// Sign-off review 2026-08-17. Cricket's flip onto the v3 lane dropped the
// legacy pad's event history AND its per-event void, which on the device-link
// surface was the ONLY way to correct anything once the ~6s hold window
// elapsed (that route mounts no console chrome, so `FixtureConsole`'s "Event
// ledger" section is not there to fall back on).
//
// These cover the rules that decide whether a destructive control is offered.
// Getting `ownedByMe` wrong OVER-GRANTS voiding across device links, so the
// rules are ported verbatim from timeline.tsx:258-261 and pinned here.
import { describe, it, expect } from "vitest";
import {
  activityRowState,
  orderedActivity,
  ACTIVITY_SCROLL_AFTER_ROWS,
  type ActivityEvent,
} from "../activity";

function ev(over: Partial<ActivityEvent> & { id: string }): ActivityEvent {
  return { seq: 1, type: "cricket.ball", payload: {}, voids: null, ...over };
}

const NO_IDS: ReadonlySet<string> = new Set();

describe("activityRowState — void permission", () => {
  it("an in-app scorer (deviceLinkId null) may void an event they did not record", () => {
    const e = ev({ id: "a" });
    const state = activityRowState(e, [e], NO_IDS, null, true);
    expect(state.ownedByMe).toBe(true);
    expect(state.canVoid).toBe(true);
  });

  it("a DEVICE LINK may not void an event it did not record — the rule that must not over-grant", () => {
    const mine = ev({ id: "mine" });
    const theirs = ev({ id: "theirs" });
    const own = new Set(["mine"]);
    expect(activityRowState(theirs, [mine, theirs], own, "dl-1", true).canVoid).toBe(false);
    expect(activityRowState(mine, [mine, theirs], own, "dl-1", true).canVoid).toBe(true);
  });

  it("an already-voided event cannot be voided again, and 'voided' is derived from ANOTHER event pointing back at it", () => {
    const target = ev({ id: "t" });
    const canceller = ev({ id: "v", type: "core.void", voids: "t" });
    const all = [target, canceller];
    const state = activityRowState(target, all, NO_IDS, null, true);
    // Nothing on `target` itself says it is voided — only the canceller does.
    expect(target.voids).toBeNull();
    expect(state.voided).toBe(true);
    expect(state.canVoid).toBe(false);
  });

  it("a core.void event is itself never voidable — there is no un-voiding", () => {
    const canceller = ev({ id: "v", type: "core.void", voids: "t" });
    expect(activityRowState(canceller, [canceller], NO_IDS, null, true).canVoid).toBe(false);
  });

  it("no onVoid handler disables every control, however owned", () => {
    const e = ev({ id: "a" });
    expect(activityRowState(e, [e], new Set(["a"]), "dl-1", false).canVoid).toBe(false);
  });
});

describe("orderedActivity", () => {
  it("is newest-first — a scorer correcting a mistake reaches for the last ball, not the first", () => {
    const a = ev({ id: "a", seq: 1 });
    const b = ev({ id: "b", seq: 2 });
    const c = ev({ id: "c", seq: 3 });
    expect(orderedActivity([a, b, c]).map((e) => e.id)).toEqual(["c", "b", "a"]);
  });

  it("does NOT mutate the caller's list — `pipeline.events` is live and shared with the ribbon", () => {
    const a = ev({ id: "a", seq: 1 });
    const b = ev({ id: "b", seq: 2 });
    const source = [a, b];
    orderedActivity(source);
    expect(source.map((e) => e.id)).toEqual(["a", "b"]);
  });

  it("is total for an empty ledger", () => {
    expect(orderedActivity([])).toEqual([]);
  });
});

describe("scroll threshold", () => {
  it("caps at roughly one over so the current over is visible without scrolling", () => {
    expect(ACTIVITY_SCROLL_AFTER_ROWS).toBe(6);
  });
});
