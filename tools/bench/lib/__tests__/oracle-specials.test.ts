// B06a Task 4 — `expected.specials`, the second field PackSchema declared and
// nothing compared at run time.
//
// A special is not a key/outcome pair (this task's own plan sketched it that
// way and was wrong): it is a fixture plus a list of typed CLAIMS, each
// asserting one thing about the folded result — the outcome, a dotted path
// into the module's own state, or a standings cell. Every mechanic the bench
// exists to witness rides this shape: a super over, a shootout, a DLS revision,
// a retirement, an expedite.
//
// Claims arrive with entrant refs ALREADY resolved to ids, the convention every
// comparator in `oracle.ts` follows.
import { describe, expect, it } from "vitest";
import { compareSpecials, type ResolvedSpecial, type SpecialSubject } from "../oracle.ts";

const KEY = "d-tiny/rr-r3-c1";

function special(claims: ResolvedSpecial["claims"]): ResolvedSpecial {
  return { kind: "retirement", divisionRef: "d-tiny", fixtureExtKey: "rr-r3-c1", claims };
}

function subject(over: Partial<SpecialSubject> = {}): ReadonlyMap<string, SpecialSubject> {
  return new Map([
    [
      KEY,
      {
        // The ENGINE's award (W2b): a loser and a typed `reason`, no `method`.
        // The `subject` is what the live board returned, parsed by
        // `MatchOutcome`; claims below are the PACK's, which say `method`.
        outcome: { kind: "award", winner: "id-alpha", loser: "id-bravo", reason: "retired" },
        state: { phase: "done", sets: [{ tiebreak: false }, { tiebreak: true }] },
        standings: new Map([
          ["id-alpha", { won: 1, lost: 0, points: 3 }],
          ["id-bravo", { won: 0, lost: 1, points: 0 }],
        ]),
        ...over,
      },
    ],
  ]);
}

describe("compareSpecials", () => {
  it("passes when every claim holds, and counts the CLAIMS it checked", () => {
    const r = compareSpecials(
      [
        special([
          { on: "outcome", kind: "award", winner: "id-alpha" },
          { on: "state", path: "phase", equals: "done" },
          { on: "standings", entrant: "id-alpha", field: "won", equals: 1 },
        ]),
      ],
      subject(),
    );
    // FOUR, not three: `checked` counts asserted FIELDS, and the outcome
    // claim above pins two of them (kind and winner). That is the number that
    // shrinks if a future change quietly stops comparing one, which is what
    // the count is for — an outcome claim pinning four fields and one pinning
    // a single field are not equally covered.
    expect(r).toMatchObject({ specials: 1, checked: 4 });
    expect(r.failures).toEqual([]);
    expect(r.unsupported).toEqual([]);
  });

  it("fails the outcome claim on the winner, naming both values", () => {
    const r = compareSpecials(
      [special([{ on: "outcome", kind: "award", winner: "id-bravo" }])],
      subject(),
    );
    expect(r.failures).toEqual([
      { fixtureExtKey: "rr-r3-c1", claim: "outcome.winner", expected: "id-bravo", actual: "id-alpha" },
    ]);
  });

  it("fails an outcome claim whose KIND differs even when the winner agrees", () => {
    const r = compareSpecials(
      [special([{ on: "outcome", kind: "win", winner: "id-alpha" }])],
      subject(),
    );
    expect(r.failures[0]).toMatchObject({ claim: "outcome.kind", expected: "win", actual: "award" });
  });

  it("compares a claim's `method` against the award's engine REASON", () => {
    // The pack says `method`; W2b's award says `reason` (the subject above is a
    // retirement). A comparator reading `award.method` sees `undefined` here and
    // reds a claim that is TRUE — the positive pair comes first for that.
    const holds = compareSpecials([special([{ on: "outcome", kind: "award", method: "retired" }])], subject());
    expect(holds.checked).toBe(2);
    expect(holds.failures).toEqual([]);

    const wrong = compareSpecials([special([{ on: "outcome", method: "walkover" }])], subject());
    expect(wrong.failures).toEqual([
      { fixtureExtKey: "rr-r3-c1", claim: "outcome.method", expected: "walkover", actual: "retired" },
    ]);
  });

  it("reds a `method` claim on an outcome that carries none — reported as absent", () => {
    const r = compareSpecials(
      [special([{ on: "outcome", method: "walkover" }])],
      subject({ outcome: { kind: "double_walkover" } }),
    );
    expect(r.failures).toEqual([
      { fixtureExtKey: "rr-r3-c1", claim: "outcome.method", expected: "walkover", actual: "(absent)" },
    ]);
  });

  it("an award's `loser` is claimable, and the wrong side reds", () => {
    const holds = compareSpecials([special([{ on: "outcome", loser: "id-bravo" }])], subject());
    expect(holds.checked).toBe(1);
    expect(holds.failures).toEqual([]);

    const wrong = compareSpecials([special([{ on: "outcome", loser: "id-alpha" }])], subject());
    expect(wrong.failures).toEqual([
      { fixtureExtKey: "rr-r3-c1", claim: "outcome.loser", expected: "id-alpha", actual: "id-bravo" },
    ]);
  });

  it("a claim can name the double walkover as the kind", () => {
    const holds = compareSpecials(
      [special([{ on: "outcome", kind: "double_walkover" }])],
      subject({ outcome: { kind: "double_walkover" } }),
    );
    expect(holds.checked).toBe(1);
    expect(holds.failures).toEqual([]);

    const reds = compareSpecials([special([{ on: "outcome", kind: "double_walkover" }])], subject());
    expect(reds.failures[0]).toMatchObject({ claim: "outcome.kind", expected: "double_walkover", actual: "award" });
  });

  it("resolves a DOTTED state path, not just a top-level key", () => {
    const ok = compareSpecials(
      [special([{ on: "state", path: "sets.1.tiebreak", equals: true }])],
      subject(),
    );
    expect(ok.failures).toEqual([]);

    const bad = compareSpecials(
      [special([{ on: "state", path: "sets.0.tiebreak", equals: true }])],
      subject(),
    );
    expect(bad.failures[0]).toMatchObject({ claim: "state.sets.0.tiebreak", expected: "true", actual: "false" });
  });

  it("reports a state path that does not exist as absent, never as a pass", () => {
    const r = compareSpecials(
      [special([{ on: "state", path: "superOver.winner", equals: "id-alpha" }])],
      subject(),
    );
    expect(r.failures[0]).toMatchObject({ claim: "state.superOver.winner", actual: "(absent)" });
  });

  it("R64 — phase equality is EXACT: a signed-off 'final' never satisfies a claim of 'done'", () => {
    const signedOff = compareSpecials(
      [special([{ on: "state", path: "phase", equals: "done" }])],
      subject({ state: { phase: "final" } }),
    );
    expect(signedOff.checked).toBe(1);
    expect(signedOff.failures).toEqual([
      { fixtureExtKey: "rr-r3-c1", claim: "state.phase", expected: "done", actual: "final" },
    ]);

    const decided = compareSpecials(
      [special([{ on: "state", path: "phase", equals: "done" }])],
      subject({ state: { phase: "done" } }),
    );
    expect(decided.failures).toEqual([]);
  });

  it("fails a standings claim on the cell, naming the entrant and field", () => {
    const r = compareSpecials(
      [special([{ on: "standings", entrant: "id-bravo", field: "won", equals: 1 }])],
      subject(),
    );
    expect(r.failures[0]).toMatchObject({ claim: "standings.id-bravo.won", expected: "1", actual: "0" });
  });

  it("reports a special whose fixture has NO subject rather than skipping it", () => {
    const r = compareSpecials([special([{ on: "state", path: "phase", equals: "done" }])], new Map());
    expect(r.checked).toBe(0);
    expect(r.failures[0]).toMatchObject({ fixtureExtKey: "rr-r3-c1", claim: "(subject)", actual: "(absent)" });
  });

  it("reports a claim it cannot evaluate as UNSUPPORTED rather than passing it", () => {
    // `squads` claims have no live source wired yet. Silently treating one as
    // satisfied is how a pack author gets a green run for an assertion nothing
    // ever made — the failure mode this whole file exists to prevent.
    const r = compareSpecials(
      [special([{ on: "squads", entrant: "id-alpha", field: "subsUsed", equals: 2 }])],
      subject(),
    );
    expect(r.unsupported).toEqual([{ fixtureExtKey: "rr-r3-c1", on: "squads" }]);
    expect(r.checked).toBe(0);
  });

  it("reports zero checked when the pack declares no specials — a legitimate case", () => {
    // Unlike expected.matches, a pack with no specials is ordinary (darts
    // declares none by design), so this is a real NO SUBJECT, not dead code.
    expect(compareSpecials([], new Map())).toMatchObject({ specials: 0, checked: 0 });
  });
});
