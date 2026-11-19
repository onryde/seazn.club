// W5 app-A Task 4 (X-CU-9, X-LE-2; RB5-L1, L2, L12; design 2026-11-05 §4.1) — which stage a late player can join after
// Start, driven through the real usecases on a real database. Main answered every league and group division with the
// bare 422 "the entrant list is locked" (entrants.ts's Start lock, `hasRootSwissStage` / `hasRootKnockoutStage` only), and
// the Start dialog said "Entrant list closes". A ROOT league or group stage now keeps the list open: the add is accepted
// (Task 5 seats the newcomer with catch-up fixtures) and a bracket FED by a table still takes nobody (X-LE-2).
//
// Expected values are the rulebook's (RB5-L1: a late entrant joins a started league; RB5-L2: or a started group stage;
// RB5-L12: a bracket fed from a table is never the entry stage; RB4-L11: a late pair is the entrant) and main's own lock
// sentence (entrants.ts), typed here. The sport set is the engine registry's own declaration, never a list typed here.
import { afterAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { builtinModules } from "@seazn/engine/sports";
import { entrantKindCap, type AnySportModule } from "@seazn/engine/sport";
import { sql } from "@/lib/db";
import { HttpError } from "@/lib/errors";
import { buildTemplateStages, templatesForSport } from "@/lib/format-templates";
import { engineEntrantKinds } from "@/lib/__tests__/_engine-entrant-kinds";
import type { AuthCtx } from "@/server/api-v1/auth";
import { CreateStage } from "@/server/api-v1/schemas";
import { createCompetition } from "../competitions";
import { createDivision } from "../divisions";
import { createEntrants } from "../entrants";
import { startDivision } from "../schedule";
import { createStages } from "../stages";
import { rootTableStages } from "../roundrobin-late-entry";
import { seedOrg } from "./_seed";

const HAS_DB = !!process.env.DATABASE_URL;

afterAll(async () => {
  if (!HAS_DB) return;
  const g = globalThis as { _sql?: { end(): Promise<void> } };
  const client = g._sql;
  g._sql = undefined;
  await client?.end();
});

/** Main's Start-lock sentence (entrants.ts), typed here. */
const LOCKED = "This tournament has started — the entrant list is locked. Withdrawing entrants still works.";
const KNOBS = { qualified: 4, swissRounds: 3, poolCount: 2, legs: 1 };
/** The templates whose entry stage is a league or group (rulebook; Task 14 added `group_only`). */
const TABLE_TEMPLATES = ["league", "league_ko", "groups_ko", "group_only", "group_stepladder", "group_playoffs"];
/** Of those, the ones that carry a bracket behind the table (X-LE-2: fed, takes nobody). */
const WITH_FED_STAGE = ["league_ko", "groups_ko", "group_stepladder", "group_playoffs"];

type EntrantKind = "individual" | "pair" | "team";
interface StageSpec {
  kind: string;
  name: string;
  config: Record<string, unknown>;
  progression: unknown;
}
interface Rig {
  auth: AuthCtx;
  divisionId: string;
  stageIds: string[];
  sport: string;
  kind: EntrantKind;
}

const moduleOf = (key: string): AnySportModule => {
  const m = builtinModules.find((x) => x.key === key);
  if (m === undefined) throw new Error(`no sport ${key}`);
  return m as AnySportModule;
};
const variantOf = (key: string): string => {
  const v = Object.keys(moduleOf(key).variants)[0];
  if (v === undefined) throw new Error(`sport ${key} declares no variant`);
  return v;
};
const defaultKindOf = (key: string): EntrantKind => (moduleOf(key).entrantModel?.defaultKind ?? "individual") as EntrantKind;
/** Does the registry's sport offer the template (the same read the builder's picker makes)? */
const offers = (sport: string, template: string): boolean =>
  templatesForSport(sport, engineEntrantKinds(sport)).some((t) => t.key === template);

/** A roster-less entrant of `kind`, or a real pair/individual with people when `people` names how many. */
function entrantInput(kind: EntrantKind, name: string, seed: number | null, people = 0) {
  return {
    kind,
    display_name: name,
    seed,
    members: Array.from({ length: people }, (_, i) => ({
      new_person: { full_name: `${name} ${i} ${randomUUID().slice(0, 6)}` },
      is_captain: false,
      roles: [] as string[],
    })),
  };
}

/** `n` seeded entrants in `stages` (each through the API's own `CreateStage` schema, `seq` from 1), started. */
async function started(sport: string, stages: StageSpec[], n = 6, kind: EntrantKind = defaultKindOf(sport), people = 0): Promise<Rig> {
  const { auth } = await seedOrg("pro");
  const comp = await createCompetition(auth, { ends_on: "2030-12-31", name: "W5 T4 " + randomUUID().slice(0, 6), visibility: "private", branding: {} });
  const division = await createDivision(auth, comp.id, {
    name: "Open",
    slug: "open-" + randomUUID().slice(0, 6),
    sport_key: sport,
    variant_key: variantOf(sport),
    config: {},
  });
  await createEntrants(auth, division.id, Array.from({ length: n }, (_, i) => entrantInput(kind, `P${i + 1}`, i + 1, people)));
  const stageIds: string[] = [];
  for (const [i, d] of stages.entries()) {
    const [stage] = await createStages(
      auth,
      division.id,
      CreateStage.parse({ seq: i + 1, kind: d.kind, name: d.name, config: d.config, progression: d.progression }),
    );
    stageIds.push(stage!.id);
  }
  await startDivision(auth, division.id);
  const [{ status }] = await sql<{ status: string }[]>`select status from divisions where id = ${division.id}`;
  expect(status, "premise: the division has started").toBe("active");
  return { auth, divisionId: division.id, stageIds, sport, kind };
}

const template = (sport: string, key: string) => started(sport, buildTemplateStages(key, KNOBS));

async function entrantCount(divisionId: string): Promise<number> {
  const [{ n }] = await sql<{ n: number }[]>`select count(*)::int as n from entrants where division_id = ${divisionId}`;
  return n;
}

/** The stages any fixture seats `entrantId` in. */
async function seatedIn(entrantId: string): Promise<string[]> {
  const rows = await sql<{ stage_id: string }[]>`
    select distinct stage_id from fixtures where ${entrantId} in (home_entrant_id, away_entrant_id)`;
  return rows.map((r) => r.stage_id);
}

/** A stage's lines as stored, in order: id, round, seats and key (what an add must leave alone). */
async function fixtureKeys(stageId: string): Promise<unknown[]> {
  return await sql<object[]>`
    select id, round_no, seq_in_round, ext_key, home_entrant_id, away_entrant_id, status
    from fixtures where stage_id = ${stageId} order by round_no, seq_in_round, id`.then((rows) => [...rows]);
}

async function addLate(rig: Rig, name = "Late", people = 0) {
  const [late] = await createEntrants(rig.auth, rig.divisionId, [entrantInput(rig.kind, name, null, people)]);
  return late!;
}

async function refusal(p: Promise<unknown>): Promise<HttpError> {
  const err = await p.then(
    () => null,
    (e: unknown) => e,
  );
  expect(err, "the add is refused").toBeInstanceOf(HttpError);
  return err as HttpError;
}

describe.skipIf(!HAS_DB)("W5 T4: a root league or group keeps the entrant list open after Start (X-CU-9, X-LE-2)", () => {
  it("X-CU-9 a late add to a started league_ko is accepted and the knockout is untouched", async () => {
    // differential: today 422 locked (entrants.ts:438 on 110b2ccbd3)
    const rig = await template("badminton", "league_ko");
    const before = await entrantCount(rig.divisionId);
    const knockoutBefore = await fixtureKeys(rig.stageIds[1]!);
    const late = await addLate(rig);
    expect(await entrantCount(rig.divisionId), "the late player is on the list").toBe(before + 1);
    expect(await seatedIn(late.id), "the fed knockout seats no late player (X-LE-2)").not.toContain(rig.stageIds[1]);
    expect(await fixtureKeys(rig.stageIds[1]!), "the knockout's own lines are byte-equal after the add").toEqual(knockoutBefore);
  });

  it("X-CU-9 every template whose entry stage is a table keeps the list open, in every sport the registry offers it", async () => {
    // The six templates on badminton; league, groups_ko and group_only on every sport whose picker offers them (the sport set is
    // the engine's own declaration). Counted: zero checked is a failure.
    const cells: [string, string][] = TABLE_TEMPLATES.map((t) => ["badminton", t]);
    for (const m of builtinModules) {
      if (m.key === "badminton") continue;
      for (const t of ["league", "groups_ko", "group_only"]) if (offers(m.key, t)) cells.push([m.key, t]);
    }
    let checked = 0;
    const sports = new Set<string>();
    for (const [sport, key] of cells) {
      const rig = await template(sport, key);
      const before = await entrantCount(rig.divisionId);
      const late = await addLate(rig);
      expect(await entrantCount(rig.divisionId), `${sport}/${key}: the late player is on the list`).toBe(before + 1);
      for (const fed of rig.stageIds.slice(1)) {
        expect(await seatedIn(late.id), `${sport}/${key}: not seated in the fed stage`).not.toContain(fed);
      }
      sports.add(sport);
      checked++;
    }
    expect(TABLE_TEMPLATES.length, "premise: the rulebook's six").toBe(6);
    expect(checked, "anti-vacuity: every cell ran").toBe(cells.length);
    expect(sports.size, "more than one sport was swept").toBeGreaterThan(1);
    expect(checked).toBeGreaterThanOrEqual(TABLE_TEMPLATES.length + 1);
  }, 600_000);

  it("X-CU-9 a late pair is accepted as the entrant (RB4-L11)", async () => {
    const sport = builtinModules.find((m) => offers(m.key, "league") && engineEntrantKinds(m.key).includes("pair"))?.key;
    expect(sport, "premise: the registry has a sport whose league takes pairs").toBeDefined();
    // The seats a pair holds are the engine's own declaration, not typed here.
    const seats = entrantKindCap("pair");
    expect(seats, "premise: a pair holds two").toBe(2);
    const rig = await started(sport!, buildTemplateStages("league", KNOBS), 6, "pair", seats);
    const before = await entrantCount(rig.divisionId);
    const late = await addLate(rig, "Late pair", seats);
    expect(late.kind).toBe("pair");
    expect(await entrantCount(rig.divisionId), "the pair is ONE entrant").toBe(before + 1);
  });

  it("the second call: a second late add to the same started league is open too", async () => {
    const rig = await template("badminton", "league");
    const before = await entrantCount(rig.divisionId);
    await addLate(rig, "Late 1");
    await addLate(rig, "Late 2");
    expect(await entrantCount(rig.divisionId)).toBe(before + 2);
  });

  it("X-LE-2 a division with no root table, Swiss, knockout or open format still locks (the guard is not widened)", async () => {
    const rig = await started("badminton", [{ kind: "double_elim", name: "Double", config: {}, progression: null }]);
    const before = await entrantCount(rig.divisionId);
    const err = await refusal(addLate(rig));
    expect(err).toMatchObject({ status: 422, message: LOCKED });
    expect(await entrantCount(rig.divisionId), "nothing of the add was written").toBe(before);
  });

  it("X-LE-2 a table fed by an earlier stage (a progression source, or a stored `qualified` field) keeps the list locked; the same stage as a root table opens it", async () => {
    // The refusal is the predicate's, not the setup's: each shape is refused, then the SAME division is taken back to a root
    // table and the add is accepted (the positive pair). A fed table is what a two-tier format's second tier is.
    let checked = 0;
    for (const shape of ["fed", "qualified"] as const) {
      const { auth } = await seedOrg("pro");
      const comp = await createCompetition(auth, { ends_on: "2030-12-31", name: "W5 T4 " + randomUUID().slice(0, 6), visibility: "private", branding: {} });
      const division = await createDivision(auth, comp.id, {
        name: "Open",
        slug: "open-" + randomUUID().slice(0, 6),
        sport_key: "badminton",
        variant_key: "bwf",
        config: {},
      });
      await createEntrants(auth, division.id, Array.from({ length: 4 }, (_, i) => entrantInput("individual", `P${i + 1}`, i + 1)));
      const [group] = await createStages(auth, division.id, { seq: 1, kind: "group", name: "Second tier", config: { legs: 1, pools: { count: 1 } }, progression: null });
      if (shape === "fed") await sql`update stages set progression = '{"sources": [{"from_seq": 1, "top": 4}], "placement": "snake", "timing": "on_complete"}'::jsonb where id = ${group!.id}`;
      else await sql`update stages set config = config || '{"qualified": []}'::jsonb where id = ${group!.id}`;
      await sql`update divisions set status = 'active' where id = ${division.id}`;
      const before = await entrantCount(division.id);
      const err = await refusal(createEntrants(auth, division.id, [entrantInput("individual", "Late", null)]));
      expect(err, shape).toMatchObject({ status: 422, message: LOCKED });
      expect(await entrantCount(division.id), `${shape}: nothing written`).toBe(before);

      await sql`update stages set progression = null, config = config - 'qualified' where id = ${group!.id}`;
      const [row] = await createEntrants(auth, division.id, [entrantInput("individual", "Late", null)]);
      expect(row!.display_name, `${shape}: a root group takes the late player`).toBe("Late");
      checked++;
    }
    expect(checked).toBe(2);
  });

  it("X-CU-9 only the division's ENTRY stage is a root table: null-progression groups at seq 1 and seq 2 (stg carries no progression on a fed stage)", async () => {
    // differential: today (196da2c969) both stages are root (no entry-stage check), so a late player would be taken by seq 2 too.
    const group = (name: string): StageSpec => ({ kind: "group", name, config: { legs: 1, pools: { count: 1 } }, progression: null });
    const rig = await started("badminton", [group("Tier 1"), group("Tier 2")], 4);
    const roots = await sql.begin((tx) => rootTableStages(tx, rig.divisionId));
    expect(roots.map((r) => r.id), "only the entry stage is root").toEqual([rig.stageIds[0]]);
    expect(roots.map((r) => r.seq)).toEqual([1]);
    const before = await entrantCount(rig.divisionId);
    const late = await addLate(rig);
    expect(await entrantCount(rig.divisionId), "seq 1 takes the late add").toBe(before + 1);
    expect(await seatedIn(late.id), "nothing of seq 2 is seated by it").not.toContain(rig.stageIds[1]);

    // The stage behind a closed entry stage exempts nothing: double_elim at seq 1, a null-progression league at seq 2.
    const behind = await started("badminton", [
      { kind: "double_elim", name: "Double", config: {}, progression: null },
      { kind: "league", name: "Behind", config: { legs: 1 }, progression: null },
    ]);
    expect(await sql.begin((tx) => rootTableStages(tx, behind.divisionId)), "a league behind a double elimination is not root").toEqual([]);
    const err = await refusal(addLate(behind));
    expect(err).toMatchObject({ status: 422, message: LOCKED });
  });

  it("X-LE-2 the templates behind a table carry a fed stage (the premise of the checks above)", () => {
    for (const key of WITH_FED_STAGE) {
      const stages = buildTemplateStages(key, KNOBS);
      expect(stages.length, key).toBeGreaterThan(1);
      expect(stages[1]!.progression, `${key}: the second stage is fed`).not.toBeNull();
    }
    expect(WITH_FED_STAGE.length).toBe(4);
  });
});
