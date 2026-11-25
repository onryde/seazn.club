"use client";

// The receipt an Open on an UNPAID package stands up on Match Day (spec 2026-11-23-online-chess-credits-design.md §7.6, §8.4; plan Task 12): "Pay N
// credits and open round 1". The server answered the open with 402 ONLINE_CHESS_UNPAID { quote, next } (`unpaidOf`); this receipt opens on the STORED
// size the quote is for (decision 15: the organiser's own choice, never the smallest that fits), or, when the server refused that size for this
// division, on the smallest it offered (`next`), which the organiser still confirms by its own price. Everything else - the other sizes with their
// price and consequence, a 409 redraw, a short balance, the late-entrant line - is the division page's own receipt (`OnlineReceipt`); this wrapper only
// feeds it the facts the 402 carried and routes its confirm to the open (`onPay`: the open again, with `pay`).
//
// The 402 also carries `invitable`, how many boards of the round the press would invite (the boards no Lichess link holds back): ZERO draws the
// "No player has linked Lichess yet" warning (pay now, re-open free once they link); one or more, or a body that did not say, draws none.
//
// Data not available here, said rather than invented: the plan's per-division cap (the sizes above it read as refused by the QUOTE's own reason
// after a pick, not greyed beforehand).
import { useMsg } from "@/components/i18n/dict-provider";
import { BuyStreamCredits } from "@/components/buy-stream-credits";
import type { Currency } from "@/lib/currency";
import { initialReceiptSize, type PayBody } from "@/lib/online-receipt";
import type { ReceiptChoice } from "@/lib/online-receipt-state";
import { readPackageQuote } from "@/lib/online-package-client";
import type { OpenRoundPayAsk } from "@/components/v2/desk/open-round-state";
import type { ViewerPlan } from "@/lib/viewer-plan";
import { OnlineReceipt } from "./receipt";

export interface OpenPayReceiptProps {
  /** The 402's ask: the stored size's quote, the smallest size that would hold the division when the stored one cannot, and how many boards the press would invite. */
  ask: OpenRoundPayAsk;
  divisionId: string;
  viewerPlan: ViewerPlan;
  /** Who is charged and in which currency, for the credits chooser a short balance opens; null: a link to the credits page instead. */
  buy: { orgId: string; currency: Currency } | null;
  buyMoreHref: string;
  /** The confirm: the open again, with `pay`. Resolves when the open answered (the receipt then closes); rejects with what the door threw. */
  onPay(body: PayBody): Promise<void>;
  /** The round's own words for a refusal of the open it named (409 changed, 402 frozen, 403 off): drawn in place of the payment sentence (spec §8.5). */
  failureWords?: (code: string) => string | null;
  onClose(): void;
}

export function OpenPayReceipt(p: OpenPayReceiptProps) {
  const msg = useMsg();
  const { ask, divisionId } = p;
  const q = ask.quote;
  const size = initialReceiptSize({ mode: "payAndOpen", stored: q.size, requested: null, quote: q, next: ask.next });
  // The quote to draw first: the stored size's own, or - when the server refused that size - the offered one's (the size above is its size).
  const first = q.refusal !== null ? ask.next : q;
  return (
    <OnlineReceipt
      mode="payAndOpen"
      facts={{ planCap: null, held: q.held, rounds: q.rounds, cameras: q.cameras, paid: null, storedSize: q.size, viewerPlan: p.viewerPlan }}
      size={size}
      quote={first}
      warnings={{ noInvitable: ask.invitable === 0 }}
      failureWords={p.failureWords}
      readQuote={(choice: ReceiptChoice) => readPackageQuote(divisionId, choice)}
      onConfirm={p.onPay}
      renderBuy={({ pack, size: shortSize, cameras }) =>
        p.buy === null ? (
          <a href={p.buyMoreHref} className="font-medium text-purple-700 underline" data-testid="online-receipt-buy-link">
            {msg("stream.phone.buyMore")}
          </a>
        ) : (
          <BuyStreamCredits orgId={p.buy.orgId} currency={p.buy.currency} preselect={pack} returnTo={{ divisionId, size: shortSize, cameras }} />
        )
      }
      onClose={p.onClose}
    />
  );
}
