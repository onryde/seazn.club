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
  // finding 6's fallback-currency query result — only consulted when a test
  // needs the query gated behind an empty `rows` list (see fetchOrgCurrency
  // in page.tsx). Left distinct from any row's own org_currency field so a
  // test can prove which source actually won.
  orgCurrency: "usd",
  // RS004 W3c: the SAME zero-rows-fallback shape, for the card-unsupported-
  // currency column. Distinct default (null = supported) from any row's own
  // org_stripe_unsupported_currency so a test can prove which source won.
  orgStripeUnsupportedCurrency: null as string | null,
  withTenantCalls: 0,
  // How many times each zero-rows fallback query actually ran. The Registrants
  // tab renders a panel that takes no context, so the resolved VALUES are not
  // observable through props there — the only honest probe is whether the page
  // bothered to ask (RS004 gap-pass review).
  currencyQueries: 0,
  unsupportedQueries: 0,
}));

const feePercentForMock = vi.hoisted(() => vi.fn(async () => 8));

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

// RS004 W3c: page.tsx now imports feePercentFor for the config panel's
// platform-cut copy. Mocked rather than left to hit the real entitlements/
// cache/DB stack (registrations.ts is a heavy module this page test does
// not otherwise pull in) — real behaviour is covered by
// fetch-division-rows.test.ts's real-Postgres suite, same split as
// fetchDivisionRows/fetchOrgCurrency below.
vi.mock("@/server/usecases/registrations", () => ({ feePercentFor: feePercentForMock }));

// A tagged-template call (`.raw` on the strings array) resolves to `h.rows`
// — UNLESS its first raw chunk identifies it as finding 6's dedicated
// currency-only fallback query (fetchOrgCurrency in page.tsx), which
// resolves to `h.orgCurrency` instead; a fragment builder call
// (`tx([...SPOT_HOLDERS])`, a plain array — no `.raw`) resolves to an inert
// marker, same split as the proven registration-nav-entry-wiring.test.tsx
// `sql` mock, adapted to withTenant's callback shape.
vi.mock("@/lib/db", () => ({
  withTenant: async (_orgId: string, fn: (tx: unknown) => unknown) => {
    h.withTenantCalls += 1;
    const tx = (strings: unknown) => {
      if (!Array.isArray(strings) || !("raw" in (strings as object))) {
        return { __fragment: strings };
      }
      const first = String((strings as string[])[0] ?? "").trim();
      if (first.startsWith("select currency from organizations")) {
        h.currencyQueries += 1;
        return Promise.resolve([{ currency: h.orgCurrency }]);
      }
      if (first.startsWith("select stripe_unsupported_currency from organizations")) {
        h.unsupportedQueries += 1;
        return Promise.resolve([{ stripe_unsupported_currency: h.orgStripeUnsupportedCurrency }]);
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
// Real (unmocked) dictionary loader — only `@/lib/resolve-locale` is mocked
// above (pinned to "en"), so this reads the SAME dictionary the page itself
// resolves. Used below to assert the panel receives the actual translated
// string, never a hardcoded English literal or a mis-keyed lookup (RS004 W2b
// review finding 2).
import { getDictionary, t } from "@/lib/i18n";

const params = Promise.resolve({ orgSlug: "riverside", compSlug: "summer-league" });
const noTab = Promise.resolve({});

beforeEach(() => {
  h.canEdit = true;
  h.refuseInGuard = false;
  h.orgTimezone = null;
  h.competitionVisibility = "public";
  h.rows = [];
  h.orgCurrency = "usd";
  h.orgStripeUnsupportedCurrency = null;
  h.withTenantCalls = 0;
  h.currencyQueries = 0;
  h.unsupportedQueries = 0;
  feePercentForMock.mockClear();
  feePercentForMock.mockResolvedValue(8);
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

  it("passes the REAL Settings-tab title/body strings from the dictionary — never a hardcoded literal or a mis-keyed lookup", async () => {
    // A mis-keyed lookup (e.g. `t(dict, "reg.hub.settings.titel")`) would
    // render the raw key string, and the assertions above (which only check
    // WHICH component type rendered) would stay green regardless — this is
    // the gap RS004 W2b review finding 2 flagged. Comparing against the
    // dictionary's OWN resolved value (not a hardcoded "Registration
    // settings" string) means a real locale-copy change never breaks this
    // test either.
    const tree = walk(await Page({ params, searchParams: noTab }));
    const panel = tree.find((e) => e.type === RegistrationHubSettingsPanel)!;
    const props = propsOf(panel);
    const dict = await getDictionary("en", "ui");
    expect(props.title).toBe(t(dict, "reg.hub.settings.title"));
    expect(props.body).toBe(t(dict, "reg.hub.settings.body"));
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

  it("does not resolve fee_percent on the Registrants tab either — same wasted-read guard (W3c)", async () => {
    await Page({ params, searchParams: Promise.resolve({ tab: "registrants" }) });
    expect(feePercentForMock).not.toHaveBeenCalled();
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

  // RS004 W3b review finding 6: asCurrency(rawRows[0]?.org_currency) silently
  // fell back to "usd" whenever rows is empty (a competition with zero
  // divisions) — harmless only because currency happened to be unused with
  // no rows, but a landmine for whatever reads it next. h.orgCurrency ("eur"
  // here) is a DIFFERENT value than the default "usd" fallback specifically
  // so this test cannot pass by coincidence.
  it("resolves the org currency independently of rows[0] — an empty rows list must not fall back to usd (finding 6)", async () => {
    h.rows = [];
    h.orgCurrency = "eur";
    const tree = walk(await Page({ params, searchParams: noTab }));
    const panel = tree.find((e) => e.type === RegistrationHubSettingsPanel)!;
    expect((propsOf(panel).context as { currency: string }).currency).toBe("eur");
  });

  // The gap-pass review caught finding 6's fix leaving one branch behind: both
  // fallbacks were `tab === "settings" ? … : <hardcoded default>`, and the
  // Registrants tab's rows list is ALWAYS empty, so it took "usd" and "card
  // payments are fine" every time. Resolving them for real on that tab would
  // have traded a wrong value for a wasted pair of queries — the test above
  // pins that tab at zero reads. The page now builds no context there at all,
  // so there is no value to be wrong about.
  // CHARACTERISATION, deliberately: both of these pass against the pre-fix
  // code too. The old shape fabricated "usd" into a context the Registrants
  // tab never renders, so no output was ever wrong and there is no regression
  // to prove. What the fix removes is the ABILITY to be wrong — the value
  // RS005 would otherwise inherit and start reading. These tests pin the
  // shape so that inheritance cannot happen silently.
  it("builds no context at all on the Registrants tab, rather than defaulting one", async () => {
    h.rows = [];
    h.orgCurrency = "eur";
    h.orgStripeUnsupportedCurrency = "sek";
    const tree = walk(await Page({ params, searchParams: Promise.resolve({ tab: "registrants" }) }));
    expect(tree.find((e) => e.type === RegistrationHubSettingsPanel)).toBeUndefined();
    expect(h.currencyQueries).toBe(0);
    expect(h.unsupportedQueries).toBe(0);
  });

  // The Settings tab is where the fallbacks must actually fire: a competition
  // with zero divisions still renders a currency and still needs to know the
  // org's card state. "sek" is outside REGISTRATION_CURRENCIES on purpose —
  // it can only have come from the fallback query, never from a row.
  it("resolves BOTH org fallbacks on the Settings tab when rows is empty (finding 6)", async () => {
    h.rows = [];
    h.orgStripeUnsupportedCurrency = "sek";
    const tree = walk(await Page({ params, searchParams: noTab }));
    const panel = tree.find((e) => e.type === RegistrationHubSettingsPanel)!;
    expect(propsOf(panel).cardUnsupportedCurrency).toBe("sek");
    expect(h.currencyQueries).toBe(1);
    expect(h.unsupportedQueries).toBe(1);
  });
});

describe("registration hub — config panel context (RS004 W3c)", () => {
  it("passes orgSlug through to the settings panel", async () => {
    const tree = walk(await Page({ params, searchParams: noTab }));
    const panel = tree.find((e) => e.type === RegistrationHubSettingsPanel)!;
    expect(propsOf(panel).orgSlug).toBe("riverside");
  });

  it("passes feePercentFor's resolved value as feePercentPct", async () => {
    feePercentForMock.mockResolvedValue(5);
    const tree = walk(await Page({ params, searchParams: noTab }));
    const panel = tree.find((e) => e.type === RegistrationHubSettingsPanel)!;
    expect(propsOf(panel).feePercentPct).toBe(5);
  });

  it("resolves fee_percent for THIS org and competition", async () => {
    await Page({ params, searchParams: noTab });
    expect(feePercentForMock).toHaveBeenCalledWith("org-1", "comp-1");
  });

  it("reads cardUnsupportedCurrency off the row's own org_stripe_unsupported_currency when rows exist", async () => {
    h.rows = [
      {
        division_id: "div-1",
        name: "Open Singles",
        category: null,
        age_min: null,
        age_max: null,
        enabled: true,
        entrant_kind: "individual",
        opens_at: null,
        closes_at: null,
        capacity: null,
        fee_cents: 0,
        approval: "auto",
        allow_free_agents: false,
        taken: 0,
        org_currency: "usd",
        org_stripe_unsupported_currency: "jpy",
      },
    ];
    const tree = walk(await Page({ params, searchParams: noTab }));
    const panel = tree.find((e) => e.type === RegistrationHubSettingsPanel)!;
    expect(propsOf(panel).cardUnsupportedCurrency).toBe("jpy");
  });

  it("is null (card supported) when the row carries no unsupported-currency value", async () => {
    h.rows = [
      {
        division_id: "div-1",
        name: "Open Singles",
        category: null,
        age_min: null,
        age_max: null,
        enabled: true,
        entrant_kind: "individual",
        opens_at: null,
        closes_at: null,
        capacity: null,
        fee_cents: 0,
        approval: "auto",
        allow_free_agents: false,
        taken: 0,
        org_currency: "usd",
        org_stripe_unsupported_currency: null,
      },
    ];
    const tree = walk(await Page({ params, searchParams: noTab }));
    const panel = tree.find((e) => e.type === RegistrationHubSettingsPanel)!;
    expect(propsOf(panel).cardUnsupportedCurrency).toBeNull();
  });

  // Same "finding 6" shape as org currency: a Settings-tab competition with
  // ZERO divisions has no row to read org_stripe_unsupported_currency off,
  // so it must resolve through the dedicated fallback query rather than
  // silently defaulting to "supported" (null) regardless of the real value.
  it("resolves cardUnsupportedCurrency independently of rows[0] on a zero-row settings tab", async () => {
    h.rows = [];
    h.orgStripeUnsupportedCurrency = "jpy";
    const tree = walk(await Page({ params, searchParams: noTab }));
    const panel = tree.find((e) => e.type === RegistrationHubSettingsPanel)!;
    expect(propsOf(panel).cardUnsupportedCurrency).toBe("jpy");
  });
});

// TEMP(RS004 variants) — the sign-off scaffold's `?variant=` read, mirroring
// `?tab=`'s own pattern above exactly. See registration-hub-variant.ts's
// header comment for the full explanation; this whole describe block is
// deleted alongside every other TEMP(RS004 variants) file/edit once the
// owner picks a direction.
describe("registration hub — ?variant= switching (TEMP(RS004 variants))", () => {
  it("defaults variant to 'a' with no ?variant=", async () => {
    const tree = walk(await Page({ params, searchParams: noTab }));
    const panel = tree.find((e) => e.type === RegistrationHubSettingsPanel)!;
    expect(propsOf(panel).variant).toBe("a");
  });

  it("passes an explicit ?variant=b through to the settings panel", async () => {
    const tree = walk(await Page({ params, searchParams: Promise.resolve({ variant: "b" }) }));
    const panel = tree.find((e) => e.type === RegistrationHubSettingsPanel)!;
    expect(propsOf(panel).variant).toBe("b");
  });

  it("passes an explicit ?variant=c through to the settings panel", async () => {
    const tree = walk(await Page({ params, searchParams: Promise.resolve({ variant: "c" }) }));
    const panel = tree.find((e) => e.type === RegistrationHubSettingsPanel)!;
    expect(propsOf(panel).variant).toBe("c");
  });

  it("falls back to 'a' on a garbage ?variant=", async () => {
    const tree = walk(await Page({ params, searchParams: Promise.resolve({ variant: "bogus" }) }));
    const panel = tree.find((e) => e.type === RegistrationHubSettingsPanel)!;
    expect(propsOf(panel).variant).toBe("a");
  });
});
