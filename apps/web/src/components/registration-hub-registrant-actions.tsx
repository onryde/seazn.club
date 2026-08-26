"use client";

// Registration hub — Registrants tab, the row-expand detail's mutating
// action controls (RS005 W3). The SECOND client island in this row family,
// after the join-code copy control (registration-hub-registrant-join-code.tsx,
// W2b) — everything around it (the row's <details>, the rest of the detail
// body) stays a plain server component, same zero-client-JS-by-default
// posture W2a established. This file imports no i18n of its own beyond
// useMsg() (client-safe — see its own header on why importing "@/lib/i18n"
// here instead would crash the client bundle, RS004's own bug).
//
// canEdit is NOT a prop here: the caller (registration-hub-registrant-
// detail.tsx) only mounts this island at all when canEdit is true — exactly
// the join-code control's own convention, so a viewer's bundle never even
// reaches this file's code, not merely a disabled button (owner ruling,
// 2026-08-25: mutating controls are ABSENT for a viewer).
//
// Legality (which of the SIX buttons render) is a pure function of the
// row's OWN status/approval/amount_cents/payment_intent_id
// (deriveRegistrantActionFlags, registration-hub-registrant-derive.ts) —
// never re-derived here by hand, so this component and its
// completeness-tested pure sibling can't drift the way
// REGISTRANT_STATUS_STYLE's hand-kept list once did (RS005 W1a).
//
// "Optimistic where safe, with rollback on 4xx" (owner ruling): approve,
// reject, withdraw and (RS005 R1) markPaid each have exactly ONE possible
// resulting status (registration-approval.ts / registrations.ts —
// confirmed, rejected, withdrawn, confirmed respectively — markPaid
// confirms/materialises in the SAME server call rather than stopping at an
// intermediate 'paid', see markPaid() below), so `runStatusAction` flips
// `optimisticStatus` to that value the instant the click is confirmed — the
// row's OWN visible controls (derived off that same optimisticStatus, not
// off the original prop) update immediately, before the network round trip
// even starts — and REVERTS it on a 4xx, surfacing the server's own English
// error text (this repo never translates thrown messages; the surrounding
// button/confirm copy is translated). Promote's resulting status depends on
// the division's settings (fee/approval mode) and is NOT safe to guess, so
// it gets a narrower optimistic treatment: `promotedOptimistically` hides
// the button the instant it's clicked, without asserting a specific next
// status; `router.refresh()` brings the real one, and the prop-sync
// render-time adjustment below reconciles `optimisticStatus` (and clears
// the promote guard) once it lands.
//
// RS005 R1 whole-branch review MAJOR (finding 2): a 4xx's revert used to
// restore whatever `optimisticStatus` held at CLICK time
// (`const previous = optimisticStatus`) — a plain closure capture, frozen
// for the life of that async call. If a `router.refresh()` fired by ANY
// other row's action on the same page, or a second organiser editing this
// exact row, lands a fresher `status` prop while the request is still in
// flight, the render-time adjustment below already moves `optimisticStatus`
// to that fresh value — and the OLD revert then clobbered it straight back
// to the stale click-time snapshot the instant the request failed, showing
// an organiser a status the server had already moved past. `latestStatusRef`
// fixes this the way a "latest ref" fixes any stale-closure read in React:
// it is reassigned unconditionally every render (a plain mutation, not a
// state update — triggers no re-render, so this is NOT the reintroduced-
// effect trap W2c/W3 already removed), and because a ref is the SAME object
// across renders, a stale closure's `.current` read always sees whatever
// the MOST RECENT render wrote, not what was there when the closure was
// created. The revert path reads `latestStatusRef.current` instead of a
// click-time snapshot, so a failure always restores the server's latest
// known truth for this row.
//
// Reject and withdraw confirm first — both are destructive: reject is
// TERMINAL (no path returns a rejected entry to any other status) and
// withdraw frees the spot and can trigger a refund. markPaid (RS005 R1)
// also confirms first, despite not being destructive in that sense: it is
// an explicit, logged payment attestation that immediately materialises the
// entrant with no undo path afterward other than withdraw (rejecting a
// 'confirmed' row 422s) — reusing the pre-existing, purpose-built
// confirm.markPaidRegistration copy (scaffolded for this exact action,
// never previously wired to any component). Approve, promote and resend do
// not confirm (owner ruling).
import { useRef, useState, useEffect } from "react";
import { useRouter } from "next/navigation";
import { apiV1 } from "@/lib/client-v1";
import { useConfirm } from "@/components/ui/confirm-provider";
import { useMsg } from "@/components/i18n/dict-provider";
import { deriveRegistrantActionFlags } from "@/components/registration-hub-registrant-derive";
import type { RegistrationListRow } from "@/server/usecases/registrations";

type Status = RegistrationListRow["status"];
type ActionKey = "approve" | "reject" | "withdraw" | "promote" | "resend" | "mark-paid";

export interface RegistrationHubRegistrantActionsProps {
  registrationId: string;
  status: Status;
  approval: RegistrationListRow["approval"];
  /** This entry's OWN quoted fee (RegistrationRow.amount_cents, frozen at
   *  submission) — the fee signal deriveRegistrantActionFlags uses as a
   *  stand-in for the division's live registration_settings.fee_cents
   *  (registration-approval.ts:128, registrations.ts:3111-3114's real
   *  gates): this component only ever receives ONE row, never the
   *  division's settings. See that function's own doc comment for exactly
   *  when the two can diverge. */
  amountCents: number;
  /** The CART's payment_intent_id (RegistrationWithGroupRow) — set once a
   *  card payment lands, shared by every entry in the cart, null for an
   *  offline/unpaid one. Both the approve-awaiting-payment exclusion and
   *  the markPaid gate key off this being null. */
  paymentIntentId: string | null;
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export function RegistrationHubRegistrantActions({
  registrationId,
  status,
  approval,
  amountCents,
  paymentIntentId,
}: RegistrationHubRegistrantActionsProps) {
  const msg = useMsg();
  const router = useRouter();
  const confirmDialog = useConfirm();
  const [optimisticStatus, setOptimisticStatus] = useState<Status>(status);
  const [promotedOptimistically, setPromotedOptimistically] = useState(false);
  const [busy, setBusy] = useState<ActionKey | null>(null);
  const [feedback, setFeedback] = useState<{ tone: "success" | "error"; text: string } | null>(null);

  // Re-syncs to the server's own truth once router.refresh() lands a fresh
  // `status` prop. The four deterministic actions already guessed right, so
  // this is a no-op for them; promote's un-guessed case is the one this is
  // load-bearing for — it's also what clears promotedOptimistically once the
  // real post-promotion status has actually arrived.
  //
  // Adjusted DURING RENDER rather than in an effect (React's own
  // "adjusting state when a prop changes" pattern). The effect form
  // rendered the stale optimistic status once, then re-rendered with the
  // server's — a visible flash of the guessed state after the truth had
  // already arrived, and a cascading-render lint error besides. Comparing
  // against the last-seen prop lets the corrected value render first time.
  const [lastStatus, setLastStatus] = useState<Status>(status);
  if (lastStatus !== status) {
    setLastStatus(status);
    setOptimisticStatus(status);
    setPromotedOptimistically(false);
  }

  // RS005 R1 finding 2 — see the file header. Mirrors the latest `status`
  // PROP by mutation (not a new closure) every render, so runStatusAction's
  // `catch` — created by whichever render was live at CLICK time — can
  // still read what the server most recently said, rather than resurrecting
  // a value frozen at click time. Read only from that catch, below.
  const latestStatusRef = useRef(status);
  // Synced in an EFFECT, not by mutating during render. Assigning to a ref
  // while rendering is unsafe under concurrent rendering (React may render a
  // component without committing it), and the lint rule that flags it —
  // "Cannot access refs during render" — is pointing at that, not at style.
  // An effect commits before the user can click anything, so the catch below
  // still reads the freshest status the server has actually delivered.
  useEffect(() => {
    latestStatusRef.current = status;
  }, [status]);

  const flags = deriveRegistrantActionFlags({
    status: optimisticStatus,
    approval,
    amount_cents: amountCents,
    payment_intent_id: paymentIntentId,
  });

  async function runStatusAction(
    action: "approve" | "reject" | "withdraw" | "mark-paid",
    path: string,
    nextStatus: Status,
    successText: string,
  ) {
    setBusy(action);
    setFeedback(null);
    setOptimisticStatus(nextStatus);
    try {
      await apiV1(`/api/v1/registrations/${registrationId}/${path}`, { method: "POST" });
      setFeedback({ tone: "success", text: successText });
      router.refresh();
    } catch (err) {
      // Latest known server truth, never the click-time snapshot — finding 2.
      setOptimisticStatus(latestStatusRef.current);
      setFeedback({ tone: "error", text: errorText(err) });
    } finally {
      setBusy(null);
    }
  }

  async function approve() {
    await runStatusAction("approve", "approve", "confirmed", msg("reg.hub.registrants.detail.actions.approved"));
  }

  async function reject() {
    const ok = await confirmDialog({
      title: msg("reg.hub.registrants.detail.actions.confirmReject.title"),
      body: msg("reg.hub.registrants.detail.actions.confirmReject.body"),
      confirmLabel: msg("reg.hub.registrants.detail.actions.confirmReject.confirm"),
      tone: "danger",
    });
    if (!ok) return;
    await runStatusAction("reject", "reject", "rejected", msg("reg.hub.registrants.status.rejected"));
  }

  async function withdraw() {
    const ok = await confirmDialog({
      title: msg("reg.hub.registrants.detail.actions.confirmWithdraw.title"),
      body: msg("reg.hub.registrants.detail.actions.confirmWithdraw.body"),
      confirmLabel: msg("reg.hub.registrants.detail.actions.confirmWithdraw.confirm"),
      tone: "danger",
    });
    if (!ok) return;
    await runStatusAction("withdraw", "withdraw", "withdrawn", msg("reg.hub.registrants.status.withdrawn"));
  }

  // RS005 R1 — reuses confirm.markPaidRegistration's pre-existing copy
  // (scaffolded for this exact action, never previously wired to any
  // component — see the file header) rather than minting new strings: the
  // real-world consequence it describes ("Records that you received the
  // fee outside the app... and confirms the entry. This is logged.") is
  // identical regardless of which surface triggers markRegistrationPaidOffline.
  async function markPaid() {
    const ok = await confirmDialog({
      title: msg("confirm.markPaidRegistration.title"),
      body: msg("confirm.markPaidRegistration.body"),
      confirmLabel: msg("confirm.markPaidRegistration.label"),
      tone: "default",
    });
    if (!ok) return;
    await runStatusAction(
      "mark-paid",
      "mark-paid",
      "confirmed",
      msg("reg.hub.registrants.detail.actions.markedPaid"),
    );
  }

  async function promote() {
    setBusy("promote");
    setFeedback(null);
    setPromotedOptimistically(true);
    try {
      // Explicit registration_id override: THIS row promotes, never
      // whichever entry promoteFromWaitlist's default (oldest-waitlisted)
      // would otherwise pick — the button is "promote this entry", not
      // "promote whoever's next".
      await apiV1(`/api/v1/registrations/${registrationId}/promote`, {
        method: "POST",
        json: { registration_id: registrationId },
      });
      setFeedback({ tone: "success", text: msg("reg.hub.registrants.detail.actions.promoted") });
      router.refresh();
    } catch (err) {
      setPromotedOptimistically(false);
      setFeedback({ tone: "error", text: errorText(err) });
    } finally {
      setBusy(null);
    }
  }

  async function resend() {
    setBusy("resend");
    setFeedback(null);
    try {
      const result = await apiV1<{ sent: boolean }>(
        `/api/v1/registrations/${registrationId}/resend-confirmation`,
        { method: "POST" },
      );
      // task 3: "sent" must read as visibly different from "nothing
      // happened" — sent:false (buildCartMail found nothing to send) is
      // its OWN distinct, translated message, never silently indistinguishable
      // from a real send.
      setFeedback(
        result.sent
          ? { tone: "success", text: msg("reg.hub.registrants.detail.actions.resent") }
          : { tone: "error", text: msg("reg.hub.registrants.detail.actions.resendNotSent") },
      );
    } catch (err) {
      setFeedback({ tone: "error", text: errorText(err) });
    } finally {
      setBusy(null);
    }
  }

  return (
    <div data-registration-hub-registrant-actions className="flex flex-col gap-2">
      <div className="flex flex-wrap items-center gap-2">
        {flags.canMarkPaid && (
          <button
            type="button"
            data-registration-hub-registrant-action="mark-paid"
            disabled={busy !== null}
            onClick={markPaid}
            className="btn btn-primary text-xs"
          >
            {busy === "mark-paid"
              ? msg("reg.hub.registrants.detail.actions.markingPaid")
              : msg("reg.hub.registrants.detail.actions.markPaid")}
          </button>
        )}
        {flags.canApprove && (
          <button
            type="button"
            data-registration-hub-registrant-action="approve"
            disabled={busy !== null}
            onClick={approve}
            className="btn btn-primary text-xs"
          >
            {busy === "approve"
              ? msg("reg.hub.registrants.detail.actions.approving")
              : msg("reg.hub.registrants.detail.actions.approve")}
          </button>
        )}
        {flags.canReject && (
          <button
            type="button"
            data-registration-hub-registrant-action="reject"
            disabled={busy !== null}
            onClick={reject}
            className="btn btn-danger text-xs"
          >
            {busy === "reject"
              ? msg("reg.hub.registrants.detail.actions.rejecting")
              : msg("reg.hub.registrants.detail.actions.reject")}
          </button>
        )}
        {flags.canPromote && !promotedOptimistically && (
          <button
            type="button"
            data-registration-hub-registrant-action="promote"
            disabled={busy !== null}
            onClick={promote}
            className="btn btn-ghost text-xs"
          >
            {busy === "promote"
              ? msg("reg.hub.registrants.detail.actions.promoting")
              : msg("reg.hub.registrants.detail.actions.promote")}
          </button>
        )}
        {flags.canWithdraw && (
          <button
            type="button"
            data-registration-hub-registrant-action="withdraw"
            disabled={busy !== null}
            onClick={withdraw}
            className="btn btn-danger text-xs"
          >
            {busy === "withdraw"
              ? msg("reg.hub.registrants.detail.actions.withdrawing")
              : msg("reg.hub.registrants.detail.actions.withdraw")}
          </button>
        )}
        {flags.canResend && (
          <button
            type="button"
            data-registration-hub-registrant-action="resend"
            disabled={busy !== null}
            onClick={resend}
            className="btn btn-ghost text-xs"
          >
            {busy === "resend"
              ? msg("reg.hub.registrants.detail.actions.resending")
              : msg("reg.hub.registrants.detail.actions.resend")}
          </button>
        )}
      </div>
      {feedback && (
        <p
          role="status"
          aria-live="polite"
          data-registration-hub-registrant-actions-feedback
          data-tone={feedback.tone}
          className={feedback.tone === "success" ? "text-xs font-medium text-green-700" : "text-xs font-medium text-red-600"}
        >
          {feedback.text}
        </p>
      )}
    </div>
  );
}
