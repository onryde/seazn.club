// W5 app PR A, Task 3 fix round 1 (X-BD-7): the three risks a one-pool group's new pool row left open, each proven through the real path.
//  1. A one-pool group now keys its table "A", not "": the knockout it feeds must still resolve, on the setup path (stage-seeding's
//     `sourceStandingsTables`) AND the on-complete path (carry-over's `tablesForCompletedStage`).
//  2. A LEGACY one-pool group (drawn before T3: lines with no pool, no pool row, a table stored under no pool) stays as it was on
//     Generate (the `legacyOnePool` branch), and a Rebuild draws it as pool A WITHOUT the old no-pool table outliving it:
//     `readSingleTableSnapshot` prefers the no-pool row, so a survivor would shadow the new table for every reader.
// Real Postgres required; skipped without DATABASE_URL.
import { afterAll, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { sql, withTenant } from "@/lib/db";
import { invalidateOrgEntitlements } from "@/lib/entitlements";
import { setOrgPlan } from "@/lib/__tests__/_billing-group";
import type { AuthCtx } from "@/server/api-v1/auth";
import { appendEvent } from "@/server/engine-db";
import { createCompetition } from "../competitions";
import { createDivision } from "../divisions";
import { createEntrants } from "../entrants";
import { completeStage, confirmSeedProposal, createStages, generateStageFixtures, getSeedProposal, getStandings, rebuildStageFixtures } from "../stages";
import { startDivision } from "../schedule";
import { readSingleTableSnapshot } from "../stage-table-snapshot";
import { playToDecided } from "./_quick-match-probe";
import { rig, rowsOf } from "./_w5-t3-rig";

vi.mock("@/lib/posthog-server", async (orig) => ({
  ...(await orig<typeof import("@/lib/posthog-server")>()),
  captureServer: vi.fn(),
}));

const HAS_DB = !!process.env.DATABASE_URL;
afterAll(async () => {
  if (!HAS_DB) return;
  const g = globalThis as { _sql?: { end(): Promise<void> } };
  const c = g._sql;
  g._sql = undefined;
  await c?.end();
});

const CFG = { resultMode: "score", allowDraws: true, points: { w: 3, d: 1, l: 0 }, progressScore: false };
const TAKE = 4;

async function genericOrg(): Promise<AuthCtx> {
  // single-sport: seeding reads a stored table's rows and ranks, never a sport rule; generic is the rig (as group-group-ko-seeding).
  const suffix = randomUUID().slice(0, 8);
  const [{ id: orgId }] = await sql<{ id: string }[]>`insert into organizations (name, slug) values (${"Op " + suffix}, ${"op-" + suffix}) returning id`;
  await setOrgPlan(orgId);
  await invalidateOrgEntitlements(orgId);
  await sql`insert into sports (key, name, module_version, position_catalog)
    values ('generic', 'Generic', '1.0.0', ${sql.json({ groups: [], lineup: { size: 1, benchMax: 0 } })}) on conflict (key) do nothing`;
  await sql`insert into sport_variants (sport_key, key, name, config, is_system)
    values ('generic', 'score', 'Score', ${sql.json(CFG)}, true) on conflict do nothing`;
  return { orgId, via: "session", userId: null, role: "owner", keyId: null };
}

/** A one-pool group of 6 feeding a knockout of its top 4. */
async function groupThenKnockout(timing: "setup" | "on_complete") {
  const auth = await genericOrg();
  const comp = await createCompetition(auth, { ends_on: "2030-12-31", name: "Op " + randomUUID().slice(0, 6), visibility: "private", branding: {} });
  const division = await createDivision(auth, comp.id, { name: "Open", slug: "open", sport_key: "generic", variant_key: "score", config: CFG } as never);
  await createEntrants(auth, division.id, Array.from({ length: 6 }, (_, i) => ({ kind: "individual" as const, display_name: "E" + (i + 1), seed: i + 1, members: [] })));
  const stages = (await createStages(auth, division.id, [
    { seq: 1, kind: "group", name: "Group", config: { pools: { count: 1 } } },
    { seq: 2, kind: "knockout", name: "Knockout", config: {}, progression: { sources: [{ stage: "previous", take: [{ kind: "topNPerGroup", n: TAKE }] }], placement: "rank_order", timing } },
  ] as never)) as { id: string }[];
  return { auth, divisionId: division.id, group: stages[0]!.id, ko: stages[1]!.id };
}

async function decideAll(auth: AuthCtx, stageId: string) {
  const fx = await sql<{ id: string }[]>`select id from fixtures where stage_id = ${stageId} and home_entrant_id is not null and away_entrant_id is not null`;
  for (const f of fx) {
    await appendEvent(auth.orgId, f.id, 0, { type: "core.start", payload: {} });
    await appendEvent(auth.orgId, f.id, 1, { type: "generic.result", payload: { p1Score: 2, p2Score: 0 } });
  }
  return fx.length;
}

/** The entrants seated in the knockout's first round, and the top TAKE of the group's own stored table (the input the seeding reads). */
async function seatedAndQualifiers(groupId: string, koId: string) {
  const seated = await sql<{ e: string | null }[]>`
    select x.e from fixtures f, lateral (values (f.home_entrant_id), (f.away_entrant_id)) as x(e) where f.stage_id = ${koId} and f.round_no = 1`;
  const [snap] = await sql<{ pool_id: string | null; rows: { entrantId: string; rank: number }[] }[]>`select pool_id, rows from standings_snapshots where stage_id = ${groupId}`;
  const top = [...snap!.rows].sort((a, b) => a.rank - b.rank).slice(0, TAKE).map((r) => r.entrantId);
  return { seated: new Set(seated.map((s) => s.e).filter((e): e is string => e !== null)), top: new Set(top), snapPool: snap!.pool_id };
}

describe.skipIf(!HAS_DB)("X-BD-7 a one-pool group feeds a knockout: the table keyed A still resolves", () => {
  it("setup path (stage-seeding): the proposal confirms and seats exactly the group table's top four", async () => {
    const r = await groupThenKnockout("setup");
    await generateStageFixtures(r.auth, r.ko); // the TBD shells, as the division builder makes them
    await generateStageFixtures(r.auth, r.group);
    expect(await decideAll(r.auth, r.group), "premise: 15 matches of a 6-field played").toBe(15);
    expect((await completeStage(r.auth, r.group)).completed).toBe(true);
    const proposal = await getSeedProposal(r.auth, r.ko);
    expect(proposal, "the completion prepared the knockout's proposal (no SEEDING_SOURCE_INCOMPLETE / STAGE_NOT_READY)").not.toBeNull();
    await confirmSeedProposal(r.auth, r.ko, { proposalId: proposal!.id });
    const { seated, top, snapPool } = await seatedAndQualifiers(r.group, r.ko);
    expect(snapPool, "premise: the group's table is stored under its pool, not under none").not.toBeNull();
    expect(top.size, "anti-vacuity: four qualifiers named").toBe(TAKE);
    expect(seated).toEqual(top);
  });

  it("on-complete path (carry-over): completing the group seats the knockout with the same four", async () => {
    const r = await groupThenKnockout("on_complete");
    await generateStageFixtures(r.auth, r.group);
    await decideAll(r.auth, r.group);
    expect((await completeStage(r.auth, r.group)).completed).toBe(true);
    const { seated, top, snapPool } = await seatedAndQualifiers(r.group, r.ko);
    expect(snapPool, "premise: stored under its pool").not.toBeNull();
    expect(top.size).toBe(TAKE);
    expect(seated, "the knockout's first round seats the group's top four").toEqual(top);
  });
});

// ---- the legacy shape: what a group drawn BEFORE this change looks like ---------------------------------------------------------

/** Turn a freshly drawn one-pool group back into the pre-T3 shape: lines with no pool and no pool row, keys unprefixed, no table. */
async function makeLegacy(stageId: string) {
  await sql`update fixtures set pool_id = null, ext_key = regexp_replace(ext_key, '^pA-', '') where stage_id = ${stageId}`;
  await sql`delete from standings_snapshots where stage_id = ${stageId}`;
  await sql`delete from pools where stage_id = ${stageId}`;
}

describe.skipIf(!HAS_DB)("X-BD-7 a legacy one-pool group: Generate leaves it alone, Rebuild draws it as pool A and the old no-pool table does not shadow the new one", () => {
  it("the legacyOnePool branch is reached: Generate on the legacy shape writes no pool row, patches no line into a pool, and leaves the lines as drawn", async () => {
    const r = await rig({ n: 4, kind: "group" });
    await makeLegacy(r.stageId);
    const before = await rowsOf(r.stageId);
    expect(before, "premise: a group of 4 plays 6").toHaveLength(6);
    expect(new Set(before.map((x) => x.pool_id)), "premise: legacy lines have no pool").toEqual(new Set([null]));
    const again = await generateStageFixtures(r.auth, r.stageId);
    expect(again.created, "a second Generate adds nothing").toBe(0);
    expect((await sql`select 1 from pools where stage_id = ${r.stageId}`).length, "and does NOT mint pool A under lines that carry none").toBe(0);
    expect(await rowsOf(r.stageId), "the lines are exactly as they were").toEqual(before);
  });

  it("Rebuild of the legacy group draws it as pool A, drops the stale no-pool table, and the next result's table is the one every single-table reader gets", async () => {
    const r = await rig({ n: 4, kind: "group" });
    await makeLegacy(r.stageId);
    // The organiser opened Standings on the unplayed legacy group: that read WRITES an all-zero table under no pool.
    await getStandings(r.auth, r.stageId);
    const stale = await sql<{ pool_id: string | null; rows: { played?: number }[] }[]>`select pool_id, rows from standings_snapshots where stage_id = ${r.stageId}`;
    expect(stale, "premise: the unplayed legacy group has a stored no-pool table").toHaveLength(1);
    expect(stale[0]!.pool_id).toBeNull();

    const rebuilt = await rebuildStageFixtures(r.auth, r.stageId);
    expect(rebuilt.created, "premise: Rebuild drew the 6 matches again").toBe(6);
    const [pool] = await sql<{ id: string; key: string }[]>`select id, key from pools where stage_id = ${r.stageId}`;
    expect(pool?.key, "the redraw made pool A").toBe("A");
    const rows = await rowsOf(r.stageId);
    expect(new Set(rows.map((x) => x.pool_id)), "every line carries it").toEqual(new Set([pool!.id]));
    expect(
      await sql`select 1 from standings_snapshots where stage_id = ${r.stageId} and pool_id is null`,
      "no table under NO pool survives next to pool A's (readSingleTableSnapshot prefers it)",
    ).toHaveLength(0);

    await startDivision(r.auth, r.divisionId);
    expect(await playToDecided(r.auth, rows[0]!.id), "premise: a result").toMatchObject({ kind: "decided" });
    const snap = await withTenant(r.auth.orgId, (tx) => readSingleTableSnapshot<{ entrantId: string; played: number }[]>(tx, r.stageId));
    expect(snap, "a single-table reader finds a table").toBeDefined();
    const [{ id: onlyPool }] = await sql<{ id: string }[]>`select pool_id as id from standings_snapshots where stage_id = ${r.stageId}`;
    expect(onlyPool, "and the only stored table is pool A's").toBe(pool!.id);
    expect(snap!.rows.reduce((n, x) => n + x.played, 0), "carrying the one decided match (two entrants played once)").toBe(2);
  });
});
