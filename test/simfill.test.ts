/**
 * Simulated fills (paper/mock) must mark positions in USD, not contracts * px.
 *
 * Regression: applySimulatedFill set notionalUsd = contracts * px and realized
 * PnL = dPx * contracts. BTC-USDT-SWAP is ctVal=0.01 BTC, so a $40 clip at
 * 80k is 0.05 contracts (0.0005 BTC) but was recorded as 0.05 * 80000 = $4,000.
 * That blew MAX_POS_USD on the first fill and fed the same number to Jev.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { SleeveRunner, makeSleeve, type SleeveDeps } from "../src/loop/tick.ts";
import { toInstrument } from "../src/okx/instruments.ts";

const BTC = toInstrument({
  instType: "SWAP", instId: "BTC-USDT-SWAP", ctVal: "0.01", ctValCcy: "BTC", ctMult: "1",
  tickSz: "0.1", lotSz: "0.01", minSz: "0.01", state: "live",
});
const SOL = toInstrument({
  instType: "SWAP", instId: "SOL-USDT-SWAP", ctVal: "1", ctValCcy: "SOL", ctMult: "1",
  tickSz: "0.01", lotSz: "1", minSz: "1", state: "live",
});
// COIN-margined: contractValueUsd refuses it, so a sim fill must not invent a number.
const BTC_USD = toInstrument({
  instType: "SWAP", instId: "BTC-USD-SWAP", ctVal: "100", ctValCcy: "USD", ctMult: "1",
  quoteCcy: "BTC", tickSz: "0.1", lotSz: "1", minSz: "1", state: "live",
} as never);

function runner(inst: typeof BTC, instId: string) {
  const fills: Array<{ realizedPnl: number }> = [];
  const logs: string[] = [];
  const d = {
    instrument: inst,
    store: { recordFill: (f: { realizedPnl: number }) => { fills.push(f); return true; } },
    bus: { emit: () => {} },
    log: (m: string) => logs.push(m),
    runtime: { simulateFills: true, killSwitched: false, dailyLossTripped: false },
  } as unknown as SleeveDeps;
  const sleeve = makeSleeve("s1", instId, "bot1");
  return { r: new SleeveRunner(sleeve, d), sleeve, fills, logs };
}

test("BTC paper notional: ctVal 0.01, 0.06 contracts, px 67000 -> ~40.2 USD", () => {
  // The exact regression the spec calls out. 0.06 * 67000 * 0.01 = 40.2.
  // contracts * px would have said 4020.
  const { r, sleeve } = runner(BTC, "BTC-USDT-SWAP");
  r.applySimulatedFill("buy", 67_000, 0.06, "0.06", false);
  assert.equal(sleeve.position.side, "long");
  assert.ok(
    Math.abs(sleeve.position.notionalUsd - 40.2) < 1e-9,
    `notional ${sleeve.position.notionalUsd}, expected 40.2`,
  );
  assert.ok(sleeve.position.notionalUsd < 200, "stays under MAX_POS_USD");
});

test("BTC: $40 clip is marked at ~$40, not ~$4,000", () => {
  const { r, sleeve } = runner(BTC, "BTC-USDT-SWAP");
  const px = 80_000;
  const szr = BTC.sizeForNotional(px, 40);
  assert.ok(szr.sz, "sizes");
  r.applySimulatedFill("buy", px, szr.contracts, szr.sz!, false);
  assert.equal(sleeve.position.side, "long");
  assert.ok(sleeve.position.notionalUsd <= 40 + 1e-9, `notional ${sleeve.position.notionalUsd}`);
  assert.ok(sleeve.position.notionalUsd > 30, `notional ${sleeve.position.notionalUsd}`);
  // The old bug: contracts * px.
  assert.notEqual(sleeve.position.notionalUsd, szr.contracts * px);
});

test("BTC: first sim fill stays under MAX_POS_USD=200", () => {
  const { r, sleeve } = runner(BTC, "BTC-USDT-SWAP");
  const szr = BTC.sizeForNotional(80_000, 40);
  r.applySimulatedFill("buy", 80_000, szr.contracts, szr.sz!, false);
  assert.ok(sleeve.position.notionalUsd < 200);
});

test("BTC: realized PnL on a sim close applies ctVal", () => {
  const { r, fills } = runner(BTC, "BTC-USDT-SWAP");
  r.applySimulatedFill("buy", 80_000, 0.05, "0.05", false);   // 0.05 ct = 0.0005 BTC = $40
  r.applySimulatedFill("sell", 81_000, 0.05, "0.05", true);  // +$1000/BTC
  assert.equal(fills.length, 1);
  // 0.0005 BTC * $1000 = $0.50. The old formula gave $50.
  assert.ok(Math.abs(fills[0]!.realizedPnl - 0.5) < 1e-9, `realized ${fills[0]!.realizedPnl}`);
});

test("BTC: short realized PnL sign and magnitude", () => {
  const { r, fills } = runner(BTC, "BTC-USDT-SWAP");
  r.applySimulatedFill("sell", 80_000, 0.05, "0.05", false);
  r.applySimulatedFill("buy", 79_000, 0.05, "0.05", true);
  assert.ok(Math.abs(fills[0]!.realizedPnl - 0.5) < 1e-9);
});

test("unrealized PnL marks with ctVal and tracks price between fills", () => {
  const { r, sleeve } = runner(BTC, "BTC-USDT-SWAP");
  r.applySimulatedFill("buy", 80_000, 0.05, "0.05", false);
  r.markSimulated(80_800);  // +1%
  assert.ok(Math.abs(sleeve.position.unrealizedPnlUsd - 0.4) < 1e-9, `upl ${sleeve.position.unrealizedPnlUsd}`);
  assert.ok(Math.abs(sleeve.position.notionalUsd - 40.4) < 1e-9);
  assert.equal(sleeve.position.markPx, 80_800);
});

test("SOL (ctVal=1): notional is contracts * px, unchanged", () => {
  const { r, sleeve } = runner(SOL, "SOL-USDT-SWAP");
  r.applySimulatedFill("buy", 120, 1, "1", false);
  assert.equal(sleeve.position.notionalUsd, 120);
});

test("non-USD-quoted contract: sim fill is refused, not guessed", () => {
  const { r, sleeve, logs } = runner(BTC_USD, "BTC-USD-SWAP");
  r.applySimulatedFill("buy", 80_000, 1, "1", false);
  assert.equal(sleeve.position.side, "flat");
  assert.equal(sleeve.position.notionalUsd, 0);
  assert.ok(logs.some((l) => /no contract value/.test(l)));
});
