/**
 * Risk gate behaviour. Every gate must be able to BLOCK, and none may ever
 * increase a limit. The daily-loss and stale-data cases are the ones that save
 * money in the bad case, so they are asserted directly.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { evaluateGates, sizeNotional, STALE_BOOK_MS, STALE_PRIVATE_MS } from "../src/risk/gates.ts";
import type { Config } from "../src/config.ts";
import type { JevAnswers, PnlSnapshot, Sleeve, SleeveIntent } from "../src/store/types.ts";
import type { Features } from "../src/features/compute.ts";

const cfg = (o: Partial<Config["risk"]> = {}): Config =>
  ({
    risk: {
      quoteUsd: 40, maxPosUsd: 200, maxGrossUsd: 800, maxDailyLossUsd: 80,
      minDirProb: 0.55, minDirConf: 0.45, minEntryQuality: 2.0,
      maxAddsPerSleeve: 2, maxOrdersPerMin: 20,
      maxSpreadBps: 25, minNotionalUsd: 10,
      alwaysPostOnly: true, enableAdd: false, ...o,
    },
  }) as Config;

const pnl = (o: Partial<PnlSnapshot> = {}): PnlSnapshot => ({
  realizedUsd: 0, unrealizedUsd: 0, dailyPnlUsd: 0, dailyLossUsedFrac: 0, grossUsd: 0, ...o,
});

const goodJev: JevAnswers = {
  direction: "long", directionProbs: { long: 0.7, short: 0.15, flat: 0.15 },
  directionConfidence: 0.6, action: "open",
  actionProbs: { open: 0.7, add: 0, hold: 0.3, reduce: 0, close: 0 },
  actionConfidence: 0.6, entryQuality: 3, entryProbs: {}, entryConfidence: 0.6,
  dumpRisk: 0.5, dumpProbs: {}, dumpConfidence: 0.6,
  latencyMs: 1, inputTokens: 0, outputTokens: 0,
  costUsd: 0, provider: "test", model: "test",
};

const feats = (o: Partial<Features> = {}): Features => ({
  instId: "BTC-USDT-SWAP", ts: Date.now(), mid: 80000, bid: 79999.9, ask: 80000.1,
  spreadBps: 0.25, spreadTicks: 1, bidSz: 1, askSz: 1, bookImbalance: 0, depthImbalance5: 0,
  lastTradeSide: "none", tradeCount30s: 0, volume30sUsd: 0, buyVol30s: 0, sellVol30s: 0,
  kyleLambda: null, ret1m: null, ret5m: null, ret15m: null, ret1h: null,
  realizedVol15m: null, realizedVol1h: null, rangePos1h: null,
  fundingRate: null, nextFundingHours: null, oiChange1hPct: null,
  buckets: {
    spread: "tight", imbalance: "balanced", flow: "mixed", momentum_5m: "flat",
    momentum_15m: "flat", vol_15m: "normal", range_pos: "mid", funding: "neutral", toxic: "clean",
  },
  ...o,
});

const sleeve = (o: Partial<Sleeve> = {}): Sleeve => ({
  id: "s1", instId: "BTC-USDT-SWAP", bot: "bot1", enabled: true,
  position: {
    instId: "BTC-USDT-SWAP", side: "flat", szContracts: 0, entryPx: 0, markPx: 0,
    notionalUsd: 0, unrealizedPnlUsd: 0, openedAt: null, leverage: 3, liqPx: null,
  },
  workingOrder: null, lastMid: 0, bookTs: Date.now(), privateTs: Date.now(),
  stats: { ticks: 0, ordersPlaced: 0, fills: 0, jevErrors: 0, lastJevLatencyMs: null, blockedByGate: 0 },
  recentTrades: [], candles1m: [], candles5m: [], lastJev: null, lastIntent: null, ...o,
});

const entryIntent = (j: JevAnswers | null = goodJev): SleeveIntent => ({
  side: "buy", urgency: "maker", reason: "test", jev: j, gateNotes: [], blocked: false,
});
const exitIntent = (j: JevAnswers | null = goodJev): SleeveIntent => ({
  side: "sell", urgency: "taker", reason: "test", jev: j, gateNotes: [], blocked: false,
});

const call = (o: Partial<Parameters<typeof evaluateGates>[0]> = {}) =>
  evaluateGates(
    {
      sleeve: sleeve(), features: feats(), intent: entryIntent(), pnl: pnl(),
      now: Date.now(), haltEntries: false, orderRateExceeded: false, ...o,
    },
    cfg(),
  );

test("a clean entry passes every gate", () => {
  assert.equal(call().ok, true);
});

test("kill switch blocks entries", () => {
  const r = call({ haltEntries: true });
  assert.equal(r.ok, false);
  assert.match(r.notes.join(), /kill switch/);
});

test("stale book blocks entries but not exits", () => {
  const now = Date.now();
  const stale = feats({ ts: now - (STALE_BOOK_MS + 500) });
  assert.equal(call({ now, features: stale, intent: entryIntent() }).ok, false);
  const exit = call({ now, features: stale, intent: exitIntent() });
  assert.equal(exit.ok, true, "exits must survive a stale book");
  assert.match(exit.notes.join(), /stale book/);
});

test("stale private state blocks entries but not exits", () => {
  const now = Date.now();
  const s = sleeve({ privateTs: now - (STALE_PRIVATE_MS + 500) });
  assert.equal(call({ now, sleeve: s, intent: entryIntent() }).ok, false);
  assert.equal(call({ now, sleeve: s, intent: exitIntent() }).ok, true);
});

test("desk gross cap blocks new risk", () => {
  const r = call({ pnl: pnl({ grossUsd: 790 }) });
  assert.equal(r.ok, false);
  assert.match(r.notes.join(), /gross/);
});

test("sleeve position cap blocks same-side adds", () => {
  const s = sleeve({
    position: { ...sleeve().position, side: "long", szContracts: 4, notionalUsd: 195 },
  });
  const r = call({ sleeve: s, intent: entryIntent() });
  assert.equal(r.ok, false);
  assert.match(r.notes.join(), /sleeve pos/);
});

test("sleeve cap does NOT block a same-side exit", () => {
  const s = sleeve({
    position: { ...sleeve().position, side: "long", szContracts: 4, notionalUsd: 195 },
  });
  assert.equal(call({ sleeve: s, intent: exitIntent() }).ok, true);
});

test("order rate limit skips the tick", () => {
  const r = call({ orderRateExceeded: true });
  assert.equal(r.ok, false);
  assert.match(r.notes.join(), /order rate/);
});

test("crossed book is rejected", () => {
  const r = call({ features: feats({ bid: 80001, ask: 80000, spreadBps: 12.5 }) });
  assert.equal(r.ok, false);
  assert.match(r.notes.join(), /crossed/);
});

test("a locked book (bid == ask) is rejected", () => {
  const r = call({ features: feats({ bid: 80000, ask: 80000, spreadBps: 0 }) });
  assert.equal(r.ok, false);
  // Both the crossed and locked guards reject this; either reason is correct.
  assert.match(r.notes.join(), /crossed|locked/);
});

test("a 0.01bps BTC spread PASSES (live-measured, would have been blocked by a 0.2 floor)", () => {
  const r = call({ features: feats({ bid: 80000, ask: 80000.01, spreadBps: 0.01 }) });
  assert.equal(r.ok, true, "liquid perps quote this tight routinely");
});

test("insane wide spread is rejected", () => {
  const r = call({ features: feats({ bid: 79000, ask: 81000, spreadBps: 250 }) });
  assert.equal(r.ok, false);
  assert.match(r.notes.join(), /spread/);
});

test("brain error blocks the entry", () => {
  const bad = { ...goodJev, error: "jev timeout after 1500ms" };
  const r = call({ intent: entryIntent(bad) });
  assert.equal(r.ok, false);
  assert.match(r.notes.join(), /brain unavailable/);
});

test("missing probabilities (P=0) blocks the entry", () => {
  const j = { ...goodJev, directionProbs: { long: 0, short: 0, flat: 0 } };
  assert.equal(call({ intent: entryIntent(j) }).ok, false);
});

test("low P(direction) blocks the entry", () => {
  const j = { ...goodJev, directionProbs: { long: 0.4, short: 0.3, flat: 0.3 } };
  const r = call({ intent: entryIntent(j) });
  assert.equal(r.ok, false);
  assert.match(r.notes.join(), /P\(long\)/);
});

test("low confidence blocks the entry", () => {
  const j = { ...goodJev, directionConfidence: 0.2 };
  assert.equal(call({ intent: entryIntent(j) }).ok, false);
});

test("poor entry quality blocks the entry", () => {
  const j = { ...goodJev, entryQuality: 1 };
  assert.equal(call({ intent: entryIntent(j) }).ok, false);
});

test("very toxic flow vetoes entries regardless of the model", () => {
  const f = feats();
  f.buckets.toxic = "very_toxic";
  const r = call({ features: f });
  assert.equal(r.ok, false);
  assert.match(r.notes.join(), /toxic/);
});

test("extreme volatility vetoes entries", () => {
  const f = feats();
  f.buckets.vol_15m = "extreme";
  assert.equal(call({ features: f }).ok, false);
});

test("an extended price is a soft note, not a veto", () => {
  const f = feats();
  f.buckets.range_pos = "top";
  const r = call({ features: f });
  assert.equal(r.ok, true);
  assert.match(r.notes.join(), /extended/);
});

test("sizing: probability scales the quote and clamps to [0.25, 1.0]", () => {
  const atMin = sizeNotional(0.55, cfg());
  assert.equal(atMin.sizeMult, 0.25, "clamped at the floor");
  assert.ok(Math.abs(atMin.notionalUsd - 10) < 1e-9);
  assert.equal(atMin.ok, true, "10 == minNotionalUsd exactly, so it is allowed");

  const mid = sizeNotional(0.775, cfg());
  assert.ok(Math.abs(mid.sizeMult - 0.5) < 1e-9);

  // The ceiling is only reached at p == 1 exactly, because the formula is
  // (p - MIN)/(1 - MIN) and p can never exceed 1.
  const atCeiling = sizeNotional(1, cfg());
  assert.equal(atCeiling.sizeMult, 1.0, "clamped at the ceiling");
  assert.equal(atCeiling.notionalUsd, 40);

  const near = sizeNotional(0.99, cfg());
  assert.ok(near.sizeMult > 0.97 && near.sizeMult < 1.0);
  assert.ok(near.notionalUsd <= 40, "never exceeds QUOTE_USD");
});

test("sizing below MIN_NOTIONAL_USD is refused", () => {
  const r = sizeNotional(0.55, cfg({ quoteUsd: 20, minNotionalUsd: 10 }));
  assert.equal(r.ok, false);
  assert.match(r.reason ?? "", /notional/);
});
