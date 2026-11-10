"use client";
// B4 fix round 1 (I-2; owner pick 7A: "Use Shared" everywhere the X-TP-1 refusal shows). A play-off stage whose field fell under
// four is refused by name wherever the draw runs (Generate, Start, the board's start); each of those surfaces shows the count
// and this one button: it saves Shared on the stage the refusal NAMED (`extra.stageId`), then runs the surface's retry.
import { useState } from "react";
import { useMsg } from "@/components/i18n/dict-provider";
import { apiV1, ApiV1Error } from "@/lib/client-v1";
import { knockoutRefusalText } from "@/lib/knockout-refusals";

/** The stage and field a KO_THIRD_PLACE_TOO_FEW refusal names; null when the wire carries no stage to act on. */
export function tooFewOfferFrom(err: unknown): { stageId: string; entrants: number } | null {
  if (!(err instanceof ApiV1Error) || err.code !== "KO_THIRD_PLACE_TOO_FEW") return null;
  const stageId = err.extra.stageId;
  const entrants = Number(err.extra.entrants);
  return typeof stageId === "string" && Number.isFinite(entrants) ? { stageId, entrants } : null;
}

export function ThirdPlaceUseShared({ stageId, onDone, disabled = false }: { stageId: string; onDone: () => void | Promise<void>; disabled?: boolean }) {
  const msg = useMsg();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  async function useShared() {
    setBusy(true);
    setError(null);
    try {
      await apiV1(`/api/v1/stages/${stageId}`, { method: "PATCH", json: { thirdPlace: "shared" } });
    } catch (err) {
      setError(err instanceof ApiV1Error ? (knockoutRefusalText(err.code, err.extra, msg) ?? err.message) : msg("schedule.error.failed"));
      setBusy(false);
      return;
    }
    setBusy(false);
    await onDone();
  }
  return (
    <span className="inline-flex flex-col items-start gap-1">
      <button type="button" data-testid="third-place-use-shared" disabled={busy || disabled} onClick={() => void useShared()} className="btn btn-ghost min-h-11 px-3 py-1.5 text-sm">
        {msg("thirdPlace.useShared")}
      </button>
      {error && <span className="text-xs text-red-600" data-testid="third-place-use-shared-error">{error}</span>}
    </span>
  );
}
