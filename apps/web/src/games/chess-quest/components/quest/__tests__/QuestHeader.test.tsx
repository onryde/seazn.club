// Rendered through react-dom/server — see Board.test.tsx's header comment
// for why (no jsdom in this workspace).
//
// Regression for a real bug caught by screenshot, not by this test's own
// method: mounting BoardThemePicker made the header's button row FIVE items
// wide with no flex-wrap, which overflowed horizontally at 320px
// (document.body.scrollWidth 397 vs a 320px viewport — confirmed live, then
// confirmed it disappeared when the picker element was removed). A static
// markup test can't reproduce real flexbox layout math, so this only locks
// in the class name that fixes it; the geometry itself was verified with a
// real browser at 320/768/1280 (see the W1 report for screenshots).
import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { ProgressProvider } from "../../../lib/progress";
import { CopyProvider } from "../../../lib/copy";
import { QuestHeader } from "../QuestHeader";

describe("QuestHeader — button row wraps instead of overflowing (W1 regression)", () => {
  it("the Players/Progress/theme/mute/voice row allows wrapping", () => {
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

  it("mounts BoardThemePicker next to the mute toggle", () => {
    const html = renderToStaticMarkup(
      <ProgressProvider>
        <CopyProvider>
          <QuestHeader onOpenProfiles={() => {}} onOpenProgress={() => {}} />
        </CopyProvider>
      </ProgressProvider>,
    );
    expect(html).toContain('aria-label="Board theme"');
  });
});
