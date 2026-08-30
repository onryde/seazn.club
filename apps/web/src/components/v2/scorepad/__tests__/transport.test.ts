// The real ScoringTransport over fetch (S10/#419 W8, network-wiring pass).
// Every case injects its own fetch double — no server is ever contacted.
import { describe, expect, it } from "vitest";
import type { AppendEventBody } from "../pipeline";
import {
  authHeadersFor,
  deviceLinkTransport,
  isPermanentRefusal,
  sessionTransport,
  type FixtureStateResult,
} from "../transport";

interface Call {
  url: string;
  init: RequestInit | undefined;
}

/** A hand-rolled Response stub — only `.ok`/`.status`/`.json()` are ever read
 *  by transport.ts, so this avoids depending on the platform's real Response
 *  constructor being available under vitest's node environment. */
function fakeResponse(status: number, body: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  } as Response;
}

function fakeFetch(handler: (url: string, init: RequestInit | undefined) => Response | Promise<Response>) {
  const calls: Call[] = [];
  const fn = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, init });
    return handler(url, init);
  }) as typeof fetch;
  return { fn, calls };
}

const BODY: AppendEventBody = {
  expected_seq: 5,
  type: "core.start",
  payload: {},
  idempotency_key: "idem-1",
};

describe("authHeadersFor", () => {
  it("session carries no Authorization header", () => {
    expect(authHeadersFor({ kind: "session" })).toEqual({});
  });

  it("device_link carries Bearer <token> verbatim, dl_ prefix included", () => {
    expect(authHeadersFor({ kind: "device_link", token: "dl_xyz" })).toEqual({
      Authorization: "Bearer dl_xyz",
    });
  });
});

describe("appendEvent — outcome mapping", () => {
  it("a 201 success maps to the ok outcome", async () => {
    const success = { seq: 8, state_summary: { headline: "1-0" }, outcome: null, status: "in_play" };
    const { fn, calls } = fakeFetch(() => fakeResponse(201, { ok: true, data: success }));
    const outcome = await sessionTransport({ fetchFn: fn }).appendEvent("fx-1", BODY);
    expect(outcome).toEqual({ kind: "ok", data: success });
    expect(calls[0]!.url).toBe("/api/v1/fixtures/fx-1/events");
    expect(calls[0]!.init?.method).toBe("POST");
    expect(calls[0]!.init?.body).toBe(JSON.stringify(BODY));
  });

  it("a 409 body's current_seq maps onto the conflict outcome's currentSeq", async () => {
    const { fn } = fakeFetch(() =>
      fakeResponse(409, { ok: false, error: { code: "SEQ_CONFLICT", message: "seq conflict", current_seq: 42 } }),
    );
    const outcome = await sessionTransport({ fetchFn: fn }).appendEvent("fx-1", BODY);
    expect(outcome).toEqual({ kind: "conflict", currentSeq: 42, message: "seq conflict" });
  });

  it("a 409 body with NO current_seq maps to currentSeq: null, not a guess", async () => {
    const { fn } = fakeFetch(() =>
      fakeResponse(409, { ok: false, error: { code: "SEQ_CONFLICT", message: "seq conflict, no body seq" } }),
    );
    const outcome = await sessionTransport({ fetchFn: fn }).appendEvent("fx-1", BODY);
    expect(outcome).toEqual({ kind: "conflict", currentSeq: null, message: "seq conflict, no body seq" });
  });

  it("a 422 maps to a permanent rejection carrying the engine's code and message", async () => {
    const { fn } = fakeFetch(() =>
      fakeResponse(422, { ok: false, error: { code: "INVALID_EVENT", message: "unknown entrant" } }),
    );
    const outcome = await sessionTransport({ fetchFn: fn }).appendEvent("fx-1", BODY);
    expect(outcome).toEqual({ kind: "rejected", code: "INVALID_EVENT", message: "unknown entrant" });
  });

  it("a thrown fetch (offline) maps to a retryable network failure", async () => {
    const { fn } = fakeFetch(() => {
      throw new Error("fetch failed");
    });
    const outcome = await sessionTransport({ fetchFn: fn }).appendEvent("fx-1", BODY);
    expect(outcome).toEqual({ kind: "network-error", message: "fetch failed" });
  });

  it("a 5xx maps to a retryable network failure, not a permanent rejection", async () => {
    const { fn } = fakeFetch(() => fakeResponse(500, { ok: false, error: { code: "INTERNAL", message: "server error" } }));
    const outcome = await sessionTransport({ fetchFn: fn }).appendEvent("fx-1", BODY);
    expect(outcome).toEqual({ kind: "network-error", message: "server error" });
  });

  // -------------------------------------------------------------------------
  // R6 FIX PASS 3, GAP 1 — the ship-blocker's own root cause lived in this
  // function. Before the fix the branch above read "a non-409/422 failure
  // (e.g. 500)" and it meant it: 400, 401, 402, 403 and 404 all landed in
  // `network-error`, which use-pad-pipeline.ts answers by KEEPING the
  // optimistic fold and setting `offline`. A band-1 402 therefore rendered a
  // penalty as recorded — ribbon, activity row, "ON ICE 3V5" strength chip
  // and a ticking countdown — with the ledger holding only `core.start`.
  //
  // The end-to-end proof (pad surfaces, real hook, real kernel) is
  // `v3/__tests__/refused-write.test.ts`; this block pins the classification
  // itself, status by status, because that is the seam that got it wrong.
  // -------------------------------------------------------------------------
  const PERMANENT: readonly { status: number; code: string; why: string }[] = [
    { status: 400, code: "VALIDATION", why: "the route schema refused the payload" },
    { status: 401, code: "UNAUTHENTICATED", why: "the session expired mid-match" },
    { status: 402, code: "PAYMENT_REQUIRED", why: "THE SHIP-BLOCKER: the band-1 entitlement gate" },
    { status: 403, code: "FORBIDDEN", why: "a device link revoked mid-match" },
    { status: 404, code: "NOT_FOUND", why: "the fixture was deleted under the pad" },
    { status: 422, code: "INVALID_EVENT", why: "the engine's own semantic refusal (unchanged)" },
  ];

  for (const { status, code, why } of PERMANENT) {
    it(`a ${status} (${why}) is a PERMANENT rejection, never a retryable network failure`, async () => {
      const { fn } = fakeFetch(() => fakeResponse(status, { ok: false, error: { code, message: "no" } }));
      const outcome = await sessionTransport({ fetchFn: fn }).appendEvent("fx-1", BODY);
      expect(outcome).toEqual({ kind: "rejected", code, message: "no" });
    });
  }

  // The other direction, and it matters just as much: a fix that made every
  // non-2xx permanent would throw away a scorer's tap on flaky courtside
  // wifi, which is worse than the bug it replaced.
  const TRANSIENT: readonly { status: number; why: string }[] = [
    { status: 408, why: "request timeout — the server explicitly invites a retry" },
    { status: 429, why: "rate limited — retry after backoff is the correct response" },
    { status: 500, why: "server fault" },
    { status: 502, why: "bad gateway, e.g. a proxy between pad and server" },
    { status: 503, why: "deploying" },
    { status: 504, why: "gateway timeout" },
  ];

  for (const { status, why } of TRANSIENT) {
    it(`a ${status} (${why}) stays transient, so the queue keeps the action`, async () => {
      const { fn } = fakeFetch(() => fakeResponse(status, { ok: false, error: { code: "X", message: "later" } }));
      const outcome = await sessionTransport({ fetchFn: fn }).appendEvent("fx-1", BODY);
      expect(outcome).toEqual({ kind: "network-error", message: "later" });
    });
  }

  it("409 is neither — it renegotiates", async () => {
    expect(isPermanentRefusal(409)).toBe(false);
  });

  it("a refusal with no parseable body still carries a code, so the pad can speak", async () => {
    const { fn } = fakeFetch(
      () => ({ ok: false, status: 402, json: async () => { throw new Error("not json"); } }) as unknown as Response,
    );
    const outcome = await sessionTransport({ fetchFn: fn }).appendEvent("fx-1", BODY);
    expect(outcome).toEqual({ kind: "rejected", code: "UNKNOWN", message: "request failed (402)" });
  });
});

// The predicate on its own, swept rather than sampled — one lucky status is
// how a classification bug survives a suite (this one did, for four waves).
describe("isPermanentRefusal — the whole status space", () => {
  it("every 4xx except 409/408/429 is permanent", () => {
    for (let s = 400; s < 500; s++) {
      const expected = s !== 409 && s !== 408 && s !== 429;
      expect(isPermanentRefusal(s), `status ${s}`).toBe(expected);
    }
  });

  it("no 2xx, 3xx or 5xx is ever permanent", () => {
    for (const s of [200, 201, 204, 301, 302, 304, 500, 502, 503, 504, 599]) {
      expect(isPermanentRefusal(s), `status ${s}`).toBe(false);
    }
  });
});

describe("listEventsSince / getLastSeq / fetchState", () => {
  it("listEventsSince returns the ledger rows, KEEPING id/recorded_at (S12/#421) and voids_event_id (R5), and hits the right URL", async () => {
    // The server's real EventOut carries more columns than LedgerSlotEvent
    // once declared (types.ts). id/recorded_at were dropped until S12/#421
    // widened the schema to keep them; voids_event_id was dropped until R5 —
    // see the MUTATION TARGET below for the defect that dropping it caused.
    const rawRow = {
      id: "e1",
      seq: 5,
      type: "core.start",
      payload: {},
      recorded_at: "t",
      recorded_by: "u1",
      voids_event_id: null,
      device_link_id: null,
    };
    const { fn, calls } = fakeFetch(() => fakeResponse(200, { ok: true, data: [rawRow] }));
    const result = await sessionTransport({ fetchFn: fn }).listEventsSince("fx-1", 4);
    expect(result).toEqual([
      {
        id: "e1",
        seq: 5,
        type: "core.start",
        payload: {},
        recorded_at: "t",
        recorded_by: "u1",
        device_link_id: null,
        voids_event_id: null,
      },
    ]);
    expect(calls[0]!.url).toBe("/api/v1/fixtures/fx-1/events?since_seq=4");
  });

  it("MUTATION TARGET (R5): a POLLED core.void keeps the id of the row it undoes — dropping it left every foreign undo targeting nothing", async () => {
    // The pad only ever builds a void's `voids` itself for a void IT
    // submitted (use-pad-pipeline.ts `pendingToEnvelope`). Every OTHER void —
    // the fixture console's "Undo last", a second referee's undo on the same
    // fixture — reaches this device through exactly this read, and the engine
    // rejects a core.void naming nothing precisely as it rejects one naming
    // an unknown id, freezing the pad behind a rejection banner.
    const voidRow = {
      id: "v1",
      seq: 9,
      type: "core.void",
      payload: {},
      recorded_at: "t",
      recorded_by: "u2",
      voids_event_id: "e-target-1",
      device_link_id: null,
    };
    const { fn } = fakeFetch(() => fakeResponse(200, { ok: true, data: [voidRow] }));
    const result = await sessionTransport({ fetchFn: fn }).listEventsSince("fx-1", 8);
    expect(result[0]!.voids_event_id).toBe("e-target-1");
  });

  it("normalises an OMITTED voids_event_id key to a real null — the common case, since only a core.void ever carries one", async () => {
    const rawRow = { id: "e1", seq: 5, type: "core.score", payload: {}, recorded_at: "t", recorded_by: "u1", device_link_id: null };
    const { fn } = fakeFetch(() => fakeResponse(200, { ok: true, data: [rawRow] }));
    const result = await sessionTransport({ fetchFn: fn }).listEventsSince("fx-1", 4);
    expect(result[0]!.voids_event_id).toBeNull();
  });

  it("MUTATION TARGET (S12/#421): a row missing id or recorded_at rejects with a parse error — both are NOT NULL server columns, never guessed", async () => {
    const missingId = { seq: 5, type: "core.start", payload: {}, recorded_at: "t", recorded_by: "u1", device_link_id: null };
    const { fn: fnA } = fakeFetch(() => fakeResponse(200, { ok: true, data: [missingId] }));
    await expect(sessionTransport({ fetchFn: fnA }).listEventsSince("fx-1", 0)).rejects.toThrow();

    const missingRecordedAt = { id: "e1", seq: 5, type: "core.start", payload: {}, recorded_by: "u1", device_link_id: null };
    const { fn: fnB } = fakeFetch(() => fakeResponse(200, { ok: true, data: [missingRecordedAt] }));
    await expect(sessionTransport({ fetchFn: fnB }).listEventsSince("fx-1", 0)).rejects.toThrow();
  });

  it("listEventsSince rejects on a thrown fetch — 'may reject', per ScoringTransport's own contract", async () => {
    const { fn } = fakeFetch(() => {
      throw new Error("offline");
    });
    await expect(sessionTransport({ fetchFn: fn }).listEventsSince("fx-1", 0)).rejects.toThrow();
  });

  it("listEventsSince rejects on a non-2xx response, surfacing the server's message", async () => {
    const { fn } = fakeFetch(() => fakeResponse(404, { ok: false, error: { code: "NOT_FOUND", message: "fixture not found" } }));
    await expect(sessionTransport({ fetchFn: fn }).listEventsSince("fx-1", 0)).rejects.toThrow("fixture not found");
  });

  it("getLastSeq narrows GET /state to last_seq", async () => {
    const { fn, calls } = fakeFetch(() =>
      fakeResponse(200, { ok: true, data: { status: "in_play", last_seq: 9, state: {}, summary: {}, outcome: null } }),
    );
    const lastSeq = await sessionTransport({ fetchFn: fn }).getLastSeq("fx-1");
    expect(lastSeq).toBe(9);
    expect(calls[0]!.url).toBe("/api/v1/fixtures/fx-1/state");
  });

  it("getLastSeq rejects on failure", async () => {
    const { fn } = fakeFetch(() => fakeResponse(500, { ok: false, error: { code: "INTERNAL", message: "boom" } }));
    await expect(sessionTransport({ fetchFn: fn }).getLastSeq("fx-1")).rejects.toThrow("boom");
  });

  it("fetchState returns the FULL fixture state payload (not just last_seq)", async () => {
    const payload: FixtureStateResult = {
      status: "in_play",
      last_seq: 9,
      state: { phase: "live" },
      summary: { headline: "1-0" },
      outcome: null,
    };
    const { fn } = fakeFetch(() => fakeResponse(200, { ok: true, data: payload }));
    const result = await sessionTransport({ fetchFn: fn }).fetchState("fx-1");
    expect(result).toEqual(payload);
  });

  it("fetchState rejects on failure", async () => {
    const { fn } = fakeFetch(() => fakeResponse(500, { ok: false, error: { code: "INTERNAL", message: "boom" } }));
    await expect(sessionTransport({ fetchFn: fn }).fetchState("fx-1")).rejects.toThrow("boom");
  });
});

describe("listEventsSince — ledger row validation at the wire boundary (review finding 1)", () => {
  it("normalises an OMITTED recorded_by/device_link_id key to a real null, not undefined", async () => {
    const rawRow = { id: "e1", seq: 5, type: "core.note", payload: { text: "x" }, recorded_at: "t" }; // both identity keys OMITTED entirely
    const { fn } = fakeFetch(() => fakeResponse(200, { ok: true, data: [rawRow] }));
    const result = await sessionTransport({ fetchFn: fn }).listEventsSince("fx-1", 4);
    expect(result).toEqual([
      {
        id: "e1",
        seq: 5,
        type: "core.note",
        payload: { text: "x" },
        recorded_at: "t",
        recorded_by: null,
        device_link_id: null,
        voids_event_id: null,
      },
    ]);
    // A GENUINE own key holding `null`, not merely absent from the object —
    // pipeline.ts's resolveConflict compares this against OwnIdentity's own
    // `string | null` fields, so "present and null" vs "absent" must not
    // matter downstream either way.
    expect(Object.prototype.hasOwnProperty.call(result[0], "recorded_by")).toBe(true);
    expect(Object.prototype.hasOwnProperty.call(result[0], "device_link_id")).toBe(true);
  });

  it("an explicit null on both identity fields round-trips as null (not just the omitted-key case)", async () => {
    const rawRow = { id: "e1", seq: 5, type: "core.note", payload: {}, recorded_at: "t", recorded_by: null, device_link_id: null };
    const { fn } = fakeFetch(() => fakeResponse(200, { ok: true, data: [rawRow] }));
    const result = await sessionTransport({ fetchFn: fn }).listEventsSince("fx-1", 4);
    expect(result).toEqual([
      {
        id: "e1",
        seq: 5,
        type: "core.note",
        payload: {},
        recorded_at: "t",
        recorded_by: null,
        device_link_id: null,
        voids_event_id: null,
      },
    ]);
  });

  it("a malformed row (wrong TYPE, not just a missing optional key) rejects with a parse error, not a silent pass-through", async () => {
    const badRow = { id: "e1", seq: "not-a-number", type: "core.note", payload: {}, recorded_at: "t", recorded_by: null, device_link_id: null };
    const { fn } = fakeFetch(() => fakeResponse(200, { ok: true, data: [badRow] }));
    await expect(sessionTransport({ fetchFn: fn }).listEventsSince("fx-1", 0)).rejects.toThrow();
  });

  it("a non-array body rejects with a parse error", async () => {
    const { fn } = fakeFetch(() => fakeResponse(200, { ok: true, data: { not: "an array" } }));
    await expect(sessionTransport({ fetchFn: fn }).listEventsSince("fx-1", 0)).rejects.toThrow();
  });
});

describe("sessionTransport vs deviceLinkTransport — table-driven request-shape parity", () => {
  it.each([
    { label: "session", make: (fetchFn: typeof fetch) => sessionTransport({ fetchFn }), authHeader: undefined },
    {
      label: "device_link",
      make: (fetchFn: typeof fetch) => deviceLinkTransport("dl_abc123", { fetchFn }),
      authHeader: "Bearer dl_abc123",
    },
  ])("$label: identical method/url/body; headers differ ONLY by Authorization", async ({ make, authHeader }) => {
    const { fn, calls } = fakeFetch(() =>
      fakeResponse(201, { ok: true, data: { seq: 1, state_summary: null, outcome: null, status: "in_play" } }),
    );
    await make(fn).appendEvent("fx-1", BODY);

    expect(calls).toHaveLength(1);
    const call = calls[0]!;
    expect(call.url).toBe("/api/v1/fixtures/fx-1/events");
    expect(call.init?.method).toBe("POST");
    expect(call.init?.body).toBe(JSON.stringify(BODY));
    const headers = call.init?.headers as Record<string, string>;
    expect(headers["Content-Type"]).toBe("application/json");
    expect(headers["Authorization"]).toBe(authHeader);
    const otherKeys = Object.keys(headers).filter((k) => k !== "Authorization");
    expect(otherKeys).toEqual(["Content-Type"]);
  });
});
