import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { StagesPanel } from "@/components/v2/stages-panel";
import type { Venue } from "@/components/v2/shared/court-multi-picker";

vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn(), push: vi.fn() }) }));
vi.mock("@/components/ui/confirm-provider", () => ({ useConfirm: () => vi.fn(async () => false) }));
vi.mock("@/components/ui/tip", () => ({ TipCallout: ({ id }: { id: string }) => <div data-tip={id} /> }));

// Ruling R35 — the WIRING pin.
//
// The court picker itself lives behind `useState(editing)` inside the row's
// inline editor, and `apps/web` vitest is `environment: "node"` with no jsdom,
// so nothing here can open it: the `<select>`'s markup is e2e's to verify. What
// IS provable here, and what this repo has been bitten by SIX times ("the inert
// seam" — code declared, typed, unit-green, and never actually fed), is that
// the `venues` a row needs travel the whole way from the panel that holds them
// to the row that renders them.
//
// So `RunSheetRow` is replaced by a stub that reports what it received, and the
// REAL `StagesPanel` and the REAL `RunSheet` are rendered around it — the same
// chain production uses (`page.tsx` passes `panelVenues` from `listVenues`).
// A dropped prop anywhere in it reads as `0` here.
vi.mock("@/components/v2/desk/run-sheet-row", () => ({
  RunSheetRow: ({ fixture, venues }: { fixture: { fixture_no: number }; venues?: readonly Venue[] }) => (
    <li data-fixture-no={fixture.fixture_no} data-venue-count={venues === undefined ? "none" : venues.length} />
  ),
}));

const VENUES = [
  {
    id: "v-1",
    name: "Main Venue",
    address: null,
    sort: 0,
    archived_at: null,
    created_at: "2026-01-01T00:00:00.000Z",
    courts: [
      {
        id: "c-1",
        venue_id: "v-1",
        name: "Court 1",
        sort: 0,
        tags: [],
        archived_at: null,
        created_at: "2026-01-01T00:00:00.000Z",
      },
    ],
  },
] satisfies Venue[];

const stage = { id: "s1", seq: 1, kind: "league", name: "League", config: {}, progression: null, status: "active" };

const fixture = (no: number, scheduledAt: string | null) => ({
  id: `f${no}`,
  stage_id: "s1",
  pool_id: null,
  round_no: 1,
  seq_in_round: no,
  fixture_no: no,
  home_entrant_id: "e1",
  away_entrant_id: "e2",
  scheduled_at: scheduledAt,
  venue: null,
  court_label: null,
  court_id: null,
  court_name: null,
  status: "scheduled",
  outcome: null,
});

function panelHtml(venues: Venue[] | undefined): string {
  return renderToStaticMarkup(
    <StagesPanel
      divisionId="d1"
      divisionSeq={5}
      competitionId="c1"
      orgSlug="org"
      compSlug="comp"
      divSlug="div"
      stages={[stage]}
      // A timed row (day block) and an untimed one (unscheduled block), so the
      // pin covers more than one of the four places `RunSheet` mounts a row.
      fixtures={[fixture(1, "2026-09-05T14:00:00.000Z"), fixture(2, null)]}
      entrantNames={{ e1: "Alpha", e2: "Bravo" }}
      venues={venues}
      canEdit
      tz="UTC"
      orgTz="UTC"
      canExport={false}
    />,
  );
}

function venueCounts(html: string): string[] {
  return [...html.matchAll(/data-venue-count="([a-z0-9]+)"/g)].map((m) => m[1]!);
}

describe("R35 — the org's venues reach every run-sheet row", () => {
  it("panel -> sheet -> row, for both a timed and an untimed row", () => {
    const html = panelHtml(VENUES);
    // Positive pair: the rows rendered at all before anything is said about
    // what they received.
    expect([...html.matchAll(/data-fixture-no="(\d+)"/g)].map((m) => m[1])).toEqual(["1", "2"]);
    expect(venueCounts(html)).toEqual(["1", "1"]);
  });

  // The panel's own `venues` prop defaults to `[]` (a dozen pre-existing test
  // files build props without it), so a row must survive with no venues at all
  // — it renders a picker offering only "Unassigned" rather than throwing.
  it("a caller that carries no venues still renders rows", () => {
    expect(venueCounts(panelHtml(undefined))).toEqual(["0", "0"]);
  });
});
