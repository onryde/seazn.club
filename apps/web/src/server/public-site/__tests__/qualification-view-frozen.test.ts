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
//
// single-sport (generic): the frozen markers read only who went through and the final order, which no sport field reaches; the
// wins-first sports (badminton, tennis, volleyball) differ only in the live race the freeze switches off, swept in
// qualification-view.test.ts.
import { describe, expect, it } from "vitest";
import { builtinModules } from "@seazn/engine/sports";
import { defaultOrderOf } from "@seazn/engine/testkit";
import en from "@/dictionaries/en/public.json";
import { plural, t, type TKey } from "@/lib/i18n-runtime";
import { QualRowView, QualTable } from "../competition-hub-schema";
import { buildQualificationView, divisionAwardAddsToLedger, divisionPointsBounds, type QualFixture, type QualificationViewInput, type StageQualMeta } from "../qualification-view";

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
