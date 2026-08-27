export const dynamic = "force-dynamic";
// RS007 rebuild — the real registrant surface (RS006 §C shipped a
// deliberately minimal read-only render; this replaces it). The URL
// convention is unchanged from RS006: `?rid=<group_id>&token=<access_token>`
// (already minted by buildCartMail's statusUrl and
// createRegistrationCheckout's Stripe success/cancel URLs) — `ref_code` is
// nullable on the schema (a submit whose ref-mint retries were exhausted
// still commits the cart), `group_id` never is, so this page follows the
// code that already ships links, not the design doc's `?ref=` placeholder.
//
// This is the page a paying registrant actually returns to:
// createRegistrationCheckout's `returnBase` takes the token branch whenever
// a token exists (a cart submit always has one), appending
// `&checkout=success&session_id={CHECKOUT_SESSION_ID}` on success. That
// session_id is reconciled BEFORE the read (reconcile-on-return, matching
// /r/[ref]'s own pattern) so a paid cart shows confirmed on first view even
// when the webhook is slow or lost — the webhook stays primary (async
// payment methods settle days later and a registrant may never revisit).
import Link from "next/link";
import type { Metadata } from "next";
import {
  groupById,
  reconcileRegistrationGroupBySession,
  type GroupStatusView,
} from "@/server/usecases/registrations";
import { HttpError } from "@/lib/errors";
import { formatMinor, type Currency } from "@/lib/currency";
import { resolveLocale } from "@/lib/resolve-locale";
import { getDictionary, t } from "@/lib/i18n";
import { DictProvider } from "@/components/i18n/dict-provider";
import { renderProse } from "@/lib/prose";
import { fillPaymentInstructions } from "@/lib/payment-instructions";
import { EntryCard } from "./entry-card";
import { ResendConfirmation } from "./resend-confirmation";

export const metadata: Metadata = { robots: { index: false, follow: false } };

type Props = {
  params: Promise<{ orgSlug: string; competitionSlug: string }>;
  searchParams: Promise<{ rid?: string; token?: string; checkout?: string; session_id?: string }>;
};

export default async function RegistrationStatusPage({ params, searchParams }: Props) {
  const { orgSlug, competitionSlug } = await params;
  const { rid, token, checkout, session_id } = await searchParams;
  const locale = await resolveLocale();
  const ui = await getDictionary(locale, "ui");

  // Reconcile-on-return: best-effort, never throws (see
  // reconcileRegistrationGroupBySession's own doc comment) — run BEFORE
  // groupById so a just-paid cart already reads confirmed on this render,
  // not one refresh later.
  if (rid && token && checkout === "success" && session_id) {
    await reconcileRegistrationGroupBySession(rid, token, session_id);
  }

  // Missing rid/token is the SAME outcome as groupById's own 404 (a bare
  // visit to this route, or a mistyped/stale link) — one not-found render,
  // not two. A wrong token and a nonexistent id are indistinguishable by
  // groupById's own contract (registration-status-read.test.ts): the ref
  // alone (there isn't even one in this URL shape) is never sufficient.
  // Anything OTHER than a 404 (a genuine outage) propagates rather than
  // being swallowed into the same friendly message.
  let view: GroupStatusView | null = null;
  if (rid && token) {
    try {
      view = await groupById(rid, token);
    } catch (err) {
      if (!(err instanceof HttpError && err.status === 404)) throw err;
    }
  }

  if (!view || !rid || !token) {
    return (
      <DictProvider dict={ui} locale={locale}>
        <div className="mx-auto max-w-xl px-4 py-8 sm:px-6">
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

  // Live subtotal: NEVER view.amount_cents (group.amount_cents is a
  // submit-time snapshot — promoteWaitlistedRow updates a promoted entry's
  // own amount_cents but never that mirror, so it goes stale the moment any
  // entry is promoted). Summed fresh from the entries this render actually
  // has, the same "non-waitlisted" rule buildCartMail's own subtotal uses.
  const subtotalCents = view.entries
    .filter((e) => e.status !== "waitlisted")
    .reduce((sum, e) => sum + e.amount_cents, 0);

  // Rendered ONCE (cart-level, not per entry — every offline-due entry in
  // this cart reads the SAME instructions) so EntryCard can stay a plain,
  // non-async component (see its own doc comment for why that matters for
  // this page's own render-to-static-markup tests).
  const instructionsHtml = view.payment_instructions
    ? await renderProse(fillPaymentInstructions(view.payment_instructions, view.ref_code))
    : null;
  const cart = {
    payment_method: view.payment_method,
    expires_at: view.expires_at,
    charges_enabled: view.charges_enabled,
    instructionsHtml,
    currency: view.currency,
  };

  return (
    <DictProvider dict={ui} locale={locale}>
      <div className="mx-auto max-w-2xl px-4 py-8 sm:px-6">
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

        <div className="mt-1 flex flex-wrap items-start justify-between gap-x-4 gap-y-2">
          <div className="min-w-0">
            <h1 className="font-display text-2xl font-semibold text-ink">{t(ui, "register.status.heading")}</h1>
            <p className="mt-2 text-sm text-ink-muted">
              {t(ui, "register.ticket.refLabel")}:{" "}
              <span className="font-mono font-semibold text-ink">{view.ref_code}</span>
            </p>
            <p className="text-sm text-ink-muted">
              {view.contact_name} · {view.org_name}
            </p>
          </div>
          <ResendConfirmation groupId={rid} token={token} />
        </div>

        <ul className="mt-6 space-y-3">
          {view.entries.map((entry) => (
            <EntryCard
              key={entry.id}
              entry={entry}
              cart={cart}
              orgSlug={view.org_slug}
              competitionSlug={view.competition_slug}
              token={token}
              locale={locale}
              ui={ui}
            />
          ))}
        </ul>

        <div className="mt-6 flex items-center justify-between border-t border-zinc-200 pt-3">
          <span className="text-xs font-semibold uppercase tracking-wider text-ink-muted">
            {t(ui, "register.entries.cart.subtotal")}
          </span>
          <span className="text-lg font-bold text-ink">
            {subtotalCents === 0
              ? t(ui, "register.entries.free")
              : formatMinor(subtotalCents, view.currency as Currency, locale)}
          </span>
        </div>
      </div>
    </DictProvider>
  );
}
