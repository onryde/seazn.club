// W3 app-B Task 8 (X-SW-7, X-SW-8; FIDE C.07 (2026) art. 16; AGENTS.md class 1, the inert seam) — the two inputs the app owes
// the engine's Swiss ledger, proved through their REAL producers and their REAL consumers on Postgres:
//   - `TableFixture.unplayed` (X-SW-7): a forfeit with nothing played and a double walkover are rounds nobody played;
//   - `TableStage.swissAbsentRounds` (X-SW-8): the Swiss rounds an entrant was in the stage but unpaired - before a late
//     entry (`admitSwissLateEntrant`, through the organiser's Add), after a withdrawal (`withdrawEntrantCascade`).
//
// Every state is built by the product's own writers (Start, Pair, the scorer's events, Forfeit, Add, Withdraw, Void) and
// read back by the consumers a person reads: `rankedStageStandings` (the desk's table, the ranker `swissGen` pairs by) and the
// competition hub's table (`loadCompetitionHub` -> `buildTableView`, the public page). The two must agree with each other
// and with the RULEBOOK.
//
// Expected values are hand-derived below from rulebook-W3-swiss.md §4 / FIDE C.07 (2026) art. 16 for the scenario's declared
// rule, never read from the engine: D = the sport's draw points (its rule's `draw`, else half its win), R = the stage's
// rounds, cap = D x R (16.4.2), an opponent read at its ADJUSTED score (16.3), and a Buchholz card is the opponent's
// adjusted score, or - for the entrant's own unplayed round (a bye, an absence) - a dummy at min(own score, cap) (16.4.2),
// or - for a forfeit - min(own score, the scheduled opponent's adjusted score) (16.4.1). Cut-1 cuts the lowest VUR first
// (16.5.1).
//
// Scenario names are the engine plan's (S2 forfeit, S3 withdrawal, S4 late entry). The players are P1..P4 in seed order and
// the pairing the Swiss itself makes; the rig asserts each pairing it relies on, so a pairing change reds the RIG, not a
// value. Boardgame (half-points) is the sport the plan's numbers are in; badminton (whole points, no draw) and football
// (win 3, draw 1) re-derive the same shapes under their own declared rules.
import { afterAll, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";


// `unstable_cache` is a Next server-runtime API with no incrementalCache outside a request: a passthrough, never a memoising
// double (the hub is read after every state change).
vi.mock("next/cache", () => ({
  unstable_cache: (fn: (...args: unknown[]) => unknown) => fn,
  revalidateTag: vi.fn(),
}));

import { sql, withTenant } from "@/lib/db";
import type { StandingsRow } from "@seazn/engine/competition";
import { builtinModules } from "@seazn/engine/sports";
import { forEachSportAsync } from "@seazn/engine/testkit";
import type { AnySportModule } from "@seazn/engine/sport";
import type { AuthCtx } from "@/server/api-v1/auth";
import { rankedStageStandings } from "@/server/engine-db/competition";
import { loadCompetitionHub } from "@/server/public-site/competition-hub";
import { createCompetition } from "@/server/usecases/competitions";
import { createDivision } from "@/server/usecases/divisions";
import { createEntrants } from "@/server/usecases/entrants";
import { startDivision } from "@/server/usecases/schedule";
import { scoreEvent } from "@/server/usecases/scoring";
import { createStages, generateStageFixtures } from "@/server/usecases/stages";
import { withdrawEntrantCascade } from "@/server/usecases/withdrawal";
import { seedOrg } from "@/server/usecases/__tests__/_seed";
import { seedLegacySwissAdhoc } from "@/server/usecases/__tests__/_swiss-legacy-adhoc";

const HAS_DB = !!process.env.DATABASE_URL;

afterAll(async () => {
  if (!HAS_DB) return;
  const g = globalThis as { _sql?: { end(): Promise<void> } };
  const client = g._sql;
  g._sql = undefined;
  await client?.end();
});

// ── The sports ────────────────────────────────────────────────────────────────────────────────────────────────────────

interface Board {
  id: string;
  ext_key: string | null;
  round_no: number;
  home_entrant_id: string | null;
  away_entrant_id: string | null;
  status: string;
  outcome: { kind?: string; winner?: string; loser?: string | null; reason?: string } | null;
}

interface SportCase {
  sport: string;
  variant: string;
  /** Plays `board` through the scorer's own events so that `winner` (one of its seats) wins. */
  win(auth: AuthCtx, board: Board, winner: string): Promise<void>;
  /** Plays `board` to a draw; undefined = the sport cannot draw. */
  draw?(auth: AuthCtx, board: Board): Promise<void>;
}

const tip = async (id: string) =>
  (await sql<{ s: number }[]>`select coalesce(max(seq), 0)::int as s from score_events where fixture_id = ${id}`)[0]!.s;
/** Append at the fixture's own tip - the console's write. */
const post = async (auth: AuthCtx, id: string, type: string, payload: unknown = {}) =>
  scoreEvent(auth, id, { expected_seq: await tip(id), type, payload } as never);

const BOARDGAME: SportCase = {
  sport: "boardgame",
  variant: "classical",
  async win(auth, b, winner) {
    await post(auth, b.id, "core.start");
    await post(auth, b.id, "boardgame.result", { winner, method: "resign" });
  },
  async draw(auth, b) {
    await post(auth, b.id, "core.start");
    await post(auth, b.id, "boardgame.result", { winner: null, method: "agreement" });
  },
};

const BADMINTON: SportCase = {
  sport: "badminton",
  variant: "bwf",
  async win(auth, b, winner) {
    const home = b.home_entrant_id === winner;
    await post(auth, b.id, "core.start");
    for (let g = 0; g < 2; g++) await post(auth, b.id, "badminton.game.summary", home ? { home: 21, away: 10 } : { home: 10, away: 21 });
  },
};

const FOOTBALL: SportCase = {
  sport: "football",
  variant: "11-a-side",
  async win(auth, b, winner) {
    await post(auth, b.id, "core.start");
    await post(auth, b.id, "football.goal", { by: winner });
    await post(auth, b.id, "football.period", { phase: "HT" });
    await post(auth, b.id, "football.period", { phase: "FT" });
  },
  async draw(auth, b) {
    await post(auth, b.id, "core.start");
    await post(auth, b.id, "football.period", { phase: "HT" });
    await post(auth, b.id, "football.period", { phase: "FT" });
  },
};

const moduleOf = (key: string): AnySportModule => {
  const m = builtinModules.find((x) => x.key === key);
  if (m === undefined) throw new Error(`no sport ${key}`);
  return m as AnySportModule;
};

/** The sport's declared table points - the rulebook's inputs (W = the win, D = the draw points of a Swiss stage: the rule's
 *  `draw` where a draw can stand, else half the win; the Standard-Points midpoint). Read from the module's own declaration of
 *  the variant, never typed beside the numbers they scale. */
function declared(sc: SportCase): { W: number; D: number } {
  const m = moduleOf(sc.sport);
  const cfg = m.configSchema.parse(m.variants[sc.variant]);
  const rule = m.tablePointsRule(cfg, "swiss");
  const win = rule.bySetScore === undefined ? rule.win.regulation : rule.bySetScore["*"]![0];
  return { W: win, D: m.supportsDraws(cfg, "swiss") && rule.draw !== undefined ? rule.draw : win / 2 };
}

/** 2 where the sport's table points are halves (boardgame: 2/1/0 is FIDE's 1/½/0), else 1 - the divisor to display units. */
function unitScale(sc: SportCase): number {
  const m = moduleOf(sc.sport);
  return m.tablePointsRule(m.configSchema.parse(m.variants[sc.variant]), "swiss").unit === "half" ? 2 : 1;
}

// ── The rig ───────────────────────────────────────────────────────────────────────────────────────────────────────────

interface Rig {
  sc: SportCase;
  auth: AuthCtx;
  divisionId: string;
  stageId: string;
  orgSlug: string;
  compSlug: string;
  divSlug: string;
  rounds: number;
  /** Entrant ids by display name. */
  id: Record<string, string>;
  /** The reverse. */
  name: (id: string | null) => string;
}

/** A public Swiss of `rounds` over `names` (seeds 1..n, in order), started - the shells minted, scoring open. */
async function swissRig(sc: SportCase, names: string[], rounds: number): Promise<Rig> {
  const { auth } = await seedOrg("pro");
  const comp = await createCompetition(auth, { ends_on: "2030-12-31", name: "Art16 " + randomUUID().slice(0, 6), visibility: "public", branding: {} });
  const division = await createDivision(auth, comp.id, {
    name: "Open",
    slug: "open-" + randomUUID().slice(0, 6),
    sport_key: sc.sport,
    variant_key: sc.variant,
    config: {},
  });
  const kind = (moduleOf(sc.sport).entrantModel?.defaultKind ?? "individual") as "individual" | "pair" | "team";
  const made = await createEntrants(
    auth,
    division.id,
    names.map((n, i) => ({ kind, display_name: n, seed: i + 1, members: [] })),
  );
  const [stage] = await createStages(auth, division.id, { seq: 1, kind: "swiss", name: "Swiss", config: { rounds }, progression: null });
  await startDivision(auth, division.id);
  const [slugs] = await sql<{ org_slug: string; comp_slug: string; div_slug: string }[]>`
    select o.slug as org_slug, c.slug as comp_slug, d.slug as div_slug
    from divisions d join competitions c on c.id = d.competition_id join organizations o on o.id = d.org_id
    where d.id = ${division.id}`;
  const id: Record<string, string> = Object.fromEntries(made.map((e) => [e.display_name, e.id]));
  const byId = new Map(made.map((e) => [e.id, e.display_name]));
  return {
    sc,
    auth,
    divisionId: division.id,
    stageId: stage!.id,
    orgSlug: slugs!.org_slug,
    compSlug: slugs!.comp_slug,
    divSlug: slugs!.div_slug,
    rounds,
    id,
    name: (i) => (i === null ? "-" : (byId.get(i) ?? i)),
  };
}

const boardsOf = (stageId: string) =>
  sql<Board[]>`
    select id, ext_key, round_no, home_entrant_id, away_entrant_id, status, outcome
    from fixtures where stage_id = ${stageId} order by round_no, seq_in_round`;
const roundOf = (rows: Board[], r: number) => rows.filter((f) => f.round_no === r && !(f.ext_key ?? "").endsWith("-bye"));
const pair = (rig: Rig) => generateStageFixtures(rig.auth, rig.stageId);

/** The two seats of the board between `a` and `b` in round `r`. */
function boardBetween(rows: Board[], r: number, a: string, b: string): Board {
  const f = roundOf(rows, r).find((x) => [x.home_entrant_id, x.away_entrant_id].sort().join() === [a, b].sort().join());
  if (f === undefined) throw new Error(`rig: no round ${r} board between ${a} and ${b}`);
  return f;
}

/** Round `r`'s pairing as sorted "X-Y" name pairs, plus the bye holder - asserted by every scenario that relies on it. */
function shapeOf(rig: Rig, rows: Board[], r: number): string[] {
  return rows
    .filter((f) => f.round_no === r && (f.home_entrant_id !== null || f.away_entrant_id !== null))
    .map((f) =>
      (f.ext_key ?? "").endsWith("-bye")
        ? `${rig.name(f.home_entrant_id)} bye`
        : [rig.name(f.home_entrant_id), rig.name(f.away_entrant_id)].sort().join("-"),
    )
    .sort();
}

/** The organiser's Add of one unseeded player - the product path (`createEntrants` -> `admitSwissLateEntrant`). */
async function addLate(rig: Rig, name: string) {
  const kind = (moduleOf(rig.sc.sport).entrantModel?.defaultKind ?? "individual") as "individual" | "pair" | "team";
  const [row] = await createEntrants(rig.auth, rig.divisionId, [{ kind, display_name: name, members: [] }]);
  rig.id[name] = row!.id;
  const prior = rig.name;
  rig.name = (i) => (i === row!.id ? name : prior(i));
  return row!;
}

// ── The consumers ─────────────────────────────────────────────────────────────────────────────────────────────────────

/** The desk's table: the ranker `swissGen` pairs by, in the caller's transaction. */
async function deskRows(rig: Rig): Promise<Map<string, StandingsRow>> {
  const rows = await withTenant(rig.auth.orgId, (tx) => rankedStageStandings(tx, rig.stageId));
  return new Map(rows.map((r) => [rig.name(r.entrantId), r]));
}

/** The public table's cells, by entrant name and column key - what the competition page prints. */
async function publicCells(rig: Rig): Promise<Map<string, Record<string, string>>> {
  const hub = await loadCompetitionHub(rig.orgSlug, rig.compSlug, new Date(), { uncached: true });
  expect(hub, "premise: the competition is public").not.toBeNull();
  const tables = hub!.tables.filter((t) => t.divisionSlug === rig.divSlug);
  expect(tables.length, "premise: the hub publishes the Swiss table").toBe(1);
  const t = tables[0]!;
  return new Map(t.rows.map((r) => [r.name, Object.fromEntries(t.columns.map((c, i) => [c.key, r.cells[i]!]))]));
}


/** A table cell as the public page prints a number: whole as is, a half as "n½" (half-point tables print the fraction as a
 *  glyph), and a bare half as "½". */
function cellOf(n: number): string {
  if (Number.isInteger(n)) return String(n);
  if (n < 0.5 || n * 2 !== Math.trunc(n * 2)) throw new Error(`cellOf: ${n} is not a whole or a half`);
  return n < 1 ? "½" : `${Math.trunc(n)}½`;
}

/** What a scenario's hand derivation says one entrant's tie-break numbers are, in DISPLAY points (the table's unit). */
type Want = Record<string, { bh: number; cut1?: number }>;

/**
 * Reads the desk's table and the public table, and holds BOTH to the hand-derived `want`, entrant by entrant. Returns how many
 * entrants it checked: a scenario asserts it equals the table's size, so a check that ran over nothing (or over fewer rows than
 * the table has) is a failure, not a pass.
 */
async function expectTable(rig: Rig, want: Want, where: string): Promise<number> {
  const desk = await deskRows(rig);
  const pub = await publicCells(rig);
  let checked = 0;
  for (const [name, w] of Object.entries(want)) {
    const row = desk.get(name);
    expect(row, `${where}: ${name} is on the desk table`).toBeDefined();
    expect(row!.metrics.buchholz, `${where}: ${name}'s Buchholz on the desk`).toBe(w.bh);
    expect(pub.get(name)?.buchholz, `${where}: ${name}'s Buchholz on the public table`).toBe(cellOf(w.bh));
    if (w.cut1 !== undefined) {
      expect(row!.metrics.buchholz_cut1, `${where}: ${name}'s Buchholz Cut-1 on the desk`).toBe(w.cut1);
      expect(pub.get(name)?.buchholz_cut1, `${where}: ${name}'s Buchholz Cut-1 on the public table`).toBe(cellOf(w.cut1));
    }
    checked++;
  }
  expect(checked, `${where}: anti-vacuity - every table entrant was held to the rulebook`).toBe(desk.size);
  expect(checked).toBeGreaterThan(0);
  return checked;
}

/** Both consumers' points, in the table's display unit, by name. */
async function pointsOf(rig: Rig): Promise<Record<string, number>> {
  return Object.fromEntries([...(await deskRows(rig)).entries()].map(([n, r]) => [n, r.points]));
}

describe.runIf(HAS_DB)("W3 T8 — art. 16's two inputs from real data, through the real producers and consumers", () => {
  // ── Empty case first: the stage every standings read must rank, before any absence or forfeit exists ───────────────────

  /**
   * The engine refuses a Swiss stage that names no `swissDraw` or no `swissAbsentRounds` at once (CONFIG_INVALID, whether or not
   * a round is unplayed), so every standings read of every Swiss fails the moment either is left out. An EVEN field reaches no
   * dummy at all - a producer that fills the fields only when it needs them would pass there and fail on the first odd round,
   * so both are pinned.  Odd field (A=P1, B=P2, C=P3; R = 2, D = 1, cap 2): round 1 paired, nothing played: the bye is C's
   * only card, dummy min(C 2, 2) = 2 half -> 1; A and B have no card yet -> 0.  Then A beats B: B = A 2 -> 1; A = B 0 -> 0.
   * Even field (P1..P4, R = 2): paired, nothing played: all 0.  Then P1 beats P3 and P2 beats P4: P1 = P3 0, P2 = P4 0,
   * P3 = P1 2 -> 1, P4 = P2 2 -> 1.
   */
  it("X-SW-7 empty case first: a Swiss with no pairing ranks nobody and publishes no table (nothing to throw on)", async () => {
    const rig = await swissRig(BOARDGAME, ["P1", "P2", "P3"], 2);
    expect([...(await deskRows(rig)).keys()], "no seat anywhere: no table entrant").toEqual([]);
    const hub = await loadCompetitionHub(rig.orgSlug, rig.compSlug, new Date(), { uncached: true });
    expect(hub!.tables.filter((t) => t.divisionSlug === rig.divSlug).flatMap((t) => t.rows), "and the public page prints no row").toEqual([]);
  }, 120_000);

  it("X-SW-7 a Swiss stage with a bye ranks through the real producer (odd field)", async () => {
    const rig = await swissRig(BOARDGAME, ["P1", "P2", "P3"], 2);
    await pair(rig);
    let rows = await boardsOf(rig.stageId);
    expect(shapeOf(rig, rows, 1), "rig: round 1").toEqual(["P1-P2", "P3 bye"]);
    expect(await expectTable(rig, { P1: { bh: 0 }, P2: { bh: 0 }, P3: { bh: 1 } }, "odd field, nothing played")).toBe(3);
    await BOARDGAME.win(rig.auth, boardBetween(rows, 1, rig.id.P1!, rig.id.P2!), rig.id.P1!);
    rows = await boardsOf(rig.stageId);
    expect(await expectTable(rig, { P1: { bh: 0 }, P2: { bh: 1 }, P3: { bh: 1 } }, "odd field, A beats B")).toBe(3);
  }, 120_000);

  it("X-SW-7 a Swiss stage with no bye ranks through the real producer (even field)", async () => {
    const rig = await swissRig(BOARDGAME, ["P1", "P2", "P3", "P4"], 2);
    await pair(rig);
    const rows = await boardsOf(rig.stageId);
    expect(shapeOf(rig, rows, 1), "rig: round 1").toEqual(["P1-P3", "P2-P4"]);
    expect(await expectTable(rig, { P1: { bh: 0 }, P2: { bh: 0 }, P3: { bh: 0 }, P4: { bh: 0 } }, "even field, nothing played")).toBe(4);
    await BOARDGAME.win(rig.auth, boardBetween(rows, 1, rig.id.P1!, rig.id.P3!), rig.id.P1!);
    await BOARDGAME.win(rig.auth, boardBetween(rows, 1, rig.id.P2!, rig.id.P4!), rig.id.P2!);
    expect(await expectTable(rig, { P1: { bh: 0 }, P2: { bh: 0 }, P3: { bh: 1 }, P4: { bh: 1 } }, "even field, round 1 played")).toBe(4);
  }, 120_000);

  // ── X-SW-8: the late entrant's missed round ──────────────────────────────────────────────────────────────────────────

  /**
   * S4 (engine plan; late entry), R = 3, rule 2/1/0 in half-points -> D = 1, cap = D x R = 3. A = P1, B = P2, C = P3, L = the
   * latecomer (Add after round 1, case (c): the round between rounds takes the newcomer at the next Pair).
   *   R1: A beats B, C has the bye (L is absent).   R2: A beats C, L beats B.   R3: L beats A, B draws C.
   *   Scores (half-points): A 2+2+0 = 4, B 0+0+1 = 1, C 2+0+1 = 3, L 0+2+2 = 4.
   * L's round 1 is a missed round followed by play: 16.2.3 `absent`, scored 0 against its own dummy min(4, 3) = 3 (16.4.2), and
   * its opponents read L at its real 4 (16.3.1), not as a draw.
   *   Buchholz (half-points): L = 3 + B 1 + A 4 = 8 -> 4;  B = A 4 + L 4 + C 3 = 11 -> 5.5 (12 if L's round were read as 16.2.5);
   *   A = B 1 + C 3 + L 4 = 8 -> 4;  C = its bye min(3, 3) = 3 + A 4 + B 1 = 8 -> 4.
   * // differential: without the producer L's own card has no round-1 dummy: L = B 1 + A 4 = 5 -> 2.5.
   */
  it("X-SW-8 a late entrant's missed round is a VUR: Buchholz on the desk and the public table equals the rulebook's (boardgame, S4)", async () => {
    expect(declared(BOARDGAME), "premise: boardgame pays 2/1/0 half-points, so D = 1").toEqual({ W: 2, D: 1 });
    const rig = await swissRig(BOARDGAME, ["P1", "P2", "P3"], 3);
    const [A, B, C] = [rig.id.P1!, rig.id.P2!, rig.id.P3!];
    await pair(rig);
    let rows = await boardsOf(rig.stageId);
    expect(shapeOf(rig, rows, 1), "rig: round 1").toEqual(["P1-P2", "P3 bye"]);
    await BOARDGAME.win(rig.auth, boardBetween(rows, 1, A, B), A);

    const late = await addLate(rig, "L");
    expect(late.late_entry, "rig: Add after round 1 is case (c), joining round 2").toMatchObject({ case: "c", round: 2 });
    const L = late.id;
    await pair(rig);
    rows = await boardsOf(rig.stageId);
    expect(shapeOf(rig, rows, 2), "rig: round 2").toEqual(["L-P2", "P1-P3"]);
    await BOARDGAME.win(rig.auth, boardBetween(rows, 2, A, C), A);
    await BOARDGAME.win(rig.auth, boardBetween(rows, 2, L, B), L);
    await pair(rig);
    rows = await boardsOf(rig.stageId);
    expect(shapeOf(rig, rows, 3), "rig: round 3").toEqual(["L-P1", "P2-P3"]);
    await BOARDGAME.win(rig.auth, boardBetween(rows, 3, L, A), L);
    await BOARDGAME.draw!(rig.auth, boardBetween(rows, 3, B, C));

    expect(await pointsOf(rig), "premise: the scores the derivation starts from, in half-points").toEqual({ P1: 4, P2: 1, P3: 3, L: 4 });
    const checked = await expectTable(rig, { P1: { bh: 4 }, P2: { bh: 5.5 }, P3: { bh: 4 }, L: { bh: 4 } }, "S4 boardgame");
    expect(checked).toBe(4);
    // a second read gives identical rows (the desk's table and the public table both)
    const again = await deskRows(rig);
    expect([...again.values()].map((r) => [r.entrantId, r.rank, r.points, r.metrics])).toEqual(
      [...(await deskRows(rig)).values()].map((r) => [r.entrantId, r.rank, r.points, r.metrics]),
    );
    expect([...(await publicCells(rig)).entries()]).toEqual([...(await publicCells(rig)).entries()]);
  }, 180_000);

  /**
   * The same shape on badminton: whole points, win 2 (the clean sweep's, `bySetScore "*"`), no draw -> D = 1/2 x 2 = 1, R = 3,
   * cap = 3. R3's board B-C has no draw, so C beats B.
   *   R1: A beats B, C bye.   R2: A beats C, L beats B.   R3: L beats A, C beats B.
   *   Scores: A 2+2+0 = 4, B 0, C 2+0+2 = 4, L 0+2+2 = 4.
   *   Buchholz: L = dummy min(4, 3) = 3 + B 0 + A 4 = 7;  B = A 4 + L 4 + C 4 = 12;  A = B 0 + C 4 + L 4 = 8;
   *   C = bye min(4, 3) = 3 + A 4 + B 0 = 7.   Displayed unhalved (whole points).
   * // differential: without the producer L = B 0 + A 4 = 4.
   */
  it("X-SW-8 the same on badminton: D = half the declared win (no draw), whole points unhalved", async () => {
    expect(declared(BADMINTON), "premise: badminton declares a win of 2 (set sweep) and no draw, so D = 1").toEqual({ W: 2, D: 1 });
    expect(unitScale(BADMINTON), "premise: whole points").toBe(1);
    const rig = await swissRig(BADMINTON, ["P1", "P2", "P3"], 3);
    const [A, B, C] = [rig.id.P1!, rig.id.P2!, rig.id.P3!];
    await pair(rig);
    let rows = await boardsOf(rig.stageId);
    expect(shapeOf(rig, rows, 1), "rig: round 1").toEqual(["P1-P2", "P3 bye"]);
    await BADMINTON.win(rig.auth, boardBetween(rows, 1, A, B), A);
    const late = await addLate(rig, "L");
    expect(late.late_entry).toMatchObject({ case: "c", round: 2 });
    const L = late.id;
    await pair(rig);
    rows = await boardsOf(rig.stageId);
    expect(shapeOf(rig, rows, 2), "rig: round 2").toEqual(["L-P2", "P1-P3"]);
    await BADMINTON.win(rig.auth, boardBetween(rows, 2, A, C), A);
    await BADMINTON.win(rig.auth, boardBetween(rows, 2, L, B), L);
    await pair(rig);
    rows = await boardsOf(rig.stageId);
    expect(shapeOf(rig, rows, 3), "rig: round 3").toEqual(["L-P1", "P2-P3"]);
    await BADMINTON.win(rig.auth, boardBetween(rows, 3, L, A), L);
    await BADMINTON.win(rig.auth, boardBetween(rows, 3, C, B), C);

    expect(await pointsOf(rig), "premise: the scores the derivation starts from").toEqual({ P1: 4, P2: 0, P3: 4, L: 4 });
    expect(await expectTable(rig, { P1: { bh: 8 }, P2: { bh: 12 }, P3: { bh: 7 }, L: { bh: 7 } }, "S4 badminton")).toBe(4);
  }, 180_000);

  /**
   * Review Focus 2 - a case-(c) latecomer with no seat yet is on the roster but NOT on the table (the table's entrants are the
   * entrants holding a seat). Naming it in `swissAbsentRounds` makes the engine refuse the whole stage (CONFIG_INVALID) and every
   * standings read fail. After round 1 (A beats B, C bye) and L's Add: A 0, B = A 2 -> 1, C = bye min(2, 3) = 2 -> 1 (half-points
   * -> display), three rows. Then Pair round 2 seats L and the key appears: R2 A beats C, L beats B (R = 3, cap 3), scores A 4,
   * B 0, C 2, L 2:  A = B 0 + C 2 = 2 -> 1;  B = A 4 + L 2 = 6 -> 3;  C = bye min(2, 3) = 2 + A 4 = 6 -> 3;  L = its missed
   * round 1 (16.2.3, R2 is played) dummy min(2, 3) = 2 + B 0 = 2 -> 1.   // differential: no key, L = B 0 -> 0.
   */
  it("X-SW-8 a case-(c) latecomer with no seat yet: the table ranks with no key; Pair the next round and the key appears with the missed round", async () => {
    const rig = await swissRig(BOARDGAME, ["P1", "P2", "P3"], 3);
    const [A, B, C] = [rig.id.P1!, rig.id.P2!, rig.id.P3!];
    await pair(rig);
    let rows = await boardsOf(rig.stageId);
    await BOARDGAME.win(rig.auth, boardBetween(rows, 1, A, B), A);
    const late = await addLate(rig, "L");
    expect(late.late_entry).toMatchObject({ case: "c", round: 2 });
    const L = late.id;
    const [stamp] = await sql<{ swiss_first_round: number | null }[]>`select swiss_first_round from entrants where id = ${L}`;
    expect(stamp!.swiss_first_round, "rig: L is on the roster with its first round stamped, and holds no seat").toBe(2);
    expect((await boardsOf(rig.stageId)).flatMap((f) => [f.home_entrant_id, f.away_entrant_id]), "rig: no seat").not.toContain(L);

    // L is not a table entrant: three rows, no CONFIG_INVALID, nobody counted absent from a round they sat
    expect([...(await deskRows(rig)).keys()].sort(), "the table is the three seated entrants").toEqual(["P1", "P2", "P3"]);
    expect(await expectTable(rig, { P1: { bh: 0 }, P2: { bh: 1 }, P3: { bh: 1 } }, "before L is seated")).toBe(3);

    await pair(rig);
    rows = await boardsOf(rig.stageId);
    expect(shapeOf(rig, rows, 2), "rig: round 2").toEqual(["L-P2", "P1-P3"]);
    await BOARDGAME.win(rig.auth, boardBetween(rows, 2, A, C), A);
    await BOARDGAME.win(rig.auth, boardBetween(rows, 2, L, B), L);
    expect(await expectTable(rig, { P1: { bh: 1 }, P2: { bh: 3 }, P3: { bh: 3 }, L: { bh: 1 } }, "after L is seated and round 2 played")).toBe(4);
  }, 180_000);

  /**
   * Review Focus 4 - the public table renders during play. S4 after round 1 and L's Add, round 2 PAIRED (A v C, B v L) with:
   *  (i) nothing played: no card in round 2, A 0, B = A 2 -> 1, C = bye min(2, 3) = 2 -> 1, L = own round 1 absent dummy min(0, 3) = 0 (display 0, 1, 1, 0) -
   *      and every seat of round 2 is a seat, so nobody but L (round 1) is absent;
   *  (ii) L beats B decided, A v C still pending: scores A 2, B 0, C 2, L 2:  A = B 0 -> 0;  B = A 2 + L 2 = 4 -> 2;
   *      C = bye min(2, 3) = 2 -> 1;  L = round 1 `absent` (16.2.3, R2 played) min(2, 3) = 2 + B 0 = 2 -> 1.
   * // differential: a pending board read as no seat makes A and C absent from round 2 (16.2.5: A's adjusted 2 + D = 3), B reads A at 3.
   */
  it("X-SW-8 a seated pending board is not an absence: ranked mid-round, nobody on a pending board is absent from it", async () => {
    const rig = await swissRig(BOARDGAME, ["P1", "P2", "P3"], 3);
    const [A, B] = [rig.id.P1!, rig.id.P2!];
    await pair(rig);
    let rows = await boardsOf(rig.stageId);
    await BOARDGAME.win(rig.auth, boardBetween(rows, 1, A, B), A);
    const late = await addLate(rig, "L");
    const L = late.id;
    await pair(rig);
    rows = await boardsOf(rig.stageId);
    expect(shapeOf(rig, rows, 2), "rig: round 2").toEqual(["L-P2", "P1-P3"]);
    expect(roundOf(rows, 2).map((f) => f.status), "rig: both round-2 boards are pending").toEqual(["scheduled", "scheduled"]);
    expect(await expectTable(rig, { P1: { bh: 0 }, P2: { bh: 1 }, P3: { bh: 1 }, L: { bh: 0 } }, "round 2 paired, nothing played")).toBe(4);

    await BOARDGAME.win(rig.auth, boardBetween(rows, 2, L, B), L);
    expect(
      (await boardsOf(rig.stageId)).filter((f) => f.round_no === 2 && f.status !== "decided").length,
      "rig: exactly one round-2 board is still pending",
    ).toBe(1);
    expect(await expectTable(rig, { P1: { bh: 0 }, P2: { bh: 2 }, P3: { bh: 1 }, L: { bh: 1 } }, "one board decided, one pending")).toBe(4);
  }, 180_000);

  /**
   * Sequence - a void. L beats B is voided: the round keeps its seats, so it is still an open round and nobody is newly absent.
   * The table returns to the "round 2 paired, nothing played" values of the test above (A 0, B 1, C 1, L 0), derived there.
   */
  it("X-SW-8 after a void of round 2's only result, the round is still open and its seats still count", async () => {
    const rig = await swissRig(BOARDGAME, ["P1", "P2", "P3"], 3);
    const [A, B] = [rig.id.P1!, rig.id.P2!];
    await pair(rig);
    let rows = await boardsOf(rig.stageId);
    await BOARDGAME.win(rig.auth, boardBetween(rows, 1, A, B), A);
    const L = (await addLate(rig, "L")).id;
    await pair(rig);
    rows = await boardsOf(rig.stageId);
    const board = boardBetween(rows, 2, L, B);
    await BOARDGAME.win(rig.auth, board, L);
    expect(await expectTable(rig, { P1: { bh: 0 }, P2: { bh: 2 }, P3: { bh: 1 }, L: { bh: 1 } }, "before the void")).toBe(4);

    const events = await sql<{ id: string; type: string }[]>`select id, type from score_events where fixture_id = ${board.id} and type = 'boardgame.result'`;
    expect(events.length, "rig: the result event to void").toBe(1);
    await post(rig.auth, board.id, "core.void", { event_id: events[0]!.id });
    const after = (await boardsOf(rig.stageId)).find((f) => f.id === board.id)!;
    expect([after.home_entrant_id, after.away_entrant_id].sort(), "rig: the voided board keeps its seats").toEqual([L, B].sort());
    expect(after.status, "rig: and is no longer decided").not.toBe("decided");
    expect(await expectTable(rig, { P1: { bh: 0 }, P2: { bh: 1 }, P3: { bh: 1 }, L: { bh: 0 } }, "after the void")).toBe(4);
  }, 180_000);

  /**
   * Review Focus 3 - an ad-hoc round (a stored legacy `adhoc-N` row, round maxRound + 1) declares no absences for anyone it does
   * not seat. Four players, R = 2 (cap 2): R1 A=P1 beats B=P3, C=P2 beats D=P4; R2 P1 beats P2, P3 beats P4. Scores (half): P1 4,
   * P2 2, P3 2, P4 0. Buchholz (half): P1 = P3 2 + P2 2 = 4 -> 2; P2 = P4 0 + P1 4 = 4 -> 2; P3 = P1 4 + P4 0 = 4 -> 2;
   * P4 = P2 2 + P3 2 = 4 -> 2. A pending ad-hoc P1 v P2 (round 3) changes nothing: P3 and P4 are not "absent from round 3" (that
   * would be a phantom VUR, and a round past the stage's 2 - the engine refuses it).
   */
  it("X-SW-8 an ad-hoc round declares no absences: a legacy adhoc row leaves the table as it was", async () => {
    const rig = await swissRig(BOARDGAME, ["P1", "P2", "P3", "P4"], 2);
    const [P1, P2, P3, P4] = [rig.id.P1!, rig.id.P2!, rig.id.P3!, rig.id.P4!];
    await pair(rig);
    let rows = await boardsOf(rig.stageId);
    expect(shapeOf(rig, rows, 1), "rig: round 1").toEqual(["P1-P3", "P2-P4"]);
    await BOARDGAME.win(rig.auth, boardBetween(rows, 1, P1, P3), P1);
    await BOARDGAME.win(rig.auth, boardBetween(rows, 1, P2, P4), P2);
    await pair(rig);
    rows = await boardsOf(rig.stageId);
    expect(shapeOf(rig, rows, 2), "rig: round 2").toEqual(["P1-P2", "P3-P4"]);
    await BOARDGAME.win(rig.auth, boardBetween(rows, 2, P1, P2), P1);
    await BOARDGAME.win(rig.auth, boardBetween(rows, 2, P3, P4), P3);
    const want: Want = { P1: { bh: 2 }, P2: { bh: 2 }, P3: { bh: 2 }, P4: { bh: 2 } };
    expect(await expectTable(rig, want, "before the ad-hoc row")).toBe(4);

    const { fixture_id } = await seedLegacySwissAdhoc(rig.stageId, P1, P2);
    const [adhoc] = await sql<{ round_no: number; ext_key: string }[]>`select round_no, ext_key from fixtures where id = ${fixture_id}`;
    expect(adhoc, "rig: the ad-hoc row sits in a round past the Swiss's two").toMatchObject({ round_no: 3, ext_key: expect.stringMatching(/^adhoc-/) });
    expect(await expectTable(rig, want, "with a pending ad-hoc row")).toBe(4);
  }, 180_000);

  // ── X-SW-7: forfeits, double walkovers, withdrawals ──────────────────────────────────────────────────────────────────

  /**
   * S2 (forfeit), R = 2, D = 1 -> cap 2; W = the sport's declared win. B (the forfeiter) and A hold the seats of round 1's top
   * board; C beats D on the other.   R1: B forfeits to A with nothing played; C beats D.   R2: A beats C, B beats D.
   *   Scores: A 2W, B W (its round-2 win), C W, D 0.
   *   A = forfeit_win min(2W, B's adjusted W) = W + C W = 2W;   B = forfeit_loss min(W, A's adjusted 2W) = W + D 0 = W;
   *   C = D 0 + A 2W = 2W;   D = C W + B W = 2W.   Cut-1 (16.5.1): A: no VUR, the lowest card (W) -> W;
   *   B: its lowest VUR (W) -> 0;   C: 0 -> 2W;   D: W -> W.   Displayed in the sport's unit (half-points halved).
   * // differential (today, the forfeit read as a played game v A): B = A 2W + 0 = 2W (not W), Cut-1 = lowest overall 0 -> 2W.
   *
   * Run with the forfeiter in the HOME seat and in the AWAY seat: `unplayed` names a seat ("home"/"away"), so a producer that
   * had the two the wrong way round would charge the winner's card instead - and the boardgame draws its colours by a lot,
   * so one run of one seat would prove it half the time.
   */
  for (const sc of [BOARDGAME, BADMINTON, FOOTBALL]) {
    for (const side of ["home", "away"] as const) {
      it(`X-SW-7 a pre-play walkover is unplayed: the loser's Buchholz uses a dummy capped at the opponent's adjusted score (S2, ${sc.sport}, forfeiter ${side})`, async () => {
        const { W } = declared(sc);
        const k = unitScale(sc);
        const rig = await swissRig(sc, ["P1", "P2", "P3", "P4"], 2);
        await pair(rig);
        let rows = await boardsOf(rig.stageId);
        expect(shapeOf(rig, rows, 1), "rig: round 1").toEqual(["P1-P3", "P2-P4"]);
        const top = boardBetween(rows, 1, rig.id.P1!, rig.id.P3!);
        const B = side === "home" ? top.home_entrant_id! : top.away_entrant_id!;
        const A = side === "home" ? top.away_entrant_id! : top.home_entrant_id!;
        const [C, D] = [rig.id.P2!, rig.id.P4!];
        await post(rig.auth, top.id, "core.forfeit", { by: B, reason: "walkover" });
        await sc.win(rig.auth, boardBetween(rows, 1, C, D), C);
        expect(await sql`select 1 from score_events where fixture_id = ${top.id} and type <> 'core.forfeit'`, "rig: nothing was played on the forfeited board").toHaveLength(0);
        await pair(rig);
        rows = await boardsOf(rig.stageId);
        expect(shapeOf(rig, rows, 2), "rig: round 2 pairs the winners and the losers").toEqual([[rig.name(A), "P2"].sort().join("-"), [rig.name(B), "P4"].sort().join("-")].sort());
        await sc.win(rig.auth, boardBetween(rows, 2, A, C), A);
        await sc.win(rig.auth, boardBetween(rows, 2, B, D), B);

        expect(await pointsOf(rig), "premise: the scores the derivation starts from").toEqual({ [rig.name(A)]: 2 * W, [rig.name(B)]: W, P2: W, P4: 0 });
        const hasCut1 = (await deskRows(rig)).get("P2")!.metrics.buchholz_cut1 !== undefined;
        const want: Want = {
          [rig.name(A)]: { bh: (2 * W) / k, ...(hasCut1 ? { cut1: W / k } : {}) },
          [rig.name(B)]: { bh: W / k, ...(hasCut1 ? { cut1: 0 } : {}) },
          P2: { bh: (2 * W) / k, ...(hasCut1 ? { cut1: (2 * W) / k } : {}) },
          P4: { bh: (2 * W) / k, ...(hasCut1 ? { cut1: W / k } : {}) },
        };
        expect(await expectTable(rig, want, `S2 ${sc.sport} ${side}`)).toBe(4);
        // the differential must be one the numbers can tell: the played reading of B's round would be 2W
        expect(W / k, "the forfeit reading is not the played reading").not.toBe((2 * W) / k);
      }, 180_000);
    }
  }

  /**
   * The positive pair of the walkover: a retirement AFTER play is a played game (M3), `forfeitPlayedFacts` true. S2 with B started
   * and retired: B's round-1 card reads A's adjusted score as a played game: B = A 4 + D 0 = 4 half -> 2, Cut-1 = the lowest
   * card (0) cut -> 4 -> 2 (the unplayed S2 has B 1 and Cut-1 0).
   */
  it("X-SW-7 a retirement after play stays played: the loser reads its opponent's score, no dummy", async () => {
    const rig = await swissRig(BOARDGAME, ["P1", "P2", "P3", "P4"], 2);
    const [A, B, C, D] = [rig.id.P1!, rig.id.P3!, rig.id.P2!, rig.id.P4!];
    await pair(rig);
    let rows = await boardsOf(rig.stageId);
    const retired = boardBetween(rows, 1, A, B);
    await post(rig.auth, retired.id, "core.start");
    await post(rig.auth, retired.id, "core.forfeit", { by: B, reason: "retired" });
    await BOARDGAME.win(rig.auth, boardBetween(rows, 1, C, D), C);
    expect((await boardsOf(rig.stageId)).find((f) => f.id === retired.id)!.status, "rig: the retirement decided the board").toBe("forfeited");
    const { forfeitPlayedFacts } = await import("@/server/engine-db/forfeit-played");
    const { resolveModule } = await import("@/server/engine-db");
    const facts = await forfeitPlayedFacts(sql, [{ id: retired.id, outcome: (await boardsOf(rig.stageId)).find((f) => f.id === retired.id)!.outcome }], resolveModule("boardgame", moduleOf("boardgame").version));
    expect(facts.get(retired.id), "rig: the ledger says something was played (chess: Start is play)").toBe(true);
    await pair(rig);
    rows = await boardsOf(rig.stageId);
    expect(shapeOf(rig, rows, 2), "rig: round 2").toEqual(["P1-P2", "P3-P4"]);
    await BOARDGAME.win(rig.auth, boardBetween(rows, 2, A, C), A);
    await BOARDGAME.win(rig.auth, boardBetween(rows, 2, B, D), B);
    expect(await pointsOf(rig)).toEqual({ P1: 4, P2: 2, P3: 2, P4: 0 });
    expect(await expectTable(rig, { P1: { bh: 2, cut1: 1 }, P3: { bh: 2, cut1: 2 }, P2: { bh: 2, cut1: 2 }, P4: { bh: 2, cut1: 1 } }, "S2 with a retirement after play")).toBe(4);
  }, 180_000);


  /**
   * A double walkover (rulebook §4 M2): BOTH sides lost without playing - each holds a forfeit_loss card against the other, a VUR
   * Cut-1 cuts first. R = 2, D = 1 (half-points). R1: P1 v P3 double walkover, P2 draws P4. R2 (the Swiss pairs a 1-pointer with
   * a 0-pointer, never the two who met): P1 and P3 each beat one of P2/P4. Scores (half): P1 2, P3 2, P2 1, P4 1.
   *   P1 = forfeit_loss min(2, P3's 2) = 2 + the player it beat 1 = 3 -> 1.5;  Cut-1 cuts the VUR (2) -> 1 -> 0.5. P3 the same.
   *   P2 = P4 1 + the player it lost to 2 = 3 -> 1.5;  no VUR, Cut-1 cuts the lowest (1) -> 2 -> 1. P4 the same.
   * // differential: read as a played game P1's Cut-1 cuts the lowest card (1) -> 2 -> 1, not 0.5.
   * single-sport: boardgame - a draw is the only way to give the other board two 1-pointers; the double walkover's seat answer
   * ("both") does not depend on the sport.
   */
  it("X-SW-7 a double walkover gives both sides a forfeit_loss: Cut-1 cuts it first (boardgame)", async () => {
    const rig = await swissRig(BOARDGAME, ["P1", "P2", "P3", "P4"], 2);
    const [P1, P2, P3, P4] = [rig.id.P1!, rig.id.P2!, rig.id.P3!, rig.id.P4!];
    await pair(rig);
    let rows = await boardsOf(rig.stageId);
    expect(shapeOf(rig, rows, 1), "rig: round 1").toEqual(["P1-P3", "P2-P4"]);
    await post(rig.auth, boardBetween(rows, 1, P1, P3).id, "core.forfeit", { by: "both", reason: "walkover" });
    await BOARDGAME.draw!(rig.auth, boardBetween(rows, 1, P2, P4));
    expect((await boardsOf(rig.stageId)).find((f) => f.id === boardBetween(rows, 1, P1, P3).id)!.outcome, "rig: a recorded double walkover").toEqual({ kind: "double_walkover" });
    await pair(rig);
    rows = await boardsOf(rig.stageId);
    const r2 = roundOf(rows, 2).filter((f) => f.home_entrant_id !== null && f.away_entrant_id !== null);
    expect(r2, "rig: two boards in round 2").toHaveLength(2);
    for (const f of r2) {
      const seats = [f.home_entrant_id!, f.away_entrant_id!];
      const low = seats.filter((x) => x === P1 || x === P3);
      expect(low, `rig: round 2 board ${shapeOf(rig, [f], 2)[0]} pairs one of the double-walkover pair with one of the drawers`).toHaveLength(1);
      await BOARDGAME.win(rig.auth, f, low[0]!);
    }
    expect(await pointsOf(rig), "premise: the scores the derivation starts from, in half-points").toEqual({ P1: 2, P2: 1, P3: 2, P4: 1 });
    expect(await expectTable(rig, { P1: { bh: 1.5, cut1: 0.5 }, P3: { bh: 1.5, cut1: 0.5 }, P2: { bh: 1.5, cut1: 1 }, P4: { bh: 1.5, cut1: 1 } }, "double walkover")).toBe(4);
  }, 180_000);

  /**
   * S3 (withdrawal), R = 3, D = the declared draw -> cap D x R. A = P1, B = P3 (withdraws after round 1), C = P2, D = P4.
   *   R1: A beats B, C beats D.   R2: A beats C, D bye.   R3: A draws D, C bye.   (B is unpaired in rounds 2 and 3.)
   *   Scores (W win, D draw): A 2W + D, B 0, C W + W (its bye), D W (its bye) + D.
   * B's rounds 2 and 3 are 16.2.5 (nothing follows), so its ADJUSTED score is 0 + 2D (16.3.2) and its opponent reads that:
   *   A = B (2D) + C (W + W) + D (W + D) ;   B = A (2W + D) + 0 + 0 (dummies at min(0, cap));
   *   C = D (W + D) + A (2W + D) + bye min(2W, D x 3);   D = C (2W) + bye min(W + D, 3D) + A (2W + D).
   * Boardgame (W 2, D 1, half-points): A 9 -> 4.5, B 5 -> 2.5, C 11 -> 5.5, D 12 -> 6.   Football (W 3, D 1): A 12, B 7, C 14, D 16.
   * // differential: today B is read at its real 0: boardgame A = 0 + 4 + 3 = 7 -> 3.5 (football 10); with D = W/2 the football
   * //  A would be 13 (B adjusted 3).
   */
  for (const sc of [BOARDGAME, FOOTBALL]) {
    it(`X-SW-7 a withdrawn entrant's opponents read its adjusted score (S3, ${sc.sport}, via withdrawEntrantCascade)`, async () => {
      const { W, D } = declared(sc);
      const k = unitScale(sc);
      const rig = await swissRig(sc, ["P1", "P2", "P3", "P4"], 3);
      const [A, B, C, Dd] = [rig.id.P1!, rig.id.P3!, rig.id.P2!, rig.id.P4!];
      await pair(rig);
      let rows = await boardsOf(rig.stageId);
      expect(shapeOf(rig, rows, 1), "rig: round 1").toEqual(["P1-P3", "P2-P4"]);
      await sc.win(rig.auth, boardBetween(rows, 1, A, B), A);
      await sc.win(rig.auth, boardBetween(rows, 1, C, Dd), C);
      const out = await withdrawEntrantCascade(rig.auth, B);
      expect(out, "rig: a withdrawal between rounds walks nothing over").toMatchObject({ status: "withdrawn", walkovers: 0, voided: 0 });
      await pair(rig);
      rows = await boardsOf(rig.stageId);
      expect(shapeOf(rig, rows, 2), "rig: round 2").toEqual(["P1-P2", "P4 bye"]);
      await sc.win(rig.auth, boardBetween(rows, 2, A, C), A);
      await pair(rig);
      rows = await boardsOf(rig.stageId);
      expect(shapeOf(rig, rows, 3), "rig: round 3").toEqual(["P1-P4", "P2 bye"]);
      await sc.draw!(rig.auth, boardBetween(rows, 3, A, Dd));

      expect(await pointsOf(rig), "premise: the scores the derivation starts from").toEqual({ P1: 2 * W + D, P3: 0, P2: 2 * W, P4: W + D });
      const cap = D * 3;
      const bAdjusted = 0 + 2 * D;
      const bh = {
        P1: bAdjusted + 2 * W + (W + D),
        P3: 2 * W + D + 0 + 0,
        P2: W + D + (2 * W + D) + Math.min(2 * W, cap),
        P4: 2 * W + Math.min(W + D, cap) + (2 * W + D),
      };
      const want: Want = Object.fromEntries(Object.entries(bh).map(([n, v]) => [n, { bh: v / k }]));
      expect(await expectTable(rig, want, `S3 ${sc.sport}`)).toBe(4);
    }, 240_000);
  }

  /**
   * Every sport, counted: round 1 and round 2 of a four-player Swiss decided BY WALKOVER on every board (nothing played, so no
   * sport's scorer is needed), forfeiters alternating between the home and the away seat. Every card is then an unplayed one, and
   * the rulebook's formula (16.3, 16.4.1, 16.5.1) over the table's own scores s is:
   *   a card against o, win or loss alike, contributes min(s(e), s(o)) (the cap is o's adjusted score, no absence here);
   *   Buchholz(e) = the sum of its cards;   Cut-1(e) = Buchholz(e) - its lowest VUR card (a forfeit_loss), else its lowest card.
   * // differential: read as played games Buchholz(e) is the sum of s(o), which differs for a loser (its opponent out-scores it).
   * The scores are the table's (the points rule is another suite's); what is held to the rulebook is the ledger read over them.
   */
  it("X-SW-7 every sport: forfeits with nothing played are unplayed rounds, held to the rulebook's card formula (registry sweep, counted)", async () => {
    const seen = { sports: 0, entrants: 0, differing: 0, cut1: 0, halfUnit: 0 };
    const skipped: string[] = [];
    const swept = await forEachSportAsync(async ({ key, module: m }) => {
      const variant = Object.keys(m.variants)[0];
      if (variant === undefined) throw new Error(`${key} declares no variant`);
      const sc: SportCase = { sport: key, variant, win: async () => { throw new Error("never played"); } };
      let rig: Rig;
      try {
        rig = await swissRig(sc, ["P1", "P2", "P3", "P4"], 2);
      } catch (e) {
        skipped.push(`${key}: ${e instanceof Error ? e.message : String(e)}`);
        return;
      }
      const decided: { winner: string; loser: string }[] = [];
      let flip = 0;
      for (let r = 1; r <= 2; r++) {
        await pair(rig);
        const scores = await pointsOf(rig);
        const boards = roundOf(await boardsOf(rig.stageId), r).filter((f) => f.home_entrant_id !== null && f.away_entrant_id !== null);
        expect(boards, `${key}: round ${r} seats two boards`).toHaveLength(2);
        for (const f of boards) {
          const [h, a] = [f.home_entrant_id!, f.away_entrant_id!];
          // the lower scorer forfeits (a tie: alternate seats), so both seats are charged across the sweep
          const sh = scores[rig.name(h)] ?? 0;
          const sa = scores[rig.name(a)] ?? 0;
          const loser = sh !== sa ? (sh < sa ? h : a) : flip++ % 2 === 0 ? a : h;
          const winner = loser === h ? a : h;
          await post(rig.auth, f.id, "core.forfeit", { by: loser, reason: "walkover" });
          decided.push({ winner: rig.name(winner), loser: rig.name(loser) });
        }
      }
      const s = await pointsOf(rig);
      const cards = new Map<string, { c: number; vur: boolean; opp: string }[]>();
      for (const b of decided) {
        const c = Math.min(s[b.winner]!, s[b.loser]!);
        cards.set(b.winner, [...(cards.get(b.winner) ?? []), { c, vur: false, opp: b.loser }]);
        cards.set(b.loser, [...(cards.get(b.loser) ?? []), { c, vur: true, opp: b.winner }]);
      }
      expect(cards.size, `${key}: all four entrants hold cards`).toBe(4);
      const k = unitScale(sc);
      const want: Want = {};
      const desk = await deskRows(rig);
      const hasCut1 = desk.get("P1")!.metrics.buchholz_cut1 !== undefined;
      let differs = false;
      for (const [name, cs] of cards) {
        const bh = cs.reduce((t, x) => t + x.c, 0);
        const vurs = cs.filter((x) => x.vur);
        const cut = Math.min(...(vurs.length > 0 ? vurs : cs).map((x) => x.c));
        want[name] = { bh: bh / k, ...(hasCut1 ? { cut1: (bh - cut) / k } : {}) };
        if (bh !== cs.reduce((t, x) => t + s[x.opp]!, 0)) differs = true;
        seen.entrants++;
        if (hasCut1) seen.cut1++;
      }
      expect(differs, `${key}: the scenario can tell the unplayed reading from the played one`).toBe(true);
      seen.differing++;
      if (k === 2) seen.halfUnit++;
      expect(await expectTable(rig, want, `walkover sweep ${key}`)).toBe(4);
      seen.sports++;
    });
    // a sport that cannot run a Swiss is named, with the refusal, and counted - never silently absent
    expect(seen.sports + skipped.length, "every registry sport was swept or named").toBe(swept);
    expect(swept).toBe(builtinModules.length);
    expect(seen.sports, `anti-vacuity: the sweep ran (skipped: ${skipped.join("; ")})`).toBeGreaterThan(5);
    expect(seen.differing).toBe(seen.sports);
    expect(seen.cut1, "Cut-1 was held to the rulebook for some sport").toBeGreaterThan(0);
    expect(seen.halfUnit, "a half-point sport was swept").toBeGreaterThan(0);
  }, 600_000);
});
