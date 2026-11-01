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
    // Review m4 — exactly three, one per Pair: the first Pair and the Pair after Unpair each append their own row
    // (`ledger: "record"`); Unpair appends no ledger row at all and the Undo one of another type; the Redo appends no fresh row but re-pairs on
    // the step's own `fixtures_generated` row (history.ts, batch-1 I1: `ledger: "step"`), which carries the audit spread.
    // Two would mean the step path dropped its audit; four would mean the Redo appended a fresh Pair as well.
    expect(
      audits.map((a) => a.seated_fixture_ids !== undefined),
      "three Pairs of round 1 on the ledger, each naming its seats",
    ).toEqual([true, true, true]);
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
// ---------------------------------------------------------------------------------------------------------------------
// Review m7 (ruling: persist the drawn order). FIDE fixes pairing numbers from the initial ranking, so the draw that
// stood in for it in round 1 is the tie-break inside a score group for every later round — not registration order.
// Expected seats are hand-derived from round 1's own SEATS: round 1 folds the draw d1..d8 upper-at-home (board k is
// d_k v d_k+4), the upper half wins, so round 2's score groups are {d1..d4} and {d5..d8}, each folded by pairing number:
// d1 v d3, d2 v d4, d5 v d7, d6 v d8. The rig re-mints its stage until registration order would fold a group differently
// (each stage id is a fresh draw), so registration order cannot pass. Chess colours are OFF here (explicit
// `chess: false` on the boardgame): a colour preference may transpose a fold, and this witness is the fold's order.
// ---------------------------------------------------------------------------------------------------------------------

/** A decisive result through the real append path: chess by resignation, badminton by two 21-10 games. */
async function win(sport: Sport, auth: AuthCtx, b: Board, winner: string): Promise<void> {
  if (sport === "boardgame") return chessWin(auth, b, winner);
  await scoreEvent(auth, b.id, { expected_seq: 0, type: "core.start", payload: {} });
  for (const seq of [1, 2]) {
    await scoreEvent(auth, b.id, {
      expected_seq: seq,
      type: "badminton.game.summary",
      payload: b.home === winner ? { home: 21, away: 10 } : { home: 10, away: 21 },
    });
  }
}

/** A score group's fold over the order given, as unordered pairs: top half v bottom half. */
const foldPairs = (group: readonly string[]) => {
  const half = group.length / 2;
  return group
    .slice(0, half)
    .map((a, i) => [a, group[i + half]!].sort().join("+"))
    .sort();
};
/** `group` re-ordered by `order`. */
const inOrder = (group: readonly string[], order: readonly string[]) => [...group].sort((a, b) => order.indexOf(a) - order.indexOf(b));

const NO_CHESS: Record<Sport, Record<string, unknown>> = { boardgame: { rounds: 3, chess: false }, badminton: { rounds: 3 } };

/** Re-mint the rig's stage (before Start: a new stage, a new id, a new draw) until `premise` holds of its draw over the
 *  active field. Each try is a fresh draw, so a few suffice; the count rides on the assertion. */
async function restageUntil(r: Rig, config: Record<string, unknown>, premise: (draw: string[], reg: string[]) => boolean) {
  const field = await activeOrder(r.divisionId);
  const reg = field.map((e) => e.id);
  const input = { seq: 1, kind: "swiss" as const, name: "Swiss", config, progression: null };
  let tries = 1;
  while (!premise(swissRoundOneOrder(swissDrawSeed(r.stageId), field), reg) && tries < 40) {
    r.stageId = (await replaceStages(r.auth, r.divisionId, [input]))[0]!.id;
    tries++;
  }
  expect(premise(swissRoundOneOrder(swissDrawSeed(r.stageId), field), reg), `rig premise (${tries} tries)`).toBe(true);
}

/** Started, round 1 paired over the draw d1..d8 and decided for the upper half; returns d from round 1's seats. */
async function roundOneDecided(r: Rig, sport: Sport): Promise<string[]> {
  await startDivision(r.auth, r.divisionId);
  await generateStageFixtures(r.auth, r.stageId);
  const r1 = await boards(r.stageId, 1);
  expect(r1, "eight entrants, four boards").toHaveLength(4);
  const d = [...r1.map((b) => b.home), ...r1.map((b) => b.away)];
  for (const b of r1) await win(sport, r.auth, b, b.home);
  return d;
}

/** Round 2 by pairing number d1..d8, hand-derived (see the header). */
const roundTwoByDraw = (d: readonly string[]) => [
  { home: d[0]!, away: d[2]! },
  { home: d[1]!, away: d[3]! },
  { home: d[4]!, away: d[6]! },
  { home: d[5]!, away: d[7]! },
];

describe.runIf(HAS_DB)("m7 the draw is the stage's pairing numbers: round 2 breaks a score-group tie by it", () => {
  it.each(["badminton", "boardgame"] as const)(
    "m7 a round-2 tie inside a score group is ordered by the draw, not registration (%s)",
    async (sport) => {
      const r = await rig({ sport, n: 8, seeded: false, door: "createStages", config: NO_CHESS[sport] });
      // Premise: registration order folds a round-2 group differently from the draw.
      await restageUntil(r, NO_CHESS[sport], (draw, reg) =>
        [draw.slice(0, 4), draw.slice(4)].some((g) => foldPairs(inOrder(g, reg)).join() !== foldPairs(g).join()),
      );
      const d = await roundOneDecided(r, sport);
      expect(d, "premise: round 1 seated the stage's draw").toEqual(swissRoundOneOrder(swissDrawSeed(r.stageId), await activeOrder(r.divisionId)));
      const r1Rows = await pairAudits(r.divisionId, r.stageId, 1);
      expect(r1Rows.at(-1), "a post-T8 stage: round 1's row carries the draw marker").toHaveProperty("draw_seed", swissDrawSeed(r.stageId));
      await generateStageFixtures(r.auth, r.stageId); // Pair round 2
      expect(seats(await boards(r.stageId, 2))).toEqual(roundTwoByDraw(d));
    },
    120_000,
  );

  it("m7 a second Pair of round 2 is identical: Unpair then Pair, and Undo then Redo", async () => {
    const r = await rig({ sport: "badminton", n: 8, seeded: false, door: "createStages", config: NO_CHESS.badminton });
    const d = await roundOneDecided(r, "badminton");
    await generateStageFixtures(r.auth, r.stageId);
    const first = seats(await boards(r.stageId, 2));
    expect(first, "premise: round 2 by the draw").toEqual(roundTwoByDraw(d));
    await unpairSwissRound(r.auth, r.stageId);
    expect(await boards(r.stageId, 2), "Unpair cleared round 2").toHaveLength(0);
    await generateStageFixtures(r.auth, r.stageId);
    expect(seats(await boards(r.stageId, 2)), "Pair again").toEqual(first);
    await undoDivision(r.auth, r.divisionId);
    expect(await boards(r.stageId, 2), "Undo cleared round 2").toHaveLength(0);
    await redoDivision(r.auth, r.divisionId);
    expect(seats(await boards(r.stageId, 2)), "Redo, through the step path").toEqual(first);
  }, 120_000);

  it("m7 a withdrawal after round 1 does not reshuffle the pairing numbers (round 1's SEATS are the drawn field)", async () => {
    // The guard: the order is re-derived from the entrants round 1 seated, withdrawn ones included. Re-drawn over the
    // entrants still active, the shuffle runs over seven and orders the winners differently — the rig makes sure it would.
    const r = await rig({ sport: "badminton", n: 8, seeded: false, door: "createStages", config: NO_CHESS.badminton });
    await restageUntil(r, NO_CHESS.badminton, (draw, reg) => {
      const gone = draw[7]!; // d8: round 1's last pairing number, a loser below
      // The shuffle reads its field in the active select's order: registration order, less the one who left.
      const left = reg.filter((id) => id !== gone).map((id) => ({ id, seed: null }));
      const redrawn = swissRoundOneOrder(swissDrawSeed(r.stageId), left);
      return foldPairs(inOrder(draw.slice(0, 4), redrawn)).join() !== foldPairs(draw.slice(0, 4)).join();
    });
    const d = await roundOneDecided(r, "badminton");
    await withdrawEntrantCascade(r.auth, d[7]!);
    const active = await activeOrder(r.divisionId);
    expect(active.map((e) => e.id), "premise: d8 left the field").not.toContain(d[7]);
    const redrawn = swissRoundOneOrder(swissDrawSeed(r.stageId), active);
    const winnersNow = foldPairs(inOrder(d.slice(0, 4), redrawn)).join();
    await generateStageFixtures(r.auth, r.stageId); // Pair round 2
    const r2 = seats(await boards(r.stageId, 2));
    expect(r2.slice(0, 2), "the winners' group folds by round 1's pairing numbers").toEqual(roundTwoByDraw(d).slice(0, 2));
    expect(r2.flatMap((b) => [b.home, b.away]), "the withdrawn entrant is not seated").not.toContain(d[7]);
    expect(winnersNow, "witness: a re-draw over the active field would have folded the winners otherwise").not.toBe(
      foldPairs(d.slice(0, 4)).join(),
    );
  }, 120_000);

  // Ruling (coordinator, fix round 1b): prod holds live Swiss stages whose round 1 was paired before T8, in registration
  // order. Their round 2+ keeps registration order: the draw is the tie-break only when round 1's own ledger row carries
  // `draw_seed` (round 1 was paired by the T8 code). The legacy state is built as a pre-T8 Pair left it: round 1 seated
  // as the fold over registration order, its ledger row without `draw_seed`.
  it.each(["badminton", "boardgame"] as const)(
    "m7 a LEGACY stage (round 1's ledger row has no draw_seed) keeps registration order in round 2 (%s)",
    async (sport) => {
      const r = await rig({ sport, n: 8, seeded: false, door: "createStages", config: NO_CHESS[sport] });
      // Premise: the draw would fold a round-2 group differently from registration order, so the gate is witnessed.
      await restageUntil(r, NO_CHESS[sport], (draw, reg) =>
        [reg.slice(0, 4), reg.slice(4)].some((g) => foldPairs(inOrder(g, draw)).join() !== foldPairs(g).join()),
      );
      await startDivision(r.auth, r.divisionId);
      await generateStageFixtures(r.auth, r.stageId); // Pair round 1 (today's code draws it)
      const reg = (await activeOrder(r.divisionId)).map((e) => e.id);
      // ...re-made as the pre-T8 Pair left it: the fold over registration order, board k = reg_k v reg_k+4, no marker.
      const r1 = await boards(r.stageId, 1);
      expect(r1, "eight entrants, four boards").toHaveLength(4);
      for (const [k, b] of r1.entries()) {
        await sql`update fixtures set home_entrant_id = ${reg[k]!}, away_entrant_id = ${reg[k + 4]!} where id = ${b.id}`;
      }
      // A pre-T8 row carries neither marker: no `draw_seed`, and no `draw_order` (T9 writes it beside the seed).
      const stripped = await sql`
        update division_events set payload = payload - 'draw_seed' - 'draw_order'
         where division_id = ${r.divisionId} and type = 'fixtures_generated'
           and payload->>'stage_id' = ${r.stageId} and (payload->>'round')::int = 1 and payload ? 'draw_seed'`;
      expect(stripped.count, "premise: round 1's row lost its marker").toBe(1);
      const legacy = await boards(r.stageId, 1);
      expect(seats(legacy), "premise: round 1 is the registration fold").toEqual([0, 1, 2, 3].map((k) => ({ home: reg[k]!, away: reg[k + 4]! })));
      for (const b of legacy) await win(sport, r.auth, b, b.home); // the upper half wins

      await generateStageFixtures(r.auth, r.stageId); // Pair round 2
      // Registration order as the tie-break, as before T8: each score group folded by registration.
      expect(seats(await boards(r.stageId, 2))).toEqual([
        { home: reg[0]!, away: reg[2]! },
        { home: reg[1]!, away: reg[3]! },
        { home: reg[4]!, away: reg[6]! },
        { home: reg[5]!, away: reg[7]! },
      ]);
    },
    120_000,
  );

  // W3 T9 (T8 review n1): round 1's ledger row records the drawn order itself (`draw_order`), and a later round reads it
  // as written instead of re-deriving it. The witness is relational: overwrite the stored order with a permutation that
  // folds both score groups differently, and round 2 must move with the STORED order, not the re-derived one.
  /** d with the last two of each half swapped: d1 d2 d4 d3 | d5 d6 d8 d7 — each group of four folds otherwise. */
  const permuted = (d: readonly string[]) => [d[0]!, d[1]!, d[3]!, d[2]!, d[4]!, d[5]!, d[7]!, d[6]!];
  it.each(["badminton", "boardgame"] as const)(
    "n1 round 1's Pair records its drawn order, and round 2 ranks by the STORED order (%s)",
    async (sport) => {
      const r = await rig({ sport, n: 8, seeded: false, door: "createStages", config: NO_CHESS[sport] });
      const d = await roundOneDecided(r, sport);
      const [audit] = await pairAudits(r.divisionId, r.stageId, 1);
      expect(audit?.draw_order, "round 1's row carries the order its seats were folded over").toEqual(d);
      const p = permuted(d);
      const moved = await sql`
        update division_events set payload = jsonb_set(payload, '{draw_order}', ${sql.json(p as never)})
         where division_id = ${r.divisionId} and type = 'fixtures_generated'
           and payload->>'stage_id' = ${r.stageId} and (payload->>'round')::int = 1`;
      expect(moved.count, "premise: one round-1 row rewritten").toBe(1);
      expect(roundTwoByDraw(p), "witness: the stored order folds round 2 otherwise than the re-derived one").not.toEqual(roundTwoByDraw(d));
      await generateStageFixtures(r.auth, r.stageId); // Pair round 2
      expect(seats(await boards(r.stageId, 2))).toEqual(roundTwoByDraw(p));
    },
    120_000,
  );

  it("n1 a late player's re-pair of round 1 (case (a)) records the new drawn order, and round 2 reads that row", async () => {
    // single-sport: badminton — the order and the row it rides on are the stage's, never the sport's (the Pair row test
    // above runs both).
    const r = await rig({ sport: "badminton", n: 7, seeded: false, door: "createStages", config: NO_CHESS.badminton });
    await startDivision(r.auth, r.divisionId);
    await generateStageFixtures(r.auth, r.stageId); // round 1: three boards and a bye
    const [late] = await createEntrants(r.auth, r.divisionId, [{ kind: "individual", display_name: "Late", members: [] }]);
    expect(late?.late_entry, "premise: nothing started, so (a) re-pairs round 1 with eight").toMatchObject({ case: "a", round: 1 });
    const r1 = await boards(r.stageId, 1);
    expect(r1, "eight: four boards").toHaveLength(4);
    const d = [...r1.map((b) => b.home), ...r1.map((b) => b.away)];
    expect(d).toContain(late!.id);
    const [row] = await sql<{ payload: Record<string, unknown> }[]>`
      select payload from division_events where division_id = ${r.divisionId} and type = 'swiss_late_entry'`;
    expect(row?.payload.draw_order, "the late-entry row carries the re-drawn order of the eight seated").toEqual(d);
    for (const b of r1) await win("badminton", r.auth, b, b.home);
    // The newest round-1 row is the late entry's: rewrite ITS order, and round 2 follows it.
    const p = permuted(d);
    await sql`
      update division_events set payload = jsonb_set(payload, '{draw_order}', ${sql.json(p as never)})
       where division_id = ${r.divisionId} and type = 'swiss_late_entry'`;
    await generateStageFixtures(r.auth, r.stageId);
    expect(seats(await boards(r.stageId, 2))).toEqual(roundTwoByDraw(p));
  }, 120_000);

  it("m7 a fully seeded field is unchanged: round 2 folds each score group by seed, and no draw is recorded", async () => {
    const r = await rig({ sport: "badminton", n: 8, seeded: true, door: "createStages", config: NO_CHESS.badminton });
    const d = await roundOneDecided(r, "badminton");
    const P = (n: number) => r.ids[n - 1]!; // P1..P8 seeded 1..8
    expect(d, "round 1 folds by seed: P1..P4 at home v P5..P8").toEqual([1, 2, 3, 4, 5, 6, 7, 8].map(P));
    await generateStageFixtures(r.auth, r.stageId);
    expect(seats(await boards(r.stageId, 2))).toEqual([
      { home: P(1), away: P(3) },
      { home: P(2), away: P(4) },
      { home: P(5), away: P(7) },
      { home: P(6), away: P(8) },
    ]);
    const [audit] = await pairAudits(r.divisionId, r.stageId, 2);
    expect(audit, "anti-vacuity: round 2's Pair row").toBeDefined();
    expect(audit, "no draw on a seeded field").not.toHaveProperty("draw_seed");
  }, 120_000);
});

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
