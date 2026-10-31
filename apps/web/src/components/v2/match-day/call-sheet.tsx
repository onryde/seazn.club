"use client";
// Match Day's call sheet (spec 2026-10-31 §7, §7.1, task A3). Opening it asks POST /fixtures/{id}/call/preview for the
// knock-on — which of the court's matches start later than planned, and the warnings (§7.2) — so nothing changes behind the
// organiser's back; confirming POSTs the call itself. A refusal (a player now busy, the court taken, the match started) shows
// in the organiser's words and refreshes the page behind the sheet, which is stale by definition.
import { useEffect, useState } from "react";
import { Modal } from "@/components/modal";
import { ApiV1Error, apiV1 } from "@/lib/client-v1";
import { fmtPublicTime } from "@/lib/format";
import { t } from "@/lib/i18n-runtime";
import type { CallPreview } from "@/lib/match-day/call";
import type { MatchDayCandidate, MatchDayCourt } from "@/lib/match-day/types";
import { matchLabel, refusalMessage, warningText } from "@/lib/match-day/view";
import type { MatchDayCtx } from "./court-focus";

export type CallSheetState =
  | { kind: "loading" }
  | { kind: "ready"; preview: CallPreview }
  | { kind: "calling"; preview: CallPreview }
  | { kind: "refused"; message: string };

/** A failed request's words: a refusal by its code, anything else (offline, a 500) as "that didn't work". */
export function failureMessage(ctx: MatchDayCtx, err: unknown): string {
  return err instanceof ApiV1Error ? refusalMessage(ctx.dict, err.code, err.extra) : refusalMessage(ctx.dict, "");
}

export function CallSheet({
  ctx,
  court,
  candidate,
  onClose,
  onCalled,
  onStale,
}: {
  ctx: MatchDayCtx;
  court: MatchDayCourt;
  candidate: MatchDayCandidate;
  onClose: () => void;
  onCalled: () => void;
  /** A refusal: the page behind the sheet no longer matches the server. */
  onStale: () => void;
}) {
  const [state, setState] = useState<CallSheetState>({ kind: "loading" });
  const fixtureId = candidate.fixture.id;
  const courtId = court.court_id;

  useEffect(() => {
    const ctl = new AbortController();
    apiV1<CallPreview>(`/api/v1/fixtures/${fixtureId}/call/preview`, { method: "POST", json: { court_id: courtId }, signal: ctl.signal })
      .then((preview) => setState({ kind: "ready", preview }))
      .catch((err: unknown) => {
        if (ctl.signal.aborted) return;
        setState({ kind: "refused", message: failureMessage(ctx, err) });
        onStale();
      });
    return () => ctl.abort();
    // The sheet previews ONE call: it is mounted per candidate and closed after.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fixtureId, courtId]);

  const confirm = async () => {
    if (state.kind !== "ready") return;
    setState({ kind: "calling", preview: state.preview });
    try {
      await apiV1(`/api/v1/fixtures/${fixtureId}/call`, { method: "POST", json: { court_id: courtId } });
      onCalled();
    } catch (err) {
      setState({ kind: "refused", message: failureMessage(ctx, err) });
      onStale();
    }
  };

  const { dict } = ctx;
  const ready = state.kind === "ready" || state.kind === "calling";
  return (
    <Modal
      title={t(dict, "matchDay.sheet.title", { court: court.court_name })}
      onClose={onClose}
      footer={
        ready ? (
          <>
            <button type="button" onClick={onClose} className="btn btn-ghost min-h-11">
              {t(dict, "matchDay.sheet.cancel")}
            </button>
            <button
              type="button"
              data-testid="md-call-confirm"
              disabled={state.kind === "calling"}
              onClick={() => void confirm()}
              className="btn btn-primary min-h-11"
            >
              {state.kind === "calling" ? t(dict, "matchDay.sheet.calling") : t(dict, "matchDay.sheet.confirm", { court: court.court_name })}
            </button>
          </>
        ) : (
          <button type="button" onClick={onClose} className="btn btn-ghost min-h-11">
            {t(dict, "matchDay.sheet.close")}
          </button>
        )
      }
    >
      <CallSheetBody ctx={ctx} court={court} candidate={candidate} state={state} />
    </Modal>
  );
}

/** What the sheet says, from a state already in hand (the SSR suite renders this directly). */
export function CallSheetBody({
  ctx,
  court,
  candidate,
  state,
}: {
  ctx: MatchDayCtx;
  court: MatchDayCourt;
  candidate: MatchDayCandidate;
  state: CallSheetState;
}) {
  const { dict, locale, tz } = ctx;
  const time = (iso: string) => fmtPublicTime(locale, tz, iso);
  return (
    <div data-testid="md-call-sheet" className="grid gap-3">
      <p className="text-base font-semibold text-slate-900 [overflow-wrap:anywhere]">
        {matchLabel(dict, candidate.fixture)}{" "}
        <span className="text-sm font-normal text-slate-500">· {candidate.fixture.division_name}</span>
      </p>
      {state.kind === "loading" && <p aria-live="polite">{t(dict, "matchDay.sheet.loading")}</p>}
      {state.kind === "refused" && (
        <p role="alert" data-testid="md-call-refused" className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-800">
          {state.message}
        </p>
      )}
      {(state.kind === "ready" || state.kind === "calling") && (
        <>
          {state.preview.shifts.length === 0 ? (
            <p>{t(dict, "matchDay.sheet.noShift", { court: court.court_name })}</p>
          ) : (
            <div>
              <p className="mb-1 text-xs font-semibold text-slate-600">{t(dict, "matchDay.sheet.shiftsTitle", { court: court.court_name })}</p>
              <ul className="grid gap-1">
                {state.preview.shifts.map((s) => (
                  <li key={s.fixture_id} data-testid="md-shift" className="[overflow-wrap:anywhere]">
                    {t(dict, "matchDay.sheet.shift", { match: s.label, from: time(s.planned_at), to: time(s.estimated_at) })}
                  </li>
                ))}
              </ul>
            </div>
          )}
          {state.preview.warnings.length > 0 && (
            <ul className="grid gap-1 rounded-lg bg-amber-50 px-3 py-2 text-amber-900">
              {state.preview.warnings.map((w, i) => (
                <li key={`${w.kind}-${i}`} data-testid="md-warning" data-kind={w.kind}>
                  {warningText(dict, w, locale, tz)}
                </li>
              ))}
            </ul>
          )}
          <p className="text-xs text-slate-500">{t(dict, "matchDay.sheet.notify")}</p>
        </>
      )}
    </div>
  );
}
