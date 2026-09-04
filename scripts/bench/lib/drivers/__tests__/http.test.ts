// Unit coverage for the registration HTTP driver (B03r task 4). DB-free:
// `fetch` is mocked to record every call the driver makes, so each test
// asserts the EXACT path literal and body the driver sends — B01's own
// http.test.ts precedent (../../__tests__/http.test.ts), widened to record
// calls rather than just script one response.
import { afterEach, describe, expect, it } from "vitest";
import { BenchHttpError, newSession } from "../../http.ts";
import { PaidEntryNeedsBrowser, httpCaptain, httpOrganiser, httpPlayer } from "../http.ts";
import type {
  ConsentInput,
  JoinEntry,
  RegistrationBlockConfig,
  RegistrationDivisionTarget,
  RegistrationEntry,
} from "../types.ts";

interface RecordedCall {
  url: string;
  method: string;
  body: unknown;
}

const originalFetch = global.fetch;
afterEach(() => {
  global.fetch = originalFetch;
});

/** Records every call `raw()` (../../http.ts) makes and answers them in
 *  order from `responses`, repeating the last one once the list runs out —
 *  most tests here only care about the first call, but `configureRegistration()`
 *  fires two requests in parallel (Promise.all), so both need a scripted
 *  response. */
function mockFetch(responses: Array<{ status: number; body: unknown }>): RecordedCall[] {
  const calls: RecordedCall[] = [];
  let i = 0;
  global.fetch = (async (input: unknown, init?: RequestInit) => {
    const method = init?.method ?? "GET";
    const body = init?.body !== undefined ? JSON.parse(init.body as string) : undefined;
    calls.push({ url: String(input), method, body });
    const resp = responses[Math.min(i, responses.length - 1)];
    i += 1;
    return {
      status: resp.status,
      headers: { getSetCookie: () => [] },
      json: async () => resp.body,
    } as unknown as Response;
  }) as unknown as typeof fetch;
  return calls;
}

const BASE = "http://x";

const division: RegistrationDivisionTarget = {
  orgSlug: "acme",
  competitionSlug: "spring-open",
  divisionId: "div-1",
};

// Recorded fixture: a straightforward individual entry, registering the
// contact themselves (RS006's common case — singles).
const soloEntry: RegistrationEntry = {
  contact: { name: "Ada Lovelace", email: "ada@example.com" },
  privacyConsent: true,
  mediaConsent: false,
  entrantKind: "individual",
  players: [{ fullName: "Ada Lovelace" }],
  registeringSelf: true,
};

describe("httpCaptain().enter()", () => {
  it("POSTs to the exact public submit path, with the recorded fixture's body keys", async () => {
    const calls = mockFetch([
      { status: 200, body: { ok: true, data: { entries: [{ registration_id: "r1", status: "confirmed" }] } } },
    ]);
    const captain = httpCaptain(BASE, newSession());
    await captain.enter(soloEntry, division);

    expect(calls).toHaveLength(1);
    expect(calls[0].method).toBe("POST");
    expect(calls[0].url).toBe("http://x/api/v1/public/orgs/acme/competitions/spring-open/register");

    const body = calls[0].body as Record<string, unknown>;
    expect(Object.keys(body).sort()).toEqual(["contact", "entries", "media_consent", "privacy_consent", "website"].sort());
    expect(body.privacy_consent).toBe(true);
    expect(body.media_consent).toBe(false);
    expect(body.website).toBe("");
    expect(body.contact).toEqual({
      name: "Ada Lovelace",
      email: "ada@example.com",
      dob: null,
      gender: null,
      guardian_name: null,
      guardian_consent: false,
    });

    const wireEntries = body.entries as Array<Record<string, unknown>>;
    expect(wireEntries).toHaveLength(1);
    expect(wireEntries[0].division_id).toBe("div-1");
    expect(wireEntries[0].entrant_kind).toBe("individual");
    expect(wireEntries[0].registering_self).toBe(true);
    // Left unset deliberately (types.ts doc comment): the server's own
    // superRefine defaults a single-player individual entry's self index to
    // 0 — sending nothing here proves the driver relies on that, not on
    // arithmetic duplicated in the bench.
    expect(wireEntries[0].self_player_index).toBeUndefined();
    expect(wireEntries[0].players).toEqual([
      { full_name: "Ada Lovelace", dob: null, gender: null, email: null, squad_number: null, is_captain: undefined },
    ]);
  });

  describe("outcome mapping — derived from the product's own submit-time status vocabulary", () => {
    it("maps wire status 'confirmed' (auto-approval, no fee due) to 'approved'", async () => {
      mockFetch([{ status: 200, body: { ok: true, data: { entries: [{ registration_id: "r1", status: "confirmed" }] } } }]);
      const outcome = await httpCaptain(BASE, newSession()).enter(soloEntry, division);
      expect(outcome).toEqual({ status: "approved", ref: "r1" });
    });

    it("maps wire status 'pending' (manual approval, or a fee still due) to 'pending'", async () => {
      mockFetch([{ status: 200, body: { ok: true, data: { entries: [{ registration_id: "r2", status: "pending" }] } } }]);
      const outcome = await httpCaptain(BASE, newSession()).enter(soloEntry, division);
      expect(outcome).toEqual({ status: "pending", ref: "r2" });
    });

    it("maps wire status 'waitlisted' (capacity exceeded) to 'waitlisted'", async () => {
      mockFetch([{ status: 200, body: { ok: true, data: { entries: [{ registration_id: "r3", status: "waitlisted" }] } } }]);
      const outcome = await httpCaptain(BASE, newSession()).enter(soloEntry, division);
      expect(outcome).toEqual({ status: "waitlisted", ref: "r3" });
    });

    it("maps a 422 with error.code 'ELIGIBILITY' to 'rejected_eligibility' with no registration ref", async () => {
      mockFetch([{ status: 422, body: { ok: false, error: { code: "ELIGIBILITY", message: "Too old for this division" } } }]);
      const outcome = await httpCaptain(BASE, newSession()).enter(soloEntry, division);
      expect(outcome).toEqual({ status: "rejected_eligibility", ref: "" });
    });

    // B03r live-crash fix: a 4xx `enter()` doesn't have a specific mapping
    // for is now a funnel-visible "unexpected_error" OUTCOME, never a thrown
    // exception — a throw here would escape `runRegistrationDivision`'s
    // `Promise.all` and abort every OTHER captain's entry in the division.
    // These two used to assert a throw; that was the bug's OWN behaviour,
    // not a property worth keeping.
    it("maps a 422 whose code is unrelated to eligibility to an 'unexpected_error' outcome, not a throw — funnel-visible, not fatal", async () => {
      const body = { ok: false, error: { code: "DIVISION_CLOSED", message: "closed" } };
      mockFetch([{ status: 422, body }]);
      const outcome = await httpCaptain(BASE, newSession()).enter(soloEntry, division);
      expect(outcome.status).toBe("unexpected_error");
      expect(outcome.ref).toBe("");
      expect(outcome.errorDetail).toEqual({ httpStatus: 422, body });
    });

    it("a 422 whose code merely CONTAINS the substring ELIGIBILITY maps to 'unexpected_error', never 'rejected_eligibility' (exact match, not a substring one)", async () => {
      mockFetch([{ status: 422, body: { ok: false, error: { code: "SOME_ELIGIBILITY_ADJACENT_RULE", message: "x" } } }]);
      const outcome = await httpCaptain(BASE, newSession()).enter(soloEntry, division);
      expect(outcome.status).toBe("unexpected_error");
    });

    it("maps a 400 (no error.code at all) to 'unexpected_error' too — the widening is 'any 4xx', not '422 only'", async () => {
      const body = { ok: false, error: { message: "Bad request" } };
      mockFetch([{ status: 400, body }]);
      const outcome = await httpCaptain(BASE, newSession()).enter(soloEntry, division);
      expect(outcome.status).toBe("unexpected_error");
      expect(outcome.errorDetail).toEqual({ httpStatus: 400, body });
    });

    it("STILL rethrows a 5xx — a hard error, never a funnel outcome", async () => {
      mockFetch([{ status: 500, body: { ok: false, error: { message: "boom" } } }]);
      await expect(httpCaptain(BASE, newSession()).enter(soloEntry, division)).rejects.toBeInstanceOf(BenchHttpError);
    });
  });
});

describe("httpCaptain().pay()", () => {
  it("throws PaidEntryNeedsBrowser without making any HTTP call — unsupported on the HTTP driver", async () => {
    const calls = mockFetch([]);
    await expect(httpCaptain(BASE, newSession()).pay({ registrationId: "r1" })).rejects.toBeInstanceOf(
      PaidEntryNeedsBrowser,
    );
    expect(calls).toHaveLength(0);
  });
});

describe("httpOrganiser().configureRegistration()", () => {
  const block: RegistrationBlockConfig = {
    category: "mixed",
    ageMin: 12,
    ageMax: 18,
    entrantKind: "team",
    feeCents: 500,
    approval: "manual",
    capacity: 16,
  };

  it("issues BOTH the PATCH (division restriction fields) and the PUT (registration settings)", async () => {
    const calls = mockFetch([
      { status: 200, body: { ok: true, data: {} } },
      { status: 200, body: { ok: true, data: {} } },
    ]);
    await httpOrganiser(BASE, newSession()).configureRegistration("div-1", block);

    expect(calls).toHaveLength(2);
    const patch = calls.find((c) => c.method === "PATCH");
    const put = calls.find((c) => c.method === "PUT");
    expect(patch).toBeDefined();
    expect(put).toBeDefined();
    expect(patch!.url).toBe("http://x/api/v1/divisions/div-1");
    expect(put!.url).toBe("http://x/api/v1/divisions/div-1/registration-settings");

    expect(patch!.body).toEqual({ category: "mixed", age_min: 12, age_max: 18 });
    expect(put!.body).toMatchObject({
      enabled: true,
      entrant_kind: "team",
      fee_cents: 500,
      approval: "manual",
      capacity: 16,
    });
  });
});

describe("httpOrganiser().act()", () => {
  it("approve: POSTs to the exact path with no body", async () => {
    const calls = mockFetch([{ status: 200, body: { ok: true, data: {} } }]);
    await httpOrganiser(BASE, newSession()).act({ action: "approve", registrationId: "r1" });
    expect(calls).toHaveLength(1);
    expect(calls[0].method).toBe("POST");
    expect(calls[0].url).toBe("http://x/api/v1/registrations/r1/approve");
    expect(calls[0].body).toBeUndefined();
  });

  it("reject: POSTs to the exact path with no body", async () => {
    const calls = mockFetch([{ status: 200, body: { ok: true, data: {} } }]);
    await httpOrganiser(BASE, newSession()).act({ action: "reject", registrationId: "r2" });
    expect(calls).toHaveLength(1);
    expect(calls[0].method).toBe("POST");
    expect(calls[0].url).toBe("http://x/api/v1/registrations/r2/reject");
    expect(calls[0].body).toBeUndefined();
  });

  it("promote: POSTs with {registration_id} naming the SAME target in both the URL and the body", async () => {
    const calls = mockFetch([{ status: 200, body: { ok: true, data: {} } }]);
    await httpOrganiser(BASE, newSession()).act({ action: "promote", registrationId: "r3" });
    expect(calls).toHaveLength(1);
    expect(calls[0].method).toBe("POST");
    expect(calls[0].url).toBe("http://x/api/v1/registrations/r3/promote");
    expect(calls[0].body).toEqual({ registration_id: "r3" });
  });

  it("assign_free_agent: POSTs to /assign with {target_registration_id}", async () => {
    const calls = mockFetch([{ status: 200, body: { ok: true, data: {} } }]);
    await httpOrganiser(BASE, newSession()).act({
      action: "assign_free_agent",
      registrationId: "r4",
      targetRegistrationId: "team-9",
    });
    expect(calls).toHaveLength(1);
    expect(calls[0].method).toBe("POST");
    expect(calls[0].url).toBe("http://x/api/v1/registrations/r4/assign");
    expect(calls[0].body).toEqual({ target_registration_id: "team-9" });
  });

  it("assign_free_agent without a targetRegistrationId throws before making any request", async () => {
    const calls = mockFetch([]);
    await expect(
      httpOrganiser(BASE, newSession()).act({ action: "assign_free_agent", registrationId: "r5" }),
    ).rejects.toThrow();
    expect(calls).toHaveLength(0);
  });
});

describe("httpPlayer().join()", () => {
  const joinEntry: JoinEntry = {
    orgSlug: "acme",
    competitionSlug: "spring-open",
    player: { fullName: "Grace Hopper" },
  };
  const consent: ConsentInput = { privacyConsent: true };

  it("POSTs to the exact join path with join_code carried in the BODY, not the query string", async () => {
    // FP found while pinning this task: join-form.tsx's own `joinSubmitUrl`
    // carries no query string at all — `join_code` travels in
    // `buildJoinBody`'s JSON body, matching `PublicJoinRequest.join_code`
    // (a body field). The route's GET preview is the only one that reads
    // `join_code` from `searchParams`. A driver sending it as `?join_code=`
    // on the POST would 404/400 against a live server while staying green
    // here forever if this test asserted the query string instead.
    const calls = mockFetch([{ status: 200, body: { ok: true, data: {} } }]);
    await httpPlayer(BASE, newSession()).join(joinEntry, "JOIN123", consent);

    expect(calls).toHaveLength(1);
    expect(calls[0].method).toBe("POST");
    expect(calls[0].url).toBe("http://x/api/v1/public/orgs/acme/competitions/spring-open/register/join");
    const body = calls[0].body as Record<string, unknown>;
    expect(body.join_code).toBe("JOIN123");
    expect(body.player).toEqual({
      full_name: "Grace Hopper",
      dob: null,
      gender: null,
      email: null,
      squad_number: null,
      is_captain: undefined,
    });
    expect(body.privacy_consent).toBe(true);
    expect(body.player_id).toBeUndefined();
  });

  it("includes player_id when claiming an existing captain-entered slot", async () => {
    const calls = mockFetch([{ status: 200, body: { ok: true, data: {} } }]);
    await httpPlayer(BASE, newSession()).join({ ...joinEntry, playerId: "slot-1" }, "JOIN123", consent);
    const body = calls[0].body as Record<string, unknown>;
    expect(body.player_id).toBe("slot-1");
  });
});
