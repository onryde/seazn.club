// Every dialog surface must measure itself against the DYNAMIC viewport.
//
// `vh` is the LARGE viewport: it ignores retractable mobile browser chrome, so
// a panel capped at 85vh is measured against a box taller than what the user
// can see. The half of the bug that is easy to miss lives on the OVERLAY, not
// the panel — `fixed inset-0` also resolves against the large viewport, so
// `items-end` bottom-aligns the sheet to an edge under the chrome no matter how
// short the panel is.
//
// These are source-level assertions on purpose. The seven-width Playwright
// matrix CANNOT catch this class: headless Chrome has no retractable chrome, so
// `100dvh === 100vh` at every width it runs. jsdom does not apply Tailwind
// either. Reading the class strings is the only gate that actually fails on a
// revert.
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const read = (rel: string): string =>
  readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");

const SHEETS = [
  { name: "components/modal.tsx", src: () => read("../modal.tsx") },
  { name: "components/ui/confirm-provider.tsx", src: () => read("../ui/confirm-provider.tsx") },
  { name: "components/v2/duplicates-panel.tsx", src: () => read("../v2/duplicates-panel.tsx") },
];

describe("dialog surfaces use dynamic viewport units", () => {
  it.each(SHEETS)("$name caps its panel in dvh, never vh", ({ src }) => {
    const text = src();
    expect(text).toMatch(/max-h-\[\d+dvh\]/);
    expect(text).not.toMatch(/max-h-\[\d+vh\]/);
  });

  it("the .modal-overlay does not use inset-0", () => {
    // `inset-0` is the large viewport. `top-0 h-dvh` is the visible one — and
    // the overlay is what `items-end` aligns against, so the panel's own cap
    // cannot compensate for getting this wrong.
    const css = read("../../app/globals.css");
    const rule = css.slice(css.indexOf(".modal-overlay"), css.indexOf(".sheet-handle"));
    expect(rule).toContain("h-dvh");
    expect(rule).not.toMatch(/\binset-0\b/);
  });

  it("the raw .modal class caps its own height and scrolls", () => {
    // The hand-rolled dialogs in duplicates-panel use this class directly and
    // get no help from components/modal.tsx. It had no cap and no scroll, so
    // content past the fold was unreachable rather than merely scrolled.
    const css = read("../../app/globals.css");
    const rule = css.slice(css.indexOf("\n  .modal {"), css.indexOf(".sheet-handle"));
    expect(rule).toMatch(/max-h-\[\d+dvh\]/);
    expect(rule).toContain("overflow-y-auto");
  });

  it("confirm-provider's overlay gets the same treatment as .modal-overlay", () => {
    const text = read("../ui/confirm-provider.tsx");
    expect(text).toContain("h-dvh");
    expect(text).not.toMatch(/className="fixed inset-0 z-50 flex items-end/);
  });
});
