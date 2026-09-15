"use client";

import { useState } from "react";
import { apiV1, ApiV1Error } from "@/lib/client-v1";
import { useMsg } from "@/components/i18n/dict-provider";
import type { MessageKey } from "@/lib/messages";
import { useRouter } from "next/navigation";

export type NeedsOrganiserRow = {
  fixtureId: string;
  fixtureNo: number | null;
  homeName: string;
  awayName: string;
  scheduledAt: string | null;
  lastError: string | null;
  href: string;
};

const RESOLVE_KINDS: { kind: "home_forfeit" | "away_forfeit" | "draw" | "no_result"; labelKey: MessageKey }[] = [
  { kind: "home_forfeit", labelKey: "externalPlay.resolve.homeForfeit" },
  { kind: "away_forfeit", labelKey: "externalPlay.resolve.awayForfeit" },
  { kind: "draw", labelKey: "externalPlay.resolve.draw" },
  { kind: "no_result", labelKey: "externalPlay.resolve.noResult" },
];

/** Organiser queue for online-play fixtures stuck in needs_organiser. */
export function ExternalPlayNeedsResultQueue({ rows }: { rows: NeedsOrganiserRow[] }) {
  const msg = useMsg();
  const router = useRouter();
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  if (rows.length === 0) return null;

  const resolve = async (fixtureId: string, kind: (typeof RESOLVE_KINDS)[number]["kind"]) => {
    setBusyId(fixtureId);
    setError(null);
    try {
      await apiV1(`/api/v1/fixtures/${fixtureId}/external-play/resolve`, {
        method: "POST",
        json: { kind },
      });
      router.refresh();
    } catch (err) {
      setError(err instanceof ApiV1Error ? err.message : msg("externalPlay.resolve.failed"));
    } finally {
      setBusyId(null);
    }
  };

  return (
    <section
      data-testid="external-play-needs-result-queue"
      className="card space-y-3 border-amber-200 bg-amber-50/40 p-4"
    >
      <div>
        <h3 className="text-sm font-semibold text-amber-950">{msg("externalPlay.queue.title")}</h3>
        <p className="text-xs text-amber-900/80">{msg("externalPlay.queue.help")}</p>
      </div>
      {error && (
        <p className="text-xs text-red-700" role="alert">
          {error}
        </p>
      )}
      <ul className="space-y-3">
        {rows.map((row) => (
          <li
            key={row.fixtureId}
            data-testid={`external-play-queue-row-${row.fixtureId}`}
            className="rounded-md border border-amber-200 bg-white p-3"
          >
            <div className="flex flex-wrap items-baseline justify-between gap-2">
              <a href={row.href} className="text-sm font-medium text-slate-800 underline">
                {row.fixtureNo != null
                  ? msg("externalPlay.queue.match", { no: row.fixtureNo })
                  : msg("externalPlay.queue.matchUnknown")}
                {": "}
                {row.homeName} vs {row.awayName}
              </a>
              {row.lastError && (
                <span className="text-[11px] text-slate-500">{row.lastError}</span>
              )}
            </div>
            <div className="mt-2 flex flex-wrap gap-2">
              {RESOLVE_KINDS.map((opt) => (
                <button
                  key={opt.kind}
                  type="button"
                  disabled={busyId === row.fixtureId}
                  data-testid={`external-play-resolve-${opt.kind}`}
                  onClick={() => void resolve(row.fixtureId, opt.kind)}
                  className="rounded border border-slate-200 px-2 py-1 text-xs text-slate-700 hover:bg-slate-50 disabled:opacity-50"
                >
                  {msg(opt.labelKey)}
                </button>
              ))}
            </div>
          </li>
        ))}
      </ul>
    </section>
  );
}
