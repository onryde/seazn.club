// W3 app-B T3 fix round 2 (review m1-export): the organiser's standings export prints a SWISS stage's ladders (Sonneborn-Berger,
// Buchholz) in the table's own points spelling, as the public table does - and a round-robin's keep the engine's text.
//
// Why a DB test: `exports.ts` hands `tableLayoutFor(rules, snapshot.stage_kind)` the stage's kind from the snapshot query. That
// one argument is the whole seam - drop it and a Swiss export prints "1.5" beside the public table's "1½" - and no pure test can
// see it (the review removed it and 90 export tests stayed green). So this drives the REAL producers (Start, Pair, the scorer's
// events, the generator) and the REAL consumers: `buildDivisionDocModel` (the export) and `loadCompetitionHub` (the public
// table), on Postgres, skipped without DATABASE_URL.
//
// Expected numbers are the RULEBOOK's, computed here from the results this file itself plays (FIDE 1 / 1/2 / 0): a player's
// score is the sum of her results; her Sonneborn-Berger is the sum over her opponents of (her result x that opponent's score)
// (C.07 art. 9.1); her Buchholz the sum of her opponents' scores (art. 8.1). Never read from the code under test. The spelling
// a visitor reads: a whole as "n", a half as "n 1/2" (the glyph), anything else as a trimmed decimal.
import { afterAll, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";

// `unstable_cache` is a Next server-runtime API with no incrementalCache outside a request: a passthrough, so every public read
// is a fresh one.
vi.mock("next/cache", () => ({
  unstable_cache: (fn: (...args: unknown[]) => unknown) => fn,
  revalidateTag: vi.fn(),
  revalidatePath: vi.fn(),
}));

import { sql } from "@/lib/db";
import type { AuthCtx } from "@/server/api-v1/auth";
import { loadCompetitionHub } from "@/server/public-site/competition-hub";
import { createCompetition } from "@/server/usecases/competitions";
import { createDivision } from "@/server/usecases/divisions";
import { createEntrants } from "@/server/usecases/entrants";
import { buildDivisionDocModel } from "@/server/usecases/exports";
import { startDivision } from "@/server/usecases/schedule";
import { scoreEvent } from "@/server/usecases/scoring";
import { createStages, generateStageFixtures } from "@/server/usecases/stages";
import { seedOrg } from "@/server/usecases/__tests__/_seed";

const HAS_DB = !!process.env.DATABASE_URL;

afterAll(async () => {
  if (!HAS_DB) return;
  const g = globalThis as { _sql?: { end(): Promise<void> } };
  const client = g._sql;
  g._sql = undefined;
  await client?.end();
});

// ── The rulebook's arithmetic, over the results this file plays ───────────────────────────────────────────────────────

/** A played game: `home` beat / drew / lost to `away` (by seat), as the scorer was told. */
interface Game {
  home: string;
  away: string;
  result: "home" | "away" | "draw";
}
const pointsIn = (g: Game, who: string): number => (g.result === "draw" ? 0.5 : (g.result === "home") === (g.home === who) ? 1 : 0);
const opponentIn = (g: Game, who: string): string => (g.home === who ? g.away : g.home);

function ladders(games: readonly Game[], players: readonly string[]): Record<string, { score: number; sb: number; bh: number }> {
  const score = (p: string) => games.filter((g) => g.home === p || g.away === p).reduce((n, g) => n + pointsIn(g, p), 0);
  return Object.fromEntries(
    players.map((p) => {
      const mine = games.filter((g) => g.home === p || g.away === p);
      return [
        p,
        {
          score: score(p),
          sb: mine.reduce((n, g) => n + pointsIn(g, p) * score(opponentIn(g, p)), 0),
          bh: mine.reduce((n, g) => n + score(opponentIn(g, p)), 0),
        },
      ];
    }),
  );
}

/** The Swiss table's spelling of a number of game points: "3", "1½", "½" - and a trimmed decimal when it is not a half. */
function halves(n: number): string {
  if (Number.isInteger(n)) return String(n);
  if (n * 2 === Math.trunc(n * 2)) return n < 1 ? "½" : `${Math.trunc(n)}½`;
  return plain(n);
}
/** The engine's own spelling of a Sonneborn-Berger off a Swiss table: a decimal to two places, trailing zeros trimmed. */
function plain(n: number): string {
  return n.toFixed(2).replace(/\.?0+$/, "") || "0";
}
const isHalf = (n: number) => !Number.isInteger(n) && n * 2 === Math.trunc(n * 2);

// ── The rig ───────────────────────────────────────────────────────────────────────────────────────────────────────────

const tip = async (id: string) =>
  (await sql<{ s: number }[]>`select coalesce(max(seq), 0)::int as s from score_events where fixture_id = ${id}`)[0]!.s;
const post = async (auth: AuthCtx, id: string, type: string, payload: unknown = {}) =>
  scoreEvent(auth, id, { expected_seq: await tip(id), type, payload } as never);

interface Board {
  id: string;
  ext_key: string | null;
  round_no: number;
  home_entrant_id: string | null;
  away_entrant_id: string | null;
}
const boardsOf = (stageId: string) =>
  sql<Board[]>`
    select id, ext_key, round_no, home_entrant_id, away_entrant_id
    from fixtures where stage_id = ${stageId} and home_entrant_id is not null and away_entrant_id is not null
    order by round_no, seq_in_round`;

/** Plays `board` through the chess scorer's own events and returns the game as played. */
async function play(auth: AuthCtx, board: Board, result: Game["result"]): Promise<Game> {
  await post(auth, board.id, "core.start");
  await post(auth, board.id, "boardgame.result", {
    winner: result === "draw" ? null : result === "home" ? board.home_entrant_id : board.away_entrant_id,
    method: result === "draw" ? "agreement" : "resign",
  });
  return { home: board.home_entrant_id!, away: board.away_entrant_id!, result };
}

interface Rig {
  auth: AuthCtx;
  divisionId: string;
  stageId: string;
  orgSlug: string;
  compSlug: string;
  divSlug: string;
  /** entrant id by name, and back */
  id: Record<string, string>;
  name: (id: string) => string;
}

/** A public chess division of `names` (seed order) with one stage of `kind`, started. */
async function chessRig(kind: "swiss" | "league", names: string[]): Promise<Rig> {
  const { auth } = await seedOrg("pro");
  const comp = await createCompetition(auth, { ends_on: "2030-12-31", name: "Ladders " + randomUUID().slice(0, 6), visibility: "public", branding: {} });
  const division = await createDivision(auth, comp.id, {
    name: "Open",
    slug: "open-" + randomUUID().slice(0, 6),
    sport_key: "boardgame",
    variant_key: "classical",
    config: {},
  });
  const made = await createEntrants(
    auth,
    division.id,
    names.map((n, i) => ({ kind: "individual" as const, display_name: n, seed: i + 1, members: [] })),
  );
  const [stage] = await createStages(
    auth,
    division.id,
    kind === "swiss"
      ? { seq: 1, kind: "swiss", name: "Swiss", config: { rounds: 2 }, progression: null }
      : { seq: 1, kind: "league", name: "League", config: {}, progression: null },
  );
  await startDivision(auth, division.id);
  const [slugs] = await sql<{ org_slug: string; comp_slug: string; div_slug: string }[]>`
    select o.slug as org_slug, c.slug as comp_slug, d.slug as div_slug
    from divisions d join competitions c on c.id = d.competition_id join organizations o on o.id = d.org_id
    where d.id = ${division.id}`;
  const byId = new Map(made.map((e) => [e.id, e.display_name]));
  return {
    auth,
    divisionId: division.id,
    stageId: stage!.id,
    orgSlug: slugs!.org_slug,
    compSlug: slugs!.comp_slug,
    divSlug: slugs!.div_slug,
    id: Object.fromEntries(made.map((e) => [e.display_name, e.id])),
    name: (i) => byId.get(i) ?? i,
  };
}

// ── The two consumers ─────────────────────────────────────────────────────────────────────────────────────────────────

interface Read {
  /** the column's letters over it, as the public table and the export both print them */
  abbr: string;
  /** entrant name -> the cell's text */
  cells: Map<string, string>;
}

/** The public table's `key` column: what the competition page prints (the hub's real loader). */
async function publicColumn(rig: Rig, key: string): Promise<Read> {
  const hub = await loadCompetitionHub(rig.orgSlug, rig.compSlug, new Date(), { uncached: true });
  expect(hub, "premise: the competition is public").not.toBeNull();
  const tables = hub!.tables.filter((t) => t.divisionSlug === rig.divSlug);
  expect(tables.length, "premise: the hub publishes the stage's one table").toBe(1);
  const t = tables[0]!;
  const at = t.columns.findIndex((c) => c.key === key);
  expect(at, `premise: the public table has a ${key} column`).toBeGreaterThanOrEqual(0);
  return { abbr: t.columns[at]!.abbr, cells: new Map(t.rows.map((r) => [r.name, r.cells[at]!])) };
}

/** The same column in the organiser's standings export (the real `buildDivisionDocModel`), found by the public table's own letters. */
async function exportedColumn(rig: Rig, abbr: string): Promise<Map<string, string>> {
  const doc = await buildDivisionDocModel(rig.auth, rig.divisionId, "standings", { printedAt: "2026-11-03T09:00:00.000Z" });
  expect(doc.sections, "premise: one stage, one table").toHaveLength(1);
  const table = doc.sections[0]!.table;
  expect(table, "premise: the standings section is a table").toBeDefined();
  const matches = table!.columns.filter((c) => c === abbr);
  expect(matches, `premise: the export has exactly one ${abbr} column`).toHaveLength(1);
  const at = table!.columns.indexOf(abbr);
  return new Map(table!.rows.map((r) => [String(r[1]), String(r[at])]));
}

describe.runIf(HAS_DB)("standings export - the ladders' spelling follows the stage kind, as the public table's does", () => {
  it("a Swiss export prints a half-point Sonneborn-Berger and Buchholz as the public table does ('1½', not '1.5')", async () => {
    const rig = await chessRig("swiss", ["P1", "P2", "P3", "P4"]);
    const games: Game[] = [];
    // Round 1: the first board is drawn, the second is won by its home seat. Round 2: the first board is won by its home seat,
    // the second is drawn. (The pairing is the Swiss's own; the arithmetic below follows whoever it seated.)
    await generateStageFixtures(rig.auth, rig.stageId);
    const r1 = (await boardsOf(rig.stageId)).filter((b) => b.round_no === 1);
    expect(r1, "premise: round 1 paired two boards").toHaveLength(2);
    games.push(await play(rig.auth, r1[0]!, "draw"), await play(rig.auth, r1[1]!, "home"));
    await generateStageFixtures(rig.auth, rig.stageId);
    const r2 = (await boardsOf(rig.stageId)).filter((b) => b.round_no === 2);
    expect(r2, "premise: round 2 paired two boards").toHaveLength(2);
    games.push(await play(rig.auth, r2[0]!, "home"), await play(rig.auth, r2[1]!, "draw"));

    const want = ladders(
      games.map((g) => ({ ...g, home: rig.name(g.home), away: rig.name(g.away) })),
      ["P1", "P2", "P3", "P4"],
    );
    expect(
      Object.values(want).filter((w) => isHalf(w.sb)).length,
      "premise: at least one Sonneborn-Berger is a half-point number, so the two spellings differ somewhere",
    ).toBeGreaterThan(0);

    const pubSb = await publicColumn(rig, "sberger");
    const pubBh = await publicColumn(rig, "buchholz");
    const expSb = await exportedColumn(rig, pubSb.abbr);
    const expBh = await exportedColumn(rig, pubBh.abbr);
    let checked = 0;
    let halvesSeen = 0;
    for (const [name, w] of Object.entries(want)) {
      expect(pubSb.cells.get(name), `${name}: the public table's Sonneborn-Berger (the rulebook's ${w.sb})`).toBe(halves(w.sb));
      expect(expSb.get(name), `${name}: the export's Sonneborn-Berger is the public table's cell`).toBe(pubSb.cells.get(name));
      expect(expBh.get(name), `${name}: the export's Buchholz is the public table's cell (the rulebook's ${w.bh})`).toBe(pubBh.cells.get(name));
      expect(expBh.get(name), `${name}: and the rulebook's number`).toBe(halves(w.bh));
      if (isHalf(w.sb)) {
        halvesSeen++;
        expect(expSb.get(name), `${name}: never the decimal spelling of a half`).not.toBe(plain(w.sb));
      }
      checked++;
    }
    expect(checked, "rows held to the rulebook").toBe(4);
    expect(halvesSeen, "half-point Sonneborn-Berger cells checked").toBeGreaterThan(0);
  }, 180_000);

  it("control: a round-robin export keeps the engine's text for the same measure ('1.5'), and the public table agrees with it", async () => {
    const rig = await chessRig("league", ["P1", "P2", "P3", "P4"]);
    await generateStageFixtures(rig.auth, rig.stageId);
    const boards = await boardsOf(rig.stageId);
    expect(boards, "premise: a 4-player round robin has 6 games").toHaveLength(6);
    // A fixed script of results by pairing of players: the lower seed number wins, except two draws. By the rulebook's arithmetic
    // that leaves scores 2 1/2, 2, 1/2, 1 and Sonneborn-Berger 3, 1 1/2, 1/2, 1 1/2 (P1..P4): three half-point values, no quarters.
    const draws = new Set(["P1-P4", "P3-P4"]);
    const games: Game[] = [];
    for (const b of boards) {
      const pair = [rig.name(b.home_entrant_id!), rig.name(b.away_entrant_id!)].sort().join("-");
      const lower = [rig.name(b.home_entrant_id!), rig.name(b.away_entrant_id!)].sort()[0]!;
      games.push(await play(rig.auth, b, draws.has(pair) ? "draw" : rig.name(b.home_entrant_id!) === lower ? "home" : "away"));
    }
    const want = ladders(
      games.map((g) => ({ ...g, home: rig.name(g.home), away: rig.name(g.away) })),
      ["P1", "P2", "P3", "P4"],
    );
    expect(
      Object.values(want).filter((w) => isHalf(w.sb)).length,
      "premise: at least one Sonneborn-Berger is a half-point number, so the Swiss spelling would differ here",
    ).toBeGreaterThan(0);

    const pubSb = await publicColumn(rig, "sberger");
    const expSb = await exportedColumn(rig, pubSb.abbr);
    let checked = 0;
    let halvesSeen = 0;
    for (const [name, w] of Object.entries(want)) {
      expect(pubSb.cells.get(name), `${name}: the public table prints the engine's text for the rulebook's ${w.sb}`).toBe(plain(w.sb));
      expect(expSb.get(name), `${name}: the export is the public table's cell`).toBe(pubSb.cells.get(name));
      if (isHalf(w.sb)) {
        halvesSeen++;
        expect(expSb.get(name), `${name}: a round-robin is not re-spelled as halves`).not.toBe(halves(w.sb));
      }
      checked++;
    }
    expect(checked, "rows held to the rulebook").toBe(4);
    expect(halvesSeen, "half-point Sonneborn-Berger cells checked").toBeGreaterThan(0);
  }, 180_000);
});
