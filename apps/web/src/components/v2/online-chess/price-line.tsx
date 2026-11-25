"use client";

// "Online Chess: 8 credits · You have 11 credits · Buy more" (spec 2026-11-23-online-chess-credits-design.md §8.1, §8.6; plan Task 11).
// What the chosen size costs and what the club holds - nothing here spends. Paying is the receipt's job (Task 12), at the moment the
// organiser opens round 1; this line only tells them what is coming, so the builder and the strip can show the same sentence.
//
// `quote` is the server's own numbers (the package quote's price and balance; the builder page's projected balance), never computed
// here. "Buy more" is a link to where credits are bought (a new tab, so a half-made division survives) or, where the caller has its
// own way, a button.
import type { ReactNode } from "react";
import { useMsg, useMsgPlural } from "@/components/i18n/dict-provider";

export interface OnlinePriceLineProps {
  quote: { price: number; balance: number };
  /** Where credits are bought; opens in a new tab. */
  buyMoreHref?: string;
  /** A caller's own "Buy more" (a modal, a panel); ignored when `buyMoreHref` is given. */
  onBuyMore?: () => void;
}

const LINK = "font-medium text-purple-700 underline decoration-purple-300 underline-offset-2 hover:decoration-purple-700";

export function OnlinePriceLine({ quote, buyMoreHref, onBuyMore }: OnlinePriceLineProps): ReactNode {
  const msg = useMsg();
  const plural = useMsgPlural();
  const short = quote.price > quote.balance;
  return (
    <div className="min-w-0" data-testid="online-price-line" data-short={short}>
      <p className="min-w-0 text-xs text-slate-800 [overflow-wrap:anywhere]">
        <span className="font-medium">{plural("onlineChess.price.cost", quote.price, { count: quote.price })}</span>
        {" · "}
        <span className={short ? "text-amber-800" : undefined}>{plural("onlineChess.price.have", quote.balance, { count: quote.balance })}</span>
        {buyMoreHref !== undefined ? (
          <>
            {" · "}
            <a href={buyMoreHref} target="_blank" rel="noopener noreferrer" className={LINK} data-testid="online-buy-more">
              {msg("stream.phone.buyMore")}
            </a>
          </>
        ) : onBuyMore !== undefined ? (
          <>
            {" · "}
            <button type="button" onClick={onBuyMore} className={LINK} data-testid="online-buy-more">
              {msg("stream.phone.buyMore")}
            </button>
          </>
        ) : null}
      </p>
      <p className="mt-0.5 text-[11px] text-slate-600">{msg("onlineChess.price.later")}</p>
    </div>
  );
}
