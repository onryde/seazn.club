// The Fly runner adapter (Task 5) over Task 5A's client, and driver selection.
//
// This file OPENS with the budget, because the budget is the one thing that has
// to be right before a wait ever lands (carry T5-d/T5-e): `PROVISION_TIMEOUT_SECONDS`
// bounds the `provisioning` state, and Task 5A's gate only ever bounded
// `createMachine` ALONE. The composed create + `waitMachine(started)` path costs
// more than that constant used to allow, so the expiry sweep would have failed a
// create the client was still legitimately running — a provisioning failure that
// looks like Fly being slow.
//
// Everything below the budget is the adapter itself. C7 / design §7.1 D4 +
// recommendation B: the create body carries the OWNER-ruled guest
// (performance-4x / 8 GB), auto_destroy: true, restart.policy "no" (any other
// policy puts two compositors on one stream key), the deterministic
// attempt-carrying name and the session metadata (the client's idempotency), and
// RELAY_DEADLINE_AT (the Machine-side hard stop). The adapter is tested through a
// FlyClient whose fetch is scripted — the retry/redaction claims are the client's
// own tests; what is proved here is that `FlyRunner` routes through them.
import { describe, expect, it, vi } from "vitest";
import { FLY_CLIENT_DEFAULTS, FLY_MACHINES_BASE, FlyApiError, FlyClient } from "../fly-client";
import { ENDING_TIMEOUT_SECONDS, PROVISION_TIMEOUT_SECONDS, RUNNER_DEFAULT_GUEST, RUNNER_DEFAULT_REGION, RUNNER_OBSERVE_SLACK_SECONDS, RUNNER_STOP_GRACE_SECONDS } from "../config";
import { CREATE_OUTCOME_UNKNOWN, FLY_STATE_MAP, FlyRunner, SESSION_METADATA_KEY, cpuKindFor, fromFlyState, isUnestablishedCreate } from "../runner-fly";
import { OBSERVED_STATES, machineNameFor } from "../domain/runner";
import { relayDrivers, setRelayDriversForTest } from "../drivers";
import { FakeIngest, FakeRecorder, FakeRunner } from "../fakes";
import { CloudflareIngest } from "../ingest-cf";
import type { RunnerSpec } from "../ports";

// Ruling 13: `drivers.ts` binds the PRODUCTION recorder into every adapter it
// builds, fake branch included. Mocking the telemetry module lets the last `it`
// witness that binding with no database. `vi.hoisted` is required — a vi.mock
// factory that closes over an ordinary module const makes the whole FILE fail to
// collect, which reads as "0 tests" rather than as an error.
// The stub is `async` and takes its real two arguments: `dbRecorder` wraps the
// result, and the binding `it` reads the SECOND one (the payload).
const telemetry = vi.hoisted(() => ({
  recordProviderCall: vi.fn<(exec: unknown, call: Record<string, unknown>) => Promise<void>>(async () => {}),
}));
vi.mock("../telemetry", () => ({ recordProviderCall: telemetry.recordProviderCall }));

/** `process.env.X = saved` stores the STRING "undefined" when `saved` is
 *  undefined, which leaves a truthy bogus value behind for every later file in
 *  the same vitest process — and a "refuses to construct without env" guard then
 *  stops refusing. Restore through this, never by assignment. */
function restoreEnv(entries: Record<string, string | undefined>): void {
  for (const [k, v] of Object.entries(entries)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
}

/** The value `PROVISION_TIMEOUT_SECONDS` held until 2026-09-20, when the composed
 *  path was costed. Named, not inlined, so the assertion below reads as the finding
 *  it is: the old number could NOT cover create + wait. */
const PROVISION_BEFORE_COMPOSED_SECONDS = 120;
/** `waitMachine`'s own default `timeoutSeconds`, and Fly's documented+measured cap
 *  for `/wait` (90 → HTTP 400 invalid_argument, measured 2026-09-20). It is a
 *  parameter default in `fly-client.ts`, not an exported constant, so it is spelled
 *  here with its source rather than imported. */
const FLY_WAIT_CAP_SECONDS = 60;

describe("the provisioning budget the COMPOSED create + wait path needs (carry T5-d/T5-e)", () => {
  it("create + waitMachine(started) fits inside PROVISION_TIMEOUT_SECONDS with a whole requestTimeoutMs of slack — and does NOT fit the 120 s that constant held before", () => {
    // Recomputed from the client's DECLARED defaults, never from a number typed
    // here (failure class 20): raising one of those moves this gate with it.
    const d = FLY_CLIENT_DEFAULTS;
    let ladder = 0;
    for (let n = 1; n < d.maxAttempts; n++) ladder += Math.min(d.maxBackoffMs, d.baseBackoffMs * 2 ** (n - 1));
    const allAttempts = d.maxAttempts * d.requestTimeoutMs + ladder;
    // Task 5A's term, unchanged: `deadlineMs` gates only the decision to SLEEP, so
    // an operation overruns it by whatever is in flight, and `createMachine` pays a
    // nested `listMachines` plus the I6 settle + confirming re-list on the last attempt.
    const createWorstMs = d.deadlineMs + d.requestTimeoutMs + allAttempts + d.lookupSettleMs + d.requestTimeoutMs;
    // The wait is a separate operation with its own deadline and NO nested lookup.
    // Its long poll has to fit inside `requestTimeoutMs` (the `it` below drives what
    // happens when it does not), so one in-flight attempt is all it can overrun by.
    const waitWorstMs = d.deadlineMs + d.requestTimeoutMs;
    const composedWorstMs = createWorstMs + waitWorstMs;
    expect(composedWorstMs).toBeLessThan(PROVISION_TIMEOUT_SECONDS * 1000);
    // Brief step 5b(b): the worst case plus one whole `requestTimeoutMs` of slack,
    // so the sweep can never fail a create the client is still retrying.
    expect(composedWorstMs + d.requestTimeoutMs).toBeLessThanOrEqual(PROVISION_TIMEOUT_SECONDS * 1000);
    // The positive twin, and the reason the constant moved: the old value is BELOW
    // the composed cost. Without this line the gate passes just as happily at 120.
    expect(composedWorstMs).toBeGreaterThan(PROVISION_BEFORE_COMPOSED_SECONDS * 1000);
  });

  it("a wait whose long poll outlasts the client's own per-request budget is not a wait at all: it reads as a timeout (which is why the sizing is owed here)", async () => {
    // Carry T5-e: Task 5A documented the hazard and deliberately did not clamp it.
    // This is the sizing, driven rather than described — ask Fly to hold the
    // connection for longer than `requestTimeoutMs` and OUR AbortSignal fires first.
    const hanging = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      await new Promise<never>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(Object.assign(new Error("aborted"), { name: "AbortError" })));
      });
      throw new Error("unreachable");
    }) as unknown as typeof fetch;
    const tooLong = new FlyClient({ token: "t", app: "seazn-relay", fetchImpl: hanging, sleep: async () => {}, random: () => 0, requestTimeoutMs: 50, maxAttempts: 1 });
    await expect(tooLong.waitMachine("m_1", "started", FLY_WAIT_CAP_SECONDS)).rejects.toMatchObject({ code: "timeout", retryable: true });
    // The positive pair: a wait that ANSWERS inside the budget is a real wait, and
    // it answers with the spec's WaitMachineResponse (not a Machine — measured 5A).
    const answering = vi.fn(async () => new Response(JSON.stringify({ ok: true, state: "started" }), { status: 200, headers: { "content-type": "application/json" } })) as unknown as typeof fetch;
    const sized = new FlyClient({ token: "t", app: "seazn-relay", fetchImpl: answering, sleep: async () => {}, random: () => 0, requestTimeoutMs: 50, maxAttempts: 1 });
    expect(await sized.waitMachine("m_1", "started", 1)).toEqual({ ok: true, state: "started" });
    // …and the pair's point: the client's DEFAULT per-request budget cannot hold
    // `waitMachine`'s DEFAULT poll, so no caller may use the two together.
    expect(FLY_CLIENT_DEFAULTS.requestTimeoutMs).toBeLessThan(FLY_WAIT_CAP_SECONDS * 1000);
  });

  it("the same reasoning at the other end: a teardown that also waits still fits ENDING_TIMEOUT_SECONDS", () => {
    // Task 5A checked `stop + destroy`. C1 measured that a destroyed Machine still
    // GETs 200 `destroyed` and that `destroying` can follow `wait destroyed`, so the
    // task that tears down may well compose a wait there too. Neither stop nor
    // destroy performs the create's nested lookup, so each is one bounded operation.
    const d = FLY_CLIENT_DEFAULTS;
    const oneOperationMs = d.deadlineMs + d.requestTimeoutMs;
    const teardownWithWaitMs = (RUNNER_STOP_GRACE_SECONDS + RUNNER_OBSERVE_SLACK_SECONDS) * 1000 + 3 * oneOperationMs;
    expect(teardownWithWaitMs).toBeLessThan(ENDING_TIMEOUT_SECONDS * 1000);
  });
});

function scripted(reply: (url: string, init: RequestInit) => { status: number; body?: unknown }) {
  const calls: { url: string; init: RequestInit }[] = [];
  const fetchImpl = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    const c = { url: String(url), init: init ?? {} };
    calls.push(c);
    const r = reply(c.url, c.init);
    return new Response(r.body === undefined ? null : JSON.stringify(r.body), { status: r.status, headers: { "content-type": "application/json" } });
  }) as unknown as typeof fetch;
  // `secrets: []` on purpose. The job token is minted per session and travels in
  // `config.env`; it can NEVER be in a constructor list, so leaving the list empty
  // is what makes the redaction `it` below prove the per-request path (C25) rather
  // than the ordinary one.
  const client = new FlyClient({ token: "fly-token", app: "seazn-relay", fetchImpl, sleep: async () => {}, random: () => 0, secrets: [] });
  return { calls, client };
}

const SPEC: RunnerSpec = {
  sessionId: "11111111-2222-4333-8444-555555555555", attempt: 1, jobToken: "jwt-SECRET", appUrl: "https://seazn.club",
  guest: RUNNER_DEFAULT_GUEST, region: RUNNER_DEFAULT_REGION, deadlineAt: new Date("2026-09-14T15:00:00Z"),
};
const NAME = machineNameFor(SPEC.sessionId, SPEC.attempt);

describe("FlyRunner", () => {
  it("create maps the RunnerSpec 1:1 onto the Machines body: C7 values, the domain's attempt-carrying name, session metadata, RELAY_DEADLINE_AT (B)", async () => {
    const s = scripted(() => ({ status: 200, body: { id: "m_123", name: NAME, state: "created" } }));
    const runner = new FlyRunner({ client: s.client, image: "registry.fly.io/seazn-relay:abc" });
    const h = await runner.create(SPEC);
    expect(h).toEqual({ runnerId: "m_123" });
    const c = s.calls[0]!;
    expect(c.url).toBe(`${FLY_MACHINES_BASE}/apps/seazn-relay/machines`);
    expect(c.init.method).toBe("POST");
    expect(JSON.parse(String(c.init.body))).toEqual({
      name: `relay-${SPEC.sessionId}-r1`,
      region: "lhr",
      config: {
        image: "registry.fly.io/seazn-relay:abc",
        guest: { cpus: 4, memory_mb: 8192, cpu_kind: "performance" },
        auto_destroy: true,
        restart: { policy: "no" },
        env: { SESSION_ID: SPEC.sessionId, JOB_TOKEN: "jwt-SECRET", APP_URL: "https://seazn.club", RELAY_DEADLINE_AT: "2026-09-14T15:00:00.000Z" },
        metadata: { [SESSION_METADATA_KEY]: SPEC.sessionId },
      },
    });
    // The defaults themselves are the ruled values — a mutant editing config.ts dies here.
    expect(RUNNER_DEFAULT_GUEST).toEqual({ cpus: 4, memoryMb: 8192, cpuClass: "dedicated" });
    expect(RUNNER_DEFAULT_REGION).toBe("lhr");
  });

  it("cpuClass is the port's word; Fly's spelling appears only through cpuKindFor", () => {
    expect(cpuKindFor("dedicated")).toBe("performance");
    expect(cpuKindFor("shared")).toBe("shared");
  });

  it("fromFlyState: every documented Fly state maps to exactly one observed input (parity over the exported map); anything else is unknown, never running", () => {
    // fly.io/docs/machines/machine-states, RE-FETCHED 2026-09-20 for this task —
    // the page lists exactly these seventeen and marks none deprecated. A state
    // missing from the map is a red here, not a silent `unknown`.
    const documented = ["created", "creating", "starting", "started", "stopping", "stopped", "restarting", "suspending", "suspended", "replacing", "updating", "launch_failed", "failed", "destroying", "destroyed", "replaced", "migrated"];
    for (const f of documented) expect(OBSERVED_STATES, f).toContain(FLY_STATE_MAP[f]);
    expect(Object.keys(FLY_STATE_MAP).sort()).toEqual([...documented].sort());
    expect(fromFlyState("started")).toBe("running");
    expect(fromFlyState("created")).toBe("pending");
    expect(fromFlyState("launch_failed")).toBe("failed");
    expect(fromFlyState("replaced")).toBe("destroyed");
    expect(fromFlyState("hibernating")).toBe("unknown");
    expect(fromFlyState(null)).toBe("unknown");
    expect(fromFlyState(undefined)).not.toBe("running");
  });

  it("stop POSTs the SIGINT stop with the grace; observe maps GET + events to { state, exit }; an absent Machine observes as destroyed", async () => {
    const s = scripted((url, init) => {
      if (url.endsWith("/stop")) return { status: 200 };
      if (url.endsWith("/events")) return { status: 200, body: [{ id: "e1", type: "exit", status: "stopped", source: "flyd", timestamp: 1, request: { exit_event: { exit_code: 0, oom_killed: false, requested_stop: true } } }] };
      if (url.endsWith("/machines/m_gone")) return { status: 404, body: { error: "not found" } };
      if (init.method === "GET") return { status: 200, body: { id: "m_1", name: "relay-x-r1", state: "stopped" } };
      return { status: 500, body: { error: "unexpected" } };
    });
    const runner = new FlyRunner({ client: s.client, image: "img" });
    await runner.stop("m_1", { signal: "SIGINT", timeoutSeconds: 10 });
    expect(s.calls[0]!.url).toBe(`${FLY_MACHINES_BASE}/apps/seazn-relay/machines/m_1/stop`);
    expect(JSON.parse(String(s.calls[0]!.init.body))).toEqual({ signal: "SIGINT", timeout: "10s" });
    // T5-f: `requestedStop` is PRODUCED here and pinned. Nothing READS it yet —
    // `failReasonFromExit` ignores it — so the consumer side stays owed by Task 10.
    expect(await runner.observe("m_1")).toEqual({ state: "stopped", exit: { exitCode: 0, oomKilled: false, requestedStop: true } });
    expect(await runner.observe("m_gone")).toEqual({ state: "destroyed", exit: null });
  });

  it("a DESTROYED Machine answers GET 200, not 404 (C1, measured) — observe still reads its exit off the events", async () => {
    // The brief's premise was that a gone Machine 404s. It does not: `state:
    // "destroyed"` comes back 200, and 404 means the id NEVER existed. An observe
    // keyed on 404 alone would return `exit: null` here and the session would fail
    // as `machine_crash` instead of `machine_exit_nonzero`.
    const s = scripted((url) => {
      if (url.endsWith("/events")) return { status: 200, body: [
        { id: "x1", type: "destroy", status: "destroyed", source: "flyd", timestamp: 5, request: null },
        { id: "x2", type: "exit", status: "stopped", source: "flyd", timestamp: 4, request: { exit_event: { exit_code: 1, oom_killed: false, requested_stop: false } } },
      ] };
      return { status: 200, body: { id: "m_dead", name: NAME, state: "destroyed" } };
    });
    const runner = new FlyRunner({ client: s.client, image: "img" });
    expect(await runner.observe("m_dead")).toEqual({ state: "destroyed", exit: { exitCode: 1, oomKilled: false, requestedStop: false } });
    expect(s.calls.map((c) => c.url.replace(`${FLY_MACHINES_BASE}/apps/seazn-relay`, ""))).toEqual(["/machines/m_dead", "/machines/m_dead/events"]);
  });

  it("create is idempotent per session through the client: a 503 on the POST is followed by a metadata lookup that finds the Machine — no second POST", async () => {
    const s = scripted((_url, init) => {
      if (init.method === "POST") return { status: 503, body: { error: "unavailable" } };
      return { status: 200, body: [{ id: "m_existing", name: NAME, state: "started", config: { metadata: { [SESSION_METADATA_KEY]: SPEC.sessionId } } }] };
    });
    const runner = new FlyRunner({ client: s.client, image: "img" });
    expect(await runner.create(SPEC)).toEqual({ runnerId: "m_existing" });
    expect(s.calls.map((c) => c.init.method)).toEqual(["POST", "GET"]);
    expect(s.calls[1]!.url).toContain(`metadata.${SESSION_METADATA_KEY}=${SPEC.sessionId}`);
  });

  it("T5-c (SAFETY): a 409 already_exists ADOPTS the Machine the refusal names — it is never reported as a create failure", async () => {
    // 409 is non-retryable and is the ONE create error where a Machine DOES exist.
    // Reporting failure here strands a running compositor: the domain fails the
    // session, nothing holds the id, and it bills until the daily orphan sweep.
    const s = scripted((url, init) => {
      if (init.method === "POST") return { status: 409, body: { error: `already_exists: unique machine name violation, machine ID 148e306f3e1683 already exists with name "${NAME}"` } };
      if (url.endsWith("/machines/148e306f3e1683")) return { status: 200, body: { id: "148e306f3e1683", name: NAME, state: "started", config: { metadata: { [SESSION_METADATA_KEY]: SPEC.sessionId } } } };
      return { status: 500, body: { error: "the refusal's own id must be enough — no list should be needed" } };
    });
    const runner = new FlyRunner({ client: s.client, image: "img" });
    expect(await runner.create(SPEC)).toEqual({ runnerId: "148e306f3e1683" });
    expect(s.calls.map((c) => c.init.method)).toEqual(["POST", "GET"]);
  });

  it("T5-c: the adopt falls back to the session lookup when the refusal names no id, and REFUSES non-retryably when neither handle yields a Machine under THIS name", async () => {
    const viaLookup = scripted((_url, init) => {
      if (init.method === "POST") return { status: 409, body: { error: "already_exists: unique machine name violation" } };
      return { status: 200, body: [{ id: "m_earlier", name: "relay-other-r1", state: "started" }, { id: "m_mine", name: NAME, state: "started" }] };
    });
    // Matched by NAME, never `found[0]` — the session's metadata lists every attempt (T5-a).
    expect(await new FlyRunner({ client: viaLookup.client, image: "img" }).create(SPEC)).toEqual({ runnerId: "m_mine" });

    // The guard's defeating case: the refusal names a Machine that is NOT ours and
    // the lookup finds nothing. Adopting on the id alone would hand back a
    // stranger's Machine, which this session would then stop and destroy.
    const stranger = scripted((url, init) => {
      if (init.method === "POST") return { status: 409, body: { error: 'already_exists: unique machine name violation, machine ID m_stranger already exists with name "someone-elses"' } };
      if (url.endsWith("/machines/m_stranger")) return { status: 200, body: { id: "m_stranger", name: "someone-elses", state: "started" } };
      return { status: 200, body: [] };
    });
    const err = await new FlyRunner({ client: stranger.client, image: "img" }).create(SPEC).then(() => null, (e: unknown) => e as FlyApiError);
    expect(err).toBeInstanceOf(FlyApiError);
    expect(err!.status).toBe(409);
    expect(err!.retryable).toBe(false);
    expect(err!.message).toContain(NAME);
  });

  it("T5-g: a create whose OUTCOME was never established is marked as its own thing in telemetry and stays non-retryable", async () => {
    // The client downgrades a retryable failure whose lookup could not answer:
    // `retryable: true` out of a create is the domain's licence to create attempt+1
    // under a DIFFERENT name, so an unanswerable lookup must not grant it. That is
    // a different operational event from "Fly refused the create", and a transient
    // LIST outage now fails a session — so it gets its own errorCode, not silence.
    const rec = new FakeRecorder();
    const s = scripted((_url, init) => (init.method === "POST" ? { status: 503, body: { error: "unavailable" } } : { status: 500, body: { error: "list down" } }));
    const runner = new FlyRunner({ client: s.client, image: "img", recorder: rec });
    const err = await runner.create(SPEC).then(() => null, (e: unknown) => e as FlyApiError);
    expect(err!.retryable).toBe(false);
    expect(isUnestablishedCreate(err)).toBe(true);
    await Promise.resolve();
    const marks = rec.calls.filter((c) => c.errorCode === CREATE_OUTCOME_UNKNOWN);
    expect(marks).toHaveLength(1);
    expect(marks[0]).toMatchObject({ provider: "fly", operation: "createMachine", sessionId: SPEC.sessionId, status: 503 });
  });

  it("T5-b, the positive pair: a create that failed RETRYABLY after a CONFIRMED absence reaches the caller with retryable true, and is NOT marked unestablished", async () => {
    // Without this pair the mark above could fire on every create failure and the
    // suite would not notice — and the domain's one legitimate retry would be lost.
    const rec = new FakeRecorder();
    const s = scripted((_url, init) => (init.method === "POST" ? { status: 503, body: { error: "unavailable" } } : { status: 200, body: [] }));
    const runner = new FlyRunner({ client: s.client, image: "img", recorder: rec });
    const err = await runner.create(SPEC).then(() => null, (e: unknown) => e as FlyApiError);
    expect(err!.status).toBe(503);
    expect(err!.retryable).toBe(true);
    expect(isUnestablishedCreate(err)).toBe(false);
    await Promise.resolve();
    expect(rec.calls.filter((c) => c.errorCode === CREATE_OUTCOME_UNKNOWN)).toHaveLength(0);
  });

  it("destroy resolves on 200 and on 404 (idempotent, C7) and rejects on a 5xx after the client's retries", async () => {
    const s = scripted((url) => ({ status: url.includes("/m_gone?") ? 404 : url.includes("/m_bad?") ? 503 : 200 }));
    const runner = new FlyRunner({ client: s.client, image: "img" });
    await expect(runner.destroy("m_123")).resolves.toBeUndefined();
    expect(s.calls[0]!.url).toBe(`${FLY_MACHINES_BASE}/apps/seazn-relay/machines/m_123?force=true`);
    await expect(runner.destroy("m_gone")).resolves.toBeUndefined();
    await expect(runner.destroy("m_bad")).rejects.toThrow(/503/);
  });

  it("list maps the app's Machines to the port's vocabulary: session id from metadata, the name (T5-a), state started→running", async () => {
    const s = scripted(() => ({ status: 200, body: [
      { id: "m_a", name: "relay-x", state: "started", config: { metadata: { [SESSION_METADATA_KEY]: "x" } } },
      { id: "m_b", name: "relay-y", state: "stopped", config: { metadata: { [SESSION_METADATA_KEY]: "y" } } },
      { id: "m_c", name: "something-else", state: "started", config: {} },
    ] }));
    const runner = new FlyRunner({ client: s.client, image: "img" });
    expect(await runner.list()).toEqual([
      { runnerId: "m_a", sessionId: "x", name: "relay-x", state: "running" },
      { runnerId: "m_b", sessionId: "y", name: "relay-y", state: "stopped" },
      { runnerId: "m_c", sessionId: null, name: "something-else", state: "running" },
    ]);
  });

  it("no secret reaches a thrown error (the client's per-request env redaction, seen from the adapter)", async () => {
    const s = scripted(() => ({ status: 400, body: { error: "bad env JOB_TOKEN=jwt-SECRET" } }));
    const runner = new FlyRunner({ client: s.client, image: "img" });
    await expect(runner.create(SPEC)).rejects.toThrow(/\[redacted\]/);
    await expect(runner.create(SPEC)).rejects.not.toThrow(/jwt-SECRET/);
  });

  it("refuses to construct without FLY_API_TOKEN or RELAY_IMAGE", () => {
    const keep = { FLY_API_TOKEN: process.env.FLY_API_TOKEN, RELAY_IMAGE: process.env.RELAY_IMAGE };
    try {
      delete process.env.FLY_API_TOKEN;
      delete process.env.RELAY_IMAGE;
      expect(() => new FlyRunner()).toThrow(/FLY_API_TOKEN/);
      process.env.FLY_API_TOKEN = "t";
      expect(() => new FlyRunner()).toThrow(/RELAY_IMAGE/);
    } finally {
      restoreEnv(keep);
    }
  });
});

describe("relayDrivers()", () => {
  it("unset or fake → the fakes, one instance per process; a test override wins", () => {
    const keep = { RELAY_DRIVERS: process.env.RELAY_DRIVERS };
    try {
      process.env.RELAY_DRIVERS = "fake";
      setRelayDriversForTest(null);
      const a = relayDrivers();
      expect(a.ingest).toBeInstanceOf(FakeIngest);
      expect(a.runner).toBeInstanceOf(FakeRunner);
      expect(relayDrivers()).toBe(a);
      const mine = { ingest: new FakeIngest(), runner: new FakeRunner() };
      setRelayDriversForTest(mine);
      expect(relayDrivers()).toBe(mine);
    } finally {
      setRelayDriversForTest(null);
      restoreEnv(keep);
    }
  });

  it("a value that is neither fake nor live throws rather than defaulting", () => {
    const keep = { RELAY_DRIVERS: process.env.RELAY_DRIVERS };
    try {
      process.env.RELAY_DRIVERS = "prod";
      setRelayDriversForTest(null);
      expect(() => relayDrivers()).toThrow(/RELAY_DRIVERS/);
    } finally {
      setRelayDriversForTest(null);
      restoreEnv(keep);
    }
  });

  it("live mode without FLY_API_TOKEN still constructs (the Fly runner is lazy); the FIRST runner call is what fails (the token is owed, passthrough must not wait for it)", async () => {
    const keep = {
      RELAY_DRIVERS: process.env.RELAY_DRIVERS, FLY_API_TOKEN: process.env.FLY_API_TOKEN,
      CLOUDFLARE_ACCOUNT_ID: process.env.CLOUDFLARE_ACCOUNT_ID, CLOUDFLARE_STREAM_TOKEN: process.env.CLOUDFLARE_STREAM_TOKEN,
    };
    try {
      process.env.RELAY_DRIVERS = "live";
      process.env.CLOUDFLARE_ACCOUNT_ID = "acct";
      process.env.CLOUDFLARE_STREAM_TOKEN = "tok";
      delete process.env.FLY_API_TOKEN;
      setRelayDriversForTest(null);
      const d = relayDrivers();
      expect(d.ingest).toBeInstanceOf(CloudflareIngest);
      await expect(d.runner.list()).rejects.toThrow(/FLY_API_TOKEN/);
    } finally {
      setRelayDriversForTest(null);
      restoreEnv(keep);
    }
  });

  it("binds the production recorder into the adapters it builds — a call through relayDrivers().ingest reaches recordProviderCall (ruling 13)", async () => {
    const keep = { RELAY_DRIVERS: process.env.RELAY_DRIVERS };
    try {
      process.env.RELAY_DRIVERS = "fake";
      telemetry.recordProviderCall.mockClear();
      setRelayDriversForTest(null);
      await relayDrivers().ingest.inputStatus("in-1");
      // The fakes record fire-and-forget (`void Promise.resolve().then(…)`), so the
      // row lands one microtask after the call resolves — noted in the report.
      await Promise.resolve();
      // FakeIngest records EVERY method, so one call is enough. Drop
      // `{ recorder: dbRecorder }` from the fake branch and the adapter falls back
      // to NOOP_RECORDER and this reads 0 — the (recorder-binding) killer. The
      // assertion is on the production recorder rather than on a field of the
      // adapter: a binding nothing ever calls is the inert seam this wave keeps
      // producing (AGENTS.md class 1).
      expect(telemetry.recordProviderCall).toHaveBeenCalledTimes(1);
      // …and it is the CLOUDFLARE adapter's row. Pinning the provider stops a
      // runner-side call from satisfying this on its own. `recordProviderCall`
      // takes (tx, input) — Task 2 — so the payload is the second argument.
      const [, payload] = telemetry.recordProviderCall.mock.calls[0]!;
      expect(payload).toMatchObject({ provider: "cloudflare" });
    } finally {
      setRelayDriversForTest(null);
      restoreEnv(keep);
    }
  });
});
