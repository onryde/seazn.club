// W3 Task 3, controller ruling (engine review): swissGen's load of the stage's existing fixtures had NO `ORDER BY`, and
// the colour history it hands `pairRound` is built by walking those rows in the order they come back. SQL promises no
// order without one. The index on (stage_id, round_no, seq_in_round) happens to return round order when the planner
// uses it, so the defect hid; a sequential or bitmap scan returns PHYSICAL order, and Postgres writes every UPDATE as a
// new tuple — so a round whose rows were touched after a later round's were written (a result, a re-seat, a slot move)
// reads back AFTER it, and a player's colours reach the engine reversed.
//
// The rig makes the physical order differ from round order by an honest no-op UPDATE of round 1 (a new tuple version
// for each row, exactly what any later write to those rows does), and runs Pair with the planner's index paths off for
// that transaction — a plan Postgres may legally choose on its own. A precondition proves the unordered read really
// comes back out of round order under that plan (else the case proves nothing). The expected history is the rule, read
// from the rows in round order: a game played holds a colour — home White, away Black (the fold) — and a forfeit holds
// none (boardgame `colorOf`).
//
// single-sport: boardgame — colours exist only for a chess Swiss (`chess: true`); the ORDER BY itself is sport-agnostic.
import { afterAll, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";

const planner = vi.hoisted(() => ({ indexPathsOff: false }));

vi.mock("@/lib/db", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/lib/db")>();
  return {
    ...real,
    withTenant: ((orgId, fn, opts) =>
      real.withTenant(
        orgId,
        async (tx) => {
          if (planner.indexPathsOff) {
            await tx`set local enable_indexscan = off`;
            await tx`set local enable_indexonlyscan = off`;
            await tx`set local enable_bitmapscan = off`;
          }
          return fn(tx);
        },
        opts,
      )) as typeof real.withTenant,
  };
});

import { sql } from "@/lib/db";
import type { Colour } from "@seazn/engine/scheduling";
import { createCompetition } from "../competitions";
import { createDivision } from "../divisions";
import { createEntrants } from "../entrants";
import { startDivision } from "../schedule";
import { scoreEvent } from "../scoring";
import { createStages, generateStageFixtures } from "../stages";
import { seedOrg } from "./_seed";

const HAS_DB = !!process.env.DATABASE_URL;

afterAll(async () => {
  if (!HAS_DB) return;
  const globalForDb = globalThis as { _sql?: { end(): Promise<void> } };
  const client = globalForDb._sql;
  globalForDb._sql = undefined;
  await client?.end();
});

interface Row {
  id: string;
  round_no: number;
  seq_in_round: number;
  home_entrant_id: string | null;
  away_entrant_id: string | null;
  outcome: { kind?: string } | null;
}

describe.runIf(HAS_DB)("W3 T3 the Swiss history reaches the engine in round order", () => {
  it("rows touched out of order: the colours handed to pairRound are each player's games in round order", async () => {
    const { auth } = await seedOrg("pro");
    const comp = await createCompetition(auth, {
      ends_on: "2030-12-31",
      name: "Swiss order " + randomUUID().slice(0, 6),
      visibility: "private",
      branding: {},
    });
    const division = await createDivision(auth, comp.id, {
      name: "Open",
      slug: "open-" + randomUUID().slice(0, 6),
      sport_key: "boardgame",
      variant_key: "classical",
      config: {},
    });
    await createEntrants(
      auth,
      division.id,
      Array.from({ length: 4 }, (_, i) => ({ kind: "individual" as const, display_name: `S${i + 1}`, seed: i + 1, members: [] })),
    );
    const [stage] = await createStages(auth, division.id, {
      seq: 1,
      kind: "swiss",
      name: "Swiss",
      config: { rounds: 3, chess: true },
      progression: null,
    });
    const stageId = stage!.id;
    await startDivision(auth, division.id); // mints the shells
    const boards = (round: number) =>
      sql<Row[]>`
        select id, round_no, seq_in_round, home_entrant_id, away_entrant_id, outcome from fixtures
        where stage_id = ${stageId} and round_no = ${round} and home_entrant_id is not null and away_entrant_id is not null
        order by seq_in_round`;
    // Rounds 1 and 2, each paired and played to draws: every player holds two real colours.
    for (const round of [1, 2]) {
      await generateStageFixtures(auth, stageId); // Pair
      const seated = await boards(round);
      expect(seated.length, `rig: round ${round} seats two boards`).toBe(2);
      for (const b of seated) {
        await scoreEvent(auth, b.id, { expected_seq: 0, type: "core.start", payload: {} });
        await scoreEvent(auth, b.id, { expected_seq: 1, type: "boardgame.result", payload: { winner: null, method: "agreement" } });
      }
    }

    // The expected history: the rule, over the rows in round order.
    const ordered = await sql<Row[]>`
      select id, round_no, seq_in_round, home_entrant_id, away_entrant_id, outcome from fixtures
      where stage_id = ${stageId} order by round_no, seq_in_round`;
    const expected = new Map<string, Colour[]>();
    for (const f of ordered) {
      if (f.home_entrant_id === null || f.away_entrant_id === null) continue;
      if (f.outcome?.kind === "award" || f.outcome?.kind === "double_walkover") continue;
      expected.set(f.home_entrant_id, [...(expected.get(f.home_entrant_id) ?? []), "W"]);
      expected.set(f.away_entrant_id, [...(expected.get(f.away_entrant_id) ?? []), "B"]);
    }
    expect(expected.size, "anti-vacuity: four players hold a history").toBe(4);
    const turned = [...expected.values()].filter((c) => c.length === 2 && c[0] !== c[1]).length;
    expect(turned, "witness: a player whose two colours differ, so reversed order is visible").toBeGreaterThan(0);

    // Shuffle the physical order: a no-op UPDATE writes each round-1 row as a new tuple, after round 2's.
    await sql`update fixtures set status = status where stage_id = ${stageId} and round_no = 1`;
    const unordered = await sql.begin(async (tx) => {
      await tx`set local enable_indexscan = off`;
      await tx`set local enable_indexonlyscan = off`;
      await tx`set local enable_bitmapscan = off`;
      return tx<{ round_no: number }[]>`select round_no from fixtures where stage_id = ${stageId}`;
    });
    const rounds = unordered.map((r) => r.round_no);
    expect(
      rounds.some((r, i) => i > 0 && r < rounds[i - 1]!),
      `precondition: without an ORDER BY this plan reads the rows out of round order (${rounds.join(",")})`,
    ).toBe(true);

    const engine = await import("@seazn/engine/scheduling");
    const spy = vi.spyOn(engine, "pairRound");
    let seen: Map<string, Colour[]> | undefined;
    try {
      planner.indexPathsOff = true;
      await generateStageFixtures(auth, stageId); // Pair round 3
      expect(spy.mock.calls.length, "anti-vacuity: Pair called the engine once").toBe(1);
      seen = spy.mock.calls[0]![1].colours as Map<string, Colour[]> | undefined;
    } finally {
      planner.indexPathsOff = false;
      spy.mockRestore();
    }
    expect(seen, "the chess Swiss hands the engine a colour history").toBeDefined();
    expect(Object.fromEntries(seen!), "each player's colours, in round order").toEqual(Object.fromEntries(expected));
  }, 120_000);
});
