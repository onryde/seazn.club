// Same defect and same fix as fixture-console-undo-pad-events.test.tsx —
// see that file's header for the full mechanism. DeviceScorePad's "Undo
// mine" (lastOwnVoidable) is the courtside-device copy of the identical
// gap: its own `events` state was only ever refreshed by its own send(),
// never by <ScorePad/>'s separate submission pipeline, so undo silently
// targeted a stale event until a reload. Proves the fix at THIS call site
// independently — the two components share no state and the seam
// (handlePadEvents) is duplicated deliberately, not refactored into a
// shared hook, per the dispatch's own scope.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ReactElement, ReactNode } from "react";
import type { EventEnvelope } from "@seazn/engine/core";
import { DeviceScorePad, type PadEventIn } from "@/components/v2/device-score-pad";
import type { SideInfo, SportInfo } from "@/components/v2/fixture-console";
import { ScorePad } from "@/components/v2/scorepad/registry";
import { propsOf, renderIsland, textOf } from "@/components/__tests__/_hook-harness";

const api = vi.hoisted(() => ({
  calls: [] as { url: string; options?: { method?: string; json?: unknown } }[],
  events: [] as PadEventIn[],
}));

vi.mock("@/lib/client-v1", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/client-v1")>();
  return {
    ...actual,
    apiV1: vi.fn((url: string, options?: { method?: string; json?: unknown }) => {
      api.calls.push({ url, options });
      if (options?.method === "POST") return Promise.resolve({});
      if (url.includes("/events")) return Promise.resolve(api.events);
      return Promise.resolve({
        status: "in_play",
        last_seq: api.events.length,
        summary: null,
        state: {},
        outcome: null,
      });
    }),
  };
});

const DEVICE_LINK_ID = "link-1";

const SEEDED: PadEventIn = {
  id: "ev-seed",
  seq: 1,
  type: "badminton.rally",
  payload: {},
  recorded_at: "2026-08-14T10:00:00.000Z",
  voids_event_id: null,
  device_link_id: DEVICE_LINK_ID,
};

/** What the pad just scored, over THIS device link. Its id stands in for
 *  the server's own randomUUID() — never idempotency-key shaped — since
 *  that is the only id `send()`'s POST /events {event_id} can void. */
const PAD_SCORED: PadEventIn = {
  id: "ev-real-server-id",
  seq: 2,
  type: "badminton.rally",
  payload: {},
  recorded_at: "2026-08-14T10:05:00.000Z",
  voids_event_id: null,
  device_link_id: DEVICE_LINK_ID,
};

const sport: SportInfo = {
  key: "badminton",
  config: {},
  scorerLabel: "Umpire",
  positionGroups: [],
  roles: [],
  lineupSize: 2,
  benchMax: 1,
};

const side = (id: string, name: string): SideInfo => ({ id, name, members: [], lineup: [] });

function baseProps() {
  return {
    token: "dl_test",
    deviceLinkId: DEVICE_LINK_ID,
    fixture: {
      id: "f1",
      round_no: 2,
      venue: null,
      court_label: "Court 2",
      competition_name: "Summer League",
      division_name: "Badminton Doubles",
    },
    sport,
    home: side("h", "Nia & Marco"),
    away: side("a", "Mira & Josh"),
    initialState: { status: "in_play", last_seq: 1, summary: null, state: {}, outcome: null },
    initialEvents: [SEEDED],
    scorePadV2: {
      moduleVersion: "1.0.0",
      resolvedConfig: {},
      initialEvents: [],
      entitlements: {},
      band: 0 as const,
      identity: { recordedBy: null, deviceLinkId: DEVICE_LINK_ID },
    },
  };
}

/** "Undo mine" is the only <button> this file renders with a `title` prop
 *  (`score.undoTitle`) — the Start-match button omits it entirely. */
function findUndoMine(tree: ReactElement[]): ReactElement {
  const el = tree.find((e) => e.type === "button" && propsOf(e).title !== undefined);
  if (!el) throw new Error("Undo mine button not found");
  return el;
}

function findScorePad(tree: ReactElement[]): ReactElement {
  const el = tree.find((e) => e.type === ScorePad);
  if (!el) throw new Error("<ScorePad/> not found in the rendered tree");
  return el;
}

beforeEach(() => {
  vi.useFakeTimers();
  api.calls.length = 0;
  api.events = [SEEDED];
});

afterEach(() => {
  vi.useRealTimers();
});

describe("DeviceScorePad — Undo mine after a pad-driven submit", () => {
  it("targets the event the pad just scored, not the stale seeded one, with no reload", async () => {
    const island = renderIsland(DeviceScorePad, baseProps());

    // Sanity: before the pad fires, undo targets the seeded event — proves
    // the assertion below is discriminating, not vacuously true.
    const initialVoid = findUndoMine(island.tree());
    expect(propsOf(initialVoid).title).toContain("1"); // score.undoTitle's seq

    const onEvents = propsOf(findScorePad(island.tree())).onEvents as (
      events: readonly EventEnvelope[],
    ) => void;

    api.events = [SEEDED, PAD_SCORED];
    onEvents([
      {
        id: "idem-client-fabricated",
        fixtureId: "f1",
        seq: 2,
        type: "badminton.rally",
        payload: {},
        recordedAt: "2026-08-14T10:05:00.000Z",
        recordedBy: null,
      },
    ]);

    await vi.advanceTimersByTimeAsync(1000);

    const undo = findUndoMine(island.tree());
    (propsOf(undo).onClick as () => void)();
    await vi.advanceTimersByTimeAsync(1000);

    const voidCall = api.calls.find((c) => c.options?.method === "POST");
    // send()'s own POST body shape: {expected_seq, type, payload, idempotency_key}
    // — event_id rides inside `payload`, not top-level (device-score-pad.tsx's
    // send()).
    expect(voidCall?.options?.json).toMatchObject({
      type: "core.void",
      payload: { event_id: "ev-real-server-id" },
    });
  });

  it("disables Undo mine while a pad-triggered resync is in flight, and re-enables it once settled", async () => {
    const island = renderIsland(DeviceScorePad, baseProps());

    const onEvents = propsOf(findScorePad(island.tree())).onEvents as (
      events: readonly EventEnvelope[],
    ) => void;

    // Same reasoning as fixture-console's own case: handlePadEvents sets
    // padSyncing(true) synchronously and kicks off resync() without being
    // awaited here, so this assertion lands inside the real in-flight
    // window rather than after it has already closed.
    api.events = [SEEDED, PAD_SCORED];
    onEvents([
      {
        id: "idem-client-fabricated",
        fixtureId: "f1",
        seq: 2,
        type: "badminton.rally",
        payload: {},
        recordedAt: "2026-08-14T10:05:00.000Z",
        recordedBy: null,
      },
    ]);

    expect(api.calls.some((c) => c.url.includes("/events"))).toBe(true);
    const midFlightUndo = findUndoMine(island.tree());
    expect(propsOf(midFlightUndo).disabled).toBe(true);

    await vi.advanceTimersByTimeAsync(1000);

    const settledUndo = findUndoMine(island.tree());
    expect(propsOf(settledUndo).disabled).toBe(false);
  });
});

// R7 / Task C review fix #6b — A THIRD UNDO CONTROL THAT CONTRADICTED ITS OWN
// TOOLTIP.
//
// C4's point was that two controls must not share one word while behaving
// differently, and it renamed both: the ribbon's to "Take back" (it can
// cancel before send), the console's to "Void last entry" (it always writes a
// permanent `core.void` row). This one — the device link's — was left reading
// "Undo my last entry" while its tooltip, shared with the console's control,
// already said Void. Same button, two vocabularies.
describe("the device link's own last-entry control says what it does", () => {
  it("agrees with the tooltip it shares with the console", () => {
    const island = renderIsland(DeviceScorePad, baseProps());
    const button = findUndoMine(island.tree());

    const label = textOf(propsOf(button).children as ReactNode);
    const title = String(propsOf(button).title);

    expect(title, "the tooltip is score.voidLastTitle — the console's own").toContain("Void");
    expect(
      label,
      "and the label must name the same act: this control can never cancel before send",
    ).toContain("Void");
    expect(label, "the word C4 took away from every other control").not.toContain("Undo");
  });
});
