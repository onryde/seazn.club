// components/sponsors/invoice-view.tsx - sponsor deals, Task 22 (spec §7): the invoice a club's sponsor opens from the link the
// club sends, `/r/sponsor/invoice/<token>`. A SERVER component: it is handed the document (server/sponsors/invoice-doc.ts) in
// the org's language, that language's dictionary and the two links the page builds from the token, and draws; it reads nothing.
// Its PDF twin is server/sponsors/invoice-pdf.ts: the same document, the same order.
//
// A sheet of paper, not a dashboard: the club that issues it top left, the word "Invoice" and its number top right in the
// display face, who it is billed to, the one line and its total, then how to pay and what the money buys. The one loud thing is
// the state stamp beside the bill-to block, tilted like a rubber stamp in the state's colour, so a sponsor sees at a glance
// whether anything is due. Everything else is the house public theme at rest.
//
// The stamp's ink is the house's, never a palette of its own (review m6, frontend-design pass in task-22-report.md fix round
// 1): due wears the house red (`--mk-live`, the same #ef4444 the PDF stamps with as PALETTE.ball; 3.8:1 on white, past AA for
// text this large and bold), settled wears night (`--color-night`, the PDF's PALETTE.night), and every closed state wears the
// theme's muted ink. The status-chip vocabulary was the other candidate and was not taken: it has no due/settled pair, and the
// deal chip's own mapping (awaiting payment = lime-900, paid = purple) would print a GREEN "Unpaid" on a money document.
//
// One DOM for every width: the header stacks on a phone and splits from `sm`; so does the bill-to block and its stamp (review
// I5: beside each other at 320, es "Pendiente de pago" left the sponsor's name ~37px), the stamp under the name on a phone and
// beside it from `sm`; the amount column never wraps and the
// description takes what is left, so a long package or competition name wraps instead of pushing the page sideways (`min-w-0`
// down every box, `break-words` on everything a person typed, `break-all` on the email). Print: the card chrome, the pay form
// and the buttons go; the sheet is the invoice.
//
// The token is a bearer credential. It reaches this file only inside `pdfHref` and `payAction`, and both elements that carry
// them are `ph-no-capture` (PostHog replay never records them; lib/__tests__/scrub-secret-painters.test.ts). The pay form is
// its own client island (invoice-pay-form.tsx: a double click sends one post, Task 23).
import type { CSSProperties } from "react";
import type { Dict } from "@/lib/i18n-constants";
import { t } from "@/lib/i18n-runtime";
import { INVOICE_STATE_KEY, invoiceMoney, invoiceNoteKey, type InvoiceState } from "@/lib/sponsor-invoice";
import { fmtIsoDay } from "@/lib/sponsor-report";
import { PrintButton } from "@/components/print-button";
import { InvoicePayForm } from "@/components/sponsors/invoice-pay-form";
import { TIER_MSG } from "@/components/sponsors/tier-labels";
import type { SponsorInvoiceDoc } from "@/server/sponsors/invoice-doc";

/** The root layout mounts Barlow Condensed as `--font-barlow`; the public theme's `font-display` reads `--ps-font-display`. */
const DISPLAY_FACE = { "--ps-font-display": "var(--font-barlow)" } as CSSProperties;

/** The stamp's ink, in house tokens (see the header): due red, settled night, closed muted. Print keeps the outline in the same
 *  colour. Exported for the page test, which holds it to tokens. */
export const STAMP_CLASS: Record<InvoiceState, string> = {
  paid: "border-night text-night",
  unpaid: "border-[var(--mk-live)] text-[var(--mk-live)]",
  refunded: "border-ink-muted text-ink-muted",
  void: "border-ink-muted text-ink-muted",
  written_off: "border-ink-muted text-ink-muted",
  ended: "border-ink-muted text-ink-muted",
};

/** The bill-to block and its stamp: stacked on a phone, side by side from `sm` (review I5). Exported for the page test. */
export const BILLED_ROW_CLASS = "flex min-w-0 flex-col items-start gap-3 px-5 pt-6 sm:flex-row sm:justify-between sm:gap-4 sm:px-10 sm:pt-8";

export function SponsorInvoiceView({
  doc,
  ui,
  pdfHref,
  payAction,
  paymentRecording = false,
}: {
  doc: SponsorInvoiceDoc;
  ui: Dict;
  /** `/r/sponsor/invoice/<token>/pdf`: carries the token. */
  pdfHref: string;
  /** `/r/sponsor/invoice/<token>/pay`: carries the token. */
  payAction: string;
  /** The pay route sent the sponsor back because Stripe already has their card payment (`?notice=recording`). */
  paymentRecording?: boolean;
}) {
  const amount = invoiceMoney(doc.locale, doc.line.amountCents, doc.line.currency);
  const note = invoiceNoteKey(doc.state, doc.dealEnded);
  // The webhook has not recorded a card payment Stripe already took: say so, and do not offer to pay again. Only while the
  // invoice still reads unpaid online - once it is recorded (paid), the flag left in the URL says nothing.
  const recording = paymentRecording && doc.state === "unpaid" && doc.method === "online";
  const showPay = doc.payable && !recording;
  const included: [string, string][] = [
    [t(ui, "sponsors.invoice.included.tier"), t(ui, TIER_MSG[doc.included.tier])],
    [t(ui, "sponsors.invoice.included.scope"), doc.included.scope],
    [t(ui, "sponsors.invoice.included.where"), t(ui, "sponsors.invoice.included.whereValue")],
    [t(ui, "sponsors.invoice.included.onStream"), t(ui, doc.included.onStream ? "sponsors.invoice.included.yes" : "sponsors.invoice.included.no")],
  ];
  return (
    <main
      data-testid="sponsor-invoice"
      lang={doc.locale}
      style={DISPLAY_FACE}
      className="min-h-screen bg-canvas px-3 py-6 text-ink sm:px-6 sm:py-10 print:min-h-0 print:bg-white print:p-0"
    >
      <article className="mx-auto min-w-0 max-w-3xl overflow-hidden rounded-2xl border border-accent-line bg-surface shadow-[0_10px_30px_-18px_rgb(35_23_56/0.45)] print:max-w-none print:rounded-none print:border-0 print:shadow-none">
        <header className="flex min-w-0 flex-col-reverse gap-6 border-b border-accent-line px-5 py-6 sm:flex-row sm:items-start sm:justify-between sm:px-10 sm:py-9">
          <div className="min-w-0">
            {doc.org.logoPath !== null ? (
              // eslint-disable-next-line @next/next/no-img-element -- the club's logo is a storage URL or one the club typed (any host): next/image only optimises the hosts next.config names
              <img src={doc.org.logoPath} alt="" referrerPolicy="no-referrer" className="mb-4 h-11 w-auto max-w-[9rem] object-contain object-left" />
            ) : null}
            <p className="text-xs text-ink-muted">{t(ui, "sponsors.invoice.from")}</p>
            <p data-testid="invoice-org" className="mt-0.5 text-base font-semibold break-words text-ink">{doc.org.name}</p>
            {doc.org.address !== null ? (
              <p className="mt-1 text-sm whitespace-pre-line break-words text-ink-muted">{doc.org.address}</p>
            ) : null}
          </div>
          <div className="min-w-0 sm:text-right">
            <h1 className="font-display text-5xl leading-none font-bold text-ink sm:text-6xl">{t(ui, "sponsors.invoice.title")}</h1>
            <dl className="mt-3 grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-0.5 text-sm sm:inline-grid sm:text-left">
              <dt className="text-ink-muted">{t(ui, "sponsors.invoice.number")}</dt>
              <dd data-testid="invoice-number" className="font-display text-lg leading-tight font-semibold tabular-nums text-ink">{doc.number}</dd>
              <dt className="text-ink-muted">{t(ui, "sponsors.invoice.date")}</dt>
              <dd className="text-ink">{fmtIsoDay(doc.locale, doc.issuedOn)}</dd>
            </dl>
          </div>
        </header>

        <section className={BILLED_ROW_CLASS}>
          <div className="min-w-0 max-w-full">
            <h2 className="text-xs text-ink-muted">{t(ui, "sponsors.invoice.billedTo")}</h2>
            <p data-testid="invoice-billed-to" className="mt-0.5 text-base font-semibold break-words text-ink">{doc.billedTo.name}</p>
            {doc.billedTo.email !== null ? <p className="text-sm break-all text-ink-muted">{doc.billedTo.email}</p> : null}
          </div>
          <p
            data-testid="invoice-state"
            data-state={doc.state}
            className={`ml-1 max-w-full shrink-0 -rotate-6 rounded-md border-[3px] px-3 py-1 font-display text-2xl leading-none font-bold tracking-wide break-words sm:mt-1 sm:mr-2 sm:ml-0 sm:text-3xl ${STAMP_CLASS[doc.state]}`}
          >
            {t(ui, INVOICE_STATE_KEY[doc.state])}
          </p>
        </section>

        <section className="px-5 pt-7 pb-6 sm:px-10 sm:pt-9 sm:pb-8">
          <table className="w-full table-fixed border-collapse text-sm">
            <thead>
              <tr className="border-b border-accent-line font-display text-base text-ink-muted">
                <th scope="col" className="pb-2 text-left font-semibold">{t(ui, "sponsors.invoice.description")}</th>
                <th scope="col" className="w-28 pb-2 text-right font-semibold sm:w-36">{t(ui, "sponsors.invoice.amount")}</th>
              </tr>
            </thead>
            <tbody>
              <tr className="border-b border-accent-line align-top">
                <td data-testid="invoice-line" className="py-3 pr-3 font-medium break-words text-ink">{doc.line.description}</td>
                <td className="py-3 text-right whitespace-nowrap tabular-nums text-ink">{amount}</td>
              </tr>
            </tbody>
            <tfoot>
              <tr className="align-baseline">
                <th scope="row" className="pt-4 text-left font-display text-xl font-bold text-ink">{t(ui, "sponsors.invoice.total")}</th>
                <td data-testid="invoice-total" className="pt-4 text-right text-xl font-semibold whitespace-nowrap tabular-nums text-ink sm:text-2xl">{amount}</td>
              </tr>
            </tfoot>
          </table>
          {note !== null ? (
            <p data-testid="invoice-state-note" className="mt-3 max-w-prose text-sm text-ink-muted">{t(ui, note, { club: doc.org.name })}</p>
          ) : null}
        </section>

        {showPay || recording || doc.cardUnavailable || doc.bankDetails !== null ? (
          <section className="grid min-w-0 gap-5 border-t border-accent-line bg-accent-soft/40 px-5 py-6 sm:grid-cols-2 sm:gap-8 sm:px-10 sm:py-7 print:bg-transparent">
            {recording ? (
              <p data-testid="invoice-recording" role="status" className="min-w-0 text-sm font-medium break-words text-ink">
                {t(ui, "sponsors.invoice.payRecording")}
              </p>
            ) : null}
            {showPay ? (
              <InvoicePayForm action={payAction} label={t(ui, "sponsors.invoice.payByCard")} note={t(ui, "sponsors.invoice.payNote", { amount })} />
            ) : null}
            {doc.cardUnavailable ? (
              <p data-testid="invoice-card-unavailable" className="min-w-0 text-sm font-medium break-words text-ink">
                {t(ui, "sponsors.invoice.cardUnavailable", { club: doc.org.name })}
              </p>
            ) : null}
            {doc.bankDetails !== null ? (
              <div data-testid="invoice-bank" className="min-w-0">
                <h2 className="font-display text-lg font-semibold text-ink">{t(ui, "sponsors.invoice.bankDetails")}</h2>
                <p className="mt-1 text-sm whitespace-pre-line break-words text-ink">{doc.bankDetails}</p>
                <p className="mt-2 text-xs text-ink-muted">{t(ui, "sponsors.invoice.bankReference", { number: doc.number })}</p>
              </div>
            ) : null}
          </section>
        ) : null}

        <section aria-labelledby="invoice-included" className="border-t border-accent-line px-5 py-6 sm:px-10 sm:py-7">
          <h2 id="invoice-included" className="font-display text-lg font-semibold text-ink">{t(ui, "sponsors.invoice.included.title")}</h2>
          <dl data-testid="invoice-included" className="mt-2 grid grid-cols-1 gap-x-6 text-sm sm:grid-cols-[minmax(0,12rem)_minmax(0,1fr)]">
            {included.map(([label, value]) => (
              <div key={label} className="grid min-w-0 grid-cols-subgrid border-b border-accent-line/70 py-2 last:border-b-0 sm:col-span-2">
                <dt className="text-ink-muted">{label}</dt>
                <dd className="font-medium break-words text-ink">{value}</dd>
              </div>
            ))}
          </dl>
        </section>

        <footer className="flex min-w-0 flex-wrap items-center gap-3 border-t border-accent-line px-5 py-4 sm:px-10 print:hidden">
          <a href={pdfHref} data-testid="invoice-pdf" className="ph-no-capture btn btn-ghost">
            {t(ui, "sponsors.invoice.downloadPdf")}
          </a>
          <PrintButton label={t(ui, "sponsors.invoice.print")} />
        </footer>
      </article>
    </main>
  );
}
