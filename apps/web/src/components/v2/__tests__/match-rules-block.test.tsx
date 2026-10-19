// W2c Task 19 (S2, X-SR-2, X-SR-3, X-SR-5) - the "Match rules" block, REACHED: the real component, rendered the way the
// fixture console renders it. Static markup (no DOM, no effects): this is the "is the control on the screen, in this state,
// for this sport, in this language" half; clicking, saving, refusing and reloading are `e2e/match-rules-w2c.spec.ts`'s.
// Expected values come from the engine's declarations (`fixtureKeysFor`, `matchFieldsFor`, the sport's variants) and from
// the dictionaries the product renders - none is typed here. Every sweep reports how many items it checked.
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { StageKind } from "@seazn/engine/core";
import { fixtureKeysFor } from "@seazn/engine/sport";
import { builtinModules } from "@seazn/engine/sports";
import { DictProvider } from "@/components/i18n/dict-provider";
import enUi from "@/dictionaries/en/ui.json";
import esUi from "@/dictionaries/es/ui.json";
import type { Dict } from "@/lib/i18n-constants";
import { moduleFor } from "@/lib/rule-scope";
import { mergeRulesOverride } from "@/server/engine-db/fixture-cfg";
import { MatchRulesBlock, type MatchRulesBlockProps, type MatchRulesState } from "../match-rules-block";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: vi.fn(), push: vi.fn() }),
}));

const EN = enUi as Record<string, string>;
const ES = esUi as Record<string, string>;
const mod = (key: string) => {
  const m = moduleFor(key);
  if (m === null) throw new Error(`no builtin ${key}`);
  return m;
};
const stageCfg = (sport: string, variant: string, stageKind: StageKind | null, extra: Record<string, unknown> = {}): Record<string, unknown> => {
  const m = mod(sport);
  const preset = (stageKind === null ? {} : (m.stageDefaults?.(stageKind, variant) ?? {})) as object;
  return m.configSchema.parse({ ...(m.variants[variant] as object), ...preset, ...extra }) as Record<string, unknown>;
};
const props = (over: Partial<MatchRulesBlockProps> & Pick<MatchRulesBlockProps, "sportKey" | "stageResolved">): MatchRulesBlockProps => ({
  fixtureId: "f1",
  stageKind: "league",
  variant: null,
  stageLine: "Best of 3 to 21",
  effective: over.stageResolved,
  override: null,
  state: "unstarted",
  ...over,
});
const render = (p: MatchRulesBlockProps, dict: Dict = enUi as Dict, locale: "en" | "es" = "en"): string =>
  renderToStaticMarkup(
    <DictProvider dict={dict} locale={locale}>
      <MatchRulesBlock {...p} />
    </DictProvider>,
  );
const has = (html: string, testId: string): boolean => html.includes(`data-testid="${testId}"`);
const fieldIds = (html: string): string[] => [...html.matchAll(/data-testid="stage-rule-field-([A-Za-z]+)"/g)].map((m) => m[1]!);
const text = (html: string): string => html.replace(/<[^>]*>/g, " ").replace(/&#x27;/g, "'").replace(/\s+/g, " ");
/** The `<select>`/`<input>` markup inside one field block. */
function blockOf(html: string, top: string): string {
  const at = html.indexOf(`data-testid="stage-rule-field-${top}"`);
  expect(at, `${top} is on the page`).toBeGreaterThan(-1);
  const next = html.indexOf('data-testid="stage-rule-field-', at + 10);
  return html.slice(at, next === -1 ? undefined : next);
}
const optionValues = (block: string): string[] => [...block.matchAll(/<option value="([^"]*)"/g)].map((m) => m[1]!);

describe("the block in each state (badminton league)", () => {
  const stage = stageCfg("badminton", "short", "league");
  const base = props({ sportKey: "badminton", variant: "short", stageResolved: stage });

  it("unstarted, no override: the block, the stage line, the fields; no chip, no reset, no lock, Save waits for a change", () => {
    const html = render(base);
    expect(has(html, "match-rules-block")).toBe(true);
    expect(html).toContain('data-state="unstarted"');
    expect(text(html)).toContain(EN["matchRules.title"]);
    expect(text(html)).toContain(EN["matchRules.fromStage"]!.replace("{format}", "Best of 3 to 21"));
    const ids = fieldIds(html);
    expect(ids.length, "the match fields are on the page").toBeGreaterThan(0);
    expect(has(html, "match-rules-overridden")).toBe(false);
    expect(has(html, "match-rules-reset")).toBe(false);
    expect(has(html, "match-rules-locked")).toBe(false);
    expect(has(html, "match-rules-error")).toBe(false);
    expect(has(html, "match-rules-warning"), "the 'match so far is kept' warning belongs to a live correction").toBe(false);
    expect(has(html, "match-rules-correct"), "an unstarted match is changed, not corrected").toBe(false);
    expect(html.slice(html.indexOf('data-testid="match-rules-save"') - 80, html.indexOf('data-testid="match-rules-save"') + 200)).toContain("disabled");
  });

  it("every field opens at the stage's value and says it is the stage's", () => {
    const html = render(base);
    for (const id of fieldIds(html)) expect(blockOf(html, id), id).toContain('data-source="stage"');
    // bestOf: the select sits on the stage's best-of (the `selected` option is the stage's, not "Default").
    const bestOf = blockOf(html, "bestOf");
    expect(bestOf).toMatch(new RegExp(`<option value="${stage.bestOf as number}" selected`));
  });

  it("overridden: the chip, the reset, the match's value in the field with the 'this match' caption", () => {
    const override = { bestOf: 1 };
    const effective = mergeRulesOverride(stage, override) as Record<string, unknown>;
    const html = render({ ...base, override, effective });
    expect(has(html, "match-rules-overridden")).toBe(true);
    expect(text(html)).toContain(EN["matchRules.overridden"]);
    expect(has(html, "match-rules-reset")).toBe(true);
    expect(text(html)).toContain(EN["matchRules.reset"]);
    expect(blockOf(html, "bestOf")).toContain('data-source="match"');
    expect(blockOf(html, "bestOf")).toMatch(/<option value="1" selected/);
  });

  it("live: the form stays closed behind 'Correct format' (a deliberate act); no warning, no fields yet", () => {
    const html = render({ ...base, state: "live" });
    expect(html).toContain('data-state="live"');
    expect(has(html, "match-rules-correct")).toBe(true);
    expect(text(html)).toContain(EN["matchRules.correctLive"]);
    expect(fieldIds(html)).toEqual([]);
    expect(has(html, "match-rules-save")).toBe(false);
    expect(has(html, "match-rules-locked")).toBe(false);
  });

  it("live and already overridden: the chip is shown with the closed form, so a correction made earlier is visible", () => {
    const override = { bestOf: 5 };
    const html = render({ ...base, state: "live", override, effective: mergeRulesOverride(stage, override) as Record<string, unknown> });
    expect(has(html, "match-rules-overridden")).toBe(true);
    expect(has(html, "match-rules-correct")).toBe(true);
  });

  it("locked (finished): the lock sentence and NO form, no save, no reset, no correct button - even with an override in force", () => {
    const override = { bestOf: 1 };
    const html = render({ ...base, state: "locked", override, effective: mergeRulesOverride(stage, override) as Record<string, unknown> });
    expect(html).toContain('data-state="locked"');
    expect(has(html, "match-rules-locked")).toBe(true);
    expect(text(html)).toContain(EN["matchRules.locked"]);
    for (const absent of ["match-rules-save", "match-rules-reset", "match-rules-correct", "match-rules-warning"]) expect(has(html, absent), absent).toBe(false);
    expect(fieldIds(html)).toEqual([]);
    expect(html, "no input or select left to change").not.toMatch(/<(select|input)\b/);
    // The override that was in force stays readable.
    expect(has(html, "match-rules-overridden")).toBe(true);
  });

  it("each state exposes exactly its own controls (counted)", () => {
    const states: MatchRulesState[] = ["unstarted", "live", "decided", "locked"];
    const want: Record<MatchRulesState, { fields: boolean; save: boolean; correct: boolean; locked: boolean }> = {
      unstarted: { fields: true, save: true, correct: false, locked: false },
      live: { fields: false, save: false, correct: true, locked: false },
      decided: { fields: false, save: false, correct: false, locked: true },
      locked: { fields: false, save: false, correct: false, locked: true },
    };
    let checked = 0;
    for (const state of states) {
      const html = render({ ...base, state });
      expect(fieldIds(html).length > 0, `${state} fields`).toBe(want[state].fields);
      expect(has(html, "match-rules-save"), `${state} save`).toBe(want[state].save);
      expect(has(html, "match-rules-correct"), `${state} correct`).toBe(want[state].correct);
      expect(has(html, "match-rules-locked"), `${state} locked`).toBe(want[state].locked);
      expect(has(html, "match-rules-cancel"), `${state}: Cancel exists only inside a correction in progress`).toBe(false);
      checked++;
    }
    expect(checked).toBe(4);
  });

  /** The markup `renderToStaticMarkup` writes for a sentence: its text with the HTML-significant characters escaped. */
  const esc = (t: string): string => t.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#x27;");

  it("a bye (decided without play) says so, not that the match is finished - words from the app's own refusal sentences", () => {
    const html = render({ ...base, state: "decided" });
    expect(html).toContain('data-state="decided"');
    expect(html).toContain('data-reason="decided"');
    expect(html).toContain(esc(EN["rules.err.fixtureDecidedWithoutPlay"]!));
    expect(html, "not the finished-match sentence").not.toContain(esc(EN["matchRules.locked"]!));
    const finished = render({ ...base, state: "locked" });
    expect(finished).toContain('data-reason="finished"');
    expect(finished).toContain(esc(EN["matchRules.locked"]!));
    expect(html, "no form").not.toMatch(/<(select|input)\b/);
  });

  it("an empty stage line says nothing about the stage (no 'From the stage:' with nothing after it)", () => {
    expect(has(render({ ...base, stageLine: "" }), "match-rules-stage-line")).toBe(false);
  });
});

describe("football extra time (the Task 5 carry), as the organiser sees it", () => {
  it("a stage with extra time 2 x 10: the select is on 10, offers Off and 1-10 minute halves, and not the old default 15", () => {
    const stage = stageCfg("football", "11-a-side", "knockout", { extraTime: { enabled: true, halfMinutes: 10 } });
    const html = render(props({ sportKey: "football", variant: "11-a-side", stageKind: "knockout", stageResolved: stage }));
    const et = blockOf(html, "extraTime");
    expect(et).toContain("<select");
    expect(et, "no checkbox: the old on/off field is gone").not.toContain('type="checkbox"');
    expect(et).toMatch(/<option value="10" selected/);
    const offered = optionValues(et);
    expect(offered).toContain("off");
    expect(offered).not.toContain("15");
    expect(offered, "nothing longer than the stage's").not.toContain("11");
    expect(text(et)).toContain(EN["matchRules.halfMinutes"]!.replace("{n}", "10"));
  });

  it("a stage with extra time OFF: held - the select is disabled, offers only Off, and says why", () => {
    const stage = stageCfg("football", "11-a-side", "knockout", { extraTime: { enabled: false, halfMinutes: 15 } });
    const html = render(props({ sportKey: "football", variant: "11-a-side", stageKind: "knockout", stageResolved: stage }));
    const et = blockOf(html, "extraTime");
    expect(et).toMatch(/<select[^>]*disabled/);
    expect(optionValues(et).filter((v) => v !== "")).toEqual(["off"]);
    expect(has(html, "match-rules-held-extraTime")).toBe(true);
    expect(text(html)).toContain(EN["matchRules.heldOff"]);
  });

  it("an override that shortens extra time opens at ITS value", () => {
    const stage = stageCfg("football", "11-a-side", "knockout", { extraTime: { enabled: true, halfMinutes: 10 } });
    const override = { extraTime: { enabled: true, halfMinutes: 5 } };
    const html = render(props({ sportKey: "football", variant: "11-a-side", stageKind: "knockout", stageResolved: stage, override, effective: mergeRulesOverride(stage, override) as Record<string, unknown> }));
    expect(blockOf(html, "extraTime")).toMatch(/<option value="5" selected/);
    expect(blockOf(html, "extraTime")).toContain('data-source="match"');
  });
});

describe("another language, and the registry", () => {
  it("in Spanish the block speaks Spanish (title, stage line, chip, reset), never the English dictionary's words", () => {
    const stage = stageCfg("badminton", "short", "league");
    const override = { bestOf: 1 };
    const html = render(
      props({ sportKey: "badminton", variant: "short", stageResolved: stage, override, effective: mergeRulesOverride(stage, override) as Record<string, unknown> }),
      esUi as Dict,
      "es",
    );
    for (const key of ["matchRules.title", "matchRules.overridden", "matchRules.reset"]) {
      expect(ES[key], key).not.toBe(EN[key]);
      expect(text(html), key).toContain(ES[key]);
    }
    expect(text(html)).not.toContain(EN["matchRules.reset"]);
    const lockedHtml = render(props({ sportKey: "badminton", variant: "short", stageResolved: stage, state: "locked" }), esUi as Dict, "es");
    expect(text(lockedHtml)).toContain(ES["matchRules.locked"]);
  });

  it("every sport x stage kind x variant renders; the fields shown are the engine's match keys (counted)", () => {
    let cells = 0;
    let blocks = 0;
    for (const m of builtinModules)
      for (const kind of StageKind.options)
        for (const variant of Object.keys(m.variants)) {
          const stage = stageCfg(m.key, variant, kind);
          const html = render(props({ sportKey: m.key, variant, stageKind: kind, stageResolved: stage }));
          const matchTop = new Set(fixtureKeysFor(m, kind, variant).map((k) => k.split(".")[0]!));
          cells++;
          expect(has(html, "match-rules-block"), `${m.key}/${kind}/${variant}`).toBe(true);
          for (const id of fieldIds(html)) {
            expect(matchTop.has(id), `${m.key}/${kind}/${variant}: ${id} is a match key`).toBe(true);
            blocks++;
          }
        }
    expect(cells).toBe(builtinModules.reduce((n, m) => n + StageKind.options.length * Object.keys(m.variants).length, 0));
    expect(blocks, "some cells have match fields").toBeGreaterThan(0);
  });

  it("a sport the app does not know renders nothing rather than crashing the console", () => {
    expect(render(props({ sportKey: "no-such-sport", stageResolved: {} }))).toBe("");
  });
});
