// Quick match plan 5, Task 7 (plan docs/superpowers/plans/2026-11-13-quick-match-5-league-knockout.md D5; spec
// docs/superpowers/specs/2026-11-12-quick-match-league-knockout-design.md §5, §11; mockup qmd13a01 §8, layout only): the
// answers to a tie at a League + Knockout's cut, `QuickMatchCutPrompt` (a client island). No DOM here (vitest
// `environment: "node"`): the island is driven through the no-DOM `renderIsland` harness, its handlers called as a browser
// calls them, its panel ref's `current` set to a stand-in for the `<details>` a browser would mount. What the posts do (the
// 303 back to the home, ALREADY_DECIDED for a second phone) is the cut route's test (app/q/[token]/__tests__/cut-route.test.ts)
// and the home's (page-league-knockout.test.tsx).
//
// The contract:
//   - no script: the server's markup is real forms (Pick posts the ticked sides, Toss posts at once), Send is never disabled
//     in it (the server counts the picks: PICK_INVALID), Back is a link to the home, and every token-bearing element is kept
//     out of session replay (O3);
//   - one place: radios; more: checkboxes;
//   - with the script: Send is disabled until exactly as many sides are ticked as there are places (none, one short, one
//     over: disabled), and names who it sends, in the panel's order whichever was ticked first; an Enter with the wrong count
//     is cancelled the same way;
//   - no lot ordered the tie: no Toss at all (Pick only);
//   - one post per prompt: the first submit goes, every later one (either form) is cancelled and both buttons read busy,
//     until a bfcache restore (`pageshow` persisted; an ordinary pageshow does not unlock);
//   - Back shuts the open panel in place; with no panel mounted it follows its link.
//
// Sport: not applicable (the island posts entrant ids; it knows no sport).
import type { ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { propsOf, renderIsland, textOf } from "@/components/__tests__/_hook-harness";
import { QuickMatchCutPrompt, type QuickMatchCutPromptProps } from "../cut-prompt";

const TOKEN = "qm_AbCdEfGhIjKlMnOpQrStUvWxYz0123456789-_abcde";
const HOME = `/q/${TOKEN}`;
const PICK = `/q/${TOKEN}/cut/pick`;
const TOSS = `/q/${TOKEN}/cut/toss`;
// The mockup's tied sides (qmd13a01 §8), in the order the guests typed them.
const INES = { id: "e-ines", name: "Ines" };
const MIKA = { id: "e-mika", name: "Mika" };
const SOFIA = { id: "e-sofia", name: "Sofia" };
const WORDS = {
  pick: "Pick who goes through",
  toss: "Toss a coin",
  back: "Back",
  question: "Who goes through?",
  send: "Send {names} through",
};

type Island = ReturnType<typeof renderIsland<QuickMatchCutPromptProps>>;
const props = (over: Partial<QuickMatchCutPromptProps> = {}): QuickMatchCutPromptProps => ({
  pickAction: PICK,
  tossAction: TOSS,
  backHref: HOME,
  members: [INES, MIKA],
  seats: 1,
  locale: "en",
  words: WORDS,
  ...over,
});
/** Hydrated: the browser with the script running (`useHydrated` reads true after the first commit). */
const mount = (over: Partial<QuickMatchCutPromptProps> = {}): Island => renderIsland(QuickMatchCutPrompt, props(over), undefined, { hydrate: true });

const byTestId = (i: Island, id: string): ReactElement[] => i.tree().filter((el) => propsOf(el)["data-testid"] === id);
const one = (i: Island, id: string): ReactElement => {
  const hits = byTestId(i, id);
  expect(hits, `exactly one [data-testid=${id}]`).toHaveLength(1);
  return hits[0]!;
};
const forms = (i: Island) => i.tree().filter((el) => el.type === "form");
const inputs = (i: Island) => i.tree().filter((el) => el.type === "input");
const classOf = (el: ReactElement) => String(propsOf(el).className ?? "").split(/\s+/);
const send = (i: Island) => one(i, "qm-cut-send");
const sendDisabled = (i: Island) => propsOf(send(i)).disabled === true;
const sendLabel = (i: Island) => textOf(propsOf(send(i)).children as never).trim();
/** Tick (or untick) a side, as the browser fires the input's change. */
function tick(i: Island, id: string, checked = true) {
  const input = inputs(i).find((el) => propsOf(el).value === id);
  expect(input, `an input for ${id}`).toBeDefined();
  (propsOf(input!).onChange as (e: { target: { checked: boolean } }) => void)({ target: { checked } });
}
/** The pick form (it holds the panel's inputs) and the toss form (it holds Toss). */
const pickForm = (i: Island) => {
  const hits = forms(i).filter((f) => propsOf(f).action === PICK);
  expect(hits, "one pick form").toHaveLength(1);
  return hits[0]!;
};
const tossForm = (i: Island) => {
  const hits = forms(i).filter((f) => propsOf(f).action === TOSS);
  expect(hits, "one toss form").toHaveLength(1);
  return hits[0]!;
};
/** A submit as the browser dispatches it, recording whether the handler cancelled it. */
function submit(form: ReactElement): { cancelled: boolean } {
  const ev = { cancelled: false, preventDefault() { this.cancelled = true; } };
  (propsOf(form).onSubmit as (e: typeof ev) => void)(ev);
  return { cancelled: ev.cancelled };
}

let listeners: Map<string, Set<(e: unknown) => void>>;
beforeEach(() => {
  listeners = new Map();
  vi.stubGlobal("window", {
    addEventListener: (type: string, fn: (e: unknown) => void) => {
      if (!listeners.has(type)) listeners.set(type, new Set());
      listeners.get(type)!.add(fn);
    },
    removeEventListener: (type: string, fn: (e: unknown) => void) => listeners.get(type)?.delete(fn),
  });
});
afterEach(() => vi.unstubAllGlobals());
const fire = (type: string, e: unknown) => [...(listeners.get(type) ?? [])].forEach((fn) => fn(e));

describe("QuickMatchCutPrompt", () => {
  it("no script: real forms, Send never disabled in the server's markup, Back a link home, every token-bearing element out of replay", () => {
    const html = renderToStaticMarkup(<QuickMatchCutPrompt {...props()} />);
    expect(html).toContain(`action="${PICK}"`);
    expect(html).toContain(`action="${TOSS}"`);
    expect(html).toContain(`href="${HOME}"`);
    expect(html, "the server counts the picks (PICK_INVALID): Send is a plain submit").not.toMatch(/<button[^>]*disabled=""/);
    expect(html).not.toContain(`aria-disabled="true"`);
    // Each element whose action or href holds the token carries ph-no-capture (O3), and there are three of them.
    const bearing = [...html.matchAll(/<(form|a)\b[^>]*\b(?:action|href)="([^"]*)"[^>]*>/g)].filter(([, , url]) => url!.includes(TOKEN));
    expect(bearing.map(([, tag]) => tag)).toEqual(["form", "a", "form"]);
    for (const [tag] of bearing) expect(tag, tag).toMatch(/class="[^"]*\bph-no-capture\b/);

    const i = renderIsland(QuickMatchCutPrompt, props());
    expect(forms(i).map((f) => [propsOf(f).method, propsOf(f).action])).toEqual([["post", PICK], ["post", TOSS]]);
    expect(propsOf(one(i, "qm-cut-pick-panel")).open, "the panel opens shut").toBeUndefined();
    expect(one(i, "qm-cut-pick-panel").type).toBe("details");
    expect(one(i, "qm-cut-pick").type).toBe("summary");
    expect(sendDisabled(i), "server snapshot: Send is enabled").toBe(false);
    expect(sendLabel(i)).toBe(WORDS.pick);
  });

  it("one place: a radio per tied side, in the typed order, all named `entrant`; more places: checkboxes", () => {
    const radios = renderIsland(QuickMatchCutPrompt, props());
    expect(inputs(radios).map((el) => [propsOf(el).type, propsOf(el).name, propsOf(el).value])).toEqual([
      ["radio", "entrant", INES.id],
      ["radio", "entrant", MIKA.id],
    ]);
    expect(textOf(propsOf(one(radios, "qm-cut-question")).children as never)).toBe(WORDS.question);
    expect(byTestId(radios, "qm-cut-option").map((el) => textOf(propsOf(el).children as never).trim())).toEqual(["Ines", "Mika"]);

    const boxes = renderIsland(QuickMatchCutPrompt, props({ members: [INES, MIKA, SOFIA], seats: 2 }));
    expect(inputs(boxes).map((el) => [propsOf(el).type, propsOf(el).name, propsOf(el).value])).toEqual([
      ["checkbox", "entrant", INES.id],
      ["checkbox", "entrant", MIKA.id],
      ["checkbox", "entrant", SOFIA.id],
    ]);
  });

  it("with the script, one place: Send waits for a side, then names it; a radio change replaces the side", () => {
    const i = mount();
    expect(sendDisabled(i), "nothing ticked").toBe(true);
    expect(sendLabel(i)).toBe(WORDS.pick);
    tick(i, MIKA.id);
    expect(sendDisabled(i)).toBe(false);
    expect(sendLabel(i)).toBe("Send Mika through");
    tick(i, INES.id);
    expect(sendDisabled(i), "a radio group holds one").toBe(false);
    expect(sendLabel(i)).toBe("Send Ines through");
  });

  it("with the script, two places of three: one short and one over are refused; exactly two names both, in the panel's order", () => {
    const i = mount({ members: [INES, MIKA, SOFIA], seats: 2 });
    expect(sendDisabled(i), "none ticked").toBe(true);
    tick(i, SOFIA.id);
    expect(sendDisabled(i), "one short").toBe(true);
    expect(sendLabel(i)).toBe("Send Sofia through");
    tick(i, INES.id);
    expect(sendDisabled(i), "exactly two").toBe(false);
    // Sofia was ticked first; the label reads the panel's order (the order the guests typed them).
    expect(sendLabel(i)).toBe("Send Ines and Sofia through");
    tick(i, MIKA.id);
    expect(sendDisabled(i), "one over").toBe(true);
    expect(sendLabel(i)).toBe("Send Ines, Mika, and Sofia through");
    tick(i, SOFIA.id, false);
    expect(sendDisabled(i), "back to exactly two").toBe(false);
    expect(sendLabel(i)).toBe("Send Ines and Mika through");
    // An Enter with the wrong count is cancelled as Send's disabled state is.
    tick(i, MIKA.id, false);
    expect(submit(pickForm(i)).cancelled, "one short: the post is cancelled").toBe(true);
    tick(i, MIKA.id);
    expect(submit(pickForm(i)).cancelled, "exactly two: the post goes").toBe(false);
  });

  it("no lot ordered the tie: Pick only, no Toss form or button", () => {
    const i = mount({ tossAction: null });
    expect(byTestId(i, "qm-cut-toss")).toHaveLength(0);
    expect(forms(i).map((f) => propsOf(f).action)).toEqual([PICK]);
    expect(renderToStaticMarkup(<QuickMatchCutPrompt {...props({ tossAction: null })} />)).not.toContain("/cut/toss");
  });

  it("Toss steps aside while the panel is open (CSS only, so no-script too)", () => {
    const i = mount();
    expect(classOf(one(i, "qm-cut-actions"))).toContain("group/cut");
    expect(classOf(tossForm(i))).toContain("group-has-[details[open]]/cut:hidden");
    expect(classOf(one(i, "qm-cut-pick")), "the summary hides inside the open panel").toContain("[details[open]>&]:hidden");
  });

  it("one post per prompt: the first submit goes, every later one is cancelled and both buttons read busy, until a bfcache restore", () => {
    const i = mount();
    expect(propsOf(one(i, "qm-cut-toss"))["aria-disabled"]).toBeUndefined();
    expect(submit(tossForm(i)).cancelled, "the first post goes").toBe(false);
    expect(propsOf(one(i, "qm-cut-toss"))["aria-disabled"]).toBe(true);
    expect(propsOf(send(i))["aria-disabled"]).toBe(true);
    tick(i, INES.id);
    // Busy is the look (`aria-disabled`), never `disabled` on a submitter (disabling one can cancel the post it started).
    expect(propsOf(send(i)).disabled, "a ticked side: Send is not disabled while busy").toBe(false);
    expect(submit(tossForm(i)).cancelled, "a second toss").toBe(true);
    expect(submit(pickForm(i)).cancelled, "a pick after the toss").toBe(true);

    expect(listeners.get("pageshow")?.size, "one pageshow listener").toBe(1);
    fire("pageshow", { persisted: false });
    expect(submit(pickForm(i)).cancelled, "an ordinary pageshow does not unlock").toBe(true);
    fire("pageshow", { persisted: true });
    expect(propsOf(one(i, "qm-cut-toss"))["aria-disabled"]).toBeUndefined();
    expect(submit(pickForm(i)).cancelled, "restored from the bfcache: the next post goes").toBe(false);
    expect(submit(tossForm(i)).cancelled, "and locks again").toBe(true);
    i.unmount();
    expect(listeners.get("pageshow")?.size ?? 0, "unmount removes the listener").toBe(0);
  });

  it("Back shuts the open panel in place; with no panel mounted it follows its link", () => {
    const i = mount();
    const back = one(i, "qm-cut-back");
    expect(back.type).toBe("a");
    expect(propsOf(back).href).toBe(HOME);
    expect(classOf(back)).toContain("ph-no-capture");
    const click = (el: ReactElement) => {
      const ev = { cancelled: false, preventDefault() { this.cancelled = true; } };
      (propsOf(el).onClick as (e: typeof ev) => void)(ev);
      return ev.cancelled;
    };
    expect(click(back), "no panel element yet: the link reloads the home").toBe(false);
    const details = { open: true };
    (propsOf(one(i, "qm-cut-pick-panel")).ref as { current: unknown }).current = details;
    expect(click(one(i, "qm-cut-back")), "the script shuts the panel instead").toBe(true);
    expect(details.open).toBe(false);
  });

  // T7 review m7: Pick is the panel's `<summary>`, and it hides once the panel opens, so the focus it held would fall to the
  // page. Opening moves it to the question (the fieldset's legend, focusable by script only), which a screen reader reads
  // out; Back shuts the panel and hides itself, so it hands the focus back to Pick. No DOM here: the panel's `toggle` is
  // fired as the browser fires it (after `open` changed), against stand-ins for the elements the refs would hold. That a
  // real browser fires `toggle` and moves the focus is the screenshot pass's to see, not this file's.
  it("opening Pick moves the focus to the question; Back shuts the panel and returns it to Pick", () => {
    const i = mount();
    const legend = one(i, "qm-cut-question");
    expect(legend.type).toBe("legend");
    expect(propsOf(legend).tabIndex, "focusable by script, never a tab stop").toBe(-1);
    const focused: string[] = [];
    const set = (el: ReactElement, current: unknown) => ((propsOf(el).ref as { current: unknown }).current = current);
    set(legend, { focus: () => focused.push("question") });
    set(one(i, "qm-cut-pick"), { focus: () => focused.push("pick") });
    const details = { open: false };
    set(one(i, "qm-cut-pick-panel"), details);
    const toggle = () => (propsOf(one(i, "qm-cut-pick-panel")).onToggle as () => void)();

    details.open = true;
    toggle();
    expect(focused, "opened: the question").toEqual(["question"]);

    (propsOf(one(i, "qm-cut-back")).onClick as (e: { preventDefault(): void }) => void)({ preventDefault() {} });
    expect(details.open, "Back shut it").toBe(false);
    expect(focused, "shut by Back: Pick again").toEqual(["question", "pick"]);
    // The toggle that follows the shut moves nothing more.
    toggle();
    expect(focused).toEqual(["question", "pick"]);
  });
});
