// T16 (D12) put the organiser's Open round control on each stage card, fed by a `openRounds` map the division page built.
// Phase 2 (spec 2026-10-24-arbiter-round-column-design.md §8, pre-flight C16) moved that control into the Arbiter Panel's round
// column: the stage cards take no rounds, render no control, and the run sheet's online chips lead to the panel only when the
// page says the panel would answer (`arbiterHref`; null = it would not, so each chip is plain text, never a link into a 404).
// The control's own copy and presses are the column's tests (arbiter/__tests__/round-column.test.tsx).
import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { StagesPanel } from "@/components/v2/stages-panel";
import { routes } from "@/lib/routes";
import type { RunSheetOnlinePlay } from "@/lib/run-sheet-groups";

vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn(), push: vi.fn() }) }));
vi.mock("@/components/ui/confirm-provider", () => ({ useConfirm: () => vi.fn(async () => false) }));
vi.mock("@/components/ui/tip", () => ({ TipCallout: ({ id }: { id: string }) => <div data-tip={id} /> }));

const stage = (id: string, seq: number) => ({ id, seq, kind: "swiss", name: `Stage ${seq}`, config: {}, progression: null, status: "active" });
const fixture = (stageId: string, no: number) => ({
  id: `f${no}`, stage_id: stageId, pool_id: null, round_no: 1, seq_in_round: no, fixture_no: no,
  home_entrant_id: "e1", away_entrant_id: "e2", scheduled_at: null, venue: null, court_label: null,
  court_id: null, court_name: null, status: "scheduled", outcome: null,
});
const PROPS = {
  divisionId: "d1", competitionId: "c1", orgSlug: "org", compSlug: "comp", divSlug: "div",
  stages: [stage("s1", 1), stage("s2", 2)], fixtures: [fixture("s1", 1), fixture("s2", 2)],
  entrantNames: { e1: "Alpha", e2: "Bravo" }, canEdit: true, tz: "UTC", orgTz: "UTC", canExport: false,
  viewerPlan: "community" as const, sportKey: "boardgame",
};
const ONLINE: RunSheetOnlinePlay = {
  cameraPolicy: "off", cameraFlagCount: 0, connectionProblemCount: 1, offSeaznFlagCount: 1, held: null, live: false, unopened: false,
};
const CHIPS = ["run-sheet-connection-chip", "run-sheet-off-seazn-chip"] as const;
/** The opening tag of the element carrying this testid. */
const tagOf = (h: string, testId: string) => h.match(new RegExp(`<[a-z]+[^>]*data-testid="${testId}"[^>]*>`))?.[0] ?? null;

describe("the stage cards after the round moved to the Arbiter Panel", () => {
  it("the cards render and carry no Open round control", () => {
    const h = renderToStaticMarkup(<StagesPanel {...PROPS} />);
    expect(h).toContain('data-testid="stage-progress"');
    expect(h).not.toContain('data-testid="open-round"');
  });

  it("a caller still handing the old rounds map gets no control either (nothing reads it)", () => {
    const legacy = { openRounds: { s1: [{ stageId: "s1", roundNo: 1 }] } };
    const h = renderToStaticMarkup(<StagesPanel {...PROPS} {...legacy} />);
    expect(h).toContain('data-testid="stage-progress"');
    expect(h).not.toContain('data-testid="open-round"');
  });
});

describe("the run sheet's online chips lead to the panel only when the page says it would answer", () => {
  const onlinePlay = { f1: ONLINE };

  it("offered (`arbiterHref` set): each chip is a link to the panel pinned to ITS board", () => {
    const h = renderToStaticMarkup(<StagesPanel {...PROPS} onlinePlay={onlinePlay} arbiterHref={routes.divisionArbiter("org", "comp", "div")} />);
    let checked = 0;
    for (const id of CHIPS) {
      const tag = tagOf(h, id);
      expect(tag, `${id} renders`).not.toBeNull();
      expect(tag, `${id} is a link`).toMatch(/^<a /);
      expect(tag, `${id} leads to its own board in the panel`).toContain(`href="${routes.divisionArbiter("org", "comp", "div", "f1")}"`);
      checked++;
    }
    expect(checked, "anti-vacuity: both chips checked").toBe(CHIPS.length);
  });

  it("not offered (`arbiterHref` null, the default): the same chips are plain text, no href anywhere on them", () => {
    for (const props of [{ arbiterHref: null }, {}]) {
      const h = renderToStaticMarkup(<StagesPanel {...PROPS} onlinePlay={onlinePlay} {...props} />);
      let checked = 0;
      for (const id of CHIPS) {
        const tag = tagOf(h, id);
        expect(tag, `${id} renders`).not.toBeNull();
        expect(tag, `${id} is a span`).toMatch(/^<span /);
        expect(tag, `${id} links nowhere`).not.toContain("href");
        checked++;
      }
      expect(checked).toBe(CHIPS.length);
    }
  });
});
