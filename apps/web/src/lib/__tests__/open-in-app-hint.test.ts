// The line beside a stream "Open in app" button (spec 2026-11-25 §5.4): the app's own Go live is refused without a
// destination or a credit, so the page names what it KNOWS is missing, destination first. The fixture panel's inputs are
// derived from what that panel already gates its own Go live on — and an open session has already taken both, so nothing
// is missing then, whatever the projected balance says (the credit it consumed reads as 0 mid-stream).
import { describe, expect, it } from "vitest";
import { streamHintKey, streamHintNeeds } from "../open-in-app-hint";
import { phoneTabState, STATE_PILL_KEYS, type PhoneTabState } from "../stream-session-view";
import { StreamSessionState } from "@/server/api-v1/schemas";
import { ACTIVE_STATES } from "@/server/relay/domain/session";

describe("streamHintKey", () => {
  it.each([
    [true, true, "openApp.stream.thenGoLive"],
    [false, true, "openApp.stream.needDestination"],
    [false, false, "openApp.stream.needDestination"],
    [true, false, "openApp.stream.needCredit"],
  ])("destination %s, credit %s → %s", (hasDestination, hasCredit, key) => {
    expect(streamHintKey({ hasDestination, hasCredit })).toBe(key);
  });
});

describe("streamHintNeeds (the fixture panel's own facts)", () => {
  const idle = { state: "idle" as PhoneTabState, selectedTargetId: "t1", balance: 3, freeRestart: false };

  it("before a session: the picked destination, and a credit or a free restart", () => {
    expect(streamHintNeeds(idle)).toEqual({ hasDestination: true, hasCredit: true });
    expect(streamHintNeeds({ ...idle, selectedTargetId: null })).toEqual({ hasDestination: false, hasCredit: true });
    expect(streamHintNeeds({ ...idle, selectedTargetId: "" })).toEqual({ hasDestination: false, hasCredit: true });
    expect(streamHintNeeds({ ...idle, balance: 0 })).toEqual({ hasDestination: true, hasCredit: false });
    expect(streamHintNeeds({ ...idle, balance: 1 })).toEqual({ hasDestination: true, hasCredit: true });
    expect(streamHintNeeds({ ...idle, balance: 0, freeRestart: true })).toEqual({ hasDestination: true, hasCredit: true });
  });

  it("with a session open nothing is missing; otherwise the facts answer — over EVERY phone-tab state", () => {
    // Which states are open is the server's statement (`ACTIVE_STATES`: the session was admitted, with a destination
    // and a credit, and has not finished), read over every state the wire declares. No session at all is idle.
    const open = new Map<PhoneTabState, boolean>([[phoneTabState(null), false]]);
    for (const s of StreamSessionState.options) {
      const at = phoneTabState({ state: s });
      const active = ACTIVE_STATES.includes(s);
      expect(open.get(at) ?? active, `${s}: one tab state, one answer`).toBe(active);
      open.set(at, active);
    }
    // `STATE_PILL_KEYS` is a Record over the type, so its keys are every PhoneTabState: a new one cannot be skipped.
    expect([...open.keys()].sort()).toEqual(Object.keys(STATE_PILL_KEYS).sort());

    let checked = 0;
    for (const [state, isOpen] of open) {
      // Nothing held: only an open session may answer "nothing is missing".
      expect(streamHintNeeds({ state, selectedTargetId: null, balance: 0, freeRestart: false }), state)
        .toEqual({ hasDestination: isOpen, hasCredit: isOpen });
      checked += 1;
    }
    expect(checked).toBe(7);
    expect([...open.values()].filter(Boolean), "both answers are exercised").toHaveLength(4);
  });
});
