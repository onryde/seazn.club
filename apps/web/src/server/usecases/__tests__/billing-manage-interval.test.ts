// The interval switch (monthly ↔ annual) — `previewIntervalChange` /
// `applyIntervalChange`, which back GET /api/billing/interval/preview and
// POST /api/billing/interval.
//
// Originally Task 7 (Pro Plus tier), written against `previewPlanChange` /
// `applyPlanChange`. pro_plus is retired (entitlements v18, V393), so a real
// PLAN-to-PLAN switch was no longer reachable and those two functions plus
// their `/api/billing/plan` routes have been deleted. The mechanism they
// shared with the interval endpoints — `resolvePriceChange`: price lookup
// keyed by (planKey, TARGET interval), not by whatever the subscription is
// currently on; the plan ITEM picked by elimination, never `data[0]`; the
// refusal when the item is already on the requested price — is live, and is
// pinned here through the functions that actually ship. Stripe + db +
// downstream entitlement/analytics calls are mocked (no network, no
// DATABASE_URL needed).
import { beforeEach, describe, expect, it, vi } from "vitest";
import { proPrice } from "@/lib/currency";
import { ORG_ADDON_FEATURE_KEY } from "@/lib/org-addons";

type SubFixture = {
  plan_key: string;
  status: string;
  stripe_customer_id: string | null;
  stripe_subscription_id: string | null;
  current_period_end: string | null;
  trial_end: string | null;
  cancel_at_period_end: boolean;
  currency: string | null;
};

type PlanRow = {
  stripe_price_id_monthly: string | null;
  stripe_price_id_annual: string | null;
};

const db = vi.hoisted(() => ({
  sub: null as SubFixture | null,
  plans: {} as Record<string, PlanRow>,
}));
vi.mock("@/lib/db", () => ({
  sql: (strings: TemplateStringsArray, ...values: unknown[]) => {
    const text = strings.join(" ");
    if (text.includes("from subscriptions")) return Promise.resolve(db.sub ? [db.sub] : []);
    if (text.includes("from plans")) {
      const key = values[0] as string;
      const row = db.plans[key];
      return Promise.resolve(row ? [row] : []);
    }
    if (text.includes("from organizations")) return Promise.resolve([{ created_by: "user_1" }]);
    return Promise.resolve([]);
  },
}));

const stripeMock = vi.hoisted(() => ({
  retrieveSubscription: vi.fn(),
  createPreview: vi.fn(),
  updateSubscription: vi.fn(),
}));
vi.mock("@/lib/stripe", () => ({
  getStripe: () => ({
    subscriptions: {
      retrieve: stripeMock.retrieveSubscription,
      update: stripeMock.updateSubscription,
    },
    invoices: { createPreview: stripeMock.createPreview },
  }),
}));

vi.mock("@/lib/auth", () => ({
  getActiveOrgId: vi.fn(),
  requireOrgRole: vi.fn(),
  requireUser: vi.fn(),
}));

const billingMock = vi.hoisted(() => ({ syncSubscription: vi.fn() }));
vi.mock("@/lib/billing", () => ({
  syncSubscription: billingMock.syncSubscription,
}));

// V314: the change lands on the billing GROUP, so the cache drop is
// invalidateEntitlementsForOrgGroup — still called with the org id.
const entitlementsMock = vi.hoisted(() => ({
  invalidateOrgEntitlements: vi.fn(),
  invalidateEntitlementsForOrgGroup: vi.fn(),
}));
vi.mock("@/lib/entitlements", () => ({
  invalidateOrgEntitlements: entitlementsMock.invalidateOrgEntitlements,
  invalidateEntitlementsForOrgGroup: entitlementsMock.invalidateEntitlementsForOrgGroup,
}));

vi.mock("@/lib/posthog-server", () => ({ captureServer: vi.fn() }));

import { applyIntervalChange, previewIntervalChange } from "../billing-manage";

const ORG_ID = "org_1";

function sub(over: Partial<SubFixture> = {}): SubFixture {
  return {
    plan_key: "pro",
    status: "active",
    stripe_customer_id: "cus_1",
    stripe_subscription_id: "sub_1",
    current_period_end: new Date(Date.now() + 15 * 86_400_000).toISOString(),
    trial_end: null,
    cancel_at_period_end: false,
    currency: "usd",
    ...over,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  db.sub = null;
  db.plans = {
    pro: {
      stripe_price_id_monthly: "price_pro_m",
      stripe_price_id_annual: "price_pro_y",
    },
  };
});

describe("previewIntervalChange refusal (resolvePriceChange)", () => {
  it("refuses when the target plan+interval is already the live price", async () => {
    db.sub = sub({ plan_key: "pro" });
    stripeMock.retrieveSubscription.mockResolvedValue({
      status: "active",
      currency: "usd",
      items: { data: [{ id: "si_1", price: { id: "price_pro_m" } }] },
    });

    await expect(previewIntervalChange(ORG_ID, "monthly")).rejects.toMatchObject({
      status: 400,
      message: "You are already billed monthly.",
    });
    expect(stripeMock.createPreview).not.toHaveBeenCalled();
  });
});

/** Two previews are taken per change, and they must not be confused:
 *  the PRORATION one (no preview_mode) drives "due today"/credit, and the
 *  RECURRING one (preview_mode: "recurring") drives the renewal quote. Distinct
 *  totals here so each assertion proves which call it came from. */
function previewByMode(prorationTotal: number, recurringTotal: number) {
  return (params: { preview_mode?: string }) =>
    Promise.resolve({
      total: params.preview_mode === "recurring" ? recurringTotal : prorationTotal,
      currency: "usd",
      lines: { data: [{ period: { end: 1_800_000_000 } }] },
    });
}

describe("previewIntervalChange price-id selection", () => {
  it("looks the target price up under the TARGET interval, not the current one", async () => {
    // Current sub is on pro MONTHLY; the request targets pro ANNUAL. The
    // target price must come from the `plans` row read under the REQUESTED
    // interval, not from a naive reuse of the current Stripe item's price id.
    db.sub = sub({ plan_key: "pro" });
    stripeMock.retrieveSubscription.mockResolvedValue({
      status: "active",
      currency: "usd",
      items: { data: [{ id: "si_1", price: { id: "price_pro_m" } }] },
    });
    stripeMock.createPreview.mockImplementation(previewByMode(2500, 5800));

    const preview = await previewIntervalChange(ORG_ID, "annual");

    expect(stripeMock.createPreview).toHaveBeenCalledWith(
      expect.objectContaining({
        subscription_details: expect.objectContaining({
          items: [{ id: "si_1", price: "price_pro_y" }],
        }),
      }),
    );
    // V314: the renewal quote is Stripe's own recurring preview, NOT
    // proPrice(). Prices are tiers_mode: graduated now, so the flat helper
    // under-quotes every multi-org group — 5800 here is base + one extra org,
    // a number the flat lookup cannot produce.
    expect(preview.renewalAmountMinor).toBe(5800);
    expect(preview.renewalAmountMinor).not.toBe(proPrice("annual", "usd"));
    // …and the recurring preview is asked for the TARGET price, same as the
    // proration one.
    expect(stripeMock.createPreview).toHaveBeenCalledWith(
      expect.objectContaining({
        preview_mode: "recurring",
        subscription_details: { items: [{ id: "si_1", price: "price_pro_y" }] },
      }),
    );
  });

  it("reprices the PLAN item, not whichever item Stripe happens to list first", async () => {
    // #329: a group with an extra-organisation rider carries two items and
    // Stripe does not promise the order. `data[0]` would move the RIDER onto
    // the plan price and leave the plan itself on its old interval. The plan
    // item is identified by ELIMINATION (subscription-items.planItem), so the
    // rider is skipped wherever it sits — the rider's marker is read from the
    // add-on catalogue here rather than typed in, so a change of marker moves
    // this fixture with it.
    db.sub = sub({ plan_key: "pro" });
    stripeMock.retrieveSubscription.mockResolvedValue({
      status: "active",
      currency: "usd",
      items: {
        data: [
          {
            id: "si_org_rider",
            price: { id: "price_org_addon" },
            metadata: { feature_key: ORG_ADDON_FEATURE_KEY },
          },
          { id: "si_plan", price: { id: "price_pro_m" } },
        ],
      },
    });
    stripeMock.createPreview.mockImplementation(previewByMode(2500, 5800));

    await previewIntervalChange(ORG_ID, "annual");

    expect(stripeMock.createPreview).toHaveBeenCalledWith(
      expect.objectContaining({
        subscription_details: expect.objectContaining({
          items: [{ id: "si_plan", price: "price_pro_y" }],
        }),
      }),
    );
  });

  it("quotes an annual → monthly switch from the recurring preview, credit from the proration one", async () => {
    db.sub = sub({ plan_key: "pro" });
    stripeMock.retrieveSubscription.mockResolvedValue({
      status: "active",
      currency: "usd",
      items: { data: [{ id: "si_1", price: { id: "price_pro_y" } }] },
    });
    stripeMock.createPreview.mockImplementation(previewByMode(-1500, 2800));

    const preview = await previewIntervalChange(ORG_ID, "monthly");

    expect(stripeMock.createPreview).toHaveBeenCalledWith(
      expect.objectContaining({
        subscription_details: expect.objectContaining({
          items: [{ id: "si_1", price: "price_pro_m" }],
        }),
      }),
    );
    // Renewal from the recurring preview; credit still from the proration one.
    expect(preview.renewalAmountMinor).toBe(2800);
    expect(preview.renewalAmountMinor).not.toBe(proPrice("monthly", "usd"));
    expect(preview.creditMinor).toBe(1500);
  });

  it("degrades to a null renewal quote rather than failing the whole preview", async () => {
    db.sub = sub({ plan_key: "pro" });
    stripeMock.retrieveSubscription.mockResolvedValue({
      status: "active",
      currency: "usd",
      items: { data: [{ id: "si_1", price: { id: "price_pro_m" } }] },
    });
    stripeMock.createPreview.mockImplementation((params: { preview_mode?: string }) =>
      params.preview_mode === "recurring"
        ? Promise.reject(new Error("stripe down"))
        : Promise.resolve({
            total: 2500,
            currency: "usd",
            lines: { data: [{ period: { end: 1_800_000_000 } }] },
          }),
    );

    const preview = await previewIntervalChange(ORG_ID, "annual");

    // One line of the confirm dialog goes missing; "due today" still renders.
    expect(preview.renewalAmountMinor).toBeNull();
    expect(preview.dueTodayMinor).toBe(2500);
  });
});

describe("applyIntervalChange", () => {
  it("invalidates cached entitlements after syncSubscription — the price changes here", async () => {
    db.sub = sub({ plan_key: "pro" });
    stripeMock.retrieveSubscription.mockResolvedValue({
      status: "active",
      currency: "usd",
      items: { data: [{ id: "si_1", price: { id: "price_pro_m" } }] },
    });
    const updated = {
      status: "active",
      currency: "usd",
      items: { data: [{ id: "si_1", price: { id: "price_pro_y" } }] },
      latest_invoice: null,
    };
    stripeMock.updateSubscription.mockResolvedValue(updated);

    const result = await applyIntervalChange(ORG_ID, "annual", 1_770_000_000);

    expect(billingMock.syncSubscription).toHaveBeenCalledWith(ORG_ID, updated);
    expect(entitlementsMock.invalidateEntitlementsForOrgGroup).toHaveBeenCalledWith(ORG_ID);
    expect(result).toEqual({ requires_action: false });
  });

  it("hands the client secret back when the change needs SCA/3DS (requires_action)", async () => {
    // SCA makes 3DS the normal path for European cards and Indian card mandates
    // require it. When Stripe leaves the interval-change invoice OPEN pending
    // confirmation, applyIntervalChange must return the confirmation
    // client_secret so the client can complete 3DS — a silent
    // { requires_action: false } would look to the buyer like "I clicked
    // upgrade and nothing happened" while Stripe holds an unconfirmed
    // PaymentIntent. Only the false branch was covered before (the test
    // above). (issue #205)
    db.sub = sub({ plan_key: "pro" });
    stripeMock.retrieveSubscription.mockResolvedValue({
      status: "active",
      currency: "usd",
      items: { data: [{ id: "si_1", price: { id: "price_pro_m" } }] },
    });
    const updated = {
      status: "active",
      currency: "usd",
      items: { data: [{ id: "si_1", price: { id: "price_pro_y" } }] },
      latest_invoice: {
        status: "open",
        confirmation_secret: { client_secret: "pi_3ds_secret_abc" },
      },
    };
    stripeMock.updateSubscription.mockResolvedValue(updated);

    const result = await applyIntervalChange(ORG_ID, "annual", 1_770_000_000);

    expect(result).toEqual({ requires_action: true, client_secret: "pi_3ds_secret_abc" });
    // The change is still synced and the group cache still dropped BEFORE 3DS
    // is handed back — the confirmation completes an already-applied change.
    expect(billingMock.syncSubscription).toHaveBeenCalledWith(ORG_ID, updated);
    expect(entitlementsMock.invalidateEntitlementsForOrgGroup).toHaveBeenCalledWith(ORG_ID);
  });
});
