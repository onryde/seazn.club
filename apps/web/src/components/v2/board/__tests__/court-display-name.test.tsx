// P9 pass 4a item 3: board-agenda.tsx and board-lanes.tsx used to render
// f.court_label as the court caption — frozen legacy, null for anything
// scheduled since the cutover, so the caption silently went blank. The fix
// (courtDisplayName, board/types.ts) prefers the resolved court_name, falls
// back to court_label for a still-labelled pre-cutover fixture, and NEVER
// falls back to court_id — a raw uuid is never organiser-facing text.
import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { courtDisplayName, type BoardFixture } from "../types";
import { BoardAgenda } from "../board-agenda";
import { BoardLanes } from "../board-lanes";

function fx(over: Partial<BoardFixture> & { id: string }): BoardFixture {
  return {
    stage_id: "st-1",
    division_id: "d1",
    round_no: 1,
    seq_in_round: 1,
    home_entrant_id: "e1",
    away_entrant_id: "e2",
    scheduled_at: "2026-08-01T10:00:00.000Z",
    venue: null,
    court_label: null,
    court_id: null,
    court_name: null,
    status: "scheduled",
    schedule_source: "manual",
    schedule_locked: false,
    outcome: null,
    ...over,
  };
}

describe("courtDisplayName", () => {
  it("prefers the resolved name", () => {
    expect(courtDisplayName({ court_name: "Show Court", court_label: "Court 1" })).toBe("Show Court");
  });

  it("falls back to the frozen label for a pre-cutover fixture with no resolved name yet", () => {
    expect(courtDisplayName({ court_name: null, court_label: "Court 1" })).toBe("Court 1");
  });

  it("is null — never a raw id — when neither is known (the post-cutover shape)", () => {
    expect(courtDisplayName({ court_name: null, court_label: null })).toBeNull();
  });
});

const agendaProps = {
  divisionNames: {},
  entrantNames: { e1: "Ada", e2: "Bea" },
  feedLabels: {},
  fixtureTitles: {},
  conflictsByFixture: {},
  canEdit: true,
  multi: false,
  pickedId: null,
  onPick: () => {},
  onPlace: () => {},
  onTogglePin: () => {},
  highlightId: null,
};

describe("BoardAgenda court caption", () => {
  it("shows the resolved court name", () => {
    const html = renderToStaticMarkup(
      <BoardAgenda {...agendaProps} fixtures={[fx({ id: "a", court_id: "crt-1", court_name: "Show Court" })]} />,
    );
    expect(html).toContain("Show Court");
  });

  it("never renders a bare court_id (uuid) when no name has resolved", () => {
    const RAW_ID = "3d6c2e2a-0000-4000-8000-000000000009";
    const html = renderToStaticMarkup(
      <BoardAgenda {...agendaProps} fixtures={[fx({ id: "a", court_id: RAW_ID, court_name: null, court_label: null })]} />,
    );
    expect(html).not.toContain(RAW_ID);
  });

  it("falls back to the frozen court_label for a pre-cutover fixture", () => {
    const html = renderToStaticMarkup(
      <BoardAgenda {...agendaProps} fixtures={[fx({ id: "a", court_id: null, court_name: null, court_label: "Court 3" })]} />,
    );
    expect(html).toContain("Court 3");
  });
});

const lanesProps = {
  day: "2026-08-01",
  divisions: [{ id: "d1", name: "Open", slug: "open", status: "active", seq: 1 }],
  entrantNames: { e1: "Ada", e2: "Bea" },
  feedLabels: {},
  fixtureTitles: {},
  conflictsByFixture: {},
  canEdit: true,
  pickedId: null,
  onPick: () => {},
  onTogglePin: () => {},
  highlightId: null,
};

describe("BoardLanes court caption", () => {
  it("shows the resolved court name", () => {
    const html = renderToStaticMarkup(
      <BoardLanes {...lanesProps} fixtures={[fx({ id: "a", court_id: "crt-1", court_name: "Show Court" })]} />,
    );
    expect(html).toContain("Show Court");
  });

  it("never renders a bare court_id (uuid) when no name has resolved", () => {
    const RAW_ID = "3d6c2e2a-0000-4000-8000-000000000009";
    const html = renderToStaticMarkup(
      <BoardLanes {...lanesProps} fixtures={[fx({ id: "a", court_id: RAW_ID, court_name: null, court_label: null })]} />,
    );
    expect(html).not.toContain(RAW_ID);
  });
});
