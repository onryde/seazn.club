// The browser's viewport table is the product's own e2e matrix, read as text
// from apps/web/playwright.config.ts (never imported), plus the bench's
// organiser viewport at 1280 (ruling 39: L1 runs there).
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { ORGANISER_VIEWPORT } from "../../../scripts/bench/lib/drivers/scorer.ts";
import { BROWSER_WIDTHS, UnknownWidth, VIEWPORT, viewportFor } from "../lib/browser/viewports.ts";
import { L2_WIDTHS } from "../lib/pairs.ts";

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

/** Each mobile/tablet project's name and its viewport, in file order. */
function configViewports(): { project: string; width: number; height: number }[] {
  const cfg = readFileSync(resolve(REPO, "apps/web/playwright.config.ts"), "utf8");
  // Anchored on the project's own name, then the FIRST viewport after it; the
  // lazy gap refuses to cross into the next project (no second `name:`).
  const re = /name:\s*"((?:mobile|tablet)-[\w-]+)"(?:(?!name:)[\s\S])*?viewport:\s*\{\s*width:\s*(\d+),\s*height:\s*(\d+)\s*\}/g;
  return [...cfg.matchAll(re)].map((m) => ({ project: m[1], width: Number(m[2]), height: Number(m[3]) }));
}

describe("viewports are the product's e2e matrix", () => {
  it("empty case first: the config parse finds exactly the seven mobile/tablet projects (a regex that found 0 would read vacuously)", () => {
    const vs = configViewports();
    expect(vs.length).toBe(7);
    // And the config holds no viewport the parse skipped.
    expect([...readFileSync(resolve(REPO, "apps/web/playwright.config.ts"), "utf8").matchAll(/viewport:\s*\{/g)].length).toBe(vs.length);
  });

  it("every project's viewport is VIEWPORT at its width", () => {
    const vs = configViewports();
    const wrong = vs.filter((v) => {
      const got = VIEWPORT[v.width as keyof typeof VIEWPORT] as { width: number; height: number } | undefined;
      return got === undefined || got.width !== v.width || got.height !== v.height;
    }).map((v) => `${v.project}: config ${v.width}x${v.height}, VIEWPORT ${JSON.stringify(VIEWPORT[v.width as keyof typeof VIEWPORT])}`);
    expect(vs.length).toBe(7);
    expect(wrong).toEqual([]);
    expect(vs.map((v) => v.width).sort((a, b) => a - b)).toEqual([...L2_WIDTHS].sort((a, b) => a - b));
  });

  it("BROWSER_WIDTHS is [1280, ...L2_WIDTHS] in that order, and VIEWPORT covers exactly those widths", () => {
    expect([...BROWSER_WIDTHS]).toEqual([1280, ...L2_WIDTHS]);
    expect(Object.keys(VIEWPORT).map(Number).sort((a, b) => a - b)).toEqual([...BROWSER_WIDTHS].sort((a, b) => a - b));
  });

  it("VIEWPORT[1280] is the bench's organiser viewport (scorer.ts ORGANISER_VIEWPORT)", () => {
    expect(VIEWPORT[1280]).toEqual({ width: ORGANISER_VIEWPORT.width, height: ORGANISER_VIEWPORT.height });
    expect(VIEWPORT[1280]).toEqual({ width: 1280, height: 900 });
  });

  it("viewportFor answers every declared width and refuses any other by name", () => {
    for (const w of BROWSER_WIDTHS) expect(viewportFor(w)).toBe(VIEWPORT[w]);
    for (const w of [0, 319, 1024, 1280.5, Number.NaN]) expect(() => viewportFor(w), String(w)).toThrow(UnknownWidth);
  });

  it("the table is frozen, entries included (a caller cannot resize a width for everyone)", () => {
    expect(Object.isFrozen(VIEWPORT)).toBe(true);
    const unfrozen = BROWSER_WIDTHS.filter((w) => !Object.isFrozen(VIEWPORT[w]));
    expect(BROWSER_WIDTHS.length).toBe(8);
    expect(unfrozen).toEqual([]);
  });
});
