// validate-pack.ts — STAGE 0 of the scheduler bench.
//
// A pack is thousands of hand-assembled historical events plus the real
// world's answers. If the pack itself is wrong — a mis-transcribed wicket, a
// swapped tie order — the bench reports a PRODUCT defect that is really an
// AUTHORING defect, minutes into a seeded HTTP run against a live database.
// Stage 0 kills such a pack offline, in seconds, before anything is created.
// It is also the bench's permanent CI presence: it runs in the DB-free job
// (`.github/workflows/ci.yml`, "Bench lib unit tests (DB-free)").
//
// PURE. No DB, no HTTP, no env vars, no filesystem: the caller hands over an
// already-parsed value. Nothing here mutates its input.
//
// ---------------------------------------------------------------------------
// THE ORACLE DIRECTION (bench `_RULES.md` §3)
// ---------------------------------------------------------------------------
// A pack carries RAW EVENTS plus the real world's EXPECTED values, and the
// ENGINE derives the outcome. Nothing in this file writes a derived value back
// into a pack, and nothing compares a pack's expected value against itself.
// Every comparison below has the engine on one side and the pack on the other.
//
// ---------------------------------------------------------------------------
// THE PIPELINE, AND WHAT EACH STAGE CAN AND CANNOT CATCH
// ---------------------------------------------------------------------------
//  1. zod parse (`PackSchema`). Shape, vocabularies, and every cross-field
//     rule Task 1 built — including the `ext_key`-unique-per-DIVISION rule
//     this task's brief asked for, which already lives in `checkStreams`
//     (pack-schema.ts) with its reason attached, and is deliberately NOT
//     re-implemented here: two implementations of one uniqueness rule is the
//     parallel-vocabulary defect this repo keeps shipping. CANNOT catch
//     anything that needs the engine — a legal event sequence folding to the
//     wrong answer parses perfectly.
//  2. Per-stream fold. Resolve the division's module, build its cfg, mint
//     envelopes exactly as the product's batch import does, fold, and compare
//     the folded `MatchOutcome` and `ScoreSummary.perSide` against the pack's
//     `expected.matches` entry. CATCHES a mis-transcribed event that changes
//     the result of its own fixture. CANNOT catch a mis-transcription that
//     leaves that fixture's outcome intact (see LIMITS below).
//  3. Derived standings. Fold every stream of a table stage into the SAME
//     competition-engine path the product uses (`completeTableStage`), and
//     compare positionally against `expected.tables` — points AND exact tie
//     order, because array position and `rank` carry the same fact. CATCHES a
//     stream whose sides are reversed end to end (stage 2 cannot: a reversal
//     in BOTH the stream and its own expected match is self-consistent at the
//     fixture level, and only shows up in the table). CANNOT bind a stream to
//     a stage in a multi-stage division, or to a pool — see LIMITS.
//  4. Specials. Every claim in `expected.specials` evaluated against the fold:
//     the folded outcome, a dotted path into the folded module State, the
//     fixture's own `StandingsDelta`, or the kernel's squad bookkeeping.
//     CATCHES a claim that names a state path the module does not actually
//     expose — the `mtbTo`-vs-`ClosedSet.mtb` class, where a claim parses fine
//     and is then unresolvable.
//  5. Provenance stats. The real / reconstructed / synthetic split, per
//     division and overall.
//
// ---------------------------------------------------------------------------
// LIMITS — what stage 0 is KNOWN not to catch
// ---------------------------------------------------------------------------
//  * DISHONEST PROVENANCE. A reconstructed stream flagged `"real"` is
//    undetectable by code: the flag describes how a human authored the stream,
//    and no derivation can see that. Stage 0's job is narrower and it is the
//    only honest one — a stream with NO provenance is refused (the field is
//    required with no default, so stage 1 reds it). The honest check is
//    procedural and belongs in the pack authoring playbook.
//  * A CONSISTENTLY-REWRITTEN PACK. A pack whose streams AND expected values
//    are both changed to describe a different, internally consistent
//    tournament folds green, because it IS a consistent tournament. What
//    stages 2-3 catch is an inconsistency between the two.
//  * A MIS-TRANSCRIBED SCORER. `generic.score.person` (and every other
//    person-valued payload field) feeds `expected.leaderboards`, which stage 0
//    does NOT derive: the product's leaderboard fold needs a
//    `PlayerStatsFoldCtx` built from entrant-member rows
//    (`usecases/player-stats.ts:124-140`), and a second, differently-built ctx
//    here would be the placer/verifier fork rather than a check. Owed to B05's
//    live run. Pinned by a test so this limit cannot quietly become false.
//  * `expected.champions` and `expected.suspensions` are likewise not derived
//    offline: a champion is the product's stage-completion + progression
//    answer, and a suspension is a discipline carry-over across fixtures. Both
//    are B05's.
//
//    All three of those blocks now emit a `warning` when they are non-empty
//    (`leaderboards.not_derived` / `champions.not_derived` /
//    `suspensions.not_derived`). Not deriving them is the right call; being
//    SILENT about them was not, because a pack with a wholly fabricated
//    leaderboard then reported "ok, no findings" — the "looks like it passed"
//    shape the warning channel exists for.
//  * A TABLE-KIND STAGE WITH NO DECLARED TABLE. `PackSchema`'s anti-vacuity
//    rule covers streams (every stream needs an `expected.matches` oracle) and
//    stops there, so a league stage can fold twenty streams and assert no
//    points and no tie order at all — and stage 3 is the ONLY stage that
//    catches an end-to-end reversed stream. Reported as
//    `standings.no_expected_table`; the better long-term home is the schema's
//    own anti-vacuity check, before the B06 freeze.
//  * STAGE AND POOL BINDING. In the product the stage is a FIXTURE-row fact
//    and a pack declares no fixtures, so a stream says which stage it belongs
//    to through `streams[].stageRef` — added to `PackSchema` for exactly this
//    — and absent means "the division's only stage". A MULTI-stage division
//    whose streams declare no `stageRef` therefore binds nothing, and every
//    consequence is reported rather than guessed: its table is skipped
//    (`standings.stage_unbindable`), and the stage-scoped cfg overlay is not
//    applied (`fold.stage_overlay_unbindable`).
//
//    The second of those is the one place stage 0 can produce a FALSE RED: a
//    groups+knockout division whose knockout stage declares `shootout` or
//    `extraTime` would fold those fixtures under the division cfg, and the
//    divergence reported is the gap rather than the pack. It is named on its
//    own for that reason — a false red a reader can explain is recoverable,
//    one they cannot is where a correct pack gets edited to match a broken
//    gate. Declaring `stageRef` on every stream silences both.
//
//    A POOL still cannot be bound at all: a pack declares none, and no field
//    was invented for it because no authored source gives one a shape. A
//    pooled table is skipped with `standings.pool_unbindable`.
//  * ROUND NUMBER. `StageCtx.roundNo` is a fixture fact and is likewise
//    undeclared, so `standingsDelta` is called without one. No shipped module
//    reads it, but a future one could.
//
// ---------------------------------------------------------------------------
// PARITY WITH THE PRODUCT'S BATCH IMPORT (session prompt item 2)
// ---------------------------------------------------------------------------
// Stage 0 shares its fold-then-trust shape with the batch import's internal
// dry run. There is NO client-facing dry run — `EventImportRequest`
// (apps/web/src/server/api-v1/schemas.ts) has no `dryRun` field; the dry run
// is an internal phase that always runs and is always followed by the write,
// in the same call, inside a read-only `withTenant`. So it cannot be called
// offline and it is deliberately NOT extracted: the two stay parallel
// implementations of ONE documented contract, and the contract's two
// offline-checkable halves are pinned here and asserted in the test file.
//
//  P1. ENVELOPE SYNTHESIS. `packEnvelopes` below mints
//      `{ id: String(i), seq: i + 1 }` and the fold runs with
//      `{ strictFromSeq: 1 }` — the same three facts as
//      `apps/web/src/server/usecases/event-import.ts:286-295` and `:305`.
//      `seq` is 1-based and gapless (`:289`, whose own comment at `:282`
//      reads "seq 1..n, gapless"); the doc comment above `EventImportRequest`
//      claiming "assigned server-side 0..n" was stale and is corrected on this
//      branch. `id` is the array index as a string so an `EngineError`'s
//      `data.eventId` maps straight back to an event index with no lookup.
//  P2. NOT-DECIDED REJECTION. `event-import.ts:323-328` rejects a stream whose
//      fold does not reach `sportModule.outcome(state) !== null`, as
//      `import.not_decided`. Stage 0 reds on exactly that condition.
//
// A LIVE cross-check of the two implementations — same pack, one through this
// file and one through the real HTTP import — needs a database and is owed to
// B05.
//
// ---------------------------------------------------------------------------
// Runtime constraints (B02 GLOBAL.md): no TS `enum`, no `namespace`, no
// emit-dependent syntax — `scripts/bench` runs under
// `node --experimental-strip-types`. Every relative import carries `.ts`;
// engine imports use SUBPATHS only; nothing from `apps/web` is imported.
import {
  EngineError,
  foldMatchWithStoppage,
  type EventEnvelope,
  type Lineup,
  type LineupPair,
  type LineupSlot,
  type MatchOutcome,
  type ScoreSummary,
  type SquadState,
  type StageCtx,
  type StandingsDelta,
} from "@seazn/engine/core";
import { registry, type AnySportModule } from "@seazn/engine/sport";
import { registerBuiltins } from "@seazn/engine/sports";
import {
  applyPointsRule,
  completeTableStage,
  PointsRule,
  type StandingsRow,
  type TableFixture,
  type TableStage,
} from "@seazn/engine/competition";
import {
  fixtureKey,
  PackSchema,
  type Pack,
  type PackClaim,
  type PackDivision,
  type PackExpectedMatch,
  type PackExpectedTable,
  type PackLineupSlot,
  type PackProvenance,
  type PackStage,
  type PackStream,
} from "./pack-schema.ts";

// ---------------------------------------------------------------------------
// Findings
// ---------------------------------------------------------------------------

/**
 * `error` fails the pack; `warning` records something stage 0 could not check
 * and says why. A warning is never a silent skip: the runner prints it, and
 * "this table was not checked" is a fact the report has to carry — a skipped
 * check that says nothing is the inert-seam shape this programme keeps
 * shipping.
 */
export type PackFindingSeverity = "error" | "warning";

export interface PackFinding {
  /** Dotted, stable, machine-matchable. The stage prefix is the pipeline
   *  stage that produced it (`schema.` / `fold.` / `match.` / `standings.` /
   *  `special.` / `pack.`). */
  readonly code: string;
  readonly severity: PackFindingSeverity;
  /** WHICH element — a pack path plus the human names a pack author uses:
   *  `streams[1] (d-tiny/rr-r2-c1)`. The brief's "must name the offending
   *  stream" is this field. */
  readonly where: string;
  /** WHAT diverged — the first divergent assertion, with both values. */
  readonly message: string;
}

export interface ProvenanceSplit {
  readonly real: number;
  readonly reconstructed: number;
  readonly synthetic: number;
  readonly total: number;
}

export interface PackProvenanceStats {
  readonly overall: ProvenanceSplit;
  /** Keyed by `divisions[].ref`. Every declared division appears, including
   *  one with no streams — an absent key and a zero count are different
   *  facts, and a report that cannot tell them apart hides an unreplayed
   *  division. */
  readonly byDivision: Readonly<Record<string, ProvenanceSplit>>;
}

export interface PackValidation {
  /** True when no `error`-severity finding was raised. Warnings do not fail. */
  readonly ok: boolean;
  readonly findings: readonly PackFinding[];
  readonly provenance: PackProvenanceStats;
  /** The parsed pack, or null when stage 1 refused it. */
  readonly pack: Pack | null;
}

export interface ValidatePackOptions {
  /**
   * The suite key the CALLER expects — normally the pack filename without its
   * extension. `PackSchema`'s own comment on `suite` says it "is checked
   * against its filename by the validator", and this is that check; it is an
   * option rather than a filesystem read because stage 0 does no I/O.
   *
   * REQUIRED, and the whole options object with it. It was optional, and that
   * made the check an inert seam: the runner could simply not pass it and the
   * comparison would silently never run — the failure class this repo has
   * shipped six times. `scripts/bench/**` non-test files ARE in the
   * `tsconfig.scripts.json` program, so a caller omitting it is now a `tsc`
   * error rather than a quiet no-op. If a genuinely suite-agnostic caller ever
   * exists it must say so explicitly rather than inherit it from a default.
   */
  readonly expectedSuite: string;
}

// Compile-time: `expectedSuite` is REQUIRED, not optional. An optional
// property does not satisfy a required one, so relaxing it back reds `tsc`
// here — in a NON-test file, because `tsconfig.scripts.json:35` excludes
// `scripts/**/*.test.ts` and a type-level guard written in a test is checked by
// nothing. Same technique as Task 1's vocabulary pins, and it is what turns
// "the runner must remember to pass it" from a comment into a gate: the
// obligation is on a caller that does not exist yet, so no runtime test in
// this suite can witness it.
type _ExpectedSuiteIsRequired = ValidatePackOptions extends { expectedSuite: string }
  ? true
  : never;
export const EXPECTED_SUITE_IS_REQUIRED: _ExpectedSuiteIsRequired = true;

const EMPTY_SPLIT: ProvenanceSplit = { real: 0, reconstructed: 0, synthetic: 0, total: 0 };

/** The stage kinds that produce a TABLE rather than a bracket. `americano`
 *  rides the league fold (`engine-db/competition.ts:333`, "Jul3/08 §3"), which
 *  is why it belongs here and not with the bracket kinds. */
const TABLE_STAGE_KINDS: ReadonlySet<string> = new Set(["league", "group", "swiss", "americano"]);

// ---------------------------------------------------------------------------
// Registry boot — mirrors apps/web/src/server/engine-db/registry.ts
// ---------------------------------------------------------------------------

/**
 * The shared singleton `registry` (`packages/engine/src/sport/registry.ts:89`)
 * is EMPTY until someone calls `registerBuiltins`, and registering the same
 * (key, version) twice throws `MODULE_DUPLICATE`. Stage 0 boots it itself
 * rather than assuming a caller did, and tolerates a duplicate for exactly the
 * reason the product's own boot does — another boot path may have got there
 * first. Any OTHER registry error is a real bug and is rethrown.
 */
let booted = false;
function bootRegistry(): typeof registry {
  if (booted) return registry;
  try {
    registerBuiltins(registry);
  } catch (err) {
    if (!EngineError.is(err, "MODULE_DUPLICATE")) throw err;
  }
  booted = true;
  return registry;
}

// ---------------------------------------------------------------------------
// Offline mirrors of the product's fold inputs
// ---------------------------------------------------------------------------

/**
 * A pack payload names entrants and people with the `@` sigil (pack-schema.ts
 * header note 6) because their UUIDs do not exist at authoring time. Offline
 * there is nothing to rewrite: the sigilled string IS the id, so the same
 * bytes fold. An expected-block ref is bare, so a comparison against a folded
 * id goes through here.
 */
export function sigil(ref: string): string {
  return `@${ref}`;
}

/**
 * The two stage-config keys that overlay a division's resolved cfg for
 * fixtures in that stage — `STAGE_DECIDER_KEYS` in
 * `apps/web/src/server/engine-db/stage-cfg.ts:9`, whose comment is the
 * authority: "those two keys (and only those) overlay the division config".
 *
 * A HAND MIRROR of a product constant, which is a drift risk this file cannot
 * remove — `apps/web` may not be imported from `scripts/bench` (GLOBAL.md:
 * `@/` aliases do not resolve here and most of that tree is `server-only`).
 * It is mirrored rather than skipped because skipping it makes stage 0 fold a
 * knockout stage that declares `shootout` under the WRONG cfg, which is
 * exactly the class of divergence the bench exists to find. Recorded in the
 * task report; the live cross-check is B05's.
 */
const STAGE_DECIDER_KEYS = ["shootout", "extraTime"] as const;

/** `stageScopedCfg` (stage-cfg.ts:11-22), for a pack's own stage config. */
export function stageScopedFoldCfg(
  divisionCfg: unknown,
  stageCfg: Record<string, unknown> | undefined,
): unknown {
  if (stageCfg === undefined) return divisionCfg;
  const overlay: Record<string, unknown> = {};
  for (const key of STAGE_DECIDER_KEYS) {
    if (stageCfg[key] !== undefined) overlay[key] = stageCfg[key];
  }
  if (Object.keys(overlay).length === 0) return divisionCfg;
  return { ...(divisionCfg as Record<string, unknown>), ...overlay };
}

/**
 * PARITY POINT P1 — envelope synthesis, mirroring
 * `apps/web/src/server/usecases/event-import.ts:286-295` field for field:
 *
 *   `id: String(i)`   the array index as a string, so an `EngineError`'s
 *                     `data.eventId` maps back to an index with no lookup;
 *   `seq: i + 1`      1-based and GAPLESS (`:289`; the "0..n" doc comment
 *                     above `EventImportRequest` was stale);
 *   `fixtureId`       a real UUID in the product. Offline the fixture does
 *                     not exist yet, so the pack's own composite key stands
 *                     in — `fixtureKey` rather than a fourth hand-rolled
 *                     format. No fold reads it.
 *   `recordedAt`      the product falls back to `new Date().toISOString()`.
 *                     Stage 0 uses a FIXED sentinel instead: no fold reads
 *                     `recordedAt` (game time travels in `payload.at`, see
 *                     `core/time.ts`), and a wall-clock read would make an
 *                     offline gate non-reproducible. The one deliberate
 *                     divergence from the product's synthesis, and it is
 *                     unobservable to the fold.
 *   `recordedBy`      `auth.userId` in the product; there is no user offline,
 *                     and the envelope schema declares it nullable.
 */
export const OFFLINE_RECORDED_AT = "1970-01-01T00:00:00.000Z";

export function packEnvelopes(stream: PackStream): EventEnvelope[] {
  const fixtureId = fixtureKey(stream.divisionRef, stream.fixtureExtKey);
  return stream.events.map((ev, i) => ({
    id: String(i),
    fixtureId,
    seq: i + 1,
    type: ev.type,
    payload: ev.payload,
    recordedAt: ev.at ?? OFFLINE_RECORDED_AT,
    recordedBy: null,
  }));
}

/** PARITY POINT P1, second half — `event-import.ts:305` folds the dry run with
 *  `{ strictFromSeq: 1 }`. The stream's first seq is 1, so the WHOLE stream is
 *  validated in full ("a value at or below the stream's first seq makes the
 *  whole stream strict", `core/events.ts:256-257`). Tolerant is the replay
 *  reading, and a pack is not a replay: it is a stream being written for the
 *  first time. */
export const PACK_FOLD_OPTIONS = { strictFromSeq: 1 } as const;

/** One lineup slot, mirroring `buildLineup` in
 *  `apps/web/src/server/engine-db/lineups.ts:27-37`: `orderNo` falls back to
 *  append order, and `role: "player"` is never spread (the engine's own
 *  contract is "OPTIONAL WITH NO `.default()` … Absent ⇒ player",
 *  `core/types.ts`). `personId` is the sigilled ref. */
function toLineupSlot(slot: PackLineupSlot, i: number): LineupSlot {
  return {
    personId: sigil(slot.person),
    slot: slot.slot,
    orderNo: slot.orderNo ?? i + 1,
    ...(slot.positionKey === undefined ? {} : { positionKey: slot.positionKey }),
    ...(slot.roles.length === 0 ? {} : { roles: slot.roles }),
    ...(slot.squadNumber === undefined ? {} : { squadNumber: slot.squadNumber }),
    ...(slot.role === undefined || slot.role === "player" ? {} : { role: slot.role }),
    ...(slot.pairOrder === undefined ? {} : { pairOrder: slot.pairOrder }),
  };
}

/**
 * The `LineupPair` `foldMatch` requires, from the stream's declared sides.
 *
 * A stream with NO `lineups` block gets two EMPTY slot arrays — not a lineup
 * synthesised from the entrant's roster. That is what the product does: an
 * INNER-join-free `loadLineupPair` (`engine-db/lineups.ts:44-58`) returns
 * `{entrantId, slots: []}` for a fixture with no lineup rows, and the fold
 * runs on that. Synthesising slots here would fold a pack under a team sheet
 * the seeded product will not have.
 */
export function packLineupPair(stream: PackStream): LineupPair {
  const side = (entrant: string, slots: readonly PackLineupSlot[] | undefined): Lineup => ({
    entrantId: sigil(entrant),
    slots: (slots ?? []).map(toLineupSlot),
  });
  return {
    home: side(stream.home, stream.lineups?.home),
    away: side(stream.away, stream.lineups?.away),
  };
}

// ---------------------------------------------------------------------------
// Small pure helpers
// ---------------------------------------------------------------------------

function deepEqual(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true;
  if (typeof a !== "object" || typeof b !== "object" || a === null || b === null) return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  if (Array.isArray(a) && Array.isArray(b)) {
    return a.length === b.length && a.every((item, i) => deepEqual(item, b[i]));
  }
  const ao = a as Record<string, unknown>;
  const bo = b as Record<string, unknown>;
  const ak = Object.keys(ao);
  const bk = Object.keys(bo);
  if (ak.length !== bk.length) return false;
  return ak.every((k) => Object.prototype.hasOwnProperty.call(bo, k) && deepEqual(ao[k], bo[k]));
}

function show(value: unknown): string {
  return JSON.stringify(value) ?? String(value);
}

/**
 * Walk a dotted path into a folded State.
 *
 * `found` is reported SEPARATELY from `value`, because an absent path and a
 * present `undefined` are different facts and only one of them is a pack
 * defect. This is the guard for the failure the specials design was corrected
 * for: a claim written as `{path: "mtbTo"}` from a line number pointed at a
 * field on a DERIVED per-set struct that is not on the state at all, so it
 * parsed cleanly and could never resolve. An unresolvable path is an error
 * here, never a skipped claim.
 */
export function resolveStatePath(root: unknown, path: string): { found: boolean; value: unknown } {
  let cursor: unknown = root;
  for (const segment of path.split(".")) {
    if (Array.isArray(cursor)) {
      const index = Number(segment);
      if (!Number.isInteger(index) || index < 0 || index >= cursor.length) {
        return { found: false, value: undefined };
      }
      cursor = cursor[index];
      continue;
    }
    if (typeof cursor !== "object" || cursor === null) return { found: false, value: undefined };
    if (!Object.prototype.hasOwnProperty.call(cursor, segment)) {
      return { found: false, value: undefined };
    }
    cursor = (cursor as Record<string, unknown>)[segment];
  }
  return { found: true, value: cursor };
}

// ---------------------------------------------------------------------------
// Stage 2 — the per-stream fold
// ---------------------------------------------------------------------------

interface FoldedStream {
  readonly stream: PackStream;
  readonly division: PackDivision;
  /** The stage this stream folded under, when the division has exactly one.
   *  See LIMITS: a multi-stage division cannot bind. */
  readonly stage: PackStage | undefined;
  readonly module: AnySportModule;
  readonly cfg: unknown;
  readonly state: unknown;
  readonly squads: SquadState;
  readonly outcome: MatchOutcome;
  readonly summary: ScoreSummary;
}

function streamLabel(stream: PackStream, index: number): string {
  return `streams[${index}] (${stream.divisionRef}/${stream.fixtureExtKey})`;
}

/**
 * WHICH STAGE this stream belongs to, or undefined when nothing can say.
 *
 * The declared `streams[].stageRef` wins. It is optional, so a single-stage
 * division still binds without one — that is what every v1 pack relies on.
 * A MULTI-stage division with no `stageRef` cannot be bound at all, and every
 * consequence of that is reported rather than guessed at (see LIMITS): the
 * stage's cfg overlay is not applied, its table is not checked, and both say
 * so.
 *
 * `stageRef` is already cross-checked by `PackSchema` against the stream's own
 * division, so a ref that resolves to nothing here is unreachable for a parsed
 * pack — the `find` still returns `undefined` rather than asserting.
 */
function resolveStage(division: PackDivision, stream: PackStream): PackStage | undefined {
  if (stream.stageRef !== undefined) {
    return division.stages.find((stage) => stage.ref === stream.stageRef);
  }
  return division.stages.length === 1 ? division.stages[0] : undefined;
}

/**
 * The stage-scoped decider keys a division declares but cannot bind, because
 * at least one of its streams resolves to no stage.
 *
 * Such a stream folds on the DIVISION cfg with no overlay. That is the honest
 * default — but it is not free: a groups+knockout division whose knockout
 * stage declares `shootout` or `extraTime` folds its knockout fixtures under
 * the wrong cfg and reports a divergence the pack did not commit.
 *
 * So the risk is NAMED rather than left to look like a data defect. A false
 * red a reader can explain is recoverable; one they cannot is where a correct
 * pack gets edited to match a broken gate. Declaring `stageRef` on every
 * stream silences it, because then nothing is unbound.
 */
function unbindableOverlayKeys(
  division: PackDivision,
  unboundStreams: readonly PackStream[],
): readonly string[] {
  if (unboundStreams.length === 0) return [];
  const keys = new Set<string>();
  for (const stage of division.stages) {
    for (const key of STAGE_DECIDER_KEYS) {
      if (stage.config[key] !== undefined) keys.add(key);
    }
  }
  return [...keys];
}

// ---------------------------------------------------------------------------
// The validator
// ---------------------------------------------------------------------------

export function validatePack(raw: unknown, opts: ValidatePackOptions): PackValidation {
  const findings: PackFinding[] = [];
  const add = (
    severity: PackFindingSeverity,
    code: string,
    where: string,
    message: string,
  ): void => {
    findings.push({ code, severity, where, message });
  };

  // -- Stage 1: zod parse -------------------------------------------------
  const parsed = PackSchema.safeParse(raw);
  if (!parsed.success) {
    for (const issue of parsed.error.issues) {
      add(
        "error",
        `schema.${issue.code}`,
        issue.path.length === 0 ? "<pack>" : issue.path.join("."),
        issue.message,
      );
    }
    return {
      ok: false,
      findings,
      provenance: { overall: EMPTY_SPLIT, byDivision: {} },
      pack: null,
    };
  }
  const pack = parsed.data;

  if (pack.suite !== opts.expectedSuite) {
    add(
      "error",
      "pack.suite_mismatch",
      "suite",
      `pack declares suite "${pack.suite}" but the caller expected "${opts.expectedSuite}" — ` +
        `a pack's identity and its filename must agree or the runner replays the wrong file`,
    );
  }

  // Task 1's close-out concern 5: `meta.synthetic` is the deliberate escape
  // hatch that lets a pack ship with no sources, and `_tiny` is the pack it
  // exists for. A REAL suite pack setting it is an authoring smell, not a
  // shortcut — flagged, never failed, because only a human can judge it.
  if (pack.meta.synthetic && !pack.suite.startsWith("_")) {
    add(
      "warning",
      "pack.synthetic_suite",
      "meta.synthetic",
      `suite "${pack.suite}" is a real suite key but the pack declares meta.synthetic — ` +
        `that flag waives the "cite a source" rule, and a real tournament has sources`,
    );
  }

  const divisionByRef = new Map(pack.divisions.map((d) => [d.ref, d]));
  // Keyed by the SIGILLED id, because that is the id the fold and the
  // competition engine see (there are no UUIDs offline).
  const seedByEntrant = new Map<string, number>();
  for (const e of pack.entrants) {
    if (e.seed !== undefined) seedByEntrant.set(sigil(e.ref), e.seed);
  }
  const registryHandle = bootRegistry();

  // WHICH STAGE each stream folds under — resolved ONCE, so the fold, the
  // overlay warning and the standings derivation cannot answer it three ways.
  const stageOfStream = new Map<string, PackStage | undefined>();
  for (const stream of pack.streams) {
    const division = divisionByRef.get(stream.divisionRef);
    stageOfStream.set(
      fixtureKey(stream.divisionRef, stream.fixtureExtKey),
      division === undefined ? undefined : resolveStage(division, stream),
    );
  }
  const streamsOf = (divisionRef: string): PackStream[] =>
    pack.streams.filter((stream) => stream.divisionRef === divisionRef);
  const unboundOf = (divisionRef: string): PackStream[] =>
    streamsOf(divisionRef).filter(
      (stream) => stageOfStream.get(fixtureKey(stream.divisionRef, stream.fixtureExtKey)) === undefined,
    );

  for (const division of pack.divisions) {
    const unbound = unboundOf(division.ref);
    const keys = unbindableOverlayKeys(division, unbound);
    if (keys.length === 0) continue;
    add(
      "warning",
      "fold.stage_overlay_unbindable",
      `divisions[ref=${division.ref}]`,
      `division "${division.ref}" declares [${keys.join(", ")}] — a stage-scoped decider key — and ` +
        `${unbound.length} of its stream(s) name no stage, so stage 0 folds those fixtures under the ` +
        `DIVISION cfg with no overlay. Any divergence reported for them may be this gap rather than ` +
        `the pack. Declaring streams[].stageRef on every stream closes it`,
    );
  }

  // -- Stage 2: per-stream fold ------------------------------------------
  // Every stream is attempted, and a failure on one never stops the next: a
  // pack with two mis-transcribed streams must report both, and an
  // `EngineError` must arrive as a named finding rather than a crash.
  const folded = new Map<string, FoldedStream>();
  const failedDivisions = new Set<string>();

  pack.streams.forEach((stream, i) => {
    const where = streamLabel(stream, i);
    const fail = (code: string, message: string): void => {
      failedDivisions.add(stream.divisionRef);
      add("error", code, where, message);
    };
    // `divisionRef` is checked by PackSchema, so this cannot be undefined for
    // a parsed pack; the guard keeps the types honest rather than asserting.
    const division = divisionByRef.get(stream.divisionRef);
    if (division === undefined) return;

    let sportModule: AnySportModule;
    try {
      sportModule = registryHandle.get(division.sportKey, division.moduleVersion);
    } catch (err) {
      fail(
        "fold.module_not_found",
        `no engine module "${division.sportKey}@${division.moduleVersion}" — ` +
          `a division pins an EXACT module version and the registry lookup is an exact string match ` +
          `(${engineCodeOf(err)})`,
      );
      return;
    }

    // cfg, exactly as `createDivision` builds it (usecases/divisions.ts:
    // 237-254): the named variant PRESET, then the pack's overrides spread
    // over it, then the module's own `configSchema`. A variant is a cfg
    // preset, never a module selector.
    const variants = sportModule.variants as Record<string, unknown>;
    if (!Object.prototype.hasOwnProperty.call(variants, division.variantKey)) {
      fail(
        "fold.unknown_variant",
        `unknown variant "${division.variantKey}" for sport "${division.sportKey}" — ` +
          `declared variants are [${Object.keys(variants).join(", ")}]`,
      );
      return;
    }
    const merged = { ...(variants[division.variantKey] as object), ...division.cfgOverrides };
    const cfgParse = sportModule.configSchema.safeParse(merged);
    if (!cfgParse.success) {
      fail(
        "fold.cfg_invalid",
        `division "${division.ref}" cfg is rejected by ${division.sportKey}'s own configSchema: ` +
          cfgParse.error.issues.map((is) => `${is.path.join(".") || "<root>"}: ${is.message}`).join("; "),
      );
      return;
    }
    const stage = stageOfStream.get(fixtureKey(stream.divisionRef, stream.fixtureExtKey));
    const cfg = stageScopedFoldCfg(cfgParse.data, stage?.config);

    let state: unknown;
    let squads: SquadState;
    try {
      const result = foldMatchWithStoppage(
        sportModule,
        cfg,
        packLineupPair(stream),
        packEnvelopes(stream),
        PACK_FOLD_OPTIONS,
      );
      state = result.state;
      squads = result.squads;
    } catch (err) {
      // The product turns this into `import.fold_rejected` with the offending
      // event's index (event-import.ts:306-321). Same information, same
      // derivation — `data.eventId` IS the array index, because P1's synthesis
      // makes it so.
      //
      // NOT ALWAYS PRESENT, and the brief's claim that it always is proved
      // false. `eventId` is attached by the KERNEL's own refusals
      // (`core/events.ts` — validation, ALREADY_DECIDED, stoppage, monotonic
      // time, LINEUP_INVALID). A refusal thrown from inside `module.apply` is
      // NOT wrapped (`core/events.ts:681` calls it bare), so a module-level
      // `WRONG_PHASE` arrives with no `data` at all. The product degrades the
      // same way — `Number(undefined)` is NaN and its `eventIndex` is omitted
      // — so this is parity, not a gap opened here; the message says which
      // kind of refusal it was rather than leaving a reader to wonder.
      if (err instanceof EngineError) {
        const index = Number((err.data as { eventId?: string } | undefined)?.eventId);
        const at = Number.isFinite(index)
          ? `event #${index} ("${stream.events[index]?.type ?? "?"}")`
          : `an event it did not name (a refusal thrown inside the sport module carries no data.eventId)`;
        fail("fold.rejected", `the engine refused ${at} with ${err.code}: ${err.message}`);
        return;
      }
      fail("fold.threw", `folding this stream threw a non-engine error: ${String(err)}`);
      return;
    }

    // PARITY POINT P2 — event-import.ts:323-328.
    const outcome = sportModule.outcome(state);
    if (outcome === null) {
      fail(
        "fold.not_decided",
        `the stream folds legally but reaches no decided outcome — the product rejects exactly ` +
          `this stream as import.not_decided (usecases/event-import.ts:323), so a pack carrying ` +
          `it would be refused on seeding`,
      );
      return;
    }

    folded.set(fixtureKey(stream.divisionRef, stream.fixtureExtKey), {
      stream,
      division,
      stage,
      module: sportModule,
      cfg,
      state,
      squads,
      outcome,
      summary: sportModule.summary(state),
    });
  });

  // Compare each folded stream against its own oracle. `PackSchema` already
  // guarantees every stream has one (its anti-vacuity rule), so a missing
  // entry here is unreachable for a parsed pack.
  const matchByFixture = new Map<string, PackExpectedMatch>(
    pack.expected.matches.map((m) => [fixtureKey(m.divisionRef, m.fixtureExtKey), m]),
  );
  pack.streams.forEach((stream, i) => {
    const key = fixtureKey(stream.divisionRef, stream.fixtureExtKey);
    const fold = folded.get(key);
    const expected = matchByFixture.get(key);
    if (fold === undefined || expected === undefined) return;
    const divergence = firstMatchDivergence(fold, expected);
    if (divergence !== null) {
      failedDivisions.add(stream.divisionRef);
      add("error", divergence.code, streamLabel(stream, i), divergence.message);
    }
  });

  // -- Stage 3: derived standings ----------------------------------------
  pack.expected.tables.forEach((table, i) => {
    const where = `expected.tables[${i}] (${table.divisionRef}/${table.stageRef})`;
    const division = divisionByRef.get(table.divisionRef);
    if (division === undefined) return; // unreachable for a parsed pack
    const stage = division.stages.find((s) => s.ref === table.stageRef);
    if (stage === undefined) return; // unreachable for a parsed pack

    const unbound = unboundOf(division.ref);
    if (unbound.length > 0) {
      add(
        "warning",
        "standings.stage_unbindable",
        where,
        `not checked: ${unbound.length} stream(s) in division "${division.ref}" name no stage and ` +
          `the division has ${division.stages.length} stages, so stage 0 cannot tell which of them ` +
          `belong to stage "${stage.ref}". Declaring streams[].stageRef on every stream closes this`,
      );
      return;
    }
    if (table.poolKey !== undefined) {
      add(
        "warning",
        "standings.pool_unbindable",
        where,
        `not checked: the table is scoped to pool "${table.poolKey}" and a pack stream declares no ` +
          `pool — in the product the FIXTURE row carries it, and a pack declares no fixtures`,
      );
      return;
    }
    if (!TABLE_STAGE_KINDS.has(stage.kind)) {
      add(
        "error",
        "standings.not_a_table_stage",
        where,
        `stage "${stage.ref}" is kind "${stage.kind}", which produces a bracket rather than a ` +
          `table — expected.tables asserts a folded standings table and there is none to fold`,
      );
      return;
    }
    if (failedDivisions.has(division.ref)) {
      add(
        "warning",
        "standings.upstream_fold_failed",
        where,
        `not checked: at least one stream in division "${division.ref}" did not fold to a verified ` +
          `outcome, so a table built from the rest would report a second, derived failure that ` +
          `hides the first`,
      );
      return;
    }

    // Only the streams that belong to THIS stage. With every stream bound,
    // a multi-stage division gets a table per stage instead of one wrong one.
    const streams = streamsOf(division.ref).filter(
      (st) => stageOfStream.get(fixtureKey(st.divisionRef, st.fixtureExtKey))?.ref === stage.ref,
    );
    const rows = deriveStandings(division, stage, streams, seedByEntrant, folded);
    if (typeof rows === "string") {
      add("error", "standings.underivable", where, rows);
      return;
    }
    const divergence = firstTableDivergence(rows, table);
    if (divergence !== null) add("error", divergence.code, where, divergence.message);
  });

  // Q3 — a TABLE-kind stage with folded streams and no `expected.tables` row
  // is unasserted, and stage 3 is the only thing that catches an end-to-end
  // reversed stream. `PackSchema`'s anti-vacuity rule covers streams (every
  // stream needs an `expected.matches` oracle) and stops there, so this is the
  // gate's own blind spot. Reported, not failed: whether a stage's table is
  // owed is an authoring judgement, and the better long-term home is the
  // schema's own anti-vacuity check before the B06 freeze.
  const tabled = new Set(
    pack.expected.tables.map((table) => fixtureKey(table.divisionRef, table.stageRef)),
  );
  for (const division of pack.divisions) {
    for (const stage of division.stages) {
      if (!TABLE_STAGE_KINDS.has(stage.kind)) continue;
      if (tabled.has(fixtureKey(division.ref, stage.ref))) continue;
      const played = streamsOf(division.ref).filter(
        (st) => stageOfStream.get(fixtureKey(st.divisionRef, st.fixtureExtKey))?.ref === stage.ref,
      );
      if (played.length === 0) continue;
      add(
        "warning",
        "standings.no_expected_table",
        `divisions[ref=${division.ref}].stages[ref=${stage.ref}]`,
        `${played.length} stream(s) fold into stage "${stage.ref}" (kind "${stage.kind}") and the ` +
          `pack declares no expected.tables row for it — so nothing asserts its points or its tie ` +
          `order, and the derived-standings stage is the ONLY one that catches an end-to-end ` +
          `reversed stream`,
      );
    }
  }

  // Q2 — three declared oracle blocks stage 0 does NOT derive. Unlike the four
  // things it cannot bind, these were silent: a pack with a wholly fabricated
  // leaderboard reported "ok, no findings", which is exactly the "looks like
  // it passed" shape the warning channel exists for. Each names its count and
  // its owner. The DECISION not to derive them is in the LIMITS block above.
  const notDerived: readonly [string, string, number, string][] = [
    [
      "leaderboards.not_derived",
      "expected.leaderboards",
      pack.expected.leaderboards.length,
      "the product's player-stats fold needs a PlayerStatsFoldCtx built from entrant-member rows " +
        "(usecases/player-stats.ts:124-140), and a second, differently-built ctx here would be a " +
        "parallel implementation rather than a check",
    ],
    [
      "champions.not_derived",
      "expected.champions",
      pack.expected.champions.length,
      "a champion is the product's stage-completion and progression answer, not the fold's",
    ],
    [
      "suspensions.not_derived",
      "expected.suspensions",
      pack.expected.suspensions.length,
      "a discipline carry-over spans fixtures, and stage 0 folds each fixture on its own",
    ],
  ];
  for (const [code, block, count, why] of notDerived) {
    if (count === 0) continue;
    add(
      "warning",
      code,
      block,
      `${count} declared ${block} entr${count === 1 ? "y is" : "ies are"} NOT checked offline: ${why}. ` +
        `Owed to the seeded HTTP run (B05)`,
    );
  }

  // -- Stage 4: specials --------------------------------------------------
  pack.expected.specials.forEach((special, i) => {
    const where = `expected.specials[${i}] (${special.kind} ${special.divisionRef}/${special.fixtureExtKey})`;
    const fold = folded.get(fixtureKey(special.divisionRef, special.fixtureExtKey));
    if (fold === undefined) {
      add(
        "warning",
        "special.upstream_fold_failed",
        where,
        `not checked: fixture "${special.fixtureExtKey}" did not fold to a verified outcome`,
      );
      return;
    }
    for (let j = 0; j < special.claims.length; j++) {
      const claim = special.claims[j];
      const message = claimDivergence(fold, claim);
      if (message !== null) {
        // FIRST divergent claim only: a special's claims describe one
        // mechanic, and reporting all of them buries the one that broke.
        add("error", `special.${claim.on}`, `${where} claims[${j}]`, message);
        return;
      }
    }
  });

  // -- Stage 5: provenance stats -----------------------------------------
  const provenance = provenanceStats(pack);

  return {
    ok: !findings.some((f) => f.severity === "error"),
    findings,
    provenance,
    pack,
  };
}

function engineCodeOf(err: unknown): string {
  return err instanceof EngineError ? err.code : String(err);
}

// ---------------------------------------------------------------------------
// Stage 2's comparison — the FIRST divergent assertion, per stream
// ---------------------------------------------------------------------------

interface Divergence {
  readonly code: string;
  readonly message: string;
}

function firstMatchDivergence(fold: FoldedStream, expected: PackExpectedMatch): Divergence | null {
  const outcome = fold.outcome;
  const want = expected.outcome;
  if (outcome.kind !== want.kind) {
    return {
      code: "match.outcome_kind",
      message: `outcome kind: pack expects "${want.kind}", the fold produced "${outcome.kind}"`,
    };
  }
  // `got = "x" in outcome ? outcome.x : undefined`, the same shape
  // `claimDivergence` uses — NOT `"x" in want && "x" in outcome && ...`. The
  // conjunction reads as a guard and is structurally always true (the two
  // unions are discriminated on the same five kinds, and Task 1's
  // `OUTCOME_KINDS_ARE_EXHAUSTIVE` proves the kind sets are equal), so it
  // cannot fail open today — but two shapes answering one question in one file
  // is how a later reader picks the one that can.
  if ("winner" in want) {
    const got = "winner" in outcome ? outcome.winner : undefined;
    if (got !== sigil(want.winner)) {
      return {
        code: "match.outcome_winner",
        message: `winner: pack expects "${want.winner}", the fold produced ${show(got)}`,
      };
    }
  }
  if ("loser" in want) {
    const got = "loser" in outcome ? outcome.loser : undefined;
    if (got !== sigil(want.loser)) {
      return {
        code: "match.outcome_loser",
        message: `loser: pack expects "${want.loser}", the fold produced ${show(got)}`,
      };
    }
  }
  // `method` is asserted only when the pack states one — a pack that does not
  // care which method decided a fixture must not be forced to guess.
  if ("method" in want && want.method !== undefined) {
    const got = "method" in outcome ? outcome.method : undefined;
    if (got !== want.method) {
      return {
        code: "match.outcome_method",
        message: `method: pack expects "${want.method}", the fold produced ${show(got)}`,
      };
    }
  }
  if (expected.perSide !== undefined) {
    // BY ENTRANT, never by index: `ScoreSummary.perSide`'s order is not
    // contractual (pack-schema.ts's own note on the pack convention), so an
    // index comparison would silently assert the module's array order.
    for (const side of expected.perSide) {
      const got = fold.summary.perSide.find((s) => s.entrantId === sigil(side.entrant));
      if (got === undefined) {
        return {
          code: "match.side_missing",
          message: `perSide names entrant "${side.entrant}" but the module's summary has no line ` +
            `for it (it has [${fold.summary.perSide.map((s) => s.entrantId).join(", ")}])`,
        };
      }
      if (got.line !== side.line) {
        return {
          code: "match.side_line",
          message: `score line for "${side.entrant}": pack expects "${side.line}", the fold produced "${got.line}"`,
        };
      }
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Stage 3's derivation — the product's own competition path
// ---------------------------------------------------------------------------

/**
 * Fold a division's streams into the ranked standings rows, through exactly
 * the path `recomputeStandings` uses:
 * `sportModule.standingsDelta(outcome, cfg, ctx, state)` per fixture, an
 * optional `applyPointsRule`, then `completeTableStage`.
 *
 * Mirrors `apps/web/src/server/engine-db/competition.ts` — `ctxBase` at `:236`
 * (`{ kind }`, the stage's OWN kind, not the americano→league display map),
 * the per-fixture delta at `:276-283`, the points rule at `:290-292`, and
 * `toTableStage` at `:329-352`. Returns a message instead of rows when the
 * derivation itself is impossible.
 */
function deriveStandings(
  division: PackDivision,
  stage: PackStage,
  streams: readonly PackStream[],
  seedByEntrant: ReadonlyMap<string, number>,
  folded: ReadonlyMap<string, FoldedStream>,
): readonly StandingsRow[] | string {
  // The string return is a DERIVATION failure, reported as
  // `standings.underivable`. Exactly one of its three cases is reachable for a
  // parsed pack — a stage `points` rule the engine's own schema refuses, which
  // has its own test. The other two are defensive: a stream with no folded
  // outcome cannot get here (the caller's `failedDivisions` gate returns
  // first), and `completeTableStage` always yields at least one pool. Said out
  // loud so neither is mistaken for a tested branch.
  const ctxBase: StageCtx = { kind: stage.kind };
  const pointsRuleRaw = stage.config["points"];
  let pointsRule: PointsRule | null = null;
  if (pointsRuleRaw !== undefined && pointsRuleRaw !== null) {
    const rule = PointsRule.safeParse(pointsRuleRaw);
    if (!rule.success) return `stage "${stage.ref}" declares a points rule the engine refuses: ${rule.error.message}`;
    pointsRule = rule.data;
  }

  const fixtures: TableFixture[] = [];
  const entrants: string[] = [];
  const seen = new Set<string>();
  for (const stream of streams) {
    const fold = folded.get(fixtureKey(stream.divisionRef, stream.fixtureExtKey));
    if (fold === undefined) return `stream "${stream.fixtureExtKey}" has no folded outcome`;
    for (const side of [stream.home, stream.away]) {
      if (!seen.has(side)) {
        seen.add(side);
        entrants.push(sigil(side));
      }
    }
    const pair = fold.module.standingsDelta(fold.outcome, fold.cfg, ctxBase, fold.state);
    fixtures.push({
      id: fixtureKey(stream.divisionRef, stream.fixtureExtKey),
      // Every folded stream is a played fixture. `decided` and `walkover` are
      // the two statuses `COUNTS_FOR_STANDINGS` admits (competition/stage.ts:
      // 20) and the fold treats them identically, so the distinction — which
      // is a fixture-row fact a pack does not declare — cannot change a row.
      status: "decided",
      result: pointsRule ? applyPointsRule(fold.outcome, pair, pointsRule) : pair,
    });
  }

  // The entrant seeds `toTableStage` reads off the entrant rows; a pack
  // declares them on `entrants[].seed`. Only seeded entrants appear, and only
  // those in THIS stage's pool — the same shape the product's `seeds` map has.
  const seeds = new Map<string, number>();
  for (const id of entrants) {
    const seed = seedByEntrant.get(id);
    if (seed !== undefined) seeds.set(id, seed);
  }

  // Everything else `toTableStage` (competition.ts:329-352) reads off the
  // STAGE's config, carried verbatim in a pack's `stages[].config`. Mirrored
  // in full rather than in part: a stage-config key the product applies and
  // stage 0 ignores makes the offline table differ from the seeded one, which
  // is a false red on a correct pack.
  //
  // WHICH OF THESE `completeTableStage` ACTUALLY READS, measured rather than
  // assumed, because a mirror line nothing consumes is dead weight a reader
  // will take for a live one:
  //   consumed  — entrants, cascade, seeds, rngSeed (the `lots` draw),
  //               swiss (assembles the ledger buchholz/sberger/direct need),
  //               openingDeltas, rankLocks, h2hScope. Each has its own test.
  //   CARRIED ONLY — `kind` and `rounds`. `completeTableStage` reads neither:
  //               `kind` is a required field of `TableStage` and `rounds` is
  //               read by `isTableStageComplete`, which this path never calls.
  //               They are kept so the construction stays diff-able against
  //               `toTableStage`, and their mutants are recorded as equivalent
  //               in the task report rather than chased with a fake test.
  const stageConfig = stage.config as Record<string, unknown>;
  const carry = stageConfig["carry_deltas"];
  const overrides = stageConfig["rank_overrides"];
  const tableStage: TableStage = {
    id: stage.ref,
    // americano rides the league fold (competition.ts:333, "Jul3/08 §3").
    kind: (stage.kind === "americano" ? "league" : stage.kind) as TableStage["kind"],
    entrants,
    cascade: (division.tiebreakers ?? tiebreakersOf(folded, streams)) as TableStage["cascade"],
    ...(seeds.size > 0 ? { seeds } : {}),
    // `!= null`, matching `toTableStage` exactly (competition.ts:337-338) and
    // NOT a `typeof === "number"` sniff. `PackStage.config` is an opaque JSON
    // record, so a string `rngSeed` is expressible; a type sniff would drop it
    // here while the product forwards it, and a pack with a typo'd seed would
    // then fold green offline and rank differently on seeding — the exact
    // divergence "mirrored in full" exists to prevent.
    ...(stageConfig["rngSeed"] != null ? { rngSeed: stageConfig["rngSeed"] as number } : {}),
    ...(stageConfig["rounds"] != null ? { rounds: stageConfig["rounds"] as number } : {}),
    ...(stage.kind === "swiss" ? { swiss: true } : {}),
    ...(Array.isArray(carry) ? { openingDeltas: carry as readonly StandingsDelta[] } : {}),
    ...(Array.isArray(overrides)
      ? {
          rankLocks: (overrides as { entrant_id: string; rank: number }[]).map((o) => ({
            entrantId: o.entrant_id,
            rank: o.rank,
          })),
        }
      : {}),
    ...(stageConfig["h2h_scope"] === "overall" ? { h2hScope: "overall" as const } : {}),
  };

  const completed = completeTableStage(tableStage, fixtures);
  const pool = completed.tables.pools[0];
  return pool === undefined ? `stage "${stage.ref}" produced no pool table` : pool.rows;
}

/** The cascade a division inherits when it declares none — the SPORT's own
 *  default (`cascadeFor`, competition.ts:326-328). Read off the module that
 *  actually folded the streams rather than re-resolved, so the two can never
 *  be two different modules. */
function tiebreakersOf(
  folded: ReadonlyMap<string, FoldedStream>,
  streams: readonly PackStream[],
): readonly string[] {
  for (const stream of streams) {
    const fold = folded.get(fixtureKey(stream.divisionRef, stream.fixtureExtKey));
    if (fold !== undefined) return fold.module.defaultTiebreakers;
  }
  return [];
}

const TABLE_SCALARS = ["played", "won", "drawn", "lost", "points"] as const;

/**
 * The first divergence between the derived table and the pack's, compared
 * POSITIONALLY.
 *
 * Position is the assertion: `PackExpectedTableRow.rank` is forced to equal
 * `j + 1` by the schema, so array order IS the exact final order and a
 * comparison keyed by entrant would pass against a swapped tie order while
 * still checking every number.
 */
function firstTableDivergence(
  derived: readonly StandingsRow[],
  table: PackExpectedTable,
): Divergence | null {
  if (derived.length !== table.rows.length) {
    return {
      code: "standings.row_count",
      message: `the fold produced ${derived.length} row(s), the pack declares ${table.rows.length}`,
    };
  }
  for (let j = 0; j < table.rows.length; j++) {
    const want = table.rows[j];
    const got = derived[j];
    if (got.entrantId !== sigil(want.entrant)) {
      return {
        code: "standings.order",
        message: `rank ${j + 1}: pack expects "${want.entrant}", the fold ranked "${got.entrantId}" there`,
      };
    }
    for (const field of TABLE_SCALARS) {
      if (got[field] !== want[field]) {
        return {
          code: "standings.value",
          message: `rank ${j + 1} "${want.entrant}" ${field}: pack expects ${want[field]}, the fold produced ${got[field]}`,
        };
      }
    }
    // `metrics` is optional in the pack: a table that declares none asserts
    // none, which is how `_tiny` ships. A declared block is compared whole,
    // so an extra derived metric is a divergence too.
    if (want.metrics !== undefined && !deepEqual(got.metrics, want.metrics)) {
      return {
        code: "standings.metrics",
        message: `rank ${j + 1} "${want.entrant}" metrics: pack expects ${show(want.metrics)}, ` +
          `the fold produced ${show(got.metrics)}`,
      };
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Stage 4's claim evaluation
// ---------------------------------------------------------------------------

/** null = the claim holds. A string = what diverged, first divergence only. */
function claimDivergence(fold: FoldedStream, claim: PackClaim): string | null {
  if (claim.on === "outcome") {
    const outcome = fold.outcome;
    if (claim.kind !== undefined && outcome.kind !== claim.kind) {
      return `outcome kind: claim expects "${claim.kind}", the fold produced "${outcome.kind}"`;
    }
    if (claim.method !== undefined) {
      const got = "method" in outcome ? outcome.method : undefined;
      if (got !== claim.method) {
        return `outcome method: claim expects "${claim.method}", the fold produced ${show(got)}`;
      }
    }
    if (claim.winner !== undefined) {
      const got = "winner" in outcome ? outcome.winner : undefined;
      if (got !== sigil(claim.winner)) {
        return `outcome winner: claim expects "${claim.winner}", the fold produced ${show(got)}`;
      }
    }
    if (claim.loser !== undefined) {
      const got = "loser" in outcome ? outcome.loser : undefined;
      if (got !== sigil(claim.loser)) {
        return `outcome loser: claim expects "${claim.loser}", the fold produced ${show(got)}`;
      }
    }
    return null;
  }

  if (claim.on === "state") {
    const { found, value } = resolveStatePath(fold.state, claim.path);
    if (!found) {
      return `state path "${claim.path}" does not exist on ${fold.division.sportKey}'s folded state — ` +
        `a claim written from a line number that pointed at a DERIVED struct parses cleanly and can ` +
        `never resolve, so an unresolvable path is a pack defect, not a skipped assertion`;
    }
    if (!deepEqual(value, claim.equals)) {
      return `state "${claim.path}": claim expects ${show(claim.equals)}, the fold produced ${show(value)}`;
    }
    return null;
  }

  if (claim.on === "standings") {
    // THIS FIXTURE's own delta, never the cumulative stage table — that is
    // what expected.tables asserts, and conflating them would make one claim
    // mean different things in a one-round and a six-round stage.
    const ctx: StageCtx = { kind: fold.stage?.kind ?? "league" };
    const pair = fold.module.standingsDelta(fold.outcome, fold.cfg, ctx, fold.state);
    const delta = pair.find((d) => d.entrantId === sigil(claim.entrant));
    if (delta === undefined) {
      return `standings claim names entrant "${claim.entrant}", which did not play this fixture ` +
        `(its delta pair is for [${pair.map((d) => d.entrantId).join(", ")}])`;
    }
    const got = delta[claim.field];
    if (got !== claim.equals) {
      return `standings ${claim.field} for "${claim.entrant}": claim expects ${claim.equals}, ` +
        `this fixture's delta gives ${got}`;
    }
    return null;
  }

  // `squads` — the kernel's own bookkeeping, a SIBLING of the module state
  // (`foldMatchWithStoppage` returns `{state, stoppage, squads}`,
  // core/events.ts:464), which is why no state path can reach it and why the
  // concussion-substitute special needs this branch at all.
  const side =
    fold.squads.home.entrantId === sigil(claim.entrant)
      ? fold.squads.home
      : fold.squads.away.entrantId === sigil(claim.entrant)
        ? fold.squads.away
        : undefined;
  if (side === undefined) {
    return `squads claim names entrant "${claim.entrant}", which is neither side of this fixture ` +
      `("${fold.squads.home.entrantId}" and "${fold.squads.away.entrantId}")`;
  }
  if (claim.field === "subsUsed") {
    if (side.subsUsed !== claim.equals) {
      return `squads subsUsed for "${claim.entrant}": claim expects ${claim.equals}, the fold produced ${side.subsUsed}`;
    }
    return null;
  }
  // An exemption never charged has no key at all, and "never charged" is 0 —
  // so `?? 0` rather than an absence error, which would make `equals: 0`
  // unassertable exactly where it matters most.
  const key = claim.exemption as string;
  const got = side.exemptUsed[key] ?? 0;
  if (got !== claim.equals) {
    return `squads exemptUsed["${key}"] for "${claim.entrant}": claim expects ${claim.equals}, the fold produced ${got}`;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Stage 5 — provenance
// ---------------------------------------------------------------------------

function provenanceStats(pack: Pack): PackProvenanceStats {
  const zero = (): { real: number; reconstructed: number; synthetic: number; total: number } => ({
    real: 0,
    reconstructed: 0,
    synthetic: 0,
    total: 0,
  });
  const byDivision: Record<string, ProvenanceSplit> = {};
  const counters = new Map<string, ReturnType<typeof zero>>();
  for (const d of pack.divisions) counters.set(d.ref, zero());
  const overall = zero();

  for (const stream of pack.streams) {
    const provenance: PackProvenance = stream.provenance;
    const bucket = counters.get(stream.divisionRef);
    if (bucket !== undefined) {
      bucket[provenance] += 1;
      bucket.total += 1;
    }
    overall[provenance] += 1;
    overall.total += 1;
  }
  for (const [ref, bucket] of counters) byDivision[ref] = { ...bucket };
  return { overall: { ...overall }, byDivision };
}
