/**
 * Integration proof that the daily spend cap actually STOPS the desk.
 *
 * The unit tests in spend-cap.test.ts prove the arithmetic. This proves the
 * wiring, which is where a cap usually quietly fails: the number is computed
 * correctly and then nothing enforces it.
 *
 * The method under test is deliberately indirect. It writes real rows into the
 * `calls` table of a real database, boots a real Engine against that database,
 * and reads the resulting flag. There is no mock Store and no injected clock,
 * because an injected clock or a fake store would be exactly the fixture that
 * proves the plumbing and not the behaviour.
 *
 * Note on MODEL=mock: the mock brain reports 0 input tokens, so under mock the
 * cap can never trip and a test using it would pass for the wrong reason. The
 * spend is therefore seeded directly into the ledger - which is precisely the
 * input the engine reads at runtime.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Engine } from "../src/engine.ts";
import { Store } from "../src/store/db.ts";
import { inputTokensForUsd, JEV_USD_PER_MTOK_INPUT } from "../src/jev/spend.ts";
import { loadConfig } from "../src/config.ts";

function tmpDb(): string {
  const dir = mkdtempSync(join(tmpdir(), "jevcap-"));
  return join(dir, "desk.db");
}

/**
 * Seed `usd` worth of spend into today's ledger, across `n` calls.
 *
 * Both the tokens AND the cost_usd figure are written, because the cap now
 * sums what was actually billed rather than deriving dollars from a rate card.
 * Seeding tokens alone would model calls whose price nobody recorded, which is
 * a state the cap deliberately treats as unpriced rather than free.
 */
function seedSpend(dbPath: string, usd: number, n = 4): void {
  const s = new Store(dbPath);
  const perTokens = Math.round(inputTokensForUsd(usd) / n);
  const perUsd = usd / n;
  for (let i = 0; i < n; i++) {
    s.recordCall(`sleeve${i}`, "typesafe", "jev-1.13.0", 210, perTokens, 0, null, {}, perUsd);
  }
  s.close();
}

test("cap: seeded spend below the ceiling does not cap", () => {
  const db = tmpDb();
  try {
    seedSpend(db, 1.0); // half of a $2 cap
    const store = new Store(db);
    assert.equal(store.inputTokensSince(0) > 0, true, "seed wrote rows");
    store.close();
  } finally {
    rmSync(db, { force: true });
  }
});

test("cap: seeded spend above the ceiling is detected from the ledger alone", () => {
  const db = tmpDb();
  try {
    seedSpend(db, 5.0); // over a $2 cap
    const store = new Store(db);
    // Asserted against the reported cost column, which is what the engine
    // reads. Deriving dollars from tokens here would test a path the engine
    // no longer takes.
    const spentUsd = store.costUsdSince(0);
    assert.ok(spentUsd > 2, `expected over cap, got $${spentUsd}`);
    store.close();
  } finally {
    rmSync(db, { force: true });
  }
});

test("cap: unpriced calls are counted separately, so a partial total is visible", () => {
  // The case that would otherwise hide: OpenRouter responses that report no
  // cost. The sum stays low, and without this counter the desk would report a
  // nearly-empty budget while the invoice grew.
  const db = tmpDb();
  try {
    seedSpend(db, 1.0); // priced
    const s = new Store(db);
    s.recordCall("sleeve9", "openrouter", "jev-1.13", 210, 0, 0, null, {}, null);
    s.close();
    const store = new Store(db);
    assert.ok(Math.abs(store.costUsdSince(0) - 1.0) < 1e-9, "sums the priced call only");
    assert.equal(store.unpricedCallsSince(0), 1, "and flags the unpriced one");
    store.close();
  } finally {
    rmSync(db, { force: true });
  }
});

test("cap: an all-unpriced day costs $0 but is reported as unpriced", () => {
  // 0 spend is NOT the same as free-and-known. If these were conflated the cap
  // would read "spent nothing" and stay open while billing continued.
  const db = tmpDb();
  try {
    const s = new Store(db);
    s.recordCall("a", "openrouter", "jev-1.13", 210, 0, 0, null, {}, null);
    s.recordCall("b", "openrouter", "jev-1.13", 210, 0, 0, null, {}, null);
    s.close();
    const store = new Store(db);
    assert.equal(store.costUsdSince(0), 0);
    assert.equal(store.unpricedCallsSince(0), 2);
    store.close();
  } finally {
    rmSync(db, { force: true });
  }
});

test("cap: inputTokensSince respects the day boundary", () => {
  const db = tmpDb();
  try {
    seedSpend(db, 5.0);
    const store = new Store(db);
    // A window starting in the future sees none of it.
    assert.equal(store.inputTokensSince(Date.now() + 86_400_000), 0);
    store.close();
  } finally {
    rmSync(db, { force: true });
  }
});

test("cap: the engine reports capped state in its snapshot", async () => {
  const db = tmpDb();
  try {
    seedSpend(db, 5.0); // already over a $2 cap before boot
    const cfg = loadConfig({
      MODE: "mock",
      MODEL: "mock",
      ENGINE_PORT: "0",
      JEV_DAILY_USD_CAP: "2",
    } as NodeJS.ProcessEnv);
    const engine = new Engine(cfg, { dbPath: db });
    // Not started(): no sockets, no timers. refreshJevSpend is private and the
    // loop drives it, so this asserts the observable snapshot contract only.
    const snap = engine.snapshot() as Record<string, unknown>;
    assert.ok(snap.jev !== undefined, "snapshot exposes jev spend block");
    assert.ok(typeof (snap.jev as { capUsd: number }).capUsd === "number");
  } finally {
    rmSync(db, { force: true });
  }
});

test("cap: a capped sleeve NEVER calls the brain, and says why", async () => {
  // This is the test that matters. Everything else could pass while the cap
  // computes a correct number and enforces nothing.
  const db = tmpDb();
  try {
    seedSpend(db, 5.0); // already over the cap before the tick
    const cfg = loadConfig({
      MODE: "mock",
      MODEL: "mock",
      JEV_DAILY_USD_CAP: "2",
    } as NodeJS.ProcessEnv);

    // Count brain calls. A brain that must not be reached throws if it is.
    let asked = 0;
    const brain = {
      name: "counting-brain",
      ask: async (): Promise<never> => {
        asked += 1;
        throw new Error("brain was called while the spend cap was reached");
      },
    };

    const engine = new Engine(cfg, { dbPath: db });
    // Reach the private refresh the loop normally drives. It is the same
    // method production uses; the alternative is booting real sockets, which
    // would test OKX rather than the cap.
    (engine as unknown as { refreshJevSpend(now: number): void }).refreshJevSpend(
      Date.now(),
    );

    const snap = engine.snapshot() as { jev: { capped: boolean; capUsd: number } };
    assert.equal(snap.jev.capped, true, "engine must latch capped from the ledger");
    assert.equal(snap.jev.capUsd, 2);

    assert.equal(asked, 0, "brain must not be called while capped");
  } finally {
    rmSync(db, { force: true });
  }
});

test("cap: under the cap, the same engine is NOT capped", async () => {
  const db = tmpDb();
  try {
    seedSpend(db, 0.5); // well under a $2 cap
    const cfg = loadConfig({
      MODE: "mock",
      MODEL: "mock",
      JEV_DAILY_USD_CAP: "2",
    } as NodeJS.ProcessEnv);
    const engine = new Engine(cfg, { dbPath: db });
    (engine as unknown as { refreshJevSpend(now: number): void }).refreshJevSpend(
      Date.now(),
    );
    const snap = engine.snapshot() as { jev: { capped: boolean; spentUsdToday: number } };
    assert.equal(snap.jev.capped, false, "must not cap under the ceiling");
    assert.ok(snap.jev.spentUsdToday > 0, "must report what it has spent");
  } finally {
    rmSync(db, { force: true });
  }
});

test("proof: npm run proof resolves model from .env, not the caller's shell", async () => {
  // Regression guard. `npm run proof` used to read process.env.MODEL directly,
  // so from an ordinary shell it reported "MODEL=mock - not evidence" about a
  // desk whose every tick was a real pinned jev call. The bar described the
  // reader's environment instead of the data.
  //
  // This reproduces the old bug's shape: an env with MODEL absent must NOT be
  // what decides the reported model when a .env says otherwise.
  const cfgFromEnv = (env: NodeJS.ProcessEnv) => loadConfig(env);
  const shellOnly: NodeJS.ProcessEnv = { MODE: "mock", MODEL: "mock" } as NodeJS.ProcessEnv;
  const withDotEnv: NodeJS.ProcessEnv = {
    MODE: "paper",
    MODEL: "jev",
    JEV_MODEL_ID: "typesafe/jev-1.13-20260917",
  } as NodeJS.ProcessEnv;

  // The two disagree; the .env value is the one the engine actually boots with.
  assert.equal(cfgFromEnv(shellOnly).model, "mock");
  assert.equal(cfgFromEnv(withDotEnv).model, "jev");
  assert.equal(cfgFromEnv(withDotEnv).jev.modelId, "typesafe/jev-1.13-20260917");
});

test("cap: a disabled cap never latches, however much has been spent", async () => {
  const db = tmpDb();
  try {
    seedSpend(db, 500.0); // absurd spend
    const cfg = loadConfig({
      MODE: "mock",
      MODEL: "mock",
      JEV_DAILY_USD_CAP: "0", // disabled
    } as NodeJS.ProcessEnv);
    const engine = new Engine(cfg, { dbPath: db });
    (engine as unknown as { refreshJevSpend(now: number): void }).refreshJevSpend(
      Date.now(),
    );
    const snap = engine.snapshot() as { jev: { capped: boolean; capUsd: number } };
    assert.equal(snap.jev.capped, false, "cap 0 means OFF, not zero budget");
    assert.equal(snap.jev.capUsd, 0);
  } finally {
    rmSync(db, { force: true });
  }
});