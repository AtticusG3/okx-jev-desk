/**
 * Private WebSocket (v5): orders, fills, positions, account.
 *
 * This is the source of truth for fills. The engine MUST NOT count a fill from
 * its own order-placement return value — a post-only order that is immediately
 * cancelled produces no fill, and a REST/WS race can double-report. Fills are
 * keyed on the exchange's `tradeId` and de-duplicated in the store.
 *
 * Login signature prehash is timestamp + "GET" + "/users/self/verify" (no
 * separator). See sign.ts.
 */
import { WebSocket } from "ws";
import type { Config } from "../config.ts";
import { signWsLogin } from "./sign.ts";
import type { FillRecord, Side, SleevePosition } from "../store/types.ts";

export interface PrivateStatus {
  connected: boolean;
  authenticated: boolean;
  lastMessageAt: number | null;
  lastError: string | null;
  reconnects: number;
}

export interface PrivateHandler {
  onOrderUpdate?: (instId: string, o: OrderEvent) => void;
  onFill?: (f: FillEvent) => void;
  onPosition?: (instId: string, p: PositionEvent) => void;
  onAccount?: (a: AccountEvent) => void;
  onStatus?: (s: PrivateStatus) => void;
  onLog?: (m: string) => void;
}

export interface OrderEvent {
  instId: string;
  ordId: string;
  clOrdId: string;
  state: string;
  side: Side;
  px: string;
  sz: string;
  accFillSz: string;
  avgPx?: string;
  fee?: string;
  reduceOnly?: string;
  ordType?: string;
  code?: string;
  msg?: string;
}

export interface FillEvent {
  instId: string;
  tradeId: string;
  ordId: string;
  clOrdId: string;
  side: Side;
  px: string;
  sz: string;
  fee: string;
  feeCcy: string;
  realizedPnl: string;
  ts: string;
  execType?: string;
}

export interface PositionEvent {
  instId: string;
  pos: string;
  avgPx: string;
  markPx?: string;
  upl: string;
  notionalUsd?: string;
  mgnMode: string;
  lever: string;
  liqPx?: string;
}

export interface AccountEvent {
  totalEq?: string;
  details?: { ccy: string; eq?: string; availEq?: string; upl?: string }[];
}

const PING_MS = 20_000;

export class OkxPrivateWs {
  private ws: WebSocket | null = null;
  private timer: NodeJS.Timeout | null = null;
  private closed = false;
  private status: PrivateStatus = {
    connected: false,
    authenticated: false,
    lastMessageAt: null,
    lastError: null,
    reconnects: 0,
  };
  /** Set once login succeeds; guards re-subscribe after reconnect. */
  private loggedIn = false;

  private readonly cfg: Config;
  private readonly h: PrivateHandler;

  constructor(cfg: Config, h: PrivateHandler) {
    this.cfg = cfg;
    this.h = h;
  }

  statusSnapshot(): PrivateStatus {
    return { ...this.status };
  }

  connect(): void {
    this.closed = false;
    this.open();
  }

  private open(): void {
    const url = this.cfg.okx.wsPrivate;
    this.h.onLog?.(`private ws connecting ${url}`);
    const ws = new WebSocket(url, { handshakeTimeout: 10_000 });
    this.ws = ws;

    ws.on("open", () => {
      this.status.connected = true;
      this.loggedIn = false;
      this.h.onLog?.("private ws open; logging in");
      this.login();
      this.startPing();
      this.h.onStatus?.(this.statusSnapshot());
    });

    ws.on("message", (raw: Buffer) => this.onMessage(raw.toString()));

    ws.on("error", (err: Error) => {
      this.status.lastError = err.message;
      this.h.onLog?.(`private ws error: ${err.message}`);
      this.h.onStatus?.(this.statusSnapshot());
    });

    ws.on("close", () => {
      this.stopPing();
      this.status.connected = false;
      this.status.authenticated = false;
      this.loggedIn = false;
      this.h.onStatus?.(this.statusSnapshot());
      if (this.closed) return;
      this.status.reconnects += 1;
      const delay = Math.min(30_000, 1000 * 2 ** Math.min(5, this.status.reconnects));
      this.h.onLog?.(`private ws closed; reconnecting in ${delay}ms`);
      setTimeout(() => this.open(), delay);
    });
  }

  private login(): void {
    const ts = new Date().toISOString();
    const sign = signWsLogin(this.cfg.okx.apiSecret, ts);
    this.send({
      op: "login",
      args: [{
        apiKey: this.cfg.okx.apiKey,
        passphrase: this.cfg.okx.passphrase,
        timestamp: ts,
        sign,
      }],
    });
  }

  private subscribeAll(): void {
    const args: unknown[] = [
      { channel: "orders", instType: "SWAP" },
      { channel: "fills", instType: "SWAP" },
      { channel: "positions", instType: "SWAP" },
      { channel: "account" },
    ];
    this.send({ op: "subscribe", args });
  }

  private send(obj: unknown): void {
    if (this.ws?.readyState !== WebSocket.OPEN) return;
    // OKX wants a BARE "ping"/"pong" text frame, not JSON. Sending
    // JSON.stringify("ping") is the string "ping" WITHOUT quotes being
    // wrapped as a JSON string ("\"ping\""), which the exchange rejects with
    // error 60012 "Illegal request: ping" (observed live 2026-09-26).
    this.ws.send(typeof obj === "string" ? obj : JSON.stringify(obj));
  }

  private startPing(): void {
    this.stopPing();
    this.timer = setInterval(() => this.send("ping"), PING_MS);
  }

  private stopPing(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  private onMessage(text: string): void {
    this.status.lastMessageAt = Date.now();
    if (text === "pong") return;
    let msg: PrivateMsg;
    try {
      msg = JSON.parse(text) as PrivateMsg;
    } catch {
      return;
    }

    if (msg.event === "login") {
      if (msg.code === "0" || msg.code === undefined) {
        this.loggedIn = true;
        this.status.authenticated = true;
        this.h.onLog?.("private ws authenticated");
        this.subscribeAll();
      } else {
        this.status.lastError = `login failed: ${msg.code} ${msg.msg}`;
        this.h.onLog?.(`private ws login FAILED: ${msg.code} ${msg.msg}`);
        // A bad key will never fix itself; do not spin reconnect forever.
        this.h.onLog?.("private ws auth failed — check OKX_API_KEY/SECRET/PASSPHRASE and demo header");
      }
      this.h.onStatus?.(this.statusSnapshot());
      return;
    }
    if (msg.event === "error") {
      this.status.lastError = `${msg.code}: ${msg.msg}`;
      this.h.onLog?.(`private ws error frame: ${msg.code} ${msg.msg}`);
      this.h.onStatus?.(this.statusSnapshot());
      return;
    }
    if (!this.loggedIn) return;

    const arg = msg.arg;
    if (!arg) return;
    const instId = arg.instId ?? "";

    switch (arg.channel) {
      case "orders":
        for (const d of (msg.data ?? []) as OrderEvent[]) {
          if (d.instId) this.h.onOrderUpdate?.(d.instId, d);
        }
        break;
      case "fills":
        for (const d of (msg.data ?? []) as FillEvent[]) {
          if (d.instId) this.h.onFill?.(d);
        }
        break;
      case "positions":
        for (const d of (msg.data ?? []) as PositionEvent[]) {
          if (d.instId) this.h.onPosition?.(d.instId, d);
        }
        break;
      case "account":
        this.h.onAccount?.(msg.data as AccountEvent);
        break;
      default:
        break;
    }
  }

  close(): void {
    this.closed = true;
    this.stopPing();
    this.ws?.close();
  }
}

interface PrivateMsg {
  event?: string;
  code?: string;
  msg?: string;
  arg?: { channel: string; instId?: string; instType?: string };
  data?: unknown;
}

/** Convert a raw position frame into the engine's shape (flat = zeros). */
export function toSleevePosition(instId: string, p: PositionEvent): SleevePosition {
  const pos = Number(p.pos ?? "0");
  const flat = !Number.isFinite(pos) || pos === 0;
  return {
    instId,
    side: flat ? "flat" : pos > 0 ? "long" : "short",
    szContracts: flat ? 0 : Math.abs(pos),
    entryPx: Number(p.avgPx ?? "0") || 0,
    markPx: Number(p.markPx ?? "0") || 0,
    notionalUsd: Number(p.notionalUsd ?? "0") || 0,
    unrealizedPnlUsd: Number(p.upl ?? "0") || 0,
    openedAt: null,
    leverage: Number(p.lever ?? "1") || 1,
    liqPx: p.liqPx ? Number(p.liqPx) : null,
  };
}

export type { FillRecord };
