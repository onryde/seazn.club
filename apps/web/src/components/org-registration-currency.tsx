"use client";

// The currency an ENTRANT is quoted and charged (organizations.currency, V365).
//
// Not the billing currency. That one belongs to the subscription, is resolved
// by preferredCurrency(), and never changes on renewal — the picker directly
// above this one in Preferences only moves what the ORGANISER browses in. This
// column is the other side of the business: one currency per org, snapshotted
// onto each cart at submit so a later change never rewrites what an already
// submitted registration was charged in.
//
// Two states, and the locked one is the interesting half. While a Stripe
// Connect account is attached, V365's same-currency rule pins this column to
// that account's settlement currency and syncConnectAccount re-mirrors it on
// every sync — so a change accepted here would be silently reverted by the
// next webhook. The control is disabled and says why, and the API refuses the
// write too (409) rather than trusting the UI to be the gate.
import { useState } from "react";
import { useRouter } from "next/navigation";
import { REGISTRATION_CURRENCIES, type Currency } from "@/lib/currency";
import { useMsg } from "@/components/i18n/dict-provider";

const LABELS: Record<Currency, string> = {
  usd: "$ USD",
  eur: "€ EUR",
  gbp: "£ GBP",
  inr: "₹ INR",
};

export function OrgRegistrationCurrency({
  orgId,
  initialCurrency,
  /** Non-null while a Connect account is attached — the settlement currency
   *  this column is pinned to, or the raw unsupported code when the account
   *  settles outside the platform allowlist. */
  lockedTo,
}: {
  orgId: string;
  initialCurrency: Currency;
  lockedTo: string | null;
}) {
  const msg = useMsg();
  const router = useRouter();
  const [value, setValue] = useState<Currency>(initialCurrency);
  const [saved, setSaved] = useState<Currency>(initialCurrency);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function save() {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/orgs/${orgId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ currency: value }),
      });
      if (!res.ok) {
        const d = await res.json().catch(() => ({}));
        throw new Error(d.error ?? msg("settings.saveFailed"));
      }
      setSaved(value);
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : msg("settings.saveFailed"));
    } finally {
      setBusy(false);
    }
  }

  const locked = lockedTo !== null;

  return (
    <div className="space-y-2">
      <p className="text-sm text-slate-500">{msg("settings.org.regCurrency.desc")}</p>
      <div className="flex flex-wrap items-center gap-3">
        <select
          className="input min-h-11 w-auto"
          data-testid="reg-currency-select"
          aria-label={msg("settings.org.regCurrency.aria")}
          value={value}
          disabled={locked}
          onChange={(e) => setValue(e.target.value as Currency)}
        >
          {REGISTRATION_CURRENCIES.map((c) => (
            <option key={c} value={c}>
              {LABELS[c]}
            </option>
          ))}
        </select>
        {!locked && (
          <button
            type="button"
            onClick={save}
            disabled={value === saved || busy}
            className="btn btn-primary"
          >
            {busy ? msg("settings.saving") : msg("settings.org.save")}
          </button>
        )}
      </div>
      {locked && (
        <p className="text-xs text-slate-500">
          {msg("settings.org.regCurrency.locked", { currency: lockedTo.toUpperCase() })}
        </p>
      )}
      {error && <p className="text-sm text-red-600">{error}</p>}
    </div>
  );
}
