// R1a (spec 2026-09-22 §4.2, plan Task 9) — the organiser console reads the
// SAME SQL function the public view calls (V414 `stage_qualification_meta`),
// so the organiser can never see a different cut from the one players see.
// Real Postgres; skipped without DATABASE_URL (same convention as
// public-stages-qualification-db.test.ts, whose scene builder this mirrors).
//
// What this pins:
//  * parity — for a public division, the usecase returns, stage by stage,
//    EXACTLY the six columns `public_stages_v` publishes. The scenes between
//    them give every column a non-default value (a points rule, per-group,
//    Swiss rounds, an organiser rank override), and a coverage check says so:
//    a column dropped from the usecase's select cannot hide behind a default;
//  * a private competition, which `public_stages_v` hides, still gets its meta
//    in the console;
//  * tenant scope — the function is SECURITY DEFINER, so the usecase must read
//    it through `stages` under withTenant; another org's stage id comes back
//    with nothing;
//  * only the stages asked for come back.
//
// Mutants killed (task-9 report): the select losing any one column (→ parity);
// the function called on the raw ids instead of through `stages` (→ the
// other-org case); the `where` on the ids dropped (→ the private case's
// exact key set).
import { afterAll, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";

// `unstable_cache` is a Next server-runtime API with no incrementalCache
// outside a real request — passthrough, never a memoising double.
vi.mock("next/cache", () => ({
  unstable_cache: (fn: (...args: unknown[]) => unknown) => fn,
  revalidateTag: vi.fn(),
}));

import { sql } from "@/lib/db";
import { createCompetition } from "@/server/usecases/competitions";
import { createDivision } from "@/server/usecases/divisions";
import { createStages } from "@/server/usecases/stages";
import { listStageQualificationMeta } from "../stage-qualification";
import { GENERIC_CONFIG, seedOrg } from "./_seed";

const HAS_DB = !!process.env.DATABASE_URL;

/** The six V414 columns, in the function's order. */
const COLUMNS = [
  "qualify_count",
  "qualify_per_group",
  "next_stage_name",
  "swiss_rounds",
  "points_rule",
  "has_rank_overrides",
] as const;

type ViewRow = { id: string } & Record<(typeof COLUMNS)[number], unknown>;

const prog = (take: unknown[]) => ({
  sources: [{ stage: "previous", take }],
  placement: "rank_order",
  timing: "on_complete",
});

/** A fresh org (so no plan cap can turn a cut into a pass for the wrong
 *  reason) with one generic division in a competition of this visibility. */
async function division(visibility: "public" | "private") {
  const { auth } = await seedOrg("pro");
  const suffix = randomUUID().slice(0, 8);
  // Created private and then moved: `createCompetition` silently writes a
  // public competition over the plan's public cap as PRIVATE.
  const comp = await createCompetition(auth, {
    ends_on: "2030-12-31",
    name: `Qual ${suffix}`,
    visibility: "private",
    branding: {},
  });
  await sql`update competitions set visibility = ${visibility} where id = ${comp.id}`;
  const div = await createDivision(auth, comp.id, {
    name: "Open",
    slug: `open-${suffix}`,
    sport_key: "generic",
    variant_key: "score",
    config: GENERIC_CONFIG,
  });
  return { auth, divisionId: div.id };
}

const POINTS = { base: { win: 2, draw: 1, loss: 0 } };

/** Swiss (4 rounds, its own points rule) → Finals taking 1..4; the Finals
 *  carries an organiser rank override (`has_rank_overrides` true). */
async function swissScene(visibility: "public" | "private") {
  const d = await division(visibility);
  const stages = await createStages(d.auth, d.divisionId, [
    { seq: 1, kind: "swiss", name: "Swiss", config: { rounds: 4, points: POINTS } },
    { seq: 2, kind: "knockout", name: "Finals", config: {}, progression: prog([{ kind: "rankRange", from: 1, to: 4 }]) },
  ] as never);
  // V414 reads only "a non-empty `config.rank_overrides` array"; the writer
  // (overrideStandings) needs entrants this scene has no use for.
  await sql`
    update stages set config = config || ${sql.json({ rank_overrides: [{ entrant_id: randomUUID(), rank: 1 }] })}
    where id = ${stages[1]!.id}`;
  return { ...d, stages };
}

/** Two groups → KO taking the top two of each (`qualify_per_group` true). */
async function groupScene() {
  const d = await division("public");
  const stages = await createStages(d.auth, d.divisionId, [
    { seq: 1, kind: "group", name: "Groups", config: { pools: { count: 2 } } },
    { seq: 2, kind: "knockout", name: "KO", config: {}, progression: prog([{ kind: "topNPerGroup", n: 2 }]) },
  ] as never);
  return { ...d, stages };
}

const published = (divisionId: string) =>
  sql<ViewRow[]>`
    select id, qualify_count, qualify_per_group, next_stage_name, swiss_rounds, points_rule,
           has_rank_overrides
    from public_stages_v where division_id = ${divisionId} order by seq`;

afterAll(async () => {
  if (!HAS_DB) return;
  const g = globalThis as { _sql?: { end(): Promise<void> } };
  const c = g._sql;
  g._sql = undefined;
  await c?.end();
});

describe.skipIf(!HAS_DB)("listStageQualificationMeta (R1a — the console's V414 read)", () => {
  it("empty case first: no stage ids → an empty map", async () => {
    const { auth } = await seedOrg("pro");
    expect((await listStageQualificationMeta(auth, [])).size).toBe(0);
  });

  it("parity: for a public division, each stage's meta is EXACTLY what public_stages_v publishes", async () => {
    const compared: ViewRow[] = [];
    for (const scene of [await swissScene("public"), await groupScene()]) {
      const pub = await published(scene.divisionId);
      expect(pub.map((r) => r.id), "premise: the view publishes every stage").toEqual(scene.stages.map((s) => s.id));
      const console_ = await listStageQualificationMeta(scene.auth, scene.stages.map((s) => s.id));
      expect([...console_.keys()].sort()).toEqual(pub.map((r) => r.id).sort());
      for (const { id, ...row } of pub) {
        expect(console_.get(id), `stage ${id}`).toEqual(row);
        // Exactly the six columns — no extra key, no missing one.
        expect(Object.keys(console_.get(id)!).sort(), `stage ${id}`).toEqual([...COLUMNS].sort());
      }
      compared.push(...pub);
    }
    // Coverage: every column had a non-default value somewhere above, so the
    // select losing any one of them reds the parity loop rather than
    // comparing a default with a default.
    expect(compared.some((r) => r.qualify_count === 4)).toBe(true);
    expect(compared.some((r) => r.qualify_per_group === true)).toBe(true);
    expect(compared.some((r) => r.next_stage_name === "Finals")).toBe(true);
    expect(compared.some((r) => r.swiss_rounds === 4)).toBe(true);
    expect(compared.some((r) => JSON.stringify(r.points_rule) === JSON.stringify(POINTS))).toBe(true);
    expect(compared.some((r) => r.has_rank_overrides === true)).toBe(true);
  });

  it("a private competition — which public_stages_v hides — still gets its meta, and only for the ids asked", async () => {
    const scene = await swissScene("private");
    expect(await published(scene.divisionId), "premise: the view publishes nothing private").toEqual([]);
    const [swiss] = scene.stages;
    const got = await listStageQualificationMeta(scene.auth, [swiss!.id]);
    expect([...got.keys()]).toEqual([swiss!.id]);
    expect(got.get(swiss!.id)).toEqual({
      qualify_count: 4,
      qualify_per_group: false,
      next_stage_name: "Finals",
      swiss_rounds: 4,
      points_rule: POINTS,
      has_rank_overrides: false,
    });
  });

  it("tenant scope: another org's stage id comes back with nothing (the definer function is read through `stages` under RLS)", async () => {
    const scene = await swissScene("private");
    const { auth: other } = await seedOrg("pro");
    const ids = scene.stages.map((s) => s.id);
    // Positive pair first: the owner does get these very ids.
    expect((await listStageQualificationMeta(scene.auth, ids)).size).toBe(2);
    expect((await listStageQualificationMeta(other, ids)).size).toBe(0);
  });
});
