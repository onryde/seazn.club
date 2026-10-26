// W2c Task 18 (S3) - the stage points section is MOUNTED on the stage card, and gets what the page hands the panel. Node env,
// no DOM: a static render settles "is it on the card, in which state, with which words" - the wiring a builder test cannot
// see (AGENTS.md class 2). Saving, reloading and the table are the browser's (stage-rules-w2c.spec.ts).
//
// Expected values come from the engine's declarations (`DRAW_KINDS`, the sport's own parsed config) and the dictionaries the
// product renders; every sweep reports its count and zero is a failure. W2d Task 10 (spec §11): the inexpressible state is
// deleted, so a division W2c split opens the editor on the card like any other.
import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { StagesPanel } from "@/components/v2/stages-panel";
import { BRACKET_KINDS, DRAW_KINDS } from "@seazn/engine/core";
import { builtinModules } from "@seazn/engine/sports";
import enPublic from "@/dictionaries/en/public.json";
import type { Dict } from "@/lib/i18n-constants";
import { pointsLine } from "@/lib/points-line";
import { pointsLineDict, rulesLineText } from "@/lib/rules-line";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: vi.fn(), push: vi.fn() }),
}));
vi.mock("@/components/ui/confirm-provider", () => ({
  useConfirm: () => vi.fn(async () => false),
}));

const STAGE_ID = "11111111-1111-4111-8111-111111111111";
const POINTS_DICT = pointsLineDict(enPublic as Dict);

function panel(over: Record<string, unknown> = {}): string {
  return renderToStaticMarkup(
    <StagesPanel
      divisionId="d1"
      competitionId="c1"
      orgSlug="o"
      compSlug="c"
      divSlug="d"
      stages={[{ id: STAGE_ID, seq: 1, kind: "league", name: "League", config: {}, progression: null, status: "active" }]}
      fixtures={[]}
      entrantNames={{}}
      canEdit
      sportKey="football"
      divisionConfig={{ points: { win: 4, draw: 2, loss: 1 } }}
      tz="UTC"
      orgTz="UTC"
      canExport={false}
      viewerPlan={{ plan: "pro", isStaff: false } as never}
      {...over}
    />,
  );
}
const stageOf = (kind: string, config: Record<string, unknown> = {}): Record<string, unknown>[] => [
  { id: STAGE_ID, seq: 1, kind, name: "Stage", config, progression: null, status: "active" },
];
const sectionTag = `data-testid="stage-points-${STAGE_ID}"`;
const stateOf = (html: string): string | null => /data-stage-points-state="([a-z]+)"/.exec(html)?.[1] ?? null;
const text = (html: string): string => html.replace(/<[^>]*>/g, " ").replace(/&#x27;/g, "'").replace(/\s+/g, " ");

describe("the points section is on a TABLE stage's card and on no other", () => {
  it("sweep: every sport, on every table kind and every bracket kind - present iff the engine says the kind has a table", () => {
    let checked = 0;
    let present = 0;
    let absent = 0;
    const kinds = [...DRAW_KINDS, ...BRACKET_KINDS] as string[];
    for (const m of builtinModules)
      for (const kind of kinds) {
        const html = panel({ sportKey: m.key, divisionConfig: {}, stages: stageOf(kind) });
        const expected = (DRAW_KINDS as ReadonlySet<string>).has(kind);
        expect(html.includes(sectionTag), `${m.key}/${kind}`).toBe(expected);
        checked++;
        if (expected) present++;
        else absent++;
      }
    expect(checked, "(sport, kind) cells").toBe(builtinModules.length * kinds.length);
    expect(present, "table cells").toBeGreaterThan(builtinModules.length - 1);
    expect(absent, "bracket cells").toBeGreaterThan(builtinModules.length - 1);
  });

  it("it is a SIBLING of the format row, not inside it (the row's markup and its tests are untouched)", () => {
    const html = panel();
    const rowAt = html.indexOf(`data-testid="stage-format-row-${STAGE_ID}"`);
    const sectionAt = html.indexOf(sectionTag);
    expect(rowAt).toBeGreaterThan(-1);
    expect(sectionAt, "after the format row").toBeGreaterThan(rowAt);
    // The format row's own band (what stages-panel-stage-format.test.tsx slices) carries no points markup.
    const band = html.slice(html.indexOf('data-testid="stage-format"'), html.indexOf("</div>", html.indexOf("</div>", html.indexOf('data-testid="stage-format"')) + 1));
    expect(band).not.toContain("stage-points-");
  });
});

describe("the state the section opens in follows the division (scoring is free on every plan: the panel is handed no plan)", () => {
  it("a division opens the editor, for a viewer of any plan the panel is built for", () => {
    expect(stateOf(panel())).toBe("editor");
    for (const plan of ["community", "pro"]) expect(stateOf(panel({ viewerPlan: { plan, isStaff: false } as never })), plan).toBe("editor");
  });

  it("W2d T10: an ice-hockey division that splits its overtime points (W2c: inexpressible) opens the editor on the card, stored rule or none; a started stage reads it", () => {
    const m = builtinModules.find((x) => x.key === "icehockey")!;
    const split = Object.keys(m.variants).find((v) => {
      const pts = (m.configSchema.parse(m.variants[v]) as { points?: Record<string, unknown> }).points ?? {};
      return "otWin" in pts;
    });
    expect(split, "premise: the engine has an ice-hockey variant paying overtime apart (iihf)").toBeDefined();
    const html = panel({ sportKey: "icehockey", divisionConfig: m.variants[split!] });
    expect(stateOf(html)).toBe("editor");
    expect(html, "no inexpressible card").not.toContain('data-testid="stage-points-inexpressible"');
    expect(html, "the inherit control is there (W2c showed no control here)").toContain('data-testid="stage-points-use-division"');
    const OWN = { win: { regulation: 4 }, draw: 1, loss: { regulation: 0 }, shootoutAs: "result", unit: "whole", bonuses: [] };
    const stored = panel({ sportKey: "icehockey", divisionConfig: m.variants[split!], stages: stageOf("league", { points: OWN }), pointsDict: POINTS_DICT });
    expect(stateOf(stored)).toBe("editor");
    const win = stored.slice(stored.lastIndexOf("<", stored.indexOf('data-testid="stage-points-win"')), stored.indexOf(">", stored.indexOf('data-testid="stage-points-win"')) + 1);
    expect(win, "the stored rule's own win").toContain('value="4"');
    // a started stage reads the same rule and gets no control
    const locked = panel({ sportKey: "icehockey", divisionConfig: m.variants[split!], stages: stageOf("league", { points: OWN }), pointsDict: POINTS_DICT, formatLockedStageIds: [STAGE_ID] });
    expect(stateOf(locked)).toBe("readonly");
    expect(locked).toContain('data-testid="stage-points-readonly"');
    expect(locked).not.toContain('data-testid="stage-points-inexpressible"');
  });
});

describe("what the page hands the panel reaches the section", () => {
  const STORED = { win: { regulation: 3 }, draw: 1, loss: { regulation: 0 }, shootoutAs: "result", unit: "whole", bonuses: [], forfeit: { winnerPoints: 4, loserPoints: 1, awardScore: [3, 0] } };

  it("config.points opens the section on the stage's own rule (the boxes hold its numbers); a stage with none inherits", () => {
    const own = panel({ stages: stageOf("league", { points: STORED }) });
    expect(own).toMatch(/data-testid="stage-points-win"[^>]*value="3"/);
    expect(own).toMatch(/data-testid="stage-points-walkover-w"[^>]*value="4"/);
    const inherited = panel();
    expect(inherited).toMatch(/data-testid="stage-points-use-division"[^>]*checked=""/);
    expect(inherited).not.toContain('data-testid="stage-points-win"');
  });

  it("the points slice of the public dictionary gives the section its preview, in the public line's words; without it, no preview", () => {
    const withWords = panel({ stages: stageOf("league", { points: STORED }), pointsDict: POINTS_DICT });
    expect(text(withWords)).toContain(rulesLineText(POINTS_DICT, pointsLine(STORED as never, { awardReaches: true })));
    expect(panel({ stages: stageOf("league", { points: STORED }) })).not.toContain('data-testid="stage-points-preview"');
  });

  it("a started stage and a viewer read the section and get no control (the SAME lock as the format row)", () => {
    for (const over of [{ formatLockedStageIds: [STAGE_ID] }, { canEdit: false }]) {
      const html = panel({ stages: stageOf("league", { points: STORED }), pointsDict: POINTS_DICT, ...over });
      expect(stateOf(html), JSON.stringify(over)).toBe("readonly");
      const section = html.slice(html.indexOf(sectionTag));
      const own = section.slice(0, section.indexOf("</section>"));
      expect(own, "no control inside the section").not.toMatch(/<(input|select|button)/);
      expect(own).toContain('data-testid="stage-points-readonly"');
    }
    // The positive pair: unlocked and editable has the controls.
    expect(panel({ stages: stageOf("league", { points: STORED }) })).toContain('data-testid="stage-points-save"');
  });
});
