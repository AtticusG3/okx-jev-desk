/**
 * Bucket edges, calibrated to THIS venue.
 *
 * Why this file exists: the first version hard-coded thresholds that were
 * inherited from equity intuition and were simply wrong here. Measured on the
 * live ledger 2026-09-26:
 *
 *   - `spread <= 1bp -> tight` but BTC-USDT-SWAP quotes 0.01bp and ETH 0.04bp,
 *     so every instrument read "tight" 100% of the time. Worse, SOL's 0.83bp
 *     (20x BTC's cost) read identically - the bucket was constant AND blind to
 *     the difference that matters.
 *   - `realizedVol15m < 0.0008 -> calm` while BTC's actual 1m vol is ~7.7e-5,
 *     i.e. the threshold sat 10x above the whole observed range. Everything was
 *     "calm" forever.
 *   - `funding >= 1bp -> against_long` while observed funding is 0.017bp (BTC),
 *     0.33bp (ETH), 0.62bp (SOL) - again all "neutral".
 *
 * A bucket that is >95% one label carries no information and is a bug, so the
 * edges are derived from a recorded sample of this venue instead of guessed,
 * and `npm run buckets` reports the occupancy that proves it.
 *
 * Two rules keep this honest:
 *   1. Edges come from data. `npm run calibrate` regenerates them from OKX
 *      public history and records the window and sample size in the file.
 *   2. Spread is bucketed in TICKS, not bps. A per-instrument bps distribution
 *      is a single point here (1 tick, always), so no edge set can split it;
 *      ticks are scale-free and widen when the book actually thins.
 */
import { readFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export interface BucketEdges {
  /** Spread width in ticks -> [tight|normal, normal|wide, wide|extreme]. */
  spreadTicks: [number, number, number];
  /** realizedVol15m -> [calm|normal, normal|elevated, elevated|extreme]. */
  vol15m: [number, number, number];
  /** |return| below this is "flat", per horizon. */
  momentumFlatAbs: { "5m": number; "15m": number };
  /** rangePos1h -> [bottom|lower, lower|mid, mid|upper, upper|top]. */
  rangePos: [number, number, number, number];
  /** |funding| in bps -> [neutral|against, against|strongly_against]. */
  fundingAbsBps: [number, number];
  /** depthImbalance5 -> [sell_heavy|sell_lean, sell_lean|balanced,
   *  balanced|buy_lean, buy_lean|buy_heavy]. Sign-symmetric. */
  imbalance: [number, number, number, number];
  /** netFlow -> [strong_selling|selling, selling|mixed, mixed|buying,
   *  buying|strong_buying]. Sign-symmetric. */
  flow: [number, number, number, number];
  /** toxicScore -> [clean|slightly_toxic, slightly_toxic|toxic, toxic|very_toxic]. */
  toxic: [number, number, number];
}

export interface EdgeFile {
  provenance: {
    generatedAt: string;
    source: string;
    windowDays: number;
    barsPerInstrument: number;
    fundingPeriods: number;
    note: string;
  };
  default: BucketEdges;
  byInstrument: Record<string, BucketEdges>;
}

/**
 * Fallbacks used only when no calibration file is present (fresh clone, or a
 * clone that has not run `npm run calibrate`). Deliberately permissive: they
 * are ordered around the values measured on this venue, and `isCalibrated`
 * reports false so the engine can warn rather than pretend.
 */
export const UNCALIBRATED_EDGES: BucketEdges = {
  spreadTicks: [1.5, 3.5, 8.5],
  vol15m: [0.00012, 0.0003, 0.0008],
  momentumFlatAbs: { "5m": 0.0003, "15m": 0.0006 },
  rangePos: [0.2, 0.45, 0.6, 0.85],
  fundingAbsBps: [0.5, 2.0],
  imbalance: [-0.4, -0.12, 0.12, 0.4],
  flow: [-0.5, -0.15, 0.15, 0.5],
  toxic: [0.35, 0.55, 0.75],
};

let cached: EdgeFile | null = null;

function edgesPath(): string {
  // src/features/edges.ts -> src/features/bucket_edges.json
  return join(dirname(fileURLToPath(import.meta.url)), "bucket_edges.json");
}

export function loadEdgeFile(path = edgesPath()): EdgeFile | null {
  if (cached) return cached;
  if (!existsSync(path)) return null;
  try {
    cached = JSON.parse(readFileSync(path, "utf8")) as EdgeFile;
    return cached;
  } catch {
    return null;
  }
}

/** Edges for one instrument: its own if calibrated, else the pooled default. */
export function edgesFor(instId: string, file: EdgeFile | null = loadEdgeFile()): BucketEdges {
  if (!file) return UNCALIBRATED_EDGES;
  return file.byInstrument[instId] ?? file.default;
}

export function isCalibrated(file: EdgeFile | null = loadEdgeFile()): boolean {
  return file !== null;
}

/** Test seam: forget a previously loaded file. */
export function resetEdgeCache(): void {
  cached = null;
}
