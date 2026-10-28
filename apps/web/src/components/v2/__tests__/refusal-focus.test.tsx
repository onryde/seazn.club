// The refusal block's focus (YouTube Connect T12 fix round 1, m4): when a YouTube refusal replaces the Go live button the organiser had
// just pressed, focus moves to the block's first action instead of falling to the top of the page.
//
// `apps/web` vitest is `environment: "node"` — no DOM — so the wrapper's callback ref is driven directly with a fake box that records
// what it was asked and which element it focused. What a real browser does with that focus (the ring, the scroll) is the shots spec's.
import { describe, expect, it } from "vitest";
import type { ReactElement } from "react";
import { propsOf, renderIsland } from "@/components/__tests__/_hook-harness";
import { FIRST_ACTION, FocusFirstAction, focusFirstAction } from "../refusal-focus";

function fakeBox(actions: string[]) {
  const asked: string[] = [];
  const focused: string[] = [];
  const box = {
    querySelector: (selector: string) => {
      asked.push(selector);
      const first = actions[0];
      return first === undefined ? null : { focus: () => focused.push(first) };
    },
  } as unknown as HTMLElement;
  return { box, asked, focused };
}

describe("focusFirstAction", () => {
  it("focuses the first action the box holds — asked for as a link or an ENABLED button, so a disabled Try again is skipped", () => {
    const f = fakeBox(["reconnect"]);
    focusFirstAction(f.box);
    expect(f.focused).toEqual(["reconnect"]);
    expect(f.asked).toEqual([FIRST_ACTION]);
    expect(FIRST_ACTION).toContain("a[href]");
    expect(FIRST_ACTION, "a disabled button cannot take focus").toContain(":not([disabled])");
  });

  it("a box with no action, or no box at all (the ref's detach), focuses nothing and throws nothing", () => {
    const f = fakeBox([]);
    focusFirstAction(f.box);
    expect(f.focused).toEqual([]);
    expect(f.asked, "it did look").toHaveLength(1);
    expect(() => focusFirstAction(null)).not.toThrow();
  });
});

describe("FocusFirstAction", () => {
  it("is a box with no layout of its own whose ref is the module-level callback — one identity across renders, so a re-render never re-focuses", () => {
    const island = renderIsland(FocusFirstAction, { children: <button type="button">Use another destination</button> });
    const root = island.tree().find((el: ReactElement) => el.type === "div")!;
    expect(root, "a wrapper box").toBeDefined();
    expect(propsOf(root).ref).toBe(focusFirstAction);
    expect(String(propsOf(root).className).split(/\s+/)).toContain("contents");
    island.rerender({ children: <button type="button">Use another destination</button> });
    const again = island.tree().find((el: ReactElement) => el.type === "div")!;
    expect(propsOf(again).ref, "the same callback after a re-render").toBe(focusFirstAction);
  });

  it("attaching the box focuses the block's first action (the ref is what React calls at attach)", () => {
    const island = renderIsland(FocusFirstAction, { children: <button type="button">x</button> });
    const root = island.tree().find((el: ReactElement) => el.type === "div")!;
    const f = fakeBox(["first"]);
    (propsOf(root).ref as (b: HTMLElement | null) => void)(f.box);
    expect(f.focused).toEqual(["first"]);
  });
});
