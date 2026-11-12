"use client";

// Sponsor invoices card (sponsor deals Task 21, spec §7 / D12): the address and the bank details every sponsor invoice prints, on
// Settings → Connect, on every plan. The bank details are what an OFFLINE invoice carries instead of a pay link; they are a
// setting of their own and never the registrants' `payment_instructions` (spec §10 Q2: that text is written for players).
//
// Saving rides PATCH /api/orgs/{id}, whose arms are single-key and strict (F30): there is no arm that takes both fields. So the
// island sends ONE PATCH per CHANGED field, strictly in sequence (address, then bank details), and says "Saved" only when the last
// of them answered 200. A pair that half-saves keeps what saved: the baseline "changed" is measured from moves as each PATCH
// answers, so the retry sends only what did not go through.
//
// The textareas stop typing at the route's caps (1000 and 2000 characters), so a long entry is stopped on screen rather than
// refused after Save; they are read-only while a save is in flight (an answer must not overwrite a keystroke), and for a member
// without an editor role, who sees the values and the reason and no Save (the PATCH would answer 401 for them).
//
// The words a refusal reads are the dictionary's, keyed on STATUS, never the server's English: 401 (requireOrgRole's AuthError
// folded onto 401 by lib/http.ts: signed out, not a member, or not an editor) says who can change this; every other status
// (400 a ZodError this card's caps make unreachable, 404 org not found, 500) is the generic. A refusal AFTER an earlier PATCH
// answered 200 says so instead ("Address saved. The bank details couldn't be saved."): the address is on file and the person
// must not think it is lost. After the last PATCH answers 200 the route is refreshed, like the rest of Settings -> Connect.
import { useId, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { api, ApiError } from "@/lib/client";
import { useMsg } from "@/components/i18n/dict-provider";

const ADDRESS_MAX = 1000;
const BANK_MAX = 2000;

type Notice = "saved" | "partialSaved" | "saveFailed" | "notAllowed" | null;

/** What the server holds is trimmed text, and "" means nothing stored (null). */
const clean = (v: string | null | undefined): string => (v ?? "").trim();

export function OrgSponsorInvoiceDetails({
  orgId,
  initialAddress,
  initialBankDetails,
  canEdit,
}: {
  orgId: string;
  initialAddress: string | null;
  initialBankDetails: string | null;
  /** Required, no default: the page passes its own auth answer, and a caller that forgets it must not hand out an editor card. */
  canEdit: boolean;
}) {
  const msg = useMsg();
  const router = useRouter();
  const base = useId();
  const [address, setAddress] = useState(initialAddress ?? "");
  const [bank, setBank] = useState(initialBankDetails ?? "");
  // What the server holds now. "Changed" is measured from here, and it moves as each PATCH answers 200.
  const [stored, setStored] = useState({ address: clean(initialAddress), bank: clean(initialBankDetails) });
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<Notice>(null);
  // A ref, not state: a second tap in the same tick reads the state it was rendered with, and the `disabled` button is not the guard.
  const inFlight = useRef(false);

  const addressChanged = clean(address) !== stored.address;
  const bankChanged = clean(bank) !== stored.bank;

  async function save() {
    if (inFlight.current) return;
    // Declared order, which is also the order on screen: the address, then the bank details.
    const changes: {
      column: "sponsor_invoice_address" | "sponsor_invoice_bank_details";
      field: "address" | "bank";
      text: string;
    }[] = [];
    if (addressChanged) changes.push({ column: "sponsor_invoice_address", field: "address", text: clean(address) });
    if (bankChanged) changes.push({ column: "sponsor_invoice_bank_details", field: "bank", text: clean(bank) });
    if (changes.length === 0) return;
    inFlight.current = true;
    setBusy(true);
    setNotice(null);
    // How many PATCHes answered 200 before one failed: any means part of the pair is on file.
    let savedBeforeFailure = 0;
    try {
      for (const change of changes) {
        // One key per PATCH (F30). null clears the column; the server never stores "".
        await api(`/api/orgs/${orgId}`, { method: "PATCH", json: { [change.column]: change.text || null } });
        setStored((s) => ({ ...s, [change.field]: change.text }));
        savedBeforeFailure++;
      }
      setNotice("saved");
      router.refresh();
    } catch (err) {
      console.error("save sponsor invoice details failed", err);
      setNotice(
        savedBeforeFailure > 0
          ? "partialSaved"
          : err instanceof ApiError && err.status === 401
            ? "notAllowed"
            : "saveFailed",
      );
      // Half saved: the address is on file, so the page's props must not restore the old one on back/forward.
      if (savedBeforeFailure > 0) router.refresh();
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  }

  const fieldClass = `textarea block${canEdit ? "" : " bg-slate-50 text-slate-600"}`;
  const hintId = `${base}-hint`;

  return (
    <div data-testid="sponsor-invoices-card" className="space-y-4">
      <div>
        <h2 className="text-sm font-medium text-slate-800">{msg("settings.sponsorInvoices.title")}</h2>
        <p id={hintId} className="mt-0.5 text-xs text-slate-500">
          {msg("settings.sponsorInvoices.hint")}
        </p>
      </div>

      <div>
        <label htmlFor={`${base}-address`} className="label">
          {msg("settings.sponsorInvoices.addressLabel")}
        </label>
        <textarea
          id={`${base}-address`}
          data-testid="sponsor-invoice-address"
          className={fieldClass}
          rows={4}
          maxLength={ADDRESS_MAX}
          value={address}
          readOnly={busy || !canEdit}
          placeholder={msg("settings.sponsorInvoices.addressPlaceholder")}
          aria-describedby={hintId}
          onChange={(e) => {
            setAddress(e.target.value);
            setNotice(null);
          }}
        />
      </div>

      <div>
        <label htmlFor={`${base}-bank`} className="label">
          {msg("settings.sponsorInvoices.bankLabel")}
        </label>
        <textarea
          id={`${base}-bank`}
          data-testid="sponsor-invoice-bank-details"
          className={fieldClass}
          rows={5}
          maxLength={BANK_MAX}
          value={bank}
          readOnly={busy || !canEdit}
          placeholder={msg("settings.sponsorInvoices.bankPlaceholder")}
          aria-describedby={hintId}
          onChange={(e) => {
            setBank(e.target.value);
            setNotice(null);
          }}
        />
      </div>

      {canEdit ? (
        <div className="flex flex-wrap items-center gap-3">
          <button
            type="button"
            data-testid="sponsor-invoices-save"
            onClick={save}
            disabled={busy || !(addressChanged || bankChanged)}
            className="btn btn-primary px-4"
          >
            {busy ? msg("settings.sponsorInvoices.saving") : msg("settings.sponsorInvoices.save")}
          </button>
          {/* Always mounted so a screen reader announces the change; `empty:hidden` keeps it out of the layout until it has words. */}
          <p
            role="status"
            aria-live="polite"
            data-testid="sponsor-invoices-status"
            className={`text-xs empty:hidden ${notice === "saved" ? "text-green-700" : "text-red-600"}`}
          >
            {notice && msg(`settings.sponsorInvoices.${notice}`)}
          </p>
        </div>
      ) : (
        <p data-testid="sponsor-invoices-readonly" className="text-xs text-slate-500">
          {msg("settings.sponsorInvoices.notAllowed")}
        </p>
      )}
    </div>
  );
}
