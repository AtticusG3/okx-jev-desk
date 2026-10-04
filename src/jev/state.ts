/**
 * Serialise engine state into the compact `state` string Jev evaluates.
 *
 * THE RULE: the object sent to Jev contains WORDS ONLY.
 *
 * Two independent reasons, and the second is the newer one:
 *
 *  1. jev-1.13 is documented as "not a calculator" and as weak at numeric
 *    precision. So every magnitude is bucketed in features/compute.ts and every
 *     threshold is applied in risk/gates.ts. The model never compares two raw
 *     numbers, because it cannot do that reliably.
 *  2. arXiv:2609.29429 ("Just Ask Jev", 2026-09-24) varies what Jev is asked
 *     against what it sees and finds the FIELDS OF THE INPUT carry the label,
 *     not the question wording. A dollar figure or a bps number in the state is
 *     a field that encodes the answer, and the model can key on it instead of
 *     on the market. So the request carries no magnitude at all: no dollars, no
 *     bps, no raw rates, no counts. Position state arrives as two buckets
 *     computed here, in code.
 *
 * The full numbers are NOT lost. Every tick writes the complete Features object
 * (numbers and buckets) to the `features` table and the outcome to `ticks` -
 * see src/loop/tick.ts. The ledger is raw and complete; the REQUEST is words
 * only. Measurement re-reads the ledger, never the request.
 *
 * Editing this file changes what the model sees, so it is an era file
 * (src/measure/era.ts) and a later edit starts a new era rather than pooling
 * rows collected under a different view of the position.
 *
 * No secrets, no full-depth book, no trade-by-trade history, no prose.
 */
import type { Features } from "../features/compute.ts";
import type { PnlSnapshot, Sleeve } from "../store/types.ts";

/** Is the open position on the right side of its entry, at it, or behind it. */
export type PositionVsEntry = "losing" | "flat" | "in_profit";
/** How long the position has been open, in three words. */
export type HoldBucket = "flat" | "just_opened" | "session";

/**
 * Deadband, in relative terms, for "at entry".
 *
 * A 2 bp move on a perp is noise around the entry, not a profit; without a
 * band, the bucket would flip on every tick and mean nothing. This is a
 * magnitude compared IN CODE, like every other edge in this project - it is
 * never shown to the model, and it is part of this file's era hash.
 */
export const FLAT_BAND_REL = 0.0002;

/** A younger position than this is "just_opened"; older is "session". */
export const JUST_OPENED_MS = 15 * 60_000;

/**
 * Where the mark sits relative to entry, in words.
 *
 * A flat side has nothing to be against, so it reads "flat" - the same word
 * as a position sitting at its entry. `position_side` is what distinguishes
 * the two, and the `action` question reads both fields together.
 */
export function positionVsEntry(
  pos: Sleeve["position"],
  mid: number,
): PositionVsEntry {
  if (pos.side === "flat") return "flat";
  if (!(pos.entryPx > 0) || !(mid > 0)) return "flat";
  const rel = (mid - pos.entryPx) / pos.entryPx;
  const signed = pos.side === "short" ? -rel : rel;
  if (signed > FLAT_BAND_REL) return "in_profit";
  if (signed < -FLAT_BAND_REL) return "losing";
  return "flat";
}

/**
 * How long the position has been open, in words. Three buckets, not four:
 * an old position and a very old one are the same decision input, so they get
 * the same word rather than a distinction nothing can act on.
 */
export function holdBucket(pos: Sleeve["position"], now: number): HoldBucket {
  if (pos.side === "flat" || !pos.openedAt) return "flat";
  if (now - pos.openedAt < JUST_OPENED_MS) return "just_opened";
  return "session";
}

export interface StateInput {
  sleeve: Sleeve;
  features: Features;
  pnl: PnlSnapshot;
  mode: string;
  now: number;
}

export function buildState(i: StateInput): string {
  const { sleeve: s, features: f, pnl, mode, now } = i;
  const pos = s.position;

  const state = {
    instrument: f.instId,
    as_of_utc: new Date(now).toISOString(),

    // The model's market inputs: classified words, no arithmetic required.
    // Every value here is a string, and every string is a value the criteria in
    // jev/questions.ts know how to read. A field nothing asks about is not sent.
    market_snapshot: {
      spread: f.buckets.spread,
      order_book: f.buckets.imbalance,
      trade_flow: f.buckets.flow,
      last_trade: f.lastTradeSide,
      momentum_5m: f.buckets.momentum_5m,
      momentum_15m: f.buckets.momentum_15m,
      volatility_15m: f.buckets.vol_15m,
      price_in_1h_range: f.buckets.range_pos,
      funding: f.buckets.funding,
      flow_quality: f.buckets.toxic,
    },

    // Inventory, as words. `action` is decidable from position_side and
    // position_vs_entry alone, so those are the only two position fields the
    // model is asked about. open_interest_change_1h_pct is deliberately NOT
    // sent: it was a raw percent (a field that encodes the answer) and no
    // question references it, so a bucket for it would be noise. It is still
    // in the ledger's features row.
    desk_context: {
      position_side: pos.side,
      position_vs_entry: positionVsEntry(pos, f.mid),
      hold: holdBucket(pos, now),
      open_order: s.workingOrder
        ? (s.workingOrder.side === "buy" ? "bid" : "ask")
        : "none",
      // Already a bucket upstream, and no question asks about it; kept because
      // it is a word and cost nothing.
      daily_loss_budget_used: pnl.dailyLossUsedFrac >= 0.5
        ? (pnl.dailyLossUsedFrac >= 1 ? "fully_used" : "mostly_used")
        : (pnl.dailyLossUsedFrac >= 0.2 ? "partly_used" : "barely_used"),
      mode,
    },
  };

  // Deterministic key order (JSON.stringify preserves insertion order) keeps
  // token counts stable, which keeps the cost estimate meaningful.
  return JSON.stringify(state);
}

/** Rough char-count guard, enforced by the caller. */
export function stateBytes(state: string): number {
  return new TextEncoder().encode(state).length;
}
