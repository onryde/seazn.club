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
import { DictProvider } from "@/components/i18n/dict-provider";
import type { Dict } from "@/lib/i18n-constants";
import es from "@/dictionaries/es/ui.json";
import { MovePanel } from "../move-panel";
import type { BoardConfig, BoardFixture } from "../types";
import { quarterHours } from "../../shared/time-options";

const esDict = es as unknown as Dict;

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
  court_id: null,
  court_name: null,
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

  // THE #448 REGRESSION. The panel used to seed its value with `toLocalInput`,
  // which is deliberately the BROWSER's zone, while its option list is built
  // from `startAt` on `orgTz`. Two clocks in one control: the organiser saw the
  // board's grid plus their own local time as a stray extra option, and pressing
  // Move stored an instant the offset away from the slot they picked.
  //
  // Tokyo (+9) is chosen so this cannot pass by coincidence: under the old
  // browser-zone seed the same fixture renders 09:00 on a UTC runner (CI) and
  // 10:00 on a BST one (this machine) — neither is 18:00.
  it("seeds the value on the VENUE clock, not the browser's", () => {
    const html = renderToStaticMarkup(
      <MovePanel
        {...baseProps}
        fixture={{ ...baseProps.fixture, scheduled_at: "2026-08-16T09:00:00.000Z" }}
        boardConfig={{ config: baseConfig, orgTz: "Asia/Tokyo" }}
      />,
    );
    expect(html).toContain('value="2026-08-16"');
    expect(html).toMatch(/<option value="18:00"[^>]*selected[^>]*>18:00<\/option>/);
  });

  it("falls back to the quarter-hour list when the config carries no startAt", () => {
    const noStart: BoardConfig = { ...baseConfig, startAt: null };
    const html = renderToStaticMarkup(
      <MovePanel {...baseProps} boardConfig={{ config: noStart, orgTz: "UTC" }} />,
    );
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

  it("fix round 3 (Important 3): an unfilled slot's title in the panel's own heading/aria-label resolves through this org's REAL locale, not the client-safe English default", () => {
    // Both cardTitle() call sites in MovePanel (aria-label and the visible
    // heading) were missing `msg` (useMsg()) as the 4th arg.
    const tbd: BoardFixture = {
      ...fixture,
      home_entrant_id: null,
      away_entrant_id: null,
      home_slot_label: { key: "slot.winner_group", params: { g: "A" } },
      away_slot_label: { key: "slot.winner_group", params: { g: "B" } },
    };
    const html = renderToStaticMarkup(
      <DictProvider dict={esDict} locale="es">
        <MovePanel {...baseProps} fixture={tbd} boardConfig={{ config: baseConfig, orgTz: "UTC" }} />
      </DictProvider>,
    );
    expect(html).toContain("Ganador del Grupo A");
    expect(html).toContain("Ganador del Grupo B");
    expect(html).not.toContain("Winner of Group A");
  });

  // P9 scope item 5: the court multi-picker replaced free-text court NAMES
  // with real court ids everywhere upstream — this panel's own seed was the
  // last free-text-shaped read left (`fixture.court_label`, frozen null on
  // anything scheduled since the cutover). A fixture whose stale label
  // disagrees with its real court_id must show the court_id's court.
  it("seeds the selected court from court_id, never the frozen court_label", () => {
    const html = renderToStaticMarkup(
      <MovePanel
        {...baseProps}
        fixture={{ ...baseProps.fixture, court_label: "Old Label", court_id: "c-2" }}
        courts={["c-1", "c-2"]}
        courtNames={{ "c-1": "Court One", "c-2": "Court Two" }}
        boardConfig={{ config: baseConfig, orgTz: "UTC" }}
      />,
    );
    expect(html).toMatch(/<option value="c-2"[^>]*selected[^>]*>Court Two<\/option>/);
    expect(html).not.toContain("Old Label");
    expect(html).not.toMatch(/<option value="c-1"[^>]*selected[^>]*>/);
  });

  it("falls back to the raw id when courtNames has no entry for it", () => {
    const html = renderToStaticMarkup(
      <MovePanel {...baseProps} courts={["c-1"]} boardConfig={{ config: baseConfig, orgTz: "UTC" }} />,
    );
    expect(html).toMatch(/<option value="c-1"[^>]*>c-1<\/option>/);
  });

  it("wraps the When field in an explicit-width container so it cannot collapse", () => {
    // Regression for the bug shipped in 00631754 (quarter-hour datetime
    // split field): every OTHER caller of DateTimeField(kind="datetime-local")
    // wraps it in something with a definite width (a grid track, a plain
    // div); this panel dropped it bare into a `flex flex-wrap` row instead,
    // so the split field's percentage-sized date/time children resolved
    // against an auto-sized flex item and collapsed to a near-zero box.
    const html = renderToStaticMarkup(
      <MovePanel {...baseProps} boardConfig={{ config: baseConfig, orgTz: "UTC" }} />,
    );
    expect(html).toContain('class="w-80 max-w-full"');
  });
});
