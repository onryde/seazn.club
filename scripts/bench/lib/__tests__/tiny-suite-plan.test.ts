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
  officialsAutoGranted: boolean;
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
  const dlsByDivisionId = new Map<string, boolean>();
  const legsByStageId = new Map<string, number>();
  const divisionIdByStageId = new Map<string, string>();
  const fixtureDivisionId = new Map<string, string>();
  const fixtureOfficials = new Map<string, unknown[]>();
  const claimInvites = new Map<string, unknown>();
  let divisionCounter = 0;
  let stageCounter = 0;
  let fixtureCounter = 0;
  let entitled = false;
  const sqlCalls: string[] = [];

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
          return { id, ext_key: `rr-r${i + 1}-c1` };
        });
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
      sqlCalls.push(`entitlementRows(${featureKey})`);
      if (featureKey === "cricket.dls") {
        return [
          { plan_key: "community", bool_value: false },
          { plan_key: "pro", bool_value: true },
        ] satisfies PlanEntitlementRow[];
      }
      if (featureKey === "officials.auto") {
        return [
          { plan_key: "community", bool_value: false },
          { plan_key: "pro", bool_value: opts.officialsAutoGranted },
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
    async updateSubscriptionPlan() {},
    async createSubscriptionForOrg() {
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
    });

    expect(report.gate).toBe("green");
    expect(report.oracles).toBeDefined();
    // Scoped to the entitlement-gate's own 5 cells — `report.oracles` also
    // carries B03 T6b's officials-claim-invite oracles now (unconditional,
    // proved separately below and in tiny-suite.test.ts), which this test
    // does not own.
    const gateOracles = (report.oracles ?? []).filter((o) => o.name.startsWith("entitlement-gate:"));
    expect(gateOracles.map((o) => o.name)).toEqual([
      "entitlement-gate: revise_no_target_unentitled",
      "entitlement-gate: revise_with_target_unentitled",
      "entitlement-gate: revise_dls_off_unentitled",
      "entitlement-gate: other_event_unentitled",
      "entitlement-gate: revise_no_target_entitled",
    ]);
    expect(gateOracles.every((o) => o.passed)).toBe(true);

    // The probe's own throwaway competition really was created over HTTP —
    // proof this is DRIVEN, not merely defined and never called.
    expect(calls.some((c) => c.method === "POST" && c.path === "/api/v1/competitions" &&
      (c.body as { name: string }).name.startsWith("Bench DLS Gate Probe"))).toBe(true);
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
    expect(gapWarning).toContain("pro");
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
    const officialsAutoIdx = calls.findIndex((c) => c.method === "POST" && /\/officials\/auto$/.test(c.path));
    const officialsApplyIdx = calls.findIndex((c) => c.method === "POST" && /\/officials\/apply$/.test(c.path));
    expect(scheduleApplyIdx).toBeGreaterThan(-1);
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
