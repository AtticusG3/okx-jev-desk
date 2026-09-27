/**
 * Intent matrix: Jev answers -> the order the desk would send.
 *
 * These are the tests that matter most for capital safety. Each fixture is a
 * (answers, position, config) triple with the expected intent, so a change to
 * the policy table in risk/intent.ts has to be deliberate.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mapAnswers, makerPrice, makeClOrdId, DUMP_RISK_FORCE_EXIT } from "../src/risk/intent.ts";
import { holdAnswer } from "../src/jev/client.ts";
import type { Config } from "../src/config.ts";
import type { JevAnswers, Sleeve } from "../src/store/types.ts";
import type { Features } from "../src/features/compute.ts";

const cfg = (over: Partial<Config["risk"]> = {}): Config =>
  ({
    risk: {
      quoteUsd: 40, maxPosUsd: 200, maxGrossUsd: 800, maxDailyLossUsd: 80,
      minDirProb: 0.55, minDirConf: 0.45, minEntryQuality: 2.0,
      maxAddsPerSleeve: 2, maxOrdersPerMin: 20,
      maxSpreadBps: 25, minNotionalUsd: 10,
      alwaysPostOnly: true, enableAdd: false, ...over,
    },
  }) as Config;

function answers(o: Partial<JevAnswers> = {}): JevAnswers {
  return {
    direction: "flat", directionProbs: { long: 0.1, short: 0.1, flat: 0.8 },
    directionConfidence: 0.3, action: "hold",
    actionProbs: { open: 0, add: 0, hold: 1, reduce: 0, close: 0 },
    actionConfidence: 0.3, entryQuality: 2, entryProbs: {}, entryConfidence: 0.3,
    dumpRisk: 0.5, dumpProbs: {}, dumpConfidence: 0.3, buyersInControl: 0.5,
    latencyMs: 1, inputTokens: 0, outputTokens: 0, model: "test", ...o,
  };
}

function sleeve(o: Partial<Sleeve["position"]> = {}): Sleeve {
  return {
    id: "s1", instId: "BTC-USDT-SWAP", bot: "bot1", enabled: true,
    position: {
      instId: "BTC-USDT-SWAP", side: "flat", szContracts: 0, entryPx: 0,
      markPx: 0, notionalUsd: 0, unrealizedPnlUsd: 0, openedAt: null,
      leverage: 3, liqPx: null, ...o,
    },
    workingOrder: null, lastMid: 0, bookTs: 0, privateTs: 0,
    stats: { ticks: 0, ordersPlaced: 0, fills: 0, jevErrors: 0, lastJevLatencyMs: null, blockedByGate: 0 },
    recentTrades: [], candles1m: [], candles5m: [], lastJev: null, lastIntent: null,
  };
}

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

// --- 12-fixture matrix ---

test("1. brain error -> hold + cancel_only, never a direction", () => {
  const i = mapAnswers(holdAnswer("timeout"), sleeve(), feats(), cfg());
  assert.equal(i.side, "none");
  assert.equal(i.urgency, "cancel_only");
  assert.match(i.reason, /brain error/);
});

test("2. direction flat, flat book -> stay out", () => {
  const i = mapAnswers(answers(), sleeve(), feats(), cfg());
  assert.equal(i.side, "none");
  assert.equal(i.urgency, "cancel_only");
});

test("3. direction flat WITH a long position -> hold inventory (no new order)", () => {
  const i = mapAnswers(answers(), sleeve({ side: "long", szContracts: 1 }), feats(), cfg());
  assert.equal(i.side, "none");
  // Nothing is sent, so the intent must not claim a taker exit.
  assert.equal(i.urgency, "cancel_only");
});

test("4. long + open -> post-only BUY maker", () => {
  const a = answers({
    direction: "long", directionProbs: { long: 0.7, short: 0.15, flat: 0.15 },
    directionConfidence: 0.6, action: "open", entryQuality: 3,
  });
  const i = mapAnswers(a, sleeve(), feats(), cfg());
  assert.equal(i.side, "buy");
  assert.equal(i.urgency, "maker");
});

test("5. short + open -> post-only SELL maker", () => {
  const a = answers({
    direction: "short", directionProbs: { long: 0.1, short: 0.7, flat: 0.2 },
    directionConfidence: 0.6, action: "open", entryQuality: 3,
  });
  const i = mapAnswers(a, sleeve(), feats(), cfg());
  assert.equal(i.side, "sell");
  assert.equal(i.urgency, "maker");
});

test("6. add is refused by default (ENABLE_ADD=false safe default)", () => {
  const a = answers({
    direction: "long", directionProbs: { long: 0.7, short: 0.1, flat: 0.2 },
    action: "add", entryQuality: 3,
  });
  const i = mapAnswers(a, sleeve({ side: "long", szContracts: 1 }), feats(), cfg());
  assert.equal(i.side, "none");
  assert.match(i.reason, /add disabled/);
});

test("7. add allowed when ENABLE_ADD=true", () => {
  const a = answers({
    direction: "long", directionProbs: { long: 0.7, short: 0.1, flat: 0.2 },
    action: "add", entryQuality: 3,
  });
  const i = mapAnswers(a, sleeve({ side: "long", szContracts: 1 }), feats(), cfg({ enableAdd: true }));
  assert.equal(i.side, "buy");
  assert.equal(i.urgency, "maker");
});

test("8. dump risk high + long position -> TAKER SELL exit (overrides direction)", () => {
  const a = answers({
    direction: "long", directionProbs: { long: 0.8, short: 0.1, flat: 0.1 },
    action: "hold", dumpRisk: DUMP_RISK_FORCE_EXIT,
  });
  const i = mapAnswers(a, sleeve({ side: "long", szContracts: 1 }), feats(), cfg());
  assert.equal(i.side, "sell");
  assert.equal(i.urgency, "taker");
  assert.match(i.reason, /dump_risk/);
});

test("9. dump risk high + flat position -> no exit (nothing to exit)", () => {
  const a = answers({ direction: "flat", action: "hold", dumpRisk: 3 });
  const i = mapAnswers(a, sleeve(), feats(), cfg());
  assert.equal(i.side, "none");
});

test("10. direction opposes position -> flatten taker", () => {
  const a = answers({
    direction: "short", directionProbs: { long: 0.1, short: 0.7, flat: 0.2 },
    action: "hold",
  });
  const i = mapAnswers(a, sleeve({ side: "long", szContracts: 1 }), feats(), cfg());
  assert.equal(i.side, "sell");
  assert.equal(i.urgency, "taker");
  assert.match(i.reason, /opposes/);
});

test("11. action=close with direction agreeing -> still flatten", () => {
  const a = answers({
    direction: "long", directionProbs: { long: 0.6, short: 0.2, flat: 0.2 },
    action: "close",
  });
  const i = mapAnswers(a, sleeve({ side: "long", szContracts: 1 }), feats(), cfg());
  assert.equal(i.side, "sell");
  assert.equal(i.urgency, "taker");
});

test("12. action=reduce -> taker partial exit", () => {
  const a = answers({
    direction: "long", directionProbs: { long: 0.5, short: 0.2, flat: 0.3 },
    action: "reduce",
  });
  const i = mapAnswers(a, sleeve({ side: "long", szContracts: 1 }), feats(), cfg());
  assert.equal(i.side, "sell");
  assert.equal(i.urgency, "taker");
  assert.match(i.reason, /reduce/);
});

// --- maker pricing ---

test("maker buy quotes the BID exactly, never inside a wide book", () => {
  // 2-tick-wide book. Improving one tick (80000) would be inside the spread:
  // better queue position, but it pays adverse selection and nothing has
  // measured markout yet. Strictly on the touch.
  const f = feats({ bid: 79999.9, ask: 80000.1 });
  const r = makerPrice("buy", f, 0.1, false);
  assert.equal(r.px, f.bid, "buy rests at the bid");
  assert.notEqual(r.px, 80000, "must NOT improve into the spread");
  assert.equal(r.wouldCross, false);
  assert.ok(r.px < f.ask);
});

test("maker sell quotes the ASK exactly, never inside a wide book", () => {
  const f = feats({ bid: 79999.9, ask: 80000.1 });
  const r = makerPrice("sell", f, 0.1, false);
  assert.equal(r.px, f.ask, "sell rests at the ask");
  assert.notEqual(r.px, 80000, "must NOT improve into the spread");
  assert.equal(r.wouldCross, false);
  assert.ok(r.px > f.bid);
});

test("a one-tick-wide spread falls back to the touch instead of crossing", () => {
  const f = feats({ bid: 80000, ask: 80000.1 });
  const r = makerPrice("buy", f, 0.1, false);
  assert.equal(r.px, 80000, "no room to improve: rest at the bid");
  assert.equal(r.wouldCross, false, "and do NOT cross into taker territory");
});

test("a genuinely crossed book is still flagged, not silently taken", () => {
  // Defensive: gates already reject crossed books, but makerPrice must not
  // invent a passive price out of one.
  const f = feats({ bid: 80000.2, ask: 80000.1 });
  const r = makerPrice("buy", f, 0.1, false);
  assert.equal(r.wouldCross, true, "crossed input must be reported, not papered over");
});

test("clOrdId is <=32 chars and alnum only", () => {
  const id = makeClOrdId("btc1", 7, 1758000000000);
  assert.ok(id.length <= 32, `too long: ${id.length}`);
  assert.match(id, /^[A-Za-z0-9]+$/);
  assert.ok(id.startsWith("jev"));
});

test("clOrdId strips non-alnum from the sleeve id", () => {
  const id = makeClOrdId("ETH-USDT-SWAP#1/x", 1, 1758000000000);
  assert.match(id, /^[A-Za-z0-9]+$/);
  assert.ok(id.length <= 32);
});
