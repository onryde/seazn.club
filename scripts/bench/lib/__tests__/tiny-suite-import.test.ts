// B05 T2 — proves `runTinySuite` actually DRIVES division B's own streams
// through the batch-import route end to end against the REAL committed
// `_tiny.json` pack: removing the
// `if (input.sql !== undefined) { ... importDivisionStreams(...) ... }`
// block in `lib/suites/tiny.ts` reds a test here (AGENTS.md recurring-
// failure class 1 — "the inert seam", the same class T1's own
// `tiny-suite-simulate.test.ts` closes for division A). `import.ts`'s own
// unit suite (`import.test.ts`) already covers chunking, caps, idempotency
// and refusal handling exhaustively — this file's only job is proving the
// WIRING actually reaches it on a `_tiny`-shaped run, never merely that it
// is reachable in principle.
//
// A fresh, self-contained fake — same "minimize blast radius outside what
// THIS task owns" precedent `tiny-suite-simulate.test.ts`'s own header
// comment gives (which is itself `tiny-suite-stats.test.ts`'s `fakeServer`
// copied verbatim). This one is THAT fake copied verbatim, with exactly one
// addition: a `refuseImportWith` knob on `raw()`'s `/events/import` branch,
// so one test can prove a call-level refusal actually reaches
// `report.errors`/`report.gate`, never a silent skip or retry.
import { describe, expect, it } from "vitest";
import pino from "pino";
import type { RawResult, Session } from "../http.ts";
import type { ProbeTransport } from "../dls-gate.ts";
import type { PlanEntitlementRow, PlanSql } from "../plan.ts";
import { runTinySuite, TINY_PACK_PATH } from "../suites/tiny.ts";
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

function fakeServer(opts: { refuseImportWith?: { status: number; code: string; message: string } } = {}): {
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
  const fixtureExtKeyById = new Map<string, string>();
  const fixtureOfficials = new Map<string, unknown[]>();
  const claimInvites = new Map<string, unknown>();
  let divisionCounter = 0;
  let stageCounter = 0;
  let fixtureCounter = 0;
  let entitled = false;

  const schedule = makeScheduleWorld({ solverEngine: "optimized" });
  // B05 T2.5 (D9) — see `_division-phase.ts`'s own header comment: EVERY
  // `sql`-passing fake now reaches `/start`/`GET /divisions/{id}`
  // unconditionally, and phase-gating `/events/import` here is what makes
  // this file's own "clean fold" assertions a real regression against the
  // start step being wired in.
  const phase = makeDivisionPhaseWorld();
  // B05 T3 — see `_advance-routes.ts`'s own header comment: EVERY
  // `sql`-passing fake now reaches the advancement routes unconditionally,
  // because `_tiny.json`'s own `s-playoff` always declares a `progression`.
  // This file is not ABOUT advancement; it exists so this file's OWN
  // "clean fold, gate green" assertions stay green rather than reddening on
  // an unmodeled route.
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
    getDivisionPlayerStats: (divisionId) => {
      if (divisionNameById.get(divisionId) !== "Tiny") return undefined;
      return tinyDivisionPlayerStats((fullName) => `person-${slug(fullName)}`);
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
      if (method === "GET" && /^\/api\/v1\/divisions\/[^/]+$/.test(routePath)) {
        // B05 T2.5 — `status` is D9's own RE-READ; `slug` is unrelated
        // scaffolding no production call site actually reads.
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
      // B05 T2's own addition: division B's batch-import fold. Refuses the
      // WHOLE call when `opts.refuseImportWith` is set (so a wiring test can
      // prove a call-level refusal reaches `report.errors`/`report.gate`,
      // never a silent skip or retry); otherwise every stream in the call
      // reports "imported".
      const importMatch = /^\/api\/v1\/divisions\/([^/]+)\/events\/import$/.exec(path);
      if (importMatch) {
        const importDivisionId = importMatch[1]!;
        // B05 T2.5 (D9) — the phase gate `usecases/event-import.ts:704`
        // enforces: this is what proves `runDivisionStartLayer` actually ran
        // BEFORE this fold, not merely that the function exists. Checked
        // BEFORE `opts.refuseImportWith` — a caller that wants to test the
        // call-refused-finding path never needs to also start the division
        // first, since `fakeServer()` (no overrides) already does.
        const phaseRefused = phase.refuseUnlessStarted(importDivisionId, "import");
        if (phaseRefused !== undefined) return phaseRefused;
        if (opts.refuseImportWith !== undefined) {
          const { status, code, message } = opts.refuseImportWith;
          return { status, json: { ok: false, error: { code, message } } as never };
        }
        const sent = (body as { streams: { fixture: { id: string }; events: unknown[] }[] }).streams;
        return {
          status: 200,
          json: {
            ok: true,
            data: {
              importId: (body as { import_id: string }).import_id,
              totals: { imported: sent.length, skipped: 0, rejected: 0 },
              results: sent.map((row) => ({
                fixture: row.fixture.id,
                status: "imported",
                eventsAppended: row.events.length,
              })),
            },
          } as never,
        };
      }
      const m = /^\/api\/v1\/fixtures\/([^/]+)\/events$/.exec(path);
      if (!m) throw new Error(`fake server: unhandled raw ${method} ${path}`);
      const fixtureId = m[1]!;
      const divisionId = fixtureDivisionId.get(fixtureId);
      const dlsEnabled = divisionId !== undefined && dlsByDivisionId.get(divisionId) === true;
      const { type, payload, expected_seq } = body as { type: string; payload: { target?: unknown }; expected_seq: number };
      // B05 T2.5 (D9) — same scoping-away-from-cricket.* reasoning as
      // `tiny-suite-simulate.test.ts`'s own identical comment: the DLS-gate
      // probe's own throwaway division is never started by this run, and its
      // probe cells must reach the ENTITLEMENT door, not this phase door.
      // This file drives no division-A scoring calls of its own, but the DLS
      // probe's unconditional cells still hit this same route.
      if (divisionId !== undefined && !type.startsWith("cricket.")) {
        const phaseRefused = phase.refuseUnlessStarted(divisionId, "scoring");
        if (phaseRefused !== undefined) return phaseRefused;
      }
      const manualTarget = payload?.target !== undefined;
      const requiresDls = type === "cricket.revise" && dlsEnabled && !manualTarget;
      if (requiresDls && !entitled) {
        return {
          status: 402,
          json: { ok: false, error: { code: "PAYMENT_REQUIRED", message: "nope", feature_key: "cricket.dls" } } as never,
        };
      }
      return { status: 201, json: { ok: true, data: { seq: expected_seq + 1 } } as never };
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
    async updateSubscriptionPlan() {},
    async createSubscriptionForOrg() {
      return "sub-new";
    },
    async setOwnerStaff() {},
    async setDivisionActive() {},
  };

  return { transport, sql, calls };
}

/** Every `POST .../events/import` call. */
function importPostCalls(calls: RecordedCall[]): RecordedCall[] {
  return calls.filter((c) => c.method === "POST" && /^\/api\/v1\/divisions\/[^/]+\/events\/import$/.test(c.path));
}

describe("runTinySuite — B05 T2 division-B stream fold wiring", () => {
  it("drives a real POST for division B's own stream and reports a populated importSimulation section", async () => {
    const { transport, sql, calls } = fakeServer();

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
    });

    expect(report.gate).toBe("green");
    // B05 T2.5 (D9) — both `_tiny.json`'s streamed divisions were started and
    // RE-READ as active BEFORE either fold ran — this is the whole reason
    // the import call below succeeded rather than 409ing against the fake's
    // own phase gate.
    expect(report.divisionStart).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ divisionRef: "d-tiny", started: true, confirmedStatus: "active" }),
        expect.objectContaining({ divisionRef: "d-badminton", started: true, confirmedStatus: "active" }),
      ]),
    );
    // `_tiny.json`'s division B (`d-badminton`) declares ONE stream with 76
    // events. B05 T5a added a THIRD streamed division (`d-tiebreak`, 3
    // streams of 2 events each — 6 total), which the SAME "every OTHER
    // division" import fold covers with no code change (`lib/suites/
    // tiny.ts`'s own comment: "grouped by divisionRef... so a future pack
    // adding a third streamed division folds it too") — so this now sends
    // TWO import POSTs, one per division, never re-grouped into one.
    // Asserted against what the pack ACTUALLY sent, never a constant typed
    // into this test a second time.
    const calls2 = importPostCalls(calls);
    expect(calls2).toHaveLength(2);
    const eventCounts = calls2
      .map((c) => (c.body as { streams: { events: unknown[] }[] }).streams)
      .map((streams) => streams.reduce((sum, st) => sum + st.events.length, 0))
      .sort((a, b) => a - b);
    expect(eventCounts).toEqual([6, 76]);
    // `/start` happens BEFORE the import POST — never the other way around.
    const firstStartIdx = calls.findIndex((c) => c.method === "POST" && /\/start$/.test(c.path));
    const firstImportIdx = calls.findIndex((c) => c.method === "POST" && /\/events\/import$/.test(c.path));
    expect(firstStartIdx).toBeGreaterThan(-1);
    expect(firstImportIdx).toBeGreaterThan(firstStartIdx);

    expect(report.importSimulation).toBeDefined();
    expect(report.importSimulation?.eventsSent).toBe(82);
    expect(report.importSimulation?.chunks).toBe(2);
    expect(report.importSimulation?.findings ?? []).toHaveLength(0);
    expect(report.timings.importMs).toBeDefined();
  });

  it("without `sql`, the import fold never runs — no import calls, no importSimulation section", async () => {
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
    expect(importPostCalls(calls)).toHaveLength(0);
    expect(report.importSimulation).toBeUndefined();
  });

  it("a deliberate call-level refusal reaches report.errors and reds the gate — never silently retried", async () => {
    const { transport, sql, calls } = fakeServer({
      refuseImportWith: { status: 409, code: "import.concurrent", message: "another import with this import_id is already running for this division" },
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
    });

    expect(report.gate).toBe("red");
    expect((report.errors ?? []).some((e) => e.includes("import.concurrent"))).toBe(true);
    // B05 T5a — the knob refuses EVERY `/events/import` call unconditionally,
    // and there are now TWO (d-badminton, d-tiebreak — the same "every OTHER
    // division" fold the test above names), so both refuse.
    expect(report.importSimulation?.findings).toHaveLength(2);
    for (const finding of report.importSimulation?.findings ?? []) {
      expect(finding).toMatchObject({ kind: "call_refused", code: "import.concurrent", status: 409 });
    }
    expect(report.importSimulation?.eventsSent).toBe(0);

    // Never retried: exactly one import POST per division, for the one
    // chunk each division's own streams needed.
    expect(importPostCalls(calls)).toHaveLength(2);
  });
});
