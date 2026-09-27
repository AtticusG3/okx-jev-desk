/**
 * OKX v5 request signing.
 *
 * Signature = base64( HMAC-SHA256( secret, prehash ) ) where
 *   prehash = timestamp + method + requestPath + body
 * and `timestamp` is ISO-8601 with millisecond precision, e.g.
 * "2020-12-08T09:08:57.715Z".
 *
 * The method must be upper-case and the requestPath must be the path *with*
 * query string, exactly as sent. A trailing slash or a different case changes
 * the signature and produces a 401 that is painful to debug because the request
 * itself looks fine.
 *
 * The private WS login uses a frozen prehash with a fixed literal path,
 * "GET/users/self/verify" — note there is no separator and no leading slash.
 */
import { createHmac } from "node:crypto";

/** OK-ACCESS-TIMESTAMP format. Verified against OKX docs (v5 auth section). */
export function isoTimestamp(d: Date = new Date()): string {
  return d.toISOString();
}

export function prehash(timestamp: string, method: string, requestPath: string, body: string): string {
  return timestamp + method.toUpperCase() + requestPath + body;
}

export function sign(secret: string, prehashText: string): string {
  return createHmac("sha256", secret).update(prehashText).digest("base64");
}

export interface SignInput {
  secret: string;
  method: string;
  requestPath: string;
  body?: string;
  timestamp?: string;
}

export function signRequest(i: SignInput): { timestamp: string; sign: string } {
  const timestamp = i.timestamp ?? isoTimestamp();
  return { timestamp, sign: sign(i.secret, prehash(timestamp, i.method, i.requestPath, i.body ?? "")) };
}

/** The exact prehash string for private WS login. Frozen by OKX; do not build it. */
export const WS_LOGIN_PATH = "/users/self/verify";

export function signWsLogin(secret: string, timestamp: string): string {
  // NOTE: "GET" + "/users/self/verify" with no separator. This is what OKX
  // specifies; it looks wrong next to the REST prehash and that is fine.
  return sign(secret, timestamp + "GET" + WS_LOGIN_PATH);
}

/** Build `path?query` deterministically, preserving insertion order. */
export function requestPath(path: string, params?: Record<string, string | number | undefined>): string {
  if (!params) return path;
  const q = Object.entries(params)
    .filter(([, v]) => v !== undefined && v !== "")
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`)
    .join("&");
  return q ? `${path}?${q}` : path;
}
