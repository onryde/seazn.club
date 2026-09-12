// Spectator surface W2, Task 10 — the competition hub's Info tab: the facts
// about the competition itself that exist before any fixture does, plus the
// three blocks the PAGE owns and hands down as slots.
//
// `deriveHubTabs` gives every competition an Info tab unconditionally
// (`lib/matches-hub.ts:243`), so unlike its four siblings this one has no empty
// state: a competition always has a Present link and always has a registration
// status, even when it has no dates, no venues and no divisions yet.
//
// NO `"use client"` — nothing here is stateful.
import Link from "next/link";
import type { ReactNode } from "react";
import { UTC, fmtDate } from "@/lib/format";
import type { Dict as PublicDict, Locale } from "@/lib/i18n-constants";
import { t } from "@/lib/i18n-runtime";
import type { CompetitionHubDocT } from "@/server/public-site/competition-hub-schema";

export interface InfoTabProps {
  doc: CompetitionHubDocT;
  dict: PublicDict;
  /**
   * The VIEWER's locale, used for exactly one thing: `Intl.ListFormat` on the
   * venue list. It is deliberately NOT threaded into the dates — see
   * `competitionDateLine`.
   *
   * ⚠️ THREE LANGUAGES CAN MEET IN ONE PANEL, and Task 11 owns the decision
   * (review F9). `competition-hub.ts:368` builds the whole document in the
   * ORG's `default_locale`, so every pre-resolved string in it — the board
   * labels on the Stats tab, `divisionName` everywhere — is org-language. This
   * prop is the viewer's, and drives the venue conjunction. The dates are
   * en-GB in all four. A Spanish viewer of an English org therefore reads
   * Spanish chrome, English board labels and English dates on one screen. That
   * is the shipped behaviour of the merged document, not a choice this file
   * makes; what Task 11 decides is which dict it hands down here.
   */
  locale: Locale;
  /** The competition's own prose. The page renders it (`renderProse` +
   *  `CompetitionProse`), because it is HTML from the database and sanitising
   *  it is a server concern; this tab only decides where it sits. */
  descriptionSlot?: ReactNode;
  /** The share bar. A client island with a clipboard and a toast, so it cannot
   *  be built here without making this whole tab a client component. */
  shareSlot?: ReactNode;
  // NO `sponsorsSlot`. The board is rendered by `page.tsx` below the whole tab
  // panel, so it is on every tab rather than on this one and the Overview
  // (owner ruling 2026-09-12; `sponsors-board.tsx`'s header has the reasoning).
}

const DATE_OPTS: Intl.DateTimeFormatOptions = {
  day: "numeric",
  month: "long",
  year: "numeric",
};

/**
 * The competition's dates as one line — "1 September 2026 – 20 September 2026",
 * "1 September 2026" for a one-day competition or a competition with no end
 * date yet, and "" when it has neither.
 *
 * ── IN UTC, AND THAT IS THE WHOLE POINT ────────────────────────────────────
 * `startsOn`/`endsOn` are CALENDAR DATES, not instants — the schema says so at
 * `competition-hub-schema.ts:168-169`, and the columns behind them are
 * `date`, not `timestamptz`. `new Date("2026-09-01")` is UTC MIDNIGHT, so
 * formatting it in any zone behind UTC prints the day before. Executed against
 * this repo's own `fmtDate`:
 *
 *     Europe/London        1 September 2026
 *     America/New_York     31 August 2026     <-- wrong day, wrong month
 *     Australia/Sydney     1 September 2026
 *
 * A New York competition starting on the 1st would have told every spectator
 * the 31st of August. A wall-clock day has no zone to be converted into, so
 * the zone is `UTC` and it is fixed HERE rather than passed in: a caller that
 * could choose the zone is a caller that can get this wrong, and the two
 * plausible wrong answers (the viewer's zone, the division's) are both
 * reachable from this component's own props.
 *
 * The competition landing page carried the same trap —
 * `new Date(d).toLocaleDateString("en-GB", …)` with no zone at all, formatting
 * in whatever zone the Node process happened to run in. **Task 12 fixed it**,
 * so this paragraph no longer describes anything live; it said "live today" and
 * then went on being read as true after the thing it described was gone.
 * Kept, corrected, because the trap itself is worth naming: a `date` column is
 * a wall-clock DAY, and any zone at all — including none — can move it.
 *
 * ── AND IN ENGLISH, IN EVERY LOCALE ────────────────────────────────────────
 * `format.ts:10` pins `const LOCALE = "en-GB"` and `fmtDate` takes no locale
 * parameter — a repo-wide, deliberate deferral ("the v5 i18n wave threads the
 * resolved locale through the same signatures"). The brief's "`fmtDate` in
 * `Intl` of the org locale" describes something the helper cannot do today.
 * Threading a locale through it is that wave's work, not this tab's: it would
 * move every date on every surface at once.
 *
 * ── WHY NOT `fmtRange` ─────────────────────────────────────────────────────
 * `format.ts`'s own range helper returns "" when `from` is null, which would
 * silently drop an end date on a competition that has one and no start. The
 * schema makes the two nullable independently, so both halves are filtered and
 * de-duplicated instead.
 */
export function competitionDateLine(info: {
  startsOn: string | null;
  endsOn: string | null;
}): string {
  const days = [info.startsOn, info.endsOn]
    .filter((d): d is string => d !== null)
    .map((d) => fmtDate(UTC, d, DATE_OPTS));
  // De-duplicated on the FORMATTED value, so a one-day competition reads "1
  // September 2026" rather than the same date twice with a dash between it.
  return [...new Set(days)].join(" – ");
}

/**
 * The division slug a calendar entry belongs to, for its testid.
 *
 * `info.calendars[]` is `{ divisionName, href }` and carries NO slug
 * (`competition-hub-schema.ts:176`), while the testid a spectator-facing test
 * needs is keyed on one. The builder maps the array straight off `hubDivisions`
 * (`competition-hub.ts:663-666`), so the two ARE index-aligned today — but
 * nothing enforces that, and the first builder change that filters the calendar
 * list breaks the alignment silently, renaming every link after its neighbour.
 *
 * So the join is STRUCTURAL: the division whose own href this `.ics` hangs off.
 * The fallback is the entry's own INDEX, prefixed `_`.
 *
 * It used to fall back to `divisions[index]?.slug` first, and review F2 is
 * right that that rung was worse than nothing. It breaks the very invariant
 * this function's testid exists to hold, on exactly the document it was written
 * for: with `divisions = [premier, sunday-league]` and
 * `calendars = [{unmatched}, premier's]`, entry 0 falls to `divisions[0].slug`
 * and entry 1 matches `premier` structurally, so BOTH links render
 * `mh-info-calendar-premier` — the duplicate locator the Stats row testid was
 * deviated from the brief to avoid, reintroduced two files later. And a
 * filtered calendar list, the case the rung was insurance against, is precisely
 * what produces an unmatched entry beside a matched one.
 *
 * `_${index}` is a worse LABEL and a correct id, which is the right trade for a
 * testid: it is only ever read by a test or a locator, and it appears only on a
 * document the builder cannot currently produce.
 *
 * The UNDERSCORE is the whole point, and re-review N1 is why. A bare
 * `String(index)` was described here as "unique by construction" and is not:
 * `Slug` (`api-v1/schemas.ts:56-60`) permits a bare `"0"` and it is
 * client-settable at `CreateDivision.slug`, so `divisions = [premier, {slug:
 * "0"}]` with an unmatched entry at index 0 renders `mh-info-calendar-0` twice
 * — the same duplicate-locator defect this fallback replaced, one rung further
 * down. Neither `Slug` nor `slugify` can emit `_`, so prefixing it puts the
 * fallback in a namespace no real slug can reach, and THAT is unique by
 * construction rather than by assertion.
 *
 * Worth noting how this was found: the F2 fix removed an overstated uniqueness
 * claim and restated the same claim one rung lower. Moving a guard does not
 * re-earn its rationale.
 */
export function calendarSlug(
  calendar: { href: string },
  index: number,
  divisions: readonly { slug: string; href: string }[],
): string {
  const matched = divisions.find((d) => calendar.href === `${d.href}/calendar.ics`);
  return matched?.slug ?? `_${index}`;
}

// One class for every link on the tab, so the 44px tap target cannot be
// present on three of them and missing on the fourth.
const LINK_CLASS =
  "inline-flex min-h-11 min-w-0 items-center gap-2 rounded-full border border-zinc-200 bg-white px-4 text-sm font-medium text-ink transition hover:border-accent hover:text-accent-strong";
// RANK IS NOT SIZE (review F10). This class sits on a `<dt>` for the two
// label/value rows, and on an `<h2>` for the calendar and share sections — the
// same rank the Stats and Teams tabs give their division headings at
// `text-xl md:text-2xl`. That looks inconsistent and is not: those sections are
// this panel's top-level divisions of content, exactly as a division heading is
// on those tabs, and an 11px label that heads a list of links is still the
// heading of that list. Demoting them to `<h3>` to match their type size would
// put a level skip under the page `<h1>` Task 11 supplies, with no `<h2>` on
// this tab at all. The suite pins the level so the choice is a decision rather
// than an accident.
const LABEL_CLASS = "text-[11px] font-semibold uppercase tracking-[0.14em] text-ink-muted";
const VALUE_CLASS = "mt-0.5 text-sm text-ink";

export function InfoTab({
  doc,
  dict,
  locale,
  descriptionSlot,
  shareSlot,
}: InfoTabProps) {
  const info = doc.info;
  const dates = competitionDateLine(info);
  // `Intl.ListFormat` on the VIEWER's locale, the same helper
  // `components/v2/stages-panel.tsx:1343` uses and for the same reason: a
  // hardcoded ", " is English punctuation, and the conjunction that ends the
  // list ("and" / "y" / "et" / "en") is a translated word nobody would think to
  // put in a dictionary. Empty list → empty string → the row does not render.
  const venues = info.venues.length
    ? new Intl.ListFormat(locale, { style: "long", type: "conjunction" }).format([...info.venues])
    : "";

  return (
    // `min-w-0` on the root for the mount site nobody has written yet — the
    // same reason all three siblings carry one.
    <div data-testid="mh-info" className="min-w-0 space-y-6">
      {/* Each slot takes its own chrome with it. A heading over an absent
          block is the shape reviews here keep catching: it reads as content
          that failed to load rather than content that does not exist. */}
      {descriptionSlot ? (
        <section data-testid="mh-info-description" className="min-w-0">
          {descriptionSlot}
        </section>
      ) : null}

      {/* A `<dl>` for the two rows that really are label/value pairs. The
          `<div>` wrapper around each `<dt>`/`<dd>` is valid HTML5 and is what
          lets each pair be a grid cell and carry its own testid. */}
      {dates || venues ? (
        <dl className="grid gap-3 sm:grid-cols-2">
          {dates ? (
            <div data-testid="mh-info-dates" className="min-w-0">
              <dt className={LABEL_CLASS}>{t(dict, "info.dates")}</dt>
              <dd className={VALUE_CLASS}>{dates}</dd>
            </div>
          ) : null}
          {venues ? (
            <div data-testid="mh-info-venues" className="min-w-0">
              <dt className={LABEL_CLASS}>{t(dict, "info.venues")}</dt>
              <dd className={VALUE_CLASS}>{venues}</dd>
            </div>
          ) : null}
        </dl>
      ) : null}

      {/* Always rendered: "registration is closed" is a fact a spectator came
          for, not the absence of one. The CTA is what the boolean gates. */}
      <div
        data-testid="mh-info-registration"
        className="flex min-w-0 flex-wrap items-center gap-3"
      >
        <span className="text-sm text-ink">
          {t(dict, info.registrationOpen ? "info.registration.open" : "info.registration.closed")}
        </span>
        {info.registrationOpen ? (
          <Link
            data-testid="mh-info-register"
            href={info.registerHref}
            className={`${LINK_CLASS} border-accent bg-accent text-accent-ink hover:text-accent-ink`}
          >
            {t(dict, "landing.register")}
          </Link>
        ) : null}
      </div>

      {info.calendars.length > 0 ? (
        <section data-testid="mh-info-calendars" className="min-w-0 space-y-2">
          {/* ONE heading over the list, and each link named by its DIVISION.
              The other way round — "Add to calendar" as the text of every link
              — gives a screen reader's link list the same four words repeated,
              which is the defect `matchesHub.card.label` shipped in W2 Task 7. */}
          <h2 className={LABEL_CLASS}>{t(dict, "info.calendar")}</h2>
          <ul className="flex flex-wrap gap-2" role="list">
            {info.calendars.map((cal, i) => (
              <li key={cal.href} className="min-w-0">
                <Link
                  data-testid={`mh-info-calendar-${calendarSlug(cal, i, doc.divisions)}`}
                  href={cal.href}
                  className={LINK_CLASS}
                >
                  <span className="min-w-0 truncate">{cal.divisionName}</span>
                </Link>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      {shareSlot ? (
        <section data-testid="mh-info-share" className="min-w-0 space-y-2">
          <h2 className={LABEL_CLASS}>{t(dict, "info.share")}</h2>
          {shareSlot}
        </section>
      ) : null}

      <div className="min-w-0">
        <Link data-testid="mh-info-present" href={info.presentHref} className={LINK_CLASS}>
          {t(dict, "landing.present")}
        </Link>
      </div>
    </div>
  );
}
