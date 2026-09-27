/**
 * Size and price rounding. A 100x size error here places a catastrophic order,
 * so the rounding direction is asserted explicitly, not just the happy path.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { toInstrument, trimNum, loadInstruments } from "../src/okx/instruments.ts";

// BTC-USDT-SWAP real metadata shape (ctVal 0.01 BTC, tick 0.1, lot 0.001)
const BTC = toInstrument({
  instType: "SWAP",
  instId: "BTC-USDT-SWAP",
  ctVal: "0.01",
  ctValCcy: "BTC",
  ctMult: "1",
  tickSz: "0.1",
  lotSz: "0.001",
  minSz: "0.001",
  state: "live",
});

// SOL-USDT-SWAP (ctVal 1 SOL, tick 0.01, lot 1)
const SOL = toInstrument({
  instType: "SWAP",
  instId: "SOL-USDT-SWAP",
  ctVal: "1",
  ctValCcy: "SOL",
  tickSz: "0.01",
  lotSz: "1",
  minSz: "1",
  state: "live",
});

test("contract value = price * ctVal", () => {
  // 1 BTC = 0.01 contracts
  assert.equal(BTC.contractValueUsd(80000), 800);
});

test("$40 notional at 80000 = 0.05 contracts (ctVal 0.01 BTC = 800 USD)", () => {
  const r = BTC.sizeForNotional(80000, 40);
  assert.equal(r.reason, undefined);
  assert.equal(r.contracts, 0.05);
  assert.equal(r.sz, "0.05");
  assert.ok(Math.abs(r.notionalUsd - 40) < 1e-6);
});

test("size floors to lotSz and never rounds UP past intent", () => {
  // 1 contract = 800 USD. 1599/800 = 1.99875 -> floors to 1.998, not 2.
  const r = BTC.sizeForNotional(80000, 1599);
  assert.equal(r.contracts, 1.998, "floors, does not round up to 2");
  assert.ok(r.contracts * 800 <= 1599, "the filled notional is never above intent");
});

test("a target that floors to zero contracts reports 'zero'", () => {
  // $0.5 / 800 = 0.000625 contracts -> floors to 0.
  const r = BTC.sizeForNotional(80000, 0.5);
  assert.equal(r.sz, null);
  assert.equal(r.reason, "zero");
});

test("a nonzero size under minSz reports 'below_min'", () => {
  // 0.001 contract = 0.8 USD (minSz). $0.8 gives exactly minSz.
  // $0.5 with a bigger minSz gives a nonzero-but-illegal size.
  const big = toInstrument({
    instType: "SWAP", instId: "Z", ctVal: "0.01", ctValCcy: "BTC", tickSz: "0.1",
    lotSz: "0.001", minSz: "1", state: "live",
  });
  const r = big.sizeForNotional(80000, 400); // 0.5 contracts, minSz is 1
  assert.equal(r.sz, null);
  assert.equal(r.reason, "below_min");
  assert.equal(r.contracts, 0.5, "reports the size it WOULD have been");
});

test("zero/negative notional is rejected", () => {
  assert.equal(BTC.sizeForNotional(80000, 0).reason, "non_finite");
  assert.equal(BTC.sizeForNotional(80000, -5).reason, "non_finite");
});

test("bad price is rejected before any division", () => {
  assert.equal(BTC.sizeForNotional(0, 100).reason, "no_price");
  assert.equal(BTC.sizeForNotional(Number.NaN, 100).reason, "no_price");
});

test("a base-coin ctValCcy is accepted (it is USD at the current price)", () => {
  // BTC-USDT-SWAP really does have ctValCcy=BTC. Refusing it would make the
  // most liquid instrument on the exchange unsizable.
  assert.equal(BTC.sizeForNotional(80000, 400).sz, "0.5");
});

test("an explicitly COIN-margined contract refuses to size rather than guessing", () => {
  // quoteCcy = BTC means px is BTC-denominated and the USD formula differs.
  // Must fail loudly instead of mis-sizing by orders of magnitude.
  const coin = toInstrument({
    instType: "SWAP", instId: "Y", ctVal: "10", ctValCcy: "USD", quoteCcy: "BTC",
    tickSz: "0.01", lotSz: "1", minSz: "1", state: "live",
  });
  assert.equal(coin.contractValueUsd(10), null, "a BTC-quoted contract has no linear USD value");
  assert.equal(coin.sizeForNotional(10, 100).reason, "no_ctval");
});

test("roundPx floors to the tick grid", () => {
  assert.equal(BTC.roundPx(80000.09), 80000);
  assert.equal(BTC.roundPx(80000.1), 80000.1);
  assert.equal(SOL.roundPx(121.567), 121.56);
});

test("trimNum has no float noise, keeps the leading zero, no trailing zeros", () => {
  assert.equal(trimNum(5), "5");
  assert.equal(trimNum(0.1 + 0.2), "0.3");
  assert.equal(trimNum(1.2000000000000002), "1.2");
  assert.equal(trimNum(0.05), "0.05", "must not become '.05'");
  assert.equal(trimNum(0.125), "0.125");
  assert.equal(trimNum(0), "0");
});

test("loadInstruments filters unknown ids and non-live state", () => {
  const list = [
    { instType: "SWAP", instId: "BTC-USDT-SWAP", ctVal: "0.01", ctValCcy: "BTC", tickSz: "0.1", lotSz: "0.001", minSz: "0.001", state: "live" },
    { instType: "SWAP", instId: "ETH-USDT-SWAP", ctVal: "0.1", ctValCcy: "ETH", tickSz: "0.01", lotSz: "0.1", minSz: "0.1", state: "live" },
    { instType: "SWAP", instId: "OLD-USDT-SWAP", ctVal: "1", ctValCcy: "X", tickSz: "1", lotSz: "1", minSz: "1", state: "suspend" },
  ];
  const m = loadInstruments(list, ["BTC-USDT-SWAP", "ETH-USDT-SWAP", "OLD-USDT-SWAP", "NOPE-USDT-SWAP"]);
  assert.deepEqual([...m.keys()].sort(), ["BTC-USDT-SWAP", "ETH-USDT-SWAP"]);
});

test("SOL: 1 contract = 1 SOL, lotSz 1 means integers", () => {
  const r = SOL.sizeForNotional(120, 240);
  assert.equal(r.sz, "2");
  const r2 = SOL.sizeForNotional(120, 100);
  assert.equal(r2.sz, null, "0.83 contracts floors to 0");
  assert.equal(r2.reason, "zero");
});
