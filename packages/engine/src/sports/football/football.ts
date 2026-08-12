// Football SportModule — spec 04 §1 + engine/sports/football.md (PROMPT-04).
// Timed periods, draws league-only, ET/shootout sub-machines, FIFA fair play,
// two official tiebreaker presets (fifa2026 H2H-first / classic GD-first).
import { z } from "zod";
import { EngineError } from "../../core/errors.ts";
import {
  isStrictFold,
  resolveVoids,
  type CoreEv,
  type EventEnvelope,
  type FoldContext,
} from "../../core/events.ts";
import type { Rng } from "../../core/rng.ts";
import { GameTime, addDuration, compareGameTime, gameTimeOf } from "../../core/time.ts";
import { periodClockPosition, type MatchPosition } from "../../core/position.ts";
// S3/W4b (#426) — the ONE squad model. Football re-derived all three of these
// privately before this wave (`squadFromLineup` dropped `positionKey` one line
// after reading it; `maxSubs` had a single reader; "may he come back" was
// spelled `bench.includes(on)`), and a second implementation of a Law is how
// the placer/verifier divergence keeps happening here.
import {
  REPLAY_LINEUP_POLICY,
  initSquads,
  isLineupEventType,
  onFieldPersons,
  personsAtPosition,
  playingSquad,
  reduceLineupEvent,
  type LineupPolicy,
  type SideSquad,
  type SquadMember,
  type SquadState as KernelSquads,
} from "../../core/lineup.ts";
import {
  AttemptOutcome,
  EntrantId,
  type DisciplineCard,
  type LineupPair,
  type MatchOutcome,
  type ScoreSummary,
  type StageCtx,
  type StageKind,
  type StandingsDelta,
} from "../../core/types.ts";
import type { PositionCatalog } from "../../sport/catalog.ts";
import type {
  ModuleEvent,
  PadAction,
  PadAttributionItem,
  PadField,
  PadGate,
  PadPanel,
  PadSpec,
  SportModule,
  TiebreakerKey,
} from "../../sport/module.ts";
import { expectedKicker, shootoutDecision } from "../period/shootout.ts";
import type { PlayerStatRow, PlayerStatsFoldCtx } from "../../stats/stats.ts";

// ---------------------------------------------------------------------------
// Cfg — spec 04 §1.1
// ---------------------------------------------------------------------------

export const FootballCfg = z.object({
  // S5/#431 — the length of ONE PLAY PERIOD: normally a half, but at
  // `halves: 4` (mini-soccer quarters) this is the length of a QUARTER
  // instead. One scalar names the concept regardless of how many periods
  // divide the match; the name is a historical artifact of the shape this
  // config started at, not a claim that only halves exist. See `halves`
  // below for the period-count switch itself, and `phaseLengths` for where
  // this is read.
  halfMinutes: z.number().int().positive().default(45),
  // W4a (#425) §3.2, as amended 2026-08-04 — the OVERRIDE the unserved-remainder
  // carry reads, and only for what the required scalars cannot express.
  //
  // `halfMinutes` is required and fixes BOTH halves; `extraTime.halfMinutes`
  // fixes both extra-time halves. Those are where the carry gets its lengths,
  // which is why this wave needed no new required config at all. What a single
  // scalar per group cannot say is that the two halves of a group are of
  // UNEQUAL length, and that is the entire remaining job of this map.
  //
  // A map giving every half in a group the SAME value therefore states nothing
  // the scalar does not — duplicated authority, not a refinement — so where the
  // two disagree the required scalar WINS and the uniform map is IGNORED.
  //
  // Ignored rather than refused, deliberately: cfg is read live from
  // `division.config` on every fold, a correct length is always in hand, and a
  // CONFIG_INVALID raised on the replay path would let one later admin edit make
  // every already-scored fixture in the division permanently unviewable.
  //
  // Optional with NO default — a defaulted key lands in the cfg serialised into
  // every frozen golden state string.
  periodSeconds: z.record(z.string().min(1), z.number().int().positive()).optional(),
  // S5/#431 — the play-period SHAPE: 2 (spec 04 §1.3's two halves, the
  // default) or 4 (mini-soccer quarters, FA U7-U10, the `mini-soccer`
  // preset). Config-as-data, same as before this wave, now with a second
  // valid value instead of only one. Q1 is `H1` REUSED, never renamed — see
  // `PlayPhase`'s own comment — so `applyPeriod` reads this to decide which
  // marker vocabulary and which destinations are legal from state.phase
  // "H1", not to pick a different opening phase.
  halves: z.union([z.literal(2), z.literal(4)]).default(2),
  extraTime: z
    .object({
      enabled: z.boolean(),
      halfMinutes: z.number().int().positive(),
    })
    .default({ enabled: false, halfMinutes: 15 }), // knockout only
  shootout: z.boolean().default(false), // knockout only
  points: z
    .object({
      win: z.number().int().nonnegative().default(3),
      draw: z.number().int().nonnegative().default(1),
      loss: z.number().int().nonnegative().default(0),
      // spec 04 §1.4 — optional split for group-stage shootouts
      // (youth-cup convention: SO win 2, SO loss 1).
      shootoutWin: z.number().int().nonnegative().optional(),
      shootoutLoss: z.number().int().nonnegative().optional(),
    })
    .default({ win: 3, draw: 1, loss: 0 }),
  awardScore: z.object({ goals: z.number().int().positive() }).default({ goals: 3 }),
  fairPlay: z.boolean().default(true), // track cards for FIFA fair-play TB
  // W4 (Law 3) — return ("rolling"/"flying") substitutions. 11-a-side under the
  // Laws forbids a substituted player from returning; FA youth football and
  // every small-sided/futsal code permits repeat substitutions. Optional with
  // no default: absent ≡ the pre-W4 behaviour (returns forbidden).
  rollingSubs: z.boolean().optional(),
  // W4 (Law 3) — competition cap on substitutions per side (5 in senior
  // 11-a-side since 2020; unlimited under rollingSubs). Absent = uncapped,
  // which is what every stream recorded before W4 assumed.
  maxSubs: z.number().int().nonnegative().optional(),
  // S3/W4b (#426), IFAB concussion-substitute trial — how many ADDITIONAL
  // permanent substitutions this competition allows for a suspected
  // concussion, held OUTSIDE `maxSubs`.
  //
  // A cfg knob and not a constant, because the trial is adopted per
  // competition: the Premier League runs two, most grassroots competitions run
  // none, and a module that hard-coded either would have answered for the wrong
  // one. Absent = the trial is not in force here, and the kernel then refuses a
  // `core.lineup.replacement` naming it (`exemption-not-declared`) rather than
  // letting any pad evade the cap by inventing an exemption key.
  //
  // Optional with NO default, like every other knob this wave: `state.cfg` is
  // serialised inside every recorded state, so a default would appear in all
  // eleven frozen football streams.
  concussionSubs: z.number().int().nonnegative().optional(),
  // W4 (Law 12 addendum, temporary dismissals) — the competition's sin-bin
  // period in minutes, used when a `football.sinbin.start` event omits its own.
  // The FA runs 10 minutes in 90-minute football and reduces it pro rata for
  // shorter formats, so this is a competition setting, not a Law constant.
  sinBinMinutes: z.number().int().positive().optional(),
  // W4 (Law 3 §1, "a match is played by two teams, each of not more than
  // eleven players") — the number of players a side fields. The Laws set 11 for
  // the senior game; FA Mini-Soccer and the small-sided/futsal codes run 5, 7
  // or 9 a side, and a competition may lower the minimum. Drives the resolved
  // PositionCatalog (`positionsFor`) rather than the fold: positions are lineup
  // data and never touch scoring math. Optional with no default — absent ≡ 11,
  // which is what every stream recorded before W4 assumed.
  teamSize: z.number().int().min(2).max(11).optional(),
  // W4a (#425) §5.2 (Law 3) — the competition's allowance of substitution
  // WINDOWS, which is a different bound from `maxSubs` and applies alongside it:
  // senior 11-a-side permits five substitutions taken in three windows, so a
  // side that uses all five one at a time has broken the Law while never
  // reaching the cap. A window is the set of substitutions sharing one `at` —
  // the stoppage, not the player. Optional with NO default: absent = unlimited
  // windows, which is what every stream recorded before this wave assumed, and
  // a default would land in the cfg serialised into every frozen golden state.
  subWindows: z.number().int().nonnegative().optional(),
  // engine/sports/football.md §8 — core.abandon policy: `replay` leaves the
  // fixture undecided (flagged for regeneration), `award` decides for the
  // current leader (level score ⇒ no_result).
  abandonPolicy: z.enum(["replay", "award"]).default("replay"),
});
export type FootballCfg = z.infer<typeof FootballCfg>;

// ---------------------------------------------------------------------------
// Ev — spec 04 §1.2
// ---------------------------------------------------------------------------

const PersonId = z.string().min(1);

// W4a (#425) §5.2 — `at` beside the deprecated `minute`, on every payload a
// scorer times.
//
// THE TWO ARE DIFFERENT UNITS, and that is the whole hazard: `minute` is
// MINUTES of the match as a match report prints them, `GameTime.elapsed` is
// SECONDS counted up from the start of the named period. `minute: 90` and
// `at: { period: "H2", elapsed: 90 }` are three quarters of a match apart.
// Nothing in this file converts between them — `core/time.ts`'s `parseElapsed`
// deliberately refuses a bare number for exactly this reason, because football's
// legacy field is literally called `minute` and a pad wiring a minute box to a
// seconds helper records 1:30 as 90:00.
//
// WHERE BOTH ARE PRESENT, `at` WINS. It is the only one the fold derives
// anything from (sin-bin expiry, §3.1; substitution windows, §5.2); `minute` is
// kept verbatim as the display integer the scorer wrote and is never read by
// the fold, never converted, and never overwritten. Two disagreeing values are
// a question for the match report, not for the reducer.
//
// `minute` is NOT removed: removing it would break every frozen golden and the
// additive-only tripwire that proves this wave is additive. It stays,
// deprecated in comment, exactly as the period kernel keeps `clockRef`.
//
// Every `at` below is the `GameTime` schema VERBATIM (§8), never a hand-rolled
// `z.object({ period, elapsed })` that looks like it. The kernel is fail-OPEN on
// a malformed stamp — `gameTimeOf` safe-parses, so `{ period: "H1", elapsed: -1 }`
// reads as UNSTAMPED rather than being rejected — which makes the payload's own
// schema the only thing between a corrupt stamp and the ledger. Only the real
// `GameTime` carries all four guards: non-negative, integer, non-empty period
// label, and strict.

export const FootballGoal = z.strictObject({
  by: EntrantId, // ownGoal: the side whose player struck it (credits opponent)
  scorer: PersonId.optional(),
  assist: PersonId.optional(), // Jul3/07 §3 — optional everywhere (own goals etc.)
  /** @deprecated W4a §5.2 — MINUTES, display only. Prefer `at` (seconds). */
  minute: z.number().int().nonnegative().optional(), // optional everywhere: coarse scoring
  ownGoal: z.boolean().optional(),
  penalty: z.boolean().optional(), // in-play penalty kick, not a shootout kick
  at: GameTime.optional(), // W4a §5.2 — elapsed-at-event; sweeps expired sin bins
});
export const CardColor = z.enum(["yellow", "red", "second_yellow"]);
// W4 (Law 12 §3 cautions, §4 sending-off offences) — the offence category a
// referee's match record names next to the card. The discipline usecase's
// suspension tariff is a function of THIS, not of the colour: violent conduct
// and a second caution are both red cards and carry different bans.
export const CardReason = z.enum([
  // Law 12.3 — cautionable offences.
  "unsporting_behaviour",
  "dissent",
  "persistent_offences",
  "delaying_restart",
  "failure_to_respect_distance",
  "entering_or_leaving_without_permission",
  // Law 12.4 — sending-off offences.
  "serious_foul_play",
  "violent_conduct",
  "spitting",
  "denying_goal_by_handball",
  "denying_obvious_goalscoring_opportunity",
  "offensive_language",
  "second_caution",
]);
export const FootballCard = z.strictObject({
  by: EntrantId,
  person: PersonId.optional(),
  color: CardColor,
  /** @deprecated W4a §5.2 — MINUTES, display only. Prefer `at` (seconds). */
  minute: z.number().int().nonnegative().optional(),
  reason: CardReason.optional(), // W4 — optional everywhere: coarse scoring
  at: GameTime.optional(), // W4a §5.2 — retained on State.cards[].at
});
export const FootballSub = z.strictObject({
  by: EntrantId,
  off: PersonId,
  on: PersonId,
  /** @deprecated W4a §5.2 — MINUTES, display only. Prefer `at` (seconds). */
  minute: z.number().int().nonnegative().optional(),
  // W4a §5.2 — the stamp that identifies the substitution WINDOW. Substitutions
  // sharing one `at` are one window (`Cfg.subWindows`); an UNSTAMPED
  // substitution is in no window and consumes none.
  at: GameTime.optional(),
});
export const FootballPeriod = z.strictObject({
  // S5/#431 — "QT" (quarter-time, Q1 -> Q2) and "3QT" (three-quarter-time,
  // Q3 -> Q4) are the two markers `halves: 4` (mini-soccer) needs beyond the
  // halves vocabulary: the Q2 -> Q3 boundary is the real half-time interval
  // and reuses "HT"; the Q4 -> done/ET/shootout boundary is the real final
  // whistle and reuses "FT". `applyPeriod` gates every arm on `cfg.halves`,
  // not merely on state.phase, so sending a halves-mode marker from a
  // quarters-mode fixture (or vice versa) is refused rather than silently
  // reinterpreted — see `applyPeriod`'s own comment.
  phase: z.enum(["HT", "FT", "ET_HT", "ET_FT", "QT", "3QT"]),
  // W4 (Law 7 §3, allowance for time lost) — minutes added to the period this
  // marker CLOSES. A match report writes "90+3"; a bare integer `minute`
  // cannot tell that apart from the 93rd minute of extra time.
  addedMinutes: z.number().int().nonnegative().optional(),
  // W4a §5.2 — the whistle's own stamp. This marker IS the natural clock
  // reading of a football match ("45+2"), and it is the event that closes a
  // phase, so it is also the boundary sweep's trigger. Leaving it unstampable
  // meant the one event a scorer always times could not carry a time.
  at: GameTime.optional(),
});
export const FootballShootoutKick = z.strictObject({
  by: EntrantId,
  person: PersonId.optional(),
  scored: z.boolean(),
  // W4a §5.2 — `playPhases` lists SHOOTOUT, so a card shown during the kicks
  // was already stampable while no shoot-out payload could carry a stamp:
  // `State.asOf` froze at the last stamped card for the whole decider, and a
  // consumer reading "as of when is this true" got an instant from before the
  // shoot-out began.
  at: GameTime.optional(),
});

// W4 (Law 14) — a penalty kick awarded IN OPEN PLAY that did not produce a
// goal. A converted penalty stays `football.goal { penalty: true }` so no
// pre-W4 stream changes meaning; this branch exists purely for the kicks a
// scorebook otherwise loses. `outcome` is required, which is also what keeps
// the branch structurally distinct inside the union.
//
// W4 review item 2 — the tokens are the SHARED attempt vocabulary minus
// `scored`, derived rather than re-typed so the two can never drift apart. A
// scored penalty is the goal event, and accepting it here would let one kick
// be counted twice.
export const PenaltyOutcome = AttemptOutcome.exclude(["scored"]);
// S4 (#428) — IFAB Law 12 §3: the direct-free-kick offence that CONCEDED the
// penalty (theifab.com Law 12, checked this session). Short and closed —
// unlike `CardReason` (Law 12.3/12.4 cautionable/sending-off offences), this
// answers a DIFFERENT question: not every penalty carries a card at all, and
// a card's reason can diverge from the offence that gave the kick away (a
// penalty for handball plus a separate caution for dissent). Named distinctly
// from `CardReason` on purpose — conflating the two fields would make one
// enum answer two questions.
export const PenaltyOffence = z.enum([
  "kicking",
  "tripping",
  "jumping_at",
  "charging",
  "pushing",
  "striking",
  "tackling",
  "handball",
]);
export type PenaltyOffence = z.infer<typeof PenaltyOffence>;
export const FootballPenalty = z.strictObject({
  by: EntrantId, // the side awarded the kick
  taker: PersonId.optional(),
  // W4 review item 1 — the DEFENDING keeper who faced it. `goalkeeper` is the
  // shared name: the period kernel's shoot-out attempt and set piece already
  // used it, and it matches the position groups the catalogs declare (FIH
  // "GK", IIHF "G"). One fact, one key, one pad control.
  goalkeeper: PersonId.optional(),
  outcome: PenaltyOutcome,
  // S4 (#428) — optional everywhere: coarse scoring records a kick and
  // nothing else, exactly like FootballCard.reason.
  offence: PenaltyOffence.optional(),
  /** @deprecated W4a §5.2 — MINUTES, display only. Prefer `at` (seconds). */
  minute: z.number().int().nonnegative().optional(),
  // W4a §5.2 — a `strictObject` with no `at` does not merely LACK the field, it
  // rejects the key: a stamped penalty was unrecordable, could never advance the
  // monotonic guard's high-water mark (so a card recorded before it was
  // accepted), and `PenaltyRecord` kept only the display `minute`.
  at: GameTime.optional(),
});

// W4 (Law 12 addendum) — a temporary dismissal ("sin bin"). The FA operates
// them below the National League System and across youth football; futsal and
// most small-sided codes use a time penalty of the same shape. No existing
// branch could express it: football.card's non-yellow path removes a player
// permanently.
//
// W4 review item 3 — the dismissal and the return are TWO events, which is the
// shape the period kernel already ships (`*.suspension.start` / `.end`). A
// sin bin genuinely IS two scorer moments minutes apart, and folding them into
// one branch behind a `returned: boolean` gave the pad one control with a
// hidden mode. The sanction LADDER stays football's own (`sin_bin`,
// `cfg.sinBinMinutes`); only the shape is shared.
export const FootballSinBinStart = z.strictObject({
  by: EntrantId,
  person: PersonId.optional(),
  minutes: z.number().int().positive().optional(), // defaults to cfg.sinBinMinutes
  /** @deprecated W4a §5.2 — MINUTES, display only. Prefer `at` (seconds). */
  minute: z.number().int().nonnegative().optional(),
  reason: CardReason.optional(),
  // W4a §5.2 — with a length (payload `minutes`, else `Cfg.sinBinMinutes`) this
  // turns the dismissal into a TIMED suspension: the fold derives `expiresAt`
  // and sweeps it at the next stamped event (§3.1). Without it — or without a
  // length — the bin ends only on an explicit `football.sinbin.end`, exactly as
  // it did before this wave.
  at: GameTime.optional(),
});
export const FootballSinBinEnd = z.strictObject({
  by: EntrantId,
  person: PersonId.optional(), // absent = the oldest anonymous dismissal
  /** @deprecated W4a §5.2 — MINUTES, display only. Prefer `at` (seconds). */
  minute: z.number().int().nonnegative().optional(),
  at: GameTime.optional(), // W4a §5.2 — the return's own stamp
});

// S8/#417 W6 — a shot with its own outcome: the shape that yields BOTH shots
// on goal (S2/#430's parked row) and, crucially, the DENOMINATOR for save
// percentage (the same row's "absent" complaint) — a bare save counter would
// repeat the silent-0/no-denominator defect this programme has now hit four
// times (`metricOf`, `PeriodSetPiece.outcome`, plus/minus, powerplay
// conversion). A save IS a shot whose outcome is "saved".
//
// Its own enum, not `PenaltyOutcome`/`AttemptOutcome` (both used just above):
// "blocked" — stopped by an outfield defender before it ever reached the
// keeper — is a real, common open-play outcome neither of those carries
// (tuned for a penalty/set-piece ATTEMPT, where by Law only the keeper may
// intervene). Widening the shared `AttemptOutcome` (`core/types.ts`) was
// considered and rejected: that file is outside this session's owned files,
// and it would have leaked "blocked" into `PenaltyOutcome`'s own pad enum as
// a choice no penalty kick can Law-fully produce. "scored" is kept (not the
// brief's illustrative "goal") for the same reason `PenaltyOutcome` already
// reads that way — one vocabulary for "did the attempt end in a goal" in
// this file, not two.
export const ShotOutcome = z.enum(["scored", "saved", "missed", "blocked"]);
export type ShotOutcome = z.infer<typeof ShotOutcome>;

// S8/#417 W6 — `by` is the SHOOTING side, `taker` the shooter (matches
// `FootballPenalty.taker`'s own naming for the same "who took this attempt on
// goal" role), `goalkeeper` the DEFENDING side's keeper — EXPLICIT override,
// wins over the spell-derived on-ice keeper `footballKeeperStatsFold` would
// otherwise credit when both are known, mirroring S8's own person-
// attribution resolution order. No `minute`: unlike every payload above,
// this type never existed before `at` did, so there is no legacy display
// integer to carry.
export const FootballShot = z.strictObject({
  by: EntrantId,
  taker: PersonId.optional(),
  goalkeeper: PersonId.optional(),
  outcome: ShotOutcome,
  at: GameTime.optional(),
});

export const FootballEv = z.union([
  FootballGoal,
  FootballCard,
  FootballSub,
  FootballPeriod,
  FootballShootoutKick,
  FootballPenalty,
  FootballSinBinStart,
  FootballSinBinEnd,
  FootballShot,
]);
export type FootballEv = z.infer<typeof FootballEv>;

// S6/#416 (W5) — event type -> its own payload schema, the SAME schema OBJECT
// REFERENCES already used as FootballEv's union members and in applyEvent's
// dispatch switch below, now also keyed by type string in one place.
// `testkit/conformance-pad.ts` asserts this is a bijection onto FootballEv's
// 8 branches, by reference. Unlike cricket's registry, no two type strings
// share one schema object here — every branch has exactly one envelope type.
export const FOOTBALL_EVENT_SCHEMAS: Readonly<Record<string, z.ZodTypeAny>> = {
  "football.goal": FootballGoal,
  "football.card": FootballCard,
  "football.sub": FootballSub,
  "football.period": FootballPeriod,
  "football.shootout.kick": FootballShootoutKick,
  "football.penalty": FootballPenalty,
  "football.sinbin.start": FootballSinBinStart,
  "football.sinbin.end": FootballSinBinEnd,
  "football.shot": FootballShot,
};

// ---------------------------------------------------------------------------
// State — spec 04 §1.3
// ---------------------------------------------------------------------------

type Side = "home" | "away";
// S5/#431 — "Q2" | "Q3" | "Q4" are mini-soccer's quarters (`cfg.halves ===
// 4`). Quarter 1 is deliberately NOT "Q1": it reuses "H1", the same literal
// halves mode opens on, so `core.start` (always `pushPeriod(state, "H1")`)
// needs no change and no cfg branch of its own.
type PlayPhase = "H1" | "H2" | "Q2" | "Q3" | "Q4" | "ET_H1" | "ET_H2";
type Phase = "pre" | PlayPhase | "SHOOTOUT" | "done" | "final" | "abandoned";

// W4 — a live temporary dismissal. Anonymous entries (coarse scoring) are
// recorded but never move the pitch, the same discipline anonymous cards get.
interface SinBinRecord {
  person?: string;
  minutes?: number;
  reason?: z.infer<typeof CardReason>;
  minute?: number;
  // W4a (#425) §3.1 — present only when the dismissal was stamped. `expiresAt`
  // additionally needs a length, so a stamped bin in a competition that has
  // declared none carries `startedAt` alone and still ends only on an explicit
  // return. Both absent until something populates them, so a pre-W4a stream
  // serialises byte-identically.
  startedAt?: GameTime;
  expiresAt?: GameTime;
}

/**
 * Football's PROJECTION of the kernel squad — never a second squad model.
 *
 * S3/W4b (#426): `core/lineup.ts` owns membership, positions, the substitution
 * count and re-entry for all eleven sports. What survives here is the football
 * half the kernel deliberately does not model — a sending-off, a temporary
 * dismissal, and the Law 3 substitution WINDOW — plus the flattened person-id
 * lists that every frozen football stream has serialised since W4 and that this
 * wave is not allowed to reshape (`state.squads` is inside the recorded state,
 * compared byte for byte).
 *
 * Renamed off `SquadState` on purpose: the kernel's type has that name, and one
 * concept must not answer to two of them in one package.
 */
interface FootballSquad {
  onPitch: string[];
  bench: string[];
  offUsed: string[]; // substituted off — may not return
  sentOff: string[]; // red / second yellow — may not return or be subbed for
  // W4 — currently serving a temporary dismissal. Absent until the first sin
  // bin of the match, so `init` serialises exactly as it did before W4.
  sinBin?: SinBinRecord[];
  // W4a (#425) §5.2 — the DISTINCT stamps at which this side has substituted,
  // in order. One entry per window, however many players went on at it. Absent
  // until the first STAMPED substitution: an unstamped one is in no window and
  // must add nothing, or every stream recorded before this wave grows a field.
  subWindows?: GameTime[];
  // W4a (#425) review — every TIMED dismissal this side has been shown, kept
  // whether or not it is still being served. The scoresheet row prints both
  // stamps, and this is the ONLY record left once the sweep removes the entry
  // from `sinBin` — which is exactly when the question "had this bin in fact run
  // out by the stamp on that release?" first arises (`alreadyRunOut`). The
  // period kernel's `cardLog` is the same idea; football simply had none.
  //
  // TIMED ONLY, and that gate is what keeps the frozen goldens byte-identical:
  // an unstamped bin, or one in a competition that declared no length, derives
  // no expiry, is never logged here, and the key stays absent — matching the
  // `sinBin` / `penalties` precedent.
  sinBinLog?: SinBinRecord[];
  // S3/W4b (#426) — replacements this side has taken OUTSIDE `Cfg.maxSubs`, per
  // exemption key (`{concussion: 1}`), mirrored from `SideSquad.exemptUsed`.
  //
  // It has to be carried rather than derived, and that is the whole point of
  // the row: an exempt replacement still puts its outgoing player in `offUsed`
  // (a concussion replacement is permanent, so he may not return), and the cap
  // is counted from `offUsed.length` — so without this the exemption would
  // silently consume the ordinary allowance one event later and the cap and the
  // exemption would never actually disagree.
  //
  // Absent until the first exempt replacement, so every frozen stream
  // serialises exactly as it did.
  exemptUsed?: Readonly<Record<string, number>>;
  // S4 (#428) review round 1, finding 1 — squad members `initialFootballSquad`
  // deliberately excludes from `onPitch`/`bench` (`playingSquad` is
  // players-only, correctly, for ON-PITCH tracking): a coach or other team
  // official. S3/#426 ruling 3 put them ON the team sheet specifically so
  // they CAN be shown a card (`core/types.ts`'s `LineupSlot.role` doc
  // comment), but `applyCard`'s "in the lineup" check reads only this
  // struct, so before this field existed a card addressed to a non-player
  // was unconditionally `INVALID_EVENT` — not merely miscounted in stats,
  // unrecordable. STATIC: football's `lineupPolicy` sets
  // `allowSquadGrowth: false`, so nobody — player or not — joins mid-fixture;
  // this list is fixed at `init` and never touched by a substitution or
  // lineup-change fold. Absent when empty, so a fixture with no non-player
  // squad member serialises exactly as it did before this field existed.
  nonPlayers?: readonly string[];
}

interface CardRecord {
  side: Side;
  person?: string;
  color: z.infer<typeof CardColor>;
  minute?: number;
  reason?: z.infer<typeof CardReason>; // W4 — Law 12 offence category
  at?: GameTime; // W4a §5.2 — the stamp, when the pad recorded one
}

// W4 — a period entry gains Law 7 added time. Optional so that every stream
// recorded before W4 serialises byte-identically.
interface PeriodRecord {
  phase: PlayPhase;
  home: number;
  away: number;
  addedMinutes?: number;
}

export interface FootballState {
  cfg: FootballCfg;
  entrants: { home: string; away: string };
  phase: Phase;
  goals: { home: number; away: number }; // regulation + ET (shootout excluded)
  // Per-period breakdown, in play order — the coarse "period summaries" view
  // (PROMPT-04 §9) and the summary.detail payload.
  periods: PeriodRecord[];
  cards: CardRecord[];
  squads: { home: FootballSquad; away: FootballSquad };
  shootout: { kicks: { side: Side; scored: boolean }[] } | null;
  outcome: MatchOutcome | null;
  replayFlagged: boolean; // abandonPolicy 'replay' — fixture to regenerate
  // W4 (Law 14) — unconverted open-play penalties, in play order. Absent until
  // the first one is recorded: `init` must keep serialising exactly as it did
  // before W4 or every frozen golden stream reds.
  penalties?: PenaltyRecord[];
  // S8/#417 W6 — every recorded shot, in play order. Absent until the first
  // one, matching the `penalties`/`goalLog` precedent so a pre-this-wave
  // state serialises byte-identically. Score-neutral by construction —
  // `applyShot` never touches `goals`/`periods` — and therefore, like
  // `penalties`, deliberately EXCLUDED from `summary.detail`: `coarsen`
  // drops it (no score effect), and §9.6 requires the two to match.
  shots?: ShotRecord[];
  /**
   * W4a (#425) §6 obligation 3 — AS OF WHEN everything above is true. Absent
   * until the first stamped event, matching the `penalties` / `sinBin`
   * precedent, so a pre-wave state serialises exactly as it did.
   *
   * It exists because lazy expiry (§3.1) means the pad and the fold
   * legitimately disagree between an expiry and the next event: a pad drawing a
   * strength chip needs to say what instant that chip is true as of, or a
   * scorer reads the stale chip as a bug. Without it, §6 obligation 3 was
   * unimplementable for football and W5's ONE universal renderer would have met
   * two different state shapes across the eleven sports.
   */
  asOf?: GameTime;
}

interface PenaltyRecord {
  side: Side;
  outcome: z.infer<typeof PenaltyOutcome>;
  taker?: string;
  goalkeeper?: string;
  minute?: number;
  at?: GameTime; // W4a §5.2 — the stamp, when the pad recorded one
  // S4 (#428) — the Law 12 offence that conceded the kick, when recorded.
  offence?: PenaltyOffence;
}

// S8/#417 W6 — one recorded shot, State's raw log (mirrors `PenaltyRecord`
// immediately above).
interface ShotRecord {
  side: Side;
  outcome: ShotOutcome;
  taker?: string;
  goalkeeper?: string;
  at?: GameTime;
}

// S5/#431 — a STATIC allowlist, not cfg-derived: it gates "currently in
// play" for goal/card/sub/penalty/sin-bin events structurally, the same way
// regardless of which mode a fixture runs under. A halves-mode fixture never
// reaches "Q2"/"Q3"/"Q4" (applyPeriod refuses the markers that would produce
// them under `cfg.halves === 2`), so widening this unconditionally costs
// nothing and matches how ET_H1/ET_H2 were already handled before this wave.
const PLAY_PHASES: readonly Phase[] = ["H1", "H2", "Q2", "Q3", "Q4", "ET_H1", "ET_H2"];

function opponent(side: Side): Side {
  return side === "home" ? "away" : "home";
}

function invalid(message: string, data?: unknown): never {
  throw new EngineError("INVALID_EVENT", message, data);
}

function wrongPhase(message: string, data?: unknown): never {
  throw new EngineError("WRONG_PHASE", message, data);
}

function sideOf(state: FootballState, entrantId: string): Side {
  if (entrantId === state.entrants.home) return "home";
  if (entrantId === state.entrants.away) return "away";
  invalid(`unknown entrant "${entrantId}"`, { entrantId });
}

function parsePayload<T>(schema: z.ZodType<T>, payload: unknown, type: string): T {
  const parsed = schema.safeParse(payload);
  if (!parsed.success) {
    invalid(`invalid ${type} payload`, { issues: parsed.error.issues });
  }
  return parsed.data;
}

function isPlayPhase(phase: Phase): phase is PlayPhase {
  return PLAY_PHASES.includes(phase);
}

/**
 * THE phase order for this cfg — W4a (#425) §7. Every phase in which a STAMPED
 * event may legally occur, in the order they occur, and nothing else.
 *
 * One function, two consumers, by contract: the fold kernel's monotonic guard
 * reads it via `SportModule.playPhases`, and every `compareGameTime` call this
 * module makes inside `apply()` passes this same function's result. Two lists
 * that merely agree today is the defect this exists to prevent — an event the
 * guard accepts is backwards one layer down, and the lazy sin-bin sweep (§3.1)
 * runs against an order nothing agrees on. `football.time.test.ts` asserts the
 * module holds this exact function reference, so a copy fails there.
 *
 * WIDER than `PLAY_PHASES`, and that is the point:
 *  - "pre" — a card before the opening whistle is legal (`applyCard`, and
 *    football.md §9 names a pre-kickoff red explicitly), so a stamped one has
 *    to be orderable.
 *  - "SHOOTOUT" — cards are legal there too, and it sorts LAST, after any extra
 *    time, because that is when it happens.
 *  - "done" / "final" / "abandoned" are excluded: nothing stamped is accepted
 *    once the match is over.
 *
 * ET and the shootout are listed only when this cfg can actually REACH them —
 * `resolveFullTime` enters `ET_H1` only under `cfg.extraTime.enabled` and
 * `SHOOTOUT` only under `cfg.shootout` — so a scorer stamping `ET_H1` in a
 * league fixture gets a fixable INVALID_EVENT naming the phases this sport has.
 *
 * Exhaustive by OBLIGATION, not by construction: the fold treats a period
 * outside this list as a bad payload field, so anything omitted here is an event
 * the scorer cannot record.
 *
 * S5/#431 — `cfg.halves === 4` swaps the two-item halves list for the
 * four-item quarters list; everything after it (ET, SHOOTOUT) is unchanged,
 * because those are gated on `cfg.extraTime`/`cfg.shootout`, not on halves.
 */
export function playPhases(cfg: FootballCfg): string[] {
  return [
    "pre",
    ...(cfg.halves === 4 ? ["H1", "Q2", "Q3", "Q4"] : ["H1", "H2"]),
    ...(cfg.extraTime.enabled ? ["ET_H1", "ET_H2"] : []),
    ...(cfg.shootout ? ["SHOOTOUT"] : []),
  ];
}

/**
 * The phases in which the MATCH CLOCK runs, in play order — where penalty time
 * can be served. Deliberately NOT `playPhases`: "pre" and "SHOOTOUT" are phases
 * of the match without being phases of play, and the carry must never spill
 * into a shoot-out, where there is no match clock at all.
 *
 * Listed only where this cfg can reach them, so a league fixture's carry stops
 * at the end of the second half rather than rolling into an extra time the
 * competition does not play.
 */
/**
 * W4a (#425) T6b — "H2 · 48:12", the cross-sport position axis.
 *
 * DELEGATES to `periodClockPosition`, the same core function the period kernel
 * uses. Football and the period kernel have different state types and so cannot
 * share a module member the way hockey and ice hockey do, and this wave has
 * already paid for that gap once: football hand-rolled the period kernel's time
 * model and diverged from it in five places. The shared derivation is the fix
 * available here, and `position.conformance.test.ts` holds both to producing an
 * identical SHAPE for the same instant, because W8 draws one chip for all four
 * period sports.
 *
 * `PLAY_PHASES` is deliberately not consulted: `playPhases` is the wider list
 * the fold's monotonic guard orders against, and it is the one an event's
 * `at.period` is validated against, so it is the one a position must rank in.
 */
function footballPosition(state: FootballState): MatchPosition {
  return periodClockPosition({
    phaseOrder: playPhases(state.cfg),
    evidence: [
      state.phase,
      state.asOf?.period,
      state.periods[state.periods.length - 1]?.phase,
      state.shootout === null ? undefined : "SHOOTOUT",
    ],
    asOf: state.asOf,
  });
}

// S5/#431 — quarters-aware, same shape as `playPhases`: `cfg.halves === 4`
// swaps in the four-item quarters list.
function clockPhases(cfg: FootballCfg): string[] {
  return [
    ...(cfg.halves === 4 ? ["H1", "Q2", "Q3", "Q4"] : ["H1", "H2"]),
    ...(cfg.extraTime.enabled ? ["ET_H1", "ET_H2"] : []),
  ];
}

/**
 * The nominal length of every clock phase, in seconds — the one authority the
 * carry counts against (§3.2, amended).
 *
 * It comes from the cfg's own REQUIRED scalars: `halfMinutes` fixes both halves
 * and `extraTime.halfMinutes` both extra-time halves. That is what removed the
 * old "the engine holds no period length, so the bin is under-served across the
 * whistle" limitation — it was never a missing FACT, only a field nobody wired.
 *
 * `cfg.periodSeconds` survives as an override for the ONE thing those scalars
 * cannot express: halves of UNEQUAL length. A map giving both halves of a group
 * the SAME value states nothing the scalar does not, so where the two disagree
 * the required scalar wins and the uniform map is IGNORED — never refused. See
 * the schema comment for why refusing would be the dangerous direction.
 *
 * S5/#431 — at `cfg.halves === 4` this fills all FOUR quarters from the same
 * `halfMinutes` scalar (its doc-comment states the generalised meaning: the
 * length of one play period, not literally "half"), instead of the two
 * halves. `cfg.periodSeconds` overrides individual quarters exactly as it
 * does individual halves — nothing else about the override changes.
 */
function phaseLengths(cfg: FootballCfg): Record<string, number> {
  const overrides = cfg.periodSeconds;
  const lengths: Record<string, number> = {};
  const fill = (labels: readonly string[], scalarSeconds: number): void => {
    const supplied = labels.map((label) => overrides?.[label]);
    const uniform =
      labels.length > 0 && supplied.every((value) => value !== undefined && value === supplied[0]);
    labels.forEach((label, i) => {
      const override = supplied[i];
      lengths[label] = uniform || override === undefined ? scalarSeconds : override;
    });
  };
  if (cfg.halves === 4) fill(["H1", "Q2", "Q3", "Q4"], cfg.halfMinutes * 60);
  else fill(["H1", "H2"], cfg.halfMinutes * 60);
  if (cfg.extraTime.enabled) fill(["ET_H1", "ET_H2"], cfg.extraTime.halfMinutes * 60);
  return lengths;
}

/**
 * W4a (#425) §3.1 — when a dismissal stamped at `startedAt` runs out.
 *
 * THE UNSERVED REMAINDER CARRIES (§3.2, amended 2026-08-04). This file used to
 * say the opposite, and both halves of that reasoning were wrong: IFAB's
 * temporary-dismissal protocol carries the remainder of a sin bin into the next
 * half exactly as IIHF carries a penalty, and the half length was never
 * missing — `Cfg.halfMinutes` is a required positive integer.
 *
 * Leaving the expiry in-period is not a harmless approximation, it is ACTIVELY
 * wrong under lazy expiry: `{H1, 3200}` sorts before every H2 stamp, so the
 * first stamped event of the second half sweeps a bin that still has 500
 * seconds to run — under-serving the player, silently, in the offending side's
 * favour. `addDuration` itself is unchanged: it is a primitive over one period
 * and never rolls forward; the carry lives here, walking `clockPhases`.
 *
 * The nominal length is what cfg holds, so a half that actually ran 48 minutes
 * still carries against 45. Stated rather than hidden, and the same
 * approximation the period kernel makes.
 *
 * Returns `undefined` where no expiry can exist: no length was declared at all
 * (payload `minutes`, else `Cfg.sinBinMinutes`), which leaves the bin ending
 * only on an explicit `football.sinbin.end`, exactly as before this wave.
 */
function expiryOf(
  cfg: FootballCfg,
  startedAt: GameTime,
  minutes: number | undefined,
): GameTime | undefined {
  if (minutes === undefined || !Number.isFinite(minutes) || minutes <= 0) return undefined;
  const play = clockPhases(cfg);
  // A stamp naming a phase with no match clock ("pre", "SHOOTOUT"). Unreachable
  // through `applySinBinStart`, which only admits a dismissal while play is
  // running, but it must not fall through to `undefined`: an expiry that does
  // not exist is a dismissal that runs to the end of the FIXTURE, so "no clock
  // here" would silently become "for the rest of the match" and the final state
  // would read a side short. With no clock to serve against it serves zero.
  if (!play.includes(startedAt.period)) return startedAt;
  const lengths = phaseLengths(cfg);
  let { period, elapsed } = addDuration(startedAt, minutes * 60);
  for (;;) {
    const length = lengths[period];
    if (length === undefined || elapsed <= length) return { period, elapsed };
    const index = play.indexOf(period);
    const next = index < 0 ? undefined : play[index + 1];
    // No more play to carry into — the named fallback (§3.2): the expiry stays
    // in-period, past the nominal length, and the bin ends on the explicit
    // release or at the final whistle.
    if (next === undefined) return { period, elapsed };
    elapsed -= length;
    period = next;
  }
}

/**
 * Release every dismissal `isOver` says has finished, returning each named
 * player to the pitch. The one place the three sweeps below share.
 *
 * An anonymous bin (coarse scoring) closes without returning anybody — it never
 * moved the pitch when it opened, which is the same discipline `applySinBinEnd`
 * and anonymous cards already get. Returns the SAME state object when nothing
 * moves, so a stream that expires nothing serialises byte-identically.
 */
function releaseBins(
  state: FootballState,
  isOver: (entry: SinBinRecord) => boolean,
): FootballState {
  let squads = state.squads;
  for (const side of ["home", "away"] as const) {
    const squad = squads[side];
    const bin = squad.sinBin;
    if (bin === undefined || bin.length === 0) continue;
    const over = bin.filter(isOver);
    if (over.length === 0) continue;
    const returning = over
      .map((entry) => entry.person)
      .filter((person): person is string => person !== undefined);
    squads = {
      ...squads,
      [side]: {
        ...squad,
        onPitch: [...squad.onPitch, ...returning],
        sinBin: bin.filter((entry) => !isOver(entry)),
      },
    };
  }
  return squads === state.squads ? state : { ...state, squads };
}

/**
 * W4a (#425) §3.1 — expiry is LAZY, swept at the next stamped event.
 *
 * The fold's state is only ever observed at event boundaries, so sweeping there
 * is sufficient; between events the pad renders the countdown from `expiresAt`
 * itself. The pad and the fold therefore DISAGREE in the window between an
 * expiry and the next stamped event. That is by design (§6 obligation 3 makes
 * showing the fold's `asOf` a pad requirement), not a bug.
 *
 * An UNSTAMPED event sweeps nothing: it carries no clock reading, so it cannot
 * be the moment the fold catches up. That is also what keeps every stream
 * recorded before this wave folding unchanged.
 *
 * NEVER THROWS `UNKNOWN_PHASE`, and that is a correctness requirement rather
 * than defensiveness: cfg is read LIVE from `division.config` at fold time, so
 * dropping extra time or renaming a phase AFTER a match was scored makes a
 * recorded phase label unrecognisable. A throwing sweep would make that fixture
 * permanently UNVIEWABLE, not merely stale. An unorderable phase reads as
 * "cannot be ordered, so does not expire" — the conservative direction: a bin
 * that outlives its time is visible and correctable, one silently erased is
 * neither.
 */
function sweepExpired(state: FootballState, now: GameTime): FootballState {
  const phases = playPhases(state.cfg);
  if (!phases.includes(now.period)) return state;
  return releaseBins(state, (entry) => {
    const expiresAt = entry.expiresAt;
    if (expiresAt === undefined) return false;
    if (!phases.includes(expiresAt.period)) return false;
    return compareGameTime(expiresAt, now, phases) <= 0;
  });
}

/**
 * THE WHISTLE SWEEPS TOO — a bin whose expiry falls inside the phase being left
 * is over, whether or not another stamped event ever arrived.
 *
 * Without this, a dismissal that ran out late in a half with nothing stamped
 * after it survives into the FINAL state and every consumer reads the side a
 * player short at full time. Ordered by phase INDEX rather than by
 * `compareGameTime`, because "the end of the first half" is not a stamp the
 * fold has: an expiry anywhere in a completed phase is in the past once that
 * phase closes, whatever its elapsed. Same unknown-phase tolerance as above.
 */
function sweepThroughPhase(state: FootballState, leaving: Phase): FootballState {
  const phases = playPhases(state.cfg);
  const closing = phases.indexOf(leaving);
  if (closing < 0) return state;
  return releaseBins(state, (entry) => {
    const expiresAt = entry.expiresAt;
    if (expiresAt === undefined) return false;
    const index = phases.indexOf(expiresAt.period);
    return index >= 0 && index <= closing;
  });
}

/**
 * THE MATCH IS OVER — every TIMED dismissal has run out, whatever phase its
 * expiry names.
 *
 * The phase sweep is not enough on its own, and the gap it leaves is exactly
 * the bug both sweeps exist to prevent: a bin opened at 40:00 of the second
 * half carries into ET_H1, and if the score is not level the full-time whistle
 * decides the match in regulation, extra time is never played, and an expiry
 * indexed PAST the closing phase survives into `done` — a side a player short
 * AT FULL TIME, in the state every summary and match report reads. One call
 * site therefore covers the full-time whistle, a shoot-out decision, a forfeit
 * and an awarded abandonment.
 *
 * TIMED only, and that is what keeps this additive: a bin with no derived
 * expiry was never given a duration to run out (unstamped, or a competition
 * that declared no sin-bin length), and it is RIGHT that it keeps the side
 * short to the final whistle. Every one of the frozen goldens is made entirely
 * of those, so none of them can be touched by this.
 */
function sweepEndOfMatch(state: FootballState): FootballState {
  return releaseBins(state, (entry) => entry.expiresAt !== undefined);
}

// ---------------------------------------------------------------------------
// Fold helpers
// ---------------------------------------------------------------------------

function pushPeriod(state: FootballState, phase: PlayPhase): FootballState {
  return { ...state, phase, periods: [...state.periods, { phase, home: 0, away: 0 }] };
}

function creditGoal(state: FootballState, credited: Side): FootballState {
  const periods = state.periods.map((period, i) =>
    i === state.periods.length - 1
      ? { ...period, [credited]: period[credited] + 1 }
      : period,
  );
  return {
    ...state,
    goals: { ...state.goals, [credited]: state.goals[credited] + 1 },
    periods,
  };
}

// Level-score resolution at FT / ET_FT — spec 04 §1.3: the knockout config
// (ET/shootout) keeps the outcome null until the deciders run; without them a
// level score is a draw (league semantics; the engine refuses to finalize a
// drawn knockout fixture via supportsDraws).
function resolveFullTime(state: FootballState, after: "FT" | "ET_FT"): FootballState {
  const { home, away } = state.goals;
  if (home !== away) {
    const winnerSide: Side = home > away ? "home" : "away";
    return {
      // W4a — the final whistle. A bin carried into an extra time this match
      // never plays is indexed past the phase the whistle closes, so only this
      // can end it.
      ...sweepEndOfMatch(state),
      phase: "done",
      outcome: {
        kind: "win",
        winner: state.entrants[winnerSide],
        loser: state.entrants[opponent(winnerSide)],
        method: after === "FT" ? "regulation" : "extra_time",
      },
    };
  }
  // Play continues into extra time or the kicks, so nothing is over yet. The
  // carry never spills into "SHOOTOUT" (no match clock there), so the phase
  // sweep has already cleared everything it could reach.
  if (after === "FT" && state.cfg.extraTime.enabled) return pushPeriod(state, "ET_H1");
  if (state.cfg.shootout) return { ...state, phase: "SHOOTOUT", shootout: { kicks: [] } };
  return { ...sweepEndOfMatch(state), phase: "done", outcome: { kind: "draw" } };
}

// spec 04 §1.4 — best-of-5 alternating, early decision when lead exceeds the
// opponent's remaining kicks, then sudden-death pairs. Extracted to the
// shared shootout primitive (v6/00 §3): football pens, IIHF GWS and the FIH
// shoot-out are one shape — `shootoutDecision`/`expectedKicker` now come from
// ../period/shootout.ts; byte-identical behavior locked by
// football.golden.test.ts, so module_version stays 1.0.0 (v6/00 §6.2).

// FIFA fair-play scale (spec 04 §1.5): yellow −1, second yellow (indirect
// red) −3, direct red −4, yellow + direct red −5 — one deduction per person,
// worst applicable category. Anonymous cards (coarse) deduct independently.
function fairPlayPoints(cards: readonly CardRecord[], side: Side): number {
  let total = 0;
  const byPerson = new Map<string, CardRecord[]>();
  for (const card of cards) {
    if (card.side !== side) continue;
    if (card.person === undefined) {
      total += card.color === "yellow" ? -1 : card.color === "second_yellow" ? -3 : -4;
      continue;
    }
    byPerson.set(card.person, [...(byPerson.get(card.person) ?? []), card]);
  }
  for (const personCards of byPerson.values()) {
    const hasYellow = personCards.some((card) => card.color === "yellow");
    const hasSecondYellow = personCards.some((card) => card.color === "second_yellow");
    const hasDirectRed = personCards.some((card) => card.color === "red");
    if (hasYellow && hasDirectRed) total += -5;
    else if (hasDirectRed) total += -4;
    else if (hasSecondYellow) total += -3;
    else if (hasYellow) total += -1;
  }
  return total;
}

function cardCounts(cards: readonly CardRecord[], side: Side): { yellow: number; red: number } {
  let yellow = 0;
  let red = 0;
  for (const card of cards) {
    if (card.side !== side) continue;
    if (card.color === "yellow" || card.color === "second_yellow") yellow++;
    if (card.color === "red" || card.color === "second_yellow") red++;
  }
  return { yellow, red };
}

function removeFromPitch(squad: FootballSquad, person: string, sentOff: boolean): FootballSquad {
  return {
    ...squad,
    onPitch: squad.onPitch.filter((id) => id !== person),
    sentOff: sentOff ? [...squad.sentOff, person] : squad.sentOff,
    // W4 — a permanent dismissal ends any temporary one already being served.
    ...(squad.sinBin === undefined
      ? {}
      : { sinBin: squad.sinBin.filter((entry) => entry.person !== person) }),
  };
}

// ---------------------------------------------------------------------------
// Event application
// ---------------------------------------------------------------------------

function applyGoal(state: FootballState, payload: z.infer<typeof FootballGoal>): FootballState {
  if (!isPlayPhase(state.phase)) {
    wrongPhase(`goal not allowed in phase "${state.phase}"`, { phase: state.phase });
  }
  const by = sideOf(state, payload.by);
  if (payload.scorer !== undefined) {
    // The scorer belongs to the striking side (`by`), also for own goals.
    const squad = state.squads[by];
    if (!squad.onPitch.includes(payload.scorer)) {
      invalid(`scorer "${payload.scorer}" is not on the pitch for "${payload.by}"`, {
        scorer: payload.scorer,
      });
    }
  }
  // spec 04 §1.3 — own-goal credits the opponent.
  return creditGoal(state, payload.ownGoal === true ? opponent(by) : by);
}

function applyCard(state: FootballState, payload: z.infer<typeof FootballCard>): FootballState {
  // Cards valid pre-kickoff (red before kickoff — football.md §9), during
  // play and during a shootout; never once the match is decided.
  if (state.phase === "done" || state.phase === "final" || state.phase === "abandoned") {
    wrongPhase(`card not allowed in phase "${state.phase}"`);
  }
  const side = sideOf(state, payload.by);
  let squads = state.squads;
  if (payload.person !== undefined) {
    const person = payload.person;
    const squad = state.squads[side];
    const inLineup =
      squad.onPitch.includes(person) ||
      squad.bench.includes(person) ||
      squad.offUsed.includes(person) ||
      // W4 — a player serving a temporary dismissal is off the pitch but very
      // much still cardable (a sin bin is frequently followed by a red).
      (squad.sinBin ?? []).some((entry) => entry.person === person) ||
      // S4 (#428) — a coach/team official (S3 ruling 3) is on the team sheet
      // and cardable, but never appears in any of the PLAYING lists above.
      (squad.nonPlayers ?? []).includes(person);
    if (squad.sentOff.includes(person)) {
      invalid(`"${person}" was already sent off`, { person });
    }
    if (!inLineup) {
      invalid(`"${person}" is not in the lineup for "${payload.by}"`, { person });
    }
    const priorYellow = state.cards.some(
      (card) => card.person === person && card.color === "yellow",
    );
    if (payload.color === "yellow" && priorYellow) {
      invalid(`second yellow for "${person}" must be recorded as second_yellow`, { person });
    }
    if (payload.color === "second_yellow" && !priorYellow) {
      invalid(`second_yellow for "${person}" without a prior yellow`, { person });
    }
    if (payload.color !== "yellow") {
      squads = { ...squads, [side]: removeFromPitch(squad, person, true) };
    }
  }
  const record: CardRecord = {
    side,
    ...(payload.person === undefined ? {} : { person: payload.person }),
    color: payload.color,
    ...(payload.minute === undefined ? {} : { minute: payload.minute }),
    ...(payload.reason === undefined ? {} : { reason: payload.reason }),
    ...(payload.at === undefined ? {} : { at: payload.at }),
  };
  return { ...state, cards: [...state.cards, record], squads };
}

function applySub(
  state: FootballState,
  payload: z.infer<typeof FootballSub>,
  ctx?: FoldContext,
): FootballState {
  if (!isPlayPhase(state.phase)) {
    wrongPhase(`substitution not allowed in phase "${state.phase}"`);
  }
  const side = sideOf(state, payload.by);
  const squad = state.squads[side];
  const rolling = state.cfg.rollingSubs === true;
  // S3/W4b (#426) — THE VERDICT IS THE KERNEL'S, for both vocabularies.
  //
  // Everything this block used to spell out itself — is `off` on the field, is
  // `on` someone this side may bring on, has this side already come back once,
  // has it spent its allowance — is one reducer now, the same one
  // `core.lineup.substitution` goes through. `football.sub` survives unchanged
  // on the wire (the frozen corpora contain it), and only what its fold CALLS
  // has moved.
  //
  // THE POLICY IS THE STRICT/REPLAY SEAM, exactly as in the fold kernel: a
  // scorer entering a substitution now is held to the variant's own rules, and
  // a substitution already in the ledger is replayed against the permissive
  // policy. A cfg-derived refusal on the read path would mean an organiser
  // lowering `maxSubs`, or switching a competition off rolling substitutions,
  // made every already-scored fixture in that division unreadable — with no
  // event to void, because the substitution was legal when it was made.
  const verdict = reduceLineupEvent(
    liftSquads(state),
    {
      type: "core.lineup.substitution",
      payload: {
        side: payload.by,
        off: payload.off,
        // `slot`/`orderNo` are structural filler: the person is already in the
        // lifted squad, so `bringOn` matches on `personId` and never reads them.
        // No `positionKey` — a `football.sub` does not state one (see liftSide).
        on: { personId: payload.on, slot: "bench" as const, orderNo: 1 },
      },
    },
    isStrictFold(ctx) ? lineupPolicy(state.cfg) : REPLAY_LINEUP_POLICY,
  );
  if (!verdict.ok) {
    invalid(verdict.message, { by: payload.by, reason: verdict.reason });
  }
  // W4a (#425) §5.2 (Law 3) — substitution WINDOWS. The Law counts the
  // stoppages a side substitutes at, not the players it substitutes: five subs
  // taken in three windows is legal, the same five taken one at a time is not,
  // and `maxSubs` alone cannot tell those apart. A window is the set of
  // substitutions sharing one `at`, so a side sending three on at one stoppage
  // spends one window.
  //
  // AN UNSTAMPED SUBSTITUTION IS IN NO WINDOW AND CONSUMES NONE. It has no `at`
  // to share, and reading "no stamp" as "one shared window" was the trap: every
  // unstamped sub in a match would have collapsed into a single window, which
  // reads as legal — until a one-window allowance rejects the second one and
  // every stream recorded before this wave becomes unfoldable. Recording them as
  // a window EACH is the mirror of the same bug. Consuming nothing is the only
  // reading under which an unstamped stream folds exactly as it does today.
  //
  // The bound applies ALONGSIDE `maxSubs`, never instead of it, and only when
  // the competition declared one.
  let subWindows = squad.subWindows;
  if (payload.at !== undefined) {
    const stamp = payload.at;
    const windows = squad.subWindows ?? [];
    // Same window = the same stamp, exactly. The monotonic guard means only the
    // newest window can still be joined, but matching on the value keeps that a
    // consequence rather than an assumption.
    const known = windows.some(
      (window) => window.period === stamp.period && window.elapsed === stamp.elapsed,
    );
    if (!known) {
      if (state.cfg.subWindows !== undefined && windows.length >= state.cfg.subWindows) {
        throw new EngineError(
          "SUB_WINDOW_EXCEEDED",
          `"${payload.by}" has used all ${state.cfg.subWindows} substitution windows`,
          { by: payload.by, subWindows: state.cfg.subWindows, at: stamp, used: [...windows] },
        );
      }
      subWindows = [...windows, stamp];
    }
  }
  const onPitch = [...squad.onPitch.filter((id) => id !== payload.off), payload.on];
  const base: FootballSquad = rolling
    ? // Repeat substitution: the player who came off rejoins the bench and may
      // re-enter, so nothing lands in offUsed.
      { ...squad, onPitch, bench: [...squad.bench.filter((id) => id !== payload.on), payload.off] }
    : {
        ...squad,
        onPitch,
        bench: squad.bench.filter((id) => id !== payload.on),
        offUsed: [...squad.offUsed, payload.off],
      };
  // Absent until the first STAMPED substitution — `base` already carries the
  // key when the squad had one, so an unstamped stream never grows it.
  const next: FootballSquad = subWindows === undefined ? base : { ...base, subWindows };
  return { ...state, squads: { ...state.squads, [side]: next } };
}

// W4 (Law 7) — stamp the marker's added time on the period it CLOSES, i.e. the
// last entry in play order. Absent added time leaves the entry untouched, so
// every pre-W4 stream serialises exactly as before.
function stampAddedMinutes(state: FootballState, addedMinutes: number | undefined): FootballState {
  if (addedMinutes === undefined || state.periods.length === 0) return state;
  const last = state.periods.length - 1;
  return {
    ...state,
    periods: state.periods.map((period, i) => (i === last ? { ...period, addedMinutes } : period)),
  };
}

/**
 * W4a (#425) review — had a dismissal answering this release's description in
 * fact run out by `at`?
 *
 * Read off `squad.sinBinLog`, which keeps every TIMED dismissal with the times
 * it was stamped with. `squad.sinBin` cannot answer it, because the whole
 * question only arises once the sweep has removed the entry from there.
 *
 * A player the fold SENT OFF answers "no", whatever the log says. A red card
 * drops the bin entry (`removeFromPitch`) precisely so they cannot return, and
 * honouring a release off the log alone would put a sent-off player back on the
 * pitch. An expiry that cannot be ordered against this cfg also answers "no".
 */
function alreadyRunOut(
  state: FootballState,
  side: Side,
  payload: z.infer<typeof FootballSinBinEnd>,
  at: GameTime,
): boolean {
  const squad = state.squads[side];
  if (payload.person !== undefined && squad.sentOff.includes(payload.person)) return false;
  const phases = playPhases(state.cfg);
  return (squad.sinBinLog ?? []).some((entry) => {
    if (entry.person !== payload.person) return false;
    const expiresAt = entry.expiresAt;
    if (expiresAt === undefined || !phases.includes(expiresAt.period)) return false;
    return compareGameTime(expiresAt, at, phases) <= 0;
  });
}

// W4 (Law 12 addendum) — the return that ends a temporary dismissal.
function applySinBinEnd(
  state: FootballState,
  payload: z.infer<typeof FootballSinBinEnd>,
): FootballState {
  if (!isPlayPhase(state.phase)) {
    wrongPhase(`sin bin not allowed in phase "${state.phase}"`, { phase: state.phase });
  }
  const side = sideOf(state, payload.by);
  const squad = state.squads[side];
  const bin = squad.sinBin ?? [];
  // An anonymous return closes the oldest anonymous dismissal — the only entry
  // it could possibly be about.
  const index = bin.findIndex((entry) => entry.person === payload.person);
  if (index < 0) {
    // W4a review — INVERTED. The whole premise of lazy expiry (§3.1) is that the
    // pad and the fold legitimately disagree between an expiry and the next
    // event: the pad is counting down, the fold is a record of facts. A scorer
    // who then records the release explicitly is being RIGHT, and refusing the
    // event punishes them for the fold's own laziness. So it is a NO-OP.
    //
    // Narrow on purpose, and `alreadyRunOut` is where the narrowness lives: only
    // where the log shows the named dismissal had in fact run out by this stamp.
    // A release of something that never existed, one still running, and one for
    // a player the fold sent off all keep their rejection — those are
    // contradictory records, not a scorer the fold got ahead of.
    if (payload.at !== undefined && alreadyRunOut(state, side, payload, payload.at)) return state;
    invalid(
      payload.person === undefined
        ? `"${payload.by}" has no anonymous sin bin to end`
        : `"${payload.person}" is not serving a sin bin`,
      { by: payload.by, ...(payload.person === undefined ? {} : { person: payload.person }) },
    );
  }
  const entry = bin[index] as SinBinRecord;
  return {
    ...state,
    squads: {
      ...state.squads,
      [side]: {
        ...squad,
        onPitch: entry.person === undefined ? squad.onPitch : [...squad.onPitch, entry.person],
        sinBin: bin.filter((_, i) => i !== index),
      },
    },
  };
}

// W4 (Law 12 addendum) — a temporary dismissal begins.
function applySinBinStart(
  state: FootballState,
  payload: z.infer<typeof FootballSinBinStart>,
): FootballState {
  if (!isPlayPhase(state.phase)) {
    wrongPhase(`sin bin not allowed in phase "${state.phase}"`, { phase: state.phase });
  }
  const side = sideOf(state, payload.by);
  const squad = state.squads[side];
  const bin = squad.sinBin ?? [];
  const withSquad = (next: FootballSquad): FootballState => ({
    ...state,
    squads: { ...state.squads, [side]: next },
  });

  if (payload.person !== undefined) {
    const person = payload.person;
    if (squad.sentOff.includes(person)) {
      invalid(`"${person}" was already sent off`, { person });
    }
    if (bin.some((entry) => entry.person === person)) {
      invalid(`"${person}" is already serving a sin bin`, { person });
    }
    if (!squad.onPitch.includes(person)) {
      invalid(`"${person}" is not on the pitch for "${payload.by}"`, { person });
    }
  }
  // The AWARDED duration: the payload's `minutes` where the referee gave one,
  // else the competition's `Cfg.sinBinMinutes`.
  //
  // `minutes` is the LENGTH; the adjacent `minute` is the display clock. Same
  // type, one letter apart, and reading the wrong one is the shape that
  // produced the `DisciplineCard.entrantSide` bug — so `minute` appears nowhere
  // in this arithmetic. It is a different unit measured from a different origin
  // (§5.2) and the fold never converts it.
  const minutes = payload.minutes ?? state.cfg.sinBinMinutes;
  // W4a (#425) §3.1 — a stamped dismissal of a known length becomes a TIMED
  // suspension: the fold derives when it runs out and sweeps it at the next
  // stamped event. BOTH halves are required, and the gate is deliberate — it is
  // what keeps the eleven frozen goldens byte-identical, since no recorded
  // stream carries `at` and nothing therefore expires that did not expire
  // before. `minutes` is MINUTES; `elapsed` is SECONDS, hence the ×60 inside
  // `expiryOf`, which also walks the cross-half carry (§3.2).
  const startedAt = payload.at;
  const expiresAt =
    startedAt === undefined ? undefined : expiryOf(state.cfg, startedAt, minutes);
  const record: SinBinRecord = {
    ...(payload.person === undefined ? {} : { person: payload.person }),
    ...(minutes === undefined ? {} : { minutes }),
    ...(payload.reason === undefined ? {} : { reason: payload.reason }),
    ...(payload.minute === undefined ? {} : { minute: payload.minute }),
    ...(startedAt === undefined ? {} : { startedAt }),
    ...(expiresAt === undefined ? {} : { expiresAt }),
  };
  return withSquad({
    ...squad,
    onPitch:
      payload.person === undefined
        ? squad.onPitch
        : squad.onPitch.filter((id) => id !== payload.person),
    sinBin: [...bin, record],
    // W4a review — the log keeps the same two stamps. Once the sweep removes
    // the entry from `sinBin` this is the ONLY record that can answer "had that
    // bin in fact run out by the stamp on this release?" (`alreadyRunOut`).
    // TIMED only, so an unstamped bin never grows the key and a pre-wave squad
    // serialises byte-identically.
    ...(expiresAt === undefined ? {} : { sinBinLog: [...(squad.sinBinLog ?? []), record] }),
  });
}

// W4 (Law 14) — an open-play penalty that was not converted. The score is
// untouched by construction; the record is what a match report needs.
function applyPenalty(state: FootballState, payload: z.infer<typeof FootballPenalty>): FootballState {
  if (!isPlayPhase(state.phase)) {
    wrongPhase(`penalty not allowed in phase "${state.phase}"`, { phase: state.phase });
  }
  const side = sideOf(state, payload.by);
  if (payload.taker !== undefined && !state.squads[side].onPitch.includes(payload.taker)) {
    invalid(`taker "${payload.taker}" is not on the pitch for "${payload.by}"`, {
      taker: payload.taker,
    });
  }
  // The goalkeeper facing the kick belongs to the DEFENDING side.
  if (
    payload.goalkeeper !== undefined &&
    !state.squads[opponent(side)].onPitch.includes(payload.goalkeeper)
  ) {
    invalid(`goalkeeper "${payload.goalkeeper}" is not on the pitch for the defending side`, {
      goalkeeper: payload.goalkeeper,
    });
  }
  const record: PenaltyRecord = {
    side,
    outcome: payload.outcome,
    ...(payload.taker === undefined ? {} : { taker: payload.taker }),
    ...(payload.goalkeeper === undefined ? {} : { goalkeeper: payload.goalkeeper }),
    ...(payload.minute === undefined ? {} : { minute: payload.minute }),
    // W4a §5.2 — the stamp rides beside the display integer, absent when the
    // pad recorded none, so a pre-wave penalty record is byte-identical.
    ...(payload.at === undefined ? {} : { at: payload.at }),
    // S4 (#428) — absent unless the referee's Law 12 offence was recorded, so
    // a pre-wave penalty record is byte-identical.
    ...(payload.offence === undefined ? {} : { offence: payload.offence }),
  };
  return { ...state, penalties: [...(state.penalties ?? []), record] };
}

// S8/#417 W6 — a shot with its own outcome; see `ShotOutcome`'s docstring for
// why it is a new enum. The goal itself still arrives as the ordinary
// `football.goal` event: an outcome-"scored" shot and the real goal both
// describe ONE event on the pitch, and this function is the whole
// double-count guard — it never calls `creditGoal` and never touches
// `state.goals`/`state.periods`, so there is no path here that could charge
// a score twice. State-only, score-neutral, mirrors `applyPenalty`'s own
// on-pitch validation shape (this file's convention, unlike the looser
// period kernel — see `applyShot` in `period/kernel.ts` for that file's own
// convention and why the two differ).
function applyShot(state: FootballState, payload: z.infer<typeof FootballShot>): FootballState {
  if (!isPlayPhase(state.phase)) {
    wrongPhase(`shot not allowed in phase "${state.phase}"`, { phase: state.phase });
  }
  const side = sideOf(state, payload.by);
  if (payload.taker !== undefined && !state.squads[side].onPitch.includes(payload.taker)) {
    invalid(`taker "${payload.taker}" is not on the pitch for "${payload.by}"`, {
      taker: payload.taker,
    });
  }
  // The goalkeeper facing the shot belongs to the DEFENDING side.
  if (
    payload.goalkeeper !== undefined &&
    !state.squads[opponent(side)].onPitch.includes(payload.goalkeeper)
  ) {
    invalid(`goalkeeper "${payload.goalkeeper}" is not on the pitch for the defending side`, {
      goalkeeper: payload.goalkeeper,
    });
  }
  const record: ShotRecord = {
    side,
    outcome: payload.outcome,
    ...(payload.taker === undefined ? {} : { taker: payload.taker }),
    ...(payload.goalkeeper === undefined ? {} : { goalkeeper: payload.goalkeeper }),
    ...(payload.at === undefined ? {} : { at: payload.at }),
  };
  return { ...state, shots: [...(state.shots ?? []), record] };
}

// S5/#431 — the marker that legally CLOSES `phase`, one entry per reachable
// play phase. Quarters and halves diverge only in what they call the SAME
// underlying moment: Q1 is "H1" reused (see `PlayPhase`'s own comment), so
// both branches key off "H1", and only the emitted marker differs. Used by
// `arbitraryEvent` below; kept as the exact inverse of `applyPeriod`'s own
// gating so the generator can never emit a marker `applyPeriod` would then
// refuse.
function nextMarker(phase: PlayPhase, quarters: boolean): z.infer<typeof FootballPeriod>["phase"] {
  if (quarters) {
    switch (phase) {
      case "H1":
        return "QT";
      case "Q2":
        return "HT";
      case "Q3":
        return "3QT";
      case "Q4":
        return "FT";
      case "ET_H1":
        return "ET_HT";
      default:
        return "ET_FT";
    }
  }
  switch (phase) {
    case "H1":
      return "HT";
    case "H2":
      return "FT";
    case "ET_H1":
      return "ET_HT";
    default:
      return "ET_FT";
  }
}

function applyPeriod(state: FootballState, payload: z.infer<typeof FootballPeriod>): FootballState {
  const marker = payload.phase;
  // W4a — the whistle CLOSES this phase, so anything whose expiry fell inside
  // it is over even if no stamped event ever arrived to sweep it. Runs on the
  // full-time marker too, or a side reads a player short in the FINAL state.
  const close = (): FootballState =>
    sweepThroughPhase(stampAddedMinutes(state, payload.addedMinutes), state.phase);
  // S5/#431 — quarters instead of halves (mini-soccer). Q1 IS "H1" reused,
  // never renamed, so halves mode and quarters mode share "H1" as their
  // opening state.phase. That is why EVERY arm below gates on cfg.halves and
  // not merely on state.phase: without the gate, sending the OLD "HT" marker
  // while state.phase === "H1" under cfg.halves === 4 would be silently
  // accepted as though it were the new Q1-end marker — same source phase,
  // wrong marker for the mode — and produce a mislabeled period record with
  // no error. Every wrong-marker-for-mode combination instead raises the same
  // WRONG_PHASE this switch already raises for every other illegal
  // transition. See DOMAIN.md's "Quarters instead of halves" row.
  const quarters = state.cfg.halves === 4;
  switch (marker) {
    // Q1 -> Q2. Quarters-only: halves mode has no marker between kickoff and
    // "HT".
    case "QT":
      if (!quarters || state.phase !== "H1") {
        wrongPhase(`QT marker in phase "${state.phase}"`, { phase: state.phase, halves: state.cfg.halves });
      }
      return pushPeriod(close(), "Q2");
    case "HT":
      // Quarters mode: Q2 -> Q3 — the SAME real half-time interval "HT"
      // always named, reused rather than duplicated. Halves mode: H1 -> H2,
      // unchanged from before this wave.
      if (quarters) {
        if (state.phase !== "Q2") {
          wrongPhase(`HT marker in phase "${state.phase}"`, { phase: state.phase, halves: state.cfg.halves });
        }
        return pushPeriod(close(), "Q3");
      }
      if (state.phase !== "H1") {
        wrongPhase(`HT marker in phase "${state.phase}"`, { phase: state.phase, halves: state.cfg.halves });
      }
      return pushPeriod(close(), "H2");
    // Q3 -> Q4. Quarters-only, symmetric with "QT" above.
    case "3QT":
      if (!quarters || state.phase !== "Q3") {
        wrongPhase(`3QT marker in phase "${state.phase}"`, { phase: state.phase, halves: state.cfg.halves });
      }
      return pushPeriod(close(), "Q4");
    case "FT":
      // Quarters mode: Q4 -> done/ET/shootout — the SAME final whistle "FT"
      // always named, reused rather than duplicated. `resolveFullTime` is
      // already phase-count-agnostic (it reads state.goals, never
      // state.phase or cfg.halves), so it needs no change either way. Halves
      // mode: H2 -> done/ET/shootout, unchanged from before this wave.
      if (quarters) {
        if (state.phase !== "Q4") {
          wrongPhase(`FT marker in phase "${state.phase}"`, { phase: state.phase, halves: state.cfg.halves });
        }
        return resolveFullTime(close(), "FT");
      }
      if (state.phase !== "H2") {
        wrongPhase(`FT marker in phase "${state.phase}"`, { phase: state.phase, halves: state.cfg.halves });
      }
      return resolveFullTime(close(), "FT");
    case "ET_HT":
      if (state.phase !== "ET_H1") wrongPhase(`ET_HT marker in phase "${state.phase}"`);
      return pushPeriod(close(), "ET_H2");
    case "ET_FT":
      if (state.phase !== "ET_H2") wrongPhase(`ET_FT marker in phase "${state.phase}"`);
      return resolveFullTime(close(), "ET_FT");
  }
}

function applyShootoutKick(
  state: FootballState,
  payload: z.infer<typeof FootballShootoutKick>,
): FootballState {
  if (state.phase !== "SHOOTOUT" || state.shootout === null) {
    wrongPhase(`shootout kick in phase "${state.phase}"`);
  }
  const side = sideOf(state, payload.by);
  const expected = expectedKicker(state.shootout.kicks);
  if (expected !== null && side !== expected) {
    invalid(`kicks must alternate: expected "${state.entrants[expected]}"`, {
      expected: state.entrants[expected],
    });
  }
  if (payload.person !== undefined) {
    const squad = state.squads[side];
    if (!squad.onPitch.includes(payload.person)) {
      invalid(`kicker "${payload.person}" is not on the pitch`, { person: payload.person });
    }
  }
  const kicks = [...state.shootout.kicks, { side, scored: payload.scored }];
  const winnerSide = shootoutDecision(kicks);
  if (winnerSide === null) return { ...state, shootout: { kicks } };
  return {
    ...sweepEndOfMatch(state), // W4a — the decider ends every timed dismissal
    shootout: { kicks },
    phase: "done",
    outcome: {
      kind: "win",
      winner: state.entrants[winnerSide],
      loser: state.entrants[opponent(winnerSide)],
      method: "shootout",
    },
  };
}

function applyForfeit(state: FootballState, by: string): FootballState {
  if (state.phase === "done" || state.phase === "final" || state.phase === "abandoned") {
    wrongPhase("match already over");
  }
  const winnerSide = opponent(sideOf(state, by));
  const goals =
    winnerSide === "home"
      ? { home: state.cfg.awardScore.goals, away: 0 }
      : { home: 0, away: state.cfg.awardScore.goals };
  // spec 04 §1 / PROMPT-04 §7 — forfeit ⇒ award with cfg.awardScore goals.
  return {
    ...sweepEndOfMatch(state), // W4a — the match is over, whatever phase it was in
    phase: "done",
    goals,
    outcome: { kind: "award", winner: state.entrants[winnerSide], score: goals },
  };
}

function applyAbandon(state: FootballState): FootballState {
  if (state.phase === "done" || state.phase === "final" || state.phase === "abandoned") {
    wrongPhase("match already over");
  }
  if (state.cfg.abandonPolicy === "replay") {
    // No outcome; fixture flagged for regeneration (PROMPT-04 §7). finalize
    // is refused because the outcome stays null.
    return { ...state, phase: "abandoned", replayFlagged: true };
  }
  const { home, away } = state.goals;
  // W4a — an AWARDED abandonment decides the match, so it is the final whistle.
  // The `replay` branch above deliberately does not sweep: that fixture is not
  // over, it is to be regenerated.
  if (home === away) {
    return { ...sweepEndOfMatch(state), phase: "done", outcome: { kind: "no_result" } };
  }
  const winnerSide: Side = home > away ? "home" : "away";
  return {
    ...sweepEndOfMatch(state),
    phase: "done",
    outcome: {
      kind: "award",
      winner: state.entrants[winnerSide],
      score: { home, away },
    },
  };
}

// ---------------------------------------------------------------------------
// Standings — spec 04 §1.5
// ---------------------------------------------------------------------------

function sideMetrics(state: FootballState, side: Side, zero: boolean): Record<string, number> {
  const counts = cardCounts(state.cards, side);
  const gf = zero ? 0 : state.goals[side];
  const ga = zero ? 0 : state.goals[opponent(side)];
  return {
    gf,
    ga,
    gd: gf - ga,
    yellow: counts.yellow,
    red: counts.red,
    fair_play: state.cfg.fairPlay ? fairPlayPoints(state.cards, side) : 0,
  };
}

// ---------------------------------------------------------------------------
// Tiebreaker presets — spec 04 §1.6 (verified against the FIFA 2026 source,
// engine/11-sources.md: H2H-first cascade aligned with UEFA for 2026).
// ---------------------------------------------------------------------------

export const FOOTBALL_TIEBREAKERS: Record<"fifa2026" | "classic", TiebreakerKey[]> = {
  // points → H2H points → H2H GD → H2H goals → overall GD → overall GF →
  // fair play → drawing of lots.
  fifa2026: ["points", "h2h_points", "h2h_diff", "h2h_for", "diff", "for", "fair_play", "lots"],
  // pre-2026 WC: points → overall GD → overall GF → H2H block → fair play → lots.
  classic: ["points", "diff", "for", "h2h_points", "h2h_diff", "h2h_for", "fair_play", "lots"],
};

// ---------------------------------------------------------------------------
// Positions — spec 04 §1 / PROMPT-04 §8
// ---------------------------------------------------------------------------

const positions: PositionCatalog = {
  groups: [
    { key: "GK", name: "Goalkeeper", min: 1, max: 1 },
    { key: "DF", name: "Defender" },
    { key: "MF", name: "Midfielder" },
    { key: "FW", name: "Forward" },
    // Child keys (display granularity below the four groups).
    { key: "CB", name: "Centre back" },
    { key: "LB", name: "Left back" },
    { key: "RB", name: "Right back" },
    { key: "CM", name: "Centre midfield" },
    { key: "DM", name: "Defensive midfield" },
    { key: "AM", name: "Attacking midfield" },
    { key: "LW", name: "Left wing" },
    { key: "RW", name: "Right wing" },
    { key: "ST", name: "Striker" },
  ],
  roles: [{ key: "captain", name: "Captain", unique: true }],
  lineup: { size: 11, benchMax: 12 },
};

// W4 (#407) — the catalog for a resolved config. Only the starting size moves:
// every small-sided code still fields exactly one goalkeeper (FA Mini-Soccer
// Rule 3, Futsal Law 3), and the position vocabulary is the same game.
function positionsFor(cfg: FootballCfg): PositionCatalog {
  if (cfg.teamSize === undefined || cfg.teamSize === positions.lineup.size) return positions;
  return { ...positions, lineup: { ...positions.lineup, size: cfg.teamSize } };
}

// ---------------------------------------------------------------------------
// Module
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// The lineup seam (S3/W4b, #426) — everything football says about who may take
// the field, said ONCE, to the kernel.
// ---------------------------------------------------------------------------

/**
 * What THIS VARIANT permits a lineup to do. The three owner rulings of
 * 2026-08-09, all as cfg and none as a per-sport constant:
 *
 *  - **Re-entry** (ruling 2). Law 3.3 forbids a substituted player to return;
 *    the FA youth and small-sided/futsal dispensations that share this module
 *    are rolling. `Cfg.rollingSubs` already said which, and it said it to a
 *    private `bench.includes(on)` test — this is the same fact, said to the one
 *    reducer every sport shares.
 *  - **The cap** (Law 3). Never applied under `rollingSubs`, which is uncapped
 *    by definition, exactly as before this wave.
 *  - **Growth** (ruling 1) is OFF, and football loses nothing by it: every
 *    football substitute comes off a pre-named bench, so a lineup event naming
 *    a person the team sheet never had is a mistake, not a concussion call-up.
 *  - **Exemptions** are declared, never inferred: the IFAB concussion trial and
 *    only when the competition has adopted it (`Cfg.concussionSubs`). An
 *    undeclared key is refused, which is what stops a pad evading the cap by
 *    inventing one.
 */
function lineupPolicy(cfg: FootballCfg): LineupPolicy {
  const rolling = cfg.rollingSubs === true;
  return {
    reentry: rolling ? "unlimited" : "none",
    reentryPositionLock: false,
    allowSquadGrowth: false,
    ...(rolling || cfg.maxSubs === undefined ? {} : { maxSubs: cfg.maxSubs }),
    ...(cfg.concussionSubs === undefined
      ? {}
      : { exemptions: { concussion: { max: cfg.concussionSubs } } }),
  };
}

/** Football's flattened view of a kernel side, as `init` writes it. Ordered by
 *  the team sheet's `orderNo` — the order every frozen stream recorded. */
function initialFootballSquad(side: SideSquad): FootballSquad {
  const byOrder = [...playingSquad(side)].sort((a, b) => a.orderNo - b.orderNo);
  // S4 (#428) — the inverse of playingSquad: every team-sheet member who is
  // NOT a player (role !== "player"). Static for the whole fixture — see the
  // field's own doc comment on FootballSquad.
  const nonPlayers = side.members.filter((m) => m.role !== "player").map((m) => m.personId);
  return {
    onPitch: byOrder.filter((m) => m.onField).map((m) => m.personId),
    bench: byOrder.filter((m) => !m.onField).map((m) => m.personId),
    offUsed: [],
    sentOff: [],
    ...(nonPlayers.length > 0 ? { nonPlayers } : {}),
  };
}

/**
 * Re-project football's squad after the KERNEL has accepted a `core.lineup.*`
 * event (the `onLineup` hook).
 *
 * Written as a DELTA against what football already had rather than as a
 * wholesale overwrite, and that is load-bearing in both directions:
 *
 *  - the kernel does not model a sending-off or a temporary dismissal, so an
 *    overwrite would put a red-carded player back on the pitch at the next
 *    substitution;
 *  - the kernel never sees a legacy `football.sub` (it is a module event), so an
 *    overwrite would also undo one.
 *
 * The delta is exactly "who did the kernel take off, and who did it put on",
 * which is derivable from the kernel members alone: a player it took off is off
 * the field with `timesOff > 0`, and a player it put on is on the field and was
 * not on football's pitch.
 */
function mergeFromKernel(prev: FootballSquad, side: SideSquad, rolling: boolean): FootballSquad {
  const known = new Map(playingSquad(side).map((m) => [m.personId, m] as const));
  const held = new Set([
    ...prev.sentOff,
    ...prev.offUsed,
    ...(prev.sinBin ?? []).flatMap((entry) => (entry.person === undefined ? [] : [entry.person])),
  ]);
  const tookOff = prev.onPitch.filter((person) => {
    const member = known.get(person);
    return member !== undefined && !member.onField && member.timesOff > 0;
  });
  const broughtOn = onFieldPersons(side).filter(
    (person) => !prev.onPitch.includes(person) && !held.has(person),
  );
  const off = new Set(tookOff);
  const on = new Set(broughtOn);
  const exemptUsed = Object.keys(side.exemptUsed).length === 0 ? prev.exemptUsed : side.exemptUsed;
  return {
    // Spread FIRST so the recorded key order is untouched and football's own
    // fields (sentOff, sinBin, subWindows, sinBinLog) survive verbatim.
    ...prev,
    onPitch: [...prev.onPitch.filter((person) => !off.has(person)), ...broughtOn],
    // Rolling substitution puts the player who came off back on the BENCH; the
    // return-forbidden variant puts him in `offUsed`. Same split `applySub`
    // makes, from the same `Cfg.rollingSubs`.
    bench: [...prev.bench.filter((person) => !on.has(person)), ...(rolling ? tookOff : [])],
    offUsed: rolling ? prev.offUsed : [...prev.offUsed, ...tookOff],
    ...(exemptUsed === undefined ? {} : { exemptUsed }),
  };
}

/**
 * S8/#417 — `goals_conceded` and `clean_sheets`, the `playerStats.folded`
 * escape hatch (see DOMAIN.md's "Goalkeeper stats" row). Mirrors
 * `periodKeeperStatsFold` (`sports/period/kernel.ts`, shared by both hockey
 * codes) but hand-written for football's own payload shape: `ownGoal` is a
 * boolean flag here, not a `kind` string, and football has no `emptyNet`
 * concept at all — the Laws of the Game do not let a side play out with an
 * empty net the way ice hockey pulls a goaltender, so there is no analogous
 * skip to make.
 *
 * READS THE FOLD of `core.lineup.*`, never the kickoff team sheet, under
 * `REPLAY_LINEUP_POLICY` (a read-side reconstruction with no `cfg` to
 * consult, and every knob at its most permissive is what a replay always
 * uses — see the file header). `goals_conceded` is charged to the
 * CONCEDING side's current `personsAtPosition(side, "GK")` occupant, worked
 * out from the CREDITED side (mirroring `applyGoal`'s own
 * `payload.ownGoal === true ? opponent(by) : by`) rather than from `by`
 * directly — the two disagree exactly on an own goal, where the side whose
 * player struck it is the side that concedes.
 *
 * CLEAN SHEET RULE (a documented judgement call, S8/#417 — no Law settles
 * this): a goalkeeper SPELL is the continuous stretch one person occupies
 * "GK" for their side, opened at kickoff (or wherever the fold first finds
 * an occupant) and closed by the next lineup change that installs a
 * DIFFERENT occupant, or by full time. A spell earns ONE clean sheet iff
 * its side conceded nothing during it — so a keeper brought on for the
 * second half with the score still 0-0 earns their own clean sheet
 * independently of whoever started, and a shutout split across two keepers
 * credits BOTH. Reads only recorded lineup events and goal credits, so it
 * carries none of the S2/#430 partial-coverage hazard a minutes-based rule
 * would.
 *
 * CARRIED LIMITATION (same shape as the row above this one in DOMAIN.md): a
 * keeper sent off (`football.card`) and replaced by an outfield player with
 * no recorded `core.lineup.position` stays the named "GK" here — sending a
 * player off is football-private state (`FootballSquad.sentOff`), invisible
 * to `core/lineup.ts`'s `SquadState`, exactly the gap the row above
 * documents for a fixture that mixes `football.sub` with `core.lineup.*`.
 *
 * S8/#417 W6 — `saves`, `shots_faced` and `save_percentage`, fed by
 * `football.shot`. Mirrors `periodKeeperStatsFold`'s own W6 addition
 * exactly (see that function's docstring for the full reasoning, repeated
 * only in outline here): `shots_faced` is `saves + goals_conceded`, never a
 * count of outcome-"scored" shot events — a goal is already fully known
 * from `football.goal`, so `shots_faced` needs no redundant shot logged
 * alongside every goal. A shot with outcome "scored" NEVER bumps
 * `goals_conceded`/`shots_faced` here (that would double-charge the same
 * real-world goal `football.goal` already counted) — it is read for
 * coverage evidence only. The credited keeper is `FootballShot.goalkeeper`
 * when present, else the same spell-derived on-ice occupant `goals_conceded`
 * already uses.
 *
 * SAVE PERCENTAGE is gated on the SAME per-side coverage checksum
 * `periodKeeperStatsFold` uses: a side is trusted iff every goal it
 * conceded also has a matching outcome-"scored" shot logged against it.
 * Known limitation carried identically: a side that conceded nothing has no
 * goal to check a shot log against and is trusted by default.
 */
function footballKeeperStatsFold(
  events: readonly EventEnvelope[],
  _ctx: PlayerStatsFoldCtx,
  lineups: LineupPair | undefined,
): PlayerStatRow[] {
  if (lineups === undefined) return [];

  // A sparse per-person stats object, NOT a fixed shape — matching
  // `stats.ts`'s own `bump`, a key is written only when it is actually
  // incremented. A keeper who only ever earns a clean sheet must not also
  // carry a `goals_conceded: 0` — that would be exactly the silent-0 defect
  // (recorded zero vs. never-happened) this programme's
  // `PlayerStatMetric.value` docstring calls out, just reached a different way.
  const rows = new Map<string, Record<string, number>>();
  const bump = (
    personId: string,
    key: "goals_conceded" | "clean_sheets" | "saves" | "shots_faced",
  ): void => {
    const stats = rows.get(personId) ?? {};
    stats[key] = (stats[key] ?? 0) + 1;
    rows.set(personId, stats);
  };

  const entrants = { home: lineups.home.entrantId, away: lineups.away.entrantId };
  const sideOf = (entrantId: string): Side | undefined =>
    entrantId === entrants.home ? "home" : entrantId === entrants.away ? "away" : undefined;

  let squads: KernelSquads = initSquads(lineups);
  const keeperOf = (side: Side): string | undefined => personsAtPosition(squads[side], "GK")[0];

  interface Spell {
    personId: string;
    conceded: boolean;
  }
  const open: Record<Side, Spell | undefined> = {
    home: (() => {
      const p = keeperOf("home");
      return p === undefined ? undefined : { personId: p, conceded: false };
    })(),
    away: (() => {
      const p = keeperOf("away");
      return p === undefined ? undefined : { personId: p, conceded: false };
    })(),
  };
  const closeSpell = (side: Side): void => {
    const spell = open[side];
    if (spell !== undefined && !spell.conceded) bump(spell.personId, "clean_sheets");
  };
  const refreshSpell = (side: Side): void => {
    const p = keeperOf(side);
    if (open[side]?.personId === p) return; // same occupant — spell continues
    closeSpell(side);
    open[side] = p === undefined ? undefined : { personId: p, conceded: false };
  };

  // S8/#417 W6 — the save-percentage coverage checksum's two counters, per
  // side (see this function's own docstring). `keeperSide` remembers which
  // side each person who touched saves/shots_faced was credited under.
  const goalsConcededBySide: Record<Side, number> = { home: 0, away: 0 };
  const goalShotsLoggedBySide: Record<Side, number> = { home: 0, away: 0 };
  const keeperSide = new Map<string, Side>();

  for (const event of events) {
    if (isLineupEventType(event.type)) {
      const result = reduceLineupEvent(squads, event, REPLAY_LINEUP_POLICY);
      if (result.ok) {
        squads = result.squads;
        refreshSpell("home");
        refreshSpell("away");
      }
      continue;
    }
    if (event.type === "football.goal") {
      const payload = event.payload as Record<string, unknown>;
      if (typeof payload.by !== "string") continue;
      const by = sideOf(payload.by);
      if (by === undefined) continue;
      const credited = payload.ownGoal === true ? opponent(by) : by;
      const concedingSide = opponent(credited);

      const spell = open[concedingSide];
      if (spell !== undefined) spell.conceded = true;
      goalsConcededBySide[concedingSide] += 1;

      const keeper = keeperOf(concedingSide);
      if (keeper !== undefined) {
        bump(keeper, "goals_conceded");
        bump(keeper, "shots_faced"); // a goal IS an on-target shot faced
        keeperSide.set(keeper, concedingSide);
      }
      continue;
    }
    if (event.type === "football.shot") {
      const payload = event.payload as Record<string, unknown>;
      if (typeof payload.by !== "string") continue;
      const shooterSide = sideOf(payload.by);
      if (shooterSide === undefined) continue;
      const facingSide = opponent(shooterSide);

      if (payload.outcome === "scored") {
        // Coverage evidence ONLY — see this function's own docstring. Never
        // touches `goals_conceded`/`shots_faced`: that goal was already
        // counted once, by the `football.goal` branch above.
        goalShotsLoggedBySide[facingSide] += 1;
        continue;
      }
      if (payload.outcome !== "saved") continue; // missed/blocked never reach the keeper

      const explicitKeeper = typeof payload.goalkeeper === "string" ? payload.goalkeeper : undefined;
      const keeper = explicitKeeper ?? keeperOf(facingSide);
      if (keeper !== undefined) {
        bump(keeper, "saves");
        bump(keeper, "shots_faced");
        keeperSide.set(keeper, facingSide);
      }
    }
  }
  closeSpell("home");
  closeSpell("away");

  // S8/#417 W6 — save percentage, gated on the per-side coverage checksum
  // computed above (see this function's own docstring).
  const covered: Record<Side, boolean> = {
    home: goalsConcededBySide.home === goalShotsLoggedBySide.home,
    away: goalsConcededBySide.away === goalShotsLoggedBySide.away,
  };
  for (const [personId, side] of keeperSide) {
    if (!covered[side]) continue;
    const stats = rows.get(personId);
    const shotsFaced = stats?.shots_faced ?? 0;
    if (stats === undefined || shotsFaced === 0) continue; // nothing to divide by
    const saves = stats.saves ?? 0;
    stats.save_percentage = Math.round((saves / shotsFaced) * 1000) / 10; // one decimal
  }

  return [...rows.entries()].map(([personId, stats]) => ({ personId, stats }));
}

/**
 * Football's squad, expressed in the kernel's vocabulary, so that a legacy
 * `football.sub` is judged by the SAME reducer a `core.lineup.substitution` is.
 *
 * This is the fork-killer. `football.sub` cannot be deleted — the frozen
 * corpora contain it — so the two vocabularies coexist, and the only way they
 * cannot drift is that neither owns the rule. `football.lineup.test.ts` holds
 * them to the same NUMBER of permitted substitutions rather than to "each
 * works", because two implementations that each work is exactly what the last
 * three placer/verifier bugs looked like.
 *
 * POSITIONS ARE DELIBERATELY ABSENT from the lift: `football.sub` names no
 * position, so inventing one here would let `personsAtPosition` answer from a
 * fact nobody recorded — the `DisciplineCard.entrantSide` shape. Positions come
 * from the kernel's own squads, which the fold carries and returns.
 */
function liftSide(state: FootballState, side: Side): SideSquad {
  const squad = state.squads[side];
  const exempt = Object.values(squad.exemptUsed ?? {}).reduce((total, n) => total + n, 0);
  let orderNo = 0;
  const member = (personId: string, onField: boolean, timesOff: number): SquadMember => ({
    personId,
    role: "player",
    provenance: "named",
    orderNo: (orderNo += 1),
    onField,
    started: false,
    timesOff,
    timesOn: 0,
  });
  const gone = squad.offUsed.filter(
    (person) => !squad.onPitch.includes(person) && !squad.bench.includes(person),
  );
  return {
    entrantId: state.entrants[side],
    members: [
      ...squad.onPitch.map((person) => member(person, true, 0)),
      ...squad.bench.map((person) => member(person, false, 0)),
      ...gone.map((person) => member(person, false, 1)),
    ],
    // The cap counts ORDINARY substitutions. An exempt replacement is in
    // `offUsed` too (it is permanent), so it has to be subtracted back out or
    // the exemption would spend the allowance it exists to sit outside.
    subsUsed: Math.max(0, squad.offUsed.length - exempt),
    exemptUsed: squad.exemptUsed ?? {},
  };
}

function liftSquads(state: FootballState): KernelSquads {
  return { home: liftSide(state, "home"), away: liftSide(state, "away") };
}

// The event dispatch, unchanged since W4. It is lifted out of `apply` so that
// `apply` can wrap it in the game-time frame — validate the stamp, sweep,
// dispatch, sweep again for the one release case, record `asOf` — rather than
// threading a stamp through every branch. The switch returning directly is what
// made post-processing impossible before.
function applyEvent(
  state: FootballState,
  ev: EventEnvelope<FootballEv | CoreEv>,
  ctx?: FoldContext,
): FootballState {
  switch (ev.type) {
    case "core.start":
      if (state.phase !== "pre") wrongPhase("already started");
      return pushPeriod(state, "H1");
    case "football.goal":
      return applyGoal(state, parsePayload(FootballGoal, ev.payload, ev.type));
    case "football.card":
      return applyCard(state, parsePayload(FootballCard, ev.payload, ev.type));
    case "football.sub":
      return applySub(state, parsePayload(FootballSub, ev.payload, ev.type), ctx);
    case "football.period":
      return applyPeriod(state, parsePayload(FootballPeriod, ev.payload, ev.type));
    case "football.shootout.kick":
      return applyShootoutKick(state, parsePayload(FootballShootoutKick, ev.payload, ev.type));
    case "football.penalty":
      return applyPenalty(state, parsePayload(FootballPenalty, ev.payload, ev.type));
    case "football.sinbin.start":
      return applySinBinStart(state, parsePayload(FootballSinBinStart, ev.payload, ev.type));
    case "football.sinbin.end":
      return applySinBinEnd(state, parsePayload(FootballSinBinEnd, ev.payload, ev.type));
    case "football.shot":
      return applyShot(state, parsePayload(FootballShot, ev.payload, ev.type));
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
}

// ---------------------------------------------------------------------------
// S6/#416 (W5) — padSpec. Pure function of resolved cfg (base ⊕ variant
// preset ⊕ org overrides, already resolved by the caller); every bound below
// reads cfg, never a hardcoded preset number — see `periodMarkers` and the
// sin-bin `minutes` cap for the two variant-sensitive cases this session's
// brief names (11-a-side vs mini-soccer, S5/#431's quarters).
// ---------------------------------------------------------------------------

// A generously large, finite stand-in for "elapsed may legitimately overrun
// the nominal period length" (core/time.ts's GameTime doc comment — football's
// own "90+3"). Not a rules number, only a property-testing upper bound
// comfortably past any plausible stoppage-inclusive reading — mirrors
// cricket's own UNBOUNDED_BALLS_SENTINEL.
const MAX_ELAPSED_SECONDS = 7200;
// Law 7 allowance for time lost has no fixed cap; this is a plausible upper
// bound for a UI control, not a Law constant.
const MAX_ADDED_MINUTES = 30;

/**
 * Legal `football.period` MARKER strings for this cfg — the padSpec-level
 * twin of `applyPeriod`'s own gating (S5/#431), so a pad can never offer a
 * marker the fold would then refuse for the wrong mode. Quarters
 * (`cfg.halves === 4`) get "QT"/"HT"/"3QT"/"FT" (Q1 itself is "H1" reused,
 * never a marker of its own — see `PlayPhase`'s comment); halves get
 * "HT"/"FT". Both add "ET_HT"/"ET_FT" when `cfg.extraTime.enabled`, because
 * `applyPeriod`'s ET arms are not gated on `quarters` at all.
 */
function periodMarkers(cfg: FootballCfg): string[] {
  return [
    ...(cfg.halves === 4 ? ["QT", "HT", "3QT", "FT"] : ["HT", "FT"]),
    ...(cfg.extraTime.enabled ? ["ET_HT", "ET_FT"] : []),
  ];
}

/**
 * `at.period` / `at.elapsed` — the W4a (#425) stamp every FootballEv branch
 * carries (`GameTime.optional()`). `at.period` reuses `playPhases(cfg)`
 * VERBATIM: it is the exact list `apply()`'s own strict-fold guard checks a
 * stamp's `period` against (§7), so a pad can never offer a period label the
 * fold would then reject as unrecognised — one function, every action, never
 * eight copies that could drift (this repo's recurring placer/verifier
 * fork).
 *
 * DOMAIN.md ("W4a — what the pad owes the time model (PadSpec, #416)") names
 * the stamp as an owed pad fact: without these two fields the whole W4a time
 * model (lazy sin-bin expiry, substitution windows, the monotonic guard) is
 * unreachable from the declared scoring surface. The deprecated `minute`
 * display integer is deliberately NOT modelled as its own field here — `at`
 * is what every post-W4a fold path actually reads, and a second control for
 * "when" is the second-vocabulary trap this programme keeps finding
 * elsewhere (S2/#430's `quick|standard|full`).
 */
function stampFields(cfg: FootballCfg): PadField[] {
  return [
    { kind: "enum", path: "at.period", values: playPhases(cfg) },
    { kind: "number", path: "at.elapsed", min: 0, max: MAX_ELAPSED_SECONDS },
  ];
}

const BY_SIDE: PadAttributionItem = { kind: "side", path: "by" };

export function padSpec(cfg: FootballCfg): PadSpec {
  const stamp = stampFields(cfg);

  // --- Goals ---------------------------------------------------------------
  const goalAction: PadAction = {
    type: "football.goal",
    labelKey: { key: "pad.football.action.goal", label: "Goal" },
    fields: [{ kind: "toggle", path: "ownGoal" }, { kind: "toggle", path: "penalty" }, ...stamp],
    attribution: [BY_SIDE, { kind: "person", path: "scorer" }, { kind: "person", path: "assist" }],
  };

  // --- Cards (Law 12.3/12.4) -------------------------------------------------
  const cardAction: PadAction = {
    type: "football.card",
    labelKey: { key: "pad.football.action.card", label: "Card" },
    fields: [
      { kind: "enum", path: "color", values: CardColor.options },
      // S4 (#428) — the SAME closed enum already shipped end to end
      // (discipline usecase, DB, dictionaries); not a second list.
      { kind: "enum", path: "reason", values: CardReason.options },
      ...stamp,
    ],
    attribution: [BY_SIDE, { kind: "person", path: "person" }],
  };

  // --- Substitutions (Law 3) -------------------------------------------------
  const subAction: PadAction = {
    type: "football.sub",
    labelKey: { key: "pad.football.action.sub", label: "Substitution" },
    fields: [...stamp],
    attribution: [BY_SIDE, { kind: "person", path: "off" }, { kind: "person", path: "on" }],
  };

  // --- Period flow, incl. mini-soccer quarters (S5/#431) ---------------------
  const periodAction: PadAction = {
    type: "football.period",
    labelKey: { key: "pad.football.action.period", label: "Period marker" },
    fields: [
      { kind: "enum", path: "phase", values: periodMarkers(cfg) },
      { kind: "number", path: "addedMinutes", min: 0, max: MAX_ADDED_MINUTES },
      ...stamp,
    ],
    attribution: [], // a whistle belongs to neither side — FootballPeriod has no `by`
  };

  // --- Shoot-out (spec 04 §1.4) -----------------------------------------------
  const shootoutKickAction: PadAction = {
    type: "football.shootout.kick",
    labelKey: { key: "pad.football.action.shootoutKick", label: "Shoot-out kick" },
    fields: [{ kind: "toggle", path: "scored" }, ...stamp],
    attribution: [BY_SIDE, { kind: "person", path: "person" }],
  };

  // --- Unconverted penalty (Law 14) ------------------------------------------
  const penaltyAction: PadAction = {
    type: "football.penalty",
    labelKey: { key: "pad.football.action.penalty", label: "Penalty" },
    fields: [
      { kind: "enum", path: "outcome", values: PenaltyOutcome.options },
      // S4 (#428) — optional everywhere, same as football.card's reason.
      { kind: "enum", path: "offence", values: PenaltyOffence.options },
      ...stamp,
    ],
    attribution: [BY_SIDE, { kind: "person", path: "taker" }, { kind: "person", path: "goalkeeper" }],
  };

  // --- Sin bin (Law 12 addendum, temporary dismissal) -------------------------
  // `minutes`' bound is `cfg.halfMinutes`: a temporary dismissal outlasting a
  // whole play period has no meaning under this Law, and it is the one cfg
  // number this sport already has for "how long is a period" — the same
  // scalar `phaseLengths`/`expiryOf` read to compute the real expiry.
  const sinBinStartAction: PadAction = {
    type: "football.sinbin.start",
    labelKey: { key: "pad.football.action.sinbinStart", label: "Sin bin" },
    fields: [
      { kind: "enum", path: "reason", values: CardReason.options },
      { kind: "number", path: "minutes", min: 1, max: cfg.halfMinutes },
      ...stamp,
    ],
    attribution: [BY_SIDE, { kind: "person", path: "person" }],
  };
  const sinBinEndAction: PadAction = {
    type: "football.sinbin.end",
    labelKey: { key: "pad.football.action.sinbinEnd", label: "Sin bin return" },
    fields: [...stamp],
    attribution: [BY_SIDE, { kind: "person", path: "person" }],
  };

  // --- Shots (S8/#417 W6) -----------------------------------------------
  const shotAction: PadAction = {
    type: "football.shot",
    labelKey: { key: "pad.football.action.shot", label: "Shot" },
    fields: [{ kind: "enum", path: "outcome", values: ShotOutcome.options }, ...stamp],
    attribution: [BY_SIDE, { kind: "person", path: "taker" }, { kind: "person", path: "goalkeeper" }],
  };

  // Shoot-out panel: cfg decides whether the FORMAT can ever reach one
  // (`cfg.shootout`) — a league fixture never declares it, so the panel is
  // simply absent, the cfg-only inclusion case the module-level note on
  // `PadGate` describes. Whether it is reachable RIGHT NOW is state (a level
  // knockout tie may finish in regulation or ET and never reach kicks), so
  // the panel also carries a runtime gate — same two-layer shape as
  // cricket's super-over panel.
  const shootoutPanels: PadPanel[] = cfg.shootout
    ? [
        {
          labelKey: { key: "pad.football.panel.shootout", label: "Shoot-out" },
          phase: "live",
          layout: "drawer",
          actions: [shootoutKickAction],
          gate: { op: "path-equals", path: "state.phase", value: "SHOOTOUT" } satisfies PadGate,
        },
      ]
    : [];

  // No "pre" or "post" panel: football's own `eventSchema` has no pre-match
  // (toss/colour) or post-match (scorecard-line) branch the way cricket does
  // — a pre-kickoff card is still `football.card` (legal in phase "pre", see
  // `applyCard`), so every one of this module's 8 registered types is a
  // "live" action.
  const panels: PadPanel[] = [
    {
      labelKey: { key: "pad.football.panel.goals", label: "Goals" },
      phase: "live",
      layout: "primary",
      actions: [goalAction],
    },
    {
      labelKey: { key: "pad.football.panel.period", label: "Period" },
      phase: "live",
      layout: "primary",
      actions: [periodAction],
    },
    {
      labelKey: { key: "pad.football.panel.cards", label: "Cards" },
      phase: "live",
      layout: "grid",
      actions: [cardAction],
    },
    {
      labelKey: { key: "pad.football.panel.subs", label: "Substitutions" },
      phase: "live",
      layout: "grid",
      actions: [subAction],
    },
    {
      labelKey: { key: "pad.football.panel.penalties", label: "Penalties" },
      phase: "live",
      layout: "drawer",
      actions: [penaltyAction],
    },
    {
      labelKey: { key: "pad.football.panel.sinbin", label: "Sin bin" },
      phase: "live",
      layout: "drawer",
      actions: [sinBinStartAction, sinBinEndAction],
    },
    ...shootoutPanels,
    {
      labelKey: { key: "pad.football.panel.shots", label: "Shots" },
      phase: "live",
      layout: "grid",
      actions: [shotAction],
    },
  ];

  return {
    panels,
    // S6 owner ruling (_INDEX.md, "redesign the fidelity model, in S6") — one
    // band per event type, no repetition. Football's OLD (untouched)
    // `fidelityTiers` duplicates tier 0/tier 1 and duplicates tier 2/tier 3
    // (S2/#430 finding); the two REAL levels underneath both duplicates are
    // "the bare score" and "the full timeline", which is exactly what these
    // two bands carry. Band 1 is deliberately unused: this sport has no
    // admin/context event group between them (no toss/interruption/powerplay
    // equivalent exists for football today) — a different reason from
    // carrom's stop-at-1, but the same shape, a module using only the bands
    // it needs.
    //
    // S8/#417 W6 — band 3 ("detail") is NO LONGER unused: S2/#430 found
    // football's tier 3 was an unfilled duplicate of tier 2 and parked real
    // detail-level content for a later session — this is that session.
    // `football.shot` is the one band-3 event.
    fidelity: {
      "football.goal": 0,
      "football.period": 0,
      "football.shootout.kick": 0,
      "football.card": 2,
      "football.sub": 2,
      "football.penalty": 2,
      "football.sinbin.start": 2,
      "football.sinbin.end": 2,
      "football.shot": 3,
    },
    // Band 2 unchanged. Band 3 REUSES the same entitlement — matches the OLD
    // ladder's own paid boundary (`fidelityTiers` below still carries
    // "scoring.match_timeline" on both tier 2 AND tier 3) rather than
    // inventing a second FeatureKey/billing-plan row this session is not
    // scoped to create.
    fidelityEntitlements: { 2: "scoring.match_timeline", 3: "scoring.match_timeline" },
  };
}

export const football: SportModule<FootballCfg, FootballEv, FootballState> = {
  key: "football",
  version: "1.0.0",
  configSchema: FootballCfg,
  eventSchema: FootballEv,
  eventSchemas: FOOTBALL_EVENT_SCHEMAS,
  padSpec,
  positions,
  positionsFor,
  entrantModel: { kinds: ["team"], defaultKind: "team", team: { squadNumbers: true, captain: true } },
  variants: {
    // spec 04 §1.1
    "11-a-side": {},
    // W4 — FA youth football and every small-sided/futsal code use repeat
    // substitutions (Law 3 / FA Mini-Soccer + SSG rules); 11-a-side does not.
    youth: { halfMinutes: 30, rollingSubs: true },
    // W4 — the FA's Small-Sided Games run 5v5 (U7–U8), 7v7 (U9–U10) and 9v9
    // (U11–U12); 7 is the middle rung and the one this preset names. A
    // competition on another rung sets `teamSize` itself. Before W4 this
    // variant declared no size at all, so it inherited the eleven-slot catalog
    // and could not hold a legal lineup.
    "small-sided": { halfMinutes: 20, halves: 2, rollingSubs: true, teamSize: 7 },
    // S5/#431 — FA Mini-Soccer, the U7-U10 age groups: FOUR 10-minute
    // quarters, not `youth`'s 2×30 halves (FA U13+, unchanged and distinct —
    // the two presets serve disjoint age groups and neither modifies the
    // other). `small-sided` also plays halves (2×20) and is likewise
    // unchanged: this is a fourth, additive option a competition may pick
    // instead, not a replacement for either. Rolling substitutions, like
    // every other grassroots/youth preset this module declares.
    "mini-soccer": { halfMinutes: 10, halves: 4, rollingSubs: true, teamSize: 7 },
  },

  init(cfg, lineups: LineupPair): FootballState {
    // S3/W4b (#426) — ONE construction of the squad, the kernel's. The private
    // `squadFromLineup` this replaces read every slot's `positionKey` and threw
    // it away on the next line, which is why "who is in goal" was unanswerable
    // from any folded football state. `initSquads` keeps it, and the fold
    // carries the result (`foldMatchWithStoppage(...).squads`, `ctx.squads`);
    // what lands in `State` is the flattened projection below, byte-identical
    // to what every frozen stream recorded.
    const squads = initSquads(lineups);
    return {
      cfg,
      entrants: { home: lineups.home.entrantId, away: lineups.away.entrantId },
      phase: "pre",
      goals: { home: 0, away: 0 },
      periods: [],
      cards: [],
      squads: {
        home: initialFootballSquad(squads.home),
        away: initialFootballSquad(squads.away),
      },
      shootout: null,
      outcome: null,
      replayFlagged: false,
    };
  },

  // S3/W4b (#426) — football's lineup rules, declared once (see lineupPolicy).
  lineupPolicy,

  /**
   * S3/W4b (#426) — the kernel has accepted a `core.lineup.*` event; football
   * moves its own pitch to match.
   *
   * Without this the two vocabularies would be mute to each other: the kernel
   * would have the substitute on the field and football would refuse his very
   * next goal as "not on the pitch". Called once at `init` too, where it is a
   * no-op by construction — `init` builds its projection from the same
   * `initSquads` — which is what stops football's State and the kernel's
   * SquadState being two constructions of one fact.
   */
  onLineup(state, squads): FootballState {
    const rolling = state.cfg.rollingSubs === true;
    return {
      ...state,
      squads: {
        home: mergeFromKernel(state.squads.home, squads.home, rolling),
        away: mergeFromKernel(state.squads.away, squads.away, rolling),
      },
    };
  },

  // W4a (#425) §7 — the SAME function the fold kernel's monotonic guard reads,
  // handed over directly rather than as a copy of its output. `sweepExpired`
  // calls it too, so the guard and this module order against one list.
  playPhases,

  apply(state, ev: EventEnvelope<FootballEv | CoreEv>, ctx): FootballState {
    // W4a (#425) §3 — the game-time frame around every event.
    //
    // `gameTimeOf` is the same structural safe-parse the fold kernel's monotonic
    // guard uses, so the module and the guard read one stamp rather than two
    // interpretations of one payload.
    const at = gameTimeOf(ev.payload);
    if (at !== null && isStrictFold(ctx)) {
      // §7, module half. The fold guard already refuses an undeclared period,
      // but `apply` must not DEPEND on having been called through it: the same
      // list, the same error code, and a message that names the phases so a
      // scorer can retype rather than a 500 that pages the on-call.
      //
      // STRICT ONLY (§3.3 seam). `playPhases` is derived from cfg — turning off
      // `extraTime.enabled` or `shootout` deletes three phases at once — and cfg
      // is read live at fold time, so on replay this same check says "an
      // organiser edited the division, therefore no scored fixture in it can be
      // read again". There is no event to void; the stamp was legal when it was
      // recorded. Nothing downstream needs the refusal either: `sweepExpired`
      // and every comparison below go through `orderable`, which returns null
      // for an unlisted phase rather than raising.
      const order = playPhases(state.cfg);
      if (!order.includes(at.period)) {
        invalid(
          `event "${ev.type}" is stamped in period "${at.period}", which this sport does not have — expected one of ${order.join(", ")}`,
          { period: at.period, phaseOrder: order },
        );
      }
    }
    // Sweep BEFORE applying, so an event at 20:00 sees the pitch as it was at
    // 20:00. The one exception is an explicit release: sweeping first would
    // remove the very bin the end event names, and the fold would then have to
    // reconcile a scorer who correctly recorded both the expiry and the release
    // — so that one applies first and sweeps after.
    const sweepsFirst = at !== null && ev.type !== "football.sinbin.end";
    const base = sweepsFirst ? sweepExpired(state, at) : state;
    const applied = applyEvent(base, ev, ctx);
    if (at === null) return applied;
    const swept = ev.type === "football.sinbin.end" ? sweepExpired(applied, at) : applied;
    // §6 obligation 3 — as of when everything above is true.
    return { ...swept, asOf: at };
  },

  outcome: (state) => state.outcome,

  // W4a (#425) T6b — the cross-sport position axis, via the SAME core
  // derivation the period kernel uses (see `footballPosition`).
  position: footballPosition,

  // §9.5 — defined at every prefix.
  summary(state): ScoreSummary {
    const { home, away } = state.goals;
    const shootout = state.shootout
      ? state.shootout.kicks.reduce(
          (tally, kick) => {
            if (kick.scored) tally[kick.side]++;
            return tally;
          },
          { home: 0, away: 0 },
        )
      : null;
    const suffix = shootout ? ` (${shootout.home}–${shootout.away} pens)` : "";
    return {
      headline: `${home} — ${away}${suffix}`,
      perSide: [
        { entrantId: state.entrants.home, line: `${home}${shootout ? ` (${shootout.home}p)` : ""}` },
        { entrantId: state.entrants.away, line: `${away}${shootout ? ` (${shootout.away}p)` : ""}` },
      ],
      detail: {
        periods: state.periods,
        ...(shootout === null ? {} : { shootout }),
        // W4: unconverted penalties and sin bins deliberately do NOT appear
        // here. §9.6 requires summary(coarse) === summary(fine), and coarsen
        // drops every event with no score effect — same reason `cards` has
        // never been in the summary. They live in State and in the ledger,
        // which is what the match report reads.
        ...(state.replayFlagged ? { abandoned: true } : {}),
      },
    };
  },

  standingsDelta(outcome, cfg, _ctx: StageCtx, state): [StandingsDelta, StandingsDelta] {
    const build = (
      side: Side,
      w: number,
      d: number,
      l: number,
      pts: number,
      zeroGoals = false,
    ): StandingsDelta => ({
      entrantId: state.entrants[side],
      played: 1,
      won: w,
      drawn: d,
      lost: l,
      points: pts,
      metrics: sideMetrics(state, side, zeroGoals),
    });

    switch (outcome.kind) {
      case "win":
      case "award": {
        const winnerSide = sideOf(state, outcome.winner);
        // spec 04 §1.4 — optional shootout points split (group-stage SO).
        const split =
          outcome.kind === "win" &&
          outcome.method === "shootout" &&
          cfg.points.shootoutWin !== undefined &&
          cfg.points.shootoutLoss !== undefined;
        const winnerPts = split ? (cfg.points.shootoutWin as number) : cfg.points.win;
        const loserPts = split ? (cfg.points.shootoutLoss as number) : cfg.points.loss;
        const winner = build(winnerSide, 1, 0, 0, winnerPts);
        const loser = build(opponent(winnerSide), 0, 0, 1, loserPts);
        return winnerSide === "home" ? [winner, loser] : [loser, winner];
      }
      case "draw":
      case "tie":
        return [build("home", 0, 1, 0, cfg.points.draw), build("away", 0, 1, 0, cfg.points.draw)];
      case "no_result":
        // Abandoned level match under the 'award' policy: share draw points,
        // no draw counted, no goal metrics (mirrors the generic module).
        return [
          build("home", 0, 0, 0, cfg.points.draw, true),
          build("away", 0, 0, 0, cfg.points.draw, true),
        ];
    }
  },

  metrics: [
    // doc 09 §2: the public table shows P W D L GF GA GD Pts — card counts and
    // fair-play stay ledger-only (display: false).
    { key: "gf", label: "GF", direction: "desc" },
    { key: "ga", label: "GA", direction: "asc" },
    { key: "gd", label: "GD", direction: "desc" },
    { key: "yellow", label: "Yellow cards", direction: "asc", display: false },
    { key: "red", label: "Red cards", direction: "asc", display: false },
    { key: "fair_play", label: "Fair play points", direction: "desc", display: false },
  ],
  // Module default = fifa2026 (spec 04 §1.6); `classic` selectable by the
  // organiser via FOOTBALL_TIEBREAKERS.
  defaultTiebreakers: FOOTBALL_TIEBREAKERS.fifa2026,

  // spec 04 §1.3 — draws are league/group results only.
  supportsDraws(_cfg, stage: StageKind) {
    return stage === "league" || stage === "group" || stage === "swiss";
  },

  // §9.3 — {win+loss, 2·draw} plus the optional shootout split total.
  declaredPointsSets(cfg) {
    const totals = [cfg.points.win + cfg.points.loss, cfg.points.draw * 2];
    if (cfg.points.shootoutWin !== undefined && cfg.points.shootoutLoss !== undefined) {
      totals.push(cfg.points.shootoutWin + cfg.points.shootoutLoss);
    }
    return [...new Set(totals)];
  },

  // doc 14 §2 — Tier 1 = bare goals/periods (final score); Tier 2/3 = the
  // attributed timeline (scorers, minutes, cards, subs), Pro-gated.
  fidelityTiers: [
    { tier: 0, eventTypes: ["football.goal", "football.period", "football.shootout.kick"] },
    { tier: 1, eventTypes: ["football.goal", "football.period", "football.shootout.kick"] },
    {
      tier: 2,
      eventTypes: [
        "football.goal",
        "football.card",
        "football.sub",
        "football.period",
        "football.shootout.kick",
        // W4 — neither moves the score, so both stay out of tiers 0/1.
        "football.penalty",
        "football.sinbin.start",
        "football.sinbin.end",
      ],
      entitlement: "scoring.match_timeline",
    },
    {
      tier: 3,
      eventTypes: [
        "football.goal",
        "football.card",
        "football.sub",
        "football.period",
        "football.shootout.kick",
        "football.penalty",
        "football.sinbin.start",
        "football.sinbin.end",
        // S8/#417 W6 — band-3-only, per padSpec's `fidelity` map above.
        "football.shot",
      ],
      entitlement: "scoring.match_timeline",
    },
  ],
  officialLabel: { scorer: "Referee" }, // doc 13 §1
  // Jul3/07 §3 — goals/assists auto (16 Apr), points = goals + assists
  // (hockey-style), cards. Own goals never credit the striker.
  playerStats: {
    metrics: [
      {
        key: "goals", label: "Goals", from: "football.goal", field: "scorer", agg: "count",
        when: (p) => p.ownGoal !== true,
      },
      { key: "assists", label: "Assists", from: "football.goal", field: "assist", agg: "count" },
      {
        key: "yellow_cards", label: "Yellow cards", from: "football.card", field: "person",
        agg: "count", when: (p) => p.color === "yellow" || p.color === "second_yellow",
      },
      {
        key: "red_cards", label: "Red cards", from: "football.card", field: "person",
        agg: "count", when: (p) => p.color === "red" || p.color === "second_yellow",
      },
      // W4 — the facts the new branches make countable. `penalty_goals` is a
      // subset of `goals`, so `points` (goals + assists) is unchanged.
      {
        key: "penalty_goals", label: "Penalty goals", from: "football.goal", field: "scorer",
        agg: "count", when: (p) => p.penalty === true && p.ownGoal !== true,
      },
      {
        key: "penalties_missed", label: "Penalties missed", from: "football.penalty",
        field: "taker", agg: "count",
      },
      // The personal column only — the goal itself was already credited to the
      // opponent by the fold, so `points` (goals + assists) is unchanged.
      {
        key: "own_goals", label: "Own goals", from: "football.goal", field: "scorer",
        agg: "count", when: (p) => p.ownGoal === true,
      },
      {
        // The START event alone: the end is the player coming back, not a
        // second sanction. The pair makes that structural — no `when` guard.
        key: "sin_bins", label: "Sin bins", from: "football.sinbin.start", field: "person",
        agg: "count",
      },
      // S8/#417 W6 — the shooter's own tally from `football.shot`.
      // `shots_faced`/`saves`/`save_percentage` are the keeper side of this
      // same event and come from `footballKeeperStatsFold`'s `folded` escape
      // hatch below (they need the on-ice spell fold); this shooter-side
      // half is a plain metric because `taker` is an explicit payload field
      // with no spell resolution needed.
      { key: "shots", label: "Shots", from: "football.shot", field: "taker", agg: "count" },
      {
        key: "shots_on_target", label: "Shots on target", from: "football.shot", field: "taker",
        agg: "count", when: (p) => p.outcome === "scored" || p.outcome === "saved",
      },
    ],
    derived: [
      { key: "points", label: "Points", derive: (s) => (s.goals ?? 0) + (s.assists ?? 0) },
    ],
    awards: [{ key: "motm", label: "Man of the Match" }],
    // S8/#417 — `goals_conceded`, `clean_sheets`. See `footballKeeperStatsFold`
    // above for the mechanism (reads the fold of `core.lineup.*`, never the
    // kickoff sheet) and the documented clean-sheet rule.
    // S8/#417 W6 — `saves`, `shots_faced`, `save_percentage` now ARE
    // declared, fed by `football.shot` — see `footballKeeperStatsFold`'s own
    // W6 addition above.
    folded: {
      keys: ["goals_conceded", "clean_sheets", "saves", "shots_faced", "save_percentage"],
      fold: footballKeeperStatsFold,
    },
  },

  // SPEC-1 — read-only card projection over the ledger (voids un-count, spec
  // 03 §2). Colours are the FA card grades; the discipline usecase folds these
  // into per-division suspensions. Zero effect on the reducer or golden files.
  discipline: {
    colors: [
      { key: "yellow", label: "Yellow card" },
      { key: "second_yellow", label: "Second yellow" },
      { key: "red", label: "Red card" },
      // W4 — a temporary dismissal is a sanction, not a card grade, but the
      // projection has exactly one axis and the rules editor prices sanctions
      // off it. The period kernel already does this: its "colours" are the
      // suspension CLASS keys (minor/major/misconduct), not card colours.
      { key: "sin_bin", label: "Sin bin" },
    ],
    extractCards(ledger): DisciplineCard[] {
      const cards: DisciplineCard[] = [];
      for (const ev of resolveVoids(ledger)) {
        // W4 review item 6 — a sin bin removes a player from the pitch and
        // carries the same Law 12 `reason` a card does, so an accumulation
        // rule ("three dissents in a season") has to see it. Filtering on
        // `football.card` alone made it invisible to the discipline usecase,
        // while every period-kernel sport projected its own suspension.
        if (ev.type === "football.sinbin.start") {
          const parsed = FootballSinBinStart.safeParse(ev.payload);
          // Only the START: the end event is the player coming back, not a
          // second sanction — projecting it would double every bin.
          if (!parsed.success) continue;
          const bin = parsed.data;
          cards.push({
            ...(bin.person === undefined ? {} : { personId: bin.person }),
            entrantSide: bin.by,
            color: "sin_bin",
            eventId: ev.id,
            ...(bin.reason === undefined ? {} : { reason: bin.reason }),
            // S4 (#428) — the length the scorer actually recorded (else the
            // sin bin runs on `cfg.sinBinMinutes`, which extractCards has no
            // cfg to read); absent when the scorer left it to the default.
            ...(bin.minutes === undefined ? {} : { minutes: bin.minutes }),
          });
          continue;
        }
        if (ev.type !== "football.card") continue;
        const parsed = FootballCard.safeParse(ev.payload);
        if (!parsed.success) continue;
        const card = parsed.data;
        cards.push({
          ...(card.person === undefined ? {} : { personId: card.person }),
          entrantSide: card.by,
          color: card.color,
          eventId: ev.id,
          // W4 — the Law 12 offence, when the referee recorded one. Football
          // has no bench penalties, so no card is ever served by a substitute:
          // `servedBy` stays absent for this sport.
          ...(card.reason === undefined ? {} : { reason: card.reason }),
        });
      }
      return cards;
    },
  },

  // spec 03 §6 — deterministic valid-event generator.
  arbitraryEvent(state, rng: Rng): ModuleEvent<FootballEv> | null {
    const sideId = (side: Side) => state.entrants[side];
    const randomSide = (): Side => (rng() < 0.5 ? "home" : "away");

    // W4a review — the generator STAMPS what it emits, so the conformance,
    // chaos, undo-sweep and (once extended) golden streams actually exercise
    // this wave's path: stamped payloads, the lazy sweep, the carry, the
    // boundary sweeps and `asOf`. Without it §9.6's coarse-equals-fine and every
    // appended stream stayed on the pre-wave path, and "the goldens are
    // byte-identical" was guaranteed by the generator's blind spot rather than
    // by the change being additive.
    //
    // The claimed reason for leaving it out — that an extra rng draw would shift
    // every generated stream — does not hold: `testkit/golden.ts` records the
    // corpus as actual `{type, payload}` objects and replays THOSE
    // (`recomputeStream` never calls this function), and `extendCorpus` copies
    // existing streams through untouched and only appends.
    //
    // Derived from `state.asOf`, never drawn. Two reasons, both load-bearing: a
    // draw would perturb every existing generated walk for no benefit, and the
    // stamp MUST be monotonic or the fold kernel's guard reds the run with
    // NON_MONOTONIC_TIME for entirely the wrong reason. One minute of game time
    // per event, restarting at the top of each phase — the phase index carries
    // the ordering across every boundary.
    const stamp = (phase: string): GameTime => ({
      period: phase,
      elapsed: (state.asOf?.period === phase ? state.asOf.elapsed : 0) + 60,
    });

    if (state.phase === "pre") {
      // Pre-kickoff card (football.md §9) — at most one, to a clean player.
      if (rng() >= 0.9 && state.cards.length === 0) {
        const side = randomSide();
        const person = state.squads[side].onPitch[0];
        if (person !== undefined) {
          return {
            type: "football.card",
            payload: { by: sideId(side), person, color: "yellow", at: stamp("pre") },
          };
        }
      }
      return { type: "core.start", payload: {} };
    }

    if (state.phase === "SHOOTOUT" && state.shootout) {
      const expected = expectedKicker(state.shootout.kicks) ?? randomSide();
      return {
        type: "football.shootout.kick",
        payload: { by: sideId(expected), scored: rng() < 0.75, at: stamp("SHOOTOUT") },
      };
    }

    if (!isPlayPhase(state.phase)) return null; // done / final / abandoned

    const roll = rng();
    if (roll < 0.02) {
      return { type: "core.forfeit", payload: { by: sideId(randomSide()), reason: "walkover" } };
    }
    if (roll < 0.04) return { type: "core.abandon", payload: { reason: "weather" } };
    if (roll < 0.14) {
      // Card to a random on-pitch player without a prior yellow (or anonymous).
      const side = randomSide();
      const squad = state.squads[side];
      const carded = new Set(
        state.cards.filter((card) => card.person !== undefined).map((card) => card.person),
      );
      const eligible = squad.onPitch.filter((person) => !carded.has(person));
      const person = eligible[Math.floor(rng() * eligible.length)];
      if (person === undefined || rng() < 0.3) {
        return {
          type: "football.card",
          payload: { by: sideId(side), color: "yellow", at: stamp(state.phase) },
        };
      }
      const color = rng() < 0.85 ? "yellow" : "red";
      return {
        type: "football.card",
        payload: { by: sideId(side), person, color, at: stamp(state.phase) },
      };
    }
    if (roll < 0.155) {
      // W4 (Law 12 addendum) — a temporary dismissal, or the return that ends
      // one. Returning is preferred whenever anybody is serving, so the pitch
      // does not drain over a long generated stream.
      const side = randomSide();
      const bin = state.squads[side].sinBin ?? [];
      const serving = bin[Math.floor(rng() * bin.length)];
      if (serving !== undefined && rng() < 0.6) {
        return {
          type: "football.sinbin.end",
          payload: {
            by: sideId(side),
            ...(serving.person === undefined ? {} : { person: serving.person }),
            at: stamp(state.phase),
          },
        };
      }
      const binned = new Set(bin.map((entry) => entry.person));
      const eligible = state.squads[side].onPitch.filter((person) => !binned.has(person));
      const person = eligible[Math.floor(rng() * eligible.length)];
      // `minutes` is carried explicitly rather than left to `Cfg.sinBinMinutes`,
      // which the golden and conformance configs do not set: without a declared
      // length nothing derives an expiry, and the generated streams would stamp
      // payloads while never once reaching the sweep or the carry.
      if (person !== undefined && eligible.length > 7) {
        return {
          type: "football.sinbin.start",
          payload: {
            by: sideId(side),
            person,
            reason: "dissent",
            minutes: 10,
            at: stamp(state.phase),
          },
        };
      }
      // Anonymous (coarse) dismissal — never moves the pitch, so cap how many
      // can pile up; otherwise fall through to the next branch.
      if (bin.length < 2) {
        return {
          type: "football.sinbin.start",
          payload: { by: sideId(side), minutes: 10, at: stamp(state.phase) },
        };
      }
    }
    if (roll < 0.17) {
      // W4 (Law 14) — an open-play penalty that was not converted. The
      // goalkeeper is the defending side's first player still on the pitch,
      // which is the catalog's GK slot in the conformance lineups.
      const side = randomSide();
      const taker = state.squads[side].onPitch[Math.floor(rng() * state.squads[side].onPitch.length)];
      const goalkeeper = rng() < 0.5 ? state.squads[opponent(side)].onPitch[0] : undefined;
      const outcomes = PenaltyOutcome.options;
      const outcome = outcomes[Math.floor(rng() * outcomes.length)] ?? "saved";
      // S4 (#428) — SOMETIMES, same idiom as goalkeeper/minute above: a
      // seeded walk has to actually witness this field for the golden
      // coverage gate to consider it protected (golden.test.ts).
      const offences = PenaltyOffence.options;
      const offence = rng() < 0.5 ? offences[Math.floor(rng() * offences.length)] : undefined;
      return {
        type: "football.penalty",
        payload: {
          by: sideId(side),
          ...(taker === undefined ? {} : { taker }),
          ...(goalkeeper === undefined ? {} : { goalkeeper }),
          outcome,
          ...(offence === undefined ? {} : { offence }),
          at: stamp(state.phase),
        },
      };
    }
    if (roll < 0.19) {
      const side = randomSide();
      const squad = state.squads[side];
      const on = squad.bench[Math.floor(rng() * squad.bench.length)];
      const off = squad.onPitch[Math.floor(rng() * squad.onPitch.length)];
      if (on !== undefined && off !== undefined) {
        return {
          type: "football.sub",
          payload: { by: sideId(side), off, on, at: stamp(state.phase) },
        };
      }
      // No bench (conformance lineups) — fall through to a goal instead.
    }
    if (roll < 0.25) {
      // S8/#417 W6 — a shot. Taker/goalkeeper mirror the penalty branch
      // above (taker from the shooting side's pitch, goalkeeper the
      // defending side's first player), which is already legal for
      // `applyShot`'s own on-pitch validation.
      const side = randomSide();
      const squad = state.squads[side];
      const taker =
        rng() < 0.6 ? squad.onPitch[Math.floor(rng() * squad.onPitch.length)] : undefined;
      const goalkeeper = rng() < 0.5 ? state.squads[opponent(side)].onPitch[0] : undefined;
      const outcomes = ShotOutcome.options;
      const outcome = outcomes[Math.floor(rng() * outcomes.length)] ?? "saved";
      return {
        type: "football.shot",
        payload: {
          by: sideId(side),
          ...(taker === undefined ? {} : { taker }),
          ...(goalkeeper === undefined ? {} : { goalkeeper }),
          outcome,
          at: stamp(state.phase),
        },
      };
    }
    if (roll < 0.72) {
      const side = randomSide();
      const ownGoal = rng() < 0.05;
      const squad = state.squads[side];
      const scorer =
        rng() < 0.5 ? squad.onPitch[Math.floor(rng() * squad.onPitch.length)] : undefined;
      const minute = rng() < 0.5 ? Math.floor(rng() * 130) : undefined;
      // W4a T10 follow-up — the two attribution facts a goal line carries that
      // this generator never wrote. Both SOMETIMES: an unassisted goal and a
      // goal from open play are the common cases, and the fold path for the
      // ABSENT field is the one every pre-W4 payload takes.
      //
      // The assisting player is drawn from the striking side's pitch, minus the
      // scorer — the same side the scorer is validated against (`applyGoal`),
      // and `assists` is the metric `assist` feeds. Only on a scored, non-own
      // goal: an own goal has no assist to credit, and naming one would put a
      // second player on a goal the fold credits to the opponent.
      const assistPool =
        scorer === undefined || ownGoal
          ? []
          : squad.onPitch.filter((person) => person !== scorer);
      const assist =
        assistPool.length > 0 && rng() < 0.35
          ? assistPool[Math.floor(rng() * assistPool.length)]
          : undefined;
      // An in-play penalty CONVERTED. `football.penalty` already generates the
      // kick that was not scored (its `outcome` covers saved/missed/post), so
      // the converted one only ever existed as a goal — and never once carried
      // the flag that says so, which is what `penalty_goals` counts.
      const penalty = !ownGoal && rng() < 0.12;
      return {
        type: "football.goal",
        payload: {
          by: sideId(side),
          ...(scorer === undefined ? {} : { scorer }),
          ...(assist === undefined ? {} : { assist }),
          ...(minute === undefined ? {} : { minute }),
          ...(ownGoal ? { ownGoal: true } : {}),
          ...(penalty ? { penalty: true } : {}),
          at: stamp(state.phase),
        },
      };
    }
    // Advance the clock. S5/#431 — `nextMarker` picks the quarters vocabulary
    // ("QT"/"HT"/"3QT"/"FT") under cfg.halves === 4, the halves vocabulary
    // otherwise; `state.phase` is narrowed to `PlayPhase` by the
    // `isPlayPhase` guard above.
    const marker = nextMarker(state.phase, state.cfg.halves === 4);
    // W4a T10 follow-up — Law 7 allowance for time lost, on SOME whistles. A
    // period closed dead on time carries none, and that absence is the shape
    // every pre-W4 marker has, so `stampAddedMinutes` needs both to be walked.
    const addedMinutes = rng() < 0.5 ? Math.floor(rng() * 7) : undefined;
    return {
      type: "football.period",
      payload: {
        phase: marker,
        ...(addedMinutes === undefined ? {} : { addedMinutes }),
        at: stamp(state.phase),
      },
    };
  },

  // §9.6 / PROMPT-04 §9 — timeline → period summaries: strip attribution
  // (scorers, minutes, kick takers) keeping only what moves the score, drop
  // cards/subs (no score effect). Core events pass through.
  coarsen(events): ModuleEvent<FootballEv>[] {
    const out: ModuleEvent<FootballEv>[] = [];
    for (const event of events) {
      switch (event.type) {
        case "football.goal": {
          const payload = event.payload as z.infer<typeof FootballGoal>;
          out.push({
            type: "football.goal",
            payload: {
              by: payload.by,
              ...(payload.ownGoal === undefined ? {} : { ownGoal: payload.ownGoal }),
            },
          });
          break;
        }
        case "football.period":
          out.push({ type: "football.period", payload: event.payload });
          break;
        case "football.shootout.kick": {
          const payload = event.payload as z.infer<typeof FootballShootoutKick>;
          out.push({
            type: "football.shootout.kick",
            payload: { by: payload.by, scored: payload.scored },
          });
          break;
        }
        case "football.card":
        case "football.sub":
        case "football.penalty":
        case "football.sinbin.start":
        case "football.sinbin.end":
        case "football.shot": // S8/#417 W6 — never moves state.goals, same arm
          break; // no score effect — dropped at coarse fidelity
        default:
          out.push({ type: event.type, payload: event.payload });
      }
    }
    return out;
  },
};
