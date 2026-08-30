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
  // RS005 W2a: fetchDivisionRows' own query (the Settings tab's heavier
  // shape) vs fetchDivisionOptions' (the Registrants tab's small id+name
  // dropdown query) — tracked SEPARATELY so "Settings issues no registrant
  // query / Registrants issues no division-ROWS query" can be pinned
  // precisely in both directions, not just as one blunt total.
  divisionRowsQueries: 0,
  divisionOptionsQueries: 0,
  divisionOptions: [] as unknown[],
  // RS005 W2b: fetchRegistrantDetails' own 2 queries (registration_players,
  // then registrations/registration_settings for siblings+form_fields) —
  // tracked separately from divisionRowsQueries/divisionOptionsQueries for
  // the same reason those two are split: "the OTHER tab's query never ran"
  // has to be provable in both directions, not just as one blunt total.
  rosterQueries: 0,
  siblingsQueries: 0,
  rosterRows: [] as unknown[],
  siblingRows: [] as unknown[],
}));

const feePercentForMock = vi.hoisted(() => vi.fn(async () => 8));
// listRegistrations is a HEAVY usecase (Stripe/entitlements/DB) — mocked the
// same way feePercentFor already is, rather than exercised for real through
// the @/lib/db fake below (that fake's tx() only ever answers the Settings
// tab's own query shapes; listRegistrations' joined SELECT is a different
// shape it was never built to recognise). Real SQL correctness for
// fetchRegistrantRows/fetchDivisionOptions lives in
// fetch-registrant-rows-db.test.ts instead.
const listRegistrationsMock = vi.hoisted(() => vi.fn(async () => [] as unknown[]));

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
vi.mock("@/server/usecases/registrations", () => ({
  feePercentFor: feePercentForMock,
  listRegistrations: listRegistrationsMock,
}));

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
      // fetchDivisionOptions (RS005 W2a, data.ts) — the Registrants tab's
      // own small id+name dropdown query. Distinguishable from
      // fetchDivisionRows' shape (falls through to the default branch
      // below) by its distinct leading text.
      if (first.startsWith("select id, name")) {
        h.divisionOptionsQueries += 1;
        return Promise.resolve(h.divisionOptions);
      }
      // fetchRegistrantDetails (RS005 W2b, data.ts) — the row-expand
      // detail's 2 queries. Distinguished by their own distinct leading
      // column lists (see data.ts's own SQL) so neither can be mistaken
      // for fetchDivisionRows' shape and pollute divisionRowsQueries.
      if (first.startsWith("select registration_id")) {
        h.rosterQueries += 1;
        return Promise.resolve(h.rosterRows);
      }
      if (first.startsWith("select r.id")) {
        h.siblingsQueries += 1;
        return Promise.resolve(h.siblingRows);
      }
      h.divisionRowsQueries += 1;
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
  h.divisionRowsQueries = 0;
  h.divisionOptionsQueries = 0;
  h.divisionOptions = [];
  h.rosterQueries = 0;
  h.siblingsQueries = 0;
  h.rosterRows = [];
  h.siblingRows = [];
  feePercentForMock.mockClear();
  feePercentForMock.mockResolvedValue(8);
  listRegistrationsMock.mockClear();
  listRegistrationsMock.mockResolvedValue([]);
});

describe("registration hub — RS005 owner/admin/viewer access (reverses RS004 ruling 2)", () => {
  it("renders for an editor (owner/admin)", async () => {
    await expect(Page({ params, searchParams: noTab })).resolves.toBeTruthy();
  });

  it("renders for a viewer too — read-only, NOT a 404 (RS005 owner ruling, 2026-08-25)", async () => {
    h.canEdit = false;
    await expect(Page({ params, searchParams: noTab })).resolves.toBeTruthy();
  });

  it("threads canEdit through to the Settings panel — true for an editor, false for a viewer", async () => {
    // Was `expect(panel).toBeTruthy()` only, with a comment saying the panel
    // had no canEdit prop. It has one now (the row context carries it, so the
    // Configure control can be absent for a viewer), and asserting only that
    // the panel rendered would ship green against a hardcoded `canEdit: true`
    // — which is precisely the regression that would put a 403-only control
    // back in front of a read-only role.
    h.canEdit = false;
    let panel = walk(await Page({ params, searchParams: noTab })).find(
      (e) => e.type === RegistrationHubSettingsPanel,
    );
    expect(panel).toBeTruthy();
    expect((propsOf(panel!).context as { canEdit: boolean }).canEdit).toBe(false);

    h.canEdit = true;
    panel = walk(await Page({ params, searchParams: noTab })).find(
      (e) => e.type === RegistrationHubSettingsPanel,
    );
    expect((propsOf(panel!).context as { canEdit: boolean }).canEdit).toBe(true);
  });

  it("still 404s the guard's own refusal (e.g. a scorer) without swallowing it — unrelated to this wave's change", async () => {
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

  it("does not run fetchDivisionRows' query on the Registrants tab — no N+1, no wasted read (RS005 W2a mirror, direction 1)", async () => {
    await Page({ params, searchParams: Promise.resolve({ tab: "registrants" }) });
    expect(h.divisionRowsQueries).toBe(0);
  });

  it("DOES run its own small division-OPTIONS query (the filter dropdown) on the Registrants tab", async () => {
    await Page({ params, searchParams: Promise.resolve({ tab: "registrants" }) });
    expect(h.divisionOptionsQueries).toBe(1);
  });

  it("does not resolve fee_percent on the Registrants tab either — same wasted-read guard (W3c)", async () => {
    await Page({ params, searchParams: Promise.resolve({ tab: "registrants" }) });
    expect(feePercentForMock).not.toHaveBeenCalled();
  });

  it("does not run listRegistrations on the Settings tab (RS005 W2a mirror, direction 2 — task acceptance's own wording)", async () => {
    await Page({ params, searchParams: noTab });
    expect(listRegistrationsMock).not.toHaveBeenCalled();
  });

  it("does not run fetchDivisionOptions' query on the Settings tab either", async () => {
    await Page({ params, searchParams: noTab });
    expect(h.divisionOptionsQueries).toBe(0);
  });

  it("DOES run listRegistrations exactly once on the Registrants tab", async () => {
    await Page({ params, searchParams: Promise.resolve({ tab: "registrants" }) });
    expect(listRegistrationsMock).toHaveBeenCalledTimes(1);
  });
});

describe("registration hub — row-expand detail query wiring (RS005 W2b, task 3)", () => {
  it("issues exactly ONE roster query and ONE siblings query for a multi-row Registrants page — never one per row", async () => {
    listRegistrationsMock.mockResolvedValueOnce([
      { id: "r1", group_id: "g1" },
      { id: "r2", group_id: "g1" },
      { id: "r3", group_id: "g2" },
    ]);
    await Page({ params, searchParams: Promise.resolve({ tab: "registrants" }) });
    expect(h.rosterQueries).toBe(1);
    expect(h.siblingsQueries).toBe(1);
  });

  it("issues ZERO detail queries when the Registrants tab has no rows — no wasted round trip", async () => {
    await Page({ params, searchParams: Promise.resolve({ tab: "registrants" }) });
    expect(h.rosterQueries).toBe(0);
    expect(h.siblingsQueries).toBe(0);
  });

  it("never runs the detail queries on the Settings tab", async () => {
    await Page({ params, searchParams: noTab });
    expect(h.rosterQueries).toBe(0);
    expect(h.siblingsQueries).toBe(0);
  });

  it("never pollutes divisionRowsQueries — the detail queries have their own distinct branches", async () => {
    listRegistrationsMock.mockResolvedValueOnce([{ id: "r1", group_id: "g1" }]);
    await Page({ params, searchParams: Promise.resolve({ tab: "registrants" }) });
    expect(h.divisionRowsQueries).toBe(0);
  });

  it("passes the resolved details straight through to the panel's details prop", async () => {
    listRegistrationsMock.mockResolvedValueOnce([{ id: "r1", group_id: "g1" }]);
    const tree = walk(await Page({ params, searchParams: Promise.resolve({ tab: "registrants" }) }));
    const panel = tree.find((e) => e.type === RegistrationHubRegistrantsPanel)!;
    const details = propsOf(panel).details as {
      rosterByRegistration: Map<string, unknown>;
      siblingsByGroup: Map<string, unknown>;
      formFieldsByRegistration: Map<string, unknown>;
    };
    expect(details.rosterByRegistration).toBeInstanceOf(Map);
    expect(details.siblingsByGroup).toBeInstanceOf(Map);
    expect(details.formFieldsByRegistration).toBeInstanceOf(Map);
  });
});

describe("registration hub — Registrants tab data wiring (RS005 W2a)", () => {
  it("threads a filter from the raw query string through to listRegistrations", async () => {
    await Page({
      params,
      searchParams: Promise.resolve({ tab: "registrants", status: "paid" }),
    });
    expect(listRegistrationsMock).toHaveBeenCalledWith(
      { orgId: "org-1" },
      null,
      "paid",
      { competition_id: "comp-1", sort: "newest" },
    );
  });

  it("maps listRegistrations' resolved rows onto the panel's rows prop", async () => {
    const fakeRows = [{ id: "reg-1", display_name: "Alex Smith" }];
    listRegistrationsMock.mockResolvedValueOnce(fakeRows);
    const tree = walk(await Page({ params, searchParams: Promise.resolve({ tab: "registrants" }) }));
    const panel = tree.find((e) => e.type === RegistrationHubRegistrantsPanel)!;
    expect(propsOf(panel).rows).toBe(fakeRows);
  });

  it("maps fetchDivisionOptions' resolved rows onto the panel's divisions prop", async () => {
    h.divisionOptions = [{ id: "div-1", name: "Open Singles" }];
    const tree = walk(await Page({ params, searchParams: Promise.resolve({ tab: "registrants" }) }));
    const panel = tree.find((e) => e.type === RegistrationHubRegistrantsPanel)!;
    expect(propsOf(panel).divisions).toEqual([{ id: "div-1", name: "Open Singles" }]);
  });

  it("threads canEdit through — true for an editor, false for a viewer", async () => {
    h.canEdit = true;
    let tree = walk(await Page({ params, searchParams: Promise.resolve({ tab: "registrants" }) }));
    expect(propsOf(tree.find((e) => e.type === RegistrationHubRegistrantsPanel)!).canEdit).toBe(true);

    h.canEdit = false;
    tree = walk(await Page({ params, searchParams: Promise.resolve({ tab: "registrants" }) }));
    expect(propsOf(tree.find((e) => e.type === RegistrationHubRegistrantsPanel)!).canEdit).toBe(false);
  });

  it("passes the REAL empty-state strings from the dictionary — never a hardcoded literal or a mis-keyed lookup", async () => {
    const tree = walk(await Page({ params, searchParams: Promise.resolve({ tab: "registrants" }) }));
    const panel = tree.find((e) => e.type === RegistrationHubRegistrantsPanel)!;
    const props = propsOf(panel);
    const dict = await getDictionary("en", "ui");
    expect(props.emptyTitle).toBe(t(dict, "reg.hub.registrants.title"));
    expect(props.emptyBody).toBe(t(dict, "reg.hub.registrants.body"));
    expect(props.emptyCtaLabel).toBe(t(dict, "reg.hub.registrants.cta"));
  });

  it("builds the empty-state cta href pointing at the Settings tab", async () => {
    const tree = walk(await Page({ params, searchParams: Promise.resolve({ tab: "registrants" }) }));
    const panel = tree.find((e) => e.type === RegistrationHubRegistrantsPanel)!;
    expect(propsOf(panel).emptyCtaHref).toBe("/o/riverside/c/summer-league/registration?tab=settings");
  });

  it("builds the CSV export href off THIS competition's id", async () => {
    const tree = walk(await Page({ params, searchParams: Promise.resolve({ tab: "registrants" }) }));
    const panel = tree.find((e) => e.type === RegistrationHubRegistrantsPanel)!;
    expect(propsOf(panel).exportHref).toBe(
      "/api/v1/competitions/comp-1/registrations/export?sort=newest",
    );
  });

  // RS005 F3 finding 2: the export href must carry the SAME filter the
  // table is actually showing, including the negative ("0") case — see
  // registrantsExportHrefFor's own comment (data.ts).
  it("carries the explicit '0' form on the export href when the table is narrowed to the negative case", async () => {
    const tree = walk(
      await Page({
        params,
        searchParams: Promise.resolve({ tab: "registrants", free_agent: "0", consent_pending: "0" }),
      }),
    );
    const panel = tree.find((e) => e.type === RegistrationHubRegistrantsPanel)!;
    expect(propsOf(panel).exportHref).toBe(
      "/api/v1/competitions/comp-1/registrations/export?sort=newest&free_agent=0&consent_pending=0",
    );
  });

  it("builds filtersAction as the tab's BARE path (no query string — a GET form submit would otherwise discard it)", async () => {
    const tree = walk(await Page({ params, searchParams: Promise.resolve({ tab: "registrants" }) }));
    const panel = tree.find((e) => e.type === RegistrationHubRegistrantsPanel)!;
    expect(propsOf(panel).filtersAction).toBe("/o/riverside/c/summer-league/registration");
  });

  it("resolves orgTz the SAME way the Settings tab does — org timezone, never UTC-by-coincidence", async () => {
    h.orgTimezone = "Asia/Kolkata";
    const tree = walk(await Page({ params, searchParams: Promise.resolve({ tab: "registrants" }) }));
    const panel = tree.find((e) => e.type === RegistrationHubRegistrantsPanel)!;
    expect(propsOf(panel).orgTz).toBe("Asia/Kolkata");
  });
});

// RS005 F3 finding 1: a repeated `?q=a&q=b` reaches this page's
// `searchParams` as `string[]` (Next's own docs), not `string` — before the
// fix, `raw.q?.trim()` threw `TypeError: raw.q?.trim is not a function`,
// and `o/[orgSlug]/c/[compSlug]/error.tsx` swallowed the WHOLE hub (title,
// tab strip, both panels), not just the Registrants panel. Asserting the
// page RENDERS is the point (per the dispatch's own framing) — not that it
// throws some OTHER, different error.
describe("registration hub — array-valued query params never 500 the page (RS005 F3 finding 1)", () => {
  it("a repeated ?q=a&q=b renders instead of throwing", async () => {
    await expect(
      Page({ params, searchParams: Promise.resolve({ tab: "registrants", q: ["a", "b"] }) }),
    ).resolves.toBeTruthy();
  });

  it("every other parsed field also survives an array value", async () => {
    await expect(
      Page({
        params,
        searchParams: Promise.resolve({
          tab: "registrants",
          status: ["paid", "confirmed"],
          division_id: ["11111111-2222-3333-4444-555555555555", "not-a-uuid"],
          kind: ["team", "pair"],
          sort: ["oldest", "newest"],
          free_agent: ["1", "0"],
          consent_pending: ["0", "1"],
        }),
      }),
    ).resolves.toBeTruthy();
  });

  it("still renders the Registrants panel (not the error boundary) on a repeated param", async () => {
    const tree = walk(
      await Page({ params, searchParams: Promise.resolve({ tab: "registrants", q: ["a", "b"] }) }),
    );
    expect(tree.some((e) => e.type === RegistrationHubRegistrantsPanel)).toBe(true);
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
        // RS007/V380 — non-null on purpose: the mapping this test exists to
        // prove would pass just as easily with the null default even if
        // page.tsx's rawRows.map(...) forgot these two fields entirely.
        age_cutoff_month: 9,
        age_cutoff_day: 1,
        eligibility_note: "School-registered students only",
        enabled: true,
        entrant_kind: "individual",
        opens_at: null,
        closes_at: null,
        capacity: 20,
        fee_cents: 1500,
        approval: "auto",
        allow_free_agents: false,
        taken: 3,
        // RS005 F4 — a value distinct from `taken` so a mapping that
        // accidentally reused the wrong source field cannot pass by
        // coincidence.
        waitlisted: 5,
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
        age_cutoff_month: 9,
        age_cutoff_day: 1,
        eligibility_note: "School-registered students only",
        enabled: true,
        entrant_kind: "individual",
        opens_at: null,
        closes_at: null,
        capacity: 20,
        fee_cents: 1500,
        approval: "auto",
        allow_free_agents: false,
        taken: 3,
        waitlisted: 5,
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

  // Finding 4 (whole-branch review): org_stripe_unsupported_currency is
  // legitimately NULL for every healthy org's row, and `rawRows[0]?.col ??
  // fallback()` treats that null exactly like "no rows at all" — so the
  // fallback query fired on nearly every Settings-tab load, the opposite of
  // "only when there are no rows" its own comment claims. h.rows is
  // NON-EMPTY here (the common case) with the column explicitly null; the
  // fallback must not run at all.
  it("issues NO fallback query when rows exist, even though the row's own column is null", async () => {
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
    await Page({ params, searchParams: noTab });
    expect(h.unsupportedQueries).toBe(0);
  });
});
