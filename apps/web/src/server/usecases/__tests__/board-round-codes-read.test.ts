// Schedule-board knockout round codes (2026-09-23, owner-approved design),
// driven through the REAL producer and the REAL board read.
//
// The board chip's code comes from `boardRoundCodes` (components/v2/board/
// round-codes.ts), which can only be as right as the columns the board's own
// fixture read carries. That read (`listDivisionFixturesForBoard`) was trimmed
// for the RSC payload budget and used to drop `lane`/`third_place`/
// `conditional` entirely — so a bronze match reached the board looking exactly
// like the final. Here a real generator writes a real bracket, the board reads
// it through its own projection, and every fixture's code is compared with the
// code the engine's `roundRole` gives the SAME fixture read through the FULL
// row (`listDivisionFixtures`, the bracket panel's read, which carries every
// round-role column plus `ext_key`). A column the board projection drops shows
// up here as a fixture whose two codes disagree.
//
// Real Postgres required; skipped without DATABASE_URL.
import { afterAll, describe, expect, it } from "vitest";
import { sql } from "@/lib/db";
import { msgFor } from "@/lib/messages-i18n";
import type { MessageKey } from "@/lib/messages";
import { laneRoundRank, roundRoleFor, roundRoleShort } from "@/lib/round-role-label";
import { feedLabels, type FeedRow } from "@/lib/schedule-board";
import { boardRoundCodes, withRoundCodeRefs } from "@/components/v2/board/round-codes";
import { cardTitle } from "@/components/v2/board/types";
import { createCompetition } from "../competitions";
import { createDivision } from "../divisions";
import { createEntrants } from "../entrants";
import { createStages, generateStageFixtures, listStages } from "../stages";
import { listDivisionFixtures, listDivisionFixturesForBoard } from "../fixtures";
import { GENERIC_CONFIG, seedOrg } from "./_seed";

const HAS_DB = !!process.env.DATABASE_URL;

afterAll(async () => {
  if (!HAS_DB) return;
  const globalForDb = globalThis as { _sql?: { end(): Promise<void> } };
  const client = globalForDb._sql;
  globalForDb._sql = undefined;
  await client?.end();
});

const en = (key: MessageKey, vars?: Record<string, string | number>) => msgFor("en", key, vars);

/** One division, `n` seeded entrants, one generated stage of `kind`. Pro:
 *  double elimination is Pro-gated (format-gates.ts). */
async function seedGeneratedStage(kind: "knockout" | "double_elim" | "league", n: number, config: Record<string, unknown>) {
  const { auth } = await seedOrg("pro");
  const comp = await createCompetition(auth, {
    ends_on: "2030-12-31",
    name: `Board Round Codes ${kind}`,
    visibility: "private",
    branding: {},
  });
  const division = await createDivision(auth, comp.id, {
    name: "Open",
    slug: "open",
    sport_key: "generic",
    variant_key: "score",
    config: GENERIC_CONFIG,
  });
  await createEntrants(
    auth,
    division.id,
    Array.from({ length: n }, (_, i) => ({
      kind: "individual" as const,
      display_name: `Entrant ${i + 1}`,
      seed: i + 1,
      members: [],
    })),
  );
  const [stage] = await createStages(auth, division.id, { seq: 1, kind, name: kind, config });
  await generateStageFixtures(auth, stage!.id);
  return { auth, divisionId: division.id };
}

/** What the board renders, and what the engine says the same fixtures ARE. */
async function readBoth(seed: Awaited<ReturnType<typeof seedGeneratedStage>>) {
  const { auth, divisionId } = seed;
  const [board, full, stages] = await Promise.all([
    listDivisionFixturesForBoard(auth, divisionId),
    listDivisionFixtures(auth, divisionId),
    listStages(auth, divisionId),
  ]);
  const codes = boardRoundCodes(board, stages, en);
  const kind = stages[0]!.kind;
  const laneRows = full.map((f) => ({ round_no: f.round_no, lane: f.lane ?? null }));
  // The expectation, from the FULL row through the engine — never a table
  // typed in here. ext_key is passed too: the full read has it, the board
  // does not, and the codes must still agree.
  const expected = new Map(
    full.map((f) => {
      const lane = f.lane ?? null;
      const role = roundRoleFor(
        laneRows,
        {
          round_no: f.round_no,
          lane,
          is_final: f.is_final === true,
          third_place: f.third_place === true,
          conditional: f.conditional === true,
        },
        kind,
        f.ext_key ?? null,
      );
      return [f.id, roundRoleShort(en, role, { lane, roundInLane: laneRoundRank(laneRows, lane, f.round_no).roundInLane })];
    }),
  );
  return { board, full, codes, expected };
}

/** Code -> how many fixtures carry it. */
const tally = (codes: (string | null)[]) =>
  codes.reduce<Record<string, number>>((acc, c) => ((acc[c ?? "none"] = (acc[c ?? "none"] ?? 0) + 1), acc), {});

describe.skipIf(!HAS_DB)("board round codes over a real generated bracket, read through the board's own projection", () => {
  it("knockout of 8 with a bronze match: QF ×4, SF ×2, F, 3rd — and every code matches the full-row engine role", async () => {
    const { board, codes, expected } = await readBoth(await seedGeneratedStage("knockout", 8, { thirdPlace: true }));
    const got = board.map((f) => codes.get(f.id)?.code ?? null);
    expect(tally(got)).toEqual({ QF: 4, SF: 2, F: 1, "3rd": 1 });
    for (const f of board) expect(codes.get(f.id)?.code ?? null, f.id).toBe(expected.get(f.id));
    // The bronze row really carries the flag across the board read, and the
    // final really does not — the two rows share round_no.
    const bronze = board.find((f) => codes.get(f.id)?.code === "3rd")!;
    const final = board.find((f) => codes.get(f.id)?.code === "F")!;
    expect(bronze.third_place).toBe(true);
    expect(bronze.round_no).toBe(final.round_no);
    expect(Object.prototype.hasOwnProperty.call(final, "third_place")).toBe(false);
    // `is_final` — the V368 presence test — arrives on the final and ONLY there.
    expect(board.filter((f) => f.is_final === true).map((f) => f.id)).toEqual([final.id]);
  });

  it("knockout of 16: the opening round is R16", async () => {
    const { board, codes, expected } = await readBoth(await seedGeneratedStage("knockout", 16, {}));
    const got = board.map((f) => codes.get(f.id)?.code ?? null);
    expect(tally(got)).toEqual({ R16: 8, QF: 4, SF: 2, F: 1 });
    for (const f of board) expect(codes.get(f.id)?.code ?? null, f.id).toBe(expected.get(f.id));
  });

  it("double elimination of 8 with a reset: WB/LB lanes numbered, GF and GF2 — lane and conditional arrive", async () => {
    const { board, codes, expected } = await readBoth(await seedGeneratedStage("double_elim", 8, { bracketReset: true }));
    const got = board.map((f) => codes.get(f.id)?.code ?? null);
    expect(new Set(got)).toEqual(new Set(["WB1", "WB2", "WB3", "LB1", "LB2", "LB3", "LB4", "GF", "GF2"]));
    expect(got.filter((c) => c === "GF")).toHaveLength(1);
    expect(got.filter((c) => c === "GF2")).toHaveLength(1);
    for (const f of board) expect(codes.get(f.id)?.code ?? null, f.id).toBe(expected.get(f.id));
    expect(board.every((f) => f.lane === "WB" || f.lane === "LB" || f.lane === "GF")).toBe(true);
    // Review M1: a winners'-bracket round is named as one — never borrowing the
    // single-elimination "Quarter-finals"/"Semi-finals" the engine role carries.
    const wbLabels = new Set(board.filter((f) => f.lane === "WB").map((f) => codes.get(f.id)!.label));
    expect(wbLabels).toEqual(
      new Set([
        en("bracket.round.winnersRound", { n: 1 }),
        en("bracket.round.winnersRound", { n: 2 }),
        en("bracket.round.winnersFinal"),
      ]),
    );
  });

  it("a league keeps R{n}: no codes, and its rows ship none of the four round-role keys", async () => {
    const { board, codes, expected } = await readBoth(await seedGeneratedStage("league", 4, {}));
    expect(codes.size).toBe(0);
    expect([...expected.values()].every((c) => c === null)).toBe(true);
    for (const f of board) {
      for (const col of ["lane", "is_final", "third_place", "conditional"]) {
        expect(Object.prototype.hasOwnProperty.call(f, col), `${f.id} ${col}`).toBe(false);
      }
    }
  });

  it("placeholders over the generator's REAL feed edges: a semi reads 'Winner of QF·n', the final 'Winner of SF·n'", async () => {
    const { auth, divisionId } = await seedGeneratedStage("knockout", 8, { thirdPlace: true });
    const [board, stages] = await Promise.all([
      listDivisionFixturesForBoard(auth, divisionId),
      listStages(auth, divisionId),
    ]);
    // The division schedule page's own feed read (d/[divSlug]/schedule/page.tsx).
    const feedRows = await sql<FeedRow[]>`
      select id, stage_id, round_no, seq_in_round, winner_to_fixture, winner_to_slot,
             loser_to_fixture, loser_to_slot
      from fixtures where division_id = ${divisionId}`;
    const codes = boardRoundCodes(board, stages, en);
    const feeds = withRoundCodeRefs(board, feedLabels(feedRows), codes);
    const titleOf = (code: string) =>
      board.filter((f) => codes.get(f.id)?.code === code).map((f) => cardTitle(f, {}, feeds, en));
    for (const t of titleOf("SF")) expect(t).toMatch(/^Winner of QF·[1-4] vs Winner of QF·[1-4]$/);
    expect(titleOf("F")).toEqual([expect.stringMatching(/^Winner of SF·[12] vs Winner of SF·[12]$/)]);
    expect(titleOf("3rd")).toEqual([expect.stringMatching(/^Loser of SF·[12] vs Loser of SF·[12]$/)]);
  });

  // Review M2 (2026-09-23). V368 added lane / is_final / third_place /
  // conditional with NO backfill, so a stage generated before 2026-08-17 reads
  // back with every row at the column defaults. Reproduced here exactly that
  // way — generate, then put the four columns back to their defaults — rather
  // than with a hand-built fixture list, so the legacy shape is the one the
  // board read really returns for it.
  async function toPreV368(divisionId: string) {
    await sql`
      update fixtures set lane = null, is_final = false, third_place = false, conditional = false
      where division_id = ${divisionId}`;
  }

  it("a PRE-V368 knockout with a bronze match keeps R{n} on every card — never a second F", async () => {
    const seed = await seedGeneratedStage("knockout", 8, { thirdPlace: true });
    await toPreV368(seed.divisionId);
    const { board, codes, expected } = await readBoth(seed);
    // The legacy shape arrived: none of the four keys on any row.
    for (const f of board) {
      for (const col of ["lane", "is_final", "third_place", "conditional"]) {
        expect(Object.prototype.hasOwnProperty.call(f, col), `${f.id} ${col}`).toBe(false);
      }
    }
    // The wrong answer the fallback exists to refuse: the engine, fed these
    // rows, names BOTH round-3 matches the final.
    expect([...expected.values()].filter((c) => c === "F")).toHaveLength(2);
    expect(codes.size).toBe(0);
  });

  it("a PRE-V368 double elimination keeps R{n} — its three lanes are never read as one R512…F bracket", async () => {
    const seed = await seedGeneratedStage("double_elim", 8, { bracketReset: true });
    await toPreV368(seed.divisionId);
    const { board, codes, expected } = await readBoth(seed);
    expect(board.length).toBeGreaterThan(0);
    // What a lane-blind read would print: every round named, none of them a WB/LB/GF code.
    expect([...expected.values()].some((c) => c !== null && /^R\d+$/.test(c))).toBe(true);
    expect(codes.size).toBe(0);
  });

  it("a PRE-V368 knockout's placeholders keep their plain refs over the REAL feed edges: 'Winner of R1·n'", async () => {
    const { auth, divisionId } = await seedGeneratedStage("knockout", 8, {});
    await toPreV368(divisionId);
    const [board, stages] = await Promise.all([
      listDivisionFixturesForBoard(auth, divisionId),
      listStages(auth, divisionId),
    ]);
    const feedRows = await sql<FeedRow[]>`
      select id, stage_id, round_no, seq_in_round, winner_to_fixture, winner_to_slot,
             loser_to_fixture, loser_to_slot
      from fixtures where division_id = ${divisionId}`;
    const codes = boardRoundCodes(board, stages, en);
    const feeds = withRoundCodeRefs(board, feedLabels(feedRows), codes);
    const round2 = board.filter((f) => f.round_no === Math.min(...board.map((x) => x.round_no)) + 1);
    expect(round2.length).toBe(2);
    for (const f of round2) {
      expect(cardTitle(f, {}, feeds, en)).toMatch(/^Winner of R1·[1-4] vs Winner of R1·[1-4]$/);
    }
  });
});
