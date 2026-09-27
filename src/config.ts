/**
 * Config loading and mode validation.
 *
 * The whole safety model rests on one invariant: the engine must not be able to
 * run in a mode it was not configured for. `validate()` refuses to boot rather
 * than degrading quietly, because a desk that silently downgrades "live" to
 * "paper" is worse than a desk that will not start.
 */
import { readFileSync, existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export type Mode = "mock" | "demo" | "paper" | "live";
export type Model = "mock" | "jev";

export interface RiskConfig {
  quoteUsd: number;
  maxPosUsd: number;
  maxGrossUsd: number;
  maxDailyLossUsd: number;
  minDirProb: number;
  minDirConf: number;
  minEntryQuality: number;
  maxAddsPerSleeve: number;
  maxOrdersPerMin: number;
  maxSpreadBps: number;
  minNotionalUsd: number;
  alwaysPostOnly: boolean;
  enableAdd: boolean;
}

export interface Config {
  mode: Mode;
  model: Model;
  jev: {
    provider: string;
    apiKey: string;
    modelId: string;
    timeoutMs: number;
  };
  okx: {
    apiKey: string;
    apiSecret: string;
    passphrase: string;
    restBase: string;
    wsPublic: string;
    wsPrivate: string;
    instIds: string[];
    leverage: number;
    /**
     * Candles (candle1m/candle5m) are NOT on the public WS. Verified live
     * 2026-09-26: the public endpoint answers them with
     * "60018 Subscribe failed ... candle1m,instId:... doesn't exist".
     * They live on the business WS, which needs no auth but a different URL.
     */
    wsBusiness: string;
  };
  tickMs: number;
  /** Self-check cadence for the proof status (ms). */
  proofIntervalMs: number;
  /** Bootstrap resamples used by the self-check. */
  proofBootP: number;
  /** Settled rows a feature needs before the self-check scores it. */
  proofMinSettled: number;
  maxJevConcurrency: number;
  /** Bot instances per instrument. Each gets an isolated sleeve/position. */
  bots: string[];
  risk: RiskConfig;
  enginePort: number;
  dashboardToken: string;
}

export class ConfigError extends Error {}

/** Minimal .env parser. No dependency, no eval, no override of real env vars. */
export function loadDotEnv(path: string, into: NodeJS.ProcessEnv = process.env): void {
  if (!existsSync(path)) return;
  for (const raw of readFileSync(path, "utf8").split("\n")) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    let val = line.slice(eq + 1).trim();
    if (
      (val.startsWith('"') && val.endsWith('"')) ||
      (val.startsWith("'") && val.endsWith("'"))
    ) {
      val = val.slice(1, -1);
    }
    // Real environment always wins: a stale .env must not mask a deliberate
    // override for a single run.
    if (into[key] === undefined) into[key] = val;
  }
}

const MODES: Mode[] = ["mock", "demo", "paper", "live"];
const MODELS: Model[] = ["mock", "jev"];

function num(env: NodeJS.ProcessEnv, key: string, dflt: number): number {
  const raw = env[key];
  if (raw === undefined || raw === "") return dflt;
  const n = Number(raw);
  if (!Number.isFinite(n)) throw new ConfigError(`${key} must be a number, got "${raw}"`);
  return n;
}

function bool(env: NodeJS.ProcessEnv, key: string, dflt: boolean): boolean {
  const raw = env[key];
  if (raw === undefined || raw === "") return dflt;
  const v = raw.trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(v)) return true;
  if (["0", "false", "no", "off"].includes(v)) return false;
  throw new ConfigError(`${key} must be a boolean, got "${raw}"`);
}

/**
 * OKX documents demo trading as the *same REST host* with a
 * `x-simulated-trading: 1` header, and separate demo WS hosts. Rather than
 * trust that, the header is asserted at call time in rest.ts and the demo WS
 * host is explicit here so a misconfiguration is visible at boot.
 */
export function deriveWsUrls(env: NodeJS.ProcessEnv, mode: Mode): { pub: string; priv: string; bus: string } {
  // `?? ` is wrong here. A .env line like `OKX_WS_PUBLIC=` parses to the EMPTY
  // STRING, not undefined, so `??` accepts it and the engine dies at boot with
  // "Invalid URL: ". The comment in .env.example says "leave blank to derive" -
  // blank must therefore mean "derive", so treat whitespace as absent.
  const explicit = (v: string | undefined): string | undefined => {
    const t = (v ?? "").trim();
    return t === "" ? undefined : t;
  };
  const explicitPub = explicit(env.OKX_WS_PUBLIC);
  const explicitPriv = explicit(env.OKX_WS_PRIVATE);
  const explicitBus = explicit(env.OKX_WS_BUSINESS);

  // us.okx.com is the regional REST host; the public WS mirrors that region.
  // Anchor on the HOST component. Testing the whole URL with
  // /(^|\.)us\.okx\.com/ silently fails on "https://us.okx.com" because the
  // string before "us" is "https:/", not a dot or a start-of-string - so the
  // us region derived the global ws.okx.com host instead of wsus.okx.com.
  const restHost = (env.OKX_REST_BASE ?? "").replace(/^https?:\/\//, "").split("/")[0] ?? "";
  const isUs = /(^|\.)us\.okx\.com$/.test(restHost);
  const regional = isUs ? "wsus" : "ws";
  // Demo uses the `wsuspap` / `wspap` family; live uses `ws`.
  const demo = mode === "demo";
  const host = demo ? (isUs ? "wsuspap.okx.com:8443" : "wspap.okx.com:8443")
    : `${regional}.okx.com:8443`;
  return {
    pub: explicitPub ?? `wss://${host}/ws/v5/public`,
    priv: explicitPriv ?? `wss://${host}/ws/v5/private`,
    // Candles only: verified to require the business endpoint.
    bus: explicitBus ?? `wss://${host}/ws/v5/business`,
  };
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const mode = (env.MODE ?? "demo") as Mode;
  if (!MODES.includes(mode)) {
    throw new ConfigError(`MODE must be one of ${MODES.join("|")}, got "${mode}"`);
  }
  const model = (env.MODEL ?? "mock") as Model;
  if (!MODELS.includes(model)) {
    throw new ConfigError(`MODEL must be one of ${MODELS.join("|")}, got "${model}"`);
  }

  const { pub, priv, bus } = deriveWsUrls(env, mode);
  return {
    mode,
    model,
    jev: {
      provider: env.JEV_PROVIDER ?? "typesafe",
      apiKey: env.TYPESAFE_API_KEY ?? "",
      modelId: env.JEV_MODEL_ID ?? "jev-latest",
      timeoutMs: num(env, "JEV_TIMEOUT_MS", 1500),
    },
    okx: {
      apiKey: env.OKX_API_KEY ?? "",
      apiSecret: env.OKX_API_SECRET ?? "",
      passphrase: env.OKX_PASSPHRASE ?? "",
      restBase: (env.OKX_REST_BASE ?? "https://www.okx.com").replace(/\/+$/, ""),
      wsPublic: pub,
      wsPrivate: priv,
      wsBusiness: bus,
      instIds: (env.OKX_INST_IDS ?? "BTC-USDT-SWAP")
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean),
      leverage: num(env, "LEVERAGE", 3),
    },
    tickMs: num(env, "TICK_MS", 3000),
    maxJevConcurrency: num(env, "MAX_JEV_CONCURRENCY", 3),
    bots: (env.BOTS ?? "1")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean),
    /**
     * Self-check cadence. Deliberately long: the proof is a summary of a
     * 28-day ledger, and recomputing it every tick would spend real CPU on a
     * number that cannot change meaningfully in three seconds. It also reads
     * the whole ledger, so a short interval on a large db is a real cost.
     */
    proofIntervalMs: num(env, "PROOF_INTERVAL_MS", 900_000),
    /** Bootstrap resamples for the self-check. Same trade as npm run measure. */
    proofBootP: num(env, "PROOF_BOOT_P", 2000),
    /** Settled rows a feature needs before it is scored at all. */
    proofMinSettled: num(env, "PROOF_MIN_SETTLED", 500),
    risk: {
      quoteUsd: num(env, "QUOTE_USD", 40),
      maxPosUsd: num(env, "MAX_POS_USD", 200),
      maxGrossUsd: num(env, "MAX_GROSS_USD", 800),
      maxDailyLossUsd: num(env, "MAX_DAILY_LOSS_USD", 80),
      minDirProb: num(env, "MIN_DIR_PROB", 0.55),
      minDirConf: num(env, "MIN_DIR_CONF", 0.45),
      minEntryQuality: num(env, "MIN_ENTRY_QUALITY", 2.0),
      maxAddsPerSleeve: num(env, "MAX_ADDS_PER_SLEEVE", 2),
      maxOrdersPerMin: num(env, "MAX_ORDERS_PER_MIN", 20),
      maxSpreadBps: num(env, "MAX_SPREAD_BPS", 25),
      minNotionalUsd: num(env, "MIN_NOTIONAL_USD", 10),
      alwaysPostOnly: bool(env, "ALWAYS_POST_ONLY", true),
      enableAdd: bool(env, "ENABLE_ADD", false),
    },
    enginePort: num(env, "ENGINE_PORT", 3000),
    dashboardToken: env.DASHBOARD_TOKEN ?? "",
  };
}

export interface ValidationReport {
  mode: Mode;
  model: Model;
  warnings: string[];
  checklist: string[];
}

/**
 * Refuse to boot when mode and credentials disagree. Throws ConfigError with an
 * actionable message; a warning list is returned for things worth surfacing but
 * not fatal (e.g. live with no dashboard token).
 */
export function validate(c: Config, env: NodeJS.ProcessEnv = process.env): ValidationReport {
  const hasCreds = Boolean(c.okx.apiKey && c.okx.apiSecret && c.okx.passphrase);
  const warnings: string[] = [];
  const checklist: string[] = [];

  if (c.mode === "live") {
    if (env.LIVE_CONFIRM !== "I_UNDERSTAND") {
      throw new ConfigError(
        "MODE=live requires LIVE_CONFIRM=I_UNDERSTAND. Live trading places real " +
          "orders with real funds. The engine will not do this implicitly.",
      );
    }
    if (!hasCreds) {
      throw new ConfigError("MODE=live requires OKX_API_KEY / SECRET / PASSPHRASE.");
    }
    if (!c.dashboardToken) {
      warnings.push(
        "MODE=live with no DASHBOARD_TOKEN: the engine binds locally, but if you " +
          "expose it, mutating routes are unauthenticated. Set DASHBOARD_TOKEN.",
      );
    }
    checklist.push(
      "OKX API key: Trade + Read ONLY. Withdraw must be DISABLED on the key.",
      "Account mode supports isolated-margin SWAP.",
      "Position mode confirmed (net preferred).",
      `Leverage set from LEVERAGE=${c.okx.leverage} per sleeve.`,
      "Demo trading completed first (MODE=demo, real fills observed).",
      "Daily loss limit understood: MAX_DAILY_LOSS_USD=" + c.risk.maxDailyLossUsd,
    );
  }

  if (c.mode === "demo" && !hasCreds) {
    throw new ConfigError(
      "MODE=demo needs OKX demo keys (OKX_API_KEY / SECRET / PASSPHRASE). Create " +
        "them at OKX -> Trade -> Demo Trading -> Demo Trading API. For an offline " +
        "boot use MODE=mock instead.",
    );
  }

  if (c.mode === "paper" && hasCreds) {
    warnings.push(
      "MODE=paper ignores account state and places no orders; OKX credentials are " +
        "not required (and not used for orders) in this mode.",
    );
  }

  if (c.model === "jev" && !c.jev.apiKey) {
    throw new ConfigError(
      "MODEL=jev requires TYPESAFE_API_KEY. Use MODEL=mock for offline development.",
    );
  }
  if (c.model === "mock") {
    warnings.push("MODEL=mock: signals are a local heuristic, not Jev. Nothing here is an edge.");
  }
  if (c.jev.provider !== "typesafe") {
    warnings.push(
      `JEV_PROVIDER=${c.jev.provider} is not implemented in v1 and will throw. ` +
        "Only 'typesafe' and 'mock' are supported.",
    );
  }
  if (c.jev.modelId === "jev-latest") {
    warnings.push(
      "JEV_MODEL_ID=jev-latest is an alias and moves on release. Pin jev-1.13.0 " +
        "once you have tuned confidence thresholds against it.",
    );
  }
  if (c.okx.leverage > 10) {
    warnings.push(`LEVERAGE=${c.okx.leverage} is high for isolated perps.`);
  }
  if (c.tickMs < 1000) {
    warnings.push(
      `TICK_MS=${c.tickMs} is aggressive; OKX + Jev latency and rate limits usually ` +
        "make 3000ms the sane floor.",
    );
  }

  return { mode: c.mode, model: c.model, warnings, checklist };
}

export function repoRoot(): string {
  return resolve(dirname(fileURLToPath(import.meta.url)), "..");
}

export function defaultEnvPath(): string {
  return join(repoRoot(), ".env");
}
