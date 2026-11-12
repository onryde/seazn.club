// components/registrations/pay-page-view.tsx - the player payment page (plan 2026-11-11-player-payment-page, Task 4): what a chase
// mail's `/r/pay/<token>` shows. A SERVER component: it is handed the document (server/usecases/registrations/pay-page.ts) in the
// entry's language, that language's dictionary and the Pay action the page builds from the token, and draws; it reads nothing.
//
// Details first (owner's Option B): the entry's facts lead - what, which division, when, who, what it costs, by when - and the one
// thing to do sits underneath them in the state's own panel. The only loud element is that panel: a Pay button while there is
// something to pay, a calm sentence in every other state. House public theme throughout (canvas, surface, accent-line, ink).
//
// One DOM for every width: the detail list is a stacked label / value pair on a phone and a two-column grid from `sm`; every
// value a person typed wraps (`break-words`, `min-w-0` down the whole chain) so a 43-character entrant name never pushes the page
// sideways at 320.
//
// The token is a bearer credential. It reaches this file only inside `payAction`, and the one element that carries it (the Pay
// form) is `ph-no-capture` (PostHog replay never records it; lib/__tests__/scrub-secret-painters.test.ts).
import type { CSSProperties, ReactNode } from "react";
import type { Dict } from "@/lib/i18n-constants";
import { t } from "@/lib/i18n-runtime";
import { payPageMoney } from "@/lib/registration-pay";
import { PayPageConfirming } from "@/components/registrations/pay-page-confirming";
import type { PayPageDoc } from "@/server/usecases/registrations/pay-page";

/** The root layout mounts Barlow Condensed as `--font-barlow`; the public theme's `font-display` reads `--ps-font-display`. */
const DISPLAY_FACE = { "--ps-font-display": "var(--font-barlow)" } as CSSProperties;

const day = (locale: string, iso: string) =>
  new Intl.DateTimeFormat(locale, { dateStyle: "medium", timeZone: "UTC" }).format(new Date(`${iso}T00:00:00.000Z`));
const dateTime = (locale: string, d: Date) =>
  new Intl.DateTimeFormat(locale, {
    day: "numeric",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    timeZone: "UTC",
    timeZoneName: "short",
  }).format(d);

function Row({ label, testId, children }: { label: string; testId?: string; children: ReactNode }) {
  return (
    <div className="grid min-w-0 gap-0.5 border-b border-accent-line/70 py-2.5 last:border-b-0 sm:grid-cols-[minmax(0,10rem)_minmax(0,1fr)] sm:gap-4">
      <dt className="text-sm text-ink-muted">{label}</dt>
      <dd data-testid={testId} className="min-w-0 text-sm font-medium break-words text-ink">
        {children}
      </dd>
    </div>
  );
}

/** A plain one-card screen: the throttled and the not-found answers. Takes no token. */
export function PayPageNotice({ testId, title, body }: { testId: string; title: string; body: string }) {
  return (
    <main data-testid={testId} style={DISPLAY_FACE} className="grid min-h-[70vh] place-items-center bg-canvas px-4 py-12 text-ink">
      <div className="w-full max-w-md min-w-0 rounded-2xl border border-accent-line bg-surface px-6 py-8 text-center">
        <h1 className="font-display text-2xl font-bold break-words text-ink">{title}</h1>
        <p className="mt-2 text-sm text-ink-muted">{body}</p>
      </div>
    </main>
  );
}

export function PayPageView({
  doc,
  ui,
  payAction,
  confirming,
  retryNotice = false,
}: {
  doc: PayPageDoc;
  ui: Dict;
  /** `/r/pay/<token>/pay`: carries the token. */
  payAction: string;
  /** The page's `isPayConfirming` verdict on this request. */
  confirming: boolean;
  /** `?notice=retry`: the Pay route sent the player back after their press lost a race to another press. Shown only above a
   *  live Pay form. */
  retryNotice?: boolean;
}) {
  const money = (cents: number) => payPageMoney(doc.locale, cents, doc.currency);
  const total = money(doc.totalCents);
  const dates =
    doc.startsOn && doc.endsOn && doc.endsOn !== doc.startsOn
      ? `${day(doc.locale, doc.startsOn)} – ${day(doc.locale, doc.endsOn)}`
      : doc.startsOn
        ? day(doc.locale, doc.startsOn)
        : null;
  const showConfirming = confirming && doc.state === "pay";

  let panel: ReactNode;
  if (showConfirming) {
    panel = (
      <div data-testid="pay-confirming" role="status" className="min-w-0">
        <p className="text-base font-semibold break-words text-ink">{t(ui, "regPay.confirming.title")}</p>
        <PayPageConfirming slowText={t(ui, "regPay.confirming.slow")} />
      </div>
    );
  } else if (doc.state === "pay") {
    panel = (
      <form method="post" action={payAction} data-testid="pay-form" className="ph-no-capture min-w-0">
        {retryNotice ? (
          <p data-testid="pay-retry" role="status" className="mb-3 text-sm font-medium break-words text-ink">
            {t(ui, "regPay.notice.retry")}
          </p>
        ) : null}
        <button type="submit" className="btn btn-primary w-full sm:w-auto">
          {t(ui, "regPay.pay", { amount: total })}
        </button>
        <p className="mt-2 text-xs text-ink-muted">{t(ui, "regPay.payHint")}</p>
      </form>
    );
  } else if (doc.state === "offline") {
    panel = (
      <div data-testid="pay-offline" className="min-w-0">
        <h2 className="font-display text-lg font-semibold text-ink">{t(ui, "regPay.offline.title")}</h2>
        {doc.paymentInstructions ? (
          <p className="mt-1 text-sm whitespace-pre-line break-words text-ink">{doc.paymentInstructions}</p>
        ) : null}
        {doc.refCode ? (
          <p className="mt-2 text-sm text-ink-muted">
            {t(ui, "regPay.reference")}: <span className="font-semibold break-all text-ink">{doc.refCode}</span>
          </p>
        ) : null}
      </div>
    );
  } else {
    const line =
      doc.state === "paid"
        ? doc.paidAt
          ? t(ui, "regPay.state.paidOn", { date: day(doc.locale, doc.paidAt.toISOString().slice(0, 10)) })
          : t(ui, "regPay.state.paid")
        : doc.state === "refunded"
          ? t(ui, "regPay.state.refunded", { amount: money(doc.refundedCents) })
          : doc.state === "deadline_passed"
            ? t(ui, "regPay.state.deadlinePassed")
            : t(ui, "regPay.state.waitlisted");
    panel = (
      <p data-testid="pay-state" data-state={doc.state} className="min-w-0 text-base font-semibold break-words text-ink">
        {line}
      </p>
    );
  }

  return (
    <main
      data-testid="pay-page"
      lang={doc.locale}
      style={DISPLAY_FACE}
      className="min-h-screen bg-canvas px-3 py-6 text-ink sm:px-6 sm:py-10"
    >
      <article className="mx-auto min-w-0 max-w-xl overflow-hidden rounded-2xl border border-accent-line bg-surface shadow-[0_10px_30px_-18px_rgb(35_23_56/0.45)]">
        <header className="min-w-0 border-b border-accent-line px-5 py-5 sm:px-8 sm:py-6">
          <p data-testid="pay-org" className="text-sm break-words text-ink-muted">{doc.orgName}</p>
          <h1 className="mt-1 font-display text-3xl leading-tight font-bold break-words text-ink sm:text-4xl">
            {t(ui, "regPay.heading")}
          </h1>
        </header>

        <dl data-testid="pay-details" className="min-w-0 px-5 py-2 sm:px-8">
          <Row label={t(ui, "regPay.competition")}>{doc.competitionName}</Row>
          <Row label={t(ui, "regPay.division")}>{doc.divisionName}</Row>
          {dates ? <Row label={t(ui, "regPay.dates")}>{dates}</Row> : null}
          <Row label={t(ui, "regPay.entrant")}>{doc.entrantName}</Row>
          {doc.members.length > 0 ? (
            <Row label={t(ui, "regPay.members")}>
              <ul className="grid gap-0.5">
                {doc.members.map((m, i) => (
                  <li key={`${i}-${m}`} className="min-w-0 break-words">{m}</li>
                ))}
              </ul>
            </Row>
          ) : null}
          {doc.lines.length > 1
            ? doc.lines.map((l, i) => (
                <Row key={`${i}-${l.label}`} label={l.label}>
                  <span className="tabular-nums">{money(l.amountCents)}</span>
                </Row>
              ))
            : null}
          <Row label={t(ui, "regPay.total")} testId="pay-total">
            <span className="text-base font-semibold tabular-nums">{total}</span>
          </Row>
          {(doc.state === "pay" || doc.state === "offline") && doc.deadline ? (
            <Row label={t(ui, "regPay.deadline")}>{dateTime(doc.locale, doc.deadline)}</Row>
          ) : null}
          {doc.refCode ? <Row label={t(ui, "regPay.reference")}>{doc.refCode}</Row> : null}
        </dl>

        <section className="min-w-0 border-t border-accent-line bg-accent-soft/40 px-5 py-5 sm:px-8 sm:py-6">{panel}</section>
      </article>
    </main>
  );
}
