// sendWithResult — the typed result behind email.ts's private send().
//
// Task 2 of the email outbox (phase 1). The outbox needs three things the old
// boolean could not give it: Resend's message id (to store as provider_id), a
// status + error NAME on failure (so a 429 retries, a 422 is terminal, and the
// two 409s split), and a bounded wait (so a hung socket cannot pin a lease).
// It also needs the Idempotency-Key header so a retry after a lost response
// cannot double-send.
//
// The other half of the contract is what must NOT move: every one of the ~50
// existing senders still resolves a boolean, logs the same lines, and puts the
// same request on the wire — no Idempotency-Key, no AbortSignal, no `tags`.
//
// No DB: `@/lib/db` is mocked so isSuppressed reads a stubbed row, and `fetch`
// is a stub. Single transport, no sport involved (so no registry sweep).
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const sqlMock = vi.hoisted(() => vi.fn());
vi.mock("@/lib/db", () => ({ sql: sqlMock }));

import {
  checkSendable,
  deliver,
  sendAiRunCostAlertEmail,
  sendVerificationEmail,
  sendWithResult,
  type SendOptions,
} from "../email";

const OLD_KEY = process.env.RESEND_API_KEY;
const KEY = "re_test_key";

const msg: SendOptions = {
  to: "player@example.test",
  subject: "Your sign-in link",
  html: "<p>hi</p>",
  text: "hi",
  transactional: true,
};

type FetchInit = {
  method: string;
  headers: Record<string, string>;
  body: string;
  signal?: AbortSignal;
};
const fetchMock = vi.fn<(url: string, init: FetchInit) => Promise<Response>>();

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

function lastCall(): { url: string; init: FetchInit; body: Record<string, unknown> } {
  const call = fetchMock.mock.calls.at(-1);
  if (!call) throw new Error("fetch was never called");
  const [url, init] = call;
  return { url, init, body: JSON.parse(init.body) as Record<string, unknown> };
}

let warn: ReturnType<typeof vi.spyOn>;
let error: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  process.env.RESEND_API_KEY = KEY;
  fetchMock.mockReset();
  fetchMock.mockImplementation(async () => json(200, { id: "re_123" }));
  vi.stubGlobal("fetch", fetchMock);
  sqlMock.mockReset();
  sqlMock.mockResolvedValue([]); // not suppressed unless a test says so
  warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  error = vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  if (OLD_KEY === undefined) delete process.env.RESEND_API_KEY;
  else process.env.RESEND_API_KEY = OLD_KEY;
});

describe("sendWithResult — the request on the wire", () => {
  it("sends Idempotency-Key exactly when given, and no such header for today's callers", async () => {
    await sendWithResult({ ...msg, idempotencyKey: "3b241101-e2bb-4255-8caf-4136c566a962" });
    const withKey = lastCall();
    expect(withKey.url).toBe("https://api.resend.com/emails");
    expect(withKey.init.headers["Idempotency-Key"]).toBe("3b241101-e2bb-4255-8caf-4136c566a962");

    // The legacy shape: exactly the two headers it always had.
    await sendWithResult(msg);
    expect(lastCall().init.headers).toEqual({
      Authorization: `Bearer ${KEY}`,
      "Content-Type": "application/json",
    });

    // Sequence: a key on call 1 must not leak into call 2, and an empty key is
    // "not given" (Resend would 400 an empty header and the send would die).
    await sendWithResult({ ...msg, idempotencyKey: "" });
    expect(Object.keys(lastCall().init.headers)).not.toContain("Idempotency-Key");
  });

  it("tags go out as Resend's [{ name, value }] array, and no tags key otherwise", async () => {
    await sendWithResult({ ...msg, tags: { kind: "magic_link", outbox_id: "abc-1" } });
    expect(lastCall().body.tags).toEqual([
      { name: "kind", value: "magic_link" },
      { name: "outbox_id", value: "abc-1" },
    ]);

    await sendWithResult(msg);
    expect("tags" in lastCall().body).toBe(false);
    await sendWithResult({ ...msg, tags: {} });
    expect("tags" in lastCall().body).toBe(false);
  });

  it("an omitted timeoutMs passes no signal; a given one passes a live AbortSignal", async () => {
    await sendWithResult(msg);
    expect(lastCall().init.signal).toBeUndefined();

    await sendWithResult({ ...msg, timeoutMs: 8000 });
    const { signal } = lastCall().init;
    expect(signal).toBeInstanceOf(AbortSignal);
    expect(signal?.aborted).toBe(false);
  });

  it("the payload is byte-for-byte today's: from, to, subject, html, text, reply_to", async () => {
    process.env.EMAIL_REPLY_TO = "help@example.test";
    try {
      await sendWithResult({ ...msg, idempotencyKey: "k", tags: { a: "b" }, timeoutMs: 100 });
      // idempotencyKey / timeoutMs are transport, never body fields.
      expect(Object.keys(lastCall().body).sort()).toEqual(
        ["from", "html", "reply_to", "subject", "tags", "text", "to"].sort(),
      );
      expect(lastCall().body).toMatchObject({
        to: [msg.to],
        subject: msg.subject,
        html: msg.html,
        text: msg.text,
        reply_to: "help@example.test",
      });
    } finally {
      delete process.env.EMAIL_REPLY_TO;
    }
  });
});

describe("sendWithResult — success", () => {
  it("2xx returns the provider id from the JSON body's `id`", async () => {
    fetchMock.mockImplementation(async () => json(200, { id: "re_123" }));
    expect(await sendWithResult(msg)).toEqual({ ok: true, providerId: "re_123" });
  });

  it("2xx without a usable id is still ok, providerId null", async () => {
    const bodies: Array<[string, () => unknown]> = [
      ["empty body", () => new Response("", { status: 200 })],
      ["non-JSON body", () => new Response("accepted", { status: 200 })],
      ["JSON without id", () => json(200, { ok: true })],
      ["non-string id", () => json(200, { id: 42 })],
      ["JSON null", () => json(200, null)],
      // The stub shape every existing alert test uses: no .json() at all.
      ["legacy stub with no json()", () => ({ ok: true, status: 200, text: async () => "" })],
    ];
    expect(bodies.length).toBeGreaterThan(0);
    for (const [label, make] of bodies) {
      fetchMock.mockImplementationOnce(async () => make() as Response);
      expect(await sendWithResult(msg), label).toEqual({ ok: true, providerId: null });
    }
  });
});

describe("sendWithResult — failure", () => {
  it("non-2xx returns the status and Resend's error `name`; a non-JSON body gives errorName null", async () => {
    // Names come from Resend's documented error shape {statusCode,name,message}.
    const cases: Array<[number, unknown, string | null]> = [
      [429, { statusCode: 429, name: "rate_limit_exceeded", message: "slow down" }, "rate_limit_exceeded"],
      [409, { statusCode: 409, name: "concurrent_idempotent_requests", message: "m" }, "concurrent_idempotent_requests"],
      [409, { statusCode: 409, name: "invalid_idempotent_request", message: "m" }, "invalid_idempotent_request"],
      [422, { statusCode: 422, name: "validation_error", message: "m" }, "validation_error"],
      [403, { statusCode: 403, name: "invalid_from_address", message: "m" }, "invalid_from_address"],
      [500, "Internal Server Error", null],
      [502, "<html>bad gateway</html>", null],
      [500, { message: "no name field" }, null],
      [500, { name: 7, message: "name is not a string" }, null],
      [500, null, null],
    ];
    for (const [status, payload, errorName] of cases) {
      const text = typeof payload === "string" ? payload : JSON.stringify(payload);
      fetchMock.mockImplementationOnce(async () => new Response(text, { status }));
      const r = await sendWithResult(msg);
      expect(r, `${status} ${text}`).toEqual({ ok: false, reason: "http", status, errorName, detail: text });
    }
    expect(cases.length).toBeGreaterThan(0);
  });

  it("a non-2xx whose body cannot be read still reports the status, with errorName null and detail empty", async () => {
    // A body stream that errors mid-read: res.text() REJECTS. The status is the
    // fact the outbox classifies on; losing the body must not turn a 422 (dead)
    // into a network failure (retried forever).
    fetchMock.mockImplementationOnce(
      async () =>
        new Response(
          new ReadableStream({
            start(controller) {
              controller.error(new Error("body stream reset"));
            },
          }),
          { status: 422 },
        ),
    );
    expect(await sendWithResult(msg)).toEqual({
      ok: false,
      reason: "http",
      status: 422,
      errorName: null,
      detail: "",
    });
  });

  it("the two 409s are told apart (the outbox retries one and kills the other)", async () => {
    fetchMock.mockImplementationOnce(async () =>
      json(409, { statusCode: 409, name: "concurrent_idempotent_requests", message: "m" }),
    );
    const concurrent = await sendWithResult(msg);
    fetchMock.mockImplementationOnce(async () =>
      json(409, { statusCode: 409, name: "invalid_idempotent_request", message: "m" }),
    );
    const invalid = await sendWithResult(msg);
    expect(concurrent).toMatchObject({ reason: "http", status: 409, errorName: "concurrent_idempotent_requests" });
    expect(invalid).toMatchObject({ reason: "http", status: 409, errorName: "invalid_idempotent_request" });
  });

  it("keeps today's console.error line for a non-2xx", async () => {
    fetchMock.mockImplementation(async () => new Response("boom", { status: 500 }));
    await sendWithResult(msg);
    expect(error).toHaveBeenCalledWith(`[email] send failed (500) to ${msg.to}: boom`);
  });

  // Ruling R8: the outbox must not log Resend's raw response text (it can echo what was sent). It asks deliver() for
  // `{ logDetail: false }`; every other caller keeps the line above byte for byte.
  describe("deliver with { logDetail: false } (the outbox's logging)", () => {
    const RAW = "RAW-PROVIDER-DETAIL echo https://seazn.club/verify?token=SECRET";

    it("logs the status and the error name only: not Resend's message, not the recipient", async () => {
      fetchMock.mockImplementation(async () => json(500, { statusCode: 500, name: "internal_server_error", message: RAW }));
      const result = await deliver(msg, KEY, { logDetail: false });
      expect(error).toHaveBeenCalledTimes(1);
      expect(error).toHaveBeenCalledWith("[email] send failed (500) internal_server_error");
      const logged = JSON.stringify(error.mock.calls);
      expect(logged).not.toContain("RAW-PROVIDER");
      expect(logged).not.toContain("SECRET");
      expect(logged).not.toContain(msg.to);
      // The result still carries the detail for the caller to classify on; it is the LOG that stops short.
      expect(result).toMatchObject({ ok: false, reason: "http", status: 500, errorName: "internal_server_error" });
    });

    it("a body with no error name logs a placeholder, and a name that is not a token is sanitised", async () => {
      fetchMock.mockImplementationOnce(async () => new Response(RAW, { status: 503 }));
      await deliver(msg, KEY, { logDetail: false });
      fetchMock.mockImplementationOnce(async () => json(422, { name: `bad\nname ${"x".repeat(200)}`, message: RAW }));
      await deliver(msg, KEY, { logDetail: false });
      const lines = (error.mock.calls as unknown[][]).map((c) => String(c[0]));
      expect(lines[0]).toBe("[email] send failed (503) unknown");
      expect(lines[1]).toMatch(/^\[email\] send failed \(422\) bad\?name\?x+$/);
      expect(lines[1]!.length).toBeLessThan(120);
      expect(JSON.stringify(error.mock.calls)).not.toContain("RAW-PROVIDER");
    });

    it("a network failure logs the cause, not the error object (whose stack and cause can carry anything)", async () => {
      fetchMock.mockImplementation(async () => {
        throw Object.assign(new TypeError("fetch failed"), { cause: { code: "ECONNRESET" }, secretField: RAW });
      });
      await deliver(msg, KEY, { logDetail: false });
      expect(error).toHaveBeenCalledTimes(1);
      expect(error).toHaveBeenCalledWith("[email] send error: fetch failed (ECONNRESET)");
      expect(JSON.stringify(error.mock.calls)).not.toContain("RAW-PROVIDER");
    });

    it("a network failure's summary is one printable line, capped: a newline and non-ASCII become '?', and 200 characters at most", async () => {
      fetchMock.mockImplementation(async () => {
        throw new TypeError(`bad\nline \u00e9${"x".repeat(300)}`);
      });
      await deliver(msg, KEY, { logDetail: false });
      expect(error).toHaveBeenCalledTimes(1);
      const line = String((error.mock.calls as unknown[][])[0]![0]);
      const prefix = "[email] send error: ";
      expect(line.startsWith(`${prefix}bad?line ?xxx`)).toBe(true);
      expect(line).not.toMatch(/[^\x20-\x7e]/);
      expect(line.length).toBe(prefix.length + 200);
    });

    it("the option is off by default and for sendWithResult: today's lines are unchanged (the two pins above stay green)", async () => {
      fetchMock.mockImplementation(async () => new Response("boom", { status: 500 }));
      await deliver(msg, KEY);
      await deliver(msg, KEY, {});
      await deliver(msg, KEY, { logDetail: true });
      await sendWithResult(msg);
      const lines = (error.mock.calls as unknown[][]).map((c) => String(c[0]));
      expect(lines).toEqual(Array(4).fill(`[email] send failed (500) to ${msg.to}: boom`));
    });
  });

  it("a fetch that rejects is network, carrying the error's message", async () => {
    fetchMock.mockImplementation(async () => {
      throw new TypeError("fetch failed");
    });
    expect(await sendWithResult(msg)).toEqual({ ok: false, reason: "network", detail: "fetch failed" });
    expect(error).toHaveBeenCalledWith(`[email] send error to ${msg.to}:`, expect.any(TypeError));
  });

  it("a network detail appends the cause's code when there is one", async () => {
    // undici surfaces "fetch failed" and hides the useful part in err.cause.code.
    const withCode = Object.assign(new TypeError("fetch failed"), {
      cause: Object.assign(new Error("read ECONNRESET"), { code: "ECONNRESET" }),
    });
    const cases: Array<[string, unknown, string]> = [
      ["cause with a code", withCode, "fetch failed (ECONNRESET)"],
      ["cause without a code", Object.assign(new TypeError("fetch failed"), { cause: new Error("x") }), "fetch failed"],
      [
        "cause with a non-string code",
        Object.assign(new TypeError("fetch failed"), { cause: Object.assign(new Error("x"), { code: 104 }) }),
        "fetch failed",
      ],
      ["cause that is not an object", Object.assign(new TypeError("fetch failed"), { cause: "ECONNRESET" }), "fetch failed"],
      ["no cause", new TypeError("fetch failed"), "fetch failed"],
    ];
    for (const [label, err, detail] of cases) {
      fetchMock.mockImplementationOnce(() => Promise.reject(err));
      expect(await sendWithResult(msg), label).toEqual({ ok: false, reason: "network", detail });
    }
    expect(cases.length).toBe(5);
  });

  it("a rejection that is not an Error is stringified, never thrown", async () => {
    const cases: Array<[unknown, string]> = [
      ["connection lost", "connection lost"],
      [null, "null"],
      [42, "42"],
    ];
    for (const [thrown, detail] of cases) {
      fetchMock.mockImplementationOnce(() => Promise.reject(thrown));
      expect(await sendWithResult(msg), String(thrown)).toEqual({ ok: false, reason: "network", detail });
    }
    expect(cases.length).toBe(3);
  });

  it("a fetch past timeoutMs is network with detail 'timeout'", async () => {
    // A transport that honours its signal, like the real fetch: it would answer
    // 200 after 300ms, but the signal aborts it at 20ms and rejects with the
    // signal's reason (a TimeoutError). With the timeout dropped it answers 200.
    fetchMock.mockImplementation(
      (_url, init) =>
        new Promise<Response>((resolve, reject) => {
          const late = setTimeout(() => resolve(json(200, { id: "re_late" })), 300);
          init.signal?.addEventListener("abort", () => {
            clearTimeout(late);
            reject(init.signal?.reason);
          });
        }),
    );
    const r = await sendWithResult({ ...msg, timeoutMs: 20 });
    expect(r).toEqual({ ok: false, reason: "network", detail: "timeout" });
  });

  it("never throws on a bad timeoutMs: it comes back as a network failure", async () => {
    // AbortSignal.timeout(-1) throws a RangeError. send() has always promised
    // never to throw; a programming error in an option must not break that.
    const r = await sendWithResult({ ...msg, timeoutMs: -1 });
    expect(r).toMatchObject({ ok: false, reason: "network" });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("sendWithResult — the gate (no key, suppression)", () => {
  it("no RESEND_API_KEY: no_api_key, fetch never called, the 'would send' warning kept", async () => {
    delete process.env.RESEND_API_KEY;
    expect(await sendWithResult({ ...msg, transactional: false })).toEqual({ ok: false, reason: "no_api_key" });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledWith(`[email] RESEND_API_KEY not set — would send "${msg.subject}" to ${msg.to}`);
    // Today's order: the key check comes first, so the suppression table is not touched.
    expect(sqlMock).not.toHaveBeenCalled();
  });

  it("non-transactional to a suppressed address: suppressed, fetch never called", async () => {
    sqlMock.mockResolvedValue([{ id: "sup-1" }]);
    expect(await sendWithResult({ ...msg, transactional: false })).toEqual({ ok: false, reason: "suppressed" });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledWith(`[email] suppressed: ${msg.to}`);
    // It asked about THIS recipient (the tagged-template's first value).
    expect(sqlMock.mock.calls[0]?.[1]).toBe(msg.to);
  });

  it("a transactional send to a suppressed address still goes out and never asks the table", async () => {
    sqlMock.mockResolvedValue([{ id: "sup-1" }]);
    expect(await sendWithResult({ ...msg, transactional: true })).toEqual({ ok: true, providerId: "re_123" });
    expect(sqlMock).not.toHaveBeenCalled();
  });

  it("a suppression lookup that throws counts as not suppressed (today's .catch)", async () => {
    sqlMock.mockRejectedValue(new Error("db down"));
    expect(await sendWithResult({ ...msg, transactional: false })).toEqual({ ok: true, providerId: "re_123" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("an omitted `transactional` is non-transactional (suppression applies)", async () => {
    sqlMock.mockResolvedValue([{ id: "sup-1" }]);
    const { transactional: _t, ...unflagged } = msg;
    void _t;
    expect(await sendWithResult(unflagged)).toEqual({ ok: false, reason: "suppressed" });
  });
});

describe("checkSendable / deliver — the seam the outbox's attemptClaimed uses", () => {
  it("checkSendable hands back the key when sendable, and the reason when not", async () => {
    expect(await checkSendable({ ...msg, transactional: false })).toEqual({ ok: true, apiKey: KEY });

    sqlMock.mockResolvedValue([{ id: "sup-1" }]);
    expect(await checkSendable({ ...msg, transactional: false })).toEqual({ ok: false, reason: "suppressed" });
    expect(await checkSendable({ ...msg, transactional: true })).toEqual({ ok: true, apiKey: KEY });

    delete process.env.RESEND_API_KEY;
    expect(await checkSendable({ ...msg, transactional: true })).toEqual({ ok: false, reason: "no_api_key" });
  });

  it("deliver does NOT re-check: a suppressed address with no env key still reaches fetch", async () => {
    sqlMock.mockResolvedValue([{ id: "sup-1" }]);
    delete process.env.RESEND_API_KEY;
    const r = await deliver({ ...msg, transactional: false, idempotencyKey: "row-1" }, "re_explicit");
    expect(r).toEqual({ ok: true, providerId: "re_123" });
    expect(sqlMock).not.toHaveBeenCalled();
    expect(lastCall().init.headers.Authorization).toBe("Bearer re_explicit");
    expect(lastCall().init.headers["Idempotency-Key"]).toBe("row-1");
  });

  it("the whole decision table: key x transactional x suppressed, against the spec's rule", async () => {
    // Expected values come from the spec ("Sending": no key -> no_api_key;
    // suppression is for NON-transactional mail only), not from checkSendable.
    // No key wins over suppression (today checks the key first).
    let checked = 0;
    for (const hasKey of [true, false]) {
      for (const transactional of [true, false]) {
        for (const suppressed of [true, false]) {
          process.env.RESEND_API_KEY = KEY;
          if (!hasKey) delete process.env.RESEND_API_KEY;
          sqlMock.mockResolvedValue(suppressed ? [{ id: "sup-1" }] : []);
          fetchMock.mockClear();

          const expected = !hasKey
            ? { ok: false, reason: "no_api_key" }
            : !transactional && suppressed
              ? { ok: false, reason: "suppressed" }
              : { ok: true, providerId: "re_123" };

          const label = `key=${hasKey} transactional=${transactional} suppressed=${suppressed}`;
          expect(await sendWithResult({ ...msg, transactional }), label).toEqual(expected);
          expect(fetchMock.mock.calls.length, `${label} fetch calls`).toBe(expected.ok ? 1 : 0);
          checked++;
        }
      }
    }
    expect(checked).toBe(8);
  });
});

describe("regression — existing senders resolve a boolean exactly as before", () => {
  const to = "someone@example.test";

  it("sendVerificationEmail: true on 2xx, false on 500, false on no key", async () => {
    expect(await sendVerificationEmail(to, "https://seazn.test/verify?t=1")).toBe(true);

    fetchMock.mockImplementationOnce(async () => new Response("boom", { status: 500 }));
    expect(await sendVerificationEmail(to, "https://seazn.test/verify?t=1")).toBe(false);

    fetchMock.mockClear();
    delete process.env.RESEND_API_KEY;
    expect(await sendVerificationEmail(to, "https://seazn.test/verify?t=1")).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("existing senders put today's request on the wire: no Idempotency-Key, no signal, no tags", async () => {
    // One transactional sender and one alert sender: the two routes into send().
    expect(await sendVerificationEmail(to, "https://seazn.test/verify?t=1")).toBe(true);
    const verification = lastCall();
    expect(await sendAiRunCostAlertEmail({
      to,
      orgId: "org-1",
      model: "claude-sonnet-5",
      costUsd: 0.5,
      medianUsd: 0.05,
      windowDays: 30,
      phase: "schedule",
    })).toBe(true);
    const alert = lastCall();
    expect(fetchMock).toHaveBeenCalledTimes(2);

    for (const call of [verification, alert]) {
      expect(call.init.headers).toEqual({
        Authorization: `Bearer ${KEY}`,
        "Content-Type": "application/json",
      });
      expect(call.init.signal).toBeUndefined();
      expect("tags" in call.body).toBe(false);
      expect(call.init.method).toBe("POST");
    }
  });

  it("a network error resolves false, and logs today's line", async () => {
    fetchMock.mockImplementation(async () => {
      throw new TypeError("fetch failed");
    });
    expect(await sendVerificationEmail(to, "https://seazn.test/verify?t=1")).toBe(false);
    expect(error).toHaveBeenCalledWith(`[email] send error to ${to}:`, expect.any(TypeError));
  });
});
