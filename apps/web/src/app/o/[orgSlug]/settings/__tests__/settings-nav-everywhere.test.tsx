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
// them would be a menu of eleven 404s. Both directions are asserted — a fix
// that shows the nav to everyone would pass a "nav is present" test.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { prerender } from "react-dom/static";

const {
  requireOrgPage, requireBillingPage, resolveLocale, preferredCurrency, getCreditsTab,
  orgPlanKey, walletIdFor, balance,
} = vi.hoisted(() => ({
  requireOrgPage: vi.fn(),
  requireBillingPage: vi.fn(),
  resolveLocale: vi.fn(),
  preferredCurrency: vi.fn(),
  getCreditsTab: vi.fn(),
  orgPlanKey: vi.fn(),
  walletIdFor: vi.fn(),
  balance: vi.fn(),
}));

vi.mock("@/lib/db", () => ({
  sql: vi.fn(async () => [{ payment_instructions: null, default_payment_method: "offline" }]),
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

import { getDictionary } from "@/lib/i18n";
import { SettingsShell, SETTINGS_TABS, navContext } from "../_components/settings-nav";
import ConnectSettingsPage from "../connect/page";
import CreditsSettingsPage from "../credits/page";

const ORG = { id: "org-1", name: "Riverside", slug: "riverside", role: "owner" };

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

  it("shows the plan and credit balance when the page hands it context", async () => {
    const dict = await getDictionary("en", "ui");
    const out = await html(
      <SettingsShell
        orgSlug="riverside"
        active="billing"
        dict={dict}
        context={{ plan: "Pro", credits: 37 }}
      >
        <p>panel</p>
      </SettingsShell>,
    );

    // Both used to be visible only from the page that owns them — which is
    // exactly where an owner is NOT looking when they run out mid-schedule.
    expect(out).toContain("Pro");
    expect(out).toContain("37 AI credits");
  });

  it("renders the rail without context rather than failing", async () => {
    const dict = await getDictionary("en", "ui");
    const out = await html(
      <SettingsShell orgSlug="riverside" active="billing" dict={dict}>
        <p>panel</p>
      </SettingsShell>,
    );

    expect(out).not.toContain("AI credits");
    expect(out).toContain("/o/riverside/settings?tab=organization");
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

  it("Credits does for a member", async () => {
    const out = await html(
      await CreditsSettingsPage({ params: Promise.resolve({ orgSlug: "riverside" }) }),
    );
    expect(out).toContain("credits-panel");
    expect(out).toContain("/o/riverside/settings?tab=organization");
  });

  it("Credits does NOT for a payer arriving from the bill", async () => {
    requireBillingPage.mockResolvedValue({ org: ORG, user: { id: "u9" }, viaPayer: true });
    const out = await html(
      await CreditsSettingsPage({ params: Promise.resolve({ orgSlug: "riverside" }) }),
    );

    expect(out).toContain("credits-panel");
    expect(out).not.toContain("/o/riverside/settings?tab=organization");
  });
});

describe("navContext", () => {
  it("returns the plan label and the wallet balance", async () => {
    expect(await navContext("org-1")).toEqual({ plan: "Pro", credits: 37 });
  });

  it("returns null rather than taking the page down when a read fails", async () => {
    // The rail is navigation. A credits outage must not 500 every Settings
    // page in the product.
    balance.mockRejectedValue(new Error("wallet unavailable"));
    expect(await navContext("org-1")).toBeNull();
  });
});
