/**
 * Public market-data WebSocket (v5).
 *
 * Two things bite here and both are handled explicitly:
 *
 *  1. `books5` / `bbo-tbt` are SNAPSHOT-then-INCREMENT. The first frame per
 *     instrument carries a full book with `action:"snapshot"`; later frames are
 *     deltas with `action:"update"`. Applying a delta without a prior snapshot
 *     yields a book that looks plausible and is wrong. The book here maintains
 *     real depth, because features like depth-weighted imbalance need more than
 *     top-of-book and because a stale top-5 is a stale signal.
 *
 *  2. `candle1m` arrays are NOT in chronological order — the confirm field is
 *     index 8 and the newest candle is FIRST. Sorting by `ts` (index 0) is the
 *     only safe way to consume them.
 *
 * Frames carry `arg.channel` and, for books, `arg.instId`. We re-key on
 * instrument because one socket serves all sleeves.
 */
import { WebSocket } from "ws";
import type { Config } from "../config.ts";
import type { BookLevel, BookState, TradeTick } from "../store/types.ts";

export interface WsStatus {
  connected: boolean;
  lastMessageAt: number | null;
  lastError: string | null;
  reconnects: number;
  subscribed: string[];
}

type Handler = {
  onBook?: (instId: string, book: BookState) => void;
  onTrade?: (instId: string, t: TradeTick) => void;
  onCandle?: (instId: string, bar: string, c: Candle) => void;
  onStatus?: (s: WsStatus) => void;
  onLog?: (msg: string) => void;
};

export interface Candle {
  ts: number;
  o: number;
  h: number;
  l: number;
  c: number;
  vol: number;
  confirm: boolean;
}

/** Internal candle shape stored per sleeve: `v` not `vol`, no OHLC-less rows. */
export interface SleeveCandle {
  ts: number;
  o: number;
  h: number;
  l: number;
  c: number;
  v: number;
}

const PING_MS = 20_000;
const PONG_GRACE_MS = 10_000;

export class OkxPublicWs {
  private ws: WebSocket | null = null;
  private timer: NodeJS.Timeout | null = null;
  private watchdog: NodeJS.Timeout | null = null;
  private closed = false;
  private lastPong = Date.now();
  private books = new Map<string, BookState>();
  private readonly status: WsStatus = {
    connected: false,
    lastMessageAt: null,
    lastError: null,
    reconnects: 0,
    subscribed: [],
  };

  private readonly cfg: Config;
  private readonly h: Handler;
  private readonly fetchImpl: typeof fetch;

  constructor(cfg: Config, h: Handler, fetchImpl: typeof fetch = fetch) {
    this.cfg = cfg;
    this.h = h;
    this.fetchImpl = fetchImpl;
  }

  statusSnapshot(): WsStatus {
    return { ...this.status, subscribed: [...this.status.subscribed] };
  }

  /** Instrument -> local book, for the feature store. */
  book(instId: string): BookState | undefined {
    return this.books.get(instId);
  }

  connect(): void {
    this.closed = false;
    this.open();
  }

  private open(): void {
    const url = this.cfg.okx.wsPublic;
    this.h.onLog?.(`public ws connecting ${url}`);
    const ws = new WebSocket(url, { handshakeTimeout: 10_000 });
    this.ws = ws;

    ws.on("open", () => {
      this.status.connected = true;
      this.status.lastError = null;
      this.lastPong = Date.now();
      this.h.onLog?.(`public ws open (${url})`);
      this.subscribeAll();
      this.startPing();
      this.h.onStatus?.(this.statusSnapshot());
    });

    ws.on("message", (raw: Buffer) => this.onMessage(raw.toString()));

    ws.on("error", (err: Error) => {
      this.status.lastError = err.message;
      this.h.onLog?.(`public ws error: ${err.message}`);
      this.h.onStatus?.(this.statusSnapshot());
    });

    ws.on("close", () => {
      this.stopPing();
      this.status.connected = false;
      this.h.onStatus?.(this.statusSnapshot());
      if (this.closed) return;
      // Books are snapshot-based; after a reconnect every book is stale until
      // its snapshot arrives, so drop them rather than serve a half-old book.
      this.books.clear();
      this.status.reconnects += 1;
      const delay = Math.min(30_000, 1000 * 2 ** Math.min(5, this.status.reconnects));
      this.h.onLog?.(`public ws closed; reconnecting in ${delay}ms`);
      setTimeout(() => this.open(), delay);
    });
  }

  private subscribeAll(): void {
    const args: unknown[] = [];
    for (const instId of this.cfg.okx.instIds) {
      args.push({ channel: "bbo-tbt", instId });
      args.push({ channel: "books5", instId });
      args.push({ channel: "trades", instId });
      // NOTE: candle1m/candle5m are deliberately NOT here. They live on the
      // business WS; the public endpoint rejects them with error 60018
      // (verified live 2026-09-26).
    }
    this.send({ op: "subscribe", args });
    this.status.subscribed = this.cfg.okx.instIds.map((i) => `bbo-tbt,books5,trades:${i}`);
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
    this.timer = setInterval(() => {
      this.send("ping");
      this.lastPong = Date.now();
      // If the exchange stops answering pings, the socket is a zombie: a stale
      // book feeding features is worse than a reconnect.
      if (Date.now() - this.lastPong > PING_MS + PONG_GRACE_MS) {
        this.h.onLog?.("public ws pong timeout; forcing reconnect");
        this.ws?.terminate();
      }
    }, PING_MS);
    this.watchdog = setInterval(() => this.checkPong(), 5_000);
  }

  private checkPong(): void {
    // OKX answers "ping" with literal "pong".
    if (Date.now() - this.lastPong > PING_MS + PONG_GRACE_MS) {
      this.h.onLog?.("public ws pong timeout; forcing reconnect");
      this.ws?.terminate();
    }
  }

  private stopPing(): void {
    if (this.timer) clearInterval(this.timer);
    if (this.watchdog) clearInterval(this.watchdog);
    this.timer = null;
    this.watchdog = null;
  }

  private onMessage(text: string): void {
    this.status.lastMessageAt = Date.now();
    this.lastPong = Date.now();
    if (text === "pong") return;
    let msg: WsMsg;
    try {
      msg = JSON.parse(text) as WsMsg;
    } catch {
      return;
    }
    if (msg.event === "error") {
      this.status.lastError = `${msg.code}: ${msg.msg}`;
      this.h.onLog?.(`public ws error frame: ${msg.code} ${msg.msg}`);
      return;
    }
    if (!msg.arg || !msg.data) return;
    const { channel, instId } = msg.arg;
    if (!instId) return;

    switch (channel) {
      case "books5":
      case "books-l2-tbt":
      case "bbo-tbt":
        this.applyBook(instId, msg.data as BookFrame[], channel);
        break;
      case "trades":
        for (const t of msg.data as TradeFrame[]) {
          this.h.onTrade?.(instId, {
            instId,
            tradeId: t.tradeId,
            px: Number(t.px),
            sz: Number(t.sz),
            side: t.side,
            ts: Number(t.ts),
          });
        }
        break;
      case "candle1m":
      case "candle5m": {
        const bar = channel === "candle1m" ? "1m" : "5m";
        for (const c of msg.data as string[][]) this.h.onCandle?.(instId, bar, parseCandle(c));
        break;
      }
      default:
        break;
    }
  }

  private applyBook(instId: string, frames: BookFrame[], channel: string): void {
    let book = this.books.get(instId);
    for (const f of frames) {
      const action = f.action ?? "snapshot";
      if (action === "snapshot" || !book) {
        book = {
          instId,
          bids: (f.bids ?? []).map(toLevel),
          asks: (f.asks ?? []).map(toLevel),
          ts: Number(f.ts ?? Date.now()),
          synced: true,
        };
        this.books.set(instId, book);
      } else {
        // Incremental update: replace by price, drop exhausted levels, keep depth.
        book.bids = mergeLevels(book.bids, (f.bids ?? []).map(toLevel), "desc");
        book.asks = mergeLevels(book.asks, (f.asks ?? []).map(toLevel), "asc");
        book.ts = Number(f.ts ?? book.ts);
      }
    }
    if (book && channel === "bbo-tbt" && this.status.lastMessageAt) {
      // bbo-tbt updates the same book; the deep book still governs.
      this.h.onBook?.(instId, book);
    } else if (book) {
      this.h.onBook?.(instId, book);
    }
  }

  close(): void {
    this.closed = true;
    this.stopPing();
    this.ws?.close();
  }
}

interface WsMsg {
  event?: string;
  code?: string;
  msg?: string;
  arg?: { channel: string; instId: string };
  data?: unknown;
}

interface BookFrame {
  action?: "snapshot" | "update";
  asks?: string[][];
  bids?: string[][];
  ts?: string;
  checksum?: number;
}

interface TradeFrame {
  tradeId: string;
  px: string;
  sz: string;
  side: "buy" | "sell";
  ts: string;
}

function toLevel(row: string[]): BookLevel {
  return { px: Number(row[0]), sz: Number(row[1]) };
}

function mergeLevels(existing: BookLevel[], incoming: BookLevel[], side: "asc" | "desc"): BookLevel[] {
  const byPx = new Map<number, number>();
  for (const l of existing) if (l.sz > 0) byPx.set(l.px, l.sz);
  for (const l of incoming) {
    if (l.sz <= 0) byPx.delete(l.px);
    else byPx.set(l.px, l.sz);
  }
  const out = [...byPx.entries()].map(([px, sz]) => ({ px, sz }));
  out.sort((a, b) => (side === "asc" ? a.px - b.px : b.px - a.px));
  return side === "asc" ? out.slice(0, 20) : out.slice(0, 20);
}

/**
 * OKX candle array order (documented, do not reorder):
 * [ts, o, h, l, c, vol, volCcy, volCcyQuote, confirm]
 */
export function parseCandle(row: string[]): Candle {
  return {
    ts: Number(row[0]),
    o: Number(row[1]),
    h: Number(row[2]),
    l: Number(row[3]),
    c: Number(row[4]),
    vol: Number(row[5]),
    confirm: row[8] === "1",
  };
}


/**
 * Business WS: candles only.
 *
 * Split from OkxPublicWs because candles are a different endpoint (verified
 * 2026-09-26: the public socket returns 60018 for candle1m/candle5m). Same
 * reconnect/ping discipline, one job.
 */
export class OkxBusinessWs {
  private ws: WebSocket | null = null;
  private timer: NodeJS.Timeout | null = null;
  private closed = false;
  private lastMsg = Date.now();

  private readonly cfg: Config;
  private readonly onCandle: (instId: string, bar: string, c: Candle) => void;
  private readonly onLog: (m: string) => void;

  constructor(cfg: Config, onCandle: (instId: string, bar: string, c: Candle) => void, onLog: (m: string) => void) {
    this.cfg = cfg;
    this.onCandle = onCandle;
    this.onLog = onLog;
  }

  connect(): void {
    this.closed = false;
    this.open();
  }

  private open(): void {
    const url = this.cfg.okx.wsBusiness;
    this.onLog(`business ws connecting ${url}`);
    const ws = new WebSocket(url, { handshakeTimeout: 10_000 });
    this.ws = ws;
    ws.on("open", () => {
      this.onLog("business ws open");
      this.lastMsg = Date.now();
      const args: unknown[] = [];
      for (const instId of this.cfg.okx.instIds) {
        args.push({ channel: "candle1m", instId });
        args.push({ channel: "candle5m", instId });
      }
      this.send({ op: "subscribe", args });
      this.startPing();
    });
    ws.on("message", (raw: Buffer) => this.onMsg(raw.toString()));
    ws.on("error", (e: Error) => this.onLog(`business ws error: ${e.message}`));
    ws.on("close", () => {
      this.stopPing();
      if (this.closed) return;
      this.onLog("business ws closed; reconnecting");
      setTimeout(() => this.open(), 3000);
    });
  }

  private send(o: unknown): void {
    if (this.ws?.readyState !== WebSocket.OPEN) return;
    // Same rule as the public socket: "ping" is a bare text frame. This class
    // was split out for candles and missed that fix, so every heartbeat got
    // 60012 "Illegal request" and no pong ever reset the idle watchdog.
    this.ws.send(typeof o === "string" ? o : JSON.stringify(o));
  }

  private onMsg(text: string): void {
    this.lastMsg = Date.now();
    if (text === "pong") return;
    let msg: WsMsg;
    try {
      msg = JSON.parse(text) as WsMsg;
    } catch {
      return;
    }
    if (msg.event === "error") {
      this.onLog(`business ws error frame: ${msg.code} ${msg.msg}`);
      return;
    }
    const ch = msg.arg?.channel;
    const instId = msg.arg?.instId;
    if (!ch || !instId || !msg.data) return;
    if (ch !== "candle1m" && ch !== "candle5m") return;
    const bar = ch === "candle1m" ? "1m" : "5m";
    for (const row of msg.data as string[][]) this.onCandle(instId, bar, parseCandle(row));
  }

  private startPing(): void {
    this.stopPing();
    this.timer = setInterval(() => {
      this.send("ping");
      if (Date.now() - this.lastMsg > 40_000) {
        this.onLog("business ws stale; reconnect");
        this.ws?.terminate();
      }
    }, 20_000);
  }

  private stopPing(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  close(): void {
    this.closed = true;
    this.stopPing();
    this.ws?.close();
  }
}
