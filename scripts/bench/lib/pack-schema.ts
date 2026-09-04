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
// 9. A STREAM DECLARES ITS SIDES. `foldMatch(module, cfg, lineups, events)`
//    takes `LineupPair` as a REQUIRED argument (`core/events.ts:445-451`;
//    `Lineup = { entrantId, slots }` at `core/types.ts:226-230`), and stage-0
//    folds every stream in process. A stream that named only its fixture
//    `ext_key` would force the sides to be recovered by re-running the
//    scheduling generator over the pack's seeds — an undeclared dependency on
//    a different subsystem, silently deciding oracles. So `streams[].home` /
//    `.away` are required entrant refs, and `streams[].lineups` optionally
//    carries the real per-fixture team sheets (needed by the concussion and
//    suspension oracles, which read the kernel's squad state rather than a
//    season roster).
//
// Runtime constraints (B02 GLOBAL.md): no TS `enum`, no `namespace`, no
// emit-dependent syntax — this file is read by `node
// --experimental-strip-types`. Every relative import carries `.ts`.
import { z } from "zod";
import { StageKind, type MatchOutcome, type StandingsDelta } from "@seazn/engine/core";
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

/** Bench doctrine (`_RULES.md` §3, GLOBAL.md): provenance is never disguised.
 *  A reconstructed stream flagged `"real"` is undetectable by code, so the
 *  only thing a validator can enforce is that the flag is PRESENT — which is
 *  why this has no default.
 *
 *  - `"real"`      the stream is the historical record, event for event.
 *  - `"reconstructed"` a legal sequence generated to fold to the EXACT real
 *                  score, because the per-rally sequence was never archived.
 *  - `"synthetic"` the stream models no real event at all. Added for B03r
 *                  (`bench-prompts/B03r-registration-layer.md` §1), whose
 *                  registration-driven fixtures are invented by construction.
 *
 *  GLOBAL.md states the vocabulary as two values; `"synthetic"` was added on
 *  a coordinator instruction in review round 1, ahead of the B06 freeze. It
 *  does not weaken the doctrine — the doctrine is that the flag tells the
 *  truth, and a third, MORE honest bucket for "this never happened" is the
 *  doctrine applied, not relaxed. Flagged in the task report so the owner
 *  sees the vocabulary changed.
 *
 *  Distinct from `meta.synthetic`, which is PACK-scoped ("this pack describes
 *  no real tournament"). A real suite pack may carry a synthetic stream; a
 *  synthetic pack may carry a stream flagged `"real"`, meaning that stream is
 *  the authored ground truth within the fixture. */
export const PackProvenance = z.enum(["real", "reconstructed", "synthetic"]);
export type PackProvenance = z.infer<typeof PackProvenance>;

/** Which provenances describe a GENERATED stream, and may therefore carry a
 *  `reconstruction.seed`.
 *
 *  A `Record<PackProvenance, boolean>` rather than a predicate, deliberately.
 *  Both `provenance === "real"` and `provenance !== "reconstructed" &&
 *  !== "synthetic"` are correct today and neither is testable, because with
 *  three values they are the same function — the difference only appears on a
 *  FOURTH value, where one fails open and the other closed. An exhaustive map
 *  removes the choice: adding a value to `PackProvenance` without deciding
 *  this question fails `tsc` with a missing property. The safe direction stops
 *  being a convention someone has to remember. */
export const SEED_LEGAL_BY_PROVENANCE: Readonly<Record<PackProvenance, boolean>> = {
  real: false, // the historical record; nothing generated it
  reconstructed: true, // generated to fold to a real score
  synthetic: true, // generated, and modelling no real event at all
};

/**
 * The refusal an author reads when a stream carries a seed it may not.
 *
 * A separate pure function, taking the table as an argument, for one reason:
 * hardcoding `"real"` in the message is INVISIBLE while `"real"` is the only
 * forbidden provenance, so a test driving the real schema cannot tell the
 * interpolated version from the hardcoded one. Passing the table in lets a
 * unit test hand it a four-value one and observe the difference — which is
 * the whole failure mode this message exists to avoid, since the fourth value
 * is exactly when an author would be told their stream is "real" when it is
 * not.
 */
export function seedRefusalMessage(
  provenance: string,
  legalBy: Readonly<Record<string, boolean>>,
): string {
  const generated = Object.keys(legalBy)
    .filter((value) => legalBy[value])
    .sort()
    .map((value) => `"${value}"`)
    .join(" or ");
  return (
    `a stream with provenance "${provenance}" may not carry a reconstruction seed — only a GENERATED ` +
    `stream records what generated it, and the generated provenances are ${generated}`
  );
}

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

/** The scalar fields of the engine's `StandingsDelta`
 *  (`packages/engine/src/core/types.ts` — `entrantId` is a string and
 *  `metrics` is a `Record`, so the numeric fields are exactly these five).
 *
 *  Pinned to the engine type the same way `TIEBREAKER_KEYS` is, and for the
 *  same reason: the list is hand-written because `StandingsDelta` ships as a
 *  zod object with no runtime array of its scalar keys, so without the two
 *  declarations below a field added engine-side would leave this enum quietly
 *  asserting yesterday's shape. It did exactly that until review round 2. */
export const STANDINGS_SCALAR_FIELDS = ["played", "won", "drawn", "lost", "points"] as const;

/** Keys of `StandingsDelta` whose value is a number — i.e. everything a
 *  `{on:"standings"}` claim can compare with `equals`. Derived from the engine
 *  type rather than restated, so the filter moves when the engine does. */
type StandingsScalarKey = {
  [K in keyof StandingsDelta]-?: StandingsDelta[K] extends number ? K : never;
}[keyof StandingsDelta];

// Compile-time, BIDIRECTIONAL, in a non-test file (tsconfig.scripts.json:35
// excludes `*.test.ts`). Two consts, never `A & B` — see the tiebreaker pair.
type _StandingsFieldsAreEngineScalars = (typeof STANDINGS_SCALAR_FIELDS)[number] extends StandingsScalarKey
  ? true
  : never;
type _StandingsFieldsAreExhaustive = Exclude<
  StandingsScalarKey,
  (typeof STANDINGS_SCALAR_FIELDS)[number]
> extends never
  ? true
  : never;
export const STANDINGS_FIELDS_ARE_ENGINE_SCALARS: _StandingsFieldsAreEngineScalars = true;
export const STANDINGS_FIELDS_ARE_EXHAUSTIVE: _StandingsFieldsAreExhaustive = true;

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
  /** IANA zone the real tournament was played in. REQUIRED, with no default:
   *  every historical start time in `historicalAssignment` is meaningless
   *  without one, and "assume UTC" is exactly how a feasibility certificate
   *  silently shifts by hours. A `.default("UTC")` here would have been that
   *  assumption wearing the comment that forbids it (review round 1, I3). */
  timezone: z.string().min(1).max(60),
  /** ISO-4217, lower-case — matches what `organizations.currency` actually
   *  stores: `db/migration/deltas/V365__org_currency.sql:70-71` adds it as
   *  `text not null default 'gbp'` with an allowlist CHECK
   *  (`usd|eur|gbp|inr|aud`, = `SUPPORTED_CURRENCIES`,
   *  `apps/web/src/lib/currency.ts:6`). Lives on the ORG, not the division —
   *  see `PackRegistrationBlock`'s doc comment for why (V365, "RS001b": one
   *  Stripe checkout session per cart, one currency per session).
   *
   *  OPTIONAL, deliberately with NO `.default()` — the same reasoning as
   *  `timezone` above, whose own comment calls a hidden default "an
   *  assumption wearing the comment that forbids it": the DB column defaults
   *  to 'gbp' for orgs that never set one, but a pack records a REAL
   *  tournament's real org, and silently assuming every unstated org is
   *  British is exactly that wrong-assumption shape. Required only where it
   *  actually matters — any division pricing a fee — and that conditional
   *  requirement is a stage-0 funnel rule (`validate-pack.ts`,
   *  `registration.currency_required`), not a shape rule, the same split
   *  `dob`/`gender` use above `PackPerson`. */
  currency: z
    .string()
    .regex(/^[a-z]{3}$/, "currency is a lower-case ISO-4217 code, matching organizations.currency")
    .optional(),
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
  // ---- PRE-FREEZE RESERVATION for B03r (registration layer) ----
  // `divisions[].entry: "admin" | "registration-api" | "registration-ui"`,
  // default `admin` — `designs/2026-08-27-bench-customer-journey-design.md`
  // §3 and §4, and `bench-prompts/B03r-registration-layer.md` §1. The CLI's
  // `--entry` overrides it at run time; this is the pack's own declaration.
  entry: z.enum(["admin", "registration-api", "registration-ui"]).default("admin"),
  // ---- PRE-FREEZE RESERVATION for B04 (scheduling layer) ----
  // "apply the pack's `ScheduleConfig` per division"
  // (`bench-prompts/B04-scheduling-layer.md` §1); the knob vocabulary is
  // bench design §5, whose authority is `ScheduleConfig` in
  // `apps/web/src/server/api-v1/schemas.ts`.
  //
  // Carried OPAQUE, exactly like `stages[].config` and `stages[].progression`,
  // and for the same reason: a second copy of that vocabulary here is how two
  // shapes of one fact drift apart, and it is ~20 knobs deep with its own
  // migration history (`courts` and `blackouts[].court` both moved from names
  // to real ids in V374).
  //
  // Court and venue references inside it use the SAME `@`-sigil convention as
  // event payloads (header note 6) — `ScheduleConfig.courts` is an array of
  // real court UUIDs that do not exist at authoring time — and the sigil is
  // checked here against the pack's declared venues and courts.
  scheduleConfig: z.record(z.string(), PackJsonValue).optional(),
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
  // ---- PRE-FREEZE RESERVATION for B03r (registration layer) ----
  // Shapes taken verbatim from
  // `designs/2026-08-27-bench-customer-journey-design.md` §4:
  //   persons[].dob?: string        // ISO date
  //   persons[].gender?: "m"|"f"
  // "required when any division the person enters carries an age band /
  // category" — that CONDITIONAL requirement is a stage-0 funnel rule B03r
  // owns (design §4's five checks), not a shape rule, so both stay optional
  // here. Declared now because PackSchema freezes at the end of B06 and an
  // additive change after that is an owner escalation.
  //
  // Gap 2 (B03r-repins-2026-09-03.md, owner ruling 2026-09-04, closed ahead
  // of the B06 freeze): `"x"` added to the union. The product's
  // `categoryEligibilityIssues` (apps/web/src/lib/registration-rules.ts
  // ~:177-178) reads "`x` never blocks: a person whose gender is `x` is
  // eligible for every category (owner ruling, RS002)" — a null gender is
  // still `MISSING_GENDER`, but a declared `"x"` is never a
  // `CATEGORY_MISMATCH`. `mixedCompositionTally` (same file, ~:357) treats
  // `x`/null identically: neither counts toward either side of a `mixed`
  // roster's m/f tally. Without this member a pack could not express a
  // non-binary person at all, and therefore could not represent the one
  // case those predicates treat specially — see `validate-pack.ts`'s
  // `categoryViolation`/`mixedCompositionViolation`, the stage-0 mirrors
  // that now honour it.
  dob: z.iso.date().optional(),
  gender: z.enum(["m", "f", "x"]).optional(),
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

/** Present only on a GENERATED stream. Task 3's generators are deterministic
 *  from a seed, and the seed lives in the pack so the same bytes come out on
 *  every machine and every run.
 *
 *  Legal on `"reconstructed"` AND on `"synthetic"`. Both are generated, and
 *  both therefore need to record what generated them: a reconstructed stream
 *  was built to fold to a real score, a synthetic one models no real event at
 *  all (B03r's registration-driven fixtures), and reproducibility is exactly
 *  as load-bearing for the second as for the first. Refusing the seed on
 *  `"synthetic"` — which this schema did between the round-1 additive pass and
 *  round 2 — leaves the customer-journey suite unable to record the seed that
 *  produced its own streams, defeating the reason the field exists.
 *
 *  Optional, because a HAND-authored stream of either provenance has no seed
 *  (`_tiny`'s reconstructed stream is hand-written). A `"real"` stream carrying
 *  one is still refused: a real stream is the historical record, and nothing
 *  generated it. */
export const PackReconstruction = z.strictObject({
  seed: z.number().int().nonnegative(),
  /** Free-form note on what the generator was asked to hit (the real set
   *  scores it folds to). Human-readable, never parsed. */
  note: z.string().min(1).max(500).optional(),
});
export type PackReconstruction = z.infer<typeof PackReconstruction>;

/** One person on one side's team sheet FOR THIS FIXTURE. Mirrors the engine's
 *  `LineupSlot` (`packages/engine/src/core/types.ts:179-223`) with `personId`
 *  replaced by a pack ref.
 *
 *  `orderNo` is optional here and defaults to the member's 1-based position in
 *  its side's array — the same "array order IS the ordinal" rule the pack
 *  applies to event `seq` (header note 2), and for the same reason: two
 *  sources of truth for one fact drift. The engine requires `orderNo`, so a
 *  consumer building a real `LineupSlot` substitutes `index + 1` when it is
 *  absent. `slot` defaults to `"starting"`; a bench player says so.
 *
 *  `role` is the engine's `"player" | "coach" | "staff"` slot role, which is
 *  how a coach reaches a team sheet without entering a playing projection
 *  (S3/#426 ruling 3). `pairOrder` is DECLARED order within a pair
 *  (`core/types.ts:222`) and lives here rather than on `PackRosterMember`,
 *  because it is a lineup fact: `entrant_members` has no such column
 *  (V213 carries only squad_number / default_position_key / is_captain /
 *  roles). */
export const PackLineupSlot = z.strictObject({
  person: PackRef,
  slot: z.enum(["starting", "bench"]).default("starting"),
  orderNo: z.number().int().positive().optional(),
  positionKey: z.string().min(1).max(60).optional(),
  roles: z.array(z.string().min(1).max(60)).default([]),
  squadNumber: z.number().int().nonnegative().max(999).optional(),
  role: z.enum(["player", "coach", "staff"]).optional(),
  pairOrder: z.number().int().positive().optional(),
});
export type PackLineupSlot = z.infer<typeof PackLineupSlot>;

export const PackStream = z.strictObject({
  /** Which division's fixture this is. Required because `ext_key` is unique
   *  per division, not globally, and because the product's own resolver
   *  looks up `division_id + ext_key` (header notes 4 and 5). */
  divisionRef: PackRef,
  fixtureExtKey: PackExtKey,
  /**
   * WHICH STAGE of that division this fixture belongs to.
   *
   * OPTIONAL, and absent means "the division's only stage" — which is why a
   * single-stage pack (every v1 pack) need not carry it and none was changed
   * when this was added.
   *
   * It exists because in the PRODUCT the stage is a FIXTURE-row fact, and a
   * pack declares no fixtures. Without it a consumer of a multi-stage
   * division cannot answer three questions at all: which streams feed which
   * `expected.tables` row, which pool a fixture sat in, and — the one with
   * teeth — which stage's `shootout` / `extraTime` overlay the fixture folds
   * under (`apps/web/src/server/engine-db/stage-cfg.ts:9`, the two keys and
   * only those two). The third is not a missing check but a WRONG one: a
   * groups+knockout division whose knockout stage turns `shootout` on folds
   * its knockout fixtures under the division cfg instead, and the validator
   * then reports a divergence the pack never committed.
   *
   * Additive on purpose, and landed BEFORE the B06 freeze rather than
   * escalated after it. Cross-checked below against the stages the stream's
   * own division declares — a stageRef naming another division's stage
   * resolves to nothing and is refused.
   */
  stageRef: PackRef.optional(),
  /**
   * WHO PLAYED, and on which side. Required — see header note 9.
   *
   * `foldMatch` takes `LineupPair` as a REQUIRED argument
   * (`packages/engine/src/core/events.ts:445-451`), and stage-0 folds every
   * stream in process, so without these the sides can only be recovered by
   * re-running the scheduling generator against the pack's seeds — an
   * undeclared dependency on a completely different subsystem, and one that
   * silently decides oracles. It is not hypothetical: `generic.result`'s
   * `p1Score` maps to HOME (`sports/generic/generic.ts:113-114`), and a
   * multi-leg round robin MIRRORS home/away on even legs
   * (`scheduling/roundrobin.ts` — `if (leg % 2 === 0) [home, away] = [away, home]`),
   * so the same `{p1Score: 3, p2Score: 1}` names a different winner in leg 1
   * and leg 2. The pack must say which.
   */
  home: PackRef,
  away: PackRef,
  provenance: PackProvenance,
  reconstruction: PackReconstruction.optional(),
  /**
   * The real team sheets for this fixture, where the record gives them.
   *
   * OPTIONAL, because an entrant-level sport (boardgame, generic, carrom) has
   * nothing to put here and the seeding layer can synthesise a one-slot
   * lineup from the entrant's roster. REQUIRED IN PRACTICE for the oracles
   * that read the squad: a `core.lineup.replacement` charged to the
   * `"concussion"` exemption, and the discipline oracle asserting the real
   * suspended player is absent from a specific fixture's sheet, both need a
   * per-fixture sheet rather than a season roster.
   */
  lineups: z
    .strictObject({
      home: z.array(PackLineupSlot).min(1),
      away: z.array(PackLineupSlot).min(1),
    })
    .optional(),
  events: z.array(PackEvent).min(1),
});
export type PackStream = z.infer<typeof PackStream>;

// ---------------------------------------------------------------------------
// Venues, officials and claim invites
//
// PRE-FREEZE RESERVATIONS. Nothing in v1 populates these; they are declared
// now because PackSchema freezes at the end of B06 and every one of them has
// a named consumer session already. Every field below is copied from an
// authored source and cited — nothing here is invented. Two things a later
// session might expect and will NOT find, because no authored source gives
// them a shape, are listed in this task's report instead.
// ---------------------------------------------------------------------------

/** One court. Fields from `CreateCourt` (`apps/web/src/server/api-v1/
 *  schemas.ts`): `name`, `sort`, `tags` — the last bounded by
 *  `RequiredCourtTags`, `z.array(z.string().min(1).max(40)).max(50)`. */
export const PackCourt = z.strictObject({
  ref: PackRef,
  name: z.string().min(1).max(200),
  sort: z.number().int().optional(),
  tags: z.array(z.string().min(1).max(40)).max(50).default([]),
});
export type PackCourt = z.infer<typeof PackCourt>;

/** One venue and its courts. Fields from `CreateVenue` (`name`, `address`,
 *  `sort`). Consumers: B03 seeds them (bench design §10's pre-flight seeds a
 *  venue/court chain today in `lib/suites/tiny.ts`), and B04's independent
 *  checker needs court identity to detect a double-booking
 *  (`bench-prompts/B04-scheduling-layer.md` §2). Design §5's suite matrix is
 *  the requirement: "9 stadiums as courts", "18 courts", "many tables to few".
 *
 *  This is deliberately SEPARATE from `historicalAssignment[].venue`, which
 *  stays free text: that field records where the REAL WORLD played a fixture
 *  (often a stadium the bench never seeds), while these are the venues the
 *  bench creates and schedules onto. Conflating them would make the
 *  feasibility certificate assert against the bench's own fixtures instead of
 *  history's. */
export const PackVenue = z.strictObject({
  ref: PackRef,
  name: z.string().min(1).max(200),
  address: z.string().max(500).optional(),
  sort: z.number().int().optional(),
  courts: z.array(PackCourt).min(1),
});
export type PackVenue = z.infer<typeof PackVenue>;

/** A blackout date for one official — one `official_availability` row
 *  (`db/migration/deltas/V284__official_onboarding.sql:28-37`: `date`,
 *  `status` CHECK-constrained to the single value `'unavailable'`, `note`,
 *  and `unique (official_id, date)`). `status` is not modelled: a row IS the
 *  unavailability, and the column admits exactly one value. */
export const PackOfficialUnavailability = z.strictObject({
  date: z.iso.date(),
  note: z.string().min(1).max(200).optional(),
});

/** One official's named assignment to a fixture. Bench design §9 P1: "the
 *  final's official == the real final's official" is the oracle this exists
 *  to make expressible. `roleKey` is one of the official's own `roleKeys`. */
export const PackOfficialAssignment = z.strictObject({
  divisionRef: PackRef,
  fixtureExtKey: PackExtKey,
  roleKey: z.string().min(1).max(60).optional(),
});

/** A real match official. Fields from `CreateOfficial`
 *  (`api-v1/schemas.ts`): `display_name`, `person_id`, `role_keys`
 *  (default `["referee"]`), `max_per_day`. Consumers: B03 §4 seeds officials
 *  and their blackouts; B04 §2's checker asserts no official double-booking;
 *  bench design §9 P1 owns the scenarios.
 *
 *  `person` is required and must name a person with `lane: "official"` —
 *  design §9 P1 says officials are seeded in that lane, and `persons.lane`
 *  admits it (`V348`, widened by `V356`). A pack that put a player-lane
 *  person here would seed an official the product's own lane split says is
 *  not one.
 *
 *  NOT modelled, deliberately: any auto-assign-vs-manual switch. B03 §4 says
 *  "auto-assign where the pack says, manual where named", but no authored
 *  source gives that switch a shape, and the distinction is already carried
 *  by the data — an official with named `assignments` is manual, one without
 *  is left to `autoAssignOfficials`. Recorded in the task report. */
export const PackOfficial = z.strictObject({
  ref: PackRef,
  person: PackRef,
  displayName: z.string().min(1).max(200),
  roleKeys: z.array(z.string().min(1).max(60)).min(1).default(["referee"]),
  maxPerDay: z.number().int().positive().optional(),
  unavailable: z.array(PackOfficialUnavailability).default([]),
  assignments: z.array(PackOfficialAssignment).default([]),
});
export type PackOfficial = z.infer<typeof PackOfficial>;

/** A player-claim invite for one of the suite's stars. Bench design §9 P2:
 *  "`pc_` claim invites for ~3 stars/suite; accepted via magic-link as fresh
 *  users; claimed profile shows the real stats". The request body is
 *  `CreateClaimInvite = z.object({ email })` (`api-v1/schemas.ts:553`); the
 *  `pc_` prefix is `CLAIM_PREFIX` (`usecases/person-claims.ts:14`) and is
 *  minted server-side, so it is not a pack field.
 *
 *  B03 §5 mints the invites; B05 accepts them. Named `claimInvites`, not
 *  `claims`, because `PackClaim` already means an assertion about a fold and
 *  one contract must not give one word two meanings. */
export const PackClaimInvite = z.strictObject({
  person: PackRef,
  email: z.email().max(200),
});
export type PackClaimInvite = z.infer<typeof PackClaimInvite>;

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
  /** NO `method`, deliberately. The engine's own `award` variant is
   *  `{kind, winner, score?}` (`packages/engine/src/core/types.ts:128-131`) —
   *  it has no `method` field at all, so a folded award outcome can never
   *  carry one. A pack writing `{kind: "award", method: "walkover"}` would
   *  parse cleanly and then be UNSATISFIABLE: the comparison reads
   *  `undefined` from the fold and reds forever. Same class as the `mtbTo`
   *  trap in header note 7, failing closed rather than open, which makes it an
   *  authoring dead end rather than a hole — and the fix is to make it
   *  unwritable. `win` keeps `method` because `MatchOutcome`'s win variant
   *  declares one (`types.ts:122`). */
  z.strictObject({
    kind: z.literal("award"),
    winner: PackRef,
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
  /** WHICH stage crowned them. Optional, and absent means "the division's
   *  outright champion" — which is all a single-stage division has to say. A
   *  multi-stage division could not previously name the stage at all, so a
   *  group winner and a knockout winner were the same unqualified claim. */
  stageRef: PackRef.optional(),
  entrant: PackRef,
});

/**
 * A stage's FINAL PLACEMENT ORDER, first to last.
 *
 * The gap this closes: `champions` gives 1st and nothing else, and
 * `expected.tables` — the only ordered block — is a HARD ERROR on a bracket
 * stage (`validate-pack.ts`'s `TABLE_STAGE_KINDS` is league/group/swiss/
 * americano). So a knockout's 2nd, 3rd, 4th … were unassertable by any block in
 * the contract, in a programme whose freeze-closing pilot (B06) is a 96-player
 * knockout and whose B05 oracle list names `finalRanks` by that name.
 *
 * The product does snapshot one for every stage kind — a bracket/ladder writes
 * a single `placementTable`-wrapped row (`usecases/stages.ts:2400-2401`, via
 * `engine-db/competition.ts:487-499`, rows from `competition/progression.ts:
 * 716-730` with the rank set and all stats zeroed) — so this is a real product
 * fact a pack can be held to, not an invented one.
 *
 * ORDER IS THE ASSERTION, and there is deliberately no per-entry `rank` field.
 * `PackExpectedTableRow` carries both and needs a refinement forcing them to
 * agree; here there is only one place to write the fact, so they cannot
 * disagree. `min(2)` because a one-entrant order says nothing `champions` does
 * not already say.
 */
export const PackExpectedFinalRanks = z.strictObject({
  divisionRef: PackRef,
  stageRef: PackRef,
  order: z.array(PackRef).min(2),
});
export type PackExpectedFinalRanks = z.infer<typeof PackExpectedFinalRanks>;

/** Names AND counts, per design §8: asserting a count alone passes for the
 *  wrong player, and asserting a name alone passes for the wrong tally. */
export const PackExpectedLeaderboardEntry = z.strictObject({
  person: PackRef,
  /** The real person's name as history records it — asserted alongside the
   *  ref so a mis-wired ref map cannot silently produce a green leaderboard. */
  name: z.string().min(1).max(200),
  count: z.number(),
});

/**
 * ONE person's rollup for one metric ACROSS THE WHOLE PACK.
 *
 * `PackExpectedLeaderboard` requires a `divisionRef`, so every person-stat
 * oracle in the contract was scoped to a single division — and two authored
 * sources ask for a cross-division one: `bench-prompts/_INDEX.md:66-68` ("a
 * player in two suites gets a career-rollup oracle") and
 * `B12-pack-badminton.md`, which owns the `personCareerStats` oracle
 * programme-wide. B12 sits well after the B06 freeze, so the alternative to
 * declaring it now is an owner escalation for a field two written prompts
 * already require.
 *
 * A SEPARATE BLOCK rather than making `divisionRef` optional, deliberately.
 * "Absent means the whole pack" is a second meaning for one field, and the
 * validator would then have to guess which meaning an author intended from
 * whether they remembered to type it. Two blocks, two questions.
 *
 * NOT derivable by summing the per-division leaderboards, which is why it has
 * to be authored: that would make the bench compute its own expected value out
 * of its other expected values, and the number the oracle asserts would stop
 * being an authored historical fact. `name` rides alongside `person` for the
 * same reason it does on a leaderboard entry — a count alone passes for the
 * wrong player.
 */
export const PackExpectedCareer = z.strictObject({
  person: PackRef,
  name: z.string().min(1).max(200),
  /** A `SportModule.playerStats` metric key. Free string, per-module and open,
   *  exactly as on a leaderboard. */
  metricKey: z.string().min(1).max(60),
  count: z.number(),
});
export type PackExpectedCareer = z.infer<typeof PackExpectedCareer>;

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
  /** A dotted path into the MODULE's folded State, compared by deep equality.
   *  Three of the event-type-less specials live here: `revisedTarget` /
   *  `targetSource` for DLS (`cricket.ts:465-466`), `expedite` for the ITTF
   *  expedite system (`setbased/kernel.ts:346`), and the deciding set's
   *  `mtb` flag for a final-set match tie-break (`ClosedSet.mtb`,
   *  `nested/kernel.ts`).
   *
   *  The root is `module.outcome`'s own state object — i.e. what `foldMatch`
   *  RETURNS. It deliberately does NOT reach the kernel's squad bookkeeping:
   *  `foldMatchWithStoppage` returns `{ state, stoppage, squads }`
   *  (`core/events.ts:464`) and `squads` is a SIBLING of `state`, not a field
   *  on it. Use the `squads` claim below for that. */
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
    field: z.enum(STANDINGS_SCALAR_FIELDS),
    equals: z.number(),
  }),
  /**
   * A number off ONE SIDE's kernel-folded squad bookkeeping —
   * `SideSquad.subsUsed` or `SideSquad.exemptUsed[<key>]`
   * (`packages/engine/src/core/lineup.ts:90-101`).
   *
   * This branch exists because the CONCUSSION SUBSTITUTE special is otherwise
   * inexpressible. It has no event type of its own: it is a generic
   * `core.lineup.replacement` charged to the named exemption string
   * `"concussion"`, and the only place that charge is observable is
   * `exemptUsed`, which the kernel returns as a field SEPARATE from the module
   * state (`foldMatchWithStoppage` -> `{ state, stoppage, squads }`,
   * `core/events.ts:464`). A `{on: "state", path: "..."}` claim can never
   * reach it. `subsUsed` is included alongside because the two are the
   * SEPARATION the exemption channel exists to express — an exempt
   * replacement deliberately does not count against `maxSubs`
   * (`lineup.ts:93-96`) — and a claim that pins only one of them cannot see a
   * replacement charged to the wrong channel.
   *
   * Addressed by ENTRANT rather than by `"home"`/`"away"`, like every other
   * claim branch; the stream's own declared `home`/`away` (header note 9)
   * makes the mapping to `SquadState`'s two sides total.
   */
  z
    .strictObject({
      on: z.literal("squads"),
      entrant: PackRef,
      field: z.enum(["subsUsed", "exemptUsed"]),
      /** The exemption KEY — `"concussion"` (cricket's cap is
       *  `lineupChanges.concussionReplacements`, `cricket.ts:103`),
       *  `"libero"` (FIVB 19.3.2.1), … Required for `exemptUsed`, and
       *  meaningless on `subsUsed`, which is a single scalar. */
      exemption: z.string().min(1).max(60).optional(),
      equals: z.number().nonnegative(),
    })
    .refine((c) => (c.field === "exemptUsed") === (c.exemption !== undefined), {
      message:
        'a squads claim on "exemptUsed" must name the exemption key, and a claim on "subsUsed" must not',
      path: ["exemption"],
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
  /** A stage's full placement order — the block `expected.tables` cannot be for
   *  a bracket. See `PackExpectedFinalRanks`. */
  finalRanks: z.array(PackExpectedFinalRanks).default([]),
  leaderboards: z.array(PackExpectedLeaderboard).default([]),
  /** Cross-division person rollups. See `PackExpectedCareer`. */
  careers: z.array(PackExpectedCareer).default([]),
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
export type PackRegistrationEntry = z.infer<typeof PackRegistrationEntry>;

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

/** NO `currency` field here — moved to `PackOrg.currency` (see its doc
 *  comment). Design §4's sketch
 *  (`designs/2026-08-27-bench-customer-journey-design.md`) lists
 *  `divisions[].registration.currency: string` per division; that line is
 *  now STALE and needs the same correction, because
 *  `db/migration/deltas/V365__org_currency.sql:70-71` DROPPED
 *  `registration_settings.currency` outright — the redesign mints one
 *  Stripe checkout session per CART, a session has ONE currency, and a cart
 *  can span divisions, so currency became a single ORG-level fact
 *  (V365 header, "RS001b"). A pack field that maps onto a column the
 *  product no longer has is exactly the "field that later reads as a real
 *  capability" failure class this repo keeps shipping — corrected here
 *  ahead of the B06 freeze rather than left for a later session to
 *  discover the hard way. */
export const PackRegistrationBlock = z.strictObject({
  category: z.enum(["open", "mens", "womens", "mixed"]),
  ageMin: z.number().int().min(0).max(120).optional(),
  ageMax: z.number().int().min(0).max(120).optional(),
  /** Gap 1 (B03r-repins-2026-09-03.md, owner ruling 2026-09-04, closed
   *  ahead of the B06 freeze): the product evaluates an age band at
   *  `age_cutoff_month`/`age_cutoff_day` of the season-start year, NOT
   *  always 1 January — `divisions.age_cutoff_month`/`age_cutoff_day`
   *  (V364/V380), `ageBandEligibilityIssues`
   *  (apps/web/src/lib/registration-rules.ts:252-326). Both independently
   *  optional and independently defaultable to 1, exactly like the product
   *  (`cutoffMonth ?? 1; cutoffDay ?? 1`, registration-rules.ts:271-272) —
   *  a pack that never sets either keeps meaning what it always meant.
   *  Range-checked only (1-12 / 1-31): the DB CHECK constraint itself does
   *  not cross-check day-per-month either (B03r-repins-2026-09-03.md FP7),
   *  so this matches the product's own laxness at the schema layer — the
   *  stage-0 mirror (`validate-pack.ts`'s `ageBandViolation`) is where an
   *  impossible combination is handled, the same split the product uses
   *  (`isValidCutoffDay` is a read-side backstop, not a parse-time
   *  rejection). */
  ageCutoffMonth: z.number().int().min(1).max(12).optional(),
  ageCutoffDay: z.number().int().min(1).max(31).optional(),
  entrantKind: PackEntrantKind,
  feeCents: z.number().int().nonnegative(),
  /** How the division COLLECTS its fee — `registration_settings.payment_method`
   *  (`RegistrationPaymentMethod`, api-v1/schemas.ts:2292). Defaulted to
   *  "offline" to match the product's own PUT default
   *  (schemas.ts:2334), so every pack written before this field existed keeps
   *  meaning exactly what it meant.
   *
   *  This is not cosmetic and it is not inferrable. `resumeRegistrationCheckout`
   *  refuses to mint a Checkout session unless the division's method is
   *  "stripe" (usecases/registrations.ts:4365), so a pack that declares
   *  `feeCents > 0` and `pay: true` but leaves this at "offline" configures a
   *  division that takes money by bank transfer and then asks Stripe to charge
   *  a card for it. Before this field existed the bench had no way to say
   *  "stripe" at all — the driver's PUT omitted the key, the product defaulted
   *  it to "offline", and `payViaCheckout` was therefore unreachable from any
   *  pack: written, typed, unit-green, and never once executed. Stage-0 rule 7
   *  (`validate-pack.ts`) is what keeps it from going quiet again.
   *
   *  Deliberately NOT derived from `feeCents > 0`: a paid division collecting
   *  offline is a real, shipped product configuration (`payment_instructions`
   *  exists for exactly that), so inferring the method would make that case
   *  unrepresentable. The pack says which one it means. */
  paymentMethod: z.enum(["offline", "stripe"]).default("offline"),
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
  /**
   * FROZEN AT 1 UNTIL THE B06 FREEZE; bumped by any change after it.
   *
   * The rule this comment used to state — "bumped by ANY change to this
   * contract" — was already false when it was written, and a later session
   * would have read it as a rule and been wrong about what version 1 means.
   * This branch made a BREAKING change under it: removing `method` from the
   * `award` outcome variant, which (the union members being `strictObject`s)
   * makes a pack that wrote `{kind:"award", method:"walkover"}` fail to parse.
   * Harmless in practice, because `_tiny.json` is the only pack in existence
   * and moved with the schema — but the discipline the comment claimed was not
   * being kept.
   *
   * So the honest rule, for the window this contract is still being designed
   * in: version 1 means "the pre-freeze shape, whatever it currently is", and
   * every pack in the tree moves with it. After B06 closes the freeze, an
   * additive change is an owner escalation and a BREAKING one bumps this
   * literal — at which point it becomes the only migration signal the contract
   * has, and a pack authored against an older shape fails loudly instead of
   * parsing into a different meaning.
   */
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
  // ---- PRE-FREEZE RESERVATIONS (see the block above each type) ----
  venues: z.array(PackVenue).optional(),
  officials: z.array(PackOfficial).optional(),
  claimInvites: z.array(PackClaimInvite).optional(),
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

/** The ref kinds that share the `@` sigil's ONE namespace.
 *
 *  A closed union, not a loose string, so every table keyed by a ref kind is
 *  checked against it — see `DUPLICATE_REF_REASON` below, where a typo'd key
 *  used to yield silently no reason at all.
 *
 *  A type rather than an `as const` array: nothing iterates the kinds at
 *  runtime (`collectSigilRefs` walks the pack, not this list), and an array
 *  used only as a type is dead weight lint correctly objects to. Adding a
 *  kind means adding it here AND to `collectSigilRefs` — the union is what
 *  makes the second half impossible to forget, because the walk's `kind`
 *  field is typed by it. */
export type PackRefKind = "person" | "entrant" | "venue" | "court" | "official";

/** One declared ref, with the kind that declared it and where it sits. */
interface DeclaredRef {
  ref: string;
  kind: PackRefKind;
  at: (string | number)[];
}

/**
 * THE walk over every ref the `@` sigil can resolve. Genuinely one function,
 * not three that agree: uniqueness (`checkRefsUnique`), the broad resolver for
 * the opaque blocks, and the narrow venue/court resolver for `scheduleConfig`
 * are all built from this list.
 *
 * That matters for the NEXT session rather than this one. B03r adds ref kinds
 * (claim invites, registration entries). Registering a kind here registers it
 * for uniqueness AND for both resolvers at once — whereas with three separate
 * walks, adding it to the uniqueness pass alone would leave a legitimate
 * `@claimInvite` inside `cfgOverrides` unresolvable, with the error pointing at
 * the author's ref rather than at the missing registration.
 */
function collectSigilRefs(p: PackShapeOut): DeclaredRef[] {
  const out: DeclaredRef[] = [];
  p.persons.forEach((x, i) => out.push({ ref: x.ref, kind: "person", at: ["persons", i, "ref"] }));
  p.entrants.forEach((x, i) => out.push({ ref: x.ref, kind: "entrant", at: ["entrants", i, "ref"] }));
  p.venues?.forEach((v, i) => {
    out.push({ ref: v.ref, kind: "venue", at: ["venues", i, "ref"] });
    v.courts.forEach((c, j) =>
      out.push({ ref: c.ref, kind: "court", at: ["venues", i, "courts", j, "ref"] }),
    );
  });
  p.officials?.forEach((o, i) => out.push({ ref: o.ref, kind: "official", at: ["officials", i, "ref"] }));
  return out;
}

/** The refs a resolver may accept — every kind, or just the named ones. Both
 *  callers read the SAME walk, so a narrowing is a filter over one truth
 *  rather than a second, hand-maintained membership. */
function sigilNamespace(p: PackShapeOut, kinds?: readonly PackRefKind[]): Set<string> {
  const want = kinds === undefined ? undefined : new Set<PackRefKind>(kinds);
  const refs = new Set<string>();
  for (const declared of collectSigilRefs(p)) {
    if (want === undefined || want.has(declared.kind)) refs.add(declared.ref);
  }
  return refs;
}

/** "a entrant" is not a message, it is a defect wearing one. */
const article = (word: string): string => (/^[aeiou]/i.test(word) ? "an" : "a");

/** Why a same-kind duplicate matters, where the reason is not obvious from the
 *  word "duplicate" alone. Court refs earn one: two venues each holding a
 *  "court-1" is a perfectly reasonable thing to write, and the reason it is
 *  refused lives in a different file's field.
 *
 *  `Partial<Record<PackRefKind, …>>`, not `Record<string, …>`: a mistyped key
 *  ("courts", "Court") used to compile fine and silently produce no reason,
 *  which is the same failure the provenance seed table was rewritten to avoid.
 *  Partial rather than total because most kinds need no extra explanation —
 *  the point is that a key that IS present must name a real kind. */
const DUPLICATE_REF_REASON: Readonly<Partial<Record<PackRefKind, string>>> = {
  court:
    " — court refs are unique across ALL venues, because a division's scheduleConfig names them unqualified",
};

/** ONE namespace for every ref the `@` sigil can resolve, plus the two
 *  ref kinds it cannot.
 *
 *  THE SIGIL HAS NO KIND. Header note 6 promises the seeding layer rewrites
 *  every `@`-prefixed string in one pass, and it has no way to know whether
 *  `"@c1"` was meant as an entrant or a court — a payload `@`-ref resolves
 *  against entrants ∪ persons (`checkStreams`), while a `scheduleConfig`
 *  `@`-ref resolves against courts ∪ venues (`checkReservations`). Two
 *  resolution tables over one syntax is exactly the per-location table note 6
 *  exists to avoid: with per-kind uniqueness only, an entrant `ref: "c1"` and
 *  a court `ref: "c1"` both parse clean, and the rewriter turns
 *  `scheduleConfig.courts: ["@c1"]` into an entrant UUID and hands it to the
 *  scheduler as a court. Nothing reds, at any layer.
 *
 *  So persons, entrants, venues, courts and officials share ONE flat
 *  namespace. A duplicate inside one kind and a collision across two kinds are
 *  reported differently, because they are different authoring mistakes.
 *
 *  Divisions and stages are deliberately NOT in it: they are addressed only
 *  through typed fields (`divisionRef`, `stageRef`, `registration.byDivision`'s
 *  keys), never through the sigil, so they cannot take part in a sigil
 *  collision. **If a future field ever `@`-references a division or a stage,
 *  it must join this namespace** — that is the whole rule, and it is cheaper
 *  to honour than to rediscover. */
function checkRefsUnique(p: PackShapeOut, ctx: Ctx): void {
  // Division and stage refs: their own namespace, unique per scope.
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

  // The sigil-resolvable namespace, walked in one pass so a collision is
  // reported wherever the SECOND use appears.
  //
  // OFFICIALS ARE IN IT PRE-EMPTIVELY. Nothing resolves an `@official` today —
  // an official is reached through `officials[].ref` and typed assignment
  // fields, never through the sigil. They are held here anyway because this
  // contract freezes at the end of B06 and the cost of joining later is an
  // owner escalation, while the cost of joining now is that an official may
  // not share a name with a court. The stated reason below is literally true
  // of persons, entrants, venues and courts; for officials it is insurance.
  const claimed = new Map<string, PackRefKind>(); // ref -> the kind that took it
  const take = (ref: string, kind: PackRefKind, at: (string | number)[]): void => {
    const owner = claimed.get(ref);
    if (owner === kind) {
      issue(ctx, at, `duplicate ${kind} ref "${ref}"${DUPLICATE_REF_REASON[kind] ?? ""}`);
      return;
    }
    if (owner !== undefined) {
      issue(
        ctx,
        at,
        `ref "${ref}" is already used by ${article(owner)} ${owner} — persons, entrants, venues, courts and ` +
          `officials share ONE ref namespace, because an @-prefixed reference carries no kind and the seeding ` +
          `layer resolves it in a single pass`,
      );
      return;
    }
    claimed.set(ref, kind);
  };

  for (const declared of collectSigilRefs(p)) take(declared.ref, declared.kind, declared.at);
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
  const stagesByDivisionRef = new Map<string, Set<string>>(
    p.divisions.map((d) => [d.ref, new Set(d.stages.map((st) => st.ref))]),
  );
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
    // Read off the exhaustive map rather than tested with a predicate, so a
    // future provenance value cannot silently inherit either answer.
    if (s.reconstruction !== undefined && !SEED_LEGAL_BY_PROVENANCE[s.provenance]) {
      // Both halves derived — the offending value from the stream, the
      // permitted list from the same table the guard just read.
      issue(ctx, ["streams", i, "reconstruction"], seedRefusalMessage(s.provenance, SEED_LEGAL_BY_PROVENANCE));
    }
    // The stage a stream names must belong to the stream's OWN division.
    // Division-scoped rather than global: stage refs are only unique within a
    // division (they are not in the `@`-sigil namespace, see
    // `checkRefsUnique`), so a global check would accept a neighbouring
    // division's stage and bind the fixture to the wrong points rule, pool and
    // decider overlay.
    if (s.stageRef !== undefined) {
      const stageRefs = stagesByDivisionRef.get(s.divisionRef) ?? new Set<string>();
      if (!stageRefs.has(s.stageRef)) {
        issue(
          ctx,
          ["streams", i, "stageRef"],
          `unknown stage ref "${s.stageRef}" for division "${s.divisionRef}"`,
        );
      }
    }
    const entrantRefs = entrantsByDivision.get(s.divisionRef) ?? new Set<string>();

    // Header note 9 — the sides. Without these the fold's required LineupPair
    // has to be re-derived from the scheduling generator.
    for (const side of ["home", "away"] as const) {
      if (!entrantRefs.has(s[side])) {
        issue(ctx, ["streams", i, side], `unknown entrant ref "${s[side]}" for division "${s.divisionRef}"`);
      }
    }
    if (s.home === s.away) {
      issue(ctx, ["streams", i, "away"], `a fixture cannot have "${s.home}" on both sides`);
    }

    // Per-fixture team sheets, where the record gives them.
    if (s.lineups !== undefined) {
      for (const side of ["home", "away"] as const) {
        const slots = s.lineups[side];
        const seenPerson = new Set<string>();
        const seenSquad = new Set<number>();
        const seenOrder = new Set<number>();
        slots.forEach((slot, j) => {
          const at = ["streams", i, "lineups", side, j] as (string | number)[];
          // A lineup MAY name a person who was never on the roster — the
          // product allows exactly that (api-v1 `CreateEntrant`/`PutLineup`'s
          // `eligibility_override`: "a lineup can name a person who was never
          // gated at roster time"). So the check is that the pack DECLARED
          // them, not that they are rostered.
          if (!personRefs.has(slot.person)) {
            issue(ctx, [...at, "person"], `unknown person ref "${slot.person}"`);
          }
          if (seenPerson.has(slot.person)) {
            issue(ctx, [...at, "person"], `person "${slot.person}" appears twice on the ${side} sheet`);
          }
          seenPerson.add(slot.person);
          if (slot.squadNumber !== undefined) {
            if (seenSquad.has(slot.squadNumber)) {
              issue(ctx, [...at, "squadNumber"], `duplicate squad number ${slot.squadNumber} on the ${side} sheet`);
            }
            seenSquad.add(slot.squadNumber);
          }
          if (slot.orderNo !== undefined) {
            if (seenOrder.has(slot.orderNo)) {
              issue(ctx, [...at, "orderNo"], `duplicate orderNo ${slot.orderNo} on the ${side} sheet`);
            }
            seenOrder.add(slot.orderNo);
          }
        });
      }
    }

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
    // The two sides this fixture's stream declares (header note 9), used to
    // scope perSide below. Undefined only when the stream is missing, which
    // the fixtureExtKey check above has already reported.
    const stream = p.streams.find(
      (st) => fixtureKey(st.divisionRef, st.fixtureExtKey) === fixtureKey(m.divisionRef, m.fixtureExtKey),
    );
    if (m.perSide !== undefined && stream !== undefined) {
      // perSide is [home, away], in the stream's own declared order. This is a
      // PACK convention, not an engine one — `ScoreSummary.perSide`'s order is
      // not contractual, so a validator must match the module's summary by
      // ENTRANT, never by index. Its job here is to pin the fixture's
      // orientation in a second place: a stream whose sides were flipped (the
      // even-leg mirror, header note 9) then contradicts its own score lines
      // instead of quietly asserting the wrong winner.
      if (m.perSide.length !== 2) {
        issue(ctx, [...base, "perSide"], `perSide names ${m.perSide.length} sides; a fixture has exactly two`);
      } else if (m.perSide[0]?.entrant !== stream.home || m.perSide[1]?.entrant !== stream.away) {
        issue(
          ctx,
          [...base, "perSide"],
          `perSide is [home, away] — expected ["${stream.home}", "${stream.away}"], got ` +
            `[${m.perSide.map((x) => `"${x.entrant}"`).join(", ")}]`,
        );
      }
    }
    m.perSide?.forEach((side, j) => {
      if (!entrantIn(m.divisionRef, side.entrant)) {
        issue(ctx, [...base, "perSide", j, "entrant"], `unknown entrant ref "${side.entrant}" for division "${m.divisionRef}"`);
      } else if (stream !== undefined && side.entrant !== stream.home && side.entrant !== stream.away) {
        // A score line for an entrant that did not play this fixture is an
        // oracle about the wrong match. Reachable in a real pack: entrant refs
        // are division-scoped, so a copy-paste from the neighbouring fixture
        // resolves fine and asserts nothing true.
        issue(
          ctx,
          [...base, "perSide", j, "entrant"],
          `entrant "${side.entrant}" did not play fixture "${m.fixtureExtKey}" — its sides are "${stream.home}" and "${stream.away}"`,
        );
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
  /** Stage-scoped champions only: (division, stage) -> the entrant crowned.
   *  A division-scoped champion (no `stageRef`) is deliberately NOT collected —
   *  see the finalRanks check below. */
  const stageChampion = new Map<string, string>();
  p.expected.champions.forEach((c, i) => {
    const base: (string | number)[] = ["expected", "champions", i];
    if (!checkDivision(base, c.divisionRef)) return;
    // Scoped by STAGE where one is named, so a group winner and a knockout
    // winner are two claims rather than a duplicate.
    const scope = `${c.divisionRef}\u0000${c.stageRef ?? ""}`;
    if (championed.has(scope)) {
      issue(
        ctx,
        [...base, "divisionRef"],
        c.stageRef === undefined
          ? `division "${c.divisionRef}" declares more than one champion`
          : `division "${c.divisionRef}" declares more than one champion for stage "${c.stageRef}"`,
      );
    }
    championed.add(scope);
    if (c.stageRef !== undefined) stageChampion.set(fixtureKey(c.divisionRef, c.stageRef), c.entrant);
    if (c.stageRef !== undefined && !(stagesByDivision.get(c.divisionRef) ?? new Set<string>()).has(c.stageRef)) {
      issue(ctx, [...base, "stageRef"], `unknown stage ref "${c.stageRef}" for division "${c.divisionRef}"`);
    }
    if (!entrantIn(c.divisionRef, c.entrant)) {
      issue(ctx, [...base, "entrant"], `unknown entrant ref "${c.entrant}" for division "${c.divisionRef}"`);
    }
  });

  // A stage's placement ORDER. Every ref an entrant of that division, no
  // entrant twice, one order per stage — and, where the stage ALSO declares a
  // table, the two orders must agree. That last rule is anti-contradiction,
  // not an oracle: a pack must not state one fact in two blocks and have them
  // disagree, exactly as `rank` must equal its row's position and `perSide`
  // must be `[home, away]`.
  const ranked = new Set<string>();
  const tableOrderOf = new Map<string, string[]>();
  for (const table of p.expected.tables) {
    if (table.poolKey !== undefined) continue; // a pool table orders a pool, not the stage
    tableOrderOf.set(fixtureKey(table.divisionRef, table.stageRef), table.rows.map((r) => r.entrant));
  }
  p.expected.finalRanks.forEach((fr, i) => {
    const base: (string | number)[] = ["expected", "finalRanks", i];
    if (!checkDivision(base, fr.divisionRef)) return;
    if (!(stagesByDivision.get(fr.divisionRef) ?? new Set<string>()).has(fr.stageRef)) {
      issue(ctx, [...base, "stageRef"], `unknown stage ref "${fr.stageRef}" for division "${fr.divisionRef}"`);
    }
    const scope = fixtureKey(fr.divisionRef, fr.stageRef);
    if (ranked.has(scope)) {
      issue(ctx, base, `stage "${fr.stageRef}" of division "${fr.divisionRef}" declares more than one final order`);
    }
    ranked.add(scope);
    const seen = new Set<string>();
    fr.order.forEach((ref, j) => {
      if (!entrantIn(fr.divisionRef, ref)) {
        issue(ctx, [...base, "order", j], `unknown entrant ref "${ref}" for division "${fr.divisionRef}"`);
      }
      if (seen.has(ref)) {
        issue(ctx, [...base, "order", j], `entrant "${ref}" is placed twice in this final order`);
      }
      seen.add(ref);
    });
    // The pair that ALWAYS coexists on the kind this block exists for. The
    // table rule below covers a pair that can NEVER coexist there —
    // `expected.tables` is a hard error on a bracket stage — so without this a
    // knockout could say `champions: e-alpha` and, two lines later,
    // `finalRanks.order: [e-bravo, …]`, and parse clean. Which is B06's exact
    // shape: a champion and a placement order and no table at all.
    //
    // STAGE-SCOPED champions only. A division-scoped champion is the OVERALL
    // winner of a multi-stage division and need not be any particular stage's
    // first place, so comparing it would be the over-refusal the pool-table
    // exclusion above was careful to avoid.
    const champion = stageChampion.get(scope);
    if (champion !== undefined && fr.order[0] !== champion) {
      issue(
        ctx,
        [...base, "order", 0],
        `stage "${fr.stageRef}" crowns "${champion}" but its final order starts with ` +
          `"${fr.order[0]}" — a champion IS first place, and one fact stated in two blocks ` +
          `must not disagree`,
      );
    }
    const table = tableOrderOf.get(scope);
    if (table !== undefined && table.join("\u0000") !== fr.order.join("\u0000")) {
      issue(
        ctx,
        [...base, "order"],
        `stage "${fr.stageRef}" declares BOTH an expected table and a final order, and they disagree — ` +
          `the table ranks [${table.join(", ")}], this order says [${fr.order.join(", ")}]. One fact, one answer. ` +
            `The comparison is EXACT, so where a stage carries a table the order must be complete — a ` +
            `published top-three beside a full league table is refused here rather than half-checked`,
      );
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

  // Cross-division career rollups: the person exists, and one (person, metric)
  // is claimed once. Two rows for the same pair are a contradiction, not two
  // oracles.
  const claimedCareer = new Set<string>();
  p.expected.careers.forEach((c, i) => {
    const base: (string | number)[] = ["expected", "careers", i];
    if (!personRefs.has(c.person)) {
      issue(ctx, [...base, "person"], `unknown person ref "${c.person}"`);
    }
    const key = fixtureKey(c.person, c.metricKey);
    if (claimedCareer.has(key)) {
      issue(ctx, base, `person "${c.person}" declares metric "${c.metricKey}" twice`);
    }
    claimedCareer.add(key);
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
      } else if (claim.on === "standings" || claim.on === "squads") {
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

/** The pre-freeze reservations: venues/courts, officials, claim invites, and
 *  the `@`-sigilled court refs inside a division's opaque `scheduleConfig`.
 *
 *  These rules ship WITH the shapes rather than after them. A declared block
 *  with no rules and no tests is the inert-seam failure this programme keeps
 *  shipping — the shape exists, nothing exercises it, and the first session to
 *  populate it discovers the contract never meant anything. */
function checkReservations(p: PackShapeOut, ctx: Ctx): void {
  const personLane = new Map(p.persons.map((person) => [person.ref, person.lane]));
  const streamKeys = new Set(p.streams.map((st) => fixtureKey(st.divisionRef, st.fixtureExtKey)));

  // ---- venues and courts ----
  // Uniqueness itself is `checkRefsUnique`'s job: court and venue refs live in
  // the ONE sigil-resolvable namespace alongside persons, entrants and
  // officials, so a court sharing a ref with another court — or with an
  // entrant — is reported there, once. This pass only needs the sets, to
  // resolve the @-refs below.
  // NARROWED from the same walk `checkRefsUnique` uses, never re-derived: a
  // scheduleConfig ref is a place, so it resolves against venues and courts
  // only. A filter over one truth, not a second membership.
  const placeRefs = sigilNamespace(p, ["venue", "court"]);

  // ---- @-sigilled court/venue refs inside the opaque scheduleConfig ----
  const knownPlace = (ref: string): boolean => placeRefs.has(ref);
  p.divisions.forEach((d, i) => {
    if (d.scheduleConfig === undefined) return;
    const bad: string[] = [];
    unresolvedPayloadRefs(d.scheduleConfig, knownPlace, bad);
    for (const ref of bad) {
      issue(
        ctx,
        ["divisions", i, "scheduleConfig"],
        `unknown pack ref "${ref}" — an @-prefixed string in scheduleConfig must name a declared venue or court`,
      );
    }
  });

  // ---- the OTHER opaque blocks ----
  // `cfgOverrides` and `stages[].config` are carried verbatim (header note on
  // PackDivision), which means nothing type-checks their contents — and until
  // now nothing scanned them for `@`-refs either. A typo'd `@ref` in either
  // block was silently passed through to the seeding layer, which would fail
  // to rewrite it and hand the engine a literal "@e-alpah" string. Same class
  // as the cross-kind collision: a sigil that resolves to nothing, with
  // nothing red.
  //
  // Checked against the WHOLE shared namespace rather than a narrower set, on
  // purpose. A payload ref is narrowed to its own division's entrants and a
  // scheduleConfig ref to venues/courts, because in both cases an authored
  // source says which kinds belong there. No authored source says what a cfg
  // blob may reference, so the honest check is "it must resolve to something
  // declared" — which catches the typo this exists for without inventing a
  // constraint that a later sport's cfg might legitimately break.
  const declared = sigilNamespace(p);
  const knownRef = (ref: string): boolean => declared.has(ref);
  const scanOpaque = (block: PackJsonValue | undefined, at: (string | number)[], what: string): void => {
    if (block === undefined) return;
    const bad: string[] = [];
    unresolvedPayloadRefs(block, knownRef, bad);
    for (const ref of bad) {
      issue(
        ctx,
        at,
        `unknown pack ref "${ref}" — an @-prefixed string in ${what} must name a declared person, entrant, ` +
          `venue, court or official. There is deliberately no escape for a literal leading "@" (header note 6): ` +
          `if this value really is meant to start with one, that is an owner escalation, not something to work around`,
      );
    }
  };
  p.divisions.forEach((d, i) => {
    scanOpaque(d.cfgOverrides, ["divisions", i, "cfgOverrides"], "cfgOverrides");
    d.stages.forEach((st, j) => {
      scanOpaque(st.config, ["divisions", i, "stages", j, "config"], "a stage's config");
      scanOpaque(st.progression, ["divisions", i, "stages", j, "progression"], "a stage's progression");
    });
  });

  // ---- officials ----
  // Ref uniqueness is `checkRefsUnique`'s job, exactly as for venues and
  // courts above. This pass keeping its own copy meant a duplicate official
  // ref was reported TWICE at the same path, contradicting the comment above
  // that says "once" — and nothing asserted the message, so no test saw it.
  p.officials?.forEach((o, i) => {
    const lane = personLane.get(o.person);
    if (lane === undefined) {
      issue(ctx, ["officials", i, "person"], `unknown person ref "${o.person}"`);
    } else if (lane !== "official") {
      issue(ctx, ["officials", i, "person"], `person "${o.person}" is lane "${lane}" — an official must be a person in the "official" lane`);
    }
    const roleKeys = new Set(o.roleKeys);
    const seenDate = new Set<string>();
    o.unavailable.forEach((u, j) => {
      // Mirrors `unique (official_id, date)` on official_availability (V284).
      if (seenDate.has(u.date)) {
        issue(ctx, ["officials", i, "unavailable", j, "date"], `official "${o.ref}" declares ${u.date} unavailable twice`);
      }
      seenDate.add(u.date);
    });
    o.assignments.forEach((a, j) => {
      if (!streamKeys.has(fixtureKey(a.divisionRef, a.fixtureExtKey))) {
        issue(ctx, ["officials", i, "assignments", j, "fixtureExtKey"], `no stream declares fixture "${a.fixtureExtKey}" in division "${a.divisionRef}"`);
      }
      if (a.roleKey !== undefined && !roleKeys.has(a.roleKey)) {
        issue(ctx, ["officials", i, "assignments", j, "roleKey"], `official "${o.ref}" is not declared for role "${a.roleKey}" (declares ${[...roleKeys].join(", ")})`);
      }
    });
  });

  // ---- claim invites ----
  const claimedPersons = new Set<string>();
  const claimedEmails = new Set<string>();
  p.claimInvites?.forEach((c, i) => {
    if (!personLane.has(c.person)) {
      issue(ctx, ["claimInvites", i, "person"], `unknown person ref "${c.person}"`);
    }
    if (claimedPersons.has(c.person)) {
      issue(ctx, ["claimInvites", i, "person"], `person "${c.person}" already has a claim invite`);
    }
    claimedPersons.add(c.person);
    const email = c.email.toLowerCase();
    if (claimedEmails.has(email)) {
      // One email accepts one magic-link identity; two invites to it would
      // race for the same fresh user (design §9 P2's accept flow).
      issue(ctx, ["claimInvites", i, "email"], `email "${c.email}" is invited twice`);
    }
    claimedEmails.add(email);
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

/**
 * THE entrants of one division, in pack order.
 *
 * One exported selector because there were four hand-rolled copies of
 * `pack.entrants.filter(e => e.divisionRef === …)` — in the template strip, the
 * runner's fixture-count derivation, stage 0's stream-count cross-check and the
 * `_tiny` seed plan — all agreeing today. The ARITHMETIC they feed was
 * deliberately unified below with a comment saying two copies of one rule is
 * the parallel-vocabulary defect; the SELECTOR feeding it was left forked in
 * four places, which is the same defect one step earlier. A division filter
 * that drifted in one of the four would mint a different fixture count in the
 * runner than the validator warned about.
 */
export function entrantsOfDivision(
  entrants: readonly PackEntrant[],
  divisionRef: string,
): PackEntrant[] {
  return entrants.filter((e) => e.divisionRef === divisionRef);
}

/**
 * How many fixtures a circle-method round robin mints for `entrants` over
 * `legs` — every pair meets once per leg, and an odd field's bye is not a
 * fixture (`packages/engine/src/scheduling/roundrobin.ts`).
 *
 * Here, in the contract file, rather than beside either of its two callers:
 * `lib/pack-io.ts` derives a runner's expected fixture count from it and
 * `lib/validate-pack.ts` warns when a pack's own stream count disagrees with
 * it, and two copies of one arithmetic is the parallel-vocabulary defect. The
 * REFUSALS (a non-league stage, a leg count past the product's clamp) stay with
 * the caller that has an author to talk to; this is only the arithmetic.
 */
export function roundRobinFixtureCount(entrants: number, legs: number): number {
  return ((entrants * (entrants - 1)) / 2) * legs;
}

export const PackSchema = PackShape.superRefine((p, ctx) => {
  checkRefsUnique(p, ctx);
  checkEntrantDivisions(p, ctx);
  checkRosters(p, ctx);
  checkStageEntrantRefs(p, ctx);
  checkStreams(p, ctx);
  checkExpected(p, ctx);
  checkHistoricalAssignment(p, ctx);
  checkReservations(p, ctx);
  checkSources(p, ctx);
  checkRegistration(p, ctx);
});

export type Pack = z.infer<typeof PackSchema>;
