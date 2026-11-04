"use client";

// Cancel one entry (RS007 §4) — CRITICAL: posts to the public/withdrawCore
// path (withdrawRegistrationPublic, actorId: null) via publicWithdrawPath,
// never the organiser-only /api/v1/registrations/{id}/withdraw
// (withdrawRegistrationOrganiser). The confirm step states which side of the
// refund line this entry sits on BEFORE the click commits — read from
// refund_policy, never invented copy that promises a refund the policy does
// not (RS007 §3).
//
// Failure copy (RS007 i18n follow-up, audit finding): PRIMARY is always the
// localized, HTTP-status-classified message (classifyStatusActionFailure,
// view-model.ts) — never `err.message` verbatim, which is un-localized
// English straight off the server (client-v1.ts's own doc comment). The raw
// detail is kept as SECONDARY, de-emphasized text (register-stepper.tsx's
// FIX 3 convention — the chosen convention for all three status-page action
// buttons): none of withdrawCore's own thrown messages embed the access
// token or any other secret (verified directly), so it is safe, useful
// extra color, never the primary thing read.
import { useState } from "react";
import { useRouter } from "next/navigation";
import { apiV1, ApiV1Error } from "@/lib/client-v1";
import { useConfirm } from "@/components/ui/confirm-provider";
import { useMsg } from "@/components/i18n/dict-provider";
import type { MessageKey } from "@/lib/messages";
import { classifyStatusActionFailure, publicWithdrawPath, type StatusActionFailureKind } from "./view-model";

/** Mirrors join-form.tsx's own FAILURE_KEY convention — an explicit map, so
 *  a bucket can never silently point at a key that doesn't exist (typed
 *  against MessageKey, not string, so a typo is a tsc error, not a runtime
 *  miss). `notFound` reuses the page's own initial-load key — see
 *  classifyStatusActionFailure's doc comment for why. */
const FAILURE_KEY: Record<StatusActionFailureKind, MessageKey> = {
  notFound: "register.status.notFound",
  conflict: "register.status.cancel.error.conflict",
  rateLimited: "register.status.action.rateLimited",
  generic: "register.status.cancel.error.generic",
};

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
  const [error, setError] = useState<{ kind: StatusActionFailureKind; detail: string } | null>(null);

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
        onClick={cancel}
        className="rounded-lg border border-red-200 px-3 py-1.5 text-xs font-medium text-red-600 transition hover:border-red-400 disabled:opacity-50"
      >
        {busy ? msg("register.status.cancel.busy") : msg("register.status.cancel.cta")}
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
