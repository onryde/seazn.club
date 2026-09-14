// N1e e7 (review-n1d G2) — the org layout frames every /shared page, the
// /present kiosk included, and its header strip ("Live scores · Schedules ·
// Standings") and footer ("Powered by … Seazn Club") were English whatever the
// org's locale. The two keys (`layout.tagline`, `layout.poweredBy`) had shipped
// in all four dictionaries with nothing rendering them. The layout now reads
// them in the org's own `default_locale`, the same rule as every /shared page
// (ISR: the language is the org's, never the visitor's). The brand name stays
// literal.
//
// The layout is an async server component: it is called with its data door
// mocked and the tree it returns is rendered to static markup. Expected text
// is read from the dictionaries, never typed here.
import { describe, expect, it, vi } from "vitest";
import { createElement, type ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

// next/font/google needs the Next build pipeline; the layout only uses the
// returned CSS-variable name.
vi.mock("next/font/google", () => ({
  Barlow_Condensed: () => ({ variable: "--ps-font-display", className: "" }),
}));
const getPublicOrg = vi.fn();
vi.mock("@/server/public-site/data", () => ({
  getPublicOrg: (...a: unknown[]) => getPublicOrg(...a),
}));
vi.mock("@/server/slug-resolve", () => ({ sharedRenameTarget: async () => null }));

import { getDictionary } from "@/lib/i18n";
import { t } from "@/lib/i18n-runtime";
import PublicOrgLayout from "../layout";

const BRAND = "Seazn Club";

async function layoutHtml(locale: string, branded = false): Promise<string> {
  getPublicOrg.mockResolvedValue({
    org: {
      id: "o1",
      name: "Test Org",
      slug: "test-org",
      branded,
      branding: {},
      logo: null,
      about: null,
      default_locale: locale,
    },
    competitions: [],
  });
  const tree = (await PublicOrgLayout({
    children: createElement("p", null, "(page)"),
    params: Promise.resolve({ orgSlug: "test-org" }),
  })) as ReactElement;
  return renderToStaticMarkup(tree);
}

/** The markup's text with every tag removed, so a phrase split by an inline
 *  element (the footer's brand span) reads as the sentence a visitor sees. */
const textOf = (html: string) => html.replace(/<[^>]+>/g, "");
/** The footer template's words before `{brand}`, in a locale. */
const poweredByLead = (template: string) => template.split("{brand}")[0]!.trim();

describe("public org layout — header strip and footer in the org's locale (N1e e7)", () => {
  it("es org: the header strip (both widths) and the footer are the es dictionary's, with the brand literal and no English", async () => {
    const [en, es] = await Promise.all([getDictionary("en", "public"), getDictionary("es", "public")]);
    const html = await layoutHtml("es");
    const text = textOf(html);

    const esTagline = t(es, "layout.tagline");
    expect(esTagline, "the premise: es differs from en").not.toBe(t(en, "layout.tagline"));
    expect(html.split(`>${esTagline}<`).length - 1, "the strip renders twice: inline at sm+, its own line below").toBe(2);
    expect(text).toContain(t(es, "layout.poweredBy", { brand: BRAND }));
    expect(html).toContain(`>${BRAND}</span>`);

    const englishLead = poweredByLead(t(en, "layout.poweredBy"));
    expect(englishLead, "the premise: es words the footer differently").not.toBe(poweredByLead(t(es, "layout.poweredBy")));
    expect(text).not.toContain(t(en, "layout.tagline"));
    expect(text).not.toContain(englishLead);
  });

  it("en org (positive pair): the same probes DO see the en header strip and footer", async () => {
    const en = await getDictionary("en", "public");
    const html = await layoutHtml("en");
    const text = textOf(html);

    expect(html.split(`>${t(en, "layout.tagline")}<`).length - 1).toBe(2);
    expect(text).toContain(t(en, "layout.poweredBy", { brand: BRAND }));
  });

  it("a branded org has no platform footer in any locale", async () => {
    const es = await getDictionary("es", "public");
    const text = textOf(await layoutHtml("es", true));
    expect(text).not.toContain(poweredByLead(t(es, "layout.poweredBy")));
    expect(text).not.toContain(BRAND);
  });
});
