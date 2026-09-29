// P2 (Task 14 fix round 2): the embedded Stripe checkout was clipped at 320 — the shared Modal's `p-6` left Stripe's
// iframe 270 px, narrower than its own layout, so the wallet button, the email row and the card box lost their right
// edge. `bleed` lets a caller whose ONLY content is such an iframe run it edge to edge below `md`, while the header keeps
// its inset and the close becomes a 44-px target. At 768 and up nothing changes: every class `bleed` adds is `max-md:`.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ReactElement } from "react";
import { renderIsland } from "@/components/__tests__/_hook-harness";
import { Modal } from "@/components/modal";

const classesOf = (el: ReactElement | undefined): string[] =>
  String((el?.props as { className?: string } | undefined)?.className ?? "").split(/\s+/).filter(Boolean);

function parts(bleed: boolean | undefined) {
  const island = renderIsland(Modal, { title: "Buy match credits", onClose: () => {}, size: "lg" as const, bleed, children: "x" });
  const tree = island.tree();
  const dialog = tree.find((el) => (el.props as { role?: string }).role === "dialog");
  const close = tree.find((el) => (el.props as { "aria-label"?: string })["aria-label"] === "Close");
  const header = tree.find((el) => classesOf(el).includes("justify-between"));
  island.unmount();
  return { dialog, close, header };
}

describe("Modal `bleed` — an iframe-only sheet runs edge to edge on a phone, and nothing moves at 768+", () => {
  beforeEach(() => {
    vi.stubGlobal("document", { activeElement: null, addEventListener: () => {}, removeEventListener: () => {} });
  });
  afterEach(() => vi.unstubAllGlobals());

  it("with bleed: no side padding below md, the header keeps a 16-px inset, and the close is 44 px", () => {
    const { dialog, close, header } = parts(true);
    expect(classesOf(dialog)).toContain("max-md:px-0");
    expect(classesOf(header)).toContain("max-md:px-4");
    expect(classesOf(close)).toEqual(expect.arrayContaining(["max-md:h-11", "max-md:w-11"]));
  });

  it("without it (every other Modal in the app) the classes are exactly what they were", () => {
    let checked = 0;
    for (const bleed of [undefined, false]) {
      const { dialog, close, header } = parts(bleed);
      for (const [name, el] of [["dialog", dialog], ["close", close], ["header", header]] as const) {
        expect(el, `${String(bleed)} ${name}`).toBeDefined();
        expect(classesOf(el).filter((c) => c.startsWith("max-md:")), `${String(bleed)} ${name}`).toEqual([]);
        checked++;
      }
    }
    expect(checked).toBe(6);
  });

  it("≥768 is unchanged: every class bleed adds or removes is a max-md: variant", () => {
    const on = parts(true);
    const off = parts(undefined);
    let checked = 0;
    for (const key of ["dialog", "close", "header"] as const) {
      const a = new Set(classesOf(on[key]));
      const b = new Set(classesOf(off[key]));
      const diff = [...a].filter((c) => !b.has(c)).concat([...b].filter((c) => !a.has(c)));
      expect(diff.length, `${key}: bleed changes nothing`).toBeGreaterThan(0);
      for (const c of diff) expect(c, key).toMatch(/^max-md:/);
      checked += diff.length;
    }
    expect(checked).toBeGreaterThanOrEqual(4);
  });
});
