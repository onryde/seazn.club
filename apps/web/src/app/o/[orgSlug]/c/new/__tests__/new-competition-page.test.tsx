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
import { readFileSync } from "node:fs";
import { renderToStaticMarkup } from "react-dom/server";
import { walk, propsOf, renderIsland } from "@/components/__tests__/_hook-harness";
import { TemplateGallery } from "@/components/v2/template-gallery";
import { CompetitionWizard } from "@/components/v2/competition-wizard";
import { FirstDivisionPrompt } from "@/components/v2/first-division-prompt";
import { apiV1 } from "@/lib/client-v1";
import { featurePlan } from "@/lib/feature-copy";
import { planLabel } from "@/lib/plan-label";
import { PUBLIC_DASHBOARD_FEATURE } from "@/lib/public-dashboard-upgrade";

const h = vi.hoisted(() => ({
  /** Every `sql` call's interpolated values, in order. */
  calls: [] as unknown[][],
  rows: [] as { int_value: number | null }[],
  fail: false,
  /** Match Day PB3: what `publicSlotsLeft` answers (a database read, so doubled here; its own suite holds it to the create). */
  slots: { limit: 2, left: 0 } as { limit: number; left: number } | null,
  slotsFail: false,
  slotsAsked: [] as string[],
}));

vi.mock("@/lib/db", () => ({
  sql: (_strings: TemplateStringsArray, ...values: unknown[]) => {
    h.calls.push(values);
    return h.fail ? Promise.reject(new Error("db down")) : Promise.resolve(h.rows);
  },
}));
vi.mock("@/server/usecases/competitions", () => ({
  publicSlotsLeft: async (orgId: string) => {
    h.slotsAsked.push(orgId);
    if (h.slotsFail) throw new Error("db down");
    return h.slots;
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
  // The wizard (rendered below, to check what it emits) reads the router.
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }),
}));
vi.mock("@/lib/resolve-locale", () => ({ resolveLocale: async () => "en" }));
vi.mock("@/lib/client-v1", async () => {
  const actual = await vi.importActual<typeof import("@/lib/client-v1")>("@/lib/client-v1");
  return { ...actual, apiV1: vi.fn() };
});
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
  h.slots = { limit: 2, left: 0 };
  h.slotsFail = false;
  h.slotsAsked = [];
});

describe("the create page hands the gallery the org the description editor uploads to", () => {
  it("orgId is the signed-in org's id, not its slug", async () => {
    const props = await galleryProps();
    expect(props.orgId).toBe("org1");
    expect(props.orgSlug).toBe("riverside");
  });
});

// Match Day PB3 item 6: `publicSlots` is a required prop, so a literal `null` compiles, renders, and silently takes the cap warning
// off the form. This is the witness that the page ASKS, for THIS org, and hands the answer down.
describe("the create page supplies the org's public slots (PB3 item 6)", () => {
  it("asks for the signed-in org's slots and hands the answer to the gallery as-is", async () => {
    h.slots = { limit: 2, left: 0 };
    expect((await galleryProps()).publicSlots).toEqual({ limit: 2, left: 0 });
    expect(h.slotsAsked, "asked once, about the signed-in org's id (not its slug)").toEqual(["org1"]);
    h.slots = { limit: 10, left: 7 };
    expect((await galleryProps()).publicSlots).toEqual({ limit: 10, left: 7 });
  });

  it("a plan with no public cap reads null and the gallery is handed null (no warning)", async () => {
    h.slots = null;
    expect((await galleryProps()).publicSlots).toBeNull();
  });

  it("fails soft: a read that throws renders the form with no cap warning, not an error page", async () => {
    h.slotsFail = true;
    const props = await galleryProps();
    expect(props.publicSlots).toBeNull();
    expect(h.slotsAsked, "the read WAS attempted - the null is a fallback, not a skipped call").toEqual(["org1"]);
    expect(props.orgId, "the page still rendered the gallery").toBe("org1");
  });
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

// From `lg` the page widens its <main> (4xl -> 6xl) while the New competition
// form, or one of the two screens it turns into, is mounted. The page cannot see
// the gallery's client state, so it keys a CSS `:has()` on an attribute those
// roots carry. A selector nobody emits (or one the template gallery's own
// degrade card, inside its modal, also emits) is a page that is the wrong width
// with every unit suite green, so the selector is held to the components here.
describe("the page's wide-page selector is held to the components that carry it", () => {
  const mainClass = async () => {
    const output = await NewCompetitionPage({ params: Promise.resolve({ orgSlug: "riverside" }) });
    const main = walk(output).find((el) => el.type === "main")!;
    return String(propsOf(main).className);
  };
  const wizardProps = {
    orgSlug: "riverside",
    orgId: "org1",
    publicDashboardUpgrade: null,
    publicSlots: null,
    viewerPlan: "community" as const,
  };

  it("widens to 6xl at lg on exactly one attribute, and that attribute is not a testid", async () => {
    const cls = await mainClass();
    const hooks = [...cls.matchAll(/lg:has-\[\[([a-z-]+)\]\]:max-w-6xl/g)].map((m) => m[1]!);
    expect(hooks, `main className: ${cls}`).toHaveLength(1);
    expect(hooks[0]).toMatch(/^data-wide-page$/);
    // Below lg it stays the 4xl column (the widening is lg-only).
    expect(cls).toMatch(/(^|\s)max-w-4xl(\s|$)/);
    expect(cls).not.toMatch(/(^|\s)max-w-6xl/);
  });

  it("the form, the degraded-create card and the first-division screen each carry it", async () => {
    const attr = (await mainClass()).match(/lg:has-\[\[([a-z-]+)\]\]/)![1]!;
    // 1. the blank form
    const form = renderIsland(CompetitionWizard, wizardProps);
    expect(propsOf(form.tree()[0]!)[attr], "the form's root").toBeDefined();
    // 2. the degraded-create card
    vi.mocked(apiV1).mockResolvedValue({
      id: "c1",
      slug: "autumn-open",
      visibility: "private",
      discoverable: false,
      public_quota_degraded: { feature_key: "dashboard.public.max", limit: 2 },
    } as never);
    const named = form.tree().find((el) => el.type === "input" && propsOf(el).maxLength === 200)!;
    (propsOf(named).onChange as (e: unknown) => void)({ target: { value: "Autumn Open" } });
    const dates = form.tree().filter((el) => propsOf(el).kind === "date");
    expect(dates, "the form has a Starts and an Ends date field").toHaveLength(2);
    (propsOf(dates[1]!).onChange as (v: string) => void)("2030-12-31");
    const formEl = form.tree().find((el) => el.type === "form")!;
    await (propsOf(formEl).onSubmit as (e: { preventDefault: () => void }) => unknown)({ preventDefault: () => {} });
    const degraded = form.tree().find((el) => propsOf(el)["data-testid"] === "public-quota-degraded");
    expect(degraded, "a degraded create shows its card").toBeDefined();
    expect(propsOf(degraded!)[attr], "the degraded card's root").toBeDefined();
    // 3. the first-division screen
    const prompt = renderToStaticMarkup(
      <FirstDivisionPrompt
        orgSlug="riverside"
        created={{
          name: "Autumn Open",
          slug: "autumn-open",
          visibility: "public",
          discoverable: false,
          startsOn: "",
          endsOn: "2030-12-31",
        }}
      />,
    );
    expect(prompt).toMatch(new RegExp(`^<div[^>]*${attr}=`));
  });

  it("the template gallery's own degrade card does NOT carry it (it sits in a modal and must not widen the page)", () => {
    const gallery = readFileSync(new URL("../../../../../../components/v2/template-gallery.tsx", import.meta.url), "utf8");
    // Anti-vacuity: the card this guards is really in that file.
    expect(gallery).toContain('data-testid="public-quota-degraded"');
    expect(gallery).not.toContain("data-wide-page");
  });
});
