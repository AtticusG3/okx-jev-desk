/**
 * Serialise engine state into the compact `state` string Jev evaluates.
 *
 * The spec caps state at ~2-4 KB. Two rules keep us there and keep accuracy up:
 *  - send NAMED BUCKETS for anything the questions reference, so the model never
 *    has to compare magnitudes itself (its documented weak spot);
 *  - include position/portfolio context because `action` cannot be answered
 *    without knowing the inventory.
 *
 * No secrets, no full-depth book, no trade-by-trade history, no prose.
 */
import type { Features } from "../features/compute.ts";
import type { PnlSnapshot, Sleeve } from "../store/types.ts";

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
  const entryVsMid = pos.entryPx > 0 && f.mid > 0
    ? Number((((f.mid - pos.entryPx) / pos.entryPx) * 10_000).toFixed(1))
    : 0;

  const state = {
    instrument: f.instId,
    as_of_utc: new Date(now).toISOString(),

    // Pre-computed numbers, for the record and for the shadow ledger.
    numbers: {
      mid: f.mid,
      bid: f.bid,
      ask: f.ask,
      spread_bps: f.spreadBps,
      spread_ticks: f.spreadTicks,
      book_imbalance: f.bookImbalance,
      trades_30s: f.tradeCount30s,
      volume_30s_usd: f.volume30sUsd,
      return_5m: f.ret5m,
      return_15m: f.ret15m,
      return_1h: f.ret1h,
      realized_vol_15m: f.realizedVol15m,
      realized_vol_1h: f.realizedVol1h,
      range_position_1h: f.rangePos1h,
      funding_rate: f.fundingRate,
      hours_to_funding: f.nextFundingHours,
    },

    // Only present when we actually have a reading. Sending
    // `open_interest_change_1h_pct: null` would be a missing input dressed up as
    // a value, and the model has no way to tell the difference. Omitted instead.
    // (Not in market_snapshot either: no question references it, and inventing a
    // bucket for a field Jev is never asked about would just be noise.)
    ...(f.oiChange1hPct === null ? {} : { open_interest: { change_1h_pct: f.oiChange1hPct } }),

    // The model's actual inputs: classified words, no arithmetic required.
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

    desk_context: {
      position_side: pos.side,
      position_size_usd: Number(pos.notionalUsd.toFixed(0)),
      entry_vs_mid_bps: entryVsMid,
      unrealized_pnl_usd: Number(pos.unrealizedPnlUsd.toFixed(2)),
      position_hold_minutes: pos.openedAt
        ? Math.round((now - pos.openedAt) / 60_000)
        : 0,
      open_order: s.workingOrder
        ? (s.workingOrder.side === "buy" ? "bid" : "ask")
        : "none",
      daily_pnl_usd: Number(pnl.dailyPnlUsd.toFixed(2)),
      daily_loss_budget_used: pnl.dailyLossUsedFrac >= 0.5
        ? (pnl.dailyLossUsedFrac >= 1 ? "fully_used" : "mostly_used")
        : (pnl.dailyLossUsedFrac >= 0.2 ? "partly_used" : "barely_used"),
      gross_exposure_usd: Number(pnl.grossUsd.toFixed(0)),
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
