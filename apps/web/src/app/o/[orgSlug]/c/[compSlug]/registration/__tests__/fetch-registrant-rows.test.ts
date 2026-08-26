// RS005 W2a — the Registrants tab's data layer: `parseRegistrantsQuery`
// (pure — raw `?status=`/`?kind=`/... to a sanitized filter set, no DB) and
// `fetchRegistrantRows` (delegates to `listRegistrations`, RS005 W1a/W1b).
// `listRegistrations` itself is MOCKED here — its own SQL correctness
// (filter narrowing, roster_cap, waitlist_position, sort…) is already
// proven by registration-list-read.test.ts (usecases/__tests__, not this
// wave's file set); this file's job is proving THIS wave's wiring: which
// arguments reach it, and what happens when it refuses one of them.
// fetch-registrant-rows-db.test.ts is the real-Postgres twin (division_id
// narrowing/cross-competition retry against a real database,
// fetchDivisionOptions' own SQL) — it cannot share this file, because
// vi.mock("@/server/usecases/registrations") is hoisted for the WHOLE file
// and would just as happily swallow a real call.
import { describe, expect, it, vi, beforeEach } from "vitest";
import { HttpError } from "@/lib/errors";
import type { AuthCtx } from "@/server/api-v1/auth";

const listRegistrationsMock = vi.hoisted(() => vi.fn());

vi.mock("@/server/usecases/registrations", () => ({
  listRegistrations: listRegistrationsMock,
}));

import { fetchRegistrantRows, parseRegistrantsQuery } from "../data";

const AUTH: AuthCtx = { orgId: "org-1", via: "session", userId: "user-1", role: "owner", keyId: null };
const COMPETITION_ID = "comp-1";
const DIVISION_ID = "11111111-2222-3333-4444-555555555555";

beforeEach(() => {
  listRegistrationsMock.mockReset();
  listRegistrationsMock.mockResolvedValue([]);
});

describe("parseRegistrantsQuery — pure, no DB", () => {
  // RS005 F3 finding 2: freeAgent/consentPending are tri-state
  // (true/false/null), not a plain boolean — an ABSENT query param must
  // stay distinguishable from an EXPLICIT `free_agent=0`/`consent_pending=0`,
  // the same true/false/undefined split registration-list-query.ts's own
  // `queryBool` already draws for the API route, just with `null` standing
  // in for `undefined` to match this file's own "unset" convention
  // (status/divisionId/kind, below) rather than introducing a second one.
  it("defaults every filter to unset (null) on an empty query, sort defaulting to newest", () => {
    expect(parseRegistrantsQuery({})).toEqual({
      status: null,
      divisionId: null,
      kind: null,
      freeAgent: null,
      consentPending: null,
      text: "",
      sort: "newest",
    });
  });

  it("accepts every real RegistrationStatus value (single source: the zod schema's own .options)", () => {
    for (const s of ["pending", "paid", "confirmed", "waitlisted", "withdrawn", "expired", "rejected"]) {
      expect(parseRegistrantsQuery({ status: s }).status).toBe(s);
    }
  });

  it("drops an unrecognised status rather than throwing", () => {
    expect(parseRegistrantsQuery({ status: "applesauce" }).status).toBeNull();
  });

  it("accepts every real EntrantKind value", () => {
    for (const k of ["team", "individual", "pair"]) {
      expect(parseRegistrantsQuery({ kind: k }).kind).toBe(k);
    }
  });

  it("drops an unrecognised kind", () => {
    expect(parseRegistrantsQuery({ kind: "clan" }).kind).toBeNull();
  });

  it("drops a division_id that is not UUID-shaped, never handing it to the DB", () => {
    // A non-UUID string reaching `where id = $1` on a uuid column is a raw
    // Postgres syntax error, not the graceful HttpError(404) the
    // cross-competition retry expects — this gate is what keeps that error
    // class out of fetchRegistrantRows entirely. Same regex
    // app/admin/fixtures/page.tsx already uses for the same reason.
    expect(parseRegistrantsQuery({ division_id: "not-a-uuid" }).divisionId).toBeNull();
    expect(parseRegistrantsQuery({ division_id: "11111111-2222-3333-4444" }).divisionId).toBeNull();
  });

  it("keeps a UUID-shaped division_id", () => {
    expect(parseRegistrantsQuery({ division_id: DIVISION_ID }).divisionId).toBe(DIVISION_ID);
  });

  it("free_agent: '1' -> true, '0' -> explicit false, anything else (including 'true') or absent -> null/unset (RS005 F3 finding 2)", () => {
    expect(parseRegistrantsQuery({ free_agent: "1" }).freeAgent).toBe(true);
    expect(parseRegistrantsQuery({ free_agent: "0" }).freeAgent).toBe(false);
    expect(parseRegistrantsQuery({ free_agent: "true" }).freeAgent).toBeNull();
    expect(parseRegistrantsQuery({}).freeAgent).toBeNull();
  });

  it("consent_pending: same tri-state split — '1' true, '0' explicit false, else null", () => {
    expect(parseRegistrantsQuery({ consent_pending: "1" }).consentPending).toBe(true);
    expect(parseRegistrantsQuery({ consent_pending: "0" }).consentPending).toBe(false);
    expect(parseRegistrantsQuery({ consent_pending: "bogus" }).consentPending).toBeNull();
    expect(parseRegistrantsQuery({}).consentPending).toBeNull();
  });

  it("trims q, and an all-whitespace q is the same as absent", () => {
    expect(parseRegistrantsQuery({ q: "  Alex  " }).text).toBe("Alex");
    expect(parseRegistrantsQuery({ q: "   " }).text).toBe("");
    expect(parseRegistrantsQuery({}).text).toBe("");
  });

  it("sort: 'oldest' is honoured, anything else (including garbage) is this tab's own default 'newest'", () => {
    expect(parseRegistrantsQuery({ sort: "oldest" }).sort).toBe("oldest");
    expect(parseRegistrantsQuery({ sort: "newest" }).sort).toBe("newest");
    expect(parseRegistrantsQuery({ sort: "bogus" }).sort).toBe("newest");
    expect(parseRegistrantsQuery({}).sort).toBe("newest");
  });
});

// RS005 F3 finding 1: Next hands a REPEATED `?x=a&x=b` query param over as
// `string[]`, not `string` (Next's own docs — `/shop?a=1&a=2` ->
// `{ a: ['1', '2'] }`), and never dedupes. page.tsx's `searchParams` is
// typed `Promise<any>` by Next's own generated PageProps, so the cast into
// this file's `RegistrantsRawQuery` shape hid that from tsc entirely —
// `raw.q?.trim()` threw `TypeError: raw.q?.trim is not a function` for a
// real `GET …?q=a&q=b`, and `error.tsx` swallowed the whole hub (title, tab
// strip, panel), not just the Registrants panel. Every field this parser
// reads is exercised here, not just `q`.
//
// Choice made: FIRST VALUE WINS, not "ignore the field entirely" — the same
// choice `URLSearchParams.get()` already makes for the API route's identical
// parsing job (registration-list-query.ts's `sp.get(...)`), and a dupe is
// far more likely a bookmarked/hand-edited URL carrying one stale copy
// alongside the current one than a deliberate "no value" signal.
describe("parseRegistrantsQuery — array-valued params never throw (RS005 F3 finding 1)", () => {
  it("never throws for any parsed field, and renders (not just 'doesn't throw differently')", () => {
    expect(() =>
      parseRegistrantsQuery({
        status: ["paid", "confirmed"],
        division_id: [DIVISION_ID, "11111111-2222-3333-4444-000000000000"],
        kind: ["team", "pair"],
        free_agent: ["1", "0"],
        consent_pending: ["0", "1"],
        q: ["Alex", "Sam"],
        sort: ["oldest", "newest"],
      }),
    ).not.toThrow();
  });

  it("first value wins for every field", () => {
    const result = parseRegistrantsQuery({
      status: ["paid", "confirmed"],
      division_id: [DIVISION_ID, "11111111-2222-3333-4444-000000000000"],
      kind: ["team", "pair"],
      free_agent: ["1", "0"],
      consent_pending: ["0", "1"],
      q: ["  Alex  ", "Sam"],
      sort: ["oldest", "newest"],
    });
    expect(result.status).toBe("paid");
    expect(result.divisionId).toBe(DIVISION_ID);
    expect(result.kind).toBe("team");
    expect(result.freeAgent).toBe(true);
    expect(result.consentPending).toBe(false);
    expect(result.text).toBe("Alex");
    expect(result.sort).toBe("oldest");
  });

  it("an empty array behaves like absent, not a crash", () => {
    expect(parseRegistrantsQuery({ q: [] }).text).toBe("");
    expect(parseRegistrantsQuery({ status: [] }).status).toBeNull();
  });
});

describe("fetchRegistrantRows — wiring to listRegistrations", () => {
  it("always sends sort explicitly, defaulting to newest — task 4's ruling, NOT listRegistrations' own 'oldest' default", async () => {
    await fetchRegistrantRows(AUTH, COMPETITION_ID, {});
    expect(listRegistrationsMock).toHaveBeenCalledWith(AUTH, null, null, {
      competition_id: COMPETITION_ID,
      sort: "newest",
    });
  });

  it("threads status and a valid division_id through positionally", async () => {
    await fetchRegistrantRows(AUTH, COMPETITION_ID, { status: "paid", division_id: DIVISION_ID });
    expect(listRegistrationsMock).toHaveBeenCalledWith(AUTH, DIVISION_ID, "paid", {
      competition_id: COMPETITION_ID,
      sort: "newest",
    });
  });

  it("composes kind + free_agent + consent_pending + q into ONE filters object", async () => {
    await fetchRegistrantRows(AUTH, COMPETITION_ID, {
      kind: "team",
      free_agent: "1",
      consent_pending: "1",
      q: "Riverside",
    });
    expect(listRegistrationsMock).toHaveBeenCalledWith(AUTH, null, null, {
      competition_id: COMPETITION_ID,
      sort: "newest",
      kind: "team",
      free_agent: true,
      consent_pending: true,
      text: "Riverside",
    });
  });

  it("a bogus status renders unfiltered rather than throwing", async () => {
    await expect(fetchRegistrantRows(AUTH, COMPETITION_ID, { status: "not-a-status" })).resolves.toBeTruthy();
    expect(listRegistrationsMock).toHaveBeenCalledWith(AUTH, null, null, {
      competition_id: COMPETITION_ID,
      sort: "newest",
    });
  });

  it("returns the SANITIZED filters alongside the rows, for the form's pre-fill", async () => {
    listRegistrationsMock.mockResolvedValueOnce([{ id: "r1" }]);
    const result = await fetchRegistrantRows(AUTH, COMPETITION_ID, { status: "bogus", sort: "oldest" });
    expect(result.rows).toEqual([{ id: "r1" }]);
    expect(result.filters).toEqual({
      status: null,
      divisionId: null,
      kind: null,
      freeAgent: null,
      consentPending: null,
      text: "",
      sort: "oldest",
    });
  });

  // RS005 F3 finding 2: registration-list-query.ts's own `queryBool` reads
  // `!== undefined` (not truthiness) so an explicit `free_agent=0`/
  // `consent_pending=0` reaches `listRegistrations` as `false`, and
  // `listRegistrations` honours that false case with its own `not exists
  // (...)` arm. Before this fix, `toListFilters`'s `if (filters.freeAgent)`
  // guard only ever SET the key on `true` — an explicit `0` collapsed to
  // "omit the filter entirely", so `?consent_pending=0` rendered every row
  // while the API (given the identical query string) returned only the
  // narrowed set. This proves the page's own wiring now matches.
  it("free_agent=0 / consent_pending=0 reach listRegistrations as an explicit false, not omitted (RS005 F3 finding 2)", async () => {
    await fetchRegistrantRows(AUTH, COMPETITION_ID, { free_agent: "0", consent_pending: "0" });
    expect(listRegistrationsMock).toHaveBeenCalledWith(AUTH, null, null, {
      competition_id: COMPETITION_ID,
      sort: "newest",
      free_agent: false,
      consent_pending: false,
    });
  });

  describe("a division_id that does not exist, or belongs to another competition", () => {
    it("retries WITHOUT the division filter instead of throwing (listRegistrations' own 404)", async () => {
      listRegistrationsMock
        .mockRejectedValueOnce(new HttpError(404, "division not found"))
        .mockResolvedValueOnce([{ id: "r1" }]);
      const result = await fetchRegistrantRows(AUTH, COMPETITION_ID, { division_id: DIVISION_ID });
      expect(result.rows).toEqual([{ id: "r1" }]);
      expect(result.filters.divisionId).toBeNull();
      expect(listRegistrationsMock).toHaveBeenCalledTimes(2);
      expect(listRegistrationsMock).toHaveBeenNthCalledWith(1, AUTH, DIVISION_ID, null, {
        competition_id: COMPETITION_ID,
        sort: "newest",
      });
      expect(listRegistrationsMock).toHaveBeenNthCalledWith(2, AUTH, null, null, {
        competition_id: COMPETITION_ID,
        sort: "newest",
      });
    });

    it("does not loop: a second 404 on the retry itself propagates rather than being swallowed", async () => {
      listRegistrationsMock.mockRejectedValue(new HttpError(404, "division not found"));
      await expect(fetchRegistrantRows(AUTH, COMPETITION_ID, { division_id: DIVISION_ID })).rejects.toThrow();
      expect(listRegistrationsMock).toHaveBeenCalledTimes(2);
    });
  });

  it("does not swallow a non-404 error", async () => {
    listRegistrationsMock.mockRejectedValueOnce(new HttpError(500, "boom"));
    await expect(fetchRegistrantRows(AUTH, COMPETITION_ID, {})).rejects.toThrow("boom");
  });

  it("does not swallow a 404 that arrives without a division_id filter — the retry guard is scoped to that case only", async () => {
    listRegistrationsMock.mockRejectedValueOnce(new HttpError(404, "competition not found"));
    await expect(fetchRegistrantRows(AUTH, COMPETITION_ID, {})).rejects.toThrow("competition not found");
    expect(listRegistrationsMock).toHaveBeenCalledTimes(1);
  });
});
