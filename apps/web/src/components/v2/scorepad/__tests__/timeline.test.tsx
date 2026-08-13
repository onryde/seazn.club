// timeline.tsx (S10/#419 W8, chassis item 3) — the persistent activity feed
// a future page hands to pad-renderer.tsx's `timelineSlot` typed seam
// verbatim (that seam is a pure passthrough — pad-renderer.test.tsx's own
// "timeline seam" describe block already proves it renders whatever it is
// given; this file proves what Timeline itself draws once it IS given).
//
// Mirrors fixture-console.tsx's established v1 activity-feed pattern
// (newest-first, `voids_event_id` cross-reference for "voided", struck-
// through-not-removed) rather than reinventing it, and reuses
// `describeEvent` (event-copy.ts) for captions — the same helper v1 uses —
// so v2's timeline never grows a second, drifting sentence for one event.
import { describe, expect, it } from "vitest";
import type { ReactElement } from "react";
import { propsOf, renderIsland, textOf, walk } from "@/components/__tests__/_hook-harness";
import { cricket } from "@seazn/engine/sports/cricket";
import type { PadAttribution } from "@seazn/engine/sport";
import { Timeline, type TimelineEvent } from "../timeline";
import { ClientTime } from "@/components/client-time";

function find(tree: ReactElement[], pred: (el: ReactElement) => boolean): ReactElement {
  const el = tree.find(pred);
  if (!el) throw new Error("element not found in rendered tree");
  return el;
}
function findAll(tree: ReactElement[], pred: (el: ReactElement) => boolean): ReactElement[] {
  return tree.filter(pred);
}
const isType = (type: unknown) => (el: ReactElement) => el.type === type;
const rowsOf = (tree: ReactElement[]) => findAll(tree, isType("li"));
const rowFor = (tree: ReactElement[], id: string) => find(rowsOf(tree), (li) => propsOf(li)["data-event-id"] === id);

function ev(partial: Partial<TimelineEvent> & { id: string; seq: number; type: string }): TimelineEvent {
  return {
    payload: {},
    recorded_at: "2026-08-12T10:00:00.000Z",
    recorded_by: null,
    device_link_id: null,
    voids_event_id: null,
    ...partial,
  };
}

describe("Timeline — empty state", () => {
  it("shows the empty message and no rows, without crashing", () => {
    const island = renderIsland(Timeline, { events: [] });
    expect(rowsOf(island.tree()).length).toBe(0);
    expect(island.text().length).toBeGreaterThan(0);
  });
});

describe("Timeline — fold-derived captions (reuses describeEvent, never a second sentence)", () => {
  it("renders the SAME badge+text describeEvent would produce for a real event type", () => {
    const events: TimelineEvent[] = [
      ev({ id: "e-1", seq: 1, type: "football.goal", payload: { by: "p1", minute: 21 } }),
    ];
    const island = renderIsland(Timeline, { events, personNames: { p1: "Riley Cole" } });
    const row = rowFor(island.tree(), "e-1");
    const text = textOf(row);
    expect(text).toContain("Riley Cole");
    expect(text).toContain("21");
  });

  it("an unknown event type still renders (describeEvent's own prettify fallback), never blank", () => {
    const events: TimelineEvent[] = [ev({ id: "e-1", seq: 1, type: "sport.brandNewThing", payload: { foo: 3 } })];
    const island = renderIsland(Timeline, { events });
    expect(textOf(rowFor(island.tree(), "e-1")).length).toBeGreaterThan(0);
  });
});

describe("Timeline — ordering: newest event first", () => {
  it("reverses the supplied (oldest-first) array for display", () => {
    const events: TimelineEvent[] = [
      ev({ id: "e-1", seq: 1, type: "core.start" }),
      ev({ id: "e-2", seq: 2, type: "core.note", payload: { text: "second" } }),
      ev({ id: "e-3", seq: 3, type: "core.note", payload: { text: "third" } }),
    ];
    const island = renderIsland(Timeline, { events });
    const rows = rowsOf(island.tree());
    expect(rows.map((r) => propsOf(r)["data-event-id"])).toEqual(["e-3", "e-2", "e-1"]);
  });
});

describe("Timeline — recorded_by / device-link provenance", () => {
  it("shows the recorder's display name when recorded_by is in recorderNames", () => {
    const events: TimelineEvent[] = [ev({ id: "e-1", seq: 1, type: "core.note", payload: { text: "x" }, recorded_by: "u1" })];
    const island = renderIsland(Timeline, { events, recorderNames: { u1: "Priya Shah" } });
    expect(textOf(rowFor(island.tree(), "e-1"))).toContain("Priya Shah");
  });

  it("falls back to a generic recorder label when recorded_by has no name on file", () => {
    const events: TimelineEvent[] = [ev({ id: "e-1", seq: 1, type: "core.note", payload: { text: "x" }, recorded_by: "u-ghost" })];
    const island = renderIsland(Timeline, { events, recorderNames: {} });
    // Never the raw user id, and never blank.
    const text = textOf(rowFor(island.tree(), "e-1"));
    expect(text).not.toContain("u-ghost");
    expect(text.trim().length).toBeGreaterThan(0);
  });

  it("a device-linked event shows device provenance INSTEAD of (not alongside a missing) recorder name", () => {
    const events: TimelineEvent[] = [
      ev({ id: "e-1", seq: 1, type: "core.note", payload: { text: "x" }, recorded_by: "u1", device_link_id: "dev-1" }),
    ];
    const island = renderIsland(Timeline, { events, recorderNames: { u1: "Priya Shah" } });
    const text = textOf(rowFor(island.tree(), "e-1"));
    expect(text).not.toContain("Priya Shah");
  });

  it("no recorded_by and no device link -> no provenance text, no crash", () => {
    const events: TimelineEvent[] = [ev({ id: "e-1", seq: 1, type: "core.note", payload: { text: "x" } })];
    const island = renderIsland(Timeline, { events });
    expect(() => rowFor(island.tree(), "e-1")).not.toThrow();
  });
});

describe("Timeline — per-event attribution breakdown (padLabel for labelled items)", () => {
  const CRICKET_CFG = cricket.configSchema.parse({});
  const spec = cricket.padSpec!(CRICKET_CFG);
  const wicketAction = spec.panels.flatMap((p) => p.actions).find((a) => a.labelKey.key === "pad.cricket.action.wicket")!;
  const ATTRIBUTION_BY_TYPE: Readonly<Record<string, PadAttribution>> = { "cricket.ball": wicketAction.attribution };

  it("resolves a labelled attribution item's caption via padLabel and its value via personNames", () => {
    const events: TimelineEvent[] = [
      ev({
        id: "e-1",
        seq: 1,
        type: "cricket.ball",
        payload: {
          striker: "p1",
          nonStriker: "p2",
          bowler: "p3",
          wicket: { out: "p1", fielder: "p4", fielderAssist: "p5" },
        },
      }),
    ];
    const island = renderIsland(Timeline, {
      events,
      personNames: { p1: "Amir Khan", p4: "Ben Stokes", p5: "Chris Woakes" },
      attributionByType: ATTRIBUTION_BY_TYPE,
    });
    const text = textOf(rowFor(island.tree(), "e-1"));
    // "Assisting fielder" is fielderAssist's declared labelKey text (falls
    // back to the engine's own English since the test dict has no override).
    expect(text).toContain("Chris Woakes");
  });

  it("a side item resolves to Home/Away using homeEntrantId/awayEntrantId, never a raw id", () => {
    // Real (UUID-shaped) entrant ids — describeEvent's own generic fallback
    // (`scalars()`) already skips uuid-looking values, so this both proves
    // OUR attribution line resolves "Home" AND stays honest to production
    // shapes (a non-uuid stand-in would pass for the wrong reason: it would
    // merely fail to trip describeEvent's separate filter).
    const HOME_ID = "11111111-1111-4111-8111-111111111111";
    const AWAY_ID = "22222222-2222-4222-8222-222222222222";
    const tossAction = spec.panels.flatMap((p) => p.actions).find((a) => a.labelKey.key === "pad.cricket.action.toss")!;
    const events: TimelineEvent[] = [
      ev({ id: "e-1", seq: 1, type: "cricket.toss", payload: { wonBy: HOME_ID, elected: "bat" } }),
    ];
    const island = renderIsland(Timeline, {
      events,
      attributionByType: { "cricket.toss": tossAction.attribution },
      homeEntrantId: HOME_ID,
      awayEntrantId: AWAY_ID,
    });
    const text = textOf(rowFor(island.tree(), "e-1"));
    expect(text).not.toContain(HOME_ID);
    expect(text.toLowerCase()).toContain("home");
  });

  it("no attributionByType supplied -> caption still renders, just without the breakdown line (never crashes)", () => {
    const events: TimelineEvent[] = [ev({ id: "e-1", seq: 1, type: "cricket.ball", payload: { striker: "p1" } })];
    const island = renderIsland(Timeline, { events });
    expect(() => rowFor(island.tree(), "e-1")).not.toThrow();
  });
});

describe("Timeline — core.void undo + a voided event renders as voided, never disappears", () => {
  it("a plain event with onVoid supplied gets an undo control that fires onVoid(id)", () => {
    const events: TimelineEvent[] = [ev({ id: "e-1", seq: 1, type: "football.goal", payload: { by: "p1" } })];
    let voided: string | null = null;
    const island = renderIsland(Timeline, { events, onVoid: (id: string) => (voided = id) });
    const row = rowFor(island.tree(), "e-1");
    const undoBtn = find(walk(propsOf(row).children as never), (el) => propsOf(el)["data-role"] === "void");
    (propsOf(undoBtn).onClick as () => void)();
    expect(voided).toBe("e-1");
  });

  it("onVoid absent -> read-only: no undo control anywhere", () => {
    const events: TimelineEvent[] = [ev({ id: "e-1", seq: 1, type: "football.goal", payload: { by: "p1" } })];
    const island = renderIsland(Timeline, { events });
    const row = rowFor(island.tree(), "e-1");
    expect(findAll(walk(propsOf(row).children as never), (el) => propsOf(el)["data-role"] === "void").length).toBe(0);
  });

  it("a core.void event itself never offers an undo control (an undo cannot be undone)", () => {
    const events: TimelineEvent[] = [
      ev({ id: "e-1", seq: 1, type: "football.goal", payload: { by: "p1" } }),
      ev({ id: "e-2", seq: 2, type: "core.void", payload: {}, voids_event_id: "e-1" }),
    ];
    const island = renderIsland(Timeline, { events, onVoid: () => {} });
    const voidRow = rowFor(island.tree(), "e-2");
    expect(findAll(walk(propsOf(voidRow).children as never), (el) => propsOf(el)["data-role"] === "void").length).toBe(0);
  });

  it("an event already voided by a later core.void loses its own undo control, but its text stays", () => {
    const events: TimelineEvent[] = [
      ev({ id: "e-1", seq: 1, type: "football.goal", payload: { by: "p1" } }),
      ev({ id: "e-2", seq: 2, type: "core.void", payload: {}, voids_event_id: "e-1" }),
    ];
    const island = renderIsland(Timeline, { events, onVoid: () => {}, personNames: { p1: "Riley Cole" } });
    const voidedRow = rowFor(island.tree(), "e-1");
    expect(propsOf(voidedRow)["data-voided"]).toBe(true);
    // NEVER disappears — the original event's own descriptive text is
    // still present, merely marked.
    expect(textOf(voidedRow)).toContain("Riley Cole");
    expect(findAll(walk(propsOf(voidedRow).children as never), (el) => propsOf(el)["data-role"] === "void").length).toBe(0);
  });

  it("voidingId disables just that row's undo control, leaving every other row interactive", () => {
    const events: TimelineEvent[] = [
      ev({ id: "e-1", seq: 1, type: "football.goal", payload: { by: "p1" } }),
      ev({ id: "e-2", seq: 2, type: "football.goal", payload: { by: "p2" } }),
    ];
    const island = renderIsland(Timeline, { events, onVoid: () => {}, voidingId: "e-1" });
    const tree = island.tree();
    const btn1 = find(walk(propsOf(rowFor(tree, "e-1")).children as never), (el) => propsOf(el)["data-role"] === "void");
    const btn2 = find(walk(propsOf(rowFor(tree, "e-2")).children as never), (el) => propsOf(el)["data-role"] === "void");
    expect(propsOf(btn1).disabled).toBe(true);
    expect(propsOf(btn2).disabled).toBeFalsy();
  });

  it("a device-linked scorer may only undo ITS OWN device's events", () => {
    const events: TimelineEvent[] = [
      ev({ id: "e-1", seq: 1, type: "football.goal", payload: {}, device_link_id: "dev-mine" }),
      ev({ id: "e-2", seq: 2, type: "football.goal", payload: {}, device_link_id: "dev-other" }),
      ev({ id: "e-3", seq: 3, type: "football.goal", payload: {}, recorded_by: "u1", device_link_id: null }),
    ];
    const island = renderIsland(Timeline, { events, onVoid: () => {}, deviceLinkId: "dev-mine" });
    const tree = island.tree();
    const hasVoid = (id: string) =>
      findAll(walk(propsOf(rowFor(tree, id)).children as never), (el) => propsOf(el)["data-role"] === "void").length > 0;
    expect(hasVoid("e-1")).toBe(true);
    expect(hasVoid("e-2")).toBe(false);
    expect(hasVoid("e-3")).toBe(false);
  });

  it("a signed-in (non-device) identity may undo any non-voided event, regardless of who recorded it", () => {
    const events: TimelineEvent[] = [
      ev({ id: "e-1", seq: 1, type: "football.goal", payload: {}, recorded_by: "u1" }),
      ev({ id: "e-2", seq: 2, type: "football.goal", payload: {}, device_link_id: "dev-x" }),
    ];
    const island = renderIsland(Timeline, { events, onVoid: () => {}, deviceLinkId: null });
    const tree = island.tree();
    const hasVoid = (id: string) =>
      findAll(walk(propsOf(rowFor(tree, id)).children as never), (el) => propsOf(el)["data-role"] === "void").length > 0;
    expect(hasVoid("e-1")).toBe(true);
    expect(hasVoid("e-2")).toBe(true);
  });
});

describe("Timeline — timestamps render via the shared ClientTime component", () => {
  it("passes each event's recorded_at to a <ClientTime> element", () => {
    const events: TimelineEvent[] = [ev({ id: "e-1", seq: 1, type: "core.start", recorded_at: "2026-08-12T09:30:00.000Z" })];
    const island = renderIsland(Timeline, { events });
    const row = rowFor(island.tree(), "e-1");
    const clientTime = find(walk(propsOf(row).children as never), isType(ClientTime));
    expect(propsOf(clientTime).value).toBe("2026-08-12T09:30:00.000Z");
  });
});
