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
  CHECKIN_EXTEND_STEP_MINUTES,
  EXTEND_REFUSALS,
  EXTEND_REFUSAL_CODES,
  EXTEND_REFUSAL_KEYS,
  type CheckinExtendRoundResult,
} from "@/lib/checkin-extend";
import {
  codeOf,
  extendBoardLabel,
  extendBoardPath,
  extendBoardSentence,
  extendClosesLine,
  extendFailureText,
  extendRoundLabel,
  extendRoundLines,
  extendRoundPath,
  initialRoundExtend,
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
