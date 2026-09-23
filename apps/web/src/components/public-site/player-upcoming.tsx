// Player profile — the Upcoming list (spec 2026-09-23, R3/R4). A SERVER
// component: rendered once per ISR regeneration, no poll (spec: no live
// updates). One chronological list in the reader's order, which it never
// re-sorts. Each row names its competition › division; on a row from another
// competition that line is the highlight, in the accent colour (owner
// 2026-09-23, replacing the "Other event" chip).
//
// "Show N more" is the one client piece (owner request 2026-09-23,
// superseding plan D2's <details>): `UpcomingReveal` in
// `player-upcoming-reveal.tsx`. Every row is still rendered HERE, on the
// server, and handed to it as ready <li> nodes with both labels resolved — no
// dictionary slice, date code or server module goes to the client. As served
// it is collapsed: the first five rows and the button, in ONE list.
//
// Every subpart is a plain function called inline (the `player-matches.tsx`
// convention), so a static-markup test sees every word.
//
// No middle-dot meta (§3 copy rules): time, court and venue are separate
// elements; the "›" between competition and division is the spec's own
// separator, aria-hidden — so the spaces around it sit OUTSIDE the hidden
// span, or a screen reader reads "Autumn CupPremier".
import Link from "next/link";
import type { Dict, Locale } from "@/lib/i18n-constants";
import { t } from "@/lib/i18n-runtime";
import { formatPublicInstant } from "@/lib/public-date-locale";
import type { PlayerUpcomingRow } from "@/server/public-site/public-player-matches";
import { UpcomingReveal } from "./player-upcoming-reveal";

/** R3: shown before the toggle. */
export const UPCOMING_VISIBLE = 5;

export interface PlayerUpcomingProps {
  rows: readonly PlayerUpcomingRow[];
  /** The public dictionary, in the ORG's locale. */
  dict: Dict;
  /** The ORG's locale, the page's own (ISR: never the viewer's). */
  locale: Locale;
}

/** The competition › division line. Another competition's row is accented, so
 *  the competition NAME is what stands out; this competition's stays muted. */
const WHERE = "min-w-0 truncate";
const WHERE_OTHER = `${WHERE} font-semibold text-accent-strong`;

function upcomingRow(row: PlayerUpcomingRow, dict: Dict, locale: Locale) {
  const day = formatPublicInstant(locale, row.tz, row.scheduledAt, { day: "numeric" });
  const month = formatPublicInstant(locale, row.tz, row.scheduledAt, { month: "short" });
  const time = formatPublicInstant(locale, row.tz, row.scheduledAt, { hour: "2-digit", minute: "2-digit" });
  return (
    <li key={row.fixtureId} className="min-w-0 first:rounded-t-xl last:rounded-b-xl">
      <Link
        href={row.href}
        data-testid={`mh-player-upcoming-row-${row.fixtureId}`}
        className="grid min-h-11 min-w-0 grid-cols-[3.25rem_minmax(0,1fr)] items-center gap-x-2.5 rounded-[inherit] px-3.5 py-2.5 transition-colors hover:bg-accent-soft/60"
      >
        <span className="flex min-w-0 flex-col items-start">
          {day !== null ? (
            <>
              <span className="font-display text-[18px] font-semibold leading-tight tabular-nums text-ink">{day}</span>
              <span className="text-xs text-ink-muted">{month}</span>
            </>
          ) : (
            <span aria-hidden className="font-display text-[18px] font-semibold leading-tight text-ink-muted">
              —
            </span>
          )}
        </span>
        <span className="min-w-0">
          <span className="block truncate font-display text-[17px] font-semibold uppercase tracking-wide text-ink">
            {t(dict, "player.opponent", { opponent: row.opponentLabel })}
          </span>
          <span className="mt-1 flex min-w-0 flex-wrap items-center gap-x-2 gap-y-0.5 text-xs text-ink-muted">
            {time !== null ? (
              <span data-testid="mh-player-upcoming-time" className="shrink-0 font-semibold tabular-nums text-ink">
                {time}
              </span>
            ) : (
              <span data-testid="mh-player-upcoming-tbc" className="shrink-0 font-semibold uppercase tracking-wide">
                {t(dict, "player.upcoming.timeTbd")}
              </span>
            )}
            {row.courtLabel ? (
              <span data-testid="mh-player-upcoming-court" className="min-w-0 max-w-full truncate">
                {row.courtLabel}
              </span>
            ) : null}
            {row.venue ? (
              <span data-testid="mh-player-upcoming-venue" className="min-w-0 max-w-full truncate">
                {row.venue}
              </span>
            ) : null}
          </span>
          <span className="mt-1 flex min-w-0 items-center text-xs text-ink-muted">
            <span data-testid="mh-player-upcoming-where" className={row.isOtherCompetition ? WHERE_OTHER : WHERE}>
              <span>{row.competitionName}</span>{" "}
              <span aria-hidden="true">›</span>{" "}
              <span>{row.divisionName}</span>
            </span>
          </span>
        </span>
      </Link>
    </li>
  );
}

export function PlayerUpcoming({ rows, dict, locale }: PlayerUpcomingProps) {
  // The empty case first: no rows, nothing at all (the page renders no section).
  if (rows.length === 0) return null;
  const rest = rows.slice(UPCOMING_VISIBLE);
  return (
    <div className="min-w-0 space-y-2">
      <UpcomingReveal
        head={rows.slice(0, UPCOMING_VISIBLE).map((r) => upcomingRow(r, dict, locale))}
        rest={rest.map((r) => upcomingRow(r, dict, locale))}
        moreLabel={t(dict, "player.upcoming.showMore", { count: rest.length })}
        lessLabel={t(dict, "player.upcoming.showLess")}
      />
    </div>
  );
}
