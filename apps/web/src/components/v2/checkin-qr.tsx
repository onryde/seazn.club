"use client";

// Fixture check-in QR (PROMPT-53): one tap mints the signed day-of link and
// shows it as QR + copyable URL (invite-scorer modal pattern). Players scan
// it at the venue to mark themselves present in the lineup picker.
import { useState } from "react";
import { apiV1 } from "@/lib/client-v1";
import { useMsg } from "@/components/i18n/dict-provider";
import { SeaznQrImage } from "@/components/v2/seazn-qr-image";
import type { SeaznQr } from "@/lib/seazn-qr";

/** The check-in QR's cap, CSS px. A real check-in link is ≈ 229 bytes (an HS256 JWT over the fixture id, iat and exp)
 *  — v16 at EC H, 89 modules with the quiet zone — so 288 holds three whole px per module (267) and a v17 link (93:
 *  279) still fits three. The painted size is the frame snapped to whole device px per module (B6 fix round 1, rulings
 *  I-1 and I-2); at 320 the dialog's phone padding (`max-md:p-2` round a `max-md:p-3` card) leaves the frame 280. */
const CHECKIN_QR_MAX_PX = 288;

export function CheckinQr({ fixtureId }: { fixtureId: string }) {
  const msg = useMsg();
  const [link, setLink] = useState<string | null>(null);
  const [qr, setQr] = useState<SeaznQr | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  async function mint() {
    setBusy(true);
    setError(null);
    try {
      const out = await apiV1<{ url: string }>(`/api/v1/fixtures/${fixtureId}/checkin-link`, {
        method: "POST",
      });
      setLink(out.url);
      // The Seazn QR (D7), loaded on the tap like the encoder before it.
      const { renderSeaznQr } = await import("@/lib/seazn-qr");
      setQr(await renderSeaznQr(out.url));
    } catch (err) {
      setError(err instanceof Error ? err.message : msg("checkinQr.failed"));
    } finally {
      setBusy(false);
    }
  }

  const close = () => {
    setLink(null);
    setQr(null);
    setCopied(false);
  };

  if (link) {
    return (
      <div
        className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/40 p-4 max-md:p-2"
        role="dialog"
        aria-modal="true"
        aria-label={msg("checkinQr.dialogAria")}
        onClick={close}
      >
        <div
          className="w-full max-w-sm space-y-3 rounded-xl bg-white p-5 shadow-xl max-md:p-3"
          onClick={(e) => e.stopPropagation()}
        >
          <div className="flex items-start justify-between gap-2">
            <h2 className="text-sm font-semibold text-slate-800">{msg("checkinQr.title")}</h2>
            <button
              type="button"
              aria-label={msg("checkinQr.close")}
              onClick={close}
              className="-m-1 p-1 text-slate-400 hover:text-slate-700"
            >
              ✕
            </button>
          </div>
          {qr && (
            // `sensitive` (D10a): the link is a signed bearer token — anyone holding it can check in — so neither the
            // QR nor its enlarged view may land in a session replay.
            <SeaznQrImage testId="checkin-qr" sensitive qr={qr} alt={msg("checkinQr.alt")} maxSize={CHECKIN_QR_MAX_PX} />
          )}
          <div className="flex items-center gap-2">
            <code
              className="ph-no-capture min-w-0 flex-1 truncate rounded bg-slate-100 px-2 py-1.5 text-xs text-slate-700"
              data-testid="checkin-link"
            >
              {link}
            </code>
            <button
              type="button"
              className="btn btn-ghost px-2 py-1 text-xs"
              onClick={() => {
                void navigator.clipboard.writeText(link);
                setCopied(true);
              }}
            >
              {copied ? msg("checkinQr.copied") : msg("checkinQr.copy")}
            </button>
          </div>
          <p className="text-[11px] text-slate-400">{msg("checkinQr.hint")}</p>
          <button type="button" onClick={close} className="btn btn-primary w-full text-xs">
            {msg("checkinQr.done")}
          </button>
        </div>
      </div>
    );
  }

  return (
    <span className="inline-flex items-center gap-2">
      <button
        type="button"
        data-testid="checkin-open"
        disabled={busy}
        onClick={mint}
        className="btn btn-ghost px-3 py-1.5 text-xs"
      >
        {busy ? msg("checkinQr.creating") : msg("checkinQr.button")}
      </button>
      {error && <span className="text-xs text-red-600">{error}</span>}
    </span>
  );
}
