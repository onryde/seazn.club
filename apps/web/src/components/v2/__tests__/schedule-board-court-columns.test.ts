// P9 pass 4c item 1: the board's court-COLUMN list used to merge a fixture's
// frozen `court_label` (a legacy NAME) straight into `cfg.courts` (real ids
// since P9 pass 1) — a mixed-identity list. `BoardGrid` matches a column
// against `f.court_id` (`sameCol`, pass 4a), so a label entry could never
// match any fixture there, and a real id's column could silently miss a
// fixture whose only known court was still the frozen label. This file pins
// `boardCourtColumns` at id-only.
import { describe, expect, it } from "vitest";
import { boardCourtColumns } from "../schedule-board";
import type { BoardFixture, GhostBlock } from "../board/types";

const fx = (o: Partial<Pick<BoardFixture, "court_id">>): Pick<BoardFixture, "court_id"> => ({
  court_id: null,
  ...o,
});

describe("boardCourtColumns", () => {
  it("never merges a fixture's court_label — only court_id ever reaches the column list", () => {
    // A pre-cutover fixture: no court_id, only the frozen label. The old memo
    // pushed "Legacy Court" onto the list; BoardGrid's sameCol(f.court_id)
    // could then never match it (a real column string never equals null),
    // so the fixture silently vanished from the grid while an unmatchable
    // "Legacy Court" column sat there empty.
    const out = boardCourtColumns(["crt-1"], [fx({ court_id: null })], null);
    expect(out).toEqual(["crt-1"]);
  });

  it("adds a scheduled fixture's court_id when it isn't already configured", () => {
    const out = boardCourtColumns(["crt-1"], [fx({ court_id: "crt-2" }), fx({ court_id: "crt-1" })], null);
    expect(out).toEqual(["crt-1", "crt-2"]);
  });

  it("keeps two courts that share a NAME (different venues) as two separate columns", () => {
    // The identical case exposed a real bug in groupByCourt server-side (P9)
    // — not assumed to work for free at this layer either. Both courts are
    // named "Court 1" by a human; this function only ever sees their ids, so
    // a same-name collision at the display layer can't collapse them here.
    const out = boardCourtColumns(["venue-north-court-1", "venue-south-court-1"], [], null);
    expect(out).toEqual(["venue-north-court-1", "venue-south-court-1"]);
    expect(new Set(out).size).toBe(2);
  });

  it("adds an AI ghost's proposed court when it isn't already in the list", () => {
    const ghosts: Pick<GhostBlock, "court">[] = [{ court: "crt-2" }, { court: null }];
    const out = boardCourtColumns(["crt-1"], [], ghosts);
    expect(out).toEqual(["crt-1", "crt-2"]);
  });
});
