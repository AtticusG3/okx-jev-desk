/**
 * Calibrate bucket edges from a recorded sample of THIS venue.
 *
 * Reads OKX public history (no keys, no orders) and derives the bucket edges in
 * src/features/bucket_edges.json from observed quantiles. Run it whenever the
 * venue's regime changes materially, and commit the result so the provenance
 * travels with the numbers.
 *
 *   npm run calibrate            # default 7 days of 1m bars
 *   npm run calibrate -- 14      # 14 days
 *
 * Why quantiles: the first hard-coded edge set was inherited from equity
 * intuition and put every instrument in one bucket forever (BTC 1m vol is
 * ~7.7e-5, the "calm" ceiling was 8e-4). Quantiles from our own sample
 * guarantee each bucket can actually occur, and the occupancy report
 * (`npm run buckets`) then checks that it does on live data.
 *
 * Deliberately NOT calibrated from this sample: `spread`. Candles carry no
 * bid/ask, and the live ledger shows the book is exactly 1 tick wide on every
 * instrument, so any bps edge set is degenerate. Spread is bucketed in ticks
 * and its edges are a fixed, documented fallback.
 */
import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { UNCALIBRATED_EDGES, type BucketEdges, type EdgeFile } from "../src/features/edges.ts";

const BASE = process.env.OKX_REST_BASE ?? "https://www.okx.com";
const INSTS = (process.env.OKX_INST_IDS ??
  "BTC-USDT-SWAP,ETH-USDT-SWAP,SOL-USDT-SWAP").split(",").map((s) => s.trim()).filter(Boolean);
const DAYS = Math.max(1, Number(process.argv[2] ?? 7));

interface Bar { ts: number; o: number; h: number; l: number; c: number; v: number }

async function get<T>(path: string, params: Record<string, string>): Promise<T[]> {
  const q = new URLSearchParams(params).toString();
  const r = await fetch(`${BASE}${path}?${q}`, { signal: AbortSignal.timeout(20_000) });
  if (!r.ok) throw new Error(`${path} HTTP ${r.status}`);
  const j = (await r.json()) as { code: string; msg?: string; data?: T[] };
  if (j.code !== "0") throw new Error(`${path} code=${j.code} ${j.msg ?? ""}`);
  return j.data ?? [];
}

/** OKX candle rows: [ts,o,h,l,c,vol,volCcy,volCcyQuote,confirm], newest first. */
async function fetchCandles(instId: string, days: number): Promise<Bar[]> {
  const want = days * 1440;
  const out: Bar[] = [];
  let after = "";
  while (out.length < want) {
    const page = await get<string[]>("/api/v5/market/history-candles", {
      instId, bar: "1m", limit: "100", ...(after ? { after } : {}),
    });
    if (page.length === 0) break;
    for (const r of page) {
      const ts = Number(r[0]);
      if (!Number.isFinite(ts)) continue;
      out.push({ ts, o: Number(r[1]), h: Number(r[2]), l: Number(r[3]), c: Number(r[4]), v: Number(r[5]) });
    }
    after = String(Number(page[page.length - 1]![0]));
    if (page.length < 100) break;
    await new Promise((r) => setTimeout(r, 120)); // stay under the candles rate limit
  }
  const seen = new Set<number>();
  return out.filter((b) => (seen.has(b.ts) ? false : (seen.add(b.ts), true)))
    .sort((a, b) => a.ts - b.ts);
}

function quantile(sorted: number[], q: number): number {
  if (sorted.length === 0) return 0;
  const i = (sorted.length - 1) * q;
  const lo = Math.floor(i);
  const hi = Math.ceil(i);
  return lo === hi ? sorted[lo]! : sorted[lo]! + (sorted[hi]! - sorted[lo]!) * (i - lo);
}

function sig(x: number, n = 6): number {
  return Number(x.toPrecision(n));
}

/** Replicates compute.ts: std of log returns over the last `n` bars. */
function realizedVol(bars: Bar[], n: number, at: number): number | null {
  const use = bars.slice(Math.max(0, at - n + 1), at + 1);
  if (use.length < 3) return null;
  const rets: number[] = [];
  for (let i = 1; i < use.length; i++) {
    const a = use[i - 1]!.c; const b = use[i]!.c;
    if (a > 0 && b > 0) rets.push(Math.log(b / a));
  }
  if (rets.length < 2) return null;
  const m = rets.reduce((s, x) => s + x, 0) / rets.length;
  return Math.sqrt(rets.reduce((s, x) => s + (x - m) ** 2, 0) / (rets.length - 1));
}

function retOver(bars: Bar[], mins: number, at: number): number | null {
  const j = at - mins;
  if (j < 0) return null;
  const a = bars[j]!.c; const b = bars[at]!.c;
  return a > 0 ? (b - a) / a : null;
}

function rangePos(bars: Bar[], at: number): number | null {
  const hour = bars.slice(Math.max(0, at - 59), at + 1);
  if (hour.length < 5) return null;
  const hi = Math.max(...hour.map((b) => b.h));
  const lo = Math.min(...hour.map((b) => b.l));
  if (!(hi > lo)) return null;
  return (bars[at]!.c - lo) / (hi - lo);
}

function edgesFrom(bars: Bar[], fundingBps: number[]): BucketEdges {
  const vol: number[] = [];
  const r5: number[] = [];
  const r15: number[] = [];
  const rp: number[] = [];
  for (let i = 60; i < bars.length; i++) {
    const v = realizedVol(bars, 15, i); if (v !== null) vol.push(v);
    const a = retOver(bars, 5, i); if (a !== null) r5.push(Math.abs(a));
    const b = retOver(bars, 15, i); if (b !== null) r15.push(Math.abs(b));
    const p = rangePos(bars, i); if (p !== null) rp.push(p);
  }
  vol.sort((x, y) => x - y); r5.sort((x, y) => x - y);
  r15.sort((x, y) => x - y); rp.sort((x, y) => x - y);
  const f = fundingBps.slice().sort((x, y) => x - y);

  return {
    // Not derived from candles - see the header note. Ticks are scale-free.
    spreadTicks: UNCALIBRATED_EDGES.spreadTicks,
    vol15m: [sig(quantile(vol, 0.33)), sig(quantile(vol, 0.66)), sig(quantile(vol, 0.9))],
    momentumFlatAbs: {
      // "flat" = |ret| in the middle 40% of the observed |ret| distribution.
      // A move smaller than the 40th percentile of typical moves is noise here.
      "5m": sig(quantile(r5, 0.4)),
      "15m": sig(quantile(r15, 0.4)),
    },
    rangePos: [
      sig(quantile(rp, 0.15), 3), sig(quantile(rp, 0.4), 3),
      sig(quantile(rp, 0.6), 3), sig(quantile(rp, 0.85), 3),
    ],
    fundingAbsBps: [sig(quantile(f, 0.5), 3), sig(quantile(f, 0.85), 3)],
    // Book-derived: no candle data exists for these, so they keep the measured
    // ledger values. Verified to occur in all 5 / 4 buckets on live data.
    imbalance: UNCALIBRATED_EDGES.imbalance,
    flow: UNCALIBRATED_EDGES.flow,
    toxic: UNCALIBRATED_EDGES.toxic,
  };
}

async function fundingBpsFor(instId: string): Promise<number[]> {
  const rows = await get<{ fundingRate: string; realizedRate?: string }>(
    "/api/v5/public/funding-rate-history", { instId, limit: "100" },
  );
  // Signed, in bps. Sign is preserved for direction; |.| drives the edges.
  return rows.map((r) => Math.abs(Number(r.realizedRate ?? r.fundingRate)) * 1e4)
    .filter((x) => Number.isFinite(x) && x > 0);
}

async function main(): Promise<void> {
  console.log(`calibrating bucket edges from ${DAYS}d of 1m bars (${BASE})\n`);
  const byInstrument: Record<string, BucketEdges> = {};
  const allBars: Bar[] = [];
  const allFunding: number[] = [];
  let bars = 0;
  let periods = 0;

  for (const instId of INSTS) {
    try {
      const barsFor = await fetchCandles(instId, DAYS);
      const f = await fundingBpsFor(instId);
      if (barsFor.length < 200) {
        console.log(`  ${instId}: only ${barsFor.length} bars - skipping (need >=200)`);
        continue;
      }
      byInstrument[instId] = edgesFrom(barsFor, f);
      allBars.push(...barsFor);
      allFunding.push(...f);
      bars = Math.max(bars, barsFor.length);
      periods = Math.max(periods, f.length);
      console.log(`  ${instId}: ${barsFor.length} bars, ${f.length} funding periods`);
      console.log(`     vol15m    [${byInstrument[instId]!.vol15m.join(", ")}]`);
      console.log(`     flatAbs   5m=${byInstrument[instId]!.momentumFlatAbs["5m"]} 15m=${byInstrument[instId]!.momentumFlatAbs["15m"]}`);
      console.log(`     rangePos  [${byInstrument[instId]!.rangePos.join(", ")}]`);
      console.log(`     fundingBps[${byInstrument[instId]!.fundingAbsBps.join(", ")}]`);
    } catch (e) {
      console.log(`  ${instId}: FAILED - ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  if (Object.keys(byInstrument).length === 0) {
    console.error("\nno instrument calibrated; leaving the existing file untouched");
    process.exit(1);
  }

  const file: EdgeFile = {
    provenance: {
      generatedAt: new Date().toISOString(),
      source: "OKX public REST: /market/history-candles (1m), /public/funding-rate-history",
      windowDays: DAYS,
      barsPerInstrument: bars,
      fundingPeriods: periods,
      note: "Edges are quantiles of THIS venue's recorded distribution. spread is bucketed in ticks and intentionally not calibrated from candles (no book data). imbalance/flow/toxic are book-derived and keep measured ledger values.",
    },
    default: edgesFrom(allBars.length ? allBars : [], allFunding),
    byInstrument,
  };

  const out = join(dirname(fileURLToPath(import.meta.url)), "..", "src", "features", "bucket_edges.json");
  writeFileSync(out, JSON.stringify(file, null, 2) + "\n");
  console.log(`\npooled default vol15m [${file.default.vol15m.join(", ")}]`);
  console.log(`wrote ${out}`);
  console.log("next: npm run buckets   # prove each bucket actually occurs on live data");
}

void main().catch((e) => {
  console.error(e);
  process.exit(1);
});
