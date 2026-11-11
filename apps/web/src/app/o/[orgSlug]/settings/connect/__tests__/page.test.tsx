// Settings -> Payments page (sponsor deals Task 21): the "Sponsor invoices" card under the offline-instructions card.
//
// The page reads the org's two V500 columns and hands them to the island, with `canEdit` from the page's own auth. The island's
// behaviour is org-sponsor-invoice-details.test.tsx's; this is the JOIN a person meets: the stored values on first paint, where
// the card sits, who may edit, and that no plan gates it. The columns' real names are the smoke row's (a real server and DB).
//
// The existing card (OrgPaymentInstructions) is stubbed: this file is not about it, and it fetches on mount.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { prerender } from "react-dom/static";

const { requireOrgPage, resolveLocale, sqlCalls, rows, entitlementCalls } = vi.hoisted(() => ({
  requireOrgPage: vi.fn(),
  resolveLocale: vi.fn(),
  sqlCalls: [] as { text: string; values: unknown[] }[],
  rows: { current: [] as Record<string, unknown>[] },
  entitlementCalls: vi.fn(),
}));

vi.mock("@/lib/db", () => ({
  sql: vi.fn(async (strings: TemplateStringsArray, ...values: unknown[]) => {
    sqlCalls.push({ text: strings.join("?"), values });
    return rows.current;
  }),
}));
vi.mock("@/server/page-auth", () => ({ requireOrgPage }));
vi.mock("@/lib/resolve-locale", () => ({ resolveLocale }));
// Any plan gate on this page would have to ask the entitlements module: it is wired to record that it was asked.
vi.mock("@/lib/entitlements", () => ({
  orgPlanKey: entitlementCalls,
  hasFeature: entitlementCalls,
  requireFeature: entitlementCalls,
  featureScopes: entitlementCalls,
}));
vi.mock("../../_components/settings-nav", () => ({
  SettingsShell: ({ children }: { children: React.ReactNode }) => <div data-testid="shell">{children}</div>,
  navContext: vi.fn(async () => null),
}));
// The Sponsor invoices island calls useRouter() (it refreshes the route after a save); a static render has no app router mounted.
vi.mock("next/navigation", async (importOriginal) => ({
  ...(await importOriginal<typeof import("next/navigation")>()),
  useRouter: () => ({ refresh: () => {} }),
}));
vi.mock("@/components/org-payment-instructions", () => ({
  OrgPaymentInstructions: () => <div data-testid="connect-panel" />,
}));

import ConnectSettingsPage from "../page";

const ORG = { id: "org-1", name: "Riverside", slug: "riverside", role: "owner" };
const STORED = { sponsor_invoice_address: "Riverside CC\n12 Mill Lane", sponsor_invoice_bank_details: "Sort 12-34-56\nAcc 12345678" };

async function html(): Promise<string> {
  const { prelude } = await prerender(await ConnectSettingsPage({ params: Promise.resolve({ orgSlug: "riverside" }) }));
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

/** The textarea's body, newlines as React writes them (a leading newline is dropped by HTML, so the raw text is compared). */
const areaBody = (page: string, testId: string): string | null =>
  page.match(new RegExp(`<textarea[^>]*data-testid="${testId}"[^>]*>([\\s\\S]*?)</textarea>`))?.[1] ?? null;

beforeEach(() => {
  vi.clearAllMocks();
  sqlCalls.length = 0;
  resolveLocale.mockResolvedValue("en");
  requireOrgPage.mockResolvedValue({ org: ORG, user: { id: "u1" }, canEdit: true });
  rows.current = [{ payment_instructions: null, default_payment_method: "offline", charges_enabled: false, ...STORED }];
});

describe("Settings -> Payments draws the Sponsor invoices card", () => {
  it("opens the card at the stored address and bank details, below the offline-instructions card", async () => {
    const page = await html();
    expect(page).toContain('data-testid="sponsor-invoices-card"');
    expect(areaBody(page, "sponsor-invoice-address")).toBe("Riverside CC\n12 Mill Lane");
    expect(areaBody(page, "sponsor-invoice-bank-details")).toBe("Sort 12-34-56\nAcc 12345678");
    expect(page.indexOf('data-testid="connect-panel"')).toBeGreaterThan(-1);
    expect(page.indexOf('data-testid="sponsor-invoices-card"')).toBeGreaterThan(page.indexOf('data-testid="connect-panel"'));
    expect(page.indexOf('data-testid="sponsor-invoices-save"')).toBeGreaterThan(-1);
  });

  it("the empty case: an org with nothing stored opens both fields empty", async () => {
    rows.current = [{ payment_instructions: null, default_payment_method: "offline", charges_enabled: false, sponsor_invoice_address: null, sponsor_invoice_bank_details: null }];
    const page = await html();
    expect(areaBody(page, "sponsor-invoice-address")).toBe("");
    expect(areaBody(page, "sponsor-invoice-bank-details")).toBe("");
  });

  it("reads the two columns for THIS org in the page's own query", async () => {
    await html();
    const reads = sqlCalls.filter((c) => c.text.includes("sponsor_invoice_address") && c.text.includes("sponsor_invoice_bank_details"));
    expect(reads, "one read names both columns").toHaveLength(1);
    expect(reads[0]!.text).toContain("from organizations");
    expect(reads[0]!.values).toContain("org-1");
  });

  it("an owner and an admin can edit; a viewer sees the values and no Save (both sides checked)", async () => {
    let checked = 0;
    for (const [role, canEdit] of [["owner", true], ["admin", true], ["viewer", false]] as const) {
      requireOrgPage.mockResolvedValue({ org: { ...ORG, role }, user: { id: "u1" }, canEdit });
      const page = await html();
      expect(page.includes('data-testid="sponsor-invoices-save"'), role).toBe(canEdit);
      expect(page.includes('data-testid="sponsor-invoices-readonly"'), role).toBe(!canEdit);
      expect(areaBody(page, "sponsor-invoice-address"), `${role} still sees the stored address`).toBe("Riverside CC\n12 Mill Lane");
      checked++;
    }
    expect(checked, "anti-vacuity").toBe(3);
  });

  it("is on every plan: the page never asks the entitlements module (no plan or feature gate)", async () => {
    await html();
    expect(entitlementCalls).not.toHaveBeenCalled();
  });
});
