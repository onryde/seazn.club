// The public news FEED prints each post's publishedAt. publishedAt is a
// timestamptz (V295__org_news.sql:34) — a real instant, not a calendar day an
// organiser typed — so there is no "wrong day" defect here. The defect is
// DETERMINISM: this is a server render, so a zone-less toLocaleDateString
// follows whatever zone the Node host happens to run in, which is never the
// reader's zone. Two hosts in two regions print two different days for the
// same post.
//
// THE TRAP this file exists to dodge: CI runs ubuntu-latest with no TZ, i.e.
// UTC, where the zone-less formula already produces the correct string. A test
// that only compares the printed day therefore PASSES in the broken state on
// CI and reds only on a runner behind UTC — a guard that works by accident of
// the environment is a guard someone deletes.
//
// So the real guard asserts the MECHANISM: spy on
// Date.prototype.toLocaleDateString and require every call the render makes to
// carry timeZone: "UTC". That separates the two implementations at any runner
// zone. The day-comparison test below is kept honest the same way — it forces
// process.env.TZ to a non-UTC zone for the duration of the render (Node 26
// honours a runtime TZ change), so it too reds at any runner zone rather than
// only on a machine that happens to sit behind UTC.
//
// Rendered through react-dom/server: vitest here is `environment: "node"` and
// this workspace has no jsdom (same pattern as ../../__tests__/not-found.test.tsx).
import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { OrgPost } from "@/server/usecases/org-posts";

// 01:30Z on 2 March is still 1 March in any zone behind UTC — the whole point
// of the fixture. A midday instant would print the same day everywhere and the
// day-comparison test below could never witness the regression it exists for.
const ISO = "2026-03-02T01:30:00Z";
const LOCALE = "en";
const OPTS = { day: "numeric", month: "short", year: "numeric" } as const;
const WRONG_ZONE = "America/Los_Angeles";

/** What the page must print, derived by formatting the SAME instant the page
 *  formats rather than typed in as a literal — a hand-typed "Mar 2, 2026"
 *  freezes today's locale data and silently stops tracking the source. */
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
  publicPosts: async () => ({ posts: [POST], hasMore: false }),
}));
vi.mock("@/server/news/public-view", () => ({ postHeroUrl: () => null }));

import NewsFeedPage from "../page";

const render = () =>
  NewsFeedPage({
    params: Promise.resolve({ orgSlug: ORG.slug }),
    searchParams: Promise.resolve({}),
  }).then(renderToStaticMarkup);

/**
 * Renders while recording the options of every Date.prototype.toLocaleDateString
 * call the render makes.
 *
 * The spy is restored in a `finally`: a throwing render or a failing assertion
 * would otherwise leave Date.prototype patched for every later test in the file.
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
      // Call through the captured original, never `this.toLocaleDateString`,
      // which would re-enter the spy forever.
      return original.call(this, locales, options);
    });
  try {
    return { html: await render(), calls };
  } finally {
    spy.mockRestore();
  }
}

describe("public news feed — publishedAt is formatted in a pinned zone", () => {
  it("formats at least one date (without this the zone guard below is vacuous)", async () => {
    const { calls } = await recordDateFormats();
    // A page that formats no dates at all satisfies "every call pins UTC"
    // trivially — this assertion is what makes deleting the date line red.
    expect(calls.length).toBeGreaterThan(0);
  });

  it("pins every publishedAt format to UTC, at any runner zone", async () => {
    const { calls } = await recordDateFormats();
    expect(calls.length).toBeGreaterThan(0);
    for (const options of calls) expect(options?.timeZone).toBe("UTC");
  });

  it("prints the UTC day even when the host's own zone says otherwise", async () => {
    // The fixture must actually distinguish the two implementations, or this
    // test cannot witness the regression it exists for.
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
