import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { StagesPanel } from "@/components/v2/stages-panel";
import { resolvePhase, type PhaseInput } from "@/lib/division-phase";

vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn(), push: vi.fn() }) }));
vi.mock("@/components/ui/confirm-provider", () => ({ useConfirm: () => vi.fn(async () => false) }));
vi.mock("@/components/ui/tip", () => ({ TipCallout: ({ id }: { id: string }) => <div data-tip={id} /> }));

const stage = (o: Partial<{ id: string; seq: number; kind: string; name: string; status: string }> = {}) => ({
  id: "s1", seq: 1, kind: "league", name: "League", config: {}, progression: null, status: "active", ...o,
});
const fixture = (stageId: string, o: Partial<{ id: string; status: string; fixture_no: number }> = {}) => ({
  id: `f-${stageId}`, stage_id: stageId, pool_id: null, round_no: 1, seq_in_round: 1, fixture_no: 1,
  home_entrant_id: "e1", away_entrant_id: "e2", scheduled_at: null, venue: null, court_label: null,
  court_id: null, court_name: null, status: "scheduled", outcome: null, ...o,
});
const baseProps = {
  divisionId: "d1", competitionId: "c1", orgSlug: "org", compSlug: "comp", divSlug: "div",
  stages: [stage()], fixtures: [fixture("s1")], entrantNames: { e1: "Alpha", e2: "Bravo" },
  canEdit: true, tz: "UTC", orgTz: "UTC", canExport: false,
  viewerPlan: "community" as const,
};

const TIP = 'data-tip="division.start-locks"';

describe("StagesPanel phase gating", () => {
  it("shows the start-locks tip while setting up with nothing played, never once play is under way", () => {
    expect(renderToStaticMarkup(<StagesPanel {...baseProps} phase="setting_up" />)).toContain(TIP);
    expect(renderToStaticMarkup(<StagesPanel {...baseProps} phase="scheduled" />)).not.toContain(TIP);
    expect(renderToStaticMarkup(<StagesPanel {...baseProps} phase="finished" />)).not.toContain(TIP);
    // The panel never renders the tip without a phase at all (an absent
    // prop is the safe direction, per the `phase?` prop's own contract).
    expect(renderToStaticMarkup(<StagesPanel {...baseProps} />)).not.toContain(TIP);
  });

  /**
   * L1 (fix round H, Critical — instance ELEVEN). `setting_up` does NOT mean
   * "nothing has happened yet": `resolvePhase`'s RULE 4 returns it for a
   * division whose whole league is played and complete while a later stage
   * still owes its fixtures. The tip then told an organiser looking at six
   * Decided results and "1. League · Complete" to "Finish seeding and
   * structure first". Driven end to end through the production API at
   * 09:30:31–09:30:45Z on 2026-09-03, arriving via the desk's own red "Open
   * fixtures" action.
   *
   * The state is BUILT from `resolvePhase` rather than asserted from a
   * hand-typed word — a table typed into the test is what let the previous
   * version of this file pin the gate for three phases and never ask whether
   * `setting_up` could mean "already played out". The `expect(phase)` line is
   * the premise: if rule 4 ever stops producing `setting_up` here, this test
   * says so instead of passing for the wrong reason.
   */
  const playedOutInput = (): PhaseInput => ({
    divisionStatus: "active",
    stages: [
      { id: "s1", name: "League", seq: 1, status: "complete", hasFixtures: true, timing: null, sourceReady: false, proposal: "none" as const },
      { id: "s2", name: "Finals", seq: 2, status: "pending", hasFixtures: false, timing: null, sourceReady: false, proposal: "none" as const },
    ],
    fixtures: [1, 2, 3, 4, 5, 6].map((n) => ({
      id: `f${n}`, status: "decided", scheduledAt: null, startedAt: null, eventCount: 0, matchMinutes: 30, hasScorer: true,
      stageId: "s1", awaitsSeedDraw: false,
    })),
    now: "2026-03-01T12:00:00Z",
    tz: "UTC",
    awaitingRegistrations: 0,
  });

  it("never shows the start-locks tip on a division that has already played its fixtures", () => {
    const input = playedOutInput();
    const phase = resolvePhase(input);
    expect(phase).toBe("setting_up");
    const html = renderToStaticMarkup(
      <StagesPanel
        {...baseProps}
        phase={phase}
        stages={[stage({ status: "complete" }), stage({ id: "s2", seq: 2, kind: "knockout", name: "Finals", status: "pending" })]}
        fixtures={input.fixtures.map((f, i) => fixture("s1", { id: f.id, status: "decided", fixture_no: i + 1 }))}
      />,
    );
    expect(html).not.toContain(TIP);
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
