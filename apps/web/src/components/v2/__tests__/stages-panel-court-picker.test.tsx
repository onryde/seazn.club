// P9 pass 4d, item 1: stages-panel.tsx's per-fixture court editor (FixtureLine)
// used to seed its state from the FROZEN `court_label` column and PATCH
// `court_label`/`venue` — both retired from the wire by pass 3a.
// `PatchFixture` (server/api-v1/schemas.ts) is `.strict()` and only accepts
// `court_id`/`venue_id`, so every save from this panel 400'd, exactly like
// the board's Auto-schedule apply did before that fix.
//
// No DOM (vitest `environment: "node"`, no jsdom) — driven through the shared
// hook harness, same pattern as stages-panel-auto-schedule-seq.test.tsx.
// FixtureLine is exported (not just StagesPanel) specifically so this file
// can drive it directly: the harness renders a function component ONE level
// deep, and StagesPanel only ever hands back an un-executed <FixtureLine/>
// element, not its internal editing state.
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ReactElement } from "react";
import { propsOf, renderIsland, walk } from "@/components/__tests__/_hook-harness";

vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn(), push: vi.fn() }) }));

const net = vi.hoisted(() => ({
  calls: [] as { url: string; method?: string; json?: unknown }[],
}));

vi.mock("@/lib/client-v1", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/client-v1")>();
  return {
    ...actual,
    apiV1: (url: string, options?: { method?: string; json?: unknown }) => {
      net.calls.push({ url, method: options?.method, json: options?.json });
      return Promise.resolve({});
    },
  };
});

import { FixtureLine } from "@/components/v2/stages-panel";
import { PatchFixture } from "@/server/api-v1/schemas";
import type { Court, Venue } from "@/components/v2/venues-panel";

function makeCourt(overrides: Partial<Court> = {}): Court {
  return {
    id: "c-1",
    venue_id: "v-1",
    name: "Court 1",
    sort: 0,
    tags: [],
    archived_at: null,
    created_at: "2026-01-01T00:00:00.000Z",
    hours: [],
    exceptions: [],
    ...overrides,
  };
}

function makeVenue(overrides: Partial<Venue> = {}): Venue {
  return {
    id: "v-1",
    name: "Main Venue",
    address: null,
    sort: 0,
    archived_at: null,
    created_at: "2026-01-01T00:00:00.000Z",
    courts: [],
    ...overrides,
  };
}

// PatchFixture's court_id/venue_id are z.uuid() — real UUID shape, so
// PatchFixture.parse() below exercises the actual production validator
// rather than tripping on unrelated "not a uuid" noise.
const COURT_NORTH_ID = "3d6c2e2a-0000-4000-8000-0000000000c1";
const COURT_SOUTH_ID = "3d6c2e2a-0000-4000-8000-0000000000c2";
const VENUE_NORTH_ID = "3d6c2e2a-0000-4000-8000-0000000000b1";
const VENUE_SOUTH_ID = "3d6c2e2a-0000-4000-8000-0000000000b2";

// Two venues, each with a court named "Tennis Court 3" — the owner's live
// item-2 bug, reused here to prove item 1's chip render also disambiguates
// (courtNames is threaded from StagesPanel's own courtNamesById).
const VENUES: Venue[] = [
  makeVenue({
    id: VENUE_NORTH_ID,
    name: "North Sports Centre",
    courts: [makeCourt({ id: COURT_NORTH_ID, venue_id: VENUE_NORTH_ID, name: "Tennis Court 3" })],
  }),
  makeVenue({
    id: VENUE_SOUTH_ID,
    name: "South Leisure Park",
    courts: [makeCourt({ id: COURT_SOUTH_ID, venue_id: VENUE_SOUTH_ID, name: "Tennis Court 3" })],
  }),
];
const COURT_NAMES = {
  [COURT_NORTH_ID]: "Tennis Court 3 (North Sports Centre)",
  [COURT_SOUTH_ID]: "Tennis Court 3 (South Leisure Park)",
};

const FIXTURE = {
  id: "f1",
  stage_id: "s1",
  pool_id: null,
  round_no: 1,
  seq_in_round: 1,
  fixture_no: 1,
  home_entrant_id: "e1",
  away_entrant_id: "e2",
  scheduled_at: "2026-08-20T09:00:00.000Z",
  // A pre-cutover fixture's frozen label deliberately does NOT match the
  // real court_id's name below — proves the panel reads court_id, never
  // court_label, for both seeding and display.
  venue: null,
  court_label: "Stale Legacy Text",
  court_id: COURT_NORTH_ID,
  court_name: "Tennis Court 3",
  status: "scheduled" as const,
  outcome: null,
};

const baseProps = {
  fixture: FIXTURE,
  href: "/f/1",
  entrantNames: { e1: "Alpha", e2: "Bravo" },
  canEdit: true,
  tz: "UTC",
  venues: VENUES,
  courtNames: COURT_NAMES,
} as unknown as Parameters<typeof FixtureLine>[0];

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

function byTestId(tree: ReactElement[], id: string): ReactElement | undefined {
  return tree.find((n) => propsOf(n)["data-testid"] === id);
}

/** Opens the inline editor, same as stages-panel-auto-schedule-seq.test.tsx's
 *  fireAutoSchedule — invoke the handler the harness found, don't simulate a
 *  DOM click that doesn't exist in this environment. */
function openEditor(tree: ReactElement[]): void {
  const toggle = byTestId(tree, "fixture-schedule-toggle");
  if (!toggle) throw new Error("no fixture-schedule-toggle button rendered");
  (propsOf(toggle).onClick as () => void)();
}

beforeEach(() => {
  net.calls = [];
});

describe("FixtureLine court editor (P9 pass 4d, item 1)", () => {
  it("seeds the court select from court_id, never court_label", () => {
    const island = renderIsland(FixtureLine, baseProps, (node) => walk(node));
    openEditor(island.tree());
    const select = byTestId(island.tree(), "fixture-court-select");
    expect(select).toBeDefined();
    expect(propsOf(select!).value).toBe(COURT_NORTH_ID);
  });

  it("PATCHes court_id (and the selected court's venue_id) — never court_label/venue — and the payload is accepted by PatchFixture", async () => {
    const island = renderIsland(FixtureLine, baseProps, (node) => walk(node));
    openEditor(island.tree());

    // Switch to the OTHER same-named court, in the other venue.
    const select = byTestId(island.tree(), "fixture-court-select")!;
    (propsOf(select).onChange as (e: { target: { value: string } }) => void)({
      target: { value: COURT_SOUTH_ID },
    });

    const save = byTestId(island.tree(), "fixture-save-schedule");
    expect(save).toBeDefined();
    (propsOf(save!).onClick as () => void)();
    await flush();

    expect(net.calls).toHaveLength(1);
    const call = net.calls[0]!;
    expect(call.url).toBe("/api/v1/fixtures/f1");
    expect(call.method).toBe("PATCH");
    const json = call.json as Record<string, unknown>;
    expect(json).not.toHaveProperty("court_label");
    expect(json).not.toHaveProperty("venue");
    expect(json).toMatchObject({ court_id: COURT_SOUTH_ID, venue_id: VENUE_SOUTH_ID });

    // The load-bearing proof: PatchFixture is `.strict()`, so this is exactly
    // what the API route runs the payload through before it ever reaches
    // patchFixture()/moveFixture(). A payload this schema rejects is what
    // "400s" means here — parse() throwing IS the regression.
    expect(() => PatchFixture.parse(json)).not.toThrow();
  });

  it("the OLD payload shape (venue/court_label) is exactly what PatchFixture rejects — documents why every save 400'd", () => {
    const oldShapePayload = {
      scheduled_at: "2026-08-20T09:00:00.000Z",
      venue: "Some Venue",
      court_label: "Court 3",
    };
    expect(() => PatchFixture.parse(oldShapePayload)).toThrow();
  });

  it("renders the court's resolved, venue-qualified NAME — never a raw court_id (uuid)", () => {
    const RAW_ID = "3d6c2e2a-0000-4000-8000-000000000009";
    const island = renderIsland(
      FixtureLine,
      {
        ...baseProps,
        fixture: { ...FIXTURE, court_id: RAW_ID, court_name: null, court_label: null },
        courtNames: {},
      },
      (node) => walk(node),
    );
    const html = JSON.stringify(island.tree().map((n) => propsOf(n)));
    expect(html).not.toContain(RAW_ID);
  });

  it("disambiguates two same-named courts via courtNames — the chip shows the venue-qualified text, not the bare collision", () => {
    const island = renderIsland(FixtureLine, baseProps, (node) => walk(node));
    expect(island.text()).toContain("Tennis Court 3 (North Sports Centre)");
    // The bare, unqualified collision never appears standalone as the
    // resolved court text (only as a substring of the qualified label).
    expect(island.text()).not.toContain("Stale Legacy Text");
  });
});
