/**
 * Thin OKX v5 REST client.
 *
 * Deliberately hand-rolled rather than pulling an SDK: the spec requires hosts,
 * the demo header and WS order ops to be explicit, and a wrapper means the
 * signature path is ours and testable.
 *
 * Demo trading: the SAME REST host, plus header `x-simulated-trading: 1`.
 * We assert that at call time rather than trusting the comment above it.
 */
import { isoTimestamp, requestPath, sign } from "./sign.ts";
import type { Config, Mode } from "../config.ts";

export const DEMO_HEADER = "x-simulated-trading";

export interface OkxEnvelope<T> {
  code: string;
  msg: string;
  data: T;
}

export class OkxApiError extends Error {
  readonly httpStatus: number;
  readonly code: string;
  readonly okxMsg: string;
  readonly body: string;

  constructor(httpStatus: number, code: string, msg: string, body: string) {
    super(`OKX ${httpStatus} code=${code} msg=${msg}`);
    this.name = "OkxApiError";
    this.httpStatus = httpStatus;
    this.code = code;
    this.okxMsg = msg;
    this.body = body;
  }
}

export interface OkxRestOptions {
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

export class OkxRest {
  private readonly base: string;
  private readonly creds: { key: string; secret: string; passphrase: string };
  private readonly simulated: boolean;
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;

  constructor(cfg: Config, opts: OkxRestOptions = {}) {
    this.base = cfg.okx.restBase;
    this.creds = {
      key: cfg.okx.apiKey,
      secret: cfg.okx.apiSecret,
      passphrase: cfg.okx.passphrase,
    };
    // In mock/paper there is no account access at all; sending a demo header
    // there would be a lie about which environment we are talking to.
    this.simulated = cfg.mode === "demo";
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.timeoutMs = opts.timeoutMs ?? 10_000;
  }

  get demoHeader(): boolean {
    return this.simulated;
  }

  private headers(needsAuth: boolean, extra?: Record<string, string>): Record<string, string> {
    const h: Record<string, string> = { "Content-Type": "application/json", ...extra };
    if (this.simulated) h[DEMO_HEADER] = "1";
    if (needsAuth) {
      const ts = isoTimestamp();
      h["OK-ACCESS-KEY"] = this.creds.key;
      h["OK-ACCESS-TIMESTAMP"] = ts;
      // Placeholder: the real signature is added by request() with the exact
      // path+body, since the prehash needs them.
      h["OK-ACCESS-SIGN"] = sign(this.creds.secret, ts);
      h["OK-ACCESS-PASSPHRASE"] = this.creds.passphrase;
    }
    return h;
  }

  async request<T>(
    method: "GET" | "POST",
    path: string,
    params?: Record<string, string | number | undefined>,
    body?: unknown,
  ): Promise<T> {
    const fullPath = requestPath(path, params);
    const bodyText = body === undefined ? "" : JSON.stringify(body);
    const ts = isoTimestamp();
    const h = this.headers(true);
    // Re-sign with the true prehash (headers() cannot know the path).
    h["OK-ACCESS-TIMESTAMP"] = ts;
    h["OK-ACCESS-SIGN"] = sign(this.creds.secret, ts + method + fullPath + bodyText);

    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), this.timeoutMs);
    let res: Response;
    try {
      res = await this.fetchImpl(`${this.base}${fullPath}`, {
        method,
        headers: h,
        body: bodyText || undefined,
        signal: ac.signal,
      });
    } catch (e) {
      throw new OkxApiError(0, "network", e instanceof Error ? e.message : String(e), "");
    } finally {
      clearTimeout(timer);
    }

    const text = await res.text();
    let env: OkxEnvelope<T>;
    try {
      env = JSON.parse(text) as OkxEnvelope<T>;
    } catch {
      throw new OkxApiError(res.status, "parse", "non-JSON response", text.slice(0, 400));
    }
    if (!res.ok || (env.code !== "0" && env.code !== undefined)) {
      throw new OkxApiError(res.status, env.code ?? String(res.status), env.msg ?? "", text.slice(0, 400));
    }
    return env.data;
  }

  /** Public endpoints need no auth and must NOT carry credentials. */
  async publicRequest<T>(
    path: string,
    params?: Record<string, string | number | undefined>,
  ): Promise<T> {
    const fullPath = requestPath(path, params);
    const h: Record<string, string> = { "Content-Type": "application/json" };
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), this.timeoutMs);
    let res: Response;
    try {
      res = await this.fetchImpl(`${this.base}${fullPath}`, { method: "GET", headers: h, signal: ac.signal });
    } catch (e) {
      throw new OkxApiError(0, "network", e instanceof Error ? e.message : String(e), "");
    } finally {
      clearTimeout(timer);
    }
    const text = await res.text();
    let env: OkxEnvelope<T>;
    try {
      env = JSON.parse(text) as OkxEnvelope<T>;
    } catch {
      throw new OkxApiError(res.status, "parse", "non-JSON response", text.slice(0, 400));
    }
    if (!res.ok || (env.code !== "0" && env.code !== undefined)) {
      throw new OkxApiError(res.status, env.code ?? String(res.status), env.msg ?? "", text.slice(0, 400));
    }
    return env.data;
  }

  // ---------- public market data ----------

  instruments(instType = "SWAP"): Promise<InstrumentInfo[]> {
    return this.publicRequest<InstrumentInfo[]>("/api/v5/public/instruments", { instType });
  }
    fundingRate(instId: string): Promise<FundingInfo[]> {
    return this.publicRequest<FundingInfo[]>("/api/v5/public/funding-rate", { instId });
  }

  /**
   * Open-interest history at 5m granularity, USD notional, newest first.
   * Fields: [ts, oiUsd, oiCcy]. This is the only way to know the 1h change at
   * boot - /public/open-interest is a snapshot with no history, so without this
   * the first hour after every restart has no OI reading at all.
   */
  openInterestHistory(ccy: string, period = "5m"): Promise<string[][]> {
    return this.publicRequest<string[][]>("/api/v5/rubik/stat/contracts/open-interest-volume", {
      ccy,
      period,
    });
  }

  openInterest(instId: string): Promise<{ instId: string; oi: string; oiCcy: string; ts: string }[]> {
    return this.publicRequest("/api/v5/public/open-interest", { instType: "SWAP", instId });
  }
  markPrice(instId: string): Promise<{ instType: string; instId: string; markPx: string; ts: string }[]> {
    return this.publicRequest("/api/v5/public/mark-price", { instType: "SWAP", instId });
  }
  candles(instId: string, bar = "1m", limit = 100, after?: string): Promise<string[][]> {
    // NOTE: OKX returns candles NEWEST-FIRST, and `after` pages backwards in
    // time. Passing `before` would page forward. Getting this backwards yields
    // a feature series that looks plausible and is silently reversed.
    return this.publicRequest<string[][]>("/api/v5/market/candles", {
      instId,
      bar,
      limit: String(limit),
      ...(after ? { after } : {}),
    });
  }
  books(instId: string, sz = "5"): Promise<BookSnapshot[]> {
    return this.publicRequest<BookSnapshot[]>("/api/v5/market/books", { instId, sz });
  }
  trades(instId: string, limit = 100): Promise<TradeTick[]> {
    return this.publicRequest<TradeTick[]>("/api/v5/market/trades", { instId, limit: String(limit) });
  }
  fundingHistory(instId: string, limit = 100): Promise<FundingHistoryItem[]> {
    return this.publicRequest<FundingHistoryItem[]>("/api/v5/public/funding-rate-history", {
      instId,
      limit: String(limit),
    });
  }

  // ---------- account ----------

  balance(): Promise<BalanceDetail[]> {
    return this.request<BalanceDetail[]>("GET", "/api/v5/account/balance");
  }
  positions(instType = "SWAP"): Promise<Position[]> {
    return this.request<Position[]>("GET", "/api/v5/account/positions", { instType });
  }
  setLeverage(instId: string, lever: number, mgnMode = "isolated"): Promise<unknown> {
    return this.request("POST", "/api/v5/account/set-leverage", undefined, {
      instId,
      lever: String(lever),
      mgnMode,
    });
  }
  placeOrder(order: PlaceOrderRequest): Promise<PlaceOrderResult[]> {
    return this.request<PlaceOrderResult[]>("POST", "/api/v5/trade/order", undefined, order);
  }
  cancelOrder(instId: string, ordId?: string, clOrdId?: string): Promise<unknown> {
    return this.request("POST", "/api/v5/trade/cancel-order", undefined, { instId, ordId, clOrdId });
  }
  cancelAll(instId?: string): Promise<unknown[]> {
    return this.request<unknown[]>("POST", "/api/v5/trade/cancel-batch-orders", undefined,
      instId ? [{ instId }] : [{ instType: "SWAP" }]);
  }
  /** Live orders for a sleeve; used to rebuild state after a restart. */
  pendingOrders(instId?: string): Promise<OrderState[]> {
    return this.request<OrderState[]>("GET", "/api/v5/trade/orders-pending", instId ? { instId } : undefined);
  }
}

export interface InstrumentInfo {
  instType: string;
  instId: string;
  baseCcy?: string;
  quoteCcy?: string;
  ctVal?: string;
  ctValCcy?: string;
  ctMult?: string;
  tickSz?: string;
  lotSz?: string;
  minSz?: string;
  state?: string;
  lever?: string;
  maxLever?: string;
}

export interface FundingInfo {
  instId: string;
  fundingRate: string;
  nextFundingTime: string;
  fundingTime: string;
}

export interface BookSnapshot {
  asks: string[][]; // [price, sz, liquidated, orders]
  bids: string[][];
  ts: string;
}

export interface TradeTick {
  instId: string;
  tradeId: string;
  px: string;
  sz: string;
  side: "buy" | "sell";
  ts: string;
}

export interface FundingHistoryItem {
  instId: string;
  fundingRate: string;
  fundingTime: string;
  method?: string;
}

export interface BalanceDetail {
  ccy: string;
  eq?: string;
  availEq?: string;
  cashBal?: string;
  frozenBal?: string;
  uTime?: string;
}

export interface Position {
  instType: string;
  instId: string;
  pos: string; // "" or "0" means flat
  posSide: "long" | "short" | "net";
  avgPx: string;
  markPx?: string;
  upl: string;
  notionalUsd?: string;
  margin?: string;
  liqPx?: string;
  lever: string;
  mgnMode: string;
}

export interface PlaceOrderRequest {
  instId: string;
  tdMode: "isolated" | "cross" | "cash";
  side: "buy" | "sell";
  ordType: "post_only" | "limit" | "market" | "ioc" | "fok";
  sz?: string;
  px?: string;
  posSide?: "long" | "short" | "net";
  reduceOnly?: boolean;
  clOrdId?: string;
}

export interface PlaceOrderResult {
  clOrdId?: string;
  ordId?: string;
  tag?: string;
  sCode: string;
  sMsg: string;
}

export interface OrderState {
  instId: string;
  ordId: string;
  clOrdId: string;
  px: string;
  sz: string;
  side: "buy" | "sell";
  state: string;
  posSide?: string;
  reduceOnly?: string;
  ordType?: string;
  accFillSz?: string;
}

export type { Mode };
