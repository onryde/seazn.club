// W4 B2a (C16, X-FR-4) — the division title through the REAL read: `getPublicDivision` carries each stage's
// `feeds_from` (read off the stored progression of a stage a real template created), and `divisionTitle` over that
// read names the MAIN draw's winner, never the Plate's. The pure suite (champion.test.ts) proves the rule on shaped
// input; only a database proves the read PRODUCES that input — a column nothing reads is an inert seam.
import { afterAll, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";

vi.mock("next/cache", () => ({
  unstable_cache: (fn: (...args: unknown[]) => unknown) => fn,
  revalidateTag: vi.fn(),
}));

import { sql } from "@/lib/db";
import { buildTemplateStages } from "@/lib/format-templates";
import { CreateStage } from "@/server/api-v1/schemas";
import { createCompetition } from "@/server/usecases/competitions";
import { createDivision } from "@/server/usecases/divisions";
import { createEntrants } from "@/server/usecases/entrants";
import { startDivision } from "@/server/usecases/schedule";
import { createStages } from "@/server/usecases/stages";
import { seedOrg } from "@/server/usecases/__tests__/_seed";
import { loadCompetitionHub } from "../competition-hub";
import { CompetitionHubDoc } from "../competition-hub-schema";
import { getPublicDivision } from "../data";
import { decisiveStageOf, divisionTitle } from "../champion";

const HAS_DB = !!process.env.DATABASE_URL;
const KNOBS = { qualified: 4, swissRounds: 3, poolCount: 2, legs: 1 };

afterAll(async () => {
  if (!HAS_DB) return;
  const g = globalThis as { _sql?: { end(): Promise<void> } };
  const client = g._sql;
  g._sql = undefined;
  await client?.end();
});

interface Rig {
  orgSlug: string;
  compSlug: string;
  divSlug: string;
  divisionId: string;
  stageIds: string[];
  entrantIds: string[];
}

async function rig(templateKey: string, n = 8, drafts?: ReturnType<typeof buildTemplateStages>): Promise<Rig> {
  const { auth } = await seedOrg("pro");
  const [{ slug: orgSlug }] = await sql<{ slug: string }[]>`select slug from organizations where id = ${auth.orgId}`;
  const comp = await createCompetition(auth, {
    ends_on: "2030-12-31",
    name: "W4 B2a " + randomUUID().slice(0, 6),
    visibility: "public",
    branding: {},
  });
  const division = await createDivision(auth, comp.id, {
    name: "Open",
    slug: "open-" + randomUUID().slice(0, 6),
    sport_key: "badminton",
    variant_key: "bwf",
    config: {},
  });
  const created = await createEntrants(
    auth,
    division.id,
    Array.from({ length: n }, (_, i) => ({
      kind: "individual" as const,
      display_name: `P${i + 1}`,
      seed: i + 1,
      members: [{ new_person: { full_name: `P${i + 1} ${randomUUID().slice(0, 6)}` }, is_captain: false, roles: [] }],
    })),
  );
  const stageIds: string[] = [];
  for (const [i, d] of (drafts ?? buildTemplateStages(templateKey, KNOBS)).entries()) {
    const [stage] = await createStages(
      auth,
      division.id,
      CreateStage.parse({ seq: i + 1, kind: d.kind, name: d.name, config: d.config, progression: d.progression }),
    );
    stageIds.push(stage!.id);
  }
  await startDivision(auth, division.id);
  const [{ slug: compSlug }] = await sql<{ slug: string }[]>`select slug from competitions where id = ${comp.id}`;
  return { orgSlug, compSlug, divSlug: division.slug, divisionId: division.id, stageIds, entrantIds: created.map((e) => e.id) };
}

/** A final the stage does not have yet: a FED stage (`timing: "setup"`) has no fixtures until its source completes, so
 *  the rig clones a fixture row of the division into it, flagged `is_final` — a row shaped like the real thing, which is
 *  all the title rule reads. (The read under test is the stage graph; the fixtures are only its input.) */
async function ensureFinal(stageId: string, from: string): Promise<void> {
  const [has] = await sql<{ n: number }[]>`select count(*)::int as n from fixtures where stage_id = ${stageId} and is_final`;
  if (has!.n > 0) return;
  const [{ max }] = await sql<{ max: number }[]>`
    select coalesce(max(fixture_no), 0)::int as max from fixtures where division_id = (select division_id from stages where id = ${stageId})`;
  const [src] = await sql<{ id: string }[]>`select id from fixtures where stage_id = ${from} order by fixture_no limit 1`;
  if (!src) throw new Error(`rig: stage ${from} has no fixture to clone`);
  await sql.begin(async (tx) => {
    await tx`create temp table _clone on commit drop as select * from fixtures where id = ${src.id}`;
    await tx`update _clone set id = gen_random_uuid(), stage_id = ${stageId}, fixture_no = ${max + 1}, is_final = true, pool_id = null,
             ext_key = 'rig-final', winner_to_fixture = null, loser_to_fixture = null`;
    await tx`insert into fixtures select * from _clone`;
  });
}

/** Write a settled final for a stage, the way the hub DB suite does: decided with a winner. */
async function decideFinal(stageId: string, winner: string, loser: string, cloneFrom?: string): Promise<string> {
  if (cloneFrom !== undefined) await ensureFinal(stageId, cloneFrom);
  const [row] = await sql<{ id: string }[]>`
    update fixtures set status = 'decided', outcome = ${sql.json({ kind: "win", winner, loser })}
    where stage_id = ${stageId} and is_final returning id`;
  if (!row) throw new Error(`rig: stage ${stageId} has no final to decide`);
  return row.id;
}

describe.skipIf(!HAS_DB)("C16 the division title through the real read", () => {
  it("ko_plate: the read carries the plate's losers' feed, and the title is the MAIN draw's winner", async () => {
    const r = await rig("ko_plate");
    const [main, plate] = r.stageIds as [string, string];
    const [mainWinner, plateWinner] = [r.entrantIds[0]!, r.entrantIds[1]!];
    await decideFinal(main, mainWinner, r.entrantIds[2]!);
    await decideFinal(plate, plateWinner, r.entrantIds[3]!, main);

    const detail = (await getPublicDivision(r.orgSlug, r.compSlug, r.divSlug))!;
    const byId = new Map(detail.stages.map((s) => [s.id, s]));
    // The producer end: the stored progression (a roundLosers take) arrives as a LOSERS' edge; the root has none.
    expect(byId.get(plate)!.feeds_from).toEqual([{ stageId: main, side: "losers" }]);
    expect(byId.get(main)!.feeds_from).toBeUndefined();
    // The private column never rides the public read.
    expect(detail.stages.every((s) => !("progression" in s)), "stages checked: " + detail.stages.length).toBe(true);
    expect(detail.stages.length).toBe(2);

    expect(decisiveStageOf(detail.stages)!.id).toBe(main);
    expect(divisionTitle(detail.stages, detail.fixtures, detail.standings)).toEqual({ kind: "champion", champion: mainWinner });
    // The differential, on the same rows: without the graph (the old rule) the Plate is crowned.
    const flat = detail.stages.map((s) => ({ id: s.id, seq: s.seq, kind: s.kind, status: s.status }));
    expect(divisionTitle(flat, detail.fixtures, detail.standings)).toEqual({ kind: "champion", champion: plateWinner });
  });

  it("the positive pair: a plain knockout is its own title, and league → knockout titles the knockout", async () => {
    let checked = 0;
    for (const key of ["knockout", "league_ko"]) {
      const r = await rig(key);
      const last = r.stageIds[r.stageIds.length - 1]!;
      const winner = r.entrantIds[4]!;
      await decideFinal(last, winner, r.entrantIds[5]!, r.stageIds[0]);
      const detail = (await getPublicDivision(r.orgSlug, r.compSlug, r.divSlug))!;
      expect(decisiveStageOf(detail.stages)!.id, key).toBe(last);
      expect(divisionTitle(detail.stages, detail.fixtures, detail.standings), key).toEqual({ kind: "champion", champion: winner });
      if (key === "league_ko") {
        expect(detail.stages[1]!.feeds_from, "the knockout is fed from the league's winners' side").toEqual([
          { stageId: r.stageIds[0]!, side: "winners", top: true },
        ]);
      }
      checked++;
    }
    expect(checked).toBe(2);
  });

  it("m5 (PO ruling): a league feeding a Cup (ranks 1-4) AND a Bowl (ranks 5-8, stored last) is titled by the CUP", async () => {
    const cut = (from: number, to: number) => ({
      sources: [{ stage: "previous", take: [{ kind: "rankRange", from, to }] }],
      placement: "rank_order",
      timing: "setup",
    });
    // The Bowl is created seeded from "previous" (the Cup) and re-pointed at the league below: a stored progression
    // names its source stage by id, which exists only after the league is created.
    const r = await rig("league_ko", 8, [
      { kind: "league", name: "League", config: { legs: 1 }, progression: null },
      { kind: "knockout", name: "Cup", config: {}, progression: cut(1, 4) },
      { kind: "knockout", name: "Bowl", config: {}, progression: cut(5, 8) },
    ] as ReturnType<typeof buildTemplateStages>);
    const [league, cup, bowl] = r.stageIds as [string, string, string];
    await sql`update stages set progression = jsonb_set(progression, '{sources,0,stage}', ${sql.json({ stageId: league })}) where id = ${bowl}`;
    const [cupWinner, bowlWinner] = [r.entrantIds[0]!, r.entrantIds[7]!];
    await decideFinal(cup, cupWinner, r.entrantIds[1]!, league);
    await decideFinal(bowl, bowlWinner, r.entrantIds[6]!, league);
    const detail = (await getPublicDivision(r.orgSlug, r.compSlug, r.divSlug))!;
    const byId = new Map(detail.stages.map((s) => [s.id, s]));
    expect(byId.get(cup)!.feeds_from).toEqual([{ stageId: league, side: "winners", top: true }]);
    expect(byId.get(bowl)!.feeds_from).toEqual([{ stageId: league, side: "winners" }]);
    expect(decisiveStageOf(detail.stages)!.id).toBe(cup);
    expect(divisionTitle(detail.stages, detail.fixtures, detail.standings)).toEqual({ kind: "champion", champion: cupWinner });
    // The differential: with the graph's rank-1 hint removed, the highest seq (the Bowl) is crowned.
    const flat = detail.stages.map((s) => ({ ...s, feeds_from: s.feeds_from?.map((f) => ({ stageId: f.stageId, side: f.side })) }));
    expect(divisionTitle(flat, detail.fixtures, detail.standings)).toEqual({ kind: "champion", champion: bowlWinner });
  });

  it("a stored double-walkover final reaches the hub as a VACANT title with the fixture, and the document parses", async () => {
    const r = await rig("knockout", 4);
    const [final] = await sql<{ id: string }[]>`
      update fixtures set status = 'forfeited', outcome = ${sql.json({ kind: "double_walkover" })}
      where stage_id = ${r.stageIds[0]!} and is_final returning id`;
    const doc = (await loadCompetitionHub(r.orgSlug, r.compSlug))!;
    expect(CompetitionHubDoc.safeParse(doc).error?.issues ?? []).toEqual([]);
    expect(doc.knockouts).toHaveLength(1);
    expect(doc.knockouts[0]!.title).toEqual({ kind: "vacant" });
    expect(doc.knockouts[0]!.championFixtureId).toBe(final!.id);
    // A vacant title flags nobody on the page's rule either.
    const detail = (await getPublicDivision(r.orgSlug, r.compSlug, r.divSlug))!;
    expect(divisionTitle(detail.stages, detail.fixtures, detail.standings)).toEqual({ kind: "vacant" });
  });
});
