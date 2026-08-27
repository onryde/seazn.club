"use client";

// Resend the cart's confirmation email (RS007 §6) — GROUP-scoped (rid), not
// per-entry: the mail itself is cart-shaped (buildCartMail), same as the
// organiser's own resend.
//
// Failure copy (RS007 i18n follow-up, audit finding): PRIMARY is always the
// localized, HTTP-status-classified message (classifyStatusActionFailure,
// view-model.ts) — never `err.message` verbatim, which is un-localized
// English straight off the server (client-v1.ts's own doc comment). The raw
// detail is kept as SECONDARY, de-emphasized text (register-stepper.tsx's
// FIX 3 convention — the chosen convention for all three status-page action
// buttons): none of resendRegistrationConfirmationPublic's own thrown
// messages embed the access token or any other secret (verified directly),
// so it is safe, useful extra color, never the primary thing read.
import { useState } from "react";
import { apiV1, ApiV1Error } from "@/lib/client-v1";
import { useMsg } from "@/components/i18n/dict-provider";
import type { MessageKey } from "@/lib/messages";
import { classifyStatusActionFailure, publicResendPath, type StatusActionFailureKind } from "./view-model";

/** Mirrors join-form.tsx's own FAILURE_KEY convention — an explicit map, so
 *  a bucket can never silently point at a key that doesn't exist (typed
 *  against MessageKey, not string, so a typo is a tsc error, not a runtime
 *  miss). `notFound` reuses the page's own initial-load key — see
 *  classifyStatusActionFailure's doc comment for why. */
const FAILURE_KEY: Record<StatusActionFailureKind, MessageKey> = {
  notFound: "register.status.notFound",
  conflict: "register.status.resend.error.conflict",
  rateLimited: "register.status.action.rateLimited",
  generic: "register.status.resend.error.generic",
};

export function ResendConfirmation({ groupId, token }: { groupId: string; token: string }) {
  const msg = useMsg();
  const [busy, setBusy] = useState(false);
  const [sent, setSent] = useState(false);
  const [error, setError] = useState<{ kind: StatusActionFailureKind; detail: string } | null>(null);

  async function resend() {
    setBusy(true);
    setError(null);
    try {
      await apiV1<{ sent: boolean }>(publicResendPath(groupId), { method: "POST", json: { token } });
      setSent(true);
    } catch (err) {
      const status = err instanceof ApiV1Error ? err.status : undefined;
      setError({
        kind: classifyStatusActionFailure(status),
        detail: err instanceof Error ? err.message : String(err),
      });
    } finally {
      setBusy(false);
    }
  }

  return (
    <div>
      <button
        type="button"
        disabled={busy}
        onClick={resend}
        className="text-xs font-medium text-ink-muted underline underline-offset-2 hover:text-accent-strong disabled:opacity-50"
      >
        {busy ? msg("register.status.resend.busy") : msg("register.status.resend.cta")}
      </button>
      {sent && <p className="mt-1 text-xs text-emerald-700">{msg("register.status.resend.sent")}</p>}
      {error && (
        <div className="mt-1 space-y-0.5">
          <p className="text-xs text-red-600">{msg(FAILURE_KEY[error.kind])}</p>
          <p className="text-xs text-ink-muted">{error.detail}</p>
        </div>
      )}
    </div>
  );
}
