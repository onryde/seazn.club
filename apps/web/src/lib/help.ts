// Help-centre link registry (v3/06 §3). Client-safe on purpose — <Tip> runs
// in the browser and cannot walk content/help, so the article slugs are
// listed here and the stale-doc test (help-content.test.ts) proves this list
// and the Markdown files on disk agree in BOTH directions. A slug outside the
// registry resolves to null and "Learn more" simply doesn't render — never a
// dead link.

export const HELP_ARTICLE_SLUGS = [
  "getting-started/create-your-organisation",
  "getting-started/create-a-competition",
  "getting-started/add-a-division",
  "getting-started/add-entrants",
  "getting-started/generate-fixtures",
  "getting-started/start-scoring",
  "getting-started/share-your-dashboard",
  "getting-started/invite-your-team",
  "entrants/kinds",
  "entrants/withdrawals",
  "entrants/duplicate-players",
  "entrants/team-badges-and-bulk-enrolment",
  "players/claim-your-profile",
  "players/invite-to-claim",
  "players/player-stats-and-photo",
  "directory/clubs-and-teams",
  "players/match-reports",
  "players/duplicates",
  "registration/open-registration",
  "registration/registrants",
  "registration/card-payments",
  "registration/reference-numbers",
  "registration/waitlist",
  "registration/youth",
  "registration/registering-for-a-competition",
  "scheduling/board",
  "scheduling/locks",
  "scheduling/undo",
  "scheduling/constraints",
  "scheduling/ai-scheduling",
  "scheduling/ai-instructions",
  "scheduling/ai-dates",
  "scheduling/ai-review",
  "scheduling/ai-credits",
  "scheduling/ai-several-divisions",
  "scheduling/ai-officials",
  "scheduling/timezones",
  "scheduling/officials",
  "scheduling/officials-assign",
  "scheduling/officials-my-assignments",
  "scheduling/official-marks",
  "scheduling/matchday-documents",
  "scheduling/match-day",
  "scheduling/match-day-scorers",
  "scheduling/match-day-stream",
  "scoring/basics",
  "scoring/conflicts",
  "scoring/device-links",
  "scoring/scorer-sheets",
  "scoring/scorer-card-scan",
  "scoring/scorer-role",
  "scoring/knockout-deciders",
  "scoring/match-audit-trail",
  "scoring/lineups",
  "scoring/fidelity",
  "scoring/attribution",
  "scoring/offline-scoring",
  "scoring/corrections",
  "scoring/batch-import",
  "scoring/batch-import-report",
  "sports/badminton",
  "sports/carrom",
  "sports/chess",
  "sports/cricket",
  "sports/hockey",
  "sports/football",
  "sports/icehockey",
  "sports/icehockey-penalties",
  "sports/tabletennis",
  "sports/tennis",
  "sports/volleyball",
  "sports/generic",
  "divisions/lifecycle",
  "divisions/archive",
  "divisions/settings",
  "divisions/groups-to-knockout",
  "divisions/qualify-from-any-stage",
  "divisions/bracket-view",
  "divisions/add-a-match",
  "divisions/discipline",
  "sharing/visibility",
  "sharing/dashboard",
  "sharing/slideshow",
  "sharing/embeds",
  "sharing/languages",
  "sharing/sponsors",
  "sharing/sponsors-hub",
  "sharing/grow-your-club",
  "sharing/news",
  "sharing/presentation-mode",
  "billing/plans",
  "billing/groups",
  "billing/downgrade",
  "billing/event-pass",
  "billing/credits",
  "billing/operator",
  "billing/add-ons",
  "api/keys",
] as const;

const ARTICLES = new Set<string>(HELP_ARTICLE_SLUGS);

// Slugs that resolve to generated pages rather than Markdown articles —
// the format gallery (v3/06 §4) renders from the engine registry.
const VIRTUAL: Record<string, string> = {
  "formats/overview": "/help/formats",
};

export function helpUrl(slug: string | undefined): string | null {
  if (!slug) return null;
  if (VIRTUAL[slug]) return VIRTUAL[slug];
  if (slug.startsWith("formats/")) return `/help/formats/${slug.slice("formats/".length)}`;
  return ARTICLES.has(slug) ? `/help/${slug}` : null;
}

/** One section of the help section list (server/help-content.ts helpSectionList): its pages, in reading order. */
export interface HelpSectionEntry {
  key: string;
  label: string;
  pages: { href: string; title: string }[];
}
