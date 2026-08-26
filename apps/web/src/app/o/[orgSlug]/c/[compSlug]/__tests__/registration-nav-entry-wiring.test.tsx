// RS004 W2 — the competition overview's "Registration" nav entry: live
// counts (open divisions, total registered) computed from the query the page
// ALREADY runs (`listDivisionCardStats`, card-stats.ts) — no second query, no
// client fetch, no N+1 per division — and shown only to a role that may edit.
//
// RS004 W2b review finding 1: `registered`/`awaiting_confirmation` replaced
// `entrants` as the pill's source (an `entrants` row only exists once an
// entry is materialised — see card-stats-registration-counts.test.ts for the
// real-Postgres proof that the QUERY counts correctly). This file proves the
// separate, narrower thing: that the PAGE sums the right fields into the
// right badge props. `registered` is deliberately set DIFFERENT from
// `entrants` per division below — if the page regressed to reading
// `entrants` again, these assertions would catch it.
//
// Mock recipe copied from the proven
// competition-header-trial-promise.test.tsx (same page, same shape) plus the
// two mocks this test actually varies: `listDivisions`/`listDivisionCardStats`
// carry real per-division data so the counts are computed from something.
import { describe, expect, it, vi, beforeEach } from "vitest";
import { propsOf, walk } from "@/components/__tests__/_hook-harness";

const h = vi.hoisted(() => {
  // Two open-for-registration divisions, one closed. `registered` sums to
  // 17 (9 + 7 + 1) — NOT 14 (the old `entrants` sum, 9 + 5 + 0) — and
  // `awaiting_confirmation` sums to 3 (0 + 2 + 1): d-2 carries 2 entries not
  // yet confirmed (e.g. manual-approval pending/paid) on top of its 5
  // materialised entrants, and d-3 carries 1 waitlisted entry despite being
  // CLOSED (registration_open: false) and having zero entrants — exactly
  // the "closed division with real registrations that read as zero" bug
  // finding 1 reported.
  const defaultStats = () =>
    new Map<string, Record<string, unknown>>([
      [
        "d-1",
        {
          division_id: "d-1",
          entrants: 9,
          registered: 9,
          awaiting_confirmation: 0,
          capacity: null,
          stage_kinds: [],
          registration_open: true,
          played: 0,
          total: 0,
          next: null,
        },
      ],
      [
        "d-2",
        {
          division_id: "d-2",
          entrants: 5,
          registered: 7,
          awaiting_confirmation: 2,
          capacity: null,
          stage_kinds: [],
          registration_open: true,
          played: 0,
          total: 0,
          next: null,
        },
      ],
      [
        "d-3",
        {
          division_id: "d-3",
          entrants: 0,
          registered: 1,
          awaiting_confirmation: 1,
          capacity: null,
          stage_kinds: [],
          registration_open: false,
          played: 0,
          total: 0,
          next: null,
        },
      ],
    ]);
  return { canEdit: true, stats: defaultStats(), defaultStats };
});

vi.mock("@/server/page-auth", () => ({
  requireCompetitionPage: async () => ({
    auth: { orgId: "org-1" },
    org: { id: "org-1", name: "Riverside CC", slug: "riverside" },
    competition: { id: "comp-1", name: "Summer League", slug: "summer-league" },
    canEdit: h.canEdit,
  }),
}));

vi.mock("@/server/usecases/competitions", () => ({
  getCompetition: async () => ({
    id: "comp-1",
    org_id: "org-1",
    name: "Summer League",
    slug: "summer-league",
    description: null,
    starts_on: null,
    ends_on: null,
    visibility: "private",
    branding: null,
    status: "live",
    created_at: new Date().toISOString(),
    discoverable: false,
    discovery: null,
    frozen: false,
  }),
}));

// Two open-for-registration divisions, one closed — 9 + 5 = 14 registered
// entrants total, matching the badges asserted below.
vi.mock("@/server/usecases/divisions", () => ({
  listDivisions: async () => [
    { id: "d-1", name: "Open", slug: "open", sport_key: "generic", archived_at: null },
    { id: "d-2", name: "U18", slug: "u18", sport_key: "generic", archived_at: null },
    { id: "d-3", name: "Masters", slug: "masters", sport_key: "generic", archived_at: null },
  ],
}));

vi.mock("@/server/usecases/card-stats", () => ({
  listDivisionCardStats: async () => h.stats,
  nextLine: () => null,
  formatLabel: () => null,
}));

vi.mock("@/server/public-site/data", () => ({ resolveLogoUrl: () => null }));
vi.mock("@/lib/currency-server", () => ({ preferredCurrency: async () => "usd" }));
vi.mock("@/lib/resolve-locale", () => ({ resolveLocale: async () => "en" }));
vi.mock("@/lib/billing", () => ({
  checkoutTrialDays: (sub?: { trial_used_at: string | null }) => (sub?.trial_used_at ? 0 : 14),
}));
vi.mock("@/lib/db", () => ({
  sql: (strings: TemplateStringsArray | unknown[]) => {
    if (!Array.isArray(strings) || !("raw" in strings)) return { __fragment: strings };
    return Promise.resolve([{ trial_used_at: null }]);
  },
}));

import Page from "../page";
import { RegistrationHubNavEntry } from "@/components/registration-hub-nav-entry";

const params = Promise.resolve({ orgSlug: "riverside", compSlug: "summer-league" });

/** `propsOf` is deliberately `Record<string, unknown>` for the find/filter
 *  idiom; this narrows it back to the component's real prop types so the
 *  assertions below index `details` rather than an `unknown`. */
type NavProps = Parameters<typeof RegistrationHubNavEntry>[0];
const navProps = (el: Parameters<typeof propsOf>[0]): NavProps =>
  propsOf(el) as unknown as NavProps;

beforeEach(() => {
  h.canEdit = true;
  h.stats = h.defaultStats();
});

describe("competition overview — the Registration nav entry", () => {
  it("shows live counts computed from the existing card-stats query: 2 open divisions of 3, 17 registered, 3 awaiting confirmation", async () => {
    const tree = walk(await Page({ params }));
    const entry = tree.find((e) => e.type === RegistrationHubNavEntry);
    expect(entry).toBeTruthy();
    const props = navProps(entry!);
    // 9 + 7 + 1 = 17 (`registered`) — NOT 14 (the old `entrants` sum,
    // 9 + 5 + 0). A regression back to reading `.entrants` would fail this.
    // It is the ONE number on the button (2026-08-25).
    expect(props.count).toBe("17");
    expect(props.details[0]).toContain("2");
    // 17 - 3 = 14 confirmed, DERIVED rather than counted again: awaiting is a
    // strict subset of registered, so the two tooltip lines must add back up
    // to the number on the button.
    expect(props.details[1]).toContain("14");
    // 0 + 2 + 1 = 3, including d-3's 1 waitlisted entry despite that
    // division being CLOSED and having zero entrants.
    expect(props.details[2]).toContain("3");
    expect(props.awaiting).toBe(true);
    // The accessible name carries the whole breakdown — the tooltip that
    // shows it is aria-hidden, so this is the only path to it.
    for (const line of props.details) expect(props.ariaLabel).toContain(line);
    // …and it CONTAINS THE VISIBLE NUMBER (WCAG 2.5.3, Label in Name). The
    // breakdown alone does not: with 3 awaiting, its figures are 14 and 3
    // while the button prints 17, so a speech-input user asking for the
    // number they can see would match nothing. Asserted as a leading segment
    // rather than a bare `toContain`, which "14 confirmed" would satisfy by
    // accident once the total happens to appear inside another line.
    expect(props.ariaLabel).toContain(`${props.count} `);
    expect(props.ariaLabel.indexOf(props.count)).toBeLessThan(
      props.ariaLabel.indexOf(props.details[0]!),
    );
    expect(props.href).toBe("/o/riverside/c/summer-league/registration");
  });

  it("omits the awaiting-confirmation line entirely (not a literal '0') once nothing needs it", async () => {
    h.stats = new Map(
      [...h.defaultStats()].map(([id, s]) => [id, { ...s, awaiting_confirmation: 0 }]),
    );
    const tree = walk(await Page({ params }));
    const entry = tree.find((e) => e.type === RegistrationHubNavEntry);
    const props = navProps(entry!);
    expect(props.awaiting).toBe(false);
    expect(props.details).toHaveLength(2);
    expect(props.details.join(" ")).not.toContain("awaiting");
    // …and with nothing outstanding every registrant is confirmed, so the
    // tooltip's confirmed line equals the button's number.
    expect(props.details[1]).toContain(props.count);
  });

  // RS005, replacing "hides the entry for a role that cannot edit". RS004
  // gated this on canEdit to match the hub page's own `if (!canEdit)
  // notFound()`. The owner reversed that on 2026-08-25 — a viewer gets the
  // hub read-only — and this entry was then the last thing hiding the tab
  // from the audience the ruling was FOR: readable by URL, unreachable by
  // clicking. A scorer never reaches this page at all (requireCompetitionPage
  // 404s them), so canEdit is the wrong question here entirely.
  it("shows the entry to a viewer — canEdit does not gate it any more", async () => {
    h.canEdit = false;
    const tree = walk(await Page({ params }));
    expect(tree.some((e) => e.type === RegistrationHubNavEntry)).toBe(true);
  });

  it("points a viewer at the same hub URL as an editor", async () => {
    h.canEdit = false;
    const viewerHref = navProps(walk(await Page({ params })).find((e) => e.type === RegistrationHubNavEntry)!).href;
    h.canEdit = true;
    const editorHref = navProps(walk(await Page({ params })).find((e) => e.type === RegistrationHubNavEntry)!).href;
    expect(viewerHref).toBe(editorHref);
  });
});
