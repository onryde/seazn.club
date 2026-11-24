"use client";

import { useMsg } from "@/components/i18n/dict-provider";
import { targetName } from "../youtube-connect-panel";
import { useSharedPhoneSession } from "../stream-session-provider";
import { elapsedLabel } from "@/lib/stream-session-view";
import { type Msg, statePill, stopError } from "./shared";

/**
 * G2 — the Phone tab's stop controls, for an org that no longer holds `streaming.relay` (a downgrade, an expired
 * override) while one of its streams is still up. The gate below it sells the feature; this keeps what is ALREADY on
 * air stoppable. Nothing but the session's own state and its way out: no QR (no credentials), no destinations, no
 * buying. Renders nothing at all without a session that is still up, so an unentitled org with nothing running sees
 * the gate alone.
 *
 * F1 (spec 2026-09-30 §2): also mounted alone by the fixture page's stop-only mount, when a billing freeze or a
 * switched-off overlay has taken the whole panel away. The page names its fixture, so no label is passed. `label` is
 * left from the division page's probe stack, which T6 removed: nothing in production passes it (B5 review m-9).
 */
export function PhoneStopProbe({ fixtureId, label }: { fixtureId: string; label?: string }) {
  const msg = useMsg();
  const s = useSharedPhoneSession(fixtureId);
  const v = s.shown;
  if (!v || s.state === "idle" || s.state === "ended" || s.state === "failed") return null;
  return (
    <div data-testid="stream-stop-probe" className="mb-3 min-w-0 space-y-2 rounded-lg border border-slate-200 p-3">
      {label && (
        <p data-testid="stream-stop-probe-label" className="truncate text-sm font-medium text-slate-800" title={label}>
          {label}
        </p>
      )}
      <div className="flex flex-wrap items-center gap-2">
        {statePill(msg, s.state)}
        {s.state === "live" && recAndElapsed(msg, v.startedAt, s.now)}
      </div>
      {s.state === "live" && (
        <button
          type="button"
          data-testid="stream-stop"
          disabled={s.busy}
          onClick={() => void s.stop()}
          className={STOP_BUTTON}
        >
          {msg("stream.phone.stop")}
        </button>
      )}
      {(s.state === "provisioning" || s.state === "warming") && (
        <button
          type="button"
          data-testid="stream-cancel"
          disabled={s.busy}
          onClick={() => void s.cancel()}
          className="btn btn-ghost min-h-11 w-full md:min-h-10 md:w-auto"
        >
          {msg("stream.phone.cancel")}
        </button>
      )}
      {s.state === "ending" && (
        <p data-testid="stream-ending" className="text-xs text-slate-600">
          {msg("stream.phone.ending", { destination: targetName(msg, v.target) })}
        </p>
      )}
      {s.stopFailed && stopError(msg, s.state)}
    </div>
  );
}

/** §8a: solid red, deliberately NOT `.btn-danger` (a white outline) — the one irreversible control on a panel that is
 *  on air. It opens the repo's confirm dialog. Shared by the tab and the stop probe (G2). */
const STOP_BUTTON =
  "min-h-11 w-full rounded-md bg-red-600 px-3 text-sm font-semibold text-white hover:bg-red-700 disabled:cursor-not-allowed disabled:opacity-50 md:min-h-10 md:w-auto";

/** REC + the elapsed clock (live). */
function recAndElapsed(msg: Msg, startedAt: string | null, now: Date) {
  return (
    <>
      <span
        data-testid="stream-rec"
        className="inline-flex items-center gap-1 rounded-full bg-red-600 px-2.5 py-1 text-[11px] font-semibold text-white"
      >
        <span
          aria-hidden
          className="inline-block h-1.5 w-1.5 animate-pulse rounded-full bg-white motion-reduce:animate-none"
        />
        {msg("stream.phone.rec")}
      </span>
      <span data-testid="stream-elapsed" className="font-mono text-sm tabular-nums text-slate-700">
        {elapsedLabel(startedAt, now)}
      </span>
    </>
  );
}
