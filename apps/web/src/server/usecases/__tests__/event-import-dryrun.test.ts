import { describe, expect, it, vi } from "vitest";

// W2a Task 6 — a passthrough spy on the real resolver, for the bracket-overlay case at the end of this file.
vi.mock("@/server/engine-db/fixture-cfg", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/server/engine-db/fixture-cfg")>();
  return { ...real, resolveFixtureCfg: vi.fn(real.resolveFixtureCfg) };
});

import { builtinModules } from "@seazn/engine/sports";
import { sql } from "@/lib/db";
import { resolveFixtureCfg } from "@/server/engine-db/fixture-cfg";
import { seedBracket } from "@/server/engine-db/__tests__/helpers/seed-bracket";
import { invalidateOrgEntitlements } from "@/lib/entitlements";
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

  // Engine lineup fix (owner ruling 2026-10-15). An import folds its whole stream under the write path (`strictFromSeq: 1`), so a
  // ledger exported from the time generic took a lineup change is refused as a stream, by name, and writes nothing. That is
  // intended: the import is a NEW write of every event in it, and the sport no longer takes this one.
  it("rejects a legacy generic stream that carries a lineup event: import.fold_rejected, LINEUP_NOT_SUPPORTED, at that event, and writes NOTHING", async () => {
    const { auth } = await seedOrg();
    const { divisionId, fixtureId } = await startedDivisionWithFixture(auth);
    const [fx] = await sql<{ home_entrant_id: string }[]>`select home_entrant_id from fixtures where id = ${fixtureId}`;

    const report = await importEvents(auth, divisionId, {
      import_id: "imp-legacy-lineup",
      streams: [{
        fixture: { id: fixtureId },
        events: [
          { type: "core.start", payload: {} },
          { type: "core.lineup.retirement", payload: { side: fx!.home_entrant_id, personId: "p-legacy" } }, // ← index 1
          { type: "generic.result", payload: { p1Score: 2, p2Score: 1 } },
        ],
      }],
    });

    expect(report.results[0]!.status).toBe("rejected");
    expect(report.results[0]!.error).toMatchObject({ code: "import.fold_rejected", eventIndex: 1, engineCode: "LINEUP_NOT_SUPPORTED" });
    const [{ n }] = await sql<{ n: number }[]>`select count(*)::int as n from score_events where fixture_id = ${fixtureId}`;
    expect(n, "nothing written").toBe(0);

    // the control: the same stream without the lineup event is a clean import of the same fixture
    const clean = await importEvents(auth, divisionId, {
      import_id: "imp-legacy-lineup-clean",
      streams: [{
        fixture: { id: fixtureId },
        events: [
          { type: "core.start", payload: {} },
          { type: "generic.result", payload: { p1Score: 2, p2Score: 1 } },
        ],
      }],
    });
    expect(clean.results[0]!.error, "the control stream is not refused").toBeUndefined();
    expect(clean.results[0]!.status, "the control stream is imported").not.toBe("rejected");
  });

  // W2d T18 (HK-TB-2). The import folds every event under the write path, so an untyped `hockey.goal` is refused by name —
  // the breaking change `docs/api-v1-breaking-changes.md` (2026-10-28) documents for this route — and the same stream with
  // the goal typed imports.
  it("rejects an untyped FIH hockey goal: import.fold_rejected, GOAL_KIND_REQUIRED, at that event, and writes NOTHING; typed, it imports", async () => {
    // single-sport: FIH hockey is the one sport whose goal must record its type (`PeriodPreset.goalKindRequired`).
    const s = await seedBracket({ sport: "hockey", variant: "fih-outdoor", stageKind: "league", entrants: 2 });
    const fixtureId = s.fixtureIds[0]!;
    const [fx] = await sql<{ home: string }[]>`select home_entrant_id as home from fixtures where id = ${fixtureId}`;
    const stream = (goal: Record<string, unknown>) => [
      { type: "core.start", payload: {} },
      { type: "hockey.goal", payload: goal }, // ← index 1
      { type: "hockey.period.advance", payload: { to: "Q2" } },
      { type: "hockey.period.advance", payload: { to: "Q3" } },
      { type: "hockey.period.advance", payload: { to: "Q4" } },
      { type: "hockey.period.advance", payload: { to: "FT" } },
    ];
    const report = await importEvents(s.auth, s.divisionId, {
      import_id: "imp-untyped-hockey-goal",
      streams: [{ fixture: { id: fixtureId }, events: stream({ by: fx!.home }) }],
    });
    // No `eventIndex` is asserted: the kernel's GOAL_KIND_REQUIRED names no event (unlike LINEUP_NOT_SUPPORTED above), so
    // the report carries none today. Final-review fix report routes that; this test does not freeze its absence.
    expect(report.results[0]).toMatchObject({
      status: "rejected",
      eventsAppended: 0,
      error: { code: "import.fold_rejected", engineCode: "GOAL_KIND_REQUIRED" },
    });
    const [{ n }] = await sql<{ n: number }[]>`select count(*)::int as n from score_events where fixture_id = ${fixtureId}`;
    expect(n, "nothing written").toBe(0);

    // The control: the same stream with the goal typed as a field goal imports.
    const typed = await importEvents(s.auth, s.divisionId, {
      import_id: "imp-typed-hockey-goal",
      streams: [{ fixture: { id: fixtureId }, events: stream({ by: fx!.home, kind: "fg" }) }],
    });
    expect(typed.results[0]!.error, "the typed stream is not refused").toBeUndefined();
    expect(typed.results[0]!.status, "the typed stream is imported").not.toBe("rejected");
  });

  // W2e Task 2 (spec 2026-10-28 §5.2, E25). The import is the second strict write path: it folds every event under the
  // write path, so play after a match-ending sanction with no ending is refused by name, and the same stream with the
  // ending (core.forfeit{disqualified} against the sanctioned side) imports. Every declared end level, from the engine's
  // own declarations.
  it("X-SE-1 event import refuses scoring after an ending sanction: import.fold_rejected, ENDING_SANCTION_PENDING, writes NOTHING; with the ending, it imports", async () => {
    /** One point to `side` in each declaring sport's own event (test input). A declaring sport missing here reds below. */
    type Ev = { type: string; payload: Record<string, unknown> };
    const PLAY: Readonly<Record<string, (side: string) => Ev>> = {
      badminton: (side) => ({ type: "badminton.rally", payload: { wonBy: side } }),
      tennis: (side) => ({ type: "tennis.point", payload: { by: side } }),
    };
    const ends = builtinModules.flatMap((m) => (m.sanctionEnding?.endLevels ?? []).map((level) => ({ m, level })));
    expect(ends.length, "the engine declares end levels (zero = nothing checked)").toBeGreaterThan(0);
    let checked = 0;
    for (const { m, level } of ends) {
      const play = PLAY[m.key];
      expect(play, `${m.key}: a point event for this declaring sport`).toBeDefined();
      const s = await seedBracket({ sport: m.key, variant: Object.keys(m.variants)[0]!, stageKind: "league", entrants: 2 });
      const fixtureId = s.fixtureIds[0]!;
      const [fx] = await sql<{ home: string; away: string }[]>`
        select home_entrant_id as home, away_entrant_id as away from fixtures where id = ${fixtureId}`;
      const stream = (after: Ev): Ev[] => [
        { type: "core.start", payload: {} },
        play!(fx!.home),
        { type: m.sanctionEnding!.eventType, payload: { by: fx!.away, level } },
        after, // ← index 3
      ];
      const report = await importEvents(s.auth, s.divisionId, {
        import_id: `imp-ending-pending-${m.key}-${level}`,
        streams: [{ fixture: { id: fixtureId }, events: stream(play!(fx!.home)) }],
      });
      // ENDING_SANCTION_PENDING names the sanction ({by, level}), not an event, so the report carries no eventIndex.
      expect(report.results[0], `${m.key}/${level}`).toMatchObject({
        status: "rejected",
        eventsAppended: 0,
        error: { code: "import.fold_rejected", engineCode: "ENDING_SANCTION_PENDING" },
      });
      const [{ n }] = await sql<{ n: number }[]>`select count(*)::int as n from score_events where fixture_id = ${fixtureId}`;
      expect(n, `${m.key}/${level}: nothing written`).toBe(0);

      // The control: the same stream with the ending after the sanction imports, and the match is decided by it.
      const ended = await importEvents(s.auth, s.divisionId, {
        import_id: `imp-ending-recorded-${m.key}-${level}`,
        streams: [{ fixture: { id: fixtureId }, events: stream({ type: "core.forfeit", payload: { by: fx!.away, reason: "disqualified" } }) }],
      });
      expect(ended.results[0]!.error, `${m.key}/${level}: the ended stream is not refused`).toBeUndefined();
      expect(ended.results[0]!.status, `${m.key}/${level}: the ended stream is imported`).not.toBe("rejected");
      checked++;
    }
    expect(checked).toBe(ends.length);
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

  // W1 (entitlements v18, 2026-09-02): formerly "rejects a tier-3 event when
  // the org lacks the entitlement (import.entitlement)" — asserted
  // `{code: "import.entitlement", feature: "scoring.ball_by_ball"}` for a
  // bare `cricket.ball` import. Scoring detail is free on every plan now, so
  // `requiredFeatures` never gains that key at all; rewritten to prove the
  // NEGATIVE directly — the same import still fails (this fixture has no
  // lineup declared, `startedCricketDivisionWithFixture`'s own doc), but
  // never for `import.entitlement` any more.
  it("no longer requires an entitlement for a tier-3 event — cricket.ball fails for a different reason", async () => {
    const { auth } = await seedOrg();
    const { divisionId, fixtureId } = await startedCricketDivisionWithFixture(auth);

    const report = await importEvents(auth, divisionId, {
      import_id: "imp-entitlement-gone",
      streams: [{ fixture: { id: fixtureId }, events: [{ type: "cricket.ball", payload: {} }] }],
    });
    // Fix round 1, M-1: pin the ACTUAL code, not just "not import.entitlement"
    // — that alone passes when `error` is `undefined` or the code is
    // anything at all. This fixture has no lineup (`startedCricketDivision
    // WithFixture`'s own doc: seeded with zero members), so the dry-run fold
    // itself refuses the bare `{}` payload with `WRONG_PHASE` before ever
    // reaching a real ball — a structural fold rejection, observed directly
    // (not assumed), pinned so both facts hold: not gated by entitlement, AND
    // failing for the specific reason this test's title claims.
    expect(report.results[0]!.error).toMatchObject({
      code: "import.fold_rejected",
      engineCode: "WRONG_PHASE",
    });
  });

  // Final review C-2: a SECOND entitlement gate the fidelity map cannot
  // express. W1 deletes `requiredFeatureForEvent` and the fidelity gate it
  // drove entirely (scoring detail is free on every plan) — this gate is
  // untouched: a `cricket.revise` with no manual umpire target, under a
  // division whose config enables DLS, is exactly what makes the fold
  // compute a Duckworth-Lewis-Stern target, which is Pro-only at the live
  // scoring door (scoring.ts's `requiresDlsEntitlement`). Without the
  // import-side counterpart a non-entitled org buys a DLS target by
  // importing instead of scoring.
  it("rejects a DLS-computed cricket.revise when the org is denied cricket.dls (import.entitlement)", async () => {
    // V393 (entitlements v18 §2) granted `cricket.dls` on every plan, so no
    // plan withholds it. The import-side gate is still live code and still has
    // to match `scoreEvent`'s, so a DENY override is what drives it.
    const { auth } = await seedOrg();
    await sql`
      insert into org_entitlement_overrides (org_id, feature_key, bool_value, reason)
      values (${auth.orgId}, 'cricket.dls', false, 'test')
      on conflict (org_id, feature_key) do update set bool_value = false`;
    await invalidateOrgEntitlements(auth.orgId);
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

describe.skipIf(!HAS_DB)("bracket overlay reaches every resolveFixtureCfg caller (spec §5.4.1, W2a Task 6)", () => {
  it("event-import.ts importEvents", async () => {
    // The dry-run fold resolves the fixture's cfg before it judges the stream; a start-only stream is then
    // refused not_decided, which writes nothing — the cfg it was judged under is what this case reads.
    const s = await seedBracket({ sport: "boardgame", variant: "classical", stageKind: "knockout", entrants: 2 });
    const spy = vi.mocked(resolveFixtureCfg);
    spy.mockClear();
    const report = await importEvents(s.auth, s.divisionId, {
      import_id: "imp-w2a-overlay",
      streams: [{ fixture: { id: s.fixtureIds[0]! }, events: [{ type: "core.start", payload: {} }] }],
    });
    expect(report.results[0]!.error?.code).toBe("import.not_decided"); // the fold ran (a refusal earlier would skip it)
    const calls = spy.mock.calls.map((c, i) => ({
      kind: (c[2] as { kind?: string } | null | undefined)?.kind ?? null,
      out: spy.mock.results[i]!.value as Record<string, unknown> | null,
    }));
    expect(calls.length, "the entry never called resolveFixtureCfg").toBeGreaterThan(0);
    expect(calls.some((c) => c.kind === "knockout" && c.out?.tiebreak === true), JSON.stringify(calls)).toBe(true);
  });
});
