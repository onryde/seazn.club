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
import type { ReactNode } from "react";

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
  // RS012 `/code-review high` finding 3 — fetchPoolSummary's own three
  // queries (data.ts), each its own bucket for the same reason
  // divisionOptionsQueries/rosterQueries/siblingsQueries are split out
  // below: before these existed, fetchPoolSummary's `waitingRows` query
  // fell through to the default branch and silently inflated
  // divisionRowsQueries, breaking the two "no N+1 / never pollutes"
  // isolation tests further down (found running this suite's own
  // baseline, not by inspection).
  poolWaitingRows: [] as unknown[],
  poolSlotRows: [] as unknown[],
  poolMetaRows: [] as unknown[],
  // How many times ANY of fetchPoolSummary's own 3 queries fired — used by
  // finding 6's concurrency test to prove fetchPoolSummary actually ran,
  // not just that it avoided the wrong bucket.
  poolQueries: 0,
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
// cache/DB stack (usecases/registrations/ is a heavy module this page test does
// not otherwise pull in) — real behaviour is covered by
// fetch-division-rows.test.ts's real-Postgres suite, same split as
// fetchDivisionRows/fetchOrgCurrency below.
vi.mock("@/server/usecases/registrations", () => ({
  feePercentFor: feePercentForMock,
  listRegistrations: listRegistrationsMock,
  // RS012 `/code-review high` finding 3: data.ts's fetchPoolSummary (now
  // exercised for real by the poolSummary wiring test below) also imports
  // `rosterCapExpr`/`effectivePoolDeadline` from this SAME module — a bare
  // {feePercentFor, listRegistrations} mock left them undefined and crashed
  // the instant fetchPoolSummary's non-empty path ran ("No 'rosterCapExpr'
  // export is defined on the mock"). Inert stand-ins, not `importOriginal`,
  // to keep this file's own stated reason for mocking the module at all
  // (avoid pulling in usecases/registrations/ folder's heavy Stripe/entitlements/DB load).
  // `rosterCapExpr`'s return value is only ever embedded as an interpolated
  // VALUE inside a query the @/lib/db fake below dispatches on the query's
  // leading TEXT — it never reads interpolated values, so what this returns
  // does not matter, only that it exists and does not throw.
  // `effectivePoolDeadline` DOES need real behaviour: fetchPoolSummary's own
  // JS-side merge calls it directly (not through a SQL template) to compute
  // the `place_by_at` value the test below asserts on — same `?? ` fallback
  // as the real implementation (usecases/registrations/list.ts, beside rosterCapExpr).
  rosterCapExpr: () => "",
  effectivePoolDeadline: (placeByAt: unknown, closesAt: unknown) => placeByAt ?? closesAt,
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
      // fetchPoolSummary (RS012 scope item 4, data.ts) — its three own
      // queries, each distinguished by its own leading column list so none
      // of them can fall through to the divisionRowsQueries default below
      // (see the h.poolWaitingRows doc comment above for why that matters).
      if (first.startsWith("select r.division_id, count(*)::int as waiting")) {
        h.poolQueries += 1;
        return Promise.resolve(h.poolWaitingRows);
      }
      if (first.startsWith("select t.division_id")) {
        h.poolQueries += 1;
        return Promise.resolve(h.poolSlotRows);
      }
      if (first.startsWith("select d.id as division_id, d.name as division_name")) {
        h.poolQueries += 1;
        return Promise.resolve(h.poolMetaRows);
      }
      h.divisionRowsQueries += 1;
      return Promise.resolve(h.rows);
    };
    return fn(tx);
  },
}));

import Page from "../page";
import { walk } from "@/components/__tests__/_hook-harness";
import { propsOf, textOf } from "@/components/__tests__/_hook-harness";
import { RegistrationHubSettingsPanel } from "@/components/registration-hub-settings-panel";
import { RegistrationHubRegistrantsPanel } from "@/components/registration-hub-registrants-panel";
import { RegistrationHubTabsHost, type HubDivisionConfigContext } from "@/components/registration-hub-tabs-host";
import { parseHubTabs } from "@/components/registration-hub-tabs-state";
import { compileClasses } from "@/components/v2/__tests__/_compiled-css";
// Real (unmocked) dictionary loader — only `@/lib/resolve-locale` is mocked
// above (pinned to "en"), so this reads the SAME dictionary the page itself
// resolves. Used below to assert the panel receives the actual translated
// string, never a hardcoded English literal or a mis-keyed lookup (RS004 W2b
// review finding 2).
import { getDictionary, t } from "@/lib/i18n";
import { builtinModules } from "@seazn/engine/sports";
import { effectiveEntrantModel } from "@seazn/engine/sport";

const FOOTBALL = builtinModules.find((m) => m.key === "football")!;

const params = Promise.resolve({ orgSlug: "riverside", compSlug: "summer-league" });
const noTab = Promise.resolve({});

// B7 T24: every tab renders inside RegistrationHubTabsHost (a client component, never invoked here). Its section panel is its
// child, which walk() follows; the strip's trailing slot (Export CSV) rides as its `stripEnd` PROP, which walk() does not —
// so the page's tree is read with that slot walked too.
const hostOf = (tree: ReturnType<typeof walk>) => tree.find((e) => e.type === RegistrationHubTabsHost);
function walkPage(node: ReactNode): ReturnType<typeof walk> {
  const tree = walk(node);
  const host = hostOf(tree);
  return host ? [...tree, ...walk(propsOf(host).stripEnd as ReactNode)] : tree;
}
/** One Settings row as fetchDivisionRows' query returns it (before the loader resolves its allowed kinds). */
const SETTINGS_ROW = {
  division_id: "div-1",
  name: "Open Singles",
  sport_key: "football",
  module_version: FOOTBALL.version,
  config: {},
  category: null,
  age_min: null,
  age_max: null,
  age_cutoff_month: null,
  age_cutoff_day: null,
  eligibility_note: null,
  enabled: true,
  entrant_kind: "team",
  opens_at: null,
  closes_at: null,
  capacity: null,
  fee_cents: 0,
  approval: "auto",
  allow_free_agents: false,
  taken: 0,
  waitlisted: 0,
  org_currency: "usd",
  org_stripe_unsupported_currency: null,
};

/** What the host hands every division settings page (null when no division tab is open on a tab that needs none). */
const configOf = (tree: ReturnType<typeof walk>) => propsOf(hostOf(tree)!).config as HubDivisionConfigContext | null;

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
  h.poolWaitingRows = [];
  h.poolSlotRows = [];
  h.poolMetaRows = [];
  h.poolQueries = 0;
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
    let panel = walkPage(await Page({ params, searchParams: noTab })).find(
      (e) => e.type === RegistrationHubSettingsPanel,
    );
    expect(panel).toBeTruthy();
    expect((propsOf(panel!).context as { canEdit: boolean }).canEdit).toBe(false);

    h.canEdit = true;
    panel = walkPage(await Page({ params, searchParams: noTab })).find(
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
    const tree = walkPage(await Page({ params, searchParams: noTab }));
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
    const tree = walkPage(await Page({ params, searchParams: noTab }));
    const panel = tree.find((e) => e.type === RegistrationHubSettingsPanel)!;
    const props = propsOf(panel);
    const dict = await getDictionary("en", "ui");
    expect(props.title).toBe(t(dict, "reg.hub.settings.title"));
    expect(props.body).toBe(t(dict, "reg.hub.settings.body"));
  });

  it("falls back to Settings on a garbage ?tab=", async () => {
    const tree = walkPage(await Page({ params, searchParams: Promise.resolve({ tab: "bogus" }) }));
    expect(tree.some((e) => e.type === RegistrationHubSettingsPanel)).toBe(true);
    expect(tree.some((e) => e.type === RegistrationHubRegistrantsPanel)).toBe(false);
  });

  it("switches to the Registrants panel with ?tab=registrants", async () => {
    const tree = walkPage(
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

// RS012 `/code-review high` finding 6: fetchDivisionOptions/fetchPoolSummary
// depend only on auth/id, not on fetchRegistrantRows' own result — they
// should run CONCURRENTLY with it via Promise.all, not wait their turn
// behind it. Proven by holding fetchRegistrantRows' own promise open and
// checking the other two have already fired — the pre-fix sequential shape
// would leave them at zero until fetchRegistrantRows resolves.
describe("registration hub — Registrants tab: concurrent fetch wiring (RS012 finding 6)", () => {
  it("fires fetchDivisionOptions and fetchPoolSummary before fetchRegistrantRows' own promise resolves", async () => {
    let resolveRegistrants!: (v: unknown[]) => void;
    listRegistrationsMock.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveRegistrants = resolve;
        }),
    );
    h.poolWaitingRows = [{ division_id: "div-9", waiting: 1 }];

    const pagePromise = Page({ params, searchParams: Promise.resolve({ tab: "registrants" }) });
    // Drain the microtask queue without ever resolving fetchRegistrantRows —
    // under the pre-fix sequential `await`s, page.tsx would still be
    // suspended on that first await and neither of the other two fetches
    // would have run yet.
    await new Promise((r) => setTimeout(r, 0));
    expect(h.divisionOptionsQueries).toBe(1);
    // fetchPoolSummary's own first query ran too — it did not wait its turn
    // behind fetchRegistrantRows either.
    expect(h.poolQueries).toBeGreaterThan(0);

    resolveRegistrants([]);
    await pagePromise;
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

  it("hands the panel the route's own slugs (the row detail's join link is built from them)", async () => {
    listRegistrationsMock.mockResolvedValueOnce([{ id: "r1", group_id: "g1" }]);
    const tree = walkPage(await Page({ params, searchParams: Promise.resolve({ tab: "registrants" }) }));
    const panel = propsOf(tree.find((e) => e.type === RegistrationHubRegistrantsPanel)!);
    expect(panel.orgSlug).toBe("riverside");
    expect(panel.compSlug).toBe("summer-league");
  });

  it("passes the resolved details straight through to the panel's details prop", async () => {
    listRegistrationsMock.mockResolvedValueOnce([{ id: "r1", group_id: "g1" }]);
    const tree = walkPage(await Page({ params, searchParams: Promise.resolve({ tab: "registrants" }) }));
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
    const tree = walkPage(await Page({ params, searchParams: Promise.resolve({ tab: "registrants" }) }));
    const panel = tree.find((e) => e.type === RegistrationHubRegistrantsPanel)!;
    expect(propsOf(panel).rows).toBe(fakeRows);
  });

  it("maps fetchDivisionOptions' resolved rows onto the panel's divisions prop", async () => {
    h.divisionOptions = [{ id: "div-1", name: "Open Singles" }];
    const tree = walkPage(await Page({ params, searchParams: Promise.resolve({ tab: "registrants" }) }));
    const panel = tree.find((e) => e.type === RegistrationHubRegistrantsPanel)!;
    expect(propsOf(panel).divisions).toEqual([{ id: "div-1", name: "Open Singles" }]);
  });

  // RS012 `/code-review high` finding 3: nothing here previously asserted
  // that page.tsx even CALLS fetchPoolSummary, let alone that its result
  // reaches the panel's `poolSummary` prop — a swapped/dropped variable
  // would have shipped silently. Real (unmocked) fetchPoolSummary
  // (../data.ts) runs against the @/lib/db fake above, so this also proves
  // the page's own href-building (division_id + free_agent=1, appended to
  // EACH row) rather than just that SOME array reached the prop.
  it("maps fetchPoolSummary's resolved rows onto the panel's poolSummary prop, with each row's own href", async () => {
    h.poolWaitingRows = [{ division_id: "div-9", waiting: 2 }];
    h.poolSlotRows = [{ division_id: "div-9", free_slots: 3 }];
    h.poolMetaRows = [{ division_id: "div-9", division_name: "Div 9", place_by_at: null, closes_at: null }];
    const tree = walkPage(await Page({ params, searchParams: Promise.resolve({ tab: "registrants" }) }));
    const panel = tree.find((e) => e.type === RegistrationHubRegistrantsPanel)!;
    expect(propsOf(panel).poolSummary).toEqual([
      {
        division_id: "div-9",
        division_name: "Div 9",
        waiting: 2,
        free_slots: 3,
        place_by_at: null,
        href: "/o/riverside/c/summer-league/registration?tab=registrants&division_id=div-9&free_agent=1",
      },
    ]);
  });

  it("threads canEdit through — true for an editor, false for a viewer", async () => {
    h.canEdit = true;
    let tree = walkPage(await Page({ params, searchParams: Promise.resolve({ tab: "registrants" }) }));
    expect(propsOf(tree.find((e) => e.type === RegistrationHubRegistrantsPanel)!).canEdit).toBe(true);

    h.canEdit = false;
    tree = walkPage(await Page({ params, searchParams: Promise.resolve({ tab: "registrants" }) }));
    expect(propsOf(tree.find((e) => e.type === RegistrationHubRegistrantsPanel)!).canEdit).toBe(false);
  });

  // RS012 `/code-review high` finding 3 — the panel's pool banner needs a
  // real `locale` (plural() runs Intl.PluralRules against it), threaded
  // from this page's own `resolveLocale()` call (mocked to "en" above),
  // never a hardcoded default the panel invents on its own.
  it("threads the resolved locale through to the panel's locale prop", async () => {
    const tree = walkPage(await Page({ params, searchParams: Promise.resolve({ tab: "registrants" }) }));
    const panel = tree.find((e) => e.type === RegistrationHubRegistrantsPanel)!;
    expect(propsOf(panel).locale).toBe("en");
  });

  it("passes the REAL empty-state strings from the dictionary — never a hardcoded literal or a mis-keyed lookup", async () => {
    const tree = walkPage(await Page({ params, searchParams: Promise.resolve({ tab: "registrants" }) }));
    const panel = tree.find((e) => e.type === RegistrationHubRegistrantsPanel)!;
    const props = propsOf(panel);
    const dict = await getDictionary("en", "ui");
    expect(props.emptyTitle).toBe(t(dict, "reg.hub.registrants.title"));
    expect(props.emptyBody).toBe(t(dict, "reg.hub.registrants.body"));
    expect(props.emptyCtaLabel).toBe(t(dict, "reg.hub.registrants.cta"));
  });

  it("builds the empty-state cta href pointing at the Settings tab", async () => {
    const tree = walkPage(await Page({ params, searchParams: Promise.resolve({ tab: "registrants" }) }));
    const panel = tree.find((e) => e.type === RegistrationHubRegistrantsPanel)!;
    expect(propsOf(panel).emptyCtaHref).toBe("/o/riverside/c/summer-league/registration?tab=settings");
  });

  // B6 T20: Export CSV moved out of the panel into the hub's tab strip row
  // (spec §8) — the page now owns it, so the page tests own its href and gate.
  const EXPORT_HREF = "/api/v1/competitions/comp-1/registrations/export?sort=newest";
  const exportLinks = (tree: ReturnType<typeof walk>) =>
    tree.filter((e) => e.type === "a" && String(propsOf(e).href ?? "").includes("/registrations/export"));
  /** The strip's trailing slot as the page hands it to the host (B7 T24: the strip itself is the host's). */
  const stripEnd = (tree: ReturnType<typeof walk>) => walk(propsOf(hostOf(tree)!).stripEnd as ReactNode);

  it("builds the CSV export href off THIS competition's id, as ONE link in the tab strip row", async () => {
    listRegistrationsMock.mockResolvedValueOnce([{ id: "r1", group_id: "g1" }]);
    const tree = walkPage(await Page({ params, searchParams: Promise.resolve({ tab: "registrants" }) }));
    const links = exportLinks(tree);
    expect(links).toHaveLength(1);
    expect(propsOf(links[0]!).href).toBe(EXPORT_HREF);
    expect(textOf(links[0]!)).toBe(t(await getDictionary("en", "ui"), "reg.exportCsv"));
    // In the strip's trailing slot (beside the tabs), not handed down to the panel.
    expect(stripEnd(tree)).toContain(links[0]);
    expect(propsOf(tree.find((e) => e.type === RegistrationHubRegistrantsPanel)!).exportHref).toBeUndefined();
  });

  // RS005 F3 finding 2: the export href must carry the SAME filter the
  // table is actually showing, including the negative ("0") case — see
  // registrantsExportHrefFor's own comment (data.ts).
  it("carries the explicit '0' form on the export href when the table is narrowed to the negative case", async () => {
    listRegistrationsMock.mockResolvedValueOnce([{ id: "r1", group_id: "g1" }]);
    const tree = walkPage(
      await Page({
        params,
        searchParams: Promise.resolve({ tab: "registrants", free_agent: "0", consent_pending: "0" }),
      }),
    );
    expect(propsOf(exportLinks(tree)[0]!).href).toBe(
      "/api/v1/competitions/comp-1/registrations/export?sort=newest&free_agent=0&consent_pending=0",
    );
  });

  it("shows Export CSV to a viewer too (owner ruling: read-scope, never gated on canEdit)", async () => {
    let checked = 0;
    for (const canEdit of [true, false]) {
      h.canEdit = canEdit;
      listRegistrationsMock.mockResolvedValueOnce([{ id: "r1", group_id: "g1" }]);
      const tree = walkPage(await Page({ params, searchParams: Promise.resolve({ tab: "registrants" }) }));
      expect(exportLinks(tree), `canEdit=${canEdit}`).toHaveLength(1);
      checked += 1;
    }
    expect(checked).toBe(2);
  });

  it("shows NO Export CSV where the panel shows 'no one's registered yet' — nothing to export (empty case first)", async () => {
    // Default mock: zero rows, no filter.
    const tree = walkPage(await Page({ params, searchParams: Promise.resolve({ tab: "registrants" }) }));
    expect(exportLinks(tree)).toHaveLength(0);
    // The tab strip itself is still there — only its trailing slot is empty.
    expect(hostOf(tree)).toBeTruthy();
    expect(propsOf(hostOf(tree)!).stripEnd).toBeNull();
  });

  it("keeps Export CSV when a filter matched nothing — the organiser still needs the file and the bar", async () => {
    const tree = walkPage(await Page({ params, searchParams: Promise.resolve({ tab: "registrants", status: "rejected" }) }));
    expect(exportLinks(tree)).toHaveLength(1);
    expect(propsOf(exportLinks(tree)[0]!).href).toBe(
      "/api/v1/competitions/comp-1/registrations/export?status=rejected&sort=newest",
    );
  });

  // Export wraps to its own right-aligned line below md and sits on the tabs row from md up — Tailwind variants, and a
  // mistyped one compiles to nothing and moves nothing. The row's own classes are the strip's (registration-hub-tab-
  // strip.test.tsx, B7 T24); this page owns the link's. Read off the real tree, not retyped here.
  it("the Export link's classes are all real Tailwind — a typo would silently leave Export in the wrong place", async () => {
    listRegistrationsMock.mockResolvedValueOnce([{ id: "r1", group_id: "g1" }]);
    const tree = walkPage(await Page({ params, searchParams: Promise.resolve({ tab: "registrants" }) }));
    const tokens = new Set<string>();
    for (const el of stripEnd(tree)) {
      for (const tok of String(propsOf(el).className ?? "").split(/\s+/)) if (tok) tokens.add(tok);
    }
    expect(tokens.size, "premise: the slot holds classed elements").toBeGreaterThan(0);
    // `btn` / `btn-ghost` are globals.css component classes.
    for (const component of ["btn", "btn-ghost"]) tokens.delete(component);
    const compiled = await compileClasses([...tokens]);
    const dead = [...tokens].filter((c) => Object.keys(compiled.get(c) ?? {}).length === 0);
    expect(dead, `classes that compile to nothing: ${dead.join(" ")}`).toEqual([]);
    for (const must of ["max-md:ml-auto", "md:mb-1"]) expect(tokens.has(must), must).toBe(true);
  });

  it("has no Export CSV on the Settings tab", async () => {
    listRegistrationsMock.mockResolvedValueOnce([{ id: "r1", group_id: "g1" }]);
    const tree = walkPage(await Page({ params, searchParams: noTab }));
    expect(exportLinks(tree)).toHaveLength(0);
  });

  it("builds filtersAction as the tab's BARE path (no query string — a GET form submit would otherwise discard it)", async () => {
    const tree = walkPage(await Page({ params, searchParams: Promise.resolve({ tab: "registrants" }) }));
    const panel = tree.find((e) => e.type === RegistrationHubRegistrantsPanel)!;
    expect(propsOf(panel).filtersAction).toBe("/o/riverside/c/summer-league/registration");
  });

  it("resolves orgTz the SAME way the Settings tab does — org timezone, never UTC-by-coincidence", async () => {
    h.orgTimezone = "Asia/Kolkata";
    const tree = walkPage(await Page({ params, searchParams: Promise.resolve({ tab: "registrants" }) }));
    const panel = tree.find((e) => e.type === RegistrationHubRegistrantsPanel)!;
    expect(propsOf(panel).orgTz).toBe("Asia/Kolkata");
  });
});

// B7 T22 ruling (2026-11-13): FILTERS ARE NOT TABS. The Registrants tab's two hrefs back to the bare tab
// ("Clear filters" on a no-match table, and the table's own base for cart links) and the empty state's
// "Open settings" CTA each used to rebuild the address from scratch, so following one closed the
// organiser's open division settings tabs (`?open=<a>,<b>`). They carry `open` now. Read back with the
// hub's own parser (parseHubTabs), not by string compare: that is what the page that receives the link does.
describe("registration hub — clearHref / emptyCtaHref keep the open division tabs (B7 T22 ruling)", () => {
  const A = "11111111-1111-4111-8111-111111111111";
  const B = "22222222-2222-4222-8222-222222222222";
  const C = "33333333-3333-4333-8333-333333333333";
  const BASE = "/o/riverside/c/summer-league/registration";
  // B7 T24: `open` is read against the divisions the viewer may open (an editor: every non-archived one), so A, B and C
  // exist here — in the dropdown's read and in the Settings rows their tabs load from.
  beforeEach(() => {
    h.divisionOptions = [A, B, C].map((id, i) => ({ id, name: `Division ${i + 1}` }));
    h.rows = [A, B, C].map((id, i) => ({ ...SETTINGS_ROW, division_id: id, name: `Division ${i + 1}` }));
  });

  async function hrefs(searchParams: Record<string, unknown>) {
    const tree = walkPage(await Page({ params, searchParams: Promise.resolve({ tab: "registrants", ...searchParams }) }));
    const props = propsOf(tree.find((e) => e.type === RegistrationHubRegistrantsPanel)!);
    return { clearHref: String(props.clearHref), emptyCtaHref: String(props.emptyCtaHref) };
  }
  const stateOf = (href: string, openable: string[]) => {
    const q = new URL(href, "https://seazn.test").searchParams;
    return parseHubTabs({ tab: q.get("tab") ?? undefined, open: q.get("open") ?? undefined }, new Set(openable));
  };

  it("with two tabs open, the clear link lands on Registrants and the CTA on Settings — both still carrying both tabs", async () => {
    const { clearHref, emptyCtaHref } = await hrefs({ open: `${A},${B}`, status: "paid" });
    expect(clearHref.startsWith(`${BASE}?`)).toBe(true);
    expect(emptyCtaHref.startsWith(`${BASE}?`)).toBe(true);
    expect(stateOf(clearHref, [A, B])).toEqual({ active: "registrants", open: [A, B] });
    expect(stateOf(emptyCtaHref, [A, B])).toEqual({ active: "settings", open: [A, B] });
    // and the clear link still drops the filters it exists to clear
    expect(new URL(clearHref, "https://seazn.test").searchParams.has("status")).toBe(false);
  });

  it("with no open tab the two hrefs are exactly what they always were", async () => {
    const { clearHref, emptyCtaHref } = await hrefs({});
    expect(clearHref).toBe(`${BASE}?tab=registrants`);
    expect(emptyCtaHref).toBe(`${BASE}?tab=settings`);
  });

  it("the grammar's own cap and de-duplication apply: three ids carry the last two, a repeat once", async () => {
    // The raw value, as the link carries it (not through the parser, which would normalise a wrong value into a right one).
    expect(new URL((await hrefs({ open: `${A},${B},${C}` })).clearHref, "https://seazn.test").searchParams.get("open")).toBe(
      `${B},${C}`,
    );
    expect(stateOf((await hrefs({ open: `${A},${B},${A}` })).clearHref, [A, B]).open).toEqual([B, A]);
  });

  it("what is not a division id is never carried into an href: no param smuggling through `open`", async () => {
    const hostile = [`${A}&tab=settings`, "x,y", `${A},not-a-uuid`, "", `${B}%26status=paid`];
    let checked = 0;
    for (const open of hostile) {
      const { clearHref, emptyCtaHref } = await hrefs({ open });
      for (const href of [clearHref, emptyCtaHref]) {
        const q = new URL(href, "https://seazn.test").searchParams;
        expect([...q.keys()].filter((k) => k === "tab"), `${open}: one tab`).toHaveLength(1);
        expect(q.has("status"), open).toBe(false);
        for (const id of (q.get("open") ?? "").split(",").filter(Boolean)) expect(id, open).toMatch(/^[0-9a-f-]{36}$/);
        checked += 1;
      }
    }
    expect(checked).toBe(hostile.length * 2);
    expect(stateOf((await hrefs({ open: `${A},not-a-uuid` })).clearHref, [A]).open).toEqual([A]);
  });

  it("a repeated ?open=a&open=b reads as its FIRST value, like every other repeated param on this page — and never throws", async () => {
    const { clearHref, emptyCtaHref } = await hrefs({ open: [`${A},${B}`, C] });
    expect(stateOf(clearHref, [A, B, C])).toEqual({ active: "registrants", open: [A, B] });
    expect(stateOf(emptyCtaHref, [A, B, C]).open).toEqual([A, B]);
    expect((await hrefs({ open: [] })).clearHref, "an empty array is absent").toBe(`${BASE}?tab=registrants`);
  });
});

// B6 T21 review, item 7: an ARCHIVED division's id in ?division_id= must not narrow the table behind a
// filter the bar shows as unset. Same ruling as a division that does not exist: ignore it.
describe("registration hub — an archived division in ?division_id= is ignored, not silently applied (B6 T21 review)", () => {
  const LIVE = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
  const ARCHIVED = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
  const ALL = [{ id: "r1", group_id: "g1" }, { id: "r2", group_id: "g2" }, { id: "r3", group_id: "g3" }];

  beforeEach(() => {
    h.divisionOptions = [{ id: LIVE, name: "Open" }];
    // The read model narrows by whatever division it is handed, archived or not — as the real one does.
    listRegistrationsMock.mockImplementation((async (_auth: unknown, divisionId: string | null) =>
      divisionId === null ? ALL : [ALL[0]]) as never);
  });

  async function panelFor(divisionId: string | undefined) {
    const tree = walkPage(
      await Page({ params, searchParams: Promise.resolve({ tab: "registrants", ...(divisionId ? { division_id: divisionId } : {}) }) }),
    );
    return { tree, props: propsOf(tree.find((e) => e.type === RegistrationHubRegistrantsPanel)!) };
  }

  it("the table is every row, and the filters handed to the bar (and the export link) say no division", async () => {
    const { tree, props } = await panelFor(ARCHIVED);
    expect((props.rows as unknown[]).map((r) => (r as { id: string }).id)).toEqual(["r1", "r2", "r3"]);
    expect((props.filters as { divisionId: string | null }).divisionId).toBeNull();
    const exportHref = tree.find((e) => e.type === "a" && String(propsOf(e).href ?? "").includes("/registrations/export"));
    expect(exportHref, "the export link is there").toBeTruthy();
    expect(String(propsOf(exportHref!).href)).not.toContain("division_id");
    expect(listRegistrationsMock).toHaveBeenCalledTimes(2);
    const calls = listRegistrationsMock.mock.calls as unknown as unknown[][];
    expect(calls[0]![1]).toBe(ARCHIVED);
    expect(calls[1]![1]).toBeNull();
  });

  it("a division the dropdown lists still narrows — with ONE read", async () => {
    const { props } = await panelFor(LIVE);
    expect((props.rows as unknown[]).map((r) => (r as { id: string }).id)).toEqual(["r1"]);
    expect((props.filters as { divisionId: string | null }).divisionId).toBe(LIVE);
    expect(listRegistrationsMock).toHaveBeenCalledTimes(1);
  });

  it("no division filter: ONE read, nothing dropped", async () => {
    const { props } = await panelFor(undefined);
    expect((props.rows as unknown[]).length).toBe(3);
    expect(listRegistrationsMock).toHaveBeenCalledTimes(1);
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
    const tree = walkPage(
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
        sport_key: "football",
        // FU1 — the loader resolves the division's allowed kinds from these (entrantShapeOf).
        module_version: FOOTBALL.version,
        config: {},
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
    const tree = walkPage(await Page({ params, searchParams: noTab }));
    const panel = tree.find((e) => e.type === RegistrationHubSettingsPanel)!;
    const props = propsOf(panel);
    expect(props.rows).toEqual([
      {
        division_id: "div-1",
        name: "Open Singles",
        individual_only: false,
        category: null,
        age_min: 10,
        age_max: 18,
        age_cutoff_month: 9,
        age_cutoff_day: 1,
        eligibility_note: "School-registered students only",
        enabled: true,
        entrant_kind: "individual",
        // FU1 — football's own declaration (engine), not every kind: the row is then flagged as refusing "individual".
        allowed_kinds: effectiveEntrantModel(FOOTBALL.entrantModel ?? null).kinds,
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
    expect((props.rows as { allowed_kinds: string[] }[])[0]!.allowed_kinds).not.toContain("individual");
    expect((props.context as { currency: string }).currency).toBe("gbp");
  });

  // Owner ruling 2026-10-26: chess takes individual entrants only. The page is the one place a division's sport
  // becomes the row's `individual_only` flag, which the config panel reads - so it is mapped per ROW, not per page.
  it("flags a chess row individual_only and no other sport's row", async () => {
    const base = {
      category: null, age_min: null, age_max: null, age_cutoff_month: null, age_cutoff_day: null,
      eligibility_note: null, enabled: true, entrant_kind: "team", opens_at: null, closes_at: null,
      capacity: null, fee_cents: 0, approval: "auto", allow_free_agents: true, taken: 0, waitlisted: 0,
      org_currency: "gbp",
    };
    h.rows = [
      { ...base, division_id: "d-chess", name: "Blitz", sport_key: "boardgame" },
      { ...base, division_id: "d-foot", name: "Five-a-side", sport_key: "football" },
    ];
    const tree = walkPage(await Page({ params, searchParams: noTab }));
    const rows = propsOf(tree.find((e) => e.type === RegistrationHubSettingsPanel)!).rows as { division_id: string; individual_only: boolean }[];
    expect(rows.map((r) => [r.division_id, r.individual_only])).toEqual([
      ["d-chess", true],
      ["d-foot", false],
    ]);
  });

  it("resolves the org timezone from organizations.timezone", async () => {
    h.orgTimezone = "Asia/Kolkata";
    const tree = walkPage(await Page({ params, searchParams: noTab }));
    const panel = tree.find((e) => e.type === RegistrationHubSettingsPanel)!;
    expect((propsOf(panel).context as { orgTz: string }).orgTz).toBe("Asia/Kolkata");
  });

  it("falls back to UTC when the org has no timezone set — never users.timezone or the cookie", async () => {
    h.orgTimezone = null;
    const tree = walkPage(await Page({ params, searchParams: noTab }));
    const panel = tree.find((e) => e.type === RegistrationHubSettingsPanel)!;
    expect((propsOf(panel).context as { orgTz: string }).orgTz).toBe("UTC");
  });

  it("shows the register link for a public competition, built via routes.publicRegister", async () => {
    h.competitionVisibility = "public";
    const tree = walkPage(await Page({ params, searchParams: noTab }));
    const panel = tree.find((e) => e.type === RegistrationHubSettingsPanel)!;
    const context = propsOf(panel).context as { showRegisterLink: boolean; registerHref: string };
    expect(context.showRegisterLink).toBe(true);
    expect(context.registerHref).toBe("/live/riverside/summer-league/register");
  });

  it("hides the register link for a private competition", async () => {
    h.competitionVisibility = "private";
    const tree = walkPage(await Page({ params, searchParams: noTab }));
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
    const tree = walkPage(await Page({ params, searchParams: noTab }));
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
    const tree = walkPage(await Page({ params, searchParams: Promise.resolve({ tab: "registrants" }) }));
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
    const tree = walkPage(await Page({ params, searchParams: noTab }));
    expect(configOf(tree)!.cardUnsupportedCurrency).toBe("sek");
    expect(h.currencyQueries).toBe(1);
    expect(h.unsupportedQueries).toBe(1);
  });
});

describe("registration hub — config panel context (RS004 W3c)", () => {
  it("passes orgSlug through to the division settings pages (the host's config)", async () => {
    const tree = walkPage(await Page({ params, searchParams: noTab }));
    expect(configOf(tree)!.orgSlug).toBe("riverside");
  });

  it("passes feePercentFor's resolved value as feePercentPct", async () => {
    feePercentForMock.mockResolvedValue(5);
    const tree = walkPage(await Page({ params, searchParams: noTab }));
    expect(configOf(tree)!.feePercentPct).toBe(5);
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
    const tree = walkPage(await Page({ params, searchParams: noTab }));
    expect(configOf(tree)!.cardUnsupportedCurrency).toBe("jpy");
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
    const tree = walkPage(await Page({ params, searchParams: noTab }));
    expect(configOf(tree)!.cardUnsupportedCurrency).toBeNull();
  });

  // Same "finding 6" shape as org currency: a Settings-tab competition with
  // ZERO divisions has no row to read org_stripe_unsupported_currency off,
  // so it must resolve through the dedicated fallback query rather than
  // silently defaulting to "supported" (null) regardless of the real value.
  it("resolves cardUnsupportedCurrency independently of rows[0] on a zero-row settings tab", async () => {
    h.rows = [];
    h.orgStripeUnsupportedCurrency = "jpy";
    const tree = walkPage(await Page({ params, searchParams: noTab }));
    expect(configOf(tree)!.cardUnsupportedCurrency).toBe("jpy");
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

// B7 T24 — the division settings tabs. The address is the tab state; this page parses it against the divisions the viewer
// may open (an editor: every non-archived division; a viewer: none) and hands it to the host, with the settings of the
// open divisions loaded on whichever tab is on screen. The host's own behaviour (dialogs, history) is the e2e's.
describe("registration hub — division settings tabs (B7 T24)", () => {
  const A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
  const B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
  const GONE = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
  beforeEach(() => {
    h.rows = [
      { ...SETTINGS_ROW, division_id: A, name: "Blitz", sport_key: "boardgame", waitlisted: 4, age_cutoff_month: 9, age_cutoff_day: 1 },
      { ...SETTINGS_ROW, division_id: B, name: "Five-a-side", waitlisted: 0 },
    ];
    h.divisionOptions = [
      { id: A, name: "Blitz" },
      { id: B, name: "Five-a-side" },
    ];
  });
  const hostProps = (tree: ReturnType<typeof walk>) => propsOf(hostOf(tree)!);
  const page = async (searchParams: Record<string, unknown>) => walkPage(await Page({ params, searchParams: Promise.resolve(searchParams) }));

  it("the host sits at ONE place in the tree on every tab — the property that keeps an edit across a tab switch", async () => {
    let checked = 0;
    for (const searchParams of [{}, { tab: "registrants", open: A }, { tab: `division:${A}`, open: A }]) {
      const tree = await page(searchParams);
      const main = tree.find((e) => e.type === "main")!;
      const kids = (propsOf(main).children as unknown[]).filter(Boolean) as { type: unknown }[];
      expect(kids.map((k) => k.type), JSON.stringify(searchParams)).toEqual(["h1", RegistrationHubTabsHost]);
      checked += 1;
    }
    expect(checked).toBe(3);
  });

  it("Settings: `open` is read against the Settings rows — an id that is not one is dropped; every row is openable", async () => {
    const tree = await page({ open: `${A},${GONE}` });
    expect(hostProps(tree).state).toEqual({ active: "settings", open: [A] });
    expect(hostProps(tree).openable).toEqual([
      { id: A, name: "Blitz" },
      { id: B, name: "Five-a-side" },
    ]);
    // The Settings list is still the section on screen.
    expect(tree.some((e) => e.type === RegistrationHubSettingsPanel)).toBe(true);
  });

  it("a division tab on screen: no section panel under it, and its settings page built from its Settings row", async () => {
    const tree = await page({ tab: `division:${A}`, open: `${B},${A}` });
    expect(hostProps(tree).state).toEqual({ active: { division: A }, open: [B, A] });
    expect(tree.some((e) => e.type === RegistrationHubSettingsPanel)).toBe(false);
    expect(tree.some((e) => e.type === RegistrationHubRegistrantsPanel)).toBe(false);
    expect(listRegistrationsMock).not.toHaveBeenCalled();
    expect(h.divisionRowsQueries).toBe(1);
    // In the address's order. A chess row (boardgame) is individual-only; its waitlist count rides along.
    expect(hostProps(tree).divisions).toEqual([
      {
        division: {
          division_id: B,
          name: "Five-a-side",
          individual_only: false,
          allowed_kinds: effectiveEntrantModel(FOOTBALL.entrantModel ?? null).kinds,
          category: null,
          age_min: null,
          age_max: null,
          age_cutoff_month: null,
          age_cutoff_day: null,
          eligibility_note: null,
        },
        waitlistedCount: 0,
      },
      expect.objectContaining({
        division: expect.objectContaining({ division_id: A, name: "Blitz", individual_only: true, age_cutoff_month: 9, age_cutoff_day: 1 }),
        waitlistedCount: 4,
      }),
    ]);
    expect(configOf(tree)).toEqual({
      orgTz: "UTC",
      orgSlug: "riverside",
      currency: "usd",
      feePercentPct: 8,
      cardUnsupportedCurrency: null,
    });
  });

  it("Registrants with tabs open: their settings load too (Settings rows + fee cut, once each), against the dropdown's divisions", async () => {
    feePercentForMock.mockResolvedValue(6);
    const tree = await page({ tab: "registrants", open: `${A},${GONE}` });
    expect(hostProps(tree).state).toEqual({ active: "registrants", open: [A] });
    expect(h.divisionRowsQueries).toBe(1);
    expect(feePercentForMock).toHaveBeenCalledTimes(1);
    expect((hostProps(tree).divisions as { division: { division_id: string } }[]).map((d) => d.division.division_id)).toEqual([A]);
    expect(configOf(tree)!.feePercentPct).toBe(6);
    expect(tree.some((e) => e.type === RegistrationHubRegistrantsPanel)).toBe(true);
  });

  it("empty case first: Registrants with no tab open reads nothing extra and hands the host no config", async () => {
    const tree = await page({ tab: "registrants" });
    expect(hostProps(tree).state).toEqual({ active: "registrants", open: [] });
    expect(hostProps(tree).divisions).toEqual([]);
    expect(configOf(tree)).toBeNull();
    expect(h.divisionRowsQueries).toBe(0);
    expect(feePercentForMock).not.toHaveBeenCalled();
  });

  it("a viewer gets no division tab on any tab — `open` is dropped and nothing extra is read", async () => {
    h.canEdit = false;
    let checked = 0;
    for (const searchParams of [{ open: A }, { tab: "registrants", open: A }, { tab: `division:${A}`, open: A }]) {
      h.divisionRowsQueries = 0;
      feePercentForMock.mockClear();
      const tree = await page(searchParams);
      const state = hostProps(tree).state as { active: unknown; open: string[] };
      expect(state.open, JSON.stringify(searchParams)).toEqual([]);
      expect(state.active).not.toEqual({ division: A });
      expect(hostProps(tree).openable).toEqual([]);
      expect(hostProps(tree).divisions).toEqual([]);
      if (searchParams.tab === "registrants") {
        expect(h.divisionRowsQueries).toBe(0);
        expect(feePercentForMock).not.toHaveBeenCalled();
      }
      checked += 1;
    }
    expect(checked).toBe(3);
  });

  it("a stale division tab (archived since: not a Settings row) falls back to Settings and loads no page for it", async () => {
    const tree = await page({ tab: `division:${GONE}`, open: GONE });
    expect(hostProps(tree).state).toEqual({ active: "settings", open: [] });
    expect(hostProps(tree).divisions).toEqual([]);
    expect(tree.some((e) => e.type === RegistrationHubSettingsPanel)).toBe(true);
  });

  it("the solo-pool links on Registrants keep the open tabs too (filters are not tabs)", async () => {
    h.poolWaitingRows = [{ division_id: B, waiting: 2 }];
    h.poolSlotRows = [{ division_id: B, free_slots: 3 }];
    h.poolMetaRows = [{ division_id: B, division_name: "Five-a-side", place_by_at: null, closes_at: null }];
    const tree = await page({ tab: "registrants", open: A });
    const [row] = propsOf(tree.find((e) => e.type === RegistrationHubRegistrantsPanel)!).poolSummary as { href: string }[];
    const q = new URL(row!.href, "https://seazn.test").searchParams;
    expect(q.get("open")).toBe(A);
    expect(q.get("division_id")).toBe(B);
    expect(q.get("free_agent")).toBe("1");
    expect(q.get("tab")).toBe("registrants");
  });
});

// Walk-fix F5 (walkthrough R17): with Connect unable to charge, the organiser's Registration > Settings read "Open now" on a card
// division the public could not enter, and warned of nothing. The Settings tab now carries a banner that says card divisions are
// closed to new registrations, with the way to fix it (Settings → Connect). Decided by the shared rule
// (lib/registration-card-payments.ts `cardDivisionsWaitOnConnect`), fed from the Settings query's own rows.
describe("registration hub — Settings warns when card divisions wait on payment setup (walk-fix F5)", () => {
  const CARD = { ...SETTINGS_ROW, payment_method: "stripe", fee_cents: 1500 };
  const bannerOf = async () =>
    walkPage(await Page({ params, searchParams: noTab })).find((e) => propsOf(e)["data-testid"] === "reg-hub-card-payments");

  it("no rows: no banner (empty case first)", async () => {
    h.rows = [];
    expect(await bannerOf()).toBeUndefined();
  });

  it("an enabled card division with a fee, Connect unable to charge: the banner, its sentence and the link to Connect", async () => {
    h.rows = [{ ...CARD, org_charges_enabled: false }];
    const banner = await bannerOf();
    expect(banner).toBeTruthy();
    const dict = await getDictionary("en", "ui");
    expect(textOf(banner!)).toContain(t(dict, "reg.hub.cardPayments.banner"));
    const link = walk(banner!).find((e) => propsOf(e).href !== undefined);
    expect(propsOf(link!).href).toBe("/o/riverside/settings/connect");
    expect(textOf(link!)).toBe(t(dict, "reg.hub.cardPayments.cta"));
  });

  it("negative pairs: Connect able to charge, a free, an offline or a disabled division -> no banner (counted)", async () => {
    let checked = 0;
    for (const row of [
      { ...CARD, org_charges_enabled: true },
      { ...CARD, fee_cents: 0, org_charges_enabled: false },
      { ...CARD, payment_method: "offline", org_charges_enabled: false },
      { ...CARD, enabled: false, org_charges_enabled: false },
    ]) {
      h.rows = [row];
      expect(await bannerOf(), JSON.stringify(row)).toBeUndefined();
      checked++;
    }
    expect(checked).toBe(4);
  });
});
