// W2c Task 8, fix round 1 (I1, I2). The chess tie-break rung list is the first ORDERED-LIST ("sequence") rule field, and
// the control that edits one is Task 17's. Until it exists, `MatchRuleFields` renders any non-number kind as ONE <select>,
// so an organiser could pick a single rung — a list of one that dead-ends the scorer (the pad would offer only that rung,
// and an Armageddon-only list asks for a colour the sheet cannot yet take). So the editor hides every sequence field, and a
// list that the API (or a later control) set must still survive a save through the fields it does not show.
//
// The hide is in `visibleRuleFields`, which `MatchRuleFields` calls. A hide nothing renders through would be an inert seam,
// so this renders the REAL component (static markup; the component has no effects) and reads what an organiser would see.
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { TIEBREAK_RUNGS } from "@seazn/engine/sports/boardgame";
import { DictProvider } from "@/components/i18n/dict-provider";
import enUi from "@/dictionaries/en/ui.json";
import type { Dict } from "@/lib/i18n-constants";
import { SPORT_RULES, buildRuleOverride, hydrateRuleValues, visibleRuleFields } from "@/lib/match-rules";
import { MatchRuleFields } from "../match-rules";

const render = (sportKey: string, values: Record<string, string> = {}): string =>
  renderToStaticMarkup(
    <DictProvider dict={enUi as Dict} locale="en">
      <MatchRuleFields sportKey={sportKey} values={values} onChange={() => undefined} />
    </DictProvider>,
  );
const labelOf = (s: string): string => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

describe("the editor shows no sequence field until Task 17 builds its control (I1)", () => {
  it("empty case first: the table really holds a sequence field, so the hide below has something to hide", () => {
    const sequences = Object.entries(SPORT_RULES).flatMap(([sport, fields]) => fields.filter((f) => f.kind === "sequence").map((f) => `${sport}.${f.key}`));
    expect(sequences).toEqual(["boardgame.tiebreakRungs"]);
  });

  it("visibleRuleFields drops every sequence field from every sport and keeps the others in table order", () => {
    let hidden = 0;
    let kept = 0;
    for (const [sport, fields] of Object.entries(SPORT_RULES)) {
      const visible = visibleRuleFields(sport, {});
      expect(visible.filter((f) => f.kind === "sequence").map((f) => f.key), sport).toEqual([]);
      expect(visible.map((f) => f.key), sport).toEqual(fields.filter((f) => f.kind !== "sequence").map((f) => f.key));
      hidden += fields.length - visible.length;
      kept += visible.length;
    }
    expect(hidden).toBeGreaterThan(0);
    expect(kept).toBeGreaterThan(0);
  });

  it("the rendered chess editor shows its clock fields and none of the tie-break list: no select offers a single rung", () => {
    const markup = render("boardgame");
    const shown = SPORT_RULES.boardgame!.filter((f) => f.kind !== "sequence");
    expect(shown.length).toBeGreaterThan(0);
    for (const f of shown) expect(markup, f.key).toContain(labelOf(f.label));
    const sequence = SPORT_RULES.boardgame!.find((f) => f.kind === "sequence")!;
    expect(markup).not.toContain(labelOf(sequence.label));
    for (const o of sequence.options ?? []) expect(markup, `option ${o.label}`).not.toContain(`>${labelOf(o.label)}<`);
    // The positive pair: the same editor, the same component, still renders a select for a field it does show.
    expect(markup).toContain("<select");
    expect(markup).toContain("Rapid"); // the clock family's own option, so "Rapid game" being absent is not a missing render
  });

  it("every sport's rendered editor omits every sequence field's label", () => {
    let judged = 0;
    for (const sport of Object.keys(SPORT_RULES)) {
      const markup = render(sport);
      for (const f of SPORT_RULES[sport]!.filter((x) => x.kind === "sequence")) expect(markup, `${sport}.${f.key}`).not.toContain(labelOf(f.label));
      judged++;
    }
    expect(judged).toBe(Object.keys(SPORT_RULES).length);
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
