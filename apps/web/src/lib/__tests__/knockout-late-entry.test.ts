// W4 app-A Task 10 (X-LE-3…X-LE-8) — the pure late-entry decision for a drawn root knockout, as a table, the empty case
// first. Expected values: the rulebook's order of cases (rules/cross-sport.md X-LE-3, X-LE-5, X-LE-6, X-LE-7, X-LE-8),
// typed per row; a bye's pick from the ONE RB4-L4 oracle over the stored byes (`rb4L4ExpectedLine`, pre-flight C3/D8),
// with each line's draw position read off the ENGINE's own bracket (`engineLineDrawPosition`) — never off the code under
// test.
//
// Sport-free by nature: the decision reads seats, seeds, statuses and three booleans, no sport field.
import { describe, expect, it } from "vitest";
import { decideKnockoutLateEntry, type KnockoutLateDecision, type LateLine } from "@/lib/knockout-late-entry";
import { engineLineDrawPosition, rb4L4ExpectedLine } from "@/lib/__tests__/rb4-l4-oracle";

/** A round-1 line of a bracket of `size`: an open match between two players unless the row says otherwise. */
function line(size: number, seq: number, o: Partial<LateLine> = {}): LateLine {
  return {
    id: `L${seq}`,
    seq,
    drawPos: engineLineDrawPosition(size, seq),
    home: `h${seq}`,
    away: `a${seq}`,
    status: "scheduled",
    reason: null,
    holderSeed: null,
    nextStarted: false,
    withdrawnSeat: null,
    played: false,
    loserFed: false,
    ...o,
  };
}
/** A bye on line `seq`: `holder` on the home seat, the away seat the phantom. */
const bye = (size: number, seq: number, holder: string, seed: number | null, o: Partial<LateLine> = {}) =>
  line(size, seq, { home: holder, away: null, status: "forfeited", reason: "bye", holderSeed: seed, ...o });
/** A withdrawal's walkover on line `seq`: the home seat withdrew, the away seat walked over. */
const walkover = (size: number, seq: number, o: Partial<LateLine> = {}) =>
  line(size, seq, { status: "forfeited", reason: "withdrew", withdrawnSeat: "home", ...o });

/** The oracle's line for `lines`' byes (their holders' seeds), or null. */
function oracle(lines: readonly LateLine[], round1Lines: number): string | null {
  const byes = lines.filter((l) => l.reason === "bye");
  return rb4L4ExpectedLine(
    byes.map((l) => ({ lineId: l.id, holderId: (l.home ?? l.away)!, seq: l.seq })),
    new Map(byes.map((l) => [(l.home ?? l.away)!, l.holderSeed])),
    round1Lines,
  );
}

describe("decideKnockoutLateEntry (X-LE-3…X-LE-8)", () => {
  const ROWS: {
    name: string;
    lines: LateLine[];
    stageStarted?: boolean;
    caseTwoOnly?: boolean;
    expected: KnockoutLateDecision;
  }[] = [
    // The empty case first: no round-1 line at all answers "no slot", and offers Rebuild only when nothing started.
    { name: "no round-1 lines, nothing started", lines: [], expected: { case: "refused", canRebuild: true } },
    { name: "no round-1 lines, the stage started", lines: [], stageStarted: true, expected: { case: "refused", canRebuild: false } },
    {
      name: "X-LE-6 round 1 full of matches, nothing started: refused, Rebuild offered",
      lines: [line(4, 1), line(4, 2)],
      expected: { case: "refused", canRebuild: true },
    },
    {
      name: "X-LE-6 round 1 full of matches, one started: refused, no Rebuild",
      lines: [line(4, 1), line(4, 2)],
      stageStarted: true,
      expected: { case: "refused", canRebuild: false },
    },
    {
      name: "X-LE-3 one open bye: the newcomer takes it",
      lines: [bye(4, 1, "S1", 1), line(4, 2)],
      stageStarted: true,
      expected: { case: "bye", lineId: "L1" },
    },
    {
      name: "X-LE-9 the bye's holder started round 2: no bye; nothing else: refused",
      lines: [bye(4, 1, "S1", 1, { nextStarted: true }), line(4, 2)],
      stageStarted: true,
      expected: { case: "refused", canRebuild: false },
    },
    {
      name: "X-LE-9 the bye's holder started round 2: case (2) if a withdrawn slot is open",
      lines: [bye(8, 1, "S1", 1, { nextStarted: true }), walkover(8, 3), line(8, 2), line(8, 4)],
      stageStarted: true,
      expected: { case: "withdrawn_slot", lineId: "L3", seat: "home", reverse: true },
    },
    {
      name: "X-LE-5 a withdrawn seat walked over, its winner not started: case (2), the walkover reversed",
      lines: [line(4, 1), walkover(4, 2)],
      stageStarted: true,
      expected: { case: "withdrawn_slot", lineId: "L2", seat: "home", reverse: true },
    },
    {
      name: "X-LE-5 the away seat withdrew",
      lines: [line(4, 1), walkover(4, 2, { withdrawnSeat: "away" })],
      stageStarted: true,
      expected: { case: "withdrawn_slot", lineId: "L2", seat: "away", reverse: true },
    },
    {
      name: "X-LE-5 a disqualified seat walks over the same way (rulebook §12)",
      lines: [line(4, 1), walkover(4, 2, { reason: "disqualified" })],
      stageStarted: true,
      expected: { case: "withdrawn_slot", lineId: "L2", seat: "home", reverse: true },
    },
    {
      name: "X-LE-5 a withdrawn seat not yet walked over: case (2), nothing to reverse",
      lines: [line(4, 1), line(4, 2, { withdrawnSeat: "home" })],
      expected: { case: "withdrawn_slot", lineId: "L2", seat: "home", reverse: false },
    },
    {
      name: "X-LE-5 the walkover winner started round 2: the case closes",
      lines: [line(4, 1), walkover(4, 2, { nextStarted: true })],
      stageStarted: true,
      expected: { case: "refused", canRebuild: false },
    },
    {
      name: "X-LE-5 a line played before the withdrawal is no withdrawn slot",
      lines: [line(4, 1), walkover(4, 2, { played: true })],
      stageStarted: true,
      expected: { case: "refused", canRebuild: false },
    },
    {
      name: "X-LE-7 a withdrawn BYE HOLDER's line is never case (2): it would seat the newcomer in round 2",
      lines: [bye(4, 1, "S1", 1, { withdrawnSeat: "home" }), line(4, 2)],
      stageStarted: true,
      expected: { case: "refused", canRebuild: false },
    },
    {
      name: "X-LE-3 a bye whose holder departed is never case (1): the next-lowest holder's bye is taken",
      // Seed 2 (the lower seed, RB4-L4's pick) departed: seed 1's bye is the answer, not seed 2's.
      lines: [bye(8, 1, "S1", 1), line(8, 2), bye(8, 3, "S2", 2, { withdrawnSeat: "home" }), line(8, 4)],
      expected: { case: "bye", lineId: "L1" },
    },
    {
      name: "an orphan bye (its holder deleted: no seat held) is never taken",
      lines: [bye(4, 1, "S1", 1, { home: null }), line(4, 2)],
      expected: { case: "refused", canRebuild: true },
    },
    {
      name: "B2 m7 a bye whose loser feeds a third-place line is never case (1): its loser seat died at Start",
      lines: [bye(4, 1, "S1", 1, { loserFed: true }), line(4, 2, { loserFed: true })],
      stageStarted: true,
      expected: { case: "refused", canRebuild: false },
    },
    {
      name: "X-LE-3 a bye comes before a withdrawn slot",
      lines: [walkover(8, 1), line(8, 2), line(8, 3), bye(8, 4, "S2", 2)],
      stageStarted: true,
      expected: { case: "bye", lineId: "L4" },
    },
    {
      name: "several withdrawn slots: the earliest in draw order",
      lines: [line(8, 1), walkover(8, 3), walkover(8, 2, { withdrawnSeat: "away" }), line(8, 4)],
      stageStarted: true,
      expected: { case: "withdrawn_slot", lineId: "L2", seat: "away", reverse: true },
    },
    {
      name: "X-LE-8 a stepladder takes case (2) only: an open bye-like rung is never taken",
      lines: [bye(4, 1, "S1", 1), line(4, 2)],
      caseTwoOnly: true,
      expected: { case: "refused", canRebuild: true },
    },
    {
      name: "X-LE-8 a stepladder's withdrawn slot is taken",
      lines: [bye(4, 1, "S1", 1), walkover(4, 2)],
      caseTwoOnly: true,
      stageStarted: true,
      expected: { case: "withdrawn_slot", lineId: "L2", seat: "home", reverse: true },
    },
  ];

  it("answers every row its rulebook case", () => {
    let checked = 0;
    for (const r of ROWS) {
      const got = decideKnockoutLateEntry({ lines: r.lines, stageStarted: r.stageStarted ?? false, caseTwoOnly: r.caseTwoOnly ?? false });
      expect(got, r.name).toEqual(r.expected);
      checked++;
    }
    expect(checked).toBe(ROWS.length);
    for (const c of ["bye", "withdrawn_slot", "refused"]) {
      expect(ROWS.some((r) => r.expected.case === c), `the table reaches case ${c}`).toBe(true);
    }
  });

  it("X-LE-4 two open byes: the lowest-seeded holder's (RB4-L4 oracle), not the first bye", () => {
    // Six seeded players in a bracket of eight: seeds 1 and 2 hold the byes. Line positions come from the engine's draw.
    const size = 8;
    const s1 = [1, 2, 3, 4].find((q) => engineLineDrawPosition(size, q) === 1)!;
    const s2 = [1, 2, 3, 4].find((q) => engineLineDrawPosition(size, q) === 2)!;
    expect(s1 !== undefined && s2 !== undefined && s1 !== s2, "premise: the engine places draw positions 1 and 2 on two lines").toBe(true);
    const lines = [1, 2, 3, 4].map((q) =>
      q === s1 ? bye(size, q, "Seed1", 1) : q === s2 ? bye(size, q, "Seed2", 2) : line(size, q),
    );
    const want = oracle(lines, 4);
    expect(want, "the oracle names seed 2's bye").toBe(`L${s2}`);
    expect(Math.min(s1, s2), "premise: a differential case — the first bye is seed 1's, not the answer").toBe(s1);
    expect(decideKnockoutLateEntry({ lines, stageStarted: true, caseTwoOnly: false })).toEqual({ case: "bye", lineId: want });
  });

  it("X-LE-4 tied holders (both unseeded): the LATER draw position, per the oracle", () => {
    const size = 8;
    let checked = 0;
    // Every pair of lines as the two byes, both holders unseeded: the oracle's tie-break decides.
    for (const a of [1, 2, 3, 4]) {
      for (const b of [1, 2, 3, 4]) {
        if (a >= b) continue;
        const lines = [1, 2, 3, 4].map((q) => (q === a || q === b ? bye(size, q, `U${q}`, null) : line(size, q)));
        const want = oracle(lines, 4);
        expect(decideKnockoutLateEntry({ lines, stageStarted: true, caseTwoOnly: false }), `byes on ${a},${b}`).toEqual({ case: "bye", lineId: want });
        checked++;
      }
    }
    expect(checked).toBe(6);
  });

  it("X-LE-4 an unseeded holder is lower than every seeded one", () => {
    const size = 8;
    const lines = [bye(size, 1, "Seed1", 1), line(size, 2), bye(size, 3, "Unseeded", null), line(size, 4)];
    expect(oracle(lines, 4)).toBe("L3");
    expect(decideKnockoutLateEntry({ lines, stageStarted: false, caseTwoOnly: false })).toEqual({ case: "bye", lineId: "L3" });
  });

  it("X-LE-7 a decision only ever names a round-1 line it was given", () => {
    // Every decision's line is one of the input lines (the server reads round 1 only) — over every row of the table.
    let checked = 0;
    for (const r of ROWS) {
      const got = decideKnockoutLateEntry({ lines: r.lines, stageStarted: r.stageStarted ?? false, caseTwoOnly: r.caseTwoOnly ?? false });
      if (got.case !== "refused") {
        expect(r.lines.map((l) => l.id), r.name).toContain(got.lineId);
        checked++;
      }
    }
    expect(checked).toBeGreaterThan(0);
  });
});
