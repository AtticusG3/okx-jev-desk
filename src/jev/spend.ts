/**
 * The Jev spend cap.
 *
 * Jev bills INPUT TOKENS ONLY (vendor figure: $0.042 per million input tokens,
 * output free). An uncapped desk that ticks every few seconds across several
 * sleeves spends without limit, and the bill is the one failure mode that does
 * not announce itself: the engine looks perfectly healthy while it drains money.
 *
 * So the cap is a HARD gate, in the same class as MAX_DAILY_LOSS_USD: when the
 * day's spend reaches the cap, every sleeve holds and no new entry may be taken
 * until 00:00 UTC. It is deliberately not a warning.
 *
 * The unit is USD, not call count. A shorter state costs less, so a fixed number
 * of calls would be the wrong thing to bound - the same call count can cost
 * wildly different amounts depending on how much state each tick carries.
 */

/** Vendor list price, USD per million input tokens. Output tokens are free. */
export const JEV_USD_PER_MTOK_INPUT = 0.042;

/** USD spent for `tokens` input tokens. */
export function usdForInputTokens(tokens: number): number {
  return (tokens / 1_000_000) * JEV_USD_PER_MTOK_INPUT;
}

/** Input tokens that `usd` buys, for budgeting a not-yet-made call. */
export function inputTokensForUsd(usd: number): number {
  return (usd / JEV_USD_PER_MTOK_INPUT) * 1_000_000;
}

/**
 * Start of the current UTC day, in ms. The cap resets on the UTC day boundary
 * because that is when the vendor's invoice day rolls; using a local-midnight
 * boundary would double-count or skip spend across the seam.
 */
export function utcDayStart(now: number): number {
  return Math.floor(now / 86_400_000) * 86_400_000;
}

/**
 * Decision tolerance, in USD.
 *
 * The cap is decided by summing tokens and converting to money, so a value
 * computed as exactly the ceiling can come back a few ulps under it
 * (inputTokensForUsd(2) -> usdForInputTokens() is 1.9999999999999999). Without
 * a tolerance the desk would let one more call through at the exact boundary,
 * which is the one place a budget most needs to be honest. Sized far below any
 * real difference: a whole extra call at desk scale is cents, not 1e-9.
 */
const USD_EPSILON = 1e-9;

/**
 * Decide whether the day is over budget.
 *
 * `spentUsd` is a DOLLAR FIGURE the caller already has, normally
 * SUM(calls.cost_usd) - the amount actually billed. It is not derived from
 * tokens here, because deriving it needs a rate that only one provider
 * publishes and the other two do not: a cap computed from a guessed rate
 * under-counts silently and never trips.
 *
 * `unpricedCalls` is how many calls in that window carried no cost at all. When
 * it is non-zero the total is an undercount, and the caller is expected to say
 * so rather than treat the ceiling as met.
 */
export function spendStatusUsd(
  spentUsd: number,
  capUsd: number,
  nowMs: number,
  unpricedCalls = 0,
): SpendStatus {
  return {
    spentUsd,
    capUsd,
    capped: capUsd > 0 && spentUsd >= capUsd - USD_EPSILON,
    resetsInMs: utcDayStart(nowMs) + 86_400_000 - nowMs,
    unpricedCalls,
  };
}

export interface SpendStatus {
  /** USD spent since the start of the current UTC day. */
  spentUsd: number;
  /** The configured ceiling, or 0 when the cap is disabled. */
  capUsd: number;
  /** True once the day's spend has reached the cap. */
  capped: boolean;
  /** ms until the cap resets at 00:00 UTC. */
  resetsInMs: number;
  /**
   * Calls in the window that carried no cost figure. Non-zero means `spentUsd`
   * is an UNDERCOUNT rather than a total, and the caller should say so instead
   * of reporting the cap as comfortably met.
   */
  unpricedCalls: number;
}

/**
 * Decide whether the brain may be asked again.
 *
 * `capUsd <= 0` disables the cap entirely. A disabled cap is reported as
 * `capped: false` with `capUsd: 0` so callers can surface "no cap" honestly
 * rather than looking like a cap that has just been hit.
 */
export function spendStatus(
  inputTokensToday: number,
  capUsd: number,
  now: number,
): SpendStatus {
  const spentUsd = usdForInputTokens(inputTokensToday);
  const dayStart = utcDayStart(now);
  return {
    spentUsd,
    capUsd,
    capped: capUsd > 0 && spentUsd >= capUsd - USD_EPSILON,
    resetsInMs: dayStart + 86_400_000 - now,
    // Every token-derived figure assumes the TypeSafe rate, so none of these
    // calls are unpriced. This path is now the fallback; the engine prefers
    // spendStatusUsd over the ledger's reported cost.
    unpricedCalls: 0,
  };
}

/**
 * Would one more call of `estimatedTokens` breach the cap?
 *
 * Used before asking, so the desk stops at the boundary rather than after it.
 * The estimate is deliberately pessimistic-by-omission: callers pass what they
 * know (state size) and a breach is judged on the cap alone. A single call that
 * overshoots slightly is acceptable; a desk that spends all day is not.
 */
export function wouldBreach(
  inputTokensToday: number,
  capUsd: number,
  estimatedTokens: number,
  now: number,
): boolean {
  if (capUsd <= 0) return false;
  return usdForInputTokens(inputTokensToday + estimatedTokens) >= capUsd - USD_EPSILON;
}