/** Shared engine types. Kept dependency-free so features and loops can import both. */

import type { Session } from "../measure/era.ts";

export interface BookLevel {
  px: number;
  sz: number;
}

export interface BookState {
  instId: string;
  bids: BookLevel[]; // sorted desc
  asks: BookLevel[]; // sorted asc
  ts: number;
  synced: boolean;
}

export interface TradeTick {
  instId: string;
  tradeId: string;
  px: number;
  sz: number;
  side: "buy" | "sell";
  ts: number;
}

export type Side = "buy" | "sell";
export type PosSide = "long" | "short" | "flat";

export interface SleevePosition {
  instId: string;
  side: PosSide;
  szContracts: number;
  entryPx: number;
  markPx: number;
  notionalUsd: number;
  unrealizedPnlUsd: number;
  openedAt: number | null;
  leverage: number;
  liqPx: number | null;
}

export interface Sleeve {
  /** Stable id, also used as the clOrdId prefix. */
  id: string;
  instId: string;
  bot: string;
  enabled: boolean;
  position: SleevePosition;
  workingOrder: WorkingOrder | null;
  lastMid: number;
  bookTs: number;
  privateTs: number;
  /** Rolling per-sleeve counters for rate limits and the UI. */
  stats: {
    ticks: number;
    ordersPlaced: number;
    fills: number;
    jevErrors: number;
    lastJevLatencyMs: number | null;
    blockedByGate: number;
  };
  /** Trailing 30s counters for flow features, kept by the feature store. */
  recentTrades: { ts: number; px: number; sz: number; side: Side }[];
  candles1m: { ts: number; c: number; h: number; l: number; o: number; v: number }[];
  candles5m: { ts: number; c: number; h: number; l: number; o: number; v: number }[];
  lastJev: JevAnswers | null;
  lastIntent: SleeveIntent | null;
}

export interface WorkingOrder {
  clOrdId: string;
  ordId: string | null;
  side: Side;
  px: number;
  sz: number;
  ts: number;
  reduceOnly: boolean;
}

export type Dir = "long" | "short" | "flat";
export type Act = "open" | "add" | "hold" | "reduce" | "close";
export type Urgency = "maker" | "taker" | "cancel_only";

export interface JevAnswers {
  direction: Dir;
  directionProbs: Record<string, number>;
  directionConfidence: number;
  action: Act;
  actionProbs: Record<string, number>;
  actionConfidence: number;
  entryQuality: number;
  entryProbs: Record<string, number>;
  entryConfidence: number;
  dumpRisk: number;
  dumpProbs: Record<string, number>;
  dumpConfidence: number;
  buyersInControl: number;
  latencyMs: number;
  inputTokens: number;
  outputTokens: number;
  model: string;
  error?: string;
}

export interface SleeveIntent {
  side: Side | "none";
  urgency: Urgency;
  reason: string;
  jev: JevAnswers | null;
  /** What the gates did to the intent, for the audit trail. */
  gateNotes: string[];
  blocked: boolean;
}

export interface GateResult {
  ok: boolean;
  notes: string[];
}

export interface PnlSnapshot {
  realizedUsd: number;
  unrealizedUsd: number;
  dailyPnlUsd: number;
  dailyLossUsedFrac: number;
  grossUsd: number;
}

export interface TickRecord {
  ts: number;
  sleeveId: string;
  instId: string;
  mid: number;
  bid: number;
  ask: number;
  spreadBps: number;
  jev: JevAnswers | null;
  intent: SleeveIntent | null;
  gates: string[];
  executed: boolean;
  execNote: string;
  positionSide: PosSide;
  positionNotionalUsd: number;
  /** UTC session this tick belongs to: Asia 00-08, Europe 08-16, US 16-24. */
  session?: Session | null;
  /** Hash of the question file, bucket edges, PROOF_RULE.md and sizing. */
  era?: string | null;
  /** Era files that could not be hashed. Empty string means all were present. */
  eraMissing?: string | null;
}

export interface FillRecord {
  ts: number;
  sleeveId: string;
  instId: string;
  ordId: string;
  clOrdId: string;
  side: Side;
  px: number;
  sz: number;
  fee: number;
  realizedPnl: number;
  /** Idempotency key: tradeId from the exchange. */
  tradeId: string;
}
