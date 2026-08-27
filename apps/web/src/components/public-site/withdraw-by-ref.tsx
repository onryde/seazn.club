"use client";

// Self-withdraw from /r/[ref] (v3/05 §3). The ref is a lookup, not auth —
// the emailed token rides along and the server re-checks it.
//
// RS006 follow-up (data-integrity fix): a cart can hold more than one entry,
// and this used to act on WHATEVER entry the server silently picked (the
// oldest) — one control for the whole cart, no way to tell which row a click
// would target. Withdraw is per-entry now: one <WithdrawByRef> instance per
// withdrawable entry, each naming its OWN entryId, so the button next to
// "Doubles" only ever withdraws Doubles.
import { useState } from "react";
import { useRouter } from "next/navigation";
import { apiV1 } from "@/lib/client-v1";
import { useConfirm } from "@/components/ui/confirm-provider";
import { useMsg } from "@/components/i18n/dict-provider";

export function WithdrawByRef({
  refCode,
  token,
  entryId,
  divisionName,
}: {
  refCode: string;
  token: string;
  /** THIS entry only — the server independently verifies it belongs to
   *  refCode's own group before withdrawing anything (never trusted alone). */
  entryId: string;
  /** Named in the confirm dialog and the button itself so a multi-entry
   *  cart is never ambiguous about which entry is about to go. */
  divisionName: string;
}) {
  const msg = useMsg();
  const router = useRouter();
  const confirmDialog = useConfirm();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function withdraw() {
    const ok = await confirmDialog({
      title: msg("confirm.withdrawCartEntry.title", { division: divisionName }),
      body: msg("confirm.withdrawCartEntry.body", { division: divisionName }),
      confirmLabel: msg("confirm.withdrawOwnRegistration.label"),
      tone: "danger",
    });
    if (!ok) return;
    setBusy(true);
    setError(null);
    try {
      await apiV1(`/api/v1/public/registrations/by-ref/${encodeURIComponent(refCode)}/withdraw`, {
        method: "POST",
        json: { token, registration_id: entryId },
      });
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Withdraw failed");
    } finally {
      setBusy(false);
    }
  }

  return (
    <span className="inline-flex items-center gap-2">
      <button
        type="button"
        disabled={busy}
        onClick={() => void withdraw()}
        className="rounded-md border border-red-200 px-3 py-1.5 text-xs text-red-600 hover:border-red-400 disabled:opacity-50"
      >
        {busy ? msg("registration.withdrawing") : msg("registration.withdrawEntryFor", { division: divisionName })}
      </button>
      {error && <span className="text-xs text-red-600">{error}</span>}
    </span>
  );
}
