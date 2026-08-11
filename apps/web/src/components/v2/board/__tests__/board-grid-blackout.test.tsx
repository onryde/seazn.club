// Board redesign (docs/superpowers/specs/2026-08-10-board-view-redesign-design.md):
// blackout windows get a hatched, always-visible highlight on the grid — but
// stay SOFT (still clickable/droppable), matching the server, which treats
// `warn.blackout` as a warning, not a rejection. `BoardGrid` calls `useMsg`,
// so it is mounted with `renderToStaticMarkup`, never called directly.
import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { BoardGrid } from "../board-grid";

const T11 = Date.parse("2026-08-10T11:00:00.000Z");
const T1130 = Date.parse("2026-08-10T11:30:00.000Z");

const baseProps = {
  day: "2026-08-10",
  slots: [T11, T1130],
  slotMinutes: 30,
  courts: ["Court 1", "Court 2"],
  fixtures: [],
  divisionNames: {},
  entrantNames: {},
  feedLabels: {},
  conflictsByFixture: {},
  canEdit: true,
  multi: false,
  pickedId: null,
  onPick: () => {},
  onPlace: () => {},
  onDropCard: () => {},
  onTogglePin: () => {},
  venueCap: "Court",
  highlightId: null,
  ghosts: null,
};

describe("BoardGrid blackout zones", () => {
  it("hatches a court-specific blackout only on its own court", () => {
    const html = renderToStaticMarkup(
      <BoardGrid
        {...baseProps}
        blackouts={[{ court: "Court 2", from: "2026-08-10T11:00:00.000Z", to: "2026-08-10T11:30:00.000Z" }]}
      />,
    );
    expect(html.match(/board-blackout/g)).toHaveLength(1);
  });

  it("hatches every court on a venue-wide (courtless) blackout", () => {
    const html = renderToStaticMarkup(
      <BoardGrid
        {...baseProps}
        blackouts={[{ from: "2026-08-10T11:00:00.000Z", to: "2026-08-10T11:30:00.000Z" }]}
      />,
    );
    expect(html.match(/board-blackout/g)).toHaveLength(2);
  });

  it("does not hatch a row the blackout window doesn't reach", () => {
    // Window is 11:00–11:30 — the SECOND slot (11:30–12:00) must stay clean.
    const html = renderToStaticMarkup(
      <BoardGrid
        {...baseProps}
        slots={[T1130]}
        blackouts={[{ from: "2026-08-10T11:00:00.000Z", to: "2026-08-10T11:30:00.000Z" }]}
      />,
    );
    expect(html).not.toContain("board-blackout");
  });

  it("keeps blackout cells enabled (soft) once a fixture is picked — never disabled", () => {
    const html = renderToStaticMarkup(
      <BoardGrid
        {...baseProps}
        pickedId="fx-1"
        blackouts={[{ from: "2026-08-10T11:00:00.000Z", to: "2026-08-10T11:30:00.000Z" }]}
      />,
    );
    expect(html).not.toContain("disabled");
  });

  it("keeps blackout cells keyboard-reachable even with NOTHING picked (a11y regression)", () => {
    // Blackout is map info, always visible for sighted users regardless of
    // pick state — a keyboard/AT user needs the same discoverability. The
    // native `disabled` attribute would make the cell unfocusable outright;
    // `aria-disabled` announces "not actionable yet" without hiding it.
    const html = renderToStaticMarkup(
      <BoardGrid
        {...baseProps}
        pickedId={null}
        blackouts={[{ from: "2026-08-10T11:00:00.000Z", to: "2026-08-10T11:30:00.000Z" }]}
      />,
    );
    const button = html.match(/<button[^>]*data-blackout="true"[^>]*>/)?.[0] ?? "";
    expect(button).not.toBe("");
    expect(button).not.toContain(" disabled");
    expect(button).toContain('aria-disabled="true"');
    expect(button).toContain('tabindex="0"');
  });

  it("catches a blackout mid-match on a gapped board, not just mid-slot (regression)", () => {
    // `slotMinutes` is the DISPLAY lattice — gcd(matchMinutes, gapMinutes) —
    // never a match's real duration. A 30-minute match with a 10-minute gap
    // renders on a 10-minute slotMinutes grid, but a fixture PLACED at 11:00
    // still runs the full 11:00-11:30, not just 11:00-11:10. A blackout
    // starting 10 minutes into that real span (11:10-11:40) must still
    // hatch the 11:00 row — checking only against slotMinutes would miss it
    // (overlaps([11:00,11:10), [11:10,11:40)) is false; the match's real
    // window, [11:00,11:30), does overlap it).
    const html = renderToStaticMarkup(
      <BoardGrid
        {...baseProps}
        slots={[T11]}
        slotMinutes={10}
        matchMinutes={30}
        blackouts={[{ from: "2026-08-10T11:10:00.000Z", to: "2026-08-10T11:40:00.000Z" }]}
      />,
    );
    expect(html).toContain("board-blackout");
  });

  it("drops the old repeated 'Place here' text entirely", () => {
    const html = renderToStaticMarkup(<BoardGrid {...baseProps} pickedId="fx-1" />);
    expect(html).not.toContain("Place here");
  });
});
