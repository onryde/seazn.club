// Spec 2026-10-09 §3.2.2 - the check-in extension's client half: the words (from the dictionary, never typed into the test), the
// round press's tiny reducer and its runner. The board's press lives in arbiter-decision.ts, the Open round control's in
// desk/open-round-state.ts; each is tested beside its reducer.
import { describe, expect, it, vi } from "vitest";
import { ApiV1Error } from "@/lib/client-v1";
import en from "@/dictionaries/en/ui.json";
import fr from "@/dictionaries/fr/ui.json";
import { plural as pluralRuntime, t as tRuntime } from "@/lib/i18n-runtime";
import type { Dict } from "@/lib/i18n-constants";
import {
  CHECKIN_EXTEND_MAX,
  CHECKIN_EXTEND_STEP_MINUTES,
  EXTEND_REFUSALS,
  EXTEND_REFUSAL_CODES,
  EXTEND_REFUSAL_KEYS,
  type CheckinExtendRoundResult,
  type CheckinExtendState,
} from "@/lib/checkin-extend";
import {
  boardExtendOffer,
  codeOf,
  extendBoardLabel,
  extendBoardPath,
  extendBoardSentence,
  extendClosesLine,
  extendFailureText,
  extendHelperLine,
  extendRoundLabel,
  extendRoundLines,
  extendRoundPath,
  extendWhyLine,
  extendedNoticeTime,
  initialRoundExtend,
  laterIso,
  linkedExtendDispatch,
  liveExtendableBoards,
  roundExtendRunner,
  roundExtendUi,
  type ExtendCopy,
  type RoundExtendAction,
} from "../checkin-extend-ui";

const copyOf = (dict: Record<string, string>, hm: (iso: string) => string | null = () => "19:55"): ExtendCopy => ({
  t: (key, vars) => tRuntime(dict as unknown as Dict, key, vars),
  plural: (key, count, vars) => pluralRuntime(dict as unknown as Dict, key, count, "en", vars),
  hm,
});
const EN = en as Record<string, string>;
const C = copyOf(EN);
const R = (over: Partial<CheckinExtendRoundResult> = {}): CheckinExtendRoundResult => ({
  extended: 0,
  skipped: { closed: 0, gameStarted: 0, capReached: 0 },
  notOpenYet: 0,
  ownBoards: 0,
  failed: 0,
  addedMinutes: CHECKIN_EXTEND_STEP_MINUTES,
  ...over,
});

describe("the words", () => {
  it("paths are the routes' own, ids encoded", () => {
    expect(extendBoardPath("f 1")).toBe("/api/v1/fixtures/f%201/external-play/extend-checkin");
    expect(extendRoundPath("s/1")).toBe("/api/v1/stages/s%2F1/extend-checkin");
  });

  it("labels carry the step from the vocabulary and the presses left", () => {
    expect(extendBoardLabel(2, C)).toBe(EN["externalPlay.checkinExtend.board"]!.replace("{minutes}", String(CHECKIN_EXTEND_STEP_MINUTES)).replace("{left}", "2"));
    expect(extendBoardLabel(2, C)).toContain("2");
    expect(extendRoundLabel(C)).toBe(EN["externalPlay.checkinExtend.round"]!.replace("{minutes}", String(CHECKIN_EXTEND_STEP_MINUTES)));
    expect(extendBoardLabel(2, copyOf(fr as Record<string, string>)), "another locale").not.toBe(extendBoardLabel(2, C));
  });

  it("the closing time is said once the viewer's clock is known - never before", () => {
    expect(extendClosesLine("2026-10-19T19:55:00.000Z", C)).toBe(EN["externalPlay.checkinExtend.closesAt"]!.replace("{time}", "19:55"));
    expect(extendClosesLine("2026-10-19T19:55:00.000Z", copyOf(EN, () => null)), "before mount").toBeNull();
  });

  it("a board's answer names the board and the new time", () => {
    const sentence = extendBoardSentence({ fixtureId: "f1", extensions: 1, extensionsLeft: 2, addedMinutes: 5, deadlineAt: "2026-10-19T19:55:00.000Z" }, 7, C);
    expect(sentence).toBe(EN["externalPlay.checkinExtend.notice.board"]!.replace("{minutes}", "5").replace("{n}", "7").replace("{time}", "19:55"));
  });

  it("the round's answer: one head line, then ONE line per reason that happened - the empty case first", () => {
    expect(extendRoundLines(R(), C), "nothing extended, nothing skipped").toEqual([EN["externalPlay.checkinExtend.notice.roundNone"]!]);
    expect(extendRoundLines(R({ extended: 1 }), C)).toEqual([EN["externalPlay.checkinExtend.notice.round.one"]!.replace("{minutes}", "5").replace("{count}", "1")]);
    expect(extendRoundLines(R({ extended: 6, skipped: { closed: 0, gameStarted: 2, capReached: 0 } }), C)).toEqual([
      "Added 5 minutes to 6 boards.",
      EN["externalPlay.checkinExtend.skip.gameStarted.other"]!.replace("{count}", "2"),
    ]);
    const all = extendRoundLines(R({ extended: 2, skipped: { closed: 1, gameStarted: 2, capReached: 3 }, notOpenYet: 4, ownBoards: 5, failed: 6 }), C);
    expect(all).toHaveLength(7);
    expect(all.slice(1).map((l) => Number(l.match(/\d+/)![0])), "in the order the line says them").toEqual([1, 2, 3, 4, 5, 6]);
    expect(extendRoundLines(R({ extended: 0, skipped: { closed: 3, gameStarted: 0, capReached: 0 } }), C)).toEqual([
      EN["externalPlay.checkinExtend.notice.roundNone"]!,
      EN["externalPlay.checkinExtend.skip.closed.other"]!.replace("{count}", "3"),
    ]);
  });

  it("each refusal code reads as its own sentence; a code nobody listed reads as a failure, never as the code", () => {
    let checked = 0;
    for (const r of EXTEND_REFUSALS) {
      expect(extendFailureText(EXTEND_REFUSAL_CODES[r], C), r).toBe(EN[EXTEND_REFUSAL_KEYS[r]]);
      checked += 1;
    }
    expect(checked, "anti-vacuity").toBe(EXTEND_REFUSALS.length);
    expect(extendFailureText("ARBITER_PLAYS_THIS_BOARD", C)).toBe(EN["externalPlay.checkinExtend.refused.playsThis"]);
    expect(extendFailureText("ROUND_NOT_OPEN", C)).toBe(EN["externalPlay.checkinExtend.refused.roundNotOpen"]);
    for (const code of ["UNKNOWN", "INTERNAL", ""]) expect(extendFailureText(code, C), code).toBe(EN["externalPlay.checkinExtend.refused.failed"]);
  });

  it("codeOf: an API error's code, anything else UNKNOWN", () => {
    expect(codeOf(new ApiV1Error("x", 409, "CHECKIN_CLOSED"))).toBe("CHECKIN_CLOSED");
    expect(codeOf(new TypeError("network"))).toBe("UNKNOWN");
    expect(codeOf(undefined)).toBe("UNKNOWN");
  });
});

describe("the round press (arbiter panel)", () => {
  const s0 = initialRoundExtend();
  const run = (...a: RoundExtendAction[]) => a.reduce(roundExtendUi, s0);
  const ANSWER: RoundExtendAction = { type: "extendDone", outcome: { ok: true, result: R({ extended: 3 }) } };

  it("the empty case first: nothing pressed, nothing in flight, no answer", () => {
    expect(s0).toEqual({ busy: false, notice: null });
  });

  it("a press is in flight, a second is refused behind it, the answer lands once and a stray one is dropped", () => {
    const busy = run({ type: "extend" });
    expect(busy).toEqual({ busy: true, notice: null });
    expect(roundExtendUi(busy, { type: "extend" })).toBe(busy);
    expect(roundExtendUi(s0, ANSWER), "no press in flight").toBe(s0);
    const done = roundExtendUi(busy, ANSWER);
    expect(done).toEqual({ busy: false, notice: { kind: "answered", result: R({ extended: 3 }) } });
    expect(roundExtendUi(done, ANSWER), "a duplicate answer").toBe(done);
  });

  it("a refusal is the notice by its code; the next press clears the answer it replaces", () => {
    const failed = run({ type: "extend" }, { type: "extendDone", outcome: { ok: false, code: "ROUND_NOT_OPEN" } });
    expect(failed).toEqual({ busy: false, notice: { kind: "failed", code: "ROUND_NOT_OPEN" } });
    expect(roundExtendUi(failed, { type: "extend" })).toEqual({ busy: true, notice: null });
  });
});

describe("the round press's runner - at most one request on the network", () => {
  it("a double tap sends ONE request with the round's number; its answer is dispatched and the page refreshes", async () => {
    const dispatch = vi.fn();
    let answer!: (v: unknown) => void;
    const post = vi.fn(() => new Promise((r) => (answer = r)));
    const refresh = vi.fn();
    const runner = roundExtendRunner({ dispatch, post, refresh });
    const first = runner.extend("s1", 3);
    expect(await runner.extend("s1", 3), "the second tap").toBe(false);
    expect(post).toHaveBeenCalledTimes(1);
    expect(post).toHaveBeenCalledWith("/api/v1/stages/s1/extend-checkin", { roundNo: 3 });
    const result = R({ extended: 4 });
    answer(result);
    expect(await first).toBe(true);
    expect(dispatch.mock.calls.map((c) => c[0])).toEqual([{ type: "extend" }, { type: "extendDone", outcome: { ok: true, result } }]);
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it("a refusal dispatches the door's CODE and refreshes nothing; a thrown non-API error is UNKNOWN; the runner is free after each", async () => {
    const dispatch = vi.fn();
    const post = vi
      .fn()
      .mockRejectedValueOnce(new ApiV1Error("x", 409, "ROUND_NOT_OPEN"))
      .mockRejectedValueOnce(new TypeError("fetch failed"))
      .mockResolvedValueOnce(R());
    const refresh = vi.fn();
    const runner = roundExtendRunner({ dispatch, post, refresh });
    await runner.extend("s1", 1);
    expect(dispatch).toHaveBeenLastCalledWith({ type: "extendDone", outcome: { ok: false, code: "ROUND_NOT_OPEN" } });
    await runner.extend("s1", 1);
    expect(dispatch).toHaveBeenLastCalledWith({ type: "extendDone", outcome: { ok: false, code: "UNKNOWN" } });
    expect(refresh).not.toHaveBeenCalled();
    expect(await runner.extend("s1", 1)).toBe(true);
    expect(refresh).toHaveBeenCalledTimes(1);
  });
});

// ── the ticking-clock pieces (owner, 2026-10-19) ─────────────────────────────────────────────────────────────────────────────────
describe("what a board's +5 is on a ticking clock", () => {
  const OPENS = Date.parse("2026-10-19T12:00:00.000Z");
  const CLOSES = OPENS + 20 * 60_000;
  const snap = (over: Partial<CheckinExtendState> = {}): CheckinExtendState => ({
    canExtend: true,
    refusal: null,
    extensionsLeft: 2,
    opensAt: new Date(OPENS).toISOString(),
    deadlineAt: new Date(CLOSES).toISOString(),
    ...over,
  });

  it("boardExtendOffer: no check-in, no offer; a null clock keeps the server's word; a clock re-judges the window", () => {
    expect(boardExtendOffer(null, OPENS), "the empty case").toBeNull();
    expect(boardExtendOffer(snap(), null)).toEqual({ refusal: null, offered: true });
    expect(boardExtendOffer(snap({ canExtend: false, refusal: "not_open" }), null), "no clock: the snapshot's reason").toEqual({ refusal: "not_open", offered: false });
    expect(boardExtendOffer(snap({ canExtend: false, refusal: "not_open" }), OPENS)).toEqual({ refusal: null, offered: true });
    expect(boardExtendOffer(snap(), CLOSES)).toEqual({ refusal: "closed", offered: false });
  });

  it("liveExtendableBoards: the boards the clock still allows; the server's count only while the clock is unknown", () => {
    const boards = [{ checkin: snap() }, { checkin: snap({ deadlineAt: new Date(OPENS + 60_000).toISOString() }) }, { checkin: null }];
    expect(liveExtendableBoards([], OPENS, 7), "the empty case: no boards, the clock known").toBe(0);
    expect(liveExtendableBoards(boards, null, 7), "no clock: the snapshot's count").toBe(7);
    expect(liveExtendableBoards(boards, OPENS + 59_999, 7)).toBe(2);
    expect(liveExtendableBoards(boards, OPENS + 60_000, 7), "the second board's deadline: it leaves").toBe(1);
    expect(liveExtendableBoards(boards, CLOSES, 7)).toBe(0);
  });

  it("the answer's time is never earlier than the board's own line: the later of the press's and the live deadline", () => {
    const a = "2026-10-19T12:55:00.000Z";
    const b = "2026-10-19T13:00:00.000Z";
    expect(laterIso(a, b)).toBe(b);
    expect(laterIso(b, a)).toBe(b);
    expect(laterIso(a, a)).toBe(a);
    expect(extendedNoticeTime(a, null), "no live board: the press's own").toBe(a);
    expect(extendedNoticeTime(a, b), "extended since: the live one").toBe(b);
    expect(extendedNoticeTime(b, a), "the refresh has not landed: the press's own").toBe(b);
    const sentence = extendBoardSentence(
      { fixtureId: "f", extensions: 1, extensionsLeft: 2, addedMinutes: 5, deadlineAt: a },
      3,
      copyOf(EN, (iso) => iso.slice(11, 16)),
      b,
    );
    expect(sentence, "the sentence names the live time").toContain("13:00");
    expect(sentence).not.toContain("12:55");
  });

  it("the helper line carries the step and the cap from the constants; the reason line has words for four refusals and silence for a board that is over", () => {
    expect(extendHelperLine(C)).toBe(`Adds ${CHECKIN_EXTEND_STEP_MINUTES} minutes while check-in is open. Up to ${CHECKIN_EXTEND_MAX} times per board.`);
    const said = EXTEND_REFUSALS.map((r) => extendWhyLine(r, C));
    expect(said.filter((x) => x !== null), "anti-vacuity: four reasons").toHaveLength(4);
    expect(extendWhyLine("not_playable", C)).toBeNull();
    expect(said.filter((x) => x !== null).sort()).toEqual(
      ["Can't extend check-in yet: it hasn't opened", "Can't extend check-in: it has closed", "Can't extend check-in: a game has started", "Can't extend check-in: no extensions left"].sort(),
    );
  });

  it("the round reducer's clear: drops the answer and nothing else, and is a no-op with nothing to drop", () => {
    const answered = { busy: false, notice: { kind: "failed", code: "X" } } as const;
    expect(roundExtendUi(answered, { type: "clear" })).toEqual({ busy: false, notice: null });
    const idle = initialRoundExtend();
    expect(roundExtendUi(idle, { type: "clear" })).toBe(idle);
    expect(roundExtendUi({ busy: true, notice: null }, { type: "clear" }).busy).toBe(true);
  });
});

describe("linkedExtendDispatch - the two presses clear each other's answer", () => {
  const rig = () => {
    const board = vi.fn();
    const round = vi.fn();
    return { board, round, ...linkedExtendDispatch<{ type: string }>(board, round) };
  };

  it("a board's press starting clears the round's answer; its other actions touch nothing else", () => {
    const l = rig();
    l.forBoard({ type: "extend" });
    expect(l.round.mock.calls, "the round's answer is cleared").toEqual([[{ type: "clear" }]]);
    expect(l.board.mock.calls, "and the board's own action still goes through").toEqual([[{ type: "extend" }]]);
    l.round.mockClear();
    l.forBoard({ type: "resync" });
    l.forBoard({ type: "extendDone" });
    expect(l.round.mock.calls, "only the START of an extend clears the other").toEqual([]);
    expect(l.board.mock.calls.length).toBe(3);
  });

  it("the round's press starting clears the board's answer, and only its start does", () => {
    const l = rig();
    l.forRound({ type: "extend" });
    expect(l.board.mock.calls).toEqual([[{ type: "clearExtend" }]]);
    expect(l.round.mock.calls).toEqual([[{ type: "extend" }]]);
    l.board.mockClear();
    l.forRound({ type: "extendDone", outcome: { ok: false, code: "X" } });
    l.forRound({ type: "clear" });
    expect(l.board.mock.calls, "an answer arriving, or a clear, does not clear the board's").toEqual([]);
    expect(l.round.mock.calls.length).toBe(3);
  });
});
