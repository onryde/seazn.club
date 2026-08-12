// Nested scoring kernel — v6/00 §2 + v6/01 §1 (ITF Rules of Tennis 2026).
// Three-level fold: points → games → sets, with deuce/advantage, no-ad
// deciding points, tie-break games (entry at tiebreakAt-all), advantage sets
// (tiebreakAt: null), match tie-breaks replacing the deciding set (App VI) and
// slam-style deciding-set tie-breaks to 10. The set-based kernel folds points
// straight into sets and cannot express the game layer (v6/00 §2 "why not
// extend"), so this kernel is separate; padel lands here later as a preset.
//
// No coarsen hook: a point stream carries serve state that per-set summaries
// cannot reconstruct, so §9.6 summary-equality would fail by construction.
// Dual fidelity is per-set instead: tier-0 `*.set_summary` events fold into
// the same set ledger the rally path banks (mirrors setbased summary mode).
import { z } from "zod";
import { EngineError } from "../../core/errors.ts";
import { isStrictFold, resolveVoids, type CoreEv, type EventEnvelope } from "../../core/events.ts";
import type { Rng } from "../../core/rng.ts";
import { DurationSeconds, GameTime, compareGameTime } from "../../core/time.ts";
import {
  currentUnit,
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
import type {
  FidelityBand,
  FidelityTier,
  ModuleEvent,
  PadAction,
  PadGate,
  PadPanel,
  PadSpec,
  SportModule,
  TiebreakerKey,
} from "../../sport/module.ts";
import type { EntrantModel } from "../../sport/entrant-model.ts";
import {
  personsForEntrant,
  type PlayerStatMetric,
  type PlayerStatRow,
  type PlayerStatsFoldCtx,
  type PlayerStatsModel,
} from "../../stats/stats.ts";
import { expectedPairServerOf, makeSquadAdopter } from "../squad-state.ts";
import type { LineupPolicy, SquadState } from "../../core/lineup.ts";

// ---------------------------------------------------------------------------
// Cfg — v6/00 §2
// ---------------------------------------------------------------------------

export interface NestedSetCfg {
  gamesTo: number;
  winBy: number;
  tiebreakAt: number | null; // null = advantage set (win by 2, open-ended)
  tiebreakTo: number;
}

// The deciding set (reached at ⌈bestOf/2⌉−1 sets all):
//  • "same" — identical to every other set;
//  • { matchTiebreakTo } — an ITF App VI match tie-break REPLACES the set
//    (first to 7/10, win by 2; the doubles norm);
//  • { tiebreakTo } — the set plays out normally but its tie-break game runs
//    to this target (the slam rule: 10-point TB at 6–6 in the decider).
//    v6/00 §2 lists only the first two; this third form is added so the
//    grand-slam preset matches the real rule instead of approximating it —
//    documented as a spec deviation in the PR.
export type NestedFinalSet =
  | "same"
  | { matchTiebreakTo: number }
  | { tiebreakTo: number };

// ---------------------------------------------------------------------------
// W4a (#425) §5.4 — interruptions: rain delay, medical timeout, toilet break,
// heat rule. The KIND lives here rather than beside the event because the cfg
// keys off it: an allowance is declared per kind.
// ---------------------------------------------------------------------------

export const NestedInterruptionKind = z.enum(["medical", "toilet", "heat", "other"]);
export type NestedInterruptionKind = z.infer<typeof NestedInterruptionKind>;

/**
 * What a competition allows for one kind of break. Both halves are optional and
 * they are enforced DIFFERENTLY, which is the rule (§5.4), not an oversight:
 *
 * - `count` bounds how many breaks of that kind one side may take in one set.
 *   The (N+1)th is RECORDED and flagged (`overCount`), not refused.
 * - `seconds` bounds how long one may run. An over-long break is RECORDED
 *   (`overran`) and stands. The engine cannot send the physio away, and
 *   rejecting the event would lose the only record that the overrun happened —
 *   which is precisely what an appeal needs.
 *
 * BOTH ARE RECORDED, NEVER REFUSED, and the count one is the correction (#425
 * review) of a fixture-bricking bug rather than a softening. §5.4 specified a
 * hard refusal for `count`, which is right for the moment the chair keys the
 * break in and wrong for every read afterwards: cfg is read live from
 * `division.config` and the whole stream replays from `init` on EVERY read
 * (state, score page, standings), so an organiser lowering `count` after the
 * fact makes an already-recorded fixture throw on every read — with no event to
 * void, and no scorer action that recovers it. There is no write-only seam
 * inside `apply` to hang the refusal on: the write path (`append-event.ts`)
 * validates by folding the whole stream through this same function.
 *
 * So nothing derived from cfg may throw here. The period kernel takes the same
 * decision for `periodSeconds` and states the reason in the same words: an
 * optional additive knob must not become something a later config edit can use
 * to make every already-scored fixture in the division unviewable. The engine
 * notes both verdicts; the umpire adjudicates.
 */
export const NestedInterruptionRules = z.strictObject({
  /** Max breaks of this kind ONE SIDE may take IN ONE SET. Exceeding it is
   *  recorded (`overCount`), never rejected. */
  count: z.number().int().nonnegative().optional(),
  /** Allowed length. Exceeding it is recorded (`overran`), never rejected. */
  seconds: DurationSeconds.optional(),
});
export type NestedInterruptionRules = z.infer<typeof NestedInterruptionRules>;

// Spelled out key by key rather than `z.record(NestedInterruptionKind, …)`,
// which in zod 4 makes an enum-keyed record EXHAUSTIVE — every kind would
// become required, and a cfg declaring one allowance would stop parsing.
export const NestedInterruptionCfg = z.strictObject({
  medical: NestedInterruptionRules.optional(),
  toilet: NestedInterruptionRules.optional(),
  heat: NestedInterruptionRules.optional(),
  other: NestedInterruptionRules.optional(),
});
export type NestedInterruptionCfg = z.infer<typeof NestedInterruptionCfg>;

export interface NestedParams {
  bestOf: number;
  set: NestedSetCfg;
  finalSet: NestedFinalSet;
  game: { noAd: boolean };
  tiebreak: { winBy: number };
  points: { win: number; loss: number }; // per-match league points
  // W4a (#425) §5.4 — per-kind break allowances. OPTIONAL WITH NO DEFAULT, and
  // that is a contract (§8): cfg is serialised into the frozen golden state
  // strings, so a default here — even `{}` — rewrites every recorded stream.
  // Absent means the competition declares no allowance, and every break stands.
  interruptions?: NestedInterruptionCfg;
}

export type NestedCfg = NestedParams;

// Builds a preset's config schema (defaults = its shipped/first variant).
export function makeNestedConfigSchema(defaults: NestedParams) {
  return z
    .object({
      bestOf: z.number().int().positive().default(defaults.bestOf),
      set: z
        .object({
          gamesTo: z.number().int().positive(),
          winBy: z.number().int().positive(),
          tiebreakAt: z.number().int().positive().nullable(),
          tiebreakTo: z.number().int().positive(),
        })
        .default(defaults.set),
      finalSet: z
        .union([
          z.literal("same"),
          z.strictObject({ matchTiebreakTo: z.number().int().positive() }),
          z.strictObject({ tiebreakTo: z.number().int().positive() }),
        ])
        .default(defaults.finalSet),
      game: z.object({ noAd: z.boolean() }).default(defaults.game),
      tiebreak: z.object({ winBy: z.number().int().positive() }).default(defaults.tiebreak),
      points: z
        .object({
          win: z.number().int().nonnegative(),
          loss: z.number().int().nonnegative(),
        })
        .default(defaults.points),
      // No `.default()` — see NestedParams.interruptions.
      interruptions: NestedInterruptionCfg.optional(),
    })
    .refine((cfg) => cfg.bestOf % 2 === 1, {
      message: "bestOf must be odd (a decider must exist)",
    })
    .refine((cfg) => cfg.set.tiebreakAt === null || cfg.set.tiebreakAt <= cfg.set.gamesTo, {
      message: "tiebreakAt must be ≤ gamesTo",
    });
}

// ---------------------------------------------------------------------------
// Events — v6/00 §2
// ---------------------------------------------------------------------------

export const NestedPointMeta = z.strictObject({
  kind: z.enum(["ace", "double_fault", "winner", "ue"]).optional(),
  // ITF App VI no-ad deciding point: the receiver chooses the service side.
  // Recorded for the record; no fold effect.
  receiverSide: z.enum(["deuce", "ad"]).optional(),
});
// W4 (#407) — person attribution. The chair umpire's card records who served
// every point and, in doubles, which of the pair won it; the entrant-only point
// could express neither. Both fields are OPTIONAL so coarse scoring stays
// legal and a pre-W4 payload folds unchanged.
//
// W4 review item 4 — the person credited with the point is `scorer`, the name
// every other module already uses for "who is credited" (football's goal has
// carried it since before this wave; set-based rallies adopted it). This
// branch shipped it as `winner`, which is an EntrantId everywhere else in the
// engine — `MatchOutcome.winner`, `standingsDelta`, every module's outcome —
// so one key meant two things on the same fixture.
//
// `NestedPointMeta.kind === "winner"` is untouched: that is the SHOT TYPE, a
// different fact on a different level, and it is the word a tennis scorer
// actually uses. Renaming it would read wrong on the card.
export const PersonId = z.string().min(1);

export const NestedPoint = z.strictObject({
  by: EntrantId,
  server: PersonId.optional(),
  scorer: PersonId.optional(),
  meta: NestedPointMeta.optional(),
});
export type NestedPoint = z.infer<typeof NestedPoint>;

// Tier-0 per-set summary. `home`/`away` are games for a normal set (with `tb`
// carrying the tie-break points when the set ended 7–6 form), or the match
// tie-break points themselves when the deciding set is an MTB.
export const NestedSetSummary = z.strictObject({
  home: z.number().int().nonnegative(),
  away: z.number().int().nonnegative(),
  tb: z
    .strictObject({
      home: z.number().int().nonnegative(),
      away: z.number().int().nonnegative(),
    })
    .optional(),
});
export type NestedSetSummary = z.infer<typeof NestedSetSummary>;

// W4 (#407) — code violations. The ITF penalty ladder is cumulative within a
// match: warning → point penalty → game penalty → default. The SCORE
// consequence is entered as points (as the chair writes it into the card); this
// row is the record of the violation itself, so the fold never moves the score.
export const NestedSanctionLevel = z.enum([
  "warning",
  "point_penalty",
  "game_penalty",
  "default",
]);
export type NestedSanctionLevel = z.infer<typeof NestedSanctionLevel>;

export const NestedSanction = z.strictObject({
  by: EntrantId,
  level: NestedSanctionLevel,
  person: PersonId.optional(), // absent = the pair/team, not a named player
  // W4 review — WHICH code violation. The rationale for `DisciplineCard.reason`
  // (core/types.ts) is an accumulation rule keyed on the offence rather than
  // the ladder step, and it applies verbatim here: racquet abuse and coaching
  // are both warnings and are not the same repeat offence. The chair writes it
  // on the card; this branch could not. Optional, free text (the ITF offence
  // list is long and tour-specific — see the dossier), and the fold never
  // reads it.
  reason: z.string().min(1).optional(),
});
export type NestedSanction = z.infer<typeof NestedSanction>;

// W4a (#425) §5.4 — the chair's break record: rain delay, medical timeout,
// toilet break, heat rule. Rule 30 ("continuous play") is the whole subject.
//
// WHY THIS IS NOT `core.suspend` / `core.resume`. That pair exists, it is
// kernel-owned, and since W4a it carries `at` — it is the right record for
// "play stopped, and here is when". It has no side, no person and no kind, so
// it cannot say WHICH break this was, WHO it is charged to, or whether the
// per-set allowance is now spent, and those three are the entire reason the
// chair writes a medical timeout down. The two records are complementary and a
// chair may write both: `core.suspend` says play stopped; this says a
// three-minute MTO was charged to the home player.
//
// WHY THERE IS NO END EVENT. A start/end pair would make the duration
// derivable from the end's `at`, and this wave's ruling is that `at` records
// only what the fold CANNOT derive — recording both would recreate the
// silent-disagreement bug a redundant pair always has. One event, two
// independent facts:
//
//   `at`       — WHEN the break was called. The fold cannot derive it.
//   `duration` — HOW LONG the break ran. The fold cannot derive that either,
//                because tennis has no running game clock for a treatment
//                limit to be measured against, and §5.4 is explicit that a
//                three-minute limit must not drift when the umpire taps late.
//
// Neither is computable from the other, so neither is redundant.
export const NestedInterruption = z.strictObject({
  kind: NestedInterruptionKind,
  // Whose break it is. OPTIONAL because a rain delay is charged to nobody, and
  // the allowance (§5.4) is therefore enforced only where a side is named —
  // the same conditional-enforcement shape the ITTF expedite rule takes when
  // `serving` is absent (see DOMAIN.tabletennis.md).
  by: EntrantId.optional(),
  // WHICH player was treated. In doubles the side alone cannot say, and the
  // ITF three-minute limit is per treatable condition per player.
  //
  // Requires `by` (enforced in `applyInterruption`, not here — the schema
  // cannot see the fold's entrants and a `.refine` would move the failure out
  // of the module's own error vocabulary). A person with no side is credited on
  // the `medical_timeouts` leaderboard while the per-side count allowance never
  // bites, which is exactly the case the per-PLAYER ITF limit is about.
  person: PersonId.optional(),
  duration: DurationSeconds.optional(),
  // The GameTime schema VERBATIM (§8), never a hand-rolled look-alike. The
  // kernel is deliberately fail-OPEN on a malformed stamp — `gameTimeOf` is a
  // structural safe-parse, so `{period: "S1", elapsed: -1}` reads as UNSTAMPED
  // rather than being rejected — which makes this schema the only thing between
  // a corrupt stamp and the ledger. Only the real GameTime carries all four
  // guards: non-negative, integer, non-empty label, strict.
  at: GameTime.optional(),
});
export type NestedInterruption = z.infer<typeof NestedInterruption>;

// S5 (#431) — the game-penalty scoring path. DOMAIN.md's "game a game penalty
// concedes" row was `deferred`: there was no "award a game" event, and a
// scorer had to hand-enter four points. This is that event, one level up from
// `tennis.point` / `tennis.sanction{level:"point_penalty"}`, and the same
// two-events pattern: `tennis.sanction{level:"game_penalty"}` stays a pure
// no-op on score (`applySanction` below, UNCHANGED — existing frozen corpora
// already replay `game_penalty` sanctions and must keep folding exactly as
// they do), and THIS event is the separate, score-moving fact the chair
// enters alongside it — the way a point penalty is entered as an ordinary
// `tennis.point` for the opponent (DOMAIN.md row above).
//
// `winner`, not `by`. `NestedSanction.by` (above) names the OFFENDER — this
// engine's established convention (`DisciplineCard.entrantSide` is also the
// offender's side). This field names the entrant CREDITED with the game,
// which on a game-penalty award is the OPPOSITE party. `NestedPoint`'s own
// doc comment already names the fix: `winner` is the engine-wide word for
// "the entrant awarded something" (`MatchOutcome.winner`), so naming this
// field for exactly what it holds sidesteps the by-means-two-things trap
// rather than reusing a name that means the opposite thing one event away.
export const NestedGameAward = z.strictObject({
  winner: EntrantId,
  // Free text, mirroring `NestedSanction.reason` exactly: the fold never
  // reads it, so no recorded state and no golden moves whether it is present.
  reason: z.string().min(1).optional(),
});
export type NestedGameAward = z.infer<typeof NestedGameAward>;

// Appended, never reordered: `{by, level}` cannot parse as a point (strict
// branches reject the extra key) and a summary needs home+away, so every
// pre-W4 payload still lands on the branch it always did. `NestedInterruption`
// is the only earlier branch with a required `kind`, so it neither swallows a
// sibling nor is swallowed. S5 (#431) appends `NestedGameAward` last: its only
// required key is `winner`, which no sibling schema declares (`NestedPoint`
// requires `by`, `NestedSanction` requires `by`+`level`, `NestedSetSummary`
// requires `home`+`away`, `NestedInterruption` requires `kind`), so it neither
// swallows a sibling nor is swallowed either. `interruption.test.ts` and
// `game-award.test.ts` both assert every shape parses against exactly ONE
// branch, which is the claim that actually fails when a branch is widened.
export const NestedEv = z.union([
  NestedPoint,
  NestedSetSummary,
  NestedSanction,
  NestedInterruption,
  NestedGameAward,
]);
export type NestedEv = z.infer<typeof NestedEv>;

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

export type Side = "home" | "away";

export type GamePoints =
  | { kind: "standard"; home: number; away: number; advantage: Side | null } // 0..3 = 0/15/30/40
  | { kind: "tiebreak"; home: number; away: number }
  | { kind: "matchTiebreak"; home: number; away: number };

export interface ClosedSet {
  home: number; // games (or MTB points when mtb)
  away: number;
  tb?: { home: number; away: number };
  mtb?: boolean;
}

export interface NestedState {
  cfg: NestedCfg;
  entrants: { home: string; away: string };
  phase: "pre" | "live" | "done" | "final" | "abandoned";
  sets: ClosedSet[];
  games: { home: number; away: number }; // current set
  points: GamePoints;
  setsWon: { home: number; away: number };
  // Serve tracking (rally fidelity only; summary sets leave it untouched).
  serving: Side;
  tbPointsPlayed: number; // serve rotation inside a TB/MTB (1 then 2-2)
  tbFirstServer: Side | null;
  // Rally/points tallies for the metrics ledger (rally-scored play + TBs).
  pointsWon: { home: number; away: number };
  outcome: MatchOutcome | null;
  replayFlagged: boolean;
  // ---- W4 (#407) additive extensions. ABSENT until the event that fills them
  // arrives: the golden corpus compares JSON.stringify(state), so initialising
  // either of these in `init` would break every frozen stream. Never do it.
  persons?: Record<string, NestedPersonTally>;
  sanctions?: NestedSanctionRec[];
  // ---- W4a (#425) §5.4. Same rule as the two above: ABSENT until the first
  // interruption arrives. Initialising it to `[]` in `init` rewrites every
  // frozen golden state string.
  interruptions?: NestedInterruptionRec[];
  /**
   * S3/W4b (#426) — the pair, and who is still on court, as `core/lineup.ts`
   * folded it. `tennis/DOMAIN.md`'s doubles-order row was deferred for exactly
   * one missing fact: the pair's DECLARED order. `server` reconstructs who
   * served, but only a declaration can say which partner was named first, and
   * without it the fixed rotation cannot be checked against anything.
   *
   * ABSENT until it says something the team sheet does not — see
   * `sports/squad-state.ts`. Same rule as the three fields above: never
   * initialise it in `init`.
   */
  squads?: SquadState;
}

/**
 * Who is due to serve this side's `serviceTurn`-th service turn (0-based) —
 * the reader `tennis/DOMAIN.md`'s "doubles serving and receiving order" row
 * was deferred for. In doubles the partners alternate service games, so the
 * turn is the side's service-game index.
 *
 * `null` for a singles fixture or a sheet naming no order: the caller then has
 * nothing to compare the recorded `server` against, which is the true answer.
 */
export function expectedDoublesServer(
  state: NestedState,
  side: Side,
  serviceTurn: number,
): string | null {
  return expectedPairServerOf(state.squads, side, serviceTurn);
}

/** Per-person tallies folded out of attributed points (W4). Aces and double
 *  faults credit the SERVER — a double fault is a point for the receiver but a
 *  serving statistic for the server, which is how the card records it. */
export interface NestedPersonTally {
  points: number;
  serves: number;
  aces: number;
  doubleFaults: number;
}

export interface NestedSanctionRec {
  by: Side;
  level: NestedSanctionLevel;
  person?: string;
}

/** W4a (#425) §5.4 — one recorded break. */
export interface NestedInterruptionRec {
  kind: NestedInterruptionKind;
  /**
   * WHICH SET it fell in, 1-based — the fold's own index, never the payload's.
   * The stamp names a period and the fold knows which set is being played, and
   * where a fact is derivable the derived one is the truth: a payload field
   * that can disagree with the fold is a bug nothing can see. `at.period` is
   * checked against this and refused when it runs ahead, so the two cannot
   * quietly diverge.
   */
  set: number;
  by?: Side;
  person?: string;
  duration?: number;
  at?: GameTime;
  /**
   * `duration` exceeded `cfg.interruptions[kind].seconds`. Recorded, never
   * rejected.
   *
   * A PROJECTION OF THE CFG IN FORCE AT READ TIME, not a fact about the event —
   * and deliberately so. It is recomputed on every fold, from a cfg read live
   * out of `division.config`, so the same stream replayed after an organiser
   * edits the allowance reports a different verdict against an identical
   * `duration`. Within one fold the two can never disagree (the whole stream
   * replays from `init` on every read). Freezing the verdict into the payload
   * beside the input it was computed from is the alternative, and it is the
   * two-fields-that-can-silently-disagree bug this wave rejected everywhere
   * else. Same for `overCount`.
   */
  overran?: true;
  /**
   * This break is beyond `cfg.interruptions[kind].count` for this side in this
   * set. Recorded and flagged rather than refused — see the rationale on
   * `NestedInterruptionRules`: a cfg-derived refusal fires on REPLAY, on events
   * already in the ledger, and bricks the fixture.
   */
  overCount?: true;
}

function opponent(side: Side): Side {
  return side === "home" ? "away" : "home";
}

function invalid(message: string, data?: unknown): never {
  throw new EngineError("INVALID_EVENT", message, data);
}

function wrongPhase(message: string, data?: unknown): never {
  throw new EngineError("WRONG_PHASE", message, data);
}

function sideOf(state: NestedState, entrantId: string): Side {
  if (entrantId === state.entrants.home) return "home";
  if (entrantId === state.entrants.away) return "away";
  invalid(`unknown entrant "${entrantId}"`, { entrantId });
}

function parsePayload<T>(schema: z.ZodType<T>, payload: unknown, type: string): T {
  const parsed = schema.safeParse(payload);
  if (!parsed.success) invalid(`invalid ${type} payload`, { issues: parsed.error.issues });
  return parsed.data;
}

const majority = (bestOf: number): number => Math.ceil(bestOf / 2);

// ---------------------------------------------------------------------------
// Game time — W4a (#425) §7. Tennis has no clock, but it has ORDER, and the
// kernel's monotonic guard needs a phase list to order stamps against.
// ---------------------------------------------------------------------------

/**
 * THE phase order for this cfg — W4a (#425) §7. Every phase in which a STAMPED
 * event may legally occur, in the order they occur, and nothing else.
 *
 * One function, two consumers, by contract: the fold kernel's monotonic guard
 * reads it via `SportModule.playPhases`, and the `compareGameTime` call this
 * module makes inside `apply()` passes this same function's result. Two lists
 * that merely agree today is the defect the obligation exists to prevent — an
 * event the guard accepts is then backwards one layer down.
 * `interruption.test.ts` asserts the module holds this exact function
 * reference, so a copy fails there.
 *
 * THE PERIOD IS THE SET, and `elapsed` counts from the start of that set —
 * which is how a chair's card and every broadcast clock report tennis time
 * ("second set, 47 minutes"). The alternative, one flat period counting from
 * the first serve, loses the label the scoresheet actually prints and makes
 * every stamp incomparable to the set it belongs to.
 *
 * WIDER than the sets, and that is the point:
 *  - "pre" — a rain delay before the first serve is the commonest stoppage in
 *    the sport, and `core.suspend` is legal before `core.start`, so a stamped
 *    one has to be orderable. The `tennis.interruption` event itself still
 *    requires live play; "pre" is here for the kernel-owned pair.
 *  - "done" / "final" / "abandoned" are excluded: nothing stamped is accepted
 *    once the match is over.
 *
 * Every set this cfg can REACH is listed, and no more, so a chair stamping "S5"
 * in a best-of-3 gets a fixable INVALID_EVENT naming the sets this match has.
 *
 * Exhaustive by OBLIGATION, not by construction: the fold treats a period
 * outside this list as a bad payload field, so anything omitted here is an
 * event the scorer cannot record.
 */
export function playPhases(cfg: NestedCfg): string[] {
  return ["pre", ...Array.from({ length: cfg.bestOf }, (_, i) => setLabel(i + 1))];
}

/** `S3` — the label `playPhases` uses for the nth set, 1-based. */
function setLabel(n: number): string {
  return `S${n}`;
}

/** The set being played right now, 1-based. Banked sets never reopen. */
function currentSet(state: NestedState): number {
  return state.sets.length + 1;
}

/**
 * Seconds into the CURRENT set — a GENERATOR-ONLY clock (`arbitraryEvent`), at
 * five minutes a completed game plus thirty seconds a point of the game in
 * progress. The fold owns no clock and never calls this.
 *
 * It exists to keep the generated stamps honest about the model the dossier
 * states: the period is the set and `elapsed` counts from the START of that
 * set. A match-wide base satisfies the monotonic guard just as well and looks
 * right in the state, so nothing would have caught it — except that the golden
 * corpus is EXTENDED from generated streams, and a wrong stamp frozen there
 * becomes the reference, with the elapsed-restarts-at-a-set-boundary property
 * never exercised by any recorded stream.
 *
 * Non-decreasing within a set by construction, which is what the kernel's
 * monotonic guard (§3.3) needs: `games` only ever rises, and a completed game
 * adds 300 while the points it clears are worth at most 180 (a standard game
 * caps at 3–3 plus an advantage flag). A tie-break holds `games` at 6–6 and
 * climbs on points alone; a match tie-break plays with `games` at 0–0 and does
 * the same. Across a set boundary it RESTARTS, and the guard compares the
 * phase index first, so forward-in-time still holds.
 */
function generatorSetElapsed(state: NestedState): number {
  return (state.games.home + state.games.away) * 300 + (state.points.home + state.points.away) * 30;
}

// ---------------------------------------------------------------------------
// Deciding-set resolution — which rules govern the set about to be played.
// ---------------------------------------------------------------------------

interface SetRules {
  gamesTo: number;
  winBy: number;
  tiebreakAt: number | null;
  tiebreakTo: number;
  mtbTo: number | null; // non-null = the set IS a match tie-break
}

function isDecidingSet(state: NestedState): boolean {
  const need = majority(state.cfg.bestOf) - 1;
  return state.setsWon.home === need && state.setsWon.away === need;
}

function rulesFor(state: NestedState): SetRules {
  const { set, finalSet } = state.cfg;
  const base: SetRules = { ...set, mtbTo: null };
  if (!isDecidingSet(state) || finalSet === "same") return base;
  if ("matchTiebreakTo" in finalSet) return { ...base, mtbTo: finalSet.matchTiebreakTo };
  return { ...base, tiebreakTo: finalSet.tiebreakTo };
}

// Terminal predicate for a TB/MTB score (first to `to`, win by `winBy`,
// open-ended) — also used for summary reachability.
function tbWinner(h: number, a: number, to: number, winBy: number): Side | null {
  const winner: Side | null = h > a ? "home" : a > h ? "away" : null;
  if (winner === null) return null;
  const hi = Math.max(h, a);
  const lo = Math.min(h, a);
  return hi >= to && hi - lo >= winBy ? winner : null;
}

function reachableTbScore(h: number, a: number, to: number, winBy: number): boolean {
  const winner = tbWinner(h, a, to, winBy);
  if (winner === null) return false;
  const prevH = winner === "home" ? h - 1 : h;
  const prevA = winner === "away" ? a - 1 : a;
  if (prevH < 0 || prevA < 0) return false;
  return tbWinner(prevH, prevA, to, winBy) === null;
}

// Winner of a set at a games score, or null while live. A tie-break set can
// only be won at tiebreakAt+1 via the TB (handled by the TB fold), so this
// predicate covers the games path: reach gamesTo with a winBy lead.
function setGamesWinner(h: number, a: number, rules: SetRules): Side | null {
  const winner: Side | null = h > a ? "home" : a > h ? "away" : null;
  if (winner === null) return null;
  const hi = Math.max(h, a);
  const lo = Math.min(h, a);
  if (hi >= rules.gamesTo && hi - lo >= rules.winBy) return winner;
  return null;
}

// ---------------------------------------------------------------------------
// Fold helpers
// ---------------------------------------------------------------------------

const FRESH_GAME: GamePoints = { kind: "standard", home: 0, away: 0, advantage: null };

function startTiebreak(state: NestedState): NestedState {
  // The TB is the next game, so its first server is whoever is due to serve.
  return {
    ...state,
    points: { kind: "tiebreak", home: 0, away: 0 },
    tbPointsPlayed: 0,
    tbFirstServer: state.serving,
  };
}

// Bank a closed set, decide the match at ⌈bestOf/2⌉, open the next set.
function bankSet(state: NestedState, winnerSide: Side, closed: ClosedSet): NestedState {
  const setsWon = { ...state.setsWon, [winnerSide]: state.setsWon[winnerSide] + 1 };
  let next: NestedState = {
    ...state,
    sets: [...state.sets, closed],
    setsWon,
    games: { home: 0, away: 0 },
    points: FRESH_GAME,
    tbPointsPlayed: 0,
    tbFirstServer: null,
  };
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
    return next;
  }
  // Deciding set = an MTB? Open it as one (serve order simply continues —
  // ITF App VI: original service order carries into the match tie-break).
  const rules = rulesFor(next);
  if (rules.mtbTo !== null) {
    return {
      ...next,
      points: { kind: "matchTiebreak", home: 0, away: 0 },
      tbPointsPlayed: 0,
      tbFirstServer: next.serving,
    };
  }
  return next;
}

// A game has been won (standard game or TB): rotate serve. After a standard
// game the serve alternates; after a TB the first TB server RECEIVES the next
// set (ITF Rule 5b), i.e. the next server is their opponent.
function serveAfterGame(state: NestedState): Side {
  return opponent(state.serving);
}

// ---------------------------------------------------------------------------
// Point application
// ---------------------------------------------------------------------------

function winGame(state: NestedState, winnerSide: Side): NestedState {
  const games = { ...state.games, [winnerSide]: state.games[winnerSide] + 1 };
  const rules = rulesFor(state);
  const next: NestedState = {
    ...state,
    games,
    points: FRESH_GAME,
    serving: serveAfterGame(state),
  };
  // Tie-break entry at tiebreakAt-all takes precedence over the games win
  // predicate (they never overlap: at tiebreakAt-all no side has a lead).
  if (
    rules.tiebreakAt !== null &&
    games.home === rules.tiebreakAt &&
    games.away === rules.tiebreakAt
  ) {
    return startTiebreak(next);
  }
  const setWinner = setGamesWinner(games.home, games.away, rules);
  if (setWinner !== null) {
    return bankSet(next, setWinner, { home: games.home, away: games.away });
  }
  return next;
}

function applyStandardPoint(state: NestedState, side: Side): NestedState {
  const pts = state.points as Extract<GamePoints, { kind: "standard" }>;
  const opp = opponent(side);
  const tally = { home: state.pointsWon.home, away: state.pointsWon.away };
  tally[side] += 1;
  const scored = { ...state, pointsWon: tally };

  if (pts[side] === 3 && pts[opp] === 3) {
    // Deuce zone (40–40): no-ad = single deciding point; otherwise advantage.
    if (state.cfg.game.noAd) return winGame(scored, side);
    if (pts.advantage === side) return winGame(scored, side);
    if (pts.advantage === opp) {
      return { ...scored, points: { ...pts, advantage: null } }; // back to deuce
    }
    return { ...scored, points: { ...pts, advantage: side } };
  }
  if (pts[side] === 3) return winGame(scored, side); // 40 vs ≤30
  return { ...scored, points: { ...pts, [side]: pts[side] + 1 } };
}

function applyTbPoint(state: NestedState, side: Side, mtb: boolean): NestedState {
  const pts = state.points as Extract<GamePoints, { kind: "tiebreak" | "matchTiebreak" }>;
  const rules = rulesFor(state);
  const to = mtb ? (rules.mtbTo as number) : rules.tiebreakTo;
  const h = pts.home + (side === "home" ? 1 : 0);
  const a = pts.away + (side === "away" ? 1 : 0);
  const played = state.tbPointsPlayed + 1;
  // Serve rotation: 1 point by the due server, then 2 each (ITF Rule 5b) —
  // the server flips after point 1, 3, 5, … (odd totals).
  const serving = played % 2 === 1 ? opponent(state.serving) : state.serving;
  const tally = { ...state.pointsWon, [side]: state.pointsWon[side] + 1 };
  let next: NestedState = {
    ...state,
    points: { ...pts, home: h, away: a },
    tbPointsPlayed: played,
    serving,
    pointsWon: tally,
  };

  const winner = tbWinner(h, a, to, state.cfg.tiebreak.winBy);
  if (winner === null) return next;

  if (mtb) {
    // The MTB is the deciding set itself — banked as its points with the flag.
    return bankSet(next, winner, { home: h, away: a, mtb: true });
  }
  // TB set closes tiebreakAt+1 : tiebreakAt; the first TB server receives
  // first in the next set, so the next server is their opponent.
  const games = { ...next.games, [winner]: next.games[winner] + 1 };
  next = {
    ...next,
    games,
    serving: opponent(next.tbFirstServer as Side),
  };
  return bankSet(next, winner, {
    home: games.home,
    away: games.away,
    tb: { home: h, away: a },
  });
}

// W4 — fold the point's optional person fields onto the tally map. Returns the
// SAME reference when the point names nobody, so an unattributed stream never
// materialises the `persons` key.
function creditPersons(
  state: NestedState,
  payload: NestedPoint,
): Record<string, NestedPersonTally> | undefined {
  const { server, scorer } = payload;
  if (server === undefined && scorer === undefined) return state.persons;
  const next: Record<string, NestedPersonTally> = { ...(state.persons ?? {}) };
  const tally = (id: string): NestedPersonTally =>
    next[id] ?? { points: 0, serves: 0, aces: 0, doubleFaults: 0 };
  if (scorer !== undefined) {
    next[scorer] = { ...tally(scorer), points: tally(scorer).points + 1 };
  }
  if (server !== undefined) {
    const kind = payload.meta?.kind;
    const prev = tally(server);
    next[server] = {
      ...prev,
      serves: prev.serves + 1,
      aces: prev.aces + (kind === "ace" ? 1 : 0),
      doubleFaults: prev.doubleFaults + (kind === "double_fault" ? 1 : 0),
    };
  }
  return next;
}

function applyPoint(state: NestedState, payload: NestedPoint): NestedState {
  if (state.phase !== "live") wrongPhase(`point not allowed in phase "${state.phase}"`);
  const side = sideOf(state, payload.by);
  const persons = creditPersons(state, payload);
  const scored = persons === state.persons ? state : { ...state, persons };
  switch (scored.points.kind) {
    case "standard":
      return applyStandardPoint(scored, side);
    case "tiebreak":
      return applyTbPoint(scored, side, false);
    case "matchTiebreak":
      return applyTbPoint(scored, side, true);
  }
}

function applySanction(state: NestedState, payload: NestedSanction): NestedState {
  if (state.phase !== "live") wrongPhase(`sanction not allowed in phase "${state.phase}"`);
  const record: NestedSanctionRec = {
    by: sideOf(state, payload.by),
    level: payload.level,
    ...(payload.person === undefined ? {} : { person: payload.person }),
  };
  return { ...state, sanctions: [...(state.sanctions ?? []), record] };
}

// W4a (#425) §5.4 — the chair's break record. Never moves the score: an
// interruption is a fact about the clock and the card, and any score
// consequence (a point penalty for delay) is entered as the point it is.
function applyInterruption(
  state: NestedState,
  payload: NestedInterruption,
  strict: boolean,
): NestedState {
  if (state.phase !== "live") wrongPhase(`interruption not allowed in phase "${state.phase}"`);
  const set = currentSet(state);

  // A named player with no side to charge the break to. The allowance is per
  // side, so it cannot bite; the `medical_timeouts` metric credits the person
  // regardless; and the ITF three-minute limit is per PLAYER, which makes this
  // the very case the rule exists for. Refused rather than derived: the fold
  // holds the two entrant ids and NO lineup (`NestedState.entrants`), and
  // putting the lineup in the state would add an always-present key to every
  // frozen golden. Payload-only, so unlike an allowance this can never turn a
  // recorded fixture unreadable — no stream contains an interruption yet.
  if (payload.person !== undefined && payload.by === undefined) {
    invalid(
      'an interruption naming a person must also name the side it is charged to ("by"), because the allowance is per side',
      { person: payload.person, kind: payload.kind },
    );
  }

  // STRICT ONLY (§3.3 seam). Every refusal in this block is computed from
  // `playPhases(state.cfg)`, which nested derives from `bestOf` — so lowering
  // `bestOf` from 5 to 3 makes `here` (S4, S5) unlistable and every recorded
  // interruption in those sets throw on every read, with no event to void. The
  // stamps were legal when they were recorded; what moved is cfg. On the write
  // path they stay exactly as strict as before: a pad whose set selector ran
  // ahead of play still gets a fixable INVALID_EVENT naming the sets it has.
  //
  // The whole block is gated, not just the two `order.includes` checks: the
  // ordering comparison below raises UNKNOWN_PHASE for an unlisted period, so
  // skipping only the friendly refusals would swap a fixable error for an
  // internal-fault 500 — the exact trade the two checks exist to prevent.
  if (payload.at !== undefined && strict) {
    // Ordered against `playPhases(state.cfg)` — the SAME exported function the
    // module hands the fold kernel (§7 obligation 3), not a local list built
    // here.
    //
    // Only a stamp running AHEAD of play is refused. A pad whose set selector
    // was left on the next set files the break against a set nobody has played,
    // and nothing downstream could tell. An EARLIER stamp is legitimate and
    // stays legal — a delay before the first serve, keyed in once play is under
    // way — and the kernel's monotonic guard is what constrains it (§3.3).
    const order = playPhases(state.cfg);
    const here = setLabel(set);
    // BOTH sides re-validated before `compareGameTime` sees them, because it
    // raises UNKNOWN_PHASE for an unlisted period and §7 reserves that for two
    // phase lists that disagree — an internal fault, a 500 that pages the
    // on-call and tells the scorer nothing. The fold kernel does refuse an
    // unknown period first, but `apply()` is also called DIRECTLY, without the
    // kernel in front of it, by `testkit/conformance.ts` and
    // `testkit/simulation.ts`. `here` is checked too: it is derived from the
    // fold's own set index against a cfg-derived list, so a `bestOf` no longer
    // covering the sets already banked lands here rather than in the guard.
    if (!order.includes(payload.at.period)) {
      invalid(
        `interruption is stamped in "${payload.at.period}", which is not a period this match has: ${order.join(", ")}`,
        { period: payload.at.period, phaseOrder: order },
      );
    }
    if (!order.includes(here)) {
      invalid(
        `this match has reached ${here}, which its configured best-of-${state.cfg.bestOf} does not have: ${order.join(", ")}`,
        { currentSet: here, phaseOrder: order },
      );
    }
    if (compareGameTime({ period: payload.at.period, elapsed: 0 }, { period: here, elapsed: 0 }, order) > 0) {
      invalid(
        `interruption is stamped in ${payload.at.period}, but this match has only reached ${here}`,
        { period: payload.at.period, currentSet: here },
      );
    }
  }

  const by = payload.by === undefined ? undefined : sideOf(state, payload.by);
  const rules = state.cfg.interruptions?.[payload.kind];

  // NEITHER ALLOWANCE REFUSES. Both are computed from a cfg read live out of
  // `division.config`, and every read replays the whole stream from `init`, so
  // a refusal here fires on events already in the ledger the moment an
  // organiser edits the number — with no event to void and no scorer action
  // that recovers the fixture. Recorded and flagged instead; the umpire
  // adjudicates, and a pad can surface both flags on the card.
  //
  // COUNT — per side per set, which is the scope the ITF medical rule uses. It
  // is evaluated only where the break names a side: an unattributed delay
  // (rain) belongs to nobody, so there is no allowance to spend, the same
  // conditional shape the ITTF expedite rule takes when `serving` is absent.
  const overCount =
    rules?.count !== undefined &&
    by !== undefined &&
    (state.interruptions ?? []).filter(
      (rec) => rec.kind === payload.kind && rec.by === by && rec.set === set,
    ).length >= rules.count;

  // DURATION — the engine cannot send the physio away, and refusing the event
  // would destroy the only record that the overrun happened (§5.4).
  const overran =
    rules?.seconds !== undefined && payload.duration !== undefined && payload.duration > rules.seconds;

  const record: NestedInterruptionRec = {
    kind: payload.kind,
    set,
    ...(by === undefined ? {} : { by }),
    ...(payload.person === undefined ? {} : { person: payload.person }),
    ...(payload.duration === undefined ? {} : { duration: payload.duration }),
    ...(payload.at === undefined ? {} : { at: payload.at }),
    ...(overran ? { overran: true as const } : {}),
    ...(overCount ? { overCount: true as const } : {}),
  };
  return { ...state, interruptions: [...(state.interruptions ?? []), record] };
}

// S5 (#431) — the game-penalty scoring path, one level up from a point
// penalty (entered as an ordinary `tennis.point` for the opponent —
// DOMAIN.md). Calls the EXISTING `winGame` directly: it already does the
// whole correct cascade (games increment, points reset to `FRESH_GAME`, serve
// rotation via `serveAfterGame`, tie-break-entry check, `setGamesWinner` /
// `bankSet` if the game decides the set), so this function adds nothing
// beyond resolving the side and refusing the one state `winGame` was never
// designed for.
//
// `strict` is the §3.3 seam (review finding, cfg-replay.conformance.test.ts).
// `state.points.kind` is CFG-DERIVED, not a payload fact: whether a tie-break
// was entered by the time this event replays depends on `rules.tiebreakAt`,
// read live out of `division.config` on every fold. An organiser lowering
// `tiebreakAt` after the fact can make a stream that reaches this event in
// "standard" play at write time reach it mid-tie-break on REPLAY — and a
// refusal computed from cfg must never fire on replay (§3.3, same rule
// `NestedInterruptionRules` and the period kernel's `periodSeconds` both
// state): there is no event to void and no scorer action that recovers a
// fixture that throws on every read. So the check gates ONLY the write path;
// a non-strict replay always proceeds to `winGame`, exactly like
// `applySetSummary`'s tie-break-score fallback below falls back to banking on
// games alone rather than refusing.
function applyGameAward(state: NestedState, payload: NestedGameAward, strict: boolean): NestedState {
  if (state.phase !== "live") wrongPhase(`game award not allowed in phase "${state.phase}"`);
  // The SAME condition `applyPoint` switches on to route a point to
  // `applyTbPoint` over `applyStandardPoint`. A tie-break (or match
  // tie-break) IS the deciding game — `nestedPosition`'s doc comment: "games
  // is held at 6-6 through it, so it falls out as game 13" — so there is no
  // separate "game" left to concede; the concession would have to be a SET
  // (or the match), a genuinely different, undesigned cascade this session
  // does not build (DOMAIN.md). Refused loudly on the write path, rather than
  // silently corrupting `state.games` — `winGame` would bump it regardless,
  // and could even re-enter a tie-break immediately under a low `tiebreakAt`.
  if (strict && state.points.kind !== "standard") {
    const breaker = state.points.kind === "matchTiebreak" ? "a match tie-break" : "a tie-break";
    throw new EngineError(
      "GAME_AWARD_DURING_TIEBREAK",
      `a game cannot be awarded during ${breaker} — the breaker itself is the deciding game`,
      { pointsKind: state.points.kind },
    );
  }
  return winGame(state, sideOf(state, payload.winner));
}

// ---------------------------------------------------------------------------
// Set-summary application (tier 0) — v6/00 §2, mirrors setbased summary mode.
// ---------------------------------------------------------------------------

function setInProgress(state: NestedState): boolean {
  if (state.games.home > 0 || state.games.away > 0) return true;
  const pts = state.points;
  return pts.home > 0 || pts.away > 0;
}

// `strict` is the §3.3 seam. EVERY refusal below whose condition reads
// `rulesFor(state)` or `state.cfg` is gated on it: the set predicate is built
// from `bestOf`, `set.tiebreakAt`, `set.tiebreakTo`, `finalSet` and
// `tiebreak.winBy`, all of which an organiser edits, and cfg is read live on
// every read. A 7–6 set with a 7–5 tie-break was real when it was played; a
// competition later moving `tiebreakAt` to 3 must not make it unreadable, and
// there is no event to void. The refusals that read only the PAYLOAD (a tb
// block whose winner contradicts the set winner) stay unconditional — no config
// edit can change their verdict.
function applySetSummary(
  state: NestedState,
  payload: NestedSetSummary,
  strict: boolean,
): NestedState {
  if (state.phase !== "live") wrongPhase(`set summary not allowed in phase "${state.phase}"`);
  if (setInProgress(state)) {
    invalid("this set is being scored point-by-point — a set summary is not allowed for it");
  }
  const rules = rulesFor(state);
  const { home, away } = payload;

  // Deciding set as a match tie-break: the summary carries the MTB points.
  if (rules.mtbTo !== null) {
    if (payload.tb !== undefined) {
      invalid("a match tie-break summary carries its points in home/away, not tb");
    }
    if (strict && !reachableTbScore(home, away, rules.mtbTo, state.cfg.tiebreak.winBy)) {
      invalid("match tie-break summary is not a reachable final score", {
        home,
        away,
        to: rules.mtbTo,
      });
    }
    const winner: Side = home > away ? "home" : "away";
    const tally = { home: state.pointsWon.home + home, away: state.pointsWon.away + away };
    return bankSet({ ...state, pointsWon: tally }, winner, { home, away, mtb: true });
  }

  // Tie-break set score (tiebreakAt+1 : tiebreakAt) — tb block required.
  const isTbScore =
    rules.tiebreakAt !== null &&
    ((home === rules.tiebreakAt + 1 && away === rules.tiebreakAt) ||
      (away === rules.tiebreakAt + 1 && home === rules.tiebreakAt));
  if (isTbScore) {
    if (strict && payload.tb === undefined) {
      invalid(`a ${home}–${away} set ends in a tie-break — include its points as tb`, {
        home,
        away,
      });
    }
    if (payload.tb === undefined) {
      // Replay under a `tiebreakAt` this score only became a tie-break score
      // under. Nothing was recorded for a tie-break that was never played, so
      // the set banks on its games alone.
      const side: Side = home > away ? "home" : "away";
      return bankSet(state, side, { home, away });
    }
    const winner: Side = home > away ? "home" : "away";
    const tbh = payload.tb.home;
    const tba = payload.tb.away;
    if (strict && !reachableTbScore(tbh, tba, rules.tiebreakTo, state.cfg.tiebreak.winBy)) {
      invalid("tie-break summary is not a reachable final score", {
        tb: payload.tb,
        to: rules.tiebreakTo,
      });
    }
    const tbWinnerSide: Side = tbh > tba ? "home" : "away";
    if (tbWinnerSide !== winner) {
      invalid("tie-break winner must match the set winner", { home, away, tb: payload.tb });
    }
    const tally = { home: state.pointsWon.home + tbh, away: state.pointsWon.away + tba };
    return bankSet({ ...state, pointsWon: tally }, winner, {
      home,
      away,
      tb: { home: tbh, away: tba },
    });
  }

  // Plain games score: terminal under the set predicate, one game earlier not.
  if (strict && payload.tb !== undefined) {
    invalid("tb points are only valid on a tie-break set score", { home, away });
  }
  const gamesWinner = setGamesWinner(home, away, rules);
  if (strict && gamesWinner === null) {
    invalid("set summary is not a completed set score", { home, away, rules });
  }
  // Non-null on every strict path; null only on replay, where the higher games
  // score takes the set.
  const winner: Side = gamesWinner ?? (home >= away ? "home" : "away");
  const prevH = winner === "home" ? home - 1 : home;
  const prevA = winner === "away" ? away - 1 : away;
  const wasLive =
    setGamesWinner(prevH, prevA, rules) === null &&
    !(rules.tiebreakAt !== null && prevH === rules.tiebreakAt && prevA === rules.tiebreakAt);
  if (strict && (prevH < 0 || prevA < 0 || !wasLive)) {
    invalid("set summary is not a reachable final score", { home, away, rules });
  }
  return bankSet(state, winner, { home, away });
}

// ---------------------------------------------------------------------------
// Forfeit / abandon — mirror setbased.
// ---------------------------------------------------------------------------

function applyForfeit(state: NestedState, by: string): NestedState {
  if (state.phase === "done" || state.phase === "final" || state.phase === "abandoned") {
    wrongPhase("match already over");
  }
  const winnerSide = opponent(sideOf(state, by));
  return {
    ...state,
    phase: "done",
    outcome: { kind: "award", winner: state.entrants[winnerSide] },
  };
}

function applyAbandon(state: NestedState): NestedState {
  if (state.phase === "done" || state.phase === "final" || state.phase === "abandoned") {
    wrongPhase("match already over");
  }
  return { ...state, phase: "abandoned", replayFlagged: true };
}

// ---------------------------------------------------------------------------
// Display — spoken score + set strip (v6/00 §2).
// ---------------------------------------------------------------------------

const CALLS = ["0", "15", "30", "40"] as const;

export function gameScoreLine(points: GamePoints): string {
  switch (points.kind) {
    case "standard": {
      if (points.home === 3 && points.away === 3) {
        if (points.advantage === "home") return "Ad–40";
        if (points.advantage === "away") return "40–Ad";
        return "40–40";
      }
      return `${CALLS[points.home]}–${CALLS[points.away]}`;
    }
    case "tiebreak":
      return `TB ${points.home}–${points.away}`;
    case "matchTiebreak":
      return `MTB ${points.home}–${points.away}`;
  }
}

function closedSetLine(set: ClosedSet): string {
  if (set.mtb === true) return `[${set.home}–${set.away}]`; // ITF MTB bracket form
  if (set.tb !== undefined) {
    const loserTb = Math.min(set.tb.home, set.tb.away);
    return `${set.home}–${set.away}(${loserTb})`;
  }
  return `${set.home}–${set.away}`;
}

// ---------------------------------------------------------------------------
// Preset wiring
// ---------------------------------------------------------------------------

export interface NestedPreset {
  key: string; // 'tennis' (padel later)
  version: string;
  defaults: NestedParams;
  variants: Record<string, Partial<NestedParams>>;
  positions: PositionCatalog;
  defaultTiebreakers: TiebreakerKey[];
  officialLabel: { scorer: string };
  rallyEntitlement: string; // FeatureKey for tier-2/3 point-by-point scoring
  entrantModel?: EntrantModel;
  playerStats?: PlayerStatsModel; // Jul3/07 §3 — unlocked by person attribution
  /**
   * S3/W4b (#426) owner ruling 2 — what this competition permits a lineup to
   * do. A FUNCTION OF CFG: ITF Rule 30 ends the match when a player retires,
   * so tennis is `none`, but padel lands on this kernel later and a club
   * format that permits a replacement partner would answer differently for
   * the same code.
   *
   * Omitted ⇒ `DEFAULT_LINEUP_POLICY`.
   */
  lineupPolicy?: (cfg: NestedCfg) => LineupPolicy;
}

const METRICS: MetricSpec[] = [
  { key: "sets_won", label: "Sets won", direction: "desc" },
  { key: "sets_lost", label: "Sets lost", direction: "asc" },
  { key: "games_won", label: "Games won", direction: "desc" },
  { key: "games_lost", label: "Games lost", direction: "asc" },
  { key: "points_won", label: "Points won", direction: "desc", display: false },
];


/**
 * W4a (#425) T6b — "Set 2 · Game 4 · 30–15". Module scope, so tennis (and any
 * later nested preset) holds ONE reference.
 *
 * THE SET AND GAME NUMBERS GO THROUGH `currentUnit`, which is the whole reason
 * that function exists. `sets.length + 1` is the obvious derivation and is
 * wrong exactly once — at the end. A best-of-three won 2–0 reads "Set 3",
 * naming a set nobody played, on every match report and every timeline row for
 * that fixture. Once the match is decided the games come from the set that was
 * actually played, because the kernel resets `state.games` when a set banks.
 *
 * The tie-break needs no special case: `games` is held at 6–6 through it, so it
 * falls out as game 13 of the set, which is what it is. A MATCH tie-break does:
 * it replaces the final set and has no games at all, so the game segment is
 * omitted rather than reported as a phantom "Game 1".
 *
 * THE POINT SCORE CARRIES NO ORDINAL, deliberately. Points played is not
 * derivable from `GamePoints` past deuce — `{home: 3, away: 3, advantage}`
 * looks identical on the fourth point of a game and the fortieth — so
 * `comparePosition` is told to stop at the game rather than handed an invented
 * rank it would sort by.
 */
function nestedPosition(state: NestedState): MatchPosition {
  const live = state.outcome === null;
  const closed = state.sets.length; // `sets` holds CLOSED sets only
  const lastSet = state.sets[closed - 1];

  // The current set is under way iff a game or a point has been played in it.
  // That is this kernel's only evidence of a STARTED set — unlike the set-based
  // kernel, it appends to `sets` on close rather than on open — and it is what
  // stops a match abandoned mid-set from reporting the set before it.
  const inProgress =
    state.games.home + state.games.away > 0 || state.points.home + state.points.away > 0;
  const setNumber = unitNumber({ started: closed + (inProgress ? 1 : 0), completed: closed, live });

  // A match tie-break REPLACES the final set and has no games at all, so the
  // game segment is omitted rather than reported as a phantom "Game 1".
  const matchTiebreak = live ? state.points.kind === "matchTiebreak" : lastSet?.mtb === true;
  const segments = [unitSegment("set", "Set", setNumber)];
  if (!matchTiebreak) {
    // While a set is under way the games come from `state.games`; once it banks
    // the kernel resets those, so a decided match reads them off the set that
    // was actually played.
    const open = inProgress || live;
    const played =
      open || lastSet === undefined
        ? state.games.home + state.games.away
        : lastSet.home + lastSet.away;
    segments.push(unitSegment("game", "Game", currentUnit(played, open)));
  }
  // Only while live: once the set banks, the deciding game's point score is
  // gone from the state, and reporting the reset "0–0" would be a lie.
  if (live) segments.push(scoreSegment("points", gameScoreLine(state.points)));
  return { segments };
}

// ---------------------------------------------------------------------------
// S6/#416 (W5) — padSpec. Pure function of (preset, resolved cfg). Unlike the
// set-based kernel, `NestedEv`'s five branches (Point/SetSummary/Sanction/
// Interruption/GameAward) are ALWAYS reachable — this kernel has no
// `records`-shaped per-preset gating at all (every `apply()` case dispatches
// unconditionally). So `eventSchemas` (built in `makeNestedModule` below) has
// no kernel-union over-registration problem, and `checkActionCoverage` is
// not called for tennis: a single cfg's action set already reaches every
// registered type, for every named variant — there is no cfg under which any
// branch becomes unreachable, so there is nothing a union across variants
// would add.
// ---------------------------------------------------------------------------

/** cfg-derived plausibility bound for `NestedSetSummary.home`/`.away`
 *  (`z.number().int().nonnegative()`, no upper bound in the schema): the
 *  ordinary games target with a deuce margin, OR — if this cfg's deciding set
 *  is a match tie-break — the MTB point target, whichever is larger (the
 *  SAME field carries games in an ordinary set and MTB points in a decider
 *  under `finalSet.matchTiebreakTo`, so the bound has to cover both). An
 *  advantage set (`tiebreakAt: null`) has no games ceiling at all, so it gets
 *  a generous open-ended sentinel instead — the same plausibility-sentinel
 *  pattern cricket's padSpec uses for `ballsPerInnings: null`. */
function gamesFieldBound(cfg: NestedCfg): number {
  const UNBOUNDED_ADVANTAGE_SET_SENTINEL = 200;
  const base =
    cfg.set.tiebreakAt === null
      ? UNBOUNDED_ADVANTAGE_SET_SENTINEL
      : cfg.set.gamesTo + cfg.set.winBy + 2;
  const mtb =
    cfg.finalSet !== "same" && "matchTiebreakTo" in cfg.finalSet ? cfg.finalSet.matchTiebreakTo + 2 : 0;
  return Math.max(base, mtb);
}

/** Bound for `NestedSetSummary.tb.{home,away}` — the ordinary tie-break
 *  target, or the decider's own `finalSet.tiebreakTo` (the slam rule) if
 *  larger. */
function tbFieldBound(cfg: NestedCfg): number {
  const ordinary = cfg.set.tiebreakTo + cfg.tiebreak.winBy + 2;
  const decider =
    cfg.finalSet !== "same" && "tiebreakTo" in cfg.finalSet
      ? cfg.finalSet.tiebreakTo + cfg.tiebreak.winBy + 2
      : 0;
  return Math.max(ordinary, decider);
}

/** ITF Rule 30 break allowance is per-kind and per-competition
 *  (`NestedInterruptionCfg`, no default — see `NestedParams.interruptions`'s
 *  own doc comment), so there is no single cfg-derived ceiling to read for a
 *  generic "duration" field. A plausibility sentinel, matching cricket's own
 *  approach for a schema field the DOMAIN leaves genuinely unbounded. */
const PLAUSIBLE_INTERRUPTION_SECONDS = 3600;

function nestedPadSpec(preset: NestedPreset, cfg: NestedCfg): PadSpec {
  const key = preset.key;
  const pointType = `${key}.point`;
  const summaryType = `${key}.set_summary`;
  const sanctionType = `${key}.sanction`;
  const interruptionType = `${key}.interruption`;
  const gameAwardType = `${key}.game.award`;
  const gamesBound = gamesFieldBound(cfg);
  const tbBound = tbFieldBound(cfg);

  const pointAction: PadAction = {
    type: pointType,
    labelKey: { key: `pad.${key}.action.point`, label: "Point" },
    fields: [],
    attribution: [{ kind: "side", path: "by" }],
  };
  const pointAttributedAction: PadAction = {
    type: pointType,
    labelKey: { key: `pad.${key}.action.pointAttributed`, label: "Point (server / scorer)" },
    fields: [
      { kind: "enum", path: "meta.kind", values: ["ace", "double_fault", "winner", "ue"] },
      { kind: "enum", path: "meta.receiverSide", values: ["deuce", "ad"] },
    ],
    attribution: [
      { kind: "side", path: "by" },
      { kind: "person", path: "server" },
      { kind: "person", path: "scorer" },
    ],
  };
  const summaryAction: PadAction = {
    type: summaryType,
    labelKey: { key: `pad.${key}.action.setScore`, label: "Set score" },
    fields: [
      { kind: "number", path: "home", min: 0, max: gamesBound },
      { kind: "number", path: "away", min: 0, max: gamesBound },
    ],
    attribution: [],
  };
  // A separate action for a tie-break-ending set — same type, richer fields
  // (the `tb` block), exactly the cricket ball/extra/wicket pattern of
  // several actions sharing one `eventSchema` branch.
  const summaryTbAction: PadAction = {
    type: summaryType,
    labelKey: { key: `pad.${key}.action.setScoreTiebreak`, label: "Set score (tie-break)" },
    fields: [
      { kind: "number", path: "home", min: 0, max: gamesBound },
      { kind: "number", path: "away", min: 0, max: gamesBound },
      { kind: "number", path: "tb.home", min: 0, max: tbBound },
      { kind: "number", path: "tb.away", min: 0, max: tbBound },
    ],
    attribution: [],
  };
  const sanctionAction: PadAction = {
    type: sanctionType,
    labelKey: { key: `pad.${key}.action.sanction`, label: "Code violation" },
    fields: [{ kind: "enum", path: "level", values: NestedSanctionLevel.options }],
    attribution: [
      { kind: "side", path: "by" },
      { kind: "person", path: "person" },
    ],
  };
  const interruptionAction: PadAction = {
    type: interruptionType,
    labelKey: { key: `pad.${key}.action.interruption`, label: "Interruption" },
    fields: [
      { kind: "enum", path: "kind", values: NestedInterruptionKind.options },
      { kind: "number", path: "duration", min: 0, max: PLAUSIBLE_INTERRUPTION_SECONDS },
    ],
    attribution: [
      { kind: "side", path: "by" },
      { kind: "person", path: "person" },
    ],
  };
  const gameAwardAction: PadAction = {
    type: gameAwardType,
    labelKey: { key: `pad.${key}.action.gameAward`, label: "Award game" },
    fields: [],
    attribution: [{ kind: "side", path: "winner" }],
  };

  const panels: PadPanel[] = [
    {
      labelKey: { key: `pad.${key}.panel.points`, label: "Points" },
      phase: "live",
      layout: "primary",
      actions: [pointAction, pointAttributedAction],
    },
    {
      labelKey: { key: `pad.${key}.panel.setScore`, label: "Set score" },
      phase: "live",
      layout: "grid",
      actions: [summaryAction, summaryTbAction],
    },
    {
      labelKey: { key: `pad.${key}.panel.sanctions`, label: "Code violations" },
      phase: "live",
      layout: "drawer",
      actions: [sanctionAction],
    },
    {
      labelKey: { key: `pad.${key}.panel.interruptions`, label: "Interruptions" },
      phase: "live",
      layout: "drawer",
      actions: [interruptionAction],
    },
    {
      labelKey: { key: `pad.${key}.panel.gameAward`, label: "Award game" },
      phase: "live",
      layout: "drawer",
      actions: [gameAwardAction],
      // Reachable, not merely configured: `applyGameAward` refuses
      // mid-tie-break (the breaker itself IS the deciding game — no
      // separate "game" left to concede), and whether a tie-break is in
      // force right now is STATE, never derivable from cfg alone.
      gate: {
        op: "and",
        of: [
          { op: "not", of: { op: "path-equals", path: "state.points.kind", value: "tiebreak" } },
          { op: "not", of: { op: "path-equals", path: "state.points.kind", value: "matchTiebreak" } },
        ],
      } satisfies PadGate,
    },
  ];

  return {
    panels,
    // One band per registered type (all 5 — see the module-level note
    // above). The bare set score alone (band 0) already reaches a decided
    // match (`bankSet` off summaries, exactly like the set-based kernel);
    // code violations and interruptions are administrative records that
    // never move the score, band 1 (matching the set-based kernel's own
    // timeout/sanction placement); points and game-awards are both
    // SCORE-MOVING facts at the kernel's maximum granularity — a game award
    // is one level up from a point ("the game a code violation concedes"),
    // not a discipline record like sanction/interruption — so both sit at
    // band 3, matching `rallyEntitlement`'s name
    // ("scoring.rally_by_rally", tennis's own `scoring.ball_by_ball`
    // sibling). Band 2 is unoccupied — same honest gap as the set-based
    // kernel's (no player-line/box-score analogue here either); S2/#430
    // parked this kernel's own T3 addition (1st-vs-2nd serve, rally length)
    // as future work, not this session's.
    fidelity: {
      [summaryType]: 0,
      [sanctionType]: 1,
      [interruptionType]: 1,
      [pointType]: 3,
      [gameAwardType]: 3,
    } satisfies Record<string, FidelityBand>,
    fidelityEntitlements: { 3: preset.rallyEntitlement },
  };
}

// ---------------------------------------------------------------------------
// S8/#417 — kernel-level default playerStats. The nested-kernel twin of
// `setbased/kernel.ts`'s own block of the same name — every metric this
// preset declares today names an OPTIONAL person field (`scorer`, `server`),
// so a v1-era stream that only ever names the REQUIRED `by` entrant folds to
// zero credit. This default closes that gap, unconditionally.
// ---------------------------------------------------------------------------

/**
 * `points_won` — the canonical entrant-fallback metric (owner ruling,
 * S8/#417), the nested-kernel twin of `setbased/kernel.ts`'s own
 * `setBasedPointsWonMetric`: an explicit `scorer` still wins whenever one
 * resolves (giving this key the SAME numbers tennis's own `points` already
 * reports), and `by` rescues a stream that never named one at all.
 */
function nestedPointsWonMetric(pointType: string): PlayerStatMetric {
  return {
    key: "points_won",
    label: "Points won",
    from: pointType,
    field: "scorer",
    entrantField: "by",
    fromEntrant: true,
    agg: "count",
  };
}

/**
 * A throwaway two-sided state, seeded directly into "live" — never returned,
 * never adopted by a real fixture, alive only for the length of one
 * `folded.fold` call below. Same non-home/away-labelled `idX`/`idY` contract
 * as `setbased/kernel.ts`'s own `setBasedReplayState` — see its doc comment.
 */
function nestedReplayState(cfg: NestedCfg, idX: string, idY: string): NestedState {
  return {
    cfg,
    entrants: { home: idX, away: idY },
    phase: "live",
    sets: [],
    games: { home: 0, away: 0 },
    points: FRESH_GAME,
    setsWon: { home: 0, away: 0 },
    serving: "home",
    tbPointsPlayed: 0,
    tbFirstServer: null,
    pointsWon: { home: 0, away: 0 },
    outcome: null,
    replayFlagged: false,
  };
}

/**
 * The same three-way dispatch `applyPoint` makes on `state.points.kind` —
 * duplicated rather than reused because `applyPoint` also folds person
 * credit (`creditPersons`) off the real payload, which this replay has no
 * use for and no payload to feed it (only a `by`-derived `side` is known
 * here, not a whole `NestedPoint`). `applyStandardPoint`/`applyTbPoint`
 * themselves are called UNMODIFIED — this is a dispatcher, not a
 * reimplementation of what they do.
 */
function applyPointForReplay(state: NestedState, side: Side): NestedState {
  switch (state.points.kind) {
    case "standard":
      return applyStandardPoint(state, side);
    case "tiebreak":
      return applyTbPoint(state, side, false);
    case "matchTiebreak":
      return applyTbPoint(state, side, true);
  }
}

/**
 * Games won so far, closed sets plus the set in progress — VERBATIM the
 * formula `sideMetrics`'s own `gamesOf` uses inside `makeNestedModule`
 * (below), duplicated because that one is a closure over `opponent`, not a
 * standalone export. Keep the two in sync if either changes.
 */
function nestedGamesOf(state: NestedState, side: Side): number {
  return (
    state.sets.reduce((sum, set) => sum + (set.mtb === true ? 0 : set[side]), 0) + state.games[side]
  );
}

/**
 * `folded.fold` for match/set/game-level outcomes (`matches`, `sets_won`,
 * `sets_lost`, `games_won`) — the nested-kernel twin of
 * `setbased/kernel.ts`'s own `setBasedMatchOutcomesFold`; read that
 * function's doc comment for the full rationale (replay-not-reimplement,
 * never-throws, the shutout case, why `ctx.cfg` is read here at all). The
 * one kernel-specific addition is `games_won`, since this kernel alone has a
 * game layer between points and sets.
 *
 * Positional set summaries here need no special case, unlike the set-based
 * kernel's: `NestedSetSummary` has only ONE shape (`{home, away, tb?}`,
 * always positional) — there is no entrant-keyed alternative to prefer, so
 * every well-formed summary in the ledger is evidence both sides "played",
 * and it is always fed to the replay (which needs no entrant id to bank a
 * games score, only two numbers to compare against `idX`'s/`idY`'s already-
 * known positions).
 */
function nestedMatchOutcomesFold(
  preset: NestedPreset,
  configSchema: ReturnType<typeof makeNestedConfigSchema>,
): NonNullable<PlayerStatsModel["folded"]> {
  const pointType = `${preset.key}.point`;
  const summaryType = `${preset.key}.set_summary`;
  const gameAwardType = `${preset.key}.game.award`;
  return {
    keys: ["matches", "sets_won", "sets_lost", "games_won"],
    fold(events: readonly EventEnvelope[], ctx: PlayerStatsFoldCtx): PlayerStatRow[] {
      if (ctx.entrants.length !== 2) return []; // this kernel is always 2-sided; nothing safe to pair
      const idX = ctx.entrants[0]!.id;
      const idY = ctx.entrants[1]!.id;
      // S8/#417 W6 fix 5 — the shared kind guard, not a local re-derivation.
      const personsFor = (entrantId: string): readonly string[] => personsForEntrant(ctx, entrantId);

      const cfgParsed = configSchema.safeParse(ctx.cfg);
      let state: NestedState | undefined = cfgParsed.success
        ? nestedReplayState(cfgParsed.data, idX, idY)
        : undefined;
      let played = false;

      for (const event of events) {
        if (event.type === pointType) {
          played = true;
          if (state === undefined) continue;
          const by = (event.payload as Record<string, unknown>).by;
          if (typeof by !== "string" || (by !== idX && by !== idY)) continue;
          try {
            state = applyPointForReplay(state, by === idX ? "home" : "away");
          } catch {
            state = undefined;
          }
          continue;
        }
        if (event.type === summaryType) {
          played = true; // no entrant id on this shape — see the doc comment above
          if (state === undefined) continue;
          const payload = event.payload as Record<string, unknown>;
          if (typeof payload.home !== "number" || typeof payload.away !== "number") continue;
          try {
            state = applySetSummary(state, payload as NestedSetSummary, false);
          } catch {
            state = undefined;
          }
          continue;
        }
        if (event.type === gameAwardType) {
          played = true;
          if (state === undefined) continue;
          const winner = (event.payload as Record<string, unknown>).winner;
          if (typeof winner !== "string" || (winner !== idX && winner !== idY)) continue;
          try {
            state = applyGameAward(state, { winner }, false);
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
          bump(p, "games_won", nestedGamesOf(state, "home"));
        }
        for (const p of personsFor(idY)) {
          bump(p, "sets_won", state.setsWon.away);
          bump(p, "sets_lost", state.setsWon.home);
          bump(p, "games_won", nestedGamesOf(state, "away"));
        }
      }

      return [...rows.entries()]
        .map(([personId, stats]) => ({ personId, stats }))
        .sort((a, b) => a.personId.localeCompare(b.personId));
    },
  };
}

/**
 * Merges the kernel default with the preset's own declared model (S8/#417).
 * Identical precedence rule to `setbased/kernel.ts`'s own `mergePlayerStats`
 * — see its doc comment for the full rationale. Duplicated rather than
 * shared: the two kernel files own no common module between them, and this
 * function is small and self-contained.
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
            keys: [...new Set([...kFolded.keys, ...pFolded.keys])],
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

export function makeNestedModule(
  preset: NestedPreset,
): SportModule<NestedCfg, NestedEv, NestedState> {
  const configSchema = makeNestedConfigSchema(preset.defaults);
  const pointType = `${preset.key}.point`;
  const summaryType = `${preset.key}.set_summary`;
  const sanctionType = `${preset.key}.sanction`;
  const interruptionType = `${preset.key}.interruption`;
  const gameAwardType = `${preset.key}.game.award`;
  // S6/#416 (W5) — type string -> its own payload schema, by reference, the
  // SAME 5 schema objects `NestedEv` unions (top of this file). Unlike the
  // set-based kernel, this is a true bijection with no kernel-union
  // over-registration: every branch here dispatches unconditionally in
  // `apply()` below, for every preset this kernel has ever had (tennis is
  // still the only one).
  const eventSchemas: Readonly<Record<string, z.ZodTypeAny>> = {
    [pointType]: NestedPoint,
    [summaryType]: NestedSetSummary,
    [sanctionType]: NestedSanction,
    [interruptionType]: NestedInterruption,
    [gameAwardType]: NestedGameAward,
  };
  // One per module — see `sports/squad-state.ts` for the init handshake it
  // keys on.
  const squadAdopter = makeSquadAdopter<NestedState>();

  // W4 review item 7 — the ITF code-violation ladder reaches the shared
  // discipline projection. The kernel folded a LOCAL sanction record in this
  // wave and shipped no `discipline` descriptor, so a violation that carries a
  // real consequence was invisible to the usecase that prices football's cards.
  // The LADDER stays tennis's own (warning → point → game → default); only the
  // projection is uniform.
  const discipline: DisciplineModel = {
    colors: NestedSanctionLevel.options.map((key) => ({
      key,
      label: key.replace(/_/g, " ").replace(/^./, (ch) => ch.toUpperCase()),
    })),
    extractCards(ledger): DisciplineCard[] {
      const cards: DisciplineCard[] = [];
      for (const ev of resolveVoids(ledger)) {
        if (ev.type !== sanctionType) continue;
        const parsed = NestedSanction.safeParse(ev.payload);
        if (!parsed.success) continue;
        const sanction = parsed.data;
        cards.push({
          ...(sanction.person === undefined ? {} : { personId: sanction.person }),
          entrantSide: sanction.by,
          color: sanction.level,
          eventId: ev.id,
          // W4 review — the offence, when the chair recorded one, the way
          // football and the period kernel already pass it. Absent stays
          // absent: "no offence recorded" is not an offence.
          ...(sanction.reason === undefined ? {} : { reason: sanction.reason }),
        });
      }
      return cards;
    },
  };

  // Tiers 0/1 stay a bare set score; the attributed timeline (who served, who
  // won the point, code violations) rides with point scoring at tiers 2/3.
  const fidelityTiers: FidelityTier[] = [
    { tier: 0, eventTypes: [summaryType] },
    { tier: 1, eventTypes: [summaryType] },
    {
      tier: 2,
      eventTypes: [pointType, sanctionType, interruptionType, gameAwardType],
      entitlement: preset.rallyEntitlement,
    },
    {
      tier: 3,
      eventTypes: [pointType, sanctionType, interruptionType, gameAwardType],
      entitlement: preset.rallyEntitlement,
    },
  ];

  const sideMetrics = (state: NestedState, side: Side): Record<string, number> => {
    const opp = opponent(side);
    const gamesOf = (s: Side): number =>
      state.sets.reduce((sum, set) => sum + (set.mtb === true ? 0 : set[s]), 0) + state.games[s];
    return {
      sets_won: state.setsWon[side],
      sets_lost: state.setsWon[opp],
      games_won: gamesOf(side),
      games_lost: gamesOf(opp),
      points_won: state.pointsWon[side],
    };
  };

  return {
    key: preset.key,
    version: preset.version,
    configSchema,
    eventSchema: NestedEv,
    eventSchemas,
    padSpec: (padCfg) => nestedPadSpec(preset, padCfg),
    positions: preset.positions,
    variants: preset.variants,

    // S3/W4b (#426) — the two halves of adopting `core/lineup.ts`.
    ...(preset.lineupPolicy === undefined ? {} : { lineupPolicy: preset.lineupPolicy }),
    onLineup: (state, squads) => squadAdopter.adopt(state, squads),

    init(cfg, lineups: LineupPair): NestedState {
      return squadAdopter.fresh({
        cfg,
        entrants: { home: lineups.home.entrantId, away: lineups.away.entrantId },
        phase: "pre",
        sets: [],
        games: { home: 0, away: 0 },
        points: FRESH_GAME,
        setsWon: { home: 0, away: 0 },
        serving: "home", // convention: the toss is not modelled; home serves first
        tbPointsPlayed: 0,
        tbFirstServer: null,
        pointsWon: { home: 0, away: 0 },
        outcome: null,
        replayFlagged: false,
      });
    },

    apply(state, ev: EventEnvelope<NestedEv | CoreEv>, ctx): NestedState {
      switch (ev.type) {
        case "core.start":
          if (state.phase !== "pre") wrongPhase("already started");
          return { ...state, phase: "live" };
        case pointType:
          return applyPoint(state, parsePayload(NestedPoint, ev.payload, ev.type));
        case summaryType:
          return applySetSummary(
            state,
            parsePayload(NestedSetSummary, ev.payload, ev.type),
            isStrictFold(ctx),
          );
        case sanctionType:
          return applySanction(state, parsePayload(NestedSanction, ev.payload, ev.type));
        case interruptionType:
          return applyInterruption(
            state,
            parsePayload(NestedInterruption, ev.payload, ev.type),
            isStrictFold(ctx),
          );
        case gameAwardType:
          return applyGameAward(
            state,
            parsePayload(NestedGameAward, ev.payload, ev.type),
            isStrictFold(ctx),
          );
        case "core.forfeit":
          return applyForfeit(state, (ev.payload as { by: string }).by);
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

    // W4a (#425) §7 obligation 2 — the EXPORTED function itself, handed over by
    // reference. Not a wrapper and not a copy of its output: the guard and the
    // ordering `apply()` does must be the same function, or an event the guard
    // accepts is backwards a layer down.
    playPhases,

    // W4a (#425) T6b — the cross-sport position axis (see `nestedPosition`).
    position: nestedPosition,

    // §9.5 — defined at every prefix. Headline speaks tennis: sets tally, the
    // closed-set strip (6–4 7–6(5) [10–7]), live games and the spoken game
    // score; serve state rides in detail for pads and scorebugs.
    summary(state): ScoreSummary {
      const strip = state.sets.map(closedSetLine).join(" ");
      const liveGames =
        state.phase === "live" && (setInProgress(state) || state.sets.length > 0)
          ? state.points.kind === "matchTiebreak"
            ? ` · ${gameScoreLine(state.points)}`
            : ` · ${state.games.home}–${state.games.away}` +
              (state.points.home > 0 ||
              state.points.away > 0 ||
              (state.points.kind === "standard" && state.points.advantage !== null)
                ? ` (${gameScoreLine(state.points)})`
                : "")
          : "";
      return {
        headline:
          `${state.setsWon.home} — ${state.setsWon.away}` +
          (strip === "" ? "" : ` · ${strip}`) +
          liveGames,
        perSide: [
          { entrantId: state.entrants.home, line: `${state.setsWon.home}` },
          { entrantId: state.entrants.away, line: `${state.setsWon.away}` },
        ],
        detail: {
          // Closed sets + (when play is under way) one open entry with the
          // live games — the same {home, away, closed} shape the setbased
          // kernel exposes, so the public set scoreboard renders tennis
          // without knowing the sport. The MTB live entry carries its points.
          sets: [
            ...state.sets.map((set) => ({ ...set, closed: true })),
            ...(state.phase === "live" && setInProgress(state)
              ? [
                  state.points.kind === "matchTiebreak"
                    ? { home: state.points.home, away: state.points.away, closed: false }
                    : { home: state.games.home, away: state.games.away, closed: false },
                ]
              : []),
          ],
          games: state.games,
          game: gameScoreLine(state.points),
          gameKind: state.points.kind,
          serving: state.phase === "live" ? state.serving : null,
          ...(state.replayFlagged ? { abandoned: true } : {}),
          // W4 — attribution rides in the summary here (unlike the set-based
          // kernel) because tennis declares no `coarsen` hook: there is no
          // coarse fold that would have to agree with it under §9.6.
          ...(state.persons === undefined ? {} : { persons: state.persons }),
          ...(state.sanctions === undefined ? {} : { sanctions: state.sanctions }),
          // W4a §5.4 — the break record rides here for the same reason: no
          // `coarsen` hook, so nothing has to agree with it under §9.6.
          ...(state.interruptions === undefined ? {} : { interruptions: state.interruptions }),
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
        case "win":
        case "award": {
          const winnerSide = sideOf(state, outcome.winner);
          const winner = build(winnerSide, 1, 0, cfg.points.win);
          const loser = build(opponent(winnerSide), 0, 1, cfg.points.loss);
          return winnerSide === "home" ? [winner, loser] : [loser, winner];
        }
        default:
          invalid(`nested module cannot rank outcome "${outcome.kind}"`);
      }
    },

    metrics: METRICS,
    defaultTiebreakers: preset.defaultTiebreakers,

    supportsDraws(_cfg, _stage: StageKind) {
      return false; // v6/00 §4 — tennis never draws
    },

    declaredPointsSets(cfg) {
      return [cfg.points.win + cfg.points.loss];
    },

    fidelityTiers,
    officialLabel: preset.officialLabel,
    ...(preset.entrantModel === undefined ? {} : { entrantModel: preset.entrantModel }),
    // S8/#417 — always populated: the kernel default (`points_won` +
    // matches/sets_won/sets_lost/games_won) merges with whatever this preset
    // declares, never merely spread when present. See `mergePlayerStats`.
    playerStats: mergePlayerStats(
      {
        metrics: [nestedPointsWonMetric(pointType)],
        folded: nestedMatchOutcomesFold(preset, configSchema),
      },
      preset.playerStats,
    ),
    discipline,

    // spec 03 §6 — deterministic generator. Summary-dominant so matches decide
    // within the conformance event budget; point bursts exercise the rally
    // path (deuce loops, TB entry) like setbased's rally bursts.
    arbitraryEvent(state, rng: Rng): ModuleEvent<NestedEv> | null {
      if (state.phase === "pre") return { type: "core.start", payload: {} };
      if (state.phase !== "live") return null;

      const randomEntrant = () => (rng() < 0.5 ? state.entrants.home : state.entrants.away);
      // W4 — the testkit's lineups are `${entrantId}-p{n}` (helpers.ts), so the
      // generator can name people the way a real pad would.
      const randomPerson = (entrantId: string) => `${entrantId}-p1`;
      const serverId = () =>
        state.serving === "home" ? randomPerson(state.entrants.home) : randomPerson(state.entrants.away);
      // Half of all points carry attribution — the other half keep the coarse
      // (entrant-only) shape exercised.
      const pointPayload = (): NestedPoint => {
        const by = randomEntrant();
        if (rng() < 0.5) return { by };
        const kindRoll = rng();
        const kind =
          kindRoll < 0.15
            ? ("ace" as const)
            : kindRoll < 0.3
              ? ("double_fault" as const)
              : undefined;
        // W4a T10 follow-up — ITF App VI: on a no-ad deciding point the
        // receiver chooses which court the serve comes into. It has no fold
        // effect, which is exactly why nothing else would ever have noticed it
        // being renamed or narrowed. SOMETIMES, and INDEPENDENT of `kind`, so
        // the corpus holds all four shapes: no meta, kind only, receiverSide
        // only, and both — `NestedPointMeta` is a strictObject whose every key
        // is optional, so a meta carrying only this one is a legal payload and
        // the one a no-ad point actually produces.
        // Annotated, not asserted: the literals widen to `string` on the way
        // through the spread below, and `no-unnecessary-type-assertion` judges
        // an `as` here against the ternary alone, so it reads as redundant and
        // its autofix breaks the return type. The annotation satisfies both.
        const receiverSide: "deuce" | "ad" | undefined =
          rng() < 0.2 ? (rng() < 0.5 ? "deuce" : "ad") : undefined;
        const meta = {
          ...(kind === undefined ? {} : { kind }),
          ...(receiverSide === undefined ? {} : { receiverSide }),
        };
        return {
          by,
          server: serverId(),
          scorer: randomPerson(by),
          ...(Object.keys(meta).length === 0 ? {} : { meta }),
        };
      };
      // Occasional code violations, so conformance walks the new branch.
      if (rng() < 0.04) {
        const levels = NestedSanctionLevel.options;
        const by = randomEntrant();
        return {
          type: sanctionType,
          payload: {
            by,
            level: levels[Math.floor(rng() * levels.length)] as (typeof levels)[number],
            person: randomPerson(by),
          },
        };
      }
      // W4a §5.4 — occasional breaks, so conformance and the corpus walk the
      // new branch AND its stamp. The stamp is DERIVED, not rolled: the period
      // is the set being played and `elapsed` is `generatorSetElapsed` — time
      // INTO THAT SET, which is the model the dossier row states, and which
      // restarts at every set boundary. It is non-decreasing within a set, so
      // every generated stream is monotone by construction and the kernel's
      // guard (§3.3) accepts all of them.
      // S5 (#431) review — game-award used to draw its OWN unconditional
      // `rng()` on every "standard" call (nearly every call), which is a
      // NET NEW draw whether or not the branch fires: `position.conformance
      // .test.ts` walks five FIXED seeds (spec 03 §6's determinism
      // requirement, not this event's own logic), and shifting every
      // downstream draw for the rest of a generated match collapsed three of
      // them into 3-4 event streams (a `tennis.set_summary` deciding a whole
      // set is already ~86% likely the moment a fresh set's `roll` below
      // lands >=0.14, and a shift can walk straight into that). Reusing
      // interruption's OWN roll as an `else if` on the SAME draw — rather
      // than adding a new one — means a call where neither fires consumes
      // EXACTLY the draws it did before this event existed, so the fix is
      // "don't add a draw", not a change to `applyGameAward`/`winGame`.
      const breakRoll = rng();
      if (breakRoll < 0.03) {
        const kinds = NestedInterruptionKind.options;
        const by = randomEntrant();
        return {
          type: interruptionType,
          payload: {
            kind: kinds[Math.floor(rng() * kinds.length)] as (typeof kinds)[number],
            by,
            person: randomPerson(by),
            duration: 120,
            at: { period: setLabel(currentSet(state)), elapsed: generatorSetElapsed(state) },
          },
        };
      }
      // Guarded on `points.kind === "standard"` — the SAME condition
      // `applyGameAward` refuses on — because every generated emission must
      // be valid for the state it is generated in: `buildStream` applies
      // each event as it walks, so an invalid one throws during generation,
      // not during assertion.
      if (breakRoll < 0.06 && state.points.kind === "standard") {
        return {
          type: gameAwardType,
          payload: {
            winner: randomEntrant(),
            ...(rng() < 0.5 ? { reason: "code violation" } : {}),
          },
        };
      }
      if (setInProgress(state)) {
        // A rally set is mid-flight — keep playing points to a finish.
        return { type: pointType, payload: pointPayload() };
      }
      const roll = rng();
      if (roll < 0.02) {
        return { type: "core.forfeit", payload: { by: randomEntrant(), reason: "walkover" } };
      }
      if (roll < 0.04) return { type: "core.abandon", payload: { reason: "rain" } };
      if (roll < 0.14) return { type: pointType, payload: pointPayload() };

      // Valid random set summary under the rules of the set about to start.
      const rules = rulesFor(state);
      const homeWins = rng() < 0.5;
      if (rules.mtbTo !== null) {
        const lo = Math.floor(rng() * Math.max(1, rules.mtbTo - state.cfg.tiebreak.winBy + 1));
        const hi = rules.mtbTo;
        return {
          type: summaryType,
          payload: { home: homeWins ? hi : lo, away: homeWins ? lo : hi },
        };
      }
      // ~30% tie-break sets when the set can have one.
      if (rules.tiebreakAt !== null && rng() < 0.3) {
        const tbLo = Math.floor(
          rng() * Math.max(1, rules.tiebreakTo - state.cfg.tiebreak.winBy + 1),
        );
        const tb = homeWins
          ? { home: rules.tiebreakTo, away: tbLo }
          : { home: tbLo, away: rules.tiebreakTo };
        const hi = rules.tiebreakAt + 1;
        const lo = rules.tiebreakAt;
        return {
          type: summaryType,
          payload: { home: homeWins ? hi : lo, away: homeWins ? lo : hi, tb },
        };
      }
      const lo = Math.floor(rng() * Math.max(1, rules.gamesTo - rules.winBy + 1));
      return {
        type: summaryType,
        payload: { home: homeWins ? rules.gamesTo : lo, away: homeWins ? lo : rules.gamesTo },
      };
    },
  };
}
