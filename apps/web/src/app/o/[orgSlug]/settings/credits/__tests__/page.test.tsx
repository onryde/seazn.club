// Settings → Credits has two sides, AI and Streaming (owner decision 2026-10-20, Option A), told apart by the URL —
// `?kind=stream` — and the page reads ONLY the side it was asked for. The page's own wiring is under test here: which
// side renders, what it reads, when it reconciles a Stripe return and what it hands the Streaming view. The views are
// stubbed to echo their props as attributes (their own markup is credits/__tests__/stream-view.test.tsx); the data
// modules are fakes that record how they were called.
//
// Mutant table (each applied once by hand, the named test must go red):
//   P1 default side     `creditsKindOf` → "stream" for an absent / unknown value   → "an absent, unknown or repeated kind is the AI side"
//   P2 one side's data  load both sides' data on every render                      → "each side reads only its own data"
//   P3 reconcile order  read the balance BEFORE reconciling the return             → "a Stripe return is reconciled before the balance is read"
//   P4 reconcile gate   reconcile on any `checkout` value / with no session id     → "only a success return with a session id is reconciled"
//   P5 cursor           hand `sp.before` to the reader unchecked                   → "a hand-edited before is the latest page, a real one is passed on"
//   P6 who reads        read as a different actor / org than the page resolved     → "the Streaming side reads as the page's own actor, for the page's own org"
//   P7 notice           invert paid / processing, or show a notice for `not_ours`  → "the notice says whether the credits are already in the balance"
//   P8 payer            show the rail to a payer who is not a member               → "a payer who is not a member gets the Streaming side without the rail"
import { beforeEach, describe, expect, it, vi } from "vitest";
import { prerender } from "react-dom/static";

const {
  requireBillingPage, resolveLocale, preferredCurrency, getCreditsTab, getStreamCreditsTab, reconcile,
  orgPlanKey, walletIdFor, balance,
} = vi.hoisted(() => ({
  requireBillingPage: vi.fn(),
  resolveLocale: vi.fn(),
  preferredCurrency: vi.fn(),
  getCreditsTab: vi.fn(),
  getStreamCreditsTab: vi.fn(),
  reconcile: vi.fn(),
  orgPlanKey: vi.fn(),
  walletIdFor: vi.fn(),
  balance: vi.fn(),
}));

vi.mock("@/lib/db", () => ({ sql: vi.fn(async () => []) }));
vi.mock("@/server/page-auth", () => ({ requireBillingPage, requireOrgPage: vi.fn() }));
vi.mock("@/lib/resolve-locale", () => ({ resolveLocale }));
vi.mock("@/lib/currency-server", () => ({ preferredCurrency }));
vi.mock("@/server/usecases/credits-tab", () => ({ getCreditsTab }));
vi.mock("@/server/usecases/stream-credits-tab", () => ({ getStreamCreditsTab }));
vi.mock("@/server/usecases/stream-credits-checkout", () => ({ reconcileStreamCreditsReturn: reconcile }));
vi.mock("@/lib/entitlements", () => ({ orgPlanKey }));
vi.mock("@/lib/credits", () => ({ walletIdFor, balance }));
vi.mock("@/components/billing-credits", () => ({ BillingCredits: () => <div data-testid="ai-credits-panel" /> }));
vi.mock("@/components/billing-stream-credits", () => ({
  BillingStreamCredits: (p: { notice: string | null; cursor?: string; orgId: string; orgSlug: string; currency: string; view: { marker: string } }) => (
    <div
      data-testid="stream-credits-panel"
      data-notice={p.notice ?? "none"}
      data-cursor={p.cursor ?? "none"}
      data-org={p.orgId}
      data-slug={p.orgSlug}
      data-currency={p.currency}
      data-marker={p.view.marker}
    />
  ),
}));

import CreditsSettingsPage from "../page";

const ORG = { id: "org-1", name: "Riverside", slug: "riverside", role: "owner" };
const AUTH = { orgId: "org-1", via: "session", userId: "u1", role: "owner", keyId: null };
// A cursor of the reader's own shape (`<created_at as text>|<t|f>|<uuid>`, base64url) — the page only has to recognise it.
const GOOD_CURSOR = Buffer.from("2026-10-20 09:00:00.123456+00|t|11111111-1111-1111-1111-111111111111").toString("base64url");

type SP = { kind?: string | string[]; before?: string | string[]; checkout?: string | string[]; session_id?: string | string[] };

async function render(sp: SP = {}): Promise<string> {
  const el = await CreditsSettingsPage({ params: Promise.resolve({ orgSlug: "riverside" }), searchParams: Promise.resolve(sp) });
  const { prelude } = await prerender(el);
  const reader = (prelude as ReadableStream<Uint8Array>).getReader();
  const decoder = new TextDecoder();
  let out = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    out += decoder.decode(value, { stream: true });
  }
  return out;
}

beforeEach(() => {
  vi.clearAllMocks();
  resolveLocale.mockResolvedValue("en");
  preferredCurrency.mockResolvedValue("gbp");
  requireBillingPage.mockResolvedValue({ org: ORG, auth: AUTH, user: { id: "u1" }, viaPayer: false });
  getCreditsTab.mockResolvedValue({ balance: 0, entries: [] });
  getStreamCreditsTab.mockResolvedValue({ marker: "view-1" });
  reconcile.mockResolvedValue(true);
  orgPlanKey.mockResolvedValue("pro");
  walletIdFor.mockResolvedValue("w1");
  balance.mockResolvedValue(37);
});

describe("Settings → Credits: which side", () => {
  it("an absent, unknown or repeated kind is the AI side (P1) — and the Streaming side reads only for kind=stream", async () => {
    let checked = 0;
    for (const sp of [{}, { kind: "ai" }, { kind: "" }, { kind: "Stream" }, { kind: "streaming" }, { kind: ["stream", "ai"] }, { kind: ["stream", "stream"] }] as SP[]) {
      vi.clearAllMocks();
      requireBillingPage.mockResolvedValue({ org: ORG, auth: AUTH, user: { id: "u1" }, viaPayer: false });
      const out = await render(sp);
      const label = JSON.stringify(sp);
      expect(out, label).toContain('data-testid="ai-credits-panel"');
      expect(out, label).not.toContain('data-testid="stream-credits-panel"');
      expect(getStreamCreditsTab, label).not.toHaveBeenCalled();
      checked++;
    }
    expect(checked).toBe(7);
    // positive pair
    const stream = await render({ kind: "stream" });
    expect(stream).toContain('data-testid="stream-credits-panel"');
    expect(stream).not.toContain('data-testid="ai-credits-panel"');
  });

  it("each side reads only its own data (P2)", async () => {
    await render({});
    expect(getCreditsTab).toHaveBeenCalledTimes(1);
    expect(getStreamCreditsTab).not.toHaveBeenCalled();
    vi.clearAllMocks();
    requireBillingPage.mockResolvedValue({ org: ORG, auth: AUTH, user: { id: "u1" }, viaPayer: false });
    getStreamCreditsTab.mockResolvedValue({ marker: "view-1" });
    await render({ kind: "stream" });
    expect(getStreamCreditsTab).toHaveBeenCalledTimes(1);
    expect(getCreditsTab).not.toHaveBeenCalled();
  });

  it("the switch is on both sides, names the current one, and the default side keeps its bare URL", async () => {
    for (const [sp, current, other] of [[{}, "ai", "stream"], [{ kind: "stream" }, "stream", "ai"]] as const) {
      const out = await render(sp);
      expect(out).toContain('data-testid="credits-kind-switch"');
      const links = [...out.matchAll(/<a[^>]*data-testid="credits-kind-(ai|stream)"[^>]*>/g)].map((m) => m[0]);
      expect(links).toHaveLength(2);
      const cur = links.find((l) => l.includes(`credits-kind-${current}"`))!;
      const oth = links.find((l) => l.includes(`credits-kind-${other}"`))!;
      expect(cur).toContain('aria-current="page"');
      expect(oth).not.toContain("aria-current");
      expect(links.find((l) => l.includes('credits-kind-ai"'))).toContain('href="/o/riverside/settings/credits"');
      expect(links.find((l) => l.includes('credits-kind-stream"'))).toContain('href="/o/riverside/settings/credits?kind=stream"');
    }
  });
});

describe("Settings → Credits → Streaming: what the page hands the view", () => {
  it("reads as the page's own actor for the page's own org, and hands the view the org's id, slug and currency (P6)", async () => {
    requireBillingPage.mockResolvedValue({ org: { ...ORG, id: "org-9", slug: "other-club" }, auth: { ...AUTH, orgId: "org-9" }, user: { id: "u1" }, viaPayer: false });
    preferredCurrency.mockResolvedValue("eur");
    const out = await render({ kind: "stream" });
    expect(getStreamCreditsTab).toHaveBeenCalledWith({ ...AUTH, orgId: "org-9" }, "org-9", { cursor: undefined });
    expect(out).toContain('data-org="org-9"');
    expect(out).toContain('data-slug="riverside"'); // the SLUG in the URL, which requireBillingPage resolved this org from
    expect(out).toContain('data-currency="eur"');
    expect(out).toContain('data-marker="view-1"');
  });

  it("only a success return with a session id is reconciled (P4) — and before the balance is read (P3)", async () => {
    let skipped = 0;
    for (const sp of [
      { kind: "stream" },
      { kind: "stream", checkout: "success" },
      { kind: "stream", checkout: "success", session_id: "" },
      { kind: "stream", checkout: "cancel", session_id: "cs_1" },
      { kind: "stream", session_id: "cs_1" },
      { kind: "stream", checkout: "success", session_id: ["cs_1", "cs_2"] },
      { checkout: "success", session_id: "cs_1" }, // the AI side: a return there is not this ledger's
    ] as SP[]) {
      reconcile.mockClear();
      await render(sp);
      expect(reconcile, JSON.stringify(sp)).not.toHaveBeenCalled();
      skipped++;
    }
    expect(skipped).toBe(7);

    reconcile.mockClear();
    getStreamCreditsTab.mockClear();
    await render({ kind: "stream", checkout: "success", session_id: "cs_live" });
    expect(reconcile).toHaveBeenCalledTimes(1);
    expect(reconcile).toHaveBeenCalledWith("org-1", "cs_live");
    expect(reconcile.mock.invocationCallOrder[0]!, "reconciled before the balance is read").toBeLessThan(getStreamCreditsTab.mock.invocationCallOrder[0]!);
  });

  it("the notice says whether the credits are already in the balance (P7); no return, no notice", async () => {
    // Four honest answers, each its own notice: in the balance, still processing, unconfirmed (terminal), and nothing of this org's (a foreign or
    // hand-edited session id, another kind of checkout, one never completed) — which says nothing at all (m3).
    let judged = 0;
    for (const [outcome, notice] of [["granted", "paid"], ["processing", "processing"], ["unconfirmed", "unconfirmed"], ["not_ours", "none"]] as const) {
      reconcile.mockResolvedValue(outcome);
      expect(await render({ kind: "stream", checkout: "success", session_id: "cs_1" }), outcome).toContain(`data-notice="${notice}"`);
      judged += 1;
    }
    expect(judged, "anti-vacuity: all four outcomes were judged").toBe(4);
    expect(await render({ kind: "stream" })).toContain('data-notice="none"');
  });

  it("a hand-edited before is the latest page, a real one is passed on (P5)", async () => {
    for (const before of ["", "nonsense", "bm9wZQ", ["a", "b"]] as const) {
      getStreamCreditsTab.mockClear();
      const out = await render({ kind: "stream", before: before as string });
      expect(getStreamCreditsTab, JSON.stringify(before)).toHaveBeenCalledWith(AUTH, "org-1", { cursor: undefined });
      expect(out).toContain('data-cursor="none"');
    }
    getStreamCreditsTab.mockClear();
    const out = await render({ kind: "stream", before: GOOD_CURSOR });
    expect(getStreamCreditsTab).toHaveBeenCalledWith(AUTH, "org-1", { cursor: GOOD_CURSOR });
    expect(out).toContain(`data-cursor="${GOOD_CURSOR}"`);
  });

  it("a payer who is not a member gets the Streaming side without the rail (P8), and the same read as a member", async () => {
    requireBillingPage.mockResolvedValue({ org: ORG, auth: { ...AUTH, role: null }, user: { id: "u9" }, viaPayer: true });
    const out = await render({ kind: "stream" });
    expect(out).toContain('data-testid="stream-credits-panel"');
    expect(out).not.toContain("/o/riverside/settings?tab=organization");
    expect(getStreamCreditsTab).toHaveBeenCalledWith({ ...AUTH, role: null }, "org-1", { cursor: undefined });
    // positive pair: a member keeps the rail on the same side
    requireBillingPage.mockResolvedValue({ org: ORG, auth: AUTH, user: { id: "u1" }, viaPayer: false });
    expect(await render({ kind: "stream" })).toContain("/o/riverside/settings?tab=organization");
  });
});
