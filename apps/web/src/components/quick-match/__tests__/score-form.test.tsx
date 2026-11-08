// Quick match plan 2, Task 6: the home's Score control, `QuickMatchScoreForm` (a client island). No DOM here (vitest
// `environment: "node"`): the island is driven through the no-DOM `renderIsland` harness, its handlers called as a browser
// calls them. What a browser does with the post itself (the 303 into the pad) is the route's test
// (app/q/[token]/__tests__/score-route.test.ts) and the e2e (e2e/quick-match-home.spec.ts).
//
// The contract:
//   - a real `<form method="post" action>`: with no script it still posts, and the server answers every tap (a second
//     post reopens the same link, so a double tap without the script costs nothing but a round trip);
//   - with the script, the first submit goes through untouched and every later one is cancelled until the page is
//     restored from the back-forward cache (the guest came back from the pad), which unlocks it;
//   - the button is never `disabled`: disabling the submitter can cancel the very post it started. The busy state is
//     `aria-disabled` and its look;
//   - the form carries `ph-no-capture` (its action holds the home token, O3) and its button is a 44px target.
//
// Sport: not applicable (the control posts a path; it knows no sport).
import type { ReactElement } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { propsOf, renderIsland, textOf } from "@/components/__tests__/_hook-harness";
import { QuickMatchScoreForm, type QuickMatchScoreFormProps } from "../score-form";

const ACTION = "/q/qm_AbCdEfGhIjKlMnOpQrStUvWxYz0123456789-_abcde/score/00000000-0000-4000-8000-000000000001";

const props = (over: Partial<QuickMatchScoreFormProps> = {}): QuickMatchScoreFormProps => ({
  action: ACTION,
  label: "Score this match",
  place: "hero",
  ...over,
});
type Island = ReturnType<typeof renderIsland<QuickMatchScoreFormProps>>;
const mount = (over: Partial<QuickMatchScoreFormProps> = {}): Island => renderIsland(QuickMatchScoreForm, props(over));

const formOf = (i: Island): ReactElement => {
  const forms = i.tree().filter((el) => el.type === "form");
  expect(forms, "exactly one form").toHaveLength(1);
  return forms[0]!;
};
const buttonOf = (i: Island): ReactElement => {
  const buttons = i.tree().filter((el) => el.type === "button");
  expect(buttons, "exactly one button").toHaveLength(1);
  return buttons[0]!;
};
const classOf = (el: ReactElement) => String(propsOf(el).className ?? "").split(/\s+/);
/** A submit as the browser dispatches it, recording whether the handler cancelled it. */
function submit(i: Island): { cancelled: boolean } {
  const ev = { cancelled: false, preventDefault() { this.cancelled = true; } };
  (propsOf(formOf(i)).onSubmit as (e: typeof ev) => void)(ev);
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

describe("QuickMatchScoreForm", () => {
  it("is a real form post to its action, blocked from session replay, with one submit button that says the label", () => {
    const i = mount();
    const form = formOf(i);
    expect(propsOf(form).method).toBe("post");
    expect(propsOf(form).action).toBe(ACTION);
    expect(classOf(form)).toContain("ph-no-capture");
    expect(propsOf(form)["data-place"]).toBe("hero");
    const button = buttonOf(i);
    expect(propsOf(button).type).toBe("submit");
    expect(textOf(button).trim()).toBe("Score this match");
    // No field: the token and the match ride the path alone (O3); the post has no body to log.
    expect(i.tree().filter((el) => el.type === "input")).toHaveLength(0);
  });

  it("the first submit goes through; every later one is cancelled; the button is never disabled, only marked busy", () => {
    const i = mount();
    expect(propsOf(buttonOf(i))["aria-disabled"], "idle").toBeUndefined();
    expect(submit(i).cancelled, "the first post is the browser's own").toBe(false);
    expect(propsOf(buttonOf(i))["aria-disabled"]).toBe(true);
    expect(propsOf(buttonOf(i)).disabled, "a disabled submitter can cancel its own post").toBeUndefined();
    let cancelled = 0;
    for (let k = 0; k < 3; k++) if (submit(i).cancelled) cancelled++;
    expect(cancelled, "a second, third and fourth tap while leaving").toBe(3);
  });

  it("back from the pad (bfcache): a restored page unlocks; an ordinary pageshow does not", () => {
    const i = mount();
    expect(submit(i).cancelled).toBe(false);
    firePageshow(false);
    expect(submit(i).cancelled, "an ordinary load is not a restore").toBe(true);
    expect(pageListeners.get("pageshow")?.size, "one pageshow listener").toBe(1);
    firePageshow(true);
    expect(propsOf(buttonOf(i))["aria-disabled"], "idle again").toBeUndefined();
    expect(submit(i).cancelled, "unlocked: the tap posts").toBe(false);
    expect(submit(i).cancelled, "and locks again").toBe(true);
  });

  it("a thumb-sized target in both places (44px or more), the hero's full width; a row's names its match through describedBy", () => {
    const hero = buttonOf(mount());
    expect(classOf(hero)).toEqual(expect.arrayContaining(["min-h-12", "w-full"]));
    const row = buttonOf(mount({ place: "row", label: "Score", describedBy: "qm-match-sides-x" }));
    expect(classOf(row)).toContain("min-h-11");
    expect(propsOf(row)["aria-describedby"]).toBe("qm-match-sides-x");
    expect(textOf(row).trim()).toBe("Score");
    expect(propsOf(hero)["aria-describedby"], "the hero's section already names its match").toBeUndefined();
  });
});
