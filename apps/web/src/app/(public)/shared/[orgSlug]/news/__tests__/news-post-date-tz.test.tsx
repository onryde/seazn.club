// The public POST page prints publishedAt the same way the feed does, and owes
// the same guard. See ./news-feed-date-tz.test.tsx for the full reasoning; the
// short version is that publishedAt is a timestamptz (a real instant), this
// route is ISR-cached (`revalidate = 30` in ../[postSlug]/page.tsx), so ONE
// rendered HTML is served to every visitor worldwide — there is no viewer
// timezone to resolve against, and without a pin the cached date depends on
// which host happened to fill the cache.
//
// The guard is the MECHANISM (every toLocaleDateString call carries
// timeZone: "UTC"), not the printed day: CI runs UTC, where the unpinned
// formula is already correct, so a day-only test passes in the broken state.
// The day test here forces process.env.TZ to a non-UTC zone so it reds at any
// runner zone too.
import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { OrgPost } from "@/server/usecases/org-posts";

// 01:30Z on 2 March is still 1 March in any zone behind UTC — a midday instant
// would print the same day everywhere and prove nothing.
const ISO = "2026-03-02T01:30:00Z";
const LOCALE = "en";
const OPTS = { day: "numeric", month: "short", year: "numeric" } as const;
const WRONG_ZONE = "America/Los_Angeles";

/** Derived from the same instant the page formats, never typed as a literal. */
const UTC_DAY = new Date(ISO).toLocaleDateString(LOCALE, { ...OPTS, timeZone: "UTC" });
/** What the unpinned code prints on a host in WRONG_ZONE. */
const WRONG_DAY = new Date(ISO).toLocaleDateString(LOCALE, { ...OPTS, timeZone: WRONG_ZONE });

const ORG = {
  id: "00000000-0000-0000-0000-0000000000aa",
  name: "Test Org",
  slug: "test-org",
  branded: false,
  branding: {},
  logo: null,
  about: null,
  default_locale: LOCALE,
  card_payments: false,
};

const POST: OrgPost = {
  id: "00000000-0000-0000-0000-000000000001",
  orgId: ORG.id,
  competitionId: null,
  divisionId: null,
  kind: "announcement",
  status: "published",
  slug: "hello",
  title: "Hello",
  // Empty body: CompetitionProse is skipped, keeping this test about the date.
  bodyMd: "",
  heroImagePath: null,
  autoSource: null,
  publishedAt: ISO,
  createdAt: ISO,
  updatedAt: ISO,
};

vi.mock("@/server/public-site/data", () => ({
  getPublicOrg: async () => ({ org: ORG, competitions: [] }),
}));
vi.mock("@/server/usecases/org-posts", () => ({
  publicPost: async () => POST,
}));
vi.mock("@/server/news/public-view", () => ({
  postHeroUrl: () => null,
  resolvePostSides: async () => null,
  relatedCompetition: async () => null,
}));
vi.mock("@/server/help-content", () => ({ renderHelpMarkdown: async () => "" }));

import PostPage from "../[postSlug]/page";

const render = () =>
  PostPage({ params: Promise.resolve({ orgSlug: ORG.slug, postSlug: POST.slug }) }).then(
    renderToStaticMarkup,
  );

/**
 * Renders while recording the options of every Date.prototype.toLocaleDateString
 * call. Restored in a `finally` so a throwing render or a failing assertion
 * cannot leave Date.prototype patched for every later test.
 */
async function recordDateFormats(): Promise<{
  html: string;
  calls: (Intl.DateTimeFormatOptions | undefined)[];
}> {
  const original = Date.prototype.toLocaleDateString;
  const calls: (Intl.DateTimeFormatOptions | undefined)[] = [];
  const spy = vi
    .spyOn(Date.prototype, "toLocaleDateString")
    .mockImplementation(function (
      this: Date,
      locales?: Intl.LocalesArgument,
      options?: Intl.DateTimeFormatOptions,
    ) {
      calls.push(options);
      // Call through the captured original — `this.toLocaleDateString` would
      // re-enter the spy forever.
      return original.call(this, locales, options);
    });
  try {
    return { html: await render(), calls };
  } finally {
    spy.mockRestore();
  }
}

describe("public post page — publishedAt is formatted in a pinned zone", () => {
  it("formats at least one date (without this the zone guard below is vacuous)", async () => {
    const { calls } = await recordDateFormats();
    expect(calls.length).toBeGreaterThan(0);
  });

  it("pins every publishedAt format to UTC, at any runner zone", async () => {
    const { calls } = await recordDateFormats();
    expect(calls.length).toBeGreaterThan(0);
    for (const options of calls) expect(options?.timeZone).toBe("UTC");
  });

  it("prints the UTC day even when the host's own zone says otherwise", async () => {
    expect(UTC_DAY).not.toBe(WRONG_DAY);

    // A zone-less toLocaleDateString resolves to the HOST's default zone, so a
    // host in WRONG_ZONE is simulated faithfully by substituting that zone into
    // exactly the calls that named none.
    //
    // Mutating process.env.TZ is the obvious way to do this and DOES NOT WORK:
    // it has no effect inside vitest's worker pool, and the first version of
    // this test used it and passed against the unpinned code — vacuous in
    // precisely the state it exists to catch.
    const original = Date.prototype.toLocaleDateString;
    const spy = vi
      .spyOn(Date.prototype, "toLocaleDateString")
      .mockImplementation(function (
        this: Date,
        locales?: Intl.LocalesArgument,
        options?: Intl.DateTimeFormatOptions,
      ) {
        const zone = options?.timeZone ? options : { ...options, timeZone: WRONG_ZONE };
        return original.call(this, locales, zone);
      });
    let html = "";
    try {
      html = await render();
    } finally {
      spy.mockRestore();
    }
    // A page that printed no date at all contains neither string, so the
    // positive assertion below cannot pass vacuously.
    expect(html).toContain(UTC_DAY);
    expect(html).not.toContain(WRONG_DAY);
  });
});
