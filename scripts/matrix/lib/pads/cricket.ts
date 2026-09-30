// cricket: the matrix generator emits one coarse `cricket.innings.summary
// {runs, wickets, legalBalls}` per innings (streams/cricket.ts), which the pad
// cannot write as one row. The references into cricket.tsx:
//  - :1523-1556 the `overSummary` tile, offered while fidelity is not "fine";
//  - :2558-2589 overSummarySheet: three number steps — this over's runs,
//    wickets and balls (balls opening at ballsPerOver) — whose payload ADDS
//    them onto the open innings and sets `partial: true` (:2585);
//  - :2597 registers the sheet under "overSummary".
// Step 0 (2026-09-30, 320, the builder default `t20`, rosterless team
// entrants) saw no toss, opener or lineup demanded: each over sheet wrote one
// cumulative `{runs, wickets, legalBalls, partial: true}` row at once. The
// 120th ball closed the innings by itself (no close row), and the chase
// decided the match on the over that passed its target (no close row).
//
// So one generated innings is ⌈legalBalls / ballsPerOver⌉ over sheets and as
// many rows, judged by its fallback's own judge (judgeInnings: the innings'
// last over row, less `partial`, against the summary; replay.ts judgeFallback,
// since e3ebd230c). The runs are spread as evenly as whole numbers
// allow (the remainder on the last over), the wickets all fall in the last
// over, and every over but the last is full. Every generated innings ends
// itself — balls out, all out, or a chase past its target — so the route never
// taps inningsClose. An innings that would stay open, or a chase that would
// pass its target before its last over, is refused by name. The adapter keeps
// one record per fixture (the entrant pair, reset by core.start): which innings
// comes next, and the first innings' runs, which set the chase's target.
import { START_MATCH_TESTID, type TapAdapterContext, type TapStep } from "../../../bench/lib/drivers/scorer.ts";
import type { LedgerRow } from "../../../bench/lib/ledger.ts";
import { sportModule } from "../sport-cfg.ts";
import { declaredAllOut } from "../streams/cricket.ts";
import type { StreamEvent } from "../streams/types.ts";
import { JUDGED_OK, asRecord, judgeKeys } from "./judge.ts";
import type { FallbackJudgement, MatrixPadAdapter } from "./types.ts";

/** The engine's cricket event type (cricket.eventSchemas; pinned). */
export const CRICKET_SUMMARY = "cricket.innings.summary";
/** cricket.tsx:1536 (text-pinned in pad-adapters.test.ts). */
export const CRICKET_OVER_TILE = "overSummary";

export interface Over { readonly runs: number; readonly wickets: number; readonly balls: number }
interface Innings { readonly runs: number; readonly wickets: number; readonly legalBalls: number }
interface Cfg { readonly ballsPerOver: number; readonly ballsPerInnings: number | null; readonly inningsPerSide: number }

/** The over sheets one innings takes: ⌈legalBalls / bpo⌉ overs, every one but
 *  the last full, the runs spread evenly with the remainder on the last over,
 *  and the wickets all in the last over. */
export function overSplit(p: Innings, bpo: number): Over[] {
  const overs = Math.ceil(p.legalBalls / bpo);
  const each = Math.floor(p.runs / overs);
  return Array.from({ length: overs }, (_x, i): Over => {
    const last = i === overs - 1;
    return {
      runs: last ? p.runs - each * (overs - 1) : each,
      wickets: last ? p.wickets : 0,
      balls: last ? p.legalBalls - bpo * (overs - 1) : bpo,
    };
  });
}

function cfgOf(cfg: unknown): Cfg {
  const c = (cfg ?? {}) as Record<string, unknown>;
  const bpo = c.ballsPerOver;
  const bpi = c.ballsPerInnings ?? null;
  if (!Number.isInteger(bpo) || (bpo as number) < 1 || (bpi !== null && (!Number.isInteger(bpi) || (bpi as number) < 1))) {
    throw new Error(`cricketPad: the cfg's ballsPerOver ${JSON.stringify(bpo)} / ballsPerInnings ${JSON.stringify(bpi)} are not whole numbers ≥ 1`);
  }
  if (c.inningsPerSide !== 1) throw new Error(`cricketPad: inningsPerSide ${JSON.stringify(c.inningsPerSide)} — the over route covers single-innings cricket only`);
  return { ballsPerOver: bpo as number, ballsPerInnings: bpi as number | null, inningsPerSide: 1 };
}

function inningsOf(payload: unknown, cfg: Cfg, allOut: number): Innings {
  const p = (payload ?? {}) as Record<string, unknown>;
  const keys = Object.keys(p).sort();
  const whole = (v: unknown) => Number.isInteger(v) && (v as number) >= 0;
  const ok = payload !== null && typeof payload === "object"
    && keys.length === 3 && keys[0] === "legalBalls" && keys[1] === "runs" && keys[2] === "wickets"
    && whole(p.runs) && whole(p.wickets) && whole(p.legalBalls)
    && (p.legalBalls as number) >= 1 && (cfg.ballsPerInnings === null || (p.legalBalls as number) <= cfg.ballsPerInnings)
    && (p.wickets as number) <= allOut;
  if (!ok) {
    throw new Error(`cricketPad: ${CRICKET_SUMMARY} payload ${JSON.stringify(payload)} is not {runs, wickets, legalBalls} of whole numbers with 1 ≤ legalBalls ≤ ${cfg.ballsPerInnings ?? "∞"} and wickets ≤ ${allOut}`);
  }
  return { runs: p.runs as number, wickets: p.wickets as number, legalBalls: p.legalBalls as number };
}

/** fixture (entrant pair) → the innings summaries tapped since core.start. */
const tapped = new Map<string, Innings[]>();
const fixtureOf = (ctx: TapAdapterContext) => `${ctx.entrants.home}|${ctx.entrants.away}`;

function summarySteps(event: StreamEvent, ctx: TapAdapterContext): readonly TapStep[] {
  const cfg = cfgOf(ctx.cfg);
  const allOut = declaredAllOut(sportModule("cricket").padSpec?.(ctx.cfg));
  const inn = inningsOf(event.payload, cfg, allOut);
  const before = tapped.get(fixtureOf(ctx));
  if (before === undefined) throw new Error("cricketPad: an innings summary before core.start on this fixture — which innings it is, is unknown");
  if (before.length >= 2) throw new Error(`cricketPad: a third innings (${JSON.stringify(event.payload)}) — single-innings cricket has two`);
  const n = before.length + 1;
  const overs = overSplit(inn, cfg.ballsPerOver);
  if (n === 2) {
    // The chase closes the moment it passes the target, so every over before
    // the last must leave it short, or the pad refuses the rest.
    const target = before[0].runs + 1;
    let sum = 0;
    for (const [k, o] of overs.slice(0, -1).entries()) {
      sum += o.runs;
      if (sum >= target) throw new Error(`cricketPad: innings 2: the chase passes its target (${target}) at over ${k + 1} of ${overs.length} — the pad would close it there`);
    }
  }
  const chaseWon = n === 2 && inn.runs >= before[0].runs + 1;
  const closesItself = (cfg.ballsPerInnings !== null && inn.legalBalls >= cfg.ballsPerInnings) || inn.wickets >= allOut || chaseWon;
  if (!closesItself) {
    throw new Error(`cricketPad: innings ${n} would stay open (${inn.runs}/${inn.wickets} in ${inn.legalBalls} balls: not all balls, not all out, not a chase past its target) — the pad owes an inningsClose whose reason the stream does not name`);
  }
  tapped.set(fixtureOf(ctx), [...before, inn]);
  return overs.flatMap((o): TapStep[] => [
    { kind: "tile", tileId: CRICKET_OVER_TILE },
    { kind: "number", value: o.runs }, { kind: "confirm" },
    { kind: "number", value: o.wickets }, { kind: "confirm" },
    { kind: "number", value: o.balls }, { kind: "confirm" },
  ]);
}

/** Fix round 1 (I-1): each over row is the open innings' running total
 *  (cricket.tsx:2585), so the innings' LAST row, less `partial`, is the
 *  generated summary: every key it carries stored and equal, and `partial`
 *  the only other key, as true. */
function judgeInnings(event: StreamEvent, rows: readonly LedgerRow[]): FallbackJudgement {
  const last = rows.at(-1);
  if (last === undefined) return { ok: false, note: "no over row stored for the innings" };
  const required = Object.keys(asRecord(event.payload));
  const j = judgeKeys(event, last, { required, stamped: { partial: { shape: "true", is: (v) => v === true } } });
  return j.ok ? JUDGED_OK : { ok: false, note: `the last of ${rows.length} over rows: ${j.note}` };
}

export const cricketPad: MatrixPadAdapter = {
  sport: "cricket",
  emits: ["core.start", CRICKET_SUMMARY],
  fallbacks: [
    {
      eventType: CRICKET_SUMMARY,
      writes: [CRICKET_SUMMARY],
      why: "cricket.tsx:2585 — the pad authors an innings only as cumulative over summaries (partial: true, one row per over; Step 0 2026-09-30), and the innings ends itself, so its judge holds the innings' last over row, less `partial`, to the summary",
      rowsFor: (event, ctx) => Math.ceil(((event.payload ?? {}) as { legalBalls: number }).legalBalls / cfgOf(ctx.cfg).ballsPerOver),
      judge: judgeInnings,
    },
  ],
  stepsFor(event, ctx) {
    if (event.type === "core.start") {
      tapped.set(fixtureOf(ctx), []);
      return [{ kind: "testid", testid: START_MATCH_TESTID }];
    }
    if (event.type === CRICKET_SUMMARY) return summarySteps(event, ctx);
    throw new Error(`cricketPad: no tap route for ${event.type} (a generator emitting it owes a route here)`);
  },
  // Every generated innings is a fallback; no row is compared by payload.
  tolerableExtraKeys: () => [],
};
