/**
 * Feature computation. EVERY number the brain sees is computed here.
 *
 * Design rule, enforced by the Jev client: the model never does arithmetic and
 * never compares two raw numbers. So each feature is exposed twice —
 *   - as a number, for logging, storage and the shadow ledger, and
 *   - as a named bucket (e.g. "tight", "extended"), which is what actually goes
 *     into the state sent to Jev.
 *
 * Signals here are deliberately simple and defensible (order-flow imbalance,
 * spread, flow toxicity, realised vol, position in range, funding). The
 * literature-backed catalogue and the measurement plan live in
 * docs/SIGNAL_CATALOGUE.md; nothing in that document is wired into the policy
 * until it has been measured on this desk's own shadow ledger.
 */
import type { BookState, Sleeve, Side } from "../store/types.ts";
import { edgesFor, type BucketEdges } from "./edges.ts";

export interface Features {
  instId: string;
  ts: number;
  mid: number;
  bid: number;
  ask: number;
  spreadBps: number;
  /** Spread width in ticks. Scale-free and robust across instruments. */
  spreadTicks: number;
  bidSz: number;
  askSz: number;
  bookImbalance: number; // (bidSz - askSz) / (bidSz + askSz), [-1, 1]
  depthImbalance5: number; // volume-weighted over top 5 levels
  lastTradeSide: Side | "none";
  tradeCount30s: number;
  volume30sUsd: number;
  buyVol30s: number;
  sellVol30s: number;
  /** Kyle's lambda proxy: |return| per unit of signed volume pressure. */
  kyleLambda: number | null;
  ret1m: number | null;
  ret5m: number | null;
  ret15m: number | null;
  ret1h: number | null;
  realizedVol15m: number | null;
  realizedVol1h: number | null;
  rangePos1h: number | null; // 0 = low of 1h range, 1 = high
  fundingRate: number | null;
  nextFundingHours: number | null;
  oiChange1hPct: number | null;
  /** Named buckets — the ONLY numeric-ish fields the model reads. */
  buckets: {
    spread: "tight" | "normal" | "wide" | "extreme";
    imbalance: "buy_heavy" | "buy_lean" | "balanced" | "sell_lean" | "sell_heavy";
    flow: "strong_buying" | "buying" | "mixed" | "selling" | "strong_selling";
    momentum_5m: "up" | "flat" | "down";
    momentum_15m: "up" | "flat" | "down";
    vol_15m: "calm" | "normal" | "elevated" | "extreme";
    range_pos: "bottom" | "lower" | "mid" | "upper" | "top";
    funding: "strongly_against_long" | "against_long" | "neutral" | "against_short" | "strongly_against_short";
    toxic: "clean" | "slightly_toxic" | "toxic" | "very_toxic";
  };
}

function r2(x: number, n = 2): number {
  return Number(x.toFixed(n));
}

function bucketSpread(ticks: number, e: BucketEdges): Features["buckets"]["spread"] {
  const [a, b, c] = e.spreadTicks;
  if (ticks <= a) return "tight";
  if (ticks <= b) return "normal";
  if (ticks <= c) return "wide";
  return "extreme";
}

function bucketImbalance(imb: number, e: BucketEdges): Features["buckets"]["imbalance"] {
  const [sh, sl, bl, bh] = e.imbalance;
  if (imb >= bh) return "buy_heavy";
  if (imb >= bl) return "buy_lean";
  if (imb > sl) return "balanced";
  if (imb > sh) return "sell_lean";
  return "sell_heavy";
}

function bucketFlow(net: number, e: BucketEdges): Features["buckets"]["flow"] {
  const [ss, s2, m, b] = e.flow;
  if (net >= b) return "strong_buying";
  if (net >= m) return "buying";
  if (net > s2) return "mixed";
  if (net > ss) return "selling";
  return "strong_selling";
}

function bucketMom(ret: number | null, flatAbs: number): "up" | "flat" | "down" {
  if (ret === null) return "flat";
  if (ret > flatAbs) return "up";
  if (ret < -flatAbs) return "down";
  return "flat";
}

function bucketVol(v: number | null, e: BucketEdges): Features["buckets"]["vol_15m"] {
  if (v === null) return "normal";
  const [a, b, c] = e.vol15m;
  if (v < a) return "calm";
  if (v < b) return "normal";
  if (v < c) return "elevated";
  return "extreme";
}

function bucketRange(p: number | null, e: BucketEdges): Features["buckets"]["range_pos"] {
  if (p === null) return "mid";
  const [a, b, c, d] = e.rangePos;
  if (p < a) return "bottom";
  if (p < b) return "lower";
  if (p < c) return "mid";
  if (p < d) return "upper";
  return "top";
}

function bucketFunding(fr: number | null, e: BucketEdges): Features["buckets"]["funding"] {
  if (fr === null) return "neutral";
  const [neutral, strong] = e.fundingAbsBps;
  const f = Math.abs(fr) * 1e4; // bps
  if (f < neutral) return "neutral";
  if (fr > 0) {
    // Positive funding: longs pay shorts -> against long.
    return f >= strong ? "strongly_against_long" : "against_long";
  }
  return f >= strong ? "strongly_against_short" : "against_short";
}

/**
 * Flow toxicity proxy. The full VPIN estimator needs volume-clock bucketing;
 * this is the cheap variant: signed-flow concentration weighted by how one-sided
 * the trade flow is. High -> price moves are being driven by informed/urgent
 * flow, which is exactly when a market order is worst.
 */
function toxicScore(sleeve: Sleeve, now: number): number {
  const win = sleeve.recentTrades.filter((t) => now - t.ts <= 30_000);
  if (win.length < 4) return 0;
  let buy = 0;
  let sell = 0;
  for (const t of win) {
    if (t.side === "buy") buy += t.sz;
    else sell += t.sz;
  }
  const tot = buy + sell;
  if (tot <= 0) return 0;
  const dominance = Math.abs(buy - sell) / tot;
  const intensity = Math.min(1, tot / 50);
  return r2(dominance * (0.5 + 0.5 * intensity), 3);
}

function toxicBucket(score: number, e: BucketEdges): Features["buckets"]["toxic"] {
  const [a, b, c] = e.toxic;
  if (score >= c) return "very_toxic";
  if (score >= b) return "toxic";
  if (score >= a) return "slightly_toxic";
  return "clean";
}

function retOver(sleeve: Sleeve, ms: number, now: number): number | null {
  const c = sleeve.candles1m;
  if (c.length < 2) return null;
  // candles are stored oldest-first.
  const target = now - ms;
  let oldest: number | null = null;
  for (let i = c.length - 1; i >= 0; i--) {
    const cv = c[i]!;
    if (cv.ts <= target) {
      oldest = cv.c;
      break;
    }
  }
  if (oldest === null) return null;
  const latest = c[c.length - 1]!.c;
  if (!(oldest > 0)) return null;
  return (latest - oldest) / oldest;
}

function realizedVol(candles: { c: number }[], n: number): number | null {
  if (candles.length < 3) return null;
  const use = candles.slice(-n);
  const rets: number[] = [];
  for (let i = 1; i < use.length; i++) {
    const a = use[i - 1]!.c;
    const b = use[i]!.c;
    if (a > 0) rets.push(Math.log(b / a));
  }
  if (rets.length < 2) return null;
  const m = rets.reduce((s, x) => s + x, 0) / rets.length;
  const varr = rets.reduce((s, x) => s + (x - m) ** 2, 0) / (rets.length - 1);
  return Math.sqrt(varr);
}

export interface FeatureContext {
  book: BookState | undefined;
  fundingRate: number | null;
  nextFundingHours: number | null;
  oiChange1hPct: number | null;
  /** Quoted tick size, needed to express spread in ticks rather than bps. */
  tickSz: number;
}

export function computeFeatures(sleeve: Sleeve, ctx: FeatureContext, now = Date.now()): Features | null {
  const book = ctx.book;
  const bid = book?.bids[0]?.px ?? 0;
  const ask = book?.asks[0]?.px ?? 0;
  if (!(bid > 0) || !(ask > 0) || ask < bid) return null;
  const mid = (bid + ask) / 2;
  const spreadBps = ((ask - bid) / mid) * 10_000;
  // Ticks, not bps: a per-instrument bps distribution on this venue is a single
  // point (always exactly 1 tick), so no bps edge set can ever split it.
  const spreadTicks = ctx.tickSz > 0 ? (ask - bid) / ctx.tickSz : 0;

  const topB = book!.bids.slice(0, 5);
  const topA = book!.asks.slice(0, 5);
  const bidSz = topB.reduce((s, l) => s + l.sz, 0);
  const askSz = topA.reduce((s, l) => s + l.sz, 0);
  const bookImbalance = bidSz + askSz > 0 ? (bidSz - askSz) / (bidSz + askSz) : 0;
  // Volume-weighted: price-level sizes, not contract counts, matter.
  const bidNotional = topB.reduce((s, l) => s + l.px * l.sz, 0);
  const askNotional = topA.reduce((s, l) => s + l.px * l.sz, 0);
  const depthImbalance5 = bidNotional + askNotional > 0
    ? (bidNotional - askNotional) / (bidNotional + askNotional)
    : 0;

  const win = sleeve.recentTrades.filter((t) => now - t.ts <= 30_000);
  const buyVol = win.filter((t) => t.side === "buy").reduce((s, t) => s + t.sz * t.px, 0);
  const sellVol = win.filter((t) => t.side === "sell").reduce((s, t) => s + t.sz * t.px, 0);
  const volume30sUsd = buyVol + sellVol;
  const netFlow = volume30sUsd > 0 ? (buyVol - sellVol) / volume30sUsd : 0;

  const last = sleeve.recentTrades.length ? sleeve.recentTrades[sleeve.recentTrades.length - 1]! : null;

  const ret1m = retOver(sleeve, 60_000, now);
  const ret5m = retOver(sleeve, 5 * 60_000, now);
  const ret15m = retOver(sleeve, 15 * 60_000, now);
  const ret1h = retOver(sleeve, 60 * 60_000, now);
  const rv15 = realizedVol(sleeve.candles1m, 15);
  const rv1h = realizedVol(sleeve.candles1m, 60);

  // Position in the last hour's range.
  let rangePos: number | null = null;
  const hour = sleeve.candles1m.slice(-60);
  if (hour.length >= 5) {
    const hi = Math.max(...hour.map((c) => c.h));
    const lo = Math.min(...hour.map((c) => c.l));
    rangePos = hi > lo ? (mid - lo) / (hi - lo) : 0.5;
  }

  const e = edgesFor(sleeve.instId);
  const tox = toxicScore(sleeve, now);
  // Kyle's lambda proxy: price change per unit of net signed flow pressure.
  const kyleLambda = ret1m !== null && Math.abs(netFlow) > 0.05
    ? r2(ret1m / netFlow, 5)
    : null;

  return {
    instId: sleeve.instId,
    ts: now,
    mid: r2(mid, 8),
    bid: r2(bid, 8),
    ask: r2(ask, 8),
    spreadBps: r2(spreadBps),
    spreadTicks: r2(spreadTicks, 3),
    bidSz: r2(bidSz, 4),
    askSz: r2(askSz, 4),
    bookImbalance: r2(bookImbalance),
    depthImbalance5: r2(depthImbalance5),
    lastTradeSide: last ? last.side : "none",
    tradeCount30s: win.length,
    volume30sUsd: r2(volume30sUsd, 0),
    buyVol30s: r2(buyVol, 0),
    sellVol30s: r2(sellVol, 0),
    kyleLambda,
    ret1m: ret1m === null ? null : r2(ret1m, 5),
    ret5m: ret5m === null ? null : r2(ret5m, 5),
    ret15m: ret15m === null ? null : r2(ret15m, 5),
    ret1h: ret1h === null ? null : r2(ret1h, 5),
    realizedVol15m: rv15 === null ? null : r2(rv15, 6),
    realizedVol1h: rv1h === null ? null : r2(rv1h, 6),
    rangePos1h: rangePos === null ? null : r2(rangePos, 3),
    fundingRate: ctx.fundingRate,
    nextFundingHours: ctx.nextFundingHours === null ? null : r2(ctx.nextFundingHours, 2),
    oiChange1hPct: ctx.oiChange1hPct,
    buckets: {
      spread: bucketSpread(spreadTicks, e),
      imbalance: bucketImbalance(depthImbalance5, e),
      flow: bucketFlow(netFlow, e),
      momentum_5m: bucketMom(ret5m, e.momentumFlatAbs["5m"]),
      momentum_15m: bucketMom(ret15m, e.momentumFlatAbs["15m"]),
      vol_15m: bucketVol(rv15, e),
      range_pos: bucketRange(rangePos, e),
      funding: bucketFunding(ctx.fundingRate, e),
      toxic: toxicBucket(tox, e),
    },
  };
}
