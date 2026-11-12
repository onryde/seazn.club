"use client";

// Registrant self-service actions (token-authenticated): pay a due entry fee
// (fresh or waitlist-promoted registrations) and withdraw.
import { useState } from "react";
import { useRouter } from "next/navigation";
import { apiV1 } from "@/lib/client-v1";
import { useConfirm } from "@/components/ui/confirm-provider";
import { useMsg } from "@/components/i18n/dict-provider";
import { TurnstileWidget, useTurnstile } from "@/components/turnstile-widget";
import { isTurnstileRefusal } from "@/lib/turnstile";
import { withTurnstile } from "@/lib/turnstile-client";

export function RegistrationActions({
  registrationId,
  token,
  status,
  paymentDue,
  payLabel,
}: {
  registrationId: string;
  token: string;
  status: string;
  paymentDue: boolean;
  payLabel?: string;
}) {
  const msg = useMsg();
  const router = useRouter();
  const confirmDialog = useConfirm();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Withdraw is bot-checked (pay is not: it only mints a checkout for a token the caller already holds). Mounted by the click,
  // before the confirm dialog, so the invisible check runs while the person reads it.
  const turnstile = useTurnstile("withdraw");
  const [armed, setArmed] = useState(false);

  async function pay() {
    setBusy(true);
    setError(null);
    try {
      const { checkout_url } = await apiV1<{ checkout_url: string }>(
        `/api/v1/public/registrations/${registrationId}/checkout`,
        { method: "POST", json: { token } },
      );
      window.location.assign(checkout_url);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Payment failed to start");
      setBusy(false);
    }
  }

  async function withdraw() {
    setArmed(true);
    const ok = await confirmDialog({
      title: msg("confirm.withdrawOwnRegistration.title"),
      body: msg("confirm.withdrawOwnRegistration.body"),
      confirmLabel: msg("confirm.withdrawOwnRegistration.label"),
      tone: "danger",
    });
    if (!ok) return;
    setBusy(true);
    setError(null);
    try {
      await withTurnstile(turnstile, (headers) =>
        apiV1(`/api/v1/public/registrations/${registrationId}/withdraw`, {
          method: "POST",
          json: { token },
          headers,
        }),
      );
      router.refresh();
    } catch (err) {
      setError(isTurnstileRefusal(err) ? msg("turnstile.error") : err instanceof Error ? err.message : "Withdraw failed");
    } finally {
      setBusy(false);
    }
  }

  if (status === "withdrawn" || status === "expired") return null;

  return (
    <>
      {paymentDue && (
        <button
          type="button"
          disabled={busy}
          onClick={pay}
          className="rounded-md bg-zinc-900 px-4 py-2 text-sm font-medium text-white hover:bg-zinc-700 disabled:opacity-50"
        >
          {payLabel ?? msg("registration.payFallback")}
        </button>
      )}
      <button
        type="button"
        disabled={busy}
        onClick={withdraw}
        className="rounded-md border border-red-200 px-4 py-2 text-sm text-red-600 hover:border-red-400 disabled:opacity-50"
      >
        {msg("registration.withdraw")}
      </button>
      {armed && <TurnstileWidget controller={turnstile} className="basis-full" />}
      {error && <p className="w-full text-sm text-red-600">{error}</p>}
    </>
  );
}
