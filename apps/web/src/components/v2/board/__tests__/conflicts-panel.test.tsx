// ConflictsPanel's cardTitle() call was missing `msg` (useMsg()) as the 4th
// arg — an unfilled slot's title fell through to cardTitle's client-safe
// English default (board/types.ts) regardless of this org's real locale
// (fix round 3, Important 3). Mirrors fixture-block.test.tsx's DictProvider
// pattern — ConflictsPanel has no jsdom-only hooks (its lone useEffect
// simply never fires under renderToStaticMarkup, which is fine: nothing
// here depends on it running).
import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { DictProvider } from "@/components/i18n/dict-provider";
import type { Dict } from "@/lib/i18n-constants";
import es from "@/dictionaries/es/ui.json";
import { ConflictsPanel } from "../conflicts-panel";
import type { BoardConflict, BoardFixture } from "../types";

const esDict = es as unknown as Dict;

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
