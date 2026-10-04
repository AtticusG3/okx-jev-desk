/**
 * The daily spend cap and the live ramp.
 *
 * Two failure modes these tests exist to catch, both of which are silent:
 *
 *   1. A cap that only warns. If hitting the cap leaves the desk still calling
 *      Jev, the engine looks healthy and spends anyway - the exact failure the
 *      cap was added to prevent. So the assertion is on `capped`, not on a log.
 *
 *   2. A cap that a restart resets. Spend is summed from the `calls` table over
 *      the UTC day rather than kept in memory, so a crash loop cannot hand the
 *      desk a fresh budget every minute.
 *
 * The live ramp is tested separately because a ramp that made positions LARGER
 * would be worse than no ramp, which is why LIVE_SIZE_MULTIPLIER is validated
 * into [0, 1] rather than trusted.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  JEV_USD_PER_MTOK_INPUT,
  inputTokensForUsd,
  spendStatus,
  usdForInputTokens,
  utcDayStart,
  wouldBreach,
} from "../src/jev/spend.ts";
import { ConfigError, loadConfig, validate } from "../src/config.ts";

const HOUR = 3_600_000;
const DAY = 86_400_000;
/** A fixed instant so day-boundary maths is testable and not clock-dependent. */
const NOON = Date.UTC(2026, 9, 4, 12, 0, 0);

test("cost: 1M input tokens costs the vendor list price", () => {
  assert.equal(usdForInputTokens(1_000_000), JEV_USD_PER_MTOK_INPUT);
});

test("cost: output tokens are free, so only input is priced", () => {
  // The cap is computed from input_tokens alone. This asserts the shape of that
  // decision: 100M input is $4.20, and nothing in this module prices output.
  assert.ok(Math.abs(usdForInputTokens(100_000_000) - 4.2) < 1e-9);
});

test("cost: round-trips USD -> tokens -> USD", () => {
  const usd = 1.37;
  const tokens = inputTokensForUsd(usd);
  assert.ok(Math.abs(usdForInputTokens(tokens) - usd) < 1e-9);
});

test("day boundary: utcDayStart floors to midnight UTC, not local midnight", () => {
  const start = utcDayStart(NOON);
  assert.equal(start, Date.UTC(2026, 9, 4, 0, 0, 0));
  assert.equal(NOON - start, 12 * HOUR);
});

test("day boundary: just before midnight belongs to the previous day", () => {
  const justBefore = Date.UTC(2026, 9, 4, 23, 59, 59);
  assert.equal(utcDayStart(justBefore), Date.UTC(2026, 9, 4, 0, 0, 0));
});

test("day boundary: exactly midnight starts the new day", () => {
  const midnight = Date.UTC(2026, 9, 5, 0, 0, 0);
  assert.equal(utcDayStart(midnight), midnight);
});

test("cap: not capped below the ceiling", () => {
  const st = spendStatus(inputTokensForUsd(1.0), 2, NOON);
  assert.ok(Math.abs(st.spentUsd - 1) < 1e-9, `spentUsd was ${st.spentUsd}`);
  assert.equal(st.capped, false);
});

test("cap: capped exactly AT the ceiling (>=, not >)", () => {
  // Boundary discipline: spending the last cent must stop the desk. Using `>`
  // here would let it spend one more call past the budget.
  const st = spendStatus(inputTokensForUsd(2.0), 2, NOON);
  assert.equal(st.capped, true);
});

test("cap: a hair UNDER the ceiling is still capped (float tolerance)", () => {
  // Guards the epsilon. Without it this comes back uncapped and the desk spends
  // one more call at exactly the boundary.
  const justUnder = inputTokensForUsd(2.0) - 1e-3;
  assert.equal(spendStatus(justUnder, 2, NOON).capped, true);
});

test("cap: capped well past the ceiling", () => {
  const st = spendStatus(inputTokensForUsd(9.9), 2, NOON);
  assert.equal(st.capped, true);
});

test("cap: cap of 0 DISABLES rather than capping everything", () => {
  // 0 means "no cap". Reading it as "zero budget" would freeze the desk for
  // anyone who set it expecting it to be off.
  const st = spendStatus(inputTokensForUsd(500), 0, NOON);
  assert.equal(st.capped, false);
  assert.equal(st.capUsd, 0);
});

test("cap: reports time until reset", () => {
  const st = spendStatus(0, 2, NOON);
  assert.equal(st.resetsInMs, 12 * HOUR);
});

test("wouldBreach: stops BEFORE the call that would cross the line", () => {
  const today = inputTokensForUsd(1.9);
  const oneCall = inputTokensForUsd(0.5);
  assert.equal(wouldBreach(today, 2, oneCall, NOON), true);
});

test("wouldBreach: allows a call that fits under the ceiling", () => {
  const today = inputTokensForUsd(1.0);
  const oneCall = inputTokensForUsd(0.5);
  assert.equal(wouldBreach(today, 2, oneCall, NOON), false);
});

test("wouldBreach: a disabled cap never breaches", () => {
  assert.equal(wouldBreach(inputTokensForUsd(1000), 0, inputTokensForUsd(100), NOON), false);
});

test("config: JEV_DAILY_USD_CAP defaults to 2 (on, not off)", () => {
  const c = loadConfig({ MODE: "mock", MODEL: "mock" } as NodeJS.ProcessEnv);
  assert.equal(c.jevDailyUsdCap, 2);
});

test("config: TICK_MS defaults to 10000", () => {
  const c = loadConfig({ MODE: "mock", MODEL: "mock" } as NodeJS.ProcessEnv);
  assert.equal(c.tickMs, 10_000);
});

test("config: JEV_DAILY_USD_CAP=0 is honoured as disabled", () => {
  const c = loadConfig({
    MODE: "mock",
    MODEL: "mock",
    JEV_DAILY_USD_CAP: "0",
  } as NodeJS.ProcessEnv);
  assert.equal(c.jevDailyUsdCap, 0);
});

test("config: a NEGATIVE cap is refused, not clamped", () => {
  // Silently turning -5 into 0 would disable a cap the operator believed was on.
  assert.throws(
    () =>
      validate(
        loadConfig({
          MODE: "mock",
          MODEL: "mock",
          JEV_DAILY_USD_CAP: "-5",
        } as NodeJS.ProcessEnv),
      ),
    ConfigError,
  );
});

test("config: warns when a fast tick runs with the cap disabled", () => {
  // This is the unbounded-spend combination, and it must be loud.
  const env = {
    MODE: "mock",
    MODEL: "mock",
    TICK_MS: "1000",
    JEV_DAILY_USD_CAP: "0",
  } as NodeJS.ProcessEnv;
  const r = validate(loadConfig(env), env);
  assert.ok(
    r.warnings.some((w) => w.includes("unbounded brain")),
    `expected an unbounded-spend warning, got: ${JSON.stringify(r.warnings)}`,
  );
});

test("config: the default 10s tick does NOT warn about unbounded spend", () => {
  const r = validate(
    loadConfig({ MODE: "mock", MODEL: "mock" } as NodeJS.ProcessEnv),
  );
  assert.equal(
    r.warnings.some((w) => w.includes("unbounded brain")),
    false,
  );
});

test("ramp: defaults to 0.25 for 24h", () => {
  const c = loadConfig({ MODE: "mock", MODEL: "mock" } as NodeJS.ProcessEnv);
  assert.equal(c.liveSizeMultiplier, 0.25);
  assert.equal(c.liveRampHours, 24);
});

test("ramp: a multiplier above 1 is refused", () => {
  // A ramp that scales UP is not a ramp. Refuse rather than trust.
  assert.throws(
    () =>
      validate(
        loadConfig({
          MODE: "mock",
          MODEL: "mock",
          LIVE_SIZE_MULTIPLIER: "2",
        } as NodeJS.ProcessEnv),
      ),
    ConfigError,
  );
});

test("ramp: live with no CLOSE_LIVE_FILE warns there is no shell-only exit", () => {
  const env = {
    MODE: "live",
    MODEL: "mock",
    LIVE_CONFIRM: "I_UNDERSTAND",
    OKX_API_KEY: "k",
    OKX_API_SECRET: "s",
    OKX_PASSPHRASE: "p",
  } as NodeJS.ProcessEnv;
  const r = validate(loadConfig(env), env);
  assert.ok(
    r.warnings.some((w) => w.includes("CLOSE_LIVE_FILE")),
    `expected a CLOSE_LIVE_FILE warning, got: ${JSON.stringify(r.warnings)}`,
  );
});

test("ramp: live with no CLOSE_LIVE_FILE still gets a kill-switch note in the checklist", () => {
  const env = {
    MODE: "live",
    MODEL: "mock",
    LIVE_CONFIRM: "I_UNDERSTAND",
    OKX_API_KEY: "k",
    OKX_API_SECRET: "s",
    OKX_PASSPHRASE: "p",
  } as NodeJS.ProcessEnv;
  const r = validate(loadConfig(env), env);
  assert.ok(r.checklist.some((x) => x.includes("end this run")));
});

test("live checklist: states the spend cap and the ramp", () => {
  const env = {
    MODE: "live",
    MODEL: "mock",
    LIVE_CONFIRM: "I_UNDERSTAND",
    OKX_API_KEY: "k",
    OKX_API_SECRET: "s",
    OKX_PASSPHRASE: "p",
    CLOSE_LIVE_FILE: "/tmp/close-live",
  } as NodeJS.ProcessEnv;
  const r = validate(loadConfig(env), env);
  assert.ok(r.checklist.some((x) => x.includes("JEV_DAILY_USD_CAP=2")));
  assert.ok(r.checklist.some((x) => x.includes("LIVE_SIZE_MULTIPLIER=0.25")));
  assert.ok(r.checklist.some((x) => x.includes("touch /tmp/close-live")));
});

test("live checklist: a disabled cap says so in capitals", () => {
  const env = {
    MODE: "live",
    MODEL: "mock",
    LIVE_CONFIRM: "I_UNDERSTAND",
    OKX_API_KEY: "k",
    OKX_API_SECRET: "s",
    OKX_PASSPHRASE: "p",
    JEV_DAILY_USD_CAP: "0",
  } as NodeJS.ProcessEnv;
  const r = validate(loadConfig(env), env);
  const line = r.checklist.find((x) => x.includes("JEV_DAILY_USD_CAP"));
  assert.ok(line && line.includes("DISABLED"), `expected DISABLED, got: ${line}`);
});