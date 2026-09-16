import { describe, expect, it, afterEach, beforeEach, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

const { track } = vi.hoisted(() => ({ track: vi.fn() }));
vi.mock("@/lib/analytics", () => ({ EVENTS: { SHARE_FIRED: "share_fired" }, track }));

import { shareLinks, ShareBar, type ShareBarLabels } from "../share-bar";
import { propsOf, renderIsland, textOf } from "./_hook-harness";

describe("shareLinks (ShareBar pure helper)", () => {
  beforeEach(() => {
    track.mockClear();
  });

  it("builds an absolute url and a wa.me link with the encoded title + url", () => {
    const { url, wa } = shareLinks(
      "https://seazn.club",
      "/shared/riverside/spring-cup",
      "Spring Cup",
    );
    expect(url).toBe("https://seazn.club/shared/riverside/spring-cup");
    expect(wa).toBe(
      `https://wa.me/?text=${encodeURIComponent("Spring Cup — https://seazn.club/shared/riverside/spring-cup")}`,
    );
  });
});

describe("ShareBar hydration safety", () => {
  const origNav = globalThis.navigator;

  afterEach(() => {
    Object.defineProperty(globalThis, "navigator", {
      value: origNav,
      configurable: true,
      writable: true,
    });
  });

  it("omits the native-share button on first render even when navigator.share is present (avoids hydration mismatch)", () => {
    Object.defineProperty(globalThis, "navigator", {
      value: { share: () => {} },
      configurable: true,
      writable: true,
    });

    const html = renderToStaticMarkup(<ShareBar path="/x" title="Y" labels={LABELS} />);

    expect(html).not.toContain('data-testid="native-share"');
    expect(html).toContain("WA-TEXT");
  });
});

// ── `labels` (Task 12) ─────────────────────────────────────────────────────
// The public competition page renders this row in the ORG's language, so every
// word in it became a prop. Fixture values, not real dictionary copy, and
// PAIRWISE DISTINCT on purpose: what is under test here is which label reaches
// which slot, and two labels that happened to read the same would let a mutant
// swapping them live. The real four-locale copy is asserted where it is
// resolved — the page's own suite and `hub-dictionary.test.ts`.
const LABELS: ShareBarLabels = {
  share: "S-NATIVE",
  whatsapp: "WA-TEXT",
  whatsappAria: "WA-ARIA",
  copy: "COPY-IDLE",
  copied: "COPY-DONE",
};

describe("ShareBar labels", () => {
  it("renders the labels it is given, each in its own slot — and none of the English defaults survive", () => {
    const html = renderToStaticMarkup(<ShareBar path="/x" title="Y" labels={LABELS} />);

    // Positive: the visible text and the SEPARATE accessible name, pinned to
    // the element each belongs to rather than to the document.
    expect(html).toMatch(/<a [^>]*aria-label="WA-ARIA"[^>]*>WA-TEXT<\/a>/);
    expect(html).toMatch(/<button [^>]*>COPY-IDLE<\/button>/);

    // Negative pair: a component that read the prop for one slot and kept its
    // literal for another passes every assertion above.
    expect(html).not.toContain("WhatsApp");
    expect(html).not.toContain("Share on WhatsApp");
    expect(html).not.toContain("Copy link");
  });

  // 44px is the standing mobile tap-target floor, and `.btn` alone is 36
  // (`px-3.5 py-2 text-sm`). `share-button.tsx` reached the same conclusion
  // about its own default for the same reason; this row is the other public
  // share control and had never been measured. Asserted on the element
  // carrying the href/onClick, not on a wrapper — a row's own class is not a
  // tap target.
  it("gives every control a 44px tap target", () => {
    const html = renderToStaticMarkup(<ShareBar path="/x" title="Y" labels={LABELS} />);
    const controls = [...html.matchAll(/<(?:a|button)\b[^>]*class="([^"]*)"[^>]*>/g)];
    expect(controls.length).toBeGreaterThan(0);
    for (const [, cls] of controls) expect(cls, cls).toContain("min-h-11");
  });

  // There is no "no labels" case any more: `labels` is required and the
  // English defaults are gone (Task 16), so a caller that forgets is a tsc
  // error rather than an English row. The four-locale copy each public page
  // passes is asserted in `public-site/__tests__/share-labels.test.tsx`.
});

// The two labels NO server render can reach, and the reason they need their own
// harness: `share` renders only after the mount effect finds `navigator.share`
// (deliberately — it is the hydration-safety contract pinned above), and
// `copied` only after a click resolves. Both are therefore invisible to
// `renderToStaticMarkup` and to a desktop reviewer, which is exactly why the
// prop is all-five-or-none rather than a `Partial`.
describe("ShareBar labels that only exist after mount", () => {
  const origNav = globalThis.navigator;
  const origWin = (globalThis as { window?: unknown }).window;

  beforeEach(() => {
    // The mount effect reads `window.location.origin`; there is no DOM here.
    (globalThis as { window?: unknown }).window = { location: { origin: "https://seazn.club" } };
  });

  afterEach(() => {
    Object.defineProperty(globalThis, "navigator", {
      value: origNav,
      configurable: true,
      writable: true,
    });
    (globalThis as { window?: unknown }).window = origWin;
    vi.useRealTimers();
  });

  it("uses the `share` label on the native-share button once the effect finds navigator.share", () => {
    Object.defineProperty(globalThis, "navigator", {
      value: { share: () => {} },
      configurable: true,
      writable: true,
    });

    const island = renderIsland(ShareBar, { path: "/x", title: "Y", labels: LABELS });

    expect(textOf(island.tree())).toContain("S-NATIVE");
    expect(textOf(island.tree())).not.toContain("Share on WhatsApp");
  });

  it("swaps in the `copied` label after the copy click resolves", async () => {
    vi.useFakeTimers();
    const writeText = vi.fn(async () => {});
    Object.defineProperty(globalThis, "navigator", {
      value: { clipboard: { writeText } },
      configurable: true,
      writable: true,
    });

    const island = renderIsland(ShareBar, { path: "/x", title: "Y", labels: LABELS });
    expect(textOf(island.tree())).toContain("COPY-IDLE");

    const button = island
      .tree()
      .find((el) => el.type === "button" && propsOf(el).children === "COPY-IDLE");
    expect(button, "copy button").toBeTruthy();
    await (propsOf(button!).onClick as () => Promise<void>)();

    expect(writeText).toHaveBeenCalledWith("https://seazn.club/x");
    expect(textOf(island.tree())).toContain("COPY-DONE");
    expect(textOf(island.tree())).not.toContain("COPY-IDLE");

    // …and back, so the label pair is a toggle rather than a one-way write.
    vi.advanceTimersByTime(1500);
    expect(textOf(island.tree())).toContain("COPY-IDLE");
  });
});
