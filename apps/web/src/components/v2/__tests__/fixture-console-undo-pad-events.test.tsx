// "Undo last" used to read a snapshot loaded once at mount and refreshed
// only by this component's OWN send() — a pad-driven submission goes
// through a wholly separate pipeline (use-pad-pipeline.ts, mounted inside
// <ScorePad/>) that never touched this component's `events` state, so undo
// silently targeted a stale event until a full page reload.
//
// Fixed via the new onEvents seam (scorepad/pad-renderer.tsx + registry.tsx,
// commit 3fec34a0) — but NOT by trusting the events it hands over directly:
// the pad's own pipeline stamps a CLIENT-fabricated id (the idempotency key)
// on every event it knows about and never learns the server's real row id
// (AppendSuccess carries none at all), so this component's handlePadEvents
// deliberately ignores the callback's payload and re-runs the real
// resync() instead — the only way to learn the id the server actually
// stores. This suite proves the OUTCOME: after a pad-driven submit, with NO
// reload, "Undo last" targets the just-scored event's REAL server id.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { EventEnvelope } from "@seazn/engine/core";
import { FixtureConsole } from "@/components/v2/fixture-console";
import type { EventIn, SideInfo, SportInfo } from "@/components/v2/fixture-console";
import { ScorePad } from "@/components/v2/scorepad/registry";
import { ActivityPanel } from "@/components/v2/scorepad/v3/activity";
import { propsOf, renderIsland } from "@/components/__tests__/_hook-harness";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: vi.fn(), push: vi.fn() }),
}));

const api = vi.hoisted(() => ({
  calls: [] as { url: string; options?: { method?: string; json?: unknown } }[],
  /** What the events GET returns — mutated mid-test to simulate the server
   *  ledger gaining the pad's just-scored row. */
  events: [] as EventIn[],
}));

vi.mock("@/lib/client-v1", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/client-v1")>();
  return {
    ...actual, // ApiV1Error stays the REAL class.
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

/** Seeded at SSR/mount — what a reload would have shown all along. */
const SEEDED: EventIn = {
  id: "ev-seed",
  seq: 1,
  type: "football.goal",
  payload: {},
  recorded_at: "2026-08-14T10:00:00.000Z",
  recorded_by: null,
  device_link_id: null,
  voids_event_id: null,
};

/** What the pad just scored. Its id is deliberately NOT idempotency-key
 *  shaped — it stands in for the server's own randomUUID(), which is the
 *  only id `send()`'s POST /events {event_id} can actually void. */
const PAD_SCORED: EventIn = {
  id: "ev-real-server-id",
  seq: 2,
  type: "football.goal",
  payload: {},
  recorded_at: "2026-08-14T10:05:00.000Z",
  recorded_by: null,
  device_link_id: null,
  voids_event_id: null,
};

const sport: SportInfo = {
  key: "football",
  config: {},
  scorerLabel: "Referee",
  positionGroups: [],
  roles: [],
  lineupSize: 0,
  benchMax: 0,
  fidelityTiers: [],
};

const side = (id: string, name: string): SideInfo => ({ id, name, members: [], lineup: [] });

function baseProps() {
  return {
    fixture: {
      id: "f1",
      status: "in_play",
      scheduled_at: null,
      venue_name: null,
      court_name: null,
      round_no: 1,
    },
    sport,
    home: side("home1", "Home FC"),
    away: side("away1", "Away FC"),
    initialState: { status: "in_play", last_seq: 1, summary: null, state: {}, outcome: null },
    initialEvents: [SEEDED],
    canEdit: true,
    scorePadV2: {
      moduleVersion: "1.0.0",
      resolvedConfig: {},
      initialEvents: [],
      entitlements: {},
      band: 0 as const,
      identity: { recordedBy: null, deviceLinkId: null },
    },
  };
}

/** Depth-first search through a React element and its CHILDREN. The harness's
 *  own `tree()` expands what a component RENDERS; it cannot see an element
 *  handed to another component as a prop, which is where R7/C1 put this
 *  control (`<ActivityPanel footer={…}>`). */
function deepFind(node: unknown, pred: (el: ReactElement) => boolean): ReactElement | null {
  if (Array.isArray(node)) {
    for (const n of node) {
      const hit = deepFind(n, pred);
      if (hit) return hit;
    }
    return null;
  }
  if (node === null || typeof node !== "object" || !("type" in node)) return null;
  const el = node as ReactElement;
  if (pred(el)) return el;
  return deepFind((propsOf(el) as { children?: unknown }).children, pred);
}

/** The chassis "Void last entry" control (R7/C1 renamed it from "Undo last"
 *  and moved it into the LEDGER's own footer, where it belongs — it edits an
 *  entry, which is scoring, not an action that ends the match). Still the only
 *  <button> this file renders with a `title` prop (`score.voidLastTitle`):
 *  per-row void buttons and every other control omit `title` entirely. */
function findUndoLast(tree: ReactElement[]): ReactElement {
  const flat = tree.find((e) => e.type === "button" && propsOf(e).title !== undefined);
  if (flat) return flat;
  const panel = tree.find((e) => e.type === ActivityPanel);
  const inFooter = panel
    ? deepFind(propsOf(panel).footer, (e) => e.type === "button" && propsOf(e).title !== undefined)
    : null;
  if (!inFooter) throw new Error("Void last entry button not found");
  return inFooter;
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

describe("FixtureConsole — Undo last after a pad-driven submit", () => {
  it("targets the event the pad just scored, not the stale seeded one, with no reload", async () => {
    const island = renderIsland(FixtureConsole, baseProps());

    // Sanity: before the pad ever fires, undo targets the seeded event —
    // proves the assertion below is discriminating, not vacuously true.
    const initialVoid = findUndoLast(island.tree());
    expect(propsOf(initialVoid).title).toContain("1"); // score.voidLastTitle's seq

    const onEvents = propsOf(findScorePad(island.tree())).onEvents as (
      events: readonly EventEnvelope[],
    ) => void;

    // The server now durably has the pad's row — resync() is about to
    // discover it. The onEvents argument itself is deliberately NOT what
    // the fix reads (see the file header); it only carries a realistic
    // shape to prove the seam is exercised faithfully.
    api.events = [SEEDED, PAD_SCORED];
    onEvents([
      {
        id: "idem-client-fabricated",
        fixtureId: "f1",
        seq: 2,
        type: "football.goal",
        payload: {},
        recordedAt: "2026-08-14T10:05:00.000Z",
        recordedBy: null,
      },
    ]);

    await vi.advanceTimersByTimeAsync(1000);

    const undo = findUndoLast(island.tree());
    (propsOf(undo).onClick as () => void)();
    await vi.advanceTimersByTimeAsync(1000);

    const voidCall = api.calls.find((c) => c.options?.method === "POST");
    // send()'s own POST body shape: {expected_seq, type, payload, idempotency_key}
    // — event_id rides inside `payload`, not top-level (fixture-console.tsx's
    // send()).
    expect(voidCall?.options?.json).toMatchObject({
      type: "core.void",
      payload: { event_id: "ev-real-server-id" },
    });
  });

  it("disables Undo last while a pad-triggered resync is in flight, and re-enables it once settled", async () => {
    const island = renderIsland(FixtureConsole, baseProps());

    const onEvents = propsOf(findScorePad(island.tree())).onEvents as (
      events: readonly EventEnvelope[],
    ) => void;

    // Fire the pad signal. handlePadEvents synchronously sets padSyncing(true)
    // and kicks off resync() before returning — the mocked apiV1 resolves
    // immediately, but Promise.all + its own await + .catch + .finally still
    // need real microtask hops, so nothing here is awaited yet: this
    // assertion deliberately lands INSIDE that window, before it closes.
    api.events = [SEEDED, PAD_SCORED];
    onEvents([
      {
        id: "idem-client-fabricated",
        fixtureId: "f1",
        seq: 2,
        type: "football.goal",
        payload: {},
        recordedAt: "2026-08-14T10:05:00.000Z",
        recordedBy: null,
      },
    ]);

    // The resync's own GETs were issued synchronously (proves this is really
    // mid-flight, not a no-op)...
    expect(api.calls.some((c) => c.url.includes("/events"))).toBe(true);
    // ...but neither has resolved yet, so Undo must already be disabled.
    const midFlightUndo = findUndoLast(island.tree());
    expect(propsOf(midFlightUndo).disabled).toBe(true);

    // Let the resync settle.
    await vi.advanceTimersByTimeAsync(1000);

    const settledUndo = findUndoLast(island.tree());
    expect(propsOf(settledUndo).disabled).toBe(false);
  });
});

// R7 / Task C review fix #1 — THE PER-ROW VOID MUST LOOK DISABLED, NOT JUST
// BE INERT.
//
// C1 replaced the per-row Void's `disabled={busy || padSyncing}` (which the
// deleted page-level ledger had) with a silent `if (busy || padSyncing)
// return;` inside `onVoid`. `setPadSyncing(true)` fires after EVERY pad event,
// so on a live console every tap opens a window in which every Void button in
// the ledger LOOKS enabled and does nothing — no dim, no cursor change, no
// message. A dead tap: the class this programme has already paid for once.
//
// Driven through the REAL producer and the REAL consumer — the console's own
// mid-resync render, handed to the actual `<ActivityPanel>` element it built,
// serialised. Never a fixture on both ends.
describe("FixtureConsole — the ledger's per-row Void during a pad resync", () => {
  /** Every per-row Void's OPENING TAG, so `disabled` is read off the same
   *  element the probe found rather than off "somewhere in the panel" —
   *  React serialises `disabled=""` BEFORE `data-role` (JSX prop order), so a
   *  one-directional regex silently reports every row enabled. Anchored on
   *  `="` throughout: an omitted prop serialises as `"$undefined"`, and a
   *  bare `disabled` probe would pass in both states. */
  function voidButtonTags(tree: ReactElement[]): string[] {
    const panel = tree.find((e) => e.type === ActivityPanel);
    if (!panel) throw new Error("<ActivityPanel/> not found in the rendered tree");
    const html = renderToStaticMarkup(panel);
    return [...html.matchAll(/<button[^>]*data-role="v3-activity-void"[^>]*>/g)].map((m) => m[0]);
  }

  function firePadEvent(island: ReturnType<typeof renderIsland<ReturnType<typeof baseProps>>>) {
    const onEvents = propsOf(findScorePad(island.tree())).onEvents as (
      events: readonly EventEnvelope[],
    ) => void;
    api.events = [SEEDED, PAD_SCORED];
    onEvents([
      {
        id: "idem-client-fabricated",
        fixtureId: "f1",
        seq: 2,
        type: "football.goal",
        payload: {},
        recordedAt: "2026-08-14T10:05:00.000Z",
        recordedBy: null,
      },
    ]);
  }

  it("renders every row's Void disabled while a pad-triggered resync is in flight", async () => {
    const island = renderIsland(FixtureConsole, baseProps());

    // Discriminating baseline: before any pad event the control is present
    // AND enabled, so the assertion below cannot pass by the button being
    // absent, or by every button in this panel always being disabled.
    const idle = voidButtonTags(island.tree());
    expect(idle.length, "the console's ledger offers a per-row Void at rest").toBeGreaterThan(0);
    expect(idle.filter((tag) => tag.includes('disabled=""'))).toEqual([]);

    firePadEvent(island);

    // The resync's GETs went out synchronously but nothing has resolved, so
    // this render is inside the padSyncing window the user taps into.
    expect(api.calls.some((c) => c.url.includes("/events"))).toBe(true);
    const midFlight = voidButtonTags(island.tree());
    expect(midFlight.length, "the row control must still be offered, not vanish").toBeGreaterThan(0);
    expect(
      midFlight.filter((tag) => !tag.includes('disabled=""')),
      "a Void that silently returns is a dead tap — every row has to READ as unavailable",
    ).toEqual([]);

    await vi.advanceTimersByTimeAsync(1000);

    const settled = voidButtonTags(island.tree());
    expect(settled.length).toBeGreaterThan(0);
    expect(
      settled.filter((tag) => tag.includes('disabled=""')),
      "and it must come back once the ledger is fresh again",
    ).toEqual([]);
  });
});
