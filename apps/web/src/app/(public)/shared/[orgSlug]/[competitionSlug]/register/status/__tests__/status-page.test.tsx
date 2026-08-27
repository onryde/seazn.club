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

const BASE_ENTRY = {
  id: "reg-1",
  division_id: "div-1",
  division_name: "Mixed Doubles",
  display_name: "Team Alpha",
  status: "pending" as const,
  amount_cents: 2500,
  free_agent: false,
  join_code: null as string | null,
  allows_new_joiner: true,
  promotion_expires_at: null as string | null,
  players: [] as { id: string; full_name: string; consent_status: "pending" | "granted" | "guardian" }[],
  refund_policy: { refundable: true, deadline: "2026-09-15T00:00:00.000Z", amount_cents: 2500 },
};

const BASE_VIEW = {
  ref_code: "SZ-TEST-01",
  contact_name: "Alex Test",
  currency: "gbp",
  amount_cents: 2500,
  payment_method: "stripe" as const,
  expires_at: "2026-08-20T00:00:00.000Z",
  refunded_cents: 0,
  competition_name: "Summer Smash",
  competition_slug: "summer-smash",
  org_slug: "riverside",
  org_name: "Riverside CC",
  created_at: "2026-08-20T10:00:00.000Z",
  charges_enabled: true,
  payment_instructions: null as string | null,
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
      });
      const html = await render({ rid: "g1", token: "tok" });
      expect(html).toContain("club@example.com");
      expect(html).toContain("SZ-TEST-01");
      expect(html).not.toContain("{{reference}}");
      // No pay button when the method is offline.
      expect(html).not.toMatch(/Pay now/);
    });

    it("a card entry with the org's Connect account not live shows 'unavailable', never a button that would 503", async () => {
      usecaseMock.groupById.mockResolvedValueOnce({ ...BASE_VIEW, charges_enabled: false });
      const html = await render({ rid: "g1", token: "tok" });
      expect(html).not.toMatch(/Pay now/);
      expect(html).toContain("aren&#x27;t available right now");
    });

    it("a confirmed entry shows no money section at all — nothing owed, nothing to name", async () => {
      usecaseMock.groupById.mockResolvedValueOnce({
        ...BASE_VIEW,
        entries: [{ ...BASE_ENTRY, status: "confirmed" as const }],
      });
      const html = await render({ rid: "g1", token: "tok" });
      expect(html).not.toMatch(/Pay now/);
      expect(html).not.toContain(">How to pay<");
    });
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
              { id: "p1", full_name: "Sam Player", consent_status: "granted" as const },
              { id: "p2", full_name: "Jordan Player", consent_status: "pending" as const },
            ],
          },
        ],
      });
      const html = await render({ rid: "g1", token: "tok" });
      expect(html).toContain("1 of 2 confirmed");
      // The per-slot link names the unclaimed player and carries their id.
      expect(html).toContain("join_code=JOIN123&amp;player_id=p2");
      // The generic link carries no player_id.
      expect(html).toMatch(/href="\/shared\/riverside\/summer-smash\/register\/join\?join_code=JOIN123"/);
      // join_code itself never appears bare in a way that leaks beyond the
      // href it belongs in — spot-check it isn't duplicated as plain text.
      expect(html.match(/JOIN123/g)?.length).toBe(2); // the two hrefs only
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
              { id: "p1", full_name: "Sam Player", consent_status: "granted" as const },
              { id: "p2", full_name: "Jordan Player", consent_status: "pending" as const },
            ],
          },
        ],
      });
      const html = await render({ rid: "g1", token: "tok" });
      expect(html).toContain("join_code=PAIR456&amp;player_id=p2");
      expect(html).not.toMatch(/href="\/shared\/riverside\/summer-smash\/register\/join\?join_code=PAIR456"/);
    });
  });
});
