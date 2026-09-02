// PackSchema — the committed shape of `scripts/bench/packs/<suite>.json`.
//
// A pack describes ONE real historical tournament: who played, what happened
// event by event, and what the real world's answer was. The bench seeds it
// into the product over HTTP, replays the events through the real scoring
// API, and asserts the product's DERIVED answers equal history's.
//
// **This is a public contract.** It FREEZES at the end of session B06; an
// additive change after that is escalated to the owner in a PR, never landed
// silently. `schemaVersion` below is the visible handle on that: a change to
// the shape bumps it, so a stale pack fails loudly instead of parsing into a
// different meaning.
//
// -------------------------------------------------------------------------
// The design decisions this file bakes in, and why
// -------------------------------------------------------------------------
//
// 1. THE ORACLE DIRECTION IS SACRED (bench `_RULES.md` §3). A pack carries
//    RAW EVENTS plus the real world's EXPECTED values. Nothing in this
//    schema lets an author write a derived outcome into the stream itself:
//    `streams[]` holds only what a scorer would have pressed, and
//    `expected{}` holds only what history recorded. The engine is what joins
//    them. Any future field that would let a pack state an outcome inside a
//    stream is a defect, not a shortcut.
//
// 2. `seq` IS NOT IN THE PACK. `EventEnvelope` (packages/engine/src/core/
//    events.ts:24) requires a gapless per-fixture `seq`, but BOTH product
//    write paths mint it themselves and neither accepts one from a caller:
//    the batch import synthesises `seq: i + 1` from the array index
//    (apps/web/src/server/usecases/event-import.ts:287-295), and the
//    single-event path takes an OPTIMISTIC `expected_seq` and 409s on a
//    mismatch (`AppendEventRequest`, api-v1/schemas.ts). A `seq` recorded in
//    the pack would therefore be a SECOND source of truth for the same fact
//    as array order, free to drift from it silently. So: **array order IS
//    the sequence**, and any consumer that needs envelopes mints
//    `seq = index + 1` — the same numbering the import route uses, so the
//    offline fold and the HTTP path can never disagree about event identity.
//    Same reasoning removes `id`, `fixtureId` and `recordedBy`: all three are
//    minted at seed time and mean nothing before the org exists.
//
// 3. A DIVISION PINS AN EXACT MODULE VERSION (`moduleVersion`). `variantKey`
//    does NOT resolve a module — a variant is a named cfg PRESET
//    (`variants: Record<string, Partial<Cfg>>`, packages/engine/src/sport/
//    module.ts:417) merged into base cfg and then parsed by `configSchema`
//    (module.ts:357); the merge precedent is `configsFor` in
//    packages/engine/src/testkit/golden.ts:147. Module resolution is a
//    separate lookup — `registry.get(key, version)` (packages/engine/src/
//    sport/registry.ts:62-71) is an EXACT string match that throws
//    `MODULE_NOT_FOUND`. Engine modules pin exact versions, so a pack that
//    does not record the version its expected values were validated against
//    is not reproducible: a module bump would silently re-fold the same
//    events into different answers. The field is named for the product's own
//    column — `divisions.module_version` ("PINNED engine module version",
//    db/migration/v2-engine/tables/V209__divisions.sql:10) — so a reader
//    mapping pack to row does no translation. The precedent for a recorded
//    artifact pinning its module version is the golden corpus
//    (testkit/golden.ts's `version`).
//
// 4. `ext_key` IS A FIXTURE KEY AND NOTHING ELSE. It exists on exactly one
//    table — `fixtures` (V214__fixtures.sql:31, partial unique index on
//    `(stage_id, ext_key)` at :32-33) — and on no other: `entrants`,
//    `persons` and `entrant_members` have no such column anywhere in the
//    migration tree. So fixtures join by `ext_key`, and everything else in a
//    pack uses a **pack-local `ref`** that the B03 seeding layer resolves to
//    a real UUID through a returned map. The two are deliberately different
//    types with different names; calling a person key `ext_key` would invent
//    a join that the database cannot perform.
//
// 5. A PACK'S ext_key IS UNIQUE PER DIVISION — stricter than the DB's index.
//    `resolveFixture` looks a fixture up by `division_id + ext_key`
//    (usecases/event-import.ts:171-174) while the unique index is per
//    `stage_id`, so a division with two stages can legally hold two fixtures
//    with the same `ext_key` and the resolver silently takes `rows[0]`. That
//    ambiguity is invisible at runtime and would bind a stream to the wrong
//    fixture. The schema closes it for bench packs.
//
// 6. A PAYLOAD REF IS SIGILLED `@`. Event payloads name entrants and people
//    — `generic.score.by` is an `EntrantId`, `core.forfeit.by` is an
//    `EntrantId`, football's goal payloads carry person ids. At authoring
//    time those UUIDs do not exist yet. Rather than teach the seeding layer
//    a per-sport table of which payload fields hold ids (eleven modules, and
//    a new one every wave), a pack writes them as `"@<ref>"` and the seeding
//    layer rewrites every `@`-prefixed string in a payload. The sigil is
//    checked HERE: an `@`-string that resolves to no declared entrant or
//    person is a parse error naming the event. There is deliberately NO
//    escape for a literal leading `@` — a real payload that needs one is an
//    owner escalation, which is louder and safer than a rewrite rule that
//    can silently eat data.
//
//    OFFLINE there is nothing to rewrite: a validator folding a stream in
//    process can use the sigilled string `"@<ref>"` AS the entrant/person id
//    (`lineups.home.entrantId = "@e-alpha"`), so the same bytes fold without
//    a substitution pass. An expected-block ref is bare (`"e-alpha"`), so the
//    comparison is against `"@" + ref`.
//
// 7. A SPECIAL IS A CLAIM ABOUT THE FOLD, NEVER ABOUT THE EVENT LOG. Of the
//    nine special mechanics the bench must prove, only five have an event
//    type of their own — `cricket.superover.ball` (sports/cricket/
//    cricket.ts:365), `cricket.revise` (:371), the three shootout literals
//    (`football.shootout.kick`, football.ts:441, and `${preset.key}
//    .shootout.attempt` built at sports/period/kernel.ts:1827, i.e.
//    `hockey.` / `icehockey.shootout.attempt`), `${key}.expedite.start`
//    (sports/setbased/kernel.ts:1078) and `boardgame.result`
//    (sports/boardgame/boardgame.ts:378). The other four are DERIVED STATE
//    with no event type at all: an overtime golden goal / GWS is a `method`
//    on the outcome (sports/period/kernel.ts:986-1017), a final-set tiebreak
//    is a cfg shape folded into state (sports/nested/kernel.ts:853), a
//    retirement is the CORE type `core.forfeit` (nested/kernel.ts) or
//    `core.lineup.retirement` (core/events.ts's lineup family) — note that
//    `cricket.retire` is a BATTER retirement under Law 25.4 and a different
//    concept entirely — and a concussion substitute has no dedicated type at
//    all: it is a generic `core.lineup.replacement` charged to the named
//    exemption string `"concussion"` (core/lineup.ts's `LineupExemption`).
//    A specials block that said "this event type appears" could therefore
//    express barely half of them, and would assert the wrong thing about the
//    rest — half-points, for instance, are the SCORING MODEL (boardgame.ts:
//    38-46, points stored doubled: win 2, draw 1, loss 0), not an event. So
//    `PackClaim` asserts against the folded `MatchOutcome`, the module's
//    folded State, or the derived standings row.
//
// 8. VOCABULARIES ARE IMPORTED, NOT RESTATED, wherever the engine ships a
//    runtime value: `StageKind` is imported from `@seazn/engine/core`. Where
//    the engine ships only a TYPE (`TiebreakerKey`), the list is written out
//    once and pinned to the engine's type by a compile-time exhaustiveness
//    check below — so a new key in the engine reds `tsc`, and the two lists
//    cannot drift apart in either direction.
//
// Runtime constraints (B02 GLOBAL.md): no TS `enum`, no `namespace`, no
// emit-dependent syntax — this file is read by `node
// --experimental-strip-types`. Every relative import carries `.ts`.
import { z } from "zod";
import { StageKind, type MatchOutcome } from "@seazn/engine/core";
import type { TiebreakerKey } from "@seazn/engine/sport";

// ---------------------------------------------------------------------------
// Primitives
// ---------------------------------------------------------------------------

/** Any JSON value. A pack IS a JSON file, so this is the honest type for the
 *  opaque passthrough fields (cfg overrides, stage config, event payloads) —
 *  `z.unknown()` would also accept values JSON cannot represent. */
export type PackJsonValue =
  | string
  | number
  | boolean
  | null
  | PackJsonValue[]
  | { [key: string]: PackJsonValue };

export const PackJsonValue: z.ZodType<PackJsonValue> = z.lazy(() =>
  z.union([
    z.string(),
    z.number(),
    z.boolean(),
    z.null(),
    z.array(PackJsonValue),
    z.record(z.string(), PackJsonValue),
  ]),
);

/** A pack-LOCAL identifier. Deliberately NOT called `ext_key` (see header
 *  note 4): `ext_key` is a fixture column and a pack ref is not stored
 *  anywhere — the seeding layer resolves it to a UUID and hands back a map. */
export const PackRef = z
  .string()
  .min(1)
  .max(120)
  .regex(/^[A-Za-z0-9][A-Za-z0-9_.:-]*$/, "a pack ref is [A-Za-z0-9][A-Za-z0-9_.:-]*");

/** A real `fixtures.ext_key` (V214__fixtures.sql:31). Bounds match the
 *  product's own `EventImportRequest.streams[].fixture.ext_key`. */
export const PackExtKey = z.string().min(1).max(200);

/** Exact semver — `registry.get` is an exact string match, so a range would
 *  be a lie about what was validated. */
export const PackModuleVersion = z
  .string()
  .regex(/^\d+\.\d+\.\d+$/, "moduleVersion must be an exact semver, e.g. 1.0.0");

/** `persons.lane` — the CHECK constraint's four values
 *  (db/migration/deltas/V356__persons_lane_coach_staff.sql:43-44, widening
 *  V348's original two). */
export const PackPersonLane = z.enum(["player", "official", "coach", "staff"]);
export type PackPersonLane = z.infer<typeof PackPersonLane>;

/** `entrants.kind` (api-v1/schemas.ts's `EntrantKind`). */
export const PackEntrantKind = z.enum(["team", "individual", "pair"]);
export type PackEntrantKind = z.infer<typeof PackEntrantKind>;

/** Bench doctrine (`_RULES.md` §3, GLOBAL.md): exactly two values, never
 *  disguised. A reconstructed stream flagged `"real"` is undetectable by
 *  code, so the only thing a validator can enforce is that the flag is
 *  PRESENT — which is why this has no default. */
export const PackProvenance = z.enum(["real", "reconstructed"]);
export type PackProvenance = z.infer<typeof PackProvenance>;

/** The 19 comparator keys the competition engine's tiebreaker registry
 *  resolves. Written out because the engine ships `TiebreakerKey` as a TYPE
 *  only (packages/engine/src/sport/module.ts:41) — there is no runtime array
 *  to import. `TIEBREAKER_KEYS_MATCH_THE_ENGINE` below makes the duplication
 *  safe: a key added or removed on either side reds `tsc`. */
export const TIEBREAKER_KEYS = [
  "points",
  "wins",
  "h2h_points",
  "h2h_diff",
  "h2h_for",
  "diff",
  "for",
  "nrr",
  "set_ratio",
  "game_ratio",
  "board_ratio",
  "point_ratio",
  "buchholz",
  "buchholz_cut1",
  "sberger",
  "direct",
  "fair_play",
  "seed",
  "lots",
] as const;

// Compile-time, BIDIRECTIONAL. Left as declarations rather than assertions in
// a test file on purpose: tsconfig.scripts.json:35 excludes `*.test.ts`, so a
// type-level guard written in a test is never checked by anything.
//   • no key here that the engine does not have  → the array is assignable
//   • no key the engine has that is missing here → the Exclude is `never`
type _TiebreakerKeysAreEngineKeys = (typeof TIEBREAKER_KEYS)[number] extends TiebreakerKey
  ? true
  : never;
type _TiebreakerKeysAreExhaustive = Exclude<
  TiebreakerKey,
  (typeof TIEBREAKER_KEYS)[number]
> extends never
  ? true
  : never;
// TWO consts rather than one intersection: in the passing case both sides are
// `true`, so `A & B` collapses and reads to eslint as a duplicated constituent
// — and, worse, gives one name to two independent facts, so a reader cannot
// tell which direction a red is about.
export const TIEBREAKER_KEYS_ARE_ENGINE_KEYS: _TiebreakerKeysAreEngineKeys = true;
export const TIEBREAKER_KEYS_ARE_EXHAUSTIVE: _TiebreakerKeysAreExhaustive = true;

export const PackTiebreakerKey = z.enum(TIEBREAKER_KEYS);

/** The nine special mechanics the bench must each prove on a real instance
 *  (design §8). A closed set so the report can tally coverage and Task 2's
 *  validator can dispatch; the ASSERTION lives in `claims` (header note 7). */
export const PackSpecialKind = z.enum([
  "super_over",
  "dls_revise",
  "shootout",
  "ot_gws",
  "final_set_tb",
  "expedite",
  "retirement",
  "concussion_sub",
  "draw_half_points",
]);
export type PackSpecialKind = z.infer<typeof PackSpecialKind>;

// ---------------------------------------------------------------------------
// Identity
// ---------------------------------------------------------------------------

export const PackOrg = z.strictObject({
  name: z.string().min(1).max(200),
  slug: z
    .string()
    .min(1)
    .max(80)
    .regex(/^[a-z0-9][a-z0-9-]*$/, "slug is lower-case kebab"),
  /** IANA zone the real tournament was played in. Not optional: every
   *  historical start time in `historicalAssignment` is meaningless without
   *  one, and "assume UTC" is how a certificate silently shifts by hours. */
  timezone: z.string().min(1).max(60).default("UTC"),
});
export type PackOrg = z.infer<typeof PackOrg>;

export const PackCompetition = z.strictObject({
  name: z.string().min(1).max(200),
  slug: z
    .string()
    .min(1)
    .max(80)
    .regex(/^[a-z0-9][a-z0-9-]*$/, "slug is lower-case kebab")
    .optional(),
  startsOn: z.iso.date().optional(),
  /** `CreateCompetition.ends_on` is MANDATORY on the product side (#376 — a
   *  null end date never crosses the date lock), so a pack that omits it
   *  could not be seeded. */
  endsOn: z.iso.date(),
  description: z.string().max(20_000).optional(),
});
export type PackCompetition = z.infer<typeof PackCompetition>;

// ---------------------------------------------------------------------------
// Divisions and stages
// ---------------------------------------------------------------------------

/** One real bracket slot. There is no `null`, no `"TBD"` branch and no
 *  placeholder shape: a pack records the bracket AS PLAYED, and `entrant`
 *  must resolve to a declared entrant of the same division. A TBD is
 *  therefore not merely discouraged — it is unrepresentable. */
export const PackBracketSlot = z.strictObject({
  /** The generator's own slot key where one exists (`wb-r0-g1`, `pp-final`),
   *  else any stable label the bracket map uses. */
  slot: z.string().min(1).max(200),
  entrant: PackRef,
});

export const PackStage = z.strictObject({
  ref: PackRef,
  seq: z.number().int().min(1),
  /** Imported from `@seazn/engine/core`, not restated. The engine union and
   *  the DB's `stages_kind_check` have been equal since V298 (bench design
   *  §11 risk 4). */
  kind: StageKind,
  name: z.string().min(1).max(200),
  /** Merged verbatim into `stages.config` — the same escape hatch
   *  `CreateStage.config` already is. Left opaque rather than re-declared:
   *  a second copy of the product's stage-config vocabulary is exactly how
   *  two shapes of one fact drift apart. */
  config: z.record(z.string(), PackJsonValue).default({}),
  /** Cross-stage progression, carried verbatim for the same reason as
   *  `config` — the authority is the product's `ProgressionSchema`. */
  progression: z.record(z.string(), PackJsonValue).optional(),
  /** The REAL historical seed order for this stage, as entrant refs. */
  seeding: z.array(PackRef).optional(),
  /** The REAL historical bracket, slot by slot. */
  bracket: z.array(PackBracketSlot).optional(),
});
export type PackStage = z.infer<typeof PackStage>;

export const PackDivision = z.strictObject({
  ref: PackRef,
  name: z.string().min(1).max(200),
  sportKey: z.string().min(1).max(60),
  /** A named cfg PRESET, not a module selector — see header note 3. */
  variantKey: z.string().min(1).max(60),
  /** The exact engine module version these expected values were validated
   *  against — see header note 3. */
  moduleVersion: PackModuleVersion,
  /** Merged over the variant preset and then parsed by the module's own
   *  `configSchema`, exactly as `createDivision` does. */
  cfgOverrides: z.record(z.string(), PackJsonValue).default({}),
  tiebreakers: z.array(PackTiebreakerKey).optional(),
  stages: z.array(PackStage).min(1),
});
export type PackDivision = z.infer<typeof PackDivision>;

// ---------------------------------------------------------------------------
// People, entrants, rosters
// ---------------------------------------------------------------------------

export const PackPerson = z.strictObject({
  ref: PackRef,
  fullName: z.string().min(1).max(200),
  lane: PackPersonLane,
  shortName: z.string().min(1).max(120).optional(),
  /** ISO-3166 alpha-3 where the real record gives one (squad lists are
   *  routinely published by nation). Display-only. */
  countryCode: z.string().length(3).optional(),
});
export type PackPerson = z.infer<typeof PackPerson>;

/** One `entrant_members` row (V213__entrant_members.sql). Field names track
 *  that table: `squad_number`, `default_position_key`, `is_captain`, `roles`.
 *  LIBERO IS A ROLE, not a boolean — `roles` is the jsonb array at :8, and
 *  the volleyball libero, a vice-captain and a designated keeper all live in
 *  it. A dedicated `libero` flag would need a sibling for every future role. */
export const PackRosterMember = z.strictObject({
  person: PackRef,
  squadNumber: z.number().int().min(0).max(999).optional(),
  positionKey: z.string().min(1).max(60).optional(),
  captain: z.boolean().default(false),
  roles: z.array(z.string().min(1).max(60)).default([]),
});
export type PackRosterMember = z.infer<typeof PackRosterMember>;

export const PackEntrant = z.strictObject({
  ref: PackRef,
  divisionRef: PackRef,
  kind: PackEntrantKind,
  displayName: z.string().min(1).max(200),
  /** The REAL seed where the tournament published one. Drives the round-robin
   *  pairing order (`seedOrder`, engine scheduling/roundrobin.ts) and hence
   *  which `ext_key` each meeting gets, so it is part of the join. */
  seed: z.number().int().min(1).optional(),
  roster: z.array(PackRosterMember).default([]),
});
export type PackEntrant = z.infer<typeof PackEntrant>;

// ---------------------------------------------------------------------------
// Streams
// ---------------------------------------------------------------------------

/** One authored event: the part a scorer actually supplies. No `seq`, `id`,
 *  `fixtureId` or `recordedBy` — see header note 2. Shape tracks the
 *  product's own `EventImportRequest.streams[].events[]`. */
export const PackEvent = z.strictObject({
  type: z
    .string()
    .min(1)
    .max(100)
    .refine((t) => t !== "core.void", {
      // Same refusal the batch import makes, and for the same reason: a void
      // is a LIVE-SCORING undo. A pack is authored history — a wrong pack is
      // corrected by editing the pack, never by shipping an undo of itself.
      message: "core.void cannot appear in a pack stream",
    }),
  payload: z.record(z.string(), PackJsonValue).default({}),
  /** The real instant this happened, when the record gives one. Lands in a
   *  `timestamptz`; the offline fold never reads it. Must carry an offset
   *  for the same reason the import route requires one. */
  at: z.iso.datetime({ offset: true }).optional(),
});
export type PackEvent = z.infer<typeof PackEvent>;

/** Present only on a GENERATED reconstructed stream. Task 3's generators are
 *  deterministic from a seed, and the seed lives in the pack so the same
 *  bytes come out on every machine and every run. A hand-authored
 *  reconstructed stream carries no seed — hence optional — but a `"real"`
 *  stream carrying one is a contradiction and is refused. */
export const PackReconstruction = z.strictObject({
  seed: z.number().int().nonnegative(),
  /** Free-form note on what the generator was asked to hit (the real set
   *  scores it folds to). Human-readable, never parsed. */
  note: z.string().min(1).max(500).optional(),
});
export type PackReconstruction = z.infer<typeof PackReconstruction>;

export const PackStream = z.strictObject({
  /** Which division's fixture this is. Required because `ext_key` is unique
   *  per division, not globally, and because the product's own resolver
   *  looks up `division_id + ext_key` (header notes 4 and 5). */
  divisionRef: PackRef,
  fixtureExtKey: PackExtKey,
  provenance: PackProvenance,
  reconstruction: PackReconstruction.optional(),
  events: z.array(PackEvent).min(1),
});
export type PackStream = z.infer<typeof PackStream>;

/** The feasibility-certificate input (design §6.3): where and when the real
 *  tournament actually played this fixture. `venue`/`court` are the REAL
 *  WORLD'S names, free text rather than pack refs, because a pack declares
 *  no venue entity — the certificate only needs identity-by-equality to spot
 *  a double-booking, and "Lord's Cricket Ground" is not ref-shaped. */
export const PackHistoricalAssignment = z.strictObject({
  divisionRef: PackRef,
  fixtureExtKey: PackExtKey,
  venue: z.string().min(1).max(200),
  court: z.string().min(1).max(200).optional(),
  startsAt: z.iso.datetime({ offset: true }),
  endsAt: z.iso.datetime({ offset: true }).optional(),
});
export type PackHistoricalAssignment = z.infer<typeof PackHistoricalAssignment>;

// ---------------------------------------------------------------------------
// The expected block — the oracles
// ---------------------------------------------------------------------------

/** Mirrors the engine's `MatchOutcome` (packages/engine/src/core/types.ts)
 *  with `EntrantId` replaced by a pack ref. `method` stays a plain string
 *  because the engine's is: modules extend it (`regulation`, `extra_time`,
 *  `shootout`, `super_over`, `dls`, `walkover`, `timeout`, …), and a closed
 *  copy here would reject the next sport that adds one. */
export const PackExpectedOutcome = z.discriminatedUnion("kind", [
  z.strictObject({
    kind: z.literal("win"),
    winner: PackRef,
    loser: PackRef,
    method: z.string().min(1).max(60).optional(),
  }),
  z.strictObject({ kind: z.literal("draw") }),
  z.strictObject({ kind: z.literal("tie") }),
  z.strictObject({ kind: z.literal("no_result") }),
  z.strictObject({
    kind: z.literal("award"),
    winner: PackRef,
    method: z.string().min(1).max(60).optional(),
  }),
]);
export type PackExpectedOutcome = z.infer<typeof PackExpectedOutcome>;

// Compile-time: the five outcome kinds here are exactly the engine's five. A
// sixth kind added to `MatchOutcome` reds `tsc` here rather than silently
// becoming inexpressible in every pack. Non-test file for the same reason as
// the tiebreaker check above.
type _OutcomeKindsAreExhaustive = Exclude<
  MatchOutcome["kind"],
  PackExpectedOutcome["kind"]
> extends never
  ? true
  : never;
type _OutcomeKindsAreEngineKinds = PackExpectedOutcome["kind"] extends MatchOutcome["kind"]
  ? true
  : never;
export const OUTCOME_KINDS_ARE_EXHAUSTIVE: _OutcomeKindsAreExhaustive = true;
export const OUTCOME_KINDS_ARE_ENGINE_KINDS: _OutcomeKindsAreEngineKinds = true;

/** One side's rendered score line, mirroring the engine's `SideSummary`. */
export const PackExpectedSideLine = z.strictObject({
  entrant: PackRef,
  line: z.string().min(1).max(200),
});

export const PackExpectedMatch = z.strictObject({
  divisionRef: PackRef,
  fixtureExtKey: PackExtKey,
  outcome: PackExpectedOutcome,
  /** The real scoreline as history rendered it, per side. Optional: a
   *  result-level sport has no line beyond the outcome itself. */
  perSide: z.array(PackExpectedSideLine).optional(),
});
export type PackExpectedMatch = z.infer<typeof PackExpectedMatch>;

/** One row of a final table. `rank` and array order carry the SAME fact —
 *  the exact tie order — and a refinement below forces them to agree, so a
 *  reordering of the array can never pass silently and a hand-edited `rank`
 *  can never contradict the order it sits in. */
export const PackExpectedTableRow = z.strictObject({
  entrant: PackRef,
  rank: z.number().int().min(1),
  played: z.number().int().nonnegative(),
  won: z.number().int().nonnegative(),
  drawn: z.number().int().nonnegative(),
  lost: z.number().int().nonnegative(),
  /** `z.number()`, not `z.number().int()`: the engine's `StandingsDelta.points`
   *  is a plain number, and boardgame stores half-points doubled while other
   *  competitions can award fractions. */
  points: z.number(),
  /** GD, NRR, buchholz, board ratio — the engine's `StandingsDelta.metrics`
   *  shape, `Record<string, number>`. NRR is fractional, hence not int. */
  metrics: z.record(z.string(), z.number()).optional(),
});

export const PackExpectedTable = z.strictObject({
  divisionRef: PackRef,
  stageRef: PackRef,
  /** Pool key (`"A"`, `"B"`, …) for a group stage's per-pool table. */
  poolKey: z.string().min(1).max(10).optional(),
  rows: z.array(PackExpectedTableRow).min(1),
});
export type PackExpectedTable = z.infer<typeof PackExpectedTable>;

export const PackExpectedChampion = z.strictObject({
  divisionRef: PackRef,
  entrant: PackRef,
});

/** Names AND counts, per design §8: asserting a count alone passes for the
 *  wrong player, and asserting a name alone passes for the wrong tally. */
export const PackExpectedLeaderboardEntry = z.strictObject({
  person: PackRef,
  /** The real person's name as history records it — asserted alongside the
   *  ref so a mis-wired ref map cannot silently produce a green leaderboard. */
  name: z.string().min(1).max(200),
  count: z.number(),
});

export const PackExpectedLeaderboard = z.strictObject({
  divisionRef: PackRef,
  /** A `SportModule.playerStats` metric key (`goals`, `wickets`, `points`, …).
   *  Free string: the vocabulary is per-module and open. */
  metricKey: z.string().min(1).max(60),
  entries: z.array(PackExpectedLeaderboardEntry).min(1),
});
export type PackExpectedLeaderboard = z.infer<typeof PackExpectedLeaderboard>;

/** The discipline carry-over oracle: the real suspended player, and exactly
 *  which fixture(s) they sat out. Both halves are the assertion — a
 *  suspension that names no missed fixture proves nothing about carry. */
export const PackExpectedSuspension = z.strictObject({
  divisionRef: PackRef,
  person: PackRef,
  missesFixtureExtKeys: z.array(PackExtKey).min(1),
  reason: z.string().min(1).max(200).optional(),
});
export type PackExpectedSuspension = z.infer<typeof PackExpectedSuspension>;

/** An assertion about what the ENGINE DERIVED — never about which event types
 *  appear in the stream. See header note 7 for why that distinction is the
 *  whole design of the specials block. */
export const PackClaim = z.discriminatedUnion("on", [
  /** The folded `MatchOutcome`. Every field optional so a claim can pin just
   *  the `method` (a shootout, an extra-time winner) or just the `kind` (a
   *  draw, a no-result) without over-asserting; at least one is required. */
  z
    .strictObject({
      on: z.literal("outcome"),
      kind: z.enum(["win", "draw", "tie", "no_result", "award"]).optional(),
      method: z.string().min(1).max(60).optional(),
      winner: PackRef.optional(),
      loser: PackRef.optional(),
    })
    .refine(
      (c) =>
        c.kind !== undefined ||
        c.method !== undefined ||
        c.winner !== undefined ||
        c.loser !== undefined,
      { message: "an outcome claim must assert at least one of kind/method/winner/loser" },
    ),
  /** A dotted path into the module's folded State, compared by deep equality.
   *  This is what makes the four event-type-less specials assertable:
   *  `revisedTarget` / `targetSource` for DLS, `expedite` for the ITTF
   *  expedite system, the nested kernel's final-set shape for a match
   *  tie-break. */
  z.strictObject({
    on: z.literal("state"),
    path: z
      .string()
      .min(1)
      .max(200)
      .regex(/^[A-Za-z_][A-Za-z0-9_]*(\.[A-Za-z0-9_]+)*$/, "a state path is dotted, e.g. sets.2.tiebreak"),
    equals: PackJsonValue,
  }),
  /** A number off the fold-derived standings row — how half-points are
   *  asserted (a boardgame draw is worth 1 of 2, not 0.5).
   *
   *  Scope: a special names ONE fixture, so a standings claim reads that
   *  fixture's own `StandingsDelta` (the module's `standingsDelta(...)` for
   *  this match), NOT the cumulative stage table — that is what
   *  `expected.tables` asserts, and conflating the two would make a claim
   *  mean different things in a one-round and a six-round stage. */
  z.strictObject({
    on: z.literal("standings"),
    entrant: PackRef,
    field: z.enum(["played", "won", "drawn", "lost", "points"]),
    equals: z.number(),
  }),
]);
export type PackClaim = z.infer<typeof PackClaim>;

export const PackExpectedSpecial = z.strictObject({
  kind: PackSpecialKind,
  divisionRef: PackRef,
  fixtureExtKey: PackExtKey,
  /** Human-readable, for the report. Never parsed. */
  note: z.string().min(1).max(500).optional(),
  claims: z.array(PackClaim).min(1),
});
export type PackExpectedSpecial = z.infer<typeof PackExpectedSpecial>;

export const PackExpected = z.strictObject({
  matches: z.array(PackExpectedMatch).default([]),
  tables: z.array(PackExpectedTable).default([]),
  champions: z.array(PackExpectedChampion).default([]),
  leaderboards: z.array(PackExpectedLeaderboard).default([]),
  suspensions: z.array(PackExpectedSuspension).default([]),
  specials: z.array(PackExpectedSpecial).default([]),
});
export type PackExpected = z.infer<typeof PackExpected>;

// ---------------------------------------------------------------------------
// Meta
// ---------------------------------------------------------------------------

export const PackSource = z.strictObject({
  url: z.url(),
  label: z.string().min(1).max(200),
  retrievedOn: z.iso.date().optional(),
});

/** Design §7A: every place reality was reshaped to fit the model, in prose a
 *  human can audit. TWO required fields, not one free-text blob — "what" with
 *  no "why" is the shape that turns into an unreviewable list. */
export const PackAdaptation = z.strictObject({
  what: z.string().min(1).max(500),
  why: z.string().min(1).max(1000),
  /** Where in this pack it applies, e.g. `divisions[1].stages[0]`. */
  where: z.string().min(1).max(200).optional(),
});
export type PackAdaptation = z.infer<typeof PackAdaptation>;

export const PackMeta = z.strictObject({
  /** True for a pack that describes NO real tournament — the `_tiny` fixture
   *  is the only such pack by design. It is what lets `sources` be empty
   *  without a real pack ever shipping uncited: the refinement below requires
   *  at least one source unless this is set. A synthetic pack's per-stream
   *  `provenance` describes how the stream was AUTHORED within the fixture,
   *  not correspondence to a real event. */
  synthetic: z.boolean().default(false),
  sources: z.array(PackSource).default([]),
  adaptations: z.array(PackAdaptation).default([]),
});
export type PackMeta = z.infer<typeof PackMeta>;

// ---------------------------------------------------------------------------
// Registration — DECLARED HERE, UNPOPULATED IN v1
// ---------------------------------------------------------------------------

/** The registration funnel layer, owned by session B03r
 *  (bench-prompts/B03r-registration-layer.md, design
 *  designs/2026-08-27-bench-customer-journey-design.md §4).
 *
 *  **No v1 pack populates this.** It is declared now, ahead of use, because
 *  PackSchema freezes at the end of B06 and an additive change after that has
 *  to be escalated to the owner — so the cheapest time to reserve the shape is
 *  before the freeze, not after it. Declared in FULL rather than as a loose
 *  passthrough for the same reason: a placeholder that B03r has to widen is
 *  not a placeholder, it is a deferred escalation.
 *
 *  Keyed by division ref rather than nested inside `divisions[]` (which is
 *  where B03r's own prompt sketches it) so the whole layer is one optional
 *  top-level key that v1 packs simply omit — the same information, and a
 *  division block that stays exactly what B02 froze. */
export const PackRegistrationEntry = z.strictObject({
  extKey: z.string().min(1).max(200),
  /** Person ref of the entering captain. */
  captain: PackRef,
  /** Person refs of the roster submitted with the entry. */
  roster: z.array(PackRef).default([]),
  pay: z.boolean().default(false),
  expect: z.enum(["entrant", "rejected_eligibility", "waitlisted", "rejected_manual"]),
});

export const PackRegistrationJoin = z.strictObject({
  /** `extKey` of the entry being joined. */
  entry: z.string().min(1).max(200),
  person: PackRef,
  consent: z.enum(["granted", "guardian"]),
});

export const PackRegistrationOrganiserAction = z.strictObject({
  action: z.enum(["approve", "reject", "promote", "assign_free_agent"]),
  /** `extKey` of the entry the action targets. */
  target: z.string().min(1).max(200),
});

export const PackRegistrationBlock = z.strictObject({
  category: z.enum(["open", "mens", "womens", "mixed"]),
  ageMin: z.number().int().min(0).max(120).optional(),
  ageMax: z.number().int().min(0).max(120).optional(),
  entrantKind: PackEntrantKind,
  feeCents: z.number().int().nonnegative(),
  currency: z.string().length(3),
  approval: z.enum(["auto", "manual"]),
  capacity: z.number().int().positive().optional(),
  entries: z.array(PackRegistrationEntry).default([]),
  joins: z.array(PackRegistrationJoin).default([]),
  organiser: z.array(PackRegistrationOrganiserAction).default([]),
  expect: z.strictObject({
    entrants: z.number().int().nonnegative(),
    waitlisted: z.number().int().nonnegative(),
    rejected: z.number().int().nonnegative(),
    paidCents: z.number().int().nonnegative(),
  }),
});
export type PackRegistrationBlock = z.infer<typeof PackRegistrationBlock>;

export const PackRegistration = z.strictObject({
  /** division ref -> that division's registration funnel. */
  byDivision: z.record(PackRef, PackRegistrationBlock).default({}),
});
export type PackRegistration = z.infer<typeof PackRegistration>;

// ---------------------------------------------------------------------------
// The pack
// ---------------------------------------------------------------------------

const PackShape = z.strictObject({
  /** Bumped by ANY change to this contract. A pack authored against an older
   *  shape then fails loudly instead of parsing into a different meaning. */
  schemaVersion: z.literal(1),
  /** The pack's own identity, checked against its filename by the validator.
   *  Deliberately NOT a closed enum of suite keys: `bench.ts`'s
   *  `KNOWN_SUITES` is the authority on which suites RUN, and a second copy
   *  of that list here is how two vocabularies of one fact drift apart. */
  suite: z
    .string()
    .min(1)
    .max(60)
    .regex(/^_?[a-z0-9][a-z0-9-]*$/, "a suite key is lower-case kebab, optionally _-prefixed"),
  org: PackOrg,
  competition: PackCompetition,
  divisions: z.array(PackDivision).min(1),
  persons: z.array(PackPerson).default([]),
  entrants: z.array(PackEntrant).min(2),
  streams: z.array(PackStream).default([]),
  historicalAssignment: z.array(PackHistoricalAssignment).optional(),
  expected: PackExpected,
  registration: PackRegistration.optional(),
  meta: PackMeta,
});

type PackShapeOut = z.infer<typeof PackShape>;

// ---------------------------------------------------------------------------
// Cross-field rules
//
// Each is a separate function so a reviewer can read one rule at a time, and
// so a mutation sweep can delete exactly one and watch exactly one test red.
// Every issue carries an explicit `path`: "the parse failed" is not actionable
// on a 40k-event pack, "streams[17].fixtureExtKey" is.
//
// Note for a consumer reporting these: zod runs a `superRefine` only after the
// base object parse SUCCEEDS. A pack with both a shape error (an unknown key,
// a missing `provenance`) and a cross-field error reports only the shape one,
// so "fix the shape, re-parse" is a real second pass and not a sign the
// cross-field rules did not run.
// ---------------------------------------------------------------------------

type Ctx = z.RefinementCtx;

function issue(ctx: Ctx, path: (string | number)[], message: string): void {
  ctx.addIssue({ code: "custom", path, message });
}

/** Composite lookup key for "this fixture, in THIS division" — the join every
 *  cross-field rule below needs (header note 5).
 *
 *  EXPORTED on purpose. Task 2's validator, the B03 seeding layer and the B05
 *  simulation layer all need the same "which fixture, in which division" map
 *  key, and three hand-rolled key formats that must agree is the
 *  parallel-vocabulary defect this repo keeps hitting. One function, one
 *  format.
 *
 *  Built through JSON rather than a delimiter string because the contract is
 *  INJECTIVITY OVER ARBITRARY STRINGS, and it must not quietly depend on
 *  `PackRef`'s current character class. Today `PackRef` happens to forbid
 *  spaces, so `${division} ${extKey}` would in fact be unambiguous — but a
 *  fixture `ext_key` is free-form text up to 200 chars, and the day `PackRef`
 *  widens by one character, a delimiter join starts silently merging two
 *  fixtures into one bucket and a real duplicate hides behind the collision.
 *  The injectivity test in pack-schema.test.ts pins that contract directly —
 *  without it, swapping this body for a space-delimited join survives the
 *  whole suite (it did, on the first mutation sweep). */
export function fixtureKey(divisionRef: string, extKey: string): string {
  return JSON.stringify([divisionRef, extKey]);
}

/** Every `ref` namespace is flat and unique — a duplicate would make the
 *  ref→UUID map the seeding layer returns ambiguous. */
function checkRefsUnique(p: PackShapeOut, ctx: Ctx): void {
  const seenDivision = new Set<string>();
  p.divisions.forEach((d, i) => {
    if (seenDivision.has(d.ref)) issue(ctx, ["divisions", i, "ref"], `duplicate division ref "${d.ref}"`);
    seenDivision.add(d.ref);
    const seenStage = new Set<string>();
    const seenSeq = new Set<number>();
    d.stages.forEach((s, j) => {
      if (seenStage.has(s.ref)) issue(ctx, ["divisions", i, "stages", j, "ref"], `duplicate stage ref "${s.ref}"`);
      seenStage.add(s.ref);
      if (seenSeq.has(s.seq)) issue(ctx, ["divisions", i, "stages", j, "seq"], `duplicate stage seq ${s.seq} in division "${d.ref}"`);
      seenSeq.add(s.seq);
    });
  });
  const seenPerson = new Set<string>();
  p.persons.forEach((person, i) => {
    if (seenPerson.has(person.ref)) issue(ctx, ["persons", i, "ref"], `duplicate person ref "${person.ref}"`);
    seenPerson.add(person.ref);
  });
  const seenEntrant = new Set<string>();
  p.entrants.forEach((e, i) => {
    if (seenEntrant.has(e.ref)) issue(ctx, ["entrants", i, "ref"], `duplicate entrant ref "${e.ref}"`);
    seenEntrant.add(e.ref);
  });
}

/** Rosters: known people, one captain, no repeated person or squad number,
 *  and the arity each entrant kind implies.
 *
 *  The arity rules count PLAYER-lane members only. A pair's two players may
 *  legitimately be accompanied by a coach on the same roster (design §9 P3
 *  seeds real managers as roster members with `lane: "coach"`, and the S3
 *  ruling is that a card against a coach never enters playing stats) — a rule
 *  that counted rows rather than players would make that unrepresentable. */
function checkRosters(p: PackShapeOut, ctx: Ctx): void {
  const laneOf = new Map(p.persons.map((person) => [person.ref, person.lane]));
  p.entrants.forEach((e, i) => {
    const seenPerson = new Set<string>();
    const seenSquad = new Set<number>();
    let captains = 0;
    let players = 0;
    e.roster.forEach((m, j) => {
      const lane = laneOf.get(m.person);
      if (lane === undefined) {
        issue(ctx, ["entrants", i, "roster", j, "person"], `unknown person ref "${m.person}"`);
      } else if (lane === "player") {
        players += 1;
      }
      if (seenPerson.has(m.person)) {
        issue(ctx, ["entrants", i, "roster", j, "person"], `person "${m.person}" appears twice on this roster`);
      }
      seenPerson.add(m.person);
      if (m.squadNumber !== undefined) {
        if (seenSquad.has(m.squadNumber)) {
          issue(ctx, ["entrants", i, "roster"], `duplicate squad number ${m.squadNumber} on entrant "${e.ref}"`);
        }
        seenSquad.add(m.squadNumber);
      }
      if (m.captain) captains += 1;
    });
    if (captains > 1) {
      issue(ctx, ["entrants", i, "roster"], `entrant "${e.ref}" names ${captains} captains; at most one is a captain`);
    }
    if (e.kind === "pair" && players !== 2) {
      issue(ctx, ["entrants", i, "roster"], `a pair entrant carries exactly two player-lane members, found ${players}`);
    }
    if (e.kind === "individual" && players > 1) {
      issue(ctx, ["entrants", i, "roster"], `an individual entrant carries at most one player-lane member, found ${players}`);
    }
  });
}

/** Entrants belong to a declared division, and every division fields enough
 *  entrants to produce a fixture. The lower bound is what makes the template
 *  skeleton's derived `entrantCount` total, and a division with one entrant
 *  is an authoring error in every real tournament. */
function checkEntrantDivisions(p: PackShapeOut, ctx: Ctx): void {
  const divisionRefs = new Set(p.divisions.map((d) => d.ref));
  const perDivision = new Map<string, number>();
  p.entrants.forEach((e, i) => {
    if (!divisionRefs.has(e.divisionRef)) {
      issue(ctx, ["entrants", i, "divisionRef"], `unknown division ref "${e.divisionRef}"`);
      return;
    }
    perDivision.set(e.divisionRef, (perDivision.get(e.divisionRef) ?? 0) + 1);
  });
  p.divisions.forEach((d, i) => {
    const n = perDivision.get(d.ref) ?? 0;
    if (n < 2) {
      issue(ctx, ["divisions", i, "ref"], `division "${d.ref}" declares ${n} entrant(s); a division needs at least two entrants`);
    }
  });
}

/** Seeding and bracket refs resolve to an entrant OF THAT DIVISION. This is
 *  also what makes a TBD placeholder unrepresentable: `"TBD"` is a ref that
 *  resolves to nothing, and reds naming the slot. */
function checkStageEntrantRefs(p: PackShapeOut, ctx: Ctx): void {
  const byDivision = new Map<string, Set<string>>();
  for (const e of p.entrants) {
    const set = byDivision.get(e.divisionRef) ?? new Set<string>();
    set.add(e.ref);
    byDivision.set(e.divisionRef, set);
  }
  p.divisions.forEach((d, i) => {
    const known = byDivision.get(d.ref) ?? new Set<string>();
    d.stages.forEach((s, j) => {
      s.seeding?.forEach((ref, k) => {
        if (!known.has(ref)) {
          issue(ctx, ["divisions", i, "stages", j, "seeding", k], `unknown entrant ref "${ref}" for division "${d.ref}"`);
        }
      });
      s.bracket?.forEach((slot, k) => {
        if (!known.has(slot.entrant)) {
          issue(ctx, ["divisions", i, "stages", j, "bracket", k, "entrant"], `unknown entrant ref "${slot.entrant}" for division "${d.ref}"`);
        }
      });
    });
  });
}

/** Walks a payload for `@`-sigilled refs (header note 6). Returns the offending
 *  values rather than raising, so the caller owns the path. */
function unresolvedPayloadRefs(
  value: PackJsonValue,
  known: (ref: string) => boolean,
  out: string[],
): void {
  if (typeof value === "string") {
    if (value.startsWith("@") && !known(value.slice(1))) out.push(value);
    return;
  }
  if (Array.isArray(value)) {
    for (const v of value) unresolvedPayloadRefs(v, known, out);
    return;
  }
  if (value !== null && typeof value === "object") {
    for (const v of Object.values(value)) unresolvedPayloadRefs(v, known, out);
  }
}

/** Streams: known division, ext_key unique WITHIN that division (header note
 *  5), reconstruction only where provenance says so, payload refs resolvable. */
function checkStreams(p: PackShapeOut, ctx: Ctx): void {
  const divisionRefs = new Set(p.divisions.map((d) => d.ref));
  const personRefs = new Set(p.persons.map((person) => person.ref));
  const entrantsByDivision = new Map<string, Set<string>>();
  for (const e of p.entrants) {
    const set = entrantsByDivision.get(e.divisionRef) ?? new Set<string>();
    set.add(e.ref);
    entrantsByDivision.set(e.divisionRef, set);
  }
  const seen = new Set<string>();
  p.streams.forEach((s, i) => {
    if (!divisionRefs.has(s.divisionRef)) {
      issue(ctx, ["streams", i, "divisionRef"], `unknown division ref "${s.divisionRef}"`);
    }
    const composite = fixtureKey(s.divisionRef, s.fixtureExtKey);
    if (seen.has(composite)) {
      issue(
        ctx,
        ["streams", i, "fixtureExtKey"],
        `duplicate fixture ext_key "${s.fixtureExtKey}" in division "${s.divisionRef}" — ` +
          `a pack ext_key is unique per DIVISION, because the product resolves a fixture by ` +
          `division_id + ext_key while the unique index is only per stage`,
      );
    }
    seen.add(composite);
    if (s.reconstruction !== undefined && s.provenance !== "reconstructed") {
      issue(ctx, ["streams", i, "reconstruction"], `only a stream with provenance "reconstructed" may carry a reconstruction seed`);
    }
    const entrantRefs = entrantsByDivision.get(s.divisionRef) ?? new Set<string>();
    const known = (ref: string): boolean => entrantRefs.has(ref) || personRefs.has(ref);
    s.events.forEach((ev, j) => {
      const bad: string[] = [];
      unresolvedPayloadRefs(ev.payload, known, bad);
      for (const ref of bad) {
        issue(
          ctx,
          ["streams", i, "events", j, "payload"],
          `unknown pack ref "${ref}" — an @-prefixed payload string must name an entrant of ` +
            `division "${s.divisionRef}" or a declared person`,
        );
      }
    });
  });
}

/** The oracle block. Two jobs: every ref resolves to something in the right
 *  scope, and — the anti-vacuity rule — every stream has an expected match.
 *  A stream with no oracle is events replayed against no assertion, which is
 *  precisely the shape that reports green while proving nothing. */
function checkExpected(p: PackShapeOut, ctx: Ctx): void {
  const divisionRefs = new Set(p.divisions.map((d) => d.ref));
  const personRefs = new Set(p.persons.map((person) => person.ref));
  const entrantsByDivision = new Map<string, Set<string>>();
  for (const e of p.entrants) {
    const set = entrantsByDivision.get(e.divisionRef) ?? new Set<string>();
    set.add(e.ref);
    entrantsByDivision.set(e.divisionRef, set);
  }
  const stagesByDivision = new Map<string, Set<string>>(
    p.divisions.map((d) => [d.ref, new Set(d.stages.map((s) => s.ref))]),
  );
  const streamKeys = new Set(p.streams.map((s) => fixtureKey(s.divisionRef, s.fixtureExtKey)));

  const entrantIn = (division: string, ref: string): boolean =>
    (entrantsByDivision.get(division) ?? new Set<string>()).has(ref);

  const checkDivision = (path: (string | number)[], ref: string): boolean => {
    if (divisionRefs.has(ref)) return true;
    issue(ctx, [...path, "divisionRef"], `unknown division ref "${ref}"`);
    return false;
  };

  p.expected.matches.forEach((m, i) => {
    const base: (string | number)[] = ["expected", "matches", i];
    if (!checkDivision(base, m.divisionRef)) return;
    if (!streamKeys.has(fixtureKey(m.divisionRef, m.fixtureExtKey))) {
      issue(ctx, [...base, "fixtureExtKey"], `no stream declares fixture "${m.fixtureExtKey}" in division "${m.divisionRef}"`);
    }
    const o = m.outcome;
    if ("winner" in o && !entrantIn(m.divisionRef, o.winner)) {
      issue(ctx, [...base, "outcome", "winner"], `unknown entrant ref "${o.winner}" for division "${m.divisionRef}"`);
    }
    if ("loser" in o && !entrantIn(m.divisionRef, o.loser)) {
      issue(ctx, [...base, "outcome", "loser"], `unknown entrant ref "${o.loser}" for division "${m.divisionRef}"`);
    }
    m.perSide?.forEach((side, j) => {
      if (!entrantIn(m.divisionRef, side.entrant)) {
        issue(ctx, [...base, "perSide", j, "entrant"], `unknown entrant ref "${side.entrant}" for division "${m.divisionRef}"`);
      }
    });
  });

  // Anti-vacuity: a declared stream MUST have an oracle.
  const oracled = new Set(p.expected.matches.map((m) => fixtureKey(m.divisionRef, m.fixtureExtKey)));
  const orphans = p.streams.filter((s) => !oracled.has(fixtureKey(s.divisionRef, s.fixtureExtKey)));
  if (orphans.length > 0) {
    const names = orphans.map((s) => `${s.divisionRef}/${s.fixtureExtKey}`).join(", ");
    issue(ctx, ["expected", "matches"], `no expected match for stream(s): ${names} — a replayed stream with no oracle asserts nothing`);
  }

  p.expected.tables.forEach((t, i) => {
    const base: (string | number)[] = ["expected", "tables", i];
    if (!checkDivision(base, t.divisionRef)) return;
    if (!(stagesByDivision.get(t.divisionRef) ?? new Set<string>()).has(t.stageRef)) {
      issue(ctx, [...base, "stageRef"], `unknown stage ref "${t.stageRef}" for division "${t.divisionRef}"`);
    }
    const seen = new Set<string>();
    t.rows.forEach((row, j) => {
      if (!entrantIn(t.divisionRef, row.entrant)) {
        issue(ctx, [...base, "rows", j, "entrant"], `unknown entrant ref "${row.entrant}" for division "${t.divisionRef}"`);
      }
      if (seen.has(row.entrant)) {
        issue(ctx, [...base, "rows", j, "entrant"], `entrant "${row.entrant}" appears twice in this table`);
      }
      seen.add(row.entrant);
      if (row.rank !== j + 1) {
        issue(ctx, [...base, "rows", j, "rank"], `rank must be ${j + 1} — rows are in EXACT final order, and rank restates that order so the two can never disagree`);
      }
    });
  });

  const championed = new Set<string>();
  p.expected.champions.forEach((c, i) => {
    const base: (string | number)[] = ["expected", "champions", i];
    if (!checkDivision(base, c.divisionRef)) return;
    if (championed.has(c.divisionRef)) {
      issue(ctx, [...base, "divisionRef"], `division "${c.divisionRef}" declares more than one champion`);
    }
    championed.add(c.divisionRef);
    if (!entrantIn(c.divisionRef, c.entrant)) {
      issue(ctx, [...base, "entrant"], `unknown entrant ref "${c.entrant}" for division "${c.divisionRef}"`);
    }
  });

  p.expected.leaderboards.forEach((l, i) => {
    const base: (string | number)[] = ["expected", "leaderboards", i];
    if (!checkDivision(base, l.divisionRef)) return;
    l.entries.forEach((entry, j) => {
      if (!personRefs.has(entry.person)) {
        issue(ctx, [...base, "entries", j, "person"], `unknown person ref "${entry.person}"`);
      }
    });
  });

  p.expected.suspensions.forEach((s, i) => {
    const base: (string | number)[] = ["expected", "suspensions", i];
    if (!checkDivision(base, s.divisionRef)) return;
    if (!personRefs.has(s.person)) {
      issue(ctx, [...base, "person"], `unknown person ref "${s.person}"`);
    }
    s.missesFixtureExtKeys.forEach((key, j) => {
      if (!streamKeys.has(fixtureKey(s.divisionRef, key))) {
        issue(ctx, [...base, "missesFixtureExtKeys", j], `no stream declares fixture "${key}" in division "${s.divisionRef}"`);
      }
    });
  });

  p.expected.specials.forEach((sp, i) => {
    const base: (string | number)[] = ["expected", "specials", i];
    if (!checkDivision(base, sp.divisionRef)) return;
    if (!streamKeys.has(fixtureKey(sp.divisionRef, sp.fixtureExtKey))) {
      issue(ctx, [...base, "fixtureExtKey"], `no stream declares fixture "${sp.fixtureExtKey}" in division "${sp.divisionRef}"`);
    }
    sp.claims.forEach((claim, j) => {
      const refs: [string, string][] = [];
      if (claim.on === "outcome") {
        if (claim.winner !== undefined) refs.push(["winner", claim.winner]);
        if (claim.loser !== undefined) refs.push(["loser", claim.loser]);
      } else if (claim.on === "standings") {
        refs.push(["entrant", claim.entrant]);
      }
      for (const [field, ref] of refs) {
        if (!entrantIn(sp.divisionRef, ref)) {
          issue(ctx, [...base, "claims", j, field], `unknown entrant ref "${ref}" for division "${sp.divisionRef}"`);
        }
      }
    });
  });
}

/** Certificate rows point at streams the pack actually declares — otherwise
 *  the feasibility check silently covers fewer fixtures than it appears to. */
function checkHistoricalAssignment(p: PackShapeOut, ctx: Ctx): void {
  if (p.historicalAssignment === undefined) return;
  const streamKeys = new Set(p.streams.map((s) => fixtureKey(s.divisionRef, s.fixtureExtKey)));
  const seen = new Set<string>();
  p.historicalAssignment.forEach((a, i) => {
    const composite = fixtureKey(a.divisionRef, a.fixtureExtKey);
    if (!streamKeys.has(composite)) {
      issue(ctx, ["historicalAssignment", i, "fixtureExtKey"], `no stream declares fixture "${a.fixtureExtKey}" in division "${a.divisionRef}"`);
    }
    if (seen.has(composite)) {
      issue(ctx, ["historicalAssignment", i, "fixtureExtKey"], `duplicate historical assignment for "${a.fixtureExtKey}" in division "${a.divisionRef}"`);
    }
    seen.add(composite);
  });
}

/** Provenance honesty (design §4): a pack that describes a real tournament
 *  cites where its facts came from. `meta.synthetic` is the one, explicit way
 *  out, and it says so in the file rather than being inferred from an empty
 *  array. */
function checkSources(p: PackShapeOut, ctx: Ctx): void {
  if (!p.meta.synthetic && p.meta.sources.length === 0) {
    issue(ctx, ["meta", "sources"], `a pack that is not meta.synthetic must cite at least one source`);
  }
}

/** The registration block, when present, points at declared divisions and
 *  people. Unreachable in v1 (nothing populates `registration`) but declared
 *  with the rest of the block so B03r inherits the rule instead of writing it. */
function checkRegistration(p: PackShapeOut, ctx: Ctx): void {
  if (p.registration === undefined) return;
  const divisionRefs = new Set(p.divisions.map((d) => d.ref));
  const personRefs = new Set(p.persons.map((person) => person.ref));
  for (const [divisionRef, block] of Object.entries(p.registration.byDivision)) {
    const base: (string | number)[] = ["registration", "byDivision", divisionRef];
    if (!divisionRefs.has(divisionRef)) {
      issue(ctx, base, `unknown division ref "${divisionRef}"`);
      continue;
    }
    const entryKeys = new Set(block.entries.map((e) => e.extKey));
    block.entries.forEach((e, i) => {
      if (!personRefs.has(e.captain)) {
        issue(ctx, [...base, "entries", i, "captain"], `unknown person ref "${e.captain}"`);
      }
      e.roster.forEach((ref, j) => {
        if (!personRefs.has(ref)) issue(ctx, [...base, "entries", i, "roster", j], `unknown person ref "${ref}"`);
      });
    });
    block.joins.forEach((j, i) => {
      if (!entryKeys.has(j.entry)) issue(ctx, [...base, "joins", i, "entry"], `unknown registration entry "${j.entry}"`);
      if (!personRefs.has(j.person)) issue(ctx, [...base, "joins", i, "person"], `unknown person ref "${j.person}"`);
    });
    block.organiser.forEach((a, i) => {
      if (!entryKeys.has(a.target)) issue(ctx, [...base, "organiser", i, "target"], `unknown registration entry "${a.target}"`);
    });
  }
}

export const PackSchema = PackShape.superRefine((p, ctx) => {
  checkRefsUnique(p, ctx);
  checkEntrantDivisions(p, ctx);
  checkRosters(p, ctx);
  checkStageEntrantRefs(p, ctx);
  checkStreams(p, ctx);
  checkExpected(p, ctx);
  checkHistoricalAssignment(p, ctx);
  checkSources(p, ctx);
  checkRegistration(p, ctx);
});

export type Pack = z.infer<typeof PackSchema>;
