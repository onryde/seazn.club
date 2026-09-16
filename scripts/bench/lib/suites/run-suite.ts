// The bench's own proof loop. Seeds one org + one 2-entrant division through
// the real HTTP API, schedules it, and asserts zero blocking conflicts via
// /divisions/{id}/schedule/validate. This is the bench's smoke AND e2e entry
// point from here on (_RULES.md §1, B01 brief) — no separate e2e test
// exists at this layer because this run IS the exercise.
//
// Endpoint shapes are hand-copied from scripts/smoke.ts's own precedent
// (never imported — see lib/http.ts's header): the minimal competition ->
// division -> entrants -> stage -> generate flow at smoke.ts:1040-1062, and
// the venue/court + schedule-settings -> schedule/auto -> schedule/apply ->
// schedule/validate flow at smoke.ts:8800-9026.
//
// ---------------------------------------------------------------------------
// B02 — THE SEED DATA IS THE PACK'S (session prompt item 4)
// ---------------------------------------------------------------------------
// This suite used to declare its competition, division cfg, entrants and stage
// inline, and `packs/_tiny.json` did not exist. Now both this runner and the
// stage-0 validator read the SAME committed file, which is the point: a shared
// artifact, not a refactor. What the run EXERCISES is unchanged — sign in, one
// venue and court, a competition, a division, two entrants, one league stage,
// generate, schedule/auto, schedule/apply, schedule/validate — only where its
// data comes from has moved.
//
// ---------------------------------------------------------------------------
// T4 — ONTO THE SHARED SEEDING LAYER, PLUS `--keep` IDEMPOTENCE
// ---------------------------------------------------------------------------
// This suite used to build its own request bodies via `tinyPlan` (a
// one-division, one-stage-only reader) and drive its own HTTP for org,
// competition, division, entrants and stage creation + generation. Both are
// gone: the plan now comes from `buildSeedPlan` (lib/seed-plan.ts, a pure
// pack -> plan mapping with no one-division refusal) and the HTTP is driven
// by `seedSuite` (lib/seed.ts). `runPackSuite` itself still only DRIVES
// `_tiny.json`'s one division/one stage for the scheduling half below — that
// assumption did not move, only the seeding half did, which is what
// `buildSeedPlan`/`seedSuite` were built (B03) to generalise past.
//
// `fixtureCountIssue` and the pack stage (`tinyPackStage`) both had to be
// adapted rather than deleted (T4 brief): `TinySeedPlan` is gone, so both now
// speak `SeedPlan` — an N-division/N-stage shape. At T4 this read only the
// FIRST `expectedFixtureCounts` entry, which for the then-single-division
// `_tiny.json` was the only one there was.
//
// B03 T5 (`_tiny.json` gains a second division, `d-badminton`) is what makes
// that premise false: `actual` at the one call site below is always
// `seeded.fixtureIdByKey.size`, a POOL-wide count spanning every division
// `seedSuite` bound fixtures for — so `fixtureCountIssue` now SUMS every
// `expectedFixtureCounts` entry rather than reading `[0]` alone. See its own
// doc comment for the full reasoning; a single-league-stage pack (every pack
// before T5) gets the identical message it always did.
//
// A `SeedTransport` is threaded through every HTTP call this file makes
// (`PackSuiteInput.transport`, defaulted to `seed.ts`'s own
// `defaultTransport`) — the same DI shape `seed.ts` itself uses
// (`lib/env.ts`'s `runPreflight` is the original precedent) — so the
// idempotence guard below is unit-testable with a fake, never `global.fetch`.
//
// ---------------------------------------------------------------------------
// `--keep` idempotence — `findExistingSeed`
// ---------------------------------------------------------------------------
// There is no `POST /api/v1/orgs` and no `PATCH` either (checked: no
// `app/api/v1/orgs/route.ts` exists, only `orgs/[id]/...` subresources) — the
// org a bench run lands in is whatever its sign-in email's FIRST sign-in ever
// provisioned, and nothing lets this file choose its slug or name. So the
// marker a later `--keep` run looks for cannot hang off the org; it hangs off
// the COMPETITION instead: a hash of the pack's own content
// (`lib/pack-hash.ts`), sent as `CreateCompetition.branding` (jsonb,
// ungated — schemas.ts:95, written at usecases/competitions.ts:202-209) on
// the SAME create call that seeds the competition, and read back with
// `GET /api/v1/competitions`, matched against the pack's own declared
// competition slug. NOT `description`: that field is markdown rendered on
// public surfaces, and `--keep` leaves orgs browsable by design — a hash
// there would be customer-visible litter.
//
// For a SECOND process invocation to ever find what a FIRST one seeded, both
// have to sign in to the SAME org — which means the sign-in email cannot be
// the random-per-run `randomUUID()` tag this suite used unconditionally
// before T4. Under `--keep` (the CLI's default: bench.ts's
// `keep: !values.wipe`) the run tag is now the FIXED literal `"keep"`, so
// every `--keep` run's email — and therefore its org — is the same. Under
// `--wipe` the run tag stays the original random one: a fresh org every
// run, and (since the lookup below is gated on `keep` and never even
// attempted otherwise) a guarantee it never short-circuits, matching the
// brief's third required case directly.
//
// KNOWN LIMITATION, disclosed rather than solved here: `_tiny.json` declares
// an explicit competition slug (`"bench-tiny-series"`), sent verbatim by
// `seedSuite`. If a `--keep` run's pack hash does NOT match (the pack's
// content changed since the last `--keep` run against the same org), this
// file still attempts to seed into that SAME deterministic org with that
// SAME slug — which a real backend will 409 on, since the stale, non-matching
// competition already holds that slug there (competitions.ts's own explicit-
// slug path 409s on collision; it does not retry, unlike a server-generated
// slug). This is an accepted edge case, not a defect this task fixes: it
// only bites a developer who edits `_tiny.json`'s content while iterating
// under `--keep`, and the fix in that case is a one-time `--wipe`. Solving it
// (e.g. dropping the literal slug on a mismatch and letting the server mint a
// fresh one) is future work if it turns out to bite in practice.
//
// On a SHORT CIRCUIT this run does NOT re-derive division/stage/court ids and
// does NOT re-run scheduling — it returns immediately, reporting the reuse.
// That is deliberate, not a shortcut this task ran out of time for: `--keep`'s
// own stated purpose (design doc, bench-prompts/_RULES.md "Keep-data default")
// is "so players/stats/news are browsable in the app afterwards" — the whole
// point of a repeat `--keep` run against unchanged content is that there is
// already a fully seeded (and, from a prior run, already scheduled)
// competition sitting there to look at, not something this run should touch
// again. Reconstructing enough state to re-drive scheduling against a REUSED
// competition (division/stage/court lookups this file does not otherwise
// need) is a bigger feature than "detect and skip a duplicate seed", and nothing
// in this task's brief asks for it.
import { randomUUID } from "node:crypto";
import type pino from "pino";
import { newSession, signIn, type Session } from "../http.ts";
import { formatFinding, loadPackFile } from "../pack-io.ts";
import { hashPack } from "../pack-hash.ts";
import {
  fixtureKey,
  type Pack,
  type PackAdaptation,
  type PackDivision,
  type PackExpectedMatch,
  type PackClaim,
  type PackExpectedOutcome,
  type PackStream,
} from "../pack-schema.ts";
import { bootRegistry, resolveDivisionCfg } from "../validate-pack.ts";
import { computeProvenance } from "../provenance.ts";
// The engine's own outcome union: a specials standings claim derives the
// fixture delta from the PRODUCT's folded outcome, parsed rather than cast.
import { MatchOutcome } from "@seazn/engine/core";
// B04 — the five modules this suite wires together. Each is CLOSED and owns
// one layer: `schedule.ts` drives the seven steps, `checker.ts` recomputes the
// rules independently of the product, `certificate.ts` runs §6.3's protocol,
// `believability.ts` scores what nobody gates on, and `board.ts` declares the
// seam plus `judgeDivision`, the one place a division's verdict is composed.
import {
  readEngineArtifacts,
  runDivisionStartLayer,
  runScheduleLayer,
  writeEngineArtifact,
  type DivisionStartTransport,
  type DivisionToStart,
  type EngineSnapshot,
  type EngineSnapshotDivision,
  type ScheduleDivision,
  type ScheduleLock,
} from "../schedule.ts";
import { checkBoard } from "../checker.ts";
import { certify } from "../certificate.ts";
import { assessBelievability, assessEngineDelta, type BelievabilityReport } from "../believability.ts";
import {
  judgeDivision,
  renderHistoryBoard,
  type Board,
  type BoardFixture,
  type CertificateVerdict,
  type CheckerReport,
  type EncodedConstraints,
} from "../board.ts";
import {
  buildSeedPlan,
  type SeedPlan,
  type SeedPlanDivision,
  type SeedPlanExpectedFixtureCount,
  type SeedPlanStage,
} from "../seed-plan.ts";
import {
  defaultTransport,
  runOfficialsAutoAssign,
  seedSuite,
  type ClaimInviteReadBack,
  type FixtureOfficialRow,
  type SeededSuite,
  type SeedTransport,
} from "../seed.ts";
import { defaultProbeTransport, runDlsGateProbe, type ProbeTransport } from "../dls-gate.ts";
import { acceptClaimInvites, enableAutoPosts, runNewsStep } from "../people.ts";
import { FREE_PLAN_KEY, type PlanSql } from "../plan.ts";
import {
  readPlayerStatsBaseline,
  playerStatsBaselineIssues,
  type RosterMemberRef,
} from "../stats.ts";
import { oracleLogFields } from "../report.ts";
import type {
  DivisionScheduleReport,
  DivisionStartConflictReport,
  DivisionStartReport,
  EngineDeltaSection,
  ImportFindingReport,
  ImportSimulationReport,
  OracleResult,
  OracleVerdict,
  RegistrationDivisionReport,
  SimulationReport,
  SolverResult,
  SuiteReport,
  TapPlayReport,
} from "../report.ts";
import { computeEventsPerSecond, simulateDivisionStreams, type SimulateResult } from "../simulate.ts";
import { defaultLedgerTransport } from "../ledger.ts";
import { personOutsideByEntrantFindings, saveTapLineups, tapLineupSides } from "../tap-setup.ts";
import { specialStateThroughPackEvents } from "../special-state.ts";
import {
  adapterForSport,
  browserTapPlayer,
  consoleFixturePath,
  playTapRounds,
  tapBoardRowsOf,
  type TapBoardRow,
  type TapFixtureJob,
  type TapPlayer,
  type TapPlayerFactory,
} from "../tap-play.ts";
import { buildImportId, importDivisionStreams, type ImportFinding } from "../import.ts";
// B07a T7 — `types.ts` carries only `import type` statements, so this is a
// TYPE-ONLY module at runtime and importing its one function here adds no
// runtime edge back into `tiny.ts`/`registry.ts` (the cycle that file's own
// header exists to avoid). `strip-types-loadable.test.ts` spawns a real
// import of every shipped module, which is what keeps that claim honest.
import { playModeFor, type PlayDeclaration } from "./types.ts";
import {
  advanceStageSeeding,
  compareFinalRanks,
  completeStageCapture,
} from "../advance.ts";
import {
  compareCareerStats,
  compareChampion,
  compareLeaderboard,
  comparePersonDivisionStat,
  compareRankCrossings,
  compareStandings,
  compareSuspensions,
  compareTieOrderCascade,
  confirmSuspension,
  createManualSuspension,
  fetchActiveSuspensions,
  fetchDivisionPlayerStats,
  fetchFixtureLineup,
  putFixtureLineup,
  suspensionMismatchReasons,
  fetchPersonCareerStats,
  fetchPersonStats,
  fetchStandings,
  renderChampionMismatch,
  renderLeaderboardMismatch,
  renderRankCrossingMismatch,
  renderSideBySide,
  renderStandingsMismatch,
  renderUndeclaredMetrics,
  standingsRankOrder,
  type DivisionPlayerStatsWire,
  type ExpectedCareerStat,
  type ExpectedLeaderboardEntry,
  type ExpectedStandingsRow,
  type ExpectedSuspension,
  type PersonCareerStatsWire,
  type PersonStatsWire,
  type SuspensionFixtureSheet,
  compareMatches,
  compareSpecials,
  fetchDivisionFixtures,
  fetchFixtureModuleState,
  fetchFixtureSideLines,
  type ActualMatchRow,
  type ExpectedMatchRow,
  type ResolvedSpecial,
  type ResolvedSpecialClaim,
  type SpecialSubject,
} from "../oracle.ts";
import type { SelectedDivisionExposure } from "../env.ts";
import {
  resolveEntryMode,
  runRegistrationDivision,
  type CliEntryFlag,
  type FunnelRow,
} from "../register.ts";
import type { Captain, Organiser, Player } from "../drivers/types.ts";
import { httpCaptain, httpOrganiser, httpPlayer } from "../drivers/http.ts";
import {
  browserCaptain,
  browserOrganiser,
  browserPlayer,
  closeRegistrationBrowserSession,
  launchRegistrationBrowser,
  newAnonymousBrowserSession,
  newOrganiserBrowserSession,
  type RegistrationBrowserSession,
} from "../drivers/browser.ts";
import {
  expectedQualifierRefs,
  type QualifierTable,
  type TopNPerGroup,
} from "../qualifiers.ts";

/** What a suite definition tells the runner about itself: which key its
 *  report and log lines carry, and which pack to fold when the caller does
 *  not override `input.packPath`. */
export interface RunPackSuiteOptions extends PlayDeclaration {
  readonly suiteKey: string;
  readonly packPath: string;
}

/** The `--keep` idempotence marker's key inside `competitions.branding`
 *  (jsonb). Exported so a test can construct a matching/mismatching branding
 *  value without hand-typing the key twice. */
export const KEEP_BRANDING_KEY = "benchPackHash";

// ---------------------------------------------------------------------------
// B07a T5 — WHICH qualifier derivation the advance step uses (D7).
//
// Two source shapes, two rules. An UNPOOLED source stage has one stage-wide
// `expected.tables` row and its qualifiers are that row in rank order — the
// long-standing behaviour `_tiny`'s league -> playoff advance relies on. A
// POOLED source stage has one table PER POOL and no stage-wide row at all, so
// the flat path has nothing to read; its seat order comes from the
// progression rule itself (`lib/qualifiers.ts`).
//
// Every refusal below yields NO seats and NAMES what it saw. Guessing a rule
// would assert a confident wrong ORDER — the exact failure this task exists to
// prevent — whereas an empty list is length-compared against the product's
// real proposal and reds loudly.
// ---------------------------------------------------------------------------

/** The advance step's expected qualifier order, plus how it was reached. */
export interface ExpectedQualifierOrder {
  /** Entrant REFS in seat order (seed 1 first); `[]` when none could be derived. */
  readonly refs: readonly string[];
  /** True when the source stage declared pools and the progression rule was used. */
  readonly pooled: boolean;
  /** Set when the progression could not be read: a placement that does not
   *  consume the list verbatim (EITHER source shape), or — for a pooled
   *  source — a take rule this derivation does not cover. Names what was
   *  actually found, never a guess. */
  readonly warning?: string;
}

function takeKindOf(rule: unknown): string {
  const kind = (rule as Record<string, unknown> | null)?.["kind"];
  return typeof kind === "string" ? kind : JSON.stringify(kind);
}

/**
 * The PLACEMENT check — applied to EVERY source shape, pooled or not.
 *
 * `rank_order` is a plain `pots.flat()` that consumes the qualifier list
 * VERBATIM (`placeDescriptors`, progression.ts:239-298). `snake` reverses
 * alternate waves and `seeded_map` seats named qualifiers at named slots, so
 * under either one a rank-order expectation is confidently WRONG rather than
 * merely unverified — and the mismatch would blame the PRODUCT for the
 * bench's own assumption.
 *
 * Fix round 1, I2: this used to live inside `parseTopNPerGroup`, which runs
 * only for a POOLED source. An UNPOOLED stage declaring `seeded_map` skipped
 * it entirely and was handed a flat rank-order expectation — a false red on a
 * legitimate pack.
 *
 * Deliberately CONSERVATIVE, and worth knowing before anyone tightens it:
 * `placeDescriptors` returns `flat` UNCHANGED when a `seeded_map` carries no
 * map or an empty one (progression.ts:299), so that particular shape would in
 * fact consume the list as-is and is refused here anyway. The refusal is loud
 * and harmless; do not read this as a claim that `seeded_map` always permutes.
 *
 * Fix round 2 — this now also checks the SOURCE COUNT. That is the other half
 * of the same I2 finding, and round 1 left it behind: the count sat inside
 * `parseTopNPerGroup`, which runs for a POOLED source only, so an UNPOOLED
 * stage fed by a two-source progression was handed its flat table with NO
 * warning at all, while the identical progression on a pooled stage was
 * refused by name. Both are SHAPE facts — each invalidates the flat
 * derivation exactly as it invalidates the pooled one — so both belong above
 * the pooled/unpooled split, and the two shapes now refuse in parity.
 *
 * Returns the single validated source on success, so the take-rule parser
 * never re-reads and never re-checks `sources`: one check, one place. A
 * duplicated guard would be worse than none — the two cover for each other,
 * and neither can then be killed by mutation.
 */
function progressionShape(
  progression: Record<string, unknown>,
): { reason: string } | { source: Record<string, unknown> } {
  const placement = progression["placement"];
  if (placement !== "rank_order") {
    return {
      reason:
        `its placement is ${JSON.stringify(placement)} rather than "rank_order" — only rank_order ` +
        "consumes the qualifier list verbatim (snake reverses alternate waves; seeded_map seats by name)",
    };
  }

  const sources = progression["sources"];
  if (!Array.isArray(sources) || sources.length !== 1) {
    return {
      reason: `it declares ${Array.isArray(sources) ? sources.length : JSON.stringify(sources)} progression sources, and this derivation covers exactly one`,
    };
  }

  return { source: (sources[0] ?? {}) as Record<string, unknown> };
}

/**
 * Narrowly parse the TAKE RULE out of ONE progression source — the source
 * having already been validated and handed over by `progressionShape`. The
 * progression is carried OPAQUE through the schema (`pack-schema.ts:459`, a
 * `Record<string, PackJsonValue>`), so every field is checked rather than
 * trusted. Neither placement NOR the source count is this function's
 * business; both are shape facts and live in `progressionShape`.
 */
function parseTopNPerGroup(
  source: Record<string, unknown>,
): { rule: TopNPerGroup } | { reason: string } {
  const take = source["take"];
  if (!Array.isArray(take) || take.length !== 1) {
    const kinds = Array.isArray(take)
      ? take.map((t) => takeKindOf(t)).join(", ")
      : JSON.stringify(take);
    return { reason: `its source combines take rules [${kinds}], and this derivation covers exactly one` };
  }

  const kind = takeKindOf(take[0]);
  if (kind !== "topNPerGroup") {
    return { reason: `its take rule is "${kind}", not topNPerGroup` };
  }

  const n = (take[0] as Record<string, unknown>)["n"];
  if (typeof n !== "number" || !Number.isInteger(n) || n < 1) {
    return { reason: `its topNPerGroup n is ${JSON.stringify(n)}, not a positive integer` };
  }
  return { rule: { kind: "topNPerGroup", n } };
}

/**
 * The expected qualifier refs for a progression-fed stage, choosing between
 * the pooled derivation and the flat table by what the SOURCE stage actually
 * declared. Exported so this decision is directly testable: a branch that
 * silently picks the wrong path is exactly the inert-seam class
 * (AGENTS.md failure class 1).
 */
export function expectedQualifierOrder(
  stageTables: readonly QualifierTable[],
  progression: Record<string, unknown> | undefined,
): ExpectedQualifierOrder {
  // No table at all: the caller already names that, and a second complaint
  // about the same fact would only obscure it.
  if (stageTables.length === 0) return { refs: [], pooled: false };

  const pooledTables = stageTables.filter((t) => t.poolKey !== undefined);
  const pooled = pooledTables.length > 0;
  const flatRefs = (): readonly string[] => {
    const flat = stageTables.find((t) => t.poolKey === undefined);
    return [...(flat?.rows ?? [])].sort((a, b) => a.rank - b.rank).map((r) => r.entrant);
  };

  if (progression === undefined) {
    // An UNPOOLED source needs no progression to be read: its seats ARE its
    // one table, in rank order. A POOLED one has no seat order without the rule.
    return pooled
      ? { refs: [], pooled: true, warning: "it declares no progression at all" }
      : { refs: flatRefs(), pooled: false };
  }

  // I2, BOTH halves: the progression's SHAPE — placement and source count —
  // is checked for either source shape, above the split. Each fact
  // invalidates the flat derivation exactly as it invalidates the pooled one,
  // so a refusal here reads the same whether the source declared pools or not.
  const shape = progressionShape(progression);
  if ("reason" in shape) return { refs: [], pooled, warning: shape.reason };

  if (!pooled) return { refs: flatRefs(), pooled: false };

  const parsed = parseTopNPerGroup(shape.source);
  if ("reason" in parsed) return { refs: [], pooled: true, warning: parsed.reason };
  return { refs: expectedQualifierRefs(pooledTables, parsed.rule), pooled: true };
}

// ---------------------------------------------------------------------------
// Registration wiring (B03r tasks 9+10, design §3/§9) — the --entry
// resolution `bench.ts` parses but never wires (this file's own former
// header comment). One registration-carrying division (`_tiny`'s own
// `d-registration`) is driven through `register.ts`'s `runRegistrationDivision`
// with either the http driver (`entry: "registration-api"`) or the browser
// driver (`entry: "registration-ui"`, the pack's own default — "the browser
// driver's daily floor", design §9) — never through `seedSuite`'s normal
// create-then-generate walk (see build-packs/_tiny.ts's own comment on
// `d-registration` for why: it has no admin-equivalent seed data, and
// `usecases/stages.ts:1141` refuses to /generate a stage with fewer than two
// real entrants, which this division's real entrant count never reaches
// until the funnel itself has run).
// ---------------------------------------------------------------------------

/** The pack's own declared registration-carrying divisions, in pack order —
 *  every `pack.divisions[]` entry that has a matching
 *  `pack.registration.byDivision[ref]` block. Exported so a test (and a
 *  future multi-suite caller) can reuse the same selector this file's own
 *  wiring uses, rather than re-deriving `Object.keys(pack.registration.
 *  byDivision)` a second way. */
export function registrationDivisionsOf(pack: Pack): readonly PackDivision[] {
  if (pack.registration === undefined) return [];
  const byDivision = pack.registration.byDivision;
  return pack.divisions.filter((d) => byDivision[d.ref] !== undefined);
}

/**
 * Reduces a pack's registration-carrying divisions down to `env.ts`'s
 * `SelectedDivisionExposure` shape, resolving each one's `--entry` mode
 * first — the exact reduction `lib/env.ts`'s own header comment describes
 * as "a concurrent agent... reduces its resolved run down to this shape
 * before calling `runPreflight`". `bench.ts`'s `main()` does not yet call
 * this (wiring `runPreflight`'s own `selectedDivisions` parameter is a
 * `bench.ts`-owned sequencing change outside this task's file set: pre-
 * flight runs BEFORE any pack is loaded there today) — this function is
 * what a future wiring pass calls, and what THIS task's own tests call
 * directly to prove the resolution/selection logic itself is correct
 * (`--entry admin` needs neither Stripe nor Chromium for `_tiny`).
 */
export function selectedDivisionExposures(
  pack: Pack,
  cliEntry: CliEntryFlag | undefined,
): SelectedDivisionExposure[] {
  return registrationDivisionsOf(pack).map((division) => {
    const block = pack.registration?.byDivision[division.ref];
    return {
      entry: resolveEntryMode(division.entry, pack.suite, cliEntry),
      pay: (block?.entries ?? []).some((e) => e.pay),
    };
  });
}

/** One real driver triple for a registration division, plus how to tear it
 *  down. `dispose` is always safe to call (a no-op for the http driver,
 *  which owns no browser resources). */
export interface RegistrationDriverSet {
  readonly organiser: Organiser;
  readonly makeCaptain: (entryExtKey: string) => Captain;
  readonly makePlayer: (personRef: string) => Player;
  readonly dispose: () => Promise<void>;
}

/** Everything a `RegistrationDriverSet` factory needs about ONE division's
 *  run, resolved by the caller. */
export interface RegistrationDriverContext {
  readonly base: string;
  readonly email: string;
  readonly orgSlug: string;
  readonly competitionSlug: string;
  /** Every entry extKey the block declares — the http driver needs one
   *  anonymous `Session` per entry; the browser driver needs one
   *  `BrowserContext`/`Page` per entry, and (design) both need to exist
   *  BEFORE `runRegistrationDivision` calls `makeCaptain`, which is
   *  synchronous (`DivisionRunnerInput.makeCaptain`, register.ts) — a
   *  playwright context cannot be minted lazily inside a sync call. */
  readonly entryExtKeys: readonly string[];
  /** Every joining person ref the block declares — same "must pre-exist"
   *  reasoning as `entryExtKeys`, for `makePlayer`. Empty for `_tiny`'s own
   *  division (it declares no `joins[]`). */
  readonly joinPersonRefs: readonly string[];
}

/**
 * The REAL default driver-set builder — httpOrganiser/httpCaptain/
 * httpPlayer for `"registration-api"`, the real playwright browser driver
 * for `"registration-ui"`. `PackSuiteInput.registrationDrivers` overrides
 * this ENTIRELY for a test (a fake Organiser/Captain/Player, or a fake
 * browser-shaped triple) — this function is never called from a test that
 * supplies that override, so no test here ever launches a real browser or
 * makes a real HTTP call, matching the DI-with-real-default convention
 * `transport`/`sql`/`probeTransport` already use in this file.
 */
async function buildRealRegistrationDrivers(
  resolvedEntry: "registration-api" | "registration-ui",
  ctx: RegistrationDriverContext,
): Promise<RegistrationDriverSet> {
  if (resolvedEntry === "registration-api") {
    const organiserSession = newSession();
    // The organiser's own actions (configure, approve/reject/promote/assign)
    // are authenticated admin routes — driven by an admin session signed in
    // via the SAME magic-link flow `runPackSuite`'s own `s` already used
    // (kept separate here rather than reusing `s` directly, so this driver
    // set owns its own session lifecycle independent of the caller's).
    await signIn(ctx.base, organiserSession, ctx.email);
    const captainByExtKey = new Map(
      ctx.entryExtKeys.map((extKey) => [
        extKey,
        httpCaptain(ctx.base, newSession()),
      ]),
    );
    const playerByRef = new Map(
      ctx.joinPersonRefs.map((ref) => [
        ref,
        httpPlayer(ctx.base, newSession()),
      ]),
    );
    return {
      organiser: httpOrganiser(ctx.base, organiserSession),
      makeCaptain: (extKey) => {
        const captain = captainByExtKey.get(extKey);
        if (captain === undefined)
          throw new Error(
            `buildRealRegistrationDrivers(): no http captain pre-built for entry "${extKey}"`,
          );
        return captain;
      },
      makePlayer: (ref) => {
        const player = playerByRef.get(ref);
        if (player === undefined)
          throw new Error(
            `buildRealRegistrationDrivers(): no http player pre-built for person "${ref}"`,
          );
        return player;
      },
      dispose: async () => {},
    };
  }

  // "registration-ui" — plain playwright, never @playwright/test (this
  // script runs under node --experimental-strip-types). One BrowserContext
  // per person (task brief), all pre-created here — NEVER a bare
  // `browser.newContext()` reused across people, which would silently carry
  // one person's auth cookies into another's session (repo trap:
  // reference_bare_newcontext_inherits_auth_state).
  const browser = await launchRegistrationBrowser();
  const organiserSession = await newOrganiserBrowserSession(
    browser,
    ctx.base,
    ctx.email,
  );
  const captainSessions = new Map<string, RegistrationBrowserSession>();
  for (const extKey of ctx.entryExtKeys)
    captainSessions.set(extKey, await newAnonymousBrowserSession(browser));
  const playerSessions = new Map<string, RegistrationBrowserSession>();
  for (const ref of ctx.joinPersonRefs)
    playerSessions.set(ref, await newAnonymousBrowserSession(browser));

  return {
    organiser: browserOrganiser(
      organiserSession,
      ctx.base,
      ctx.orgSlug,
      ctx.competitionSlug,
    ),
    makeCaptain: (extKey) => {
      const session = captainSessions.get(extKey);
      if (session === undefined)
        throw new Error(
          `buildRealRegistrationDrivers(): no browser session pre-built for entry "${extKey}"`,
        );
      return browserCaptain(
        session,
        ctx.base,
        ctx.orgSlug,
        ctx.competitionSlug,
      );
    },
    makePlayer: (ref) => {
      const session = playerSessions.get(ref);
      if (session === undefined)
        throw new Error(
          `buildRealRegistrationDrivers(): no browser session pre-built for person "${ref}"`,
        );
      return browserPlayer(session, ctx.base, ctx.orgSlug, ctx.competitionSlug);
    },
    dispose: async () => {
      await Promise.all([
        closeRegistrationBrowserSession(organiserSession),
        ...[...captainSessions.values()].map(closeRegistrationBrowserSession),
        ...[...playerSessions.values()].map(closeRegistrationBrowserSession),
      ]);
      await browser.close();
    },
  };
}

export interface PackSuiteInput {
  base: string;
  /** The CLI's `--engine` value. Recorded in the report as `requestedEngine`
   *  so a reader can see what was ASKED for — it is not, and cannot be,
   *  honoured (see the comment at the `schedule/auto` call below: the real
   *  API has no per-request engine field at all). */
  engine: "optimized" | "greedy" | "both";
  /**
   * T4: now ENFORCED, not merely recorded. `true` (the CLI's default —
   * `keep: !values.wipe`) makes this run sign in with a FIXED identity and,
   * before seeding anything, look for a prior `--keep` run's competition
   * whose branding carries the SAME pack hash — if found, seeding (and
   * scheduling) are skipped entirely and this run reports the reuse. `false`
   * (`--wipe`) never attempts that lookup: a fresh random identity, a fresh
   * seed, every time. See this file's header comment for the full mechanism
   * and its one disclosed limitation.
   */
  keep: boolean;
  log: pino.Logger;
  /** Overridable so a test can drive the pack stage against another file.
   *  Defaults to the committed micro-pack; a live run never passes it. */
  packPath?: string;
  /** Overridable so a test can drive this suite's ENTIRE HTTP surface
   *  (sign-in, the `--keep` lookup, venue/court, scheduling, and — forwarded
   *  — `seedSuite`'s own calls) through one fake, never `global.fetch`.
   *  Defaults to `seed.ts`'s own `defaultTransport`; a live run never passes
   *  it. */
  transport?: SeedTransport;
  /**
   * B03 T7: the plan/entitlement-provisioning SQL seam (`lib/plan.ts`).
   * **Optional, and the absence is deliberate**: every EXISTING caller of
   * `runPackSuite` (this file's own test suite included) that does not know
   * about plan provisioning gets today's behavior unchanged — no DLS-gate
   * probe, auto-assign stays off. `bench.ts` is the one caller that always
   * supplies the real thing (`lib/plan.ts#createRealPlanSql`), so a real
   * `_tiny` run always exercises the probe — see
   * `lib/__tests__/bench-cli.test.ts` for the test proving THAT wiring
   * specifically (removing it there reds a test at the bench.ts layer,
   * independent of this file's own coverage of what happens once `sql` is
   * supplied).
   *
   * When present, this run: (1) drives `runDlsGateProbe` — the cricket.dls
   * entitlement-gate 2x2-plus-clear proof (see dls-gate.ts's header comment)
   * — reporting every cell as an `oracle` and reddening the gate on any cell
   * that fails its own expectation, choosing a plan that grants EVERY
   * capability this run needs (`lib/plan.ts#chooseGrantingPlanForCapabilities`
   * — B03 review F1(a): the old choice optimised for `cricket.dls` alone and
   * hoped it also granted `officials.auto`, which on the live catalog it did
   * not); (2) derives `autoAssign` from whether that SAME provisioned plan
   * ALSO grants `officials.auto` (`probe.officialsAutoGranted` — "derived,
   * not assumed", never assumed true merely because SOME plan got
   * provisioned) and, once THIS suite's own scheduling walk below has
   * completed, drives `runOfficialsAutoAssign` for real (B03 review F1(b) —
   * calling it any earlier always proposes zero, since `officials/auto`
   * only considers already-scheduled fixtures).
   */
  sql?: PlanSql;
  /** Overridable so a test can drive the DLS-gate probe's OWN HTTP surface
   *  through a fake, never `global.fetch` — same DI shape as `transport`
   *  above. Defaults to `dls-gate.ts`'s own `defaultProbeTransport`; a live
   *  run never passes it. Meaningless (never read) when `sql` is omitted. */
  probeTransport?: ProbeTransport;
  /**
   * B05 T1 — overridable so a test can drive the division-A stream fold's
   * OWN HTTP surface through a fake, never `global.fetch`. `ProbeTransport`
   * (not a bespoke type) because it is exactly the shape `simulate.ts`'s own
   * `SimTransport` needs — `raw()`, to read back a refusal's real status and
   * body rather than have `request()` throw it away. Defaults to
   * `simulate.ts`'s own `defaultSimTransport`; a live run never passes it.
   * Meaningless (never read) when `sql` is omitted — same gating as
   * `probeTransport`, and for the same reason: every EXISTING caller that
   * does not know about this step gets today's behavior unchanged. A
   * SEPARATE field from `probeTransport` (never falls back to it) — the two
   * probes are independent, and a test wanting different fakes for each
   * must be able to say so.
   */
  simTransport?: ProbeTransport;
  /**
   * B05 T2 — overridable so a test can drive division B's batch-import
   * fold's OWN HTTP surface through a fake, never `global.fetch`.
   * `ProbeTransport` (not a bespoke type), same reasoning as `simTransport`
   * above — it is exactly the shape `import.ts`'s own `ImportTransport`
   * needs (`raw()`, to read back a refusal's real status and body). Defaults
   * to `import.ts`'s own `defaultImportTransport`; a live run never passes
   * it. Meaningless (never read) when `sql` is omitted — same gating as
   * `simTransport`. A SEPARATE field from `simTransport` (never falls back
   * to it): the two write paths are independent, and a test wanting
   * different fakes for each must be able to say so.
   */
  importTransport?: ProbeTransport;
  /**
   * B05 T2.5 (D9) — overridable so a test can drive the division-start
   * step's OWN HTTP surface through a fake, never `global.fetch`.
   * `DivisionStartTransport` (`schedule.ts`'s own type — structurally the
   * same `signIn`/`request`/`raw` shape as `ProbeTransport`, so a fake typed
   * either way satisfies both). Defaults to `schedule.ts`'s own
   * `defaultDivisionStartTransport`; a live run never passes it. Meaningless
   * (never read) when `sql` is omitted — same gating as `simTransport`/
   * `importTransport`. A SEPARATE field from both (never falls back to
   * either): starting is neither fold, and runs before both of them.
   */
  startTransport?: DivisionStartTransport;
  /**
   * B05 T3 — overridable so a test can drive the stage-advancement step's
   * (`advance.ts`) OWN HTTP surface through a fake, never `global.fetch`.
   * `ProbeTransport`, same reasoning as `simTransport`/`importTransport`
   * above — it is exactly the shape `advance.ts`'s own `AdvanceTransport`
   * needs (`raw()`). Defaults to `advance.ts`'s own `defaultAdvanceTransport`;
   * a live run never passes it. Meaningless (never read) when `sql` is
   * omitted, or when `division0`'s second stage declares no `progression` —
   * same gating discipline as every other B05 transport field. A SEPARATE
   * field from every other one above: advancement is neither fold nor the
   * start step, and runs after both folds and the player-stats baseline.
   */
  advanceTransport?: ProbeTransport;
  /**
   * B05 T4 — overridable so a test can drive the runtime-oracle step's OWN
   * HTTP surface through a fake, never `global.fetch`. `ProbeTransport`,
   * same reasoning as `advanceTransport` above — it is exactly the shape
   * `oracle.ts`'s own `OracleTransport` needs (`raw()`). Defaults to
   * `oracle.ts`'s own `defaultOracleTransport`; a live run never passes it.
   * Meaningless (never read) when `sql` is omitted, or when `division0`'s
   * second stage declares no `progression` — same gating discipline as
   * `advanceTransport`. A SEPARATE field: the oracle step reads standings
   * AFTER the advance step writes, and a test wanting different fakes for
   * each must be able to say so.
   */
  oracleTransport?: ProbeTransport;
  /** B06a task 3 — the per-match oracle's board, injectable for the same
   *  reason `oracleTransport` is: a suite-level test that fakes the whole
   *  world would otherwise have to model two more routes
   *  (`GET /divisions/{id}/fixtures` and `GET /fixtures/{id}/state`) AND the
   *  identity mapping between pack refs and the ids its own fake minted, just
   *  to keep a green run green while testing something else entirely.
   *
   *  Unset in production: the run fetches the real board. A test that injects
   *  `echoExpectedBoard` makes the per-match oracle VACUOUS on purpose — the
   *  oracle's real coverage is `oracle-matches.test.ts` plus the wiring test
   *  that injects a WRONG board and asserts the run reds. */
  matchBoard?: (args: {
    readonly divisionRef: string;
    readonly expected: readonly ExpectedMatchRow[];
  }) => readonly ActualMatchRow[] | Promise<readonly ActualMatchRow[]>;
  /** B06a task 4 — the specials oracle's subjects, injectable for the same
   *  reason `matchBoard` is, and for one more: a standings claim's subject is
   *  the fixture's own `StandingsDelta`, which the ENGINE derives from the
   *  product's folded state. A fake world would therefore have to produce a
   *  state its sport module accepts, which is a far larger fiction than the
   *  test needs. Unset in production. */
  specialSubjects?: (args: {
    readonly specials: readonly ResolvedSpecial[];
  }) => ReadonlyMap<string, SpecialSubject> | Promise<ReadonlyMap<string, SpecialSubject>>;
  /** B03r tasks 9+10: `bench.ts`'s `--entry admin|registration` flag,
   *  forwarded through `BenchConfig.entry`/`runSuite`. `undefined` (no flag)
   *  leaves every registration-carrying division on its own pack-declared
   *  entry mode — `_tiny`'s own `d-registration` defaults to
   *  `"registration-ui"`, design §9's "browser driver's daily floor". */
  cliEntry?: CliEntryFlag;
  /** Overrides `buildRealRegistrationDrivers` entirely for a registration
   *  division whose resolved entry is NOT `"admin"` — a test's fake
   *  Organiser/Captain/Player, conforming to `drivers/types.ts` exactly like
   *  a real driver would. Defaults to the REAL http/browser driver
   *  construction (same "optional, defaults to the real thing" convention as
   *  `transport`/`sql`/`probeTransport` above) — a live run never passes it,
   *  and no test that DOES pass it ever reaches real network or browser
   *  code. */
  registrationDrivers?: (
    resolvedEntry: "registration-api" | "registration-ui",
    ctx: RegistrationDriverContext,
  ) => Promise<RegistrationDriverSet>;
  /** B07a T10 (R45) — builds the player every `tap` division is played by.
   *  Defaults to `browserTapPlayer` (a real Chromium signed in as the run's
   *  organiser) — same "optional, defaults to the real thing" convention as
   *  `registrationDrivers` above. A live run never passes it; a test that
   *  does never reaches a real browser. */
  tapPlayer?: TapPlayerFactory;
  /** Resolves the SERVER-ASSIGNED org slug that every public URL is addressed
   *  by. Defaults to `sql.getOrgSlug` — same "optional, defaults to the real
   *  thing" convention as `transport`/`sql` above.
   *
   *  A seam rather than a plain `plan.org.slug` read because those are two
   *  DIFFERENT slugs and only one of them exists on the server. The pack
   *  declares `bench-tiny-club`; the backend auto-provisions the org and mints
   *  `my-organization-N`. The pack's value 404s, and a 404 here still returns
   *  HTTP 200 chrome with no wizard in it — so the first live run failed 30s
   *  later as `locator.fill: Timeout waiting for '#reg-who-name'`, blaming a
   *  selector that was entirely correct. There is no default that reads the
   *  pack: falling back to it would restore the defect silently. */
  resolveOrgSlug?: (orgId: string) => Promise<string>;
  /** Overridable so the unit suite can drive the Connect claim without a live
   *  Postgres or a real Stripe account — same DI shape as `resolveOrgSlug`
   *  above. A live run passes neither and gets the `PlanSql` implementation. */
  connectAccount?: {
    claim: (orgId: string, accountId: string) => Promise<string | null>;
    release: (
      orgId: string,
      previousHolderId: string | null,
      accountId: string,
    ) => Promise<void>;
  };
  /** Overridable for the same reason `connectAccount` is — the unit suite has
   *  no live Postgres. A live run passes neither and gets `PlanSql`. */
  setOrgCurrency?: (orgId: string, currency: string) => Promise<void>;
  /**
   * B04 — where `engine-<engine>.json` is written and read back
   * (`schedule.ts`'s `writeEngineArtifact`/`readEngineArtifacts`, ruling R3).
   *
   * BOTH of these or neither: without a run id there is no directory to write
   * into, and without a directory there is nowhere to put it. `bench.ts`
   * always supplies both — `reportDir` off `--report-dir` and `runId` off
   * `resolveRunId(--run-id, gitSha)`, i.e. the SAME identity `writeReport`
   * uses, resolved ONCE by that caller. Two resolution points for one identity
   * is how a leg lands in a directory its sibling never looks in.
   *
   * Absent (every unit test, which has no business writing to disk) means no
   * artifact is written and `assessEngineDelta` is called with `undefined`,
   * which reports "nothing to compare" rather than an engine tie.
   */
  reportDir?: string;
  /** See `reportDir`. Already RESOLVED — never a raw `--run-id` that may be
   *  undefined. */
  runId?: string;
}

// ---------------------------------------------------------------------------
// The pack stage — everything this suite decides before it touches the network
// ---------------------------------------------------------------------------

export type TinyPackStage =
  | {
      readonly ok: true;
      readonly pack: Pack;
      readonly plan: SeedPlan;
      /** `hashPack(pack)` — computed here (still offline, still pure) so
       *  every caller of `tinyPackStage` gets ONE value to compare, rather
       *  than each recomputing it and risking a drift between what was
       *  staged and what gets stamped/looked-up. */
      readonly packHash: string;
      readonly warnings: readonly string[];
    }
  | {
      readonly ok: false;
      readonly errors: readonly string[];
      readonly warnings: readonly string[];
    };

/**
 * Load and gate the pack, BEFORE anything is created over HTTP.
 *
 * The severity split is structural, not a convention: `loadPackFile` hands back
 * a union whose `ok: false` branch carries `errors` and whose `ok: true` branch
 * carries no error field at all, so a warning cannot reach the gate by
 * accident. `_tiny` carries two permanent `*.not_derived` warnings — stage 0
 * SAYS what it does not derive offline rather than staying silent — and those
 * belong in the report, not in the gate. A stage that failed on "any finding"
 * would red `_tiny` forever, and the obvious repair would be to delete the
 * honest warning.
 */
export async function tinyPackStage(packPath: string): Promise<TinyPackStage> {
  const load = await loadPackFile(packPath);
  const warnings = load.warnings.map(formatFinding);
  if (!load.ok)
    return { ok: false, errors: load.errors.map(formatFinding), warnings };
  try {
    const plan = buildSeedPlan(load.pack);
    const packHash = hashPack(load.pack);
    return { ok: true, pack: load.pack, plan, packHash, warnings };
  } catch (err) {
    return {
      ok: false,
      errors: [err instanceof Error ? err.message : String(err)],
      warnings,
    };
  }
}

/** One `expectedFixtureCounts` entry, rendered the way a reader can trace it
 *  back to the pack: the count, the division's own entrant arithmetic, and
 *  the legs that produced it — never a bare number. */
function describeExpectedCount(
  entry: SeedPlanExpectedFixtureCount,
  plan: SeedPlan,
): string {
  const division = plan.divisions.find((d) => d.ref === entry.divisionRef);
  const stage = division?.stages.find((s) => s.ref === entry.stageRef);
  const entrantCount = plan.entrants.filter(
    (e) => e.divisionRef === entry.divisionRef,
  ).length;
  // `config` is `PackJsonValue`, so `legs` can be an object or an array as far
  // as the type is concerned, and interpolating one renders "[object Object]"
  // into a message whose whole job is to let a reader trace the count back to
  // the pack. Narrowed rather than asserted: a non-numeric `legs` falls back to
  // the same 1 the arithmetic uses.
  const declaredLegs = stage?.config["legs"];
  const legs = typeof declaredLegs === "number" ? declaredLegs : 1;
  return `${entry.count} fixture(s) from the pack's ${entrantCount}-entrant league over ${legs} leg(s)`;
}

/**
 * ADDENDUM 1's comparison, as a pure function.
 *
 * `null` = the generator minted what the pack implies. A message = what
 * diverged, naming BOTH numbers and the legs that produced the expectation.
 *
 * Adapted for T4 to `SeedPlan`'s N-division/N-stage shape: `plan` now carries
 * one `expectedFixtureCounts` entry PER LEAGUE STAGE (seed-plan.ts:235-239).
 *
 * B03 T5 (`_tiny.json` grows a second division, `d-badminton`) is what makes
 * this SUM rather than "read the first entry": `actual` is always
 * `seeded.fixtureIdByKey.size` at the one call site (`runPackSuite` below) —
 * a POOL-wide count spanning every division `seedSuite` bound fixtures for,
 * never scoped to one division — so comparing it against a single division's
 * own expectation was already the wrong shape once a second league stage
 * existed; it happened to read correct only because `_tiny.json` had
 * exactly one. T4's own doc comment here recorded that as the reason it was
 * safe to take `[0]` alone: "This suite still only ever drives `_tiny.json`,
 * which declares exactly one league stage" — a premise this task's own pack
 * change falsifies, so the comparison follows the pack rather than stay
 * pinned to a division count `_tiny.json` no longer has.
 *
 * A single-league-stage pack (every pack before T5) gets the IDENTICAL
 * message it always did — `plan.expectedFixtureCounts.length === 1` degrades
 * to the old one-entry sentence exactly, so no existing single-division
 * caller sees a shape change. An ABSENT expectation entirely (a pack that
 * declares no league stage at all) is itself surfaced rather than silently
 * skipped, as before.
 *
 * Extracted from the HTTP path because that is where it was unreachable: the
 * review inverted the operator in situ and the whole suite stayed green. The
 * DERIVATION (`expectedFixtureCount`) was well covered; the line that CONSUMES
 * it was not — and consuming it wrongly is exactly what shipped before, as
 * `!== 1` against a pack declaring three. A silent inversion here reports a
 * GREEN `_tiny` while the product mints the wrong number of fixtures, which is
 * the one failure the addendum exists to prevent.
 */
/**
 * B05 T3 — how many of `seeded.fixtureIdByKey`'s bound fixtures belong to a
 * LEAGUE-kind stage, the only kind `expectedFixtureCounts` can derive a
 * number for (`SeedPlan.expectedFixtureCounts`'s own doc comment: "a
 * bracket/group/swiss/etc. stage simply has no entry here, not a wrong
 * one"). `d-tiny` gained a second stage this task (`s-playoff`, a knockout)
 * whose own TBD placeholder fixture is generated and bound exactly like
 * every other one — `seedSuite`'s per-stage `/generate` loop does not
 * discriminate by kind — so `seeded.fixtureIdByKey.size` now counts a
 * fixture `expectedFixtureCounts` was never asked about. Comparing the two
 * totals wholesale would red every division that ever grows a non-league
 * stage, forever, regardless of whether the league stage itself seeded
 * correctly — exactly the false attribution `fixtureCountIssue`'s own doc
 * comment warns a silent shape change produces.
 *
 * Scoped by STREAM rather than by re-deriving a per-stage generated count:
 * `bindStreamFixtures` already proved (its own two anti-vacuity checks) that
 * every pack stream matches exactly one generated, bound fixture and vice
 * versa, so "how many streams resolve to a league-kind stage" and "how many
 * bound fixtures belong to a league-kind stage" are the same number. A
 * stream's stage is resolved the same way `validate-pack.ts`'s `resolveStage`
 * does — declared `stageRef` wins, absent means "the division's only stage"
 * — reimplemented here rather than imported because that resolver is a
 * validate-pack.ts private helper, not an exported one.
 */
function leagueBoundStreamCount(pack: Pack, plan: SeedPlan): number {
  let count = 0;
  for (const stream of pack.streams) {
    const division = plan.divisions.find((d) => d.ref === stream.divisionRef);
    if (division === undefined) continue;
    const stage =
      stream.stageRef !== undefined
        ? division.stages.find((s) => s.ref === stream.stageRef)
        : division.stages.length === 1
          ? division.stages[0]
          : undefined;
    if (stage?.kind === "league") count += 1;
  }
  return count;
}

/**
 * B06b — does this pack have a league stage at all?
 *
 * `fixtureCountIssue` deliberately NAMES a missing league expectation rather
 * than no-op'ing silently, and its own test pins that. But suite 11 is
 * knockout-only in both divisions, so there is no league count to check and
 * that note reddened the whole run. Both intents hold once severity is the
 * caller's decision: the absence is still REPORTED, just not gated.
 */
export function packDeclaresLeagueStage(plan: SeedPlan): boolean {
  return plan.divisions.some((d) => d.stages.some((s) => s.kind === "league"));
}

export function fixtureCountIssue(
  actual: number,
  plan: SeedPlan,
): string | null {
  if (plan.expectedFixtureCounts.length === 0) {
    return `pack declares no league-stage fixture-count expectation to check the ${actual} generated fixture(s) against`;
  }
  const expectedTotal = plan.expectedFixtureCounts.reduce(
    (sum, entry) => sum + entry.count,
    0,
  );
  if (actual === expectedTotal) return null;
  if (plan.expectedFixtureCounts.length === 1) {
    return `expected ${describeExpectedCount(plan.expectedFixtureCounts[0], plan)}, got ${actual}`;
  }
  const perDivision = plan.expectedFixtureCounts
    .map(
      (entry) =>
        `"${entry.divisionRef}": ${describeExpectedCount(entry, plan)}`,
    )
    .join("; ");
  return `expected ${expectedTotal} fixture(s) total across ${plan.expectedFixtureCounts.length} league stage(s) (${perDivision}), got ${actual}`;
}

// ---------------------------------------------------------------------------
// `--keep` idempotence — the lookup
// ---------------------------------------------------------------------------

interface CompetitionListItem {
  readonly id: string;
  readonly org_id: string;
  readonly slug: string;
  readonly branding: Record<string, unknown>;
}

interface CompetitionListPage {
  readonly items: readonly CompetitionListItem[];
  readonly nextCursor: string | null;
}


// ---------------------------------------------------------------------------
// B04 — the small pack-derived facts the scheduling layer needs
//
// Exported so a unit test drives each one directly rather than only through a
// whole fake-server run: every one of them decides something a live run cannot
// be asked about twice.
// ---------------------------------------------------------------------------

/**
 * Is this stage kind generated as a round robin?
 *
 * `league` and `group` are the two, and they are read off the product's own
 * generator switch (`apps/web/src/server/usecases/stages.ts:752-753` — both
 * cases fall into `roundRobinGen`; `group` differs only by splitting into
 * pools that each play their own). Every other kind is a bracket or a ladder.
 *
 * Load-bearing because `EncodedConstraints.isRoundRobin` gates design §3.3's
 * round-order rule, and that rule compares round numbers by day and by start.
 * Answering `true` for a knockout would red a bracket for playing its rounds
 * in bracket order, which is the only order it can play them in; answering
 * `false` for a league silently deletes the rule. Nothing on a `Board` can
 * tell the two apart, which is why the pack's own declaration is forwarded
 * rather than derived downstream.
 */
export function isRoundRobinStage(stageKind: string): boolean {
  return stageKind === "league" || stageKind === "group";
}

/**
 * Did the PACK declare an official FOR THIS DIVISION?
 *
 * `EncodedConstraints.declaresOfficials` is the ONLY thing that can tell "this
 * division has no officials" from "this division's officials did not come
 * back" — `Fixture.officials` is `z.array(z.unknown())` on the wire, so a
 * division that fetched none arrives as an empty array and every "no official
 * is double-booked" check passes forever (design §4.3). The checker reds on
 * the mismatch; this function is where the fact comes from.
 *
 * A NAMED ASSIGNMENT is the test, not "the pack declares any official at all".
 * `_tiny` declares two: `off-dee` with an assignment onto d-tiny's rr-r1-c1
 * (seeded by `seedOfficialsAndClaims`, i.e. on the board before scheduling
 * ever runs) and `off-eli` with none at all, which is the pack's way of saying
 * "leave this one to auto-assign". Counting `off-eli` toward d-tiny would make
 * the rule red whenever `/officials/auto` proposed nothing — a claim about an
 * entitlement, not about the board — and would make it red for d-badminton,
 * which the pack never mentions officials for.
 */
export function divisionDeclaresOfficials(pack: Pack, divisionRef: string): boolean {
  return (pack.officials ?? []).some((official) =>
    official.assignments.some((a) => a.divisionRef === divisionRef),
  );
}

/** B05 T2.5 (D9) — `schedule.ts`'s own `WireConflict` shape
 *  (`fixture_id?`/`blocking?`/`details.kind?`, read through `details.kind`
 *  ONLY, never `code`) renamed onto `report.ts`'s `DivisionStartConflictReport`
 *  — one rename site, matching every other wire-to-report mapper in this
 *  file. Typed structurally rather than importing `WireConflict` by name:
 *  that type is not exported from `schedule.ts` (it is this module's own
 *  private wire shape), and this function needs nothing beyond its shape. */
function toDivisionStartConflictReport(c: {
  fixture_id?: string;
  blocking?: boolean;
  details?: { kind?: string };
}): DivisionStartConflictReport {
  return {
    ...(c.fixture_id === undefined ? {} : { fixtureId: c.fixture_id }),
    ...(c.blocking === undefined ? {} : { blocking: c.blocking }),
    ...(typeof c.details?.kind === "string" ? { kind: c.details.kind } : {}),
  };
}

/** B05 T2 — flattens `import.ts`'s discriminated `ImportFinding` union into
 *  `report.ts`'s single reportable row shape (`ImportFindingReport`). A
 *  `switch` over `kind` rather than a spread, so a FOURTH finding kind added
 *  to the union later is a `tsc` error here (`never` narrows to nothing)
 *  instead of silently reporting an empty row. */
function toImportFindingReport(finding: ImportFinding): ImportFindingReport {
  switch (finding.kind) {
    case "stream_oversize":
      return {
        kind: finding.kind,
        streamKey: finding.streamKey,
        eventCount: finding.eventCount,
        cap: finding.cap,
        code: "import.stream_exceeds_cap",
      };
    case "call_refused":
      return {
        kind: finding.kind,
        chunkIndex: finding.chunkIndex,
        streamKeys: [...finding.streamKeys],
        status: finding.status,
        code: finding.code,
        message: finding.message,
      };
    case "stream_not_imported":
      return {
        kind: finding.kind,
        streamKey: finding.streamKey,
        fixture: finding.fixture,
        status: finding.status,
        ...(finding.code === undefined ? {} : { code: finding.code }),
        ...(finding.eventIndex === undefined ? {} : { eventIndex: finding.eventIndex }),
      };
  }
}

/** Human-readable form of the same finding, for `errors.push(...)` — same
 *  "a refusal is a FINDING, reported and never silently retried" convention
 *  division A's block already uses. */
function describeImportFinding(finding: ImportFinding): string {
  switch (finding.kind) {
    case "stream_oversize":
      return (
        `stream ${finding.streamKey} carries ${finding.eventCount} events, over the ` +
        `${finding.cap} eventsPerFixture cap — excluded from every call`
      );
    case "call_refused":
      return (
        `chunk #${finding.chunkIndex} (streams ${finding.streamKeys.join(", ")}) refused: ` +
        `${finding.code} (HTTP ${finding.status}) — ${finding.message}`
      );
    case "stream_not_imported":
      return (
        `stream ${finding.streamKey} (fixture ${finding.fixture}) ${finding.status}` +
        (finding.code === undefined ? "" : ` — ${finding.code}`)
      );
  }
}

/** The one distinct defined value in a list, or `undefined` when the list has
 *  none — or more than one. Used where a run-level field has to answer for N
 *  divisions: "they all said greedy" is a fact, "the first one said greedy" is
 *  a coin toss recorded as one. */
function soleValue<T>(values: readonly (T | undefined)[]): T | undefined {
  const distinct = [...new Set(values.filter((v): v is T => v !== undefined))];
  return distinct.length === 1 ? distinct[0] : undefined;
}

/**
 * The verdict for a division whose three layers could not all run.
 *
 * Deliberately NOT `judgeDivision` with a stand-in checker: `checkBoard` on an
 * absent (or empty) board returns `clean: true` having measured nothing, and
 * recording that as a clean checker is design §1.4's false clean with a type
 * annotation on it. `runScheduleLayer` only omits a board/encoding after a
 * throw it has already recorded, so the errors below are the real verdict —
 * and if they are somehow empty, that emptiness is itself reported rather than
 * allowed to render as a division with nothing wrong.
 *
 * The `<ref>: ` prefix matches `judgeDivision`'s own, so a multi-division
 * report still reads flat.
 */
function degradedVerdict(
  divisionRef: string,
  scheduleErrors: readonly string[],
  board: Board | undefined,
  constraints: EncodedConstraints | undefined,
): { red: boolean; reasons: readonly string[] } {
  const missing = [
    board === undefined ? "no board was fetched" : undefined,
    constraints === undefined ? "the scheduleConfig never encoded" : undefined,
  ].filter((part): part is string => part !== undefined);
  const cause =
    scheduleErrors.length > 0
      ? scheduleErrors.join("; ")
      : "and the driver recorded no error for it, which is itself a bench wiring fault";
  return {
    red: true,
    reasons: [
      `${divisionRef}: the verification layers did not run (${missing.join(", ")}) — ${cause}`,
    ],
  };
}


// ---------------------------------------------------------------------------
// F-T6-3 — the RUN-LEVEL cross-division court check
//
// Every layer above this one is DIVISION-scoped, and that is structural rather
// than an oversight: `checkBoard` is handed one division's `Board`, `certify`
// is handed one division's encoding, and `POST /divisions/{id}/schedule/validate`
// is addressed by a division id. So two divisions sharing a venue can put two
// fixtures on ONE court at ONE instant and every per-division verdict is clean.
//
// A court holding two overlapping fixtures is a physical impossibility no
// matter which division each belongs to, so this GATES.
//
// SCOPED TO DIFFERENT DIVISIONS ON PURPOSE. A same-division overlap is
// `checkBoard`'s `court_double_booking`, and reporting it here as well would be
// two authorities on one fact — the pair would red twice, with two different
// wordings, and a reader could not tell whether that was one clash or two.
// ---------------------------------------------------------------------------

/** One court held by two fixtures from DIFFERENT divisions at overlapping
 *  times. Both sides are always named: a clash naming one fixture cannot be
 *  acted on, which is the same rule `CheckerFinding.fixtureIds` follows. */
export interface CrossDivisionCourtClash {
  courtId: string;
  a: { divisionRef: string; fixtureId: string; start: number; end: number };
  b: { divisionRef: string; fixtureId: string; start: number; end: number };
}

/** `checker.ts`'s own placed predicate, restated rather than approximated.
 *
 *  The `Number.isFinite` half is NOT redundant with the `typeof`: a NaN start
 *  compares false against every bound, so a fixture carrying one would be
 *  silently exempt from every overlap test here exactly as it is there. A
 *  fixture with no court occupies no court and cannot clash on one. */
function placedOnCourt(
  fixture: BoardFixture,
): { fixtureId: string; courtId: string; start: number; end: number } | undefined {
  const { start, end, courtId } = fixture;
  if (typeof start !== "number" || !Number.isFinite(start)) return undefined;
  if (typeof end !== "number" || !Number.isFinite(end)) return undefined;
  if (typeof courtId !== "string" || courtId.length === 0) return undefined;
  return { fixtureId: fixture.fixtureId, courtId, start, end };
}

/**
 * Every court held by two overlapping fixtures from two DIFFERENT divisions,
 * across the whole run.
 *
 * Pure, and exported so a test drives it on a hand-built pair rather than only
 * through a whole fake-server run.
 *
 * `[start, end)` — the same half-open interval every occupancy rule in this
 * bench measures on, so two fixtures that merely touch (one ends exactly as
 * the next begins) do NOT clash. A closed interval here would red every
 * back-to-back pair the product legitimately produces.
 */
export function crossDivisionCourtClashes(
  boards: readonly Board[],
): readonly CrossDivisionCourtClash[] {
  const placed = boards.flatMap((board) =>
    board.fixtures.flatMap((fixture) => {
      const slot = placedOnCourt(fixture);
      return slot === undefined ? [] : [{ divisionRef: board.divisionRef, ...slot }];
    }),
  );
  const out: CrossDivisionCourtClash[] = [];
  for (let i = 0; i < placed.length; i += 1) {
    for (let j = i + 1; j < placed.length; j += 1) {
      const a = placed[i];
      const b = placed[j];
      // SAME DIVISION IS NOT THIS RULE'S BUSINESS — see the block comment.
      if (a.divisionRef === b.divisionRef) continue;
      if (a.courtId !== b.courtId) continue;
      if (!(a.start < b.end && b.start < a.end)) continue;
      out.push({
        courtId: a.courtId,
        a: { divisionRef: a.divisionRef, fixtureId: a.fixtureId, start: a.start, end: a.end },
        b: { divisionRef: b.divisionRef, fixtureId: b.fixtureId, start: b.start, end: b.end },
      });
    }
  }
  return out;
}

/** The BOARD as it stands after officials auto-assign, built from the
 *  product's own post-apply READ.
 *
 *  F-T6-2: `/officials/auto` only considers fixtures whose `scheduled_at` is
 *  set, so it must follow apply — which means the board `runScheduleLayer`
 *  fetched, and every verdict taken on it, predates whatever it assigns.
 *  Re-running `checkBoard` needs a board that includes those assignments.
 *
 *  DEVIATION, stated rather than hidden: this is not a second full fetch.
 *  `schedule.ts` owns the wire->`Board` builder and is a closed module, so a
 *  second one here would be two readers of one wire shape — the drift class
 *  this wave has already paid for twice. Every field still comes from a
 *  product read: the slots are the FETCHED board's, and the officials are
 *  `runOfficialsAutoAssign`'s own `GET /api/v1/fixtures/{id}` AFTER the apply
 *  (`seed.ts:1092-1098` — a distinct GET, never the apply's echoed body). No
 *  field on this board comes from a request this bench sent. */
function boardWithOfficials(
  board: Board,
  officialsByFixtureId: ReadonlyMap<string, readonly FixtureOfficialRow[]>,
): Board {
  if (officialsByFixtureId.size === 0) return board;
  return {
    ...board,
    fixtures: board.fixtures.map((fixture) => {
      const rows = officialsByFixtureId.get(fixture.fixtureId);
      if (rows === undefined) return fixture;
      return {
        ...fixture,
        officialIds: rows
          .map((row) => row.official_id)
          .filter((id) => typeof id === "string" && id.length > 0),
      };
    }),
  };
}

/** One `@`-sigilled or bare court reference from a pack's `scheduleConfig`,
 *  resolved against the ids `seedSuite` actually created.
 *
 *  The SAME convention `board.ts`'s own `resolveCourt` implements, and the
 *  same map — so the two cannot name different courts. It is a second READER
 *  rather than a second authority, and the distinction matters: the value here
 *  only ever goes into a `PATCH /fixtures/{id}` body, and the pin the checker
 *  later judges is snapshotted back from the PRODUCT's own state at design
 *  §3.2 step 3, never from what this asked for. */
function resolveCourtRef(raw: unknown, courtIdByRef: ReadonlyMap<string, string>): string | undefined {
  if (typeof raw !== "string" || raw.length === 0) return undefined;
  if (!raw.startsWith("@")) return raw;
  return courtIdByRef.get(raw.slice(1));
}

/** What `resolveScheduleLocks` decided, and why, when it decided nothing. */
export interface ScheduleLockResolution {
  /** Keyed by `divisionRef`. At most ONE entry — design §4.4 locks one
   *  fixture, and locking every division's only fixture would leave `auto`
   *  with nothing to propose. */
  readonly locks: ReadonlyMap<string, ScheduleLock>;
  /** Why no lock was declared, when none was. Reported as a warning, never
   *  dropped: design §4.4 is explicit that an unreachable lock route is a
   *  named deferral and not a rule left passing because it never ran. */
  readonly notes: readonly string[];
}

/**
 * The one pin design §4.4 asks for, resolved from the pack.
 *
 * RULING R22, and it is the whole reason this returns a SLOT and not just an
 * id: a bare-id lock issued before `auto` leaves the fixture `schedule_locked`
 * with no `scheduled_at` and no `court_id`, because nothing is placed yet — so
 * `snapshotPins` carries no pin, design §3.3's pin-integrity rule has nothing
 * to check, and it reports clean forever. `PatchFixture` takes `scheduled_at`,
 * `court_id` and `schedule_locked` in one body (`schemas.ts:964-979`), so the
 * slot and the lock are one call. `expected_seq` is never sent: the schema is
 * `.partial()` so omitting it is legal, and a stale value 409s SEQ_CONFLICT.
 *
 * The FIRST scheduled division's FIRST declared stream, at the division's own
 * declared `startAt` on its first declared court. Three deliberate choices:
 *
 *  * The first division, not every one. `_tiny`'s second division has exactly
 *    one fixture, and locking a stage's only fixture leaves `auto` nothing to
 *    propose — which the driver correctly reports as a refusal.
 *  * The first stream, because `_tiny` declares d-tiny's in round order
 *    (rr-r1-c1, rr-r2-c1, rr-r3-c1) and this pins round 1. Pinning a LATER
 *    round at the earliest slot would force the round-order rule to fire on a
 *    board the solver had no way to lay out legally — a bench-authored red.
 *    The test beside this pins the chosen fixture and slot, so a reordering of
 *    the pack's streams reds there rather than surfacing as a mystery
 *    round-order finding on a live run.
 *  * `startAt` and `courts[0]` from the division's OWN config, so the pin sits
 *    inside the window the settings PUT declares rather than at an instant the
 *    product would refuse.
 */
export function resolveScheduleLocks(
  pack: Pack,
  seedPlan: SeedPlan,
  seeded: Pick<SeededSuite, "fixtureIdByKey" | "courtIdByRef">,
): ScheduleLockResolution {
  const locks = new Map<string, ScheduleLock>();
  const notes: string[] = [];
  const first = seedPlan.divisions[0];
  if (first === undefined) {
    notes.push("no division was seeded, so no fixture could be pinned and pin integrity is unchecked");
    return { locks, notes };
  }
  const ref = first.ref;
  const cfg = pack.divisions.find((d) => d.ref === ref)?.scheduleConfig;
  const stream = pack.streams.find((s) => s.divisionRef === ref);
  const startAt = cfg?.startAt;
  const courtId = resolveCourtRef(
    Array.isArray(cfg?.courts) ? cfg.courts[0] : undefined,
    seeded.courtIdByRef,
  );
  const fixtureId =
    stream === undefined
      ? undefined
      : seeded.fixtureIdByKey.get(fixtureKey(ref, stream.fixtureExtKey));

  // B06b — PIN AT THE FIXTURE'S OWN HISTORICAL START when the pack declares
  // one. Pinning the first stream's fixture at the DIVISION's `startAt` is
  // only coherent when the pack's first stream is also its first match, which
  // is true of `_tiny` by construction and false of any real tournament:
  // suite 11 pinned a first-round match at 12:30 on a day the tournament
  // played an evening session only, and the certificate correctly reported
  // `pin_moved`. A pin that contradicts history tests nothing about pin
  // integrity — it only re-reports the disagreement it created.
  const historyRow =
    stream === undefined
      ? undefined
      : (pack.historicalAssignment ?? []).find(
          (h) => h.divisionRef === ref && h.fixtureExtKey === stream.fixtureExtKey,
        );
  const historicalCourtId =
    historyRow?.court === undefined
      ? undefined
      : seeded.courtIdByRef.get(
          pack.venues?.flatMap((v) => v.courts).find((c) => c.name === historyRow.court)?.ref ?? "",
        );
  const pinnedAt = historyRow?.startsAt ?? startAt;
  const pinnedCourtId = historicalCourtId ?? courtId;

  if (fixtureId === undefined || typeof pinnedAt !== "string" || pinnedCourtId === undefined) {
    notes.push(
      `no fixture was pinned in "${ref}" — ` +
        `fixture=${fixtureId ?? `unresolved (stream ${stream?.fixtureExtKey ?? "none declared"})`}, ` +
        `startAt=${typeof startAt === "string" ? startAt : "not declared"}, ` +
        `court=${courtId ?? "unresolved"}. Design §3.3's pin-integrity rule has nothing to check this run, ` +
        "which is a named deferral rather than a rule that passed.",
    );
    return { locks, notes };
  }
  locks.set(ref, { fixtureId, scheduledAt: pinnedAt, courtId: pinnedCourtId });
  if (historyRow !== undefined) {
    notes.push(
      `pinned "${stream?.fixtureExtKey ?? "?"}" at its OWN historical start ${pinnedAt} ` +
        `rather than the division's startAt — a pin that contradicts history checks nothing`,
    );
  }
  return { locks, notes };
}

export interface ExistingSeed {
  readonly orgId: string;
  readonly competitionId: string;
}

/**
 * The three answers the `--keep` lookup can give. `stale` is the one that
 * matters and the one an earlier cut of this file did not express: it returned
 * `null` for "no such competition" AND for "the competition is there but the
 * pack has changed under it", which are opposite situations.
 *
 * `competitions_org_id_slug_key` is UNIQUE `(org_id, slug)`, and a `--keep`
 * run signs in with a deterministic email so it lands in the SAME org every
 * time. So a stale row cannot be seeded past: the create would collide on that
 * index and `createCompetition` turns an explicit-slug collision into a 409
 * (`usecases/competitions.ts` — "Explicit slugs are the caller's choice —
 * collisions 409"). Reporting `absent` there bought a 409 several HTTP calls
 * later, with nothing in the message about the real cause. The suite now
 * refuses up front and says what to do.
 *
 * That same uniqueness is why `stale` can be returned the moment the slug
 * matches without reading further pages — at most one row in this org can hold
 * the slug, so there is no later page that could still hold a hash match.
 */
export type SeedLookup =
  | {
      readonly kind: "reuse";
      readonly orgId: string;
      readonly competitionId: string;
    }
  | {
      readonly kind: "stale";
      readonly competitionId: string;
      readonly heldHash: unknown;
    }
  | { readonly kind: "absent" };

/**
 * Pages through `GET /api/v1/competitions` (tenant-scoped to whatever org `s`
 * is signed into) looking for a row whose slug matches the pack's own
 * declared competition slug. Slug match plus hash match is `reuse`; slug match
 * with any other hash is `stale`. `absent` on no slug match at all — including
 * when the pack declares no explicit slug, since there is then nothing stable
 * to match on (the server would mint a slug from the run-tagged name, which
 * this file cannot predict without asking it).
 *
 * `listCompetitions` is paginated and ordered `created_at desc, id desc`
 * with `limit + 1` (competitions.ts:82-94) — under `--keep`, competitions
 * accumulate in the deterministic org across every EDITED-then-reseeded pack
 * generation, so the match this run wants can be pushed off the first page.
 * This pages through the cursor until found or exhausted rather than
 * assuming page one.
 */
export async function findExistingSeed(
  base: string,
  s: Session,
  t: SeedTransport,
  plan: SeedPlan,
  packHash: string,
): Promise<SeedLookup> {
  const slug = plan.competition.slug;
  if (slug === undefined) return { kind: "absent" };
  let cursor: string | undefined;
  for (;;) {
    const qs = cursor ? `?cursor=${encodeURIComponent(cursor)}` : "";
    const page = await t.request<CompetitionListPage>(
      base,
      s,
      `/api/v1/competitions${qs}`,
    );
    for (const row of page.items) {
      if (row.slug !== slug) continue;
      const heldHash = row.branding[KEEP_BRANDING_KEY];
      if (heldHash === packHash)
        return { kind: "reuse", orgId: row.org_id, competitionId: row.id };
      return { kind: "stale", competitionId: row.id, heldHash };
    }
    if (!page.nextCursor) return { kind: "absent" };
    cursor = page.nextCursor;
  }
}

interface IdOut {
  id: string;
}

/** An `expected.matches` outcome carries PACK refs; every comparator in
 *  `oracle.ts` takes ids already resolved by its caller. Unresolvable refs are
 *  collected rather than thrown on, so one bad row reports every bad ref in
 *  that division instead of the first. */
export function resolveExpectedOutcome(
  outcome: PackExpectedOutcome,
  entrantIdByRef: ReadonlyMap<string, string>,
  unresolved: string[],
): ExpectedMatchRow["outcome"] | undefined {
  if (outcome.kind === "draw" || outcome.kind === "tie" || outcome.kind === "no_result") return outcome;
  const winner = entrantIdByRef.get(outcome.winner);
  if (winner === undefined) unresolved.push(outcome.winner);
  if (outcome.kind === "award") {
    // The PACK's award variant carries no `score` — only the engine's does.
    //
    // It DOES carry `method`, and this rebuild used to drop it. The note that
    // stood here cited `pack-schema.ts` for a rule that had since been
    // rewritten to say the opposite: the engine's award variant now declares
    // `method`, fed verbatim from `core.forfeit`'s required `reason`, and the
    // pack's was opened to match. Dropping it here meant `compareMatches`
    // compared an award's reason against a value it was never handed — so
    // suite 11's declared walkover (`se-r0-i19`) asserted nothing on a live
    // run. A field this function does not NAME is a field the oracle cannot
    // check, whatever the schema and the comparator agree between them.
    if (winner === undefined) return undefined;
    return { kind: "award", winner, ...(outcome.method === undefined ? {} : { method: outcome.method }) };
  }
  const loser = entrantIdByRef.get(outcome.loser);
  if (loser === undefined) unresolved.push(outcome.loser);
  if (winner === undefined || loser === undefined) return undefined;
  return { kind: "win", winner, loser, ...(outcome.method === undefined ? {} : { method: outcome.method }) };
}

/** A special's claims carry PACK refs; `compareSpecials` takes resolved ids. */
function resolveSpecialClaim(
  claim: PackClaim,
  entrantIdByRef: ReadonlyMap<string, string>,
  unresolved: string[],
): ResolvedSpecialClaim {
  if (claim.on === "state") return claim;
  if (claim.on === "outcome") {
    const mapRef = (ref: string | undefined): string | undefined => {
      if (ref === undefined) return undefined;
      const id = entrantIdByRef.get(ref);
      if (id === undefined) unresolved.push(ref);
      return id;
    };
    return {
      on: "outcome",
      ...(claim.kind === undefined ? {} : { kind: claim.kind }),
      ...(claim.method === undefined ? {} : { method: claim.method }),
      ...(claim.winner === undefined ? {} : { winner: mapRef(claim.winner) }),
      ...(claim.loser === undefined ? {} : { loser: mapRef(claim.loser) }),
    };
  }
  const id = entrantIdByRef.get(claim.entrant);
  if (id === undefined) unresolved.push(claim.entrant);
  return { ...claim, entrant: id ?? claim.entrant };
}

/** The fixture's own `StandingsDelta` pair, keyed by entrant id.
 *
 *  Returns an EMPTY map when the module, cfg or fold cannot be resolved, which
 *  `compareSpecials` then reports as a failed claim naming the missing cell —
 *  never as a pass. Every such case also pushes a warning saying why. */
function specialStandingsDelta(
  pack: Pack,
  divisionRef: string,
  outcome: unknown,
  state: unknown,
  warnings: string[],
): ReadonlyMap<string, Record<string, number>> {
  const empty = new Map<string, Record<string, number>>();
  const division = pack.divisions.find((d) => d.ref === divisionRef);
  if (division === undefined) return empty;
  const parsedOutcome = MatchOutcome.safeParse(outcome);
  if (!parsedOutcome.success || state === null || state === undefined) {
    warnings.push(
      `oracle: special standings claim in "${divisionRef}" has no folded outcome/state to derive a delta from`,
    );
    return empty;
  }
  let sportModule;
  try {
    sportModule = bootRegistry().get(division.sportKey, division.moduleVersion);
  } catch {
    warnings.push(`oracle: no engine module "${division.sportKey}@${division.moduleVersion}" for a specials claim`);
    return empty;
  }
  const resolvedCfg = resolveDivisionCfg(sportModule, division);
  if (!resolvedCfg.ok) {
    warnings.push(`oracle: division "${divisionRef}" cfg could not be resolved for a specials claim`);
    return empty;
  }
  const stageKind = division.stages[0]?.kind;
  if (stageKind === undefined) return empty;
  try {
    const pair = sportModule.standingsDelta(parsedOutcome.data, resolvedCfg.cfg, { kind: stageKind }, state);
    return new Map(pair.map((delta) => [delta.entrantId, delta as unknown as Record<string, number>]));
  } catch (err) {
    // Fails closed: an empty map makes every standings claim report its
    // cell as absent, which reds. The warning says why, so the red is
    // diagnosable rather than mysterious.
    warnings.push(
      `oracle: ${division.sportKey} could not derive a standings delta for a specials claim in "${divisionRef}" — ` +
        `${err instanceof Error ? err.message : String(err)}`,
    );
    return empty;
  }
}

/**
 * B07a T3 — one `PackAdaptation` as the single line of prose the report
 * carries for it.
 *
 * Exported, and a named function rather than an inline lambda at its three
 * call sites, because the `where` branch otherwise has NO witness anywhere:
 * `where` is optional in the schema, and neither `_tiny` (15 rows) nor
 * `suite11` (13) declares a row without one — so deleting the guard would
 * render a literal `[undefined]` into every report and no pack in the tree
 * would notice. Its test drives both sides directly.
 *
 * BOTH required fields, never just `what`: `PackAdaptation` splits
 * what-was-reshaped from why precisely because "what" with no "why" is the
 * unreviewable list those two required fields exist to forbid, and a report
 * carrying half of each row would rebuild exactly that.
 */
export function formatAdaptation(a: PackAdaptation): string {
  return `${a.what} — WHY: ${a.why}${a.where === undefined ? "" : ` [${a.where}]`}`;
}

/** `se-r{n}-i{i}` — the single-elim generator's own id shape
 *  (`packages/engine/src/scheduling/singleelim.ts`, and `_tiny`'s own
 *  `se-r0-i0`, `pack-schema.test.ts`). Both captures parsed as integers —
 *  see `publishTargets` below for why. */
const SE_ROUND_KEY = /^se-r(\d+)-i(\d+)$/;

interface ParsedSeKey {
  readonly extKey: string;
  readonly round: number;
  readonly index: number;
}

/**
 * B07a Task 12 / Ruling R70 — the array `publishTargets` returns, PLUS one
 * non-enumerable property naming the input keys that did not parse as
 * `se-r{n}-i{i}`.
 *
 * Non-enumerable deliberately: `expect(publishTargets(x)).toEqual([...])`
 * (the brief's own three tests) compares plain arrays via `Object.keys`,
 * which never sees a non-enumerable property, so the brief's assertions
 * keep working unmodified. `runPackSuite` reads `.unparsedKeys` directly
 * (bracket/dot access does not care about enumerability) to push a warning
 * naming what it silently excluded — see rule 4.
 */
export type PublishTargets = readonly string[] & {
  readonly unparsedKeys: readonly string[];
};

function withUnparsedKeys(published: readonly string[], unparsedKeys: readonly string[]): PublishTargets {
  const result: string[] = published.slice();
  Object.defineProperty(result, "unparsedKeys", {
    value: unparsedKeys,
    enumerable: false,
    writable: false,
    configurable: false,
  });
  return result as unknown as PublishTargets;
}

/**
 * B07a Task 12 / Ruling R70 — the news step publishes the SEMIS and the
 * FINAL, not the whole last stage. Pure over ONE stage's streams: the caller
 * (`runPackSuite`, below) filters to division0's last stage before calling
 * this, exactly as it filtered before Task 12 — this function only decides
 * WHICH of those streams' ext keys publish.
 *
 * - Empty case FIRST (rule 3): no streams in => `[]` out. NOT a separate
 *   early return — the mutation sweep proved one dead (removing it never
 *   reddened a test): `parsed` stays `[]`, so `roundsPresent` is `[]`,
 *   `topTwoRounds` is the empty set, and the final filter falls through to
 *   `[]` on its own. Left out rather than shipped as decoration
 *   (AGENTS.md recurring-failure class 3 — "a guard nothing kills is not
 *   tested"). This is also a DIFFERENT empty case from "streams present but
 *   none parse" below — both land on `[]`, for different reasons, and rule 4
 *   requires the second one to say so via `unparsedKeys` while this one has
 *   nothing to name.
 * - The round is parsed from `se-r{n}-i{i}` with BOTH `n` and `i` read as
 *   INTEGERS (rule 2): a string sort would put `"se-r10-i0"` between
 *   `"se-r1x"` and `"se-r2x"`, so `se-r10` would wrongly outrank `se-r9`.
 * - The TOP TWO distinct rounds present publish, in round-then-index order.
 *   Exactly one round present => that round only — never an invented semi.
 * - A key that does not match `se-r{n}-i{i}` is excluded from the published
 *   set (never guessed at) and reported on the returned array's
 *   `unparsedKeys` (rule 4) so `runPackSuite` can warn by name instead of
 *   the list silently coming back short.
 */
export function publishTargets(streams: readonly Pick<PackStream, "fixtureExtKey">[]): PublishTargets {
  const parsed: ParsedSeKey[] = [];
  const unparsedKeys: string[] = [];
  for (const st of streams) {
    const m = SE_ROUND_KEY.exec(st.fixtureExtKey);
    if (m === null) {
      unparsedKeys.push(st.fixtureExtKey);
      continue;
    }
    parsed.push({ extKey: st.fixtureExtKey, round: Number(m[1]), index: Number(m[2]) });
  }

  const roundsPresent = [...new Set(parsed.map((p) => p.round))].sort((a, b) => a - b);
  const topTwoRounds = new Set(roundsPresent.slice(-2));

  const published = parsed
    .filter((p) => topTwoRounds.has(p.round))
    .sort((a, b) => (a.round !== b.round ? a.round - b.round : a.index - b.index))
    .map((p) => p.extKey);

  return withUnparsedKeys(published, unparsedKeys);
}

export async function runPackSuite(
  input: PackSuiteInput,
  opts: RunPackSuiteOptions,
): Promise<SuiteReport> {
  const { suiteKey, packPath: definitionPackPath } = opts;
  const { base, engine, keep, log } = input;
  // B06a T6 — `report.claims` has been declared since B01 (`report.ts:671`)
  // and nothing ever wrote it, exactly as `provenancePct` had not been written
  // until T5. Now that invites are actually accepted there is a real pair of
  // numbers to publish, and a report that says how many invites a run minted
  // without saying how many a human could use is the same silence this whole
  // task exists to break.
  let claimsSummary: { total: number; accepted: number } | undefined;
  // B06a T7 — `report.news` (`report.ts:673`) has been declared since B01 with
  // no writer, for the same reason `report.claims` had none: nothing in the
  // bench had ever turned drafting ON, so there was never anything to write.
  let newsSummary: { drafted: number; published: number } | undefined;
  const t = input.transport ?? defaultTransport;
  const errors: string[] = [];
  const warnings: string[] = [];
  const oracles: OracleResult[] = [];
  const timings: { seedMs?: number; scheduleMs?: number; simMs?: number; importMs?: number } = {};
  const registrationReports: RegistrationDivisionReport[] = [];
  /** B04 — one row per division actually driven through the scheduling layer.
   *  Empty for a run that never reached it (stage 0 refused, `--keep` short
   *  circuit, a throw before seeding), and then omitted from the report
   *  entirely rather than rendered as a suite that scheduled zero divisions
   *  cleanly. */
  const scheduling: DivisionScheduleReport[] = [];
  /** F-T6-3 — the run-level gate's own findings. Empty on a clean run and
   *  omitted from the report then; NEVER omitted when non-empty, because every
   *  per-division layer is blind to this by construction. */
  let crossDivisionClashes: readonly CrossDivisionCourtClash[] = [];
  /** F-T6-2 — what the product reported back on each fixture officials
   *  auto-assign touched. Read AFTER the apply, per fixture, by
   *  `runOfficialsAutoAssign`. */
  let officialsByFixtureId: ReadonlyMap<string, readonly FixtureOfficialRow[]> = new Map();
  let engineDelta: EngineDeltaSection | undefined;
  let conflictCount: number | undefined;
  let solver: Omit<SolverResult, "requestedEngine"> | undefined;
  /** B05 T1 — set only when the simulate step actually ran (`input.sql`
   *  present AND division A declared at least one stream). */
  let simulation: SimulationReport | undefined;
  /** B05 T2 — set only when the import step actually ran (`input.sql`
   *  present AND some OTHER division declared at least one stream). */
  let importSimulation: ImportSimulationReport | undefined;
  /** B05 T2.5 (D9) — one row per division `runDivisionStartLayer` started,
   *  set only when the step actually ran (`input.sql` present AND at least
   *  one division declared a stream). Populated BEFORE `simulation`/
   *  `importSimulation` above run, since neither fold can succeed against an
   *  unstarted division. */
  let divisionStart: DivisionStartReport[] | undefined;
  /** B07a T10 — the tap player (created on the first tapped division, closed
   *  after the run whatever happened) and `report.tapPlay`, set only when at
   *  least one tapped match was actually handed to the player. A holder rather
   *  than two `let`s: both are written inside a closure, which control-flow
   *  narrowing cannot see. */
  const tapState: { player?: TapPlayer; report?: TapPlayReport } = {};
  // Fix round 2 (R64) — fixtures the tap path played, and so signed off with a
  // bench-appended core.finalize that is not a pack event.
  const tapPlayedFixtureIds = new Set<string>();

  // Stage 0 FIRST, and nothing is created if it refuses: a pack the offline
  // gate rejects would otherwise be seeded over HTTP and report a product
  // defect that is really an authoring one, minutes into a live run.
  const packPath = input.packPath ?? definitionPackPath;
  const staged = await tinyPackStage(packPath);
  warnings.push(...staged.warnings);
  if (!staged.ok) {
    log.error(
      { packPath, errors: staged.errors },
      `${suiteKey}: pack refused by stage 0`,
    );
    return {
      suite: suiteKey,
      gate: "red",
      timings,
      keep,
      solver: { requestedEngine: engine },
      errors: staged.errors.map((e) => `pack: ${e}`),
      ...(warnings.length > 0 ? { warnings } : {}),
    };
  }
  const { pack, plan, packHash } = staged;
  if (warnings.length > 0)
    log.warn({ packPath, warnings }, `${suiteKey}: pack validated with warnings`);

  try {
    // The identity used to sign in this run — see this file's header comment
    // on why `--keep` needs a FIXED tag and `--wipe` keeps the original
    // random one.
    const runTag = keep ? "keep" : randomUUID().slice(0, 8);
    const email = `delivered+bench-${plan.org.slug}-${runTag}@resend.dev`;

    const s: Session = newSession();
    const seedStart = performance.now();
    log.info({ email, keep }, `${suiteKey}: signing in`);
    const { org_id: orgId } = await t.signIn(base, s, email);

    const lookup: SeedLookup = keep
      ? await findExistingSeed(base, s, t, plan, packHash)
      : { kind: "absent" };

    // A changed pack under an unchanged slug: refuse here, with the cause, and
    // create nothing. See `SeedLookup` above for why seeding on cannot work.
    if (lookup.kind === "stale") {
      const message =
        `${suiteKey}: --keep cannot reuse competition "${plan.competition.slug}" (${lookup.competitionId}) — it holds ` +
        `pack hash ${JSON.stringify(lookup.heldHash)} and this pack hashes to ${packHash}. The pack changed since ` +
        `the last --keep run, and (org_id, slug) is unique so a fresh seed would 409 on the same slug. ` +
        `Re-run with --wipe to reseed this suite from scratch.`;
      log.error(
        {
          competitionId: lookup.competitionId,
          heldHash: lookup.heldHash,
          packHash,
        },
        `${suiteKey}: --keep refused — pack changed under an existing competition slug`,
      );
      return {
        suite: suiteKey,
        gate: "red",
        timings: { seedMs: Math.round(performance.now() - seedStart) },
        keep,
        solver: { requestedEngine: engine },
        // B07a T3 — the pack LOADED here (it is precisely the CHANGED pack
        // that caused this refusal), so its §7A list is known and is a fact
        // about this run like any other. Omitting it would render the
        // "never measured" state over a pack sitting in memory.
        adaptations: pack.meta.adaptations.map(formatAdaptation),
        errors: [message],
        ...(warnings.length > 0 ? { warnings } : {}),
      };
    }

    const existing = lookup.kind === "reuse" ? lookup : null;
    if (existing) {
      timings.seedMs = Math.round(performance.now() - seedStart);
      warnings.push(
        `${suiteKey}: --keep reused existing seed (org ${existing.orgId}, competition ${existing.competitionId}) — ` +
          `pack hash unchanged, seeding and scheduling skipped this run. No board, no checker, no certificate and ` +
          `no engine artifact were produced. Pass --wipe for any leg that must actually schedule (required for the ` +
          `second leg of the two-engine bench protocol — see B04-handoff-2026-09-05.md).`,
      );
      log.info(
        { orgId: existing.orgId, competitionId: existing.competitionId },
        `${suiteKey}: --keep short-circuited — reusing a prior run's seed`,
      );
      // T7e: NEVER "green" here. This leg scheduled nothing, checked nothing
      // and certified nothing — the same class of false pass B04 exists to
      // catch in the PRODUCT (`CheckerReport.unexercised`), just found in the
      // bench's own reporting instead. A bare "green" on `actual=n/a` is
      // exactly what the first live run's leg B produced, and it read as a
      // clean pass at a glance. "skipped" is a third, non-green `gate` value
      // (`report.ts`'s `SuiteGateStatus`) that `gateOf` folds into the run-
      // level "red" — the warning above says why, but the gate itself is what
      // makes the short circuit impossible to miss.
      return {
        suite: suiteKey,
        gate: "skipped",
        timings,
        keep,
        solver: { requestedEngine: engine },
        // B07a T3 — and this is the one that matters most: `--keep` is the
        // DEFAULT (`bench.ts`'s `keep: !values.wipe`), so a repeat run lands
        // HERE, not on the main return. The pack was loaded and hashed to
        // get this far; reporting "never measured" while its adaptations sit
        // in memory is the silence this field exists to break.
        adaptations: pack.meta.adaptations.map(formatAdaptation),
        ...(warnings.length > 0 ? { warnings } : {}),
      };
    }

    // `_tiny.json` declares exactly one FIRST division — `buildSeedPlan`/
    // `seedSuite` are generalised past that, but this suite's OWN scheduling
    // walk below still only ever drives the first division's FIRST stage,
    // matching what `_tiny.json`'s league stage needs. `divisions.min(1)` on
    // `PackSchema` guarantees at least one; a stage-less division would be an
    // authoring bug stage 0 does not currently catch, so it is named here
    // rather than silently producing `undefined.id` downstream.
    //
    // B05 T3: `division0` legitimately declares a SECOND stage (`s-playoff`, a
    // knockout fed from the league).
    //
    // B07a T6: there is no longer a `stage1` binding here. Advancement used to
    // read `division0.stages[1]` and nothing else, which is precisely why it
    // ran for one division only; it now walks every division's own stage list
    // (see the advance loop below), so a single hoisted "second stage of the
    // first division" has no reader left. `division0`/`stage0` are unaffected
    // and still name what this suite's scheduling walk drives.
    const division0 = plan.divisions[0];
    const stage0 = division0?.stages[0];
    if (division0 === undefined || stage0 === undefined) {
      throw new Error(
        `${suiteKey}: the pack's plan has no division/stage to seed and schedule`,
      );
    }

    // B03 T7 — plan/entitlement provisioning + the cricket.dls entitlement-
    // gate probe. Runs BEFORE `seedSuite` (never after): `autoAssign` below
    // has to be known before this suite's own scheduling walk decides
    // whether to drive `runOfficialsAutoAssign` afterward (B03 review
    // F1(b) — that call itself happens much later, AFTER schedule/apply,
    // see below). The probe owns its OWN throwaway competition/divisions
    // (dls-gate.ts's header comment) — it never touches `_tiny`'s own
    // competition/division/stage, so this ordering costs nothing else in
    // this function. Skipped entirely when `input.sql` is absent (see
    // `PackSuiteInput.sql`'s own doc comment on why that is the deliberate
    // default).
    let autoAssign: boolean | undefined;
    // B03 T6b: whether the plan the DLS-gate probe just provisioned ALSO
    // grants `stats.player` — now genuinely derived the same way `autoAssign`
    // is, i.e. out of the probe's own capability SELECTION. It previously read
    // `plan_entitlements` again and tested the already-chosen plan, and this
    // comment claimed the two were equivalent; they were not, and the
    // difference is the whole of review finding F1(a) one capability over.
    // Gates the org-authenticated
    // half of the player-stats baseline (`lib/stats.ts`); the public route
    // needs no entitlement at all, only `competitionVisibility` below.
    let statsPlayerGranted = false;
    // B06a T7 — whether the chosen plan sells `news.auto`. DERIVED from the
    // same plan selection as `officialsAutoGranted`, never assumed: without it
    // `PATCH /divisions/{id}` refuses `auto_posts: true`
    // (`usecases/divisions.ts:652-654`), and because drafting is a side effect
    // of FOLDING there is no later moment at which this run could recover.
    let newsAutoGranted = false;
    // B07a T11 — whether the chosen plan grants `scoring.device_links`, from
    // the same selection. Task 10's tap branch consumes this.
    let deviceLinksGranted = false;
    if (input.sql !== undefined) {
      log.info(
        {},
        `${suiteKey}: running the cricket.dls entitlement-gate probe (B03 T7)`,
      );
      const probe = await runDlsGateProbe({
        base,
        email,
        runTag,
        sql: input.sql,
        ...(input.probeTransport === undefined
          ? {}
          : { transport: input.probeTransport }),
      });
      for (const cell of probe.cells) {
        oracles.push({
          name: `entitlement-gate: ${cell.cell}`,
          passed: cell.ok,
          detail: cell.detail,
        });
        if (!cell.ok) {
          errors.push(
            `entitlement-gate probe cell "${cell.cell}" failed its own expectation: ${cell.detail}`,
          );
        }
      }
      // THE PROMISE at the matrix, as its own oracle (dls-gate.ts's header,
      // point 2). The cells above prove the door is open for THIS org over
      // HTTP; this proves it is open for every org that never paid. Scoring
      // is free by owner ruling — a false here means a migration put it back
      // behind a price.
      oracles.push({
        name: "entitlement-gate: cricket.dls is free on the plan a non-paying org resolves to",
        passed: probe.dlsFreeOnCommunityPlan,
        detail: probe.dlsFreeOnCommunityPlan
          ? `plan_entitlements grants cricket.dls on "${FREE_PLAN_KEY}" — scoring is free, as ruled ` +
            `(V390__scoring_free.sql; V393__entitlements_v18.sql:63-70)`
          : `plan_entitlements no longer grants cricket.dls on "${FREE_PLAN_KEY}" — scoring has been ` +
            `re-gated for customers who never paid, which contradicts the standing owner ruling`,
      });
      if (!probe.dlsFreeOnCommunityPlan) {
        errors.push(
          `entitlement-gate: cricket.dls is no longer granted on "${FREE_PLAN_KEY}" — scoring is supposed to be free`,
        );
      }
      // The paywall cell retires itself when nothing this probe can provoke
      // is still sold (`DlsGateProbeResult.gatedFeatureProbed`). That is a
      // finding to act on — point one of those gates at a key that IS sold —
      // never a silent loss of coverage.
      if (probe.gatedFeatureProbed === null) {
        warnings.push(
          `${suiteKey}: no feature key the DLS-gate probe knows how to provoke is still gated for a ` +
            `"${FREE_PLAN_KEY}" org, so the "a 402 names its feature_key" cell did not run — that ` +
            "coverage is retired until PROVOCABLE_GATED_FEATURES (lib/dls-gate.ts) names a key that is still sold",
        );
      }
      autoAssign = probe.officialsAutoGranted;
      newsAutoGranted = probe.newsAutoGranted;
      deviceLinksGranted = probe.deviceLinksGranted;
      // B07a T11 — the two device-link cells ride the generic loop above; what
      // needs saying here is when they could not run, or could not pass.
      if (!probe.deviceLinkGateProbed) {
        warnings.push(
          `${suiteKey}: scoring.device_links is not paywalled for a "${FREE_PLAN_KEY}" org on this catalog, so the ` +
            "device_link_refused_before_plan / device_link_minted_after_plan cells were not emitted — there is no " +
            "device-link paywall on this catalog for the probe to prove",
        );
      }
      if (!deviceLinksGranted) {
        warnings.push(
          `${suiteKey}: plan "${probe.provisionedPlan}" does not grant scoring.device_links (deviceLinksGranted false) — ` +
            "this org cannot mint a device link, so no scorer on this run can be handed one",
        );
      }
      // What the device-link proof must say without reddening: a link it
      // minted and could not revoke, or a single-plan choice that traded device
      // links away while a public plan sells them.
      for (const warning of probe.deviceLinkWarnings) {
        warnings.push(`${suiteKey}: ${warning}`);
      }
      // B03 review F1(a): the chosen plan is not guaranteed to grant every
      // capability this run wants (`chooseGrantingPlanForCapabilities` picks
      // the best available candidate, never invents one) — reported here,
      // never silently swallowed, when it does not.
      if (probe.unsatisfiedCapabilities.length > 0) {
        warnings.push(
          `${suiteKey}: plan "${probe.provisionedPlan}" (chosen because it grants cricket.dls) does not also grant ` +
            `${probe.unsatisfiedCapabilities.join(", ")} — no single plan on this catalog grants every ` +
            `capability this run wants`,
        );
      }
      statsPlayerGranted = probe.statsPlayerGranted;
      log.info(
        {
          provisionedPlan: probe.provisionedPlan,
          officialsAutoGranted: probe.officialsAutoGranted,
          newsAutoGranted: probe.newsAutoGranted,
          deviceLinksGranted,
          deviceLinkGateProbed: probe.deviceLinkGateProbed,
          unsatisfiedCapabilities: probe.unsatisfiedCapabilities,
          statsPlayerGranted,
          dlsFreeOnCommunityPlan: probe.dlsFreeOnCommunityPlan,
          gatedFeatureProbed: probe.gatedFeatureProbed,
        },
        `${suiteKey}: entitlement-gate probe complete`,
      );
    }

    // B03r tasks 9+10: every registration-carrying division (`_tiny`'s own
    // `d-registration`) is EXCLUDED from the plan handed to `seedSuite` — it
    // is created and driven separately, below, via `register.ts`'s own
    // driver flow (see build-packs/_tiny.ts's comment on `d-registration`
    // for why `seedSuite`'s normal create-then-generate walk cannot touch
    // it: it has no real entrants until the registration funnel runs, and
    // `/generate` on fewer than two refuses). `plan` itself is left
    // UNTOUCHED — `division0`/`stage0` above, `fixtureCountIssue` below and
    // the officials/stats blocks all keep reading the ORIGINAL plan, which
    // is correct either way: `d-registration`'s stage is `kind:"knockout"`
    // (never "league"), so it was never contributing an
    // `expectedFixtureCounts` entry regardless of this filter.
    const registrationDivisionRefs = new Set(
      registrationDivisionsOf(pack).map((d) => d.ref),
    );
    const seedPlan: SeedPlan =
      registrationDivisionRefs.size === 0
        ? plan
        : {
            ...plan,
            divisions: plan.divisions.filter(
              (d) => !registrationDivisionRefs.has(d.ref),
            ),
            entrants: plan.entrants.filter(
              (e) => !registrationDivisionRefs.has(e.divisionRef),
            ),
          };

    // ONE chain now. This suite used to create its own venue and its own
    // single court over HTTP, concurrently with `seedSuite`, because
    // `_tiny.json` declared no `venues[]` — so the pack could not name a
    // court, `scheduleConfig.courts` had nothing to `@`-reference, and design
    // §3.3's court-double-booking rule had exactly one court to look for a
    // clash on. B04 T6 moves the venue and TWO courts into the pack (design
    // §7) and deletes that chain: `seedSuite` already seeds `pack.venues`
    // (`seed.ts:332-378`) and hands back `venueIdByRef`/`courtIdByRef`, which
    // is the ONE resolution of every court ref this run makes.
    //
    // `seedSuite` signs in AGAIN internally with the SAME email — a second
    // magic-link round trip, accepted as the cost of keeping `seedSuite`
    // self-contained (it does not accept an external session) rather than
    // exposing one just for this caller.
    const seeded: SeededSuite = await seedSuite({
      base,
      plan: seedPlan,
      streams: pack.streams,
      venues: pack.venues,
      runTag,
      transport: t,
      competitionBranding: { [KEEP_BRANDING_KEY]: packHash },
      // B03 T6b: only when a plan has been provisioned (`input.sql`
      // present) — the public stats route needs the competition's
      // visibility off its `'private'` default (see `lib/stats.ts`'s
      // header comment), and there is no reason to change it for a caller
      // that never asked for the stats baseline at all (unit tests
      // included — `input.sql` absent there too).
      ...(input.sql === undefined
        ? {}
        : { competitionVisibility: "unlisted" as const }),
    });

    if (seeded.orgId !== orgId) {
      throw new Error(
        `${suiteKey}: seedSuite signed into org "${seeded.orgId}" but this suite's own session is on "${orgId}" ` +
          `— sign-in for "${email}" did not return the same org twice`,
      );
    }
    const divisionId = seeded.divisionIdByRef.get(division0.ref);
    const stageId = seeded.stageIdByRef.get(stage0.ref);
    if (divisionId === undefined || stageId === undefined) {
      throw new Error(
        `${suiteKey}: seedSuite resolved no id for division "${division0.ref}" / stage "${stage0.ref}"`,
      );
    }

    // B03 T6b: every official's claim invite `seedOfficialsAndClaims` just
    // minted — a real oracle, not merely that the seeding step ran.
    // `claimed_at === null` is the proof nothing here accepted it (B03 §5:
    // seeding only mints invites). Runs unconditionally — the invite call
    // is ungated on every plan, matching the pack's own player claim
    // invites just above it in seed.ts.
    const officialInvites = seeded.officialsAndClaims?.officialClaimInviteByRef;
    if (officialInvites !== undefined) {
      for (const [ref, claim] of officialInvites) {
        const passed = claim.claimed_at === null;
        oracles.push({
          name: `officials: claim invite unclaimed (${ref})`,
          passed,
          detail: passed
            ? `claim ${claim.id} for person ${claim.person_id} is minted and unclaimed`
            : `claim ${claim.id} shows claimed_at=${claim.claimed_at} — seeding must never accept`,
        });
        if (!passed) {
          errors.push(
            `official "${ref}"'s claim invite shows claimed_at != null — seeding must never accept`,
          );
        }
      }
    }

    // DERIVED from the pack (entrants choose two, times its declared legs) —
    // never a constant. See `fixtureCountIssue`'s own doc comment for why
    // this comparison lives on the testable side of the network boundary.
    // B05 T3: scoped to LEAGUE-stage-bound fixtures ONLY — see
    // `leagueBoundStreamCount`'s own doc comment for why the pool-wide
    // `seeded.fixtureIdByKey.size` stopped being the right number the moment
    // `d-tiny` grew a second, non-league stage.
    const countIssue = fixtureCountIssue(leagueBoundStreamCount(pack, plan), plan);
    if (countIssue !== null) {
      // B06b — a knockout-only pack has no league fixture count to check, and
      // that is NO SUBJECT rather than a defect: suite 11 is knockout in both
      // divisions and this note reddened its entire run. `fixtureCountIssue`
      // still NAMES the absence (its own test pins that it never no-ops
      // silently) — severity is decided here instead, so the note is reported
      // without gating. A league stage that EXISTS and declares no
      // expectation still reds, unchanged.
      if (packDeclaresLeagueStage(plan)) errors.push(countIssue);
      else warnings.push(`${countIssue} — this pack declares no league stage, so there is nothing to check`);
    }
    timings.seedMs = Math.round(performance.now() - seedStart);

    // B03 prompt's acceptance line: `pino: suite_seeded (org, persons,
    // entrants, fixtures, ms)`. Every count is read off what the run actually
    // CREATED — `seeded.*` maps returned by `seedSuite` — never off the plan it
    // intended to create, so a partial seed reports the smaller number rather
    // than the hoped-for one.
    log.info(
      {
        org: seeded.orgId,
        competition: seeded.competitionId,
        persons: seeded.personIdByRef.size,
        entrants: seeded.entrantIdByRef.size,
        divisions: seeded.divisionIdByRef.size,
        stages: seeded.stageIdByRef.size,
        fixtures: seeded.fixtureIdByKey.size,
        officials: seeded.officialsAndClaims?.officialIdByRef.size ?? 0,
        ms: timings.seedMs,
      },
      "suite_seeded",
    );

    // -----------------------------------------------------------------
    // B06a T7 — turn NEWS DRAFTING on, before anything folds.
    //
    // Drafting is a side effect of folding (`refreshNews`, `scoring.ts:132`
    // and `event-import.ts:435`), never a route anyone calls, and it is gated
    // on five conditions in order: the event decides or voids
    // (`scoring.ts:129`), `divisions.auto_posts` is true (`:353-356`, re-read
    // at `org-posts.ts:479`), the org holds `news.auto` (`:480`), and the
    // fixture's status is decided/finalized/forfeited (`:483-485`). Miss any
    // one and the product drafts NOTHING and says nothing about why.
    //
    // So this runs HERE — after seeding, before the first fold — and not with
    // the publish step far below. There is no second chance: an event folded
    // while `auto_posts` was false never drafts, and re-folding it is not
    // something a bench may do.
    let newsEnable: Awaited<ReturnType<typeof enableAutoPosts>> | undefined;
    if (input.sql !== undefined) {
      const newsTransport = input.oracleTransport ?? defaultProbeTransport;
      const divisionIds = [...seeded.divisionIdByRef.values()];
      if (!newsAutoGranted) {
        // A REPORTED gap, never a silent skip. `PATCH /divisions/{id}` would
        // answer 402 and the whole news step would then look like a product
        // that drafts nothing.
        warnings.push(
          `${suiteKey}: the provisioned plan does not grant "news.auto", so auto-posting could not be turned ` +
            "on and the news step has NO SUBJECT — no post this run reports on was ever draftable",
        );
      } else if (divisionIds.length === 0) {
        warnings.push(`${suiteKey}: no division was seeded, so auto-posting could not be turned on`);
      } else {
        newsEnable = await enableAutoPosts({
          base,
          session: s,
          divisionIds,
          transport: newsTransport,
        });
        if (newsEnable.refused.length > 0) {
          errors.push(
            `news: auto-posting could not be turned on for ${newsEnable.refused.length} of ` +
              `${newsEnable.requested} divisions — ` +
              newsEnable.refused.map((r) => `${r.divisionId} HTTP ${r.status} (${r.detail})`).join("; "),
          );
        }
        log.info(
          { requested: newsEnable.requested, enabled: newsEnable.enabled },
          `${suiteKey}: auto-posting enabled ahead of the folds (B06a T7)`,
        );
      }
    }

    // -----------------------------------------------------------------------
    // B04 — the scheduling layer, over EVERY division this run seeded
    // -----------------------------------------------------------------------
    //
    // What this replaces: a hand-rolled walk that PUT a hardcoded
    // `scheduleConfig` (30-minute matches on the one court this file created
    // itself), POSTed `schedule/auto` with an EMPTY body, applied whatever came
    // back, and asserted `/validate`'s blocking count — for `divisions[0]` and
    // `stages[0]` ONLY. `_INDEX.md` recorded both halves of that as B04's to
    // close, and this is where they close: the pack now declares the venue, the
    // courts and each division's own `scheduleConfig`, and the loop below drives
    // every seeded division rather than the first.
    //
    // Three things the old walk could not do, and why they are not optional:
    //
    //  * `body: {}` on `schedule/auto` silently asked for a REFLOW.
    //    `AutoScheduleRequest` (`apps/web/src/server/api-v1/schemas.ts:1643-1688`
    //    — 1643 is the `z.preprocess` WRAPPER, and the derivation itself is at
    //    :1651) reads `only_unlocked === false ? "build" : "reflow"`, with the
    //    strict `=== false` there precisely because an absent flag defaults to
    //    `true`. So a first-time build was being reported for a call that asked
    //    to re-flow a stage nothing had ever scheduled. `schedule.ts` sends the
    //    flag. (This comment also replaces a stale `schemas.ts:1496-1542` pin —
    //    design finding F5; the type has moved twice, so it is cited by NAME
    //    with the line range beside it rather than by line alone.)
    //  * `--engine` was logged as "not honoured" and nothing asserted it.
    //    Nothing in the product selects an engine (design §1.1/F3), so the flag
    //    is an ASSERTION about what actually ran, and `schedule.ts`'s
    //    `readSolver` makes it — `both` asserts nothing, and nothing else is
    //    relaxed.
    //  * The board was never fetched back, so layer 1's `blocking` count was
    //    the only thing judging it — and design §1.2 shows how little that
    //    gates (a blackout violation is not `blocking`). The board is FETCHED
    //    now and judged independently.
    //
    // `AutoScheduleOut`/`ValidateOut` are gone from this file rather than
    // widened (design finding F4 asked for a widening). `schedule.ts` declares
    // the widened copy, with its own hand-maintained note; keeping a second,
    // narrower copy here would be the exact drift F4 names, one file over.
    const scheduleStart = performance.now();

    // Design §4.4's one pin, resolved from the pack BEFORE the loop so it is
    // one decision rather than one per division — and so the "no pin this run"
    // deferral is reported once, in full, rather than N times.
    const lockResolution = resolveScheduleLocks(pack, seedPlan, seeded);
    // Prefixed here, not inside the helper: the helper is pure, separately
    // tested, and suite-agnostic — the suite key is this caller's fact.
    warnings.push(...lockResolution.notes.map((n) => `${suiteKey}: ${n}`));

    const scheduleDivisions: ScheduleDivision[] = [];
    for (const planned of seedPlan.divisions) {
      const plannedDivisionId = seeded.divisionIdByRef.get(planned.ref);
      const stage = planned.stages[0];
      const plannedStageId = stage === undefined ? undefined : seeded.stageIdByRef.get(stage.ref);
      if (plannedDivisionId === undefined || stage === undefined || plannedStageId === undefined) {
        // Never silent: a division that was seeded and then not scheduled is
        // indistinguishable in a report from one that was scheduled cleanly.
        errors.push(
          `${suiteKey}: division "${planned.ref}" was seeded but cannot be scheduled — ` +
            `divisionId=${plannedDivisionId ?? "unresolved"}, stage=${stage?.ref ?? "none declared"}, ` +
            `stageId=${plannedStageId ?? "unresolved"}`,
        );
        continue;
      }
      if (planned.stages.length > 1) {
        // One `ScheduleDivision` carries ONE stage, and steps 4/5 are
        // per-stage while steps 6/7 are per-division — so a second stage would
        // need its own auto/apply against a division whose board the first
        // pass already fetched. Out of B04's scope, and said out loud rather
        // than dropped: `_tiny` declares one stage per division.
        warnings.push(
          `${suiteKey}: division "${planned.ref}" declares ${planned.stages.length} stages and only "${stage.ref}" is scheduled — ` +
            "B04 drives one stage per division",
        );
      }
      const packDivision = pack.divisions.find((d) => d.ref === planned.ref);
      const scheduleConfig = packDivision?.scheduleConfig;
      if (scheduleConfig === undefined) {
        // Legal (the encoding falls through to the product's own defaults) and
        // worth saying: a division with no declared config is judged against
        // defaults nobody wrote down.
        warnings.push(
          `${suiteKey}: division "${planned.ref}" declares no scheduleConfig — nothing is PUT and the checker's oracle ` +
            "falls back to ScheduleConfig's own defaults",
        );
      }
      scheduleDivisions.push({
        divisionRef: planned.ref,
        divisionId: plannedDivisionId,
        stageId: plannedStageId,
        ...(scheduleConfig === undefined ? {} : { scheduleConfig }),
        // The PACK's declared zone, not the host's. Every wall clock in the
        // config is read against it, and `Board.tz` buckets calendar days by
        // it — a host-local default would make the same pack answer
        // differently on a BST dev box and a UTC CI runner.
        tz: pack.org.timezone,
        isRoundRobin: isRoundRobinStage(stage.kind),
        declaresOfficials: divisionDeclaresOfficials(pack, planned.ref),
        ...(lockResolution.locks.has(planned.ref)
          ? { locks: [lockResolution.locks.get(planned.ref)!] }
          : {}),
      });
    }

    const layer = await runScheduleLayer({
      base,
      session: s,
      orgId,
      divisions: scheduleDivisions,
      // `seedSuite`'s own map — the ONE resolution of every `@`-sigilled court
      // ref in the run. `schedule.ts` builds the config it PUTs from
      // `encodeConstraints`' output, so the product and the checker's oracle
      // are handed the same courts by construction.
      courtIdByRef: seeded.courtIdByRef,
      engine,
      transport: t,
    });

    // Keyed by `divisionRef`, NEVER by index: a division that failed before
    // its board was fetched contributes an outcome and no board, so the three
    // arrays `runScheduleLayer` returns are not index-aligned.
    const boardByRef = new Map(layer.boards.map((b) => [b.divisionRef, b]));
    const constraintsByRef = new Map(layer.constraints.map((c) => [c.divisionRef, c]));
    const engineSnapshotDivisions: EngineSnapshotDivision[] = [];

    for (const outcome of layer.outcomes) {
      const ref = outcome.divisionRef;
      const board = boardByRef.get(ref);
      const constraints = constraintsByRef.get(ref);
      // A COPY: the two throws this task must route (`encodeConstraints`',
      // caught inside the driver, and `certify`'s, caught below) are the same
      // channel, and appending to the driver's own frozen list is not an
      // option. Ruling R13 and T3's guards both say the same thing — catch and
      // ROUTE, never swallow, and never add a fallback that lets either
      // continue, because a fallback is how a throw stops being loud.
      const scheduleErrors: string[] = [...outcome.errors];

      let checker: CheckerReport | undefined;
      let certificate: CertificateVerdict | undefined;
      let believability: BelievabilityReport | undefined;
      let metricsNote: string | undefined;

      if (board !== undefined && constraints !== undefined) {
        checker = checkBoard(board, constraints);
        believability = assessBelievability({
          board,
          constraints,
          // UNFILTERED, deliberately: `assessBelievability` scopes the rows to
          // this board's own division itself (its `historicalAssignment` doc
          // comment says so), and pre-filtering here would be a second scoping
          // authority that can disagree with the one inside.
          ...(pack.historicalAssignment === undefined
            ? {}
            : { historicalAssignment: pack.historicalAssignment }),
        });
      }

      if (constraints !== undefined) {
        // THE TWO DENOMINATORS, and which one is AUTHORITATIVE.
        //
        // RULING (T6 review): **`judgeDivision.unplacedCount` — the FETCHED
        // board's count — is the authoritative unplaced gate. The
        // certificate's `placed`/`total` are a SECONDARY, HISTORY-ONLY path.**
        // Written here as a decision rather than left as an accident of
        // ordering, because the ordering is what makes it true and the
        // ordering is easy to read past:
        //
        //   `certify` evaluates SKIPPED_NO_HISTORY FIRST and returns
        //   (`certificate.ts`, design §3.4's table, ruling R27). So on a pack
        //   that declares no `historicalAssignment` — every pack the bench
        //   runs today, `_tiny` included — the UNPLACED branch beneath it is
        //   UNREACHABLE, whatever the solver claims. Feeding this call site a
        //   proposal of 2-of-3 changes nothing about the verdict.
        //
        // That is correct behaviour, not a gap: the certificate is a claim
        // about HISTORY versus our encoding, and it has nothing to say about a
        // pack with no history. But it means a reader must not take the
        // certificate as cover for the proposal side. The board is what gates;
        // the proposal is reported, compared, and warned about when the two
        // disagree.
        //
        // Both numbers are still passed and still printed, in their own report
        // columns, and neither is derived from the other — a single merged
        // "unplaced" would lose whichever one it did not pick.
        const metrics = outcome.metrics;
        if (metrics === undefined) {
          // `ScheduleOutcome.metrics` is optional, so this decision has to be
          // made explicitly rather than let `undefined` fall through into a
          // verdict. An absent `metrics` means the proposal is UNKNOWN, not
          // empty — and `(0, 0)` cannot satisfy `placed < total`, so the
          // certificate's UNPLACED branch has nothing to fire on. That is
          // exactly why this is an ERROR rather than a substitution: the
          // division reds through `judgeDivision`'s fifth trigger, and the
          // report prints this note beside the certificate so a branch that
          // had nothing to measure can never be read as one that measured a
          // complete board.
          metricsNote =
            `auto returned no metrics for ${ref}, so the solver's own placed/total are UNKNOWN — ` +
            "the certificate's UNPLACED branch could not be evaluated (it is fed (0, 0), which asserts nothing) " +
            "and the fetched board's unplaced count is the only placement evidence this division has";
          scheduleErrors.push(metricsNote);
        }
        // B06b — the history board, rendered from the pack's declared
        // timetable. Until suite 11 no pack declared one, so this was
        // `undefined` and `certify` answered SKIPPED_NO_HISTORY; the first
        // pack with rows made it throw, deliberately, because "a fallback
        // that let the run continue would certify a timetable against nothing
        // and report FEASIBLE". That work is now done rather than smoothed
        // over — see `renderHistoryBoard`.
        //
        // Still `undefined` when the pack declares nothing, so `_tiny` keeps
        // its SKIPPED_NO_HISTORY verdict exactly as before.
        let historyBoard: Board | undefined;
        if (board !== undefined && (pack.historicalAssignment ?? []).some((h) => h.divisionRef === ref)) {
          const declaredMinutes = pack.divisions.find((d) => d.ref === ref)?.scheduleConfig?.matchMinutes;
          const rendered = renderHistoryBoard({
            board,
            historical: pack.historicalAssignment ?? [],
            divisionRef: ref,
            matchMinutes: typeof declaredMinutes === "number" ? declaredMinutes : 60,
          });
          historyBoard = rendered.board;
          // Unmatched rows are reported, never dropped: a history row naming a
          // court or fixture the board does not carry is judged by nothing, and
          // a certificate that quietly skipped it would read as FEASIBLE.
          if (rendered.unmatched.length > 0) {
            scheduleErrors.push(
              `certificate: ${ref} history has ${rendered.unmatched.length} unmatched row(s): ` +
                `${rendered.unmatched.slice(0, 5).join("; ")}`,
            );
          }
        }
        try {
          certificate = certify({
            historical: pack.historicalAssignment,
            historyBoard,
            constraints,
            solverStatus: outcome.solverStatus,
            placed: metrics?.placed ?? 0,
            total: metrics?.total ?? 0,
          });
        } catch (err) {
          scheduleErrors.push(
            `certificate: ${err instanceof Error ? err.message : String(err)}`,
          );
        }
        if (metrics !== undefined) {
          const proposalUnplaced = metrics.total - metrics.placed;
          if (proposalUnplaced !== outcome.unplacedCount) {
            warnings.push(
              `${suiteKey}: "${ref}" — the solver's PROPOSAL reports ${proposalUnplaced} unplaced ` +
                `(${metrics.placed}/${metrics.total}) while the FETCHED board shows ${outcome.unplacedCount}. ` +
                "Both are reported; neither is derived from the other. The board's count is the run's own " +
                "gate, the proposal's is the feasibility certificate's, and a disagreement means apply and " +
                "auto did not end up describing the same board.",
            );
          }
        }
      }

      const verdict =
        checker !== undefined && certificate !== undefined
          ? judgeDivision({
              divisionRef: ref,
              blockingCount: outcome.blockingCount,
              checker,
              certificate,
              unplacedCount: outcome.unplacedCount,
              scheduleErrors,
            })
          : degradedVerdict(ref, scheduleErrors, board, constraints);

      for (const reason of verdict.reasons) errors.push(reason);

      scheduling.push({
        divisionRef: ref,
        requestedEngine: outcome.requestedEngine,
        ...(outcome.actualEngine === undefined ? {} : { actualEngine: outcome.actualEngine }),
        ...(outcome.solverStatus === undefined ? {} : { solverStatus: outcome.solverStatus }),
        ...(outcome.notSearchedReason === undefined
          ? {}
          : { notSearchedReason: outcome.notSearchedReason }),
        ...(outcome.mode === undefined ? {} : { mode: outcome.mode }),
        ...(outcome.budgetExpired === undefined ? {} : { budgetExpired: outcome.budgetExpired }),
        ...(outcome.tiersCompleted === undefined ? {} : { tiersCompleted: outcome.tiersCompleted }),
        ...(outcome.tiersTotal === undefined ? {} : { tiersTotal: outcome.tiersTotal }),
        ...(outcome.metrics === undefined ? {} : { metrics: outcome.metrics }),
        ...(metricsNote === undefined ? {} : { metricsNote }),
        blockingCount: outcome.blockingCount,
        warnKindTally: outcome.warnKindTally,
        unplacedCount: outcome.unplacedCount,
        wallMs: outcome.wallMs,
        scheduleErrors,
        ...(checker === undefined
          ? {}
          : {
              checker: {
                clean: checker.clean,
                findings: checker.findings,
                unchecked: checker.unchecked,
                unexercised: checker.unexercised,
              },
            }),
        ...(certificate === undefined
          ? {}
          : {
              certificate: {
                branch: certificate.branch,
                reason: certificate.reason,
                red: certificate.red,
                violations: certificate.violations,
              },
            }),
        ...(believability === undefined ? {} : { believability }),
        red: verdict.red,
        reasons: verdict.reasons,
      });

      engineSnapshotDivisions.push({
        divisionRef: ref,
        // T7d: THIS division's own resolved engine — the engine is resolved
        // PER DIVISION, so this is what makes a leg whose divisions disagreed
        // legible even though the leg-level `engine` field below cannot state
        // a single value for it.
        ...(outcome.actualEngine === undefined ? {} : { actualEngine: outcome.actualEngine }),
        ...(outcome.metrics === undefined ? {} : { metrics: outcome.metrics }),
        ...(outcome.solverStatus === undefined ? {} : { solverStatus: outcome.solverStatus }),
        ...(outcome.notSearchedReason === undefined
          ? {}
          : { notSearchedReason: outcome.notSearchedReason }),
        ...(outcome.mode === undefined ? {} : { mode: outcome.mode }),
        ...(outcome.budgetExpired === undefined ? {} : { budgetExpired: outcome.budgetExpired }),
        ...(outcome.tiersCompleted === undefined ? {} : { tiersCompleted: outcome.tiersCompleted }),
        ...(outcome.tiersTotal === undefined ? {} : { tiersTotal: outcome.tiersTotal }),
        blockingCount: outcome.blockingCount,
        unplacedCount: outcome.unplacedCount,
        wallMs: outcome.wallMs,
        verdict: { red: verdict.red, reasons: verdict.reasons },
      });

      // The prompt's acceptance line, one event per division. `division` is
      // the one field beyond that list, and it is not optional: without it a
      // multi-division run emits N identical-looking rows nothing can
      // attribute.
      log.info(
        {
          division: ref,
          engine: outcome.actualEngine,
          status: outcome.solverStatus,
          ms: outcome.wallMs,
          conflicts: outcome.blockingCount,
          checker: checker === undefined ? "not run" : checker.clean ? "clean" : `${checker.findings.length} finding(s)`,
          certificate: certificate === undefined ? "not run" : certificate.branch,
        },
        "suite_scheduled",
      );
    }

    conflictCount = layer.outcomes.reduce((sum, o) => sum + o.blockingCount, 0);
    // ONE value for N divisions, so it is reported only when it is
    // unambiguous. A run whose divisions disagree about which engine answered
    // has no single engine, and picking the first would be a coin toss
    // recorded as a fact — the per-division truth is in `scheduling[]`.
    const legEngine = soleValue(layer.outcomes.map((o) => o.actualEngine));
    solver = {
      ...(legEngine === undefined ? {} : { engine: legEngine }),
      ...(soleValue(layer.outcomes.map((o) => o.solverStatus)) === undefined
        ? {}
        : { status: soleValue(layer.outcomes.map((o) => o.solverStatus)) }),
    };


    // B03 review F1(b): officials auto-assign runs HERE, strictly AFTER the
    // whole scheduling layer — never inside `seedSuite`, which completes before
    // this suite's own scheduling walk even starts. B04 moved it from between
    // `schedule/apply` and `/validate` (where the old hand-rolled walk had it)
    // to after `runScheduleLayer` returns, because that driver owns apply,
    // validate AND the board fetch as one sequence. It CANNOT move earlier
    // (see the re-check below, and B03 review F1(b)), so the board every layer
    // judged above predates whatever this assigns — which is why the checker
    // runs a second time immediately after it. `officials/auto`'s own
    // `engineInput` only considers fixtures whose `scheduled_at` is set
    // (`usecases/officials.ts:386`), so calling it any earlier always
    // proposes zero regardless of what the pack declares. `plan.officials`
    // with EMPTY `assignments` are the auto-needing ones (pack-schema.ts:
    // 768-769's own rule) — `_tiny.json`'s "off-eli" is exactly one, and
    // this is the only place a live run can actually reach it. Gated on
    // `autoAssign` (derived above from the DLS-gate probe's own plan
    // choice) — calling `/officials/auto` without the entitlement 402s.
    const autoOfficials = plan.officials.filter(
      (o) => o.assignments.length === 0,
    );
    let officialsAutoApplied = 0;
    if (autoAssign === true && autoOfficials.length > 0) {
      log.info(
        { autoOfficials: autoOfficials.length },
        `${suiteKey}: running officials auto-assign (B03 review F1(b) — after schedule/apply)`,
      );
      const autoResult = await runOfficialsAutoAssign({
        base,
        email,
        primaryDivisionId: divisionId,
        autoOfficials,
        transport: t,
      });
      officialsAutoApplied = autoResult.appliedCount;
      // The product's OWN post-apply read (`seed.ts:1092-1098` — a distinct
      // GET per touched fixture, never the apply's echoed body). Kept so the
      // re-check below judges what the product says is on the board.
      officialsByFixtureId = autoResult.fixtureOfficialsById;
      const autoPassed = autoResult.appliedCount > 0;
      oracles.push({
        name: "officials: auto-assign reaches the auto-needing official(s) after scheduling",
        passed: autoPassed,
        detail: autoPassed
          ? `${autoResult.proposedCount} proposed, ${autoResult.appliedCount} applied across ` +
            `${autoResult.fixtureOfficialsById.size} fixture(s)`
          : `officials/auto proposed 0 assignments for ${autoOfficials.length} auto-needing official(s) ` +
            `(e.g. "${autoOfficials[0].ref}") even after scheduling`,
      });
      if (!autoPassed) {
        errors.push(
          `officials auto-assign: 0 assignment(s) applied for ${autoOfficials.length} auto-needing official(s)`,
        );
      }
    }

    // F-T6-2 — RE-CHECK the board after officials auto-assign.
    //
    // `/officials/auto`'s own `engineInput` only considers fixtures whose
    // `scheduled_at` is set (`usecases/officials.ts:386`), so auto-assign
    // CANNOT move earlier than apply — B03 review F1(b) established that, and
    // it is why the whole block sits here. The consequence is that the board
    // `runScheduleLayer` fetched, and every verdict taken on it above,
    // predates whatever auto-assign puts on it: an official double-booking
    // INTRODUCED here would be seen by neither layer 1 nor design §3.3's
    // officials rule.
    //
    // So the checker runs a SECOND time, and BOTH verdicts are reported.
    // Not one: a single post-officials verdict would hide which stage
    // introduced a finding, and "the board was clean when it was scheduled and
    // dirty once the officials landed" is exactly the fact a reader needs.
    // The after-verdict GATES like the before-verdict does — it describes a
    // board that really exists.
    if (officialsAutoApplied > 0 && officialsByFixtureId.size > 0) {
      for (let i = 0; i < scheduling.length; i += 1) {
        const row = scheduling[i];
        const board = boardByRef.get(row.divisionRef);
        const constraints = constraintsByRef.get(row.divisionRef);
        if (board === undefined || constraints === undefined) continue;
        const after = checkBoard(boardWithOfficials(board, officialsByFixtureId), constraints);
        const reasons = [...row.reasons];
        if (!after.clean) {
          const kinds = [...new Set(after.findings.map((f) => f.kind))];
          const reason =
            `${row.divisionRef}: checker findings AFTER officials auto-assign = ` +
            `${after.findings.length} (${kinds.length > 0 ? kinds.join(", ") : "none named"})`;
          reasons.push(reason);
          errors.push(reason);
        }
        scheduling[i] = {
          ...row,
          checkerAfterOfficials: {
            clean: after.clean,
            findings: after.findings,
            unchecked: after.unchecked,
            unexercised: after.unexercised,
          },
          red: row.red || !after.clean,
          reasons,
        };
      }
    }

    // F-T6-3 — the RUN-LEVEL cross-division court gate.
    //
    // Runs AFTER the officials re-check so the report's ordering matches the
    // order the board was actually judged in, and over the boards
    // `runScheduleLayer` FETCHED — officials do not move a fixture, so the
    // slots are the same either way.
    crossDivisionClashes = crossDivisionCourtClashes(layer.boards);
    for (const clash of crossDivisionClashes) {
      errors.push(
        `cross-division court double-booking on ${clash.courtId}: ` +
          `${clash.a.divisionRef}/${clash.a.fixtureId} [${new Date(clash.a.start).toISOString()}..${new Date(clash.a.end).toISOString()}) ` +
          `overlaps ${clash.b.divisionRef}/${clash.b.fixtureId} [${new Date(clash.b.start).toISOString()}..${new Date(clash.b.end).toISOString()}). ` +
          "One court cannot hold two fixtures at once whichever division each belongs to, and every per-division " +
          "layer is blind to this by construction",
      );
    }

    // The engine artifact — one file per LEG (ruling R3), keyed by the
    // REQUESTED engine (T7d). Written only when the caller resolved a report
    // directory AND a run id: `bench.ts` always does, and a unit test that
    // supplies neither gets no disk write at all rather than a file under a
    // guessed path.
    //
    // T7d: this used to be keyed by `legEngine` — the derived, SOLE actual
    // engine across this leg's divisions — which is `undefined`, and so wrote
    // NOTHING, the first time a real run's divisions legitimately disagreed
    // (`d-badminton`, one fixture, proved `already_optimal` and came back
    // `greedy` while `d-tiny` in the SAME `--engine optimized` leg came back
    // `optimized`). A leg's identity is what was ASKED for, never what
    // happened to come back — `engine` (this suite's own `--engine`) is
    // always exactly one value, so it can always name the file. The
    // per-division truth that `legEngine` could not carry lives on each
    // `EngineSnapshotDivision.actualEngine` instead; the leg-level
    // `EngineSnapshot.engine` field is still set when the divisions agreed,
    // and left absent — not a coin toss — when they did not.
    if (input.reportDir !== undefined && input.runId !== undefined) {
      const snapshot: EngineSnapshot = {
        runId: input.runId,
        requestedEngine: engine,
        ...(legEngine === undefined ? {} : { engine: legEngine }),
        divisions: engineSnapshotDivisions,
      };
      const file = await writeEngineArtifact(input.reportDir, input.runId, engine, snapshot);
      log.info({ file, requestedEngine: engine, legEngine }, `${suiteKey}: engine artifact written`);
      // ONCE, after the division loop — `assessEngineDelta` is a RUN-level
      // fact (its own doc comment says so). Called per division it would be
      // emitted N times, each copy listing every OTHER division's refs in
      // `comparedDivisionRefs`; scoped to one division it would destroy the
      // run-level total design §2.1 asks for.
      engineDelta = assessEngineDelta(await readEngineArtifacts(input.reportDir, input.runId));
    } else {
      engineDelta = assessEngineDelta(undefined);
    }

    timings.scheduleMs = Math.round(performance.now() - scheduleStart);

    // B05 T2.5 (D9) — start every division this run's folds need. Gated on
    // `input.sql`, same as the player-stats baseline and both folds below —
    // every EXISTING caller that does not know about this step gets today's
    // behavior unchanged. Runs BEFORE either fold (T1's division-A
    // single-event fold, T2's division-B batch import): both write paths
    // refuse a division still "setup"/"scheduled"
    // (`usecases/scoring.ts:222` WRONG_PHASE, `usecases/event-import.ts:704`
    // 409 `import.division_not_started`), and `runScheduleLayer` above only
    // ever takes a division that far.
    if (input.sql !== undefined) {
      // EVERY streamed division, not only `division0` — `division0`'s own
      // streams AND every "other" division's (the exact same grouping T1's
      // and T2's blocks below each re-derive for their own fold) all need
      // the phase moved before either fold below can succeed.
      const streamedDivisionRefs = new Set(pack.streams.map((st) => st.divisionRef));
      const divisionsToStart: DivisionToStart[] = [];
      for (const ref of streamedDivisionRefs) {
        const id = seeded.divisionIdByRef.get(ref);
        if (id === undefined) {
          // Never silent — same discipline as the import block below's
          // identical guard for an unresolved divisionId.
          errors.push(
            `${suiteKey}: division "${ref}" declares streams but has no resolved divisionId — cannot start it`,
          );
          continue;
        }
        divisionsToStart.push({ divisionRef: ref, divisionId: id });
      }
      if (divisionsToStart.length > 0) {
        log.info(
          { divisions: divisionsToStart.map((d) => d.divisionRef) },
          `${suiteKey}: starting the division(s) the folds below need (B05 T2.5, D9)`,
        );
        const startLayer = await runDivisionStartLayer({
          base,
          session: s,
          divisions: divisionsToStart,
          ...(input.startTransport === undefined ? {} : { transport: input.startTransport }),
        });
        divisionStart = startLayer.outcomes.map((outcome) => {
          // D9's "report both sides": what B04's OWN independent checker
          // (`scheduling[]`'s own `.checker`, populated moments earlier in
          // THIS division's own walk above) said about the SAME board —
          // populated only alongside a blocking refusal, since that is the
          // one case D9 asks the two to be compared.
          const schedRow = scheduling.find((r) => r.divisionRef === outcome.divisionRef);
          return {
            divisionRef: outcome.divisionRef,
            acknowledgedWarnings: outcome.acknowledgedWarnings,
            warnings: outcome.warnings.map(toDivisionStartConflictReport),
            ...(outcome.blockingConflicts === undefined
              ? {}
              : {
                  blockingConflicts: outcome.blockingConflicts.map(toDivisionStartConflictReport),
                  // T2.5 review MINOR: an absent `schedRow.checker` (the
                  // board fetch itself failed earlier in this division's own
                  // walk) is reported EXPLICITLY as "nothing to compare",
                  // never left to read the same as "the checker said clean" —
                  // D9's "report both sides" needs a THIRD, honest state
                  // between "clean" and "found something".
                  ...(schedRow?.checker === undefined
                    ? { checkerUnavailable: true as const }
                    : {
                        checkerClean: schedRow.checker.clean,
                        checkerFindingCount: schedRow.checker.findings.length,
                      }),
                }),
            ...(outcome.confirmedStatus === undefined ? {} : { confirmedStatus: outcome.confirmedStatus }),
            started: outcome.started,
          };
        });
        for (const outcome of startLayer.outcomes) {
          // `errors`, never `warnings`: D9's blocking/unrecognized/re-read
          // refusals are all product disagreements or bugs, matching the
          // "a refusal is a FINDING, reported and never silently retried"
          // convention both folds below already follow.
          for (const err of outcome.errors) errors.push(`start: ${err}`);
          log.info(
            {
              division: outcome.divisionRef,
              acknowledgedWarnings: outcome.acknowledgedWarnings,
              warningCount: outcome.warnings.length,
              blockingConflictCount: outcome.blockingConflicts?.length,
              confirmedStatus: outcome.confirmedStatus,
              started: outcome.started,
            },
            "suite_division_started",
          );
        }
      }
    }

    // B03 T6b: the player-stats baseline. Gated on `input.sql` — it needs
    // the org-authenticated routes' `stats.player` entitlement (derived
    // above from the SAME provisioned-plan read the DLS-gate probe made)
    // and `competitionVisibility` (threaded into `seedSuite` above, only
    // under this same condition). See `lib/stats.ts`'s header comment for
    // exactly what this can and cannot prove against an unscored division.
    if (input.sql !== undefined) {
      const personsByRef = new Map(plan.persons.map((p) => [p.ref, p]));
      const roster: RosterMemberRef[] = [];
      const seenPersonRefs = new Set<string>();
      for (const e of plan.entrants) {
        if (e.divisionRef !== division0.ref) continue;
        for (const m of e.members) {
          if (seenPersonRefs.has(m.personRef)) continue;
          const person = personsByRef.get(m.personRef);
          // Player-lane only — "player stats" is what these three routes
          // answer; a rostered coach/staff member (S3 ruling 3) earns no
          // leaderboard row even once a fold exists.
          if (person === undefined || person.lane !== "player") continue;
          const personId = seeded.personIdByRef.get(m.personRef);
          if (personId === undefined) continue;
          seenPersonRefs.add(m.personRef);
          roster.push({
            personRef: m.personRef,
            personId,
            full_name: person.full_name,
          });
        }
      }
      if (!statsPlayerGranted) {
        warnings.push(
          `${suiteKey}: player-stats baseline skipped — the entitlement-gate probe's own plan does not grant stats.player`,
        );
      } else {
        log.info(
          { roster: roster.length },
          `${suiteKey}: reading the player-stats baseline (B03 T6b)`,
        );
        const baseline = await readPlayerStatsBaseline({
          base,
          email,
          orgId,
          divisionId,
          roster,
          ...(plan.competition.slug === undefined
            ? {}
            : { competitionSlug: plan.competition.slug }),
          transport: t,
        });
        const issues = playerStatsBaselineIssues(baseline, roster);
        oracles.push({
          name: "player-stats: baseline",
          passed: issues.length === 0,
          detail:
            issues.length === 0
              ? `${roster.length} roster read(s), ${baseline.divisionStats.rows.length} division row(s), ` +
                `${baseline.publicDivisionStats?.rows.length ?? 0} public row(s) — empty rows is the correct ` +
                `baseline (B03 folds no score events; see lib/stats.ts's header comment)`
              : issues.join("; "),
        });
        for (const issue of issues)
          errors.push(`player-stats baseline: ${issue}`);
      }
    }

    // B05 T5b-3 — the DISCIPLINE CARRY (bench spec section 8), wired against
    // `expected.suspensions` through `oracle.ts`'s `compareSuspensions`.
    // That block carried ZERO rows until this task, so its oracle was a
    // silence: nothing compared, nothing able to fail.
    //
    // POSITION IS LOAD-BEARING. This runs BEFORE the folds below, not beside
    // the other oracles after them, because `putLineup`
    // (`usecases/fixtures.ts:333-335`) refuses any fixture whose status has
    // left `scheduled` — "lineup is locked once a fixture is decided". Once
    // T1/T2 have folded, no team sheet can be written at all.
    //
    // Read `compareSuspensions`'s header in oracle.ts for how a suspension
    // actually comes about here. T5b-3 measured the enforcement question
    // rather than answering it (the product had not decided); B05 answered it,
    // so the probe below is an ORACLE now — 422 SUSPENDED_PLAYER for the
    // banned player, acceptance for the eligible team-mate, both sides on the
    // same sheet.
    //
    // Gated on `input.sql !== undefined`, like every other B05 step.
    if (input.sql !== undefined) {
      if (pack.expected.suspensions.length === 0) {
        // An EMPTY expected set is not a passing oracle — the same discipline
        // T5b-2's career block states. A green "discipline carry" line for a
        // pack that declares no ban is exactly the vacuity this wave removes.
        //
        // B05 review round 1, MAJOR 2: the PACK declared nothing here, so the
        // zero-subject rule (report.ts, beside `OracleVerdict`) says
        // `no_subject` — counted, never red, never readable as a pass. It used
        // to be a warning and NOTHING else, which left a skipped comparator
        // indistinguishable from one nobody ever wrote, both in
        // `report.oracles` and on the `oracle_checked` stream.
        warnings.push(
          `oracle: pack declares no expected.suspensions rows — the discipline-carry oracle ` +
            `(compareSuspensions) has no subject and was NOT run`,
        );
        oracles.push({
          name: `oracle: discipline carry`,
          passed: true,
          verdict: "no_subject",
          subject: false,
          detail:
            `the pack declares no expected.suspensions rows — the discipline-carry oracle ` +
            `(compareSuspensions) has NO SUBJECT and compared nothing`,
        });
        log.info(oracleLogFields("suspension_carry", "no_subject"), "oracle_checked");
      } else {
        for (const sus of pack.expected.suspensions) {
          const susDivisionId = seeded.divisionIdByRef.get(sus.divisionRef);
          const bannedPersonId = seeded.personIdByRef.get(sus.person);
          if (susDivisionId === undefined || bannedPersonId === undefined) {
            errors.push(
              `oracle: expected.suspensions names division "${sus.divisionRef}" / person "${sus.person}" ` +
                `and one of them has no resolved id`,
            );
            continue;
          }
          // The entrant is DERIVED from the pack's own rosters, never named
          // by `expected.suspensions` — a second declaration of the same fact
          // could disagree with the roster and still pass.
          const bannedEntrant = pack.entrants.find(
            (e) => e.divisionRef === sus.divisionRef && e.roster.some((m) => m.person === sus.person),
          );
          if (bannedEntrant === undefined) {
            errors.push(
              `oracle: expected.suspensions names person "${sus.person}", who is on no entrant of ` +
                `division "${sus.divisionRef}" — there is nothing to ban them from`,
            );
            continue;
          }
          // The POSITIVE half's subject: a team-mate on the SAME entrant that
          // no expected.suspensions row bans. Without one, "was she refused?"
          // is satisfied by a product that refuses everybody.
          const bannedRefs = new Set(
            pack.expected.suspensions
              .filter((other) => other.divisionRef === sus.divisionRef)
              .map((other) => other.person),
          );
          const controlRef = bannedEntrant.roster
            .map((m) => m.person)
            .find((ref) => !bannedRefs.has(ref));
          const controlPersonId = controlRef === undefined ? undefined : seeded.personIdByRef.get(controlRef);
          const susEntrantId = seeded.entrantIdByRef.get(bannedEntrant.ref);
          if (controlRef === undefined || controlPersonId === undefined || susEntrantId === undefined) {
            errors.push(
              `oracle: entrant "${bannedEntrant.ref}" cannot carry a two-sided discipline check — ` +
                `${controlRef === undefined ? "every one of its members is banned, so there is no ELIGIBLE control" : "an id never resolved"}`,
            );
            continue;
          }
          const controlPerson = pack.persons?.find((pp) => pp.ref === controlRef);

          // Every fixture this entrant is a side of, split by the pack's own
          // verdict. `missed` is what `expected.suspensions` names; `played`
          // is the REST, and it is the fixture-identity discriminator — a ban
          // from every fixture also satisfies "absent from the named one".
          const missedKeys = new Set<string>(sus.missesFixtureExtKeys);
          const entrantStreams = pack.streams.filter(
            (st) =>
              st.divisionRef === sus.divisionRef &&
              (st.home === bannedEntrant.ref || st.away === bannedEntrant.ref),
          );
          const unresolvedFixtures: string[] = [];
          const targets: { extKey: string; fixtureId: string; missed: boolean }[] = [];
          for (const st of entrantStreams) {
            const fid = seeded.fixtureIdByKey.get(fixtureKey(sus.divisionRef, st.fixtureExtKey));
            if (fid === undefined) {
              unresolvedFixtures.push(st.fixtureExtKey);
              continue;
            }
            targets.push({ extKey: st.fixtureExtKey, fixtureId: fid, missed: missedKeys.has(st.fixtureExtKey) });
          }
          if (unresolvedFixtures.length > 0) {
            errors.push(
              `oracle: discipline carry for "${sus.person}" could not resolve fixture id(s) ` +
                `${unresolvedFixtures.join(", ")} in division "${sus.divisionRef}"`,
            );
            continue;
          }

          // A local write, used twice below: the PLAYED sheets go in before the
          // ban exists, the MISSED ones after it. The read-BACK is deliberately
          // NOT here — it is one pass at the end, so every sheet is read at the
          // SAME moment, after every write and after the ban is confirmed. A
          // read taken beside its own write would sample the played sheets
          // before the ban existed at all, and a ban that then reached too far
          // would be invisible to `absentOnPlayed`.
          const writtenTargets: { extKey: string; fixtureId: string; missed: boolean }[] = [];
          const writeFailures: string[] = [];
          const writeSheet = async (
            target: { extKey: string; fixtureId: string; missed: boolean },
            wanted: readonly string[],
          ): Promise<boolean> => {
            const written = await putFixtureLineup(
              base,
              s,
              target.fixtureId,
              susEntrantId,
              wanted,
              input.oracleTransport,
            );
            if (written.status >= 400) {
              writeFailures.push(
                `${target.extKey}: HTTP ${written.status}${written.code === undefined ? "" : ` ${written.code}`}`,
              );
              return false;
            }
            if (!writtenTargets.some((t) => t.fixtureId === target.fixtureId)) writtenTargets.push(target);
            return true;
          };

          // (1) The PLAYED sheets — the fixtures the pack does NOT say this
          // person misses — written BEFORE the ban exists.
          //
          // THE ORDER IS THE PRODUCT'S, not a convenience. A ban names no
          // fixtures: `suspensions` carries no fixture list and no date range,
          // so while a row is `active` the lineup gate refuses that person on
          // EVERY fixture of the division, the ones this pack says they play
          // included. Writing these after the confirm would be asking the
          // product to contradict the gate, and the honest sequence is a real
          // season anyway — the organiser names a squad, a ban lands, and the
          // sheets for the fixtures the player misses get redone.
          for (const target of targets.filter((t) => !t.missed)) {
            await writeSheet(target, [controlPersonId, bannedPersonId]);
          }

          // (2) The PRODUCER, through the product's own two calls. A row this
          // bench wrote in SQL would prove the fixture, not the product.
          const pending = await createManualSuspension(
            base,
            s,
            susDivisionId,
            {
              personId: bannedPersonId,
              // DERIVED, never declared: the ban is exactly as long as the
              // list of fixtures the pack says are missed.
              matchesTotal: sus.missesFixtureExtKeys.length,
              reason: sus.reason ?? `bench discipline carry: ${sus.person}`,
            },
            input.oracleTransport,
          );
          const confirmed = await confirmSuspension(base, s, pending.id, input.oracleTransport);

          // (3) The ENFORCEMENT ORACLE. Until B05 this was a WARNING: it
          // reported the live HTTP status and asserted neither answer, because
          // the product had not decided whether discipline was advisory. It
          // has decided — `putLineup` reads `suspensions` and refuses an
          // `active` ban with 422 SUSPENDED_PLAYER — so the measurement is an
          // assertion now, and the bench PROVES the gate instead of
          // describing it.
          //
          // BOTH directions, on the SAME fixture and the SAME entrant. A
          // product that refuses every team sheet satisfies the negative half
          // on its own, which is why the eligible team-mate's acceptance is
          // asserted here rather than left to the sheets loop below.
          // ZERO-SUBJECT RULE (report.ts): this REDS rather than reporting
          // `no_subject` — the pack declared this suspension, so a run with no
          // missed fixture to refuse a sheet for is a missing answer, not an
          // absent question.
          const probeFixture = targets.find((f) => f.missed);
          if (probeFixture === undefined) {
            errors.push(
              `oracle: discipline carry for "${sus.person}" resolved no MISSED fixture — the ` +
                `enforcement assertion has no subject to refuse a team sheet for`,
            );
          } else {
            const refusal = await putFixtureLineup(
              base,
              s,
              probeFixture.fixtureId,
              susEntrantId,
              [controlPersonId, bannedPersonId],
              input.oracleTransport,
            );
            const refused = refusal.status === 422 && refusal.code === "SUSPENDED_PLAYER";
            // The POSITIVE half doubles as this fixture's real team sheet:
            // `putLineup` REPLACES an entrant's whole lineup, so this write is
            // the stored state the comparison below reads back.
            const accepted = await writeSheet(probeFixture, [controlPersonId]);
            const enforced = refused && accepted;
            oracles.push({
              name: `oracle: ${sus.divisionRef} discipline enforced at the team sheet (${sus.person})`,
              passed: enforced,
              detail: enforced
                ? `naming the ACTIVE-suspended "${sus.person}" on "${probeFixture.extKey}" was REFUSED ` +
                  `with 422 SUSPENDED_PLAYER, and the ELIGIBLE team-mate "${controlRef}" alone was ` +
                  `ACCEPTED on that same sheet — the gate refuses the banned player, not everybody`
                : [
                    refused
                      ? undefined
                      : `the banned player was NOT refused: HTTP ${refusal.status}` +
                        `${refusal.code === undefined ? "" : ` ${refusal.code}`} (expected 422 SUSPENDED_PLAYER)`,
                    accepted
                      ? undefined
                      : `the ELIGIBLE team-mate "${controlRef}" was refused too — the gate is refusing everybody`,
                  ]
                    .filter((x): x is string => x !== undefined)
                    .join("; "),
            });
            log.info(
              { ...oracleLogFields("discipline_enforced", enforced ? "pass" : "fail"), division: sus.divisionRef },
              "oracle_checked",
            );
            if (!enforced) {
              errors.push(
                `oracle: ${sus.divisionRef}: the lineup gate did not enforce "${sus.person}"'s ACTIVE ban on ` +
                  `"${probeFixture.extKey}" — banned player HTTP ${refusal.status}` +
                  `${refusal.code === undefined ? "" : ` ${refusal.code}`}, eligible team-mate ` +
                  `${accepted ? "accepted" : "REFUSED"}`,
              );
            }
          }

          // (4) Every remaining MISSED sheet (the probe wrote the first one):
          // the banned player OFF the fixtures the pack names, the eligible
          // team-mate on all of them. The PLAYED sheets went in at (1).
          for (const target of targets) {
            if (!target.missed || target.fixtureId === probeFixture?.fixtureId) continue;
            await writeSheet(target, [controlPersonId]);
          }

          // (5) The read-BACK, never the PUTs' own echoes, and all of it AFTER
          // every write: the stored state as it stands at comparison time is
          // what the oracle compares.
          const sheets: SuspensionFixtureSheet[] = [];
          for (const target of writtenTargets) {
            const lineup = await fetchFixtureLineup(
              base,
              s,
              target.fixtureId,
              susEntrantId,
              input.oracleTransport,
            );
            sheets.push({
              fixtureExtKey: target.extKey,
              fixtureId: target.fixtureId,
              missed: target.missed,
              lineup,
            });
          }
          if (writeFailures.length > 0) {
            errors.push(
              `oracle: discipline carry for "${sus.person}" could not write the team sheet(s) it compares — ` +
                `${writeFailures.join("; ")}`,
            );
          }

          // (6) The comparison, against the product's own active-ban list.
          const active = await fetchActiveSuspensions(base, s, susDivisionId, input.oracleTransport);
          const expectedSuspensions: ExpectedSuspension[] = [
            {
              personId: bannedPersonId,
              personName: pack.persons?.find((pp) => pp.ref === sus.person)?.fullName ?? sus.person,
              divisionId: susDivisionId,
              entrantId: susEntrantId,
              matchesTotal: sus.missesFixtureExtKeys.length,
              controlPersonId,
              controlPersonName: controlPerson?.fullName ?? controlRef,
            },
          ];
          const susCheck = compareSuspensions(expectedSuspensions, { active, sheets });
          const entry = susCheck.entries[0];
          oracles.push({
            name: `oracle: ${sus.divisionRef} discipline carry (${sus.person})`,
            passed: susCheck.matched,
            detail: susCheck.matched
              ? `the ban confirmed through POST /divisions/{id}/suspensions + PATCH {kind:"confirm"} is ACTIVE ` +
                `over ${confirmed.matchesTotal} match(es), stamped on entrant "${bannedEntrant.ref}", and "${sus.person}" ` +
                `is off the team sheet of ${sus.missesFixtureExtKeys.join(", ")} while still on ` +
                `${entry?.playedFixturesChecked ?? 0} fixture(s) the pack does NOT name — and the ELIGIBLE ` +
                `team-mate "${controlRef}" holds no ban and is on all ${sheets.length} sheet(s)`
              : entry === undefined
                ? `compareSuspensions returned no entry for "${sus.person}" — the expected list resolved empty`
                : suspensionMismatchReasons(entry).join("; "),
          });
          log.info(
            { ...oracleLogFields("suspension_carry", susCheck.matched ? "pass" : "fail"), division: sus.divisionRef },
            "oracle_checked",
          );
          if (!susCheck.matched) {
            errors.push(
              `oracle: ${sus.divisionRef}: the live discipline state disagrees with the pack's ` +
                `expected.suspensions row for "${sus.person}" — ` +
                `${entry === undefined ? "no comparison entry" : suspensionMismatchReasons(entry).join("; ")}`,
            );
          }
        }
      }
    }

    // B05 T1/T2 + B07a T7 — the write-path fold: ONE loop over the plan's
    // divisions, dispatching on the play mode the suite declared for each
    // (design doc §3 D4).
    //
    // This replaces two hard-coded blocks — a single-event fold for
    // `division0` and a batch-import fold for "every OTHER division". That
    // split was positional and implicit, so a pack had no way to say how any
    // of its divisions should be played. `playModeFor` answers that now, and
    // its DEFAULT reproduces the positional split VERBATIM, so `_tiny`
    // (`d-tiny` single-POSTs, the rest import) and suite 11 (`d-worlds`
    // single-POSTs, `d-womens` imports) are unchanged — which matters,
    // because `_RULES.md` §3 keeps one suite on the single-POST path and the
    // import path needs a live subject of its own. A mode that silently moved
    // either would delete coverage while appearing to add some.
    //
    // Gated on `input.sql`, and ordered AFTER the player-stats baseline above
    // on purpose: that baseline's own oracle asserts EMPTY rows ("B03 folds
    // no score events") and would go stale the moment real events landed on a
    // division's fixtures, so folding first would silently turn a correct
    // baseline oracle into a wrong one for every future `input.sql` caller.
    //
    // FIRST STAGE ONLY, for every division (B07a T6's scoping, now applied
    // uniformly rather than to the non-first divisions alone). A later stage's
    // fixtures are placeholders with no real entrants until that division's
    // own advance seeds them, so folding their streams here would post into
    // fixtures nobody has seeded yet. Each later stage's streams are played by
    // the advance step below, which dispatches on the SAME mode — a division
    // plays every one of its stages the one way it declared (ruling R23).
    // -----------------------------------------------------------------
    // B07a T10 — play one division's streams by TAPPING the real pad: the
    // organiser taps the device hand-over and mints a link, a scorer on a
    // phone-sized page plays the match through it, and the organiser signs it
    // off. Called by BOTH dispatch sites below (the first-stage fold and the
    // advance step), because a division plays every stage the one way it
    // declared (ruling R23).
    //
    // Judged on what the PRODUCT says afterwards, never on the driver's word:
    // every tapped fixture must read `finalized` on a fresh board read — a
    // separate oracle, because the per-match oracle's `SETTLED_STATUSES`
    // accepts `decided` for every other path and has to keep doing so.
    const playDivisionByTaps = async (
      division: SeedPlanDivision,
      streams: readonly Pack["streams"][number][],
    ): Promise<void> => {
      const keys = streams.map((st) => st.fixtureExtKey);
      // R55 — never a silent skip, and never counted in `tapPlay`: a plan
      // without device links means no scorer can be handed anything.
      if (!deviceLinksGranted) {
        const message =
          `${suiteKey}: WARNING — division "${division.ref}" declares play "tap", but this run's plan does not grant ` +
          `scoring.device_links (deviceLinksGranted false), so no scorer can be handed a device link — tap fixtures ` +
          `NOT played: ${keys.join(", ")} (not counted in tapPlay)`;
        warnings.push(message);
        log.warn({ division: division.ref, fixtures: keys, unsatisfiedCapability: "scoring.device_links" }, message);
        return;
      }
      const notPlayed = `fixtures not played: ${keys.join(", ")}`;
      const divisionId = seeded.divisionIdByRef.get(division.ref);
      const packDivision = pack.divisions.find((d) => d.ref === division.ref);
      if (divisionId === undefined || packDivision === undefined) {
        errors.push(`tap: division "${division.ref}" has no resolved divisionId — cannot open its console (${notPlayed})`);
        return;
      }
      // R45 — the cap is the division's REAL court count: the courts the
      // scheduling layer resolved and PUT to the product for this division
      // (`EncodedConstraints.courtIds`), never a typed number.
      const courtCount = constraintsByRef.get(division.ref)?.courtIds.length ?? 0;
      if (courtCount < 1) {
        errors.push(
          `tap: division "${division.ref}" has no courts in its schedule constraints — tapped matches run at most one ` +
            `per court at once, and there is no court count to derive that cap from (${notPlayed})`,
        );
        return;
      }
      const adapter = adapterForSport(packDivision.sportKey);
      if (adapter === undefined) {
        errors.push(`tap: no tap adapter exists for sport "${packDivision.sportKey}" (division "${division.ref}"; ${notPlayed})`);
        return;
      }
      let cfg: unknown;
      let orgSlug: string;
      let competitionSlug: unknown;
      let divisionSlug: unknown;
      let board: readonly TapBoardRow[];
      try {
        const resolved = resolveDivisionCfg(
          bootRegistry().get(packDivision.sportKey, packDivision.moduleVersion),
          packDivision,
        );
        if (!resolved.ok) throw new Error(`its cfg could not be resolved (${resolved.reason})`);
        cfg = resolved.cfg;
        // Every console URL segment is the SERVER's value — see
        // `resolveOrgSlug`'s own doc for what a pack slug does here.
        const resolveOrgSlug =
          input.resolveOrgSlug ??
          (async (id: string) => {
            if (input.sql === undefined) throw new Error("no PlanSql seam to read the server-assigned org slug from");
            return input.sql.getOrgSlug(id);
          });
        orgSlug = await resolveOrgSlug(orgId);
        competitionSlug = (await t.request<{ slug?: unknown }>(base, s, `/api/v1/competitions/${seeded.competitionId}`))?.slug;
        divisionSlug = (await t.request<{ slug?: unknown }>(base, s, `/api/v1/divisions/${divisionId}`))?.slug;
        board = tapBoardRowsOf(await fetchDivisionFixtures(base, s, divisionId, input.oracleTransport));
      } catch (err) {
        errors.push(
          `tap: division "${division.ref}" could not be prepared for tap play — ` +
            `${err instanceof Error ? err.message : String(err)} (${notPlayed})`,
        );
        return;
      }
      if (typeof competitionSlug !== "string" || typeof divisionSlug !== "string") {
        errors.push(`tap: the competition or division read carried no slug — cannot address "${division.ref}"'s console (${notPlayed})`);
        return;
      }

      const refIdByKey = new Map<string, string>([...seeded.entrantIdByRef, ...seeded.personIdByRef]);
      const jobsByRound = new Map<number, TapFixtureJob[]>();
      for (const st of streams) {
        const fixtureId = seeded.fixtureIdByKey.get(fixtureKey(division.ref, st.fixtureExtKey));
        const row = fixtureId === undefined ? undefined : board.find((r) => r.id === fixtureId);
        if (fixtureId === undefined || row === undefined || row.fixtureNo === null) {
          errors.push(
            `tap: ${division.ref}/${st.fixtureExtKey} is not on the division's board with a fixture_no — its console ` +
              "cannot be addressed, so it was not played",
          );
          continue;
        }
        // Fix round 2 (R62) — the team sheets are SETUP, written through the
        // real lineups API with the organiser session before any scorer is
        // handed the fixture: player-attributed pad scoring needs a saved
        // lineup. Built from each side's own seeded members; a pack event
        // naming a non-member, or a refused sheet, is a finding that reds.
        const lineupFindings = [
          ...personOutsideByEntrantFindings(pack, st),
          ...(await saveTapLineups({
            base,
            session: s,
            fixtureId,
            sides: tapLineupSides(pack, st),
            entrantIdByRef: seeded.entrantIdByRef,
            personIdByRef: seeded.personIdByRef,
            transport: input.oracleTransport,
          })),
        ];
        for (const finding of lineupFindings) errors.push(`tap: ${division.ref}/${st.fixtureExtKey}: ${finding}`);
        // The round comes off the REAL board, same reasoning as the api
        // branch's dependency waves. A board row with no round sorts last.
        const round = row.roundNo ?? Number.MAX_SAFE_INTEGER;
        const jobs = jobsByRound.get(round) ?? [];
        jobs.push({
          divisionRef: division.ref,
          fixtureExtKey: st.fixtureExtKey,
          fixtureId,
          consolePath: consoleFixturePath({ orgSlug, competitionSlug, divisionSlug, fixtureNo: row.fixtureNo }),
          stream: st,
          adapter,
          cfg,
          refIdByKey,
        });
        jobsByRound.set(round, jobs);
      }
      if (jobsByRound.size === 0) return;

      let player: TapPlayer;
      try {
        player =
          tapState.player ??
          (tapState.player = await (input.tapPlayer ?? browserTapPlayer)({
            base,
            session: s,
            email,
            ledger: defaultLedgerTransport,
          }));
      } catch (err) {
        errors.push(`tap: the tap player could not start — ${err instanceof Error ? err.message : String(err)} (${notPlayed})`);
        return;
      }

      const rounds = [...jobsByRound.entries()].sort((a, b) => a[0] - b[0]).map(([, jobs]) => jobs);
      log.info(
        { division: division.ref, fixtures: keys.length, rounds: rounds.length, courts: courtCount },
        `${suiteKey}: playing a division's streams by tapping the real pad (B07a T10)`,
      );
      const blockStart = performance.now();
      const played = await playTapRounds(rounds, courtCount, async (job) => {
        try {
          return { job, result: await player.playFixture(job) };
        } catch (err) {
          // `playFixture` promises never to reject; this keeps that promise
          // for it rather than letting one match abort a round.
          const detail = err instanceof Error ? err.message : String(err);
          return {
            job,
            result: { fixtureId: job.fixtureId, taps: 0, wallMs: 0, findings: [`player: unexpected failure — ${detail}`], observations: [] },
          };
        }
      });
      const blockMs = Math.round(performance.now() - blockStart);

      // Driver findings RED the gate; observations are reported, never gated.
      for (const { job, result } of played) {
        tapPlayedFixtureIds.add(job.fixtureId);
        for (const finding of result.findings) errors.push(`tap: ${division.ref}/${job.fixtureExtKey}: ${finding}`);
        for (const observation of result.observations) {
          log.info({ division: division.ref, fixture: job.fixtureExtKey, observation }, "tap_observation");
        }
        log.info(
          {
            division: division.ref,
            fixture: job.fixtureExtKey,
            taps: result.taps,
            wallMs: result.wallMs,
            findings: result.findings.length,
            observations: result.observations.length,
          },
          "tap_fixture_played",
        );
      }

      // The sign-off check: a FRESH board read, after every match of this
      // block was played.
      let after: readonly TapBoardRow[] = [];
      try {
        after = tapBoardRowsOf(await fetchDivisionFixtures(base, s, divisionId, input.oracleTransport));
      } catch (err) {
        errors.push(
          `tap: could not re-read "${division.ref}"'s board to check its tapped fixtures were finalized — ` +
            `${err instanceof Error ? err.message : String(err)}`,
        );
      }
      for (const { job } of played) {
        const status = after.find((r) => r.id === job.fixtureId)?.status ?? "(absent)";
        const passed = status === "finalized";
        oracles.push({
          name: `tap: ${division.ref}/${job.fixtureExtKey} finalized`,
          passed,
          // Worded for what was OBSERVED — the status once tap play ended —
          // never "after the sign-off": the first live run stopped every match
          // on an adapter finding before the organiser was ever asked to sign.
          detail: passed
            ? "the organiser's sign-off landed: the product reads the tapped fixture as finalized"
            : `the product reads "${status}" once tap play ended, not "finalized"`,
        });
        log.info(oracleLogFields("tap_fixture_finalized", passed ? "pass" : "fail"), "oracle_checked");
        if (!passed) {
          errors.push(
            `tap: ${division.ref}/${job.fixtureExtKey} reads "${status}" once tap play ended — a tapped fixture must be ` +
              `finalized by the organiser's sign-off, not left "${status}" (the per-match oracle's SETTLED_STATUSES ` +
              `accepts "decided"; this check does not)`,
          );
        }
      }

      const prev = tapState.report;
      tapState.report = {
        matches: (prev?.matches ?? 0) + played.length,
        taps: (prev?.taps ?? 0) + played.reduce((n, p) => n + p.result.taps, 0),
        wallMs: (prev?.wallMs ?? 0) + blockMs,
        observations: (prev?.observations ?? 0) + played.reduce((n, p) => n + p.result.observations.length, 0),
        // Minors batch B, row (a) (R79) — `unreadRowsAfterFinalize` was set
        // by `drivers/scorer.ts` and dropped by `tap-play.ts`'s own success
        // path, so it never reached here to be counted at all. Summed the
        // same way `observations` is, across every match this division just
        // played, folded onto whatever an earlier division's tap fold
        // already counted.
        unreadRowsAfterFinalize:
          (prev?.unreadRowsAfterFinalize ?? 0) +
          played.reduce((n, p) => n + (p.result.unreadRowsAfterFinalize ?? 0), 0),
      };
    };

    if (input.sql !== undefined) {
      // A stream whose division the PLAN does not carry is invisible to a loop
      // over `plan.divisions`, so it is NAMED here rather than silently
      // skipped — carried forward from the per-stream guard B07a T6 added, and
      // still fail-loud rather than fail-open, because scoping such a stream
      // out of the fold would report a clean run that played nothing.
      // Unreachable today (`pack-schema.ts` refuses a stream naming an unknown
      // division, and the registration filter builds a SEPARATE `seedPlan`
      // rather than narrowing `plan`), which is why it is an error rather than
      // a guard with a fallback.
      const plannedDivisionRefs = new Set(plan.divisions.map((d) => d.ref));
      for (const st of pack.streams) {
        if (plannedDivisionRefs.has(st.divisionRef)) continue;
        errors.push(
          `${suiteKey}: stream "${st.fixtureExtKey}" names division "${st.divisionRef}", which has no stage in ` +
            "the plan — cannot tell which of its streams belong to its first stage",
        );
      }

      // B07a T7 fix round 1 (I2) — a `play` key naming no planned division
      // used to fall straight through `playModeFor`'s `declared?.[divisionRef]`
      // lookup to the positional default, with nothing to say the key was
      // ever read. A misspelled division ref then turns a suite's intended
      // `tap` (or any other override) into a silent no-op behind a GREEN
      // gate — exactly the "hidden API fallback on a tapped division" Global
      // Constraint 3 forbids. Same fail-loud shape as the stream guard just
      // above: named, pushed, and the fold still runs (a typo'd key affects
      // no real division either way), so the run reports red rather than
      // clean.
      for (const key of Object.keys(opts.play ?? {})) {
        if (plannedDivisionRefs.has(key)) continue;
        errors.push(
          `${suiteKey}: play declares division "${key}", which is not a planned division — planned ` +
            `divisions: ${[...plannedDivisionRefs].join(", ")}`,
        );
      }

      // `@`-sigilled payload refs (pack-schema.ts header note 6) name EITHER
      // an entrant or a person — ONE namespace, so merging both maps is
      // exactly as authoritative as keeping them separate. Built once here
      // rather than once per fold, which is what the two blocks this replaces
      // each did separately.
      const refIdByKey = new Map<string, string>([
        ...seeded.entrantIdByRef,
        ...seeded.personIdByRef,
      ]);

      // Both report sections aggregate ACROSS divisions, so a pack that puts
      // several divisions on one path publishes one honest total rather than
      // whichever division happened to fold last. With exactly one division
      // per path — every pack shipped today — each total is that division's
      // own, unchanged.
      const sims: SimulateResult[] = [];
      const importFindings: ImportFinding[] = [];
      let importEventsSent = 0;
      let importChunks = 0;
      let importWallMs = 0;
      let importRan = false;

      for (const [divisionIndex, division] of plan.divisions.entries()) {
        const divisionStreamsAll = pack.streams.filter((st) => st.divisionRef === division.ref);
        if (divisionStreamsAll.length === 0) continue;

        const firstStageRef = division.stages[0]?.ref;
        if (firstStageRef === undefined) {
          // Same fail-loud reasoning as the plan guard above: a division that
          // declares streams but reached here with no stage cannot have any of
          // them placed, and a silent skip would report a clean run.
          errors.push(
            `${suiteKey}: division "${division.ref}" declares streams but has no stage in the plan — cannot ` +
              "tell which of its streams belong to its first stage",
          );
          continue;
        }

        // An absent `stageRef` means "the division's ONLY stage" — the
        // convention `validate-pack.ts`'s own `resolveStage` uses. A division
        // with SEVERAL stages therefore cannot place such a stream at all, and
        // this says so rather than guessing. The two blocks being replaced
        // disagreed on precisely this point: `division0`'s dropped the stream
        // SILENTLY (it is matched by neither this fold nor the advance step's
        // explicit `stageRef` filter, so it was never played anywhere), while
        // every other division's assumed the first stage. Neither silence nor
        // a guess survives a unification, so the ambiguity is reported.
        // `validate-pack.ts` only WARNS about such a stream, so no pack in the
        // tree reaches this today.
        for (const st of divisionStreamsAll) {
          if (st.stageRef !== undefined || division.stages.length <= 1) continue;
          errors.push(
            `${suiteKey}: stream "${st.fixtureExtKey}" names division "${division.ref}" with no stage, but that ` +
              `division declares ${division.stages.length} stages — an absent stageRef means a division's ONLY ` +
              "stage, so there is no way to tell whether this stream belongs to the stage being folded",
          );
        }

        const divisionStreams = divisionStreamsAll.filter((st) =>
          st.stageRef === undefined ? division.stages.length === 1 : st.stageRef === firstStageRef,
        );
        if (divisionStreams.length === 0) continue;

        // THE DISPATCH, exhaustive over all three modes. `tap` is played by
        // tapping the real pad (B07a T10) and never falls back to either write
        // path: a tapped division that cannot be played says so, loudly.
        const mode = playModeFor(opts, division.ref, divisionIndex);

        if (mode === "tap") {
          await playDivisionByTaps(division, divisionStreams);
        } else if (mode === "api") {
          // B06b — fold in DEPENDENCY WAVES, not one flat `Promise.all`. A
          // bracket fixture's entrants are written by its feeders' decisions,
          // so posting round 2 concurrently with round 1 refuses every later
          // round with `WRONG_PHASE — fixture has an unassigned entrant
          // (bye/TBD)`. The round comes off the REAL board rather than being
          // parsed out of the generator's `se-r{n}-i{m}` ext key: the key
          // format is the product's, and reading `round_no` keeps this correct
          // for any stage kind rather than for the ones whose keys happen to
          // encode a round.
          const roundByFixtureKey = new Map<string, number>();
          const apiDivisionId = seeded.divisionIdByRef.get(division.ref);
          if (apiDivisionId !== undefined) {
            for (const f of await fetchDivisionFixtures(base, s, apiDivisionId, input.oracleTransport)) {
              if (f.ext_key == null || f.round_no == null) continue;
              roundByFixtureKey.set(fixtureKey(division.ref, f.ext_key), f.round_no);
            }
          }
          log.info(
            { division: division.ref, streams: divisionStreams.length },
            `${suiteKey}: folding a division's streams through the single-event scoring route (B05 T1)`,
          );
          const sim = await simulateDivisionStreams({
            base,
            session: s,
            streams: divisionStreams,
            fixtureIdByKey: seeded.fixtureIdByKey,
            refIdByKey,
            roundByFixtureKey,
            ...(input.simTransport === undefined ? {} : { transport: input.simTransport }),
          });
          sims.push(sim);
          // D5: a refusal is a FINDING, reported and never silently retried —
          // and, for `_tiny`'s own real historical stream, also a genuine
          // product defect (the pack's events are meant to fold cleanly), so
          // it reds the run rather than staying a quiet report-only note.
          for (const finding of sim.findings) {
            errors.push(
              `simulate: fixture ${finding.fixtureId} (stream ${finding.streamKey}) event #${finding.eventIndex}: ` +
                `${finding.code} (HTTP ${finding.status}) — ${finding.message}`,
            );
          }
        } else {
          const importDivisionId = seeded.divisionIdByRef.get(division.ref);
          if (importDivisionId === undefined) {
            // Never silent: a division that declares streams but was never
            // seeded/scheduled is indistinguishable in a report from one the
            // import fold simply skipped.
            errors.push(
              `${suiteKey}: division "${division.ref}" declares streams but has no resolved divisionId — ` +
                "cannot fold them through the import route",
            );
            continue;
          }
          log.info(
            { division: division.ref, streams: divisionStreams.length },
            `${suiteKey}: folding a division's streams through the batch-import route (B05 T2)`,
          );
          const imp = await importDivisionStreams({
            base,
            session: s,
            divisionId: importDivisionId,
            importId: buildImportId(division.ref, input.runId),
            streams: divisionStreams,
            fixtureIdByKey: seeded.fixtureIdByKey,
            refIdByKey,
            ...(input.importTransport === undefined
              ? {}
              : { transport: input.importTransport }),
          });
          importRan = true;
          importEventsSent += imp.eventsSent;
          importChunks += imp.chunks;
          importWallMs += imp.wallMs;
          importFindings.push(...imp.findings);
          // Same D5 discipline as the single-event branch above: an
          // oversize/refusal/not-imported finding is reported and never
          // silently retried.
          for (const finding of imp.findings) {
            errors.push(`import: ${describeImportFinding(finding)}`);
          }
        }
      }

      if (sims.length > 0) {
        const simEventsSent = sims.reduce((n, x) => n + x.eventsSent, 0);
        const simWallMs = sims.reduce((n, x) => n + x.wallMs, 0);
        const simFindings = sims.flatMap((x) => [...x.findings]);
        // The SAME derivation `simulate.ts` applies to its own result
        // (simulate.ts:317), so a one-division run publishes exactly the
        // number it always did rather than a separately-rounded one.
        const simEventsPerSecond = computeEventsPerSecond(simEventsSent, simWallMs);
        timings.simMs = simWallMs;
        simulation = {
          eventsSent: simEventsSent,
          wallMs: simWallMs,
          eventsPerSecond: simEventsPerSecond,
          ...(simFindings.length > 0 ? { findings: simFindings } : {}),
        };
        log.info(
          // B05 T2 — `path` added so this event and the batch-import fold's
          // own `suite_simulated` below are distinguishable in a log stream
          // by more than which fields happen to be present.
          { events: simEventsSent, ms: simWallMs, eventsPerSecond: simEventsPerSecond, path: "single" },
          "suite_simulated",
        );
      }

      // `importRan`, never `importFindings.length` or a division count: the
      // section is written when an import call was actually MADE. A run whose
      // only import division never resolved an id has already pushed its error
      // above, and publishing `eventsSent: 0, chunks: 0` for it would read as
      // "imported nothing, cleanly" — the absent-vs-empty rule every other
      // section in this report follows.
      if (importRan) {
        const importEventsPerSecond = computeEventsPerSecond(importEventsSent, importWallMs);
        timings.importMs = importWallMs;
        importSimulation = {
          eventsSent: importEventsSent,
          wallMs: importWallMs,
          eventsPerSecond: importEventsPerSecond,
          chunks: importChunks,
          ...(importFindings.length > 0
            ? { findings: importFindings.map(toImportFindingReport) }
            : {}),
        };
        log.info(
          // Same event name as the single-event fold above, same core fields,
          // plus `path` to distinguish which write path produced this line and
          // `chunks` (meaningless for the single-event door, so absent there).
          {
            events: importEventsSent,
            ms: importWallMs,
            eventsPerSecond: importEventsPerSecond,
            chunks: importChunks,
            path: "import",
          },
          "suite_simulated",
        );
      }
    }

    // -----------------------------------------------------------------
    // B06a T9 (found by the FIRST live run) — advancement moved ABOVE the
    // outcome oracles. It used to run after them, and the per-match oracle
    // then compared `_tiny`'s playoff fixture while it was still
    // `scheduled`: `oracle: per-match mismatch in "d-tiny" fixture
    // "se-r0-i0" — status: expected decided, got scheduled`. The PRODUCT
    // was right and the bench asserted too early.
    //
    // No suite-level test could see it. Those drive `echoExpectedBoard`,
    // which answers whatever the pack expects BY CONSTRUCTION — the
    // documented vacuity of that helper, and exactly the class of gap a
    // live run exists to close.
    //
    // The rule this encodes: FOLD EVERYTHING, THEN ASSERT. Every oracle
    // below now reads a competition whose every stage has been played,
    // rather than one still mid-progression.
    // B05 T3 — stage advancement (design doc §3 D1/D7): a division's
    // progression-fed stage (a `timing:"setup"` knockout fed from the
    // preceding stage's standings, in `_tiny`'s own case) is advanced through
    // the LIVE `propose -> assert -> confirm -> generate` flow (`advance.ts`),
    // its own stream folded through the SAME `simulateDivisionStreams` T1 uses
    // above, and completed with the `finalRanks` response CAPTURED (D1 — it is
    // the only time they cross the wire; `GET /divisions/{id}/history` never
    // carries the payload).
    //
    // B07a T6 — this was gated on `division0`/`stage0`/`stage1`, so it ran for
    // the FIRST division's SECOND stage and nothing else. Every other division
    // was batch-imported with no stage step at all, which was harmless only
    // because every other division in every shipped pack happens to be
    // single-stage. The body is unchanged and now takes its division and its
    // two stages as parameters; the loop below drives it for every division.
    //
    // Minors batch B, row 28 — R23 (below) can send a LATER stage's streams
    // down this same import route, but `importEventsSent`/`importChunks`/
    // `importWallMs` above are scoped to the `if (input.sql !== undefined)`
    // block that closes before this closure is even declared, so they cannot
    // be accumulated into directly. Own accumulators here, folded into
    // `importSimulation` once every division has advanced (below the
    // `advanceDivision` loop) rather than left to sit beside it, unread — the
    // finding's exact shape: "logs `path: 'advance-import'`, but never adds
    // to `importEventsSent`, `importChunks` or `timings.importMs`".
    let advanceImportEventsSent = 0;
    let advanceImportChunks = 0;
    let advanceImportWallMs = 0;
    let advanceImportRan = false;

    const advanceDivision = async (
      division: SeedPlanDivision,
      divisionIndex: number,
      sourceStage: SeedPlanStage,
      targetStage: SeedPlanStage,
    ): Promise<void> => {
      const sourceStageId = seeded.stageIdByRef.get(sourceStage.ref);
      const targetStageId = seeded.stageIdByRef.get(targetStage.ref);
      if (sourceStageId === undefined || targetStageId === undefined) {
        errors.push(
          `${suiteKey}: division "${division.ref}" declares a progression-fed stage "${targetStage.ref}" but one of ` +
            `its own stage ids ("${sourceStage.ref}" / "${targetStage.ref}") never resolved — cannot advance it`,
        );
      } else {
        // The expected qualifier order (D7's "expected qualifier list"),
        // derived from the SOURCE stage's own `expected.tables` — the pack's
        // already-authored, already-offline-checked final standings for
        // `stage0`, resolved from refs to the REAL entrant ids `seedSuite`
        // minted.
        //
        // B07a T5: this used to read "the one table with no poolKey", in rank
        // order, and assume the take rule pulled every ranked entrant of it.
        // That is right for an UNPOOLED source (`_tiny`'s league, whose
        // `rankRange(1, N)` does take them all) and it is not a derivation at
        // all for a POOLED group stage, which has one table per pool and no
        // stage-wide row — so `find(... poolKey === undefined)` returned
        // undefined and the run died on the "no expected.tables row" error
        // below. `expectedQualifierOrder` now picks the rule by what the
        // source actually declared; a pooled stage's seats come from the
        // progression itself, RANK BEFORE GROUP (lib/qualifiers.ts).
        //
        // STILL TRUE, and carried forward from the comment this replaced: the
        // UNPOOLED branch returns EVERY ranked row of the stage-wide table,
        // whatever the take rule asks for. A future pack with a NARROWER take
        // — "top 2 of 8" — would need that list sliced to the qualifier count.
        // That shape reds LOUDLY on length rather than passing silently
        // (`compareQualifiers` compares length before order), so it is a
        // documented limitation and not a silent hole — but a pack author who
        // meets it should recognise it rather than hunt a product defect.
        const stageTables = pack.expected.tables.filter(
          (t) => t.divisionRef === division.ref && t.stageRef === sourceStage.ref,
        );
        const qualifierOrder = expectedQualifierOrder(stageTables, targetStage.progression);
        if (qualifierOrder.warning !== undefined) {
          warnings.push(
            `${suiteKey}: stage "${targetStage.ref}" is fed by ` +
              `${qualifierOrder.pooled ? "the POOLED stage" : "the unpooled stage"} "${sourceStage.ref}", but ` +
              `${qualifierOrder.warning} — this bench derives a qualifier order only for a rank_order ` +
              "placement, and for a pooled source only from a single topNPerGroup take, so it asserts " +
              "none here (D7)",
          );
        }
        const expectedQualifierEntrantIds: string[] = [];
        const unresolvedQualifierRefs: string[] = [];
        for (const ref of qualifierOrder.refs) {
          const id = seeded.entrantIdByRef.get(ref);
          if (id === undefined) unresolvedQualifierRefs.push(ref);
          else expectedQualifierEntrantIds.push(id);
        }
        if (stageTables.length === 0 || unresolvedQualifierRefs.length > 0) {
          errors.push(
            stageTables.length === 0
              ? `${suiteKey}: stage "${targetStage.ref}" declares a progression from "${sourceStage.ref}" but the pack carries ` +
                `no expected.tables row for "${sourceStage.ref}" — there is no expected qualifier order to assert ` +
                "against before confirming (D7)"
              : `${suiteKey}: stage "${sourceStage.ref}"'s expected table names entrant ref(s) with no resolved id: ` +
                `${unresolvedQualifierRefs.join(", ")}`,
          );
        } else if (expectedQualifierEntrantIds.length === 0) {
          // A pooled source whose progression this bench cannot read reaches
          // here with an empty list. It stays a LOUD failure — the same shape
          // the un-derivable case has always had — rather than advancing the
          // stage with nothing asserted about its seats.
          errors.push(
            `${suiteKey}: stage "${targetStage.ref}" is fed by "${sourceStage.ref}", whose expected tables yielded no ` +
              `qualifier order to assert before confirming — ${qualifierOrder.warning ?? "the source declared no ranked rows"} (D7)`,
          );
        } else {
          log.info(
            {
              division: division.ref,
              sourceStage: sourceStage.ref,
              targetStage: targetStage.ref,
              expected: expectedQualifierEntrantIds,
            },
            `${suiteKey}: advancing the progression-fed stage (B05 T3)`,
          );
          // The SOURCE stage must be COMPLETE before `computeSeedProposal`
          // will resolve its standings (409 SEEDING_SOURCE_INCOMPLETE
          // otherwise) — nothing upstream of this block ever completes a
          // stage, so this run does it here, once, immediately before
          // proposing into the stage it feeds.
          await completeStageCapture(base, s, sourceStageId, input.advanceTransport);

          const advanceOutcome = await advanceStageSeeding({
            base,
            session: s,
            stageId: targetStageId,
            expectedQualifierEntrantIds,
            ...(input.advanceTransport === undefined ? {} : { transport: input.advanceTransport }),
          });
          const qc = advanceOutcome.qualifierCheck;
          // B07a T6 — the DIVISION ref leads every name this block pushes.
          // Stage refs are unique only WITHIN a division (`pack-schema.ts`'s
          // `checkRefsUnique` builds its `seenStage` set inside the
          // per-division loop), so two divisions may legally call their
          // knockout the same thing — and now that every division advances,
          // a stage-only name would give the report two identical rows and
          // no way to tell which division failed. Same `division/stage`
          // shape the standings-table oracles below already use.
          oracles.push({
            name: `advance: ${division.ref}/${targetStage.ref} seed proposal qualifiers`,
            passed: qc.matched,
            detail: qc.matched
              ? `proposal qualifiers [${qc.actual.join(", ")}] match the pack's expected order`
              : `proposal qualifiers [${qc.actual.join(", ")}] disagree with the pack's expected order ` +
                `[${qc.expected.join(", ")}] — confirm/generate/complete were never called for "${targetStage.ref}" (D7)`,
          });
          // B05 review round 1, MAJOR 4: this pushed an `OracleResult` and
          // emitted nothing, so a log consumer reading `oracle_checked`
          // undercounted the wave against the report's own oracle list.
          log.info(oracleLogFields("seed_proposal_qualifiers", qc.matched ? "pass" : "fail"), "oracle_checked");
          if (!qc.matched) {
            errors.push(
              `advance: ${division.ref}/${targetStage.ref}: seed proposal qualifiers [${qc.actual.join(", ")}] disagree with the ` +
                `pack's expected order [${qc.expected.join(", ")}]`,
            );
          } else {
            // The newly-confirmed stage's OWN stream(s), folded through the
            // SAME single-event route T1 uses above — reusing that function
            // is the acceptance bar (T3's brief: "the existing fold covers
            // it", not a new folding primitive). Explicit `stageRef` match
            // only: a division reaching here has more than one stage, so the
            // "absent means the division's only stage" fallback (T1's own
            // block) does not apply here.
            //
            // B07a T6 — this is also the ONLY place a non-first stage's
            // streams are played now: the batch-import fold above is scoped
            // to each division's first stage, because a later stage's
            // fixtures have no real entrants until the advance directly above
            // seeds them (ruling R1).
            const targetStageStreams = pack.streams.filter(
              (st) => st.divisionRef === division.ref && st.stageRef === targetStage.ref,
            );
            if (targetStageStreams.length > 0) {
              const refIdByKey = new Map<string, string>([
                ...seeded.entrantIdByRef,
                ...seeded.personIdByRef,
              ]);
              // B07a T7 (ruling R23) — this fold used to be hard-wired to the
              // single-event route for EVERY division, whatever that division
              // declared. A division's play mode is a property of the DIVISION,
              // not of one of its stages, so a later stage follows the same
              // mode its first stage did; leaving this hard-wired would have
              // made `play` a half-connected seam that a pack could set and
              // then watch be ignored for every stage past the first.
              const advanceMode = playModeFor(opts, division.ref, divisionIndex);
              if (advanceMode === "tap") {
                await playDivisionByTaps(division, targetStageStreams);
              } else if (advanceMode === "import") {
                const divisionId = seeded.divisionIdByRef.get(division.ref);
                if (divisionId === undefined) {
                  // Never silent — same discipline as the first-stage fold's
                  // identical guard.
                  errors.push(
                    `${suiteKey}: division "${division.ref}" declares streams for "${targetStage.ref}" but has no ` +
                      "resolved divisionId — cannot fold them through the import route",
                  );
                } else {
                  // The SAME `import_id` this division's first-stage fold used.
                  // The importer's receipts are keyed
                  // `(division_id, import_id, fixture_id)` (`import.ts:275`),
                  // and a later stage's fixtures are DIFFERENT fixtures, so
                  // they import normally rather than reading as duplicates —
                  // while a rerun at the same commit still replays identically,
                  // which is what `buildImportId`'s run-scoped id is for.
                  const advImp = await importDivisionStreams({
                    base,
                    session: s,
                    divisionId,
                    importId: buildImportId(division.ref, input.runId),
                    streams: targetStageStreams,
                    fixtureIdByKey: seeded.fixtureIdByKey,
                    refIdByKey,
                    ...(input.importTransport === undefined
                      ? {}
                      : { transport: input.importTransport }),
                  });
                  for (const finding of advImp.findings) {
                    errors.push(`advance: ${describeImportFinding(finding)}`);
                  }
                  // Minors batch B, row 28 — this log line reported these
                  // numbers but never fed them anywhere a reader of the
                  // REPORT (as opposed to the log stream) could see them.
                  advanceImportRan = true;
                  advanceImportEventsSent += advImp.eventsSent;
                  advanceImportChunks += advImp.chunks;
                  advanceImportWallMs += advImp.wallMs;
                  log.info(
                    {
                      events: advImp.eventsSent,
                      ms: advImp.wallMs,
                      eventsPerSecond: advImp.eventsPerSecond,
                      chunks: advImp.chunks,
                      // Its own `path`, never the first-stage fold's "import":
                      // these events were sent AFTER a seed proposal, and a log
                      // reader that could not tell the two apart would be
                      // unable to check that ordering at all.
                      path: "advance-import",
                    },
                    "suite_simulated",
                  );
                }
              } else {
                const advSim = await simulateDivisionStreams({
                  base,
                  session: s,
                  streams: targetStageStreams,
                  fixtureIdByKey: seeded.fixtureIdByKey,
                  refIdByKey,
                  ...(input.advanceTransport === undefined ? {} : { transport: input.advanceTransport }),
                });
                for (const finding of advSim.findings) {
                  errors.push(
                    `advance: fixture ${finding.fixtureId} (stream ${finding.streamKey}) event #${finding.eventIndex}: ` +
                      `${finding.code} (HTTP ${finding.status}) — ${finding.message}`,
                  );
                }
                log.info(
                  { events: advSim.eventsSent, ms: advSim.wallMs, eventsPerSecond: advSim.eventsPerSecond, path: "advance" },
                  "suite_simulated",
                );
              }
            }

            const completion = await completeStageCapture(
              base,
              s,
              targetStageId,
              input.advanceTransport,
            );
            // D1 — the finalRanks oracle: the pack's OWN expected order
            // (`expected.finalRanks`, `PackExpectedFinalRanks` — the ONLY
            // block that can assert a bracket's placement order) compared
            // against the CAPTURED `complete` response. A mismatch renders
            // BOTH sides, never just one.
            const expectedFinalRanksRow = pack.expected.finalRanks.find(
              (fr) => fr.divisionRef === division.ref && fr.stageRef === targetStage.ref,
            );
            if (expectedFinalRanksRow === undefined) {
              errors.push(
                `${suiteKey}: stage "${division.ref}/${targetStage.ref}" completed but the pack declares no expected.finalRanks row for it — ` +
                  "there is nothing to compare the captured finalRanks against",
              );
            } else {
              const expectedIds: string[] = [];
              const unresolvedFinalRankRefs: string[] = [];
              for (const ref of expectedFinalRanksRow.order) {
                const id = seeded.entrantIdByRef.get(ref);
                if (id === undefined) unresolvedFinalRankRefs.push(ref);
                else expectedIds.push(id);
              }
              if (unresolvedFinalRankRefs.length > 0) {
                errors.push(
                  `${suiteKey}: stage "${division.ref}/${targetStage.ref}"'s expected.finalRanks names entrant ref(s) with no resolved id: ` +
                    `${unresolvedFinalRankRefs.join(", ")}`,
                );
              } else {
                const franksCheck = compareFinalRanks(expectedIds, completion.finalRanks);
                oracles.push({
                  name: `advance: ${division.ref}/${targetStage.ref} finalRanks`,
                  passed: franksCheck.matched,
                  // `reason` is set by the comparator only when a side was
                  // EMPTY — i.e. exactly when there was nothing to compare.
                  subject: franksCheck.reason === undefined,
                  detail: franksCheck.matched
                    ? `captured finalRanks [${(franksCheck.actual ?? []).join(", ")}] match the pack's expected order`
                    : `captured finalRanks [${franksCheck.actual === undefined ? "(absent — stage did not report complete)" : franksCheck.actual.join(", ")}] ` +
                      `disagree with the pack's expected order [${franksCheck.expected.join(", ")}]`,
                });
                // B05 review round 1, MAJOR 4 — see the sibling emitter above.
                log.info(oracleLogFields("final_ranks", franksCheck.matched ? "pass" : "fail"), "oracle_checked");
                if (!franksCheck.matched) {
                  errors.push(
                    `advance: ${division.ref}/${targetStage.ref}: captured finalRanks ` +
                      `[${franksCheck.actual === undefined ? "(absent)" : franksCheck.actual.join(", ")}] disagree with ` +
                      `the pack's expected order [${franksCheck.expected.join(", ")}]`,
                  );
                }

                // B05 T4 — the runtime oracle layer proper (design doc D1/D2).
                // A SECOND, independently-fetched crossing of the same final
                // order: `GET /stages/{id}/standings`'s own `rank` field is
                // re-readable at any time (unlike the `complete` response
                // captured above, which is not — `advance.ts`'s own header
                // comment) and is what a CUSTOMER actually sees. Comparing it
                // against the captured response is the genuinely new check
                // this task owes; comparing it against the pack's own
                // `expected.finalRanks` re-derives D7's own assertion from a
                // wholly different route.
                const standingsWire = await fetchStandings(base, s, targetStageId, undefined, input.oracleTransport);
                const standingsRanked = standingsRankOrder(standingsWire.rows);

                const rankCrossing = compareRankCrossings(completion.finalRanks, standingsRanked);
                oracles.push({
                  name: `oracle: ${division.ref}/${targetStage.ref} rank crossing (captured vs standings)`,
                  passed: rankCrossing.matched,
                  subject: rankCrossing.reason === undefined,
                  detail: rankCrossing.matched
                    ? `captured finalRanks and the re-read standings agree: [${standingsRanked.join(", ")}]`
                    : renderRankCrossingMismatch(rankCrossing),
                });
                log.info(oracleLogFields("rank_crossing", rankCrossing.matched ? "pass" : "fail"), "oracle_checked");
                if (!rankCrossing.matched) {
                  errors.push(
                    `oracle: ${division.ref}/${targetStage.ref}: the captured complete response and the re-read standings DISAGREE on final order — ` +
                      `${renderRankCrossingMismatch(rankCrossing)}`,
                  );
                }

                const standingsVsExpected = compareFinalRanks(expectedIds, standingsRanked);
                oracles.push({
                  name: `oracle: ${division.ref}/${targetStage.ref} standings rank vs expected.finalRanks`,
                  passed: standingsVsExpected.matched,
                  subject: standingsVsExpected.reason === undefined,
                  detail: standingsVsExpected.matched
                    ? `re-read standings [${standingsRanked.join(", ")}] match the pack's expected order`
                    : `re-read standings [${standingsRanked.join(", ")}] disagree with the pack's expected order ` +
                      `[${expectedIds.join(", ")}]`,
                });
                log.info(oracleLogFields("standings_final_rank", standingsVsExpected.matched ? "pass" : "fail"), "oracle_checked");
                if (!standingsVsExpected.matched) {
                  errors.push(
                    `oracle: ${division.ref}/${targetStage.ref}: re-read standings [${standingsRanked.join(", ")}] disagree with the ` +
                      `pack's expected order [${expectedIds.join(", ")}]`,
                  );
                }

                // D2 — champion, defined as rank 1 of the final stage's
                // standings, cross-checked against the captured response,
                // compared against `expected.champions`. No champion field
                // exists anywhere on the wire (F1b) — the bench does not
                // invent one.
                const expectedChampionRow = pack.expected.champions.find(
                  (c) => c.divisionRef === division.ref && (c.stageRef === undefined || c.stageRef === targetStage.ref),
                );
                if (expectedChampionRow === undefined) {
                  warnings.push(
                    `oracle: division "${division.ref}" completed but the pack declares no expected.champions row for it — champion oracle skipped`,
                  );
                } else {
                  const expectedChampionId = seeded.entrantIdByRef.get(expectedChampionRow.entrant);
                  if (expectedChampionId === undefined) {
                    errors.push(
                      `${suiteKey}: expected.champions names entrant ref "${expectedChampionRow.entrant}" with no resolved id`,
                    );
                  } else {
                    const championCheck = compareChampion(expectedChampionId, standingsRanked, completion.finalRanks);
                    oracles.push({
                      name: `oracle: ${division.ref} champion`,
                      passed: championCheck.matched,
                      detail: championCheck.matched
                        ? `champion ${championCheck.fromStandings} matches the pack's expected champion`
                        : renderChampionMismatch(championCheck),
                    });
                    log.info(oracleLogFields("champion", championCheck.matched ? "pass" : "fail"), "oracle_checked");
                    if (!championCheck.matched) {
                      errors.push(`oracle: champion mismatch — ${renderChampionMismatch(championCheck)}`);
                    }
                  }
                }
              }
            }
          }
        }
      }
    };

    // B07a T6 — advancement for EVERY division, driven STAGE-MAJOR: one whole
    // stage boundary at a time across every division, before any division
    // moves on to its next boundary.
    //
    // The order is the point (ruling R1). Each division's later-stage streams
    // are played by `advanceDivision` itself, immediately after the advance
    // that generates that stage's fixtures — so walking divisions in the outer
    // loop instead would seat and PLAY a second boundary of division A before
    // division B's first knockout had been seeded at all. Interleaving by
    // boundary keeps every division's stage N generated before anything's
    // stage N+1 is proposed, which is the only order in which a knockout
    // fixture exists before its own stream is folded into it. The batch-import
    // fold above is scoped to each division's FIRST stage for the same reason.
    //
    // `plan.divisions` is pack order (`buildSeedPlan` maps `pack.divisions`
    // 1:1), so oracles read in the order the pack author wrote their
    // divisions. A division with a single stage, or whose next stage declares
    // no `progression`, contributes nothing — which is every division of every
    // pack shipped before this task except `_tiny`'s own `d-tiny`, so no
    // existing run changes shape.
    if (input.sql !== undefined) {
      const deepestStageCount = Math.max(0, ...plan.divisions.map((d) => d.stages.length));
      for (let stageIndex = 1; stageIndex < deepestStageCount; stageIndex += 1) {
        for (const [divisionIndex, division] of plan.divisions.entries()) {
          const sourceStage = division.stages[stageIndex - 1];
          const targetStage = division.stages[stageIndex];
          if (sourceStage === undefined || targetStage?.progression === undefined) continue;
          await advanceDivision(division, divisionIndex, sourceStage, targetStage);
        }
      }
    }

    // Minors batch B, row 28 — fold the later-stage import fold's own
    // accumulators (above) into the report's `importSimulation`, once every
    // division has advanced. Added rather than replaced: a division whose
    // FIRST stage also imported already has an `importSimulation` from the
    // block above, and this later fold is on top of that, never instead of
    // it. `importSimulation` can also still be `undefined` here (a division
    // with streams ONLY on a later stage, none on its first), so this is the
    // one place that can create it, not only extend it.
    if (advanceImportRan) {
      const eventsSent = (importSimulation?.eventsSent ?? 0) + advanceImportEventsSent;
      const wallMs = (importSimulation?.wallMs ?? 0) + advanceImportWallMs;
      const chunks = (importSimulation?.chunks ?? 0) + advanceImportChunks;
      importSimulation = {
        eventsSent,
        wallMs,
        eventsPerSecond: computeEventsPerSecond(eventsSent, wallMs),
        chunks,
        ...(importSimulation?.findings === undefined ? {} : { findings: importSimulation.findings }),
      };
      timings.importMs = wallMs;
    }

    // B05 T4b — the standings comparator (design doc §3, oracle.ts's
    // `compareStandings`), wired against EVERY `expected.tables` row the
    // pack declares — not only the final stage's placement crossing T4
    // already wires above. T4 built and unit-tested this comparator but
    // reached it from nothing on a real run (AGENTS.md failure class 1, the
    // inert seam — the exact thing this whole wave exists to close;
    // `b05-oracle-comparators.md`'s own vacuity note). Gated on
    // `input.sql !== undefined` only — it does NOT depend on any division
    // being advanced. A division can carry an `expected.tables` row and never
    // declare a progression at all (`d-tiebreak` does exactly that), so gating
    // this on the advance step would leave such a table permanently unasserted.
    //
    // B07a T6: this comment used to say "unlike T3's advance step BELOW … does
    // not depend on `stage1?.progression`". Both halves are now stale — the
    // advance step moved ABOVE this block in B06a T9, and `stage1` no longer
    // exists: advancement walks every division's own stage list.
    const reportMatchOracle = (
      divisionRef: string,
      expectedRows: readonly ExpectedMatchRow[],
      actualRows: readonly ActualMatchRow[],
    ): void => {
      const matchCheck = compareMatches(expectedRows, actualRows);
      // `checked` is never 0, and there is deliberately no `no_subject`
      // branch: `matchesByDivision` only holds divisions the pack declares a
      // match for, and stage 0 REFUSES a pack carrying a stream with no
      // expected match at all ("a replayed stream with no oracle asserts
      // nothing", `validate-pack.ts`). So a run that reaches here always has a
      // subject. `tiny-suite-simulate.test.ts` pins that guarantee rather than
      // leaving it as a comment.
      const verdict = matchCheck.mismatches.length === 0 ? "pass" : "fail";
      oracles.push({
        name: `oracle: ${divisionRef} per-match results`,
        passed: matchCheck.mismatches.length === 0,
        subject: matchCheck.checked > 0,
        verdict,
        detail:
          matchCheck.checked === 0
            ? "no expected.matches rows for this division"
            : `${matchCheck.checked} checked, ${matchCheck.mismatches.length} mismatched` +
              ` (${matchCheck.byRound.map((r) => `r${r.roundNo ?? "-"}: ${r.checked - r.mismatched}/${r.checked}`).join(", ")})`,
      });
      log.info({ ...oracleLogFields("per_match_results", verdict), division: divisionRef }, "oracle_checked");
      for (const miss of matchCheck.mismatches) {
        errors.push(
          `oracle: per-match mismatch in "${divisionRef}" fixture "${miss.fixtureExtKey}" — ` +
            `${miss.field}: expected ${miss.expected}, got ${miss.actual}`,
        );
      }
    };

    if (input.sql !== undefined) {
      // B06a task 3 — per-match results. `expected.matches` has been in the
      // schema since B02 and was compared only OFFLINE, by stage 0's fold;
      // nothing ever asked the product what it decided. One request per
      // division (the route takes no query params and returns the lot), and
      // the fixture STATE route only for the fixtures whose expected row
      // declares `perSide` — a 95-match suite must not pay 95 extra round
      // trips to compare scorelines no pack declared.
      const matchesByDivision = new Map<string, PackExpectedMatch[]>();
      // Captured as the per-match oracle goes, and read by the specials block
      // below: an outcome claim asserts the same folded outcome the per-match
      // oracle just compared, so a second fetch would be a second source of
      // truth for one fact.
      const boardByDivision = new Map<string, readonly ActualMatchRow[]>();
      for (const m of pack.expected.matches) {
        const list = matchesByDivision.get(m.divisionRef) ?? [];
        list.push(m);
        matchesByDivision.set(m.divisionRef, list);
      }
      for (const [divisionRef, declared] of matchesByDivision) {
        const divisionId = seeded.divisionIdByRef.get(divisionRef);
        if (divisionId === undefined) {
          errors.push(`oracle: expected.matches names division ref "${divisionRef}" with no resolved id`);
          continue;
        }
        const expectedRows: ExpectedMatchRow[] = [];
        const unresolved: string[] = [];
        for (const m of declared) {
          const resolvedOutcome = resolveExpectedOutcome(m.outcome, seeded.entrantIdByRef, unresolved);
          if (resolvedOutcome === undefined) continue;
          const perSide = m.perSide?.flatMap((side) => {
            const entrantId = seeded.entrantIdByRef.get(side.entrant);
            if (entrantId === undefined) {
              unresolved.push(side.entrant);
              return [];
            }
            return [{ entrant: entrantId, line: side.line }];
          });
          expectedRows.push({
            fixtureExtKey: m.fixtureExtKey,
            outcome: resolvedOutcome,
            ...(perSide === undefined ? {} : { perSide }),
          });
        }
        if (unresolved.length > 0) {
          errors.push(
            `oracle: expected.matches for "${divisionRef}" names entrant ref(s) with no resolved id: ${unresolved.join(", ")}`,
          );
          continue;
        }
        if (input.matchBoard !== undefined) {
          const injected = await input.matchBoard({ divisionRef, expected: expectedRows });
          boardByDivision.set(divisionRef, injected);
          reportMatchOracle(divisionRef, expectedRows, injected);
          continue;
        }
        const wire = await fetchDivisionFixtures(base, s, divisionId, input.oracleTransport);
        // Scorelines come from the fixture STATE route, and only for the
        // fixtures whose expected row declares `perSide` — see
        // `fetchFixtureSideLines`'s own note on why this is not a blanket
        // second pass over every fixture.
        const wantsLines = new Set(
          expectedRows.filter((row) => row.perSide !== undefined).map((row) => row.fixtureExtKey),
        );
        const actualRows: ActualMatchRow[] = [];
        for (const f of wire) {
          const extKey = f.ext_key ?? "";
          const perSide = wantsLines.has(extKey)
            ? await fetchFixtureSideLines(base, s, f.id, input.oracleTransport)
            : undefined;
          actualRows.push({
            extKey,
            status: f.status,
            roundNo: f.round_no,
            outcome: f.outcome,
            ...(perSide === undefined ? {} : { perSide }),
          });
        }
        boardByDivision.set(divisionRef, actualRows);
        reportMatchOracle(divisionRef, expectedRows, actualRows);
      }

      const standingsByDivision = new Map<string, ReadonlyMap<string, Record<string, number>>>();
      for (const table of pack.expected.tables) {
        const tableStageId = seeded.stageIdByRef.get(table.stageRef);
        if (tableStageId === undefined) {
          errors.push(
            `oracle: expected.tables row for "${table.divisionRef}"/"${table.stageRef}" names a stage ref with no resolved id`,
          );
          continue;
        }
        const expectedRows: ExpectedStandingsRow[] = [];
        const unresolvedEntrantRefs: string[] = [];
        for (const row of table.rows) {
          const entrantId = seeded.entrantIdByRef.get(row.entrant);
          if (entrantId === undefined) {
            unresolvedEntrantRefs.push(row.entrant);
            continue;
          }
          expectedRows.push({
            entrantId,
            played: row.played,
            won: row.won,
            drawn: row.drawn,
            lost: row.lost,
            points: row.points,
            ...(row.metrics === undefined ? {} : { metrics: row.metrics }),
          });
        }
        if (unresolvedEntrantRefs.length > 0) {
          errors.push(
            `oracle: expected.tables row for "${table.divisionRef}"/"${table.stageRef}" names entrant ref(s) with no ` +
              `resolved id: ${unresolvedEntrantRefs.join(", ")}`,
          );
          continue;
        }
        // `compareStandings`'s own empty-case discipline ("an empty expected
        // table is itself a case this asserts on, never silently vacuous")
        // is exercised here for free: `table.rows.min(1)` (pack-schema.ts)
        // means `expectedRows` is never empty for a REAL pack row, but a
        // live fetch returning ZERO rows (a stage nothing ever folded events
        // into) still reds via `actual.length === expected.length`, never a
        // vacuous pass.
        const standingsWire = await fetchStandings(base, s, tableStageId, table.poolKey, input.oracleTransport);
        // Kept for the specials block below — a standings claim reads the same
        // rows this table oracle just compared, never a second fetch.
        standingsByDivision.set(
          table.divisionRef,
          new Map(standingsWire.rows.map((row) => [row.entrantId, row as unknown as Record<string, number>])),
        );
        const tableCheck = compareStandings(expectedRows, standingsWire.rows);
        // B05 T6 fix 1 — a metric the pack does NOT declare is not a failure
        // (`compareMetrics`), but it is not nothing either: the live rows'
        // undeclared metrics ride along on the oracle's own detail line so a
        // reader SEES them. Empty string when there are none, so a table
        // whose every live metric was declared renders exactly as before.
        const undeclaredNote = renderUndeclaredMetrics(tableCheck);
        const undeclaredSuffix =
          undeclaredNote === ""
            ? ""
            : ` — live rows also carry metric(s) this pack does not declare (not gated): ${undeclaredNote}`;
        oracles.push({
          name: `oracle: ${table.divisionRef}/${table.stageRef} standings table`,
          passed: tableCheck.matched,
          detail: tableCheck.matched
            ? `live standings for "${table.stageRef}" match the pack's expected.tables row${undeclaredSuffix}`
            : `${renderStandingsMismatch(tableCheck)}${undeclaredSuffix}`,
        });
        log.info(oracleLogFields("standings_table", tableCheck.matched ? "pass" : "fail"), "oracle_checked");
        if (!tableCheck.matched) {
          errors.push(
            `oracle: ${table.divisionRef}/${table.stageRef}: live standings disagree with the pack's ` +
              `expected.tables row — ${renderStandingsMismatch(tableCheck)}`,
          );
        }

        // B05 T5a — the tie-order cascade oracle (design doc §3, oracle.ts's
        // `compareTieOrderCascade`): reviewer MAJOR #2 — this comparator had
        // no call site anywhere. Wired into the SAME loop, reusing the SAME
        // already-fetched `standingsWire.rows` above (no second fetch, no
        // second route), against the DIVISION's own declared `tiebreakers`
        // — never a hardcoded order, per the comparator's own doc comment.
        // `d-tiebreak`'s own table (B05 T5a) is what makes this reachable
        // with a genuine ordering-differential tie; d-tiny/d-badminton's
        // tables carry no tied rows, so this runs for them too but always
        // reports `checkedPairs: 0`.
        const tableDivision = pack.divisions.find((d) => d.ref === table.divisionRef);
        if (tableDivision?.tiebreakers === undefined) {
          // B05 review round 1, MAJOR 2: the third warn-with-no-oracle site.
          // `tiebreakers` is the PACK's own declaration, so an absent one is
          // the pack side being empty — `no_subject` by the zero-subject rule
          // (report.ts), pushed and emitted rather than left as a warning
          // string no oracle consumer can see.
          warnings.push(
            `oracle: division "${table.divisionRef}" declares no tiebreakers — tie-order cascade oracle ` +
              `skipped for "${table.stageRef}"`,
          );
          oracles.push({
            name: `oracle: ${table.divisionRef}/${table.stageRef} tie-order cascade`,
            passed: true,
            verdict: "no_subject",
            subject: false,
            detail:
              `division "${table.divisionRef}" declares no tiebreakers — this oracle has NO SUBJECT ` +
              `and compared nothing (0 checked, 0 skipped)`,
          });
          log.info(oracleLogFields("tie_order_cascade", "no_subject"), "oracle_checked");
        } else {
          const cascade = tableDivision.tiebreakers;
          const cascadeCheck = compareTieOrderCascade(cascade, standingsWire.rows);
          // B05 T6 fix 2 — the first live run printed a PASS here for two of
          // three divisions over ZERO tied pairs. `matched` is `issues.length
          // === 0`, which an empty check satisfies vacuously; `checkedPairs`
          // is the only field that answers "was there a subject at all", so
          // it is what picks the verdict. `no_subject` keeps `passed: true`
          // (an absent subject is not a failure, and nothing below this line
          // reds) but never renders as PASS.
          const cascadeVerdict: OracleVerdict = !cascadeCheck.matched
            ? "fail"
            : cascadeCheck.checkedPairs === 0
              ? "no_subject"
              : "pass";
          oracles.push({
            name: `oracle: ${table.divisionRef}/${table.stageRef} tie-order cascade`,
            passed: cascadeVerdict !== "fail",
            verdict: cascadeVerdict,
            // From the comparator's OWN count, never re-derived from the
            // verdict — see `OracleResult.subject` in report.ts.
            subject: cascadeCheck.checkedPairs > 0,
            detail:
              cascadeVerdict === "no_subject"
                ? `no two rows in "${table.stageRef}" are tied on points that cascade ` +
                  `[${cascade.join(",")}] could decide — this oracle has NO SUBJECT and compared nothing ` +
                  `(${cascadeCheck.checkedPairs} checked, ${cascadeCheck.skippedPairs} skipped)`
                : cascadeCheck.matched
                  ? `live order agrees with cascade [${cascade.join(",")}] on every tied pair ` +
                    `(${cascadeCheck.checkedPairs} checked, ${cascadeCheck.skippedPairs} skipped)`
                  : cascadeCheck.issues.map((i) => i.detail).join("; "),
          });
          log.info(oracleLogFields("tie_order_cascade", cascadeVerdict), "oracle_checked");
          if (!cascadeCheck.matched) {
            errors.push(
              `oracle: ${table.divisionRef}/${table.stageRef}: live order disagrees with the division's own ` +
                `cascade [${cascade.join(",")}] — ${cascadeCheck.issues.map((i) => i.detail).join("; ")}`,
            );
          }
        }
      }

      // B06a task 4 — specials. Every mechanic the bench exists to witness (a
      // super over, a shootout, a DLS revision, a retirement) is declared as a
      // fixture plus typed claims, and none of them were compared at run time.
      //
      // Subjects are assembled from what the run ALREADY fetched: the outcome
      // from the per-match board above, the standings from the table oracle's
      // own rows. Only the folded state costs a request, one per special, and
      // packs declare few.
      if (pack.expected.specials.length > 0) {
        const specialSubjects = new Map<string, SpecialSubject>();
        const resolvedSpecials: ResolvedSpecial[] = [];
        const unresolvedSpecialRefs: string[] = [];
        for (const sp of pack.expected.specials) {
          if (input.specialSubjects !== undefined) {
            resolvedSpecials.push({
              kind: sp.kind,
              divisionRef: sp.divisionRef,
              fixtureExtKey: sp.fixtureExtKey,
              claims: sp.claims.map((claim) => resolveSpecialClaim(claim, seeded.entrantIdByRef, unresolvedSpecialRefs)),
            });
            continue;
          }
          const specialKey = `${sp.divisionRef}/${sp.fixtureExtKey}`;
          const specialFixtureId = seeded.fixtureIdByKey.get(fixtureKey(sp.divisionRef, sp.fixtureExtKey));
          const specialOutcome = boardByDivision
            .get(sp.divisionRef)
            ?.find((row) => row.extKey === sp.fixtureExtKey)?.outcome;
          if (specialFixtureId !== undefined) {
            let specialState: unknown;
            if (tapPlayedFixtureIds.has(specialFixtureId)) {
              // Fix round 2 (R64) — a pack claim describes the STREAM's end
              // state. A tapped fixture's stored state is folded through the
              // bench-appended core.finalize (generic: "done" -> "final"), so
              // the claim is judged on the product's own ledger rows through
              // the last pack event instead. Never a fallback to /state: a
              // failed fold reds, and the claims read `(absent)`.
              const specialStream = pack.streams.find(
                (st) => st.divisionRef === sp.divisionRef && st.fixtureExtKey === sp.fixtureExtKey,
              );
              const specialDivision = pack.divisions.find((d) => d.ref === sp.divisionRef);
              const homeEntrantId = specialStream === undefined ? undefined : seeded.entrantIdByRef.get(specialStream.home);
              const awayEntrantId = specialStream === undefined ? undefined : seeded.entrantIdByRef.get(specialStream.away);
              try {
                if (
                  specialStream === undefined ||
                  specialDivision === undefined ||
                  homeEntrantId === undefined ||
                  awayEntrantId === undefined
                ) {
                  throw new Error("its stream, division or entrant ids did not resolve");
                }
                const specialModule = bootRegistry().get(specialDivision.sportKey, specialDivision.moduleVersion);
                const specialCfg = resolveDivisionCfg(specialModule, specialDivision);
                if (!specialCfg.ok) throw new Error(`its cfg could not be resolved (${specialCfg.reason})`);
                const folded = await specialStateThroughPackEvents({
                  base,
                  session: s,
                  fixtureId: specialFixtureId,
                  homeEntrantId,
                  awayEntrantId,
                  packEventTypes: specialStream.events.map((event) => event.type),
                  module: specialModule,
                  cfg: specialCfg.cfg,
                  transport: input.oracleTransport,
                });
                specialState = folded.state;
                log.info(
                  { fixture: specialKey, signOffRows: folded.signOffRows },
                  `${suiteKey}: special state judged through the pack's own events (R64)`,
                );
              } catch (err) {
                errors.push(
                  `oracle: specials: ${specialKey} was tapped, and its state through the pack's own events could not be ` +
                    `folded — ${err instanceof Error ? err.message : String(err)} (never judged off the signed-off /state)`,
                );
              }
            } else {
              specialState = await fetchFixtureModuleState(base, s, specialFixtureId, input.oracleTransport);
            }
            specialSubjects.set(specialKey, {
              outcome: specialOutcome,
              state: specialState,
              // NOT the cumulative table: `PackClaim`'s own doc is explicit
              // that a standings claim reads THIS fixture's `StandingsDelta`,
              // because a special names one fixture and conflating the two
              // would make a claim mean different things in a one-round and a
              // six-round stage. The delta is computed by the ENGINE from the
              // PRODUCT's own folded outcome and state — the product supplies
              // the facts, the engine supplies the arithmetic.
              standings: specialStandingsDelta(pack, sp.divisionRef, specialOutcome, specialState, warnings),
            });
          }
          resolvedSpecials.push({
            kind: sp.kind,
            divisionRef: sp.divisionRef,
            fixtureExtKey: sp.fixtureExtKey,
            claims: sp.claims.map((claim) => resolveSpecialClaim(claim, seeded.entrantIdByRef, unresolvedSpecialRefs)),
          });
        }
        if (unresolvedSpecialRefs.length > 0) {
          errors.push(
            `oracle: expected.specials names entrant ref(s) with no resolved id: ${unresolvedSpecialRefs.join(", ")}`,
          );
        }
        const injectedSubjects =
          input.specialSubjects === undefined
            ? undefined
            : await input.specialSubjects({ specials: resolvedSpecials });
        const specialCheck = compareSpecials(resolvedSpecials, injectedSubjects ?? specialSubjects);
        const specialsClean = specialCheck.failures.length === 0 && specialCheck.unsupported.length === 0;
        const specialsVerdict = specialCheck.checked === 0 ? "no_subject" : specialsClean ? "pass" : "fail";
        oracles.push({
          name: "oracle: specials",
          passed: specialsClean,
          subject: specialCheck.checked > 0,
          verdict: specialsVerdict,
          detail:
            `${specialCheck.specials} special(s), ${specialCheck.checked} claim(s) checked, ` +
            `${specialCheck.failures.length} failed, ${specialCheck.unsupported.length} unsupported`,
        });
        log.info(oracleLogFields("specials", specialsVerdict), "oracle_checked");
        for (const f of specialCheck.failures) {
          errors.push(
            `oracle: special claim failed on fixture "${f.fixtureExtKey}" — ${f.claim}: ` +
              `expected ${f.expected}, got ${f.actual}`,
          );
        }
        for (const u of specialCheck.unsupported) {
          // Never silent: a claim nothing evaluates is an assertion the pack
          // author believes is being made.
          errors.push(
            `oracle: special claim on "${u.on}" (fixture "${u.fixtureExtKey}") cannot be evaluated by this runner`,
          );
        }
      }
    }

    // B05 T4b — the leaderboard comparator (design §8, oracle.ts's
    // `compareLeaderboard`), wired against `expected.leaderboards` via
    // `GET /divisions/{id}/stats/players` — the SAME "built by T4, reached
    // by nothing" gap `compareStandings` above closes. Grouped by a
    // per-division cache so a division with more than one `metricKey` entry
    // (`_tiny.json`'s own d-tiny: "scores" and "points") fetches once, not
    // once per entry.
    if (input.sql !== undefined && pack.expected.leaderboards.length > 0) {
      const playerStatsCache = new Map<string, DivisionPlayerStatsWire>();
      // B05 T5b-2 — `comparePersonDivisionStat`'s own cache. `GET
      // /persons/{id}/stats` (UNFILTERED — no `?division_id=`) answers with
      // EVERY division that person appears in, so one fetch per person serves
      // every board they are named on: `p-ana` is on all four of `_tiny`'s
      // boards and is fetched once.
      const personStatsCache = new Map<string, PersonStatsWire>();

      for (const board of pack.expected.leaderboards) {
        const leaderboardDivisionId = seeded.divisionIdByRef.get(board.divisionRef);
        if (leaderboardDivisionId === undefined) {
          errors.push(
            `oracle: expected.leaderboards names division ref "${board.divisionRef}" with no resolved id`,
          );
          continue;
        }
        let playerStats = playerStatsCache.get(leaderboardDivisionId);
        if (playerStats === undefined) {
          playerStats = await fetchDivisionPlayerStats(base, s, leaderboardDivisionId, input.oracleTransport);
          playerStatsCache.set(leaderboardDivisionId, playerStats);
        }
        const expectedEntries: ExpectedLeaderboardEntry[] = [];
        const unresolvedPersonRefs: string[] = [];
        for (const entry of board.entries) {
          const personId = seeded.personIdByRef.get(entry.person);
          if (personId === undefined) {
            unresolvedPersonRefs.push(entry.person);
            continue;
          }
          expectedEntries.push({ personId, name: entry.name, count: entry.count });
        }
        if (unresolvedPersonRefs.length > 0) {
          errors.push(
            `oracle: expected.leaderboards "${board.divisionRef}"/"${board.metricKey}" names person ref(s) with no ` +
              `resolved id: ${unresolvedPersonRefs.join(", ")}`,
          );
          continue;
        }
        // Name AND count, independently (design §8) — `compareLeaderboard`'s
        // own discipline, exercised here against a LIVE fetch for the first
        // time: a count-only or name-only check would each pass for a wrong
        // half of a mis-attributed entry (D6, below).
        const boardCheck = compareLeaderboard(board.metricKey, expectedEntries, playerStats);
        oracles.push({
          name: `oracle: ${board.divisionRef} leaderboard (${board.metricKey})`,
          passed: boardCheck.matched,
          detail: boardCheck.matched
            ? `live leaderboard "${board.metricKey}" matches the pack's expected.leaderboards row`
            : renderLeaderboardMismatch(boardCheck),
        });
        log.info(oracleLogFields("leaderboard", boardCheck.matched ? "pass" : "fail"), "oracle_checked");
        if (!boardCheck.matched) {
          errors.push(
            `oracle: ${board.divisionRef}/${board.metricKey}: live leaderboard disagrees with the pack's ` +
              `expected.leaderboards row — ${renderLeaderboardMismatch(boardCheck)}`,
          );
        }

        // B05 T5b-2 — `comparePersonDivisionStat`, wired: the SECOND wire
        // crossing of the same historical fact the board above already pins.
        // A customer can read a division's leaderboard OR a player's own
        // card, and `usecases/player-stats.ts` derives them separately —
        // `personStats` walks that person's own rows, `divisionPlayerStats`
        // walks the division's. Two derivations of one history that are
        // never compared is precisely the gap this oracle closes; the
        // comparator existed since T5b and was reached by nothing.
        //
        // Reuses `expectedEntries` above rather than re-resolving refs: the
        // expected count IS the leaderboard's own authored count, never a
        // second number typed anywhere.
        const cardIssues: { label: string; expected: string; actual: string }[] = [];
        for (const entry of expectedEntries) {
          let personStats = personStatsCache.get(entry.personId);
          if (personStats === undefined) {
            personStats = await fetchPersonStats(base, s, entry.personId, undefined, input.oracleTransport);
            personStatsCache.set(entry.personId, personStats);
          }
          const cardCheck = comparePersonDivisionStat(
            board.metricKey,
            entry.count,
            leaderboardDivisionId,
            personStats,
          );
          if (!cardCheck.matched) {
            cardIssues.push({
              label: `${board.metricKey}: ${entry.name}`,
              expected: String(cardCheck.expectedCount),
              actual: cardCheck.actualCount === undefined ? "(absent)" : String(cardCheck.actualCount),
            });
          }
        }
        // `expectedEntries.length` is what answers "did we check anything",
        // exactly as `compareLeaderboard`'s own doc comment says of its
        // entries — an `every()` over an empty list is a silent yes. The
        // guard above (`unresolvedPersonRefs`) already `continue`s before
        // here, and `pack-schema.ts` gives every board `entries.min(1)`, so
        // an empty list here would mean the pack changed shape underneath
        // this block rather than that nothing was owed.
        //
        // ZERO-SUBJECT RULE (report.ts, beside `OracleVerdict`): this REDS
        // rather than reporting `no_subject`, deliberately. The pack declared
        // a board — `pack-schema.ts` gives every one of them `entries.min(1)`
        // — so zero resolved entries here is a missing answer to a question
        // that WAS asked, not an absent subject.
        const cardsChecked = expectedEntries.length;
        const cardsMatched = cardsChecked > 0 && cardIssues.length === 0;
        oracles.push({
          name: `oracle: ${board.divisionRef} person cards (${board.metricKey})`,
          passed: cardsMatched,
          // A zero-entry board REDS (see the rule above) but did not compare
          // anything, and the run summary must not count it as if it had.
          subject: cardsChecked > 0,
          detail: cardsMatched
            ? `each of the ${cardsChecked} person(s) on this board carries the SAME "${board.metricKey}" count ` +
              `on their own /persons/{id}/stats card for "${board.divisionRef}"`
            : cardsChecked === 0
              ? `expected.leaderboards "${board.divisionRef}"/"${board.metricKey}" resolved ZERO person entries — ` +
                `nothing was cross-checked against /persons/{id}/stats`
              : renderSideBySide(cardIssues),
        });
        log.info(oracleLogFields("person_division_stat", cardsMatched ? "pass" : "fail"), "oracle_checked");
        if (!cardsMatched) {
          errors.push(
            `oracle: ${board.divisionRef}/${board.metricKey}: a person's own /persons/{id}/stats card ` +
              `disagrees with the SAME count the division leaderboard already pins — ` +
              `${cardsChecked === 0 ? "zero entries resolved" : renderSideBySide(cardIssues)}`,
          );
        }
      }
    }

    // B05 T5b-2 — `compareCareerStats`, wired against `expected.careers` via
    // `GET /persons/{id}/stats?group=sport`. T5b-1 gave this comparator its
    // first real subject on `_tiny` (Ana Alvarez scoring across `d-tiny` and
    // `d-tiebreak`, both `generic`, so `personCareerStats` files them under
    // ONE sports[] entry and SUMS them); until this block it was still
    // reached by nothing — AGENTS.md failure class 1.
    //
    // Grouped by PERSON, not per row: `compareCareerStats` takes a person's
    // whole expected metric list at once, and one `?group=sport` fetch
    // answers all of them.
    //
    // Gated on `input.sql !== undefined` only — a career rollup crosses no
    // stage and no progression, so it has nothing to wait for beyond the
    // folds above.
    if (input.sql !== undefined) {
      if (pack.expected.careers.length === 0) {
        // An EMPTY expected set is not a passing oracle. `compareCareerStats`
        // says so itself ("no expected careers is vacuously matched, and
        // callers must check length before trusting it") — pushing an oracle
        // here would report a green "career rollup" for a pack that declares
        // no career at all, which is the vacuity this wave exists to remove.
        // Stated as a warning, the same way T5a's cascade states a division
        // that declares no tiebreakers.
        //
        // B05 review round 1, MAJOR 2: and, since the pack is the empty side,
        // ALSO as a `no_subject` oracle row — see the zero-subject rule in
        // report.ts. The warning alone was invisible to every oracle consumer.
        warnings.push(
          `oracle: pack declares no expected.careers rows — the cross-division career rollup oracle ` +
            `(compareCareerStats) has no subject and was NOT run`,
        );
        oracles.push({
          name: `oracle: career rollup`,
          passed: true,
          verdict: "no_subject",
          subject: false,
          detail:
            `the pack declares no expected.careers rows — the cross-division career rollup oracle ` +
            `(compareCareerStats) has NO SUBJECT and compared nothing`,
        });
        log.info(oracleLogFields("career_stats", "no_subject"), "oracle_checked");
      } else {
        const careersByPerson = new Map<string, ExpectedCareerStat[]>();
        const unresolvedCareerRefs: string[] = [];
        for (const career of pack.expected.careers) {
          const personId = seeded.personIdByRef.get(career.person);
          if (personId === undefined) {
            unresolvedCareerRefs.push(career.person);
            continue;
          }
          const bucket = careersByPerson.get(career.person);
          const row: ExpectedCareerStat = {
            personId,
            name: career.name,
            metricKey: career.metricKey,
            count: career.count,
          };
          if (bucket === undefined) careersByPerson.set(career.person, [row]);
          else bucket.push(row);
        }
        if (unresolvedCareerRefs.length > 0) {
          errors.push(
            `oracle: expected.careers names person ref(s) with no resolved id: ` +
              `${[...new Set(unresolvedCareerRefs)].join(", ")}`,
          );
        }
        const careerStatsCache = new Map<string, PersonCareerStatsWire>();
        for (const [personRef, expectedCareers] of careersByPerson) {
          const careerPersonId = expectedCareers[0].personId;
          let careerWire = careerStatsCache.get(careerPersonId);
          if (careerWire === undefined) {
            careerWire = await fetchPersonCareerStats(base, s, careerPersonId, input.oracleTransport);
            careerStatsCache.set(careerPersonId, careerWire);
          }
          const careerCheck = compareCareerStats(expectedCareers, careerWire);
          // `expectedCareers.length > 0` by construction (a key only exists
          // once a row landed in it), so this `matched` is never the empty
          // set's vacuous yes — the empty case is the `warnings.push` branch
          // above, which reports NO oracle at all.
          oracles.push({
            name: `oracle: ${personRef} career rollup`,
            passed: careerCheck.matched,
            detail: careerCheck.matched
              ? `the live ?group=sport rollup carries all ${careerCheck.entries.length} of this person's ` +
                `expected.careers metric(s), each in exactly one sport`
              : renderSideBySide(
                  careerCheck.entries
                    .filter((e) => !e.matched)
                    .map((e) => ({
                      label: `${e.metricKey} (found in ${e.foundInSports} sport(s))`,
                      expected: String(e.expectedCount),
                      actual: e.actualValue === undefined ? "(absent or ambiguous)" : String(e.actualValue),
                    })),
                ),
          });
          log.info(oracleLogFields("career_stats", careerCheck.matched ? "pass" : "fail"), "oracle_checked");
          if (!careerCheck.matched) {
            errors.push(
              `oracle: ${personRef}: the live career rollup disagrees with the pack's expected.careers ` +
                `row(s) — ${careerCheck.entries
                  .filter((e) => !e.matched)
                  .map(
                    (e) =>
                      `${e.metricKey}: expected ${e.expectedCount}, got ` +
                      `${e.actualValue === undefined ? "(absent or ambiguous)" : e.actualValue} ` +
                      `(found in ${e.foundInSports} sport(s))`,
                  )
                  .join("; ")}`,
            );
          }
        }
      }
    }

    // -----------------------------------------------------------------
    // B06a T6 — CLAIM ACCEPTANCE. The half of the people layer nothing has
    // ever driven.
    //
    // B03 §5 drew the line ("the accept flow is B05's, seeding only mints
    // invites") and no wave since crossed it, so every people-layer claim
    // this programme has made rests on a `person_claims` row EXISTING. That
    // is not the customer's question. The customer's question is whether the
    // human the invite was sent to can get into their own profile, and an
    // unusable invite and a working one are indistinguishable from
    // `claimed_at === null`.
    //
    // Runs AFTER the folds so a claimed profile's stats can be compared with
    // the numbers this run has already proven, and gated on `input.sql` for
    // the same reason every other B05/B06a step is.
    //
    // Two route facts found while building this, both correcting the plan:
    //   - `GET /persons/{id}/claim-invites` is `getOpenClaim`
    //     (`usecases/person-claims.ts:200-208`), whose WHERE clause carries
    //     `claimed_at is null`. An accepted invite therefore reads back as
    //     `null`, not as a row with a timestamp. That absence is the
    //     read-back proof, and the plan's "assert claimed_at != null" would
    //     have asserted against a row the route refuses to return.
    //   - `/api/claims/*` runs on the non-v1 envelope (`lib/http.ts:113-121`)
    //     which DROPS the error `code`, so `CLAIM_INVALID` never crosses the
    //     wire. Refusals are asserted on STATUS.
    if (input.sql !== undefined && seeded.officialsAndClaims !== undefined) {
      // The whole step in its own try/catch. Unlike every oracle block above
      // it, this one signs in as BRAND-NEW third-party accounts — one per
      // invitee, each auto-provisioning its own org on first sign-in
      // (`http.ts:73`) — and reads two routes that throw on any non-200. A
      // failure here is a FINDING about the claim surface; letting it
      // propagate would abandon the stage-advancement block that follows and
      // report the whole run as one error with no claim detail at all.
      try {
        // Accept the PLAYER invites and leave the officials' alone. Not an
        // arbitrary split: a player invite points at a pack person who actually
        // scored, so the claimed profile has stats to compare, and the untouched
        // remainder is what keeps "an unclaimed invite still exists after this
        // step" provable rather than assumed.
        //
        // The order is DERIVED here from `kind`, never assumed of `seed.ts`'s
        // own ordering. Two authorities for "which invites are players" — a
        // count taken from `kind` and a prefix taken from position — would let a
        // reorder in `seed.ts` accept the officials, skip the players, and leave
        // all five oracles below passing.
        const playerInvites = seeded.officialsAndClaims.mintedInvites.filter((m) => m.kind === "player");
        const otherInvites = seeded.officialsAndClaims.mintedInvites.filter((m) => m.kind !== "player");
        const minted = [...playerInvites, ...otherInvites];
        const limit = playerInvites.length;
        const claimTransport = input.oracleTransport ?? defaultProbeTransport;
        // Local, not `timings` — `RunReport.timings` is a fixed four-field shape
        // and widening it is a report change this task does not owe.
        const claimStart = performance.now();

        // Snapshot BEFORE, so the comparison is against this run's own numbers
        // rather than a table typed into the bench.
        const statsBefore = new Map<string, PersonStatsWire>();
        for (const inv of minted.slice(0, limit)) {
          statsBefore.set(inv.personId, await fetchPersonStats(base, s, inv.personId, undefined, input.oracleTransport));
        }

        const claims = await acceptClaimInvites({ base, invites: minted, limit, transport: claimTransport });
        const claimsMs = Math.round(performance.now() - claimStart);

        const acceptedAll = claims.attempted > 0 && claims.accepted === claims.attempted;
        // `passed` is DERIVED from `verdict`, never computed beside it.
        // `OracleResult`'s own `superRefine` (`report.ts:151-164`) requires
        // `passed === (verdict !== "fail")` and `writeReport` (`:790`) parses
        // before writing, so a `no_subject` row carrying `passed: false` does not
        // fail an assertion — it throws inside the report writer and leaves the
        // whole run with NO report on disk. No suite-level test can see it:
        // vitest calls the runner, never `writeReport`.
        const acceptedVerdict = claims.attempted === 0 ? "no_subject" : acceptedAll ? "pass" : "fail";
        oracles.push({
          name: "people: claim invites accepted",
          passed: acceptedVerdict !== "fail",
          verdict: acceptedVerdict,
          subject: claims.attempted > 0,
          detail:
            claims.attempted === 0
              ? "the pack declares no claim invites — nothing was accepted and this oracle compared NOTHING"
              : `${claims.accepted}/${claims.attempted} invites accepted by the invited address` +
                (claims.rejected.length === 0
                  ? ""
                  : ` — refused: ${claims.rejected.map((r) => `${r.person} HTTP ${r.status} (${r.detail})`).join("; ")}`),
        });
        log.info(oracleLogFields("claims_accepted", acceptedVerdict), "oracle_checked");
        if (claims.attempted > 0 && !acceptedAll) {
          errors.push(
            `people: ${claims.rejected.length} of ${claims.attempted} claim invites were REFUSED — ` +
              claims.rejected.map((r) => `${r.person} HTTP ${r.status} (${r.detail})`).join("; "),
          );
        }
        if (claims.attempted === 0) {
          warnings.push(
            "people: the pack declares no claim invites, so claim acceptance had NO SUBJECT and was not proven",
          );
        }

        // The negative case, and the reason it is an assertion rather than
        // decoration: a run that accepted everything it was handed proves the
        // happy path and nothing about whether the product checks the token at
        // all. `invalidTokenRefused` is false unless a tampered token drew a
        // 401 IN A RUN THAT ALSO ACCEPTED SOMETHING — see its own doc comment.
        // A run that accepted NOTHING cannot have proven token validation either
        // way: the tampered probe had no session it could show was working, so
        // there is no subject here — not a failure, and certainly not the
        // token-validation defect an unconditional error message would name.
        const negativeVerdict =
          claims.invalidTokenStatus === null || claims.accepted === 0
            ? "no_subject"
            : claims.invalidTokenRefused
              ? "pass"
              : "fail";
        oracles.push({
          name: "people: an invalid claim token is refused",
          passed: negativeVerdict !== "fail",
          verdict: negativeVerdict,
          subject: negativeVerdict !== "no_subject",
          detail:
            claims.invalidTokenStatus === null
              ? "no invite was available to tamper with — the negative case compared NOTHING"
              : claims.accepted === 0
                ? `a never-minted token drew HTTP ${claims.invalidTokenStatus}, but this run accepted NO real ` +
                  "invite, so that refusal proves the session was missing rather than that the token was checked"
                : `a same-shape, same-length token that was never minted drew HTTP ${claims.invalidTokenStatus}` +
                  (claims.invalidTokenRefused ? "" : " — expected 401"),
        });
        log.info(oracleLogFields("claims_invalid_token", negativeVerdict), "oracle_checked");
        if (negativeVerdict === "fail") {
          errors.push(
            `people: a tampered claim token drew HTTP ${claims.invalidTokenStatus}, not the 401 a never-minted ` +
              "token must draw — the claim surface is not validating the token",
          );
        }

        // Read back through the product, never off the acceptance response.
        // `getOpenClaim` returns only OPEN claims, so an accepted invite reads
        // as `null` and an untouched one still reads as a row — the two
        // assertions below are the same route answering opposite ways, which is
        // what makes either of them worth anything.
        const stillOpen = async (personId: string): Promise<ClaimInviteReadBack | null> =>
          await t.request<ClaimInviteReadBack | null>(base, s, `/api/v1/persons/${personId}/claim-invites`);

        const acceptedStillOpen: string[] = [];
        for (const personId of claims.acceptedPersonIds) {
          if ((await stillOpen(personId)) !== null) acceptedStillOpen.push(personId);
        }
        if (claims.accepted > 0) {
          const closed = acceptedStillOpen.length === 0;
          oracles.push({
            name: "people: an accepted invite is closed",
            passed: closed,
            verdict: closed ? "pass" : "fail",
            subject: true,
            detail: closed
              ? `all ${claims.accepted} accepted invites no longer read back as open`
              : `${acceptedStillOpen.length} accepted invite(s) still read back as OPEN: ${acceptedStillOpen.join(", ")}`,
          });
          log.info(oracleLogFields("claims_accepted_closed", closed ? "pass" : "fail"), "oracle_checked");
          if (!closed) {
            errors.push(
              `people: ${acceptedStillOpen.length} invite(s) reported accepted still read back as open — ` +
                "the acceptance did not persist",
            );
          }
        }

        const skippedInvites = minted.slice(limit);
        const skippedClosed: string[] = [];
        for (const inv of skippedInvites) {
          if ((await stillOpen(inv.personId)) === null) skippedClosed.push(inv.ref);
        }
        const untouchedVerdict =
          skippedInvites.length === 0 ? "no_subject" : skippedClosed.length === 0 ? "pass" : "fail";
        oracles.push({
          name: "people: invites past the limit stay unclaimed",
          passed: untouchedVerdict !== "fail",
          verdict: untouchedVerdict,
          subject: skippedInvites.length > 0,
          detail:
            skippedInvites.length === 0
              ? "this run accepted every invite the pack declares, so nothing proves an UNCLAIMED one survives"
              : skippedClosed.length === 0
                ? `${skippedInvites.length} invite(s) were never touched and still read back as open`
                : `${skippedClosed.length} invite(s) this run never touched are no longer open: ${skippedClosed.join(", ")}`,
        });
        log.info(oracleLogFields("claims_untouched_open", untouchedVerdict), "oracle_checked");
        if (skippedClosed.length > 0) {
          errors.push(
            `people: invite(s) this run never touched are no longer open (${skippedClosed.join(", ")}) — ` +
              "something accepted an invite nobody asked it to",
          );
        }

        // Claiming a profile must not change what it reports. The comparison is
        // against this run's own BEFORE snapshot, so a change to the metrics
        // moves both sides together instead of leaving a typed-in table
        // asserting yesterday's numbers.
        const statsDrift: string[] = [];
        let comparedAny = false;
        for (const personId of claims.acceptedPersonIds) {
          const before = statsBefore.get(personId);
          if (before === undefined) {
            // The accept response named a person this run never invited. That is
            // a product finding, not a row to skip quietly — skipping it is how a
            // wrong `person_id` would leave every oracle here green.
            statsDrift.push(`${personId} (accepted a person this run never snapshotted)`);
            comparedAny = true;
            continue;
          }
          const after = await fetchPersonStats(base, s, personId, undefined, input.oracleTransport);
          const hadNumbers = before.divisions.some((d) => Object.keys(d.stats).length > 0);
          if (hadNumbers) comparedAny = true;
          if (JSON.stringify(after.divisions) !== JSON.stringify(before.divisions)) {
            statsDrift.push(personId);
          }
        }
        const driftVerdict = !comparedAny ? "no_subject" : statsDrift.length === 0 ? "pass" : "fail";
        oracles.push({
          name: "people: a claimed profile still reports the same stats",
          passed: driftVerdict !== "fail",
          verdict: driftVerdict,
          subject: comparedAny,
          detail: !comparedAny
            ? "no accepted profile carried any stats before acceptance — this oracle compared NOTHING"
            : statsDrift.length === 0
              ? `${claims.accepted} claimed profile(s) report the same divisions and stats as before acceptance`
              : `claimed profile(s) ${statsDrift.join(", ")} report DIFFERENT stats after being claimed`,
        });
        log.info(oracleLogFields("claims_profile_stats", driftVerdict), "oracle_checked");
        if (statsDrift.length > 0) {
          errors.push(
            `people: claiming a profile changed the stats it reports (${statsDrift.join(", ")}) — ` +
              "the same person-stats read returned different numbers before and after acceptance",
          );
        }
        if (!comparedAny && claims.accepted > 0) {
          warnings.push(
            "people: every accepted profile had EMPTY stats before acceptance, so the claimed-profile stats " +
              "oracle had no subject — the pack's claim invites do not point at anyone who scored",
          );
        }

        claimsSummary = { total: minted.length, accepted: claims.accepted };
        log.info(
          {
            attempted: claims.attempted,
            accepted: claims.accepted,
            skipped: claims.skipped,
            invalidTokenStatus: claims.invalidTokenStatus,
            ms: claimsMs,
          },
          `${suiteKey}: claim invites accepted (B06a T6)`,
        );
      } catch (err) {
        const detail = err instanceof Error ? err.message : String(err);
        errors.push(`people: the claim-acceptance step FAILED before it could report — ${detail}`);
        oracles.push({
          name: "people: claim invites accepted",
          passed: false,
          verdict: "fail",
          subject: true,
          detail: `the claim-acceptance step threw before reporting: ${detail}`,
        });
        log.info(oracleLogFields("claims_accepted", "fail"), "oracle_checked");
      }
    }


    // B03r tasks 9+10 — registration divisions (design §3/§9), driven
    // separately from seedSuite's admin walk above (see this file's own
    // "Registration wiring" header comment for why).
    //
    // A pack that declares `paymentMethod: "stripe"` anywhere needs the org to
    // hold the shared Connect test account BEFORE the first division is
    // configured: `resumeRegistrationCheckout` reads
    // `organizations.stripe_account_id` + `stripe_charges_enabled` and refuses
    // otherwise (usecases/registrations.ts:2325, :4387), and a bench org is
    // auto-provisioned by this run's own sign-in with neither set. Claimed once
    // around the whole loop rather than per division — the account belongs to
    // the ORG, so a per-division claim would be the same write repeated.
    //
    // Hand-back is in the `finally` and is not optional: `smoke.ts` claims the
    // same single account and RESTORES it (smoke.ts:8758), so a bench run that
    // kept it would make smoke's paid suites skip themselves and report green
    // while proving nothing.
    // The pack's declared currency, WRITTEN — not merely validated. Stage 0
    // requires `org.currency` once any division prices a fee, but nothing
    // transmitted it, so a pack could declare "usd", satisfy every offline
    // check, and be charged in "gbp" — `organizations.currency` defaults to
    // 'gbp', and the first live paid run did exactly that: two 100 GBP
    // payment intents against a pack that said usd. Written BEFORE the
    // registration loop because the amount and currency are snapshotted onto
    // the entry at submit time; a write afterwards would be decoration.
    const declaredCurrency = pack.org.currency;
    if (declaredCurrency !== undefined) {
      const sqlSeam = input.sql;
      const writeCurrency =
        input.setOrgCurrency ??
        (sqlSeam === undefined
          ? undefined
          : (id: string, c: string) => sqlSeam.setOrgCurrency(id, c));
      if (writeCurrency === undefined) {
        throw new Error(
          `${suiteKey}: pack declares org.currency "${declaredCurrency}" but neither the PlanSql seam nor a setOrgCurrency ` +
            `override is wired — writing it is the only thing that makes the declaration mean anything`,
        );
      }
      await writeCurrency(orgId, declaredCurrency);
      log.info(
        { org: orgId, currency: declaredCurrency },
        `${suiteKey}: wrote the pack's declared org currency`,
      );
    }

    const needsConnect = registrationDivisionsOf(pack).some(
      (d) => pack.registration?.byDivision[d.ref]?.paymentMethod === "stripe",
    );
    const connectAccountId = process.env.STRIPE_CONNECT_TEST_ACCOUNT;
    let connectPreviousHolder: string | null = null;
    let connectClaimed = false;
    if (needsConnect) {
      if (connectAccountId === undefined || connectAccountId === "") {
        throw new Error(
          `${suiteKey}: a registration division declares paymentMethod:"stripe" but STRIPE_CONNECT_TEST_ACCOUNT is not set — ` +
            "hosted Checkout needs a real connected account (usecases/registrations.ts:2325). Refusing rather than " +
            "running a paid funnel that would fail at mint time with an opaque error.",
        );
      }
      const connect =
        input.connectAccount ??
        (input.sql === undefined
          ? undefined
          : {
              claim: (id: string, account: string) =>
                input.sql!.claimConnectAccount(id, account),
              release: (id: string, prev: string | null, account: string) =>
                input.sql!.releaseConnectAccount(id, prev, account),
            });
      if (connect === undefined) {
        throw new Error(
          `${suiteKey}: a paid registration division needs either the PlanSql seam or an explicit connectAccount override ` +
            "to attach STRIPE_CONNECT_TEST_ACCOUNT to this run's org",
        );
      }
      connectPreviousHolder = await connect.claim(orgId, connectAccountId);
      connectClaimed = true;
      log.info(
        { org: orgId, previousHolder: connectPreviousHolder },
        `${suiteKey}: claimed STRIPE_CONNECT_TEST_ACCOUNT for this run's org (restored on the way out)`,
      );
    }

    try {
      for (const division of registrationDivisionsOf(pack)) {
        const block = pack.registration?.byDivision[division.ref];
        if (block === undefined) continue; // registrationDivisionsOf already filtered this; narrows the type for TS below.

        const resolvedEntry = resolveEntryMode(
          division.entry,
          pack.suite,
          input.cliEntry,
        );
        if (resolvedEntry === "admin") {
          const skipped = `${suiteKey}: registration "${division.ref}": resolved to admin and SKIPPED — _tiny carries no admin-equivalent seed data for it, so this run proves nothing about registration.`;
          log.info({ division: division.ref }, skipped);
          // The warning, not just the log line, is what makes the skip legible.
          // Without it `--entry admin` renders a report with NO Registration
          // section at all, and a reader cannot tell "the pack declares no
          // registration divisions" from "one was declared and stepped over" —
          // an absent symptom reading as a pass, which is exactly what
          // ORGANISER_FORCE_UNPROVEN_NOTE exists to prevent one seam over.
          warnings.push(skipped);
          continue;
        }

        const funnelStart = performance.now();
        log.info(
          { division: division.ref, resolvedEntry },
          `${suiteKey}: creating + configuring a registration division`,
        );
        // Created DIRECTLY over HTTP, never through seedSuite/seedPlan above —
        // see build-packs/_tiny.ts's own comment on `d-registration` for why.
        const createdDivision = await t.request<IdOut>(
          base,
          s,
          `/api/v1/competitions/${seeded.competitionId}/divisions`,
          {
            method: "POST",
            body: {
              name: division.name,
              sport_key: division.sportKey,
              variant_key: division.variantKey,
              config: division.cfgOverrides,
              ...(division.tiebreakers === undefined
                ? {}
                : { tiebreakers: division.tiebreakers }),
            },
          },
        );
        const divisionId = createdDivision.id;

        // The SERVER's slug, never the pack's. `plan.org.slug` is what the pack
        // declares; the backend auto-provisions the org and names it itself, so
        // the two differ on every real run (`bench-tiny-club` vs
        // `my-organization-2`). Every public surface the browser driver touches
        // is addressed by this slug — `/shared/{orgSlug}/...` and `/o/{orgSlug}/...`
        // — and the pack's value resolves to a 404 whose HTTP 200 chrome renders
        // without the wizard, so the failure surfaced as a Playwright timeout on
        // a correct selector rather than as a bad URL. See `PlanSql.getOrgSlug`.
        const resolveOrgSlug =
          input.resolveOrgSlug ??
          (async (id: string) => {
            if (input.sql === undefined) {
              throw new Error(
                `${suiteKey}: registration division "${division.ref}" needs either the PlanSql seam or an explicit resolveOrgSlug ` +
                  `to read the server-assigned org slug — every /shared/ and /o/ URL is addressed by it, and the pack's ` +
                  `declared slug is not what the backend minted`,
              );
            }
            return input.sql.getOrgSlug(id);
          });
        const orgSlug = await resolveOrgSlug(orgId);
        const competitionSlug = plan.competition.slug;
        if (competitionSlug === undefined) {
          throw new Error(
            `${suiteKey}: registration division "${division.ref}" needs the competition's own slug (RegistrationDivisionTarget) — the pack declares none`,
          );
        }

        const driverCtx: RegistrationDriverContext = {
          base,
          email,
          orgSlug,
          competitionSlug,
          entryExtKeys: block.entries.map((e) => e.extKey),
          joinPersonRefs: block.joins.map((j) => j.person),
        };
        const drivers = await (
          input.registrationDrivers ?? buildRealRegistrationDrivers
        )(resolvedEntry, driverCtx);
        const personsByRef = new Map(pack.persons.map((p) => [p.ref, p]));

        try {
          const result = await runRegistrationDivision({
            divisionRef: division.ref,
            divisionId,
            target: { orgSlug, competitionSlug, divisionId },
            block,
            personsByRef,
            runTag,
            organiser: drivers.organiser,
            makeCaptain: drivers.makeCaptain,
            makePlayer: drivers.makePlayer,
            // `_tiny`'s own registration division declares no joins[] — see
            // `DivisionRunnerInput.resolveJoinCode`'s own doc comment (G2,
            // B03r-repins-2026-09-03.md) for why this stays a required,
            // no-default resolver rather than a silent empty-string fallback.
            resolveJoinCode: () => {
              throw new Error(
                `${suiteKey}: registration division "${division.ref}" declares no joins[] — resolveJoinCode should never be called`,
              );
            },
            fetchFinalRows: async () => {
              const rows = await t.request<
                {
                  id: string;
                  status: FunnelRow["status"];
                  amount_cents: number;
                  entry_payment_intent_id: string | null;
                }[]
              >(base, s, `/api/v1/divisions/${divisionId}/registrations`);
              return new Map(
                rows.map((r) => [
                  r.id,
                  {
                    registrationId: r.id,
                    status: r.status,
                    amountCents: r.amount_cents,
                    paymentIntentId: r.entry_payment_intent_id,
                  },
                ]),
              );
            },
          });

          for (const freeAgentWarning of result.freeAgentWarnings)
            warnings.push(
              `${suiteKey}: registration "${division.ref}": ${freeAgentWarning}`,
            );
          for (const finding of result.funnel.findings) {
            errors.push(
              `registration "${division.ref}": ${finding.code} — ${finding.message}`,
            );
          }

          // rejectedEligibility/rejectedManual: derived from the pack's OWN
          // declared `expect` (report.ts task 8's own doc comment — a plain
          // `FunnelResult` carries no such split, only findings, and
          // `DivisionRunnerResult` exposes no per-entry final classification
          // this file could tally directly without duplicating
          // `runRegistrationDivision`'s own internal work). Accurate whenever
          // the run is green (design §9's expected case for `_tiny`); an entry
          // whose finding fired above is EXCLUDED from either bucket rather
          // than guessed, since the finding already names its real mismatch.
          const findingExtKeys = new Set(
            result.funnel.findings.map((f) => f.extKey),
          );
          let rejectedEligibility = 0;
          let rejectedManual = 0;
          for (const entry of block.entries) {
            if (findingExtKeys.has(entry.extKey)) continue;
            if (entry.expect === "rejected_eligibility")
              rejectedEligibility += 1;
            if (entry.expect === "rejected_manual") rejectedManual += 1;
          }

          registrationReports.push({
            divisionRef: division.ref,
            entries: block.entries.length,
            entrants: result.funnel.entrants,
            waitlisted: result.funnel.waitlisted,
            rejectedEligibility,
            rejectedManual,
            paidCents: result.funnel.paidCents,
            organiserForceEligibilityProven:
              result.funnel.organiserForceEligibilityProven,
            funnelWallMs: Math.round(performance.now() - funnelStart),
          });
          log.info(
            {
              division: division.ref,
              funnelOk: result.funnel.ok,
              entrants: result.funnel.entrants,
            },
            `${suiteKey}: registration division funnel complete`,
          );
        } finally {
          await drivers.dispose();
        }
      }
    } finally {
      if (connectClaimed && connectAccountId !== undefined) {
        const connect =
          input.connectAccount ??
          (input.sql === undefined
            ? undefined
            : {
                claim: (id: string, account: string) =>
                  input.sql!.claimConnectAccount(id, account),
                release: (id: string, prev: string | null, account: string) =>
                  input.sql!.releaseConnectAccount(id, prev, account),
              });
        // Best-effort: a failure to hand the account back must not replace the
        // real error that got us here, but it must not be silent either — the
        // next smoke run's paid suites are what pays for it.
        try {
          await connect?.release(
            orgId,
            connectPreviousHolder,
            connectAccountId,
          );
        } catch (releaseErr) {
          warnings.push(
            `${suiteKey}: FAILED to release STRIPE_CONNECT_TEST_ACCOUNT back to ${connectPreviousHolder ?? "nobody"} — ` +
              `smoke's paid suites will skip until it is restored by hand: ` +
              `${releaseErr instanceof Error ? releaseErr.message : String(releaseErr)}`,
          );
        }
      }
    }
    // -----------------------------------------------------------------
    // B06a T7 — NEWS: publish some of what folding drafted, and prove the
    // rest is still a draft.
    //
    // LAST, deliberately: after the league folds, after the stage advancement
    // and after the registration funnel. Drafting is a side effect of folding,
    // so a news step placed before the advancement block reports NO DRAFT for
    // the very stage this suite cares most about — `_tiny`'s playoff is folded
    // there, and running earlier reported "no draft for fx-8" on a run where
    // the product had done nothing wrong.
    //
    // `report.news` has been declared since B01 and written by nothing. The
    // reason was never neglect: until the step above turned `auto_posts` on,
    // the product had drafted nothing for this bench to report.
    //
    // The fire-once effect is NOT HTTP-observable. `shouldFirePostPublished`
    // (`org-posts.ts:317-318`) fires a PostHog `captureServer` call and
    // nothing else — no row, no outbox, no webhook — so this asserts the
    // PREDICATE by proxy instead: `published_at` is assigned only when it was
    // null (`:276,282`), so a second publish must not move it. That is the one
    // thing `prevStatus !== "published"` protects that a client can see.
    if (input.sql !== undefined && newsEnable !== undefined && newsEnable.enabled > 0) {
      try {
        const newsTransport = input.oracleTransport ?? defaultProbeTransport;
        // Publish the semis and the final of the LAST stage — not the whole
        // stage (B07a Task 12 / Ruling R70) — and a proper SUBSET so what
        // stays draft is provable. Derived from the pack, never a count
        // typed in here. `fixtureKey`, never a hand-built string: the map is
        // keyed by `JSON.stringify([divisionRef, extKey])`
        // (`pack-schema.ts:1579`) — a delimiter join misses EVERY entry, and
        // it misses silently: the list comes back empty and the two oracles
        // below report NO SUBJECT, which reads exactly like a suite that
        // legitimately drafted nothing.
        const lastStage = division0.stages[division0.stages.length - 1];
        const division0Streams = pack.streams.filter((st) => st.divisionRef === division0.ref);
        const lastStageStreams =
          lastStage === undefined ? [] : division0Streams.filter((st) => st.stageRef === lastStage.ref);
        const targets = publishTargets(lastStageStreams);
        if (targets.unparsedKeys.length > 0) {
          warnings.push(
            `${suiteKey}: news publish skipped ${targets.unparsedKeys.length} last-stage fixture key(s) that ` +
              `do not match se-r{n}-i{i}, so they were neither published nor counted toward the top two rounds: ` +
              targets.unparsedKeys.join(", "),
          );
        }
        const publishFixtureIds = targets
          .map((extKey) => seeded.fixtureIdByKey.get(fixtureKey(division0.ref, extKey)))
          .filter((id): id is string => id !== undefined);

        const news = await runNewsStep({
          base,
          session: s,
          orgId,
          competitionId: seeded.competitionId,
          publishFixtureIds,
          transport: newsTransport,
        });
        newsSummary = { drafted: news.drafted, published: news.published };

        // 1. Did folding draft anything at all? Five preconditions can each
        //    legitimately produce zero, so zero is NO SUBJECT — never a pass.
        const draftVerdict = news.drafted === 0 ? "no_subject" : "pass";
        oracles.push({
          name: "news: folding drafted posts",
          passed: true,
          verdict: draftVerdict,
          subject: news.drafted > 0,
          detail:
            news.drafted === 0
              ? "auto-posting was on and every fixture decided, yet NOTHING drafted — this oracle compared nothing"
              : `${news.drafted} draft(s) exist for this run's competition after the folds`,
        });
        log.info(oracleLogFields("news_drafted", draftVerdict), "oracle_checked");
        if (news.drafted === 0) {
          warnings.push(
            `${suiteKey}: auto-posting was enabled on ${newsEnable.enabled} division(s) and the folds still drafted ` +
              "NO posts — the news step has no subject and proves nothing",
          );
        }

        // 2. Publishing, and the half that matters more: what stayed draft.
        //    A run that published everything has not proven the draft state
        //    exists at all.
        const askedFor = publishFixtureIds.length;
        const publishVerdict =
          askedFor === 0 || news.drafted === 0
            ? "no_subject"
            : news.published === askedFor && news.requestedButNotDrafted.length === 0 && news.stillDraft > 0
              ? "pass"
              : "fail";
        oracles.push({
          name: "news: the named fixtures publish and the rest stay draft",
          passed: publishVerdict !== "fail",
          verdict: publishVerdict,
          subject: publishVerdict !== "no_subject",
          detail:
            publishVerdict === "no_subject"
              ? "nothing was drafted or nothing was asked for — this oracle compared nothing"
              : `${news.published}/${askedFor} named fixture(s) published, ${news.stillDraft} post(s) still draft` +
                (news.requestedButNotDrafted.length === 0
                  ? ""
                  : ` — no draft existed for ${news.requestedButNotDrafted.join(", ")}`) +
                (news.stillDraft === 0 ? " — NOTHING stayed draft, so the draft state is unproven" : ""),
        });
        log.info(oracleLogFields("news_published", publishVerdict), "oracle_checked");
        if (publishVerdict === "fail") {
          errors.push(
            `news: expected ${askedFor} named fixture(s) to publish with the rest left draft, got ` +
              `${news.published} published and ${news.stillDraft} still draft` +
              (news.requestedButNotDrafted.length === 0
                ? ""
                : ` (no draft for ${news.requestedButNotDrafted.join(", ")})`),
          );
        }

        // 3. The fire-once proxy.
        const republishVerdict = !news.republishProbed ? "no_subject" : news.republishWasInert ? "pass" : "fail";
        oracles.push({
          name: "news: a republish does not move published_at",
          passed: republishVerdict !== "fail",
          verdict: republishVerdict,
          subject: news.republishProbed,
          detail: !news.republishProbed
            ? "nothing was published, so the fire-once predicate was never probed — this oracle compared nothing"
            : news.republishWasInert
              ? "publishing an already-published post left published_at where it was"
              : "publishing an already-published post MOVED published_at — the fire-once guard is not holding",
        });
        log.info(oracleLogFields("news_republish_inert", republishVerdict), "oracle_checked");
        if (republishVerdict === "fail") {
          errors.push(
            "news: a second publish of an already-published post moved published_at — `shouldFirePostPublished` " +
              "would fire twice, and its effect is analytics-only so nothing else can witness it",
          );
        }

        log.info(
          {
            drafted: news.drafted,
            published: news.published,
            stillDraft: news.stillDraft,
            republishProbed: news.republishProbed,
            republishWasInert: news.republishWasInert,
          },
          `${suiteKey}: news drafted and published (B06a T7)`,
        );
      } catch (err) {
        const detail = err instanceof Error ? err.message : String(err);
        errors.push(`news: the news step FAILED before it could report — ${detail}`);
        oracles.push({
          name: "news: folding drafted posts",
          passed: false,
          verdict: "fail",
          subject: true,
          detail: `the news step threw before reporting: ${detail}`,
        });
        log.info(oracleLogFields("news_drafted", "fail"), "oracle_checked");
      }
    }

  } catch (err) {
    errors.push(err instanceof Error ? err.message : String(err));
  }

  // B07a T10 — the tap player owns a real browser: closed after the run
  // whatever happened above, so a thrown step never leaves Chromium running.
  if (tapState.player !== undefined) {
    try {
      await tapState.player.close();
    } catch (err) {
      warnings.push(`${suiteKey}: closing the tap player failed — ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  // Warnings are REPORTED, never gated on. Stage 0 names what it does not
  // derive offline; that is a fact the report has to carry, and a gate that
  // read it would red `_tiny` on every run for saying something true.
  const provenance = computeProvenance(pack);
  const gate = errors.length === 0 ? "green" : "red";
  return {
    suite: suiteKey,
    gate,
    timings,
    keep,
    solver: {
      engine: solver?.engine,
      requestedEngine: engine,
      status: solver?.status,
    },
    conflictCount,
    // B06a task 5 — the honesty number design §4 asks every suite to publish.
    // The field has existed since B01 with no writer, so every report before
    // this one carried it undefined.
    provenancePct: provenance.realPct,
    provenance,
    // B07a T3 — `report.adaptations` has been declared since B01 with no
    // writer, for the same reason `provenancePct` had none until T5 above:
    // nothing ever mapped the pack's own §7A list into the report. So every
    // report so far published how much of a pack was GENERATED without ever
    // saying what was RESHAPED to get there — the other half of the same
    // honesty claim, and the half a thin-data pack leans on hardest.
    //
    // Written on EVERY return that got a pack, empty list included: a run
    // that loaded a pack HAS measured this, and `[]` is that pack saying it
    // reshaped nothing. The two `--keep` short circuits above carry it for
    // the same reason — `--keep` is the DEFAULT (`bench.ts`'s
    // `keep: !values.wipe`), so those, not this one, are the ordinary
    // re-run shape. The field is absent on exactly one return in this
    // function: the stage-0 refusal, which gives up before a pack exists.
    adaptations: pack.meta.adaptations.map(formatAdaptation),
    errors: errors.length > 0 ? errors : undefined,
    ...(warnings.length > 0 ? { warnings } : {}),
    ...(oracles.length > 0 ? { oracles } : {}),
    ...(registrationReports.length > 0
      ? { registration: registrationReports }
      : {}),
    // B04. `scheduling` is OMITTED rather than sent empty for a run that never
    // reached the layer: an empty array renders a "Scheduling" section with no
    // rows, which reads as "this suite scheduled nothing and that was fine".
    // `engineDelta` follows the same rule and is set only inside the layer.
    ...(scheduling.length > 0 ? { scheduling } : {}),
    ...(engineDelta === undefined ? {} : { engineDelta }),
    // F-T6-3. Omitted when empty — a rendered "cross-division clashes: none"
    // on every pre-B04 report would be noise — but never omitted when it
    // fired, because nothing else in the run can see it.
    ...(crossDivisionClashes.length > 0 ? { crossDivisionCourtClashes: crossDivisionClashes } : {}),
    ...(divisionStart === undefined || divisionStart.length === 0 ? {} : { divisionStart }),
    // `total` is every invite this run MINTED, not the subset it attempted —
    // a denominator that shrank to the attempted count would flatter the
    // number the same way a provenance total taken from known buckets would.
    ...(claimsSummary === undefined ? {} : { claims: claimsSummary }),
    ...(newsSummary === undefined ? {} : { news: newsSummary }),
    ...(simulation === undefined ? {} : { simulation }),
    ...(importSimulation === undefined ? {} : { importSimulation }),
    // B07a T10 — report-only. Absent unless a tapped match was actually handed
    // to the player; a division skipped for want of device links is a warning,
    // never a `matches: 0`.
    ...(tapState.report === undefined ? {} : { tapPlay: tapState.report }),
  };
}
