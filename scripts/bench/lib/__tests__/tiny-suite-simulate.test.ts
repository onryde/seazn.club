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
import { describe, expect, it } from "vitest";
import pino from "pino";
import type { RawResult, Session } from "../http.ts";
import type { ProbeTransport } from "../dls-gate.ts";
import type { PlanEntitlementRow, PlanSql } from "../plan.ts";
import { runTinySuite, TINY_PACK_PATH } from "../suites/tiny.ts";
import { makeScheduleWorld } from "./_schedule-routes.ts";

const silent = pino({ level: "silent" });

interface RecordedCall {
  readonly method: string;
  readonly path: string;
  readonly body: unknown;
}

function slug(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "");
}

function fakeServer(opts: { conflictAt?: { extKey: string; expectedSeq: number } } = {}): {
  transport: ProbeTransport;
  sql: PlanSql;
  calls: RecordedCall[];
} {
  const calls: RecordedCall[] = [];
  const dlsByDivisionId = new Map<string, boolean>();
  const legsByStageId = new Map<string, number>();
  const divisionIdByStageId = new Map<string, string>();
  const fixtureDivisionId = new Map<string, string>();
  const fixtureExtKeyById = new Map<string, string>();
  const fixtureOfficials = new Map<string, unknown[]>();
  const claimInvites = new Map<string, unknown>();
  let divisionCounter = 0;
  let stageCounter = 0;
  let fixtureCounter = 0;
  let entitled = false;

  const schedule = makeScheduleWorld({ solverEngine: "optimized" });

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
        const b = body as { config?: { dls?: { enabled?: boolean } } };
        const id = `div-${++divisionCounter}`;
        dlsByDivisionId.set(id, b.config?.dls?.enabled === true);
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
        const stagesBody = body as { config?: { legs?: number } }[];
        return stagesBody.map((st) => {
          const id = `stage-${++stageCounter}`;
          legsByStageId.set(id, (st.config?.legs as number | undefined) ?? 1);
          divisionIdByStageId.set(id, divisionId);
          schedule.addStage(id, divisionId);
          return { id };
        }) as unknown as T;
      }
      if (method === "POST" && /^\/api\/v1\/stages\/[^/]+\/generate$/.test(routePath)) {
        const stageId = routePath.split("/")[4]!;
        const legs = legsByStageId.get(stageId) ?? 1;
        const divisionId = divisionIdByStageId.get(stageId);
        const fixtures = Array.from({ length: legs }, (_v, i) => {
          const id = `fx-${++fixtureCounter}`;
          if (divisionId !== undefined) fixtureDivisionId.set(id, divisionId);
          const extKey = `rr-r${i + 1}-c1`;
          fixtureExtKeyById.set(id, extKey);
          return { id, ext_key: extKey };
        });
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
        return { slug: `slug-${routePath.split("/")[4]}` } as T;
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
      // B05 T2 — division B's own streams (`d-badminton`) fold through THIS
      // route unconditionally whenever `sql` is present, same gating as
      // division A's single-event fold this file is actually about. Handled
      // here as a plain pass-through so THIS file's own division-A
      // assertions stay green; the import path's own wiring/behaviour is
      // covered by `tiny-suite-import.test.ts`.
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
      const { type, payload, expected_seq } = body as { type: string; payload: { target?: unknown }; expected_seq: number };
      const manualTarget = payload?.target !== undefined;
      const requiresDls = type === "cricket.revise" && dlsEnabled && !manualTarget;
      if (requiresDls && !entitled) {
        return {
          status: 402,
          json: { ok: false, error: { code: "PAYMENT_REQUIRED", message: "nope", feature_key: "cricket.dls" } } as never,
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
    });

    expect(report.gate).toBe("green");
    // `_tiny.json`'s division A (`d-tiny`) declares 3 streams with 2, 5 and 2
    // events — 9 total. Asserted against what the pack ACTUALLY sent (call
    // count), never a constant typed into this test a second time.
    const eventCalls = divisionAEventCalls(calls);
    expect(eventCalls).toHaveLength(9);
    // And in strictly ascending expected_seq PER FIXTURE — grouped by path
    // (== fixture), each fixture's own sequence starts at 0 and increments.
    const byFixture = new Map<string, number[]>();
    for (const c of eventCalls) {
      const seqs = byFixture.get(c.path) ?? [];
      seqs.push((c.body as { expected_seq: number }).expected_seq);
      byFixture.set(c.path, seqs);
    }
    expect(byFixture.size).toBe(3);
    for (const seqs of byFixture.values()) {
      expect(seqs).toEqual(seqs.map((_v, i) => i));
    }

    expect(report.simulation).toBeDefined();
    expect(report.simulation?.eventsSent).toBe(9);
    expect(report.simulation?.findings ?? []).toHaveLength(0);
    expect(report.timings.simMs).toBeDefined();
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
});
