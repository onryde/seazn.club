// Match Day C7 (owner rulings 2026-11-01): the org Competitions home's cards — concept C, the "today deck", with concept B's
// "nothing scheduled" stub on the quiet cards. Reference mock (layout only): .superpowers/sdd/2026-10-31-match-day/
// c7-mock-reference.html. House tokens throughout; no tinted band and no emoji (owner).
//
//  - The today deck: one night panel at the top, a wide row per competition with a match today — its identity, the match it
//    plays next, its progress and Open Match Day. On a phone the three stack; from `lg` they sit side by side.
//  - The quiet roster: small white cards, four to a row on a desktop, one on a phone. A card with nothing upcoming ends in B's
//    stub (a dashed tear line), whose action is an editor's.
// Server components: the ⋯ menu and the status chip arrive as slots, built by the page (the pass seal's logic stays there).
import type { ReactNode } from "react";
import { Radio } from "lucide-react";
import Link from "@/components/ui/console-link";
import { fmtPublicDate } from "@/lib/format";
import { t, plural, type Dict } from "@/lib/i18n";
import type { Locale } from "@/lib/i18n-constants";
import type { TodayHeadline } from "@/server/usecases/match-day";
import { matchWhen, type HomeStub, type NextLine } from "./home-rules";

/** What every card on the page shows about its competition. */
export interface HomeCardBase {
  slug: string;
  name: string;
  href: string;
  /** Status chip (and the pass seal), built by the page. */
  chip: ReactNode;
  sports: { text: string; full: string } | null;
  /** "3 divisions, 19 entrants". */
  meta: string | null;
  progress: { played: number; total: number };
  /** The ⋯ menu, built by the page. */
  menu: ReactNode;
}

export interface TodayRowData extends HomeCardBase {
  /** Today's headline match (`competitionsFixturesToday`): in play first, else the earliest planned today; null when none of
   *  today's matches can be named (all played, or a side still to be decided) — the row then says how many there are. */
  next: TodayHeadline | null;
  matchesToday: number;
  matchDayHref: string;
}

export interface QuietCardData extends HomeCardBase {
  next: NextLine | null;
  stub: { kind: HomeStub; action: { href: string; label: string; aria: string } | null } | null;
}

/** "Badminton", "Badminton and Tennis", or "3 sports" with the full list for a pointer (title) and a screen reader (sr-only). */
function Sports({ sports, tone }: { sports: HomeCardBase["sports"]; tone: "night" | "light" }) {
  if (!sports) return null;
  const cls = tone === "night" ? "text-cream/70" : "text-slate-500";
  return (
    <span data-testid="org-home-sports" title={sports.full} className={`min-w-0 truncate text-xs ${cls}`}>
      {sports.text === sports.full ? (
        sports.text
      ) : (
        <>
          <span aria-hidden="true">{sports.text}</span>
          <span className="sr-only">{sports.full}</span>
        </>
      )}
    </span>
  );
}

function Progress({ dict, progress, tone }: { dict: Dict; progress: HomeCardBase["progress"]; tone: "night" | "light" }) {
  const label = t(dict, "card.progress.played", { played: progress.played, total: progress.total });
  const pct = progress.total > 0 ? Math.round((progress.played / progress.total) * 100) : 0;
  return (
    <span className="flex min-w-0 items-center gap-2">
      <span
        role="progressbar"
        aria-valuemin={0}
        aria-valuemax={progress.total}
        aria-valuenow={progress.played}
        aria-label={label}
        className={`h-1 min-w-12 flex-1 overflow-hidden rounded-full ${tone === "night" ? "bg-white/15" : "bg-slate-100"}`}
      >
        <span
          className={`block h-full rounded-full ${tone === "night" ? "bg-purple-300" : "bg-purple-600"}`}
          style={{ width: `${pct}%` }}
        />
      </span>
      <span className={`shrink-0 text-[11px] tabular-nums ${tone === "night" ? "text-cream/70" : "text-slate-500"}`}>{label}</span>
    </span>
  );
}

/** The deck's date line, from the organisation's day 'YYYY-MM-DD' (noon UTC, so no zone can move the date). */
export const deckDate = (locale: Locale, day: string) =>
  fmtPublicDate(locale, "UTC", `${day}T12:00:00Z`, { weekday: "long", day: "numeric", month: "long" });

function TodayRow({ row, dict, locale, tz, day }: { row: TodayRowData; dict: Dict; locale: Locale; tz: string; day: string }) {
  const n = row.next;
  // The match's time in the organisation's zone; a match not planned on the deck's day (one in play from yesterday) says which
  // day it was planned for. The quiet card's "Next:" line reads the same `matchWhen`.
  const when = n ? matchWhen(locale, tz, day, n.scheduled_at) : null;
  return (
    <article
      data-testid="org-home-today-row"
      data-comp={row.slug}
      className="relative grid min-w-0 grid-cols-1 gap-3.5 rounded-xl border border-white/10 bg-white/5 p-4 transition-colors hover:border-lime-400/40 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.25fr)_220px] lg:items-center lg:gap-6 lg:px-5"
    >
      <div className="flex min-w-0 flex-col gap-2">
        <div className="flex items-start gap-2">
          <h3 className="min-w-0 flex-1 text-2xl font-bold leading-tight text-white [font-family:var(--font-barlow,var(--font-geist-sans))] [overflow-wrap:anywhere]">
            <Link
              href={row.href}
              className="rounded-sm after:absolute after:inset-0 after:rounded-xl focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-lime-400"
            >
              {row.name}
            </Link>
          </h3>
          <span className="relative z-10 -my-1.5 -mr-2 shrink-0">{row.menu}</span>
        </div>
        <div className="flex min-w-0 flex-wrap items-center gap-x-2.5 gap-y-1">
          {row.chip}
          <Sports sports={row.sports} tone="night" />
        </div>
        {row.meta && <p className="text-xs text-cream/70">{row.meta}</p>}
      </div>

      <div data-testid="org-home-today-match" className="min-w-0 rounded-lg bg-black/25 px-3.5 py-3">
        {n ? (
          <>
            <p className="mb-1 flex flex-wrap items-center gap-x-2.5 gap-y-0.5 text-xs">
              {n.in_play ? (
                <span className="inline-flex items-center gap-1.5 font-bold text-lime-400">
                  <span aria-hidden className="chip-pulse-dot h-1.5 w-1.5 rounded-full bg-lime-400" />
                  <span>{t(dict, "org.home.today.now")}</span>
                </span>
              ) : (
                when && <span className="font-bold tabular-nums text-lime-400">{when}</span>
              )}
              {n.court_label && <span className="min-w-0 text-cream/70 [overflow-wrap:anywhere]">{n.court_label}</span>}
            </p>
            <p className="text-xl font-semibold leading-snug text-white [font-family:var(--font-barlow,var(--font-geist-sans))] [overflow-wrap:anywhere]">
              <span>{n.home}</span> <span className="font-sans text-sm font-normal text-cream/70">{t(dict, "schedule.vs")}</span>{" "}
              <span>{n.away}</span>
            </p>
          </>
        ) : (
          <p className="text-sm text-cream/80">{plural(dict, "org.home.today.matches", row.matchesToday, locale)}</p>
        )}
      </div>

      <div className="flex min-w-0 flex-col gap-2.5">
        <Progress dict={dict} progress={row.progress} tone="night" />
        <Link
          href={row.matchDayHref}
          data-testid="org-home-open-match-day"
          aria-label={t(dict, "org.home.today.openFor", { name: row.name })}
          className="relative z-10 inline-flex min-h-11 items-center justify-center gap-1.5 rounded-lg bg-lime-400 px-4 text-sm font-semibold text-night transition hover:bg-lime-300 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-lime-400"
        >
          <Radio aria-hidden className="h-4 w-4" strokeWidth={2} />
          <span>{t(dict, "desk.tools.openMatchDay")}</span>
        </Link>
      </div>
    </article>
  );
}

/** The night deck: every competition with a match today, in the organisation's day. */
export function TodayDeck({
  rows,
  dict,
  locale,
  tz,
  day,
}: {
  rows: TodayRowData[];
  dict: Dict;
  locale: Locale;
  tz: string;
  day: string;
}) {
  return (
    <section
      data-testid="org-home-today"
      aria-labelledby="org-home-today-h"
      className="mb-8 rounded-2xl bg-[linear-gradient(160deg,var(--color-night-2),var(--color-night))] px-3 pb-3 pt-4 text-cream lg:px-4 lg:pb-4 lg:pt-5"
    >
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-0.5 px-1 pb-3">
        <h2 id="org-home-today-h" className="app-display text-2xl font-bold text-white">
          {t(dict, "org.home.today.title")}
        </h2>
        <p className="text-[13px] text-cream/70">
          {plural(dict, "org.home.today.summary", rows.length, locale, { date: deckDate(locale, day) })}
        </p>
      </div>
      <div className="flex flex-col gap-2">
        {rows.map((r) => (
          <TodayRow key={r.slug} row={r} dict={dict} locale={locale} tz={tz} day={day} />
        ))}
      </div>
    </section>
  );
}

/** No match today anywhere: the deck's place says so, quietly, so the page reads the same way every day. */
export function TodayEmpty({ dict, locale, day }: { dict: Dict; locale: Locale; day: string }) {
  return (
    <section
      data-testid="org-home-today-empty"
      aria-labelledby="org-home-today-h"
      className="mb-8 flex flex-wrap items-baseline gap-x-3 gap-y-0.5 rounded-2xl border border-dashed border-purple-200 bg-white/60 px-4 py-3"
    >
      <h2 id="org-home-today-h" className="app-display text-lg font-bold text-night">
        {t(dict, "org.home.today.title")}
      </h2>
      <p className="text-sm text-slate-600">{t(dict, "org.home.today.empty", { date: deckDate(locale, day) })}</p>
    </section>
  );
}

/** A quiet card: identity, progress, what's next — or B's stub when nothing is. */
export function QuietCard({ card, dict }: { card: QuietCardData; dict: Dict }) {
  return (
    <article
      data-testid="org-home-card"
      data-comp={card.slug}
      className="relative flex h-full min-w-0 flex-col rounded-xl border border-slate-200 bg-white shadow-sm transition-colors hover:border-purple-300"
    >
      <div className="flex min-w-0 flex-1 flex-col gap-2 p-3.5">
        <div className="flex items-start gap-1">
          <h3 className="min-w-0 flex-1 pt-0.5 text-[15px] font-semibold leading-snug text-slate-800 [overflow-wrap:anywhere]">
            <Link
              href={card.href}
              className="rounded-sm after:absolute after:inset-0 after:rounded-xl hover:text-purple-700 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-purple-600"
            >
              {card.name}
            </Link>
          </h3>
          <span className="relative z-10 -my-2 -mr-2 shrink-0">{card.menu}</span>
        </div>
        <div className="flex min-w-0 flex-wrap items-center gap-x-2.5 gap-y-1">
          {card.chip}
          <Sports sports={card.sports} tone="light" />
        </div>
        {card.progress.total > 0 && <Progress dict={dict} progress={card.progress} tone="light" />}
        {card.next && (
          // When first, then the court, then the pair on a line of its own: a phone's truncation eats the names, never the time.
          <div data-testid="org-home-card-next" className="min-w-0 text-xs text-slate-600" title={card.next.text}>
            <p className="flex min-w-0 flex-wrap items-baseline gap-x-1.5">
              <span className="font-semibold text-purple-700">{t(dict, card.next.live ? "card.next.live" : "card.next.upcoming")}</span>
              {card.next.when && <span className="font-semibold tabular-nums text-slate-800">{card.next.when}</span>}
              {card.next.court && <span className="min-w-0 truncate">{card.next.court}</span>}
            </p>
            <p className="truncate">{card.next.pair}</p>
          </div>
        )}
        {card.meta && <p className="text-xs text-slate-500">{card.meta}</p>}
      </div>
      {card.stub && (
        <div
          data-testid="org-home-stub"
          data-stub={card.stub.kind}
          className="flex flex-col items-start gap-0.5 rounded-b-xl border-t-2 border-dashed border-purple-200 bg-purple-50/60 px-3.5 pb-1.5 pt-2.5"
        >
          <p className="text-xs font-medium text-slate-600">
            {t(dict, card.stub.kind === "no_fixtures" ? "card.progress.none" : "org.home.stub.noMatch")}
          </p>
          {card.stub.action ? (
            <Link
              href={card.stub.action.href}
              aria-label={card.stub.action.aria}
              className="relative z-10 inline-flex min-h-11 items-center text-sm font-semibold text-purple-700 underline underline-offset-[3px] hover:text-purple-800 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-purple-600"
            >
              {card.stub.action.label}
            </Link>
          ) : (
            <span className="pb-1" />
          )}
        </div>
      )}
    </article>
  );
}

/** A roster group: "Under way 6", then its cards — one to a row on a phone, two from `md`, four from `lg`. */
export function HomeGroupSection({
  group,
  title,
  count,
  children,
}: {
  group: string;
  title: string;
  count: number;
  children: ReactNode;
}) {
  const id = `org-home-group-${group}`;
  return (
    <section data-testid="org-home-group" data-group={group} aria-labelledby={id} className="mt-6 first:mt-0">
      <h2 id={id} className="app-display mb-3 flex items-baseline gap-2 text-xl font-bold text-night">
        {title}
        <span className="font-sans text-sm font-normal normal-case tracking-normal text-slate-500">{count}</span>
      </h2>
      <div className="grid grid-cols-1 gap-2.5 md:grid-cols-2 md:gap-3 lg:grid-cols-4">{children}</div>
    </section>
  );
}
