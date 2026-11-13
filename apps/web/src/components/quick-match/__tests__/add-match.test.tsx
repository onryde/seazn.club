// Quick match plan 2, Task 8: the home's "Add a match" control, `QuickMatchAddMatch` (a client island). No DOM here (vitest
// `environment: "node"`): the island is driven through the no-DOM `renderIsland` harness, its handlers called as a browser
// calls them. What the post does (the 303, the new match, every refusal) is the route's test
// (app/q/[token]/__tests__/add-match-route.test.ts); what a browser shows is the e2e (e2e/quick-match-home.spec.ts) and the
// walkthrough (e2e/walkthrough/quick-match.spec.ts, step 7).
//
// The contract:
//   - collapsed behind "+ Add a match", a native `<details>`: one tap opens it, with or without the script;
//   - a real `<form method="post" action>` with two selects, `home` and `away`, each listing every side in the order the
//     guest typed them and opening at the two the page picked; each select named by its visible label;
//   - with the script, the first submit goes through and every later one is cancelled until the page comes back from the
//     back-forward cache: an add is NOT idempotent (a double tap would add two matches), so the lock matters here more
//     than on Score. The button is never `disabled` (that can cancel the very post it started); busy is `aria-disabled`;
//   - the form carries `ph-no-capture` (its action holds the home token, O3); every control is a 44px target, and a long
//     side name never widens the page (the selects are `w-full min-w-0`).
//
// Sport: not applicable (the control posts two ids; it knows no sport).
import type { ReactElement } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { propsOf, renderIsland, textOf } from "@/components/__tests__/_hook-harness";
import { QuickMatchAddMatch, type QuickMatchAddMatchProps } from "../add-match";

const ACTION = "/q/qm_AbCdEfGhIjKlMnOpQrStUvWxYz0123456789-_abcde/add-match";
const SIDES = [
  { id: "00000000-0000-4000-8000-000000000001", name: "The Extraordinarily Long-Named Doubles Pair" },
  { id: "00000000-0000-4000-8000-000000000002", name: "Priya & Tom" },
  { id: "00000000-0000-4000-8000-000000000003", name: "Lee & Ana" },
];
const LABELS = { open: "+ Add a match", home: "First side", away: "Second side", submit: "Add the match" };

const props = (over: Partial<QuickMatchAddMatchProps> = {}): QuickMatchAddMatchProps => ({
  action: ACTION,
  sides: SIDES,
  home: SIDES[1]!.id,
  away: SIDES[2]!.id,
  labels: LABELS,
  ...over,
});
type Island = ReturnType<typeof renderIsland<QuickMatchAddMatchProps>>;
const mount = (over: Partial<QuickMatchAddMatchProps> = {}): Island => renderIsland(QuickMatchAddMatch, props(over));

const only = (i: Island, type: string): ReactElement => {
  const els = i.tree().filter((el) => el.type === type);
  expect(els, `exactly one <${type}>`).toHaveLength(1);
  return els[0]!;
};
const classOf = (el: ReactElement) => String(propsOf(el).className ?? "").split(/\s+/);
const selects = (i: Island) => i.tree().filter((el) => el.type === "select");
function submit(i: Island): { cancelled: boolean } {
  const ev = { cancelled: false, preventDefault() { this.cancelled = true; } };
  (propsOf(only(i, "form")).onSubmit as (e: typeof ev) => void)(ev);
  return { cancelled: ev.cancelled };
}

let pageListeners: Map<string, Set<(e: unknown) => void>>;
beforeEach(() => {
  pageListeners = new Map();
  vi.stubGlobal("window", {
    addEventListener: (type: string, fn: (e: unknown) => void) => {
      if (!pageListeners.has(type)) pageListeners.set(type, new Set());
      pageListeners.get(type)!.add(fn);
    },
    removeEventListener: (type: string, fn: (e: unknown) => void) => pageListeners.get(type)?.delete(fn),
  });
});
afterEach(() => vi.unstubAllGlobals());
const firePageshow = (persisted: boolean) => [...(pageListeners.get("pageshow") ?? [])].forEach((fn) => fn({ persisted }));

describe("QuickMatchAddMatch", () => {
  it("is a native disclosure: '+ Add a match' is its summary, the form inside it (no script needed to open it)", () => {
    const i = mount();
    const details = only(i, "details");
    expect(propsOf(details).open, "closed on first paint").toBeUndefined();
    const summary = only(i, "summary");
    expect(textOf(summary).trim()).toBe(LABELS.open);
    // The form is inside the disclosure, after its summary.
    const inside = i.tree().indexOf(only(i, "form"));
    expect(inside).toBeGreaterThan(i.tree().indexOf(summary));
  });

  it("a refused add comes back open on first paint (review m4); closed is the default, and `open={false}` is closed too", () => {
    const cases: [Partial<QuickMatchAddMatchProps>, boolean | undefined][] = [
      [{}, undefined],
      [{ open: false }, undefined],
      [{ open: true }, true],
    ];
    let checked = 0;
    for (const [over, open] of cases) {
      expect(propsOf(only(mount(over), "details")).open, JSON.stringify(over)).toBe(open);
      checked++;
    }
    expect(checked).toBe(3);
  });

  it("is a real form post to its action, blocked from session replay, with two selects named home and away and one submit", () => {
    const i = mount();
    const form = only(i, "form");
    expect(propsOf(form).method).toBe("post");
    expect(propsOf(form).action).toBe(ACTION);
    expect(classOf(form)).toContain("ph-no-capture");
    expect(selects(i).map((s) => propsOf(s).name)).toEqual(["home", "away"]);
    const button = only(i, "button");
    expect(propsOf(button).type).toBe("submit");
    expect(textOf(button).trim()).toBe(LABELS.submit);
    // Nothing else is posted: no hidden field carries the token or anything of the home's.
    expect(i.tree().filter((el) => el.type === "input")).toHaveLength(0);
  });

  it("each select lists every side, in the order given, by name, and opens at the side the page picked", () => {
    const i = mount();
    let checked = 0;
    for (const [n, select] of selects(i).entries()) {
      const options = i.tree().filter((el) => el.type === "option" && walkUp(i, el) === select);
      expect(options.map((o) => propsOf(o).value), `select ${n}`).toEqual(SIDES.map((s) => s.id));
      expect(options.map((o) => textOf(o).trim()), `select ${n}`).toEqual(SIDES.map((s) => s.name));
      checked++;
    }
    expect(checked).toBe(2);
    expect(selects(i).map((s) => propsOf(s).defaultValue)).toEqual([SIDES[1]!.id, SIDES[2]!.id]);
    // Another pick opens at it: the defaults are the page's, never the island's own.
    expect(selects(mount({ home: SIDES[2]!.id, away: SIDES[0]!.id })).map((s) => propsOf(s).defaultValue)).toEqual([
      SIDES[2]!.id,
      SIDES[0]!.id,
    ]);
  });

  it("each select is named by its visible label: the label wraps it and says 'First side' / 'Second side'", () => {
    const i = mount();
    const labels = i.tree().filter((el) => el.type === "label");
    expect(labels).toHaveLength(2);
    expect(labels.map((l) => textOf(l).split(SIDES[0]!.name)[0]!.trim())).toEqual([LABELS.home, LABELS.away]);
    let checked = 0;
    for (const [n, label] of labels.entries()) {
      expect(walkDown(label).includes(selects(i)[n]!), `label ${n} holds its select`).toBe(true);
      checked++;
    }
    expect(checked).toBe(2);
  });

  it("the first submit goes through; every later one is cancelled (an add is not idempotent); never disabled, only busy", () => {
    const i = mount();
    expect(propsOf(only(i, "button"))["aria-disabled"], "idle").toBeUndefined();
    expect(submit(i).cancelled, "the first post is the browser's own").toBe(false);
    expect(propsOf(only(i, "button"))["aria-disabled"]).toBe(true);
    expect(propsOf(only(i, "button")).disabled, "a disabled submitter can cancel its own post").toBeUndefined();
    let cancelled = 0;
    for (let k = 0; k < 3; k++) if (submit(i).cancelled) cancelled++;
    expect(cancelled, "a second, third and fourth tap while the page leaves").toBe(3);
  });

  it("restored from the back-forward cache, it unlocks; an ordinary pageshow does not", () => {
    const i = mount();
    expect(submit(i).cancelled).toBe(false);
    firePageshow(false);
    expect(submit(i).cancelled, "an ordinary load is not a restore").toBe(true);
    expect(pageListeners.get("pageshow")?.size, "one pageshow listener").toBe(1);
    firePageshow(true);
    expect(propsOf(only(i, "button"))["aria-disabled"], "idle again").toBeUndefined();
    expect(submit(i).cancelled, "unlocked: the tap posts").toBe(false);
  });

  it("thumb-sized: the summary, both selects and the button are 44px targets; the selects never widen the page", () => {
    const i = mount();
    const targets = [only(i, "summary"), ...selects(i), only(i, "button")];
    let checked = 0;
    for (const el of targets) {
      expect(classOf(el), String(el.type)).toContain("min-h-11");
      checked++;
    }
    expect(checked).toBe(4);
    for (const s of selects(i)) expect(classOf(s)).toEqual(expect.arrayContaining(["w-full", "min-w-0", "max-w-full"]));
    // A secondary control: the page's one lime call to action stays the hero's Score.
    expect(classOf(only(i, "button")).some((c) => c.startsWith("bg-[color:var(--mk-lime)]")), "not filled lime").toBe(false);
  });
});

/** The nearest `<select>` above an element in the island's tree (the harness flattens it, so the parent is searched). */
function walkUp(i: Island, el: ReactElement): ReactElement | undefined {
  return i.tree().find((s) => s.type === "select" && walkDown(s).includes(el));
}
function walkDown(el: ReactElement): ReactElement[] {
  const out: ReactElement[] = [];
  const visit = (n: unknown) => {
    if (Array.isArray(n)) return n.forEach(visit);
    if (n === null || typeof n !== "object" || !("props" in (n as object))) return;
    out.push(n as ReactElement);
    visit((n as ReactElement<{ children?: unknown }>).props.children);
  };
  visit((el as ReactElement<{ children?: unknown }>).props.children);
  return out;
}
