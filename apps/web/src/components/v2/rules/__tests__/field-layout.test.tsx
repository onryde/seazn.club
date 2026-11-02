// Match Day E1 item 4 (owner 2026-11-01: the Variant label and select "look messy") - how the rules editors lay a field out. One
// rule for every field in the Match rules, Points and Tie-breaks panels:
//   - the label sits ABOVE its control (the `.label` style the grid's own fields already wear), never beside it - the Variant row
//     used to flip between "label left of the select" at 1280 and "label above" at 320, because a `w-full` select capped at 24rem left
//     room for the label's text on its line;
//   - a select is full width below `md` and capped at 20rem (`md:max-w-xs`) from `md` up, so a three-letter choice is not a 700px bar;
//   - under the Variant select, ONE line says what the variant plays, worded by the public rules line's own describer
//     (`describeMatchRules`) from the variant's declared preset - never a typed table of variant meanings.
//
// Static markup (node env, no DOM - AGENTS.md class 2): classes, order and words. The painted geometry (label above, 320px cap, full
// width on a phone) is `mobile.spec.ts`'s "rules strip field layout" test. Every sweep runs the sport registry and counts what it
// checked; zero checked is a failure. Expected numbers come from the engine's own declared variants (`module.variants`).
import { renderToStaticMarkup } from "react-dom/server";
import type { ReactElement } from "react";
import { describe, expect, it, vi } from "vitest";
import { builtinModules } from "@seazn/engine/sports";
import type { AnySportModule, TableStageKind } from "@seazn/engine/sport";
import { DictProvider } from "@/components/i18n/dict-provider";
import enUi from "@/dictionaries/en/ui.json";
import enPublic from "@/dictionaries/en/public.json";
import type { Dict } from "@/lib/i18n-constants";
import { rulesLineDict, rulesLineText } from "@/lib/rules-line";
import { describeMatchRules } from "@/server/public-site/describe-rules";
import { TiebreaksEditor } from "../tiebreaks-editor";
import { PointsEditor, divisionPointsKeys, divisionPointsOf, hydrateDivisionPoints } from "../points-editor";
import { MatchFormatEditor } from "../match-format-editor";
import { DivisionRulesStrip } from "../division-rules-strip";
import { cfgOf, tableRulesOf } from "../../stage-rules/__tests__/_table-rules-fixture";

vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: () => undefined, replace: () => undefined, push: () => undefined }) }));

const UI = enUi as Record<string, string>;
const RULE_DICT = rulesLineDict(enPublic as Dict);
const ID = "33333333-3333-4333-8333-333333333333";
const SPORTS: readonly AnySportModule[] = builtinModules;

const html = (el: ReactElement): string =>
  renderToStaticMarkup(
    <DictProvider dict={enUi as Dict} locale="en">
      {el}
    </DictProvider>,
  );
const text = (h: string): string => h.replace(/<[^>]+>/g, " ").replace(/&#x27;/g, "'").replace(/&amp;/g, "&").replace(/\s+/g, " ").trim();
/** Every open tag of this element in the markup. */
const tagsOf = (h: string, name: string): string[] => [...h.matchAll(new RegExp(`<${name}\\b[^>]*>`, "g"))].map((m) => m[0]);
const classesOf = (tag: string): string[] => (/\sclass="([^"]*)"/.exec(tag)?.[1] ?? "").split(/\s+/).filter(Boolean);
/** The one open tag carrying this test id (an element's attributes are all inside its own `<...>`). */
const tagWith = (h: string, testId: string): string | undefined => tagsOf(h, "(?:select|input)").find((t) => t.includes(`data-testid="${testId}"`));
const divisionCfg = (m: AnySportModule): Record<string, unknown> => cfgOf(m) as Record<string, unknown>;
const variantsOf = (m: AnySportModule) => Object.entries(m.variants as Record<string, Record<string, unknown>>).map(([key, config]) => ({ key, name: key, system: true, config }));

/** A select's width contract: it is a block, full width, and capped at 20rem from md - and the old 24rem-from-sm cap is gone. */
function expectContentSized(tag: string, what: string): void {
  const c = classesOf(tag);
  expect(c, `${what}: a block select (never inline, so a label cannot sit beside it)`).toContain("block");
  expect(c, `${what}: full width below md`).toContain("w-full");
  expect(c, `${what}: capped at 20rem from md`).toContain("md:max-w-xs");
  expect(c, `${what}: not the old 24rem cap from sm`).not.toContain("sm:max-w-sm");
}

const strip = (m: AnySportModule, over: { variantKey?: string | null; divisionConfig?: Record<string, unknown>; variants?: ReturnType<typeof variantsOf>; ruleDict?: Dict | undefined; onlineChessOffered?: boolean } = {}) =>
  html(
    <DivisionRulesStrip
      divisionId={ID}
      sportKey={m.key}
      variantKey={over.variantKey === undefined ? (Object.keys(m.variants)[0] ?? null) : over.variantKey}
      divisionConfig={over.divisionConfig ?? divisionCfg(m)}
      divisionTiebreakers={null}
      tableKinds={["league"]}
      canEdit
      ruleDict={"ruleDict" in over ? over.ruleDict : RULE_DICT}
      variants={over.variants ?? variantsOf(m)}
      lockedFields={[]}
      onlineChessOffered={over.onlineChessOffered ?? false}
      initialOpen={["format", "points", "tiebreaks"]}
    />,
  );

describe("Variant row: the label is above, the select is content-sized", () => {
  it("every sport that has variants: the label is the .label span directly above a block, full-width, md:max-w-xs select", () => {
    let checked = 0;
    for (const m of SPORTS.filter((s) => Object.keys(s.variants).length > 0)) {
      const h = strip(m);
      const tag = tagWith(h, "division-settings-variant");
      expect(tag, `${m.key}: the Variant select is drawn`).toBeDefined();
      expectContentSized(tag!, `${m.key} variant select`);
      // The label's text is the span above the select, inside the same <label>: one source order, label first.
      expect(h, `${m.key}: the label sits above its select`).toContain(`<label class="block"><span class="label">${UI["divset.variant"]}</span><select`);
      checked++;
    }
    expect(checked, "sports with variants swept").toBeGreaterThan(0);
  });

  it("the Lichess rows: online play and the time control wear the same label-above, content-sized shape", () => {
    const chess = SPORTS.find((s) => s.key === "boardgame")!; // single-sport: online play is the board games' only
    const h = strip(chess, { onlineChessOffered: true, divisionConfig: { ...divisionCfg(chess), onlinePlay: "lichess" } });
    const online = tagWith(h, "division-online-play");
    const clock = tagWith(h, "division-time-control");
    expect(online, "premise: the online-play select is drawn").toBeDefined();
    expect(clock, "premise: the time-control select is drawn").toBeDefined();
    expectContentSized(online!, "online play");
    expectContentSized(clock!, "time control");
    expect(h).toContain(`<span class="label">${UI["divset.onlinePlay.label"]}</span><select`);
    expect(h).toContain(`<span class="label">${UI["divset.timeControl.label"]}</span><select`);
  });
});

describe("The rule grid's selects and labels (every sport)", () => {
  it("division and stage grids: every select is full width below md and capped at 20rem from md; every field's label is the .label span", () => {
    let selects = 0;
    let labelled = 0;
    for (const m of SPORTS) {
      const cfg = divisionCfg(m);
      const division = html(<MatchFormatEditor scope="division" mode="edit" sportKey={m.key} module={m} values={{}} onChange={() => undefined} inherited={cfg} ruleDict={RULE_DICT} />);
      const stage = html(
        <MatchFormatEditor scope="stage" mode="edit" started={false} sportKey={m.key} module={m} kind="league" variant={null} values={{}} onChange={() => undefined} divisionConfig={cfg} resolved={cfg} ruleDict={RULE_DICT} />,
      );
      for (const [where, h] of [["division", division], ["stage", stage]] as const) {
        for (const tag of tagsOf(h, "select")) {
          expect(classesOf(tag), `${m.key} ${where} grid select`).toContain("md:max-w-xs");
          expect(classesOf(tag), `${m.key} ${where} grid select`).toContain("w-full");
          selects++;
        }
        // A field is `<label><span class="label">Name</span><control>`: the label span is always the control's first sibling.
        for (const m2 of h.matchAll(/<label class="block"><span class="label">[^<]+<\/span><(select|input)\b/g)) labelled += m2[1] ? 1 : 0;
      }
    }
    expect(selects, "grid selects swept").toBeGreaterThan(0);
    expect(labelled, "label-above fields swept").toBeGreaterThan(0);
  });
});

describe("The ordered-list field (Lichess tie-break rungs)", () => {
  it("its Add menu is full width below md and 20rem from md, in the division grid and the stage grid", () => {
    const chess = SPORTS.find((m) => m.key === "boardgame")!; // single-sport: the ordered-list field is the board games' (tiebreakRungs)
    const cfg = divisionCfg(chess);
    const division = html(<MatchFormatEditor scope="division" mode="edit" sportKey={chess.key} module={chess} values={{ tiebreakRungs: "rapid" }} onChange={() => undefined} inherited={cfg} ruleDict={RULE_DICT} />);
    const stage = html(
      <MatchFormatEditor scope="stage" mode="edit" started={false} sportKey={chess.key} module={chess} kind="knockout" variant={null} values={{ tiebreakRungs: "rapid" }} onChange={() => undefined} divisionConfig={cfg} resolved={cfg} ruleDict={RULE_DICT} />,
    );
    let checked = 0;
    for (const [where, h] of [["division", division], ["stage", stage]] as const) {
      const add = tagWith(h, "stage-rule-sequence-tiebreakRungs-add");
      expect(add, `${where}: premise: a list with a rung left to add draws the menu`).toBeDefined();
      expect(classesOf(add!), `${where}: the add menu`).toContain("md:max-w-xs");
      expect(classesOf(add!), `${where}: the add menu`).toContain("w-full");
      // A flex-1 menu that may shrink to nothing (`min-w-0`) shares its wrapped row with the Reset menu and was squeezed to 56px at 320
      // (mobile.spec "W2c stage format row": `select 128px content in 56px`): the 10rem floor makes it wrap instead of shrink.
      expect(classesOf(add!), `${where}: the add menu keeps its 10rem floor`).toContain("min-w-[10rem]");
      expect(classesOf(add!), `${where}: the add menu may not shrink to nothing`).not.toContain("min-w-0");
      checked++;
    }
    expect(checked).toBe(2);
  });
});

describe("Points and Tie-breaks panels", () => {
  it("division points: each box's label is the .label span above it", () => {
    let boxes = 0;
    for (const m of SPORTS) {
      const cfg = divisionCfg(m);
      const keys = divisionPointsKeys(m.key, divisionPointsOf(m, cfg));
      const value = hydrateDivisionPoints(m.key, divisionPointsOf(m, cfg));
      const h = html(<PointsEditor scope="division" mode="edit" module={m} divisionConfig={cfg} value={value} onChange={() => undefined} kinds={["league"] as TableStageKind[]} />);
      for (const key of keys) {
        expect(h, `${m.key}: the ${key} box has its label above`).toMatch(new RegExp(`<span class="label">[^<]+</span><input[^>]*data-testid="division-points-${key}"`));
        boxes++;
      }
    }
    expect(boxes, "points boxes swept").toBeGreaterThan(0);
  });

  it("the stage's Add-a-bonus select: full width below md, 20rem from md (it is drawn once the stage keeps its OWN points rule)", () => {
    const football = SPORTS.find((m) => m.key === "football")!; // single-sport: a stored own rule is the only way in, and its shape is the table sports'
    const stored = { win: { regulation: 3 }, draw: 1, loss: { regulation: 0 }, tie: 0, noResult: 0, shootoutAs: "result", unit: "whole", bonuses: [] };
    const h = html(<PointsEditor scope="stage" mode="edit" started={false} stageId={ID} module={football} kind="league" stageConfig={{}} divisionConfig={divisionCfg(football)} stored={stored} pointsDict={undefined} onSaved={() => undefined} />);
    const tag = tagWith(h, "stage-points-bonus-add");
    expect(tag, "premise: the bonus menu is drawn").toBeDefined();
    expect(classesOf(tag!)).toContain("md:max-w-xs");
    expect(classesOf(tag!)).toContain("w-full");
  });

  it("every sport's stage tie-breaks: the Add-a-step select (and the reset menu where more than one preset exists) is full width below md, 20rem from md", () => {
    let added = 0;
    let resetMenus = 0;
    for (const m of SPORTS) {
      const cfg = divisionCfg(m);
      const rules = tableRulesOf(m, "league");
      const stage = { id: ID, kind: "league" as TableStageKind, pooled: false, bestNth: false, tableRules: rules };
      const ties = html(<TiebreaksEditor scope="stage" mode="edit" started={false} stage={stage} module={m} divisionConfig={cfg} stageConfig={{}} onSaved={() => undefined} />);
      const add = tagWith(ties, "stage-tiebreaks-add");
      if (add !== undefined) {
        expect(classesOf(add), `${m.key}: the add-a-step menu`).toContain("md:max-w-xs");
        expect(classesOf(add), `${m.key}: the add-a-step menu`).toContain("w-full");
        expect(classesOf(add), `${m.key}: the add-a-step menu keeps its 10rem floor`).toContain("min-w-[10rem]");
        expect(classesOf(add), `${m.key}: the add-a-step menu may not shrink to nothing`).not.toContain("min-w-0");
        added++;
      }
      const reset = tagWith(ties, "stage-tiebreaks-reset");
      if (reset !== undefined && reset.startsWith("<select")) {
        expect(classesOf(reset), `${m.key}: the reset menu`).toContain("md:max-w-xs");
        resetMenus++;
      }
    }
    expect(added, "sports with an add-a-step menu").toBeGreaterThan(0);
    expect(resetMenus, "sports with a reset menu (more than one preset order)").toBeGreaterThan(0);
  });
});

describe("What the variant plays: one line under the Variant select", () => {
  it("every declared variant of every sport: the line is the public describer's words for that variant's preset, or absent when it has none", () => {
    let swept = 0;
    let said = 0;
    for (const m of SPORTS) {
      for (const v of variantsOf(m)) {
        const h = strip(m, { variantKey: v.key });
        const clauses = describeMatchRules(m.key, m, v.config) ?? [];
        const at = h.indexOf('data-testid="division-variant-meaning"');
        if (clauses.length === 0) {
          expect(at, `${m.key}/${v.key}: nothing to say, so no line`).toBe(-1);
        } else {
          expect(at, `${m.key}/${v.key}: the line is drawn`).toBeGreaterThan(-1);
          const para = h.slice(h.lastIndexOf("<p", at), h.indexOf("</p>", at));
          expect(text(para), `${m.key}/${v.key}: the public line's own words`).toBe(rulesLineText(RULE_DICT, clauses).replace(/\s+/g, " "));
          said++;
        }
        swept++;
      }
    }
    expect(swept, "variants swept").toBeGreaterThan(20);
    expect(said, "variants with a line").toBeGreaterThan(10);
  });

  it("badminton: the line carries the variant's OWN declared numbers - and not the other variant's (the engine's presets, read here)", () => {
    const badminton = SPORTS.find((m) => m.key === "badminton")!; // single-sport: the set-to / cap numbers are the set kernel's; every set sport shares the describer
    const presets = badminton.variants as Record<string, { setTo: number; cap: number }>;
    const bwf = presets.bwf!;
    const short = presets.short!;
    expect([bwf.setTo, bwf.cap], "premise: the two presets disagree on both numbers").not.toEqual([short.setTo, short.cap]);
    const lineOf = (variantKey: string, divisionConfig?: Record<string, unknown>) => {
      const h = strip(badminton, { variantKey, ...(divisionConfig === undefined ? {} : { divisionConfig }) });
      const at = h.indexOf('data-testid="division-variant-meaning"');
      expect(at, `${variantKey}: drawn`).toBeGreaterThan(-1);
      return text(h.slice(h.lastIndexOf("<p", at), h.indexOf("</p>", at)));
    };
    const short1 = lineOf("short");
    expect(short1).toContain(String(short.setTo));
    expect(short1).toContain(String(short.cap));
    expect(short1, "the other variant's target is not said").not.toContain(String(bwf.setTo));
    expect(short1).not.toBe(lineOf("bwf"));
    // THE VARIANT's meaning, not the division's own numbers: a division saved on `short` but overridden to 21 still says what `short` is.
    expect(lineOf("short", { ...divisionCfg(badminton), setTo: bwf.setTo, cap: bwf.cap })).toBe(short1);
  });

  it("the empty cases: a variant with no stored preset, and a page with no public dictionary, say nothing (and the picker is still there)", () => {
    const badminton = SPORTS.find((m) => m.key === "badminton")!; // single-sport: the guards are sport-blind
    const noConfig = strip(badminton, { variantKey: "short", variants: variantsOf(badminton).map((v) => ({ key: v.key, name: v.name, system: v.system })) as unknown as ReturnType<typeof variantsOf> });
    expect(noConfig).not.toContain("division-variant-meaning");
    expect(noConfig).toContain('data-testid="division-settings-variant"');
    const noDict = strip(badminton, { variantKey: "short", ruleDict: undefined });
    expect(noDict).not.toContain("division-variant-meaning");
    expect(noDict).toContain('data-testid="division-settings-variant"');
  });

  it("the line is the select's description (aria-describedby names it), beside the dated BWF note where there is one", () => {
    const badminton = SPORTS.find((m) => m.key === "badminton")!; // single-sport: the dated note exists only for badminton's two BWF variants
    const h = strip(badminton, { variantKey: "bwf" });
    const select = tagWith(h, "division-settings-variant")!;
    const described = /aria-describedby="([^"]*)"/.exec(select)?.[1]?.split(" ") ?? [];
    const meaning = tagsOf(h, "p").find((t) => t.includes('data-testid="division-variant-meaning"'))!;
    const meaningId = /\sid="([^"]*)"/.exec(meaning)?.[1];
    expect(meaningId, "the line has an id").toBeTruthy();
    expect(described, "the select is described by the line").toContain(meaningId);
  });
});
