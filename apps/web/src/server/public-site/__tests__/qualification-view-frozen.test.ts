// W5 app PR B Task 6 (X-QS-1, X-QS-2 <- RB5-T1..T4, RB5-T14; owner ruling 283; R24 pick 17 A; ST-G17; preflight K24, K25): a
// finished league, group or Swiss table keeps its cut line, frozen. The live race ("Through / Win and in / Needs help / Out") stops,
// and each row still in the field reads "Qualified" or "Out" - from who actually went through (`meta.qualified`: the destination's
// confirmed proposal, else its stored `config.qualified`), else from the final table's own order. A departed row has no marker
// (its "Withdrawn" chip is the table's); the legend loses "Still open"; the cut line says the places WENT through.
//
// differential: today (929cdbdf96) the builder hands the engine `complete: true` with neither `qualified` nor `order`, and engine
// 10's `frozenStatus` answers null for that (qualification.ts `frozenStatus`: "No order source ... fails closed") - so every
// finished table showed NOTHING: no marker, no cut line, no legend.
//
// Expected values: the rulebook's table read by hand off the results typed below (a win is 3 points, the better row wins every
// match unless a case says otherwise), and the owner-approved words of the R24 pick (typed from the mock, never read back from the
// dictionary the builder resolves). Every result is the REAL builder over the REAL engine; nothing is mocked.
import { describe, expect, it } from "vitest";
import { foldResults, rankStandings, type FixtureResult, type StandingsRow } from "@seazn/engine/competition";
import type { AnySportModule } from "@seazn/engine/sport";
import { builtinModules } from "@seazn/engine/sports";
import { declaredCfgs, defaultOrderOf, simOptionsFor, simulateDivision } from "@seazn/engine/testkit";
import en from "@/dictionaries/en/public.json";
import { plural, t, type TKey } from "@/lib/i18n-runtime";
import { QualRowView, QualTable } from "../competition-hub-schema";
import { buildQualificationView, divisionAwardAddsToLedger, divisionPointsBounds, type QualFixture, type QualificationViewInput, type StageQualMeta } from "../qualification-view";

// single-sport: the frozen markers read only who went through and the final order, which no sport field reaches; the wins-first sports (badminton, tennis, volleyball) differ only in the live race the freeze switches off, swept in qualification-view.test.ts, and the cut-line tie below is swept over every builtin sport.
const GENERIC = builtinModules.find((m) => m.key === "generic")!;
const CFG = { resultMode: "score", allowDraws: true, points: { w: 3, d: 1, l: 0 }, progressScore: false };
const BOUNDS = divisionPointsBounds(GENERIC, CFG)!;

/** R24 pick 17 A, the mock's words. */
const PICK = { qualified: "Qualified", out: "Out", wentThrough2: "Top 2 went through to Finals" } as const;

let n = 0;
const fx = (round: number, home: string, away: string, winner: string | null, pool: string | null = null): QualFixture => ({
  id: `f${++n}`,
  stage_id: "S",
  pool_id: pool,
  round_no: round,
  status: winner === null ? "scheduled" : "decided",
  home_entrant_id: home,
  away_entrant_id: away,
  outcome: winner === null ? null : { kind: "win", winner, loser: winner === home ? away : home },
  played: false,
});

/** Every pair of `ids` once (a single round robin), the earlier id winning unless `upsets` names the pair. */
function roundRobin(ids: readonly string[], opts: { open?: number; upsets?: readonly string[]; pool?: string | null } = {}): QualFixture[] {
  const out: QualFixture[] = [];
  let round = 0;
  for (let i = 0; i < ids.length; i++) {
    for (let j = i + 1; j < ids.length; j++) {
      const [a, b] = [ids[i]!, ids[j]!];
      const upset = opts.upsets?.includes(`${a}${b}`) ?? false;
      out.push(fx(++round, a, b, upset ? b : a, opts.pool ?? null));
    }
  }
  // the last `open` lines are still to play
  for (let k = 0; k < (opts.open ?? 0); k++) {
    const f = out[out.length - 1 - k]!;
    out[out.length - 1 - k] = { ...f, status: "scheduled", outcome: null };
  }
  return out;
}

/** The ranked rows a fold of `fixtures` gives: 3 points a win, ranked on points then for/diff (the table read by hand). */
function rowsOf(ids: readonly string[], fixtures: readonly QualFixture[], order: readonly string[]) {
  return order.map((id, i) => {
    const mine = fixtures.filter((f) => f.outcome !== null && (f.home_entrant_id === id || f.away_entrant_id === id));
    const w = mine.filter((f) => (f.outcome as { winner: string }).winner === id).length;
    expect(ids).toContain(id);
    return { entrantId: id, rank: i + 1, played: mine.length, won: w, drawn: 0, lost: mine.length - w, points: 3 * w, metrics: { for: w, against: mine.length - w, diff: 2 * w - mine.length } };
  });
}

function meta(over: Partial<StageQualMeta> = {}): StageQualMeta {
  return { qualifyCount: 2, qualifyPerGroup: false, nextStageName: "Finals", swissRounds: null, pointsRule: null, hasRankOverrides: false, tablePointsRule: null, ...over };
}

function input(o: { kind?: string; meta?: StageQualMeta; ids: string[]; fixtures: QualFixture[]; order: string[]; statuses?: Record<string, string>; poolId?: string | null }): QualificationViewInput {
  return {
    stage: { id: "S", kind: o.kind ?? "league", meta: o.meta ?? meta() },
    poolId: o.poolId ?? null,
    rows: rowsOf(o.ids, o.fixtures, o.order),
    fixtures: o.fixtures,
    entrantStatuses: o.statuses ?? Object.fromEntries(o.ids.map((id) => [id, "confirmed"])),
    bounds: BOUNDS,
    awardAddsToLedger: divisionAwardAddsToLedger(GENERIC, CFG),
    cascade: [...defaultOrderOf(GENERIC)],
    entrantNames: Object.fromEntries(o.ids.map((id) => [id, `Team ${id}`])),
    msg: (k: TKey, v?: Record<string, string | number>) => t(en, k, v),
    plural: (k: string, c: number, v?: Record<string, string | number>) => plural(en, k, c, "en", v),
  };
}

/** id -> its marker's label, or "none"; every id read (anti-vacuity: the caller asserts the count). */
const markers = (v: ReturnType<typeof buildQualificationView>, ids: readonly string[]) =>
  Object.fromEntries(ids.map((id) => [id, v?.rows[id]?.label ?? "none"]));

const FOUR = ["A", "B", "C", "D"];
/** A league of four, every line played: A 3 wins, B 2, C 1, D 0. */
const finished = () => roundRobin(FOUR);

describe("X-QS-1 / X-QS-2 a finished table keeps its cut, frozen (W5 app PR B Task 6)", () => {
  it("X-QS-1 a complete league shows Qualified and Out, never nothing", () => {
    // differential: today null (engine qualification.ts frozenStatus: no `qualified`, no `order`).
    const fixtures = finished();
    const v = buildQualificationView(input({ ids: FOUR, fixtures, order: FOUR }));
    expect(v, "a finished table keeps a view").not.toBeNull();
    const m = markers(v, FOUR);
    expect(Object.keys(m)).toHaveLength(4);
    expect(m).toEqual({ A: PICK.qualified, B: PICK.qualified, C: PICK.out, D: PICK.out });
    expect(v!.rows.A!.status, "the frozen kind travels in the document").toBe("qualified");
    expect(v!.rows.C!.status).toBe("out");
    for (const id of FOUR) {
      expect(v!.rows[id]!.ifYouLose, `${id}: no loss case on a finished table`).toBeNull();
      expect(v!.rows[id]!.whatIf).toBeNull();
      expect(QualRowView.safeParse(v!.rows[id]).success).toBe(true);
      expect(Object.values(v!.rows[id]!).join(" "), "never a printed key").not.toMatch(/table\.qual\./);
    }
    expect(v!.table.cutIndex, "the line sits under the second place").toBe(2);
    expect(v!.table.label, "past tense, and no rounds left").toBe(PICK.wentThrough2);
    expect(v!.table.legend.through, "the legend's tick reads Qualified").toBe(PICK.qualified);
    expect(v!.table.legend.open, "the legend loses Still open").toBeNull();
    expect(v!.table.legend.out).toBe(PICK.out);
    expect(QualTable.safeParse(v!.table).success).toBe(true);
    expect(v!.rows.A!.ariaLabel).toBe("Rank 1, Qualified, show details");
    expect(v!.rows.A!.headline).toContain("Finals");
    expect(v!.rows.C!.headline).toContain("Finals");
  });

  it("X-QS-2 a settled tie: the picked team reads Qualified", () => {
    // A beats everyone; C beats B, D beats C, B beats D: B, C and D one win each. The table's last resort put B second, the
    // confirm's tie pick put C through - and who went through is the pick, not the order: `qualified` wins (RB5-T14).
    const fixtures = roundRobin(FOUR, { upsets: ["BC", "CD"] });
    const order = ["A", "B", "C", "D"];
    const rows = rowsOf(FOUR, fixtures, order);
    expect(rows.find((r) => r.entrantId === "B")!.points, "the premise: B and C are level on points").toBe(rows.find((r) => r.entrantId === "C")!.points);
    const v = buildQualificationView(input({ ids: FOUR, fixtures, order, meta: meta({ qualified: ["A", "C"] }) }));
    const m = markers(v, FOUR);
    expect(Object.keys(m)).toHaveLength(4);
    expect(m).toEqual({ A: PICK.qualified, B: PICK.out, C: PICK.qualified, D: PICK.out });
  });

  it("X-QS-2 no confirmed set: the markers follow the cut and a correction moves them", () => {
    const fixtures = finished();
    const before = markers(buildQualificationView(input({ ids: FOUR, fixtures, order: FOUR })), FOUR);
    expect(before).toEqual({ A: PICK.qualified, B: PICK.qualified, C: PICK.out, D: PICK.out });
    // A correction of B v C (C wins it): C 2 wins, B 1 - the final order is A, C, B, D, and the markers move with it.
    const corrected = roundRobin(FOUR, { upsets: ["BC"] }).map((f) => (f.home_entrant_id === "B" && f.away_entrant_id === "D" ? { ...f, outcome: { kind: "win", winner: "D", loser: "B" } } : f));
    const after = markers(buildQualificationView(input({ ids: FOUR, fixtures: corrected, order: ["A", "C", "D", "B"] })), FOUR);
    expect(Object.keys(after)).toHaveLength(4);
    expect(after).toEqual({ A: PICK.qualified, B: PICK.out, C: PICK.qualified, D: PICK.out });
  });

  it("X-QS-2 a backfill after a withdrawal: the departed has no marker, the next eligible row reads Qualified", () => {
    // B finished second, then withdrew (after the table was complete: every result stands, nothing left to walk over). The cut
    // skips a departed entrant (W4 T13, RB4-V6): C backfills. Her row keeps its place in the table; it carries no marker.
    const fixtures = finished();
    const v = buildQualificationView(input({ ids: FOUR, fixtures, order: FOUR, statuses: { A: "confirmed", B: "withdrawn", C: "confirmed", D: "confirmed" } }));
    const m = markers(v, FOUR);
    expect(Object.keys(m)).toHaveLength(4);
    expect(m).toEqual({ A: PICK.qualified, B: "none", C: PICK.qualified, D: PICK.out });
    expect(v!.table.cutIndex, "the line sits under C, the second still in the field (B's row is above it)").toBe(3);
  });

  it("a Swiss table (S3) freezes the same way, from its final order", () => {
    // Four players, two rounds: A 2 wins, B 1, C 1, D 0 (A beat C then B; B beat D; C beat D). Cut 1 into Finals.
    const fixtures = [fx(1, "A", "C", "A"), fx(1, "B", "D", "B"), fx(2, "A", "B", "A"), fx(2, "C", "D", "C")].map((f) => ({ ...f, ext_key: null }));
    const v = buildQualificationView(input({ kind: "swiss", ids: FOUR, fixtures, order: ["A", "B", "C", "D"], meta: meta({ qualifyCount: 1, swissRounds: 2 }) }));
    const m = markers(v, FOUR);
    expect(Object.keys(m)).toHaveLength(4);
    expect(m).toEqual({ A: PICK.qualified, B: PICK.out, C: PICK.out, D: PICK.out });
    expect(v!.table.label).toBe("First place went through to Finals");
  });

  it("the empty case: a table with no cut shows no markers, finished or not", () => {
    const fixtures = finished();
    expect(buildQualificationView(input({ ids: FOUR, fixtures, order: FOUR, meta: meta({ qualifyCount: null, nextStageName: null }) }))).toBeNull();
    // and a cut that takes every row still in the field is no contest (F3), finished or not
    expect(buildQualificationView(input({ ids: FOUR, fixtures, order: FOUR, meta: meta({ qualifyCount: 4 }) }))).toBeNull();
  });

  it("the live table is unchanged: one line still to play shows the live race, never the frozen words", () => {
    const fixtures = roundRobin(FOUR, { open: 1 });
    const v = buildQualificationView(input({ ids: FOUR, fixtures, order: FOUR }));
    expect(v, "premise: a live view").not.toBeNull();
    const labels = Object.values(v!.rows).map((r) => r.label);
    expect(labels.length).toBeGreaterThan(0);
    expect(labels, "no frozen word on a running table").not.toContain(PICK.qualified);
    expect(v!.table.legend.open, "the live legend keeps Still open").toBe("Still open");
  });

  it("K25 best-Nth seats beside the per-group cut: no live race, frozen markers only from who went through", () => {
    // Pool P of four into "top 1 of each group and the best runner-up" (`qualifyBestNth`): B (2nd here) may or may not be the
    // best runner-up - only the confirmed seats say. Live: no status at all (an "Out" on B could be false).
    const bn = (over: Partial<StageQualMeta>) => meta({ qualifyCount: 1, qualifyPerGroup: true, qualifyBestNth: true, ...over });
    const live = roundRobin(FOUR, { open: 1, pool: "P" });
    expect(buildQualificationView(input({ kind: "group", poolId: "P", ids: FOUR, fixtures: live, order: FOUR, meta: bn({ qualified: null }) })), "live: no statuses").toBeNull();
    // B3 m-3: live with a seating already confirmed (a corrected result reopened the table after the confirm) - still the live
    // table, so still no statuses: the seats were made over results that are moving
    expect(buildQualificationView(input({ kind: "group", poolId: "P", ids: FOUR, fixtures: live, order: FOUR, meta: bn({ qualified: ["A", "B", "X9"] }) })), "live, seated: no statuses").toBeNull();
    const done = roundRobin(FOUR, { pool: "P" });
    expect(buildQualificationView(input({ kind: "group", poolId: "P", ids: FOUR, fixtures: done, order: FOUR, meta: bn({ qualified: null }) })), "finished, nobody seated yet: no markers (never the per-group order)").toBeNull();
    // seated: B was the best runner-up - she reads Qualified below the per-group line
    const seated = buildQualificationView(input({ kind: "group", poolId: "P", ids: FOUR, fixtures: done, order: FOUR, meta: bn({ qualified: ["A", "B", "X9"] }) }));
    const m = markers(seated, FOUR);
    expect(Object.keys(m)).toHaveLength(4);
    expect(m).toEqual({ A: PICK.qualified, B: PICK.qualified, C: PICK.out, D: PICK.out });
    // seated, and B was NOT the best runner-up (another pool's was)
    const other = markers(buildQualificationView(input({ kind: "group", poolId: "P", ids: FOUR, fixtures: done, order: FOUR, meta: bn({ qualified: ["A", "X9"] }) })), FOUR);
    expect(other).toEqual({ A: PICK.qualified, B: PICK.out, C: PICK.out, D: PICK.out });
  });
});

// ---------------------------------------------------------------------------------------------------------------------
// W5 B3 fix (review I-1; controller ruling 1): a cut-line tie waiting on the organiser's pick shows no final verdict.
// ---------------------------------------------------------------------------------------------------------------------
// The engine flags every row of a class it could not separate before the lot (or its seed fallback) `tieUnbroken`, with the
// class's other members in `tieBreak.with` (tiebreakers.js: "even with a lots decider the console should alert before KO
// seeding"). A class that STRADDLES the cut becomes a proposal tie (`resolveProgression`) that the confirm refuses until the
// organiser answers it (SEEDING_TIE_UNRESOLVED) - and the answer may send the lot's loser through. So until who went through
// is known (`meta.qualified`), the class's rows carry no frozen marker. A class wholly above or wholly below the cut decides
// nothing about who goes through: its rows keep theirs, and so does every row clear of the tie.
//
// Expected values: the engine's own ranking - `rankStandings` over results each sport's own fold paid, under the sport's
// declared league order - whose `tieUnbroken` flags and `with` lists are asserted as the premise, and the declared cut.
// The registry is swept (every sport, its first declared variant).

/** One decided match of `mod` under `cfg`, as its fold paid it (the engine's simulation plays it). */
function oneWin(mod: AnySportModule, cfg: unknown): { win: FixtureResult[0]; loss: FixtureResult[1] } {
  const sim = simulateDivision({ ...simOptionsFor(mod, "league", 7), cfg, entrantCount: 3 });
  const f = sim.stages[0]?.fixtures.find((x) => x.status === "decided" && x.winner !== undefined && x.result !== undefined);
  if (f?.result === undefined) throw new Error(`premise: ${mod.key}'s simulated league decided no match with a winner`);
  const [home, away] = f.result;
  const win = f.winner === home.entrantId ? home : away;
  return { win, loss: win === home ? away : home };
}

/** Each [winner, loser] pair, won exactly as the simulated match was: every win identical, every loss too. */
function engineScene(mod: AnySportModule, cfg: unknown, wins: readonly (readonly [string, string])[]) {
  const w = oneWin(mod, cfg);
  const results: FixtureResult[] = wins.map(([a, b]) => [
    { ...w.win, entrantId: a, metrics: { ...w.win.metrics } },
    { ...w.loss, entrantId: b, metrics: { ...w.loss.metrics } },
  ]);
  const cascade = mod.defaultTiebreakers("league", cfg as never);
  const { rows } = rankStandings(foldResults(FOUR, results), {
    cascade,
    results,
    seeds: new Map(FOUR.map((id, i) => [id, i + 1] as const)),
    rngSeed: 20261121,
    countedFixtures: results.length,
  });
  return { rows, cascade, fixtures: wins.map(([a, b], k) => fx(k + 1, a, b, a)) };
}

function sportInput(mod: AnySportModule, cfg: unknown, s: ReturnType<typeof engineScene>, cut: number, over: Partial<StageQualMeta> = {}): QualificationViewInput {
  return {
    stage: { id: "S", kind: "league", meta: meta({ qualifyCount: cut, ...over }) },
    poolId: null,
    rows: s.rows,
    fixtures: s.fixtures,
    entrantStatuses: Object.fromEntries(FOUR.map((id) => [id, "confirmed"])),
    bounds: divisionPointsBounds(mod, cfg),
    awardAddsToLedger: divisionAwardAddsToLedger(mod, cfg),
    cascade: s.cascade,
    primary: mod.primaryTableKey,
    entrantNames: Object.fromEntries(FOUR.map((id) => [id, `Team ${id}`])),
    msg: (k: TKey, v?: Record<string, string | number>) => t(en, k, v),
    plural: (k: string, c: number, v?: Record<string, string | number>) => plural(en, k, c, "en", v),
  };
}

/** A leads (beats all three); B, C and D go round in a circle (B beats C, C beats D, D beats B): level on everything. */
const LEADER_AND_CIRCLE = [["A", "B"], ["A", "C"], ["A", "D"], ["B", "C"], ["C", "D"], ["D", "B"]] as const;
/** A, B and C go round in a circle (A beats B, B beats C, C beats A) and each beats D: three level at the top. */
const CIRCLE_AND_TAIL = [["A", "B"], ["B", "C"], ["C", "A"], ["A", "D"], ["B", "D"], ["C", "D"]] as const;

/** The engine's own tie classes: each `tieUnbroken` row with the members its `with` names, sorted. */
const engineClasses = (rows: readonly StandingsRow[]) =>
  [...new Set(rows.filter((r) => r.tieUnbroken === true).map((r) => [r.entrantId, ...(r.tieBreak?.with ?? [])].sort().join(",")))];
const byRank = (rows: readonly StandingsRow[]) => [...rows].sort((a, b) => a.rank! - b.rank!).map((r) => r.entrantId);

describe("I-1 a cut-line tie waiting on the organiser's pick shows no final verdict (W5 B3 fix; ruling 1)", () => {
  it("every sport: a lot-ordered class straddling the cut reads no marker until the pick; a class wholly above or below keeps its markers, and so does every row clear of it", () => {
    let swept = 0;
    let flaggedSports = 0;
    const seedSteps: string[] = [];
    for (const mod of builtinModules) {
      const cfg = declaredCfgs(mod)[0]!.cfg;
      const lead = engineScene(mod, cfg, LEADER_AND_CIRCLE);
      const top = engineScene(mod, cfg, CIRCLE_AND_TAIL);
      const v = (s: ReturnType<typeof engineScene>, cut: number, over: Partial<StageQualMeta> = {}) => {
        const out = buildQualificationView(sportInput(mod, cfg, s, cut, over));
        expect(out, `${mod.key}: premise - a finished table with a cut keeps a view (cut ${cut})`).not.toBeNull();
        const m = markers(out, FOUR);
        expect(Object.keys(m)).toHaveLength(4);
        return m;
      };
      swept++;
      // The engine's declaration decides whether the circle reaches the lot: a `seed` step in the declared order separates the
      // level sides by seed, so nothing is left unbroken and no pick is owed (the confirm asks nothing).
      if (lead.cascade.includes("seed")) {
        seedSteps.push(mod.key);
        expect(engineClasses(lead.rows), `${mod.key}: premise - a seed step leaves no unbroken class`).toEqual([]);
        const order = byRank(lead.rows);
        expect(v(lead, 2), `${mod.key}: no pick owed, the order's top 2 went through`).toEqual(
          Object.fromEntries(FOUR.map((id) => [id, order.indexOf(id) < 2 ? PICK.qualified : PICK.out])),
        );
        continue;
      }
      flaggedSports++;
      // premise, the engine's flags: B, C and D level on everything, ranked 2-4 by the lot; A, B and C likewise at 1-3
      expect(engineClasses(lead.rows), `${mod.key}: premise - B, C and D unbroken`).toEqual(["B,C,D"]);
      expect(byRank(lead.rows)[0], `${mod.key}: premise - A leads`).toBe("A");
      expect(lead.rows.find((r) => r.entrantId === "B")!.tieBreak?.key, `${mod.key}: premise - the lot ordered them`).toBe("lots");
      expect(engineClasses(top.rows), `${mod.key}: premise - A, B and C unbroken`).toEqual(["A,B,C"]);
      expect(byRank(top.rows)[3], `${mod.key}: premise - D last`).toBe("D");

      // the class wholly below the cut: every marker stands
      expect(v(lead, 1), `${mod.key}: cut 1, the class below it`).toEqual({ A: PICK.qualified, B: PICK.out, C: PICK.out, D: PICK.out });
      // the class wholly above the cut: every marker stands
      expect(v(top, 3), `${mod.key}: cut 3, the class above it`).toEqual({ A: PICK.qualified, B: PICK.qualified, C: PICK.qualified, D: PICK.out });
      // the class straddles the cut: its rows wait on the pick; the rows clear of it keep theirs
      expect(v(lead, 2), `${mod.key}: cut 2 crosses B, C, D`).toEqual({ A: PICK.qualified, B: "none", C: "none", D: "none" });
      expect(v(lead, 3), `${mod.key}: cut 3 crosses B, C, D`).toEqual({ A: PICK.qualified, B: "none", C: "none", D: "none" });
      expect(v(top, 2), `${mod.key}: cut 2 crosses A, B, C`).toEqual({ A: "none", B: "none", C: "none", D: PICK.out });
      // the pick confirmed: who went through wins, the lot's last-ranked included
      const lotLoser = byRank(lead.rows)[3]!;
      const picked = v(lead, 2, { qualified: ["A", lotLoser] });
      expect(picked, `${mod.key}: the pick sent ${lotLoser} through`).toEqual(
        Object.fromEntries(FOUR.map((id) => [id, id === "A" || id === lotLoser ? PICK.qualified : PICK.out])),
      );
    }
    expect(swept, "every builtin sport").toBe(builtinModules.length);
    expect(flaggedSports, "anti-vacuity: sports whose declared order reaches the lot").toBeGreaterThan(0);
    // The engine's declarations: the sports whose league default lists `seed` (a change in the engine moves this pin).
    expect(seedSteps.sort()).toEqual(builtinModules.filter((m) => m.defaultTiebreakers("league", declaredCfgs(m)[0]!.cfg as never).includes("seed")).map((m) => m.key).sort());
    expect(flaggedSports + seedSteps.length).toBe(swept);
  });

  it("the cut line stays where the cut is while the pick is owed; the line still says how many places went through", () => {
    const lead = engineScene(GENERIC, CFG, LEADER_AND_CIRCLE);
    const v = buildQualificationView(sportInput(GENERIC, CFG, lead, 2))!;
    expect(v.table.cutIndex).toBe(2);
    expect(v.table.label).toBe(PICK.wentThrough2);
    expect(v.table.legend.open, "finished: nothing is still open").toBeNull();
  });

  it("a guard, not a comment: a row marked unbroken with no class named fails closed while the order is the only source", () => {
    // `tieUnbroken` is only ever written WITH a `tieBreak` (engine tiebreakers.js; lib/table-withdrawal.ts relies on it too).
    // A row that breaks that cannot say whom it is level with, so whether its tie crosses the cut is unknown: no view (R3).
    const lead = engineScene(GENERIC, CFG, LEADER_AND_CIRCLE);
    const untraced = (r: StandingsRow): StandingsRow => {
      const bare = { ...r };
      delete bare.tieBreak;
      return bare;
    };
    const broken = { ...lead, rows: lead.rows.map((r) => (r.entrantId === "D" ? untraced(r) : r)) };
    expect(broken.rows.find((r) => r.entrantId === "D")!.tieUnbroken, "premise: D still marked unbroken").toBe(true);
    expect(buildQualificationView(sportInput(GENERIC, CFG, broken, 1)), "the order cannot be trusted").toBeNull();
    // who went through is known: the order is not read, so the malformed trace changes nothing
    const seated = markers(buildQualificationView(sportInput(GENERIC, CFG, broken, 1, { qualified: ["A"] })), FOUR);
    expect(seated).toEqual({ A: PICK.qualified, B: PICK.out, C: PICK.out, D: PICK.out });
  });

  it("the live table is unchanged: a straddling class with a line still to play reads the live race", () => {
    // the same circle with D v B still to play: nobody's verdict is frozen, the live race answers as it did before
    const lead = engineScene(GENERIC, CFG, LEADER_AND_CIRCLE.slice(0, 5));
    const fixtures = [...lead.fixtures, { ...fx(6, "D", "B", null) }];
    const v = buildQualificationView({ ...sportInput(GENERIC, CFG, { ...lead, fixtures }, 2) });
    expect(v, "premise: a live view").not.toBeNull();
    expect(v!.table.legend.open).toBe("Still open");
    expect(Object.values(v!.rows).map((r) => r.label)).not.toContain(PICK.qualified);
  });
});
