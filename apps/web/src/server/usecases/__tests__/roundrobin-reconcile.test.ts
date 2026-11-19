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
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { generateRoundRobin } from "@seazn/engine/scheduling";
import { builtinModules } from "@seazn/engine/sports";
import { entrantKindCap } from "@seazn/engine/sport";
import { sql, withTenant } from "@/lib/db";
import { HttpError } from "@/lib/errors";
import { ROUND_ROBIN_REFUSALS } from "@/lib/roundrobin-refusals";
import { isRrExtKey, rrKey, rrLegOfExtKey } from "@/lib/roundrobin-reconcile";
import type { AuthCtx } from "@/server/api-v1/auth";
import { createCompetition } from "../competitions";
import { createDivision } from "../divisions";
import { createEntrants, deleteEntrant } from "../entrants";
import { undoDivision } from "../history";
import { startDivision } from "../schedule";
import { addFixture, createStages, generateStageFixtures, generateStageFixturesTx, rebuildStageFixtures } from "../stages";
import { withdrawEntrantCascade } from "../withdrawal";
import { CHESS_SEAT_REF_TYPE, chessSeatRef } from "../external-play/seat-stamp";
import { seedCourts, seedOrg } from "./_seed";

const HAS_DB = !!process.env.DATABASE_URL;

// A pre-Start entrant delete refreshes the public pages after it commits; the names of the fixture ids it passes are what #4
// of the Task-2 review pins (the removed lines' match-centre documents), so the drop is spied and everything else stays real.
const fireScoreRevalidate = vi.hoisted(() => vi.fn(async () => {}));
const dropNamedPublicDocuments = vi.hoisted(() => vi.fn());
vi.mock("@/server/public-site/revalidate", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/server/public-site/revalidate")>()),
  fireScoreRevalidate,
  dropNamedPublicDocuments,
}));

afterAll(async () => {
  if (!HAS_DB) return;
  const globalForDb = globalThis as { _sql?: { end(): Promise<void> } };
  const client = globalForDb._sql;
  globalForDb._sql = undefined;
  await client?.end();
});

/** The plan's sentence (RB5-G7, task-2 brief), typed here: the refusal table is the code under test. */
const AFTER_START = "Play has started, so Generate won't change the fixtures. Players waiting to join are listed on this stage: use Add to the table.";
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

/** An official on a line: organiser setup a redraw would clear (`fixture_officials` goes with the line). */
async function attachOfficial(auth: AuthCtx, fixtureId: string): Promise<void> {
  const [person] = await sql<{ id: string }[]>`insert into persons (org_id, full_name) values (${auth.orgId}, ${"Ref " + randomUUID().slice(0, 6)}) returning id`;
  const [official] = await sql<{ id: string }[]>`
    insert into officials (org_id, person_id, display_name, role_keys)
    values (${auth.orgId}, ${person!.id}, 'Ref X', ${sql.json(["referee"])}) returning id`;
  await sql`insert into fixture_officials (org_id, fixture_id, official_id, role_key, response)
            values (${auth.orgId}, ${fixtureId}, ${official!.id}, 'referee', 'accepted')`;
}
async function officialsOn(stageId: string): Promise<number> {
  const [row] = await sql<{ n: number }[]>`
    select count(*)::int as n from fixture_officials fo join fixtures f on f.id = fo.fixture_id where f.stage_id = ${stageId}`;
  return row!.n;
}
/** The first line both of whose players are in `among` (default: any line): the line a roster change here keeps. */
async function keptLine(stageId: string, among?: readonly string[]): Promise<Row> {
  const line = (await rowsOf(stageId)).find((x) => among === undefined || (among.includes(x.home_entrant_id!) && among.includes(x.away_entrant_id!)));
  if (line === undefined) throw new Error("test: no line among the kept players");
  return line;
}
/** The engine's own count of rounds for a field: what a fresh draw spans. */
const freshSpan = (ids: readonly string[], legs: number): number => Math.max(...generateRoundRobin({ entrants: [...ids], config: { legs } }).fixtures.map((f) => f.roundNo));
const spanOf = (rows: readonly Row[]): number => Math.max(...rows.map((r) => r.round_no));

beforeEach(() => {
  fireScoreRevalidate.mockClear();
  dropNamedPublicDocuments.mockClear();
});

describe.skipIf(!HAS_DB)("X-CU-6 / FX-G1: Generate before Start reconciles a league by (pair, leg)", () => {
  // differential: today the positional insert adds 9 rows that duplicate ad, ac, bd, ab, cd and miss af, be, ae, ce, bf — run 2026-11-16
  // rulebook silent on round count; X-CU-6 keeps lines: a league patch keeps every surviving line (the same rows) and adds only the
  // missing pairs, however many rounds that makes.
  for (const legs of [1, 2]) {
    for (const withOfficial of [false, true]) {
      it(`X-CU-6 FX-G1 4→6${withOfficial ? " over an official on a surviving line" : ""}: patched in place, nine pairs per leg, every old line kept (legs ${legs})`, async () => {
        const r = await rig({ n: 4, legs });
        const before = await rowsOf(r.stageId);
        expect(before).toHaveLength(6 * legs);
        if (withOfficial) await attachOfficial(r.auth, (await keptLine(r.stageId)).id);
        const all = [...r.ids, await r.add("P5", 5), await r.add("P6", 6)];
        expect(all).toHaveLength(6);

        const out = await generateStageFixtures(r.auth, r.stageId);
        // C(6,2) - C(4,2) = 9 new pairs, per leg.
        expect(out.created, "nine new pairs per leg").toBe(9 * legs);
        expect(out.reconcile?.kind).toBe("in_place");
        const after = await rowsOf(r.stageId);
        // The multiset of keys is the engine's schedule of six, once each: nothing twice, nothing missing.
        expect(await storedKeys(r.stageId)).toEqual(sorted(engineKeys(all, legs)));
        expect(after).toHaveLength(15 * legs);
        // The four players' old lines are the SAME rows, in the same rounds (patched in, never redrawn).
        const afterById = new Map(after.map((x) => [x.id, x]));
        for (const b of before) {
          const kept = afterById.get(b.id);
          expect(kept, `the line ${b.id} survives`).toBeDefined();
          expect([kept!.round_no, kept!.seq_in_round, kept!.ext_key], `the line ${b.id} is untouched`).toEqual([b.round_no, b.seq_in_round, b.ext_key]);
        }
        if (withOfficial) expect(await officialsOn(r.stageId), "the official stays").toBe(1);
        expect(after.every((x) => rrLegOfExtKey(x.ext_key) !== null)).toBe(true);
        expect(expectNoDoubleBooking(after, `legs ${legs}`)).toBe(after.length * 2);
        // The round count may grow past a fresh draw's (rulebook silent): the lines are kept all the same.
        expect(spanOf(after), "rounds").toBeGreaterThanOrEqual(freshSpan(all, legs));
        // A second Generate after a patch is the named no-op: every key is present, nothing is written.
        const again = await generateStageFixtures(r.auth, r.stageId);
        expect(again.reconcile?.kind).toBe("noop");
        expect(again.created).toBe(0);
        expect(await rowsOf(r.stageId)).toEqual(after);
      });
    }
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

  it("X-CU-6 a withdrawal before Start then Generate: an even field losing two drops exactly their pairs (with or without setup); an odd result is drawn again", async () => {
    let checked = 0;
    for (const withOfficial of [false, true]) {
      const r = await rig({ n: 6 });
      const before = await rowsOf(r.stageId);
      if (withOfficial) await attachOfficial(r.auth, (await keptLine(r.stageId, r.ids.slice(0, 4))).id);
      await withdrawEntrantCascade(r.auth, r.ids[4]!);
      await withdrawEntrantCascade(r.auth, r.ids[5]!);
      const out = await generateStageFixtures(r.auth, r.stageId);
      expect(out.reconcile?.kind, `official ${withOfficial}`).toBe("in_place");
      expect(out.reconcile?.vacated.sort()).toEqual([r.ids[4]!, r.ids[5]!].sort());
      expect(await storedKeys(r.stageId)).toEqual(sorted(engineKeys(r.ids.slice(0, 4), 1)));
      // Every line between the four stays the same row.
      const afterIds = new Set((await rowsOf(r.stageId)).map((x) => x.id));
      const survivors = before.filter((b) => r.ids.slice(0, 4).includes(b.home_entrant_id!) && r.ids.slice(0, 4).includes(b.away_entrant_id!));
      expect(survivors).toHaveLength(6);
      expect(survivors.every((b) => afterIds.has(b.id)), "the surviving lines are kept").toBe(true);
      if (withOfficial) expect(await officialsOn(r.stageId), "the official stays").toBe(1);
      checked++;
    }
    expect(checked).toBe(2);
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
      expect(out.reconcile?.kind, `${sport.key}/${sport.kind}`).toBe("in_place");
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

  /** Two pools of four grown to six, nobody moving (seeds 9..12 continue the snake: A gets 9 and 12, B gets 10 and 11). */
  async function grownPools(sport: SportPick, withOfficial: boolean) {
    const r = await rig({ n: 8, kind: "group", pools: 2, sport });
    const before = await rowsOf(r.stageId);
    expect(before).toHaveLength(12);
    expect(new Set(before.map((x) => x.pool_id)).size).toBe(2);
    if (withOfficial) await attachOfficial(r.auth, before[0]!.id);
    for (const [i, name] of ["P9", "P10", "P11", "P12"].entries()) await r.add(name, 9 + i);
    const out = await generateStageFixtures(r.auth, r.stageId);
    const after = await rowsOf(r.stageId);
    const byPool = new Map<string, Row[]>();
    for (const row of after) byPool.set(row.pool_id!, [...(byPool.get(row.pool_id!) ?? []), row]);
    return { r, before, out, after, byPool };
  }

  it("X-CU-6 two pools of four growing to six (nobody moves, parity kept) patch each pool by its own missing pairs, with and without an official (badminton and football)", async () => {
    let checked = 0;
    for (const [sport, withOfficial] of [[BADMINTON, false], [BADMINTON, true], [FOOTBALL, false], [FOOTBALL, true]] as const) {
      const { before, out, after, byPool, r } = await grownPools(sport, withOfficial);
      expect(out.reconcile?.kind, sport.key).toBe("in_place");
      expect(out.created, `${sport.key}: 2 x (15 - 6) new lines`).toBe(18);
      expect(after, sport.key).toHaveLength(30);
      expect([...byPool.values()].map((x) => x.length)).toEqual([15, 15]);
      const afterIds = new Set(after.map((x) => x.id));
      expect(before.every((b) => afterIds.has(b.id)), `${sport.key}: the old lines survive`).toBe(true);
      expect(await officialsOn(r.stageId), `${sport.key}: the official stays`).toBe(withOfficial ? 1 : 0);
      for (const rows of byPool.values()) {
        const members = new Set(rows.flatMap((x) => [x.home_entrant_id!, x.away_entrant_id!]));
        expect(members.size).toBe(6);
        expect(sorted(rows.map(keyOfRow)), `${sport.key}: each pool is its own round robin, once each`).toEqual(sorted(engineKeys([...members], 1, rows[0]!.pool_id)));
      }
      expect(expectNoDoubleBooking(after, `${sport.key} grown pools`)).toBe(60);
      checked++;
    }
    expect(checked).toBe(4);
  });
});

describe.skipIf(!HAS_DB)("X-CU-6 RB5-G4/G7: a withdrawal before Start, then Generate on a group", () => {
  // differential: the first reconcile redrew a group whose live field could no longer fill its pools, and the redraw threw
  // `not enough entrants to fill` (group-group-ko-seeding I2a went red); main's positional Generate resolved and changed nothing.
  it("X-CU-6 a field below its pools' minimum (7 in 4 pools) cannot be snaked again: Generate resolves and the draw stands (both sports)", async () => {
    let checked = 0;
    for (const sport of [BADMINTON, FOOTBALL]) {
      const r = await rig({ n: 8, kind: "group", pools: 4, sport });
      const before = await rowsOf(r.stageId);
      expect(before.length, "premise: drawn").toBeGreaterThan(0);
      await withdrawEntrantCascade(r.auth, r.ids[7]!);
      const out = await generateStageFixtures(r.auth, r.stageId);
      expect(out.reconcile?.kind, sport.key).toBe("noop");
      // The desk must not read this as "up to date": the reason and the numbers (4 pools x 2 = 8 required, 7 live) ride on the answer.
      expect(out.reconcile, `${sport.key}: the answer says why nothing was done`).toEqual({
        kind: "noop",
        placed: [],
        vacated: [],
        vacated_seats: 0,
        reason: "pools_below_minimum",
        groups: 4,
        entrants: 7,
        required: 8,
        // W5 T12 (X-BD-1): floor(7/3)=2, so three pools work.
        suggested: 3,
      });
      expect(await rowsOf(r.stageId), `${sport.key}: the draw stands`).toEqual(before);
      checked++;
    }
    expect(checked).toBe(2);
  });

  it("X-CU-6 the reason is absent on the genuine no-ops: a plain second Generate, and a full group's (both sports)", async () => {
    let checked = 0;
    for (const sport of [BADMINTON, FOOTBALL]) {
      for (const shape of [{ kind: "league" as const }, { kind: "group" as const, pools: 2 }]) {
        const r = await rig({ n: 8, sport, ...shape });
        const out = await generateStageFixtures(r.auth, r.stageId);
        expect(out.reconcile, `${sport.key} ${shape.kind}`).toEqual({ kind: "noop", placed: [], vacated: [], vacated_seats: 0 });
        expect(out.reconcile, `${sport.key} ${shape.kind}`).not.toHaveProperty("reason");
        checked++;
      }
    }
    expect(checked).toBe(4);
  });

  it("X-CU-6 a withdrawal that leaves the pools fillable (9 -> 8 in 4 pools) re-snakes the remaining entrants: nobody withdrawn is seated, every pool is its own round robin once", async () => {
    let checked = 0;
    for (const sport of [BADMINTON, FOOTBALL]) {
      const r = await rig({ n: 9, kind: "group", pools: 4, sport });
      const gone = r.ids[8]!;
      await withdrawEntrantCascade(r.auth, gone);
      const out = await generateStageFixtures(r.auth, r.stageId);
      expect(["regenerated", "in_place"], `${sport.key}: ${out.reconcile?.kind}`).toContain(out.reconcile?.kind);
      const after = await rowsOf(r.stageId);
      const seated = after.flatMap((x) => [x.home_entrant_id!, x.away_entrant_id!]);
      expect(seated.includes(gone), `${sport.key}: the withdrawn entrant is in no line`).toBe(false);
      expect(new Set(seated), `${sport.key}: all eight remaining entrants are seated`).toEqual(new Set(r.ids.slice(0, 8)));
      const byPool = new Map<string, Row[]>();
      for (const row of after) byPool.set(row.pool_id!, [...(byPool.get(row.pool_id!) ?? []), row]);
      expect(byPool.size, `${sport.key}: four pools`).toBe(4);
      for (const rows of byPool.values()) {
        const members = new Set(rows.flatMap((x) => [x.home_entrant_id!, x.away_entrant_id!]));
        expect(members.size, `${sport.key}: a pool holds at least two`).toBeGreaterThanOrEqual(2);
        expect(sorted(rows.map(keyOfRow)), `${sport.key}: each pool once per pair`).toEqual(sorted(engineKeys([...members], 1, rows[0]!.pool_id)));
      }
      const again = await generateStageFixtures(r.auth, r.stageId);
      expect(again.reconcile?.kind, `${sport.key}: a second Generate is the named no-op`).toBe("noop");
      checked++;
    }
    expect(checked).toBe(2);
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

/** A chess invite still queued for a line's white seat: the outbox row a delete must end (Phase 3 G-1). */
async function queueInvite(orgId: string, fixtureId: string): Promise<string> {
  const [row] = await sql<{ id: string }[]>`
    insert into email_outbox (id, kind, ref_type, ref_id, org_id, recipient, subject, transactional, status, expires_at)
    values (${randomUUID()}, 'chess_invite', ${CHESS_SEAT_REF_TYPE}, ${chessSeatRef(fixtureId, "white")}, ${orgId}, 'seat@example.test',
            'invite', true, 'queued', now() + interval '1 hour')
    returning id`;
  return row!.id;
}
async function outboxStatus(id: string): Promise<string> {
  const [row] = await sql<{ status: string }[]>`select status from email_outbox where id = ${id}`;
  return row!.status;
}

describe.skipIf(!HAS_DB)("X-CU-6 Generate stays undoable (Task-2 review, ruling 3)", () => {
  // differential: before the fix a regenerate and a patch's removals deleted the lines with no history row, so Undo undid only the
  // insert half (or nothing) and the previous lines were gone for good.
  it("X-CU-6 a regenerate then Undo puts the previous lines back (the new draw goes first, then the old one returns)", async () => {
    // 3 -> 4 is an odd field becoming even: the byes recorded for it cannot stay honest under a patch, so it is drawn again.
    const r = await rig({ n: 3 });
    const before = await rowsOf(r.stageId);
    await r.add("P4", 4);
    const out = await generateStageFixtures(r.auth, r.stageId);
    expect(out.reconcile?.kind).toBe("regenerated");
    expect(await rowsOf(r.stageId)).toHaveLength(6);

    await undoDivision(r.auth, r.divisionId); // the fresh draw goes
    expect(await rowsOf(r.stageId), "the fresh lines are gone").toHaveLength(0);
    await undoDivision(r.auth, r.divisionId); // the previous lines return
    const restored = await rowsOf(r.stageId);
    expect(restored.map((x) => x.id).sort(), "the previous lines are the very same rows").toEqual(before.map((x) => x.id).sort());
    expect(await storedKeys(r.stageId)).toEqual(sorted(before.map(keyOfRow)));
  });

  it("X-CU-6 a patch that only removes lines, then Undo, restores the removed lines (football too)", async () => {
    let checked = 0;
    for (const sport of [BADMINTON, FOOTBALL]) {
      const r = await rig({ n: 6, sport });
      await attachOfficial(r.auth, (await keptLine(r.stageId, r.ids.slice(0, 4))).id);
      const before = await rowsOf(r.stageId);
      await withdrawEntrantCascade(r.auth, r.ids[4]!);
      await withdrawEntrantCascade(r.auth, r.ids[5]!);
      const out = await generateStageFixtures(r.auth, r.stageId);
      expect(out.reconcile?.kind, sport.key).toBe("in_place");
      const patched = await rowsOf(r.stageId);
      expect(patched.length, `${sport.key}: removals only`).toBe(6);
      const gone = before.filter((b) => !patched.some((x) => x.id === b.id));
      expect(gone, `${sport.key}: nine lines of the two withdrawn players went`).toHaveLength(9);

      await undoDivision(r.auth, r.divisionId);
      const restored = await rowsOf(r.stageId);
      expect(restored.map((x) => x.id).sort(), `${sport.key}: every removed line is back, as the same row`).toEqual(before.map((x) => x.id).sort());
      checked++;
    }
    expect(checked).toBe(2);
  });

  it("X-CU-6 a patch that removes and inserts takes two Undo steps: the inserted lines go first, then the removed ones return", async () => {
    const r = await rig({ n: 6 });
    await attachOfficial(r.auth, (await keptLine(r.stageId, r.ids.slice(0, 5))).id);
    const before = await rowsOf(r.stageId);
    await withdrawEntrantCascade(r.auth, r.ids[5]!);
    const newcomer = await r.add("P7", 7);
    const out = await generateStageFixtures(r.auth, r.stageId);
    expect(out.reconcile?.kind).toBe("in_place");
    const patched = await rowsOf(r.stageId);
    const removed = before.filter((b) => !patched.some((x) => x.id === b.id));
    const inserted = patched.filter((x) => !before.some((b) => b.id === x.id));
    expect(removed, "the withdrawn player's five lines").toHaveLength(5);
    expect(inserted, "the newcomer's five lines").toHaveLength(5);
    expect(inserted.every((x) => x.home_entrant_id === newcomer || x.away_entrant_id === newcomer)).toBe(true);

    await undoDivision(r.auth, r.divisionId);
    const afterFirst = await rowsOf(r.stageId);
    expect(afterFirst.some((x) => inserted.some((i) => i.id === x.id)), "the inserted lines are gone").toBe(false);
    expect(afterFirst, "the removed lines have not returned yet").toHaveLength(before.length - removed.length);
    await undoDivision(r.auth, r.divisionId);
    expect((await rowsOf(r.stageId)).map((x) => x.id).sort(), "the removed lines return").toEqual(before.map((x) => x.id).sort());
  });
});

describe.skipIf(!HAS_DB)("X-CU-6 Generate refuses to clear setup (Task-2 review, ruling 1)", () => {
  // differential: before the fix a parity flip redrew the table and the cascade took the official with it, with no word said.
  it("X-CU-6 3→4 over an official on a surviving line: refused by name with the counts, lines and official untouched (football too)", async () => {
    let checked = 0;
    for (const sport of [BADMINTON, FOOTBALL]) {
      const r = await rig({ n: 3, sport });
      await attachOfficial(r.auth, (await keptLine(r.stageId)).id);
      const rows = await rowsOf(r.stageId);
      const byes = await roundByesOf(r.stageId);
      await r.add("P4", 4);
      const err = await refusal(generateStageFixtures(r.auth, r.stageId));
      expect([err.status, err.code], sport.key).toEqual([409, "RR_REGENERATE_WOULD_CLEAR_SETUP"]);
      expect((err.extra?.attachments as { officials: number }).officials, `${sport.key}: the counts ride on the refusal`).toBe(1);
      expect(await rowsOf(r.stageId), `${sport.key}: lines byte-equal`).toEqual(rows);
      expect(await officialsOn(r.stageId), `${sport.key}: the official is still there`).toBe(1);
      expect(await roundByesOf(r.stageId), `${sport.key}: byes untouched`).toEqual(byes);
      checked++;
    }
    expect(checked).toBe(2);
  });

  it("X-CU-6 a group that would re-snake over an official is refused too, and once the official is gone Generate draws it", async () => {
    // Seeds 2..9 now, the newcomer takes seed 1: every player moves down the snake, so the pools must be redrawn.
    const r = await rig({ n: 8, kind: "group", pools: 2, seeds: [2, 3, 4, 5, 6, 7, 8, 9] });
    await attachOfficial(r.auth, (await keptLine(r.stageId)).id);
    const rows = await rowsOf(r.stageId);
    await r.add("P9", 1);
    const err = await refusal(generateStageFixtures(r.auth, r.stageId));
    expect(err.code).toBe("RR_REGENERATE_WOULD_CLEAR_SETUP");
    expect(await rowsOf(r.stageId), "lines byte-equal").toEqual(rows);
    expect(await officialsOn(r.stageId)).toBe(1);
    // The organiser clears the setup (or uses Rebuild, which lists it): the same Generate now draws.
    await sql`delete from fixture_officials where fixture_id in (select id from fixtures where stage_id = ${r.stageId})`;
    const out = await generateStageFixtures(r.auth, r.stageId);
    expect(out.reconcile?.kind).toBe("regenerated");
    expect(await rowsOf(r.stageId)).toHaveLength(16);
  });

  it("X-CU-6 slots are NOT setup: a time and a court on a line carry over a redraw without a refusal", async () => {
    const r = await rig({ n: 3 });
    const courts = await seedCourts(r.auth.orgId, 1);
    const line = await keptLine(r.stageId);
    await sql`update fixtures set scheduled_at = ${"2030-06-11T10:00:00.000Z"}, court_id = ${courts[0]!} where id = ${line.id}`;
    await r.add("P4", 4);
    const out = await generateStageFixtures(r.auth, r.stageId);
    expect(out.reconcile?.kind).toBe("regenerated");
    const carried = (await rowsOf(r.stageId)).find((x) => keyOfRow(x) === keyOfRow(line));
    expect(carried?.court_id).toBe(courts[0]!);
  });
});

describe.skipIf(!HAS_DB)("X-CU-6 an entrant delete refreshes the removed lines' public pages and ends their queued invites (Task-2 review)", () => {
  // differential: the hook ran BEFORE the scope read, so the lines it deleted were already gone and their match-centre documents stayed
  it("X-CU-6 the delete's public refresh names the removed lines, so their match-centre documents are dropped", async () => {
    const r = await rig({ n: 4 });
    const victim = r.ids[1]!;
    const lines = (await rowsOf(r.stageId)).filter((x) => x.home_entrant_id === victim || x.away_entrant_id === victim).map((x) => x.id);
    expect(lines, "premise: the victim sits in three lines").toHaveLength(3);
    dropNamedPublicDocuments.mockClear();
    await deleteEntrant(r.auth, victim);
    expect(await rowsOf(r.stageId), "the lines went with the entrant").toHaveLength(3);
    expect(dropNamedPublicDocuments).toHaveBeenCalledTimes(1);
    const scope = (dropNamedPublicDocuments.mock.calls[0] as unknown as [{ fixtureIds: string[] }])[0];
    expect([...scope.fixtureIds].sort()).toEqual([...lines].sort());
  });

  it("X-CU-6 a queued chess invite on a removed line ends with it: on a pre-Start delete, and on a patch's removals", async () => {
    // The delete hook.
    const r = await rig({ n: 4 });
    const victim = r.ids[1]!;
    const [onVictim] = (await rowsOf(r.stageId)).filter((x) => x.home_entrant_id === victim || x.away_entrant_id === victim);
    const survivor = (await rowsOf(r.stageId)).find((x) => x.home_entrant_id !== victim && x.away_entrant_id !== victim)!;
    const doomed = await queueInvite(r.auth.orgId, onVictim!.id);
    const kept = await queueInvite(r.auth.orgId, survivor.id);
    await deleteEntrant(r.auth, victim);
    expect(await outboxStatus(doomed), "the removed line's invite is ended").toBe("expired");
    expect(await outboxStatus(kept), "another line's invite is left alone").toBe("queued");

    // A patch's removals (a league keeps its lines when an even field stays even: the pairs of the departed are dropped).
    const r2 = await rig({ n: 6 });
    await attachOfficial(r2.auth, (await keptLine(r2.stageId, r2.ids.slice(0, 4))).id);
    const gone = (await rowsOf(r2.stageId)).find((x) => x.home_entrant_id === r2.ids[5] || x.away_entrant_id === r2.ids[5])!;
    const doomed2 = await queueInvite(r2.auth.orgId, gone.id);
    // Two leave: an even field stays even, so Generate patches and drops their pairs.
    await withdrawEntrantCascade(r2.auth, r2.ids[4]!);
    await withdrawEntrantCascade(r2.auth, r2.ids[5]!);
    const out = await generateStageFixtures(r2.auth, r2.stageId);
    expect(out.reconcile?.kind).toBe("in_place");
    expect((await rowsOf(r2.stageId)).some((x) => x.id === gone.id), "premise: the line went").toBe(false);
    expect(await outboxStatus(doomed2), "the patch ended the removed line's invite").toBe("expired");
  });

  // differential: a redraw rewrites `stages.config.round_byes` (writeRoundByes) and Undo put the lines back but left the NEW byes
  // beside them, so the table's byes named players in rounds they no longer sit out.
  it("X-CU-6 Undo of a redraw puts `round_byes` back with the lines: 6 -> 5 (none before) and 5 -> 6 (five before), both sports", async () => {
    let checked = 0;
    for (const sport of [BADMINTON, FOOTBALL]) {
      for (const change of [
        { from: 6, label: "6 -> 5", apply: async (r: Rig) => withdrawEntrantCascade(r.auth, r.ids[5]!) },
        { from: 5, label: "5 -> 6", apply: async (r: Rig) => void (await r.add("P6", 6)) },
      ]) {
        const r = await rig({ n: change.from, sport });
        const before = await roundByesOf(r.stageId);
        const lines = await rowsOf(r.stageId);
        await change.apply(r);
        const out = await generateStageFixtures(r.auth, r.stageId);
        expect(out.reconcile?.kind, `${sport.key} ${change.label}`).toBe("regenerated");
        const redrawn = await roundByesOf(r.stageId);
        expect(redrawn, `${sport.key} ${change.label}: premise - the redraw rewrote the byes`).not.toEqual(before);
        await undoDivision(r.auth, r.divisionId); // the fresh draw goes
        await undoDivision(r.auth, r.divisionId); // the previous lines return
        expect((await rowsOf(r.stageId)).map((x) => x.id).sort(), `${sport.key} ${change.label}: the lines are back`).toEqual(lines.map((x) => x.id).sort());
        expect(await roundByesOf(r.stageId), `${sport.key} ${change.label}: the byes are back with them`).toEqual(before);
        checked++;
      }
    }
    expect(checked).toBe(4);
  });

  // differential: a patch took every kind of match setup hanging on a departed player's lines (officials, sheets, calls) and the
  // organiser was told only "N entrants who left were taken out".
  it("X-CU-6 a patch that drops lines carrying setup says how many setups went and with whom; no setup, no clause (both sports)", async () => {
    let checked = 0;
    for (const sport of [BADMINTON, FOOTBALL]) {
      const r = await rig({ n: 6, sport });
      const goneLine = (await rowsOf(r.stageId)).find((x) => x.home_entrant_id === r.ids[5] || x.away_entrant_id === r.ids[5])!;
      await attachOfficial(r.auth, goneLine.id);
      await withdrawEntrantCascade(r.auth, r.ids[4]!);
      await withdrawEntrantCascade(r.auth, r.ids[5]!);
      const out = await generateStageFixtures(r.auth, r.stageId);
      expect(out.reconcile?.kind, sport.key).toBe("in_place");
      expect(out.reconcile?.setups_removed, `${sport.key}: one official went with P5's and P6's lines`).toEqual({ count: 1, names: ["P5", "P6"] });
      expect(await officialsOn(r.stageId), `${sport.key}: it is gone`).toBe(0);

      const plain = await rig({ n: 6, sport });
      await withdrawEntrantCascade(plain.auth, plain.ids[4]!);
      await withdrawEntrantCascade(plain.auth, plain.ids[5]!);
      const quiet = await generateStageFixtures(plain.auth, plain.stageId);
      expect(quiet.reconcile?.kind, `${sport.key} (no setup)`).toBe("in_place");
      expect(quiet.reconcile, `${sport.key}: nothing to report`).not.toHaveProperty("setups_removed");
      checked++;
    }
    expect(checked).toBe(2);
  });

  // differential: `sealed ?? { streams: 0, youtubeBroadcasts: 0 }` read a caller that never read the sealed kinds as "none", so a
  // redraw cleared a stream's setup it could not see.
  it("X-CU-6 a redraw whose sealed setup counts were never read is refused, not assumed empty (and drawn once they are read)", async () => {
    let checked = 0;
    for (const sport of [BADMINTON, FOOTBALL]) {
      const r = await rig({ n: 3, sport });
      const rows = await rowsOf(r.stageId);
      await r.add("P4", 4);
      const err = await refusal(withTenant(r.auth.orgId, (tx) => generateStageFixturesTx(tx, r.auth, r.stageId, {})));
      expect([err.status, err.code], sport.key).toEqual([409, "RR_REGENERATE_WOULD_CLEAR_SETUP"]);
      expect(err.extra?.sealed_unread, `${sport.key}: the refusal says why`).toBe(true);
      expect(await rowsOf(r.stageId), `${sport.key}: nothing was drawn`).toEqual(rows);
      const drawn = await withTenant(r.auth.orgId, (tx) => generateStageFixturesTx(tx, r.auth, r.stageId, { sealedSetup: { streams: 0, youtubeBroadcasts: 0 } }));
      expect(drawn.outcome.reconcile?.kind, `${sport.key}: with the counts read, none, it draws`).toBe("regenerated");
      checked++;
    }
    expect(checked).toBe(2);
  });

  // A voided result is still evidence (monotonic), so a voided line makes the stage STARTED: it stays keyed, and Generate - however
  // many times, with a departure in between - adds nothing for its pair and never drops it. An arrival is refused by name.
  it("X-CU-6 a voided line of a surviving pair stays keyed, and every Generate after it adds nothing for the pair (both sports)", async () => {
    let checked = 0;
    for (const sport of [BADMINTON, FOOTBALL]) {
      const r = await rig({ n: 6, sport });
      const line = await keptLine(r.stageId, r.ids.slice(0, 4));
      const [start] = await sql<{ id: string }[]>`
        insert into score_events (fixture_id, org_id, seq, type, payload) values (${line.id}, ${r.auth.orgId}, 0, 'core.start', '{}') returning id`;
      await sql`insert into score_events (fixture_id, org_id, seq, type, payload)
                values (${line.id}, ${r.auth.orgId}, 1, 'core.void', ${sql.json({ event_id: start!.id } as never)})`;
      const before = await rowsOf(r.stageId);
      await withdrawEntrantCascade(r.auth, r.ids[5]!);
      for (const call of [1, 2]) {
        const out = await generateStageFixtures(r.auth, r.stageId);
        expect(out.reconcile, `${sport.key} call ${call}`).toEqual({ kind: "noop", placed: [], vacated: [], vacated_seats: 0 });
        expect(out.created, `${sport.key} call ${call}`).toBe(0);
        const rows = await rowsOf(r.stageId);
        expect(rows.find((x) => x.id === line.id)?.ext_key, `${sport.key} call ${call}: the voided line keeps its key`).toBe(line.ext_key);
        expect(rows, `${sport.key} call ${call}: no line added, none dropped`).toEqual(before);
        expect(rows.filter((x) => keyOfRow(x) === keyOfRow(line)), `${sport.key} call ${call}: the pair is keyed once`).toHaveLength(1);
      }
      await r.add("P7", 7);
      const err = await refusal(generateStageFixtures(r.auth, r.stageId));
      expect([err.status, err.code], `${sport.key}: an arrival after the void`).toEqual([409, "RR_GENERATE_AFTER_START"]);
      expect(await rowsOf(r.stageId), `${sport.key}: still byte-equal`).toEqual(before);
      checked++;
    }
    expect(checked).toBe(2);
  });

  // A voided result is still evidence (`fixtureHasResultSql` reads the ledger the monotonic way): the line is not silently dropped.
  it("X-CU-6 a line whose only result was voided still holds evidence: its entrant's delete is refused and the lines stay", async () => {
    const r = await rig({ n: 4 });
    const rows = await rowsOf(r.stageId);
    const line = rows[0]!;
    const [start] = await sql<{ id: string }[]>`
      insert into score_events (fixture_id, org_id, seq, type, payload) values (${line.id}, ${r.auth.orgId}, 0, 'core.start', '{}') returning id`;
    await sql`insert into score_events (fixture_id, org_id, seq, type, payload)
              values (${line.id}, ${r.auth.orgId}, 1, 'core.void', ${sql.json({ event_id: start!.id } as never)})`;
    const err = await refusal(deleteEntrant(r.auth, line.home_entrant_id!));
    expect(err.status).toBe(409);
    expect(err.code).toBe("ENTRANT_FIXTURES_HAVE_RESULTS");
    expect(err.message, "the sentence is the table row's, so every locale has it").toBe(ROUND_ROBIN_REFUSALS.ENTRANT_FIXTURES_HAVE_RESULTS.en);
    expect(await rowsOf(r.stageId), "nothing was dropped").toEqual(rows);
  });
});

describe.skipIf(!HAS_DB)("FX-G21 / X-CU-6: a league drawn over day-one seats (`timing: setup`) records its byes and reads legacy keys", () => {
  /** 5 players, stage 1 a league, stage 2 a league whose five seats are the first five of stage 1 (an odd field), drawn off seats. */
  async function seatLeague() {
    const r = await rig({ n: 5, generate: false });
    const [fed] = await createStages(r.auth, r.divisionId, {
      seq: 2,
      kind: "league",
      name: "Super",
      config: {},
      progression: {
        sources: [{ stage: "previous", take: [{ kind: "rankRange", from: 1, to: 5 }] }],
        placement: "rank_order",
        timing: "setup",
      },
    });
    return { r, fed: fed! };
  }

  // differential: the setup path never recorded round_byes, so an odd seat league's bye was lost like main's
  it("FX-G21 an odd league drawn over five seats records the engine's byes, naming the seats", async () => {
    const { r, fed } = await seatLeague();
    const out = await generateStageFixtures(r.auth, fed.id);
    expect(out.fixtures.length, "ten lines of C(5,2)").toBe(10);
    const seats = [1, 2, 3, 4, 5].map((i) => `slot:${i}`);
    const expected = engineByes(seats, 1);
    expect(expected, "premise: the engine emits one bye per round").toHaveLength(5);
    const byes = await roundByesOf(fed.id);
    expect(byes, "round_byes is written").toBeDefined();
    expect(bySlot(byes!.map(({ round_no, leg, entrant_id }) => ({ round_no, leg, entrant_id })))).toEqual(bySlot(expected));
    expect(byes!.every((b) => b.pool === null)).toBe(true);
  });

  // differential: byKey read only the new `-L{n}` spelling, so a seat league drawn before the leg was stored would be inserted twice
  it("X-CU-6 a seat league whose lines carry the pre-leg key is not drawn twice by a second Generate", async () => {
    const { r, fed } = await seatLeague();
    await generateStageFixtures(r.auth, fed.id);
    const before = await rowsOf(fed.id);
    expect(before).toHaveLength(10);
    await sql`update fixtures set ext_key = regexp_replace(ext_key, '-L[0-9]+$', '') where stage_id = ${fed.id}`;
    await generateStageFixtures(r.auth, fed.id);
    const after = await rowsOf(fed.id);
    expect(after, "no line written a second time").toHaveLength(10);
    expect(after.map((x) => x.id).sort()).toEqual(before.map((x) => x.id).sort());
  });
});

// B1 batch review C1: "Add match" writes `ext_key = adhoc-N`, which is no round-robin line. The reconcile read it as a line of a
// legacy leg, saw a repeat of a pair the engine already draws, and redrew the stage - deleting the organiser's extra match (and
// over-refusing when setup hung on the lines, and breaking "a second Generate with no roster change is a no-op").
// Decision for a redraw: it never keeps an Add match row (it cannot, without seating a player twice in a round), so it REFUSES
// by name (RR_REGENERATE_WOULD_DROP_ADD_MATCH, pointing to Rebuild) and writes nothing.
describe.skipIf(!HAS_DB)("X-CU-6 Generate leaves Add match rows alone (B1 batch C1)", () => {
  /** Strip the `-L{leg}` tail from every round-robin key: a stage drawn before W5. */
  async function makeLegacy(stageId: string) {
    await sql`update fixtures set ext_key = regexp_replace(ext_key, '-L[0-9]+$', '') where stage_id = ${stageId} and ext_key like '%rr-r%'`;
  }
  async function addMatch(r: Rig, a: number, b: number): Promise<Row> {
    const added = await addFixture(r.auth, r.stageId, { home_entrant_id: r.ids[a]!, away_entrant_id: r.ids[b]! });
    const row = (await rowsOf(r.stageId)).find((x) => x.id === added.fixture_id)!;
    expect(row.ext_key, "premise: Add match writes the adhoc key").toMatch(/^adhoc-\d+$/);
    return row;
  }

  for (const legacy of [false, true]) {
    const tag = legacy ? "a pre-W5 stage (legacy keys)" : "a W5 stage";

    it(`Add match then Generate with no roster change is the named no-op, the extra row byte-equal: ${tag}, even and odd fields, both sports`, async () => {
      let checked = 0;
      for (const sport of [BADMINTON, FOOTBALL]) {
        for (const n of [4, 5]) {
          const r = await rig({ n, sport });
          if (legacy) await makeLegacy(r.stageId);
          await addMatch(r, 0, 1);
          const before = await rowsOf(r.stageId);
          const byes = await roundByesOf(r.stageId);
          for (const call of [1, 2]) {
            const out = await generateStageFixtures(r.auth, r.stageId);
            expect(out.reconcile, `${sport.key} n=${n} call ${call}`).toEqual({ kind: "noop", placed: [], vacated: [], vacated_seats: 0 });
            expect(await rowsOf(r.stageId), `${sport.key} n=${n} call ${call}: every row byte-equal, the extra one included`).toEqual(before);
            expect(await roundByesOf(r.stageId), `${sport.key} n=${n} call ${call}: byes untouched`).toEqual(byes);
          }
          checked++;
        }
      }
      expect(checked).toBe(4);
    });

    it(`Add match then two newcomers (even stays even) is a patch that keeps the extra row and seats nobody twice in a round: ${tag}, both sports`, async () => {
      let checked = 0;
      for (const sport of [BADMINTON, FOOTBALL]) {
        const r = await rig({ n: 4, sport });
        if (legacy) await makeLegacy(r.stageId);
        const extra = await addMatch(r, 0, 1);
        await r.add("P5", 5);
        await r.add("P6", 6);
        const out = await generateStageFixtures(r.auth, r.stageId);
        expect(out.reconcile?.kind, sport.key).toBe("in_place");
        const after = await rowsOf(r.stageId);
        expect(after.find((x) => x.id === extra.id), `${sport.key}: the extra row is untouched`).toEqual(extra);
        const seats = expectNoDoubleBooking(after, sport.key);
        // 6 players: 15 pair lines + the extra one, two seats each.
        expect(seats, `${sport.key}: anti-vacuity, every seat checked`).toBe(2 * (15 + 1));
        expect(after.filter((x) => x.ext_key !== extra.ext_key), `${sport.key}: the 15 lines are the engine's pairs`).toHaveLength(15);
        checked++;
      }
      expect(checked).toBe(2);
    });
  }

  // differential: a stage that holds only Add match rows entered the reconcile (`existing.length > 0`), read as "no lines either side" and
  // answered a redraw, which the Add match guard refused - main's positional insert wrote the table and kept the extra row.
  // Decision: the FIRST Generate never deletes an Add match row (byte-equal), and does not move it either, so it can sit in a round
  // beside a table line of the same player: the same thing main did, and the row is the organiser's own placement.
  it("a never-generated league holding only Add match rows takes the FIRST Generate: the table is written, the extra row byte-equal (even and odd field, both sports)", async () => {
    let checked = 0;
    for (const sport of [BADMINTON, FOOTBALL]) {
      // (A never-generated GROUP has no pools yet, so Add match refuses it: only a league can reach this.)
      for (const shape of [{ n: 8, pairs: 28 }, { n: 5, pairs: 10 }]) {
        const r = await rig({ n: shape.n, sport, generate: false });
        const added = await addFixture(r.auth, r.stageId, { home_entrant_id: r.ids[0]!, away_entrant_id: r.ids[1]! });
        const extra = (await rowsOf(r.stageId)).find((x) => x.id === added.fixture_id)!;
        expect(extra.ext_key, "premise: only an Add match row exists").toMatch(/^adhoc-\d+$/);
        expect(await rowsOf(r.stageId), "premise: the stage holds that one row").toHaveLength(1);
        const out = await generateStageFixtures(r.auth, r.stageId);
        expect(out.reconcile, `${sport.key} n=${shape.n}: a first Generate reports no reconcile`).toBeUndefined();
        const after = await rowsOf(r.stageId);
        expect(after.find((x) => x.id === extra.id), `${sport.key} n=${shape.n}: the extra row is byte-equal`).toEqual(extra);
        const table = after.filter((x) => x.ext_key !== extra.ext_key);
        // n choose 2: 8 entrants = 28 pairs, 5 entrants = 10.
        expect(table, `${sport.key} n=${shape.n}: the table is written`).toHaveLength(shape.pairs);
        expect(table.every((x) => isRrExtKey(x.ext_key)), `${sport.key} n=${shape.n}: every written row is a table line`).toBe(true);
        // A second Generate is then the named no-op, the extra row untouched.
        const again = await generateStageFixtures(r.auth, r.stageId);
        expect(again.reconcile, `${sport.key} n=${shape.n}`).toEqual({ kind: "noop", placed: [], vacated: [], vacated_seats: 0 });
        expect(await rowsOf(r.stageId), `${sport.key} n=${shape.n}: byte-equal`).toEqual(after);
        checked++;
      }
    }
    expect(checked).toBe(4);
  });

  it("Add match then ONE newcomer (4 -> 5, an odd field: a redraw) is refused by name and writes nothing, in both sports", async () => {
    let checked = 0;
    for (const sport of [BADMINTON, FOOTBALL]) {
      const r = await rig({ n: 4, sport });
      await addMatch(r, 0, 1);
      await r.add("P5", 5);
      const before = await rowsOf(r.stageId);
      const byes = await roundByesOf(r.stageId);
      const err = await refusal(generateStageFixtures(r.auth, r.stageId));
      expect([err.status, err.code], sport.key).toEqual([409, "RR_REGENERATE_WOULD_DROP_ADD_MATCH"]);
      expect(await rowsOf(r.stageId), `${sport.key}: byte-equal`).toEqual(before);
      expect(await roundByesOf(r.stageId), `${sport.key}: byes untouched`).toEqual(byes);
      checked++;
    }
    expect(checked).toBe(2);
  });

  it("a group that would re-snake over an Add match row is refused the same way", async () => {
    const r = await rig({ n: 8, kind: "group", pools: 2 });
    const line = await keptLine(r.stageId);
    const added = await addFixture(r.auth, r.stageId, { home_entrant_id: line.home_entrant_id!, away_entrant_id: line.away_entrant_id!, pool_id: line.pool_id! } as never);
    expect((await rowsOf(r.stageId)).find((x) => x.id === added.fixture_id)?.ext_key, "premise").toMatch(/^adhoc-/);
    await r.add("P9", 1); // seeded first: everyone moves, a re-snake
    const before = await rowsOf(r.stageId);
    const err = await refusal(generateStageFixtures(r.auth, r.stageId));
    expect(err.code).toBe("RR_REGENERATE_WOULD_DROP_ADD_MATCH");
    expect(await rowsOf(r.stageId)).toEqual(before);
  });
});

