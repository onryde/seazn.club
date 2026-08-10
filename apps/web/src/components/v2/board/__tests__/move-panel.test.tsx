// `move-panel.tsx` converted its hand-rolled `<input type="datetime-local">`
// onto the shared `DateTimeField` (see
// docs/superpowers/specs/2026-08-10-quarter-hour-time-select-design.md).
// Fixture-level fields get BOARD SLOTS, not the quarter-hour grid — a 40/0
// division's real slots are 09:00, 09:40, 10:20, which a quarter-hour select
// cannot express past the first. `MovePanel` has hooks (`useState`,
// `useMemo`, `useMsg`), so it cannot be called as a plain function outside
// React (`_hook-harness.tsx` — hooks throw there); this suite mounts it for
// real with `renderToStaticMarkup`, the same pattern `datetime-split-field`
// uses for the one other stateful piece of this UX.
import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { MovePanel } from "../move-panel";
import type { BoardConfig, BoardFixture } from "../types";
import { quarterHours } from "../../shared/time-options";

const fixture: BoardFixture = {
  id: "fx-1",
  stage_id: "st-1",
  division_id: "dv-1",
  round_no: 1,
  seq_in_round: 1,
  home_entrant_id: null,
  away_entrant_id: null,
  scheduled_at: null,
  venue: null,
  court_label: null,
  status: "scheduled",
  schedule_source: "manual",
  schedule_locked: false,
  outcome: null,
};

const baseConfig: BoardConfig = {
  startAt: "2026-08-10T09:00:00.000Z", // 09:00 UTC == 09:00 in the orgTz below
  endAt: null,
  matchMinutes: 40,
  gapMinutes: 0,
  courts: ["Court 1"],
  perEntrantMinRest: 0,
  blackouts: [],
  sessionWindows: [],
};

const baseProps = {
  fixture,
  courts: ["Court 1"],
  entrantNames: {},
  feedLabels: {},
  onMove: () => {},
  onClose: () => {},
};

describe("MovePanel", () => {
  it("offers the division's board slots (09:00, 09:40, 10:20) on a 40/0 board, not the quarter-hour grid", () => {
    const html = renderToStaticMarkup(
      <MovePanel {...baseProps} boardConfig={{ config: baseConfig, orgTz: "UTC" }} />,
    );
    expect(html).toContain('value="09:00"');
    expect(html).toContain('value="09:40"');
    expect(html).toContain('value="10:20"');
    // Off the 40-minute grid — the quarter-hour list would have offered this.
    expect(html).not.toContain('value="09:15"');
  });

  it("falls back to the quarter-hour list when no board config is passed", () => {
    const html = renderToStaticMarkup(<MovePanel {...baseProps} />);
    for (const t of quarterHours()) {
      expect(html).toContain(`value="${t}"`);
    }
  });

  it("falls back to the quarter-hour list when the config produces fewer than 2 slots", () => {
    const degenerate: BoardConfig = { ...baseConfig, matchMinutes: 0 };
    const html = renderToStaticMarkup(
      <MovePanel {...baseProps} boardConfig={{ config: degenerate, orgTz: "UTC" }} />,
    );
    for (const t of quarterHours()) {
      expect(html).toContain(`value="${t}"`);
    }
  });

  it("falls back to the quarter-hour list when the config has no startAt yet", () => {
    const noStart: BoardConfig = { ...baseConfig, startAt: null };
    const html = renderToStaticMarkup(
      <MovePanel {...baseProps} boardConfig={{ config: noStart, orgTz: "UTC" }} />,
    );
    for (const t of quarterHours()) {
      expect(html).toContain(`value="${t}"`);
    }
  });

  it("converts startAt through the ORG zone, not UTC or the browser zone", () => {
    // 09:00 UTC is 05:00 in America/New_York (EDT, UTC-4 in August). A
    // 45-minute stride from a wrongly-UTC 09:00 anchor would land back on
    // 09:00 itself; from the correct 05:00 anchor it never does — so
    // asserting BOTH "05:00 present" and "09:00 absent" pins the zone, not
    // just the stride math (already covered by the 40/0 test above).
    const config: BoardConfig = { ...baseConfig, matchMinutes: 45, gapMinutes: 0 };
    const html = renderToStaticMarkup(
      <MovePanel {...baseProps} boardConfig={{ config, orgTz: "America/New_York" }} />,
    );
    expect(html).toContain('value="05:00"');
    expect(html).not.toContain('value="09:00"');
  });
});
