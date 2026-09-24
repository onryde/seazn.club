"use client";
// Scorer sheets §4.4 — the organiser's print control (owner ruling Q5, option
// A: an inline day select plus a Print button right of the schedule title,
// stacking under it on phones). fetch, not a <form>: the response is a file,
// and an error must stay on this page as localised copy rather than navigating
// to a JSON body (the documents menu's rule, board/documents-menu.tsx).
// Hidden (by the page) for viewers and billing-frozen competitions; gated here
// for plans without device links, since printing mints them.
import { useState } from "react";
import { useLocaleOrDefault, useMsg } from "@/components/i18n/dict-provider";
import { UpgradeGate } from "@/components/upgrade-gate";
import { dayLabel } from "@/lib/day-label";
import { downloadBlob } from "@/lib/download-blob";
import type { MessageKey } from "@/lib/messages";

/** A refusal's line, by what the organiser can do about it. Signed out and
 *  throttled reuse the scoring-link lines (device-link-copy.ts) — the
 *  organiser is in the same position whichever button they pressed. Anything
 *  unlisted is worth another try. */
const REFUSAL_BY_STATUS: Partial<Record<number, MessageKey>> = {
  401: "dlink.error.signedOut",
  402: "sheets.error.notAllowed",
  403: "sheets.error.notAllowed",
  429: "dlink.error.rateLimited",
};

function refusalKey(status: number, code: string | undefined): MessageKey {
  if (code === "NO_FIXTURES_ON_DAY") return "sheets.error.noFixtures";
  return REFUSAL_BY_STATUS[status] ?? "sheets.error.generic";
}

export function PrintScorerSheets({
  action,
  days,
  defaultDay,
  allowed,
  viewerPlan,
  download = downloadBlob,
}: {
  /** `POST /api/v1/competitions/{id}/exports/scorer-sheets` (Task 8). */
  action: string;
  /** The org-clock days with something to print, ascending (`listSheetDays`). */
  days: readonly string[];
  /** Today on the org clock if it has fixtures, else the next day that does
   *  (`defaultSheetDay`). Computed by the page, never on this device. */
  defaultDay: string | null;
  /** `scoring.device_links` for this competition — printing mints links. */
  allowed: boolean;
  viewerPlan: Parameters<typeof UpgradeGate>[0]["viewerPlan"];
  download?: (blob: Blob, filename: string) => void;
}) {
  const msg = useMsg();
  const locale = useLocaleOrDefault();
  const [picked, setPicked] = useState(defaultDay ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  if (days.length === 0 || defaultDay === null) return null;
  // The empty case first: with nothing to print there is nothing to sell.
  if (!allowed) {
    return (
      // Capped between md and lg: at its natural width the French pill took
      // three quarters of a 768 header and left the title six lines tall.
      <div className="md:max-w-sm lg:max-w-none">
        <UpgradeGate
          feature="scoring.device_links"
          // The feature's own sentence is about hand-over scoring links; this
          // gate is selling printing.
          reason={msg("sheets.gate.reason")}
          viewerPlan={viewerPlan}
          compact
        />
      </div>
    );
  }

  // The page re-renders the list when the board changes. A picked day that is
  // no longer on it would leave the select SHOWING one day (the browser falls
  // back to an option) while the POST sent another — so the pick only stands
  // while it is still offered.
  const day = days.includes(picked) ? picked : defaultDay;

  async function submit() {
    // `disabled` stops a second tap in the browser; this stops a second call.
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(action, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ date: day }),
      });
      if (!res.ok) {
        // The server's message is English prose; the organiser reads a
        // localised line chosen by the status and wire code.
        const code = ((await res.json().catch(() => null)) as { error?: { code?: string } } | null)?.error?.code;
        setError(msg(refusalKey(res.status, code)));
        return;
      }
      const name =
        /filename="([^"]+)"/.exec(res.headers.get("content-disposition") ?? "")?.[1] ?? "scorer-sheets.pdf";
      download(await res.blob(), name);
    } catch {
      setError(msg("sheets.error.generic"));
    } finally {
      setBusy(false);
    }
  }

  // Two siblings, laid out by the page header's grid (schedule/page.tsx): the
  // control row beside the title, and a refusal in the row BELOW it — so the
  // sentence can neither widen the control nor move the title when it lands.
  return (
    <>
      <div data-testid="print-sheets" className="flex min-w-0 max-w-full flex-wrap items-end gap-2">
        <label className="flex min-w-0 flex-col text-xs font-medium text-slate-600">
          {msg("sheets.day")}
          <select
            data-testid="print-sheets-day"
            value={day}
            onChange={(e) => setPicked(e.target.value)}
            className="select mt-1 h-11 w-auto min-w-0 py-0 text-sm"
          >
            {days.map((d) => (
              <option key={d} value={d}>
                {/* Named exactly as the board's day tabs beside it name a day
                    (lib/day-label.ts), in the page's locale — never the
                    runtime's, which differs between server and browser. */}
                {dayLabel(d, locale)}
              </option>
            ))}
          </select>
        </label>
        <button
          type="button"
          data-testid="print-sheets-submit"
          onClick={() => void submit()}
          disabled={busy}
          className="btn btn-ghost h-11"
        >
          {busy ? msg("sheets.preparing") : msg("sheets.print")}
        </button>
      </div>
      {/* `w-0 min-w-full`: as wide as its cell and no wider, so the sentence
          adds nothing to the column's intrinsic width. */}
      {error && (
        <p
          data-testid="print-sheets-error"
          role="alert"
          className="w-0 min-w-full text-sm text-red-700 max-md:-mt-2 md:col-start-2"
        >
          {error}
        </p>
      )}
    </>
  );
}
