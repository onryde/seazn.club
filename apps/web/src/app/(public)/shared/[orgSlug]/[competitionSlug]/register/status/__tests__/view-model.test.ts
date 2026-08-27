// Pure view-model logic for the rebuilt status page (RS007) — no React, no
// DB: every branch here is a plain function of plain data, so it is tested
// directly rather than through a render.
import { describe, expect, it } from "vitest";
import {
  canCancelEntry,
  claimHref,
  effectivePayDeadline,
  publicCheckoutPath,
  publicResendPath,
  publicWithdrawPath,
  resolveMoneyState,
  rosterCounts,
} from "../view-model";

describe("effectivePayDeadline", () => {
  it("uses the entry's OWN promotion deadline when it has one", () => {
    expect(effectivePayDeadline("2026-09-01T00:00:00.000Z", "2026-08-20T00:00:00.000Z")).toBe(
      "2026-09-01T00:00:00.000Z",
    );
  });

  it("falls back to the cart's shared deadline for a never-promoted entry", () => {
    expect(effectivePayDeadline(null, "2026-08-20T00:00:00.000Z")).toBe("2026-08-20T00:00:00.000Z");
  });

  it("is null when neither exists", () => {
    expect(effectivePayDeadline(null, null)).toBeNull();
  });
});

describe("resolveMoneyState — never a debt with no route to settle", () => {
  const cart = (over: Partial<Parameters<typeof resolveMoneyState>[1]> = {}) => ({
    payment_method: "stripe" as const,
    expires_at: "2026-08-20T00:00:00.000Z",
    charges_enabled: true,
    ...over,
  });
  const entry = (over: Partial<Parameters<typeof resolveMoneyState>[0]> = {}) => ({
    status: "pending" as const,
    amount_cents: 2500,
    promotion_expires_at: null,
    ...over,
  });

  it("a pending card entry with Stripe live is stripe_due, deadline attached", () => {
    expect(resolveMoneyState(entry(), cart())).toEqual({
      kind: "stripe_due",
      deadline: "2026-08-20T00:00:00.000Z",
    });
  });

  it("a promoted entry's OWN deadline wins over the cart's", () => {
    const state = resolveMoneyState(
      entry({ promotion_expires_at: "2026-09-05T00:00:00.000Z" }),
      cart(),
    );
    expect(state).toEqual({ kind: "stripe_due", deadline: "2026-09-05T00:00:00.000Z" });
  });

  it("a pending card entry with Stripe NOT live is stripe_unavailable — never a bare 'pay now' that 503s", () => {
    expect(resolveMoneyState(entry(), cart({ charges_enabled: false }))).toEqual({
      kind: "stripe_unavailable",
    });
  });

  it("a pending offline entry is offline_due, deadline attached", () => {
    expect(resolveMoneyState(entry(), cart({ payment_method: "offline" }))).toEqual({
      kind: "offline_due",
      deadline: "2026-08-20T00:00:00.000Z",
    });
  });

  it("a confirmed entry owes nothing regardless of amount_cents", () => {
    expect(resolveMoneyState(entry({ status: "confirmed" }), cart())).toEqual({ kind: "none" });
  });

  it("a waitlisted entry (amount_cents 0) owes nothing", () => {
    expect(
      resolveMoneyState(entry({ status: "waitlisted", amount_cents: 0 }), cart()),
    ).toEqual({ kind: "none" });
  });

  it("a free (amount_cents 0) pending entry owes nothing even though it is pending", () => {
    expect(resolveMoneyState(entry({ amount_cents: 0 }), cart())).toEqual({ kind: "none" });
  });
});

describe("canCancelEntry", () => {
  it("allows cancel for the live, spot-holding statuses", () => {
    for (const status of ["pending", "paid", "confirmed", "waitlisted"] as const) {
      expect(canCancelEntry(status)).toBe(true);
    }
  });

  it("refuses cancel once the entry is already terminal — withdrawCore would 422 or no-op on these", () => {
    for (const status of ["withdrawn", "rejected", "expired"] as const) {
      expect(canCancelEntry(status)).toBe(false);
    }
  });
});

describe("rosterCounts", () => {
  it("counts granted/guardian as claimed, pending as unclaimed", () => {
    expect(
      rosterCounts([
        { consent_status: "pending" },
        { consent_status: "granted" },
        { consent_status: "guardian" },
      ]),
    ).toEqual({ claimed: 2, total: 3 });
  });

  it("an empty roster is 0 of 0", () => {
    expect(rosterCounts([])).toEqual({ claimed: 0, total: 0 });
  });
});

describe("claimHref", () => {
  it("names the join_code, no player_id, for the generic entry-level link", () => {
    expect(claimHref("riverside", "summer-smash", "JOIN123")).toBe(
      "/shared/riverside/summer-smash/register/join?join_code=JOIN123",
    );
  });

  it("names the specific slot's player_id for a per-slot claim link", () => {
    expect(claimHref("riverside", "summer-smash", "JOIN123", "p1")).toBe(
      "/shared/riverside/summer-smash/register/join?join_code=JOIN123&player_id=p1",
    );
  });
});

describe("public write-path URL builders — the /public/ segment is load-bearing", () => {
  it("withdraw targets the PUBLIC per-entry path, never the organiser one", () => {
    expect(publicWithdrawPath("reg-1")).toBe("/api/v1/public/registrations/reg-1/withdraw");
  });

  it("checkout targets the PUBLIC per-entry path", () => {
    expect(publicCheckoutPath("reg-1")).toBe("/api/v1/public/registrations/reg-1/checkout");
  });

  it("resend targets the PUBLIC group-scoped path", () => {
    expect(publicResendPath("grp-1")).toBe("/api/v1/public/registrations/groups/grp-1/resend");
  });
});
