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
// comes next, and the runs of the innings before it, which set the chase's target.
//
// Two innings a side (the `test` preset; W1d item 16, D13) are the same route
// four times over, with three differences, each read from the engine
// (packages/engine/src/sports/cricket/cricket.ts):
//  - the chase is the FOURTH innings, and its target is an aggregate:
//    chaseTarget, :791-801 — the opponents' runs over the innings so far, less
//    the chaser's own, plus one (no follow-on: home bats 1st and 3rd);
//  - a declared innings (`declared: true` on the summary, :1704) is the over
//    sheets and then the skin's `declare` tile (cricket.tsx:1506-1511), which
//    writes a SEPARATE `cricket.innings.declare` row (:3714-3722) — the
//    declaration is not a key of any over row — and is only offered while the
//    innings is still open (closedTile), so a declared innings the over sheets
//    would close by themselves is refused by name;
//  - a `partial` summary leaves the innings open, which the over sheets do by
//    themselves.
// `cricket.followon` and `cricket.match.close` have NO route: the skin builds
// no tile or sheet for either (cricket.tsx:59-63), so they are rows of the
// generic More sheet, whose buttons carry no testid (action-form.tsx
// renderActionRow) — nothing in the tap vocabulary can address them. They are
// declared in `noControl`, a route to the wave that owns the pad's controls,
// and the driver scores a stream holding either over http (browser-driver.ts).
import { START_MATCH_TESTID, type TapAdapterContext, type TapStep } from "../../../bench/lib/drivers/scorer.ts";
import type { LedgerRow } from "../../../bench/lib/ledger.ts";
import { routeTo } from "../routing.ts";
import { sportModule } from "../sport-cfg.ts";
import { declaredAllOut } from "../streams/cricket.ts";
import type { StreamEvent } from "../streams/types.ts";
import { JUDGED_OK, asRecord, judgeKeys, show } from "./judge.ts";
import type { FallbackJudgement, MatrixPadAdapter } from "./types.ts";

/** The engine's cricket event type (cricket.eventSchemas; pinned). */
export const CRICKET_SUMMARY = "cricket.innings.summary";
/** cricket.tsx:1536 (text-pinned in pad-adapters.test.ts). */
export const CRICKET_OVER_TILE = "overSummary";
/** cricket.tsx:1507 (text-pinned): the declare tile, built only for two innings a side. */
export const CRICKET_DECLARE_TILE = "declare";
/** The engine's declaration event (cricket.eventSchemas; pinned) — what the declare tile writes. */
export const CRICKET_DECLARE = "cricket.innings.declare";
/** The engine's follow-on and time-expiry draw events (cricket.eventSchemas; pinned). */
export const CRICKET_FOLLOW_ON = "cricket.followon";
export const CRICKET_MATCH_CLOSE = "cricket.match.close";

/** Why the pad cannot be driven to write either of the two: one cause, so one
 *  route (the mixed ledger refuses a second, different exemption per type). */
export const CRICKET_NO_CONTROL = routeTo("W2", "the pad offers cricket's follow-on and time-expiry draw only as rows of the generic More sheet, whose buttons carry no testid; once they do, they are taps like any other");

export interface Over { readonly runs: number; readonly wickets: number; readonly balls: number }
interface Innings { readonly runs: number; readonly wickets: number; readonly legalBalls: number }
/** What an innings summary carries beyond its totals: `declared` ends it by
 *  declaration, `partial` leaves it open. Each is generated as `true` or absent. */
interface Summary extends Innings { readonly declared: boolean; readonly partial: boolean }
interface Cfg { readonly ballsPerOver: number; readonly ballsPerInnings: number | null; readonly inningsPerSide: 1 | 2 }
/** One fixture's record since core.start: the innings the pad has closed, in order, and whether a `partial` one is open. */
interface Taken { readonly closed: readonly Innings[]; readonly open: boolean }

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
  if (c.inningsPerSide !== 1 && c.inningsPerSide !== 2) throw new Error(`cricketPad: inningsPerSide ${JSON.stringify(c.inningsPerSide)} — the over route covers one or two innings a side`);
  return { ballsPerOver: bpo as number, ballsPerInnings: bpi as number | null, inningsPerSide: c.inningsPerSide };
}

const whole = (v: unknown): boolean => Number.isInteger(v) && (v as number) >= 0;

function summaryOf(payload: unknown, cfg: Cfg, allOut: number): Summary {
  const p = (payload ?? {}) as Record<string, unknown>;
  const keys = Object.keys(p).sort();
  const totals = ["legalBalls", "runs", "wickets"];
  // `declared` and `partial` are generated as `true` or not at all, and a declaration is a two-innings act (cricket.ts:1692).
  const extra = keys.filter((k) => !totals.includes(k));
  const flagsOk = extra.every((k) => (k === "partial" || (k === "declared" && cfg.inningsPerSide === 2)) && p[k] === true);
  const ok = payload !== null && typeof payload === "object"
    && totals.every((k) => keys.includes(k)) && flagsOk
    && whole(p.runs) && whole(p.wickets) && whole(p.legalBalls)
    && (p.legalBalls as number) >= 1 && (cfg.ballsPerInnings === null || (p.legalBalls as number) <= cfg.ballsPerInnings)
    && (p.wickets as number) <= allOut
    && !(p.declared === true && p.partial === true);
  if (!ok) {
    throw new Error(`cricketPad: ${CRICKET_SUMMARY} payload ${JSON.stringify(payload)} is not {runs, wickets, legalBalls} of whole numbers with 1 ≤ legalBalls ≤ ${cfg.ballsPerInnings ?? "∞"} and wickets ≤ ${allOut}, and at most one of declared: true (two innings a side) and partial: true`);
  }
  return { runs: p.runs as number, wickets: p.wickets as number, legalBalls: p.legalBalls as number, declared: p.declared === true, partial: p.partial === true };
}

/** The runs the last innings needs to win, from the innings before it (the
 *  engine's chaseTarget, cricket.ts:791-801; no follow-on, so the pairs are
 *  home 1st and 3rd, away 2nd and 4th). One innings a side: the first innings'
 *  runs + 1. Two: the home aggregate, less away's first innings, + 1. */
function chaseTargetOf(before: readonly Innings[], cfg: Cfg): number {
  if (cfg.inningsPerSide === 1) return before[0].runs + 1;
  return before[0].runs + before[2].runs - before[1].runs + 1;
}

const ORDINAL = ["", "first", "second", "third", "fourth", "fifth"];

function summarySteps(event: StreamEvent, ctx: TapAdapterContext, tapped: Map<string, Taken>): readonly TapStep[] {
  const cfg = cfgOf(ctx.cfg);
  const allOut = declaredAllOut(sportModule("cricket").padSpec?.(ctx.cfg));
  const sum = summaryOf(event.payload, cfg, allOut);
  const key = fixtureOf(ctx);
  const taken = tapped.get(key);
  if (taken === undefined) throw new Error("cricketPad: an innings summary before core.start on this fixture — which innings it is, is unknown");
  if (taken.open) throw new Error(`cricketPad: an innings summary (${JSON.stringify(event.payload)}) after a partial one — the pad would add it to the open innings; the generator builds none`);
  const total = cfg.inningsPerSide * 2;
  if (taken.closed.length >= total) throw new Error(`cricketPad: a ${ORDINAL[total + 1] ?? `#${total + 1}`} innings (${JSON.stringify(event.payload)}) — ${cfg.inningsPerSide === 1 ? "single-innings" : "two-innings"} cricket has ${total === 2 ? "two" : "four"}`);
  const n = taken.closed.length + 1;
  const overs = overSplit(sum, cfg.ballsPerOver);
  const target = n === total ? chaseTargetOf(taken.closed, cfg) : null;
  if (target !== null) {
    // The chase closes the moment it passes the target, so every over before
    // the last must leave it short, or the pad refuses the rest.
    let run = 0;
    for (const [k, o] of overs.slice(0, -1).entries()) {
      run += o.runs;
      if (run >= target) throw new Error(`cricketPad: innings ${n}: the chase passes its target (${target}) at over ${k + 1} of ${overs.length} — the pad would close it there`);
    }
  }
  const closesItself = (cfg.ballsPerInnings !== null && sum.legalBalls >= cfg.ballsPerInnings) || sum.wickets >= allOut || (target !== null && sum.runs >= target);
  const at = `${sum.runs}/${sum.wickets} in ${sum.legalBalls} balls`;
  if (sum.partial || sum.declared) {
    // Both leave the innings open after its over sheets: a partial summary by
    // definition, a declaration because the declare tile is disabled on a closed one.
    if (closesItself) throw new Error(`cricketPad: innings ${n} would close itself (${at}: all balls, all out, or a chase past its target), so the ${sum.declared ? "declare tile is disabled on it" : "partial summary cannot leave it open"}`);
  } else if (!closesItself) {
    throw new Error(`cricketPad: innings ${n} would stay open (${at}: not all balls, not all out, not a chase past its target) — the pad owes an inningsClose whose reason the stream does not name`);
  }
  tapped.set(key, sum.partial ? { closed: taken.closed, open: true } : { closed: [...taken.closed, sum], open: false });
  return [
    ...overs.flatMap((o): TapStep[] => [
      { kind: "tile", tileId: CRICKET_OVER_TILE },
      { kind: "number", value: o.runs }, { kind: "confirm" },
      { kind: "number", value: o.wickets }, { kind: "confirm" },
      { kind: "number", value: o.balls }, { kind: "confirm" },
    ]),
    ...(sum.declared ? [{ kind: "tile", tileId: CRICKET_DECLARE_TILE } as const] : []),
  ];
}

const fixtureOf = (ctx: TapAdapterContext) => `${ctx.entrants.home}|${ctx.entrants.away}`;

/** Fix round 1 (I-1): each over row is the open innings' running total
 *  (cricket.tsx:2585), so the innings' LAST over row, less `partial`, is the
 *  generated summary: every key it carries stored and equal, and `partial`
 *  the only other key, as true. A declared innings ends in the declare tile's
 *  own row (W1d item 16): an empty-payload `cricket.innings.declare`, and the
 *  `declared` key is that row, never a key of an over row. */
function judgeInnings(event: StreamEvent, rows: readonly LedgerRow[]): FallbackJudgement {
  const payload = asRecord(event.payload);
  const declared = payload.declared === true;
  let overRows = rows;
  if (declared) {
    const decl = rows.at(-1);
    if (decl === undefined || decl.type !== CRICKET_DECLARE) return { ok: false, note: `the declared innings ends in ${decl === undefined ? "no row" : `a ${decl.type} row`}, not a ${CRICKET_DECLARE} row` };
    if (Object.keys(asRecord(decl.payload)).length !== 0) return { ok: false, note: `the ${CRICKET_DECLARE} row carries ${show(decl.payload)}, not an empty payload` };
    overRows = rows.slice(0, -1);
  }
  const last = overRows.at(-1);
  if (last === undefined) return { ok: false, note: "no over row stored for the innings" };
  if (overRows.some((r) => r.type !== CRICKET_SUMMARY)) return { ok: false, note: `a ${overRows.find((r) => r.type !== CRICKET_SUMMARY)!.type} row among the innings' over rows` };
  const required = Object.keys(payload).filter((k) => k !== "declared");
  const j = judgeKeys(event, last, { required, stamped: { partial: { shape: "true", is: (v) => v === true } } });
  return j.ok ? JUDGED_OK : { ok: false, note: `the last of ${overRows.length} over rows: ${j.note}` };
}

/** One adapter, with its own record of what each fixture has tapped (W1d M-4:
 *  this was a module-level map, so a second adapter, or a second case's replay
 *  in the same process, read the first's record). */
export function makeCricketPad(): MatrixPadAdapter {
  /** fixture (entrant pair) → what it has tapped since core.start. */
  const tapped = new Map<string, Taken>();
  return {
    sport: "cricket",
    emits: ["core.start", CRICKET_SUMMARY, CRICKET_FOLLOW_ON, CRICKET_MATCH_CLOSE],
    fallbacks: [
      {
        eventType: CRICKET_SUMMARY,
        writes: [CRICKET_SUMMARY, CRICKET_DECLARE],
        why: "cricket.tsx:2585 — the pad authors an innings only as cumulative over summaries (partial: true, one row per over; Step 0 2026-09-30), and the innings ends itself, so its judge holds the innings' last over row, less `partial`, to the summary; a declared innings is those rows and then the declare tile's own cricket.innings.declare row (cricket.tsx:1510)",
        rowsFor: (event, ctx) => {
          const p = (event.payload ?? {}) as { legalBalls: number; declared?: unknown };
          return Math.ceil(p.legalBalls / cfgOf(ctx.cfg).ballsPerOver) + (p.declared === true ? 1 : 0);
        },
        judge: judgeInnings,
      },
    ],
    noControl: { eventTypes: [CRICKET_FOLLOW_ON, CRICKET_MATCH_CLOSE], route: CRICKET_NO_CONTROL },
    stepsFor(event, ctx) {
      if (event.type === "core.start") {
        tapped.set(fixtureOf(ctx), { closed: [], open: false });
        return [{ kind: "testid", testid: START_MATCH_TESTID }];
      }
      if (event.type === CRICKET_SUMMARY) return summarySteps(event, ctx, tapped);
      if (event.type === CRICKET_FOLLOW_ON || event.type === CRICKET_MATCH_CLOSE) {
        throw new Error(`cricketPad: ${event.type} has no addressable pad control (→ ${CRICKET_NO_CONTROL.wave}: ${CRICKET_NO_CONTROL.why}); a stream holding it is scored over http`);
      }
      throw new Error(`cricketPad: no tap route for ${event.type} (a generator emitting it owes a route here)`);
    },
    // Every generated innings is a fallback; no row is compared by payload.
    tolerableExtraKeys: () => [],
  };
}

export const cricketPad: MatrixPadAdapter = makeCricketPad();
