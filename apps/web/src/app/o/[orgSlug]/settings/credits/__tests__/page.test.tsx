// Settings → Credits has two sides, Streaming and AI (owner decision 2026-10-20, Option A), told apart by the URL. Streaming
// is the default side (owner, 2026-11-11: streaming credits come first): the bare URL, and `?kind=stream` from links made
// before, open it; `?kind=ai` opens the AI side. The page reads ONLY the side it was asked for. The page's own wiring is under test here: which
// side renders, what it reads, when it reconciles a Stripe return and what it hands the Streaming view. The views are
// stubbed to echo their props as attributes (their own markup is credits/__tests__/stream-view.test.tsx); the data
// modules are fakes that record how they were called.
//
// Mutant table (each applied once by hand, the named test must go red):
//   P1 default side     `creditsKindOf` → "ai" for an absent / unknown value       → "an absent, unknown or repeated kind is the Streaming side"
//   P2 one side's data  load both sides' data on every render                      → "each side reads only its own data"
//   P3 reconcile order  read the balance BEFORE reconciling the return             → "a Stripe return is reconciled before the balance is read"
//   P4 reconcile gate   reconcile on any `checkout` value / with no session id     → "only a success return with a session id is reconciled"
//   P5 cursor           hand `sp.before` to the reader unchecked                   → "a hand-edited before is the latest page, a real one is passed on"
//   P6 who reads        read as a different actor / org than the page resolved     → "the Streaming side reads as the page's own actor, for the page's own org"
//   P7 notice           invert paid / processing, or show a notice for `not_ours`  → "the notice says whether the credits are already in the balance"
//   P8 payer            show the rail to a payer who is not a member               → "a payer who is not a member gets the Streaming side without the rail"
//   P9 rail after read  resolve the rail's context BEFORE the side's own read       → "the rail's streaming balance is the number the Streaming side shows"
//   P10 rail source     the rail reads the AI wallet again                          → "the rail shows the streaming balance on the AI side too"
//   P11 switch order    AI first again                                              → "the switch is on both sides, Streaming first"
import { beforeEach, describe, expect, it, vi } from "vitest";
import { prerender } from "react-dom/static";
import { readFileSync } from "node:fs";
import path from "node:path";

const {
  requireBillingPage, resolveLocale, preferredCurrency, getCreditsTab, getStreamCreditsTab, reconcile,
  orgPlanKey, walletIdFor, balance, ledger,
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
  // The org's match-credit ledger as the rail's reader sees it: `org_stream_credits` summed by bucket.
  ledger: { monthly: 0, pack: 0, fail: false },
}));

// The real `creditBreakdown` (server/usecases/stream-credits.ts, the Streaming side's own authority for the balance) runs
// over this: a statement on `org_stream_credits` answers the ledger above, anything else answers nothing.
vi.mock("@/lib/db", () => ({
  sql: vi.fn(async (strings: unknown) => {
    const text = Array.isArray(strings) ? strings.join("?") : "";
    if (!text.includes("org_stream_credits")) return [];
    if (ledger.fail) throw new Error("ledger unavailable");
    return [{ monthly: String(ledger.monthly), pack: String(ledger.pack) }];
  }),
}));
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
  BillingStreamCredits: (p: { notice: string | null; cursor?: string; orgId: string; orgSlug: string; currency: string; view: { marker: string; total?: number } }) => (
    <div
      data-testid="stream-credits-panel"
      data-total={p.view.total ?? "none"}
      data-notice={p.notice ?? "none"}
      data-cursor={p.cursor ?? "none"}
      data-org={p.orgId}
      data-slug={p.orgSlug}
      data-currency={p.currency}
      data-marker={p.view.marker}
    />
  ),
}));

import { sql } from "@/lib/db";
import { creditBreakdown } from "@/server/usecases/stream-credits";
import CreditsSettingsPage from "../page";

// Expected copy comes from the dictionary FILE, never from the component's own key.
const EN: Record<string, string> = JSON.parse(readFileSync(path.join(process.cwd(), "src/dictionaries/en/ui.json"), "utf8"));
const fill = (s: string, vars: Record<string, string | number>) => s.replace(/\{(\w+)\}/g, (_, k: string) => String(vars[k]));
/** The rail's balance line for `count`, as the dictionary spells it. */
const railLine = (count: number) => fill(EN["settings.nav.streamCreditsLeft"] ?? "<missing settings.nav.streamCreditsLeft>", { count });
/** The rail's balance link: its href and its text, or null when the rail has none. */
function railLink(out: string): { href: string; text: string } | null {
  const m = /<a[^>]*href="([^"]*)"[^>]*data-testid="settings-nav-stream-credits"[^>]*>([^<]*)<\/a>|<a[^>]*data-testid="settings-nav-stream-credits"[^>]*href="([^"]*)"[^>]*>([^<]*)<\/a>/.exec(out);
  if (!m) return null;
  return { href: (m[1] ?? m[3])!, text: (m[2] ?? m[4])! };
}

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
  ledger.monthly = 3;
  ledger.pack = 9;
  ledger.fail = false;
});

describe("Settings → Credits: which side", () => {
  it("an absent, unknown or repeated kind is the Streaming side (P1) — and the AI side reads only for kind=ai", async () => {
    let checked = 0;
    // `{}` is the bare URL every Credits link now opens; `kind=stream` is what links made while AI was the default carry.
    for (const sp of [{}, { kind: "stream" }, { kind: "" }, { kind: "AI" }, { kind: "ai " }, { kind: "streaming" }, { kind: ["ai", "stream"] }, { kind: ["ai", "ai"] }] as SP[]) {
      vi.clearAllMocks();
      requireBillingPage.mockResolvedValue({ org: ORG, auth: AUTH, user: { id: "u1" }, viaPayer: false });
      const out = await render(sp);
      const label = JSON.stringify(sp);
      expect(out, label).toContain('data-testid="stream-credits-panel"');
      expect(out, label).not.toContain('data-testid="ai-credits-panel"');
      expect(getCreditsTab, label).not.toHaveBeenCalled();
      checked++;
    }
    expect(checked, "anti-vacuity: every Streaming-side URL was rendered").toBe(8);
    // positive pair: kind=ai, exactly, is the AI side
    getStreamCreditsTab.mockClear();
    const ai = await render({ kind: "ai" });
    expect(ai).toContain('data-testid="ai-credits-panel"');
    expect(ai).not.toContain('data-testid="stream-credits-panel"');
    expect(getStreamCreditsTab).not.toHaveBeenCalled();
  });

  it("each side reads only its own data (P2)", async () => {
    await render({});
    expect(getStreamCreditsTab).toHaveBeenCalledTimes(1);
    expect(getCreditsTab).not.toHaveBeenCalled();
    vi.clearAllMocks();
    requireBillingPage.mockResolvedValue({ org: ORG, auth: AUTH, user: { id: "u1" }, viaPayer: false });
    await render({ kind: "ai" });
    expect(getCreditsTab).toHaveBeenCalledTimes(1);
    expect(getStreamCreditsTab).not.toHaveBeenCalled();
  });

  it("the switch is on both sides, Streaming first (P11), names the current one, and the default side keeps the bare URL", async () => {
    let checked = 0;
    for (const [sp, current, other] of [[{}, "stream", "ai"], [{ kind: "stream" }, "stream", "ai"], [{ kind: "ai" }, "ai", "stream"]] as const) {
      const out = await render(sp);
      const label = JSON.stringify(sp);
      expect(out, label).toContain('data-testid="credits-kind-switch"');
      const links = [...out.matchAll(/<a[^>]*data-testid="credits-kind-(ai|stream)"[^>]*>/g)];
      expect(links.map((m) => m[1]), `${label}: Streaming, then AI`).toEqual(["stream", "ai"]);
      const tag = (k: string) => links.find((m) => m[1] === k)![0];
      expect(tag(current), label).toContain('aria-current="page"');
      expect(tag(other), label).not.toContain("aria-current");
      expect(tag("stream"), label).toContain('href="/o/riverside/settings/credits"');
      expect(tag("ai"), label).toContain('href="/o/riverside/settings/credits?kind=ai"');
      checked++;
    }
    expect(checked).toBe(3);
  });
});

describe("Settings → Credits: the rail's streaming balance", () => {
  it("the rail's streaming balance is the number the Streaming side shows — read after that side's own read, which grants the month first (P9)", async () => {
    // A month's first visit: the ledger holds 9 bought credits and none of this month's free ones until the Streaming
    // side's read grants them (`relayCredits` → `ensureMonthlyStreamGrant`). Stubbed here as a read that writes the grant
    // into the ledger and then answers the balance through the SAME authority the rail reads.
    ledger.monthly = 0;
    ledger.pack = 9;
    const before = (await creditBreakdown(sql, "org-1")).total;
    getStreamCreditsTab.mockImplementation(async () => {
      ledger.monthly = 5;
      return { marker: "view-1", total: (await creditBreakdown(sql, "org-1")).total };
    });
    const out = await render({});
    const shown = Number(/data-testid="stream-credits-panel"[^>]*data-total="(\d+)"/.exec(out)?.[1] ?? Number.NaN);
    expect(shown, "the Streaming side shows the granted balance").toBe((await creditBreakdown(sql, "org-1")).total);
    expect(shown, "differential: the grant moved the balance, or this test cannot tell the order").not.toBe(before);
    const rail = railLink(out);
    expect(rail, "the rail's balance link").not.toBeNull();
    expect(rail!.text).toBe(railLine(shown));
    expect(rail!.text).not.toBe(railLine(before));
  });

  it("the rail shows the streaming balance on the AI side too, never the AI wallet's (P10), and links to the Streaming side", async () => {
    let checked = 0;
    for (const sp of [{ kind: "ai" }, {}] as SP[]) {
      const out = await render(sp);
      const expected = (await creditBreakdown(sql, "org-1")).total;
      expect(expected, "differential: the AI wallet's 37 is not the streaming balance").not.toBe(await balance());
      const rail = railLink(out);
      expect(rail, JSON.stringify(sp)).not.toBeNull();
      expect(rail!.text).toBe(railLine(expected));
      expect(rail!.href, "the bare URL — the Streaming side").toBe("/o/riverside/settings/credits");
      checked++;
    }
    expect(checked).toBe(2);
  });

  it("a ledger read that fails drops the rail's header, not the page", async () => {
    ledger.fail = true;
    const out = await render({ kind: "ai" });
    expect(out).toContain('data-testid="ai-credits-panel"');
    expect(railLink(out)).toBeNull();
    // the rail itself is still there — only its plan/balance header is skipped
    expect(out).toContain("/o/riverside/settings?tab=organization");
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
      { kind: "ai", checkout: "success", session_id: "cs_1" }, // the AI side: a return there is not this ledger's
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

    // The bare URL is the Streaming side now, so a success return to it is this ledger's too.
    reconcile.mockClear();
    await render({ checkout: "success", session_id: "cs_bare" });
    expect(reconcile).toHaveBeenCalledWith("org-1", "cs_bare");
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
