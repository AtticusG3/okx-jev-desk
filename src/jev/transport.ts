/**
 * Where the brain lives, and what it costs.
 *
 * Three transports are supported. All three speak the SAME protocol - POST a
 * `{ model, state, questions }` body and read `{ answers, usage }` back - so the
 * desk's question set, parser and gating are identical across all of them. Only
 * the URL, the credential and the price differ.
 *
 *   typesafe   POST https://api.typesafe.ai/v1/systemone   Bearer TYPESAFE_API_KEY
 *   openrouter POST https://openrouter.ai/api/v1/systemone Bearer OPENROUTER_API_KEY
 *   local      POST <JEV_BASE_URL>/v1/systemone           Bearer JEV_API_KEY (any)
 *
 * The openrouter case is why this module exists. OpenRouter is OpenAI-compatible
 * for chat, but System One models are exposed at a separate `/v1/systemone`
 * path that takes the identical typed-questions body, so pointing at it is a URL
 * and credential change rather than an adapter. Getting this wrong in either
 * direction is expensive in different ways: a wrong URL silently never calls the
 * brain, and a wrong price silently under-counts the spend cap.
 *
 * Pricing is per-transport and NEVER inferred from the model name. TypeSafe
 * publishes $0.042/MTok input with output free. OpenRouter's number is not
 * something this file should guess at, so `usdPerMtokInput: null` there forces
 * the cap to fall back on the cost the response actually reports. A guessed price
 * is worse than no price: it under-counts silently and the cap never trips.
 */

/** Transport used to reach the brain. */
export type JevProvider = "typesafe" | "openrouter" | "local";

export interface JevTransport {
  readonly provider: JevProvider;
  /** Full URL of the System One endpoint. No trailing slash. */
  readonly endpoint: string;
  /**
   * Token presented to the endpoint. Sent as `Authorization: Bearer <key>`
   * when non-empty; a local server that ignores auth may be given "".
   */
  readonly key: string;
  /**
   * USD per million input tokens, or null when unknown.
   *
   * null means "do not try to compute cost from tokens" - the caller must use
   * the cost the response reports, or record nothing. See usdForCall.
   */
  readonly usdPerMtokInput: number | null;
}

/** Published TypeSafe list price: input only, output egress is free. */
export const TYPESAFE_USD_PER_MTOK_INPUT = 0.042;

const ENDPOINTS: Record<JevProvider, string> = {
  typesafe: "https://api.typesafe.ai/v1/systemone",
  openrouter: "https://openrouter.ai/api/v1/systemone",
  local: "",
};

export class TransportError extends Error {}

/**
 * Resolve a transport from config values.
 *
 * `baseUrl` overrides the built-in endpoint. That is what makes the `local`
 * provider work against a self-hosted OpenJev shim, and it is also the escape
 * hatch for pinning a provider's hostname behind a proxy.
 */
export function resolveTransport(opts: {
  provider: string;
  baseUrl?: string;
  key: string;
}): JevTransport {
  const raw = (opts.provider ?? "").trim().toLowerCase();

  if (raw === "typesafe" || raw === "openrouter") {
    const provider = raw;
    // `??` is wrong here: config defaults baseUrl to the empty string, and ??
    // only falls through on null/undefined, so an unset base silently became
    // an empty endpoint and every request failed. Truthiness is the test.
    const base = (opts.baseUrl ?? "").trim() || ENDPOINTS[provider];
    const endpoint = base.replace(/\/+$/, "");
    if (!endpoint) throw new TransportError(`empty endpoint for ${provider}`);
    return {
      provider,
      endpoint,
      key: opts.key,
      // Only TypeSafe's rate is published. OpenRouter bills to its own account
      // and its rate is not ours to assert, so we refuse to invent one.
      usdPerMtokInput: provider === "typesafe" ? TYPESAFE_USD_PER_MTOK_INPUT : null,
    };
  }

  if (raw === "local") {
    // A self-hosted OpenJev (openjev/openjev) serves the same protocol at
    // /v1/systemone. The URL is mandatory: there is no default, because a
    // silent default would point at nothing and look like a working desk.
    const base = (opts.baseUrl ?? "").trim().replace(/\/+$/, "");
    if (!base) {
      throw new TransportError(
        "JEV_PROVIDER=local requires JEV_BASE_URL (e.g. http://127.0.0.1:3000). " +
          "A self-hosted OpenJev shim has no default address.",
      );
    }
    const endpoint = `${base}/v1/systemone`;
    return {
      provider: "local",
      endpoint,
      key: opts.key,
      // Self-hosted weights have no per-token meter. Reporting a price here
      // would invent a cost that does not exist and make the cap meaningless.
      usdPerMtokInput: null,
    };
  }

  throw new TransportError(
    `unknown JEV_PROVIDER=${opts.provider}; expected typesafe, openrouter or local`,
  );
}

/**
 * USD for one call, and whether that number is trustworthy.
 *
 * `reportedUsd` is the cost the provider itself returned. When present it wins,
 * because it is the amount actually billed and it cannot drift from a rate card
 * we copied some time ago. The per-MTok constant is only a fallback for a
 * transport that publishes a rate and does not report cost (TypeSafe).
 *
 * Returns null when neither is available - the caller must then record no cost
 * rather than record a guess, so the cap can distinguish "free" from "unknown".
 */
export function usdForCall(
  t: JevTransport,
  inputTokens: number,
  reportedUsd?: number | null,
): number | null {
  if (typeof reportedUsd === "number" && Number.isFinite(reportedUsd)) {
    return reportedUsd;
  }
  if (t.usdPerMtokInput !== null) {
    return (inputTokens / 1_000_000) * t.usdPerMtokInput;
  }
  return null;
}

/**
 * Extract a provider-reported cost from a usage block, if it carries one.
 *
 * OpenRouter puts the billed amount in `usage.cost`; TypeSafe does not report
 * one. Both are accepted, and both are treated as authoritative when present,
 * because the point is to never contradict the invoice.
 */
export function reportedCostFrom(
  usage: { cost?: unknown; total_cost?: unknown } | undefined,
): number | null {
  if (!usage) return null;
  for (const v of [usage.cost, usage.total_cost]) {
    if (typeof v === "number" && Number.isFinite(v)) return v;
  }
  return null;
}