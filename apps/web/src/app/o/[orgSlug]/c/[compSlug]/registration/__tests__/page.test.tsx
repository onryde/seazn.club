// RS004 W2 — the registration hub route: the owner/admin guard and the
// server-side `?tab=` switch. RS004 W3 adds the Settings tab's single
// server-side division-rows query (`@/lib/db`'s `withTenant`, mocked below)
// and the context (org tz, currency, register link) it hands the panel.
//
// `requireCompetitionPage` (page-auth.ts:192-201) already 404s a SCORER on
// its own — that is pre-existing, trusted behaviour, not this page's code, so
// the "propagates the guard's refusal" case below proves this page does not
// accidentally swallow it (no try/catch around the call). A VIEWER reaches
// `requireCompetitionPage` fine with `canEdit:false` (only a scorer is turned
// away there) — registration data is more sensitive than the read-only
// competition-settings page a viewer may already open, so THIS page adds its
// own `canEdit` check. That is the behaviour this file's guard tests actually
// exercise.
import { describe, expect, it, vi, beforeEach } from "vitest";

vi.mock("next/navigation", () => ({
  notFound: () => {
    throw new Error("NOT_FOUND");
  },
}));

const h = vi.hoisted(() => ({
  canEdit: true,
  refuseInGuard: false,
  orgTimezone: null as string | null,
  competitionVisibility: "public",
  rows: [] as unknown[],
  withTenantCalls: 0,
}));

vi.mock("@/server/page-auth", () => ({
  requireCompetitionPage: async () => {
    if (h.refuseInGuard) throw new Error("NOT_FOUND");
    return {
      auth: { orgId: "org-1" },
      org: { id: "org-1", name: "Riverside CC", slug: "riverside", timezone: h.orgTimezone },
      competition: { id: "comp-1", name: "Summer League", slug: "summer-league" },
      canEdit: h.canEdit,
    };
  },
}));

vi.mock("@/server/usecases/competitions", () => ({
  getCompetition: async () => ({
    id: "comp-1",
    name: "Summer League",
    slug: "summer-league",
    visibility: h.competitionVisibility,
  }),
}));

vi.mock("@/lib/resolve-locale", () => ({ resolveLocale: async () => "en" }));

// A tagged-template call (`.raw` on the strings array) resolves to `h.rows`;
// a fragment builder call (`tx([...SPOT_HOLDERS])`, a plain array — no
// `.raw`) resolves to an inert marker, same split as the proven
// registration-nav-entry-wiring.test.tsx `sql` mock, adapted to withTenant's
// callback shape.
vi.mock("@/lib/db", () => ({
  withTenant: async (_orgId: string, fn: (tx: unknown) => unknown) => {
    h.withTenantCalls += 1;
    const tx = (strings: unknown) => {
      if (!Array.isArray(strings) || !("raw" in (strings as object))) {
        return { __fragment: strings };
      }
      return Promise.resolve(h.rows);
    };
    return fn(tx);
  },
}));

import Page from "../page";
import { walk } from "@/components/__tests__/_hook-harness";
import { propsOf } from "@/components/__tests__/_hook-harness";
import { RegistrationHubSettingsPanel } from "@/components/registration-hub-settings-panel";
import { RegistrationHubRegistrantsPanel } from "@/components/registration-hub-registrants-panel";

const params = Promise.resolve({ orgSlug: "riverside", compSlug: "summer-league" });
const noTab = Promise.resolve({});

beforeEach(() => {
  h.canEdit = true;
  h.refuseInGuard = false;
  h.orgTimezone = null;
  h.competitionVisibility = "public";
  h.rows = [];
  h.withTenantCalls = 0;
});

describe("registration hub — owner/admin guard", () => {
  it("renders for an editor (owner/admin)", async () => {
    await expect(Page({ params, searchParams: noTab })).resolves.toBeTruthy();
  });

  it("404s a member who cannot edit (viewer)", async () => {
    h.canEdit = false;
    await expect(Page({ params, searchParams: noTab })).rejects.toThrow("NOT_FOUND");
  });

  it("propagates the guard's own refusal (e.g. a scorer) without swallowing it", async () => {
    h.refuseInGuard = true;
    await expect(Page({ params, searchParams: noTab })).rejects.toThrow("NOT_FOUND");
  });
});

describe("registration hub — ?tab= switching", () => {
  it("defaults to the Settings panel with no ?tab=", async () => {
    const tree = walk(await Page({ params, searchParams: noTab }));
    expect(tree.some((e) => e.type === RegistrationHubSettingsPanel)).toBe(true);
    expect(tree.some((e) => e.type === RegistrationHubRegistrantsPanel)).toBe(false);
  });

  it("falls back to Settings on a garbage ?tab=", async () => {
    const tree = walk(await Page({ params, searchParams: Promise.resolve({ tab: "bogus" }) }));
    expect(tree.some((e) => e.type === RegistrationHubSettingsPanel)).toBe(true);
    expect(tree.some((e) => e.type === RegistrationHubRegistrantsPanel)).toBe(false);
  });

  it("switches to the Registrants panel with ?tab=registrants", async () => {
    const tree = walk(
      await Page({ params, searchParams: Promise.resolve({ tab: "registrants" }) }),
    );
    expect(tree.some((e) => e.type === RegistrationHubRegistrantsPanel)).toBe(true);
    expect(tree.some((e) => e.type === RegistrationHubSettingsPanel)).toBe(false);
  });

  it("does not run the division-rows query on the Registrants tab — no N+1, no wasted read", async () => {
    await Page({ params, searchParams: Promise.resolve({ tab: "registrants" }) });
    expect(h.withTenantCalls).toBe(0);
  });
});

describe("registration hub — Settings tab data wiring (RS004 W3)", () => {
  it("maps the single query's rows onto the Settings panel", async () => {
    h.rows = [
      {
        division_id: "div-1",
        name: "Open Singles",
        category: null,
        age_min: 10,
        age_max: 18,
        enabled: true,
        entrant_kind: "individual",
        opens_at: null,
        closes_at: null,
        capacity: 20,
        fee_cents: 1500,
        approval: "auto",
        allow_free_agents: false,
        taken: 3,
        org_currency: "gbp",
      },
    ];
    const tree = walk(await Page({ params, searchParams: noTab }));
    const panel = tree.find((e) => e.type === RegistrationHubSettingsPanel)!;
    const props = propsOf(panel);
    expect(props.rows).toEqual([
      {
        division_id: "div-1",
        name: "Open Singles",
        category: null,
        age_min: 10,
        age_max: 18,
        enabled: true,
        entrant_kind: "individual",
        opens_at: null,
        closes_at: null,
        capacity: 20,
        fee_cents: 1500,
        approval: "auto",
        allow_free_agents: false,
        taken: 3,
      },
    ]);
    expect((props.context as { currency: string }).currency).toBe("gbp");
  });

  it("resolves the org timezone from organizations.timezone", async () => {
    h.orgTimezone = "Asia/Kolkata";
    const tree = walk(await Page({ params, searchParams: noTab }));
    const panel = tree.find((e) => e.type === RegistrationHubSettingsPanel)!;
    expect((propsOf(panel).context as { orgTz: string }).orgTz).toBe("Asia/Kolkata");
  });

  it("falls back to UTC when the org has no timezone set — never users.timezone or the cookie", async () => {
    h.orgTimezone = null;
    const tree = walk(await Page({ params, searchParams: noTab }));
    const panel = tree.find((e) => e.type === RegistrationHubSettingsPanel)!;
    expect((propsOf(panel).context as { orgTz: string }).orgTz).toBe("UTC");
  });

  it("shows the register link for a public competition, built via routes.publicRegister", async () => {
    h.competitionVisibility = "public";
    const tree = walk(await Page({ params, searchParams: noTab }));
    const panel = tree.find((e) => e.type === RegistrationHubSettingsPanel)!;
    const context = propsOf(panel).context as { showRegisterLink: boolean; registerHref: string };
    expect(context.showRegisterLink).toBe(true);
    expect(context.registerHref).toBe("/shared/riverside/summer-league/register");
  });

  it("hides the register link for a private competition", async () => {
    h.competitionVisibility = "private";
    const tree = walk(await Page({ params, searchParams: noTab }));
    const panel = tree.find((e) => e.type === RegistrationHubSettingsPanel)!;
    expect((propsOf(panel).context as { showRegisterLink: boolean }).showRegisterLink).toBe(false);
  });
});
