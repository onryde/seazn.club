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
import { compareMatches, outcomeLoserOf } from "../oracle.ts";
import type { PackExpectedOutcome } from "../pack-schema.ts";
import { resolveExpectedOutcome } from "../suites/run-suite.ts";
import type { MatchOutcome } from "@seazn/engine/core";

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

// B07a Task 2 — the comparator asked who WON and never who LOST. Swap an
// opponent and the same player still wins, so a fixture played by the wrong
// pair passed. B06's D4 said the bench asserts its own draw; nothing read
// round-0 pairings back, and the loser is the cheapest true check on one.
//
// Per the ENGINE's union (`packages/engine/src/core/types.ts:115`), `loser`
// lives on the `win` variant ALONE, while `method` is declared by BOTH `win`
// and `award` — so the method comparison, which fired only for `win`, was
// blind to a walkover recorded as a disqualification.
const awarded = (winner: string, method?: string) =>
  ({ kind: "award" as const, winner, ...(method === undefined ? {} : { method }) });

describe("compareMatches — the losing side", () => {
  const expected = [{ fixtureExtKey: "se-r0-i0", outcome: won("en-more", "en-lenus") }];

  it("reds when the right winner beat the wrong opponent", () => {
    const result = compareMatches(expected, [
      {
        extKey: "se-r0-i0",
        status: "finalized",
        roundNo: 0,
        outcome: won("en-more", "en-azmeen"),
      },
    ]);
    expect(result.mismatches).toHaveLength(1);
    expect(result.mismatches[0]).toMatchObject({
      field: "loser",
      expected: "en-lenus",
      actual: "en-azmeen",
    });
  });

  it("passes when both sides match — the positive pair", () => {
    const result = compareMatches(expected, [
      {
        extKey: "se-r0-i0",
        status: "finalized",
        roundNo: 0,
        outcome: won("en-more", "en-lenus"),
      },
    ]);
    expect(result.mismatches).toEqual([]);
    expect(result.checked).toBe(1);
  });

  it("asserts no loser for an outcome shape that has none — never reports `(none)`", () => {
    // A draw, a tie, a no_result and an award carry no losing side at all.
    // Reading the field off them regardless would report `(none)` against
    // every one of these, turning four correct results into four mismatches.
    //
    // This loop alone kills NOTHING (Minors row 10 / task-2-review.md Minor
    // 2, honestly labelled by the report as such): `expected` and `actual`
    // are the exact same `outcome` reference, so any DETERMINISTIC function
    // of it — including a broken `outcomeLoserOf` — produces the same value
    // on both sides and the comparator's `expectedLoser !== actualLoser`
    // guard never fires either way. Kept as an integration smoke check (it
    // does still prove the winner/method/line checks don't false-positive
    // on these shapes), but the loser-specific claim needs the direct call
    // below to actually be falsifiable.
    for (const outcome of [
      { kind: "draw" as const },
      { kind: "tie" as const },
      { kind: "no_result" as const },
      awarded("en-more"),
    ]) {
      const result = compareMatches(
        [{ fixtureExtKey: "se-r0-i0", outcome }],
        [{ extKey: "se-r0-i0", status: "finalized", roundNo: 0, outcome }],
      );
      expect(result.mismatches).toEqual([]);
    }
  });

  // Minors row 10 fix: a genuinely differential case. `MatchOutcome`'s zod
  // schema strips unknown keys on parse, so a "leaked" `loser` on a
  // non-"win" outcome can never survive `compareMatches`'s own
  // `MatchOutcome.safeParse` — which is exactly why the loop above cannot
  // witness a broken kind check. Calling `outcomeLoserOf` directly with a
  // hand-built object that bypasses that parse is the only way to prove the
  // ternary — not just "no property exists" — is what returns `undefined`.
  it("outcomeLoserOf ignores a loser field leaked onto a non-win outcome", () => {
    for (const kind of ["draw", "tie", "no_result", "award"] as const) {
      const leaked = {
        kind,
        winner: "en-more",
        loser: "en-leaked",
      } as unknown as MatchOutcome;
      expect(outcomeLoserOf(leaked)).toBeUndefined();
    }
    // The positive pair: a real "win" outcome's loser IS read through.
    expect(outcomeLoserOf(won("en-more", "en-lenus"))).toBe("en-lenus");
  });

  it("reports the winner first when BOTH sides are wrong — the order is the contract", () => {
    // status → outcome kind → winner → loser → method → line. A reader shown
    // "loser" for a match whose winner is also wrong is being pointed at the
    // second-most-useful fact, so the insertion point is pinned, not incidental.
    const result = compareMatches(
      [{ fixtureExtKey: "se-r0-i0", outcome: won("en-more", "en-lenus") }],
      [
        {
          extKey: "se-r0-i0",
          status: "finalized",
          roundNo: 0,
          outcome: won("en-azmeen", "en-more"),
        },
      ],
    );
    expect(result.mismatches[0]).toMatchObject({ field: "winner" });
  });

  it("reports the loser ahead of the method and the scoreline", () => {
    const result = compareMatches(
      [
        {
          fixtureExtKey: "se-r0-i0",
          outcome: won("en-more", "en-lenus", "regulation"),
          perSide: [{ entrant: "en-more", line: "3" }],
        },
      ],
      [
        {
          extKey: "se-r0-i0",
          status: "finalized",
          roundNo: 0,
          outcome: won("en-more", "en-azmeen", "shootout"),
          perSide: [{ entrant: "en-more", line: "2" }],
        },
      ],
    );
    expect(result.mismatches[0]).toMatchObject({ field: "loser" });
  });
});

describe("compareMatches — an award's method", () => {
  it("reds when a walkover is recorded with a different reason", () => {
    const result = compareMatches(
      [{ fixtureExtKey: "se-r1-i0", outcome: awarded("en-more", "walkover") }],
      [
        {
          extKey: "se-r1-i0",
          status: "forfeited",
          roundNo: 1,
          outcome: awarded("en-more", "disqualification"),
        },
      ],
    );
    expect(result.mismatches[0]).toMatchObject({
      field: "method",
      expected: "walkover",
      actual: "disqualification",
    });
  });

  it("passes when the award's reason matches — the positive pair", () => {
    const result = compareMatches(
      [{ fixtureExtKey: "se-r1-i0", outcome: awarded("en-more", "walkover") }],
      [
        {
          extKey: "se-r1-i0",
          status: "forfeited",
          roundNo: 1,
          outcome: awarded("en-more", "walkover"),
        },
      ],
    );
    expect(result.mismatches).toEqual([]);
    expect(result.checked).toBe(1);
  });

  it("reds when the live award carries no reason at all", () => {
    // The shape suite 11's walkover had to work around before the engine's
    // award variant declared `method`: an award with no reason is not a
    // satisfied assertion, it is an absent one.
    const result = compareMatches(
      [{ fixtureExtKey: "se-r1-i0", outcome: awarded("en-more", "walkover") }],
      [{ extKey: "se-r1-i0", status: "forfeited", roundNo: 1, outcome: awarded("en-more") }],
    );
    expect(result.mismatches[0]).toMatchObject({
      field: "method",
      expected: "walkover",
      actual: "(absent)",
    });
  });

  it("lets any live reason stand where the pack declares none", () => {
    // Same rule the `win` method already followed: a pack that states no
    // method is not asserting one. Without this guard the comparator would
    // red every award whose reason the pack simply declined to pin.
    const result = compareMatches(
      [{ fixtureExtKey: "se-r1-i0", outcome: awarded("en-more") }],
      [
        {
          extKey: "se-r1-i0",
          status: "forfeited",
          roundNo: 1,
          outcome: awarded("en-more", "walkover"),
        },
      ],
    );
    expect(result.mismatches).toEqual([]);
  });
});

// B07a Task 2 (extended) — the WIRING, not the comparator.
//
// `compareMatches` takes entrant ids; `expected.matches` carries pack refs.
// `resolveExpectedOutcome` is the real translator between them, and it
// rebuilds each outcome FIELD BY FIELD, so any field it fails to name is
// dropped before the comparator can ever compare it. A unit test on the
// comparator alone cannot see that — which is exactly how an award's
// `method` came to be compared by code that never received one.
//
// So these drive the REAL producer into the REAL consumer: pack refs in one
// end, a mismatch verdict out the other, with no hand-built row in between.
describe("resolveExpectedOutcome → compareMatches — the real producer into the real consumer", () => {
  const entrantIdByRef = new Map([
    ["ref-more", "en-more"],
    ["ref-lenus", "en-lenus"],
  ]);

  const resolve = (outcome: PackExpectedOutcome) => {
    const unresolved: string[] = [];
    const resolved = resolveExpectedOutcome(outcome, entrantIdByRef, unresolved);
    expect(unresolved).toEqual([]);
    if (resolved === undefined) throw new Error("resolveExpectedOutcome dropped a row it could resolve");
    return resolved;
  };

  it("carries an award's reason through the ref→id rebuild and into the verdict", () => {
    // The shape suite 11 declares at `se-r0-i19`: a walkover. If the rebuild
    // drops `method`, the comparator receives no declared reason, asserts
    // nothing, and this fixture passes while recorded as a disqualification.
    const result = compareMatches(
      [
        {
          fixtureExtKey: "se-r0-i19",
          outcome: resolve({ kind: "award", winner: "ref-more", method: "walkover" }),
        },
      ],
      [
        {
          extKey: "se-r0-i19",
          status: "forfeited",
          roundNo: 0,
          outcome: awarded("en-more", "disqualification"),
        },
      ],
    );
    expect(result.mismatches[0]).toMatchObject({
      field: "method",
      expected: "walkover",
      actual: "disqualification",
    });
  });

  it("passes that same award when the live reason IS the declared one", () => {
    const result = compareMatches(
      [
        {
          fixtureExtKey: "se-r0-i19",
          outcome: resolve({ kind: "award", winner: "ref-more", method: "walkover" }),
        },
      ],
      [
        {
          extKey: "se-r0-i19",
          status: "forfeited",
          roundNo: 0,
          outcome: awarded("en-more", "walkover"),
        },
      ],
    );
    expect(result.mismatches).toEqual([]);
    expect(result.checked).toBe(1);
  });

  it("carries a win's loser and method through the same rebuild", () => {
    // The other arm of the same function, pinned so a future edit cannot
    // quietly drop `loser` the way the award arm dropped `method` — which
    // would make this whole task's comparator change inert.
    const outcome = resolve({
      kind: "win",
      winner: "ref-more",
      loser: "ref-lenus",
      method: "regulation",
    });
    expect(outcome).toEqual({ kind: "win", winner: "en-more", loser: "en-lenus", method: "regulation" });

    const result = compareMatches(
      [{ fixtureExtKey: "se-r0-i0", outcome }],
      [
        {
          extKey: "se-r0-i0",
          status: "finalized",
          roundNo: 0,
          outcome: won("en-more", "en-azmeen", "regulation"),
        },
      ],
    );
    expect(result.mismatches[0]).toMatchObject({ field: "loser", expected: "en-lenus", actual: "en-azmeen" });
  });

  it("reports an unresolvable ref rather than resolving it to nothing", () => {
    const unresolved: string[] = [];
    const resolved = resolveExpectedOutcome(
      { kind: "award", winner: "ref-nobody", method: "walkover" },
      entrantIdByRef,
      unresolved,
    );
    expect(resolved).toBeUndefined();
    expect(unresolved).toEqual(["ref-nobody"]);
  });
});

// Final whole-branch review, finding 5 (check 7 mutant #2) — `SETTLED_STATUSES`
// (oracle.ts:1290) declares "abandoned" a settled status the per-match oracle
// will compare an outcome against, but nothing anywhere in this file (or the
// rest of the bench) ever drove `compareMatches` with one: dropping
// "abandoned" from the set broke 0 of 1869 tests, reproduced twice. It is a
// real, reachable product status — `core.abandon` folds a fixture straight
// to it (`fixtureStatusFromFold`, apps/web/src/server/engine-db/
// append-event.ts:118-121: "Abandon first: cricket abandon folds to a
// no_result OUTCOME, but the fixture status stays 'abandoned'" — replay
// policy owns it from there, not a re-run). A pack that ever ships a
// `core.abandon` fixture needs this oracle to compare its outcome like any
// other settled fixture, not report it as an unfinished run.
describe("compareMatches — an abandoned fixture", () => {
  const noResult = { kind: "no_result" as const };

  it("compares an abandoned fixture's outcome instead of reporting it unfinished — the positive pair", () => {
    const result = compareMatches(
      [{ fixtureExtKey: "f1", outcome: noResult }],
      [{ extKey: "f1", status: "abandoned", roundNo: 0, outcome: noResult }],
    );
    expect(result.checked).toBe(1);
    expect(result.mismatches).toEqual([]);
  });

  it("still catches a genuinely wrong outcome on an abandoned fixture, not a blanket pass", () => {
    // The differential case (a right answer that differs from the wrong
    // answer's constant): if this oracle merely special-cased "abandoned
    // always passes" instead of treating it as SETTLED and comparing the
    // real outcome, a pack that expected a decisive win but got an abandoned
    // no-result would slip through unread. It must report the SAME "outcome"
    // field a live, non-abandoned kind mismatch reports — not "status",
    // which is what dropping "abandoned" from `SETTLED_STATUSES` produces
    // instead (an "abandoned" fixture would read as merely not-yet-decided).
    const result = compareMatches(
      [{ fixtureExtKey: "f1", outcome: won("e1", "e2") }],
      [{ extKey: "f1", status: "abandoned", roundNo: 0, outcome: noResult }],
    );
    expect(result.mismatches[0]).toMatchObject({ field: "outcome", expected: "win", actual: "no_result" });
  });
});
