// Spectator W2, Task 16 — the ONE place a public page turns its `public`
// dictionary into `ShareBar`'s five words.
//
// `ShareBar` used to fall back to English defaults ("Copy link", "Copied ✓")
// when a caller passed no labels, and the org news post page passed none — so
// a Spanish club's post said "Copy link" under a Spanish article. The defaults
// are gone (the prop is required, so tsc refuses a caller that forgets), and
// this helper is what callers pass.
//
// Every expectation below is the locale's OWN dictionary value, never an
// English literal checked for absence: nl/fr share words with English
// ("WhatsApp" is the same brand everywhere), and a list of "old English" would
// red on a correct page. The negative half runs only where the two differ and
// neither contains the other, and a premise case proves at least one locale
// differs for every word — or the negative would be decoration.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

const { track } = vi.hoisted(() => ({ track: vi.fn() }));
vi.mock("@/lib/analytics", () => ({
  EVENTS: { SHARE_FIRED: "share_fired", POST_SHARED: "post_shared" },
  track,
}));

import en from "@/dictionaries/en/public.json";
import es from "@/dictionaries/es/public.json";
import fr from "@/dictionaries/fr/public.json";
import nl from "@/dictionaries/nl/public.json";
import { ShareBar } from "@/components/share-bar";
import { propsOf, renderIsland, textOf } from "@/components/__tests__/_hook-harness";
import { shareLabels } from "../share-labels";

const DICTS: Record<string, Record<string, string>> = {
  en: en as Record<string, string>,
  es: es as Record<string, string>,
  fr: fr as Record<string, string>,
  nl: nl as Record<string, string>,
};

/** React escapes text and attributes: fr "l'équipe" ships as "l&#x27;équipe". */
const esc = (s: string) =>
  s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#x27;");
const reEsc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** The English is absent only where it is not also this locale's word. */
const differs = (mine: string, english: string) =>
  mine !== english && !mine.includes(english) && !english.includes(mine);

describe("shareLabels — which dictionary key feeds which ShareBar slot", () => {
  for (const [locale, d] of Object.entries(DICTS)) {
    it(`${locale}: the default reading names no subject ("Share on WhatsApp"), for any public page`, () => {
      expect(shareLabels(d)).toEqual({
        share: d["share.share"],
        // The short brand name is the visible text; the verb is the accessible
        // name. Same split the competition page settled on at 320px.
        whatsapp: d["share.whatsappShort"],
        whatsappAria: d["share.whatsapp"],
        copy: d["share.copy"],
        copied: d["share.copied"],
      });
    });

    it(`${locale}: a competition page names the competition in the accessible name`, () => {
      expect(shareLabels(d, "share.whatsappAria")).toEqual({
        share: d["share.share"],
        whatsapp: d["share.whatsappShort"],
        whatsappAria: d["share.whatsappAria"],
        copy: d["share.copy"],
        copied: d["share.copied"],
      });
    });
  }

  it("every key it reads resolves to a real string in all four locales (a miss renders the dotted key)", () => {
    for (const [locale, d] of Object.entries(DICTS)) {
      for (const v of Object.values(shareLabels(d, "share.whatsappAria"))) {
        expect(v, locale).not.toMatch(/^share\./);
      }
      for (const v of Object.values(shareLabels(d))) expect(v, locale).not.toMatch(/^share\./);
    }
  });
});

describe("ShareBar renders the locale's words, not English", () => {
  it("premise: every server-rendered word differs from English in at least one of es/fr/nl", () => {
    for (const k of ["share.whatsapp", "share.copy"]) {
      expect(
        ["es", "fr", "nl"].some((l) => differs(DICTS[l]![k]!, DICTS.en![k]!)),
        k,
      ).toBe(true);
    }
  });

  for (const [locale, d] of Object.entries(DICTS)) {
    it(`${locale}: the WhatsApp link and the copy button carry ${locale}'s dictionary values`, () => {
      const html = renderToStaticMarkup(<ShareBar path="/x" title="Y" labels={shareLabels(d)} />);

      expect(html).toMatch(
        new RegExp(
          `<a [^>]*aria-label="${reEsc(esc(d["share.whatsapp"]!))}"[^>]*>${reEsc(esc(d["share.whatsappShort"]!))}</a>`,
        ),
      );
      expect(html).toMatch(new RegExp(`<button [^>]*>${reEsc(esc(d["share.copy"]!))}</button>`));

      for (const k of ["share.whatsapp", "share.copy"]) {
        const english = DICTS.en![k]!;
        if (locale !== "en" && differs(d[k]!, english)) {
          expect(html, `${locale} ${k}`).not.toContain(esc(english));
        }
      }
    });
  }
});

// `share` renders only after the mount effect finds `navigator.share`, and
// `copied` only after the click resolves — no server render reaches either, so
// they get the island harness, per locale.
describe("ShareBar's after-mount words come from the locale too", () => {
  const origNav = globalThis.navigator;
  const origWin = (globalThis as { window?: unknown }).window;

  beforeEach(() => {
    (globalThis as { window?: unknown }).window = { location: { origin: "https://seazn.club" } };
  });
  afterEach(() => {
    Object.defineProperty(globalThis, "navigator", { value: origNav, configurable: true, writable: true });
    (globalThis as { window?: unknown }).window = origWin;
    vi.useRealTimers();
  });

  for (const [locale, d] of Object.entries(DICTS)) {
    it(`${locale}: native-share button and the copied toast`, async () => {
      vi.useFakeTimers();
      Object.defineProperty(globalThis, "navigator", {
        value: { share: () => {}, clipboard: { writeText: vi.fn(async () => {}) } },
        configurable: true,
        writable: true,
      });

      const island = renderIsland(ShareBar, { path: "/x", title: "Y", labels: shareLabels(d) });
      expect(textOf(island.tree())).toContain(d["share.share"]);

      const button = island
        .tree()
        .find((el) => el.type === "button" && propsOf(el).children === d["share.copy"]);
      expect(button, "copy button").toBeTruthy();
      await (propsOf(button!).onClick as () => Promise<void>)();

      expect(textOf(island.tree())).toContain(d["share.copied"]);
    });
  }
});
