// Quick match plan 4, Task 4 (plan docs/superpowers/plans/2026-11-13-quick-match-4-skip-match.md D6, D7; spec
// docs/superpowers/specs/2026-11-12-quick-match-cancel-and-skip-design.md §6; owner 2026-11-13: one ⋯ menu per row): the
// home's row menu, `QuickMatchRowMenu` (a client island). No DOM here (vitest `environment: "node"`): the island is driven
// through the no-DOM `renderIsland` harness, its handlers called as a browser calls them, its refs' `current` set to stand-ins
// for the elements a browser would mount. What a browser does with the posts (the 303 back to the home) is the routes' test
// (app/q/[token]/__tests__/skip-route.test.ts) and the e2e (e2e/quick-match-home.spec.ts).
//
// The contract:
//   - the empty case first: an island handed no action offers nothing, and draws no sheet;
//   - every item is a real `<form method="post" action>` (no script: it posts), blocked from session replay, a 44px target,
//     in the order Score, Not played, Edit result, Put back; the ⋯ is a native `<details>` summary named for its match;
//   - "Not played" is offered only WITH its sheet (never a skip that cannot ask first);
//   - no `<dialog>` to open (none mounted yet, or a browser without `showModal`): the skip posts, as with no script (D7);
//   - with one: the skip's first submit is held, the menu closes and the sheet opens once, its safe answer focused; "Mark not
//     played" posts once; one post per menu (a second confirm, or any other item, is cancelled) until a bfcache restore;
//   - Keep and a backdrop tap close the sheet, and focus goes back to the ⋯; Escape or a tap outside closes the open menu.
//
// Sport: not applicable (the island posts paths; it knows no sport).
import type { ReactElement } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { propsOf, renderIsland, textOf } from "@/components/__tests__/_hook-harness";
import { QuickMatchRowMenu, type QuickMatchRowMenuProps } from "../row-menu";

const TOKEN = "qm_AbCdEfGhIjKlMnOpQrStUvWxYz0123456789-_abcde";
const FIXTURE = "00000000-0000-4000-8000-000000000001";
const SCORE = `/q/${TOKEN}/score/${FIXTURE}`;
const SKIP = `/q/${TOKEN}/skip/${FIXTURE}`;
const PUT_BACK = `/q/${TOKEN}/put-back/${FIXTURE}`;
const WORDS = {
  score: "Score",
  editResult: "Edit result",
  notPlayed: "Not played",
  notPlayedHint: "Skip it. No points for either side.",
  putBack: "Put back",
};
const SHEET = {
  title: "Skip Ines v Ravi?",
  body: "It gives no points to either side.",
  partial: "8–5 is already scored.",
  confirm: "Mark not played",
  keep: "Keep this match",
};

type Island = ReturnType<typeof renderIsland<QuickMatchRowMenuProps>>;
const mount = (over: Partial<QuickMatchRowMenuProps> = {}): Island =>
  renderIsland(QuickMatchRowMenu, { label: "More actions for Ines v Ravi", words: WORDS, ...over });
/** An open match's menu, as the page hands it: Score and Not played with its sheet. */
const openMatch = (over: Partial<QuickMatchRowMenuProps> = {}) => mount({ scoreAction: SCORE, skipAction: SKIP, sheet: SHEET, ...over });

const byTestId = (i: Island, id: string): ReactElement[] => i.tree().filter((el) => propsOf(el)["data-testid"] === id);
const one = (i: Island, id: string): ReactElement => {
  const hits = byTestId(i, id);
  expect(hits, `exactly one [data-testid=${id}]`).toHaveLength(1);
  return hits[0]!;
};
const forms = (i: Island) => i.tree().filter((el) => el.type === "form");
/** The form whose submit button carries this test id. */
const formOf = (i: Island, buttonId: string): ReactElement => {
  const hits = forms(i).filter((f) => containsTestId(f, buttonId));
  expect(hits, `exactly one form holds [data-testid=${buttonId}]`).toHaveLength(1);
  return hits[0]!;
};
function containsTestId(el: ReactElement, id: string): boolean {
  const kids = (propsOf(el).children ?? []) as unknown;
  const list = Array.isArray(kids) ? kids.flat(Infinity) : [kids];
  return list.some((k) => k && typeof k === "object" && "props" in (k as object) && (propsOf(k as ReactElement)["data-testid"] === id || containsTestId(k as ReactElement, id)));
}
/** The test id of the one submit button a form holds. */
const testIdOfButton = (form: ReactElement): string => {
  const kids = (propsOf(form).children ?? []) as unknown;
  const list = (Array.isArray(kids) ? kids.flat(Infinity) : [kids]) as ReactElement[];
  const button = list.find((k) => k && typeof k === "object" && (k as ReactElement).type === "button" && propsOf(k).type === "submit");
  return String(button ? propsOf(button)["data-testid"] : "");
};
const classOf = (el: ReactElement) => String(propsOf(el).className ?? "").split(/\s+/);
/** A submit as the browser dispatches it, recording whether the handler cancelled it. */
function submit(i: Island, buttonId: string): { cancelled: boolean } {
  const ev = { cancelled: false, preventDefault() { this.cancelled = true; } };
  (propsOf(formOf(i, buttonId)).onSubmit as (e: typeof ev) => void)(ev);
  return { cancelled: ev.cancelled };
}
/** The browser's elements behind the island's refs: the menu's `<details>`, its `<summary>`, the `<dialog>` and Keep. */
function mountElements(i: Island, dialog: Record<string, unknown> | null = { showModal: vi.fn(), close: vi.fn() }) {
  const details = { open: true, contains: (n: unknown) => n === "inside" };
  const summary = { focus: vi.fn() };
  const keep = { focus: vi.fn() };
  (propsOf(one(i, "qm-row-menu")).ref as { current: unknown }).current = details;
  (propsOf(one(i, "qm-row-menu-toggle")).ref as { current: unknown }).current = summary;
  if (byTestId(i, "qm-skip-sheet").length > 0) {
    (propsOf(one(i, "qm-skip-sheet")).ref as { current: unknown }).current = dialog;
    (propsOf(one(i, "qm-skip-keep")).ref as { current: unknown }).current = keep;
  }
  return { details, summary, keep, dialog };
}

let listeners: Map<string, Set<(e: unknown) => void>>;
const target = () => ({
  addEventListener: (type: string, fn: (e: unknown) => void) => {
    if (!listeners.has(type)) listeners.set(type, new Set());
    listeners.get(type)!.add(fn);
  },
  removeEventListener: (type: string, fn: (e: unknown) => void) => listeners.get(type)?.delete(fn),
});
beforeEach(() => {
  listeners = new Map();
  vi.stubGlobal("window", target());
  vi.stubGlobal("document", target());
});
afterEach(() => vi.unstubAllGlobals());
const fire = (type: string, e: unknown) => [...(listeners.get(type) ?? [])].forEach((fn) => fn(e));

describe("QuickMatchRowMenu", () => {
  it("the empty case first: handed no action, it offers no item and draws no sheet", () => {
    const i = mount();
    expect(forms(i)).toHaveLength(0);
    expect(byTestId(i, "qm-skip-sheet")).toHaveLength(0);
    // The ⋯ itself is still the disclosure (the list never asks for an empty menu: match-list.tsx `rowMenuItems`).
    expect(one(i, "qm-row-menu").type).toBe("details");
  });

  it("the ⋯ is a native disclosure named for its match, a 44px square; the menus share one name, so one is open at a time", () => {
    const i = openMatch();
    const details = one(i, "qm-row-menu");
    expect(details.type).toBe("details");
    expect(propsOf(details).name).toBe("qm-row-menu");
    expect(propsOf(details).open, "closed on first paint").toBeUndefined();
    const summary = one(i, "qm-row-menu-toggle");
    expect(summary.type).toBe("summary");
    expect(propsOf(summary)["aria-label"]).toBe("More actions for Ines v Ravi");
    expect(classOf(summary)).toEqual(expect.arrayContaining(["h-11", "w-11"]));
  });

  it("every item is a real post (no script: it posts), blocked from session replay, 44px, in the order Score, Not played, Edit result, Put back", () => {
    const i = mount({ scoreAction: SCORE, skipAction: SKIP, sheet: SHEET, editAction: SCORE, putBackAction: PUT_BACK });
    const items: [string, string, string][] = [
      ["qm-menu-score", SCORE, "Score"],
      ["qm-skip", SKIP, "Not played Skip it. No points for either side."],
      ["qm-edit-result", SCORE, "Edit result"],
      ["qm-put-back", PUT_BACK, "Put back"],
    ];
    let checked = 0;
    for (const [id, action, words] of items) {
      const form = formOf(i, id);
      expect(propsOf(form).method, id).toBe("post");
      expect(propsOf(form).action, id).toBe(action);
      expect(classOf(form), id).toContain("ph-no-capture");
      const button = one(i, id);
      expect(propsOf(button).type, id).toBe("submit");
      expect(classOf(button), id).toContain("min-h-11");
      expect(propsOf(button).disabled, `${id}: never disabled`).toBeUndefined();
      expect(textOf(button).replace(/\s+/g, " ").trim(), id).toBe(words);
      checked++;
    }
    expect(checked).toBe(4);
    // Order: the panel's forms, then the sheet's own (the sheet is outside the menu, after it).
    expect(forms(i).map((f) => propsOf(f).action)).toEqual([SCORE, SKIP, SCORE, PUT_BACK, SKIP]);
    expect(forms(i).filter((f) => containsTestId(one(i, "qm-row-menu-panel"), testIdOfButton(f))), "four of them in the menu").toHaveLength(4);
    // No field: the token and the match ride the path alone (O3).
    expect(i.tree().filter((el) => el.type === "input")).toHaveLength(0);
  });

  it("'Not played' is offered only with its sheet: a skip action alone offers no Not played and no sheet", () => {
    const i = mount({ scoreAction: SCORE, skipAction: SKIP });
    expect(byTestId(i, "qm-skip")).toHaveLength(0);
    expect(byTestId(i, "qm-skip-sheet")).toHaveLength(0);
    // The positive pair: the same island WITH its sheet offers both.
    const withSheet = openMatch();
    expect(byTestId(withSheet, "qm-skip")).toHaveLength(1);
    expect(byTestId(withSheet, "qm-skip-sheet")).toHaveLength(1);
  });

  it("no dialog to open (not mounted yet, or no showModal): the skip posts as it does with no script, and locks", () => {
    for (const dialog of [null, { close: vi.fn() }]) {
      const i = openMatch();
      mountElements(i, dialog);
      expect(submit(i, "qm-skip").cancelled, `${JSON.stringify(dialog)}: the post is the browser's own`).toBe(false);
      expect(submit(i, "qm-skip").cancelled, "a second tap while leaving").toBe(true);
    }
  });

  it("with the dialog: the skip is held, the menu closes and the sheet opens once with Keep focused; Mark not played posts once", () => {
    const i = openMatch();
    const el = mountElements(i);
    expect(submit(i, "qm-skip").cancelled, "the first tap asks first").toBe(true);
    expect(el.dialog!.showModal).toHaveBeenCalledTimes(1);
    expect(el.details.open, "the menu it came from is closed").toBe(false);
    expect(el.keep.focus, "the safe answer has the focus").toHaveBeenCalledTimes(1);
    // The sheet's own form posts the skip.
    const confirm = formOf(i, "qm-skip-confirm");
    expect([propsOf(confirm).method, propsOf(confirm).action]).toEqual(["post", SKIP]);
    expect(classOf(confirm)).toContain("ph-no-capture");
    expect(submit(i, "qm-skip-confirm").cancelled, "Mark not played posts").toBe(false);
    expect(propsOf(one(i, "qm-skip-confirm"))["aria-disabled"], "busy").toBe(true);
    // One post per menu: a second confirm, another item, or the skip again, are all cancelled while the page is leaving.
    let cancelled = 0;
    for (const id of ["qm-skip-confirm", "qm-menu-score", "qm-skip"]) if (submit(i, id).cancelled) cancelled++;
    expect(cancelled).toBe(3);
    expect(el.dialog!.showModal, "a locked skip never opens the sheet again").toHaveBeenCalledTimes(1);
  });

  it("back from the pad (bfcache): a restored page unlocks; an ordinary pageshow does not", () => {
    const i = openMatch();
    mountElements(i);
    expect(submit(i, "qm-menu-score").cancelled).toBe(false);
    fire("pageshow", { persisted: false });
    expect(submit(i, "qm-menu-score").cancelled, "an ordinary load is not a restore").toBe(true);
    expect(listeners.get("pageshow")?.size, "one pageshow listener").toBe(1);
    fire("pageshow", { persisted: true });
    expect(propsOf(one(i, "qm-menu-score"))["aria-disabled"], "idle again").toBeUndefined();
    expect(submit(i, "qm-menu-score").cancelled, "unlocked: the tap posts").toBe(false);
  });

  it("Keep closes the sheet; a backdrop tap closes it, a tap inside does not; closing puts focus back on the ⋯", () => {
    const i = openMatch();
    const el = mountElements(i);
    submit(i, "qm-skip");
    const keep = one(i, "qm-skip-keep");
    expect(propsOf(keep).type, "Keep never submits").toBe("button");
    (propsOf(keep).onClick as () => void)();
    expect(el.dialog!.close).toHaveBeenCalledTimes(1);
    const sheet = one(i, "qm-skip-sheet");
    const onClick = propsOf(sheet).onClick as (e: unknown) => void;
    const self = { close: vi.fn() };
    onClick({ target: self, currentTarget: self });
    expect(self.close, "the backdrop is the dialog itself").toHaveBeenCalledTimes(1);
    onClick({ target: { inner: true }, currentTarget: self });
    expect(self.close, "a tap on the sheet's own content").toHaveBeenCalledTimes(1);
    (propsOf(sheet).onClose as () => void)();
    expect(el.summary.focus).toHaveBeenCalledTimes(1);
  });

  it("the open menu closes on a tap outside it (not inside) and on Escape, which puts focus back on the ⋯", () => {
    const i = openMatch();
    const el = mountElements(i);
    expect(listeners.get("pointerdown")?.size ?? 0, "closed: nothing listens").toBe(0);
    (propsOf(one(i, "qm-row-menu")).onToggle as (e: unknown) => void)({ currentTarget: { open: true } });
    expect(listeners.get("pointerdown")?.size, "open: one listener").toBe(1);
    fire("pointerdown", { target: "inside" });
    expect(el.details.open, "a tap on the menu's own item").toBe(true);
    fire("pointerdown", { target: "elsewhere" });
    expect(el.details.open).toBe(false);
    el.details.open = true;
    fire("keydown", { key: "Enter" });
    expect(el.details.open).toBe(true);
    fire("keydown", { key: "Escape" });
    expect(el.details.open).toBe(false);
    expect(el.summary.focus).toHaveBeenCalledTimes(1);
    (propsOf(one(i, "qm-row-menu")).onToggle as (e: unknown) => void)({ currentTarget: { open: false } });
    expect(listeners.get("pointerdown")?.size, "closed again: the listener is gone").toBe(0);
  });

  it("the sheet says the match's own words: its title, a live match's score before the body, and the two answers", () => {
    const i = openMatch();
    const sheet = one(i, "qm-skip-sheet");
    expect(sheet.type).toBe("dialog");
    expect(textOf(one(i, "qm-skip-title"))).toBe(SHEET.title);
    expect(propsOf(sheet)["aria-labelledby"]).toBe(propsOf(one(i, "qm-skip-title")).id);
    const body = i.tree().filter((el) => propsOf(el).id === propsOf(sheet)["aria-describedby"]);
    expect(body, "the sheet is described by its words").toHaveLength(1);
    expect(textOf(body[0]!).replace(/\s+/g, " ").trim()).toBe(`${SHEET.partial} ${SHEET.body}`);
    expect(textOf(one(i, "qm-skip-confirm"))).toBe(SHEET.confirm);
    expect(textOf(one(i, "qm-skip-keep"))).toBe(SHEET.keep);
    // Nothing scored: no partial line.
    const fresh = openMatch({ sheet: { ...SHEET, partial: null } });
    expect(byTestId(fresh, "qm-skip-partial")).toHaveLength(0);
    expect(textOf(one(fresh, "qm-skip-body"))).toBe(SHEET.body);
  });
});
