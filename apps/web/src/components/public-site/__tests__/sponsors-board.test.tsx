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
import { parseClickTag, type BoardClickTag } from "@/lib/sponsor-clicks";
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

type Over = { sponsors?: ResolvedSponsor[]; tiered?: boolean; locale?: string; clickTag?: BoardClickTag; includeTitle?: boolean };

/** The competition page's tag (S10): what every board and hero link claims there. */
const SITE: BoardClickTag = { source: "site" };
/** A match page's tag (D15): that match's fixture. Not a uuid on purpose — the board encodes, it does not validate. */
const MATCH: BoardClickTag = { source: "match", fixtureId: "fx-42" };

const render = (over: Over = {}) =>
  renderToStaticMarkup(
    <SponsorsBoard
      sponsors={over.sponsors ?? [TITLE, GOLD, SILVER, PARTNER]}
      tiered={over.tiered ?? true}
      dict={DICTS[over.locale ?? "en"]!}
      clickTag={over.clickTag ?? SITE}
      includeTitle={over.includeTitle}
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
      clickTag={over.clickTag ?? SITE}
    />,
  );

describe("sponsorHref", () => {
  it("sends a table row through the tracked redirect, tagged with the page it sits on (S10)", () => {
    expect(sponsorHref({ id: "sp-gold", url: "https://halston.example" }, SITE)).toBe("/s/sp-gold?src=site");
    expect(sponsorHref({ id: "sp-gold", url: "https://halston.example" }, MATCH)).toBe("/s/sp-gold?f=fx-42&src=match");
  });

  // The rung that silently stops counting clicks. Blob-shim entries (an org's
  // un-backfilled `branding` jsonb) have no row and therefore no id.
  it("links a blob-shim entry straight out, untagged on either page (normalised by the URL parser)", () => {
    expect(sponsorHref({ id: null, url: "https://halston.example" }, SITE)).toBe("https://halston.example/");
    expect(sponsorHref({ id: null, url: "http://halston.example/deal?x=1" }, MATCH)).toBe("http://halston.example/deal?x=1");
  });

  // Fix round 1, m1: a blob entry is linked STRAIGHT out (no redirect to refuse it), so its href is the one place a
  // stored `javascript:` or `data:` url would go live. React 19 blocks a `javascript:` href but passes `data:` through.
  it("a blob-shim entry whose url is not http(s) gets no link at all (count reported)", () => {
    const refused = ["javascript:alert(document.cookie)", "data:text/html,<script>alert(1)</script>", "ftp://files.example/x", "//evil.example", "halston.example"];
    for (const url of refused) {
      expect(sponsorHref({ id: null, url }, SITE), url).toBeNull();
      expect(sponsorHref({ id: null, url }, MATCH), url).toBeNull();
    }
    expect(refused.length).toBe(5);
    // A table row's link is the tracked redirect either way: the route refuses a bad stored url itself (404).
    expect(sponsorHref({ id: "sp-gold", url: "https://halston.example" }, SITE)).toBe("/s/sp-gold?src=site");
  });

  it("a blob entry with a refused url still renders its NAME, unlinked, on the board", () => {
    const html = render({ sponsors: [s({ name: "Old Faithful", tier: "partner", url: "data:text/html,<script>alert(1)</script>" })], tiered: false });
    expect(html).toContain("Old Faithful");
    expect(html).not.toContain("href=");
  });

  it("is null when the sponsor gave no url at all — with or without an id", () => {
    expect(sponsorHref({ id: "sp-gold", url: null }, SITE)).toBeNull();
    expect(sponsorHref({ id: null, url: null }, MATCH)).toBeNull();
  });
});

// ── CLICK TAGS (S10, spec §3.7, owner ruling D15) ──────────────────────────
// Every tracked link carries the page it sits on, so a sponsor's report can
// say WHERE a click came from. Swept over every link the markup actually
// renders — hero, panels, ticker, flat strip and the match board's title line —
// rather than one sample, and each href is parsed back through the route's
// own reader (`parseClickTag`), never compared to a string built the same way.
describe("click tags — every tracked link says which page it sits on", () => {
  const LINKED = [TITLE, GOLD, PARTNER]; // the rows with an id AND a url (SILVER has neither)
  const hrefsIn = (html: string) => [...html.matchAll(/<a href="([^"]*)"/g)].map((m) => m[1]!.replace(/&amp;/g, "&"));

  for (const [page, tag, html] of [
    ["competition page (board + hero)", SITE, () => render() + renderHero()],
    ["competition page, free org (flat strip)", SITE, () => render({ tiered: false })],
    ["match page (board incl. title)", MATCH, () => render({ clickTag: MATCH, includeTitle: true })],
    ["match page, free org (flat strip)", MATCH, () => render({ clickTag: MATCH, includeTitle: true, tiered: false })],
  ] as const) {
    it(`${page}: each linked sponsor once, each href tagged ${tag.source} (count reported)`, () => {
      const hrefs = hrefsIn(html());
      expect(hrefs.length, "links checked").toBe(LINKED.length);
      for (const href of hrefs) {
        const url = new URL(href, "https://seazn.club");
        expect(url.pathname, href).toMatch(/^\/s\/sp-(title|gold|partner)$/);
        expect(parseClickTag(url.searchParams), href).toEqual(
          tag.source === "match" ? { fixtureId: null, source: "match" } : { fixtureId: null, source: "site" },
        );
        if (tag.source === "match") expect(url.searchParams.get("f"), href).toBe(tag.fixtureId);
      }
      expect(new Set(hrefs.map((h) => h.split("?")[0])).size, "no sponsor linked twice").toBe(LINKED.length);
    });
  }

  it("anchors on the attribute: the match tag is in the href itself (`=\"`), &-escaped as React writes it", () => {
    expect(render({ sponsors: [GOLD], clickTag: MATCH })).toContain(`href="/s/sp-gold?f=fx-42&amp;src=match"`);
    expect(render({ sponsors: [GOLD] })).toContain(`href="/s/sp-gold?src=site"`);
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
      /<a href="\/s\/sp-title\?src=site" target="_blank" rel="nofollow noopener sponsored"/,
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

// ── THE MATCH PAGE'S BOARD (owner rulings D15 + R8) ────────────────────────
// The match page has no hero, so the title tier would otherwise be missing
// from every match page, and its clicks with it. `includeTitle` puts the title
// sponsor at the head of the slab, as the same "Presented by" sentence the
// hero carries. The competition page never sets it: there, the hero has it.
describe("SponsorsBoard — the match page's board (includeTitle)", () => {
  it("leads the slab with the title sentence, then the panels — each once, in that order", () => {
    const h = render({ clickTag: MATCH, includeTitle: true });
    const title = h.indexOf(`data-testid="mh-sponsors-title"`);
    const panels = h.indexOf(`data-testid="mh-sponsors-panels"`);
    expect(title, "the title line is drawn").toBeGreaterThan(-1);
    expect(title, "inside the slab").toBeGreaterThan(h.indexOf(`data-testid="mh-sponsors-board"`));
    expect(panels, "the panels follow it").toBeGreaterThan(title);
    expect(h).toContain("Presented by Northbank Bank");
    expect(h.match(/Northbank Bank/g)?.length, "the title sponsor once").toBe(1);
    // The title line holds the title sponsor only; the panels never repeat it.
    const titleLine = h.slice(title, panels);
    expect(titleLine).not.toContain("Halston Tyres");
    expect(h.slice(panels)).not.toContain("Northbank Bank");
    // Not the hero's lockup: there is no hero on a match page.
    expect(h).not.toContain(`data-testid="mh-hero-sponsor"`);
  });

  it("a tiered org whose only sponsor is the title still gets the slab, holding just the title line", () => {
    const h = render({ sponsors: [TITLE], clickTag: MATCH, includeTitle: true });
    expect(h).toContain(`data-testid="mh-sponsors-board"`);
    expect(h).toContain(`data-testid="mh-sponsors-title"`);
    expect(h).not.toContain(`data-testid="mh-sponsors-panels"`);
    // The competition page's board for the SAME list draws nothing (its hero has the sponsor) — the differential.
    expect(render({ sponsors: [TITLE] })).toBe("");
  });

  it("separates the title line from the panels with a hairline only when both are drawn", () => {
    const both = render({ sponsors: [TITLE, GOLD], clickTag: MATCH, includeTitle: true });
    expect(both).toMatch(/data-testid="mh-sponsors-panels" class="[^"]*border-t border-white\/10/);
    const panelsOnly = render({ sponsors: [GOLD], clickTag: MATCH, includeTitle: true });
    expect(panelsOnly).not.toContain("border-t border-white/10");
  });

  it("a free org gets the flat strip with the title-tier row as a plain name — no title line, no sentence", () => {
    const h = render({ tiered: false, clickTag: MATCH, includeTitle: true });
    expect(h).toContain(`data-testid="mh-sponsors-flat"`);
    expect(h).not.toContain(`data-testid="mh-sponsors-title"`);
    expect(h).not.toContain("Presented by");
    expect(h).toContain("Northbank Bank");
  });

  it("renders NOTHING for no sponsors, with or without the title tier switched in", () => {
    expect(render({ sponsors: [], clickTag: MATCH, includeTitle: true })).toBe("");
    expect(render({ sponsors: [], tiered: false, clickTag: MATCH, includeTitle: true })).toBe("");
  });

  it("carries min-w-0 down the title line's chain and wraps rather than truncating (a 43-character name)", () => {
    const long = s({ name: "Northbank Regional Building Society & Trust", tier: "title", id: "sp-long", url: "https://nb.example" });
    expect(long.name.length).toBe(43);
    const h = render({ sponsors: [long], clickTag: MATCH, includeTitle: true });
    const line = h.slice(h.indexOf(`data-testid="mh-sponsors-title"`));
    expect(line).toContain("flex-wrap");
    expect(h).not.toContain("truncate");
    expect(line.match(/min-w-0/g)?.length).toBeGreaterThanOrEqual(3);
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
    expect(h).toMatch(/<a href="\/s\/sp-gold\?src=site" target="_blank" rel="nofollow noopener sponsored"/);
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
      // The match board's title line is the same dictionary sentence, not a second copy of it.
      const matchBoard = render({ locale, clickTag: MATCH, includeTitle: true });
      expect(matchBoard).toContain(dict["landing.presentedBy"]!.replace("{sponsor}", "Northbank Bank"));

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
