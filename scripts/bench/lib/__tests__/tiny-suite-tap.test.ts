// B07a T10 — tap mode, wired: the organiser hands over, the scorer plays, the
// organiser signs off.
//
// Two layers, because a unit suite cannot launch a browser:
//
//  1. SUITE level (`runPackSuite` against the real `_tiny.json`): the tap
//     branch is reached by the declared play mode, hands every tapped fixture
//     to the injected `tapPlayer` seam (PackSuiteInput, R45 — same
//     optional-defaults-to-real shape as `registrationDrivers`), and then
//     judges what the PRODUCT says: every tapped fixture must read
//     `finalized`, driver findings red the gate, observations are counted and
//     never red, the parallelism cap is the division's own court count, and a
//     plan without `scoring.device_links` is a loud warning rather than a
//     silent skip.
//  2. PLAYER level (`createTapPlayer` against a fake browser + fake product):
//     the real `playMatchByTaps` and the real `genericAdapter` run against
//     fake pages, so the organiser hand-over, the secret read off the mint
//     response, the consent pre-answer, the core.start wait (R52 NB3) and the
//     reload before finalize (R52 NB5) are each killable here.
//
// The suite-level fake world is `tiny-suite-plan.test.ts`'s own `fakeServer`
// (the green, device-link-aware one Task 11 extended), COPIED — the same
// "fresh, self-contained fake per file" precedent every tiny-suite-*.test.ts
// file follows — with three additions for tap play: a board that carries
// `fixture_no` and a live status per fixture, the competition read (the
// console URL is addressed by the SERVER's slug), and the division slug.
import { describe, expect, it } from "vitest";
import pino from "pino";
import { readFile } from "node:fs/promises";
import type { RawResult, Session } from "../http.ts";
import type { ProbeTransport } from "../dls-gate.ts";
import type { PlanEntitlementRow, PlanSql } from "../plan.ts";
import { TINY_PACK_PATH } from "../suites/tiny.ts";
import { runPackSuite } from "../suites/run-suite.ts";
import { lookupSuite } from "../suites/registry.ts";
import { playModeFor, type PlayMode } from "../suites/types.ts";
import { makeScheduleWorld } from "./_schedule-routes.ts";
import { makeDivisionPhaseWorld } from "./_division-phase.ts";
import { makeAdvanceRoutesWorld } from "./_advance-routes.ts";
import type { DivisionCardSource } from "./_oracle-routes.ts";
import { makeClaimRoutesWorld } from "./_claim-routes.ts";
import { makeNewsRoutesWorld } from "./_news-routes.ts";
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
import { resolvePayloadRefs } from "../simulate.ts";

const silent = pino({ level: "silent" });

/** The brief's name for the pack these suite-level tests fold. It IS the
 *  committed `_tiny.json` — no second pack exists to drift from it. */
const FIXTURE_PACK_PATH = TINY_PACK_PATH;
const TAP_D_TINY: Readonly<Record<string, PlayMode>> = { "d-tiny": "tap" };

interface RecordedCall {
  readonly method: string;
  readonly path: string;
  readonly body: unknown;
}

function slug(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "");
}

/** The SERVER's competition slug — deliberately not the pack's
 *  `bench-tiny-series`, so a console URL built from the pack would 404 here
 *  exactly as it would live (the org-slug lesson in `resolveOrgSlug`'s doc). */
const SERVER_COMPETITION_SLUG = "bench-tiny-series-2";

interface TapWorldOptions {
  /** Put `scoring.device_links` on the catalog (community false, pro true). */
  deviceLinksSold: boolean;
  /** Report every fixture of these division NAMES as round 1 on the board, so
   *  one round carries more matches than the division has courts. */
  flattenRoundsOf?: readonly string[];
  /** Fix round 2 (R62) — the lineups route refuses every team sheet (422). */
  refuseLineupWrites?: boolean;
  /** Fix round 2 (R64) — the ledger read answers 500. */
  refuseLedgerReads?: boolean;
}

function fakeServer(opts: TapWorldOptions): {
  transport: ProbeTransport;
  sql: PlanSql;
  calls: RecordedCall[];
  /** The product's own status for a fixture — what a tap player's taps move. */
  setFixtureStatus(fixtureId: string, status: string): void;
  divisionNameOfFixture(fixtureId: string): string | undefined;
} {
  const calls: RecordedCall[] = [];
  const schedule = makeScheduleWorld({ solverEngine: "optimized" });
  const legsByStageId = new Map<string, number>();
  const kindByStageId = new Map<string, string>();
  const divisionIdByStageId = new Map<string, string>();
  const stageNameById = new Map<string, string>();
  const divisionNameById = new Map<string, string>();
  const divisionSportById = new Map<string, string>();
  const fixtureDivisionId = new Map<string, string>();
  const fixtureOfficials = new Map<string, unknown[]>();
  // T10 — the per-division ordinal the `/f/{no}` console URL segment uses
  // (`schemas.ts` `Fixture.fixture_no`), and the live status a tap moves.
  const fixtureNoById = new Map<string, number>();
  const fixtureCountByDivision = new Map<string, number>();
  const statusById = new Map<string, string>();
  // Fix round 2 (R64) — the ledger each fixture's events route actually
  // stored, served back on `GET .../events?since_seq=N`, so the specials
  // oracle's fold reads the PRODUCT's rows rather than the pack's.
  const ledgerById = new Map<string, { id: string; seq: number; type: string; payload: unknown }[]>();
  let divisionCounter = 0;
  let stageCounter = 0;
  let fixtureCounter = 0;
  let provisionedPlan: string | null = null;
  const phase = makeDivisionPhaseWorld();
  const advanceRoutes = makeAdvanceRoutesWorld({
    getQualifiers: (stageId) => {
      const divisionId = divisionIdByStageId.get(stageId);
      return divisionId === undefined ? undefined : schedule.entrantsOfDivision(divisionId);
    },
  });
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
  const entrantByDivisionPerson = new Map<string, string>();
  const discipline = makeDisciplineRoutesWorld({
    entrantForPerson: (divisionId, personId) => entrantByDivisionPerson.get(`${divisionId}|${personId}`),
    ...(opts.refuseLineupWrites === true ? { refuseEveryLineupWrite: true } : {}),
  });
  const oracleRoutes = makeOracleRoutesWorld({
    // Fix round 2 (R64) — the PRODUCT's post-sign-off truth: `match_states`
    // is the fold at the last row, and on a signed-off fixture that row is
    // core.finalize, which moves phase "done" -> "final".
    getFixtureModuleState: (fixtureId) =>
      statusById.get(fixtureId) === "finalized" ? { ...TINY_SPECIAL_STATE, phase: "final" } : TINY_SPECIAL_STATE,
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
    getPersonStats: (personId) => personStatsFromDivisions(personId, divisionCardSources()),
    getPersonCareerStats: (personId) => personCareerStatsFromDivisions(personId, divisionCardSources()),
    // T10 — the board a tap branch reads: `fixture_no` for the console URL,
    // `round_no` for the rounds, and the LIVE status the finalized oracle
    // judges. Read off the schedule world's own rows, never a literal.
    getDivisionFixtures: (divisionId) =>
      [...schedule.fixtures.values()]
        .filter((f) => f.division_id === divisionId)
        .map((f) => ({
          id: f.id,
          ext_key: f.ext_key,
          round_no: (opts.flattenRoundsOf ?? []).includes(divisionNameById.get(divisionId) ?? "") ? 1 : f.round_no,
          fixture_no: fixtureNoById.get(f.id) ?? null,
          status: statusById.get(f.id) ?? f.status ?? "scheduled",
          outcome: null,
        })),
  });
  const claims = makeClaimRoutesWorld();
  let competitionId: string | undefined;
  const news = makeNewsRoutesWorld({
    divisionOfFixture: (fixtureId) => fixtureDivisionId.get(fixtureId),
    competitionOfDivision: () => competitionId,
  });

  const mintFixture = (divisionId: string | undefined, extKey: string): { id: string; ext_key: string } => {
    const id = `fx-${++fixtureCounter}`;
    if (divisionId !== undefined) {
      fixtureDivisionId.set(id, divisionId);
      const no = (fixtureCountByDivision.get(divisionId) ?? 0) + 1;
      fixtureCountByDivision.set(divisionId, no);
      fixtureNoById.set(id, no);
    }
    return { id, ext_key: extKey };
  };

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
      // T10 — the competition read the console URL takes its slug from.
      if (method === "GET" && /^\/api\/v1\/competitions\/[^/]+$/.test(routePath)) {
        return { id: routePath.split("/")[4], slug: SERVER_COMPETITION_SLUG } as T;
      }
      const divisionsMatch = /^\/api\/v1\/competitions\/([^/]+)\/divisions$/.exec(routePath);
      if (method === "POST" && divisionsMatch !== null) {
        competitionId = divisionsMatch[1]!;
        const b = body as { name?: string; sport_key?: string };
        const id = `div-${++divisionCounter}`;
        if (b.name !== undefined) divisionNameById.set(id, b.name);
        if (b.sport_key !== undefined) divisionSportById.set(id, b.sport_key);
        return { id } as T;
      }
      const entrantsMatch = /^\/api\/v1\/divisions\/([^/]+)\/entrants$/.exec(routePath);
      if (method === "POST" && entrantsMatch !== null) {
        const rows = body as { display_name?: string; members?: { person_id?: string }[] }[];
        const out = rows.map((e, i) => ({ id: `entrant-${slug(e.display_name ?? String(i))}-${Math.random()}` }));
        rows.forEach((e, i) => {
          for (const m of e.members ?? []) {
            if (m.person_id !== undefined) entrantByDivisionPerson.set(`${entrantsMatch[1]!}|${m.person_id}`, out[i]!.id);
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
        const fixtures =
          kindByStageId.get(stageId) === "knockout"
            ? [mintFixture(divisionId, "se-r0-i0")]
            : Array.from(
                {
                  length: roundRobinRoundCount(
                    divisionId === undefined ? 0 : schedule.entrantsOfDivision(divisionId).length,
                    legsByStageId.get(stageId) ?? 1,
                  ),
                },
                (_v, i) => mintFixture(divisionId, `rr-r${i + 1}-c1`),
              );
        schedule.addFixtures(stageId, fixtures);
        return { fixtures } as unknown as T;
      }
      const scheduled = schedule.handle(method, routePath, body);
      if (scheduled !== undefined) return scheduled as T;
      if (method === "POST" && /^\/api\/v1\/divisions\/[^/]+\/officials\/auto$/.test(routePath)) {
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
      // T10 — the division read carries the SERVER's slug alongside D9's status.
      const divisionGet = phase.handleDivisionGet(method, routePath);
      if (divisionGet !== undefined) return { slug: `slug-${routePath.split("/")[4]}`, ...divisionGet } as T;
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
      news.observe(method, path, body);
      const newsRouted = news.handle(method, path, body);
      if (newsRouted !== undefined) return newsRouted;
      const claimAccepted = claims.handle(method, path);
      if (claimAccepted !== undefined) return claimAccepted;
      const started = phase.handleStart(method, path);
      if (started !== undefined) return started;
      const advanced = advanceRoutes.handle(method, path, body);
      if (advanced !== undefined) return advanced;
      const oracled = oracleRoutes.handle(method, path);
      if (oracled !== undefined) return oracled;
      const disciplined = discipline.handle(method, path, body);
      if (disciplined !== undefined) return disciplined;
      if (/^\/api\/v1\/divisions\/[^/]+\/events\/import$/.test(path)) {
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
      if (/^\/api\/v1\/divisions\/([^/]+)\/officials\/auto$/.test(path) && provisionedPlan === null) {
        return {
          status: 402,
          json: { ok: false, error: { code: "PAYMENT_REQUIRED", message: "nope", feature_key: "officials.auto" } } as never,
        };
      }
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
      if (method === "DELETE" && /^\/api\/v1\/fixtures\/[^/]+\/device-links\/[^/]+$/.test(path)) {
        return { status: 200, json: { ok: true, data: { id: "dl-1", revoked_at: "2026-09-14T12:00:00Z" } } as never };
      }
      // Fix round 2 (R64) — the product's ledger read, off what the POSTs stored.
      const ledgerRead = /^\/api\/v1\/fixtures\/([^/]+)\/events\?since_seq=(\d+)$/.exec(path);
      if (method === "GET" && ledgerRead !== null) {
        if (opts.refuseLedgerReads === true) {
          return { status: 500, json: { ok: false, error: { code: "INTERNAL", message: "ledger unavailable" } } as never };
        }
        const rows = (ledgerById.get(ledgerRead[1]!) ?? []).filter((r) => r.seq > Number(ledgerRead[2]));
        return {
          status: 200,
          json: {
            ok: true,
            data: rows.map((r) => ({
              ...r,
              recorded_at: "2026-09-14T12:00:00.000Z",
              recorded_by: "user-organiser",
              voids_event_id: null,
              device_link_id: null,
            })),
          } as never,
        };
      }
      const m = /^\/api\/v1\/fixtures\/([^/]+)\/events$/.exec(path);
      if (!m) throw new Error(`fake server: unhandled raw ${method} ${path}`);
      const { type, payload } = body as { type: string; payload: { target?: unknown; oversPerSide?: unknown } };
      if (type === "cricket.revise" && payload?.target === undefined && payload?.oversPerSide === undefined) {
        return {
          status: 422,
          json: { ok: false, error: { code: "INVALID_EVENT", message: "revise needs oversPerSide and/or target" } } as never,
        };
      }
      const ledger = ledgerById.get(m[1]!) ?? [];
      const seq = ledger.length + 1;
      ledger.push({ id: `ev-${m[1]!}-${seq}`, seq, type, payload });
      ledgerById.set(m[1]!, ledger);
      return { status: 201, json: { ok: true, data: { seq } } as never };
    },
  };

  const sql: PlanSql = {
    async entitlementRows(featureKey) {
      if (featureKey === "cricket.dls") {
        return [
          { plan_key: "community", bool_value: true },
          { plan_key: "pro", bool_value: true },
        ] satisfies PlanEntitlementRow[];
      }
      if (featureKey === "officials.auto") {
        return [
          { plan_key: "community", bool_value: false },
          { plan_key: "pro", bool_value: true },
        ] satisfies PlanEntitlementRow[];
      }
      if (featureKey === "scoring.device_links" && opts.deviceLinksSold) {
        return [
          { plan_key: "community", bool_value: false },
          { plan_key: "pro", bool_value: true },
        ] satisfies PlanEntitlementRow[];
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
    async getOrgSlug() {
      return "org-fixed-slug";
    },
  } as PlanSql;

  return {
    transport,
    sql,
    calls,
    setFixtureStatus: (fixtureId, status) => statusById.set(fixtureId, status),
    divisionNameOfFixture: (fixtureId) => {
      const divisionId = fixtureDivisionId.get(fixtureId);
      return divisionId === undefined ? undefined : divisionNameById.get(divisionId);
    },
  };
}

// ---------------------------------------------------------------------------
// The fake tap player — the PRODUCT side of a tapped match, as the seam sees
// it: every event lands on the fake server's own events route (so the folds
// the other oracles observe still happen), and the organiser's sign-off moves
// the fixture's live status to `finalized` — unless a knob says the product
// did not.
// ---------------------------------------------------------------------------
interface TapJobLike {
  readonly divisionRef: string;
  readonly fixtureExtKey: string;
  readonly fixtureId: string;
  readonly consolePath: string;
  readonly stream: {
    readonly home: string;
    readonly away: string;
    readonly events: readonly { readonly type: string; readonly payload?: unknown }[];
  };
  readonly refIdByKey: ReadonlyMap<string, string>;
}

interface FakeTapPlayerOptions {
  /** The organiser's sign-off never reaches the product: the fixture stays
   *  `decided`. The player itself reports no finding, so only the finalized
   *  oracle can see it. */
  skipFinalize?: boolean;
  findingsFor?: Readonly<Record<string, readonly string[]>>;
  observationsFor?: Readonly<Record<string, readonly string[]>>;
}

function fakeTapPlayer(world: ReturnType<typeof fakeServer>, opts: FakeTapPlayerOptions = {}) {
  const jobs: TapJobLike[] = [];
  const state = { inFlight: 0, maxInFlight: 0, created: 0, closed: 0 };
  const factory = async (ctx: { readonly base: string; readonly session: Session }) => {
    state.created += 1;
    return {
      async playFixture(job: TapJobLike) {
        jobs.push(job);
        state.inFlight += 1;
        state.maxInFlight = Math.max(state.maxInFlight, state.inFlight);
        // Yield long enough for every sibling the cap allows to start too.
        await new Promise((resolve) => setTimeout(resolve, 5));
        let seq = 0;
        for (const event of job.stream.events) {
          // Refs resolved exactly as the real pad writes them (ids, not `@refs`),
          // so a fold over the stored rows sees what the product would.
          await world.transport.raw(ctx.base, ctx.session, `/api/v1/fixtures/${job.fixtureId}/events`, "POST", {
            type: event.type,
            payload: resolvePayloadRefs(event.payload ?? {}, job.refIdByKey, "fake-tap-player"),
            expected_seq: seq,
          });
          seq += 1;
        }
        // The organiser's sign-off is a ROW on the ledger, after the pack's
        // own events — exactly what the real tap path appends (R64).
        if (opts.skipFinalize !== true) {
          await world.transport.raw(ctx.base, ctx.session, `/api/v1/fixtures/${job.fixtureId}/events`, "POST", {
            type: "core.finalize",
            payload: {},
            expected_seq: seq,
          });
        }
        world.setFixtureStatus(job.fixtureId, opts.skipFinalize === true ? "decided" : "finalized");
        state.inFlight -= 1;
        return {
          fixtureId: job.fixtureId,
          taps: job.stream.events.length + 1,
          wallMs: 7,
          findings: [...(opts.findingsFor?.[job.fixtureExtKey] ?? [])],
          observations: [...(opts.observationsFor?.[job.fixtureExtKey] ?? [])],
        };
      },
      async close() {
        state.closed += 1;
      },
    };
  };
  return { factory, jobs, state };
}

function tapInput(world: ReturnType<typeof fakeServer>, tapPlayer: ReturnType<typeof fakeTapPlayer>["factory"]) {
  return {
    base: "http://bench.example",
    engine: "optimized" as const,
    keep: false,
    log: silent,
    cliEntry: "admin" as const,
    transport: world.transport,
    sql: world.sql,
    probeTransport: world.transport,
    simTransport: world.transport,
    importTransport: world.transport,
    startTransport: world.transport,
    advanceTransport: world.transport,
    oracleTransport: world.transport,
    matchBoard: echoExpectedBoard,
    specialSubjects: echoSpecialSubjects,
    resolveOrgSlug: async () => "org-fixed-slug",
    tapPlayer,
  };
}

interface TinyStreamLike {
  divisionRef: string;
  fixtureExtKey: string;
  stageRef?: string;
  events: { type: string }[];
}

async function tinyStreams(): Promise<TinyStreamLike[]> {
  const raw = JSON.parse(await readFile(TINY_PACK_PATH, "utf8")) as { streams: TinyStreamLike[] };
  return raw.streams;
}

function inputWhereFinalizeIsSkipped() {
  const world = fakeServer({ deviceLinksSold: true });
  return { input: tapInput(world, fakeTapPlayer(world, { skipFinalize: true }).factory) };
}

function inputWithTappedDivision() {
  const world = fakeServer({ deviceLinksSold: true });
  const player = fakeTapPlayer(world);
  return { input: tapInput(world, player.factory), player };
}

describe("tap mode — the organiser signs a tapped fixture off (B07a T10)", () => {
  it("requires a tapped fixture to reach finalized, not merely decided", async () => {
    const report = await runPackSuite(inputWhereFinalizeIsSkipped().input, {
      suiteKey: "fixture",
      packPath: FIXTURE_PACK_PATH,
      play: TAP_D_TINY,
    });
    expect(report.gate).toBe("red");
    expect(report.errors?.join(" ")).toContain("finalized");
  });

  it("counts taps and wall time without gating on them", async () => {
    const { input, player } = inputWithTappedDivision();
    const report = await runPackSuite(input, { suiteKey: "fixture", packPath: FIXTURE_PACK_PATH, play: TAP_D_TINY });
    expect((report.errors ?? []).join("\n")).toBe("");
    expect(report.gate).toBe("green");
    expect(report.tapPlay?.taps).toBeGreaterThan(0);
    // Derived from the pack: every d-tiny stream (both stages) is one tapped
    // match, and the fake counts its events plus the organiser's sign-off.
    const dTiny = (await tinyStreams()).filter((s) => s.divisionRef === "d-tiny");
    expect(dTiny.length).toBeGreaterThan(0);
    expect(player.jobs.map((j) => j.fixtureExtKey).sort()).toEqual(dTiny.map((s) => s.fixtureExtKey).sort());
    expect(report.tapPlay?.matches).toBe(dTiny.length);
    expect(report.tapPlay?.taps).toBe(dTiny.reduce((n, s) => n + s.events.length + 1, 0));
    expect(typeof report.tapPlay?.wallMs).toBe("number");
    // The player owns a real browser: created once for the run, closed once.
    expect(player.state.created).toBe(1);
    expect(player.state.closed).toBe(1);
  });
});

describe("the `_tiny` registry row declares d-tiny tapped (B07a T10)", () => {
  it("d-tiny is tap, and d-badminton keeps the import path's coverage", async () => {
    const row = lookupSuite("_tiny");
    expect(row?.play).toEqual({ "d-tiny": "tap" });
    // Index from the pack itself, never a literal: the positional default is
    // what keeps d-badminton on the import path.
    const pack = JSON.parse(await readFile(TINY_PACK_PATH, "utf8")) as { divisions: { ref: string }[] };
    const badmintonIndex = pack.divisions.findIndex((d) => d.ref === "d-badminton");
    expect(badmintonIndex).toBeGreaterThan(0);
    expect(playModeFor(row ?? {}, "d-badminton", badmintonIndex)).toBe("import");
    expect(playModeFor(row ?? {}, "d-tiny", pack.divisions.findIndex((d) => d.ref === "d-tiny"))).toBe("tap");
  });
});

describe("tap mode — what gates, and what is only reported (B07a T10)", () => {
  it("a driver finding reds the gate, named with its division and fixture", async () => {
    const world = fakeServer({ deviceLinksSold: true });
    const finding = "tap: event 1 (generic.score) failed — the half never mounted";
    const player = fakeTapPlayer(world, { findingsFor: { "rr-r2-c1": [finding] } });
    const report = await runPackSuite(tapInput(world, player.factory), {
      suiteKey: "fixture",
      packPath: FIXTURE_PACK_PATH,
      play: TAP_D_TINY,
    });
    expect(report.gate).toBe("red");
    expect(report.errors).toContain(`tap: d-tiny/rr-r2-c1: ${finding}`);
  });

  it("observations are counted in tapPlay and never red the gate", async () => {
    const world = fakeServer({ deviceLinksSold: true });
    const player = fakeTapPlayer(world, {
      observationsFor: { "rr-r1-c1": ["a burst made a status unjudgeable", "a tolerated person key"], "se-r0-i0": ["a hold released itself"] },
    });
    const report = await runPackSuite(tapInput(world, player.factory), {
      suiteKey: "fixture",
      packPath: FIXTURE_PACK_PATH,
      play: TAP_D_TINY,
    });
    expect((report.errors ?? []).join("\n")).toBe("");
    expect(report.gate).toBe("green");
    expect(report.tapPlay?.observations).toBe(3);
  });

  it("a plan without scoring.device_links is a loud warning naming every unplayed tap fixture — never silent, never counted", async () => {
    const world = fakeServer({ deviceLinksSold: false });
    const player = fakeTapPlayer(world);
    const report = await runPackSuite(tapInput(world, player.factory), {
      suiteKey: "fixture",
      packPath: FIXTURE_PACK_PATH,
      play: TAP_D_TINY,
    });
    const warnings = (report.warnings ?? []).join("\n");
    expect(warnings).toContain('WARNING — division "d-tiny" declares play "tap"');
    expect(warnings).toContain("scoring.device_links");
    const dTiny = (await tinyStreams()).filter((s) => s.divisionRef === "d-tiny");
    expect(dTiny.length).toBeGreaterThan(0);
    for (const st of dTiny) expect(warnings).toContain(st.fixtureExtKey);
    expect(player.state.created).toBe(0);
    expect(player.jobs).toEqual([]);
    expect(report.tapPlay).toBeUndefined();
  });

  it("plays no more matches of one round at once than the division has courts", async () => {
    const pack = JSON.parse(await readFile(TINY_PACK_PATH, "utf8")) as {
      divisions: { ref: string; name: string; scheduleConfig?: { courts?: unknown[] }; stages: { ref: string }[] }[];
    };
    const division = pack.divisions.find((d) => d.ref === "d-tiny");
    const courts = division?.scheduleConfig?.courts?.length ?? 0;
    const firstStageRef = division?.stages[0]?.ref;
    const firstStage = (await tinyStreams()).filter(
      (s) => s.divisionRef === "d-tiny" && (s.stageRef === undefined || s.stageRef === firstStageRef),
    );
    // The differential only exists when the one round holds MORE matches than
    // there are courts, and the court count is neither 1 nor the match count:
    // a cap hard-coded to 1, or no cap at all, must each read differently.
    expect(courts).toBeGreaterThan(1);
    expect(firstStage.length).toBeGreaterThan(courts);

    const world = fakeServer({ deviceLinksSold: true, flattenRoundsOf: [division?.name ?? ""] });
    const player = fakeTapPlayer(world);
    const report = await runPackSuite(tapInput(world, player.factory), {
      suiteKey: "fixture",
      packPath: FIXTURE_PACK_PATH,
      play: TAP_D_TINY,
    });
    expect((report.errors ?? []).join("\n")).toBe("");
    expect(player.state.maxInFlight).toBe(courts);
  });
});

describe("tap mode — a tapped fixture's team sheets are SETUP, saved before the scorer taps (fix round 2, R62)", () => {
  it("PUTs each side's sheet of its OWN seeded members through the lineups route, before that fixture's first tap", async () => {
    const world = fakeServer({ deviceLinksSold: true });
    const player = fakeTapPlayer(world);
    const report = await runPackSuite(tapInput(world, player.factory), {
      suiteKey: "fixture",
      packPath: FIXTURE_PACK_PATH,
      play: TAP_D_TINY,
    });
    expect((report.errors ?? []).join("\n")).toBe("");
    // Members from the PACK's rosters (what the bench seeds as entrant
    // members), never a literal — and the two d-tiny sides differ, so a sheet
    // built from the wrong entrant cannot read the same.
    const pack = JSON.parse(await readFile(TINY_PACK_PATH, "utf8")) as {
      entrants: { ref: string; roster: { person: string }[] }[];
    };
    const membersOf = (ref: string) => pack.entrants.find((e) => e.ref === ref)?.roster.map((m) => m.person) ?? [];
    const dTiny = (await tinyStreams()).filter((s) => s.divisionRef === "d-tiny");
    expect(player.jobs.map((j) => j.fixtureExtKey).sort()).toEqual(dTiny.map((s) => s.fixtureExtKey).sort());
    for (const job of player.jobs) {
      const firstTap = world.calls.findIndex(
        (c) => c.method === "POST" && c.path === `/api/v1/fixtures/${job.fixtureId}/events`,
      );
      expect(firstTap, job.fixtureExtKey).toBeGreaterThan(-1);
      const sides = [job.stream.home, job.stream.away];
      expect(new Set(sides.map(membersOf).map((m) => m.join(","))).size, job.fixtureExtKey).toBe(2);
      for (const sideRef of sides) {
        const members = membersOf(sideRef);
        expect(members.length, `${job.fixtureExtKey} ${sideRef}`).toBeGreaterThan(0);
        const entrantId = job.refIdByKey.get(sideRef);
        expect(entrantId, `${job.fixtureExtKey} ${sideRef}`).toBeDefined();
        const puts = world.calls
          .map((c, i) => ({ c, i }))
          .filter(({ c }) => c.method === "PUT" && c.path === `/api/v1/fixtures/${job.fixtureId}/lineups/${entrantId}`);
        expect(puts.length, `${job.fixtureExtKey} ${sideRef}`).toBe(1);
        expect(puts[0]!.i, `${job.fixtureExtKey} ${sideRef} saved before the first tap`).toBeLessThan(firstTap);
        expect(puts[0]!.c.body).toEqual({
          slots: members.map((ref, i) => ({ person_id: job.refIdByKey.get(ref), slot: "starting", order_no: i + 1 })),
        });
      }
    }
  });
});

describe("tap mode — a special's state claim describes the STREAM, never the sign-off (fix round 2, R64)", () => {
  it("judges rr-r3's phase on the product's rows through the last pack event, while /state reads the signed-off 'final'", async () => {
    const world = fakeServer({ deviceLinksSold: true });
    const player = fakeTapPlayer(world);
    // The REAL specials path: no echoed subjects.
    const input = { ...tapInput(world, player.factory), specialSubjects: undefined };
    const report = await runPackSuite(input, { suiteKey: "fixture", packPath: FIXTURE_PACK_PATH, play: TAP_D_TINY });
    const specials = (report.oracles ?? []).filter((o) => o.name === "oracle: specials");
    expect(specials.map((o) => [o.verdict, o.passed, o.detail])).toEqual([["pass", true, expect.stringContaining("claim(s) checked")]]);
    expect((report.errors ?? []).join("\n")).toBe("");

    const rr3 = player.jobs.find((j) => j.fixtureExtKey === "rr-r3-c1");
    expect(rr3).toBeDefined();
    // The run never read the signed-off state for the tapped special…
    expect(world.calls.some((c) => c.path === `/api/v1/fixtures/${rr3!.fixtureId}/state`)).toBe(false);
    // Control 1 — the product's stored state IS post-sign-off here, so a
    // claim judged off /state would have read "final".
    const stateRead = await world.transport.raw(
      "http://bench.example",
      {} as Session,
      `/api/v1/fixtures/${rr3!.fixtureId}/state`,
      "GET",
    );
    expect((stateRead.json as unknown as { data: { state: { phase: string } } }).data.state.phase).toBe("final");
    // Control 2 — the ledger that was folded ends in the sign-off row.
    const posted = world.calls
      .filter((c) => c.method === "POST" && c.path === `/api/v1/fixtures/${rr3!.fixtureId}/events`)
      .map((c) => (c.body as { type: string }).type);
    expect(posted.at(-1)).toBe("core.finalize");
    expect(
      world.calls.some((c) => c.method === "GET" && c.path === `/api/v1/fixtures/${rr3!.fixtureId}/events?since_seq=0`),
    ).toBe(true);
  });

  it("a tapped special whose ledger cannot be read reds, named — and is never judged off /state instead", async () => {
    const world = fakeServer({ deviceLinksSold: true, refuseLedgerReads: true });
    const player = fakeTapPlayer(world);
    const input = { ...tapInput(world, player.factory), specialSubjects: undefined };
    const report = await runPackSuite(input, { suiteKey: "fixture", packPath: FIXTURE_PACK_PATH, play: TAP_D_TINY });
    const rr3 = player.jobs.find((j) => j.fixtureExtKey === "rr-r3-c1");
    expect(rr3).toBeDefined();
    expect(report.gate).toBe("red");
    expect(report.errors).toContain(
      "oracle: specials: d-tiny/rr-r3-c1 was tapped, and its state through the pack's own events could not be folded — " +
        `special state: the ledger read /api/v1/fixtures/${rr3!.fixtureId}/events?since_seq=0 answered HTTP 500 ` +
        "(never judged off the signed-off /state)",
    );
    expect(world.calls.some((c) => c.path === `/api/v1/fixtures/${rr3!.fixtureId}/state`)).toBe(false);
    const specials = (report.oracles ?? []).filter((o) => o.name === "oracle: specials");
    expect(specials.map((o) => o.verdict)).toEqual(["fail"]);
  });
});

describe("tap mode — a refused team sheet is a finding that reds (fix round 2, R62)", () => {
  it("names the division, fixture, side and the product's refusal", async () => {
    const world = fakeServer({ deviceLinksSold: true, refuseLineupWrites: true });
    const player = fakeTapPlayer(world);
    const report = await runPackSuite(tapInput(world, player.factory), {
      suiteKey: "fixture",
      packPath: FIXTURE_PACK_PATH,
      play: TAP_D_TINY,
    });
    expect(report.gate).toBe("red");
    const errors = report.errors ?? [];
    const lineupErrors = errors.filter((e) => e.startsWith("tap: d-tiny/") && e.includes(": lineup: "));
    // Two sides for every tapped d-tiny fixture, each refused.
    const dTiny = (await tinyStreams()).filter((s) => s.divisionRef === "d-tiny");
    expect(lineupErrors).toHaveLength(dTiny.length * 2);
    expect(errors).toContain(
      'tap: d-tiny/rr-r1-c1: lineup: saving the home sheet for "e-alpha" answered HTTP 422 SUSPENDED_PLAYER ' +
        "— its players cannot be named on the pad",
    );
  });
});
