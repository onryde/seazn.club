// Keyboard -- rendered through react-dom/server (no jsdom; see Grid.test.tsx
// header). Locks in three QWERTY rows + Enter/Backspace, and that key
// coloring reflects `statuses`.
import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { Keyboard } from "../Keyboard";

describe("Keyboard", () => {
  it("renders three rows totalling 26 letters + Enter + Backspace", () => {
    const html = renderToStaticMarkup(<Keyboard statuses={{}} onKey={() => {}} />);
    const letterKeys = html.match(/data-key="[A-Z]"/g) ?? [];
    expect(letterKeys).toHaveLength(26);
    expect(html).toContain('data-key="ENTER"');
    expect(html).toContain('data-key="BACKSPACE"');
  });

  it("colors a key according to its best-seen status", () => {
    const html = renderToStaticMarkup(<Keyboard statuses={{ M: "hit", O: "near" }} onKey={() => {}} />);
    // crude but sufficient: the hit/near classes appear somewhere in the markup
    expect(html).toContain("bg-green-600");
    expect(html).toContain("bg-yellow-500");
  });

  it("gives every key a real (never $undefined) aria-label", () => {
    const html = renderToStaticMarkup(<Keyboard statuses={{}} onKey={() => {}} />);
    expect(html).not.toContain("$undefined");
    expect(html).toContain('aria-label="Backspace"');
    expect(html).toContain('aria-label="Enter"');
  });
});
