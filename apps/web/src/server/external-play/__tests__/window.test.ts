import { describe, expect, it } from "vitest";
import {
  CHECKIN_BATCH_GAP_MS, CHECKIN_BATCH_SIZE, DEADLINE_AFTER_MS, EMAIL_LEAD_MS, WINDOW_OPEN_LEAD_MS,
  LINE_DEADLINE_GRACE_MS, batchCount, batchOfRank, boardAnchor, boardCap, checkInCounts, deadlineReason, roomPhase, windowFor,
} from "../window";

const T = new Date("2026-10-01T19:00:00.000Z");
const at = (ms: number) => new Date(T.getTime() + ms);

describe("windowFor", () => {
  it("derives every edge from the constants, not literals", () => {
    const w = windowFor(boardAnchor(T, 0, false));
    expect(w.emailAt.getTime()).toBe(T.getTime() - EMAIL_LEAD_MS);
    expect(w.opensAt.getTime()).toBe(T.getTime() - WINDOW_OPEN_LEAD_MS);
    expect(w.deadline.getTime()).toBe(T.getTime() + DEADLINE_AFTER_MS);
  });
  it("pins the owner-approved values", () => {
    // The ONE typed number in this file, on purpose: its job is to pin the OWNER's value, copied from the ruling and not
    // derived from the code under test, so changing the constant is deliberate. DEADLINE_AFTER_MS is 10 minutes, not the
    // 20 it was: owner proposal of 2026-10-15, C7 (spec §0, §3.2.1). Every other test derives its minutes from the constant.
    expect([EMAIL_LEAD_MS, WINDOW_OPEN_LEAD_MS, DEADLINE_AFTER_MS]).toEqual([900_000, 600_000, 600_000]);
  });
});

describe("roomPhase", () => {
  it("is before one ms ahead of T−10, open at T−10 exactly", () => {
    expect(roomPhase(at(-WINDOW_OPEN_LEAD_MS - 1), boardAnchor(T, 0, false))).toBe("before");
    expect(roomPhase(at(-WINDOW_OPEN_LEAD_MS), boardAnchor(T, 0, false))).toBe("open");
  });
  it("is open one ms before the deadline (DEADLINE_AFTER_MS), closed at the deadline exactly", () => {
    expect(roomPhase(at(DEADLINE_AFTER_MS - 1), boardAnchor(T, 0, false))).toBe("open");
    expect(roomPhase(at(DEADLINE_AFTER_MS), boardAnchor(T, 0, false))).toBe("closed");
  });
});

describe("checkInCounts", () => {
  it("null never counts", () => {
    expect(checkInCounts(null, boardAnchor(T, 0, false))).toBe(false);
  });
  it("a stamp before the window (e.g. before a reschedule) does not count", () => {
    expect(checkInCounts(at(-WINDOW_OPEN_LEAD_MS - 1), boardAnchor(T, 0, false))).toBe(false);
  });
  it("counts from T−10 inclusive to the deadline (DEADLINE_AFTER_MS) exclusive", () => {
    expect(checkInCounts(at(-WINDOW_OPEN_LEAD_MS), boardAnchor(T, 0, false))).toBe(true);
    expect(checkInCounts(at(DEADLINE_AFTER_MS - 1), boardAnchor(T, 0, false))).toBe(true);
    expect(checkInCounts(at(DEADLINE_AFTER_MS), boardAnchor(T, 0, false))).toBe(false);
  });
});

// ─── Timed check-in batches (spec §3.2.1; capacity tests 1, 4, 5a and the window of a later batch) ────────────────────────
describe("batchOfRank / boardAnchor — the batch boundaries (capacity test 1)", () => {
  const S = CHECKIN_BATCH_SIZE;
  it("boards ranked S-1 and S sit in batches 0 and 1; 2S-1 and 2S in batches 1 and 2 (the owner's '10/11 and 20/21' in one-based terms)", () => {
    // From the RULING (boards 1 to 10 are batch 0, 11 to 20 batch 1, 21 to 30 batch 2), in zero-based ranks - never from
    // batchOfRank's own division. S enters only as the constant that names the ruling's "10".
    const want: [number, number][] = [[0, 0], [S - 1, 0], [S, 1], [2 * S - 1, 1], [2 * S, 2]];
    let checked = 0;
    for (const [rank, batch] of want) {
      expect(batchOfRank(rank), `rank ${rank}`).toBe(batch);
      expect(boardAnchor(T, rank, true).batch, `anchor of rank ${rank}`).toBe(batch);
      checked += 1;
    }
    expect(checked, "anti-vacuity: boundary ranks checked").toBe(want.length);
  });

  it("a 25-board round gives batches of 10, 10 and 5 (the per-batch counts, 25 in total)", () => {
    const boards = 2 * S + Math.floor(S / 2);
    const perBatch = new Map<number, number>();
    for (let rank = 0; rank < boards; rank++) {
      const b = boardAnchor(T, rank, true).batch;
      perBatch.set(b, (perBatch.get(b) ?? 0) + 1);
    }
    expect([...perBatch.entries()], "batches of S, S and half an S, in order").toEqual([[0, S], [1, S], [2, Math.floor(S / 2)]]);
    expect([...perBatch.values()].reduce((a, b) => a + b, 0), "anti-vacuity: every board counted once").toBe(boards);
    expect(batchCount(boards), "the round runs in three batches").toBe(3);
    // batchCount's edges: a round of exactly S boards is ONE batch, S+1 is two, none is still one.
    expect([batchCount(0), batchCount(1), batchCount(S), batchCount(S + 1), batchCount(2 * S)]).toEqual([1, 1, 1, 2, 2]);
  });

  it("a rank that is not a non-negative integer is refused, not rounded into a batch (a guard, not a comment)", () => {
    let refused = 0;
    for (const bad of [-1, 0.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() => batchOfRank(bad), String(bad)).toThrow(RangeError);
      refused += 1;
    }
    expect(refused, "anti-vacuity").toBe(4);
  });
});

describe("boardAnchor — T_batch and the window of a batch (capacity tests 4, 5a)", () => {
  it("the gap and the size are the owner's values, pinned HERE so changing either is deliberate and no other test moves (C1)", () => {
    // The typed numbers in this block: the OWNER's, copied from the ruling (2026-10-15: start at 120 s; the load re-run may
    // tighten the gap to 60 s, which is a change to this one line). Every other test derives from the constants.
    expect([CHECKIN_BATCH_SIZE, CHECKIN_BATCH_GAP_MS]).toEqual([10, 120_000]);
  });

  it("T_batch(i) = round_opened_at + i x CHECKIN_BATCH_GAP_MS, for every batch up to the ninth (100 boards)", () => {
    let checked = 0;
    for (let rank = 0; rank < 10 * CHECKIN_BATCH_SIZE; rank++) {
      const batch = Math.floor(rank / CHECKIN_BATCH_SIZE);
      expect(boardAnchor(T, rank, true).at.getTime() - T.getTime(), `rank ${rank}`).toBe(batch * CHECKIN_BATCH_GAP_MS);
      checked += 1;
    }
    expect(checked, "anti-vacuity: boards checked").toBe(10 * CHECKIN_BATCH_SIZE);
  });

  it("a round of at most S boards is unchanged: one batch, opens T - WINDOW_OPEN_LEAD_MS, closes T + DEADLINE_AFTER_MS", () => {
    let checked = 0;
    for (let rank = 0; rank < CHECKIN_BATCH_SIZE; rank++) {
      const a = boardAnchor(T, rank, true);
      const w = windowFor(a);
      expect(a.at.getTime(), `rank ${rank}`).toBe(T.getTime());
      expect(w.opensAt.getTime()).toBe(T.getTime() - WINDOW_OPEN_LEAD_MS);
      expect(w.deadline.getTime()).toBe(T.getTime() + DEADLINE_AFTER_MS);
      checked += 1;
    }
    expect(checked, "anti-vacuity").toBe(CHECKIN_BATCH_SIZE);
  });

  it("a later batch opens AT its own start (the lead does not apply) and has its own full DEADLINE_AFTER_MS", () => {
    const rank = 2 * CHECKIN_BATCH_SIZE; // batch 2
    const w = windowFor(boardAnchor(T, rank, true));
    const start = T.getTime() + 2 * CHECKIN_BATCH_GAP_MS;
    expect(w.opensAt.getTime(), "opens at T_batch, not T_batch - WINDOW_OPEN_LEAD_MS").toBe(start);
    expect(w.deadline.getTime() - w.opensAt.getTime(), "the same DEADLINE_AFTER_MS a batch-0 board has after T").toBe(DEADLINE_AFTER_MS);
    const a = boardAnchor(T, rank, true);
    expect(roomPhase(new Date(start - 1), a), "one ms before its start").toBe("before");
    expect(roomPhase(new Date(start), a), "at its start").toBe("open");
    expect(roomPhase(new Date(start + DEADLINE_AFTER_MS - 1), a), "one ms before its deadline").toBe("open");
    expect(roomPhase(new Date(start + DEADLINE_AFTER_MS), a), "at its deadline").toBe("closed");
    // A check-in stamped inside batch 0's window but before batch 2 opened does not count for the batch-2 board.
    expect(checkInCounts(at(0), a), "a stamp before the board's own window").toBe(false);
    expect(checkInCounts(new Date(start), a), "a stamp at its own start").toBe(true);
  });

  it("an `off` round is ONE batch whatever the rank: every board opens at T (capacity test 5a)", () => {
    let checked = 0;
    for (let rank = 0; rank < 3 * CHECKIN_BATCH_SIZE; rank++) {
      const a = boardAnchor(T, rank, false);
      expect(a.batch, `rank ${rank}`).toBe(0);
      expect(a.at.getTime()).toBe(T.getTime());
      expect(windowFor(a)).toEqual(windowFor(boardAnchor(T, 0, false)));
      checked += 1;
    }
    expect(checked, "anti-vacuity").toBe(3 * CHECKIN_BATCH_SIZE);
  });

  it("the same rank differs between a staggered and an unstaggered round (the case where the wrong answer is not the right one's constant)", () => {
    const rank = 2 * CHECKIN_BATCH_SIZE;
    expect(boardAnchor(T, rank, true).at.getTime()).not.toBe(boardAnchor(T, rank, false).at.getTime());
  });
});

describe("deadlineReason (spec §9)", () => {
  it("neither checked in → no_show_both", () => {
    expect(deadlineReason({ whiteCheckedIn: false, blackCheckedIn: false, lichessStatus: null })).toBe("no_show_both");
  });
  it("white only → no_show_black", () => {
    expect(deadlineReason({ whiteCheckedIn: true, blackCheckedIn: false, lichessStatus: null })).toBe("no_show_black");
  });
  it("black only → no_show_white", () => {
    expect(deadlineReason({ whiteCheckedIn: false, blackCheckedIn: true, lichessStatus: null })).toBe("no_show_white");
  });
  it("both, no game → not_started", () => {
    expect(deadlineReason({ whiteCheckedIn: true, blackCheckedIn: true, lichessStatus: null })).toBe("not_started");
    expect(deadlineReason({ whiteCheckedIn: true, blackCheckedIn: true, lichessStatus: "created" })).toBe("not_started");
  });
  it("both, aborted-family status → aborted", () => {
    for (const s of ["aborted", "noStart", "unknownFinish"]) {
      expect(deadlineReason({ whiteCheckedIn: true, blackCheckedIn: true, lichessStatus: s })).toBe("aborted");
    }
  });
  it("a started or finished game is never a deadline case", () => {
    for (const s of ["started", "mate", "resign", "outoftime", "draw"]) {
      expect(deadlineReason({ whiteCheckedIn: true, blackCheckedIn: true, lichessStatus: s })).toBeNull();
    }
  });
  it("a missing check-in outranks a Lichess status (order differential)", () => {
    expect(deadlineReason({ whiteCheckedIn: true, blackCheckedIn: false, lichessStatus: "aborted" })).toBe("no_show_black");
  });
});

// Capacity test 27's pure half (spec §5.7.8): the ONE bound on every protection the check-in line gives. All of it derived:
// cap = T_batch + DEADLINE_AFTER_MS + LINE_DEADLINE_GRACE_MS, for each board's own batch.
describe("boardCap (spec 5.7.8)", () => {
  it("is the board's deadline plus LINE_DEADLINE_GRACE_MS, in batch 0 and in batch 2 (the case where it is not the round's)", () => {
    let checked = 0;
    for (const rank of [0, CHECKIN_BATCH_SIZE - 1, 2 * CHECKIN_BATCH_SIZE]) {
      const anchor = boardAnchor(T, rank, true);
      const batch = batchOfRank(rank);
      expect(boardCap(anchor).getTime(), `rank ${rank}`).toBe(T.getTime() + batch * CHECKIN_BATCH_GAP_MS + DEADLINE_AFTER_MS + LINE_DEADLINE_GRACE_MS);
      expect(boardCap(anchor).getTime() - windowFor(anchor).deadline.getTime(), `rank ${rank}: the grace past ITS deadline`).toBe(LINE_DEADLINE_GRACE_MS);
      checked += 1;
    }
    expect(checked, "boards checked").toBe(3);
    expect(boardCap(boardAnchor(T, 2 * CHECKIN_BATCH_SIZE, true)).getTime(), "batch 2 differs from batch 0").not.toBe(boardCap(boardAnchor(T, 0, true)).getTime());
  });
  it("pins the owner's value: five minutes past the deadline (Q4, 2026-10-15)", () => {
    // The typed number on purpose: it is the OWNER's 5-minute cap, and changing it is deliberate.
    expect(LINE_DEADLINE_GRACE_MS).toBe(300_000);
  });
});
