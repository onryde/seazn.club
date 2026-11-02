// Match Day E1 fix round 1 (m5): the ledger's "Show finished" is a link wearing role="switch". A switch toggles on SPACE as well as Enter
// (ARIA APG), and a link only follows Enter - so Space must do what Enter does. The handler is driven with fake events (apps/web vitest
// has no DOM) and the rendered markup is checked for the switch's wiring; the keypress in a real browser is the competition-desk e2e.
import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { routes } from "@/lib/routes";
import { SwitchLink, switchLinkKeyDown, type SwitchKeyEvent } from "../switch-link";

function key(k: string, extra: Partial<SwitchKeyEvent> = {}) {
  const click = vi.fn();
  const preventDefault = vi.fn();
  const e: SwitchKeyEvent = { key: k, repeat: false, ctrlKey: false, metaKey: false, altKey: false, shiftKey: false, defaultPrevented: false, preventDefault, currentTarget: { click }, ...extra };
  return { e, click, preventDefault };
}

describe("switchLinkKeyDown", () => {
  it("Space follows the link (once) and stops the page from scrolling", () => {
    const { e, click, preventDefault } = key(" ");
    switchLinkKeyDown(e);
    expect(preventDefault).toHaveBeenCalledTimes(1);
    expect(click).toHaveBeenCalledTimes(1);
  });

  it("older engines name the key 'Spacebar': the same", () => {
    const { e, click } = key("Spacebar");
    switchLinkKeyDown(e);
    expect(click).toHaveBeenCalledTimes(1);
  });

  it("Enter is left to the browser (a link follows it itself) - no second navigation from us", () => {
    const { e, click, preventDefault } = key("Enter");
    switchLinkKeyDown(e);
    expect(click).not.toHaveBeenCalled();
    expect(preventDefault).not.toHaveBeenCalled();
  });

  it("other keys do nothing", () => {
    let checked = 0;
    for (const k of ["a", "Tab", "Escape", "ArrowRight", "Shift"]) {
      const { e, click, preventDefault } = key(k);
      switchLinkKeyDown(e);
      expect(click, k).not.toHaveBeenCalled();
      expect(preventDefault, k).not.toHaveBeenCalled();
      checked++;
    }
    expect(checked).toBe(5);
  });

  it("a held Space toggles once: the repeats are swallowed (no scroll) but do not navigate again", () => {
    const { e, click, preventDefault } = key(" ", { repeat: true });
    switchLinkKeyDown(e);
    expect(preventDefault).toHaveBeenCalledTimes(1);
    expect(click).not.toHaveBeenCalled();
  });

  it("Space with a modifier is the browser's / assistive tech's, not a toggle", () => {
    let checked = 0;
    for (const mod of ["ctrlKey", "metaKey", "altKey", "shiftKey"] as const) {
      const { e, click, preventDefault } = key(" ", { [mod]: true });
      switchLinkKeyDown(e);
      expect(click, mod).not.toHaveBeenCalled();
      expect(preventDefault, mod).not.toHaveBeenCalled();
      checked++;
    }
    expect(checked).toBe(4);
  });

  it("a key some other handler already claimed is left alone", () => {
    const { e, click } = key(" ", { defaultPrevented: true });
    switchLinkKeyDown(e);
    expect(click).not.toHaveBeenCalled();
  });
});

describe("SwitchLink markup", () => {
  it("is still a link: an anchor with its href, role and state, and the caller's own props", () => {
    const href = `${routes.competition("org", "comp")}?finished=1`;
    const html = renderToStaticMarkup(
      <SwitchLink href={href} role="switch" aria-checked={false} data-testid="sw" className="x">
        Show finished (2)
      </SwitchLink>,
    );
    expect(html).toMatch(/^<a /);
    expect(html).toContain(`href="${href}"`);
    expect(html).toContain('role="switch"');
    expect(html).toContain('aria-checked="false"');
    expect(html).toContain('data-testid="sw"');
    expect(html).toContain("Show finished (2)");
  });
});
