// W4 app-A Task 10 (X-LE-3…X-LE-8) — the pure late-entry decision for a drawn root knockout, as a table, the empty case
// first. Expected values: the rulebook's order of cases (rules/cross-sport.md X-LE-3, X-LE-5, X-LE-6, X-LE-7, X-LE-8),
// typed per row; a bye's pick from the ONE RB4-L4 oracle over the stored byes (`rb4L4ExpectedLine`, pre-flight C3/D8),
// with each line's draw position read off the ENGINE's own bracket (`engineLineDrawPosition`) — never off the code under
// test.
//
// Sport-free by nature: the decision reads seats, seeds, statuses and three booleans, no sport field.
//
// Final review m1 (owner ruling 2026-11-09): Rebuild refuses a frozen schedule (422 SCHEDULE_LOCKED, usecases/stages/
// `regenerateStageInTx`), so a frozen division is never OFFERED it — the refusal says unfreeze first (`unfreezeFirst`).
import { describe, expect, it } from "vitest";
import { decideKnockoutLateEntry, decideWaitingEntrant, type KnockoutLateDecision, type LateLine } from "@/lib/knockout-late-entry";
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
    walkoverLoser: null,
    ...o,
  };
}
/** A bye on line `seq`: `holder` on the home seat, the away seat the phantom. */
const bye = (size: number, seq: number, holder: string, seed: number | null, o: Partial<LateLine> = {}) =>
  line(size, seq, { home: holder, away: null, status: "forfeited", reason: "bye", holderSeed: seed, ...o });
/** A withdrawal's walkover on line `seq`: the home seat withdrew, the away seat walked over. */
const walkover = (size: number, seq: number, o: Partial<LateLine> = {}) =>
  line(size, seq, { status: "forfeited", reason: "withdrew", withdrawnSeat: "home", walkoverLoser: `h${seq}`, ...o });

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
    scheduleFrozen?: boolean;
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
    // m1: the schedule frozen. Nothing started, so Rebuild would be the way in — but Rebuild refuses a frozen schedule, so
    // it is not offered: the refusal says unfreeze first. Started, there is no Rebuild to unfreeze for.
    {
      name: "m1 round 1 full, nothing started, the schedule FROZEN: refused, no Rebuild offered, unfreeze first",
      lines: [line(4, 1), line(4, 2)],
      scheduleFrozen: true,
      expected: { case: "refused", canRebuild: false, unfreezeFirst: true },
    },
    {
      name: "m1 no round-1 lines, nothing started, frozen: the empty case says unfreeze first too",
      lines: [],
      scheduleFrozen: true,
      expected: { case: "refused", canRebuild: false, unfreezeFirst: true },
    },
    {
      name: "m1 round 1 full, one started, frozen: refused, no Rebuild — and nothing to unfreeze for",
      lines: [line(4, 1), line(4, 2)],
      stageStarted: true,
      scheduleFrozen: true,
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
      const got = decideKnockoutLateEntry({
        lines: r.lines,
        stageStarted: r.stageStarted ?? false,
        caseTwoOnly: r.caseTwoOnly ?? false,
        scheduleFrozen: r.scheduleFrozen ?? false,
      });
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
    expect(decideKnockoutLateEntry({ lines, stageStarted: true, caseTwoOnly: false, scheduleFrozen: false })).toEqual({ case: "bye", lineId: want });
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
        expect(decideKnockoutLateEntry({ lines, stageStarted: true, caseTwoOnly: false, scheduleFrozen: false }), `byes on ${a},${b}`).toEqual({ case: "bye", lineId: want });
        checked++;
      }
    }
    expect(checked).toBe(6);
  });

  it("X-LE-4 an unseeded holder is lower than every seeded one", () => {
    const size = 8;
    const lines = [bye(size, 1, "Seed1", 1), line(size, 2), bye(size, 3, "Unseeded", null), line(size, 4)];
    expect(oracle(lines, 4)).toBe("L3");
    expect(decideKnockoutLateEntry({ lines, stageStarted: false, caseTwoOnly: false, scheduleFrozen: false })).toEqual({ case: "bye", lineId: "L3" });
  });

  it("X-LE-7 a decision only ever names a round-1 line it was given", () => {
    // Every decision's line is one of the input lines (the server reads round 1 only) — over every row of the table.
    let checked = 0;
    for (const r of ROWS) {
      const got = decideKnockoutLateEntry({
        lines: r.lines,
        stageStarted: r.stageStarted ?? false,
        caseTwoOnly: r.caseTwoOnly ?? false,
        scheduleFrozen: r.scheduleFrozen ?? false,
      });
      if (got.case !== "refused") {
        expect(r.lines.map((l) => l.id), r.name).toContain(got.lineId);
        checked++;
      }
    }
    expect(checked).toBeGreaterThan(0);
  });
});

// W4 app-A Task 11 (X-LE-10, K13): the tap on a WAITING entrant. A newcomer (no seat in the stage) runs the same cases as
// "Add late player"; a REINSTATED entrant still holds their old seat, so their tap may only give them that seat back — the
// walkover their own withdrawal wrote, reversed — never a second seat beside it. Expected values are the rulebook's cases.
describe("decideWaitingEntrant (X-LE-10, K13)", () => {
  /** A reinstated `me` on line 2's home seat, walked over by their own withdrawal (no longer departed: reinstated). */
  const mine = (o: Partial<LateLine> = {}) => walkover(4, 2, { home: "me", withdrawnSeat: null, walkoverLoser: "me", ...o });
  const ROWS: {
    name: string;
    lines: LateLine[];
    holdsSeat: boolean;
    stageStarted?: boolean;
    scheduleFrozen?: boolean;
    expected: KnockoutLateDecision;
  }[] = [
    // The empty case first: no lines and no seat is the newcomer's answer to an empty round 1.
    { name: "no round-1 lines, no seat: refused, Rebuild offered", lines: [], holdsSeat: false, expected: { case: "refused", canRebuild: true } },
    {
      name: "a newcomer (no seat) takes the bye, as Add late player does",
      lines: [bye(4, 1, "S1", 1), line(4, 2)],
      holdsSeat: false,
      expected: { case: "bye", lineId: "L1" },
    },
    {
      name: "K13 a reinstated player's own walkover is reversed: their seat, not the open bye",
      lines: [bye(4, 1, "S1", 1), mine()],
      holdsSeat: true,
      stageStarted: true,
      expected: { case: "withdrawn_slot", lineId: "L2", seat: "home", reverse: true },
    },
    {
      name: "K13 … the away seat",
      lines: [line(4, 1), mine({ home: "h2", away: "me", walkoverLoser: "me" })],
      holdsSeat: true,
      stageStarted: true,
      expected: { case: "withdrawn_slot", lineId: "L2", seat: "away", reverse: true },
    },
    {
      name: "K13 the walkover winner started round 2: refused, never a second seat in the open bye",
      lines: [bye(4, 1, "S1", 1), mine({ nextStarted: true })],
      holdsSeat: true,
      stageStarted: true,
      expected: { case: "refused", canRebuild: false },
    },
    {
      name: "K13 their line was played before they left: refused",
      lines: [line(4, 1), mine({ played: true })],
      holdsSeat: true,
      stageStarted: true,
      expected: { case: "refused", canRebuild: false },
    },
    {
      name: "K13 the walkover went the OTHER way (they won it, then left later): not theirs to reverse",
      lines: [line(4, 1), mine({ walkoverLoser: "h9" })],
      holdsSeat: true,
      stageStarted: true,
      expected: { case: "refused", canRebuild: false },
    },
    {
      name: "K13 they held a bye (now carried past round 1): refused",
      lines: [bye(4, 1, "me", 1), line(4, 2)],
      holdsSeat: true,
      stageStarted: true,
      expected: { case: "refused", canRebuild: false },
    },
    {
      name: "K13 a seat only beyond round 1 (no round-1 line names them): refused, Rebuild when nothing started",
      lines: [line(4, 1), line(4, 2)],
      holdsSeat: true,
      expected: { case: "refused", canRebuild: true },
    },
    // m1: the tap's refusal reads the freeze as the add's does.
    {
      name: "m1 a newcomer, round 1 full, nothing started, the schedule FROZEN: no Rebuild offered, unfreeze first",
      lines: [line(4, 1), line(4, 2)],
      holdsSeat: false,
      scheduleFrozen: true,
      expected: { case: "refused", canRebuild: false, unfreezeFirst: true },
    },
    // No row for a frozen SEAT HOLDER (T26c item C): the tap answers any seat holder's refusal "played on"
    // (KO_LATE_ENTRY_PLAYED_ON) before it reads this decision's `unfreezeFirst` (server/usecases/knockout-late-entry.ts,
    // `placeWaitingKnockoutEntrant`), so what this function says for one reaches nobody. The usecase pins the answer a
    // frozen seat holder gets: knockout-late-arrival.test.ts, "K13 race with the schedule FROZEN before the tap".
    {
      name: "m1 frozen, one started: refused, nothing to unfreeze for",
      lines: [line(4, 1), line(4, 2)],
      holdsSeat: false,
      stageStarted: true,
      scheduleFrozen: true,
      expected: { case: "refused", canRebuild: false },
    },
  ];

  it("answers every row its case", () => {
    let checked = 0;
    for (const r of ROWS) {
      const got = decideWaitingEntrant({
        lines: r.lines,
        stageStarted: r.stageStarted ?? false,
        caseTwoOnly: false,
        scheduleFrozen: r.scheduleFrozen ?? false,
        entrantId: "me",
        holdsSeat: r.holdsSeat,
      });
      expect(got, r.name).toEqual(r.expected);
      checked++;
    }
    expect(checked).toBe(ROWS.length);
  });
});
