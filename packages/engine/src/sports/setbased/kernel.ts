// Set-based scoring kernel — spec 04 §3–5 + engine/sports/{volleyball,badminton,
// table-tennis}.md (PROMPT-06). ONE parametric engine parameterised by
// {bestOf, setTo, finalSetTo, winBy, cap, pointsMap}; volleyball, badminton and
// table tennis are three thin presets — this file owns every line of set logic,
// the presets add only catalog/metrics/labels. Dual fidelity (spec 04 §9.6):
// fine `rally {wonBy}` and coarse `*.summary` fold to identical set totals and
// outcomes, and all result math reads only the folded set ledger.
import { z } from "zod";
import { EngineError } from "../../core/errors.ts";
import {
  forfeitOf,
  isStrictFold,
  resolveVoids,
  type CoreEv,
  type EventEnvelope,
} from "../../core/events.ts";
import type { Rng } from "../../core/rng.ts";
import {
  scoreSegment,
  unitNumber,
  unitSegment,
  type MatchPosition,
} from "../../core/position.ts";
import {
  EntrantId,
  type DisciplineCard,
  type DisciplineModel,
  type LineupPair,
  type MatchOutcome,
  type MetricSpec,
  type ScoreSummary,
  type StageKind,
  type StandingsDelta,
} from "../../core/types.ts";
import type { PositionCatalog } from "../../sport/catalog.ts";
import type { EntrantModel } from "../../sport/entrant-model.ts";
import { boundsFrom, stampAttributionRequired } from "../../sport/module.ts";
import {
  personsForEntrant,
  type PlayerStatMetric,
  type PlayerStatRow,
  type PlayerStatsFoldCtx,
  type PlayerStatsModel,
} from "../../stats/stats.ts";
import type {
  FidelityBand,
  ModuleEvent,
  PadAction,
  PadAttribution,
  PadGate,
  PadPanel,
  PadSpec,
  SportModule,
  TiebreakerKey,
} from "../../sport/module.ts";
import { expectedPairServerOf, makeSquadAdopter, pairOrderOf } from "../squad-state.ts";
import { memberOf, onFieldPersons } from "../../core/lineup.ts";
import type { LineupPolicy, SquadState } from "../../core/lineup.ts";

// ---------------------------------------------------------------------------
// Kernel parameters & config — spec 04 §3.1 / §4 / §5
// ---------------------------------------------------------------------------

// A completed-set score maps to [winnerPoints, loserPoints] keyed by the
// winner's set tally "W-L" (FIVB 3-2 → [2,1]); "*" is the fall-through for
// every other (clean-win) score. Integers only — spec 04 §9.3.
export const PointsPair = z.tuple([
  z.number().int().nonnegative(),
  z.number().int().nonnegative(),
]);
export type PointsPair = z.infer<typeof PointsPair>;

// S6/#416 (W5) — which scoresheet interruptions THIS FIXTURE records. Was a
// preset-level (whole-module) constant (`SetBasedPreset.records`, now
// removed) until the beach-volleyball regression: `records` gated `apply()`'s
// dispatch and was read ONCE at module-construction time, so every variant of
// a sport shared one answer and `beach` could never differ from `indoor` —
// beach wrongly accepted `volleyball.sub`. Moving it into cfg (mirroring how
// `bestOf`/`setTo`/etc already vary per variant) is the only fix that can
// actually reach `apply()`, which sees only the resolved `cfg`, never a
// variant NAME (`init(cfg, lineups)` is not told which preset produced it).
// Every field is a plain required boolean (no per-field default): a variant
// overriding `records` restates the whole object, matching this kernel's own
// convention for every other nested cfg default (see the nested kernel's
// `set`/`game`/`tiebreak`, all `.default()`-wrapped objects with required
// inner leaves).
export interface SetBasedRecordFlags {
  timeouts: boolean;
  sanctions: boolean;
  substitutions: boolean;
  expedite: boolean;
}

export interface SetBasedParams {
  bestOf: number;
  setTo: number;
  finalSetTo: number;
  winBy: number;
  cap: number | null;
  pointsMap: Record<string, PointsPair>;
  records: SetBasedRecordFlags;
}

// Builds a preset's config schema (defaults = its shipped/first variant).
// Refinements are the kernel's hard invariants: odd bestOf (so ⌈bestOf/2⌉ has a
// unique decider) and cap ≥ target.
function makeConfigSchema(defaults: SetBasedParams) {
  return z
    .object({
      bestOf: z.number().int().positive().default(defaults.bestOf),
      setTo: z.number().int().positive().default(defaults.setTo),
      finalSetTo: z.number().int().positive().default(defaults.finalSetTo),
      winBy: z.number().int().positive().default(defaults.winBy),
      cap: z.number().int().positive().nullable().default(defaults.cap),
      pointsMap: z.record(z.string().min(1), PointsPair).default(defaults.pointsMap),
      // Inner leaves are plain required booleans (no per-field default) —
      // see SetBasedRecordFlags's doc comment: an override restates the whole
      // object, matching this kernel's `set`/`game`/`tiebreak` convention.
      records: z
        .object({
          timeouts: z.boolean(),
          sanctions: z.boolean(),
          substitutions: z.boolean(),
          expedite: z.boolean(),
        })
        .default(defaults.records),
    })
    .refine((cfg) => cfg.bestOf % 2 === 1, { message: "bestOf must be odd (a decider must exist)" })
    .refine((cfg) => cfg.cap === null || cfg.cap >= Math.max(cfg.setTo, cfg.finalSetTo), {
      message: "cap must be ≥ the set target",
    })
    .refine((cfg) => Object.keys(cfg.pointsMap).length > 0, {
      message: "pointsMap needs at least one entry",
    });
}

export type SetBasedCfg = SetBasedParams;

// ---------------------------------------------------------------------------
// Events — spec 04 §3.2 / §4 / §5
// ---------------------------------------------------------------------------

// W4 (#407) — person attribution. `PersonId` mirrors the football convention
// (a plain non-empty id); EVERY person field is optional so a coarse scorer who
// records nothing but `wonBy` stays legal and folds exactly as before.
export const PersonId = z.string().min(1);

// The FIVB scoresheet's point-by-point grid records the SERVING player's
// number, and the BWF / ITTF umpire sheets track the server through the service
// rotation — so `server` is a genuine scorebook field, not broadcast trivia.
// `scorer` is the player credited with the terminating action (kill/block/ace/
// winner); only pads that ask for it will send it.
export const SetBasedRally = z.strictObject({
  wonBy: EntrantId,
  server: PersonId.optional(),
  scorer: PersonId.optional(),
  // W4a (#425) §5.3 — the ITTF expedite system (Law 2.15.2). READ THE UNIT:
  // this is the count of the RECEIVER'S good returns, NOT the rally's stroke
  // count and NOT the number of shots the server played. The receiver takes
  // the point on their thirteenth, so the two readings differ by exactly the
  // amount that decides a rally. Only meaningful once expedite is in force;
  // recorded (and inert) before that.
  returns: z.number().int().nonnegative().optional(),
  // The SIDE that served this rally — an `EntrantId`, like `wonBy`.
  //
  // THIS IS NOT `server`. `server` directly above is a `PersonId`: the player
  // who served. They are adjacent, similarly named, differently typed, and in
  // doubles they routinely disagree (a person on the receiving pair can be
  // named in `server` by a pad recording the previous rally's server, and the
  // side that served is still the other one). `DisciplineCard.entrantSide`
  // shipped that exact confusion once already, so expedite enforcement reads
  // `serving` and never `server`. `expedite.test.ts` pins it with a rally whose
  // `server` is a string that is ALSO a legal `EntrantId` and names the OTHER
  // side — in both the accept and the reject direction. That is the only shape
  // that kills the bug: with a person-shaped `server` a wrong-field kernel dies
  // inside `sideOf` on an unknown entrant, which is a type-domain refusal and
  // not the wrong-side verdict the pin exists to catch.
  //
  // WHY IT IS ON THE PAYLOAD AT ALL: the set-based kernel holds no serving
  // state — `server` feeds a `serves` tally and nothing else — so the engine
  // cannot name the receiver from what it stores. Deriving the ITTF rotation
  // would break on doubles order and lineup changes (spec §5.3). The pad
  // already knows who is serving, because it is drawing the service
  // indicator, so it sends it. Optional: where it is absent the 13-return
  // rule is UNENFORCEABLE and the rally stands (see `applyRally`).
  serving: EntrantId.optional(),
});
export type SetBasedRally = z.infer<typeof SetBasedRally>;

// Coarse fidelity. Two accepted shapes fold identically:
//  • positional `{home, away}` — the scorer form (spec 04 §3.2 `set.summary`);
//  • entrant-keyed `{by, forBy, forOpp}` — the fidelity bridge coarsen emits,
//    position-independent so coarsen needs no lineup context (`by` scored
//    `forBy`, the opponent `forOpp`).
// `partial: true` = an in-progress (non-terminal) snapshot — the coarse analogue
// of an unfinished rally set, so a stream stopped mid-set renders the same live
// score after coarsening (spec 04 §9.6).
export const SetSummaryPositional = z.strictObject({
  home: z.number().int().nonnegative(),
  away: z.number().int().nonnegative(),
  partial: z.boolean().optional(),
});
export const SetSummaryByEntrant = z.strictObject({
  by: EntrantId,
  forBy: z.number().int().nonnegative(),
  forOpp: z.number().int().nonnegative(),
  partial: z.boolean().optional(),
});
export const SetBasedSummary = z.union([SetSummaryPositional, SetSummaryByEntrant]);
export type SetBasedSummary = z.infer<typeof SetBasedSummary>;

// W4 (#407) — the interruptions a set-based scoresheet actually carries.
// Which of the three a sport records is declared per preset (`records`): FIVB
// keeps timeouts, sanctions and substitutions; the ITTF sheet keeps timeouts
// and cards; BWF has no timeouts and no substitutions at all.
//
// NONE of these touches the score. A volleyball penalty concedes a rally and an
// ITTF penalty card awards a point, but the scoresheet writes that point into
// the point-by-point grid — so the point arrives as a rally and this row is the
// record of the misconduct, exactly as on paper.

/** FIVB's four-step sanction ladder. The BWF card ladder (yellow warning / red
 *  fault / black disqualification) and the ITTF yellow/red cards map onto it —
 *  each sport's dossier records the mapping. */
export const SetBasedSanctionLevel = z.enum([
  "warning",
  "penalty",
  "expulsion",
  "disqualification",
]);
export type SetBasedSanctionLevel = z.infer<typeof SetBasedSanctionLevel>;

export const SetBasedTimeout = z.strictObject({
  by: EntrantId,
  /** FIVB technical timeout (automatic at 8/16 in a non-deciding set). */
  technical: z.boolean().optional(),
});
export type SetBasedTimeout = z.infer<typeof SetBasedTimeout>;

export const SetBasedSanction = z.strictObject({
  by: EntrantId,
  level: SetBasedSanctionLevel,
  person: PersonId.optional(), // absent = a team sanction
  // W4 review — the offence as the official called it. The whole rationale for
  // `DisciplineCard.reason` (core/types.ts) is an accumulation rule keyed on
  // the offence rather than the ladder step — "three for dissent" — and this
  // branch could not express one, though the FIVB/BWF/ITTF sheets all leave a
  // free-text sanction note. Optional: coarse scoring records a step and
  // nothing else, and the fold never reads it (discipline does).
  reason: z.string().min(1).optional(),
});
export type SetBasedSanction = z.infer<typeof SetBasedSanction>;

// W4 review item 5 — `off`/`on`, the names `football.sub` has carried since
// before this wave. The incumbent wins; `in`/`out` also read badly across the
// engine, where cricket's `out` already names a DISMISSAL.
export const SetBasedSub = z.strictObject({
  by: EntrantId,
  off: PersonId.optional(),
  on: PersonId.optional(),
});
export type SetBasedSub = z.infer<typeof SetBasedSub>;

// W4a (#425) §5.3 — expedite is introduced, per ITTF Law 2.15.1, when a game
// reaches ten minutes unfinished (or earlier if both players agree), unless
// both have already scored nine. The TEN-MINUTE TRIGGER IS THE PAD'S: the
// engine owns no clock, and this event is the record that the umpire called it.
//
// EMPTY BY DESIGN, and the emptiness is the rule. Law 2.15.4 runs expedite to
// the end of the MATCH, not the end of the game, so there is no game number to
// carry — and because there is none, a second `expedite.start` is simply an
// invalid event rather than a re-scoping (`applyExpedite`). Scoping this per
// game would have been the wrong model, quietly.
export const SetBasedExpediteStart = z.strictObject({});
export type SetBasedExpediteStart = z.infer<typeof SetBasedExpediteStart>;

// Branch order matters: z.union takes the FIRST branch that parses, so the new
// branches are APPENDED and every pre-existing payload still lands on the
// branch it always did (rally needs `wonBy`, the summaries need home/away or
// forBy+forOpp — none of which the new strict branches accept).
// A bare `{by}` is accepted by both the timeout and the substitution branch;
// that overlap is inert because `apply` dispatches on the ENVELOPE type and
// parses with the one branch that type names.
// `SetBasedExpediteStart` is LAST and matches only `{}` — every other branch
// requires at least one key, so it can steal nothing from a sibling; placed
// first it would still steal nothing, but the rule is the rule (§8).
export const SetBasedEv = z.union([
  SetBasedRally,
  SetBasedSummary,
  SetBasedTimeout,
  SetBasedSanction,
  SetBasedSub,
  SetBasedExpediteStart,
]);
export type SetBasedEv = z.infer<typeof SetBasedEv>;

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

export type Side = "home" | "away";

export interface SetState {
  home: number;
  away: number;
  closed: boolean;
}

/** Per-person tallies folded out of attributed rallies (W4). */
export interface SetBasedPersonTally {
  points: number; // rallies won by this player's terminating action
  serves: number; // rallies this player served
}

export interface SetBasedSanctionRec {
  by: Side;
  level: SetBasedSanctionLevel;
  person?: string;
}

export interface SetBasedSubRec {
  by: Side;
  off?: string;
  on?: string;
}

export interface SetBasedSubState {
  home: number; // match totals
  away: number;
  thisSet: { home: number; away: number }; // reset when a set closes
  log: SetBasedSubRec[];
}

export interface SetBasedState {
  cfg: SetBasedCfg;
  entrants: { home: string; away: string };
  phase: "pre" | "live" | "done" | "final" | "abandoned";
  sets: SetState[]; // closed sets in order + at most one trailing open set
  setsWon: { home: number; away: number };
  outcome: MatchOutcome | null;
  replayFlagged: boolean;
  // ---- W4 (#407) additive extensions. Every one of these is ABSENT until the
  // event that fills it arrives, so a stream recorded before W4 folds to a
  // byte-identical state (the golden corpus compares JSON.stringify(state)).
  // Never initialise them in `init`.
  persons?: Record<string, SetBasedPersonTally>;
  timeouts?: { home: number; away: number };
  sanctions?: SetBasedSanctionRec[];
  subs?: SetBasedSubState;
  // ---- W4a (#425) §5.3 — expedite. MATCH-scoped (ITTF 2.15.4): `bankSet`
  // deliberately does NOT clear this, unlike `subs.thisSet`.
  expedite?: boolean;
  /** Rallies the 13-return rule could not be checked against, because they
   *  carried `returns` but no `serving` (spec §5.3). Recorded rather than
   *  hidden: a count of zero and a count of forty mean very different things
   *  about how much of an expedited match the engine actually validated.
   *  Deliberately NOT surfaced in `summary` — coarsening discards `returns`
   *  entirely, so a coarse fold could never reproduce it and §9.6 would break
   *  (the same reason `persons` stays out of the summary). `arbitraryEvent`
   *  generates the unenforceable rally precisely so that exclusion is a claim
   *  §9.6 ENFORCES: put this key in `summary().detail` and the conformance run
   *  goes red.
   *
   *  NOT write-only, and `summary().detail` is not the only surface. The whole
   *  folded state is persisted verbatim (`match_states.state`) and served raw
   *  by `GET /api/v1/fixtures/:id/state`, which is what the scoring pad page
   *  already reads — so a pad can read this counter today without any new
   *  export. Staying out of `summary` costs it nothing. */
  expediteUnchecked?: number;
  /**
   * S3/W4b (#426) — who is on court and where, as `core/lineup.ts` folded it.
   *
   * Two dossier rows land here. FIVB's LIBERO REPLACEMENT is a squad fact and
   * nothing else: it changes no score, so `subs`/`sets` cannot carry it, and
   * `SetBasedSubState` beside it is the scoresheet's substitution BOXES (a
   * per-set tally of in/out numbers) rather than a model of who is on court —
   * the two record different things and neither is derivable from the other.
   * And the racquet codes' DOUBLES ORDER arrives here from the team sheet's
   * `pairOrder`, which is what `expectedDoublesServer` reads.
   *
   * ABSENT until it says something the team sheet does not — see
   * `sports/squad-state.ts`. Never initialise it in `init`, for the same reason
   * as every optional field above it.
   */
  squads?: SquadState;
}

/**
 * Who is due to serve this side's `serviceTurn`-th service turn (0-based),
 * from the pair the team sheet declared — the reader
 * `DOMAIN.tabletennis.md`'s "doubles serve and receive order" row was deferred
 * for.
 *
 * The rotation itself was always derivable from the service history; the ORDER
 * was not, because it is declared and `init` used to discard it. `null` for a
 * singles fixture or a sheet that names no order: the caller then has nothing
 * to check the recorded `server` against, which is a true answer, unlike a
 * fabricated one.
 */
export function expectedDoublesServer(
  state: SetBasedState,
  side: Side,
  serviceTurn: number,
): string | null {
  return expectedPairServerOf(state.squads, side, serviceTurn);
}

/** ITTF Law 2.15.2 — the receiver wins the point on their thirteenth good
 *  return. Not configurable: it is the law, not a competition setting.
 *  Exported for `padSpec` (S6/#416): the same plausibility-sentinel pattern
 *  cricket uses for a schema-unbounded numeric field (`UNBOUNDED_BALLS_SENTINEL`). */
export const EXPEDITE_RETURNS = 13;

function opponent(side: Side): Side {
  return side === "home" ? "away" : "home";
}

function invalid(message: string, data?: unknown): never {
  throw new EngineError("INVALID_EVENT", message, data);
}

function wrongPhase(message: string, data?: unknown): never {
  throw new EngineError("WRONG_PHASE", message, data);
}

function sideOf(state: SetBasedState, entrantId: string): Side {
  if (entrantId === state.entrants.home) return "home";
  if (entrantId === state.entrants.away) return "away";
  invalid(`unknown entrant "${entrantId}"`, { entrantId });
}

function parsePayload<T>(schema: z.ZodType<T>, payload: unknown, type: string): T {
  const parsed = schema.safeParse(payload);
  if (!parsed.success) invalid(`invalid ${type} payload`, { issues: parsed.error.issues });
  return parsed.data;
}

// ---------------------------------------------------------------------------
// Set-win predicate & reachability — spec 04 §3.3 (single source of truth for
// both fidelities and coarsen)
// ---------------------------------------------------------------------------

const majority = (bestOf: number): number => Math.ceil(bestOf / 2);

// The deciding set is the last possible one (index bestOf−1, reached only at
// ⌈bestOf/2⌉−1 sets each) and uses finalSetTo (spec 04 §3.3).
function setTarget(params: SetBasedParams, setIndex: number): number {
  return setIndex === params.bestOf - 1 ? params.finalSetTo : params.setTo;
}

// Winner of a set at score (h,a), or null while it is still live. `cap` is the
// hard golden-point ceiling (badminton 30-29); cap=null = uncapped win-by-two
// endgame (volleyball 32-30). spec 04 §3.3.
function setWinner(
  h: number,
  a: number,
  target: number,
  winBy: number,
  cap: number | null,
): Side | null {
  const winner: Side | null = h > a ? "home" : a > h ? "away" : null;
  if (winner === null) return null;
  const hi = Math.max(h, a);
  const lo = Math.min(h, a);
  if (cap !== null && hi >= cap) return winner;
  if (hi >= target && hi - lo >= winBy) return winner;
  return null;
}

// A summary score is *reachable* iff it is terminal and the score one point
// earlier (winner one lower) was still live — rejecting 25-24 (winBy 2, no cap)
// and 22-19 / 31-30 (already decided earlier), accepting 26-24, 30-29 (cap),
// 32-30 (spec 04 §3.3; badminton/TT §3 corners).
function reachableSetScore(
  h: number,
  a: number,
  target: number,
  winBy: number,
  cap: number | null,
): boolean {
  // The set ends *at* the cap, so no score can exceed it (rejects 31-30).
  if (cap !== null && Math.max(h, a) > cap) return false;
  const winner = setWinner(h, a, target, winBy, cap);
  if (winner === null) return false;
  const prevH = winner === "home" ? h - 1 : h;
  const prevA = winner === "away" ? a - 1 : a;
  if (prevH < 0 || prevA < 0) return false;
  return setWinner(prevH, prevA, target, winBy, cap) === null;
}

// ---------------------------------------------------------------------------
// Fold helpers
// ---------------------------------------------------------------------------

function openSet(state: SetBasedState): { set: SetState; index: number } | null {
  const index = state.sets.length - 1;
  const set = state.sets[index];
  if (set === undefined || set.closed) return null;
  return { set, index };
}

function replaceSet(state: SetBasedState, index: number, set: SetState): SetBasedState {
  return { ...state, sets: state.sets.map((entry, i) => (i === index ? set : entry)) };
}

function totalPoints(state: SetBasedState, side: Side): number {
  return state.sets.reduce((sum, set) => sum + set[side], 0);
}

// W4 — credit optional person fields onto the tally map. Returns the SAME
// reference when nothing is credited, so an unattributed stream never
// materialises the `persons` key (golden byte-identity) and `apply` stays pure.
function creditPersons(
  persons: Record<string, SetBasedPersonTally> | undefined,
  credits: ReadonlyArray<readonly [string | undefined, keyof SetBasedPersonTally]>,
): Record<string, SetBasedPersonTally> | undefined {
  const named = credits.filter((entry): entry is readonly [string, keyof SetBasedPersonTally] =>
    entry[0] !== undefined,
  );
  if (named.length === 0) return persons;
  const next: Record<string, SetBasedPersonTally> = { ...(persons ?? {}) };
  for (const [personId, key] of named) {
    const prev = next[personId] ?? { points: 0, serves: 0 };
    next[personId] = { ...prev, [key]: prev[key] + 1 };
  }
  return next;
}

// Closes the set at `index` for `winnerSide`, banks the set win and decides the
// match when a side reaches ⌈bestOf/2⌉ sets (spec 04 §3.3). No draws, ever.
function bankSet(state: SetBasedState, index: number, winnerSide: Side): SetBasedState {
  const closed: SetState = { ...(state.sets[index] as SetState), closed: true };
  const setsWon = { ...state.setsWon, [winnerSide]: state.setsWon[winnerSide] + 1 };
  let next: SetBasedState = { ...replaceSet(state, index, closed), setsWon };
  // A new set means a fresh substitution allowance (indoor volleyball counts
  // six a SET, not a match) — the match totals keep running.
  if (next.subs !== undefined) {
    next = { ...next, subs: { ...next.subs, thisSet: { home: 0, away: 0 } } };
  }
  if (setsWon[winnerSide] >= majority(state.cfg.bestOf)) {
    next = {
      ...next,
      phase: "done",
      outcome: {
        kind: "win",
        winner: next.entrants[winnerSide],
        loser: next.entrants[opponent(winnerSide)],
        method: "regulation",
      },
    };
  }
  return next;
}

// ---------------------------------------------------------------------------
// Event application
// ---------------------------------------------------------------------------

// W4a (#425) §5.3 — ITTF Law 2.15.2 under expedite: thirteen good returns by
// the RECEIVER and the point is theirs, so a 13-return rally credited to the
// SERVING side contradicts the rule and is refused.
//
// Enforcement is CONDITIONAL on the rally naming `serving`, and that is a
// stated limitation, not an oversight. The kernel holds no serving state, so
// with `serving` absent there is no receiver to compare `wonBy` against.
// Rejecting those rallies would make coarse-tier expedited scoring — a pad
// that records `returns` off the umpire's sheet but not the service indicator
// — impossible to record at all. So the rally stands and the fold COUNTS it
// (`expediteUnchecked`) rather than pretending it was validated.
function checkExpedite(
  state: SetBasedState,
  payload: SetBasedRally,
  winner: Side,
): number | undefined {
  if (state.expedite !== true) return state.expediteUnchecked;
  if (payload.returns === undefined || payload.returns < EXPEDITE_RETURNS) {
    return state.expediteUnchecked;
  }
  if (payload.serving === undefined) return (state.expediteUnchecked ?? 0) + 1;
  // `serving`, never `server`: one is the side, the other is a person, and in
  // doubles they disagree.
  if (sideOf(state, payload.serving) === winner) {
    throw new EngineError(
      "EXPEDITE_WRONG_WINNER",
      `under expedite the receiver wins the point on their ${EXPEDITE_RETURNS}th good return — ` +
        `this rally records ${payload.returns} returns but credits the serving side`,
      { wonBy: payload.wonBy, serving: payload.serving, returns: payload.returns },
    );
  }
  return state.expediteUnchecked;
}

function applyRally(
  state: SetBasedState,
  payload: SetBasedRally,
  preset: { key: string; recordsExpedite: boolean; strict: boolean },
): SetBasedState {
  if (state.phase !== "live") wrongPhase(`rally not allowed in phase "${state.phase}"`);
  // W4a review — `returns` rides on the SHARED rally payload, so without this
  // gate volleyball and badminton accept an ITTF-only field their laws have no
  // concept of and then discard it. `records` exists to refuse exactly that
  // (see `SetBasedRecordFlags`), and the expedite EVENT is already gated;
  // the field has to be too or the preset principle only half holds.
  // `serving` is deliberately NOT gated: which side served is a fact every
  // set-based scoresheet carries — only the return count is table tennis's.
  //
  // S6/#416 (W5) review (cfg-replay.conformance.test.ts §3.3) — STRICT ONLY.
  // `recordsExpedite` is now READ FROM CFG (`state.cfg.records.expedite`,
  // the beach-volleyball fix), so — exactly like `NestedInterruptionRules`'s
  // count/seconds and the period kernel's `periodSeconds` — a refusal built
  // from it must never fire on REPLAY: cfg is read live and the whole stream
  // refolds from `init` on every read, so an organiser's later config edit
  // would otherwise brick an already-recorded rally that legally carried
  // `returns` when it was written.
  if (preset.strict && payload.returns !== undefined && !preset.recordsExpedite) {
    invalid(`"${preset.key}" has no expedite system, so a rally cannot carry \`returns\``);
  }
  const side = sideOf(state, payload.wonBy);
  // Validate the serving side even where the rule does not bite, so a typo'd
  // entrant id is caught on the rally that carries it rather than on whichever
  // later rally happens to reach thirteen returns.
  if (payload.serving !== undefined) sideOf(state, payload.serving);
  const expediteUnchecked = checkExpedite(state, payload, side);

  const persons = creditPersons(state.persons, [
    [payload.scorer, "points"],
    [payload.server, "serves"],
  ]);
  let next =
    persons === state.persons && expediteUnchecked === state.expediteUnchecked
      ? state
      : {
          ...state,
          ...(persons === undefined ? {} : { persons }),
          ...(expediteUnchecked === undefined ? {} : { expediteUnchecked }),
        };
  let open = openSet(next);
  if (open === null) {
    next = { ...next, sets: [...next.sets, { home: 0, away: 0, closed: false }] };
    // We just appended an open set, so openSet cannot return null here. The
    // assertion is load-bearing: `open` is declared `… | null`, so without it
    // the reads below do not narrow. no-unnecessary-type-assertion judges the
    // assertion against the DECLARED type of the assignment target rather than
    // the narrowing it establishes, and so reports a false positive — its
    // autofix breaks tsc here.
    // eslint-disable-next-line @typescript-eslint/no-unnecessary-type-assertion
    open = openSet(next) as { set: SetState; index: number };
  }
  const scored: SetState = { ...open.set, [side]: open.set[side] + 1 };
  const target = setTarget(next.cfg, open.index);
  const winner = setWinner(scored.home, scored.away, target, next.cfg.winBy, next.cfg.cap);
  next = replaceSet(next, open.index, scored);
  return winner === null ? next : bankSet(next, open.index, winner);
}

// Resolves either summary shape to positional home/away.
function normalizeSummary(
  state: SetBasedState,
  payload: SetBasedSummary,
): { home: number; away: number; partial: boolean } {
  if ("by" in payload) {
    const side = sideOf(state, payload.by);
    const home = side === "home" ? payload.forBy : payload.forOpp;
    const away = side === "home" ? payload.forOpp : payload.forBy;
    return { home, away, partial: payload.partial === true };
  }
  return { home: payload.home, away: payload.away, partial: payload.partial === true };
}

function applySummary(
  state: SetBasedState,
  payload: SetBasedSummary,
  strict: boolean,
): SetBasedState {
  if (state.phase !== "live") wrongPhase(`set summary not allowed in phase "${state.phase}"`);
  const params = state.cfg;
  const { home, away, partial } = normalizeSummary(state, payload);

  if (partial) {
    // In-progress snapshot: create/refresh an open set; must not already be
    // terminal (a finished set arrives as a non-partial summary).
    const open = openSet(state);
    const index = open?.index ?? state.sets.length;
    const target = setTarget(params, index);
    // STRICT ONLY (§3.3 seam), for the same reason as the two checks below the
    // completed-set branch: "is this score already a finished set?" is built
    // from `setTo`, `finalSetTo`, `winBy` and `cap` — all cfg. Lower any of them
    // and a snapshot the ledger already holds becomes a completed score, so
    // every read of that fixture refuses an event there is nothing to void. On
    // replay the snapshot is banked as recorded: an open set that happens to
    // read as complete under today's config stays open, and the rally or
    // summary that actually closed it still closes it.
    if (strict && setWinner(home, away, target, params.winBy, params.cap) !== null) {
      invalid("a partial set summary must not be a completed set score", { home, away });
    }
    if (open === null) {
      return { ...state, sets: [...state.sets, { home, away, closed: false }] };
    }
    if (home < open.set.home || away < open.set.away) {
      invalid("a partial set summary may not decrease the score");
    }
    return replaceSet(state, index, { ...open.set, home, away });
  }

  // Completed-set summary: no rally set may be mid-flight (dual fidelity is
  // per-set, not per-point).
  const open = openSet(state);
  // STRICT ONLY (§3.3 seam). "Is a set in flight?" is a PROJECTION of cfg: lower
  // `setTo` and rallies that used to close a set no longer do, so a set the
  // ledger scored rally-by-rally and then summarised reads as still open on
  // replay and every summary in the division is refused. The dual-fidelity rule
  // it enforces — do not mix point-by-point and summary scoring for one set —
  // is about what a scorer may ENTER, and stays exactly as strict there.
  if (strict && open !== null && (open.set.home > 0 || open.set.away > 0)) {
    invalid("this set is being scored rally-by-rally — a set summary is not allowed for it");
  }
  const index = open === null ? state.sets.length : open.index;
  const target = setTarget(params, index);
  const winner = setWinner(home, away, target, params.winBy, params.cap);
  // STRICT ONLY (§3.3 seam). The set predicate is built from `setTo`,
  // `finalSetTo`, `winBy` and `cap` — all cfg — so lowering any of them makes
  // every set summary already in the ledger "unreachable" and every fixture in
  // the division unreadable, with no event to void. 21–19 was a real set when
  // it was played; it is not the ledger's fault the competition later moved to
  // 15. On replay the summary is banked as recorded: `winner` is null only when
  // neither side meets the target, and the higher score then takes the set,
  // which is the reading a scoresheet has always had.
  if (strict && (winner === null || !reachableSetScore(home, away, target, params.winBy, params.cap))) {
    invalid("set summary is not a reachable final score under the set predicate", {
      home,
      away,
      target,
      winBy: params.winBy,
      cap: params.cap,
    });
  }
  const set: SetState = { home, away, closed: false };
  const withSet =
    open === null ? { ...state, sets: [...state.sets, set] } : replaceSet(state, index, set);
  // `winner` is non-null on every strict path (the guard above proves it) and
  // may be null only on replay, where the higher score takes the set.
  return bankSet(withSet, index, winner ?? (home >= away ? "home" : "away"));
}

// ---------------------------------------------------------------------------
// W4 (#407) — scoresheet interruptions. None of them touches the set ledger,
// so they are legal at any live moment and leave the score exactly as it was.
// ---------------------------------------------------------------------------

function applyTimeout(state: SetBasedState, payload: SetBasedTimeout): SetBasedState {
  if (state.phase !== "live") wrongPhase(`timeout not allowed in phase "${state.phase}"`);
  const side = sideOf(state, payload.by);
  const timeouts = state.timeouts ?? { home: 0, away: 0 };
  return { ...state, timeouts: { ...timeouts, [side]: timeouts[side] + 1 } };
}

function applySanction(state: SetBasedState, payload: SetBasedSanction): SetBasedState {
  if (state.phase !== "live") wrongPhase(`sanction not allowed in phase "${state.phase}"`);
  const record: SetBasedSanctionRec = {
    by: sideOf(state, payload.by),
    level: payload.level,
    ...(payload.person === undefined ? {} : { person: payload.person }),
  };
  return { ...state, sanctions: [...(state.sanctions ?? []), record] };
}

function applySub(state: SetBasedState, payload: SetBasedSub): SetBasedState {
  if (state.phase !== "live") wrongPhase(`substitution not allowed in phase "${state.phase}"`);
  const side = sideOf(state, payload.by);
  const subs = state.subs ?? { home: 0, away: 0, thisSet: { home: 0, away: 0 }, log: [] };
  const record: SetBasedSubRec = {
    by: side,
    ...(payload.off === undefined ? {} : { off: payload.off }),
    ...(payload.on === undefined ? {} : { on: payload.on }),
  };
  return {
    ...state,
    subs: {
      ...subs,
      [side]: subs[side] + 1,
      thisSet: { ...subs.thisSet, [side]: subs.thisSet[side] + 1 },
      log: [...subs.log, record],
    },
  };
}

// W4a (#425) §5.3 — the umpire introduced expedite (ITTF 2.15.1). It touches
// no score; it changes how every subsequent rally is judged, for the rest of
// the MATCH (2.15.4). `bankSet` closing a game leaves `expedite` alone, which
// is the whole point of holding it here rather than on the open set.
function applyExpedite(state: SetBasedState): SetBasedState {
  if (state.phase !== "live") wrongPhase(`expedite not allowed in phase "${state.phase}"`);
  if (state.expedite === true) {
    invalid(
      "expedite is already in force — ITTF 2.15.4 runs it to the end of the match, so there is " +
        "nothing a second introduction could scope",
    );
  }
  return { ...state, expedite: true };
}

// Forfeit — spec 04 §3 / volleyball.md §7: award the match to the opponent;
// completed sets already stand in the ledger.
function applyForfeit(state: SetBasedState, by: string, reason: string): SetBasedState {
  if (state.phase === "done" || state.phase === "final" || state.phase === "abandoned") {
    wrongPhase("match already over");
  }
  const winnerSide = opponent(sideOf(state, by));
  return {
    ...state,
    phase: "done",
    outcome: { kind: "award", winner: state.entrants[winnerSide], method: reason },
  };
}

// Abandon — leave the fixture undecided and flagged for regeneration (mirrors
// football's replay policy; a gym closure is re-scheduled, not awarded).
function applyAbandon(state: SetBasedState): SetBasedState {
  if (state.phase === "done" || state.phase === "final" || state.phase === "abandoned") {
    wrongPhase("match already over");
  }
  return { ...state, phase: "abandoned", replayFlagged: true };
}

// ---------------------------------------------------------------------------
// R5-1 (owner ruling, R5 dispatch) — THE SERVE-CONTEXT READER (v3/09 defect
// D-17: the pad rendered "—" for who is serving, on all three sports).
//
// WHY IT LIVES HERE AND NOT IN THE PAD. Three skins each deriving the BWF /
// ITTF / FIVB service rules is the placer-vs-verifier fork this engine keeps
// paying for, and the public scoreboard needs the same answer as the pad. One
// reader, over the fold the whole product already reads.
//
// WHY IT ADDS NO STATE AND NO EVENT. Serving is a pure function of the ledger
// once ONE datum is known — who served the first rally — and that datum
// already has a home: `SetBasedRally.serving`, the optional field expedite
// enforcement was given (see its own doc comment). So there is no new event
// type (§9), no payload change, no new State key (a State key would red the
// frozen tabletennis corpus, whose expedite rallies already carry `serving`)
// and no new cfg key (a cfg key reds golden.ts's config-COVERAGE gate, which
// can only be closed from `src/testkit/golden.ts`). The rules ride on the
// PRESET, which is compile-time and in no corpus at all.
//
// THE RULES ARE DECLARED, NEVER KEYED ON THE SPORT. `if (key === "badminton")`
// anywhere below would be the same defect in a new place; every branch here
// reads `SetBasedServeRotation`, which each preset states for itself.
// ---------------------------------------------------------------------------

/**
 * Who serves the next rally INSIDE a set.
 *
 *  * `rally-winner` — side-out: the winner of a rally serves the next one
 *    (BWF Law 10.3, FIVB 12.2.2). The consequence worth knowing is that the
 *    ledger answers this by itself from the second rally of a set onwards —
 *    a declaration is only ever needed for the first.
 *  * `fixed-turns` — the serve changes hands after a fixed number of rallies
 *    whoever wins them (ITTF 2.13.3), so it is a function of the SCORE and
 *    the set's first server, and nothing else.
 */
export type SetBasedServeWithin = "rally-winner" | "fixed-turns";

/**
 * Who serves first in a set after the first one.
 *
 *  * `set-winner` — the side that won the previous set (BWF Law 7.6).
 *  * `alternate` — the sides take the first serve in turn (ITTF 2.13.6;
 *    FIVB 12.1.2 for sets 2–4 — 7.1 is the TOSS, a different rule).
 */
export type SetBasedSetStart = "set-winner" | "alternate";

/**
 * Why the reader will not name a server. Present exactly when
 * `serveOrderKnown` is false, and never otherwise — a pad renders nothing and
 * ASKS, so it needs to know which question to ask.
 */
export type SetBasedServeUnknown =
  /** Nothing in the ledger has ever said who served, and the laws do not make
   *  it derivable here (the first rally of the match; a `fixed-turns` set
   *  whose opener was never established). */
  | "undeclared"
  /** The match is over. Nobody serves next. */
  | "match-over"
  /** A partial set summary moved the score without naming the rallies that
   *  moved it, and under side-out the rally winners ARE the rotation. */
  | "score-jumped"
  /** R4-7 drift detector: a rally declared a serving side that the fold's own
   *  rotation contradicts. Two derivations of one fact disagree, so the answer
   *  is unknown — neither is patched to match the other. */
  | "recorded-disagrees"
  /** The ledger handed in does not fold to the state handed in. */
  | "ledger-mismatch"
  /** The deciding set's first service comes from the TOSS (FIVB 12.1.1, the
   *  toss itself being 7.1), so the alternation does not carry into it. */
  | "deciding-set-toss"
  /** `setStart: "alternate"` only. The next set opens with the OPPONENT of
   *  this set's first server, so the alternation rests on `firstServer` — and
   *  a `recorded-disagrees` inside the set disputes that very derivation.
   *  Distinct from `recorded-disagrees` because the new set is not itself in
   *  contradiction: its first declared serve re-anchors it, and under side-out
   *  its first rally names the side again. */
  | "alternation-disputed";

/**
 * The service rules of ONE federation, declared by the preset that plays them.
 *
 * REQUIRED on `SetBasedPreset`, and required for the same reason
 * `sanctionLevels` is: a sport added to this kernel must state its own answer
 * rather than silently inherit the FIVB's. The three shipped answers disagree
 * on every field that has one.
 */
export interface SetBasedServeRotation {
  readonly within: SetBasedServeWithin;
  /** `fixed-turns` only — rallies per service turn (ITTF 2.13.3: two). */
  readonly turnLength?: number;
  /** `fixed-turns` only — ITTF 2.13.3's deuce clause: once BOTH sides reach
   *  one short of the
   *  target ("10-all"), the serve changes after every rally. Derived from
   *  `setTo`/`finalSetTo`, so the hardbat-21 variant accelerates at 20-all
   *  without declaring anything extra. */
  readonly acceleratesAtDeuce?: boolean;
  readonly setStart: SetBasedSetStart;
  /** FIVB 12.1.1 — the deciding set's first service is the toss's (7.1), so
   *  the alternation stops
   *  there and the reader reports `deciding-set-toss` until the ledger says
   *  who served. */
  readonly decidingSetTossed?: boolean;
  /**
   * The side's service turns run down the team sheet's declared pair order
   * (ITTF 2.13.4 doubles; FIVB Beach 13.2). Absent means the laws pick the
   * server from facts this kernel does not fold — BWF Law 11 reads the
   * SERVICE COURT the players happen to be standing in, and FIVB 7.6 reads a
   * six-position court rotation — so no person is named at all.
   */
  readonly serverFromPairOrder?: boolean;
  /** Squad roles this federation forbids from serving (FIVB 19.3.2.4 — a
   *  libero may not serve). Matched against `SquadMember.roles`. */
  readonly nonServingRoles?: readonly string[];
  /** Positions in the court rotation (FIVB 7.6.2: six). Reported only where
   *  the side actually has that many players on court, so a pair never gets a
   *  six-position rotation number. */
  readonly rotationCycle?: number;
  /**
   * How to tell a side has `rotationCycle` players on court when the fold kept
   * NO squad — which is the ordinary case, not a corner one. A team sheet
   * survives into State only where it declares something the pre-wave lineup
   * model could not hold (`sports/squad-state.ts`: a `pairOrder` or a
   * non-`player` role), and the sheet a referee actually files — six
   * starters and their positions — declares neither. So `state.squads` is
   * absent on an ordinary indoor fixture, and gating the rotation on it left
   * the number dark on all of them.
   *
   * Names a `cfg.records` flag that separates the codes playing under this one
   * preset, because a preset field cannot vary per variant (the S6/#416
   * lesson, and why `records` lives in cfg at all): FIVB indoor has a bench
   * and records substitutions, the beach pair has neither (FIVB Beach §7).
   * A squad, WHERE THE FOLD KEPT ONE, still wins — a declared pair is a pair
   * whatever the flag says. Unstated means an unknown count stays unknown.
   */
  readonly rotationImpliedBy?: keyof SetBasedRecordFlags;
}

/** What the reader needs off a module: its key (for the event type strings it
 *  already builds the same way) and the rules it plays. */
export interface SetBasedServeSource {
  readonly key: string;
  readonly coarseEventType: "set.summary" | "game.summary";
  readonly serveRotation: SetBasedServeRotation;
}

/**
 * Who is serving, as far as the ledger can say.
 *
 * INVARIANT: `serveOrderKnown === (servingSide !== null)`, and
 * `unknownBecause` is present exactly when it is false. A caller draws the
 * indicator when it is true and draws NOTHING (and asks) when it is false —
 * never a placeholder glyph standing in for a fact.
 *
 * The optional fields are narrower still: they need the set's whole service
 * chain, from its first rally, and are simply ABSENT when it has a hole in it.
 * An omitted fact beats an authoritative-looking wrong one.
 */
export interface SetBasedServeContext {
  /** The entrant id due to serve the NEXT rally. */
  servingSide: string | null;
  /** The same answer as a side label, for a caller that renders home/away. */
  side: Side | null;
  /** The person due to serve, where the laws make one derivable and the team
   *  sheet declared the order. `null` is the normal answer for singles, for an
   *  undeclared order, and for every badminton and indoor-volleyball fixture. */
  serverPersonId: string | null;
  serveOrderKnown: boolean;
  /** This side's own 0-based service-turn index within the current set. */
  serviceTurn?: number;
  /** `fixed-turns` only: which serve of the current turn comes next, 1-based. */
  serveNumber?: number;
  /** The serving side's rotation number, 1-based against the lineup it started
   *  the set with (FIVB 7.6.2). */
  rotation?: number;
  unknownBecause?: SetBasedServeUnknown;
}

/**
 * The turn a point belongs to, 0-based, under `fixed-turns`.
 *
 * `accelerateFrom` is the point count from which every rally is its own
 * service turn — 10-all (ITTF 2.13.3) or the moment expedite came into force
 * (2.15.3), whichever comes first. Points before it are grouped `turnLength`
 * at a time; the turn in flight when acceleration begins is CUT SHORT, which
 * is what `Math.ceil` says here and a `Math.floor` would not.
 */
function serveTurnIndexOf(points: number, turnLength: number, accelerateFrom: number): number {
  if (points < accelerateFrom) return Math.floor(points / turnLength);
  return Math.ceil(accelerateFrom / turnLength) + (points - accelerateFrom);
}

/** The point count at which service turn `turn` began — the inverse of
 *  `serveTurnIndexOf`, and the only thing `serveNumber` needs. */
function servePointsAtTurnStart(turn: number, turnLength: number, accelerateFrom: number): number {
  const pivot = Math.ceil(accelerateFrom / turnLength);
  return turn < pivot ? turn * turnLength : accelerateFrom + (turn - pivot);
}

/** A pair is two people. `expectedPairServerOf` cycles `turn % order.length`,
 *  so handing it a six-long "order" off an indoor volleyball sheet would
 *  produce a six-cycle that is not the FIVB rotation and name the wrong
 *  player with complete confidence — the exact failure R4's own code review
 *  found in `pairOrderOf` (defect 2). Size is checked, not assumed. */
const SERVE_PAIR_SIZE = 2;

interface ServeWalk {
  /** Who serves the next rally, or null when the ledger cannot say. */
  serving: Side | null;
  /** Who opened the set in progress — kept even across a drift, because the
   *  set-transition rules read it and a within-set contradiction is not
   *  evidence against it. */
  firstServer: Side | null;
  /** Set-scoped. `turns[side]` counts the service turns that side has STARTED,
   *  so its current 0-based index is one less. */
  turns: { home: number; away: number };
  /** Set-scoped: times this side has taken the serve FROM the opponent, which
   *  is what FIVB 7.6.2 rotates on. */
  gains: { home: number; away: number };
  /** Non-null when this set's chain has a hole in it: the side may still be
   *  known, but turn counts, the server person and the rotation are not. */
  chainBroken: SetBasedServeUnknown | null;
  /** Points played in the set in progress. */
  points: number;
  /** `serveTurnIndexOf`'s third argument for the set in progress. */
  accelerateFrom: number;
  /** Does the ledger handed in actually fold to the state handed in? */
  ledgerAgrees: boolean;
}

/**
 * Replays the ledger through THE REAL `applyRally`/`applySummary`/`bankSet`
 * and tracks the serve alongside it.
 *
 * Never a parallel reimplementation of the set predicate — the same rule
 * `setBasedMatchOutcomesFold` above follows, and for the same reason: a second
 * derivation of "did that close a set?" drifts from the fold silently, and the
 * whole point of this reader is not to be a second source of truth.
 *
 * Total and never throws: every refusal is a returned value — INCLUDING a
 * malformed or dangling `core.void`. That was aspirational until this pass:
 * every `applyRally`/`applySummary`/`applyExpedite` call below was already
 * wrapped to flip `ledgerAgrees` on a catch, but the `resolveVoids(events)`
 * that FEEDS the loop was not, so a bad void reached the caller as a thrown
 * `INVALID_EVENT` (core/events.ts) instead of a refused value. That matters
 * here specifically because a v3 skin reads this walk synchronously during
 * render with no try/catch of its own — the throw reached
 * `ScoringErrorBoundary` rather than degrading like every other failure in
 * this function already does. Wrapped the same way as the rest of them now.
 */
function setBasedServeWalk(
  source: SetBasedServeSource,
  state: SetBasedState,
  events: readonly EventEnvelope[],
): ServeWalk {
  const rotation = source.serveRotation;
  const cfg = state.cfg;
  const turnLength = Math.max(1, Math.trunc(rotation.turnLength ?? 1));
  const rallyType = `${source.key}.rally`;
  const summaryType = `${source.key}.${source.coarseEventType}`;
  const expediteType = `${source.key}.expedite.start`;

  const sideFor = (id: unknown): Side | null =>
    id === state.entrants.home ? "home" : id === state.entrants.away ? "away" : null;

  let replay = setBasedReplayState(cfg, state.entrants.home, state.entrants.away);
  let ledgerAgrees = true;
  let firstServer: Side | null = null;
  let serving: Side | null = null;
  let turns = { home: 0, away: 0 };
  let gains = { home: 0, away: 0 };
  let expediteFrom: number | null = null;
  let chainBroken: SetBasedServeUnknown | null = "undeclared";

  const setIndexNow = (): number => openSet(replay)?.index ?? replay.sets.length;
  const pointsNow = (): number => {
    const open = openSet(replay);
    return open === null ? 0 : open.set.home + open.set.away;
  };
  const closedCount = (): number => replay.sets.filter((set) => set.closed).length;
  // ITTF 2.13.3's deuce clause and 2.15.3 are the same mechanic — one rally
  // per turn — with two different triggers, so the reader takes whichever
  // bites first.
  const accelerateFromNow = (): number => {
    const deuce = rotation.acceleratesAtDeuce === true
      ? 2 * (setTarget(cfg, setIndexNow()) - 1)
      : Number.POSITIVE_INFINITY;
    return Math.min(deuce, expediteFrom ?? Number.POSITIVE_INFINITY);
  };

  // Who we believe is about to serve, given `points` already played this set.
  // `fixed-turns` derives it from the score every time (so a summary that
  // jumps the score costs it nothing); side-out carries it forward from the
  // last rally winner.
  const believedServer = (points: number): Side | null => {
    if (chainBroken === "recorded-disagrees") return null;
    if (rotation.within !== "fixed-turns") return serving;
    if (firstServer === null) return null;
    const turn = serveTurnIndexOf(points, turnLength, accelerateFromNow());
    return turn % 2 === 0 ? firstServer : opponent(firstServer);
  };

  const startSet = (opener: Side | null, why: SetBasedServeUnknown): void => {
    firstServer = opener;
    serving = opener;
    turns = { home: 0, away: 0 };
    gains = { home: 0, away: 0 };
    if (opener !== null) turns[opener] = 1;
    // Expedite runs to the end of the MATCH (ITTF 2.15.4), so a set that opens
    // with it already in force is one-rally-per-turn from its very first point.
    expediteFrom = replay.expedite === true ? 0 : null;
    chainBroken = opener === null ? why : null;
  };

  /** A set just closed: who opens the next one, per the declared rule. */
  const openNextSet = (): void => {
    const closed = closedCount();
    const justClosed = replay.sets[closed - 1];
    const wonBy: Side | null =
      justClosed === undefined ? null : justClosed.home > justClosed.away ? "home" : "away";
    const previousOpener = firstServer;
    // FIVB 12.1.1 — the deciding set's first service comes from the TOSS
    // (7.1), so the alternation stops at its door rather than carrying
    // through it.
    if (rotation.decidingSetTossed === true && closed === cfg.bestOf - 1) {
      startSet(null, "deciding-set-toss");
      return;
    }
    if (rotation.setStart === "set-winner") {
      // BWF Law 7.6 — the next game reads the game SCORE, which a contradiction
      // inside the game does not touch. So this branch alternates off nothing
      // and re-anchors cleanly however broken the set it follows was.
      startSet(wonBy, "undeclared");
      return;
    }
    // ITTF 2.13.6 / FIVB 12.1.2 — the next set opens with the OPPONENT OF THIS
    // SET'S FIRST SERVER. That is `firstServer`, the derivation an R4-7
    // contradiction disputes, so alternating off it would answer the next set
    // with full confidence from a fact the ledger has already contradicted.
    // Refuse instead, and let the new set re-anchor from its own evidence.
    if (chainBroken === "recorded-disagrees") {
      startSet(null, "alternation-disputed");
      return;
    }
    startSet(previousOpener === null ? null : opponent(previousOpener), "undeclared");
  };

  // See the doc comment above: `resolveVoids` throws on a malformed or
  // dangling void, and this function must degrade instead, exactly like
  // every `applyRally`/`applySummary`/`applyExpedite` call below already
  // does on its own catch.
  let resolvedEvents: readonly EventEnvelope[];
  try {
    resolvedEvents = resolveVoids(events);
  } catch {
    ledgerAgrees = false;
    resolvedEvents = [];
  }

  for (const event of resolvedEvents) {
    if (!ledgerAgrees) break;

    if (event.type === expediteType) {
      try {
        replay = applyExpedite(replay);
      } catch {
        ledgerAgrees = false;
        break;
      }
      expediteFrom = pointsNow();
      continue;
    }

    if (event.type === rallyType) {
      const parsed = SetBasedRally.safeParse(event.payload);
      if (!parsed.success) {
        ledgerAgrees = false;
        break;
      }
      const payload = parsed.data;
      const winner = sideFor(payload.wonBy);
      if (winner === null) {
        ledgerAgrees = false;
        break;
      }
      const before = pointsNow();
      const believed = believedServer(before);
      if (payload.serving !== undefined) {
        const declared = sideFor(payload.serving);
        if (declared === null) {
          ledgerAgrees = false;
          break;
        }
        if (believed === null) {
          // THE ANCHOR. A gap may be filled by a declaration; a CONTRADICTION
          // may not, which is why a set already flagged `recorded-disagrees`
          // is not re-anchored here — that would be patching one derivation to
          // match the other, the thing R4-7 exists to forbid.
          if (chainBroken !== "recorded-disagrees") {
            if (rotation.within === "fixed-turns") {
              // The score says which turn this rally is; the declaration says
              // who is serving it; together they name the set's opener — and
              // with the opener known, every other turn in the set is a pure
              // function of the score, so the chain is whole again even when
              // the declaration arrives in the middle of one.
              const turn = serveTurnIndexOf(before, turnLength, accelerateFromNow());
              firstServer = turn % 2 === 0 ? declared : opponent(declared);
              chainBroken = null;
            } else {
              serving = declared;
              if (before === 0) {
                firstServer = declared;
                turns = { home: 0, away: 0 };
                gains = { home: 0, away: 0 };
                turns[declared] = 1;
                chainBroken = null;
              }
            }
          }
        } else if (declared !== believed) {
          // R4-7. Narrow on purpose: the rest of THIS set is unknown, and a
          // guard that killed the indicator for the rest of the MATCH would be
          // D-24 all over again. How the next set re-anchors depends on which
          // rule it starts under, and the two are not alike:
          //   * `set-winner` (BWF Law 7.6) reads the set SCORE — a fact this
          //     contradiction does not touch, so the next set is untouched;
          //   * `alternate` (ITTF 2.13.6, FIVB 12.1.2) reads `firstServer`,
          //     which IS what this disputes, so `openNextSet` refuses to
          //     alternate off it and opens `alternation-disputed` instead.
          // Nothing type-checks a comment, so that split is a test
          // ("refuses to alternate off a DISPUTED opener"), on both sports.
          chainBroken = "recorded-disagrees";
          serving = null;
        }
      }

      const closedBefore = closedCount();
      try {
        replay = applyRally(replay, payload, {
          key: source.key,
          recordsExpedite: cfg.records.expedite,
          strict: false,
        });
      } catch {
        ledgerAgrees = false;
        break;
      }
      if (rotation.within === "rally-winner" && chainBroken !== "recorded-disagrees") {
        if (serving !== null && winner !== serving) {
          gains[winner] += 1;
          turns[winner] += 1;
        }
        // Side-out: the winner of the rally serves the next one, which holds
        // whether or not we knew who served THIS one.
        serving = winner;
      }
      if (closedCount() > closedBefore) openNextSet();
      continue;
    }

    if (event.type === summaryType) {
      const parsed = SetBasedSummary.safeParse(event.payload);
      if (!parsed.success) {
        ledgerAgrees = false;
        break;
      }
      const before = pointsNow();
      const closedBefore = closedCount();
      try {
        replay = applySummary(replay, parsed.data, false);
      } catch {
        ledgerAgrees = false;
        break;
      }
      if (closedCount() > closedBefore) {
        openNextSet();
        continue;
      }
      // A partial snapshot moved the score without naming the rallies that
      // moved it. Under side-out the rally winners ARE the rotation, so the
      // chain has a hole; under `fixed-turns` the score is the whole input and
      // nothing is lost. Narrow both ways, and both directions are tested.
      if (rotation.within === "rally-winner" && pointsNow() !== before) {
        if (chainBroken === null) chainBroken = "score-jumped";
        serving = null;
      }
      continue;
    }
  }

  const points = pointsNow();
  const accelerateFrom = accelerateFromNow();
  const serverNow = believedServer(points);
  const agrees =
    ledgerAgrees &&
    replay.sets.length === state.sets.length &&
    replay.setsWon.home === state.setsWon.home &&
    replay.setsWon.away === state.setsWon.away &&
    replay.sets.every((set, i) => {
      const mirror = state.sets[i];
      return (
        mirror !== undefined &&
        set.home === mirror.home &&
        set.away === mirror.away &&
        set.closed === mirror.closed
      );
    });

  return {
    serving: serverNow,
    firstServer,
    turns,
    gains,
    chainBroken,
    points,
    accelerateFrom,
    ledgerAgrees: agrees,
  };
}

/**
 * Does this side field the `rotationCycle` players FIVB 7.6.2 numbers?
 *
 * The rotation NUMBER itself is pure ledger — the side-outs this side has
 * taken — so nothing here gates the arithmetic; the only question is whether a
 * six-position rotation applies to this side at all. The squad answers it
 * where the fold kept one, and where it did not the preset's
 * `rotationImpliedBy` cfg flag stands in for it (see its doc comment).
 */
function sideFieldsTheRotation(
  source: SetBasedServeSource,
  state: SetBasedState,
  side: Side,
): boolean {
  const { rotationCycle: cycle, rotationImpliedBy: implied } = source.serveRotation;
  if (cycle === undefined) return false;
  const squad = state.squads?.[side];
  // A beach pair plays the same side-out rules under the same preset and has
  // no six-position rotation to number, so a declared squad is SIZED, never
  // assumed.
  if (squad !== undefined) return onFieldPersons(squad).length === cycle;
  return implied !== undefined && state.cfg.records[implied] === true;
}

/**
 * WHO IS SERVING — the reader D-17 was open for.
 *
 * A pure reader over the ledger and the folded state, with no fold effect: it
 * mutates nothing, `init`/`apply` never call it, and it adds not one byte to
 * any serialised state.
 *
 * TWO DRIFT DETECTORS, both R4-7 shaped — compare two derivations and report
 * unknown when they disagree, rather than patching either:
 *
 *  1. a rally's own recorded `serving` against the rotation the fold implies;
 *  2. the set ledger this walk replays against the `state` handed in, so a
 *     truncated or foreign ledger reports `ledger-mismatch` instead of naming
 *     a confidently wrong side.
 */
export function setBasedServeContext(
  source: SetBasedServeSource,
  state: SetBasedState,
  events: readonly EventEnvelope[],
): SetBasedServeContext {
  const unknown = (why: SetBasedServeUnknown): SetBasedServeContext => ({
    servingSide: null,
    side: null,
    serverPersonId: null,
    serveOrderKnown: false,
    unknownBecause: why,
  });

  // "pre" is deliberately NOT here: a fixture that has not started still has a
  // first server to declare, and the pad wants to ask for it.
  if (state.phase === "done" || state.phase === "final" || state.phase === "abandoned") {
    return unknown("match-over");
  }

  const walk = setBasedServeWalk(source, state, events);
  if (!walk.ledgerAgrees) return unknown("ledger-mismatch");
  const side = walk.serving;
  if (side === null) return unknown(walk.chainBroken ?? "undeclared");

  const rotation = source.serveRotation;
  const turnLength = Math.max(1, Math.trunc(rotation.turnLength ?? 1));
  const chainComplete = walk.chainBroken === null;

  let serviceTurn: number | undefined;
  let serveNumber: number | undefined;
  if (chainComplete) {
    if (rotation.within === "fixed-turns") {
      const turn = serveTurnIndexOf(walk.points, turnLength, walk.accelerateFrom);
      serviceTurn = Math.floor(turn / 2);
      serveNumber =
        walk.points - servePointsAtTurnStart(turn, turnLength, walk.accelerateFrom) + 1;
    } else {
      serviceTurn = walk.turns[side] - 1;
    }
  }

  let rotationNumber: number | undefined;
  const cycle = rotation.rotationCycle;
  if (cycle !== undefined && chainComplete && sideFieldsTheRotation(source, state, side)) {
    rotationNumber = (walk.gains[side] % cycle) + 1;
  }

  let serverPersonId: string | null = null;
  if (rotation.serverFromPairOrder === true && serviceTurn !== undefined) {
    const order = state.squads === undefined ? [] : pairOrderOf(state.squads[side]);
    if (order.length === SERVE_PAIR_SIZE) {
      const candidate = expectedDoublesServer(state, side, serviceTurn);
      const forbidden = rotation.nonServingRoles ?? [];
      const member =
        candidate === null || state.squads === undefined
          ? undefined
          : memberOf(state.squads[side], candidate);
      // FIVB 19.3.2.4 — a libero may not serve. Refuse to NAME them; the side
      // is still serving and still reported, because the side is not in doubt.
      const barred =
        forbidden.length > 0 && (member?.roles ?? []).some((role) => forbidden.includes(role));
      serverPersonId = barred ? null : candidate;
    }
  }

  return {
    servingSide: state.entrants[side],
    side,
    serverPersonId,
    serveOrderKnown: true,
    ...(serviceTurn === undefined ? {} : { serviceTurn }),
    ...(serveNumber === undefined ? {} : { serveNumber }),
    ...(rotationNumber === undefined ? {} : { rotation: rotationNumber }),
  };
}

// ---------------------------------------------------------------------------
// Generator helper — a reachable completed-set score for the given target.
// ---------------------------------------------------------------------------

function generateSetScore(
  target: number,
  winBy: number,
  cap: number | null,
  rng: Rng,
): [hi: number, lo: number] {
  // ~25% deuce/cap endings, else a clean win to the target.
  if (rng() < 0.25) {
    const ceiling = cap ?? target + winBy + 4;
    // Winner lands on hi with the loser winBy behind, or exactly at the cap.
    let hi = target + 1 + Math.floor(rng() * Math.max(1, ceiling - target - 1));
    if (cap !== null && rng() < 0.4) hi = cap;
    hi = Math.min(hi, cap ?? hi);
    const lo = cap !== null && hi === cap ? hi - 1 : hi - winBy;
    if (reachableSetScore(hi, lo, target, winBy, cap)) return [hi, Math.max(0, lo)];
  }
  const lo = Math.floor(rng() * Math.max(1, target - winBy + 1));
  return [target, lo];
}

// ---------------------------------------------------------------------------
// Preset wiring — the parts that differ between the three sports
// ---------------------------------------------------------------------------

export interface SetBasedPreset {
  key: string; // 'volleyball' | 'badminton' | 'tabletennis'
  version: string;
  defaults: SetBasedParams; // shipped variant (also what coarsen segments under)
  variants: Record<string, Partial<SetBasedParams>>;
  positions: PositionCatalog;
  // Metric labels differ (Sets vs Games); keys stay set_ratio/point_ratio so the
  // shared comparator registry (PROMPT-08) resolves them uniformly.
  unitLabel: { one: string; many: string };
  defaultTiebreakers: TiebreakerKey[];
  officialLabel: { scorer: string };
  coarseEventType: "set.summary" | "game.summary";
  /**
   * S7/#427 — which steps of the shared `SetBasedSanctionLevel` ladder THIS
   * federation's umpire can actually award, in the enum's own order. Read by
   * `setBasedPadSpec` for the sanction action's enum bounds and by nothing
   * else.
   *
   * REQUIRED, not optional with a full-ladder default, and that is the whole
   * point: a sport added to this kernel must state its own card ladder rather
   * than silently inherit the FIVB's. The three shipped answers are all
   * different questions, not variations on one — badminton's black card IS
   * `disqualification` (BWF Law 16), table tennis has no third card at all
   * (`expulsion`/`disqualification` are the REFEREE removing a player, not
   * the umpire's ladder — DOMAIN.tabletennis.md:36), and volleyball uses the
   * FIVB four verbatim.
   *
   * SCOPE: this bounds THE PAD ONLY. `eventSchema` keeps the full union (a
   * referee removal that was recorded must still parse, and narrowing it
   * would move frozen goldens), `arbitraryEvent` keeps generating all four,
   * and `discipline.colors` keeps projecting all four.
   */
  sanctionLevels: readonly SetBasedSanctionLevel[];
  /**
   * R5-1 — the service rules THIS federation plays (`SetBasedServeRotation`).
   *
   * REQUIRED, for the same reason `sanctionLevels` above is: the three sports
   * on this kernel disagree on every field of it, so a kernel default would be
   * right for at most one of them and silently wrong for the others. It is a
   * PRESET field rather than a cfg one deliberately — cfg is serialised into
   * every frozen state and a new cfg key reds golden.ts's config-coverage gate,
   * which cannot be closed from inside `src/sports/**`.
   */
  serve: SetBasedServeRotation;
  entrantModel?: EntrantModel;
  // W4 (#407) — which interruptions THIS sport's scoresheet carries. A sport
  // that does not declare one refuses the event outright rather than silently
  // recording a fact its laws have no concept of (badminton has no timeouts
  // and no substitutions; only indoor volleyball substitutes).
  // W4a (#425) §5.3 — `expedite` is table tennis's alone (ITTF Law 2.15);
  // volleyball and badminton have no such rule, so the kernel refuses
  // `<key>.expedite.start` for them exactly as it refuses `badminton.timeout`
  // — and, because `returns` rides on the SHARED rally payload rather than a
  // sport-specific one, `applyRally` refuses that field for them too.
  //
  // S6/#416 (W5) — MOVED into `defaults.records` / a variant's own
  // `records` override (see `SetBasedRecordFlags`). Was a sibling field here,
  // read once at module-construction time — which is the beach-volleyball
  // regression (beach could never differ from indoor). No field here any
  // more; every preset now supplies `records` inside `defaults`, and a
  // variant that needs a different answer (only `beach` does, today)
  // restates the whole object in its own `variants[name].records`.
  playerStats?: PlayerStatsModel; // Jul3/07 §3 — unlocked by person attribution
  /**
   * S3/W4b (#426) owner ruling 2 — what this competition permits a lineup to
   * do. A FUNCTION OF CFG, and on this kernel the per-sport answers are as far
   * apart as they get: FIVB indoor is `once` PLUS a position lock (15.6),
   * while ITTF and BWF have no substitution at all and so no return either. A
   * kernel constant would be right for at most one of the three.
   *
   * Omitted ⇒ `DEFAULT_LINEUP_POLICY`.
   */
  lineupPolicy?: (cfg: SetBasedCfg) => LineupPolicy;
}

function makeMetrics(unit: { one: string; many: string }): MetricSpec[] {
  // doc 09 §2: the public table shows sets won/lost plus the cascade-derived
  // set/point ratios (engine competition/display.ts); raw point tallies are
  // ledger-only ratio operands.
  return [
    { key: "sets_won", label: `${unit.many} won`, direction: "desc" },
    { key: "sets_lost", label: `${unit.many} lost`, direction: "asc" },
    { key: "points_won", label: "Points won", direction: "desc", display: false },
    { key: "points_lost", label: "Points lost", direction: "asc", display: false },
  ];
}

// ---------------------------------------------------------------------------
// S6/#416 (W5) — padSpec. Pure function of (preset, resolved cfg). One
// builder shared by volleyball/badminton/tabletennis — the same "kernel owns
// the logic, presets add data" split every other per-sport hook on this
// factory already uses (discipline, arbitraryEvent…).
//
// `eventSchemas` is built separately, in `makeSetBasedModule` below, and is
// DELIBERATELY the same 6 branches (Rally/Summary/Timeout/Sanction/Sub/
// ExpediteStart) for all three sports, regardless of what THIS preset's
// `records` says — because `eventSchema` itself (`SetBasedEv`, top of this
// file) is ALSO the same shared 6-branch union for all three, by design
// (golden.ts calls this the "KERNEL-UNION" class and already carries a
// parallel exemption list, `UNREACHABLE_FIELDS`, for the fields that ride on
// a branch a given sport can never reach — e.g. `badminton.timeout`'s
// `technical`). `padSpecConformanceSuite`'s bijection check (a) is therefore
// against the FULL union, not the sport's own recordable subset: narrowing
// `eventSchemas` to "only what THIS preset records" would break bijection
// for every sport on this kernel, every time, structurally — the fix would
// have to narrow `eventSchema` itself, which is out of scope this session
// (it feeds `schema-snapshot.ts` and `golden.ts`'s optional-field walk, and
// nothing recorded ever needed the wider shape narrowed).
//
// The CONSEQUENCE for padSpec: a branch this preset's `records` says it
// cannot record (e.g. `badminton.timeout`, `volleyball.expedite.start`,
// `tabletennis.sub`) is registered in `eventSchemas` (bijection needs it) but
// gets NO action, ever, for ANY cfg of that sport — permanently, not merely
// for the cfg under test. This is NOT the cfg-mutual-exclusivity case
// `checkActionCoverage`'s own doc comment describes (cricket's superOver vs
// 2-innings, where EVERY branch is reachable from SOME legal cfg): here a
// branch is unreachable from ALL of a sport's cfgs. `checkActionCoverage` is
// therefore called (setbased/padspec.test.ts) only for volleyball, where
// indoor/beach genuinely disagree on `substitutions` — the real
// mutual-exclusivity case — and explicitly NOT for badminton/tabletennis,
// which have none.
// ---------------------------------------------------------------------------

/** cfg-derived plausibility bound for a schema-unbounded score field
 *  (`SetBasedSummary.home`/`.away` are `z.number().int().nonnegative()` with
 *  no upper bound at all) — the same sentinel pattern cricket's padSpec uses
 *  for `cricket.innings.summary.runs`. Capped sports (badminton) use the cap
 *  itself; uncapped ones (volleyball, table tennis) get a margin past the
 *  target generous enough for any plausible deuce ending. */
function summaryScoreBound(cfg: SetBasedCfg): number {
  return cfg.cap ?? Math.max(cfg.setTo, cfg.finalSetTo) + 20;
}

const RALLY_ATTRIBUTION: PadAttribution = [{ kind: "side", path: "wonBy" }];

/**
 * S7/#427 — was a module-level constant; it is now a function of the sport
 * key, because the two person prompts finally carry label keys and a label
 * key is per-sport (one flat dictionary namespace across all eleven modules,
 * so a shared `pad.setbased.*` key would force the FIVB's wording onto the
 * BWF's and ITTF's pads). All three dossiers list `rally.server` and
 * `rally.scorer` as owed prompts for exactly the reason they need copy: they
 * are adjacent person pickers that are NOT interchangeable — `server` is the
 * player who served (it feeds the `serves` tally), `scorer` the player
 * credited with the terminating kill/block/ace/winner.
 */
function rallyAttributedAttribution(key: string): PadAttribution {
  return [
    { kind: "side", path: "wonBy" },
    {
      kind: "person",
      path: "server",
      labelKey: { key: `pad.${key}.action.rallyAttributed.field.server`, label: "Server" },
    },
    {
      kind: "person",
      path: "scorer",
      labelKey: { key: `pad.${key}.action.rallyAttributed.field.scorer`, label: "Point scored by" },
    },
  ];
}

function setBasedPadSpec(preset: SetBasedPreset, cfg: SetBasedCfg): PadSpec {
  const key = preset.key;
  const rallyType = `${key}.rally`;
  const summaryType = `${key}.${preset.coarseEventType}`;
  const timeoutType = `${key}.timeout`;
  const sanctionType = `${key}.sanction`;
  const subType = `${key}.sub`;
  const expediteType = `${key}.expedite.start`;
  const scoreBound = summaryScoreBound(cfg);

  const rallyAction: PadAction = {
    type: rallyType,
    labelKey: { key: `pad.${key}.action.rally`, label: "Rally" },
    fields: [],
    attribution: RALLY_ATTRIBUTION,
  };
  const rallyAttributedAction: PadAction = {
    type: rallyType,
    labelKey: { key: `pad.${key}.action.rallyAttributed`, label: "Rally (server / scorer)" },
    fields: [],
    attribution: rallyAttributedAttribution(key),
  };
  const summaryAction: PadAction = {
    type: summaryType,
    labelKey: { key: `pad.${key}.action.setScore`, label: "Set score" },
    fields: [
      { kind: "number", path: "home", min: 0, max: scoreBound },
      { kind: "number", path: "away", min: 0, max: scoreBound },
      { kind: "toggle", path: "partial" },
    ],
    attribution: [],
  };
  const timeoutAction: PadAction = {
    type: timeoutType,
    labelKey: { key: `pad.${key}.action.timeout`, label: "Timeout" },
    fields: [{ kind: "toggle", path: "technical" }],
    attribution: [{ kind: "side", path: "by" }],
  };
  const sanctionAction: PadAction = {
    type: sanctionType,
    labelKey: { key: `pad.${key}.action.sanction`, label: "Sanction" },
    // S7/#427 — PER SPORT, not the whole kernel union: the ITTF umpire has
    // two cards and the BWF three, so offering all four steps on both pads
    // put a sanction on screen the federation has no concept of. See
    // `SetBasedPreset.sanctionLevels`.
    fields: [{ kind: "enum", path: "level", values: preset.sanctionLevels }],
    attribution: [
      { kind: "side", path: "by" },
      { kind: "person", path: "person" },
    ],
  };
  const subAction: PadAction = {
    type: subType,
    labelKey: { key: `pad.${key}.action.sub`, label: "Substitution" },
    fields: [],
    attribution: [
      { kind: "side", path: "by" },
      { kind: "person", path: "off" },
      { kind: "person", path: "on" },
    ],
  };
  const expediteStartAction: PadAction = {
    type: expediteType,
    labelKey: { key: `pad.${key}.action.expediteStart`, label: "Start expedite" },
    fields: [],
    attribution: [],
  };
  // ITTF Law 2.15.2 rally variant: the receiver's good-return count, and which
  // side is serving (`serving`, never `server` — see SetBasedRally's own doc
  // comment on the trap of confusing the two).
  const rallyExpediteAction: PadAction = {
    type: rallyType,
    labelKey: { key: `pad.${key}.action.rallyExpedite`, label: "Rally (expedite)" },
    fields: [{ kind: "number", path: "returns", min: 0, max: EXPEDITE_RETURNS * 3 }],
    attribution: [
      { kind: "side", path: "wonBy" },
      { kind: "side", path: "serving" },
    ],
  };

  const panels: PadPanel[] = [
    {
      labelKey: { key: `pad.${key}.panel.rally`, label: "Rally" },
      phase: "live",
      layout: "primary",
      actions: [rallyAction, rallyAttributedAction],
    },
    {
      labelKey: { key: `pad.${key}.panel.setScore`, label: "Set score" },
      phase: "live",
      layout: "grid",
      actions: [summaryAction],
    },
    // Cfg-only inclusion (mirrors cricket's DLS/super-over panels): a sport
    // that does not record a given interruption simply never builds the
    // panel for it — no gate needed, since `padSpec(cfg)` is already pure in
    // cfg (module.ts's own note on `PadGate`).
    ...(cfg.records.timeouts
      ? [
          {
            labelKey: { key: `pad.${key}.panel.timeouts`, label: "Timeouts" },
            phase: "live" as const,
            layout: "drawer" as const,
            actions: [timeoutAction],
          },
        ]
      : []),
    ...(cfg.records.sanctions
      ? [
          {
            labelKey: { key: `pad.${key}.panel.sanctions`, label: "Sanctions" },
            phase: "live" as const,
            layout: "drawer" as const,
            actions: [sanctionAction],
          },
        ]
      : []),
    // S6/#416 (W5) variant-reshaping proof: present for indoor, absent for
    // beach (`cfg.records.substitutions`) — the beach-fix regression test's
    // padSpec analogue.
    ...(cfg.records.substitutions
      ? [
          {
            labelKey: { key: `pad.${key}.panel.subs`, label: "Substitutions" },
            phase: "live" as const,
            layout: "drawer" as const,
            actions: [subAction],
          },
        ]
      : []),
    ...(cfg.records.expedite
      ? [
          {
            labelKey: { key: `pad.${key}.panel.expedite`, label: "Expedite" },
            phase: "live" as const,
            layout: "drawer" as const,
            actions: [expediteStartAction],
            // Runtime gate: hide once already in force (ITTF 2.15.4 runs it
            // to the end of the match — a second declaration only errors).
            gate: { op: "not", of: { op: "path-truthy", path: "state.expedite" } } satisfies PadGate,
          },
          {
            labelKey: { key: `pad.${key}.panel.expediteRally`, label: "Expedite scoring" },
            phase: "live" as const,
            layout: "drawer" as const,
            actions: [rallyExpediteAction],
            // Reachable, not merely configured (mirrors cricket's super-over
            // panel): the format allows expedite, but it only actually
            // applies once the match has reached it.
            gate: { op: "path-truthy", path: "state.expedite" } satisfies PadGate,
          },
        ]
      : []),
  ];

  return {
    panels,
    // One band per REGISTERED type (all 6, per the module-level note above) —
    // not merely the ones this cfg happens to build an action for. Modelled
    // on cricket: the bare result alone (band 0) already reaches a decided
    // match (a set-based match is decided by `bankSet` off summaries alone);
    // administrative/incident records (timeout, sanction, sub, expedite —
    // none of which touches the score) sit at band 1, the same band cricket
    // gives its own admin events (toss, interruption, review, powerplay);
    // rally-by-rally scoring is the maximum-granularity record for this
    // kernel, band 3. Band 2 is genuinely unoccupied for this kernel today —
    // there is no player-line/box-score analogue — which is honest, not a
    // gap: S2/#430 parked exactly this (per-event rally-length / 1st-vs-2nd
    // -serve detail) as future T3-lane work, not this session's.
    fidelity: {
      [summaryType]: 0,
      [timeoutType]: 1,
      [sanctionType]: 1,
      [subType]: 1,
      [expediteType]: 1,
      [rallyType]: 3,
    } satisfies Record<string, FidelityBand>,
  };
}

// ---------------------------------------------------------------------------
// Module factory
// ---------------------------------------------------------------------------


/**
 * W4a (#425) T6b — "Set 3 · 21–19". Module scope, so badminton, table tennis
 * and volleyball hold the SAME reference; `position.conformance.test.ts`
 * asserts that by identity, the way `phases.test.ts` asserts `playPhases`.
 *
 * THE SET NUMBER IS THE COMPLETED COUNT THROUGH `currentUnit`, not
 * `state.sets.length`. `sets` holds the closed sets AND a trailing open one, so
 * the two agree while a set is in progress and disagree in the two places that
 * matter: between sets, where `sets.length` under-counts by one, and after the
 * match is decided, where `closed + 1` names a set nobody played.
 *
 * The score comes from `sets[n - 1]` — the set this resolved to — which makes
 * every case fall out of one expression: love-all before the first rally, the
 * live score during a set, love-all again between sets, and the final score of
 * the deciding set once the match is over.
 *
 * `home + away` is an exact rank here in a way it is not in tennis: every rally
 * scores a point, so it counts rallies played and orders two positions inside
 * one set.
 */
function setBasedPosition(state: SetBasedState): MatchPosition {
  const number = unitNumber({
    // A set is opened LAZILY, on its first rally, so `sets.length` counts sets
    // STARTED and under-counts by one between sets — while `closed + 1`
    // over-counts by one on a match abandoned mid-set. `unitNumber` is the max.
    started: state.sets.length,
    completed: state.sets.filter((set) => set.closed).length,
    live: state.outcome === null,
  });
  const set = state.sets[number - 1];
  const home = set?.home ?? 0;
  const away = set?.away ?? 0;
  return {
    segments: [
      unitSegment("set", "Set", number),
      scoreSegment("points", `${home}–${away}`, home + away),
    ],
  };
}


// ---------------------------------------------------------------------------
// S8/#417 — kernel-level default playerStats. Every metric a preset declares
// today names an OPTIONAL person field (`scorer`, `server`); a v1-era stream
// that only ever names the REQUIRED `wonBy` entrant folds those to zero
// credit (the "requires_detailed_scoring" posture DOMAIN.<sport>.md already
// documents). This default is what closes that gap, unconditionally, for
// every sport on this kernel — see `mergePlayerStats` for how it coexists
// with each preset's own declared metrics.
// ---------------------------------------------------------------------------

/**
 * `points_won` — the canonical entrant-fallback metric (owner ruling,
 * S8/#417): an explicit `scorer` still wins whenever one resolves (giving
 * this key the SAME numbers a preset's own scorer-keyed metric already
 * reports, e.g. volleyball's `points`), and `wonBy` rescues a stream that
 * never named one at all. The duplication against a preset's own metric on a
 * fully-attributed stream is intentional, not an oversight: `points_won` is
 * the one key that ALSO answers for a v1-era stream, which a preset's own
 * metric (no `fromEntrant`) structurally never will.
 */
function setBasedPointsWonMetric(rallyType: string): PlayerStatMetric {
  return {
    key: "points_won",
    label: "Points won",
    from: rallyType,
    field: "scorer",
    entrantField: "wonBy",
    fromEntrant: true,
    agg: "count",
  };
}

/**
 * A throwaway two-sided state, seeded directly into "live" — never returned,
 * never adopted by a real fixture, alive only for the length of one
 * `folded.fold` call below. `idX`/`idY` are POSITIONS, not "home"/"away" in
 * any real sense: `folded.fold` never sees the real `SetBasedState`, only the
 * raw ledger + `ctx`, and `ctx.entrants` (docstring: "which entrants exist
 * THIS fixture") is unordered — there is no true home/away to recover here,
 * only two ids to keep the real `applyRally`/`applySummary`/`bankSet`
 * cascade's home/away bookkeeping happy. Every credit `setBasedMatchOutcomesFold`
 * reads back is keyed by ENTRANT ID, never by the "home"/"away" label, so the
 * arbitrary assignment cannot misattribute anything.
 */
function setBasedReplayState(cfg: SetBasedCfg, idX: string, idY: string): SetBasedState {
  return {
    cfg,
    entrants: { home: idX, away: idY },
    phase: "live",
    sets: [],
    setsWon: { home: 0, away: 0 },
    outcome: null,
    replayFlagged: false,
  };
}

/**
 * `folded.fold` for match/set-level outcomes (`matches`, `sets_won`,
 * `sets_lost`) — a metric+field walk fires once per qualifying EVENT and
 * cannot express "how many sets did this entrant end up winning", which is
 * exactly why `PlayerStatsModel.folded` exists (see its own docstring).
 *
 * REPLAYS the real `applyRally`/`applySummary`/`bankSet` — never a parallel
 * reimplementation of the set predicate, which this engine has watched
 * silently drift from the real fold before. A raw rally stream carries no
 * explicit "set closed" marker (unlike a coarse summary), so detecting a set
 * boundary from `wonBy` alone needs the same `setTo`/`finalSetTo`/`winBy`/
 * `cap` the real fold checks against — which lives in `ctx.cfg`, the field
 * `stats.ts` itself declares "reserved for a future metric that needs
 * division config" and never reads. This is that metric.
 *
 * NEVER THROWS (house rule: no throw on a cfg- or data-derived condition
 * inside a fold — this engine has bricked a recorded fixture that way
 * before). `ctx.cfg` absent or failing to parse against THIS preset's own
 * `configSchema`, or the replay itself raising for any reason (a stray event
 * a synthetic two-entrant state cannot express, e.g. a rally after the
 * synthetic match is already "done"), degrades to `matches`-only for the
 * rest of the ledger rather than throwing — a refusal is a returned value,
 * not an exception, the same rule `checkExpedite`/`applyInterruption` follow
 * elsewhere in this file.
 *
 * `matches` needs no cfg at all: it is credited the moment EITHER entrant's
 * event TYPE (a rally or a set summary) appears anywhere in the ledger —
 * both sides of a fixture that was scored at all "played" it, independent of
 * whether either one specifically won a point (see the shutout note below).
 *
 * Positional summaries (`{home, away}`, no entrant id) cannot bank a set
 * here: attributing one needs a true home/away label this function never has
 * (see `setBasedReplayState`'s own doc comment). A real, narrow gap:
 * `coarsen()` itself never emits that shape (only `arbitraryEvent`'s direct
 * coarse path does), and the loss is only ever of the set/match tally, never
 * of `points_won`, which credits every rally regardless of summary shape.
 *
 * The SHUT-OUT case — an entrant that never wins a single rally in the whole
 * ledger — is why `idX`/`idY` come from `ctx.entrants` rather than from ids
 * OBSERVED in the stream: a rally-only ledger where one side is blanked
 * every set never names that entrant anywhere at all, so without
 * `ctx.entrants` there would be no opponent to credit `sets_lost` to.
 */
function setBasedMatchOutcomesFold(
  preset: SetBasedPreset,
  configSchema: ReturnType<typeof makeConfigSchema>,
): NonNullable<PlayerStatsModel["folded"]> {
  const rallyType = `${preset.key}.rally`;
  const summaryType = `${preset.key}.${preset.coarseEventType}`;
  return {
    // S8/#417 W6 review — `sets_won`/`sets_lost` borrow this preset's OWN
    // `unitLabel` (the same one `makeMetrics` above uses for the standings
    // columns of the very same fact), not a hardcoded "Sets": badminton and
    // table tennis call this unit a "Game" everywhere else in their own
    // product surface, so a player-profile row reading "Sets won" would
    // silently disagree with their own standings table. `matches` needs no
    // such split — a match is a match in every sport on this kernel.
    keys: [
      { key: "matches", label: "Matches" },
      { key: "sets_won", label: `${preset.unitLabel.many} won` },
      { key: "sets_lost", label: `${preset.unitLabel.many} lost` },
    ],
    fold(events: readonly EventEnvelope[], ctx: PlayerStatsFoldCtx): PlayerStatRow[] {
      if (ctx.entrants.length !== 2) return []; // this kernel is always 2-sided; nothing safe to pair
      const idX = ctx.entrants[0]!.id;
      const idY = ctx.entrants[1]!.id;
      // S8/#417 W6 fix 5 — the shared kind guard, not a local re-derivation.
      const personsFor = (entrantId: string): readonly string[] => personsForEntrant(ctx, entrantId);

      const cfgParsed = configSchema.safeParse(ctx.cfg);
      let state: SetBasedState | undefined = cfgParsed.success
        ? setBasedReplayState(cfgParsed.data, idX, idY)
        : undefined;
      let played = false;

      for (const event of events) {
        if (event.type === rallyType) {
          played = true;
          if (state === undefined) continue;
          const wonBy = (event.payload as Record<string, unknown>).wonBy;
          if (typeof wonBy !== "string" || (wonBy !== idX && wonBy !== idY)) continue;
          try {
            state = applyRally(
              state,
              { wonBy },
              { key: preset.key, recordsExpedite: false, strict: false },
            );
          } catch {
            state = undefined;
          }
          continue;
        }
        if (event.type === summaryType) {
          played = true;
          if (state === undefined) continue;
          const payload = event.payload as Record<string, unknown>;
          const by = payload.by;
          // Positional shape (no `by`), or an id this fixture never
          // declared — cannot attribute a set boundary without a side label.
          if (typeof by !== "string" || (by !== idX && by !== idY)) continue;
          if (typeof payload.forBy !== "number" || typeof payload.forOpp !== "number") continue;
          try {
            state = applySummary(state, payload as SetBasedSummary, false);
          } catch {
            state = undefined;
          }
        }
      }

      const rows = new Map<string, Record<string, number>>();
      const bump = (personId: string, key: string, by: number) => {
        const stats = rows.get(personId) ?? {};
        stats[key] = (stats[key] ?? 0) + by;
        rows.set(personId, stats);
      };

      if (played) {
        for (const p of personsFor(idX)) bump(p, "matches", 1);
        for (const p of personsFor(idY)) bump(p, "matches", 1);
      }
      if (state !== undefined) {
        for (const p of personsFor(idX)) {
          bump(p, "sets_won", state.setsWon.home);
          bump(p, "sets_lost", state.setsWon.away);
        }
        for (const p of personsFor(idY)) {
          bump(p, "sets_won", state.setsWon.away);
          bump(p, "sets_lost", state.setsWon.home);
        }
      }

      return [...rows.entries()]
        .map(([personId, stats]) => ({ personId, stats }))
        .sort((a, b) => a.personId.localeCompare(b.personId));
    },
  };
}

/**
 * `folded.keys` union helper (S8/#417 W6 review) — dedupes a concatenated
 * `{key,label}[]` by `.key`, FIRST occurrence wins. Extracted rather than a
 * `[...new Set(...)]` one-liner because `Set` dedupes by value identity,
 * which stopped working the moment `keys` elements became objects instead of
 * plain strings (S8/#417 W6 changed `PlayerStatsModel.folded.keys`'s element
 * type — see `stats.ts`).
 */
function dedupeFoldedKeys(
  keys: readonly { key: string; label: string }[],
): { key: string; label: string }[] {
  const seen = new Map<string, string>();
  for (const k of keys) if (!seen.has(k.key)) seen.set(k.key, k.label);
  return [...seen].map(([key, label]) => ({ key, label }));
}

/**
 * Merges the kernel default with the preset's own declared model (S8/#417).
 * PRECEDENCE: a preset-declared metric key always beats a default of the
 * same key — a sport's hand-tuned metric must never be silently shadowed by
 * a generic fallback added after it. Today the two are disjoint by
 * construction (every metric the four presets on this kernel declare is
 * "points"/"serves"/"sanctions"[/…], never "points_won"/"matches"/
 * "sets_won"/"sets_lost"), so in practice this drops nothing — the rule
 * exists so a FUTURE preset cannot lose one of its own metrics to a default
 * it never asked for. `folded.fold` results are concatenated, never
 * clobbered: `aggregatePlayerStats` merges a folded row's stats into the
 * running per-person total by ADDITION, so two rows for one personId from
 * two different `fold` calls sum correctly rather than either one
 * overwriting the other. `folded.keys` is the union of both declarations.
 */
function mergePlayerStats(
  kernelDefault: PlayerStatsModel,
  preset: PlayerStatsModel | undefined,
): PlayerStatsModel {
  if (preset === undefined) return kernelDefault;
  const presetKeys = new Set(preset.metrics.map((m) => m.key));
  const metrics = [...kernelDefault.metrics.filter((m) => !presetKeys.has(m.key)), ...preset.metrics];
  const kFolded = kernelDefault.folded;
  const pFolded = preset.folded;
  const folded =
    kFolded === undefined
      ? pFolded
      : pFolded === undefined
        ? kFolded
        : {
            // S8/#417 W6 review — dedup by `.key`, kernel-default label wins
            // a same-named clash (first occurrence), matching
            // `labelPlayerStats`'s own first-declaration-wins precedence
            // elsewhere in this merge.
            keys: dedupeFoldedKeys([...kFolded.keys, ...pFolded.keys]),
            // S8/#417 W6 fix 4 — `lineups` forwarded to BOTH sides, not
            // dropped: this used to be a 2-arg `(events, ctx) => [...]`,
            // silently swallowing the 3rd argument `aggregatePlayerStats`
            // always passes. Dead today (no preset on this kernel declares
            // its own `folded`), but a future preset-declared fold needing
            // `lineups` (a keeper fold, say) would otherwise lose it
            // silently the moment it got merged with the kernel default.
            fold: (events: readonly EventEnvelope[], ctx: PlayerStatsFoldCtx, lineups?: LineupPair) => [
              ...kFolded.fold(events, ctx, lineups),
              ...pFolded.fold(events, ctx, lineups),
            ],
          };
  return {
    metrics,
    ...(preset.derived === undefined ? {} : { derived: preset.derived }),
    ...(preset.awards === undefined ? {} : { awards: preset.awards }),
    ...(folded === undefined ? {} : { folded }),
  };
}

/**
 * A set-based module, plus the two declarations `setBasedServeContext` reads
 * off it. An intersection rather than a change to `SportModule` (which this
 * kernel does not own), and structurally still a `SportModule`, so every
 * existing consumer is untouched.
 */
export type SetBasedModule = SportModule<SetBasedCfg, SetBasedEv, SetBasedState> &
  SetBasedServeSource;

export function makeSetBasedModule(preset: SetBasedPreset): SetBasedModule {
  const configSchema = makeConfigSchema(preset.defaults);
  const rallyType = `${preset.key}.rally`;
  const summaryType = `${preset.key}.${preset.coarseEventType}`;
  const timeoutType = `${preset.key}.timeout`;
  const sanctionType = `${preset.key}.sanction`;
  const subType = `${preset.key}.sub`;
  // Dotted like the period kernel's `<key>.suspension.start` — the `.start`
  // suffix is load-bearing shorthand for "there is no `.end`": expedite runs to
  // the end of the match (ITTF 2.15.4) and nothing ever stops it.
  const expediteType = `${preset.key}.expedite.start`;
  // S6/#416 (W5) — type string -> its own payload schema, by reference, the
  // SAME 6 schema objects `SetBasedEv` unions (top of this file). ALWAYS all
  // 6, regardless of this preset's `records` — see the module-level note
  // above `setBasedPadSpec` for why a narrower, per-preset registry cannot
  // satisfy `padSpecConformanceSuite`'s bijection check against the shared
  // `eventSchema`.
  const eventSchemas: Readonly<Record<string, z.ZodTypeAny>> = {
    [rallyType]: SetBasedRally,
    [summaryType]: SetBasedSummary,
    [timeoutType]: SetBasedTimeout,
    [sanctionType]: SetBasedSanction,
    [subType]: SetBasedSub,
    [expediteType]: SetBasedExpediteStart,
  };
  // S6/#416 (W5) — `records` moved from a preset-level (whole-module)
  // constant into `SetBasedCfg.records` (above), because `apply()` and
  // `arbitraryEvent` need a PER-FIXTURE answer (`state.cfg.records`, read
  // where each is called below) — the beach-volleyball regression was
  // exactly this: a module-level constant can never let `beach` and `indoor`
  // disagree on `substitutions`. `declaredRecords` here is deliberately the
  // STATIC declared-default answer, used only for `coarsen`'s pass-through
  // classification (which only ever sees events a real fixture's `apply()`
  // already accepted, so a superset costs it nothing — narrower-per-variant
  // precision is not needed there).
  const declaredRecords = preset.defaults.records;
  const coarsenParams = preset.defaults; // spec 04 §9.6 conformance runs at default cfg
  // One per module, so the init handshake it keys on cannot leak between the
  // three sports sharing this kernel (see `sports/squad-state.ts`).
  const squadAdopter = makeSquadAdopter<SetBasedState>();

  // W4 — the interruption types a stream from THIS MODULE may ever carry.
  // `coarsen` treats them as transparent, so they never split a rally set.
  // Shared with `arbitraryEvent`'s PER-FIXTURE computation below (same
  // formula, different `records` input — declared vs `state.cfg.records`).
  function extensionTypesFor(flags: SetBasedRecordFlags): string[] {
    return [
      ...(flags.timeouts ? [timeoutType] : []),
      ...(flags.sanctions ? [sanctionType] : []),
      ...(flags.substitutions ? [subType] : []),
      ...(flags.expedite ? [expediteType] : []),
    ];
  }
  const extensionTypes = extensionTypesFor(declaredRecords);
  const isExtensionType = (type: string): boolean => extensionTypes.includes(type);

  // W4 review item 7 — the sanction row reaches the shared discipline
  // projection. Volleyball, badminton and table tennis each folded a LOCAL
  // sanction record in this wave and none of the three shipped a
  // `discipline` descriptor, so a card that suspends a player in football was
  // invisible to the same usecase here.
  //
  // The LADDER stays the sport's own — FIVB's four steps are not the ITF's and
  // not football's colours; the dossiers record how each code's cards map onto
  // it. What has to be uniform is the PROJECTION, so W5 renders one control.
  const discipline: DisciplineModel | undefined =
    declaredRecords.sanctions
      ? {
          colors: SetBasedSanctionLevel.options.map((key) => ({
            key,
            label: key.replace(/_/g, " ").replace(/^./, (ch) => ch.toUpperCase()),
          })),
          extractCards(ledger): DisciplineCard[] {
            const cards: DisciplineCard[] = [];
            for (const ev of resolveVoids(ledger)) {
              if (ev.type !== sanctionType) continue;
              const parsed = SetBasedSanction.safeParse(ev.payload);
              if (!parsed.success) continue;
              const sanction = parsed.data;
              cards.push({
                ...(sanction.person === undefined ? {} : { personId: sanction.person }),
                entrantSide: sanction.by,
                // The ladder step IS the colour axis, exactly as the period
                // kernel projects its suspension CLASS keys.
                color: sanction.level,
                eventId: ev.id,
                // W4 review — the offence, when the official recorded one, the
                // way football and the period kernel already pass it. Absent
                // stays absent: an accumulation rule must be able to tell "no
                // offence recorded" from an offence named.
                ...(sanction.reason === undefined ? {} : { reason: sanction.reason }),
              });
            }
            return cards;
          },
        }
      : undefined;

  // Award/forfeit points = a clean-sweep win pair: "*" (or the first entry).
  const cleanSweepPair = (cfg: SetBasedCfg): PointsPair =>
    cfg.pointsMap["*"] ?? Object.values(cfg.pointsMap)[0] ?? [1, 0];

  // pointsMap lookup for a decided match: exact "W-L", else "*".
  const matchPoints = (cfg: SetBasedCfg, winnerSets: number, loserSets: number): PointsPair => {
    const exact = cfg.pointsMap[`${winnerSets}-${loserSets}`];
    if (exact !== undefined) return exact;
    const wildcard = cfg.pointsMap["*"];
    if (wildcard !== undefined) return wildcard;
    invalid(`no pointsMap entry for set score ${winnerSets}-${loserSets}`);
  };

  const sideMetrics = (state: SetBasedState, side: Side): Record<string, number> => ({
    sets_won: state.setsWon[side],
    sets_lost: state.setsWon[opponent(side)],
    points_won: totalPoints(state, side),
    points_lost: totalPoints(state, opponent(side)),
  });

  return {
    key: preset.key,
    version: preset.version,
    // R5-1 — read by `setBasedServeContext`, which builds this module's own
    // event type strings the same way the factory does, from `key`.
    coarseEventType: preset.coarseEventType,
    serveRotation: preset.serve,
    configSchema,
    eventSchema: SetBasedEv,
    eventSchemas,
    // R8/WS-B — `required` stamped ONCE here, from the SAME `eventSchemas`
    // registry already declared above (never hand-typed per action; see
    // module.ts's own doc comment).
    padSpec: (padCfg) => stampAttributionRequired(setBasedPadSpec(preset, padCfg), eventSchemas),
    positions: preset.positions,
    variants: preset.variants,
    ...(preset.entrantModel === undefined ? {} : { entrantModel: preset.entrantModel }),
    // S8/#417 — always populated: the kernel default (`points_won` +
    // matches/sets_won/sets_lost) merges with whatever this preset declares,
    // never merely spread when present. See `mergePlayerStats`.
    playerStats: mergePlayerStats(
      {
        metrics: [setBasedPointsWonMetric(rallyType)],
        folded: setBasedMatchOutcomesFold(preset, configSchema),
      },
      preset.playerStats,
    ),
    ...(discipline === undefined ? {} : { discipline }),

    // S3/W4b (#426) — the two halves of adopting `core/lineup.ts`.
    ...(preset.lineupPolicy === undefined ? {} : { lineupPolicy: preset.lineupPolicy }),
    onLineup: (state, squads) => squadAdopter.adopt(state, squads),

    init(cfg, lineups: LineupPair): SetBasedState {
      return squadAdopter.fresh({
        cfg,
        entrants: { home: lineups.home.entrantId, away: lineups.away.entrantId },
        phase: "pre",
        sets: [],
        setsWon: { home: 0, away: 0 },
        outcome: null,
        replayFlagged: false,
      });
    },

    apply(state, ev: EventEnvelope<SetBasedEv | CoreEv>, ctx): SetBasedState {
      const strict = isStrictFold(ctx);
      // S6/#416 (W5) — PER-FIXTURE, from the resolved cfg this state was
      // built from (never the declared/static `declaredRecords` above): this
      // is what lets `beach` refuse `volleyball.sub` while `indoor` accepts
      // it from the SAME shared module.
      //
      // review (cfg-replay.conformance.test.ts §3.3) — every refusal keyed
      // off `records` below is gated `strict &&`, for the SAME reason as
      // `applyRally`'s own `recordsExpedite` gate (see its doc comment): cfg
      // is read live and every read refolds the whole stream from `init`, so
      // an UNGATED refusal here would brick an already-recorded event the
      // moment an organiser's config edit flips a `records` flag — found by
      // that suite's generic mutation walk, which (correctly) does not know
      // "beach never had subs to begin with" and mutates the flag anyway.
      const records = state.cfg.records;
      switch (ev.type) {
        case "core.start":
          if (state.phase !== "pre") wrongPhase("already started");
          return { ...state, phase: "live" };
        case rallyType:
          return applyRally(state, parsePayload(SetBasedRally, ev.payload, ev.type), {
            key: preset.key,
            recordsExpedite: records.expedite,
            strict,
          });
        case summaryType:
          return applySummary(state, parsePayload(SetBasedSummary, ev.payload, ev.type), strict);
        case timeoutType:
          if (strict && !records.timeouts) {
            invalid(`"${preset.key}" does not record timeouts`);
          }
          return applyTimeout(state, parsePayload(SetBasedTimeout, ev.payload, ev.type));
        case sanctionType:
          if (strict && !records.sanctions) {
            invalid(`"${preset.key}" does not record sanctions`);
          }
          return applySanction(state, parsePayload(SetBasedSanction, ev.payload, ev.type));
        case subType:
          if (strict && !records.substitutions) {
            invalid(`"${preset.key}" does not record substitutions`);
          }
          return applySub(state, parsePayload(SetBasedSub, ev.payload, ev.type));
        case expediteType:
          if (strict && !records.expedite) {
            invalid(`"${preset.key}" has no expedite system`);
          }
          // Parsed for its own sake: the payload is empty and the strict schema
          // is what refuses a `game` key, i.e. the per-game scoping mistake.
          parsePayload(SetBasedExpediteStart, ev.payload, ev.type);
          return applyExpedite(state);
        case "core.forfeit":
          return applyForfeit(state, forfeitOf(ev.payload).by, forfeitOf(ev.payload).reason);
        case "core.abandon":
          return applyAbandon(state);
        case "core.finalize":
          if (state.outcome === null) wrongPhase("cannot finalize an undecided fixture");
          return { ...state, phase: "final" };
        case "core.note":
      case "core.award":
          return state;
        default:
          invalid(`unknown event type "${ev.type}"`);
      }
    },

    outcome: (state) => state.outcome,

    // W4a (#425) T6b — the cross-sport position axis (see `setBasedPosition`).
    position: setBasedPosition,

    // §9.5 — defined at every prefix; reads only the folded set ledger so
    // coarse and fine folds render identically (§9.6). The headline carries the
    // per-set points, racquet-scoreline style ("2 — 0 · 21–15, 21–18"): a
    // just-entered set summary must be visible in the top score (v3/09 §1a —
    // "chosen score not reflected in top score").
    summary(state): ScoreSummary {
      const points = { home: totalPoints(state, "home"), away: totalPoints(state, "away") };
      const closedSets = state.sets.filter((set) => set.closed);
      const setLine =
        closedSets.length === 0
          ? ""
          : ` · ${closedSets.map((set) => `${set.home}–${set.away}`).join(", ")}`;
      // While a set is mid-flight, surface its live points next to the set
      // tally ("1 — 0 · 21–15 (14–11)") so rally scoring is visible too.
      const open = openSet(state);
      const inSet = open === null ? "" : ` (${open.set.home}–${open.set.away})`;
      return {
        headline: `${state.setsWon.home} — ${state.setsWon.away}${setLine}${inSet}`,
        perSide: [
          { entrantId: state.entrants.home, line: `${state.setsWon.home}` },
          { entrantId: state.entrants.away, line: `${state.setsWon.away}` },
        ],
        detail: {
          sets: state.sets.map((set) => ({ home: set.home, away: set.away, closed: set.closed })),
          points,
          ...(state.replayFlagged ? { abandoned: true } : {}),
          // W4 — interruption counters survive coarsening (they pass straight
          // through it), so exposing them here keeps §9.6 coarse ≡ fine. Per-
          // PERSON tallies deliberately do NOT appear: coarsening collapses
          // rallies into set summaries and discards attribution, so a summary
          // that carried `persons` could never satisfy §9.6. They live in
          // state (and in the playerStats fold over the ledger) instead.
          // W4a §5.3 — expedite survives coarsening (it is an extension type,
          // passed straight through), so it can appear here without breaking
          // §9.6. `expediteUnchecked` cannot and deliberately does not.
          ...(state.expedite === undefined ? {} : { expedite: state.expedite }),
          ...(state.timeouts === undefined ? {} : { timeouts: state.timeouts }),
          ...(state.sanctions === undefined ? {} : { sanctions: state.sanctions }),
          ...(state.subs === undefined
            ? {}
            : { subs: { home: state.subs.home, away: state.subs.away, thisSet: state.subs.thisSet } }),
        },
      };
    },

    standingsDelta(outcome, cfg, _ctx, state): [StandingsDelta, StandingsDelta] {
      const build = (side: Side, w: number, l: number, pts: number): StandingsDelta => ({
        entrantId: state.entrants[side],
        played: 1,
        won: w,
        drawn: 0,
        lost: l,
        points: pts,
        metrics: sideMetrics(state, side),
      });

      switch (outcome.kind) {
        case "win": {
          const winnerSide = sideOf(state, outcome.winner);
          const [wp, lp] = matchPoints(
            cfg,
            state.setsWon[winnerSide],
            state.setsWon[opponent(winnerSide)],
          );
          const winner = build(winnerSide, 1, 0, wp);
          const loser = build(opponent(winnerSide), 0, 1, lp);
          return winnerSide === "home" ? [winner, loser] : [loser, winner];
        }
        case "award": {
          // Forfeit: clean-sweep pair to keep the total inside declaredPointsSets.
          const winnerSide = sideOf(state, outcome.winner);
          const [wp, lp] = cleanSweepPair(cfg);
          const winner = build(winnerSide, 1, 0, wp);
          const loser = build(opponent(winnerSide), 0, 1, lp);
          return winnerSide === "home" ? [winner, loser] : [loser, winner];
        }
        // Set-based sports always produce a winner (§3.3 supportsDraws = false);
        // abandon leaves the outcome null, so no draw/tie/no_result reaches here.
        default:
          invalid(`set-based module cannot rank outcome "${outcome.kind}"`);
      }
    },

    metrics: makeMetrics(preset.unitLabel),
    defaultTiebreakers: preset.defaultTiebreakers,

    supportsDraws(_cfg, _stage: StageKind) {
      return false;
    },

    // §9.3 — every decided fixture pays a pointsMap value-sum (award reuses the
    // clean-sweep pair, whose sum is already present).
    declaredPointsSets(cfg) {
      return [...new Set(Object.values(cfg.pointsMap).map(([w, l]) => w + l))];
    },

    matchPointsBounds(cfg) {
      const pairs = Object.values(cfg.pointsMap) as readonly (readonly [number, number])[];
      return boundsFrom(pairs.map((p) => p[0]), pairs.map((p) => p[1]));
    },

    officialLabel: preset.officialLabel,

    // spec 03 §6 — deterministic generator. Summary-dominant so best-of-N
    // matches decide within the conformance event budget; rally bursts exercise
    // the point-by-point path and coarsen (§9.6).
    arbitraryEvent(state, rng: Rng): ModuleEvent<SetBasedEv> | null {
      if (state.phase === "pre") return { type: "core.start", payload: {} };
      if (state.phase !== "live") return null;

      const randomEntrant = () => (rng() < 0.5 ? state.entrants.home : state.entrants.away);
      // W4 — the testkit's lineups are `${entrantId}-p{n}` (helpers.ts), so the
      // generator can name people the way a real pad would.
      const randomPerson = (entrantId: string) => `${entrantId}-p${1 + Math.floor(rng() * 3)}`;
      // S6/#416 (W5) — PER-FIXTURE, from `state.cfg.records`, never the
      // declared/static `extensionTypes` above: `beach` must never generate a
      // `volleyball.sub` it would then reject on its own `apply()` call two
      // lines below (`buildWalk` applies every event it generates
      // immediately — an illegal generated event throws DURING generation,
      // not during a later assertion).
      const liveExtensionTypes = extensionTypesFor(state.cfg.records);
      // Occasional interruptions, so conformance actually walks the new
      // branches (and §9.6 proves coarsen stays transparent to them).
      if (liveExtensionTypes.length > 0 && rng() < 0.05) {
        const by = randomEntrant();
        // Expedite is introduced ONCE per match (ITTF 2.15.4), so drop it from
        // the pool the moment it is in force — a second one is a rejected
        // event and the generator must only emit legal streams.
        const choices =
          state.expedite === true
            ? liveExtensionTypes.filter((type) => type !== expediteType)
            : liveExtensionTypes;
        const type = choices[Math.floor(rng() * choices.length)];
        if (type === expediteType) return { type, payload: {} };
        if (type === timeoutType) return { type, payload: { by, technical: rng() < 0.3 } };
        if (type === sanctionType) {
          const levels = SetBasedSanctionLevel.options;
          const level = levels[Math.floor(rng() * levels.length)] as (typeof levels)[number];
          return { type, payload: { by, level, person: randomPerson(by) } };
        }
        if (type === subType) {
          return { type, payload: { by, off: randomPerson(by), on: randomPerson(by) } };
        }
        // `choices` was emptied (expedite was this sport's only extension) —
        // fall through and rally instead.
      }
      // Half of all rallies carry attribution — the other half keep the coarse
      // (entrant-only) shape legal and exercised.
      const rallyPayload = (): SetBasedRally => {
        const wonBy = randomEntrant();
        const base: SetBasedRally =
          rng() < 0.5
            ? { wonBy }
            : { wonBy, server: randomPerson(randomEntrant()), scorer: randomPerson(wonBy) };
        // Under expedite, exercise the 13-return path — and only ever LEGALLY:
        // the receiver takes the point on the thirteenth, so the serving side
        // is by construction the side that did not win it (Law 2.15.2).
        if (state.expedite !== true || rng() < 0.5) return base;
        // W4a review — half of those omit `serving`, which is the UNENFORCEABLE
        // path (§5.3): the rally stands and the fold counts it in
        // `state.expediteUnchecked`. Generating it is what makes the summary
        // exclusion of that counter an ENFORCED claim rather than an asserted
        // one — coarsening discards `returns`, so the coarse fold cannot
        // reproduce the count, and §9.6 (which deep-compares `summary()`) goes
        // red the moment `expediteUnchecked` is exposed there. Without these
        // streams the counter is always `undefined` on both sides and the
        // exclusion reds nothing.
        if (rng() < 0.5) return { ...base, returns: EXPEDITE_RETURNS };
        const serving =
          wonBy === state.entrants.home ? state.entrants.away : state.entrants.home;
        return { ...base, serving, returns: EXPEDITE_RETURNS };
      };
      const open = openSet(state);
      if (open !== null) {
        // W4a follow-up — an in-progress SNAPSHOT of the set being rallied: the
        // umpire posts the score so far, and the set carries on. It is the one
        // shape `partial` has on the write path (everywhere else it comes from
        // `coarsen`), and it reads the OPEN SET rather than inventing numbers,
        // so it can never be a completed score and never decreases — legal
        // under any config, which is what keeps it off the §3.3 seam.
        // Both payload shapes are offered: the positional one coarsen must drop
        // (it has no lineup context) and the entrant-keyed one it can absorb.
        if (rng() < 0.06 && (open.set.home > 0 || open.set.away > 0)) {
          const { home, away } = open.set;
          return rng() < 0.5
            ? { type: summaryType, payload: { home, away, partial: true } }
            : {
                type: summaryType,
                payload: { by: state.entrants.home, forBy: home, forOpp: away, partial: true },
              };
        }
        // A rally set is mid-flight — keep rallying it to a finish.
        return { type: rallyType, payload: rallyPayload() };
      }
      const roll = rng();
      if (roll < 0.02) {
        return { type: "core.forfeit", payload: { by: randomEntrant(), reason: "walkover" } };
      }
      if (roll < 0.04) return { type: "core.abandon", payload: { reason: "venue closed" } };
      if (roll < 0.14) return { type: rallyType, payload: rallyPayload() };
      const target = setTarget(state.cfg, state.sets.length);
      const [hi, lo] = generateSetScore(target, state.cfg.winBy, state.cfg.cap, rng);
      const homeWins = rng() < 0.5;
      return {
        type: summaryType,
        payload: { home: homeWins ? hi : lo, away: homeWins ? lo : hi },
      };
    },

    // §9.6 — collapse a rally stream into per-set summaries. Completed sets emit
    // a non-partial entrant-keyed summary; a trailing open set emits a `partial`
    // snapshot. Segmentation is position-independent: it tracks the two entrant
    // ids in local slots and asks setWinner which slot won, so no lineup context
    // is needed. core/positional-summary events flush the open set, then pass
    // through. Uses the preset default params (coarsenParams; §9.6 runs at the
    // default cfg — the shipped variant).
    coarsen(events): ModuleEvent<SetBasedEv>[] {
      const out: ModuleEvent<SetBasedEv>[] = [];
      let setsPlayed = 0;
      // Local slot A = first id seen this set, B = the other.
      let idA: string | null = null;
      let idB: string | null = null;
      let a = 0;
      let b = 0;

      const resetSet = () => {
        idA = null;
        idB = null;
        a = 0;
        b = 0;
      };
      const flushPartial = () => {
        if (a === 0 && b === 0) return;
        // Slot A always fills first, so idA is set whenever any point exists.
        out.push({
          type: summaryType,
          payload: { by: idA as string, forBy: a, forOpp: b, partial: true },
        });
        resetSet();
      };

      for (const event of events) {
        if (event.type === rallyType) {
          const { wonBy } = event.payload as SetBasedRally;
          if (idA === null || wonBy === idA) {
            idA = wonBy;
            a += 1;
          } else {
            idB = wonBy;
            b += 1;
          }
          const target = setTarget(coarsenParams, setsPlayed);
          const winner = setWinner(a, b, target, coarsenParams.winBy, coarsenParams.cap);
          if (winner !== null) {
            const winnerId = (winner === "home" ? idA : idB) as string;
            out.push({
              type: summaryType,
              payload: {
                by: winnerId,
                forBy: winner === "home" ? a : b,
                forOpp: winner === "home" ? b : a,
              },
            });
            setsPlayed += 1;
            resetSet();
          }
          continue;
        }
        // A snapshot of the set being coarsened. The coarse stream may hold AT
        // MOST ONE partial per set: flushing our own rally-derived partial and
        // then passing this one through puts two in, and because the flush
        // restarts the count at zero the second reads as a DECREASE and the
        // coarse fold refuses the stream (§9.6).
        if (event.type === summaryType && (event.payload as { partial?: boolean }).partial === true) {
          const payload = event.payload as SetBasedSummary;
          if ("by" in payload) {
            // Entrant-keyed: ABSORBED, not dropped. `by` names one of the two
            // slots outright — no lineup context needed — so the snapshot
            // becomes the running count and any points it carries that were
            // never recorded rally-by-rally survive the coarsening.
            if (idA === null) {
              idA = payload.by;
              a = payload.forBy;
              b = payload.forOpp;
            } else if (payload.by === idA) {
              a = payload.forBy;
              b = payload.forOpp;
            } else {
              idB = payload.by;
              b = payload.forBy;
              a = payload.forOpp;
            }
            continue;
          }
          // Positional {home, away}: unresolvable here by design — coarsen
          // segments on entrant ids alone and never learns which slot is home.
          // Our own rally count is the record for a set we have been counting,
          // so drop the snapshot (coarsening is allowed to discard, and it
          // already discards `returns`); with nothing counted it is the only
          // reading of the set there is, so keep it.
          if (a !== 0 || b !== 0) continue;
          out.push({ type: event.type, payload: event.payload });
          continue;
        }
        // W4 — an interruption (timeout / sanction / substitution) is
        // TRANSPARENT: it neither scores nor ends a set, so flushing the open
        // set here would split one rally set into two coarse summaries and
        // break §9.6. Pass it through and keep counting the set.
        if (isExtensionType(event.type)) {
          out.push({ type: event.type, payload: event.payload });
          continue;
        }
        // Non-rally: flush the open set, then pass through. A completed
        // (non-partial) summary already occupies a set slot, so advance the set
        // index — otherwise a later rally set (e.g. the decider) would segment
        // under the wrong target (spec 04 §3.3).
        flushPartial();
        out.push({ type: event.type, payload: event.payload });
        if (event.type === summaryType && (event.payload as { partial?: boolean }).partial !== true) {
          setsPlayed += 1;
        }
      }
      flushPartial();
      return out;
    },
  };
}
