// W4 app-A B2 fr2 carry (task 11 batch): Generate's PRIVILEGED read of the sealed setup tables (`sealedStageSetupCounts`,
// run in `withTenant`'s `privilegedPrelude`, before the role drops to app_user) is opened only by the one Generate that
// needs it — a REDRAW of a root knockout that already has its lines (`reconcileKnockoutGenerate`). Every other Generate
// (a Swiss round, a league, a knockout's first draw) never opens it, so a failure of that read can never stop them.
//
// The gate is invisible in the rows (an unopened read and an opened one that found nothing write the same fixtures), so
// the suite counts the transactions that carried a prelude: `@/lib/db`'s `withTenant`, wrapped through `importOriginal`,
// every call forwarded unchanged. Expected counts are the gate's rule (0 for each shape that is not a redraw, at least 1
// for the redraw), never read from the code under test.
//
// Single sport (badminton singles): the gate reads stage kind, progression and fixtures — no sport field reaches it.
import { afterAll, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";

const seen = vi.hoisted(() => ({ preludes: 0 }));
vi.mock("@/lib/db", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/db")>();
  return {
    ...actual,
    withTenant: ((orgId, fn, opts) => {
      if (opts?.privilegedPrelude !== undefined) seen.preludes++;
      return actual.withTenant(orgId, fn, opts);
    }) as typeof actual.withTenant,
  };
});

import { sql } from "@/lib/db";
import type { AuthCtx } from "@/server/api-v1/auth";
import { createCompetition } from "../competitions";
import { createDivision } from "../divisions";
import { createEntrants } from "../entrants";
import { startDivision } from "../schedule";
import { createStages, generateStageFixtures } from "../stages";
import { seedOrg } from "./_seed";

const HAS_DB = !!process.env.DATABASE_URL;

afterAll(async () => {
  if (!HAS_DB) return;
  const g = globalThis as { _sql?: { end(): Promise<void> } };
  const client = g._sql;
  g._sql = undefined;
  await client?.end();
});

async function division(n: number): Promise<{ auth: AuthCtx; divisionId: string }> {
  const { auth } = await seedOrg("pro");
  const comp = await createCompetition(auth, { ends_on: "2030-12-31", name: "fr2 gate " + randomUUID().slice(0, 6), visibility: "private", branding: {} });
  const d = await createDivision(auth, comp.id, { name: "Open", slug: "open-" + randomUUID().slice(0, 6), sport_key: "badminton", variant_key: "bwf", config: {} });
  await createEntrants(
    auth,
    d.id,
    Array.from({ length: n }, (_, i) => ({ kind: "individual" as const, display_name: `P${i + 1}`, seed: i + 1, members: [] })),
  );
  return { auth, divisionId: d.id };
}

/** The privileged preludes `generateStageFixtures` opened. */
async function preludesOf(auth: AuthCtx, stageId: string): Promise<number> {
  seen.preludes = 0;
  await generateStageFixtures(auth, stageId);
  return seen.preludes;
}

const fixtureCount = async (stageId: string) =>
  (await sql<{ n: number }[]>`select count(*)::int as n from fixtures where stage_id = ${stageId}`)[0]!.n;

describe.skipIf(!HAS_DB)("fr2: Generate opens the sealed read only for a knockout redraw", () => {
  it("a league, a Swiss round and a knockout's first draw open none; the knockout's redraw opens it", async () => {
    let checked = 0;

    const league = await division(4);
    const [ls] = await createStages(league.auth, league.divisionId, { seq: 1, kind: "league", name: "League", config: { legs: 1 }, progression: null });
    expect(await preludesOf(league.auth, ls!.id), "league").toBe(0);
    expect(await fixtureCount(ls!.id), "premise: the league Generate wrote its fixtures").toBeGreaterThan(0);
    checked++;

    const swiss = await division(4);
    const [ss] = await createStages(swiss.auth, swiss.divisionId, { seq: 1, kind: "swiss", name: "Swiss", config: { rounds: 3 }, progression: null });
    await startDivision(swiss.auth, swiss.divisionId);
    expect(await preludesOf(swiss.auth, ss!.id), "swiss").toBe(0);
    expect(await fixtureCount(ss!.id), "premise: the Swiss Generate paired round 1").toBeGreaterThan(0);
    checked++;

    const ko = await division(6);
    const [ks] = await createStages(ko.auth, ko.divisionId, { seq: 1, kind: "knockout", name: "KO", config: {}, progression: null });
    expect(await fixtureCount(ks!.id), "premise: no lines before the first draw").toBe(0);
    expect(await preludesOf(ko.auth, ks!.id), "knockout first draw").toBe(0);
    expect(await fixtureCount(ks!.id), "premise: the first draw wrote its lines").toBeGreaterThan(0);
    checked++;

    // The redraw: the same knockout, its lines drawn, Generated again (the reconcile reads the sealed setup counts).
    expect(await preludesOf(ko.auth, ks!.id), "knockout redraw").toBeGreaterThanOrEqual(1);
    checked++;

    expect(checked).toBe(4);
  });
});
