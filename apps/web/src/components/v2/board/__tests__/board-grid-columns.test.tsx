// P9 pass 4a item 2: the board grid's column identity. `sameCol` used to
// compare a fixture's frozen, null `court_label` against the (now
// court_id-shaped) `courts` list — a real column string never equals `null`,
// so a fixture never matched ANY column and silently vanished from the grid
// entirely. Column identity must be `court_id`.
import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { BoardGrid } from "../board-grid";
import type { BoardFixture } from "../types";

const T11 = Date.parse("2026-08-10T11:00:00.000Z");

const baseProps = {
  day: "2026-08-10",
  slots: [T11],
  slotMinutes: 30,
  fixtures: [],
  divisionNames: {},
  feedLabels: {},
  fixtureTitles: {},
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

function fx(id: string, o: Partial<BoardFixture> & { court_id: string | null }): BoardFixture {
  return {
    id,
    stage_id: "st-1",
    division_id: "d1",
    round_no: 1,
    seq_in_round: 1,
    home_entrant_id: null,
    away_entrant_id: null,
    scheduled_at: "2026-08-10T11:00:00.000Z",
    venue: null,
    court_label: null, // frozen legacy — every post-cutover fixture has this
    court_name: null,
    status: "scheduled",
    schedule_source: "manual",
    schedule_locked: false,
    outcome: null,
    ...o,
  };
}

/** Splits the (single-row) rendered table on `<td` boundaries: [time, col0,
 *  col1, …] — robust to markup/class churn since it only counts cell edges. */
function cells(html: string): string[] {
  return html.split("<td").slice(1);
}

describe("BoardGrid column identity", () => {
  it("groups a fixture into its court_id's column even though court_label is null (post-cutover shape)", () => {
    const html = renderToStaticMarkup(
      <BoardGrid
        {...baseProps}
        courts={["crt-a", "crt-b"]}
        fixtures={[fx("a", { court_id: "crt-a", home_entrant_id: "e1", away_entrant_id: "e2" })]}
        entrantNames={{ e1: "Ada", e2: "Bea" }}
      />,
    );
    const [, colA, colB] = cells(html);
    expect(colA).toContain("Ada");
    expect(colB).not.toContain("Ada");
  });

  it("keeps two courts that share a NAME (different venues) as two separate columns", () => {
    // BoardGrid has no notion of a court's display NAME at all — it groups
    // purely on the court_id string — so this proves id-keyed grouping holds
    // even for the case a human would call "Court 1" twice. (groupByCourt's
    // server-side equivalent just shipped a real same-name bug — P9 — so
    // this is not assumed to work for free at this layer either.)
    const html = renderToStaticMarkup(
      <BoardGrid
        {...baseProps}
        courts={["venue-north-court-1", "venue-south-court-1"]}
        fixtures={[
          fx("north", { court_id: "venue-north-court-1", home_entrant_id: "e1", away_entrant_id: "e2" }),
          fx("south", { court_id: "venue-south-court-1", home_entrant_id: "e3", away_entrant_id: "e4" }),
        ]}
        entrantNames={{ e1: "Ada", e2: "Bea", e3: "Cy", e4: "Del" }}
      />,
    );
    const [, colNorth, colSouth] = cells(html);
    expect(colNorth).toContain("Ada");
    expect(colNorth).not.toContain("Cy");
    expect(colSouth).toContain("Cy");
    expect(colSouth).not.toContain("Ada");
  });

  it("a fixture whose court_id matches no configured column renders nowhere (not merged into another column)", () => {
    const html = renderToStaticMarkup(
      <BoardGrid
        {...baseProps}
        courts={["crt-a"]}
        fixtures={[fx("orphan", { court_id: "crt-gone", home_entrant_id: "e1", away_entrant_id: "e2" })]}
        entrantNames={{ e1: "Ada", e2: "Bea" }}
      />,
    );
    expect(html).not.toContain("Ada");
  });
});
