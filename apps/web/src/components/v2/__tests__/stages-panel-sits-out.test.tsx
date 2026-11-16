// W5 app PR A, Task 3 (X-SF-4): the stage card's run sheet says who sits out each round - the seam from `stages.config.round_byes` (stored the way
// Generate stores the engine's byes) through StagesPanel to the round bar, driven through the real panel (AGENTS.md class 1: a builder that
// nothing mounts is an inert seam). Who has left the field is the page's `activeEntrantIds` complement; with no roster the panel names no one
// (never a bye dressed up as a fact).
import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { generateRoundRobin } from "@seazn/engine/scheduling";
import { StagesPanel } from "@/components/v2/stages-panel";

vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn(), push: vi.fn() }) }));
vi.mock("@/components/ui/confirm-provider", () => ({ useConfirm: () => vi.fn(async () => false) }));

const IDS = ["e1", "e2", "e3", "e4", "e5"];
const NAMES: Record<string, string> = { e1: "Ana", e2: "Bo", e3: "Cy", e4: "Di", e5: "Eve" };
const SCHEDULE = generateRoundRobin({ entrants: IDS, config: { legs: 1 } });
const ROUND_BYES = SCHEDULE.rounds.flatMap((r) => (r.bye === undefined ? [] : [{ pool: null, round_no: r.roundNo, leg: r.leg, entrant_id: r.bye }]));
const STAGE = (config: Record<string, unknown>) => ({ id: "s1", seq: 1, kind: "league", name: "League", config, progression: null, status: "active" });
const FIXTURES = SCHEDULE.fixtures.map((f, i) => ({
  id: `f${i + 1}`, stage_id: "s1", pool_id: null, round_no: f.roundNo, seq_in_round: f.court, fixture_no: i + 1,
  home_entrant_id: f.home, away_entrant_id: f.away, scheduled_at: null, venue: null, court_label: null, court_id: null, court_name: null,
  status: "scheduled", outcome: null,
}));
const base = {
  divisionId: "d1", competitionId: "c1", orgSlug: "org", compSlug: "comp", divSlug: "div",
  entrantNames: NAMES, fixtures: FIXTURES, canEdit: true, tz: "UTC", orgTz: "UTC", canExport: false, viewerPlan: "community" as const,
};
const text = (html: string) => html.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim();
const sitsOutLines = (html: string): string[] =>
  [...html.matchAll(/<span data-run-sheet-round-sits-out[^>]*>([\s\S]*?)<\/span>/g)].map((m) => text(m[1]!).replace(/^·\s*/, ""));

describe("StagesPanel: Sits out reaches the round bar (X-SF-4)", () => {
  it("the empty case first: a stage that recorded no byes (drawn before W5, an even field) draws no line", () => {
    const html = renderToStaticMarkup(<StagesPanel {...base} stages={[STAGE({})]} activeEntrantIds={IDS} />);
    expect(sitsOutLines(html)).toEqual([]);
    expect(html, "anti-vacuity: the five round bars are there").toMatch(/data-run-sheet-round="5"/);
  });

  it("five teams: each round's bar names its resting team (the engine's own bye), in round order", () => {
    const html = renderToStaticMarkup(<StagesPanel {...base} stages={[STAGE({ round_byes: ROUND_BYES })]} activeEntrantIds={IDS} />);
    const got = sitsOutLines(html);
    expect(got).toHaveLength(5);
    expect(new Set(got).size).toBe(5);
    SCHEDULE.rounds.forEach((r) => expect(got).toContain(`Sits out: ${NAMES[r.bye!]}`));
  });

  it("a withdrawn team (not in activeEntrantIds) is not named: its round has no line", () => {
    const html = renderToStaticMarkup(
      <StagesPanel {...base} stages={[STAGE({ round_byes: ROUND_BYES })]} activeEntrantIds={IDS.filter((id) => id !== "e3")} />,
    );
    const got = sitsOutLines(html);
    expect(got).toHaveLength(4);
    expect(got).not.toContain("Sits out: Cy");
  });

  it("with no roster (activeEntrantIds absent) nobody is named: the roster is unknown, never assumed in the field", () => {
    const html = renderToStaticMarkup(<StagesPanel {...base} stages={[STAGE({ round_byes: ROUND_BYES })]} />);
    expect(sitsOutLines(html)).toEqual([]);
  });
});
