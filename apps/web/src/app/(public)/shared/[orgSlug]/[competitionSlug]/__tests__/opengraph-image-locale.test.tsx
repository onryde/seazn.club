// Spectator W2, Task 16 — the competition share card is drawn in the ORG's
// language.
//
// This PNG is every WhatsApp/iMessage/X preview of the competition link, and it
// drew four pieces of English in every locale: the live pill ("1 live now"),
// the two count chips ("2 divisions", "10 entrants", pluralised by an English
// `s`), and the frame's footer ("Live scores · fixtures · standings"). The page
// behind the link was already Spanish; the preview above it was not.
//
// `next/og`'s ImageResponse is captured and its element tree rendered to
// markup (the same technique as ./opengraph-image-dates.test.tsx). Every
// expectation is the locale's own dictionary value through the SAME plural
// rule the page uses — never an English literal checked for absence (fr
// "divisions" IS the English word).
import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { ReactElement } from "react";
import en from "@/dictionaries/en/public.json";
import es from "@/dictionaries/es/public.json";
import fr from "@/dictionaries/fr/public.json";
import nl from "@/dictionaries/nl/public.json";

const captured: { tree: ReactElement | null } = { tree: null };
vi.mock("next/og", () => ({
  ImageResponse: class {
    constructor(tree: unknown) {
      captured.tree = tree as ReactElement;
    }
  },
}));
const getPublicCompetition = vi.fn();
vi.mock("@/server/public-site/data", () => ({
  getPublicCompetition: (...a: unknown[]) => getPublicCompetition(...a),
}));
vi.mock("@/server/og/poster-image", () => ({ posterImageDataUrl: vi.fn(async () => null) }));

import CompetitionOg from "../opengraph-image";

const DICTS: Record<string, Record<string, string>> = {
  en: en as Record<string, string>,
  es: es as Record<string, string>,
  fr: fr as Record<string, string>,
  nl: nl as Record<string, string>,
};

/** Pairwise-distinct counts, so a chip bound to the wrong number cannot pass
 *  another chip's assertion. 1 live exercises the `.one` form; 2 and 10 the
 *  plural. */
const DIVISIONS = [{ entrant_count: 6 }, { entrant_count: 4 }];
const LIVE = [{ id: "f1" }];

const esc = (s: string) =>
  s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#x27;");

/** The dictionary's own plural form for `count` in `locale`. */
const pl = (locale: string, key: string, count: number) => {
  const d = DICTS[locale]!;
  const form = new Intl.PluralRules(locale).select(count);
  return (d[`${key}.${form}`] ?? d[`${key}.other`]!).replace("{count}", String(count));
};

async function renderCard(locale: string): Promise<string> {
  captured.tree = null;
  getPublicCompetition.mockResolvedValue({
    org: { id: "o1", name: "Test Org", slug: "test-org", branded: false, branding: {}, logo: null, about: null, default_locale: locale },
    competition: {
      id: "c1",
      org_id: "o1",
      name: "Test Comp",
      slug: "test-comp",
      description: null,
      starts_on: null,
      ends_on: null,
      branding: {},
      status: "active",
      visibility: "public" as const,
    },
    divisions: DIVISIONS,
    liveNow: LIVE,
  });
  await CompetitionOg({ params: Promise.resolve({ orgSlug: "test-org", competitionSlug: "test-comp" }) });
  if (!captured.tree) throw new Error("ImageResponse was never constructed");
  return renderToStaticMarkup(captured.tree);
}

describe("competition share card — drawn in the org's locale", () => {
  it("premise: every drawn phrase differs from English in at least one of es/fr/nl", () => {
    const phrases: [string, (l: string) => string][] = [
      ["live", (l) => pl(l, "org.live", 1)],
      ["divisions", (l) => pl(l, "landing.divisions", 2)],
      ["entrants", (l) => pl(l, "landing.entrants", 10)],
      ["tagline", (l) => DICTS[l]!["og.tagline"]!],
    ];
    for (const [name, of] of phrases) {
      expect(["es", "fr", "nl"].some((l) => of(l) !== of("en")), name).toBe(true);
    }
  });

  for (const locale of Object.keys(DICTS)) {
    it(`${locale}: the live pill, both count chips and the footer are ${locale}'s dictionary values`, async () => {
      const html = await renderCard(locale);
      const d = DICTS[locale]!;

      expect(html).toContain(`>${esc(pl(locale, "org.live", 1))}<`);
      expect(html).toContain(`>${esc(pl(locale, "landing.divisions", 2))}<`);
      expect(html).toContain(`>${esc(pl(locale, "landing.entrants", 10))}<`);
      expect(html).toContain(`>${esc(d["og.tagline"]!)}<`);
      expect(html).not.toMatch(/\{count\}/);

      if (locale !== "en") {
        for (const english of [
          pl("en", "org.live", 1),
          pl("en", "landing.entrants", 10),
          DICTS.en!["og.tagline"]!,
        ]) {
          const mine = [pl(locale, "org.live", 1), pl(locale, "landing.entrants", 10), d["og.tagline"]!];
          if (!mine.includes(english)) expect(html, `${locale}: ${english}`).not.toContain(`>${esc(english)}<`);
        }
      }
    });
  }
});
