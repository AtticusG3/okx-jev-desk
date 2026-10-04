/**
 * The analysis both `npm run measure` and `npm run proof` are built on.
 *
 * Why one module: if the proof and the measure computed the variance ratio or
 * the markout separately, they could disagree, and the one that decides
 * promotions would be the one nobody audited. The earlier Bonferroni bug was
 * exactly that shape - a correct statistic wired to the wrong alpha. So the
 * numbers a decision depends on live here, once, and both commands call them.
 */
import { openReadOnly } from "../store/db.ts";
import { auc, mean, mulberry32, varianceRatio } from "./stats.ts";
import { bootstrapAucPValue, minResolvableP } from "./nullp.ts";

export const FEATURES = [
  "spreadTicks", "spreadBps", "bookImbalance", "depthImbalance5", "tradeCount30s",
  "volume30sUsd", "kyleLambda", "ret1m", "ret5m", "ret15m", "ret1h",
  "realizedVol15m", "realizedVol1h", "rangePos1h", "fundingRate", "nextFundingHours",
  "oiChange1hPct",
] as const;

export type FeatureName = (typeof FEATURES)[number];

export interface Tick {
  ts: number; mid: number; bid: number; ask: number;
  /** Era this row was collected under. Null for pre-era (card 1) rows. */
  era?: string | null;
  /** UTC session: asia | europe | us. Null for pre-era rows. */
  session?: string | null;
}
export interface FRow { ts: number; f: Record<string, number | null> }

export interface Series {
  ticks: Tick[];
  rows: FRow[];
  ts: number[];
  /** Every era present, with its tick count. Empty-era rows are not counted. */
  eras: Map<string, number>;
  /** Sessions seen in the ticks, as a count per session name. */
  sessions: Map<string, number>;
  /** UTC calendar days (YYYY-MM-DD) that have at least one tick. */
  days: Set<string>;
}

/**
 * Load one instrument's series, optionally restricted to a single era.
 *
 * The era filter is applied IN SQL, not by filtering afterwards. Two reasons,
 * and the second is the one that matters:
 *
 *   1. Efficiency, obviously - do not read 4,000 rows to discard them.
 *   2. Correctness of the FEATURE join. The `features` table has no era column
 *      of its own; a feature row is identified to an era by its TIMESTAMP,
 *      because a tick and its feature snapshot share one. So the feature query
 *      must also be era-restricted, by asking for the rows whose ts falls
 *      inside the set of era-tagged tick timestamps.
 *
 * Filtering only the day/week count, as an earlier version did, left the
 * variance ratio and every feature score reading all rows for the instrument -
 * including the 4,221 pre-era rows on the live ledger, collected under
 * questions and edges nobody can now reconstruct. That is precisely the pooling
 * the era hash exists to prevent, and it moved the measured VR by up to 0.06
 * per instrument.
 *
 * `era: null` means "no filter" and is only for callers that genuinely want
 * every row (the bucket-occupancy tool, which reports across eras on purpose).
 */
export function loadSeries(dbPath: string, instId: string, era: string | null = null): Series {
  const db = openReadOnly(dbPath);
  try {
    const eraClause = era === null ? "" : " AND era = ?";
    const eraArg = era === null ? [] : [era];
    const raw = db
      .prepare(`SELECT ts, mid, bid, ask, era, session FROM ticks WHERE inst_id = ? AND mid > 0${eraClause} ORDER BY ts`)
      .all(instId, ...eraArg) as unknown as Array<Tick & { era: string | null; session: string | null }>;
    // Feature rows inherit their era from the tick at the same timestamp.
    const fr = era === null
      ? db.prepare("SELECT ts, json FROM features WHERE inst_id = ? ORDER BY ts").all(instId) as
          unknown as Array<{ ts: number; json: string }>
      : db
          .prepare(
            `SELECT f.ts, f.json FROM features f
             JOIN (SELECT ts FROM ticks WHERE inst_id = ? AND era = ? AND mid > 0) t
               ON t.ts = f.ts
             WHERE f.inst_id = ? ORDER BY f.ts`,
          )
          .all(instId, era, instId) as unknown as Array<{ ts: number; json: string }>;

    const ticks: Tick[] = [];
    const seenT = new Set<number>();
    const eras = new Map<string, number>();
    const sessions = new Map<string, number>();
    const days = new Set<string>();
    for (const t of raw) {
      if (seenT.has(t.ts)) continue;
      seenT.add(t.ts);
      ticks.push({ ts: t.ts, mid: t.mid, bid: t.bid, ask: t.ask, era: t.era, session: t.session });
      if (t.era) eras.set(t.era, (eras.get(t.era) ?? 0) + 1);
      if (t.session) sessions.set(t.session, (sessions.get(t.session) ?? 0) + 1);
      days.add(new Date(t.ts).toISOString().slice(0, 10));
    }

    const rows: FRow[] = [];
    const seenF = new Set<number>();
    for (const r of fr) {
      if (seenF.has(r.ts)) continue;
      seenF.add(r.ts);
      try {
        const j = JSON.parse(r.json) as Record<string, unknown>;
        const f: Record<string, number | null> = {};
        for (const k of FEATURES) {
          const v = j[k];
          f[k] = typeof v === "number" && Number.isFinite(v) ? v : null;
        }
        rows.push({ ts: r.ts, f });
      } catch { /* a malformed row is skipped, not fatal */ }
    }
    return { ticks, rows, ts: ticks.map((t) => t.ts), eras, sessions, days };
  } finally { db.close(); }
}

/** Index of the first tick at or after `t`. */
export function lowerBound(ts: number[], t: number): number {
  let lo = 0;
  let hi = ts.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (ts[mid]! >= t) hi = mid;
    else lo = mid + 1;
  }
  return lo;
}

/** Forward mid change in bps at +hMs from the tick at/after `fromTs`. */
export function forwardBps(ticks: Tick[], ts: number[], fromTs: number, hMs: number, tolMs: number): number | null {
  const i0 = lowerBound(ts, fromTs);
  if (i0 >= ticks.length) return null;
  const base = ticks[i0]!;
  if (!(base.mid > 0)) return null;
  const target = base.ts + hMs;
  const i1 = lowerBound(ts, target);
  if (i1 >= ticks.length) return null;
  if (ts[i1]! - target > tolMs) return null; // gap too large; not that horizon
  return ((ticks[i1]!.mid - base.mid) / base.mid) * 10_000;
}

/**
 * Adverse selection, measured rather than assumed.
 *
 * A resting buy at the bid is filled once the best ask trades down to it; a
 * resting sell at the ask is filled once the best bid trades up to it. For each
 * such event take the signed mid move from the fill onward. A mid that moves
 * against the passive side is the cost of having rested there - what you pay
 * for queue priority, and the number that decides whether improving the price
 * is worth it.
 */
export function markout(
  ticks: Tick[], ts: number[], horizonMs: number, side: "buy" | "sell",
): { n: number; bps: number } {
  const moves: number[] = [];
  for (let i = 0; i < ticks.length - 1; i++) {
    const t = ticks[i]!;
    if (!(t.bid > 0) || !(t.ask > 0)) continue;
    let fill = -1;
    for (let j = i + 1; j < ticks.length; j++) {
      const u = ticks[j]!;
      if (u.ts - t.ts > horizonMs) break;
      if (side === "buy" ? u.ask <= t.bid : u.bid >= t.ask) { fill = j; break; }
    }
    if (fill < 0) continue;
    const f = ticks[fill]!;
    const target = f.ts + horizonMs;
    const k = lowerBound(ts, target);
    if (k >= ticks.length || ts[k]! - target > horizonMs) continue;
    const move = ((ticks[k]!.mid - f.mid) / f.mid) * 10_000;
    moves.push(side === "buy" ? -move : move);
  }
  return { n: moves.length, bps: mean(moves) };
}

export interface VrResult {
  horizonMin: number;
  q: number;
  vr: number;
  z: number;
  n: number;
  /** Rows needed for a verdict at this cadence. */
  need: number;
  /** True when there are enough rows to say anything. */
  decidable: boolean;
  /** z < -1.96 => mean reversion, z > 1.96 => trending. Neither => no verdict. */
  verdict: "mean-reverting" | "trending" | "no-verdict" | "insufficient";
}

export function vrResult(mids: number[], horizonMin: number, tickMs: number): VrResult {
  const q = Math.max(1, Math.round((horizonMin * 60_000) / tickMs));
  const r = varianceRatio(mids, q);
  const need = 4 * q * q;
  const decidable = mids.length >= need;
  let verdict: VrResult["verdict"] = "insufficient";
  if (decidable) {
    if (r.z < -1.96) verdict = "mean-reverting";
    else if (r.z > 1.96) verdict = "trending";
    else verdict = "no-verdict";
  }
  return { horizonMin, q, vr: r.vr, z: r.z, n: mids.length, need, decidable, verdict };
}

export interface Scored {
  feat: string;
  n: number;
  oos: number;
  auc: number;
  grossBps: number;
  grossBpsAlwaysLong: number;
  adverseBps: number;
  netBps: number;
  pAdj: number;
  significant: boolean;
  positiveAfterCost: boolean;
}

export interface ScoreOpts {
  hMin: number;
  tickMs: number;
  feeBps: number;
  alpha: number;
  family: number;
  bootP: number;
  minSettled: number;
  embargoRows: number;
}

export function seedFor(parts: (string | number)[]): number {
  let h = 2166136261;
  for (const p of parts) {
    const s = String(p);
    for (let i = 0; i < s.length; i++) {
      h ^= s.charCodeAt(i);
      h = Math.imul(h, 16777619);
    }
  }
  return h >>> 0;
}

/**
 * Walk-forward AUC for one feature, with embargo, and a Bonferroni-corrected
 * p-value. `directionsFitInSample` is intentionally absent: the sign is fitted
 * on train folds only, inside this function.
 */
export function scoreFeature(
  s: Series, feat: FeatureName, o: ScoreOpts, seed: number,
): Scored | { waiting: true; settled: number; need: number } {
  const hMs = o.hMin * 60_000;
  const tolMs = o.tickMs * 2;
  const key = feat as string;

  const pairs: { x: number; y: number }[] = [];
  for (const row of s.rows) {
    const x = row.f[key];
    if (x === null || x === undefined || !Number.isFinite(x)) continue;
    const y = forwardBps(s.ticks, s.ts, row.ts, hMs, tolMs);
    if (y === null || !Number.isFinite(y)) continue;
    pairs.push({ x, y });
  }
  if (pairs.length < o.minSettled) {
    return { waiting: true, settled: pairs.length, need: o.minSettled };
  }

  // Split: oldest 57% train, newest 43% test. Train is older, so the embargo
  // between them removes the rows whose forward window straddles the split.
  const n = pairs.length;
  const cut = Math.floor(n * 0.57);
  const embargo = Math.min(o.embargoRows, Math.max(0, n - cut - 1));
  const test = pairs.slice(cut + embargo);
  if (test.length < 30) return { waiting: true, settled: pairs.length, need: o.minSettled };

  // Purged walk-forward, ONE pass.
  //
  // The AUC set, the signed-gross set and the label set are produced by the
  // same loop over the same blocks, so they cannot describe different data.
  // An earlier version computed the AUC in a first pass and then recomputed
  // the direction in a second pass to get the economics; two copies of the
  // same logic, free to drift, which is precisely how a feature ends up with
  // significance from one sample and economics from another.
  const blockRows = Math.max(20, Math.round(test.length / 10));
  const oS: number[] = [];
  const oL: number[] = [];
  const signed: number[] = [];
  const alwaysLong: number[] = [];
  const dirFits: number[] = [];
  for (let b = 0; b < test.length; b += blockRows) {
    const blk = test.slice(b, b + blockRows);
    const blockStart = b + embargo;
    // Train only on rows whose forward window closed before this block began.
    const train = pairs.slice(0, Math.max(0, cut - Math.ceil(hMs / o.tickMs))).filter((_, i) => i < blockStart);
    if (train.length < 60) continue;
    let sPos = 0;
    let sNeg = 0;
    for (const p of train) {
      if (p.y > 0) sPos += p.x;
      else sNeg += p.x;
    }
    const dir = sPos > sNeg ? 1 : -1;
    dirFits.push(dir);
    for (const p of blk) {
      oS.push(p.x);
      oL.push(p.y * dir > 0 ? 1 : -1);
      // The economics follow the SAME fitted direction as the label above, in
      // the same iteration. This is the whole point: a feature's significance
      // and its profit must be measured on the same rows, with the same
      // direction, or the two numbers describe different experiments.
      signed.push(p.y * dir);
      alwaysLong.push(p.y);
    }
  }
  if (oS.length < 30) return { waiting: true, settled: pairs.length, need: o.minSettled };

  // The cap is on the RESAMPLE set only. AUC is a rank statistic, so a
  // subsample estimates the same quantity with a wider interval - the honest
  // direction here, because the gate is a threshold on p_adj. Without a cap the
  // cost is O(n * bootP) per feature and the obvious "fix" is to lower bootP,
  // which would be the wrong trade.
  //
  // The point estimate and BOTH gross figures still use every out-of-sample
  // row, so the economics do not get a sampling error the statistics do not
  // have.
  const CAP = 2000;
  const stride = Math.max(1, Math.ceil(oS.length / CAP));
  const bS = oS.filter((_, i) => i % stride === 0);
  const bL = oL.filter((_, i) => i % stride === 0);

  const a = auc(oS, oL);
  const pv = bootstrapAucPValue(bS, bL, Math.max(20, Math.round(bS.length / 10)), o.bootP, mulberry32(seed));
  const pAdj = Math.min(1, pv.p * o.family);
  const gross = signed.length ? mean(signed) : 0;
  const grossBpsAlwaysLong = alwaysLong.length ? mean(alwaysLong) : 0;
  const adverse = meanOfMarkout(s);
  const net = gross - o.feeBps - adverse;

  return {
    feat: key, n, oos: oS.length, auc: a,
    /** Mean forward move in the direction the feature predicted, in bps. */
    grossBps: gross,
    /**
     * Mean forward move with the direction forced to +1, in bps. This is
     * volatility, not edge. If it is close to grossBps the feature is
     * describing how big bars are rather than where they go.
     */
    grossBpsAlwaysLong,
    adverseBps: adverse,
    netBps: net, pAdj, significant: pAdj < o.alpha, positiveAfterCost: net > 0,
  };
}

/**
 * Adverse selection, averaged over both sides and the three markout horizons.
 * Shared so the proof and the measure quote the same number.
 */
export function meanOfMarkout(s: Series, feeBps = 0): number {
  const horizons = [1, 10, 60];
  const vals: number[] = [];
  for (const sec of horizons) {
    for (const side of ["buy", "sell"] as const) {
      const m = markout(s.ticks, s.ts, sec * 1000, side);
      if (m.n >= 30) vals.push(m.bps);
    }
  }
  if (vals.length === 0) return 0;
  return mean(vals);
}

export { auc, mean, mulberry32, varianceRatio, bootstrapAucPValue, minResolvableP };
