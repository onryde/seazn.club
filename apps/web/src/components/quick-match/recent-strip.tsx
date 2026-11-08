// "Your recent quick matches" (spec docs/superpowers/specs/2026-11-03-quick-match-design.md §5 step 5; plan 2 Task 9,
// pre-flight A9, A10, D11): the matches a guest made on this browser, so a closed tab is not a lost match. Up to 5, newest
// first, each its name and the day it was made, linking to its home. A server component on the stadium-night stage of
// both pages that mount it (the marketing hero and `/<lang>/play`).
//
// It takes its rows as props: eslint.config.mjs refuses a value import of @/server/** anywhere in
// src/components/quick-match/** (plan 2 pre-flight, T4), so the page reads them (`readRecentQuickMatches`,
// server/usecases/quick-match-recent.ts, over `listRecentQuickMatches` in quick-match-home.ts) and hands them down. The
// rows arrive sorted and capped; the strip neither sorts nor filters, and renders nothing for none.
import type { ReactNode } from "react";
import { fmtPublicDate, UTC } from "@/lib/format";
import { routes } from "@/lib/routes";
import type { RecentQuickMatch } from "@/server/usecases/quick-match-home";

export type { RecentQuickMatch };

export interface RecentStripProps {
  /** The page's locale: the date is written in it. */
  lang: string;
  title: string;
  items: readonly RecentQuickMatch[];
  /** The page's spacing around the strip; nothing at all renders when there are no rows. */
  className?: string;
}

/** One strip per page (the marketing hero, or the setup screen). */
const TITLE_ID = "qm-recent-title";

export function RecentStrip({ lang, title, items, className = "" }: RecentStripProps): ReactNode {
  if (items.length === 0) return null;
  return (
    <section aria-labelledby={TITLE_ID} data-testid="qm-recent" className={`@container min-w-0 ${className}`}>
      <h2 id={TITLE_ID} className="mk-display text-lg font-semibold tracking-[0.02em] text-[var(--mk-cream)]">
        {title}
      </h2>
      {/* One column in the setup screen's narrow column and on a phone; two, then three, where the container is wide. */}
      <ul className="mt-3 grid min-w-0 gap-2 @2xl:grid-cols-2 @4xl:grid-cols-3">
        {items.map((item) => (
          <RecentRow key={item.token} lang={lang} item={item} />
        ))}
      </ul>
    </section>
  );
}

function RecentRow({ lang, item }: { lang: string; item: RecentQuickMatch }): ReactNode {
  // The href holds the home token, a capability: whoever holds it can score the match. `ph-no-capture` keeps the link
  // out of PostHog's session replay (lib/__tests__/scrub-secret-painters.test.ts). A plain <a>, not a prefetching Link:
  // the home is dynamic and per token, and nothing is gained by rendering five of them before a tap.
  const href = routes.quickMatch(item.token);
  // The server has no viewer zone: the day is the UTC one, explicit (lib/format.ts never falls back to the runtime's).
  const made = fmtPublicDate(lang, UTC, item.createdAt, { day: "numeric", month: "short" });
  return (
    <li className="min-w-0">
      <a
        href={href}
        className="ph-no-capture flex min-h-11 min-w-0 items-center gap-3 rounded-xl border border-[#3b2a6e] bg-[rgb(36_22_80/0.75)] px-4 py-2.5 transition hover:border-[#5b4a9e] hover:shadow-[inset_0_-2px_0_var(--mk-lime)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--mk-lime)]"
      >
        <span className="min-w-0 flex-1 truncate text-sm font-semibold text-[var(--mk-cream)]">{item.name}</span>
        <time dateTime={item.createdAt} className="shrink-0 text-xs tabular-nums text-[#b7aede]">
          {made}
        </time>
      </a>
    </li>
  );
}
