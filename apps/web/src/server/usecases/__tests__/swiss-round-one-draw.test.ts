// W3 Task 8 (spec 2026-10-31-format-matrix-w3-swiss-design.md §12) — a Swiss round 1, through the real Pair:
//   X-SW-22 (SW-L6, REC RB3-16): an unseeded round 1 is a seeded random draw over the stage's own seed, recorded on the
//           Pair's `fixtures_generated` row (`draw_seed`) so it replays; seeded entrants keep their seed order ahead of it.
//   BG-SW-1 (SW-H3, REC RB3-10): a boardgame Swiss stage CREATED after this change is stored with `chess: true` (the
//           create door's default); round 1's colours are by lot (`colour_lot`): board 1's upper player takes the lot's
//           colour and the boards alternate (FIDE C.04.3 A3 5.1). Home is White. A stage stored before it with `chess`
//           unset keeps today's colours (orchestrator ruling m5), and an explicit `chess: false` is kept.
//
// The defect (SW-H3) on main: a boardgame Swiss stage stored no `chess`, so the pairer gave the upper board White in
// every round — the stronger player never got Black. And (SW-L6) round 1 paired an unseeded field in the active
// select's order (`created_at, id`), so who met whom was an accident of registration.
//
// Every assertion is on the SEATS (`home_entrant_id`/`away_entrant_id`). Expected values come from the rulebook (the
// alternation rule; a player with White in round 1 takes Black in round 2 where the pairing allows) or from the pure
// functions `lib/swiss-draw.ts` exports (pinned against the rulebook in swiss-draw.test.ts) composed with the engine's
// own `pairRound` — never from swissGen.
import { afterAll, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { StageKind } from "@seazn/engine/core";
import { pairRound, type SwissStanding } from "@seazn/engine/scheduling";
import type { AnySportModule } from "@seazn/engine/sport";
import { builtinModules } from "@seazn/engine/sports";
import { sportRefusesStageKind } from "@/lib/chess-individual-only";
import { sql } from "@/lib/db";
import { applyRoundOneColourLot, swissColourLot, swissDrawSeed, swissRoundOneOrder } from "@/lib/swiss-draw";
import type { AuthCtx } from "@/server/api-v1/auth";
import { createCompetition } from "../competitions";
import { createDivision } from "../divisions";
import { createEntrants } from "../entrants";
import { redoDivision, undoDivision } from "../history";
import { startDivision } from "../schedule";
import { scoreEvent } from "../scoring";
import { validatedStageConfig } from "../stage-defaults";
import { createStages, generateStageFixtures, replaceStages, unpairSwissRound } from "../stages";
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

type Sport = "boardgame" | "badminton";
type Door = "createStages" | "replaceStages" | "sql-legacy";
type Board = { id: string; ext_key: string; seq_in_round: number; home: string; away: string; status: string };

interface Rig {
  auth: AuthCtx;
  divisionId: string;
  stageId: string;
  /** Entrant ids in registration (createEntrants) order. */
  ids: string[];
  seedOf: (id: string) => number | null;
  name: (id: string) => string;
}

const VARIANT: Record<Sport, string> = { boardgame: "classical", badminton: "bwf" };

/** A division of `n` individuals P1..Pn (seeded 1..n when `seeded`), and one Swiss stage of `rounds` written through
 *  `door`: the create door, the Format tab's replace door, or — for a stage stored before W3 — a bare SQL row whose
 *  config carries no `chess` (exactly what every pre-W3 create stored). */
async function rig(opts: { sport: Sport; n: number; seeded: boolean; door: Door; config?: Record<string, unknown> }): Promise<Rig> {
  const { auth } = await seedOrg("pro");
  const comp = await createCompetition(auth, {
    ends_on: "2030-12-31",
    name: "W3 T8 " + randomUUID().slice(0, 6),
    visibility: "private",
    branding: {},
  });
  const division = await createDivision(auth, comp.id, {
    name: "Open",
    slug: "open-" + randomUUID().slice(0, 6),
    sport_key: opts.sport,
    variant_key: VARIANT[opts.sport],
    config: {},
  });
  const entrants = await createEntrants(
    auth,
    division.id,
    Array.from({ length: opts.n }, (_, i) => ({
      kind: "individual" as const,
      display_name: `P${i + 1}`,
      seed: opts.seeded ? i + 1 : null,
      members: [],
    })),
  );
  const config = opts.config ?? { rounds: 3 };
  let stageId: string;
  if (opts.door === "sql-legacy") {
    const [row] = await sql<{ id: string }[]>`
      insert into stages (division_id, seq, kind, name, config, progression)
      values (${division.id}, 1, 'swiss', 'Swiss', ${sql.json(config as never)}, null) returning id`;
    stageId = row!.id;
  } else {
    const input = { seq: 1, kind: "swiss" as const, name: "Swiss", config, progression: null };
    const [stage] = opts.door === "createStages" ? await createStages(auth, division.id, input) : await replaceStages(auth, division.id, [input]);
    stageId = stage!.id;
  }
  const seeds = new Map(entrants.map((e) => [e.id, e.seed ?? null]));
  const names = new Map(entrants.map((e) => [e.id, e.display_name]));
  return {
    auth,
    divisionId: division.id,
    stageId,
    ids: entrants.map((e) => e.id),
    seedOf: (id) => seeds.get(id) ?? null,
    name: (id) => names.get(id) ?? id,
  };
}

const stageConfig = async (stageId: string) =>
  (await sql<{ config: Record<string, unknown> }[]>`select config from stages where id = ${stageId}`)[0]!.config;

/** Round `r`'s two-seated boards, in board order. */
async function boards(stageId: string, r: number): Promise<Board[]> {
  return sql<Board[]>`
    select id, ext_key, seq_in_round, home_entrant_id as home, away_entrant_id as away, status
      from fixtures
     where stage_id = ${stageId} and round_no = ${r} and home_entrant_id is not null and away_entrant_id is not null
     order by seq_in_round`;
}

/** Every Pair's `fixtures_generated` payload for the stage that seated round `r`, oldest first. */
async function pairAudits(divisionId: string, stageId: string, r: number): Promise<Record<string, unknown>[]> {
  const rows = await sql<{ payload: Record<string, unknown> }[]>`
    select payload from division_events
     where division_id = ${divisionId} and type = 'fixtures_generated'
       and payload->>'stage_id' = ${stageId} and (payload->>'round')::int = ${r}
     order by seq`;
  return rows.map((x) => x.payload);
}

/** The field the Pair reads, in the order it reads it (the active select: `seed nulls last, created_at, id`). Entrants
 *  created in one batch share a `created_at`, so this — not the createEntrants order — is what main paired in. */
async function activeOrder(divisionId: string): Promise<{ id: string; seed: number | null }[]> {
  return sql<{ id: string; seed: number | null }[]>`
    select id, seed from entrants where division_id = ${divisionId} and status in ('registered', 'confirmed')
     order by seed nulls last, created_at, id`;
}

/** The engine's own round 1 over `order` (rank = position), board by board: what the Pair hands on before any lot. */
function engineRoundOne(order: readonly string[], chess: boolean): { home: string; away: string }[] {
  const standings: SwissStanding[] = order.map((id, i) => ({ entrantId: id, score: 0, rank: i + 1 }) as SwissStanding);
  return pairRound(standings, { played: new Set() }, { chess }).pairings.map((p) => ({ home: p.home, away: p.away }));
}

/** The seats we expect for round 1: the draw (X-SW-22), the engine's pairing, and — chess on — the lot (BG-SW-1). */
function expectedRoundOne(stageId: string, field: readonly { id: string; seed: number | null }[], chess: boolean) {
  const seed = swissDrawSeed(stageId);
  const paired = engineRoundOne(swissRoundOneOrder(seed, field), chess);
  return chess ? applyRoundOneColourLot(paired, swissColourLot(seed)) : paired;
}

const seats = (bs: readonly Board[]) => bs.map((b) => ({ home: b.home, away: b.away }));

/** A decisive chess result through the scorer's quick result (the real append path). */
async function chessWin(auth: AuthCtx, b: Board, winner: string): Promise<void> {
  await scoreEvent(auth, b.id, { expected_seq: 0, type: "core.start", payload: {} });
  await scoreEvent(auth, b.id, { expected_seq: 1, type: "boardgame.result", payload: { winner, method: "resign" } });
}

/** Round 1 decided so that every round-2 board pairs two players of OPPOSITE round-1 colours, whatever the lot: boards
 *  1-2 to the upper (lower-seeded) player, boards 3-4 to the lower. Over seeds 1..8 the fold sends S1, S2, S7, S8 up and
 *  S3, S4, S5, S6 down, and round 2's fold pairs S1-S7, S2-S8, S3-S5, S4-S6: each of those met across a colour boundary
 *  of the alternating round 1. (A rig where the round-2 pairs share a colour could not witness SW-H3.) */
async function decideRoundOne(r: Rig, r1: readonly Board[]): Promise<void> {
  for (const b of r1) {
    const homeUpper = r.seedOf(b.home)! < r.seedOf(b.away)!;
    const upper = homeUpper ? b.home : b.away;
    const lower = homeUpper ? b.away : b.home;
    await chessWin(r.auth, b, b.seq_in_round <= 2 ? upper : lower);
  }
}

describe.runIf(HAS_DB)("BG-SW-1 chess colours are on by default for a NEW boardgame Swiss; round 1 by lot", () => {
  it.each(["createStages", "replaceStages"] as const)(
    "BG-SW-1 a boardgame Swiss stage created after deploy stores chess: true and alternates colours in round 2 (%s)",
    async (door) => {
      const r = await rig({ sport: "boardgame", n: 8, seeded: true, door });
      expect((await stageConfig(r.stageId)).chess, "stored by the create door").toBe(true);
      await startDivision(r.auth, r.divisionId); // mints the shells
      await generateStageFixtures(r.auth, r.stageId); // Pair round 1

      const r1 = await boards(r.stageId, 1);
      expect(r1, "eight players, four boards").toHaveLength(4);
      const [audit] = await pairAudits(r.divisionId, r.stageId, 1);
      expect(audit?.colour_lot, "the lot is the stage's own, recorded").toBe(swissColourLot(swissDrawSeed(r.stageId)));
      expect(audit, "a seeded field is not drawn").not.toHaveProperty("draw_seed");
      // FIDE C.04.3 A3 5.1: board 1's upper player takes the lot's colour, and every board after alternates.
      const upperWhite = r1.map((b) => r.seedOf(b.home)! < r.seedOf(b.away)!);
      expect(upperWhite[0], "board 1's upper player has the lot's colour").toBe(audit?.colour_lot === "white");
      for (let i = 1; i < upperWhite.length; i++) expect(upperWhite[i], `board ${i + 1} alternates`).toBe(!upperWhite[i - 1]);

      const whiteInRoundOne = new Map<string, boolean>();
      for (const b of r1) {
        whiteInRoundOne.set(b.home, true);
        whiteInRoundOne.set(b.away, false);
      }
      await decideRoundOne(r, r1);
      await generateStageFixtures(r.auth, r.stageId); // Pair round 2
      const r2 = await boards(r.stageId, 2);
      expect(r2).toHaveLength(4);
      let allowed = 0;
      let players = 0;
      for (const b of r2) {
        // Where the pairing allows: two players who both had the same colour cannot both switch.
        if (whiteInRoundOne.get(b.home) === whiteInRoundOne.get(b.away)) continue;
        allowed++;
        expect(whiteInRoundOne.get(b.home), `${r.name(b.home)} (White now) had Black in round 1`).toBe(false);
        expect(whiteInRoundOne.get(b.away), `${r.name(b.away)} (Black now) had White in round 1`).toBe(true);
        players += 2;
      }
      console.info(`BG-SW-1 (${door}): ${r2.length} round-2 boards, ${allowed} pair opposite round-1 colours, ${players} players switched`);
      expect(allowed, "the rig pairs opposite colours on every round-2 board").toBe(4);
      expect(players).toBe(8);
    },
  );

  it("BG-SW-1 an EXISTING boardgame Swiss stage with chess unset keeps today's colours", async () => {
    const r = await rig({ sport: "boardgame", n: 8, seeded: true, door: "sql-legacy" });
    expect(Object.hasOwn(await stageConfig(r.stageId), "chess"), "premise: stored before W3, no chess key").toBe(false);
    await startDivision(r.auth, r.divisionId);
    await generateStageFixtures(r.auth, r.stageId);
    const r1 = await boards(r.stageId, 1);
    expect(r1).toHaveLength(4);
    await decideRoundOne(r, r1);
    await generateStageFixtures(r.auth, r.stageId);
    const r2 = await boards(r.stageId, 2);
    expect(r2).toHaveLength(4);

    // Today's engine rule (non-chess, scheduling/swiss.ts `assignColours`): the upper board side is home. Upper = more
    // points, then the better seed. Points from the round-1 results read back.
    const won = new Set((await sql<{ w: string }[]>`
      select outcome->>'winner' as w from fixtures where stage_id = ${r.stageId} and round_no = 1`).map((x) => x.w));
    const pts = (id: string) => (won.has(id) ? 1 : 0);
    let checked = 0;
    for (const b of r1) {
      expect(r.seedOf(b.home)! < r.seedOf(b.away)!, `round 1 ${b.ext_key}: the upper seed is home`).toBe(true);
      checked++;
    }
    for (const b of r2) {
      const homeUpper = pts(b.home) > pts(b.away) || (pts(b.home) === pts(b.away) && r.seedOf(b.home)! < r.seedOf(b.away)!);
      expect(homeUpper, `round 2 ${b.ext_key}: the upper board side is home`).toBe(true);
      checked++;
    }
    console.info(`BG-SW-1 m5: ${checked} boards upper-at-home across rounds 1-2`);
    expect(checked).toBe(8);
    for (const round of [1, 2]) {
      const audits = await pairAudits(r.divisionId, r.stageId, round);
      expect(audits.length, `round ${round} was paired once`).toBe(1);
      expect(audits[0], `round ${round}: no colour lot outside chess`).not.toHaveProperty("colour_lot");
    }
    expect(Object.hasOwn(await stageConfig(r.stageId), "chess"), "Pair never writes the default").toBe(false);
  });

  it("BG-SW-1 an explicit chess: false on a new boardgame stage is kept", async () => {
    const r = await rig({ sport: "boardgame", n: 8, seeded: true, door: "createStages", config: { rounds: 3, chess: false } });
    expect((await stageConfig(r.stageId)).chess).toBe(false);
    await startDivision(r.auth, r.divisionId);
    await generateStageFixtures(r.auth, r.stageId);
    const r1 = await boards(r.stageId, 1);
    expect(r1).toHaveLength(4);
    for (const b of r1) expect(r.seedOf(b.home)! < r.seedOf(b.away)!, `${b.ext_key}: upper seed home, no lot`).toBe(true);
    const [audit] = await pairAudits(r.divisionId, r.stageId, 1);
    expect(audit).toBeDefined();
    expect(audit).not.toHaveProperty("colour_lot");
  });

  it("BG-SW-1 the lot refuses a round 1 the engine did not seat upper-at-home (its premise, guarded), writing nothing", async () => {
    const r = await rig({ sport: "boardgame", n: 4, seeded: true, door: "createStages" });
    await startDivision(r.auth, r.divisionId);
    const engine = await import("@seazn/engine/scheduling");
    const real = engine.pairRound;
    const spy = vi.spyOn(engine, "pairRound").mockImplementation((...args: Parameters<typeof real>) => {
      const out = real(...args);
      // The premise broken on board 2: the lower player at home.
      return { ...out, pairings: out.pairings.map((p, i) => (i === 1 ? { ...p, home: p.away, away: p.home } : p)) };
    });
    try {
      await expect(generateStageFixtures(r.auth, r.stageId)).rejects.toMatchObject({ code: "CONFIG_INVALID" });
      expect(spy.mock.calls.length, "anti-vacuity: the Pair reached the engine").toBe(1);
    } finally {
      spy.mockRestore();
    }
    expect(await boards(r.stageId, 1), "the refusal seated nobody").toHaveLength(0);
    // And the real engine pairs it.
    await generateStageFixtures(r.auth, r.stageId);
    expect(await boards(r.stageId, 1)).toHaveLength(2);
  });
});

describe.runIf(HAS_DB)("X-SW-22 an unseeded round 1 is the stage's seeded random draw", () => {
  it("X-SW-22 the audit payload records draw_seed and colour_lot, and round 1 seats the draw, not registration order", async () => {
    const r = await rig({ sport: "boardgame", n: 16, seeded: false, door: "createStages" });
    await startDivision(r.auth, r.divisionId);
    await generateStageFixtures(r.auth, r.stageId);
    const seed = swissDrawSeed(r.stageId);
    const audits = await pairAudits(r.divisionId, r.stageId, 1);
    expect(audits).toHaveLength(1);
    expect(audits[0]!.draw_seed, "the stage's seed, recorded so the draw replays").toBe(seed);
    expect(audits[0]!.colour_lot).toBe(swissColourLot(seed));

    const field = await activeOrder(r.divisionId);
    expect(field.length).toBe(16);
    const r1 = await boards(r.stageId, 1);
    expect(seats(r1), "round 1 is the draw, paired by the engine, coloured by the lot").toEqual(expectedRoundOne(r.stageId, field, true));
    // The regression: main seated the engine's fold over the active order. 16 unseeded players: the draw's pairs equal it
    // with probability 8!·2^8/16! (about 5e-7).
    const pairSet = (ps: { home: string; away: string }[]) => ps.map((p) => [p.home, p.away].sort().join("|")).sort();
    expect(pairSet(seats(r1)), "not the registration-order pairing").not.toEqual(pairSet(engineRoundOne(field.map((e) => e.id), true)));
  });

  it("X-SW-22 seeded entrants keep their seed order; only the unseeded are drawn", async () => {
    const r = await rig({ sport: "badminton", n: 8, seeded: false, door: "createStages" });
    // Seed the first three registered (3, 1, 2); the other five stay unseeded.
    for (const [i, seed] of [3, 1, 2].entries()) await sql`update entrants set seed = ${seed} where id = ${r.ids[i]!}`;
    await startDivision(r.auth, r.divisionId);
    await generateStageFixtures(r.auth, r.stageId);
    const field = await activeOrder(r.divisionId);
    const order = swissRoundOneOrder(swissDrawSeed(r.stageId), field);
    expect(order.slice(0, 3), "seeds 1, 2, 3 head the order").toEqual([r.ids[1], r.ids[2], r.ids[0]]);
    expect(seats(await boards(r.stageId, 1))).toEqual(expectedRoundOne(r.stageId, field, false));
    const [audit] = await pairAudits(r.divisionId, r.stageId, 1);
    expect(audit?.draw_seed).toBe(swissDrawSeed(r.stageId));
  });
});

describe.runIf(HAS_DB)("X-SW-22 / BG-SW-1 sequences", () => {
  it("a second Pair of round 1 replays the same draw and lot: Unpair then Pair, and Undo then Redo (the step path)", async () => {
    const r = await rig({ sport: "boardgame", n: 8, seeded: false, door: "createStages" });
    await startDivision(r.auth, r.divisionId);
    await generateStageFixtures(r.auth, r.stageId);
    const first = seats(await boards(r.stageId, 1));
    expect(first).toEqual(expectedRoundOne(r.stageId, await activeOrder(r.divisionId), true));

    await unpairSwissRound(r.auth, r.stageId);
    expect(await boards(r.stageId, 1), "Unpair cleared the seats").toHaveLength(0);
    await generateStageFixtures(r.auth, r.stageId);
    expect(seats(await boards(r.stageId, 1)), "Pair again: the same seats").toEqual(first);

    await undoDivision(r.auth, r.divisionId);
    expect(await boards(r.stageId, 1), "Undo cleared the seats").toHaveLength(0);
    await redoDivision(r.auth, r.divisionId);
    expect(seats(await boards(r.stageId, 1)), "Redo re-pairs through the step path: the same seats").toEqual(first);
    const audits = await pairAudits(r.divisionId, r.stageId, 1);
    expect(audits.length, "three Pairs of round 1 on the ledger").toBeGreaterThanOrEqual(2);
    for (const a of audits) {
      expect(a.draw_seed).toBe(swissDrawSeed(r.stageId));
      expect(a.colour_lot).toBe(swissColourLot(swissDrawSeed(r.stageId)));
    }
  });

  it("after a withdrawal before Start, the draw is over the field that stays", async () => {
    const r = await rig({ sport: "boardgame", n: 9, seeded: false, door: "createStages" });
    const gone = r.ids[4]!;
    await withdrawEntrantCascade(r.auth, gone);
    await startDivision(r.auth, r.divisionId);
    await generateStageFixtures(r.auth, r.stageId);
    const field = await activeOrder(r.divisionId);
    expect(field.map((e) => e.id), "premise: the withdrawn player left the field").not.toContain(gone);
    expect(field.length).toBe(8);
    const r1 = await boards(r.stageId, 1);
    expect(seats(r1)).toEqual(expectedRoundOne(r.stageId, field, true));
    expect(r1.some((b) => b.home === gone || b.away === gone), "the withdrawn player is on no board").toBe(false);
  });

  it("the smallest field: two unseeded players, one board, coloured by the lot", async () => {
    const r = await rig({ sport: "boardgame", n: 2, seeded: false, door: "createStages" });
    await startDivision(r.auth, r.divisionId);
    await generateStageFixtures(r.auth, r.stageId);
    const field = await activeOrder(r.divisionId);
    const r1 = await boards(r.stageId, 1);
    expect(r1).toHaveLength(1);
    const order = swissRoundOneOrder(swissDrawSeed(r.stageId), field);
    // Board 1: the upper (first-drawn) player has White iff the lot is white.
    const white = swissColourLot(swissDrawSeed(r.stageId)) === "white" ? order[0] : order[1];
    expect(r1[0]!.home).toBe(white);
  });

  it("a single entrant: the Pair is refused by name before any draw or lot (a round 1 always holds a board), writing nothing", async () => {
    // The premise swissGen's lot leans on (no "empty round 1" branch): the generate door refuses a field under two, and
    // Start, which mints the Swiss through it, is refused with it.
    const r = await rig({ sport: "boardgame", n: 1, seeded: false, door: "createStages" });
    expect((await stageConfig(r.stageId)).chess, "premise: a chess Swiss").toBe(true);
    await expect(startDivision(r.auth, r.divisionId)).rejects.toMatchObject({ code: "STAGE_NOT_READY" });
    expect(await boards(r.stageId, 1), "no board seated").toEqual([]);
    expect(await pairAudits(r.divisionId, r.stageId, 1), "no Pair recorded: no draw_seed, no colour_lot").toEqual([]);
  });

  it("a badminton Swiss keeps upper-at-home in round 1: no lot outside chess, and a seeded field is not drawn", async () => {
    const r = await rig({ sport: "badminton", n: 8, seeded: true, door: "createStages" });
    expect(Object.hasOwn(await stageConfig(r.stageId), "chess"), "no chess default outside boardgame").toBe(false);
    await startDivision(r.auth, r.divisionId);
    await generateStageFixtures(r.auth, r.stageId);
    const r1 = await boards(r.stageId, 1);
    expect(r1).toHaveLength(4);
    for (const b of r1) expect(r.seedOf(b.home)! < r.seedOf(b.away)!, `${b.ext_key}: the upper seed is home`).toBe(true);
    // The seeded order is the seed order: the same seats the engine gives seeds 1..8 with no lot.
    expect(seats(r1)).toEqual(engineRoundOne(r.ids, false));
    const [audit] = await pairAudits(r.divisionId, r.stageId, 1);
    expect(audit).toBeDefined();
    expect(audit).not.toHaveProperty("colour_lot");
    expect(audit).not.toHaveProperty("draw_seed");
  });

  it("an unseeded badminton Swiss is drawn (X-SW-22 is every sport's) and still takes no lot", async () => {
    const r = await rig({ sport: "badminton", n: 8, seeded: false, door: "createStages" });
    await startDivision(r.auth, r.divisionId);
    await generateStageFixtures(r.auth, r.stageId);
    expect(seats(await boards(r.stageId, 1))).toEqual(expectedRoundOne(r.stageId, await activeOrder(r.divisionId), false));
    const [audit] = await pairAudits(r.divisionId, r.stageId, 1);
    expect(audit?.draw_seed).toBe(swissDrawSeed(r.stageId));
    expect(audit).not.toHaveProperty("colour_lot");
  });
});

// The create door itself, every sport x every variant x every stage kind (DB-free: `validatedStageConfig` is the one
// door every stage-creating path calls — createStages, replaceStages and the template door). RB3-10's default is a
// SWISS default on a CHESS division, and nothing else: a boardgame league or knockout stores no `chess`.
describe("BG-SW-1 the create-time default is the boardgame Swiss's alone", () => {
  it("BG-SW-1 every sport x variant x kind: chess: true is stored exactly on a boardgame Swiss (counted)", () => {
    let checked = 0;
    let chessCells = 0;
    let refused = 0;
    for (const m of builtinModules as readonly AnySportModule[]) {
      for (const variant of Object.keys(m.variants)) {
        const division = m.configSchema.parse(m.variants[variant]);
        for (const kind of StageKind.options) {
          if (sportRefusesStageKind(m.key, kind)) {
            refused++;
            continue;
          }
          const stored = validatedStageConfig(m, m.key, kind, variant, division, kind === "swiss" ? { rounds: 3 } : {});
          // The rule (RB3-10), stated apart from the code: a Swiss stage on the chess sport.
          const owed = kind === "swiss" && m.key === "boardgame";
          if (owed) {
            expect(stored.chess, `${m.key}/${variant}/${kind}`).toBe(true);
            chessCells++;
          } else {
            expect(Object.hasOwn(stored, "chess"), `${m.key}/${variant}/${kind}: no chess key`).toBe(false);
          }
          checked++;
        }
      }
    }
    const chessVariants = Object.keys((builtinModules as readonly AnySportModule[]).find((m) => m.key === "boardgame")!.variants).length;
    console.info(`BG-SW-1: ${checked} (sport, variant, kind) configs, ${chessCells} chess, ${refused} refused kinds skipped`);
    expect(checked, "anti-vacuity").toBeGreaterThan(StageKind.options.length);
    expect(chessCells, "one chess Swiss per boardgame variant").toBe(chessVariants);
    expect(chessVariants, "the registry carries chess variants").toBeGreaterThan(0);
  });
});
