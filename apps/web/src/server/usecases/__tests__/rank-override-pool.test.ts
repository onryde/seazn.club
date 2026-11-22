// W5 app PR A, Task 13 (X-PO-3 <- RB5-P5, X-PO-4 <- RB5-P7; ST-G14 app half; rulings 285, 288) - the manual rank override, checked
// at write PER POOL and refused on a stage that has no table, driven through the real usecases on a real database.
//
// Main checked the body as ONE list (`duplicate ranks in override`), never a pool's size (an over-size pin was stored and thrown by the
// engine at the next recompute), never the stage kind, replaced EVERY pool's pins with the new body, and left a departed or
// re-snaked entrant's pin in the stage's config for ever.
//
// Expected values: the rulebook's (RB5-P5: a rank pinned once per pool; above the pool's size refused at write. RB5-P7: a named refusal
// on a non-table stage, the public page silent), the seeded snake of a group (doc 05 section 1, typed below), and the engine's own
// declaration of which stage kinds exist (the `stages.kind` check constraint). Never derived from the code under test.
import { afterAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { builtinModules } from "@seazn/engine/sports";
import { entrantKindCap } from "@seazn/engine/sport";
import { sql } from "@/lib/db";
import { RANK_OVERRIDE_TABLE_KINDS } from "@/lib/rank-override";
import { TABLE_KINDS } from "@/server/engine-db/competition";
import { HttpError } from "@/lib/errors";
import { OverrideStandings } from "@/server/api-v1/schemas";
import type { AuthCtx } from "@/server/api-v1/auth";
import { createCompetition } from "../competitions";
import { createDivision } from "../divisions";
import { createEntrants, deleteEntrant, patchEntrant } from "../entrants";
import { startDivision } from "../schedule";
import { scoreEvent } from "../scoring";
import { completeStage, createStages, generateStageFixtures, getStandings, overrideStandings, rebuildStageFixtures } from "../stages";
import { withdrawEntrantCascade } from "../withdrawal";
import { seedOrg } from "./_seed";

const HAS_DB = !!process.env.DATABASE_URL;

afterAll(async () => {
  if (!HAS_DB) return;
  const globalForDb = globalThis as { _sql?: { end(): Promise<void> } };
  const client = globalForDb._sql;
  globalForDb._sql = undefined;
  await client?.end();
});

interface SportPick {
  key: string;
  variant: string;
  kind: "individual" | "pair" | "team";
}
const BADMINTON: SportPick = { key: "badminton", variant: "bwf", kind: "individual" };
/** The second sport, from the engine's own declarations: its default entrant kind and first variant. */
const FOOTBALL: SportPick = (() => {
  const m = builtinModules.find((x) => x.key === "football");
  const variant = m === undefined ? undefined : Object.keys(m.variants)[0];
  if (m === undefined || variant === undefined) throw new Error("the engine declares no football module");
  return { key: m.key, variant, kind: (m.entrantModel?.defaultKind ?? "team") as SportPick["kind"] };
})();
const GENERIC: SportPick = { key: "generic", variant: "score", kind: "individual" };
/** The write-time checks and the storage cleanups do not read a sport's results: both sports with a member roster. */
const SPORTS = [BADMINTON, FOOTBALL] as const;

function entrantInput(sport: SportPick, name: string, seed: number | null) {
  const seats = sport.key === "generic" ? 0 : Math.min(2, entrantKindCap(sport.kind));
  return {
    kind: sport.kind,
    display_name: name,
    seed,
    members: Array.from({ length: seats }, (_, i) => ({
      new_person: { full_name: `${name} m${i + 1} ${randomUUID().slice(0, 4)}` },
      is_captain: false,
      roles: [],
    })),
  };
}

interface Rig {
  auth: AuthCtx;
  divisionId: string;
  stageId: string;
  sport: SportPick;
  /** Entrant ids by display name (`P1`, `P2`, ...). */
  id: Map<string, string>;
  add(name: string, seed: number): Promise<string>;
}

/** A division of `n` seeded entrants (seed = position) and one root league or group stage, generated. */
async function rig(opts: { n: number; kind?: "league" | "group"; pools?: number; sport?: SportPick; seeds?: number[] }): Promise<Rig> {
  const sport = opts.sport ?? BADMINTON;
  const { auth } = await seedOrg("pro");
  const comp = await createCompetition(auth, { ends_on: "2030-12-31", name: "W5 T13 " + randomUUID().slice(0, 6), visibility: "private", branding: {} });
  const division = await createDivision(auth, comp.id, {
    name: "Open",
    slug: "open-" + randomUUID().slice(0, 6),
    sport_key: sport.key,
    variant_key: sport.variant,
    config: {},
  });
  const made = await createEntrants(
    auth,
    division.id,
    Array.from({ length: opts.n }, (_, i) => entrantInput(sport, `P${i + 1}`, opts.seeds ? opts.seeds[i]! : i + 1)),
  );
  const [stage] = await createStages(auth, division.id, {
    seq: 1,
    kind: opts.kind ?? "league",
    name: "Table",
    config: opts.pools ? { pools: { count: opts.pools } } : {},
    progression: null,
  });
  await generateStageFixtures(auth, stage!.id);
  const id = new Map(made.map((e) => [e.display_name, e.id]));
  return {
    auth,
    divisionId: division.id,
    stageId: stage!.id,
    sport,
    id,
    add: async (name, seed) => {
      const [e] = await createEntrants(auth, division.id, [entrantInput(sport, name, seed)]);
      id.set(name, e!.id);
      return e!.id;
    },
  };
}

interface Stored {
  entrant_id: string;
  rank: number;
  pool_id?: string | null;
}
async function storedOverrides(stageId: string): Promise<Stored[] | undefined> {
  const [row] = await sql<{ config: { rank_overrides?: Stored[] } }[]>`select config from stages where id = ${stageId}`;
  return row!.config.rank_overrides;
}

/** pool key (`A`, `B`, ...) -> pool id, of a stage. */
async function poolIds(stageId: string): Promise<Map<string, string>> {
  const rows = await sql<{ id: string; key: string }[]>`select id, key from pools where stage_id = ${stageId}`;
  return new Map(rows.map((r) => [r.key, r.id]));
}

/** The names seated in each pool of the stage, read off its stored lines. */
async function poolMembers(stageId: string): Promise<Map<string, string[]>> {
  const rows = await sql<{ key: string; name: string }[]>`
    select p.key, e.display_name as name from pools p
      join fixtures f on f.pool_id = p.id
      join entrants e on e.id in (f.home_entrant_id, f.away_entrant_id)
     where p.stage_id = ${stageId}
     group by p.key, e.display_name`;
  const out = new Map<string, string[]>();
  for (const r of rows) out.set(r.key, [...(out.get(r.key) ?? []), r.name].sort());
  return out;
}

async function refusal(p: Promise<unknown>): Promise<HttpError> {
  const err = await p.then(
    () => null,
    (e: unknown) => e,
  );
  expect(err, "a refusal").toBeInstanceOf(HttpError);
  return err as HttpError;
}

const pin = (entrant_id: string, rank: number) => ({ entrant_id, rank, reason: "placement game" });

/** The seeded snake of doc 05 section 1, typed by hand: eight seeds into two pools run 1->A 2->B | 3->B 4->A | 5->A 6->B | 7->B 8->A. */
const SNAKE_8 = { A: ["P1", "P4", "P5", "P8"], B: ["P2", "P3", "P6", "P7"] };
/** Nine seeds: 9->A. */
const SNAKE_9 = { A: ["P1", "P4", "P5", "P8", "P9"], B: ["P2", "P3", "P6", "P7"] };

describe.skipIf(!HAS_DB)("X-PO-3 (RB5-P5, ST-G14): a rank is pinned once PER POOL, and never above the pool's size", () => {
  // differential: today 422 `duplicate ranks in override` - the body is one list, so rank 1 in pool A and rank 1 in pool B collide
  it("X-PO-3 rank 1 pinned in two pools is allowed, and each pool's table puts that entrant first (both sports and a scored one)", async () => {
    let checked = 0;
    for (const sport of [...SPORTS, GENERIC]) {
      const r = await rig({ n: 8, kind: "group", pools: 2, sport });
      const members = await poolMembers(r.stageId);
      expect([...members.keys()].sort(), `${sport.key}: two pools`).toEqual(["A", "B"]);
      expect(members.get("A"), `${sport.key}: the snake`).toEqual(SNAKE_8.A);
      expect(members.get("B"), `${sport.key}: the snake`).toEqual(SNAKE_8.B);
      const ids = await poolIds(r.stageId);
      const a = r.id.get("P8")!; // the weakest seed of pool A
      const b = r.id.get("P7")!; // the weakest seed of pool B
      expect(await overrideStandings(r.auth, r.stageId, { rows: [pin(a, 1), pin(b, 1)] })).toEqual({ overridden: 2 });
      expect(await storedOverrides(r.stageId), `${sport.key}: one entry per pool, each carrying its pool`).toEqual([
        { entrant_id: a, rank: 1, pool_id: ids.get("A")! },
        { entrant_id: b, rank: 1, pool_id: ids.get("B")! },
      ]);
      // Seat-level: nothing is played, so a pool's table lists nobody yet; score every line so the pins have rows to pin.
      if (sport.key === "generic") {
        await startDivision(r.auth, r.divisionId);
        const lines = await sql<{ id: string; home: string; away: string }[]>`
          select f.id, h.display_name as home, a.display_name as away from fixtures f
            join entrants h on h.id = f.home_entrant_id join entrants a on a.id = f.away_entrant_id
           where f.stage_id = ${r.stageId}`;
        for (const l of lines) {
          const homeWins = l.home < l.away; // the lower name wins, so P8 and P7 finish last in their pools
          await scoreEvent(r.auth, l.id, { expected_seq: 0, type: "core.start", payload: {} });
          await scoreEvent(r.auth, l.id, { expected_seq: 1, type: "generic.result", payload: { p1Score: homeWins ? 2 : 0, p2Score: homeWins ? 0 : 2 } });
        }
        for (const [pool, entrant] of [["A", a], ["B", b]] as const) {
          const t = await getStandings(r.auth, r.stageId, ids.get(pool)!);
          const rows = t.rows as { entrantId: string; rank: number; rankLocked?: boolean }[];
          expect(rows.map((x) => x.entrantId)[0], `pool ${pool}: the pinned entrant tops its own table`).toBe(entrant);
          expect(rows[0]!.rankLocked, `pool ${pool}: and is marked pinned`).toBe(true);
          checked++;
        }
      }
      checked++;
    }
    expect(checked, "anti-vacuity: 3 sports + 2 pool tables").toBe(5);
  });

  it("X-PO-3 the same rank twice in ONE pool is still refused by name, nothing stored (the positive pair of the case above)", async () => {
    let checked = 0;
    for (const sport of SPORTS) {
      const r = await rig({ n: 8, kind: "group", pools: 2, sport });
      const err = await refusal(overrideStandings(r.auth, r.stageId, { rows: [pin(r.id.get("P1")!, 2), pin(r.id.get("P4")!, 2)] }));
      expect(err.status).toBe(422);
      expect(err.code).toBe("RR_RANK_OVERRIDE_POOL");
      expect(await storedOverrides(r.stageId), `${sport.key}: a refused write stores nothing`).toBeUndefined();
      checked++;
    }
    expect(checked).toBe(2);
  });

  // differential: today accepted, stored, and thrown by the engine at the next recompute (applyRankLocks: "out of range")
  it("X-PO-3 a rank above the pool's size is refused at write (pool of 4 in a field of 8); the pool's own size is accepted; a league counts its whole field", async () => {
    let checked = 0;
    for (const sport of SPORTS) {
      const g = await rig({ n: 8, kind: "group", pools: 2, sport });
      const over = await refusal(overrideStandings(g.auth, g.stageId, { rows: [pin(g.id.get("P1")!, 5)] }));
      expect(over.status, `${sport.key}: rank 5 in a pool of 4`).toBe(422);
      expect(over.code).toBe("RR_RANK_OVERRIDE_POOL");
      expect(await storedOverrides(g.stageId), `${sport.key}: nothing stored`).toBeUndefined();
      // the boundary: rank 4 IS the pool's size
      await overrideStandings(g.auth, g.stageId, { rows: [pin(g.id.get("P1")!, 4)] });
      expect((await storedOverrides(g.stageId))?.map((x) => x.rank)).toEqual([4]);
      // a league is ONE table: rank 4 of 4 fine, rank 5 refused
      const l = await rig({ n: 4, kind: "league", sport });
      expect((await refusal(overrideStandings(l.auth, l.stageId, { rows: [pin(l.id.get("P1")!, 5)] }))).code).toBe("RR_RANK_OVERRIDE_POOL");
      await overrideStandings(l.auth, l.stageId, { rows: [pin(l.id.get("P1")!, 4)] });
      expect((await storedOverrides(l.stageId))?.map((x) => x.rank)).toEqual([4]);
      checked += 2;
    }
    expect(checked).toBe(4);
  });

  // B4 fix wave (m4): a group stage created but not drawn (a `setup` super-groups tier, or Generate not yet run) has no pool ids, so a
  // pin cannot name its pool: refused by name, nothing stored. differential: today it is stored with pool_id null. Its pair: an
  // undrawn league is one table and still takes the pin; drawn, the group takes it (the tests above).
  it("X-PO-3 a pin on a group stage before its pools are drawn is refused RR_RANK_OVERRIDE_UNDRAWN_POOLS, nothing stored; an undrawn league takes it", async () => {
    let checked = 0;
    for (const kind of ["group", "league"] as const) {
      const { auth } = await seedOrg("pro");
      const comp = await createCompetition(auth, { ends_on: "2030-12-31", name: "B4 m4 " + randomUUID().slice(0, 6), visibility: "private", branding: {} });
      const division = await createDivision(auth, comp.id, { name: "Open", slug: "open-" + randomUUID().slice(0, 6), sport_key: BADMINTON.key, variant_key: BADMINTON.variant, config: {} });
      const made = await createEntrants(auth, division.id, Array.from({ length: 8 }, (_, i) => entrantInput(BADMINTON, `P${i + 1}`, i + 1)));
      const [stage] = await createStages(auth, division.id, { seq: 1, kind, name: "Table", config: kind === "group" ? { pools: { count: 2 } } : {}, progression: null });
      const body = { rows: [pin(made[0]!.id, 1)] };
      if (kind === "group") {
        const err = await refusal(overrideStandings(auth, stage!.id, body));
        expect({ status: err.status, code: err.code }).toEqual({ status: 422, code: "RR_RANK_OVERRIDE_UNDRAWN_POOLS" });
        expect(await storedOverrides(stage!.id), "nothing stored").toBeUndefined();
        // drawn, the same pin is taken and names its pool
        await generateStageFixtures(auth, stage!.id);
        await overrideStandings(auth, stage!.id, body);
        expect((await storedOverrides(stage!.id))?.map((x) => typeof x.pool_id)).toEqual(["string"]);
      } else {
        await overrideStandings(auth, stage!.id, body);
        expect(await storedOverrides(stage!.id)).toEqual([{ entrant_id: made[0]!.id, rank: 1, pool_id: null }]);
      }
      checked++;
    }
    expect(checked).toBe(2);
  });

  it("X-PO-3 a pool the entrant is not seated in is not guessed: an entrant with no line in the stage is refused, nothing stored", async () => {
    const r = await rig({ n: 4, kind: "league" });
    const late = await r.add("P5", 5); // on the division, in no line of the table yet
    const err = await refusal(overrideStandings(r.auth, r.stageId, { rows: [pin(late, 1)] }));
    expect(err.status).toBe(422);
    expect(await storedOverrides(r.stageId)).toBeUndefined();
  });

  it("X-PO-3 a second override replaces only its pool's: the other pool's pin stays", async () => {
    let checked = 0;
    for (const sport of SPORTS) {
      const r = await rig({ n: 8, kind: "group", pools: 2, sport });
      const ids = await poolIds(r.stageId);
      await overrideStandings(r.auth, r.stageId, { rows: [pin(r.id.get("P1")!, 1), pin(r.id.get("P2")!, 1)] }); // A: P1, B: P2
      // a second body that names ONLY pool B: P3 takes rank 2 there
      await overrideStandings(r.auth, r.stageId, { rows: [pin(r.id.get("P3")!, 2)] });
      expect(await storedOverrides(r.stageId), `${sport.key}: A kept, B replaced`).toEqual([
        { entrant_id: r.id.get("P1")!, rank: 1, pool_id: ids.get("A")! },
        { entrant_id: r.id.get("P3")!, rank: 2, pool_id: ids.get("B")! },
      ]);
      // and a body naming both pools replaces both
      await overrideStandings(r.auth, r.stageId, { rows: [pin(r.id.get("P4")!, 3), pin(r.id.get("P6")!, 3)] });
      expect(await storedOverrides(r.stageId), `${sport.key}: both replaced`).toEqual([
        { entrant_id: r.id.get("P4")!, rank: 3, pool_id: ids.get("A")! },
        { entrant_id: r.id.get("P6")!, rank: 3, pool_id: ids.get("B")! },
      ]);
      checked++;
    }
    expect(checked).toBe(2);
  });

  it("X-PO-3 an empty body is still refused (pin, no defect: the route's schema)", () => {
    expect(OverrideStandings.safeParse({ rows: [] }).success).toBe(false);
    expect(OverrideStandings.safeParse({ rows: [{ entrant_id: randomUUID(), rank: 1, reason: "x" }] }).success).toBe(true);
  });
});

describe.skipIf(!HAS_DB)("X-PO-3 (G7): a pin does not outlive the entrant it names", () => {
  // differential: today the departed entrant's lock stays in `config.rank_overrides` for ever
  it("X-PO-3 after a withdrawal the departed entrant's lock is dropped, the others stay (before Start, both sports)", async () => {
    let checked = 0;
    for (const sport of SPORTS) {
      const r = await rig({ n: 4, kind: "league", sport });
      await overrideStandings(r.auth, r.stageId, { rows: [pin(r.id.get("P1")!, 2), pin(r.id.get("P2")!, 3)] });
      await withdrawEntrantCascade(r.auth, r.id.get("P1")!);
      expect(await storedOverrides(r.stageId), `${sport.key}: only the leaver's pin goes`).toEqual([
        { entrant_id: r.id.get("P2")!, rank: 3, pool_id: null },
      ]);
      checked++;
    }
    expect(checked).toBe(2);
  });

  it("X-PO-3 after a withdrawal the departed entrant's lock is dropped, after Start too (a pooled group: the other pool's pins untouched)", async () => {
    const r = await rig({ n: 8, kind: "group", pools: 2, sport: GENERIC });
    const ids = await poolIds(r.stageId);
    await overrideStandings(r.auth, r.stageId, { rows: [pin(r.id.get("P1")!, 2), pin(r.id.get("P2")!, 2)] }); // A: P1, B: P2
    await startDivision(r.auth, r.divisionId);
    await withdrawEntrantCascade(r.auth, r.id.get("P1")!);
    expect(await storedOverrides(r.stageId)).toEqual([{ entrant_id: r.id.get("P2")!, rank: 2, pool_id: ids.get("B")! }]);
  });

  it("X-PO-3 a finished table keeps its pins: a later departure takes nothing from it (RB5-L8)", async () => {
    const r = await rig({ n: 3, kind: "league", sport: GENERIC });
    await startDivision(r.auth, r.divisionId);
    const lines = await sql<{ id: string }[]>`select id from fixtures where stage_id = ${r.stageId}`;
    expect(lines).toHaveLength(3);
    for (const l of lines) {
      await scoreEvent(r.auth, l.id, { expected_seq: 0, type: "core.start", payload: {} });
      await scoreEvent(r.auth, l.id, { expected_seq: 1, type: "generic.result", payload: { p1Score: 2, p2Score: 0 } });
    }
    await overrideStandings(r.auth, r.stageId, { rows: [pin(r.id.get("P3")!, 1)] });
    await completeStage(r.auth, r.stageId);
    await withdrawEntrantCascade(r.auth, r.id.get("P3")!);
    expect(await storedOverrides(r.stageId), "the finished table stands as earned").toEqual([{ entrant_id: r.id.get("P3")!, rank: 1, pool_id: null }]);
  });

  it("X-PO-3 Reinstate does not bring the pin back: the organiser pins again", async () => {
    const r = await rig({ n: 4, kind: "league", sport: GENERIC });
    await startDivision(r.auth, r.divisionId);
    await overrideStandings(r.auth, r.stageId, { rows: [pin(r.id.get("P1")!, 2)] });
    await withdrawEntrantCascade(r.auth, r.id.get("P1")!);
    expect(await storedOverrides(r.stageId)).toEqual([]);
    await patchEntrant(r.auth, r.id.get("P1")!, { status: "registered" }); // the Reinstate door: the status write runs the table's own Reinstate
    expect(await storedOverrides(r.stageId), "still empty after the Reinstate").toEqual([]);
    await overrideStandings(r.auth, r.stageId, { rows: [pin(r.id.get("P1")!, 2)] });
    expect((await storedOverrides(r.stageId))?.map((x) => x.entrant_id)).toEqual([r.id.get("P1")!]);
  });

  // differential: today the deleted entrant's pin stays in the config of every stage
  it("X-PO-3 deleting an entrant before Start drops her pin with her lines", async () => {
    const r = await rig({ n: 4, kind: "league" });
    await overrideStandings(r.auth, r.stageId, { rows: [pin(r.id.get("P1")!, 2), pin(r.id.get("P2")!, 3)] });
    await deleteEntrant(r.auth, r.id.get("P1")!);
    expect((await storedOverrides(r.stageId))?.map((x) => x.entrant_id)).toEqual([r.id.get("P2")!]);
  });
});

describe.skipIf(!HAS_DB)("X-PO-3 (G7): a pre-Start re-snake clears the pins of every pool whose membership changed", () => {
  // differential: today the pins stay, naming entrants that now sit in another pool, and a stale rank is thrown at the next recompute
  it("X-PO-3 a pre-Start re-snake clears the changed pools' overrides and keeps an unchanged pool's (9 -> 10: only pool B changes)", async () => {
    let checked = 0;
    for (const sport of SPORTS) {
      const r = await rig({ n: 9, kind: "group", pools: 2, sport });
      const before = await poolMembers(r.stageId);
      expect(before.get("A"), "the snake of nine").toEqual(SNAKE_9.A);
      expect(before.get("B")).toEqual(SNAKE_9.B);
      const ids = await poolIds(r.stageId);
      await overrideStandings(r.auth, r.stageId, { rows: [pin(r.id.get("P4")!, 1), pin(r.id.get("P3")!, 1)] }); // A: P4, B: P3
      await r.add("P10", 10); // snake of ten: 10 -> B; pool A keeps its five, pool B grows 4 -> 5 (a parity change: drawn again)
      const out = await generateStageFixtures(r.auth, r.stageId);
      expect(out.reconcile?.kind, `${sport.key}: the premise - a redraw, not a patch`).toBe("regenerated");
      expect(out.reconcile?.pins_cleared, `${sport.key}: the answer says how many pins the redraw dropped (pool B's one)`).toBe(1);
      const after = await poolMembers(r.stageId);
      expect(after.get("A"), `${sport.key}: pool A did not change`).toEqual(SNAKE_9.A);
      expect(after.get("B"), `${sport.key}: pool B grew`).toEqual([...SNAKE_9.B, "P10"].sort());
      expect(await storedOverrides(r.stageId), `${sport.key}: B's pin goes, A's stays`).toEqual([
        { entrant_id: r.id.get("P4")!, rank: 1, pool_id: ids.get("A")! },
      ]);
      checked++;
    }
    expect(checked).toBe(2);
  });

  it("X-PO-3 a re-snake that moves everyone (a newcomer seeded 1) clears every pool's pins; a legacy entry with no pool_id goes with its entrant's pool", async () => {
    const r = await rig({ n: 8, kind: "group", pools: 2, seeds: [2, 3, 4, 5, 6, 7, 8, 9] });
    const ids = await poolIds(r.stageId);
    await overrideStandings(r.auth, r.stageId, { rows: [pin(r.id.get("P1")!, 1), pin(r.id.get("P2")!, 1)] });
    // a placement game's write (scoring.ts) carries no pool_id
    await sql`
      update stages set config = config || ${sql.json({ rank_overrides: [...(await storedOverrides(r.stageId))!, { entrant_id: r.id.get("P3")!, rank: 2 }] } as never)}
       where id = ${r.stageId}`;
    await r.add("P9", 1);
    const out = await generateStageFixtures(r.auth, r.stageId);
    expect(out.reconcile?.kind, "everyone moved: drawn again").toBe("regenerated");
    expect(out.reconcile?.pins_cleared, "three pins went: two stamped, one legacy").toBe(3);
    expect(await storedOverrides(r.stageId)).toEqual([]);
    expect(ids.size).toBe(2);
  });

  it("X-PO-3 a patch that moves nobody (two pools of four growing to six) keeps every pin: a larger pool still holds its ranks", async () => {
    const r = await rig({ n: 8, kind: "group", pools: 2 });
    const ids = await poolIds(r.stageId);
    await overrideStandings(r.auth, r.stageId, { rows: [pin(r.id.get("P1")!, 1), pin(r.id.get("P2")!, 1)] });
    for (const [i, name] of ["P9", "P10", "P11", "P12"].entries()) await r.add(name, 9 + i);
    const out = await generateStageFixtures(r.auth, r.stageId);
    expect(out.reconcile?.kind, "the premise: patched in place").toBe("in_place");
    expect(out.reconcile?.pins_cleared, "nothing dropped: the key is absent, not 0").toBeUndefined();
    expect(await storedOverrides(r.stageId)).toEqual([
      { entrant_id: r.id.get("P1")!, rank: 1, pool_id: ids.get("A")! },
      { entrant_id: r.id.get("P2")!, rank: 1, pool_id: ids.get("B")! },
    ]);
  });
});

describe.skipIf(!HAS_DB)("X-PO-3 fix round 1: a pin waits for its pool's results; a bare withdrawn flip drops her pin; a left entrant takes no pin", () => {
  /** pool key -> its lines (home/away names, id), oldest first. */
  async function linesOf(stageId: string, key: string): Promise<{ id: string; home: string; away: string }[]> {
    return sql<{ id: string; home: string; away: string }[]>`
      select f.id, h.display_name as home, a.display_name as away from fixtures f
        join pools p on p.id = f.pool_id join entrants h on h.id = f.home_entrant_id join entrants a on a.id = f.away_entrant_id
       where f.stage_id = ${stageId} and p.key = ${key} order by f.round_no, f.seq_in_round`;
  }
  const play = async (r: Rig, fixtureId: string, homeWins: boolean) => {
    await scoreEvent(r.auth, fixtureId, { expected_seq: 0, type: "core.start", payload: {} });
    await scoreEvent(r.auth, fixtureId, { expected_seq: 1, type: "generic.result", payload: { p1Score: homeWins ? 2 : 0, p2Score: homeWins ? 0 : 2 } });
  };

  // differential: today the pin below is written (rank 3 <= 4 seats), the engine then reads pool A as TWO entrants holding a result and
  // throws CONFIG_INVALID - from the pin POST's own recompute (after the commit), and from every later score in the pool.
  // W5 app PR B Task 1 (preflight C12): the pool is its SEATING now (engine 10 `TableStage.pools`), four rows from Start, so the
  // rank-3 pin fits the seated size at once - it no longer waits for the pool's results (was: "waits while only two hold a result").
  it("I-1 a rank-3 pin in a pool of four applies from the first result (the pool seats four): the pin is written, the next result scores, the pin still holds", async () => {
    const r = await rig({ n: 8, kind: "group", pools: 2, sport: GENERIC });
    const ids = await poolIds(r.stageId);
    await startDivision(r.auth, r.divisionId);
    const lines = await linesOf(r.stageId, "A");
    expect(lines, "the premise: a pool of four plays six lines").toHaveLength(6);
    const first = lines[0]!;
    const disjoint = lines.find((l) => ![first.home, first.away].includes(l.home) && ![first.home, first.away].includes(l.away));
    expect(disjoint, "the premise: a second line with the other two entrants").toBeDefined();
    await play(r, first.id, true);
    const pinned = r.id.get(first.away)!; // lost the first line
    await expect(overrideStandings(r.auth, r.stageId, { rows: [pin(pinned, 3)] }), "the pin POST must not throw after its commit").resolves.toEqual({ overridden: 1 });
    expect(await storedOverrides(r.stageId), "stored, waiting").toEqual([{ entrant_id: pinned, rank: 3, pool_id: ids.get("A")! }]);
    let rows = ((await getStandings(r.auth, r.stageId, ids.get("A")!)).rows as { entrantId: string; rankLocked?: boolean }[]);
    expect(rows, "the pool's four seats are its rows (C12: the seated size)").toHaveLength(4);
    expect([rows[2]!.entrantId, rows[2]!.rankLocked], "the pin applies at once: her place is third").toEqual([pinned, true]);
    await play(r, disjoint!.id, true); // before the I-1 fix: 422 CONFIG_INVALID, the score refused
    rows = ((await getStandings(r.auth, r.stageId, ids.get("A")!)).rows as { entrantId: string; rankLocked?: boolean }[]);
    expect(rows, "four rows after the second result").toHaveLength(4);
    expect([rows[2]!.entrantId, rows[2]!.rankLocked], "the pin still holds her third").toEqual([pinned, true]);
  });

  // differential: today the bare flip leaves her pin in the config, ranking a withdrawn entrant above the field of an open table
  it("d a bare PATCH withdrawn drops her pin before Start (both sports), and in an open started table the standings read without her pin", async () => {
    let checked = 0;
    for (const sport of SPORTS) {
      const r = await rig({ n: 4, kind: "league", sport });
      await overrideStandings(r.auth, r.stageId, { rows: [pin(r.id.get("P1")!, 2), pin(r.id.get("P2")!, 3)] });
      await patchEntrant(r.auth, r.id.get("P1")!, { status: "withdrawn" });
      expect(await storedOverrides(r.stageId), `${sport.key}: only the leaver's pin goes`).toEqual([{ entrant_id: r.id.get("P2")!, rank: 3, pool_id: null }]);
      checked++;
    }
    expect(checked).toBe(2);
    // Started and fully played but not completed: P3 loses every line (the lower name wins) and is pinned first; her bare withdrawal takes
    // the pin and the stored table is read again, so the head of the table is the best player, not her.
    const r = await rig({ n: 3, kind: "league", sport: GENERIC });
    await startDivision(r.auth, r.divisionId);
    const lines = await sql<{ id: string; home: string; away: string }[]>`
      select f.id, h.display_name as home, a.display_name as away from fixtures f
        join entrants h on h.id = f.home_entrant_id join entrants a on a.id = f.away_entrant_id where f.stage_id = ${r.stageId}`;
    for (const l of lines) await play(r, l.id, l.home < l.away);
    await overrideStandings(r.auth, r.stageId, { rows: [pin(r.id.get("P3")!, 1)] });
    const head = async () => ((await getStandings(r.auth, r.stageId)).rows as { entrantId: string }[])[0]!.entrantId;
    expect(await head(), "the premise: pinned first").toBe(r.id.get("P3")!);
    await patchEntrant(r.auth, r.id.get("P3")!, { status: "withdrawn" });
    expect(await storedOverrides(r.stageId)).toEqual([]);
    expect(await head(), "her pin no longer ranks her above the field").toBe(r.id.get("P1")!);
  });

  it("d a finished table keeps its pin through a bare withdrawn flip (RB5-L8), the pair of the case above", async () => {
    const r = await rig({ n: 3, kind: "league", sport: GENERIC });
    await startDivision(r.auth, r.divisionId);
    const lines = await sql<{ id: string }[]>`select id from fixtures where stage_id = ${r.stageId}`;
    for (const l of lines) await play(r, l.id, true);
    await overrideStandings(r.auth, r.stageId, { rows: [pin(r.id.get("P3")!, 1)] });
    await completeStage(r.auth, r.stageId);
    await patchEntrant(r.auth, r.id.get("P3")!, { status: "withdrawn" });
    expect(await storedOverrides(r.stageId)).toEqual([{ entrant_id: r.id.get("P3")!, rank: 1, pool_id: null }]);
  });

  it("b an open table refuses a pin naming an entrant who has left it, by name, nothing stored; the one still in the field is pinned", async () => {
    const r = await rig({ n: 4, kind: "league", sport: GENERIC });
    await withdrawEntrantCascade(r.auth, r.id.get("P1")!);
    const err = await refusal(overrideStandings(r.auth, r.stageId, { rows: [pin(r.id.get("P1")!, 2), pin(r.id.get("P2")!, 3)] }));
    expect(err.status).toBe(422);
    expect(err.message).toMatch(/no longer in the field/);
    expect(await storedOverrides(r.stageId), "nothing stored").toBeUndefined();
    expect(await overrideStandings(r.auth, r.stageId, { rows: [pin(r.id.get("P2")!, 3)] })).toEqual({ overridden: 1 });
  });
});

describe.skipIf(!HAS_DB)("X-PO-4 (RB5-P7, ruling 288): a pin on a stage with no table is refused by name", () => {
  /** The kinds the schema allows (`stages.kind`'s check constraint, current): read, never typed, so a new kind fails the classification below. */
  async function declaredKinds(): Promise<string[]> {
    const rows = await sql<{ def: string }[]>`
      select pg_get_constraintdef(c.oid) as def from pg_constraint c
        join pg_class t on t.oid = c.conrelid
       where t.relname = 'stages' and c.contype = 'c' and pg_get_constraintdef(c.oid) like '%kind%'`;
    const def = rows.map((r) => r.def).join(" ");
    return [...def.matchAll(/'([a-z_]+)'/g)].map((m) => m[1]!);
  }
  /** Hand-typed from the rulebook: which of the stage kinds rank a table. */
  const TABLE = ["league", "group", "swiss", "americano"];
  const NOT_TABLE = ["knockout", "double_elim", "stepladder", "page_playoff", "ladder"];

  it("X-PO-4 every stage kind is classified, and an override on each non-table kind is refused by name, nothing stored", async () => {
    const kinds = [...new Set(await declaredKinds())];
    expect(kinds.length, "anti-vacuity: the constraint names kinds").toBeGreaterThanOrEqual(NOT_TABLE.length - 1);
    for (const k of kinds) expect([...TABLE, ...NOT_TABLE], `kind ${k} is classified`).toContain(k);
    let checked = 0;
    const r = await rig({ n: 4, kind: "league" });
    for (const kind of NOT_TABLE.filter((k) => kinds.includes(k))) {
      // Inserted, not created: a stepladder or a page playoff needs a feeding table the usecase would demand, and the override reads only the kind.
      const [stage] = await sql<{ id: string }[]>`
        insert into stages (division_id, org_id, seq, kind, name, config)
        values (${r.divisionId}, ${r.auth.orgId}, ${2 + checked}, ${kind}, ${kind}, '{}'::jsonb) returning id`;
      const err = await refusal(overrideStandings(r.auth, stage!.id, { rows: [pin(r.id.get("P1")!, 1)] }));
      expect(err.status, kind).toBe(422);
      expect(err.code, kind).toBe("RR_RANK_OVERRIDE_NOT_TABLE");
      expect(await storedOverrides(stage!.id), `${kind}: nothing stored`).toBeUndefined();
      checked++;
    }
    expect(checked, "anti-vacuity: every non-table kind the schema declares").toBe(kinds.filter((k) => NOT_TABLE.includes(k)).length);
    expect(checked).toBeGreaterThan(0);
  });

  it("X-PO-4 the kinds that take a pin are the fold's own table kinds, and the rulebook's four (a kind added to one is added to both)", () => {
    expect([...RANK_OVERRIDE_TABLE_KINDS].sort()).toEqual([...TABLE_KINDS].sort());
    expect([...TABLE_KINDS].sort(), "anti-vacuity: the rulebook's four").toEqual([...TABLE].sort());
    expect(TABLE_KINDS.size).toBe(4);
  });

  it("X-PO-4 the positive pair: a league and a group stage still take an override", async () => {
    const l = await rig({ n: 4, kind: "league" });
    expect(await overrideStandings(l.auth, l.stageId, { rows: [pin(l.id.get("P1")!, 1)] })).toEqual({ overridden: 1 });
    const g = await rig({ n: 8, kind: "group", pools: 2 });
    expect(await overrideStandings(g.auth, g.stageId, { rows: [pin(g.id.get("P1")!, 1)] })).toEqual({ overridden: 1 });
  });
});

// W5 app-A Task 23 (Task 18 review: "Rebuild drops pins silently"): Rebuild drops the pins of every pool whose membership changed
// (T18) — and now SAYS how many, as Generate's redraw does (`pins_cleared`, additive on `RebuildResult`). Absent at zero, never 0.
// Expected counts from the snake of nine growing to ten (pool B changes, A does not), as the Generate case above.
describe.skipIf(!HAS_DB)("W5 T23 Rebuild reports the manual ranks it cleared", () => {
  it("a Rebuild that changes pool B clears B's one pin and says 1; A's pin stays", async () => {
    const r = await rig({ n: 9, kind: "group", pools: 2 });
    const ids = await poolIds(r.stageId);
    await overrideStandings(r.auth, r.stageId, { rows: [pin(r.id.get("P4")!, 1), pin(r.id.get("P3")!, 1)] });
    await r.add("P10", 10);
    const out = await rebuildStageFixtures(r.auth, r.stageId);
    expect(out.pins_cleared).toBe(1);
    expect(await storedOverrides(r.stageId)).toEqual([{ entrant_id: r.id.get("P4")!, rank: 1, pool_id: ids.get("A")! }]);
  });

  it("the empty cases: a Rebuild that moves nobody, and one with no pin at all, carry no pins_cleared key", async () => {
    const same = await rig({ n: 8, kind: "group", pools: 2 });
    await overrideStandings(same.auth, same.stageId, { rows: [pin(same.id.get("P1")!, 1)] });
    const kept = await rebuildStageFixtures(same.auth, same.stageId);
    expect("pins_cleared" in kept, "nothing moved: the key is absent").toBe(false);
    expect((await storedOverrides(same.stageId))?.length, "positive pair: the pin is still there").toBe(1);

    const bare = await rig({ n: 9, kind: "group", pools: 2 });
    await bare.add("P10", 10);
    expect("pins_cleared" in (await rebuildStageFixtures(bare.auth, bare.stageId))).toBe(false);
  });
});
