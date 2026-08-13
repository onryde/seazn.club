// Helpers every skin needs, in one place (S11/#420 W9, review follow-up).
//
// These were independently reimplemented in all five skins during the parallel
// build — `renderLockedTile` four times byte-identically, `chipClass` twice,
// and a defensive record probe five times under three different signatures.
// That is not just repetition: four copies of the locked tile is four places a
// future fix has to land, and the drift had already started (cricket's own
// inline version omitted `aria-disabled`, so the one sport with the busiest pad
// was the one announcing a locked control as an ordinary element to a screen
// reader).
import type { ReactNode } from "react";
import { padLabel, type MsgFn } from "@/lib/scoring-vocab";
import type { PadActionView } from "../view-model";

/**
 * The "you cannot use this on your plan" tile. Same visual language and same
 * reason text as the universal renderer's own (`panel.tsx:57-69`), because a
 * scorer who moves between a skinned and an unskinned sport should not meet two
 * different treatments of the same state.
 *
 * Returns null for an action that is NOT locked, so a caller can use it as a
 * guard clause without repeating the check.
 */
export function renderLockedTile(action: PadActionView, msg: MsgFn): ReactNode {
  if (action.availability.kind !== "locked") return null;
  const label = padLabel(action.labelKey.key, msg, action.labelKey.label);
  return (
    <div
      key={action.type + action.labelKey.key}
      className="flex h-14 w-full flex-col items-center justify-center gap-0.5 rounded-lg border border-amber-200 bg-amber-50 px-3 text-center opacity-75"
      aria-disabled="true"
    >
      <span className="text-sm font-medium text-amber-900">{label}</span>
      <span className="text-[11px] text-amber-700">{msg(action.availability.reason.key)}</span>
    </div>
  );
}

/** A tap-to-select chip. `min-h-11` is the 44px touch bar, which this pad is
 *  held to at 320px as much as at 1280. */
export function chipClass(pressed: boolean): string {
  return `inline-flex min-h-11 shrink-0 items-center rounded-full border px-4 text-sm font-medium transition ${
    pressed ? "border-accent-line bg-accent-line/10 text-slate-900" : "border-slate-200 text-slate-600"
  }`;
}

// NOT extracted, deliberately: each skin's own `asRecord`/`isRecord` probe.
// Review flagged the five copies, but they are not actually the same function —
// football's returns `| undefined`, period's is a type guard, and the other
// three differ on whether an ARRAY counts as a record. Collapsing them would
// change behaviour in three files to remove nine lines, which is a worse trade
// than the duplication. Left as is, with the reason recorded so the next
// reviewer does not re-open it.
