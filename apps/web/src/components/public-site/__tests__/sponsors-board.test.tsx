// Spectator surface W2, Task 12 — the sponsor board, lifted out of the
// competition page.
//
// Two things this file is FOR, beyond "it renders":
//   • the tier encoding is the product. A free org's title-tier row must not
//     be drawn as a title placement, and a Pro org's partner must not be drawn
//     as one either — so every assertion below names the SECTION as well as the
//     sponsor, and the negatives are paired with positives.
//   • the copy is dictionary copy in four locales, and `landing.presentedBy`
//     is a sentence with the sponsor's name inside it. A test that asserted
//     ">Presented by<" would be asserting the shape this lift deliberately
//     stopped rendering.
import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import en from "@/dictionaries/en/public.json";
import es from "@/dictionaries/es/public.json";
import fr from "@/dictionaries/fr/public.json";
import nl from "@/dictionaries/nl/public.json";
import type { Dict } from "@/lib/i18n-constants";
import type { ResolvedSponsor } from "@/server/usecases/sponsors";
import { SponsorsBoard, sponsorHref } from "../sponsors-board";

const DICTS: Record<string, Dict> = { en: en as Dict, es: es as Dict, fr: fr as Dict, nl: nl as Dict };

/** Pairwise-distinct in every field a test reads: a fixture whose two rows
 *  share a name cannot witness a renderer that draws one of them twice. */
const s = (over: Partial<ResolvedSponsor> & Pick<ResolvedSponsor, "name" | "tier">): ResolvedSponsor => ({
  id: null,
  url: null,
  logo: null,
  ...over,
});

const TITLE = s({ name: "Northbank Bank", tier: "title", id: "sp-title", url: "https://northbank.example" });
const GOLD = s({ name: "Halston Tyres", tier: "gold", id: "sp-gold", url: "https://halston.example" });
const SILVER = s({ name: "Cobb Dairy", tier: "silver" });
const PARTNER = s({ name: "Vale Physio", tier: "partner", id: "sp-partner", url: "https://vale.example" });

const render = (over: { sponsors?: ResolvedSponsor[]; tiered?: boolean; locale?: string } = {}) =>
  renderToStaticMarkup(
    <SponsorsBoard
      sponsors={over.sponsors ?? [TITLE, GOLD, SILVER, PARTNER]}
      tiered={over.tiered ?? true}
      dict={DICTS[over.locale ?? "en"]!}
    />,
  );

describe("sponsorHref", () => {
  it("sends a table row through the tracked redirect", () => {
    expect(sponsorHref({ id: "sp-gold", url: "https://halston.example" })).toBe("/s/sp-gold");
  });

  // The rung that silently stops counting clicks. Blob-shim entries (an org's
  // un-backfilled `branding` jsonb) have no row and therefore no id.
  it("links a blob-shim entry straight out", () => {
    expect(sponsorHref({ id: null, url: "https://halston.example" })).toBe("https://halston.example");
  });

  it("is null when the sponsor gave no url at all — with or without an id", () => {
    expect(sponsorHref({ id: "sp-gold", url: null })).toBeNull();
    expect(sponsorHref({ id: null, url: null })).toBeNull();
  });
});

describe("SponsorsBoard — the tiered board", () => {
  it("draws the title sentence, the sized panels and the partner ticker, each in its own section", () => {
    const h = render();

    // The title lockup is the SENTENCE, not a label plus a name: the key is
    // "Presented by {sponsor}" and the lift stopped splitting it.
    const title = h.slice(h.indexOf(`data-testid="mh-sponsors-title"`));
    expect(title).toContain("Presented by Northbank Bank");

    const panels = h.slice(h.indexOf(`data-testid="mh-sponsors-panels"`), h.indexOf(`data-testid="mh-sponsors-partners"`));
    expect(panels).toContain("Halston Tyres");
    expect(panels).toContain("Cobb Dairy");
    // Negative pair for the slice above: the title sponsor is NOT one of the
    // panels, and the partner is not either.
    expect(panels).not.toContain("Northbank Bank");
    expect(panels).not.toContain("Vale Physio");

    const partners = h.slice(h.indexOf(`data-testid="mh-sponsors-partners"`));
    expect(partners).toContain("Vale Physio");
    expect(partners).not.toContain("Halston Tyres");
  });

  it("keeps the flat strip off a tiered board entirely", () => {
    const h = render();
    expect(h).toContain(`data-testid="mh-sponsors-board"`);
    expect(h).not.toContain(`data-testid="mh-sponsors-flat"`);
  });

  // Each tier's own section is conditional, so a board with only one tier
  // populated must not render the others' chrome. Three documents, not one.
  it("omits the sections a competition has no sponsors for", () => {
    const onlyPartners = render({ sponsors: [PARTNER] });
    expect(onlyPartners).not.toContain(`data-testid="mh-sponsors-board"`);
    expect(onlyPartners).toContain(`data-testid="mh-sponsors-partners"`);

    const onlyTitle = render({ sponsors: [TITLE] });
    expect(onlyTitle).toContain(`data-testid="mh-sponsors-title"`);
    expect(onlyTitle).not.toContain(`data-testid="mh-sponsors-panels"`);
    expect(onlyTitle).not.toContain(`data-testid="mh-sponsors-partners"`);

    const onlyPanels = render({ sponsors: [GOLD] });
    expect(onlyPanels).toContain(`data-testid="mh-sponsors-panels"`);
    expect(onlyPanels).not.toContain(`data-testid="mh-sponsors-title"`);
  });

  // The divider between the title lockup and the panels below it only earns
  // its place when there is something below.
  it("rules off the title lockup only when panels follow it", () => {
    expect(render({ sponsors: [TITLE, GOLD] })).toMatch(
      /data-testid="mh-sponsors-title"[^>]*class="[^"]*border-b/,
    );
    expect(render({ sponsors: [TITLE] })).not.toMatch(
      /data-testid="mh-sponsors-title"[^>]*class="[^"]*border-b/,
    );
  });
});

describe("SponsorsBoard — the free strip", () => {
  // The product rule this component exists for: without Pro `sponsors.tiers`
  // a community sponsor must not read like a paid title placement, whatever
  // the row's own tier column says.
  it("collapses every tier to the flat strip, including a title-tier row", () => {
    const h = render({ tiered: false });

    expect(h).toContain(`data-testid="mh-sponsors-flat"`);
    expect(h).not.toContain(`data-testid="mh-sponsors-board"`);
    expect(h).not.toContain(`data-testid="mh-sponsors-title"`);
    expect(h).not.toContain(`data-testid="mh-sponsors-partners"`);
    // Positive pair: the sponsors are all still on the page, just level.
    for (const name of ["Northbank Bank", "Halston Tyres", "Cobb Dairy", "Vale Physio"]) {
      expect(h, name).toContain(name);
    }
    // …and the title sponsor is rendered as its NAME, never as the
    // "presented by" sentence.
    expect(h).not.toContain("Presented by");
  });

  it("draws no display type at all on the flat strip", () => {
    const flat = render({ sponsors: [TITLE], tiered: false });
    expect(flat).not.toContain("text-3xl");
    // The tiered render of the same single sponsor is the differential half:
    // without it this only proves the string is absent from some markup.
    expect(render({ sponsors: [TITLE] })).toContain("text-3xl");
  });

  // The ONE place the per-sponsor tier lookup is still reachable when the org
  // is not tiered — and the mutation sweep is how that was found. Dropping
  // `tiered ?` from the panel lookup survived every other assertion in this
  // file, because the three tiered SECTIONS are already empty by then, so the
  // sizing table is only consulted from the logo. A free org with a
  // title-tier row and a logo would have shown a 48px mark on a strip whose
  // every other mark is 20px.
  it("sizes a title-tier sponsor's logo like a partner's when the org is not tiered", () => {
    const titleWithLogo = s({ name: "Northbank Bank", tier: "title", logo: "/uploads/nb.png" });

    const flat = render({ sponsors: [titleWithLogo], tiered: false });
    expect(flat).toContain("h-5 w-5");
    expect(flat).not.toContain("h-12 w-12");

    // Differential half — the same sponsor, tiered, gets the title size.
    const board = render({ sponsors: [titleWithLogo] });
    expect(board).toContain("h-12 w-12");
    expect(board).not.toContain("h-5 w-5");
  });
});

describe("SponsorsBoard — links and logos", () => {
  it("marks a sponsored link for crawlers and opens it away from the competition", () => {
    const h = render({ sponsors: [GOLD] });
    expect(h).toMatch(/<a href="\/s\/sp-gold" target="_blank" rel="nofollow noopener sponsored"/);
  });

  it("renders a sponsor with no url as plain text, not as an empty link", () => {
    const h = render({ sponsors: [SILVER] });
    expect(h).toContain("Cobb Dairy");
    expect(h).not.toContain("<a ");
  });

  it("renders a logo only for the sponsors that have one", () => {
    const withLogo = s({ name: "Kestrel Kit", tier: "gold", logo: "/uploads/kestrel.png" });
    const h = render({ sponsors: [withLogo, SILVER] });
    const imgs = [...h.matchAll(/<img\b/g)];
    expect(imgs).toHaveLength(1);
  });
});

describe("SponsorsBoard — four locales", () => {
  // Compared against each locale's OWN dictionary value, never a table typed
  // in here. `landing.sponsors` is byte-identical in en/fr/nl ("Sponsors" is
  // the word in all three), so a hardcoded ">Sponsors<" absence check would
  // red on a perfectly correct Dutch page.
  for (const locale of ["en", "es", "fr", "nl"]) {
    it(`${locale}: the heading, the title sentence and the partner label all come from the dictionary`, () => {
      const dict = DICTS[locale] as Record<string, string>;
      const h = render({ locale });

      expect(h).toContain(dict["landing.sponsors"]!);
      expect(h).toContain(dict["landing.partners"]!);
      expect(h).toContain(dict["landing.presentedBy"]!.replace("{sponsor}", "Northbank Bank"));
      // No raw placeholder survived interpolation.
      expect(h).not.toContain("{sponsor}");

      // The negative half, skipped only where the locale really does say the
      // same thing as English — which is the whole reason this is derived from
      // the dictionaries rather than from a list of English literals.
      const enDict = en as Record<string, string>;
      if (dict["landing.presentedBy"] !== enDict["landing.presentedBy"]) {
        expect(h).not.toContain("Presented by Northbank Bank");
      }
      if (dict["landing.partners"] !== enDict["landing.partners"]) {
        expect(h).not.toContain(">Partners<");
      }
    });
  }
});
