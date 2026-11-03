// Match Day C8 — "Add your first division" moves a screen reader's cursor onto
// the new screen. The effect is `heading.current?.focus()`; a source-regex for
// `.focus()` passes with the call commented out or pointed at the wrong element.
// This runs the REAL effect through the hook harness.
//
// The harness has no DOM, so a ref never attaches. `useRef` is wrapped to hand
// the one ref in this component an element-shaped object whose `focus` is a spy;
// the test then proves (a) the effect called it, once, and (b) the ref the
// component put on the `<h2 id="first-division-title">` is that very object —
// i.e. the focus lands on the heading, not on some other element.
import { describe, expect, it, vi } from "vitest";
import type { ReactElement } from "react";

const focus = vi.hoisted(() => ({ spy: undefined as undefined | (() => void) }));
vi.mock("react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react")>();
  return {
    ...actual,
    useRef: <T,>(initial: T) => {
      const ref = actual.useRef(initial);
      if (initial === null && focus.spy) (ref as { current: unknown }).current = { focus: focus.spy };
      return ref;
    },
  };
});

import { propsOf, renderIsland } from "@/components/__tests__/_hook-harness";
import { FirstDivisionPrompt } from "../first-division-prompt";

const created = {
  name: "Riverside Autumn Open 2026",
  slug: "autumn-open",
  visibility: "public",
  discoverable: true,
  startsOn: "2026-11-14",
  endsOn: "2026-11-15",
};

describe("<FirstDivisionPrompt> focus", () => {
  it("calls focus() once on mount, on the ref the heading carries", () => {
    const spy = vi.fn();
    focus.spy = spy;
    try {
      const island = renderIsland(FirstDivisionPrompt, { orgSlug: "riverside", created });
      expect(spy).toHaveBeenCalledTimes(1);
      const headings = island.tree().filter((el: ReactElement) => el.type === "h2");
      expect(headings).toHaveLength(1);
      const heading = headings[0]!;
      expect(propsOf(heading).id).toBe("first-division-title");
      const ref = propsOf(heading).ref as { current: { focus: () => void } } | undefined;
      // The ref on the heading IS the one the effect focused.
      expect(ref?.current.focus).toBe(spy);
    } finally {
      focus.spy = undefined;
    }
  });

  it("without an attached element the effect is a no-op, never a throw", () => {
    focus.spy = undefined; // the harness' own ref stays `null`, as before mount
    expect(() => renderIsland(FirstDivisionPrompt, { orgSlug: "riverside", created })).not.toThrow();
  });
});
