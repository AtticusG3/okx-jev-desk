/**
 * Engine wiring: venues in, sleeves out, one shared desk-level risk book.
 */
import type { Config, Mode } from "./config.ts";
import { loadInstruments, type Instrument } from "./okx/instruments.ts";
import { OkxRest } from "./okx/rest.ts";
import { OkxBusinessWs, OkxPublicWs, parseCandle } from "./okx/wsPublic.ts";
import { OkxPrivateWs, toSleevePosition } from "./okx/wsPrivate.ts";
import { makeBrain } from "./jev/client.ts";
import { EventBus } from "./store/events.ts";
import { Store } from "./store/db.ts";
import { makeSleeve, SleeveRunner } from "./loop/tick.ts";
import type { PnlSnapshot, Sleeve } from "./store/types.ts";
import { computeEra, eraHash, sizingFingerprint, type EraDescriptor } from "./measure/era.ts";
import { runProof, type ProofStatus } from "./measure/proof.ts";
import { loadProofRule } from "./measure/proof_rule.ts";
import { Worker } from "node:worker_threads";
import type { ProofResponse } from "./measure/proof_worker.ts";

export interface EngineApi {
  mode: Mode;
  model: string;
  sleeves(): Sleeve[];
  snapshot(): unknown;
  kill(): Promise<void>;
  unkill(): Promise<void>;
  setMode(m: string): Promise<{ ok: boolean; error?: string }>;
  pnl(): PnlSnapshot;
  start(): Promise<void>;
  stop(): void;
}

export interface EngineOpts {
  dbPath: string;
  /** Overrides for tests; production leaves these alone. */
  now?: () => number;
}

export class Engine implements EngineApi {
  mode: Mode;
  private readonly dbPath: string;
  readonly model: string;
  private readonly cfg: Config;
  private readonly bus = new EventBus();
  private readonly store: Store;
  private readonly rest: OkxRest;
  private readonly instruments = new Map<string, Instrument>();
  private readonly funding = new Map<string, { rate: number; nextHours: number }>();
  /**
   * 1h open-interest change, percent, per instrument. Rubik's
   * open-interest-volume series is currency-level (all SWAPs for that coin) and
   * carries ~2 days of 5m history, so unlike /public/open-interest it lets us
   * compute a 1h change from the first tick after a restart instead of waiting
   * an hour. Re-fetched whole each cycle: no local ring to get out of sync.
   */
  private readonly oiChange1hPct = new Map<string, number | null>();
  private readonly runners = new Map<string, SleeveRunner>();
  private readonly sleevesByInst = new Map<string, SleeveRunner>();
  /** Every runner, including the 2nd..Nth bot on the same instrument. */
  private readonly sleevesByInstMulti: SleeveRunner[] = [];
  /** Shared mutable desk-level state read by every sleeve on every tick. */
  private readonly runtime = { simulateFills: true, killSwitched: false, dailyLossTripped: false };
  private publicWs!: OkxPublicWs;
  private businessWs: OkxBusinessWs | null = null;
  private privateWs: OkxPrivateWs | null = null;
  private timer: NodeJS.Timeout | null = null;
  private killSwitched = false;
  private dailyLossTripped = false;
  private inFlight = 0;
  private stopped = false;
  /**
   * Era identity, computed ONCE at construction.
   *
   * Recomputing per tick would mean a file edited mid-run produces two eras in
   * one ledger, which is technically honest and practically useless: the desk
   * would show a moving target. One hash per process, stable for the life of
   * the boot, and a restart after an edit starts a new era cleanly.
   */
  /**
   * Last proof result, and when it was computed.
   *
   * `null` until the first self-check completes. The distinction matters: a
   * null status means "not yet run", and the desk must show that rather than a
   * status that looks like a verdict nobody has reached.
   */
  private proof: {
    status: ProofStatus;
    reason: string;
    era: string;
    days: number;
    weeks: number;
    sessionsMissing: string[];
    at: number;
    /** Set when the last attempt threw. The previous status is kept. */
    error: string | null;
    consecutiveFailures: number;
    /** Wall time of the last successful check. */
    ms: number;
  } | null = null;
  private proofTimer: NodeJS.Timeout | null = null;
  private readonly eraDesc: EraDescriptor;
  private readonly era: string;
  private readonly eraMissing: string;

  constructor(cfg: Config, opts: EngineOpts) {
    this.cfg = cfg;
    this.mode = cfg.mode;
    this.model = cfg.model === "jev" ? `jev(${cfg.jev.modelId})` : "mock";
    this.dbPath = opts.dbPath;
    this.eraDesc = computeEra();
    this.era = eraHash(this.eraDesc, sizingFingerprint(cfg.risk));
    this.eraMissing = this.eraDesc.missing.join(",");
    this.store = new Store(opts.dbPath);
    this.rest = new OkxRest(cfg);
  }

  /** The era this process collects into. Exposed for the proof and the desk. */
  get eraId(): string {
    return this.era;
  }

  /** Era files that could not be hashed at boot. Non-empty weakens the bar. */
  get eraFilesMissing(): string[] {
    return [...this.eraDesc.missing];
  }

  get simulateFills(): boolean {
    return this.mode === "mock" || this.mode === "paper";
  }

  /** Keep the shared runtime flags in step with mode/kill/loss state. */
  private syncRuntime(): void {
    this.runtime.simulateFills = this.simulateFills;
    this.runtime.killSwitched = this.killSwitched;
    this.runtime.dailyLossTripped = this.dailyLossTripped;
  }

  get usesPrivateWs(): boolean {
    return this.mode === "demo" || this.mode === "live";
  }

  sleeves(): Sleeve[] {
    return [...this.runners.values()].map((r) => r.sleeve);
  }

  allRunners(): SleeveRunner[] {
    return [...this.runners.values()];
  }

  /** Exposed so the HTTP layer can serve SSE and history without duplicating state. */
  get eventBus(): EventBus {
    return this.bus;
  }

  get db(): Store {
    return this.store;
  }

  get restClient(): OkxRest {
    return this.rest;
  }

  private log = (m: string): void => {
    process.stdout.write(`${new Date().toISOString()} ${m}\n`);
  };

  async start(): Promise<void> {
    this.stopped = false;
    await this.loadInstruments();
    // The public WS object must exist before sleeves are built: each sleeve
    // holds a reference to it. Order matters -- this was a real boot bug.
    this.wirePublicWs();
    this.createSleeves();
    this.wirePrivateWs();
    await this.backfillCandles();
    this.loop();
    this.startProofLoop();
    this.log(
      `engine up: mode=${this.mode} model=${this.model} sleeves=${this.runners.size} ` +
        `tick=${this.cfg.tickMs}ms port=${this.cfg.enginePort} era=${this.era}` +
        (this.eraMissing ? ` (era files missing: ${this.eraMissing})` : ""),
    );
  }

  // ------------------------------------------------------------ self-check
  /**
   * Recompute the proof status on an interval and publish it on the snapshot.
   *
   * Autonomy here means exactly two things: the process stays up, and it
   * classifies its own ledger. It does NOT mean the engine may act on what it
   * finds. There is no code path from a proof result to a change in questions,
   * edges, sizing or intent - a bot that retunes itself from its own score is
   * no longer a measuring instrument.
   *
   * A failure keeps the LAST status and records the error alongside it. It
   * never propagates: the tick loop is the thing that must not stop, so this
   * whole method is defensive and returns void.
   */
  private startProofLoop(): void {
    const everyMs = this.cfg.proofIntervalMs;
    // Run once shortly after boot so the desk is not blank for a whole
    // interval, but not before the first ticks land.
    const first = setTimeout(() => this.runProofInBackground(), Math.min(15_000, everyMs));
    first.unref?.();
    this.proofTimer = setInterval(() => this.runProofInBackground(), everyMs);
    this.proofTimer.unref?.();
  }

  /**
   * Visible for tests: run one self-check now. Never throws.
   *
   * SYNCHRONOUS AND CPU-BOUND. This walks the whole ledger and runs thousands
   * of bootstrap resamples per feature, which on a multi-thousand-row ledger
   * is tens of seconds of solid CPU.
   *
   * That is a real hazard, and it was found by running the thing rather than
   * testing it: the first live boot pegged one core at 100%, the event loop
   * never yielded, and the engine stopped answering its own HTTP endpoint,
   * stopped processing WS frames, and stopped ticking - while still holding
   * both sockets open, so it looked alive from the outside.
   *
   * Two mitigations, both load-bearing:
   *   1. The default interval is 15 minutes, so the duty cycle is tiny.
   *   2. runProofInBackground() uses a worker thread, so even a slow check
   *      cannot starve the loop. This method is the synchronous core that the
   *      worker and the tests both call; anything on the hot path must use the
   *      background form.
   */
  private proofBusy = false;

  /**
   * Run the self-check off the main thread.
   *
   * Single-flight: if a check is already running, this returns. A check that
   * takes 30s against a shorter interval would otherwise queue work until the
   * process fell over.
   */
  private runProofInBackground(): void {
    if (this.proofBusy || this.stopped) return;
    let request;
    try {
      const rule = loadProofRule();
      request = {
        dbPath: this.dbPath,
        instruments: this.cfg.okx.instIds,
        rule,
        model: this.cfg.model === "jev" ? "jev" : "mock",
        modelId: this.cfg.model === "jev" ? this.cfg.jev.modelId : null,
        tickMs: this.cfg.tickMs,
        era: this.era,
        bootP: this.cfg.proofBootP,
        minSettled: this.cfg.proofMinSettled,
      };
    } catch (e) {
      this.recordProofFailure(e);
      return;
    }

    this.proofBusy = true;
    const w = new Worker(new URL("./measure/proof_worker.ts", import.meta.url), {
      workerData: request,
      // The worker must inherit the type-stripping flag or it cannot load the
      // .ts entry point at all.
      execArgv: process.execArgv.includes("--experimental-strip-types")
        ? process.execArgv
        : ["--experimental-strip-types", ...process.execArgv],
    });
    // Never let a worker failure take the process with it.
    w.on("error", (e) => { this.proofBusy = false; this.recordProofFailure(e); void w.terminate(); });
    w.on("exit", () => { this.proofBusy = false; });
    w.on("message", (msg: { ok: boolean; out?: ProofResponse; error?: string }) => {
      this.proofBusy = false;
      if (!msg.ok) { this.recordProofFailure(new Error(msg.error ?? "proof worker failed")); return; }
      const out = msg.out!;
      this.proof = {
        status: out.status,
        reason: out.reason,
        era: out.era,
        days: out.days,
        weeks: out.weeks,
        sessionsMissing: out.sessionsMissing,
        at: Date.now(),
        error: null,
        consecutiveFailures: 0,
        ms: out.ms,
      };
      this.bus.emit("proof", this.proof);
    });
  }

  /** Record a failed check without losing the last good status. */
  private recordProofFailure(e: unknown): void {
    const msg = e instanceof Error ? e.message : String(e);
    const prev = this.proof;
    this.proof = {
      status: prev?.status ?? "COLLECTING",
      reason: prev?.reason ?? "self-check has not completed yet",
      era: this.era,
      days: prev?.days ?? 0,
      weeks: prev?.weeks ?? 0,
      sessionsMissing: prev?.sessionsMissing ?? [],
      at: prev?.at ?? 0,
      error: msg,
      consecutiveFailures: (prev?.consecutiveFailures ?? 0) + 1,
      ms: prev?.ms ?? 0,
    };
    // Log at most occasionally: a failing proof every interval would bury the
    // tick log, which is the thing that actually matters.
    if (this.proof.consecutiveFailures === 1 || this.proof.consecutiveFailures % 12 === 0) {
      this.log(`proof self-check failed (${this.proof.consecutiveFailures}x): ${msg}`);
    }
  }

  runProofOnce(): void {
    try {
      const rule = loadProofRule();
      const report = runProof({
        dbPath: this.dbPath,
        instruments: this.cfg.okx.instIds,
        rule,
        model: this.cfg.model === "jev" ? "jev" : "mock",
        modelId: this.cfg.model === "jev" ? this.cfg.jev.modelId : null,
        tickMs: this.cfg.tickMs,
        era: this.era,
        strictEra: true,
        bootP: this.cfg.proofBootP,
        minSettled: this.cfg.proofMinSettled,
      });
      this.proof = {
        status: report.status,
        reason: report.reason,
        era: report.era,
        days: report.calendarDays,
        weeks: report.weeks,
        sessionsMissing: report.sessionsMissing,
        at: Date.now(),
        error: null,
        consecutiveFailures: 0,
        ms: 0,
      };
      this.bus.emit("proof", this.proof);
    } catch (e) {
      this.recordProofFailure(e);
    }
  }

  /** Last proof result, or null if the self-check has never completed. */
  proofState(): Engine["proof"] {
    return this.proof;
  }

  private async loadInstruments(): Promise<void> {
    try {
      const list = await this.rest.instruments("SWAP");
      const m = loadInstruments(list, this.cfg.okx.instIds);
      this.instruments.clear();
      for (const [k, v] of m) this.instruments.set(k, v);
      const missing = this.cfg.okx.instIds.filter((i) => !m.has(i));
      if (missing.length) {
        this.log(`WARN instruments not found or not live: ${missing.join(", ")}`);
      }
      this.log(`instruments loaded: ${m.size}/${this.cfg.okx.instIds.length}`);
    } catch (e) {
      // Without tickSz/lotSz we cannot size anything, so a desk that silently
      // guessed would be worse than one that runs degraded and says so.
      this.log(`FATAL could not load instruments: ${e instanceof Error ? e.message : String(e)}`);
      throw e;
    }
  }

  private createSleeves(): void {
    // One sleeve per instrument by default. To run several bots on the same
    // account, add more entries here (or via BOTS env, see README): each gets a
    // distinct id, its own isolated position and its own working order.
    for (const instId of this.cfg.okx.instIds) {
      for (const bot of this.cfg.bots) {
        const suffix = this.cfg.bots.length > 1 ? String(bot) : "";
        const sleeve = makeSleeve(
          `${instId.split("-")[0]!.toLowerCase()}${suffix || "1"}`,
          instId,
          `bot${suffix || "1"}`,
        );
        const runner = new SleeveRunner(sleeve, {
          cfg: this.cfg,
          rest: this.rest,
          publicWs: this.publicWs,
          store: this.store,
          bus: this.bus,
          era: this.era,
          eraMissing: this.eraMissing,
          brain: makeBrain(this.cfg),
          instrument: this.instruments.get(instId) ?? null,
          funding: this.funding,
          oiChange1hPct: this.oiChange1hPct,
          log: this.log,
          runtime: this.runtime,
        });
        this.runners.set(sleeve.id, runner);
        if (!this.sleevesByInst.has(instId)) this.sleevesByInst.set(instId, runner);
        this.sleevesByInstMulti.push(runner);
      }
    }
  }

  private wirePublicWs(): void {
    this.publicWs = new OkxPublicWs(this.cfg, {
      onBook: (instId, book) => {
        const r = this.sleevesByInst.get(instId);
        if (!r) return;
        r.setBook(book);
        r.checkSimulatedFill(book);
      },
      onTrade: (instId, t) => {
        const r = this.sleevesByInst.get(instId);
        if (!r) return;
        r.ingestTrade(instId, t);
        r.markPrivateFresh();
      },
      onStatus: (s) => this.bus.emit("status", { which: "okx-public", ...s }),
      onLog: (m) => this.log(`[public] ${m}`),
    });
    this.publicWs.connect();

    // Candles: business endpoint, no auth.
    this.businessWs = new OkxBusinessWs(
      this.cfg,
      (instId, bar, c) => {
        const row = { ts: c.ts, o: c.o, h: c.h, l: c.l, c: c.c, v: c.vol };
        for (const r of this.sleevesByInstMulti) {
          if (r.sleeve.instId === instId) r.ingestCandle(instId, bar, row);
        }
      },
      (m) => this.log(`[business] ${m}`),
    );
    this.businessWs.connect();
    this.refreshFundingLoop();
    this.refreshOiLoop();
  }

  private wirePrivateWs(): void {
    if (!this.usesPrivateWs) {
      this.log("no private WS: fills are simulated, orders are not sent");
      return;
    }
    this.privateWs = new OkxPrivateWs(this.cfg, {
      onFill: (f) => {
        const instId = f.instId;
        const runners = this.sleevesByInstMulti.filter((r) => r.sleeve.instId === instId);
        const sleeve = runners[0]?.sleeve;
        const isNew = this.store.recordFill(
          {
            ts: Number(f.ts),
            sleeveId: sleeve?.id ?? "",
            instId,
            ordId: f.ordId,
            clOrdId: f.clOrdId,
            side: f.side,
            px: Number(f.px),
            sz: Number(f.sz),
            fee: Number(f.fee ?? 0),
            realizedPnl: Number(f.realizedPnl ?? 0),
            tradeId: f.tradeId,
          },
          sleeve?.id ?? null,
        );
        if (isNew) {
          // A fill belongs to ONE sleeve: the one whose clOrdId matches. With
          // several bots on one instrument, crediting all of them would
          // multiply the position by the bot count.
          const owner = runners.find((r) => r.sleeve.workingOrder?.clOrdId === f.clOrdId)
            ?? runners.find((r) => r.sleeve.workingOrder?.ordId === f.ordId)
            ?? runners[0];
          if (owner) {
            owner.sleeve.stats.fills += 1;
            owner.markPrivateFresh();
            this.bus.emit("fill", { ...f, sleeveId: owner.sleeve.id, duplicate: false });
          } else {
            this.bus.emit("fill", { ...f, sleeveId: null, duplicate: false });
          }
          this.log(`fill ${f.instId} ${f.side} ${f.sz}@${f.px} (${f.tradeId})`);
        } else {
          // Duplicate on reconnect: counted once, logged for audit.
          this.log(`fill duplicate ignored ${f.tradeId}`);
        }
        for (const r of runners) r.markPrivateFresh();
      },
      onOrderUpdate: (instId, o) => {
        for (const r of this.sleevesByInstMulti) {
          if (r.sleeve.instId !== instId) continue;
          r.onOrderTerminal(o.clOrdId, o.state);
          r.markPrivateFresh();
        }
        this.bus.emit("status", { which: "order", instId, clOrdId: o.clOrdId, state: o.state });
      },
      onPosition: (instId, p) => {
        const r = this.sleevesByInst.get(instId);
        if (!r) return;
        // NOTE: OKX reports ONE net position per instrument per account. With
        // several bots on the same instrument their sleeves are logical, not
        // exchange-separated, so the first sleeve mirrors reality and the others
        // are advisory. For true isolation run one instrument per account, or
        // one bot per instrument (the default).
        const next = toSleevePosition(instId, p);
        const prev = r.sleeve.position;
        r.sleeve.position = next;
        if (prev.side !== "flat" && next.side === "flat") r.sleeve.position.openedAt = null;
        else if (prev.side === "flat" && next.side !== "flat") r.sleeve.position.openedAt = Date.now();
        r.markPrivateFresh();
        this.bus.emit("status", { which: "position", instId, position: next });
      },
      onAccount: (a) => this.bus.emit("status", { which: "account", ...a }),
      onStatus: (s) => this.bus.emit("status", { which: "okx-private", ...s }),
      onLog: (m) => this.log(`[private] ${m}`),
    });
    this.privateWs.connect();
  }

  /**
   * One-shot candle backfill over REST. Without it the first 15 minutes of
   * features are computed from an empty series (no realised vol, no range
   * position) and the brain is being asked to judge a partial picture.
   */
  private async backfillCandles(): Promise<void> {
    for (const instId of this.cfg.okx.instIds) {
      for (const bar of ["1m", "5m"] as const) {
        try {
          const rows = await this.rest.candles(instId, bar, 100);
          // OKX returns NEWEST FIRST; reverse into chronological order.
          const parsed = rows
            .map((r) => parseCandle(r))
            .sort((a, b) => a.ts - b.ts);
          for (const r of this.sleevesByInstMulti) {
            if (r.sleeve.instId !== instId) continue;
            const arr = bar === "1m" ? r.sleeve.candles1m : r.sleeve.candles5m;
            arr.push(...parsed.map((c) => ({ ts: c.ts, o: c.o, h: c.h, l: c.l, c: c.c, v: c.vol })));
            arr.sort((a, b) => a.ts - b.ts);
            while (arr.length > 300) arr.shift();
          }
        } catch (e) {
          this.log(`candle backfill ${instId} ${bar} failed: ${e instanceof Error ? e.message : String(e)}`);
        }
      }
    }
    this.log("candle backfill done");
  }

  /**
   * Open-interest 1h change, from OKX rubik history. Rows are
   * [ts, oiUsd, oiCcy], newest first. We use oiUsd.
   *
   * If the series cannot be read, the value stays null and the field is OMITTED
   * from Jev's state - a null dressed up as "neutral" is a lie the model cannot
   * detect, so it is never sent.
   */
  private refreshOiLoop(): void {
    const once = async (): Promise<void> => {
      const now = Date.now();
      for (const instId of this.cfg.okx.instIds) {
        const ccy = instId.split("-")[0];
        if (!ccy) continue;
        try {
          const rows = await this.rest.openInterestHistory(ccy);
          const pts = rows
            .map((r) => ({ ts: Number(r[0]), oi: Number(r[1]) }))
            .filter((x) => Number.isFinite(x.ts) && Number.isFinite(x.oi) && x.oi > 0)
            .sort((a, b) => a.ts - b.ts);
          if (pts.length < 2) continue;
          const latest = pts[pts.length - 1]!;
          // Oldest sample that is at least an hour old.
          const target = now - 3_600_000;
          let base: { ts: number; oi: number } | null = null;
          for (const p of pts) {
            if (p.ts <= target) base = p;
            else break;
          }
          // Refuse to pretend: if the base is more than 3h stale the "1h change"
          // would be measuring something else.
          if (!base || latest.ts - base.ts > 4 * 3_600_000) continue;
          this.oiChange1hPct.set(instId, ((latest.oi - base.oi) / base.oi) * 100);
        } catch {
          /* OI is best-effort; features and state tolerate null by omitting it */
        }
      }
    };
    void once();
    const t = setInterval(() => void once(), 5 * 60_000);
    t.unref?.();
  }

  /** Funding rate is a code-side feature input; refresh it periodically. */
  private refreshFundingLoop(): void {
    const once = async (): Promise<void> => {
      for (const instId of this.cfg.okx.instIds) {
        try {
          const fr = await this.rest.fundingRate(instId);
          const f = fr[0];
          if (!f) continue;
          const nextMs = Number(f.nextFundingTime ?? 0);
          const nextHours = nextMs > 0 ? Math.max(0, (nextMs - Date.now()) / 3_600_000) : null;
          this.funding.set(instId, { rate: Number(f.fundingRate), nextHours: nextHours ?? 0 });
        } catch {
          /* funding is best-effort; features tolerate null */
        }
      }
    };
    void once();
    const t = setInterval(() => void once(), 5 * 60_000);
    t.unref?.();
  }

  pnl(): PnlSnapshot {
    const dayStart = Date.parse(new Date().toISOString().slice(0, 10) + "T00:00:00Z");
    const realized = this.store.realizedSince(dayStart);
    const unrealized = this.sleeves().reduce((s, sl) => s + sl.position.unrealizedPnlUsd, 0);
    const gross = this.sleeves().reduce((s, sl) => s + Math.abs(sl.position.notionalUsd), 0);
    const max = this.cfg.risk.maxDailyLossUsd;
    const used = max > 0 ? Math.max(0, -realized) / max : 0;
    if (used >= 1 && !this.dailyLossTripped) {
      this.dailyLossTripped = true;
      this.log(`DAILY LOSS TRIPPED: realized ${realized.toFixed(2)} <= -${max}`);
      this.bus.emit("error", { kind: "daily_loss", realizedUsd: realized, maxUsd: max });
      void this.flattenAll("daily loss limit");
    }
    return {
      realizedUsd: realized,
      unrealizedUsd: unrealized,
      dailyPnlUsd: realized + unrealized,
      dailyLossUsedFrac: used,
      grossUsd: gross,
    };
  }

  private loop(): void {
    const tickAll = async (): Promise<void> => {
      if (this.stopped) return;
      this.syncRuntime();
      const pnl = this.pnl();
      // Every runner each tick. The concurrency cap throttles how many brain
      // calls are in flight, not how many sleeves get a tick.
      for (const r of this.allRunners()) void this.tickOne(r, pnl);
    };
    this.timer = setInterval(() => void tickAll(), this.cfg.tickMs);
    void tickAll();
  }

  private async tickOne(r: SleeveRunner, pnl: PnlSnapshot): Promise<void> {
    this.inFlight += 1;
    try {
      if (this.inFlight > this.cfg.maxJevConcurrency) {
        // Over the brain budget: still tick, but skip the call entirely rather
        // than queueing latency into a stale decision.
        r.sleeve.stats.blockedByGate += 1;
        return;
      }
      await r.tick(pnl);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      this.log(`tick error ${r.sleeve.id}: ${msg}`);
      this.bus.emit("error", { kind: "tick", sleeveId: r.sleeve.id, message: msg });
    } finally {
      this.inFlight -= 1;
    }
  }

  snapshot(): unknown {
    const pnl = this.pnl();
    return {
      ts: Date.now(),
      mode: this.mode,
      model: this.model,
      era: this.era,
      proof: this.proof,
      kill: this.killSwitched,
      dailyLossTripped: this.dailyLossTripped,
      tickMs: this.cfg.tickMs,
      pnl,
      connections: {
        // Null before start() and after stop(). The desk polls this endpoint, and
        // a handler that throws on a half-built engine turns a diagnostic
        // surface into a crash.
        public: this.publicWs?.statusSnapshot() ?? null,
        private: this.privateWs?.statusSnapshot() ?? null,
      },
      sleeves: this.sleeves().map((s) => ({
        id: s.id,
        bot: s.bot,
        instId: s.instId,
        position: s.position,
        workingOrder: s.workingOrder,
        lastMid: s.lastMid,
        bookTs: s.bookTs,
        stats: s.stats,
        jev: s.lastJev,
        intent: s.lastIntent,
      })),
    };
  }

  async kill(): Promise<void> {
    this.killSwitched = true;
    this.syncRuntime();
    this.log("KILL: cancelling all working orders, entries halted");
    await this.cancelAll();
    await this.flattenAll("kill switch");
    this.bus.emit("kill", { active: true, at: Date.now() });
  }

  async unkill(): Promise<void> {
    this.killSwitched = false;
    this.syncRuntime();
    this.log("UNKILL: entries may resume (mode gates still apply)");
    this.bus.emit("kill", { active: false, at: Date.now() });
  }

  private async cancelAll(): Promise<void> {
    for (const r of this.allRunners()) await r.cancelWorking("kill");
    if (this.usesPrivateWs) {
      try {
        await this.rest.cancelAll();
      } catch (e) {
        this.log(`cancel-all failed: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
  }

  private async flattenAll(reason: string): Promise<void> {
    for (const r of this.allRunners()) {
      const s = r.sleeve;
      if (s.position.side === "flat") continue;
      const inst = this.instruments.get(s.instId);
      if (!inst) continue;
      const target = s.position.notionalUsd > 0 ? s.position.notionalUsd : this.cfg.risk.maxPosUsd;
      const szr = inst.sizeForNotional(s.lastMid || s.position.entryPx, target);
      if (!szr.sz) continue;
      const side = s.position.side === "long" ? "sell" : "buy";
      this.log(`flatten ${s.instId} (${reason}): ${szr.sz} ${side}`);
      if (this.simulateFills) {
        r.applySimulatedFill(side, s.lastMid, szr.contracts, szr.sz, true);
      } else {
        try {
          await this.rest.placeOrder({
            instId: s.instId,
            tdMode: "isolated",
            side,
            ordType: "ioc",
            sz: szr.sz,
            reduceOnly: true,
          });
        } catch (e) {
          this.log(`flatten ${s.instId} failed: ${e instanceof Error ? e.message : String(e)}`);
        }
      }
    }
  }

  async setMode(m: string): Promise<{ ok: boolean; error?: string }> {
    const allowed: Mode[] = ["mock", "demo", "paper"];
    if (m === "live") {
      // Never a silent upgrade, and never via HTTP: env + LIVE_CONFIRM only.
      return { ok: false, error: "live mode cannot be set at runtime; set MODE=live and LIVE_CONFIRM=I_UNDERSTAND in the environment" };
    }
    if (!allowed.includes(m as Mode)) {
      return { ok: false, error: `mode must be one of ${allowed.join("|")}` };
    }
    if (m === this.mode) return { ok: true };
    this.log(`mode change ${this.mode} -> ${m}; restart the engine to rewire venues`);
    this.mode = m as Mode;
    this.syncRuntime();
    this.bus.emit("mode", { mode: this.mode });
    return { ok: true };
  }

  stop(): void {
    if (this.proofTimer) { clearInterval(this.proofTimer); this.proofTimer = null; }
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    this.publicWs?.close();
    this.businessWs?.close();
    this.privateWs?.close();
    this.store.close();
  }
}
