// Match / end card layer (2026-09-12) — not a ?style= theme.
// Spec: docs/superpowers/specs/2026-09-12-overlay-match-card-layer-design.md
//
// `apps/web` vitest is `environment: "node"` — no DOM. This proves the
// ELEMENT TREE and the STATE MACHINE `OverlayMatchCard` produces.
// Driven through `renderIsland` (_hook-harness.tsx).
import { afterEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { isValidElement, type ReactElement, type ReactNode } from "react";
import { propsOf, renderIsland, textOf } from "@/components/__tests__/_hook-harness";
import { OverlayMatchCard, OverlaySlate, slateStateOf } from "../overlay-slate";
import type { OverlayThemeProps } from "../theme-registry";
import { t } from "@/lib/i18n-runtime";
import { nameLadder, type OverlayModel, type OverlayMsg } from "@/lib/overlay-model";

const HERE = dirname(fileURLToPath(import.meta.url));
const DICT = join(HERE, "../../../dictionaries");
const LOCALES = ["en", "fr", "es", "nl"] as const;

const dictOf = (locale: string): Record<string, string> =>
  JSON.parse(readFileSync(join(DICT, locale, "public.json"), "utf8"));

/** The REAL `msg` an overlay theme receives — `t()` over the real, on-disk
 *  dictionary for that locale, which is exactly what `overlay-stage.tsx`
 *  builds (`(key, vars) => t(props.dict, key, vars)`). */
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
    { short: "MIL", name: "Milton Keynes Rovers", ladder: nameLadder({ id: "x", name: "Milton Keynes Rovers" }), big: "2", led: false, serving: false },
    { short: "NOR", name: "Northbridge Athletic", ladder: nameLadder({ id: "x", name: "Northbridge Athletic" }), big: "1", led: true, serving: false },
  ],
  cellsKind: "none",
  cells: [],
  detail: [],
};

function classesOf(el: ReactElement): string {
  return (propsOf(el).className as string | undefined) ?? "";
}

function expand(node: ReactNode, out: ReactElement[] = []): ReactElement[] {
  if (Array.isArray(node)) {
    for (const child of node) expand(child, out);
    return out;
  }
  if (!isValidElement(node)) return out;
  out.push(node);
  return expand((node.props as { children?: ReactNode }).children, out);
}

function render(
  model: OverlayModel,
  { locale = "en" }: { locale?: string } = {},
) {
  return renderIsland(OverlayMatchCard, { model, msg: msgOf(locale) }, expand);
}

const byTestId = (tree: ReactElement[], id: string) => tree.find((el) => propsOf(el)["data-testid"] === id);

afterEach(() => {
  vi.useRealTimers();
});

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
    expect(slateStateOf({ ...BASE_MODEL, live: true, decided: true, voided: false })).toBe("ended");
  });
});

describe("OverlayMatchCard — card-only layer (no nested scorebug)", () => {
  it.each<[string, OverlayModel]>([
    ["warming", { ...BASE_MODEL, live: false, decided: false, voided: false }],
    ["ended (decided)", { ...BASE_MODEL, live: false, decided: true, result: "Milton Keynes Rovers won by 44 runs" }],
    ["ended (voided, no verdict)", { ...BASE_MODEL, live: false, decided: false, voided: true }],
  ])("%s: .ovl-slate, brand, and card mount — never ovl-bar / ovl-bug", (_label, model) => {
    const tree = render(model).tree();
    expect(tree.some((el) => classesOf(el) === "ovl-slate"), "root").toBe(true);
    const brand = tree.find((el) => classesOf(el).includes("ovl-slate-brand"));
    expect(brand, "brand").toBeDefined();
    expect(textOf(brand!)).toBe("seazn");
    expect(byTestId(tree, "ovl-slate-card"), "card").toBeDefined();
    expect(
      tree.some((el) => classesOf(el).split(" ").includes("ovl-bar")),
      "no nested bar",
    ).toBe(false);
    expect(
      tree.some((el) => classesOf(el).split(" ").includes("ovl-bug")),
      "no nested bug",
    ).toBe(false);
  });

  it("live ⇒ null (stage owns when to mount; card does not paint an empty root)", () => {
    const tree = render({ ...BASE_MODEL, live: true, decided: false, voided: false }).tree();
    expect(tree.length).toBe(0);
    expect(byTestId(tree, "ovl-slate-card")).toBeUndefined();
  });

  it("OverlaySlate alias still points at OverlayMatchCard", () => {
    expect(OverlaySlate).toBe(OverlayMatchCard);
  });

  it("fix round 5, I5 — the brand is RESOLVED, not a hardcoded literal", () => {
    const keyMsg: OverlayMsg = (key) => key;
    const tree = renderIsland(
      OverlayMatchCard,
      { model: { ...BASE_MODEL, live: false }, msg: keyMsg },
      expand,
    ).tree();
    const brand = tree.find((el) => classesOf(el).includes("ovl-slate-brand"));
    expect(textOf(brand!), "card resolves the wordmark through the dictionary channel").toBe(
      "overlay.brand",
    );
    expect(textOf(brand!)).not.toBe("seazn");
  });
});

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
  header: { context: "", period: "MIL won" },
  result: "Milton Keynes Rovers won by 44 runs",
};

describe("OverlayMatchCard — headline/line per state, resolved through `msg`", () => {
  it("warming: headline is Home vs Away; line is toss-pending + start (A1, 2026-09-12)", () => {
    const en = dictOf("en");
    const tree = render(WARMING).tree();
    expect(textOf(byTestId(tree, "ovl-slate-headline")!)).toBe(
      t(en, "overlay.slate.warmingHeadlineVs", {
        home: "Milton Keynes Rovers",
        away: "Northbridge Athletic",
      }),
    );
    expect(textOf(byTestId(tree, "ovl-slate-line")!)).toBe(
      t(en, "overlay.slate.warmingLineTossPending", {
        start: "Sat 14:30 BST",
      }),
    );
    const dots = byTestId(tree, "ovl-slate-indicator-warming");
    expect(dots, "warming indicator").toBeDefined();
    const children = propsOf(dots!).children;
    expect(Array.isArray(children) ? children.length : 0, "three dots").toBe(3);
  });

  it("warming: every {var} in the templates is supplied — no literal placeholder survives to screen", () => {
    const tree = render(WARMING).tree();
    const headline = textOf(byTestId(tree, "ovl-slate-headline")!);
    const line = textOf(byTestId(tree, "ovl-slate-line")!);
    expect(headline, "an unsupplied var renders as `{name}`").not.toMatch(/\{[a-z]+\}/i);
    expect(line, "an unsupplied var renders as `{name}`").not.toMatch(/\{[a-z]+\}/i);
    expect(headline).toContain("Milton Keynes Rovers");
    expect(headline).toContain("Northbridge Athletic");
    expect(line).toContain("Sat 14:30 BST");
  });

  it("ended: headline is model.result (result card); matchup tiles carry scores", () => {
    const tree = render(ENDED).tree();
    expect(textOf(byTestId(tree, "ovl-slate-headline")!)).toBe("Milton Keynes Rovers won by 44 runs");
    expect(byTestId(tree, "ovl-slate-line"), "ended card has no toss line").toBeUndefined();
    expect(byTestId(tree, "ovl-slate-indicator-warming"), "no warming dots once ended").toBeUndefined();
    expect(textOf(byTestId(tree, "ovl-slate-vs")!)).toBe("vs");
    expect(textOf(byTestId(tree, "ovl-slate-tile-0")!)).toContain("MIL");
    expect(textOf(byTestId(tree, "ovl-slate-tile-0")!)).toContain("2");
    expect(textOf(byTestId(tree, "ovl-slate-tile-1")!)).toContain("NOR");
  });

  it("ended (voided, no verdict): headline falls back to endedHeadline; NO fabricated result line", () => {
    const en = dictOf("en");
    const model: OverlayModel = { ...BASE_MODEL, live: false, decided: false, voided: true, header: { context: "Cancelled" } };
    const tree = render(model).tree();
    expect(textOf(byTestId(tree, "ovl-slate-headline")!)).toBe(en["overlay.slate.endedHeadline"]);
    expect(byTestId(tree, "ovl-slate-line"), "no invented line").toBeUndefined();
  });

  it("warming: matchup tiles show codes without scores", () => {
    const tree = render(WARMING).tree();
    expect(textOf(byTestId(tree, "ovl-slate-pill")!)).toContain(dictOf("en")["overlay.slate.pillUpcoming"]);
    expect(textOf(byTestId(tree, "ovl-slate-tile-0")!)).toBe("MIL");
    expect(textOf(byTestId(tree, "ovl-slate-name-0")!)).toBe("Milton Keynes Rovers");
    expect(textOf(byTestId(tree, "ovl-slate-vs")!)).toBe("vs");
  });

  it("live renders nothing — no content / headline / line", () => {
    const tree = render({ ...BASE_MODEL, live: true, decided: false, voided: false }).tree();
    expect(byTestId(tree, "ovl-slate-content")).toBeUndefined();
    expect(byTestId(tree, "ovl-slate-headline")).toBeUndefined();
    expect(byTestId(tree, "ovl-slate-line")).toBeUndefined();
  });
});

describe("public.overlay.slate.* actually reaches the screen, in every locale", () => {
  it.each(LOCALES)("%s: the warming headline IS that locale's interpolated vs template", (locale) => {
    const dict = dictOf(locale);
    const tree = render(WARMING, { locale }).tree();
    expect(textOf(byTestId(tree, "ovl-slate-headline")!)).toBe(
      t(dict, "overlay.slate.warmingHeadlineVs", {
        home: "Milton Keynes Rovers",
        away: "Northbridge Athletic",
      }),
    );
  });

  it.each(LOCALES)("%s: the voided ended headline IS that locale's own dictionary value", (locale) => {
    const voided: OverlayModel = {
      ...BASE_MODEL,
      live: false,
      decided: false,
      voided: true,
      header: { context: "Cancelled" },
    };
    const tree = render(voided, { locale }).tree();
    expect(textOf(byTestId(tree, "ovl-slate-headline")!)).toBe(dictOf(locale)["overlay.slate.endedHeadline"]);
  });

  it("en and fr render DIFFERENT words — the differential a hardcoded English string cannot satisfy", () => {
    const headline = (locale: string, model: OverlayModel) =>
      textOf(byTestId(render(model, { locale }).tree(), "ovl-slate-headline")!);
    const voided: OverlayModel = {
      ...BASE_MODEL,
      live: false,
      decided: false,
      voided: true,
      header: { context: "Cancelled" },
    };
    expect(dictOf("en")["overlay.slate.warmingHeadlineVs"]).not.toBe(dictOf("fr")["overlay.slate.warmingHeadlineVs"]);
    expect(dictOf("en")["overlay.slate.endedHeadline"]).not.toBe(dictOf("fr")["overlay.slate.endedHeadline"]);
    expect(headline("en", WARMING)).not.toBe(headline("fr", WARMING));
    expect(headline("en", voided)).not.toBe(headline("fr", voided));
  });

  it("nothing renders a raw dictionary KEY — a `t()` miss returns the key itself and would slip past a bare toBeDefined", () => {
    for (const model of [WARMING, ENDED]) {
      for (const locale of LOCALES) {
        const tree = render(model, { locale }).tree();
        const content = byTestId(tree, "ovl-slate-content");
        expect(textOf(content!), `${locale}`).not.toMatch(/overlay\.slate\./);
      }
    }
  });
});

describe("OverlayMatchCard — the state-swap cross-fade", () => {
  const themeProps = (model: OverlayModel): Pick<OverlayThemeProps, "model" | "msg"> => ({
    model,
    msg: msgOf("en"),
  });

  it("never fades on mount", () => {
    vi.useFakeTimers();
    const tree = render({ ...BASE_MODEL, live: false, decided: false, voided: false }).tree();
    expect(classesOf(byTestId(tree, "ovl-slate-content")!)).not.toContain("ovl-slate-fading");
  });

  it("fades for exactly 250ms on a genuine state change, then clears", () => {
    vi.useFakeTimers();
    const island = render({ ...BASE_MODEL, live: false, decided: false, voided: false });
    island.rerender(
      themeProps({ ...BASE_MODEL, live: false, decided: true, voided: false, result: "X won" }),
    );
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
    island.rerender(themeProps({ ...model, header: { context: "Sun 10:00" } }));
    const tree = island.tree();
    expect(classesOf(byTestId(tree, "ovl-slate-content")!), "same state: no fade").not.toContain("ovl-slate-fading");
    expect(textOf(byTestId(tree, "ovl-slate-line")!), "content still updates").toContain("Sun 10:00");
  });

  it("unmounting mid-fade clears its timer (no leaked setTimeout)", () => {
    vi.useFakeTimers();
    const island = render({ ...BASE_MODEL, live: false, decided: false, voided: false });
    island.rerender(themeProps({ ...BASE_MODEL, live: false, decided: true, voided: false }));
    expect(vi.getTimerCount(), "one timer armed mid-fade").toBe(1);
    island.unmount();
    expect(vi.getTimerCount(), "cleanup ran").toBe(0);
  });
});

describe("public.overlay.slate.* — present in all four locales", () => {
  const KEYS = [
    "overlay.slate.warmingHeadlineVs",
    "overlay.slate.warmingLineTossPending",
    "overlay.slate.signalLostHeadline",
    "overlay.slate.signalLostLine",
    "overlay.slate.endedHeadline",
  ] as const;

  it.each(LOCALES)("%s/public.json carries all slate keys as non-empty strings", (locale) => {
    const dict = JSON.parse(readFileSync(join(DICT, locale, "public.json"), "utf8")) as Record<string, unknown>;
    for (const key of KEYS) {
      expect(typeof dict[key], `${locale} missing ${key}`).toBe("string");
      expect((dict[key] as string).length, `${locale} ${key} is empty`).toBeGreaterThan(0);
    }
  });

  it("en's status headlines are upper case, as §4a requires ('as written in the dictionary')", () => {
    const en = JSON.parse(readFileSync(join(DICT, "en", "public.json"), "utf8")) as Record<string, string>;
    for (const key of ["overlay.slate.signalLostHeadline", "overlay.slate.endedHeadline"]) {
      expect(en[key], key).toBe(en[key]!.toUpperCase());
    }
  });
});
