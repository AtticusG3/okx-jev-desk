/**
 * The proof: one status, derived from the ledger and docs/PROOF_RULE.md alone.
 *
 * Four statuses, and no fifth:
 *
 *   COLLECTING  Not enough is known to decide. The normal state for weeks.
 *   NO_EDGE     Enough data, the statistics say there is nothing to find.
 *   COST_BOUND  There is a statistical edge, and it does not survive costs.
 *   CANDIDATE   Every requirement in the bar is met.
 *
 * The order matters. Duration and coverage are checked first, so a young
 * ledger can never be told NO_EDGE on the strength of 200 rows — that is the
 * failure mode where a system concludes "no edge exists" from having barely
 * looked. A ledger that has not earned a verdict says COLLECTING.
 *
 * Nothing here writes. CANDIDATE is a statement about evidence, not a
 * configuration change.
 */
import { loadSeries, scoreFeature, vrResult, FEATURES, seedFor, type Series, type Scored } from "./analysis.ts";
import type { ProofRule } from "./proof_rule.ts";

export type ProofStatus = "COLLECTING" | "NO_EDGE" | "COST_BOUND" | "CANDIDATE";

export interface Requirement {
  id: string;
  label: string;
  met: boolean;
  detail: string;
}

export interface ProofReport {
  status: ProofStatus;
  era: string;
  /** The era the verdict is about, or null when none has data. */
  requirements: Requirement[];
  /** Best p_adj across the family at the primary horizon, or null. */
  bestPAdj: number | null;
  bestFeat: string | null;
  /** Best net bps after cost, or null. */
  bestNetBps: number | null;
  /** Sessions from the bar that are still missing this week. */
  sessionsMissing: string[];
  calendarDays: number;
  weeks: number;
  instruments: string[];
  scored: number;
  /** Why the status is what it is, in one sentence. */
  reason: string;
}

export interface ProofInput {
  dbPath: string;
  instruments: string[];
  rule: ProofRule;
  /** Model actually used for collection. `mock` can never be evidence. */
  model: string;
  /** The pinned model id, or null if unpinned. */
  modelId: string | null;
  tickMs: number;
  bootP?: number;
  minSettled?: number;
  era: string;
  /**
   * When true, judge ONLY `era` and never fall back.
   *
   * The fallback exists for the CLI: a ledger collected before the current
   * process booted has rows under an era this process did not compute, and
   * reporting on nothing would be less useful than reporting on the busiest
   * one. A test that means to assert the era filter needs the strict form, or
   * it silently asserts the fallback instead.
   */
  strictEra?: boolean;
}

/** ISO week key, UTC. Weeks are what the bar counts in. */
function weekKey(ts: number): string {
  const d = new Date(ts);
  const target = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  // Shift to the Thursday of this week; ISO weeks start Monday.
  const dayNum = (target.getUTCDay() + 6) % 7;
  target.setUTCDate(target.getUTCDate() - dayNum + 3);
  const firstThursday = new Date(Date.UTC(target.getUTCFullYear(), 0, 4));
  const week = 1 + Math.round(
    ((target.getTime() - firstThursday.getTime()) / 86400000 - 3 + ((firstThursday.getUTCDay() + 6) % 7)) / 7,
  );
  return `${target.getUTCFullYear()}-W${String(week).padStart(2, "0")}`;
}

function sessionOf(ts: number): string {
  const h = new Date(ts).getUTCHours();
  return h < 8 ? "asia" : h < 16 ? "europe" : "us";
}

export function runProof(inp: ProofInput): ProofReport {
  const r = inp.rule;
  const bootP = inp.bootP ?? 4000;
  const minSettled = inp.minSettled ?? 500;
  const requirements: Requirement[] = [];
  const sessionsMissing: string[] = [];

  const push = (id: string, label: string, met: boolean, detail: string) =>
    requirements.push({ id, label, met, detail });

  // --- the era with the most data in it
  //
  // This pass reads UNFILTERED on purpose: it is the discovery step, and it
  // cannot know which era to ask for until it has seen which ones exist. Rows
  // with era = null are skipped here, so a pre-era row never contributes a day
  // or a week. The second pass, below, re-reads era-scoped and is what the
  // statistics see.
  const perEra = new Map<string, { ticks: number; days: Set<string>; weeks: Map<string, Set<string>> }>();
  for (const inst of inp.instruments) {
    const s = loadSeries(inp.dbPath, inst);
    for (const t of s.ticks) {
      const e = t.era;
      if (!e) continue;
      let rec = perEra.get(e);
      if (!rec) { rec = { ticks: 0, days: new Set(), weeks: new Map() }; perEra.set(e, rec); }
      rec.ticks++;
      rec.days.add(new Date(t.ts).toISOString().slice(0, 10));
      const wk = weekKey(t.ts);
      if (!rec.weeks.has(wk)) rec.weeks.set(wk, new Set());
      rec.weeks.get(wk)!.add(t.session ?? sessionOf(t.ts));
    }
  }

  let era = inp.era;
  let best = perEra.get(era);
  if ((!best || best.ticks === 0) && !inp.strictEra) {
    // Fall back to whichever era actually has rows, so the proof can report on
    // a ledger collected before this process started.
    let top = "";
    let topN = 0;
    for (const [e, rec] of perEra) if (rec.ticks > topN) { top = e; topN = rec.ticks; }
    if (top) { era = top; best = perEra.get(top)!; }
  }
  if (!best) best = { ticks: 0, days: new Set(), weeks: new Map() };

  const days = best.days.size;
  push("days", `>= ${r.minCalendarDays} calendar days in one era`, days >= r.minCalendarDays,
    `${days}/${r.minCalendarDays} days`);

  // Weeks that have EVERY required session. Count only the most recent N
  // complete weeks, so an old complete week cannot carry a new gap.
  const complete = [...best.weeks.entries()]
    .filter(([, ss]) => r.requiredSessions.every((x) => ss.has(x)))
    .map(([w]) => w)
    .sort();
  const recent = complete.slice(-r.minWeeks);
  push("weeks", `Asia+US present in each of the last ${r.minWeeks} weeks`,
    complete.length >= r.minWeeks && recent.length === r.minWeeks,
    `${Math.min(complete.length, r.minWeeks)}/${r.minWeeks} complete weeks`);

  // Which required sessions are missing from the most recent complete-ish week.
  const latestWeek = [...best.weeks.keys()].sort().at(-1);
  if (latestWeek) {
    const have = best.weeks.get(latestWeek)!;
    for (const need of r.requiredSessions) if (!have.has(need)) sessionsMissing.push(need);
  }

  const modelOk = inp.model === r.requiredModel;
  const pinnedOk = modelOk && inp.modelId !== null && inp.modelId !== "jev-latest";
  push("model", `MODEL=${r.requiredModel} with a pinned id`, pinnedOk,
    `MODEL=${inp.model}${inp.modelId ? ` (${inp.modelId})` : ""}${pinnedOk ? "" : " - not evidence"}`);

  // --- statistics
  const series: Series[] = [];
  for (const inst of inp.instruments) {
    const s = loadSeries(inp.dbPath, inst, era);
    series.push(s);
  }

  const vrByHorizon: { h: number; ok: boolean; detail: string }[] = [];
  for (const h of r.vrHorizonsMin) {
    let ok = false;
    const details: string[] = [];
    for (const s of series) {
      const v = vrResult(s.ticks.map((t) => t.mid), h, inp.tickMs);
      if (v.verdict === "mean-reverting" || v.verdict === "trending") ok = true;
      details.push(`${v.verdict}${v.decidable ? ` (VR ${v.vr.toFixed(2)})` : ` (need ${v.need})`}`);
    }
    vrByHorizon.push({ h, ok, detail: details.join("; ") });
  }
  push("vr", `variance ratio rejects the random walk at ${r.vrHorizonsMin.map((h) => `${h}m`).join(" and ")}`,
    vrByHorizon.every((v) => v.ok),
    vrByHorizon.map((v) => `${v.h}m ${v.detail}`).join("; "));

  // Primary horizon for the family test: the shortest one the bar names.
  const primaryH = Math.min(...r.vrHorizonsMin);
  const family = FEATURES.length;
  const scoredAll: Scored[] = [];
  let waiting = 0;
  for (const s of series) {
    for (const feat of FEATURES) {
      const res = scoreFeature(s, feat, {
        hMin: primaryH, tickMs: inp.tickMs, feeBps: r.makerFeeBps + r.takerFeeBps,
        alpha: r.maxPAdj, family, bootP, minSettled, embargoRows: Math.round((primaryH * 60_000) / inp.tickMs),
      }, seedFor([era, primaryH, feat]));
      if ("waiting" in res) waiting++;
      else scoredAll.push(res);
    }
  }
  // ONE feature must satisfy BOTH tests.
  //
  // The previous version took the smallest p_adj across the family and the
  // largest net bps across the family as two independent reductions, then
  // required both to be true. Those can come from different features: A can be
  // significant and unprofitable while B is noise with a fat absolute move, and
  // the conjunction is satisfied by a pair that neither feature satisfies on
  // its own. With 34 tests per horizon there are many such pairs, so this was
  // not a theoretical hole.
  //
  // The subject of the claim is now a single feature: the one with the best
  // corrected p-value, and it must ALSO be profitable on its own numbers. A
  // different, more profitable, insignificant feature does not rescue it.
  const bestRow = scoredAll.length
    ? scoredAll.reduce((a, b) => (b.pAdj < a.pAdj ? b : a))
    : null;
  const bestP = bestRow ? bestRow.pAdj : null;
  push("p_adj", `Bonferroni p_adj < ${r.maxPAdj} across the ${family}-feature family`,
    bestP !== null && bestP < r.maxPAdj,
    bestP === null ? `waiting (${waiting} feature/horizon combos below ${minSettled} settled rows)`
      : `best p_adj ${bestP.toExponential(2)} (${bestRow!.feat})`);

  // Net for the SAME feature that carries the significance. Not the family's
  // maximum, which is a different experiment.
  const bestNet = bestRow ? bestRow.netBps : null;
  const otherNet = scoredAll.length ? Math.max(...scoredAll.map((x) => x.netBps)) : null;
  push("net", `net bps > ${r.minNetBps} after ${r.makerFeeBps}+${r.takerFeeBps} and measured markout`,
    bestNet !== null && bestNet > r.minNetBps,
    bestNet === null ? "waiting"
      : `${bestRow!.feat} net ${bestNet.toFixed(2)}bps` +
        (otherNet !== null && otherNet > bestNet
          // Say so when a different feature is more profitable, because that
          // is the thing a reader would otherwise assume.
          ? ` (best in family is ${otherNet.toFixed(2)}bps, a DIFFERENT feature - not the claim)`
          : ""));

  // --- status
  const identityMet = ["days", "weeks", "model"].every((id) => requirements.find((x) => x.id === id)!.met);
  const statsMet = ["vr", "p_adj", "net"].every((id) => requirements.find((x) => x.id === id)!.met);

  let status: ProofStatus;
  let reason: string;
  if (!identityMet) {
    status = "COLLECTING";
    const lacking = requirements.filter((x) => !x.met && ["days", "weeks", "model"].includes(x.id));
    reason = `not enough to judge: ${lacking.map((x) => x.detail).join("; ")}`;
  } else if (!statsMet) {
    // Enough history to say something. Which something depends on whether the
    // statistics ran at all.
    const pMet = requirements.find((x) => x.id === "p_adj")!.met;
    const netMet = requirements.find((x) => x.id === "net")!.met;
    const vrMet = requirements.find((x) => x.id === "vr")!.met;
    if (pMet && !netMet) {
      status = "COST_BOUND";
      reason = `edge is there on ${bestRow!.feat} (p_adj ${bestP!.toExponential(2)}) but its net is ${bestNet!.toFixed(2)}bps, which does not clear the bar`;
    } else if (vrMet && !pMet) {
      status = "NO_EDGE";
      reason = `${r.minCalendarDays} days of history and no feature clears p_adj < ${r.maxPAdj}`;
    } else {
      status = "COLLECTING";
      reason = `history is sufficient but the statistics are not yet decidable: ${
        requirements.filter((x) => !x.met).map((x) => x.detail).join("; ")}`;
    }
  } else {
    status = "CANDIDATE";
    reason = "every requirement in docs/PROOF_RULE.md is met";
  }

  return {
    status, era, requirements, bestPAdj: bestP, bestFeat: bestRow?.feat ?? null,
    bestNetBps: bestNet, sessionsMissing, calendarDays: days, weeks: complete.length,
    instruments: inp.instruments, scored: scoredAll.length, reason,
  };
}
