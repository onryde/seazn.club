// The degrade card names BOTH numbers: the cap that was hit, and what the next
// plan up hosts.
//
// ── What was missing ─────────────────────────────────────────────────────────
// V396 made a create over the `dashboard.public.max` cap SUCCEED as a private
// competition, returning `public_quota_degraded: { feature_key, limit }` on the
// 201. Both create paths rendered a good card for it — and both destructured
// only `{ name, slug }`, dropping `limit` on the floor. The organiser was told
// their plan's public dashboards were "all in use" and never learned they were
// at 2, nor that the plan on the other side of the `<UpgradeGate>` hosts 10.
//
// A dropped field is invisible to `tsc` (the response type is structural and
// nothing read the property), invisible to the usecase suites (the server sends
// it correctly — `public-dashboard-quota.test.ts` proves that), and invisible to
// any class-scan (the markup was already there). The only witness is driving the
// island's own state through a degraded 201 and reading the sentence back.
//
// vitest is `environment: "node"` with no jsdom, so the islands run through the
// shared hook harness — the same way competition-end-date-required.test.tsx
// drives the JOIN between form state and the body it POSTs.
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { ReactElement } from "react";
import { propsOf, renderIsland } from "@/components/__tests__/_hook-harness";
import { CompetitionWizard } from "../competition-wizard";
import { TemplateDetailSheet } from "../template-gallery";
import { DateTimeField } from "../shared/datetime-field";
import {
  publicDashboardGain,
  PUBLIC_DASHBOARD_FEATURE,
  type PublicDashboardUpgrade,
} from "@/lib/public-dashboard-upgrade";
import { apiV1 } from "@/lib/client-v1";
import { featurePlan } from "@/lib/feature-copy";
import { planLabel } from "@/lib/plan-label";
import { getTemplate } from "@/server/templates/catalog";
import { sql } from "@/lib/db";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }),
  usePathname: () => "/",
}));
// `useT()` THROWS outside a real <DictProvider>, and this harness has no
// provider tree at all (see _hook-harness.tsx's useContext doc) — so the
// template sheet cannot mount without this. Bound to the REAL shipped English
// catalog, which is exactly the contract `useMsg()` already honours by falling
// back to it, so both islands read the same sentences a customer does. Only
// `useT` is replaced; everything else in the module stays real.
vi.mock("@/components/i18n/dict-provider", async () => {
  const actual = await vi.importActual<typeof import("@/components/i18n/dict-provider")>(
    "@/components/i18n/dict-provider",
  );
  const { t } = await import("@/lib/i18n-runtime");
  const ui = (await import("@/dictionaries/en/ui.json")).default;
  return {
    ...actual,
    useT: () => (key: string, vars?: Record<string, string | number>) =>
      t(ui as unknown as import("@/lib/i18n-constants").Dict, key, vars),
  };
});
vi.mock("@/lib/client-v1", async () => {
  const actual = await vi.importActual<typeof import("@/lib/client-v1")>("@/lib/client-v1");
  return { ...actual, apiV1: vi.fn() };
});

const HAS_DB = !!process.env.DATABASE_URL;

afterAll(async () => {
  if (!HAS_DB) return;
  const globalForDb = globalThis as { _sql?: { end(): Promise<void> } };
  const client = globalForDb._sql;
  globalForDb._sql = undefined;
  await client?.end();
});

/** The 201 an org at its cap gets back: the competition EXISTS, privately. */
const degradedResponse = (limit: number | null) => ({
  id: "c1",
  slug: "summer-cup",
  visibility: "private",
  public_quota_degraded: { feature_key: PUBLIC_DASHBOARD_FEATURE, limit },
});

/** Fill the mandatory end date, then fire the form the way a browser would. */
async function createWith(tree: () => ReactElement[]): Promise<void> {
  const fields = tree().filter((el) => el.type === DateTimeField);
  // [starts, ends] — both forms render the pair in that order, and only the
  // second is mandatory (#376). Without it submit() returns before the POST.
  (propsOf(fields[1]!).onChange as (v: string) => void)("2026-12-01");
  const form = tree().find((el) => el.type === "form")!;
  await (propsOf(form).onSubmit as (e: { preventDefault: () => void }) => unknown)({
    preventDefault: () => {},
  });
}

const PRO: PublicDashboardUpgrade = { plan: "Pro", limit: 10 };

const mountWizard = (upgrade: PublicDashboardUpgrade | null) =>
  renderIsland(CompetitionWizard, { orgSlug: "riverside", publicDashboardUpgrade: upgrade });

const leaguePlayoff = getTemplate("league-playoff");
if (!leaguePlayoff) throw new Error("league-playoff missing from the catalog");

const mountSheet = (upgrade: PublicDashboardUpgrade | null) =>
  renderIsland(TemplateDetailSheet, {
    orgSlug: "riverside",
    template: leaguePlayoff,
    onClose: () => {},
    publicDashboardUpgrade: upgrade,
  });

beforeEach(() => {
  vi.mocked(apiV1).mockReset();
});

// ── The rule ────────────────────────────────────────────────────────────────

describe("publicDashboardGain — when there is a figure worth naming", () => {
  it("names the next plan's cap when it really is bigger", () => {
    expect(publicDashboardGain(2, PRO)).toBe(10);
  });

  it("suppresses when the upgrade is not an upgrade (a Pro org at Pro's own cap)", () => {
    // "Pro hosts 10 at a time" under a card refusing an 11th dashboard is an
    // offer that buys nothing. Archive, or Contact us — both already on the
    // card below.
    expect(publicDashboardGain(10, PRO)).toBeNull();
    expect(publicDashboardGain(11, PRO)).toBeNull();
  });

  it("suppresses an UNREAD figure rather than embellishing it", () => {
    // `undefined` is "no row / the read failed". `?? null` here would print a
    // promise of an uncapped plan built out of a database outage.
    expect(publicDashboardGain(2, { plan: "Pro", limit: undefined })).toBeNull();
    expect(publicDashboardGain(2, null)).toBeNull();
  });

  it("suppresses an UNLIMITED upgrade — there is no sentence for it today", () => {
    // Deliberate: `featurePlan("dashboard.public.max")` resolves to `pro`,
    // whose cap is finite, so this branch is unreachable from any live matrix.
    // A dictionary key for it in four locales would be dead copy.
    expect(publicDashboardGain(2, { plan: "Pro", limit: null })).toBeNull();
  });

  it("suppresses when the org's OWN cap did not arrive", () => {
    expect(publicDashboardGain(null, PRO)).toBeNull();
    expect(publicDashboardGain(undefined, PRO)).toBeNull();
  });
});

// ── The two create paths ────────────────────────────────────────────────────

for (const [label, mount] of [
  ["the blank wizard", mountWizard],
  ["the template sheet", mountSheet],
] as const) {
  describe(`${label} — the degrade card quotes the numbers`, () => {
    it("names the cap it was refused BY and what the next plan up hosts", async () => {
      vi.mocked(apiV1).mockResolvedValue(degradedResponse(2) as never);
      const island = mount(PRO);
      await createWith(island.tree);

      const text = island.text();
      // The card, not the form: the create succeeded.
      expect(text).toContain("was created as private");
      // BOTH figures, in the shipped English sentence. `t()` returns the KEY on
      // a miss, so this also fails if the key never reached en/ui.json.
      expect(text).toContain("Your plan hosts 2 at a time; Pro hosts 10.");
    });

    it("names only the org's own cap when the next plan up is no bigger", async () => {
      vi.mocked(apiV1).mockResolvedValue(degradedResponse(10) as never);
      const island = mount(PRO);
      await createWith(island.tree);

      const text = island.text();
      expect(text).toContain("Your plan hosts 10 at a time.");
      // …and never the sentence that would read as an offer.
      expect(text).not.toContain("Pro hosts 10.");
    });

    it("says nothing about caps at all when the server sent no number", async () => {
      vi.mocked(apiV1).mockResolvedValue(degradedResponse(null) as never);
      const island = mount(PRO);
      await createWith(island.tree);

      const text = island.text();
      // Still the degrade card — the competition exists and the way onward
      // must not disappear with the figure.
      expect(text).toContain("was created as private");
      expect(text).not.toContain("at a time");
    });

    it("still renders the card when the page could not read the upgrade figure", async () => {
      vi.mocked(apiV1).mockResolvedValue(degradedResponse(2) as never);
      const island = mount(null);
      await createWith(island.tree);

      const text = island.text();
      expect(text).toContain("Your plan hosts 2 at a time.");
      expect(text).not.toContain("Pro hosts");
    });
  });
}

// ── The numbers themselves ──────────────────────────────────────────────────
//
// Everything above proves the figures REACH the copy. This proves they are the
// figures the resolver actually enforces: a reachability test is satisfied by
// any value, and the card's whole job is to be right about two of them.
//
// Real Postgres required; skipped without DATABASE_URL (CI sets it).
describe.skipIf(!HAS_DB)("the figures come from plan_entitlements, not from copy", () => {
  const capFor = async (plan: string): Promise<number | null> => {
    const [row] = await sql<{ int_value: number | null }[]>`
      select int_value from plan_entitlements
       where plan_key = ${plan} and feature_key = ${PUBLIC_DASHBOARD_FEATURE}`;
    expect(row, `plan_entitlements has no ${plan}/${PUBLIC_DASHBOARD_FEATURE} row`).toBeDefined();
    return row!.int_value;
  };

  it("prints the live community cap beside the live cap of the plan featurePlan names", async () => {
    const upgradePlan = featurePlan(PUBLIC_DASHBOARD_FEATURE);
    const community = await capFor("community");
    const upgrade = await capFor(upgradePlan);
    // The premise of the whole card: the free tier is capped, and the plan the
    // gate sells lifts it. If this ever stops being true the sentence below is
    // the wrong sentence, not just a stale number.
    expect(typeof community).toBe("number");
    expect(typeof upgrade).toBe("number");
    expect(upgrade!).toBeGreaterThan(community!);

    vi.mocked(apiV1).mockResolvedValue(degradedResponse(community) as never);
    const island = mountWizard({ plan: planLabel(upgradePlan), limit: upgrade });
    await createWith(island.tree);

    expect(island.text()).toContain(
      `Your plan hosts ${community} at a time; ${planLabel(upgradePlan)} hosts ${upgrade}.`,
    );
  });
});
