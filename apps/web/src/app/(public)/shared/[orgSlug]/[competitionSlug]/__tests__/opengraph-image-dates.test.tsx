// The competition share card draws the competition's date range, and those
// dates are CALENDAR DAYS: `competitions.starts_on`/`ends_on` are pg `date`
// columns — wall-clock days, not instants. `new Date("2026-09-01")` is UTC
// MIDNIGHT, so formatting it with no `timeZone` formats in whatever zone the
// Node process runs in, and every zone behind UTC prints the day before.
// Measured:
//
//     UTC                   1 Sept 2026
//     America/New_York     31 Aug 2026     <-- wrong day, wrong month
//     America/Los_Angeles  31 Aug 2026     <-- wrong day, wrong month
//
// This card is what every WhatsApp/iMessage/X preview of the competition link
// renders, so a US-hosted render would have put the wrong start date in front
// of spectators who never open the page. The same rule, with the same
// reasoning, is written out at length on
// `components/public-site/matches-hub/info-tab.tsx` (`competitionDateLine`).
//
// ── HOW THIS READS A PNG'S TEXT (IT DOES NOT) ─────────────────────────────
// The route's product is a rasterised PNG — there is no text in the bytes to
// grep. So `next/og`'s `ImageResponse` is mocked to CAPTURE the element tree it
// is handed, and that tree is rendered to static markup. The card's copy is
// passed as `CardFrame`'s children, so the date line is in the captured tree.
//
// ── WHY THE MECHANISM GUARD BELOW EXISTS ──────────────────────────────────
// The rendered-day assertions can only witness the defect on a runner BEHIND
// UTC. `ci.yml`'s test job is `ubuntu-latest` with no `TZ` — i.e. UTC — where
// the zone-less formula produces the CORRECT string and every day comparison
// passes in the broken state. So the day assertions are paired with an
// assertion on the MECHANISM, which separates the two implementations at ANY
// runner zone. It asserts the OPTIONS each call carries rather than that
// `toLocaleDateString` is never called, because this surface deliberately
// keeps its own `toLocaleDateString` call (see the sibling
// `__tests__/page.test.tsx`, whose page routes through `lib/format.ts`
// instead and can therefore assert the stronger "never called").
import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { ReactElement } from "react";

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
// The crest reaches satori as bytes via a real fetch; this test is about the
// date line, so the image door is stubbed shut.
vi.mock("@/server/og/poster-image", () => ({
  posterImageDataUrl: vi.fn(async () => null),
}));

import CompetitionOg from "../opengraph-image";

const STARTS_ON = "2026-09-01";
const ENDS_ON = "2026-09-13";
const LOCALE = "en-GB";
const DATE_OPTS: Intl.DateTimeFormatOptions = {
  day: "numeric",
  month: "short",
  year: "numeric",
};

/** The calendar day read in an explicit zone — what the card SHOULD draw when
 *  that zone is UTC. */
const dayIn = (tz: string, iso: string) =>
  new Date(iso).toLocaleDateString(LOCALE, { ...DATE_OPTS, timeZone: tz });

/** What the zone-less formula prints on THIS runner, whatever zone it is. */
const zoneless = (iso: string) => new Date(iso).toLocaleDateString(LOCALE, DATE_OPTS);

async function renderCard(): Promise<string> {
  captured.tree = null;
  getPublicCompetition.mockResolvedValue({
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
    competition: {
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
    divisions: [],
    liveNow: [],
  });
  await CompetitionOg({ params: Promise.resolve({ orgSlug: "test-org", competitionSlug: "test-comp" }) });
  if (!captured.tree) throw new Error("ImageResponse was never constructed — nothing to assert on");
  return renderToStaticMarkup(captured.tree);
}

describe("competition share card — the date range is the calendar days the organiser typed", () => {
  it("draws the organiser's days, not the day before them", async () => {
    const html = await renderCard();

    // The fixture is PROVEN differential rather than assumed.
    expect(
      dayIn("America/New_York", STARTS_ON),
      "the premise: this date really does read as a different day in New York",
    ).not.toBe(dayIn("UTC", STARTS_ON));

    expect(html).toContain(`${dayIn("UTC", STARTS_ON)} – ${dayIn("UTC", ENDS_ON)}`);
    expect(html).not.toContain(dayIn("America/New_York", STARTS_ON));

    // Live under `TZ=America/New_York`, inert on a runner at or ahead of UTC.
    if (zoneless(STARTS_ON) !== dayIn("UTC", STARTS_ON))
      expect(html).not.toContain(zoneless(STARTS_ON));
  });

  it("formats the card's dates in an explicit UTC zone, whatever zone the process runs in", async () => {
    const seen: (Intl.DateTimeFormatOptions | undefined)[] = [];
    const real = Date.prototype.toLocaleDateString;
    const spy = vi
      .spyOn(Date.prototype, "toLocaleDateString")
      .mockImplementation(function (this: Date, l?: unknown, o?: Intl.DateTimeFormatOptions) {
        seen.push(o);
        return real.call(this, l as string | undefined, o);
      });
    try {
      await renderCard();
    } finally {
      spy.mockRestore();
    }

    // Non-vacuous first: a guard that passes because the card formatted NO
    // dates would survive deleting the date line altogether.
    expect(seen.length, "the card really did format at least one date").toBeGreaterThan(0);
    expect(
      seen.filter((o) => o?.timeZone !== "UTC"),
      "every date this card draws carries an explicit UTC zone",
    ).toEqual([]);
  });
});
