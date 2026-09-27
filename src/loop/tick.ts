/**
 * Tick loop: one independent sleeve per (bot, instrument) pair.
 *
 * MULTI-BOT MODEL: each sleeve is a fully isolated desk. It has its own
 * instrument, its own position, its own working order, its own tick clock and
 * its own brain answer. Sleeves never share a position and never share a
 * decision, so three or four bots can run against the same exchange account
 * without one bot's position confusing another's. The only shared resource is
 * desk-level risk (gross exposure, daily loss), which is enforced in gates.ts
 * and is intentionally global — three bots each at MAX_POS_USD would otherwise
 * be three times the risk you think you have.
 *
 * Idempotency: a tick rebuilds everything from exchange state (book, position,
 * working order) rather than from memory, so a crash mid-tick resumes cleanly.
 */
import type { Config } from "../config.ts";
import { computeFeatures, type FeatureContext, type Features } from "../features/compute.ts";
import { makeBrain, type Brain } from "../jev/client.ts";
import { buildState } from "../jev/state.ts";
import { evaluateGates, sizeNotional } from "../risk/gates.ts";
import { makeClOrdId, mapAnswers, makerPrice } from "../risk/intent.ts";
import type { Instrument } from "../okx/instruments.ts";
import type { OkxRest, PlaceOrderResult } from "../okx/rest.ts";
import type { OkxPublicWs } from "../okx/wsPublic.ts";
import type { BookState, PnlSnapshot, Sleeve, SleeveIntent, TickRecord } from "../store/types.ts";
import type { EventBus } from "../store/events.ts";
import type { Store } from "../store/db.ts";
import { sessionForTs } from "../measure/era.ts";

export interface SleeveDeps {
  cfg: Config;
  rest: OkxRest;
  publicWs: OkxPublicWs;
  store: Store;
  bus: EventBus;
  /** Era identity for this boot, stamped onto every tick. */
  era: string;
  /** Comma-separated era files that could not be hashed. "" when all present. */
  eraMissing: string;
  brain: Brain;
  instrument: Instrument | null;
  funding: Map<string, { rate: number; nextHours: number }>;
  oiChange1hPct: Map<string, number | null>;
  log: (m: string) => void;
  /** Live, engine-owned flags. Mutable on purpose: the engine owns desk-wide
   *  risk state, and every sleeve must read the same value on the same tick. */
  runtime: {
    simulateFills: boolean;
    killSwitched: boolean;
    dailyLossTripped: boolean;
  };
}

export function makeSleeve(id: string, instId: string, bot: string): Sleeve {
  return {
    id,
    instId,
    bot,
    enabled: true,
    position: {
      instId,
      side: "flat",
      szContracts: 0,
      entryPx: 0,
      markPx: 0,
      notionalUsd: 0,
      unrealizedPnlUsd: 0,
      openedAt: null,
      leverage: 1,
      liqPx: null,
    },
    workingOrder: null,
    lastMid: 0,
    bookTs: 0,
    privateTs: 0,
    stats: { ticks: 0, ordersPlaced: 0, fills: 0, jevErrors: 0, lastJevLatencyMs: null, blockedByGate: 0 },
    recentTrades: [],
    candles1m: [],
    candles5m: [],
    lastJev: null,
    lastIntent: null,
  };
}

export class SleeveRunner {
  readonly sleeve: Sleeve;
  private readonly d: SleeveDeps;
  private seq = 0;
  private orderTimestamps: number[] = [];
  /** Serialises ticks for this sleeve so two ticks never interleave. */
  private running = false;

  constructor(sleeve: Sleeve, d: SleeveDeps) {
    this.sleeve = sleeve;
    this.d = d;
  }

  ingestTrade(instId: string, t: { ts: number; px: number; sz: number; side: "buy" | "sell" }): void {
    if (instId !== this.sleeve.instId) return;
    this.sleeve.recentTrades.push(t);
    // Keep a bounded window; 30s is the feature window, keep 2 minutes for safety.
    const cut = Date.now() - 120_000;
    while (this.sleeve.recentTrades.length && this.sleeve.recentTrades[0]!.ts < cut) {
      this.sleeve.recentTrades.shift();
    }
  }

  ingestCandle(instId: string, bar: string, c: { ts: number; o: number; h: number; l: number; c: number; v: number }): void {
    if (instId !== this.sleeve.instId) return;
    const arr = bar === "1m" ? this.sleeve.candles1m : this.sleeve.candles5m;
    const last = arr[arr.length - 1];
    if (last && last.ts === c.ts) {
      arr[arr.length - 1] = c; // update in place
    } else {
      arr.push(c);
    }
    // 4h of 1m is plenty for the 1h features; bound memory.
    while (arr.length > 300) arr.shift();
    arr.sort((a, b) => a.ts - b.ts);
  }

  setBook(book: BookState): void {
    if (book.instId !== this.sleeve.instId) return;
    this.sleeve.bookTs = book.ts;
    this.sleeve.lastMid = book.bids[0] && book.asks[0] ? (book.bids[0].px + book.asks[0].px) / 2 : 0;
  }

  markPrivateFresh(): void {
    this.sleeve.privateTs = Date.now();
  }

  private rateExceeded(now: number): boolean {
    this.orderTimestamps = this.orderTimestamps.filter((t) => now - t < 60_000);
    return this.orderTimestamps.length >= this.d.cfg.risk.maxOrdersPerMin;
  }

  private recordOrder(now: number): void {
    this.orderTimestamps.push(now);
  }

  /** Invalidate the in-memory working order when the exchange says it's gone. */
  onOrderTerminal(clOrdId: string, state: string): void {
    const wo = this.sleeve.workingOrder;
    if (wo && wo.clOrdId === clOrdId && /filled|partially_filled|canceled|mmp_canceled/.test(state)) {
      if (!/partially_filled/.test(state)) this.sleeve.workingOrder = null;
    }
  }

  async tick(pnl: PnlSnapshot): Promise<TickRecord | null> {
    if (this.running) return null; // never overlap ticks for one sleeve
    this.running = true;
    const now = Date.now();
    try {
      const book = this.d.publicWs.book(this.sleeve.instId);
      const fctx: FeatureContext = {
        book,
        fundingRate: this.d.funding.get(this.sleeve.instId)?.rate ?? null,
        nextFundingHours: this.d.funding.get(this.sleeve.instId)?.nextHours ?? null,
        oiChange1hPct: this.d.oiChange1hPct.get(this.sleeve.instId) ?? null,
        // Needed for spread-in-ticks; absent metadata degrades to 0 -> "tight"
        // which the occupancy report will flag rather than silently mislead.
        tickSz: this.d.instrument?.tickSz ?? 0,
      };
      const features = computeFeatures(this.sleeve, fctx, now);
      // Without this a simulated position is only marked on fills, so
      // unrealized PnL - and the notional the gates and Jev state read - go stale.
      if (features && this.d.runtime.simulateFills) this.markSimulated(features.mid);
      if (!features) {
        return {
          ts: now,
          sleeveId: this.sleeve.id,
          instId: this.sleeve.instId,
          mid: this.sleeve.lastMid,
          bid: 0,
          ask: 0,
          spreadBps: 0,
          jev: null,
          intent: null,
          gates: ["no usable book"],
          executed: false,
          execNote: "no book",
          positionSide: this.sleeve.position.side,
          positionNotionalUsd: this.sleeve.position.notionalUsd,
        };
      }

      // --- brain ---
      const state = buildState({
        sleeve: this.sleeve,
        features,
        pnl,
        mode: this.d.cfg.mode,
        now,
      });
      const answers = await this.d.brain.ask(this.sleeve.id, state, features);
      this.sleeve.lastJev = answers;
      if (answers.error) this.sleeve.stats.jevErrors += 1;
      this.sleeve.stats.lastJevLatencyMs = answers.latencyMs;
      this.d.store.recordCall(
        this.sleeve.id,
        this.d.brain.name,
        answers.model,
        answers.latencyMs,
        answers.inputTokens,
        answers.outputTokens,
        answers.error ?? null,
        answers,
      );

      // --- policy ---
      let intent: SleeveIntent = mapAnswers(answers, this.sleeve, features, this.d.cfg);

      // --- gates ---
      const gate = evaluateGates(
        {
          sleeve: this.sleeve,
          features,
          intent,
          pnl,
          now,
          haltEntries: this.d.runtime.killSwitched || this.d.runtime.dailyLossTripped,
          orderRateExceeded: this.rateExceeded(now),
        },
        this.d.cfg,
      );
      intent = { ...intent, gateNotes: gate.notes };
      if (!gate.ok && !intent.blocked) {
        intent = {
          ...intent,
          blocked: true,
          // A blocked entry or a blocked exit becomes a no-op, never a trade.
          side: "none",
          urgency: intent.urgency === "taker" && this.sleeve.position.side !== "flat" ? "taker" : "cancel_only",
        };
        this.sleeve.stats.blockedByGate += 1;
      }
      this.sleeve.lastIntent = intent;

      // --- execute ---
      const exec = await this.execute(intent, features, now);

      this.sleeve.stats.ticks += 1;
      const rec: TickRecord = {
        ts: now,
        sleeveId: this.sleeve.id,
        instId: this.sleeve.instId,
        mid: features.mid,
        bid: features.bid,
        ask: features.ask,
        spreadBps: features.spreadBps,
        jev: answers,
        intent,
        gates: gate.notes,
        executed: exec.placed,
        execNote: exec.note,
        positionSide: this.sleeve.position.side,
        positionNotionalUsd: this.sleeve.position.notionalUsd,
        session: sessionForTs(now),
        era: this.d.era,
        eraMissing: this.d.eraMissing,
      };
      this.d.store.recordTick(rec);
      this.d.store.recordFeatures(this.sleeve.id, this.sleeve.instId, now, JSON.stringify(features));
      this.d.bus.emit("tick", {
        sleeveId: this.sleeve.id,
        instId: this.sleeve.instId,
        mid: features.mid,
        bid: features.bid,
        ask: features.ask,
        spreadBps: features.spreadBps,
        buckets: features.buckets,
        jev: answers,
        intent,
        gates: gate.notes,
        executed: exec.placed,
        execNote: exec.note,
        position: this.sleeve.position,
      });
      return rec;
    } finally {
      this.running = false;
    }
  }

  private async execute(
    intent: SleeveIntent,
    features: Features,
    now: number,
  ): Promise<{ placed: boolean; note: string }> {
    // 1. Cancel-only paths.
    if (intent.side === "none") {
      if (intent.urgency === "cancel_only" && this.sleeve.workingOrder) {
        await this.cancelWorking("intent no longer wants this quote");
        return { placed: false, note: "cancelled working quote" };
      }
      return { placed: false, note: "no action" };
    }

    const side = intent.side;
    const reduceOnly = intent.urgency === "taker";
    const inst = this.d.instrument;
    if (!inst) return { placed: false, note: "no instrument metadata" };

    // 2. Taker path: exit / flatten. Market IOC reduce-only.
    if (reduceOnly) {
      const posNotional = this.sleeve.position.notionalUsd;
      const target = posNotional > 0 ? posNotional : this.d.cfg.risk.maxPosUsd;
      const szr = inst.sizeForNotional(features.mid, target);
      if (!szr.sz) return { placed: false, note: `exit size 0: ${szr.reason ?? "unknown"}` };
      if (this.d.runtime.simulateFills) {
        this.applySimulatedFill(side, features.mid, szr.contracts, szr.sz, true);
        return { placed: true, note: `SIMULATED exit ${szr.sz} @ mid` };
      }
      const clOrdId = makeClOrdId(this.sleeve.id, this.seq++, now);
      const res = await this.d.rest.placeOrder({
        instId: this.sleeve.instId,
        tdMode: "isolated",
        side,
        ordType: "ioc",
        sz: szr.sz,
        reduceOnly: true,
        clOrdId,
      });
      this.recordOrder(now);
      this.sleeve.stats.ordersPlaced += 1;
      return this.reportOrder(res, clOrdId, "exit");
    }

    // 3. Maker path: post-only entry.
    if (this.rateExceeded(now)) return { placed: false, note: "order rate limit" };
    const pDir = intent.jev?.directionProbs[intent.jev.direction] ?? 0;
    const sizing = sizeNotional(pDir, this.d.cfg);
    if (!sizing.ok) return { placed: false, note: `sizing: ${sizing.reason}` };

    const { px, wouldCross } = makerPrice(side, features, inst.tickSz, !this.d.cfg.risk.alwaysPostOnly);
    if (wouldCross && this.d.cfg.risk.alwaysPostOnly) {
      // A maker intent must never become a taker fill.
      return { placed: false, note: "maker price would cross the spread: skipped" };
    }
    const szr = inst.sizeForNotional(px, sizing.notionalUsd);
    if (!szr.sz) return { placed: false, note: `entry size 0: ${szr.reason ?? "unknown"}` };

    // Replace-by-cancel: one working quote per sleeve.
    if (this.sleeve.workingOrder) {
      const prev = this.sleeve.workingOrder;
      if (Math.abs(prev.px - px) < inst.tickSz * 0.5 && prev.side === side) {
        return { placed: false, note: "working quote already at target" };
      }
      await this.cancelWorking("replace by new quote");
    }

    const clOrdId = makeClOrdId(this.sleeve.id, this.seq++, now);
    if (this.d.runtime.simulateFills) {
      // Simulated maker: fill only if the market trades through our price.
      this.sleeve.workingOrder = { clOrdId, ordId: null, side, px, sz: Number(szr.sz), ts: now, reduceOnly: false };
      this.sleeve.stats.ordersPlaced += 1;
      this.d.bus.emit("quote", { sleeveId: this.sleeve.id, instId: this.sleeve.instId, side, px, sz: Number(szr.sz), simulated: true });
      return { placed: true, note: `SIMULATED post-only ${szr.sz} @ ${px}` };
    }
    const res = await this.d.rest.placeOrder({
      instId: this.sleeve.instId,
      tdMode: "isolated",
      side,
      ordType: "post_only",
      px: String(px),
      sz: szr.sz,
      reduceOnly: false,
      clOrdId,
    });
    this.recordOrder(now);
    this.sleeve.stats.ordersPlaced += 1;
    const ok = this.reportOrder(res, clOrdId, "entry");
    if (ok.placed) {
      this.sleeve.workingOrder = { clOrdId, ordId: res[0]?.ordId ?? null, side, px, sz: Number(szr.sz), ts: now, reduceOnly: false };
      this.d.bus.emit("quote", { sleeveId: this.sleeve.id, instId: this.sleeve.instId, side, px, sz: Number(szr.sz), simulated: false });
    }
    return ok;
  }

  private reportOrder(res: PlaceOrderResult[], clOrdId: string, kind: string): { placed: boolean; note: string } {
    const r = res[0];
    if (!r) return { placed: false, note: `${kind}: empty response` };
    if (r.sCode && r.sCode !== "0") {
      this.d.store.upsertOrder({
        clOrdId, ordId: r.ordId ?? null, ts: Date.now(), sleeveId: this.sleeve.id,
        instId: this.sleeve.instId, side: "buy", ordType: "unknown", px: null, sz: null,
        reduceOnly: false, state: "rejected", sCode: r.sCode,
      });
      return { placed: false, note: `${kind} REJECTED sCode=${r.sCode} ${r.sMsg}` };
    }
    this.d.store.upsertOrder({
      clOrdId, ordId: r.ordId ?? null, ts: Date.now(), sleeveId: this.sleeve.id,
      instId: this.sleeve.instId, side: "buy", ordType: kind, px: null, sz: null,
      reduceOnly: false, state: "live", sCode: "0",
    });
    return { placed: true, note: `${kind} accepted ordId=${r.ordId ?? "?"}` };
  }

  async cancelWorking(reason: string): Promise<void> {
    const wo = this.sleeve.workingOrder;
    if (!wo) return;
    this.sleeve.workingOrder = null;
    if (this.d.runtime.simulateFills) {
      this.d.bus.emit("quote", { sleeveId: this.sleeve.id, instId: this.sleeve.instId, cancelled: true, reason });
      return;
    }
    try {
      await this.d.rest.cancelOrder(this.sleeve.instId, wo.ordId ?? undefined, wo.clOrdId);
    } catch (e) {
      this.d.log(`cancel failed for ${wo.clOrdId}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  /** USD value of a 1.0 price move on one contract: ctVal * ctMult. Null if
   *  the instrument can't be valued (non-USD quote, missing metadata). */
  private contractMult(): number | null {
    const cv = this.d.instrument?.contractValueUsd(1);
    return cv !== null && cv !== undefined && cv > 0 ? cv : null;
  }

  /** Mark a simulated position to `px`. Live positions are marked by OKX. */
  markSimulated(px: number): void {
    const p = this.sleeve.position;
    const mult = this.contractMult();
    if (mult === null || !(px > 0)) return;
    p.markPx = px;
    p.notionalUsd = p.szContracts * px * mult;
    p.unrealizedPnlUsd = p.side === "flat" ? 0 : (px - p.entryPx) * p.szContracts * mult * (p.side === "long" ? 1 : -1);
  }

  /** Simulated fill for paper/mock mode: mark the position and emit. */
  applySimulatedFill(side: "buy" | "sell", px: number, contracts: number, sz: string, reduceOnly: boolean): void {
    const p = this.sleeve.position;
    // USD per 1.0 price move per contract. OKX contracts are NOT one unit of the
    // base coin: BTC-USDT-SWAP is ctVal=0.01 BTC, so contracts * px overstates
    // notional and PnL by 100x. Live positions read notionalUsd/upl from OKX;
    // this is the paper/mock path and must apply the same multiplier.
    const mult = this.contractMult();
    if (mult === null) {
      this.d.log(`${this.sleeve.id}: simulated fill dropped - no contract value for ${this.sleeve.instId}`);
      return;
    }
    const now = Date.now();
    const dir = side === "buy" ? 1 : -1;
    if (p.side === "flat") {
      p.side = dir > 0 ? "long" : "short";
      p.szContracts = contracts;
      p.entryPx = px;
      p.openedAt = now;
    } else if ((p.side === "long" && side === "buy") || (p.side === "short" && side === "sell")) {
      const total = p.szContracts + contracts;
      p.entryPx = (p.entryPx * p.szContracts + px * contracts) / total;
      p.szContracts = total;
    } else {
      const closing = Math.min(contracts, p.szContracts);
      const realized = (px - p.entryPx) * closing * mult * (p.side === "long" ? 1 : -1);
      p.szContracts -= closing;
      if (p.szContracts <= 1e-9) {
        p.side = "flat";
        p.szContracts = 0;
        p.entryPx = 0;
        p.openedAt = null;
      }
      this.d.store.recordFill(
        {
          ts: now, sleeveId: this.sleeve.id, instId: this.sleeve.instId,
          ordId: `sim-${now}`, clOrdId: `sim-${now}`, side, px, sz: contracts,
          fee: 0, realizedPnl: realized, tradeId: `sim-${now}-${contracts}`,
        },
        this.sleeve.id,
      );
    }
    this.markSimulated(px);
    this.sleeve.stats.fills += 1;
    this.d.bus.emit("fill", {
      sleeveId: this.sleeve.id, instId: this.sleeve.instId, side, px, sz: contracts,
      simulated: true, position: p,
    });
  }

  /** Fill a simulated resting quote if the market traded through it. */
  checkSimulatedFill(book: BookState | undefined): void {
    if (!this.d.runtime.simulateFills) return;
    const wo = this.sleeve.workingOrder;
    if (!wo || !book) return;
    const tradedThrough = wo.side === "buy"
      ? book.asks[0] !== undefined && book.asks[0].px <= wo.px
      : book.bids[0] !== undefined && book.bids[0].px >= wo.px;
    if (!tradedThrough) return;
    this.sleeve.workingOrder = null;
    this.applySimulatedFill(wo.side, wo.px, wo.sz, String(wo.sz), wo.reduceOnly);
  }
}
