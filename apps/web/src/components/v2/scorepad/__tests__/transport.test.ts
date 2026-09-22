// The real ScoringTransport over fetch (S10/#419 W8, network-wiring pass).
// Every case injects its own fetch double — no server is ever contacted.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { AppendEventBody } from "../pipeline";
import {
  authHeadersFor,
  deviceLinkTransport,
  isPermanentRefusal,
  sessionTransport,
  TERMINAL_CONFLICT_CODES,
  type FixtureStateResult,
} from "../transport";

interface Call {
  url: string;
  init: RequestInit | undefined;
}

/** A hand-rolled Response stub — only `.ok`/`.status`/`.json()` are ever read
 *  by transport.ts, so this avoids depending on the platform's real Response
 *  constructor being available under vitest's node environment. */
function fakeResponse(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  // Header lookup is case-insensitive on a real `Headers`, so the stub
  // lowercases both sides — otherwise a test could pass only because it
  // happened to spell the header the same way the code does.
  const lower = new Map(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v]));
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (name: string) => lower.get(name.toLowerCase()) ?? null },
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
  // W1 (2026-09-21): 429 LEFT this table. It is still transient — the queue
  // still keeps the tap, and `isPermanentRefusal(429)` is still false — but it
  // no longer maps to `network-error`, because that is what put "Offline" on a
  // pad whose wifi was fine. Its own case is in the "429 is throttled"
  // describe below; the rest of this table is unchanged and still pins that a
  // fix here did not make every non-2xx permanent.
  const TRANSIENT: readonly { status: number; why: string }[] = [
    { status: 408, why: "request timeout — the server explicitly invites a retry" },
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

// ---------------------------------------------------------------------------
// W1 (2026-09-21) — a 409 is classified by its CODE, not by its status.
// Measured on staging: 10 queued actions stacked behind one already-undone
// void, because every 409 took the renegotiation path, failed identically on
// the resend, and was left at the queue HEAD forever.
// ---------------------------------------------------------------------------
describe("409 classification", () => {
  const body = (code: string, extra: Record<string, unknown> = {}) => ({
    ok: false,
    error: { code, message: "nope", ...extra },
  });

  it.each(["UNDO_NOOP", "UNDO_TARGET_MISSING", "UNDO_ALREADY_VOIDED", "UNDO_NOT_UNDOABLE"])(
    "%s is terminal, not renegotiable",
    async (code) => {
      const { fn } = fakeFetch(() => fakeResponse(409, body(code)));
      const outcome = await sessionTransport({ fetchFn: fn }).appendEvent("fx-1", {
        expected_seq: 1,
        type: "core.void",
        payload: {},
        idempotency_key: "k",
      });
      expect(outcome.kind).toBe("rejected");
      expect(outcome).toMatchObject({ code });
    },
  );

  // The positive pair. Without it, "terminal" would also pass if EVERY 409
  // became terminal — which would silently break the replay ruling and drop
  // real writes.
  it("SEQ_CONFLICT stays renegotiable", async () => {
    const { fn } = fakeFetch(() => fakeResponse(409, body("SEQ_CONFLICT", { current_seq: 9 })));
    const outcome = await sessionTransport({ fetchFn: fn }).appendEvent("fx-1", {
      expected_seq: 1,
      type: "badminton.rally",
      payload: {},
      idempotency_key: "k",
    });
    expect(outcome).toMatchObject({ kind: "conflict", currentSeq: 9 });
  });

  // An un-migrated server sends 409 with no explicit code. It must keep
  // today's behaviour, or a new client would wedge against an old server.
  it("a 409 with no recognised code stays renegotiable", async () => {
    const { fn } = fakeFetch(() => fakeResponse(409, body("CONFLICT")));
    const outcome = await sessionTransport({ fetchFn: fn }).appendEvent("fx-1", {
      expected_seq: 1,
      type: "badminton.rally",
      payload: {},
      idempotency_key: "k",
    });
    expect(outcome.kind).toBe("conflict");
  });

  // The list is not a hand-typed table: it is pinned against the codes the
  // server's own undo path throws, so a fifth terminal refusal added there
  // without a client entry fails HERE rather than wedging a queue in a venue.
  it("TERMINAL_CONFLICT_CODES is exactly the set scoring.ts refuses an undo with", () => {
    // Read as TEXT, not imported: `@/server/**` is banned from this bundle by
    // the pad's purity gate (`__tests__/server-boundary.test.ts`) — the same
    // trick `refusal-copy.test.ts` uses to pin against `http.ts`.
    const src = readFileSync(join(process.cwd(), "src/server/usecases/scoring.ts"), "utf8");
    const thrown = new Set([...src.matchAll(/"(UNDO_[A-Z_]+)"/g)].map((m) => m[1]!));
    expect(thrown.size).toBeGreaterThan(0);
    expect([...TERMINAL_CONFLICT_CODES].sort()).toEqual([...thrown].sort());
  });
});

// ---------------------------------------------------------------------------
// W1 (2026-09-21) — a 429 is THROTTLED, not offline. It stays retryable (the
// tap is kept), but telling a scorer standing in a venue with working wifi
// that they have no connection sends them to fix the wrong thing. The bucket
// is per FIXTURE, so a second device on the same match can cause it without
// this scorer doing anything at all.
// ---------------------------------------------------------------------------
describe("429 is throttled, not offline", () => {
  const limited = { ok: false, error: { code: "RATE_LIMITED", message: "Too many requests" } };

  it("429 maps to the throttled outcome", async () => {
    const { fn } = fakeFetch(() => fakeResponse(429, limited));
    const outcome = await sessionTransport({ fetchFn: fn }).appendEvent("fx-1", BODY);
    expect(outcome).toEqual({ kind: "throttled", message: "Too many requests", retryAfterMs: null });
  });

  // Our own API does not send `Retry-After` today (nothing under
  // `src/server/api-v1` sets it) — this reads one if a server ever does, and
  // must degrade to `null` rather than NaN until then.
  it("carries a numeric Retry-After as milliseconds", async () => {
    const { fn } = fakeFetch(() => fakeResponse(429, limited, { "Retry-After": "3" }));
    const outcome = await sessionTransport({ fetchFn: fn }).appendEvent("fx-1", BODY);
    expect(outcome).toMatchObject({ kind: "throttled", retryAfterMs: 3000 });
  });

  // `Retry-After` is legally an HTTP-date too. `Number("Wed, 21 Oct 2026…")`
  // is NaN, and a NaN delay compares false against everything — the entry
  // would either never send or never wait. Ignored, never guessed.
  it("ignores an HTTP-date Retry-After instead of parsing it into NaN", async () => {
    const { fn } = fakeFetch(() =>
      fakeResponse(429, limited, { "Retry-After": "Wed, 21 Oct 2026 07:28:00 GMT" }),
    );
    const outcome = await sessionTransport({ fetchFn: fn }).appendEvent("fx-1", BODY);
    expect(outcome).toMatchObject({ kind: "throttled", retryAfterMs: null });
  });

  // Positive pair: a real transport failure must STILL be a network error, or
  // "throttled" could pass by swallowing everything.
  it("a thrown fetch is still a network error", async () => {
    const { fn } = fakeFetch(() => {
      throw new Error("dns");
    });
    const outcome = await sessionTransport({ fetchFn: fn }).appendEvent("fx-1", BODY);
    expect(outcome.kind).toBe("network-error");
  });

  // …and so is the other transient class. A 5xx is a server fault, not a
  // rate limit, and must not be relabelled as one.
  it("a 5xx is still a network error, not throttled", async () => {
    const { fn } = fakeFetch(() => fakeResponse(503, { ok: false, error: { code: "INTERNAL", message: "deploying" } }));
    const outcome = await sessionTransport({ fetchFn: fn }).appendEvent("fx-1", BODY);
    expect(outcome.kind).toBe("network-error");
  });
});

// ---------------------------------------------------------------------------
// W1 (2026-09-22) — an edge challenge is not OUR refusal.
//
// Verified against the live `seazn.club` zone: `security_level: "medium"` and
// `browser_check: "on"`, with NO WAF custom ruleset, so no `/api/` skip — a
// challenge can land on the scoring write path. Cloudflare's own docs: a
// challenge "interrupts the request flow by returning a full HTML page … This
// mechanism fails when the browser expects a non-HTML response, such as an
// AJAX or XHR (fetch) request." A venue behind carrier-grade NAT with a poor
// IP reputation is the realistic trigger.
//
// The discriminator is the ENVELOPE SHAPE, never a `cf-mitigated` header: our
// API always answers in the v1 envelope, an HTML challenge page never does,
// and coupling the pad's transport to one vendor's header name would rot the
// day that vendor renames it or another one is in front.
// ---------------------------------------------------------------------------
describe("a 403 from an intermediary is not our refusal", () => {
  /** A challenge/block page: an HTML body, so `res.json()` throws. */
  function challenge(status: number): Response {
    return {
      ok: false,
      status,
      headers: { get: () => null },
      json: async () => {
        throw new SyntaxError("Unexpected token '<', \"<!DOCTYPE \"... is not valid JSON");
      },
    } as unknown as Response;
  }

  // The positive pair, and it is the one that keeps this narrow: a 403 our own
  // server sent stays permanent, exactly as `isPermanentRefusal`'s own comment
  // argues it must.
  it("a 403 carrying OUR envelope is still a permanent refusal", async () => {
    const { fn } = fakeFetch(() =>
      fakeResponse(403, { ok: false, error: { code: "FORBIDDEN", message: "device link revoked" } }),
    );
    const outcome = await sessionTransport({ fetchFn: fn }).appendEvent("fx-1", BODY);
    expect(outcome).toEqual({ kind: "rejected", code: "FORBIDDEN", message: "device link revoked" });
  });

  it("a 403 carrying a challenge HTML page is transient, so the tap is kept", async () => {
    const { fn } = fakeFetch(() => challenge(403));
    const outcome = await sessionTransport({ fetchFn: fn }).appendEvent("fx-1", BODY);
    expect(outcome.kind).toBe("network-error");
  });

  // Not every intermediary answers in HTML. A JSON error page that is not OUR
  // envelope is equally not our refusal — the test is the shape, not the
  // content type.
  it("a 403 carrying JSON that is not our envelope is transient too", async () => {
    const { fn } = fakeFetch(() => fakeResponse(403, { error: "blocked", ray: "8f2a" }));
    const outcome = await sessionTransport({ fetchFn: fn }).appendEvent("fx-1", BODY);
    expect(outcome.kind).toBe("network-error");
  });

  // NOT widened to 401. `isPermanentRefusal`'s own comment spends a paragraph
  // on why an expired session must refuse VISIBLY rather than queue behind a
  // pad claiming the action landed, and that reasoning is untouched.
  it("a 401 with the same unparseable body is STILL permanent", async () => {
    const { fn } = fakeFetch(() => challenge(401));
    const outcome = await sessionTransport({ fetchFn: fn }).appendEvent("fx-1", BODY);
    expect(outcome.kind).toBe("rejected");
  });

  // …nor to 402. A malformed body from OUR entitlement gate is still our
  // refusal, and retrying it forever is the R6 ship-blocker reintroduced.
  it("a 402 with an unparseable body is STILL permanent", async () => {
    const { fn } = fakeFetch(() => challenge(402));
    const outcome = await sessionTransport({ fetchFn: fn }).appendEvent("fx-1", BODY);
    expect(outcome).toEqual({ kind: "rejected", code: "UNKNOWN", message: "request failed (402)" });
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
