// Pure view-model logic for the rebuilt status page (RS007) — no React, no
// DB: every branch here is a plain function of plain data, so it is tested
// directly rather than through a render.
import { describe, expect, it } from "vitest";
import uiEn from "@/dictionaries/en/ui.json";
import uiEs from "@/dictionaries/es/ui.json";
import uiFr from "@/dictionaries/fr/ui.json";
import uiNl from "@/dictionaries/nl/ui.json";
import {
  assignedTeamName,
  awaitingTeamAssignment,
  canCancelEntry,
  canJoinEntry,
  cartHeadline,
  cartMoneySummary,
  claimHref,
  classifyStatusActionFailure,
  effectivePayDeadline,
  entryCountsTowardTotal,
  entryDisplayName,
  inviteLinks,
  moneyLine,
  poolPlaceByDate,
  publicCheckoutPath,
  publicResendPath,
  publicWithdrawPath,
  receivedCount,
  resolveMoneyState,
  rosterCounts,
  rosterPlayerDisplayName,
  rosterVocabulary,
  whatHappensNext,
  type EntryStatus,
  type HeadlineKind,
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

describe("awaitingTeamAssignment (RS008 review fix #9, NARROWED by RS009, then RS012)", () => {
  it("true only when free_agent is true", () => {
    expect(awaitingTeamAssignment({ status: "pending", free_agent: true })).toBe(true);
    expect(awaitingTeamAssignment({ status: "pending", free_agent: false })).toBe(false);
  });

  it("stops once an organiser has placed them", () => {
    // The fuse RS008 documented and handed over. `free_agent` records how the
    // entry was MADE and never flips back, so on its own this told a placed
    // player they were still waiting — forever, and in direct contradiction
    // of the email they had just been sent.
    expect(
      awaitingTeamAssignment({
        status: "confirmed",
        free_agent: true,
        assigned_team_name: "Riverside Rovers",
      }),
    ).toBe(false);
  });

  it("stops once the entry is withdrawn, rejected, or expired — RS012, found by the walkthrough", () => {
    // The Stage 2 sweep withdraws an unplaced solo sign-up past its deadline:
    // free_agent stays true, assigned_team_name stays null (never placed) —
    // status is the ONLY column that changes. Without this check the card
    // read "Withdrawn" right next to "Waiting for a team" and an already-
    // past refund date, a live defect the unit suite never caught because
    // every prior test only ever used an active status.
    for (const status of ["withdrawn", "rejected", "expired"] as const) {
      expect(
        awaitingTeamAssignment({ status, free_agent: true, assigned_team_name: null }),
        status,
      ).toBe(false);
    }
  });

  it("still true for an unplaced, still-active pending/paid/confirmed entry", () => {
    for (const status of ["pending", "paid", "confirmed"] as const) {
      expect(
        awaitingTeamAssignment({ status, free_agent: true, assigned_team_name: null }),
        status,
      ).toBe(true);
    }
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
      { status: "pending" as const, free_agent: true, assigned_team_name: null },
      { status: "confirmed" as const, free_agent: true, assigned_team_name: "Riverside Rovers" },
      { status: "pending" as const, free_agent: false, assigned_team_name: null },
      { status: "confirmed" as const, free_agent: false, assigned_team_name: "Riverside Rovers" },
      { status: "withdrawn" as const, free_agent: true, assigned_team_name: null },
    ]) {
      expect(
        awaitingTeamAssignment(entry) && assignedTeamName(entry) !== null,
        JSON.stringify(entry),
      ).toBe(false);
    }
  });
});

describe("poolPlaceByDate (RS012 — the other other half)", () => {
  it("is the division's place-by date while a solo sign-up is still in the pool", () => {
    expect(
      poolPlaceByDate({
        status: "pending",
        free_agent: true,
        assigned_team_name: null,
        pool_place_by_at: "2026-03-15T00:00:00.000Z",
      }),
    ).toBe("2026-03-15T00:00:00.000Z");
  });

  it("is null once the solo sign-up has been assigned to a team, even if a date was carried", () => {
    // Reuses awaitingTeamAssignment's own predicate — an entry cannot be
    // "waiting" and carry a live deadline at the same time.
    expect(
      poolPlaceByDate({
        status: "confirmed",
        free_agent: true,
        assigned_team_name: "Riverside Rovers",
        pool_place_by_at: "2026-03-15T00:00:00.000Z",
      }),
    ).toBeNull();
  });

  it("is null for an entry that was never a solo sign-up, regardless of any carried date", () => {
    expect(
      poolPlaceByDate({
        status: "pending",
        free_agent: false,
        assigned_team_name: null,
        pool_place_by_at: "2026-03-15T00:00:00.000Z",
      }),
    ).toBeNull();
  });

  it("is null when the pool has no deadline to enforce", () => {
    expect(
      poolPlaceByDate({
        status: "pending",
        free_agent: true,
        assigned_team_name: null,
        pool_place_by_at: null,
      }),
    ).toBeNull();
  });

  it("is null once the sweep withdraws an unplaced entry, even though a date was carried — RS012, found by the walkthrough", () => {
    // The exact defect: the sweep withdraws this entry FOR missing its
    // place-by date, so pool_place_by_at is still populated on the row. If
    // this didn't gate on status too, the card would show a refund-by date
    // that has already passed, right next to a "Withdrawn" badge.
    expect(
      poolPlaceByDate({
        status: "withdrawn",
        free_agent: true,
        assigned_team_name: null,
        pool_place_by_at: "2026-03-15T00:00:00.000Z",
      }),
    ).toBeNull();
  });

  it("is never non-null at the same time assignedTeamName is non-null", () => {
    for (const entry of [
      {
        status: "pending" as const,
        free_agent: true,
        assigned_team_name: null,
        pool_place_by_at: "2026-03-15T00:00:00.000Z",
      },
      {
        status: "confirmed" as const,
        free_agent: true,
        assigned_team_name: "Riverside Rovers",
        pool_place_by_at: "2026-03-15T00:00:00.000Z",
      },
      {
        status: "pending" as const,
        free_agent: false,
        assigned_team_name: null,
        pool_place_by_at: null,
      },
      {
        status: "withdrawn" as const,
        free_agent: true,
        assigned_team_name: null,
        pool_place_by_at: "2026-03-15T00:00:00.000Z",
      },
    ]) {
      expect(
        poolPlaceByDate(entry) !== null && assignedTeamName(entry) !== null,
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
      "/live/riverside/summer-smash/register/join?join_code=JOIN123",
    );
  });

  it("names the specific slot's player_id for a per-slot claim link", () => {
    expect(claimHref("riverside", "summer-smash", "JOIN123", "p1")).toBe(
      "/live/riverside/summer-smash/register/join?join_code=JOIN123&player_id=p1",
    );
  });
});

// Polish wave P6: the captain's "Invite your teammates" block. WHICH links it offers is a rule of its own (the old inline condition
// in entry-card.tsx), so it is pinned here, over every status and both entrant kinds, with a count. The URLs themselves are built by
// the block (`joinLinkPath`, lib/join-link.ts), not here.
describe("inviteLinks", () => {
  const ALL_STATUSES: EntryStatus[] = ["pending", "paid", "confirmed", "waitlisted", "withdrawn", "expired", "rejected"];
  const LIVE: EntryStatus[] = ["pending", "paid", "confirmed", "waitlisted"];
  const players = [
    { id: "p1", consent_status: "granted" as const },
    { id: "p2", consent_status: "pending" as const },
    { id: "p3", consent_status: "pending" as const },
    { id: "p4", consent_status: "guardian" as const },
  ];
  const entry = (over: Partial<Parameters<typeof inviteLinks>[0]> = {}) => ({
    status: "pending" as EntryStatus,
    join_code: "JOIN123",
    allows_new_joiner: true,
    players,
    ...over,
  });

  // Polish wave K (owner feedback): the block names EVERY roster slot with whether that person has joined, so the captain sees who is
  // still to come; only a slot still to join gets a link. Granted and guardian are joined.
  it("a team on a live entry: every slot in roster order, joined or not (granted and guardian are joined), and the general link", () => {
    expect(inviteLinks(entry())).toEqual({
      joinCode: "JOIN123",
      slots: [
        { id: "p1", joined: true },
        { id: "p2", joined: false },
        { id: "p3", joined: false },
        { id: "p4", joined: true },
      ],
      generic: true,
    });
  });

  it("a pair (allows_new_joiner false): both slots, the partner still to join, and NO general link", () => {
    expect(inviteLinks(entry({ allows_new_joiner: false, players: players.slice(0, 2) }))).toEqual({
      joinCode: "JOIN123",
      slots: [
        { id: "p1", joined: true },
        { id: "p2", joined: false },
      ],
      generic: false,
    });
  });

  it("every dead status offers nothing, however much else is still true; every live status offers links (counted, both directions)", () => {
    let dead = 0;
    let live = 0;
    for (const status of ALL_STATUSES) {
      const links = inviteLinks(entry({ status }));
      if (LIVE.includes(status)) {
        expect(links, status).not.toBeNull();
        live++;
      } else {
        expect(links, status).toBeNull();
        dead++;
      }
    }
    expect([live, dead]).toEqual([4, 3]);
  });

  it("no join code (a free agent, a legacy row): nothing, even with unclaimed slots", () => {
    expect(inviteLinks(entry({ join_code: null }))).toBeNull();
  });

  it("empty case: a team with every slot claimed still offers the general link; a pair with every slot claimed offers nothing", () => {
    const claimed = players.map((p) => ({ ...p, consent_status: "granted" as const }));
    expect(inviteLinks(entry({ players: claimed }))).toEqual({
      joinCode: "JOIN123",
      slots: claimed.map((p) => ({ id: p.id, joined: true })),
      generic: true,
    });
    expect(inviteLinks(entry({ players: claimed, allows_new_joiner: false }))).toBeNull();
  });

  it("empty roster: a team with no players at all still offers the general link", () => {
    expect(inviteLinks(entry({ players: [] }))).toEqual({ joinCode: "JOIN123", slots: [], generic: true });
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

// Polish wave P3 (W6, W10, W11): a waitlisted, expired or withdrawn page printed SUBTOTAL "Free" and a roster that read "Checked in".
// The expectations below are the brief's rulings, written out per status; none is read back from the function under test.
// Polish wave final fix (owner ruling on V7, 2026-11-12): only a CONFIRMED entry says "checked in"; an entry still awaiting payment,
// approval or both (pending, paid) says its players have JOINED - "2 of 2 checked in" on an unpaid entry read as a false claim.
describe("rosterVocabulary: 'checked in' only on a confirmed entry", () => {
  // Every status a registration can hold (the DB CHECK on registrations.status), each with the ruling for it.
  const RULING: [EntryStatus, "checkin" | "joined" | "registered"][] = [
    ["pending", "joined"],
    ["paid", "joined"],
    ["confirmed", "checkin"],
    ["waitlisted", "registered"],
    ["withdrawn", "registered"],
    ["expired", "registered"],
    ["rejected", "registered"],
  ];
  it("one case per status (counted)", () => {
    let checked = 0;
    for (const [status, want] of RULING) {
      expect(rosterVocabulary(status), status).toBe(want);
      checked += 1;
    }
    expect(checked).toBe(7);
    expect(new Set(RULING.map(([s]) => s)).size, "premise: no status listed twice").toBe(7);
  });
});

// ---------------------------------------------------------------------------
// Registration redesign B4 T15 (spec §5.1-5.3): the page's outcome headline, its money line and "What happens next". Every expected
// value below is a literal from the spec's rule tables (or the T15 rulings named beside a row), never read back from the functions.
// ---------------------------------------------------------------------------

describe("status page outcome (B4 T15)", () => {
  // Far past/future: resolveMoneyState reads deadlines against the real clock (see its own FIX #8).
  const FUTURE = "2099-01-01T00:00:00.000Z";
  const SOONER = "2098-06-01T00:00:00.000Z";
  const PAST = "2000-01-01T00:00:00.000Z";
  const CART = { expires_at: FUTURE, charges_enabled: true };

  type Entry = Parameters<typeof cartMoneySummary>[0][number] & Parameters<typeof whatHappensNext>[0]["entries"][number];
  const entry = (over: Partial<Entry> = {}): Entry => ({
    status: "confirmed",
    amount_cents: 0,
    promotion_expires_at: null,
    payment_method: "stripe",
    settled_by: null,
    refunded_cents: 0,
    fee_if_promoted_cents: null,
    join_code: null,
    allows_new_joiner: true,
    players: [],
    free_agent: false,
    assigned_team_name: null,
    ...over,
  });

  // One entry per state the rules name.
  const unpaidCard = entry({ status: "pending", amount_cents: 2400, payment_method: "stripe" });
  const offlineDue = entry({ status: "pending", amount_cents: 2400, payment_method: "offline" });
  const windowClosed = entry({ status: "pending", amount_cents: 2400, promotion_expires_at: PAST });
  const paidAwaiting = entry({ status: "paid", amount_cents: 1500, settled_by: "card" });
  const freeAwaiting = entry({ status: "pending", amount_cents: 0 });
  const confirmedCard = entry({ status: "confirmed", amount_cents: 1500, settled_by: "card" });
  const confirmedFree = entry({ status: "confirmed", amount_cents: 0 });
  const waived = entry({ status: "confirmed", amount_cents: 1500, settled_by: "waived" });
  const waitlisted = entry({ status: "waitlisted", amount_cents: 0, fee_if_promoted_cents: 1500 });
  const withdrawn = entry({ status: "withdrawn", amount_cents: 1500 });
  const expired = entry({ status: "expired", amount_cents: 1500 });
  const rejected = entry({ status: "rejected", amount_cents: 1500 });
  // B4 review I1: a solo sign-up (free agent) in the player pool. Confirmed before any placement (registration-submit.ts confirms a
  // free auto-approval entry at submit; assignSoloSignUp places only a confirmed or paid one), so "You're in" + "Nothing else to do"
  // would sit above its own card's "Waiting for a team".
  const inPool = entry({ status: "confirmed", amount_cents: 0, free_agent: true });
  const placedSolo = entry({ status: "confirmed", amount_cents: 0, free_agent: true, assigned_team_name: "Riverside Rovers" });
  const soloAwaitingApproval = entry({ status: "pending", amount_cents: 0, free_agent: true });
  const soloUnpaid = entry({ status: "pending", amount_cents: 800, free_agent: true });
  const soloWaitlisted = entry({ status: "waitlisted", amount_cents: 0, free_agent: true });
  const soloWithdrawn = entry({ status: "withdrawn", amount_cents: 0, free_agent: true });

  describe("cartHeadline", () => {
    it("the empty cart is closed (the empty case, first)", () => {
      expect(cartHeadline([], CART)).toBe("closed");
    });

    // Spec §5.1: the first matching rule wins. Rule 2 is the spec's own: an entry that can be paid here (a Pay button, or offline
    // instructions). The two owed states with no way to pay here (B4 review m1, owner ruling 2026-11-13) never say "Pay to finish
    // entering" and never fall through to "awaiting approval": a card fee owed while card payments are unavailable leads with the
    // card notice (`payUnavailable`), and a fee owed past its pay-by date has lost its place (`closed`, or whatever its siblings say).
    const RULES: { name: string; entries: Entry[]; cart?: Partial<typeof CART>; want: HeadlineKind }[] = [
      { name: "rule 2: an unpaid card entry", entries: [unpaidCard], want: "pay" },
      { name: "rule 2: an offline entry with its fee due", entries: [offlineDue], want: "pay" },
      { name: "m1: a card fee owed while card payments are unavailable", entries: [unpaidCard], cart: { charges_enabled: false }, want: "payUnavailable" },
      { name: "m1: a fee owed past its pay-by date has lost its place", entries: [windowClosed], want: "closed" },
      { name: "m1: a card fee past its pay-by date while cards are unavailable has lost its place too", entries: [windowClosed], cart: { charges_enabled: false }, want: "closed" },
      // m1 precedence pairs: what each of the two lands on beside a sibling.
      { name: "m1 ruling: window_closed + confirmed -> in (the closed entry's card says it lost its place)", entries: [windowClosed, confirmedCard], want: "in" },
      { name: "m1: window_closed + paid awaiting approval -> received (for the paid one alone)", entries: [windowClosed, paidAwaiting], want: "received" },
      { name: "m1: window_closed + waitlisted -> waitlist", entries: [windowClosed, waitlisted], want: "waitlist" },
      { name: "m1: window_closed + a card entry still in its window -> pay", entries: [windowClosed, unpaidCard], want: "pay" },
      { name: "m1: cards unavailable + confirmed -> payUnavailable (an owed fee outranks You're in, as pay does)", entries: [unpaidCard, confirmedCard], cart: { charges_enabled: false }, want: "payUnavailable" },
      { name: "m1: cards unavailable + free awaiting approval -> payUnavailable", entries: [unpaidCard, freeAwaiting], cart: { charges_enabled: false }, want: "payUnavailable" },
      { name: "m1: cards unavailable + an offline fee due -> pay (one of them can be paid here)", entries: [unpaidCard, offlineDue], cart: { charges_enabled: false }, want: "pay" },
      { name: "m1: cards unavailable + window_closed -> payUnavailable", entries: [unpaidCard, windowClosed], cart: { charges_enabled: false }, want: "payUnavailable" },
      // I1: the player pool. A confirmed solo sign-up nobody has placed on a team yet.
      { name: "I1: a confirmed solo sign-up not yet on a team -> pool", entries: [inPool], want: "pool" },
      { name: "I1: once placed on a team -> in", entries: [placedSolo], want: "in" },
      { name: "I1 ruling: pool + a confirmed team entry -> pool (You're in's 'Nothing else to do' would contradict the solo card)", entries: [confirmedCard, inPool], want: "pool" },
      { name: "I1: pool + a placed solo -> pool", entries: [placedSolo, inPool], want: "pool" },
      { name: "I1: pool + waitlisted -> pool", entries: [waitlisted, inPool], want: "pool" },
      { name: "I1: pool + paid awaiting approval -> received (the organiser's decision comes first)", entries: [inPool, paidAwaiting], want: "received" },
      { name: "I1: pool + an unpaid card entry -> pay", entries: [inPool, unpaidCard], want: "pay" },
      { name: "I1: a solo sign-up awaiting approval -> received (not placeable until confirmed)", entries: [soloAwaitingApproval], want: "received" },
      { name: "I1: a solo sign-up that owes its fee -> pay", entries: [soloUnpaid], want: "pay" },
      { name: "I1: a waitlisted solo sign-up -> waitlist, not the pool", entries: [soloWaitlisted], want: "waitlist" },
      { name: "I1: a withdrawn solo sign-up -> closed, not the pool", entries: [soloWithdrawn], want: "closed" },
      { name: "I1: a solo past its pay-by date -> closed, not the pool", entries: [{ ...soloUnpaid, promotion_expires_at: PAST }], want: "closed" },
      { name: "I1, after a withdrawal: a withdrawn solo beside a confirmed team -> in", entries: [confirmedCard, soloWithdrawn], want: "in" },
      { name: "rule 3: a card-paid confirmed entry", entries: [confirmedCard], want: "in" },
      { name: "rule 3: a waived entry is confirmed, not owed", entries: [waived], want: "in" },
      { name: "rule 3: a free confirmed entry", entries: [confirmedFree], want: "in" },
      { name: "rule 4: a paid entry awaiting approval", entries: [paidAwaiting], want: "received" },
      { name: "rule 4: a free entry awaiting approval", entries: [freeAwaiting], want: "received" },
      { name: "rule 5: a waitlisted entry", entries: [waitlisted], want: "waitlist" },
      { name: "rule 6: only withdrawn", entries: [withdrawn], want: "closed" },
      { name: "rule 6: only expired", entries: [expired], want: "closed" },
      { name: "rule 6: only rejected", entries: [rejected], want: "closed" },
      { name: "rule 6: withdrawn + expired + rejected", entries: [withdrawn, expired, rejected], want: "closed" },
      // Precedence pairs (mixed carts).
      { name: "pending-due + confirmed -> pay", entries: [confirmedCard, unpaidCard], want: "pay" },
      { name: "pending-due + waitlisted -> pay", entries: [waitlisted, offlineDue], want: "pay" },
      { name: "confirmed + waitlisted -> in", entries: [confirmedCard, waitlisted], want: "in" },
      { name: "paid + waitlisted -> received", entries: [paidAwaiting, waitlisted], want: "received" },
      { name: "confirmed + paid -> received (rule 3 needs no pending/paid entry)", entries: [confirmedCard, paidAwaiting], want: "received" },
      { name: "confirmed + free pending -> received", entries: [confirmedFree, freeAwaiting], want: "received" },
      { name: "confirmed + withdrawn -> in (an ended sibling changes nothing)", entries: [withdrawn, confirmedCard], want: "in" },
      { name: "waitlisted + withdrawn -> waitlist", entries: [withdrawn, waitlisted], want: "waitlist" },
      { name: "after a withdrawal clears the only debt: confirmed + withdrawn unpaid -> in", entries: [confirmedCard, { ...unpaidCard, status: "withdrawn" }], want: "in" },
    ];

    it("one case per rule and precedence pair (counted)", () => {
      let checked = 0;
      for (const r of RULES) {
        expect(cartHeadline(r.entries, { ...CART, ...r.cart }), r.name).toBe(r.want);
        checked += 1;
      }
      expect(checked).toBe(RULES.length);
      expect(checked).toBeGreaterThan(0);
      // Premise: every headline kind is reached by at least one row, so no kind is asserted vacuously.
      expect(new Set(RULES.map((r) => r.want))).toEqual(
        new Set<HeadlineKind>(["pay", "payUnavailable", "in", "pool", "received", "waitlist", "closed"]),
      );
    });

    // B4 review m1: the `received` headline and its step are worded for a count ("Entries received", "reviews your entries"). An entry
    // owed with no way to pay here is not waiting on the organiser's decision, so it is never counted. Literals, one row per entry state.
    it("receivedCount counts only the entries waiting on the organiser's decision, never an owed one (counted)", () => {
      const COUNTS: { name: string; entries: Entry[]; cart?: Partial<typeof CART>; want: number }[] = [
        { name: "the empty cart (the empty case, first)", entries: [], want: 0 },
        { name: "paid awaiting approval", entries: [paidAwaiting], want: 1 },
        { name: "free awaiting approval", entries: [freeAwaiting], want: 1 },
        { name: "both awaiting", entries: [paidAwaiting, freeAwaiting], want: 2 },
        { name: "window_closed is not awaiting a decision", entries: [windowClosed], want: 0 },
        { name: "window_closed beside a paid one: only the paid one", entries: [windowClosed, paidAwaiting], want: 1 },
        { name: "a card fee owed while cards are unavailable", entries: [unpaidCard, freeAwaiting], cart: { charges_enabled: false }, want: 1 },
        { name: "a fee that can be paid now", entries: [unpaidCard, offlineDue], want: 0 },
        { name: "confirmed, waitlisted and ended entries", entries: [confirmedCard, waitlisted, withdrawn, expired, rejected], want: 0 },
      ];
      let checked = 0;
      for (const r of COUNTS) {
        expect(receivedCount(r.entries, { ...CART, ...r.cart }), r.name).toBe(r.want);
        checked += 1;
      }
      expect(checked).toBe(COUNTS.length);
    });

    it("the order of the entries never changes the answer (a second read of the same cart, reversed)", () => {
      let checked = 0;
      for (const r of RULES) {
        expect(cartHeadline([...r.entries].reverse(), { ...CART, ...r.cart }), r.name).toBe(r.want);
        checked += 1;
      }
      expect(checked).toBeGreaterThan(0);
    });
  });

  describe("cartMoneySummary", () => {
    it("the empty cart pays nothing and owes nothing (the empty case, first)", () => {
      expect(cartMoneySummary([], CART)).toEqual({ paidCents: 0, dueCents: 0, waitlistedCents: 0 });
    });

    it("partial: a card-settled £15 entry and a pending card-due £24 entry -> paid 1500, due 2400", () => {
      expect(cartMoneySummary([confirmedCard, unpaidCard], CART)).toEqual({ paidCents: 1500, dueCents: 2400, waitlistedCents: 0 });
    });

    it("a waived entry is neither paid nor due, although it is confirmed and keeps its £15 fee (FP11)", () => {
      expect(cartMoneySummary([waived], CART)).toEqual({ paidCents: 0, dueCents: 0, waitlistedCents: 0 });
    });

    it("refunded: £15 paid with £5 sent back -> paid 1000", () => {
      expect(cartMoneySummary([{ ...confirmedCard, refunded_cents: 500 }], CART).paidCents).toBe(1000);
    });

    it("an offline (Mark paid) settlement counts as paid, the same as a card", () => {
      expect(cartMoneySummary([{ ...confirmedCard, settled_by: "offline" }], CART).paidCents).toBe(1500);
    });

    it("after a withdrawal: a card-paid entry withdrawn and fully refunded has paid 0; one withdrawn before paying owes 0", () => {
      expect(cartMoneySummary([{ ...confirmedCard, status: "withdrawn", refunded_cents: 1500 }], CART)).toEqual({
        paidCents: 0,
        dueCents: 0,
        waitlistedCents: 0,
      });
      expect(cartMoneySummary([withdrawn], CART)).toEqual({ paidCents: 0, dueCents: 0, waitlistedCents: 0 });
    });

    it("a card-paid entry withdrawn past the refund line stays paid: settlement is history, not status", () => {
      expect(cartMoneySummary([{ ...confirmedCard, status: "withdrawn" }], CART).paidCents).toBe(1500);
    });

    it("paid never goes below 0 when more was sent back than the fee", () => {
      expect(cartMoneySummary([{ ...confirmedCard, refunded_cents: 2000 }], CART).paidCents).toBe(0);
    });

    it("window_closed is still owed: counted in due", () => {
      expect(resolveMoneyState(windowClosed, CART).kind, "premise: this fixture is window_closed").toBe("window_closed");
      expect(cartMoneySummary([windowClosed], CART).dueCents).toBe(2400);
    });

    it("a card fee owed while card payments are unavailable is still owed: counted in due (T15 ruling)", () => {
      const cart = { ...CART, charges_enabled: false };
      expect(resolveMoneyState(unpaidCard, cart).kind, "premise: this fixture is stripe_unavailable").toBe("stripe_unavailable");
      expect(cartMoneySummary([unpaidCard], cart).dueCents).toBe(2400);
    });

    it("an offline fee due is due", () => {
      expect(cartMoneySummary([offlineDue], CART).dueCents).toBe(2400);
    });

    it("a free entry and a free confirmed entry owe and paid nothing", () => {
      expect(cartMoneySummary([freeAwaiting, confirmedFree], CART)).toEqual({ paidCents: 0, dueCents: 0, waitlistedCents: 0 });
    });

    it("a waitlisted entry's would-be fee is kept apart: never paid, never due", () => {
      expect(cartMoneySummary([waitlisted, { ...waitlisted, fee_if_promoted_cents: 1000 }], CART)).toEqual({
        paidCents: 0,
        dueCents: 0,
        waitlistedCents: 2500,
      });
      // The fee a promotion would set is unknown (no settings row): nothing to quote.
      expect(cartMoneySummary([{ ...waitlisted, fee_if_promoted_cents: null }], CART).waitlistedCents).toBe(0);
    });

    // Two surfaces, one set of facts (B4 review m1). The headline says "Pay to finish entering" exactly when an entry can be paid on
    // this page (a Pay button or offline instructions: `stripe_due`, `offline_due`, spec §5.1 rule 2). The money line still names
    // every owed fee, including the two with no way to pay here, so whenever something is due and nothing can be paid, the page
    // never leads with "awaiting approval" for that debt: it leads with the card notice, or with the entry's siblings.
    it("pay exactly when an entry can be paid here; an owed fee with no way to pay never reads as awaiting approval (counted)", () => {
      const palette = [unpaidCard, offlineDue, windowClosed, paidAwaiting, freeAwaiting, confirmedCard, confirmedFree, waived, waitlisted, withdrawn, expired, rejected, inPool, soloUnpaid];
      const PAYABLE = new Set(["stripe_due", "offline_due"]);
      let checked = 0;
      let pays = 0;
      let owedNotPayable = 0;
      for (const charges_enabled of [true, false]) {
        const cart = { ...CART, charges_enabled };
        for (const a of palette) {
          for (const b of palette) {
            const name = `${a.status}/${a.amount_cents} + ${b.status}/${b.amount_cents}, charges ${charges_enabled}`;
            const payable = [a, b].some((e) => PAYABLE.has(resolveMoneyState(e, cart).kind));
            const headline = cartHeadline([a, b], cart);
            expect(headline === "pay", name).toBe(payable);
            if (payable) pays += 1;
            if (!payable && cartMoneySummary([a, b], cart).dueCents > 0) {
              owedNotPayable += 1;
              // Waiting on the organiser is said only for an entry that is: a paid or free one owing nothing.
              const awaiting = [a, b].some((e) => (e.status === "paid" || e.status === "pending") && resolveMoneyState(e, cart).kind === "none");
              if (headline === "received") expect(awaiting, `${name}: received only for an entry awaiting approval`).toBe(true);
            }
            checked += 1;
          }
        }
      }
      expect(checked).toBe(palette.length * palette.length * 2);
      // Every direction is exercised, or the equivalence is vacuous.
      expect(pays).toBeGreaterThan(0);
      expect(checked - pays).toBeGreaterThan(0);
      expect(owedNotPayable, "pairs owing a fee nobody can pay here").toBeGreaterThan(0);
    });
  });

  describe("moneyLine (spec §5.3 rendering table)", () => {
    const sum = (paidCents: number, dueCents: number, waitlistedCents: number) => ({ paidCents, dueCents, waitlistedCents });
    it("nothing paid, nothing due, nothing waiting: Nothing to pay (the empty case, first)", () => {
      expect(moneyLine(sum(0, 0, 0))).toBe("nothing");
    });
    const TABLE: [ReturnType<typeof sum>, ReturnType<typeof moneyLine>][] = [
      [sum(1500, 2400, 0), "paidDue"],
      [sum(1500, 2400, 1500), "paidDue"],
      [sum(1500, 0, 0), "paid"],
      [sum(1500, 0, 1500), "paid"],
      [sum(0, 2400, 0), "due"],
      [sum(0, 2400, 1500), "due"],
      [sum(0, 0, 1500), "waitlisted"],
    ];
    it("one row per condition (counted)", () => {
      let checked = 0;
      for (const [s, want] of TABLE) {
        expect(moneyLine(s), JSON.stringify(s)).toBe(want);
        checked += 1;
      }
      expect(checked).toBe(TABLE.length);
    });
  });

  describe("whatHappensNext (spec §5.2: real data only)", () => {
    // A fixed "now" (12:00 UTC on 13 Nov 2026), so the competition dates below never go stale against the real clock.
    const NOW = new Date("2026-11-13T12:00:00.000Z");
    type View = Parameters<typeof whatHappensNext>[0];
    const view = (over: Partial<View> = {}): View => ({
      competition_name: "Summer Smash",
      competition_starts_on: null,
      competition_ends_on: null,
      venue_name: null,
      expires_at: FUTURE,
      charges_enabled: true,
      org_timezone: "UTC",
      entries: [],
      ...over,
    });

    it("no dates, no venue and a closed cart: no items, so the section is not shown (the empty case, first)", () => {
      expect(whatHappensNext(view(), "closed", NOW)).toEqual([]);
    });

    // B4 review m7: "{name} starts on {date}" is not a next step once the competition is over. The dates line goes when its last day
    // (ends_on, else starts_on) is before today, today read in the org's own zone. Expected values from that rule, a row per case.
    it("the dates line goes once the competition's last day is before today, and stays until then (counted)", () => {
      const CASES: { name: string; start: string; end: string | null; tz?: string; now?: string; kept: boolean }[] = [
        { name: "a one-day event yesterday", start: "2026-11-12", end: null, kept: false },
        { name: "a one-day event today", start: "2026-11-13", end: null, kept: true },
        { name: "a one-day event tomorrow", start: "2026-11-14", end: null, kept: true },
        { name: "a run that ended yesterday", start: "2026-11-10", end: "2026-11-12", kept: false },
        { name: "a run that ends today", start: "2026-11-10", end: "2026-11-13", kept: true },
        { name: "a run under way (started, not ended)", start: "2026-11-12", end: "2026-11-20", kept: true },
        { name: "a run still ahead", start: "2026-12-05", end: "2026-12-07", kept: true },
        { name: "a start long past, ends_on equal", start: "2026-01-01", end: "2026-01-01", kept: false },
        // The org's zone decides "today": 23:30 UTC on 13 Nov is already 14 Nov in Auckland (UTC+13), so a 13 Nov event is over there.
        { name: "Auckland: past midnight, the 13th is over", start: "2026-11-13", end: null, tz: "Pacific/Auckland", now: "2026-11-13T23:30:00.000Z", kept: false },
        { name: "UTC at the same instant: the 13th is today", start: "2026-11-13", end: null, tz: "UTC", now: "2026-11-13T23:30:00.000Z", kept: true },
      ];
      let checked = 0;
      let dropped = 0;
      for (const c of CASES) {
        const items = whatHappensNext(
          view({ competition_starts_on: c.start, competition_ends_on: c.end, org_timezone: c.tz ?? "UTC" }),
          "closed",
          c.now ? new Date(c.now) : NOW,
        );
        expect(items.some((i) => i.kind === "dates"), c.name).toBe(c.kept);
        checked += 1;
        if (!c.kept) dropped += 1;
      }
      expect(checked).toBe(CASES.length);
      expect(dropped, "both directions").toBeGreaterThan(0);
      expect(checked - dropped).toBeGreaterThan(0);
    });

    it("a past competition keeps the venue and the step: only the dates line goes", () => {
      const items = whatHappensNext(
        view({ competition_starts_on: "2026-11-01", competition_ends_on: "2026-11-02", venue_name: "Riverside Courts", entries: [confirmedCard] }),
        "in",
        NOW,
      );
      expect(items.map((i) => i.kind)).toEqual(["venue", "step"]);
    });

    it("a closed cart adds no step, even with dates and a venue", () => {
      const items = whatHappensNext(view({ competition_starts_on: "2026-12-05", venue_name: "Riverside Courts" }), "closed", NOW);
      expect(items.map((i) => i.kind)).toEqual(["dates", "venue"]);
    });

    it("a one-day event (ends_on equal to starts_on) says 'starts on'", () => {
      expect(whatHappensNext(view({ competition_starts_on: "2026-12-05", competition_ends_on: "2026-12-05" }), "closed", NOW)).toEqual([
        { kind: "dates", key: "register.status.next.starts", vars: { name: "Summer Smash", date: "2026-12-05" } },
      ]);
    });

    it("no ends_on says 'starts on'", () => {
      expect(whatHappensNext(view({ competition_starts_on: "2026-12-05" }), "closed", NOW)[0]!.key).toBe("register.status.next.starts");
    });

    it("an ends_on that differs says 'runs {start} to {end}'", () => {
      expect(whatHappensNext(view({ competition_starts_on: "2026-12-05", competition_ends_on: "2026-12-07" }), "closed", NOW)).toEqual([
        { kind: "dates", key: "register.status.next.runs", vars: { name: "Summer Smash", start: "2026-12-05", end: "2026-12-07" } },
      ]);
    });

    it("an ends_on with no starts_on invents no start: no dates item", () => {
      expect(whatHappensNext(view({ competition_ends_on: "2026-12-07" }), "closed", NOW)).toEqual([]);
    });

    it("a venue is named only when the read model names one", () => {
      expect(whatHappensNext(view({ venue_name: "Riverside Courts" }), "closed", NOW)).toEqual([
        { kind: "venue", key: "register.status.next.venue", vars: { venue: "Riverside Courts" } },
      ]);
    });

    it("dates, then venue, then the step: at most three items", () => {
      const items = whatHappensNext(
        view({ competition_starts_on: "2026-12-05", venue_name: "Riverside Courts", entries: [waitlisted] }),
        "waitlist",
        NOW,
      );
      expect(items.map((i) => i.kind)).toEqual(["dates", "venue", "step"]);
    });

    describe("the step, by headline", () => {
      it("pay: names the EARLIEST pay-by deadline among the entries due", () => {
        const promoted = { ...unpaidCard, promotion_expires_at: SOONER };
        expect(whatHappensNext(view({ entries: [unpaidCard, promoted] }), "pay", NOW)).toEqual([
          { kind: "step", key: "register.status.next.payBy", vars: { deadline: SOONER } },
        ]);
      });

      it("pay with no deadline anywhere: 'Pay to keep your place', no invented date", () => {
        expect(whatHappensNext(view({ expires_at: null, entries: [offlineDue] }), "pay", NOW)).toEqual([
          { kind: "step", key: "register.status.next.pay", vars: {} },
        ]);
      });

      it("pay beside an entry past its deadline: names only the date still ahead, never one that has gone by", () => {
        expect(whatHappensNext(view({ entries: [windowClosed, unpaidCard] }), "pay", NOW)).toEqual([
          { kind: "step", key: "register.status.next.payBy", vars: { deadline: FUTURE } },
        ]);
      });

      // B4 review m1: neither owed state with no way to pay here may say "Pay to keep your place". Read through the real headline, so
      // the step is the one the page shows for that cart.
      it("a fee past its deadline alone: the cart is closed and adds no step", () => {
        const v = view({ entries: [windowClosed] });
        expect(cartHeadline(v.entries, v), "premise: the headline").toBe("closed");
        expect(whatHappensNext(v, cartHeadline(v.entries, v), NOW)).toEqual([]);
      });

      it("a card fee owed while cards are unavailable: the headline is the card notice and there is no pay step", () => {
        const v = view({ charges_enabled: false, entries: [unpaidCard] });
        expect(cartHeadline(v.entries, v), "premise: the headline").toBe("payUnavailable");
        expect(whatHappensNext(v, cartHeadline(v.entries, v), NOW)).toEqual([]);
      });

      it("received: the organiser reviews, counted over the entries awaiting the decision", () => {
        expect(whatHappensNext(view({ entries: [paidAwaiting, freeAwaiting, waitlisted] }), "received", NOW)).toEqual([
          { kind: "step", key: "register.status.next.received", vars: {}, count: 2 },
        ]);
        expect(whatHappensNext(view({ entries: [paidAwaiting] }), "received", NOW)[0]!.count).toBe(1);
        // m1: an entry past its pay-by date is not awaiting a decision, so it is not counted ("your entry", not "your entries").
        expect(whatHappensNext(view({ entries: [paidAwaiting, windowClosed] }), "received", NOW)[0]!.count).toBe(1);
      });

      it("pool: the organiser places you on a team, and this page shows it", () => {
        expect(whatHappensNext(view({ entries: [inPool, confirmedCard] }), "pool", NOW)).toEqual([
          { kind: "step", key: "register.status.next.pool", vars: {} },
        ]);
      });

      it("waitlist: this page shows a promotion", () => {
        expect(whatHappensNext(view({ entries: [waitlisted] }), "waitlist", NOW)).toEqual([
          { kind: "step", key: "register.status.next.waitlist", vars: {} },
        ]);
      });

      const pending = (id: string) => ({ id, consent_status: "pending" as const });
      const joined = (id: string) => ({ id, consent_status: "granted" as const });

      it("in, with a teammate still to join: send the invite links", () => {
        const team = { ...confirmedCard, join_code: "JOIN1", players: [joined("p1"), pending("p2")] };
        expect(whatHappensNext(view({ entries: [team] }), "in", NOW)).toEqual([{ kind: "step", key: "register.status.next.invite", vars: {} }]);
      });

      it("in, with everyone joined (only the general link left): nothing else to do", () => {
        const team = { ...confirmedCard, join_code: "JOIN1", players: [joined("p1"), joined("p2")] };
        expect(whatHappensNext(view({ entries: [team] }), "in", NOW)).toEqual([{ kind: "step", key: "register.status.next.done", vars: {} }]);
      });

      it("in, with no join code at all: nothing else to do", () => {
        expect(whatHappensNext(view({ entries: [confirmedCard] }), "in", NOW)[0]!.key).toBe("register.status.next.done");
      });

      it("in, after a withdrawal: a withdrawn sibling's unclaimed slot asks for no invite (its link is dead)", () => {
        const deadTeam = { ...withdrawn, join_code: "JOIN2", players: [pending("p3")] };
        expect(whatHappensNext(view({ entries: [confirmedCard, deadTeam] }), "in", NOW)[0]!.key).toBe("register.status.next.done");
      });
    });

    // Spec §5.2: no item promises an email, and the check-in wording belongs to the roster (FP9). Swept over every locale's own
    // `register.status.next.*` copy, so a translation cannot reintroduce the promise either.
    it("no next-step copy in any locale mentions email or checking in (counted)", () => {
      const FORBIDDEN = /e-?mail|correo|courriel|check[- ]?in|inchecken|registro de llegada/i;
      let checked = 0;
      for (const [locale, dict] of Object.entries({ en: uiEn, es: uiEs, fr: uiFr, nl: uiNl })) {
        const keys = Object.keys(dict).filter((k) => k.startsWith("register.status.next."));
        expect(keys.length, `${locale} carries the next-step copy`).toBeGreaterThan(0);
        for (const k of keys) {
          expect((dict as Record<string, string>)[k], `${locale} ${k}`).not.toMatch(FORBIDDEN);
          checked += 1;
        }
      }
      expect(checked).toBeGreaterThan(0);
    });

    it("every key a next item can carry exists in every locale (counted)", () => {
      const KEYS = ["starts", "runs", "venue", "payBy", "pay", "received.one", "received.other", "pool", "waitlist", "invite", "done", "title"];
      let checked = 0;
      for (const [locale, dict] of Object.entries({ en: uiEn, es: uiEs, fr: uiFr, nl: uiNl })) {
        for (const k of KEYS) {
          expect((dict as Record<string, string>)[`register.status.next.${k}`], `${locale} register.status.next.${k}`).toEqual(
            expect.any(String),
          );
          checked += 1;
        }
      }
      expect(checked).toBe(KEYS.length * 4);
    });
  });

  // The page words each headline kind from one key (page.tsx; `received` is a plural family, `payUnavailable` the card notice).
  it("every headline kind's copy exists in every locale (counted)", () => {
    const KEYS: Record<HeadlineKind, string[]> = {
      pay: ["register.status.headline.pay"],
      payUnavailable: ["register.status.pay.unavailable"],
      received: ["register.status.headline.received.one", "register.status.headline.received.other"],
      pool: ["register.status.headline.pool"],
      in: ["register.status.headline.in"],
      waitlist: ["register.status.headline.waitlist"],
      closed: ["register.status.headline.closed"],
    };
    let checked = 0;
    for (const [locale, dict] of Object.entries({ en: uiEn, es: uiEs, fr: uiFr, nl: uiNl })) {
      for (const k of Object.values(KEYS).flat()) {
        expect((dict as Record<string, string>)[k], `${locale} ${k}`).toEqual(expect.any(String));
        checked += 1;
      }
    }
    expect(checked).toBe(8 * 4);
  });
});
