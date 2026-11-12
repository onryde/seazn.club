// Owner, 2026-11-12: "close icon is very small in edit and add deal modal ... do that similarly in any sponsor". `closeSize="lg"` is an
// opt-in on the shared Modal: every other caller (~24) keeps the h-7 w-7 "×". Sport-agnostic: no sport sweep.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { ReactElement } from "react";
import { renderIsland } from "@/components/__tests__/_hook-harness";
import { Modal } from "@/components/modal";

const classesOf = (el: ReactElement | undefined): string[] =>
  String((el?.props as { className?: string } | undefined)?.className ?? "").split(/\s+/).filter(Boolean);

function close(closeSize?: "md" | "lg") {
  const island = renderIsland(Modal, { title: "T", onClose: () => {}, children: "x", closeSize });
  const tree = island.tree();
  const el = tree.find((e) => (e.props as { "aria-label"?: string })["aria-label"] === "Close");
  const svg = tree.find((e) => (e.props as { "data-testid"?: string })["data-testid"] === "modal-close-x");
  island.unmount();
  return { el, svg };
}

describe("Modal closeSize", () => {
  beforeEach(() => {
    vi.stubGlobal("document", { activeElement: null, addEventListener: () => {}, removeEventListener: () => {} });
  });
  afterEach(() => vi.unstubAllGlobals());

  it("default callers keep the small close: h-7 w-7, slate-400, a text ×, no svg", () => {
    for (const size of [undefined, "md" as const]) {
      const { el, svg } = close(size);
      expect(classesOf(el)).toEqual(expect.arrayContaining(["h-7", "w-7", "text-slate-400"]));
      expect(classesOf(el)).not.toContain("h-10");
      expect(svg).toBeUndefined();
    }
  });

  it("lg: a 40px button, 44px below md, a 20px stroke-2 X, text-slate-500, same label and hover", () => {
    const { el, svg } = close("lg");
    expect(classesOf(el)).toEqual(
      expect.arrayContaining(["h-10", "w-10", "max-md:h-11", "max-md:w-11", "text-slate-500", "hover:bg-purple-50", "hover:text-purple-700"]),
    );
    expect(classesOf(el)).not.toContain("h-7");
    expect((el!.props as { "aria-label": string })["aria-label"]).toBe("Close");
    const p = svg!.props as { width: string; height: string; strokeWidth: string };
    expect([p.width, p.height, p.strokeWidth]).toEqual(["20", "20", "2"]);
  });

  it("every sponsor Modal asks for lg (the sponsor page, Add deal, Packages)", () => {
    const dir = join(__dirname, "..");
    const files = [
      ...readdirSync(join(dir, "sponsors")).filter((f) => f.endsWith(".tsx")).map((f) => join(dir, "sponsors", f)),
      join(dir, "org-sponsors.tsx"),
    ];
    let checked = 0;
    for (const f of files) {
      const src = readFileSync(f, "utf8");
      for (const m of src.matchAll(/<Modal\b([^>]*?)(?:\n\s*)?>/gs)) {
        checked++;
        expect(m[1], `${f}`).toContain('closeSize="lg"');
      }
    }
    expect(checked, "sponsor Modal call sites checked").toBeGreaterThanOrEqual(3);
  });
});
