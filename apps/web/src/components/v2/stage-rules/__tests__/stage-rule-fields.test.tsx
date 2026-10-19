// W2c Task 17 - the stage rule fields are REACHED for every sport: the real `StageRuleFields` component, rendered the way
// the row renders it, shows the engine's stage fields and nothing else, in the sections the engine's decider keys decide,
// each with the source of its value; and the abandon select says, with the engine's own sentence, which option it will not
// take. Static markup (no DOM, no effects): this is the "is the control on the screen" half; clicking is the e2e's.
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { BRACKET_KINDS, type StageKind } from "@seazn/engine/core";
import { deciderKeysFor } from "@seazn/engine/sport";
import { builtinModules } from "@seazn/engine/sports";
import { DictProvider } from "@/components/i18n/dict-provider";
import enUi from "@/dictionaries/en/ui.json";
import type { Dict } from "@/lib/i18n-constants";
import { SPORT_RULES } from "@/lib/match-rules";
import { stageFieldsFor } from "@/lib/rule-scope";
import { StageRuleFields } from "../stage-rule-fields";

const KINDS = ["league", ...BRACKET_KINDS] as StageKind[];
const render = (sportKey: string, kind: StageKind, values: Record<string, string> = {}, divisionConfig: Record<string, unknown> = {}, variant: string | null = null): string => {
  const mod = builtinModules.find((m) => m.key === sportKey)!;
  return renderToStaticMarkup(
    <DictProvider dict={enUi as Dict} locale="en">
      <StageRuleFields sportKey={sportKey} module={mod} kind={kind} variant={variant} values={values} onChange={() => undefined} disabled={false} divisionConfig={divisionConfig} />
    </DictProvider>,
  );
};
const fieldBlocks = (markup: string): string[] => [...markup.matchAll(/data-testid="stage-rule-field-([A-Za-z]+)"/g)].map((m) => m[1]!);

describe("StageRuleFields renders exactly the engine's stage fields, for every sport and stage kind (counted)", () => {
  it("one field block per declared stage field, each carrying a source caption", () => {
    let cells = 0;
    let blocks = 0;
    const problems: string[] = [];
    for (const m of builtinModules)
      for (const kind of KINDS)
        for (const variant of [null, ...Object.keys(m.variants)]) {
          const expected = stageFieldsFor({ module: m, stageKind: kind, variant }).map((f) => f.edits[0]!.split(".")[0]!);
          const markup = render(m.key, kind, {}, {}, variant);
          const got = fieldBlocks(markup);
          cells++;
          blocks += got.length;
          if (JSON.stringify([...got].sort()) !== JSON.stringify([...expected].sort())) problems.push(`${m.key}/${kind}/${variant}: ${got} != ${expected}`);
          // every block says where its value comes from; a blank editor inherits everything
          const sources = [...markup.matchAll(/data-source="(division|stage)"/g)].map((x) => x[1]);
          if (sources.length !== got.length || sources.some((x) => x !== "division")) problems.push(`${m.key}/${kind}/${variant}: sources ${sources}`);
        }
    expect(problems).toEqual([]);
    expect(cells).toBeGreaterThan(builtinModules.length * KINDS.length);
    expect(blocks).toBeGreaterThan(cells); // more than one field per cell on average: the sweep is not trivially empty
  });

  it("a field with a value says 'This stage'; the same field blank says 'Division'", () => {
    const set = render("badminton", "league", { bestOf: "3" });
    expect(set).toMatch(/data-testid="stage-rule-field-bestOf"[^>]*data-source="stage"/);
    expect(set).toContain("This stage");
    const blank = render("badminton", "league", {});
    expect(blank).toMatch(/data-testid="stage-rule-field-bestOf"[^>]*data-source="division"/);
    expect(blank).toContain("Division");
  });

  it("the deciders are a section of their own on every kind the engine declares them for (football: league and knockout alike)", () => {
    // The engine declares football's extra time and shoot-out as stage keys for EVERY kind (`deciderKeysFor`), so the
    // section is offered on a league too, where a level match is a draw and the keys have no effect: recorded as a finding
    // in the Task 17 report, not hidden here on a rule the engine does not state.
    const football = builtinModules.find((m) => m.key === "football")!;
    for (const kind of ["league", "knockout"] as StageKind[]) {
      expect(deciderKeysFor(football, kind, null).length, `premise: ${kind}`).toBeGreaterThan(0);
      expect(render("football", kind)).toContain('data-testid="stage-rules-section-deciders"');
    }
    expect(render("football", "knockout")).toContain('data-testid="stage-rule-field-extraTime"');
    // A sport that declares no decider has no such section.
    const none = builtinModules.filter((m) => deciderKeysFor(m, "knockout", null).length === 0);
    expect(none.length, "premise: some sport declares no decider").toBeGreaterThan(0);
    for (const m of none) expect(render(m.key, "knockout"), m.key).not.toContain('data-testid="stage-rules-section-deciders"');
  });

  it("chess shows the tie-break list on a knockout and not on a league (the engine's stage keys)", () => {
    expect(render("boardgame", "knockout")).toContain('data-testid="stage-rule-sequence-tiebreakRungs"');
    expect(render("boardgame", "league")).not.toContain('data-testid="stage-rule-sequence-tiebreakRungs"');
  });
});

describe("the abandon select names the option it will not take, with the engine's own sentence (owner P-5)", () => {
  it("generic with draws off: 'share' is disabled and the reason is on screen; with draws on there is no reason", () => {
    const offMarkup = render("generic", "league", {}, { allowDraws: false });
    expect(offMarkup).toContain('data-testid="stage-abandon-unavailable-share"');
    expect(offMarkup).toContain("Sharing the points needs draws to be allowed");
    expect(offMarkup).toMatch(/<option value="share" disabled=""/);
    const onMarkup = render("generic", "league", {}, { allowDraws: true });
    expect(onMarkup).not.toContain("stage-abandon-unavailable");
    expect(onMarkup).not.toMatch(/<option value="share" disabled=""/);
    expect(onMarkup).toMatch(/<option value="share"/); // the positive pair: the option is still offered
  });

  it("an edit that switches draws on or off moves the unavailable option with it (the cfg judged is division + the edit)", () => {
    const abandon = SPORT_RULES.generic!.find((f) => f.key === "abandon")!;
    expect(abandon.options!.some((o) => o.value === "share"), "premise: generic offers share").toBe(true);
    const draws = SPORT_RULES.generic!.find((f) => f.edits.includes("allowDraws"));
    if (draws) {
      const enabled = render("generic", "league", { [draws.key]: "on" }, { allowDraws: false });
      expect(enabled).not.toContain("stage-abandon-unavailable-share");
    }
  });
});

describe("the abandon field follows the engine's declarations (carries 'share only on draw kinds' and the carrom flip)", () => {
  it("generic offers the abandon field on a league and not on a knockout (abandonPolicy appliesTo the table kinds)", () => {
    let withField = 0;
    let without = 0;
    for (const kind of KINDS) {
      const has = render("generic", kind).includes('data-testid="stage-rule-field-abandonPolicy"');
      const declared = stageFieldsFor({ module: builtinModules.find((m) => m.key === "generic")!, stageKind: kind, variant: null }).some((f) => f.edits.includes("abandonPolicy"));
      expect(has, `generic/${kind}`).toBe(declared);
      if (has) withField++;
      else without++;
    }
    expect(withField, "a table kind has it").toBeGreaterThan(0);
    expect(without, "a bracket kind does not").toBeGreaterThan(0);
    expect(render("generic", "league")).toContain('data-testid="stage-rule-field-abandonPolicy"');
    expect(render("generic", "knockout")).not.toContain('data-testid="stage-rule-field-abandonPolicy"');
  });

  it("carrom: 'share' is unavailable while the tie board is the extra board, and available once the stage sets 'Drawn game' (the flipped case)", () => {
    const tieBoard = SPORT_RULES.carrom!.find((f) => f.edits.includes("tieBoard"))!;
    const drawn = tieBoard.options!.find((o) => (tieBoard.build(o.value, { [tieBoard.key]: o.value }) as { tieBoard?: string }).tieBoard === "draw");
    expect(drawn, "premise: carrom's tie-board field has a Drawn game option").toBeDefined();
    const extra = tieBoard.options!.find((o) => (tieBoard.build(o.value, { [tieBoard.key]: o.value }) as { tieBoard?: string }).tieBoard === "extra")!;
    const before = render("carrom", "league", { [tieBoard.key]: extra.value });
    expect(before).toMatch(/<option value="share" disabled=""/);
    expect(before).toContain('data-testid="stage-abandon-unavailable-share"');
    const after = render("carrom", "league", { [tieBoard.key]: drawn!.value });
    expect(after).not.toMatch(/<option value="share" disabled=""/);
    expect(after).not.toContain("stage-abandon-unavailable");
    expect(after).toMatch(/<option value="share"/);
  });
});
