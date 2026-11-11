// The Settings sidebar must be on EVERY Settings surface.
//
// Billing, Connect, Credits and Add-ons own their own routes (each has a
// Stripe reconcile-on-return round trip or its own gate) and for that reason
// rendered as bare single-column pages: you clicked "Plan & Billing" in the
// menu and the menu vanished, leaving a Back link as the only way out. The
// tabbed index was the only page that had navigation.
//
// One exception survives, and it is not cosmetic: a PAYER who is not a member
// of this org reaches Billing/Credits/Add-ons from their bill (v17 gap #333).
// Every link in the sidebar points at a member-gated route, so showing it to
// them would be a menu of ten 404s. Both directions are asserted — a fix
// that shows the nav to everyone would pass a "nav is present" test.
//
// The rail's header (desktop) carries the plan and the org's STREAMING credit balance (owner, 2026-11-11: streaming
// credits are promoted over AI credits), read through the Streaming side's own authority for that number.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { prerender } from "react-dom/static";
import { readFileSync } from "node:fs";
import path from "node:path";

const {
  requireOrgPage, requireBillingPage, resolveLocale, preferredCurrency, getCreditsTab,
  orgPlanKey, walletIdFor, balance, ledger, projectedStreamCreditsTotal,
} = vi.hoisted(() => ({
  requireOrgPage: vi.fn(),
  requireBillingPage: vi.fn(),
  resolveLocale: vi.fn(),
  preferredCurrency: vi.fn(),
  getCreditsTab: vi.fn(),
  orgPlanKey: vi.fn(),
  walletIdFor: vi.fn(),
  balance: vi.fn(),
  // The org's match-credit ledger, summed by bucket, as `org_stream_credits` would answer it.
  ledger: { monthly: 0, pack: 0, fail: false },
  // The rail's read-only projection (usecases/__tests__/stream-credits-rail-projection.test.ts drives it over a real DB).
  projectedStreamCreditsTotal: vi.fn(),
}));

// A statement on `org_stream_credits` (the real `creditBreakdown` runs over this mock) answers the ledger above; any other
// answers the Connect page's row.
vi.mock("@/lib/db", () => ({
  sql: vi.fn(async (strings: unknown) => {
    const text = Array.isArray(strings) ? strings.join("?") : "";
    if (!text.includes("org_stream_credits")) return [{ payment_instructions: null, default_payment_method: "offline" }];
    if (ledger.fail) throw new Error("ledger unavailable");
    return [{ monthly: String(ledger.monthly), pack: String(ledger.pack) }];
  }),
}));
vi.mock("@/server/page-auth", () => ({ requireOrgPage, requireBillingPage }));
vi.mock("@/lib/resolve-locale", () => ({ resolveLocale }));
vi.mock("@/lib/currency-server", () => ({ preferredCurrency }));
vi.mock("@/server/usecases/credits-tab", () => ({ getCreditsTab }));
vi.mock("@/lib/entitlements", () => ({ orgPlanKey }));
vi.mock("@/lib/credits", () => ({ walletIdFor, balance }));
vi.mock("@/components/org-payment-instructions", () => ({
  OrgPaymentInstructions: () => <div data-testid="connect-panel" />,
}));
vi.mock("@/components/billing-credits", () => ({
  BillingCredits: () => <div data-testid="credits-panel" />,
}));
// The Credits page has two sides; Streaming is the default (the bare URL) and AI is `?kind=ai`. These tests are about the
// sidebar, so both sides' data modules are stubbed; credits/__tests__/page.test.tsx is the one that drives the sides.
vi.mock("@/server/usecases/stream-credits-tab", () => ({ getStreamCreditsTab: vi.fn(), projectedStreamCreditsTotal }));
vi.mock("@/server/usecases/stream-credits-checkout", () => ({ reconcileStreamCreditsReturn: vi.fn() }));
vi.mock("@/components/billing-stream-credits", () => ({ BillingStreamCredits: () => <div data-testid="stream-credits-panel" /> }));

import { getDictionary } from "@/lib/i18n";
import { creditsKindOf } from "@/components/credits-kind-switch";
import { SettingsShell, SETTINGS_TABS, navContext } from "../_components/settings-nav";
import ConnectSettingsPage from "../connect/page";
import CreditsSettingsPage from "../credits/page";

const ORG = { id: "org-1", name: "Riverside", slug: "riverside", role: "owner" };

// Expected copy comes from the dictionary FILES, never from the component's own key.
const dictFile = (loc: string): Record<string, string> =>
  JSON.parse(readFileSync(path.join(process.cwd(), "src/dictionaries", loc, "ui.json"), "utf8"));
const fill = (s: string, vars: Record<string, string | number>) => s.replace(/\{(\w+)\}/g, (_, k: string) => String(vars[k]));
const esc = (s: string) => s.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&#x27;");
/** The rail's balance link (`data-testid="settings-nav-stream-credits"`): its href and text, or null. */
function railLink(out: string): { href: string; text: string } | null {
  const m = /<a[^>]*href="([^"]*)"[^>]*data-testid="settings-nav-stream-credits"[^>]*>([^<]*)<\/a>|<a[^>]*data-testid="settings-nav-stream-credits"[^>]*href="([^"]*)"[^>]*>([^<]*)<\/a>/.exec(out);
  if (!m) return null;
  return { href: (m[1] ?? m[3])!, text: (m[2] ?? m[4])! };
}

async function html(element: React.ReactElement): Promise<string> {
  const { prelude } = await prerender(element);
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
  requireOrgPage.mockResolvedValue({ org: ORG, user: { id: "u1" }, canEdit: true });
  requireBillingPage.mockResolvedValue({ org: ORG, user: { id: "u1" }, viaPayer: false });
  getCreditsTab.mockResolvedValue({
    balance: 0, granted: 0, spent: 0, periodStart: null, periodEnd: null, entries: [],
  });
  orgPlanKey.mockResolvedValue("pro");
  walletIdFor.mockResolvedValue("w1");
  balance.mockResolvedValue(37);
  ledger.monthly = 3;
  ledger.pack = 9;
  ledger.fail = false;
  projectedStreamCreditsTotal.mockResolvedValue(12);
});

describe("the Settings sidebar", () => {
  it("links every tab AND every route-owning page", async () => {
    const dict = await getDictionary("en", "ui");
    const out = await html(
      <SettingsShell orgSlug="riverside" active="billing" dict={dict}>
        <p>panel</p>
      </SettingsShell>,
    );

    for (const tab of SETTINGS_TABS) {
      expect(out, `missing ?tab=${tab}`).toContain(`/o/riverside/settings?tab=${tab}`);
    }
    for (const route of ["connect", "billing", "credits", "add-ons"]) {
      expect(out, `missing /${route}`).toContain(`/o/riverside/settings/${route}`);
    }
  });

  it("marks exactly one item current, and it is the one asked for", async () => {
    const dict = await getDictionary("en", "ui");
    const out = await html(
      <SettingsShell orgSlug="riverside" active="credits" dict={dict}>
        <p>panel</p>
      </SettingsShell>,
    );

    expect(out.match(/aria-current="page"/g)).toHaveLength(1);
    // aria-current is what ScrollActiveTabIntoView looks for to drag the
    // active chip into view on a 320px strip, so this is load-bearing twice.
    const marked = out.match(/<a[^>]*aria-current="page"[^>]*>/)?.[0] ?? "";
    expect(marked).toContain("/o/riverside/settings/credits");
  });

  it("groups the links without rendering any of them twice", async () => {
    const dict = await getDictionary("en", "ui");
    const out = await html(
      <SettingsShell orgSlug="riverside" active="credits" dict={dict}>
        <p>panel</p>
      </SettingsShell>,
    );

    for (const header of ["Organisation", "Money", "You"]) {
      expect(out, `no ${header} group`).toContain(header);
    }
    // The obvious way to get headers on desktop and a flat strip on phones is
    // to render the list twice and hide one with CSS. That puts every link —
    // and `aria-current` — in the document twice, which a screen reader reads
    // as two current pages. One rendering, reshaped with `display: contents`.
    const links = out.match(/\/o\/riverside\/settings\/credits"/g) ?? [];
    expect(links).toHaveLength(1);
  });

  it("shows the plan and the streaming credit balance, linked to the Streaming side, in every locale", async () => {
    // Both used to be visible only from the page that owns them — which is
    // exactly where an owner is NOT looking when they run out mid-schedule.
    let checked = 0;
    for (const loc of ["en", "nl", "fr", "es"] as const) {
      const dict = await getDictionary(loc, "ui");
      const out = await html(
        <SettingsShell orgSlug="riverside" active="billing" dict={dict} context={{ plan: "Pro", streamCredits: 12 }}>
          <p>panel</p>
        </SettingsShell>,
      );
      const file = dictFile(loc);
      const rail = railLink(out);
      expect(out, loc).toContain("Pro");
      expect(rail, `${loc}: the balance link`).not.toBeNull();
      expect(file["settings.nav.streamCreditsLeft"], `${loc} has the copy`).toBeTruthy();
      expect(rail!.text, loc).toBe(esc(fill(file["settings.nav.streamCreditsLeft"]!, { count: 12 })));
      // Whatever URL the rail links, the Credits page's own parser must read it as the Streaming side.
      const url = new URL(rail!.href, "https://seazn.test");
      expect(url.pathname, loc).toBe("/o/riverside/settings/credits");
      const kinds = url.searchParams.getAll("kind");
      expect(creditsKindOf(kinds.length > 1 ? kinds : kinds[0]), loc).toBe("stream");
      checked++;
    }
    expect(checked, "anti-vacuity: all four locales were rendered").toBe(4);
  });

  it("renders the rail without context rather than failing", async () => {
    const dict = await getDictionary("en", "ui");
    const out = await html(
      <SettingsShell orgSlug="riverside" active="billing" dict={dict}>
        <p>panel</p>
      </SettingsShell>,
    );

    expect(railLink(out)).toBeNull();
    expect(out).toContain("/o/riverside/settings?tab=organization");
    // positive pair: the same shell WITH context has the link the assertion above looks for
    const withCtx = await html(
      <SettingsShell orgSlug="riverside" active="billing" dict={dict} context={{ plan: "Pro", streamCredits: 0 }}>
        <p>panel</p>
      </SettingsShell>,
    );
    expect(railLink(withCtx)).not.toBeNull();
  });

  it("is dropped for a payer who is not a member of this org", async () => {
    const dict = await getDictionary("en", "ui");
    const out = await html(
      <SettingsShell orgSlug="riverside" active="billing" dict={dict} showNav={false}>
        <p data-testid="the-panel">panel</p>
      </SettingsShell>,
    );

    expect(out).not.toContain("/o/riverside/settings?tab=organization");
    // The page itself still renders — this is a nav decision, not a gate.
    expect(out).toContain("the-panel");
  });
});

describe("route-owning Settings pages mount the sidebar", () => {
  it("Connect does", async () => {
    const out = await html(
      await ConnectSettingsPage({ params: Promise.resolve({ orgSlug: "riverside" }) }),
    );
    expect(out).toContain("connect-panel");
    expect(out).toContain("/o/riverside/settings?tab=organization");
  });

  // Both sides, each anchored on its own panel's `data-testid="` (a bare "credits-panel" is a substring of
  // "stream-credits-panel", so it would pass on either side).
  it("Credits does for a member, on both sides", async () => {
    let checked = 0;
    for (const [kind, panel] of [[undefined, "stream-credits-panel"], ["ai", "credits-panel"]] as const) {
      const out = await html(
        await CreditsSettingsPage({ params: Promise.resolve({ orgSlug: "riverside" }), searchParams: Promise.resolve(kind ? { kind } : {}) }),
      );
      expect(out, String(kind)).toContain(`data-testid="${panel}"`);
      expect(out, String(kind)).toContain("/o/riverside/settings?tab=organization");
      checked++;
    }
    expect(checked).toBe(2);
  });

  it("Credits does NOT for a payer arriving from the bill", async () => {
    requireBillingPage.mockResolvedValue({ org: ORG, user: { id: "u9" }, viaPayer: true });
    const out = await html(
      await CreditsSettingsPage({ params: Promise.resolve({ orgSlug: "riverside" }), searchParams: Promise.resolve({}) }),
    );

    expect(out).toContain('data-testid="stream-credits-panel"');
    expect(out).not.toContain("/o/riverside/settings?tab=organization");
  });
});

describe("navContext", () => {
  it("returns the plan label and the Streaming tab's projected balance — never the AI wallet's", async () => {
    expect(await balance(), "differential: the AI wallet's balance is not the streaming balance").not.toBe(12);
    expect(await navContext("org-1")).toEqual({ plan: "Pro", streamCredits: 12 });
    expect(projectedStreamCreditsTotal).toHaveBeenCalledWith("org-1");
    // a second call over a number that moved answers the new number (no memo)
    projectedStreamCreditsTotal.mockResolvedValue(20);
    expect(await navContext("org-1")).toEqual({ plan: "Pro", streamCredits: 20 });
    // the empty ledger is 0, not null: an org that never streamed still gets the rail header
    projectedStreamCreditsTotal.mockResolvedValue(0);
    expect(await navContext("org-1")).toEqual({ plan: "Pro", streamCredits: 0 });
  });

  it("never reads the AI wallet", async () => {
    await navContext("org-1");
    expect(projectedStreamCreditsTotal).toHaveBeenCalled();
    expect(balance).not.toHaveBeenCalled();
    expect(walletIdFor).not.toHaveBeenCalled();
  });

  it("returns null rather than taking the page down when a read fails", async () => {
    // The rail is navigation. A credits outage must not 500 every Settings
    // page in the product.
    projectedStreamCreditsTotal.mockRejectedValue(new Error("ledger unavailable"));
    expect(await navContext("org-1")).toBeNull();
    projectedStreamCreditsTotal.mockResolvedValue(12);
    orgPlanKey.mockRejectedValue(new Error("entitlements unavailable"));
    expect(await navContext("org-1")).toBeNull();
  });
});
