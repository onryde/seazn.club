// W2d Task 15 (spec §9 "Tie-breaks", X-TB-1..3, OC1, OC2, D5) — the Tie-breaks section, REACHED: the real component, rendered
// the way the stage card renders it. Static markup (node env, no DOM — AGENTS.md class 2): "is the control on the screen, in
// this state, with these words"; clicking, saving and the lock after a first score are the e2e's
// (`e2e/stage-tiebreaks-w2d.spec.ts`). Expected values come from the engine's declarations (`resolveTableRules` through
// `_table-rules-fixture.ts`, `offerableKeys`, `tablePresets`, `primaryTableKey`) and the en dictionary the product renders.
// Every sweep counts what it checked, and zero is a failure.
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { builtinModules } from "@seazn/engine/sports";
import { isHeadToHeadKey, offerableKeys, type TableRulesPin } from "@seazn/engine/competition";
import type { AnySportModule, TableStageKind, TiebreakerKey } from "@seazn/engine/sport";
import { DictProvider } from "@/components/i18n/dict-provider";
import enUi from "@/dictionaries/en/ui.json";
import type { Dict } from "@/lib/i18n-constants";
import type { StageTableRules } from "@/server/api-v1/schemas";
import { StageTiebreaksSection } from "../stage-tiebreaks-section";
import { cfgOf, tableRulesOf } from "./_table-rules-fixture";

const sport = (key: string): AnySportModule => builtinModules.find((m) => m.key === key)!;
const UI = enUi as Record<string, string>;
const ID = "22222222-2222-4222-8222-222222222222";
const football = sport("football");
const boardgame = sport("boardgame");
const badminton = sport("badminton");

function render(
  m: AnySportModule,
  kind: TableStageKind,
  tableRules: StageTableRules,
  over: { locked?: boolean; canEdit?: boolean; pooled?: boolean; bestNth?: boolean; divisionConfig?: Record<string, unknown> } = {},
): string {
  return renderToStaticMarkup(
    <DictProvider dict={enUi as Dict} locale="en">
      <StageTiebreaksSection
        stage={{ id: ID, kind, pooled: over.pooled ?? false, bestNth: over.bestNth ?? false, tableRules }}
        stageName="Pool A"
        module={m}
        divisionConfig={over.divisionConfig ?? (cfgOf(m) as Record<string, unknown>)}
        stageConfig={{}}
        formatLockedStageIds={over.locked === true ? [ID] : []}
        canEdit={over.canEdit ?? true}
        onSaved={() => undefined}
      />
    </DictProvider>,
  );
}

const has = (html: string, testId: string): boolean => html.includes(`data-testid="${testId}"`);
function tagOf(html: string, testId: string): string {
  const at = html.indexOf(`data-testid="${testId}"`);
  expect(at, `${testId} is on the page`).toBeGreaterThan(-1);
  return html.slice(html.lastIndexOf("<", at), html.indexOf(">", at) + 1);
}
const text = (html: string): string => html.replace(/<[^>]*>/g, " ").replace(/&#x27;/g, "'").replace(/\s+/g, " ");
/** The `data-key` of every listed row, in order. */
const listed = (html: string): string[] => [...html.matchAll(/data-testid="stage-tiebreaks-row-\d+" data-key="([a-z_0-9]+)"/g)].map((x) => x[1]!);
const options = (html: string, testId: string): string[] =>
  [...html.slice(html.indexOf(`data-testid="${testId}"`)).split("</select>")[0]!.matchAll(/<option value="([a-z_0-9]+)"/g)].map((x) => x[1]!);
const stepWord = (key: string) => UI[`div.detail.tiebreak.rule.${key}`]!;

describe("the list (X-TB-3, D11, OC1)", () => {
  it("football league, inherited from the sport: the order as served, the primary measure 'always first' and lots 'always last' with no arrows; the middle steps move", () => {
    const rules = tableRulesOf(football, "league");
    const html = render(football, "league", rules);
    expect(html).toContain('data-state="editor"');
    expect(listed(html)).toEqual(rules.tiebreakers.keys);
    const last = rules.tiebreakers.keys.length - 1;
    expect(rules.tiebreakers.keys[0], "premise: football's order opens with its primary measure").toBe(football.primaryTableKey);
    expect(rules.tiebreakers.keys[last], "premise: and closes with lots").toBe("lots");
    expect(text(tagOf(html, "stage-tiebreaks-pinned-0") + html.slice(html.indexOf('data-testid="stage-tiebreaks-pinned-0"')))).toContain(UI["stageTiebreaks.alwaysFirst"]!);
    expect(has(html, `stage-tiebreaks-pinned-${last}`)).toBe(true);
    for (const i of [0, last]) expect(has(html, `stage-tiebreaks-up-${i}`) || has(html, `stage-tiebreaks-remove-${i}`), `row ${i} is pinned`).toBe(false);
    let middle = 0;
    for (let i = 1; i < last; i++) {
      expect(has(html, `stage-tiebreaks-up-${i}`) && has(html, `stage-tiebreaks-down-${i}`) && has(html, `stage-tiebreaks-remove-${i}`), `row ${i}`).toBe(true);
      middle++;
    }
    expect(middle, "middle rows checked").toBeGreaterThan(0);
    // The first middle row cannot move past the pinned first; the last middle row cannot move past lots.
    expect(tagOf(html, "stage-tiebreaks-up-1")).toContain("disabled");
    expect(tagOf(html, `stage-tiebreaks-down-${last - 1}`)).toContain("disabled");
  });

  it("a Swiss order keeps its own shape: nothing is pinned (OC1)", () => {
    const rules = tableRulesOf(boardgame, "swiss");
    const html = render(boardgame, "swiss", rules);
    expect(listed(html)).toEqual(rules.tiebreakers.keys);
    expect(html).not.toContain("stage-tiebreaks-pinned-");
    expect(has(html, "stage-tiebreaks-remove-0")).toBe(true);
  });

  it("'+ Add step' offers exactly the engine's offerable keys at the step before lots, each in the dictionary's words (sweep: every sport, league)", () => {
    let checked = 0;
    let offered = 0;
    for (const m of builtinModules) {
      const rules = tableRulesOf(m, "league");
      const html = render(m, "league", rules);
      const keys = rules.tiebreakers.keys;
      const at = keys[keys.length - 1] === "lots" ? keys.length - 1 : keys.length;
      const want = offerableKeys(keys, at, { module: m, cfg: cfgOf(m), stageKind: "league", crossGroup: false });
      if (want.length === 0) expect(has(html, "stage-tiebreaks-add"), m.key).toBe(false);
      else {
        expect(options(html, "stage-tiebreaks-add"), m.key).toEqual([...want]);
        for (const k of want) expect(text(html), `${m.key}: ${k} said`).toContain(stepWord(k));
        offered += want.length;
      }
      checked++;
    }
    expect(checked, "sports").toBe(builtinModules.length);
    expect(offered, "options checked").toBeGreaterThan(0);
  });
});

describe("Reset (PS-7b, D5)", () => {
  it("football: a menu of its named orders, FIFA 2026 / UEFA / Classic (tablePresets)", () => {
    const presets = football.tablePresets!("league").tiebreakers.map((p) => p.id);
    expect(presets.length, "premise: football names its orders").toBeGreaterThan(1);
    const html = render(football, "league", tableRulesOf(football, "league"));
    expect(options(html, "stage-tiebreaks-reset")).toEqual(presets);
    for (const id of presets) expect(text(html)).toContain(UI[`stageTiebreaks.preset.${id}`]!);
  });

  it("a sport with no named order: one 'Reset to sport default' button", () => {
    const html = render(badminton, "league", tableRulesOf(badminton, "league"));
    expect(tagOf(html, "stage-tiebreaks-reset").startsWith("<button")).toBe(true);
    expect(text(html)).toContain(UI["stageTiebreaks.reset"]!);
  });

  it("every named order of every sport has its words in the dictionary (counted)", () => {
    let checked = 0;
    for (const m of builtinModules)
      for (const kind of ["league", "group", "swiss", "americano"] as const)
        for (const p of m.tablePresets?.(kind).tiebreakers ?? []) {
          expect(UI[`stageTiebreaks.preset.${p.id}`], `${m.key}/${kind}: ${p.id}`).toBeTypeOf("string");
          checked++;
        }
    expect(checked, "named orders").toBeGreaterThan(0);
  });
});

describe("the badge (X-TB-1)", () => {
  const DIV: TiebreakerKey[] = ["points", "diff", "for", "lots"];

  it("Inherited from the sport default, from the division; Overridden for the stage's own; Pinned at start with its source", () => {
    const sportRules = render(football, "league", tableRulesOf(football, "league"));
    expect(tagOf(sportRules, "stage-tiebreaks-badge")).toContain('data-badge="inherited"');
    expect(tagOf(sportRules, "stage-tiebreaks-badge")).toContain('data-source="sport"');
    expect(text(sportRules)).toContain(UI["stageTiebreaks.source.sport"]!);
    const division = render(football, "league", tableRulesOf(football, "league", { division: DIV }));
    expect(tagOf(division, "stage-tiebreaks-badge")).toContain('data-source="division"');
    const own = render(football, "league", tableRulesOf(football, "league", { own: DIV }));
    expect(tagOf(own, "stage-tiebreaks-badge")).toContain('data-badge="overridden"');
    const pin: TableRulesPin = {
      tiebreakers: DIV,
      crossGroup: DIV,
      points: tableRulesOf(football, "league").points.rule,
      sources: { tiebreakers: "division", points: "sport", crossGroup: "derived" },
    };
    const pinned = render(football, "league", tableRulesOf(football, "league", { division: DIV, pinned: pin }));
    expect(tagOf(pinned, "stage-tiebreaks-badge")).toContain('data-source="division"');
    expect(tagOf(pinned, "stage-tiebreaks-badge")).toContain('data-badge="pinned"');
    expect(text(pinned)).toContain(UI["stageTiebreaks.badge.pinned"]!);
  });

  it("'Use the division's order' only for a stage with its own", () => {
    expect(has(render(football, "league", tableRulesOf(football, "league", { own: DIV })), "stage-tiebreaks-clear")).toBe(true);
    expect(has(render(football, "league", tableRulesOf(football, "league", { division: DIV })), "stage-tiebreaks-clear")).toBe(false);
  });
});

describe("the lock (X-TB-2, OC2, PF-9)", () => {
  it("pinned but not listed by the server (generated, no score yet): still editable", () => {
    const rules = tableRulesOf(football, "league", { pinnedAt: "2026-10-27T10:00:00.000Z" });
    const html = render(football, "league", rules);
    expect(html).toContain('data-state="editor"');
    expect(has(html, "stage-tiebreaks-locked")).toBe(false);
    expect(has(html, "stage-tiebreaks-add") || has(html, "stage-tiebreaks-reset")).toBe(true);
  });

  it("listed by the server (a first score): the 🔒 line naming the stage, the order still listed, and no control at all", () => {
    const rules = tableRulesOf(football, "league", { pinnedAt: "2026-10-27T10:00:00.000Z" });
    const html = render(football, "league", rules, { locked: true });
    expect(html).toContain('data-state="locked"');
    expect(text(html)).toContain(UI["stageTiebreaks.locked"]!.replace("{stage}", "Pool A"));
    expect(listed(html)).toEqual(rules.tiebreakers.keys);
    expect(html).not.toMatch(/<(select|button)[^>]*data-testid="stage-tiebreaks-/);
  });

  it("a viewer: no control and no lock line", () => {
    const html = render(football, "league", tableRulesOf(football, "league"), { canEdit: false });
    expect(html).toContain('data-state="readonly"');
    expect(has(html, "stage-tiebreaks-locked")).toBe(false);
    expect(html).not.toMatch(/<(select|button)[^>]*data-testid="stage-tiebreaks-/);
  });
});

describe("errors inline (spec §9 Errors)", () => {
  it("an inherited division order the stage refuses: the reason beside the step, in the TIEBREAK_KEY_INVALID words, and the hint to set the stage's own", () => {
    // Buchholz needs a Swiss stage (§5.5 rule 3): a chess division order carrying it is refused on a league stage.
    const rules = tableRulesOf(boardgame, "league", { division: ["points", "buchholz", "lots"] });
    const html = render(boardgame, "league", rules);
    const why = UI["rules.err.tiebreakKeyInvalid"]!.replace("{step}", stepWord("buchholz")).replace("{reason}", UI["rules.err.tiebreak.reason.stage_format"]!);
    expect(text(tagOf(html, "stage-tiebreaks-refusal-1") + html.slice(html.indexOf('data-testid="stage-tiebreaks-refusal-1"')))).toContain(why);
    expect(has(html, "stage-tiebreaks-refusal-0") || has(html, "stage-tiebreaks-refusal-2"), "only the refused step").toBe(false);
    expect(text(html)).toContain(UI["stageTiebreaks.inheritedHint"]!);
    // The positive pair: the sport's own order is taken, no reason, no hint.
    const ok = render(boardgame, "league", tableRulesOf(boardgame, "league"));
    expect(ok).not.toContain("stage-tiebreaks-refusal-");
    expect(has(ok, "stage-tiebreaks-hint")).toBe(false);
  });
});

describe("the cross-group line (§5.9)", () => {
  it("a pooled stage a later stage takes a best-Nth from: 'Between groups: …' with no head-to-head step; otherwise none", () => {
    const rules = tableRulesOf(football, "group");
    const html = render(football, "group", rules, { pooled: true, bestNth: true });
    const line = text(tagOf(html, "stage-tiebreaks-cross-group") + html.slice(html.indexOf('data-testid="stage-tiebreaks-cross-group"')));
    const steps = rules.crossGroup.keys.filter((k) => !isHeadToHeadKey(k));
    expect(steps.length, "premise: football's cross-group order has steps").toBeGreaterThan(0);
    expect(line).toContain(UI["stageTiebreaks.crossGroup"]!.replace("{steps}", steps.map(stepWord).join(", ")));
    expect(has(render(football, "group", rules, { pooled: true, bestNth: false }), "stage-tiebreaks-cross-group")).toBe(false);
    expect(has(render(football, "league", tableRulesOf(football, "league"), { pooled: false, bestNth: true }), "stage-tiebreaks-cross-group")).toBe(false);
  });
});

describe("phone composition (one DOM, branched)", () => {
  it("the heading and badge sit outside the fold; the list is inside a phone disclosure whose toggle is md:hidden", () => {
    const html = render(football, "league", tableRulesOf(football, "league"));
    const badgeAt = html.indexOf('data-testid="stage-tiebreaks-badge"');
    const toggleAt = html.indexOf(UI["stageTiebreaks.show"]!);
    const bodyAt = html.indexOf('data-testid="stage-tiebreaks-body"');
    expect(badgeAt).toBeGreaterThan(-1);
    expect(toggleAt, "the fold's toggle").toBeGreaterThan(badgeAt);
    expect(bodyAt, "the list inside it").toBeGreaterThan(toggleAt);
    // Anchored: `/\bmd:hidden\b/` also matches inside `max-md:hidden` (AGENTS.md).
    expect(html).toMatch(/class="[^"]*\smd:hidden[\s"]/);
  });
});
