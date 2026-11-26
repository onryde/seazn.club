// The surfaces that hold the engine's own conflict shape (camelCase `details`) rather than the board's
// wire shape: the AI diff card, the AI review card and the merge report. A round-order conflict arrives
// there under the feeder's reason (`order`) or the generic `no_slot`, so labelling it by reason says
// "plays before feeder" about rounds that feed nothing.
import { describe, expect, it } from "vitest";
import type { ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { ConflictDetail } from "@seazn/engine/scheduling";
import type { AiPlanResponse } from "@/server/api-v1/schemas";
import type { Dict } from "@/lib/i18n-constants";
import { DictProvider } from "@/components/i18n/dict-provider";
import { MergeOutcomeCard } from "@/components/v2/duplicates-panel";
import en from "@/dictionaries/en/ui.json";
import { AiDiffPanel } from "../ai-diff-panel";
import { AiReviewPanel } from "../ai-review-panel";
import { buildReviewRows } from "../ai-review";
import type { AiConsoleFixture } from "../ai-diff";

const dict = en as Record<string, string>;
const ROUND = dict["board.conflict.warn.round_order"]!;
const FEEDER = dict["board.conflict.warn.order"]!;
const NO_SLOT = dict["board.conflict.warn.no_slot"]!;
const FIX = "11111111-1111-1111-1111-111111111111";

const fixtures: AiConsoleFixture[] = [
  { id: FIX, stage_id: "st-1", scheduled_at: null, court_label: null, code: "R1", matchup: "A vs B", isFinal: false, isJunior: false, status: "scheduled", home_entrant_id: "en-a", away_entrant_id: "en-b" },
];

/** Every round-order kind, under the reason token it travels with. */
const ROUND_CASES: { reason: string; kind: ConflictDetail["kind"] }[] = [
  { reason: "order", kind: "round_order_day" },
  { reason: "order", kind: "round_order_same_day" },
  { reason: "order", kind: "round_order_end" },
  { reason: "no_slot", kind: "no_slot_round_barrier" },
];
const FEEDER_CASE = { reason: "order", kind: "order_before_feeder" } as const;

const conflict = (c: { reason: string; kind: ConflictDetail["kind"] }) => ({
  fixtureId: FIX,
  reason: c.reason,
  details: { kind: c.kind, roundNo: 2, otherRoundNo: 1, day: "2026-11-26", otherDay: "2026-11-27" },
});

const render = (node: ReactElement): string =>
  renderToStaticMarkup(
    <DictProvider dict={dict as unknown as Dict} locale="en">
      {node}
    </DictProvider>,
  );

const diffCard = (c: ReturnType<typeof conflict>): string => {
  const plan: AiPlanResponse = {
    proposal: [],
    unschedulable: [],
    warnings: [],
    blocking: [c],
    diff: { moved: [], placed: [], unscheduled: [], unchanged: [] },
    explanations: [],
    summary: "s",
    assumptions: [],
    usage: { input_tokens: 1, output_tokens: 1, repair_rounds: 0 },
    repair: { engine: "none" as const, solver_ran: false },
    officials_coverage: null,
  };
  return render(<AiDiffPanel plan={plan} fixtures={fixtures} excluded={[]} onToggleExclude={() => {}} />);
};

const reviewCard = (c: ReturnType<typeof conflict>): string =>
  render(
    <AiReviewPanel rows={buildReviewRows({ warnings: [c], unschedulable: [], assumptions: [] })} fixtures={fixtures} />,
  );

describe.each([
  ["the AI diff card", diffCard],
  ["the AI review card", reviewCard],
])("round-order wording on %s", (_name, card) => {
  it("labels every round-order kind as rounds, never as feeding or a bare no-slot", () => {
    let checked = 0;
    for (const c of ROUND_CASES) {
      const html = card(conflict(c));
      expect(html, c.kind).toContain(`>${ROUND}<`);
      expect(html, c.kind).not.toContain(FEEDER);
      expect(html, c.kind).not.toContain(`>${NO_SLOT}<`);
      checked++;
    }
    expect(checked).toBe(4);
  });

  it("keeps the feeder wording for a real feeder conflict", () => {
    const html = card(conflict(FEEDER_CASE));
    expect(html).toContain(`>${FEEDER}<`);
    expect(html).not.toContain(ROUND);
  });
});

describe("round-order wording on the merge report", () => {
  const chips = (conflicts: ReturnType<typeof conflict>[]): string[] => {
    const html = render(
      <MergeOutcomeCard
        survivorName="Ada"
        boards={[{ division_id: "d1", name: "Spring League", status: "active", conflicts }]}
        onUndo={() => {}}
        onClose={() => {}}
      />,
    );
    return [...html.matchAll(/data-conflict-reason="[^"]*"[^>]*>([^<]*)</g)].map((m) => m[1]!);
  };

  it("says rounds once for several round-order conflicts, whatever their reason's own label is", () => {
    expect(chips(ROUND_CASES.slice(0, 3).map(conflict))).toEqual([ROUND]);
    expect(chips([conflict(ROUND_CASES[3]!)])).toEqual([ROUND]);
  });

  it("keeps a feeder chip beside a round-order one under the same reason", () => {
    expect(chips([conflict(ROUND_CASES[0]!), conflict(FEEDER_CASE)])).toEqual([ROUND, FEEDER]);
  });
});
