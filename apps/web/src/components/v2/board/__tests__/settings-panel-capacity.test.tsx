// The D2 capacity card's WIRING into SettingsPanel — proves the panel
// actually computes a report from its own seeded draft state (startAt/
// endAt/matchMinutes/gapMinutes/courts/rest, all initialised FROM `config`
// under useState) and the fixtures prop, and renders CapacityCard with it.
// renderToStaticMarkup runs useState initialisers and useMemo on first
// render (component-ui-i18n memory) — exactly what a config-seeded report
// needs, with no fetch/effect involved.
import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { Dict } from "@/lib/i18n-constants";
import { DictProvider } from "@/components/i18n/dict-provider";
import en from "@/dictionaries/en/ui.json";
import { SettingsPanel } from "../settings-panel";
import type { BoardConfig } from "../types";
import type { Venue } from "@/components/v2/shared/court-multi-picker";

function render(ui: React.ReactElement): string {
  return renderToStaticMarkup(
    <DictProvider dict={en as unknown as Dict} locale="en">
      {ui}
    </DictProvider>,
  );
}

function baseConfig(overrides: Partial<BoardConfig> = {}): BoardConfig {
  return {
    matchMinutes: 60,
    gapMinutes: 0,
    courts: ["Court 1"],
    perEntrantMinRest: 0,
    blackouts: [],
    sessionWindows: [],
    ...overrides,
  };
}

const MOVABLE = (id: string, home: string | null, away: string | null) => ({
  status: "scheduled",
  home_entrant_id: home,
  away_entrant_id: away,
  pool_id: null,
  id,
});

// Two real org courts under one venue — enough to prove the fallback reads
// the ACTUAL org court list (via `flattenCourts`), not just its length.
function orgVenues(): Venue[] {
  return [
    {
      id: "venue-1",
      name: "Riverside Centre",
      address: null,
      sort: 0,
      archived_at: null,
      created_at: "2026-01-01T00:00:00.000Z",
      courts: [
        {
          id: "court-1",
          venue_id: "venue-1",
          name: "Court 1",
          sort: 0,
          tags: [],
          archived_at: null,
          created_at: "2026-01-01T00:00:00.000Z",
        },
        {
          id: "court-2",
          venue_id: "venue-1",
          name: "Court 2",
          sort: 1,
          tags: [],
          archived_at: null,
          created_at: "2026-01-01T00:00:00.000Z",
        },
      ],
    },
  ];
}

describe("SettingsPanel — D2 capacity card wiring", () => {
  it("renders no capacity card when there is no bounded window yet (no endAt)", () => {
    const html = render(
      <SettingsPanel
        divisionId="div-1"
        config={baseConfig({ startAt: "2026-08-01T09:00:00.000Z", endAt: null })}
        canEdit
        constraintsAllowed
        orgTz="UTC"
        defaultOpen
        onSaved={() => {}}
        onError={() => {}}
        fixtures={[MOVABLE("f1", "A", "B")]}
      />,
    );
    expect(html).not.toContain("data-capacity-verdict");
  });

  it("renders the impossible verdict from CONFIG-SEEDED draft state — one court, 1h window, 6 movable fixtures", () => {
    const html = render(
      <SettingsPanel
        divisionId="div-1"
        config={baseConfig({
          startAt: "2026-08-01T09:00:00.000Z",
          endAt: "2026-08-01T23:59:00.000Z", // one calendar day
          sessionWindows: [{ from: "2026-08-01T09:00:00.000Z", to: "2026-08-01T10:00:00.000Z" }], // 1h -> 1 slot
        })}
        canEdit
        constraintsAllowed
        orgTz="UTC"
        defaultOpen
        onSaved={() => {}}
        onError={() => {}}
        fixtures={[
          MOVABLE("f1", "A", "B"),
          MOVABLE("f2", "A", "C"),
          MOVABLE("f3", "A", "D"),
          MOVABLE("f4", "B", "C"),
          MOVABLE("f5", "B", "D"),
          MOVABLE("f6", "C", "D"),
        ]}
      />,
    );
    expect(html).toContain('data-capacity-verdict="impossible"');
  });

  it("ignores a non-movable (already-decided) fixture when counting demand", () => {
    const html = render(
      <SettingsPanel
        divisionId="div-1"
        config={baseConfig({
          startAt: "2026-08-01T09:00:00.000Z",
          endAt: "2026-08-01T23:59:00.000Z",
          sessionWindows: [{ from: "2026-08-01T09:00:00.000Z", to: "2026-08-01T21:00:00.000Z" }], // 12h -> ample
        })}
        canEdit
        constraintsAllowed
        orgTz="UTC"
        defaultOpen
        onSaved={() => {}}
        onError={() => {}}
        fixtures={[
          MOVABLE("f1", "A", "B"),
          { status: "decided", home_entrant_id: "A", away_entrant_id: "B", pool_id: null, id: "f2" },
        ]}
      />,
    );
    expect(html).toContain('data-capacity-verdict="ok"');
  });

  it("falls back to every org court (via `venues`) when the division's own court selection is empty — mirrors resolveCandidateCourts' server-side UNCONSTRAINED fallback", () => {
    const html = render(
      <SettingsPanel
        divisionId="div-1"
        config={baseConfig({
          courts: [], // legitimate "never configured" state — NOT zero courts server-side
          startAt: "2026-08-01T09:00:00.000Z",
          endAt: "2026-08-01T23:59:00.000Z", // one calendar day
          sessionWindows: [{ from: "2026-08-01T09:00:00.000Z", to: "2026-08-01T21:00:00.000Z" }], // 12h -> 12 slots/court
        })}
        canEdit
        constraintsAllowed
        orgTz="UTC"
        venues={orgVenues()} // 2 real org courts
        defaultOpen
        onSaved={() => {}}
        onError={() => {}}
        fixtures={[
          MOVABLE("f1", "A", "B"),
          MOVABLE("f2", "A", "C"),
          MOVABLE("f3", "A", "D"),
          MOVABLE("f4", "B", "C"),
          MOVABLE("f5", "B", "D"),
          MOVABLE("f6", "C", "D"),
        ]}
      />,
    );
    // Supply computed against the 2 FALLBACK org courts (2 * 12 = 24 slots),
    // not 0 — an empty `courts` selection must never read as zero supply.
    // Demand (6) vs 0 supply would be "impossible"; demand (6) vs 24 supply
    // is comfortably "ok". The literal "24" in the summary text pins the
    // actual computed value, not just the verdict.
    expect(html).toContain('data-capacity-verdict="ok"');
    expect(html).toContain("6 to place vs 24 available slots");
  });
});
