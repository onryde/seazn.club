// The real ScoringTransport over fetch (S10/#419 W8, network-wiring pass).
// Every case injects its own fetch double — no server is ever contacted.
import { describe, expect, it } from "vitest";
import type { AppendEventBody } from "../pipeline";
import {
  authHeadersFor,
  deviceLinkTransport,
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

  it("a non-409/422 failure (e.g. 500) maps to a retryable network failure, not a permanent rejection", async () => {
    const { fn } = fakeFetch(() => fakeResponse(500, { ok: false, error: { code: "INTERNAL", message: "server error" } }));
    const outcome = await sessionTransport({ fetchFn: fn }).appendEvent("fx-1", BODY);
    expect(outcome).toEqual({ kind: "network-error", message: "server error" });
  });
});

describe("listEventsSince / getLastSeq / fetchState", () => {
  it("listEventsSince returns the ledger rows, NARROWED to LedgerSlotEvent's own fields, and hits the right URL", async () => {
    // The server's real EventOut carries more columns than LedgerSlotEvent
    // declares (types.ts: "narrowed to exactly the fields the replay ruling
    // compares") — id/recorded_at/voids_event_id are validated but DROPPED
    // by the zod boundary (review finding 1), not silently forwarded.
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
    expect(result).toEqual([{ seq: 5, type: "core.start", payload: {}, recorded_by: "u1", device_link_id: null }]);
    expect(calls[0]!.url).toBe("/api/v1/fixtures/fx-1/events?since_seq=4");
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
    const rawRow = { seq: 5, type: "core.note", payload: { text: "x" } }; // both keys OMITTED entirely
    const { fn } = fakeFetch(() => fakeResponse(200, { ok: true, data: [rawRow] }));
    const result = await sessionTransport({ fetchFn: fn }).listEventsSince("fx-1", 4);
    expect(result).toEqual([{ seq: 5, type: "core.note", payload: { text: "x" }, recorded_by: null, device_link_id: null }]);
    // A GENUINE own key holding `null`, not merely absent from the object —
    // pipeline.ts's resolveConflict compares this against OwnIdentity's own
    // `string | null` fields, so "present and null" vs "absent" must not
    // matter downstream either way.
    expect(Object.prototype.hasOwnProperty.call(result[0], "recorded_by")).toBe(true);
    expect(Object.prototype.hasOwnProperty.call(result[0], "device_link_id")).toBe(true);
  });

  it("an explicit null on both identity fields round-trips as null (not just the omitted-key case)", async () => {
    const rawRow = { seq: 5, type: "core.note", payload: {}, recorded_by: null, device_link_id: null };
    const { fn } = fakeFetch(() => fakeResponse(200, { ok: true, data: [rawRow] }));
    const result = await sessionTransport({ fetchFn: fn }).listEventsSince("fx-1", 4);
    expect(result).toEqual([{ seq: 5, type: "core.note", payload: {}, recorded_by: null, device_link_id: null }]);
  });

  it("a malformed row (wrong TYPE, not just a missing optional key) rejects with a parse error, not a silent pass-through", async () => {
    const badRow = { seq: "not-a-number", type: "core.note", payload: {}, recorded_by: null, device_link_id: null };
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
