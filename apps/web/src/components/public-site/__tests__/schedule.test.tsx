// Public Schedule tab (doc 09 §2) — node-env test: renderToStaticMarkup only
// (no jsdom in this repo, same convention as bracket.test.tsx).
//
// P6 fix round 1, finding #2 (CRITICAL): this is a Client Component with no
// safe way to call msgFor() itself (server-only), so it must NEVER resolve a
// slot label on its own — every unfilled slot's text has to arrive already
// resolved via the `slotLabels` prop (built server-side by the caller from
// the org's own default_locale). These tests prove the component actually
// USES that prop (not silently falling back to English msg()) and that a
// truncated name carries a `title` (finding #5).
import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { createElement } from "react";
import { Schedule } from "../schedule";
import type { PublicFixture } from "@/server/public-site/data";

const F = (over: Partial<PublicFixture>): PublicFixture => ({
  id: "f1",
  division_id: "d1",
  stage_id: "s1",
  pool_id: null,
  round_no: 1,
  seq_in_round: 1,
  home_entrant_id: null,
  away_entrant_id: null,
  home_slot_label: null,
  away_slot_label: null,
  scheduled_at: "2026-09-25T09:00:00.000Z",
  venue: null,
  court_label: null,
  venue_name: null,
  court_name: null,
  status: "scheduled",
  outcome: null,
  summary: null,
  last_seq: null,
  ...over,
});

const entrantNames = { e1: "Real Team" };

describe("public Schedule — slotLabels prop (P6 finding #2)", () => {
  it("renders the caller's pre-resolved slotLabels text for both unfilled sides, not English msg()", () => {
    const fixtures = [F({ id: "final" })];
    const html = renderToStaticMarkup(
      createElement(Schedule, {
        fixtures,
        entrantNames,
        divisionPath: "/shared/org/comp/div",
        tz: "UTC",
        slotLabels: { "final:home": "Ganador del Grupo A", "final:away": "Ganador del Grupo B" },
      }),
    );
    expect(html).toContain("Ganador del Grupo A");
    expect(html).toContain("Ganador del Grupo B");
    // Never falls through to the English default when the map has the key.
    expect(html).not.toContain("Winner of Group");
    expect(html).not.toMatch(/>TBD</);
  });

  it("a real entrant on one side and a slotLabels entry on the other render distinctly", () => {
    const fixtures = [F({ id: "semi", home_entrant_id: "e1", away_entrant_id: null })];
    const html = renderToStaticMarkup(
      createElement(Schedule, {
        fixtures,
        entrantNames,
        divisionPath: "/shared/org/comp/div",
        tz: "UTC",
        slotLabels: { "semi:away": "Runner-up of Group C" },
      }),
    );
    expect(html).toContain("Real Team");
    expect(html).toContain("Runner-up of Group C");
  });

  it("falls back to the client-safe English default ONLY when slotLabels has no entry for that key (defensive, should not happen in practice)", () => {
    const fixtures = [F({ id: "mystery" })];
    const html = renderToStaticMarkup(
      createElement(Schedule, {
        fixtures,
        entrantNames,
        divisionPath: "/shared/org/comp/div",
        tz: "UTC",
        slotLabels: {},
      }),
    );
    expect(html).toMatch(/>TBD</);
  });

  it("a truncated name carries a title with its own full text (finding #5)", () => {
    const fixtures = [F({ id: "final" })];
    const html = renderToStaticMarkup(
      createElement(Schedule, {
        fixtures,
        entrantNames,
        divisionPath: "/shared/org/comp/div",
        tz: "UTC",
        slotLabels: {
          "final:home": "Best 2 of the 3-place teams",
          "final:away": "Winner of Group B",
        },
      }),
    );
    expect(html).toContain('title="Best 2 of the 3-place teams"');
    expect(html).toContain('title="Winner of Group B"');
  });
});

describe("public Schedule — court_name/venue_name, never the frozen court_label/venue (P9 pass 4c)", () => {
  it("renders the resolved court_name and venue_name when they disagree with the frozen court_label/venue", () => {
    const fixtures = [
      F({
        id: "f1",
        scheduled_at: "2026-09-25T09:00:00.000Z",
        venue: "Stale Freetext Venue",
        court_label: "Stale Freetext Court",
        venue_name: "Riverside Sports Hall",
        court_name: "Show Court 3",
      }),
    ];
    const html = renderToStaticMarkup(
      createElement(Schedule, {
        fixtures,
        entrantNames,
        divisionPath: "/shared/org/comp/div",
        tz: "UTC",
        slotLabels: {},
      }),
    );
    expect(html).toContain("Show Court 3");
    expect(html).toContain("Riverside Sports Hall");
    expect(html).not.toContain("Stale Freetext Court");
    expect(html).not.toContain("Stale Freetext Venue");
  });
});
