// The tear-off ticket (v3/05 §3 — "the page is a ticket, not a form").
// Sports registration's native artifact is the entry ticket: event masthead
// up top, a perforated tear line, and the stub carrying the huge mono
// reference + QR. Server component — the QR arrives as a data URL.
//
// RS006: widened from one holder+stamp to an `entries` list — /r/[ref] now
// shows the WHOLE cart (owner ruling), so the division line moved off the
// shared masthead (entries can span different divisions in one cart) down
// into each entry's own row alongside its stamp. The masthead, perforation
// and ref+QR stub stay cart-level: one ref, one QR, one competition.
import { msgFor } from "@/lib/messages-i18n";
import type { Locale } from "@/lib/i18n-constants";
import type { MessageKey } from "@/lib/messages";

const STATUS_STAMP: Record<string, { labelKey: MessageKey; tone: string }> = {
  pending: { labelKey: "ticket.stamp.pending", tone: "text-amber-700 border-amber-400" },
  paid: { labelKey: "ticket.stamp.paid", tone: "text-emerald-700 border-emerald-400" },
  confirmed: { labelKey: "ticket.stamp.confirmed", tone: "text-emerald-700 border-emerald-400" },
  waitlisted: { labelKey: "ticket.stamp.waitlisted", tone: "text-sky-700 border-sky-400" },
  withdrawn: { labelKey: "ticket.stamp.withdrawn", tone: "text-zinc-500 border-zinc-300" },
  expired: { labelKey: "ticket.stamp.expired", tone: "text-zinc-500 border-zinc-300" },
  rejected: { labelKey: "ticket.stamp.rejected", tone: "text-red-700 border-red-400" },
};

export interface TicketEntry {
  id: string;
  status: string;
  displayName: string;
  divisionName: string;
}

/** Walk-fix F1: the entry a typed reference names (`/r/<ref>-2`). Its row comes first and open under its own heading; the cart's
 *  other entries fold under `othersLabel`. Both strings arrive localized from the page. */
export interface TicketFocus {
  entryId: string;
  heading: string;
  othersLabel: string;
}

export function TearOffTicket({
  refCode,
  entries,
  competitionName,
  orgName,
  startsOn,
  endsOn,
  qrDataUrl,
  actions,
  renderEntryAction,
  focus,
  locale,
}: {
  refCode: string | null;
  /** One row per cart entry — masked display names come from the caller. */
  entries: TicketEntry[];
  locale: Locale;
  competitionName: string;
  orgName: string;
  startsOn: string | null;
  endsOn: string | null;
  /** QR encoding the /r/[ref] status URL; null when the row predates refs. */
  qrDataUrl: string | null;
  /** Buttons row rendered under the stub (calendar / save / share). */
  actions?: React.ReactNode;
  /** Per-ROW control, rendered beside that entry's own stamp — e.g. a
   *  per-entry Withdraw button (RS006 follow-up: withdraw acts on ONE named
   *  entry, so its control lives on that entry's own row, never as a single
   *  cart-wide button in `actions`). Return null/undefined for a row with
   *  nothing to show. */
  renderEntryAction?: (entry: TicketEntry) => React.ReactNode;
  /** Opens the ticket on one entry (walk-fix F1). A focus naming no entry here is ignored: the cart renders unfocused. */
  focus?: TicketFocus | null;
}) {
  const dates = startsOn
    ? `${startsOn}${endsOn && endsOn !== startsOn ? ` – ${endsOn}` : ""}`
    : null;
  const focused = focus ? entries.find((e) => e.id === focus.entryId) : undefined;
  const others = focused ? entries.filter((e) => e !== focused) : entries;

  const stampOf = (entry: TicketEntry) => {
    const stamp = STATUS_STAMP[entry.status] ?? STATUS_STAMP.pending!;
    return (
      <div className="flex shrink-0 flex-wrap items-center gap-2">
        <span
          className={`shrink-0 -rotate-6 rounded border-2 px-2.5 py-1 font-display text-lg font-bold tracking-widest ${stamp.tone}`}
          aria-label={`Status: ${entry.status}`}
        >
          {msgFor(locale, stamp.labelKey)}
        </span>
        {renderEntryAction?.(entry)}
      </div>
    );
  };
  /** One row per cart entry: division + holder, and its own stamp. */
  const rowOf = (entry: TicketEntry) => (
    <div
      key={entry.id}
      className="flex flex-col gap-2 px-6 py-4 xs:flex-row xs:items-center xs:justify-between xs:gap-4"
    >
      <div className="min-w-0">
        <p className="text-[11px] tracking-widest text-ink-muted uppercase">
          {entry.divisionName}
        </p>
        <p className="text-lg font-semibold break-words text-ink xs:truncate">
          {entry.displayName}
        </p>
      </div>
      {stampOf(entry)}
    </div>
  );

  return (
    <div className="relative">
      <article
        className="overflow-hidden rounded-2xl border border-zinc-300 bg-surface shadow-sm"
        aria-label="Registration ticket"
      >
        {/* Masthead */}
        <header className="border-b border-zinc-200 px-6 py-5">
          <p className="text-xs tracking-widest text-ink-muted uppercase">{orgName}</p>
          <h2 className="mt-0.5 font-display text-3xl leading-none font-bold tracking-tight text-ink uppercase">
            {competitionName}
          </h2>
          {dates && <p className="mt-1 text-sm text-ink-muted">{dates}</p>}
        </header>

        {focused && focus ? (
          <>
            {/* The entry the typed reference names: first, open, and the page's heading. The ink rule down its edge is the
                ticket's "this one" mark - the stub below still carries the whole cart's reference and QR. */}
            <section
              data-testid="ref-focus-entry"
              aria-labelledby="ref-focus-heading"
              className="flex flex-col gap-3 border-l-4 border-ink px-6 py-5 xs:flex-row xs:items-center xs:justify-between xs:gap-4"
            >
              <div className="min-w-0">
                <p className="text-[11px] tracking-widest text-ink-muted uppercase">{focused.divisionName}</p>
                <h1 id="ref-focus-heading" className="mt-0.5 text-2xl leading-tight font-bold break-words text-ink">
                  {focus.heading}
                </h1>
              </div>
              {stampOf(focused)}
            </section>
            {others.length > 0 && (
              <details data-testid="ref-other-entries" className="group border-t border-zinc-200">
                <summary className="flex cursor-pointer list-none items-center justify-between gap-3 px-6 py-3 text-sm font-medium text-ink-muted hover:text-ink [&::-webkit-details-marker]:hidden">
                  <span className="min-w-0">{focus.othersLabel}</span>
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" className="shrink-0 transition-transform group-open:rotate-180 motion-reduce:transition-none">
                    <path d="m6 9 6 6 6-6" />
                  </svg>
                </summary>
                <div className="divide-y divide-zinc-100 border-t border-zinc-100">{others.map(rowOf)}</div>
              </details>
            )}
          </>
        ) : (
          <div className="divide-y divide-zinc-100">{entries.map(rowOf)}</div>
        )}

        {/* Perforation: the tear line between ticket and stub */}
        <div className="relative" aria-hidden>
          <div className="border-t-2 border-dashed border-zinc-300" />
          <span className="absolute top-1/2 -left-3 h-6 w-6 -translate-y-1/2 rounded-full border border-zinc-300 bg-canvas" />
          <span className="absolute top-1/2 -right-3 h-6 w-6 -translate-y-1/2 rounded-full border border-zinc-300 bg-canvas" />
        </div>

        {/* Stub: huge mono ref + QR */}
        <div className="flex flex-wrap items-center gap-5 px-6 py-5">
          <div className="min-w-0 flex-1">
            <p className="text-[11px] tracking-widest text-ink-muted uppercase">
              {msgFor(locale, "register.ticket.refLabel")}
            </p>
            {refCode ? (
              <p
                data-testid="ref-code"
                className="mt-1 font-mono text-3xl font-bold tracking-[0.08em] break-all text-ink sm:text-4xl"
              >
                {refCode}
              </p>
            ) : (
              <p className="mt-1 text-sm text-ink-muted">
                {msgFor(locale, "register.ticket.legacyRef")}
              </p>
            )}
            <p className="mt-2 max-w-md text-xs text-ink-muted">{msgFor(locale, "register.ticket.keep")}</p>
          </div>
          {qrDataUrl && (
            /* data: URI QR code — generated in-memory, not storage-served; next/image
               optimizer doesn't apply, stays <img> */
            /* eslint-disable-next-line @next/next/no-img-element -- data URL QR */
            <img
              src={qrDataUrl}
              alt={`QR code for your registration status page${refCode ? ` (${refCode})` : ""}`}
              width={112}
              height={112}
              className="rounded-lg border border-zinc-200 bg-white p-1.5"
            />
          )}
        </div>
      </article>

      {actions && <div className="mt-4 flex flex-wrap items-center gap-3">{actions}</div>}
    </div>
  );
}
