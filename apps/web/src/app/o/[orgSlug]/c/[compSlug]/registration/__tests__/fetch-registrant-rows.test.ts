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
  it("defaults every filter to 'off' on an empty query, sort defaulting to newest", () => {
    expect(parseRegistrantsQuery({})).toEqual({
      status: null,
      divisionId: null,
      kind: null,
      freeAgent: false,
      consentPending: false,
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

  it("free_agent=1 turns the filter on; any other value (including '0' and 'true') leaves it off", () => {
    expect(parseRegistrantsQuery({ free_agent: "1" }).freeAgent).toBe(true);
    expect(parseRegistrantsQuery({ free_agent: "0" }).freeAgent).toBe(false);
    expect(parseRegistrantsQuery({ free_agent: "true" }).freeAgent).toBe(false);
    expect(parseRegistrantsQuery({}).freeAgent).toBe(false);
  });

  it("consent_pending=1 turns the filter on; any other value leaves it off", () => {
    expect(parseRegistrantsQuery({ consent_pending: "1" }).consentPending).toBe(true);
    expect(parseRegistrantsQuery({ consent_pending: "0" }).consentPending).toBe(false);
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
      freeAgent: false,
      consentPending: false,
      text: "",
      sort: "oldest",
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
