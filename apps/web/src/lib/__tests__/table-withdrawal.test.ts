// The ONE reading of DB fixture rows into the table withdrawal policy's input
// (spec 05 §5). Shared by the cascade that applies the policy
// (usecases/withdrawal.ts, DB-covered by withdrawal.test.ts) and the
// qualification builder that must predict it (ruling F1) — so the status sets
// and the opponent resolution are pinned here, where both readers meet.
import { describe, expect, it } from "vitest";
import { withdrawTableEntrant } from "@seazn/engine/competition";
import {
  WITHDRAWAL_PENDING_STATUSES,
  WITHDRAWAL_PLAYED_STATUSES,
  countsAsPlayed,
  departedRankedLast,
  tableWithdrawalInputs,
  type WithdrawalFixtureRow,
} from "../table-withdrawal";

const f = (id: string, status: string, home: string | null, away: string | null, outcome: unknown = null): WithdrawalFixtureRow => ({
  id,
  status,
  home_entrant_id: home,
  away_entrant_id: away,
  outcome,
});
const WIN = { kind: "win", winner: "A", loser: "B" };

describe("tableWithdrawalInputs", () => {
  it("pins the two status sets", () => {
    expect([...WITHDRAWAL_PLAYED_STATUSES].sort()).toEqual(["decided", "finalized", "forfeited"]);
    expect([...WITHDRAWAL_PENDING_STATUSES].sort()).toEqual(["in_play", "scheduled"]);
  });
  it("played = a played status WITH a result; pending = scheduled/in play; void is neither", () => {
    const { played, pending } = tableWithdrawalInputs("A", [
      f("1", "decided", "A", "B", WIN),
      f("2", "finalized", "C", "A", WIN),
      f("3", "forfeited", "A", "D", { kind: "award", winner: "D" }),
      f("4", "decided", "A", "E", null), // no result yet: not played
      f("5", "scheduled", "A", "F"),
      f("6", "in_play", "G", "A"),
      f("7", "cancelled", "A", "H"),
      f("8", "abandoned", "A", "I"),
    ]);
    expect(played.map((x) => x.id)).toEqual(["1", "2", "3"]);
    expect(played.every((x) => x.status === "decided")).toBe(true);
    expect(pending).toEqual([
      { id: "5", opponent: "F" },
      { id: "6", opponent: "G" },
    ]);
  });
  // B3 fix wave (I-5, RB5-W2/W4): an ABANDONED line that still carries an outcome (a cricket no result, a football award-policy
  // abandon - shaped so before W2b D7 moved such a line to `decided`) is a result she played: counted, and removed under half.
  // One with no outcome stays neither (X-AB-1: it never reached the table). differential: today the first is neither.
  it("an abandoned line WITH an outcome is played; one without stays neither (countsAsPlayed is the one reading)", () => {
    const NR = { kind: "no_result" };
    const rows = [f("1", "abandoned", "A", "B", NR), f("2", "abandoned", "C", "A", null), f("3", "scheduled", "A", "D")];
    const { played, pending } = tableWithdrawalInputs("A", rows);
    expect(played.map((x) => x.id)).toEqual(["1"]);
    expect(pending.map((x) => x.id)).toEqual(["3"]);
    expect(rows.map(countsAsPlayed)).toEqual([true, false, false]);
    // Every played status still needs its result (a decided row with no outcome is not played).
    expect([f("4", "decided", "A", "E", null), f("5", "finalized", "A", "E", WIN)].map(countsAsPlayed)).toEqual([false, true]);
  });
  it("feeds the engine's mode: under 50% played expunges, half or more awards", () => {
    const stage = { id: "S", kind: "league" as const, entrants: ["A"], cascade: [] };
    const mode = (rows: WithdrawalFixtureRow[]) => {
      const e = withdrawTableEntrant(stage, "A", tableWithdrawalInputs("A", rows)).events[0];
      return e?.type === "entrant_withdrawn" ? e.mode : undefined;
    };
    expect(mode([f("1", "decided", "A", "B", WIN), f("2", "scheduled", "A", "C"), f("3", "scheduled", "D", "A")])).toBe("expunge");
    expect(mode([f("1", "decided", "A", "B", WIN), f("2", "decided", "C", "A", WIN), f("3", "scheduled", "D", "A")])).toBe("award");
  });
});

// W5 T8 (RB5-W1, X-WDT-7): a departed entrant stays in the table and ranks last, whatever her points. The order AMONG the
// competing rows, and among the departed ones, is the engine's (its stored ranks, ties kept); only the split moves.
describe("departedRankedLast", () => {
  const r = (entrantId: string, rank: number | undefined) => ({ entrantId, rank });
  const gone = (...ids: string[]) => (id: string) => ids.includes(id);
  it("the leaver with the most points goes from first to last; the rest close up", () => {
    expect(departedRankedLast([r("a", 1), r("b", 2), r("c", 3), r("d", 4)], gone("a"))).toEqual([r("b", 1), r("c", 2), r("d", 3), r("a", 4)]);
  });
  it("two leavers keep their own order below the field; a tie among the field stays a tie", () => {
    expect(departedRankedLast([r("a", 1), r("b", 2), r("c", 2), r("d", 4), r("e", 5)], gone("d", "a"))).toEqual([
      r("b", 1), r("c", 1), r("e", 3), r("a", 4), r("d", 5),
    ]);
  });
  it("nobody left, an empty table, or an unranked row: the rows as they came", () => {
    const field = [r("b", 2), r("a", 1)];
    expect(departedRankedLast(field, gone())).toEqual(field);
    expect(departedRankedLast([], gone("a"))).toEqual([]);
    const unranked = [r("a", 1), r("b", undefined)];
    expect(departedRankedLast(unranked, gone("a"))).toEqual(unranked);
  });
});

// W5 final fix wave (G1; whole-PR review I1): the re-rank moves rows across the departed boundary, so the TIE NOTES the engine
// wrote for the pre-move table must move with them. A competing row never names a leaver ("Tied with P1" on a table P1 is
// ranked last on is false: her departure, not a tie-break, is why she is below), and a leaver carries no tie at all (cutEligiblePools'
// rule). Expected values come from the rule, written by hand per case, never from the function under test.
describe("departedRankedLast: tie notes follow the re-rank (I1)", () => {
  type Row = { entrantId: string; rank: number; tieUnbroken?: boolean; tieBreak?: { key: string; with: string[]; note?: string; drawnAt?: string } };
  const tied = (entrantId: string, rank: number, key: string, others: string[], extra: Partial<Row> = {}): Row => ({ entrantId, rank, tieBreak: { key, with: others }, ...extra });
  const gone = (...ids: string[]) => (id: string) => ids.includes(id);
  const byId = (rows: Row[], id: string): Row => {
    const row = rows.find((x) => x.entrantId === id);
    if (!row) throw new Error(`no row ${id}`);
    return row;
  };

  it("a leaver level on points with a competitor: neither row names the other any more", () => {
    // P1 beat P4 head-to-head, so the engine ranked P1 first and wrote the split on both rows.
    const out = departedRankedLast([tied("P1", 1, "head_to_head", ["P4"]), tied("P4", 2, "head_to_head", ["P1"]), { entrantId: "P2", rank: 3 }, { entrantId: "P3", rank: 4 }], gone("P1"));
    expect(out.map((r) => [r.entrantId, r.rank])).toEqual([["P4", 1], ["P2", 2], ["P3", 3], ["P1", 4]]);
    expect(byId(out, "P4").tieBreak).toBeUndefined();
    expect(byId(out, "P1").tieBreak).toBeUndefined();
    expect(out.filter((r) => r.tieBreak !== undefined || r.tieUnbroken !== undefined).length).toBe(0);
  });

  it("a three-way tie where one leaves: the two who stay still name each other, and only each other", () => {
    const out = departedRankedLast(
      [tied("A", 1, "head_to_head", ["B", "C"]), tied("B", 2, "head_to_head", ["A", "C"]), tied("C", 3, "head_to_head", ["A", "B"]), { entrantId: "D", rank: 4 }],
      gone("A"),
    );
    expect(byId(out, "B").tieBreak).toEqual({ key: "head_to_head", with: ["C"] });
    expect(byId(out, "C").tieBreak).toEqual({ key: "head_to_head", with: ["B"] });
    expect(byId(out, "A").tieBreak).toBeUndefined();
    expect(byId(out, "D").tieBreak).toBeUndefined();
    expect(byId(out, "A").rank).toBe(4);
  });

  it("a note keeps its other fields (note, drawnAt) while the leaver is stripped from its list", () => {
    const out = departedRankedLast(
      [
        { entrantId: "A", rank: 1, tieUnbroken: true, tieBreak: { key: "lots", with: ["B", "C"], drawnAt: "2026-11-01", note: "h2h_incomplete" } },
        { entrantId: "B", rank: 2, tieUnbroken: true, tieBreak: { key: "lots", with: ["A", "C"], drawnAt: "2026-11-01", note: "h2h_incomplete" } },
        { entrantId: "C", rank: 3, tieUnbroken: true, tieBreak: { key: "lots", with: ["A", "B"], drawnAt: "2026-11-01", note: "h2h_incomplete" } },
      ],
      gone("A"),
    );
    expect(byId(out as Row[], "B")).toEqual({ entrantId: "B", rank: 1, tieUnbroken: true, tieBreak: { key: "lots", with: ["C"], drawnAt: "2026-11-01", note: "h2h_incomplete" } });
  });

  it("a tie the engine could not break (tieUnbroken) goes with its only partner; it stays while a partner remains", () => {
    const pair = [tied("A", 1, "seed", ["B"], { tieUnbroken: true }), tied("B", 2, "seed", ["A"], { tieUnbroken: true }), { entrantId: "C", rank: 3 }];
    const out = departedRankedLast(pair, gone("A"));
    expect(byId(out, "B")).toEqual({ entrantId: "B", rank: 1 });
    expect(byId(out, "A")).toEqual({ entrantId: "A", rank: 3 });
    const trio = departedRankedLast(
      [tied("A", 1, "seed", ["B", "C"], { tieUnbroken: true }), tied("B", 2, "seed", ["A", "C"], { tieUnbroken: true }), tied("C", 3, "seed", ["A", "B"], { tieUnbroken: true })],
      gone("A"),
    );
    expect(byId(trio, "B").tieUnbroken).toBe(true);
    expect(byId(trio, "B").tieBreak?.with).toEqual(["C"]);
  });

  it("a leaver tied with another leaver carries no note, and neither does the competitor they were both tied with", () => {
    const out = departedRankedLast(
      [tied("A", 1, "head_to_head", ["B", "C"]), tied("B", 2, "head_to_head", ["A", "C"]), tied("C", 3, "head_to_head", ["A", "B"]), { entrantId: "D", rank: 4 }],
      gone("A", "B"),
    );
    expect(out.map((r) => [r.entrantId, r.rank])).toEqual([["C", 1], ["D", 2], ["A", 3], ["B", 4]]);
    expect(out.filter((r) => r.tieBreak !== undefined).length).toBe(0);
  });

  it("nobody left: a row's tie note is untouched (the rows as they came)", () => {
    const field = [tied("A", 1, "head_to_head", ["B"]), tied("B", 2, "head_to_head", ["A"])];
    expect(departedRankedLast(field, gone())).toEqual(field);
  });

  it("does not mutate its input rows", () => {
    const a = tied("A", 1, "head_to_head", ["B"]);
    const b = tied("B", 2, "head_to_head", ["A"]);
    departedRankedLast([a, b], gone("A"));
    expect(a.tieBreak).toEqual({ key: "head_to_head", with: ["B"] });
    expect(b.tieBreak).toEqual({ key: "head_to_head", with: ["A"] });
  });
});
