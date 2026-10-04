/**
 * Answer -> SleeveIntent mapping. This is the "code, not Jev" layer that turns
 * typed answers into an orderable decision, and the single place where the
 * policy from the spec lives.
 *
 * Order of precedence matters and is deliberate:
 *   1. hard risk exit  (dump risk)      — an adverse move is a reason to leave
 *   2. flatten on opposed/flat direction
 *   3. entry (direction + action + quality all satisfied)
 *   4. hold (default; also the answer to "I don't know")
 */
import type { Config } from "../config.ts";
import type { Features } from "../features/compute.ts";
import type { JevAnswers, Side, Sleeve, SleeveIntent } from "../store/types.ts";

export const DUMP_RISK_FORCE_EXIT = 2.5; // "High" or worse

export function mapAnswers(
  answers: JevAnswers,
  sleeve: Sleeve,
  features: Features,
  cfg: Config,
): SleeveIntent {
  const base = { jev: answers, gateNotes: [] as string[], blocked: false };
  const pos = sleeve.position;

  // 0. A failed/errored brain is hold + cancel_only. Never infer a direction.
  if (answers.error) {
    return {
      ...base,
      side: "none",
      urgency: "cancel_only",
      reason: `brain error: ${answers.error}`,
    };
  }

  const dir = answers.direction;
  const act = answers.action;

  // 1. Hard risk exit. Dump risk is about a sharp adverse MOVE, so it
  //    overrides the direction call entirely.
  if (answers.dumpRisk >= DUMP_RISK_FORCE_EXIT && pos.side !== "flat") {
    return {
      ...base,
      side: pos.side === "long" ? "sell" : "buy",
      urgency: "taker",
      reason: `dump_risk ${answers.dumpRisk.toFixed(1)} >= ${DUMP_RISK_FORCE_EXIT} with ${pos.side} position: taker exit`,
    };
  }

  // 2. Flatten when direction opposes the position or has gone flat with the
  //    model asking to close.
  if (pos.side !== "flat") {
    const opposed = (pos.side === "long" && dir === "short") || (pos.side === "short" && dir === "long");
    if (act === "close" || opposed) {
      return {
        ...base,
        side: pos.side === "long" ? "sell" : "buy",
        urgency: "taker",
        reason: opposed
          ? `direction ${dir} opposes ${pos.side} position: flatten`
          : `action close on ${pos.side} position: flatten`,
      };
    }
    if (act === "reduce") {
      return {
        ...base,
        side: pos.side === "long" ? "sell" : "buy",
        urgency: "taker",
        reason: `action reduce on ${pos.side} position: taker partial exit`,
      };
    }
  }

  // 3. Entries.
  if (dir === "flat") {
    return {
      ...base,
      side: "none",
      // No order goes out in either case. "taker" here used to label a no-op
      // as an aggressive exit; the gate-block path then preserved it as taker.
      urgency: "cancel_only",
      reason: pos.side === "flat"
        ? "direction flat, no position: stay out"
        : "direction flat with a position: hold inventory",
    };
  }

  if (act === "open" || act === "add") {
    if (act === "add" && !cfg.risk.enableAdd) {
      return {
        ...base,
        side: "none",
        urgency: "cancel_only",
        reason: "add disabled by ENABLE_ADD=false (safe default for the first demo week)",
      };
    }
    const side: Side = dir === "long" ? "buy" : "sell";
    return {
      ...base,
      side,
      urgency: "maker",
      reason: `direction ${dir} + action ${act} @ entry_quality ${answers.entryQuality.toFixed(1)}`,
    };
  }

  // 4. hold
  return {
    ...base,
    side: "none",
    urgency: "cancel_only",
    reason: `action ${act}: hold`,
  };
}

/**
 * Maker price for a passive entry.
 *
 * Buy maker rests at the bid; sell maker rests at the ask. We may improve by one
 * tick for queue priority ONLY while that still leaves the order strictly
 * passive.
 *
 * The spec's suggested formula was `min(bid + tick, ask - tick)` for a buy, but
 * that is wrong: with bid=79999.9 / ask=80000.1 / tick=0.1 it yields 80000, which
 * is INSIDE the spread and makes us the best bid — we get filled immediately
 * instead of resting. That is taker economics wearing a post-only label. This
 * implementation quotes the touch exactly - bid for a buy, ask for a sell -
 * and never improves inside the spread until markout says improving pays.
 */
export function makerPrice(
  side: Side,
  features: Features,
  tickSz: number,
  crossAllowed = false,
): { px: number; wouldCross: boolean } {
  const { bid, ask } = features;
  // STRICTLY on the touch: buy at the bid, sell at the ask. No one-tick
  // improvement inside a wider book. Improving buys queue priority but pays
  // adverse selection - we are the first to be filled by informed flow - and
  // nothing here has measured markout yet, so there is no evidence the
  // improvement is worth it. Revisit only when `npm run measure` shows the
  // fill-time markout at 1s/10s/60s is cheap enough to pay for it.
  const px = round(side === "buy" ? bid : ask, tickSz);
  return side === "buy"
    ? { px, wouldCross: px >= ask }
    : { px, wouldCross: px <= bid };
}

function round(px: number, tickSz: number): number {
  if (!(tickSz > 0)) return px;
  const raw = Math.floor(px / tickSz + 1e-9) * tickSz;
  // Strip binary-float noise: floor(79999.9/0.1)*0.1 is 79999.90000000001, and
  // that string is what we would send OKX as the price. 12 significant digits
  // is exact for every tick size and price this desk trades. Same trick as the
  // contract-count rounding in tick.ts.
  return Number(raw.toPrecision(12));
}

/** clOrdId: alnum, <= 32 chars. Must round-trip to the fill. */
export function makeClOrdId(sleeveId: string, seq: number, now = Date.now()): string {
  const clean = sleeveId.replace(/[^A-Za-z0-9]/g, "").slice(0, 10) || "sl";
  const id = `jev${clean}${now}${seq}`;
  return id.slice(0, 32);
}
