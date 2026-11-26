// W5 follow-ups C (owner 2026-11-23, Option A "by round"): the organiser's run sheet for a big division ships the rounds a person
// reads now and every other round of a league or group stage as a TALLY. The scenes are the perf report's cap shapes, generated here:
// groups 512 in 26 pools (4,788 lines, as measured) and a 71-team double league (4,970). Every expected value is counted off the scene
// - which rounds it played, which rows it holds - never off the windowing code.
import { describe, expect, it } from "vitest";
import { foldedRoundOf, foldedRoundShows, foldedTally, windowRunSheet, withFoldedRounds, type PagedRunSheetRow } from "../run-sheet-paging";
import { ROUND_PAGING_MIN_FIXTURES } from "../round-paging";
import { FIXTURE_STATUSES } from "../fixture-status";
import { buildRunSheet, roundDone, roundUnderWay, stageRoundSections, type RunSheetFixture } from "../run-sheet-groups";
import { stageCounts } from "../stage-card/summaries";
import { isResultMissing } from "../division-phase";

const NOW = Date.UTC(2026, 10, 23, 12, 0);
const DAY = 86_400_000;
type Row = PagedRunSheetRow & { pool_id: string | null; seq_in_round: number };
let n = 0;
const row = (stage: string, pool: string | null, round: number, seq: number, status: string, at: number | null, extra: Partial<Row> = {}): Row => ({
  id: `f${++n}`, stage_id: stage, pool_id: pool, round_no: round, seq_in_round: seq, status, scheduled_at: at === null ? null : new Date(at).toISOString(),
  outcome: status === "decided" ? { winner: "a" } : null, home_entrant_id: `h${n}`, away_entrant_id: `a${n}`, home_slot_label: null, away_slot_label: null,
  ext_key: null, ...extra,
});

/** One pool's single round robin (circle method): `size` entrants, an odd field sitting one out a round. */
function poolRounds(size: number): number[] {
  const even = size % 2 === 0 ? size : size + 1;
  return Array.from({ length: even - 1 }, () => Math.floor(size / 2));
}
/** Round r is played (decided, a week ago) through `played`, then scheduled a week per round ahead - nothing owed, nothing today. */
const statusOf = (round: number, played: number) => (round <= played ? "decided" : "scheduled");
const timeOf = (round: number, played: number) => (round <= played ? NOW - (played - round + 7) * DAY : NOW + (round - played + 7) * DAY);

function groups512(played = 9) {
  n = 0;
  const sizes = [...Array(18).fill(20), ...Array(8).fill(19)] as number[];
  const fixtures: Row[] = [];
  sizes.forEach((size, p) => poolRounds(size).forEach((matches, r) => {
    for (let s = 1; s <= matches; s++) fixtures.push(row("grp", `pool${p}`, r + 1, s, statusOf(r + 1, played), timeOf(r + 1, played)));
  }));
  return fixtures;
}
function doubleLeague71(played = 71) {
  n = 0;
  const fixtures: Row[] = [];
  for (let r = 1; r <= 142; r++) for (let s = 1; s <= 35; s++) fixtures.push(row("lg", null, r, s, statusOf(r, played), timeOf(r, played)));
  return fixtures;
}
const ctx = { held: new Set<string>(), nowMs: NOW, tz: "UTC" };
const roundsOf = (rows: readonly Row[]) => [...new Set(rows.map((f) => f.round_no))].sort((a, b) => a - b);

describe("C: a big run sheet ships its open rounds and a tally of the rest", () => {
  it("premise: the generated scenes are the measured cap shapes, over the paging line", () => {
    expect(groups512().length).toBe(4788);
    expect(doubleLeague71().length).toBe(4970);
    expect(ROUND_PAGING_MIN_FIXTURES).toBeLessThan(4788);
  });

  it("groups 512, nine rounds played: round 10 (the next) ships, every other round is a tally, and the payload is a fraction", () => {
    const all = groups512(9);
    const { shipped, folded } = windowRunSheet(all, [{ id: "grp", kind: "group" }], ctx);
    expect(roundsOf(shipped), "only the next round ships").toEqual([10]);
    expect(shipped.length).toBe(all.filter((f) => f.round_no === 10).length);
    expect(folded.map((r) => r.round)).toEqual(roundsOf(all).filter((r) => r !== 10));
    // No folded round's row rides along.
    const foldedIds = new Set(all.filter((f) => f.round_no !== 10).map((f) => f.id));
    expect(shipped.filter((f) => foldedIds.has(f.id)).length).toBe(0);
    // The size bar's stand-in: the serialised props are under a tenth of the whole list.
    const before = JSON.stringify(all).length;
    const after = JSON.stringify({ shipped, folded }).length;
    expect(after / before, `${after} of ${before} bytes`).toBeLessThan(0.1);
  });

  it("double league 71, half played: round 72 ships (35 rows), 141 rounds fold, and the payload is a fraction", () => {
    const all = doubleLeague71(71);
    const { shipped, folded } = windowRunSheet(all, [{ id: "lg", kind: "league" }], ctx);
    expect(roundsOf(shipped)).toEqual([72]);
    expect(shipped.length).toBe(35);
    expect(folded.length).toBe(141);
    expect(JSON.stringify({ shipped, folded }).length / JSON.stringify(all).length).toBeLessThan(0.1);
  });

  it("a folded round's tally is the same figures the card and the bar compute over its rows", () => {
    const all = doubleLeague71(71);
    const { folded } = windowRunSheet(all, [{ id: "lg", kind: "league" }], ctx);
    let checked = 0;
    for (const r of folded) {
      const own = all.filter((f) => f.round_no === r.round);
      const bar = roundDone(own as unknown as RunSheetFixture[], ctx.held);
      expect({ done: r.done, total: r.total, rows: r.rows, counts: r.counts }).toEqual({ ...bar, rows: own.length, counts: stageCounts(own) });
      expect(r.unscheduled, "every row has a time").toBe(0);
      expect(r.played).toBe(own.filter((f) => f.status === "decided").length);
      checked += 1;
    }
    expect(checked).toBe(141);
    const t = foldedTally(folded, "lg");
    expect(t.rows + 35).toBe(all.length);
    expect(t.done).toBe(all.filter((f) => f.status === "decided").length);
    expect(foldedTally(folded, "other").rows, "another stage's tally is its own").toBe(0);
  });

  it("an organiser's attention opens a folded round: a held match, a settle owed, a match today, a live match (the only kind that can owe a result)", () => {
    const cases: [string, (rows: Row[]) => void, Partial<typeof ctx>?][] = [
      ["needs_decision", (rows) => { rows[0]!.status = "needs_decision"; }],
      // A held id alone, on a row left as it was (to come, weeks away): only the `held` set can open this round. A played row would
      // move the frontier to round 120 and open it as the current round, which hides the clause (measured: the mutant survived).
      ["awaiting settle", () => {}, {}],
      ["timed today", (rows) => { rows[0]!.scheduled_at = new Date(NOW + 3 * 3_600_000).toISOString(); }],
      ["live", (rows) => { rows[0]!.status = "in_play"; }],
    ];
    let checked = 0;
    for (const [name, mutate] of cases) {
      const all = doubleLeague71(71);
      const target = all.filter((f) => f.round_no === 120);
      mutate(target);
      const held = name === "awaiting settle" ? new Set([target[0]!.id]) : new Set<string>();
      const { shipped, folded } = windowRunSheet(all, [{ id: "lg", kind: "league" }], { ...ctx, held });
      expect(roundsOf(shipped), name).toContain(120);
      expect(folded.some((r) => r.round === 120), name).toBe(false);
      checked += 1;
    }
    expect(checked).toBe(4);
  });

  // The "Needs result" chip counts only SHIPPED rows, so every row the predicate could name must ship. And since the
  // 2026-11-26 ruling a never-started match past its slot is not work: its round folds like any other.
  it("every row that owes a result ships its round; a never-started row days past its slot opens nothing", () => {
    const twoDaysAgo = new Date(NOW - 2 * DAY).toISOString();
    let owed = 0;
    let checked = 0;
    for (const status of FIXTURE_STATUSES) {
      const all = doubleLeague71(71);
      const target = all.filter((f) => f.round_no === 120)[0]!;
      target.status = status;
      target.scheduled_at = twoDaysAgo;
      const { shipped } = windowRunSheet(all, [{ id: "lg", kind: "league" }], ctx);
      if (isResultMissing({ status, startedAt: null, scheduledAt: twoDaysAgo, matchMinutes: 60 }, NOW)) {
        expect(roundsOf(shipped), status).toContain(120);
        owed += 1;
      }
      if (status === "scheduled") expect(roundsOf(shipped), "never started: folds").not.toContain(120);
      checked += 1;
    }
    expect(checked).toBe(FIXTURE_STATUSES.length);
    expect(owed, "anti-vacuity: at least one status can owe").toBeGreaterThan(0);
  });

  it("a void (cancelled) round folds as finished, and its void counts as done", () => {
    const all = doubleLeague71(71);
    for (const f of all.filter((x) => x.round_no === 30)) f.status = "cancelled";
    const { folded } = windowRunSheet(all, [{ id: "lg", kind: "league" }], ctx);
    const r30 = folded.find((r) => r.round === 30)!;
    expect(r30).toMatchObject({ rows: 35, done: 35, total: 35, played: 35 });
  });

  it("everything finished: the last round ships, the other 141 fold", () => {
    const all = doubleLeague71(142);
    const { shipped, folded } = windowRunSheet(all, [{ id: "lg", kind: "league" }], ctx);
    expect(roundsOf(shipped)).toEqual([142]);
    expect(folded.length).toBe(141);
  });

  it("nothing folds in a small division, an empty one, or a stage that is not a league or a group (Swiss, knockout)", () => {
    const small = doubleLeague71(71).slice(0, ROUND_PAGING_MIN_FIXTURES);
    expect(windowRunSheet(small, [{ id: "lg", kind: "league" }], ctx).folded).toEqual([]);
    expect(windowRunSheet([], [{ id: "lg", kind: "league" }], ctx)).toEqual({ shipped: [], folded: [] });
    let kinds = 0;
    for (const kind of ["swiss", "knockout", "americano", "ladder"]) {
      const all = doubleLeague71(71);
      const w = windowRunSheet(all, [{ id: "lg", kind }], ctx);
      expect(w.folded, kind).toEqual([]);
      expect(w.shipped.length, kind).toBe(all.length);
      kinds += 1;
    }
    expect(kinds).toBe(4);
  });

  it("a folded bar answers All and Unscheduled from its tally, never Needs result or Today", () => {
    const untimed = foldedRoundOf("lg", 9, [row("lg", null, 9, 1, "scheduled", null)], new Set());
    expect(untimed.unscheduled).toBe(1);
    expect(["all", "unscheduled", "needs_result", "today"].map((f) => foldedRoundShows(untimed, f))).toEqual([true, true, false, false]);
    const timed = foldedRoundOf("lg", 9, [row("lg", null, 9, 1, "scheduled", NOW + 9 * DAY)], new Set());
    expect(foldedRoundShows(timed, "unscheduled")).toBe(false);
  });

  it("folded rounds go back among the sections by kickoff, untimed last, round breaking ties; a loaded round is not doubled", () => {
    const at = (d: number) => new Date(NOW + d * DAY).toISOString();
    const sections = [{ round: 2, fixtures: [{ scheduled_at: at(2) }], underWay: false }, { round: 5, fixtures: [{ scheduled_at: null }], underWay: false }];
    const folded = [
      foldedRoundOf("lg", 1, [row("lg", null, 1, 1, "decided", NOW - DAY)], new Set()),
      foldedRoundOf("lg", 3, [row("lg", null, 3, 1, "scheduled", NOW + 3 * DAY)], new Set()),
      foldedRoundOf("lg", 4, [row("lg", null, 4, 1, "scheduled", null)], new Set()),
      foldedRoundOf("lg", 2, [row("lg", null, 2, 1, "scheduled", NOW + 2 * DAY)], new Set()),
    ];
    const merged = withFoldedRounds(sections, folded, new Set([2]));
    expect(merged.map((s) => [s.round, "folded" in s])).toEqual([[1, true], [2, false], [3, true], [4, true], [5, false]]);
    expect(withFoldedRounds([], [], new Set())).toEqual([]);
  });
});

// Task 51 (owner 2026-11-25): a round already under way keeps its number's place when it has no kickoff times. The folded summary DOES
// carry what the rule needs - `foldedRoundOf` answers it from the same predicate the loaded section uses (`roundUnderWay`) - so folded
// untimed rounds follow the rule too, and the loaded and folded readings of one scene must give ONE order (`stageRoundSections` vs
// `withFoldedRounds`). Expected orders are written from the rule, never read off the sorter.
describe("task 51: a folded or loaded round under way keeps its place with no kickoff times", () => {
  const none = new Set<string>();
  // A full run-sheet row (the paging `row` carries the fields the folded tally reads; the grouping reads the rest).
  const full = (round: number, status: string, when: number | null, extra: Partial<Row> = {}) =>
    ({ ...row("lg", null, round, 1, status, when === null ? null : NOW + when * DAY, extra), court_name: null, court_id: null, venue_name: null, officials: [], lane: null, is_final: false, third_place: false, conditional: false }) as unknown as RunSheetFixture;
  const section = (round: number, status: string, when: number | null) => {
    const rows = [full(round, status, when)];
    return { round, fixtures: rows, underWay: status !== "scheduled" };
  };
  const foldedOf = (round: number, status: string, when: number | null) => foldedRoundOf("lg", round, [full(round, status, when)], none);
  const order = (merged: { round: number }[]) => merged.map((s) => s.round);

  it("the empty case: no rounds, nothing to put back", () => {
    expect(withFoldedRounds([], [], new Set<number>())).toEqual([]);
  });

  it("foldedRoundOf: under way exactly when a counted line has a result or is in play - every status swept, a bye alone is not", () => {
    let checked = 0;
    let underWay = 0;
    for (const status of FIXTURE_STATUSES) {
      expect(foldedOf(1, status, null).underWay, status).toBe(status !== "scheduled");
      checked++;
      if (status !== "scheduled") underWay++;
    }
    expect(checked, "every status swept").toBe(FIXTURE_STATUSES.length);
    expect(underWay, "anti-vacuity: both answers are reached").toBeGreaterThan(0);
    expect(underWay).toBeLessThan(FIXTURE_STATUSES.length);
    const award = { kind: "award", winner: "h1", loser: null, reason: "bye" };
    const byeOnly = foldedRoundOf("lg", 1, [row("lg", null, 1, 1, "forfeited", null, { away_entrant_id: null, outcome: award })], none);
    expect(byeOnly.underWay, "a bye settled at the draw is no match started").toBe(false);
    expect(foldedRoundOf("lg", 1, [], none).underWay, "no rows, nothing started").toBe(false);
  });

  // Fix round 1 (M3). INTENDED: a held (awaiting-settle) id never changes whether a round is under way, so the loaded section (no held ids)
  // and the folded tally (which has them) are one reading. Held ids only move a settled row from "played" to "inPlay" in the tally's counts.
  it("held changes nothing: the folded verdict is the same with every row held, with none held, and as the loaded reading, for every status", () => {
    let checked = 0;
    for (const status of FIXTURE_STATUSES) {
      const rows = [full(1, status, null)];
      const held = new Set(rows.map((r) => r.id));
      const loaded = roundUnderWay(rows);
      expect(foldedRoundOf("lg", 1, rows as unknown as PagedRunSheetRow[], held).underWay, `${status}: held`).toBe(loaded);
      expect(foldedRoundOf("lg", 1, rows as unknown as PagedRunSheetRow[], none).underWay, `${status}: not held`).toBe(loaded);
      expect(loaded, status).toBe(status !== "scheduled");
      checked++;
    }
    expect(checked, "every status swept").toBe(FIXTURE_STATUSES.length);
  });

  it("folded untimed Round 1 with results sits first, ahead of a loaded timed Round 2 and a folded timed Round 3; with nothing started it goes last", () => {
    const loaded = [section(2, "scheduled", 2)];
    const started = withFoldedRounds(loaded, [foldedOf(1, "decided", null), foldedOf(3, "scheduled", 3)], new Set([2]));
    expect(order(started)).toEqual([1, 2, 3]);
    expect(started.map((s) => "folded" in s)).toEqual([true, false, true]);
    const waiting = withFoldedRounds(loaded, [foldedOf(1, "scheduled", null), foldedOf(3, "scheduled", 3)], new Set([2]));
    expect(order(waiting)).toEqual([2, 3, 1]);
  });

  it("a LOADED untimed round under way reads in its number's place among folded timed rounds", () => {
    const merged = withFoldedRounds([section(1, "in_play", null)], [foldedOf(2, "scheduled", 2), foldedOf(3, "scheduled", 1)], new Set([1]));
    expect(order(merged), "Round 1 precedes every higher round; Round 3 kicks off before Round 2 and keeps that").toEqual([1, 3, 2]);
  });

  it("the loaded reading and the folded reading of ONE scene give ONE order: the owner's four rounds, and the earlier-kicking Round 3", () => {
    let checked = 0;
    const scenes: { name: string; rows: RunSheetFixture[]; expected: number[] }[] = [
      {
        name: "owner's case",
        rows: [full(1, "decided", null), full(1, "in_play", null), full(2, "scheduled", 2), full(3, "scheduled", 3), full(4, "scheduled", 4)],
        expected: [1, 2, 3, 4],
      },
      {
        name: "Round 3 kicks off before Round 2",
        rows: [full(1, "decided", null), full(2, "scheduled", 4), full(3, "scheduled", 2)],
        expected: [1, 3, 2],
      },
      {
        name: "nothing started",
        rows: [full(1, "scheduled", null), full(2, "scheduled", 4), full(3, "scheduled", 2)],
        expected: [3, 2, 1],
      },
    ];
    for (const scene of scenes) {
      const stages = [{ id: "lg", seq: 1, kind: "league" }];
      const blocksOf = (rows: RunSheetFixture[]) => buildRunSheet({ fixtures: rows, stages, tz: "UTC", nowMs: NOW });
      const allLoaded = stageRoundSections(blocksOf(scene.rows), "lg").map((s) => s.round);
      // Fold every round but the LAST one (the loaded one), as the page does for a big division.
      const keep = Math.max(...scene.rows.map((f) => f.round_no));
      const shipped = scene.rows.filter((f) => f.round_no === keep);
      const foldedRounds = [...new Set(scene.rows.map((f) => f.round_no))].filter((r) => r !== keep).map((r) => foldedRoundOf("lg", r, scene.rows.filter((f) => f.round_no === r) as unknown as PagedRunSheetRow[], none));
      const windowed = order(withFoldedRounds(stageRoundSections(blocksOf(shipped), "lg"), foldedRounds, new Set()));
      expect(allLoaded, `${scene.name}: every round loaded`).toEqual(scene.expected);
      expect(windowed, `${scene.name}: every round but one folded`).toEqual(scene.expected);
      checked++;
    }
    expect(checked, "every scene read both ways").toBe(3);
  });
});
