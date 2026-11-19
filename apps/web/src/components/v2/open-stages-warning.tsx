"use client";

// W4 T21 (AN-1, X-CH-8; owner pick R24 4A, ruling 273): the inline warning under competition settings' Status select.
// Completing a competition WARNS and never refuses: it lists every stage still open with what it waits for, and offers
// the EXISTING Complete stage (POST /api/v1/stages/{id}/complete, stages-panel.tsx's own call) on a stage with nothing
// but its completion left. Prod held a completed competition whose knockout final was decided and whose stage was
// never completed, so its bracket never ranked. Layout from the owner's mock (heading, one line, a row per stage with
// its status line and a small ghost button); house theme, amber warning tone.
import { useState } from "react";
import { useRouter } from "next/navigation";
import { apiV1 } from "@/lib/client-v1";
import { useMsg, useMsgPlural } from "@/components/i18n/dict-provider";
import type { MessageKey } from "@/lib/messages";
import { onlyCompletionLeft, type OpenStageRow, type OpenStageState } from "@/lib/open-stages";
import { completedSeedingFailedText } from "@/lib/completed-seeding-failed";

/** One status line per state; `matches_left` is counted, so it is the plural key below. A `Record`, so a new state is a
 *  compile error here rather than a row with no line. */
const STATE_KEY: Record<Exclude<OpenStageState, "matches_left">, MessageKey> = {
  final_decided: "compset.openStages.state.final_decided",
  final_pending: "compset.openStages.state.final_pending",
  final_held: "compset.openStages.state.final_held",
  all_played: "compset.openStages.state.all_played",
  no_matches: "compset.openStages.state.no_matches",
};

/** The sentence under the heading, by the door the warning sits in: settings completes on Save; the competition
 *  page's wrap-up prompt has no Save button, so it speaks of marking the competition completed (B-desk re-review N3). */
const BODY_KEY: Record<"settings" | "wrapUp", MessageKey> = {
  settings: "compset.openStages.body",
  wrapUp: "comp.wrapUp.openStagesBody",
};

export function OpenStagesWarning({
  id,
  stages,
  canComplete,
  door = "settings",
}: {
  /** The completing control (the Status select, or Mark completed) points at this with aria-describedby. */
  id: string;
  stages: OpenStageRow[];
  /** False for a frozen competition: the warning still says what is open, but offers no write. */
  canComplete: boolean;
  door?: keyof typeof BODY_KEY;
}) {
  const msg = useMsg();
  const msgPlural = useMsgPlural();
  const router = useRouter();
  const [busy, setBusy] = useState<string | null>(null);
  // `tone`: "error" - nothing was written; "warning" - the stage DID complete and something after it needs the organiser (B5 n1).
  const [notice, setNotice] = useState<{ stageId: string; text: string; tone: "warning" | "error" } | null>(null);

  async function complete(stageId: string) {
    setBusy(stageId);
    setNotice(null);
    try {
      const out = await apiV1<{ completed: boolean; already_complete?: boolean }>(`/api/v1/stages/${stageId}/complete`, { method: "POST", json: {} });
      // X-BD-4: a stage that was already complete is done as far as this warning goes - refresh and the row is gone.
      if (out.completed || out.already_complete === true) router.refresh();
      else setNotice({ stageId, text: msg("schedule.notice.notReady"), tone: "error" });
    } catch (err) {
      // B5 n1: the stage completed and only the next stage's seeding failed - the stage rail's own amber "completed, but" line with
      // the carried cause, and a refresh (the stage is no longer open). Same sentence, same home (`completedSeedingFailedText`).
      const completedBut = completedSeedingFailedText(err, msg);
      if (completedBut !== null) {
        setNotice({ stageId, text: completedBut, tone: "warning" });
        router.refresh();
        return;
      }
      // The server's own sentence is English; the reader gets theirs, and where to look.
      setNotice({ stageId, text: msg("compset.openStages.completeFailed"), tone: "error" });
    } finally {
      setBusy(null);
    }
  }

  return (
    <div
      id={id}
      data-testid="compset-open-stages"
      className="col-span-2 mt-2 rounded-lg bg-amber-50 p-3 ring-1 ring-inset ring-amber-200"
    >
      <p className="text-sm font-semibold text-amber-900">{msgPlural("compset.openStages.heading", stages.length)}</p>
      <p className="mt-1 text-xs leading-relaxed text-amber-900/80">{msg(BODY_KEY[door])}</p>
      <ul className="mt-2 divide-y divide-amber-200/80">
        {stages.map((s) => {
          const offer = canComplete && onlyCompletionLeft(s.state);
          const line =
            s.state === "matches_left"
              ? msgPlural("compset.openStages.state.matches_left", s.matchesLeft)
              : msg(STATE_KEY[s.state]);
          return (
            <li
              key={s.stageId}
              data-open-stage={s.stageId}
              data-state={s.state}
              className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1.5 py-2"
            >
              <div className="min-w-0 flex-1">
                <p className="break-words text-sm font-medium text-slate-800">
                  {msg("compset.openStages.row", { division: s.divisionName, seq: s.seq, stage: s.stageName })}
                </p>
                <p className={`mt-0.5 text-xs ${offer ? "text-amber-900" : "text-slate-600"}`}>{line}</p>
                {notice?.stageId === s.stageId && noticeLine(notice.tone, notice.text)}
              </div>
              {offer && (
                <button
                  type="button"
                  data-complete-stage={s.stageId}
                  disabled={busy !== null}
                  onClick={() => void complete(s.stageId)}
                  className="btn btn-ghost min-h-11 shrink-0 px-3 py-1.5 text-xs"
                >
                  {msg("schedule.complete")}
                </button>
              )}
            </li>
          );
        })}
      </ul>
      {/* B5 n1: a stage that completed leaves the list on the refresh; its "completed, but" line stays, under the list. Only that one:
          a red line says nothing was written to its row's stage, so it goes with the row (B5 fix wave G4). */}
      {notice !== null && notice.tone === "warning" && !stages.some((s) => s.stageId === notice.stageId) && noticeLine(notice.tone, notice.text)}
    </div>
  );
}

/** A plain function, not a component: the line stays in this island's own tree (the hook harness expands no child component). */
function noticeLine(tone: "warning" | "error", text: string) {
  return (
    <p role="alert" data-notice-tone={tone} className={`mt-1 text-xs ${tone === "warning" ? "font-medium text-amber-900" : "text-red-700"}`}>
      {text}
    </p>
  );
}
