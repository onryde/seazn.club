// W5 app PR A, B4 fix wave (owner 2026-11-18, "better to fix now"): an UNDER-half leaver of a pool keeps her RB5-W7 footnote.
//
// RB5-W2: under half played, every result she played is removed and the rest void - so no counted result names her and her
// pool's table has no row for her (Task 20's finding). RB5-W7: the table's footnote still names the rule applied. Through the
// REAL producers: a real two-pool group, Started, scored through `scoreEvent`, the real cascade (`withdrawEntrantCascade`), then
// the hub's own document (`loadCompetitionHub`, parsed by its schema) - and the division page's read (`getPublicDivision` +
// `loadTableWithdrawals` + `withdrawalNotesFor`, as the page calls it).
//
// differential: today (c959c9d428) her pool's table carries no `withdrawalNotes` at all.
// Expected values: RB5-W2 (1 of 3 played is under half: expunge), RB5-W7 (the note's words, the en dictionary's own copy).
// Single-sport (badminton): the pool a ledger row names is sport-blind; X-WDT-7's ruling-290 tests cover the other sports' rule.
import { afterAll, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";

vi.mock("next/cache", () => ({
  unstable_cache: (fn: (...args: unknown[]) => unknown) => fn,
  revalidateTag: vi.fn(),
}));

import enPublic from "@/dictionaries/en/public.json";
import { sql } from "@/lib/db";
import { buildTemplateStages } from "@/lib/format-templates";
import { withdrawalNotesFor } from "@/lib/table-withdrawal-note";
import { CreateStage } from "@/server/api-v1/schemas";
import { post } from "@/server/engine-db/__tests__/helpers/w2b-rig";
import { createCompetition } from "@/server/usecases/competitions";
import { createDivision } from "@/server/usecases/divisions";
import { createEntrants, patchEntrant } from "@/server/usecases/entrants";
import { startDivision } from "@/server/usecases/schedule";
import { createStages } from "@/server/usecases/stages";
import { withdrawEntrantCascade } from "@/server/usecases/withdrawal";
import { seedOrg } from "@/server/usecases/__tests__/_seed";
import { CompetitionHubDoc } from "../competition-hub-schema";
import { getPublicDivision } from "../data";
import { loadCompetitionHub } from "../competition-hub";
import { loadTableWithdrawals } from "../table-withdrawals";

const HAS_DB = !!process.env.DATABASE_URL;

afterAll(async () => {
  if (!HAS_DB) return;
  const g = globalThis as { _sql?: { end(): Promise<void> } };
  const client = g._sql;
  g._sql = undefined;
  await client?.end();
});

type Line = { id: string; pool_id: string | null; home_entrant_id: string; away_entrant_id: string };

async function twoPools() {
  const { auth } = await seedOrg("pro");
  const [{ slug: orgSlug }] = await sql<{ slug: string }[]>`select slug from organizations where id = ${auth.orgId}`;
  const comp = await createCompetition(auth, { ends_on: "2030-12-31", name: "B4 pool leaver " + randomUUID().slice(0, 6), visibility: "public", branding: {} });
  const division = await createDivision(auth, comp.id, { name: "Groups", slug: "groups-" + randomUUID().slice(0, 6), sport_key: "badminton", variant_key: "bwf", config: {} });
  const created = await createEntrants(
    auth,
    division.id,
    Array.from({ length: 8 }, (_, i) => ({
      kind: "individual" as const,
      display_name: `P${i + 1}`,
      seed: i + 1,
      members: [{ new_person: { full_name: `P${i + 1} ${randomUUID().slice(0, 6)}` }, is_captain: false, roles: [] }],
    })),
  );
  const [d] = buildTemplateStages("group_only", { qualified: 4, swissRounds: 3, poolCount: 2, legs: 1 });
  const [stage] = await createStages(auth, division.id, CreateStage.parse({ seq: 1, kind: d!.kind, name: d!.name, config: d!.config, progression: d!.progression }));
  await startDivision(auth, division.id);
  const [{ slug: compSlug }] = await sql<{ slug: string }[]>`select slug from competitions where id = ${comp.id}`;
  const lines = await sql<Line[]>`select id, pool_id, home_entrant_id, away_entrant_id from fixtures where stage_id = ${stage!.id} order by round_no, seq_in_round, id`;
  return { auth, orgSlug, compSlug, divSlug: division.slug, divisionId: division.id, stageId: stage!.id, ids: created.map((e) => e.id), lines };
}

const EXPUNGED_1_OF_3 = (enPublic as Record<string, string>)["table.withdrawalNote.expunged"]!.replace("{played}", "1").replace("{scheduled}", "3");

describe.runIf(HAS_DB)("an under-half pool leaver keeps her footnote under her pool's table (RB5-W2, RB5-W7)", () => {
  it("1 of 3 played in pool A, withdrawn: no pool row, the note under pool A's table on the hub and the division page; pool B has none; Reinstate takes it away", async () => {
    const r = await twoPools();
    const v = r.ids[0]!;
    const mine = r.lines.filter((l) => l.home_entrant_id === v || l.away_entrant_id === v);
    expect(mine, "premise: a pool of 4, one leg").toHaveLength(3);
    const poolA = mine[0]!.pool_id!;
    const poolB = r.lines.find((l) => l.pool_id !== poolA)!.pool_id!;
    // She wins one line; every other line of the stage is played (home wins), so both pools hold counted results.
    const first = mine[0]!;
    await post(r.auth, first.id, "core.forfeit", { by: first.home_entrant_id === v ? first.away_entrant_id : first.home_entrant_id, reason: "walkover" });
    for (const l of r.lines.filter((x) => x.home_entrant_id !== v && x.away_entrant_id !== v)) {
      await post(r.auth, l.id, "core.forfeit", { by: l.away_entrant_id, reason: "walkover" });
    }
    const out = await withdrawEntrantCascade(r.auth, v);
    expect(out.policy, "RB5-W2: 1 of 3 is under half").toBe("expunge");
    const [row] = await sql<{ payload: { pool_id?: string | null } }[]>`
      select payload from division_events where division_id = ${r.divisionId} and type = 'table_withdrawal'`;
    expect(row!.payload.pool_id, "the cascade records the pool her lines were in").toBe(poolA);

    // The hub's document.
    const doc = CompetitionHubDoc.parse(await loadCompetitionHub(r.orgSlug, r.compSlug, new Date(), { uncached: true }));
    const tables = doc.tables.filter((t) => t.divisionId === r.divisionId);
    expect(tables, "two pool tables").toHaveLength(2);
    const tableA = tables.find((t) => t.rows.some((x) => mine.some((l) => l.home_entrant_id === x.entrantId || l.away_entrant_id === x.entrantId)))!;
    const tableB = tables.find((t) => t !== tableA)!;
    expect(tableA.rows.map((x) => x.entrantId), "premise (RB5-W2): no counted result names her, so her pool has no row for her").not.toContain(v);
    const pub = await getPublicDivision(r.orgSlug, r.compSlug, r.divSlug);
    const publicName = pub!.entrants.find((e) => e.id === v)!.display_name;
    expect(tableA.withdrawalNotes, "differential: today none").toEqual([{ entrantId: v, lead: `${publicName} (withdrawn):`, body: EXPUNGED_1_OF_3 }]);
    expect(tableB.withdrawalNotes, "pool B's table names nobody").toBeUndefined();

    // The division page's read, as the page calls it: the pool's snapshot rows and the snapshot's pool.
    const records = await loadTableWithdrawals(r.divisionId);
    const statuses = Object.fromEntries(pub!.entrants.map((e) => [e.id, e.status]));
    const names = Object.fromEntries(pub!.entrants.map((e) => [e.id, e.display_name]));
    const snaps = await sql<{ pool_id: string | null; rows: { entrantId: string }[] }[]>`
      select pool_id, rows from standings_snapshots where stage_id = ${r.stageId}`;
    const pageNotes = (pool: string) => {
      const snap = snaps.find((s) => s.pool_id === pool)!;
      return withdrawalNotesFor(r.stageId, snap.rows.map((x) => x.entrantId), records, statuses, names, snap.pool_id ?? null).map((n) => n.entrantId);
    };
    expect(pageNotes(poolA), "the division page: under pool A").toEqual([v]);
    expect(pageNotes(poolB), "the division page: none under pool B").toEqual([]);

    // After Reinstate the note is gone (RB5-W6): her row is voided.
    await patchEntrant(r.auth, v, { status: "registered" });
    const after = CompetitionHubDoc.parse(await loadCompetitionHub(r.orgSlug, r.compSlug, new Date(), { uncached: true }));
    expect(after.tables.filter((t) => t.divisionId === r.divisionId).flatMap((t) => t.withdrawalNotes ?? []), "after Reinstate").toEqual([]);
  }, 240_000);
});
