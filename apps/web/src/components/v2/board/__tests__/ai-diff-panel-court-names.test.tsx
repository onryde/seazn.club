// P9 review wave 1, finding 4 (MEDIUM): `AiDiffPanel`'s `slot()` rendered
// `s.court_label` verbatim in every from/to row of the AI review panel. Since
// the V374 uuid cutover, the plan's `court_label` field carries a real court
// uuid (see ai-diff.ts's own doc) — so the panel was showing an organiser a
// raw database id instead of a court name. `courtNames` (the same id -> label
// directory `buildCourtDirectory`/`resolveCourtNames` build everywhere else a
// court renders — court-directory.ts, schedule-board.tsx) resolves it; an id
// missing from the directory falls back to the existing
// `courtPicker.unknownCourt` string, never the bare id.
import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { AiPlanResponse } from "@/server/api-v1/schemas";
import type { Dict } from "@/lib/i18n-constants";
import { DictProvider } from "@/components/i18n/dict-provider";
import { AiDiffPanel } from "../ai-diff-panel";
import type { AiConsoleFixture } from "../ai-diff";
import en from "@/dictionaries/en/ui.json";

const enDict = en as Record<string, string>;

const MOVED = "11111111-1111-1111-1111-111111111111";
const COURT_A = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
const COURT_UNKNOWN = "cccccccc-cccc-cccc-cccc-cccccccccccc";
// The fixture's CURRENT court (`fixtures[0].court_id` below) — the ORIGIN
// side of a "moved" row (P9 review wave 3, finding #13).
const COURT_ORIGIN = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb";
// A bare-uuid probe, not tied to any one fixture — any 8-4 hex run anywhere
// in the panel's HTML means an id leaked into user-facing text.
const UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-/;

const fixtures: AiConsoleFixture[] = [
  {
    id: MOVED,
    stage_id: "st-1",
    scheduled_at: "2026-08-01T09:00:00.000Z",
    court_label: null,
    court_id: COURT_ORIGIN,
    code: "SF1",
    matchup: "A vs B",
    isFinal: false,
    isJunior: false,
    status: "scheduled",
    home_entrant_id: "en-a",
    away_entrant_id: "en-b",
  },
];

function plan(courtLabel: string): AiPlanResponse {
  return {
    proposal: [{ fixture_id: MOVED, scheduled_at: "2026-08-01T10:00:00.000Z", court_label: courtLabel }],
    unschedulable: [],
    warnings: [],
    blocking: [],
    diff: { moved: [MOVED], placed: [], unscheduled: [], unchanged: [] },
    explanations: [],
    summary: "Moved SF1.",
    assumptions: [],
    usage: { input_tokens: 10, output_tokens: 5, repair_rounds: 0 },
    repair: { engine: "none" as const, solver_ran: false },
    officials_coverage: null,
  };
}

function renderPanel(courtLabel: string, courtNames?: Record<string, string>): string {
  return renderToStaticMarkup(
    <DictProvider dict={enDict as unknown as Dict} locale="en">
      <AiDiffPanel
        plan={plan(courtLabel)}
        fixtures={fixtures}
        excluded={[]}
        onToggleExclude={() => {}}
        courtNames={courtNames}
      />
    </DictProvider>,
  );
}

describe("AiDiffPanel court-name resolution (P9 review wave 1, finding 4)", () => {
  it("shows the court's display name, never the raw uuid, when courtNames resolves it", () => {
    const html = renderPanel(COURT_A, { [COURT_A]: "Court 2" });
    expect(html).toContain("Court 2");
    expect(html).not.toMatch(UUID_RE);
  });

  it("falls back to the unknown-court label, never a bare uuid, when the id is not in the directory", () => {
    const html = renderPanel(COURT_UNKNOWN, {});
    expect(html).toContain(enDict["courtPicker.unknownCourt"]);
    expect(html).not.toMatch(UUID_RE);
  });
});

// P9 review wave 3, finding #13: `ai-diff.ts`'s `moved.from`/`unscheduled.from`
// used to read the board's frozen (always-null) `court_label` instead of the
// real `court_id`, so a "moved" row's from→to line always showed the
// destination court and silently dropped to time-only for the ORIGIN — the
// bug the tests above never caught because they only asserted the
// destination side.
describe("AiDiffPanel names the ORIGIN court on a moved row too (P9 review wave 3, finding #13)", () => {
  it("resolves BOTH the origin and destination court names on a moved row's from→to line", () => {
    const html = renderPanel(COURT_A, { [COURT_ORIGIN]: "Court 2", [COURT_A]: "Court 3" });
    expect(html).toContain("Court 2"); // the FROM side — this is finding #13's fix
    expect(html).toContain("Court 3"); // the TO side — already worked (finding 4)
    expect(html).not.toMatch(UUID_RE);
  });

  it("the origin degrades to the unknown-court label on its OWN miss, independent of whether the destination resolved", () => {
    // Destination resolves; origin does not — proves the two sides are
    // resolved independently, not by one shared success/failure.
    const html = renderPanel(COURT_A, { [COURT_A]: "Court 3" });
    expect(html).toContain("Court 3");
    expect(html).toContain(enDict["courtPicker.unknownCourt"]);
    expect(html).not.toMatch(UUID_RE);
  });
});
