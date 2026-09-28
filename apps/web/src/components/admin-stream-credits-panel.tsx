"use client";

// Staff "Match credits" panel (Task 7A, owner ruling 15; Revision 4 — OWNER RULING 2026-09-27,
// owner's word "B") on /admin/orgs/[id]: the org's streaming match-credit balance, ONE "Adjust
// credits" button that opens a Modal carrying the action, the amount, the note and — for a refund
// only — the session id, and the latest ledger rows on a rail below. Posts to
// POST /api/admin/orgs/[id]/stream-credits.
//
// WHY one modal and not three inline cards: the three money verbs sit behind one deliberate open,
// so `revoke` is never a button adjacent to `grant` on a staff page; and it is the shape of the
// ONLY other money panel on this page (components/admin-credits-panel.tsx), so staff learn one
// pattern for both wallets. The rail stays because the page's own Adjustments log shows actor /
// action / category / reason / when / reversible but NOT the delta, the running balance or the
// session link — which is exactly what a linked refund's cap is judged against.
//
// English only: /admin is staff-only and the tree owes it no dictionary keys
// (admin-credits-panel.tsx:8-9, slot-waiver-button.tsx:12, adjustment-labels.ts:16).
//
// Donor idioms, every one from components/admin-credits-panel.tsx: `import { Modal } from
// "@/components/modal"` (:12) with its `title` / `onClose` / `footer` props (:131, :132, :133-152 —
// Modal's own contract is `{ title: string; children?; onClose: () => void; footer?; size?:
// "md"|"lg" }`, modal.tsx:37-49); Cancel and the submit IN the footer (:140, :143-149); the
// section trigger's raw Tailwind (:122); `input w-full` on every field (:175, :195, :216) and
// `mb-1 block text-xs font-medium text-slate-600` on every label (:165); `btn btn-ghost` /
// `btn btn-primary disabled:opacity-40` on the footer buttons (:140, :146); the key mint with its
// fallback (:61-65); fetch → `if (!res.ok) throw new Error(d.error ?? …)` → `router.refresh()`
// (:80-95). A `select` for the action is that panel's idiom for its reason (:191-202), so the
// dropdown here is convention, not invention.
//
// THREE departures from the donor, all deliberate, all money:
//  1. The idempotency key is per SUBMISSION, not per modal open. It is minted on open, KEPT across
//     a failed attempt (a failure that wrote nothing leaves the key unused, so a retry with edited
//     fields is legal and an attempt that DID land replays instead of applying twice), re-minted
//     on success, and DROPPED on a 409 idempotency_key_reused.
//  2. The route answers 409 idempotency_key_reused when a kept key comes back with DIFFERENT
//     values (Task 7, Revision 2), where the donor answers a silent applied:false.
//  3. No in-modal "Applied. New balance is N" confirmation. The donor needs one because its page's
//     balance sits behind the overlay; here the resolved submission closes the modal and
//     router.refresh() re-reads the balance and the rail ON THE SERVER, so `stream-credits-balance`
//     (creditBalance) stays the ONE authority for this org's balance. `d.data.balance` is read off
//     the envelope's type below and deliberately not rendered for that reason — and on a REPLAY
//     (`applied: false`) that field is the CURRENT balance rather than what the original row left
//     behind, so painting it would restate a number this submission did not produce.
import { useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { Modal } from "@/components/modal";
import type { StreamCreditLedgerRow } from "@/server/usecases/admin-stream-credits";

/** Deterministic on server and client (no locale, no zone), so hydration can never disagree. */
const utc = (iso: string) => `${iso.slice(0, 16).replace("T", " ")} UTC`;

/** admin-credits-panel.tsx:61-65's key, fallback included (`crypto.randomUUID` is absent on an
 *  insecure origin). Both shapes clear the route's 8-character floor. */
const mintKey = () =>
  typeof crypto !== "undefined" && crypto.randomUUID
    ? crypto.randomUUID()
    : `adj-${Date.now()}-${Math.random().toString(36).slice(2)}`;

type Kind = "grant" | "refund" | "revoke";

/** The dropdown's order IS this array's order, and it names the same three literals as the route's
 *  zod discriminator. A refund ADDS credits back; a revoke takes them away. */
const KINDS: { kind: Kind; label: string }[] = [
  { kind: "grant", label: "Grant — add credits" },
  { kind: "refund", label: "Refund — add credits back" },
  { kind: "revoke", label: "Revoke — take credits away" },
];

type Form = { kind: Kind; amount: string; note: string; sessionId: string };
/** What the modal OPENS AT (AGENTS.md class 19): grant, ONE credit, no note, no session. A
 *  reachability test is satisfied by any value, so the component test pins these. */
const EMPTY: Form = { kind: "grant", amount: "1", note: "", sessionId: "" };

/** Shown on a 409 idempotency_key_reused. The walkthrough asserts on "already landed". */
const REUSED_KEY_MESSAGE =
  "An earlier attempt of this submission already landed with different values. The ledger below shows what landed; the form was reset for a new submission.";

export function AdminStreamCreditsPanel({
  orgId,
  balance,
  rows,
  maxDelta,
  ledgerLimit,
}: {
  orgId: string;
  /** creditBalance() on the server — the ONE balance. */
  balance: number;
  rows: StreamCreditLedgerRow[];
  /** STREAM_CREDIT_ADJUST_MAX, passed down so the input and the route share one number. */
  maxDelta: number;
  ledgerLimit: number;
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  // The ref closes the window between a second click and React committing `busy`, so a
  // double-click sends ONE request. The server's idempotency key is the backstop, not the guard.
  const inFlight = useRef(false);
  // ONE key per SUBMISSION (see the header): minted in openModal, kept across a failed attempt,
  // re-minted on success, dropped on a 409 idempotency_key_reused.
  const idemKey = useRef<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [replayed, setReplayed] = useState(false);
  const [form, setForm] = useState<Form>(EMPTY);
  const edit = (patch: Partial<Form>) => setForm((f) => ({ ...f, ...patch }));

  /** The donor's openModal (:60-73): rotate the key FIRST, then reset every field. Every open is a
   *  new submission, so a modal reopened after a success or a 409 can never inherit either. */
  function openModal() {
    idemKey.current = mintKey();
    setForm(EMPTY);
    setError("");
    setReplayed(false);
    setBusy(false);
    setOpen(true);
  }

  async function submit() {
    if (inFlight.current || !form.note.trim()) return;
    inFlight.current = true;
    const key = (idemKey.current ??= mintKey());
    setBusy(true);
    setError("");
    setReplayed(false);
    try {
      const res = await fetch(`/api/admin/orgs/${orgId}/stream-credits`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          kind: form.kind,
          delta: Number(form.amount),
          // Only a refund carries a session, and only the route's refund member accepts one: the
          // body is a STRICT discriminated union, so a grant carrying session_id is a 400.
          ...(form.kind === "refund" ? { session_id: form.sessionId.trim() || null } : {}),
          note: form.note,
          idempotency_key: key,
        }),
      });
      // SINGLE-wrapped. The route returns Task 7's `{ id, balance, applied }` and `handler` wraps
      // it ONCE, so the fields are under `d.data` — never `d.data.data`. (The DONOR route returns
      // its own `{ ok:true, … }` INSIDE the same wrapper, which is why admin-credits-panel.tsx:92-94
      // reads `d.data?.balance_after` and carries a comment recording that a top-level read left
      // its confirmation dead. Lane B's route does not double-wrap, so one `.data` is right here.)
      // `balance` is typed and deliberately NOT rendered: stream-credits-balance is creditBalance()
      // after router.refresh(), and one authority per fact means no second, client-held balance.
      const d = (await res.json().catch(() => ({}))) as {
        error?: string;
        code?: string;
        data?: { id?: string; balance?: number; applied?: boolean };
      };
      if (!res.ok && d.code === "idempotency_key_reused") {
        // An earlier attempt of THIS submission landed and the form was edited before the retry.
        // Keeping the key would 409 on every retry until a reload: drop it (K3), reset the form,
        // re-read the page so the attempt that DID land is on screen (K4), and say what happened.
        // The modal STAYS OPEN with the message inside it, at its opening state — which means the
        // action is back at `grant` and has to be re-chosen deliberately (deviation f).
        idemKey.current = null;
        setForm(EMPTY);
        router.refresh();
        throw new Error(REUSED_KEY_MESSAGE);
      }
      if (!res.ok) throw new Error(d.error ?? `Failed (${res.status})`);
      // Resolved. Anything from here is a NEW submission, so rotate rather than clear.
      idemKey.current = mintKey();
      // applied:false is an EXACT replay (the server compares org, kind, signed amount and
      // session): an earlier attempt of this submission already landed, so nothing was added.
      setReplayed(d.data?.applied === false);
      // Close on a resolved answer: the balance and the rail below are the confirmation, re-read
      // from the server. A failure does NOT close, so the staff member can fix and retry with the
      // same submission's key still in hand.
      setOpen(false);
      router.refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed");
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  }

  const label = "mb-1 block text-xs font-medium text-slate-600";

  return (
    <section data-testid="stream-credits-panel">
      <h2 className="mb-2 text-sm font-semibold text-slate-300">Match credits (streaming)</h2>
      <div className="space-y-3 rounded-lg bg-slate-800 p-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="min-w-0 space-y-1">
            <p className="text-2xl font-bold text-white">
              <span data-testid="stream-credits-balance">{balance}</span>{" "}
              <span className="text-sm font-normal text-slate-300">match credits</span>
            </p>
            <p className="text-xs text-slate-400">
              Up to {maxDelta} credits per adjustment. A refund adds credits back; to tie it to a failed
              stream, paste the session id from that stream&apos;s consume row. A revoke takes credits away
              and cannot go below zero. Latest {ledgerLimit} ledger entries, newest first.
            </p>
          </div>
          <button
            data-testid="stream-credits-adjust"
            type="button"
            onClick={openModal}
            className="shrink-0 rounded bg-purple-700 px-3 py-1.5 text-sm font-medium text-white hover:bg-purple-600"
          >
            Adjust credits
          </button>
        </div>

        {replayed && (
          <p data-testid="stream-credits-replayed" className="text-xs text-amber-300">
            Already recorded: an earlier attempt of this submission reached the ledger, so nothing was added twice.
          </p>
        )}

        {rows.length === 0 ? (
          <p data-testid="stream-credits-empty" className="text-xs text-slate-400">
            No match-credit ledger entries for this org.
          </p>
        ) : (
          <div
            data-testid="stream-credits-ledger"
            className="overflow-x-auto rounded-lg border border-slate-700"
            tabIndex={0}
            role="region"
            aria-label="Match credits ledger"
          >
            <table className="w-full text-sm">
              <thead className="bg-slate-900 text-xs text-slate-400">
                <tr>
                  {["When", "Reason", "Delta", "Balance after", "Note", "By", "Session"].map((h) => (
                    <th key={h} className="whitespace-nowrap px-3 py-2 text-left">{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-700">
                {rows.map((r) => (
                  <tr key={r.id} data-testid="stream-credits-row" data-reason={r.reason} data-delta={r.delta}>
                    <td className="whitespace-nowrap px-3 py-2 text-xs text-slate-400">{utc(r.createdAt)}</td>
                    <td className="px-3 py-2 text-slate-200">{r.reason}</td>
                    <td className="px-3 py-2 font-mono text-slate-200">{r.delta > 0 ? `+${r.delta}` : r.delta}</td>
                    <td className="px-3 py-2 font-mono text-slate-300">{r.balanceAfter}</td>
                    <td className="px-3 py-2 text-xs text-slate-300">{r.note ?? "—"}</td>
                    <td className="px-3 py-2 text-xs text-slate-300">{r.createdByEmail ?? r.createdBy ?? "—"}</td>
                    <td className="px-3 py-2 font-mono text-xs text-slate-400">{r.sessionId ?? "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {open && (
        <Modal
          title="Adjust match credits"
          onClose={() => setOpen(false)}
          footer={
            <>
              <button data-testid="stream-credits-cancel" type="button" onClick={() => setOpen(false)} className="btn btn-ghost">
                Cancel
              </button>
              <button
                data-testid="stream-credits-submit"
                type="button"
                onClick={submit}
                disabled={!form.note.trim() || busy}
                className="btn btn-primary disabled:opacity-40"
              >
                {busy ? "Applying…" : "Apply"}
              </button>
            </>
          }
        >
          <div className="space-y-4">
            <div>
              <label htmlFor="sc-kind" className={label}>Action</label>
              <select
                id="sc-kind"
                data-testid="stream-credits-kind"
                value={form.kind}
                onChange={(e) => edit({ kind: e.target.value as Kind })}
                className="input w-full"
              >
                {KINDS.map((k) => (
                  <option key={k.kind} value={k.kind}>{k.label}</option>
                ))}
              </select>
            </div>

            <div>
              <label htmlFor="sc-amount" className={label}>Credits (1–{maxDelta})</label>
              <input
                id="sc-amount"
                data-testid="stream-credits-amount"
                type="number"
                min={1}
                max={maxDelta}
                step={1}
                value={form.amount}
                onChange={(e) => edit({ amount: e.target.value })}
                className="input w-full"
              />
            </div>

            {/* A session caps a REFUND, so the field exists only for a refund — the route's body is
                a strict discriminated union and only its refund member accepts session_id. */}
            {form.kind === "refund" && (
              <div>
                <label htmlFor="sc-session" className={label}>Refunded session id (optional)</label>
                <input
                  id="sc-session"
                  data-testid="stream-credits-session"
                  value={form.sessionId}
                  onChange={(e) => edit({ sessionId: e.target.value })}
                  placeholder="The session id from that stream's consume row"
                  className="input w-full font-mono"
                />
                <p className="mt-1 text-xs text-slate-500">
                  Linked refunds may not exceed what that session consumed. Leave blank for a goodwill refund.
                </p>
              </div>
            )}

            <div>
              <label htmlFor="sc-note" className={label}>Note (required)</label>
              <input
                id="sc-note"
                data-testid="stream-credits-note"
                type="text"
                maxLength={500}
                value={form.note}
                onChange={(e) => edit({ note: e.target.value })}
                placeholder="Context for the audit log"
                className="input w-full"
              />
            </div>

            {error && <p data-testid="stream-credits-error" className="text-xs text-red-600">{error}</p>}
          </div>
        </Modal>
      )}
    </section>
  );
}
