// Registration redesign B2 T7 (spec §7.1, owner decision: stepper S1) — the step rail has two faces on ONE DOM: below `md` a
// header block ("Step n of total", "Next: …", the step's name, a progress bar), from `md` the numbered bar it always was, whose
// finished steps are now buttons. Rendered by calling the component directly (it holds no state of its own) with `useT` bound to
// the REAL English dictionary, so the sentences read here are the ones a person reads — and, as in the other register suites,
// the markup is also rendered statically for the class contract, which is the only place a CSS-only fold can be pinned in a
// workspace with no DOM.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { propsOf, textOf, walk } from "@/components/__tests__/_hook-harness";
import type { Dict } from "@/lib/i18n-constants";
import { t as tRuntime } from "@/lib/i18n-runtime";
import { compileClasses } from "@/components/v2/__tests__/_compiled-css";
import { StepNav } from "../step-nav";
import { buildStepOrder } from "../steps";
import type { StepId } from "../types";

const EN_UI: Dict = JSON.parse(
  readFileSync(join(__dirname, "..", "..", "..", "..", "dictionaries", "en", "ui.json"), "utf8"),
) as Dict;

vi.mock("@/components/i18n/dict-provider", () => ({
  useT: () => (key: string, vars?: Record<string, string | number>) => tRuntime(EN_UI, key, vars),
}));

/** What a person reads for each step — the owner-approved names (the first one is "Contact", not the old "Who"). */
const NAME: Record<StepId, string> = {
  who: "Contact",
  entries: "Entries",
  details: "Details",
  consent: "Consent",
  review: "Review",
};

// BOTH real orders, from the real builder (never typed here): 5 steps normally, 4 when the lone open division is an individual
// one and the Entries step collapses away (spec FP7 — "of 5" is never a constant).
const FIVE = buildStepOrder(2, "individual");
const FOUR = buildStepOrder(1, "individual");
const ORDERS = [
  { label: "5-step", order: FIVE },
  { label: "4-step (Entries collapsed)", order: FOUR },
];

/** The two faces: `phone` is the header block, `bar` the numbered <ol>. Reading them off the returned fragment, by element type,
 *  fails loudly if either goes missing instead of silently asserting on the other. */
function faces(order: readonly StepId[], currentIndex: number, onJump?: (i: number) => void) {
  const parts = walk(StepNav({ order, currentIndex, onJump }));
  const bar = parts.find((e) => e.type === "ol");
  const phone = parts.find((e) => e.type === "div" && walk(e).some((c) => propsOf(c).role === "progressbar"));
  expect(bar, "the numbered <ol> is not rendered").toBeTruthy();
  expect(phone, "the phone header block is not rendered").toBeTruthy();
  const progress = walk(phone!).find((e) => propsOf(e).role === "progressbar")!;
  return { bar: bar!, phone: phone!, progress };
}

describe("premises — the two real orders", () => {
  it("5 steps with Entries, 4 without — read off the builder, not assumed", () => {
    expect(FIVE).toHaveLength(5);
    expect(FOUR).toHaveLength(4);
    expect(FOUR).not.toContain("entries");
  });
});

describe("StepNav — empty case", () => {
  it("an empty step order renders nothing (there is no 'step 1 of 0')", () => {
    expect(StepNav({ order: [], currentIndex: 0 })).toBeNull();
  });
});

describe("StepNav — the phone header (below md)", () => {
  it("on Entries of the 5-step order: 'Step 2 of 5', 'Next: Details', and the step's own name", () => {
    const { phone } = faces(FIVE, 1);
    const text = textOf(phone);
    expect(text).toContain("Step 2 of 5");
    expect(text).toContain("Next: Details");
    expect(text).toContain("Entries");
  });

  it("on Details of the 4-step order: 'Step 2 of 4' (the total follows the order — it is not a constant 5)", () => {
    const { phone } = faces(FOUR, 1);
    const text = textOf(phone);
    expect(FOUR[1]).toBe("details"); // premise: index 1 of the collapsed order IS Details
    expect(text).toContain("Step 2 of 4");
    expect(text).not.toContain("of 5");
    expect(text).toContain("Next: Consent");
  });

  it("on the last step it says 'Last step', and does not offer a 'Next:' that points nowhere", () => {
    for (const { label, order } of ORDERS) {
      const text = textOf(faces(order, order.length - 1).phone);
      expect(text, label).toContain("Last step");
      expect(text, label).not.toContain("Next:");
      expect(text, label).toContain(`Step ${order.length} of ${order.length}`);
    }
  });

  it("every position of both orders: its own count, its own name, and the step AFTER it (or 'Last step')", () => {
    let checked = 0;
    for (const { label, order } of ORDERS) {
      order.forEach((step, i) => {
        const text = textOf(faces(order, i).phone);
        expect(text, `${label} #${i}`).toContain(`Step ${i + 1} of ${order.length}`);
        expect(text, `${label} #${i}`).toContain(NAME[step]);
        const after = order[i + 1];
        if (after) expect(text, `${label} #${i}`).toContain(`Next: ${NAME[after]}`);
        else expect(text, `${label} #${i}`).toContain("Last step");
        checked++;
      });
    }
    expect(checked, "anti-vacuity: 5 + 4 positions").toBe(FIVE.length + FOUR.length);
  });

  it("the first step reads 'Contact', not the old 'Who' — on the phone header and on the bar", () => {
    const first = faces(FIVE, 0);
    expect(textOf(first.phone)).toContain("Contact");
    expect(textOf(first.bar)).toContain("Contact");
    for (const text of [textOf(first.phone), textOf(first.bar), textOf(faces(FIVE, 2).bar)]) expect(text).not.toMatch(/\bWho\b/);
  });

  it("the progress bar: role, 1..total, now = position, and a spoken value that names the step", () => {
    let checked = 0;
    for (const { label, order } of ORDERS) {
      order.forEach((step, i) => {
        const p = propsOf(faces(order, i).progress);
        expect(p["aria-valuemin"], `${label} #${i}`).toBe(1);
        expect(p["aria-valuemax"], `${label} #${i}`).toBe(order.length);
        expect(p["aria-valuenow"], `${label} #${i}`).toBe(i + 1);
        expect(p["aria-valuetext"], `${label} #${i}`).toBe(`Step ${i + 1} of ${order.length}, ${NAME[step]}`);
        expect(String(p["aria-label"] ?? "").length, `${label} #${i}: a progressbar needs a name`).toBeGreaterThan(0);
        checked++;
      });
    }
    expect(checked).toBe(FIVE.length + FOUR.length);
  });

  it("the bar is filled to n/total of its track", () => {
    const fill = (order: readonly StepId[], i: number) => {
      const inner = walk(faces(order, i).progress).find((e) => (propsOf(e).style as { width?: string } | undefined)?.width);
      expect(inner, "no filled part inside the progress bar").toBeTruthy();
      return (propsOf(inner!).style as { width: string }).width;
    };
    expect([0, 1, 2, 3, 4].map((i) => fill(FIVE, i))).toEqual(["20%", "40%", "60%", "80%", "100%"]);
    expect([0, 1, 2, 3].map((i) => fill(FOUR, i))).toEqual(["25%", "50%", "75%", "100%"]);
  });

  it("nothing in the phone header is a button: finished steps are only jumpable from md up", () => {
    const { phone } = faces(FIVE, 3, vi.fn());
    expect(walk(phone).filter((e) => e.type === "button")).toHaveLength(0);
  });
});

describe("StepNav — the numbered bar (md and up)", () => {
  /** The <li>s of the bar, in step order. */
  const items = (bar: ReactElement) => walk(bar).filter((e) => e.type === "li");
  const buttonsIn = (li: ReactElement) => walk(li).filter((e) => e.type === "button");

  it("a finished step is a button that jumps to ITS index; the current and upcoming steps are not buttons", () => {
    let checked = 0;
    for (const { label, order } of ORDERS) {
      for (let at = 0; at < order.length; at++) {
        const onJump = vi.fn();
        const lis = items(faces(order, at, onJump).bar);
        expect(lis, `${label} @${at}`).toHaveLength(order.length);
        lis.forEach((li, i) => {
          const buttons = buttonsIn(li);
          if (i < at) {
            expect(buttons, `${label} @${at}: step ${i} is finished`).toHaveLength(1);
            expect(textOf(buttons[0]!), `${label} @${at}: step ${i}`).toContain(NAME[order[i]!]);
            onJump.mockClear();
            (propsOf(buttons[0]!).onClick as () => void)();
            expect(onJump, `${label} @${at}: step ${i}`).toHaveBeenCalledTimes(1);
            expect(onJump, `${label} @${at}: step ${i}`).toHaveBeenCalledWith(i);
          } else {
            expect(buttons, `${label} @${at}: step ${i} is ${i === at ? "current" : "upcoming"}`).toHaveLength(0);
          }
          checked++;
        });
      }
    }
    expect(checked, "anti-vacuity: every li at every position").toBe(FIVE.length ** 2 + FOUR.length ** 2);
  });

  // B2 review m7: the numbered bar shows which step is current with colour alone; a screen reader reads a plain list of five names.
  it("exactly the current step's <li> carries aria-current=\"step\", at every position of both orders, and no other does", () => {
    let checked = 0;
    for (const { label, order } of ORDERS) {
      for (let at = 0; at < order.length; at++) {
        const lis = items(faces(order, at, vi.fn()).bar);
        expect(lis, `${label} @${at}`).toHaveLength(order.length);
        lis.forEach((li, i) => {
          expect(propsOf(li)["aria-current"], `${label} @${at}: step ${i} (${i === at ? "current" : i < at ? "finished" : "upcoming"})`).toBe(i === at ? "step" : undefined);
          checked++;
        });
      }
    }
    expect(checked, "anti-vacuity: every li at every position").toBe(FIVE.length ** 2 + FOUR.length ** 2);
  });

  it("the first step has nothing finished before it, so the bar there has no button at all", () => {
    expect(walk(faces(FIVE, 0, vi.fn()).bar).filter((e) => e.type === "button")).toHaveLength(0);
  });

  it("with no onJump a finished step is plain text — a button that does nothing would be an inert control", () => {
    const { bar } = faces(FIVE, 3);
    expect(walk(bar).filter((e) => e.type === "button")).toHaveLength(0);
    expect(textOf(bar)).toContain("Contact");
  });

  it("a finished step is a type=button (inside the stepper it must never submit anything)", () => {
    const button = walk(faces(FIVE, 2, vi.fn()).bar).find((e) => e.type === "button")!;
    expect(propsOf(button).type).toBe("button");
  });

  it("the bar still names every step, in order, whatever the position", () => {
    const text = textOf(faces(FIVE, 2).bar);
    const at = FIVE.map((s) => text.indexOf(NAME[s]));
    expect(at.every((i) => i >= 0)).toBe(true);
    expect([...at].sort((a, b) => a - b)).toEqual(at);
  });
});

describe("StepNav — one DOM, two faces (class contract; vitest here has no DOM)", () => {
  // Compared as WHOLE class tokens, not by pattern: `/\bmd:hidden\b/` also matches INSIDE `max-md:hidden`, so a bare pattern
  // passes on its own inversion (AGENTS.md, phone composition). A token is either exactly `md:hidden` or it is not.
  const tokens = (el: ReactElement): string[] => String(propsOf(el).className ?? "").split(/\s+/).filter(Boolean);

  it("the phone header is `md:hidden` — shown below md, gone from md up — and is not also `max-md:hidden`", () => {
    const { phone } = faces(FIVE, 1);
    expect(tokens(phone)).toContain("md:hidden");
    expect(tokens(phone)).not.toContain("max-md:hidden");
  });

  it("the numbered bar is `max-md:hidden` — gone below md, shown from md up — and is not also `md:hidden`", () => {
    const { bar } = faces(FIVE, 1);
    expect(tokens(bar)).toContain("max-md:hidden");
    expect(tokens(bar)).not.toContain("md:hidden");
  });

  it("they are the only two things hidden by breakpoint in the whole rail (one DOM, no third tree)", () => {
    const all = walk(StepNav({ order: FIVE, currentIndex: 1, onJump: () => {} }));
    const hiders = all.flatMap(tokens).filter((c) => c === "md:hidden" || c === "max-md:hidden");
    expect(hiders.sort()).toEqual(["max-md:hidden", "md:hidden"]);
  });

  it("the markup agrees with the element tree (the static render carries both classes, once each, on different elements)", () => {
    const html = renderToStaticMarkup(<StepNav order={FIVE} currentIndex={1} onJump={() => {}} />);
    const classes = [...html.matchAll(/\bclass="([^"]*)"/g)].map((m) => m[1]!.split(/\s+/));
    expect(classes.filter((c) => c.includes("md:hidden"))).toHaveLength(1);
    expect(classes.filter((c) => c.includes("max-md:hidden"))).toHaveLength(1);
  });
});

describe("StepNav — every utility it uses is a real one", () => {
  // A class Tailwind does not know compiles to NOTHING and the element silently loses that rule (the offset that keeps the focus ring
  // inside the bar's `overflow-hidden`, the breakpoint hide, the reduced-motion opt-out). Read through the repo's own pipeline.
  it("each class on the rail compiles to at least one declaration", async () => {
    const all = walk(StepNav({ order: FIVE, currentIndex: 2, onJump: () => {} }));
    const classes = [...new Set(all.flatMap((e) => String(propsOf(e).className ?? "").split(/\s+/)).filter(Boolean))];
    expect(classes.length, "anti-vacuity: the rail has classes").toBeGreaterThan(20);
    for (const must of ["md:hidden", "max-md:hidden", "focus-visible:-outline-offset-2", "motion-reduce:transition-none", "transition-[width]"]) {
      expect(classes, `the rail uses ${must}`).toContain(must);
    }
    const compiled = await compileClasses(classes);
    const empty = classes.filter((c) => Object.keys(compiled.get(c) ?? {}).length === 0);
    expect(empty, "classes that compile to nothing").toEqual([]);
  }, 60_000);
});
