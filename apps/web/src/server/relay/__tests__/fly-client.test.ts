// The Fly Machines client against a scripted fetch, a fake clock, a
// recording sleeper and a fixed random source. Every fact the client relies
// on is listed in the plan (Task 5A) with its source; the shapes below are
// those. Killers recorded for the PR table: remove the retry → "503 then
// 200"; retry on 400 → "400 is not retried"; drop Retry-After → "429 waits
// exactly Retry-After"; drop the pre-retry lookup → "timeout then lookup";
// drop the redaction → "redaction"; treat destroy 404 as an error → "destroy".
import { describe, expect, it, vi } from "vitest";
import { FLY_CLIENT_DEFAULTS, FLY_MACHINES_BASE, FlyApiError, FlyClient, exitInfoFrom, isRetryable, redact } from "../fly-client";
import type { MachineCreateInput } from "../fly-client";
import { ENDING_TIMEOUT_SECONDS, PROVISION_TIMEOUT_SECONDS, RUNNER_OBSERVE_SLACK_SECONDS, RUNNER_STOP_GRACE_SECONDS } from "../config";
import { FakeRecorder } from "../fakes";

/** `stallBody` is C2's shape: headers arrive, the body never does, and the stream
 *  does NOT honour the AbortSignal — so it proves the timeout bounds the read
 *  itself rather than relying on the mock to co-operate. */
/** `clockJumpMs` advances the fake clock and then ANSWERS — a slow call that
 *  succeeds, which `delayMs` cannot express (that one hangs until the abort).
 *  It is what puts a create's own ambiguity lookup past the deadline. */
type Scripted = { status: number; body?: unknown; headers?: Record<string, string>; delayMs?: number; networkError?: boolean; stallBody?: boolean; clockJumpMs?: number };

function rig(script: Scripted[], opts: Partial<ConstructorParameters<typeof FlyClient>[0]> = {}) {
  let now = 1_000_000;
  const sleeps: number[] = [];
  const calls: { url: string; init: RequestInit }[] = [];
  const fetchImpl = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} });
    const step = script.shift();
    if (!step) throw new Error(`unscripted call ${init?.method} ${String(url)}`);
    if (step.networkError) throw new TypeError("fetch failed");
    if (step.delayMs !== undefined) {
      // Simulate a hang: the client's AbortSignal must fire before we "respond".
      await new Promise<void>((resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(Object.assign(new Error("aborted"), { name: "AbortError" })));
        now += step.delayMs!;
      });
    }
    if (step.clockJumpMs !== undefined) now += step.clockJumpMs;
    if (step.stallBody) {
      // A body that never arrives AND never reacts to the abort. `new ReadableStream`
      // with an empty start() leaves `res.text()` pending for ever.
      return new Response(new ReadableStream({ start() {} }), {
        status: step.status, headers: { "content-type": "application/json", ...(step.headers ?? {}) },
      });
    }
    return new Response(step.body === undefined ? null : typeof step.body === "string" ? step.body : JSON.stringify(step.body), {
      status: step.status, headers: { "content-type": "application/json", ...(step.headers ?? {}) },
    });
  }) as unknown as typeof fetch;
  const client = new FlyClient({
    token: "fly-token-SECRET", app: "seazn-relay", fetchImpl,
    clock: () => now, sleep: async (ms) => { sleeps.push(ms); now += ms; }, random: () => 0.5,
    requestTimeoutMs: 1000, deadlineMs: 10_000, maxAttempts: 4, baseBackoffMs: 500, maxBackoffMs: 8000,
    lookupSettleMs: 50,
    secrets: ["stream-key-SECRET", "fly-token-SECRET"],
    ...opts,
  });
  return { client, calls, sleeps, fetchImpl, tick: (ms: number) => { now += ms; } };
}

const MACHINE = { id: "m_1", name: "relay-s1", state: "created", instance_id: "01H", region: "lhr", config: { metadata: { seazn_session: "s1" } } };
const CREATE = {
  name: "relay-s1", region: "lhr",
  config: { image: "img", guest: { cpus: 4, memory_mb: 8192, cpu_kind: "performance" as const }, auto_destroy: true as const, restart: { policy: "no" as const }, env: { JOB_TOKEN: "stream-key-SECRET" }, metadata: { seazn_session: "s1" } },
};

describe("FlyClient — requests", () => {
  it("createMachine POSTs the body to /apps/{app}/machines with the bearer, parses the Machine", async () => {
    const r = rig([{ status: 200, body: MACHINE }]);
    const m = await r.client.createMachine(CREATE);
    expect(m.id).toBe("m_1");
    expect(r.calls[0]!.url).toBe(`${FLY_MACHINES_BASE}/apps/seazn-relay/machines`);
    expect(r.calls[0]!.init.method).toBe("POST");
    expect((r.calls[0]!.init.headers as Record<string, string>).authorization).toBe("Bearer fly-token-SECRET");
    expect(JSON.parse(String(r.calls[0]!.init.body))).toEqual(CREATE);
  });
  it("listMachines builds the metadata filter the spec documents (metadata.<key>=<value>)", async () => {
    const r = rig([{ status: 200, body: [MACHINE] }]);
    const ms = await r.client.listMachines({ metadata: { seazn_session: "s1" } });
    expect(ms.map((m) => m.id)).toEqual(["m_1"]);
    expect(r.calls[0]!.url).toBe(`${FLY_MACHINES_BASE}/apps/seazn-relay/machines?metadata.seazn_session=s1`);
  });
  it("waitMachine calls the wait endpoint with state and timeout, and parses the REAL WaitMachineResponse (not a Machine)", async () => {
    // Measured live 2026-09-20: `{"ok":true,"state":"started"}`, which is the
    // spec's WaitMachineResponse — NOT a Machine. Parsing it as one made every
    // wait fail `malformed`, and it is the shape asserted here for that reason.
    const r = rig([{ status: 200, body: { ok: true, state: "started" } }]);
    const m = await r.client.waitMachine("m_1", "started", 30);
    expect(m).toEqual({ ok: true, state: "started" });
    expect(r.calls[0]!.url).toBe(`${FLY_MACHINES_BASE}/apps/seazn-relay/machines/m_1/wait?state=started&timeout=30`);
  });
  it("getMachine: 404 → null; destroyMachine: DELETE ?force=true, 404 → resolved, 500 → FlyApiError (C7)", async () => {
    const r = rig([{ status: 404, body: { error: "not found" } }, { status: 200 }, { status: 404, body: { error: "gone" } }, { status: 500, body: { error: "boom" } }]);
    expect(await r.client.getMachine("m_x")).toBeNull();
    await expect(r.client.destroyMachine("m_1")).resolves.toBeUndefined();
    expect(r.calls[1]!.url).toBe(`${FLY_MACHINES_BASE}/apps/seazn-relay/machines/m_1?force=true`);
    expect(r.calls[1]!.init.method).toBe("DELETE");
    await expect(r.client.destroyMachine("m_gone")).resolves.toBeUndefined();
    await expect(r.client.destroyMachine("m_bad")).rejects.toBeInstanceOf(FlyApiError);
  });
});

describe("FlyClient — retries, timeouts, deadline", () => {
  it("503 then 200: retried ONCE with a jittered backoff", async () => {
    // A create that failed with a 5xx is AMBIGUOUS: the client looks the machine
    // up before retrying — the list answers EMPTY here, so the POST is retried.
    const r = rig([{ status: 503, body: { error: "unavailable" } }, { status: 200, body: [] }, { status: 200, body: MACHINE }]);
    const m = await r.client.createMachine(CREATE);
    expect(m.id).toBe("m_1");
    expect(r.calls.map((c) => c.init.method)).toEqual(["POST", "GET", "POST"]);
    expect(r.sleeps).toEqual([250]); // base 500 × 2^0 × random 0.5 (full jitter)
  });
  it("429 waits EXACTLY Retry-After (seconds), then succeeds", async () => {
    const r = rig([{ status: 429, body: { error: "rate" }, headers: { "retry-after": "3" } }, { status: 200, body: [MACHINE] }]);
    await r.client.listMachines();
    expect(r.sleeps).toEqual([3000]);
  });
  it("400 is NOT retried and surfaces as a non-retryable FlyApiError with the status", async () => {
    const r = rig([{ status: 400, body: { error: "invalid guest" } }]);
    await expect(r.client.createMachine(CREATE)).rejects.toMatchObject({ status: 400, retryable: false, attempts: 1 });
    expect(r.calls).toHaveLength(1);
  });
  it("isRetryable: network and timeout are retryable; 502/503/504 are; 401/403/404/409/422 are not", () => {
    expect(isRetryable(null, "network")).toBe(true);
    expect(isRetryable(null, "timeout")).toBe(true);
    for (const s of [429, 502, 503, 504]) expect(isRetryable(s, "http"), String(s)).toBe(true);
    for (const s of [400, 401, 403, 404, 409, 422, 500]) expect(isRetryable(s, "http"), String(s)).toBe(false);
  });

  // Lane-A minors, Task 5A review m1: the rig has carried a `networkError` capability
  // that no test ever used, and the `it` above was TITLED "a network error is retried"
  // while only calling `isRetryable` directly. So collapsing `isAbort ? "timeout" :
  // "network"` to a constant survived the whole file. It is telemetry only — both
  // classify retryable — but `retryReason` is how Task 17 tells a Fly outage apart
  // from our own request budget firing, and the two must not read the same.
  it("a network error DRIVEN through the loop is retried, and both the error and its row say network — our own AbortSignal firing says timeout", async () => {
    const net = new FakeRecorder();
    const r = rig([{ status: 0, networkError: true }, { status: 200, body: [MACHINE] }], { recorder: net });
    await r.client.listMachines();
    expect(r.calls).toHaveLength(2);                                   // not vacuous: it RETRIED past the network error
    expect(net.calls[0]).toMatchObject({ status: null, errorCode: "network", retryReason: "network" });

    const timeout = new FakeRecorder();
    const r2 = rig([{ status: 200, body: [MACHINE], delayMs: 5000 }, { status: 200, body: [MACHINE] }], { recorder: timeout });
    await r2.client.listMachines();
    expect(timeout.calls[0]).toMatchObject({ status: null, errorCode: "timeout", retryReason: "timeout" });
    // the pair is the assertion: a constant on either side makes these two identical
    expect(net.calls[0]!.errorCode).not.toBe(timeout.calls[0]!.errorCode);
  });
  it("a create that TIMES OUT is looked up before any retry: the machine exists → returned, no second POST", async () => {
    const r = rig([{ status: 200, body: MACHINE, delayMs: 5000 }, { status: 200, body: [MACHINE] }]);
    const m = await r.client.createMachine(CREATE);
    expect(m.id).toBe("m_1");
    expect(r.calls.map((c) => c.init.method)).toEqual(["POST", "GET"]);
  });
  it("the deadline is honoured: attempts stop when the next wait would end past it, with code deadline", async () => {
    const r = rig(Array.from({ length: 10 }, () => ({ status: 503, body: { error: "down" } })), { deadlineMs: 1500, maxAttempts: 10 });
    await expect(r.client.listMachines()).rejects.toMatchObject({ code: "deadline", retryable: true });
    // Lane-A minors, Task 5A review m5: `toBeLessThan(10)` had six of slack over the
    // real count, so the deadline could stop the ladder one attempt early or late and
    // this stayed green. Derived from the ladder rather than typed: attempt 1 sleeps
    // 250 ms (full jitter at random 0.5 × 500), attempt 2 sleeps 500 — 750 ms elapsed
    // — and the third attempt's 1000 ms wait would end past deadlineMs 1500, so the
    // loop stops with exactly three calls made.
    expect(r.calls).toHaveLength(3);
  });
  it("maxAttempts caps the retries even with deadline to spare", async () => {
    const r = rig(Array.from({ length: 10 }, () => ({ status: 503, body: { error: "down" } })), { deadlineMs: 1_000_000, maxAttempts: 3 });
    await expect(r.client.listMachines()).rejects.toMatchObject({ status: 503, attempts: 3 });
    expect(r.calls).toHaveLength(3);
  });
  it("T5-a: the ambiguous-create lookup returns the Machine with THIS create's name — an earlier attempt's Machine listed under the same session is not taken for it", async () => {
    const EARLIER = { ...MACHINE, id: "m_0", name: "relay-s1-earlier", state: "started" };
    const r = rig([{ status: 503, body: { error: "unavailable" } }, { status: 200, body: [EARLIER] }, { status: 200, body: MACHINE }]);
    const m = await r.client.createMachine(CREATE);
    expect(m.id).toBe("m_1");                                          // `found[0]` would have handed back m_0
    expect(r.calls.map((c) => c.init.method)).toEqual(["POST", "GET", "POST"]);
  });
  it("T5-b: a RETRYABLE create failure means Fly holds no Machine under that name — the LAST attempt is looked up too: found → returned; nothing → the retryable error; the lookup itself failing → NOT retryable", async () => {
    const found = rig([{ status: 503, body: { error: "unavailable" } }, { status: 200, body: [MACHINE] }], { maxAttempts: 1 });
    expect((await found.client.createMachine(CREATE)).id).toBe("m_1");
    expect(found.calls.map((c) => c.init.method)).toEqual(["POST", "GET"]);
    // I6: on the LAST attempt an empty list is about to become `retryable: true`, so it is
    // confirmed once after a settle — hence the second GET and the settle in `sleeps`.
    const none = rig([{ status: 503, body: { error: "unavailable" } }, { status: 200, body: [] }, { status: 200, body: [] }], { maxAttempts: 1 });
    await expect(none.client.createMachine(CREATE)).rejects.toMatchObject({ status: 503, retryable: true, attempts: 1 });
    expect(none.calls.map((c) => c.init.method)).toEqual(["POST", "GET", "GET"]);
    expect(none.sleeps).toEqual([50]);
    // The domain reads `retryable` as permission to create attempt + 1; a lookup that could not answer must not grant it.
    const blind = rig([{ status: 503, body: { error: "unavailable" } }, { status: 500, body: { error: "list down" } }], { maxAttempts: 1 });
    await expect(blind.client.createMachine(CREATE)).rejects.toMatchObject({ status: 503, retryable: false });
  });

  it("a lookup that fails BEFORE the last attempt is not absence either — the retry is REFUSED, not granted", async () => {
    // The I6 confirm runs on the LAST attempt only, so it cannot cover for the first
    // lookup. Found by the fix-round sweep: mutant M10 (`listMachines().catch(() => [])`)
    // survived every other case here, because every one of them was a last attempt and
    // the confirm caught the swallowed failure. Mid-ladder, a list that could not answer
    // must be `unknown` too — otherwise the client posts a second create it cannot justify.
    const r = rig([{ status: 503, body: { error: "unavailable" } }, { status: 500, body: { error: "list down" } }], { maxAttempts: 4 });
    await expect(r.client.createMachine(CREATE)).rejects.toMatchObject({
      status: 503, retryable: false, attempts: 1, message: expect.stringContaining("create outcome unknown"),
    });
    expect(r.calls.map((c) => c.init.method)).toEqual(["POST", "GET"]);   // there is no attempt 2
    expect(r.sleeps).toEqual([]);                                         // and no backoff was waited
  });

  it("a create that ends at the DEADLINE reports retryable only on a CONFIRMED absence — the third terminal exit", async () => {
    // Re-review N-C1. `retryable: true` out of a create is the domain's licence to create
    // attempt + 1 under a DIFFERENT name (`relay-<sid>-r2`), which Fly will NOT refuse, so it is
    // only ever safe on an absence that was CONFIRMED. The deadline is a terminal exit like
    // maxAttempts, and it used to hand out that licence on one unsettled list.
    //
    // (a) The deadline is FORESEEABLE — the next wait already ends past it — so the lookup is
    // told this is the end and the settle + confirm runs. The absence is established, and the
    // retryable deadline error is earned.
    const foreseen = rig([{ status: 503, body: { error: "down" } }, { status: 200, body: [] }, { status: 200, body: [] }],
      { deadlineMs: 100, maxAttempts: 4 });
    await expect(foreseen.client.createMachine(CREATE)).rejects.toMatchObject({ code: "deadline", retryable: true, attempts: 1 });
    expect(foreseen.calls.map((c) => c.init.method)).toEqual(["POST", "GET", "GET"]);   // the confirm ran
    expect(foreseen.sleeps).toEqual([50]);                                              // the settle, not a backoff
    // (b) The deadline is NOT foreseeable: the lookup itself is what consumes the budget. The
    // absence was observed once, unsettled and unconfirmed — so the error is NOT retryable.
    const raced = rig([{ status: 503, body: { error: "down" } }, { status: 200, body: [], clockJumpMs: 20_000 }],
      { deadlineMs: 10_000, maxAttempts: 4 });
    const e = await raced.client.createMachine(CREATE).catch((x: unknown) => x as FlyApiError);
    expect(e).toMatchObject({ code: "deadline", retryable: false, attempts: 1 });
    expect(e.message).toContain("absence was never confirmed");
    expect(raced.calls.map((c) => c.init.method)).toEqual(["POST", "GET"]);
    expect(raced.sleeps).toEqual([]);
    // (c) An op that cannot create anything keeps the plain retryable deadline — see the
    // `listMachines` deadline test above, which this must not have changed.
  });

  it("C1: a create whose metadata carries no seazn_session is NOT retryable — no lookup is possible, and 'nobody looked' is never 'nothing there'", async () => {
    // The type now demands the key; a cast walks past a type, so the runtime refusal is what is
    // pinned here. Before the fix this threw { retryable: true } after ZERO GETs (methods
    // ["POST","POST"]) and the domain would have taken that as proof Fly holds no Machine.
    const keyless = { ...CREATE, config: { ...CREATE.config, metadata: { some_other_key: "v" } } } as unknown as MachineCreateInput;
    const r = rig([{ status: 503, body: { error: "unavailable" } }, { status: 503, body: { error: "unavailable" } }]);
    await expect(r.client.createMachine(keyless)).rejects.toMatchObject({ status: 503, retryable: false, attempts: 1 });
    expect(r.calls.map((c) => c.init.method)).toEqual(["POST"]);      // it never even tried a lookup
    const empty = { ...CREATE, config: { ...CREATE.config, metadata: {} } } as unknown as MachineCreateInput;
    const r2 = rig([{ status: 502, body: { error: "bad gateway" } }]);
    await expect(r2.client.createMachine(empty)).rejects.toMatchObject({ status: 502, retryable: false });
  });

  it("I6: the last attempt's empty lookup is CONFIRMED after a settle — a Machine that only appears on the second look is returned, and a confirm that cannot answer is not retryable", async () => {
    // Unsettled list, then the Machine shows up: adopted, no retryable error.
    const late = rig([{ status: 503, body: { error: "unavailable" } }, { status: 200, body: [] }, { status: 200, body: [MACHINE] }], { maxAttempts: 1 });
    expect((await late.client.createMachine(CREATE)).id).toBe("m_1");
    expect(late.calls.map((c) => c.init.method)).toEqual(["POST", "GET", "GET"]);
    expect(late.sleeps).toEqual([50]);
    // The confirm itself cannot answer → "we still do not know" → NOT retryable.
    const blindConfirm = rig([{ status: 503, body: { error: "unavailable" } }, { status: 200, body: [] }, { status: 500, body: { error: "list down" } }], { maxAttempts: 1 });
    await expect(blindConfirm.client.createMachine(CREATE)).rejects.toMatchObject({ status: 503, retryable: false });
    // BEFORE the last attempt there is no confirm: an empty list just permits another POST,
    // which Fly refuses 409 rather than duplicating.
    const early = rig([{ status: 503, body: { error: "x" } }, { status: 200, body: [] }, { status: 200, body: MACHINE }], { maxAttempts: 4 });
    expect((await early.client.createMachine(CREATE)).id).toBe("m_1");
    expect(early.calls.map((c) => c.init.method)).toEqual(["POST", "GET", "POST"]);
    expect(early.sleeps).toEqual([250]);      // the jittered backoff alone — no settle
  });

  it("I3: the backoff ladder is capped by maxBackoffMs and floored to whole ms — the full ladder at maxAttempts 7", async () => {
    // random 0.4999 so every product is fractional: Math.floor has to bind too. The cap binds
    // from attempt 5 (baseBackoffMs × 2^4 = 8000 = maxBackoffMs) and REFUSES 16000 at attempt 6.
    const r = rig(Array.from({ length: 9 }, () => ({ status: 503, body: { error: "down" } })), {
      deadlineMs: 1_000_000, maxAttempts: 7, random: () => 0.4999,
    });
    await expect(r.client.listMachines()).rejects.toMatchObject({ status: 503, attempts: 7 });
    expect(r.sleeps).toEqual([249, 499, 999, 1999, 3999, 3999]);
    for (const s of r.sleeps) expect(Number.isInteger(s), String(s)).toBe(true);
  });

  it("I4: a Retry-After that is an HTTP-date is REFUSED, and the jittered backoff is used instead", async () => {
    // Retry-After is legally an HTTP-date. A loose /\d+/ would make Number(...) NaN, the deadline
    // comparison false, and sleep(NaN) a hot loop against the rate limiter that sent it.
    const r = rig([{ status: 429, body: { error: "rate" }, headers: { "retry-after": "Wed, 21 Oct 2026 07:28:00 GMT" } }, { status: 200, body: [MACHINE] }]);
    await r.client.listMachines();
    expect(r.sleeps).toEqual([250]);
    const rec = new FakeRecorder();
    const r2 = rig([{ status: 429, body: { error: "rate" }, headers: { "retry-after": "Wed, 21 Oct 2026 07:28:00 GMT" } }, { status: 200, body: [MACHINE] }], { recorder: rec });
    await r2.client.listMachines();
    await new Promise((res) => setImmediate(res));
    expect(rec.calls[0]!.retryAfterSeconds).toBeNull();
  });
});

describe("FlyClient — the per-request timeout covers the BODY (C2)", () => {
  it("a response whose body never arrives times out at requestTimeoutMs instead of hanging for ever", async () => {
    // The stalled stream does not honour the AbortSignal, so this fails unless the client bounds
    // the read itself. Before the fix the abort timer was cleared the instant headers arrived and
    // the promise had not settled after 3 s — a create that returns no outcome AT ALL.
    const r = rig([{ status: 200, stallBody: true }], { requestTimeoutMs: 50, maxAttempts: 1 });
    const settled = await Promise.race([
      r.client.getMachine("m_1").then(() => "resolved").catch((e: unknown) => `rejected:${(e as FlyApiError).code}`),
      new Promise((res) => setTimeout(() => res("HUNG"), 2000)),
    ]);
    expect(settled).toBe("rejected:timeout");
  });

  it("a stalled body on a create is still an AMBIGUOUS failure: it is looked up, not reported as absent", async () => {
    const r = rig([{ status: 200, stallBody: true }, { status: 200, body: [MACHINE] }], { requestTimeoutMs: 50 });
    const m = await r.client.createMachine(CREATE);
    expect(m.id).toBe("m_1");
    expect(r.calls.map((c) => c.init.method)).toEqual(["POST", "GET"]);
  });
});

describe("FlyClient — the budget config.ts derives (I5)", () => {
  it("the provisioning budget HOLDS against this client's DECLARED defaults, and moving one moves this gate", () => {
    const d = FLY_CLIENT_DEFAULTS;
    let ladder = 0;
    for (let n = 1; n < d.maxAttempts; n++) ladder += Math.min(d.maxBackoffMs, d.baseBackoffMs * 2 ** (n - 1));
    const allAttempts = d.maxAttempts * d.requestTimeoutMs + ladder;          // listMachines' own worst case
    // `deadlineMs` gates only the decision to SLEEP, so an operation overruns it by whatever is
    // still in flight — and createMachine pays a NESTED lookup after every ambiguous attempt,
    // plus, on the last one, the I6 settle and its single-attempt confirm.
    const createWorstMs = d.deadlineMs + d.requestTimeoutMs + allAttempts + d.lookupSettleMs + d.requestTimeoutMs;
    expect(createWorstMs).toBeLessThan(PROVISION_TIMEOUT_SECONDS * 1000);
    // Teardown: neither stop nor destroy performs the nested lookup.
    const stopOrDestroyWorstMs = d.deadlineMs + d.requestTimeoutMs;
    const teardownWorstMs = (RUNNER_STOP_GRACE_SECONDS + RUNNER_OBSERVE_SLACK_SECONDS) * 1000 + 2 * stopOrDestroyWorstMs;
    expect(teardownWorstMs).toBeLessThan(ENDING_TIMEOUT_SECONDS * 1000);
  });
});

describe("FlyClient — the lifecycle endpoints (stop, signal, events)", () => {
  it("stopMachine POSTs { signal, timeout: '<n>s' } to /stop; 404 resolves (already gone); 500 rejects", async () => {
    const r = rig([{ status: 200 }, { status: 404, body: { error: "not found" } }, { status: 500, body: { error: "x" } }]);
    await r.client.stopMachine("m_1", { signal: "SIGINT", timeoutSeconds: 10 });
    expect(r.calls[0]!.url).toBe(`${FLY_MACHINES_BASE}/apps/seazn-relay/machines/m_1/stop`);
    expect(JSON.parse(String(r.calls[0]!.init.body))).toEqual({ signal: "SIGINT", timeout: "10s" });
    await expect(r.client.stopMachine("m_gone", { signal: "SIGINT", timeoutSeconds: 10 })).resolves.toBeUndefined();
    await expect(r.client.stopMachine("m_bad", { signal: "SIGINT", timeoutSeconds: 10 })).rejects.toBeInstanceOf(FlyApiError);
  });
  it("signalMachine POSTs the spec's enum value", async () => {
    const r = rig([{ status: 200 }]);
    await r.client.signalMachine("m_1", "SIGKILL");
    expect(r.calls[0]!.url).toBe(`${FLY_MACHINES_BASE}/apps/seazn-relay/machines/m_1/signal`);
    expect(JSON.parse(String(r.calls[0]!.init.body))).toEqual({ signal: "SIGKILL" });
  });
  it("machineEvents parses defensively: an exit event with exit_code/oom_killed/requested_stop, one without, and no events at all", async () => {
    const r = rig([
      { status: 200, body: [{ id: "e1", type: "start", status: "started", source: "flyd", timestamp: 1 }, { id: "e2", type: "exit", status: "stopped", source: "flyd", timestamp: 2, request: { exit_event: { exit_code: 137, oom_killed: true, requested_stop: false } } }] },
      { status: 200, body: [{ id: "e3", type: "exit", status: "stopped", source: "flyd", timestamp: 3, request: {} }] },
      { status: 200, body: [] },
      // The REAL payload, captured live 2026-09-20: NEWEST FIRST, `request` is
      // `null` on launch/destroy events, and the exit payload carries the three
      // named fields beside guest_*/signal/error/restarting/exited_at. Two exits
      // here, so the newest must win: an oldest-first `reverse().find()` hands
      // back the 137.
      { status: 200, body: [
        { id: "x1", type: "destroy", status: "destroyed", source: "flyd", timestamp: 5, request: null },
        { id: "x2", type: "exit", status: "stopped", source: "flyd", timestamp: 4, request: { exit_event: { requested_stop: true, restarting: false, guest_exit_code: 0, guest_signal: -1, guest_error: "", exit_code: 0, signal: -1, error: "", oom_killed: false, exited_at: "2026-09-20T11:02:55.102Z" }, restart_count: 0 } },
        { id: "x3", type: "start", status: "started", source: "flyd", timestamp: 3, request: {} },
        { id: "x4", type: "exit", status: "stopped", source: "flyd", timestamp: 2, request: { exit_event: { exit_code: 137, oom_killed: true, requested_stop: false } } },
        { id: "x5", type: "launch", status: "created", source: "user", timestamp: 1, request: null },
      ] },
    ]);
    expect(exitInfoFrom(await r.client.machineEvents("m_1"))).toEqual({ exitCode: 137, oomKilled: true, requestedStop: false });
    expect(r.calls[0]!.url).toBe(`${FLY_MACHINES_BASE}/apps/seazn-relay/machines/m_1/events`);
    expect(exitInfoFrom(await r.client.machineEvents("m_1"))).toEqual({ exitCode: null, oomKilled: null, requestedStop: null });
    expect(exitInfoFrom(await r.client.machineEvents("m_1"))).toBeNull();
    // The live shape: it PARSES (a `request: null` must not red the array), and
    // the NEWEST exit is the one reported.
    const live = await r.client.machineEvents("m_1");
    expect(live).toHaveLength(5);
    expect(exitInfoFrom(live)).toEqual({ exitCode: 0, oomKilled: false, requestedStop: true });
  });
});

describe("FlyClient — boundary parsing, request id, redaction", () => {
  it("a malformed body is a typed error, never an undefined field", async () => {
    const r = rig([{ status: 200, body: { nope: true } }]);
    await expect(r.client.createMachine(CREATE)).rejects.toMatchObject({ code: "malformed", retryable: false });
    const r2 = rig([{ status: 200, body: "not json {" }]);
    await expect(r2.client.listMachines()).rejects.toMatchObject({ code: "malformed" });
  });

  // Lane-A minors, Task 5A review m2: the attempt row used to be written ABOVE the
  // parse, so a 2xx whose body we could not read left a row saying the call
  // SUCCEEDED (status 200, errorCode null) and then threw `malformed`. The ledger is
  // what Task 17 reconciles against the provider, and `malformed` is one of the three
  // codes `isUnestablishedCreate` treats as "the create's outcome was never
  // established" — so a row calling it a success is the ledger disagreeing with the
  // money decision taken off the same event.
  it("a 2xx body we could not parse is recorded as an ATTEMPT THAT FAILED, not as a success (the row carries errorCode malformed)", async () => {
    const rec = new FakeRecorder();
    const r = rig([{ status: 200, body: { nope: true } }], { recorder: rec });
    await expect(r.client.createMachine(CREATE)).rejects.toMatchObject({ code: "malformed" });
    expect(rec.calls).toHaveLength(1);
    expect(rec.calls[0]).toMatchObject({ operation: "createMachine", status: 200, errorCode: "malformed", retryReason: null });
    // The positive twin, or the assertion passes just as happily if every row said
    // "malformed": a 2xx we COULD parse still records the clean success row.
    const ok = new FakeRecorder();
    const r2 = rig([{ status: 200, body: MACHINE }], { recorder: ok });
    await r2.client.createMachine(CREATE);
    expect(ok.calls[0]).toMatchObject({ status: 200, errorCode: null });
    // …and a body-less 2xx (no schema — destroy/stop) keeps its clean row: the parse
    // never runs there, so `malformed` must not leak onto it.
    const noSchema = new FakeRecorder();
    const r3 = rig([{ status: 200 }], { recorder: noSchema });
    await r3.client.destroyMachine("m_1");
    expect(noSchema.calls[0]).toMatchObject({ operation: "destroyMachine", status: 200, errorCode: null });
  });
  it("carries fly-request-id from the response header when present, null otherwise", async () => {
    const r = rig([{ status: 500, body: { error: "x" }, headers: { "fly-request-id": "01HREQ" } }, { status: 500, body: { error: "x" } }]);
    await expect(r.client.getMachine("m")).rejects.toMatchObject({ requestId: "01HREQ" });
    await expect(r.client.getMachine("m")).rejects.toMatchObject({ requestId: null });
  });
  it("redaction: no secret ever appears in a message, a cause or a log line", async () => {
    const r = rig([{ status: 400, body: { error: "bad env value stream-key-SECRET for token fly-token-SECRET" } }]);
    let thrown: unknown;
    try { await r.client.createMachine(CREATE); } catch (e) { thrown = e; }
    const err = thrown as FlyApiError & { cause?: unknown };
    expect(err).toBeInstanceOf(FlyApiError);
    const everything = JSON.stringify({ message: err.message, cause: String(err.cause ?? ""), stack: err.stack ?? "" });
    expect(everything).not.toContain("stream-key-SECRET");
    expect(everything).not.toContain("fly-token-SECRET");
    expect(err.message).toContain("[redacted]"); // the positive twin: something WAS redacted
    expect(redact("a stream-key-SECRET b", ["stream-key-SECRET"])).toBe("a [redacted] b");
  });

  it("a secret carried ONLY in the request's config.env — never declared in `secrets` — is redacted too (C25)", async () => {
    // The job token is minted per session and handed to the Machine through
    // config.env; it can never be in the constructor's `secrets` list. Fly
    // echoes a rejected env value straight back in the error body, so without
    // the per-request redaction this message would print a live job token.
    const r = rig([{ status: 400, body: { error: "rejected env JOB_TOKEN=job-token-ONLY-IN-ENV" } }], { secrets: [] });
    let thrown: unknown;
    try {
      await r.client.createMachine({ ...CREATE, config: { ...CREATE.config, env: { JOB_TOKEN: "job-token-ONLY-IN-ENV" } } });
    } catch (e) { thrown = e; }
    const err = thrown as FlyApiError;
    expect(err.status).toBe(400);
    expect(err.message).not.toContain("job-token-ONLY-IN-ENV");
    expect(err.message).toContain("[redacted]");   // positive twin
  });
});

describe("FlyClient — the provider-call ledger (ruling 13)", () => {
  it("records one row per ATTEMPT: 429 (Retry-After 3) then 200 → two records, attempt 1 status 429 retryReason status_429 retryAfterSeconds 3, attempt 2 status 200; a timeout records status null / timeout; the token is in no record", async () => {
    const rec = new FakeRecorder();
    const r = rig(
      [
        { status: 429, headers: { "retry-after": "3", "fly-request-id": "req-1" }, body: { error: "rate limited" } },
        { status: 200, headers: { "fly-request-id": "req-2" }, body: { ...MACHINE, state: "started" } },
      ],
      { recorder: rec },
    );
    await r.client.getMachine("m_1");
    await new Promise((res) => setImmediate(res));
    expect(rec.calls.map((c) => [c.operation, c.attempt, c.status, c.retryReason, c.retryAfterSeconds, c.requestId])).toEqual([
      ["getMachine", 1, 429, "status_429", 3, "req-1"], ["getMachine", 2, 200, null, null, "req-2"],
    ]);
    expect(rec.calls[0]!.ids).toEqual(["seazn-relay", "m_1"]);
    expect(rec.calls[0]!.subjectId).toBe("m_1");
    for (const c of rec.calls) expect(JSON.stringify(c)).not.toContain("fly-token-SECRET");
    // A request that never answers: the AbortSignal fires, and the attempt is
    // still recorded — status null, errorCode timeout.
    const t = rig([{ status: 200, body: MACHINE, delayMs: 5000 }], { requestTimeoutMs: 50, maxAttempts: 1, recorder: rec });
    await expect(t.client.getMachine("m_2")).rejects.toMatchObject({ code: "timeout" });
    await new Promise((res) => setImmediate(res));
    expect(rec.calls.at(-1)).toMatchObject({ operation: "getMachine", status: null, errorCode: "timeout", retryReason: "timeout", attempt: 1 });
  });

  // Lane-A minors, Task 5A review m3: an explicit `recorder: undefined` really does
  // overwrite the constructor's `NOOP_RECORDER` default through the `...opts` spread —
  // every optional-parameter rig in this wave passes exactly that — so the branch IS
  // taken. What the review asked for, a killer, does not exist and cannot: see the
  // comment at `record()`. This `it` pins the half that IS observable, that a client
  // built with no recorder still completes its calls.
  it("a client constructed with an explicit `recorder: undefined` still completes its calls (the record fallback absorbs it)", async () => {
    const r = rig([{ status: 200, body: MACHINE }], { recorder: undefined });
    await expect(r.client.getMachine("m_1")).resolves.toMatchObject({ id: "m_1" });
    await new Promise((res) => setImmediate(res));   // the record is fire-and-forget; let it run
  });
});
