// Player card (doc 09 §2, doc 06 §4.7): consent-gated — public_players_v only
// contains persons with public_name consent, so anyone else 404s here. Photo
// only with photo consent; DOB is never in any public payload.
//
// Spectator surface W2, Task 14 (owner-approved option C), plus the upcoming
// list (spec 2026-09-23): Upcoming (when any) then Matches lead — the newest
// match as a court slab, older ones as rows, updating in place while the page
// is open (R10, `PlayerMatches`) — then Career, Stats and the squad entry.
// One DOM: from `lg` the page splits 7/5, below it the same blocks stack.
//
// Every visible word is the ORG's locale, from the `public` dictionary. Not the
// viewer's: this route is ISR (`revalidate` below), and `getPublicPlayer`
// already bakes its stat labels and career line in the org's language, so a
// viewer-locale chrome would put two languages on one card.
import Link from "next/link";
import { notFound } from "next/navigation";
import type { Metadata } from "next";
import { getPublicPlayer, getPublicPlayerUpcoming } from "@/server/public-site/data";
import { playerMetaDescription } from "@/lib/public-meta";
import { toLocale } from "@/lib/i18n-constants";
import { getDictionary, t } from "@/lib/i18n";
import { playerMatchesDict } from "@/lib/player-matches-dict";
import { routes } from "@/lib/routes";
import { PlayerMatches } from "@/components/public-site/player-matches";
import { PlayerUpcoming } from "@/components/public-site/player-upcoming";

export const revalidate = 300; // doc 09 §3: entrant/player pages revalidate 300

// ISR (task-8): empty-array generateStaticParams is required for on-demand
// ISR on a dynamic segment in this Next version — see generate-static-params.md.
// REVALIDATE_SLOW (300) above is unchanged, just gaining ISR eligibility.
export async function generateStaticParams() {
  return [];
}

type Props = {
  params: Promise<{ orgSlug: string; competitionSlug: string; personId: string }>;
};

/** P3 — a section title: Barlow 16 px uppercase ink, not a tracked Geist eyebrow. */
const SECTION_TITLE = "mb-3 font-display text-base font-semibold uppercase tracking-wide text-ink";

/** A stats/career card. No shadow (P7): the slab is the page's one lifted object. */
const CARD = "rounded-xl border border-zinc-200/80 bg-surface p-3";

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { orgSlug, competitionSlug, personId } = await params;
  const data = await getPublicPlayer(orgSlug, competitionSlug, personId);
  if (!data) return {};
  // The org's locale, like every word on the page (ISR: never the viewer's).
  const dict = await getDictionary(toLocale(data.org.default_locale), "public");
  return {
    title: `${data.player.name} — ${data.competition.name}`,
    description: playerMetaDescription(data.player.name, data.competition.name, dict),
    ...(data.competition.visibility === "unlisted"
      ? { robots: { index: false, follow: false } }
      : {}),
  };
}

export default async function PlayerCardPage({ params }: Props) {
  const { orgSlug, competitionSlug, personId } = await params;
  const data = await getPublicPlayer(orgSlug, competitionSlug, personId);
  if (!data) notFound();
  const { org, competition, player, memberships, stats, career, careerLabel, matches, generatedAt } = data;
  const locale = toLocale(org.default_locale);
  // Both only after the gate above has passed (`getPublicPlayer`'s notFound),
  // and independent of each other, so they run together. Upcoming is the
  // player's next scheduled matches across the org (spec 2026-09-23), uncached
  // (plan D3): the page's own ISR bounds it. It takes the gate's result itself
  // (`data` is a `PublicPlayerGate`), never loose ids.
  const [dict, upcoming] = await Promise.all([getDictionary(locale, "public"), getPublicPlayerUpcoming(data)]);
  const hub = routes.shared(org.slug, competition.slug);

  return (
    <div className="min-w-0">
      <nav className="mb-4 flex items-center text-xs text-ink-muted">
        <Link href={hub} className="inline-flex min-h-11 items-center hover:text-accent-strong hover:underline">
          {competition.name}
        </Link>
      </nav>
      <div className="flex min-w-0 items-start gap-4">
        {player.photo ? (
          // arbitrary-host avatar — not in remotePatterns, stays <img>
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={player.photo}
            alt={player.name}
            className="h-24 w-24 shrink-0 rounded-xl object-cover"
          />
        ) : (
          <div
            aria-hidden
            className="flex h-24 w-24 shrink-0 items-center justify-center rounded-xl bg-accent-soft font-display text-3xl font-bold text-accent-strong"
          >
            {player.name
              .split(/\s+/)
              .map((w) => w[0])
              .slice(0, 2)
              .join("")}
          </div>
        )}
        <div className="min-w-0">
          <h1 className="font-display text-3xl font-bold uppercase leading-none tracking-tight text-ink">
            {player.name}
          </h1>
          <p className="mt-1 text-sm text-ink-muted">{org.name}</p>
        </div>
      </div>

      <div className="mt-6 space-y-6 lg:grid lg:grid-cols-12 lg:items-start lg:gap-6 lg:space-y-0">
        {/* One 7-span cell from lg (plan D4): Upcoming, when there is any, then
            Matches. Upcoming renders no empty state (spec R3/§3); Matches
            renders in every state, empty included (R9). */}
        <div data-testid="player-main-column" className="min-w-0 space-y-6 lg:col-span-7">
          {upcoming.length > 0 ? (
            <section data-testid="mh-player-upcoming" className="min-w-0">
              <h2 className={SECTION_TITLE}>{t(dict, "player.upcoming")}</h2>
              <PlayerUpcoming rows={upcoming} dict={dict} locale={locale} />
            </section>
          ) : null}
          {/* W2 Task 14 — renders in every state, empty included (R9). */}
          <section data-testid="mh-player-matches" className="min-w-0">
            <h2 className={SECTION_TITLE}>{t(dict, "player.matches")}</h2>
            <PlayerMatches
              orgSlug={org.slug}
              competitionSlug={competition.slug}
              personId={player.id}
              // `generatedAt` is the instant of getPublicPlayer's CACHED read, not
              // this render's: a render inside a warm entry shows lines that old,
              // and the island's "Updated Ns ago" and its older-response guard
              // both count from it. Both sides of that guard are then server
              // clocks — this one and the poll document's.
              initial={{ matches, generatedAt }}
              dict={playerMatchesDict(dict)}
              locale={locale}
            />
          </section>
        </div>

        <div className="min-w-0 space-y-6 lg:col-span-5">
          {/* S9/#418 — the per-sport career rollup, scoped to THIS competition
              only (getPublicPlayer sums only the snapshot rows it already read
              for this competition_id — see that function's own comment). Sits
              above the per-division breakdown below: the total a spectator
              scans first, with the division-by-division detail underneath for
              anyone who wants it. Same "nothing renders when empty" rule as
              that section.

              `career` arrives already reduced to the sports that AGGREGATE
              something — see getPublicPlayer, which drops single-division sports
              per sport rather than per page, so a mixed competition cannot show
              one sport's real rollup beside another's restatement of the Stats
              block below. Unlike /me, which always shows Career because summing
              across clubs is the whole point of that view, this card is already
              competition-scoped, so with one division there is nothing to sum. */}
          {career.length > 0 && (
            <section className="min-w-0" data-testid="player-career">
              <h2 className={SECTION_TITLE}>{careerLabel}</h2>
              <div className="space-y-3">
                {career.map((c) => (
                  <div key={c.sport_key} data-testid={`career-sport-${c.sport_key}`} className={CARD}>
                    <p className="text-sm font-medium text-ink">{c.sport_label}</p>
                    <p className="text-xs text-ink-muted">{c.meta}</p>
                    <dl className="mt-2 flex flex-wrap gap-x-6 gap-y-2">
                      {c.metrics.map((m) => (
                        <div key={m.key} className="min-w-16">
                          <dt className="text-xs text-ink-muted">{m.label}</dt>
                          <dd className="font-display text-2xl font-bold tabular-nums text-ink">{m.value}</dd>
                        </div>
                      ))}
                    </dl>
                  </div>
                ))}
              </div>
            </section>
          )}

          {/* PROMPT-65: per-division totals — labels come from the sport module's
              declared playerStats model; nothing renders when there's nothing to
              show (no layout shift). Free at every tier by design. The division
              name opens the competition hub's Table tab: the hub GROUPS its
              tables by division and honours `?division=` only on Matches and
              Knockout (`competition-landing.tsx` PanelArgs), so no division
              parameter is sent. */}
          {stats.length > 0 && (
            <section className="min-w-0" data-testid="player-stats">
              <h2 className={SECTION_TITLE}>{t(dict, "player.stats")}</h2>
              <div className="space-y-3">
                {stats.map((s) => (
                  <div key={s.division_slug} className={CARD}>
                    <Link
                      href={`${hub}?tab=table`}
                      className="inline-flex min-h-11 items-center text-sm font-medium text-accent-strong underline decoration-accent-line underline-offset-2 hover:decoration-accent"
                    >
                      {s.division_name}
                    </Link>
                    <dl className="mt-2 flex flex-wrap gap-x-6 gap-y-2">
                      {s.metrics.map((m) => (
                        <div key={m.key} className="min-w-16">
                          <dt className="text-xs text-ink-muted">{m.label}</dt>
                          <dd className="font-display text-2xl font-bold tabular-nums text-ink">{m.value}</dd>
                        </div>
                      ))}
                    </dl>
                  </div>
                ))}
              </div>
            </section>
          )}

          {/* The squad entry: one link card per membership, each fact its own
              element (§3 copy rules — the old "Division — Team · #7 · Keeper"
              sentence is gone). It opens the hub's Teams tab, which groups by
              division and takes no `?division=` filter, so none is sent. */}
          <section className="min-w-0" data-testid="player-squad">
            <h2 className={SECTION_TITLE}>{t(dict, "player.inThisCompetition")}</h2>
            {memberships.length === 0 ? (
              <p className="text-sm text-ink-muted">{t(dict, "player.noSquad")}</p>
            ) : (
              <ul className="space-y-2">
                {memberships.map((m, i) => (
                  <li key={i} className="min-w-0">
                    <Link
                      href={`${hub}?tab=teams`}
                      className="block min-h-11 min-w-0 rounded-xl border border-zinc-200/80 bg-surface px-3.5 py-2.5 transition-colors hover:border-accent-line hover:bg-accent-soft/60"
                    >
                      <span className="block truncate font-display text-[17px] font-semibold uppercase tracking-wide text-ink">
                        {m.entrant_name}
                      </span>
                      <span className="mt-1 flex min-w-0 flex-wrap items-center gap-1.5">
                        <span className="min-w-0 max-w-full truncate rounded-full bg-accent-soft px-2 py-0.5 text-[11px] font-semibold uppercase tracking-wide text-accent-strong">
                          {m.division_name}
                        </span>
                        {m.squad_number != null ? (
                          <span
                            data-testid="player-squad-number"
                            className="shrink-0 rounded-full border border-zinc-200 px-2 py-0.5 text-[11px] font-semibold tabular-nums text-ink"
                          >
                            {`#${m.squad_number}`}
                          </span>
                        ) : null}
                        {m.position ? (
                          <span data-testid="player-squad-position" className="min-w-0 truncate text-xs text-ink-muted">
                            {m.position}
                          </span>
                        ) : null}
                      </span>
                    </Link>
                  </li>
                ))}
              </ul>
            )}
          </section>
        </div>
      </div>
    </div>
  );
}
