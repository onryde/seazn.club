"use client";

// Cancel one entry (RS007 §4) — CRITICAL: posts to the public/withdrawCore
// path (withdrawRegistrationPublic, actorId: null) via publicWithdrawPath,
// never the organiser-only /api/v1/registrations/{id}/withdraw
// (withdrawRegistrationOrganiser). The confirm step states which side of the
// refund line this entry sits on BEFORE the click commits — read from
// refund_policy, never invented copy that promises a refund the policy does
// not (RS007 §3).
import { useState } from "react";
import { useRouter } from "next/navigation";
import { apiV1 } from "@/lib/client-v1";
import { useConfirm } from "@/components/ui/confirm-provider";
import { useMsg } from "@/components/i18n/dict-provider";
import { publicWithdrawPath } from "./view-model";

export function CancelEntry({
  entryId,
  token,
  divisionName,
  refundable,
  refundAmountFormatted,
}: {
  entryId: string;
  token: string;
  divisionName: string;
  refundable: boolean;
  /** This entry's own remaining refund_policy.amount_cents, already
   *  formatted in the cart's currency/locale — only shown when refundable. */
  refundAmountFormatted: string;
}) {
  const msg = useMsg();
  const router = useRouter();
  const confirmDialog = useConfirm();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function cancel() {
    const ok = await confirmDialog({
      title: msg("confirm.cancelEntry.title", { division: divisionName }),
      body: refundable
        ? msg("confirm.cancelEntry.bodyRefundable", { amount: refundAmountFormatted })
        : msg("confirm.cancelEntry.bodyDiscretion"),
      confirmLabel: msg("confirm.cancelEntry.label"),
      tone: "danger",
    });
    if (!ok) return;
    setBusy(true);
    setError(null);
    try {
      await apiV1(publicWithdrawPath(entryId), { method: "POST", json: { token } });
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Cancel failed");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div>
      <button
        type="button"
        disabled={busy}
        onClick={cancel}
        className="rounded-lg border border-red-200 px-3 py-1.5 text-xs font-medium text-red-600 transition hover:border-red-400 disabled:opacity-50"
      >
        {busy ? msg("register.status.cancel.busy") : msg("register.status.cancel.cta")}
      </button>
      {error && <p className="mt-1.5 text-xs text-red-600">{error}</p>}
    </div>
  );
}
