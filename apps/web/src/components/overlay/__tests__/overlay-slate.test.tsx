// Theme C — the slate (`_THEMES.md` §4a, task 5e). `apps/web` vitest is
// `environment: "node"` — no DOM, so this cannot see the rendered ground, the
// radial highlight or the actual cross-fade paint; it proves the ELEMENT TREE
// and the STATE MACHINE `OverlaySlate` produces, the same way
// decided-void-and-cells.test.tsx proves the bar/bug. `OverlaySlate` (unlike
// bar/bug) uses hooks, so it is driven through `renderIsland`
// (_hook-harness.tsx), not called as a plain function.
import { afterEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { isValidElement, type ReactElement, type ReactNode } from "react";
import { propsOf, renderIsland, textOf } from "@/components/__tests__/_hook-harness";
import { OverlaySlate, slateStateOf } from "../overlay-slate";
import { OVERLAY_THEMES, defaultThemeFor, type OverlayThemeProps } from "../theme-registry";
import { t } from "@/lib/i18n-runtime";
import type { OverlayModel, OverlayMsg } from "@/lib/overlay-model";

const HERE = dirname(fileURLToPath(import.meta.url));
const DICT = join(HERE, "../../../dictionaries");
const LOCALES = ["en", "fr", "es", "nl"] as const;

/** The eleven sport keys the overlay serves — the same list `theme-registry`'s
 *  own slate suite sweeps. Expectations are DERIVED from `defaultThemeFor`
 *  below, never from a per-sport table typed here. */
const SPORTS = [
  "cricket",
  "football",
  "hockey",
  "icehockey",
  "tennis",
  "badminton",
  "tabletennis",
  "volleyball",
  "boardgame",
  "carrom",
  "generic",
] as const;

const dictOf = (locale: string): Record<string, string> =>
  JSON.parse(readFileSync(join(DICT, locale, "public.json"), "utf8"));

/** The REAL `msg` an overlay theme receives — `t()` over the real, on-disk
 *  dictionary for that locale, which is exactly what `overlay-stage.tsx`
 *  builds (`(key, vars) => t(props.dict, key, vars)`). A hardcoded English
 *  string in the component therefore cannot satisfy `fr`. */
const msgOf =
  (locale: string): OverlayMsg =>
  (key, vars) =>
    t(dictOf(locale), key, vars);

const BASE_MODEL: OverlayModel = {
  live: true,
  decided: false,
  voided: false,
  header: { context: "overlay.header.live" },
  sides: [
    { short: "MIL", name: "Milton Keynes Rovers", big: "2", led: false, serving: false },
    { short: "NOR", name: "Northbridge Athletic", big: "1", led: true, serving: false },
  ],
  cellsKind: "none",
  cells: [],
  detail: [],
};

function classesOf(el: ReactElement): string {
  return (propsOf(el).className as string | undefined) ?? "";
}

/** The registry's own hookless themes, DERIVED from the registry rather than
 *  named here: whichever component `defaultThemeFor` picks is the one `expand`
 *  must descend into, so this keeps working if a sport's default moves.
 *  `OverlaySlate` itself is excluded — it has hooks, and nothing defaults to
 *  it (pinned in theme-registry.test.ts). */
const COMPOSITABLE = new Set(
  Object.values(OVERLAY_THEMES)
    .map((theme) => theme.component)
    .filter((component) => component !== OverlaySlate),
);

/**
 * `OverlaySlate` embeds the composited scorebug as JSX (§4a: "the selected
 * theme … renders ON TOP"), not as a called function — `walk`'s default
 * behaviour reads only `.props.children`, so it treats that element as opaque
 * and never descends into what the scorebug itself renders. This expands it —
 * hookless, so calling it directly is a real, non-mocked render, the same
 * shape decided-void-and-cells.test.tsx uses at the top level; here it happens
 * one level deeper because OverlaySlate embeds it rather than calling it.
 */
function expand(node: ReactNode, out: ReactElement[] = []): ReactElement[] {
  if (Array.isArray(node)) {
    for (const child of node) expand(child, out);
    return out;
  }
  if (!isValidElement(node)) return out;
  out.push(node);
  if (typeof node.type === "function" && COMPOSITABLE.has(node.type as never)) {
    return expand((node.type as (p: OverlayThemeProps) => ReactNode)(node.props as OverlayThemeProps), out);
  }
  return expand((node.props as { children?: ReactNode }).children, out);
}

function render(
  model: OverlayModel,
  tick: [boolean, boolean] = [false, false],
  { locale = "en", sportKey = "football" }: { locale?: string; sportKey?: string } = {},
) {
  return renderIsland(OverlaySlate, { model, tick, msg: msgOf(locale), sportKey }, expand);
}

const byTestId = (tree: ReactElement[], id: string) => tree.find((el) => propsOf(el)["data-testid"] === id);

afterEach(() => {
  vi.useRealTimers();
});

// ---------------------------------------------------------------------------
// The state union `?style=slate` can actually reach — mutated per member.
// ---------------------------------------------------------------------------
describe("slateStateOf — the three states OverlayModel alone can drive (gap 3: 'signal lost' is not one of them)", () => {
  it("decided ⇒ ended", () => {
    expect(slateStateOf({ ...BASE_MODEL, live: false, decided: true, voided: false })).toBe("ended");
  });

  it("voided ⇒ ended — the OTHER ended path, not the same branch as decided", () => {
    expect(slateStateOf({ ...BASE_MODEL, live: false, decided: false, voided: true })).toBe("ended");
  });

  it("not decided, not voided, not live ⇒ warming", () => {
    expect(slateStateOf({ ...BASE_MODEL, live: false, decided: false, voided: false })).toBe("warming");
  });

  it("live, and neither decided nor voided ⇒ live", () => {
    expect(slateStateOf({ ...BASE_MODEL, live: true, decided: false, voided: false })).toBe("live");
  });

  it("ended is checked BEFORE live — a mutant swapping the branch order changes this", () => {
    // Real data never sets both, but this pins which `if` runs first.
    expect(slateStateOf({ ...BASE_MODEL, live: true, decided: true, voided: false })).toBe("ended");
  });
});

// ---------------------------------------------------------------------------
// The always-present scaffold: ground root, brand, and the composited
// scorebug — present in EVERY state, never conditional on it.
// ---------------------------------------------------------------------------
describe("OverlaySlate — ground, brand and the scorebug-on-top mount in every state", () => {
  it.each<[string, OverlayModel]>([
    ["warming", { ...BASE_MODEL, live: false, decided: false, voided: false }],
    ["ended (decided)", { ...BASE_MODEL, live: false, decided: true, result: "Milton Keynes Rovers won by 44 runs" }],
    ["ended (voided, no verdict)", { ...BASE_MODEL, live: false, decided: false, voided: true }],
    ["live", { ...BASE_MODEL, live: true, decided: false, voided: false }],
  ])("%s: .ovl-slate, .ovl-slate-brand ('seazn'), and the composited scorebug all mount", (_label, model) => {
    const tree = render(model).tree();
    expect(tree.some((el) => classesOf(el) === "ovl-slate"), "root").toBe(true);
    const brand = tree.find((el) => classesOf(el).includes("ovl-slate-brand"));
    expect(brand, "brand").toBeDefined();
    expect(textOf(brand!)).toBe("seazn");
    const bug = tree.find((el) => classesOf(el).split(" ").includes("ovl-bug"));
    expect(bug, "the composited scorebug (football ⇒ bug, per defaultThemeFor)").toBeDefined();
  });

});

// ---------------------------------------------------------------------------
// Headline / line per state — mutated per member of the union.
// ---------------------------------------------------------------------------
const WARMING: OverlayModel = {
  ...BASE_MODEL,
  live: false,
  decided: false,
  voided: false,
  header: { context: "Sat 14:30 BST" },
};

const ENDED: OverlayModel = {
  ...BASE_MODEL,
  live: false,
  decided: true,
  voided: false,
  header: { context: "Final" },
  result: "Milton Keynes Rovers won by 44 runs",
};

describe("OverlaySlate — headline/line per state, resolved through the theme's own `msg`", () => {
  it("warming: headline is §4a's own key, line is §4a's own template — both from the dictionary, not the model", () => {
    const en = dictOf("en");
    const tree = render(WARMING).tree();
    expect(textOf(byTestId(tree, "ovl-slate-headline")!)).toBe(en["overlay.slate.warmingHeadline"]);
    // The whole interpolated sentence, derived by running the SAME template
    // through the SAME `t()` — never a hand-typed "A v B · 14:30".
    expect(textOf(byTestId(tree, "ovl-slate-line")!)).toBe(
      t(en, "overlay.slate.warmingLine", {
        home: "Milton Keynes Rovers",
        away: "Northbridge Athletic",
        start: "Sat 14:30 BST",
      }),
    );
    const dots = byTestId(tree, "ovl-slate-indicator-warming");
    expect(dots, "warming indicator").toBeDefined();
    const children = propsOf(dots!).children;
    expect(Array.isArray(children) ? children.length : 0, "three dots").toBe(3);
  });

  it("warming: every {var} in the template is supplied — no literal placeholder survives to screen", () => {
    const line = textOf(byTestId(render(WARMING).tree(), "ovl-slate-line")!);
    expect(line, "an unsupplied var renders as `{name}`").not.toMatch(/\{[a-z]+\}/i);
    for (const part of ["Milton Keynes Rovers", "Northbridge Athletic", "Sat 14:30 BST"]) {
      expect(line, part).toContain(part);
    }
  });

  it("ended: headline is §4a's endedHeadline key; line is model.result — zero deviation from §4a's own producer there", () => {
    const en = dictOf("en");
    const tree = render(ENDED).tree();
    expect(textOf(byTestId(tree, "ovl-slate-headline")!)).toBe(en["overlay.slate.endedHeadline"]);
    expect(textOf(byTestId(tree, "ovl-slate-line")!)).toBe("Milton Keynes Rovers won by 44 runs");
    expect(byTestId(tree, "ovl-slate-indicator-warming"), "no warming dots once ended").toBeUndefined();
  });

  it("ended (voided, no verdict): headline still renders; NO line is fabricated for a null resultMsg", () => {
    const en = dictOf("en");
    const model: OverlayModel = { ...BASE_MODEL, live: false, decided: false, voided: true, header: { context: "Cancelled" } };
    const tree = render(model).tree();
    expect(textOf(byTestId(tree, "ovl-slate-headline")!)).toBe(en["overlay.slate.endedHeadline"]);
    expect(byTestId(tree, "ovl-slate-line"), "no invented line").toBeUndefined();
  });

  it("the positive/negative pair — live renders NO .ovl-slate-content at all (§4a defines no fourth headline)", () => {
    const tree = render({ ...BASE_MODEL, live: true, decided: false, voided: false }).tree();
    expect(byTestId(tree, "ovl-slate-content")).toBeUndefined();
    expect(byTestId(tree, "ovl-slate-headline")).toBeUndefined();
    expect(byTestId(tree, "ovl-slate-line")).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// The keys are WIRED, not merely present. A non-English locale is what makes
// this fail against a hardcoded English literal: the four dictionaries carry
// four different sentences, and only a real `msg(key)` lookup produces all
// four. (The old version of this file asserted the keys EXISTED in the four
// JSON files, which passed identically in the orphaned and the wired state.)
// ---------------------------------------------------------------------------
describe("public.overlay.slate.* actually reaches the screen, in every locale", () => {
  it.each(LOCALES)("%s: the warming headline IS that locale's own dictionary value", (locale) => {
    const tree = render(WARMING, [false, false], { locale }).tree();
    expect(textOf(byTestId(tree, "ovl-slate-headline")!)).toBe(dictOf(locale)["overlay.slate.warmingHeadline"]);
  });

  it.each(LOCALES)("%s: the ended headline IS that locale's own dictionary value", (locale) => {
    const tree = render(ENDED, [false, false], { locale }).tree();
    expect(textOf(byTestId(tree, "ovl-slate-headline")!)).toBe(dictOf(locale)["overlay.slate.endedHeadline"]);
  });

  it("en and fr render DIFFERENT words — the differential a hardcoded English string cannot satisfy", () => {
    const headline = (locale: string, model: OverlayModel) =>
      textOf(byTestId(render(model, [false, false], { locale }).tree(), "ovl-slate-headline")!);
    // Guard the guard: if the two dictionaries ever carried the same word this
    // check would be vacuous, so assert the SOURCE differs first.
    expect(dictOf("en")["overlay.slate.warmingHeadline"]).not.toBe(dictOf("fr")["overlay.slate.warmingHeadline"]);
    expect(dictOf("en")["overlay.slate.endedHeadline"]).not.toBe(dictOf("fr")["overlay.slate.endedHeadline"]);
    expect(headline("en", WARMING)).not.toBe(headline("fr", WARMING));
    expect(headline("en", ENDED)).not.toBe(headline("fr", ENDED));
  });

  it("nothing renders a raw dictionary KEY — a `t()` miss returns the key itself and would slip past a bare toBeDefined", () => {
    for (const model of [WARMING, ENDED]) {
      for (const locale of LOCALES) {
        const tree = render(model, [false, false], { locale }).tree();
        const content = byTestId(tree, "ovl-slate-content");
        expect(textOf(content!), `${locale}`).not.toMatch(/overlay\.slate\./);
      }
    }
  });
});

// ---------------------------------------------------------------------------
// The composited scorebug is the SPORT'S default, not a constant (§4a: "the
// SELECTED theme (§3 bar or §4 bug) renders ON TOP"). Expectations derive from
// `defaultThemeFor` + the registry — a table typed here would freeze today's
// answer.
// ---------------------------------------------------------------------------
describe("OverlaySlate — the composited scorebug resolves per sport", () => {
  /** The root className the registry's own default for this sport produces when
   *  rendered standalone. Both bar and bug are hookless, so this is a real,
   *  non-mocked render of the actual component the registry names. */
  const standaloneRootClass = (sportKey: string, model: OverlayModel): string => {
    const Component = OVERLAY_THEMES[defaultThemeFor(sportKey)].component as (p: OverlayThemeProps) => ReactNode;
    const node = Component({ model, tick: [false, false], msg: msgOf("en"), sportKey });
    return isValidElement(node) ? classesOf(node) : "";
  };

  it.each(SPORTS)("%s composites exactly the component defaultThemeFor names for it", (sportKey) => {
    const model: OverlayModel = { ...BASE_MODEL, live: true };
    const expected = standaloneRootClass(sportKey, model);
    expect(expected, `${sportKey} standalone root class`).not.toBe("");
    const tree = render(model, [false, false], { sportKey }).tree();
    expect(
      tree.some((el) => classesOf(el) === expected),
      `${sportKey} should composite ${defaultThemeFor(sportKey)} (root class "${expected}")`,
    ).toBe(true);
  });

  it("cricket gets the BAR and football the BUG — the differential a hardcoded OverlayBug fails", () => {
    const model: OverlayModel = { ...BASE_MODEL, live: true };
    const rootsFor = (sportKey: string) =>
      render(model, [false, false], { sportKey })
        .tree()
        .map((el) => classesOf(el).split(" ")[0]);
    // Derived, not typed: whatever the registry says cricket/football open on.
    expect(defaultThemeFor("cricket"), "premise").not.toBe(defaultThemeFor("football"));
    expect(rootsFor("cricket")).toContain("ovl-bar");
    expect(rootsFor("cricket")).not.toContain("ovl-bug");
    expect(rootsFor("football")).toContain("ovl-bug");
    expect(rootsFor("football")).not.toContain("ovl-bar");
  });

  it("the composited scorebug receives the SAME msg and sportKey the slate got — pass-through, not a fresh channel", () => {
    // The composited theme must be indistinguishable from the same theme
    // served directly under `?style=bar`/`?style=bug`; §3's bar and §4's bug
    // happen not to READ msg today, so this binds on the element's props
    // rather than on rendered text (which would be vacuous for them).
    const msg = msgOf("en");
    const island = renderIsland(
      OverlaySlate,
      { model: { ...BASE_MODEL, live: true }, tick: [true, false] as [boolean, boolean], msg, sportKey: "cricket" },
      expand,
    );
    const scorebug = island.tree().find((el) => COMPOSITABLE.has(el.type as never));
    expect(scorebug, "the composited scorebug element").toBeDefined();
    expect(propsOf(scorebug!).msg, "same msg instance").toBe(msg);
    expect(propsOf(scorebug!).sportKey).toBe("cricket");
    expect(propsOf(scorebug!).tick).toEqual([true, false]);
  });

  it("the composited scorebug receives THIS model and tick, not a stale/default one", () => {
    const a = render({ ...BASE_MODEL, live: true }).tree();
    const b = render({
      ...BASE_MODEL,
      live: true,
      sides: [{ ...BASE_MODEL.sides[0], big: "9" }, BASE_MODEL.sides[1]],
    }).tree();
    expect(textOf(byTestId(a, "ovl-big-home")!)).toBe("2");
    expect(textOf(byTestId(b, "ovl-big-home")!)).toBe("9");
  });
});

// ---------------------------------------------------------------------------
// The 250ms cross-fade (§6): none on mount, exactly one 250ms window per
// real state change, never on a same-state re-render.
// ---------------------------------------------------------------------------
describe("OverlaySlate — the state-swap cross-fade", () => {
  it("never fades on mount", () => {
    vi.useFakeTimers();
    const tree = render({ ...BASE_MODEL, live: false, decided: false, voided: false }).tree();
    expect(classesOf(byTestId(tree, "ovl-slate-content")!)).not.toContain("ovl-slate-fading");
  });

  it("fades for exactly 250ms on a genuine state change, then clears", () => {
    vi.useFakeTimers();
    const island = render({ ...BASE_MODEL, live: false, decided: false, voided: false });
    island.rerender({
      model: { ...BASE_MODEL, live: false, decided: true, voided: false, result: "X won" },
      tick: [false, false],
      msg: msgOf("en"),
      sportKey: "football",
    });
    expect(classesOf(byTestId(island.tree(), "ovl-slate-content")!), "fading right after the swap").toContain(
      "ovl-slate-fading",
    );
    vi.advanceTimersByTime(249);
    expect(classesOf(byTestId(island.tree(), "ovl-slate-content")!), "still fading 1ms short of 250").toContain(
      "ovl-slate-fading",
    );
    vi.advanceTimersByTime(1);
    expect(classesOf(byTestId(island.tree(), "ovl-slate-content")!), "cleared at 250").not.toContain(
      "ovl-slate-fading",
    );
  });

  it("does NOT fade on a re-render that leaves the state unchanged (warming → warming with new data)", () => {
    vi.useFakeTimers();
    const model: OverlayModel = { ...BASE_MODEL, live: false, decided: false, voided: false, header: { context: "Sat 14:30" } };
    const island = render(model);
    island.rerender({
      model: { ...model, header: { context: "Sun 10:00" } },
      tick: [false, false],
      msg: msgOf("en"),
      sportKey: "football",
    });
    const tree = island.tree();
    expect(classesOf(byTestId(tree, "ovl-slate-content")!), "same state: no fade").not.toContain("ovl-slate-fading");
    // The warming LINE carries the changed start label (§4a moved the time off
    // the headline and into the line); the headline itself is now the constant
    // dictionary word, so the "content still updates" claim binds here.
    expect(textOf(byTestId(tree, "ovl-slate-line")!), "content still updates").toContain("Sun 10:00");
  });

  it("unmounting mid-fade clears its timer (no leaked setTimeout)", () => {
    vi.useFakeTimers();
    const island = render({ ...BASE_MODEL, live: false, decided: false, voided: false });
    island.rerender({
      model: { ...BASE_MODEL, live: false, decided: true, voided: false },
      tick: [false, false],
      msg: msgOf("en"),
      sportKey: "football",
    });
    expect(vi.getTimerCount(), "one timer armed mid-fade").toBe(1);
    island.unmount();
    expect(vi.getTimerCount(), "cleanup ran").toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Completeness, beneath the reachability checks above. Four of the five keys
// are now referenced by `overlay-slate.tsx` and so are covered by
// `overlay-dict-coverage.test.ts`'s source scan as well; the two
// `signalLost*` keys are NOT referenced anywhere (gap 3 — the `<video>` seam
// is B3's, not this wave's) and that scan is one-directional, so their
// presence is only asserted here.
// ---------------------------------------------------------------------------
describe("public.overlay.slate.* — present in all four locales", () => {
  const KEYS = [
    "overlay.slate.warmingHeadline",
    "overlay.slate.warmingLine",
    "overlay.slate.signalLostHeadline",
    "overlay.slate.signalLostLine",
    "overlay.slate.endedHeadline",
  ] as const;

  it.each(LOCALES)("%s/public.json carries all five slate keys as non-empty strings", (locale) => {
    const dict = JSON.parse(readFileSync(join(DICT, locale, "public.json"), "utf8")) as Record<string, unknown>;
    for (const key of KEYS) {
      expect(typeof dict[key], `${locale} missing ${key}`).toBe("string");
      expect((dict[key] as string).length, `${locale} ${key} is empty`).toBeGreaterThan(0);
    }
  });

  it("en's three headlines are upper case, as §4a requires ('as written in the dictionary')", () => {
    const en = JSON.parse(readFileSync(join(DICT, "en", "public.json"), "utf8")) as Record<string, string>;
    for (const key of ["overlay.slate.warmingHeadline", "overlay.slate.signalLostHeadline", "overlay.slate.endedHeadline"]) {
      expect(en[key], key).toBe(en[key]!.toUpperCase());
    }
  });

  it.each(LOCALES)("%s/ui.json carries stream.tab.slate — this one IS wired (theme-registry.ts's labelKey)", (locale) => {
    const dict = JSON.parse(readFileSync(join(DICT, locale, "ui.json"), "utf8")) as Record<string, unknown>;
    expect(typeof dict["stream.tab.slate"], `${locale} missing stream.tab.slate`).toBe("string");
  });
});
