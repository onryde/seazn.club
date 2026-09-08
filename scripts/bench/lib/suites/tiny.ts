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
// by `seedSuite` (lib/seed.ts). `runTinySuite` itself still only DRIVES
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
// (`TinySuiteInput.transport`, defaulted to `seed.ts`'s own
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
import { fileURLToPath } from "node:url";
import type pino from "pino";
import { newSession, signIn, type Session } from "../http.ts";
import { formatFinding, loadPackFile } from "../pack-io.ts";
import { hashPack } from "../pack-hash.ts";
import { fixtureKey, type Pack, type PackDivision, type PackStream } from "../pack-schema.ts";
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
  type Board,
  type BoardFixture,
  type CertificateVerdict,
  type CheckerReport,
  type EncodedConstraints,
} from "../board.ts";
import {
  buildSeedPlan,
  type SeedPlan,
  type SeedPlanExpectedFixtureCount,
} from "../seed-plan.ts";
import {
  defaultTransport,
  runOfficialsAutoAssign,
  seedSuite,
  type FixtureOfficialRow,
  type SeededSuite,
  type SeedTransport,
} from "../seed.ts";
import { runDlsGateProbe, type ProbeTransport } from "../dls-gate.ts";
import { type PlanSql } from "../plan.ts";
import {
  readPlayerStatsBaseline,
  playerStatsBaselineIssues,
  type RosterMemberRef,
} from "../stats.ts";
import type {
  DivisionScheduleReport,
  DivisionStartConflictReport,
  DivisionStartReport,
  EngineDeltaSection,
  ImportFindingReport,
  ImportSimulationReport,
  OracleResult,
  RegistrationDivisionReport,
  SimulationReport,
  SolverResult,
  SuiteReport,
} from "../report.ts";
import { computeEventsPerSecond, simulateDivisionStreams } from "../simulate.ts";
import { buildImportId, importDivisionStreams, type ImportFinding } from "../import.ts";
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
  standingsRankOrder,
  type DivisionPlayerStatsWire,
  type ExpectedCareerStat,
  type ExpectedLeaderboardEntry,
  type ExpectedStandingsRow,
  type ExpectedSuspension,
  type PersonCareerStatsWire,
  type PersonStatsWire,
  type SuspensionFixtureSheet,
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

/** The committed micro-pack, resolved from THIS module rather than from the
 *  process cwd — the bench is run from the repo root by `npm run
 *  bench:scheduler` and from a worktree root by CI, and a cwd-relative path
 *  would silently read a different file (or none) between the two. */
export const TINY_PACK_PATH = fileURLToPath(
  new URL("../../packs/_tiny.json", import.meta.url),
);

/** The `--keep` idempotence marker's key inside `competitions.branding`
 *  (jsonb). Exported so a test can construct a matching/mismatching branding
 *  value without hand-typing the key twice. */
export const KEEP_BRANDING_KEY = "benchPackHash";

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
 * for `"registration-ui"`. `TinySuiteInput.registrationDrivers` overrides
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
    // via the SAME magic-link flow `runTinySuite`'s own `s` already used
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

export interface TinySuiteInput {
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
   * `runTinySuite` (this file's own test suite included) that does not know
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
 * `seeded.fixtureIdByKey.size` at the one call site (`runTinySuite` below) —
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
    notes.push("tiny: no division was seeded, so no fixture could be pinned and pin integrity is unchecked");
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

  if (fixtureId === undefined || typeof startAt !== "string" || courtId === undefined) {
    notes.push(
      `tiny: no fixture was pinned in "${ref}" — ` +
        `fixture=${fixtureId ?? `unresolved (stream ${stream?.fixtureExtKey ?? "none declared"})`}, ` +
        `startAt=${typeof startAt === "string" ? startAt : "not declared"}, ` +
        `court=${courtId ?? "unresolved"}. Design §3.3's pin-integrity rule has nothing to check this run, ` +
        "which is a named deferral rather than a rule that passed.",
    );
    return { locks, notes };
  }
  locks.set(ref, { fixtureId, scheduledAt: startAt, courtId });
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

export async function runTinySuite(
  input: TinySuiteInput,
): Promise<SuiteReport> {
  const { base, engine, keep, log } = input;
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

  // Stage 0 FIRST, and nothing is created if it refuses: a pack the offline
  // gate rejects would otherwise be seeded over HTTP and report a product
  // defect that is really an authoring one, minutes into a live run.
  const packPath = input.packPath ?? TINY_PACK_PATH;
  const staged = await tinyPackStage(packPath);
  warnings.push(...staged.warnings);
  if (!staged.ok) {
    log.error(
      { packPath, errors: staged.errors },
      "tiny: pack refused by stage 0",
    );
    return {
      suite: "_tiny",
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
    log.warn({ packPath, warnings }, "tiny: pack validated with warnings");

  try {
    // The identity used to sign in this run — see this file's header comment
    // on why `--keep` needs a FIXED tag and `--wipe` keeps the original
    // random one.
    const runTag = keep ? "keep" : randomUUID().slice(0, 8);
    const email = `bench-${plan.org.slug}-${runTag}@example.com`;

    const s: Session = newSession();
    const seedStart = performance.now();
    log.info({ email, keep }, "tiny: signing in");
    const { org_id: orgId } = await t.signIn(base, s, email);

    const lookup: SeedLookup = keep
      ? await findExistingSeed(base, s, t, plan, packHash)
      : { kind: "absent" };

    // A changed pack under an unchanged slug: refuse here, with the cause, and
    // create nothing. See `SeedLookup` above for why seeding on cannot work.
    if (lookup.kind === "stale") {
      const message =
        `tiny: --keep cannot reuse competition "${plan.competition.slug}" (${lookup.competitionId}) — it holds ` +
        `pack hash ${JSON.stringify(lookup.heldHash)} and this pack hashes to ${packHash}. The pack changed since ` +
        `the last --keep run, and (org_id, slug) is unique so a fresh seed would 409 on the same slug. ` +
        `Re-run with --wipe to reseed this suite from scratch.`;
      log.error(
        {
          competitionId: lookup.competitionId,
          heldHash: lookup.heldHash,
          packHash,
        },
        "tiny: --keep refused — pack changed under an existing competition slug",
      );
      return {
        suite: "_tiny",
        gate: "red",
        timings: { seedMs: Math.round(performance.now() - seedStart) },
        keep,
        solver: { requestedEngine: engine },
        errors: [message],
        ...(warnings.length > 0 ? { warnings } : {}),
      };
    }

    const existing = lookup.kind === "reuse" ? lookup : null;
    if (existing) {
      timings.seedMs = Math.round(performance.now() - seedStart);
      warnings.push(
        `tiny: --keep reused existing seed (org ${existing.orgId}, competition ${existing.competitionId}) — ` +
          `pack hash unchanged, seeding and scheduling skipped this run. No board, no checker, no certificate and ` +
          `no engine artifact were produced. Pass --wipe for any leg that must actually schedule (required for the ` +
          `second leg of the two-engine bench protocol — see B04-handoff-2026-09-05.md).`,
      );
      log.info(
        { orgId: existing.orgId, competitionId: existing.competitionId },
        "tiny: --keep short-circuited — reusing a prior run's seed",
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
        suite: "_tiny",
        gate: "skipped",
        timings,
        keep,
        solver: { requestedEngine: engine },
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
    // B05 T3: `division0` now legitimately declares a SECOND stage
    // (`s-playoff`, a knockout fed from the league) — `stage1`, undefined for
    // every pack (and division) that does not. Every existing reader of
    // `division0`/`stage0` above is unaffected; `stage1` is read only by the
    // advance step below.
    const division0 = plan.divisions[0];
    const stage0 = division0?.stages[0];
    const stage1 = division0?.stages[1];
    if (division0 === undefined || stage0 === undefined) {
      throw new Error(
        "tiny: the pack's plan has no division/stage to seed and schedule",
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
    // `TinySuiteInput.sql`'s own doc comment on why that is the deliberate
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
    if (input.sql !== undefined) {
      log.info(
        {},
        "tiny: running the cricket.dls entitlement-gate probe (B03 T7)",
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
      autoAssign = probe.officialsAutoGranted;
      // B03 review F1(a): the chosen plan is not guaranteed to grant every
      // capability this run wants (`chooseGrantingPlanForCapabilities` picks
      // the best available candidate, never invents one) — reported here,
      // never silently swallowed, when it does not.
      if (probe.unsatisfiedCapabilities.length > 0) {
        warnings.push(
          `tiny: plan "${probe.provisionedPlan}" (chosen because it grants cricket.dls) does not also grant ` +
            `${probe.unsatisfiedCapabilities.join(", ")} — no single plan on this catalog grants every ` +
            `capability this run wants`,
        );
      }
      statsPlayerGranted = probe.statsPlayerGranted;
      log.info(
        {
          provisionedPlan: probe.provisionedPlan,
          officialsAutoGranted: probe.officialsAutoGranted,
          unsatisfiedCapabilities: probe.unsatisfiedCapabilities,
          statsPlayerGranted,
        },
        "tiny: entitlement-gate probe complete",
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
        `tiny: seedSuite signed into org "${seeded.orgId}" but this suite's own session is on "${orgId}" ` +
          `— sign-in for "${email}" did not return the same org twice`,
      );
    }
    const divisionId = seeded.divisionIdByRef.get(division0.ref);
    const stageId = seeded.stageIdByRef.get(stage0.ref);
    if (divisionId === undefined || stageId === undefined) {
      throw new Error(
        `tiny: seedSuite resolved no id for division "${division0.ref}" / stage "${stage0.ref}"`,
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
    if (countIssue !== null) errors.push(countIssue);
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
    warnings.push(...lockResolution.notes);

    const scheduleDivisions: ScheduleDivision[] = [];
    for (const planned of seedPlan.divisions) {
      const plannedDivisionId = seeded.divisionIdByRef.get(planned.ref);
      const stage = planned.stages[0];
      const plannedStageId = stage === undefined ? undefined : seeded.stageIdByRef.get(stage.ref);
      if (plannedDivisionId === undefined || stage === undefined || plannedStageId === undefined) {
        // Never silent: a division that was seeded and then not scheduled is
        // indistinguishable in a report from one that was scheduled cleanly.
        errors.push(
          `tiny: division "${planned.ref}" was seeded but cannot be scheduled — ` +
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
          `tiny: division "${planned.ref}" declares ${planned.stages.length} stages and only "${stage.ref}" is scheduled — ` +
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
          `tiny: division "${planned.ref}" declares no scheduleConfig — nothing is PUT and the checker's oracle ` +
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
        try {
          certificate = certify({
            historical: pack.historicalAssignment,
            // NO PACK THE BENCH RUNS TODAY DECLARES HISTORY — `_tiny` has no
            // real-world timetable (design §7), so this is `undefined` and
            // `certify` answers SKIPPED_NO_HISTORY. The first pack that DOES
            // declare rows makes `certify` throw here, loudly, and that throw
            // is routed into `scheduleErrors` below rather than smoothed over:
            // rendering history into a `Board` is a real piece of work, and a
            // fallback that let the run continue would certify a timetable
            // against nothing and report FEASIBLE.
            historyBoard: undefined,
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
              `tiny: "${ref}" — the solver's PROPOSAL reports ${proposalUnplaced} unplaced ` +
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
        "tiny: running officials auto-assign (B03 review F1(b) — after schedule/apply)",
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
      log.info({ file, requestedEngine: engine, legEngine }, "tiny: engine artifact written");
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
            `tiny: division "${ref}" declares streams but has no resolved divisionId — cannot start it`,
          );
          continue;
        }
        divisionsToStart.push({ divisionRef: ref, divisionId: id });
      }
      if (divisionsToStart.length > 0) {
        log.info(
          { divisions: divisionsToStart.map((d) => d.divisionRef) },
          "tiny: starting the division(s) the folds below need (B05 T2.5, D9)",
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
          "tiny: player-stats baseline skipped — the entitlement-gate probe's own plan does not grant stats.player",
        );
      } else {
        log.info(
          { roster: roster.length },
          "tiny: reading the player-stats baseline (B03 T6b)",
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
    // actually comes about here, and for why the brief's expected proof pair
    // (a 422 ELIGIBILITY_VIOLATION on a lineup naming a banned player) is not
    // assertable: nothing on the lineup path reads the `suspensions` table.
    // The enforcement probe below MEASURES that on every run rather than
    // leaving it as a claim.
    //
    // Gated on `input.sql !== undefined`, like every other B05 step.
    if (input.sql !== undefined) {
      if (pack.expected.suspensions.length === 0) {
        // An EMPTY expected set is not a passing oracle — the same discipline
        // T5b-2's career block states. A green "discipline carry" line for a
        // pack that declares no ban is exactly the vacuity this wave removes.
        warnings.push(
          `oracle: pack declares no expected.suspensions rows — the discipline-carry oracle ` +
            `(compareSuspensions) has no subject and was NOT run`,
        );
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

          // (1) The PRODUCER, through the product's own two calls. A row this
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

          // (2) The ENFORCEMENT PROBE. The brief for this task expected a
          // 422 ELIGIBILITY_VIOLATION here. Measured on every run rather than
          // asserted either way: freezing today's answer as an expectation
          // would make a future enforcement gate look like a regression, and
          // asserting the brief's answer would red on the product as it is.
          // The correct sheet is written over this one immediately below —
          // `putLineup` REPLACES an entrant's whole lineup — so the stored
          // state the oracle then reads is unaffected by the probe.
          const probeFixture = targets.find((f) => f.missed);
          if (probeFixture !== undefined) {
            const probe = await putFixtureLineup(
              base,
              s,
              probeFixture.fixtureId,
              susEntrantId,
              [controlPersonId, bannedPersonId],
              input.oracleTransport,
            );
            const refused = probe.status >= 400;
            warnings.push(
              `discipline enforcement probe: naming the ACTIVE-suspended "${sus.person}" on the team sheet of ` +
                `"${probeFixture.extKey}" (the fixture the pack says they miss) answered HTTP ${probe.status}` +
                `${probe.code === undefined ? "" : ` ${probe.code}`} — ` +
                (refused
                  ? `the lineup gate REFUSED it, so discipline is enforced on this path`
                  : `the lineup gate ACCEPTED it. Discipline is ADVISORY in this product: putLineup calls ` +
                    `gateRosterEligibility, and neither it nor rosterIssues beneath it reads the suspensions ` +
                    `table — every reader of that table is a display surface or the stage-rebuild guard`),
            );
          }

          // (3) The team sheets the oracle actually compares: the banned
          // player OFF every fixture the pack names, ON every fixture it does
          // not; the eligible team-mate on all of them.
          const sheets: SuspensionFixtureSheet[] = [];
          const writeFailures: string[] = [];
          for (const target of targets) {
            const wanted = target.missed ? [controlPersonId] : [controlPersonId, bannedPersonId];
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
              continue;
            }
            // Read BACK, never the PUT's own echo.
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

          // (4) The comparison, against the product's own active-ban list.
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
            { kind: "suspension_carry", passed: susCheck.matched, division: sus.divisionRef },
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

    // B05 T1 — the single-event write-path fold (design doc §3 D4): division
    // A's own streams (`division0` — this file's own "declares exactly one
    // FIRST division" comment above is why that index is always the division
    // the pack calls A) folded through the LIVE `POST /fixtures/{id}/events`
    // route, strictly sequential per fixture (`simulate.ts`'s own header
    // comment). Division B's import path is a SEPARATE task (T2) — this
    // block touches only `division0`'s streams.
    //
    // Gated on `input.sql`, placed AFTER the player-stats baseline above on
    // purpose: that baseline's own oracle asserts EMPTY rows ("B03 folds no
    // score events") and would go stale the moment real events land on
    // division A's fixtures — running the fold first would silently turn a
    // correct baseline oracle into a wrong one for every future `input.sql`
    // caller. Ordered AFTER, this step touches nothing the baseline already
    // read.
    //
    // B05 T3: scoped to `stage0`'s OWN streams, never `stage1`'s (a
    // progression-fed stage's fixture has no real entrants until the advance
    // step below confirms them — folding it here would score a TBD fixture
    // before it exists as anything but a placeholder). A stream naming no
    // stage still counts when the division has exactly one — the same
    // "absent means the division's only stage" convention `validate-pack.ts`'s
    // own `resolveStage` uses — so no pack before this task sees any change.
    // `stage1`'s own stream is folded separately, after the advance step,
    // reusing this exact function (see that block's own comment for why: the
    // acceptance bar is "the existing fold covers it", not a new primitive).
    if (input.sql !== undefined) {
      const divisionAStreams = pack.streams.filter(
        (st) =>
          st.divisionRef === division0.ref &&
          (st.stageRef === undefined
            ? division0.stages.length === 1
            : st.stageRef === stage0.ref),
      );
      if (divisionAStreams.length > 0) {
        // `@`-sigilled payload refs (pack-schema.ts header note 6) name
        // EITHER an entrant or a person — ONE namespace, so merging both
        // maps is exactly as authoritative as keeping them separate.
        const refIdByKey = new Map<string, string>([
          ...seeded.entrantIdByRef,
          ...seeded.personIdByRef,
        ]);
        log.info(
          { streams: divisionAStreams.length },
          "tiny: folding division A's streams through the single-event scoring route (B05 T1)",
        );
        const sim = await simulateDivisionStreams({
          base,
          session: s,
          streams: divisionAStreams,
          fixtureIdByKey: seeded.fixtureIdByKey,
          refIdByKey,
          ...(input.simTransport === undefined
            ? {}
            : { transport: input.simTransport }),
        });
        timings.simMs = sim.wallMs;
        simulation = {
          eventsSent: sim.eventsSent,
          wallMs: sim.wallMs,
          eventsPerSecond: sim.eventsPerSecond,
          ...(sim.findings.length > 0 ? { findings: [...sim.findings] } : {}),
        };
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
        log.info(
          // B05 T2 — `path` added so this event and the batch-import fold's
          // own `suite_simulated` below are distinguishable in a log stream
          // by more than which fields happen to be present.
          { events: sim.eventsSent, ms: sim.wallMs, eventsPerSecond: sim.eventsPerSecond, path: "single" },
          "suite_simulated",
        );
      }
    }

    // B05 T2 — the batch write-path fold (design doc §3 D4): every OTHER
    // division's own streams (never `division0` — that is `simulate.ts`'s
    // job, immediately above) folded through the LIVE
    // `POST /divisions/{id}/events/import` route. `_tiny.json` declares
    // exactly one such division today (`d-badminton`); grouped by
    // `divisionRef` rather than hardcoding that name, so a future pack
    // adding a third streamed division folds it too, aggregated into the
    // same report section (T7 owns splitting that presentation out per
    // division, if it ever needs to be).
    //
    // Gated on `input.sql`, same as division A's block — a unit test with no
    // `sql` gets today's behavior unchanged.
    if (input.sql !== undefined) {
      const otherStreamsByDivisionRef = new Map<string, PackStream[]>();
      for (const st of pack.streams) {
        if (st.divisionRef === division0.ref) continue;
        const group = otherStreamsByDivisionRef.get(st.divisionRef) ?? [];
        group.push(st);
        otherStreamsByDivisionRef.set(st.divisionRef, group);
      }
      if (otherStreamsByDivisionRef.size > 0) {
        const refIdByKey = new Map<string, string>([
          ...seeded.entrantIdByRef,
          ...seeded.personIdByRef,
        ]);
        const importStart = performance.now();
        let importEventsSent = 0;
        const importFindings: ImportFinding[] = [];
        let importChunks = 0;
        for (const [divisionRef, streams] of otherStreamsByDivisionRef) {
          const divisionId = seeded.divisionIdByRef.get(divisionRef);
          if (divisionId === undefined) {
            // Never silent: a division that declares streams but was never
            // seeded/scheduled is indistinguishable in a report from one the
            // import fold simply skipped.
            errors.push(
              `tiny: division "${divisionRef}" declares streams but has no resolved divisionId — ` +
                "cannot fold them through the import route",
            );
            continue;
          }
          log.info(
            { division: divisionRef, streams: streams.length },
            "tiny: folding division B's streams through the batch-import route (B05 T2)",
          );
          const imp = await importDivisionStreams({
            base,
            session: s,
            divisionId,
            importId: buildImportId(divisionRef, input.runId),
            streams,
            fixtureIdByKey: seeded.fixtureIdByKey,
            refIdByKey,
            ...(input.importTransport === undefined
              ? {}
              : { transport: input.importTransport }),
          });
          importEventsSent += imp.eventsSent;
          importChunks += imp.chunks;
          importFindings.push(...imp.findings);
        }
        const importWallMs = Math.round(performance.now() - importStart);
        timings.importMs = importWallMs;
        importSimulation = {
          eventsSent: importEventsSent,
          wallMs: importWallMs,
          eventsPerSecond: computeEventsPerSecond(importEventsSent, importWallMs),
          chunks: importChunks,
          ...(importFindings.length > 0
            ? { findings: importFindings.map(toImportFindingReport) }
            : {}),
        };
        // Same D5 discipline as division A's block: a refusal/oversize/
        // not-imported finding is reported and never silently retried, and —
        // for `_tiny`'s own real historical streams — also a genuine product
        // defect (the pack's events are meant to fold cleanly), so it reds
        // the run rather than staying a quiet report-only note.
        for (const finding of importFindings) {
          errors.push(`import: ${describeImportFinding(finding)}`);
        }
        log.info(
          // Same event name as division A's fold above (`suite_simulated`),
          // same core fields (events/ms/eventsPerSecond), plus `path` to
          // distinguish which write path produced this line, and `chunks`
          // (meaningless for the single-event door, so not present there).
          {
            events: importEventsSent,
            ms: importWallMs,
            eventsPerSecond: computeEventsPerSecond(importEventsSent, importWallMs),
            chunks: importChunks,
            path: "import",
          },
          "suite_simulated",
        );
      }
    }

    // B05 T4b — the standings comparator (design doc §3, oracle.ts's
    // `compareStandings`), wired against EVERY `expected.tables` row the
    // pack declares — not only the final stage's placement crossing T4
    // already wires above. T4 built and unit-tested this comparator but
    // reached it from nothing on a real run (AGENTS.md failure class 1, the
    // inert seam — the exact thing this whole wave exists to close;
    // `b05-oracle-comparators.md`'s own vacuity note). Gated on
    // `input.sql !== undefined` only — unlike T3's advance step below, this
    // does NOT depend on `stage1?.progression`: `d-badminton` (T2's
    // batch-import division, folded just above) carries its own
    // `expected.tables` row and is never advanced through a progression at
    // all, so a gate on `stage1?.progression` would leave it permanently
    // unreached.
    if (input.sql !== undefined) {
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
        const tableCheck = compareStandings(expectedRows, standingsWire.rows);
        oracles.push({
          name: `oracle: ${table.divisionRef}/${table.stageRef} standings table`,
          passed: tableCheck.matched,
          detail: tableCheck.matched
            ? `live standings for "${table.stageRef}" match the pack's expected.tables row`
            : renderStandingsMismatch(tableCheck),
        });
        log.info({ kind: "standings_table", passed: tableCheck.matched }, "oracle_checked");
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
          warnings.push(
            `oracle: division "${table.divisionRef}" declares no tiebreakers — tie-order cascade oracle ` +
              `skipped for "${table.stageRef}"`,
          );
        } else {
          const cascade = tableDivision.tiebreakers;
          const cascadeCheck = compareTieOrderCascade(cascade, standingsWire.rows);
          oracles.push({
            name: `oracle: ${table.divisionRef}/${table.stageRef} tie-order cascade`,
            passed: cascadeCheck.matched,
            detail: cascadeCheck.matched
              ? `live order agrees with cascade [${cascade.join(",")}] on every tied pair ` +
                `(${cascadeCheck.checkedPairs} checked, ${cascadeCheck.skippedPairs} skipped)`
              : cascadeCheck.issues.map((i) => i.detail).join("; "),
          });
          log.info({ kind: "tie_order_cascade", passed: cascadeCheck.matched }, "oracle_checked");
          if (!cascadeCheck.matched) {
            errors.push(
              `oracle: ${table.divisionRef}/${table.stageRef}: live order disagrees with the division's own ` +
                `cascade [${cascade.join(",")}] — ${cascadeCheck.issues.map((i) => i.detail).join("; ")}`,
            );
          }
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
        log.info({ kind: "leaderboard", passed: boardCheck.matched }, "oracle_checked");
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
        const cardsChecked = expectedEntries.length;
        const cardsMatched = cardsChecked > 0 && cardIssues.length === 0;
        oracles.push({
          name: `oracle: ${board.divisionRef} person cards (${board.metricKey})`,
          passed: cardsMatched,
          detail: cardsMatched
            ? `each of the ${cardsChecked} person(s) on this board carries the SAME "${board.metricKey}" count ` +
              `on their own /persons/{id}/stats card for "${board.divisionRef}"`
            : cardsChecked === 0
              ? `expected.leaderboards "${board.divisionRef}"/"${board.metricKey}" resolved ZERO person entries — ` +
                `nothing was cross-checked against /persons/{id}/stats`
              : renderSideBySide(cardIssues),
        });
        log.info({ kind: "person_division_stat", passed: cardsMatched }, "oracle_checked");
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
        warnings.push(
          `oracle: pack declares no expected.careers rows — the cross-division career rollup oracle ` +
            `(compareCareerStats) has no subject and was NOT run`,
        );
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
          const careerPersonId = expectedCareers[0]!.personId;
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
          log.info({ kind: "career_stats", passed: careerCheck.matched }, "oracle_checked");
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

    // B05 T3 — stage advancement (design doc §3 D1/D7): `division0`'s second
    // stage, `stage1`, when it declares a `progression` (a `timing:"setup"`
    // knockout fed from `stage0`'s standings, in `_tiny`'s own case) is
    // advanced through the LIVE `propose -> assert -> confirm -> generate`
    // flow (`advance.ts`), its own stream folded through the SAME
    // `simulateDivisionStreams` T1 uses above, and completed with the
    // `finalRanks` response CAPTURED (D1 — it is the only time they cross the
    // wire; `GET /divisions/{id}/history` never carries the payload).
    //
    // Gated on `input.sql`, same as every other B05 step — a unit test with
    // no `sql` gets today's behavior unchanged. A no-op for any pack (or
    // division) whose second stage declares no `progression`: `_tiny` is the
    // only pack this bench runs, and its OTHER two divisions
    // (d-badminton, d-registration) are both single-stage.
    if (input.sql !== undefined && stage1?.progression !== undefined) {
      const sourceStageId = seeded.stageIdByRef.get(stage0.ref);
      const targetStageId = seeded.stageIdByRef.get(stage1.ref);
      if (sourceStageId === undefined || targetStageId === undefined) {
        errors.push(
          `tiny: division "${division0.ref}" declares a progression-fed stage "${stage1.ref}" but one of ` +
            `its own stage ids ("${stage0.ref}" / "${stage1.ref}") never resolved — cannot advance it`,
        );
      } else {
        // The expected qualifier order (D7's "expected qualifier list"),
        // derived from the SOURCE stage's own `expected.tables` row — the
        // pack's already-authored, already-offline-checked final standings
        // for `stage0`, resolved from refs to the REAL entrant ids `seedSuite`
        // minted. Assumes the progression's own take rule pulls every ranked
        // entrant of that table, in order (true of `_tiny`'s own
        // `rankRange(1, N)` — a future pack with a NARROWER take, e.g. top 2
        // of 8, would need this sliced to the qualifier count, out of this
        // task's scope).
        const sourceTable = pack.expected.tables.find(
          (t) => t.divisionRef === division0.ref && t.stageRef === stage0.ref && t.poolKey === undefined,
        );
        const expectedQualifierEntrantIds: string[] = [];
        const unresolvedQualifierRefs: string[] = [];
        for (const row of [...(sourceTable?.rows ?? [])].sort((a, b) => a.rank - b.rank)) {
          const id = seeded.entrantIdByRef.get(row.entrant);
          if (id === undefined) unresolvedQualifierRefs.push(row.entrant);
          else expectedQualifierEntrantIds.push(id);
        }
        if (sourceTable === undefined || unresolvedQualifierRefs.length > 0) {
          errors.push(
            sourceTable === undefined
              ? `tiny: stage "${stage1.ref}" declares a progression from "${stage0.ref}" but the pack carries ` +
                `no expected.tables row for "${stage0.ref}" — there is no expected qualifier order to assert ` +
                "against before confirming (D7)"
              : `tiny: stage "${stage0.ref}"'s expected table names entrant ref(s) with no resolved id: ` +
                `${unresolvedQualifierRefs.join(", ")}`,
          );
        } else {
          log.info(
            { sourceStage: stage0.ref, targetStage: stage1.ref, expected: expectedQualifierEntrantIds },
            "tiny: advancing the progression-fed stage (B05 T3)",
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
          oracles.push({
            name: `advance: ${stage1.ref} seed proposal qualifiers`,
            passed: qc.matched,
            detail: qc.matched
              ? `proposal qualifiers [${qc.actual.join(", ")}] match the pack's expected order`
              : `proposal qualifiers [${qc.actual.join(", ")}] disagree with the pack's expected order ` +
                `[${qc.expected.join(", ")}] — confirm/generate/complete were never called for "${stage1.ref}" (D7)`,
          });
          if (!qc.matched) {
            errors.push(
              `advance: ${stage1.ref}: seed proposal qualifiers [${qc.actual.join(", ")}] disagree with the ` +
                `pack's expected order [${qc.expected.join(", ")}]`,
            );
          } else {
            // The newly-confirmed stage's OWN stream(s), folded through the
            // SAME single-event route T1 uses above — reusing that function
            // is the acceptance bar (T3's brief: "the existing fold covers
            // it", not a new folding primitive). Explicit `stageRef` match
            // only: `division0` now has more than one stage, so the "absent
            // means the division's only stage" fallback (T1's own block)
            // does not apply here.
            const stage1Streams = pack.streams.filter(
              (st) => st.divisionRef === division0.ref && st.stageRef === stage1.ref,
            );
            if (stage1Streams.length > 0) {
              const refIdByKey = new Map<string, string>([
                ...seeded.entrantIdByRef,
                ...seeded.personIdByRef,
              ]);
              const advSim = await simulateDivisionStreams({
                base,
                session: s,
                streams: stage1Streams,
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
              (fr) => fr.divisionRef === division0.ref && fr.stageRef === stage1.ref,
            );
            if (expectedFinalRanksRow === undefined) {
              errors.push(
                `tiny: stage "${stage1.ref}" completed but the pack declares no expected.finalRanks row for it — ` +
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
                  `tiny: stage "${stage1.ref}"'s expected.finalRanks names entrant ref(s) with no resolved id: ` +
                    `${unresolvedFinalRankRefs.join(", ")}`,
                );
              } else {
                const franksCheck = compareFinalRanks(expectedIds, completion.finalRanks);
                oracles.push({
                  name: `advance: ${stage1.ref} finalRanks`,
                  passed: franksCheck.matched,
                  detail: franksCheck.matched
                    ? `captured finalRanks [${(franksCheck.actual ?? []).join(", ")}] match the pack's expected order`
                    : `captured finalRanks [${franksCheck.actual === undefined ? "(absent — stage did not report complete)" : franksCheck.actual.join(", ")}] ` +
                      `disagree with the pack's expected order [${franksCheck.expected.join(", ")}]`,
                });
                if (!franksCheck.matched) {
                  errors.push(
                    `advance: ${stage1.ref}: captured finalRanks ` +
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
                  name: `oracle: ${stage1.ref} rank crossing (captured vs standings)`,
                  passed: rankCrossing.matched,
                  detail: rankCrossing.matched
                    ? `captured finalRanks and the re-read standings agree: [${standingsRanked.join(", ")}]`
                    : renderRankCrossingMismatch(rankCrossing),
                });
                log.info({ kind: "rank_crossing", passed: rankCrossing.matched }, "oracle_checked");
                if (!rankCrossing.matched) {
                  errors.push(
                    `oracle: ${stage1.ref}: the captured complete response and the re-read standings DISAGREE on final order — ` +
                      `${renderRankCrossingMismatch(rankCrossing)}`,
                  );
                }

                const standingsVsExpected = compareFinalRanks(expectedIds, standingsRanked);
                oracles.push({
                  name: `oracle: ${stage1.ref} standings rank vs expected.finalRanks`,
                  passed: standingsVsExpected.matched,
                  detail: standingsVsExpected.matched
                    ? `re-read standings [${standingsRanked.join(", ")}] match the pack's expected order`
                    : `re-read standings [${standingsRanked.join(", ")}] disagree with the pack's expected order ` +
                      `[${expectedIds.join(", ")}]`,
                });
                log.info({ kind: "standings_final_rank", passed: standingsVsExpected.matched }, "oracle_checked");
                if (!standingsVsExpected.matched) {
                  errors.push(
                    `oracle: ${stage1.ref}: re-read standings [${standingsRanked.join(", ")}] disagree with the ` +
                      `pack's expected order [${expectedIds.join(", ")}]`,
                  );
                }

                // D2 — champion, defined as rank 1 of the final stage's
                // standings, cross-checked against the captured response,
                // compared against `expected.champions`. No champion field
                // exists anywhere on the wire (F1b) — the bench does not
                // invent one.
                const expectedChampionRow = pack.expected.champions.find(
                  (c) => c.divisionRef === division0.ref && (c.stageRef === undefined || c.stageRef === stage1.ref),
                );
                if (expectedChampionRow === undefined) {
                  warnings.push(
                    `oracle: division "${division0.ref}" completed but the pack declares no expected.champions row for it — champion oracle skipped`,
                  );
                } else {
                  const expectedChampionId = seeded.entrantIdByRef.get(expectedChampionRow.entrant);
                  if (expectedChampionId === undefined) {
                    errors.push(
                      `tiny: expected.champions names entrant ref "${expectedChampionRow.entrant}" with no resolved id`,
                    );
                  } else {
                    const championCheck = compareChampion(expectedChampionId, standingsRanked, completion.finalRanks);
                    oracles.push({
                      name: `oracle: ${division0.ref} champion`,
                      passed: championCheck.matched,
                      detail: championCheck.matched
                        ? `champion ${championCheck.fromStandings} matches the pack's expected champion`
                        : renderChampionMismatch(championCheck),
                    });
                    log.info({ kind: "champion", passed: championCheck.matched }, "oracle_checked");
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
          `tiny: pack declares org.currency "${declaredCurrency}" but neither the PlanSql seam nor a setOrgCurrency ` +
            `override is wired — writing it is the only thing that makes the declaration mean anything`,
        );
      }
      await writeCurrency(orgId, declaredCurrency);
      log.info(
        { org: orgId, currency: declaredCurrency },
        "tiny: wrote the pack's declared org currency",
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
          'tiny: a registration division declares paymentMethod:"stripe" but STRIPE_CONNECT_TEST_ACCOUNT is not set — ' +
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
          "tiny: a paid registration division needs either the PlanSql seam or an explicit connectAccount override " +
            "to attach STRIPE_CONNECT_TEST_ACCOUNT to this run's org",
        );
      }
      connectPreviousHolder = await connect.claim(orgId, connectAccountId);
      connectClaimed = true;
      log.info(
        { org: orgId, previousHolder: connectPreviousHolder },
        "tiny: claimed STRIPE_CONNECT_TEST_ACCOUNT for this run's org (restored on the way out)",
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
          const skipped = `tiny: registration "${division.ref}": resolved to admin and SKIPPED — _tiny carries no admin-equivalent seed data for it, so this run proves nothing about registration.`;
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
          "tiny: creating + configuring a registration division",
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
                `tiny: registration division "${division.ref}" needs either the PlanSql seam or an explicit resolveOrgSlug ` +
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
            `tiny: registration division "${division.ref}" needs the competition's own slug (RegistrationDivisionTarget) — the pack declares none`,
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
                `tiny: registration division "${division.ref}" declares no joins[] — resolveJoinCode should never be called`,
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
              `tiny: registration "${division.ref}": ${freeAgentWarning}`,
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
            "tiny: registration division funnel complete",
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
            `tiny: FAILED to release STRIPE_CONNECT_TEST_ACCOUNT back to ${connectPreviousHolder ?? "nobody"} — ` +
              `smoke's paid suites will skip until it is restored by hand: ` +
              `${releaseErr instanceof Error ? releaseErr.message : String(releaseErr)}`,
          );
        }
      }
    }
  } catch (err) {
    errors.push(err instanceof Error ? err.message : String(err));
  }

  // Warnings are REPORTED, never gated on. Stage 0 names what it does not
  // derive offline; that is a fact the report has to carry, and a gate that
  // read it would red `_tiny` on every run for saying something true.
  const gate = errors.length === 0 ? "green" : "red";
  return {
    suite: "_tiny",
    gate,
    timings,
    keep,
    solver: {
      engine: solver?.engine,
      requestedEngine: engine,
      status: solver?.status,
    },
    conflictCount,
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
    ...(simulation === undefined ? {} : { simulation }),
    ...(importSimulation === undefined ? {} : { importSimulation }),
  };
}
