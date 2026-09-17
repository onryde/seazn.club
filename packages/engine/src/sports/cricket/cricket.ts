// Cricket SportModule — spec 04 §2 (normative) + engine/sports/cricket.md
// (PROMPT-05). Dual fidelity is the load-bearing design (spec §2.2): fine
// `cricket.ball` events and coarse `cricket.innings.summary` events both fold
// into the same InningsTotals shape, and all result/NRR/DLS math reads only
// those totals — result logic never peeks at ball events.
import { z } from "zod";
import { EngineError } from "../../core/errors.ts";
import { forfeitOf, isStrictFold, type CoreEv, type EventEnvelope } from "../../core/events.ts";
import { playingSquad, type LineupPolicy, type SquadState } from "../../core/lineup.ts";
import type { Rng } from "../../core/rng.ts";
import {
  labelledSegment,
  unitNumber,
  unitSegment,
  type MatchPosition,
} from "../../core/position.ts";
import {
  EntrantId,
  type LineupPair,
  type MatchOutcome,
  type ScoreSummary,
  type StageCtx,
  type StageKind,
  type StandingsDelta,
} from "../../core/types.ts";
import type { PositionCatalog } from "../../sport/catalog.ts";
import { stampAttributionRequired } from "../../sport/module.ts";
import type {
  ModuleEvent,
  PadAction,
  PadAttribution,
  PadField,
  PadGate,
  PadPanel,
  PadSpec,
  SportModule,
} from "../../sport/module.ts";
import { resolvePayloadPath, type PlayerStatMetric, type PlayerStatsModel } from "../../stats/stats.ts";
import { makeSquadAdopter } from "../squad-state.ts";
import { dlsPar, dlsTarget, resourcesFromBalls } from "./dls.ts";

// ---------------------------------------------------------------------------
// Cfg — spec 04 §2.1
// ---------------------------------------------------------------------------

const CricketCfgBase = z.object({
  inningsPerSide: z.union([z.literal(1), z.literal(2)]).default(1),
  // T20 120, ODI 300, Hundred 100; null = unlimited (test).
  ballsPerInnings: z.number().int().positive().nullable().default(120),
  ballsPerOver: z.number().int().positive().default(6), // Hundred uses 5-ball sets
  playersPerSide: z.number().int().min(2).default(11),
  maxOversPerBowler: z.number().int().positive().optional(), // T20 4, ODI 10
  points: z
    .object({
      win: z.number().int().nonnegative().default(2),
      tie: z.number().int().nonnegative().default(1),
      noResult: z.number().int().nonnegative().default(1),
      loss: z.number().int().nonnegative().default(0),
      draw: z.number().int().nonnegative().optional(), // 2-innings only
    })
    .default({ win: 2, tie: 1, noResult: 1, loss: 0 }),
  superOver: z.boolean().default(false), // knockout tie resolution
  // spec 04 §2.3 — still-tied policy. ICC current conditions repeat the super
  // over until decided; boundary_count is the (2019) legacy rule kept for
  // community leagues; shared records the tie.
  superOverStillTied: z.enum(["repeat", "boundary_count", "shared"]).default("repeat"),
  dls: z
    .object({ enabled: z.boolean(), edition: z.literal("standard") })
    .default({ enabled: false, edition: "standard" }),
  followOn: z
    .object({ enabled: z.boolean(), lead: z.number().int().positive() })
    .optional(), // 2-innings only
  minOversForResult: z.number().int().nonnegative().default(5), // T20 5, ODI 20
  // W4 domain audit — player-review (DRS) allowance per innings per side.
  // Deliberately `.optional()` with NO default: an absent block means "no
  // declared allowance" (reviews are still recordable, just uncapped), and it
  // keeps every previously-parsed config byte-identical.
  reviews: z.object({ perInnings: z.number().int().nonnegative() }).optional(),
  // S3/W4b (#426) — what this variant lets a squad DO mid-fixture, feeding
  // `lineupPolicy` below. Three separate knobs rather than one "concussion
  // replacements allowed" boolean, because rulings 1 and 2 are independent
  // axes: growth is about who may arrive, re-entry about who may come back,
  // and the cap about how many arrivals are ordinary rather than exempt.
  //
  // `.optional()` with NO `.default()` at either level. `state.cfg` is
  // serialised inside every recorded state and compared by the frozen corpus,
  // so a defaulted key would appear in every stream ever recorded; an absent
  // block parses to an absent block and reproduces the pre-wave behaviour
  // exactly (no growth, no return, no exemption, no substitution).
  lineupChanges: z
    .object({
      // Ordinary substitutions per side. Absent ⇒ 0, which is Law 24: a
      // substitute may field but not bat, bowl or keep, so an ordinary
      // substitution changes nothing a scorecard records and none of the
      // shipped variants raises this. Present and positive is for the
      // community codes that do swap players outright.
      maxSubs: z.number().int().nonnegative().optional(),
      // Ruling 1 — like-for-like concussion (and, under the ICC's event
      // conditions, COVID/illness) replacements per side. A like-for-like
      // replacement CAN bat and bowl and is a person the team sheet never
      // named, so honouring one means letting the squad grow; that is exactly
      // why the row sat deferred until `core/lineup.ts` existed. Absent ⇒ 0 ⇒
      // no growth, which is ruling 1's stated default.
      concussionReplacements: z.number().int().nonnegative().optional(),
      // Ruling 2 — may a player who has LEFT THE FIELD take it again. ICC
      // conditions say no: the concussed player takes no further part in the
      // match. This knob is about the field only; a batter who retired hurt
      // never left it, and his resumption is governed by the crease
      // (`cricket.retire` → `fine.retiredNotOut`), not by this.
      reentry: z.enum(["none", "once", "unlimited"]).optional(),
    })
    .optional(),
});

export const CricketCfg = CricketCfgBase.refine(
  (cfg) =>
    cfg.maxOversPerBowler === undefined ||
    cfg.ballsPerInnings === null ||
    cfg.maxOversPerBowler <= Math.ceil(cfg.ballsPerInnings / cfg.ballsPerOver),
  { message: "maxOversPerBowler exceeds the innings length" },
)
  .refine((cfg) => !(cfg.followOn?.enabled === true) || cfg.inningsPerSide === 2, {
    message: "followOn requires inningsPerSide = 2",
  })
  .refine((cfg) => !cfg.superOver || cfg.inningsPerSide === 1, {
    message: "superOver requires inningsPerSide = 1",
  })
  .refine((cfg) => !cfg.dls.enabled || cfg.ballsPerInnings !== null, {
    message: "DLS requires a limited-overs config",
  })
  .refine(
    (cfg) =>
      cfg.ballsPerInnings === null ||
      cfg.minOversForResult * cfg.ballsPerOver <= cfg.ballsPerInnings,
    { message: "minOversForResult exceeds the innings length" },
  );
export type CricketCfg = z.infer<typeof CricketCfg>;

// ---------------------------------------------------------------------------
// Ev — spec 04 §2.2 (+ doc 14 §1 Tier-2 player lines)
// ---------------------------------------------------------------------------

const PersonId = z.string().min(1);

export const CricketExtras = z.strictObject({
  kind: z.enum(["wide", "noball", "bye", "legbye", "penalty"]),
  runs: z.number().int().positive(),
});

export const CricketWicket = z.strictObject({
  kind: z.enum([
    "bowled",
    "caught",
    "lbw",
    "runout",
    "stumped",
    "hitwicket",
    "retired",
    "obstructed",
    "timedout",
    // W4: Law 34 — the tenth mode of dismissal, credited to no bowler.
    "hitballtwice",
  ]),
  out: PersonId,
  /** The fielder who completed the dismissal: took the catch, broke the
   *  wicket, or effected the stumping. */
  fielder: PersonId.optional(),
  /** W4: the supporting fielder on a run out — the scorebook's
   *  "run out (thrower/breaker)". Requires `fielder` and must differ from it. */
  fielderAssist: PersonId.optional(),
  /** W4: the batter who comes in. Law 25.1 leaves the order after the openers
   *  entirely to the captain, so the lineup's orderNo is only the default. */
  incoming: PersonId.optional(),
  bowlerCredited: z.boolean(),
});

export const CricketBall = z.strictObject({
  over: z.number().int().nonnegative(),
  ballInOver: z.number().int().positive(),
  striker: PersonId,
  nonStriker: PersonId,
  bowler: PersonId,
  runs: z.strictObject({
    bat: z.number().int().nonnegative(),
    extras: CricketExtras.optional(),
  }),
  wicket: CricketWicket.optional(),
  boundary: z.union([z.literal(4), z.literal(6)]).optional(),
  freeHit: z.boolean().optional(),
  // S8/#417 W6b — 1-based innings number, the SAME convention
  // `CricketPlayerLine.innings` below already uses: an index into
  // `state.innings`, never `state.superOver.innings` (a super-over
  // delivery has no legitimate value here, and needs none —
  // `cricket.superover.ball` is already excluded from every playerStats
  // consumer, per the comment above `CRICKET_PLAYER_STATS`).
  //
  // RECORDED, not derived — which looks at odds with the position-axis row
  // in DOMAIN.md ("Where in the match an event happened"), which
  // deliberately rejected stamping a derived value for exactly the
  // "recorded and derived can silently disagree" reason. That rejection is
  // about `apply()`'s OWN state, which already tracks the open innings
  // itself, so a stamped copy there would be pure, provably redundant
  // duplication. `CRICKET_PLAYER_STATS.folded.fold` is a different consumer
  // bound by a different signature — `(events, ctx) => PlayerStatRow[]`, no
  // `State` parameter at all — so segmenting a flat ball list into innings
  // with no marker needs `coarsen()`'s own multi-signal heuristic or a full
  // apply() replay, both rejected there as disproportionate for a pure stat
  // fold (see `folded`'s own comment). `CricketPlayerLine.innings` already
  // carries the identical pattern for this exact fold; this completes that
  // precedent rather than setting a new one.
  //
  // `apply()` deliberately never reads this field. Validating it against the
  // real open innings (the way `applyPlayerLine` checks its own `innings`
  // against the closed-innings ledger) would need the same `strictFold`-only
  // gating every OTHER state-derived ball check above uses: a void or edit
  // upstream that shifts an auto-close boundary must never turn an
  // already-recorded, previously-valid ball into a throw with no event to
  // void (see `applyDelivery`'s comments). Left unvalidated, the worst a
  // stale stamp can do is mis-scope a best-effort leaderboard number in a
  // rare replay-shifted edge case — it can never touch score, result or
  // DLS, none of which read it.
  innings: z.number().int().positive().optional(),
});
export type CricketBallEv = z.infer<typeof CricketBall>;

// Coarse fidelity (spec §2.2). `partial: true` = in-progress snapshot: totals
// update an open innings and the fold's auto-close rules (all out / balls
// exhausted / target passed) decide closure — exactly the rules a fine
// innings closes under, which is what makes cfg-free coarsening possible.
// `boundaries` feeds the boundary-count tiebreak at coarse fidelity.
export const CricketInningsSummary = z.strictObject({
  runs: z.number().int().nonnegative(),
  wickets: z.number().int().nonnegative(),
  legalBalls: z.number().int().nonnegative(),
  declared: z.boolean().optional(),
  boundaries: z.number().int().nonnegative().optional(),
  partial: z.boolean().optional(),
});

export const CricketToss = z.strictObject({
  wonBy: EntrantId,
  elected: z.enum(["bat", "bowl"]),
});
export const CricketDeclare = z.strictObject({});
// W4: a scorebook always says WHY an innings ended. The three auto-closes
// (all out / overs complete / target reached) stay unstamped on purpose —
// they are exactly the `autoClose` predicates and so are derivable from the
// totals; stamping them would change every previously folded state.
export const CricketClose = z.strictObject({
  reason: z
    .enum(["all_out", "overs_complete", "target_reached", "time", "weather", "forfeited", "other"])
    .optional(),
});
export const CricketMatchClose = z.strictObject({}); // 2-innings time expiry ⇒ draw
export const CricketInterruption = z.strictObject({
  kind: z.enum(["rain", "light", "other"]),
  oversLostEstimate: z.number().int().nonnegative().optional(),
});
export const CricketRevise = z
  .strictObject({
    oversPerSide: z.number().int().positive().optional(),
    target: z.number().int().positive().optional(),
  })
  .refine((r) => r.oversPerSide !== undefined || r.target !== undefined, {
    message: "revise needs oversPerSide and/or target",
  });
export const CricketFollowOn = z.strictObject({});

// W4 domain audit — facts a scorebook records that had no home before.
//
// Law 25.4: "retired out" is a dismissal credited to no bowler; a batter who
// retires for any other reason ("retired not out" — hurt, ill, other) costs
// the side no wicket and may resume the innings later. Modelling both through
// the `wicket` grammar is impossible: that path always takes a wicket.
export const CricketRetire = z.strictObject({
  person: PersonId,
  reason: z.enum(["hurt", "out", "other"]),
  incoming: PersonId.optional(), // defaults to the next batter in the order
});

// Law 4.5 — the fielding captain may take a new ball after the prescribed
// number of overs; the scorer marks the point at which it was taken.
export const CricketNewBall = z.strictObject({});

// Limited-overs fielding-restriction blocks. `kind` is deliberately disjoint
// from CricketInterruption's so the structural union never confuses the two.
export const CricketPowerplay = z.strictObject({
  kind: z.enum(["mandatory", "batting", "bowling"]),
  phase: z.enum(["start", "end"]),
});

// Player reviews (DRS). `by` is the side the review is recorded against; an
// umpire review is recorded but never consumes that side's allowance.
export const CricketReview = z.strictObject({
  by: EntrantId,
  kind: z.enum(["player", "umpire"]),
  person: PersonId.optional(), // who called for it
  against: PersonId.optional(), // the batter the decision concerned
  outcome: z.enum(["upheld", "struck_down", "umpires_call"]),
});

// doc 14 §1 Tier 2 — post-match scorecard line, validated for sum-consistency
// against the innings totals.
//
// Owner ruling 12 (2026-09-05, S17) — band-2 lines gain SIX optional fields
// on top of the seven this schema shipped with: `batting.fours`/`.sixes`/
// `.dismissal` and `bowling.maidens`/`.wides`/`.noBalls`. The band stays 2 —
// nothing here is a delivery, so `applyPlayerLine` still cross-checks only
// the aspects it always has (runs/balls/wickets/legalBalls); these six are
// additive and carry no cross-check against `FineInnings` at all. Every
// pre-ruling-12 payload — one carrying none of them — still parses byte-
// identical, which is what keeps the golden corpus un-rebaselined.
//
// DELIBERATELY NO `.refine()` tying `fours`/`sixes` to `runs`, or `dismissal`
// to `out`, on THIS schema — found by running the full suite, not assumed.
// `batting.fours`, `batting.sixes`, `batting.dismissal.kind` and `batting.out`
// are each independent `PadField`/`PadAttribution` entries on
// `playerLineAction` below, and `testkit/conformance-pad.ts`'s property (b)
// (`checkActionPayloadsAccepted`) and (g) (`checkOmittedAttributionAcceptance`)
// fuzz every declared field/attribution item INDEPENDENTLY and require the
// schema to accept whatever in-bounds combination results — that is the
// exact contract a scorer's pad relies on (fields fillable in any order).
// A cross-field `.refine()` here reds both: the fuzzer freely pairs
// `out: false` with a fuzzed `dismissal` (property g, omitting only the
// OPTIONAL `dismissal.bowler` attribution item still leaves `dismissal.kind`
// and `.fielder` in the payload) and pairs high `fours`/`sixes` with a low
// `runs` (property b). `CricketWicket` already sets the precedent for this:
// its own "fielderAssist requires fielder" rule has no schema refine either
// (enforced only where `applyDelivery` builds a wicket, ~line 1142). Both
// checks below live in `applyPlayerLine` instead — exactly where that
// precedent, and this file's own conformance suite, say they belong.
export const CricketPlayerLine = z
  .strictObject({
    // 1-based innings number. `CricketBall.innings` (S8/#417 W6b) mirrors
    // this exact convention for the same reason — see its own comment.
    innings: z.number().int().positive(),
    person: PersonId,
    batting: z
      .strictObject({
        runs: z.number().int().nonnegative(),
        balls: z.number().int().nonnegative(),
        out: z.boolean().optional(),
        fours: z.number().int().nonnegative().optional(),
        sixes: z.number().int().nonnegative().optional(),
        // `kind` is the SAME enum object `CricketWicket.kind` uses — never a
        // second hand-copied list of the ten dismissal modes.
        dismissal: z
          .strictObject({
            kind: CricketWicket.shape.kind,
            bowler: PersonId.optional(),
            fielder: PersonId.optional(),
          })
          .optional(),
      })
      .optional(),
    bowling: z
      .strictObject({
        legalBalls: z.number().int().nonnegative(),
        runs: z.number().int().nonnegative(),
        wickets: z.number().int().nonnegative(),
        maidens: z.number().int().nonnegative().optional(),
        wides: z.number().int().nonnegative().optional(),
        noBalls: z.number().int().nonnegative().optional(),
      })
      .optional(),
  })
  .refine((line) => line.batting !== undefined || line.bowling !== undefined, {
    message: "player line needs a batting and/or bowling aspect",
  });

export const CricketEv = z.union([
  CricketBall,
  CricketInningsSummary,
  CricketToss,
  CricketDeclare,
  CricketClose,
  CricketMatchClose,
  CricketInterruption,
  CricketRevise,
  CricketFollowOn,
  CricketPlayerLine,
  // W4 branches are appended, never interleaved: z.union takes the first
  // branch that parses, so every pre-wave payload still resolves to exactly
  // the branch it resolved to before.
  CricketRetire,
  CricketNewBall,
  CricketPowerplay,
  CricketReview,
]);
export type CricketEv = z.infer<typeof CricketEv>;

// S6/#416 (W5) — event type -> its own payload schema, the SAME schema
// OBJECT REFERENCES already used as CricketEv's union members and in
// apply()'s dispatch switch below, now also keyed by type string in one
// place. `eventSchema` carries no per-branch discriminant (the type string
// lives only on the envelope), so without this registry there was no way to
// enumerate "every branch, with its type string" short of parsing the
// dispatch switch. `testkit/conformance-pad.ts` asserts this is a bijection
// onto CricketEv's 14 branches, by reference and deduped: `cricket.ball` and
// `cricket.superover.ball` deliberately share ONE schema object below (a
// super-over delivery is literally the same shape as an ordinary one), so
// this map has 15 keys over 14 distinct schemas — a raw key-count bijection
// would be the wrong invariant here, and the conformance check is written
// for exactly that.
export const CRICKET_EVENT_SCHEMAS: Readonly<Record<string, z.ZodTypeAny>> = {
  "cricket.toss": CricketToss,
  "cricket.ball": CricketBall,
  "cricket.superover.ball": CricketBall,
  "cricket.innings.summary": CricketInningsSummary,
  "cricket.innings.declare": CricketDeclare,
  "cricket.innings.close": CricketClose,
  "cricket.match.close": CricketMatchClose,
  "cricket.interruption": CricketInterruption,
  "cricket.revise": CricketRevise,
  "cricket.followon": CricketFollowOn,
  "cricket.player.line": CricketPlayerLine,
  "cricket.retire": CricketRetire,
  "cricket.newball": CricketNewBall,
  "cricket.powerplay": CricketPowerplay,
  "cricket.review": CricketReview,
};

// ---------------------------------------------------------------------------
// State — spec §2.2 layered design: InningsState.{runs,wickets,legalBalls}
// is the InningsTotals every downstream computation reads.
// ---------------------------------------------------------------------------

type Side = "home" | "away";

/** W4 — per-fielder dismissal credit, the fielding half of a scorecard. */
export interface FieldingCredit {
  catches: number;
  runOuts: number;
  stumpings: number;
}

/** W4 — a powerplay block, measured in legal balls from the innings start.
 *  `toBalls: null` = still open. */
export interface PowerplayBlock {
  kind: "mandatory" | "batting" | "bowling";
  fromBalls: number;
  toBalls: number | null;
}

/** W4 — reviews taken by each side during one innings, and how many of them
 *  were spent (struck down). */
export interface ReviewLedger {
  taken: number;
  lost: number;
}

export interface FineInnings {
  striker: string | null; // null = awaiting replacement (super over only)
  nonStriker: string | null;
  nextBatterIndex: number; // cursor into the batting order (main innings)
  dismissed: string[];
  currentBowler: string | null; // null = new over pending
  prevOverBowler: string | null;
  freeHitPending: boolean;
  batterRuns: Record<string, number>;
  batterBalls: Record<string, number>;
  bowlerBalls: Record<string, number>;
  bowlerRuns: Record<string, number>;
  bowlerWickets: Record<string, number>;
  extras: number;
  // W4 additions. Every one of them stays `undefined` until the fact it
  // records actually occurs — JSON.stringify omits undefined-valued keys, so
  // an innings that uses none of them serialises exactly as it did pre-wave
  // (which is what the frozen golden corpus compares).
  fielding?: Record<string, FieldingCredit> | undefined;
  retiredNotOut?: string[] | undefined;
  /** Person who just walked in and has not faced a ball (not a wide). The
   *  next ball may name a different eligible batter at that crease end —
   *  the same window as `currentBowler === null` for a new over. Surviving
   *  partners who have 0 balls are NOT this; only the replacement. */
  unfacedIncoming?: string | undefined;
}

export interface InningsState {
  battingSide: Side;
  runs: number;
  wickets: number;
  legalBalls: number;
  boundaries: number;
  declared: boolean;
  closed: boolean;
  ballsLimit: number | null; // quota at this point (revise updates it)
  fine: FineInnings | null; // null = coarse innings
  // W4 additions — same undefined-until-used discipline as FineInnings.
  closeReason?: z.infer<typeof CricketClose>["reason"] | undefined;
  newBallAt?: number[] | undefined;
  powerplays?: PowerplayBlock[] | undefined;
  reviews?: Record<Side, ReviewLedger> | undefined;
}

interface PlayerLineRec {
  innings: number;
  person: string;
  // S17/owner ruling 12 — fours/sixes/dismissal and maidens/wides/noBalls
  // are OPTIONAL, mirroring `CricketPlayerLine` exactly (this is stored
  // straight off the validated payload — see `applyPlayerLine`'s `record`).
  batting?: {
    runs: number;
    balls: number;
    out?: boolean;
    fours?: number;
    sixes?: number;
    dismissal?: { kind: z.infer<typeof CricketWicket>["kind"]; bowler?: string; fielder?: string };
  };
  bowling?: { legalBalls: number; runs: number; wickets: number; maidens?: number; wides?: number; noBalls?: number };
}

/**
 * How a decided cricket match was won, as DATA — owner decision 2026-09-16.
 *
 * This used to be English prose the reducer composed itself ("by 12 runs",
 * "by 1 wicket", "by an innings and 50 runs", "Super Over", "on boundary
 * count"), and the web passed it verbatim into every locale's result sentence,
 * so an es/fr/nl spectator read "ganó by 12 runs". The engine now states the
 * fact and the web owns the words, the word order and the plural (which is a
 * per-locale `Intl.PluralRules` question — French selects `one` for 0 as well
 * as 1 — and so could never be answered here).
 *
 * The kinds are exactly the five margins `decideWin` is called with; nothing is
 * invented. The two things this deliberately does NOT carry:
 * - DLS. It is a METHOD, not a margin: a DLS result is still won by runs or by
 *   wickets, and `outcome.method === "dls"` already says so by name. Copying
 *   it here would be a second authority for one fact.
 * - tie / draw / no_result / award. Those are `outcome.kind`s with no winner
 *   and nothing to measure, so their margin is `null`, as it always was.
 *
 * `value` is the bare count — runs, wickets in hand, or the runs beyond the
 * innings — never pre-inflected, so a margin of one is the number 1.
 */
export const CRICKET_COUNTED_MARGIN_KINDS = ["runs", "wickets", "innings_and_runs"] as const;
export const CRICKET_MARGIN_KINDS = [...CRICKET_COUNTED_MARGIN_KINDS, "super_over", "boundary_count"] as const;
export type CricketMargin =
  | { kind: (typeof CRICKET_COUNTED_MARGIN_KINDS)[number]; value: number }
  | { kind: "super_over" }
  | { kind: "boundary_count" };

export interface CricketState {
  cfg: CricketCfg;
  entrants: { home: string; away: string };
  orders: { home: string[]; away: string[] }; // batting order = LineupSlot.order_no
  phase: "pre" | "live" | "super_over" | "done" | "final";
  battingFirst: Side;
  tossTaken: boolean;
  innings: InningsState[];
  followOnEnforced: boolean;
  quota: number | null; // current balls-per-innings (post-revise)
  revisedTarget: number | null;
  targetSource: "dls" | "manual" | null;
  r1: number | null; // DLS resources available, first innings (spec §2.5)
  r2: number | null; // …and the chase
  interruptions: number;
  superOver: {
    innings: InningsState[];
    dismissed: { home: string[]; away: string[] };
  } | null;
  outcome: MatchOutcome | null;
  margin: CricketMargin | null;
  playerLines: PlayerLineRec[];
  // S3/W4b (#426) — the kernel's squad, persisted by `onLineup`. Structurally a
  // `SquadCarrier` (src/sports/squad-state.ts), which is what lets cricket share
  // the adoption rule with every other pass-B sport instead of inventing one.
  //
  // ABSENT UNTIL A `core.lineup.*` EVENT IS FOLDED, and that is not an
  // optimisation — `init` writing it would put a copy of the team sheet into
  // every serialised state, and the frozen corpus compares `JSON.stringify` per
  // event across eleven sports. It is also NOT the source of truth: the
  // authoritative squads are `foldMatchWithStoppage(...).squads`, which the
  // kernel returns whether or not any module persisted them. This copy exists
  // so cricket's own fold can keep `orders` honest.
  squads?: SquadState;
}

// One adopter per module. It owns the `init`-vs-change handshake by object
// identity — see src/sports/squad-state.ts for why a shape test cannot do it
// (a `core.lineup.position` bumps no counter anywhere in SquadState).
const squadAdopter = makeSquadAdopter<CricketState>();

function opponent(side: Side): Side {
  return side === "home" ? "away" : "home";
}

function invalid(message: string, data?: unknown): never {
  throw new EngineError("INVALID_EVENT", message, data);
}

function wrongPhase(message: string, data?: unknown): never {
  throw new EngineError("WRONG_PHASE", message, data);
}

function sideOf(state: CricketState, entrantId: string): Side {
  if (entrantId === state.entrants.home) return "home";
  if (entrantId === state.entrants.away) return "away";
  invalid(`unknown entrant "${entrantId}"`, { entrantId });
}

function parsePayload<T>(schema: z.ZodType<T>, payload: unknown, type: string): T {
  const parsed = schema.safeParse(payload);
  if (!parsed.success) invalid(`invalid ${type} payload`, { issues: parsed.error.issues });
  return parsed.data;
}

// All-out threshold — spec §2.3: playersPerSide − 1 partnerships; bounded by
// the actual lineup so short lineups stay consistent across both fidelities.
//
// #451 — this is ALSO the DLS wickets scale (every `resourcesFromBalls` call
// below passes it). The alternative was the stable cfg-derived
// `cfg.playersPerSide − 1`, on the grounds that the lineup is supplied at read
// time and so a squad edit could move the scale under a recorded ledger.
// Rejected, because:
//   1. The DLS column means "how much of THIS innings' batting is gone", and
//      the innings ends at exactly this threshold (`autoClose` below reads the
//      same function). Scaling by anything else puts an all-out side somewhere
//      other than the last column — which is defect #451 itself, in miniature.
//   2. It introduces no NEW replay instability: `allOutWickets` already gates
//      the all-out close, so a lineup edit that moves it already moves the
//      innings result. A DLS scale that stayed put while the close moved would
//      make the two disagree.
// `state.orders` is written once, by `init`, and is never reassigned by the
// fold, so the scale is constant for the whole of one replay.
function allOutWickets(state: CricketState, side: Side): number {
  const order = state.orders[side];
  const players = Math.min(state.cfg.playersPerSide, order.length || state.cfg.playersPerSide);
  return Math.max(1, players - 1);
}

// spec §2.4 — decimalised overs with ballsPerOver generality (display only;
// the ledger stays integer balls).
function oversText(balls: number, ballsPerOver: number): string {
  const whole = Math.floor(balls / ballsPerOver);
  const rem = balls % ballsPerOver;
  return rem === 0 ? `${whole}` : `${whole}.${rem}`;
}


/**
 * THE innings list actually being played, and how many innings precede it.
 *
 * ONE definition, read by the position axis below AND by the v3 pad
 * (`skins/cricket.tsx`), so the two cannot fork on the question "which
 * innings am I looking at". They did fork: the pad re-derived it as
 * `state.innings` alone and therefore spent every super over describing the
 * innings before it — a frozen score, a stale target, the wrong bowler, and
 * a delivery row disabled by a closure that was not the match's.
 *
 * Structural and generic rather than taking `CricketState`, for the same
 * reason `nextBattingSide` is: the pad holds a narrowed shape of the state
 * and must be able to call this without either owning the full type or
 * casting a partial object into one.
 *
 * THE SUPER OVER CONTINUES THE INNINGS COUNT, so `offset` is the main
 * innings' length, never 0 — numbering a super over 1 and 2 would send
 * position BACKWARDS mid-fixture, and W6 sorts a timeline by it.
 *
 * An EMPTY super-over list is still the active list. `decideTie` creates
 * `superOver` with no innings in it, and the pad meets exactly that state
 * between the tie and the first super-over ball; answering `state.innings`
 * there is what told the pad the match was over.
 */
export interface ActiveInnings<T> {
  list: readonly T[];
  offset: number;
  inSuperOver: boolean;
}

export function activeInnings<T>(m: {
  innings: readonly T[];
  superOver: { innings: readonly T[] } | null | undefined;
}): ActiveInnings<T> {
  const so = m.superOver;
  if (so === null || so === undefined) {
    return { list: m.innings, offset: 0, inSuperOver: false };
  }
  return { list: so.innings, offset: m.innings.length, inSuperOver: true };
}

/**
 * W4a (#425) T6b — "Innings 2 · Over 12.3", the cross-sport position axis.
 *
 * THE OVER COMES FROM `legalBalls`, AND ONLY FROM `legalBalls`. An innings also
 * carries `extras`, an integer on the same object that also counts deliveries,
 * and only one of the two is the over reading — three wides into an over and
 * the scoreboard still says 0.3. A producer that reached for the other one
 * compiles, folds and reads plausibly; it shows up as a timeline that files a
 * wicket in the wrong over, which is the `DisciplineCard.entrantSide` shape
 * again. `oversText` is the module's own notation, shared with `summary`, so an
 * over is spelled one way everywhere.
 *
 * THE SUPER OVER CONTINUES THE INNINGS COUNT rather than restarting at 1: its
 * innings are the third and fourth of the match. Numbering them 1 and 2 would
 * send position BACKWARDS mid-fixture, and W6 sorts a timeline by this.
 * Delegates to `activeInnings` (above) rather than keeping its own copy of
 * the superOver/offset switch — see that function's own doc for why.
 */
function cricketPosition(state: CricketState): MatchPosition {
  const live = state.outcome === null;
  const { list, offset } = activeInnings<InningsState>(state);
  const number = unitNumber({
    // An innings is opened on its first ball, so `length` counts innings
    // STARTED — which is what keeps a match abandoned mid-innings from
    // reporting the innings before it.
    started: list.length,
    completed: list.filter((innings) => innings.closed).length,
    live,
  });
  const balls = list[number - 1]?.legalBalls ?? 0;
  return {
    segments: [
      unitSegment("innings", "Innings", offset + number),
      labelledSegment("over", "Over", oversText(balls, state.cfg.ballsPerOver), balls),
    ],
  };
}


// ---------------------------------------------------------------------------
// Innings sequencing — spec §2.3 / cricket.md §3
// ---------------------------------------------------------------------------

function maxInningsCount(cfg: CricketCfg): number {
  return cfg.inningsPerSide * 2;
}

// Only the fields battingSideAt/nextBattingSide actually read — narrower on
// purpose than CricketState so nextBattingSide (below, exported) can be
// called by a caller that does not hold a full CricketState (e.g. apps/web's
// v3 cricket skin, whose PadHostView.state/.cfg are `unknown` by the
// chassis's own contract and re-derive a narrow, all-optional local shape
// rather than importing this module's real types). Every existing internal
// call site passes a real CricketState, which trivially satisfies this
// narrower shape (structural typing) — no behaviour change.
interface BattingAlternationCfg {
  battingFirst: Side;
  cfg: { inningsPerSide: 1 | 2 };
  followOnEnforced: boolean;
}

function battingSideAt(state: BattingAlternationCfg, index: number): Side {
  const first = state.battingFirst;
  if (state.cfg.inningsPerSide === 1) return index === 0 ? first : opponent(first);
  if (state.followOnEnforced) {
    // F, S, S, F
    return index === 0 || index === 3 ? first : opponent(first);
  }
  return index % 2 === 0 ? first : opponent(first);
}

/**
 * Public mirror of `battingSideAt`/`maxInningsCount` (both private, above) —
 * purpose-built for a caller outside this module that does not hold a full
 * `CricketState` (apps/web's v3 cricket skin: `skins/cricket.tsx`'s own
 * "Defensive shape probes" header explains why `PadHostView.state`/`.cfg`
 * are read as `unknown` and re-derived into a narrow, all-optional local
 * shape rather than importing engine types directly). Exported so that
 * caller can ask "who bats the next innings, if one is still due" without
 * hand-copying the alternation/follow-on rule — a forked copy is the
 * recurring defect class this repo has hit before (drifts silently the next
 * time this rule changes here and not there).
 *
 * `inningsCount` is `state.innings.length` — the SAME addressing
 * `createInnings` uses for `index` (above) — and the `null` return is the
 * same "no further innings is due" case `createInnings` enforces by
 * throwing (`index >= maxInningsCount(cfg)` -> `invalid("all innings
 * already recorded")`); a caller asking "who's next" before an illegal
 * event is ever submitted is not making an illegal request itself, so this
 * reports the dead end as data instead of throwing.
 */
export function nextBattingSide(
  state: BattingAlternationCfg & { inningsCount: number },
): Side | null {
  if (state.inningsCount >= state.cfg.inningsPerSide * 2) return null;
  return battingSideAt(state, state.inningsCount);
}

function aggregate(state: CricketState, side: Side): number {
  return state.innings.reduce(
    (sum, innings) => (innings.battingSide === side ? sum + innings.runs : sum),
    0,
  );
}

function isChaseIndex(state: CricketState, index: number): boolean {
  return index === maxInningsCount(state.cfg) - 1;
}

// Runs the batting side of the final innings needs to win (spec §2.3).
export function chaseTarget(state: CricketState): number {
  if (state.cfg.inningsPerSide === 1) {
    if (state.revisedTarget !== null) return state.revisedTarget;
    const first = state.innings[0];
    return (first?.runs ?? 0) + 1;
  }
  const chaseSide = battingSideAt(state, 3);
  const own = state.innings
    .slice(0, 3)
    .reduce((sum, innings) => (innings.battingSide === chaseSide ? sum + innings.runs : sum), 0);
  return aggregate(state, opponent(chaseSide)) - own + 1;
}

function openInnings(state: CricketState): { innings: InningsState; index: number } | null {
  const index = state.innings.length - 1;
  const innings = state.innings[index];
  if (innings === undefined || innings.closed) return null;
  return { innings, index };
}

function freshFine(): FineInnings {
  return {
    striker: null,
    nonStriker: null,
    nextBatterIndex: 0,
    dismissed: [],
    currentBowler: null,
    prevOverBowler: null,
    freeHitPending: false,
    batterRuns: {},
    batterBalls: {},
    bowlerBalls: {},
    bowlerRuns: {},
    bowlerWickets: {},
    extras: 0,
  };
}

/** First unused slot in `order` after the named openers. Default openers
 *  (order[0]/[1]) still yield 2 — the pre-named-opener cursor — so existing
 *  streams that never name a pair keep their auto-walk. Custom openers
 *  (Law 25.1) yield the earliest leftover, which may be 0. */
function nextBatterIndexAfterOpeners(
  order: readonly string[],
  striker: string,
  nonStriker: string,
): number {
  for (let i = 0; i < order.length; i++) {
    if (order[i] !== striker && order[i] !== nonStriker) return i;
  }
  return order.length;
}

function resolveOpeners(
  order: readonly string[],
  named: { striker: string; nonStriker: string } | undefined,
): { striker: string; nonStriker: string; nextBatterIndex: number } {
  const striker = named?.striker ?? order[0];
  const nonStriker = named?.nonStriker ?? order[1];
  if (striker === undefined || nonStriker === undefined) {
    invalid("batting order must name at least two batters");
  }
  if (striker === nonStriker) invalid("striker and non-striker must differ");
  if (!order.includes(striker)) invalid(`batter "${striker}" is not in the lineup`);
  if (!order.includes(nonStriker)) invalid(`batter "${nonStriker}" is not in the lineup`);
  return { striker, nonStriker, nextBatterIndex: nextBatterIndexAfterOpeners(order, striker, nonStriker) };
}

// Creates the next innings (on the first scoring event for it).
function createInnings(
  state: CricketState,
  fidelity: "fine" | "coarse",
  openers?: { striker: string; nonStriker: string },
): CricketState {
  const index = state.innings.length;
  if (index >= maxInningsCount(state.cfg)) invalid("all innings already recorded");
  const battingSide = battingSideAt(state, index);
  let fine: FineInnings | null = null;
  if (fidelity === "fine") {
    const order = state.orders[battingSide];
    if (order.length < 2) {
      invalid(`batting order for "${state.entrants[battingSide]}" needs at least 2 players`);
    }
    const pair = resolveOpeners(order, openers);
    fine = {
      ...freshFine(),
      // spec §2.3 — openers from the first ball when named, else lineup order.
      striker: pair.striker,
      nonStriker: pair.nonStriker,
      nextBatterIndex: pair.nextBatterIndex,
    };
  }
  const innings: InningsState = {
    battingSide,
    runs: 0,
    wickets: 0,
    legalBalls: 0,
    boundaries: 0,
    declared: false,
    closed: false,
    ballsLimit: state.quota,
    fine,
  };
  let next: CricketState = { ...state, innings: [...state.innings, innings] };
  // DLS bookkeeping (spec §2.5) — resources available at innings start.
  if (state.quota !== null) {
    const res = resourcesFromBalls(state.quota, 0, allOutWickets(state, battingSide));
    if (index === 0 && next.r1 === null) next = { ...next, r1: res };
    if (state.cfg.inningsPerSide === 1 && index === 1 && next.r2 === null) {
      next = { ...next, r2: res };
      next = maybeComputeDlsTarget(next);
    }
  }
  return next;
}

function replaceInnings(state: CricketState, index: number, innings: InningsState): CricketState {
  const list = state.innings.map((entry, i) => (i === index ? innings : entry));
  return { ...state, innings: list };
}

// ---------------------------------------------------------------------------
// Result determination — spec §2.3
// ---------------------------------------------------------------------------

function decideWin(
  state: CricketState,
  winnerSide: Side,
  method: string,
  margin: CricketMargin,
): CricketState {
  return {
    ...state,
    phase: "done",
    outcome: {
      kind: "win",
      winner: state.entrants[winnerSide],
      loser: state.entrants[opponent(winnerSide)],
      method,
    },
    margin,
  };
}

function decideTie(state: CricketState): CricketState {
  // spec §2.3 — tie → super over when configured (fold superover.* events
  // recursively); otherwise the tie stands (league: 1 pt each).
  if (state.cfg.superOver) {
    return {
      ...state,
      phase: "super_over",
      superOver: state.superOver ?? { innings: [], dismissed: { home: [], away: [] } },
    };
  }
  return { ...state, phase: "done", outcome: { kind: "tie" }, margin: null };
}

// Runs after every innings close; owns the whole §2.3 result table.
function decideAfterClose(state: CricketState): CricketState {
  const cfg = state.cfg;
  const count = state.innings.length;
  const methodSuffix = state.targetSource !== null ? "dls" : "regulation";

  if (cfg.inningsPerSide === 1) {
    if (count < 2) return state; // innings break
    const chase = state.innings[1] as InningsState;
    const target = chaseTarget(state);
    if (chase.runs >= target) {
      const wicketsLeft = allOutWickets(state, chase.battingSide) - chase.wickets;
      return decideWin(state, chase.battingSide, methodSuffix, { kind: "wickets", value: wicketsLeft });
    }
    if (chase.runs === target - 1) return decideTie(state);
    const runs = target - 1 - chase.runs;
    return decideWin(state, opponent(chase.battingSide), methodSuffix, { kind: "runs", value: runs });
  }

  // Two innings per side — spec §2.3 test rules.
  const done: Record<Side, number> = { home: 0, away: 0 };
  for (const innings of state.innings) done[innings.battingSide]++;
  const aggHome = aggregate(state, "home");
  const aggAway = aggregate(state, "away");

  if (count === 4) {
    const chase = state.innings[3] as InningsState;
    const chaseSide = chase.battingSide;
    const chaseAgg = chaseSide === "home" ? aggHome : aggAway;
    const otherAgg = chaseSide === "home" ? aggAway : aggHome;
    if (chaseAgg > otherAgg) {
      const wicketsLeft = allOutWickets(state, chaseSide) - chase.wickets;
      return decideWin(state, chaseSide, "regulation", { kind: "wickets", value: wicketsLeft });
    }
    if (chaseAgg === otherAgg) return decideTie(state);
    const runs = otherAgg - chaseAgg;
    return decideWin(state, opponent(chaseSide), "regulation", { kind: "runs", value: runs });
  }

  // Innings victory: a side finished both innings still behind an opponent
  // that batted once (spec §2.3 "innings victory").
  for (const side of ["home", "away"] as const) {
    const other = opponent(side);
    const sideAgg = side === "home" ? aggHome : aggAway;
    const otherAgg = side === "home" ? aggAway : aggHome;
    if (done[side] === 2 && done[other] === 1 && sideAgg < otherAgg) {
      const runs = otherAgg - sideAgg;
      return decideWin(state, other, "innings", { kind: "innings_and_runs", value: runs });
    }
  }
  return state;
}

// Close the open innings (auto or manual) and run the result table. `bpo`
// balls-exhausted, all-out and target-passed closes flow through here from
// both fidelities.
function closeOpenInnings(
  state: CricketState,
  declared: boolean,
  reason?: z.infer<typeof CricketClose>["reason"],
): CricketState {
  const open = openInnings(state);
  if (open === null) invalid("no innings in progress");
  const closed: InningsState = {
    ...open.innings,
    declared,
    closed: true,
    ...(reason === undefined ? {} : { closeReason: reason }),
  };
  return decideAfterClose(replaceInnings(state, open.index, closed));
}

// Auto-close rules — the single source of truth for when an innings ends
// without an explicit event (spec §2.3): target passed, all out, balls
// exhausted. Shared by ball- and summary-fidelity application.
function autoClose(state: CricketState): CricketState {
  const open = openInnings(state);
  if (open === null) return state;
  const { innings, index } = open;
  const chasing = isChaseIndex(state, index);
  if (chasing && state.innings.length >= 2 && innings.runs >= chaseTarget(state)) {
    return closeOpenInnings(state, false);
  }
  if (innings.wickets >= allOutWickets(state, innings.battingSide)) {
    return closeOpenInnings(state, false);
  }
  if (innings.ballsLimit !== null && innings.legalBalls >= innings.ballsLimit) {
    return closeOpenInnings(state, false);
  }
  return state;
}

// ---------------------------------------------------------------------------
// DLS folding — spec §2.5 (revise events carry the umpire-confirmed numbers;
// our Standard-Edition computation fills the target when cfg.dls is on and no
// manual target was given; a manual target always wins).
// ---------------------------------------------------------------------------

function maybeComputeDlsTarget(state: CricketState): CricketState {
  if (
    !state.cfg.dls.enabled ||
    state.targetSource === "manual" ||
    state.cfg.inningsPerSide !== 1 ||
    state.innings.length < 1 ||
    !(state.innings[0] as InningsState).closed ||
    state.r1 === null ||
    state.r2 === null
  ) {
    return state;
  }
  const s1 = (state.innings[0] as InningsState).runs;
  if (Math.abs(state.r2 - state.r1) < 1e-9) {
    // Equal resources ⇒ no revision needed.
    return state.targetSource === "dls" ? { ...state, revisedTarget: s1 + 1 } : state;
  }
  return {
    ...state,
    revisedTarget: dlsTarget(s1, state.r1, state.r2),
    targetSource: "dls",
  };
}

function applyRevise(
  state: CricketState,
  payload: z.infer<typeof CricketRevise>,
  strict: boolean,
): CricketState {
  if (state.phase !== "pre" && state.phase !== "live") {
    wrongPhase(`revise not allowed in phase "${state.phase}"`);
  }
  if (state.quota === null) invalid("revise applies to limited-overs matches only");
  if (state.cfg.inningsPerSide !== 1) invalid("revise applies to single-innings matches only");
  const bpo = state.cfg.ballsPerOver;
  let next = state;

  if (payload.oversPerSide !== undefined) {
    const newLimit = payload.oversPerSide * bpo;
    const open = openInnings(next);
    if (open !== null) {
      const { innings, index } = open;
      // STRICT ONLY (§3.3 seam), like the three checks in `applySummary`. Both
      // sides of this comparison are cfg-derived: the quota is
      // `oversPerSide × cfg.ballsPerOver` while the innings is recorded in
      // BALLS, so shortening the over shrinks the limit under history that
      // cannot move. Ungated, an umpire-confirmed revise the ledger already
      // holds is refused on every read, with nothing to void. What the revise
      // MEANS on replay is unchanged — the quota is set to the recorded number
      // of overs, and `autoClose` reads it the same way it always did.
      if (strict && newLimit < innings.legalBalls) {
        invalid("revised overs are below the balls already bowled", {
          legalBalls: innings.legalBalls,
          newLimit,
        });
      }
      if (innings.ballsLimit !== null) {
        // Resources lost = remaining before − remaining after, at the current
        // wickets (Standard Edition interruption accounting). Balls and raw
        // wickets go in; `resourcesFromBalls` owns both unit conversions (#451).
        const allOut = allOutWickets(next, innings.battingSide);
        const before = resourcesFromBalls(
          innings.ballsLimit - innings.legalBalls,
          innings.wickets,
          allOut,
        );
        const after = resourcesFromBalls(newLimit - innings.legalBalls, innings.wickets, allOut);
        const lost = before - after;
        if (index === 0 && next.r1 !== null) next = { ...next, r1: next.r1 - lost };
        if (index === 1 && next.r2 !== null) next = { ...next, r2: next.r2 - lost };
      }
      next = replaceInnings(next, index, { ...innings, ballsLimit: newLimit });
    } else if (next.innings.length === 1 && next.quota !== null) {
      // Between innings: the chase quota (and its resources) shrink.
      const chaseSide = battingSideAt(next, 1);
      next = {
        ...next,
        r2: resourcesFromBalls(newLimit, 0, allOutWickets(next, chaseSide)),
      };
    }
    next = { ...next, quota: newLimit };
  }

  if (payload.target !== undefined) {
    next = { ...next, revisedTarget: payload.target, targetSource: "manual" };
  } else {
    next = maybeComputeDlsTarget(next);
  }

  // A shrunk quota or lowered target can resolve the match immediately.
  return autoClose(next);
}

// core.abandon — spec §2.3: no_result below the minimum, DLS par decision
// beyond it (method 'dls'); 2-innings matches are drawn.
function applyAbandon(state: CricketState): CricketState {
  if (state.phase === "done" || state.phase === "final") wrongPhase("match already over");
  if (state.cfg.inningsPerSide === 2) {
    return { ...state, phase: "done", outcome: { kind: "draw" }, margin: null };
  }
  if (state.phase === "super_over") {
    // Main match already tied; the abandoned decider leaves the tie standing.
    return { ...state, phase: "done", outcome: { kind: "tie" }, margin: null };
  }
  const open = openInnings(state);
  const chase = open !== null && isChaseIndex(state, open.index) ? open.innings : null;
  const minBalls = state.cfg.minOversForResult * state.cfg.ballsPerOver;
  if (
    chase !== null &&
    state.cfg.dls.enabled &&
    state.quota !== null &&
    chase.legalBalls >= minBalls &&
    state.r1 !== null &&
    state.r2 !== null &&
    chase.ballsLimit !== null
  ) {
    const s1 = (state.innings[0] as InningsState).runs;
    const remaining = resourcesFromBalls(
      chase.ballsLimit - chase.legalBalls,
      chase.wickets,
      allOutWickets(state, chase.battingSide),
    );
    const par = dlsPar(s1, state.r1, state.r2, state.r2 - remaining);
    if (chase.runs > par) {
      const runs = chase.runs - par;
      return decideWin(state, chase.battingSide, "dls", { kind: "runs", value: runs });
    }
    if (chase.runs === par) {
      return { ...state, phase: "done", outcome: { kind: "tie" }, margin: null };
    }
    const runs = par - chase.runs;
    return decideWin(state, opponent(chase.battingSide), "dls", { kind: "runs", value: runs });
  }
  return { ...state, phase: "done", outcome: { kind: "no_result" }, margin: null };
}

// ---------------------------------------------------------------------------
// Ball application — spec §2.2 grammar + legality rules
// ---------------------------------------------------------------------------

const BOWLER_CREDITED_KINDS = new Set(["bowled", "caught", "lbw", "stumped", "hitwicket"]);

// W4 — which dismissals put a fielder in the scorebook, and under which column.
const FIELDER_CREDIT_COLUMN: Record<string, keyof FieldingCredit> = {
  caught: "catches",
  stumped: "stumpings",
  runout: "runOuts",
  obstructed: "runOuts",
};

function bumpFielding(
  fielding: Record<string, FieldingCredit> | undefined,
  person: string,
  column: keyof FieldingCredit,
): Record<string, FieldingCredit> {
  const existing = fielding?.[person] ?? { catches: 0, runOuts: 0, stumpings: 0 };
  return { ...fielding, [person]: { ...existing, [column]: existing[column] + 1 } };
}

// Validates the fielders named on a dismissal and folds their credit. Returns
// the previous map untouched when no fielder was named, so an innings that
// never names one keeps `fielding` undefined.
function creditFielding(
  fielding: Record<string, FieldingCredit> | undefined,
  wicket: z.infer<typeof CricketWicket>,
  bowlingOrder: readonly string[],
): Record<string, FieldingCredit> | undefined {
  const { fielder, fielderAssist } = wicket;
  if (fielderAssist !== undefined && fielder === undefined) {
    invalid("fielderAssist needs a primary fielder");
  }
  if (fielderAssist !== undefined && fielderAssist === fielder) {
    invalid("fielderAssist must differ from the primary fielder");
  }
  for (const person of [fielder, fielderAssist]) {
    if (person !== undefined && !bowlingOrder.includes(person)) {
      invalid(`fielder "${person}" is not in the fielding lineup`);
    }
  }
  if (fielder === undefined) return fielding;
  const column = FIELDER_CREDIT_COLUMN[wicket.kind];
  if (column === undefined) return fielding; // named but not a fielding dismissal
  let next = bumpFielding(fielding, fielder, column);
  if (fielderAssist !== undefined) next = bumpFielding(next, fielderAssist, "runOuts");
  return next;
}

// The next batter by lineup order, skipping anyone who is unavailable
// (dismissed, at the crease, or retired not out). Pre-W4 streams never hit
// the skip — the cursor is monotone and only ever pointed at a batter who had
// not yet batted — so this is behaviour-identical for them.
function nextBatterFrom(
  order: readonly string[],
  fromIndex: number,
  unavailable: ReadonlySet<string>,
): { person: string; index: number } | null {
  for (let i = fromIndex; i < order.length; i++) {
    const person = order[i] as string;
    if (unavailable.has(person)) continue;
    return { person, index: i + 1 };
  }
  return null;
}

/** Resolves who walks in after a batter leaves the crease, honouring an
 *  explicitly named `incoming` (captain's choice, or a retired-not-out batter
 *  resuming). Returns the replacement plus the advanced order cursor and the
 *  remaining retired-not-out list. */
function resolveIncoming(
  incoming: string | undefined,
  ctx: {
    battingOrder: readonly string[];
    dismissed: readonly string[];
    retiredNotOut: readonly string[];
    atCrease: readonly (string | null)[];
    nextBatterIndex: number;
  },
): { person: string; index: number; retiredNotOut: string[] } {
  const crease = ctx.atCrease.filter((p): p is string => p !== null);
  if (incoming !== undefined) {
    if (!ctx.battingOrder.includes(incoming)) {
      invalid(`incoming batter "${incoming}" is not in the lineup`);
    }
    if (ctx.dismissed.includes(incoming)) {
      invalid(`incoming batter "${incoming}" is already out`);
    }
    if (crease.includes(incoming)) {
      invalid(`incoming batter "${incoming}" is already at the crease`);
    }
    return {
      person: incoming,
      index: ctx.nextBatterIndex,
      retiredNotOut: ctx.retiredNotOut.filter((p) => p !== incoming),
    };
  }
  const unavailable = new Set<string>([...ctx.dismissed, ...ctx.retiredNotOut, ...crease]);
  const pick = nextBatterFrom(ctx.battingOrder, ctx.nextBatterIndex, unavailable);
  if (pick !== null) {
    return { person: pick.person, index: pick.index, retiredNotOut: [...ctx.retiredNotOut] };
  }
  // No batter is left who has not batted, so a retired-not-out batter resumes
  // (Law 25.4.2). This keeps the count of available batters equal to the
  // all-out threshold whatever the retirements were — which is what lets a
  // COARSE fold of the same match, which never sees the retirements, close
  // the innings at exactly the same wicket (§9.6).
  const resuming = ctx.retiredNotOut.find(
    (person) => !crease.includes(person) && !ctx.dismissed.includes(person),
  );
  if (resuming === undefined) invalid("batting order exhausted");
  return {
    person: resuming,
    index: ctx.nextBatterIndex,
    retiredNotOut: ctx.retiredNotOut.filter((person) => person !== resuming),
  };
}

interface DeliveryCtx {
  battingOrder: readonly string[];
  bowlingOrder: readonly string[];
  whiteBall: boolean;
  ballsPerOver: number;
  maxOversPerBowler: number | undefined;
  allOut: number;
  // Main innings: strict next-batter-by-order. Super over: any eligible
  // batter not previously dismissed in the super over(s).
  strictOrder: boolean;
  soIneligible: readonly string[];
  /** W4a (#425) §3.3 seam — false when this event is already in the ledger. */
  strictFold: boolean;
}

function leftoverBatterIndex(order: readonly string[], unavailable: ReadonlySet<string>): number {
  for (let i = 0; i < order.length; i++) {
    if (!unavailable.has(order[i] as string)) return i;
  }
  return order.length;
}

/** One crease end may change iff its occupant is the unfaced incoming batter. */
function adoptUnfacedIncoming(
  fine: FineInnings,
  payload: CricketBallEv,
  battingOrder: readonly string[],
): { nextBatterIndex: number; unfacedIncoming: string } | null {
  const unfaced = fine.unfacedIncoming;
  if (unfaced === undefined) return null;
  const { striker: nextStriker, nonStriker: nextNon } = payload;
  if (nextStriker === nextNon) return null;
  const strikerChanged = nextStriker !== fine.striker;
  const nonChanged = nextNon !== fine.nonStriker;
  if (strikerChanged === nonChanged) return null;
  const occupant = strikerChanged ? fine.striker : fine.nonStriker;
  if (occupant !== unfaced) return null;
  const nextPerson = strikerChanged ? nextStriker : nextNon;
  const other = strikerChanged ? nextNon : nextStriker;
  if (!eligibleIncomingBatters(battingOrder, fine.dismissed, [other]).includes(nextPerson)) {
    return null;
  }
  const unavailable = new Set<string>([
    ...fine.dismissed,
    ...(fine.retiredNotOut ?? []),
    nextPerson,
    other,
  ]);
  return {
    nextBatterIndex: leftoverBatterIndex(battingOrder, unavailable),
    unfacedIncoming: nextPerson,
  };
}

function applyDelivery(
  innings: InningsState,
  payload: CricketBallEv,
  ctx: DeliveryCtx,
): InningsState {
  const fine = innings.fine;
  if (fine === null) {
    invalid("this innings is recorded at summary fidelity — ball events are not allowed");
  }
  const bpo = ctx.ballsPerOver;

  // Over/ball counters must match the fold's expectation (wides/no-balls do
  // not advance the count — spec §2.2 ball legality).
  const expectedOver = Math.floor(innings.legalBalls / bpo);
  const expectedBall = (innings.legalBalls % bpo) + 1;
  // STRICT ONLY (§3.3 seam). `bpo` is `cfg.ballsPerOver`, read live from
  // division.config, so an eight-ball competition edited to six renumbers every
  // delivery already in the ledger and the fixture throws on every read — with
  // no event to void. The counters are what the scorer wrote on the card; the
  // config is what someone changed afterwards.
  if (ctx.strictFold && (payload.over !== expectedOver || payload.ballInOver !== expectedBall)) {
    invalid("over/ballInOver do not match the ledger", {
      expected: { over: expectedOver, ballInOver: expectedBall },
      got: { over: payload.over, ballInOver: payload.ballInOver },
    });
  }

  // Bowler legality — no consecutive overs, per-bowler quota (spec §2.2).
  let currentBowler = fine.currentBowler;
  if (currentBowler === null) {
    // BOTH CFG-DERIVED, so both are STRICT ONLY (§3.3 seam). Where an over ENDS
    // is `cfg.ballsPerOver`, so re-cutting six-ball overs to five re-partitions
    // a recorded innings and turns a perfectly legal spell into "consecutive
    // overs" on every read; the quota is `cfg.maxOversPerBowler` outright.
    // Neither refusal has an event to void — the deliveries were legal as
    // bowled. The lineup check between them is NOT gated: it reads the lineup,
    // which is recorded alongside the stream, not the division config.
    if (ctx.strictFold && payload.bowler === fine.prevOverBowler) {
      invalid(`bowler "${payload.bowler}" cannot bowl consecutive overs`);
    }
    if (!ctx.bowlingOrder.includes(payload.bowler)) {
      invalid(`bowler "${payload.bowler}" is not in the fielding lineup`);
    }
    if (ctx.strictFold && ctx.maxOversPerBowler !== undefined) {
      const bowled = Math.floor((fine.bowlerBalls[payload.bowler] ?? 0) / bpo);
      if (bowled >= ctx.maxOversPerBowler) {
        invalid(`bowler "${payload.bowler}" has exhausted the ${ctx.maxOversPerBowler}-over quota`);
      }
    }
    currentBowler = payload.bowler;
  } else if (ctx.strictFold && payload.bowler !== currentBowler) {
    // Same cause as the two above: whether an over is "in progress" at this
    // delivery is decided by `cfg.ballsPerOver`, so the boundary moves when the
    // config does and a legal change of bowler reads as a mid-over swap.
    invalid(`over in progress belongs to "${currentBowler}"`);
  }

  // Batters at the crease.
  let striker = fine.striker;
  let nonStriker = fine.nonStriker;
  let nextBatterIndex = fine.nextBatterIndex;
  let unfacedIncoming = fine.unfacedIncoming;
  if (ctx.strictOrder) {
    if (payload.striker !== striker || payload.nonStriker !== nonStriker) {
      // STRICT ONLY (§3.3 seam). Who is on strike is a projection of where the
      // OVER ended, and that is `cfg.ballsPerOver` — re-cutting six-ball overs
      // to five re-partitions a recorded innings and puts the fold's expected
      // pair out of step with every delivery card already in the ledger. On
      // replay the LEDGER wins: the card names who faced the ball, and that is
      // the recorded fact; the fold's expectation is the derivation.
      //
      // Exception: the incoming batter after a wicket/retire has not faced
      // yet. The next ball may name a different eligible person at that end
      // only — same window as a new-over bowler (`currentBowler === null`).
      const adopted = adoptUnfacedIncoming(fine, payload, ctx.battingOrder);
      if (adopted === null && ctx.strictFold) {
        invalid("striker/non-striker do not match the ledger", {
          expected: { striker, nonStriker },
          got: { striker: payload.striker, nonStriker: payload.nonStriker },
        });
      }
      if (adopted !== null) {
        nextBatterIndex = adopted.nextBatterIndex;
        unfacedIncoming = adopted.unfacedIncoming;
      }
      striker = payload.striker;
      nonStriker = payload.nonStriker;
    }
  } else {
    // Super over: resolve open ends against eligibility.
    const named = [payload.striker, payload.nonStriker];
    if (payload.striker === payload.nonStriker) invalid("striker and non-striker must differ");
    for (const person of named) {
      if (!ctx.battingOrder.includes(person)) {
        invalid(`batter "${person}" is not in the lineup`);
      }
      if (fine.dismissed.includes(person) || ctx.soIneligible.includes(person)) {
        invalid(`batter "${person}" is not eligible (already dismissed)`);
      }
    }
    const survivors = [striker, nonStriker].filter((p): p is string => p !== null);
    for (const survivor of survivors) {
      if (!named.includes(survivor)) {
        invalid(`batter "${survivor}" is at the crease and must stay`, { survivor });
      }
    }
    striker = payload.striker;
    nonStriker = payload.nonStriker;
  }

  // Free hit — armed by a white-ball no-ball, consumed by the next legal
  // delivery; only the run-out family can dismiss on it (spec §2.2).
  if (payload.freeHit === true && !fine.freeHitPending) {
    invalid("freeHit flagged but no free hit is pending");
  }
  const extras = payload.runs.extras;
  const legal = extras === undefined || (extras.kind !== "wide" && extras.kind !== "noball");
  if (extras?.kind === "wide" && payload.runs.bat > 0) {
    invalid("bat runs are impossible off a wide");
  }
  if (payload.wicket !== undefined) {
    const wicket = payload.wicket;
    if (fine.freeHitPending && wicket.kind !== "runout" && wicket.kind !== "obstructed") {
      invalid(`"${wicket.kind}" cannot dismiss on a free hit`);
    }
    if (wicket.out !== striker && wicket.out !== nonStriker) {
      invalid(`"${wicket.out}" is not at the crease`);
    }
    const shouldCredit = BOWLER_CREDITED_KINDS.has(wicket.kind);
    if (wicket.bowlerCredited !== shouldCredit) {
      invalid(`bowlerCredited must be ${shouldCredit} for "${wicket.kind}"`);
    }
  }

  // Accounting.
  const batRuns = payload.runs.bat;
  const extraRuns = extras?.runs ?? 0;
  const facing = striker;
  const batterRuns =
    extras?.kind === "wide"
      ? fine.batterRuns
      : { ...fine.batterRuns, [facing]: (fine.batterRuns[facing] ?? 0) + batRuns };
  const batterBalls =
    extras?.kind === "wide"
      ? fine.batterBalls
      : { ...fine.batterBalls, [facing]: (fine.batterBalls[facing] ?? 0) + 1 };
  if (extras?.kind !== "wide" && unfacedIncoming !== undefined && facing === unfacedIncoming) {
    unfacedIncoming = undefined;
  }
  const bowlerCharged =
    batRuns + (extras !== undefined && (extras.kind === "wide" || extras.kind === "noball") ? extras.runs : 0);
  const bowlerRuns = {
    ...fine.bowlerRuns,
    [currentBowler]: (fine.bowlerRuns[currentBowler] ?? 0) + bowlerCharged,
  };
  const bowlerBalls = legal
    ? { ...fine.bowlerBalls, [currentBowler]: (fine.bowlerBalls[currentBowler] ?? 0) + 1 }
    : fine.bowlerBalls;

  let wickets = innings.wickets;
  let dismissed = fine.dismissed;
  let bowlerWickets = fine.bowlerWickets;
  let fielding = fine.fielding;
  if (payload.wicket !== undefined) {
    wickets += 1;
    dismissed = [...dismissed, payload.wicket.out];
    // W4 — the scorebook's fielding column. Validates the named fielders even
    // when the mode of dismissal earns no credit.
    fielding = creditFielding(fielding, payload.wicket, ctx.bowlingOrder);
    if (payload.wicket.bowlerCredited) {
      bowlerWickets = {
        ...bowlerWickets,
        [currentBowler]: (bowlerWickets[currentBowler] ?? 0) + 1,
      };
    }
  }

  // Striker rotation — spec §2.2: swap on odd runs actually run (bat runs
  // unless a boundary, plus run extras net of the wide/no-ball penalty);
  // dismissal resolves positions instead (documented simplification).
  let crossings = 0;
  if (payload.boundary === undefined) crossings += batRuns;
  if (extras !== undefined) {
    if (extras.kind === "wide" || extras.kind === "noball") crossings += extras.runs - 1;
    else if (extras.kind !== "penalty") crossings += extras.runs;
  }
  if (payload.wicket === undefined && crossings % 2 === 1) {
    [striker, nonStriker] = [nonStriker, striker];
  }

  if (payload.wicket !== undefined && wickets < ctx.allOut) {
    const outPerson = payload.wicket.out;
    let replacement: string | null = null;
    let retiredNotOut = fine.retiredNotOut;
    if (ctx.strictOrder) {
      // spec §2.3 — dismissal → next batter by order, unless the ball names
      // an `incoming` batter (W4: Law 25.1 puts the order in the captain's
      // hands, and it is how a retired-not-out batter resumes).
      const resolved = resolveIncoming(payload.wicket.incoming, {
        battingOrder: ctx.battingOrder,
        dismissed,
        retiredNotOut: fine.retiredNotOut ?? [],
        atCrease: [striker, nonStriker],
        nextBatterIndex,
      });
      replacement = resolved.person;
      nextBatterIndex = resolved.index;
      retiredNotOut = resolved.retiredNotOut.length === 0 ? undefined : resolved.retiredNotOut;
    }
    if (striker === outPerson) striker = replacement;
    else if (nonStriker === outPerson) nonStriker = replacement;
    unfacedIncoming = replacement ?? undefined;
    return finishDelivery(innings, payload, {
      ...fine,
      striker,
      nonStriker,
      nextBatterIndex,
      dismissed,
      batterRuns,
      batterBalls,
      bowlerRuns,
      bowlerBalls,
      bowlerWickets,
      currentBowler,
      fielding,
      retiredNotOut,
      unfacedIncoming,
    }, { legal, batRuns, extraRuns, wickets, whiteBall: ctx.whiteBall, bpo });
  }

  return finishDelivery(innings, payload, {
    ...fine,
    striker,
    nonStriker,
    nextBatterIndex,
    dismissed,
    batterRuns,
    batterBalls,
    bowlerRuns,
    bowlerBalls,
    bowlerWickets,
    currentBowler,
    fielding,
    unfacedIncoming,
  }, { legal, batRuns, extraRuns, wickets, whiteBall: ctx.whiteBall, bpo });
}

function finishDelivery(
  innings: InningsState,
  payload: CricketBallEv,
  fine: FineInnings,
  info: { legal: boolean; batRuns: number; extraRuns: number; wickets: number; whiteBall: boolean; bpo: number },
): InningsState {
  const legalBalls = innings.legalBalls + (info.legal ? 1 : 0);
  let next: FineInnings = {
    ...fine,
    extras: fine.extras + info.extraRuns,
    freeHitPending:
      payload.runs.extras?.kind === "noball" && info.whiteBall
        ? true
        : info.legal
          ? false
          : fine.freeHitPending,
  };
  // Over end: swap ends, hand the ball to a new bowler.
  if (info.legal && legalBalls % info.bpo === 0) {
    next = {
      ...next,
      striker: next.nonStriker,
      nonStriker: next.striker,
      prevOverBowler: next.currentBowler,
      currentBowler: null,
    };
  }
  return {
    ...innings,
    runs: innings.runs + info.batRuns + info.extraRuns,
    wickets: info.wickets,
    legalBalls,
    boundaries: innings.boundaries + (payload.boundary !== undefined ? 1 : 0),
    fine: next,
  };
}

// ---------------------------------------------------------------------------
// Coarse application — spec §2.2 dual fidelity
// ---------------------------------------------------------------------------

function applySummary(
  state: CricketState,
  payload: z.infer<typeof CricketInningsSummary>,
  strict: boolean,
): CricketState {
  if (state.phase !== "live") wrongPhase(`innings summary in phase "${state.phase}"`);
  let next = state;
  let open = openInnings(next);
  if (open !== null && open.innings.fine !== null) {
    invalid("this innings is recorded ball-by-ball — summaries are not allowed for it");
  }
  if (open === null) {
    next = createInnings(next, "coarse");
    // createInnings just opened one, so openInnings cannot return null here.
    // Load-bearing: `open` is declared `… | null` and the destructure below
    // needs the narrowing. no-unnecessary-type-assertion checks the declared
    // type of the target, not the narrowing, so it false-positives and its
    // autofix breaks tsc.
    // eslint-disable-next-line @typescript-eslint/no-unnecessary-type-assertion
    open = openInnings(next) as { innings: InningsState; index: number };
  }
  const { innings, index } = open;
  // Monotone update: totals may only grow (progressive coarse scoring).
  if (
    payload.runs < innings.runs ||
    payload.wickets < innings.wickets ||
    payload.legalBalls < innings.legalBalls
  ) {
    invalid("summary totals may not decrease", {
      previous: { runs: innings.runs, wickets: innings.wickets, legalBalls: innings.legalBalls },
      got: { runs: payload.runs, wickets: payload.wickets, legalBalls: payload.legalBalls },
    });
  }
  // THREE STRICT-ONLY CHECKS (§3.3 seam), all three cfg-derived: `allOut`
  // follows `playersPerSide`, `ballsLimit` follows `ballsPerInnings`, and the
  // declaration rule follows `inningsPerSide`. Lowering any of them refuses a
  // summary the ledger already holds, on every read, with nothing to void — a
  // T20 division re-cut to 10 overs would take every recorded innings dark.
  const allOut = allOutWickets(next, innings.battingSide);
  if (strict && payload.wickets > allOut) {
    invalid(`wickets exceed all-out (${allOut})`, { wickets: payload.wickets });
  }
  if (strict && innings.ballsLimit !== null && payload.legalBalls > innings.ballsLimit) {
    invalid("legalBalls exceed the innings quota", {
      legalBalls: payload.legalBalls,
      quota: innings.ballsLimit,
    });
  }
  if (strict && payload.declared === true && next.cfg.inningsPerSide !== 2) {
    invalid("declarations apply to two-innings matches only");
  }
  const updated: InningsState = {
    ...innings,
    runs: payload.runs,
    wickets: payload.wickets,
    legalBalls: payload.legalBalls,
    boundaries: Math.max(innings.boundaries, payload.boundaries ?? 0),
  };
  next = replaceInnings(next, index, updated);
  if (payload.partial === true) return autoClose(next);
  return closeOpenInnings(next, payload.declared === true);
}

// ---------------------------------------------------------------------------
// Super over — spec §2.3: a recursive 1-over innings pair, 2-wicket all out;
// still-tied policy from cfg (repeat | boundary_count | shared).
// ---------------------------------------------------------------------------

function boundaryCount(state: CricketState, side: Side): number {
  const main = state.innings.reduce(
    (sum, innings) => (innings.battingSide === side ? sum + innings.boundaries : sum),
    0,
  );
  const so = (state.superOver?.innings ?? []).reduce(
    (sum, innings) => (innings.battingSide === side ? sum + innings.boundaries : sum),
    0,
  );
  return main + so;
}

/** Narrow shape `soBattingSideAt` (below) actually reads — same posture as
 *  `BattingAlternationCfg` above and for the identical reason: a caller
 *  outside this module (apps/web's v3 cricket skin) holds a narrowed,
 *  all-optional local shape rather than a real `CricketState`, and must be
 *  able to call this without owning one. */
interface SuperOverAlternationCfg {
  battingFirst: Side;
}

/**
 * ICC super-over alternation rule (spec §2.3): the side batting second in
 * the match bats first in the super over; the side batting second in a
 * super over bats first in the next one. `index` addresses super-over
 * innings the same way `applySuperOverBall` (below) does when it opens a
 * fresh one — 0/1 is pair 1's two innings, 2/3 is pair 2's, and so on.
 *
 * Exported (R3.5 Task S) — same posture as `nextBattingSide`/
 * `eligibleBowlers`/`reviewsRemaining`/`activeInnings` above: a public
 * mirror of a private rule so a caller outside this module mirrors it
 * instead of hand-copying it. This was the one rule in that family still
 * missing its export: the pad's own `dueBattingSide` (apps/web
 * skins/cricket.tsx) answered "who's due to bat" for every OTHER
 * super-over window (mid-pair, pair-complete) by re-deriving the answer
 * from the last RECORDED innings, but had no fold-backed value to read
 * before the very FIRST super-over ball, when no innings has been created
 * yet — the live 422 this task fixes. `resolvePeople`'s `battingSide`
 * default silently fell through to a literal `"home"` in that state,
 * proposing the wrong side's striker/non-striker and, so, the wrong side's
 * bowler — refused outright by the fielding-lineup check.
 */
export function soBattingSideAt(state: SuperOverAlternationCfg, index: number): Side {
  // ICC: the side batting second in the match bats first in the super over;
  // the side batting second in a super over bats first in the next one.
  const pair = Math.floor(index / 2);
  const pairFirst = pair % 2 === 0 ? opponent(state.battingFirst) : state.battingFirst;
  return index % 2 === 0 ? pairFirst : opponent(pairFirst);
}

/**
 * Batting-order candidates still eligible to come to the crease in a super
 * over, in lineup order — exported (R3.5 F1, review finding, BLOCKER) for
 * the v3 pad's own default-picker (`resolvePeople`, apps/web `skins/
 * cricket.tsx`), same posture as `nextBattingSide`/`eligibleBowlers`/
 * `activeInnings`/`soBattingSideAt` above: a public mirror of a rule this
 * file already enforces, so a caller outside this module mirrors it rather
 * than hand-copying it a third time.
 *
 * Mirrors `applyDelivery`'s own super-over eligibility check verbatim (this
 * file, the "resolve open ends against eligibility" branch): a named batter
 * is refused when `fine.dismissed.includes(person) || ctx.soIneligible.
 * includes(person)` — `dismissed`/`soIneligible` below are exactly those two
 * arguments. `crease` is who is CURRENTLY at the batting end(s) and must be
 * renamed on the very next ball rather than replaced (the same check's
 * "batter … is at the crease and must stay" refusal) — never a spent name to
 * union into `dismissed`, a genuinely separate reason to withhold a
 * candidate.
 *
 * The pad needs this the instant a super-over wicket sets `fine.striker`/
 * `.nonStriker` to `null` ("awaiting replacement" — this file's own
 * `FineInnings.striker` doc): unlike the main innings (`strictOrder: true`,
 * `resolveIncoming` above resolves a real replacement inside the fold
 * itself), a super-over wicket leaves the fold's own state with a `null`
 * end and requires the NEXT ball to name a real, eligible replacement — the
 * fold has no opinion on WHICH one, so a caller building a default proposal
 * needs this list rather than guessing `battingOrder[0]`, which can be the
 * batter just dismissed.
 */
export function soEligibleBatters(
  battingOrder: readonly string[],
  dismissed: readonly string[],
  soIneligible: readonly string[],
  crease: readonly string[],
): string[] {
  const unavailable = new Set<string>([...dismissed, ...soIneligible, ...crease]);
  return battingOrder.filter((person) => !unavailable.has(person));
}

function applySuperOverBall(
  state: CricketState,
  payload: CricketBallEv,
  strict: boolean,
): CricketState {
  if (state.phase !== "super_over" || state.superOver === null) {
    wrongPhase(`super-over ball in phase "${state.phase}"`);
  }
  const so = state.superOver;
  const bpo = state.cfg.ballsPerOver;
  let inningsList = so.innings;
  let index = inningsList.length - 1;
  let innings = inningsList[index];
  if (innings === undefined || innings.closed) {
    index += 1;
    const battingSide = soBattingSideAt(state, index);
    innings = {
      battingSide,
      runs: 0,
      wickets: 0,
      legalBalls: 0,
      boundaries: 0,
      declared: false,
      closed: false,
      ballsLimit: bpo, // one over
      fine: freshFine(),
    };
    inningsList = [...inningsList, innings];
  }
  const battingSide = innings.battingSide;
  const updated = applyDelivery(innings, payload, {
    battingOrder: state.orders[battingSide],
    bowlingOrder: state.orders[opponent(battingSide)],
    whiteBall: true,
    ballsPerOver: bpo,
    maxOversPerBowler: undefined,
    allOut: 2, // spec cricket.md §3 — 2-wicket all out
    strictOrder: false,
    soIneligible: so.dismissed[battingSide],
    strictFold: strict,
  });

  const dismissedNow = payload.wicket !== undefined ? [payload.wicket.out] : [];
  const dismissed = {
    ...so.dismissed,
    [battingSide]: [...so.dismissed[battingSide], ...dismissedNow],
  };

  // Close conditions for a super-over innings.
  const second = index % 2 === 1;
  const target = second ? (inningsList[index - 1] as InningsState).runs + 1 : null;
  const shouldClose =
    updated.wickets >= 2 ||
    updated.legalBalls >= bpo ||
    (target !== null && updated.runs >= target);
  const closed: InningsState = shouldClose ? { ...updated, closed: true } : updated;
  const nextList = inningsList.map((entry, i) => (i === index ? closed : entry));
  const next: CricketState = { ...state, superOver: { innings: nextList, dismissed } };

  if (!shouldClose || !second) return next;

  // Pair complete — decide or recurse (spec §2.3).
  const first = nextList[index - 1] as InningsState;
  if (closed.runs > first.runs) {
    return decideWin(next, closed.battingSide, "super_over", { kind: "super_over" });
  }
  if (closed.runs < first.runs) {
    return decideWin(next, first.battingSide, "super_over", { kind: "super_over" });
  }
  switch (next.cfg.superOverStillTied) {
    case "repeat":
      return next; // next pair opens on the next ball (ICC current rule)
    case "boundary_count": {
      const home = boundaryCount(next, "home");
      const away = boundaryCount(next, "away");
      if (home === away) {
        return { ...next, phase: "done", outcome: { kind: "tie" }, margin: null };
      }
      return decideWin(next, home > away ? "home" : "away", "boundary_count", { kind: "boundary_count" });
    }
    case "shared":
      return { ...next, phase: "done", outcome: { kind: "tie" }, margin: null };
  }
}

// ---------------------------------------------------------------------------
// Tier-2 player lines — doc 14 §1: sum-consistency vs InningsTotals; fine
// innings cross-check exactly against the derived cards.
// ---------------------------------------------------------------------------

function applyPlayerLine(
  state: CricketState,
  payload: z.infer<typeof CricketPlayerLine>,
): CricketState {
  const innings = state.innings[payload.innings - 1];
  if (innings === undefined || !innings.closed) {
    invalid(`innings ${payload.innings} is not a closed innings`);
  }
  const battingOrder = state.orders[innings.battingSide];
  const bowlingOrder = state.orders[opponent(innings.battingSide)];
  const existing = state.playerLines.filter((line) => line.innings === payload.innings);
  const dupe = existing.find(
    (line) =>
      line.person === payload.person &&
      ((line.batting !== undefined && payload.batting !== undefined) ||
        (line.bowling !== undefined && payload.bowling !== undefined)),
  );
  if (dupe !== undefined) {
    invalid(`a line for "${payload.person}" in innings ${payload.innings} already exists`);
  }

  const reject = (field: string, expected: number | string, got: number): never =>
    invalid("player line disagrees with the innings totals", {
      innings: payload.innings,
      person: payload.person,
      field,
      expected,
      got,
    });

  if (payload.batting !== undefined) {
    if (!battingOrder.includes(payload.person)) {
      invalid(`"${payload.person}" is not in the batting lineup for innings ${payload.innings}`);
    }
    // S17/owner ruling 12 — these two checks belong HERE, not on
    // `CricketPlayerLine`'s schema (see that schema's own comment): both
    // `fours`/`sixes` and `dismissal`/`out` are independent PadFields, and
    // the pad conformance suite requires the schema to accept every
    // in-bounds combination of them on its own. `reject` reuses the exact
    // shape (`code`, `field`/`expected`/`got`) the totals checks below use.
    const fours = payload.batting.fours ?? 0;
    const sixes = payload.batting.sixes ?? 0;
    if (fours * 4 + sixes * 6 > payload.batting.runs) {
      reject("batting.fours", `≤ ${payload.batting.runs} runs (4×fours + 6×sixes)`, fours * 4 + sixes * 6);
    }
    if (payload.batting.dismissal !== undefined && payload.batting.out !== true) {
      // `out` is provably not `true` in this branch (the guard above just
      // checked it) — `0` names that without a self-defeating comparison.
      reject("batting.dismissal", "out: true", 0);
    }
    // W1 review finding P2 — the SAME two rules band 3 applies to a
    // `CricketWicket`, mirrored here rather than re-derived, because a
    // band-2 line says exactly the same things in a different shape:
    //
    //  * naming `dismissal.bowler` IS this band's `bowlerCredited: true`, so
    //    it answers to the one shared `BOWLER_CREDITED_KINDS` set that
    //    `applyDelivery`'s "bowlerCredited must be …" check reads. Without
    //    this, `{ kind: "runout", bowler: "a7" }` folded clean at band 2 and
    //    the scorecard printed a run out as bowler-credited, while band 3
    //    refused the identical claim.
    //  * a named bowler or fielder must be in the FIELDING lineup. Band 3
    //    gets that for free: its bowler through `applyDelivery`'s own
    //    "not in the fielding lineup" check, its fielder through
    //    `creditFielding`. A line could name the batting side, or nobody.
    const dismissal = payload.batting.dismissal;
    if (dismissal !== undefined) {
      const shouldCredit = BOWLER_CREDITED_KINDS.has(dismissal.kind);
      if (dismissal.bowler !== undefined && !shouldCredit) {
        invalid(`bowlerCredited must be ${shouldCredit} for "${dismissal.kind}"`);
      }
      if (dismissal.bowler !== undefined && !bowlingOrder.includes(dismissal.bowler)) {
        invalid(`bowler "${dismissal.bowler}" is not in the fielding lineup`);
      }
      // `creditFielding` is band 3's own fielder check; called for that
      // validation alone (band 2 keeps no fielding map, and a line carries
      // no `fielderAssist`) so there is ONE predicate for "is this fielder
      // in the fielding lineup", never a second copy of it here.
      creditFielding(
        undefined,
        {
          kind: dismissal.kind,
          out: payload.person,
          ...(dismissal.fielder === undefined ? {} : { fielder: dismissal.fielder }),
          bowlerCredited: shouldCredit,
        },
        bowlingOrder,
      );
    }
    if (innings.fine !== null) {
      const runs = innings.fine.batterRuns[payload.person] ?? 0;
      const balls = innings.fine.batterBalls[payload.person] ?? 0;
      if (payload.batting.runs !== runs) reject("batting.runs", runs, payload.batting.runs);
      if (payload.batting.balls !== balls) reject("batting.balls", balls, payload.batting.balls);
    } else {
      const soFar = existing.reduce((sum, line) => sum + (line.batting?.runs ?? 0), 0);
      if (soFar + payload.batting.runs > innings.runs) {
        reject("batting.runs", `≤ ${innings.runs - soFar}`, payload.batting.runs);
      }
    }
  }
  if (payload.bowling !== undefined) {
    if (!bowlingOrder.includes(payload.person)) {
      invalid(`"${payload.person}" is not in the bowling lineup for innings ${payload.innings}`);
    }
    if (innings.fine !== null) {
      const balls = innings.fine.bowlerBalls[payload.person] ?? 0;
      const runs = innings.fine.bowlerRuns[payload.person] ?? 0;
      const wickets = innings.fine.bowlerWickets[payload.person] ?? 0;
      if (payload.bowling.legalBalls !== balls) reject("bowling.legalBalls", balls, payload.bowling.legalBalls);
      if (payload.bowling.runs !== runs) reject("bowling.runs", runs, payload.bowling.runs);
      if (payload.bowling.wickets !== wickets) reject("bowling.wickets", wickets, payload.bowling.wickets);
    } else {
      const wicketsSoFar = existing.reduce((sum, line) => sum + (line.bowling?.wickets ?? 0), 0);
      const ballsSoFar = existing.reduce((sum, line) => sum + (line.bowling?.legalBalls ?? 0), 0);
      const runsSoFar = existing.reduce((sum, line) => sum + (line.bowling?.runs ?? 0), 0);
      if (wicketsSoFar + payload.bowling.wickets > innings.wickets) {
        reject("bowling.wickets", `≤ ${innings.wickets - wicketsSoFar}`, payload.bowling.wickets);
      }
      if (ballsSoFar + payload.bowling.legalBalls > innings.legalBalls) {
        reject("bowling.legalBalls", `≤ ${innings.legalBalls - ballsSoFar}`, payload.bowling.legalBalls);
      }
      if (runsSoFar + payload.bowling.runs > innings.runs) {
        reject("bowling.runs", `≤ ${innings.runs - runsSoFar}`, payload.bowling.runs);
      }
    }
    // S17/owner ruling 12 — a maiden is an OVER conceding no runs, so a
    // line can never claim more maidens than the overs its own reported
    // `legalBalls` actually cover. Independent of the fine/coarse branch
    // above (a maiden is not one of `FineInnings`'s per-bowler tallies
    // either), and reads `state.cfg.ballsPerOver`, never a hardcoded 6.
    if (payload.bowling.maidens !== undefined) {
      const maxMaidens = Math.floor(payload.bowling.legalBalls / state.cfg.ballsPerOver);
      if (payload.bowling.maidens > maxMaidens) {
        reject("bowling.maidens", `≤ ${maxMaidens}`, payload.bowling.maidens);
      }
    }
  }

  const record: PlayerLineRec = {
    innings: payload.innings,
    person: payload.person,
    ...(payload.batting === undefined ? {} : { batting: payload.batting }),
    ...(payload.bowling === undefined ? {} : { bowling: payload.bowling }),
  };
  return { ...state, playerLines: [...state.playerLines, record] };
}

// ---------------------------------------------------------------------------
// W4 domain events — retirement, the new ball, powerplays, reviews.
// All four fold into the open innings; none of them touch runs or balls, so
// none of them can change a pre-wave replay.
// ---------------------------------------------------------------------------

function requireOpenInnings(
  state: CricketState,
  what: string,
): { innings: InningsState; index: number } {
  if (state.phase !== "live") wrongPhase(`${what} in phase "${state.phase}"`);
  const open = openInnings(state);
  if (open === null) invalid(`${what} needs an innings in progress`);
  return open;
}

function applyRetire(state: CricketState, payload: z.infer<typeof CricketRetire>): CricketState {
  const { innings, index } = requireOpenInnings(state, "retirement");
  const fine = innings.fine;
  if (fine === null) {
    invalid("this innings is recorded at summary fidelity — retirements are not allowed");
  }
  const { person } = payload;
  if (person !== fine.striker && person !== fine.nonStriker) {
    invalid(`"${person}" is not at the crease`);
  }
  // Law 25.4.3: retired out is a dismissal (no bowler credited). Any other
  // retirement leaves the batter not out and eligible to resume.
  const retiredOut = payload.reason === "out";
  const wickets = innings.wickets + (retiredOut ? 1 : 0);
  const dismissed = retiredOut ? [...fine.dismissed, person] : fine.dismissed;
  const standing = fine.retiredNotOut ?? [];
  const retiredList = retiredOut ? [...standing] : [...standing, person];

  let striker = fine.striker;
  let nonStriker = fine.nonStriker;
  let nextBatterIndex = fine.nextBatterIndex;
  let retiredNotOut: string[] | undefined = retiredList.length === 0 ? undefined : retiredList;
  let unfacedIncoming: string | undefined = undefined;

  if (wickets < allOutWickets(state, innings.battingSide)) {
    const resolved = resolveIncoming(payload.incoming, {
      battingOrder: state.orders[innings.battingSide],
      dismissed,
      retiredNotOut: retiredList,
      atCrease: [striker, nonStriker],
      nextBatterIndex,
    });
    nextBatterIndex = resolved.index;
    retiredNotOut = resolved.retiredNotOut.length === 0 ? undefined : resolved.retiredNotOut;
    if (striker === person) striker = resolved.person;
    else nonStriker = resolved.person;
    unfacedIncoming = resolved.person;
  } else if (striker === person) {
    striker = null;
  } else {
    nonStriker = null;
  }

  const updated: InningsState = {
    ...innings,
    wickets,
    fine: { ...fine, striker, nonStriker, nextBatterIndex, dismissed, retiredNotOut, unfacedIncoming },
  };
  return autoClose(replaceInnings(state, index, updated));
}

function applyNewBall(state: CricketState): CricketState {
  const { innings, index } = requireOpenInnings(state, "new ball");
  const taken = innings.newBallAt ?? [];
  if (taken.includes(innings.legalBalls)) {
    invalid("a new ball has already been taken at this point of the innings");
  }
  return replaceInnings(state, index, { ...innings, newBallAt: [...taken, innings.legalBalls] });
}

function applyPowerplay(
  state: CricketState,
  payload: z.infer<typeof CricketPowerplay>,
): CricketState {
  const { innings, index } = requireOpenInnings(state, "powerplay");
  const blocks = innings.powerplays ?? [];
  const openBlock = blocks.findIndex((block) => block.toBalls === null);
  if (payload.phase === "start") {
    if (openBlock >= 0) invalid("a powerplay block is already open");
    const block: PowerplayBlock = {
      kind: payload.kind,
      fromBalls: innings.legalBalls,
      toBalls: null,
    };
    return replaceInnings(state, index, { ...innings, powerplays: [...blocks, block] });
  }
  if (openBlock < 0) invalid("no powerplay block is open");
  const block = blocks[openBlock] as PowerplayBlock;
  if (block.kind !== payload.kind) {
    invalid(`the open powerplay block is "${block.kind}", not "${payload.kind}"`);
  }
  return replaceInnings(state, index, {
    ...innings,
    powerplays: blocks.map((entry, i) =>
      i === openBlock ? { ...entry, toBalls: innings.legalBalls } : entry,
    ),
  });
}

function applyReview(state: CricketState, payload: z.infer<typeof CricketReview>): CricketState {
  const { innings, index } = requireOpenInnings(state, "review");
  const side = sideOf(state, payload.by);
  const ledger: Record<Side, ReviewLedger> = innings.reviews ?? {
    home: { taken: 0, lost: 0 },
    away: { taken: 0, lost: 0 },
  };
  const allowance = state.cfg.reviews?.perInnings;
  if (payload.kind === "player" && reviewsRemaining(innings, allowance, side) === 0) {
    invalid(`"${payload.by}" has no reviews left in this innings`, { allowance });
  }
  // Only an unsuccessful player review is spent: umpire's call retains it
  // (current ICC conditions) and an umpire review never counts against a side.
  const spent = payload.kind === "player" && payload.outcome === "struck_down";
  return replaceInnings(state, index, {
    ...innings,
    reviews: {
      ...ledger,
      [side]: { taken: ledger[side].taken + 1, lost: ledger[side].lost + (spent ? 1 : 0) },
    },
  });
}

// ---------------------------------------------------------------------------
// Generator internals — spec 03 §6 (rng-injected, no fast-check dependency).
// ---------------------------------------------------------------------------

/**
 * The two over-boundary facts `eligibleBowlers` reads, and nothing else.
 * Deliberately a standalone structural type, not a `Pick<FineInnings, ...>`:
 * the v3 cricket skin holds its own looser shape of a folded innings, where
 * both of these are OPTIONAL, so a `Pick` — which keeps them required — was
 * still unusable at the one call site the export was created for (proved by
 * tsc, not guessed). Declaring them optional here is also the honest
 * signature: the body already tolerates both being absent, since a fine
 * innings that has not opened has neither.
 */
export type OverBowlerFacts = {
  readonly prevOverBowler?: string | null;
  readonly bowlerBalls?: Readonly<Record<string, number>> | undefined;
};

/**
 * Who may legally OPEN the next over — the consecutive-over law
 * (`applyDelivery`'s own check) and, only where the cfg caps it, the
 * per-bowler quota.
 *
 * EXPORTED for the pad (R2c). It was private, and R2b's v3 cricket skin
 * hand-copied it as `isEligibleOverBowler` because the export was not
 * granted — which cost that wave's review a byte-for-byte verification to
 * trust, and left a rule that could silently drift. The pad needs exactly
 * this LIST to narrow its bowler chip's candidates, so the fork is deleted
 * rather than re-verified.
 *
 * The engine's THIRD refusal ground at an over boundary — "not in the
 * fielding lineup" — is NOT applied here, because every caller passes
 * `order` drawn from the fielding side already, which makes it structurally
 * true rather than checked. A caller that can violate that invariant (a
 * scorer's manual override) must check membership itself.
 *
 * `ballsPerOver` must be the cfg's real value, never a hardcoded 6 — the
 * Hundred sets 5, and the quota arithmetic mis-divides against the wrong
 * divisor otherwise. A null/absent `fine` means the innings has not opened:
 * nobody has bowled, so nobody is yet ineligible.
 */
/**
 * Who the Laws still allow to walk in (Law 25.1 / 25.4): anyone in the
 * batting order who is not already dismissed and not currently at the
 * crease. Retired-not-out batters stay in the order and are therefore
 * included — they may resume; a dismissed batter may not.
 *
 * EXPORTED for the pad's wicket/retire incoming step (same posture as
 * `eligibleBowlers`). The auto default ("next in order") is
 * `suggestedIncomingBatter`; this list is the captain's full choice.
 */
export function eligibleIncomingBatters(
  battingOrder: readonly string[],
  dismissed: readonly string[],
  atCrease: readonly (string | null)[],
): string[] {
  const crease = new Set(atCrease.filter((p): p is string => typeof p === "string" && p !== ""));
  const out = new Set(dismissed);
  return battingOrder.filter((person) => !out.has(person) && !crease.has(person));
}

/**
 * Who the fold would walk in if `incoming` is omitted — next unused name
 * in batting order, else a retired-not-out batter resuming (Law 25.4.2).
 * Null when nobody is left (all out). The pad puts this name first in the
 * incoming picker so one tap keeps today's auto.
 */
export function suggestedIncomingBatter(
  battingOrder: readonly string[],
  dismissed: readonly string[],
  retiredNotOut: readonly string[],
  atCrease: readonly (string | null)[],
  nextBatterIndex: number,
): string | null {
  const crease = atCrease.filter((p): p is string => typeof p === "string" && p !== "");
  const unavailable = new Set<string>([...dismissed, ...retiredNotOut, ...crease]);
  const byOrder = nextBatterFrom(battingOrder, nextBatterIndex, unavailable);
  if (byOrder !== null) return byOrder.person;
  return retiredNotOut.find((person) => !crease.includes(person) && !dismissed.includes(person)) ?? null;
}

export function eligibleBowlers(
  order: readonly string[],
  fine: OverBowlerFacts | null | undefined,
  maxOversPerBowler: number | undefined,
  ballsPerOver: number,
): string[] {
  return order.filter((person) => {
    if (person === (fine?.prevOverBowler ?? null)) return false;
    if (maxOversPerBowler === undefined) return true;
    return Math.floor((fine?.bowlerBalls?.[person] ?? 0) / ballsPerOver) < maxOversPerBowler;
  });
}

/**
 * How many player reviews `side` still holds in this innings — `null` when
 * the cfg declares no allowance at all (uncapped, which must never be read
 * as zero).
 *
 * NEW in R2c, and it exists because this arithmetic was already forked TWICE
 * inside this file — `applyReview` below and the random-stream generator each
 * open-coded `lost >= allowance`. The pad needs the same rule to stop
 * offering a review that will be refused, and a third copy is the drift bug
 * this repo keeps paying for. Both engine call sites now route through here.
 *
 * Two subtleties this owns so no caller re-derives them: only an
 * UNSUCCESSFUL player review is spent, so the counter is `lost`, never
 * `taken`; and an innings that has recorded no reviews yet carries no ledger
 * at all, which is a full allowance rather than a missing one.
 *
 * Takes the innings rather than the state on purpose: WHICH innings is the
 * caller's business and the callers genuinely differ (the engine's two both
 * mean the open innings; the pad resolves a scoring innings that may sit
 * after a closed one). Only the arithmetic is shared, so only the arithmetic
 * lives here.
 */
/**
 * What `reviewsRemaining` reads. A standalone structural type rather than a
 * `Pick<InningsState, "reviews">` for the same reason `OverBowlerFacts` is
 * one: the v3 cricket skin carries its own looser shape of a folded innings,
 * and a `Pick` of an optional field still demands the surrounding type match.
 */
export type ReviewLedgerHolder = {
  readonly reviews?: Readonly<Record<Side, ReviewLedger>> | undefined;
};

export function reviewsRemaining(
  innings: ReviewLedgerHolder,
  allowance: number | undefined,
  side: Side,
): number | null {
  if (allowance === undefined) return null;
  return Math.max(0, allowance - (innings.reviews?.[side].lost ?? 0));
}

function pickFrom(items: readonly string[], rng: Rng): string {
  if (items.length === 0) invalid("generator ran out of eligible players");
  return items[Math.floor(rng() * items.length)] as string;
}

function randomDelivery(
  base: {
    over: number;
    ballInOver: number;
    striker: string;
    nonStriker: string;
    bowler: string;
  },
  freeHitPending: boolean,
  whiteBall: boolean,
  rng: Rng,
  // W4 — the fielding lineup, so generated dismissals can carry fielder credit
  // (which is what makes the fielding fold reachable from chaos/undo sweeps).
  fielders: readonly string[] = [],
): CricketBallEv {
  const freeHit = freeHitPending ? { freeHit: true as const } : {};
  const roll = rng();
  if (roll < 0.04) {
    // Wide (occasionally with runs run). No bat runs, no free-hit consumption.
    return { ...base, runs: { bat: 0, extras: { kind: "wide", runs: rng() < 0.15 ? 2 : 1 } } };
  }
  if (whiteBall && roll < 0.06) {
    return {
      ...base,
      runs: { bat: Math.floor(rng() * 3), extras: { kind: "noball", runs: 1 } },
      ...freeHit,
    };
  }
  if (roll < 0.13) {
    const kind = rng() < 0.5 ? ("bye" as const) : ("legbye" as const);
    return { ...base, runs: { bat: 0, extras: { kind, runs: 1 + Math.floor(rng() * 2) } }, ...freeHit };
  }
  if (roll < 0.2) {
    const kind = freeHitPending
      ? ("runout" as const)
      : ((["bowled", "caught", "lbw", "runout", "stumped"] as const)[Math.floor(rng() * 5)] ??
        ("bowled" as const));
    const out = kind === "runout" && rng() < 0.4 ? base.nonStriker : base.striker;
    const needsFielder = kind === "caught" || kind === "stumped" || kind === "runout";
    const fielder = needsFielder && fielders.length > 0 ? pickFrom(fielders, rng) : undefined;
    const assistPool = fielders.filter((person) => person !== fielder);
    const assist =
      fielder !== undefined && kind === "runout" && assistPool.length > 0 && rng() < 0.4
        ? pickFrom(assistPool, rng)
        : undefined;
    return {
      ...base,
      runs: { bat: kind === "runout" && rng() < 0.5 ? 1 : 0 },
      wicket: {
        kind,
        out,
        ...(fielder === undefined ? {} : { fielder }),
        ...(assist === undefined ? {} : { fielderAssist: assist }),
        bowlerCredited: BOWLER_CREDITED_KINDS.has(kind),
      },
      ...freeHit,
    };
  }
  if (roll < 0.32) {
    const six = rng() < 0.3;
    return { ...base, runs: { bat: six ? 6 : 4 }, boundary: six ? 6 : 4, ...freeHit };
  }
  const bat = ([0, 0, 0, 1, 1, 1, 1, 2, 2, 3] as const)[Math.floor(rng() * 10)] ?? 0;
  return { ...base, runs: { bat }, ...freeHit };
}

function generateBall(state: CricketState, rng: Rng): CricketBallEv {
  const open = openInnings(state);
  const index = open === null ? state.innings.length : state.innings.length - 1;
  const battingSide = open?.innings.battingSide ?? battingSideAt(state, index);
  const order = state.orders[battingSide];
  const bowlingOrder = state.orders[opponent(battingSide)];
  const fine: FineInnings = open?.innings.fine ?? {
    ...freshFine(),
    striker: order[0] as string,
    nonStriker: order[1] as string,
    nextBatterIndex: 2,
  };
  const legalBalls = open?.innings.legalBalls ?? 0;
  const bpo = state.cfg.ballsPerOver;
  const bowler =
    fine.currentBowler ??
    pickFrom(eligibleBowlers(bowlingOrder, fine, state.cfg.maxOversPerBowler, bpo), rng);
  const ball = randomDelivery(
    {
      over: Math.floor(legalBalls / bpo),
      ballInOver: (legalBalls % bpo) + 1,
      striker: fine.striker as string,
      nonStriker: fine.nonStriker as string,
      bowler,
    },
    fine.freeHitPending,
    state.cfg.ballsPerInnings !== null,
    rng,
    bowlingOrder,
  );
  if (ball.wicket === undefined) return ball;
  // W4a follow-up — name the batter walking in on EVERY OTHER wicket, so
  // `resolveIncoming`'s explicit arm (Law 25.1: the order after the openers is
  // the captain's) is folded by generated streams instead of only by
  // hand-written ones. Two deliberate properties:
  //   * SOMETIMES, not always — a field written on every event leaves the
  //     missing-field fold path exactly as unwalked as one written on none.
  //   * DERIVED, never drawn. The trigger is the wicket count and the value is
  //     the batter the default arm would have picked anyway, so this consumes
  //     no rng and moves no existing walk: same batter, same runs, same
  //     decisions downstream. A draw here would re-seed every cricket stream in
  //     every property suite for no benefit.
  if (fine.dismissed.length % 2 !== 0) return ball;
  const unavailable = new Set<string>([
    ...fine.dismissed,
    ball.wicket.out,
    ...(fine.retiredNotOut ?? []),
    ...[fine.striker, fine.nonStriker].filter((person): person is string => person !== null),
  ]);
  const byOrder = nextBatterFrom(order, fine.nextBatterIndex, unavailable);
  if (byOrder === null) return ball; // last man, or a resumption — leave it implicit
  return { ...ball, wicket: { ...ball.wicket, incoming: byOrder.person } };
}

// W4 review item 3 — a Tier-2 scorecard line for a closed FINE innings, built
// from that innings' own ledger. `applyPlayerLine` compares every number
// against the ledger, so anything else would be an event this generator's own
// fold rejects. Returns null when there is nothing left to line: no closed
// fine innings, or every person in it already has a line of that aspect.
function generatePlayerLine(
  state: CricketState,
  rng: Rng,
): z.infer<typeof CricketPlayerLine> | null {
  const candidates: number[] = [];
  state.innings.forEach((innings, i) => {
    if (innings.closed && innings.fine !== null) candidates.push(i);
  });
  if (candidates.length === 0) return null;
  const index = candidates[Math.floor(rng() * candidates.length)] as number;
  const innings = state.innings[index] as InningsState;
  const fine = innings.fine as FineInnings;
  const number = index + 1;
  const taken = state.playerLines.filter((line) => line.innings === number);

  const batters = Object.keys(fine.batterBalls).filter(
    (person) => !taken.some((line) => line.person === person && line.batting !== undefined),
  );
  const bowlers = Object.keys(fine.bowlerBalls).filter(
    (person) => !taken.some((line) => line.person === person && line.bowling !== undefined),
  );
  const wantBowling = bowlers.length > 0 && (batters.length === 0 || rng() < 0.5);
  if (wantBowling) {
    const person = bowlers[Math.floor(rng() * bowlers.length)] as string;
    const legalBalls = fine.bowlerBalls[person] ?? 0;
    // S17/owner ruling 12 — SOMETIMES, not always (same discipline as the
    // `incoming` batter above): `maidens`/`wides`/`noBalls` are never
    // cross-checked against `FineInnings` (`applyPlayerLine` only bounds
    // `maidens` against THIS line's own `legalBalls`), so any in-bound value
    // is a legal line and this generator is free to pick one — the point is
    // reaching the fold path at all, walked by `golden.test.ts`'s
    // `EXTEND_GOLDEN` coverage search, not modelling a real over.
    const maxMaidens = Math.floor(legalBalls / state.cfg.ballsPerOver);
    const maidens = rng() < 0.5 && maxMaidens > 0 ? Math.floor(rng() * (maxMaidens + 1)) : undefined;
    const wides = rng() < 0.5 ? Math.floor(rng() * 5) : undefined;
    const noBalls = rng() < 0.5 ? Math.floor(rng() * 3) : undefined;
    return {
      innings: number,
      person,
      bowling: {
        legalBalls,
        runs: fine.bowlerRuns[person] ?? 0,
        wickets: fine.bowlerWickets[person] ?? 0,
        ...(maidens !== undefined ? { maidens } : {}),
        ...(wides !== undefined ? { wides } : {}),
        ...(noBalls !== undefined ? { noBalls } : {}),
      },
    };
  }
  if (batters.length === 0) return null;
  const person = batters[Math.floor(rng() * batters.length)] as string;
  const runs = fine.batterRuns[person] ?? 0;
  const isOut = fine.dismissed.includes(person);
  // S17/owner ruling 12 — same "sometimes" discipline, and same "no
  // cross-check to respect" freedom as the bowling half above: `fours`/
  // `sixes` only have to satisfy THIS line's own `fours*4 + sixes*6 <= runs`
  // (never `FineInnings`'s real boundary count), and `dismissal` only has to
  // satisfy `out === true`, never the wicket the fine ball actually recorded.
  const maxFours = Math.floor(runs / 4);
  const fours = rng() < 0.5 && maxFours > 0 ? Math.floor(rng() * (maxFours + 1)) : undefined;
  const maxSixes = Math.floor((runs - (fours ?? 0) * 4) / 6);
  const sixes = rng() < 0.5 && maxSixes > 0 ? Math.floor(rng() * (maxSixes + 1)) : undefined;
  const wantDismissal = isOut && rng() < 0.5;
  const dismissalBowlingOrder = state.orders[opponent(innings.battingSide)];
  // `DISMISSAL_KINDS` is `readonly string[]` (its declared type, for reuse in
  // `PadFieldEnum.values`) — narrow the pick back to the real union so the
  // return type below still matches `z.infer<typeof CricketPlayerLine>`.
  const dismissalKind = pickFrom(DISMISSAL_KINDS, rng) as z.infer<typeof CricketWicket>["kind"];
  return {
    innings: number,
    person,
    batting: {
      runs,
      balls: fine.batterBalls[person] ?? 0,
      ...(isOut ? { out: true } : {}),
      ...(fours !== undefined ? { fours } : {}),
      ...(sixes !== undefined ? { sixes } : {}),
      ...(wantDismissal
        ? {
            dismissal: {
              kind: dismissalKind,
              // W1 review finding P2 — `applyPlayerLine` now refuses a bowler
              // on a mode of dismissal that credits none (the same rule band 3
              // enforces), so this generator must stop minting one into the
              // golden corpus. `BOWLER_CREDITED_KINDS` is the reducer's own
              // set, read here rather than restated.
              ...(BOWLER_CREDITED_KINDS.has(dismissalKind) &&
              dismissalBowlingOrder.length > 0 &&
              rng() < 0.7
                ? { bowler: pickFrom(dismissalBowlingOrder, rng) }
                : {}),
              ...(dismissalBowlingOrder.length > 0 && rng() < 0.5
                ? { fielder: pickFrom(dismissalBowlingOrder, rng) }
                : {}),
            },
          }
        : {}),
    },
  };
}

function generateSoBall(state: CricketState, rng: Rng): CricketBallEv {
  const so = state.superOver as NonNullable<CricketState["superOver"]>;
  let index = so.innings.length - 1;
  // Explicit `| undefined` so this compiles under consumers that don't enable
  // noUncheckedIndexedAccess (apps/web); a no-op under the engine's own config.
  let innings: InningsState | undefined = so.innings[index];
  if (innings === undefined || innings.closed) {
    index += 1;
    innings = undefined;
  }
  const battingSide = innings?.battingSide ?? soBattingSideAt(state, index);
  const order = state.orders[battingSide];
  const fine = innings?.fine ?? freshFine();
  const ineligible = new Set([...so.dismissed[battingSide], ...fine.dismissed]);
  const survivors = [fine.striker, fine.nonStriker].filter((p): p is string => p !== null);
  const fresh = order.filter(
    (person) => !ineligible.has(person) && !survivors.includes(person),
  );
  const striker = survivors[0] ?? fresh[0];
  const nonStriker = survivors[1] ?? (striker === fresh[0] ? fresh[1] : fresh[0]);
  if (striker === undefined || nonStriker === undefined) {
    invalid("generator ran out of eligible super-over batters");
  }
  // One bowler bowls the whole super over — reuse the over's bowler mid-over
  // (the fold rejects a change of bowler within an over).
  const bowler =
    fine.currentBowler ?? pickFrom(state.orders[opponent(battingSide)], rng);
  return randomDelivery(
    {
      over: 0,
      ballInOver: ((innings?.legalBalls ?? 0) % state.cfg.ballsPerOver) + 1,
      striker,
      nonStriker,
      bowler,
    },
    fine.freeHitPending,
    true,
    rng,
    state.orders[opponent(battingSide)],
  );
}

// ---------------------------------------------------------------------------
// Positions — spec §2.7
// ---------------------------------------------------------------------------

const positions: PositionCatalog = {
  groups: [
    { key: "BAT", name: "Batter" },
    { key: "BOWL", name: "Bowler" },
    { key: "AR", name: "All-rounder" },
    { key: "WK", name: "Wicketkeeper" },
  ],
  roles: [
    { key: "captain", name: "Captain", unique: true },
    { key: "wicketkeeper", name: "Wicketkeeper", unique: true, required: true },
  ],
  lineup: { size: 11, benchMax: 4 }, // substitutes: fielding only (spec §2.7)
};

// The catalog for a resolved config, mirroring football's positionsFor (W4,
// #407). Only the starting size moves: `playersPerSide` already carries a
// schema default of 11 (== positions.lineup.size), so the common case returns
// the static catalog unchanged. Closes a real gap: validateLineup compared
// the starting count exactly and had no way to see this knob before, so any
// config with a non-default playersPerSide (a raw override, or a future
// variant) would reject every lineup that wasn't exactly eleven.
function positionsFor(cfg: CricketCfg): PositionCatalog {
  if (cfg.playersPerSide === positions.lineup.size) return positions;
  return { ...positions, lineup: { ...positions.lineup, size: cfg.playersPerSide } };
}

// ---------------------------------------------------------------------------
// Module
// ---------------------------------------------------------------------------

/**
 * The batting/bowling order this side starts with.
 *
 * The `role` filter is S3/#426 OWNER RULING 3 applied on the ORDER path, and
 * it was missing: `state.orders[side]` fed every batter/bowler picker in the
 * v2 pad, so a team sheet naming a coach in a starting slot offered that coach
 * as a striker or a bowler, and runs could be credited to them. The ruling —
 * "squad and stat projections keep only `role === 'player'`, so a card to a
 * coach records against the person but never enters a playing record" — was
 * enforced on the stats projections (`playingSquad`/`onFieldPersons`,
 * core/lineup.ts) and nowhere near here, because this function predates the
 * role field reaching any caller. Found by S12/#421 driving the real cricket
 * console against a real roster.
 *
 * `role` absent means `player` (core/lineup.ts's own default), so every
 * recorded lineup — none of which carries a non-`player` role, the field
 * having never reached the wire before S12 — produces a byte-identical order
 * and no golden corpus moves.
 */
function orderFromLineup(lineup: LineupPair["home"]): string[] {
  return lineup.slots
    .filter((slot) => slot.slot === "starting" && (slot.role ?? "player") === "player")
    .sort((a, b) => a.orderNo - b.orderNo)
    .map((slot) => slot.personId);
}

/**
 * Everyone now on the field who is not yet in this side's batting order.
 *
 * APPEND-ONLY, and that is the whole design. `state.orders[side]` is not just a
 * list — `fine.nextBatterIndex` is an INDEX INTO IT, and `resolveIncoming`
 * scans it from that index. Inserting a replacement at the position of the
 * player he replaced would silently re-point the cursor at a different batter,
 * and every later "who walks in next" would be wrong with nothing in the
 * totals, the summary or the standings to show it. Appending moves no existing
 * index and removes nobody: a replaced player keeps his place because his
 * scorecard line, his `dismissed` entry and the all-out arithmetic all still
 * refer to him.
 *
 * It is also the right domain answer rather than a mechanical one. Law 25.1
 * leaves the order after the openers entirely to the captain, which cricket
 * already honours through `incoming`; what a replacement needs is to be
 * ELIGIBLE (`resolveIncoming` refuses a batter the order does not contain), not
 * to be at a particular position.
 *
 * `onField` is the gate rather than the squad's declared slot, because a bench
 * player is not in the batting order and never was — at `init` every starting
 * player is already present, so this is identity for every stream that folds no
 * lineup event, which is every stream in the frozen corpus.
 */
function withArrivals(state: CricketState, squads: SquadState): CricketState {
  let orders = state.orders;
  // `squads.home`/`.away` and `state.orders.home`/`.away` are both built from
  // the same `LineupPair`, so the side keys agree by construction.
  for (const side of ["home", "away"] as const) {
    const known = new Set(orders[side]);
    const arrived = playingSquad(squads[side])
      .filter((member) => member.onField && !known.has(member.personId))
      // At most one person arrives per accepted event, but the sort keeps the
      // result total and stable rather than dependent on member order.
      .sort((a, b) => (a.orderNo === b.orderNo ? 0 : a.orderNo - b.orderNo))
      .map((member) => member.personId);
    if (arrived.length > 0) orders = { ...orders, [side]: [...orders[side], ...arrived] };
  }
  return orders === state.orders ? state : { ...state, orders };
}

function sideLine(state: CricketState, side: Side): string {
  const list = state.innings.filter((innings) => innings.battingSide === side);
  if (list.length === 0) return "—";
  return list
    .map((innings) => {
      const allOut = innings.wickets >= allOutWickets(state, side);
      const wickets = allOut ? "" : `/${innings.wickets}`;
      const declared = innings.declared ? "d" : "";
      const overs =
        state.cfg.inningsPerSide === 1
          ? ` (${oversText(innings.legalBalls, state.cfg.ballsPerOver)})`
          : "";
      return `${innings.runs}${wickets}${declared}${overs}`;
    })
    .join(" & ");
}

// ---------------------------------------------------------------------------
// Player leaderboards (Jul3/07 §3, extended S8/#417). Every credit a cricket
// scorebook keeps is nested inside `cricket.ball`, so this model was
// undeclarable until `PlayerStatMetric.field`/`sumField` learned dotted
// paths (W4). `cricket.ball` (fine) is authoritative wherever it exists;
// `folded` below is the ONLY thing fine data cannot cover on its own — a
// stream that carries `cricket.player.line` (Tier 2) instead of, or
// alongside, `cricket.ball` for some person. See `folded`'s own comment for
// the merge rule. Super-over deliveries stay excluded from player records by
// the same convention the ICC applies — no `metrics[]` entry below reads
// `cricket.superover.ball`, and `folded`'s presence gate ignores it too.
// ---------------------------------------------------------------------------

/** Wides and no-balls are not legal deliveries — the same rule the fold's ball
 *  legality check applies (§2.2), so leaderboards and the fold agree. */
const legalDelivery = (p: Record<string, unknown>): boolean => {
  const kind = resolvePayloadPath(p, "runs.extras.kind");
  return kind !== "wide" && kind !== "noball";
};
/** Byes and leg byes are the keeper's, penalty runs the side's; only runs off
 *  the bat and the wide/no-ball penalty are charged to the bowler. */
const chargedToBowler = (p: Record<string, unknown>): boolean => {
  const kind = resolvePayloadPath(p, "runs.extras.kind");
  return kind === "wide" || kind === "noball";
};
const dismissedBy = (kind: string) => (p: Record<string, unknown>) =>
  resolvePayloadPath(p, "wicket.kind") === kind;

// `CricketWicket.kind`'s own ten members (Laws 30-39, plus Law 34's
// `hitballtwice`) — S8/#417 W6 fix 5: derived straight off the zod enum
// (`ZodEnum.options`) rather than hand-copied, so a new dismissal mode added
// to `CricketWicket` cannot be silently missed by the stat model's per-mode
// split below the way a THIRD hand-copy (alongside the schema itself and the
// pad spec's own `wicket.kind` enum values a few hundred lines down) could.
const DISMISSAL_KINDS = CricketWicket.shape.kind.options;

// S8/#417 W6b — per-innings scoping for the fine/coarse gate `folded` below
// implements. Two kinds of fine coverage, unioned:
//   - WHOLE: a fine ball with NO `innings` discriminator (every ball
//     recorded before `CricketBall.innings` existed, or any future producer
//     that still omits it) covers the person for EVERY innings — the
//     original whole-stream gate, kept exactly as the fallback for untagged
//     data, and the conservative choice whenever a stream mixes tagged and
//     untagged fine balls for the same person: never invent a coarse credit
//     the old gate would not have allowed.
//   - BY INNINGS: a fine ball that DOES carry `innings` covers the person
//     for that one innings only, which is what lets a coarse line for a
//     DIFFERENT innings through.
interface FineCoverage {
  whole: Set<string>;
  byInnings: Map<string, Set<number>>;
}
const newFineCoverage = (): FineCoverage => ({ whole: new Set(), byInnings: new Map() });
const markFine = (coverage: FineCoverage, person: string, innings: unknown): void => {
  if (typeof innings !== "number") {
    coverage.whole.add(person);
    return;
  }
  const set = coverage.byInnings.get(person) ?? new Set<number>();
  set.add(innings);
  coverage.byInnings.set(person, set);
};
const hasFineCoverage = (coverage: FineCoverage, person: string, innings: unknown): boolean =>
  coverage.whole.has(person) ||
  (typeof innings === "number" && (coverage.byInnings.get(person)?.has(innings) ?? false));

const CRICKET_PLAYER_STATS: PlayerStatsModel = {
  metrics: [
    // Batting.
    {
      key: "runs", label: "Runs", from: "cricket.ball", field: "striker",
      agg: "sum", sumField: "runs.bat",
    },
    {
      key: "balls_faced", label: "Balls faced", from: "cricket.ball", field: "striker",
      agg: "count", when: legalDelivery,
    },
    // S8/#417 — boundaries. `boundary` is only ever 4, 6 or absent (schema),
    // so "not a four or a six" is exactly "boundary absent" — a stroke run to
    // 4 without crossing the rope carries no `boundary` flag and correctly
    // credits neither key.
    {
      key: "fours", label: "Fours", from: "cricket.ball", field: "striker",
      agg: "count", when: (p) => resolvePayloadPath(p, "boundary") === 4,
    },
    {
      key: "sixes", label: "Sixes", from: "cricket.ball", field: "striker",
      agg: "count", when: (p) => resolvePayloadPath(p, "boundary") === 6,
    },
    // Bowling. `runs_conceded` is two metrics on one key — the fold bumps per
    // metric, so bat runs and the wide/no-ball penalty add into the same total.
    {
      key: "balls_bowled", label: "Balls bowled", from: "cricket.ball", field: "bowler",
      agg: "count", when: legalDelivery,
    },
    {
      key: "runs_conceded", label: "Runs conceded", from: "cricket.ball", field: "bowler",
      agg: "sum", sumField: "runs.bat",
    },
    {
      key: "runs_conceded", label: "Runs conceded", from: "cricket.ball", field: "bowler",
      agg: "sum", sumField: "runs.extras.runs", when: chargedToBowler,
    },
    {
      key: "wickets", label: "Wickets", from: "cricket.ball", field: "bowler",
      agg: "count", when: (p) => resolvePayloadPath(p, "wicket.bowlerCredited") === true,
    },
    // Fielding — new for the product. A run out credits the fielder who broke
    // the wicket and the one who threw ("run out (Patel/Khan)"), one each.
    {
      key: "catches", label: "Catches", from: "cricket.ball", field: "wicket.fielder",
      agg: "count", when: dismissedBy("caught"),
    },
    {
      key: "stumpings", label: "Stumpings", from: "cricket.ball", field: "wicket.fielder",
      agg: "count", when: dismissedBy("stumped"),
    },
    {
      key: "run_outs", label: "Run outs", from: "cricket.ball", field: "wicket.fielder",
      agg: "count", when: dismissedBy("runout"),
    },
    {
      key: "run_outs", label: "Run outs", from: "cricket.ball", field: "wicket.fielderAssist",
      agg: "count", when: dismissedBy("runout"),
    },
    // S8/#417 — dismissals, attributed to the BATTER (`wicket.out`): distinct
    // from the bowler's `wickets` above and the fielder's `catches`/
    // `stumpings`/`run_outs`. `dismissals` is every mode; the ten
    // `dismissals_<kind>` keys split it. `wicket.out` is a REQUIRED field on
    // `CricketWicket`, so it resolves whenever — and only whenever — a
    // wicket is actually present; the field walk alone gates `dismissals`
    // correctly and needs no `when`.
    {
      key: "dismissals", label: "Dismissals", from: "cricket.ball", field: "wicket.out",
      agg: "count",
    },
    ...DISMISSAL_KINDS.map(
      (kind): PlayerStatMetric => ({
        key: `dismissals_${kind}`,
        label: `Dismissals (${kind})`,
        from: "cricket.ball",
        field: "wicket.out",
        agg: "count",
        when: dismissedBy(kind),
      }),
    ),
  ],
  // S8/#417 — the coarse (Tier 2) fallback. `cricket.player.line` is a
  // per-person, per-innings scorecard LINE, not a per-event fact: whether one
  // should count depends on whether fine data ALREADY covers that person,
  // which is a fact about the whole stream, not about the line event by
  // itself — exactly what a per-event `metrics[]` entry cannot express and
  // `folded` exists for.
  //
  // THE RULE: ball-by-ball data wins wherever it exists; the coarse line
  // fills in only where it is absent. S8/#417 W6b — gated per PERSON, per
  // ASPECT (batting/bowling), per INNINGS whenever a producer stamps
  // `CricketBall.innings`: an innings boundary is not derivable from a flat
  // `cricket.ball` list by itself (over/ballInOver restart every innings),
  // so before W6b this fold could only ask "fine ANYWHERE" — correct for a
  // v1-migration stream (fine-or-coarse for the WHOLE fixture, which needs
  // no innings distinction at all) but a real under-count for a stream that
  // is fine in one innings and coarse-only in another. `CricketBall.innings`
  // (optional; see its own comment) closes that gap for any producer that
  // supplies it. A fine ball with NO `innings` field — every ball recorded
  // before W6b, or a future producer that still omits it — still blocks
  // EVERY innings for that person/aspect, unchanged from before: the
  // conservative fallback, and the reason no previously-recorded fixture's
  // numbers move. `applyPlayerLine` already requires a line that coexists
  // with a fine innings to carry the exact numbers the ball fold produced,
  // so even the gate failing open would have doubled a correct figure,
  // never patched a wrong one.
  //
  // `keys` names every key `fold` below actually writes — `runs`,
  // `balls_faced`, `balls_bowled`, `runs_conceded`, `wickets`, `dismissals`
  // — and `sharesMetricKeys` (S8/#417 W6 fix 1) marks all six as a
  // DECLARED, intentional overlap with `metrics[]` above: the coarse
  // contribution is meant to land in the SAME column the fine one does,
  // gated so the two never both fire for one person's aspect.
  // `playerStatsKeyCollisions` exists to catch an ACCIDENTAL name clash
  // between two uncoordinated sources — an earlier version of this file
  // declared `keys: []` here to dodge that checker entirely, which also
  // meant nothing protected these six names from a genuinely accidental
  // FUTURE `metrics[]` addition, since the checker never saw the real keys
  // at all. Declaring them honestly, with the overlap named explicitly,
  // keeps the checker able to catch a seventh, uncoordinated collision
  // while leaving this intentional six-way merge silent — see
  // cricket.playerstats.test.ts's "playerStatsKeyCollisions" block for the
  // test that proves the checker still fires on a genuine accident. Dismissal
  // MODE is fine-only regardless — `cricket.player.line` has no mode field —
  // so no `dismissals_<kind>` key is ever folded-derived or shared.
  folded: {
    // S8/#417 W6 review — labels here are BYTE-IDENTICAL to the `metrics[]`
    // entries of the same name above (never a second, drifting name for one
    // concept): every one of these six is in `sharesMetricKeys` below, so
    // `labelPlayerStats`'s first-declaration-wins precedence always renders
    // the `metrics[]` copy and this label is never the one shown — declared
    // anyway so the model satisfies "every folded key ships a label" on its
    // own, without relying on a reader to know the overlap is total.
    keys: [
      { key: "runs", label: "Runs" },
      { key: "balls_faced", label: "Balls faced" },
      { key: "balls_bowled", label: "Balls bowled" },
      { key: "runs_conceded", label: "Runs conceded" },
      { key: "wickets", label: "Wickets" },
      { key: "dismissals", label: "Dismissals" },
    ],
    sharesMetricKeys: ["runs", "balls_faced", "balls_bowled", "runs_conceded", "wickets", "dismissals"],
    fold: (events, _ctx) => {
      const batted = newFineCoverage();
      const bowled = newFineCoverage();
      for (const event of events) {
        // Superover excluded, the same convention every metric above follows.
        if (event.type !== "cricket.ball") continue;
        const p = event.payload as Record<string, unknown>;
        const innings = resolvePayloadPath(p, "innings");
        const striker = resolvePayloadPath(p, "striker");
        if (typeof striker === "string" && striker !== "") markFine(batted, striker, innings);
        const bowler = resolvePayloadPath(p, "bowler");
        if (typeof bowler === "string" && bowler !== "") markFine(bowled, bowler, innings);
      }

      const rows = new Map<string, Record<string, number>>();
      const bump = (personId: string, key: string, by: number) => {
        const stats = rows.get(personId) ?? {};
        stats[key] = (stats[key] ?? 0) + by;
        rows.set(personId, stats);
      };
      for (const event of events) {
        if (event.type !== "cricket.player.line") continue;
        const p = event.payload as Record<string, unknown>;
        const person = resolvePayloadPath(p, "person");
        if (typeof person !== "string" || person === "") continue;
        const lineInnings = resolvePayloadPath(p, "innings");

        if (!hasFineCoverage(batted, person, lineInnings)) {
          const runs = resolvePayloadPath(p, "batting.runs");
          const balls = resolvePayloadPath(p, "batting.balls");
          if (typeof runs === "number") bump(person, "runs", runs);
          if (typeof balls === "number") bump(person, "balls_faced", balls);
          if (resolvePayloadPath(p, "batting.out") === true) bump(person, "dismissals", 1);
        }
        if (!hasFineCoverage(bowled, person, lineInnings)) {
          const legalBalls = resolvePayloadPath(p, "bowling.legalBalls");
          const bowlRuns = resolvePayloadPath(p, "bowling.runs");
          const wkts = resolvePayloadPath(p, "bowling.wickets");
          if (typeof legalBalls === "number") bump(person, "balls_bowled", legalBalls);
          if (typeof bowlRuns === "number") bump(person, "runs_conceded", bowlRuns);
          if (typeof wkts === "number") bump(person, "wickets", wkts);
        }
      }
      return [...rows.entries()].map(([personId, stats]) => ({ personId, stats }));
    },
  },
};

// ---------------------------------------------------------------------------
// S6/#416 (W5) — padSpec. Pure function of resolved cfg (base ⊕ variant
// preset ⊕ org overrides, already resolved by the caller); every numeric
// bound below reads cfg, never a hardcoded preset number. Cricket is the
// REFERENCE module for this contract — the one sport with a real 4-band
// fidelity ladder already (S2/#430) — so its tier semantics here model the
// S6 redesign directly rather than approximating it.
// ---------------------------------------------------------------------------

// A big-but-finite stand-in for "no configured limit" (test cricket:
// `ballsPerInnings: null`). Not a rules number — the fold enforces no such
// cap — only a property-testing upper bound comfortably past any recorded
// first-class innings, so `fields` can declare a finite `max`.
const UNBOUNDED_BALLS_SENTINEL = 3000;
const MAX_PLAUSIBLE_RUNS = 2000;

function inningsBallsBound(cfg: CricketCfg): number {
  return cfg.ballsPerInnings ?? UNBOUNDED_BALLS_SENTINEL;
}

// 0-based over index — the last legal over of an innings at this quota
// (mirrors how `over` is folded: `Math.floor(legalBalls / ballsPerOver)`).
function oversBound(cfg: CricketCfg): number {
  return Math.max(0, Math.ceil(inningsBallsBound(cfg) / cfg.ballsPerOver) - 1);
}

const BALL_ATTRIBUTION: PadAttribution = [
  { kind: "person", path: "striker" },
  { kind: "person", path: "nonStriker" },
  { kind: "person", path: "bowler" },
];

// Every dismissal name a scorebook records, on top of who was at the crease.
//
// S7/#427 labels the two the dossier lists as owed prompts. `out` and
// `fielder` are left unlabelled deliberately (see `PadFieldEnum`'s doc
// comment in sport/module.ts): a "Wicket" action's first two person slots
// are the batter dismissed and the fielder who did it, which is what a
// scorebook's own columns say, whereas ASSIST and INCOMING are the two a
// scorer cannot infer from position alone — the assist is a second fielder
// (Law 19 run-out credit) and `incoming` is not a dismissal participant at
// all but the NEXT batter, an optional captain's-choice override.
const WICKET_ATTRIBUTION: PadAttribution = [
  ...BALL_ATTRIBUTION,
  { kind: "person", path: "wicket.out" },
  { kind: "person", path: "wicket.fielder" },
  {
    kind: "person",
    path: "wicket.fielderAssist",
    labelKey: { key: "pad.cricket.action.wicket.field.fielderAssist", label: "Assisting fielder" },
  },
  {
    kind: "person",
    path: "wicket.incoming",
    labelKey: { key: "pad.cricket.action.wicket.field.incoming", label: "Incoming batter" },
  },
];

function ballBaseFields(cfg: CricketCfg): PadField[] {
  return [
    { kind: "number", path: "over", min: 0, max: oversBound(cfg) },
    { kind: "number", path: "ballInOver", min: 1, max: cfg.ballsPerOver },
    { kind: "number", path: "runs.bat", min: 0, max: 6 },
  ];
}

export function padSpec(cfg: CricketCfg): PadSpec {
  const base = ballBaseFields(cfg);

  // --- Over rhythm --------------------------------------------------------
  const ballAction: PadAction = {
    type: "cricket.ball",
    labelKey: { key: "pad.cricket.action.ball", label: "Ball" },
    fields: [...base, { kind: "toggle", path: "freeHit" }],
    attribution: BALL_ATTRIBUTION,
  };

  // --- Extras --------------------------------------------------------------
  const extraAction: PadAction = {
    type: "cricket.ball",
    labelKey: { key: "pad.cricket.action.extra", label: "Extra" },
    fields: [
      ...base,
      { kind: "enum", path: "runs.extras.kind", values: ["wide", "noball", "bye", "legbye", "penalty"] },
      { kind: "number", path: "runs.extras.runs", min: 1, max: 6 },
    ],
    attribution: BALL_ATTRIBUTION,
  };

  // --- Dismissals, with fielder credit --------------------------------------
  const wicketAction: PadAction = {
    type: "cricket.ball",
    labelKey: { key: "pad.cricket.action.wicket", label: "Wicket" },
    fields: [
      ...base,
      {
        kind: "enum",
        path: "wicket.kind",
        values: [
          "bowled", "caught", "lbw", "runout", "stumped",
          "hitwicket", "retired", "obstructed", "timedout", "hitballtwice",
        ],
      },
      { kind: "toggle", path: "wicket.bowlerCredited" },
    ],
    attribution: WICKET_ATTRIBUTION,
  };

  // --- Reviews (DRS) --------------------------------------------------------
  const reviewAction: PadAction = {
    type: "cricket.review",
    labelKey: { key: "pad.cricket.action.review", label: "Review" },
    fields: [
      { kind: "enum", path: "kind", values: ["player", "umpire"] },
      { kind: "enum", path: "outcome", values: ["upheld", "struck_down", "umpires_call"] },
    ],
    // A side (who called it) AND, independently, up to two optional persons
    // — exactly the shape a single `attribution.kind` choice could not
    // express; see PadAttribution's own doc comment in sport/module.ts.
    attribution: [
      { kind: "side", path: "by" },
      { kind: "person", path: "person" },
      { kind: "person", path: "against" },
    ],
  };

  // --- Super over -------------------------------------------------------
  const superOverAction: PadAction = {
    type: "cricket.superover.ball",
    labelKey: { key: "pad.cricket.action.superOverBall", label: "Super over ball" },
    fields: [...base, { kind: "toggle", path: "freeHit" }],
    attribution: BALL_ATTRIBUTION,
  };

  // --- Pre-match --------------------------------------------------------
  const tossAction: PadAction = {
    type: "cricket.toss",
    labelKey: { key: "pad.cricket.action.toss", label: "Toss" },
    fields: [{ kind: "enum", path: "elected", values: ["bat", "bowl"] }],
    attribution: [{ kind: "side", path: "wonBy" }],
  };

  // --- Innings admin ------------------------------------------------------
  const inningsSummaryAction: PadAction = {
    type: "cricket.innings.summary",
    labelKey: { key: "pad.cricket.action.inningsSummary", label: "Innings total" },
    fields: [
      { kind: "number", path: "runs", min: 0, max: MAX_PLAUSIBLE_RUNS },
      { kind: "number", path: "wickets", min: 0, max: Math.max(0, cfg.playersPerSide - 1) },
      { kind: "number", path: "legalBalls", min: 0, max: inningsBallsBound(cfg) },
      { kind: "toggle", path: "declared" },
      { kind: "toggle", path: "partial" },
    ],
    attribution: [],
  };

  const inningsCloseAction: PadAction = {
    type: "cricket.innings.close",
    labelKey: { key: "pad.cricket.action.inningsClose", label: "Close innings" },
    fields: [
      {
        kind: "enum",
        path: "reason",
        values: ["all_out", "overs_complete", "target_reached", "time", "weather", "forfeited", "other"],
      },
    ],
    attribution: [],
  };

  const newBallAction: PadAction = {
    type: "cricket.newball",
    labelKey: { key: "pad.cricket.action.newBall", label: "New ball" },
    fields: [],
    attribution: [],
  };

  const powerplayAction: PadAction = {
    type: "cricket.powerplay",
    labelKey: { key: "pad.cricket.action.powerplay", label: "Powerplay" },
    fields: [
      { kind: "enum", path: "kind", values: ["mandatory", "batting", "bowling"] },
      { kind: "enum", path: "phase", values: ["start", "end"] },
    ],
    attribution: [],
  };

  const interruptionAction: PadAction = {
    type: "cricket.interruption",
    labelKey: { key: "pad.cricket.action.interruption", label: "Interruption" },
    fields: [
      { kind: "enum", path: "kind", values: ["rain", "light", "other"] },
      { kind: "number", path: "oversLostEstimate", min: 0, max: oversBound(cfg) + 1 },
    ],
    attribution: [],
  };

  const retireAction: PadAction = {
    type: "cricket.retire",
    labelKey: { key: "pad.cricket.action.retire", label: "Retire" },
    fields: [{ kind: "enum", path: "reason", values: ["hurt", "out", "other"] }],
    attribution: [
      { kind: "person", path: "person" },
      { kind: "person", path: "incoming" },
    ],
  };

  const declareAction: PadAction = {
    type: "cricket.innings.declare",
    labelKey: { key: "pad.cricket.action.declare", label: "Declare" },
    fields: [],
    attribution: [],
  };

  const followOnAction: PadAction = {
    type: "cricket.followon",
    labelKey: { key: "pad.cricket.action.followOn", label: "Enforce follow-on" },
    fields: [],
    attribution: [],
  };

  const matchCloseAction: PadAction = {
    type: "cricket.match.close",
    labelKey: { key: "pad.cricket.action.matchClose", label: "Draw (time expired)" },
    fields: [],
    attribution: [],
  };

  // --- DLS -----------------------------------------------------------------
  const reviseAction: PadAction = {
    type: "cricket.revise",
    labelKey: { key: "pad.cricket.action.revise", label: "Revise target" },
    fields: [
      { kind: "number", path: "oversPerSide", min: 1, max: oversBound(cfg) + 1 },
      { kind: "number", path: "target", min: 1, max: MAX_PLAUSIBLE_RUNS },
    ],
    attribution: [],
  };

  // --- Post-match -----------------------------------------------------------
  // S17/owner ruling 12 — six more fields and two more (OPTIONAL) person
  // attributions than this action shipped with, closing the band-2 gap at
  // the source. `batting.dismissal.kind` reuses `DISMISSAL_KINDS` — the SAME
  // zod-derived list `CricketWicket.kind`'s stat-model split already uses —
  // rather than a third hand-copy of the ten dismissal modes (a "choice"
  // field kind is not needed: `PadFieldEnum`'s `values: readonly string[]`
  // already expresses an enumerated option list). The two dismissal-credit
  // attributions are `optional: true` because a scorer filing a coarse line
  // may know only THAT a batter was out, not who bowled or fielded it —
  // `isPathRequired` already derives `required: false` for both from the
  // schema's own `.optional()` on `dismissal.bowler`/`.fielder`; `optional`
  // is a separate, hand-authored flag the picker reads (see `PadAttributionItem`
  // in sport/module.ts).
  //
  // S18/owner ruling 12 (pad wiring) — three more flags on these same six
  // fields/two attributions, closing gaps found by reading `checkActionValidity`/
  // `buildActionPayload` rather than assumed:
  // - `optional: true` on all six new FIELDS. Every field on this action used
  //   to be required for Confirm (`checkActionValidity` gates on EVERY
  //   declared field); without this, the six new fields would silently make
  //   the whole action require MORE input than before, and the legacy
  //   7-field payload would become unreachable from the pad — exactly the
  //   opposite of "additive, band-2 unchanged" this ruling promises.
  // - `chips: true` on `batting.dismissal.kind` — the ten dismissal modes
  //   render as a chip row (data-value, ≥44px), like every other pad chip,
  //   rather than the generic enum `<select>`.
  // - `requiresField: "batting.dismissal.kind"` on both dismissal-credit
  //   attributions — `dismissal.kind` is NOT optional inside the schema's own
  //   `dismissal` sub-object, so a scorer who names a bowler/fielder without
  //   ever picking a kind would otherwise build a payload the schema rejects
  //   outright. See `PadAttributionItem.requiresField`'s own doc in
  //   sport/module.ts for the full mechanism.
  //
  // Task 20 — `group: "batting"`/`"bowling"` on every field of its aspect
  // (including the legacy, still-`optional`-less ones): `CricketPlayerLine`'s
  // schema and `applyPlayerLine` already accept EITHER aspect alone (see
  // this schema's own `.refine()` and `applyPlayerLine`'s independent
  // `payload.batting !== undefined`/`payload.bowling !== undefined` checks
  // below) — the pad-form layer was the only place still requiring BOTH.
  // `PadField.group`'s own doc (sport/module.ts) has the full mechanism;
  // `innings` stays ungrouped (shared by both aspects, always required).
  //
  // Task A — every remaining control on this action is now CAPTIONED. A
  // `labelKey` is optional by design (`PadFieldEnum`'s header, module.ts) and
  // apps/web's universal renderer falls back to `deriveFieldPathLabel(path)`,
  // which is derived ENGLISH routed through no dictionary — so the seven
  // fields and the `person` attribution that shipped uncaptioned read
  // "Bowling legal balls" / "Scorecard line — Person" to a French, Spanish or
  // Dutch scorer. This action is the one a scorer fills in field by field
  // with no surrounding layout naming anything, so every control here earns a
  // key; the other twelve cricket actions keep theirs deliberately (see
  // `WICKET_ATTRIBUTION` above). Two notes on the keys:
  // - the aspect segment is KEPT (`…field.battingRuns`, not `…field.runs`)
  //   where the leaf name collides. `batting.runs` and `bowling.runs` are two
  //   different numbers on ONE form; the older sibling convention
  //   (`batting.fours` -> `…field.fours`) only holds while leaves are unique,
  //   and `checkLabelKeysUnique` would flag the collision as a false alarm.
  // - the captions are the scorecard's own words ("Balls faced", "Runs
  //   conceded"), not the path's, precisely because two of them would
  //   otherwise be the same word twice.
  //
  // Task B — `requiresFieldIn` on `batting.dismissal.bowler` (see its own
  // line below, and `PadAttributionItem.requiresFieldIn` in sport/module.ts).
  const playerLineAction: PadAction = {
    type: "cricket.player.line",
    labelKey: { key: "pad.cricket.action.playerLine", label: "Scorecard line" },
    fields: [
      {
        kind: "number",
        path: "innings",
        min: 1,
        max: Math.max(1, cfg.inningsPerSide * 2),
        labelKey: { key: "pad.cricket.action.playerLine.field.innings", label: "Innings" },
      },
      {
        kind: "toggle",
        path: "batting.out",
        group: "batting",
        labelKey: { key: "pad.cricket.action.playerLine.field.battingOut", label: "Dismissed" },
      },
      {
        kind: "number",
        path: "batting.runs",
        min: 0,
        max: MAX_PLAUSIBLE_RUNS,
        group: "batting",
        labelKey: { key: "pad.cricket.action.playerLine.field.battingRuns", label: "Runs scored" },
      },
      {
        kind: "number",
        path: "batting.balls",
        min: 0,
        max: inningsBallsBound(cfg),
        group: "batting",
        labelKey: { key: "pad.cricket.action.playerLine.field.battingBalls", label: "Balls faced" },
      },
      {
        kind: "number",
        path: "batting.fours",
        min: 0,
        max: inningsBallsBound(cfg),
        optional: true,
        group: "batting",
        labelKey: { key: "pad.cricket.action.playerLine.field.fours", label: "Fours" },
      },
      {
        kind: "number",
        path: "batting.sixes",
        min: 0,
        max: inningsBallsBound(cfg),
        optional: true,
        group: "batting",
        labelKey: { key: "pad.cricket.action.playerLine.field.sixes", label: "Sixes" },
      },
      {
        kind: "enum",
        path: "batting.dismissal.kind",
        values: DISMISSAL_KINDS,
        chips: true,
        optional: true,
        group: "batting",
        labelKey: { key: "pad.cricket.action.playerLine.field.dismissalKind", label: "How out" },
      },
      {
        kind: "number",
        path: "bowling.legalBalls",
        min: 0,
        max: inningsBallsBound(cfg),
        group: "bowling",
        labelKey: { key: "pad.cricket.action.playerLine.field.bowlingLegalBalls", label: "Balls bowled" },
      },
      {
        kind: "number",
        path: "bowling.runs",
        min: 0,
        max: MAX_PLAUSIBLE_RUNS,
        group: "bowling",
        labelKey: { key: "pad.cricket.action.playerLine.field.bowlingRuns", label: "Runs conceded" },
      },
      {
        kind: "number",
        path: "bowling.wickets",
        min: 0,
        max: Math.max(0, cfg.playersPerSide - 1),
        group: "bowling",
        labelKey: { key: "pad.cricket.action.playerLine.field.bowlingWickets", label: "Wickets" },
      },
      {
        kind: "number",
        path: "bowling.maidens",
        min: 0,
        max: Math.max(0, Math.floor(inningsBallsBound(cfg) / cfg.ballsPerOver)),
        optional: true,
        group: "bowling",
        labelKey: { key: "pad.cricket.action.playerLine.field.maidens", label: "Maidens" },
      },
      {
        kind: "number",
        path: "bowling.wides",
        min: 0,
        max: MAX_PLAUSIBLE_RUNS,
        optional: true,
        group: "bowling",
        labelKey: { key: "pad.cricket.action.playerLine.field.wides", label: "Wides" },
      },
      {
        kind: "number",
        path: "bowling.noBalls",
        min: 0,
        max: MAX_PLAUSIBLE_RUNS,
        optional: true,
        group: "bowling",
        labelKey: { key: "pad.cricket.action.playerLine.field.noBalls", label: "No-balls" },
      },
    ],
    attribution: [
      {
        kind: "person",
        path: "person",
        labelKey: { key: "pad.cricket.action.playerLine.field.person", label: "Player" },
      },
      {
        kind: "person",
        path: "batting.dismissal.bowler",
        optional: true,
        requiresField: "batting.dismissal.kind",
        // W1 review finding P2 — `applyPlayerLine` (above) refuses a named
        // bowler on any kind this set does not credit one for, so the pad
        // must not OFFER the chips there. Spread from the reducer's OWN set
        // rather than restated, so the two cannot drift: a kind added to or
        // removed from `BOWLER_CREDITED_KINDS` moves the pad with it.
        requiresFieldIn: [...BOWLER_CREDITED_KINDS],
        labelKey: { key: "pad.cricket.action.playerLine.field.dismissalBowler", label: "Bowler" },
      },
      {
        kind: "person",
        path: "batting.dismissal.fielder",
        optional: true,
        requiresField: "batting.dismissal.kind",
        labelKey: { key: "pad.cricket.action.playerLine.field.dismissalFielder", label: "Fielder" },
      },
    ],
  };

  // spec §2.3/§2.6 — declare/follow-on/time-expiry draw only exist for
  // 2-innings cricket; a limited-overs padSpec simply never includes them,
  // rather than including an action the fold would refuse on every cfg it
  // renders for (`state.cfg.inningsPerSide !== 2` -> INVALID_EVENT). This is
  // the cfg-only case the module-level note on `PadGate` describes: no gate
  // needed, `padSpec(cfg)` just doesn't build the action.
  const twoInnings = cfg.inningsPerSide === 2;
  const followOnEnabled = twoInnings && cfg.followOn?.enabled === true;

  const inningsActions: PadAction[] = [
    inningsSummaryAction,
    inningsCloseAction,
    newBallAction,
    powerplayAction,
    interruptionAction,
    retireAction,
    ...(twoInnings ? [declareAction] : []),
    ...(followOnEnabled ? [followOnAction] : []),
    ...(twoInnings ? [matchCloseAction] : []),
  ];

  // DLS panel: cfg-only inclusion, same reasoning as above.
  const dlsPanels: PadPanel[] = cfg.dls.enabled
    ? [
        {
          labelKey: { key: "pad.cricket.panel.dls", label: "DLS" },
          phase: "live",
          layout: "drawer",
          actions: [reviseAction],
        },
      ]
    : [];

  // Super over panel: cfg decides whether the FORMAT can ever reach one
  // (`cfg.superOver`) — a knockout T20 declares it, a two-innings Test never
  // does. Whether it is reachable RIGHT NOW is state, not cfg (a league game
  // may finish level and never actually go to a super over), so the panel
  // also carries a runtime gate: visible in the spec once the format allows
  // it, shown by the renderer only once the match has actually reached one.
  const superOverPanels: PadPanel[] = cfg.superOver
    ? [
        {
          labelKey: { key: "pad.cricket.panel.superOver", label: "Super over" },
          phase: "live",
          layout: "drawer",
          actions: [superOverAction],
          gate: { op: "path-equals", path: "state.phase", value: "super_over" } satisfies PadGate,
        },
      ]
    : [];

  const panels: PadPanel[] = [
    {
      labelKey: { key: "pad.cricket.panel.pre", label: "Pre-match" },
      phase: "pre",
      layout: "primary",
      actions: [tossAction],
    },
    {
      labelKey: { key: "pad.cricket.panel.over", label: "Over" },
      phase: "live",
      layout: "primary",
      actions: [ballAction],
    },
    {
      labelKey: { key: "pad.cricket.panel.extras", label: "Extras" },
      phase: "live",
      layout: "grid",
      actions: [extraAction],
    },
    {
      labelKey: { key: "pad.cricket.panel.wicket", label: "Wicket" },
      phase: "live",
      layout: "grid",
      actions: [wicketAction],
    },
    {
      labelKey: { key: "pad.cricket.panel.reviews", label: "Reviews" },
      phase: "live",
      layout: "drawer",
      actions: [reviewAction],
    },
    {
      labelKey: { key: "pad.cricket.panel.innings", label: "Innings" },
      phase: "live",
      layout: "drawer",
      actions: inningsActions,
    },
    ...dlsPanels,
    ...superOverPanels,
    {
      labelKey: { key: "pad.cricket.panel.post", label: "Scorecard" },
      phase: "post",
      layout: "primary",
      actions: [playerLineAction],
    },
  ];

  // R8/WS-B — `required` stamped ONCE, here, from CRICKET_EVENT_SCHEMAS
  // itself (never hand-typed per action; see module.ts's own doc comment).
  return stampAttributionRequired(
    {
      panels,
      // S6 owner ruling (`_INDEX.md`, "OWNER RULING: redesign the fidelity
      // model, in S6") — one band per event type, no repetition. The retired
      // cumulative-tier model listed `cricket.superover.ball` in BOTH tier 1
      // and tier 3 — the non-nesting inconsistency S2/#430 found, and the
      // reason for this redesign. A super-over ball is the same
      // shape and the same granularity as an ordinary ball, so it belongs at
      // band 3 here, matching `cricket.ball`, not band 1.
      fidelity: {
        "cricket.innings.summary": 0,
        "cricket.toss": 1,
        "cricket.innings.declare": 1,
        "cricket.innings.close": 1,
        "cricket.match.close": 1,
        "cricket.interruption": 1,
        "cricket.revise": 1,
        "cricket.followon": 1,
        "cricket.newball": 1,
        "cricket.powerplay": 1,
        "cricket.review": 1,
        "cricket.player.line": 2,
        "cricket.ball": 3,
        "cricket.superover.ball": 3,
        "cricket.retire": 3,
      },
    },
    CRICKET_EVENT_SCHEMAS,
  );
}

export const cricket: SportModule<CricketCfg, CricketEv, CricketState> = {
  key: "cricket",
  version: "1.0.0",
  configSchema: CricketCfg,
  eventSchema: CricketEv,
  eventSchemas: CRICKET_EVENT_SCHEMAS,
  padSpec,
  positions,
  positionsFor,
  entrantModel: { kinds: ["team"], defaultKind: "team", team: { squadNumbers: true, captain: true } },
  // The concussion allowance is declared ONLY on the three formats the ICC's
  // playing conditions cover (DOMAIN.md, "Batters coming and going"). `hundred`
  // is deliberately left without it: ruling 1's default is off, and a variant
  // that says nothing keeps the squad its team sheets declared. Changing
  // `variants` is golden-safe — the corpus stores and re-parses the RAW config
  // objects it was recorded with, and `configsFor()` only runs under
  // UPDATE_GOLDEN=1.
  //
  // A fifth variant, `pairs-6-a-side`, was dropped 2026-08-11 (#431 ruling 3):
  // it only ever shrank the side to 6 and the innings to 60 balls, and the
  // real pairs convention (fixed pairs, a dismissal costs runs instead of
  // ending the partnership) is a different scoring grammar, not an extension
  // of this one — "a variant that cannot score its own sport is worse than no
  // variant." See docs/superpowers/specs/2026-08-06-scoringpad-v2-prompts/
  // _INDEX.md, the 2026-08-11 decision log entry, for the full reasoning.
  variants: {
    // spec 04 §2.1
    t20: { ballsPerInnings: 120, maxOversPerBowler: 4, lineupChanges: { concussionReplacements: 1 } },
    odi: {
      ballsPerInnings: 300,
      maxOversPerBowler: 10,
      minOversForResult: 20,
      lineupChanges: { concussionReplacements: 1 },
    },
    hundred: { ballsPerInnings: 100, ballsPerOver: 5, maxOversPerBowler: 4 },
    test: {
      inningsPerSide: 2,
      ballsPerInnings: null,
      points: { win: 2, tie: 1, noResult: 1, loss: 0, draw: 1 },
      superOver: false, // multi-day cricket draws; it never goes to a super over
      followOn: { enabled: true, lead: 200 },
      minOversForResult: 0,
      lineupChanges: { concussionReplacements: 1 },
    },
  },

  // spec 03 §2 guarantee 4 — post-match scorecards append after the decision.
  postDecisionTypes: ["cricket.player.line"],

  /**
   * S3/W4b (#426) — what this variant permits a squad to do, handed to
   * `core/lineup.ts`. THE MODULE OWNS NO SQUAD LOGIC: it translates cfg into a
   * policy and the kernel enforces it. There is no membership test, no
   * replacement counter and no re-entry rule anywhere in this file, and
   * `grep -a "initSquads|reduceLineupEvent|subsUsed >=|exemptUsed\["` over
   * `src/sports/` is the check that keeps it that way.
   *
   * PURE AND TOTAL, like every cfg-derived verdict in this wave. It reads cfg
   * and returns a value; it cannot throw, so it cannot brick a recorded
   * fixture, and on the read path the fold ignores it entirely in favour of
   * `REPLAY_LINEUP_POLICY`.
   *
   * `maxSubs: 0` IS THE DEFAULT, and it is a statement rather than an
   * omission. Leaving the cap absent means UNCAPPED in the kernel, which would
   * say cricket permits unlimited outright substitution — the opposite of Law
   * 24, under which a substitute fields only and never bats, bowls or keeps.
   * Zero also makes the exemption channel meaningful from the first ball: the
   * cap and the exemption disagree in every shipped variant, which is the
   * property `cricket.lineup.test.ts` pins.
   *
   * `reentry` defaults to `none` because ICC concussion conditions make the
   * replaced player's departure permanent. That is NOT the answer for a batter
   * who retired hurt — he may resume — and the two coexist because they are
   * different axes: retirement is the CREASE (`fine.retiredNotOut`, resolved by
   * `resolveIncoming`), this knob is the FIELD. A retired-hurt batter never
   * leaves the field, so nothing here is asked about him.
   */
  lineupPolicy(cfg): LineupPolicy {
    const changes = cfg.lineupChanges;
    const concussion = changes?.concussionReplacements ?? 0;
    return {
      reentry: changes?.reentry ?? "none",
      // FIVB 15.6's lock is a volleyball rule; cricket's positions are fielding
      // groups a captain moves at will (Law 28 is about where they stand, not
      // about who may stand there).
      reentryPositionLock: false,
      // Ruling 1 — the ONLY reason a cricket squad may grow is the like-for-like
      // replacement, so growth is gated on that allowance and nothing else.
      allowSquadGrowth: concussion > 0,
      maxSubs: changes?.maxSubs ?? 0,
      ...(concussion === 0 ? {} : { exemptions: { concussion: { max: concussion } } }),
    };
  },

  init(cfg, lineups: LineupPair): CricketState {
    // `fresh` registers this exact object for the `onLineup` handshake and
    // returns it unchanged, so `init`'s output is byte-identical to pre-wave.
    return squadAdopter.fresh({
      cfg,
      entrants: { home: lineups.home.entrantId, away: lineups.away.entrantId },
      orders: { home: orderFromLineup(lineups.home), away: orderFromLineup(lineups.away) },
      phase: "pre",
      battingFirst: "home", // toss overrides
      tossTaken: false,
      innings: [],
      followOnEnforced: false,
      quota: cfg.ballsPerInnings,
      revisedTarget: null,
      targetSource: null,
      r1: null,
      r2: null,
      interruptions: 0,
      superOver: null,
      outcome: null,
      margin: null,
      playerLines: [],
    });
  },

  /**
   * S3/W4b (#426) — the kernel handing back the squads it has just folded.
   *
   * Two jobs, in this order and for a reason. `adopt` first: it identifies the
   * `init` handshake by the identity of the object `init` returned, so it must
   * see that object and not a copy — `withArrivals` is identity at `init`
   * anyway, but relying on that would make a correctness property depend on an
   * optimisation. Then `withArrivals` keeps the batting order honest.
   *
   * NOTHING HERE DECIDES ANYTHING. There is no membership test, no replacement
   * counter and no re-entry rule in this function or anywhere else in this
   * file: `core/lineup.ts` accepted the change before cricket was told, and
   * this hook is only asked where the result may land.
   */
  onLineup(state, squads) {
    return withArrivals(squadAdopter.adopt(state, squads), squads);
  },

  apply(state, ev: EventEnvelope<CricketEv | CoreEv>, ctx): CricketState {
    const strict = isStrictFold(ctx);
    switch (ev.type) {
      case "core.start":
        if (state.phase !== "pre") wrongPhase("already started");
        return { ...state, phase: "live" };
      case "cricket.toss": {
        if (state.phase !== "pre") wrongPhase("toss must precede core.start");
        if (state.tossTaken) invalid("toss already recorded");
        const payload = parsePayload(CricketToss, ev.payload, ev.type);
        const winner = sideOf(state, payload.wonBy);
        return {
          ...state,
          tossTaken: true,
          battingFirst: payload.elected === "bat" ? winner : opponent(winner),
        };
      }
      case "cricket.ball": {
        if (state.phase !== "live") wrongPhase(`ball in phase "${state.phase}"`);
        const payload = parsePayload(CricketBall, ev.payload, ev.type);
        let next = state;
        let open = openInnings(next);
        if (open !== null && open.innings.fine === null) {
          invalid("this innings is recorded at summary fidelity — ball events are not allowed");
        }
        if (open === null) {
          next = createInnings(next, "fine", {
            striker: payload.striker,
            nonStriker: payload.nonStriker,
          });
          // See applySummary above: the assertion is the narrowing, and
          // no-unnecessary-type-assertion's autofix breaks tsc without it.
          // eslint-disable-next-line @typescript-eslint/no-unnecessary-type-assertion
          open = openInnings(next) as { innings: InningsState; index: number };
        }
        const battingSide = open.innings.battingSide;
        const updated = applyDelivery(open.innings, payload, {
          battingOrder: next.orders[battingSide],
          bowlingOrder: next.orders[opponent(battingSide)],
          whiteBall: next.cfg.ballsPerInnings !== null,
          ballsPerOver: next.cfg.ballsPerOver,
          maxOversPerBowler: next.cfg.maxOversPerBowler,
          allOut: allOutWickets(next, battingSide),
          strictOrder: true,
          soIneligible: [],
          strictFold: strict,
        });
        return autoClose(replaceInnings(next, open.index, updated));
      }
      case "cricket.superover.ball":
        return applySuperOverBall(state, parsePayload(CricketBall, ev.payload, ev.type), strict);
      case "cricket.innings.summary":
        return applySummary(state, parsePayload(CricketInningsSummary, ev.payload, ev.type), strict);
      case "cricket.innings.declare": {
        if (state.phase !== "live") wrongPhase(`declare in phase "${state.phase}"`);
        parsePayload(CricketDeclare, ev.payload, ev.type);
        if (state.cfg.inningsPerSide !== 2) {
          invalid("declarations apply to two-innings matches only");
        }
        return closeOpenInnings(state, true);
      }
      case "cricket.innings.close": {
        if (state.phase !== "live") wrongPhase(`innings close in phase "${state.phase}"`);
        const payload = parsePayload(CricketClose, ev.payload, ev.type);
        return closeOpenInnings(state, false, payload.reason);
      }
      case "cricket.retire":
        return applyRetire(state, parsePayload(CricketRetire, ev.payload, ev.type));
      case "cricket.newball":
        parsePayload(CricketNewBall, ev.payload, ev.type);
        return applyNewBall(state);
      case "cricket.powerplay":
        return applyPowerplay(state, parsePayload(CricketPowerplay, ev.payload, ev.type));
      case "cricket.review":
        return applyReview(state, parsePayload(CricketReview, ev.payload, ev.type));
      case "cricket.match.close": {
        if (state.phase !== "live") wrongPhase(`match close in phase "${state.phase}"`);
        parsePayload(CricketMatchClose, ev.payload, ev.type);
        if (state.cfg.inningsPerSide !== 2) {
          invalid("match close (time expiry draw) applies to two-innings matches only");
        }
        // spec §2.3 — draw on time expiry.
        return { ...state, phase: "done", outcome: { kind: "draw" }, margin: null };
      }
      case "cricket.interruption": {
        if (state.phase !== "pre" && state.phase !== "live") {
          wrongPhase(`interruption in phase "${state.phase}"`);
        }
        parsePayload(CricketInterruption, ev.payload, ev.type);
        // Metadata only — the revise event carries the numbers (spec §2.5).
        return { ...state, interruptions: state.interruptions + 1 };
      }
      case "cricket.revise":
        return applyRevise(state, parsePayload(CricketRevise, ev.payload, ev.type), strict);
      case "cricket.followon": {
        if (state.phase !== "live") wrongPhase(`follow-on in phase "${state.phase}"`);
        parsePayload(CricketFollowOn, ev.payload, ev.type);
        const followOn = state.cfg.followOn;
        if (state.cfg.inningsPerSide !== 2 || followOn === undefined || !followOn.enabled) {
          invalid("follow-on is not enabled for this match");
        }
        if (state.innings.length !== 2 || openInnings(state) !== null) {
          invalid("follow-on is decided between the 2nd and 3rd innings");
        }
        const lead =
          (state.innings[0] as InningsState).runs - (state.innings[1] as InningsState).runs;
        if (lead < followOn.lead) {
          invalid(`follow-on requires a lead of ${followOn.lead} (actual ${lead})`);
        }
        return { ...state, followOnEnforced: true };
      }
      case "cricket.player.line":
        return applyPlayerLine(state, parsePayload(CricketPlayerLine, ev.payload, ev.type));
      case "core.forfeit": {
        if (state.phase === "done" || state.phase === "final") wrongPhase("match already over");
        const { by, reason } = forfeitOf(ev.payload);
        const winner = opponent(sideOf(state, by));
        return {
          ...state,
          phase: "done",
          outcome: { kind: "award", winner: state.entrants[winner], method: reason },
          margin: null,
        };
      }
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

  // W4a (#425) T6b — the cross-sport position axis (see `cricketPosition`).
  position: cricketPosition,

  // §9.5 — reads only InningsTotals (never fine state), so coarse and fine
  // folds of the same match render identically (§9.6).
  summary(state): ScoreSummary {
    const home = sideLine(state, "home");
    const away = sideLine(state, "away");
    const so = state.superOver;
    const soTally =
      so === null
        ? null
        : so.innings.reduce(
            (tally, innings) => {
              tally[innings.battingSide] += innings.runs;
              return tally;
            },
            { home: 0, away: 0 },
          );
    const headline = `${home} — ${away}${soTally ? ` · SO ${soTally.home}–${soTally.away}` : ""}`;
    return {
      headline,
      perSide: [
        { entrantId: state.entrants.home, line: home },
        { entrantId: state.entrants.away, line: away },
      ],
      detail: {
        innings: state.innings.map((innings) => ({
          entrantId: state.entrants[innings.battingSide],
          runs: innings.runs,
          wickets: innings.wickets,
          legalBalls: innings.legalBalls,
          declared: innings.declared,
          closed: innings.closed,
          // W4 — survives coarsening (the close event passes through), so the
          // §9.6 coarse ≡ fine summary equality still holds.
          ...(innings.closeReason === undefined ? {} : { closeReason: innings.closeReason }),
        })),
        ...(state.revisedTarget === null
          ? {}
          : { target: state.revisedTarget, targetSource: state.targetSource }),
        ...(state.margin === null ? {} : { margin: state.margin }),
        ...(soTally === null ? {} : { superOver: soTally }),
      },
    };
  },

  // spec §2.4/§2.6 — integer NRR ledger; NRR itself is computed at rank time
  // from these integers (never stored as a float).
  standingsDelta(outcome, cfg, _ctx: StageCtx, state): [StandingsDelta, StandingsDelta] {
    const allOutFor = (side: Side) => allOutWickets(state, side);
    // spec §2.4 — a bowled-out side is charged its full quota; DLS-revised
    // matches use the revised quota (the innings' ballsLimit at close).
    const effectiveBalls = (innings: InningsState): number => {
      if (innings.ballsLimit !== null && innings.wickets >= allOutFor(innings.battingSide)) {
        return innings.ballsLimit;
      }
      return innings.legalBalls;
    };
    const ledger = (side: Side): Record<string, number> => {
      let runsFor = 0;
      let ballsFaced = 0;
      let runsAgainst = 0;
      let ballsBowled = 0;
      for (const innings of state.innings) {
        if (innings.battingSide === side) {
          runsFor += innings.runs;
          ballsFaced += effectiveBalls(innings);
        } else {
          runsAgainst += innings.runs;
          ballsBowled += effectiveBalls(innings);
        }
      }
      return {
        runs_for: runsFor,
        balls_faced_eff: ballsFaced,
        runs_against: runsAgainst,
        balls_bowled_eff: ballsBowled,
        ties: 0,
        no_results: 0,
      };
    };
    const zeroLedger = (): Record<string, number> => ({
      runs_for: 0,
      balls_faced_eff: 0,
      runs_against: 0,
      balls_bowled_eff: 0,
      ties: 0,
      no_results: 0,
    });
    const build = (
      side: Side,
      w: number,
      d: number,
      l: number,
      pts: number,
      metrics: Record<string, number>,
    ): StandingsDelta => ({
      entrantId: state.entrants[side],
      played: 1,
      won: w,
      drawn: d,
      lost: l,
      points: pts,
      metrics,
    });

    switch (outcome.kind) {
      case "win": {
        const winnerSide = sideOf(state, outcome.winner);
        const winner = build(winnerSide, 1, 0, 0, cfg.points.win, ledger(winnerSide));
        const loser = build(opponent(winnerSide), 0, 0, 1, cfg.points.loss, ledger(opponent(winnerSide)));
        return winnerSide === "home" ? [winner, loser] : [loser, winner];
      }
      case "award": {
        // Forfeit: full points, no NRR contribution (ICC convention).
        const winnerSide = sideOf(state, outcome.winner);
        const winner = build(winnerSide, 1, 0, 0, cfg.points.win, zeroLedger());
        const loser = build(opponent(winnerSide), 0, 0, 1, cfg.points.loss, zeroLedger());
        return winnerSide === "home" ? [winner, loser] : [loser, winner];
      }
      case "tie": {
        const metrics = (side: Side) => ({ ...ledger(side), ties: 1 });
        return [
          build("home", 0, 0, 0, cfg.points.tie, metrics("home")),
          build("away", 0, 0, 0, cfg.points.tie, metrics("away")),
        ];
      }
      case "draw": {
        const pts = cfg.points.draw ?? cfg.points.tie;
        return [
          build("home", 0, 1, 0, pts, zeroLedger()),
          build("away", 0, 1, 0, pts, zeroLedger()),
        ];
      }
      case "no_result": {
        const metrics = () => ({ ...zeroLedger(), no_results: 1 });
        return [
          build("home", 0, 0, 0, cfg.points.noResult, metrics()),
          build("away", 0, 0, 0, cfg.points.noResult, metrics()),
        ];
      }
    }
  },

  metrics: [
    // doc 09 §2: cricket shows P W L T/NR Pts NRR. The four NRR operands are
    // ledger-only; NRR itself is a cascade-derived display column (engine
    // competition/display.ts).
    { key: "runs_for", label: "Runs for", direction: "desc", display: false },
    { key: "balls_faced_eff", label: "Balls faced (eff.)", direction: "asc", display: false },
    { key: "runs_against", label: "Runs against", direction: "asc", display: false },
    { key: "balls_bowled_eff", label: "Balls bowled (eff.)", direction: "desc", display: false },
    { key: "ties", label: "T", direction: "desc" },
    { key: "no_results", label: "NR", direction: "desc" },
  ],
  // spec §2.6 — ICC-style cascade; `nrr` is resolved from the integer ledger
  // by the competition engine at rank time (cross-multiplication).
  defaultTiebreakers: ["points", "wins", "nrr", "h2h_points", "seed"],

  // Draw exists only in 2-innings cricket and only survives league/group play.
  supportsDraws(cfg, stage: StageKind) {
    return cfg.inningsPerSide === 2 && (stage === "league" || stage === "group" || stage === "swiss");
  },

  // §9.3 — {win+loss, 2·tie, 2·noResult, 2·draw}.
  declaredPointsSets(cfg) {
    return [
      ...new Set([
        cfg.points.win + cfg.points.loss,
        cfg.points.tie * 2,
        cfg.points.noResult * 2,
        (cfg.points.draw ?? cfg.points.tie) * 2,
      ]),
    ];
  },

  playerStats: CRICKET_PLAYER_STATS,
  officialLabel: { scorer: "Umpire" }, // doc 13 §1

  // spec 03 §6 / PROMPT-05 §9 — generates only legal deliveries.
  arbitraryEvent(state, rng: Rng): ModuleEvent<CricketEv> | null {
    const pick = <T>(items: readonly T[]): T => items[Math.floor(rng() * items.length)] as T;

    if (state.phase === "pre") {
      if (!state.tossTaken && rng() < 0.4) {
        return {
          type: "cricket.toss",
          payload: {
            wonBy: rng() < 0.5 ? state.entrants.home : state.entrants.away,
            elected: rng() < 0.5 ? "bat" : "bowl",
          },
        };
      }
      return { type: "core.start", payload: {} };
    }
    if (state.phase === "done" || state.phase === "final") return null;

    if (state.phase === "super_over") {
      return { type: "cricket.superover.ball", payload: generateSoBall(state, rng) };
    }

    const open = openInnings(state);
    if (open === null) {
      // Between innings.
      const cfg = state.cfg;
      if (cfg.inningsPerSide === 2 && state.innings.length >= 2 && rng() < 0.05) {
        return { type: "cricket.match.close", payload: {} };
      }
      if (
        cfg.inningsPerSide === 2 &&
        cfg.followOn?.enabled === true &&
        state.innings.length === 2 &&
        !state.followOnEnforced &&
        (state.innings[0] as InningsState).runs - (state.innings[1] as InningsState).runs >=
          cfg.followOn.lead &&
        rng() < 0.5
      ) {
        return { type: "cricket.followon", payload: {} };
      }
      // W4 review item 3 — a Tier-2 scorecard line for a CLOSED fine innings.
      // The fold validates it against the innings ledger exactly, so it is
      // built FROM that ledger; a line that disagreed would be an event the
      // generator's own fold rejects (spec 03 §6).
      if (rng() < 0.25) {
        const line = generatePlayerLine(state, rng);
        if (line !== null) return { type: "cricket.player.line", payload: line };
      }
      if (rng() < 0.6) {
        // Coarse innings in one event.
        const limit = state.quota;
        const nextIndex = state.innings.length;
        const battingSide = battingSideAt(state, nextIndex);
        const allOut = allOutWickets(state, battingSide);
        const bowledOut = rng() < 0.3;
        const wickets = bowledOut ? allOut : Math.floor(rng() * allOut);
        const legalBalls =
          limit === null
            ? 60 + Math.floor(rng() * 400)
            : bowledOut
              ? 1 + Math.floor(rng() * limit)
              : limit;
        const runs = Math.floor(rng() * 220);
        // W4a follow-up — a coarse innings entered PROGRESSIVELY. `partial`
        // leaves the innings open (spec §2.3: the totals may only grow), which
        // is how a coarse scorer records a match while it is still being
        // played; the branch below then grows it to a finish. Only offered
        // where the snapshot is genuinely mid-innings — not all out and inside
        // the quota — or the fold auto-closes it and `partial` records nothing.
        // Derived from numbers already drawn, so it consumes no rng of its own.
        if (!bowledOut && limit !== null && runs % 2 === 0) {
          const half = Math.floor(runs / 2);
          return {
            type: "cricket.innings.summary",
            payload: {
              runs: half,
              wickets: Math.floor(wickets / 2),
              legalBalls: Math.floor(legalBalls / 2),
              boundaries: Math.floor(half / 8),
              partial: true,
            },
          };
        }
        return {
          type: "cricket.innings.summary",
          payload: {
            runs,
            wickets,
            legalBalls,
            boundaries: Math.floor(runs / 8),
            ...(state.cfg.inningsPerSide === 2 && rng() < 0.15 ? { declared: true } : {}),
          },
        };
      }
      return { type: "cricket.ball", payload: generateBall(state, rng) };
    }

    if (open.innings.fine === null) {
      // An open COARSE innings — the progressive snapshot above left it open.
      // Grow the totals to a legal finish and close it with a non-partial
      // summary; that is the second half of progressive coarse scoring, and it
      // is what makes the partial branch a real fold path rather than a flag.
      const { innings } = open;
      const allOut = allOutWickets(state, innings.battingSide);
      const wicketRoom = allOut - innings.wickets;
      const ballRoom = innings.ballsLimit === null ? 60 : innings.ballsLimit - innings.legalBalls;
      const runs = innings.runs + Math.floor(rng() * 120);
      return {
        type: "cricket.innings.summary",
        payload: {
          runs,
          wickets: innings.wickets + (wicketRoom > 0 ? Math.floor(rng() * (wicketRoom + 1)) : 0),
          legalBalls: innings.legalBalls + (ballRoom > 0 ? Math.floor(rng() * (ballRoom + 1)) : 0),
          boundaries: Math.floor(runs / 8),
        },
      };
    }
    const roll = rng();
    if (roll < 0.004) return { type: "core.abandon", payload: { reason: "rain" } };
    if (roll < 0.006) {
      return {
        type: "core.forfeit",
        payload: { by: rng() < 0.5 ? state.entrants.home : state.entrants.away, reason: "walkover" },
      };
    }
    if (roll < 0.012 && state.quota !== null && state.cfg.inningsPerSide === 1) {
      const bpo = state.cfg.ballsPerOver;
      const currentOvers = Math.floor(state.quota / bpo);
      const floorOvers = Math.max(1, Math.ceil(open.innings.legalBalls / bpo));
      if (currentOvers - 1 >= floorOvers) {
        const newOvers = Math.max(floorOvers, currentOvers - 1 - Math.floor(rng() * 3));
        // W4a follow-up — every other revise of a CHASE also carries the
        // umpire-confirmed target (§2.5: a manual target always wins over the
        // computed one). Its VALUE is the target the chase already had, so the
        // revise decides nothing it would not have decided anyway and no
        // existing walk moves; what it does change is `targetSource`, which is
        // the whole point — a manual target is folded, and the match reads as
        // won against a revised target rather than a regulation one. Offered
        // only where the first innings is complete, so runs + 1 IS the target,
        // and only where DLS is off, since the two are alternatives.
        const first = state.innings[0];
        const chasing = state.innings.length === 2 && first !== undefined && first.closed;
        const named = chasing && !state.cfg.dls.enabled && open.innings.legalBalls % 2 === 0;
        return {
          type: "cricket.revise",
          payload: {
            oversPerSide: newOvers,
            ...(named ? { target: first.runs + 1 } : {}),
          },
        };
      }
    }
    if (
      roll < 0.03 &&
      state.cfg.inningsPerSide === 2 &&
      open.innings.runs > 50 &&
      state.innings.length < 4
    ) {
      return { type: "cricket.innings.declare", payload: {} };
    }

    // W4 domain events. They occupy their own bands of the roll so the
    // pre-existing abandon/forfeit/revise/declare bands keep their rates.
    if (roll >= 0.03 && roll < 0.036) {
      const blocks = open.innings.powerplays ?? [];
      const openBlock = blocks.find((block) => block.toBalls === null);
      return openBlock === undefined
        ? {
            type: "cricket.powerplay",
            payload: { kind: pick(["mandatory", "batting", "bowling"] as const), phase: "start" },
          }
        : { type: "cricket.powerplay", payload: { kind: openBlock.kind, phase: "end" } };
    }
    if (roll >= 0.036 && roll < 0.04) {
      if (!(open.innings.newBallAt ?? []).includes(open.innings.legalBalls)) {
        return { type: "cricket.newball", payload: {} };
      }
    }
    if (roll >= 0.04 && roll < 0.046) {
      const by = rng() < 0.5 ? state.entrants.home : state.entrants.away;
      const side = sideOf(state, by);
      const remaining = reviewsRemaining(open.innings, state.cfg.reviews?.perInnings, side);
      if (remaining === null || remaining > 0) {
        // `against` — the batter the decision concerned — is DERIVED from the
        // crease and gated on a state parity, for the same reason as
        // `wicket.incoming` above: it consumes no rng, so adding it re-seeds no
        // existing stream. It feeds no fold path at all (applyReview only moves
        // the allowance ledger), which is exactly why nothing but a corpus
        // coverage check would ever notice it was unwritten.
        const against = open.innings.fine.striker;
        const named = against !== null && open.innings.legalBalls % 2 === 0;
        return {
          type: "cricket.review",
          payload: {
            by,
            kind: rng() < 0.2 ? "umpire" : "player",
            ...(named ? { against } : {}),
            outcome: pick(["upheld", "struck_down", "umpires_call"] as const),
          },
        };
      }
    }
    // W4 review item 3 — the generator could not reach these two, so no
    // corpus could hold them and no property run explored them.
    if (roll >= 0.052 && roll < 0.056) {
      return {
        type: "cricket.interruption",
        payload: {
          kind: pick(["rain", "light", "other"] as const),
          ...(rng() < 0.5 ? { oversLostEstimate: 1 + Math.floor(rng() * 6) } : {}),
        },
      };
    }
    if (roll >= 0.056 && roll < 0.058 && open.innings.legalBalls > 0) {
      // An innings closed by the umpires rather than by a fold predicate: the
      // three auto-closes are derivable from the totals, these are not.
      return {
        type: "cricket.innings.close",
        payload: { reason: pick(["time", "weather", "other"] as const) },
      };
    }
    if (roll >= 0.046 && roll < 0.052) {
      const fine = open.innings.fine;
      const person = rng() < 0.5 ? fine.striker : fine.nonStriker;
      if (person !== null) {
        // Only offer a retirement when a legal replacement exists, so the
        // generator never emits an event its own fold would reject.
        const unavailable = new Set<string>([
          ...fine.dismissed,
          ...(fine.retiredNotOut ?? []),
          ...[fine.striker, fine.nonStriker].filter((p): p is string => p !== null),
        ]);
        const battingOrder = state.orders[open.innings.battingSide];
        const byOrder = nextBatterFrom(battingOrder, fine.nextBatterIndex, unavailable);
        if (byOrder !== null) {
          // Half the time name the incoming batter explicitly (Law 25.1 —
          // the order after the openers is the captain's), which is also how
          // the coarsener learns who walked in.
          const eligible = battingOrder.filter((p) => !unavailable.has(p));
          const incoming = rng() < 0.5 ? pickFrom(eligible, rng) : undefined;
          return {
            type: "cricket.retire",
            payload: {
              person,
              reason: rng() < 0.5 ? "hurt" : "out",
              ...(incoming === undefined ? {} : { incoming }),
            },
          };
        }
      }
    }
    return { type: "cricket.ball", payload: generateBall(state, rng) };
  },

  // §9.6 / spec §2.2 — coarsen: collapse ball runs into innings summaries.
  // cfg-free by design: it emits `partial` snapshots at every boundary and
  // lets the fold's auto-close rules (identical for both fidelities) decide
  // closure, so coarse folds close and decide exactly where fine folds did.
  coarsen(events): ModuleEvent<CricketEv>[] {
    interface Tracker {
      runs: number;
      wickets: number;
      legalBalls: number;
      boundaries: number;
      seen: Set<string>;
    }
    const out: ModuleEvent<CricketEv>[] = [];
    let cur: Tracker | null = null;
    let dirty = false; // unflushed deliveries since the last snapshot
    // W4 — a retirement swaps a batter with no delivery in between, so both
    // ends of the crease can be "unseen" on the next ball without the innings
    // having changed. The over/ball restart below is the reliable signal;
    // this flag stops the (still useful) unseen-pair heuristic from firing on
    // a retirement instead.
    let retiredSinceBall = false;
    // Emit a cumulative partial snapshot at most once per set of new balls, so
    // a snapshot taken for a mid-innings pass-through (revise) isn't re-emitted
    // by the trailing flush as a post-decision duplicate.
    const flush = () => {
      if (cur === null || !dirty) return;
      out.push({
        type: "cricket.innings.summary",
        payload: {
          runs: cur.runs,
          wickets: cur.wickets,
          legalBalls: cur.legalBalls,
          boundaries: cur.boundaries,
          partial: true,
        },
      });
      dirty = false;
    };
    for (const event of events) {
      switch (event.type) {
        case "cricket.ball": {
          const ball = event.payload as CricketBallEv;
          // New innings when the over/ball cursor restarts after a legal
          // delivery has been bowled (0.1 can only recur before the first
          // legal ball of an innings), or when both crease batters are unseen
          // (sides alternate; the follow-on boundary always carries an
          // explicit event). The second signal is suppressed straight after a
          // retirement, which can change both ends without a delivery.
          const restarted = ball.over === 0 && ball.ballInOver === 1;
          if (
            cur !== null &&
            ((restarted && cur.legalBalls > 0) ||
              (!retiredSinceBall &&
                !cur.seen.has(ball.striker) &&
                !cur.seen.has(ball.nonStriker)))
          ) {
            flush();
            cur = null;
          }
          retiredSinceBall = false;
          cur ??= { runs: 0, wickets: 0, legalBalls: 0, boundaries: 0, seen: new Set() };
          const extras = ball.runs.extras;
          const legal =
            extras === undefined || (extras.kind !== "wide" && extras.kind !== "noball");
          cur.runs += ball.runs.bat + (extras?.runs ?? 0);
          cur.wickets += ball.wicket === undefined ? 0 : 1;
          cur.legalBalls += legal ? 1 : 0;
          cur.boundaries += ball.boundary === undefined ? 0 : 1;
          cur.seen.add(ball.striker);
          cur.seen.add(ball.nonStriker);
          dirty = true;
          break;
        }
        case "cricket.innings.summary":
        case "cricket.innings.close":
        case "cricket.innings.declare":
        case "cricket.followon":
          // Innings boundary: snapshot totals, then the explicit event closes
          // (or hands over) the innings in the fold.
          flush();
          cur = null;
          out.push({ type: event.type, payload: event.payload });
          break;
        case "cricket.retire": {
          // W4 — a retired-out is a wicket in the innings column; a retired
          // not out is not. Both batters go into `seen` either way, so the
          // innings-boundary heuristic above is not fooled by the swap.
          const retire = event.payload as z.infer<typeof CricketRetire>;
          cur ??= { runs: 0, wickets: 0, legalBalls: 0, boundaries: 0, seen: new Set() };
          if (retire.reason === "out") {
            cur.wickets += 1;
            dirty = true;
          }
          cur.seen.add(retire.person);
          if (retire.incoming !== undefined) cur.seen.add(retire.incoming);
          retiredSinceBall = true;
          break;
        }
        case "cricket.newball":
        case "cricket.powerplay":
        case "cricket.review":
          break; // W4 innings context — no effect on totals, dropped like a
        // player line; Tier 0 is the totals and nothing else.
        case "cricket.player.line":
          break; // Tier-2 attribution — dropped at coarse fidelity
        default:
          // revise / interruption / toss / match.close / superover.ball /
          // core.* — snapshot so the fold decides on the same totals, then
          // pass through. The innings may continue afterwards (revise).
          flush();
          out.push({ type: event.type, payload: event.payload });
      }
    }
    flush();
    return out;
  },
};

