/**
 * The client actually dials what the transport says it should.
 *
 * transport.test.ts proves resolveTransport returns the right URL. This proves
 * the client USES it. Those are separate claims and the gap between them is
 * where a silent hold-forever lives: a correct transport object that nothing
 * consults still produces a desk that never calls the brain and never explains
 * why.
 *
 * So every test here inspects the request that a stub fetch actually received.
 * No assertion is made about what the client reports about itself.
 *
 * The response doubles as a Jev System One reply, with `usage.cost` added,
 * because the cost path is only exercised by a real parse.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { JevClient } from "../src/jev/client.ts";
import { loadConfig, type Config } from "../src/config.ts";
import type { Features } from "../src/features/compute.ts";

interface Captured {
  url: string;
  init: RequestInit;
}

/** A stub fetch that records the request and returns a valid System One reply. */
function stubFetch(
  captured: Captured[],
  body: unknown = goodBody(),
  status = 200,
): typeof fetch {
  return (async (url: string | URL | Request, init?: RequestInit) => {
    captured.push({ url: String(url), init: init ?? {} });
    return new Response(JSON.stringify(body), {
      status,
      headers: { "Content-Type": "application/json" },
    });
  }) as unknown as typeof fetch;
}

function headersOf(c: Captured): Record<string, string> {
  return (c.init.headers ?? {}) as Record<string, string>;
}

/**
 * The single request a test made.
 *
 * tsconfig has noUncheckedIndexedAccess, so indexing an array of captures
 * yields `Captured | undefined`. This asserts length and returns the element,
 * which both narrows the type and produces a better failure than "cannot read
 * properties of undefined" when a client stops making requests.
 */
function one(got: Captured[]): Captured {
  assert.equal(got.length, 1, `expected exactly 1 request, got ${got.length}`);
  return got[0] as Captured;
}

function goodBody(cost?: number): Record<string, unknown> {
  const usage: Record<string, unknown> = { input_tokens: 1000, output_tokens: 0 };
  if (cost !== undefined) usage.cost = cost;
  return {
    model: "jev-1.13",
    answers: {
      direction: {
        type: "choice",
        choice: "long",
        probabilities: { long: 0.7, short: 0.15, flat: 0.15 },
        confidence: 0.6,
      },
      action: {
        type: "choice",
        choice: "hold",
        probabilities: { open: 0, add: 0, hold: 1, reduce: 0, close: 0 },
        confidence: 0.9,
      },
      entry_quality: { type: "score", score: 2, probabilities: { "2": 0.6 }, confidence: 0.4 },
      dump_risk: { type: "score", score: 1, probabilities: { "1": 0.7 }, confidence: 0.4 },
    },
    usage,
  };
}

function cfgFor(over: Record<string, string>): Config {
  return loadConfig({
    MODE: "mock",
    MODEL: "jev",
    JEV_TIMEOUT_MS: "5000",
    ...over,
  } as NodeJS.ProcessEnv);
}

// Minimal Features; the client's ask() ignores them, but the signature needs one.
const feats = {} as Features;
const STATE = JSON.stringify({ desk_context: { position_side: "flat" } });

test("openrouter: the client POSTs to openrouter's systemone path", async () => {
  const got: Captured[] = [];
  const c = new JevClient(
    cfgFor({ JEV_PROVIDER: "openrouter", OPENROUTER_API_KEY: "or-key" }),
    stubFetch(got),
  );
  await c.ask("s1", STATE, feats);
  assert.equal(got.length, 1, "must make exactly one request");
  assert.equal(one(got).url, "https://openrouter.ai/api/v1/systemone");
  assert.equal(one(got).init.method, "POST");
});

test("openrouter: sends the OpenRouter key as a bearer token", async () => {
  const got: Captured[] = [];
  const c = new JevClient(
    cfgFor({ JEV_PROVIDER: "openrouter", OPENROUTER_API_KEY: "or-secret" }),
    stubFetch(got),
  );
  await c.ask("s1", STATE, feats);
  assert.equal(headersOf(one(got)).Authorization, "Bearer or-secret");
});

test("openrouter: never sends a typesafe key to openrouter", async () => {
  const got: Captured[] = [];
  const c = new JevClient(
    cfgFor({
      JEV_PROVIDER: "openrouter",
      OPENROUTER_API_KEY: "or-secret",
      TYPESAFE_API_KEY: "ts-secret",
    }),
    stubFetch(got),
  );
  await c.ask("s1", STATE, feats);
  const auth = headersOf(one(got)).Authorization ?? "";
  assert.ok(!auth.includes("ts-secret"), "typesafe key must not leak to openrouter");
});

test("typesafe: the client still POSTs to api.typesafe.ai", async () => {
  const got: Captured[] = [];
  const c = new JevClient(
    cfgFor({ JEV_PROVIDER: "typesafe", TYPESAFE_API_KEY: "ts-key" }),
    stubFetch(got),
  );
  await c.ask("s1", STATE, feats);
  assert.equal(one(got).url, "https://api.typesafe.ai/v1/systemone");
});

test("local: the client dials the configured base", async () => {
  const got: Captured[] = [];
  const c = new JevClient(
    cfgFor({
      JEV_PROVIDER: "local",
      JEV_BASE_URL: "http://127.0.0.1:3000",
      JEV_API_KEY: "x",
    }),
    stubFetch(got),
  );
  await c.ask("s1", STATE, feats);
  assert.equal(one(got).url, "http://127.0.0.1:3000/v1/systemone");
});

test("local: a keyless shim is allowed to be called with no auth header", async () => {
  const got: Captured[] = [];
  const c = new JevClient(
    cfgFor({ JEV_PROVIDER: "local", JEV_BASE_URL: "http://127.0.0.1:3000" }),
    stubFetch(got),
  );
  const a = await c.ask("s1", STATE, feats);
  assert.equal(got.length, 1, "a local shim that ignores auth must still be reachable");
  assert.equal(a.error, undefined, "and must not be reported as an error");
});

test("local with no key does NOT hold (auth is optional locally)", async () => {
  // Contrast with the metered providers, where a missing key must hold rather
  // than fire an unauthenticated request that 401s.
  const got: Captured[] = [];
  const c = new JevClient(
    cfgFor({ JEV_PROVIDER: "local", JEV_BASE_URL: "http://127.0.0.1:3000" }),
    stubFetch(got),
  );
  const a = await c.ask("s1", STATE, feats);
  assert.equal(a.action, "hold");
});

test("a metered provider with no key HOLDS instead of making a doomed request", async () => {
  const got: Captured[] = [];
  const c = new JevClient(cfgFor({ JEV_PROVIDER: "openrouter" }), stubFetch(got));
  const a = await c.ask("s1", STATE, feats);
  assert.equal(got.length, 0, "must not dial with no credential");
  assert.equal(a.action, "hold");
  assert.match(a.error ?? "", /OPENROUTER|no API key/);
});

test("the request body is identical across providers: model, state, questions", async () => {
  const got: Captured[] = [];
  const c = new JevClient(
    cfgFor({ JEV_PROVIDER: "openrouter", OPENROUTER_API_KEY: "k", JEV_MODEL_ID: "jev-1.13" }),
    stubFetch(got),
  );
  await c.ask("s1", STATE, feats);
  const body = JSON.parse(String(one(got).init.body)) as Record<string, unknown>;
  assert.equal(body.model, "jev-1.13");
  assert.equal(body.state, STATE);
  assert.ok(body.questions && typeof body.questions === "object");
  // The reproducibility rule from client.ts: no sampling knob may appear here,
  // or two identical ticks could produce different ledger rows.
  for (const forbidden of ["temperature", "top_p", "seed", "max_tokens"]) {
    assert.equal(forbidden in body, false, `${forbidden} must not be sent`);
  }
});

test("cost: a reported usage.cost is what gets recorded", async () => {
  const got: Captured[] = [];
  const c = new JevClient(
    cfgFor({ JEV_PROVIDER: "openrouter", OPENROUTER_API_KEY: "k" }),
    stubFetch(got, goodBody(0.00042)),
  );
  const a = await c.ask("s1", STATE, feats);
  assert.equal(a.costUsd, 0.00042);
  assert.equal(a.provider, "openrouter");
});

test("cost: with no reported cost on openrouter, cost is NULL not 0", async () => {
  // The distinction that protects the cap: 0 would assert the call was free and
  // let the budget look untouched.
  const got: Captured[] = [];
  const c = new JevClient(
    cfgFor({ JEV_PROVIDER: "openrouter", OPENROUTER_API_KEY: "k" }),
    stubFetch(got, goodBody()),
  );
  const a = await c.ask("s1", STATE, feats);
  assert.equal(a.costUsd, null);
});

test("cost: typesafe derives cost from its published rate", async () => {
  const got: Captured[] = [];
  const c = new JevClient(
    cfgFor({ JEV_PROVIDER: "typesafe", TYPESAFE_API_KEY: "k" }),
    stubFetch(got, goodBody()),
  );
  const a = await c.ask("s1", STATE, feats);
  assert.equal(a.inputTokens, 1000);
  assert.ok(a.costUsd !== null && a.costUsd > 0, "typesafe must derive a cost");
});

test("a 404 from the wrong endpoint becomes a typed hold, never a throw", async () => {
  const got: Captured[] = [];
  const c = new JevClient(
    cfgFor({ JEV_PROVIDER: "openrouter", OPENROUTER_API_KEY: "k" }),
    stubFetch(got, { error: { message: "no route" } }, 404),
  );
  const a = await c.ask("s1", STATE, feats);
  assert.equal(a.action, "hold");
  assert.equal(a.direction, "flat");
  assert.match(a.error ?? "", /404/);
  assert.equal(a.costUsd, 0, "a call that failed billed nothing");
});

test("a 401 is surfaced as a hold naming the status", async () => {
  const got: Captured[] = [];
  const c = new JevClient(
    cfgFor({ JEV_PROVIDER: "openrouter", OPENROUTER_API_KEY: "wrong" }),
    stubFetch(got, { error: "invalid key" }, 401),
  );
  const a = await c.ask("s1", STATE, feats);
  assert.match(a.error ?? "", /401/);
});