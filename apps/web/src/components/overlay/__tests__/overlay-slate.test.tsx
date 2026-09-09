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
import { OverlayBug } from "../overlay-bug";
import type { OverlayModel } from "@/lib/overlay-model";

const HERE = dirname(fileURLToPath(import.meta.url));
const DICT = join(HERE, "../../../dictionaries");
const LOCALES = ["en", "fr", "es", "nl"] as const;

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

/**
 * `OverlaySlate` embeds `<OverlayBug model={model} tick={tick} />` as JSX
 * (§4a: "the selected theme … renders ON TOP"), not as a called function —
 * `walk`'s default behaviour reads only `.props.children`, so it treats that
 * element as opaque and never descends into what `OverlayBug` itself
 * renders. This expands it — hookless, so calling it directly is a real,
 * non-mocked render, the same shape decided-void-and-cells.test.tsx uses at
 * the top level; here it happens one level deeper because OverlaySlate
 * embeds it rather than calling it.
 */
function expand(node: ReactNode, out: ReactElement[] = []): ReactElement[] {
  if (Array.isArray(node)) {
    for (const child of node) expand(child, out);
    return out;
  }
  if (!isValidElement(node)) return out;
  out.push(node);
  if (node.type === OverlayBug) {
    return expand(OverlayBug(node.props as { model: OverlayModel; tick: [boolean, boolean] }), out);
  }
  return expand((node.props as { children?: ReactNode }).children, out);
}

function render(model: OverlayModel, tick: [boolean, boolean] = [false, false]) {
  return renderIsland(OverlaySlate, { model, tick }, expand);
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
  ])("%s: .ovl-slate, .ovl-slate-brand ('seazn'), and OverlayBug's .ovl-bug all mount", (_label, model) => {
    const tree = render(model).tree();
    expect(tree.some((el) => classesOf(el) === "ovl-slate"), "root").toBe(true);
    const brand = tree.find((el) => classesOf(el).includes("ovl-slate-brand"));
    expect(brand, "brand").toBeDefined();
    expect(textOf(brand!)).toBe("seazn");
    const bug = tree.find((el) => classesOf(el).split(" ").includes("ovl-bug"));
    expect(bug, "the composited scorebug (always OverlayBug — gap 2)").toBeDefined();
  });

  it("the composited OverlayBug actually reflects THIS model, not a stale/default one", () => {
    // Differential: two different models must produce two different scores in
    // the nested bug, proving `model`/`tick` really do reach it.
    const a = render({ ...BASE_MODEL, live: true, decided: false, voided: false }).tree();
    const b = render({
      ...BASE_MODEL,
      live: true,
      decided: false,
      voided: false,
      sides: [{ ...BASE_MODEL.sides[0], big: "9" }, BASE_MODEL.sides[1]],
    }).tree();
    const scoreA = byTestId(a, "ovl-big-home");
    const scoreB = byTestId(b, "ovl-big-home");
    expect(textOf(scoreA!)).toBe("2");
    expect(textOf(scoreB!)).toBe("9");
    expect(textOf(scoreA!)).not.toBe(textOf(scoreB!));
  });
});

// ---------------------------------------------------------------------------
// Headline / line per state — mutated per member of the union.
// ---------------------------------------------------------------------------
describe("OverlaySlate — headline/line per state", () => {
  it("warming: headline is the model's own (already-localized) start/status text; line is the two team names; three-dot indicator mounts", () => {
    const model: OverlayModel = { ...BASE_MODEL, live: false, decided: false, voided: false, header: { context: "Sat 14:30" } };
    const tree = render(model).tree();
    expect(textOf(byTestId(tree, "ovl-slate-headline")!)).toBe("Sat 14:30");
    const line = byTestId(tree, "ovl-slate-line");
    expect(textOf(line!)).toBe("Milton Keynes Rovers · Northbridge Athletic");
    const dots = byTestId(tree, "ovl-slate-indicator-warming");
    expect(dots, "warming indicator").toBeDefined();
    const children = propsOf(dots!).children;
    expect(Array.isArray(children) ? children.length : 0, "three dots").toBe(3);
  });

  it("ended (decided): headline is the model's own status word; line is model.result — zero deviation from §4a's own producer there", () => {
    const model: OverlayModel = {
      ...BASE_MODEL,
      live: false,
      decided: true,
      voided: false,
      header: { context: "Final" },
      result: "Milton Keynes Rovers won by 44 runs",
    };
    const tree = render(model).tree();
    expect(textOf(byTestId(tree, "ovl-slate-headline")!)).toBe("Final");
    expect(textOf(byTestId(tree, "ovl-slate-line")!)).toBe("Milton Keynes Rovers won by 44 runs");
    expect(byTestId(tree, "ovl-slate-indicator-warming"), "no warming dots once ended").toBeUndefined();
  });

  it("ended (voided, no verdict): headline still shows the status word; NO line is fabricated for a null resultMsg", () => {
    const model: OverlayModel = { ...BASE_MODEL, live: false, decided: false, voided: true, header: { context: "Cancelled" } };
    const tree = render(model).tree();
    expect(textOf(byTestId(tree, "ovl-slate-headline")!)).toBe("Cancelled");
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
    island.rerender({ model: { ...model, header: { context: "Sun 10:00" } }, tick: [false, false] });
    const tree = island.tree();
    expect(classesOf(byTestId(tree, "ovl-slate-content")!), "same state: no fade").not.toContain("ovl-slate-fading");
    expect(textOf(byTestId(tree, "ovl-slate-headline")!), "content still updates").toBe("Sun 10:00");
  });

  it("unmounting mid-fade clears its timer (no leaked setTimeout)", () => {
    vi.useFakeTimers();
    const island = render({ ...BASE_MODEL, live: false, decided: false, voided: false });
    island.rerender({ model: { ...BASE_MODEL, live: false, decided: true, voided: false }, tick: [false, false] });
    expect(vi.getTimerCount(), "one timer armed mid-fade").toBe(1);
    island.unmount();
    expect(vi.getTimerCount(), "cleanup ran").toBe(0);
  });
});

// ---------------------------------------------------------------------------
// The dictionary keys the brief requires regardless of reachability (gap 1):
// added in all four locales even though nothing in overlay-slate.tsx can
// resolve them yet. A direct completeness check, since the source-literal
// scan in overlay-dict-coverage.test.ts is one-directional (referenced ⇒
// must exist) and these keys are deliberately NOT referenced anywhere.
// ---------------------------------------------------------------------------
describe("public.overlay.slate.* — present in all four locales ahead of the msg/dict channel that would consume them", () => {
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
