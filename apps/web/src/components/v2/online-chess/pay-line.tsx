"use client";

// The amber line an unpaid Online Chess division wears on its Fixtures tab (spec 2026-11-23-online-chess-credits-design.md §8.3; plan Task 12):
// "Online Chess not paid. 41 registered, up to 64. Round 1 can't open until it's paid." with Change size and Pay {owed} credits.
// In `LockLine`'s style (a small status sentence in the strip) with a tone and two actions, which `LockLine` has no place for.
//
// It decides nothing and spends nothing. `owed` is the leaf's price for the size the row stores (the host passes it), the buttons are the
// host's: Change size takes the organiser to the select, Pay opens the receipt, where the server's own quote - never this figure - is what
// they confirm. Phone: the two buttons sit under the sentence, full width, Pay first. Desktop: one row, sentence left, buttons right.
import type { ReactNode } from "react";
import { useMsg, useMsgPlural } from "@/components/i18n/dict-provider";
import type { OnlineSize } from "@/lib/online-chess-package";

export interface OnlinePayLineProps {
  /** Places held: the entrants the division already has. */
  held: number;
  /** The size the package is stored at. */
  size: OnlineSize;
  /** What paying costs now (the leaf's price for the stored size). */
  owed: number;
  onChangeSize: () => void;
  onPay: () => void;
  /** The organiser may not pay (a view-only reader): the sentence stays, the buttons go. */
  readOnly?: boolean;
}

export function OnlinePayLine({ held, size, owed, onChangeSize, onPay, readOnly = false }: OnlinePayLineProps): ReactNode {
  const msg = useMsg();
  const plural = useMsgPlural();
  return (
    <div
      className="flex min-w-0 flex-col gap-2 rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-900 md:flex-row md:items-center md:justify-between"
      data-testid="online-pay-line"
      data-owed={owed}
    >
      <p className="min-w-0 leading-snug [overflow-wrap:anywhere]">
        <span aria-hidden="true" className="mr-1 font-bold">
          !
        </span>
        {msg("onlineChess.payLine.text", { held, size })}
      </p>
      {!readOnly && (
        // Pay is the primary action: first on a phone (reversed column), last on a desktop row, where it sits at the right edge.
        <div className="flex min-w-0 flex-col-reverse gap-2 md:flex-row md:shrink-0">
          <button type="button" onClick={onChangeSize} className="btn btn-ghost min-h-11 max-md:w-full" data-testid="online-pay-line-change">
            {msg("onlineChess.payLine.change")}
          </button>
          <button type="button" onClick={onPay} className="btn btn-primary min-h-11 max-md:w-full" data-testid="online-pay-line-pay">
            {plural("onlineChess.payLine.pay", owed, { count: owed })}
          </button>
        </div>
      )}
    </div>
  );
}
