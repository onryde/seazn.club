// Spectator surface W2, Task 12 — the competition page IS the landing.
//
// What this file has to hold down, in order of how badly it would hurt:
//
//  1. The page renders the landing root at all, with the hub document it
//     fetched — the seam this whole wave exists to close. Four tasks built
//     tabs that nothing mounted.
//  2. The old page is GONE — the divisions grid, its empty sentence, the
//     live-now rail — rather than sitting underneath the new one.
//  3. Not one word of it is hardcoded English any more, in any of the four
//     locales, and the locale is the ORG's.
//  4. The competition's dates are the calendar days the organiser typed.
//
// ── THE SWEEP IN (3) IS DERIVED, NOT TYPED IN ─────────────────────────────
// A list of old English literals checked for absence is a FALSE POSITIVE
// machine on this surface: Dutch `landing.sponsors` is "Sponsors" and Dutch
// `landing.partners` is "Partners", byte-identical to English because that is
// what those words are in Dutch, and French `landing.divisions.other` is
// "{count} divisions". A `not.toMatch(/>Sponsors</)` would red on a perfectly
// correct page. `fixtures/[fixtureId]/__tests__/page.test.ts:24-30` documents
// the same trap for `matchCentre.status.live`.
//
// So every assertion below compares against the locale's OWN dictionary value,
// and the negative half (the English is gone) is applied only where the two
// really differ AND neither contains the other — French "Infos" contains
// English "Info", so demanding the absence of "Info" from a correct French
// page would be the same bug wearing the opposite sign.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { isValidElement, type ReactElement } from "react";
import { propsOf, walk } from "@/components/__tests__/_hook-harness";
import { CompetitionLanding } from "@/components/public-site/matches-hub/competition-landing";
import { ShareBar } from "@/components/share-bar";
import en from "@/dictionaries/en/public.json";
import es from "@/dictionaries/es/public.json";
import fr from "@/dictionaries/fr/public.json";
import nl from "@/dictionaries/nl/public.json";
import { UTC, fmtDate } from "@/lib/format";
import type { CompetitionHubDocT } from "@/server/public-site/competition-hub-schema";
import { division, hubDoc, info, m } from "@/components/public-site/__tests__/hub-fixtures";

const DICTS: Record<string, Record<string, string>> = {
  en: en as Record<string, string>,
  es: es as Record<string, string>,
  fr: fr as Record<string, string>,
  nl: nl as Record<string, string>,
};

const stub = vi.hoisted(() => ({
  getPublicCompetition: vi.fn(),
  getPublicCompetitionHub: vi.fn(),
  resolveSponsors: vi.fn(),
  hasFeature: vi.fn(),
  renderProse: vi.fn(),
  sharedRenameTarget: vi.fn(),
}));

vi.mock("@/server/public-site/data", () => ({ getPublicCompetition: stub.getPublicCompetition }));
vi.mock("@/server/public-site/competition-hub", () => ({
  getPublicCompetitionHub: stub.getPublicCompetitionHub,
}));
vi.mock("@/server/usecases/sponsors", () => ({ resolveSponsors: stub.resolveSponsors }));
vi.mock("@/lib/entitlements", () => ({ hasFeature: stub.hasFeature }));
vi.mock("@/lib/prose", () => ({ renderProse: stub.renderProse }));
vi.mock("@/server/slug-resolve", () => ({ sharedRenameTarget: stub.sharedRenameTarget }));

// `notFound`/`permanentRedirect` throw sentinels rather than Next's own control
// -flow errors, because three of this page's branches END in them and a test
// that only asserted "it threw" could not tell a 404 from a redirect from a
// crash. Everything else in the module stays real.
const nav = vi.hoisted(() => ({
  notFound: vi.fn(() => {
    throw new Error("CALLED_NOT_FOUND");
  }),
  permanentRedirect: vi.fn((to: string) => {
    throw new Error(`CALLED_REDIRECT:${to}`);
  }),
}));
vi.mock("next/navigation", async (importOriginal) => ({
  ...(await importOriginal<typeof import("next/navigation")>()),
  notFound: nav.notFound,
  permanentRedirect: nav.permanentRedirect,
}));

// The hub transport's fetch layer. No effect runs under `renderToStaticMarkup`,
// so nothing polls — this only keeps a real `fetch` out of the module graph.
vi.mock("@/components/public-site/competition-hub-data", () => ({ fetchCompetitionHub: vi.fn() }));

import Page, { generateMetadata } from "../page";

// ---------------------------------------------------------------- fixtures

/** React escapes text and attributes on the way into the markup, so an
 *  expectation taken straight from a dictionary misses: French "S'inscrire"
 *  ships as "S&#x27;inscrire". */
const esc = (s: string) =>
  s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#x27;");

const STARTS_ON = "2026-09-05";
const ENDS_ON = "2026-09-20";
const DATE_OPTS: Intl.DateTimeFormatOptions = { day: "numeric", month: "long", year: "numeric" };

const shell = (over: { locale?: string; description?: string | null; visibility?: string } = {}) => ({
  org: {
    id: "o1",
    name: "Riverside SC",
    slug: "riverside",
    branded: false,
    branding: {},
    logo: null,
    about: null,
    default_locale: over.locale ?? "en",
    card_payments: false,
  },
  competition: {
    id: "c1",
    org_id: "o1",
    name: "Autumn Cup",
    slug: "autumn-cup",
    description: over.description ?? null,
    starts_on: STARTS_ON,
    ends_on: ENDS_ON,
    branding: {},
    status: "active",
    visibility: over.visibility ?? "public",
  },
  divisions: [],
  liveNow: [],
});

/** Two divisions, ten entrants, one live match, registration open — so every
 *  hero chip and both calls to action are on the page at once. The counts are
 *  PAIRWISE DISTINCT (2 / 10 / 1) so a chip bound to the wrong number cannot
 *  satisfy another chip's assertion. */
const doc = (over: { locale?: string } = {}): CompetitionHubDocT =>
  hubDoc({
    locale: over.locale ?? "en",
    matches: [
      m("live-1", "live", "2026-09-05T11:00:00.000Z", "premier"),
      m("up-1", "upcoming", "2026-09-20T11:00:00.000Z", "sunday-league"),
    ],
    divisions: [
      division("premier", { entrantCount: 6 }),
      division("sunday-league", { entrantCount: 4 }),
    ],
    info: info({ startsOn: STARTS_ON, endsOn: ENDS_ON, registrationOpen: true }),
  });

const TITLE_SPONSOR = { id: "sp1", name: "Northbank Bank", url: "https://nb.example", logo: null, tier: "title" as const };
const PARTNER_SPONSOR = { id: "sp2", name: "Vale Physio", url: null, logo: null, tier: "partner" as const };

const render = async (): Promise<string> =>
  renderToStaticMarkup(
    (await Page({
      params: Promise.resolve({ orgSlug: "riverside", competitionSlug: "autumn-cup" }),
    })) as ReactElement,
  );

const forLocale = async (locale: string) => {
  stub.getPublicCompetition.mockResolvedValue(shell({ locale }));
  stub.getPublicCompetitionHub.mockResolvedValue(doc({ locale }));
  stub.hasFeature.mockResolvedValue(true);
  stub.resolveSponsors.mockResolvedValue([TITLE_SPONSOR, PARTNER_SPONSOR]);
  return render();
};

beforeEach(() => {
  vi.clearAllMocks();
  stub.getPublicCompetition.mockResolvedValue(shell());
  stub.getPublicCompetitionHub.mockResolvedValue(doc());
  stub.resolveSponsors.mockResolvedValue([]);
  stub.hasFeature.mockResolvedValue(false);
  stub.renderProse.mockImplementation(async (s: string) => `<p>${s}</p>`);
  stub.sharedRenameTarget.mockResolvedValue(null);
});

// ------------------------------------------------------------- the mount

describe("the competition page mounts the landing", () => {
  it("renders the hero and the landing root with its tab rail, over the fetched document", async () => {
    const h = await render();

    expect(h).toContain(`data-testid="mh-hero"`);
    expect(h).toContain(`data-testid="mh-root"`);
    expect(h).toContain(`data-testid="mh-tab-overview"`);
    // The rail is derived from the DOCUMENT, so a tab that only exists because
    // this document has matches proves the fetched doc reached the root rather
    // than some default.
    expect(h).toContain(`data-testid="mh-tab-matches"`);
    expect(h).not.toContain(`data-testid="mh-tab-table"`);

    // The hero's own content: the competition's name, the share bar, the two
    // calls to action.
    expect(h).toMatch(/<h1[^>]*>Autumn Cup<\/h1>/);
    expect(h).toContain(en["share.copy"]!);
    expect(h).toContain(`data-testid="mh-hero-present"`);
    expect(h).toContain(`data-testid="mh-hero-register"`);
    // The share bar is pointed at THIS competition. `origin` is "" until the
    // bar mounts, so the wa.me text carries the bare path.
    expect(h).toContain(encodeURIComponent("/shared/riverside/autumn-cup"));
  });

  it("asks for the hub with the same slugs it was routed with", async () => {
    await render();
    expect(stub.getPublicCompetitionHub).toHaveBeenCalledWith("riverside", "autumn-cup");
  });

  // The hero's title is the DOCUMENT's, like everything below it. The two can
  // only differ while the page's 30s cache and the hub's own are out of step
  // (a competition renamed in between) — and in that window the honest thing
  // for the heading over a stale document is the stale document's name, not a
  // fresher one from a different read.
  it("titles the hero from the document, not from the shell", async () => {
    stub.getPublicCompetitionHub.mockResolvedValue(
      hubDoc({ name: "Autumn Cup 2026", info: info({ startsOn: STARTS_ON, endsOn: ENDS_ON }) }),
    );
    const h = await render();
    expect(h).toMatch(/<h1[^>]*>Autumn Cup 2026<\/h1>/);
  });

  // The slots are props, and two of the four are only ever rendered inside a
  // panel no server render reaches (the Info tab). Read at the boundary
  // instead: this is the one place the page's whole contract with the landing
  // root is visible at once.
  it("hands the landing root the document, the dictionary, the locale and all three slots", async () => {
    stub.hasFeature.mockResolvedValue(true);
    stub.resolveSponsors.mockResolvedValue([TITLE_SPONSOR]);
    stub.getPublicCompetition.mockResolvedValue(shell({ description: "Since 1894." }));
    const hub = doc();
    stub.getPublicCompetitionHub.mockResolvedValue(hub);

    const mount = walk(
      (await Page({
        params: Promise.resolve({ orgSlug: "riverside", competitionSlug: "autumn-cup" }),
      })) as ReactElement,
    ).find((el) => el.type === CompetitionLanding);
    expect(mount, "CompetitionLanding is mounted").toBeTruthy();
    const props = propsOf(mount!) as Record<string, unknown>;

    expect(props.initial).toBe(hub);
    expect(props.locale).toBe("en");
    expect((props.dict as Record<string, string>)["landing.present"]).toBe(en["landing.present"]);
    // All three slots, each a real element — `shareSlot` in particular, whose
    // only consumer is the Info panel.
    for (const slot of ["sponsorsSlot", "descriptionSlot", "shareSlot"]) {
      expect(isValidElement(props[slot]), slot).toBe(true);
    }
    expect((props.shareSlot as ReactElement).type).toBe(ShareBar);
  });

  // Both hrefs come off the document rather than being rebuilt from the slugs,
  // so the page and the Info tab cannot send a spectator to two different
  // places. A distinct fixture href is what makes that visible.
  it("takes the present and register hrefs from the document", async () => {
    stub.getPublicCompetitionHub.mockResolvedValue(
      hubDoc({
        matches: [m("live-1", "live", "2026-09-05T11:00:00.000Z", "premier")],
        info: info({ registrationOpen: true, presentHref: "/elsewhere/present", registerHref: "/elsewhere/register" }),
      }),
    );
    const h = await render();
    // `next/link` emits `href` LAST, after the className it composes — so the
    // testid and the href are pinned as the SAME element without assuming an
    // attribute order the framework owns.
    expect(h).toMatch(/data-testid="mh-hero-present"[^>]*href="\/elsewhere\/present"/);
    expect(h).toMatch(/data-testid="mh-hero-register"[^>]*href="\/elsewhere\/register"/);
  });

  it("hides the register call to action when the document says registration is closed", async () => {
    stub.getPublicCompetitionHub.mockResolvedValue(
      hubDoc({
        matches: [m("live-1", "live", "2026-09-05T11:00:00.000Z", "premier")],
        info: info({ registrationOpen: false }),
      }),
    );
    const h = await render();
    expect(h).not.toContain(`data-testid="mh-hero-register"`);
    // Positive pair — the rest of the hero is still there, so this is the CTA
    // being gated rather than the hero failing to render.
    expect(h).toContain(`data-testid="mh-hero-present"`);
  });

  it("passes the sponsor board and the competition's prose down as slots, and omits them when there is nothing to show", async () => {
    stub.hasFeature.mockResolvedValue(true);
    stub.resolveSponsors.mockResolvedValue([TITLE_SPONSOR, PARTNER_SPONSOR]);
    stub.getPublicCompetition.mockResolvedValue(shell({ description: "Since 1894." }));

    const withBoth = await render();
    expect(withBoth).toContain(`data-testid="mh-sponsors"`);
    expect(withBoth).toContain("<p>Since 1894.</p>");
    expect(stub.renderProse).toHaveBeenCalledWith("Since 1894.");
    // The Overview's own chrome around each slot.
    expect(withBoth).toContain(`data-testid="mh-sec-description"`);
    expect(withBoth).toContain(`data-testid="mh-sec-sponsors"`);

    // The caller contract both tabs state: `undefined`, never an element that
    // renders nothing — a heading over an absent block reads as content that
    // failed to load.
    vi.clearAllMocks();
    stub.getPublicCompetition.mockResolvedValue(shell());
    stub.getPublicCompetitionHub.mockResolvedValue(doc());
    stub.resolveSponsors.mockResolvedValue([]);
    stub.hasFeature.mockResolvedValue(false);
    const withNeither = await render();
    expect(withNeither).not.toContain(`data-testid="mh-sponsors"`);
    expect(stub.renderProse).not.toHaveBeenCalled();
    // The CHROME, not just the content. `CompetitionProse` returns null for
    // empty html, so a page that passed an element unconditionally would look
    // identical in the prose itself and still open a `space-y-3` section with
    // nothing in it — which is exactly the "content that failed to load" the
    // slot contract exists to prevent. A mutation sweep found this: asserting
    // only `renderProse` was not called left it alive.
    expect(withNeither).not.toContain(`data-testid="mh-sec-description"`);
    expect(withNeither).not.toContain(`data-testid="mh-sec-sponsors"`);
  });

  it("reads the sponsor tier entitlement for this competition and hands the answer to the board", async () => {
    stub.hasFeature.mockResolvedValue(false);
    stub.resolveSponsors.mockResolvedValue([TITLE_SPONSOR]);
    const flat = await render();
    expect(stub.hasFeature).toHaveBeenCalledWith("o1", "sponsors.tiers", "c1");
    expect(stub.resolveSponsors).toHaveBeenCalledWith("o1", "c1", { tiered: false });
    expect(flat).toContain(`data-testid="mh-sponsors-flat"`);

    vi.clearAllMocks();
    stub.getPublicCompetition.mockResolvedValue(shell());
    stub.getPublicCompetitionHub.mockResolvedValue(doc());
    stub.hasFeature.mockResolvedValue(true);
    stub.resolveSponsors.mockResolvedValue([TITLE_SPONSOR]);
    const tiered = await render();
    expect(stub.resolveSponsors).toHaveBeenCalledWith("o1", "c1", { tiered: true });
    expect(tiered).toContain(`data-testid="mh-sponsors-board"`);
  });
});

// ---------------------------------------------------------- the hero chips

describe("the hero's counters", () => {
  it("counts divisions, entrants and live matches off the SAME document the tabs render", async () => {
    const h = await render();
    // Terminated, so "2 divisions" cannot be satisfied by "12 divisions", and
    // pinned per chip so all three cannot be reading one number.
    expect(h).toMatch(/data-testid="mh-hero-divisions"[^>]*>2 divisions</);
    expect(h).toMatch(/data-testid="mh-hero-entrants"[^>]*>10 entrants</);
    expect(h).toContain(`data-testid="mh-hero-live"`);
    expect(h).toMatch(/1 live</);
  });

  // `bucket === "live"` is the predicate `landingStatus` and the Overview's own
  // live rail use. The old page counted a separate `liveNow` query, which is
  // how one page ends up saying two things.
  it("drops the live chip when the document has no live match, and keeps the others", async () => {
    stub.getPublicCompetitionHub.mockResolvedValue(
      hubDoc({
        matches: [m("up-1", "upcoming", "2026-09-20T11:00:00.000Z", "premier")],
        divisions: [division("premier", { entrantCount: 6 })],
        info: info({ startsOn: STARTS_ON, endsOn: ENDS_ON }),
      }),
    );
    const h = await render();
    expect(h).not.toContain(`data-testid="mh-hero-live"`);
    expect(h).toMatch(/data-testid="mh-hero-divisions"[^>]*>1 division</);
    expect(h).toMatch(/data-testid="mh-hero-entrants"[^>]*>6 entrants</);
  });

  it("says so when a competition has no divisions, instead of counting nothing twice", async () => {
    stub.getPublicCompetitionHub.mockResolvedValue(
      hubDoc({ divisions: [], info: info({ startsOn: STARTS_ON, endsOn: ENDS_ON }) }),
    );
    const h = await render();
    expect(h).toMatch(/data-testid="mh-hero-no-divisions"[^>]*>No divisions yet</);
    expect(h).not.toContain(`data-testid="mh-hero-divisions"`);
    expect(h).not.toContain(`data-testid="mh-hero-entrants"`);
  });
});

// ------------------------------------------------------------- the dates

describe("the hero's date line", () => {
  // ── WHY THIS IS SHAPED THE WAY IT IS ────────────────────────────────────
  // `startsOn`/`endsOn` are CALENDAR dates (pg `date`), and the line this page
  // used to draw was `new Date(d).toLocaleDateString("en-GB", …)` with NO
  // `timeZone` — so it formatted in whatever zone the Node process ran in.
  // Production is right only because fly.toml sets no TZ and the machine is
  // UTC.
  //
  // No same-process test can witness that here. Measured on this runner: the
  // default zone is Europe/London (UTC+1 in September, so the zone-less
  // formula renders the correct day), and setting `process.env.TZ` mid-run
  // does NOT move ICU under vitest's worker pool — `before` and `after` both
  // came back "Europe/London". Setting it for the whole invocation DOES:
  //
  //     TZ=America/New_York npx vitest run "src/app/(public)/shared"
  //
  // renders "4 September 2026" for a competition starting on the 5th, and the
  // second assertion below fails. That run is the real witness and it is
  // recorded in the task report; what runs by default is the two assertions
  // that hold on ANY runner.
  const dayIn = (tz: string) =>
    new Date(STARTS_ON).toLocaleDateString("en-GB", { ...DATE_OPTS, timeZone: tz });

  it("shows the calendar days the organiser typed, not the day before them", async () => {
    const h = await render();

    // The fixture is PROVEN differential rather than assumed: if these two ever
    // agreed, everything below would pass on a page that formats in the wrong
    // zone.
    expect(dayIn("America/New_York")).not.toBe(dayIn(UTC));

    expect(h).toMatch(
      new RegExp(`data-testid="mh-hero-dates"[^>]*>${fmtDate(UTC, STARTS_ON, DATE_OPTS)} – ${fmtDate(UTC, ENDS_ON, DATE_OPTS)}<`),
    );
    expect(h).not.toContain(dayIn("America/New_York"));

    // Live under `TZ=America/New_York`, inert on a runner at or ahead of UTC.
    // Written as a conditional rather than left out, because the run that CAN
    // fail is the point and a comment cannot fail.
    const zoneless = new Date(STARTS_ON).toLocaleDateString("en-GB", DATE_OPTS);
    if (zoneless !== dayIn(UTC)) expect(h).not.toContain(zoneless);
  });

  it("collapses a one-day competition to a single date rather than repeating it", async () => {
    stub.getPublicCompetitionHub.mockResolvedValue(
      hubDoc({ info: info({ startsOn: STARTS_ON, endsOn: STARTS_ON }) }),
    );
    const h = await render();
    expect(h).toMatch(
      new RegExp(`data-testid="mh-hero-dates"[^>]*>${fmtDate(UTC, STARTS_ON, DATE_OPTS)}<`),
    );
  });

  it("draws no date line at all when the competition has neither date", async () => {
    stub.getPublicCompetitionHub.mockResolvedValue(
      hubDoc({ info: info({ startsOn: null, endsOn: null }) }),
    );
    expect(await render()).not.toContain(`data-testid="mh-hero-dates"`);
  });
});

// -------------------------------------------------------- the old page is gone

describe("the old competition page is gone, not buried", () => {
  it("renders no divisions grid, no live-now rail and no 'Register now'", async () => {
    const h = await render();

    // The grid's own heading and its empty sentence, both hardcoded English.
    expect(h).not.toMatch(/<h2[^>]*>Divisions<\/h2>/);
    expect(h).not.toContain("No divisions published yet.");
    // The old CTA copy. The new one is `landing.register` ("Register").
    expect(h).not.toContain("Register now");
    // The old live chip, "{n} live now". `landing.liveCount` is "{count} live"
    // and `landing.status.live.*` is "Live now: {count} matches", so a digit
    // immediately before "live now" belongs to nothing on the page any more.
    expect(h).not.toMatch(/\d+ live now/);

    // Positive pair for all four: the things that REPLACED them are present.
    expect(h).toContain(`data-testid="mh-root"`);
    expect(h).toMatch(/data-testid="mh-hero-divisions"[^>]*>2 divisions</);
    expect(h).toContain(en["landing.register"]!);
  });

  it("no longer reads the registration usecase itself — the document's flag is the only answer", async () => {
    // A second read is a second answer. If this page ever imports
    // `publicRegistrationInfo` again, the CTA and the tabs can disagree.
    //
    // Anchored at IMPORT position, not on the bare phrase: the page's own
    // comment explains which read the document's flag came from, and a
    // substring check reds on the prose while a real re-import in a file that
    // never mentioned it would slip past. Same lesson, same shape, as
    // `public-isr-contract.test.ts`'s `dynamic` guard.
    const source = await import("node:fs").then((fs) =>
      fs.readFileSync(new URL("../page.tsx", import.meta.url), "utf8"),
    );
    expect(source).not.toMatch(/^\s*import[\s\S]{0,200}?publicRegistrationInfo/m);
  });
});

// --------------------------------------------------------------- locales

describe("every word on this page comes from the org's dictionary", () => {
  /** The keys the PAGE itself renders (the tabs' own copy is pinned in their
   *  own suites). Values are read from each locale at assert time. */
  const PAGE_KEYS = [
    "landing.present",
    "landing.register",
    "landing.sponsors",
    "landing.partners",
    "landing.tabsLabel",
    "landing.tab.overview",
    "landing.tab.matches",
    "landing.tab.info",
    "share.whatsapp",
    "share.whatsappAria",
    "share.copy",
  ];

  for (const locale of ["en", "es", "fr", "nl"]) {
    it(`${locale}: renders that locale's own copy, and drops the English where the two differ`, async () => {
      const dict = DICTS[locale]!;
      const h = await forLocale(locale);

      for (const key of PAGE_KEYS) {
        const mine = dict[key]!;
        expect(h, `${locale} ${key}`).toContain(esc(mine));

        // The negative half — applied only where the words really differ and
        // neither is a substring of the other (French "Infos" contains English
        // "Info"; Dutch "Sponsors" IS English "Sponsors").
        const english = DICTS.en![key]!;
        if (mine !== english && !mine.includes(english) && !english.includes(mine)) {
          expect(h, `${locale} ${key} still shows the English`).not.toContain(esc(english));
        }
      }

      // The counted chips, interpolated — the plural category is the locale's,
      // not English's.
      const chips: [string, number][] = [
        ["landing.divisions", 2],
        ["landing.entrants", 10],
        ["landing.liveCount", 1],
      ];
      for (const [key, count] of chips) {
        const form = new Intl.PluralRules(locale).select(count);
        const template = dict[`${key}.${form}`] ?? dict[`${key}.other`]!;
        expect(h, `${locale} ${key}`).toContain(esc(template.replace("{count}", String(count))));
      }

      // The sponsor board's sentence, with the sponsor's name inside it.
      expect(h).toContain(esc(dict["landing.presentedBy"]!.replace("{sponsor}", "Northbank Bank")));
      expect(h).not.toContain("{sponsor}");
      expect(h).not.toContain("{count}");
    });
  }

  // The ruling the page implements: ONE locale, the ORG's, for the chrome AND
  // the document — never the viewer's. Proven by showing the chrome MOVES with
  // the document's locale while the route's params stay the same.
  it("takes the locale from the document, so the chrome cannot disagree with the strings baked into it", async () => {
    stub.getPublicCompetition.mockResolvedValue(shell({ locale: "en" }));
    stub.getPublicCompetitionHub.mockResolvedValue(doc({ locale: "es" }));
    const h = await render();

    // `landing.tab.overview` and not `landing.present`: Spanish "Presentar"
    // CONTAINS English "Present", so the negative half would red on a correct
    // page. "Resumen" and "Overview" share nothing.
    expect(h).toContain(esc(DICTS.es!["landing.tab.overview"]!));
    expect(h).not.toContain(esc(DICTS.en!["landing.tab.overview"]!));
    // …and the register CTA, whose two words are disjoint in the same way.
    expect(h).toContain(esc(DICTS.es!["landing.register"]!));
    expect(h).not.toContain(esc(DICTS.en!["landing.register"]!));
  });
});

// -------------------------------------------------------------- metadata

describe("generateMetadata", () => {
  const meta = () =>
    generateMetadata({
      params: Promise.resolve({ orgSlug: "riverside", competitionSlug: "autumn-cup" }),
    });

  it("titles the page with the competition and the org", async () => {
    expect((await meta()).title).toBe("Autumn Cup — Riverside SC");
  });

  for (const locale of ["en", "es", "fr", "nl"]) {
    it(`${locale}: the fallback description is that locale's sentence`, async () => {
      stub.getPublicCompetition.mockResolvedValue(shell({ locale }));
      const expected = DICTS[locale]!["landing.metaDescription"]!
        .replace("{competition}", "Autumn Cup")
        .replace("{org}", "Riverside SC");
      expect((await meta()).description).toBe(expected);
      // Not the placeholder, and not the English (all four differ here).
      expect((await meta()).description).not.toContain("{");
      if (locale !== "en") {
        expect((await meta()).description).not.toBe(
          DICTS.en!["landing.metaDescription"]!
            .replace("{competition}", "Autumn Cup")
            .replace("{org}", "Riverside SC"),
        );
      }
    });
  }

  it("prefers the organiser's own description, truncated", async () => {
    stub.getPublicCompetition.mockResolvedValue(shell({ description: "z".repeat(200) }));
    expect((await meta()).description).toBe("z".repeat(160));
  });

  it("keeps an unlisted competition out of the index, and a public one in it", async () => {
    stub.getPublicCompetition.mockResolvedValue(shell({ visibility: "unlisted" }));
    expect((await meta()).robots).toEqual({ index: false, follow: false });

    stub.getPublicCompetition.mockResolvedValue(shell({ visibility: "public" }));
    expect((await meta()).robots).toBeUndefined();
  });

  it("returns an empty object for a competition that is not there", async () => {
    stub.getPublicCompetition.mockResolvedValue(null);
    expect(await meta()).toEqual({});
  });
});

// ------------------------------------------------------------ the 404 paths

describe("a competition that is not there", () => {
  it("permanently redirects a renamed slug", async () => {
    stub.getPublicCompetition.mockResolvedValue(null);
    stub.sharedRenameTarget.mockResolvedValue("/shared/riverside/autumn-cup-2026");
    await expect(render()).rejects.toThrow("CALLED_REDIRECT:/shared/riverside/autumn-cup-2026");
    expect(nav.notFound).not.toHaveBeenCalled();
  });

  it("404s a slug that was never anything", async () => {
    stub.getPublicCompetition.mockResolvedValue(null);
    stub.sharedRenameTarget.mockResolvedValue(null);
    await expect(render()).rejects.toThrow("CALLED_NOT_FOUND");
    expect(nav.permanentRedirect).not.toHaveBeenCalled();
  });

  // The two reads are not atomic. A competition deleted between them leaves a
  // shell with no document, and every section below the nav is derived from
  // that document — so there is nothing to render and a crash is the only other
  // outcome.
  it("404s when the shell survives but the document does not", async () => {
    stub.getPublicCompetition.mockResolvedValue(shell());
    stub.getPublicCompetitionHub.mockResolvedValue(null);
    await expect(render()).rejects.toThrow("CALLED_NOT_FOUND");
    expect(nav.permanentRedirect).not.toHaveBeenCalled();
  });
});
