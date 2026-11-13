// RS007 rebuild — the real registrant surface (RS006 §C shipped a
// deliberately minimal render; this replaces it). Same renderToStaticMarkup
// pattern as register-page-live.test.tsx (no jsdom in this workspace) and
// the same "mock the usecase, not the DB" convention. EntryCard/PayButton/
// CancelEntry/ResendConfirmation each have their own focused unit tests
// (entry-card is exercised indirectly here since it is a plain, non-async
// component composed straight into this render) — this file covers page-
// level ORCHESTRATION: reconcile ordering/gating, not-found handling, and
// that the resolved view's data actually reaches the right sections.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { fmtDateTime, fmtPublicDeadline, fmtZoneAbbrev } from "@/lib/format";
import { BTN_QUIET_LINK } from "@/components/public-site/register/styles";
import uiEn from "@/dictionaries/en/ui.json";

vi.mock("@/lib/resolve-locale", () => ({ resolveLocale: async () => "en" }));

// CancelEntry (rendered per live entry) reads useRouter() and useConfirm()
// at render time — renderToStaticMarkup has no App Router context and no
// <ConfirmProvider> in the tree, matching the established convention
// (stages-panel-delete.test.tsx and siblings).
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: () => {} }) }));
vi.mock("@/components/ui/confirm-provider", () => ({
  useConfirm: () => async () => false,
}));

const usecaseMock = vi.hoisted(() => ({
  groupById: vi.fn(),
  reconcile: vi.fn(),
}));
vi.mock("@/server/usecases/registrations", () => ({
  groupById: (...args: unknown[]) => usecaseMock.groupById(...args),
  reconcileRegistrationGroupBySession: (...args: unknown[]) => usecaseMock.reconcile(...args),
}));

beforeEach(() => {
  usecaseMock.groupById.mockReset();
  usecaseMock.reconcile.mockReset().mockResolvedValue(true);
});

import StatusPage from "../page";

const render = async (searchParams: Record<string, string>): Promise<string> =>
  renderToStaticMarkup(
    await StatusPage({
      params: Promise.resolve({ orgSlug: "riverside", competitionSlug: "summer-smash" }),
      searchParams: Promise.resolve(searchParams),
    }),
  );

// Deliberately far past/future — resolveMoneyState's FIX #8 reads
// money.deadline (and, through it, this fixture's `expires_at`) against the
// REAL wall clock (Date.now()), so a date merely "later than when this
// fixture was written" goes stale the moment real time catches up to it and
// every card in this file would silently start rendering window_closed.
// Mirrors view-model.test.ts's own FUTURE/PAST convention.
const FUTURE = "2099-01-01T00:00:00.000Z";

/** The invite block's words, read from the English dictionary (never typed here), for the page's own locale. */
const invite = (key: string, vars: Record<string, string> = {}): string =>
  Object.entries(vars).reduce(
    (text, [k, v]) => text.replaceAll(`{${k}}`, v),
    (uiEn as Record<string, string>)[`register.status.invite.${key}`]!,
  );

const BASE_ENTRY = {
  id: "reg-1",
  division_id: "div-1",
  division_name: "Mixed Doubles",
  display_name: "Team Alpha",
  status: "pending" as const,
  // RS008 review fix #1: "Team Alpha" is semantically a team already (this
  // fixture predates the field) — the heading-masking regression it cannot
  // see is exercised by its own dedicated test below, with an explicit
  // "individual" override.
  entrant_kind: "team" as const,
  amount_cents: 2500,
  free_agent: false,
  join_code: null as string | null,
  allows_new_joiner: true,
  promotion_expires_at: null as string | null,
  // RS007 review fix #10: payment_method now lives on the ENTRY (its own
  // division's registration_settings.payment_method), never the cart —
  // see resolveMoneyState's own doc comment (view-model.ts).
  payment_method: "stripe" as const,
  // Polish wave P3: this entry's own division's review mode, and the fee a promotion off the waitlist would set (waitlisted only).
  approval: "auto" as "auto" | "manual",
  approved: false,
  fee_if_promoted_cents: null as number | null,
  // B3 T13: a waitlisted entry's place in its division's queue (GroupEntryView.waitlist_position), null on every other entry.
  waitlist_position: null as number | null,
  // RS008: this entry's own division youth/player_name_display policy —
  // threaded onto GroupEntryView (buildGroupStatusView, usecases/registrations/group-status.ts).
  division_youth: false,
  division_player_name_display: null as string | null,
  players: [] as {
    id: string;
    full_name: string;
    consent_status: "pending" | "granted" | "guardian";
    consent: { public_name?: boolean } | null;
  }[],
  refund_policy: { refundable: true, deadline: "2026-09-15T00:00:00.000Z", amount_cents: 2500 },
  refunded_cents: 0,
  // B4 T14: how this entry's fee was settled (GroupEntryView.settled_by), history not status. null = nothing settled it.
  settled_by: null as "card" | "offline" | "waived" | null,
  // B5 T18: the reference to quote for THIS entry (GroupEntryView.entry_ref): the cart's with its place in the cart, in a cart sent
  // with two or more entries. BASE_VIEW's cart was sent with two.
  entry_ref: "SZ-TEST-01-1" as string | null,
};

const BASE_VIEW = {
  ref_code: "SZ-TEST-01" as string | null,
  // B5 T18: how many entries the cart was sent with (GroupStatusView.cart_size, stored, never shrinks).
  cart_size: 2,
  contact_name: "Alex Test",
  // B4 T15: the address the confirmation went to ("Confirmation sent to {email}.").
  contact_email: "alex@example.test",
  currency: "gbp",
  amount_cents: 2500,
  payment_method: "stripe" as const,
  expires_at: FUTURE,
  refunded_cents: 0,
  competition_name: "Summer Smash",
  // B4 T14: the competition's own dates and the one venue its published fixtures share; unset here, so "What happens next" has
  // only its step.
  competition_starts_on: null as string | null,
  competition_ends_on: null as string | null,
  venue_name: null as string | null,
  competition_slug: "summer-smash",
  org_slug: "riverside",
  org_name: "Riverside CC",
  created_at: "2026-08-20T10:00:00.000Z",
  charges_enabled: true,
  payment_instructions: null as string | null,
  // RS007 review fix #13(a): the org's own timezone, threaded onto
  // GroupStatusView (buildGroupStatusView, usecases/registrations/group-status.ts).
  org_timezone: "UTC",
  entries: [
    BASE_ENTRY,
    {
      ...BASE_ENTRY,
      id: "reg-2",
      division_id: "div-2",
      division_name: "Womens 35+",
      display_name: "Alex Test",
      status: "waitlisted" as const,
      amount_cents: 0,
      refund_policy: { refundable: false, deadline: null, amount_cents: 0 },
      entry_ref: "SZ-TEST-01-2" as string | null,
    },
  ],
};

describe("register status page (RS007 rebuild)", () => {
  it("renders the group ref, every entry's division/status, and the live (non-waitlisted) subtotal", async () => {
    usecaseMock.groupById.mockResolvedValueOnce(BASE_VIEW);
    const html = await render({ rid: "g1", token: "tok" });
    expect(html).toContain("SZ-TEST-01");
    expect(html).toContain("Mixed Doubles");
    expect(html).toContain("Womens 35+");
    expect(html).toContain(">pending<");
    expect(html).toContain(">waitlisted<");
    // Subtotal excludes the waitlisted (amount_cents 0) entry — same as the
    // single pending entry's own fee.
    expect(html).toContain("£25.00");
    expect(usecaseMock.groupById).toHaveBeenCalledWith("g1", "tok");
  });

  // B3 T13: the read model's place reaches the waitlisted entry's own card through the page (the seam between `groupById` and
  // `EntryCard`), and only that card: the pending entry beside it states none.
  it("a waitlisted entry's place in the queue reaches its card, and only its card", async () => {
    usecaseMock.groupById.mockResolvedValueOnce({
      ...BASE_VIEW,
      entries: BASE_VIEW.entries.map((e) => (e.status === "waitlisted" ? { ...e, waitlist_position: 4 } : e)),
    });
    const html = (await render({ rid: "g1", token: "tok" })).replace(/&#x27;/g, "'");
    expect(html).toContain("You're #4 on the waiting list");
    expect(html.match(/data-testid="reg-status-waitlist-position"/g)?.length, "one waitlisted card, one place").toBe(1);
  });

  // B2 T8 (spec §7.2): the org header scrolls away on a phone only where `data-register-flow` is on the page (the register stepper). The
  // status page is where a person comes back to check or pay, and its header stays sticky: the marker must not be here.
  it("does not carry data-register-flow, so the org header stays sticky on the status page", async () => {
    usecaseMock.groupById.mockResolvedValueOnce(BASE_VIEW);
    const html = await render({ rid: "g1", token: "tok" });
    expect(html, "anti-vacuity: this is the real status page, not an empty render").toContain("SZ-TEST-01");
    expect(html).not.toContain("data-register-flow");
  });

  // RS008 review fix #9 (RS009 handoff) — gated ONLY on free_agent, no other
  // condition (see awaitingTeamAssignment's own doc comment for why this is
  // deliberately incomplete and owed to RS009).
  it("shows 'Waiting for a team' for a free-agent entry, and never for an ordinary one", async () => {
    usecaseMock.groupById.mockResolvedValueOnce({
      ...BASE_VIEW,
      entries: [{ ...BASE_ENTRY, free_agent: true }],
    });
    const html = await render({ rid: "g1", token: "tok" });
    expect(html).toContain("Waiting for a team");
  });

  it("never shows 'Waiting for a team' for an ordinary (non-free-agent) entry", async () => {
    usecaseMock.groupById.mockResolvedValueOnce(BASE_VIEW); // both entries free_agent: false
    const html = await render({ rid: "g1", token: "tok" });
    expect(html).not.toContain("Waiting for a team");
  });

  it("shows a plain not-found message, and never calls groupById, when rid/token are missing", async () => {
    const html = await render({});
    // "couldn't" renders as the HTML entity &#x27; under renderToStaticMarkup
    // — assert on a substring either side of the apostrophe, not through it.
    expect(html).toContain("find that registration");
    expect(usecaseMock.groupById).not.toHaveBeenCalled();
  });

  it("shows the SAME not-found message when groupById 404s (wrong token / nonexistent id) — never a raw error page", async () => {
    const { HttpError } = await import("@/lib/errors");
    usecaseMock.groupById.mockRejectedValueOnce(new HttpError(404, "registration not found"));
    const html = await render({ rid: "g1", token: "wrong" });
    expect(html).toContain("find that registration");
  });

  it("lets a non-404 error propagate rather than masking it as 'not found'", async () => {
    usecaseMock.groupById.mockRejectedValueOnce(new Error("db unreachable"));
    await expect(render({ rid: "g1", token: "tok" })).rejects.toThrow("db unreachable");
  });

  describe("reconcile-on-load (acceptance criterion 1)", () => {
    it("reconciles BEFORE the read on a checkout=success return, so a webhook-suppressed payment already reads confirmed on first view", async () => {
      const callOrder: string[] = [];
      usecaseMock.reconcile.mockImplementationOnce(async () => {
        callOrder.push("reconcile");
        return true;
      });
      usecaseMock.groupById.mockImplementationOnce(async () => {
        callOrder.push("read");
        return { ...BASE_VIEW, entries: [{ ...BASE_ENTRY, status: "confirmed" as const }] };
      });

      const html = await render({ rid: "g1", token: "tok", checkout: "success", session_id: "cs_test_123" });

      expect(usecaseMock.reconcile).toHaveBeenCalledWith("g1", "tok", "cs_test_123");
      expect(callOrder).toEqual(["reconcile", "read"]);
      expect(html).toContain(">confirmed<");
    });

    it("does NOT reconcile on a plain visit (no checkout param)", async () => {
      usecaseMock.groupById.mockResolvedValueOnce(BASE_VIEW);
      await render({ rid: "g1", token: "tok" });
      expect(usecaseMock.reconcile).not.toHaveBeenCalled();
    });

    it("does NOT reconcile without a session_id, even on checkout=success", async () => {
      usecaseMock.groupById.mockResolvedValueOnce(BASE_VIEW);
      await render({ rid: "g1", token: "tok", checkout: "success" });
      expect(usecaseMock.reconcile).not.toHaveBeenCalled();
    });
  });

  describe("money — never a debt named with no route to settle (acceptance criterion 2)", () => {
    it("an unpaid CARD entry renders a working pay control naming the amount", async () => {
      usecaseMock.groupById.mockResolvedValueOnce(BASE_VIEW);
      const html = await render({ rid: "g1", token: "tok" });
      expect(html).toContain("£25.00");
      expect(html).toMatch(/Pay now/);
    });

    it("an unpaid OFFLINE entry renders the resolved payment instructions, {{reference}} filled in with the ref code", async () => {
      usecaseMock.groupById.mockResolvedValueOnce({
        ...BASE_VIEW,
        payment_method: "offline" as const,
        payment_instructions: "Send to club@example.com, quoting {{reference}}.",
        // RS007 review fix #10: money state now reads the ENTRY's own
        // payment_method, not the cart's (above) — both must agree here for
        // this to still exercise the offline_due branch under test.
        entries: BASE_VIEW.entries.map((e) => ({ ...e, payment_method: "offline" as const })),
      });
      const html = await render({ rid: "g1", token: "tok" });
      expect(html).toContain("club@example.com");
      expect(html).toContain("SZ-TEST-01");
      expect(html).not.toContain("{{reference}}");
      // No pay button when the method is offline.
      expect(html).not.toMatch(/Pay now/);
      // Bug (2026-08-27 review, FIX 1): formatMinor(entry.amount_cents, …)
      // used to appear ONLY inside the stripe_due "Pay now — {amount}"
      // label, so an offline-due card showed instructions and a deadline
      // with no figure to actually transfer. The page's own Subtotal line
      // ALSO renders "£25" on its own (summed from this same single entry)
      // — a plain `toContain` would pass on that alone, so this counts
      // exact, tag-flanked occurrences: 1 is just the Subtotal, 2 proves
      // the card itself shows its own figure too.
      expect(
        (html.match(/>£25\.00</g) || []).length,
        "the offline-due card itself must show its own fee (the money line reads \"£25.00 due\", never a bare figure)",
      ).toBe(1);
    });


    // Registration redesign B5 T18 (spec §6.3). The hero keeps the CART's reference; each card of a 2+ cart quotes its own.
    describe("per-entry reference (B5 T18)", () => {
      /** The entry-reference lines of the page, in card order. */
      const cardRefs = (html: string): string[] => [...html.matchAll(/data-testid="reg-status-entry-ref" data-entry-ref="([^"]*)"/g)].map((m) => m[1]!);
      const offlineView = (over: Record<string, unknown>) => ({
        ...BASE_VIEW,
        payment_method: "offline" as const,
        payment_instructions: "Send to club@example.com, quoting {{reference}}.",
        ...over,
      });
      const dueEntry = (n: number, over: Record<string, unknown> = {}) => ({
        ...BASE_ENTRY,
        id: `reg-${n}`,
        payment_method: "offline" as const,
        entry_ref: `SZ-TEST-01-${n}`,
        ...over,
      });

      it("every card of a 2+ cart names its own reference, in card order, and the hero still names the cart's", async () => {
        usecaseMock.groupById.mockResolvedValueOnce(BASE_VIEW);
        const html = await render({ rid: "g1", token: "tok" });
        expect(cardRefs(html)).toEqual(["SZ-TEST-01-1", "SZ-TEST-01-2"]);
        const hero = html.match(/<section[^>]*data-testid="reg-status-ref"[\s\S]*?<\/section>/)?.[0];
        expect(hero, "the hero is still there").toContain(">SZ-TEST-01<");
        expect(hero).not.toContain("SZ-TEST-01-");
        // The label is the dictionary's own, read from the English file (never typed here).
        const [lead] = (uiEn as Record<string, string>)["register.status.entry.reference"]!.split("{reference}");
        expect(html).toContain(lead!);
      });

      it("a one-entry cart prints none on its card: it would only repeat the hero", async () => {
        usecaseMock.groupById.mockResolvedValueOnce({
          ...BASE_VIEW,
          cart_size: 1,
          entries: [{ ...BASE_ENTRY, entry_ref: "SZ-TEST-01" }],
        });
        const html = await render({ rid: "g1", token: "tok" });
        expect(html, "anti-vacuity: the card and the hero rendered").toContain(">SZ-TEST-01<");
        expect(html).toContain("Mixed Doubles");
        expect(cardRefs(html)).toEqual([]);
        expect(html).not.toContain('data-testid="reg-status-entry-ref"');
      });

      it("the lone survivor of a cart sent with three still prints its own -3 (the size is what it was sent with)", async () => {
        usecaseMock.groupById.mockResolvedValueOnce({
          ...BASE_VIEW,
          cart_size: 3,
          entries: [{ ...BASE_ENTRY, entry_ref: "SZ-TEST-01-3" }],
        });
        expect(cardRefs(await render({ rid: "g1", token: "tok" }))).toEqual(["SZ-TEST-01-3"]);
      });

      it("a cart with no reference (the mint ran out of retries) prints no entry reference and no hero", async () => {
        usecaseMock.groupById.mockResolvedValueOnce({
          ...BASE_VIEW,
          ref_code: null,
          entries: BASE_VIEW.entries.map((e) => ({ ...e, entry_ref: null })),
        });
        const html = await render({ rid: "g1", token: "tok" });
        expect(html, "anti-vacuity: the page still rendered").toContain("Mixed Doubles");
        expect(cardRefs(html)).toEqual([]);
        expect(html).not.toContain('data-testid="reg-status-ref"');
      });

      it("offline instructions with TWO entries due quote the cart's reference, which finds both", async () => {
        usecaseMock.groupById.mockResolvedValueOnce(offlineView({ entries: [dueEntry(1), dueEntry(2)] }));
        const html = await render({ rid: "g1", token: "tok" });
        expect(html.match(/quoting SZ-TEST-01\./g)?.length, "both due cards carry the instructions with the cart's reference").toBe(2);
        expect(html).not.toContain("quoting SZ-TEST-01-");
      });

      it("offline instructions with exactly ONE entry due quote that entry's own reference, whichever place it holds", async () => {
        for (const [due, other] of [[2, 1], [1, 2]] as const) {
          usecaseMock.groupById.mockResolvedValueOnce(
            offlineView({ entries: [dueEntry(other, { status: "confirmed" as const }), dueEntry(due)].sort((a, b) => a.id.localeCompare(b.id)) }),
          );
          const html = await render({ rid: "g1", token: "tok" });
          expect(html.match(/quoting SZ-TEST-01-\d\./g), `entry ${due} is the one due`).toEqual([`quoting SZ-TEST-01-${due}.`]);
        }
      });

      it("a withdrawn sibling does not hand the survivor the bare reference: entry 2 still quotes -2", async () => {
        usecaseMock.groupById.mockResolvedValueOnce(
          offlineView({ entries: [dueEntry(1, { status: "withdrawn" as const }), dueEntry(2)] }),
        );
        const html = await render({ rid: "g1", token: "tok" });
        expect(html.match(/quoting SZ-TEST-01[-\d]*\./g)).toEqual(["quoting SZ-TEST-01-2."]);
      });

      it("a one-entry cart owing its fee quotes the bare reference", async () => {
        usecaseMock.groupById.mockResolvedValueOnce(
          offlineView({ cart_size: 1, entries: [dueEntry(1, { entry_ref: "SZ-TEST-01" })] }),
        );
        const html = await render({ rid: "g1", token: "tok" });
        expect(html.match(/quoting SZ-TEST-01[-\d]*\./g)).toEqual(["quoting SZ-TEST-01."]);
      });
    });

    // Bug (2026-08-27 browser sweep): payment_instructions is Markdown, and a
    // single \n is insignificant whitespace to Markdown — only a blank line
    // starts a new paragraph — so multi-line bank details rendered as ONE
    // run-on paragraph ("Account name: X Sort code: Y"), which at 320px
    // wraps into false groupings. The blank-line break must still work.
    it("an unpaid OFFLINE entry keeps each line of multi-line payment instructions on its own line", async () => {
      usecaseMock.groupById.mockResolvedValueOnce({
        ...BASE_VIEW,
        payment_method: "offline" as const,
        payment_instructions:
          "Please pay using these details:\n\nBank: Example Bank\nAccount name: RS007 Seed Org\nSort code: 12-34-56\nAccount number: 12345678\nReference: {{reference}}",
        entries: BASE_VIEW.entries.map((e) => ({ ...e, payment_method: "offline" as const })),
      });
      const html = await render({ rid: "g1", token: "tok" });
      expect(html).toContain("Bank: Example Bank<br>");
      expect(html).toContain("Account name: RS007 Seed Org<br>");
      expect(html).toContain("Sort code: 12-34-56<br>");
      // The tell for the bug: never space-joined into one run-on paragraph.
      expect(html).not.toContain("Account name: RS007 Seed Org Sort code:");
    });

    it("a card entry with the org's Connect account not live shows 'unavailable', never a button that would 503", async () => {
      usecaseMock.groupById.mockResolvedValueOnce({ ...BASE_VIEW, charges_enabled: false });
      const html = await render({ rid: "g1", token: "tok" });
      expect(html).not.toMatch(/Pay now/);
      expect(html).toContain("aren&#x27;t available right now");
      // FIX 1: stripe_unavailable used to render no figure at all either.
      // Same "Subtotal alone would satisfy a plain toContain" trap as the
      // offline case above — count exact, tag-flanked occurrences instead.
      expect(
        (html.match(/>£25\.00</g) || []).length,
        "the stripe_unavailable card itself must show its own fee (the money line reads \"£25.00 due\", never a bare figure)",
      ).toBe(1);
    });

    // B4 fix round 3 (re-review gap): the expiry pass expires a card entry at its pay-by date whatever the org's Stripe state, so the
    // unavailable card names that date — the time the person has to sort the payment with the organiser.
    it("a card fee owed while cards are unavailable names its pay-by date", async () => {
      usecaseMock.groupById.mockResolvedValueOnce({ ...BASE_VIEW, charges_enabled: false, entries: [BASE_ENTRY] });
      const html = (await render({ rid: "g1", token: "tok" })).replace(/&#x27;/g, "'");
      expect(html).toContain(`>Pay by ${fmtPublicDeadline("en", "UTC", FUTURE)}<`);
    });

    // B4 fix round 3 (re-review gap): an offline fee with no instructions from the organiser shows the fee and the date, never a
    // "How to pay" heading with nothing under it. With instructions, the heading stays.
    it("an offline fee with no instructions has no empty 'How to pay' heading; with instructions it keeps it", async () => {
      const offline = { ...BASE_VIEW, payment_method: "offline" as const, entries: [{ ...BASE_ENTRY, payment_method: "offline" as const }] };
      usecaseMock.groupById.mockResolvedValueOnce({ ...offline, payment_instructions: null });
      const bare = await render({ rid: "g1", token: "tok" });
      expect(bare, "premise: the fee is still named").toMatch(/>£25\.00</);
      expect(bare).not.toContain(">How to pay<");
      usecaseMock.groupById.mockResolvedValueOnce({ ...offline, payment_instructions: "Bank: Example Bank" });
      const withText = await render({ rid: "g1", token: "tok" });
      expect(withText).toContain(">How to pay<");
      expect(withText).toContain("Bank: Example Bank");
    });

    it("a confirmed entry still names its own fee — no Pay control, no instructions, but not a blank money section (FIX 1)", async () => {
      usecaseMock.groupById.mockResolvedValueOnce({
        ...BASE_VIEW,
        entries: [{ ...BASE_ENTRY, status: "confirmed" as const }],
      });
      const html = await render({ rid: "g1", token: "tok" });
      expect(html).not.toMatch(/Pay now/);
      expect(html).not.toContain(">How to pay<");
      // The page's own Subtotal (summed from this same single entry)
      // already renders "£25" on its own — see the offline/unavailable
      // tests above for why a plain toContain can't distinguish "the card
      // shows it" from "only the Subtotal does".
      expect(
        (html.match(/>£25\.00</g) || []).length,
        "the confirmed card itself must show its own fee (the money line is a sentence, never a bare figure)",
      ).toBe(1);
    });

    it("a genuinely free (amount_cents 0) confirmed entry reads as 'Free', never '£0' (FIX 1)", async () => {
      usecaseMock.groupById.mockResolvedValueOnce({
        ...BASE_VIEW,
        entries: [{ ...BASE_ENTRY, status: "confirmed" as const, amount_cents: 0 }],
      });
      const html = await render({ rid: "g1", token: "tok" });
      expect(html).not.toContain("£0");
      // The page's own Subtotal (amount_cents 0, single entry) already
      // reads "Free" on its own — 2 proves the card reads Free too, not
      // just the Subtotal.
      expect(
        (html.match(/>Free</g) || []).length,
        "the confirmed card itself must read Free (the money line says \"Nothing to pay\", never \"Free\")",
      ).toBe(1);
    });
  });

  describe("money — code-review follow-up #8 and #13(a)", () => {
    // FIX #8 ("pay-then-refund on a stale deadline"): the hourly sweep has
    // not caught up yet, so the row is still 'pending', but its own deadline
    // has already passed — no live Pay button (it would mint a real Stripe
    // session the very next sweep expires and auto-refunds) and no stale
    // "Pay by" date printed above it.
    it("an entry past its own deadline shows neither a Pay button nor a 'Pay by' date — the payment-window-closed message instead", async () => {
      usecaseMock.groupById.mockResolvedValueOnce({
        ...BASE_VIEW,
        expires_at: "2000-01-01T00:00:00.000Z", // robustly in the past
      });
      const html = await render({ rid: "g1", token: "tok" });
      expect(html).not.toMatch(/Pay now/);
      expect(html).not.toMatch(/Pay by/);
      expect(html).toContain("The payment window for this entry has closed");
      // The fee is still named (transparency about what's owed) — same
      // "never a blank money section" rule FIX 1 already established for
      // stripe_unavailable/confirmed/free.
      expect(
        (html.match(/>£25\.00</g) || []).length,
        "the window_closed card itself must still show its own fee",
      ).toBe(1);
    });

    it("an entry whose deadline is still ahead is unaffected (sanity — not simply hiding every Pay button)", async () => {
      usecaseMock.groupById.mockResolvedValueOnce(BASE_VIEW); // FUTURE expires_at
      const html = await render({ rid: "g1", token: "tok" });
      expect(html).toMatch(/Pay now/);
      expect(html).not.toContain("The payment window for this entry has closed");
    });

    // FIX #13(a): entry-card.tsx used to hardcode UTC (and no zone label) for
    // every deadline it rendered, whatever timezone the org actually runs
    // in. Asserts against the SAME formatting functions the component calls
    // (fmtDateTime/fmtZoneAbbrev) rather than a hand-typed string, so this
    // can't drift from a real ICU/ Intl formatting change — see this
    // repo's own "pin an actual computed value, don't guess the format
    // string" convention (formatMinor's whole-number rounding trap).
    it("renders the deadline in the ORG's own timezone, with a zone label — never hardcoded UTC", async () => {
      // A TIME BOMB, defused (found 2026-09-01T19:10Z, ten minutes after it
      // went off). This was `2026-09-01T19:00:00.000Z` — an instant that was
      // comfortably in the future when RS012 wrote it and silently became the
      // PAST during the evening it merged. The page then renders its expired
      // state instead of a deadline, so the assertion below fails for everyone,
      // on main, from that minute onward — with a message about a missing date
      // string that says nothing about why.
      //
      // The properties this fixture actually needs are that the instant is in
      // the FUTURE and that Asia/Kolkata (UTC+5:30) lands it on a different
      // CALENDAR DAY from UTC — which is what makes the "never hardcoded UTC"
      // assertion below able to fail. A far-future date holds both without
      // depending on when the suite runs.
      const deadline = "2099-09-01T19:00:00.000Z"; // 00:30 on 2 Sept LOCAL in Asia/Kolkata (UTC+5:30)
      usecaseMock.groupById.mockResolvedValueOnce({
        ...BASE_VIEW,
        org_timezone: "Asia/Kolkata",
        expires_at: deadline,
      });
      const html = await render({ rid: "g1", token: "tok" });

      const expectedDate = fmtDateTime("Asia/Kolkata", deadline);
      const expectedZone = fmtZoneAbbrev("Asia/Kolkata", deadline);
      const utcDate = fmtDateTime("UTC", deadline);
      expect(utcDate, "sanity: the two zones must genuinely disagree on this instant").not.toBe(expectedDate);

      expect(html).toContain(expectedDate);
      expect(html).toContain(expectedZone);
      // The bug this fixes: the OLD hardcoded-UTC render of this exact
      // instant must not appear anywhere on the page.
      expect(html).not.toContain(utcDate);
    });
  });

  // B4 T15 (spec §5.3): the money line replaces the Subtotal. Paid is counted by SETTLEMENT (T14 `settled_by`), never by status: a
  // fee waiver confirms an entry and keeps its fee (FP11). Each row's text is a literal from the spec's rendering table.
  describe("money line (B4 T15, spec §5.3)", () => {
    const moneyText = (html: string) => html.match(/data-testid="reg-status-money"[^>]*>([^<]*)</)?.[1]?.replace(/&#x27;/g, "'");
    const CLOSED_AT = "2000-01-01T00:00:00.000Z"; // a pay-by date long gone: the entry is window_closed
    const MONEY_CASES: { name: string; view?: Record<string, unknown>; entries: Record<string, unknown>[]; currency?: string; text: string }[] = [
      { name: "no entries at all -> Nothing to pay (the empty case)", entries: [], text: "Nothing to pay" },
      { name: "part-paid: a card-settled £15.00 and a pending card-due £24.00",
        entries: [{ status: "confirmed", amount_cents: 1500, settled_by: "card" }, { status: "pending", amount_cents: 2400 }],
        text: "Paid £15.00 · £24.00 still due" },
      { name: "paid only", entries: [{ status: "confirmed", amount_cents: 1500, settled_by: "card" }], text: "Paid £15.00" },
      { name: "paid offline (Mark paid)", entries: [{ status: "confirmed", amount_cents: 1500, settled_by: "offline" }], text: "Paid £15.00" },
      { name: "due only", entries: [{ status: "pending", amount_cents: 2400 }], text: "£24.00 due" },
      { name: "a waived entry never looks paid", entries: [{ status: "confirmed", amount_cents: 1500, settled_by: "waived" }], text: "Nothing to pay" },
      { name: "refunded: £15.00 paid, £5.00 sent back",
        entries: [{ status: "confirmed", amount_cents: 1500, settled_by: "card", refunded_cents: 500 }], text: "Paid £10.00" },
      { name: "after a withdrawal: a withdrawn entry's stale fee is neither paid nor due (FIX 1)",
        entries: [{ status: "pending", amount_cents: 2500 }, { status: "withdrawn", amount_cents: 1000 }], text: "£25.00 due" },
      { name: "all waitlisted: what a promotion would cost, not due now",
        entries: [{ status: "waitlisted", amount_cents: 0, fee_if_promoted_cents: 1500 }], text: "£15.00 if a place opens — not due now" },
      { name: "all waitlisted in a free division -> Nothing to pay",
        entries: [{ status: "waitlisted", amount_cents: 0, fee_if_promoted_cents: 0 }], text: "Nothing to pay" },
      { name: "all ended -> Nothing to pay", entries: [{ status: "expired", amount_cents: 1500 }, { status: "rejected", amount_cents: 900 }], text: "Nothing to pay" },
      { name: "a free confirmed entry -> Nothing to pay", entries: [{ status: "confirmed", amount_cents: 0 }], text: "Nothing to pay" },
      // B4 fix round 2 (controller ruling): a fee past its pay-by date cannot be paid, so it is never "due". Round 3: both halves, each
      // as the sweep sees it — never promoted (the CART's date gone: the expiry pass expires it) and a lapsed promotion (its OWN date
      // gone: the lapse puts it back on the waitlist).
      { name: "past the cart's pay-by date alone -> Nothing to pay", view: { expires_at: CLOSED_AT },
        entries: [{ status: "pending", amount_cents: 2400 }], text: "Nothing to pay" },
      { name: "past the cart's pay-by date beside a promoted entry still in its window -> only the payable fee is due",
        view: { expires_at: CLOSED_AT },
        entries: [{ status: "pending", amount_cents: 2400 }, { status: "pending", amount_cents: 1500, promotion_expires_at: FUTURE }],
        text: "£15.00 due" },
      { name: "past the cart's pay-by date beside a card-paid entry -> Paid, never still due", view: { expires_at: CLOSED_AT },
        entries: [{ status: "pending", amount_cents: 2400 }, { status: "confirmed", amount_cents: 1500, settled_by: "card" }],
        text: "Paid £15.00" },
      { name: "a lapsed promotion alone -> Nothing to pay",
        entries: [{ status: "pending", amount_cents: 2400, promotion_expires_at: CLOSED_AT }], text: "Nothing to pay" },
      { name: "a lapsed promotion beside a pending card fee -> only the payable fee is due",
        entries: [{ status: "pending", amount_cents: 2400, promotion_expires_at: CLOSED_AT }, { status: "pending", amount_cents: 1500 }],
        text: "£15.00 due" },
      { name: "the cart's own currency, two decimals (a whole amount keeps its .00)", currency: "eur",
        entries: [{ status: "waitlisted", amount_cents: 0, fee_if_promoted_cents: 1500 }], text: "€15.00 if a place opens — not due now" },
    ];

    it("every case prints its literal sentence (counted)", async () => {
      let checked = 0;
      for (const c of MONEY_CASES) {
        usecaseMock.groupById.mockResolvedValueOnce({
          ...BASE_VIEW,
          ...c.view,
          currency: c.currency ?? BASE_VIEW.currency,
          entries: c.entries.map((e, i) => ({ ...BASE_ENTRY, id: `reg-${i + 1}`, ...e })),
        });
        const html = await render({ rid: "g1", token: "tok" });
        expect(moneyText(html), c.name).toBe(c.text);
        checked += 1;
      }
      expect(checked).toBe(MONEY_CASES.length);
      expect(checked).toBeGreaterThan(0);
    });

    it("the Subtotal row is gone: one money line, no second total", async () => {
      usecaseMock.groupById.mockResolvedValueOnce(BASE_VIEW);
      const html = await render({ rid: "g1", token: "tok" });
      expect(html.match(/data-testid="reg-status-money"/g)?.length).toBe(1);
      expect(html).not.toContain(">Subtotal<");
      expect(html).not.toContain("reg-status-subtotal");
    });
  });

  describe("outcome headline, reference hero and what happens next (B4 T15, spec §5.1-5.2)", () => {
    const headline = (html: string) =>
      html.match(/<h1[^>]*data-testid="reg-status-headline"[^>]*>([^<]*)</)?.[1]?.replace(/&#x27;/g, "'");

    const PAST = "2000-01-01T00:00:00.000Z";
    const HEADLINES: { name: string; view?: Record<string, unknown>; entries: Record<string, unknown>[]; kind: string; text: string }[] = [
      { name: "no entries (the empty case, first)", entries: [], kind: "closed", text: "This registration is closed" },
      { name: "an unpaid card entry", entries: [{ status: "pending", amount_cents: 2500 }], kind: "pay", text: "Pay to finish entering" },
      // B4 review m1 (owner ruling 2026-11-13): the two owed states with no way to pay on this page.
      { name: "a card fee owed while card payments are unavailable: the card notice, never Pay or awaiting approval",
        view: { charges_enabled: false }, entries: [{ status: "pending", amount_cents: 2500 }],
        kind: "payUnavailable", text: "Card payments aren't available right now — contact the organiser." },
      // Round 3 (re-review I1): each half of "past its pay-by date" as the sweep sees it.
      { name: "never promoted, past the cart's pay-by date: closed (the expiry pass expires it)", view: { expires_at: PAST },
        entries: [{ status: "pending", amount_cents: 2500 }], kind: "closed", text: "This registration is closed" },
      { name: "a promotion past its own pay-by date: the waiting list (the lapse puts it back)",
        entries: [{ status: "pending", amount_cents: 2500, promotion_expires_at: PAST }], kind: "waitlist", text: "You're on the waiting list" },
      { name: "past the cart's pay-by date beside a confirmed entry: You're in", view: { expires_at: PAST },
        entries: [{ status: "pending", amount_cents: 2500 }, { status: "confirmed", settled_by: "card" }],
        kind: "in", text: "You're in" },
      { name: "past the cart's pay-by date beside a paid entry awaiting approval: one entry received (the closed one is not counted)",
        view: { expires_at: PAST },
        entries: [{ status: "pending", amount_cents: 2500 }, { status: "paid", settled_by: "card" }],
        kind: "received", text: "Entry received, awaiting approval" },
      { name: "a confirmed entry", entries: [{ status: "confirmed", settled_by: "card" }], kind: "in", text: "You're in" },
      { name: "one entry awaiting approval", entries: [{ status: "paid", settled_by: "card" }], kind: "received", text: "Entry received, awaiting approval" },
      { name: "two entries awaiting approval (plural)", entries: [{ status: "paid", settled_by: "card" }, { status: "pending", amount_cents: 0 }],
        kind: "received", text: "Entries received, awaiting approval" },
      { name: "a waitlisted entry", entries: [{ status: "waitlisted", amount_cents: 0 }], kind: "waitlist", text: "You're on the waiting list" },
      { name: "only withdrawn", entries: [{ status: "withdrawn" }], kind: "closed", text: "This registration is closed" },
      // B4 review I1: a confirmed solo sign-up nobody has placed on a team yet.
      { name: "a solo sign-up in the player pool", entries: [{ status: "confirmed", amount_cents: 0, free_agent: true }],
        kind: "pool", text: "You're in the player pool" },
      { name: "a solo sign-up placed on a team", entries: [{ status: "confirmed", amount_cents: 0, free_agent: true, assigned_team_name: "Riverside Rovers" }],
        kind: "in", text: "You're in" },
    ];

    it("the h1 is the outcome, one literal per headline kind (counted)", async () => {
      let checked = 0;
      for (const c of HEADLINES) {
        usecaseMock.groupById.mockResolvedValueOnce({
          ...BASE_VIEW,
          ...c.view,
          entries: c.entries.map((e, i) => ({ ...BASE_ENTRY, id: `reg-${i + 1}`, ...e })),
        });
        const html = await render({ rid: "g1", token: "tok" });
        expect(headline(html), c.name).toBe(c.text);
        expect(html, c.name).toContain(`data-headline="${c.kind}"`);
        expect(html.match(/<h1/g)?.length, `${c.name}: one h1`).toBe(1);
        checked += 1;
      }
      expect(checked).toBe(HEADLINES.length);
      // Premise: every headline kind the page can show is reached by a row here.
      expect(new Set(HEADLINES.map((c) => c.kind))).toEqual(new Set(["pay", "payUnavailable", "in", "pool", "received", "waitlist", "closed"]));
    });

    // B4 review I1, through the page: the lead line, the step and the solo card agree. Beside a confirmed team entry the pool still
    // leads (ruling: "Nothing else to do" would contradict the solo card's "Waiting for a team").
    it("a solo sign-up in the pool beside a confirmed team: the pool leads, the step says the organiser places you, never 'Nothing else to do'", async () => {
      usecaseMock.groupById.mockResolvedValueOnce({
        ...BASE_VIEW,
        entries: [
          { ...BASE_ENTRY, id: "reg-1", status: "confirmed" as const, settled_by: "card" as const },
          { ...BASE_ENTRY, id: "reg-2", division_name: "Womens 35+", display_name: "Alex Test", entrant_kind: "individual" as const,
            status: "confirmed" as const, amount_cents: 0, free_agent: true, assigned_team_name: null },
        ],
      });
      const html = (await render({ rid: "g1", token: "tok" })).replace(/&#x27;/g, "'");
      expect(headline(html)).toBe("You're in the player pool");
      const steps = [...html.matchAll(/<li[^>]*data-next-kind="step"[^>]*>([^<]*)</g)].map((m) => m[1]);
      expect(steps).toEqual(["The organiser places you on a team. This page shows it."]);
      expect(html).toContain("Waiting for a team");
      expect(html).not.toContain("Nothing else to do");
    });

    // B4 review m1, the owed states' cards and steps. A card fee owed while cards are unavailable keeps its figure and the notice, has
    // no Pay button, and "What happens next" never says "Pay to keep your place". A fee past its pay-by date beside a confirmed entry:
    // the page leads with "You're in", and the closed entry's own card says it lost its place.
    it("cards unavailable: the owed fee still shows, no Pay button, and no step asks to pay", async () => {
      usecaseMock.groupById.mockResolvedValueOnce({ ...BASE_VIEW, charges_enabled: false, entries: [BASE_ENTRY] });
      const html = (await render({ rid: "g1", token: "tok" })).replace(/&#x27;/g, "'");
      expect(headline(html), "premise: the card notice leads").toBe("Card payments aren't available right now — contact the organiser.");
      expect(html).not.toMatch(/Pay now/);
      expect(html).not.toContain("to keep your place");
      expect(html).toMatch(/data-testid="reg-status-money"[^>]*>£25\.00 due</);
    });

    // B4 fix round 2 (controller ruling): the card notice is said once. A one-entry cart's h1 IS the notice, so its card keeps the
    // figure and drops the sentence; a cart of two or more keeps it on the card that owes, so the person can tell which entry it means.
    const NOTICE = "Card payments aren't available right now — contact the organiser.";
    const count = (html: string, text: string) => html.split(text).length - 1;

    it("cards unavailable on a one-entry cart: the notice is the h1 only, the card keeps its figure", async () => {
      usecaseMock.groupById.mockResolvedValueOnce({ ...BASE_VIEW, charges_enabled: false, entries: [BASE_ENTRY] });
      const html = (await render({ rid: "g1", token: "tok" })).replace(/&#x27;/g, "'");
      expect(headline(html)).toBe(NOTICE);
      expect(count(html, NOTICE), "said once, in the h1").toBe(1);
      expect((html.match(/>£25\.00</g) || []).length, "the card still names its fee").toBe(1);
    });

    it("cards unavailable on a two-entry cart: the h1 and the owing card both say it, the confirmed card does not", async () => {
      usecaseMock.groupById.mockResolvedValueOnce({
        ...BASE_VIEW,
        charges_enabled: false,
        entries: [
          { ...BASE_ENTRY, id: "reg-1" },
          { ...BASE_ENTRY, id: "reg-2", division_name: "Womens 35+", status: "confirmed" as const, settled_by: "card" as const },
        ],
      });
      const html = (await render({ rid: "g1", token: "tok" })).replace(/&#x27;/g, "'");
      expect(headline(html)).toBe(NOTICE);
      const cards = html.match(/<li class="[^"]*rounded-xl[\s\S]*?(?=<li class="[^"]*rounded-xl|$)/g) ?? [];
      expect(cards.length, "two entry cards").toBe(2);
      expect(count(cards[0]!, NOTICE), "the owing card names it").toBe(1);
      expect(count(cards[1]!, NOTICE), "the confirmed card does not").toBe(0);
      expect(count(html, NOTICE), "h1 + the owing card").toBe(2);
    });

    // Round 3 (re-review m5): the one-entry rule counts LIVE entries. A withdrawn card beside the owing one is not what the h1 is about.
    it("cards unavailable beside a withdrawn entry: one live entry, so the notice is the h1 only", async () => {
      usecaseMock.groupById.mockResolvedValueOnce({
        ...BASE_VIEW,
        charges_enabled: false,
        entries: [{ ...BASE_ENTRY, id: "reg-1" }, { ...BASE_ENTRY, id: "reg-2", division_name: "Womens 35+", status: "withdrawn" as const }],
      });
      const html = (await render({ rid: "g1", token: "tok" })).replace(/&#x27;/g, "'");
      expect(headline(html)).toBe(NOTICE);
      expect(count(html, NOTICE), "said once, in the h1").toBe(1);
    });

    it("past the cart's pay-by date beside a confirmed entry: You're in, and the closed entry's card says it lost its place", async () => {
      usecaseMock.groupById.mockResolvedValueOnce({
        ...BASE_VIEW,
        expires_at: PAST, // never promoted: the cart's shared date is this entry's, and the expiry pass expires it
        entries: [
          { ...BASE_ENTRY, id: "reg-1" },
          { ...BASE_ENTRY, id: "reg-2", division_name: "Womens 35+", status: "confirmed" as const, settled_by: "card" as const },
        ],
      });
      const html = (await render({ rid: "g1", token: "tok" })).replace(/&#x27;/g, "'");
      expect(headline(html)).toBe("You're in");
      const cards = html.match(/<li class="[^"]*rounded-xl[\s\S]*?(?=<li class="[^"]*rounded-xl|$)/g) ?? [];
      expect(cards.length, "two entry cards").toBe(2);
      expect(cards[0], "the closed entry's card").toContain("so it has lost its place");
      expect(cards[0], "round 4: its chip says Closed, never pending").toMatch(/data-testid="reg-status-outcome"[^>]*>Closed<\/span>/);
      expect(cards[1], "the confirmed card says nothing of it").not.toContain("lost its place");
      expect(html).not.toContain("to keep your place");
    });

    // Round 3 (re-review I1): a promotion past its own pay-by date is put back at the END of the waitlist by the sweep's lapse
    // (sweep.ts → returnToWaitlist), never expired. The page says so before the sweep runs: the waiting-list headline and the card's
    // own sentence, never "lost its place", no Pay and no pay-by date.
    it("a lapsed promotion: the waiting list leads, and its card says it goes back to the end of the list", async () => {
      usecaseMock.groupById.mockResolvedValueOnce({ ...BASE_VIEW, entries: [{ ...BASE_ENTRY, promotion_expires_at: PAST }] });
      const html = (await render({ rid: "g1", token: "tok" })).replace(/&#x27;/g, "'");
      expect(headline(html)).toBe("You're on the waiting list");
      const cards = html.match(/<li class="[^"]*rounded-xl[\s\S]*?(?=<li class="[^"]*rounded-xl|$)/g) ?? [];
      expect(cards.length, "one entry card").toBe(1);
      expect(cards[0]).toContain(">The time to pay for this place has passed. Your entry goes back to the end of the waiting list.<");
      expect(cards[0]).not.toContain("lost its place");
      expect(cards[0], "not waiting for a payment it can no longer take").not.toContain("waiting for payment");
      expect(cards[0], "round 4: never PENDING under a waitlist headline").toMatch(/data-testid="reg-status-outcome"[^>]*>waitlisted<\/span>/);
      expect(html).not.toMatch(/Pay now|Pay by/);
      expect(html).not.toContain("to keep your place");
    });

    it("states where the confirmation went", async () => {
      usecaseMock.groupById.mockResolvedValueOnce(BASE_VIEW);
      const html = await render({ rid: "g1", token: "tok" });
      expect(html).toMatch(/Confirmation sent to <[^>]+>alex@example\.test<\/[a-z]+>\./);
    });

    // B4 review m3: the address is the registrant's own, so the element that holds it is kept out of session replay. Read off the
    // element that wraps the address itself (its class list, token by token), never a regex that survives the class being deleted.
    it("the address sits in an element marked ph-no-capture", async () => {
      usecaseMock.groupById.mockResolvedValueOnce(BASE_VIEW);
      const html = await render({ rid: "g1", token: "tok" });
      const holders = [...html.matchAll(/<([a-z]+) class="([^"]*)">alex@example\.test<\/\1>/g)];
      expect(holders.length, "one element holds the address").toBe(1);
      expect(holders[0]![2]!.split(/\s+/)).toContain("ph-no-capture");
    });

    it("reg-status-ref holds the cart reference and a Copy reference button", async () => {
      usecaseMock.groupById.mockResolvedValueOnce(BASE_VIEW);
      const html = await render({ rid: "g1", token: "tok" });
      const hero = html.match(/<section[^>]*data-testid="reg-status-ref"[\s\S]*?<\/section>/)?.[0];
      expect(hero, "reference hero not found").toBeDefined();
      expect(hero).toContain(">SZ-TEST-01<");
      expect(hero).toContain("Your reference");
      expect(hero).toMatch(/<button[^>]*data-testid="reg-status-copy-ref"[\s\S]*?Copy reference/);
    });

    it("a cart whose reference was never minted shows no hero and no Copy button (nothing to copy)", async () => {
      usecaseMock.groupById.mockResolvedValueOnce({ ...BASE_VIEW, ref_code: null });
      const html = await render({ rid: "g1", token: "tok" });
      expect(html, "anti-vacuity: the page still rendered").toContain("Mixed Doubles");
      expect(html).not.toContain('data-testid="reg-status-ref"');
      expect(html).not.toContain("Copy reference");
    });

    it("no dates, no venue and a closed cart: the section is not rendered (the empty case)", async () => {
      usecaseMock.groupById.mockResolvedValueOnce({ ...BASE_VIEW, entries: [{ ...BASE_ENTRY, status: "withdrawn" as const }] });
      const html = await render({ rid: "g1", token: "tok" });
      expect(html, "anti-vacuity: the page still rendered").toContain("Mixed Doubles");
      expect(html).not.toContain('data-testid="reg-status-next"');
      expect(html).not.toContain("What happens next");
    });

    it("dates, venue and the step render as sentences, the dates in the page's locale", async () => {
      usecaseMock.groupById.mockResolvedValueOnce({
        ...BASE_VIEW,
        competition_starts_on: "2099-12-05",
        competition_ends_on: "2099-12-07",
        venue_name: "Riverside Courts",
        entries: [{ ...BASE_ENTRY, status: "waitlisted" as const, amount_cents: 0, waitlist_position: 2 }],
      });
      const html = (await render({ rid: "g1", token: "tok" })).replace(/&#x27;/g, "'");
      const lines = [...html.matchAll(/<li[^>]*data-next-kind="([a-z]+)"[^>]*>([^<]*)</g)].map((m) => [m[1], m[2]]);
      expect(lines).toEqual([
        ["dates", "Summer Smash runs 5 Dec 2099 to 7 Dec 2099."],
        ["venue", "Played at Riverside Courts."],
        ["step", "If a place opens, your entry moves up and this page shows it."],
      ]);
      expect(html).toContain("What happens next");
      // The T13 queue line still sits on the waitlisted card beside the headline's "You're on the waiting list".
      expect(html).toContain("You're #2 on the waiting list");
    });

    // B4 review m7: the page passes the real clock, so these dates are far past/future (the file's FUTURE convention). A competition
    // whose last day is before today has no dates line; the venue and the step stay.
    it("a competition that is over shows no dates line, and keeps the venue and the step", async () => {
      usecaseMock.groupById.mockResolvedValueOnce({
        ...BASE_VIEW,
        competition_starts_on: "2000-06-01",
        competition_ends_on: "2000-06-03",
        venue_name: "Riverside Courts",
        entries: [{ ...BASE_ENTRY, status: "confirmed" as const }],
      });
      const html = (await render({ rid: "g1", token: "tok" })).replace(/&#x27;/g, "'");
      const kinds = [...html.matchAll(/<li[^>]*data-next-kind="([a-z]+)"/g)].map((m) => m[1]);
      expect(kinds).toEqual(["venue", "step"]);
      expect(html).not.toContain("Summer Smash runs");
      expect(html).not.toContain("Summer Smash starts on");
    });

    it("a one-day event says 'starts on'", async () => {
      usecaseMock.groupById.mockResolvedValueOnce({
        ...BASE_VIEW,
        competition_starts_on: "2099-12-05",
        competition_ends_on: "2099-12-05",
        entries: [{ ...BASE_ENTRY, status: "confirmed" as const }],
      });
      const html = (await render({ rid: "g1", token: "tok" })).replace(/&#x27;/g, "'");
      expect(html).toContain(">Summer Smash starts on 5 Dec 2099.<");
      expect(html).toContain(">Nothing else to do. Keep this page — it's your entry.<");
    });

    it("pay: the step names the same pay-by deadline the card does, in the org's zone", async () => {
      usecaseMock.groupById.mockResolvedValueOnce(BASE_VIEW);
      const html = await render({ rid: "g1", token: "tok" });
      expect(html).toContain(`>Pay by ${fmtPublicDeadline("en", "UTC", FUTURE)} to keep your place.<`);
    });
  });

  // Bug (2026-08-27 browser sweep): the global cookie-consent banner is
  // fixed bottom-left (components/cookie-consent.tsx) and, on a first visit
  // — which a registration email always is — sat over this page's own
  // primary actions (Cancel this entry at 1280px; the whole roster block
  // and per-slot claim links at 320px). The banner itself is out of scope
  // (blast radius — see its own z-index test suite); this page reserves
  // its own bottom clearance instead, the same "fixed bar → spacer" shape
  // globals.css already uses for `.bottom-bar`/`.bottom-bar-spacer`.
  it("reserves bottom clearance so the fixed cookie banner never sits over the roster/cancel actions", async () => {
    usecaseMock.groupById.mockResolvedValueOnce(BASE_VIEW);
    const html = await render({ rid: "g1", token: "tok" });
    const wrapperMatch = html.match(/<div class="([^"]*mx-auto max-w-2xl[^"]*)"/);
    expect(wrapperMatch, "status page content wrapper not found").not.toBeNull();
    const wrapperClass = wrapperMatch![1];
    // Safe-area aware, matching the codebase's own `pb-[calc(<n>+env(safe-
    // area-inset-bottom))]` convention (confirm-provider.tsx, modal.tsx) —
    // generous enough to clear the banner's real measured footprint
    // (240px on mobile, 160px on desktop, both starting from bottom-4).
    expect(wrapperClass).toMatch(/pb-\[calc\(\d+px\+env\(safe-area-inset-bottom\)\)\]/);
    expect(wrapperClass).toMatch(/sm:pb-\[calc\(\d+px\+env\(safe-area-inset-bottom\)\)\]/);
  });

  describe("cancel + refund clarity (acceptance criteria 3 & 4)", () => {
    it("offers Cancel for a live entry, naming the public per-entry withdraw path (not the organiser one)", async () => {
      usecaseMock.groupById.mockResolvedValueOnce(BASE_VIEW);
      const html = await render({ rid: "g1", token: "tok" });
      expect(html).toContain("Cancel this entry");
    });

    // B4 T15 (spec §5.1 item 7): Cancel is a quiet text link in the card's own footer, never a filled or outlined button. Its class is
    // the status page's quiet-link token (styles.ts BTN_QUIET_LINK): sentence case and underlined since the B4 design review.
    it("Cancel renders as a link-styled button inside the card footer, not a filled button", async () => {
      usecaseMock.groupById.mockResolvedValueOnce({ ...BASE_VIEW, entries: [BASE_ENTRY] });
      const html = await render({ rid: "g1", token: "tok" });
      const card = html.match(/<li class="[^"]*rounded-xl[\s\S]*?<\/li>/)?.[0];
      expect(card, "entry card not found").toBeDefined();
      const footer = card!.match(/<div class="border-t[^"]*">[\s\S]*$/)?.[0];
      expect(footer, "the card's footer").toBeDefined();
      const button = footer!.match(/<button([^>]*)>Cancel this entry<\/button>/);
      expect(button, "Cancel sits in the card's footer").not.toBeNull();
      const cls = button![1]!.match(/class="([^"]*)"/)![1]!;
      expect(cls).toBe(BTN_QUIET_LINK);
      expect(cls).not.toMatch(/\bborder\b|\bbg-/);
      expect(cls.split(/\s+/)).not.toContain("uppercase");
    });

    it("Resend sits in the page's quiet footer, after the entries and the money line, as a text link", async () => {
      usecaseMock.groupById.mockResolvedValueOnce(BASE_VIEW);
      const html = await render({ rid: "g1", token: "tok" });
      const resend = html.match(/<button([^>]*)>Resend confirmation email<\/button>/);
      expect(resend, "Resend button").not.toBeNull();
      expect(resend![1]!.match(/class="([^"]*)"/)![1]).toBe(BTN_QUIET_LINK);
      expect(html.indexOf("Resend confirmation email")).toBeGreaterThan(html.indexOf('data-testid="reg-status-money"'));
      expect(html.indexOf('data-testid="reg-status-money"')).toBeGreaterThan(html.indexOf("Mixed Doubles"));
    });

    it("hides Cancel for an already-withdrawn entry", async () => {
      usecaseMock.groupById.mockResolvedValueOnce({
        ...BASE_VIEW,
        entries: [{ ...BASE_ENTRY, status: "withdrawn" as const }],
      });
      const html = await render({ rid: "g1", token: "tok" });
      expect(html).not.toContain("Cancel this entry");
    });

    // Bug (2026-08-27 review, FIX 3): refund_policy now carries a `reason`
    // ("no_deadline") when a refund is fail-closed-declined because no
    // deadline is knowable at all (resolveRefundPolicy, usecases/registrations/refunds.ts),
    // but nothing rendered it — a registrant saw a refusal with no
    // explanation. Plain-English copy, not the computed reason code.
    it("explains a fail-closed 'no_deadline' refund decline in plain English near the Cancel control", async () => {
      usecaseMock.groupById.mockResolvedValueOnce({
        ...BASE_VIEW,
        entries: [
          {
            ...BASE_ENTRY,
            refund_policy: { refundable: false, deadline: null, amount_cents: 2500, reason: "no_deadline" as const },
          },
        ],
      });
      const html = await render({ rid: "g1", token: "tok" });
      expect(html).toContain("Cancel this entry");
      expect(html).toContain("The organiser handles refunds");
    });

    it("shows no extra explanation for an ORDINARY refund decline (a real deadline that has simply passed — reason null)", async () => {
      usecaseMock.groupById.mockResolvedValueOnce({
        ...BASE_VIEW,
        entries: [
          {
            ...BASE_ENTRY,
            refund_policy: {
              refundable: false,
              deadline: "2026-01-01T00:00:00.000Z",
              amount_cents: 2500,
              reason: null,
            },
          },
        ],
      });
      const html = await render({ rid: "g1", token: "tok" });
      expect(html).toContain("Cancel this entry");
      expect(html).not.toContain("The organiser handles refunds");
    });
  });

  describe("roster meter + claim links (acceptance criterion 5)", () => {
    it("counts claimed vs unclaimed and renders a per-slot claim link for each unclaimed player, plus one generic link", async () => {
      usecaseMock.groupById.mockResolvedValueOnce({
        ...BASE_VIEW,
        entries: [
          {
            ...BASE_ENTRY,
            join_code: "JOIN123",
            players: [
              { id: "p1", full_name: "Sam Player", consent_status: "granted" as const, consent: null },
              { id: "p2", full_name: "Jordan Player", consent_status: "pending" as const, consent: null },
            ],
          },
        ],
      });
      const html = await render({ rid: "g1", token: "tok" });
      // Finding #20: this used to read "1 of 2 confirmed" — the same word
      // the entry's own payment-status pill uses a few lines above (green
      // CONFIRMED = the fee landed). Roster-side copy now uses a check-in
      // metaphor instead, so it can no longer be read as a payment state. This entry is still PENDING, so (owner ruling on V7,
      // 2026-11-12) its meter says who has joined - "checked in" is kept for a confirmed entry (pinned below).
      expect(html).toContain("1 of 2 joined");
      expect(html).not.toContain("checked in");
      // The per-slot link carries the unclaimed player's id, on that slot's Copy button (polish wave K: no URL is printed).
      expect(html).toContain('data-href="/live/riverside/summer-smash/register/join?join_code=JOIN123&amp;player_id=p2"');
      // The generic link carries no player_id.
      expect(html).toContain('data-href="/live/riverside/summer-smash/register/join?join_code=JOIN123"');
      // The code is painted ONLY by the invite block's Copy buttons, once per link (two links, two), and none of it outside the
      // block: no printed URL, no href (polish wave K; it was an href plus the printed URL per link before).
      const block = html.slice(html.indexOf('data-testid="reg-invite"'));
      expect(html.match(/JOIN123/g)?.length).toBe(2);
      expect(block.match(/JOIN123/g)?.length).toBe(2);
      expect(block).not.toContain(">http");
      // The block lists BOTH roster slots (Sam has joined: chip only; Jordan has not: chip and Copy link), then the general link.
      expect(html).toContain(invite("heading"));
      expect(html).toContain(invite("intro"));
      expect(html).toContain(invite("notListed"));
      expect(html.match(/data-invite-slot/g)?.length).toBe(2);
      expect(html.match(/data-testid="reg-invite-copy"/g)?.length).toBe(2);
      // The whole block is under ph-no-capture (the join code is a capability).
      expect(html).toMatch(/<section data-testid="reg-invite" class="ph-no-capture /);
    });

    // Polish wave P6 (the empty case the old inline gate hid): a team registered with NO roster has no roster box, and its captain
    // still needs the general link to bring people in.
    it("a team with no players at all still offers the general link, in its own block", async () => {
      usecaseMock.groupById.mockResolvedValueOnce({
        ...BASE_VIEW,
        entries: [{ ...BASE_ENTRY, join_code: "EMPTY01", players: [] }],
      });
      const html = await render({ rid: "g1", token: "tok" });
      expect(html).toContain(invite("heading"));
      expect(html).toContain(invite("notListed"));
      expect(html).toContain('data-href="/live/riverside/summer-smash/register/join?join_code=EMPTY01"');
      expect(html).not.toContain("player_id=");
    });

    // RS008: a roster row backed by a person who opted out via /me
    // (persons.consent.public_name = false) must render masked here too —
    // this page is one of the sites named in the gap (RS007 shipped the
    // consent gate; nothing enforced it on THIS render until now). A sibling
    // row with no opt-out (consent: null, e.g. never claimed) stays full, on
    // a non-youth division — proves the fix is additive, not a blanket mask.
    it("masks a roster row whose linked person opted out of a public name; a non-opted-out row stays full", async () => {
      usecaseMock.groupById.mockResolvedValueOnce({
        ...BASE_VIEW,
        entries: [
          {
            ...BASE_ENTRY,
            join_code: "JOIN456",
            players: [
              {
                id: "p1",
                full_name: "Arun Kumar",
                consent_status: "granted" as const,
                consent: { public_name: false },
              },
              {
                id: "p2",
                full_name: "Dev Patel",
                consent_status: "pending" as const,
                consent: null,
              },
            ],
          },
        ],
      });
      const html = await render({ rid: "g1", token: "tok" });
      expect(html).not.toContain("Arun Kumar");
      expect(html).toContain("Arun K.");
      expect(html).toContain("Dev Patel");
      // The claim-link text for the STILL-unclaimed row names it in full too
      // (consent: null is not an opt-out) — masking is per-person, not
      // blanket once any row on the entry has opted out.
      expect(html).toContain("Dev Patel");
    });

    // Polish wave P6: the invite rows name the SAME unclaimed person the roster does, so they mask the same way: by the linked person's
    // own opt-out, and by a youth division's policy. Neither opted-out nor youth is the control: its row stays in full.
    it("the invite row names an unclaimed player as masked as the roster row does (a person's opt-out, and a youth division), and a plain one stays in full", async () => {
      const players = [
        { id: "p1", full_name: "Priya Nair", consent_status: "pending" as const, consent: { public_name: false } },
        { id: "p2", full_name: "Dev Patel", consent_status: "pending" as const, consent: null },
      ];
      usecaseMock.groupById.mockResolvedValueOnce({ ...BASE_VIEW, entries: [{ ...BASE_ENTRY, join_code: "MASK01", players }] });
      const inviteBlock = (html: string) => html.slice(html.indexOf('data-testid="reg-invite"'));
      const opted = await render({ rid: "g1", token: "tok" });
      expect(opted).not.toContain("Priya Nair");
      expect(inviteBlock(opted)).toContain(">Priya N.</span>");
      expect(inviteBlock(opted)).toContain(">Dev Patel</span>");

      usecaseMock.groupById.mockResolvedValueOnce({
        ...BASE_VIEW,
        entries: [{ ...BASE_ENTRY, join_code: "MASK02", division_youth: true, players }],
      });
      const youth = await render({ rid: "g1", token: "tok" });
      expect(youth).not.toContain("Priya Nair");
      expect(youth).not.toContain("Dev Patel");
      expect(inviteBlock(youth)).toContain(">Priya N.</span>");
      expect(inviteBlock(youth)).toContain(">Dev P.</span>");
    });

    // RS008 review fix #1 (Critical): the entry-card HEADING (entry.display_name)
    // had ZERO masking — only the roster rows above (the previous test) were
    // routed through the consent resolver. BASE_ENTRY's own "Team Alpha"
    // fixture can never see this (a team's own name never takes the consent
    // axis) — this uses an "individual" entrant, whose display_name IS a
    // person's name, realistically the SAME person as its own sole roster row.
    it("masks the entry-card HEADING too, not just the roster rows below it, for a non-team entry whose linked person opted out", async () => {
      usecaseMock.groupById.mockResolvedValueOnce({
        ...BASE_VIEW,
        entries: [
          {
            ...BASE_ENTRY,
            entrant_kind: "individual" as const,
            display_name: "Arun Kumar",
            players: [
              {
                id: "p1",
                full_name: "Arun Kumar",
                consent_status: "granted" as const,
                consent: { public_name: false },
              },
            ],
          },
        ],
      });
      const html = await render({ rid: "g1", token: "tok" });
      expect(html).not.toContain("Arun Kumar");
      // Both the heading AND the roster row below it now read "Arun K." —
      // before this fix, only the roster row did; the heading leaked
      // "Arun Kumar" raw.
      expect(html.match(/Arun K\./g)?.length).toBe(2);
    });

    // Finding #20: the entry's own lifecycle pill can say CONFIRMED (fee
    // landed, auto-approved) on the SAME card where a roster row is still
    // unclaimed. Before this fix both used the word "confirm" — a paying
    // registrant read their own outstanding roster row as "my payment
    // didn't go through", three inches under a badge saying the opposite.
    // Reproduced here with BOTH states live on one card at once, the way
    // the owner actually spotted it, not just as an isolated dictionary
    // pin.
    it("the roster's own copy never says 'confirm', even on a card whose entry pill legitimately does", async () => {
      usecaseMock.groupById.mockResolvedValueOnce({
        ...BASE_VIEW,
        entries: [
          {
            ...BASE_ENTRY,
            status: "confirmed" as const,
            players: [
              { id: "p1", full_name: "Pair Captain", consent_status: "granted" as const, consent: null },
              { id: "p2", full_name: "Pair Partner", consent_status: "pending" as const, consent: null },
            ],
          },
        ],
      });
      const html = await render({ rid: "g1", token: "tok" });
      // The entry pill still legitimately says CONFIRMED — this finding is
      // about the ROSTER's vocabulary, not the entry's own money status.
      expect(html).toContain(">confirmed<");
      // The roster's per-row badges and its meter use a check-in metaphor —
      // who has personally shown up, not whether the entry (or a refund) is
      // valid — deliberately distinct from both "confirm" (the entry's own
      // money word) and "claim" (which carries its own money-adjacent
      // reading: an insurance claim, an expense claim).
      expect(html).toContain(">Not checked in<");
      expect(html).toContain(">Checked in<");
      expect(html).toContain("1 of 2 checked in");
      // ...and nowhere does the roster block reuse "confirm" or "claim" —
      // pinned against the dictionary source directly (not string-sliced
      // out of the render) so this fails the moment any of the three keys
      // drifts back toward payment vocabulary, whatever the exact wording
      // becomes.
      const roster = uiEn as Record<string, string>;
      for (const key of ["register.status.roster.pending", "register.status.roster.claimed", "register.status.roster.meter"]) {
        // Strip interpolation placeholders first — `.meter`'s own template
        // variable is literally named "{claimed}" in the SOURCE string
        // (view-model.ts's RosterCounts field), which would otherwise trip
        // the /claim/ check below on a token the reader never sees (only
        // the substituted number renders).
        const readerFacing = roster[key]!.replace(/\{[^}]+\}/g, "").toLowerCase();
        expect(readerFacing, `${key} must not read as a payment state`).not.toMatch(/confirm/);
        expect(readerFacing, `${key} must not read as a claim/insurance state`).not.toMatch(/claim/);
      }
    });

    // A pair's roster is fixed at exactly two (registration-submit.ts) — its
    // join_code only ever lets the partner claim their own already-typed-in
    // slot. joinTeamEntry 422s a pair's insert-a-new-person path, so the
    // GENERIC link must never be offered for one, even though the per-slot
    // link for an actual unclaimed partner still is.
    it("hides the generic claim link for a pair (allows_new_joiner: false), but keeps the per-slot one", async () => {
      usecaseMock.groupById.mockResolvedValueOnce({
        ...BASE_VIEW,
        entries: [
          {
            ...BASE_ENTRY,
            join_code: "PAIR456",
            entrant_kind: "pair" as const,
            allows_new_joiner: false,
            players: [
              { id: "p1", full_name: "Sam Player", consent_status: "granted" as const, consent: null },
              { id: "p2", full_name: "Jordan Player", consent_status: "pending" as const, consent: null },
            ],
          },
        ],
      });
      const html = await render({ rid: "g1", token: "tok" });
      expect(html).toContain("join_code=PAIR456&amp;player_id=p2");
      expect(html).not.toContain('data-href="/live/riverside/summer-smash/register/join?join_code=PAIR456"');
      // ... and it is worded for a pair: a partner, not teammates, and no "Someone not listed?" link.
      expect(html).toContain(invite("headingPair"));
      expect(html).toContain(invite("introPair"));
      expect(html).not.toContain(invite("heading"));
      expect(html).not.toContain(invite("notListed"));
    });

    // Bug (2026-08-27 review, FIX 2): the claim block gated on
    // `entry.join_code && (unclaimed.length > 0 || entry.allows_new_joiner)`
    // with NO status check, while withdrawCore never clears join_code — so
    // a cancelled entry kept offering claim/invite links that
    // joinTeamEntry/previewJoinEntry's own dead-entry gate 404s every time.
    it.each(["withdrawn", "rejected", "expired"] as const)(
      "hides both the per-slot claim link and the generic invite link on a %s entry, even though join_code + unclaimed players + allows_new_joiner are all still present",
      async (status) => {
        usecaseMock.groupById.mockResolvedValueOnce({
          ...BASE_VIEW,
          entries: [
            {
              ...BASE_ENTRY,
              status,
              join_code: "DEAD789",
              allows_new_joiner: true,
              players: [
                { id: "p1", full_name: "Sam Player", consent_status: "granted" as const, consent: null },
                { id: "p2", full_name: "Jordan Player", consent_status: "pending" as const, consent: null },
              ],
            },
          ],
        });
        const html = await render({ rid: "g1", token: "tok" });
        expect(html).not.toContain("join_code=DEAD789");
        expect(html).not.toContain('data-testid="reg-invite"');
        expect(html).not.toContain(invite("heading"));
        expect(html).not.toContain('data-testid="reg-invite-copy"');
        expect(html).not.toContain(invite("notListed"));
      },
    );
  });
});
