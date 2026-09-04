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
import type { Pack, PackDivision } from "../pack-schema.ts";
import {
  buildSeedPlan,
  type SeedPlan,
  type SeedPlanExpectedFixtureCount,
} from "../seed-plan.ts";
import {
  defaultTransport,
  runOfficialsAutoAssign,
  seedSuite,
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
  OracleResult,
  RegistrationDivisionReport,
  SuiteReport,
} from "../report.ts";
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
interface AutoScheduleOut {
  assignments: {
    fixture_id: string;
    scheduled_at: string;
    ends_at?: string;
    court_id: string;
  }[];
  conflicts: { fixture_id: string; code: string; blocking: boolean }[];
  solver?: { engine?: "optimized" | "greedy"; status?: string; mode?: string };
}
interface ValidateOut {
  conflicts: { fixture_id: string; code: string; blocking: boolean }[];
}

export async function runTinySuite(
  input: TinySuiteInput,
): Promise<SuiteReport> {
  const { base, engine, keep, log } = input;
  const t = input.transport ?? defaultTransport;
  const errors: string[] = [];
  const warnings: string[] = [];
  const oracles: OracleResult[] = [];
  const timings: { seedMs?: number; scheduleMs?: number } = {};
  const registrationReports: RegistrationDivisionReport[] = [];
  let conflictCount: number | undefined;
  let solver: AutoScheduleOut["solver"];

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
          `pack hash unchanged, seeding and scheduling skipped this run`,
      );
      log.info(
        { orgId: existing.orgId, competitionId: existing.competitionId },
        "tiny: --keep short-circuited — reusing a prior run's seed",
      );
      return {
        suite: "_tiny",
        gate: "green",
        timings,
        keep,
        solver: { requestedEngine: engine },
        ...(warnings.length > 0 ? { warnings } : {}),
      };
    }

    // `_tiny.json` declares exactly one division and one (league) stage —
    // `buildSeedPlan`/`seedSuite` are generalised past that, but this
    // suite's OWN scheduling walk below still only ever drives the first of
    // each, matching what `_tiny.json` actually contains. `divisions.min(1)`
    // on `PackSchema` guarantees at least one; a stage-less division would be
    // an authoring bug stage 0 does not currently catch, so it is named here
    // rather than silently producing `undefined.id` downstream.
    const division0 = plan.divisions[0];
    const stage0 = division0?.stages[0];
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

    // Two independent chains, run concurrently on separate sessions: this
    // suite's OWN venue/court (never part of `SeedPlan` — `_tiny.json`
    // declares no `venues[]`), and the entire org/competition/division/
    // entrants/stage/generate tree via `seedSuite`. `seedSuite` signs in
    // AGAIN internally with the SAME email — a second magic-link round trip,
    // accepted as the cost of keeping `seedSuite` self-contained (it does not
    // accept an external session) rather than exposing one just for this
    // caller.
    const seedPromise = seedSuite({
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
    const venuePromise = (async () => {
      const venue = await t.request<IdOut>(
        base,
        s,
        `/api/v1/orgs/${orgId}/venues`,
        {
          method: "POST",
          body: { name: `Bench Tiny Venue ${runTag}` },
        },
      );
      return t.request<IdOut>(
        base,
        s,
        `/api/v1/orgs/${orgId}/venues/${venue.id}/courts`,
        {
          method: "POST",
          body: { name: "Court 1" },
        },
      );
    })();
    const [seeded, court]: [SeededSuite, IdOut] = await Promise.all([
      seedPromise,
      venuePromise,
    ]);

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
    const countIssue = fixtureCountIssue(seeded.fixtureIdByKey.size, plan);
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

    const scheduleStart = performance.now();
    // Derived from the PACK's own competition window, not from the wall clock.
    //
    // This was `Date.now() + 24h`, justified as "a real future calendar slot",
    // and it 422'd on the first live run this suite ever had:
    // `SCHEDULE_OUTSIDE_COMPETITION` — "this division's schedule starts before
    // the competition opens on 2099-01-01". `usecases/schedule.ts:305-319`
    // requires a division's schedule to sit INSIDE its competition's dates, and
    // `_tiny` declares 2099-01-01..2099-01-03, so tomorrow is years too early.
    //
    // Nothing offline could catch it: the unit suite's fake transport accepts
    // any `schedule-settings` PUT, which is the fourth time in this wave a
    // fixture has accepted what the product refuses. The rule the rest of this
    // module already follows — derive every value from the pack rather than
    // inventing one — is exactly what was missing here.
    //
    // A pack that declares no `startsOn` has no window to respect, so the
    // wall-clock slot remains correct for it.
    const startAt =
      plan.competition.startsOn === undefined
        ? new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString()
        : `${plan.competition.startsOn}T09:00:00.000Z`;
    await t.request(
      base,
      s,
      `/api/v1/divisions/${divisionId}/schedule-settings`,
      {
        method: "PUT",
        body: {
          config: {
            startAt,
            matchMinutes: 30,
            gapMinutes: 0,
            courts: [court.id],
            perEntrantMinRest: 0,
            blackouts: [],
            sessionWindows: [],
          },
          tz: "UTC",
        },
      },
    );

    // There is no request-level "engine" field on AutoScheduleRequest
    // (schemas.ts:1496-1542) — engine selection is entirely
    // server-environment-determined by whether the placement service
    // answers (`_RULES.md` §2's "run gates both with and without a live
    // placement container" is exactly this fact, from the operator's
    // side). So `--engine` cannot be honoured by this call regardless of
    // what the operator asked for; `requestedEngine` in the report below
    // still records the CLI's actual value (`input.engine`), and the
    // ACTUAL engine the response reports is recorded honestly alongside it
    // rather than either one overwriting the other. Flagged in the PR body
    // as a brief/API-shape finding.
    log.info(
      { requestedEngine: engine },
      "tiny: --engine is not honoured — AutoScheduleRequest has no per-request engine field",
    );
    const auto = await t.request<AutoScheduleOut>(
      base,
      s,
      `/api/v1/stages/${stageId}/schedule/auto`,
      {
        method: "POST",
        body: {},
      },
    );
    solver = auto.solver;

    await t.request(base, s, `/api/v1/stages/${stageId}/schedule/apply`, {
      method: "POST",
      body: {
        assignments: auto.assignments.map((a) => ({
          fixture_id: a.fixture_id,
          scheduled_at: a.scheduled_at,
          court_id: a.court_id,
        })),
      },
    });

    // B03 review F1(b): officials auto-assign runs HERE, strictly AFTER
    // schedule/apply — never inside `seedSuite`, which completes before this
    // suite's own scheduling walk even starts. `officials/auto`'s own
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

    const validated = await t.request<ValidateOut>(
      base,
      s,
      `/api/v1/divisions/${divisionId}/schedule/validate`,
      {
        method: "POST",
      },
    );
    const blocking = validated.conflicts.filter((c) => c.blocking);
    conflictCount = blocking.length;
    if (blocking.length > 0) {
      errors.push(
        `${blocking.length} blocking conflict(s) after schedule/apply: ${blocking.map((c) => c.code).join(", ")}`,
      );
    }
    timings.scheduleMs = Math.round(performance.now() - scheduleStart);

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
  };
}
