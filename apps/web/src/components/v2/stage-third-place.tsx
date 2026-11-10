"use client";
// W4 app B, Task 10 (X-TP-2 UI half, X-TP-6; owner picks 1A, 7A; carry C35): a knockout stage's Third place, in the stage card's
// settings. An organiser changes it until the stage starts (PATCH /stages/{id} `{ thirdPlace }`, which draws the lines again for
// the new setting); once play has started it is READ-ONLY and says so in THIRD_PLACE_LOCKED's own words. A plate that was asked
// for a third-place match and drew under two semi-finals says it was dropped (C35: `thirdPlaceDropped` is on the wire, nothing
// showed it).
import { useState } from "react";
import { useRouter } from "next/navigation";
import { useMsg } from "@/components/i18n/dict-provider";
import { ThirdPlaceChoice } from "@/components/v2/third-place-choice";
import { apiV1, ApiV1Error } from "@/lib/client-v1";
import { knockoutRefusalText } from "@/lib/knockout-refusals";
import { thirdPlaceModeOf, thirdPlaceOffered, type ThirdPlaceMode } from "@/lib/third-place";

export function StageThirdPlace({
  stageId,
  config,
  fed,
  started,
  field,
  dropped,
  canEdit,
}: {
  stageId: string;
  config: Record<string, unknown> | null | undefined;
  /** A stage fed by an earlier one: its field is the source's, so the control cannot count it up front (the server does). */
  fed: boolean;
  /** Any line of the stage has started (a result, a decided line, a Match Day call): the setting is read-only (X-TP-6). */
  started: boolean;
  /** The plan's active entrants: a root bracket's field. */
  field: number;
  /** C35: the plate drew without its third-place match (`thirdPlaceDropped`). */
  dropped: boolean;
  canEdit: boolean;
}) {
  const msg = useMsg();
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const stored = thirdPlaceModeOf(config);
  const offer = { offered: fed || thirdPlaceOffered(field), entrants: fed ? null : field };

  async function pick(mode: ThirdPlaceMode) {
    if (mode === stored) return;
    setBusy(true);
    setError(null);
    try {
      await apiV1(`/api/v1/stages/${stageId}`, { method: "PATCH", json: { thirdPlace: mode } });
      router.refresh();
    } catch (err) {
      if (err instanceof ApiV1Error && err.code === "KO_THIRD_PLACE_TOO_FEW") {
        setError(msg("thirdPlace.tooFewCount", { count: Number(err.extra.entrants ?? field) }));
      } else {
        setError((err instanceof ApiV1Error ? knockoutRefusalText(err.code, err.extra, msg) : null) ?? (err instanceof Error ? err.message : msg("schedule.error.failed")));
      }
      // A refusal means the page's last read is stale (a start landed): read it again.
      if (err instanceof ApiV1Error) router.refresh();
    } finally {
      setBusy(false);
    }
  }

  if (!canEdit && !dropped) return null;
  return (
    <div className="min-w-0 space-y-2 border-b border-slate-100 px-4 py-3" data-testid="stage-third-place">
      {canEdit && (
        <ThirdPlaceChoice
          value={stored}
          onChange={(m) => void pick(m)}
          offer={offer}
          readOnlyReason={started ? msg("knockout.refusal.THIRD_PLACE_LOCKED") : null}
          busy={busy}
          testId="stage-third-place-choice"
        />
      )}
      {dropped && (
        <p className="text-xs text-amber-800" data-testid="stage-third-place-dropped">
          {msg("thirdPlace.dropped")}
        </p>
      )}
      {error && (
        <p className="rounded-md bg-red-50 px-3 py-2 text-sm text-red-600" data-testid="stage-third-place-error">
          {error}
        </p>
      )}
    </div>
  );
}
