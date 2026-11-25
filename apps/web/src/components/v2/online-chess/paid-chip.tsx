"use client";

// "Online Chess · up to 64 · paid          Change size" - what replaces the amber line once the package is paid (spec
// 2026-11-23-online-chess-credits-design.md §8.6, §8.7; plan Task 12). Once round 1 has opened (`frozen`) the chip stays and Change size
// goes: the size is fixed for the whole event, and there is no price and no prompt anywhere after it.
import type { ReactNode } from "react";
import { useMsg } from "@/components/i18n/dict-provider";
import type { OnlineSize } from "@/lib/online-chess-package";

export interface OnlinePaidChipProps {
  size: OnlineSize;
  /** Round 1 has opened: the size is fixed, so no Change size. */
  frozen: boolean;
  onChangeSize: () => void;
  /** A view-only reader: the chip says what is paid, and offers nothing. */
  readOnly?: boolean;
}

export function OnlinePaidChip({ size, frozen, onChangeSize, readOnly = false }: OnlinePaidChipProps): ReactNode {
  const msg = useMsg();
  const canChange = !frozen && !readOnly;
  return (
    <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1" data-testid="online-paid-chip" data-frozen={frozen}>
      <span className="inline-block max-w-full rounded-full bg-emerald-50 px-2.5 py-0.5 text-xs font-medium text-emerald-800 [overflow-wrap:anywhere]">
        {msg("onlineChess.chip.text", { size })}
      </span>
      {canChange && (
        <button
          type="button"
          onClick={onChangeSize}
          className="inline-flex min-h-11 items-center text-xs font-medium text-purple-700 underline decoration-purple-300 underline-offset-2 hover:decoration-purple-700"
          data-testid="online-paid-chip-change"
        >
          {msg("onlineChess.chip.change")}
        </button>
      )}
    </div>
  );
}
