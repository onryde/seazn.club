"use client";

// "Hand this device over" (doc 13 §7, PROMPT-21; scorer sheets §4.2): the
// organiser shows the fixture's device link as a QR + link, revokes it, or
// revokes & reissues it. Links are sealed server-side and last until the
// fixture is over, so "Show QR" goes through ENSURE (POST /device-links) and
// re-shows the SAME secret every time — a hand-over never kills a sheet that
// was already printed for this match. Only the explicit, confirmed "Revoke &
// reissue" (POST /device-links/reissue) mints a new one.
import { useCallback, useEffect, useState } from "react";
import QRCode from "qrcode";
import { apiV1, ApiV1Error } from "@/lib/client-v1";
import { UpgradeGate } from "@/components/upgrade-gate";
import { useMsg } from "@/components/i18n/dict-provider";
import { liveCopy } from "@/components/v2/device-link-copy";
import type { ViewerPlan } from "@/lib/viewer-plan";

interface ActiveLink {
  id: string;
  label: string | null;
  /** `null` for a sealed link: it lives until the fixture is over. */
  expires_at: string | null;
  created_at: string;
}

export function DeviceLinkPanel({
  fixtureId,
  scorerLabel,
  embedded = false,
  viewerPlan,
}: {
  fixtureId: string;
  /** Sport-aware copy (doc 13 §1): 'Umpire' / 'Referee' / 'Arbiter' / 'Scorer'. */
  scorerLabel: string;
  /**
   * R7/C3 (D-19) — rendered INSIDE the scoring card, opened from its heading
   * row, instead of as the last card on the page. Drops this component's own
   * card chrome and heading: a card inside a card reads as a nesting bug, and
   * the disclosure button the organiser just pressed already said what this
   * is. Everything below the heading is unchanged.
   */
  embedded?: boolean;
  viewerPlan: ViewerPlan;
}) {
  const msg = useMsg();
  const [active, setActive] = useState<ActiveLink | null>(null);
  const [minted, setMinted] = useState<{ secret: string; qr: string; expires_at: string | null } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [paywall, setPaywall] = useState(false);
  const [busy, setBusy] = useState(false);
  const [confirmReissue, setConfirmReissue] = useState(false);
  const fmtDate = (iso: string) => new Date(iso).toLocaleString();

  /** A refusal as the organiser reads it. A server without its key answers
   *  503 DEVICE_LINK_KEK_MISSING with an English sentence naming an env var;
   *  that is ours to fix, so it gets localised copy (controller ruling). */
  const failure = (err: unknown) =>
    err instanceof ApiV1Error && err.code === "DEVICE_LINK_KEK_MISSING"
      ? msg("dlink.kekMissing")
      : err instanceof Error
        ? err.message
        : msg("dlink.failed");

  const refresh = useCallback(async () => {
    try {
      setActive(await apiV1<ActiveLink | null>(`/api/v1/fixtures/${fixtureId}/device-links`));
    } catch {
      // non-editor or transient — panel just shows the create button
    }
  }, [fixtureId]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  async function showLink(link: ActiveLink & { secret: string }) {
    const url = `${window.location.origin}/score/${link.secret}`;
    const qr = await QRCode.toDataURL(url, { width: 280, margin: 1 });
    setMinted({ secret: link.secret, qr, expires_at: link.expires_at });
  }

  /** Create (no link yet) and Show QR (a live link): ENSURE — re-shows the
   *  live sealed link, or mints the first one. Never revokes. */
  async function show() {
    setBusy(true);
    setError(null);
    setPaywall(false);
    try {
      const link = await apiV1<ActiveLink & { secret: string }>(
        `/api/v1/fixtures/${fixtureId}/device-links`,
        { method: "POST", json: {} },
      );
      await showLink(link);
      await refresh();
    } catch (err) {
      if (err instanceof ApiV1Error && err.code === "PAYMENT_REQUIRED") setPaywall(true);
      else setError(failure(err));
    } finally {
      setBusy(false);
    }
  }

  /** Revoke & reissue, only from the on-screen confirm: every QR already
   *  handed out or printed for this match stops working. */
  async function reissue() {
    setBusy(true);
    setError(null);
    try {
      const link = await apiV1<ActiveLink & { secret: string }>(
        `/api/v1/fixtures/${fixtureId}/device-links/reissue`,
        { method: "POST", json: {} },
      );
      await showLink(link);
      setConfirmReissue(false);
      await refresh();
    } catch (err) {
      if (err instanceof ApiV1Error && err.code === "PAYMENT_REQUIRED") setPaywall(true);
      else setError(failure(err));
    } finally {
      setBusy(false);
    }
  }

  async function revoke(linkId: string) {
    setBusy(true);
    setError(null);
    try {
      await apiV1(`/api/v1/fixtures/${fixtureId}/device-links/${linkId}`, { method: "DELETE" });
      setMinted(null);
      setConfirmReissue(false);
      await refresh();
    } catch (err) {
      setError(failure(err));
    } finally {
      setBusy(false);
    }
  }

  const padUrl = minted ? `${window.location.origin}/score/${minted.secret}` : null;
  const live = active ? liveCopy(active.expires_at, fmtDate) : null;

  return (
    <section
      className={embedded ? "rounded-xl border border-purple-100 bg-purple-50/40 p-4" : "card p-5"}
      data-role="device-link-panel"
    >
      {!embedded && <h2 className="text-sm font-semibold text-slate-700">{msg("dlink.title")}</h2>}
      <p className={`text-xs text-slate-600 ${embedded ? "" : "mt-1"}`}>
        {msg("dlink.desc", { scorer: scorerLabel.toLowerCase() })}
      </p>

      {paywall && (
        <div className="mt-3">
          <UpgradeGate feature="scoring.device_links" viewerPlan={viewerPlan} />
        </div>
      )}
      {error && <p className="mt-3 rounded-md bg-red-50 px-3 py-2 text-xs text-red-600">{error}</p>}

      {minted ? (
        <div className="mt-3 space-y-3 text-center">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={minted.qr} alt={msg("dlink.alt")} className="mx-auto h-56 w-56" />
          <p
            data-testid="device-link-url"
            className="break-all rounded bg-slate-50 px-2 py-1 font-mono text-[10px] text-slate-500"
          >
            {padUrl}
          </p>
          <p className="text-xs text-slate-500">{msg("dlink.sameQr")}</p>
          <div className="flex flex-wrap justify-center gap-2">
            <button
              type="button"
              className="btn btn-ghost min-h-11 text-xs"
              onClick={() => padUrl && navigator.clipboard?.writeText(padUrl)}
            >
              {msg("dlink.copy")}
            </button>
            {active && (
              <button
                type="button"
                disabled={busy}
                onClick={() => revoke(active.id)}
                className="btn btn-danger min-h-11 text-xs"
              >
                {msg("dlink.revokeNow")}
              </button>
            )}
          </div>
        </div>
      ) : active && live ? (
        <div className="mt-3 space-y-2">
          <p className="text-xs text-slate-600">{msg(live.key, live.vars)}</p>
          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              data-testid="device-link-show"
              disabled={busy}
              onClick={show}
              className="btn btn-primary min-h-11 text-xs"
            >
              {msg("dlink.showQr")}
            </button>
            <button
              type="button"
              disabled={busy}
              onClick={() => revoke(active.id)}
              className="btn btn-danger min-h-11 text-xs"
            >
              {msg("dlink.revoke")}
            </button>
            <button
              type="button"
              data-testid="device-link-reissue"
              disabled={busy}
              onClick={() => setConfirmReissue(true)}
              className="btn btn-ghost min-h-11 text-xs"
            >
              {msg("dlink.reissue")}
            </button>
          </div>
          {confirmReissue && (
            <div className="space-y-2 rounded-md border border-amber-200 bg-amber-50 p-3">
              <p role="alert" className="text-xs text-amber-800">
                {msg("dlink.reissueWarn")}
              </p>
              <div className="flex flex-wrap gap-2">
                <button
                  type="button"
                  data-testid="device-link-reissue-confirm"
                  disabled={busy}
                  onClick={reissue}
                  className="btn btn-danger min-h-11 text-xs"
                >
                  {msg("dlink.reissueConfirm")}
                </button>
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => setConfirmReissue(false)}
                  className="btn btn-ghost min-h-11 text-xs"
                >
                  {msg("dlink.keep")}
                </button>
              </div>
            </div>
          )}
        </div>
      ) : (
        <button
          type="button"
          data-testid="device-link-mint"
          disabled={busy}
          onClick={show}
          className="btn btn-primary mt-3 min-h-11"
        >
          {busy ? "…" : msg("dlink.create")}
        </button>
      )}
    </section>
  );
}
