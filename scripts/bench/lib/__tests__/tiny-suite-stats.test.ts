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
import { makeOracleRoutesWorld, tinyDivisionPlayerStats, tinyLeagueTableRows } from "./_oracle-routes.ts";
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

function fakeServer(opts: { statsPlayerGranted: boolean }): {
  transport: ProbeTransport;
  sql: PlanSql;
  calls: RecordedCall[];
} {
  const calls: RecordedCall[] = [];
  const dlsByDivisionId = new Map<string, boolean>();
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
  const fixtureDivisionId = new Map<string, string>();
  const fixtureOfficials = new Map<string, unknown[]>();
  const claimInvites = new Map<string, unknown>();
  let divisionCounter = 0;
  let stageCounter = 0;
  let fixtureCounter = 0;
  let entitled = false;

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
  const oracleRoutes = makeOracleRoutesWorld({
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
    // B05 T5b — keyed by division NAME so BOTH leaderboard divisions the pack
    // now names (`Tiny` and, since T5b-1, `Tiebreak`) are answered; a name
    // this pack declares no leaderboard for still falls through to
    // `undefined` exactly as before.
    getDivisionPlayerStats: (divisionId) => {
      const divisionName = divisionNameById.get(divisionId);
      if (divisionName === undefined) return undefined;
      return tinyDivisionPlayerStats(divisionName, (fullName) => `person-${slug(fullName)}`);
    },
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
      if (method === "POST" && /^\/api\/v1\/competitions\/[^/]+\/divisions$/.test(routePath)) {
        const b = body as { name?: string; config?: { dls?: { enabled?: boolean } } };
        const id = `div-${++divisionCounter}`;
        dlsByDivisionId.set(id, b.config?.dls?.enabled === true);
        if (b.name !== undefined) divisionNameById.set(id, b.name);
        return { id } as T;
      }
      const entrantsMatch = /^\/api\/v1\/divisions\/([^/]+)\/entrants$/.exec(routePath);
      if (method === "POST" && entrantsMatch !== null) {
        const rows = body as { display_name?: string }[];
        const out = rows.map((e, i) => ({
          id: `entrant-${slug(e.display_name ?? String(i))}-${Math.random()}`,
        }));
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
      const inviteMatch = /^\/api\/v1\/officials\/([^/]+)\/invite$/.exec(routePath);
      if (method === "POST" && inviteMatch) {
        const officialId = inviteMatch[1]!;
        const personId = `invited-${officialId}`;
        const row = { id: personId, person_id: personId, claimed_at: null, revoked_at: null };
        claimInvites.set(personId, row);
        return { person_id: personId } as T;
      }
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
      if (method === "POST" && /^\/api\/v1\/persons\/[^/]+\/claim-invites$/.test(routePath)) {
        const personId = routePath.split("/")[4]!;
        const row = { person_id: personId, claimed_at: null, revoked_at: null };
        claimInvites.set(personId, row);
        return row as T;
      }
      if (method === "GET" && /^\/api\/v1\/persons\/[^/]+\/claim-invites$/.test(routePath)) {
        const personId = routePath.split("/")[4]!;
        return (claimInvites.get(personId) ?? null) as T;
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
        entitled = true;
        return { ok: true } as unknown as T;
      }
      if (method === "DELETE" && /^\/api\/admin\/orgs\/[^/]+\/entitlement-override$/.test(routePath)) {
        return { ok: true } as unknown as T;
      }
      throw new Error(`fake server: unhandled ${method} ${routePath}`);
    },
    async raw(_base, _s, path, method = "GET", body): Promise<RawResult> {
      calls.push({ method, path, body });
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
      const m = /^\/api\/v1\/fixtures\/([^/]+)\/events$/.exec(path);
      if (!m) throw new Error(`fake server: unhandled raw ${method} ${path}`);
      const fixtureId = m[1]!;
      const divisionId = fixtureDivisionId.get(fixtureId);
      const dlsEnabled = divisionId !== undefined && dlsByDivisionId.get(divisionId) === true;
      const { type, payload } = body as { type: string; payload: { target?: unknown } };
      const manualTarget = payload?.target !== undefined;
      const requiresDls = type === "cricket.revise" && dlsEnabled && !manualTarget;
      if (requiresDls && !entitled) {
        return {
          status: 402,
          json: { ok: false, error: { code: "PAYMENT_REQUIRED", message: "nope", feature_key: "cricket.dls" } } as never,
        };
      }
      return { status: 201, json: { ok: true, data: { seq: 1 } } as never };
    },
  };

  const sql: PlanSql = {
    async entitlementRows(featureKey) {
      if (featureKey === "cricket.dls") {
        return [
          { plan_key: "community", bool_value: false },
          { plan_key: "pro", bool_value: true },
        ] satisfies PlanEntitlementRow[];
      }
      if (featureKey === "officials.auto") {
        return [{ plan_key: "community", bool_value: false }, { plan_key: "pro", bool_value: false }] satisfies PlanEntitlementRow[];
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
    async updateSubscriptionPlan() {},
    async createSubscriptionForOrg() {
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
    });

    expect(report.gate).toBe("green");
    expect(calls.some((c) => c.method === "GET" && c.path === "/api/orgs")).toBe(false);
    // NOT `/stats/players` (B05 T4b now calls that route independently, via
    // `raw()`, for the leaderboard oracle — unconditionally, regardless of
    // this `statsPlayerGranted` knob, which only gates B03 T6b's OWN
    // `request()`-based baseline read). `/persons/{id}/stats` stays a clean
    // discriminator: only the baseline ever calls it.
    expect(calls.some((c) => c.method === "GET" && /^\/api\/v1\/persons\/[^/]+\/stats(\?|$)/.test(c.path))).toBe(
      false,
    );
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
