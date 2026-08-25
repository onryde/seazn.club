// RS005 W2a — pure derivations feeding the Registrants tab's table/filters:
// the status-pill style map, "is any filter active" (which empty state to
// show), and the CSV export href builder.
import { describe, expect, it } from "vitest";
import { RegistrationStatus } from "@/server/api-v1/schemas";
import {
  REGISTRANT_STATUS_STYLE,
  CONSENT_STATUS_STYLE,
  hasActiveFilters,
  registrantsExportHref,
  deriveRegistrantPaymentState,
  answerLabel,
  registrantRowAnchor,
  deriveRegistrantActionFlags,
} from "@/components/registration-hub-registrant-derive";
import type { RegistrantsFilters } from "@/app/o/[orgSlug]/c/[compSlug]/registration/data";
import type { RegistrationFormField } from "@/server/api-v1/schemas";

const BASE: RegistrantsFilters = {
  status: null,
  divisionId: null,
  kind: null,
  freeAgent: false,
  consentPending: false,
  text: "",
  sort: "newest",
};

describe("REGISTRANT_STATUS_STYLE", () => {
  // RS005 W1a's own history: a 'rejected' status was missed from a hand-kept
  // list not once but twice (the route allowlist AND the OpenAPI enum) before
  // RS005 W1b made RegistrationStatus.options the single source. A style map
  // keyed by hand is exactly that same drift class, so this iterates the real
  // enum rather than trusting a literal count.
  it("has a style entry for every real RegistrationStatus value", () => {
    for (const s of RegistrationStatus.options) {
      expect(REGISTRANT_STATUS_STYLE).toHaveProperty(s);
    }
  });

  it("declares no extra keys beyond the real status set", () => {
    expect(Object.keys(REGISTRANT_STATUS_STYLE).sort()).toEqual([...RegistrationStatus.options].sort());
  });
});

describe("hasActiveFilters", () => {
  it("is false for the default (no filters) state", () => {
    expect(hasActiveFilters(BASE)).toBe(false);
  });

  it("is false when only sort differs from the default — sort orders, it doesn't narrow", () => {
    expect(hasActiveFilters({ ...BASE, sort: "oldest" })).toBe(false);
  });

  it("is true for each filter independently", () => {
    expect(hasActiveFilters({ ...BASE, status: "paid" })).toBe(true);
    expect(hasActiveFilters({ ...BASE, divisionId: "d1" })).toBe(true);
    expect(hasActiveFilters({ ...BASE, kind: "team" })).toBe(true);
    expect(hasActiveFilters({ ...BASE, freeAgent: true })).toBe(true);
    expect(hasActiveFilters({ ...BASE, consentPending: true })).toBe(true);
    expect(hasActiveFilters({ ...BASE, text: "alex" })).toBe(true);
  });
});

describe("registrantsExportHref", () => {
  it("links straight at the /api/v1 export route — this codebase's convention, no client fetch (documents-menu.tsx)", () => {
    expect(registrantsExportHref("comp-1", BASE)).toBe(
      "/api/v1/competitions/comp-1/registrations/export?sort=newest",
    );
  });

  it("carries every active filter through, using the API's own query param names and 1/0 boolean convention", () => {
    const href = registrantsExportHref("comp-1", {
      status: "paid",
      divisionId: "div-1",
      kind: "team",
      freeAgent: true,
      consentPending: true,
      text: "Alex Smith",
      sort: "oldest",
    });
    const url = new URL(href, "https://test.local");
    expect(url.pathname).toBe("/api/v1/competitions/comp-1/registrations/export");
    expect(url.searchParams.get("status")).toBe("paid");
    expect(url.searchParams.get("division_id")).toBe("div-1");
    expect(url.searchParams.get("kind")).toBe("team");
    expect(url.searchParams.get("free_agent")).toBe("1");
    expect(url.searchParams.get("consent_pending")).toBe("1");
    expect(url.searchParams.get("q")).toBe("Alex Smith");
    expect(url.searchParams.get("sort")).toBe("oldest");
  });

  it("always includes sort, even at the default, so the export matches exactly what's on screen", () => {
    expect(registrantsExportHref("comp-1", BASE)).toContain("sort=newest");
  });
});

// RS005 W2b — the row-expand detail's own pure derivations: the consent
// chip style map, the payment-state word, and the answers label lookup.
describe("CONSENT_STATUS_STYLE", () => {
  // No shared zod enum exists for this column (unlike RegistrationStatus) —
  // registration_players.consent_status (V363) is only ever a 2-value zod
  // subset elsewhere (schemas.ts's ClaimPlayer, deliberately excluding
  // 'pending' for that different use). So this pins the literal 3-value set
  // the DB CHECK constraint declares, by hand, rather than iterating a
  // schema this column has none of.
  it("has exactly the 3 real consent_status values, no more, no fewer", () => {
    expect(Object.keys(CONSENT_STATUS_STYLE).sort()).toEqual(["granted", "guardian", "pending"]);
  });
});

const PAYMENT_BASE = {
  amount_cents: 1500,
  refunded_cents: 0,
  disputed_at: null,
  offline_marked_paid_at: null,
  status: "confirmed" as const,
};

describe("deriveRegistrantPaymentState", () => {
  it("a disputed entry is 'disputed' regardless of anything else", () => {
    expect(
      deriveRegistrantPaymentState({ ...PAYMENT_BASE, disputed_at: new Date(), refunded_cents: 1500 }),
    ).toBe("disputed");
  });

  it("refunded in full is 'refunded'", () => {
    expect(deriveRegistrantPaymentState({ ...PAYMENT_BASE, refunded_cents: 1500 })).toBe("refunded");
  });

  it("refunded less than the amount is 'partiallyRefunded'", () => {
    expect(deriveRegistrantPaymentState({ ...PAYMENT_BASE, refunded_cents: 500 })).toBe("partiallyRefunded");
  });

  it("a zero-fee entry is 'free', even with a non-null offline_marked_paid_at", () => {
    expect(
      deriveRegistrantPaymentState({ ...PAYMENT_BASE, amount_cents: 0, offline_marked_paid_at: new Date() }),
    ).toBe("free");
  });

  it("marked paid offline, no refund, is 'paidOffline'", () => {
    expect(deriveRegistrantPaymentState({ ...PAYMENT_BASE, offline_marked_paid_at: new Date() })).toBe(
      "paidOffline",
    );
  });

  it("status paid or confirmed, no offline mark, is 'paid' (card payment captured)", () => {
    expect(deriveRegistrantPaymentState({ ...PAYMENT_BASE, status: "paid" })).toBe("paid");
    expect(deriveRegistrantPaymentState({ ...PAYMENT_BASE, status: "confirmed" })).toBe("paid");
  });

  it("a pending fee-bearing entry with no payment yet is 'awaitingPayment'", () => {
    expect(deriveRegistrantPaymentState({ ...PAYMENT_BASE, status: "pending" })).toBe("awaitingPayment");
  });
});

const FIELDS: RegistrationFormField[] = [
  { key: "dietary_reqs", label: "Dietary requirements", kind: "text", required: false },
  { key: "shirt_size", label: "Shirt size", kind: "select", options: ["S", "M", "L"], required: true },
];

describe("answerLabel", () => {
  it("resolves a declared key to its form-field label", () => {
    expect(answerLabel("dietary_reqs", FIELDS)).toBe("Dietary requirements");
  });

  it("falls back to the raw key when it is not declared on the division's form", () => {
    expect(answerLabel("mystery_key", FIELDS)).toBe("mystery_key");
  });

  it("falls back to the raw key when there are no fields at all", () => {
    expect(answerLabel("dietary_reqs", [])).toBe("dietary_reqs");
  });
});

describe("registrantRowAnchor", () => {
  it("builds the SAME anchor id a row sets on itself and a sibling link points at — one function, not two hand-typed copies", () => {
    expect(registrantRowAnchor("reg-42")).toBe("registrant-reg-42");
  });
});

describe("deriveRegistrantActionFlags", () => {
  // RS005 W3 task 3's own legality rule, taken literally: approve/reject
  // need BOTH approval === "manual" AND an awaiting-decision status
  // (pending or paid) — never re-derived by hand at a button call site, so
  // the pure rule and the completeness sweep below can't drift apart.
  // amount_cents: 0 / payment_intent_id: null throughout this first block
  // keeps every case OUTSIDE RS005 R1's awaiting-payment carve-out (a free
  // entry never awaits payment), so these assert the approval-mode rule in
  // isolation — the carve-out itself gets its own describe block below.
  it("approve/reject are legal on a manual division's pending or paid entry", () => {
    expect(
      deriveRegistrantActionFlags({ status: "pending", approval: "manual", amount_cents: 0, payment_intent_id: null }),
    ).toMatchObject({
      canApprove: true,
      canReject: true,
    });
    expect(
      deriveRegistrantActionFlags({ status: "paid", approval: "manual", amount_cents: 0, payment_intent_id: null }),
    ).toMatchObject({
      canApprove: true,
      canReject: true,
    });
  });

  it("approve/reject are ABSENT on an auto-approval division, even pending/paid — offering them would hand an organiser a button approveRegistration 422s on", () => {
    expect(
      deriveRegistrantActionFlags({ status: "pending", approval: "auto", amount_cents: 0, payment_intent_id: null }),
    ).toMatchObject({
      canApprove: false,
      canReject: false,
    });
    expect(
      deriveRegistrantActionFlags({ status: "paid", approval: "auto", amount_cents: 0, payment_intent_id: null }),
    ).toMatchObject({
      canApprove: false,
      canReject: false,
    });
  });

  it("approve/reject are ABSENT on a manual division once the entry is no longer awaiting a decision (includes the terminal statuses)", () => {
    for (const status of ["confirmed", "waitlisted", "withdrawn", "expired", "rejected"] as const) {
      expect(
        deriveRegistrantActionFlags({ status, approval: "manual", amount_cents: 0, payment_intent_id: null }),
      ).toMatchObject({
        canApprove: false,
        canReject: false,
      });
    }
  });

  it("withdraw is legal on every non-terminal status", () => {
    for (const status of ["pending", "paid", "confirmed", "waitlisted"] as const) {
      expect(
        deriveRegistrantActionFlags({ status, approval: "auto", amount_cents: 0, payment_intent_id: null }).canWithdraw,
      ).toBe(true);
    }
  });

  it("withdraw is ABSENT on every terminal status (withdrawn, rejected, expired)", () => {
    for (const status of ["withdrawn", "rejected", "expired"] as const) {
      expect(
        deriveRegistrantActionFlags({ status, approval: "auto", amount_cents: 0, payment_intent_id: null }).canWithdraw,
      ).toBe(false);
    }
  });

  // RS005 R1 second-wave finding: observed live, a WITHDRAWN entry rendered
  // Resend and the send succeeded — the mail is cart-shaped, so someone who
  // had pulled out was told they were still registered, siblings included.
  // Same rule and same source set as withdraw (isTerminalRegistrationStatus,
  // @/lib/registration-status) — resendRegistrationConfirmation
  // (registrations.ts:1071) now refuses the same three statuses
  // server-side; this is the button-level courtesy.
  it("resend is legal on every non-terminal status", () => {
    for (const status of ["pending", "paid", "confirmed", "waitlisted"] as const) {
      expect(
        deriveRegistrantActionFlags({ status, approval: "auto", amount_cents: 0, payment_intent_id: null }).canResend,
      ).toBe(true);
    }
  });

  it("resend is ABSENT on every terminal status (withdrawn, rejected, expired)", () => {
    for (const status of ["withdrawn", "rejected", "expired"] as const) {
      expect(
        deriveRegistrantActionFlags({ status, approval: "auto", amount_cents: 0, payment_intent_id: null }).canResend,
      ).toBe(false);
    }
  });

  it("promote is legal ONLY for a waitlisted entry", () => {
    expect(
      deriveRegistrantActionFlags({ status: "waitlisted", approval: "auto", amount_cents: 0, payment_intent_id: null })
        .canPromote,
    ).toBe(true);
    for (const status of ["pending", "paid", "confirmed", "withdrawn", "expired", "rejected"] as const) {
      expect(
        deriveRegistrantActionFlags({ status, approval: "auto", amount_cents: 0, payment_intent_id: null }).canPromote,
      ).toBe(false);
    }
  });

  // RS005 R1 finding 1 (whole-branch review MAJOR): registration-approval.ts
  // approveRegistration (line 128) 422s "Awaiting payment — mark it paid
  // first, or approve once payment arrives" for a manual division's
  // fee-bearing, still-`pending` entry with no payment on file — the
  // ORDINARY state of every entry on a paid manual division between submit
  // and payment. Approve must not render there. Uses amount_cents (this
  // row's OWN quoted fee) as the fee signal in place of the division's live
  // registration_settings.fee_cents — see the function's own doc comment
  // for why (this pure function never sees the division's settings).
  describe("approve's awaiting-payment carve-out (RS005 R1 finding 1)", () => {
    it("approve is ABSENT on a manual, fee-bearing, unpaid, pending entry", () => {
      expect(
        deriveRegistrantActionFlags({
          status: "pending",
          approval: "manual",
          amount_cents: 1500,
          payment_intent_id: null,
        }).canApprove,
      ).toBe(false);
    });

    it("approve is PRESENT once that same entry is paid (payment_intent_id set)", () => {
      expect(
        deriveRegistrantActionFlags({
          status: "pending",
          approval: "manual",
          amount_cents: 1500,
          payment_intent_id: "pi_123",
        }).canApprove,
      ).toBe(true);
    });

    it("approve is PRESENT once the entry's OWN status has already moved to paid, even with no payment_intent_id — approveRegistration's own check (registration-approval.ts:128) only bites while status is still pending", () => {
      expect(
        deriveRegistrantActionFlags({
          status: "paid",
          approval: "manual",
          amount_cents: 1500,
          payment_intent_id: null,
        }).canApprove,
      ).toBe(true);
    });

    it("approve is still PRESENT on a manual FREE entry (fee 0) that is pending — a free entry never awaits payment, so this must not be over-gated", () => {
      expect(
        deriveRegistrantActionFlags({
          status: "pending",
          approval: "manual",
          amount_cents: 0,
          payment_intent_id: null,
        }).canApprove,
      ).toBe(true);
    });

    it("reject stays PRESENT in the exact case approve is hidden — rejectRegistration carries no awaiting-payment check, so an organiser can always decline outright before ever collecting money", () => {
      expect(
        deriveRegistrantActionFlags({
          status: "pending",
          approval: "manual",
          amount_cents: 1500,
          payment_intent_id: null,
        }).canReject,
      ).toBe(true);
    });
  });

  // RS005 R1 finding 1's recovery path: markRegistrationPaidOffline's own
  // rule (registrations.ts ~3102-3114) — status must still be 'pending', no
  // payment_intent_id on file (a card payment refunds on the payments
  // trail instead), and a real fee owed. Deliberately no approval-mode
  // check: the usecase confirms identically on a manual or an auto
  // division (registrations.test.ts's own "...still confirm on a MANUAL
  // division — an organiser's explicit action IS the approval").
  describe("canMarkPaid (RS005 R1 finding 1's recovery path)", () => {
    it("is legal on a pending, fee-bearing, unpaid entry — on EITHER approval mode", () => {
      for (const approval of ["manual", "auto"] as const) {
        expect(
          deriveRegistrantActionFlags({
            status: "pending",
            approval,
            amount_cents: 1500,
            payment_intent_id: null,
          }).canMarkPaid,
        ).toBe(true);
      }
    });

    it("is ABSENT once a payment_intent_id already exists — a card payment refunds on the payments trail instead", () => {
      expect(
        deriveRegistrantActionFlags({
          status: "pending",
          approval: "manual",
          amount_cents: 1500,
          payment_intent_id: "pi_123",
        }).canMarkPaid,
      ).toBe(false);
    });

    it("is ABSENT on a free entry (amount_cents 0) — 'This division has no entry fee'", () => {
      expect(
        deriveRegistrantActionFlags({
          status: "pending",
          approval: "manual",
          amount_cents: 0,
          payment_intent_id: null,
        }).canMarkPaid,
      ).toBe(false);
    });

    it("is ABSENT on any non-pending status — 'Only pending registrations can be marked paid'", () => {
      for (const status of ["paid", "confirmed", "waitlisted", "withdrawn", "expired", "rejected"] as const) {
        expect(
          deriveRegistrantActionFlags({
            status,
            approval: "manual",
            amount_cents: 1500,
            payment_intent_id: null,
          }).canMarkPaid,
        ).toBe(false);
      }
    });

    it("is mutually exclusive with canApprove by construction — never both true for the same row", () => {
      for (const status of RegistrationStatus.options) {
        for (const approval of ["auto", "manual"] as const) {
          for (const amount_cents of [0, 1500]) {
            for (const payment_intent_id of [null, "pi_123"] as const) {
              const flags = deriveRegistrantActionFlags({ status, approval, amount_cents, payment_intent_id });
              expect(flags.canApprove && flags.canMarkPaid).toBe(false);
            }
          }
        }
      }
    });
  });

  // Completeness sweep, RS005 W1a-style: iterates the REAL zod enum rather
  // than a hand-copied list, for both approval modes and (RS005 R1) both
  // fee/payment-intent combinations, so a status added to the union in
  // future is exercised here automatically rather than silently falling
  // through to whatever a branch's default does.
  it("returns a defined boolean for every real status × approval × fee × payment_intent combination", () => {
    for (const status of RegistrationStatus.options) {
      for (const approval of ["auto", "manual"] as const) {
        for (const amount_cents of [0, 1500]) {
          for (const payment_intent_id of [null, "pi_123"] as const) {
            const flags = deriveRegistrantActionFlags({ status, approval, amount_cents, payment_intent_id });
            expect(typeof flags.canApprove).toBe("boolean");
            expect(typeof flags.canReject).toBe("boolean");
            expect(typeof flags.canWithdraw).toBe("boolean");
            expect(typeof flags.canPromote).toBe("boolean");
            expect(typeof flags.canMarkPaid).toBe("boolean");
            expect(typeof flags.canResend).toBe("boolean");
            // canResend and canWithdraw share the identical rule (both key
            // off isTerminalRegistrationStatus alone) — pinned here so a
            // FUTURE divergence between the two is a deliberate code change,
            // not a silent drift the sweep never notices.
            expect(flags.canResend).toBe(flags.canWithdraw);
          }
        }
      }
    }
  });
});
