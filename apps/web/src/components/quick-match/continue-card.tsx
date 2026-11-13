// "Continue" on the setup page (owner 2026-11-12: "if same browser tries to create one more, show the first one"). A guest
// whose browser holds an UNFINISHED quick match (not every match decided) meets it first, above the form: its name, how many
// of its matches are played, and Continue to its home. The newest unfinished one is the card; every other recent match stays
// in the strip below it; a finished match is only ever in the strip. The form follows under its own heading: making another
// is never blocked.
//
// The rows are the recent strip's (`readRecentQuickMatches`, the same visitor cookie, the same read, which carries each
// match's `playedOf` count): no second query and no browser storage. A server component, handed its rows and words by the
// page (eslint.config.mjs keeps every value import of @/server out of components/quick-match/**).
import type { ReactNode } from "react";
import { routes } from "@/lib/routes";
import type { RecentQuickMatch } from "./recent-strip";

/**
 * The card's row and the strip's rows. `items` arrive newest first (the read sorts); the card is the first that still has a
 * match to play, and the strip keeps every other row in the order it was handed. A row with no matches at all has nothing to
 * continue (no producer makes one: a quick match has two sides at least), so it is never the card.
 */
export function splitRecent(items: readonly RecentQuickMatch[]): { resume: RecentQuickMatch | null; rest: RecentQuickMatch[] } {
  const resume = items.find((r) => r.played < r.total) ?? null;
  return { resume, rest: items.filter((r) => r !== resume) };
}

const NAME_ID = "qm-continue-name";

export function ContinueCard({
  item,
  labels,
}: {
  item: RecentQuickMatch;
  /** In the page's language: the count line ("2 of 6 matches played") and the link's word. */
  labels: { played: string; action: string };
}): ReactNode {
  // The href holds the home token, a capability: `ph-no-capture` keeps it out of PostHog's session replay
  // (lib/__tests__/scrub-secret-painters.test.ts), and a plain <a>, as the strip's rows are (the home is dynamic per token).
  const href = routes.quickMatch(item.token);
  return (
    <section
      aria-labelledby={NAME_ID}
      data-testid="qm-continue"
      className="min-w-0 rounded-2xl border border-[rgb(163_230_53/0.45)] bg-[rgb(36_22_80/0.75)] p-4 sm:flex sm:items-center sm:gap-5 sm:p-5"
    >
      <div className="min-w-0 sm:flex-1">
        <h2
          id={NAME_ID}
          className="mk-display text-xl font-bold leading-tight text-[var(--mk-cream)] [overflow-wrap:anywhere]"
        >
          {item.name}
        </h2>
        <p data-testid="qm-continue-played" className="mt-1 text-sm text-[#b7aede]">
          {labels.played}
        </p>
      </div>
      <a
        href={href}
        aria-describedby={NAME_ID}
        data-testid="qm-continue-link"
        className="ph-no-capture mt-4 flex min-h-12 w-full items-center justify-center rounded-xl bg-[var(--mk-lime)] px-6 py-3 text-base font-semibold text-[var(--mk-night)] transition hover:brightness-105 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--mk-cream)] sm:mt-0 sm:w-auto sm:shrink-0"
      >
        {labels.action}
      </a>
    </section>
  );
}
