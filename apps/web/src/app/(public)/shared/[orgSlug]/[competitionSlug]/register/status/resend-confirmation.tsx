"use client";

// Resend the cart's confirmation email (RS007 §6) — GROUP-scoped (rid), not
// per-entry: the mail itself is cart-shaped (buildCartMail), same as the
// organiser's own resend.
import { useState } from "react";
import { apiV1 } from "@/lib/client-v1";
import { useMsg } from "@/components/i18n/dict-provider";
import { publicResendPath } from "./view-model";

export function ResendConfirmation({ groupId, token }: { groupId: string; token: string }) {
  const msg = useMsg();
  const [busy, setBusy] = useState(false);
  const [sent, setSent] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function resend() {
    setBusy(true);
    setError(null);
    try {
      await apiV1<{ sent: boolean }>(publicResendPath(groupId), { method: "POST", json: { token } });
      setSent(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't resend the confirmation email");
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
      {error && <p className="mt-1 text-xs text-red-600">{error}</p>}
    </div>
  );
}
