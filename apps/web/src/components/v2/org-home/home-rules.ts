// Match Day C7 (owner rulings 2026-11-01): the org Competitions home's three rules, pure so they can be swept without a page.
//
//  - The band a competition sits in. A match TODAY is the competition page's own question, asked of the same count
//    (`needsYouHome`: the page that offers "Open Match Day" on a match day), so this home and that page cannot disagree about
//    which competitions are on today. A Draft competition with a match today is in the deck too (owner: yes). A finished one
//    (archived, or completed by the card chip's own predicate `competitionCompleted`: every division completed, or the
//    status completed) is hidden by default whatever else is true of it.
//  - The sports line: from the divisions — one named, two named, three or more as "N sports" with the full list for title/aria.
//  - B's stub on a quiet card with nothing upcoming: "No fixtures yet" before any fixture exists, "No match scheduled" after.
//  - When a match plays, as the page prints it everywhere (the deck's match and the quiet card's "Next:" line alike): its time
//    in the organisation's zone, 24-hour, in the locale's own order (`fmtPublicTime`/`fmtPublicDate`), with its date in front
//    unless it is on the deck's day — so two lines on one page can never disagree about a time.
import { competitionCompleted } from "@/components/ui/status-chip";
import { needsYouHome } from "@/components/v2/desk/needs-you";
import { fmtPublicDate, fmtPublicTime } from "@/lib/format";
import { intlLocaleFor } from "@/lib/public-date-locale";
import type { NextFixture } from "@/server/usecases/card-stats";

/** The page's bands, in page order: the today deck, then the quiet roster's groups. */
export const HOME_GROUPS = ["today", "underWay", "notStarted", "finished"] as const;
export type HomeGroup = (typeof HOME_GROUPS)[number];

export function homeGroupOf(c: {
  status: string;
  played: number;
  fixturesToday: number;
  /** The card stats' division counts (archived divisions count for none), as the chip reads them. */
  divisions: number;
  divisionsCompleted: number;
}): HomeGroup {
  // Asked first so a bad count is refused for every competition, a finished one included: `needsYouHome` throws on anything
  // but a whole, non-negative count, and a silent "not today" is the answer this page must never invent.
  const onMatchDay = needsYouHome(c.fixturesToday) === "match_day";
  // UI5 fix round 1 (review m5): finished by the card CHIP's own predicate (`competitionChipState` reads its divisions):
  // starting a division makes a competition `live` and nothing completes it, so its status alone left a competition whose
  // every division had finished reading Completed in the "Under way" band.
  if (c.status === "archived" || competitionCompleted(c.status, c)) return "finished";
  if (onMatchDay) return "today";
  if (c.status === "live" || c.played > 0) return "underWay";
  return "notStarted";
}

/** "Badminton" · "Badminton and Tennis" · "3 sports" (full: "Badminton, Cricket and Tennis"). `keys` in the caller's order
 *  (most divisions first); a key repeated is one sport. Null for a competition with no division yet. */
export function sportsLine(
  keys: readonly string[],
  locale: string,
  fmt: { name: (key: string) => string; count: (n: number) => string },
): { text: string; full: string } | null {
  const unique = [...new Set(keys)];
  if (unique.length === 0) return null;
  const full = new Intl.ListFormat(intlLocaleFor(locale), { type: "conjunction" }).format(unique.map(fmt.name));
  return { text: unique.length <= 2 ? full : fmt.count(unique.length), full };
}

export type HomeStub = "no_fixtures" | "no_match";

/** B's stub, or null while a match is coming up. */
export function stubOf(s: { total: number; next: NextFixture | null }): HomeStub | null {
  if (s.next !== null) return null;
  return s.total === 0 ? "no_fixtures" : "no_match";
}

/** The day an instant falls on in `tz`, 'YYYY-MM-DD' (en-CA writes ISO order). */
const dayIn = (tz: string, at: string) =>
  new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(at));

/** "15:10" on the organisation's day `day`, else "Mon 9 Nov 15:10" (the locale's order); null for a match with no time. */
export function matchWhen(locale: string, tz: string, day: string, at: string | null): string | null {
  if (at === null) return null;
  const time = fmtPublicTime(locale, tz, at);
  return dayIn(tz, at) === day ? time : `${fmtPublicDate(locale, tz, at)} ${time}`;
}

export interface NextLine {
  /** When it plays (`matchWhen`); null while it is in play (the caller says "Now:") or when it has no time. */
  when: string | null;
  court: string | null;
  /** "Ann vs Bob", joined with the locale's own word. */
  pair: string;
  /** In play right now: the caller shows "Now:" instead of "Next:" — one label, chosen once, never both. */
  live: boolean;
  /** The whole line, for a pointer's `title`. */
  text: string;
}

/** The quiet card's answer to "what's next?", read as the deck reads its own match. A fixture with a side still to be decided
 *  is no answer — card-stats' query already leaves such a fixture out (D4a), and it is refused here too rather than printed
 *  with a placeholder. */
export function nextLine(
  next: NextFixture | null,
  f: { locale: string; tz: string; day: string; vs: string },
): NextLine | null {
  if (!next || next.home === null || next.away === null) return null;
  const when = next.in_play ? null : matchWhen(f.locale, f.tz, f.day, next.scheduled_at);
  const pair = `${next.home} ${f.vs} ${next.away}`;
  const text = [when, next.court_label, pair].filter((x): x is string => !!x).join(", ");
  return { when, court: next.court_label, pair, live: next.in_play, text };
}
