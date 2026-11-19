import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { StagesPanel } from "@/components/v2/stages-panel";
import { tableCutDriftStageIds, type TableCutDrift } from "@/lib/table-cut-drift";
import en from "@/dictionaries/en/ui.json";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: vi.fn(), push: vi.fn() }),
}));
vi.mock("@/components/ui/confirm-provider", () => ({
  useConfirm: () => vi.fn(async () => false),
}));

// W5 T11 (X-CUT-4 <- RB5-K6) — "after the knockout starts, the bracket stands and the desk warns". An amber notice in the
// COMPLETED league's card, by DISPLAY NAME. `apps/web` vitest is `environment: "node"`: these see MARKUP, not layout (the
// 320/768/1280 bar is settled in a browser). The usecase's own cases: table-source-correction.test.ts.

const LONG = "Alexandria Montgomery-Featherstonehaugh III"; // 43 characters: a realistic long name
const names: Record<string, string> = { e1: "Ana Ruiz", e2: "Bo Chen", e3: LONG, e4: "Di Eze" };
const DRIFT: TableCutDrift = { out: ["e3"], in: ["e4"] };

const stage = (id: string, seq: number, status: string) => ({ id, seq, kind: seq === 1 ? "league" : "knockout", name: seq === 1 ? "League" : "Main draw", config: {}, progression: null, status });
/** A decided final, so the completed card has a match to fold. */
const played = (stageId: string) => [
  {
    id: `${stageId}-1`,
    stage_id: stageId,
    pool_id: null,
    round_no: 1,
    seq_in_round: 1,
    fixture_no: 1,
    home_entrant_id: "e1",
    away_entrant_id: "e2",
    scheduled_at: null,
    venue: null,
    court_label: null,
    court_id: null,
    court_name: null,
    status: "decided",
    outcome: { kind: "win", winner: "e1" },
  },
];

const props = {
  divisionId: "d1",
  competitionId: "c1",
  orgSlug: "org",
  compSlug: "comp",
  divSlug: "div",
  tz: "UTC",
  orgTz: "UTC",
  canExport: false,
  viewerPlan: "community" as const,
  entrantNames: names,
  activeEntrantIds: Object.keys(names),
  stages: [stage("k1", 1, "complete"), stage("k2", 2, "active")],
  fixtures: played("k1"),
};

const WARNING = /<div[^>]*data-testid="table-cut-drift-warning"[^>]*>([\s\S]*?)<\/div>/;
function warningOf(html: string): { text: string; tag: string } | null {
  const m = WARNING.exec(html);
  if (!m) return null;
  return { text: m[1]!.replace(/<[^>]*>/g, "").replace(/&#x27;/g, "'").replace(/&amp;/g, "&"), tag: m[0].slice(0, m[0].indexOf(">") + 1) };
}

/** What the division page does: the attention list from the same stages, editability and map it hands the panel. */
const render = (canEdit: boolean, drift: Record<string, TableCutDrift> | undefined) =>
  renderToStaticMarkup(
    <StagesPanel {...props} canEdit={canEdit} tableCutDrift={drift} attentionStageIds={tableCutDriftStageIds(props.stages, canEdit, drift)} />,
  );

const hiddenBody = (html: string, stageId: string) => {
  const tag = new RegExp(`<div[^>]*\\sid="stage-body-${stageId}"[^>]*>`).exec(html)?.[0];
  expect(tag, `premise: the card ${stageId} has a body`).toBeTruthy();
  return /\shidden(=""|\s|>)/.test(tag!);
};

describe("StagesPanel — the table cut drift warning (X-CUT-4)", () => {
  it("no warning when there is no drift: nothing supplied, nothing for this stage, or a viewer who cannot edit", () => {
    expect(warningOf(render(true, undefined)), "no prop").toBeNull();
    expect(warningOf(render(true, {})), "empty").toBeNull();
    expect(warningOf(render(true, { other: DRIFT })), "another stage's").toBeNull();
    expect(warningOf(render(false, { k1: DRIFT })), "a viewer").toBeNull();
  });

  it("the desk shows the amber notice in the dictionary's words, with both names and never an id", () => {
    const warning = warningOf(render(true, { k1: DRIFT }));
    expect(warning, "the warning renders").not.toBeNull();
    const words = en["table.cutDrift.warning.one"];
    expect(words, "premise: the dictionary has the sentence").toBeTruthy();
    expect(warning!.text).toBe(words.replace("{in}", "Di Eze").replace("{out}", LONG));
    expect(warning!.tag).toContain("border-amber-200");
    expect(warning!.tag).toContain("bg-amber-50");
    expect(warning!.tag).toContain('role="status"');
    expect(warning!.text).not.toMatch(/\be[1-4]\b/);
  });

  it("several moving at once are joined with the locale's conjunction, in the plural's words", () => {
    const warning = warningOf(render(true, { k1: { out: ["e2", "e3"], in: ["e4", "e1"] } }));
    expect(warning!.text).toBe(en["table.cutDrift.warning.other"].replace("{in}", "Di Eze and Ana Ruiz").replace("{out}", `Bo Chen and ${LONG}`));
  });

  it("a completed league that carries it starts open; the same card without it starts folded (PB1's attention seam)", () => {
    const withDrift = render(true, { k1: DRIFT });
    expect(hiddenBody(withDrift, "k1"), "the body is shown").toBe(false);
    expect(withDrift.indexOf('data-testid="table-cut-drift-warning"'), "inside the card's body").toBeGreaterThan(withDrift.indexOf('id="stage-body-k1"'));
    const without = render(true, undefined);
    expect(hiddenBody(without, "k1"), "folded").toBe(true);
    expect(without).toContain('data-testid="stage-collapsed-summary"');
  });
});
