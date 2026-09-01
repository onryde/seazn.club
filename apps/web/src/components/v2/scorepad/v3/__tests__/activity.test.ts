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
  priorActivityEvents,
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

// R2b (owner request — "show when the bowler changed"): the previous-event
// lookup a skin's `activityDetail` needs to detect a change across
// consecutive events. Two traps this pins directly: `orderedActivity`
// renders NEWEST FIRST, so "previous" (older) is `rows[index + 1]`, never
// `rows[index - 1]`; and a voided row must never stand in as "the
// previous" event.
//
// R2b-cricket-over review fix (item 2): `previousActivityEvent` (the
// single-item lookup these tests used to call directly) is DELETED —
// review proved it was always exactly `priorActivityEvents`'s own last
// element (both walk `rows[index + 1..]`, skipping voided; the only
// difference was direction/stopping point). These tests port the same
// reversed-order and voided-skip traps onto the SURVIVING function,
// reading its own last element where `previousActivityEvent` used to
// return a single value directly — `priorActivityEvents`'s own return
// shape carries `{type, payload}`, not `id`, so fixtures below distinguish
// rows by a payload marker instead of by id.
describe("priorActivityEvents", () => {
  it("its LAST element is rows[index + 1] — the OLDER neighbour — never rows[index - 1]", () => {
    // Oldest → newest: a, b, c. orderedActivity reverses this to [c, b, a].
    const a = ev({ id: "a", seq: 1, payload: { bowler: "OLDEST" } });
    const b = ev({ id: "b", seq: 2, payload: { bowler: "MIDDLE" } });
    const c = ev({ id: "c", seq: 3, payload: { bowler: "NEWEST" } });
    const rows = orderedActivity([a, b, c]); // [c, b, a]
    // b sits at rows[1]. Its correct OLDER neighbour is a (rows[2]).
    // Picking rows[index - 1] instead would wrongly surface c (rows[0]) — a
    // different, detectably wrong event, which is why this fixture uses
    // three DISTINCT payloads rather than two.
    const history = priorActivityEvents(rows, 1);
    const prev = history[history.length - 1];
    expect(prev?.payload.bowler).toBe("OLDEST");
    expect(prev?.payload.bowler).not.toBe("NEWEST");
  });

  it("skips a voided row to reach the real previous ball beneath it", () => {
    // Oldest → newest: b1 (real prev), b2 (later voided), b3 (current),
    // then the void event itself — recorded AFTER b3, a realistic sequence
    // (a scorer can notice and undo an older mistake after later balls
    // have already been bowled).
    const b1 = ev({ id: "b1", seq: 1, payload: { bowler: "REAL_PREV" } });
    const b2 = ev({ id: "b2", seq: 2, payload: { bowler: "VOIDED_BOWLER" } });
    const b3 = ev({ id: "b3", seq: 3, payload: { bowler: "CURRENT" } });
    const voidEvt = ev({ id: "v1", seq: 4, type: "core.void", voids: "b2" });
    const rows = orderedActivity([b1, b2, b3, voidEvt]); // [v1, b3, b2, b1]
    const b3Index = rows.findIndex((r) => r.id === "b3");
    // Without the voided-skip this would wrongly end in b2.
    const history = priorActivityEvents(rows, b3Index);
    expect(history[history.length - 1]?.payload.bowler).toBe("REAL_PREV");
  });

  it("skips MULTIPLE consecutive voided rows, not just one", () => {
    const real = ev({ id: "real", seq: 1, payload: { bowler: "REAL" } });
    const v2 = ev({ id: "v2", seq: 2, payload: { bowler: "V2" } });
    const v3 = ev({ id: "v3", seq: 3, payload: { bowler: "V3" } });
    const current = ev({ id: "current", seq: 4, payload: { bowler: "CURRENT" } });
    const void2 = ev({ id: "void2", seq: 5, type: "core.void", voids: "v2" });
    const void3 = ev({ id: "void3", seq: 6, type: "core.void", voids: "v3" });
    const rows = orderedActivity([real, v2, v3, current, void2, void3]);
    const currentIndex = rows.findIndex((r) => r.id === "current");
    const history = priorActivityEvents(rows, currentIndex);
    expect(history[history.length - 1]?.payload.bowler).toBe("REAL");
  });

  it("is empty at the oldest row — nothing before it", () => {
    const a = ev({ id: "a", seq: 1 });
    const b = ev({ id: "b", seq: 2 });
    const rows = orderedActivity([a, b]); // [b, a]
    expect(priorActivityEvents(rows, 1)).toEqual([]);
  });

  it("is empty when every older row is voided", () => {
    const onlyPrev = ev({ id: "p", seq: 1 });
    const current = ev({ id: "c", seq: 2 });
    const voidEvt = ev({ id: "v", seq: 3, voids: "p" });
    const rows = orderedActivity([onlyPrev, current, voidEvt]); // [v, c, p]
    const currentIndex = rows.findIndex((r) => r.id === "c");
    expect(priorActivityEvents(rows, currentIndex)).toEqual([]);
  });
});

// R2b — proves the WIRING, not just the pure helper above: ActivityPanel
// itself must compute and pass `history` to `resolveDetail` correctly. A
// helper that works in isolation but is never actually threaded through
// the render is the exact "unit-tested, product-inert" shape this whole
// panel's D1-D3 sign-off review already found three times.
//
// R2b-cricket-over review fix (item 2): renamed from "prev wiring" —
// `resolveDetail`'s own 3rd parameter is now `history`, not a separate
// `prev`; these tests check `history`'s own LAST element instead of a
// dedicated 3rd-argument value, preserving the exact same reversed-order
// and voided-skip trap coverage the original "prev wiring" tests pinned.
describe("ActivityPanel — history wiring (R2b)", () => {
  it("calls resolveDetail with a history array whose LAST element is the OLDER neighbour, not the array-adjacent-by-index-minus-one row", () => {
    const oldest = ev({ id: "oldest", seq: 1, payload: { bowler: "OLDEST" } });
    const middle = ev({ id: "middle", seq: 2, payload: { bowler: "MIDDLE" } });
    const newest = ev({ id: "newest", seq: 3, payload: { bowler: "NEWEST" } });
    const calls: Array<{
      payload: Record<string, unknown>;
      history?: readonly { type: string; payload: Record<string, unknown> }[];
    }> = [];
    const resolveDetail = (
      _type: string,
      payload: Record<string, unknown>,
      history?: readonly { type: string; payload: Record<string, unknown> }[],
    ): string | undefined => {
      calls.push({ payload, history });
      return undefined;
    };
    ActivityPanel({
      events: [oldest, middle, newest],
      ownEventIds: NO_IDS,
      deviceLinkId: null,
      personNames: {},
      t: T,
      resolveDetail,
    });
    const middleCall = calls.find((c) => c.payload.bowler === "MIDDLE");
    const prev = middleCall?.history?.[middleCall.history.length - 1];
    expect(prev?.payload.bowler).toBe("OLDEST");
    expect(prev?.payload.bowler).not.toBe("NEWEST");
  });

  it("skips a voided row when resolving the nearest-older event for the row above it", () => {
    const real = ev({ id: "real", seq: 1, payload: { bowler: "REAL" } });
    const voided = ev({ id: "voided", seq: 2, payload: { bowler: "VOIDED" } });
    const current = ev({ id: "current", seq: 3, payload: { bowler: "CURRENT" } });
    const voidEvt = ev({ id: "v", seq: 4, type: "core.void", voids: "voided" });
    const calls: Array<{
      payload: Record<string, unknown>;
      history?: readonly { type: string; payload: Record<string, unknown> }[];
    }> = [];
    const resolveDetail = (
      _type: string,
      payload: Record<string, unknown>,
      history?: readonly { type: string; payload: Record<string, unknown> }[],
    ): string | undefined => {
      calls.push({ payload, history });
      return undefined;
    };
    ActivityPanel({
      events: [real, voided, current, voidEvt],
      ownEventIds: NO_IDS,
      deviceLinkId: null,
      personNames: {},
      t: T,
      resolveDetail,
    });
    const currentCall = calls.find((c) => c.payload.bowler === "CURRENT");
    const prev = currentCall?.history?.[currentCall.history.length - 1];
    expect(prev?.payload.bowler).toBe("REAL");
  });

  it("passes an empty history for the oldest row", () => {
    const only = ev({ id: "only", seq: 1, payload: { bowler: "ONLY" } });
    const calls: Array<{ history?: readonly { type: string; payload: Record<string, unknown> }[] }> = [];
    const resolveDetail = (
      _type: string,
      _payload: Record<string, unknown>,
      history?: readonly { type: string; payload: Record<string, unknown> }[],
    ): string | undefined => {
      calls.push({ history });
      return undefined;
    };
    ActivityPanel({
      events: [only],
      ownEventIds: NO_IDS,
      deviceLinkId: null,
      personNames: {},
      t: T,
      resolveDetail,
    });
    expect(calls[0]?.history).toEqual([]);
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

// R7-42/F (ruling on P-5, `_INDEX.md`): "label the stat as partial wherever
// it surfaces" — the honest-ledger half of the fix. `isPartial` mirrors
// `resolveDetail`'s own shape (a per-row resolver the caller supplies,
// this panel stays sport-agnostic) rather than a boolean on `ActivityEvent`
// itself, for the identical reason `resolveDetail` is a function and not a
// precomputed string: the panel never derives sport vocabulary, the caller
// (pad-host.tsx's `isPartialDockAnswer`) does.
const T_PARTIAL: MsgFn = ((key: string, vars?: Record<string, string | number>) => {
  if (key === "pad.ribbon.fallback") return `${vars!.event} recorded`;
  if (key === "pad.activity.heading") return "Activity";
  if (key === "pad.activity.empty") return "Nothing recorded yet.";
  if (key === "pad.activity.partial") return "Partial";
  return String(key);
}) as MsgFn;

describe("ActivityPanel — partial rows (R7-42/F)", () => {
  it("renders the partial badge only for a row isPartial flags true", () => {
    const answered = ev({ id: "r1", type: "badminton.rally", payload: { wonBy: "home", scorer: "a" } });
    const unanswered = ev({ id: "r2", type: "badminton.rally", payload: { wonBy: "away" } });
    const tree = ActivityPanel({
      events: [answered, unanswered],
      ownEventIds: NO_IDS,
      deviceLinkId: null,
      personNames: {},
      t: T_PARTIAL,
      isPartial: (_type, payload) => payload.scorer === undefined,
    });
    const rows = rowTexts(tree);
    // orderedActivity reverses (newest first) — row 0 is r2, the UNANSWERED
    // rally submitted last; row 1 is r1, the answered one.
    expect(rows[0]).toContain("Partial");
    expect(rows[1]).not.toContain("Partial");
  });

  it("WITHOUT isPartial, no row ever carries the badge — additive, zero change for every existing caller", () => {
    const events = [ev({ id: "r1", type: "badminton.rally", payload: { wonBy: "home" } })];
    const tree = ActivityPanel({
      events,
      ownEventIds: NO_IDS,
      deviceLinkId: null,
      personNames: {},
      t: T_PARTIAL,
    });
    expect(rowTexts(tree)[0]).not.toContain("Partial");
  });
});
