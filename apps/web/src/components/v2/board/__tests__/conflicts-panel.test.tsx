// ConflictsPanel's cardTitle() call was missing `msg` (useMsg()) as the 4th
// arg — an unfilled slot's title fell through to cardTitle's client-safe
// English default (board/types.ts) regardless of this org's real locale
// (fix round 3, Important 3). Mirrors fixture-block.test.tsx's DictProvider
// pattern — ConflictsPanel has no jsdom-only hooks (its lone useEffect
// simply never fires under renderToStaticMarkup, which is fine: nothing
// here depends on it running).
//
// Regression (C3 review findings 2+3): `ConflictsPanel` built its
// `fixtureTitles` map from its own `board` prop, on the claim that `board`
// "already carries every fixture (unfiltered by day)". True on the DAY
// axis, false on the DIVISION one — schedule-board.tsx passes this panel
// `board = actions.board.filter((f) => visibleIds.has(f.division_id))`
// (the SAME file deliberately builds `FixtureBlock`'s own `fixtureTitles`
// from the unfiltered `actions.board` for exactly this reason). On a board
// filtered to one division, a cross-division court clash named its
// counterparty by an 8-char short id in this panel while the card's own
// tooltip (fed the unfiltered map) named it in full.
import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { DictProvider } from "@/components/i18n/dict-provider";
import type { Dict, Locale } from "@/lib/i18n-constants";
import es from "@/dictionaries/es/ui.json";
import en from "@/dictionaries/en/ui.json";
import { ConflictsPanel } from "../conflicts-panel";
import type { BoardConflict, BoardFixture } from "../types";

const esDict = es as unknown as Dict;
const enDict = en as unknown as Dict;

const TBD_FIXTURE: BoardFixture = {
  id: "f1",
  stage_id: "st-1",
  division_id: "d1",
  round_no: 1,
  seq_in_round: 1,
  home_entrant_id: null,
  away_entrant_id: null,
  home_slot_label: { key: "slot.winner_group", params: { g: "A" } },
  away_slot_label: { key: "slot.winner_group", params: { g: "B" } },
  scheduled_at: null,
  venue: null,
  court_label: null,
  status: "scheduled",
  schedule_source: "manual",
  schedule_locked: false,
  outcome: null,
};

const CONFLICT: BoardConflict = {
  fixture_id: "f1",
  code: "warn.rest",
  blocking: false,
  detail: "entrant e1 below rest",
};

describe("ConflictsPanel", () => {
  it("fix round 3 (Important 3): names an unfilled slot in this org's REAL locale, not cardTitle's client-safe English default", () => {
    const html = renderToStaticMarkup(
      <DictProvider dict={esDict} locale="es">
        <ConflictsPanel
          conflicts={[CONFLICT]}
          board={[TBD_FIXTURE]}
          entrantNames={{}}
          feedLabels={{}}
          divisionNames={{}}
          onJump={() => {}}
          onClose={() => {}}
          checkFailed={false}
          checking={false}
          onRetryCheck={() => {}}
        />
      </DictProvider>,
    );
    expect(html).toContain("Ganador del Grupo A");
    expect(html).toContain("Ganador del Grupo B");
    expect(html).not.toContain("Winner of Group A");
  });
});

// The panel's own (division-filtered) `board` prop — only this one fixture,
// mirroring schedule-board.tsx's `board = actions.board.filter(...)`.
const FILTERED_FIXTURE: BoardFixture = {
  id: "f1",
  division_id: "d1",
  home_entrant_id: "e1",
  away_entrant_id: "e2",
  scheduled_at: "2026-08-01T09:00:00.000Z",
  court_label: "Court 1",
  status: "scheduled",
  schedule_locked: false,
} as unknown as BoardFixture;

// The cross-division counterparty a division filter has dropped from
// `board` — present ONLY in a board-wide `fixtureTitles` map, never in this
// panel's own `board` prop, exactly like `actions.board` vs the filtered
// `board` in schedule-board.tsx.
const OTHER_FIXTURE_ID = "22222222-2222-4222-8222-222222222222";

// An UNMAPPED code (no `board.conflictHelp.<code>` key, no `CONFLICT_HELP`
// entry) — the only way to actually reach `formatBoardConflictDetail` from
// this panel, same trick `schedule-gate-dialog.test.tsx`'s own such test
// uses: every REAL code in this file's fixtures would short-circuit to the
// generic locale help before ever touching `fixtureTitles`.
const CROSS_DIVISION_CLASH: BoardConflict = {
  fixture_id: "f1",
  code: "warn.some_future_code",
  blocking: true,
  details: { kind: "court_double_booking", court: "Court 1", other_fixture_id: OTHER_FIXTURE_ID },
} as unknown as BoardConflict;

function panelMarkup(fixtureTitles?: Record<string, string>): string {
  return renderToStaticMarkup(
    <DictProvider locale={"en" as Locale} dict={enDict}>
      <ConflictsPanel
        conflicts={[CROSS_DIVISION_CLASH]}
        board={[FILTERED_FIXTURE]}
        entrantNames={{ e1: "Alpha", e2: "Bravo" }}
        feedLabels={{}}
        divisionNames={{ d1: "Open" }}
        onJump={() => undefined}
        onClose={() => undefined}
        checkFailed={false}
        checking={false}
        onRetryCheck={() => undefined}
        fixtureTitles={fixtureTitles}
      />
    </DictProvider>,
  );
}

describe("ConflictsPanel names a cross-division counterparty (C3 review findings 2+3)", () => {
  it("names the counterparty in full when the board-wide fixtureTitles map supplies it", () => {
    const html = panelMarkup({ [OTHER_FIXTURE_ID]: "Charlie vs Delta" });
    expect(html).toContain("Charlie vs Delta");
    expect(html).not.toContain(OTHER_FIXTURE_ID.slice(0, 8));
  });

  it("degrades to the short id — never a full UUID — when no fixtureTitles prop is supplied (optional, additive)", () => {
    const html = panelMarkup(undefined);
    expect(html).toContain(OTHER_FIXTURE_ID.slice(0, 8));
    expect(html).not.toContain("Charlie vs Delta");
    expect(html).not.toContain(OTHER_FIXTURE_ID);
  });
});
