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
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { renderToStaticMarkup } from "react-dom/server";
import en from "@/dictionaries/en/public.json";
import es from "@/dictionaries/es/public.json";
import fr from "@/dictionaries/fr/public.json";
import nl from "@/dictionaries/nl/public.json";
import type { Dict } from "@/lib/i18n-constants";
import type { ResolvedSponsor } from "@/server/usecases/sponsors";
import { SponsorsBoard, SponsorsHeroTitle, sponsorHref } from "../sponsors-board";

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

type Over = { sponsors?: ResolvedSponsor[]; tiered?: boolean; locale?: string };

const render = (over: Over = {}) =>
  renderToStaticMarkup(
    <SponsorsBoard
      sponsors={over.sponsors ?? [TITLE, GOLD, SILVER, PARTNER]}
      tiered={over.tiered ?? true}
      dict={DICTS[over.locale ?? "en"]!}
    />,
  );

/** The hero lockup. Takes the SAME whole list as the board — neither component
 *  is handed a slice, so the page cannot split it wrongly. */
const renderHero = (over: Over = {}) =>
  renderToStaticMarkup(
    <SponsorsHeroTitle
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

// ── THE SPLIT (owner ruling 2026-09-12, Option B) ──────────────────────────
// The title tier is drawn in the HERO and everyone else on the board, and both
// components take the org's whole list. So the first thing to pin is that each
// one draws its own tiers and nothing else: a component that rendered the
// whole list would look correct in isolation and print every sponsor twice on
// the page.
describe("SponsorsHeroTitle — the hero lockup", () => {
  it("draws the title sponsor as the whole SENTENCE, and nobody else", () => {
    const h = renderHero();
    // The key is "Presented by {sponsor}" — a sentence in all four locales, so
    // it is never split into a label above and a name below. A fixed lockup
    // pins English word order into the markup.
    expect(h).toContain(`data-testid="mh-hero-sponsor"`);
    expect(h).toContain("Presented by Northbank Bank");
    // The negative pair, and it is the one that catches a component rendering
    // the list it was handed rather than its own tier.
    for (const name of ["Halston Tyres", "Cobb Dairy", "Vale Physio"]) {
      expect(h, name).not.toContain(name);
    }
  });

  it("renders NOTHING when there is no title sponsor, so the caller needs no predicate", () => {
    expect(renderHero({ sponsors: [GOLD, SILVER, PARTNER] })).toBe("");
    expect(renderHero({ sponsors: [] })).toBe("");
  });

  it("renders nothing for an un-tiered org even when a row still carries a title tier", () => {
    // Bought, then downgraded. Without Pro `sponsors.tiers` there is no title
    // tier to sell, so the hero placement does not come back.
    expect(renderHero({ tiered: false })).toBe("");
  });

  it("draws every title sponsor when an org sold more than one", () => {
    const second = s({ name: "Kestrel Kit", tier: "title" });
    const h = renderHero({ sponsors: [TITLE, second] });
    expect(h).toContain("Presented by Northbank Bank");
    expect(h).toContain("Presented by Kestrel Kit");
  });

  it("carries min-w-0 down the whole chain, and wraps rather than truncating", () => {
    // A long sponsor name in a flex child that cannot shrink is the shape that
    // put 106px of horizontal overflow on a phone once already. And the name is
    // what the sponsor paid for, so it WRAPS — `truncate` would cut it off.
    const h = renderHero({ sponsors: [TITLE] });
    expect(h).toContain("flex-wrap");
    expect(h).not.toContain("truncate");
    // Every element between the root and the text, not just the root: a
    // `min-w-0` that reaches only the outermost box does nothing.
    expect(h.match(/min-w-0/g)?.length).toBeGreaterThanOrEqual(3);
  });

  it("marks the hero link as sponsored and opens it away from the competition", () => {
    expect(renderHero({ sponsors: [TITLE] })).toMatch(
      /<a href="\/s\/sp-title" target="_blank" rel="nofollow noopener sponsored"/,
    );
  });
});

describe("SponsorsBoard — the tiered board", () => {
  it("draws the sized panels and the partner ticker, each in its own section", () => {
    const h = render();

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

  it("leaves the TITLE sponsor to the hero — it is not on the board in any form", () => {
    // The other half of the split, and the half a half-done move breaks: the
    // board is handed the whole list and must ignore the title row rather than
    // reproduce it as a panel, a ticker entry or a second "Presented by".
    const h = render();
    expect(h).not.toContain("Northbank Bank");
    expect(h).not.toContain("Presented by");
    expect(h).not.toContain(`data-testid="mh-sponsors-title"`);
    // Positive pair: the rest of the list IS on the board, so this is the
    // title row being excluded rather than the board failing to render.
    expect(h).toContain("Halston Tyres");
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

    const onlyPanels = render({ sponsors: [GOLD] });
    expect(onlyPanels).toContain(`data-testid="mh-sponsors-panels"`);
    expect(onlyPanels).not.toContain(`data-testid="mh-sponsors-partners"`);
  });

  it("renders NOTHING — not an empty heading — when it has no tier of its own to draw", () => {
    // This board owns an `<h2>`, so an empty one reads as content that failed
    // to load. Returning null is what lets `page.tsx` mount it unconditionally
    // instead of duplicating the "is there anything to show" question.
    //
    // A tiered org whose ONLY sponsor is the title one reaches exactly this
    // state: the hero has the sponsor and the board has nobody.
    expect(render({ sponsors: [TITLE] })).toBe("");
    expect(render({ sponsors: [] })).toBe("");
    expect(render({ sponsors: [], tiered: false })).toBe("");
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
    const flat = render({ sponsors: [GOLD], tiered: false });
    expect(flat).not.toContain("font-display");
    // The tiered render of the same single sponsor is the differential half:
    // without it this only proves the string is absent from some markup.
    expect(render({ sponsors: [GOLD] })).toContain("font-display");
  });

  // A title-tier row on a free org's strip must be the same size as every
  // other chip — the mutation sweep found the earlier version of this, where
  // dropping the `tiered ?` guard from the sizing lookup survived every other
  // assertion in the file because the tiered SECTIONS were empty by then and
  // the table was reached only from the logo. A free org would have shown an
  // oversized mark on a strip whose every other mark is 20px.
  //
  // Since the split the differential half lives in the HERO rather than on the
  // board, which is a sharper pair than the old one: the same sponsor row, the
  // same logo, sized by which PLACEMENT drew it.
  it("sizes a title-tier sponsor's logo like a partner's on a free org's strip", () => {
    const titleWithLogo = s({ name: "Northbank Bank", tier: "title", logo: "/uploads/nb.png" });

    const flat = render({ sponsors: [titleWithLogo], tiered: false });
    expect(flat).toContain("h-5 w-5");
    expect(flat).toContain("width=\"20\"");
    expect(flat).not.toContain("h-10 w-10");

    // Differential half — the same sponsor, tiered, gets the hero's size.
    const hero = renderHero({ sponsors: [titleWithLogo] });
    expect(hero).toContain("h-10 w-10");
    expect(hero).toContain("width=\"40\"");
    expect(hero).not.toContain("h-5 w-5");
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

  // ── THE POINTER THAT KEEPS THE next/image CONTRACT DISCOVERABLE ──────────
  // This component's `<Image>` call site is pinned by
  // `lib/__tests__/public-image-contract.test.ts` (imports `Image`, keeps its
  // width/height pair, has not reverted to a plain `<img>`) — a source-text
  // contract, because the repo has no render harness for CLS.
  //
  // That file lives in `src/lib/__tests__`, which THIS wave's test gate
  // (`"src/app/(public)/shared"` + `src/components/public-site`) does not
  // select. Lifting the board here reddened it, and that was found only by
  // running wider than the dispatch asked for — luck, not process. So the
  // pointer is a test rather than a comment: if the contract is repointed away
  // from this file or deleted, the guard is gone and THIS suite says so, from
  // inside the gate that actually runs.
  it("is still named by the public next/image source contract", () => {
    const contract = readFileSync(
      join(__dirname, "..", "..", "..", "lib", "__tests__", "public-image-contract.test.ts"),
      "utf8",
    );
    expect(contract).toContain("components/public-site/sponsors-board.tsx");
    // Not just the path — the parameter the width/height pair is matched on, so
    // a rename that silences the contract reds here too. Both dimensions are
    // the SAME identifier since the board and the hero were given one logo
    // site, which is why they cannot drift apart.
    expect(contract).toContain('width: "px"');
    expect(contract).toContain('height: "px"');
    // …and not just the NAMES. Re-review N3: emptying the contract's two
    // width/height assertion bodies left both suites 24/24 green, because a
    // hollowed contract still mentions this file and still mentions the helper.
    // A pointer that only proves the contract SPEAKS of us is satisfied by a
    // contract that asserts nothing, so the assertions themselves are pinned.
    for (const assertion of [
      "toContain(`width={${width}}`)",
      "toContain(`height={${height}}`)",
    ]) {
      expect(contract, `the contract still ASSERTS: ${assertion}`).toContain(assertion);
    }
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
      // Both placements, because the sentence and the two labels no longer live
      // in one component and a per-component check would leave one untested.
      const h = render({ locale }) + renderHero({ locale });

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
