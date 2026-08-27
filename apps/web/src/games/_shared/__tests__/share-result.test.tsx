// ShareResult — button that copies text via navigator.clipboard, falling
// back to a selectable <textarea> when the API is missing or fails (repo
// policy: "Clipboard API missing → textarea fallback", see the design doc's
// "Error handling" section).
//
// This vitest environment runs under Node (no jsdom — see use-game-store's
// test header for the same fact across this game toolkit), so there is no
// way to fire a real click and watch the button's post-click state. Same
// pattern the design doc itself uses for W2's drag input ("Unit: drag
// reducer … pure function, no DOM"): the copy/fallback DECISION is pulled
// out into `copyShareText`, a plain async function with no DOM
// dependency, and tested directly here for both paths. The actual
// post-click DOM (button text flips to "Copied", or a <textarea> appears)
// is for Daily Word/2048's own e2e once a real page exists to click on.
import { afterEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { copyShareText, ShareResult } from "../share-result";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("copyShareText", () => {
  it("resolves 'copied' and calls writeText with the exact text on success", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    const result = await copyShareText("Seazn Word #12 3/6", { writeText });
    expect(result).toBe("copied");
    expect(writeText).toHaveBeenCalledWith("Seazn Word #12 3/6");
  });

  it("resolves 'fallback' when the Clipboard API is missing", async () => {
    expect(await copyShareText("text", undefined)).toBe("fallback");
    expect(await copyShareText("text", null)).toBe("fallback");
  });

  it("resolves 'fallback' when writeText rejects (e.g. permission denied)", async () => {
    const writeText = vi.fn().mockRejectedValue(new Error("denied"));
    expect(await copyShareText("text", { writeText })).toBe("fallback");
  });
});

describe("ShareResult (rendered through react-dom/server — no jsdom in this workspace)", () => {
  it("renders a button with the default label and no textarea before any interaction", () => {
    const html = renderToStaticMarkup(<ShareResult text="Seazn Word #12 3/6" />);
    expect(html).toContain("<button");
    expect(html).toContain("Share result");
    expect(html).not.toContain("<textarea");
  });

  it("renders a custom label when given", () => {
    const html = renderToStaticMarkup(<ShareResult text="2048 score: 4096" label="Share score" />);
    expect(html).toContain("Share score");
  });
});
