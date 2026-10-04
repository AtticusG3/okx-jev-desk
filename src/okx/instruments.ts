/**
 * Instrument metadata and the USD-notional -> OKX `sz` conversion.
 *
 * Getting `sz` wrong is the classic way to place a 100x-too-large order, so the
 * rounding rules are explicit and independently tested rather than inlined at
 * the call site:
 *   - contracts = notionalUsd / (px * ctValCcy-per-ctVal in USD)
 *   - floor to lotSz (never round UP past the size you intended)
 *   - reject below minSz
 *   - price floors to tickSz
 */
import type { InstrumentInfo } from "./rest.ts";

export interface Instrument {
  instId: string;
  instType: string;
  tickSz: number;
  lotSz: number;
  minSz: number;
  ctVal: number;
  ctValCcy: string;
  ctMult: number;
  state: string;
  /** USD value of one contract at price `px`, or null if it cannot be derived. */
  contractValueUsd(px: number): number | null;
  /** Convert a target USD notional to a legal OKX `sz` string. */
  sizeForNotional(px: number, notionalUsd: number): SizeResult;
  roundPx(px: number): number;
  roundSz(sz: number): number;
}

export interface SizeResult {
  sz: string | null;
  contracts: number;
  notionalUsd: number;
  reason?: "below_min" | "zero" | "no_price" | "no_ctval" | "non_finite";
}

export function toInstrument(i: InstrumentInfo): Instrument {
  const tickSz = Number(i.tickSz ?? "0");
  const lotSz = Number(i.lotSz ?? "0");
  const minSz = Number(i.minSz ?? "0");
  const ctVal = Number(i.ctVal ?? "0");
  const ctMult = Number(i.ctMult ?? "1") || 1;

  const roundPx = (px: number): number => {
    if (!Number.isFinite(px) || tickSz <= 0) return px;
    // Floor to tick grid. Flooring a buy price keeps it passive; flooring a
    // sell price also keeps it passive, so floor is the safe default and the
    // caller never crosses the spread by accident.
    return Math.floor(px / tickSz + 1e-9) * tickSz;
  };

  const roundSz = (sz: number): number => {
    if (!Number.isFinite(sz) || lotSz <= 0) return sz;
    return Math.floor(sz / lotSz + 1e-9) * lotSz;
  };

  const contractValueUsd = (px: number): number | null => {
    if (!Number.isFinite(px) || px <= 0) return null;
    if (!(ctVal > 0)) return null;
    // For a USDT-margined linear perp, ctVal is denominated in the BASE coin
    // (BTC-USDT-SWAP has ctVal=0.01, ctValCcy="BTC") or in USDT (SOL has
    // ctVal=1, ctValCcy="SOL"). Either way px is a USD price and the contract's
    // USD value is px * ctVal * ctMult.
    //
    // What must fail loudly is a contract whose QUOTE is not a USD stablecoin.
    // Then px is denominated in BTC/ETH and the USD value is a completely
    // different formula (roughly px/ctVal), so multiplying would mis-size by
    // orders of magnitude. v1 trades USDT-margined swaps only, so anything else
    // is refused rather than guessed.
    const quoteCcy = (i.quoteCcy ?? "").toUpperCase();
    const usdQuoted = quoteCcy === "" || quoteCcy === "USDT" || quoteCcy === "USD" || quoteCcy === "USDC";
    if (!usdQuoted) return null;
    return px * ctVal * ctMult;
  };

  const sizeForNotional = (px: number, notionalUsd: number): SizeResult => {
    if (!Number.isFinite(px) || px <= 0) {
      return { sz: null, contracts: 0, notionalUsd: 0, reason: "no_price" };
    }
    if (!Number.isFinite(notionalUsd) || notionalUsd <= 0) {
      return { sz: null, contracts: 0, notionalUsd: 0, reason: "non_finite" };
    }
    const cv = contractValueUsd(px);
    if (cv === null) return { sz: null, contracts: 0, notionalUsd: 0, reason: "no_ctval" };

    const raw = notionalUsd / cv;
    const contracts = roundSz(raw);
    if (contracts <= 0) {
      return { sz: null, contracts: 0, notionalUsd: 0, reason: "zero" };
    }
    if (minSz > 0 && contracts < minSz - 1e-12) {
      // Report what it WOULD have been so the caller can log the shortfall.
      return { sz: null, contracts, notionalUsd: contracts * cv, reason: "below_min" };
    }
    // Trim float noise: OKX wants a plain decimal, not 1.2000000000000002.
    return { sz: trimNum(contracts), contracts, notionalUsd: contracts * cv };
  };

  return {
    instId: i.instId,
    instType: i.instType,
    tickSz,
    lotSz,
    minSz,
    ctVal,
    ctValCcy: i.ctValCcy ?? "",
    ctMult,
    state: i.state ?? "",
    contractValueUsd,
    sizeForNotional,
    roundPx,
    roundSz,
  };
}

export function trimNum(n: number): string {
  if (!Number.isFinite(n)) return "0";
  // 8dp is the OKX contract-size convention; strip trailing zeros but KEEP the
  // leading zero. A previous version returned ".05", which is valid JS but not
  // a safe thing to send to an exchange parser.
  const s = n.toFixed(8).replace(/\.?0+$/, "");
  return s.startsWith(".") ? `0${s}` : s === "-0" ? "0" : s;
}

export function loadInstruments(list: InstrumentInfo[], wanted: string[]): Map<string, Instrument> {
  const out = new Map<string, Instrument>();
  const byId = new Map(list.map((i) => [i.instId, i]));
  for (const id of wanted) {
    const info = byId.get(id);
    if (!info) continue;
    if (info.state && info.state !== "live") continue;
    out.set(id, toInstrument(info));
  }
  return out;
}
