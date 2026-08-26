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

export function TearOffTicket({
  refCode,
  entries,
  competitionName,
  orgName,
  startsOn,
  endsOn,
  qrDataUrl,
  actions,
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
  /** Buttons row rendered under the stub (calendar / save / withdraw). */
  actions?: React.ReactNode;
}) {
  const dates = startsOn
    ? `${startsOn}${endsOn && endsOn !== startsOn ? ` – ${endsOn}` : ""}`
    : null;

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

        {/* One row per cart entry: division + holder, and its own stamp. */}
        <div className="divide-y divide-zinc-100">
          {entries.map((entry) => {
            const stamp = STATUS_STAMP[entry.status] ?? STATUS_STAMP.pending!;
            return (
              <div key={entry.id} className="flex items-center justify-between gap-4 px-6 py-4">
                <div className="min-w-0">
                  <p className="text-[11px] tracking-widest text-ink-muted uppercase">
                    {entry.divisionName}
                  </p>
                  <p className="truncate text-lg font-semibold text-ink">{entry.displayName}</p>
                </div>
                <span
                  className={`shrink-0 -rotate-6 rounded border-2 px-2.5 py-1 font-display text-lg font-bold tracking-widest ${stamp.tone}`}
                  aria-label={`Status: ${entry.status}`}
                >
                  {msgFor(locale, stamp.labelKey)}
                </span>
              </div>
            );
          })}
        </div>

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
