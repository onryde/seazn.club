"use client";

// "Hand this device over" (doc 13 §7, PROMPT-21; scorer sheets §4.2): the
// organiser shows the fixture's device link as a QR + link, revokes it, or
// revokes & reissues it. Links are sealed server-side and last until the
// fixture is over, so "Show QR" goes through ENSURE (POST /device-links) and
// re-shows the SAME secret every time — a hand-over never kills a sheet that
// was already printed for this match. Only the explicit, confirmed "Revoke &
// reissue" (POST /device-links/reissue) mints a new one. Plain "Revoke" (and
// "Revoke now" under a shown QR) kills a printed sheet just the same, so it
// asks first too, with the same on-screen question (owner ruling, T3 fix
// round 2). One question at a time.
import { useCallback, useEffect, useState } from "react";
import QRCode from "qrcode";
import { apiV1, ApiV1Error } from "@/lib/client-v1";
import { UpgradeGate } from "@/components/upgrade-gate";
import { useMsg } from "@/components/i18n/dict-provider";
import { failureKey, liveCopy } from "@/components/v2/device-link-copy";
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
  /** The open "this kills the QR" question, if any. */
  const [confirm, setConfirm] = useState<"reissue" | "revoke" | null>(null);
  const fmtDate = (iso: string) => new Date(iso).toLocaleString();
  // Every refusal below is shown as `msg(failureKey(err))` — localised by code
  // and status, never the server's English (T3 review finding 3).

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
    setConfirm(null);
    try {
      const link = await apiV1<ActiveLink & { secret: string }>(
        `/api/v1/fixtures/${fixtureId}/device-links`,
        { method: "POST", json: {} },
      );
      await showLink(link);
      await refresh();
    } catch (err) {
      if (err instanceof ApiV1Error && err.code === "PAYMENT_REQUIRED") setPaywall(true);
      else setError(msg(failureKey(err)));
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
      setConfirm(null);
      await refresh();
    } catch (err) {
      if (err instanceof ApiV1Error && err.code === "PAYMENT_REQUIRED") setPaywall(true);
      else setError(msg(failureKey(err)));
    } finally {
      setBusy(false);
    }
  }

  /** Revoke, only from the on-screen confirm: every QR already handed out or
   *  printed for this match stops working, and no new one is made. */
  async function revoke(linkId: string) {
    setBusy(true);
    setError(null);
    try {
      await apiV1(`/api/v1/fixtures/${fixtureId}/device-links/${linkId}`, { method: "DELETE" });
      setMinted(null);
      setConfirm(null);
      await refresh();
    } catch (err) {
      setError(msg(failureKey(err)));
    } finally {
      setBusy(false);
    }
  }

  const padUrl = minted ? `${window.location.origin}/score/${minted.secret}` : null;
  const live = active ? liveCopy(active.expires_at, fmtDate) : null;

  /** The on-screen question both destructive doors open — a native dialog
   *  would be invisible to e2e and easy to dismiss by reflex. */
  const question =
    confirm && active ? (
      <div className="space-y-2 rounded-md border border-amber-200 bg-amber-50 p-3 text-left">
        <p role="alert" className="text-xs text-amber-800">
          {msg(confirm === "revoke" ? "dlink.revokeWarn" : "dlink.reissueWarn")}
        </p>
        <div className="flex flex-wrap gap-2">
          <button
            type="button"
            data-testid={confirm === "revoke" ? "device-link-revoke-confirm" : "device-link-reissue-confirm"}
            disabled={busy}
            onClick={confirm === "revoke" ? () => revoke(active.id) : reissue}
            className="btn btn-danger min-h-11 text-xs"
          >
            {msg(confirm === "revoke" ? "dlink.revokeConfirm" : "dlink.reissueConfirm")}
          </button>
          <button
            type="button"
            data-testid="device-link-keep"
            disabled={busy}
            onClick={() => setConfirm(null)}
            className="btn btn-ghost min-h-11 text-xs"
          >
            {msg("dlink.keep")}
          </button>
        </div>
      </div>
    ) : null;

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
                data-testid="device-link-revoke-now"
                disabled={busy}
                onClick={() => setConfirm("revoke")}
                className="btn btn-danger min-h-11 text-xs"
              >
                {msg("dlink.revokeNow")}
              </button>
            )}
          </div>
          {question}
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
              data-testid="device-link-revoke"
              disabled={busy}
              onClick={() => setConfirm("revoke")}
              className="btn btn-danger min-h-11 text-xs"
            >
              {msg("dlink.revoke")}
            </button>
            <button
              type="button"
              data-testid="device-link-reissue"
              disabled={busy}
              onClick={() => setConfirm("reissue")}
              className="btn btn-ghost min-h-11 text-xs"
            >
              {msg("dlink.reissue")}
            </button>
          </div>
          {question}
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
