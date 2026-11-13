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
import { formatMoneyExact } from "@/lib/currency";
import { fmtPublicDate, fmtPublicDeadline } from "@/lib/format";
import { resolveLocale } from "@/lib/resolve-locale";
import { getDictionary, plural, t } from "@/lib/i18n";
import type { Dict, Locale } from "@/lib/i18n-constants";
import { DictProvider } from "@/components/i18n/dict-provider";
import { renderProse } from "@/lib/prose";
import { fillPaymentInstructions, preserveLineBreaks } from "@/lib/payment-instructions";
import { CopyReference } from "./copy-reference";
import { EntryCard } from "./entry-card";
import { ResendConfirmation } from "./resend-confirmation";
import {
  cartHeadline,
  cartMoneySummary,
  headlineCarriesUnavailableNotice,
  moneyLine,
  offlineInstructionsReference,
  receivedCount,
  whatHappensNext,
  type MoneySummary,
  type NextItem,
} from "./view-model";
import { routes } from "@/lib/routes";

export const metadata: Metadata = { robots: { index: false, follow: false } };

/** A competition's own dates ('YYYY-MM-DD', no zone) the way the org hub prints them: "5 Dec 2026", read in UTC so the calendar day
 *  never shifts. */
const COMPETITION_DATE: Intl.DateTimeFormatOptions = { day: "numeric", month: "short", year: "numeric" };

/** The money line's sentence (spec §5.3). Every amount in the cart's one currency, always to 2 decimals. */
function moneySentence(money: MoneySummary, currency: string, locale: Locale, ui: Dict): string {
  const amount = (cents: number) => formatMoneyExact(cents, currency, locale);
  switch (moneyLine(money)) {
    case "paidDue":
      return t(ui, "register.status.money.paidDue", { paid: amount(money.paidCents), due: amount(money.dueCents) });
    case "paid":
      return t(ui, "register.status.money.paid", { amount: amount(money.paidCents) });
    case "due":
      return t(ui, "register.status.money.due", { amount: amount(money.dueCents) });
    case "waitlisted":
      return t(ui, "register.status.money.waitlisted", { amount: amount(money.waitlistedCents) });
    case "nothing":
      return t(ui, "register.status.money.nothing");
  }
}

/** One "What happens next" line. `whatHappensNext` hands over raw values (see `NextItem`); this localises them: the competition's
 *  dates as calendar days, a pay-by deadline in the org's own zone with its label (the card's own "Pay by" format). */
function nextSentence(item: NextItem, locale: Locale, timezone: string, ui: Dict): string {
  const vars = { ...item.vars };
  for (const day of ["date", "start", "end"] as const) {
    if (vars[day]) vars[day] = fmtPublicDate(locale, "UTC", vars[day], COMPETITION_DATE);
  }
  if (vars.deadline) vars.deadline = fmtPublicDeadline(locale, timezone, vars.deadline);
  return item.count === undefined ? t(ui, item.key, vars) : plural(ui, item.key, item.count, locale, vars);
}

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
            <Link href={routes.publicHub(orgSlug, competitionSlug)} className="hover:text-accent-strong hover:underline">
              {t(ui, "status.breadcrumb")}
            </Link>
          </p>
          <h1 className="mt-1 font-display text-2xl font-semibold text-ink">{t(ui, "register.status.heading")}</h1>
          <p className="mt-2 text-sm text-zinc-500">{t(ui, "register.status.notFound")}</p>
        </div>
      </DictProvider>
    );
  }

  // Registration redesign B4 T15 (spec §5): the page leads with the outcome, then the reference, the entries, the money and what
  // happens next. Each is a pure function of the view (view-model.ts); this only words what they return.
  //
  // The money line is summed fresh from the entries this render has, never `view.amount_cents` (a submit-time snapshot that a
  // promotion never updates), and paid is counted by settlement, never by status: a fee waiver confirms an entry and keeps its fee.
  const headline = cartHeadline(view.entries, view);
  const headlineText =
    headline === "received"
      ? plural(ui, "register.status.headline.received", receivedCount(view.entries, view), locale)
      : // B4 review m1: the card notice the owed entry's card already carries, as the page's lead line (owner ruling: the existing
        // notice, not new copy).
        headline === "payUnavailable"
        ? t(ui, "register.status.pay.unavailable")
        : t(ui, `register.status.headline.${headline}`);
  const money = cartMoneySummary(view.entries, view);
  const nextItems = whatHappensNext(view, headline, new Date());
  // The address is set in its own span (layout.tsx's poweredBy split): the template is split on its one placeholder.
  const [sentLead, sentTail = ""] = t(ui, "register.status.sentTo").split("{email}");

  // Rendered ONCE (cart-level, not per entry — every offline-due entry in
  // this cart reads the SAME instructions) so EntryCard can stay a plain,
  // non-async component (see its own doc comment for why that matters for
  // this page's own render-to-static-markup tests).
  //
  // B5 T18 (spec §6.3): {{reference}} is the one entry's own reference when exactly one entry owes, the cart's when several do
  // (`offlineInstructionsReference`), so the line a person quotes to their bank is the one the organiser can match.
  const instructionsHtml = view.payment_instructions
    ? await renderProse(
        preserveLineBreaks(fillPaymentInstructions(view.payment_instructions, offlineInstructionsReference(view.entries, view))),
      )
    : null;
  const cart = {
    cart_size: view.cart_size,
    expires_at: view.expires_at,
    charges_enabled: view.charges_enabled,
    instructionsHtml,
    currency: view.currency,
    // FIX #13(a): org's own zone (already resolved server-side as refundTz —
    // usecases/registrations/) — entry-card.tsx renders every deadline in this,
    // never a hardcoded UTC.
    timezone: view.org_timezone,
    // B4 fix round 2: a one-entry cart's h1 IS the card notice, so its card does not repeat it.
    unavailableNoticeInHeadline: headlineCarriesUnavailableNotice(view.entries.length, headline),
  };

  return (
    <DictProvider dict={ui} locale={locale}>
      <div
        // Bottom clearance for the global cookie-consent banner
        // (components/cookie-consent.tsx: fixed, bottom-4, z-40). On a
        // first visit — which a registration email always is — the banner
        // sat directly over this page's own primary actions: "Cancel this
        // entry" at 1280px, the whole roster block + per-slot claim links
        // at 320px (measured live: the banner renders ~240px tall on
        // mobile, ~160px on desktop, both anchored bottom-4). The banner
        // itself is out of scope here (blast radius — it's shared by every
        // page); this page reserves its own trailing clearance instead,
        // same "fixed bar → spacer" shape as globals.css's own
        // `.bottom-bar`/`.bottom-bar-spacer` pair, safe-area aware to match
        // `pb-[calc(<n>+env(safe-area-inset-bottom))]` elsewhere
        // (confirm-provider.tsx, modal.tsx).
        className="mx-auto max-w-2xl px-4 pt-8 pb-[calc(280px+env(safe-area-inset-bottom))] sm:px-6 sm:pb-[calc(200px+env(safe-area-inset-bottom))]"
      >
        <p className="text-xs text-ink-muted">
          {/* The RESOLVED view's own org/competition — token-authenticated,
              so trusted over the URL's own path segments (which could be a
              stale link after a slug rename). */}
          <Link
            href={routes.publicHub(view.org_slug, view.competition_slug)}
            className="hover:text-accent-strong hover:underline"
          >
            {view.competition_name}
          </Link>
        </p>

        <h1 data-testid="reg-status-headline" data-headline={headline} className="mt-1 font-display text-2xl font-semibold text-ink">
          {headlineText}
        </h1>
        {/* The mail is queued at submit, so this states a fact. The address is the registrant's own: kept out of session replay. */}
        <p className="mt-2 text-sm text-ink-muted">
          {sentLead}
          <span className="ph-no-capture font-medium break-all text-ink">{view.contact_email}</span>
          {sentTail}
        </p>

        {/* The reference hero: the largest type on the page (spec §5.1 item 2). A cart whose reference mint ran out of retries has
            none (`ref_code` is nullable), so there is nothing to show or copy. Per-entry suffixes (B5) go on each card, not here: the hero is
            the whole cart's. */}
        {view.ref_code && (
          <section
            data-testid="reg-status-ref"
            aria-labelledby="reg-status-ref-label"
            className="mt-6 rounded-xl border border-zinc-200 bg-surface p-4 shadow-sm"
          >
            <div className="flex flex-wrap items-end justify-between gap-x-4 gap-y-3">
              <div className="min-w-0">
                <p id="reg-status-ref-label" className="text-sm text-ink-muted">
                  {t(ui, "register.ticket.refLabel")}
                </p>
                <p className="mt-1 font-mono text-3xl font-semibold tracking-wide break-all text-ink select-all sm:text-4xl">{view.ref_code}</p>
              </div>
              <CopyReference reference={view.ref_code} />
            </div>
          </section>
        )}

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

        {/* One sentence, never a bare figure (spec §5.3): "Paid £15.00 · £24.00 still due". */}
        <p
          data-testid="reg-status-money"
          data-money-kind={moneyLine(money)}
          data-paid-cents={money.paidCents}
          data-due-cents={money.dueCents}
          className="mt-6 border-t border-zinc-200 pt-4 text-lg font-semibold text-ink"
        >
          {moneySentence(money, view.currency, locale, ui)}
        </p>

        {/* Real data only (spec §5.2): the competition's dates, the one venue its published fixtures share, and one step. Not
            rendered at all when there is nothing to say. Not numbered: the lines are facts, not a sequence. A surface panel on the
            canvas page, without the entry cards' shadow: guidance, quieter than the entries above it. */}
        {nextItems.length > 0 && (
          <section
            data-testid="reg-status-next"
            aria-labelledby="reg-status-next-title"
            className="mt-6 rounded-xl border border-zinc-200 bg-surface p-4"
          >
            <h2 id="reg-status-next-title" className="font-display text-base font-semibold text-ink">
              {t(ui, "register.status.next.title")}
            </h2>
            <ul className="mt-2 space-y-1.5 text-sm text-ink">
              {nextItems.map((item) => (
                <li key={item.kind} data-next-kind={item.kind}>
                  {nextSentence(item, locale, view.org_timezone, ui)}
                </li>
              ))}
            </ul>
          </section>
        )}

        {/* Quiet footer (spec §5.1 item 7): a text link, not a button competing with Pay. Each entry's Cancel is its own card's
            footer link. */}
        <div className="mt-4">
          <ResendConfirmation groupId={rid} token={token} />
        </div>
      </div>
    </DictProvider>
  );
}
