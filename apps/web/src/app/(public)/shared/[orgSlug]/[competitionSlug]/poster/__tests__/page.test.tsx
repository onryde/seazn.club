// Spectator W2, Task 16 — the printable QR poster speaks the org's language.
//
// Three strings on this page were English in every locale: the QR image's alt
// text, the call to action printed under the code ("Scan for live scores,
// fixtures & standings") and the print button. A Dutch club printing this for
// its clubhouse wall got an English poster.
//
// Each expectation is the locale's own dictionary VALUE, interpolated where the
// template takes a param — never an English literal checked for absence (nl/fr
// share words with English; see `../../__tests__/page.test.tsx:14-27`).
import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { ReactElement } from "react";
import en from "@/dictionaries/en/public.json";
import es from "@/dictionaries/es/public.json";
import fr from "@/dictionaries/fr/public.json";
import nl from "@/dictionaries/nl/public.json";

const DICTS: Record<string, Record<string, string>> = {
  en: en as Record<string, string>,
  es: es as Record<string, string>,
  fr: fr as Record<string, string>,
  nl: nl as Record<string, string>,
};

const state = vi.hoisted(() => ({ locale: "en" }));

vi.mock("@/server/public-site/data", () => ({
  getPublicCompetition: async () => ({
    org: {
      id: "o1",
      name: "Riverside SC",
      slug: "riverside",
      branded: false,
      branding: {},
      logo: null,
      about: null,
      default_locale: state.locale,
      card_payments: false,
    },
    competition: { id: "c1", name: "Autumn Cup", slug: "autumn-cup", branding: {} },
    divisions: [],
    liveNow: [],
  }),
}));

import PosterPage from "../page";

const URL_ = "https://seazn.club/shared/riverside/autumn-cup";
const KEYS = ["qrPoster.qrAlt", "qrPoster.scan", "qrPoster.print"] as const;

const esc = (s: string) =>
  s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#x27;");
const reEsc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const differs = (mine: string, english: string) =>
  mine !== english && !mine.includes(english) && !english.includes(mine);

const render = async () =>
  renderToStaticMarkup(
    (await PosterPage({
      params: Promise.resolve({ orgSlug: "riverside", competitionSlug: "autumn-cup" }),
    })) as ReactElement,
  );

beforeEach(() => {
  state.locale = "en";
});

describe("QR poster page — every visible word is the org locale's", () => {
  it("premise: each key exists in all four locales and differs from English somewhere", () => {
    for (const k of KEYS) {
      for (const [l, d] of Object.entries(DICTS)) expect(typeof d[k], `${l} ${k}`).toBe("string");
      expect(["es", "fr", "nl"].some((l) => differs(DICTS[l]![k]!, DICTS.en![k]!)), k).toBe(true);
    }
    // The alt names the URL it encodes, in every locale.
    for (const [l, d] of Object.entries(DICTS)) expect(d["qrPoster.qrAlt"], l).toContain("{url}");
  });

  for (const [locale, d] of Object.entries(DICTS)) {
    it(`${locale}: QR alt, call to action and print button carry ${locale}'s dictionary values`, async () => {
      state.locale = locale;
      const html = await render();

      expect(html).toMatch(
        new RegExp(`<img [^>]*alt="${reEsc(esc(d["qrPoster.qrAlt"]!.replace("{url}", URL_)))}"`),
      );
      expect(html).toContain(`>${esc(d["qrPoster.scan"]!)}</p>`);
      expect(html).toMatch(new RegExp(`<button [^>]*>[^<]*${reEsc(esc(d["qrPoster.print"]!))}</button>`));
      expect(html).not.toContain("{url}");

      if (locale !== "en") {
        for (const k of KEYS) {
          const english = DICTS.en![k]!.replace("{url}", URL_);
          const mine = d[k]!.replace("{url}", URL_);
          if (differs(mine, english)) expect(html, `${locale} ${k}`).not.toContain(esc(english));
        }
      }
    });
  }
});
