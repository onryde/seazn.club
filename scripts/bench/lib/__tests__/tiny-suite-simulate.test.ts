// B05 T1 — proves `runTinySuite` actually DRIVES division A's streams
// through the single-event scoring route end to end against the REAL
// committed `_tiny.json` pack: removing the
// `if (input.sql !== undefined) { ... simulateDivisionStreams(...) ... }`
// block in `lib/suites/tiny.ts` reds a test here (AGENTS.md recurring-
// failure class 1 — "the inert seam", which is this whole task's reason to
// exist: `seed.ts`'s `bindStreamFixtures` has resolved every stream's real
// fixture id since B03 and NOTHING ever read `.events` until now).
//
// A fresh, self-contained fake — same "minimize blast radius outside what
// THIS task owns" precedent `tiny-suite-stats.test.ts`'s own header comment
// gives for not extending `tiny-suite.test.ts`'s shared `makeFakeServer()`.
// This one is `tiny-suite-stats.test.ts`'s own `fakeServer` COPIED VERBATIM
// (its `request()` surface already answers everything `input.sql` present
// unconditionally drives — the DLS-gate probe, officials/claims seeding —
// against the real `_tiny.json` pack), with exactly one addition: a
// `conflictAt` knob on `raw()` so one test can prove a refusal actually
// reaches `report.errors`/`report.gate`, not just `simulate.ts`'s own unit
// suite (which already covers the fold logic exhaustively).
import { afterEach, describe, expect, it, vi } from "vitest";
import pino from "pino";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RawResult, Session } from "../http.ts";
import type { ProbeTransport } from "../dls-gate.ts";
import type { PlanEntitlementRow, PlanSql } from "../plan.ts";
import { runTinySuite, TINY_PACK_PATH } from "../suites/tiny.ts";
// B07a T7 — most of the play-mode tests below drive `runPackSuite` DIRECTLY
// rather than `runTinySuite`, so a declaration can be handed straight to the
// runner's own options without needing a real registry row. (Fix round 1
// gave `runTinySuite` its own `play` parameter — see the "fix round 1"
// describe block further down, which drives `runTinySuite` itself.)
import { runPackSuite, type PackSuiteInput } from "../suites/run-suite.ts";
import type { PlayMode, SuiteDefinition } from "../suites/types.ts";
// B07a T7 fix round 1 (I1) — the seam `bench.ts`'s own `runSuite` calls to
// forward a registry row's `play` into its `.run()`. Imported here (rather
// than mutating `SUITE_REGISTRY`, which the ruling forbids in a test) so a
// hand-built `SuiteDefinition` can drive the SAME line production uses.
//
// B07a T7 fix round 2 (I1(b)/(c)) — `runSuite`/`parseCliArgs` drive the REAL
// exported entry point (not the extracted `invokeSuiteDefinition` helper
// alone), against the REAL registry row (see the `vi.mock` below).
import { invokeSuiteDefinition, parseCliArgs, runSuite } from "../../bench.ts";
import { makeScheduleWorld } from "./_schedule-routes.ts";
import { makeDivisionPhaseWorld } from "./_division-phase.ts";
import { makeAdvanceRoutesWorld } from "./_advance-routes.ts";
import { makeDisciplineRoutesWorld, type SuspensionRowLike } from "./_discipline-routes.ts";
import type { DivisionCardSource, DivisionPlayerStatsLike } from "./_oracle-routes.ts";
import { makeClaimRoutesWorld, type ClaimRoutesOptions } from "./_claim-routes.ts";
import { makeNewsRoutesWorld, type NewsRoutesOptions } from "./_news-routes.ts";
import {
  makeOracleRoutesWorld,
  personCareerStatsFromDivisions,
  personStatsFromDivisions,
  tinyDivisionPlayerStats,
  tinyLeagueTableRows,
  echoExpectedBoard,
  TINY_SPECIAL_STATE,
  echoSpecialSubjects,
} from "./_oracle-routes.ts";
import { roundRobinRoundCount } from "./_roundrobin-rounds.ts";
import { OracleResult } from "../report.ts";

// B07a T7 fix round 2 (I1(b)/(c)), narrowed in fix round 3 (R34) — mocks
// ONLY `registry.ts`'s `lookupSuite`, injecting a `play` declaration onto
// the REAL `_tiny` row returned by `importOriginal()`, while leaving that
// row's own `run` binding (`registry.ts`'s `run: runTinySuite`) completely
// untouched underneath a thin test-side wrapper — the spread
// (`{ ...real, play: injectedPlay!, run: (input, play) => real.run({
// ...input, ...injectedTransports }, play) }`) is what lets the REAL row's
// REAL binding execute (the wrapper calls it, with `play` forwarded
// UNTOUCHED as its own second argument) when `bench.ts`'s
// `runSuite("_tiny", ...)` resolves it, rather than a test-built fixture
// (the gap the round-1 re-review found: round 1's own seam test handed
// `invokeSuiteDefinition` a row it built itself, so `registry.ts`'s actual
// `run: runTinySuite` binding never ran).
//
// R34(a) — round 2 threaded a supplied `probeTransport` into
// `PackSuiteInput`'s other test-only transport seams from PRODUCTION
// `bench.ts` code. The re-review's own verified alternative (and the
// controller's ruling) moves that threading HERE instead: `injectedTransports`
// is spread into the row's `run` call, never into `bench.ts` itself, so
// `runSuite`'s production behaviour for `probeTransport` goes back to
// meaning only "the DLS-gate probe's transport" — Task 10 wires `tap`
// through this exact path with REAL transports, and a single fake standing
// in for five seams belongs on the test side, not in front of it.
//
// R34(c) — BOTH `injectedPlay` and `injectedTransports` are OPT-IN, read by
// the mock factory AT CALL TIME (not baked into the factory itself): unset
// (`undefined`/`{}`), `lookupSuite("_tiny")` returns the row completely
// unmodified. Before this, EVERY `_tiny` lookup in this file carried
// `play: { "d-tiny": "tap" }` — a latent trap for any future test in this
// file that expects a normal `_tiny` run through `runSuite`. Each of the two
// tests below sets these before calling `runSuite` and `afterEach` resets
// them, so no other test in this file (there are ~40) is affected — proven
// by the full-file run in the fix-round-3 report.
//
// `suiteKeys()`/`SUITE_REGISTRY` and every other row pass through
// `...actual` unchanged. Nothing else in this file imports `registry.ts`
// (directly or transitively — `run-suite.ts`/`tiny.ts`/`suite11.ts` do not
// import it, only `bench.ts` does), so this mock cannot contaminate any
// other test in this file.
let injectedPlay: Record<string, PlayMode> | undefined;
let injectedTransports: Partial<PackSuiteInput> = {};

vi.mock("../suites/registry.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../suites/registry.ts")>();
  return {
    ...actual,
    lookupSuite: (key: string) => {
      const real = actual.lookupSuite(key);
      if (real === undefined) return real;
      if (key === "_tiny" && injectedPlay !== undefined) {
        return {
          ...real,
          play: injectedPlay,
          run: (input: PackSuiteInput, play?: Parameters<SuiteDefinition["run"]>[1]) =>
            real.run({ ...input, ...injectedTransports }, play),
        };
      }
      return real;
    },
  };
});

afterEach(() => {
  injectedPlay = undefined;
  injectedTransports = {};
});

const silent = pino({ level: "silent" });

interface RecordedCall {
  readonly method: string;
  readonly path: string;
  readonly body: unknown;
}

function slug(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "");
}

function fakeServer(
  opts: {
    conflictAt?: { extKey: string; expectedSeq: number };
    /** B06a T6 — knobs for the shared claim rail (`_claim-routes.ts`). */
    claimRoutes?: ClaimRoutesOptions;
    /** B06a T7 — knobs for the shared news rail (`_news-routes.ts`). */
    newsRoutes?: NewsRoutesOptions;
    /** B06a T6 — `GET /persons/{id}/stats` answers DIFFERENT numbers once a
     *  claim has been accepted. Reds the claimed-profile oracle and nothing
     *  else, same one-knob-one-oracle discipline as the three above. */
    statsChangeAfterClaim?: boolean;
    /** B05 T3 regression — the seed-proposal answers with the WRONG order
     *  (reversed), so D7's assertion should red and neither confirm,
     *  generate nor the playoff's own stream fold should ever be attempted. */
    reverseAdvanceQualifiers?: boolean;
    /** B05 T4 regression — `GET /stages/{id}/standings` answers with the
     *  final order REVERSED, independent of `reverseAdvanceQualifiers`
     *  above (that one is read by the SEED PROPOSAL for `s-league` ->
     *  `s-playoff`; this one is read by the runtime oracle's re-fetch of
     *  `s-playoff`'s OWN completed standings). Proves the oracle step is a
     *  real wire read, not a restatement of the captured `complete`
     *  response: with this set, the captured response still says
     *  [e-alpha, e-bravo] but the re-read standings say the opposite. */
    wrongFinalStandingsOrder?: boolean;
    /** B05 T5b-3 regression — the division's active-ban list comes back with
     *  EVERY member of the banned player's entrant on it, so the eligible
     *  control is banned too. Every NEGATIVE assertion still holds. */
    disciplineBansEveryone?: boolean;
    /** B05 T5b-3 regression — the ban reaches every fixture rather than the
     *  named one: the banned player is off EVERY team sheet, including the
     *  ones `expected.suspensions` does not name. */
    disciplineBanOverReaches?: boolean;
    /** B05 regression — the PRE-B05 product, whose lineup path never read the
     *  `suspensions` table: the PUT accepts a banned player onto any team
     *  sheet. The enforcement oracle is the ONLY thing that can see this, and
     *  the carry comparison cannot: this bench writes the sheets it wants, so
     *  an advisory product still stores exactly the sheets the pack expects. */
    disciplineAdvisoryLineupGate?: boolean;
    /** B05 regression — an OVER-refusing lineup gate: every PUT answers 422
     *  SUSPENDED_PLAYER, banned player or not. Only the enforcement oracle's
     *  POSITIVE half can tell this from a gate that works. */
    disciplineRefusesEveryLineup?: boolean;
    /** B05 T4b regression — `GET /stages/{id}/standings` answers `d-badminton`'s
     *  own league table with ZERO rows (as if nothing ever folded into it),
     *  proving `compareStandings`'s empty-case discipline through the WIRING:
     *  an empty `actual` against a non-empty `expected.tables` row must red,
     *  never vacuously pass. */
    emptyBadmintonStandings?: boolean;
    /** B05 T5a review MINOR — `GET /divisions/{id}/stats/players` answers
     *  `d-tiny`'s division with ZERO rows (the same empty shape
     *  `oracle.test.ts`'s own unit test uses) instead of this fake's real
     *  live tally, proving `compareLeaderboard`'s empty-case discipline
     *  through the WIRING — symmetric with `emptyBadmintonStandings` above. */
    emptyLeaderboard?: boolean;
    /** B05 T5b — `GET /persons/{id}/stats?group=sport` answers an EMPTY
     *  `sports` array (a person the rollup found nothing for) while every
     *  other read stays honest, proving `compareCareerStats`'s empty case
     *  through the WIRING: an empty rollup against a non-empty
     *  `expected.careers` must red, never vacuously pass. Scoped to the
     *  career route alone so the per-division cards keep passing — a sibling
     *  oracle reddening alongside it would not be coverage of this one. */
    emptyCareerSports?: boolean;
    /** B05 T5b — `GET /persons/{id}/stats` answers an EMPTY `divisions`
     *  array while the division leaderboard read stays honest, proving
     *  `comparePersonDivisionStat`'s absent-division case through the
     *  WIRING. Symmetric with `emptyCareerSports`, and equally scoped: the
     *  leaderboard oracle for the same board must still pass. */
    emptyPersonDivisions?: boolean;
  } = {},
): {
  transport: ProbeTransport;
  sql: PlanSql;
  calls: RecordedCall[];
} {
  const calls: RecordedCall[] = [];
  const legsByStageId = new Map<string, number>();
  // B05 T3 — d-tiny now declares a second, non-league stage (s-playoff, a
  // knockout fed from the league). `/generate` needs to know which shape to
  // mint: this fake's own round-robin arithmetic assumes every stage is a
  // league, which was true of every pack this file drove before this task.
  const kindByStageId = new Map<string, string>();
  const divisionIdByStageId = new Map<string, string>();
  // B05 T4b — the name `_oracle-routes.ts`'s `tinyLeagueTableRows` keys its
  // real (non-placement) standings fixture on: the `/stages` POST body's
  // own `name` field (`seed.ts`), never a pack ref this fake never sees.
  // `divisionNameById` is this file's OWN discriminator for
  // `getDivisionPlayerStats` below (is this division "Tiny"?).
  const stageNameById = new Map<string, string>();
  const divisionNameById = new Map<string, string>();
  // B05 T5b — the `sport_key` the SAME `POST /competitions/{id}/divisions`
  // body already carries (`seed.ts:614`). Read off the wire rather than
  // guessed, because `personCareerStats` files a person's divisions UNDER
  // their sport and `compareCareerStats` reds on a metric key found in more
  // than one sport.
  const divisionSportById = new Map<string, string>();
  const fixtureDivisionId = new Map<string, string>();
  // B05 T2.5 (D9) — see `_division-phase.ts`'s own header comment: EVERY
  // `sql`-passing fake now reaches `/start`/`GET /divisions/{id}`
  // unconditionally, and phase-gating `/fixtures/{id}/events` here is what
  // makes this file's own "clean fold" assertions a real regression against
  // the start step being wired in, rather than a test that only proves the
  // fold function exists.
  const phase = makeDivisionPhaseWorld();
  const fixtureExtKeyById = new Map<string, string>();
  const fixtureOfficials = new Map<string, unknown[]>();
  // B05 T4b — D6's OWN mis-attribution regression, run through the WIRED
  // leaderboard oracle rather than only a unit fixture: this fake TALLIES
  // real `generic.score` events as they land on `/fixtures/{id}/events`
  // (never a hardcoded constant), so `GET /divisions/{id}/stats/players`
  // answers with whatever the pack's OWN streams actually produced —
  // exactly what a mis-transcribed `payload.person` would change.
  const personNameById = new Map<string, string>();
  const personScoreTally = new Map<string, { scores: number; points: number }>();
  let divisionCounter = 0;
  let stageCounter = 0;
  let fixtureCounter = 0;
  // B05: the plan `provisionPlan` has flipped this org onto, null until it
  // does. Replaces the old `entitled` flag, which modelled a `cricket.dls`
  // paywall the product DELETED — scoring is free by owner ruling. What is
  // still sold is `officials.auto` (V393:84 grants it to `pro`; `community`
  // gets no row), which is the key the probe's re-pointed paywall cell
  // derives and provokes above, while this is still null.
  let provisionedPlan: string | null = null;

  const schedule = makeScheduleWorld({ solverEngine: "optimized" });
  // B05 T3 — see `_advance-routes.ts`'s own header comment: EVERY
  // `sql`-passing fake now reaches the advancement routes unconditionally,
  // because `_tiny.json`'s own `s-playoff` always declares a `progression`.
  // This file is not ABOUT advancement; it exists so this file's OWN
  // "clean fold, gate green" assertions stay green rather than reddening on
  // an unmodeled route.
  const advanceRoutes = makeAdvanceRoutesWorld({
    getQualifiers: (stageId) => {
      const divisionId = divisionIdByStageId.get(stageId);
      if (divisionId === undefined) return undefined;
      const entrants = schedule.entrantsOfDivision(divisionId);
      return opts.reverseAdvanceQualifiers === true ? [...entrants].reverse() : entrants;
    },
  });
  // B05 T4 — the runtime oracle's own route (`GET /stages/{id}/standings`),
  // unconditionally reached once `s-playoff` completes. This world reports
  // the REAL entrant order regardless of `reverseAdvanceQualifiers` above —
  // that knob feeds the SEED PROPOSAL a wrong order to prove D7 stops the
  // flow before `complete` is ever called, so the oracle step (which only
  // runs once `complete` has actually been captured) never reaches this
  // route in that scenario either way.
  // B05 T5b — division player stats, hoisted out of the world literal below
  // so the person-stats routes can derive their own answers from the SAME
  // source. `d-tiebreak` ("Tiebreak") also carries `expected.leaderboards`
  // rows since T5b-1 gave `expected.careers` a second division to roll up;
  // its own streams fold through `/events/import` (this file's pass-through
  // branch, which tallies nothing), so it takes `_oracle-routes.ts`'s shared
  // committed fixture rather than the live tally — only division A's fold is
  // tallied here.
  const honestDivisionPlayerStats = (divisionId: string): DivisionPlayerStatsLike | undefined => {
    const divisionName = divisionNameById.get(divisionId);
    if (divisionName === undefined) return undefined;
    if (divisionName !== "Tiny") {
      return tinyDivisionPlayerStats(divisionName, (fullName) => `person-${slug(fullName)}`);
    }
    return {
      metrics: [
        { key: "scores", label: "Scores" },
        { key: "points", label: "Points" },
      ],
      rows: [...personScoreTally.entries()].map(([personId, tally]) => ({
        person_id: personId,
        full_name: personNameById.get(personId) ?? personId,
        stats: { scores: tally.scores, points: tally.points },
      })),
      requires_detailed_scoring: false,
    };
  };
  const divisionPlayerStatsFor = (divisionId: string): DivisionPlayerStatsLike | undefined => {
    if (opts.emptyLeaderboard === true && divisionNameById.get(divisionId) === "Tiny") {
      return { metrics: [], rows: [], requires_detailed_scoring: true };
    }
    return honestDivisionPlayerStats(divisionId);
  };
  const divisionCardSources = (): readonly DivisionCardSource[] =>
    [...divisionNameById.entries()].flatMap(([divisionId, divisionName]) => {
      const playerStats = honestDivisionPlayerStats(divisionId);
      return playerStats === undefined
        ? []
        : [{ divisionId, divisionName, sportKey: divisionSportById.get(divisionId) ?? "unknown", playerStats }];
    });

  // B05 T5b-3 — the discipline surface (five routes), from the shared world.
  const entrantMembers = new Map<string, string[]>();
  const entrantByDivisionPerson = new Map<string, string>();
  const discipline = makeDisciplineRoutesWorld({
    entrantForPerson: (divisionId, personId) =>
      entrantByDivisionPerson.get(`${divisionId}|${personId}`),
    ...(opts.disciplineBansEveryone === true
      ? {
          // A product that refuses EVERYBODY: every other member of the
          // banned player's own entrant comes back banned too. The NEGATIVE
          // half of the oracle still holds on this — which is exactly why
          // the positive half has to exist.
          interceptActive: (rows: SuspensionRowLike[]) => [
            ...rows,
            ...rows.flatMap((r) =>
              (entrantMembers.get(r.entrantId ?? "") ?? [])
                .filter((pid) => pid !== r.personId)
                .map((pid, i) => ({ ...r, id: `${r.id}-also-${i}`, personId: pid })),
            ),
          ],
        }
      : {}),
    ...(opts.disciplineAdvisoryLineupGate === true ? { advisoryLineupGate: true } : {}),
    ...(opts.disciplineRefusesEveryLineup === true ? { refuseEveryLineupWrite: true } : {}),
    ...(opts.disciplineBanOverReaches === true
      ? {
          // A ban that reached EVERY fixture, not the named one: the banned
          // player is off every team sheet. "Absent from rr-r3-c1" still
          // holds, so only the fixture-identity check can see this.
          interceptSheet: (_fixtureId: string, _entrantId: string, personIds: string[]) =>
            personIds.filter((pid) => !discipline.created.some((r) => r.personId === pid)),
        }
      : {}),
  });

  // B06a T6 — the claim rail (officials invite, person claim-invite mint and
  // read-back, and `POST /api/claims/{token}/accept`). Reached unconditionally
  // now: the runner accepts the pack's player invites after the fold on every
  // `sql`-passing run. Constructed BEFORE the oracle world because
  // `statsChangeAfterClaim` below has to ask it whether anything has been
  // accepted yet.
  const claims = makeClaimRoutesWorld(opts.claimRoutes ?? {});

  // B06a T7 — the news rail. Drafting is a SIDE EFFECT of folding in the real
  // product, not a route anyone calls, so this world OBSERVES the fold calls
  // this fake already answers rather than waiting to be told. See
  // `_news-routes.ts`.
  let competitionId: string | undefined;
  const news = makeNewsRoutesWorld({
    ...(opts.newsRoutes ?? {}),
    divisionOfFixture: (fixtureId) => fixtureDivisionId.get(fixtureId),
    competitionOfDivision: () => competitionId,
  });

  const oracleRoutes = makeOracleRoutesWorld({
    // `_tiny` declares one special; without a folded state its
    // `phase` claim reads as absent and reds every run in this file.
    getFixtureModuleState: () => TINY_SPECIAL_STATE,
    getRankedEntrantIds: (stageId) => {
      const divisionId = divisionIdByStageId.get(stageId);
      if (divisionId === undefined) return undefined;
      const entrants = schedule.entrantsOfDivision(divisionId);
      return opts.wrongFinalStandingsOrder === true ? [...entrants].reverse() : entrants;
    },
    // B05 T4b — the two REAL league tables (`d-tiny`/`s-league`,
    // `d-badminton`/`s-badminton-league`); `undefined` for `s-playoff`
    // (the knockout `getRankedEntrantIds` above already covers) falls back
    // to the placement shape unchanged.
    getFullStandingsRows: (stageId) => {
      const divisionId = divisionIdByStageId.get(stageId);
      const stageName = stageNameById.get(stageId);
      if (divisionId === undefined || stageName === undefined) return undefined;
      if (opts.emptyBadmintonStandings === true && stageName === "Badminton League") return [];
      return tinyLeagueTableRows(stageName, schedule.entrantsOfDivision(divisionId));
    },
    // B05 T4b/D6 — a LIVE tally of `generic.score` events actually posted to
    // `/fixtures/{id}/events` (`personScoreTally`, filled below in `raw()`),
    // never `_oracle-routes.ts`'s hardcoded fixture: this file is the one
    // that folds division0's OWN real events, and D6's regression needs the
    // fake to report whatever a mis-attributed `payload.person` actually
    // produced, not a constant that could never disagree with it.
    getDivisionPlayerStats: divisionPlayerStatsFor,
    // B05 T5b — the two person-stats reads. Both derive from
    // `honestDivisionPlayerStats`, NEVER from `divisionPlayerStatsFor`: the
    // `emptyLeaderboard` knob models one broken ENDPOINT, and letting it
    // leak into the person card would red two oracles for one injected
    // fault, which is exactly the "two guards covering for each other" shape
    // this task is required not to ship. Each of the three knobs below reds
    // its own oracle and no other.
    getPersonStats: (personId) => {
      if (opts.emptyPersonDivisions === true) return { divisions: [] };
      const wire = personStatsFromDivisions(personId, divisionCardSources());
      // B06a T6 — the fourth knob: a profile whose numbers CHANGE the moment
      // it is claimed. Nothing else in this file can witness the
      // claimed-profile oracle actually comparing its before and after reads,
      // and a comparison nothing can falsify is decoration.
      if (opts.statsChangeAfterClaim !== true || claims.acceptedTokens().length === 0) return wire;
      return {
        divisions: wire.divisions.map((d) => ({ ...d, stats: { ...d.stats, claimed_bonus: 99 } })),
      };
    },
    getPersonCareerStats: (personId) =>
      opts.emptyCareerSports === true
        ? { sports: [] }
        : personCareerStatsFromDivisions(personId, divisionCardSources()),
  });

  const transport: ProbeTransport = {
    async signIn(_base, _s) {
      calls.push({ method: "SIGNIN", path: "signIn", body: undefined });
      return { has_org: true, org_id: "org-fixed", redirect: "/dashboard" };
    },
    async request<T>(_base: string, _s: Session, rawPath: string, reqOpts?: { method?: string; body?: unknown }) {
      const method = reqOpts?.method ?? "GET";
      const body = reqOpts?.body;
      const routePath = rawPath.split("?")[0]!;
      calls.push({ method, path: rawPath, body });

      if (method === "GET" && routePath === "/api/orgs") {
        return [{ id: "org-fixed", slug: "org-fixed-slug", name: "Bench Org" }] as unknown as T;
      }
      if (method === "POST" && /^\/api\/v1\/orgs\/[^/]+\/venues$/.test(routePath)) {
        const id = `venue-${slug((body as { name: string }).name)}`;
        schedule.addVenue(id);
        return { id } as T;
      }
      const courtsMatch = /^\/api\/v1\/orgs\/[^/]+\/venues\/([^/]+)\/courts$/.exec(routePath);
      if (method === "POST" && courtsMatch !== null) {
        const name = (body as { name: string }).name;
        const id = `court-${slug(name)}`;
        schedule.addCourt(courtsMatch[1]!, id, name);
        return { id } as T;
      }
      if (method === "POST" && routePath === "/api/v1/persons") {
        const fullName = (body as { full_name: string }).full_name;
        const id = `person-${slug(fullName)}`;
        personNameById.set(id, fullName);
        return { id } as T;
      }
      if (method === "POST" && routePath === "/api/v1/competitions") {
        return { id: `comp-${slug((body as { name: string }).name)}` } as T;
      }
      const divisionsMatch = /^\/api\/v1\/competitions\/([^/]+)\/divisions$/.exec(routePath);
      if (method === "POST" && divisionsMatch !== null) {
        // B06a T7 — the competition every post this run drafts belongs to.
        // Read off the wire, never guessed: the posts list route carries no
        // competition filter at all, so the runner filters client-side and a
        // post with the wrong id would simply vanish from every count.
        competitionId = divisionsMatch[1]!;
        const b = body as { name?: string; sport_key?: string; config?: { dls?: { enabled?: boolean } } };
        const id = `div-${++divisionCounter}`;
        if (b.name !== undefined) divisionNameById.set(id, b.name);
        if (b.sport_key !== undefined) divisionSportById.set(id, b.sport_key);
        return { id } as T;
      }
      const entrantsMatch = /^\/api\/v1\/divisions\/([^/]+)\/entrants$/.exec(routePath);
      if (method === "POST" && entrantsMatch !== null) {
        const rows = body as { display_name?: string; members?: { person_id?: string }[] }[];
        const out = rows.map((e, i) => ({
          id: `entrant-${slug(e.display_name ?? String(i))}-${Math.random()}`,
        }));
        // B05 T5b-3: the roster the request carried, kept so the discipline
        // world can answer `entrantForPerson` the way `decideSuspension`'s
        // confirm branch resolves it out of `entrant_members`. Recorded from
        // the REQUEST body rather than re-derived from the pack, so a suite
        // that sent the wrong roster cannot be papered over here.
        rows.forEach((e, i) => {
          const entrantId = out[i]!.id;
          const memberIds = (e.members ?? []).map((m) => m.person_id).filter((x): x is string => !!x);
          entrantMembers.set(entrantId, memberIds);
          for (const personId of memberIds) {
            entrantByDivisionPerson.set(`${entrantsMatch[1]!}|${personId}`, entrantId);
          }
        });
        schedule.addEntrants(entrantsMatch[1]!, out.map((e) => e.id));
        return out as unknown as T;
      }
      if (method === "POST" && /^\/api\/v1\/divisions\/([^/]+)\/stages$/.test(routePath)) {
        const divisionId = routePath.split("/")[4]!;
        const stagesBody = body as { name?: string; kind?: string; config?: { legs?: number } }[];
        return stagesBody.map((st) => {
          const id = `stage-${++stageCounter}`;
          legsByStageId.set(id, (st.config?.legs as number | undefined) ?? 1);
          kindByStageId.set(id, st.kind ?? "league");
          divisionIdByStageId.set(id, divisionId);
          if (st.name !== undefined) stageNameById.set(id, st.name);
          schedule.addStage(id, divisionId);
          return { id };
        }) as unknown as T;
      }
      if (method === "POST" && /^\/api\/v1\/stages\/[^/]+\/generate$/.test(routePath)) {
        const stageId = routePath.split("/")[4]!;
        const divisionId = divisionIdByStageId.get(stageId);
        // B05 T3 — a knockout `timing:"setup"` progression stage mints ONE
        // TBD placeholder (`se-r0-i0`, `buildSingleElim`'s own id for a
        // 2-slot single-elim bracket), never this fake's round-robin
        // arithmetic — see `kindByStageId`'s own comment.
        const fixtures =
          kindByStageId.get(stageId) === "knockout"
            ? [(() => {
                const id = `fx-${++fixtureCounter}`;
                if (divisionId !== undefined) fixtureDivisionId.set(id, divisionId);
                fixtureExtKeyById.set(id, "se-r0-i0");
                return { id, ext_key: "se-r0-i0" };
              })()]
            : Array.from(
                {
                  length: roundRobinRoundCount(
                    divisionId === undefined ? 0 : schedule.entrantsOfDivision(divisionId).length,
                    legsByStageId.get(stageId) ?? 1,
                  ),
                },
                (_v, i) => {
                  const id = `fx-${++fixtureCounter}`;
                  if (divisionId !== undefined) fixtureDivisionId.set(id, divisionId);
                  const extKey = `rr-r${i + 1}-c1`;
                  fixtureExtKeyById.set(id, extKey);
                  return { id, ext_key: extKey };
                },
              );
        schedule.addFixtures(stageId, fixtures);
        return { fixtures } as unknown as T;
      }
      // B04 — the seven scheduling endpoints, from the shared world. BEFORE
      // the officials routes below, so the anchored `PATCH /fixtures/{id}`
      // and `PATCH /fixtures/{id}/officials` cannot shadow each other.
      const scheduled = schedule.handle(method, routePath, body);
      if (scheduled !== undefined) return scheduled as T;
      if (method === "POST" && /^\/api\/v1\/divisions\/[^/]+\/officials\/auto$/.test(routePath)) {
        return { assignments: [] } as unknown as T;
      }
      if (method === "POST" && routePath === "/api/v1/officials") {
        return { id: `official-${slug((body as { display_name: string }).display_name)}` } as T;
      }
      if (method === "POST" && /^\/api\/v1\/officials\/[^/]+\/availability$/.test(routePath)) {
        return { date: (body as { date: string }).date } as T;
      }
      // B06a T6 — the officials invite, the person claim-invite mint and its
      // read-back all live in `_claim-routes.ts` now: all four fakes carried
      // byte-identical copies of them, and the mint has to hand back a
      // `claim_url` for the accept step to have a token at all.
      const claimRouted = claims.handleRequest(method, routePath, body);
      if (claimRouted !== undefined) return claimRouted.value as T;
      if (method === "PATCH" && /^\/api\/v1\/fixtures\/[^/]+\/officials$/.test(routePath)) {
        const fixtureId = routePath.split("/")[4]!;
        const set = (body as { set: unknown[] }).set;
        fixtureOfficials.set(fixtureId, set);
        schedule.setOfficials(fixtureId, set);
        return { ok: true } as T;
      }
      if (method === "GET" && /^\/api\/v1\/fixtures\/[^/]+$/.test(routePath)) {
        const fixtureId = routePath.split("/")[4]!;
        return { id: fixtureId, officials: fixtureOfficials.get(fixtureId) ?? [] } as T;
      }
      if (method === "GET" && /^\/api\/v1\/divisions\/[^/]+$/.test(routePath)) {
        // B05 T2.5 — `status` is D9's own RE-READ; `slug` is unrelated
        // scaffolding no production call site actually reads.
        return { slug: `slug-${routePath.split("/")[4]}`, ...phase.handleDivisionGet(method, routePath) } as T;
      }
      if (method === "POST" && /^\/api\/admin\/orgs\/[^/]+\/entitlement-override$/.test(routePath)) {
        return { ok: true } as unknown as T;
      }
      if (method === "DELETE" && /^\/api\/admin\/orgs\/[^/]+\/entitlement-override$/.test(routePath)) {
        return { ok: true } as unknown as T;
      }
      throw new Error(`fake server: unhandled ${method} ${routePath}`);
    },
    async raw(_base, _s, path, method = "GET", body): Promise<RawResult> {
      calls.push({ method, path, body });
      // B06a T7 — watch the folds (drafting is their side effect), then the
      // three news routes. Both before anything below: a fold that reached the
      // events handler without being observed drafts nothing, and the whole
      // step then reports a legitimate-looking zero.
      news.observe(method, path, body);
      const newsRouted = news.handle(method, path, body);
      if (newsRouted !== undefined) return newsRouted;
      // B06a T6 — claim acceptance (see `_claim-routes.ts`). Checked here for
      // the same reason `/start` is: nothing below can answer it.
      const claimAccepted = claims.handle(method, path);
      if (claimAccepted !== undefined) return claimAccepted;
      // B05 T2.5 (D9) — `/start` itself, unconditionally whenever `sql` is
      // present. Checked FIRST: nothing below can be reached before this.
      const started = phase.handleStart(method, path);
      if (started !== undefined) return started;
      // B05 T3 — the advancement routes, unconditionally whenever `sql` is
      // present (see `_advance-routes.ts`'s own header comment).
      const advanced = advanceRoutes.handle(method, path, body);
      if (advanced !== undefined) return advanced;
      // B05 T4 — the runtime oracle's standings read, unconditionally
      // whenever `sql` is present (see `_oracle-routes.ts`'s own header
      // comment).
      const oracled = oracleRoutes.handle(method, path);
      if (oracled !== undefined) return oracled;
      // B05 T5b-3 — the discipline surface. AFTER the oracle routes, whose
      // `GET /divisions/{id}/stats/players` shares this route's prefix, and
      // BEFORE the import branch below, whose own `/divisions/{id}/...`
      // regex would not match these but which throws on anything unhandled.
      const disciplined = discipline.handle(method, path, body);
      if (disciplined !== undefined) return disciplined;
      // B05 T2 — division B's own streams (`d-badminton`) fold through THIS
      // route unconditionally whenever `sql` is present, same gating as
      // division A's single-event fold this file is actually about. Handled
      // here as a plain pass-through so THIS file's own division-A
      // assertions stay green; the import path's own wiring/behaviour is
      // covered by `tiny-suite-import.test.ts`.
      const importMatch = /^\/api\/v1\/divisions\/([^/]+)\/events\/import$/.exec(path);
      if (importMatch) {
        const importDivisionId = importMatch[1]!;
        const refused = phase.refuseUnlessStarted(importDivisionId, "import");
        if (refused !== undefined) return refused;
        const sent = (body as { streams: { fixture: { id: string }; events: unknown[] }[] }).streams;
        return {
          status: 200,
          json: {
            ok: true,
            data: {
              importId: "x",
              totals: { imported: sent.length, skipped: 0, rejected: 0 },
              results: sent.map((s) => ({ fixture: s.fixture.id, status: "imported", eventsAppended: s.events.length })),
            },
          } as never,
        };
      }
      // B05 — the DLS-gate probe's RE-POINTED paywall cell. "A 402 names its
      // feature_key" is still a real regression-catcher, but `cricket.dls` is
      // free now, so the probe derives a key the live matrix still gates and
      // provokes it here. `autoAssignOfficials` (usecases/officials.ts:496)
      // gates on `officials.auto` as its FIRST statement, before any division
      // state is read, so the plan is the only thing that decides the answer.
      const autoGate = /^\/api\/v1\/divisions\/([^/]+)\/officials\/auto$/.exec(path);
      if (autoGate && provisionedPlan === null) {
        return {
          status: 402,
          json: { ok: false, error: { code: "PAYMENT_REQUIRED", message: "nope", feature_key: "officials.auto" } } as never,
        };
      }
      const m = /^\/api\/v1\/fixtures\/([^/]+)\/events$/.exec(path);
      if (!m) throw new Error(`fake server: unhandled raw ${method} ${path}`);
      const fixtureId = m[1]!;
      const divisionId = fixtureDivisionId.get(fixtureId);
      const { type, payload, expected_seq } = body as { type: string; payload: { target?: unknown }; expected_seq: number };
      // B05 T2.5 (D9) — the phase gate `usecases/scoring.ts:222` enforces:
      // this is what proves `runDivisionStartLayer` actually ran BEFORE this
      // fold, not merely that the function exists. Scoped away from
      // `cricket.*` types on purpose: the DLS-gate probe's own throwaway
      // division is NEVER in `runDivisionStartLayer`'s input (only `_tiny`'s
      // OWN streamed divisions are), and the probe's whole point is proving
      // the ENTITLEMENT door — this phase door would otherwise shadow it,
      // turning a "must be 402" cell into a false "422 WRONG_PHASE" this
      // probe's own `NEVER_REACHED_THE_GATE` list does not even know to
      // exclude. `_tiny.json`'s division-A stream events use only
      // `core.*`/`generic.*` types (this file's own `divisionAEventCalls`
      // helper relies on the same non-overlap), so this scoping costs the
      // real fold nothing.
      if (divisionId !== undefined && !type.startsWith("cricket.")) {
        const refused = phase.refuseUnlessStarted(divisionId, "scoring");
        if (refused !== undefined) return refused;
      }
      // B05: SCORING IS FREE (owner ruling; V390__scoring_free.sql, and
      // V393__entitlements_v18.sql:63-70 puts `cricket.dls` on `community`),
      // so NO plan check gates this route. The only refusal a `cricket.revise`
      // can draw here is the ENGINE's own shape rule — `CricketRevise` needs
      // `oversPerSide` and/or `target` (packages/engine/src/sports/cricket/
      // cricket.ts:259-266) — which is exactly what the DLS-gate probe's
      // freedom cell requires, as 422 INVALID_EVENT. This used to 402 on
      // `cricket.dls`, which kept a deleted paywall alive inside the fakes.
      const revisePayload = payload as { target?: unknown; oversPerSide?: unknown };
      if (type === "cricket.revise" && revisePayload?.target === undefined && revisePayload?.oversPerSide === undefined) {
        return {
          status: 422,
          json: { ok: false, error: { code: "INVALID_EVENT", message: "revise needs oversPerSide and/or target" } } as never,
        };
      }
      // B05 T1's own addition: a deliberate SEQ_CONFLICT for exactly one
      // (extKey, expected_seq) pair, so a wiring test can prove the finding
      // reaches `report.errors`/`report.gate` — never a silent skip or retry.
      const extKey = fixtureExtKeyById.get(fixtureId);
      if (
        opts.conflictAt !== undefined &&
        extKey === opts.conflictAt.extKey &&
        expected_seq === opts.conflictAt.expectedSeq
      ) {
        return {
          status: 409,
          json: {
            ok: false,
            error: { code: "SEQ_CONFLICT", message: "deliberate test conflict", current_seq: expected_seq + 5 },
          } as never,
        };
      }
      // B05 T4b/D6 — tally the event actually accepted, never one this fake
      // is about to refuse above: `payload.person` is already the REAL
      // resolved id by this point (`simulate.ts#resolvePayloadRefs` runs
      // before `raw()` ever sees the event), so a re-attributed
      // `generic.score` in the SOURCE pack changes exactly this tally, with
      // no help from this fake.
      if (type === "generic.score") {
        const scorePayload = payload as unknown as { person?: string; points?: number };
        if (scorePayload.person !== undefined) {
          const tally = personScoreTally.get(scorePayload.person) ?? { scores: 0, points: 0 };
          tally.scores += 1;
          tally.points += typeof scorePayload.points === "number" ? scorePayload.points : 0;
          personScoreTally.set(scorePayload.person, tally);
        }
      }
      return { status: 201, json: { ok: true, data: { seq: expected_seq + 1 } } as never };
    },
  };

  const sql: PlanSql = {
    async entitlementRows(featureKey) {
      if (featureKey === "cricket.dls") {
        // B05: `community` GRANTS this — V393__entitlements_v18.sql:63-70,
        // "charge for leverage, never correctness". The probe reads this row
        // to report `dlsFreeOnCommunityPlan`, and a `false` here would claim
        // scoring had been re-gated for customers who never paid.
        return [
          { plan_key: "community", bool_value: true },
          { plan_key: "pro", bool_value: true },
        ] satisfies PlanEntitlementRow[];
      }
      if (featureKey === "officials.auto") {
        return [{ plan_key: "community", bool_value: false }, { plan_key: "pro", bool_value: false }] satisfies PlanEntitlementRow[];
      }
      // B06a T7 — `news.auto` on the plan this run buys. Without it the
      // enable step correctly REFUSES (`PATCH /divisions/{id}` would answer
      // 402, `usecases/divisions.ts:652-654`) and the whole news step reports
      // no subject — which is what this fake did before the row existed.
      if (featureKey === "news.auto") {
        return [
          { plan_key: "community", bool_value: false },
          { plan_key: "pro", bool_value: true },
        ] satisfies PlanEntitlementRow[];
      }
      if (featureKey === "stats.player") {
        return [{ plan_key: "community", bool_value: false }, { plan_key: "pro", bool_value: false }] satisfies PlanEntitlementRow[];
      }
      return [];
    },
    async planCandidateInfo(planKeys) {
      return planKeys
        .filter((k) => k === "community" || k === "pro")
        .map((k) => ({ plan_key: k, is_public: true, privilege: k === "pro" ? 1 : 0 }));
    },
    async getOrgSubscriptionId() {
      return null;
    },
    async updateSubscriptionPlan(_subscriptionId, plan) {
      provisionedPlan = plan;
    },
    async createSubscriptionForOrg(_orgId, plan) {
      provisionedPlan = plan;
      return "sub-new";
    },
    async setOwnerStaff() {},
    async setDivisionActive() {},
  };

  return { transport, sql, calls };
}

/** Every `POST .../events` call — INCLUDING the DLS-gate probe's own 5
 *  synthetic `cricket.*` cells, unconditionally driven whenever `input.sql`
 *  is present (same fake, same `raw()` route). `divisionAEventCalls` below
 *  is the one that scopes to what THIS task's own fold sent. */
function eventPostCalls(calls: RecordedCall[]): RecordedCall[] {
  return calls.filter((c) => c.method === "POST" && /^\/api\/v1\/fixtures\/[^/]+\/events$/.test(c.path));
}

/** Division A's (`d-tiny`'s) own stream events, scoped away from the DLS-
 *  gate probe's unconditional `cricket.revise`/`cricket.ball` cells by event
 *  TYPE — `_tiny.json`'s division-A streams use only `core.*`/`generic.*`
 *  types, and the probe's cells use only `cricket.*` ones (dls-gate.ts:347-
 *  397); the two vocabularies never overlap. */
function divisionAEventCalls(calls: RecordedCall[]): RecordedCall[] {
  return eventPostCalls(calls).filter((c) => !(c.body as { type: string }).type.startsWith("cricket."));
}

describe("runTinySuite — B05 T1 division-A stream fold wiring", () => {
  it("drives real POSTs for every division-A event and reports a populated simulation section", async () => {
    const { transport, sql, calls } = fakeServer();
    // B05 T6 fix 2 — the `oracle_checked` pino event is a SEPARATE consumer
    // surface from report.json, and a log reader filtering `passed: true`
    // would miscount a no-subject oracle exactly the way report.md did. It is
    // captured here rather than asserted through `silent`, so the event's own
    // payload is pinned, not merely the report's.
    const oracleEvents: { kind: unknown; passed: unknown; verdict: unknown }[] = [];
    const capturing = pino({ level: "info" }, {
      write(line: string) {
        const entry = JSON.parse(line) as Record<string, unknown>;
        if (entry.msg === "oracle_checked") {
          oracleEvents.push({ kind: entry.kind, passed: entry.passed, verdict: entry.verdict });
        }
      },
    });

    const report = await runTinySuite({
      base: "http://bench.example",
      engine: "optimized",
      keep: false,
      log: capturing,
      cliEntry: "admin",
      packPath: TINY_PACK_PATH,
      transport,
      sql,
      probeTransport: transport,
      simTransport: transport,
      // B05 T2 — the SAME fake now handles `/events/import` too (see this
      // file's own `raw()`), so division B's own streams fold cleanly
      // rather than falling back to a real `fetch()`. This file's own
      // assertions are about division A; the import path's own wiring is
      // `tiny-suite-import.test.ts`'s job.
      importTransport: transport,
      startTransport: transport,
      advanceTransport: transport,
      oracleTransport: transport,
      matchBoard: echoExpectedBoard,
      specialSubjects: echoSpecialSubjects,
    });

    expect(report.gate).toBe("green");
    // B05 T2.5 (D9) — both `_tiny.json`'s streamed divisions (`d-tiny` AND
    // `d-badminton`) were started and RE-READ as active BEFORE either fold
    // below ran at all — this is the whole reason the fold above succeeded
    // rather than 409ing against the fake's own phase gate.
    expect(report.divisionStart).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ divisionRef: "d-tiny", started: true, confirmedStatus: "active" }),
        expect.objectContaining({ divisionRef: "d-badminton", started: true, confirmedStatus: "active" }),
      ]),
    );
    // `/start` happens BEFORE any division-A event POST — never the other
    // way around. Scoped to division A's OWN `core.*`/`generic.*` calls
    // (`divisionAEventCalls`'s own reasoning): the DLS-gate probe's
    // `cricket.*` cells run BEFORE scheduling/start even begins, so an
    // unscoped index would always read as "before" regardless of ordering.
    const firstStartIdx = calls.findIndex((c) => c.method === "POST" && /\/start$/.test(c.path));
    const firstDivisionAEventIdx = calls.findIndex(
      (c) =>
        c.method === "POST" &&
        /^\/api\/v1\/fixtures\/[^/]+\/events$/.test(c.path) &&
        !(c.body as { type: string }).type.startsWith("cricket."),
    );
    expect(firstStartIdx).toBeGreaterThan(-1);
    expect(firstDivisionAEventIdx).toBeGreaterThan(firstStartIdx);
    // `_tiny.json`'s division A (`d-tiny`) league stage (`s-league`) declares
    // 3 streams with 2, 5 and 2 events — 9 total, via T1's OWN fold
    // (`report.simulation`, asserted below). B05 T3 ALSO folds `s-playoff`'s
    // OWN single stream (2 events: core.start + generic.result) through this
    // SAME `/fixtures/{id}/events` route — a SEPARATE call, reusing T1's
    // fold function rather than a new one (the acceptance bar: the existing
    // fold covers it) — so the RAW call count this fake recorded is 11
    // across 4 fixtures, not 9 across 3; `report.simulation` itself stays
    // scoped to T1's own 9, asserted against what the pack ACTUALLY sent
    // (call count), never a constant typed into this test a second time.
    const eventCalls = divisionAEventCalls(calls);
    expect(eventCalls).toHaveLength(11);
    // And in strictly ascending expected_seq PER FIXTURE — grouped by path
    // (== fixture), each fixture's own sequence starts at 0 and increments.
    const byFixture = new Map<string, number[]>();
    for (const c of eventCalls) {
      const seqs = byFixture.get(c.path) ?? [];
      seqs.push((c.body as { expected_seq: number }).expected_seq);
      byFixture.set(c.path, seqs);
    }
    expect(byFixture.size).toBe(4);
    for (const seqs of byFixture.values()) {
      expect(seqs).toEqual(seqs.map((_v, i) => i));
    }

    expect(report.simulation).toBeDefined();
    expect(report.simulation?.eventsSent).toBe(9);
    expect(report.simulation?.findings ?? []).toHaveLength(0);
    expect(report.timings.simMs).toBeDefined();
    // B05 T3's own oracles — the advance step's qualifier proposal and the
    // captured finalRanks both matched the pack's own expectations.
    const advanceOracles = (report.oracles ?? []).filter((o) => o.name.startsWith("advance:"));
    expect(advanceOracles.map((o) => o.passed)).toEqual([true, true]);
    // B05 T4 — the runtime oracle layer's own checks: rank crossing
    // (captured vs re-read standings), standings vs `expected.finalRanks`,
    // and champion, all against this fake's clean (unreversed) final order.
    // B05 T4b — the two comparators T4 left unwired, now reached for every
    // real subject `_tiny.json` carries: both league tables
    // (`expected.tables`) and both `d-tiny` leaderboard entries
    // (`expected.leaderboards`), all BEFORE the T3 advance step's own checks
    // (this task's wiring runs earlier in `runTinySuite`, right after T2's
    // import fold). If (false)-ing out either T4b block removes its four
    // entries from this list — the wiring-level regression this task owes.
    const runtimeOracles = (report.oracles ?? []).filter((o) => o.name.startsWith("oracle:"));
    // B05 T5b-2 — the two person-stats comparators, wired: a `person cards`
    // entry interleaves after EACH leaderboard entry (same loop, same
    // already-resolved expected entries, one `/persons/{id}/stats` fetch per
    // person shared across both boards), and `p-ana career rollup` trails the
    // whole leaderboard block. `if (false)`-ing out either new block drops
    // its own entries from this list and nothing else — the wiring-level
    // regression this task owes, one per block.
    //
    // B05 T5a — the tie-order cascade oracle (reviewer MAJOR #2: this
    // comparator had no call site anywhere) is wired right after EACH
    // table's own standings check, so it interleaves one-per-table rather
    // than trailing the whole list. `d-tiebreak`'s own pair (echo/golf) is
    // genuinely tied on points and genuinely checked (not skipped); d-tiny
    // and d-badminton's tables carry no tied rows, so their own cascade
    // entries report `checkedPairs: 0` but still run — removing the block
    // (`if (false)`) drops all THREE from this list, which is the wiring
    // regression this task owes.
    expect(runtimeOracles.map((o) => o.name)).toEqual([
      // B05 T5b-3 — FIRST, and that position is the point: the discipline
      // step has to write team sheets, and `putLineup` refuses any fixture
      // that has left `scheduled`, so it runs before the folds rather than
      // beside the other oracles after them. `if (false)`-ing the block drops
      // exactly this entry — the wiring regression this task owes.
      "oracle: d-tiebreak discipline enforced at the team sheet (p-hotel)",
      "oracle: d-tiebreak discipline carry (p-hotel)",
      // B06a task 3 — one per division that declares `expected.matches`, in
      // pack order, BEFORE the tables loop. Under this file's injected
      // `echoExpectedBoard` these three are vacuous by construction (the board
      // is the pack's own expectation handed back), so their presence and
      // ORDER is all this assertion claims; that they can fail is proven in
      // `oracle-matches.test.ts` and by the wrong-board wiring test.
      // B06a T9 — the advancement trio now leads the outcome oracles instead
      // of trailing them, and the ORDER is the assertion. Advancement used to
      // run last, so the per-match oracle below compared `_tiny`'s playoff
      // fixture while it was still `scheduled` and the first live run reported
      // `expected decided, got scheduled` against a product that was correct.
      // Fold everything, then assert. If these three drift back below the
      // per-match rows, that defect is back.
      "oracle: d-tiny/s-playoff rank crossing (captured vs standings)",
      "oracle: d-tiny/s-playoff standings rank vs expected.finalRanks",
      "oracle: d-tiny champion",
      "oracle: d-tiny per-match results",
      "oracle: d-badminton per-match results",
      "oracle: d-tiebreak per-match results",
      "oracle: d-tiny/s-league standings table",
      "oracle: d-tiny/s-league tie-order cascade",
      "oracle: d-badminton/s-badminton-league standings table",
      "oracle: d-badminton/s-badminton-league tie-order cascade",
      "oracle: d-tiebreak/s-tiebreak-league standings table",
      "oracle: d-tiebreak/s-tiebreak-league tie-order cascade",
      // B06a task 4 — one row for the whole pack, after the tables loop
      // (a standings claim reads rows that loop has already fetched).
      "oracle: specials",
      "oracle: d-tiny leaderboard (scores)",
      "oracle: d-tiny person cards (scores)",
      "oracle: d-tiny leaderboard (points)",
      "oracle: d-tiny person cards (points)",
      "oracle: d-tiebreak leaderboard (scores)",
      "oracle: d-tiebreak person cards (scores)",
      "oracle: d-tiebreak leaderboard (points)",
      "oracle: d-tiebreak person cards (points)",
      "oracle: p-ana career rollup",
    ]);
    expect(runtimeOracles.map((o) => o.passed)).toEqual([
      true, true, true, true, true, true, true, true, true, true,
      true, true, true, true, true, true, true, true, true, true,
      true, true, true, true,
    ]);
    // The genuinely tied pair (echo/golf) was actually CHECKED, not merely
    // present-and-skipped — the whole point of an ordering-differential
    // fixture (a case with nothing tied would report checkedPairs: 0 here
    // too, and could never witness a reversed cascade).
    const tiebreakCascade = runtimeOracles.find((o) => o.name === "oracle: d-tiebreak/s-tiebreak-league tie-order cascade");
    expect(tiebreakCascade?.detail).toContain("1 checked");

    // B05 T6 fix 2 — and the two cascades that compared NOTHING report the
    // third verdict, not a pass. The live run printed `PASS … (0 checked, 0
    // skipped)` for exactly these two, which is a comparator with no subject
    // printing itself green in the wave's own report. `passed` stays true (an
    // absent subject does not red a run — the assertion above still expects
    // twenty trues), so `verdict` is the ONLY thing that can witness this.
    const cascades = runtimeOracles.filter((o) => o.name.endsWith("tie-order cascade"));
    expect(
      cascades.map((o) => [o.name.replace("oracle: ", "").replace(" tie-order cascade", ""), o.verdict]),
    ).toEqual([
      ["d-tiny/s-league", "no_subject"],
      ["d-badminton/s-badminton-league", "no_subject"],
      // its POSITIVE PAIR, from the same run: the one division with a genuine
      // points tie compared something and agreed.
      ["d-tiebreak/s-tiebreak-league", "pass"],
    ]);
    for (const o of cascades.filter((c) => c.verdict === "no_subject")) {
      expect(o.detail).toContain("NO SUBJECT");
      expect(o.detail).toContain("0 checked");
    }
    // B05 review round 1, MINOR: `subject` reaches report.json off the
    // comparator's OWN `checkedPairs`, discriminating both ways in one run —
    // without this the field is declared, typed and read by nothing.
    expect(cascades.map((o) => o.subject)).toEqual([false, false, true]);
    // The two `advance:` rows and the crossing derive theirs from the
    // comparators' `reason` field, and this run has real subjects for all of
    // them — a hardcoded `false` would land here.
    const crossing = (report.oracles ?? []).find((o) => o.name.includes("rank crossing"));
    expect(crossing?.subject).toBe(true);
    const franks = (report.oracles ?? []).find((o) => o.name.endsWith("finalRanks"));
    expect(franks?.subject).toBe(true);

    // The pino event carries the verdict DISTINCTLY: the two no-subject
    // cascades are `passed: true` on the wire (they do not red a run) and are
    // separable from a real pass only by `verdict`.
    expect(oracleEvents.filter((e) => e.kind === "tie_order_cascade")).toEqual([
      { kind: "tie_order_cascade", passed: true, verdict: "no_subject" },
      { kind: "tie_order_cascade", passed: true, verdict: "no_subject" },
      { kind: "tie_order_cascade", passed: true, verdict: "pass" },
    ]);
    // Every other `oracle_checked` event keeps the same `passed` it always
    // had and gains the derived verdict — no oracle's verdict is changed by
    // this task except the cascade's.
    expect(
      oracleEvents.filter((e) => e.kind !== "tie_order_cascade" && !(e.passed === true && e.verdict === "pass")),
    ).toEqual([]);
    // Exactly one event per emitting oracle — a dropped emitter shrinks this
    // and is not hidden by the two `every()` assertions above, which an empty
    // or short list satisfies vacuously.
    //
    // B05 review round 1, MAJOR 4: this used to count only the `oracle:`-
    // prefixed rows, and the two `advance:` ones (seed proposal qualifiers,
    // finalRanks) pushed an `OracleResult` while emitting NO `oracle_checked`
    // event — so a log consumer undercounted the wave by exactly two against
    // the report's own list, and this length check could not see it because
    // both sides of it excluded the same two rows. The set spans both
    // prefixes now.
    //
    // B06a task 6 widened it again, for the same reason: the claim-acceptance
    // rows carry the `people:` prefix and every one of them emits, so a set
    // that stopped at `oracle:`/`advance:` would count four fewer report rows
    // than log events and this length check would red on a correct run.
    const emittingOracles = (report.oracles ?? []).filter(
      (o) =>
        o.name.startsWith("oracle:") ||
        o.name.startsWith("advance:") ||
        o.name.startsWith("people:") ||
        o.name.startsWith("news:"),
    );
    const peopleOracles = (report.oracles ?? []).filter((o) => o.name.startsWith("people:"));
    const newsOracles = (report.oracles ?? []).filter((o) => o.name.startsWith("news:"));
    // B06a task 7. Pinned by NAME and VERDICT, because a no-subject news row is
    // `passed: true` on the wire and a suite that drafted nothing would look
    // identical to one that drafted and published correctly.
    expect(newsOracles.map((o) => [o.name.replace("news: ", ""), o.verdict])).toEqual([
      ["folding drafted posts", "pass"],
      ["the named fixtures publish and the rest stay draft", "pass"],
      ["a republish does not move published_at", "pass"],
    ]);
    expect(report.news?.published).toBeGreaterThan(0);
    expect(report.news!.drafted).toBeGreaterThan(report.news!.published);
    // The two `advance:` rows and the four `people:` ones are genuinely in
    // this run, or the widened count below would be the same number it
    // always was.
    // Five, and the fifth is the tell: `people: an accepted invite is closed`
    // is pushed ONLY when something was actually accepted, so a run where the
    // claim step silently accepted nothing lands on four.
    // B06a task 6, found in review — every oracle this runner pushes must
    // PARSE its own schema. `OracleResult`'s `superRefine` (`report.ts:140-164`)
    // requires `passed === (verdict !== "fail")` and forbids
    // `no_subject` beside `subject: true`; `writeReport` (`:790`) parses
    // before writing, so a row breaking either rule fails no assertion
    // anywhere — it throws inside the report writer and the run ends with NO
    // report on disk. Every suite-level test calls the runner and never
    // `writeReport`, so this whole class was invisible to all of them.
    //
    // Deliberately per-ORACLE rather than `BenchReport.parse(report)`: the
    // runner returns a partial report (`runId` and friends are added by
    // `bench.ts`), so the whole-report parse would red on fields this layer
    // does not own. Broad within its scope on purpose — it guards every
    // oracle this runner will ever push, not only the ones below.
    for (const o of report.oracles ?? []) {
      expect(() => OracleResult.parse(o), `oracle "${o.name}" does not parse`).not.toThrow();
    }

    expect(peopleOracles.map((o) => o.name)).toEqual([
      "people: claim invites accepted",
      "people: an invalid claim token is refused",
      "people: an accepted invite is closed",
      "people: invites past the limit stay unclaimed",
      "people: a claimed profile still reports the same stats",
    ]);
    expect(emittingOracles.length).toBe(runtimeOracles.length + 2 + peopleOracles.length + newsOracles.length);
    // Every `people:` row a green run must PASS, and the last one is the
    // load-bearing one: it is `pass` only when an accepted profile carried
    // REAL numbers before acceptance (`comparedAny`), so a fake answering an
    // empty division list would land it on `no_subject` here instead. The
    // verdict is asserted, never inferred from `passed`, because a no-subject
    // row is `passed: true` on the wire.
    expect(peopleOracles.map((o) => [o.name.replace("people: ", ""), o.verdict])).toEqual([
      ["claim invites accepted", "pass"],
      ["an invalid claim token is refused", "pass"],
      ["an accepted invite is closed", "pass"],
      ["invites past the limit stay unclaimed", "pass"],
      ["a claimed profile still reports the same stats", "pass"],
    ]);
    expect(oracleEvents).toHaveLength(emittingOracles.length);
    // …and by KIND, so a mislabelled emitter cannot satisfy the count alone.
    expect(oracleEvents.filter((e) => e.kind === "seed_proposal_qualifiers")).toHaveLength(1);
    expect(oracleEvents.filter((e) => e.kind === "final_ranks")).toHaveLength(1);
    expect(oracleEvents.filter((e) => e.kind.startsWith("claims_")).map((e) => e.kind).sort()).toEqual([
      "claims_accepted",
      "claims_accepted_closed",
      "claims_invalid_token",
      "claims_profile_stats",
      "claims_untouched_open",
    ]);
    // Every OTHER oracle's verdict is untouched by this change — either
    // absent (the pre-T6 shape) or an explicit pass, never no_subject.
    // B06a task 3 widened the exempt set: the per-match rows carry an EXPLICIT
    // verdict for the same reason the cascades do — they can legitimately have
    // no subject (a division the pack declares no matches for), and B05's own
    // ruling is that "no subject" must never read as a pass. The assertion's
    // intent is unchanged: no OTHER oracle silently acquired one.
    const perMatch = runtimeOracles.filter((o) => o.name.endsWith("per-match results"));
    expect(perMatch.map((o) => o.verdict)).toEqual(new Array(perMatch.length).fill("pass"));
    const specialsRow = runtimeOracles.filter((o) => o.name === "oracle: specials");
    expect(specialsRow.map((o) => o.verdict)).toEqual(["pass"]);
    const untouched = runtimeOracles.filter(
      (o) =>
        !o.name.endsWith("tie-order cascade") &&
        !o.name.endsWith("per-match results") &&
        o.name !== "oracle: specials",
    );
    expect(untouched.map((o) => o.verdict)).toEqual(new Array(untouched.length).fill(undefined));

    // B05 T6 fix 1 — the first LIVE run failed both metric-less tables on
    // nothing but a live `metrics` map the pack never declares. This fake now
    // answers the LIVE shape for those two stages (`_oracle-routes.ts`'s
    // `tinyLeagueTableRows`), so this assertion is the wiring-level witness:
    // the tables PASS, and the undeclared metrics are still REPORTED on the
    // oracle's own detail line rather than silently dropped.
    for (const [stageRef, liveMetrics] of [
      ["d-tiny/s-league", { for: 5, diff: 2, against: 3 }],
      ["d-badminton/s-badminton-league", { sets_won: 2, sets_lost: 0, points_won: 42, points_lost: 33 }],
    ] as const) {
      const table = runtimeOracles.find((o) => o.name === `oracle: ${stageRef} standings table`);
      expect(table?.passed).toBe(true);
      expect(table?.detail).toContain("does not declare");
      for (const [k, v] of Object.entries(liveMetrics)) expect(table?.detail).toContain(`"${k}":${v}`);
    }
    // …and the table whose every live metric IS declared says nothing extra —
    // the informational channel stays silent rather than restating a clean row.
    const tiebreakTable = runtimeOracles.find((o) => o.name === "oracle: d-tiebreak/s-tiebreak-league standings table");
    expect(tiebreakTable?.detail).not.toContain("does not declare");

    // B05 — the enforcement oracle. T5b-3 left this as a WARNING that pinned
    // no status, because the product had not decided whether discipline was
    // advisory; B05 decided (`putLineup` -> `gateLineupSuspensions`), so the
    // measurement is an assertion and this pins BOTH of its halves. The
    // warning it replaced is gone, and that absence is asserted too — a
    // measurement left lying beside an assertion is how two answers to one
    // question start drifting apart.
    const enforcement = runtimeOracles.find((o) => o.name.includes("discipline enforced"));
    expect(enforcement?.passed).toBe(true);
    expect(enforcement?.detail).toContain("rr-r3-c1");
    expect(enforcement?.detail).toContain("p-hotel");
    expect(enforcement?.detail).toContain("422 SUSPENDED_PLAYER");
    // The POSITIVE half is named, not merely implied: a detail that only said
    // "refused" would read identically against a gate that refuses everybody.
    expect(enforcement?.detail).toMatch(/ELIGIBLE team-mate "p-\w+" alone was ACCEPTED/);
    expect((report.warnings ?? []).some((w) => w.includes("discipline enforcement probe"))).toBe(false);

    // B05 T5b-2 — HOW MANY subjects each new oracle actually compared, not
    // merely that it ran. A reachability assertion is satisfied by any
    // value (AGENTS.md rule 19): a career block that passed an EMPTY expected
    // list to `compareCareerStats` would still push a passing, correctly-
    // named oracle here. Both counts are read out of the pack rather than
    // typed, so a pack that grows a metric or an entrant moves the assertion
    // with it instead of leaving it pinning yesterday's number.
    const packExpected = (
      JSON.parse(await readFile(TINY_PACK_PATH, "utf8")) as {
        expected: {
          careers: { person: string }[];
          leaderboards: { divisionRef: string; metricKey: string; entries: unknown[] }[];
        };
      }
    ).expected;
    const anaCareerRows = packExpected.careers.filter((c) => c.person === "p-ana").length;
    expect(anaCareerRows).toBeGreaterThan(0);
    const careerOracle = runtimeOracles.find((o) => o.name === "oracle: p-ana career rollup");
    expect(careerOracle?.detail).toContain(`all ${anaCareerRows} of this person's`);

    const tinyScoresBoard = packExpected.leaderboards.find(
      (b) => b.divisionRef === "d-tiny" && b.metricKey === "scores",
    );
    expect(tinyScoresBoard?.entries.length).toBeGreaterThan(0);
    const tinyScoresCards = runtimeOracles.find((o) => o.name === "oracle: d-tiny person cards (scores)");
    expect(tinyScoresCards?.detail).toContain(`each of the ${tinyScoresBoard?.entries.length} person(s)`);
  });

  // B05 T4b — D6, MOVED ONTO THE WIRED PATH (the re-pin's own instruction:
  // "this regression must now run through the WIRED leaderboard oracle, not
  // only through a unit fixture — otherwise D6 proves the comparator and
  // not the pipeline"). `oracle.test.ts`'s own D6 test proves
  // `compareLeaderboard` itself, fed a hand-built `liveDerivedActual`; this
  // one proves the WIRING — the mutated pack's stream is folded through the
  // REAL `simulateDivisionStreams`/`/fixtures/{id}/events` path, and the
  // fake's `getDivisionPlayerStats` (this file's own live tally, not a
  // fixture) answers with whatever that fold actually produced.
  it("D6 — a mis-transcribed generic.score stays invisible to stage 0, but reds the WIRED leaderboard oracle", async () => {
    // The SAME mutation `oracle.test.ts`'s own D6 test uses: `rr-r2-c1`'s
    // `@p-bo` scoring event re-attributed to `@p-ana`. `by` (the SIDE,
    // `@e-bravo`) is untouched, so the fixture's own outcome/standings stay
    // exactly what stage 0 already checks — only who gets PERSONAL credit
    // changes, which stage 0's own header names as the one thing it cannot
    // see.
    const raw = JSON.parse(await readFile(TINY_PACK_PATH, "utf8")) as {
      streams: { fixtureExtKey: string; events: { type: string; payload?: Record<string, string | number> }[] }[];
    };
    const stream = raw.streams.find((st) => st.fixtureExtKey === "rr-r2-c1");
    if (stream === undefined) throw new Error("test fixture assumption broken: rr-r2-c1 stream not found");
    const boEvent = stream.events.find((e) => e.type === "generic.score" && e.payload?.person === "@p-bo");
    if (boEvent?.payload === undefined) throw new Error("test fixture assumption broken: no @p-bo scoring event");
    boEvent.payload.person = "@p-ana"; // the mis-transcription

    // The filename must stay `_tiny.json`: `pack-schema.ts`'s own
    // `suite_mismatch` check refuses a pack whose declared `suite` disagrees
    // with the file it was loaded from — a different temp DIRECTORY keeps
    // this isolated from the real committed pack without tripping it.
    const dir = await mkdtemp(join(tmpdir(), "b05-d6-"));
    const mutatedPackPath = join(dir, "_tiny.json");
    await writeFile(mutatedPackPath, JSON.stringify(raw), "utf8");

    const { transport, sql } = fakeServer();
    const report = await runTinySuite({
      base: "http://bench.example",
      engine: "optimized",
      keep: false,
      log: silent,
      cliEntry: "admin",
      packPath: mutatedPackPath,
      transport,
      sql,
      probeTransport: transport,
      simTransport: transport,
      importTransport: transport,
      startTransport: transport,
      advanceTransport: transport,
      oracleTransport: transport,
      matchBoard: echoExpectedBoard,
      specialSubjects: echoSpecialSubjects,
    });

    // The mutated pack still reaches the live run at all — stage 0 does NOT
    // derive `expected.leaderboards` from events (`validate-pack.ts`'s own
    // "LIMITS" header), so this is a warning, never a stage-0 error.
    const leaderboardOracles = (report.oracles ?? []).filter((o) => o.name.startsWith("oracle: d-tiny leaderboard"));
    expect(leaderboardOracles.map((o) => o.name)).toEqual([
      "oracle: d-tiny leaderboard (scores)",
      "oracle: d-tiny leaderboard (points)",
    ]);
    // Both metrics disagree: the live tally now shows p-ana with 3
    // scores/4 points (three events, one worth 2) and p-bo with 0/0, against
    // the pack's OWN unchanged `expected.leaderboards` (2/1 scores, 2/2
    // points) — a REAL disagreement the wiring caught, not a restated
    // fixture (`expected.leaderboards` is read from the pack exactly once,
    // by `lib/suites/tiny.ts`'s own T4b block, never re-derived here).
    expect(leaderboardOracles.map((o) => o.passed)).toEqual([false, false]);
    expect(report.gate).toBe("red");
    expect((report.errors ?? []).some((e) => e.includes("d-tiny/scores") || e.includes("leaderboard"))).toBe(true);
  });

  // B06a task 7 — the news rail's three DISCRIMINATING wiring tests. Each
  // knob reds ONE oracle and no other: two guards covering for each other are
  // each untested, so they are mutated one at a time.
  it("B06a T7 — a republish that MOVES published_at reds the run", async () => {
    // The fire-once proxy, and the only part of `shouldFirePostPublished` a
    // client can see: its real effect is a PostHog call with no row, no
    // outbox and no webhook, so nothing else in this bench could witness it.
    const { transport, sql } = fakeServer({ newsRoutes: { republishBumpsTimestamp: true } });
    const report = await runTinySuite({
      base: "http://bench.example",
      engine: "optimized",
      keep: false,
      log: silent,
      cliEntry: "admin",
      packPath: TINY_PACK_PATH,
      transport,
      sql,
      probeTransport: transport,
      simTransport: transport,
      importTransport: transport,
      startTransport: transport,
      advanceTransport: transport,
      oracleTransport: transport,
      matchBoard: echoExpectedBoard,
      specialSubjects: echoSpecialSubjects,
    });

    const republish = (report.oracles ?? []).find((o) => o.name === "news: a republish does not move published_at");
    expect(republish).toMatchObject({ passed: false, verdict: "fail", subject: true });
    expect(report.gate).toBe("red");
    expect((report.errors ?? []).some((e) => e.includes("moved published_at"))).toBe(true);
    // The drafting and publishing oracles are untouched — one knob, one red.
    expect((report.oracles ?? []).find((o) => o.name === "news: folding drafted posts")).toMatchObject({
      verdict: "pass",
    });
  });

  it("B06a T7 — a run that publishes EVERY draft reds: the draft state is then unproven", async () => {
    // What stays draft is half of what this step proves. A run that published
    // everything has demonstrated that publishing works and NOTHING about the
    // draft state it was supposed to leave behind — so the oracle fails even
    // though every named fixture published successfully.
    const { transport, sql } = fakeServer({ newsRoutes: { keepOnlyLastDraft: true } });

    const report = await runTinySuite({
      base: "http://bench.example",
      engine: "optimized",
      keep: false,
      log: silent,
      cliEntry: "admin",
      packPath: TINY_PACK_PATH,
      transport,
      sql,
      probeTransport: transport,
      simTransport: transport,
      importTransport: transport,
      startTransport: transport,
      advanceTransport: transport,
      oracleTransport: transport,
      matchBoard: echoExpectedBoard,
      specialSubjects: echoSpecialSubjects,
    });

    const publishOracle = (report.oracles ?? []).find(
      (o) => o.name === "news: the named fixtures publish and the rest stay draft",
    );
    expect(publishOracle).toMatchObject({ passed: false, verdict: "fail", subject: true });
    expect(publishOracle?.detail).toContain("NOTHING stayed draft");
    expect(report.news).toMatchObject({ drafted: 1, published: 1 });
    expect(report.gate).toBe("red");
    // Drafting itself still worked — one knob, one red.
    expect((report.oracles ?? []).find((o) => o.name === "news: folding drafted posts")).toMatchObject({
      verdict: "pass",
    });
  });

  it("B06a T7 — a product that drafts nothing reports NO SUBJECT, never a pass", async () => {
    // Five preconditions can each legitimately produce zero drafts
    // (`org-posts.ts:479-485`), so zero must never read as a working news
    // layer. It is also not an ERROR: the run says it proved nothing.
    const { transport, sql } = fakeServer({ newsRoutes: { draftNothing: true } });
    const report = await runTinySuite({
      base: "http://bench.example",
      engine: "optimized",
      keep: false,
      log: silent,
      cliEntry: "admin",
      packPath: TINY_PACK_PATH,
      transport,
      sql,
      probeTransport: transport,
      simTransport: transport,
      importTransport: transport,
      startTransport: transport,
      advanceTransport: transport,
      oracleTransport: transport,
      matchBoard: echoExpectedBoard,
      specialSubjects: echoSpecialSubjects,
    });

    const drafted = (report.oracles ?? []).find((o) => o.name === "news: folding drafted posts");
    expect(drafted).toMatchObject({ passed: true, verdict: "no_subject", subject: false });
    expect(report.news).toMatchObject({ drafted: 0, published: 0 });
    expect(
      (report.warnings ?? []).some((w) => w.includes("drafted") && w.includes("no subject")),
    ).toBe(true);
    // A run that drafted nothing has not tested the fire-once predicate
    // either, and must not claim it did.
    expect((report.oracles ?? []).find((o) => o.name === "news: a republish does not move published_at")).toMatchObject(
      { verdict: "no_subject", subject: false },
    );
    // Drafting nothing is not a FAILURE — the gate stays green and the run
    // says what it could not prove.
    expect(report.gate).toBe("green");
  });

  it("B06a T7 — an org that cannot buy news.auto never turns drafting on, and says so", async () => {
    // `PATCH /divisions/{id}` refuses `auto_posts: true` without the
    // entitlement (`usecases/divisions.ts:652-654`). Because drafting is a
    // side effect of FOLDING there is no later moment at which the run could
    // recover, so this has to be visible rather than inferred from an empty
    // draft list much later.
    const { transport, sql } = fakeServer({ newsRoutes: { newsAutoGranted: false } });
    const report = await runTinySuite({
      base: "http://bench.example",
      engine: "optimized",
      keep: false,
      log: silent,
      cliEntry: "admin",
      packPath: TINY_PACK_PATH,
      transport,
      sql,
      probeTransport: transport,
      simTransport: transport,
      importTransport: transport,
      startTransport: transport,
      advanceTransport: transport,
      oracleTransport: transport,
      matchBoard: echoExpectedBoard,
      specialSubjects: echoSpecialSubjects,
    });

    expect((report.errors ?? []).some((e) => e.includes("auto-posting could not be turned on"))).toBe(true);
    expect(report.gate).toBe("red");
    // Nothing downstream pretends: no news oracle is pushed at all, rather
    // than three rows reporting on a step that never ran.
    expect((report.oracles ?? []).filter((o) => o.name.startsWith("news:"))).toEqual([]);
    expect(report.news).toBeUndefined();
  });

  // B06a task 6 — the claim rail's two DISCRIMINATING wiring tests.
  //
  // The green run above proves acceptance works. Neither of these can pass
  // against a claim surface that waves everything through, which is exactly
  // the failure the whole negative case exists for: a bench that only ever
  // accepts VALID tokens has proven that the happy path works and nothing at
  // all about whether the product checks the token.
  it("B06a T6 — a claim surface that accepts an unminted token reds the run", async () => {
    const { transport, sql } = fakeServer({ claimRoutes: { acceptAnyToken: true } });

    const report = await runTinySuite({
      base: "http://bench.example",
      engine: "optimized",
      keep: false,
      log: silent,
      cliEntry: "admin",
      packPath: TINY_PACK_PATH,
      transport,
      sql,
      probeTransport: transport,
      simTransport: transport,
      importTransport: transport,
      startTransport: transport,
      advanceTransport: transport,
      oracleTransport: transport,
      matchBoard: echoExpectedBoard,
      specialSubjects: echoSpecialSubjects,
    });

    const negative = (report.oracles ?? []).find((o) => o.name === "people: an invalid claim token is refused");
    expect(negative).toMatchObject({ passed: false, verdict: "fail", subject: true });
    expect(negative?.detail).toContain("HTTP 200");
    expect(report.gate).toBe("red");
    expect((report.errors ?? []).some((e) => e.includes("not validating the token"))).toBe(true);
    // The REAL acceptances still succeeded — the run reds on the negative case
    // alone, so this is not a fake that simply broke everything.
    expect((report.oracles ?? []).find((o) => o.name === "people: claim invites accepted")).toMatchObject({
      passed: true,
      verdict: "pass",
    });
  });

  it("B06a T6 — a claim surface that refuses a real invite reds the run and names the status", async () => {
    const { transport, sql } = fakeServer({ claimRoutes: { refuseWith: 409 } });

    const report = await runTinySuite({
      base: "http://bench.example",
      engine: "optimized",
      keep: false,
      log: silent,
      cliEntry: "admin",
      packPath: TINY_PACK_PATH,
      transport,
      sql,
      probeTransport: transport,
      simTransport: transport,
      importTransport: transport,
      startTransport: transport,
      advanceTransport: transport,
      oracleTransport: transport,
      matchBoard: echoExpectedBoard,
      specialSubjects: echoSpecialSubjects,
    });

    const accepted = (report.oracles ?? []).find((o) => o.name === "people: claim invites accepted");
    expect(accepted).toMatchObject({ passed: false, verdict: "fail", subject: true });
    expect(accepted?.detail).toContain("HTTP 409");
    expect(report.gate).toBe("red");
    // And the negative case does NOT report a pass off the back of it: every
    // acceptance failed, so a refusal of the tampered token proves the session
    // was missing rather than that the token was checked. That is NO SUBJECT,
    // not a failure — the claim surface here refuses everything, which is not
    // evidence that it validates tokens, and calling it a token-validation
    // defect would name a cause this run never established.
    const negative = (report.oracles ?? []).find((o) => o.name === "people: an invalid claim token is refused");
    expect(negative).toMatchObject({ verdict: "no_subject", subject: false, passed: true });
    expect(negative?.detail).toContain("accepted NO real invite");
    // …and it contributes no error of its own: the run is red on the
    // acceptances alone.
    expect((report.errors ?? []).some((e) => e.includes("not validating the token"))).toBe(false);
    // Nothing was accepted, so the "an accepted invite is closed" row is not
    // pushed at all — a run that reported it here would be reporting on an
    // empty set.
    expect((report.oracles ?? []).some((o) => o.name === "people: an accepted invite is closed")).toBe(false);
  });

  it("B06a T6 — a claim surface that closes invites nobody touched reds the run", async () => {
    const { transport, sql } = fakeServer({ claimRoutes: { closeUntouched: true } });

    const report = await runTinySuite({
      base: "http://bench.example",
      engine: "optimized",
      keep: false,
      log: silent,
      cliEntry: "admin",
      packPath: TINY_PACK_PATH,
      transport,
      sql,
      probeTransport: transport,
      simTransport: transport,
      importTransport: transport,
      startTransport: transport,
      advanceTransport: transport,
      oracleTransport: transport,
      matchBoard: echoExpectedBoard,
      specialSubjects: echoSpecialSubjects,
    });

    const untouched = (report.oracles ?? []).find((o) => o.name === "people: invites past the limit stay unclaimed");
    expect(untouched).toMatchObject({ passed: false, verdict: "fail", subject: true });
    expect(untouched?.detail).toContain("no longer open");
    expect(report.gate).toBe("red");
    expect((report.errors ?? []).some((e) => e.includes("nobody asked it to"))).toBe(true);
    // The acceptances themselves still succeeded, so this reds on the
    // untouched invites alone rather than on a broken claim surface.
    expect((report.oracles ?? []).find((o) => o.name === "people: claim invites accepted")).toMatchObject({
      verdict: "pass",
    });
  });

  it("B06a T6 — a profile whose stats CHANGE when it is claimed reds the run", async () => {
    const { transport, sql } = fakeServer({ statsChangeAfterClaim: true });

    const report = await runTinySuite({
      base: "http://bench.example",
      engine: "optimized",
      keep: false,
      log: silent,
      cliEntry: "admin",
      packPath: TINY_PACK_PATH,
      transport,
      sql,
      probeTransport: transport,
      simTransport: transport,
      importTransport: transport,
      startTransport: transport,
      advanceTransport: transport,
      oracleTransport: transport,
      matchBoard: echoExpectedBoard,
      specialSubjects: echoSpecialSubjects,
    });

    const drift = (report.oracles ?? []).find(
      (o) => o.name === "people: a claimed profile still reports the same stats",
    );
    expect(drift).toMatchObject({ passed: false, verdict: "fail", subject: true });
    expect(drift?.detail).toContain("DIFFERENT stats");
    expect(report.gate).toBe("red");
    expect((report.errors ?? []).some((e) => e.includes("changed the stats it reports"))).toBe(true);
  });

  // B06a task 4 — the specials oracle's DISCRIMINATING wiring test, and the
  // reason `echoSpecialSubjects` above is never evidence: it satisfies every
  // claim by construction. This one hands back a subject that DISAGREES with
  // the pack on one claim and asserts the run reds naming it.
  it("B06a T4 — a special whose claim does NOT hold reds the run and names the claim", async () => {
    const { transport, sql } = fakeServer();

    const report = await runTinySuite({
      base: "http://bench.example",
      engine: "optimized",
      keep: false,
      log: silent,
      cliEntry: "admin",
      packPath: TINY_PACK_PATH,
      transport,
      sql,
      probeTransport: transport,
      simTransport: transport,
      importTransport: transport,
      startTransport: transport,
      advanceTransport: transport,
      oracleTransport: transport,
      matchBoard: echoExpectedBoard,
      specialSubjects: ({ specials }) => {
        const honest = echoSpecialSubjects({ specials });
        // `_tiny`'s single special claims `state.phase === "done"`. Serve a
        // fixture that is still live instead.
        const tampered = new Map(honest);
        for (const [key, subject] of honest) {
          tampered.set(key, { ...subject, state: { ...(subject.state as object), phase: "live" } });
        }
        return tampered;
      },
    });

    const specialsOracle = (report.oracles ?? []).find((o) => o.name === "oracle: specials");
    expect(specialsOracle).toMatchObject({ passed: false, verdict: "fail", subject: true });
    expect(report.gate).toBe("red");
    const message = (report.errors ?? []).find((e) => e.includes("special claim failed"));
    expect(message).toContain("state.phase");
    expect(message).toContain("expected done");
    expect(message).toContain("got live");
    // The OTHER claims on that special still passed, so the failure is one
    // claim rather than the whole subject being lost.
    expect(specialsOracle?.detail).toContain("1 failed");
  });

  // B06a task 3 — the per-match oracle's DISCRIMINATING wiring test.
  //
  // Every other suite-level run in this file injects `echoExpectedBoard`,
  // which hands the pack's own expectation back as the live board and makes
  // the oracle vacuous by construction. That is fine for tests whose subject
  // is something else, and worthless as evidence that the oracle works — so
  // this one injects a board that DISAGREES and asserts the run reds with the
  // fixture named. Delete the comparison from `run-suite.ts` and this is the
  // test that goes green when it should not.
  it("B06a T3 — a WRONG per-match outcome reds the run and names the fixture", async () => {
    const { transport, sql } = fakeServer();

    const report = await runTinySuite({
      base: "http://bench.example",
      engine: "optimized",
      keep: false,
      log: silent,
      cliEntry: "admin",
      packPath: TINY_PACK_PATH,
      transport,
      sql,
      probeTransport: transport,
      simTransport: transport,
      importTransport: transport,
      startTransport: transport,
      advanceTransport: transport,
      oracleTransport: transport,
      // One division's first declared match comes back with the winner and
      // loser swapped; everything else echoes. A blanket wrong board would
      // pass a comparator that ignored the pack entirely.
      matchBoard: ({ divisionRef, expected }) => {
        const rows = echoExpectedBoard({ expected });
        if (divisionRef !== "d-tiny") return rows;
        return rows.map((row, i) => {
          const o = row.outcome as { kind?: string; winner?: string; loser?: string };
          if (i !== 0 || o.kind !== "win") return row;
          return { ...row, outcome: { ...o, winner: o.loser, loser: o.winner } };
        });
      },
    });

    const perMatch = (report.oracles ?? []).filter((o) => o.name.endsWith("per-match results"));
    // Exactly the tampered division reds — not all three (the knob leaked)
    // and not none (the comparison never ran).
    expect(perMatch.map((o) => `${o.name}:${o.passed}`)).toEqual([
      "oracle: d-tiny per-match results:false",
      "oracle: d-badminton per-match results:true",
      "oracle: d-tiebreak per-match results:true",
    ]);
    expect(report.gate).toBe("red");
    const message = (report.errors ?? []).find((e) => e.includes("per-match mismatch"));
    expect(message).toContain("d-tiny");
    expect(message).toContain("winner");
    // The subject count is reported, so a future change that quietly stops
    // comparing shows up as a shrinking number rather than a silent pass.
    expect(perMatch[0]?.detail).toContain("4 checked");
  });

  it("B06a T3 — stage 0 REFUSES a pack whose streams have no expected match", async () => {
    // Why the per-match oracle has no `no_subject` branch, pinned rather than
    // asserted in a comment. The mutation sweep found the first version of
    // that branch unreachable; this is the guarantee that makes it so — a
    // pack that replays a stream it declares no expected result for is
    // refused OFFLINE, before anything is seeded.
    const raw = JSON.parse(await readFile(TINY_PACK_PATH, "utf8")) as {
      expected: { matches?: unknown[] };
    };
    if (raw.expected.matches === undefined || raw.expected.matches.length === 0) {
      throw new Error("test fixture assumption broken: the committed pack declares no expected.matches");
    }
    raw.expected.matches = [];

    const dir = await mkdtemp(join(tmpdir(), "b06a-t3-nomatches-"));
    const mutatedPackPath = join(dir, "_tiny.json");
    await writeFile(mutatedPackPath, JSON.stringify(raw), "utf8");

    const { transport, sql } = fakeServer();
    const report = await runTinySuite({
      base: "http://bench.example",
      engine: "optimized",
      keep: false,
      log: silent,
      cliEntry: "admin",
      packPath: mutatedPackPath,
      transport,
      sql,
      probeTransport: transport,
      simTransport: transport,
      importTransport: transport,
      startTransport: transport,
      advanceTransport: transport,
      oracleTransport: transport,
      matchBoard: echoExpectedBoard,
      specialSubjects: echoSpecialSubjects,
    });

    expect(report.gate).toBe("red");
    expect((report.errors ?? []).join(" ")).toContain("a replayed stream with no oracle asserts nothing");
    // Refused OFFLINE: nothing was seeded, so no oracle ran at all.
    expect(report.oracles ?? []).toHaveLength(0);
  });

  // B05 T4b — `compareStandings`'s empty-case discipline ("an empty rows
  // array must not vacuously satisfy the comparison"), proven through the
  // WIRING: `d-badminton`'s own `GET /stages/{id}/standings` answers ZERO
  // rows (as if its fold never happened), against a non-empty
  // `expected.tables` row. `oracle.test.ts`'s own unit tests already prove
  // `compareStandings` itself does this ("the EMPTY set is checked
  // explicitly" — empty vs empty matches, empty actual vs non-empty
  // expected reds); this proves the WIRED path reaches that same discipline
  // rather than short-circuiting past it (e.g. skipping the comparison
  // entirely for a stage with no rows).
  it("B05 T4b — an EMPTY standings table reds the wired comparator, never vacuously", async () => {
    const { transport, sql } = fakeServer({ emptyBadmintonStandings: true });

    const report = await runTinySuite({
      base: "http://bench.example",
      engine: "optimized",
      keep: false,
      log: silent,
      cliEntry: "admin",
      packPath: TINY_PACK_PATH,
      transport,
      sql,
      probeTransport: transport,
      simTransport: transport,
      importTransport: transport,
      startTransport: transport,
      advanceTransport: transport,
      oracleTransport: transport,
      matchBoard: echoExpectedBoard,
      specialSubjects: echoSpecialSubjects,
    });

    const tableOracles = (report.oracles ?? []).filter((o) => o.name.endsWith("standings table"));
    // B05 T5a added a THIRD table (`d-tiebreak`'s own), untouched by this
    // knob just like d-tiny's — the knob only hollows out d-badminton's.
    expect(tableOracles.map((o) => o.name)).toEqual([
      "oracle: d-tiny/s-league standings table",
      "oracle: d-badminton/s-badminton-league standings table",
      "oracle: d-tiebreak/s-tiebreak-league standings table",
    ]);
    // d-tiny's and d-tiebreak's own tables are UNTOUCHED by this knob —
    // only d-badminton's fetch was hollowed out — so the middle entry must
    // disagree with its neighbours, never all three red (which would
    // suggest the knob leaked) or all three green (which would suggest the
    // empty case was silently ignored).
    expect(tableOracles.map((o) => o.passed)).toEqual([true, false, true]);
    expect(report.gate).toBe("red");
    expect((report.errors ?? []).some((e) => e.includes("d-badminton/s-badminton-league"))).toBe(true);
  });

  // B05 T5a review MINOR — `compareLeaderboard`'s own empty-case discipline
  // (`oracle.test.ts`: "the EMPTY set: an empty actual leaderboard against
  // non-empty expected reds every entry, never vacuously") is unit-tested
  // but had no WIRED equivalent, asymmetric with standings' own empty-case
  // wiring proof just above. `GET /divisions/{id}/stats/players` answers
  // `d-tiny`'s division with `{metrics:[],rows:[],requires_detailed_scoring:
  // true}` — the SAME empty shape the unit test uses — in place of this
  // fake's real live tally, against the pack's own non-empty
  // `expected.leaderboards` rows.
  it("B05 T5a — an EMPTY leaderboard reds the wired comparator, never vacuously (symmetric with standings' empty case)", async () => {
    const { transport, sql } = fakeServer({ emptyLeaderboard: true });

    const report = await runTinySuite({
      base: "http://bench.example",
      engine: "optimized",
      keep: false,
      log: silent,
      cliEntry: "admin",
      packPath: TINY_PACK_PATH,
      transport,
      sql,
      probeTransport: transport,
      simTransport: transport,
      importTransport: transport,
      startTransport: transport,
      advanceTransport: transport,
      oracleTransport: transport,
      matchBoard: echoExpectedBoard,
      specialSubjects: echoSpecialSubjects,
    });

    const leaderboardOracles = (report.oracles ?? []).filter((o) => o.name.startsWith("oracle: d-tiny leaderboard"));
    expect(leaderboardOracles.map((o) => o.name)).toEqual([
      "oracle: d-tiny leaderboard (scores)",
      "oracle: d-tiny leaderboard (points)",
    ]);
    // Every entry reds against the empty actual — never a vacuous pass just
    // because there was nothing to fetch.
    expect(leaderboardOracles.map((o) => o.passed)).toEqual([false, false]);
    expect(report.gate).toBe("red");
    expect((report.errors ?? []).some((e) => e.includes("d-tiny/scores") || e.includes("leaderboard"))).toBe(true);
  });

  // B05 T5b-2 — the two person-stats comparators' own empty cases, each
  // proven THROUGH THE WIRE and each in ISOLATION. The isolation is the
  // point: a knob that reddened its own oracle AND a sibling's would be two
  // guards covering for each other, and neither would be evidence for the
  // other. So each of these tests asserts BOTH that its own oracle went red
  // and that every sibling oracle over the same subjects stayed green.
  it("B05 T5b-2 — an EMPTY career rollup (no sports) reds the wired career oracle, and NOTHING else", async () => {
    const { transport, sql } = fakeServer({ emptyCareerSports: true });

    const report = await runTinySuite({
      base: "http://bench.example",
      engine: "optimized",
      keep: false,
      log: silent,
      cliEntry: "admin",
      packPath: TINY_PACK_PATH,
      transport,
      sql,
      probeTransport: transport,
      simTransport: transport,
      importTransport: transport,
      startTransport: transport,
      advanceTransport: transport,
      oracleTransport: transport,
      matchBoard: echoExpectedBoard,
      specialSubjects: echoSpecialSubjects,
    });

    const oracles = report.oracles ?? [];
    // `compareCareerStats([], {sports: []})` is a MATCH by the comparator's
    // own documented contract. What must not happen is that contract being
    // reached with a NON-empty expected set and still passing: `_tiny`'s two
    // authored `expected.careers` rows are both absent from an empty
    // `sports[]`, so both must red.
    const careerOracle = oracles.find((o) => o.name === "oracle: p-ana career rollup");
    expect(careerOracle).toBeDefined();
    expect(careerOracle?.passed).toBe(false);
    expect(report.gate).toBe("red");
    expect((report.errors ?? []).some((e) => e.includes("career rollup"))).toBe(true);
    // ISOLATION — the knob is scoped to `?group=sport` alone, so every OTHER
    // oracle over the same persons and the same counts is still green. If
    // this list ever goes red alongside the career oracle, the fault is the
    // fake leaking between routes and the assertion above stops being
    // evidence for the career block specifically.
    const siblings = oracles.filter(
      (o) => o.name.includes("person cards") || o.name.includes("leaderboard"),
    );
    expect(siblings).toHaveLength(8);
    expect(siblings.every((o) => o.passed)).toBe(true);
  });

  it("B05 T5b-2 — an EMPTY person card (no divisions) reds the wired person-card oracles, and NOTHING else", async () => {
    const { transport, sql } = fakeServer({ emptyPersonDivisions: true });

    const report = await runTinySuite({
      base: "http://bench.example",
      engine: "optimized",
      keep: false,
      log: silent,
      cliEntry: "admin",
      packPath: TINY_PACK_PATH,
      transport,
      sql,
      probeTransport: transport,
      simTransport: transport,
      importTransport: transport,
      startTransport: transport,
      advanceTransport: transport,
      oracleTransport: transport,
      matchBoard: echoExpectedBoard,
      specialSubjects: echoSpecialSubjects,
    });

    const oracles = report.oracles ?? [];
    // Every board's cross-check reds: the person's own card names NO
    // division at all, so `comparePersonDivisionStat` finds no row — the
    // `actualCount === undefined` case, which must never read as a pass.
    const cardOracles = oracles.filter((o) => o.name.includes("person cards"));
    expect(cardOracles.map((o) => o.name)).toEqual([
      "oracle: d-tiny person cards (scores)",
      "oracle: d-tiny person cards (points)",
      "oracle: d-tiebreak person cards (scores)",
      "oracle: d-tiebreak person cards (points)",
    ]);
    expect(cardOracles.map((o) => o.passed)).toEqual([false, false, false, false]);
    expect(cardOracles[0]?.detail).toContain("(absent)");
    expect(report.gate).toBe("red");
    expect((report.errors ?? []).some((e) => e.includes("/persons/{id}/stats card"))).toBe(true);
    // ISOLATION — the division leaderboards and the career rollup read
    // different routes and are untouched by this knob.
    const siblings = oracles.filter((o) => o.name.includes("leaderboard") || o.name.includes("career rollup"));
    expect(siblings).toHaveLength(5);
    expect(siblings.every((o) => o.passed)).toBe(true);
  });

  // -------------------------------------------------------------------------
  // B05 T5b-3 — the discipline carry
  // -------------------------------------------------------------------------

  it("B05 T5b-3 — a product that bans EVERYBODY reds the carry oracle, even though every negative check still holds", async () => {
    // The POSITIVE half, and the reason it is mandatory. Here the division's
    // active-ban list comes back naming every member of the banned player's
    // entrant. The banned player IS banned, her ban IS the right length, she
    // IS off the named sheet and ON the other one — every negative assertion
    // passes. Only the eligible team-mate's own verdict can see this.
    const { transport, sql } = fakeServer({ disciplineBansEveryone: true });
    const report = await runTinySuite({
      base: "http://bench.example",
      engine: "optimized",
      keep: false,
      log: silent,
      cliEntry: "admin",
      packPath: TINY_PACK_PATH,
      transport,
      sql,
      probeTransport: transport,
      simTransport: transport,
      importTransport: transport,
      startTransport: transport,
      advanceTransport: transport,
      oracleTransport: transport,
      matchBoard: echoExpectedBoard,
      specialSubjects: echoSpecialSubjects,
    });

    expect(report.gate).toBe("red");
    const carry = (report.oracles ?? []).find((o) => o.name.includes("discipline carry"));
    expect(carry).toBeDefined();
    expect(carry?.passed).toBe(false);
    expect(carry?.detail).toContain("refused everybody");
    expect(
      (report.errors ?? []).some((e) => e.includes("discipline") || e.includes("expected.suspensions")),
    ).toBe(true);
  });

  it("B05 T5b-3 — a ban that reaches EVERY fixture reds on fixture identity, not on absence", async () => {
    // "Ineligible for exactly the right fixture" versus "ineligible
    // somewhere". Here the banned player is off EVERY team sheet, so
    // `presentOnMissed` is still empty and the ban is still active and
    // correctly sized — the only check that can witness it is the one that
    // requires her PRESENT on a fixture the pack does not name.
    const { transport, sql } = fakeServer({ disciplineBanOverReaches: true });
    const report = await runTinySuite({
      base: "http://bench.example",
      engine: "optimized",
      keep: false,
      log: silent,
      cliEntry: "admin",
      packPath: TINY_PACK_PATH,
      transport,
      sql,
      probeTransport: transport,
      simTransport: transport,
      importTransport: transport,
      startTransport: transport,
      advanceTransport: transport,
      oracleTransport: transport,
      matchBoard: echoExpectedBoard,
      specialSubjects: echoSpecialSubjects,
    });

    expect(report.gate).toBe("red");
    const carry = (report.oracles ?? []).find((o) => o.name.includes("discipline carry"));
    expect(carry?.passed).toBe(false);
    expect(carry?.detail).toContain("which the pack does NOT name");
  });

  it("B05 — an ADVISORY lineup gate (the pre-B05 product) reds the enforcement oracle, and the carry oracle cannot see it", async () => {
    // The wiring regression this task owes. `advisoryLineupGate` restores the
    // product as it was before B05: `putLineup` accepts a banned player onto
    // any team sheet. Nothing else about the world changes — the ban is still
    // created, confirmed, active, correctly sized and stamped on the right
    // entrant.
    //
    // The second assertion is the point of adding a SEPARATE oracle rather
    // than folding enforcement into `compareSuspensions`: the carry oracle
    // still PASSES here, because this bench writes the sheets it wants and an
    // advisory product stores them faithfully. Only a live 422 can witness the
    // gate, so only the enforcement oracle reds.
    const { transport, sql } = fakeServer({ disciplineAdvisoryLineupGate: true });
    const report = await runTinySuite({
      base: "http://bench.example",
      engine: "optimized",
      keep: false,
      log: silent,
      cliEntry: "admin",
      packPath: TINY_PACK_PATH,
      transport,
      sql,
      probeTransport: transport,
      simTransport: transport,
      importTransport: transport,
      startTransport: transport,
      advanceTransport: transport,
      oracleTransport: transport,
      matchBoard: echoExpectedBoard,
      specialSubjects: echoSpecialSubjects,
    });

    expect(report.gate).toBe("red");
    const enforcement = (report.oracles ?? []).find((o) => o.name.includes("discipline enforced"));
    expect(enforcement).toBeDefined();
    expect(enforcement?.passed).toBe(false);
    expect(enforcement?.detail).toContain("was NOT refused");
    expect(enforcement?.detail).toContain("expected 422 SUSPENDED_PLAYER");
    expect(
      (report.errors ?? []).some((e) => e.includes("the lineup gate did not enforce")),
    ).toBe(true);
    // The carry oracle is BLIND to this, which is why enforcement is its own
    // subject and not an extra clause inside `compareSuspensions`.
    const carry = (report.oracles ?? []).find((o) => o.name.includes("discipline carry"));
    expect(carry?.passed).toBe(true);
  });

  it("B05 — a gate that refuses EVERY team sheet reds the enforcement oracle on its POSITIVE half", async () => {
    // The mirror of the advisory mutant above, and the reason the enforcement
    // oracle asserts two things rather than one. Here every lineup PUT answers
    // 422 SUSPENDED_PLAYER — so "the banned player was refused" is TRUE, and
    // the oracle must still red, because the eligible team-mate was refused
    // too. A one-sided check passes against exactly this product.
    const { transport, sql } = fakeServer({ disciplineRefusesEveryLineup: true });
    const report = await runTinySuite({
      base: "http://bench.example",
      engine: "optimized",
      keep: false,
      log: silent,
      cliEntry: "admin",
      packPath: TINY_PACK_PATH,
      transport,
      sql,
      probeTransport: transport,
      simTransport: transport,
      importTransport: transport,
      startTransport: transport,
      advanceTransport: transport,
      oracleTransport: transport,
      matchBoard: echoExpectedBoard,
      specialSubjects: echoSpecialSubjects,
    });

    expect(report.gate).toBe("red");
    const enforcement = (report.oracles ?? []).find((o) => o.name.includes("discipline enforced"));
    expect(enforcement?.passed).toBe(false);
    // The NEGATIVE half held — the failure is entirely the positive one.
    expect(enforcement?.detail).not.toContain("was NOT refused");
    expect(enforcement?.detail).toContain("was refused too");
    expect(enforcement?.detail).toContain("refusing everybody");
  });

  it("B05 T5b-3 — a pack with NO expected.suspensions reports a warning and NO carry oracle, never a vacuous pass", async () => {
    // The empty case, stated the same way T5b-2's career block states its
    // own: `compareSuspensions([], …).matched` is TRUE by contract, so a
    // wiring that pushed an oracle unconditionally would report a GREEN
    // "discipline carry" for a pack that declares no ban at all.
    const raw = JSON.parse(await readFile(TINY_PACK_PATH, "utf8")) as {
      expected: { suspensions?: unknown[] };
    };
    if (raw.expected.suspensions === undefined || raw.expected.suspensions.length === 0) {
      throw new Error("test fixture assumption broken: the committed pack declares no expected.suspensions");
    }
    delete raw.expected.suspensions;

    const dir = await mkdtemp(join(tmpdir(), "b05-t5b3-nosuspensions-"));
    const mutatedPackPath = join(dir, "_tiny.json");
    await writeFile(mutatedPackPath, JSON.stringify(raw), "utf8");

    const { transport, sql } = fakeServer();
    const report = await runTinySuite({
      base: "http://bench.example",
      engine: "optimized",
      keep: false,
      log: silent,
      cliEntry: "admin",
      packPath: mutatedPackPath,
      transport,
      sql,
      probeTransport: transport,
      simTransport: transport,
      importTransport: transport,
      startTransport: transport,
      advanceTransport: transport,
      oracleTransport: transport,
      matchBoard: echoExpectedBoard,
      specialSubjects: echoSpecialSubjects,
    });

    const oracles = report.oracles ?? [];
    // B05 review round 1, MAJOR 2: this used to pin NO oracle row at all,
    // which made a skipped comparator indistinguishable from one that was
    // never written — for `report.oracles` and for the `oracle_checked`
    // stream alike. The zero-subject rule (report.ts, beside `OracleVerdict`)
    // says a PACK that declared nothing yields `no_subject`: counted, never
    // red, never readable as a pass.
    const carry = oracles.filter((o) => o.name.includes("discipline carry"));
    expect(carry).toHaveLength(1);
    expect(carry[0]!.verdict).toBe("no_subject");
    expect(carry[0]!.passed).toBe(true);
    expect(carry[0]!.detail).toContain("NO SUBJECT");
    expect(
      (report.warnings ?? []).some(
        (w) => w.includes("no expected.suspensions rows") && w.includes("NOT run"),
      ),
    ).toBe(true);
    // The enforcement probe rides inside the same block, so it must be gone
    // too — a probe still firing would mean the block ran and only declined
    // to report its oracle.
    expect((report.warnings ?? []).some((w) => w.includes("enforcement probe"))).toBe(false);
    // The SIBLINGS still ran: the mutation reached the suite and disabled
    // only this block, rather than the whole oracle step falling over (which
    // would satisfy the "no carry oracle" assertion above, vacuously).
    expect(oracles.filter((o) => o.name.includes("standings table"))).toHaveLength(3);
    expect(report.gate).toBe("green");
  });

  it("B05 T5b-2 — a pack with NO expected.careers reports a warning and NO career oracle, never a vacuous pass", async () => {
    // The third empty case, and the one that cannot be reached with a
    // transport knob: `compareCareerStats([], anything).matched` is TRUE by
    // its own contract, so a wiring that pushed an oracle unconditionally
    // would report a GREEN "career rollup" for a pack that declares no
    // career at all — a check that proves nothing, reported as a check that
    // passed. The block must decline to report instead.
    const raw = JSON.parse(await readFile(TINY_PACK_PATH, "utf8")) as {
      expected: { careers?: unknown[] };
    };
    // The key is DELETED, not emptied — `pack-schema.ts` defaults `careers`
    // to `[]`, so absence and emptiness are the same state downstream, and
    // absence is the one a pack actually ships in.
    if (raw.expected.careers === undefined) {
      throw new Error("test fixture assumption broken: the committed pack declares no expected.careers");
    }
    delete raw.expected.careers;

    const dir = await mkdtemp(join(tmpdir(), "b05-t5b2-nocareers-"));
    const mutatedPackPath = join(dir, "_tiny.json");
    await writeFile(mutatedPackPath, JSON.stringify(raw), "utf8");

    const { transport, sql } = fakeServer();
    const report = await runTinySuite({
      base: "http://bench.example",
      engine: "optimized",
      keep: false,
      log: silent,
      cliEntry: "admin",
      packPath: mutatedPackPath,
      transport,
      sql,
      probeTransport: transport,
      simTransport: transport,
      importTransport: transport,
      startTransport: transport,
      advanceTransport: transport,
      oracleTransport: transport,
      matchBoard: echoExpectedBoard,
      specialSubjects: echoSpecialSubjects,
    });

    const oracles = report.oracles ?? [];
    // B05 review round 1, MAJOR 2 — the zero-subject rule, same as the
    // suspensions case above: counted as `no_subject`, not omitted.
    const career = oracles.filter((o) => o.name.includes("career rollup"));
    expect(career).toHaveLength(1);
    expect(career[0]!.verdict).toBe("no_subject");
    expect(career[0]!.passed).toBe(true);
    expect(career[0]!.detail).toContain("NO SUBJECT");
    expect(
      (report.warnings ?? []).some((w) => w.includes("no expected.careers rows") && w.includes("NOT run")),
    ).toBe(true);
    // The SIBLING block still ran and still passed — this proves the pack
    // mutation reached the suite and disabled only the career block, rather
    // than the whole oracle step falling over (which would also satisfy the
    // "no career oracle" assertion above, vacuously).
    const cardOracles = oracles.filter((o) => o.name.includes("person cards"));
    expect(cardOracles).toHaveLength(4);
    expect(cardOracles.every((o) => o.passed)).toBe(true);
    expect(report.gate).toBe("green");
  });

  it("B05 review round 1, MAJOR 2 — a division declaring NO tiebreakers reports a no_subject cascade, not silence", async () => {
    // The third warn-with-no-oracle site, and the one the review did not name
    // by line: it is the same convention as the two above, so it moves with
    // them or the wave ships a fourth answer to the same question. A skipped
    // cascade is now COUNTED — in `report.oracles` and on the `oracle_checked`
    // stream — instead of existing only as a warning string.
    const raw = JSON.parse(await readFile(TINY_PACK_PATH, "utf8")) as {
      divisions: { ref: string; tiebreakers?: unknown }[];
    };
    const dTiny = raw.divisions.find((d) => d.ref === "d-tiny");
    if (dTiny?.tiebreakers === undefined) {
      throw new Error("test fixture assumption broken: d-tiny declares no tiebreakers");
    }
    delete dTiny.tiebreakers;

    const dir = await mkdtemp(join(tmpdir(), "b05-major2-notiebreakers-"));
    const mutatedPackPath = join(dir, "_tiny.json");
    await writeFile(mutatedPackPath, JSON.stringify(raw), "utf8");

    const events: { kind: unknown; passed: unknown; verdict: unknown }[] = [];
    const capturing = pino({ level: "info" }, {
      write(line: string) {
        const entry = JSON.parse(line) as Record<string, unknown>;
        if (entry.msg === "oracle_checked") {
          events.push({ kind: entry.kind, passed: entry.passed, verdict: entry.verdict });
        }
      },
    });

    const { transport, sql } = fakeServer();
    const report = await runTinySuite({
      base: "http://bench.example",
      engine: "optimized",
      keep: false,
      log: capturing,
      cliEntry: "admin",
      packPath: mutatedPackPath,
      transport,
      sql,
      probeTransport: transport,
      simTransport: transport,
      importTransport: transport,
      startTransport: transport,
      advanceTransport: transport,
      oracleTransport: transport,
      matchBoard: echoExpectedBoard,
      specialSubjects: echoSpecialSubjects,
    });

    const cascades = (report.oracles ?? []).filter((o) => o.name.endsWith("tie-order cascade"));
    // Still one per table — the mutation changes the VERDICT of d-tiny's,
    // never the population. A block that simply stopped running would also
    // satisfy a "no pass here" assertion, vacuously.
    expect(cascades).toHaveLength(3);
    const skipped = cascades.filter((o) => o.name.includes("d-tiny/"));
    expect(skipped).toHaveLength(1);
    expect(skipped[0]!.verdict).toBe("no_subject");
    expect(skipped[0]!.passed).toBe(true);
    expect(skipped[0]!.subject).toBe(false);
    expect(skipped[0]!.detail).toContain("NO SUBJECT");
    // Its POSITIVE PAIR from the same run: the untouched division still
    // compares a real tie and still passes.
    const tiebreak = cascades.find((o) => o.name.includes("d-tiebreak/"));
    expect(tiebreak?.verdict).toBe("pass");
    // The warning is kept — the oracle row is an addition, not a replacement.
    expect(
      (report.warnings ?? []).some((w) => w.includes("declares no tiebreakers")),
    ).toBe(true);
    // And the log stream counts it too, or a consumer still undercounts.
    expect(events.filter((e) => e.kind === "tie_order_cascade")).toEqual([
      { kind: "tie_order_cascade", passed: true, verdict: "no_subject" },
      { kind: "tie_order_cascade", passed: true, verdict: "no_subject" },
      { kind: "tie_order_cascade", passed: true, verdict: "pass" },
    ]);
    expect(report.gate).toBe("green");
  });

  it("B05 T4 — the runtime oracle is a REAL wire read, not an inert restatement: a reversed re-read standings order reds the run", async () => {
    // The captured `complete` response still reports [e-alpha, e-bravo] —
    // this fake's `advanceRoutes` world is untouched. Only the SEPARATE
    // `GET /stages/{id}/standings` re-read (`oracleRoutes`) disagrees. If
    // the oracle step were dead code (never wired, or silently comparing
    // the captured response against itself), this run would still be
    // green.
    const { transport, sql } = fakeServer({ wrongFinalStandingsOrder: true });
    const report = await runTinySuite({
      base: "http://bench.example",
      engine: "optimized",
      keep: false,
      log: silent,
      cliEntry: "admin",
      packPath: TINY_PACK_PATH,
      transport,
      sql,
      probeTransport: transport,
      simTransport: transport,
      importTransport: transport,
      startTransport: transport,
      advanceTransport: transport,
      oracleTransport: transport,
      matchBoard: echoExpectedBoard,
      specialSubjects: echoSpecialSubjects,
    });

    expect(report.gate).toBe("red");
    const runtimeOracles = (report.oracles ?? []).filter((o) => o.name.startsWith("oracle:"));
    const rankCrossing = runtimeOracles.find((o) => o.name === "oracle: d-tiny/s-playoff rank crossing (captured vs standings)");
    expect(rankCrossing?.passed).toBe(false);
    const standingsVsExpected = runtimeOracles.find(
      (o) => o.name === "oracle: d-tiny/s-playoff standings rank vs expected.finalRanks",
    );
    expect(standingsVsExpected?.passed).toBe(false);
    const champion = runtimeOracles.find((o) => o.name === "oracle: d-tiny champion");
    expect(champion?.passed).toBe(false);
    expect((report.errors ?? []).join(" | ")).toContain("DISAGREE on final order");
  });

  it("without `sql`, the fold never runs — no fixtures/events calls, no simulation section", async () => {
    const { transport, calls } = fakeServer();

    const report = await runTinySuite({
      base: "http://bench.example",
      engine: "optimized",
      keep: false,
      log: silent,
      cliEntry: "admin",
      packPath: TINY_PACK_PATH,
      transport,
    });

    expect(report.gate).toBe("green");
    expect(divisionAEventCalls(calls)).toHaveLength(0);
    expect(report.simulation).toBeUndefined();
  });

  it("a deliberate SEQ_CONFLICT reaches report.errors and reds the gate — never silently retried", async () => {
    // `rr-r2-c1` is the 5-event stream; conflict its THIRD event (index 2).
    const { transport, sql, calls } = fakeServer({ conflictAt: { extKey: "rr-r2-c1", expectedSeq: 2 } });

    const report = await runTinySuite({
      base: "http://bench.example",
      engine: "optimized",
      keep: false,
      log: silent,
      cliEntry: "admin",
      packPath: TINY_PACK_PATH,
      transport,
      sql,
      probeTransport: transport,
      simTransport: transport,
      // B05 T2 — the SAME fake now handles `/events/import` too (see this
      // file's own `raw()`), so division B's own streams fold cleanly
      // rather than falling back to a real `fetch()`. This file's own
      // assertions are about division A; the import path's own wiring is
      // `tiny-suite-import.test.ts`'s job.
      importTransport: transport,
      startTransport: transport,
      advanceTransport: transport,
      oracleTransport: transport,
      matchBoard: echoExpectedBoard,
      specialSubjects: echoSpecialSubjects,
    });

    expect(report.gate).toBe("red");
    expect((report.errors ?? []).some((e) => e.includes("SEQ_CONFLICT"))).toBe(true);
    expect(report.simulation?.findings).toHaveLength(1);
    expect(report.simulation?.findings?.[0]).toMatchObject({ code: "SEQ_CONFLICT", status: 409, eventIndex: 2 });

    // Never retried: the conflicted fixture's stream stops at expected_seq 2
    // — nothing sent it twice, and events 3/4 (the two AFTER the conflict in
    // that same 5-event stream) were never attempted at all.
    const conflictedFixturePath = divisionAEventCalls(calls).find(
      (c) => (c.body as { expected_seq: number }).expected_seq === 2,
    )?.path;
    const conflictedFixtureCalls = divisionAEventCalls(calls).filter((c) => c.path === conflictedFixturePath);
    const seqsOnConflictedFixture = conflictedFixtureCalls.map((c) => (c.body as { expected_seq: number }).expected_seq);
    expect(seqsOnConflictedFixture).toEqual([0, 1, 2]);
  });

  // B05 T3 (design doc D7) — the wiring-level regression: a wrong seed
  // proposal reds the run, and NOTHING downstream of the assertion is ever
  // attempted, at the `tiny.ts` wiring layer, not just inside
  // `advanceStageSeeding` itself (`advance.test.ts` proves the function; this
  // proves the SUITE actually stops on its answer rather than folding
  // `s-playoff`'s own stream regardless).
  it("D7 — a WRONG seed-proposal order reds the run, and the playoff's own fixture is NEVER scored", async () => {
    const { transport, sql, calls } = fakeServer({ reverseAdvanceQualifiers: true });

    const report = await runTinySuite({
      base: "http://bench.example",
      engine: "optimized",
      keep: false,
      log: silent,
      cliEntry: "admin",
      packPath: TINY_PACK_PATH,
      transport,
      sql,
      probeTransport: transport,
      simTransport: transport,
      importTransport: transport,
      startTransport: transport,
      advanceTransport: transport,
      oracleTransport: transport,
      matchBoard: echoExpectedBoard,
      specialSubjects: echoSpecialSubjects,
    });

    expect(report.gate).toBe("red");
    expect((report.errors ?? []).some((e) => e.includes("disagree with the pack's expected order"))).toBe(true);
    const advanceOracle = (report.oracles ?? []).find((o) => o.name.includes("seed proposal qualifiers"));
    expect(advanceOracle?.passed).toBe(false);
    // No finalRanks oracle at all — completing the target stage never ran.
    expect((report.oracles ?? []).some((o) => o.name.includes("finalRanks"))).toBe(false);
    // The absence of the downstream CALLS, not just the absence of an
    // oracle: confirm is never attempted at all, and `/complete` is called
    // EXACTLY once — the SOURCE stage's own completion this wiring always
    // makes BEFORE proposing (it is what satisfies SEEDING_SOURCE_INCOMPLETE)
    // — never a second time for the TARGET stage.
    expect(calls.some((c) => c.method === "POST" && /\/seed-proposal\/confirm$/.test(c.path))).toBe(false);
    expect(calls.filter((c) => c.method === "POST" && /\/complete$/.test(c.path))).toHaveLength(1);
    // 9 events total (T1's league fold only) — the playoff's own 2-event
    // stream was never sent.
    expect(divisionAEventCalls(calls)).toHaveLength(9);
  });
});

// ---------------------------------------------------------------------------
// B07a T6 — advancement runs for EVERY division, not only the first.
//
// Before this task the advance step was gated on `division0`/`stage0`/`stage1`,
// so a pack whose SECOND division also had a progression-fed stage imported
// that stage's fixtures and never seeded them from a proposal. No shipped pack
// has a second advancing division (`_tiny`'s other three are single-stage, and
// suite 11 is single-stage in both), so the loop has NO live subject and these
// fixtures are the only thing that drives it.
// ---------------------------------------------------------------------------

/** The parts of `_tiny.json` these fixtures reshape. Deliberately loose — the
 *  file is parsed, mutated and re-serialised, never type-checked against
 *  `Pack` (stage 0 is what judges it, which is the point). */
interface MutablePack {
  divisions: { ref: string; stages: Record<string, unknown>[] }[];
  streams: { divisionRef: string; fixtureExtKey: string; stageRef?: string }[];
  expected: {
    finalRanks: { divisionRef: string; stageRef: string; order: string[] }[];
    matches: { divisionRef: string; fixtureExtKey: string }[];
    tables: { divisionRef: string; stageRef: string; rows: { entrant: string; rank: number }[] }[];
  };
}

/** `_tiny.json`, mutated and written to its own temp directory. The filename
 *  must stay `_tiny.json`: `pack-schema.ts`'s own `suite_mismatch` check
 *  refuses a pack whose declared `suite` disagrees with the file it came from,
 *  so a different DIRECTORY is what keeps this isolated from the committed
 *  pack (the same shape the D6 fixture above uses). */
async function writeMutatedTinyPack(mutate: (raw: MutablePack) => void): Promise<string> {
  const raw = JSON.parse(await readFile(TINY_PACK_PATH, "utf8")) as MutablePack;
  mutate(raw);
  const dir = await mkdtemp(join(tmpdir(), "b07a-t6-"));
  const packPath = join(dir, "_tiny.json");
  await writeFile(packPath, JSON.stringify(raw), "utf8");
  return packPath;
}

/** `d-tiny/s-playoff`'s OWN progression, read out of the pack rather than
 *  re-typed here: a two-slot knockout seeded from the previous stage's
 *  standings in rank order. Derived from the source of truth so a change to
 *  the shipped shape moves this fixture with it instead of leaving it
 *  asserting yesterday's shape (AGENTS.md rule 19). */
function playoffProgressionOf(raw: MutablePack): Record<string, unknown> {
  const playoff = raw.divisions
    .find((d) => d.ref === "d-tiny")
    ?.stages.find((s) => s["ref"] === "s-playoff");
  const progression = playoff?.["progression"];
  if (progression === undefined) {
    throw new Error("test fixture assumption broken: d-tiny/s-playoff declares no progression");
  }
  return progression as Record<string, unknown>;
}

/** A stage's own `expected.tables` order, rank 1 first — read out of the pack
 *  rather than typed here, the same way `playoffProgressionOf` reads the
 *  progression. A finalRanks order typed into the test would keep asserting
 *  yesterday's answer the moment the table it mirrors moved. */
function rankOrderOf(raw: MutablePack, divisionRef: string, stageRef: string): string[] {
  const table = raw.expected.tables.find(
    (t) => t.divisionRef === divisionRef && t.stageRef === stageRef,
  );
  if (table === undefined || table.rows.length === 0) {
    throw new Error(`test fixture assumption broken: no expected.tables rows for ${divisionRef}/${stageRef}`);
  }
  return [...table.rows].sort((a, b) => a.rank - b.rank).map((r) => r.entrant);
}

/** `_tiny.json` with `d-badminton` given a progression-fed SECOND stage, so
 *  the pack carries TWO divisions that each owe an advancement. Its league
 *  table already ranks `e-cho` above `e-dahl`, which is also the order this
 *  file's fake proposes (entrants in creation order), so a correct run
 *  advances it cleanly. */
async function twoAdvancingDivisionsPack(): Promise<string> {
  return await writeMutatedTinyPack((raw) => {
    const badminton = raw.divisions.find((d) => d.ref === "d-badminton");
    if (badminton === undefined) {
      throw new Error("test fixture assumption broken: no d-badminton division");
    }
    if (badminton.stages.length !== 1) {
      throw new Error("test fixture assumption broken: d-badminton is no longer single-stage");
    }
    badminton.stages.push({
      ref: "s-badminton-ko",
      seq: 2,
      kind: "knockout",
      name: "Badminton Playoff",
      config: {},
      progression: playoffProgressionOf(raw),
    });
    // The knockout's own fixture owes a STREAM: the product stamps a generated
    // bracket game `scheduled` unless it carries an award (a bye —
    // `usecases/stages.ts:1351`), and `seedSuite` throws on any generated
    // fixture still at `scheduled` that no stream claims (`seed.ts:342`,
    // `SETTLED_AT_GENERATION`). A stream in turn owes an `expected.matches`
    // row — `PackSchema`'s anti-vacuity rule, "a replayed stream with no
    // oracle asserts nothing" (`pack-schema.ts:2105`).
    //
    // Both are COPIED from `d-badminton`'s own league fixture rather than
    // authored here: the rally sequence is a reconstructed 21-15/21-18 win for
    // `e-cho`, and re-deriving one by hand would be inventing a badminton
    // scoreline this test has no way to check.
    const leagueStream = raw.streams.find(
      (st) => st.divisionRef === "d-badminton" && st.fixtureExtKey === "rr-r1-c1",
    );
    const leagueMatch = raw.expected.matches.find(
      (m) => m.divisionRef === "d-badminton" && m.fixtureExtKey === "rr-r1-c1",
    );
    if (leagueStream === undefined || leagueMatch === undefined) {
      throw new Error("test fixture assumption broken: d-badminton has no rr-r1-c1 stream/expected match");
    }
    raw.streams.push({ ...leagueStream, fixtureExtKey: "se-r0-i0", stageRef: "s-badminton-ko" });
    raw.expected.matches.push({ ...leagueMatch, fixtureExtKey: "se-r0-i0" });
    raw.expected.finalRanks.push({
      divisionRef: "d-badminton",
      stageRef: "s-badminton-ko",
      // The knockout seats its two entrants in the league table's rank order,
      // so THAT table is the source of truth for this order, not a literal.
      order: rankOrderOf(raw, "d-badminton", "s-badminton-league"),
    });
  });
}

describe("runTinySuite — B07a T6 advancement runs for EVERY division", () => {
  it("proposes, confirms and generates for the SECOND division's progression-fed stage too", async () => {
    const packPath = await twoAdvancingDivisionsPack();
    const { transport, sql, calls } = fakeServer();
    const report = await runTinySuite({
      base: "http://bench.example",
      engine: "optimized",
      keep: false,
      log: silent,
      cliEntry: "admin",
      packPath,
      transport,
      sql,
      probeTransport: transport,
      simTransport: transport,
      importTransport: transport,
      startTransport: transport,
      advanceTransport: transport,
      oracleTransport: transport,
      matchBoard: echoExpectedBoard,
      specialSubjects: echoSpecialSubjects,
    });

    // TWO proposals, not one. This is the whole task: the pre-T6 gate read
    // `division0`'s second stage only, so `d-badminton`'s knockout was
    // generated at seed time and then never seeded from a proposal at all.
    const proposals = calls.filter((c) => c.method === "POST" && /\/seed-proposal$/.test(c.path));
    expect(proposals).toHaveLength(2);
    // Confirm and generate reached BOTH target stages — a proposal that was
    // asserted and then abandoned would leave the second stage unseeded while
    // still counting above.
    const confirms = calls.filter((c) => c.method === "POST" && /\/seed-proposal\/confirm$/.test(c.path));
    expect(confirms).toHaveLength(2);

    // The oracle NAMES carry the division ref. Stage refs are unique only
    // WITHIN a division (`pack-schema.ts`'s `checkRefsUnique` builds its
    // `seenStage` set inside the per-division loop), so two divisions may
    // legally declare the same stage ref — and a report whose reader cannot
    // tell which division failed is the thing this names away.
    const seedOracles = (report.oracles ?? []).filter((o) => o.name.includes("seed proposal qualifiers"));
    expect(seedOracles.map((o) => o.name)).toEqual([
      "advance: d-tiny/s-playoff seed proposal qualifiers",
      "advance: d-badminton/s-badminton-ko seed proposal qualifiers",
    ]);
    // …and both actually PASSED. A reachability assertion is satisfied by any
    // value (AGENTS.md rule 19): an oracle that compared an empty qualifier
    // list against an empty proposal would still be present and correctly
    // named here.
    expect(seedOracles.map((o) => o.passed)).toEqual([true, true]);

    // The captured `complete` response was compared for BOTH, which is what
    // proves the second division ran the whole propose -> confirm -> generate
    // -> play -> complete flow rather than stopping at the assertion.
    const finalRanksOracles = (report.oracles ?? []).filter(
      (o) => o.name.startsWith("advance:") && o.name.includes("finalRanks"),
    );
    expect(finalRanksOracles.map((o) => o.name)).toEqual([
      "advance: d-tiny/s-playoff finalRanks",
      "advance: d-badminton/s-badminton-ko finalRanks",
    ]);
    expect(finalRanksOracles.map((o) => o.passed)).toEqual([true, true]);

    // Ruling R1, the half a permissive fake cannot red on its own: the
    // batch-import fold carries the second division's FIRST stage only. Its
    // knockout fixture has no real entrants until the advance above seeds it,
    // so importing that stream up front would post into a fixture nobody had
    // seeded — which this fake would happily accept (its `/events/import`
    // branch is a pass-through) and a live run would refuse.
    //
    // The import call identifies ITSELF by the rally events it carries rather
    // than by a division id this test would have to guess.
    const imports = calls.filter((c) => c.method === "POST" && /\/events\/import$/.test(c.path));
    const badmintonImport = imports.find((c) =>
      (c.body as { streams: { events: { type: string }[] }[] }).streams.some((st) =>
        st.events.some((e) => e.type === "badminton.rally"),
      ),
    );
    expect(badmintonImport).toBeDefined();
    expect((badmintonImport?.body as { streams: unknown[] }).streams).toHaveLength(1);

    // …and the knockout stream WAS still played, strictly AFTER its own seed
    // proposal. Scoping the import without this would be indistinguishable
    // from silently dropping the stream.
    //
    // B07a T7 (ruling R23) moved WHICH ROUTE carries it. This used to assert
    // `badminton.rally` on `/fixtures/{id}/events`, because the advance step
    // was hard-wired to the single-event route for every division whatever
    // that division's mode — the half-connected seam R23 exists to close. A
    // division's play mode is a property of the DIVISION, so `d-badminton`
    // (index 1, undeclared, therefore "import") now folds its knockout the
    // same way it folded its league. The GUARANTEE under test is unchanged and
    // the routing half is newly pinned below, so this is re-expressed rather
    // than relaxed.
    const proposalIdxs = calls
      .map((c, i) => ({ c, i }))
      .filter(({ c }) => c.method === "POST" && /\/seed-proposal$/.test(c.path))
      .map(({ i }) => i);
    expect(proposalIdxs).toHaveLength(2);
    const badmintonImportIdxs = calls
      .map((c, i) => ({ c, i }))
      .filter(
        ({ c }) =>
          c.method === "POST" &&
          /\/events\/import$/.test(c.path) &&
          String((c.body as { import_id: string }).import_id).endsWith(":d-badminton"),
      )
      .map(({ i }) => i);
    // TWO: its league in the first-stage fold, then its knockout once the
    // advance has seeded it. One would mean the knockout stream was dropped.
    expect(badmintonImportIdxs).toHaveLength(2);
    // `proposalIdxs[1]` is `d-badminton`'s own proposal — divisions advance in
    // pack order, which the oracle names above have already pinned.
    expect(badmintonImportIdxs[1]!).toBeGreaterThan(proposalIdxs[1]!);
    // …and NOTHING of this division went out on the single-event route. That
    // negative is what makes the pair above a ROUTING assertion rather than
    // only an ordering one — without it, a run that played the knockout on
    // both routes would pass.
    expect(
      calls.some(
        (c) =>
          c.method === "POST" &&
          /^\/api\/v1\/fixtures\/[^/]+\/events$/.test(c.path) &&
          (c.body as { type?: string }).type === "badminton.rally",
      ),
    ).toBe(false);
  });

  it("advances STAGE-MAJOR: every division's FIRST boundary before any division's SECOND", async () => {
    // The ordering-differential this task turns on (ruling R1), and the test I
    // wrongly reported as unbuildable. Three things are individually true — the
    // advance step needs an `expected.tables` row for each SOURCE stage, a table
    // on a bracket stage is a hard error (`validate-pack.ts:1693`), and a
    // TABLE-kind middle stage's generated ext keys would collide — and the
    // conclusion drawn from them was still wrong: a stage-less-and-stream-less
    // extra stage is only a WARNING (`validate-pack.ts:1875-1902`), so a third
    // stage carrying nothing but a `progression` loads fine and its advance
    // pushes an ORDERED error while making zero HTTP calls.
    //
    // Two divisions, asymmetric depth, each boundary failing in a way that names
    // itself:
    //   d-badminton  league -> ko        (boundary 1) — advances, then errors,
    //                                     because it declares no finalRanks row
    //   d-tiny       league -> playoff -> final (boundary 2) — errors before any
    //                                     call, because a knockout SOURCE has no
    //                                     expected.tables row
    // STAGE-major visits every division's boundary 1 first, so s-badminton-ko
    // errors BEFORE s-final. DIVISION-major would finish d-tiny — both its
    // boundaries — before starting d-badminton, inverting the pair.
    const packPath = await writeMutatedTinyPack((raw) => {
      const badminton = raw.divisions.find((d) => d.ref === "d-badminton");
      const tiny = raw.divisions.find((d) => d.ref === "d-tiny");
      if (badminton === undefined || tiny === undefined) {
        throw new Error("test fixture assumption broken: d-badminton / d-tiny not both present");
      }
      if (tiny.stages.length !== 2) {
        throw new Error("test fixture assumption broken: d-tiny is no longer exactly two stages");
      }
      const progression = playoffProgressionOf(raw);

      // d-badminton's own first boundary. It owes a stream (a generated bracket
      // fixture nobody claims throws at `seed.ts:342`) and a stream owes an
      // expected match — but deliberately NO `expected.finalRanks` row, which is
      // what makes it report itself after completing.
      badminton.stages.push({
        ref: "s-badminton-ko",
        seq: 2,
        kind: "knockout",
        name: "Badminton Playoff",
        config: {},
        progression,
      });
      const leagueStream = raw.streams.find(
        (st) => st.divisionRef === "d-badminton" && st.fixtureExtKey === "rr-r1-c1",
      );
      const leagueMatch = raw.expected.matches.find(
        (m) => m.divisionRef === "d-badminton" && m.fixtureExtKey === "rr-r1-c1",
      );
      if (leagueStream === undefined || leagueMatch === undefined) {
        throw new Error("test fixture assumption broken: d-badminton has no rr-r1-c1 stream/expected match");
      }
      raw.streams.push({ ...leagueStream, fixtureExtKey: "se-r0-i0", stageRef: "s-badminton-ko" });
      raw.expected.matches.push({ ...leagueMatch, fixtureExtKey: "se-r0-i0" });

      // d-tiny's SECOND boundary — stream-less on purpose. Its generated
      // `se-r0-i0` shares a division+ext_key with `s-playoff`'s, which the
      // playoff stream already claims, so `seedSuite`'s unclaimed-fixture guard
      // stays satisfied without inventing a second scoreline.
      tiny.stages.push({ ref: "s-final", seq: 3, kind: "knockout", name: "Final", config: {}, progression });
    });

    const { transport, sql } = fakeServer();
    const report = await runTinySuite({
      base: "http://bench.example",
      engine: "optimized",
      keep: false,
      log: silent,
      cliEntry: "admin",
      packPath,
      transport,
      sql,
      probeTransport: transport,
      simTransport: transport,
      importTransport: transport,
      startTransport: transport,
      advanceTransport: transport,
      oracleTransport: transport,
      matchBoard: echoExpectedBoard,
      specialSubjects: echoSpecialSubjects,
    });

    // ORDER is the whole assertion. Both entries are present under either loop
    // shape — only their sequence differs — so a membership check would pass on
    // the very thing this test exists to refuse.
    const advanceErrors = (report.errors ?? []).filter(
      (e) => e.includes("s-badminton-ko") || e.includes("s-final"),
    );
    expect(advanceErrors).toHaveLength(2);
    expect(advanceErrors[0]).toContain("s-badminton-ko");
    expect(advanceErrors[1]).toContain("s-final");
  });
});

// ---------------------------------------------------------------------------
// B07a T7 — the runner DISPATCHES on the declared play mode.
//
// Before this task the write path was positional and implicit: `division0`
// folded through the single-event scoring route and every other division
// through the batch-import route, each in its own hard-coded block. The
// declaration has to be able to INVERT that, or it is a field nobody reads —
// so every test below is a differential against the positional answer rather
// than a check that some call happened.
//
// These drive `runPackSuite` directly, so a `play` map can be handed
// straight to the runner's own options without needing a real registry row.
// (Fix round 1 gave `runTinySuite`/`runSuite11` their own `play` parameter,
// forwarded into these SAME options — see the "fix round 1" describe block
// below for the tests that drive THAT path instead.)
// ---------------------------------------------------------------------------

/** Every `POST /divisions/{id}/events/import` call. */
function importCalls(calls: RecordedCall[]): RecordedCall[] {
  return calls.filter(
    (c) => c.method === "POST" && /^\/api\/v1\/divisions\/[^/]+\/events\/import$/.test(c.path),
  );
}

/** The DIVISION each import call belongs to, read OFF THE WIRE rather than
 *  resolved back out of a division id this test never sees: `buildImportId`
 *  mints `bench-import:{runId ?? "local"}:{divisionRef}` (`import.ts:292`) and
 *  `buildImportRequestBody` carries it as `import_id`. */
function importedDivisionRefs(calls: RecordedCall[]): string[] {
  return importCalls(calls).map((c) =>
    String((c.body as { import_id: string }).import_id).replace(/^bench-import:[^:]*:/, ""),
  );
}

function eventsInImport(call: RecordedCall): number {
  return (call.body as { streams: { events: unknown[] }[] }).streams.reduce(
    (n, st) => n + st.events.length,
    0,
  );
}

/** Single-event POSTs that belong to a PACK stream, scoped away from the
 *  DLS-gate probe's unconditional `cricket.*` cells exactly as
 *  `divisionAEventCalls` does — but not scoped to division A, because which
 *  division lands on this route is the very thing these tests vary. */
function packEventPostCalls(calls: RecordedCall[]): RecordedCall[] {
  return eventPostCalls(calls).filter((c) => !(c.body as { type: string }).type.startsWith("cricket."));
}

/** `_tiny.json`'s own event totals, keyed `divisionRef` and
 *  `divisionRef/stageRef`. READ OUT OF THE PACK, never typed here: a literal
 *  freezes yesterday's pack, and this file has already had two count
 *  assertions go stale that way (see the B05 T5b note above). */
async function tinyEventTotals(): Promise<{
  byDivision: Map<string, number>;
  byStage: Map<string, number>;
}> {
  const raw = JSON.parse(await readFile(TINY_PACK_PATH, "utf8")) as {
    streams: { divisionRef: string; stageRef?: string; events: unknown[] }[];
  };
  const byDivision = new Map<string, number>();
  const byStage = new Map<string, number>();
  for (const st of raw.streams) {
    byDivision.set(st.divisionRef, (byDivision.get(st.divisionRef) ?? 0) + st.events.length);
    const stageKey = `${st.divisionRef}/${st.stageRef ?? "-"}`;
    byStage.set(stageKey, (byStage.get(stageKey) ?? 0) + st.events.length);
  }
  return { byDivision, byStage };
}

function playInput(
  transport: ReturnType<typeof fakeServer>["transport"],
  sql: ReturnType<typeof fakeServer>["sql"],
) {
  return {
    base: "http://bench.example",
    engine: "optimized" as const,
    keep: false,
    log: silent,
    cliEntry: "admin" as const,
    packPath: TINY_PACK_PATH,
    transport,
    sql,
    probeTransport: transport,
    simTransport: transport,
    importTransport: transport,
    startTransport: transport,
    advanceTransport: transport,
    oracleTransport: transport,
    matchBoard: echoExpectedBoard,
    specialSubjects: echoSpecialSubjects,
  };
}

describe("runPackSuite — B07a T7 play-mode dispatch", () => {
  it("keeps the positional split when the suite declares nothing", async () => {
    // The REGRESSION that matters most. `_RULES.md` §3 keeps one suite on the
    // single-POST path and the import path needs a live subject of its own, so
    // a dispatch that quietly moved `_tiny`'s divisions would delete coverage
    // while appearing to add some. Asserted as an exact per-division split,
    // both sides, so a mode that moved ONE division is caught.
    const { transport, sql, calls } = fakeServer();
    const { byDivision } = await tinyEventTotals();

    await runPackSuite(playInput(transport, sql), {
      suiteKey: "_tiny",
      packPath: TINY_PACK_PATH,
    });

    expect([...importedDivisionRefs(calls)].sort()).toEqual(["d-badminton", "d-tiebreak"]);
    // …and division A's whole stream — BOTH its stages — still went through
    // the single-event route. Derived from the pack, never a literal.
    expect(packEventPostCalls(calls)).toHaveLength(byDivision.get("d-tiny") ?? 0);
  });

  it("routes each division by its DECLARED mode, inverting the positional default", async () => {
    // The differential. `d-tiny` is index 0 (positionally "api") and
    // `d-badminton` index 1 (positionally "import"); this declaration swaps
    // both. A runner that ignored the declaration would produce EXACTLY the
    // assertions of the test above, so neither half can pass by accident.
    const { transport, sql, calls } = fakeServer();
    const { byDivision } = await tinyEventTotals();

    await runPackSuite(playInput(transport, sql), {
      suiteKey: "_tiny",
      packPath: TINY_PACK_PATH,
      play: { "d-tiny": "import" as PlayMode, "d-badminton": "api" as PlayMode },
    });

    // `d-badminton` is no longer imported at all; `d-tiny` now is. Compared as
    // a SET, because `d-tiny` imports TWICE — once for its league and once for
    // the playoff the advance step folds by the same declared mode (ruling
    // R23, which has its own test below). What this assertion is about is
    // WHICH divisions take the import route, not how many calls each takes.
    expect([...new Set(importedDivisionRefs(calls))].sort()).toEqual(["d-tiebreak", "d-tiny"]);
    expect(importedDivisionRefs(calls)).not.toContain("d-badminton");
    // …and the single-event route now carries `d-badminton`'s whole stream
    // and nothing else — the exact count, so a route carrying BOTH divisions
    // (a dispatch that added a path without removing one) fails here.
    expect(packEventPostCalls(calls)).toHaveLength(byDivision.get("d-badminton") ?? 0);
    expect(
      packEventPostCalls(calls).some((c) => (c.body as { type: string }).type === "badminton.rally"),
    ).toBe(true);
  });

  it("plays a division's LATER stage by the same declared mode (R23)", async () => {
    // `d-tiny` is the only shipped division with two stages: `s-league` folds
    // in the first-stage pass and `s-playoff` is played by the advance step
    // once its seats are confirmed. Before this task that second fold was
    // hard-wired to the single-event route for EVERY division, whatever its
    // mode — the seam Task 6 left open and named R23.
    const { transport, sql, calls } = fakeServer();
    const { byStage } = await tinyEventTotals();

    await runPackSuite(playInput(transport, sql), {
      suiteKey: "_tiny",
      packPath: TINY_PACK_PATH,
      play: { "d-tiny": "import" as PlayMode },
    });

    const tinyImports = importCalls(calls).filter(
      (c) => String((c.body as { import_id: string }).import_id).endsWith(":d-tiny"),
    );
    // TWO imports for the one division: its first stage, then its advanced
    // stage. One import plus two stray single-event POSTs is exactly the
    // pre-R23 shape.
    expect(tinyImports).toHaveLength(2);
    expect(tinyImports.map(eventsInImport)).toEqual([
      byStage.get("d-tiny/s-league") ?? 0,
      byStage.get("d-tiny/s-playoff") ?? 0,
    ]);
    // …and the playoff's fold happened AFTER its seats were confirmed. An
    // import issued before the seed proposal would post into a bracket fixture
    // that has no real entrants yet.
    const proposalIdx = calls.findIndex(
      (c) => c.method === "POST" && /\/seed-proposal$/.test(c.path),
    );
    const secondTinyImportIdx = calls.indexOf(tinyImports[1]!);
    expect(proposalIdx).toBeGreaterThan(-1);
    expect(secondTinyImportIdx).toBeGreaterThan(proposalIdx);
  });

  it("reaches the tap branch LOUDLY (no device links: a named warning), proving the dispatch is reached and not merely declared", async () => {
    // The proof device. The failure this repo ships most often is a seam that
    // is declared, typed and unit-green while nothing ever drives it. Since
    // B07a T10 a tap division is PLAYED; on this device-link-less catalog the
    // tap branch's own named warning can only come from that branch running.
    const { transport, sql, calls } = fakeServer();

    const report = await runPackSuite(playInput(transport, sql), {
      suiteKey: "_tiny",
      packPath: TINY_PACK_PATH,
      play: { "d-tiny": "tap" as PlayMode },
    });

    // B07a T10 — the dispatch now PLAYS a tap division, and this fake's catalog
    // sells no `scoring.device_links` (deviceLinksGranted false). The tap
    // branch's own loud warning (R55) can only come from that branch running,
    // and no tapPlay is published for fixtures nobody played.
    expect((report.warnings ?? []).join("\n")).toContain('division "d-tiny" declares play "tap"');
    expect((report.warnings ?? []).join("\n")).toContain("tap fixtures NOT played");
    expect(report.tapPlay).toBeUndefined();
    // The other half, and the half that makes this a REACHED assertion rather
    // than a thrown-from-somewhere one: nothing was written for that division
    // by either write path. A silent fall-back to `api` or `import` would be
    // indistinguishable from the dispatch never having run.
    expect(importedDivisionRefs(calls)).not.toContain("d-tiny");
    expect(packEventPostCalls(calls)).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// B07a T7 fix round 1 — I1 (the registry row's `play` had zero readers) and
// I2 (an unplanned `play` key silently falls back instead of refusing).
//
// I1's dispatch test above (`runPackSuite — B07a T7 play-mode dispatch`)
// proves `run-suite.ts`'s OWN dispatch refuses a declared `tap`. It does NOT
// prove the declaration ever gets there from the registry row — `runPackSuite`
// was called directly, with a hand-built `opts.play`, bypassing every hop a
// live run actually takes. These tests drive the two hops a live run takes
// instead: `bench.ts`'s own forwarding seam (`invokeSuiteDefinition`), and
// `runTinySuite`'s own forwarding of its new `play` parameter.
// ---------------------------------------------------------------------------
describe("a registry row's `play` reaches the dispatch (B07a T7 fix round 1, I1)", () => {
  it("runTinySuite forwards its `play` parameter into runPackSuite's dispatch", async () => {
    // Drives the REAL `runTinySuite` (not `runPackSuite` directly) with a
    // declared `play`, exactly as `bench.ts`'s forwarding seam would call it
    // once handed a row's `definition.play`. Deleting `runTinySuite`'s own
    // `...(play === undefined ? {} : { play })` spread reds this test and
    // nothing else in this hop.
    const { transport, sql, calls } = fakeServer();

    const report = await runTinySuite(playInput(transport, sql), {
      "d-tiny": "tap" as PlayMode,
    });

    // B07a T10 — the dispatch now PLAYS a tap division, and this fake's catalog
    // sells no `scoring.device_links` (deviceLinksGranted false). The tap
    // branch's own loud warning (R55) can only come from that branch running,
    // and no tapPlay is published for fixtures nobody played.
    expect((report.warnings ?? []).join("\n")).toContain('division "d-tiny" declares play "tap"');
    expect((report.warnings ?? []).join("\n")).toContain("tap fixtures NOT played");
    expect(report.tapPlay).toBeUndefined();
    expect(importedDivisionRefs(calls)).not.toContain("d-tiny");
    expect(packEventPostCalls(calls)).toHaveLength(0);
  });

  it("bench.ts's own forwarding seam passes a registry row's `play` into its `.run()`", async () => {
    // `SUITE_REGISTRY` is never mutated here (the ruling forbids it, and
    // every real row leaves `play` undeclared until Task 10 touches `_tiny`
    // alone) — this drives `invokeSuiteDefinition`, the exact line
    // `runSuite("_tiny", ...)` calls in production, with a hand-built
    // `SuiteDefinition` that both declares `play` AND wires its own `run` to
    // the real `runPackSuite`, so the assertion below can only pass if
    // `definition.play` actually crossed this one line.
    const { transport, sql, calls } = fakeServer();

    const definition: SuiteDefinition = {
      key: "_tiny",
      title: "fake row for the forwarding-seam test",
      packPath: TINY_PACK_PATH,
      play: { "d-tiny": "tap" as PlayMode },
      run: (input, play) =>
        runPackSuite(input, {
          suiteKey: "_tiny",
          packPath: TINY_PACK_PATH,
          ...(play === undefined ? {} : { play }),
        }),
    };

    const report = await invokeSuiteDefinition(definition, playInput(transport, sql));

    // B07a T10 — the dispatch now PLAYS a tap division, and this fake's catalog
    // sells no `scoring.device_links` (deviceLinksGranted false). The tap
    // branch's own loud warning (R55) can only come from that branch running,
    // and no tapPlay is published for fixtures nobody played.
    expect((report.warnings ?? []).join("\n")).toContain('division "d-tiny" declares play "tap"');
    expect((report.warnings ?? []).join("\n")).toContain("tap fixtures NOT played");
    expect(report.tapPlay).toBeUndefined();
    expect(importedDivisionRefs(calls)).not.toContain("d-tiny");
    expect(packEventPostCalls(calls)).toHaveLength(0);
  });
});

describe("an unplanned `play` key reds the gate instead of silently falling back (B07a T7 fix round 1, I2)", () => {
  it("names the misspelled key and lists the planned divisions, gate red", async () => {
    // Same shape as CHECK 2's probe in the review: a typo'd division ref in
    // `play` used to produce NO refusal, NO warning, `d-tiny` single-POSTed
    // positionally, and `report.gate === "green"`. This pins the fixed
    // behaviour: an error naming the bad key, and a red gate.
    const { transport, sql, calls } = fakeServer();
    const { byDivision } = await tinyEventTotals();

    const report = await runPackSuite(playInput(transport, sql), {
      suiteKey: "_tiny",
      packPath: TINY_PACK_PATH,
      play: { "d-tinyy": "tap" as PlayMode },
    });

    expect(report.gate).toBe("red");
    const errorText = (report.errors ?? []).join("\n");
    expect(errorText).toContain('play declares division "d-tinyy"');
    // "lists the planned refs" — EXACT match on the message's own list, not
    // a bare `toContain` per ref: "d-tiny" is itself a substring of this
    // test's own bad key "d-tinyy" (from the assertion just above), so a
    // plain `errorText.toContain("d-tiny")` would pass even if the
    // "planned divisions:" list dropped "d-tiny" entirely — it could never
    // fail. Split the message's own list and compare it exactly instead.
    const plannedRefsText = errorText.split("planned divisions: ")[1];
    expect(plannedRefsText).toBeDefined();
    expect((plannedRefsText ?? "").split(", ")).toEqual([
      "d-tiny",
      "d-badminton",
      "d-registration",
      "d-tiebreak",
    ]);
    // The typo never touched `d-tiny`'s OWN play — it still single-POSTs
    // positionally, proving the guard doesn't fail the run's data, only its
    // gate.
    expect(packEventPostCalls(calls)).toHaveLength(byDivision.get("d-tiny") ?? 0);
  });

  // The positive pair for the test above. Without it, a guard that compares
  // every key against the WRONG set (e.g. an always-empty one, rather than
  // `plannedDivisionRefs`) would flag a correctly-named key too — reddening
  // every run that declares `play` at all — and nothing above would catch
  // it, since the misspelled-key test only proves an unplanned key gets
  // flagged, never that a PLANNED one does not.
  //
  // TWO keys, one at index 0 (`d-tiny`) and one NOT (`d-badminton`, index
  // 1) — re-review round 1 finding, M7: a positive pair that only ever
  // declares the FIRST planned division cannot tell a correct guard from
  // one that (wrongly) accepts only `plan.divisions[0]`, because "first
  // division" and "planned division" give the same answer at index 0. Both
  // keys here are declared at their OWN positional default (`api` for index
  // 0, `import` for index 1), so the write path is unchanged either way —
  // this test is about the GUARD, not the dispatch.
  it("a correctly-named play key never trips the unplanned-division guard, at index 0 or later", async () => {
    const { transport, sql } = fakeServer();

    const report = await runPackSuite(playInput(transport, sql), {
      suiteKey: "_tiny",
      packPath: TINY_PACK_PATH,
      play: { "d-tiny": "api" as PlayMode, "d-badminton": "import" as PlayMode },
    });

    expect((report.errors ?? []).join("\n")).not.toContain("play declares division");
  });
});

// ---------------------------------------------------------------------------
// B07a T7 fix round 2 — I1(b)/(c): round 1's own seam test proved
// `invokeSuiteDefinition` forwards `definition.play`, but drove it with a
// `SuiteDefinition` the TEST built — never `bench.ts`'s own exported
// `runSuite`, and never the REAL registry row's `run` binding. Reverting
// `bench.ts`'s call to the seam (M1), or replacing either registry row's
// `run` with a wrapper that drops the second argument (M2/M3), stayed green.
// This block drives the REAL `runSuite` against the REAL row (mocked ABOVE
// to carry an injected `play`, but with the row's own `run` untouched), so
// all three links — `runSuite` -> the seam -> the row's real binding -> the
// dispatch — are exercised in one call.
//
// Fix round 3 (R34): `probeTransport` is no longer auto-threaded into
// `simTransport`/`importTransport`/`startTransport`/`advanceTransport`/
// `oracleTransport` by PRODUCTION `bench.ts` code (that was round 2's own
// deviation, reverted — see `bench.ts`'s `runSuite`). This test now supplies
// all five itself, via `injectedTransports`, spread into the row's `run`
// call by the mock above — a test-side seam, not a production one. It also
// points `--report-dir` at a fresh `mkdtemp` directory, removed in
// `afterEach`, so no `bench-report/<run-id>/` artifact is ever written into
// the worktree (round 2's own `fix-round-2-i1bc` directory, R34(b)).
// ---------------------------------------------------------------------------
describe("bench.ts's REAL runSuite drives the REAL `_tiny` registry row (B07a T7 fix round 2, I1(b)/(c))", () => {
  let reportDir: string | undefined;

  afterEach(async () => {
    if (reportDir !== undefined) {
      await rm(reportDir, { recursive: true, force: true });
      reportDir = undefined;
    }
  });

  it("a play declaration injected onto the real row reaches the real dispatch: tap-branch warning, zero writes", async () => {
    const { transport, sql, calls } = fakeServer();

    // Opt-in (R34(c)): unset, `lookupSuite("_tiny")` returns the row
    // completely unmodified — every OTHER test in this file, which calls
    // `runTinySuite`/`runPackSuite` directly and never touches
    // `lookupSuite`, is unaffected either way, but this keeps the mock
    // honest for any FUTURE test here that calls `runSuite("_tiny", ...)`
    // expecting a normal run.
    injectedPlay = { "d-tiny": "tap" as PlayMode };
    // `transport` doubles for all six: the SAME fake `fakeServer()` returns
    // already answers every route the DLS-gate probe, division-start, and
    // every other granular test-only transport seam need — one
    // comprehensive fake, not five different ones. Threaded here, by the
    // TEST, into the row's `run` call — never by `bench.ts`.
    injectedTransports = {
      probeTransport: transport,
      simTransport: transport,
      importTransport: transport,
      startTransport: transport,
      advanceTransport: transport,
      oracleTransport: transport,
    };
    reportDir = await mkdtemp(join(tmpdir(), "bench-report-fix-round-3-"));

    // No `--suite` needed: `runSuite`'s `key` argument is independent of
    // `config.suites` (that list only gates the CLI's own `--suite` flag
    // validation).
    const config = parseCliArgs([
      "--base",
      "http://bench.example",
      "--wipe",
      "--report-dir",
      reportDir,
    ]);
    const report = await runSuite("_tiny", config, "fix-round-3-i1bc", sql, transport);

    // B07a T10 — the dispatch now PLAYS a tap division, and this fake's catalog
    // sells no `scoring.device_links` (deviceLinksGranted false). The tap
    // branch's own loud warning (R55) can only come from that branch running,
    // and no tapPlay is published for fixtures nobody played.
    expect((report.warnings ?? []).join("\n")).toContain('division "d-tiny" declares play "tap"');
    expect((report.warnings ?? []).join("\n")).toContain("tap fixtures NOT played");
    expect(report.tapPlay).toBeUndefined();
    // The negative half: nothing was written for `d-tiny` on either write
    // path. A silent fall-back (M1/M2/M3, each of which drops the `play`
    // forward somewhere on this path) would single-POST `d-tiny` instead —
    // it is index 0, so its positional default is `"api"`.
    expect(importedDivisionRefs(calls)).not.toContain("d-tiny");
    expect(packEventPostCalls(calls)).toHaveLength(0);
  });
});
