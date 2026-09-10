// B03 T6b — proves `runTinySuite` actually DRIVES the player-stats baseline
// end to end against the REAL committed `_tiny.json` pack: removing the
// `if (input.sql !== undefined) { ... readPlayerStatsBaseline(...) ... }`
// block in `lib/suites/tiny.ts`, or the `competitionVisibility` passthrough
// it feeds into `seedSuite`, reds a test here (AGENTS.md recurring-failure
// class 1 — "the inert seam"; the same acceptance criteria T7's own
// `tiny-suite-plan.test.ts` was built to satisfy for the DLS-gate probe).
//
// A fresh, self-contained fake — same "minimize blast radius outside what
// THIS task owns" precedent `tiny-suite-plan.test.ts`'s own header comment
// gives for not extending `tiny-suite.test.ts`'s shared `makeFakeServer()`.
// This fake's `request()` surface is copied from `tiny-suite-plan.test.ts`'s
// own `fakeServer` (same generic legs/ext_key derivation, needed because
// `input.sql` present ALSO drives the DLS-gate probe and officials seam
// unconditionally — there is no way to exercise T6b's own gating without
// the whole surface answering), extended with the stats-baseline routes
// this task adds: `GET /api/orgs`, `GET /api/v1/divisions/{id}` (bare —
// the division's slug read-back), `GET /api/v1/persons/{id}/stats`,
// `GET /api/v1/divisions/{id}/stats/players`, and the public route.
import { describe, expect, it } from "vitest";
import pino from "pino";
import type { RawResult, Session } from "../http.ts";
import type { ProbeTransport } from "../dls-gate.ts";
import type { PlanEntitlementRow, PlanSql } from "../plan.ts";
import { runTinySuite, TINY_PACK_PATH } from "../suites/tiny.ts";
// B04 — the seven scheduling endpoints, shared with the other fakes in this
// directory, so no two of them can disagree about what landed on the board.
import { makeScheduleWorld } from "./_schedule-routes.ts";
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

function fakeServer(opts: {
  /** B06a T7 — knobs for the shared news rail (`_news-routes.ts`). */
  newsRoutes?: NewsRoutesOptions;
  statsPlayerGranted: boolean;
}): {
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

  const schedule = makeScheduleWorld({ solverEngine: "optimized" });
  // B05 T2.5 (D9) — see `_division-phase.ts`'s own header comment: EVERY
  // `sql`-passing fake now reaches `/start`/`GET /divisions/{id}`
  // unconditionally. This file is not ABOUT the start step, so it only
  // answers `/start` and the re-read.
  const phase = makeDivisionPhaseWorld();
  // B05 T3 — see `_advance-routes.ts`'s own header comment: EVERY
  // `sql`-passing fake now reaches the advancement routes unconditionally,
  // because `_tiny.json`'s own `s-playoff` always declares a `progression`.
  // This file is not ABOUT advancement; it exists so the player-stats
  // baseline assertions this file DOES cover stay green.
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
        // B04: onto the BOARD too — see the same note in the other fakes.
        schedule.setOfficials(fixtureId, set);
        return { ok: true } as T;
      }
      if (method === "GET" && /^\/api\/v1\/fixtures\/[^/]+$/.test(routePath)) {
        const fixtureId = routePath.split("/")[4]!;
        return { id: fixtureId, officials: fixtureOfficials.get(fixtureId) ?? [] } as T;
      }
      // B03 T6b — the stats baseline's own routes.
      const personStatsMatch = /^\/api\/v1\/persons\/[^/]+\/stats$/.test(routePath);
      if (method === "GET" && personStatsMatch) {
        return { divisions: [] } as unknown as T;
      }
      if (method === "GET" && /^\/api\/v1\/divisions\/[^/]+\/stats\/players$/.test(routePath)) {
        return { metrics: [], rows: [], requires_detailed_scoring: false } as unknown as T;
      }
      if (method === "GET" && /^\/api\/v1\/public\/orgs\/[^/]+\/competitions\/[^/]+\/divisions\/[^/]+\/stats$/.test(routePath)) {
        return { rows: [] } as unknown as T;
      }
      // Bare `GET /api/v1/divisions/{id}` — the division-slug read-back.
      // Ordered AFTER every more specific `/divisions/{id}/...` pattern
      // above so it only ever matches the bare form.
      if (method === "GET" && /^\/api\/v1\/divisions\/[^/]+$/.test(routePath)) {
        // B05 T2.5 — `status` is D9's own RE-READ; `slug` is the pre-existing
        // read-back this file's own header comment names.
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
      // B05 T5b-3 — the discipline surface (see `_discipline-routes.ts`).
      const disciplined = discipline.handle(method, path, body);
      if (disciplined !== undefined) return disciplined;
      // B05 T2 — division B's own streams (`d-badminton`) fold through THIS
      // route unconditionally whenever `sql` is present, same gating as
      // division A's single-event fold below. This suite is not ABOUT the
      // import path — it exists so the player-stats-baseline assertions
      // stay green rather than reddening on an unmodeled route.
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
        return [
          { plan_key: "community", bool_value: false },
          { plan_key: "pro", bool_value: opts.statsPlayerGranted },
        ] satisfies PlanEntitlementRow[];
      }
      return [];
    },
    // B05 T0: `chooseGrantingPlanForCapabilities` now filters candidates to
    // is_public plans — "pro" is the only plan this fixture ever grants
    // anything to, so it just needs to be marked public to keep resolving
    // the way it always did.
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

describe("runTinySuite — B03 T6b player-stats baseline wiring", () => {
  it("statsPlayerGranted: drives all three stats routes for real, and reports a passing oracle", async () => {
    const { transport, sql, calls } = fakeServer({ statsPlayerGranted: true });

    const report = await runTinySuite({
      base: "http://bench.example",
      engine: "optimized",
      keep: false,
      log: silent,
      // B03r tasks 9+10: `_tiny.json` now declares a THIRD division
      // (`d-registration`) — this file is about the player-stats baseline,
      // not registration, so `cliEntry: "admin"` keeps it there (also live
      // coverage of the task's own acceptance criterion: `--entry admin`
      // needs neither Stripe nor a browser).
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
    expect(calls.some((c) => c.method === "GET" && c.path === "/api/orgs")).toBe(true);
    expect(calls.some((c) => c.method === "GET" && /^\/api\/v1\/divisions\/div-\d+$/.test(c.path))).toBe(true);
    expect(calls.some((c) => c.method === "GET" && /^\/api\/v1\/persons\/[^/]+\/stats\?division_id=/.test(c.path))).toBe(
      true,
    );
    expect(calls.some((c) => c.method === "GET" && /\/stats\/players$/.test(c.path))).toBe(true);
    expect(calls.some((c) => c.method === "GET" && c.path.includes("/api/v1/public/orgs/"))).toBe(true);
    // The competition's visibility was cleared for the public route — see
    // lib/stats.ts's header comment on why (default 'private' 404s it).
    // TWO competitions get created (the DLS-gate probe's own throwaway one,
    // then `_tiny`'s own via `seedSuite`) — `_tiny`'s is the one that never
    // names itself "Bench DLS Gate Probe ...".
    const competitionPosts = calls.filter((c) => c.method === "POST" && c.path === "/api/v1/competitions");
    const tinyCompetitionPost = competitionPosts.find(
      (c) => !(c.body as { name: string }).name.startsWith("Bench DLS Gate Probe"),
    );
    expect((tinyCompetitionPost?.body as { visibility?: string }).visibility).toBe("unlisted");

    const oracle = (report.oracles ?? []).find((o) => o.name === "player-stats: baseline");
    expect(oracle).toBeDefined();
    expect(oracle?.passed).toBe(true);
  });

  it("statsPlayerGranted FALSE: the baseline is SKIPPED (no stats routes called), and the report says why", async () => {
    const { transport, sql, calls } = fakeServer({ statsPlayerGranted: false });

    const report = await runTinySuite({
      base: "http://bench.example",
      engine: "optimized",
      keep: false,
      log: silent,
      // B03r tasks 9+10: `_tiny.json` now declares a THIRD division
      // (`d-registration`) — this file is about the player-stats baseline,
      // not registration, so `cliEntry: "admin"` keeps it there (also live
      // coverage of the task's own acceptance criterion: `--entry admin`
      // needs neither Stripe nor a browser).
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
    expect(calls.some((c) => c.method === "GET" && c.path === "/api/orgs")).toBe(false);
    // NOT `/stats/players` (B05 T4b now calls that route independently, via
    // `raw()`, for the leaderboard oracle — unconditionally, regardless of
    // this `statsPlayerGranted` knob, which only gates B03 T6b's OWN
    // `request()`-based baseline read).
    //
    // B05 T5b-2 narrowed this from `/persons/{id}/stats(\?|$)` to the
    // `?division_id=` form for the SAME reason, and only that reason: the
    // career/person-card oracles now call the bare path and its
    // `?group=sport` sibling unconditionally, via `raw()`. `?division_id=`
    // is the ONE shape only this baseline ever sends (`player-stats.ts`'s
    // per-division read), so the discriminator is still exact rather than
    // weakened — and the two assertions below pin the baseline's absence by
    // its own oracle and warning, independently of any route count.
    expect(
      calls.some((c) => c.method === "GET" && /^\/api\/v1\/persons\/[^/]+\/stats\?division_id=/.test(c.path)),
    ).toBe(false);
    expect((report.oracles ?? []).some((o) => o.name === "player-stats: baseline")).toBe(false);
    expect((report.warnings ?? []).some((w) => w.includes("player-stats baseline skipped"))).toBe(true);
  });

  it("without `sql`: the baseline never runs, and the competition is never sent a visibility override", async () => {
    const { transport, calls } = fakeServer({ statsPlayerGranted: true });

    const report = await runTinySuite({
      base: "http://bench.example",
      engine: "optimized",
      keep: false,
      log: silent,
      // B03r tasks 9+10: `_tiny.json` now declares a THIRD division
      // (`d-registration`) — this file is about the player-stats baseline,
      // not registration, so `cliEntry: "admin"` keeps it there (also live
      // coverage of the task's own acceptance criterion: `--entry admin`
      // needs neither Stripe nor a browser).
      cliEntry: "admin",
      packPath: TINY_PACK_PATH,
      transport,
    });

    expect(report.gate).toBe("green");
    expect(calls.some((c) => c.method === "GET" && c.path === "/api/orgs")).toBe(false);
    const competitionPost = calls.find((c) => c.method === "POST" && c.path === "/api/v1/competitions");
    expect(competitionPost?.body && "visibility" in (competitionPost.body as object)).toBe(false);
  });
});
