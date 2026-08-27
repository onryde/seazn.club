// RS006 — the general-public /r/[ref] cart status page. Same
// renderToStaticMarkup pattern as register/status/__tests__/status-page.test.tsx
// (no jsdom in this workspace) and the same "mock the usecase, not the DB"
// convention. This page is the one this session re-points at the real
// cart-shaped read (publicCartByRef) — it used to unconditionally render
// "Registration is closed" regardless of the ref, including for a real paid
// confirmed cart.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

vi.mock("@/lib/resolve-locale", () => ({ resolveLocale: async () => "en" }));
vi.mock("next/headers", () => ({
  cookies: async () => ({ get: () => undefined, set: () => {}, delete: () => {} }),
  headers: async () => new Headers(),
}));
vi.mock("next/navigation", () => ({
  notFound: () => {
    throw new Error("NOT_FOUND");
  },
}));

// WithdrawByRef is a "use client" island that needs <ConfirmProvider> (root
// layout only, not present in this isolated render) — mock the whole module
// rather than fake the context, same precedent as useConfirm/useRouter under
// the hook-harness. A recognizable stub proves the PAGE wired refCode/token
// through correctly without exercising withdraw-by-ref.tsx's own (untouched,
// already-covered) internals.
vi.mock("@/components/public-site/withdraw-by-ref", () => ({
  WithdrawByRef: ({
    refCode,
    token,
    entryId,
    divisionName,
  }: {
    refCode: string;
    token: string;
    entryId: string;
    divisionName: string;
  }) => (
    <button
      data-testid="withdraw-stub"
      data-ref={refCode}
      data-token={token}
      data-entry={entryId}
      data-division={divisionName}
    />
  ),
}));

const usecases = vi.hoisted(() => ({
  publicCartByRef: vi.fn(),
  reconcileRegistrationBySession: vi.fn(),
}));
vi.mock("@/server/usecases/registrations", () => ({
  publicCartByRef: (...args: unknown[]) => usecases.publicCartByRef(...args),
  reconcileRegistrationBySession: (...args: unknown[]) =>
    usecases.reconcileRegistrationBySession(...args),
}));

beforeEach(() => {
  usecases.publicCartByRef.mockReset();
  usecases.reconcileRegistrationBySession.mockReset().mockResolvedValue(false);
});

import RefStatusPage from "../page";

const render = async (
  ref: string,
  searchParams: Record<string, string>,
): Promise<string> =>
  renderToStaticMarkup(
    await RefStatusPage({
      params: Promise.resolve({ ref }),
      searchParams: Promise.resolve(searchParams),
    }),
  );

const BASE_VIEW = {
  ref_code: "SZ-TEST-01",
  competition_name: "Summer Smash",
  competition_slug: "summer-smash",
  org_slug: "riverside",
  org_name: "Riverside CC",
  starts_on: "2026-09-15",
  ends_on: "2026-09-20",
  created_at: "2026-08-20T10:00:00.000Z",
  can_withdraw: false,
  entries: [
    {
      id: "reg-1",
      status: "confirmed" as const,
      display_name: "Alex Roberts",
      division_name: "Open",
      can_withdraw: false,
    },
    {
      id: "reg-2",
      status: "pending" as const,
      display_name: "Jamie Y.",
      division_name: "Under 15",
      can_withdraw: false,
    },
  ],
};

describe("/r/[ref] cart status page", () => {
  it("renders every entry's division and (already-masked) display name, plus the ref code", async () => {
    usecases.publicCartByRef.mockResolvedValueOnce(BASE_VIEW);
    const html = await render("SZ-TEST-01", {});
    expect(html).toContain("SZ-TEST-01");
    expect(html).toContain("Open");
    expect(html).toContain("Under 15");
    expect(html).toContain("Alex Roberts");
    expect(html).toContain("Jamie Y.");
    expect(html).toContain("Summer Smash");
    expect(html).toContain("Riverside CC");
    expect(usecases.publicCartByRef).toHaveBeenCalledWith("SZ-TEST-01", null);
  });

  it("calls Next's notFound() — a real 404, not a 200 with copy — when the ref does not resolve", async () => {
    const { HttpError } = await import("@/lib/errors");
    usecases.publicCartByRef.mockRejectedValueOnce(new HttpError(404, "registration not found"));
    await expect(render("SZ-NOPE-00", {})).rejects.toThrow("NOT_FOUND");
  });

  it("lets a non-404 error propagate rather than masking it as not-found", async () => {
    usecases.publicCartByRef.mockRejectedValueOnce(new Error("db unreachable"));
    await expect(render("SZ-TEST-01", {})).rejects.toThrow("db unreachable");
  });

  it("reconciles the session BEFORE reading status, only when checkout=success carries a session_id", async () => {
    usecases.publicCartByRef.mockResolvedValueOnce(BASE_VIEW);
    await render("SZ-TEST-01", { checkout: "success", session_id: "cs_test_123" });
    expect(usecases.reconcileRegistrationBySession).toHaveBeenCalledWith("SZ-TEST-01", "cs_test_123");
    expect(usecases.reconcileRegistrationBySession.mock.invocationCallOrder[0]!).toBeLessThan(
      usecases.publicCartByRef.mock.invocationCallOrder[0]!,
    );
  });

  it("does not reconcile on a bare visit, or on checkout=cancelled", async () => {
    usecases.publicCartByRef.mockResolvedValue(BASE_VIEW);
    await render("SZ-TEST-01", {});
    await render("SZ-TEST-01", { checkout: "cancelled" });
    expect(usecases.reconcileRegistrationBySession).not.toHaveBeenCalled();
  });

  // RS006 follow-up (data-integrity fix): withdraw used to be ONE control for
  // the whole cart, wired to whichever entry withdrawRegistrationByRef
  // silently picked (the oldest) — a multi-entry cart gave no way to tell,
  // or choose, which row it would act on. Each entry now carries its OWN
  // can_withdraw, and the page must render a control PER entry, scoped to
  // that entry's id — never a single cart-wide button.
  it("renders a withdraw control per entry, scoped to that entry's id — only where can_withdraw is true AND a token is present", async () => {
    usecases.publicCartByRef.mockResolvedValueOnce({
      ...BASE_VIEW,
      can_withdraw: true,
      entries: [
        { ...BASE_VIEW.entries[0]!, can_withdraw: true },
        { ...BASE_VIEW.entries[1]!, can_withdraw: false },
      ],
    });
    const withToken = await render("SZ-TEST-01", { token: "regtok_abc" });
    // Exactly the withdrawable entry (reg-1) gets a control — reg-2 (its own
    // can_withdraw false) does not, even though the cart-level flag is true
    // and a token is present: this is the exact bug (one flag driving every
    // row) the per-entry field replaces.
    expect(withToken).toContain('data-entry="reg-1"');
    expect(withToken).not.toContain('data-entry="reg-2"');
    expect(withToken).toContain('data-token="regtok_abc"');
    expect(withToken).toContain('data-division="Open"');

    usecases.publicCartByRef.mockResolvedValueOnce({
      ...BASE_VIEW,
      can_withdraw: true,
      entries: [
        { ...BASE_VIEW.entries[0]!, can_withdraw: true },
        { ...BASE_VIEW.entries[1]!, can_withdraw: true },
      ],
    });
    const withoutToken = await render("SZ-TEST-01", {});
    // No ?token= at all — zero controls, regardless of what any entry claims.
    expect(withoutToken).not.toContain("withdraw-stub");

    usecases.publicCartByRef.mockResolvedValueOnce({
      ...BASE_VIEW,
      can_withdraw: false,
      entries: [
        { ...BASE_VIEW.entries[0]!, can_withdraw: false },
        { ...BASE_VIEW.entries[1]!, can_withdraw: false },
      ],
    });
    const noneWithdrawable = await render("SZ-TEST-01", { token: "regtok_abc" });
    expect(noneWithdrawable).not.toContain("withdraw-stub");
  });
});
