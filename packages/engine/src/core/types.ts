// Shared primitives — spec 03 §3 (MatchOutcome, ScoreSummary, StandingsDelta,
// MetricSpec, StageCtx), spec 02 §2/§3/§5 (entrants, lineups, stage kinds).
// Zod schemas first, inferred types second (conventions PROMPT-00 §3).
import { z } from "zod";

import type { EventEnvelope } from "./events.ts";

// spec 02 §2 — the competition engine pairs/ranks entrants and never cares
// what's inside them (team | individual | pair).
export const EntrantId = z.string().min(1);
export type EntrantId = z.infer<typeof EntrantId>;

// SPEC-1 (discipline) — an entrant identifier: the fixture side a card was
// shown to (a card event's `by`). Named for how it reads on a card record.
export type Side = EntrantId;

// W4 review item 2 — how a single attempt at goal finished, shared by every
// module that records one: football's open-play penalty (Law 14), the period
// kernel's set piece (FIH penalty corner / stroke, IIHF penalty shot). The
// wave shipped two shapes for this one fact — `outcome: saved|missed|post` and
// `converted: boolean` — and a boolean cannot express "hit the post", so the
// enum wins and the boolean's true case becomes the token `scored`.
//
// A module NARROWS this to the tokens its own branch may carry (football's
// penalty branch excludes `scored`, because a converted penalty is already a
// goal event and would otherwise be counted twice). The vocabulary is shared
// so a pad renders ONE result control; the allowed subset is the sport's, the
// same way each sport keeps its own sanction ladder.
export const AttemptOutcome = z.enum(["scored", "saved", "missed", "post"]);
export type AttemptOutcome = z.infer<typeof AttemptOutcome>;

// SPEC-1 — a card projected from a fixture ledger, the read-only input to the
// discipline fold (usecases/discipline.ts). Additive projection, same layer as
// playerStats: zero reducer/replay/golden impact (D2). Anonymous cards
// (personId undefined) are returned but never accumulate downstream.
export interface DisciplineCard {
  personId?: string;
  // INVARIANT (W4 review) — the OFFENDER's side: the side the sanction was
  // shown to, never the side whose score moved because of it. When `personId`
  // is present it MUST be a member of `entrantSide`; a producer that cannot
  // reconcile the two omits `personId` rather than assert it against the wrong
  // side. Every producer that names a `by` (football's card and sin bin, the
  // period kernel's suspension, the set-based and nested sanctions) satisfies
  // this by construction; carrom, whose payload names the side CREDITED by a
  // Laws 51/55 penalty, resolves the offender before projecting. Downstream
  // groups cards by side, so a card filed under the opponent is a card shown
  // to the wrong team.
  entrantSide: Side;
  color: string; // module-declared key, e.g. "yellow" | "red"
  eventId: string;
  // W4 (#407) — the offence as the official called it: football's Law 12
  // category ("dissent", "violent_conduct"), an IIHF infraction code, an FIH
  // umpire's note. The suspension tariff downstream is a function of THIS as
  // much as of the colour — a second caution and violent conduct are both red
  // cards and carry different bans — and an accumulation rule like "three
  // cards for dissent" cannot be written without it. Optional everywhere:
  // coarse scoring records a colour and nothing else.
  reason?: string;
  // W4 (#407) — the person who SERVES the sanction when that is not the person
  // penalised: an IIHF bench minor or goalkeeper penalty (Rule 33), an FIH card
  // shown to a team official. Absent ⇒ `personId` serves it himself. Without
  // this, a bench minor accumulates against whoever happens to sit in
  // `personId`, which is the wrong player.
  servedBy?: string;
  // S4 (#428) — the AWARDED length of a timed sanction, in minutes. W4 ruled
  // this out of that pass's scope; a duration-keyed accumulation rule ("any
  // 10-minute misconduct counts double") needs it. PLUMBING, not new design:
  // `PeriodSuspensionStart.minutes` and `FootballSinBinStart.minutes` (the
  // W4a §5.2 duration model) already carry this value and are already read by
  // each sport's own fold (`suspensions.ts`'s `SuspensionDetail.minutes`,
  // football's sin-bin expiry) — `extractCards()` only has to copy it across,
  // same optional/absent-when-uncoarse shape as `reason`.
  minutes?: number;
}

// SPEC-1 — the optional sport-module discipline descriptor: which colours the
// rules editor may offer, and how to extract cards from a ledger (voids
// respected inside extractCards).
export interface DisciplineModel {
  colors: { key: string; label: string }[];
  extractCards(ledger: EventEnvelope[]): DisciplineCard[];
}

// spec 02 §5 — a division's format is an ordered list of stages.
// L3/#414 — americano/ladder/page_playoff close a type-vs-schema drift, not a
// new capability: the DB has allowed all three since
// db/migration/deltas/V298__page_playoff_stage_kind.sql. `TableStage` (spec
// 05, competition/stage.ts) still only accepts league|group|swiss — americano
// is adapted onto a league table elsewhere; ladder has no table/bracket shape
// of its own (its finish order is `config.ladder_order`, apps/web).
export const StageKind = z.enum([
  "league",
  "group",
  "swiss",
  "knockout",
  "double_elim",
  "stepladder",
  "americano",
  "ladder",
  "page_playoff",
]);
export type StageKind = z.infer<typeof StageKind>;

// spec 03 §3 — context the sport module receives when computing standings
// deltas (knockout football forbids draws; group cricket shares points, …).
export const StageCtx = z.object({
  kind: StageKind,
  poolId: z.string().min(1).optional(),
  roundNo: z.number().int().positive().optional(),
});
export type StageCtx = z.infer<typeof StageCtx>;

// spec 03 §3 — all five kinds. `tie` (cricket) ≠ `draw`: different points in
// some competitions. `award` covers forfeit/DQ with an awarded score.
export const MatchOutcome = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("win"),
    winner: EntrantId,
    loser: EntrantId,
    // 'regulation' | 'extra_time' | 'shootout' | 'super_over' | 'dls' |
    // 'walkover' | 'timeout' — sport modules may extend, so plain string.
    method: z.string().min(1).optional(),
  }),
  z.object({ kind: z.literal("draw") }),
  z.object({ kind: z.literal("tie") }),
  z.object({ kind: z.literal("no_result") }),
  z.object({
    kind: z.literal("award"),
    winner: EntrantId,
    score: z.unknown().optional(),
  }),
]);
export type MatchOutcome = z.infer<typeof MatchOutcome>;

// spec 03 §3 — structured, render-agnostic: UI and public API render it
// without knowing the sport.
export const SideSummary = z.object({
  entrantId: EntrantId,
  line: z.string(), // '252/8 (50)', '3–1', '2½'
});
export type SideSummary = z.infer<typeof SideSummary>;

export const ScoreSummary = z.object({
  headline: z.string(), // '252/8 (50) — 253/4 (48.2)'
  perSide: z.array(SideSummary),
  detail: z.unknown().optional(), // sport-specific breakdown
});
export type ScoreSummary = z.infer<typeof ScoreSummary>;

// spec 02 §7 — additive contribution of one decided fixture to a StandingsRow;
// the competition engine folds deltas and ranks via the tiebreaker cascade.
export const StandingsDelta = z.object({
  entrantId: EntrantId,
  played: z.number().int().nonnegative(),
  won: z.number().int().nonnegative(),
  drawn: z.number().int().nonnegative(),
  lost: z.number().int().nonnegative(),
  points: z.number(),
  // sport ledger contributions: gf/ga · runs_for/overs_faced · sets_won …
  metrics: z.record(z.string(), z.number()),
});
export type StandingsDelta = z.infer<typeof StandingsDelta>;

// spec 03 §3 — declares a ledger field the sport maintains (gd, nrr,
// set_ratio…) so the standings UI and tiebreaker cascade can consume it.
export const MetricSpec = z.object({
  key: z.string().min(1), // 'gd', 'nrr', 'set_ratio'
  label: z.string().min(1), // 'Goal difference'
  direction: z.enum(["desc", "asc"]), // desc = higher is better
  decimals: z.number().int().nonnegative().optional(), // display precision
  // false = internal ledger field (NRR operands, card counts) — the standings
  // UI hides it (doc 09 §2: sport-correct tables with zero per-sport UI code).
  // Absent/true = shown as a column, in declaration order.
  display: z.boolean().optional(),
});
export type MetricSpec = z.infer<typeof MetricSpec>;

// spec 02 §3 — person selected for a specific fixture. orderNo = batting
// order in cricket, board order in team chess.
export const LineupSlot = z.object({
  personId: z.string().min(1),
  positionKey: z.string().min(1).optional(),
  slot: z.enum(["starting", "bench"]),
  orderNo: z.number().int().positive(),
  // Role keys from the sport's PositionCatalog (captain, wicketkeeper, …).
  // PROMPT-03 deviation: doc 02 §3 kept roles on RosterEntry only, but
  // validateLineup (spec 02 §3 "unique roles") checks them per fixture, so
  // the lineup carries the fixture-specific assignment.
  roles: z.array(z.string().min(1)).optional(),
  // W4 (#407) — the squad number this person wears in THIS fixture.
  // `entrantModel.team.squadNumbers` (src/sport/entrant-model.ts) already
  // advertised the affordance, but the number itself had nowhere to live, so
  // team sheets, scoresheets and match reports could not print it.
  // NAMED `squadNumber`, not `shirtNumber`: the roster path got there first and
  // one concept must not carry two names across the engine. Fixture-scoped
  // rather than roster-scoped for the same reason `roles` is: numbers are
  // reassigned between matches. Optional everywhere — sports without squad
  // numbers simply omit it, and every lineup written before W4 stays valid.
  // 0 is a legal number.
  squadNumber: z.number().int().nonnegative().optional(),
  // S3/W4b (#426) OWNER RULING 3 — a team official is a ROLE on the slot, not a
  // separate collection. A coach can be cautioned, sent off and suspended, so
  // he has to be nameable on the team sheet; but he never plays, so `role`
  // rather than a parallel `officials: []` keeps one identity per person and
  // lets `core/lineup.ts` filter every playing projection on one field.
  //
  // OPTIONAL WITH NO `.default()`, deliberately. A `.default()` would rewrite
  // every parsed slot in the system to carry `role: "player"`, which is a
  // change to recorded lineups for a field nothing had asked for; `initSquads`
  // applies the default once, where it is read. Absent ⇒ `player`.
  //
  // Carried caveat (S4, #428): `persons.lane` is `check (lane in
  // ('player','official'))` where `'official'` means a MATCH official, so a
  // team coach has no DB lane yet. Engine-side only until S4 extends it.
  role: z.enum(["player", "coach", "staff"]).optional(),
  // S3/W4b (#426) — declared order WITHIN a pair (1 = first-named), for the
  // doubles disciplines. `orderNo` cannot carry it: that is the team-sheet
  // order across the whole squad, and a five-pair table-tennis tie has five
  // first-named players. Recorded because it is DECLARED, not derivable — the
  // racquet dossiers marked it `deferred` for exactly the lack of a field.
  // Sports read it in pass B; the engine only has to stop discarding it.
  pairOrder: z.number().int().positive().optional(),
});
export type LineupSlot = z.infer<typeof LineupSlot>;

export const Lineup = z.object({
  entrantId: EntrantId,
  slots: z.array(LineupSlot),
});
export type Lineup = z.infer<typeof Lineup>;

// spec 03 §3 — SportModule.init(cfg, lineups: LineupPair).
export const LineupPair = z.object({
  home: Lineup,
  away: Lineup,
});
export type LineupPair = z.infer<typeof LineupPair>;
