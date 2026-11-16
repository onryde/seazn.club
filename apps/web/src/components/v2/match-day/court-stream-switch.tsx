"use client";
// A match's Stream switch (court stream spec 2026-11-14 §5.2; web plan Task 12): on a linked court's current and queued matches,
// "Stream" hands the match to the court's phone. It is the per-match INTENT and nothing more: turning it off never ends a video
// that is already on air (ruling R5), so nothing here says it does.
//
// A refused turn-on (409: the match has its own code, or the court stopped streaming under the desk) puts the switch back where
// it was and says why, in the row — and to the court's notice (`onRefused`), which the shell keeps through the refresh it triggers:
// the refresh can take this very row away (the court's link is gone), and a refusal that vanished with its row would be a silent
// one. A locked switch (the match's own code, or no link) is a plain disabled switch with its reason beside it, in words — never
// colour alone.
import { useId, useState } from "react";
import { ApiV1Error, apiV1 } from "@/lib/client-v1";
import { t } from "@/lib/i18n-runtime";
import { switchFailureKey, type SwitchSpec } from "@/lib/match-day/court-stream";
import type { MatchDayFixture } from "@/lib/match-day/types";
import type { MatchDayCtx } from "./court-focus";

const LOCK_KEY = { own_code: "matchDay.courtStream.ownCode", not_streaming: "matchDay.courtStream.notStreaming" } as const;

export function CourtStreamSwitch({
  ctx,
  fixture,
  spec,
  onChanged,
  onRefused,
}: {
  ctx: MatchDayCtx;
  fixture: Pick<MatchDayFixture, "id">;
  spec: SwitchSpec;
  /** The switch was written: read the board again. */
  onChanged: () => void;
  /** A refusal, in the organiser's words: the shell holds it for the court and reads the board again. */
  onRefused: (message: string) => void;
}) {
  const { dict } = ctx;
  // What the organiser just chose, shown at once; it yields to the board the moment the board's own answer differs from the one
  // it was chosen against (`base`), so a stale choice can never outlive the poll that settles it.
  const [choice, setChoice] = useState<{ base: boolean; value: boolean } | null>(null);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const switchId = useId();
  const reasonId = useId();
  const shown = choice !== null && choice.base === spec.on ? choice.value : spec.on;
  const locked = spec.lock !== null;
  const reason = spec.lock === "own_code" || spec.lock === "not_streaming" ? t(dict, LOCK_KEY[spec.lock]) : null;

  const turn = async () => {
    if (locked || busy) return;
    const next = !shown;
    setBusy(true);
    setFailure(null);
    setChoice({ base: spec.on, value: next });
    try {
      await apiV1(`/api/v1/fixtures/${fixture.id}/court-stream`, { method: "PUT", json: { on: next } });
      onChanged();
    } catch (err) {
      const words = t(dict, switchFailureKey(err instanceof ApiV1Error ? err.code : ""));
      setChoice(null);
      setFailure(words);
      onRefused(words);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div data-testid="md-cs-switch-row" className="min-w-0">
      {/* A settings row: the name (and, when the switch cannot be turned, why) on the left, the switch on the right. The name is a
          label of the switch, so a tap on it turns it too: a bigger target than the 44 px track alone. */}
      <div className="flex min-h-11 min-w-0 items-center justify-between gap-3">
        <label htmlFor={switchId} className="min-w-0 flex-1 cursor-pointer py-1.5">
          <span className="block text-sm font-medium text-slate-900">{t(dict, "matchDay.courtStream.switch")}</span>
          {reason !== null && (
            <span id={reasonId} data-testid="md-cs-switch-reason" className="block text-xs text-slate-600 [overflow-wrap:anywhere]">
              {reason}
            </span>
          )}
        </label>
        <button
          id={switchId}
          type="button"
          role="switch"
          data-testid="md-cs-switch"
          aria-checked={shown}
          aria-describedby={reason !== null ? reasonId : undefined}
          disabled={locked || busy}
          onClick={() => void turn()}
          className="inline-flex min-h-11 min-w-11 shrink-0 items-center justify-end rounded-lg disabled:cursor-not-allowed"
        >
          <span
            aria-hidden
            className={`relative inline-block h-6 w-11 shrink-0 rounded-full transition-colors motion-reduce:transition-none ${shown ? "bg-purple-600" : "bg-slate-300"} ${locked ? "opacity-60" : ""}`}
          >
            <span
              className={`absolute left-0.5 top-0.5 h-5 w-5 rounded-full bg-white shadow transition-transform motion-reduce:transition-none ${shown ? "translate-x-5" : ""}`}
            />
          </span>
        </button>
      </div>
      {failure !== null && (
        <p role="alert" data-testid="md-cs-switch-failed" className="pb-1 text-xs font-medium text-amber-900 [overflow-wrap:anywhere]">
          {failure}
        </p>
      )}
    </div>
  );
}
