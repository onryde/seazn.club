// Regression (C3 phase 4 — the gap found reviewing phase 3): `AiDiffPanel`
// hardcoded `entrantNames: {}` in its `formatConflictDetail` call, so an
// `entrant_overlap`/`entrant_below_rest` conflict's entrant always rendered
// as an 8-char short id even when the board's real entrant-name map was
// available upstream (`schedule-board.tsx`'s `entrantNames` prop, already
// threaded to `BoardGrid`/`BoardAgenda`/`fixture-block.tsx`, just never to
// the AI console). `entrantNames` is now an OPTIONAL prop defaulting to
// `{}` — additive, so a caller that never supplies it keeps today's
// behaviour byte-for-byte.
//
// Both halves matter: the real-name case proves the prop is actually wired
// through to `formatConflictDetail`, and the short-id case proves the
// optional default still degrades exactly as before rather than throwing or
// rendering a raw UUID.
import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { AiPlanResponse } from "@/server/api-v1/schemas";
import type { Dict } from "@/lib/i18n-constants";
import { DictProvider } from "@/components/i18n/dict-provider";
import { AiDiffPanel } from "../ai-diff-panel";
import type { AiConsoleFixture } from "../ai-diff";
import en from "@/dictionaries/en/ui.json";

const enDict = en as Record<string, string>;

const FIX = "11111111-1111-1111-1111-111111111111";
const OTHER_FIX = "22222222-2222-2222-2222-222222222222";
const ENTRANT = "33333333-3333-3333-3333-333333333333";

// `entrant_overlap` is one of only two `ConflictDetailKind`s that carry
// `entrantIds` (the other is `entrant_below_rest`) — the whole visible
// surface of this gap.
const plan: AiPlanResponse = {
  proposal: [],
  unschedulable: [],
  warnings: [],
  blocking: [
    {
      fixtureId: FIX,
      reason: "entrant",
      details: { kind: "entrant_overlap", entrantIds: [ENTRANT], otherFixtureId: OTHER_FIX },
    },
  ],
  diff: { moved: [], placed: [], unscheduled: [], unchanged: [] },
  explanations: [],
  summary: "Kept the entrant clear.",
  assumptions: [],
  usage: { input_tokens: 10, output_tokens: 5, repair_rounds: 0 },
  repair: { engine: "none" as const, solver_ran: false },
  officials_coverage: null,
};

const fixtures: AiConsoleFixture[] = [
  {
    id: FIX,
    stage_id: "st-1",
    scheduled_at: null,
    court_label: null,
    code: "SF1",
    matchup: "A vs B",
    isFinal: false,
    isJunior: false,
    status: "scheduled",
    home_entrant_id: ENTRANT,
    away_entrant_id: "en-b",
  },
  {
    id: OTHER_FIX,
    stage_id: "st-1",
    scheduled_at: null,
    court_label: null,
    code: "SF2",
    matchup: "C vs D",
    isFinal: false,
    isJunior: false,
    status: "scheduled",
    home_entrant_id: "en-c",
    away_entrant_id: "en-d",
  },
];

function renderPanel(entrantNames?: Record<string, string>): string {
  return renderToStaticMarkup(
    <DictProvider dict={enDict as unknown as Dict} locale="en">
      <AiDiffPanel
        plan={plan}
        fixtures={fixtures}
        excluded={[]}
        onToggleExclude={() => {}}
        entrantNames={entrantNames}
      />
    </DictProvider>,
  );
}

describe("AiDiffPanel entrant-name resolution (C3 phase 4)", () => {
  it("shows the entrant's display name when entrantNames supplies one", () => {
    const html = renderPanel({ [ENTRANT]: "Wildcats" });
    const expected = enDict["board.conflict.detail.entrant_overlap"]!
      .replace("{entrant}", "Wildcats")
      .replace("{other}", "C vs D");
    expect(html).toContain(expected);
    // Non-vacuity: the short id must not appear where the name should be.
    expect(html).not.toContain(ENTRANT.slice(0, 8));
  });

  it("degrades to the 8-char short id when entrantNames is not supplied (the optional prop's default)", () => {
    const html = renderPanel(undefined);
    const expected = enDict["board.conflict.detail.entrant_overlap"]!
      .replace("{entrant}", ENTRANT.slice(0, 8))
      .replace("{other}", "C vs D");
    expect(html).toContain(expected);
    // Non-vacuity: no full UUID, and the name from the other test never leaks in.
    expect(html).not.toContain(ENTRANT);
    expect(html).not.toContain("Wildcats");
  });
});
