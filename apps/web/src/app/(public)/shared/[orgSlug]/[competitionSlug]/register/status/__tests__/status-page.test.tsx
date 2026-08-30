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
import { fmtDateTime, fmtZoneAbbrev } from "@/lib/format";
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
  // RS008: this entry's own division youth/player_name_display policy —
  // threaded onto GroupEntryView (buildGroupStatusView, registrations.ts).
  division_youth: false,
  division_player_name_display: null as string | null,
  players: [] as {
    id: string;
    full_name: string;
    consent_status: "pending" | "granted" | "guardian";
    consent: { public_name?: boolean } | null;
  }[],
  refund_policy: { refundable: true, deadline: "2026-09-15T00:00:00.000Z", amount_cents: 2500 },
};

const BASE_VIEW = {
  ref_code: "SZ-TEST-01",
  contact_name: "Alex Test",
  currency: "gbp",
  amount_cents: 2500,
  payment_method: "stripe" as const,
  expires_at: FUTURE,
  refunded_cents: 0,
  competition_name: "Summer Smash",
  competition_slug: "summer-smash",
  org_slug: "riverside",
  org_name: "Riverside CC",
  created_at: "2026-08-20T10:00:00.000Z",
  charges_enabled: true,
  payment_instructions: null as string | null,
  // RS007 review fix #13(a): the org's own timezone, threaded onto
  // GroupStatusView (buildGroupStatusView, registrations.ts).
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
    expect(html).toContain("£25");
    expect(usecaseMock.groupById).toHaveBeenCalledWith("g1", "tok");
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
      expect(html).toContain("£25");
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
        (html.match(/>£25</g) || []).length,
        "the offline-due card itself must show its own fee, not just the page Subtotal",
      ).toBeGreaterThanOrEqual(2);
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
        (html.match(/>£25</g) || []).length,
        "the stripe_unavailable card itself must show its own fee, not just the page Subtotal",
      ).toBeGreaterThanOrEqual(2);
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
        (html.match(/>£25</g) || []).length,
        "the confirmed card itself must show its own fee, not just the page Subtotal",
      ).toBeGreaterThanOrEqual(2);
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
        "the confirmed card itself must read Free, not just the page Subtotal",
      ).toBeGreaterThanOrEqual(2);
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
        (html.match(/>£25</g) || []).length,
        "the window_closed card itself must still show its own fee",
      ).toBeGreaterThanOrEqual(2);
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
      const deadline = "2026-09-01T19:00:00.000Z"; // 00:30 on 2 Sept LOCAL in Asia/Kolkata (UTC+5:30)
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

  describe("subtotal — never includes a cancelled entry's stale pre-cancellation fee (FIX 1)", () => {
    it("excludes a withdrawn entry's amount_cents from the page Subtotal — withdrawCore never clears it", async () => {
      usecaseMock.groupById.mockResolvedValueOnce({
        ...BASE_VIEW,
        entries: [
          { ...BASE_ENTRY, id: "reg-1", status: "pending" as const, amount_cents: 2500 },
          { ...BASE_ENTRY, id: "reg-2", status: "withdrawn" as const, amount_cents: 1000 },
        ],
      });
      const html = await render({ rid: "g1", token: "tok" });
      const subtotalMatch = html.match(/<span class="text-lg font-bold text-ink">([^<]*)<\/span>/);
      expect(subtotalMatch, "subtotal span not found").not.toBeNull();
      // withdrawCore (registrations.ts), the rejection path
      // (registration-approval.ts), and the expiry sweep (registrations.ts)
      // all touch ONLY status/timestamps — none ever clears amount_cents —
      // so reg-2's stale 1000 must NOT be folded into the live subtotal.
      expect(subtotalMatch![1]).toContain("25");
      expect(subtotalMatch![1]).not.toContain("35");
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
    // deadline is knowable at all (resolveRefundPolicy, registrations.ts),
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
      // metaphor instead, so it can no longer be read as a payment state.
      expect(html).toContain("1 of 2 checked in");
      // The per-slot link names the unclaimed player and carries their id.
      expect(html).toContain("join_code=JOIN123&amp;player_id=p2");
      // The generic link carries no player_id.
      expect(html).toMatch(/href="\/shared\/riverside\/summer-smash\/register\/join\?join_code=JOIN123"/);
      // join_code itself never appears bare in a way that leaks beyond the
      // href it belongs in — spot-check it isn't duplicated as plain text.
      expect(html.match(/JOIN123/g)?.length).toBe(2); // the two hrefs only
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
      expect(html).not.toMatch(/href="\/shared\/riverside\/summer-smash\/register\/join\?join_code=PAIR456"/);
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
        expect(html).not.toContain("Send Jordan Player their claim link");
        expect(html).not.toContain("Invite someone new to this entry");
      },
    );
  });
});
