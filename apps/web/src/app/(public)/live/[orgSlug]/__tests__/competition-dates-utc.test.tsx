// The org hub lists every public competition's date range, and those dates are
// CALENDAR DAYS: `competitions.starts_on`/`ends_on` are pg `date` columns —
// wall-clock days, not instants. `new Date("2026-09-01")` is UTC MIDNIGHT, so
// formatting it with no `timeZone` formats in whatever zone the Node process
// runs in, and every zone behind UTC prints the day before. Measured:
//
//     UTC                   1 Sept 2026
//     America/New_York     31 Aug 2026     <-- wrong day, wrong month
//     America/Los_Angeles  31 Aug 2026     <-- wrong day, wrong month
//
// A US-hosted render would have told every spectator the wrong start date. The
// same rule, with the same reasoning, is written out at length on
// `components/public-site/matches-hub/info-tab.tsx` (`competitionDateLine`) and
// applied on `overview-tab.tsx` — which format these same two fields for the
// competition page. A wall-clock day has no zone to be converted INTO, so the
// answer is UTC and never the venue's zone.
//
// ── WHY THE MECHANISM GUARD BELOW EXISTS ──────────────────────────────────
// The rendered-day assertions can only witness the defect on a runner BEHIND
// UTC. `ci.yml`'s test job is `ubuntu-latest` with no `TZ` — i.e. UTC — where
// the zone-less formula produces the CORRECT string and every day comparison
// passes in the broken state. A guard that only works when an environment
// variable happens to be set is a guard someone deletes. So the day assertions
// are paired with an assertion on the MECHANISM, which separates the two
// implementations at ANY runner zone.
//
// That guard asserts the OPTIONS each call carries rather than that
// `toLocaleDateString` is never called (which is how the competition page's
// own `page.test.tsx` does it). The difference is deliberate: that page routes
// through `lib/format.ts`'s `fmtDate`, which pins `LOCALE = "en-GB"`
// internally and takes no locale parameter. This page keeps its own
// `toLocaleDateString` call, so "never called" would be the wrong assertion
// here — "never called WITHOUT a zone" is the real contract.
import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { ReactElement } from "react";

const getPublicOrg = vi.fn();
vi.mock("@/server/public-site/data", () => ({
  getPublicOrg: (...a: unknown[]) => getPublicOrg(...a),
}));
// The news strip is left EMPTY on purpose: with no posts, the only dates this
// render formats are the competition's own, which is what makes the mechanism
// guard below discriminating rather than merely true.
vi.mock("@/server/usecases/org-posts", () => ({
  publicPosts: vi.fn(async () => ({ posts: [], total: 0 })),
}));
vi.mock("@/lib/posthog-server", () => ({ captureServer: vi.fn(async () => {}) }));
vi.mock("@/lib/prose", () => ({ renderProse: vi.fn(async (h: string) => h) }));

import OrgLandingPage from "../page";

const STARTS_ON = "2026-09-01";
const ENDS_ON = "2026-09-13";
const LOCALE = "en-GB";
const DATE_OPTS: Intl.DateTimeFormatOptions = {
  day: "numeric",
  month: "short",
  year: "numeric",
};

/** The calendar day read in an explicit zone — what the page SHOULD print when
 *  that zone is UTC. */
const dayIn = (tz: string, iso: string) =>
  new Date(iso).toLocaleDateString(LOCALE, { ...DATE_OPTS, timeZone: tz });

/** What the zone-less formula prints on THIS runner, whatever zone it is. */
const zoneless = (iso: string) => new Date(iso).toLocaleDateString(LOCALE, DATE_OPTS);

async function render(): Promise<string> {
  getPublicOrg.mockResolvedValue({
    org: {
      id: "o1",
      name: "Test Org",
      slug: "test-org",
      branded: false,
      branding: {},
      logo: null,
      about: null,
      default_locale: "en",
    },
    competitions: [
      {
        id: "c1",
        org_id: "o1",
        name: "Test Comp",
        slug: "test-comp",
        description: null,
        starts_on: STARTS_ON,
        ends_on: ENDS_ON,
        branding: {},
        status: "active",
        visibility: "public" as const,
      },
    ],
  });
  const tree = (await OrgLandingPage({
    params: Promise.resolve({ orgSlug: "test-org" }),
  })) as ReactElement;
  return renderToStaticMarkup(tree);
}

describe("org hub — a competition's date range is the calendar days the organiser typed", () => {
  it("prints the organiser's days, not the day before them", async () => {
    const html = await render();

    // The fixture is PROVEN differential rather than assumed: if these two ever
    // agreed, everything below would pass on a page formatting in the wrong
    // zone.
    expect(
      dayIn("America/New_York", STARTS_ON),
      "the premise: this date really does read as a different day in New York",
    ).not.toBe(dayIn("UTC", STARTS_ON));

    expect(html).toContain(`${dayIn("UTC", STARTS_ON)} – ${dayIn("UTC", ENDS_ON)}`);
    expect(html).not.toContain(dayIn("America/New_York", STARTS_ON));

    // Live under `TZ=America/New_York`, inert on a runner at or ahead of UTC.
    // Written as a conditional rather than left out because the run that CAN
    // fail is the point, and a comment cannot fail. It is NOT the guard — the
    // mechanism test below is what protects this at CI's zone.
    if (zoneless(STARTS_ON) !== dayIn("UTC", STARTS_ON))
      expect(html).not.toContain(zoneless(STARTS_ON));
  });

  it("formats every date it prints in an explicit UTC zone, whatever zone the process runs in", async () => {
    const seen: (Intl.DateTimeFormatOptions | undefined)[] = [];
    const real = Date.prototype.toLocaleDateString;
    const spy = vi
      .spyOn(Date.prototype, "toLocaleDateString")
      .mockImplementation(function (this: Date, l?: unknown, o?: Intl.DateTimeFormatOptions) {
        seen.push(o);
        return real.call(this, l as string | undefined, o);
      });
    try {
      await render();
    } finally {
      // Restored in `finally`: a render that throws — or the first assertion
      // failing — would otherwise leave `Date.prototype` patched for every
      // test that runs after this one.
      spy.mockRestore();
    }

    // Non-vacuous first: a guard that passes because the page formatted NO
    // dates would survive deleting the date line altogether.
    expect(seen.length, "the page really did format at least one date").toBeGreaterThan(0);
    expect(
      seen.filter((o) => o?.timeZone !== "UTC"),
      "every date this page prints carries an explicit UTC zone",
    ).toEqual([]);
  });
});
