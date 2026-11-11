"use client";

// The ⋯ on a sponsor's row below md (sponsor deals PR 2, Task 14; spec §6.1: "on phones, the clicks count and the edit, move and
// delete actions move into a ⋯ menu"). It is only the toggle: the controls it folds stay ONCE in the row (the list marks their
// tray `max-md:hidden` until this is open), so there is no second phone copy of them. `md:hidden` - from 768 up the controls are
// inline and this is gone. A 44px target (`h-11 w-11`), the house's tap floor (ui/card-menu.tsx `tap`). The edit pencil is NOT
// folded behind it: it sits beside this toggle in the row's lead cell, on screen whether the tray is open or not (owner, 2026-11-11).
import { MoreHorizontal } from "lucide-react";
import { useMsg } from "@/components/i18n/dict-provider";

export function SponsorRowMore({
  name,
  open,
  controlsId,
  onToggle,
}: {
  /** The sponsor, named for a screen reader: every row has its own ⋯. */
  name: string;
  open: boolean;
  /** The id of the tray this opens (`aria-controls`). */
  controlsId: string;
  onToggle: () => void;
}) {
  const msg = useMsg();
  return (
    <button
      type="button"
      data-testid="sponsor-row-more"
      aria-expanded={open}
      aria-controls={controlsId}
      aria-label={msg("sponsors.list.more", { name })}
      onClick={onToggle}
      className="grid h-11 w-11 shrink-0 place-items-center rounded-lg text-slate-500 hover:bg-purple-50 hover:text-purple-700 aria-expanded:bg-purple-50 aria-expanded:text-purple-700 md:hidden"
    >
      <MoreHorizontal className="h-4 w-4" strokeWidth={2} />
    </button>
  );
}
