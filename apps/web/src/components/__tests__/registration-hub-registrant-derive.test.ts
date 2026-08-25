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
