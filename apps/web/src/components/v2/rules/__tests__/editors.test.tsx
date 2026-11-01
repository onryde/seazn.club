// Match Day C2 (spec 2026-10-31 §12 Phase C item 10) — the ONE Match format, Points and Tie-breaks component, each in every scope
// it is mounted in (division: the builder and the Division rules strip; stage: the stage card; fixture: the match pages) and in
// both modes. Static markup (node env, no DOM — AGENTS.md class 2): "is the control on the screen, in this mode". Clicking and
// saving are the e2e's; the division order reaching a stage on "Use the division's order" is the DB test beside this one
// (`division-tiebreaks-seam.db.test.ts`), through the real use cases.
//
// Every sweep runs the sport registry (`builtinModules`) and counts what it checked; zero checked is a failure. Expected values
// come from the engine's declarations (`ruleKeys` through `rulesFor`, `defaultTiebreakers`, `configSchema`) and the en dictionary.
import { renderToStaticMarkup } from "react-dom/server";
import type { ReactElement } from "react";
import { describe, expect, it, vi } from "vitest";
import { builtinModules } from "@seazn/engine/sports";
import type { AnySportModule, TableStageKind } from "@seazn/engine/sport";
import { DictProvider } from "@/components/i18n/dict-provider";
import enUi from "@/dictionaries/en/ui.json";
import enPublic from "@/dictionaries/en/public.json";
import type { Dict } from "@/lib/i18n-constants";
import { rulesFor } from "@/lib/match-rules";
import { rulesLineDict } from "@/lib/rules-line";
import { foldTiebreaks, unitLabelKey } from "@/lib/stage-card/summaries";
import { MatchFormatEditor } from "../match-format-editor";
import { PointsEditor, divisionPointsKeys, divisionPointsOf, hydrateDivisionPoints } from "../points-editor";
import { TiebreaksEditor, divisionSportOrder } from "../tiebreaks-editor";
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
const has = (h: string, testId: string): boolean => h.includes(`data-testid="${testId}"`);
const text = (h: string): string => h.replace(/<[^>]+>/g, " ").replace(/&#x27;/g, "'").replace(/&amp;/g, "&").replace(/\s+/g, " ");
/** Every form control in the markup, and how many of them a person could use. */
function controls(h: string): { all: number; enabled: number } {
  const tags = [...h.matchAll(/<(input|select|textarea)\b[^>]*>/g)].map((m) => m[0]);
  return { all: tags.length, enabled: tags.filter((t) => !/\sdisabled=""/.test(t)).length };
}
/** Locked means read-only: no input, no select, no textarea, no button. */
const writable = (h: string): boolean => /<(input|select|textarea|button)\b/.test(h);

/** The cfg a division of this sport plays (its defaults, else its first variant). */
const divisionCfg = (m: AnySportModule): Record<string, unknown> => cfgOf(m) as Record<string, unknown>;

describe("Match format — every scope × mode, every sport", () => {
  it("division, edit: the grid of the sport's own fields (one control per field the engine declares); locked: chips, no control", () => {
    let withFields = 0;
    let checked = 0;
    for (const m of SPORTS) {
      const cfg = divisionCfg(m);
      const edit = html(<MatchFormatEditor scope="division" mode="edit" sportKey={m.key} module={m} values={{}} onChange={() => undefined} inherited={cfg} ruleDict={RULE_DICT} />);
      const locked = html(<MatchFormatEditor scope="division" mode="locked" sportKey={m.key} module={m} values={{}} onChange={() => undefined} inherited={cfg} ruleDict={RULE_DICT} />);
      if (rulesFor(m.key).length > 0) {
        expect(controls(edit).enabled, `${m.key}: the fields are editable`).toBeGreaterThan(0);
        withFields++;
      }
      expect(writable(locked), `${m.key}: locked has no control`).toBe(false);
      expect(has(locked, "match-format-readonly"), `${m.key}: locked is the read-only view`).toBe(true);
      checked++;
    }
    expect(checked, "sports swept").toBe(SPORTS.length);
    expect(withFields, "sports with a rule field").toBeGreaterThan(0);
  });

  it("stage, edit: the stage's field sections; locked: chips, no control, and the ONE lock line only once the stage has started", () => {
    let checked = 0;
    for (const m of SPORTS) {
      const cfg = divisionCfg(m);
      const common = { sportKey: m.key, module: m, kind: "league" as const, variant: null, values: {}, onChange: () => undefined, divisionConfig: cfg, resolved: cfg, ruleDict: RULE_DICT };
      const edit = html(<MatchFormatEditor scope="stage" mode="edit" started={false} {...common} />);
      const started = html(<MatchFormatEditor scope="stage" mode="locked" started {...common} />);
      const viewer = html(<MatchFormatEditor scope="stage" mode="locked" started={false} {...common} />);
      expect(writable(started) || writable(viewer), `${m.key}: locked has no control`).toBe(false);
      expect(has(started, "stage-format-locked"), `${m.key}: a started stage says it`).toBe(true);
      expect(text(started), `${m.key}: in organiser words`).toContain(UI["stageCard.locked"]!);
      expect(has(viewer, "stage-format-locked"), `${m.key}: a viewer of an open stage is told nothing is locked`).toBe(false);
      // The edit grid draws the stage fields the engine declares for a league; a sport with none draws none.
      if (edit.includes('data-testid="stage-rules-section-')) expect(controls(edit).enabled, `${m.key}: stage fields editable`).toBeGreaterThan(0);
      checked++;
    }
    expect(checked, "sports swept").toBe(SPORTS.length);
  });

  it("fixture, locked: the match's own line as a chip, no control; an empty line says nothing", () => {
    const line = "Best of 3 games to 21";
    const h = html(<MatchFormatEditor scope="fixture" mode="locked" line={line} />);
    expect(text(h)).toContain(line);
    expect(writable(h)).toBe(false);
    expect(has(html(<MatchFormatEditor scope="fixture" mode="locked" line="" />), "match-format-chips"), "the empty case").toBe(false);
  });
});

describe("Points — every scope × mode, every sport", () => {
  it("stage, edit: the editor's controls; locked: what the stage pays, no control, the lock line only when started", () => {
    let edited = 0;
    let checked = 0;
    for (const m of SPORTS) {
      const cfg = divisionCfg(m);
      const props = { stageId: ID, module: m, kind: "league", stageConfig: {}, divisionConfig: cfg, stored: null, pointsDict: undefined, onSaved: () => undefined };
      const edit = html(<PointsEditor scope="stage" mode="edit" started={false} {...props} />);
      const started = html(<PointsEditor scope="stage" mode="locked" started {...props} />);
      const viewer = html(<PointsEditor scope="stage" mode="locked" started={false} {...props} />);
      expect(writable(started), `${m.key}: started has no control`).toBe(false);
      expect(writable(viewer), `${m.key}: a viewer has no control`).toBe(false);
      expect(has(started, "stage-points-locked"), `${m.key}: the lock line`).toBe(true);
      expect(has(viewer, "stage-points-locked"), `${m.key}: no lock line before the start`).toBe(false);
      // Item 4: "Changes to the division's points don't reach it" is internals, never said.
      expect(text(started), `${m.key}: no internals`).not.toContain("don't reach it");
      if (edit.includes('data-stage-points-state="editor"')) {
        expect(controls(edit).enabled, `${m.key}: the editor has controls`).toBeGreaterThan(0);
        edited++;
      }
      checked++;
    }
    expect(checked, "sports swept").toBe(SPORTS.length);
    expect(edited, "sports with a points editor").toBeGreaterThan(0);
  });

  it("division, edit: one box per win / draw / loss the config's OWN points keep; locked: no box", () => {
    let boxed = 0;
    let checked = 0;
    for (const m of SPORTS) {
      const cfg = divisionCfg(m);
      const keys = divisionPointsKeys(m.key, divisionPointsOf(m, cfg));
      const value = hydrateDivisionPoints(m.key, divisionPointsOf(m, cfg));
      const props = { module: m, divisionConfig: cfg, value, onChange: () => undefined, kinds: ["league"] as TableStageKind[] };
      const edit = html(<PointsEditor scope="division" mode="edit" {...props} />);
      const locked = html(<PointsEditor scope="division" mode="locked" {...props} />);
      for (const key of keys) expect(has(edit, `division-points-${key}`), `${m.key}: the ${key} box`).toBe(true);
      expect(controls(edit).all, `${m.key}: exactly the config's boxes`).toBe(keys.length);
      expect(writable(locked), `${m.key}: locked has no box`).toBe(false);
      if (keys.length > 0) boxed++;
      checked++;
    }
    expect(checked, "sports swept").toBe(SPORTS.length);
    expect(boxed, "sports whose config keeps a win / loss").toBeGreaterThan(0);
  });

  it("a set table that pays every score the same is said once — 'Win 2 · Loss 0' — never per score (item 5)", () => {
    const badminton = SPORTS.find((m) => m.key === "badminton")!; // single-sport: badminton is the set-table sport the owner's screenshot shows
    const cfg = divisionCfg(badminton);
    const rule = badminton.tablePointsRule(badminton.configSchema.parse(cfg), "league");
    const pair = rule.bySetScore!["*"]!;
    const h = html(<PointsEditor scope="stage" mode="locked" started stageId={ID} module={badminton} kind="league" stageConfig={{}} divisionConfig={cfg} stored={null} pointsDict={undefined} onSaved={() => undefined} />);
    expect(text(h)).toContain(UI["stageCard.points.uniform"]!.replace("{w}", String(pair[0])).replace("{l}", String(pair[1])));
    expect(h).not.toContain('data-testid="stage-points-row-set-');
  });
});

describe("Tie-breaks — every scope × mode, every sport", () => {
  it("stage, edit: move / remove / add controls; locked: the folded order (real criteria numbered, in the sport's unit), no control", () => {
    let checked = 0;
    for (const m of SPORTS) {
      const kind: TableStageKind = "league";
      const rules = tableRulesOf(m, kind);
      const stage = { id: ID, kind, pooled: false, bestNth: false, tableRules: rules };
      const props = { stage, module: m, divisionConfig: divisionCfg(m), stageConfig: {}, onSaved: () => undefined };
      const edit = html(<TiebreaksEditor scope="stage" mode="edit" started={false} {...props} />);
      const locked = html(<TiebreaksEditor scope="stage" mode="locked" started {...props} />);
      // The phone fold's own show/hide button is the only button a locked order keeps: nothing that edits.
      expect(/<(input|select|textarea)\b/.test(locked), `${m.key}: locked has no field`).toBe(false);
      expect(/data-testid="stage-tiebreaks-(up|down|remove|add|reset|save|clear)/.test(locked), `${m.key}: locked has no edit control`).toBe(false);
      expect(has(locked, "stage-tiebreaks-locked"), `${m.key}: the lock line`).toBe(true);
      const { steps, twoWayH2h } = foldTiebreaks(rules.tiebreakers.keys);
      for (const [i, key] of steps.entries()) {
        expect(locked, `${m.key}: step ${i + 1}`).toContain(`data-testid="stage-tiebreaks-row-${i}" data-key="${key}"`);
        expect(text(locked), `${m.key}: ${key} in the sport's unit`).toContain(UI[unitLabelKey(key, m.key)]!);
      }
      expect(has(locked, "stage-tiebreaks-h2h"), `${m.key}: the two-way h2h said once iff folded`).toBe(twoWayH2h);
      expect(has(locked, "stage-tiebreaks-badge"), `${m.key}: no source chip on a locked order`).toBe(false);
      expect(text(locked), `${m.key}: no internals`).not.toContain(UI["stageTiebreaks.source.migrated"]!);
      expect(/<(select|button)\b/.test(edit), `${m.key}: the editor has controls`).toBe(true);
      checked++;
    }
    expect(checked, "sports swept").toBe(SPORTS.length);
  });

  it("division, edit: the sport's own order, editable, while the division keeps none; locked: read-only", () => {
    let checked = 0;
    for (const m of SPORTS) {
      const cfg = divisionCfg(m);
      const kinds: TableStageKind[] = ["league"];
      const own = divisionSportOrder(m, cfg, kinds);
      expect(own, `${m.key}: the sport declares an order`).not.toBeNull();
      expect(own).toEqual(m.defaultTiebreakers("league", m.configSchema.parse(cfg)));
      const props = { module: m, value: null, onChange: () => undefined, divisionConfig: cfg, kinds };
      const edit = html(<TiebreaksEditor scope="division" mode="edit" {...props} />);
      const locked = html(<TiebreaksEditor scope="division" mode="locked" {...props} />);
      expect(edit, `${m.key}: following the sport`).toContain('data-source="sport"');
      expect(/<(select|button)\b/.test(edit), `${m.key}: editable`).toBe(true);
      expect(/<(input|select|textarea)\b/.test(locked), `${m.key}: locked has no control`).toBe(false);
      for (const [i, key] of foldTiebreaks(own!).steps.entries()) expect(locked, `${m.key}: step ${i + 1}`).toContain(`data-key="${key}"`);
      checked++;
    }
    expect(checked, "sports swept").toBe(SPORTS.length);
  });

  it("division, the strip's Save: offered only while the order differs from what is stored (second call: equal ⇒ none)", () => {
    const football = SPORTS.find((m) => m.key === "football")!; // single-sport: the dirty check is sport-blind
    const cfg = divisionCfg(football);
    const order = divisionSportOrder(football, cfg, ["league"])!;
    const reordered = [order[0]!, ...order.slice(1, -1).reverse(), order[order.length - 1]!];
    const base = { module: football, onChange: () => undefined, divisionConfig: cfg, kinds: ["league"] as TableStageKind[], onSave: () => undefined };
    expect(has(html(<TiebreaksEditor scope="division" mode="edit" value={reordered} stored={null} {...base} />), "division-tiebreaks-save")).toBe(true);
    expect(has(html(<TiebreaksEditor scope="division" mode="edit" value={reordered} stored={reordered} {...base} />), "division-tiebreaks-save")).toBe(false);
    expect(has(html(<TiebreaksEditor scope="division" mode="edit" value={null} stored={null} {...base} />), "division-tiebreaks-save")).toBe(false);
  });

  it("Points and Tie-breaks refuse scope 'fixture' at the type level (a match has no table)", () => {
    // @ts-expect-error — PointsEditorProps has no fixture scope
    const p = <PointsEditor scope="fixture" mode="locked" />;
    // @ts-expect-error — TiebreaksEditorProps has no fixture scope
    const t = <TiebreaksEditor scope="fixture" mode="locked" />;
    expect(p.props.scope).toBe("fixture");
    expect(t.props.scope).toBe("fixture");
  });
});

describe("the Division rules strip", () => {
  const strip = (m: AnySportModule, canEdit: boolean, tableKinds: TableStageKind[]) =>
    html(
      <DivisionRulesStrip
        divisionId={ID}
        sportKey={m.key}
        variantKey={Object.keys(m.variants)[0] ?? null}
        divisionConfig={divisionCfg(m)}
        divisionTiebreakers={null}
        tableKinds={tableKinds}
        canEdit={canEdit}
        ruleDict={RULE_DICT}
        variants={Object.entries(m.variants).map(([key, config]) => ({ key, name: key, system: true, config: config as Record<string, unknown> }))}
        lockedFields={[]}
        onlineChessOffered={false}
        initialOpen={["format", "points", "tiebreaks"]}
      />,
    );

  it("three toggles (Points and Tie-breaks only with a table stage), the panels inline; a reader gets every panel read-only", () => {
    let checked = 0;
    for (const m of SPORTS) {
      const editor = strip(m, true, ["league"]);
      for (const p of ["format", "points", "tiebreaks"]) {
        expect(has(editor, `division-rules-toggle-${p}`), `${m.key}: the ${p} toggle`).toBe(true);
        expect(has(editor, `division-rules-panel-${p}`), `${m.key}: the ${p} panel`).toBe(true);
      }
      expect(editor, `${m.key}: an open toggle says so`).toContain('aria-expanded="true"');
      const reader = strip(m, false, ["league"]);
      expect(/<(input|select|textarea)\b/.test(reader), `${m.key}: a reader has no field`).toBe(false);
      expect(has(reader, "division-rules-format-save") || has(reader, "division-points-save") || has(reader, "division-tiebreaks-save"), `${m.key}: and no Save`).toBe(false);
      const bracketOnly = strip(m, true, []);
      expect(has(bracketOnly, "division-rules-toggle-points") || has(bracketOnly, "division-rules-toggle-tiebreaks"), `${m.key}: no table, no Points / Tie-breaks`).toBe(false);
      expect(has(bracketOnly, "division-rules-toggle-format"), `${m.key}: the format is always there`).toBe(true);
      checked++;
    }
    expect(checked, "sports swept").toBe(SPORTS.length);
  });

  it("closed by default: the toggles and the summary, no panel", () => {
    const m = SPORTS.find((s) => s.key === "badminton")!; // single-sport: open/closed is sport-blind
    const h = html(
      <DivisionRulesStrip
        divisionId={ID}
        sportKey={m.key}
        variantKey={null}
        divisionConfig={divisionCfg(m)}
        divisionTiebreakers={null}
        tableKinds={["league"]}
        canEdit
        ruleDict={RULE_DICT}
        variants={[]}
        lockedFields={[]}
        onlineChessOffered={false}
      />,
    );
    expect(h).toContain('aria-expanded="false"');
    expect(h).not.toContain('aria-expanded="true"');
    expect(has(h, "division-rules-panel-format")).toBe(false);
    expect(has(h, "division-rules-summary")).toBe(true);
  });
});
