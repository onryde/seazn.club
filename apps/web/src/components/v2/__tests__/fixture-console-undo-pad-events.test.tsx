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
import type { EventEnvelope } from "@seazn/engine/core";
import { FixtureConsole } from "@/components/v2/fixture-console";
import type { EventIn, SideInfo, SportInfo } from "@/components/v2/fixture-console";
import { ScorePad } from "@/components/v2/scorepad/registry";
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
  fidelityTiers: [],
};

const side = (id: string, name: string): SideInfo => ({ id, name, members: [], lineup: [] });

function baseProps() {
  return {
    fixture: {
      id: "f1",
      status: "in_play",
      scheduled_at: null,
      venue: null,
      court_label: null,
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

/** The chassis "Undo last" control is the only <button> this file renders
 *  with a `title` prop (`score.undoTitle`) — per-row void buttons and every
 *  other toolbar button omit `title` entirely (fixture-console.tsx). */
function findUndoLast(tree: ReactElement[]): ReactElement {
  const el = tree.find((e) => e.type === "button" && propsOf(e).title !== undefined);
  if (!el) throw new Error("Undo last button not found");
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

describe("FixtureConsole — Undo last after a pad-driven submit", () => {
  it("targets the event the pad just scored, not the stale seeded one, with no reload", async () => {
    const island = renderIsland(FixtureConsole, baseProps());

    // Sanity: before the pad ever fires, undo targets the seeded event —
    // proves the assertion below is discriminating, not vacuously true.
    const initialVoid = findUndoLast(island.tree());
    expect(propsOf(initialVoid).title).toContain("1"); // score.undoTitle's seq

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
});
