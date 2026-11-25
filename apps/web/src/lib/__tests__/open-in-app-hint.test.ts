// The line beside a stream "Open in app" button (spec 2026-11-25 §5.4): the app's own Go live is refused without a
// destination or a credit, so the page names what it KNOWS is missing, destination first. The fixture panel's inputs are
// derived from what that panel already gates its own Go live on — and an open session has already taken both, so nothing
// is missing then, whatever the projected balance says (the credit it consumed reads as 0 mid-stream).
import { describe, expect, it } from "vitest";
import { streamHintKey, streamHintNeeds } from "../open-in-app-hint";
import { phoneTabState } from "../stream-session-view";

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
  const idle = { sessionOpen: false, selectedTargetId: "t1", balance: 3, freeRestart: false };

  it("before a session: the picked destination, and a credit or a free restart", () => {
    expect(streamHintNeeds(idle)).toEqual({ hasDestination: true, hasCredit: true });
    expect(streamHintNeeds({ ...idle, selectedTargetId: null })).toEqual({ hasDestination: false, hasCredit: true });
    expect(streamHintNeeds({ ...idle, selectedTargetId: "" })).toEqual({ hasDestination: false, hasCredit: true });
    expect(streamHintNeeds({ ...idle, balance: 0 })).toEqual({ hasDestination: true, hasCredit: false });
    expect(streamHintNeeds({ ...idle, balance: 1 })).toEqual({ hasDestination: true, hasCredit: true });
    expect(streamHintNeeds({ ...idle, balance: 0, freeRestart: true })).toEqual({ hasDestination: true, hasCredit: true });
  });

  it("with a session open nothing is missing: it was admitted with both — counted over every open state", () => {
    // The open states come from the panel's own state machine, not a list typed here.
    const open = ["provisioning", "warming", "live", "ending"] as const;
    let checked = 0;
    for (const state of open) {
      expect(phoneTabState({ state } as never), "premise: the panel names this state").toBe(state);
      expect(streamHintNeeds({ sessionOpen: true, selectedTargetId: null, balance: 0, freeRestart: false }), state)
        .toEqual({ hasDestination: true, hasCredit: true });
      checked += 1;
    }
    expect(checked).toBe(4);
  });
});
