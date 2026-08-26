import { describe, expect, it } from "vitest";
import { sql } from "@/lib/db";
import { importEvents, IMPORT_CAPS } from "../event-import";
import {
  seedOrg,
  startedDivisionWithFixture,
  setupDivisionWithFixture,
  startedCricketDivisionWithFixture,
} from "./_rig";

const HAS_DB = !!process.env.DATABASE_URL;

describe.skipIf(!HAS_DB)("importEvents — guards and dry run", () => {
  it("rejects the whole stream when an event mid-stream is invalid, and writes NOTHING", async () => {
    const { auth } = await seedOrg();
    const { divisionId, fixtureId } = await startedDivisionWithFixture(auth);

    const report = await importEvents(auth, divisionId, {
      import_id: "imp-invalid",
      streams: [{
        fixture: { id: fixtureId },
        events: [
          { type: "core.start", payload: {} },
          { type: "core.not_a_real_event", payload: {} },   // ← index 1
          { type: "core.finalize", payload: {} },
        ],
      }],
    });

    expect(report.results[0]!.status).toBe("rejected");
    expect(report.results[0]!.error?.code).toBe("import.fold_rejected");
    expect(report.results[0]!.error?.eventIndex).toBe(1);
    // The assertion that matters: the ledger, not the response.
    const [{ n }] = await sql<{ n: number }[]>`
      select count(*)::int as n from score_events where fixture_id = ${fixtureId}`;
    expect(n).toBe(0);
  });

  it("rejects a fixture that already has events", async () => {
    const { auth } = await seedOrg();
    const { divisionId, fixtureId } = await startedDivisionWithFixture(auth);
    await sql`insert into score_events (fixture_id, org_id, seq, type, payload)
              values (${fixtureId}, ${auth.orgId}, 1, 'core.start', '{}'::jsonb)`;

    const report = await importEvents(auth, divisionId, {
      import_id: "imp-started",
      streams: [{ fixture: { id: fixtureId }, events: [{ type: "core.start", payload: {} }] }],
    });
    expect(report.results[0]!.error?.code).toBe("import.fixture_started");
  });

  it("refuses the whole call when the division has not started", async () => {
    const { auth } = await seedOrg();
    const { divisionId, fixtureId } = await setupDivisionWithFixture(auth);
    await expect(
      importEvents(auth, divisionId, {
        import_id: "imp-phase",
        streams: [{ fixture: { id: fixtureId }, events: [{ type: "core.start", payload: {} }] }],
      }),
    ).rejects.toMatchObject({ status: 409, code: "import.division_not_started" });
  });

  it("rejects a stream that never reaches a decided outcome", async () => {
    const { auth } = await seedOrg();
    const { divisionId, fixtureId } = await startedDivisionWithFixture(auth);
    const report = await importEvents(auth, divisionId, {
      import_id: "imp-open",
      streams: [{ fixture: { id: fixtureId }, events: [{ type: "core.start", payload: {} }] }],
    });
    expect(report.results[0]!.error?.code).toBe("import.not_decided");
  });

  // Final review I-6. There used to be ONE cap test, built as
  // `eventsPerCall + 1` events in a single stream — which trips the PER-FIXTURE
  // ceiling first (assertWithinCaps checks streams → per-fixture → per-call, and
  // 10,001 > 1,000), so the per-call branch it was named after was never
  // reached. Design doc §9 asks for all three, and each case now pins
  // `error.cap` as well as the status and code: without that field the three
  // are indistinguishable from each other and any one of them can stand in for
  // the other two.
  it("413s a call over the STREAMS cap", async () => {
    const { auth } = await seedOrg();
    const { divisionId, fixtureId } = await startedDivisionWithFixture(auth);
    const streams = Array.from({ length: IMPORT_CAPS.streams + 1 }, () => ({
      fixture: { id: fixtureId },
      events: [{ type: "core.start", payload: {} }],
    }));
    await expect(
      importEvents(auth, divisionId, { import_id: "imp-many-streams", streams }),
    ).rejects.toMatchObject({
      status: 413,
      code: "import.too_large",
      extra: { cap: "streams", limit: IMPORT_CAPS.streams, actual: IMPORT_CAPS.streams + 1 },
    });
  });

  it("413s a call over the per-FIXTURE event cap", async () => {
    const { auth } = await seedOrg();
    const { divisionId, fixtureId } = await startedDivisionWithFixture(auth);
    const events = Array.from({ length: IMPORT_CAPS.eventsPerFixture + 1 }, () => ({
      type: "core.start", payload: {},
    }));
    await expect(
      importEvents(auth, divisionId, { import_id: "imp-big-fixture", streams: [{ fixture: { id: fixtureId }, events }] }),
    ).rejects.toMatchObject({
      status: 413,
      code: "import.too_large",
      extra: {
        cap: "eventsPerFixture",
        limit: IMPORT_CAPS.eventsPerFixture,
        actual: IMPORT_CAPS.eventsPerFixture + 1,
      },
    });
  });

  it("413s a call over the per-CALL event cap", async () => {
    const { auth } = await seedOrg();
    const { divisionId, fixtureId } = await startedDivisionWithFixture(auth);
    // Every individual stream sits exactly ON the per-fixture ceiling (1,000,
    // not over it) and the stream count is well under 50, so the first two
    // checks pass and this is the only branch that can fire — which is exactly
    // what the old single test could not arrange.
    const events = Array.from({ length: IMPORT_CAPS.eventsPerFixture }, () => ({
      type: "core.start", payload: {},
    }));
    const streamCount = Math.floor(IMPORT_CAPS.eventsPerCall / IMPORT_CAPS.eventsPerFixture) + 1;
    const streams = Array.from({ length: streamCount }, () => ({ fixture: { id: fixtureId }, events }));
    await expect(
      importEvents(auth, divisionId, { import_id: "imp-big-call", streams }),
    ).rejects.toMatchObject({
      status: 413,
      code: "import.too_large",
      extra: {
        cap: "eventsPerCall",
        limit: IMPORT_CAPS.eventsPerCall,
        actual: streamCount * IMPORT_CAPS.eventsPerFixture,
      },
    });
  });

  it("rejects an ext_key that matches two fixtures in the division", async () => {
    const { auth } = await seedOrg();
    const { divisionId, fixtureIds } = await startedDivisionWithFixture(auth, { fixtures: 2 });
    await sql`update fixtures set ext_key = 'M1' where id in ${sql(fixtureIds)}`;
    const report = await importEvents(auth, divisionId, {
      import_id: "imp-ambig",
      streams: [{ fixture: { ext_key: "M1" }, events: [{ type: "core.start", payload: {} }] }],
    });
    expect(report.results[0]!.error).toMatchObject({ code: "import.fixture_unknown", matches: 2 });
  });

  // Added beyond the brief's verbatim list (standing rule: every change ships
  // a test that fails without it) — the brief's own step 4 names
  // import.slots_unfilled as one of the six guards runStream must implement,
  // but neither task's test file exercises it.
  it("rejects a fixture with an unassigned entrant (bye/TBD)", async () => {
    const { auth } = await seedOrg();
    const { divisionId, fixtureId } = await startedDivisionWithFixture(auth);
    await sql`update fixtures set away_entrant_id = null where id = ${fixtureId}`;

    const report = await importEvents(auth, divisionId, {
      import_id: "imp-unfilled",
      streams: [{ fixture: { id: fixtureId }, events: [{ type: "core.start", payload: {} }] }],
    });
    expect(report.results[0]!.error?.code).toBe("import.slots_unfilled");
  });

  // Task 5 addition (review finding #5(d), carried over from Tasks 3+4's
  // report): `generic` tops out at fidelity tier 1 and can never require an
  // entitlement, so this needs the cricket rig — see
  // startedCricketDivisionWithFixture's own doc comment in _rig.ts for why
  // `cricket.ball` / `scoring.ball_by_ball` is the pairing that reaches it.
  it("rejects a tier-3 event when the org lacks the entitlement (import.entitlement)", async () => {
    const { auth } = await seedOrg();
    const { divisionId, fixtureId } = await startedCricketDivisionWithFixture(auth);

    const report = await importEvents(auth, divisionId, {
      import_id: "imp-entitlement",
      streams: [{ fixture: { id: fixtureId }, events: [{ type: "cricket.ball", payload: {} }] }],
    });
    expect(report.results[0]!.error).toMatchObject({
      code: "import.entitlement",
      feature: "scoring.ball_by_ball",
    });
  });

  // Final review C-2: a SECOND entitlement gate the fidelity map cannot
  // express. `cricket.revise` is fidelity TIER 1, so `requiredFeatureForEvent`
  // returns null for it and step 5's loop asks for nothing — but a revise with
  // no manual umpire target, under a division whose config enables DLS, is
  // exactly what makes the fold compute a Duckworth-Lewis-Stern target, which
  // is Pro-only at the live scoring door (scoring.ts's `requiresDlsEntitlement`).
  // Without the import-side counterpart a non-entitled org buys a DLS target by
  // importing instead of scoring.
  it("rejects a DLS-computed cricket.revise when the org lacks cricket.dls (import.entitlement)", async () => {
    const { auth } = await seedOrg();
    const { divisionId, fixtureId } = await startedCricketDivisionWithFixture(auth);
    // The division-level config is what BOTH paths read (owner ruling R-B) —
    // not the fixture's cfg snapshot — so parity with `scoreEvent` is
    // byte-for-byte rather than approximate.
    await sql`
      update divisions set config = config || '{"dls":{"enabled":true}}'::jsonb
      where id = ${divisionId}`;

    const report = await importEvents(auth, divisionId, {
      import_id: "imp-dls",
      streams: [{ fixture: { id: fixtureId }, events: [{ type: "cricket.revise", payload: {} }] }],
    });
    expect(report.results[0]!.error).toMatchObject({
      code: "import.entitlement",
      feature: "cricket.dls",
    });
  });

  // Non-vacuousness control: an IDENTICAL stream with a manual umpire target is
  // not a DLS computation at all and must sail past the gate — so this rejects
  // for a different reason (the fold, which this fixture has no lineups for),
  // never `import.entitlement`. Without it, a "fix" that demanded `cricket.dls`
  // for every `cricket.revise` would pass the case above.
  it("negative control: a cricket.revise WITH a manual target never asks for cricket.dls", async () => {
    const { auth } = await seedOrg();
    const { divisionId, fixtureId } = await startedCricketDivisionWithFixture(auth);
    await sql`
      update divisions set config = config || '{"dls":{"enabled":true}}'::jsonb
      where id = ${divisionId}`;

    const report = await importEvents(auth, divisionId, {
      import_id: "imp-dls-manual",
      streams: [{
        fixture: { id: fixtureId },
        events: [{ type: "cricket.revise", payload: { target: 148 } }],
      }],
    });
    expect(report.results[0]!.error?.code).not.toBe("import.entitlement");
  });
});
