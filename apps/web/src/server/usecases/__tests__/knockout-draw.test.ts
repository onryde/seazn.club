// W4 app-A Task 7 (K5; FX-G17's draw half) — a root knockout's unseeded entrants are drawn AT RANDOM with the stage's own
// stored seed, never placed in registration order. Rulebook rows (rulebook-W4-knockout.md):
//   RB4-D1 seeds by the fold; RB4-D2 byes to the top seeds first; RB4-D3 the unseeded drawn at random, never registration
//   order; RB4-D4 the seed stored, shown and reproducible (W3's `swissDrawSeed` + `mulberry32`, on the generate's ledger
//   row as `draw_seed`); RB4-D5 Rebuild reuses it; RB4-D6 an API `slotOrder` overrides the draw.
//
// The defect (K5) on main: Generate read the active list ordered `seed nulls last, created_at, id`, and the engine keeps
// the input order for the unseeded, so the byes went to the earliest registrants.
//
// Expected values (pre-flight R9; controller ruling 2): the draw is `lib/swiss-draw.ts` (pinned against the rulebook by
// swiss-draw.test.ts) over the field in the order the active select reads it, fed to the ENGINE's own
// `generateSingleElim` — never the stage code under test. Every assertion is on the seats (`home_entrant_id` /
// `away_entrant_id`) by the engine's own line id (`ext_key`).
import { afterAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { generateSingleElim } from "@seazn/engine/scheduling";
import { builtinModules } from "@seazn/engine/sports";
import { isChessSport } from "@/lib/chess-individual-only-rule";
import { sql } from "@/lib/db";
import { swissDrawSeed, swissRoundOneOrder } from "@/lib/swiss-draw";
import { bracketRoleKey, finalRoundOf } from "@/lib/bracket-role";
import type { AuthCtx } from "@/server/api-v1/auth";
import { createCompetition } from "../competitions";
import { createDivision } from "../divisions";
import { createEntrants } from "../entrants";
import { createStages, generateStageFixtures, readStageDrawSeed, rebuildStageFixtures } from "../stages";
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
}

const BADMINTON: SportPick = { key: "badminton", variant: "bwf" };

/** The second sport (R27): the registry's chess module, read from the engine's declarations — the module whose key the
 *  app's chess predicate names, individual by its own entrant model — and its first declared variant. */
function chessSport(): SportPick {
  const pick = builtinModules.find(
    (m) => isChessSport(m.key) && (m.entrantModel?.defaultKind ?? "individual") === "individual",
  );
  if (pick === undefined) throw new Error("the engine registry declares no individual chess sport");
  const variant = Object.keys(pick.variants)[0];
  if (variant === undefined) throw new Error(`sport ${pick.key} declares no variant`);
  return { key: pick.key, variant };
}

interface Rig {
  auth: AuthCtx;
  divisionId: string;
  stageId: string;
  /** Entrant ids in createEntrants order. */
  ids: string[];
  name: (id: string) => string;
}

/** A division of `seeds.length` individuals P1..Pn (seed per entry; null = unseeded), and one knockout stage. When
 *  `premise` is given, the stage is re-created (a fresh server-minted id each time, at most 40 tries) until the premise
 *  holds for its id — "a stage id chosen so the shuffle differs" (brief) without inventing an id. */
async function rig(opts: {
  sport?: SportPick;
  seeds: (number | null)[];
  config?: Record<string, unknown>;
  premise?: (stageId: string, active: { id: string; seed: number | null }[]) => boolean;
}): Promise<Rig> {
  const sport = opts.sport ?? BADMINTON;
  const { auth } = await seedOrg("pro");
  const comp = await createCompetition(auth, {
    ends_on: "2030-12-31",
    name: "W4 T7 " + randomUUID().slice(0, 6),
    visibility: "private",
    branding: {},
  });
  const division = await createDivision(auth, comp.id, {
    name: "Open",
    slug: "open-" + randomUUID().slice(0, 6),
    sport_key: sport.key,
    variant_key: sport.variant,
    config: {},
  });
  const entrants = await createEntrants(
    auth,
    division.id,
    opts.seeds.map((seed, i) => ({ kind: "individual" as const, display_name: `P${i + 1}`, seed, members: [] })),
  );
  const names = new Map(entrants.map((e) => [e.id, e.display_name]));
  const active = await activeOrder(division.id);
  let stageId: string | undefined;
  for (let tries = 0; tries < 40; tries++) {
    const [stage] = await createStages(auth, division.id, {
      seq: 1,
      kind: "knockout",
      name: "KO",
      config: opts.config ?? {},
      progression: null,
    });
    if (opts.premise === undefined || opts.premise(stage!.id, active)) {
      stageId = stage!.id;
      break;
    }
    await sql`delete from stages where id = ${stage!.id}`;
  }
  if (stageId === undefined) throw new Error("rig: no stage id met the premise in 40 tries");
  return { auth, divisionId: division.id, stageId, ids: entrants.map((e) => e.id), name: (id) => names.get(id) ?? id };
}

/** The field Generate reads, in the order it reads it (the active select: `seed nulls last, created_at, id`). Entrants
 *  created in one batch share a `created_at`, so this — not the createEntrants order — is "registration order". */
async function activeOrder(divisionId: string): Promise<{ id: string; seed: number | null }[]> {
  return sql<{ id: string; seed: number | null }[]>`
    select id, seed from entrants where division_id = ${divisionId} and status in ('registered', 'confirmed')
     order by seed nulls last, created_at, id`;
}

/** The draw (RB4-D3/D4): `lib/swiss-draw.ts` over the stage's own seed. */
const drawn = (stageId: string, active: readonly { id: string; seed: number | null }[]) =>
  swissRoundOneOrder(swissDrawSeed(stageId), active);

/** The ENGINE's bracket over `order` (the engine sorts the seeded first, keeping the input order among the rest), as
 *  ext_key → "home|away" with a bye's real side at home (stages/ stores `home: f.home ?? f.award`), and the bye
 *  holders. */
function engineSeats(
  order: readonly string[],
  seedOf: (id: string) => number | null,
  extra: { slotOrder?: (number | null)[] } = {},
): { seats: Map<string, string>; byes: string[] } {
  const seeds = new Map(order.flatMap((id) => (seedOf(id) === null ? [] : [[id, seedOf(id)!] as const])));
  const bracket = generateSingleElim({ entrants: [...order], seeds, ...extra });
  const seats = new Map<string, string>();
  const byes: string[] = [];
  for (const f of bracket.fixtures) {
    if (f.round !== 0) continue;
    seats.set(f.id, `${f.home ?? f.award ?? "-"}|${f.away ?? "-"}`);
    if (f.award !== undefined) byes.push(f.award);
  }
  return { seats, byes };
}

interface StoredRow {
  id: string;
  ext_key: string;
  pool_id: string | null;
  round_no: number;
  seq_in_round: number;
  home_entrant_id: string | null;
  away_entrant_id: string | null;
  status: string;
  outcome: { kind?: string; reason?: string; winner?: string } | null;
}

async function rowsOf(stageId: string): Promise<StoredRow[]> {
  return sql<StoredRow[]>`
    select id, ext_key, pool_id, round_no, seq_in_round, home_entrant_id, away_entrant_id, status, outcome
      from fixtures where stage_id = ${stageId} order by round_no, seq_in_round`;
}

/** Round 1's seats as stored, ext_key → "home|away", and the stored bye holders (a `bye` award's winner). */
async function storedSeats(stageId: string): Promise<{ seats: Map<string, string>; byes: string[] }> {
  const rows = await rowsOf(stageId);
  const seats = new Map<string, string>();
  const byes: string[] = [];
  for (const r of rows) {
    if (r.round_no !== 1) continue;
    seats.set(r.ext_key, `${r.home_entrant_id ?? "-"}|${r.away_entrant_id ?? "-"}`);
    if (r.outcome?.kind === "award" && r.outcome.reason === "bye" && r.outcome.winner) byes.push(r.outcome.winner);
  }
  return { seats, byes };
}

/** Every line's seats keyed by its bracket ROLE (Task 4's key, counted back from the stage's own final). */
async function seatsByRole(stageId: string): Promise<Map<string, string>> {
  const rows = await rowsOf(stageId);
  const final = finalRoundOf(rows);
  return new Map(rows.map((r) => [bracketRoleKey(r, final), `${r.home_entrant_id ?? "-"}|${r.away_entrant_id ?? "-"}`]));
}

async function generateAudits(divisionId: string, stageId: string): Promise<Record<string, unknown>[]> {
  const rows = await sql<{ payload: Record<string, unknown> }[]>`
    select payload from division_events
     where division_id = ${divisionId} and type = 'fixtures_generated' and payload->>'stage_id' = ${stageId}
     order by seq`;
  return rows.map((r) => r.payload);
}

const sorted = (xs: readonly string[]) => [...xs].sort();
const UNSEEDED_6 = [null, null, null, null, null, null];

describe.skipIf(!HAS_DB)("X-SD-6 the unseeded are drawn at random with the stage's seed, never in registration order", () => {
  for (const [label, sport] of [
    ["badminton", BADMINTON],
    // R27: a second sport, chosen from the engine registry's declarations.
    ["chess", chessSport()],
  ] as const) {
    it(`X-SD-6 the earliest registrants do not get the byes (${label})`, async () => {
      // Premise (asserted): this stage's draw does not hand the byes to the first two registrants, so main's order and
      // the draw's answer differ — a test that cannot tell them apart would witness nothing.
      const r = await rig({
        sport,
        seeds: UNSEEDED_6,
        premise: (stageId, active) => {
          const byes = engineSeats(drawn(stageId, active), () => null).byes;
          return sorted(byes).join() !== sorted(active.slice(0, 2).map((e) => e.id)).join();
        },
      });
      const active = await activeOrder(r.divisionId);
      expect(active.length, "premise: six active entrants").toBe(6);
      const want = engineSeats(drawn(r.stageId, active), () => null);
      expect(want.byes.length, "RB4-D2: a field of six in a bracket of eight has two byes").toBe(2);
      const registrationByes = engineSeats(active.map((e) => e.id), () => null).byes;
      expect(sorted(registrationByes), "premise: in registration order the first two registrants hold the byes").toEqual(
        sorted(active.slice(0, 2).map((e) => e.id)),
      );
      expect(sorted(want.byes), "premise: the draw differs from registration order").not.toEqual(sorted(registrationByes));

      await generateStageFixtures(r.auth, r.stageId);
      const got = await storedSeats(r.stageId);
      expect(sorted(got.byes.map(r.name)), "RB4-D3: the byes go where the draw puts them").toEqual(sorted(want.byes.map(r.name)));
      // Every first-round line, by the engine's own id: the stored bracket IS the engine's bracket over the drawn order.
      let lines = 0;
      for (const [ext, seats] of want.seats) {
        expect(got.seats.get(ext), `line ${ext}`).toBe(seats);
        lines++;
      }
      expect(lines, "anti-vacuity: first-round lines compared").toBe(4);
      expect(got.seats.size).toBe(want.seats.size);
    });
  }

  it("X-SD-6 seeds stay on the fold and take the byes first", async () => {
    // Seeds 1 and 2, four unseeded: RB4-D2 — the byes go to seeds 1 and 2, whatever the draw does to the rest; RB4-D1 —
    // the seeds sit where the fold puts them; the four unseeded are drawn into the remaining positions.
    const r = await rig({ seeds: [1, 2, null, null, null, null] });
    const active = await activeOrder(r.divisionId);
    const seedOf = (id: string) => active.find((e) => e.id === id)?.seed ?? null;
    const want = engineSeats(drawn(r.stageId, active), seedOf);
    await generateStageFixtures(r.auth, r.stageId);
    const got = await storedSeats(r.stageId);
    expect(sorted(got.byes.map(r.name)), "RB4-D2: seeds 1 and 2 hold the byes").toEqual(["P1", "P2"]);
    let lines = 0;
    for (const [ext, seats] of want.seats) {
      expect(got.seats.get(ext), `line ${ext}`).toBe(seats);
      lines++;
    }
    expect(lines, "anti-vacuity: first-round lines compared").toBe(4);
  });
});

describe.skipIf(!HAS_DB)("X-SD-7 / X-SD-8 the draw is stored and replays", () => {
  it("X-SD-7 same seed and same entrants give the same bracket", async () => {
    const r = await rig({ seeds: UNSEEDED_6 });
    expect(await readStageDrawSeed(sql as never, r.stageId), "nothing generated: no seed recorded yet").toBeNull();
    await generateStageFixtures(r.auth, r.stageId);
    const first = await seatsByRole(r.stageId);
    expect(first.size, "anti-vacuity: lines read").toBe(7);
    // The fixtures go (not through the product: a clean slate), and the same field generates again.
    await sql`delete from fixtures where stage_id = ${r.stageId}`;
    await generateStageFixtures(r.auth, r.stageId);
    const second = await seatsByRole(r.stageId);
    expect(second, "RB4-D4: the same seed and the same entrants give the same bracket").toEqual(first);
    const audits = await generateAudits(r.divisionId, r.stageId);
    expect(audits.length, "two generates, two ledger rows").toBe(2);
    for (const a of audits) expect(a.draw_seed, "RB4-D4: the seed is recorded on the generate's row").toBe(swissDrawSeed(r.stageId));
    expect(await readStageDrawSeed(sql as never, r.stageId), "the stage's stored seed").toBe(swissDrawSeed(r.stageId));
  });

  it("X-SD-8 Rebuild reuses the stored seed", async () => {
    const r = await rig({ seeds: UNSEEDED_6 });
    await generateStageFixtures(r.auth, r.stageId);
    const before = await seatsByRole(r.stageId);
    await rebuildStageFixtures(r.auth, r.stageId);
    const after = await seatsByRole(r.stageId);
    expect(after.size, "anti-vacuity: lines compared").toBe(7);
    expect(after, "RB4-D5: every role holds the same seats after a Rebuild with the roster unchanged").toEqual(before);
    expect(await readStageDrawSeed(sql as never, r.stageId), "the Rebuild's own row records the same seed").toBe(swissDrawSeed(r.stageId));
  });

  it("a wholly seeded field is not drawn: the fold over the seeds, and no draw_seed recorded", async () => {
    const r = await rig({ seeds: [1, 2, 3, 4, 5, 6] });
    const active = await activeOrder(r.divisionId);
    const seedOf = (id: string) => active.find((e) => e.id === id)?.seed ?? null;
    const want = engineSeats(active.map((e) => e.id), seedOf);
    await generateStageFixtures(r.auth, r.stageId);
    const got = await storedSeats(r.stageId);
    expect(got.seats).toEqual(want.seats);
    const audits = await generateAudits(r.divisionId, r.stageId);
    expect(audits.length).toBe(1);
    expect(audits[0]!.draw_seed, "nothing was drawn, so no seed is recorded").toBeUndefined();
    expect(await readStageDrawSeed(sql as never, r.stageId)).toBeNull();
  });
});

describe.skipIf(!HAS_DB)("X-SD-9 an API slotOrder overrides the draw", () => {
  it("X-SD-9 an API slotOrder overrides the draw", async () => {
    // A slot map over a field of six (bracket of eight): each seed 1..6 once, null = a bye, never two byes on one line.
    const slotOrder = [1, null, 4, 5, 3, 6, null, 2];
    const r = await rig({
      seeds: UNSEEDED_6,
      config: { slotOrder },
      // Premise: the draw would seat this field differently under the same slot map, so obeying the map and drawing are
      // distinguishable on this stage.
      premise: (stageId, active) =>
        [...engineSeats(drawn(stageId, active), () => null, { slotOrder }).seats.values()].join() !==
        [...engineSeats(active.map((e) => e.id), () => null, { slotOrder }).seats.values()].join(),
    });
    const active = await activeOrder(r.divisionId);
    // The slot map indexes into the field as the active select orders it — the engine's own reading.
    const want = engineSeats(active.map((e) => e.id), () => null, { slotOrder });
    await generateStageFixtures(r.auth, r.stageId);
    const got = await storedSeats(r.stageId);
    let lines = 0;
    for (const [ext, seats] of want.seats) {
      expect(got.seats.get(ext), `line ${ext} follows the slot map`).toBe(seats);
      lines++;
    }
    expect(lines, "anti-vacuity").toBe(4);
    const audits = await generateAudits(r.divisionId, r.stageId);
    expect(audits.length).toBe(1);
    expect(audits[0]!.draw_seed, "RB4-D6: nothing was drawn").toBeUndefined();
    expect(await readStageDrawSeed(sql as never, r.stageId)).toBeNull();
  });
});

describe.skipIf(!HAS_DB)("sequence: a fed knockout is never shuffled", () => {
  it("a fed knockout (league then knockout) is never shuffled: its config.qualified order is the seeding", async () => {
    // seedNextStage writes the qualified list as `config.qualified`; Generate draws from it in that order (stages/) —
    // the published seeding. Every qualifier is unseeded on the roster, so a draw, were it run, would move them.
    const { auth } = await seedOrg("pro");
    const comp = await createCompetition(auth, { ends_on: "2030-12-31", name: "W4 T7 fed " + randomUUID().slice(0, 6), visibility: "private", branding: {} });
    const division = await createDivision(auth, comp.id, {
      name: "Open",
      slug: "open-" + randomUUID().slice(0, 6),
      sport_key: BADMINTON.key,
      variant_key: BADMINTON.variant,
      config: {},
    });
    const entrants = await createEntrants(
      auth,
      division.id,
      UNSEEDED_6.map((seed, i) => ({ kind: "individual" as const, display_name: `Q${i + 1}`, seed, members: [] })),
    );
    const [, ko] = await createStages(auth, division.id, [
      { seq: 1, kind: "league", name: "League", config: {}, progression: null },
      {
        seq: 2,
        kind: "knockout",
        name: "KO",
        config: {},
        progression: { sources: [{ stage: "previous", take: [{ kind: "rankRange", from: 1, to: 6 }] }], placement: "rank_order", timing: "on_complete" },
      },
    ]);
    // A qualification order that is neither registration order nor the draw's (reversed registration).
    const qualified = [...entrants.map((e) => e.id)].reverse();
    expect(drawn(ko!.id, qualified.map((id) => ({ id, seed: null }))), "premise: a draw would reorder them").not.toEqual(qualified);
    await sql`update stages set config = ${sql.json({ qualified } as never)} where id = ${ko!.id}`;
    await generateStageFixtures(auth, ko!.id);
    const want = engineSeats(qualified, (id) => qualified.indexOf(id) + 1);
    const got = await storedSeats(ko!.id);
    let lines = 0;
    for (const [ext, seats] of want.seats) {
      expect(got.seats.get(ext), `line ${ext}: the qualification order's fold`).toBe(seats);
      lines++;
    }
    expect(lines, "anti-vacuity").toBe(4);
    const audits = await generateAudits(division.id, ko!.id);
    expect(audits.length).toBe(1);
    expect(audits[0]!.draw_seed, "a fed knockout records no draw").toBeUndefined();
  });
});
