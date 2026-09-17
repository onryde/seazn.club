// The player card's own not-found page (owner ruling 2026-09-17, finding D2).
//
// A refused or absent card used to fall through to `[orgSlug]/not-found.tsx`,
// whose copy is written for an expired REGISTRATION link ("This link is no
// longer valid … ask the organiser to resend the link") and is English
// whatever the org speaks. The card now has a boundary of its own, in the
// org's language, that says only that the player page is not available — the
// same words whether the person never consented, the org is not granted player
// pages, or there is no such person (`not-found-causes-db.test.tsx` drives the
// three causes against Postgres).
//
// `not-found.tsx` takes no props (Next's contract), so it cannot read the org:
// the card's `layout.tsx` provides the org-locale copy through `DictProvider`,
// and the boundary reads it with `useT()`. A layout wraps its own segment's
// not-found boundary, so the copy is there when the page calls `notFound()`.
//
// Markup assertions anchor on `="` (an omitted prop serialises as "$undefined").
import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import en from "@/dictionaries/en/public.json";
import es from "@/dictionaries/es/public.json";
import fr from "@/dictionaries/fr/public.json";
import nl from "@/dictionaries/nl/public.json";
import enUi from "@/dictionaries/en/ui.json";
import esUi from "@/dictionaries/es/ui.json";
import frUi from "@/dictionaries/fr/ui.json";
import nlUi from "@/dictionaries/nl/ui.json";
import type { Dict, Locale } from "@/lib/i18n-constants";

const guard = vi.hoisted(() => ({ locale: "en" }));
vi.mock("@/server/public-site/org-guard", () => ({
  publicOrgOr404: vi.fn(async (orgSlug: string) => ({
    org: { id: "o1", slug: orgSlug, name: "Riverside", default_locale: guard.locale },
    competitions: [],
  })),
}));
vi.mock("next/navigation", async (importOriginal) => ({
  ...(await importOriginal<typeof import("next/navigation")>()),
  useParams: () => ({ orgSlug: "riverside", competitionSlug: "autumn-cup", personId: "p1" }),
}));

import PlayerCardLayout from "../layout";
import PlayerNotFound from "../not-found";

const PUBLIC: Record<Locale, Dict> = { en, es, fr, nl } as Record<Locale, Dict>;
const UI: Record<Locale, Dict> = { en: enUi, es: esUi, fr: frUi, nl: nlUi } as Record<Locale, Dict>;

const esc = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#x27;");

/** The not-found boundary as Next mounts it: inside the card's layout. */
async function renderBoundary(locale: Locale) {
  guard.locale = locale;
  const tree = await PlayerCardLayout({
    params: Promise.resolve({ orgSlug: "riverside", competitionSlug: "autumn-cup", personId: "p1" }),
    children: <PlayerNotFound />,
  });
  const html = renderToStaticMarkup(tree);
  return { html, text: html.replace(/<[^>]+>/g, "") };
}

const copy = (locale: Locale) => ({
  heading: PUBLIC[locale]["player.notFound.heading"] as string,
  body: PUBLIC[locale]["player.notFound.body"] as string,
  cta: PUBLIC[locale]["player.notFound.cta"] as string,
});

describe("player card not-found — its own copy, in the org's language", () => {
  it("every locale carries all three strings, and es/fr/nl are not the English", () => {
    for (const locale of ["en", "es", "fr", "nl"] as const) {
      const c = copy(locale);
      for (const [k, v] of Object.entries(c)) expect(typeof v === "string" && v.length > 0, `${locale} ${k}`).toBe(true);
    }
    for (const locale of ["es", "fr", "nl"] as const) {
      expect(copy(locale).heading, locale).not.toBe(copy("en").heading);
      expect(copy(locale).body, locale).not.toBe(copy("en").body);
      expect(copy(locale).cta, locale).not.toBe(copy("en").cta);
    }
  });

  for (const locale of ["es", "fr", "nl", "en"] as const) {
    it(`${locale} org: the heading, the sentence and the link are that locale's own dictionary values`, async () => {
      const { html } = await renderBoundary(locale);
      const c = copy(locale);
      expect(html).toContain('data-testid="player-not-found"');
      expect(html).toContain(`>${esc(c.heading)}</h1>`);
      expect(html).toContain(`>${esc(c.body)}</p>`);
      expect(html).toContain(`href="/shared/riverside">${esc(c.cta)}</a>`);
    });

    it(`${locale} org: none of the registration-link copy — not in ${locale}, not in English`, async () => {
      const { text } = await renderBoundary(locale);
      for (const dict of [UI[locale], UI.en]) {
        expect(text).not.toContain(dict["shared.notFound.heading"] as string);
        expect(text).not.toContain(dict["shared.notFound.body"] as string);
        expect(text).not.toContain(dict["shared.notFound.cta"] as string);
      }
    });
  }

  it("es org: no English word of the player copy leaks through (a missing key would render the dotted key or English)", async () => {
    const { text } = await renderBoundary("es");
    expect(text).not.toContain("player.notFound");
    expect(text).not.toContain(copy("en").heading);
    expect(text).not.toContain(copy("en").body);
  });
});
