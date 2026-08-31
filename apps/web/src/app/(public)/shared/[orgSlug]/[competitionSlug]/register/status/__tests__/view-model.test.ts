// Pure view-model logic for the rebuilt status page (RS007) — no React, no
// DB: every branch here is a plain function of plain data, so it is tested
// directly rather than through a render.
import { describe, expect, it } from "vitest";
import {
  assignedTeamName,
  awaitingTeamAssignment,
  canCancelEntry,
  canJoinEntry,
  claimHref,
  classifyStatusActionFailure,
  effectivePayDeadline,
  entryCountsTowardTotal,
  entryDisplayName,
  publicCheckoutPath,
  publicResendPath,
  publicWithdrawPath,
  resolveMoneyState,
  rosterCounts,
  rosterPlayerDisplayName,
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
  // Deliberately far past/future — see FIX #8 below, which reads `deadline`
  // against the REAL wall clock (Date.now()), so a date merely "later than
  // when this test was written" (e.g. a fixed 2026 date) goes stale and
  // silently starts reading as window_closed the moment real time catches up
  // to it. Mirrors resolveRefundPolicy's own test file's FUTURE/PAST
  // convention (registrations.test.ts) for the identical reason.
  const FUTURE = "2099-01-01T00:00:00.000Z";
  const PAST = "2000-01-01T00:00:00.000Z";

  const cart = (over: Partial<Parameters<typeof resolveMoneyState>[1]> = {}) => ({
    expires_at: FUTURE,
    charges_enabled: true,
    ...over,
  });
  // RS007 review fix #10: payment_method now lives on the ENTRY (sourced
  // from its own DIVISION's registration_settings.payment_method), never on
  // the cart — see this describe block's own "division wins" tests below for
  // why: registration_groups.payment_method (the cart's shared envelope
  // column) can stay null/stale past a promotion that genuinely needs it
  // (promoteWaitlistedRow's `not exists (other pending)` guard).
  const entry = (over: Partial<Parameters<typeof resolveMoneyState>[0]> = {}) => ({
    status: "pending" as const,
    amount_cents: 2500,
    promotion_expires_at: null,
    payment_method: "stripe" as const,
    ...over,
  });

  it("a pending card entry with Stripe live is stripe_due, deadline attached", () => {
    expect(resolveMoneyState(entry(), cart())).toEqual({
      kind: "stripe_due",
      deadline: FUTURE,
    });
  });

  it("a promoted entry's OWN deadline wins over the cart's", () => {
    const ownDeadline = "2099-02-01T00:00:00.000Z"; // distinct from cart's FUTURE — proves it, doesn't just match it
    const state = resolveMoneyState(entry({ promotion_expires_at: ownDeadline }), cart());
    expect(state).toEqual({ kind: "stripe_due", deadline: ownDeadline });
  });

  it("a pending card entry with Stripe NOT live is stripe_unavailable — never a bare 'pay now' that 503s", () => {
    expect(resolveMoneyState(entry(), cart({ charges_enabled: false }))).toEqual({
      kind: "stripe_unavailable",
    });
  });

  it("a pending offline entry is offline_due, deadline attached", () => {
    expect(resolveMoneyState(entry({ payment_method: "offline" }), cart())).toEqual({
      kind: "offline_due",
      deadline: FUTURE,
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

  // RS007 review fix #10 ("a lapse timer with no way to pay"): a promoted
  // entry whose own division genuinely charges via Stripe must read
  // stripe_due even when the CART's shared payment_method write was
  // suppressed (promoteWaitlistedRow only overwrites it when no OTHER entry
  // in the cart is still 'pending') — the entry's own division is now the
  // only input, so there is no cart-level field left to go stale.
  it("a promoted entry's own division method is 'stripe' — resolves stripe_due regardless of what the (now-irrelevant) cart column would have said", () => {
    expect(
      resolveMoneyState(entry({ payment_method: "stripe", promotion_expires_at: FUTURE }), cart()),
    ).toEqual({ kind: "stripe_due", deadline: FUTURE });
  });

  it("a promoted entry's own division method is 'offline' — resolves offline_due, never stripe_due", () => {
    expect(
      resolveMoneyState(entry({ payment_method: "offline", promotion_expires_at: FUTURE }), cart()),
    ).toEqual({ kind: "offline_due", deadline: FUTURE });
  });

  // RS007 review fix #8 ("pay-then-refund on a stale deadline"): the hourly
  // sweep (cron "37 * * * *") means a cart whose deadline passed at 14:00 is
  // still 'pending' at 14:36 — resolveMoneyState must not print a live pay
  // control (or offline instructions) above a deadline that has already
  // gone by, however the entry would otherwise be paid.
  describe("window_closed — the deadline has passed but the sweep has not caught up yet", () => {
    it("a stripe entry past its OWN promotion deadline is window_closed, never stripe_due", () => {
      expect(
        resolveMoneyState(
          entry({ promotion_expires_at: PAST }),
          cart({ expires_at: FUTURE }), // cart's own clock still ahead — must not win
        ),
      ).toEqual({ kind: "window_closed" });
    });

    it("a stripe entry past the CART's shared deadline (never promoted) is window_closed, never stripe_due", () => {
      expect(resolveMoneyState(entry(), cart({ expires_at: PAST }))).toEqual({
        kind: "window_closed",
      });
    });

    it("an offline entry past its deadline is ALSO window_closed — the stale 'Pay by' copy is the bug, not just the button", () => {
      expect(
        resolveMoneyState(entry({ payment_method: "offline" }), cart({ expires_at: PAST })),
      ).toEqual({ kind: "window_closed" });
    });

    it("takes priority over stripe_unavailable — the window being closed is the more actionable fact", () => {
      expect(
        resolveMoneyState(entry(), cart({ expires_at: PAST, charges_enabled: false })),
      ).toEqual({ kind: "window_closed" });
    });

    it("a deadline in the future is unaffected (sanity: not simply always-closed)", () => {
      const state = resolveMoneyState(entry(), cart({ expires_at: FUTURE }));
      expect(state.kind).toBe("stripe_due");
    });

    it("no deadline at all (null) never reads as closed — nothing to have closed", () => {
      const state = resolveMoneyState(
        entry({ payment_method: "offline" }),
        cart({ expires_at: null }),
      );
      expect(state).toEqual({ kind: "offline_due", deadline: null });
    });
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

describe("entryCountsTowardTotal — live money only (RS007 status-page review FIX 1)", () => {
  it("counts pending/paid/confirmed — the fee is still live, whatever the payment method", () => {
    for (const status of ["pending", "paid", "confirmed"] as const) {
      expect(entryCountsTowardTotal(status)).toBe(true);
    }
  });

  it("excludes waitlisted — its amount_cents is always 0 by construction (registration-submit.ts sets feeCents 0 while waitlisted)", () => {
    expect(entryCountsTowardTotal("waitlisted")).toBe(false);
  });

  it("excludes the three terminal statuses — none of withdrawCore, the rejection path, or the expiry sweep ever clears amount_cents, so it keeps naming a PRE-cancellation fee forever", () => {
    for (const status of ["withdrawn", "rejected", "expired"] as const) {
      expect(entryCountsTowardTotal(status)).toBe(false);
    }
  });
});

describe("canJoinEntry — gates the roster claim/invite links (RS007 status-page review FIX 2)", () => {
  it("allows a join/claim for every live status — joinTeamEntry/previewJoinEntry only refuse the three terminal ones", () => {
    for (const status of ["pending", "paid", "confirmed", "waitlisted"] as const) {
      expect(canJoinEntry(status)).toBe(true);
    }
  });

  it("refuses withdrawn/rejected/expired — joinTeamEntry and previewJoinEntry both 404/422 on these (registration-submit.ts)", () => {
    for (const status of ["withdrawn", "rejected", "expired"] as const) {
      expect(canJoinEntry(status)).toBe(false);
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

// RS008: the roster row's own name, masked by division youth policy OR the
// linked person's own consent opt-out — whichever is stricter. Delegates to
// the single canonical resolver (lib/name-display.ts); this only pins the
// composition (the right fields feed the right resolver args), not the
// resolver's own matrix (name-display.test.ts owns that).
describe("rosterPlayerDisplayName", () => {
  const division = (over: { youth?: boolean; player_name_display?: string | null } = {}) => ({
    youth: false,
    player_name_display: null,
    ...over,
  });

  it("full name when the division is adult and the person has not opted out", () => {
    expect(
      rosterPlayerDisplayName({ full_name: "Arun Kumar", consent: { public_name: true } }, division()),
    ).toBe("Arun Kumar");
  });

  it("masks when the division is a youth division, regardless of consent", () => {
    expect(
      rosterPlayerDisplayName(
        { full_name: "Arun Kumar", consent: { public_name: true } },
        division({ youth: true }),
      ),
    ).toBe("Arun K.");
  });

  it("masks when the person explicitly opted out, even on an adult division", () => {
    expect(
      rosterPlayerDisplayName({ full_name: "Arun Kumar", consent: { public_name: false } }, division()),
    ).toBe("Arun K.");
  });

  it("a row with no linked person yet (consent null) masks by youth alone, never blocked on a person existing", () => {
    expect(rosterPlayerDisplayName({ full_name: "Arun Kumar", consent: null }, division())).toBe(
      "Arun Kumar",
    );
    expect(
      rosterPlayerDisplayName({ full_name: "Arun Kumar", consent: null }, division({ youth: true })),
    ).toBe("Arun K.");
  });
});

describe("awaitingTeamAssignment (RS008 review fix #9, NARROWED by RS009)", () => {
  it("true only when free_agent is true", () => {
    expect(awaitingTeamAssignment({ free_agent: true })).toBe(true);
    expect(awaitingTeamAssignment({ free_agent: false })).toBe(false);
  });

  it("stops once an organiser has placed them", () => {
    // The fuse RS008 documented and handed over. `free_agent` records how the
    // entry was MADE and never flips back, so on its own this told a placed
    // player they were still waiting — forever, and in direct contradiction
    // of the email they had just been sent.
    expect(
      awaitingTeamAssignment({ free_agent: true, assigned_team_name: "Riverside Rovers" }),
    ).toBe(false);
  });
});

describe("assignedTeamName (RS009)", () => {
  it("names the team once they are placed", () => {
    expect(assignedTeamName({ free_agent: true, assigned_team_name: "Riverside Rovers" })).toBe(
      "Riverside Rovers",
    );
  });

  it("is null while they are still in the pool", () => {
    expect(assignedTeamName({ free_agent: true, assigned_team_name: null })).toBeNull();
  });

  it("is null for an entry that was never a solo sign-up", () => {
    expect(assignedTeamName({ free_agent: false, assigned_team_name: "Riverside Rovers" })).toBeNull();
  });

  it("is never true at the same time as awaitingTeamAssignment", () => {
    // The property that matters more than either function alone: a card must
    // never say "waiting for a team" AND name a team. Both read the same
    // placement, so this holds by construction — pinned so it keeps holding
    // if either is edited on its own.
    for (const entry of [
      { free_agent: true, assigned_team_name: null },
      { free_agent: true, assigned_team_name: "Riverside Rovers" },
      { free_agent: false, assigned_team_name: null },
      { free_agent: false, assigned_team_name: "Riverside Rovers" },
    ]) {
      expect(
        awaitingTeamAssignment(entry) && assignedTeamName(entry) !== null,
        JSON.stringify(entry),
      ).toBe(false);
    }
  });
});

describe("entryDisplayName (RS008 review fix #1)", () => {
  const division = (over: { youth?: boolean; player_name_display?: string | null } = {}) => ({
    youth: false,
    player_name_display: null,
    ...over,
  });

  it("never masks a TEAM's own name, even when a roster member explicitly opted out", () => {
    expect(
      entryDisplayName(
        {
          display_name: "Thunder Strikers",
          entrant_kind: "team",
          players: [{ consent: { public_name: false } }],
        },
        division(),
      ),
    ).toBe("Thunder Strikers");
  });

  it("masks an INDIVIDUAL entrant's display_name when its linked person opted out", () => {
    expect(
      entryDisplayName(
        { display_name: "Arun Kumar", entrant_kind: "individual", players: [{ consent: { public_name: false } }] },
        division(),
      ),
    ).toBe("Arun K.");
  });

  it("masks a PAIR's compound display_name when EITHER partner opted out", () => {
    expect(
      entryDisplayName(
        {
          display_name: "Arun Kumar & Dev Patel",
          entrant_kind: "pair",
          players: [{ consent: { public_name: true } }, { consent: { public_name: false } }],
        },
        division(),
      ),
    ).toBe("Arun K. & Dev P.");
  });

  it("masks by division youth policy alone, with no explicit opt-out", () => {
    expect(
      entryDisplayName(
        { display_name: "Arun Kumar", entrant_kind: "individual", players: [{ consent: null }] },
        division({ youth: true }),
      ),
    ).toBe("Arun K.");
  });

  it("full name on a non-youth division when nobody opted out (consent null/absent never masks)", () => {
    expect(
      entryDisplayName(
        { display_name: "Arun Kumar", entrant_kind: "individual", players: [{ consent: null }] },
        division(),
      ),
    ).toBe("Arun Kumar");
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

describe("classifyStatusActionFailure — cancel/pay/resend's shared HTTP-status classifier (RS007 i18n follow-up)", () => {
  it("404 -> notFound (token/entryId/groupId no longer resolves)", () => {
    expect(classifyStatusActionFailure(404)).toBe("notFound");
  });
  it("409 -> conflict (a genuine concurrency race — e.g. resumeRegistrationCheckout's REGISTRATION_CHECKOUT_CONFLICT)", () => {
    expect(classifyStatusActionFailure(409)).toBe("conflict");
  });
  it("429 -> rateLimited (publicRateLimit tripped on the write route)", () => {
    expect(classifyStatusActionFailure(429)).toBe("rateLimited");
  });
  it("422/400/503/5xx/no-response -> generic (one honest fallback; the raw detail supplies the specifics)", () => {
    expect(classifyStatusActionFailure(422)).toBe("generic");
    expect(classifyStatusActionFailure(400)).toBe("generic");
    expect(classifyStatusActionFailure(503)).toBe("generic");
    expect(classifyStatusActionFailure(500)).toBe("generic");
    expect(classifyStatusActionFailure(undefined)).toBe("generic");
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
