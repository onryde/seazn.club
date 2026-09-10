// B06a Task 3 — `expected.matches` was declared by PackSchema from B02 and
// read by NOTHING at run time. Stage 0 folds each stream offline and compares
// the fold to the pack's expected outcome; the seeded HTTP run never asked the
// product what it decided. So the one oracle a pack author would assume exists
// — "did the real result come out?" — did not.
//
// The comparison is on the OUTCOME, not on a scoreline:
// `GET /api/v1/divisions/{id}/fixtures` carries no score field at all. It
// returns `outcome` (jsonb, typed `z.unknown().nullable()` on the wire) plus
// `status` and `round_no`, and the engine's `MatchOutcome` is a discriminated
// union on `kind` — win/draw/tie/no_result/award. Scorelines exist only where
// a pack declares `perSide`, and come from the fixture STATE route.
import { describe, expect, it } from "vitest";
import { compareMatches } from "../oracle.ts";

const won = (winner: string, loser: string, method?: string) =>
  ({ kind: "win" as const, winner, loser, ...(method === undefined ? {} : { method }) });

describe("compareMatches", () => {
  it("passes when the declared outcome matches the live one", () => {
    const r = compareMatches(
      [{ fixtureExtKey: "f1", outcome: won("e1", "e2") }],
      [{ extKey: "f1", status: "decided", roundNo: 1, outcome: won("e1", "e2") }],
    );
    expect(r.checked).toBe(1);
    expect(r.mismatches).toEqual([]);
  });

  it("catches the reversed winner and names the field", () => {
    const r = compareMatches(
      [{ fixtureExtKey: "f1", outcome: won("e1", "e2") }],
      [{ extKey: "f1", status: "decided", roundNo: 1, outcome: won("e2", "e1") }],
    );
    expect(r.mismatches).toEqual([
      { fixtureExtKey: "f1", field: "winner", expected: "e1", actual: "e2" },
    ]);
  });

  it("catches a draw served where a win was expected", () => {
    const r = compareMatches(
      [{ fixtureExtKey: "f1", outcome: won("e1", "e2") }],
      [{ extKey: "f1", status: "decided", roundNo: 1, outcome: { kind: "draw" } }],
    );
    expect(r.mismatches[0]).toMatchObject({ field: "outcome", expected: "win", actual: "draw" });
  });

  it("catches a method mismatch only where the pack declares one", () => {
    const declared = compareMatches(
      [{ fixtureExtKey: "f1", outcome: won("e1", "e2", "shootout") }],
      [{ extKey: "f1", status: "decided", roundNo: 1, outcome: won("e1", "e2", "regulation") }],
    );
    expect(declared.mismatches[0]).toMatchObject({ field: "method", expected: "shootout", actual: "regulation" });

    // A pack that declares no method is not asserting one — the live value is
    // free to be anything, including absent.
    const undeclared = compareMatches(
      [{ fixtureExtKey: "f1", outcome: won("e1", "e2") }],
      [{ extKey: "f1", status: "decided", roundNo: 1, outcome: won("e1", "e2", "extra_time") }],
    );
    expect(undeclared.mismatches).toEqual([]);
  });

  it("treats an undecided fixture as a status mismatch, never as absent", () => {
    const r = compareMatches(
      [{ fixtureExtKey: "f1", outcome: won("e1", "e2") }],
      [{ extKey: "f1", status: "scheduled", roundNo: 1, outcome: null }],
    );
    expect(r.checked).toBe(1);
    expect(r.mismatches[0]).toMatchObject({ field: "status", actual: "scheduled" });
  });

  it("treats a declared fixture the live board never returned as a mismatch", () => {
    // Not "absent, therefore skipped" — a fixture that vanished between
    // seeding and the read-back is exactly the defect this oracle exists for.
    const r = compareMatches([{ fixtureExtKey: "f1", outcome: won("e1", "e2") }], []);
    expect(r.checked).toBe(1);
    expect(r.mismatches[0]).toMatchObject({ fixtureExtKey: "f1", field: "status", actual: "(absent)" });
  });

  it("refuses an outcome jsonb that does not parse as a MatchOutcome", () => {
    // A jsonb column written as a JSON *string* parses to a scalar, and every
    // field read off it then yields undefined — which would compare as a
    // silent match against an expected `undefined`. Parsing through the
    // engine's own union is what makes that impossible.
    const r = compareMatches(
      [{ fixtureExtKey: "f1", outcome: won("e1", "e2") }],
      [{ extKey: "f1", status: "decided", roundNo: 1, outcome: "win" }],
    );
    expect(r.mismatches[0]).toMatchObject({ field: "outcome", actual: "(unparseable)" });
  });

  it("compares perSide lines only where the pack declares them", () => {
    const r = compareMatches(
      [
        {
          fixtureExtKey: "f1",
          outcome: won("e1", "e2"),
          perSide: [
            { entrant: "e1", line: "7" },
            { entrant: "e2", line: "3" },
          ],
        },
      ],
      [
        {
          extKey: "f1",
          status: "decided",
          roundNo: 1,
          outcome: won("e1", "e2"),
          perSide: [
            { entrant: "e1", line: "7" },
            { entrant: "e2", line: "2" },
          ],
        },
      ],
    );
    expect(r.mismatches).toEqual([
      { fixtureExtKey: "f1", field: "line", expected: "e2:3", actual: "e2:2" },
    ]);
  });

  it("groups the count by round so a knockout reports per round", () => {
    const r = compareMatches(
      [
        { fixtureExtKey: "f1", outcome: won("e1", "e2") },
        { fixtureExtKey: "f2", outcome: won("e3", "e4") },
      ],
      [
        { extKey: "f1", status: "decided", roundNo: 1, outcome: won("e1", "e2") },
        { extKey: "f2", status: "decided", roundNo: 2, outcome: won("e4", "e3") },
      ],
    );
    expect(r.byRound).toEqual([
      { roundNo: 1, checked: 1, mismatched: 0 },
      { roundNo: 2, checked: 1, mismatched: 1 },
    ]);
  });

  it("reports zero checked when the pack declares no matches — never a silent pass", () => {
    expect(compareMatches([], []).checked).toBe(0);
  });
});
