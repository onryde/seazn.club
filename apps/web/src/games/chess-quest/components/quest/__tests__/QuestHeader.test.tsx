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

// Phone composition — design of record: scratchpad games-phone-options.html,
// "Quest hub on a phone" ("Header"). Title on its own row, then the four
// device controls as 44px icon buttons on one row; the lede and the land-badge
// shelf are desktop-only. One DOM: every phone rule is `max-md:*`, so ≥768
// renders today's header.
describe("QuestHeader — phone composition (title row + icon row, no lede or badges)", () => {
  const html = renderToStaticMarkup(
    <ProgressProvider>
      <CopyProvider>
        <QuestHeader onOpenProfiles={() => {}} onOpenProgress={() => {}} />
      </CopyProvider>
    </ProgressProvider>,
  );

  // Anchored on the quote/space before the token: a bare /\bmd:hidden\b/
  // also matches inside "max-md:hidden" and would pass on its inversion.
  const cls = (name: string) =>
    new RegExp(`["\\s]${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}[\\s"]`);

  const tagWith = (attr: string) => {
    const at = html.indexOf(attr);
    expect(at, `no element carries ${attr}`).toBeGreaterThan(-1);
    return html.slice(html.lastIndexOf("<", at), html.indexOf(">", at) + 1);
  };

  const DEVICE_BUTTONS = ["Players", "Progress", "Mute sounds", "Turn coach voice off"];

  it("stacks the title above the controls on phones only", () => {
    const row = tagWith('data-cq-slot="header-row"');
    expect(row).toMatch(cls("max-md:flex-col"));
    // Still the wrapping row at ≥768 (see this file's first regression).
    expect(row).toMatch(cls("flex-wrap"));
  });

  it("gives all four device controls a 44px phone tap target and a stable accessible name", () => {
    for (const label of DEVICE_BUTTONS) {
      const tag = tagWith(`aria-label="${label}"`);
      expect(tag, `${label} is not 44px on phones`).toMatch(cls("max-md:h-11"));
      expect(tag, `${label} is not 44px on phones`).toMatch(cls("max-md:w-11"));
      expect(tag, `${label} is hidden at every width`).not.toMatch(cls("hidden"));
    }
  });

  it("drops the button labels to icons on phones without dropping them from the DOM", () => {
    // The visible text stays for ≥768; only its own span folds away, so the
    // accessible name (the aria-label above) is identical at every width.
    for (const text of ["Players", "Progress"]) {
      const at = html.indexOf(`>${text}`);
      expect(at, `no visible "${text}" label`).toBeGreaterThan(-1);
      const span = html.slice(html.lastIndexOf("<span", at), at + 1);
      expect(span, `the "${text}" label is not folded on phones`).toMatch(cls("max-md:hidden"));
    }
  });

  it("renders the lede once, desktop-only — phones get no lede and no About fold", () => {
    // The first phone build folded the lede behind a <details>; driven live at
    // 320 that fold plus the badge shelf pushed today's Play button to 824px.
    // The lede is now a single ≥768 paragraph: one copy, hidden on phones.
    expect(html).not.toContain("About the quest");
    expect(html).not.toContain("<details");
    const lede = "One focused lesson every other day";
    const copies = html.split(lede).length - 1;
    expect(copies, "the lede should render exactly once").toBe(1);
    const paraAt = html.lastIndexOf(lede);
    const para = html.slice(html.lastIndexOf("<p", paraAt), paraAt);
    expect(para).toMatch(cls("max-md:hidden"));
    expect(para).not.toMatch(cls("md:hidden"));
  });

  it("keeps the progress bar at every width and the land-badge shelf on desktop only", () => {
    expect(html).toContain("Quest progress");
    const badges = tagWith('data-cq-slot="land-badges"');
    expect(badges).toMatch(cls("max-md:hidden"));
    expect(badges).not.toMatch(cls("md:hidden"));
  });

  it("tightens the title on phones without changing the desktop size", () => {
    const at = html.indexOf("Chess Quest");
    const h2 = html.slice(html.lastIndexOf("<h2", at), at);
    expect(h2).toMatch(cls("max-md:text-xl"));
    expect(h2).toMatch(cls("text-2xl"));
  });
});
