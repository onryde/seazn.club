// T16 (D12) — the stage card mounts the organiser's Open round control for
// ITS rounds (`openRounds`, keyed by stage id; listOpenRounds' answer, which
// the division page hands down only while the club is offered online chess).
// Nothing for a viewer, nothing without the map. What the control itself
// renders is open-round-control.test.tsx's.
import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { StagesPanel } from "@/components/v2/stages-panel";
import type { OpenRoundView } from "@/lib/open-round";

vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn(), push: vi.fn() }) }));
vi.mock("@/components/ui/confirm-provider", () => ({ useConfirm: () => vi.fn(async () => false) }));
vi.mock("@/components/ui/tip", () => ({ TipCallout: ({ id }: { id: string }) => <div data-tip={id} /> }));

const stage = (id: string, seq: number) => ({ id, seq, kind: "swiss", name: `Stage ${seq}`, config: {}, progression: null, status: "active" });
const fixture = (stageId: string, no: number) => ({
  id: `f${no}`, stage_id: stageId, pool_id: null, round_no: 1, seq_in_round: no, fixture_no: no,
  home_entrant_id: "e1", away_entrant_id: "e2", scheduled_at: null, venue: null, court_label: null,
  court_id: null, court_name: null, status: "scheduled", outcome: null,
});
const ROUND = (stageId: string, fixtureId: string): OpenRoundView => ({
  stageId,
  stageName: "Swiss",
  roundNo: 1,
  state: "paired",
  openedAt: null,
  deadlineAt: null,
  windowMinutes: 20,
  scheduledAt: null,
  press: "open",
  pairings: [{ fixtureId, boardNo: 1, whiteName: "Ada", blackName: "Bo", invitedAt: null, owedSeats: 2, canResend: false }],
});
const PROPS = {
  divisionId: "d1", competitionId: "c1", orgSlug: "org", compSlug: "comp", divSlug: "div",
  stages: [stage("s1", 1), stage("s2", 2)], fixtures: [fixture("s1", 1), fixture("s2", 2)],
  entrantNames: { e1: "Alpha", e2: "Bravo" }, canEdit: true, tz: "UTC", orgTz: "UTC", canExport: false,
  viewerPlan: "community" as const, sportKey: "boardgame",
};
/** The stage card holding this testid'd element, by the card's own stage id attribute. */
const cardOf = (h: string, stageId: string) => {
  const start = h.indexOf(`data-stage-id="${stageId}"`);
  expect(start, `stage card ${stageId}`).toBeGreaterThan(-1);
  const next = h.indexOf("data-stage-id=", start + 1);
  return h.slice(start, next === -1 ? undefined : next);
};

describe("the stage card's Open round control", () => {
  it("the empty case first: no map ⇒ no control (the cards render)", () => {
    const h = renderToStaticMarkup(<StagesPanel {...PROPS} />);
    expect(h).toContain('data-testid="stage-progress"');
    expect(h).not.toContain('data-testid="open-round"');
  });

  it("each stage card mounts ITS OWN rounds' control, and only those", () => {
    const h = renderToStaticMarkup(<StagesPanel {...PROPS} openRounds={{ s2: [ROUND("s2", "f2")] }} />);
    expect(h.split('data-testid="open-round"').length - 1).toBe(1);
    expect(cardOf(h, "s2")).toContain('data-testid="open-round-pending-f2"');
    expect(cardOf(h, "s1")).not.toContain('data-testid="open-round"');
  });

  it("a viewer (no edit) gets no control, even with the map", () => {
    const h = renderToStaticMarkup(<StagesPanel {...PROPS} canEdit={false} openRounds={{ s1: [ROUND("s1", "f1")] }} />);
    expect(h).toContain('data-testid="stage-progress"');
    expect(h).not.toContain('data-testid="open-round"');
  });
});
