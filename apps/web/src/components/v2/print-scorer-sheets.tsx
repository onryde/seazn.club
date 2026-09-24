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
import { fmtPublicDate, UTC } from "@/lib/format";

interface DownloadEnv {
  createElement: () => HTMLAnchorElement;
  append: (a: HTMLAnchorElement) => void;
  createObjectURL: (b: Blob) => string;
  revokeObjectURL: (u: string) => void;
}

const browserEnv = (): DownloadEnv => ({
  createElement: () => document.createElement("a"),
  append: (a) => document.body.append(a),
  createObjectURL: (b) => URL.createObjectURL(b),
  revokeObjectURL: (u) => URL.revokeObjectURL(u),
});

/** Save a fetched file under its server-given name: an attached anchor with
 *  `download`, clicked once, then the object URL released. */
export function downloadBlob(blob: Blob, filename: string, env: DownloadEnv = browserEnv()): void {
  const url = env.createObjectURL(blob);
  const a = env.createElement();
  a.href = url;
  a.download = filename;
  env.append(a);
  a.click();
  a.remove();
  env.revokeObjectURL(url);
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
  if (!allowed) return <UpgradeGate feature="scoring.device_links" viewerPlan={viewerPlan} compact />;

  // The page re-renders the list when the board changes. A picked day that is
  // no longer on it would leave the select SHOWING one day (the browser falls
  // back to an option) while the POST sent another — so the pick only stands
  // while it is still offered.
  const day = days.includes(picked) ? picked : defaultDay;

  async function submit() {
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
        // localised line chosen by the wire code.
        const code = ((await res.json().catch(() => null)) as { error?: { code?: string } } | null)?.error?.code;
        setError(code === "NO_FIXTURES_ON_DAY" ? msg("sheets.error.noFixtures") : msg("sheets.error.generic"));
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

  return (
    <div data-testid="print-sheets" className="flex min-w-0 flex-wrap items-end gap-2">
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
              {/* A calendar day, at UTC noon so no zone can shift it, in the
                  page's locale — never the runtime's, which would differ
                  between the server render and the browser. */}
              {fmtPublicDate(locale, UTC, `${d}T12:00:00Z`)}
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
      {error && (
        <p data-testid="print-sheets-error" role="alert" className="w-full text-sm text-red-700">
          {error}
        </p>
      )}
    </div>
  );
}
