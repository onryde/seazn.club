"use client";

// The Online Chess package on the division page: the amber pay line or the paid chip, and the receipt each of them opens (spec
// 2026-11-23-online-chess-credits-design.md §8.3-§8.7; plan Task 12). The Division rules strip mounts it under its header; it owns WHEN the receipt
// opens and what a confirm does, and nothing about what anything costs (the receipt reads the server's quote).
//
// The receipt opens for four reasons, each its own `open` request:
//   - Pay on the amber line                            -> `pay` the stored size;
//   - Change size on the chip                           -> `change`, no size chosen (the list);
//   - a pick on a PAID row's select (`pick`)             -> `change`, on that size;
//   - the checkout return (`?oc=pay`, `request`)         -> `pay` on the stored size (a first payment) or `change` on the size the address named.
// The checkout return is keyed on its arrival (`request.key`, the Stripe session): it opens ONCE per arrival, however the page was reached - a full
// load, or a client navigation that hands this host a new request - and a `router.refresh()` of the same arrival does not reopen what the organiser
// closed. A request that goes away (a navigation to the plain page) forgets the arrival, so the next `?oc=pay` opens again.
import { useCallback, useState, type ReactNode } from "react";
import { useRouter } from "next/navigation";
import { useMsg } from "@/components/i18n/dict-provider";
import { BuyStreamCredits } from "@/components/buy-stream-credits";
import type { Currency } from "@/lib/currency";
import { packagePrice, type OnlineSize } from "@/lib/online-chess-package";
import { payPackage, readPackageQuote } from "@/lib/online-package-client";
import type { OnlineReceiptRequest } from "@/lib/online-package-return";
import type { PayBody, ReceiptMode } from "@/lib/online-receipt";
import type { ReceiptChoice } from "@/lib/online-receipt-state";
import type { ViewerPlan } from "@/lib/viewer-plan";
import { OnlinePaidChip } from "./paid-chip";
import { OnlinePayLine } from "./pay-line";
import { OnlineReceipt } from "./receipt";

export interface OnlinePackageHostProps {
  divisionId: string;
  /** The live package row; null while the division has none (online play off): nothing is drawn. */
  stored: { size: OnlineSize; paid: { size: OnlineSize; camerasPaid: boolean } | null; frozen: boolean } | null;
  planCap: number | null;
  held: number;
  rounds: number;
  cameras: boolean;
  viewerPlan: ViewerPlan;
  /** The reader may pay (an organiser of an offered club): a view-only reader sees the line and the chip, and no buttons. */
  canEdit: boolean;
  /** The checkout return the page read from its address; null on an ordinary visit. */
  request: OnlineReceiptRequest | null;
  /** The last pick on a paid row's select: `n` counts picks, so the same size picked twice opens twice. */
  pick: { size: OnlineSize; n: number } | null;
  /** Change size on the amber line: take the organiser to the select. */
  onChangeSize: () => void;
  /** Where credits are bought (the chooser inside the receipt), and where to send a reader who cannot see it. */
  buy: { orgId: string; currency: Currency } | null;
  buyMoreHref: string;
}

type Open = { mode: ReceiptMode; size: OnlineSize | null; n: number };

/** The receipt a checkout return asks for: a first payment reopens on the stored size, an upgrade on the size the address named. Nothing to open
 *  for a package that does not exist or is frozen. */
function openForReturn(stored: OnlinePackageHostProps["stored"], request: OnlineReceiptRequest, n: number): Open | null {
  if (stored === null || stored.frozen) return null;
  return stored.paid === null ? { mode: "pay", size: request.size ?? stored.size, n } : { mode: "change", size: request.size, n };
}

export function OnlinePackageHost(p: OnlinePackageHostProps): ReactNode {
  const msg = useMsg();
  const router = useRouter();
  const { divisionId, stored } = p;
  const [open, setOpen] = useState<Open | null>(() => (p.request === null ? null : openForReturn(stored, p.request, 0)));
  const [handledArrival, setHandledArrival] = useState<string | null>(p.request === null ? null : p.request.key);
  const [seenPick, setSeenPick] = useState(p.pick === null ? 0 : p.pick.n);
  const [opened, setOpened] = useState(0);
  const [notice, setNotice] = useState<string | null>(null);

  // A new arrival opens the receipt; a request that left forgets it (adjust-state-during-render: no effect, no frame without the receipt).
  if (p.request === null) {
    if (handledArrival !== null) setHandledArrival(null);
  } else if (handledArrival !== p.request.key) {
    setHandledArrival(p.request.key);
    setOpened(opened + 1);
    setOpen(openForReturn(stored, p.request, opened + 1));
  }
  // A pick on a paid row's select opens the receipt on that size, once per pick.
  if (p.pick !== null && p.pick.n !== seenPick) {
    setSeenPick(p.pick.n);
    if (stored !== null && stored.paid !== null && !stored.frozen) {
      setOpened(opened + 1);
      setOpen({ mode: "change", size: p.pick.size, n: opened + 1 });
    }
  }

  const readQuote = useCallback((choice: ReceiptChoice) => readPackageQuote(divisionId, choice), [divisionId]);
  const onConfirm = useCallback(
    async (body: PayBody): Promise<void> => {
      const result = await payPackage(divisionId, body);
      setNotice(result.capacityLoweredTo === null ? null : msg("onlineChess.capacityLowered", { size: result.capacityLoweredTo }));
      router.refresh();
    },
    [divisionId, msg, router],
  );

  if (stored === null) return null;
  const unpaid = stored.paid === null && !stored.frozen;
  const paid = stored.paid !== null;
  const startOpen = (mode: ReceiptMode, size: OnlineSize | null) => {
    setOpened(opened + 1);
    setOpen({ mode, size, n: opened + 1 });
  };

  return (
    <div className="grid min-w-0 gap-2" data-testid="online-package-host">
      {unpaid && (
        <OnlinePayLine
          held={p.held}
          size={stored.size}
          owed={packagePrice(stored.size, p.cameras)}
          onChangeSize={p.onChangeSize}
          onPay={() => startOpen("pay", stored.size)}
          readOnly={!p.canEdit}
        />
      )}
      {paid && <OnlinePaidChip size={stored.size} frozen={stored.frozen} onChangeSize={() => startOpen("change", null)} readOnly={!p.canEdit} />}
      {notice !== null && (
        <p role="status" data-testid="online-package-notice" className="min-w-0 text-xs text-slate-700 [overflow-wrap:anywhere]">
          {notice}
        </p>
      )}
      {open !== null && p.canEdit && (
        <OnlineReceipt
          key={open.n}
          mode={open.mode}
          facts={{ planCap: p.planCap, held: p.held, rounds: p.rounds, cameras: p.cameras, paid: stored.paid, storedSize: stored.size, viewerPlan: p.viewerPlan }}
          size={open.size}
          quote={null}
          readQuote={readQuote}
          onConfirm={onConfirm}
          renderBuy={({ pack, size }) =>
            p.buy === null ? (
              <a href={p.buyMoreHref} className="font-medium text-purple-700 underline" data-testid="online-receipt-buy-link">
                {msg("stream.phone.buyMore")}
              </a>
            ) : (
              <BuyStreamCredits orgId={p.buy.orgId} currency={p.buy.currency} preselect={pack} returnTo={{ divisionId, size }} />
            )
          }
          onClose={() => setOpen(null)}
        />
      )}
    </div>
  );
}
