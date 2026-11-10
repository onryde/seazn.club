// W4 app-A Task 9 (X-LE-1, X-LE-2; ruling 263, pre-flight C11) — which stage a late player can join after Start, driven
// through the real usecases on a real database. Main answered every knockout division with the bare 422 "the entrant
// list is locked" (entrants.ts's Start lock), and the Start dialog said "Entrant list closes"; a root knockout now keeps
// the list open — its round 1 takes a late player while a slot is free (Task 10 places them) — and a knockout fed by an
// earlier stage never takes one.
//
// Expected values are the rulebook's (rules/cross-sport.md X-LE-1: the entry stage is the root knockout — under ko_plate
// the main bracket, under qualifying_main the qualifying one; X-LE-2: league_ko, groups_ko and swiss_knockout's
// knockouts are fed, and never take a late entrant), and main's own lock sentence (entrants.ts), typed here.
//
// Single sport (badminton singles): the predicate reads stage kinds, progression and order — no sport field reaches it.
// Task 10's placement suite sweeps sports.
import { afterAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { sql } from "@/lib/db";
import { HttpError } from "@/lib/errors";
import { buildTemplateStages } from "@/lib/format-templates";
import type { AuthCtx } from "@/server/api-v1/auth";
import { CreateStage } from "@/server/api-v1/schemas";
import { createCompetition } from "../competitions";
import { createDivision } from "../divisions";
import { createEntrants } from "../entrants";
import { startDivision } from "../schedule";
import { createStages } from "../stages";
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

function player(name: string, seed: number | null) {
  return {
    kind: "individual" as const,
    display_name: name,
    seed,
    members: [{ new_person: { full_name: `${name} ${randomUUID().slice(0, 6)}` }, is_captain: false, roles: [] }],
  };
}

interface Rig {
  auth: AuthCtx;
  divisionId: string;
  stageIds: string[];
}

/** `n` seeded players in `stages` (each through the API's own `CreateStage` schema, `seq` from 1), started. */
async function started(stages: { kind: string; name: string; config: Record<string, unknown>; progression: unknown }[], n = 6): Promise<Rig> {
  const { auth } = await seedOrg("pro");
  const comp = await createCompetition(auth, { ends_on: "2030-12-31", name: "W4 T9 " + randomUUID().slice(0, 6), visibility: "private", branding: {} });
  const division = await createDivision(auth, comp.id, {
    name: "Open",
    slug: "open-" + randomUUID().slice(0, 6),
    sport_key: "badminton",
    variant_key: "bwf",
    config: {},
  });
  await createEntrants(auth, division.id, Array.from({ length: n }, (_, i) => player(`P${i + 1}`, i + 1)));
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
  return { auth, divisionId: division.id, stageIds };
}

const template = (key: string) => started(buildTemplateStages(key, KNOBS));

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

async function addLate(rig: Rig, name = "Late") {
  const [late] = await createEntrants(rig.auth, rig.divisionId, [player(name, null)]);
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

describe.skipIf(!HAS_DB)("W4 T9: the entry stage a late player can join (X-LE-1, X-LE-2)", () => {
  it("X-LE-2 a late add to a started league_ko or groups_ko is refused and seated nowhere in the knockout", async () => {
    let checked = 0;
    for (const key of ["league_ko", "groups_ko"]) {
      const rig = await template(key);
      const before = await entrantCount(rig.divisionId);
      const err = await refusal(addLate(rig));
      expect(err.status, key).toBe(422);
      expect(err.message, key).toBe(LOCKED);
      expect(await entrantCount(rig.divisionId), `${key}: nothing of the add was written`).toBe(before);
      const [{ n }] = await sql<{ n: number }[]>`
        select count(*)::int as n from fixtures f join entrants e on e.id in (f.home_entrant_id, f.away_entrant_id)
         where f.stage_id = ${rig.stageIds[1]!} and e.display_name = 'Late'`;
      expect(n, `${key}: the knockout seats no late player`).toBe(0);
      checked++;
    }
    expect(checked).toBe(2);
  });

  it("C11 a knockout after a league with NO progression stored (the stg census shape) is fed: the list stays locked", async () => {
    const rig = await started([
      { kind: "league", name: "League", config: { legs: 1 }, progression: null },
      { kind: "knockout", name: "Knockout", config: {}, progression: null },
    ]);
    const before = await entrantCount(rig.divisionId);
    const err = await refusal(addLate(rig));
    expect(err).toMatchObject({ status: 422, message: LOCKED });
    expect(await entrantCount(rig.divisionId)).toBe(before);
  });

  it("X-LE-2 a swiss_knockout late add joins the Swiss, never the knockout (X-SW-12 holds)", async () => {
    const rig = await template("swiss_knockout");
    const late = await addLate(rig);
    expect(late.late_entry, "the Swiss's answer").toMatchObject({ format: "swiss", stage_id: rig.stageIds[0] });
    expect(await seatedIn(late.id), "never seated in the knockout").not.toContain(rig.stageIds[1]);
  });

  it("X-LE-1 a root knockout keeps the list open after Start: knockout, ko_plate, qualifying_main", async () => {
    let checked = 0;
    for (const key of ["knockout", "ko_plate", "qualifying_main"]) {
      const rig = await template(key);
      const before = await entrantCount(rig.divisionId);
      const late = await addLate(rig);
      expect(await entrantCount(rig.divisionId), `${key}: the late player is on the list`).toBe(before + 1);
      // X-LE-2: ko_plate's plate and qualifying_main's main draw are fed — the admission picks the root stage only, so
      // the late player's only seat is in the first stage (Task 10 places them: six in a bracket of eight hold byes).
      expect(late.late_entry, key).toMatchObject({ format: "knockout", stage_id: rig.stageIds[0] });
      expect(await seatedIn(late.id), `${key}: seated in the first stage only`).toEqual([rig.stageIds[0]]);
      checked++;
    }
    expect(checked).toBe(3);
  });

  it("the second call: a second late add to the same started knockout is open too", async () => {
    const rig = await template("knockout");
    const before = await entrantCount(rig.divisionId);
    await addLate(rig, "Late 1");
    await addLate(rig, "Late 2");
    expect(await entrantCount(rig.divisionId)).toBe(before + 2);
  });
});
