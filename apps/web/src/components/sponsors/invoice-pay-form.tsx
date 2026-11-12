"use client";
// components/sponsors/invoice-pay-form.tsx - the invoice page's "Pay by card" form (sponsor deals, Task 23 carry 2): a plain
// POST to `/r/sponsor/invoice/<token>/pay`, which answers with a redirect to Stripe Checkout. The one thing it adds to the form
// the server page drew before: a double click sends ONE post. The first submit goes through and disables the button; any later
// one is cancelled. The guard is a ref, not the state: a second click can land before the re-render that disables the button.
//
// Back from Stripe, a browser may restore this page from its back-forward cache with the button still disabled; `pageshow`
// with `persisted` re-arms it, or a sponsor who backed out of Checkout could never pay.
//
// `action` carries the invoice token (a bearer credential), so the form is `ph-no-capture` (lib/__tests__/
// scrub-secret-painters.test.ts). `label` and `note` are the page's resolved copy in the org's language.
import { useEffect, useRef, useState, type FormEvent } from "react";

export function InvoicePayForm({ action, label, note }: { action: string; label: string; note: string }) {
  const sent = useRef(false);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    const rearm = (e: PageTransitionEvent) => {
      if (!e.persisted) return;
      sent.current = false;
      setBusy(false);
    };
    window.addEventListener("pageshow", rearm);
    return () => window.removeEventListener("pageshow", rearm);
  }, []);
  const onSubmit = (e: FormEvent<HTMLFormElement>) => {
    if (sent.current) {
      e.preventDefault();
      return;
    }
    sent.current = true;
    setBusy(true);
  };
  return (
    <form method="post" action={action} onSubmit={onSubmit} data-testid="invoice-pay" className="ph-no-capture min-w-0 print:hidden">
      <button type="submit" disabled={busy} aria-busy={busy} className="btn btn-primary w-full sm:w-auto">
        {label}
      </button>
      <p className="mt-2 text-xs text-ink-muted">{note}</p>
    </form>
  );
}
