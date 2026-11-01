// R3.5/Task Q — the standings-points editor (division-settings.tsx's
// applyFormat) silently cancelled Task I's shoot-out points split, and was
// broken outright for every sport but generic. Three bugs, all in
// division-settings.tsx:
//
//   1. `ruleValues` (MatchRuleFields' controlled values) never hydrated from
//      `division.config` — every field showed blank on reopen no matter what
//      was saved.
//   2. `Object.assign(override, buildRuleOverride(...))` replaced
//      `override.points` WHOLESALE instead of merging it — buildRuleOverride
//      returns a nested `{ points: {...} }`, so this discarded whatever of
//      `division.config.points` the rule fields didn't themselves resend.
//   3. The standings-points writer (win/draw/loss inputs) then overwrote
//      `override.points` YET AGAIN, unconditionally, using `w`/`d`/`l` — keys
//      only `generic.ts` reads (verified against every sport module: football,
//      cricket, the period kernel, the nested kernel all use win/draw/loss).
//      For every other sport this editor's writes were silently dropped by
//      the pinned schema's non-strict `.object()`, and its reads were always
//      undefined, so the boxes showed blank too.
//
// W2d (PS-1): Task I's shoot-out points pair is gone (a table shoot-out is a draw plus `points.soBonus`, which the
// stage's Points section owns). `soBonus` stays in these fixtures as the saved points key NO box here edits: every save
// must carry it through untouched, which is what bug 2 broke.
//
// Match Day C2: the match rules and the standings points left Settings for the Division rules strip on the Fixtures tab
// (`rules/division-rules-strip.tsx`), each with its own Save - the Match format panel's "Save match format" sends the rules
// and leaves the points as stored; the Points panel's Save sends the points. The three bugs below are the strip's to keep
// fixed, so this suite now drives the strip (`_rules-strip.tsx` opens its two child editors the way a browser renders them).
//
// Same harness as division-settings-paywall.test.tsx (a stateful island; renderToStaticMarkup can't drive a save).
// MatchRuleFields is a CHILD function component, so its own <input>s never appear in tree() (see typeRuleField's comment) —
// this suite reaches through its `values`/`onChange` props directly instead, exactly what a real keystroke inside it would
// do one level down.
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ReactElement } from "react";
import { propsOf, renderIsland, textOf } from "@/components/__tests__/_hook-harness";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: vi.fn(), push: vi.fn(), replace: vi.fn() }),
}));
vi.mock("@/components/ui/confirm-provider", () => ({
  useConfirm: () => vi.fn(async () => false),
}));

const net = vi.hoisted(() => ({
  calls: [] as { url: string; options?: { method?: string; json?: unknown } }[],
}));

vi.mock("@/lib/client-v1", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/client-v1")>();
  return {
    ...actual,
    apiV1: vi.fn((url: string, options?: { method?: string; json?: unknown }) => {
      net.calls.push({ url, options });
      // The venues tag-suggestions fetch (division-settings.tsx's only other
      // apiV1 caller) just needs to not throw synchronously — its own
      // `.catch()` swallows anything this shape can't satisfy.
      if (url.includes("/venues")) return Promise.resolve([]);
      return Promise.resolve({});
    }),
  };
});

import { MatchRuleFields } from "@/components/v2/rules/match-format-editor";
import { DivisionRulesStrip, expandRules, stripPropsOf } from "./_rules-strip";

const FOOTBALL_POINTS = { win: 3, draw: 1, loss: 0, soBonus: 1 };

function baseProps(config: Record<string, unknown>, sportKey = "football", variantKey = "standard") {
  return stripPropsOf({
    division: { id: "d1", sport_key: sportKey, variant_key: variantKey, config },
    variants: [{ key: variantKey, name: "Standard" }],
  });
}

function mount(config: Record<string, unknown>, sportKey = "football", variantKey = "standard") {
  return renderIsland(DivisionRulesStrip, baseProps(config, sportKey, variantKey), expandRules);
}

/** The Match format panel's Save (rules only) and the Points panel's Save (points only, offered once a box differs). */
const SAVE_RULES = "division-rules-format-save";
const SAVE_POINTS = "division-points-save";

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

/** Same idiom as division-settings-paywall.test.tsx's clickButton: invoke the
 *  handler the harness found rather than simulate a DOM click — there is no
 *  DOM here (`environment: "node"`). */
function clickButton(tree: ReactElement[], testId: string): void {
  const btn = tree.find((n) => n.type === "button" && propsOf(n)["data-testid"] === testId);
  if (!btn) {
    throw new Error(`no <button> "${testId}" — rendered: ${tree.map((n) => textOf(n)).join(" | ")}`);
  }
  (propsOf(btn).onClick as () => void)();
}

function lastPatchConfig(): Record<string, unknown> {
  const patch = [...net.calls].reverse().find((c) => c.options?.method === "PATCH");
  if (!patch) throw new Error(`no PATCH call captured — calls: ${JSON.stringify(net.calls)}`);
  return (patch.options!.json as { config: Record<string, unknown> }).config;
}

function matchRuleFieldsEl(tree: ReactElement[]): ReactElement {
  const el = tree.find((e) => e.type === MatchRuleFields);
  if (!el) throw new Error("<MatchRuleFields> not found in tree");
  return el;
}

/** MatchRuleFields is a CHILD function component — the interactive hook
 *  harness (_hook-harness.tsx) renders one component ONE level deep and
 *  never CALLS a child component, so MatchRuleFields' own <input>/<select>
 *  elements never show up in tree() — only the opaque <MatchRuleFields>
 *  element does, with its `values`/`onChange` props intact. Its real
 *  onChange handler is exactly `onChange({ ...values, [field.key]:
 *  e.target.value })` (match-rules.tsx's MatchRuleFields) — reproducing that
 *  merge against the CURRENT `values` prop and calling the SAME onChange
 *  DivisionSettings passed down (its setRuleValues) is everything a real
 *  keystroke does differently from this. */
function typeRuleField(tree: ReactElement[], key: string, value: string): void {
  const props = propsOf(matchRuleFieldsEl(tree));
  (props.onChange as (next: Record<string, string>) => void)({
    ...(props.values as Record<string, string>),
    [key]: value,
  });
}

function ruleValuesOf(tree: ReactElement[]): Record<string, string> {
  return propsOf(matchRuleFieldsEl(tree)).values as Record<string, string>;
}

/** Every standings-points <input> currently rendered — min=0/max=99 is the
 *  only pair used for this editor anywhere in division-settings.tsx, every
 *  other numeric field there uses a different min/max. The COUNT varies by
 *  sport post-R3.5-review-F7 (shape-derived: 2 for a win/loss-only sport
 *  like tennis, 3 for win/draw/loss), so this does not assert a length —
 *  `pointsInputs` below is the fixed-at-3 convenience the football/generic
 *  tests already assume. */
function allPointsInputs(tree: ReactElement[]): ReactElement[] {
  return tree.filter((e) => e.type === "input" && propsOf(e).min === 0 && propsOf(e).max === 99);
}

/** The three standings-points <input>s (Win/Draw/Loss, in that order) for a
 *  sport whose schema has all three concepts — football/generic here. */
function pointsInputs(tree: ReactElement[]): ReactElement[] {
  const inputs = allPointsInputs(tree);
  if (inputs.length !== 3) {
    throw new Error(`expected 3 standings-points inputs, found ${inputs.length}`);
  }
  return inputs;
}

function typePointsField(tree: ReactElement[], index: 0 | 1 | 2, value: string): void {
  const input = pointsInputs(tree)[index]!;
  (propsOf(input).onChange as (e: { target: { value: string } }) => void)({ target: { value } });
}

function typeAnyPointsField(tree: ReactElement[], index: number, value: string): void {
  const input = allPointsInputs(tree)[index]!;
  (propsOf(input).onChange as (e: { target: { value: string } }) => void)({ target: { value } });
}

beforeEach(() => {
  net.calls.length = 0;
});

describe("division settings — rule-field values hydrate from the saved config (bug 1)", () => {
  it("shows the division's saved match rules instead of blank inputs on open", () => {
    const island = mount({ halfMinutes: 50, maxSubs: 3, points: { ...FOOTBALL_POINTS } });
    const values = ruleValuesOf(island.tree());
    expect(values.halfMinutes, "halfMinutes should show the saved value, not blank").toBe("50");
    expect(values.maxSubs, "maxSubs should show the saved value, not blank").toBe("3");
  });

  it("hydrates the football standings win/draw/loss inputs from win/draw/loss, not w/d/l", () => {
    const island = mount({ points: { ...FOOTBALL_POINTS } });
    const [w, d, l] = pointsInputs(island.tree());
    expect(propsOf(w!).value).toBe("3");
    expect(propsOf(d!).value).toBe("1");
    expect(propsOf(l!).value).toBe("0");
  });
});

describe("division settings save path — the standings-points editor must not silently cancel other saved points (R3.5/Task Q)", () => {
  it("case 1: saving an unrelated rule change leaves every points key intact (soBonus, which no box owns, included)", async () => {
    const island = mount({ points: { ...FOOTBALL_POINTS } });
    typeRuleField(island.tree(), "halfMinutes", "50");
    clickButton(island.tree(), SAVE_RULES);
    await flush();
    expect(lastPatchConfig().points).toEqual(FOOTBALL_POINTS);
  });

  it("case 2: retyping only the win box still keeps soBonus (and draw/loss) intact", async () => {
    const island = mount({ points: { ...FOOTBALL_POINTS } });
    typePointsField(island.tree(), 0, "5");
    clickButton(island.tree(), SAVE_POINTS);
    await flush();
    const points = lastPatchConfig().points as Record<string, unknown>;
    expect(points.win, "the just-retyped value").toBe(5);
    expect(points.soBonus, "must survive even though no box edits it").toBe(1);
    expect(points.draw).toBe(1);
    expect(points.loss).toBe(0);
  });

  it("case 3: typing standings points 4/2/0 on a football division writes win/draw/loss, never w/d/l", async () => {
    const island = mount({ points: { ...FOOTBALL_POINTS } });
    typePointsField(island.tree(), 0, "4");
    typePointsField(island.tree(), 1, "2");
    typePointsField(island.tree(), 2, "0");
    clickButton(island.tree(), SAVE_POINTS);
    await flush();
    const points = lastPatchConfig().points as Record<string, unknown>;
    expect(points.win).toBe(4);
    expect(points.draw).toBe(2);
    expect(points.loss).toBe(0);
    expect(points.w, "football reads win/draw/loss, never w/d/l").toBeUndefined();
    expect(points.d).toBeUndefined();
    expect(points.l).toBeUndefined();
  });

  it("case 4: a generic division still writes w/d/l, not win/draw/loss", async () => {
    const island = mount({ points: { w: 3, d: 1, l: 0 } }, "generic", "generic-standard");
    typePointsField(island.tree(), 0, "5");
    typePointsField(island.tree(), 1, "2");
    typePointsField(island.tree(), 2, "1");
    clickButton(island.tree(), SAVE_POINTS);
    await flush();
    const points = lastPatchConfig().points as Record<string, unknown>;
    expect(points.w).toBe(5);
    expect(points.d).toBe(2);
    expect(points.l).toBe(1);
    expect(points.win, "generic reads w/d/l, never win/draw/loss").toBeUndefined();
  });

  it("does not disturb an unrelated rule field saved in the same request", async () => {
    const island = mount({ points: { ...FOOTBALL_POINTS } });
    typeRuleField(island.tree(), "halfMinutes", "50");
    clickButton(island.tree(), SAVE_RULES);
    await flush();
    expect(lastPatchConfig().halfMinutes).toBe(50);
  });
});

describe("division settings — the points editor renders exactly the boxes a sport's schema declares (R3.5 review F7)", () => {
  it("renders Win/Loss only for a sport whose points schema has no draw (tennis)", () => {
    const island = mount({ points: { win: 3, loss: 0 } }, "tennis", "standard");
    expect(allPointsInputs(island.tree())).toHaveLength(2);
  });

  it("never writes a spurious draw key for a division whose schema has none (tennis)", async () => {
    const island = mount({ points: { win: 3, loss: 0 } }, "tennis", "standard");
    clickButton(island.tree(), SAVE_RULES);
    await flush();
    const points = lastPatchConfig().points as Record<string, unknown>;
    expect(points.win).toBe(3);
    expect(points.loss).toBe(0);
    expect(points.draw, "tennis has no draw in its points schema — must not gain one").toBeUndefined();
  });

  it("retyping win/loss for a tennis division writes only those two keys", async () => {
    const island = mount({ points: { win: 3, loss: 0 } }, "tennis", "standard");
    typeAnyPointsField(island.tree(), 0, "4");
    typeAnyPointsField(island.tree(), 1, "1");
    clickButton(island.tree(), SAVE_POINTS);
    await flush();
    const points = lastPatchConfig().points as Record<string, unknown>;
    expect(points.win).toBe(4);
    expect(points.loss).toBe(1);
    expect(Object.keys(points).sort()).toEqual(["loss", "win"]);
  });

  it("renders Win/Loss only for a T20-shaped cricket division (no draw) — tie/noResult stay unexposed", () => {
    const island = mount({ points: { win: 2, tie: 1, noResult: 1, loss: 0 } }, "cricket", "standard");
    expect(allPointsInputs(island.tree())).toHaveLength(2);
  });

  it("saving a T20-shaped cricket division leaves tie/noResult untouched and writes no draw", async () => {
    const island = mount({ points: { win: 2, tie: 1, noResult: 1, loss: 0 } }, "cricket", "standard");
    clickButton(island.tree(), SAVE_RULES);
    await flush();
    const points = lastPatchConfig().points as Record<string, unknown>;
    expect(points.win).toBe(2);
    expect(points.loss).toBe(0);
    expect(points.tie, "not yet exposed as editable — must pass through unchanged").toBe(1);
    expect(points.noResult, "not yet exposed as editable — must pass through unchanged").toBe(1);
    expect(points.draw, "T20 has no draw in its points schema — must not gain one").toBeUndefined();
  });

  it("renders Win/Draw/Loss for a 2-innings-shaped cricket division (draw present) — tie/noResult still unexposed", () => {
    const island = mount(
      { points: { win: 2, tie: 1, noResult: 1, loss: 0, draw: 1 } },
      "cricket",
      "standard",
    );
    expect(allPointsInputs(island.tree())).toHaveLength(3);
  });
});

describe("division settings — no football field writes shoot-out points any more (W2d PS-1)", () => {
  it("a retired shoot-out points key typed into the form (a stale tab) writes nothing into points", async () => {
    const island = mount({ points: { ...FOOTBALL_POINTS } });
    typeRuleField(island.tree(), "shootoutWin", "2");
    typeRuleField(island.tree(), "shootoutLoss", "1");
    clickButton(island.tree(), SAVE_RULES);
    await flush();
    expect(lastPatchConfig().points, "exactly the saved points: no retired key gained, soBonus kept").toEqual(FOOTBALL_POINTS);
  });
});

describe("division settings — the rules/points panel re-syncs with a refreshed division.config (R3.5 review F6)", () => {
  it("re-hydrates ruleValues on a MOUNTED instance when router.refresh() hands back a new config", () => {
    const island = mount({ halfMinutes: 50, points: { ...FOOTBALL_POINTS } });
    expect(ruleValuesOf(island.tree()).halfMinutes, "sanity: starts hydrated from the initial config").toBe("50");
    // The shape a real router.refresh() delivers after a key is deleted server-side: same component instance, a NEW
    // division.config with halfMinutes gone.
    island.rerender(baseProps({ points: { win: 3, draw: 1, loss: 0 } }));
    const values = ruleValuesOf(island.tree());
    expect(values.halfMinutes, "must drop the stale value once the server no longer has it").toBeUndefined();
  });

  it("re-hydrates the standings-points boxes the same way, on the same prop change", () => {
    const island = mount({ points: { ...FOOTBALL_POINTS } });
    island.rerender(
      baseProps({ points: { win: 5, draw: 2, loss: 1, soBonus: 1 } }),
    );
    const [w, d, l] = pointsInputs(island.tree());
    expect(propsOf(w!).value, "server-clamped/defaulted win must overwrite the stale typed value").toBe("5");
    expect(propsOf(d!).value).toBe("2");
    expect(propsOf(l!).value).toBe("1");
  });

  it("does not discard an in-progress edit when the refreshed config's CONTENT is unchanged", () => {
    const island = mount({ points: { ...FOOTBALL_POINTS } });
    typeRuleField(island.tree(), "halfMinutes", "77");
    // Same content, a fresh object — what an UNRELATED save elsewhere in
    // this component (name, logo, entrants...) hands back via
    // router.refresh(), since the server always re-serialises `config` even
    // when nothing in it changed.
    island.rerender(baseProps({ points: { ...FOOTBALL_POINTS } }));
    expect(
      ruleValuesOf(island.tree()).halfMinutes,
      "an unrelated refresh must not discard a field the organiser is mid-typing",
    ).toBe("77");
  });
});

describe("the Points panel's own Save (Match Day C2: the points left the rules' Save)", () => {
  it("is offered only once a box differs from what is stored; typed back, it goes again (and the rules' Save never sends a typed box)", async () => {
    const island = mount({ points: { ...FOOTBALL_POINTS } });
    const offered = () => island.tree().some((e) => propsOf(e)["data-testid"] === SAVE_POINTS);
    expect(offered(), "untouched: nothing to save").toBe(false);
    typePointsField(island.tree(), 0, "5");
    expect(offered(), "a box differs").toBe(true);
    clickButton(island.tree(), SAVE_RULES);
    await flush();
    expect(lastPatchConfig().points, "the rules' Save leaves the points as stored").toEqual(FOOTBALL_POINTS);
    typePointsField(island.tree(), 0, "3");
    expect(offered(), "typed back: nothing to save").toBe(false);
  });
});
