// Match Day online, Task 7 - the round panel's pure rules (plan 2026-11-05-match-day-all-in-one.md Task 7; owner rulings MD-R2/R22 (a link
// hold's way back is the stage's latest round) and MD-R15 (Pair next round in the panel)).
//
// Chess-only reason, once: online play is `onlinePlay = 'lichess'` on `boardgame`, so no other sport reaches these rules and there is no
// sport registry to sweep. What IS swept: every NEEDS_REASONS value (only the two link reasons are a link hold), every board state.
//
// Where an expected value comes from (never from the function under test): "over" is `boardIsOver` (lib/arbiter-view.ts) over typed
// board states; the window's edge is `inExtendWindow`'s half-open rule (lib/checkin-extend.ts); the two link reasons are the ones the
// server's open reports (`OPEN_ROUND_SKIP_REASONS`, lib/open-round.ts); the stage-and-round pairing is typed in each seed.
// Anti-vacuity: every sweep reports what it checked, zero is a failure.
import { describe, expect, it } from "vitest";
import { emptyExtendTally, inExtendWindow } from "@/lib/checkin-extend";
import { OPEN_ROUND_SKIP_REASONS, type OpenRoundView } from "@/lib/open-round";
import type { MatchDayOnlineRound } from "../types";
import { NEEDS_REASONS, type NeedsReason } from "@/server/external-play/types";
import { arbiterRound, board, done, held, live, openWindow, pairedRound, round, withState, NOW } from "@/components/v2/match-day/__tests__/_online-fixtures";
import { linkHolds, nextRoundOf, pairNextRound } from "../online";

const MIN = 60_000;
const iso = (ms: number) => new Date(ms).toISOString();

/** An opened round of stage `s` whose every board is decided. */
const over = (key: string, extra: Partial<MatchDayOnlineRound> = {}) => round(key, "playing", arbiterRound([done("1-0"), done("0-1")]), extra);
/** A held board of a round with the reason `held_reason` the producer stamps (`hold_reason`, MD-R8). */
const heldFor = (reason: NeedsReason | null, over: Record<string, unknown> = {}) => ({ ...held(0), hold_reason: reason, ...over });

describe("nextRoundOf - the round the panel offers to open after this one: the same STAGE's next round number, paired and not opened", () => {
  it("EMPTY CASE FIRST: no rows, and a round with no successor row, have no next", () => {
    expect(nextRoundOf([], { stage_id: "s1", round_no: 1 })).toBeNull();
    expect(nextRoundOf([over("s1:1")], { stage_id: "s1", round_no: 1 })).toBeNull();
  });

  it("the row with the same stage and round_no + 1 in phase before is the next", () => {
    const r1 = over("s1:1");
    const r2 = pairedRound("s1:2");
    expect(nextRoundOf([r1, r2], r1)?.key).toBe("s1:2");
  });

  it("another stage's round number is never the next (two stages of one division each have a round 2)", () => {
    const r1 = over("s1:1");
    const otherStage = pairedRound("s2:2");
    expect(nextRoundOf([r1, otherStage], r1)).toBeNull();
    // and the right row wins when both exist, in either order
    const mine = pairedRound("s1:2");
    expect(nextRoundOf([otherStage, r1, mine], r1)?.key).toBe("s1:2");
    expect(nextRoundOf([mine, r1, otherStage], r1)?.key).toBe("s1:2");
  });

  it("only the very next number: round 3 is not the next of round 1", () => {
    const r1 = over("s1:1");
    expect(nextRoundOf([r1, pairedRound("s1:3")], r1)).toBeNull();
  });

  it("a successor that is already opened (check-in or playing) is not 'ready to open': only a before row is", () => {
    const r1 = over("s1:1");
    let checked = 0;
    for (const phase of ["checkin", "playing", "not_started"] as const) {
      const successor = round("s1:2", phase, phase === "not_started" ? null : arbiterRound([live()]));
      expect(nextRoundOf([r1, successor], r1), phase).toBeNull();
      checked += 1;
    }
    expect(checked).toBe(3);
  });

  it("a row's next is judged on its own stage_id and round_no, not on its key's spelling or its position", () => {
    const r1 = round("s1:1", "playing", arbiterRound([done()]), { stage_id: "s1", round_no: 1 });
    expect(nextRoundOf([pairedRound("s1:2"), r1], r1)?.round_no).toBe(2);
  });
});

describe("pairNextRound - MD-R15: Pair next round is offered only on a round whose every board is over, in a Swiss stage whose next round waits to be paired", () => {
  const swiss = (r: ReturnType<typeof over>, pair_next_round: number | null) => ({ ...r, pair_next_round });

  it("EMPTY CASE FIRST: a round with no board on screen is not over (the empty set answers yes to 'every board is over')", () => {
    const none = round("s1:1", "playing", arbiterRound([], { ownBoards: 2 }), { pair_next_round: 2 });
    expect(none.round!.boards).toHaveLength(0);
    expect(pairNextRound(none)).toBeNull();
  });

  it("an opened round, all boards decided, whose stage pairs round + 1 next: the round it would pair", () => {
    expect(pairNextRound(swiss(over("s1:1"), 2))).toBe(2);
    expect(pairNextRound(swiss(over("s1:4"), 5))).toBe(5);
  });

  it("not over: any board checking in, playing, or held keeps it away (a held board is not decided)", () => {
    let checked = 0;
    for (const unfinished of [board(), live(), held(0)]) {
      const r = round("s1:1", "playing", arbiterRound([done("1-0"), unfinished]), { pair_next_round: 2 });
      expect(pairNextRound(r), unfinished.state.kind).toBeNull();
      checked += 1;
    }
    expect(checked).toBe(3);
  });

  it("every state that is over counts: a score, no result, and a cancelled board", () => {
    let checked = 0;
    for (const state of [{ kind: "result", score: "1-0", noResult: false }, { kind: "result", score: null, noResult: true }, { kind: "cancelled" }] as const) {
      const r = round("s1:1", "playing", arbiterRound([withState(state), done()]), { pair_next_round: 2 });
      expect(pairNextRound(r), state.kind).toBe(2);
      checked += 1;
    }
    expect(checked).toBe(3);
  });

  it("a board over that is OWED an invite (a re-armed No result) is waiting, not finished: no Pair next", () => {
    const rearmed = done(null, { fixtureId: "rearm" });
    const view: OpenRoundView = {
      stageId: "s1",
      stageName: "Swiss",
      roundNo: 1,
      state: "open",
      openedAt: iso(NOW),
      deadlineAt: iso(NOW + 5 * MIN),
      windowMinutes: 10,
      staggered: false,
      batches: [],
      staggerSpanMinutes: 0,
      scheduledAt: null,
      press: "reopen",
      pairings: [{ fixtureId: "rearm", boardNo: 1, whiteName: "A", blackName: "B", invitedAt: null, owedSeats: 2, canResend: false }],
      extendableBoards: 0,
      extendWindows: [],
      extendRefusals: emptyExtendTally(),
      earlierInPlay: [],
    };
    const r = round("s1:1", "playing", arbiterRound([rearmed, done()]), { pair_next_round: 2, view });
    expect(pairNextRound(r)).toBeNull();
  });

  it("only the stage's NEXT round: a stage that pairs round + 2 (round + 1 is already paired) offers nothing here; null and absent say none", () => {
    expect(pairNextRound(swiss(over("s1:1"), 3))).toBeNull();
    expect(pairNextRound(swiss(over("s1:3"), 2))).toBeNull();
    expect(pairNextRound(swiss(over("s1:1"), null))).toBeNull();
    expect(pairNextRound(over("s1:1"))).toBeNull();
  });

  it("a round that is not opened has nothing to be over, whatever its stage says", () => {
    expect(pairNextRound({ ...pairedRound("s1:1"), pair_next_round: 2 })).toBeNull();
  });
});

describe("linkHolds - MD-R2/R22: the boards of the round on screen held for a Lichess link, and whether their window has closed", () => {
  const LINK: readonly NeedsReason[] = ["lichess_unlinked", "lichess_reconnect"];

  it("EMPTY CASE FIRST: a round with no held board, and a before row, hold nothing", () => {
    expect(linkHolds(over("s1:1"), NOW)).toEqual([]);
    expect(linkHolds(pairedRound("s1:1"), NOW)).toEqual([]);
  });

  it("the link reasons are exactly the two the server's open reports as link skips", () => {
    const reported = OPEN_ROUND_SKIP_REASONS.filter((r) => r.startsWith("lichess_"));
    expect([...LINK].sort()).toEqual([...reported].sort());
  });

  it("every NEEDS_REASONS value: only the two link reasons are a link hold, and only on a board that IS on hold", () => {
    let checked = 0;
    for (const reason of NEEDS_REASONS) {
      const r = round("s1:1", "playing", arbiterRound([live(), heldFor(reason)]));
      const holds = linkHolds(r, NOW);
      expect(holds.length, reason).toBe(LINK.includes(reason) ? 1 : 0);
      checked += 1;
    }
    expect(checked).toBe(NEEDS_REASONS.length);
    expect(checked).toBeGreaterThan(0);
    // the reason alone does not make a hold: a board that left the hold (it plays) with a stale stamp is not one
    const stale = round("s1:1", "playing", arbiterRound([{ ...live(), hold_reason: "lichess_unlinked" } as never]));
    expect(linkHolds(stale, NOW)).toEqual([]);
  });

  it("a board with no reason (a non-editor's read strips it, MD-R21) is a hold the panel cannot name: none", () => {
    expect(linkHolds(round("s1:1", "playing", arbiterRound([heldFor(null)])), NOW)).toEqual([]);
  });

  it("window closed follows the board's own check-in window on the clock, half-open [opens, deadline)", () => {
    const edge = NOW; // the deadline is NOW + 8 min in openWindow(8)
    const w = openWindow(8);
    const b = heldFor("lichess_unlinked", { checkin: w });
    const r = round("s1:1", "playing", arbiterRound([b]));
    const deadline = Date.parse(w.deadlineAt);
    // the oracle is the window's own rule
    expect(inExtendWindow(w, deadline - 1)).toBe(true);
    expect(inExtendWindow(w, deadline)).toBe(false);
    expect(linkHolds(r, deadline - 1)[0]!.windowClosed).toBe(false);
    expect(linkHolds(r, deadline)[0]!.windowClosed).toBe(true);
    expect(linkHolds(r, deadline + 60 * MIN)[0]!.windowClosed).toBe(true);
    expect(linkHolds(r, edge)[0]!.windowClosed).toBe(false);
  });

  it("with no clock yet the snapshot's word stands; a board with no window at all is not closed", () => {
    const closedAtRead = heldFor("lichess_reconnect", { checkin: { ...openWindow(8), canExtend: false, refusal: "closed" as const } });
    expect(linkHolds(round("s1:1", "playing", arbiterRound([closedAtRead])), null)[0]!.windowClosed).toBe(true);
    const open = heldFor("lichess_reconnect", { checkin: openWindow(8) });
    expect(linkHolds(round("s1:1", "playing", arbiterRound([open])), null)[0]!.windowClosed).toBe(false);
    const noWindow = heldFor("lichess_reconnect", { checkin: null });
    expect(linkHolds(round("s1:1", "playing", arbiterRound([noWindow])), null)[0]!.windowClosed).toBe(false);
  });

  it("holds come in board order whatever order the boards arrive in", () => {
    const a = heldFor("lichess_unlinked", { fixtureId: "a", boardNo: 3 });
    const b = heldFor("lichess_reconnect", { fixtureId: "b", boardNo: 1 });
    const holds = linkHolds(round("s1:1", "playing", arbiterRound([a, b])), NOW);
    expect(holds.map((h) => h.board.fixtureId)).toEqual(["b", "a"]);
    expect(holds.map((h) => h.reason)).toEqual(["lichess_reconnect", "lichess_unlinked"]);
  });
});
