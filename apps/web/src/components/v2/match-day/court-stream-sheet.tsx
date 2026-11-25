"use client";
// Linking a court to streaming, and its QR (court stream spec 2026-11-14 §5.1; web plan Task 12). Follows the Match Day code
// sheet: a modal, editors only (the doors refuse anyone else on their own), the QR sensitive (it is a credential).
//
// Three pieces:
//  - `LinkCourtAction`: the focus header's "Stream this court" for a court with no link.
//  - `CourtStreamBand`: a linked court's status block (court-phone-status.tsx) with, for a writer, "Show court QR" and "Stop
//    streaming". Withdraw asks first, in the band.
//  - `CourtStreamSheet`: the modal both open. Opened to link, it asks where to stream (Task 37: the club's Seazn destination first, when
//    it is offered, then the connected YouTube channels: a court streams one video per match, which a pasted key cannot give), links,
//    and shows the answer's QR at once. Opened on a link that
//    exists it only READS the court's QR (GET) — opening it never makes a code.
// The two buttons only ASK for the sheet; the focus owns it (court-focus.tsx). The link refreshes the board, which turns the header
// action into the band: a sheet owned by either would be unmounted with it, in the middle of showing the QR it had just made.
//
// The QR's token is a credential: it is held only long enough to draw, never logged, never in an error or a URL.
import { useEffect, useState } from "react";
import { Modal } from "@/components/modal";
import { PHONE_HANDOVER_QR_MAX_PX, SeaznQrImage } from "@/components/v2/seazn-qr-image";
import { ApiV1Error, apiV1 } from "@/lib/client-v1";
import { captureQrV2Text } from "@/lib/capture-qr";
import { fmtPublicTime } from "@/lib/format";
import type { Dict } from "@/lib/i18n-constants";
import { t } from "@/lib/i18n-runtime";
import { canWriteCourtStream, courtTargets, lastWorkingMinute, linkFailureKey } from "@/lib/match-day/court-stream";
import type { MatchDayCourt, MatchDayCourtStream } from "@/lib/match-day/types";
import { renderSeaznQr, type SeaznQr } from "@/lib/seazn-qr";
import { useStreamingHref } from "@/components/use-org-paths";
import type { CourtStream, StreamTarget } from "@/server/api-v1/schemas";
import type { MatchDayCtx } from "./court-focus";
import { CourtPhoneStatus } from "./court-phone-status";

export type TargetsState = { status: "loading" } | { status: "error" } | { status: "ok"; list: readonly StreamTarget[] };
type QrState = { status: "loading" } | { status: "error" } | { status: "ok"; qr: SeaznQr; expiresAt: string };

/** The destinations a court may stream to, as radios: Seazn first (a card of its own, saying nothing needs connecting), then the
 *  connected YouTube channels. With none: why, and the way to connect a channel (the Streaming page). */
export function TargetPicker({
  dict,
  state,
  value,
  onChange,
}: {
  dict: Dict;
  state: TargetsState;
  value: string | null;
  onChange: (id: string) => void;
}) {
  const streamingHref = useStreamingHref();
  if (state.status === "loading") return <p className="text-sm text-slate-600">{t(dict, "matchDay.code.loading")}</p>;
  if (state.status === "error") return <p role="alert" className="text-sm text-amber-900">{t(dict, "matchDay.refusal.other")}</p>;
  const targets = courtTargets(state.list);
  if (targets.length === 0) {
    return (
      <div data-testid="md-cs-youtube-only" className="grid min-w-0 gap-3">
        <p className="text-sm text-slate-700">{t(dict, "matchDay.courtStream.youtubeOnly")}</p>
        <a
          data-testid="md-cs-connect-youtube"
          href={streamingHref}
          target="_blank"
          rel="noopener noreferrer"
          className="btn btn-ghost min-h-11 justify-self-start"
        >
          {t(dict, "matchDay.courtStream.connectYoutube")}
        </a>
      </div>
    );
  }
  return (
    <fieldset className="grid min-w-0 gap-2">
      <legend className="mb-1 text-sm font-medium text-slate-800">{t(dict, "matchDay.courtStream.destination")}</legend>
      {targets.map((target) => (
        <label
          key={target.id}
          data-testid={target.kind === "seazn" ? "md-cs-target-seazn" : undefined}
          className="flex min-h-11 min-w-0 cursor-pointer items-center gap-3 rounded-xl px-3 py-2 text-sm ring-1 ring-inset ring-purple-100 has-[:checked]:bg-purple-50 has-[:checked]:ring-purple-400"
        >
          <input type="radio" name="md-cs-target" data-testid="md-cs-target" checked={value === target.id} onChange={() => onChange(target.id)} />
          <span className="min-w-0">
            <span className="block font-medium text-slate-900 [overflow-wrap:anywhere]">{target.label}</span>
            {target.kind === "seazn" && (
              <span className="block text-xs text-slate-600 [overflow-wrap:anywhere]">{t(dict, "matchDay.courtStream.seaznHint")}</span>
            )}
            {target.youtube !== null && target.youtube.channelTitle !== target.label && (
              <span className="block text-xs text-slate-600 [overflow-wrap:anywhere]">{target.youtube.channelTitle}</span>
            )}
          </span>
        </label>
      ))}
    </fieldset>
  );
}

/** The QR of a court link, drawn from the answer's payload (the write's, or the list's: the same `CourtStream`). */
async function drawn(link: CourtStream | undefined): Promise<{ qr: SeaznQr; expiresAt: string } | null> {
  if (link === undefined || link.qr === null) return null;
  return { qr: await renderSeaznQr(captureQrV2Text(link.qr)), expiresAt: link.expires_at };
}

export function CourtStreamSheet({
  ctx,
  court,
  linkId,
  onClose,
  onChanged,
}: {
  ctx: MatchDayCtx;
  court: Pick<MatchDayCourt, "court_id" | "court_name">;
  /** The court's link to show the QR of; null to LINK the court first. */
  linkId: string | null;
  onClose: () => void;
  /** A link was made: read the board again. */
  onChanged: () => void;
}) {
  const { dict } = ctx;
  const [targets, setTargets] = useState<TargetsState>({ status: "loading" });
  const [target, setTarget] = useState<string | null>(null);
  const [qr, setQr] = useState<QrState | null>(linkId === null ? null : { status: "loading" });
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);

  // Opened on a link: READ its QR. Never a POST — showing the QR again must not make a code.
  useEffect(() => {
    if (linkId === null) return;
    const ctl = new AbortController();
    apiV1<CourtStream[] | undefined>(`/api/v1/competitions/${ctx.competitionId}/court-streams`, { signal: ctl.signal })
      .then(async (list) => {
        const mine = Array.isArray(list) ? list.find((l) => l.id === linkId) : undefined;
        const ok = await drawn(mine);
        if (!ctl.signal.aborted) setQr(ok === null ? { status: "error" } : { status: "ok", ...ok });
      })
      .catch(() => {
        if (!ctl.signal.aborted) setQr({ status: "error" });
      });
    return () => ctl.abort();
  }, [linkId, ctx.competitionId]);

  // Opened to link: the organisation's channels.
  useEffect(() => {
    if (linkId !== null || ctx.orgId === undefined) return;
    const ctl = new AbortController();
    apiV1<StreamTarget[] | undefined>(`/api/v1/orgs/${ctx.orgId}/stream-targets`, { signal: ctl.signal })
      .then((list) => {
        if (ctl.signal.aborted) return;
        const all = Array.isArray(list) ? list : [];
        setTargets({ status: "ok", list: all });
        const only = courtTargets(all);
        if (only.length === 1) setTarget(only[0]!.id);
      })
      .catch(() => {
        if (!ctl.signal.aborted) setTargets({ status: "error" });
      });
    return () => ctl.abort();
  }, [linkId, ctx.orgId]);

  const link = async () => {
    if (target === null || busy) return;
    setBusy(true);
    setFailure(null);
    try {
      const made = await apiV1<CourtStream>(`/api/v1/competitions/${ctx.competitionId}/court-streams`, {
        method: "POST",
        json: { court_id: court.court_id, target_id: target },
      });
      const ok = await drawn(made);
      setQr(ok === null ? { status: "error" } : { status: "ok", ...ok });
      onChanged();
    } catch (err) {
      setFailure(t(dict, linkFailureKey(err instanceof ApiV1Error ? err.code : "", err)));
    } finally {
      setBusy(false);
    }
  };

  const showing = qr !== null;
  return (
    <Modal
      title={t(dict, showing ? "matchDay.courtStream.show" : "matchDay.courtStream.link")}
      onClose={onClose}
      closeLabel={t(dict, "matchDay.code.close")}
      footer={
        <>
          <button type="button" onClick={onClose} className="btn btn-ghost min-h-11">
            {t(dict, "matchDay.code.close")}
          </button>
          {!showing && (
            <button type="button" data-testid="md-cs-link-confirm" disabled={target === null || busy} onClick={() => void link()} className="btn btn-primary min-h-11">
              {t(dict, busy ? "matchDay.courtStream.linking" : "matchDay.courtStream.link")}
            </button>
          )}
        </>
      }
    >
      <div data-testid="md-cs-sheet" className="grid min-w-0 gap-4">
        <p className="text-sm font-semibold text-purple-950 [overflow-wrap:anywhere]">{court.court_name}</p>
        {!showing && <TargetPicker dict={dict} state={targets} value={target} onChange={setTarget} />}
        {failure !== null && (
          <p role="alert" data-testid="md-cs-failed" className="text-sm text-amber-900">
            {failure}
          </p>
        )}
        {qr !== null && <QrView dict={dict} state={qr} ctx={ctx} />}
      </div>
    </Modal>
  );
}

function QrView({ dict, state, ctx }: { dict: Dict; state: QrState; ctx: MatchDayCtx }) {
  if (state.status === "loading") return <p className="text-sm text-slate-600">{t(dict, "matchDay.code.loading")}</p>;
  if (state.status === "error") {
    return (
      <p role="alert" data-testid="md-cs-failed" className="text-sm text-amber-900">
        {t(dict, "matchDay.refusal.other")}
      </p>
    );
  }
  return (
    <div className="grid min-w-0 gap-3">
      <div data-testid="md-cs-qr" className="mx-auto w-full max-w-xs">
        <SeaznQrImage testId="md-cs-qr-image" sensitive qr={state.qr} alt={t(dict, "matchDay.courtStream.alt")} maxSize={PHONE_HANDOVER_QR_MAX_PX} />
      </div>
      <p className="text-center text-sm text-slate-700">{t(dict, "matchDay.courtStream.qrHint")}</p>
      <p className="text-center text-xs text-slate-600">
        {t(dict, "matchDay.courtStream.until", { time: fmtPublicTime(ctx.locale, ctx.tz, lastWorkingMinute(state.expiresAt)) })}
      </p>
    </div>
  );
}

/** "Stream this court", in the focus header of a court with no link. */
export function LinkCourtAction({ ctx, onOpen }: { ctx: MatchDayCtx; onOpen: () => void }) {
  return (
    <button
      type="button"
      data-testid="md-cs-link"
      aria-haspopup="dialog"
      onClick={onOpen}
      className="btn btn-ghost min-h-11 shrink-0 text-sm lg:min-h-0 lg:py-1.5"
    >
      {t(ctx.dict, "matchDay.courtStream.link")}
    </button>
  );
}

/** A linked court's status block, and for a writer its two actions: Show court QR, and Stop streaming (asks first). A view-only or
 *  frozen desk reads the status and nothing that writes. */
export function CourtStreamBand({
  ctx,
  court,
  link,
  onShowQr,
  onChanged,
}: {
  ctx: MatchDayCtx;
  court: MatchDayCourt;
  link: MatchDayCourtStream;
  /** "Show court QR": the focus opens the sheet on this link. */
  onShowQr: () => void;
  onChanged: () => void;
}) {
  const { dict } = ctx;
  const [asking, setAsking] = useState(false);
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  const writer = canWriteCourtStream(ctx);

  const withdraw = async () => {
    if (busy) return;
    setBusy(true);
    setFailed(false);
    try {
      await apiV1(`/api/v1/court-streams/${link.link_id}/withdraw`, { method: "POST" });
      setAsking(false);
      onChanged();
    } catch {
      setFailed(true);
    } finally {
      setBusy(false);
    }
  };

  return (
    <section data-testid="md-cs-band" aria-label={court.court_name} className="card grid min-w-0 gap-3 p-4">
      <CourtPhoneStatus dict={dict} locale={ctx.locale} tz={ctx.tz} link={link} viewNow={ctx.viewNow} {...(ctx.onTailEnd ? { onTailEnd: ctx.onTailEnd } : {})} />
      {writer && !asking && (
        <div className="flex min-w-0 flex-wrap gap-2 max-md:flex-col">
          <button type="button" data-testid="md-cs-show" aria-haspopup="dialog" onClick={onShowQr} className="btn btn-ghost min-h-11">
            {t(dict, "matchDay.courtStream.show")}
          </button>
          <button type="button" data-testid="md-cs-withdraw" onClick={() => setAsking(true)} className="btn btn-ghost min-h-11">
            <span className="min-w-0 [overflow-wrap:anywhere]">{t(dict, "matchDay.courtStream.withdraw", { court: court.court_name })}</span>
          </button>
        </div>
      )}
      {writer && asking && (
        <div data-testid="md-cs-confirm" role="group" className="grid min-w-0 gap-3 rounded-xl bg-amber-50 p-3 ring-1 ring-inset ring-amber-100">
          <p className="text-sm text-amber-950 [overflow-wrap:anywhere]">{t(dict, "matchDay.courtStream.withdrawConfirm", { court: court.court_name })}</p>
          <div className="flex min-w-0 flex-wrap gap-2 max-md:flex-col">
            <button type="button" data-testid="md-cs-withdraw-confirm" disabled={busy} onClick={() => void withdraw()} className="btn btn-primary min-h-11">
              <span className="min-w-0 [overflow-wrap:anywhere]">
                {t(dict, busy ? "matchDay.courtStream.withdrawing" : "matchDay.courtStream.withdraw", { court: court.court_name })}
              </span>
            </button>
            <button type="button" disabled={busy} onClick={() => setAsking(false)} className="btn btn-ghost min-h-11">
              {t(dict, "matchDay.sheet.cancel")}
            </button>
          </div>
          {failed && (
            <p role="alert" data-testid="md-cs-failed" className="text-xs font-medium text-amber-900">
              {t(dict, "matchDay.refusal.other")}
            </p>
          )}
        </div>
      )}
    </section>
  );
}
