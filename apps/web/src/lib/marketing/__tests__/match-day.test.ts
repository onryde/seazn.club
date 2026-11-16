// The Match Day page's model (match-day.ts). Expected behaviour is the help page's (content/help/scheduling/match-day.md):
// a court with a match playing or called takes no call; a match whose player is on another court cannot be called;
// Undo call puts the match back; a court's phone is on air only while a match plays there.
import { describe, expect, it } from "vitest";
import { MATCHES, blockedBy, call, nextFor, openingDay, result, start, streamOf, undoCall, type DayState } from "../match-day";

const kinds = (s: DayState) => s.courts.map((c) => c.kind);
const on = (s: DayState, court: number) => { const c = s.courts[court]!; return c.kind === "free" ? null : c.match; };

describe("match day model", () => {
  it("opens with three courts, one match playing and four waiting, and no team listed twice in a match", () => {
    const s = openingDay();
    expect(kinds(s)).toEqual(["playing", "free", "free"]);
    expect(s.waiting).toHaveLength(4);
    expect(s.done).toEqual([]);
    expect(s.last).toBeNull();
    const ids = [on(s, 0)!, ...s.waiting];
    expect(new Set(ids).size).toBe(5);
    for (const id of ids) expect(MATCHES[id]!.a, id).not.toBe(MATCHES[id]!.b);
  });

  it("calling a free court takes the first waiting match and marks the court called", () => {
    const s0 = openingDay();
    const first = s0.waiting[0]!;
    const s = call(s0, 1);
    expect(s.courts[1]).toEqual({ kind: "called", match: first });
    expect(s.waiting).toEqual(s0.waiting.slice(1));
    expect(s.last).toEqual({ type: "call", court: 1, match: first });
  });

  it("a court with a match playing or called takes no call", () => {
    const s0 = openingDay();
    expect(call(s0, 0)).toBe(s0);
    const s1 = call(s0, 1);
    expect(call(s1, 1)).toBe(s1);
  });

  it("a match whose team is on another court is passed over, and can be called once that court's result is in", () => {
    const s0 = openingDay();
    // Premise: some waiting match shares a team with the one playing on the first court, and it is not the first in line.
    const clash = s0.waiting.find((id) => blockedBy(s0, id) !== null)!;
    expect(clash).toBeDefined();
    expect(blockedBy(s0, clash)).toBe(0);
    expect(s0.waiting.indexOf(clash)).toBe(1);
    const s2 = call(call(s0, 1), 2);
    expect(on(s2, 2)).not.toBe(clash);
    expect(on(s2, 2)).toBe(s0.waiting[2]);
    expect(s2.waiting[0]).toBe(clash);
    // First in line, yet still not the one a call would take: the last match is.
    expect(nextFor(s2)).toBe(s0.waiting[3]);
    const freed = result(s2, 0);
    expect(blockedBy(freed, clash)).toBeNull();
    expect(on(call(freed, 0), 0)).toBe(clash);
  });

  it("the scorer starts a called match, a result frees the court, and neither works out of turn", () => {
    const s0 = openingDay();
    expect(start(s0, 1)).toBe(s0);
    expect(result(s0, 1)).toBe(s0);
    const called = call(s0, 1);
    expect(result(called, 1)).toBe(called);
    const playing = start(called, 1);
    expect(playing.courts[1]!.kind).toBe("playing");
    expect(start(playing, 1)).toBe(playing);
    const over = result(playing, 1);
    expect(over.courts[1]).toEqual({ kind: "free" });
    expect(over.done).toEqual([on(playing, 1)]);
    expect(over.last?.type).toBe("result");
  });

  it("undo call puts the match back first in line, and only a called court can be undone", () => {
    const s0 = openingDay();
    const called = call(s0, 1);
    const back = undoCall(called, 1);
    expect(back.courts[1]).toEqual({ kind: "free" });
    expect(back.waiting).toEqual(s0.waiting);
    expect(undoCall(s0, 0)).toBe(s0);
    expect(undoCall(s0, 1)).toBe(s0);
    // Call again after an undo: the same match comes back.
    expect(on(call(back, 1), 1)).toBe(s0.waiting[0]);
  });

  it("a court's phone is on air only while a match plays there, and a court with no phone never streams", () => {
    const linked = [true, true, false];
    const s0 = openingDay();
    expect(streamOf(s0, 0, linked)).toBe("live");
    expect(streamOf(s0, 1, linked)).toBe("waiting");
    const called = call(s0, 1);
    expect(streamOf(called, 1, linked)).toBe("waiting");
    const playing = start(called, 1);
    expect(streamOf(playing, 1, linked)).toBe("live");
    expect(streamOf(result(playing, 1), 1, linked)).toBe("waiting");
    const third = start(call(called, 2), 2);
    expect(third.courts[2]!.kind).toBe("playing");
    expect(streamOf(third, 2, linked)).toBe("none");
  });

  it("a whole day: every match is played exactly once and the day ends with every court free", () => {
    let s = openingDay();
    let steps = 0;
    while (s.done.length < 5 && steps < 60) {
      for (let c = 0; c < s.courts.length; c++) {
        const k = s.courts[c]!.kind;
        s = k === "free" ? call(s, c) : k === "called" ? start(s, c) : result(s, c);
        steps++;
      }
    }
    expect(s.done).toHaveLength(5);
    expect(new Set(s.done).size).toBe(5);
    expect(s.waiting).toEqual([]);
    expect(kinds(s)).toEqual(["free", "free", "free"]);
    expect(call(s, 0)).toBe(s);
  });
});
