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
  isVoidableEventType,
  orderedActivity,
  ACTIVITY_SCROLL_AFTER_ROWS,
  ActivityPanel,
  type ActivityEvent,
} from "../activity";
import { propsOf, textOf, walk } from "@/components/__tests__/_hook-harness";
import type { MsgFn } from "../ribbon";

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

// D3 fix (sign-off review, 2026-08-17): a real screenshot showed a "Void"
// button on `core.start`'s row that always fails server-side (voiding it
// strands any later event that needed `state.phase !== "pre"` — proven via
// `cricket.ts`'s own `apply()`, which throws WRONG_PHASE for `cricket.ball`
// once `core.start` is missing from the fold; see `isVoidableEventType`'s
// own doc in activity.tsx for the full chain). Fixed with an ALLOWLIST
// (fails safe), not a denylist of just the one example a screenshot caught.
describe("isVoidableEventType", () => {
  it("any non-core (sport) event type is voidable — this panel's whole reason to exist", () => {
    expect(isVoidableEventType("cricket.ball")).toBe(true);
    expect(isVoidableEventType("football.goal")).toBe(true);
  });

  it("core.note and core.award are voidable — the engine documents both as having NO state effect", () => {
    expect(isVoidableEventType("core.note")).toBe(true);
    expect(isVoidableEventType("core.award")).toBe(true);
  });

  it.each([
    "core.start",
    "core.void",
    "core.forfeit",
    "core.abandon",
    "core.finalize",
    "core.suspend",
    "core.resume",
    "core.lineup.substitution",
    "core.lineup.replacement",
    "core.lineup.position",
    "core.lineup.retirement",
    "core.lineup.entry",
  ])("%s is NOT voidable — every other core.* type is excluded, allowlist-style, even ones never proven unsafe", (type) => {
    expect(isVoidableEventType(type)).toBe(false);
  });
});

describe("activityRowState — which event types may be voided (D3)", () => {
  it("core.start is never voidable, even when every other gate (owned, not-already-voided, voiding enabled) is satisfied", () => {
    const start = ev({ id: "s", type: "core.start" });
    const ball = ev({ id: "b", type: "cricket.ball" });
    // A realistic ledger: start, then a ball already recorded after it —
    // exactly the shape the screenshot showed (start's Void always failing
    // once balls exist).
    const state = activityRowState(start, [start, ball], NO_IDS, null, true);
    expect(state.voided).toBe(false);
    expect(state.ownedByMe).toBe(true);
    expect(state.canVoid).toBe(false);
  });

  it("core.note and core.award ARE offered Void — the allowlist's two safe exceptions", () => {
    const note = ev({ id: "n", type: "core.note" });
    const award = ev({ id: "a", type: "core.award" });
    expect(activityRowState(note, [note], NO_IDS, null, true).canVoid).toBe(true);
    expect(activityRowState(award, [award], NO_IDS, null, true).canVoid).toBe(true);
  });

  it("composes with device-link ownership — a device link's OWN core.start still cannot be voided (the type gate and the ownership gate are ANDed, neither overrides the other)", () => {
    const start = ev({ id: "s", type: "core.start" });
    const own = new Set(["s"]);
    const state = activityRowState(start, [start], own, "dl-1", true);
    expect(state.ownedByMe).toBe(true); // this device link DID record it…
    expect(state.canVoid).toBe(false); // …but the type gate still refuses it
  });

  it("the pre-existing 'device link may only void its own events' rule still holds, unchanged by the type gate", () => {
    const mine = ev({ id: "mine" });
    const theirs = ev({ id: "theirs" });
    const own = new Set(["mine"]);
    expect(activityRowState(theirs, [mine, theirs], own, "dl-1", true).canVoid).toBe(false);
    expect(activityRowState(mine, [mine, theirs], own, "dl-1", true).canVoid).toBe(true);
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

// D1 + D2, at the RENDERED level: `activityRowState`/`buildRibbon` being
// correct in isolation (ribbon.test.ts) does not prove `ActivityPanel`
// actually wires them up. `ActivityPanel` has no hooks, so it can be called
// directly as a plain function — same shape React itself would call it —
// and its output walked with the shared node-env harness utilities.
const T: MsgFn = ((key: string, vars?: Record<string, string | number>) => {
  if (key === "pad.ribbon.core.start") return "Match started";
  if (key === "pad.ribbon.fallback") return `${vars!.event} recorded`;
  if (key === "pad.ribbon.withDetail") return `${vars!.base} — ${vars!.detail}`;
  if (key === "pad.activity.heading") return "Activity";
  if (key === "pad.activity.empty") return "Nothing recorded yet.";
  return String(key);
}) as MsgFn;

function rowTexts(tree: ReturnType<typeof ActivityPanel>): string[] {
  return walk(tree)
    .filter((el) => propsOf(el)["data-role"] === "v3-activity-row")
    .map((el) => textOf(el));
}

describe("ActivityPanel — rendered captions (D1)", () => {
  it("core.start never renders its raw event type — a real screenshot caught 'core.start recorded'", () => {
    const events: ActivityEvent[] = [ev({ id: "s", type: "core.start" })];
    const tree = ActivityPanel({
      events,
      ownEventIds: NO_IDS,
      deviceLinkId: null,
      personNames: {},
      t: T,
    });
    const text = textOf(tree);
    expect(text).not.toContain("core.start");
    expect(text).toContain("Match started");
  });
});

describe("ActivityPanel — rendered captions (D2)", () => {
  it("two ball rows with DIFFERENT resolveDetail output render DIFFERENT text — the actual defect fix", () => {
    const dot = ev({ id: "b1", type: "cricket.ball", payload: { runs: { bat: 0 } } });
    const four = ev({ id: "b2", type: "cricket.ball", payload: { runs: { bat: 4 } } });
    const resolveDetail = (_type: string, payload: Record<string, unknown>): string => {
      const bat = (payload.runs as { bat?: number } | undefined)?.bat ?? 0;
      return bat === 0 ? "Dot ball" : `${bat} runs`;
    };
    const tree = ActivityPanel({
      events: [dot, four],
      ownEventIds: NO_IDS,
      deviceLinkId: null,
      personNames: {},
      t: T,
      resolveDetail,
    });
    const [texts0, texts1] = rowTexts(tree);
    expect(texts0).not.toBe(texts1);
    expect(rowTexts(tree).some((r) => r.includes("Dot ball"))).toBe(true);
    expect(rowTexts(tree).some((r) => r.includes("4 runs"))).toBe(true);
  });

  it("WITHOUT resolveDetail, two different balls collapse to the SAME text — documents that pad-host.tsx must still wire resolveDetail for this to differentiate in production", () => {
    const dot = ev({ id: "b1", type: "cricket.ball", payload: { runs: { bat: 0 } } });
    const four = ev({ id: "b2", type: "cricket.ball", payload: { runs: { bat: 4 } } });
    const tree = ActivityPanel({
      events: [dot, four],
      ownEventIds: NO_IDS,
      deviceLinkId: null,
      personNames: {},
      t: T,
    });
    const texts = rowTexts(tree);
    expect(texts).toHaveLength(2);
    expect(texts[0]).toBe(texts[1]);
  });
});
