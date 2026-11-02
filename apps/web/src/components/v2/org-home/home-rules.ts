// Match Day C7 (owner rulings 2026-11-01): the org Competitions home's three rules, pure so they can be swept without a page.
//
//  - The band a competition sits in. A match TODAY is the competition page's own question, asked of the same count
//    (`needsYouHome`: the page that offers "Open Match Day" on a match day), so this home and that page cannot disagree about
//    which competitions are on today. A Draft competition with a match today is in the deck too (owner: yes). A finished one
//    (completed or archived, by the status chip's own vocabulary) is hidden by default whatever else is true of it.
//  - The sports line: from the divisions — one named, two named, three or more as "N sports" with the full list for title/aria.
//  - B's stub on a quiet card with nothing upcoming: "No fixtures yet" before any fixture exists, "No match scheduled" after.
import { competitionChipState } from "@/components/ui/status-chip";
import { needsYouHome } from "@/components/v2/desk/needs-you";
import { intlLocaleFor } from "@/lib/public-date-locale";
import type { NextFixture } from "@/server/usecases/card-stats";

/** The page's bands, in page order: the today deck, then the quiet roster's groups. */
export const HOME_GROUPS = ["today", "underWay", "notStarted", "finished"] as const;
export type HomeGroup = (typeof HOME_GROUPS)[number];

export function homeGroupOf(c: { status: string; played: number; fixturesToday: number }): HomeGroup {
  // Asked first so a bad count is refused for every competition, a finished one included: `needsYouHome` throws on anything
  // but a whole, non-negative count, and a silent "not today" is the answer this page must never invent.
  const onMatchDay = needsYouHome(c.fixturesToday) === "match_day";
  const chip = competitionChipState(c.status);
  if (chip === "completed" || chip === "archived") return "finished";
  if (onMatchDay) return "today";
  if (chip === "live" || c.played > 0) return "underWay";
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
