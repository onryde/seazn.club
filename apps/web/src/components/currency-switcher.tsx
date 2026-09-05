"use client";

import { useRouter } from "next/navigation";
import { CURRENCY_COOKIE, SUPPORTED_CURRENCIES, type Currency } from "@/lib/currency";

const LABELS: Record<Currency, string> = {
  usd: "$ USD",
  eur: "€ EUR",
  gbp: "£ GBP",
  inr: "₹ INR",
};

/** Pricing-page currency switcher (v3/07 §4): writes the cookie the checkout
 *  routes honour, then re-renders the server page in the chosen currency. */
export function CurrencySwitcher({
  current,
  /**
   * The select's accessible name, localized by the calling page.
   *
   * It was the literal "Currency" until 2026-09-05 — visible at >= sm beside the
   * switcher on /fr/pricing and /es/pricing, English on both, and invisible to
   * every test in the repo. A REQUIRED prop rather than one defaulting to that
   * literal: the two callers read it from different namespaces
   * (`pricing.currency.label` on the marketing page, `settings.prefs.currency`
   * in Settings), and a default would have been the English fallback that let
   * this sit unnoticed.
   */
  label,
  /**
   * `false` where the surface already prints its own "Currency" heading
   * (Settings → Preferences). The word still ships to assistive tech — it is
   * the select's only accessible name — it just stops appearing twice on
   * screen, one line under the other.
   */
  showLabel = true,
}: {
  current: Currency;
  label: string;
  showLabel?: boolean;
}) {
  const router = useRouter();
  return (
    <label className="inline-flex items-center gap-2 text-sm text-slate-500">
      <span className={showLabel ? "sr-only sm:not-sr-only" : "sr-only"}>{label}</span>
      <select
        value={current}
        data-currency-switcher
        onChange={(e) => {
          document.cookie = `${CURRENCY_COOKIE}=${e.target.value}; path=/; max-age=31536000; samesite=lax`;
          router.refresh();
        }}
        // `.select` (components-layer) sets its own padding, but Tailwind's
        // utilities layer wins, so `py-1.5 text-sm` beside it collapses this
        // under the repo's 44px touch floor — the same override tracked in
        // S13/#422 W11. `min-h-11` survives it; the density recipe stays.
        className="input min-h-11 w-auto py-1.5 text-sm"
      >
        {SUPPORTED_CURRENCIES.map((c) => (
          <option key={c} value={c}>
            {LABELS[c]}
          </option>
        ))}
      </select>
    </label>
  );
}
