// Shared state and helpers (pass/fail counters, check, sessions, the HTTP/DB helpers, tag): see the header of that file.
import { newSession, check, signIn, tag, insertEntitlementOverride, v1, v1data, setPlan } from "../harness.ts";

/** P11 (D6) batch score-event import (design doc
 *  docs/superpowers/specs/2026-08-25-p11-batch-event-import-design.md, Task
 *  9): one real `POST /divisions/{id}/events/import` call over HTTP, on a
 *  fresh Pro org (stats.player for the leaderboard read below, news.auto for
 *  the auto_posts toggle) with `import.events` granted per-org — that
 *  entitlement carries NO `plan_entitlements` row on any plan during rollout
 *  (R6), so even Pro 402s the import call without the override below.
 *
 *  Own competition/division: two individual entrants (real persons via
 *  `members`, not a lineup — the generic module's playerStats.folded fold
 *  reads entrant members directly, and a "team" entrant kind credits
 *  nobody, S8/#417) in one league stage, which round-robins to exactly one
 *  fixture (C(2,2) = 1 — the "one unstarted fixture" the brief calls for).
 *  The DIVISION is started, not the fixture: starting a division appends no
 *  core.start to any fixture (division-archive.spec.ts's own comment on
 *  that exact call), which is why the fixture is still "scheduled" when the
 *  import runs and the usecase's unstarted-fixture guard (event-import.ts
 *  step 3) still accepts it.
 *
 *  The stream itself is the events-import.spec.ts worked example: core.start
 *  -> generic.result{p1Score:2,p2Score:0} -> core.finalize (core.score is
 *  NOT the deciding event for this module). Three seams the unit/regression
 *  suites can't reach from outside the process, each false until this import
 *  runs and true only after: the fixture's persisted outcome, the
 *  division's player-stats fold, and the decided-write news auto-draft. */
export async function eventImportSuite(): Promise<void> {
  const owner = newSession();
  const who = await signIn(owner, `delivered+eventimport_${tag}@resend.dev`);
  const orgId = who.org_id;
  await setPlan(orgId, "pro", owner);
  await insertEntitlementOverride(owner, orgId, "import.events", true);

  const comp = v1data<{ id: string }>(
    await v1(owner, "/api/v1/competitions", "POST", {
      ends_on: "2030-12-31",
      name: `Event Import ${tag}`,
      visibility: "private",
    }),
  );
  const div = v1data<{ id: string }>(
    await v1(owner, `/api/v1/competitions/${comp.id}/divisions`, "POST", {
      name: "Import",
      sport_key: "generic",
      variant_key: "score",
      config: { points: { w: 3, d: 1, l: 0 }, progressScore: false },
    }),
  );

  // BEFORE the decide: refreshNews (scoring.ts) reads divisions.auto_posts
  // and returns early when it's false, so an import that ran before this
  // toggle would leave the news check below with nothing to find.
  const autoPosts = await v1(owner, `/api/v1/divisions/${div.id}`, "PATCH", { auto_posts: true });
  check("event-import: auto_posts toggle allowed (Pro news.auto)", autoPosts.status === 200);

  const home = v1data<{ id: string }>(
    await v1(owner, "/api/v1/persons", "POST", {
      full_name: `Import Home ${tag}`,
      consent: { public_name: true },
    }),
  );
  const away = v1data<{ id: string }>(
    await v1(owner, "/api/v1/persons", "POST", {
      full_name: `Import Away ${tag}`,
      consent: { public_name: true },
    }),
  );
  const entrants = v1data<{ id: string }[]>(
    await v1(owner, `/api/v1/divisions/${div.id}/entrants`, "POST", [
      {
        kind: "individual",
        display_name: `Import Home ${tag}`,
        seed: 1,
        members: [{ person_id: home.id }],
      },
      {
        kind: "individual",
        display_name: `Import Away ${tag}`,
        seed: 2,
        members: [{ person_id: away.id }],
      },
    ]),
  );
  const personOfEntrant = new Map([
    [entrants[0].id, home.id],
    [entrants[1].id, away.id],
  ]);

  const stage = v1data<{ id: string }>(
    await v1(owner, `/api/v1/divisions/${div.id}/stages`, "POST", {
      seq: 1,
      kind: "league",
      name: "League",
    }),
  );
  const fixtures = v1data<{
    fixtures: { id: string; home_entrant_id: string | null; away_entrant_id: string | null }[];
  }>(await v1(owner, `/api/v1/stages/${stage.id}/generate`, "POST")).fixtures;
  check(
    "event-import: two entrants in one league stage generate exactly one fixture",
    fixtures.length === 1,
  );
  const fixtureId = fixtures[0].id;
  const homeEntrantId = fixtures[0].home_entrant_id!;
  const homePersonId = personOfEntrant.get(homeEntrantId);

  // Starts the DIVISION only — appends no core.start to any fixture, so the
  // fixture stays "scheduled" (the ORDERING CONSTRAINT the usecase enforces:
  // the division must be started, the fixture must not be).
  const started = await v1(owner, `/api/v1/divisions/${div.id}/start`, "POST");
  check("event-import: division start", started.status < 300);

  const beforeFixture = v1data<{ outcome: unknown }>(await v1(owner, `/api/v1/fixtures/${fixtureId}`));
  check(
    "event-import: before the import, the fixture carries no outcome",
    beforeFixture.outcome === null,
  );

  const report = v1data<{
    totals: { imported: number; skipped: number; rejected: number };
    results: { status: string; eventsAppended: number }[];
  }>(
    await v1(owner, `/api/v1/divisions/${div.id}/events/import`, "POST", {
      import_id: `import-${tag}`,
      streams: [
        {
          fixture: { id: fixtureId },
          events: [
            { type: "core.start", payload: {} },
            { type: "generic.result", payload: { p1Score: 2, p2Score: 0 } },
            { type: "core.finalize", payload: {} },
          ],
        },
      ],
    }),
  );
  check(
    "event-import: one stream imported, three events appended, none rejected",
    report.totals.imported === 1 &&
      report.totals.rejected === 0 &&
      report.results[0]?.status === "imported" &&
      report.results[0]?.eventsAppended === 3,
  );

  // --- the fixture shows an outcome (home won 2-0) ---
  const afterFixture = v1data<{ outcome: { kind: string; winner?: string } | null }>(
    await v1(owner, `/api/v1/fixtures/${fixtureId}`),
  );
  check(
    "event-import: the fixture shows a decided outcome for the imported win",
    afterFixture.outcome?.kind === "win" && afterFixture.outcome?.winner === homeEntrantId,
  );

  // --- the division stats show the imported appearance ---
  const stats = v1data<{ rows: { person_id: string; stats: Record<string, number> }[] }>(
    await v1(owner, `/api/v1/divisions/${div.id}/stats/players`),
  );
  const homeRow = stats.rows.find((r) => r.person_id === homePersonId);
  check(
    "event-import: division stats credit the imported win to the home entrant's person",
    homeRow?.stats.wins === 1 && homeRow?.stats.points_for === 2,
  );

  // --- an auto-draft news post exists ---
  const drafts = v1data<{ id: string; kind: string; auto_source: unknown }[]>(
    await v1(owner, `/api/v1/orgs/${orgId}/posts?status=draft`),
  );
  check(
    "event-import: a result post auto-drafted from the imported decide",
    drafts.some((d) => d.kind === "result" && !!d.auto_source),
  );
}
