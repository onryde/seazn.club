"use client";

// Resumes/mints Stripe checkout for exactly ONE entry — the same
// resumeRegistrationCheckout works whether it is a fresh pending entry or a
// waitlist-promoted one (RS007 §2).
import { useState } from "react";
import { apiV1 } from "@/lib/client-v1";
import { useMsg } from "@/components/i18n/dict-provider";
import { publicCheckoutPath } from "./view-model";

export function PayButton({
  entryId,
  token,
  label,
}: {
  entryId: string;
  token: string;
  /** Pre-translated, amount included ("Pay now — £25.00") — the amount is
   *  resolved server-side alongside the currency/locale it needs. */
  label?: string;
}) {
  const msg = useMsg();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function pay() {
    setBusy(true);
    setError(null);
    try {
      const { checkout_url } = await apiV1<{ checkout_url: string }>(publicCheckoutPath(entryId), {
        method: "POST",
        json: { token },
      });
      window.location.assign(checkout_url);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Payment failed to start");
      setBusy(false);
    }
  }

  return (
    <div>
      <button
        type="button"
        disabled={busy}
        onClick={pay}
        className="rounded-lg bg-accent px-4 py-2 text-sm font-semibold text-white shadow-sm transition hover:opacity-90 disabled:opacity-50"
      >
        {busy ? msg("register.status.pay.busy") : (label ?? msg("register.status.pay.ctaFallback"))}
      </button>
      {error && <p className="mt-1.5 text-xs text-red-600">{error}</p>}
    </div>
  );
}
