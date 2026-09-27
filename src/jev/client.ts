/**
 * Jev (TypeSafe System One) client + the mock brain.
 *
 * Endpoint: POST https://api.typesafe.ai/v1/systemone
 *   Authorization: Bearer $TYPESAFE_API_KEY
 *   { "model": "jev-latest", "state": "...", "questions": { ... } }
 *
 * Response: { model, answers: { <id>: {...} }, usage: { input_tokens, output_tokens } }
 *   choice -> { type, choice, probabilities, confidence }
 *   score  -> { type, score, legend, probabilities, confidence }
 *   noul   -> { type, noul }
 *
 * Failure policy: ANY error, timeout or malformed answer becomes a typed
 * "hold + cancel_only" answer carrying the reason. We never guess a direction
 * when the model did not answer. That single rule is the difference between a
 * desk that loses to bad luck and one that loses to bad code.
 */
import type { Config } from "../config.ts";
import { QUESTIONS } from "./questions.ts";
import type { Features } from "../features/compute.ts";
import type { Act, Dir, JevAnswers } from "../store/types.ts";
import { buildState, stateBytes } from "./state.ts";

const TYPESAFE_BASE = "https://api.typesafe.ai";
const MAX_STATE_BYTES = 4096; // spec: cap at ~2-4 KB

export interface Brain {
  readonly name: string;
  ask(sleeveId: string, state: string, features: Features): Promise<JevAnswers>;
}

interface RawAnswer {
  type?: string;
  choice?: string;
  score?: number;
  noul?: number;
  probabilities?: Record<string, number>;
  confidence?: number;
}

interface RawResponse {
  model?: string;
  answers?: Record<string, RawAnswer>;
  usage?: { input_tokens?: number; output_tokens?: number };
  error?: { message?: string } | string;
}

/** The answer used whenever the model fails, times out, or returns nonsense. */
export function holdAnswer(reason: string, latencyMs = 0): JevAnswers {
  return {
    direction: "flat",
    directionProbs: { long: 0, short: 0, flat: 1 },
    directionConfidence: 0,
    action: "hold",
    actionProbs: { open: 0, add: 0, hold: 1, reduce: 0, close: 0 },
    actionConfidence: 0,
    entryQuality: 0,
    entryProbs: {},
    entryConfidence: 0,
    dumpRisk: 4,
    dumpProbs: {},
    dumpConfidence: 0,
    buyersInControl: 0,
    latencyMs,
    inputTokens: 0,
    outputTokens: 0,
    model: "none",
    error: reason,
  };
}

function num(v: unknown, dflt: number): number {
  return typeof v === "number" && Number.isFinite(v) ? v : dflt;
}

function probs(a: RawAnswer | undefined, keys: string[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const k of keys) out[k] = num(a?.probabilities?.[k], 0);
  return out;
}

/** Validate + normalise the raw response. Throws on anything malformed. */
export function parseAnswers(raw: RawResponse, latencyMs: number): JevAnswers {
  const answers = raw.answers;
  if (!answers || typeof answers !== "object") {
    throw new Error("jev response missing `answers`");
  }
  const dir = answers.direction;
  const act = answers.action;
  if (!dir || dir.type !== "choice" || typeof dir.choice !== "string") {
    throw new Error("jev response missing choice answer `direction`");
  }
  if (!act || act.type !== "choice" || typeof act.choice !== "string") {
    throw new Error("jev response missing choice answer `action`");
  }
  const entry = answers.entry_quality;
  const dump = answers.dump_risk;
  const buyers = answers.buyers_in_control;

  const dirProbs = probs(dir, ["long", "short", "flat"]);
  // If probabilities are missing, we cannot gate on P(direction). Refuse rather
  // than substitute confidence for probability.
  if (Object.values(dirProbs).every((v) => v === 0)) {
    throw new Error("jev `direction` had no probabilities; cannot gate");
  }

  return {
    direction: dir.choice as Dir,
    directionProbs: dirProbs,
    directionConfidence: num(dir.confidence, 0),
    action: act.choice as Act,
    actionProbs: probs(act, ["open", "add", "hold", "reduce", "close"]),
    actionConfidence: num(act.confidence, 0),
    entryQuality: num(entry?.score, 0),
    entryProbs: probs(entry, ["0", "1", "2", "3", "4"]),
    entryConfidence: num(entry?.confidence, 0),
    dumpRisk: num(dump?.score, 4),
    dumpProbs: probs(dump, ["0", "1", "2", "3"]),
    dumpConfidence: num(dump?.confidence, 0),
    buyersInControl: num(buyers?.noul, 0.5),
    latencyMs,
    inputTokens: num(raw.usage?.input_tokens, 0),
    outputTokens: num(raw.usage?.output_tokens, 0),
    model: raw.model ?? "unknown",
  };
}

export class JevClient implements Brain {
  readonly name: string;
  private readonly key: string;
  private readonly modelId: string;
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof fetch;

  constructor(cfg: Config, fetchImpl: typeof fetch = fetch) {
    this.key = cfg.jev.apiKey;
    this.modelId = cfg.jev.modelId;
    this.timeoutMs = cfg.jev.timeoutMs;
    this.fetchImpl = fetchImpl;
    this.name = `jev:${this.modelId}`;
  }

  async ask(_sleeveId: string, state: string, _features: Features): Promise<JevAnswers> {
    if (!this.key) return holdAnswer("no TYPESAFE_API_KEY", 0);
    const bytes = stateBytes(state);
    if (bytes > MAX_STATE_BYTES) {
      return holdAnswer(`state ${bytes}B exceeds ${MAX_STATE_BYTES}B cap`, 0);
    }

    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), this.timeoutMs);
    const t0 = performance.now();
    try {
      const res = await this.fetchImpl(`${TYPESAFE_BASE}/v1/systemone`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${this.key}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model: this.modelId,
          state,
          questions: QUESTIONS,
        }),
        signal: ac.signal,
      });
      const latencyMs = Math.round(performance.now() - t0);
      if (res.status === 429 || res.status === 529) {
        return holdAnswer(`jev ${res.status} ${res.status === 429 ? "rate limited" : "overloaded"}`, latencyMs);
      }
      if (!res.ok) {
        const text = await res.text().catch(() => "");
        return holdAnswer(`jev http ${res.status}: ${text.slice(0, 160)}`, latencyMs);
      }
      const json = (await res.json()) as RawResponse;
      try {
        return parseAnswers(json, latencyMs);
      } catch (e) {
        return holdAnswer(`jev malformed: ${e instanceof Error ? e.message : String(e)}`, latencyMs);
      }
    } catch (e) {
      const latencyMs = Math.round(performance.now() - t0);
      if (e instanceof Error && e.name === "AbortError") {
        return holdAnswer(`jev timeout after ${this.timeoutMs}ms`, latencyMs);
      }
      return holdAnswer(`jev error: ${e instanceof Error ? e.message : String(e)}`, latencyMs);
    } finally {
      clearTimeout(timer);
    }
  }
}

/**
 * Offline brain. Same output shape, deliberately dumb: short-horizon momentum
 * plus a book-imbalance tilt. It exists so the whole stack — gates, sizing,
 * router, dashboard — can be built and tested without a paid key, and so a
 * MODEL=jev regression can be compared against a fixed baseline.
 *
 * It is NOT an edge and the UI labels it as such.
 */
export class MockBrain implements Brain {
  readonly name = "mock:momentum";

  async ask(_sleeveId: string, state: string, features: Features): Promise<JevAnswers> {
    const t0 = performance.now();
    const latencyMs = Math.round(performance.now() - t0) + 5; // pretend a small cost

    let posSide = "flat";
    try {
      const parsed = JSON.parse(state) as { desk_context?: { position_side?: string } };
      posSide = parsed.desk_context?.position_side ?? "flat";
    } catch {
      /* fall through to flat */
    }

    const b = features.buckets;
    // Score a naive direction from the bucketed inputs only.
    let score = 0;
    if (b.imbalance === "buy_heavy") score += 0.5;
    else if (b.imbalance === "buy_lean") score += 0.2;
    else if (b.imbalance === "sell_heavy") score -= 0.5;
    else if (b.imbalance === "sell_lean") score -= 0.2;
    if (b.flow === "strong_buying") score += 0.35;
    else if (b.flow === "buying") score += 0.15;
    else if (b.flow === "strong_selling") score -= 0.35;
    else if (b.flow === "selling") score -= 0.15;
    if (b.momentum_5m === "up") score += 0.2;
    else if (b.momentum_5m === "down") score -= 0.2;
    // Extended price: fade it slightly.
    if (b.range_pos === "top") score -= 0.15;
    else if (b.range_pos === "bottom") score += 0.15;
    // Toxic flow: stand aside.
    if (b.toxic === "very_toxic") score *= 0.3;
    if (b.vol_15m === "extreme") score *= 0.5;

    const dir: Dir = score > 0.25 ? "long" : score < -0.25 ? "short" : "flat";
    const p = Math.min(0.95, Math.max(0.3, 0.5 + score * 0.4));
    const rest = (1 - p) / 2;
    const directionProbs =
      dir === "long"
        ? { long: p, short: rest, flat: rest }
        : dir === "short"
        ? { long: rest, short: p, flat: rest }
        : { long: rest, short: rest, flat: p };

    // The mock must be SELF-CONSISTENT with the gates, or every tick produces a
    // nonsense "entry that was immediately blocked" and the audit trail becomes
    // noise. It only ever proposes a directional action when the implied
    // probability clears the same 0.55 bar the gates enforce; otherwise it
    // says flat/hold and the gates are not asked to arbitrate a bad proposal.
    const dirProb = dir === "long" ? p : dir === "short" ? p : 1;
    const entryAllowed = dir !== "flat" && dirProb >= 0.55;

    let act: Act;
    if (!entryAllowed) {
      act = "hold";
    } else if (posSide === "flat") {
      act = "open";
    } else if ((posSide === "long" && dir === "long") || (posSide === "short" && dir === "short")) {
      act = "add";
    } else {
      act = "close";
    }
    const actionProbs: Record<string, number> = { open: 0, add: 0, hold: 0, reduce: 0, close: 0 };
    actionProbs[act] = 0.7;
    actionProbs.hold = act === "hold" ? 0.7 : 0.3;

    const entryQuality =
      b.spread === "tight" && (b.imbalance.endsWith("heavy") || b.imbalance.endsWith("lean")) ? 3.5
      : b.spread === "tight" ? 3
      : b.spread === "normal" ? 2
      : b.spread === "wide" ? 1
      : 0.5;

    const dumpRisk =
      b.vol_15m === "extreme" ? 3
      : b.vol_15m === "elevated" ? 2
      : b.toxic === "very_toxic" ? 3
      : b.toxic === "toxic" ? 2
      : b.spread === "extreme" ? 3
      : b.spread === "wide" ? 2
      : 0.5;

    const buyers = b.imbalance === "buy_heavy" ? 0.85
      : b.imbalance === "buy_lean" ? 0.65
      : b.imbalance === "balanced" ? 0.5
      : b.imbalance === "sell_lean" ? 0.35
      : 0.15;

    const conf = Math.abs(score);
    return {
      direction: dir,
      directionProbs,
      directionConfidence: conf,
      action: act,
      actionProbs,
      actionConfidence: 0.7,
      entryQuality,
      entryProbs: {},
      entryConfidence: 0.5,
      dumpRisk,
      dumpProbs: {},
      dumpConfidence: 0.5,
      buyersInControl: buyers,
      latencyMs,
      inputTokens: 0,
      outputTokens: 0,
      model: "mock",
    };
  }
}

export function makeBrain(cfg: Config, fetchImpl?: typeof fetch): Brain {
  return cfg.model === "jev" ? new JevClient(cfg, fetchImpl) : new MockBrain();
}

export { buildState, stateBytes } from "./state.ts";
export { QUESTIONS } from "./questions.ts";
