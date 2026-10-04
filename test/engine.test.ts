/**
 * Mode validation, Jev response parsing, and fill idempotency.
 *
 * The three things that must never silently do the wrong thing: start in the
 * wrong mode, act on a malformed brain answer, or count one fill twice.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { loadConfig, validate, ConfigError, loadDotEnv, deriveWsUrls } from "../src/config.ts";
import { parseAnswers, holdAnswer, makeBrain, MockBrain } from "../src/jev/client.ts";
import { buildState, stateBytes } from "../src/jev/state.ts";
import { Store } from "../src/store/db.ts";
import { parseCandle } from "../src/okx/wsPublic.ts";
import { toSleevePosition as posFromPrivate } from "../src/okx/wsPrivate.ts";
import { makeSleeve } from "../src/loop/tick.ts";
import { computeFeatures } from "../src/features/compute.ts";
import type { FillRecord } from "../src/store/types.ts";

import type { BookState } from "../src/store/types.ts";

/** A minimal live-looking book so computeFeatures has something to read. */
const book = (): BookState => ({
  instId: "BTC-USDT-SWAP",
  bids: [{ px: 79999.9, sz: 3 }, { px: 79999.8, sz: 2 }],
  asks: [{ px: 80000.1, sz: 2 }, { px: 80000.2, sz: 3 }],
  ts: Date.now(),
  synced: true,
});

const ENV = (o: Record<string, string> = {}): NodeJS.ProcessEnv => ({
  MODE: "mock", MODEL: "mock", ...o,
});

// ---------- mode / credentials ----------

test("MODE=live without LIVE_CONFIRM refuses to boot", () => {
  const cfg = loadConfig(ENV({ MODE: "live", OKX_API_KEY: "k", OKX_API_SECRET: "s", OKX_PASSPHRASE: "p" }));
  assert.throws(() => validate(cfg, { MODE: "live" }), ConfigError);
});

test("MODE=live with LIVE_CONFIRM but no keys refuses to boot", () => {
  const cfg = loadConfig(ENV({ MODE: "live" }));
  assert.throws(() => validate(cfg, { MODE: "live", LIVE_CONFIRM: "I_UNDERSTAND" }), ConfigError);
});

test("MODE=live fully configured boots and prints a checklist", () => {
  const cfg = loadConfig(ENV({ MODE: "live", OKX_API_KEY: "k", OKX_API_SECRET: "s", OKX_PASSPHRASE: "p" }));
  const r = validate(cfg, { MODE: "live", LIVE_CONFIRM: "I_UNDERSTAND", DASHBOARD_TOKEN: "t" });
  assert.equal(r.mode, "live");
  assert.ok(r.checklist.length > 0, "live mode must print a checklist");
});

test("MODE=demo without demo keys refuses to boot", () => {
  const cfg = loadConfig(ENV({ MODE: "demo" }));
  assert.throws(() => validate(cfg, { MODE: "demo" }), ConfigError);
});

test("MODEL=jev without a TypeSafe key refuses to boot", () => {
  const cfg = loadConfig(ENV({ MODEL: "jev" }));
  assert.throws(() => validate(cfg, { MODEL: "jev" }), ConfigError);
});

test("mock mode boots with no credentials at all", () => {
  const cfg = loadConfig(ENV({}));
  const r = validate(cfg, { MODE: "mock", MODEL: "mock" });
  assert.equal(r.mode, "mock");
});

test("an invalid MODE is rejected at load time", () => {
  assert.throws(() => loadConfig(ENV({ MODE: "yolo" })), ConfigError);
});

test("demo and live derive different WS hosts", () => {
  const demo = deriveWsUrls({ MODE: "demo", OKX_REST_BASE: "https://www.okx.com" }, "demo");
  const live = deriveWsUrls({ MODE: "live", OKX_REST_BASE: "https://www.okx.com" }, "live");
  assert.match(demo.pub, /wspap|wsuspap/);
  assert.match(live.pub, /^wss:\/\/ws\.okx\.com/);
  assert.notEqual(demo.pub, live.pub);
});

test("business WS is derived separately from public (candles are not on public)", () => {
  const u = deriveWsUrls({ MODE: "live", OKX_REST_BASE: "https://www.okx.com" }, "live");
  assert.match(u.bus, /\/ws\/v5\/business$/);
  assert.notEqual(u.bus, u.pub);
});

test(".env does not override a real environment variable", () => {
  const dir = mkdtempSync(join(tmpdir(), "desk-"));
  const p = join(dir, ".env");
  writeFileSync(p, "MODE=demo\nQUOTE_USD=99\n");
  const env: NodeJS.ProcessEnv = { QUOTE_USD: "42" };
  loadDotEnv(p, env);
  assert.equal(env.QUOTE_USD, "42", "real env wins");
  assert.equal(env.MODE, "demo", "missing keys are filled from .env");
  rmSync(dir, { recursive: true, force: true });
});

// ---------- Jev response parsing ----------

const goodRaw = {
  model: "jev-1.13.0",
  answers: {
    direction: { type: "choice", choice: "long", confidence: 0.62, probabilities: { long: 0.62, short: 0.2, flat: 0.18 } },
    action: { type: "choice", choice: "hold", confidence: 0.5, probabilities: { open: 0.1, add: 0.1, hold: 0.6, reduce: 0.1, close: 0.1 } },
    entry_quality: { type: "score", score: 2.1, confidence: 0.5, probabilities: { "0": 0.1, "1": 0.2, "2": 0.4, "3": 0.2, "4": 0.1 } },
    dump_risk: { type: "score", score: 1.4, confidence: 0.6, probabilities: { "0": 0.5, "1": 0.3, "2": 0.15, "3": 0.05 } },
  },
  usage: { input_tokens: 900, output_tokens: 40 },
};

test("a well-formed Jev response parses into the expected shape", () => {
  const a = parseAnswers(goodRaw, 120);
  assert.equal(a.direction, "long");
  assert.equal(a.directionConfidence, 0.62);
  assert.equal(a.action, "hold");
  assert.equal(a.entryQuality, 2.1);
  assert.equal(a.dumpRisk, 1.4);
  assert.equal(a.inputTokens, 900);
  assert.equal(a.model, "jev-1.13.0");
});

test("a response missing `answers` is rejected", () => {
  assert.throws(() => parseAnswers({ model: "x" }, 1));
});

test("a direction answer with no probabilities is rejected (cannot gate on P)", () => {
  const bad = { ...goodRaw, answers: { ...goodRaw.answers, direction: { type: "choice", choice: "long", confidence: 0.9 } } };
  assert.throws(() => parseAnswers(bad, 1), /probabilities/);
});

test("a wrong-typed direction answer is rejected", () => {
  const bad = { ...goodRaw, answers: { ...goodRaw.answers, direction: { type: "score", score: 1 } } };
  assert.throws(() => parseAnswers(bad, 1));
});

test("holdAnswer is a safe flat/hold, not a guess", () => {
  const h = holdAnswer("boom");
  assert.equal(h.direction, "flat");
  assert.equal(h.action, "hold");
  assert.equal(h.error, "boom");
  assert.equal(h.directionProbs.flat, 1);
});

test("a Jev HTTP error becomes hold, not an exception", async () => {
  const cfg = loadConfig(ENV({ MODEL: "jev", TYPESAFE_API_KEY: "k" }));
  const brain = makeBrain(cfg, (async () => new Response("nope", { status: 500 })) as typeof fetch);
  const a = await brain.ask("s", "{}", {} as never);
  assert.equal(a.action, "hold");
  assert.match(a.error ?? "", /500/);
});

test("a Jev timeout becomes hold", async () => {
  const cfg = loadConfig(ENV({ MODEL: "jev", TYPESAFE_API_KEY: "k", JEV_TIMEOUT_MS: "50" }));
  const brain = makeBrain(cfg, ((_u: unknown, init: { signal: AbortSignal }) =>
    new Promise((_res, rej) => {
      init.signal.addEventListener("abort", () => {
        const e = new Error("aborted");
        e.name = "AbortError";
        rej(e);
      });
    })) as unknown as typeof fetch);
  const a = await brain.ask("s", "{}", {} as never);
  assert.equal(a.action, "hold");
  assert.match(a.error ?? "", /timeout/);
});

test("a 429 becomes hold, not a retry storm", async () => {
  const cfg = loadConfig(ENV({ MODEL: "jev", TYPESAFE_API_KEY: "k" }));
  const brain = makeBrain(cfg, (async () => new Response("", { status: 429 })) as typeof fetch);
  const a = await brain.ask("s", "{}", {} as never);
  assert.match(a.error ?? "", /429/);
});

// ---------- state serialisation ----------

test("state stays under the 4KB cap and contains buckets not raw comparisons", () => {
  const s = makeSleeve("btc1", "BTC-USDT-SWAP", "bot1");
  const f = computeFeatures(s, { book: book(), fundingRate: 1e-5, nextFundingHours: 2, oiChange1hPct: null, tickSz: 0.1 })!;
  const state = buildState({ sleeve: s, features: f, pnl: { realizedUsd: 0, unrealizedUsd: 0, dailyPnlUsd: 0, dailyLossUsedFrac: 0, grossUsd: 0 }, mode: "mock", now: Date.now() });
  assert.ok(stateBytes(state) < 4096);
  const parsed = JSON.parse(state) as { market_snapshot: Record<string, string>; desk_context: { position_side: string } };
  assert.ok(parsed.market_snapshot.spread, "buckets present");
  assert.equal(parsed.desk_context.position_side, "flat");
});

// ---------- fill idempotency ----------

test("a duplicate tradeId is recorded once", () => {
  const dir = mkdtempSync(join(tmpdir(), "desk-db-"));
  const store = new Store(join(dir, "t.db"));
  const f: FillRecord = {
    ts: Date.now(), sleeveId: "s1", instId: "BTC-USDT-SWAP", ordId: "o1",
    clOrdId: "c1", side: "buy", px: 80000, sz: 1, fee: -1, realizedPnl: 0, tradeId: "T-1",
  };
  assert.equal(store.recordFill(f, "s1"), true, "first insert");
  assert.equal(store.recordFill(f, "s1"), false, "second insert rejected");
  assert.equal(store.recordFill({ ...f, tradeId: "T-2" }, "s1"), true, "a different tradeId is new");
  assert.equal(store.recentFills(10).length, 2);
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

test("realized PnL accumulates per UTC day and is the fill-table source of truth", () => {
  const dir = mkdtempSync(join(tmpdir(), "desk-db-"));
  const store = new Store(join(dir, "t.db"));
  const now = Date.now();
  const mk = (id: string, pnl: number): FillRecord => ({
    ts: now, sleeveId: "s1", instId: "BTC-USDT-SWAP", ordId: "o", clOrdId: "c",
    side: "sell", px: 80000, sz: 1, fee: 0, realizedPnl: pnl, tradeId: id,
  });
  store.recordFill(mk("A", 10), "s1");
  store.recordFill(mk("B", -3), "s1");
  assert.equal(store.realizedSince(0), 7);
  assert.equal(store.pnlForDay().realizedUsd, 7);
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

// ---------- exchange payload parsing ----------

test("candle arrays are parsed positionally, newest-first from the API", () => {
  // [ts,o,h,l,c,vol,volCcy,volCcyQuote,confirm]
  const c = parseCandle(["1758000000000", "1", "2", "0.5", "1.5", "10", "1", "1", "1"]);
  assert.equal(c.ts, 1758000000000);
  assert.equal(c.c, 1.5);
  assert.equal(c.confirm, true);
  assert.equal(parseCandle(["1", "1", "2", "0.5", "1.5", "10", "1", "1", "0"]).confirm, false);
});

test("a flat position parses to side=flat, not a phantom short", () => {
  const p = posFromPrivate("BTC-USDT-SWAP", {
    instId: "BTC-USDT-SWAP", pos: "0", avgPx: "0", upl: "0", mgnMode: "isolated", lever: "3",
  });
  assert.equal(p.side, "flat");
  assert.equal(p.szContracts, 0);
});

test("net-mode negative pos is a short, positive is a long", () => {
  const mk = (pos: string) => posFromPrivate("X", { instId: "X", pos, avgPx: "1", upl: "0", mgnMode: "isolated", lever: "3" });
  assert.equal(mk("-2").side, "short");
  assert.equal(mk("2").side, "long");
  assert.equal(mk("2").szContracts, 2);
});

test("the mock brain is self-consistent with the gates", async () => {
  const cfg = loadConfig(ENV({}));
  const brain = new MockBrain();
  const s = makeSleeve("btc1", "BTC-USDT-SWAP", "bot1");
  // Force a weak signal: below MIN_DIR_PROB the gates would block, so the mock
  // must not propose an entry at all.
  const f = computeFeatures(s, { book: book(), fundingRate: null, nextFundingHours: null, oiChange1hPct: null, tickSz: 0.1 })!;
  f.buckets.imbalance = "balanced";
  f.buckets.flow = "mixed";
  f.buckets.momentum_5m = "flat";
  const state = buildState({ sleeve: s, features: f, pnl: { realizedUsd: 0, unrealizedUsd: 0, dailyPnlUsd: 0, dailyLossUsedFrac: 0, grossUsd: 0 }, mode: "mock", now: Date.now() });
  const a = await brain.ask("s", state, f);
  assert.equal(a.direction, "flat");
  assert.equal(a.action, "hold");
  assert.notEqual(a.action, "open");
});

// --- WS URL derivation: blank must mean "derive", not "empty string" -------
// Regression: a fresh `cp .env.example .env && npm run engine` shipped
// `OKX_WS_PUBLIC=` (empty string, not undefined), which `??` accepted, and
// the engine died with `SyntaxError: Invalid URL:` before serving anything.
// The .env.example comment says "leave blank to derive", so blank must
// derive. This test is the public repo's first-contact guarantee.

test("blank OKX_WS_* in .env derives the URL instead of yielding an empty string", () => {
  const urls = deriveWsUrls({ OKX_WS_PUBLIC: "", OKX_WS_PRIVATE: "", OKX_WS_BUSINESS: "" }, "mock");
  for (const [k, v] of Object.entries(urls)) {
    assert.ok(v.startsWith("wss://"), `${k} should be a wss URL, got ${JSON.stringify(v)}`);
  }
  assert.match(urls.pub, /\/ws\/v5\/public$/);
  assert.match(urls.priv, /\/ws\/v5\/private$/);
  // Candles require the business endpoint - verified live.
  assert.match(urls.bus, /\/ws\/v5\/business$/);
});

test("whitespace-only WS override is treated as absent", () => {
  const urls = deriveWsUrls({ OKX_WS_PUBLIC: "   " }, "mock");
  assert.match(urls.pub, /^wss:\/\//);
});



// Regression: /(^|\.)us\.okx\.com/ was tested against the whole URL, so
// "https://us.okx.com" never matched (the char before "us" is "https:/") and
// the us region silently derived the GLOBAL ws.okx.com host.
test("us region REST base derives the us WS family, not the global one", () => {
  const us = deriveWsUrls({ OKX_REST_BASE: "https://us.okx.com" }, "live");
  assert.match(us.pub, /wsus\.okx\.com/);
  assert.doesNotMatch(us.pub, /:\/\/ws\.okx\.com/);
});

test("us demo region derives the wsuspap family", () => {
  const usDemo = deriveWsUrls({ OKX_REST_BASE: "https://us.okx.com" }, "demo");
  assert.match(usDemo.pub, /wsuspap\.okx\.com/);
});

test("us region check is anchored - a lookalike host is not treated as us", () => {
  const evil = deriveWsUrls({ OKX_REST_BASE: "https://us.okx.com.evil.test" }, "live");
  assert.doesNotMatch(evil.pub, /wsus\.okx\.com/);
  const notUs = deriveWsUrls({ OKX_REST_BASE: "https://www.okx.com" }, "live");
  assert.doesNotMatch(notUs.pub, /wsus\.okx\.com/);
});

