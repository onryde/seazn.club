// W2c Task 17 (carry 2). The chess tie-break rung list is the first ORDERED-LIST ("sequence") rule field. Until Task 17
// the editor HID it: with no control for a list, `MatchRuleFields` would have rendered it as ONE <select>, so an organiser
// could pick a single rung, and saving `[]` ("no tie-break games: a drawn game waits for me") was not expressible. Task 17
// built the control (`stage-rules/sequence-field.tsx`): a list you reorder and remove from, a menu for what is not yet in
// it, and an EMPTY list that is a value of its own (`RuleField.emptyValue`), never a blank (a blank means "unset").
//
// This file proves the control is reached through the REAL component an organiser sees (static markup; the component has
// no effects), that the pure list helpers behind it keep order and the empty case, and - in the second half, unchanged
// from Task 8 - that a stored list survives a save through the editor, the empty list included.
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { TIEBREAK_RUNGS } from "@seazn/engine/sports/boardgame";
import { DictProvider } from "@/components/i18n/dict-provider";
import enUi from "@/dictionaries/en/ui.json";
import type { Dict } from "@/lib/i18n-constants";
import { SPORT_RULES, buildRuleOverride, clearedSequenceKeys, hydrateRuleValues, visibleRuleFields } from "@/lib/match-rules";
import { moveSequenceItem, sequenceItems, sequenceValue } from "../stage-rules/sequence-field";
import { MatchRuleFields } from "@/components/v2/rules/match-format-editor";

const render = (sportKey: string, values: Record<string, string> = {}): string =>
  renderToStaticMarkup(
    <DictProvider dict={enUi as Dict} locale="en">
      <MatchRuleFields sportKey={sportKey} values={values} onChange={() => undefined} />
    </DictProvider>,
  );
const labelOf = (s: string): string => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const TIEBREAK = SPORT_RULES.boardgame!.find((f) => f.kind === "sequence")!;
const rungLabel = (v: string): string => TIEBREAK.options!.find((o) => o.value === v)!.label;
/** The tie-break list's items as rendered, in order: the `<li data-testid="...-item-<i>">` rows' label spans. */
const renderedItems = (markup: string): string[] =>
  [...markup.matchAll(/data-testid="stage-rule-sequence-tiebreakRungs-item-(\d+)"[^>]*><span[^>]*>([^<]*)<\/span>/g)].map((m) => m[2]!);

describe("the editor shows the sequence field, with a control that can say the empty list (carry 2)", () => {
  it("empty case first: the table really holds a sequence field, so the checks below have something to show", () => {
    const sequences = Object.entries(SPORT_RULES).flatMap(([sport, fields]) => fields.filter((f) => f.kind === "sequence").map((f) => `${sport}.${f.key}`));
    expect(sequences).toEqual(["boardgame.tiebreakRungs"]);
    expect(TIEBREAK.emptyValue, "a sequence field names its empty token").toBeDefined();
    expect(TIEBREAK.options!.map((o) => o.value)).toEqual([...TIEBREAK_RUNGS]);
  });

  it("visibleRuleFields keeps every field of every sport, sequence fields included, in table order (counted)", () => {
    let checked = 0;
    let sequences = 0;
    for (const [sport, fields] of Object.entries(SPORT_RULES)) {
      expect(visibleRuleFields(sport, {}).map((f) => f.key), sport).toEqual(fields.map((f) => f.key));
      checked += fields.length;
      sequences += fields.filter((f) => f.kind === "sequence").length;
    }
    expect(checked).toBeGreaterThan(0);
    expect(sequences).toBe(1);
  });

  it("the rendered chess editor shows the tie-break list: the default order as rows, nothing left to add", () => {
    const markup = render("boardgame");
    expect(markup).toContain(labelOf(TIEBREAK.label));
    expect(markup).toContain('data-testid="stage-rule-sequence-tiebreakRungs"');
    // Every rung, in the engine's declared order - read from the engine's own list, not typed.
    expect(renderedItems(markup)).toEqual(TIEBREAK_RUNGS.map(rungLabel));
    expect(markup).not.toContain("stage-rule-sequence-tiebreakRungs-add"); // all three are in the list: nothing to add
    expect(markup).not.toContain("stage-rule-sequence-tiebreakRungs-reset"); // the default order has nothing to reset
    expect(markup).toContain("Default order");
    // The positive pair: the clock fields still render beside it.
    expect(markup).toContain("Rapid");
  });

  it("a stored list renders in its STORED order, and what it leaves out is offered to add", () => {
    const stored = [TIEBREAK_RUNGS[2]!, TIEBREAK_RUNGS[0]!];
    const markup = render("boardgame", { tiebreakRungs: stored.join(",") });
    expect(renderedItems(markup)).toEqual(stored.map(rungLabel));
    expect(markup).toContain("stage-rule-sequence-tiebreakRungs-add");
    expect(markup).toContain(`<option value="${TIEBREAK_RUNGS[1]}">${labelOf(rungLabel(TIEBREAK_RUNGS[1]!))}</option>`);
    expect(markup).toContain("stage-rule-sequence-tiebreakRungs-reset");
    expect(markup).not.toContain("Default order");
  });

  it("the EMPTY list is shown as 'no tie-breaks' with every rung offered, not as the default order", () => {
    const markup = render("boardgame", { tiebreakRungs: TIEBREAK.emptyValue! });
    expect(renderedItems(markup)).toEqual([]);
    expect(markup).toContain('data-testid="stage-rule-sequence-tiebreakRungs-empty"');
    expect(markup).toContain("a level match waits for you");
    for (const r of TIEBREAK_RUNGS) expect(markup).toContain(`<option value="${r}">`);
  });

  it("the pure list helpers: blank is the default order, [] is the empty token (never blank), order and moves are kept", () => {
    expect(sequenceItems(TIEBREAK, "")).toEqual([...TIEBREAK_RUNGS]);
    expect(sequenceItems(TIEBREAK, TIEBREAK.emptyValue!)).toEqual([]);
    expect(sequenceValue(TIEBREAK, [])).toBe(TIEBREAK.emptyValue);
    expect(sequenceValue(TIEBREAK, [])).not.toBe("");
    const reversed = [...TIEBREAK_RUNGS].reverse();
    expect(sequenceItems(TIEBREAK, sequenceValue(TIEBREAK, reversed))).toEqual(reversed);
    expect(moveSequenceItem(["a", "b", "c"], 2, -1)).toEqual(["a", "c", "b"]);
    expect(moveSequenceItem(["a", "b", "c"], 0, 1)).toEqual(["b", "a", "c"]);
    // the edges are no-ops, never a wrap or a loss
    expect(moveSequenceItem(["a", "b", "c"], 0, -1)).toEqual(["a", "b", "c"]);
    expect(moveSequenceItem(["a", "b", "c"], 2, 1)).toEqual(["a", "b", "c"]);
    expect(moveSequenceItem([], 0, 1)).toEqual([]);
    // a field with no empty token cannot say "empty on purpose": it falls back to unset
    expect(sequenceValue({ ...TIEBREAK, emptyValue: undefined }, [])).toBe("");
  });
});

// A stored list is not lost by an editor that does not show it. The division Settings save sends
// `{...division.config, ...buildRuleOverride(sport, hydrateRuleValues(sport, division.config), division.config)}`
// (division-settings.tsx applyFormat); a stage's PUT sends the same override over its rules fragment.
describe("a stored rung list survives a save through the editor, the empty list included (I1, I2)", () => {
  const save = (config: Record<string, unknown>): Record<string, unknown> => ({
    ...config,
    ...buildRuleOverride("boardgame", hydrateRuleValues("boardgame", config), config),
  });
  // every ordered selection of the engine's rungs: [], each single, each ordered pair, each ordered triple
  const orderedSelections = (rungs: readonly string[]): string[][] => {
    const out: string[][] = [[]];
    const grow = (prefix: string[]) => {
      for (const r of rungs) {
        if (prefix.includes(r)) continue;
        const next = [...prefix, r];
        out.push(next);
        grow(next);
      }
    };
    grow([]);
    return out;
  };

  it("an API-set EMPTY list is kept by a division save, and a division with no list is not given one", () => {
    const config = { variant: "classical", tiebreakRungs: [] as string[] };
    expect(save(config)).toEqual(config);
    // The positive pair: absent stays absent (a rewrite that invented a list would pin the engine's default order).
    const bare = { variant: "classical" };
    expect(save(bare)).toEqual(bare);
    expect(Object.hasOwn(save(bare), "tiebreakRungs")).toBe(false);
  });

  it("an EMPTY list is a value of its own on reopen, distinct from no list, and rebuilds as the empty list (a stage fragment's PUT)", () => {
    const withEmpty = hydrateRuleValues("boardgame", { tiebreakRungs: [] });
    expect(withEmpty.tiebreakRungs, "an empty list hydrates to something, not to nothing").toBeDefined();
    expect(withEmpty.tiebreakRungs, "and not to a blank, which means 'unset'").not.toBe("");
    expect(hydrateRuleValues("boardgame", {})).toEqual({}); // no list: nothing to show
    expect(buildRuleOverride("boardgame", withEmpty)).toEqual({ tiebreakRungs: [] });
  });

  it("every ordered selection of the engine's rungs round-trips through hydrate and build, order kept", () => {
    const selections = orderedSelections(TIEBREAK_RUNGS);
    // 1 empty + 3 single + 6 ordered pairs + 6 ordered triples: derived from the engine's rung count, not typed
    expect(selections.length).toBe(1 + 3 + 6 + 6);
    for (const list of selections) {
      const saved = { tiebreakRungs: list };
      expect(buildRuleOverride("boardgame", hydrateRuleValues("boardgame", saved)), JSON.stringify(list)).toEqual(saved);
      expect(save({ variant: "blitz", ...saved }), JSON.stringify(list)).toEqual({ variant: "blitz", ...saved });
    }
  });
});

// W2c Task 17, fix round 1 (I-2): which keys the division door removes on a reset. The door's PATCH itself is pinned in
// `division-format-patch.test.ts`; this is the field-table half.
describe("clearedSequenceKeys: a blank ordered list is a reset, nothing else is", () => {
  it("a blank or absent list names its key; a list, the empty token and every non-sequence sport name nothing (counted)", () => {
    expect(clearedSequenceKeys("boardgame", {})).toEqual(["tiebreakRungs"]);
    expect(clearedSequenceKeys("boardgame", { tiebreakRungs: "" })).toEqual(["tiebreakRungs"]);
    expect(clearedSequenceKeys("boardgame", { tiebreakRungs: "rapid" })).toEqual([]);
    expect(clearedSequenceKeys("boardgame", { tiebreakRungs: TIEBREAK.emptyValue! }), "'no tie-break games' is a value, not a reset").toEqual([]);
    let others = 0;
    for (const [sport, fields] of Object.entries(SPORT_RULES)) {
      if (fields.some((f) => f.kind === "sequence")) continue;
      expect(clearedSequenceKeys(sport, {}), `${sport}: a blank number or select keeps what is saved`).toEqual([]);
      others++;
    }
    expect(others, "sports without a sequence field were walked").toBeGreaterThan(0);
  });
});
