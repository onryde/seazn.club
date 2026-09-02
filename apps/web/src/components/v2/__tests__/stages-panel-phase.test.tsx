import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { StagesPanel } from "@/components/v2/stages-panel";

vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn(), push: vi.fn() }) }));
vi.mock("@/components/ui/confirm-provider", () => ({ useConfirm: () => vi.fn(async () => false) }));
vi.mock("@/components/ui/tip", () => ({ TipCallout: ({ id }: { id: string }) => <div data-tip={id} /> }));

const stage = (o: Partial<{ id: string; seq: number; kind: string; name: string; status: string }> = {}) => ({
  id: "s1", seq: 1, kind: "league", name: "League", config: {}, progression: null, status: "active", ...o,
});
const fixture = (stageId: string) => ({
  id: `f-${stageId}`, stage_id: stageId, pool_id: null, round_no: 1, seq_in_round: 1, fixture_no: 1,
  home_entrant_id: "e1", away_entrant_id: "e2", scheduled_at: null, venue: null, court_label: null,
  court_id: null, court_name: null, status: "scheduled", outcome: null,
});
const baseProps = {
  divisionId: "d1", divisionSeq: 5, competitionId: "c1", orgSlug: "org", compSlug: "comp", divSlug: "div",
  stages: [stage()], fixtures: [fixture("s1")], entrantNames: { e1: "Alpha", e2: "Bravo" },
  canEdit: true, tz: "UTC", orgTz: "UTC", canExport: false,
};

describe("StagesPanel phase gating", () => {
  it("shows the start-locks tip only while setting up", () => {
    expect(renderToStaticMarkup(<StagesPanel {...baseProps} phase="setting_up" />)).toContain('data-tip="division.start-locks"');
    expect(renderToStaticMarkup(<StagesPanel {...baseProps} phase="scheduled" />)).not.toContain('data-tip="division.start-locks"');
    expect(renderToStaticMarkup(<StagesPanel {...baseProps} phase="finished" />)).not.toContain('data-tip="division.start-locks"');
  });
  it("renders stages by seq: a complete stage 1 stays above a pending stage 2", () => {
    const html = renderToStaticMarkup(
      <StagesPanel {...baseProps} phase="setting_up"
        stages={[stage({ id: "s2", seq: 2, status: "pending", name: "Finals" }), stage({ id: "s1", seq: 1, status: "complete", name: "League" })]}
        fixtures={[fixture("s1")]} />,
    );
    expect(html.indexOf("League")).toBeGreaterThan(-1);
    expect(html.indexOf("League")).toBeLessThan(html.indexOf("Finals"));
  });
});
