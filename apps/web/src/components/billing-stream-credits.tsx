import Link from "next/link";
import { t, plural, type Dict, type Locale, type TKey } from "@/lib/i18n";
import type { StreamCreditsTabView } from "@/server/usecases/stream-credits-tab";
import type { StreamHistoryFixture, StreamHistoryRow } from "@/server/usecases/stream-credit-history";
import { BuyStreamCredits } from "@/components/buy-stream-credits";
import type { Currency } from "@/lib/currency";
import { routes } from "@/lib/routes";

/** What the page learned from the buyer's return from Stripe: `paid` — the credits are in the balance below; `processing` —
 *  it is this org's checkout but the payment has not cleared (or the ledger not been written) yet, so the credits arrive a
 *  moment later. `null` — this is not a return, or the session was not this org's: say nothing. */
export type StreamPurchaseNotice = "paid" | "processing" | null;

interface Props {
  view: StreamCreditsTabView;
  dict: Dict;
  locale: Locale;
  orgId: string;
  orgSlug: string;
  currency: Currency;
  notice: StreamPurchaseNotice;
  /** The cursor this page was read with — present means "not the first page", so the pager offers the way back. */
  cursor: string | undefined;
}

/** More free credits than this and a row of segments is a smear, so the meter falls back to one continuous bar. */
const SEGMENT_CAP = 20;

function fmtDay(iso: string, locale: Locale): string {
  // UTC: the free credits turn over at the start of the UTC month, and a row dated by the viewer's zone could read as
  // the wrong month's grant.
  return new Date(iso).toLocaleDateString(locale, { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" });
}

function fixtureLabel(dict: Dict, f: StreamHistoryFixture): string {
  if (!f.homeName && !f.awayName) return t(dict, "settings.credits.stream.matchNo", { no: f.fixtureNo });
  const tbd = t(dict, "settings.credits.stream.tbd");
  return t(dict, "settings.credits.stream.fixture", { home: f.homeName ?? tbd, away: f.awayName ?? tbd });
}

/** The row's activity in plain words. A pack names how many credits it brought; every other kind is one fixed sentence. */
function activityLabel(dict: Dict, locale: Locale, row: StreamHistoryRow): string {
  if (row.kind === "packPurchase") return plural(dict, "settings.credits.stream.kind.packPurchase", Math.abs(row.delta), locale);
  return t(dict, `settings.credits.stream.kind.${row.kind}` as TKey);
}

/** One segment per free credit — the month's allowance as something you can count, filled as matches are streamed. Amber
 *  once 90% is gone, the same threshold the AI meter turns at. Decorative: the words beside it carry the number. */
function FreeMeter({ cap, used }: { cap: number; used: number }) {
  const spent = used / cap >= 0.9;
  const fill = spent ? "bg-amber-500" : "bg-purple-500";
  if (cap > SEGMENT_CAP) {
    return (
      <div aria-hidden className="mt-2 h-2 w-full rounded-full bg-purple-100">
        <div className={`h-2 rounded-full ${fill}`} style={{ width: `${Math.min(100, (used / cap) * 100)}%` }} />
      </div>
    );
  }
  return (
    <div aria-hidden data-testid="credits-stream-meter" className="mt-2 flex w-full gap-1">
      {Array.from({ length: cap }, (_, i) => (
        <span key={i} className={`h-2 min-w-0 flex-1 rounded-sm ${i < used ? fill : "bg-purple-100"}`} />
      ))}
    </div>
  );
}

function HistoryRow({ row, dict, locale }: { row: StreamHistoryRow; dict: Dict; locale: Locale }) {
  return (
    <div
      role="row"
      data-testid="credits-stream-row"
      data-kind={row.kind}
      className="grid grid-cols-[minmax(0,1fr)_auto] items-baseline gap-x-3 gap-y-1 border-b border-purple-50 py-3 last:border-0 lg:grid-cols-[7rem_minmax(0,1.2fr)_minmax(0,1.6fr)_4rem_6rem] lg:items-center"
    >
      <div role="cell" className="text-xs text-slate-500 max-lg:order-4 lg:text-sm">
        <time dateTime={row.dateIso}>{fmtDay(row.dateIso, locale)}</time>
      </div>
      <div role="cell" className="min-w-0 text-sm font-medium text-slate-800 max-lg:order-1">
        {activityLabel(dict, locale, row)}
      </div>
      {row.fixture ? (
        <div role="cell" className="min-w-0 max-lg:order-3 max-lg:col-span-2">
          {/* The hit area is the full 44px without taking the room: the padding is paid back by the negative margin. */}
          <Link href={row.fixture.href} className="-my-3 block truncate py-3 text-sm text-purple-700 hover:underline">
            {fixtureLabel(dict, row.fixture)}
          </Link>
          <span className="block truncate text-xs text-slate-500">{row.fixture.competitionName}</span>
        </div>
      ) : (
        <div role="cell" className="text-sm text-slate-500 max-lg:hidden">
          —
        </div>
      )}
      <div
        role="cell"
        className={`text-right text-sm font-semibold tabular-nums max-lg:order-2 ${row.delta < 0 ? "text-slate-700" : "text-emerald-700"}`}
      >
        {row.delta > 0 ? `+${row.delta}` : row.delta}
      </div>
      <div role="cell" className="text-right text-xs tabular-nums text-slate-500 max-lg:order-5 lg:text-sm">
        <span className="lg:hidden">{t(dict, "settings.credits.stream.col.balance")}: </span>
        {row.balanceAfter}
      </div>
    </div>
  );
}

/**
 * Settings → Credits → Streaming (owner decision 2026-10-20, Option A): the match-credit balance, this month's free
 * allowance, the packs to buy and the ledger as the organiser reads it. The twin of `BillingCredits` (the AI wallet) in the
 * same card / eyebrow / balance-box idiom, so the two sides of the tab read as one screen.
 *
 * The history is ONE DOM: stacked two-line cards below `lg` (1024), a five-column table from `lg` up, ordered with `max-lg:order-*`
 * (never a second tree). The cut is `lg`, not `md`: the Settings rail takes 176px beside the page, so at 768 the card is
 * ~490px wide and a five-column grid left the Activity column ~60px; from 1024 the card is 744px and Activity gets ~180px. It scrolls with the page — nothing here is a scroll region — and a long competition or entrant
 * name truncates inside `min-w-0` all the way up the chain.
 */
export function BillingStreamCredits({ view, dict, locale, orgId, orgSlug, currency, notice, cursor }: Props) {
  const rows = view.history.rows;
  const older = view.history.nextCursor
    ? `${routes.creditsStream(orgSlug)}&before=${encodeURIComponent(view.history.nextCursor)}`
    : null;
  const latest = cursor ? routes.creditsStream(orgSlug) : null;

  return (
    <section data-credits-stream className="card mb-6 p-5">
      <h2 className="mb-4 text-xs font-semibold uppercase tracking-wide text-purple-600">
        {t(dict, "settings.credits.stream.title")}
      </h2>

      {notice && (
        <p
          role="status"
          data-testid={notice === "paid" ? "credits-stream-paid" : "credits-stream-processing"}
          className={`mb-4 rounded-lg border px-3 py-2 text-sm ${
            notice === "paid" ? "border-emerald-200 bg-emerald-50 text-emerald-900" : "border-amber-200 bg-amber-50 text-amber-900"
          }`}
        >
          {t(dict, notice === "paid" ? "settings.credits.stream.paid" : "settings.credits.stream.processing")}
        </p>
      )}

      <div className="rounded-xl border border-purple-100 bg-purple-50/40 p-4">
        <div className="flex items-baseline justify-between gap-2">
          <span className="text-sm text-slate-600">{t(dict, "settings.credits.stream.balance")}</span>
          <span data-testid="credits-stream-balance" className="text-2xl font-bold text-slate-800">
            {plural(dict, "settings.credits.stream.balanceCount", view.total, locale)}
          </span>
        </div>

        {view.freeAllowance > 0 && (
          <div className="mt-4">
            <div className="flex flex-wrap justify-between gap-x-2 text-sm">
              <span className="text-slate-600">{t(dict, "settings.credits.stream.free")}</span>
              <span data-testid="credits-stream-free-used" className="font-medium text-slate-800">
                {t(dict, "settings.credits.stream.freeUsed", { used: view.freeUsed, cap: view.freeAllowance })}
              </span>
            </div>
            <FreeMeter cap={view.freeAllowance} used={view.freeUsed} />
            <p className="mt-1 text-xs text-slate-500">
              {plural(dict, "settings.credits.stream.resets", view.freeResetsInDays, locale)}
            </p>
          </div>
        )}

        <p className="mt-3 text-sm text-slate-600">
          {t(dict, "settings.credits.stream.bought", { count: view.pack })}{" "}
          <span className="text-xs text-slate-500">({t(dict, "settings.credits.stream.boughtNote")})</span>
        </p>
      </div>

      <div className="mt-5">
        {view.offer === "on" ? (
          <BuyStreamCredits orgId={orgId} currency={currency} />
        ) : (
          <p
            data-testid="credits-stream-notice"
            className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-900"
          >
            {t(dict, view.offer === "unavailable" ? "settings.credits.stream.unavailable" : "settings.credits.stream.notIncluded")}
          </p>
        )}
      </div>

      <div className="mt-6">
        <div className="mb-2 flex items-center justify-between gap-2">
          <h3 className="text-sm font-semibold text-slate-700">{t(dict, "settings.credits.stream.history")}</h3>
          {rows.length > 0 && (
            <a
              href={routes.creditsStreamCsv(orgSlug)}
              download
              data-testid="credits-stream-export"
              className="btn btn-ghost min-h-11 text-xs"
            >
              {t(dict, "billing.credits.export")}
            </a>
          )}
        </div>

        {rows.length === 0 ? (
          <p
            data-testid="credits-stream-empty"
            className="rounded-xl border border-dashed border-purple-100 px-4 py-6 text-center text-sm text-slate-500"
          >
            {t(dict, "settings.credits.stream.empty")}
          </p>
        ) : (
          <div role="table" aria-label={t(dict, "settings.credits.stream.history")} data-testid="credits-stream-history">
            <div role="rowgroup" className="max-lg:hidden">
              <div
                role="row"
                className="grid grid-cols-[7rem_minmax(0,1.2fr)_minmax(0,1.6fr)_4rem_6rem] gap-x-3 border-b border-purple-100 py-2 text-xs font-medium text-slate-500"
              >
                <div role="columnheader">{t(dict, "billing.credits.col.date")}</div>
                <div role="columnheader">{t(dict, "billing.credits.col.activity")}</div>
                <div role="columnheader">{t(dict, "settings.credits.stream.col.match")}</div>
                <div role="columnheader" className="text-right">{t(dict, "billing.credits.col.change")}</div>
                <div role="columnheader" className="text-right">{t(dict, "settings.credits.stream.col.balance")}</div>
              </div>
            </div>
            <div role="rowgroup">
              {rows.map((row) => (
                <HistoryRow key={row.id} row={row} dict={dict} locale={locale} />
              ))}
            </div>
          </div>
        )}

        {(older || latest) && (
          <nav
            aria-label={t(dict, "settings.credits.stream.pages")}
            data-testid="credits-stream-pager"
            className="mt-3 flex flex-wrap items-center justify-between gap-2"
          >
            {latest ? (
              <Link href={latest} data-testid="credits-stream-latest" className="btn btn-ghost min-h-11 text-sm">
                {t(dict, "settings.credits.stream.latest")}
              </Link>
            ) : (
              <span />
            )}
            {older && (
              <Link href={older} data-testid="credits-stream-older" className="btn btn-ghost min-h-11 text-sm">
                {t(dict, "settings.credits.stream.older")}
              </Link>
            )}
          </nav>
        )}
      </div>
    </section>
  );
}
