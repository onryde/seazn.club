"use client";
// The "payment received - confirming" island of the player payment page (plan 2026-11-11-player-payment-page, Task 4). The card
// is paid in Stripe and the webhook has not recorded it yet, so the page re-reads itself: `router.refresh()` every 4 s, at most 15
// times (a minute), then a "taking longer" line and no more polling. The page's own server read decides when this unmounts - a
// refresh that finds the entry paid renders the Paid screen instead of this island.
import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";

export const CONFIRM_INTERVAL_MS = 4000;
export const CONFIRM_MAX_REFRESHES = 15;

export function PayPageConfirming({ slowText }: { slowText: string }) {
  const router = useRouter();
  const [slow, setSlow] = useState(false);
  useEffect(() => {
    let refreshes = 0;
    const timer = setInterval(() => {
      if (refreshes >= CONFIRM_MAX_REFRESHES) {
        clearInterval(timer);
        setSlow(true);
        return;
      }
      refreshes++;
      router.refresh();
      if (refreshes >= CONFIRM_MAX_REFRESHES) setSlow(true);
    }, CONFIRM_INTERVAL_MS);
    return () => clearInterval(timer);
  }, [router]);
  return slow ? (
    <p data-testid="pay-confirming-slow" className="mt-3 min-w-0 text-sm break-words text-ink-muted">
      {slowText}
    </p>
  ) : null;
}
