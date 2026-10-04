// B03 T7 — proves `runTinySuite` actually DRIVES the DLS-gate probe and the
// derived `autoAssign` flag, end to end, against the REAL committed
// `_tiny.json` pack. Everything else (`--keep`/pack-refusal/fixture-count
// coverage) already lives in `tiny-suite.test.ts`; this file exists so that
// removing the wiring this task adds — the `if (input.sql !== undefined)`
// block in `lib/suites/tiny.ts`, or the `autoAssign` passthrough it feeds
// into `seedSuite` — reds a test, per the task's own acceptance criteria
// ("the probe is driven by the suite, not merely defined").
//
// A fresh, self-contained fake server rather than extending
// `tiny-suite.test.ts`'s own `makeFakeServer()`: that helper is shared by 22
// existing tests and this task's brief is explicit about minimizing blast
// radius outside what T7 actually owns. This fake is fully GENERIC (legs
// tracked per stage at creation time, `ext_key`s derived as `rr-r{n}-c1` for
// n=1..legs) rather than special-cased per division name — which happens to
// match `_tiny.json`'s own two league stages' declared ext_keys exactly
// (`legs: 3` → rr-r1-c1/rr-r2-c1/rr-r3-c1, `legs: 1` → rr-r1-c1) AND serves
// the DLS-gate probe's own throwaway cricket divisions with no special
// casing at all.
import { describe, expect, it } from "vitest";
import pino from "pino";
import type { RawResult, Session } from "../http.ts";
import type { ProbeTransport } from "../dls-gate.ts";
import type { PlanEntitlementRow, PlanSql } from "../plan.ts";
import { runTinySuite, TINY_PACK_PATH } from "../suites/tiny.ts";
// B04 — the seven scheduling endpoints, shared with the other fakes in this
// directory. This file keeps its own generic seeding fake (see the header)
// and delegates only the scheduling half, so the two cannot disagree about
// which court a fixture landed on or whether a lock survived.
import {
  makeScheduleWorld,
  type FakeScheduleOptions,
  type FakeScheduleWorld,
} from "./_schedule-routes.ts";
import { makeDivisionPhaseWorld } from "./_division-phase.ts";
import { makeAdvanceRoutesWorld } from "./_advance-routes.ts";
import type { DivisionCardSource } from "./_oracle-routes.ts";
import { makeClaimRoutesWorld } from "./_claim-routes.ts";
import { makeNewsRoutesWorld, type NewsRoutesOptions } from "./_news-routes.ts";
import { makeDisciplineRoutesWorld } from "./_discipline-routes.ts";
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

const silent = pino({ level: "silent" });

interface RecordedCall {
  readonly method: string;
  readonly path: string;
  readonly body: unknown;
}

function slug(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "");
}

/** One combined fake implementing signIn/request/raw — a `ProbeTransport`
 *  wherever the DLS-gate probe needs one, a `SeedTransport` (its own subset)
 *  wherever `seedSuite`/`runTinySuite` need one. `officialsAutoGranted`
 *  controls what the fake POST /entitlement-override "provisions" — the SQL
 *  seam below reports back the SAME thing, so a caller can drive both
 *  directions of the wiring from one factory. */
function fakeServer(opts: {
  /** B06a T7 — knobs for the shared news rail (`_news-routes.ts`). */
  newsRoutes?: NewsRoutesOptions;
  officialsAutoGranted: boolean;
  /**
   * B07a T11 — put `scoring.device_links` on the catalog as the live DB has it
   * (community false, pro true: V117__device_links.sql:55-56). Off by default,
   * which leaves the key with no rows at all: nothing to refuse for, so the
   * probe's two device-link cells retire and the run has to SAY so.
   */
  deviceLinksSold?: boolean;
  /** B07a T11 fix round 1 — the status the device-link revoke answers (200 by
   *  default): anything else stands in for a revoke that went wrong. */
  deviceLinkRevokeStatus?: number;

  /** B04 — knobs for the shared scheduling world (`_schedule-routes.ts`). */
  schedule?: FakeScheduleOptions;
  /**
   * B04 F-T6-2 — make `/officials/auto` propose the SAME official on the first
   * TWO placed fixtures of the requested division, resolved from the board
   * rather than from a hardcoded id.
   *
   * Resolved from the board on purpose: this file's fixture ids are minted
   * from a global counter that the DLS-gate probe's own throwaway divisions
   * consume first, so a literal id here would name whatever happened to be
   * created third. And the pair has to be REAL and OVERLAPPING for the
   * post-officials re-check to have anything to find — an official on two
   * fixtures that never overlap is not a double-booking.
   */
  autoAssignSameOfficialTwice?: boolean;
}): {
  transport: ProbeTransport;
  sql: PlanSql;
  calls: RecordedCall[];
  schedule: FakeScheduleWorld;
} {
  const calls: RecordedCall[] = [];
  const schedule = makeScheduleWorld({ solverEngine: "optimized", ...(opts.schedule ?? {}) });
  const orgBySession = new WeakMap<Session, string>();
  const legsByStageId = new Map<string, number>();
  // B05 T3 — d-tiny now declares a second, non-league stage (s-playoff, a
  // knockout fed from the league). `/generate` needs to know which shape to
  // mint: this fake's own round-robin arithmetic assumes every stage is a
  // league, which was true of every pack this file drove before this task.
  const kindByStageId = new Map<string, string>();
  const divisionIdByStageId = new Map<string, string>();
  // B05 T4b — see `_oracle-routes.ts`'s own header comment: these key the
  // real (non-placement) league-table/leaderboard fixtures on the `/stages`
  // and `/divisions` POST bodies' own `name` field.
  const stageNameById = new Map<string, string>();
  const divisionNameById = new Map<string, string>();
  // B05 T5b — the `sport_key` the SAME `POST /competitions/{id}/divisions`
  // body already carries (`seed.ts:614`). Read off the wire rather than
  // guessed, because `personCareerStats` files a person's divisions UNDER
  // their sport and `compareCareerStats` reds on a metric key found in more
  // than one sport — a fake that flattened every division into one sport
  // could never witness that guard.
  const divisionSportById = new Map<string, string>();
  const fixtureDivisionId = new Map<string, string>();
  const fixtureOfficials = new Map<string, unknown[]>();
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
  const sqlCalls: string[] = [];
  // B05 T2.5 (D9) — see `_division-phase.ts`'s own header comment: EVERY
  // `sql`-passing fake now reaches `/start`/`GET /divisions/{id}`
  // unconditionally. This file is not ABOUT the start step (it exists for
  // the DLS-gate probe/officials-auto wiring), so it only answers `/start`
  // and the re-read — it does not phase-gate scoring/import, which stays
  // out of this file's own scope.
  const phase = makeDivisionPhaseWorld();
  // B05 T3 — see `_advance-routes.ts`'s own header comment: EVERY
  // `sql`-passing fake now reaches the advancement routes unconditionally,
  // because `_tiny.json`'s own `s-playoff` always declares a `progression`.
  // This file is not ABOUT advancement; it exists so the DLS-gate/officials
  // wiring this file DOES cover stays green rather than reddening on an
  // unmodeled route.
  const advanceRoutes = makeAdvanceRoutesWorld({
    getQualifiers: (stageId) => {
      const divisionId = divisionIdByStageId.get(stageId);
      return divisionId === undefined ? undefined : schedule.entrantsOfDivision(divisionId);
    },
  });
  // B05 T4 — the runtime oracle's own route, unconditionally reached once
  // `s-playoff` completes (see `_oracle-routes.ts`'s own header comment).
  // B05 T5b — keyed by division NAME so BOTH leaderboard divisions the pack
  // now names (`Tiny` and, since T5b-1, `Tiebreak`) are answered; a name this
  // pack declares no leaderboard for falls through to `undefined`. Hoisted
  // out of the world literal below so the person-stats routes can derive
  // their own answers from the SAME source.
  const divisionPlayerStatsFor = (divisionId: string) => {
    const divisionName = divisionNameById.get(divisionId);
    if (divisionName === undefined) return undefined;
    return tinyDivisionPlayerStats(divisionName, (fullName) => `person-${slug(fullName)}`);
  };
  const divisionCardSources = (): readonly DivisionCardSource[] =>
    [...divisionNameById.entries()].flatMap(([divisionId, divisionName]) => {
      const playerStats = divisionPlayerStatsFor(divisionId);
      return playerStats === undefined
        ? []
        : [{ divisionId, divisionName, sportKey: divisionSportById.get(divisionId) ?? "unknown", playerStats }];
    });

  // B05 T5b-3 — the discipline surface (five routes), from the shared world.
  const entrantByDivisionPerson = new Map<string, string>();
  const discipline = makeDisciplineRoutesWorld({
    entrantForPerson: (divisionId, personId) =>
      entrantByDivisionPerson.get(`${divisionId}|${personId}`),
  });

  const oracleRoutes = makeOracleRoutesWorld({
    // `_tiny` declares one special; without a folded state its
    // `phase` claim reads as absent and reds every run in this file.
    getFixtureModuleState: () => TINY_SPECIAL_STATE,
    getRankedEntrantIds: (stageId) => {
      const divisionId = divisionIdByStageId.get(stageId);
      return divisionId === undefined ? undefined : schedule.entrantsOfDivision(divisionId);
    },
    getFullStandingsRows: (stageId) => {
      const divisionId = divisionIdByStageId.get(stageId);
      const stageName = stageNameById.get(stageId);
      if (divisionId === undefined || stageName === undefined) return undefined;
      return tinyLeagueTableRows(stageName, schedule.entrantsOfDivision(divisionId));
    },
    getDivisionPlayerStats: divisionPlayerStatsFor,
    // B05 T5b — the two person-stats reads, DERIVED from the same
    // per-division sources (see `_oracle-routes.ts`).
    getPersonStats: (personId) => personStatsFromDivisions(personId, divisionCardSources()),
    getPersonCareerStats: (personId) => personCareerStatsFromDivisions(personId, divisionCardSources()),
  });

  // B06a T6 — the claim rail (officials invite, person claim-invite mint and
  // read-back, and `POST /api/claims/{token}/accept`). Reached unconditionally
  // now: the runner accepts the pack's player invites after the fold on every
  // `sql`-passing run.
  const claims = makeClaimRoutesWorld();

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

  const transport: ProbeTransport = {
    async signIn(_base, s) {
      calls.push({ method: "SIGNIN", path: "signIn", body: undefined });
      const orgId = "org-fixed";
      orgBySession.set(s, orgId);
      return { has_org: true, org_id: orgId, redirect: "/dashboard" };
    },
    async request<T>(_base: string, _s: Session, rawPath: string, reqOpts?: { method?: string; body?: unknown }) {
      const method = reqOpts?.method ?? "GET";
      const body = reqOpts?.body;
      const routePath = rawPath.split("?")[0]!;
      calls.push({ method, path: rawPath, body });

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
        return { id: `person-${slug((body as { full_name: string }).full_name)}` } as T;
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
        // B05 T5b-3 — the roster the request carried, so the discipline world
        // can answer `entrantForPerson` the way `decideSuspension` resolves it.
        rows.forEach((e, i) => {
          for (const m of e.members ?? []) {
            if (m.person_id !== undefined) {
              entrantByDivisionPerson.set(`${entrantsMatch[1]!}|${m.person_id}`, out[i]!.id);
            }
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
                  return { id, ext_key: `rr-r${i + 1}-c1` };
                },
              );
        schedule.addFixtures(stageId, fixtures);
        return { fixtures } as unknown as T;
      }
      // B04 — the seven scheduling endpoints, from the shared world. BEFORE
      // the officials routes below, so the anchored `PATCH /fixtures/{id}`
      // (a lock) and `PATCH /fixtures/{id}/officials` (a set) cannot shadow
      // each other.
      const scheduled = schedule.handle(method, routePath, body);
      if (scheduled !== undefined) return scheduled as T;
      const autoOfficialsMatch = /^\/api\/v1\/divisions\/([^/]+)\/officials\/auto$/.exec(routePath);
      if (method === "POST" && autoOfficialsMatch !== null && opts.autoAssignSameOfficialTwice === true) {
        const divisionId = autoOfficialsMatch[1]!;
        const placed = [...schedule.fixtures.values()]
          .filter((f) => f.division_id === divisionId && f.scheduled_at !== null)
          .sort((a, b) => a.round_no - b.round_no || a.id.localeCompare(b.id))
          .slice(0, 2);
        return {
          assignments: placed.map((f) => ({
            fixtureId: f.id,
            officialId: "official-eli-ostrander",
            roleKey: "linesman",
          })),
        } as unknown as T;
      }
      if (method === "POST" && /^\/api\/v1\/divisions\/[^/]+\/officials\/auto$/.test(routePath)) {
        // Non-empty when the caller actually wants a proposal — `_tiny.json`'s
        // "off-eli" (role_keys ["linesman"]) is the one auto-needing official
        // this fake ever needs to satisfy. Always the SAME official/fixture
        // pair regardless of division id, since the DLS-gate probe's own
        // throwaway divisions never call this route at all — the only real
        // caller in a `runTinySuite` run is the post-scheduling auto-assign
        // step for `_tiny`'s own division.
        return {
          assignments: [{ fixtureId: "fx-auto-assigned", officialId: "official-eli-ostrander", roleKey: "linesman" }],
        } as unknown as T;
      }
      if (method === "POST" && /^\/api\/v1\/divisions\/[^/]+\/officials\/apply$/.test(routePath)) {
        const b = body as { assignments: { fixture_id: string; official_id: string }[] };
        for (const a of b.assignments) fixtureOfficials.set(a.fixture_id, [{ official_id: a.official_id }]);
        return { applied: b.assignments.length } as T;
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
        // B04: onto the BOARD too — the checker's officials rule reads
        // `GET /divisions/{id}/fixtures`, and a PATCH that never landed there
        // leaves design §4.3's rule permanently vacuous.
        schedule.setOfficials(fixtureId, set);
        return { ok: true } as T;
      }
      if (method === "GET" && /^\/api\/v1\/fixtures\/[^/]+$/.test(routePath)) {
        const fixtureId = routePath.split("/")[4]!;
        return { id: fixtureId, officials: fixtureOfficials.get(fixtureId) ?? [] } as T;
      }
      // B05 T2.5 (D9) — the RE-READ `runDivisionStartLayer` makes after a
      // successful `/start`.
      const divisionGet = phase.handleDivisionGet(method, routePath);
      if (divisionGet !== undefined) return divisionGet as T;
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
      // B05 T5b-3 — the discipline surface (see `_discipline-routes.ts`).
      const disciplined = discipline.handle(method, path, body);
      if (disciplined !== undefined) return disciplined;
      // B05 T2 — division B's own streams (`d-badminton`) fold through THIS
      // route unconditionally whenever `sql` is present, same gating as
      // division A's single-event fold below. This suite is not ABOUT the
      // import path — it exists so DLS-gate/officials assertions stay green
      // rather than reddening on an unmodeled route.
      const importMatch = /^\/api\/v1\/divisions\/[^/]+\/events\/import$/.exec(path);
      if (importMatch) {
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
      // B07a T11 — the probe's device-link cells. `createDeviceLink` gates on
      // `scoring.device_links` (usecases/device-links.ts:128) before it reads
      // the fixture, so again only the plan decides the answer.
      if (/^\/api\/v1\/fixtures\/[^/]+\/device-links$/.test(path)) {
        if (!opts.deviceLinksSold) throw new Error(`fake server: device-link mint with no device links on the catalog: ${path}`);
        if (provisionedPlan === null) {
          return {
            status: 402,
            json: { ok: false, error: { code: "PAYMENT_REQUIRED", message: "nope", feature_key: "scoring.device_links" } } as never,
          };
        }
        return { status: 201, json: { ok: true, data: { id: "dl-1", secret: "dl_fake" } } as never };
      }
      // …and revokes what it minted, by DELETE on the link's own route.
      if (method === "DELETE" && /^\/api\/v1\/fixtures\/[^/]+\/device-links\/[^/]+$/.test(path)) {
        const status = opts.deviceLinkRevokeStatus ?? 200;
        return status === 200
          ? { status, json: { ok: true, data: { id: "dl-1", revoked_at: "2026-09-14T12:00:00Z" } } as never }
          : { status, json: { ok: false, error: { code: "INTERNAL", message: "nope" } } as never };
      }
      const m = /^\/api\/v1\/fixtures\/([^/]+)\/events$/.exec(path);
      if (!m) throw new Error(`fake server: unhandled raw ${method} ${path}`);
      const { type, payload } = body as { type: string; payload: { target?: unknown } };
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
      return { status: 201, json: { ok: true, data: { seq: 1 } } as never };
    },
  };

  const sql: PlanSql = {
    async entitlementRows(featureKey) {
      sqlCalls.push(`entitlementRows(${featureKey})`);
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
        return [
          { plan_key: "community", bool_value: false },
          { plan_key: "pro", bool_value: opts.officialsAutoGranted },
        ] satisfies PlanEntitlementRow[];
      }
      if (featureKey === "scoring.device_links" && opts.deviceLinksSold === true) {
        return [
          { plan_key: "community", bool_value: false },
          { plan_key: "pro", bool_value: true },
        ] satisfies PlanEntitlementRow[];
      }
      // `stats.player` deliberately absent, and the omission is load-bearing:
      // granting it switches the player-stats baseline ON, and this fake
      // models the scheduling surface, not the three stats routes — so the run
      // would go red for a reason that has nothing to do with what these tests
      // assert. Tried it; all three reddened. The consequence is that the
      // capability gap reported below names `stats.player` as well as
      // `officials.auto`, which the assertion accounts for rather than hides.
      return [];
    },
    // B05 T0: `chooseGrantingPlanForCapabilities` now filters candidates to
    // is_public plans — "pro" is the only plan this fixture ever grants
    // anything to, so it just needs to be marked public to keep resolving
    // the way it always did.
    async planCandidateInfo(planKeys) {
      sqlCalls.push(`planCandidateInfo(${planKeys.join(",")})`);
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
    async setDivisionActive(divisionId) {
      sqlCalls.push(`setDivisionActive(${divisionId})`);
    },
  };

  return { transport, sql, calls, schedule };
}

describe("runTinySuite — B03 T7 plan/entitlement-gate wiring", () => {
  it("drives the DLS-gate probe and reports its 5 cells as oracles, all passing", async () => {
    const { transport, sql, calls } = fakeServer({ officialsAutoGranted: false });

    const report = await runTinySuite({
      base: "http://bench.example",
      engine: "optimized",
      keep: false,
      log: silent,
      // B03r tasks 9+10: `_tiny.json` now declares a THIRD division
      // (`d-registration`) — this file is about the DLS-gate entitlement
      // probe, not registration, so `cliEntry: "admin"` keeps it there
      // (also live coverage of the task's own acceptance criterion:
      // `--entry admin` needs neither Stripe nor a browser).
      cliEntry: "admin",
      packPath: TINY_PACK_PATH,
      transport,
      sql,
      probeTransport: transport,
      // B05 T1 — this fake's `raw()` already answers `POST .../fixtures/
      // {id}/events` generically (201, unless the DLS-gate probe's own
      // cricket.revise/dls-enabled combination applies), so it doubles as
      // the simulate step's transport with no further changes.
      simTransport: transport,
      // B05 T2 — the SAME fake now handles `/events/import` too (this
      // file's own `raw()`), so division B's own streams fold cleanly
      // rather than falling back to a real `fetch()`.
      importTransport: transport,
      startTransport: transport,
      advanceTransport: transport,
      oracleTransport: transport,
      matchBoard: echoExpectedBoard,
      specialSubjects: echoSpecialSubjects,
    });

    expect(report.gate).toBe("green");
    expect(report.oracles).toBeDefined();
    // Scoped to the entitlement-gate's own 5 cells — `report.oracles` also
    // carries B03 T6b's officials-claim-invite oracles now (unconditional,
    // proved separately below and in tiny-suite.test.ts), which this test
    // does not own.
    const gateOracles = (report.oracles ?? []).filter((o) => o.name.startsWith("entitlement-gate:"));
    // B05: the cells no longer say "unentitled"/"entitled", because no plan
    // choice can make an org unentitled to `cricket.dls` any more — scoring
    // is free (owner ruling; V393__entitlements_v18.sql:63-70). The
    // `gated_feature_...` cell is ABSENT here on purpose: this fixture's
    // catalog grants `officials.auto` to no plan at all
    // (`officialsAutoGranted: false`), so nothing it can provoke is still
    // sold and the cell retires itself — asserted below.
    expect(gateOracles.map((o) => o.name)).toEqual([
      "entitlement-gate: revise_no_target_community",
      "entitlement-gate: revise_with_target_community",
      "entitlement-gate: revise_dls_off_community",
      "entitlement-gate: other_event_community",
      "entitlement-gate: revise_no_target_after_plan",
      "entitlement-gate: cricket.dls is free on the plan a non-paying org resolves to",
    ]);
    expect(gateOracles.every((o) => o.passed)).toBe(true);

    // The retirement is REPORTED, never silent: a run that loses the "a 402
    // names its feature_key" cell has to say so, or the coverage evaporates
    // with a green gate — the exact shape of the failure this wave repaired.
    const retiredWarning = (report.warnings ?? []).find((w) => w.includes("did not run"));
    expect(retiredWarning, "a retired paywall cell must be reported").toBeDefined();
    expect(retiredWarning).toContain("PROVOCABLE_GATED_FEATURES");

    // B07a T11 — this catalog has no `scoring.device_links` rows at all, so
    // the probe's two device-link cells retire (nothing to refuse for) and the
    // chosen plan cannot mint a device link. Both are REPORTED, never silent;
    // the sold path, where neither warning may appear, is the next test.
    const warnings = report.warnings ?? [];
    expect(
      warnings.find((w) => w.includes("scoring.device_links") && w.includes("not paywalled")),
      "retired device-link cells must be reported",
    ).toBeDefined();
    expect(
      warnings.find((w) => w.includes("deviceLinksGranted")),
      "a run whose plan cannot mint a device link must say so",
    ).toBeDefined();

    // The probe's own throwaway competition really was created over HTTP —
    // proof this is DRIVEN, not merely defined and never called.
    expect(calls.some((c) => c.method === "POST" && c.path === "/api/v1/competitions" &&
      (c.body as { name: string }).name.startsWith("Bench DLS Gate Probe"))).toBe(true);
  });

  it("B07a T11 — device links sold: both device-link cells reach the report as passing oracles, and nothing warns about device links", async () => {
    const { transport, sql } = fakeServer({ officialsAutoGranted: true, deviceLinksSold: true });

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

    expect((report.errors ?? []).join("\n")).toBe("");
    expect(report.gate).toBe("green");
    // Through run-suite's generic `entitlement-gate: ${cell.cell}` loop — no
    // device-link-specific wiring exists or is needed there.
    const byName = new Map((report.oracles ?? []).map((o) => [o.name, o] as const));
    expect(byName.get("entitlement-gate: device_link_refused_before_plan")?.passed).toBe(true);
    expect(byName.get("entitlement-gate: device_link_minted_after_plan")?.passed).toBe(true);
    // The negative pair of the previous test's two warnings.
    expect(
      (report.warnings ?? []).filter((w) => w.includes("scoring.device_links") || w.includes("deviceLinksGranted")),
    ).toEqual([]);
  });

  it("B07a T11 fix round 1 — a device-link revoke that fails reaches the report as a WARNING: no error, a green gate, and never the secret", async () => {
    const { transport, sql, calls } = fakeServer({
      officialsAutoGranted: true,
      deviceLinksSold: true,
      deviceLinkRevokeStatus: 500,
    });

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

    expect((report.errors ?? []).join("\n")).toBe("");
    expect(report.gate).toBe("green");
    const byName = new Map((report.oracles ?? []).map((o) => [o.name, o] as const));
    expect(byName.get("entitlement-gate: device_link_minted_after_plan")?.passed).toBe(true);
    // The revoke really went out, and its failure is said exactly once.
    expect(calls.filter((c) => c.method === "DELETE" && /\/device-links\/[^/]+$/.test(c.path))).toHaveLength(1);
    const revokeWarnings = (report.warnings ?? []).filter((w) => w.includes("dl-1"));
    expect(revokeWarnings).toHaveLength(1);
    expect(revokeWarnings[0]).toContain("status 500");
    // The one-time secret is nowhere in what the run reports.
    expect(JSON.stringify(report)).not.toContain("dl_fake");
  });

  it("autoAssign OFF: the provisioned plan does NOT grant officials.auto, so /officials/auto is never called", async () => {
    const { transport, sql, calls } = fakeServer({ officialsAutoGranted: false });

    const report = await runTinySuite({
      base: "http://bench.example",
      engine: "optimized",
      keep: false,
      log: silent,
      // B03r tasks 9+10: `_tiny.json` now declares a THIRD division
      // (`d-registration`) — this file is about the DLS-gate entitlement
      // probe, not registration, so `cliEntry: "admin"` keeps it there
      // (also live coverage of the task's own acceptance criterion:
      // `--entry admin` needs neither Stripe nor a browser).
      cliEntry: "admin",
      packPath: TINY_PACK_PATH,
      transport,
      sql,
      probeTransport: transport,
      // B05 T1 — this fake's `raw()` already answers `POST .../fixtures/
      // {id}/events` generically (201, unless the DLS-gate probe's own
      // cricket.revise/dls-enabled combination applies), so it doubles as
      // the simulate step's transport with no further changes.
      simTransport: transport,
      // B05 T2 — the SAME fake now handles `/events/import` too (this
      // file's own `raw()`), so division B's own streams fold cleanly
      // rather than falling back to a real `fetch()`.
      importTransport: transport,
      startTransport: transport,
      advanceTransport: transport,
      oracleTransport: transport,
      matchBoard: echoExpectedBoard,
      specialSubjects: echoSpecialSubjects,
    });

    expect(report.gate).toBe("green");
    expect(calls.some((c) => c.method === "POST" && /\/officials\/auto$/.test(c.path))).toBe(false);

    // And the run SAYS SO. Second-review finding: the
    // `unsatisfiedCapabilities -> warnings` wiring in `suites/tiny.ts` had no
    // end-to-end test, so the gap could stop being reported and every existing
    // assertion would still pass — the run would simply skip auto-assign in
    // silence, which is the shape of the F1 defect this whole area exists to
    // prevent. Pinned on the CONTENT, not merely on a warning existing.
    const gapWarning = (report.warnings ?? []).find((w) => w.includes("does not also grant"));
    expect(gapWarning, "the run must report the capability it could not provision").toBeDefined();
    expect(gapWarning).toContain("officials.auto");
    // Names the plan it settled on too, so a reader can tell "no plan grants
    // this" from "the plan we picked for something else does not".
    //
    // B05: that plan is now `community`. On this fixture's catalog NO plan
    // grants officials.auto, and `cricket.dls` — the one REQUIRED capability
    // — is granted by `community` itself (V393:63-70), which is public and
    // privilege-0, so it is the least-privileged public grantor and wins.
    // That is the chooser working correctly on a catalog where scoring is
    // free, not a regression: before V393 `community` had no cricket.dls row
    // at all and could never have been a candidate.
    expect(gapWarning).toContain('plan "community"');
  });

  it("autoAssign ON: the provisioned plan DOES grant officials.auto, so runOfficialsAutoAssign's auto pass is actually called — AFTER schedule/apply, never before", async () => {
    const { transport, sql, calls } = fakeServer({ officialsAutoGranted: true });

    const report = await runTinySuite({
      base: "http://bench.example",
      engine: "optimized",
      keep: false,
      log: silent,
      // B03r tasks 9+10: `_tiny.json` now declares a THIRD division
      // (`d-registration`) — this file is about the DLS-gate entitlement
      // probe, not registration, so `cliEntry: "admin"` keeps it there
      // (also live coverage of the task's own acceptance criterion:
      // `--entry admin` needs neither Stripe nor a browser).
      cliEntry: "admin",
      packPath: TINY_PACK_PATH,
      transport,
      sql,
      probeTransport: transport,
      // B05 T1 — this fake's `raw()` already answers `POST .../fixtures/
      // {id}/events` generically (201, unless the DLS-gate probe's own
      // cricket.revise/dls-enabled combination applies), so it doubles as
      // the simulate step's transport with no further changes.
      simTransport: transport,
      // B05 T2 — the SAME fake now handles `/events/import` too (this
      // file's own `raw()`), so division B's own streams fold cleanly
      // rather than falling back to a real `fetch()`.
      importTransport: transport,
      startTransport: transport,
      advanceTransport: transport,
      oracleTransport: transport,
      matchBoard: echoExpectedBoard,
      specialSubjects: echoSpecialSubjects,
    });

    expect(report.gate).toBe("green");
    // `_tiny.json`'s "off-eli" official declares empty `assignments` — the
    // one auto-needing official this run's plan flip is supposed to unblock
    // (seed.ts's own header comment on why this call was previously never
    // wired at all).
    expect(calls.some((c) => c.method === "POST" && /\/officials\/auto$/.test(c.path))).toBe(true);
    expect(calls.some((c) => c.method === "POST" && /\/officials\/apply$/.test(c.path))).toBe(true);

    // B03 review F1(b), the acceptance criterion itself: assert the ORDER,
    // not merely that both happened. A regression that put the auto pass
    // back inside `seedSuite` (before this suite's OWN scheduling walk)
    // would still make both calls truthy above while reversing this order —
    // that mutant is what this specific assertion exists to kill.
    const scheduleApplyIdx = calls.findIndex(
      (c) => c.method === "POST" && /^\/api\/v1\/stages\/[^/]+\/schedule\/apply$/.test(c.path),
    );
    // B05: `/officials/auto` is now hit TWICE in a run. The DLS-gate probe's
    // RE-POINTED paywall cell provokes it FIRST, on the probe's own throwaway
    // division and deliberately BEFORE the plan flip, where it must 402 —
    // `officials.auto` is what the live matrix still gates now that
    // `cricket.dls` is free. Taking `findIndex` here would match THAT call and
    // satisfy the ordering check for free, which is exactly the vacuous pass
    // this assertion exists to prevent, so scope to the LAST one and pin the
    // probe's call on the other side of schedule/apply.
    const officialsAutoIdxs = calls
      .map((c, i) => ({ c, i }))
      .filter(({ c }) => c.method === "POST" && /\/officials\/auto$/.test(c.path))
      .map(({ i }) => i);
    expect(officialsAutoIdxs).toHaveLength(2);
    const officialsAutoIdx = officialsAutoIdxs[1]!;
    const officialsApplyIdx = calls.findIndex((c) => c.method === "POST" && /\/officials\/apply$/.test(c.path));
    expect(scheduleApplyIdx).toBeGreaterThan(-1);
    expect(officialsAutoIdxs[0]!).toBeLessThan(scheduleApplyIdx);
    expect(officialsAutoIdx).toBeGreaterThan(scheduleApplyIdx);
    expect(officialsApplyIdx).toBeGreaterThan(officialsAutoIdx);

    // The auto-assign oracle this task adds — proves a real run REACHES the
    // auto-needing official, not merely that the HTTP calls fired.
    const autoOracle = (report.oracles ?? []).find((o) => o.name.includes("auto-assign reaches"));
    expect(autoOracle?.passed).toBe(true);
  });

  it("without `sql`, the probe is SKIPPED entirely — today's behavior, unchanged", async () => {
    const { transport, calls } = fakeServer({ officialsAutoGranted: true });

    const report = await runTinySuite({
      base: "http://bench.example",
      engine: "optimized",
      keep: false,
      log: silent,
      // B03r tasks 9+10: `_tiny.json` now declares a THIRD division
      // (`d-registration`) — this file is about the DLS-gate entitlement
      // probe, not registration, so `cliEntry: "admin"` keeps it there
      // (also live coverage of the task's own acceptance criterion:
      // `--entry admin` needs neither Stripe nor a browser).
      cliEntry: "admin",
      packPath: TINY_PACK_PATH,
      transport,
    });

    expect(report.gate).toBe("green");
    // No entitlement-gate cells — the probe itself really is skipped. B03
    // T6b's officials-claim-invite oracles still fire (ungated, unrelated to
    // `sql`), so `report.oracles` is no longer entirely absent — scoped to
    // what THIS test owns proving.
    expect((report.oracles ?? []).some((o) => o.name.startsWith("entitlement-gate:"))).toBe(false);
    expect(calls.some((c) => c.path.includes("entitlement-override"))).toBe(false);
    expect(calls.some((c) => c.method === "POST" && /\/officials\/auto$/.test(c.path))).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// B04 F-T6-2 — the board is RE-CHECKED after officials auto-assign
//
// `/officials/auto`'s own `engineInput` only considers fixtures whose
// `scheduled_at` is set (`usecases/officials.ts:386`), so auto-assign cannot
// run before apply — B03 review F1(b) established that, and it is not
// negotiable. The consequence is that the board `runScheduleLayer` fetched,
// and every verdict taken on it, PREDATES whatever auto-assign puts on it: an
// official double-booking introduced there is seen by neither layer 1 nor
// design §3.3's officials rule.
//
// So the checker runs a second time, and BOTH verdicts are reported. Not one:
// a single post-officials verdict would hide which stage introduced a finding.
// ---------------------------------------------------------------------------
describe("runTinySuite — the post-officials re-check (B04 F-T6-2)", () => {
  async function runWith(opts: Parameters<typeof fakeServer>[0]) {
    const server = fakeServer(opts);
    const report = await runTinySuite({
      base: "http://bench.example",
      engine: "optimized",
      keep: false,
      log: silent,
      cliEntry: "admin",
      packPath: TINY_PACK_PATH,
      transport: server.transport,
      sql: server.sql,
      probeTransport: server.transport,
      simTransport: server.transport,
      importTransport: server.transport,
      startTransport: server.transport,
      advanceTransport: server.transport,
      oracleTransport: server.transport,
      matchBoard: echoExpectedBoard,
      specialSubjects: echoSpecialSubjects,
    });
    return { report, server };
  }

  it("catches an official double-booking that NEITHER the first checker pass nor layer 1 could see", async () => {
    // `doubleBookCourt` makes a division's own fixtures overlap in time, which
    // is what an official double-booking needs to exist at all. The first pass
    // sees the court clash; only the SECOND pass can see the official on both,
    // because the official was not on the board when the first pass ran.
    const { report } = await runWith({
      officialsAutoGranted: true,
      autoAssignSameOfficialTwice: true,
      schedule: { doubleBookCourt: true },
    });

    const rows = report.scheduling ?? [];
    const withAfter = rows.filter((r) => r.checkerAfterOfficials !== undefined);
    expect(withAfter.length, "auto-assign applied, so every division is re-checked").toBeGreaterThan(0);

    const touched = rows.find((r) =>
      (r.checkerAfterOfficials?.findings ?? []).some((f) => f.kind === "official_double_booking"),
    );
    expect(touched, "the re-check must find the official on two overlapping fixtures").toBeDefined();

    // THE DIFFERENTIAL, which is the whole point of keeping both verdicts:
    // the finding is present AFTER and absent BEFORE. A single post-officials
    // verdict would report it without saying which stage introduced it.
    expect(touched?.checker?.findings.map((f) => f.kind) ?? []).not.toContain(
      "official_double_booking",
    );
    expect(touched?.red).toBe(true);
    expect(report.gate).toBe("red");
    expect((report.errors ?? []).join(" | ")).toContain(
      "checker findings AFTER officials auto-assign",
    );
  });

  it("re-checks even when the second pass is CLEAN, so 'unchanged' is a stated result and not a silence", async () => {
    // A re-check that only appeared on failure would be indistinguishable from
    // one that never ran.
    const { report } = await runWith({
      officialsAutoGranted: true,
      autoAssignSameOfficialTwice: true,
    });
    const rows = report.scheduling ?? [];
    expect(rows.every((r) => r.checkerAfterOfficials !== undefined)).toBe(true);
    expect(rows.every((r) => r.checkerAfterOfficials?.clean === true)).toBe(true);
    expect(report.gate).toBe("green");
  });

  it("is ABSENT when auto-assign applied nothing — there is no second board to judge", async () => {
    // The complement. `officialsAutoGranted: false` means `/officials/auto` is
    // never called at all, so the board never changed and a second verdict
    // would be the first one copied.
    const { report } = await runWith({ officialsAutoGranted: false });
    const rows = report.scheduling ?? [];
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every((r) => r.checkerAfterOfficials === undefined)).toBe(true);
  });
});
