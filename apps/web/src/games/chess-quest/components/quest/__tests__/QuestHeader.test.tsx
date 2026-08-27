// Rendered through react-dom/server — see Board.test.tsx's header comment
// for why (no jsdom in this workspace).
//
// Regression for a real bug caught by screenshot, not by this test's own
// method: a fifth item in the header's button row with no flex-wrap
// overflowed horizontally at 320px (document.body.scrollWidth 397 vs a
// 320px viewport — confirmed live). The board-theme picker that was the
// fifth item is gone (owner ruling 2026-08-27, one white/green board only),
// but flex-wrap stays: it is what keeps the row safe the next time an item
// is added. A static markup test can't reproduce real flexbox layout math,
// so this only locks in the class name that fixes it; the geometry itself
// was verified with a real browser at 320/768/1280.
import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { ProgressProvider } from "../../../lib/progress";
import { CopyProvider } from "../../../lib/copy";
import { QuestHeader } from "../QuestHeader";

describe("QuestHeader — button row wraps instead of overflowing (W1 regression)", () => {
  it("the Players/Progress/mute/voice row allows wrapping", () => {
    const html = renderToStaticMarkup(
      <ProgressProvider>
        <CopyProvider>
          <QuestHeader onOpenProfiles={() => {}} onOpenProgress={() => {}} />
        </CopyProvider>
      </ProgressProvider>,
    );
    // Find the button-group div specifically (holds the mute toggle) rather
    // than asserting on the whole document, so this doesn't pass by
    // coincidentally matching flex-wrap somewhere unrelated.
    const muteAt = html.indexOf("Mute sounds");
    expect(muteAt).toBeGreaterThan(-1);
    const groupStart = html.lastIndexOf('<div class="flex', muteAt);
    const groupTag = html.slice(groupStart, html.indexOf(">", groupStart) + 1);
    expect(groupTag).toContain("flex-wrap");
  });

  // Inverted, not deleted: this probe used to assert the picker WAS mounted.
  // It now guards the ruling that no board-theme control exists at all, so
  // re-adding one reddens here instead of shipping a brown/purple board.
  it("mounts no board-theme control", () => {
    const html = renderToStaticMarkup(
      <ProgressProvider>
        <CopyProvider>
          <QuestHeader onOpenProfiles={() => {}} onOpenProgress={() => {}} />
        </CopyProvider>
      </ProgressProvider>,
    );
    expect(html).not.toContain('aria-label="Board theme"');
    expect(html).not.toContain("Brown");
    expect(html).not.toContain("Purple");
  });
});
