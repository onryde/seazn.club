// W5 app PR A, Task 2 (X-CU-6, X-BD-5, FX-G1 #879, FX-G21, #837; RB5-G7, RB5-G3, RB5-L17, RB5-E1, RB5-E2) — Generate over a league
// or group that already has its lines, driven through the real usecases on a real database.
//
// Main inserted a round robin's lines by their POSITIONAL `ext_key` alone: 4 → 6 inserted nine rows that repeated pairs already
// drawn and missed the pairs the newcomers owed; 3 → 4 did the same through a different round structure; after Start it kept
// inserting; an odd league's bye was thrown away at generate; and deleting a league entrant left its lines half-filled.
//
// Expected values: the ENGINE is the oracle (`generateRoundRobin`: its `fixtures[].leg`, its `rounds[].bye`), and the pair/leg
// key is the rulebook's (RB5-G7: the unordered pair, the leg, the pool). Hand-derived where the engine has no say: the seeded
// snake of a group (doc 05 §1), typed below. Never derived from the code under test.
import { afterAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { generateRoundRobin } from "@seazn/engine/scheduling";
import { builtinModules } from "@seazn/engine/sports";
import { entrantKindCap } from "@seazn/engine/sport";
import { sql } from "@/lib/db";
import { HttpError } from "@/lib/errors";
import { rrKey, rrLegOfExtKey } from "@/lib/roundrobin-reconcile";
import type { AuthCtx } from "@/server/api-v1/auth";
import { createCompetition } from "../competitions";
import { createDivision } from "../divisions";
import { createEntrants, deleteEntrant } from "../entrants";
import { undoDivision } from "../history";
import { startDivision } from "../schedule";
import { createStages, generateStageFixtures, rebuildStageFixtures } from "../stages";
import { withdrawEntrantCascade } from "../withdrawal";
import { seedCourts, seedOrg } from "./_seed";

const HAS_DB = !!process.env.DATABASE_URL;

afterAll(async () => {
  if (!HAS_DB) return;
  const globalForDb = globalThis as { _sql?: { end(): Promise<void> } };
  const client = globalForDb._sql;
  globalForDb._sql = undefined;
  await client?.end();
});

/** The plan's sentence (RB5-G7, task-2 brief), typed here: the refusal table is the code under test. */
const AFTER_START = "Play has started, so Generate won't change the fixtures. Use Add late player.";
/** Main's own copy (stages/generate-tx.ts, the `entrants.length < 2` refusal): X-BD-5's pin. */
const NOT_READY = "need at least 2 active entrants to generate";

interface SportPick {
  key: string;
  variant: string;
  kind: "individual" | "pair" | "team";
}
const BADMINTON: SportPick = { key: "badminton", variant: "bwf", kind: "individual" };
const BADMINTON_PAIRS: SportPick = { key: "badminton", variant: "bwf", kind: "pair" };
/** The second sport, from the engine's own declarations: its default entrant kind and first variant. */
const FOOTBALL: SportPick = (() => {
  const m = builtinModules.find((x) => x.key === "football");
  const variant = m === undefined ? undefined : Object.keys(m.variants)[0];
  if (m === undefined || variant === undefined) throw new Error("the engine declares no football module");
  return { key: m.key, variant, kind: (m.entrantModel?.defaultKind ?? "team") as SportPick["kind"] };
})();

/** An entrant of the sport's own kind: one inline person per seat, at most two (`entrantKindCap`). */
function entrantInput(kind: SportPick["kind"], name: string, seed: number | null) {
  const seats = Math.min(2, entrantKindCap(kind));
  return {
    kind,
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
  /** Entrant ids in creation order (`P1`, `P2`, ...). */
  ids: string[];
  legs: number;
  add(name: string, seed?: number | null): Promise<string>;
}

/** A division of `n` seeded entrants (seed = position) and one root league or group stage, generated unless told not to. */
async function rig(opts: {
  n: number;
  kind?: "league" | "group";
  pools?: number;
  legs?: number;
  sport?: SportPick;
  seeds?: (number | null)[];
  generate?: boolean;
}): Promise<Rig> {
  const sport = opts.sport ?? BADMINTON;
  const legs = opts.legs ?? 1;
  const { auth } = await seedOrg("pro");
  const comp = await createCompetition(auth, { ends_on: "2030-12-31", name: "W5 T2 " + randomUUID().slice(0, 6), visibility: "private", branding: {} });
  const division = await createDivision(auth, comp.id, {
    name: "Open",
    slug: "open-" + randomUUID().slice(0, 6),
    sport_key: sport.key,
    variant_key: sport.variant,
    config: {},
  });
  const made =
    opts.n === 0
      ? []
      : await createEntrants(
          auth,
          division.id,
          Array.from({ length: opts.n }, (_, i) => entrantInput(sport.kind, `P${i + 1}`, opts.seeds ? (opts.seeds[i] ?? null) : i + 1)),
        );
  const [stage] = await createStages(auth, division.id, {
    seq: 1,
    kind: opts.kind ?? "league",
    name: "Table",
    config: { ...(legs > 1 ? { legs } : {}), ...(opts.pools ? { pools: { count: opts.pools } } : {}) },
    progression: null,
  });
  if (opts.generate !== false) await generateStageFixtures(auth, stage!.id);
  return {
    auth,
    divisionId: division.id,
    stageId: stage!.id,
    sport,
    legs,
    ids: made.map((e) => e.id),
    add: async (name, seed = null) => (await createEntrants(auth, division.id, [entrantInput(sport.kind, name, seed)]))[0]!.id,
  };
}

interface Row {
  id: string;
  ext_key: string | null;
  pool_id: string | null;
  round_no: number;
  seq_in_round: number;
  home_entrant_id: string | null;
  away_entrant_id: string | null;
  status: string;
  scheduled_at: Date | null;
  court_id: string | null;
}

async function rowsOf(stageId: string): Promise<Row[]> {
  return sql<Row[]>`
    select id, ext_key, pool_id, round_no, seq_in_round, home_entrant_id, away_entrant_id, status, scheduled_at, court_id
    from fixtures where stage_id = ${stageId}
    order by pool_id nulls first, round_no, seq_in_round`;
}

/** The (pair, leg, pool) key of a STORED row — its leg read off the stored `ext_key`, which must carry one. */
function keyOfRow(r: Row): string {
  const leg = rrLegOfExtKey(r.ext_key);
  if (leg === null) throw new Error(`row ${r.id} (${r.ext_key}) stores no leg`);
  return rrKey(r.home_entrant_id!, r.away_entrant_id!, leg, r.pool_id);
}

/** The engine's own keys for a field in one pool. */
function engineKeys(ids: readonly string[], legs: number, pool: string | null = null): string[] {
  return generateRoundRobin({ entrants: [...ids], config: { legs } }).fixtures.map((f) => rrKey(f.home, f.away, f.leg, pool));
}

const sorted = (xs: readonly string[]) => [...xs].sort();

/** The stored lines' multiset of keys, sorted: duplicates stay visible. */
async function storedKeys(stageId: string): Promise<string[]> {
  return sorted((await rowsOf(stageId)).map(keyOfRow));
}

/** No entrant sits twice in one (pool, round) of the stored table. Returns how many seats it checked. */
function expectNoDoubleBooking(rows: readonly Row[], label: string): number {
  const seen = new Set<string>();
  let seats = 0;
  for (const r of rows) {
    for (const e of [r.home_entrant_id, r.away_entrant_id]) {
      if (e === null) continue;
      const at = `${r.pool_id ?? ""}|${r.round_no}|${e}`;
      expect(seen.has(at), `${label}: ${e} twice in round ${r.round_no}`).toBe(false);
      seen.add(at);
      seats++;
    }
  }
  return seats;
}

interface RoundBye {
  pool: string | null;
  round_no: number;
  leg: number;
  entrant_id: string;
}
async function roundByesOf(stageId: string): Promise<RoundBye[] | undefined> {
  const [row] = await sql<{ config: { round_byes?: RoundBye[] } }[]>`select config from stages where id = ${stageId}`;
  return row!.config.round_byes;
}

/** The engine's byes for a field: every `rounds[].bye`, with its round and leg. */
function engineByes(ids: readonly string[], legs: number): { round_no: number; leg: number; entrant_id: string }[] {
  return generateRoundRobin({ entrants: [...ids], config: { legs } }).rounds.flatMap((r) =>
    r.bye === undefined ? [] : [{ round_no: r.roundNo, leg: r.leg, entrant_id: r.bye }],
  );
}

const bySlot = <T extends { round_no: number; leg: number; entrant_id: string }>(xs: readonly T[]) =>
  [...xs].sort((a, b) => a.round_no - b.round_no || a.entrant_id.localeCompare(b.entrant_id));

async function refusal(p: Promise<unknown>): Promise<HttpError> {
  const err = await p.then(
    () => null,
    (e: unknown) => e,
  );
  expect(err, "a refusal").toBeInstanceOf(HttpError);
  return err as HttpError;
}

describe.skipIf(!HAS_DB)("X-CU-6 / FX-G1: Generate before Start reconciles a league by (pair, leg)", () => {
  // differential: today the positional insert adds 9 rows that duplicate ad, ac, bd, ab, cd and miss af, be, ae, ce, bf — run 2026-11-16
  for (const legs of [1, 2]) {
    it(`X-CU-6 FX-G1 4→6: Generate adds exactly the missing pairs and duplicates none (legs ${legs})`, async () => {
      const r = await rig({ n: 4, legs });
      const before = await rowsOf(r.stageId);
      expect(before).toHaveLength(6 * legs);
      await r.add("P5", 5);
      await r.add("P6", 6);
      const all = [...r.ids, ...(await sql<{ id: string }[]>`select id from entrants where division_id = ${r.divisionId} and display_name in ('P5','P6')`).map((e) => e.id)];
      expect(all).toHaveLength(6);

      const out = await generateStageFixtures(r.auth, r.stageId);
      // C(6,2) - C(4,2) = 9 new pairs, per leg.
      expect(out.created, "nine new pairs per leg").toBe(9 * legs);
      expect(out.reconcile?.kind).toBe("in_place");

      const after = await rowsOf(r.stageId);
      // The multiset of keys is the engine's schedule of six, once each: nothing twice, nothing missing.
      expect(await storedKeys(r.stageId)).toEqual(sorted(engineKeys(all, legs)));
      expect(after).toHaveLength(15 * legs);
      // The four players' old lines are the SAME rows (patched in, never redrawn).
      const afterIds = new Set(after.map((x) => x.id));
      expect(before.every((b) => afterIds.has(b.id)), "the old lines survive").toBe(true);
      // Every stored line carries its leg, and a patched table never seats a player twice in a round.
      expect(after.every((x) => rrLegOfExtKey(x.ext_key) !== null)).toBe(true);
      expect(expectNoDoubleBooking(after, `legs ${legs}`)).toBe(after.length * 2);
    });
  }

  // differential: today 3 -> 4 inserts by position into a different round structure — duplicates and gaps
  it("X-CU-6 FX-G1 3→4 regenerates once with times and courts carried by pair", async () => {
    const r = await rig({ n: 3 });
    const courts = await seedCourts(r.auth.orgId, 3);
    const first = await rowsOf(r.stageId);
    expect(first).toHaveLength(3);
    // Give every pair its own time and court, recorded BY PAIR before the Generate.
    const slotOfPair = new Map<string, { at: string; court: string }>();
    for (const [i, row] of first.entries()) {
      const at = `2030-06-1${i + 1}T10:00:00.000Z`;
      await sql`update fixtures set scheduled_at = ${at}, court_id = ${courts[i]!} where id = ${row.id}`;
      slotOfPair.set(keyOfRow(row), { at, court: courts[i]! });
    }
    const fourth = await r.add("P4", 4);

    const out = await generateStageFixtures(r.auth, r.stageId);
    expect(out.reconcile?.kind, "an odd field gaining one is a parity flip: drawn again, once").toBe("regenerated");
    const after = await rowsOf(r.stageId);
    expect(await storedKeys(r.stageId)).toEqual(sorted(engineKeys([...r.ids, fourth], 1)));
    const oldIds = new Set(first.map((x) => x.id));
    expect(after.some((x) => oldIds.has(x.id)), "every line is new: the stage was drawn again").toBe(false);
    let carried = 0;
    for (const row of after) {
      const want = slotOfPair.get(keyOfRow(row));
      if (want === undefined) {
        // A pair that did not exist before has no slot to inherit.
        expect([row.scheduled_at, row.court_id], `${keyOfRow(row)} is new`).toEqual([null, null]);
        continue;
      }
      expect(row.scheduled_at?.toISOString(), `${keyOfRow(row)} keeps its time`).toBe(want.at);
      expect(row.court_id, `${keyOfRow(row)} keeps its court`).toBe(want.court);
      carried++;
    }
    expect(carried, "the three surviving pairs").toBe(3);
    expect(after).toHaveLength(6);
    expect(expectNoDoubleBooking(after, "3→4")).toBe(12);
  });

  it("X-CU-6 a second Generate with no roster change is a named no-op (pin, no defect expected)", async () => {
    const r = await rig({ n: 5, legs: 2 });
    const before = await rowsOf(r.stageId);
    const byesBefore = await roundByesOf(r.stageId);
    for (const call of [1, 2]) {
      const out = await generateStageFixtures(r.auth, r.stageId);
      expect(out.reconcile, `call ${call}`).toEqual({ kind: "noop", placed: [], vacated: [], vacated_seats: 0 });
      expect(out.created, `call ${call}`).toBe(0);
      expect(out.existing, `call ${call}`).toBe(before.length);
      expect(await rowsOf(r.stageId), `call ${call}: rows byte-equal`).toEqual(before);
      expect(await roundByesOf(r.stageId), `call ${call}: byes untouched`).toEqual(byesBefore);
    }
  });

  it("X-CU-6 a withdrawal before Start then Generate: an even field losing two drops exactly their pairs; an odd result is drawn again", async () => {
    const r = await rig({ n: 6 });
    await withdrawEntrantCascade(r.auth, r.ids[4]!);
    await withdrawEntrantCascade(r.auth, r.ids[5]!);
    const out = await generateStageFixtures(r.auth, r.stageId);
    expect(out.reconcile?.kind).toBe("in_place");
    expect(out.reconcile?.vacated.sort()).toEqual([r.ids[4]!, r.ids[5]!].sort());
    expect(await storedKeys(r.stageId)).toEqual(sorted(engineKeys(r.ids.slice(0, 4), 1)));
    // 6 -> 5 withdrawn one: odd, drawn again.
    const r2 = await rig({ n: 6 });
    await withdrawEntrantCascade(r2.auth, r2.ids[5]!);
    const out2 = await generateStageFixtures(r2.auth, r2.stageId);
    expect(out2.reconcile?.kind).toBe("regenerated");
    expect(await storedKeys(r2.stageId)).toEqual(sorted(engineKeys(r2.ids.slice(0, 5), 1)));
    expect(await roundByesOf(r2.stageId), "the new odd table's byes are recorded").toHaveLength(5);
  });

  it("X-CU-6 the differential holds on another sport (football teams) and a pair division (badminton doubles)", async () => {
    let checked = 0;
    for (const sport of [FOOTBALL, BADMINTON_PAIRS]) {
      const r = await rig({ n: 4, sport });
      await r.add("P5", 5);
      await r.add("P6", 6);
      const all = (await sql<{ id: string }[]>`select id from entrants where division_id = ${r.divisionId}`).map((e) => e.id);
      expect(all).toHaveLength(6);
      const out = await generateStageFixtures(r.auth, r.stageId);
      expect(out.created, `${sport.key}/${sport.kind}`).toBe(9);
      expect(await storedKeys(r.stageId), `${sport.key}/${sport.kind}`).toEqual(sorted(engineKeys(all, 1)));
      checked++;
    }
    expect(checked).toBe(2);
  });

  it("X-CU-6 a stage generated before the leg was stored (legacy `rr-r{n}-c{m}` keys) reads as unchanged, never duplicated", async () => {
    const r = await rig({ n: 4, legs: 2 });
    const before = await rowsOf(r.stageId);
    // The pre-change writer's shape: the engine's positional id, no leg.
    await sql`update fixtures set ext_key = regexp_replace(ext_key, '-L[0-9]+$', '') where stage_id = ${r.stageId}`;
    const stripped = await rowsOf(r.stageId);
    expect(stripped.every((x) => rrLegOfExtKey(x.ext_key) === null), "premise: no row stores a leg").toBe(true);
    const out = await generateStageFixtures(r.auth, r.stageId);
    expect(out.reconcile?.kind).toBe("noop");
    expect(out.created).toBe(0);
    expect((await rowsOf(r.stageId)).map((x) => x.id)).toEqual(before.map((x) => x.id));
  });

  // The fed path keeps its positional insert (a stage drawn from `config.qualified` is not reconciled by pair); a line it drew
  // before the leg was stored is the SAME line its next pass would write with a leg, so it is not written a second time.
  // differential: without the legacy-key tolerance this pass inserts six lines beside the six it already holds
  it("X-CU-6 a fed league with legacy keys is not drawn twice by the positional insert", async () => {
    const r = await rig({ n: 4 });
    const before = await rowsOf(r.stageId);
    expect(before).toHaveLength(6);
    await sql`update fixtures set ext_key = regexp_replace(ext_key, '-L[0-9]+$', '') where stage_id = ${r.stageId}`;
    await sql`update stages set config = config || ${sql.json({ qualified: r.ids } as never)} where id = ${r.stageId}`;
    const out = await generateStageFixtures(r.auth, r.stageId);
    const after = await rowsOf(r.stageId);
    expect(after, "no line written a second time").toHaveLength(6);
    expect(after.map((x) => x.id).sort()).toEqual(before.map((x) => x.id).sort());
    expect(out.created).toBe(0);
  });
});

describe.skipIf(!HAS_DB)("X-CU-6 RB5-L17: a group stage re-snakes before Start", () => {
  // The seeded snake of doc 05 §1, written by hand: seeds 1..9 into two pools run 1→A 2→B | 3→B 4→A | 5→A 6→B | 7→B 8→A | 9→A.
  const SNAKE_9 = { A: [1, 4, 5, 8, 9], B: [2, 3, 6, 7] };

  async function poolsOfStage(stageId: string): Promise<Map<string, string>> {
    const rows = await sql<{ key: string; entrant: string }[]>`
      select p.key, e.display_name as entrant from pools p
        join fixtures f on f.pool_id = p.id
        join entrants e on e.id in (f.home_entrant_id, f.away_entrant_id)
       where p.stage_id = ${stageId}
       group by p.key, e.display_name`;
    return new Map(rows.map((x) => [x.entrant, x.key]));
  }

  // differential: today the positional insert adds a pool's new rows beside the old ones and never moves a player between pools
  it("X-CU-6 a group stage re-snakes on a pre-Start add (a newcomer seeded 1 moves everyone: pools after = the snake of the new roster)", async () => {
    // Seeds 2..9 now; the newcomer takes seed 1, so every existing player moves down one place in the snake.
    const r = await rig({ n: 8, kind: "group", pools: 2, seeds: [2, 3, 4, 5, 6, 7, 8, 9] });
    // Entrants are named by their creation order; the seed is what the snake reads.
    const seedOfName = new Map<string, number>([
      ["P1", 2], ["P2", 3], ["P3", 4], ["P4", 5], ["P5", 6], ["P6", 7], ["P7", 8], ["P8", 9],
    ]);
    const before = await poolsOfStage(r.stageId);
    expect(before.size).toBe(8);
    await r.add("P9", 1);
    seedOfName.set("P9", 1);
    const out = await generateStageFixtures(r.auth, r.stageId);
    expect(out.reconcile?.kind, "a player changed pool: drawn again").toBe("regenerated");
    const after = await poolsOfStage(r.stageId);
    expect(after.size).toBe(9);
    let checked = 0;
    for (const [name, key] of after) {
      const seed = seedOfName.get(name)!;
      expect(SNAKE_9[key as "A" | "B"], `${name} (seed ${seed}) is in pool ${key}`).toContain(seed);
      checked++;
    }
    expect(checked).toBe(9);
    // A player really moved (the premise that makes this a re-snake, not a growth): the old seed-2 player was in pool A.
    expect(before.get("P1")).toBe("A");
    expect(after.get("P1")).toBe("B");
    // And each pool's lines are its own round robin, once each.
    const rows = await rowsOf(r.stageId);
    expect(rows).toHaveLength(10 + 6);
    expect(new Set(rows.map(keyOfRow)).size, "no pair twice").toBe(16);
    expect(expectNoDoubleBooking(rows, "re-snake")).toBe(32);
  });

  it("X-CU-6 two pools of four growing to six (nobody moves, parity kept) patch each pool by its own missing pairs", async () => {
    const r = await rig({ n: 8, kind: "group", pools: 2 });
    const before = await rowsOf(r.stageId);
    expect(before).toHaveLength(12);
    const poolIds = [...new Set(before.map((x) => x.pool_id))];
    expect(poolIds).toHaveLength(2);
    for (const [i, name] of ["P9", "P10", "P11", "P12"].entries()) await r.add(name, 9 + i);
    const out = await generateStageFixtures(r.auth, r.stageId);
    // Seeds 9..12 continue the snake without moving seeds 1..8 (A gets 9 and 12, B gets 10 and 11): 2 x (15 - 6) new lines.
    expect(out.reconcile?.kind).toBe("in_place");
    expect(out.created).toBe(18);
    const after = await rowsOf(r.stageId);
    expect(after).toHaveLength(30);
    const byPool = new Map<string, Row[]>();
    for (const row of after) byPool.set(row.pool_id!, [...(byPool.get(row.pool_id!) ?? []), row]);
    expect([...byPool.values()].map((x) => x.length)).toEqual([15, 15]);
    for (const rows of byPool.values()) {
      const members = new Set(rows.flatMap((x) => [x.home_entrant_id!, x.away_entrant_id!]));
      expect(members.size).toBe(6);
      expect(sorted(rows.map(keyOfRow)), "each pool is its own round robin, once each").toEqual(sorted(engineKeys([...members], 1, rows[0]!.pool_id)));
    }
    expect(expectNoDoubleBooking(after, "grown pools")).toBe(60);
  });
});

describe.skipIf(!HAS_DB)("X-CU-6 after Start Generate never reshapes", () => {
  async function started(n: number, legs = 1): Promise<Rig> {
    const r = await rig({ n, legs });
    await startDivision(r.auth, r.divisionId);
    return r;
  }

  // differential: today the positional insert runs after Start and adds rows for the arrival
  it("X-CU-6 after Start Generate never reshapes: an arrival → RR_GENERATE_AFTER_START, rows byte-equal", async () => {
    for (const sport of [BADMINTON, FOOTBALL]) {
      const r = await rig({ n: 4, sport });
      await startDivision(r.auth, r.divisionId);
      const [org] = await sql<{ org_id: string }[]>`select org_id from divisions where id = ${r.divisionId}`;
      await sql`insert into entrants (org_id, division_id, kind, display_name) values (${org!.org_id}, ${r.divisionId}, ${sport.kind}, 'Arrival')`;
      const before = await rowsOf(r.stageId);
      const byes = await roundByesOf(r.stageId);
      const err = await refusal(generateStageFixtures(r.auth, r.stageId));
      expect([err.status, err.code, err.message], sport.key).toEqual([409, "RR_GENERATE_AFTER_START", AFTER_START]);
      expect(await rowsOf(r.stageId), `${sport.key}: rows byte-equal`).toEqual(before);
      expect(await roundByesOf(r.stageId), `${sport.key}: byes untouched`).toEqual(byes);
    }
  });

  it("X-CU-6 after Start an unchanged roster is the named no-op twice, and so is a withdrawal (the cascade already walked it over)", async () => {
    const r = await started(5);
    const before = await rowsOf(r.stageId);
    for (const call of [1, 2]) {
      const out = await generateStageFixtures(r.auth, r.stageId);
      expect(out.reconcile, `call ${call}`).toEqual({ kind: "noop", placed: [], vacated: [], vacated_seats: 0 });
      expect(await rowsOf(r.stageId), `call ${call}`).toEqual(before);
    }
    await withdrawEntrantCascade(r.auth, r.ids[0]!);
    const afterWithdrawal = await rowsOf(r.stageId);
    for (const call of [1, 2]) {
      const out = await generateStageFixtures(r.auth, r.stageId);
      expect(out.reconcile?.kind, `withdrawal call ${call}`).toBe("noop");
      expect(await rowsOf(r.stageId), `withdrawal call ${call}: never reshaped`).toEqual(afterWithdrawal);
    }
  });
});

describe.skipIf(!HAS_DB)("FX-G21: an odd league persists one bye per round from the engine schedule", () => {
  // differential: today nothing persisted — `roundRobinGen` dropped `rounds[].bye`
  it("FX-G21 an odd league persists one bye per round from the engine schedule (5 teams, 2 legs → 10 entries, each entrant twice)", async () => {
    const r = await rig({ n: 5, legs: 2 });
    const byes = await roundByesOf(r.stageId);
    expect(byes, "round_byes is written").toBeDefined();
    expect(byes).toHaveLength(10);
    // The engine's own schedule over the same field in seed order (the rig seeds P1..P5 as 1..5).
    const expected = engineByes(r.ids, 2);
    expect(expected, "premise: the engine emits one bye per round").toHaveLength(10);
    expect(bySlot(byes!.map(({ round_no, leg, entrant_id }) => ({ round_no, leg, entrant_id })))).toEqual(bySlot(expected));
    expect(byes!.every((b) => b.pool === null)).toBe(true);
    // Each entrant sits out once per leg: twice in all.
    const perEntrant = new Map<string, number>();
    for (const b of byes!) perEntrant.set(b.entrant_id, (perEntrant.get(b.entrant_id) ?? 0) + 1);
    expect([...perEntrant.values()]).toEqual([2, 2, 2, 2, 2]);
    // A bye never holds a fixture: the round's five players are two lines and the one on the bye.
    const rows = await rowsOf(r.stageId);
    for (const b of byes!) {
      expect(rows.filter((x) => x.round_no === b.round_no && (x.home_entrant_id === b.entrant_id || x.away_entrant_id === b.entrant_id))).toHaveLength(0);
    }
  });

  it("FX-G21 an even league records no bye (6 teams → [])", async () => {
    const r = await rig({ n: 6, legs: 2 });
    expect(await roundByesOf(r.stageId)).toEqual([]);
  });

  it("FX-G21 another sport (football) persists its odd league's byes too, and Rebuild rewrites them wholesale", async () => {
    const r = await rig({ n: 5, sport: FOOTBALL });
    expect(bySlot((await roundByesOf(r.stageId))!.map(({ round_no, leg, entrant_id }) => ({ round_no, leg, entrant_id })))).toEqual(bySlot(engineByes(r.ids, 1)));
    // A sixth player and a Rebuild: the stage is even now, and the stored byes say so.
    await r.add("P6", 6);
    await rebuildStageFixtures(r.auth, r.stageId);
    expect(await roundByesOf(r.stageId)).toEqual([]);
  });
});

describe.skipIf(!HAS_DB)("X-BD-5: an empty field is refused by name, never 'up to date'", () => {
  // pin: the 0/1-entrant refusal is main's own (generate-tx.ts, `entrants.length < 2`); the third case guards the new branch.
  it(`X-BD-5 0 entrants: Generate refuses by name, never "up to date"`, async () => {
    const r = await rig({ n: 0, generate: false });
    await expect(generateStageFixtures(r.auth, r.stageId)).rejects.toMatchObject({ code: "STAGE_NOT_READY", message: NOT_READY });
    expect(await rowsOf(r.stageId)).toEqual([]);
  });

  it("X-BD-5 1 entrant: Generate refuses by name", async () => {
    const r = await rig({ n: 1, generate: false });
    await expect(generateStageFixtures(r.auth, r.stageId)).rejects.toMatchObject({ code: "STAGE_NOT_READY", message: NOT_READY });
    expect(await rowsOf(r.stageId)).toEqual([]);
  });

  // differential: guards the new branch; today the positional path refuses at generate-tx.ts's `entrants.length < 2`
  it("X-BD-5 a stage with lines whose roster fell to 1 before Start refuses, never patches to empty", async () => {
    for (const sport of [BADMINTON, FOOTBALL]) {
      const r = await rig({ n: 2, sport });
      const before = await rowsOf(r.stageId);
      expect(before).toHaveLength(1);
      await withdrawEntrantCascade(r.auth, r.ids[1]!);
      await expect(generateStageFixtures(r.auth, r.stageId), sport.key).rejects.toMatchObject({ code: "STAGE_NOT_READY", message: NOT_READY });
      expect(await rowsOf(r.stageId), `${sport.key}: never patched to empty`).toEqual(before);
    }
  });
});

describe.skipIf(!HAS_DB)("#837 / G7: deleting a league entrant before Start drops its lines and its bye entries", () => {
  // differential: none — the entries are written by this task, so the test is red until the delete hook removes them
  it("X-CU-6 a pre-Start delete leaves no round_byes entry for the victim", async () => {
    const r = await rig({ n: 5, legs: 2 });
    const victim = r.ids[2]!;
    const before = (await roundByesOf(r.stageId))!;
    expect(before.filter((b) => b.entrant_id === victim), "premise: the victim sits out twice").toHaveLength(2);
    await deleteEntrant(r.auth, victim);
    const after = (await roundByesOf(r.stageId))!;
    expect(after.filter((b) => b.entrant_id === victim)).toHaveLength(0);
    // Everybody else's entries are intact.
    expect(after).toHaveLength(before.length - 2);
    expect(after).toEqual(before.filter((b) => b.entrant_id !== victim));
    // The victim's lines went with it: 4 players, 2 legs.
    expect(await rowsOf(r.stageId), "C(4,2) pairs x 2 legs").toHaveLength(12);
  });

  it("X-CU-6 Generate after a pre-Start delete is one regenerate when the parity flipped, then a named no-op", async () => {
    // 5 -> 4: odd to even. The surviving lines are exactly the fresh pairs, so only the stored byes can say the table was drawn
    // for another size.
    const r = await rig({ n: 5 });
    await deleteEntrant(r.auth, r.ids[4]!);
    expect(await rowsOf(r.stageId)).toHaveLength(6);
    const first = await generateStageFixtures(r.auth, r.stageId);
    expect(first.reconcile?.kind).toBe("regenerated");
    expect(await storedKeys(r.stageId)).toEqual(sorted(engineKeys(r.ids.slice(0, 4), 1)));
    expect(await roundByesOf(r.stageId), "four players sit out nobody").toEqual([]);
    const second = await generateStageFixtures(r.auth, r.stageId);
    expect(second.reconcile?.kind).toBe("noop");
    expect(second.created).toBe(0);
  });

  it("X-CU-6 two deletes from an even league leave the parity kept: Generate is the named no-op, never a redraw", async () => {
    const r = await rig({ n: 6 });
    await deleteEntrant(r.auth, r.ids[4]!);
    await deleteEntrant(r.auth, r.ids[5]!);
    const before = await rowsOf(r.stageId);
    expect(before).toHaveLength(6);
    const out = await generateStageFixtures(r.auth, r.stageId);
    expect(out.reconcile?.kind).toBe("noop");
    expect(await rowsOf(r.stageId)).toEqual(before);
  });

  it("X-CU-6 a delete in a group's pool drops that pool's lines only; the other pool is untouched", async () => {
    const r = await rig({ n: 8, kind: "group", pools: 2 });
    const before = await rowsOf(r.stageId);
    const victim = before[0]!.home_entrant_id!;
    const victimPool = before[0]!.pool_id;
    await deleteEntrant(r.auth, victim);
    const after = await rowsOf(r.stageId);
    expect(after.filter((x) => x.pool_id === victimPool)).toHaveLength(6 - 3);
    expect(after.filter((x) => x.pool_id !== victimPool)).toEqual(before.filter((x) => x.pool_id !== victimPool));
    expect(after.every((x) => x.home_entrant_id !== null && x.away_entrant_id !== null)).toBe(true);
  });

  it("X-CU-6 a delete is refused while a line of the entrant carries recorded match data, and nothing is dropped", async () => {
    const r = await rig({ n: 4 });
    const rows = await rowsOf(r.stageId);
    const victim = rows[0]!.home_entrant_id!;
    await sql`update fixtures set config_snapshot = ${sql.json({ bestOf: 3 } as never)}, config_snapshot_at = now() where id = ${rows[0]!.id}`;
    const err = await refusal(deleteEntrant(r.auth, victim));
    expect(err.status).toBe(409);
    expect(await rowsOf(r.stageId)).toEqual(rows);
    const [still] = await sql<{ id: string }[]>`select id from entrants where id = ${victim}`;
    expect(still?.id).toBe(victim);
  });
});

describe.skipIf(!HAS_DB)("X-CU-6 a patched Generate is undoable", () => {
  it("X-CU-6 Undo takes back exactly the lines a patched Generate inserted", async () => {
    const r = await rig({ n: 4 });
    const before = await rowsOf(r.stageId);
    await r.add("P5", 5);
    await r.add("P6", 6);
    const out = await generateStageFixtures(r.auth, r.stageId);
    expect(out.created).toBe(9);
    await undoDivision(r.auth, r.divisionId);
    expect((await rowsOf(r.stageId)).map((x) => x.id)).toEqual(before.map((x) => x.id));
  });
});
