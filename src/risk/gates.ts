/**
 * Hard risk gates. These run AFTER the brain and BEFORE any order, and they are
 * the only thing standing between a confused model and real funds.
 *
 * Two invariants:
 *  1. Gates can only REDUCE exposure or refuse. There is no code path here that
 *     can increase a limit.
 *  2. Every refusal is recorded with a human-readable note, because "it didn't
 *     trade" is the hardest thing to debug without an audit trail.
 */
import type { Config } from "../config.ts";
import type { Features } from "../features/compute.ts";
import type { GateResult, PnlSnapshot, Sleeve, SleeveIntent } from "../store/types.ts";

export const STALE_BOOK_MS = 2_000;
export const STALE_PRIVATE_MS = 5_000;

export interface GateInput {
  sleeve: Sleeve;
  features: Features;
  intent: SleeveIntent;
  pnl: PnlSnapshot;
  now: number;
  /** Flatten-only mode (daily loss tripped, or kill switch). */
  haltEntries: boolean;
  /** True when the working order count this minute exceeds the limit. */
  orderRateExceeded: boolean;
}

function worst(bucket: string, positive: string[], negative: string[]): number {
  if (positive.includes(bucket)) return 1;
  if (negative.includes(bucket)) return -1;
  return 0;
}

export function evaluateGates(i: GateInput, cfg: Config): GateResult {
  const { sleeve, features, intent, pnl, now } = i;
  const r = cfg.risk;
  const notes: string[] = [];
  const isReduce = intent.urgency === "taker" && intent.side !== "none";
  const wantsEntry = !isReduce && (intent.side === "buy" || intent.side === "sell");

  // --- staleness: always checked, but only blocks NEW risk ---
  const bookAge = now - features.ts;
  if (bookAge > STALE_BOOK_MS) {
    if (wantsEntry) {
      notes.push(`stale book (${bookAge}ms > ${STALE_BOOK_MS}ms): hold`);
      return { ok: false, notes };
    }
    notes.push(`stale book (${bookAge}ms): reduce-only`);
  }
  const privAge = now - sleeve.privateTs;
  if (sleeve.privateTs > 0 && privAge > STALE_PRIVATE_MS) {
    if (wantsEntry) {
      notes.push(`stale private state (${privAge}ms > ${STALE_PRIVATE_MS}ms): hold`);
      return { ok: false, notes };
    }
    notes.push(`stale private state (${privAge}ms): reduce-only`);
  }

  if (!wantsEntry) {
    // Nothing to gate for a hold/cancel. A close still needs a sane book.
    return { ok: true, notes };
  }

  // --- kill switch / daily loss ---
  if (i.haltEntries) {
    notes.push("kill switch / daily-loss halt: no new entries");
    return { ok: false, notes };
  }

  // --- spread sanity ---
  // NOTE: the spec's MIN_SPREAD_BPS default of 0.2 is wrong for liquid perps.
  // Measured live 2026-09-26: BTC-USDT-SWAP quotes 0.01bps and ETH 0.04bps
  // routinely, so a 0.2 floor blocks every BTC/ETH entry. What this gate is
  // really for is a CROSSED or locked book (bid >= ask), or a quote that
  // rounds to the same price on both sides. So: hard-fail on crossed/locked.
  // There is deliberately no minimum-spread setting; the only spread bound is
  // MAX_SPREAD_BPS below.
  if (features.bid >= features.ask) {
    notes.push(`crossed book: bid ${features.bid} >= ask ${features.ask}`);
    return { ok: false, notes };
  }
  if (features.bid === features.ask) {
    notes.push(`locked book: bid == ask == ${features.bid}`);
    return { ok: false, notes };
  }
  if (features.spreadBps > r.maxSpreadBps) {
    notes.push(`spread ${features.spreadBps}bps > max ${r.maxSpreadBps}bps`);
    return { ok: false, notes };
  }

  // --- rate limit ---
  if (i.orderRateExceeded) {
    notes.push(`order rate > ${r.maxOrdersPerMin}/min for this sleeve`);
    return { ok: false, notes };
  }

  // --- exposure ---
  if (pnl.grossUsd + r.quoteUsd > r.maxGrossUsd) {
    notes.push(`desk gross ${Math.round(pnl.grossUsd)}USD + ${r.quoteUsd}USD > max ${r.maxGrossUsd}USD`);
    return { ok: false, notes };
  }

  const posNotional = sleeve.position.notionalUsd;
  if (posNotional + r.quoteUsd > r.maxPosUsd) {
    // Adding in the same direction as an existing position hits the per-sleeve cap.
    const sameSide = (sleeve.position.side === "long" && intent.side === "buy")
      || (sleeve.position.side === "short" && intent.side === "sell");
    if (sameSide) {
      notes.push(`sleeve pos ${Math.round(posNotional)}USD + ${r.quoteUsd}USD > max ${r.maxPosUsd}USD`);
      return { ok: false, notes };
    }
  }

  // --- brain quality gates (code decides, model only advises) ---
  const jev = intent.jev;
  if (!jev || jev.error) {
    notes.push(`brain unavailable (${jev?.error ?? "no answer"}): treat as hold`);
    return { ok: false, notes };
  }
  const dirP = jev.directionProbs[jev.direction] ?? 0;
  if (dirP < r.minDirProb) {
    notes.push(`P(${jev.direction})=${dirP.toFixed(2)} < min ${r.minDirProb}`);
    return { ok: false, notes };
  }
  if (jev.directionConfidence < r.minDirConf) {
    notes.push(`confidence ${jev.directionConfidence.toFixed(2)} < min ${r.minDirConf}`);
    return { ok: false, notes };
  }
  if (jev.entryQuality < r.minEntryQuality) {
    notes.push(`entry quality ${jev.entryQuality.toFixed(2)} < min ${r.minEntryQuality}`);
    return { ok: false, notes };
  }

  // --- toxic / extreme conditions are code-side vetoes, not model opinions ---
  if (features.buckets.toxic === "very_toxic") {
    notes.push("flow very toxic: no new entries");
    return { ok: false, notes };
  }
  if (features.buckets.vol_15m === "extreme") {
    notes.push("volatility extreme: no new entries");
    return { ok: false, notes };
  }
  if (worst(features.buckets.range_pos, ["top"], ["bottom"]) !== 0) {
    // Only a soft note: being extended is a reason to be patient, not a veto.
    notes.push(`price extended (${features.buckets.range_pos})`);
  }

  return { ok: true, notes };
}

export interface SizingResult {
  ok: boolean;
  notionalUsd: number;
  sizeMult: number;
  reason?: string;
}

/**
 * Deterministic sizing. The model never picks a size.
 *   notional = QUOTE_USD * clamp((p_dir - MIN_DIR_PROB) / (1 - MIN_DIR_PROB), 0.25, 1.0)
 */
export function sizeNotional(pDir: number, cfg: Config): SizingResult {
  const r = cfg.risk;
  const span = 1 - r.minDirProb;
  const raw = span > 0 ? (pDir - r.minDirProb) / span : 0;
  const mult = Math.min(1, Math.max(0.25, raw));
  const notionalUsd = r.quoteUsd * mult;
  if (notionalUsd < r.minNotionalUsd) {
    return { ok: false, notionalUsd, sizeMult: mult, reason: `notional ${notionalUsd.toFixed(2)} < min ${r.minNotionalUsd}` };
  }
  return { ok: true, notionalUsd, sizeMult: mult };
}
