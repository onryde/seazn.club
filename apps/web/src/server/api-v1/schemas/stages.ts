// /api/v1 contracts — stages: take/progression rules (+ engine twins), stage config, court tags, stage and fixture rules, table-stage rules, standings, templates.
// One module of the schemas/ folder; ./index.ts is the map and the public surface. Pure zod (loads bare under
// `node --experimental-strip-types`): relative imports carry an explicit `.ts`, types come in through `import type`.
import { z } from "zod";
// Type-only (erased under strip-types, so openapi-gen.ts still loads this
// file bare): the TakeRuleSchema tie below compares against it.
import type { OutcomeKey, TableRulesSource, TakeRule, TieBreakNote } from "@seazn/engine/competition";
import type { PartialScheduleKey, TiebreakerKey } from "@seazn/engine/sport";
// W2c Task 13: a stage's own points ARE the engine's PointsRule (the owner of the shape), reused rather than restated —
// `@seazn/engine/competition` loads bare under strip-types, as `@seazn/engine/core` does above.
import { PointsRule } from "@seazn/engine/competition";
// W3 T18 (RB3-7(c)): the sentence a requested half/zero bye is refused with — the table's own constant (client-safe and
// strip-types-safe: its only import is `import type`), so this schema, `http.ts`'s reader and the table row say one thing.
import { SWISS_REQUESTED_BYES_DEFERRED_MESSAGE } from "../../../lib/swiss-refusals.ts";
// W4 T7 (RB4-D9, X-SD-10): the same pattern for a country-separation request — the knockout table owns the sentence.
import { COUNTRY_SEPARATION_NOT_OFFERED_MESSAGE } from "../../../lib/knockout-refusals.ts";
// Match Day D1: the format fields' bounds, shared with the division builder and the Format dialog (FMT5). Import-free,
// so the standalone generator loads it like the files above.
import { FORMAT_BOUNDS } from "../../../lib/format-bounds.ts";
// W2c Task 13b finish-up (R-13b-1) — the deciders a stage config refuses at its top level, the engine's own set (shared
// with the create door). RELATIVE with `.ts`; the module's only imports are the bare engine packages, which load under
// strip-types as the engine imports above do.
import { TOP_LEVEL_STAGE_DECIDERS } from "../../../lib/top-level-stage-deciders.ts";
import { Uuid, StageKind, RequiredCourtTags, VenueId, CourtId, Visibility, Slug } from "./common.ts";
import { checkDateOrder, PublicQuotaDegraded } from "./competitions.ts";
import { TiebreakerKeyS } from "./divisions.ts";

// ---------------------------------------------------------------------------
// Stages
// ---------------------------------------------------------------------------

// F2 (unified progression field) — one ProgressionSchema replaces the two
// prior vocabularies: QualificationSpecSchema (topN | bestOfRank |
// losersOfRound | take/picks | combine, auto-seed-on-complete only) and
// StageSeedingSchema (rankRange | topNPerGroup | bestNth, source/take/
// placement/map, TBD-at-setup + propose/confirm). Mirrors the plain-TS shape
// in @seazn/engine/competition (TakeRule/ProgressionSource/SeededMapEntry)
// field-for-field — usecases import THOSE types, not these zod schemas, so a
// shape drift here would 400 at the edge. TakeRule is no longer kept in step
// by hand: the compile-time tie under TakeRuleSchema fails tsc on a drift in
// either direction (ruling 55, CL-R2).
//
// Collapse (owner ruling 4, F2 plan Decision 2): `rankRange` survives `topN`
// (topN:n IS rankRange{from:1,to:n}); `bestNth` survives `bestOfRank`,
// absorbing its `normaliseUnequalPools` field (Decision 2b — the merged rule
// still refuses unequal pool sizes by default; setting the flag silences the
// refusal, carried forward as a documented, production-unreachable gap, not
// newly closed here). `picks`/`roundLosers` are qualification's
// TakePicks/RoundLosers, unchanged in meaning, given the kind-tagged shape
// the rest of this union already uses. `take[].pool` / `picks[].pool` match
// the pool KEY ("A"); the display name ("Pool A") is also accepted — the
// engine normalises.
const PoolRankPickS = z.object({ pool: z.string().min(1), rank: z.number().int().min(1) }).strict();
const RankRangeTakeS = z
  .object({ kind: z.literal("rankRange"), from: z.number().int().min(1), to: z.number().int().min(1) })
  .strict()
  .refine((t) => t.to >= t.from, { message: "rankRange: to must be >= from", path: ["to"] });
const TopNPerGroupTakeS = z.object({ kind: z.literal("topNPerGroup"), n: z.number().int().min(1).max(16) }).strict();
const BestNthTakeS = z
  .object({
    kind: z.literal("bestNth"),
    nth: z.number().int().min(1),
    count: z.number().int().min(1),
    normaliseUnequalPools: z.boolean().optional(),
  })
  .strict();
const PicksTakeS = z.object({ kind: z.literal("picks"), picks: z.array(PoolRankPickS).min(1) }).strict();
// L3/#414 — losers of a completed bracket round (KO->plate, qualifying-KO
// wildcards). `round` is a bracket-wiring label, never an arithmetic
// quantity (rounds number sparsely — see progression.ts's roundLosers).
// `count` is REQUIRED, mirroring the engine exactly: `progressionSize` reads
// `roundLosers.count` unconditionally, so an optional count here would let a
// malformed spec 400 loudly at create time only to 500 later, deep inside a
// read path that must never throw.
const RoundLosersTakeS = z
  .object({ kind: z.literal("roundLosers"), round: z.number().int().min(1), count: z.number().int().min(1) })
  .strict();
export const TakeRuleSchema = z.union([RankRangeTakeS, TopNPerGroupTakeS, BestNthTakeS, PicksTakeS, RoundLosersTakeS]);

// The single-source tie (ruling 55, CL-R2): what this schema parses and the
// engine's TakeRule must be assignable BOTH ways. One direction alone is not
// enough — wire→engine fails only for a schema that is too LOOSE (a wider
// field, an extra kind); engine→wire fails only for one that is too STRICT
// (a missing kind, a required field the engine has as optional).
//
// Compared twice. (1) Deep-readonly on both sides, because zod infers
// mutable arrays where the engine declares `readonly PoolRankPick[]` —
// mutability is not a wire property. (2) Additionally with every optional
// made required, because plain assignability cannot see an OPTIONAL field
// that exists on one side only (`normaliseUnequalPools` dropped from the
// schema would pass (1) in both directions).
//
// Value-level rules (min/max/int, .strict(), the rankRange refine) are
// runtime and invisible here; __tests__/take-rule-schema.test.ts parses every
// shipped template's take rules through this schema for that half.
type WireDeepReadonly<T> = T extends readonly (infer E)[]
  ? readonly WireDeepReadonly<E>[]
  : T extends object
    ? { readonly [K in keyof T]: WireDeepReadonly<T[K]> }
    : T;
type WireDeepRequired<T> = T extends readonly (infer E)[]
  ? readonly WireDeepRequired<E>[]
  : T extends object
    ? { readonly [K in keyof T]-?: WireDeepRequired<Exclude<T[K], undefined>> }
    : T;
type MutuallyAssignable<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;
type AssertTrue<T extends true> = T;
type TakeRuleWire = z.infer<typeof TakeRuleSchema>;
// Engine 5.0.0 added `{ kind: "firstLosses" }` (the plate feed). The wire stays CLOSED to it on purpose: nothing in the
// app can resolve that take yet (app B's T7 does, and admits `FirstLossesTakeS` then), so accepting it now would open an
// input the resolver cannot handle. The tie is therefore against the engine's TakeRule MINUS that member; a member the
// engine adds beyond it still fails tsc here.
type WireTakeRule = Exclude<TakeRule, { kind: "firstLosses" }>;
export type TakeRuleSchemaMatchesEngine = AssertTrue<
  MutuallyAssignable<WireDeepReadonly<TakeRuleWire>, WireDeepReadonly<WireTakeRule>>
>;
export type TakeRuleSchemaMatchesEngineFields = AssertTrue<
  MutuallyAssignable<WireDeepRequired<TakeRuleWire>, WireDeepRequired<WireTakeRule>>
>;

// W2d (m8): the API's tie-break vocabularies are the engine's declared ones, exactly — a key or note added to the
// engine's `TiebreakerKey`, `PartialScheduleKey` or `TieBreakNote` that the wire cannot name fails `tsc`. It binds the
// declarations, not each writer: a standings row's `tieBreak.key` is typed `string` in the engine (`markTieBreak`).
export type TiebreakerKeySchemaMatchesEngine = AssertTrue<MutuallyAssignable<z.infer<typeof TiebreakerKeyS>, TiebreakerKey>>;
export type TieBreakKeySchemaMatchesEngine = AssertTrue<MutuallyAssignable<z.infer<typeof TieBreakKeyS>, PartialScheduleKey>>;
export type TieBreakNoteSchemaMatchesEngine = AssertTrue<MutuallyAssignable<z.infer<typeof TieBreakNoteS>, TieBreakNote>>;
export type TableRulesSourceSchemaMatchesEngine = AssertTrue<MutuallyAssignable<z.infer<typeof TableRulesSourceS>, TableRulesSource>>;
export type OutcomeKeySchemaMatchesEngine = AssertTrue<
  MutuallyAssignable<(typeof FIXED_OUTCOME_KEYS)[number], Exclude<OutcomeKey, `set:${number}-${number}`>>
>;

const SeededMapEntryS = z.object({ slot: z.string().min(1).max(20), source: z.string().min(1).max(40) }).strict();

const ProgressionSourceS = z
  .object({
    stage: z.union([z.literal("previous"), z.object({ stageId: Uuid }).strict()]),
    take: z.array(TakeRuleSchema).min(1).max(8),
  })
  .strict();

// Decision 1 (F2 plan) — `timing` is the axis the design doc's own proposed
// shape omitted: whether this stage's fixtures appear at setup, as TBD
// placeholders (old `.seeding`), or only once every source stage completes
// (old `.qualification`). Required, no default — ruling 5's "strict
// constraints from day one, no permissive interim state". Multi-source
// `sources[]` (new capability — Finding 1: it never actually worked
// server-side before F2) is enforced for dedupe at RESOLUTION time
// (resolveProgression), not at parse time — two sources are both
// independently well-formed here even if they could later name the same
// entrant.
export const ProgressionSchema = z
  .object({
    sources: z.array(ProgressionSourceS).min(1).max(8),
    placement: z.enum(["seeded_map", "snake", "rank_order"]),
    map: z.array(SeededMapEntryS).max(64).optional(),
    timing: z.enum(["setup", "on_complete"]),
    // Carry prior points/metrics into the qualified stage's opening
    // standings (Jul3/05 §3) — like `timing`, an apps/web/DB-orchestration
    // concept the engine's pure ProgressionSpec has no notion of (take-rule
    // expansion/placement/resolution math never reads it). Restored from
    // the old QualificationSpec.carry: this plan's own grounding said no
    // shipped writer sets it (true for format-templates.ts/the catalogue),
    // but custom-points.test.ts exercises it end to end against a
    // hand-built stage graph, and it backs a MARKETED entitlement
    // (standings.carry_over — feature-copy.ts's paywall copy,
    // pricing.matrix.standings.carry_over in all 4 marketing dictionaries;
    // free on every plan since V471). Deleting it would silently break an
    // advertised feature.
    // Accepted on BOTH timings as of F6. Applied in seedNextStage for
    // `on_complete` and in confirmSeedProposal for `setup`. computeSeedProposal
    // refuses a non-real source at propose time (HttpError 422
    // SEEDING_CARRY_SOURCE_INVALID); confirm re-checks the same belt before
    // writing `carry_deltas` + one `standings_carried` event.
    // A refine here used to reject the pair outright, because carry was
    // read only under `on_complete` and the entitlement gate
    // (`progression?.carry`, timing-agnostic) would otherwise have charged
    // the org's `standings.carry_over` for a silent no-op.
    carry: z.enum(["none", "points", "full"]).optional(),
  })
  .strict()
  .refine((s) => s.placement !== "seeded_map" || (s.map !== undefined && s.map.length > 0), {
    message: "seeded_map placement needs a non-empty map",
    path: ["map"],
  });
export type ProgressionInput = z.infer<typeof ProgressionSchema>;

/**
 * A stage's `config`, with the KEY SET closed.
 *
 * `CreateStage` below has been `.strict()` since F2 Task 5, but `config` was
 * `z.record(z.string(), z.unknown())` — so the very bug that strictness was
 * added to stop survived one level down. A misspelled `byes`, `slotOrder` or
 * `legs` inside `config` parsed fine, was stored, was never read by anything,
 * and the product then seeded its own draw and returned 201. No error, no log.
 * The organiser sees a draw they did not ask for and has nothing to go on.
 *
 * Two deliberate halves:
 *
 * KEYS are closed. That is the defect, and only `.strictObject` fixes it.
 * Every key below has a real reader; omitting one would make it permanently
 * unreachable, because `CreateStage` is the ONLY client write path (there is
 * no PatchStage/UpdateStage) and the server's own later writes —
 * `config.ladder_order` at `usecases/stages/`, and `qualified` /
 * `cross_feeds` / `rank_overrides` / `carry_deltas` / `rngSeed` — round-trip
 * through rows this schema has to be a superset of. The list was derived by
 * enumerating every reader and every writer, not typed from memory.
 *
 * VALUES are typed only where THIS file is the authority. `points` belongs to
 * the engine's `PointsRule`, `rules` to each sport module's `configSchema`
 * (`packages/engine/src/sport/module.ts`), and `cross_feeds` /
 * `placements` / `rank_overrides` / `carry_deltas` to the usecases that read
 * them. Restating those shapes here would create a second copy of a fact that
 * already has an owner — which is exactly how two shapes of one fact drift
 * apart, and exactly why `tools/bench/lib/pack-schema.ts:456` deliberately
 * declined to copy this vocabulary. `z.unknown()` means "this key is real,
 * its shape is someone else's to enforce".
 *
 * Net effect for the bench: a pack no longer needs its own copy of this
 * vocabulary to catch a typo, because the product now rejects one at the
 * door — which is the guarantee `pack-schema.ts` wanted and could not give
 * itself.
 */
/** The refusal a top-level stage decider gets (W2c Task 12): the key moved, it is not a typo. */
export const STAGE_DECIDER_MOVED = "moved to config.rules: a stage's deciders are its match rules";

/** W2c Task 13b finish-up (R-13b-1; D3, greenfield: no shim): every whole decider any sport declares is refused at the
 *  top level of a stage's config LOUDLY, saying where it went (`http.ts` turns the message into a named 400), rather than
 *  as an unrecognised key a client would read as a typo. The set is the create door's own (`lib/top-level-stage-
 *  deciders.ts`, from the engine's declarations), so a decider a sport adds is refused here the day it is declared.
 *  Spread FIRST in each shape: a real config key of a decider's name would then win the shape, and the guard in
 *  usecases/__tests__/stage-defaults.test.ts would see a decider that is not refused. The cast names only the two keys
 *  the type has always carried (the rest are `never` too, so the inferred types lose nothing a client could send). */
const TOP_LEVEL_DECIDER_REFUSALS = Object.fromEntries(
  TOP_LEVEL_STAGE_DECIDERS.map((key) => [key, z.never({ error: STAGE_DECIDER_MOVED }).optional()]),
) as Record<"shootout" | "extraTime", z.ZodOptional<z.ZodNever>>;

export const StageConfig = z
  .strictObject({
    ...TOP_LEVEL_DECIDER_REFUSALS,
    // League / group shape.
    // Floor from FORMAT_BOUNDS (Match Day D1). The ceiling stays 8 on the server, the generator's own clamp (usecases/stages/,
    // "Jul3/08 §2: legs > 2 allowed"), by owner ruling Option A (2026-11-01): the builder offers 1-2 only (LegsChoice), and
    // Triple round robin is retired from the list, but a stored division with 3 or more legs keeps playing it, so the door
    // must not refuse the value it already holds.
    legs: z.number().int().min(FORMAT_BOUNDS.legs.min).max(8).optional(),
    pools: z.strictObject({ count: z.number().int().min(1) }).optional(),
    // Knockout shape. `byes` are entrant ids; `slotOrder` is a draw order with
    // `null` for an empty slot — the two fields §18.2 was raised about.
    thirdPlace: z.boolean().optional(),
    byes: z.array(z.string()).optional(),
    slotOrder: z.array(z.number().int().nullable()).optional(),
    bracketReset: z.boolean().optional(),
    // W4 T7 (RB4-D9, X-SD-10): country separation is not offered — Seazn holds no country for a player or a team — so the
    // one key a client would reach for refuses by NAME (`http.ts` answers 400 COUNTRY_SEPARATION_NOT_OFFERED). Any value
    // fails: the key accepts nothing. Club separation (RB4-D7/D8) is deferred (ruling 272) and has no key at all.
    countrySeparation: z.never({ error: COUNTRY_SEPARATION_NOT_OFFERED_MESSAGE }).optional(),
    // Americano / Mexicano.
    mode: z.enum(["americano", "mexicano"]).optional(),
    courtCount: z.number().int().min(1).optional(),
    // Swiss (also `rounds`). Floor from FORMAT_BOUNDS (Match Day D1); no ceiling here, because Americano's `rounds`
    // is this same key and is not bounded by the Swiss rounds field.
    rounds: z.number().int().min(FORMAT_BOUNDS.swissRounds.min).optional(),
    chess: z.boolean().optional(),
    // W3 T18 (RB3-7(c), signed 252; X-SW-18): a requested half-point or zero-point bye is DEFERRED — no path, and the one
    // key a client would reach for refuses by name (`http.ts` answers 400 SWISS_REQUESTED_BYES_DEFERRED with the guidance).
    // Any value fails: the key accepts nothing, and the spec documents it as the never-schema it is.
    requestedByes: z.never({ error: SWISS_REQUESTED_BYES_DEFERRED_MESSAGE }).optional(),
    // Which pairing model the swiss generator uses. Mirrors the engine's
    // `SwissConstraints.pairing` (packages/engine/src/scheduling/swiss.ts) —
    // spelled out rather than imported because this file may not reach into
    // `@/` or the engine (see the import-boundary note at the top). OMITTED
    // is the fold default: every swiss stage that predates Swiss Playoff
    // carries no `pairing` key and must keep folding top-vs-bottom, so this
    // deliberately has NO `.default()`.
    pairing: z.enum(["fold", "rank_adjacent"]).optional(),
    // Ladder.
    challengeRange: z.number().int().min(1).optional(),
    ladder_order: z.array(z.string()).optional(),
    // Seeding / standings, any kind.
    qualified: z.array(z.string()).optional(),
    h2h_scope: z.literal("overall").optional(),
    rngSeed: z.number().optional(),
    // Shapes owned elsewhere — key allowed, value left to its own authority.
    points: z.unknown().optional(),
    carry_deltas: z.unknown().optional(),
    rank_overrides: z.unknown().optional(),
    cross_feeds: z.unknown().optional(),
    placements: z.unknown().optional(),
    // W2c Task 12 (D3): a stage's deciders are its match RULES, written at create as its kind's preset under
    // `config.rules`; one at the top level is refused by `TOP_LEVEL_DECIDER_REFUSALS`, spread at the head of this shape.
    /** Per-stage match rules (design 2026-09-17 §T3; W2c Task 12, SC-P8). Deliberately LOOSE here: which keys a stage
     *  may set, and their values, depend on the stage's sport, kind and variant, none of which this schema knows. A
     *  create lays this fragment over the stage kind's preset and validates it as `PUT /stages/{id}/rules` validates a
     *  save (`usecases/stage-defaults.ts`): the engine's per-sport, per-kind allowlist, then the merged parse with the
     *  division's config. A key sent as null removes that preset key (the stage inherits the division's value). */
    rules: z.record(z.string(), z.unknown()).nullish(),
  })
  .default({});

// F2 Task 5 — .strict(): before this, an unknown key (the old
// .qualification/.seeding shape, or any typo) parsed successfully with the
// key silently STRIPPED — stages-panel.tsx's live "Add stage" POST
// (qualification: {topN}) created a stage with progression: null, returned
// 201, and generated nobody. No error, no log, ever. Strict converts that
// whole class of bug from silent to loud: the same POST now 400s, naming the
// offending key (zod's unrecognized_keys issue). `config` carries the same
// guarantee one level down since 2026-09-10 — see StageConfig above.
export const CreateStage = z
  .object({
    seq: z.number().int().min(1),
    kind: StageKind,
    name: z.string().min(1).max(200),
    config: StageConfig,
    progression: ProgressionSchema.nullish(),
  })
  .strict();

/** POST /divisions/{id}/stages — the stage graph, one or many (doc 08 §3). */
export const CreateStages = z.union([CreateStage, z.array(CreateStage).min(1).max(20)]);

/** POST /stages/{id}/fixtures — ad-hoc single fixture (PROMPT-66).
 *
 *  P9 pass 3c-2: this was the one writer the venues/courts cutover missed —
 *  it still took a free-text `venue`. Real venue/court by id now, same as
 *  `PatchFixture`. `.strict()` for the same reason that schema documents: a
 *  client still sending `venue` gets a loud 400 instead of a silent no-op. */
// ---------------------------------------------------------------------------
// #622 — stage- and round-scoped required court tags
// ---------------------------------------------------------------------------

/** A `roundRoleKey()` value from `@seazn/engine/competition` — `final`,
 *  `semi_final`, `quarter_final`, `round_of_16`, `losers_round_2`,
 *  `grand_final`, `rung_3`, `plain_round_4`, … The usecase re-validates with
 *  `isRoundRoleKey()`, which is the authoritative vocabulary; this pattern is
 *  the cheap shape gate in front of it, deliberately not a duplicate of the
 *  role list (a second copy would go stale the next time a stage format ships
 *  a new role). */
export const RoundRoleKey = z
  .string()
  .min(1)
  .max(40)
  .regex(/^[a-z][a-z0-9_]*$/, "not a round role key");

export const StageRoundCourtTags = z.object({
  round_role: RoundRoleKey,
  required_court_tags: RequiredCourtTags,
});

/** PUT semantics on `rounds`: whole-list replace, so an omitted round is
 *  DELETED. Omitting the KEY itself leaves the stage's round rules untouched —
 *  the two are different, which is why neither field has a default. */
export const PutStageCourtTags = z
  .object({
    required_court_tags: RequiredCourtTags,
    rounds: z.array(StageRoundCourtTags).max(64),
  })
  .partial()
  .refine((p) => Object.keys(p).length > 0, "empty patch");
export type PutStageCourtTags = z.infer<typeof PutStageCourtTags>;

export const StageCourtTags = z.object({
  stage_id: Uuid,
  required_court_tags: z.array(z.string()),
  rounds: z.array(StageRoundCourtTags),
  /** The roles this stage's fixtures currently occupy, in bracket order — a
   *  picker source, never a constraint on what may be written (a stage whose
   *  fixtures are not generated yet occupies none). */
  available_round_roles: z.array(z.string()),
});

/** Per-stage match-format override (design 2026-09-17 §T3; W2c Task 11). The
 *  fragment MERGES into what the stage carries: an omitted key is kept, a key
 *  sent as `null` is removed, and `rules: null` or `{}` clears the stage back to
 *  the division's format. Values are unconstrained HERE for the openapi-gen
 *  reason on `StageConfig.rules` above; `usecases/stage-rules.ts` enforces, for
 *  every sport, the engine's declared stage keys for the stage's kind and
 *  variant (400 UNKNOWN_RULE_KEY / RULE_NOT_SETTABLE), the merged-config parse
 *  (422 CONFIG_INVALID), the per-stage lock (409 STAGE_FORMAT_LOCKED) and an
 *  unstarted match's own format still fitting (409
 *  FIXTURE_OWN_FORMAT_NO_LONGER_FITS).
 *
 *  W2c Task 13 (ST-G8) and W2d Task 13: four arms, `rules`, `points`,
 *  `tiebreakers` and `crossGroupTiebreakers`, each left as stored when
 *  omitted, at least one sent. `points` is the stage's own PointsRule (the
 *  engine's shape), written whole; `null` removes it. The key set is CLOSED: a
 *  misspelled arm was silently stripped before (and answered 200 having saved
 *  nothing), and a top-level decider is refused saying where it goes, as on
 *  `StageConfig`. */
export const PutStageRules = z
  .strictObject({
    ...TOP_LEVEL_DECIDER_REFUSALS,
    rules: z.record(z.string(), z.unknown()).nullable().optional(),
    points: PointsRule.nullable().optional(),
    /** W2d (spec §5.4, §5.5): the stage's own tie-break order, validated on the stage's kind (422 TIEBREAK_KEY_INVALID,
     *  `extra.refusals`); `null` clears it back to the division's order (else the sport's). */
    tiebreakers: z.array(TiebreakerKeyS).meta({ examples: [["points", "h2h_points", "diff", "for", "lots"]] }).nullable().optional(),
    /** W2d (spec §5.9): the stage's own cross-group order (entrants from different groups); `null` derives it again. */
    crossGroupTiebreakers: z.array(TiebreakerKeyS).meta({ examples: [["points", "diff", "for", "lots"]] }).nullable().optional(),
  })
  .refine(
    (b) => b.rules !== undefined || b.points !== undefined || b.tiebreakers !== undefined || b.crossGroupTiebreakers !== undefined,
    "send `rules`, `points`, `tiebreakers`, `crossGroupTiebreakers` or any of them together",
  );
export type PutStageRules = z.infer<typeof PutStageRules>;

export const StageRules = z.object({
  rules: z.record(z.string(), z.unknown()).nullable(),
  /** The stage's own points rule as stored, or null when it plays the division's points (W2c Task 13). */
  points: PointsRule.nullable(),
  /** W2d: the stage's own order as stored, or null when it ranks by the division's (else the sport's). */
  tiebreakers: z.array(TiebreakerKeyS).nullable(),
  /** W2d: the stage's own cross-group order as stored, or null when it is derived from the order (§5.9). */
  crossGroupTiebreakers: z.array(TiebreakerKeyS).nullable(),
});

/** W2c (X-SR-2, X-SR-5) — one match's own format over its stage's. Values unconstrained HERE for the same openapi-gen
 *  reason as `PutStageRules`; `usecases/fixture-rules.ts` enforces the sport's declared keys (400 UNKNOWN_RULE_KEY),
 *  the match scope and its bounds (400 RULE_NOT_SETTABLE), the merged parse (422 CONFIG_INVALID), the finished lock
 *  (409 FIXTURE_FORMAT_LOCKED) and, for a started match, the fit with the recorded play (409 FORMAT_DOES_NOT_FIT_PLAY). */
export const PutFixtureRules = z.object({
  rules: z.record(z.string(), z.unknown()).nullable(),
});
export type PutFixtureRules = z.infer<typeof PutFixtureRules>;

export const FixtureRulesResult = z.object({
  fixtures: z.array(
    z.object({
      id: Uuid,
      /** The match had a frozen config: the write was a live correction. */
      started: z.boolean(),
      /** Bumped by a correction that changed the frozen config (and by a staff re-freeze) — an open pad compares it. */
      rules_version: z.number().int().min(0),
    }),
  ),
});

/** W2c Task 15 (X-SR-7, owner P-1) — the rules a match plays by NOW, as a scoring pad reloads them after a correction:
 *  the cfg the engine folds its ledger under, its rules version, and its rules line in the reader's language (the
 *  public line: format, how a tied match ends, a changed abandon policy; null when there is none to say for this sport or cfg). */
export const FixtureCurrentRules = z.object({
  cfg: z.unknown(),
  rules_version: z.number().int().min(0),
  format_line: z.string().nullable(),
});
export type FixtureCurrentRules = z.infer<typeof FixtureCurrentRules>;

/** `GET /api/v1/device-link` — the bootstrap a phone's Remote Scoring reads with its `dl_` link (capture design §7.1). The server
 *  usecase (`device-link-bootstrap.ts`) types the same shape; a seat with no entrant yet is null. */
const DeviceLinkSide = z.object({
  entrant_id: z.string(),
  name: z.string(),
  kind: z.string(),
  members: z.array(z.object({ person_id: z.string(), full_name: z.string() })),
  /** S2-5 design §10: each row carries the team sheet (slot, position, order, role(s), shirt number) beside `pair_order`. */
  lineup: z.array(
    z.object({
      person_id: z.string(),
      pair_order: z.number().int().nullable(),
      slot: z.enum(["starting", "bench"]),
      position_key: z.string().nullable(),
      order_no: z.number().int().nullable(),
      role: z.string().nullable(),
      roles: z.array(z.string()),
      squad_number: z.number().int().nullable(),
    }),
  ),
});
export const DeviceLinkBootstrap = z.object({
  fixture_id: z.string(),
  link_id: z.string(),
  sport_key: z.string(),
  module_version: z.string(),
  cfg: z.unknown(),
  rules_version: z.number().int().min(0),
  engine_epoch_required: z.number().int().min(1),
  screen: z.enum(["view_only", "division_not_started", "waiting", "confirm", "pad"]),
  view_only_reason: z.string().nullable(),
  names: z.object({
    competition: z.string(),
    division: z.string().nullable(),
    round_label: z.string().nullable(),
    ref: z.string().nullable(),
  }),
  sides: z.object({ home: DeviceLinkSide.nullable(), away: DeviceLinkSide.nullable() }),
  state: z.object({ status: z.string(), last_seq: z.number().int().min(0) }),
});
export type DeviceLinkBootstrap = z.infer<typeof DeviceLinkBootstrap>;

/** `GET /api/v1/public/fixtures/{id}/realtime-token`. `url` and `apikey` are the public project URL and anon key (null where the
 *  deployment has none), so a phone configures its Realtime client from the server. */
export const RealtimeTokenOut = z.object({
  token: z.string(),
  channel: z.string(),
  url: z.string().nullable(),
  apikey: z.string().nullable(),
});
export type RealtimeTokenOut = z.infer<typeof RealtimeTokenOut>;

export const AddFixture = z
  .object({
    home_entrant_id: Uuid,
    away_entrant_id: Uuid,
    round_no: z.number().int().min(1).optional(),
    scheduled_at: z.string().datetime({ offset: true }).nullish(),
    venue_id: VenueId.nullish(),
    court_id: CourtId.nullish(),
  })
  .strict();
export type AddFixture = z.infer<typeof AddFixture>;
export type CreateStages = z.infer<typeof CreateStages>;

// F2 — READ-path shape (Task 6): the two old columns this response used to
// expose (qualification/seeding) were dropped by V374; API consumers now
// see the one unified field. Deliberately `z.record(...).nullable()`, not
// `ProgressionSchema.nullable()` — a response schema should not 400 a row
// this API itself wrote (defence-in-depth against a shape ProgressionSchema
// would reject slipping in through a future direct-SQL writer), matching
// this field's pre-F2 precedent (`qualification`/`seeding` were never
// validated on the way OUT either).
export const Stage = z.object({
  id: Uuid,
  division_id: Uuid,
  seq: z.number().int(),
  kind: StageKind,
  name: z.string(),
  config: z.record(z.string(), z.unknown()),
  progression: z.record(z.string(), z.unknown()).nullable(),
  status: z.enum(["pending", "active", "complete"]),
});

// ---------------------------------------------------------------------------
// W2d (spec §7, §10) — a table stage's rules as the loader reads them, and the
// standings rows they rank. Response shapes: documented, never parsed on the
// way out (a row this API wrote is never 400'd by its own reader).
// ---------------------------------------------------------------------------

/** The layer a stage's order or points came from (`TableRulesSource`): its own, its division's, its sport's, or — in a
 *  pin only — what the W2d migration found it ranking by. */
export const TableRulesSourceS = z.enum(["stage", "division", "sport", "migrated"]);

/** One outcome a stage can produce, as its points rule names it (`OutcomeKey`, spec §5.3): a win or loss per way it was
 *  decided, a loss not played, a level result, or a final set score `set:W-L`. */
const FIXED_OUTCOME_KEYS = [
  "win.regulation", "win.ot", "win.so", "loss.regulation", "loss.ot", "loss.so", "loss.unplayed", "draw", "tie", "noResult",
] as const;
export const OutcomeKeyS = z.union([z.enum(FIXED_OUTCOME_KEYS), z.string().regex(/^set:\d+-\d+$/)]);

/** GET /stages/{id} and GET /divisions/{id}/stages — the stage's table rules (spec §7): the order it ranks by, where the
 *  order came from and when the stage was pinned to it (the generate that activates a stage pins it; a pinned stage keeps
 *  its rules while the division's move, `stagesKeptPinned`), the sport's own default for the stage (the editor's Reset,
 *  PS-7b: never the winning order), the cross-group order (§5.9), the points with their source and pin, and every
 *  outcome those points range over (`reachableOutcomes`). */
export const StageTableRules = z.object({
  tiebreakers: z.object({
    keys: z.array(TiebreakerKeyS),
    source: TableRulesSourceS,
    /** When the stage was pinned to its rules (the DB's own stamp); null while it is not. */
    pinnedAt: z.string().nullable(),
    sportDefault: z.array(TiebreakerKeyS),
  }),
  crossGroup: z.object({ keys: z.array(TiebreakerKeyS) }),
  points: z.object({ rule: PointsRule, source: TableRulesSourceS, pinnedAt: z.string().nullable() }),
  reachableOutcomes: z.array(OutcomeKeyS),
});
export type StageTableRules = z.infer<typeof StageTableRules>;

/** A stage with its table rules: null where the stage's rules do not read (a build this server no longer carries, a
 *  cfg its sport cannot read) — the reader shows no order rather than a guessed one. */
export const StageWithTableRules = Stage.extend({ tableRules: StageTableRules.nullable() });

/** FMT5 — `PUT /divisions/{id}/stages?dry_run=1`: what the format change would clear (`FormatChangePreview`,
 *  lib/format-change.ts), every count read from the rows the delete takes. Also the `preview` of a FORMAT_CHANGE_CONFIRM /
 *  FORMAT_CHANGE_STALE refusal. */
export const FormatChangePreview = z.object({
  dry_run: z.literal(true),
  stages: z.array(z.object({ id: Uuid, name: z.string() })),
  fixtures: z.number().int(),
  slots: z.number().int(),
  courts: z.number().int(),
  officials: z.number().int(),
  lineups: z.number().int(),
  device_links: z.number().int(),
  calls: z.number().int(),
  voided_scores: z.number().int(),
  token: z.string().nullable(),
});

/** A tie-break reason on a standings row: a cascade key, or `fewest_played` (a partial schedule's step, IIHF RBG). */
export const TieBreakKeyS = z.enum([...TiebreakerKeyS.options, "fewest_played"]);
/** Why a conditional step left a residual tie unsplit (`TieBreakNote`, W2d §2.3). */
export const TieBreakNoteS = z.enum(["h2h_two_not_applicable", "h2h_incomplete"]);

/** One ranked row of a stage's table (engine `StandingsRow`). `metrics` is the sport's ledger; `won_ot`/`won_so`/
 *  `lost_ot`/`lost_so` (1, only when 1 for a match) count the wins and losses decided beyond regulation (spec §5.7).
 *  `tieBreak` names the step that split the row from the rows it was tied with (`drawnAt`: the date a stored lots draw
 *  was made, §5.8); `level` is true on every row of a table with no counted fixture, and `rank` is then null (D11 b). */
export const StandingsRow = z.object({
  entrantId: z.string(),
  played: z.number(),
  won: z.number(),
  drawn: z.number(),
  lost: z.number(),
  points: z.number(),
  metrics: z
    .object({
      won_ot: z.number().optional(),
      won_so: z.number().optional(),
      lost_ot: z.number().optional(),
      lost_so: z.number().optional(),
    })
    .catchall(z.number()),
  /** The place, 1..n. `null` on every row of a table with no counted fixture (`level`): a level table has no leader, so the
   *  routes serve no place (W2e D11 b, 2026-10-28). Absent when the ranking pass left none. */
  rank: z.number().nullable().optional(),
  rankLocked: z.boolean().optional(),
  tieUnbroken: z.boolean().optional(),
  tieBreak: z
    .object({ key: TieBreakKeyS, with: z.array(z.string()), note: TieBreakNoteS.optional(), drawnAt: z.string().optional() })
    .optional(),
  level: z.boolean().optional(),
});

/** GET /stages/{id}/standings — one pool's (or the stage's) table as last folded. `computed_through_seq` is the stored
 *  snapshot's bigint watermark, served as the DB prints it (a decimal string), and 0 for a table folded on the read. */
export const StandingsSnapshot = z.object({
  stage_id: Uuid,
  pool_id: Uuid.nullable(),
  rows: z.array(StandingsRow),
  computed_through_seq: z.union([z.string().regex(/^\d+$/).meta({ examples: ["42"] }), z.literal(0)]),
  updated_at: z.string().nullable(),
});

/** GET /public/…/divisions/{divisionSlug}/standings — every published table of the division. */
export const PublicDivisionStandings = z.object({
  division_id: Uuid,
  standings: z.array(
    z.object({ stage_id: Uuid, pool_id: Uuid.nullable(), rows: z.array(StandingsRow), updated_at: z.string().nullable() }),
  ),
});

// ---------------------------------------------------------------------------
// Templates (D1a design doc, P4) — curated built-ins only, v1: no
// user-generated templates, no sharing. `checkDateOrder` is the SAME
// superRefine CreateCompetition uses; a template still needs real dates,
// only the structure comes from the catalog.
// ---------------------------------------------------------------------------

export const CreateFromTemplate = z
  .object({
    template_key: z.string().min(1),
    /** Optional stale-catalog guard: when present, must match the catalog's
     *  CURRENT version for this key, else 409 template.version_retired — a
     *  wizard detail sheet that sat open across a catalog deploy must not
     *  silently instantiate a different shape than what was reviewed. */
    template_version: z.number().int().positive().optional(),
    name: z.string().min(1).max(200),
    starts_on: z.iso.date().nullish(),
    ends_on: z.iso.date(),
    /** Public by default, same ruling and same degrade as CreateCompetition —
     *  the two create paths must not disagree about what an omitted
     *  visibility means. */
    visibility: Visibility.default("public"),
  })
  .superRefine(checkDateOrder);
export type CreateFromTemplate = z.infer<typeof CreateFromTemplate>;

const TemplateStageResultS = z.object({ id: Uuid, fixtureCount: z.number().int().min(0) });
const TemplateDivisionResultS = z.object({ id: Uuid, stages: z.array(TemplateStageResultS) });
export const FromTemplateResult = z.object({
  competitionId: Uuid,
  /** So the wizard can navigate straight to the created competition page —
   *  same pattern the blank-form wizard already uses off its own POST. */
  slug: Slug,
  /** The visibility that was ACTUALLY applied (T20). `createCompetition`
   *  returns the whole row, so its caller could always diff requested against
   *  created; this result carried no visibility at all, which is why the
   *  template gallery — the DEFAULT create path, the one `/competitions/new`
   *  opens on — redirected unconditionally into a silently private
   *  competition whose public link 404s. */
  visibility: Visibility,
  /** Present ONLY when the public-dashboard cap turned this create private —
   *  the same note POST /competitions carries, deliberately the same field
   *  name and the same shape so one concept has one name on both create
   *  paths. */
  public_quota_degraded: PublicQuotaDegraded.optional(),
  divisions: z.array(TemplateDivisionResultS),
  templateKey: z.string(),
  templateVersion: z.number().int(),
});
export type FromTemplateResult = z.infer<typeof FromTemplateResult>;
