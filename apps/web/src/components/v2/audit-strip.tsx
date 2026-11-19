"use client";

// PROMPT-63 §4 — scoring-ledger integrity strip on the fixture console:
// chain-verified badge (mirrors /admin/audit's staff-log treatment) + the
// signed audit download (`scoring.audit_export`: paid plans and the Event Pass). Hidden until the
// fixture has events (nothing to audit).
import { useMsg } from "@/components/i18n/dict-provider";

export function AuditStrip({
  fixtureId,
  verified,
  tamperedSeq,
  entitled,
}: {
  fixtureId: string;
  verified: boolean;
  tamperedSeq: number | null;
  entitled: boolean;
}) {
  const msg = useMsg();
  return (
    <div className="mt-3 flex flex-wrap items-center gap-2 text-xs" data-testid="audit-strip">
      {verified ? (
        <span className="badge bg-emerald-100 text-emerald-700">{msg("audit.verified")}</span>
      ) : (
        <span className="badge bg-red-100 text-red-700">
          {msg("audit.tampered", { seq: tamperedSeq ?? 0 })}
        </span>
      )}
      {entitled ? (
        <a
          href={`/api/v1/fixtures/${fixtureId}/audit`}
          target="_blank"
          rel="noreferrer"
          // R7/C1 moved this strip into the activity panel's footer, beside
          // the ledger it is a verdict about; 26px was under the 44px touch
          // floor there as much as it was on the page.
          className="btn btn-ghost min-h-11 text-xs"
        >
          {msg("audit.download")}
        </a>
      ) : (
        <>
          <span className="text-slate-400">{msg("audit.pro")}</span>
          {/* Said in the open, not as a `title`: a tooltip is not reachable by touch or keyboard, and the lock
              is the one place a scorer learns what unlocks the download. Own line, so it wraps at 320. */}
          <p className="min-w-0 basis-full text-slate-600" data-testid="audit-pro-hint">
            {msg("audit.proHint")}
          </p>
        </>
      )}
    </div>
  );
}
