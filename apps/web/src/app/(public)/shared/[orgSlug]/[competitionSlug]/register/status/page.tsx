export const dynamic = "force-dynamic";
// RS006 §C — post-submit status page. Design §4 names the shape
// `?ref=<GROUP_REF>`; the ACTUAL, already-shipped convention (already minted
// by buildCartMail's statusUrl and createRegistrationCheckout's Stripe
// success/cancel URLs, registrations.ts) is `?rid=<group_id>&token=
// <access_token>` — `ref_code` is nullable on the schema (a submit whose
// ref-mint retries were exhausted still commits the cart), `group_id` never
// is, so this page follows the code that already ships links, not the
// design doc's placeholder param name.
//
// Deliberately minimal (RS006 dispatch §C): the group ref plus every
// entry's own division/status/fee, plainly — no roster fill meter, no
// join-link, no cancel/pay-now action. RS007 rebuilds this into the real
// surface (its own prompt: "rebuild .../register/status from RS006's
// minimal render into the real surface"); `/r/[ref]` is explicitly RS007's
// to restore, not this session's.
import Link from "next/link";
import type { Metadata } from "next";
import { groupById, type GroupStatusView } from "@/server/usecases/registrations";
import { HttpError } from "@/lib/errors";
import { formatMinor, type Currency } from "@/lib/currency";
import { resolveLocale } from "@/lib/resolve-locale";
import { getDictionary, t } from "@/lib/i18n";
import { DictProvider } from "@/components/i18n/dict-provider";

export const metadata: Metadata = { robots: { index: false, follow: false } };

/** `reg.status.*` — the SAME plain status vocabulary the org hub CSV export
 *  and the .ics DESCRIPTION already reuse (registrations.ts's own
 *  REG_ICS_STATUS_KEY comment invites exactly this: "currently unwired
 *  elsewhere"), rather than minting a second one for this page alone.
 *  "rejected" completes the set (RS006 §C — the design's new terminal
 *  status; the ICS map never needed it, this page can reach it). */
const STATUS_KEY: Record<GroupStatusView["entries"][number]["status"], string> = {
  pending: "reg.status.pending",
  paid: "reg.status.paid",
  confirmed: "reg.status.confirmed",
  waitlisted: "reg.status.waitlisted",
  rejected: "reg.status.rejected",
  withdrawn: "reg.status.withdrawn",
  expired: "reg.status.expired",
};

type Props = {
  params: Promise<{ orgSlug: string; competitionSlug: string }>;
  searchParams: Promise<{ rid?: string; token?: string }>;
};

export default async function RegistrationStatusPage({ params, searchParams }: Props) {
  const { orgSlug, competitionSlug } = await params;
  const { rid, token } = await searchParams;
  const locale = await resolveLocale();
  const ui = await getDictionary(locale, "ui");

  // Missing rid/token is the SAME outcome as groupById's own 404 (a bare
  // visit to this route, or a mistyped/stale link) — one not-found render,
  // not two. A wrong token and a nonexistent id are indistinguishable by
  // groupById's own contract (registration-status-read.test.ts); anything
  // OTHER than a 404 (a genuine outage) is left to propagate, not swallowed
  // into the same friendly message.
  let view: GroupStatusView | null = null;
  if (rid && token) {
    try {
      view = await groupById(rid, token);
    } catch (err) {
      if (!(err instanceof HttpError && err.status === 404)) throw err;
    }
  }

  if (!view) {
    return (
      <DictProvider dict={ui} locale={locale}>
        <div className="mx-auto max-w-xl">
          <p className="text-xs text-ink-muted">
            <Link href={`/shared/${orgSlug}/${competitionSlug}`} className="hover:text-accent-strong hover:underline">
              {t(ui, "status.breadcrumb")}
            </Link>
          </p>
          <h1 className="mt-1 font-display text-2xl font-semibold text-ink">{t(ui, "register.status.heading")}</h1>
          <p className="mt-2 text-sm text-zinc-500">{t(ui, "register.status.notFound")}</p>
        </div>
      </DictProvider>
    );
  }

  return (
    <DictProvider dict={ui} locale={locale}>
      <div className="mx-auto max-w-xl">
        <p className="text-xs text-ink-muted">
          {/* The RESOLVED view's own org/competition — token-authenticated,
              so trusted over the URL's own path segments (which could be a
              stale link after a slug rename). */}
          <Link
            href={`/shared/${view.org_slug}/${view.competition_slug}`}
            className="hover:text-accent-strong hover:underline"
          >
            {view.competition_name}
          </Link>
        </p>
        <h1 className="mt-1 font-display text-2xl font-semibold text-ink">{t(ui, "register.status.heading")}</h1>
        <p className="mt-2 text-sm text-ink-muted">
          {t(ui, "register.ticket.refLabel")}: <span className="font-mono font-semibold text-ink">{view.ref_code}</span>
        </p>
        <p className="text-sm text-ink-muted">
          {view.contact_name} · {view.org_name}
        </p>

        <ul className="mt-6 space-y-3">
          {view.entries.map((entry) => (
            <li key={entry.id} className="rounded-lg border border-zinc-200 p-3">
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <p className="truncate font-semibold text-ink">{entry.division_name}</p>
                  <p className="truncate text-sm text-ink-muted">{entry.display_name}</p>
                </div>
                <div className="shrink-0 text-right">
                  <p className="text-sm font-medium text-ink">{t(ui, STATUS_KEY[entry.status])}</p>
                  <p className="text-xs text-ink-muted">
                    {entry.amount_cents === 0
                      ? t(ui, "register.entries.free")
                      : formatMinor(entry.amount_cents, view.currency as Currency, locale)}
                  </p>
                </div>
              </div>
            </li>
          ))}
        </ul>

        <div className="mt-6 flex items-center justify-between border-t border-zinc-200 pt-3">
          <span className="text-xs font-semibold uppercase tracking-wider text-ink-muted">
            {t(ui, "register.entries.cart.subtotal")}
          </span>
          <span className="text-lg font-bold text-ink">
            {view.amount_cents === 0 ? t(ui, "register.entries.free") : formatMinor(view.amount_cents, view.currency as Currency, locale)}
          </span>
        </div>
      </div>
    </DictProvider>
  );
}
