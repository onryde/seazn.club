"use client";

// The "Players, up to" select of an Online Chess division (spec 2026-11-23-online-chess-credits-design.md §8.1, §8.6; plan Task 11).
// One control for both homes of the choice - the Division rules strip's draft mode (the builder's step 3) and its saved mode (the
// division page's Fixtures tab) - so the options, their greying and their words are written once.
//
// Every number is the price leaf's (`lib/online-chess-package`: the ladder, the rounds each size includes, the price table), reached
// through `onlineSizeOptions`; the reasons a size is greyed are the SERVER's refusal order, one size at a time. A paid row never saves
// a size from here: a pick calls `onPaidPick` (the receipt, Task 12) and the select keeps showing the paid size.
import type { ReactNode } from "react";
import { useMsg, useMsgPlural } from "@/components/i18n/dict-provider";
import type { OnlineSize } from "@/lib/online-chess-package";
import type { ViewerPlan } from "@/lib/viewer-plan";
import { onlineSizeOptions, type OnlineSizeOption } from "@/lib/online-size-options";

export interface OnlineSizeSelectProps {
  /** The chosen size; null when no size holds the places and rounds (nothing is picked for the organiser). */
  value: OnlineSize | null;
  /** The plan's `entrants.per_division.max`; null is no cap. */
  planCap: number | null;
  /** The plan the select says "not on {plan}" with; `unknown` reads "your plan". */
  viewerPlan: ViewerPlan;
  /** Places already held. */
  held: number;
  /** Swiss rounds the division's stages declare. */
  rounds: number;
  /** Whether the division is priced with the Fair-play camera. */
  cameras: boolean;
  /** The PAID package, when there is one: its size and whether its camera was paid. */
  paid: { size: OnlineSize; camerasPaid: boolean } | null;
  /** An unpaid pick. */
  onChange: (size: OnlineSize) => void;
  /** A pick on a PAID row: the receipt's door, never a save. Absent: the pick is dropped. */
  onPaidPick?: (size: OnlineSize) => void;
  /** The package is frozen (round 1 has begun): read only. */
  frozen?: boolean;
  /** A save is in flight. */
  disabled?: boolean;
}

/** The note after an option's size and rounds: why it is greyed, or what moving to it costs on a paid row. */
function noteFor(
  o: OnlineSizeOption,
  p: Pick<OnlineSizeSelectProps, "held" | "rounds" | "viewerPlan" | "paid">,
  msg: ReturnType<typeof useMsg>,
  plural: ReturnType<typeof useMsgPlural>,
): string | null {
  if (o.disabled === "held") return msg("onlineChess.size.note.held", { held: p.held });
  if (o.disabled === "plan") return msg("onlineChess.size.note.plan", { plan: msg(`onlineChess.size.plan.${p.viewerPlan}` as Parameters<typeof msg>[0]) });
  if (o.disabled === "rounds") return msg("onlineChess.size.note.rounds", { rounds: p.rounds });
  if (p.paid === null || o.diff === null) return null;
  if (o.diff === 0) return msg("onlineChess.size.note.paid");
  return o.diff > 0 ? plural("onlineChess.size.note.pay", o.diff, { count: o.diff }) : plural("onlineChess.size.note.back", -o.diff, { count: -o.diff });
}

export function OnlineSizeSelect(p: OnlineSizeSelectProps): ReactNode {
  const msg = useMsg();
  const plural = useMsgPlural();
  const options = onlineSizeOptions({ planCap: p.planCap, held: p.held, rounds: p.rounds, cameras: p.cameras, paid: p.paid });
  const readOnly = p.frozen === true;

  function pick(raw: string): void {
    const option = options.find((o) => String(o.size) === raw); // the empty option and a size off the ladder match nothing
    if (option === undefined || option.disabled !== null) return; // a greyed size is never picked, even by a hand-made event
    if (p.paid !== null) {
      if (option.size !== p.paid.size) p.onPaidPick?.(option.size);
      return;
    }
    p.onChange(option.size);
  }

  return (
    <div>
      <label className="block">
        <span className="label">{msg("onlineChess.size.label")}</span>
        <select
          value={p.value === null ? "" : String(p.value)}
          disabled={p.disabled === true || readOnly}
          onChange={(e) => pick(e.target.value)}
          className="select block min-h-11 w-full md:max-w-xs"
          data-testid="online-size-select"
        >
          {p.value === null && <option value="">{"—"}</option>}
          {options.map((o) => {
            const note = noteFor(o, p, msg, plural);
            return (
              <option key={o.size} value={o.size} disabled={o.disabled !== null}>
                {msg("onlineChess.size.option", { size: o.size, rounds: o.rounds })}
                {note !== null && ` · ${note}`}
              </option>
            );
          })}
        </select>
      </label>
      <p className="mt-1 text-[11px] text-slate-600">{msg("onlineChess.size.help")}</p>
    </div>
  );
}
