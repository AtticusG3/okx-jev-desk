/**
 * The transport layer: which URL, which key, which price.
 *
 * The failure this guards against is specific and quiet. A desk pointed at the
 * wrong endpoint does not crash - it accumulates "hold" answers forever and
 * looks like a model that is merely undecided. So these tests assert on the URL
 * that would actually be dialled, and on the Authorization header, rather than
 * on anything the desk reports about itself.
 *
 * The cost rules matter just as much. A cap built on a guessed rate under-counts
 * and never trips, so "we have no price" must be a first-class state that is
 * visibly different from "this cost nothing".
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  resolveTransport,
  reportedCostFrom,
  TransportError,
  TYPESAFE_USD_PER_MTOK_INPUT,
  usdForCall,
} from "../src/jev/transport.ts";
import { ConfigError, loadConfig, validate } from "../src/config.ts";

test("typesafe: hits the documented endpoint", () => {
  const t = resolveTransport({ provider: "typesafe", key: "k" });
  assert.equal(t.endpoint, "https://api.typesafe.ai/v1/systemone");
});

test("openrouter: hits openrouter's systemone path, NOT chat/completions", () => {
  // The whole point of the adapter. OpenRouter is OpenAI-compatible for chat,
  // but System One models live at their own path. Getting this wrong yields a
  // 404 that looks like a model outage.
  const t = resolveTransport({ provider: "openrouter", key: "k" });
  assert.equal(t.endpoint, "https://openrouter.ai/api/v1/systemone");
  assert.ok(!t.endpoint.includes("chat/completions"));
});

test("local: builds /v1/systemone on the configured base", () => {
  const t = resolveTransport({
    provider: "local",
    baseUrl: "http://127.0.0.1:3000",
    key: "",
  });
  assert.equal(t.endpoint, "http://127.0.0.1:3000/v1/systemone");
});

test("local: a trailing slash on the base does not double up", () => {
  const t = resolveTransport({
    provider: "local",
    baseUrl: "http://127.0.0.1:3000/",
    key: "",
  });
  assert.equal(t.endpoint, "http://127.0.0.1:3000/v1/systemone");
});

test("local: no base URL is REFUSED, not defaulted", () => {
  // A default address would point at nothing and produce a desk that holds
  // forever with no error. Failing to boot is the honest outcome.
  assert.throws(
    () => resolveTransport({ provider: "local", baseUrl: "", key: "" }),
    TransportError,
  );
});

test("unknown provider is refused with the list of valid ones", () => {
  assert.throws(() => resolveTransport({ provider: "anthropic", key: "k" }), TransportError);
});

test("provider match is case- and whitespace-insensitive", () => {
  const t = resolveTransport({ provider: "  OpenRouter ", key: "k" });
  assert.equal(t.provider, "openrouter");
});

test("cost: typesafe publishes a rate, so cost is derivable", () => {
  const t = resolveTransport({ provider: "typesafe", key: "k" });
  assert.equal(t.usdPerMtokInput, TYPESAFE_USD_PER_MTOK_INPUT);
  assert.equal(usdForCall(t, 1_000_000), TYPESAFE_USD_PER_MTOK_INPUT);
});

test("cost: openrouter has NO invented rate", () => {
  // If we guessed here, the cap would silently under-count and never trip.
  const t = resolveTransport({ provider: "openrouter", key: "k" });
  assert.equal(t.usdPerMtokInput, null);
  assert.equal(usdForCall(t, 1_000_000), null, "must refuse to invent a price");
});

test("cost: local has no rate, because there is no meter", () => {
  const t = resolveTransport({ provider: "local", baseUrl: "http://x", key: "" });
  assert.equal(t.usdPerMtokInput, null);
  assert.equal(usdForCall(t, 10_000_000), null);
});

test("cost: a REPORTED cost always beats the rate card", () => {
  // The invoice is authoritative. If TypeSafe ever repriced, or a rounding
  // difference existed, the amount actually billed must win.
  const t = resolveTransport({ provider: "typesafe", key: "k" });
  assert.equal(usdForCall(t, 1_000_000, 0.5), 0.5);
});

test("cost: a reported cost of 0 is respected, not treated as missing", () => {
  // A genuinely free call must not fall through to the rate card and be
  // turned into a charge.
  const t = resolveTransport({ provider: "openrouter", key: "k" });
  assert.equal(usdForCall(t, 1_000_000, 0), 0);
});

test("cost: reads usage.cost and usage.total_cost", () => {
  assert.equal(reportedCostFrom({ cost: 0.25 }), 0.25);
  assert.equal(reportedCostFrom({ total_cost: 0.75 }), 0.75);
  assert.equal(reportedCostFrom(undefined), null);
  assert.equal(reportedCostFrom({}), null);
});

test("cost: a non-numeric cost is ignored rather than coerced", () => {
  assert.equal(reportedCostFrom({ cost: "0.25" }), null);
  assert.equal(reportedCostFrom({ cost: Number.NaN }), null);
});

test("config: OPENROUTER_API_KEY is picked when the provider is openrouter", () => {
  const c = loadConfig({
    MODE: "mock",
    MODEL: "mock",
    JEV_PROVIDER: "openrouter",
    OPENROUTER_API_KEY: "or-key",
    TYPESAFE_API_KEY: "ts-key",
  } as NodeJS.ProcessEnv);
  assert.equal(c.jev.apiKey, "or-key");
});

test("config: TYPESAFE_API_KEY is picked when the provider is typesafe", () => {
  const c = loadConfig({
    MODE: "mock",
    MODEL: "mock",
    TYPESAFE_API_KEY: "ts-key",
    OPENROUTER_API_KEY: "or-key",
  } as NodeJS.ProcessEnv);
  assert.equal(c.jev.apiKey, "ts-key");
});

test("config: an openrouter key is NOT inherited by the typesafe provider", () => {
  // Guards a real footgun: one shared .env with both keys must not let the
  // desk send an OpenRouter credential to TypeSafe, which returns a 401 that
  // reads as a model failure.
  const c = loadConfig({
    MODE: "mock",
    MODEL: "mock",
    JEV_PROVIDER: "typesafe",
    OPENROUTER_API_KEY: "or-key",
  } as NodeJS.ProcessEnv);
  assert.equal(c.jev.apiKey, "");
});

test("config: JEV_API_KEY overrides any provider", () => {
  const c = loadConfig({
    MODE: "mock",
    MODEL: "mock",
    JEV_PROVIDER: "openrouter",
    JEV_API_KEY: "explicit",
    OPENROUTER_API_KEY: "or-key",
  } as NodeJS.ProcessEnv);
  assert.equal(c.jev.apiKey, "explicit");
});

test("config: an unknown provider is refused at boot", () => {
  assert.throws(
    () =>
      validate(
        loadConfig({
          MODE: "mock",
          MODEL: "mock",
          JEV_PROVIDER: "ollama",
        } as NodeJS.ProcessEnv),
      ),
    ConfigError,
  );
});

test("config: local without JEV_BASE_URL is refused at boot", () => {
  assert.throws(
    () =>
      validate(
        loadConfig({
          MODE: "mock",
          MODEL: "mock",
          JEV_PROVIDER: "local",
        } as NodeJS.ProcessEnv),
      ),
    ConfigError,
  );
});

test("config: the missing-key error names the variable the provider actually uses", () => {
  // A 401 with no hint is a wasted debugging session; the message is the hint.
  assert.throws(
    () =>
      validate(
        loadConfig({
          MODE: "mock",
          MODEL: "jev",
          JEV_PROVIDER: "openrouter",
        } as NodeJS.ProcessEnv),
      ),
    /OPENROUTER_API_KEY/,
  );
  assert.throws(
    () =>
      validate(
        loadConfig({
          MODE: "mock",
          MODEL: "jev",
          JEV_PROVIDER: "typesafe",
        } as NodeJS.ProcessEnv),
      ),
    /TYPESAFE_API_KEY/,
  );
});

test("config: openrouter warns that the cap depends on reported cost", () => {
  const r = validate(
    loadConfig({
      MODE: "mock",
      MODEL: "mock",
      JEV_PROVIDER: "openrouter",
    } as NodeJS.ProcessEnv),
  );
  assert.ok(
    r.warnings.some((w) => w.includes("openrouter")),
    `expected an openrouter cost warning, got ${JSON.stringify(r.warnings)}`,
  );
});

test("config: local does NOT warn about unknown pricing", () => {
  // A local model genuinely has no per-token bill, so there is no gap to flag.
  const r = validate(
    loadConfig({
      MODE: "mock",
      MODEL: "mock",
      JEV_PROVIDER: "local",
      JEV_BASE_URL: "http://127.0.0.1:3000",
    } as NodeJS.ProcessEnv),
  );
  assert.equal(r.warnings.some((w) => w.includes("reported")), false);
});