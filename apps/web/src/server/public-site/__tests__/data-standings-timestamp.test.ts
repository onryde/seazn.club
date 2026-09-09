// Final-review fix F1 — `public_standings_v.updated_at` is a `timestamptz`
// (V218), and `db.ts`'s date-type override only patches OID 1082 (`date`):
// postgres.js's default handler still parses OID 1184 (`timestamptz`) into a
// JS `Date` (`mergeUserTypes` merges by OID). `PublicStandings.updated_at` is
// declared `string`, and `competition-hub.ts:591` forwards this field
// unchanged into `TableView.updatedAt` (`z.string()`), so a `Date` here fails
// `CompetitionHubDoc.safeParse` — measured as `tables.0.updatedAt → invalid_type,
// expected "string", received "Date"`.
//
// `competition-hub.test.ts` mocks `./data`'s `getPublicDivision` at the module
// boundary, so it cannot see this bug however its standings double is typed —
// the mock replaces `getPublicDivision` wholesale, and neither its double nor
// `competition-hub.ts` (a deliberate blind passthrough — the fix belongs at
// the SOURCE, not the call site) can be reverted here and reddened. THIS file
// closes that blind spot: it mocks `@/lib/db`'s `sql` directly (the same
// pattern `hub-cache-poisoned-entry.test.ts` uses for a different module) and
// runs the REAL, unmocked `getPublicDivision`, so a reverted normalisation
// reds here without a database — `competition-hub-db.test.ts:184`/`:244` are
// the DB-gated proof of the same fact, unreachable in this environment
// (no DATABASE_URL).
//
// Every `sql` call `getPublicDivision` makes on this path is answered in the
// exact sequential order the function issues them (verified by reading
// `data.ts` top to bottom): org, competition, divisions, liveNow, stages,
// pools, rawFixtures, standings, rawEntrants, tz. Fixtures and entrants are
// seeded empty so `withCourtVenueNames`/`maskPublicEntrantNames` short-circuit
// before issuing their own (unmocked-here) `sql(array)` IN-clause calls.
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("next/cache", () => ({
  unstable_cache: (fn: (...args: unknown[]) => unknown) => fn,
  revalidateTag: vi.fn(),
}));

const sql = vi.hoisted(() => vi.fn());
vi.mock("@/lib/db", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/db")>()),
  sql,
}));

import { getPublicDivision } from "../data";

const ORG_ROW = {
  id: "org-1",
  name: "Riverside SC",
  slug: "riverside",
  about: null,
  default_locale: "en",
  card_payments: false,
  branded: false,
  branding: {},
  logo_url: null,
  logo_storage_path: null,
};

const COMPETITION_ROW = {
  id: "comp-1",
  org_id: "org-1",
  name: "Autumn Cup",
  slug: "autumn-cup",
  description: null,
  starts_on: null,
  ends_on: null,
  branding: {},
  status: "live",
  visibility: "public",
};

const DIVISION_ROW = {
  id: "div-1",
  competition_id: "comp-1",
  name: "Open",
  slug: "open",
  description: null,
  sport_key: "football",
  variant_key: "11-a-side",
  status: "active",
  module_version: "1.0.0",
  tiebreakers: null,
  sport_name: "Football",
  entrant_count: 0,
  youth: false,
  player_name_display: null,
  config: {},
};

/** Seeds all ten `sql` calls `getPublicDivision` makes on this path, in the
 *  order it issues them. `updated_at` is a real JS `Date` — exactly what
 *  postgres.js hands back for a `timestamptz` column absent the OID 1082-only
 *  override, and exactly what the review measured. */
function seedSqlCalls(updatedAt: unknown) {
  sql.mockReset();
  sql
    .mockResolvedValueOnce([ORG_ROW]) // loadOrg
    .mockResolvedValueOnce([COMPETITION_ROW]) // getPublicCompetition: competition
    .mockResolvedValueOnce([DIVISION_ROW]) // getPublicCompetition: divisions
    .mockResolvedValueOnce([]) // getPublicCompetition: liveNow
    .mockResolvedValueOnce([]) // stages
    .mockResolvedValueOnce([]) // pools
    .mockResolvedValueOnce([]) // rawFixtures (empty ⇒ withCourtVenueNames short-circuits)
    .mockResolvedValueOnce([{ stage_id: "st1", pool_id: null, rows: [], updated_at: updatedAt }]) // standings
    .mockResolvedValueOnce([]) // rawEntrants (empty ⇒ maskPublicEntrantNames short-circuits)
    .mockResolvedValueOnce([{ tz: "UTC" }]); // tz
}

beforeEach(() => {
  sql.mockReset();
});

describe("getPublicDivision — standings.updated_at survives the real timestamptz shape", () => {
  it("a Date from the driver comes back as an ISO string, never a Date", async () => {
    seedSqlCalls(new Date("2026-09-04T16:00:00.000Z"));

    const result = await getPublicDivision("riverside", "autumn-cup", "open");

    expect(result).not.toBeNull();
    const row = result!.standings[0]!;
    expect(typeof row.updated_at, "updated_at must be a string, not a Date").toBe("string");
    expect(row.updated_at).toBe("2026-09-04T16:00:00.000Z");
  });

  it("a plain ISO string (the declared shape) passes through unchanged", async () => {
    seedSqlCalls("2026-09-04T16:00:00.000Z");

    const result = await getPublicDivision("riverside", "autumn-cup", "open");

    expect(result!.standings[0]!.updated_at).toBe("2026-09-04T16:00:00.000Z");
  });
});
