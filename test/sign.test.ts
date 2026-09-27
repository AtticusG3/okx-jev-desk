/**
 * OKX signing fixtures.
 *
 * The sign is the one place where a silent error costs real money: a wrong
 * signature is a 401, but a *plausible* signature over the wrong prehash is
 * indistinguishable from a permissions problem. These fixtures pin the
 * prehash construction and the base64-HMAC output.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { isoTimestamp, prehash, sign, signRequest, signWsLogin, requestPath, WS_LOGIN_PATH } from "../src/okx/sign.ts";

const SECRET = "5018A4AA-20FF-4C2F-9E5B-1B2A3B4C5D6E";

test("isoTimestamp is ISO-8601 with millis and Z", () => {
  const ts = isoTimestamp(new Date("2020-12-08T09:08:57.715Z"));
  assert.equal(ts, "2020-12-08T09:08:57.715Z");
});

test("prehash = timestamp + METHOD + requestPath + body", () => {
  const p = prehash("2020-12-08T09:08:57.715Z", "get", "/api/v5/account/balance", "");
  // Method must be upper-cased regardless of caller casing.
  assert.equal(p, "2020-12-08T09:08:57.715ZGET/api/v5/account/balance");
});

test("prehash includes the body for POST", () => {
  const body = JSON.stringify({ instId: "BTC-USDT-SWAP" });
  const p = prehash("2020-12-08T09:08:57.715Z", "POST", "/api/v5/trade/order", body);
  assert.ok(p.endsWith(body));
});

test("sign is base64(HMAC-SHA256(secret, prehash))", () => {
  const pre = "2020-12-08T09:08:57.715ZGET/api/v5/account/balance";
  const expected = createHmac("sha256", SECRET).update(pre).digest("base64");
  assert.equal(sign(SECRET, pre), expected);
  // base64, not hex
  assert.match(sign(SECRET, pre), /^[A-Za-z0-9+/]+=*$/);
});

test("signRequest pins a known vector end to end", () => {
  const ts = "2020-12-08T09:08:57.715Z";
  const r = signRequest({
    secret: SECRET,
    method: "GET",
    requestPath: "/api/v5/account/balance",
    timestamp: ts,
  });
  const pre = ts + "GET/api/v5/account/balance";
  assert.equal(r.sign, createHmac("sha256", SECRET).update(pre).digest("base64"));
});

test("different body changes the signature", () => {
  const ts = "2020-12-08T09:08:57.715Z";
  const a = signRequest({ secret: SECRET, method: "POST", requestPath: "/api/v5/trade/order", body: "{}", timestamp: ts });
  const b = signRequest({ secret: SECRET, method: "POST", requestPath: "/api/v5/trade/order", body: '{"a":1}', timestamp: ts });
  assert.notEqual(a.sign, b.sign);
});

test("WS login prehash has NO separator between GET and the path", () => {
  assert.equal(WS_LOGIN_PATH, "/users/self/verify");
  const ts = "2020-12-08T09:08:57.715Z";
  const expected = createHmac("sha256", SECRET).update(ts + "GET" + "/users/self/verify").digest("base64");
  assert.equal(signWsLogin(SECRET, ts), expected);
  // Explicitly NOT the REST-style prehash (which has no slash before the path).
  assert.notEqual(signWsLogin(SECRET, ts), sign(SECRET, ts + "GET/api/v5/users/self/verify"));
});

test("requestPath appends query and skips empty values", () => {
  assert.equal(requestPath("/x", undefined), "/x");
  assert.equal(requestPath("/x", {}), "/x");
  assert.equal(requestPath("/x", { a: 1, b: "z" }), "/x?a=1&b=z");
  assert.equal(requestPath("/x", { a: 1, b: undefined, c: "" }), "/x?a=1");
});

test("requestPath encodes reserved characters", () => {
  assert.equal(requestPath("/x", { q: "a b&c" }), "/x?q=a%20b%26c");
});
