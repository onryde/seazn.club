// Owner ruling 2026-10-20 — "all stages are free" (option 2), V471.
//
// FREE on every plan:
//   (a) the stage COUNT — `stages.per_division.max` unlimited (NULL) on every plan;
//   (b) `standings.carry_over` — carrying a stage's standings into the next one;
//   (c) `auto_progress = true` — a stage advancing without a button;
//   (d) a stage's custom `byes`, `cross_feeds` and `placements` config.
// STAYS PAID (`formats.advanced`): the americano and ladder stage KINDS,
// including a ladder challenge.
//
// Expected values come from that ruling, never from the code under test. The
// plan SET is read from `plans` at run time: the live catalogue is not what the
// migrations read (`business` and `pro_plus` exist in some histories and not in
// others), and a hand-typed plan list would go on asserting a catalogue that
// moved.
//
// The (a) and (b) gates are KEPT as code: an `org_entitlement_overrides` row can
// still cap stages or switch carry-over off for one organisation, the same lever
// every other freed key keeps (`formats.double_elim`, `cricket.dls`,
// `standings.custom_points`). The last block proves that lever still shuts, so
// the kept code is not dead.
//
// Single sport (generic) on purpose: every gate here reads a stage's kind and
// config or a division flag, never its sport (format-gates.ts, divisions.ts).
//
// Real Postgres required; skipped without DATABASE_URL. Seeds are run-unique.
import { afterAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { sql } from "@/lib/db";
import { getLimit, hasFeature, invalidateOrgEntitlements } from "@/lib/entitlements";
import type { AuthCtx } from "@/server/api-v1/auth";
import { createCompetition } from "../competitions";
import { createDivision, getDivision, patchDivision } from "../divisions";
import { createEntrants } from "../entrants";
import { createStages, generateStageFixtures, issueChallenge } from "../stages";
import { GENERIC_CONFIG, seedOrg } from "./_seed";

const HAS_DB = !!process.env.DATABASE_URL;

afterAll(async () => {
  if (!HAS_DB) return;
  const globalForDb = globalThis as { _sql?: { end(): Promise<void> } };
  const client = globalForDb._sql;
  globalForDb._sql = undefined;
  await client?.end();
});

async function seedDivision(auth: AuthCtx, names: string[]) {
  const comp = await createCompetition(auth, {
    ends_on: "2030-12-31",
    name: "Free Stages " + randomUUID().slice(0, 6),
    visibility: "private",
    branding: {},
  });
  const division = await createDivision(auth, comp.id, {
    name: "Open",
    slug: "open",
    sport_key: "generic",
    variant_key: "score",
    config: GENERIC_CONFIG,
  } as never);
  const entrants = await createEntrants(
    auth,
    division.id,
    names.map((name, i) => ({ kind: "individual" as const, display_name: name, seed: i + 1, members: [] })) as never,
  );
  return { division, entrants: entrants as { id: string }[] };
}

const league = (seq: number) => ({ seq, kind: "league", name: `S${seq}`, config: {} });

async function stageCount(divisionId: string): Promise<number> {
  const [{ n }] = await sql<{ n: number }[]>`
    select count(*)::int as n from stages where division_id = ${divisionId}`;
  return n;
}

/** A staff override row — the per-organisation lever that outranks the plan. */
async function override(orgId: string, featureKey: string, value: { bool?: boolean; int?: number }) {
  await sql`
    insert into org_entitlement_overrides (org_id, feature_key, bool_value, int_value, reason)
    values (${orgId}, ${featureKey}, ${value.bool ?? null}, ${value.int ?? null}, 'all-stages-free test')
    on conflict (org_id, feature_key)
      do update set bool_value = excluded.bool_value, int_value = excluded.int_value`;
  await invalidateOrgEntitlements(orgId);
}

describe.skipIf(!HAS_DB)("all stages are free (owner ruling 2026-10-20, V471)", () => {
  it("the matrix: EVERY plan holds an explicit unlimited stage count and a granted carry-over row; community still lacks formats.advanced", async () => {
    const plans = (await sql<{ key: string }[]>`select key from plans order by key`).map((p) => p.key);
    // Empty case first: no plans would make every check below vacuous.
    expect(plans.length).toBeGreaterThan(0);

    const rows = await sql<{ plan_key: string; feature_key: string; bool_value: boolean | null; int_value: number | null }[]>`
      select plan_key, feature_key, bool_value, int_value from plan_entitlements
      where feature_key in ('stages.per_division.max', 'standings.carry_over')`;
    let checked = 0;
    for (const plan of plans) {
      // A ROW, not merely a resolved answer: an int key with no row resolves to
      // 0 (deny), and a bool key with no row denies — so "absent" is never free.
      const stagesRow = rows.find((r) => r.plan_key === plan && r.feature_key === "stages.per_division.max");
      const carryRow = rows.find((r) => r.plan_key === plan && r.feature_key === "standings.carry_over");
      expect(stagesRow, `${plan}: stages.per_division.max row`).toBeDefined();
      expect(stagesRow!.int_value, `${plan}: stages.per_division.max is unlimited`).toBeNull();
      expect(carryRow, `${plan}: standings.carry_over row`).toBeDefined();
      expect(carryRow!.bool_value, `${plan}: standings.carry_over is granted`).toBe(true);
      checked++;
    }
    expect(checked).toBe(plans.length);

    // Through the resolver, on a real community org — the path every gate reads.
    const { auth } = await seedOrg("community");
    expect(await getLimit(auth.orgId, "stages.per_division.max")).toBeNull();
    expect(await hasFeature(auth.orgId, "standings.carry_over")).toBe(true);
    // The negative pair: the SAME org still lacks the advanced-formats layer,
    // so every success below is the ruling, not an org that happens to hold it.
    expect(await hasFeature(auth.orgId, "formats.advanced")).toBe(false);
  });

  it("(a) community adds a 3rd stage, then reaches a 7th on a second call — past every old cap (community 2, pass 4, pro 6)", async () => {
    const { auth } = await seedOrg("community");
    const { division } = await seedDivision(auth, ["A", "B", "C", "D"]);

    // The empty batch first: it writes nothing and refuses nothing.
    expect(await createStages(auth, division.id, [])).toEqual([]);
    expect(await stageCount(division.id)).toBe(0);

    const first = await createStages(auth, division.id, [league(1), league(2), league(3)] as never);
    expect(first).toHaveLength(3);
    // Second call: the count is read again, in the insert's own transaction.
    const second = await createStages(auth, division.id, [league(4), league(5), league(6), league(7)] as never);
    expect(second).toHaveLength(4);
    expect(await stageCount(division.id)).toBe(7);
  });

  it("(b) community stores a carry-over progression rule", async () => {
    const { auth } = await seedOrg("community");
    const { division } = await seedDivision(auth, ["A", "B", "C", "D"]);
    const [, phase2] = await createStages(auth, division.id, [
      league(1),
      {
        seq: 2,
        kind: "league",
        name: "Phase 2",
        config: {},
        progression: {
          sources: [{ stage: "previous", take: [{ kind: "rankRange", from: 1, to: 2 }] }],
          placement: "rank_order",
          timing: "on_complete",
          carry: "points",
        },
      },
    ] as never);
    const [row] = await sql<{ progression: { carry?: string } | null }[]>`
      select progression from stages where id = ${phase2!.id}`;
    expect(row!.progression?.carry).toBe("points");
  });

  it("(c) community turns auto_progress ON, and back OFF", async () => {
    const { auth } = await seedOrg("community");
    const { division } = await seedDivision(auth, ["A", "B"]);
    expect((await getDivision(auth, division.id)).auto_progress).toBe(false);

    const on = await patchDivision(auth, division.id, { auto_progress: true });
    expect(on.auto_progress).toBe(true);
    expect((await getDivision(auth, division.id)).auto_progress).toBe(true);

    const off = await patchDivision(auth, division.id, { auto_progress: false });
    expect(off.auto_progress).toBe(false);
  });

  it("(d) community creates a stage with custom byes, one with cross-stage feeds, and one with placements — and the custom-bye bracket generates", async () => {
    const { auth } = await seedOrg("community");

    // Custom byes: three entrants make a four-slot bracket with one bye, and
    // the organiser hands it to seed 3 instead of the default seed 1.
    const byes = await seedDivision(auth, ["B1", "B2", "B3"]);
    const [ko] = await createStages(auth, byes.division.id, {
      seq: 1,
      kind: "knockout",
      name: "Custom byes",
      config: { byes: [byes.entrants[2]!.id] },
    } as never);
    const [stored] = await sql<{ config: { byes?: string[] } }[]>`select config from stages where id = ${ko!.id}`;
    expect(stored!.config.byes).toEqual([byes.entrants[2]!.id]);
    const { created } = await generateStageFixtures(auth, ko!.id);
    expect(created).toBeGreaterThan(0);
    // WHO holds the bye is the point of the config: seed 3, the entrant the
    // organiser named — and every one-seated row of the bracket is theirs.
    const byeHolders = async (stageId: string) =>
      (
        await sql<{ seated: string }[]>`
          select coalesce(home_entrant_id, away_entrant_id)::text as seated from fixtures
          where stage_id = ${stageId} and (home_entrant_id is null) <> (away_entrant_id is null)`
      ).map((r) => r.seated);
    const custom = await byeHolders(ko!.id);
    expect(custom.length, "the custom-bye bracket seated no bye at all").toBeGreaterThan(0);
    expect(new Set(custom)).toEqual(new Set([byes.entrants[2]!.id]));
    // The control: the SAME three entrants with no `byes` key give the bye to
    // seed 1 (the top seed takes the bye), so seed 3 above is the config at
    // work and not the bracket's default.
    // A second community org: this one is at Community's active-competition
    // cap once the three divisions below exist.
    const { auth: control } = await seedOrg("community");
    const plain = await seedDivision(control, ["B1", "B2", "B3"]);
    const [plainKo] = await createStages(control, plain.division.id, {
      seq: 1,
      kind: "knockout",
      name: "Default byes",
      config: {},
    } as never);
    await generateStageFixtures(control, plainKo!.id);
    const fallback = await byeHolders(plainKo!.id);
    expect(fallback.length).toBeGreaterThan(0);
    expect(new Set(fallback)).toEqual(new Set([plain.entrants[0]!.id]));

    // Cross-stage feed: a CL quarter-final loser drops into the EL.
    const feeds = await seedDivision(auth, ["F1", "F2", "F3", "F4"]);
    const fed = await createStages(auth, feeds.division.id, [
      {
        seq: 1,
        kind: "knockout",
        name: "CL",
        config: {
          cross_feeds: [{ from_ext_key: "se-r0-i0", side: "loser", to_stage_seq: 2, to_ext_key: "se-r0-i0", slot: 1 }],
        },
      },
      { seq: 2, kind: "knockout", name: "EL", config: {} },
    ] as never);
    expect(fed).toHaveLength(2);
    const [fedRow] = await sql<{ config: { cross_feeds?: unknown } }[]>`
      select config from stages where id = ${(fed as { id: string }[])[0]!.id}`;
    expect(fedRow!.config.cross_feeds).toEqual([
      { from_ext_key: "se-r0-i0", side: "loser", to_stage_seq: 2, to_ext_key: "se-r0-i0", slot: 1 },
    ]);

    // Placement game: the winner of the first match is ranked 1st, the loser 2nd.
    const placed = await seedDivision(auth, ["P1", "P2"]);
    const [placement] = await createStages(auth, placed.division.id, {
      seq: 1,
      kind: "league",
      name: "Placement",
      config: { placements: { "rr-r1-c1": [1, 2] } },
    } as never);
    const [placedRow] = await sql<{ config: { placements?: unknown } }[]>`
      select config from stages where id = ${placement!.id}`;
    expect(placedRow!.config.placements).toEqual({ "rr-r1-c1": [1, 2] });
  });

  it("formats.advanced still guards the americano and ladder KINDS on community (402) — and pro creates both", async () => {
    const { auth: free } = await seedOrg("community");
    const { division: freeDiv } = await seedDivision(free, ["A", "B", "C", "D"]);
    let refused = 0;
    for (const kind of ["americano", "ladder"]) {
      await expect(
        createStages(free, freeDiv.id, { seq: 1, kind, name: kind, config: {} } as never),
        kind,
      ).rejects.toMatchObject({ status: 402, featureKey: "formats.advanced" });
      refused++;
    }
    expect(refused).toBe(2);
    expect(await stageCount(freeDiv.id)).toBe(0);

    // The positive pair: the same two kinds on a plan that holds the layer.
    const { auth: pro } = await seedOrg("pro");
    const { division: proDiv } = await seedDivision(pro, ["A", "B", "C", "D"]);
    await createStages(pro, proDiv.id, { seq: 1, kind: "americano", name: "Am", config: { mode: "americano", courtCount: 1, rounds: 1 } } as never);
    const { division: proLadderDiv } = await seedDivision(pro, ["A", "B", "C", "D"]);
    await createStages(pro, proLadderDiv.id, { seq: 1, kind: "ladder", name: "Ladder", config: { challengeRange: 2 } } as never);
    expect(await stageCount(proDiv.id)).toBe(1);
    expect(await stageCount(proLadderDiv.id)).toBe(1);
  });

  it("a ladder challenge stays formats.advanced: issued on pro, refused 402 once the org loses the layer", async () => {
    const { auth } = await seedOrg("pro");
    const { division, entrants } = await seedDivision(auth, ["L1", "L2", "L3", "L4"]);
    const [ladder] = await createStages(auth, division.id, {
      seq: 1,
      kind: "ladder",
      name: "Club ladder",
      config: { challengeRange: 2 },
    } as never);
    const issued = await issueChallenge(auth, ladder!.id, {
      challenger_id: entrants[1]!.id,
      opponent_id: entrants[0]!.id,
    });
    expect(issued.fixture_id).toBeTruthy();

    await override(auth.orgId, "formats.advanced", { bool: false });
    await expect(
      issueChallenge(auth, ladder!.id, { challenger_id: entrants[3]!.id, opponent_id: entrants[2]!.id }),
    ).rejects.toMatchObject({ status: 402, featureKey: "formats.advanced" });
  });

  it("the stage-count and carry-over gates are still live for a staff override (why their code is kept)", async () => {
    const { auth } = await seedOrg("community");

    // Stage cap: staff cap this one organisation at 2.
    await override(auth.orgId, "stages.per_division.max", { int: 2 });
    const { division } = await seedDivision(auth, ["A", "B", "C", "D"]);
    await createStages(auth, division.id, [league(1), league(2)] as never);
    await expect(createStages(auth, division.id, league(3) as never)).rejects.toMatchObject({
      status: 402,
      featureKey: "stages.per_division.max",
    });
    expect(await stageCount(division.id)).toBe(2);

    // Carry-over: staff switch it off for this organisation.
    await override(auth.orgId, "standings.carry_over", { bool: false });
    const { division: d2 } = await seedDivision(auth, ["A", "B", "C", "D"]);
    await expect(
      createStages(auth, d2.id, [
        league(1),
        {
          seq: 2,
          kind: "league",
          name: "Phase 2",
          config: {},
          progression: {
            sources: [{ stage: "previous", take: [{ kind: "rankRange", from: 1, to: 2 }] }],
            placement: "rank_order",
            timing: "on_complete",
            carry: "points",
          },
        },
      ] as never),
    ).rejects.toMatchObject({ status: 402, featureKey: "standings.carry_over" });
    expect(await stageCount(d2.id)).toBe(0);
  });
});
