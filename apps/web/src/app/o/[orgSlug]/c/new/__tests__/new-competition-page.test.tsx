// The create page ASKS plan_entitlements for the upgrade figure, and hands it
// down.
//
// Without this the seam is inert-shaped: `publicDashboardUpgrade` is a required
// prop, so `tsc` forces the page to pass SOMETHING — and a literal `null`
// compiles, renders, and silently takes both numbers off the degrade card
// again. Nothing else can witness the query: the component suite supplies the
// figure itself, and no e2e can put an org at its public-dashboard cap cheaply.
//
// So this drives the real Server Component with a stubbed `sql` and asserts
// three things: WHICH plan is asked about (derived from `featurePlan`, the same
// helper the <UpgradeGate> button uses, never a typed "pro"), WHICH feature key,
// and that the answer reaches `<TemplateGallery>`'s props.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { walk, propsOf } from "@/components/__tests__/_hook-harness";
import { TemplateGallery } from "@/components/v2/template-gallery";
import { featurePlan } from "@/lib/feature-copy";
import { planLabel } from "@/lib/plan-label";
import { PUBLIC_DASHBOARD_FEATURE } from "@/lib/public-dashboard-upgrade";

const h = vi.hoisted(() => ({
  /** Every `sql` call's interpolated values, in order. */
  calls: [] as unknown[][],
  rows: [] as { int_value: number | null }[],
  fail: false,
}));

vi.mock("@/lib/db", () => ({
  sql: (_strings: TemplateStringsArray, ...values: unknown[]) => {
    h.calls.push(values);
    return h.fail ? Promise.reject(new Error("db down")) : Promise.resolve(h.rows);
  },
}));
vi.mock("@/server/page-auth", () => ({
  requireOrgPage: async () => ({ auth: { orgId: "org1" }, canEdit: true }),
}));
// v18 W3-B: the page also resolves the viewer's plan for <TemplateGallery>.
// Mocked directly (not through the `sql` stub above) so it does not perturb
// `h.calls`, which this file's own assertions pin to the entitlements-matrix
// query alone.
vi.mock("@/lib/entitlements", () => ({ orgPlanKey: async () => "community" }));
vi.mock("next/navigation", () => ({
  redirect: () => {
    throw new Error("redirected");
  },
}));
vi.mock("@/lib/resolve-locale", () => ({ resolveLocale: async () => "en" }));
vi.mock("@/lib/i18n", () => ({
  getDictionary: async () => ({}),
  t: (_dict: unknown, key: string) => key,
}));

import NewCompetitionPage from "../page";

const galleryProps = async () => {
  const output = await NewCompetitionPage({ params: Promise.resolve({ orgSlug: "riverside" }) });
  const gallery = walk(output).find((el) => el.type === TemplateGallery);
  expect(gallery, "the page must still render the gallery").toBeDefined();
  return propsOf(gallery!);
};

beforeEach(() => {
  h.calls = [];
  h.rows = [{ int_value: 10 }];
  h.fail = false;
});

describe("the create page supplies the public-dashboard upgrade figure", () => {
  it("asks plan_entitlements for the plan featurePlan names, on the refused key", async () => {
    await galleryProps();
    expect(h.calls).toHaveLength(1);
    // Not the string "pro": whichever plan the paywall would actually sell.
    expect(h.calls[0]).toEqual([featurePlan(PUBLIC_DASHBOARD_FEATURE), PUBLIC_DASHBOARD_FEATURE]);
  });

  it("hands the row's int_value down under the plan's display name", async () => {
    expect((await galleryProps()).publicDashboardUpgrade).toEqual({
      plan: planLabel(featurePlan(PUBLIC_DASHBOARD_FEATURE)),
      limit: 10,
    });
  });

  it("keeps UNLIMITED and UNREADABLE apart", async () => {
    // A present row with a null cap is unlimited…
    h.rows = [{ int_value: null }];
    expect((await galleryProps()).publicDashboardUpgrade).toMatchObject({ limit: null });
    // …and no row at all is `undefined`, never `?? null`. Collapsing the two
    // would let a vanished row advertise an uncapped plan.
    h.rows = [];
    expect((await galleryProps()).publicDashboardUpgrade).toMatchObject({ limit: undefined });
  });

  it("still renders the form when the matrix read fails outright", async () => {
    h.fail = true;
    const props = await galleryProps();
    expect(props.publicDashboardUpgrade).toBeNull();
    // The create path must survive a database that the figure did not.
    expect(props.templates).toBeInstanceOf(Array);
    expect((props.templates as unknown[]).length).toBeGreaterThan(0);
  });
});
