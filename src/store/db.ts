/**
 * SQLite persistence.
 *
 * node:sqlite is built into Node 22 (experimental), so there is no native
 * dependency to compile. The schema keeps the audit trail complete: every tick
 * records the features, the answers, the intent and the gate notes, which is
 * what makes a post-hoc "why did it not trade" answerable.
 *
 * Secrets are NEVER written here — no API keys, no signatures.
 */
import { DatabaseSync } from "node:sqlite";
import { mkdirSync, existsSync } from "node:fs";
import { dirname } from "node:path";
import type { FillRecord, TickRecord } from "./types.ts";

/**
 * Read-only handle for offline tooling (bucket occupancy, the measure harness).
 * Deliberately separate from Store: these tools must never run a migration or
 * write a row into the ledger they are analysing.
 */
export function openReadOnly(path: string): DatabaseSync {
  if (!existsSync(path)) {
    // The normal state on a fresh clone: no engine has run yet. Callers are
    // offline tools, so this is "nothing to analyse", not a crash.
    throw new MissingLedgerError(path);
  }
  return new DatabaseSync(path, { readOnly: true });
}

/** Thrown when there is no ledger yet. Offline tools catch this and say so. */
export class MissingLedgerError extends Error {
  readonly path: string;
  constructor(path: string) {
    super(`no ledger at ${path}`);
    this.name = "MissingLedgerError";
    this.path = path;
  }
}

export class Store {
  private readonly db: DatabaseSync;

  constructor(path: string) {
    mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db.exec("PRAGMA journal_mode = WAL");
    this.db.exec("PRAGMA busy_timeout = 5000");
    this.migrate();
  }

  /**
   * Card 1. Add the identity columns to `ticks`.
   *
   * ALTER TABLE ADD COLUMN has no IF NOT EXISTS in SQLite, and this table is
   * append-only, so re-running migrate() on an existing ledger must not fail
   * and must not touch the rows already there. Probing the column list first
   * makes the migration idempotent without a version table.
   *
   * Existing rows are left NULL on purpose. Backfilling would assert an era for
   * data collected under a configuration nobody can now reconstruct, and a
   * wrong era is worse than an absent one: absent rows simply do not count
   * toward the frozen bar, which is the honest outcome.
   */
  private migrateIdentityColumns(): void {
    const cols = new Set(
      (this.db.prepare("PRAGMA table_info(ticks)").all() as { name: string }[]).map((c) => c.name),
    );
    if (!cols.has("session")) {
      this.db.exec("ALTER TABLE ticks ADD COLUMN session TEXT");
    }
    if (!cols.has("era")) {
      this.db.exec("ALTER TABLE ticks ADD COLUMN era TEXT");
    }
    if (!cols.has("era_missing")) {
      this.db.exec("ALTER TABLE ticks ADD COLUMN era_missing TEXT");
    }
    // The frozen bar groups by era and session, so this index is on the hot
    // path of every proof run once the ledger grows.
    this.db.exec("CREATE INDEX IF NOT EXISTS idx_ticks_era_session ON ticks(era, session, ts)");
  }

  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS ticks (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        ts INTEGER NOT NULL,
        sleeve_id TEXT NOT NULL,
        inst_id TEXT NOT NULL,
        mid REAL, bid REAL, ask REAL, spread_bps REAL,
        jev_json TEXT,
        intent_json TEXT,
        gates_json TEXT,
        executed INTEGER NOT NULL DEFAULT 0,
        exec_note TEXT,
        position_side TEXT,
        position_notional_usd REAL
      );
      CREATE INDEX IF NOT EXISTS idx_ticks_ts ON ticks(ts DESC);
      CREATE INDEX IF NOT EXISTS idx_ticks_sleeve ON ticks(sleeve_id, ts DESC);

      -- Full feature snapshot per tick: the shadow ledger. Signals are measured
      -- from this table later; it is deliberately raw so the measurement can
      -- change without re-collecting.
      CREATE TABLE IF NOT EXISTS features (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        ts INTEGER NOT NULL,
        sleeve_id TEXT NOT NULL,
        inst_id TEXT NOT NULL,
        json TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_features_sleeve_ts ON features(sleeve_id, ts DESC);

      CREATE TABLE IF NOT EXISTS calls (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        ts INTEGER NOT NULL,
        sleeve_id TEXT NOT NULL,
        provider TEXT,
        model TEXT,
        latency_ms INTEGER,
        input_tokens INTEGER,
        output_tokens INTEGER,
        error TEXT,
        answers_json TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_calls_ts ON calls(ts DESC);

      CREATE TABLE IF NOT EXISTS orders (
        cl_ord_id TEXT PRIMARY KEY,
        ord_id TEXT,
        ts INTEGER NOT NULL,
        sleeve_id TEXT NOT NULL,
        inst_id TEXT NOT NULL,
        side TEXT NOT NULL,
        ord_type TEXT NOT NULL,
        px REAL, sz REAL,
        reduce_only INTEGER NOT NULL DEFAULT 0,
        state TEXT,
        s_code TEXT
      );

      -- trade_id is the exchange's own id: the idempotency key. A PK here is
      -- what makes WS reconnects and REST/WS overlap safe.
      CREATE TABLE IF NOT EXISTS fills (
        trade_id TEXT PRIMARY KEY,
        ts INTEGER NOT NULL,
        ord_id TEXT,
        cl_ord_id TEXT,
        sleeve_id TEXT,
        inst_id TEXT NOT NULL,
        side TEXT NOT NULL,
        px REAL NOT NULL,
        sz REAL NOT NULL,
        fee REAL DEFAULT 0,
        realized_pnl REAL DEFAULT 0
      );
      CREATE INDEX IF NOT EXISTS idx_fills_ts ON fills(ts DESC);

      CREATE TABLE IF NOT EXISTS pnl_daily (
        day TEXT PRIMARY KEY,
        realized_usd REAL NOT NULL DEFAULT 0,
        fees_usd REAL NOT NULL DEFAULT 0,
        trades INTEGER NOT NULL DEFAULT 0,
        updated INTEGER NOT NULL
      );
    `);

    // Last, not first: ALTER TABLE ADD COLUMN requires `ticks` to exist, and
    // on a fresh clone it does not until the CREATE above has run.
    this.migrateIdentityColumns();
  }

  /**
   * Run `fn` inside a single transaction.
   *
   * For bulk writes only - fixture builders, backfills. The tick loop must NOT
   * use this: it would hold a write lock across a network call, and a long-held
   * SQLite lock is exactly how a ledger stops being append-only in practice.
   */
  transaction<T>(fn: () => T): T {
    this.db.exec("BEGIN");
    try {
      const out = fn();
      this.db.exec("COMMIT");
      return out;
    } catch (e) {
      this.db.exec("ROLLBACK");
      throw e;
    }
  }

  /** Test/backfill only: trade durability for write speed. */
  fastWrites(): void {
    this.db.exec("PRAGMA synchronous = OFF");
  }

  recordTick(t: TickRecord): void {
    this.db
      .prepare(
        `INSERT INTO ticks (ts,sleeve_id,inst_id,mid,bid,ask,spread_bps,
           jev_json,intent_json,gates_json,executed,exec_note,position_side,position_notional_usd,
           session,era,era_missing)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      )
      .run(
        t.ts,
        t.sleeveId,
        t.instId,
        t.mid,
        t.bid,
        t.ask,
        t.spreadBps,
        t.jev ? JSON.stringify(t.jev) : null,
        t.intent ? JSON.stringify(t.intent) : null,
        JSON.stringify(t.gates),
        t.executed ? 1 : 0,
        t.execNote,
        t.positionSide,
        t.positionNotionalUsd,
        t.session ?? null,
        t.era ?? null,
        t.eraMissing ?? null,
      );
  }

  recordFeatures(sleeveId: string, instId: string, ts: number, json: string): void {
    this.db
      .prepare("INSERT INTO features (ts,sleeve_id,inst_id,json) VALUES (?,?,?,?)")
      .run(ts, sleeveId, instId, json);
  }

  recordCall(
    sleeveId: string,
    provider: string,
    model: string,
    latencyMs: number,
    inputTokens: number,
    outputTokens: number,
    error: string | null,
    answers: unknown,
  ): void {
    this.db
      .prepare(
        `INSERT INTO calls (ts,sleeve_id,provider,model,latency_ms,input_tokens,output_tokens,error,answers_json)
         VALUES (?,?,?,?,?,?,?,?,?)`,
      )
      .run(
        Date.now(),
        sleeveId,
        provider,
        model,
        latencyMs,
        inputTokens,
        outputTokens,
        error,
        JSON.stringify(answers),
      );
  }

  upsertOrder(o: {
    clOrdId: string;
    ordId: string | null;
    ts: number;
    sleeveId: string;
    instId: string;
    side: string;
    ordType: string;
    px: number | null;
    sz: number | null;
    reduceOnly: boolean;
    state: string;
    sCode: string | null;
  }): void {
    this.db
      .prepare(
        `INSERT INTO orders (cl_ord_id,ord_id,ts,sleeve_id,inst_id,side,ord_type,px,sz,reduce_only,state,s_code)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?)
         ON CONFLICT(cl_ord_id) DO UPDATE SET ord_id=excluded.ord_id, state=excluded.state, s_code=excluded.s_code`,
      )
      .run(
        o.clOrdId,
        o.ordId,
        o.ts,
        o.sleeveId,
        o.instId,
        o.side,
        o.ordType,
        o.px,
        o.sz,
        o.reduceOnly ? 1 : 0,
        o.state,
        o.sCode,
      );
  }

  /**
   * Insert a fill, ignoring duplicates on trade_id. Returns true if this was a
   * NEW fill. This single method is what makes "WS reconnect does not
   * double-count fills" true rather than aspirational.
   */
  recordFill(f: FillRecord, sleeveId: string | null): boolean {
    try {
      this.db
        .prepare(
          `INSERT INTO fills (trade_id,ts,ord_id,cl_ord_id,sleeve_id,inst_id,side,px,sz,fee,realized_pnl)
           VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
        )
        .run(
          f.tradeId,
          f.ts,
          f.ordId,
          f.clOrdId,
          sleeveId,
          f.instId,
          f.side,
          f.px,
          f.sz,
          f.fee,
          f.realizedPnl,
        );
    } catch (e) {
      // UNIQUE violation = duplicate. Not an error.
      if (e instanceof Error && e.message.includes("UNIQUE")) return false;
      throw e;
    }
    this.applyPnl(f);
    return true;
  }

  private applyPnl(f: FillRecord): void {
    const day = new Date(f.ts).toISOString().slice(0, 10);
    this.db
      .prepare(
        `INSERT INTO pnl_daily (day,realized_usd,fees_usd,trades,updated)
         VALUES (?,?,?,1,?)
         ON CONFLICT(day) DO UPDATE SET
           realized_usd = realized_usd + excluded.realized_usd,
           fees_usd = fees_usd + excluded.fees_usd,
           trades = trades + 1,
           updated = excluded.updated`,
      )
      .run(day, f.realizedPnl, f.fee, Date.now());
  }

  pnlForDay(day = new Date().toISOString().slice(0, 10)): { realizedUsd: number; feesUsd: number; trades: number } {
    const r = this.db
      .prepare("SELECT realized_usd, fees_usd, trades FROM pnl_daily WHERE day=?")
      .get(day) as { realized_usd: number; fees_usd: number; trades: number } | undefined;
    return {
      realizedUsd: Number(r?.realized_usd ?? 0),
      feesUsd: Number(r?.fees_usd ?? 0),
      trades: Number(r?.trades ?? 0),
    };
  }

  /** Realized PnL for a UTC day from the fills table (source of truth). */
  realizedSince(sinceMs: number): number {
    const r = this.db
      .prepare("SELECT COALESCE(SUM(realized_pnl),0) AS p FROM fills WHERE ts >= ?")
      .get(sinceMs) as { p: number };
    return Number(r.p ?? 0);
  }

  history(instId: string | undefined, n: number): TickRecord[] {
    const rows = instId
      ? (this.db
          .prepare("SELECT * FROM ticks WHERE inst_id=? ORDER BY ts DESC LIMIT ?")
          .all(instId, n) as Record<string, unknown>[])
      : (this.db.prepare("SELECT * FROM ticks ORDER BY ts DESC LIMIT ?").all(n) as Record<string, unknown>[]);
    return rows.map(rowToTick);
  }

  midSeries(instId: string, n = 300): { ts: number; mid: number[]; fills: { ts: number; px: number; side: string }[] } {
    const mids = this.db
      .prepare("SELECT ts, mid FROM ticks WHERE inst_id=? ORDER BY ts DESC LIMIT ?")
      .all(instId, n) as { ts: number; mid: number }[];
    const fills = this.db
      .prepare("SELECT ts, px, side FROM fills WHERE inst_id=? ORDER BY ts DESC LIMIT ?")
      .all(instId, n) as { ts: number; px: number; side: string }[];
    return {
      ts: Date.now(),
      mid: mids.reverse().map((m) => m.mid),
      fills: fills.reverse(),
    };
  }

  recentFills(n = 100): FillRecord[] {
    const rows = this.db
      .prepare("SELECT * FROM fills ORDER BY ts DESC LIMIT ?")
      .all(n) as Record<string, unknown>[];
    return rows.map((r) => ({
      ts: Number(r.ts),
      sleeveId: String(r.sleeve_id ?? ""),
      instId: String(r.inst_id),
      ordId: String(r.ord_id ?? ""),
      clOrdId: String(r.cl_ord_id ?? ""),
      side: r.side as "buy" | "sell",
      px: Number(r.px),
      sz: Number(r.sz),
      fee: Number(r.fee ?? 0),
      realizedPnl: Number(r.realized_pnl ?? 0),
      tradeId: String(r.trade_id),
    }));
  }

  close(): void {
    this.db.close();
  }
}

function rowToTick(r: Record<string, unknown>): TickRecord {
  const safe = (v: unknown) => (v ? (JSON.parse(String(v)) as unknown) : null);
  return {
    ts: Number(r.ts),
    sleeveId: String(r.sleeve_id),
    instId: String(r.inst_id),
    mid: Number(r.mid ?? 0),
    bid: Number(r.bid ?? 0),
    ask: Number(r.ask ?? 0),
    spreadBps: Number(r.spread_bps ?? 0),
    jev: safe(r.jev_json) as TickRecord["jev"],
    intent: safe(r.intent_json) as TickRecord["intent"],
    gates: r.gates_json ? (JSON.parse(String(r.gates_json)) as string[]) : [],
    executed: Number(r.executed ?? 0) === 1,
    execNote: String(r.exec_note ?? ""),
    positionSide: (r.position_side as TickRecord["positionSide"]) ?? "flat",
    positionNotionalUsd: Number(r.position_notional_usd ?? 0),
  };
}
