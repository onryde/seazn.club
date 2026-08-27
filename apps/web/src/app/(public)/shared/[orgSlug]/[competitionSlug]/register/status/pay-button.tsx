"use client";

// Resumes/mints Stripe checkout for exactly ONE entry — the same
// resumeRegistrationCheckout works whether it is a fresh pending entry or a
// waitlist-promoted one (RS007 §2).
//
// Failure copy (RS007 i18n follow-up, audit finding): PRIMARY is always the
// localized, HTTP-status-classified message (classifyStatusActionFailure,
// view-model.ts) — never `err.message` verbatim, which is un-localized
// English straight off the server (client-v1.ts's own doc comment). The raw
// detail is kept as SECONDARY, de-emphasized text (register-stepper.tsx's
// FIX 3 convention — the chosen convention for all three status-page action
// buttons): none of resumeRegistrationCheckout's own thrown messages embed
// the access token or any other secret (verified directly), so it is safe,
// useful extra color, never the primary thing read.
import { useState } from "react";
import { apiV1, ApiV1Error } from "@/lib/client-v1";
import { useMsg } from "@/components/i18n/dict-provider";
import type { MessageKey } from "@/lib/messages";
import { classifyStatusActionFailure, publicCheckoutPath, type StatusActionFailureKind } from "./view-model";

/** Mirrors join-form.tsx's own FAILURE_KEY convention — an explicit map, so
 *  a bucket can never silently point at a key that doesn't exist (typed
 *  against MessageKey, not string, so a typo is a tsc error, not a runtime
 *  miss). `notFound` reuses the page's own initial-load key — see
 *  classifyStatusActionFailure's doc comment for why. `conflict` is the ONE
 *  bucket genuinely reachable here today: resumeRegistrationCheckout's own
 *  createRegistrationCheckout throws exactly this 409
 *  (REGISTRATION_CHECKOUT_CONFLICT) on a losing checkout-mint race. */
const FAILURE_KEY: Record<StatusActionFailureKind, MessageKey> = {
  notFound: "register.status.notFound",
  conflict: "register.status.pay.error.conflict",
  rateLimited: "register.status.action.rateLimited",
  generic: "register.status.pay.error.generic",
};

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
  const [error, setError] = useState<{ kind: StatusActionFailureKind; detail: string } | null>(null);

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
      const status = err instanceof ApiV1Error ? err.status : undefined;
      setError({
        kind: classifyStatusActionFailure(status),
        detail: err instanceof Error ? err.message : String(err),
      });
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
      {error && (
        <div className="mt-1.5 space-y-0.5">
          <p className="text-xs text-red-600">{msg(FAILURE_KEY[error.kind])}</p>
          <p className="text-xs text-ink-muted">{error.detail}</p>
        </div>
      )}
    </div>
  );
}
