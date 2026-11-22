// What the page keeps of its last answer when a poll could not read part of the online half (gaps wave A2, fix rounds 1 and 2). TWO things can
// fail, and each holds ONLY what it failed to read:
//  - the online ROUNDS read (`online_failed`, ruling MD-R9: the courts are answered whole): `online_rounds` is `[]` because nothing was read,
//    so taking it whole would close the board panel open on a game, drop a phone to the list and make the cameras leave and join again for one
//    poll. The page keeps its last rounds and nothing else of the poll's.
//  - the held or flagged lister of ONE division (`boards_unread` names it): the desk's per-board Needs-you rows of THAT division are missing
//    from the poll, because they were not read, not because nothing is held. The page keeps its last `board_held` / `board_flagged` rows of
//    that division and takes every other row (another division's, a badminton division's, a court's) and the results-owed count from the
//    poll: the count comes from the matches' own state, never from the listers, so a failed lister cannot change it.
// An ANSWERED poll is taken whole, an empty answer included - a round that ended leaves, a board that was settled leaves its row; holding
// either forever would be the opposite defect.
//
// Where an expected value comes from: the markers' meaning is the type's own sentences (types.ts `online_failed`, `boards_unread`); the rows
// are named by the ONE spelling that names them (`needsYouKey`); the rounds are fixture objects compared by identity, so "kept" means the very
// array the page held. Anti-vacuity: each case counts what it compared.
import { describe, expect, it } from "vitest";
import { needsYouKey, type NeedsYouItem } from "@/components/v2/desk/needs-you";
import type { MatchDayView } from "../types";
import { viewAfterPoll } from "../view";
import { checkinRound, onlineView, pairedRound } from "../../../components/v2/match-day/__tests__/_online-fixtures";

const prev = (): MatchDayView => onlineView([checkinRound("stage-1:3"), pairedRound("stage-2:1")], { now: "2026-11-19T18:00:00.000Z" });
const SEVERITY = { board_held: "red", board_flagged: "amber" } as const;
/** A division-level row (a badminton division's, say): named the way the desk names it, by division and kind. */
const row = (division: string, kind: NeedsYouItem["kind"], severity: NeedsYouItem["severity"] = "amber"): NeedsYouItem => ({
  key: needsYouKey(division, kind), severity, kind, title: needsYouKey(division, kind), sub: "", action: { label: "Open", href: "/" },
});
/** A PER-BOARD row: one per board, named with the board's fixture id. */
const boardRow = (division: string, kind: "board_held" | "board_flagged", fixture: string): NeedsYouItem => ({
  key: needsYouKey(division, kind, fixture), severity: SEVERITY[kind], kind, fixture_id: fixture, title: needsYouKey(division, kind, fixture), sub: "",
  action: { label: "Open", href: "/" },
});
const keys = (v: MatchDayView): string[] => v.needs_you.map((r) => r.key);
const polled = (over: Partial<MatchDayView>): MatchDayView => ({ ...onlineView([], { now: "2026-11-19T18:01:00.000Z" }), ...over });

// Two chess divisions and a badminton one, the page's last answer: chess A holds one board and has one flagged, chess B holds one, the badminton
// division has an unscheduled match.
const A = "div-chess-a";
const B = "div-chess-b";
const BAD = "div-badminton";
const had = (): MatchDayView => ({
  ...prev(),
  needs_you: [boardRow(A, "board_held", "fa1"), boardRow(B, "board_held", "fb1"), boardRow(A, "board_flagged", "fa2"), row(BAD, "unscheduled")],
  results_owed: 3,
});

describe("viewAfterPoll - the empty cases first", () => {
  it("a poll that read everything (no marker, nothing unread) is taken whole - the very poll - and holds nothing, whatever the page had", () => {
    const before = had();
    expect(before.needs_you, "premise: the page holds four rows, three of them board rows").toHaveLength(4);
    const answered = polled({ online_failed: false, boards_unread: [], online_rounds: [], needs_you: [], results_owed: 0 });
    const out = viewAfterPoll(before, answered);
    expect(out, "the poll itself").toBe(answered);
    expect(out.needs_you, "a poll with no board rows is the answer: every held row left").toEqual([]);
    expect(out.online_rounds, "an empty answer is the answer: the round that ended left").toEqual([]);
  });

  it("a failed poll when the page holds nothing yet (a first paint that failed) is the poll as it is", () => {
    const first = polled({ online_failed: true, boards_unread: [A], online_rounds: [], needs_you: [row(BAD, "unscheduled")] });
    const out = viewAfterPoll(onlineView([]), first);
    expect(out.online_rounds).toEqual([]);
    expect(keys(out), "nothing to hold: the poll's own row is all there is").toEqual([needsYouKey(BAD, "unscheduled")]);
    expect(out.online_failed).toBe(true);
    expect(out.boards_unread).toEqual([A]);
  });

  it("a body with no markers at all (a server older than the page) is an answer, taken whole", () => {
    const { online_failed: _o, boards_unread: _b, ...legacy } = polled({ online_rounds: [checkinRound("stage-1:4")], needs_you: [row(BAD, "unscheduled")] });
    void _o;
    void _b;
    const out = viewAfterPoll(had(), legacy as unknown as MatchDayView);
    expect(out.online_rounds.map((r) => r.key)).toEqual(["stage-1:4"]);
    expect(keys(out), "no board row is held on a body that did not say any division was unread").toEqual([needsYouKey(BAD, "unscheduled")]);
  });
});

describe("viewAfterPoll - a division whose queue read failed holds ONLY its own board rows (fix round 2)", () => {
  it("a failing chess division beside a working badminton row: the badminton row updates and the working chess division's rows are the poll's, while the failing division's board rows hold", () => {
    const before = had();
    // The poll: chess A's lister failed (no rows of A's boards), chess B's held board was settled since (its row is gone), the badminton division's
    // row changed (a second match is unscheduled), the rounds read answered, and the results owed moved.
    const unscheduledNow: NeedsYouItem = { ...row(BAD, "unscheduled"), title: "2 matches have no slot" };
    const next = polled({ online_failed: false, boards_unread: [A], online_rounds: [checkinRound("stage-1:4")], needs_you: [unscheduledNow], results_owed: 1 });

    const out = viewAfterPoll(before, next);

    // The failing division's two board rows are the page's last ones - the very objects - and nothing of division B's survived its settle.
    const heldRows = out.needs_you.filter((r) => r.kind === "board_held" || r.kind === "board_flagged");
    expect(heldRows.map((r) => r.key).sort(), "chess A's two board rows hold; chess B's settled row is gone").toEqual([needsYouKey(A, "board_flagged", "fa2"), needsYouKey(A, "board_held", "fa1")].sort());
    expect(heldRows.every((r) => before.needs_you.includes(r)), "the very rows the page held").toBe(true);
    expect(out.needs_you, "the badminton row is the poll's NEW one").toContain(unscheduledNow);
    expect(out.needs_you.filter((r) => r.kind === "unscheduled"), "and its old one is not kept beside it").toHaveLength(1);
    expect(out.needs_you, "three rows in all: A's two held, the badminton one").toHaveLength(3);
    expect(out.results_owed, "the count is the poll's - it never depends on a lister").toBe(1);
    expect(out.online_rounds, "the rounds read ANSWERED: the poll's rounds, not the held ones").toBe(next.online_rounds);
    expect(out.online_rounds.map((r) => r.key)).toEqual(["stage-1:4"]);
  });

  it("two divisions unread: both divisions' board rows hold, a third's do not", () => {
    const before = had();
    const out = viewAfterPoll(before, polled({ boards_unread: [A, B], needs_you: [] }));
    expect(keys(out).sort(), "A's two and B's one, and not the badminton row (a division-level row is the poll's, and the poll has none)").toEqual(
      [needsYouKey(A, "board_held", "fa1"), needsYouKey(A, "board_flagged", "fa2"), needsYouKey(B, "board_held", "fb1")].sort(),
    );
  });

  it("an unread division that had NO board rows held nothing: the poll's rows are all there is", () => {
    const before = { ...had(), needs_you: [boardRow(B, "board_held", "fb1")] };
    const next = polled({ boards_unread: [A], needs_you: [] });
    expect(viewAfterPoll(before, next).needs_you, "B's settled row left; A has none to keep").toEqual([]);
  });

  it("a division-level row of the unread division is the poll's, not held: only the two PER-BOARD kinds are what the failed read could not see", () => {
    const before = { ...had(), needs_you: [boardRow(A, "board_held", "fa1"), row(A, "unscheduled")] };
    const next = polled({ boards_unread: [A], needs_you: [] });
    expect(keys(viewAfterPoll(before, next)), "the unscheduled row is gone (the poll read it and has none); the board row holds").toEqual([needsYouKey(A, "board_held", "fa1")]);
  });

  it("the held rows keep the severity order: a held red row sits before the poll's amber ones, a held amber row after a red of the poll's", () => {
    const before = { ...had(), needs_you: [boardRow(A, "board_held", "fa1"), boardRow(A, "board_flagged", "fa2")] };
    const amber = row(BAD, "unscheduled", "amber");
    const red = row(B, "needs_decision", "red");
    const out = viewAfterPoll(before, polled({ boards_unread: [A], needs_you: [amber, red] }));
    expect(out.needs_you.map((r) => r.severity), "red first, then amber, as the desk sorts them").toEqual(["red", "red", "amber", "amber"]);
    expect(keys(out)[0], "the poll's own red row stays ahead of the held red one: a held row joins the END of its severity").toBe(red.key);
  });
});

describe("viewAfterPoll - a failed rounds read holds the rounds and never the rows or the count (fix round 2)", () => {
  it("online_failed with NO division unread (the rounds read threw for its own reasons): the rounds are the page's, every row and the count are the poll's", () => {
    const before = had();
    const next = polled({ online_failed: true, boards_unread: [], online_rounds: [], needs_you: [row(BAD, "unscheduled")], results_owed: 4, fixtures_today: 7 });

    const out = viewAfterPoll(before, next);

    expect(out.online_rounds, "the very rounds the page held").toBe(before.online_rounds);
    expect(out.online_rounds, "premise: it held something").toHaveLength(2);
    expect(keys(out), "no division was unread, so no board row is held: the poll's rows are the answer").toEqual([needsYouKey(BAD, "unscheduled")]);
    expect(out.results_owed, "never held").toBe(4);
    expect(out.now, "the day itself is the poll's").toBe(next.now);
    expect(out.fixtures_today).toBe(7);
    expect(out.online_failed, "still marked: this poll's online half is stale").toBe(true);
  });

  it("online_failed AND a division unread (a started division's lister threw: both readers saw it): the rounds hold, that division's board rows hold, the others' are the poll's", () => {
    const before = had();
    const out = viewAfterPoll(before, polled({ online_failed: true, boards_unread: [A], online_rounds: [], needs_you: [row(BAD, "unscheduled")], results_owed: 2 }));
    expect(out.online_rounds).toBe(before.online_rounds);
    expect(keys(out).sort(), "A's two board rows held, B's settled one gone, the badminton row the poll's").toEqual(
      [needsYouKey(A, "board_held", "fa1"), needsYouKey(A, "board_flagged", "fa2"), needsYouKey(BAD, "unscheduled")].sort(),
    );
    expect(out.results_owed).toBe(2);
  });

  it("a DESK-ONLY failure (a division unread, the rounds read answered) takes the good online rounds - they are not replaced by stale ones", () => {
    const before = had();
    const fresh = [checkinRound("stage-1:4")];
    const out = viewAfterPoll(before, polled({ online_failed: false, boards_unread: [A], online_rounds: fresh }));
    expect(out.online_rounds, "the poll's own rounds").toBe(fresh);
    expect(out.online_rounds, "and not the held ones").not.toBe(before.online_rounds);
    expect(before.online_rounds.map((r) => r.key), "premise: the page's old rounds are different ones").not.toEqual(fresh.map((r) => r.key));
  });
});

describe("viewAfterPoll - the sequence: answer, failure, failure, answer (and a settle in between)", () => {
  it("a failing division holds its rows through both failures, a settle elsewhere shows at once, and the next whole answer replaces all of it", () => {
    let page = had();
    const aRows = page.needs_you.filter((r) => r.key.startsWith(A));
    expect(aRows, "premise: A has two board rows").toHaveLength(2);
    // Failure 1: A unread; B's held board was settled (its row is not in the poll).
    page = viewAfterPoll(page, polled({ boards_unread: [A], needs_you: [row(BAD, "unscheduled")], now: "2026-11-19T18:01:00.000Z" }));
    expect(page.needs_you.filter((r) => r.key.startsWith(A)), "failure 1 holds A's rows").toEqual(aRows);
    expect(keys(page).some((k) => k.startsWith(B)), "B's settled row left on the very poll that settled it").toBe(false);
    // Failure 2: A still unread: the rows held from failure 1 are held again (a hold is not a one-poll thing).
    page = viewAfterPoll(page, polled({ boards_unread: [A], needs_you: [row(BAD, "unscheduled")], now: "2026-11-19T18:02:00.000Z" }));
    expect(page.needs_you.filter((r) => r.key.startsWith(A)), "failure 2 holds them again").toEqual(aRows);
    expect(page.needs_you, "one row each, never doubled by holding twice").toHaveLength(3);
    // The answer: A's lister reads, and A's board was settled meanwhile - the row is GONE, not kept.
    page = viewAfterPoll(page, polled({ boards_unread: [], needs_you: [boardRow(A, "board_flagged", "fa2"), row(BAD, "unscheduled")], now: "2026-11-19T18:03:00.000Z" }));
    expect(keys(page).sort(), "the settled held board's row is gone with the failure; the still-flagged one is the poll's").toEqual([needsYouKey(A, "board_flagged", "fa2"), needsYouKey(BAD, "unscheduled")].sort());
  });

  it("a Settle followed by a good poll: the row is gone (nothing stale survives the next read that answers)", () => {
    // The row was held across a failure; the board is then settled; the poll after answers whole.
    let page = viewAfterPoll(had(), polled({ boards_unread: [A], needs_you: [] }));
    expect(keys(page).filter((k) => k.startsWith(A)), "premise: the row is held while the lister is down").toHaveLength(2);
    const good = polled({ boards_unread: [], needs_you: [] });
    page = viewAfterPoll(page, good);
    expect(page, "the good poll is taken whole").toBe(good);
    expect(page.needs_you.filter((r) => r.kind === "board_held" || r.kind === "board_flagged"), "no board row is left").toEqual([]);
  });
});
