// Task 30: the delivered-minutes reader for Seazn live (Cloudflare's GraphQL Analytics, `streamMinutesViewedAdaptiveGroups`)
// against a mocked fetch. No network. The query's names and limits are Cloudflare's published ones
// (developers.cloudflare.com/stream/getting-analytics/fetching-bulk-analytics, read 2026-11-23): the endpoint, the dataset, its
// `sum { minutesViewed }` and `dimensions { uid }`, and its maximum query interval of "32 days (768 hours)". The caller always asks
// for the input uid and its video uids (the interim replay plays by video uid); whether one live view is reported under both is the
// Task 7 probe's question, not this file's. Every expected value below is typed from those sources, never read back from the reader.
import { afterEach, describe, expect, it, vi } from "vitest";
import { FakeRecorder } from "@/server/relay/fakes";
import type { CfAnalyticsConfig } from "@/server/relay/config";
import { liveMinutesViewed } from "../cf-analytics";

const CONFIG: CfAnalyticsConfig = { accountId: "acct-0f1e2d3c", token: "ZZ-cf-stream-token-9d1f7a" };
const GRAPHQL = "https://api.cloudflare.com/client/v4/graphql";
const INPUT = "in-0001";
const VIDEO_A = "vid-000a";
const VIDEO_B = "vid-000b";
/** 18:30 on the 1st to the last millisecond of the 22nd: the dates sent are the UTC days, never the instants. */
const FROM = new Date("2026-11-01T18:30:00.000Z");
const TO = new Date("2026-11-22T23:59:59.999Z");

type Call = { url: string; method: string; headers: Record<string, string>; body: { query: string; variables: Record<string, unknown> } };
type Reply = { status: number; body?: unknown } | (() => never);

function harness(reply: (c: Call) => Reply) {
  const calls: Call[] = [];
  const fetchImpl = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    const c: Call = {
      url: String(url),
      method: init?.method ?? "GET",
      headers: Object.fromEntries(new Headers(init?.headers).entries()),
      body: JSON.parse(String(init?.body)),
    };
    calls.push(c);
    const r = reply(c);
    if (typeof r === "function") return r();
    return new Response(r.body === undefined ? null : typeof r.body === "string" ? r.body : JSON.stringify(r.body), {
      status: r.status, headers: { "content-type": "application/json" },
    });
  }) as unknown as typeof fetch;
  const recorder = new FakeRecorder();
  const read = (uids: string[], from = FROM, to = TO) => liveMinutesViewed(uids, from, to, { config: CONFIG, fetchImpl, recorder });
  return { read, calls, recorder };
}

/** Cloudflare's answer: one account, its groups. */
const answer = (groups: { uid: unknown; minutes: unknown }[]) => ({
  data: { viewer: { accounts: [{ streamMinutesViewedAdaptiveGroups: groups.map((g) => ({ sum: { minutesViewed: g.minutes }, dimensions: { uid: g.uid } })) }] } },
  errors: null,
});

const errorOf = async (p: Promise<unknown>): Promise<string> => {
  try { await p; } catch (e) { return (e as Error).message; }
  throw new Error("expected a rejection, got an answer");
};
const flush = () => new Promise((r) => setTimeout(r, 0)); // the record is fire-and-forget

afterEach(() => { vi.unstubAllEnvs(); });

describe("liveMinutesViewed: the query it sends", () => {
  it("POSTs one GraphQL query to Cloudflare's endpoint with the token as a Bearer header; the body carries uid_in with the given uids and the date filters as ISO dates", async () => {
    const { read, calls } = harness(() => ({ status: 200, body: answer([]) }));
    await read([INPUT, VIDEO_A, VIDEO_B]);
    expect(calls).toHaveLength(1);
    const [c] = calls;
    expect(c.url).toBe(GRAPHQL);
    expect(c.method).toBe("POST");
    expect(c.headers.authorization).toBe(`Bearer ${CONFIG.token}`);
    expect(c.headers["content-type"]).toBe("application/json");
    // The dataset, its filter and the two fields read: Cloudflare's own names.
    const q = c.body.query.replace(/\s+/g, " ");
    for (const part of [
      "streamMinutesViewedAdaptiveGroups(", "accounts(filter: { accountTag: $accountTag })", "uid_in: $uids", "date_geq: $start", "date_leq: $end",
      "sum { minutesViewed }", "dimensions { uid }",
    ]) expect(q, part).toContain(part);
    expect(c.body.variables).toEqual({ accountTag: CONFIG.accountId, uids: [INPUT, VIDEO_A, VIDEO_B], start: "2026-11-01", end: "2026-11-22" });
    for (const k of ["start", "end"] as const) expect(c.body.variables[k], k).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    // The token rides in the header alone: never in the URL or the body.
    expect(c.url).not.toContain(CONFIG.token);
    expect(JSON.stringify(c.body)).not.toContain(CONFIG.token);
  });

  it("asks once per uid: a repeated uid is sent once", async () => {
    const { read, calls } = harness(() => ({ status: 200, body: answer([]) }));
    expect(await read([INPUT, VIDEO_A, INPUT])).toEqual({ [INPUT]: 0, [VIDEO_A]: 0 });
    expect(calls[0].body.variables.uids).toEqual([INPUT, VIDEO_A]);
  });

  it("the empty case: no uids is an empty answer and no call", async () => {
    const { read, calls } = harness(() => ({ status: 200, body: answer([]) }));
    expect(await read([])).toEqual({});
    expect(calls).toEqual([]);
  });
});

describe("liveMinutesViewed: what it answers", () => {
  it("sums sum.minutesViewed per uid, and every uid asked has a number (0 when Cloudflare answers no group for it)", async () => {
    const { read } = harness(() => ({
      status: 200,
      body: answer([{ uid: INPUT, minutes: 12.5 }, { uid: VIDEO_A, minutes: 3 }, { uid: INPUT, minutes: 0.5 }]),
    }));
    expect(await read([INPUT, VIDEO_A, VIDEO_B])).toEqual({ [INPUT]: 13, [VIDEO_A]: 3, [VIDEO_B]: 0 });
  });

  it("an answer naming a uid that was not asked for is refused (the filter was not applied: C6), never summed or dropped", async () => {
    const { read } = harness(() => ({ status: 200, body: answer([{ uid: INPUT, minutes: 4 }, { uid: "someone-elses-video", minutes: 900 }]) }));
    const message = await errorOf(read([INPUT]));
    expect(message).toMatch(/^cloudflare liveMinutesViewed: .*not asked for/);
  });

  it("an answer whose shape is not the query's is refused by its own guard, never read as 0", async () => {
    // Each row names the fragment of ITS guard's message (fix round 1, review m3): a later guard catching the row instead (the
    // foreign-uid refusal for a uid-less group, the groups check for an empty account list) is a red, not a pass.
    const ONE_ACCOUNT = { streamMinutesViewedAdaptiveGroups: [{ sum: { minutesViewed: 4 }, dimensions: { uid: INPUT } }] };
    const shapes: [string, unknown, RegExp][] = [
      ["no data", { data: null, errors: null }, /answered no accounts, not the one asked for$/],
      ["no account", { data: { viewer: { accounts: [] } }, errors: null }, /answered 0 accounts, not the one asked for$/],
      ["two accounts (the filter on accountTag not applied)", { data: { viewer: { accounts: [ONE_ACCOUNT, ONE_ACCOUNT] } }, errors: null }, /answered 2 accounts, not the one asked for$/],
      ["groups not a list", { data: { viewer: { accounts: [{ streamMinutesViewedAdaptiveGroups: null }] } }, errors: null }, /answered no minutes-viewed groups$/],
      ["minutes missing", answer([{ uid: INPUT, minutes: undefined }]), /the group for in-0001 carries no minutes count$/],
      ["minutes not a number", answer([{ uid: INPUT, minutes: "12" }]), /the group for in-0001 carries no minutes count$/],
      ["minutes negative", answer([{ uid: INPUT, minutes: -1 }]), /the group for in-0001 carries no minutes count$/],
      ["uid missing", answer([{ uid: undefined, minutes: 1 }]), /: a group carries no uid$/],
      ["uid not a string", answer([{ uid: 7, minutes: 1 }]), /: a group carries no uid$/],
    ];
    let checked = 0;
    for (const [what, body, guard] of shapes) {
      const { read } = harness(() => ({ status: 200, body }));
      const message = await errorOf(read([INPUT]));
      expect(message, what).toMatch(/^cloudflare liveMinutesViewed: /);
      expect(message, what).toMatch(guard);
      checked++;
    }
    expect(checked, "anti-vacuity: shapes refused").toBe(9);
  });

  it("a non-2xx answer with no errors[] is refused as its HTTP status alone — a body with the query's shape included — and recorded with that status", async () => {
    // Fix round 1 (review m2): the errors[] branch answers first, so these rows carry none; each would read differently past it.
    const rows: [string, number, unknown][] = [
      ["503, an empty object", 503, {}],
      ["500, a body with the query's shape", 500, answer([{ uid: INPUT, minutes: 5 }])],
      ["502, an HTML error page (not JSON: read as absent)", 502, "<html><body>Bad gateway</body></html>"],
    ];
    let checked = 0;
    for (const [what, status, body] of rows) {
      const { read, recorder } = harness(() => ({ status, body }));
      expect(await errorOf(read([INPUT])), what).toBe(`cloudflare liveMinutesViewed: HTTP ${status}`);
      await flush();
      expect(recorder.calls.map((c) => [c.status, c.errorCode]), what).toEqual([[status, null]]);
      checked++;
    }
    expect(checked, "anti-vacuity: non-2xx answers refused").toBe(3);
  });
});

describe("liveMinutesViewed: the window", () => {
  it("a 33-day window throws before any call; a 32-day one (Cloudflare's maximum) is asked", async () => {
    const { read, calls } = harness(() => ({ status: 200, body: answer([]) }));
    // 1 Oct to 2 Nov is 33 UTC days, counted inclusively as Cloudflare's date_geq/date_leq read them.
    const refused = await errorOf(read([INPUT], new Date("2026-10-01T00:00:00.000Z"), new Date("2026-11-02T12:00:00.000Z")));
    expect(refused).toMatch(/33 days/);
    expect(refused).toMatch(/32/);
    expect(calls).toEqual([]);
    await read([INPUT], new Date("2026-10-01T00:00:00.000Z"), new Date("2026-11-01T23:59:59.999Z"));
    expect(calls).toHaveLength(1);
    expect(calls[0].body.variables).toMatchObject({ start: "2026-10-01", end: "2026-11-01" });
  });

  it("a window that ends before it starts, or a date that is not one, throws before any call", async () => {
    const { read, calls } = harness(() => ({ status: 200, body: answer([]) }));
    expect(await errorOf(read([INPUT], TO, FROM))).toMatch(/before it starts/);
    expect(await errorOf(read([INPUT], new Date("not a date"), TO))).toMatch(/not a date/);
    expect(await errorOf(read([INPUT], FROM, new Date(Number.NaN)))).toMatch(/not a date/);
    expect(calls).toEqual([]);
    // One day is a window: from and to on the same UTC day.
    await read([INPUT], new Date("2026-11-22T00:00:00.000Z"), new Date("2026-11-22T00:00:00.000Z"));
    expect(calls[0].body.variables).toMatchObject({ start: "2026-11-22", end: "2026-11-22" });
  });
});

describe("liveMinutesViewed: refusals, and the token in none of them", () => {
  it("an errors[] answer throws without echoing the token, and so does a refused or unreachable call; no record carries it", async () => {
    const messages: string[] = [];
    const recorders: FakeRecorder[] = [];
    const graphqlRefusal = harness(() => ({
      status: 200,
      body: { data: null, errors: [{ message: `authz: token ${CONFIG.token} is not authorized for account ${CONFIG.accountId}` }, { message: "second" }] },
    }));
    const graphqlMessage = await errorOf(graphqlRefusal.read([INPUT]));
    expect(graphqlMessage).toMatch(/refused/);
    expect(graphqlMessage, "Cloudflare's own reason is kept, redacted").toContain("is not authorized");
    messages.push(graphqlMessage);
    recorders.push(graphqlRefusal.recorder);
    const httpRefusal = harness(() => ({ status: 403, body: `{"success":false,"errors":[{"message":"bad token ${CONFIG.token}"}]}` }));
    const httpMessage = await errorOf(httpRefusal.read([INPUT]));
    expect(httpMessage).toMatch(/HTTP 403/);
    messages.push(httpMessage);
    recorders.push(httpRefusal.recorder);
    const network = harness(() => () => { throw new TypeError(`fetch failed: Authorization: Bearer ${CONFIG.token}`); });
    const networkMessage = await errorOf(network.read([INPUT]));
    expect(networkMessage).toMatch(/request failed before a response/);
    messages.push(networkMessage);
    recorders.push(network.recorder);
    await flush();
    let checked = 0;
    for (const m of messages) { expect(m, m).not.toContain(CONFIG.token); checked++; }
    // Each refusal is recorded as the failure it was (fix round 1, review m4): a refused query by its status and `graphql_error`,
    // a call that never answered with no status and `network`. Never a clean row.
    const expected: [number | null, string][] = [[200, "graphql_error"], [403, "graphql_error"], [null, "network"]];
    for (const [k, r] of recorders.entries()) {
      expect(r.calls).toHaveLength(1);
      expect(JSON.stringify(r.calls[0])).not.toContain(CONFIG.token);
      expect([r.calls[0].status, r.calls[0].errorCode], `record ${k}`).toEqual(expected[k]);
      checked++;
    }
    expect(checked, "anti-vacuity: three messages and three records read").toBe(6);
  });

  it("the Stream token unset (the reader uses the relay's own pair: owner ruling 2026-11-23): it refuses naming CLOUDFLARE_STREAM_TOKEN, makes no call, and importing the module reads no setting", async () => {
    vi.stubEnv("CLOUDFLARE_STREAM_TOKEN", "");
    vi.stubEnv("CLOUDFLARE_ACCOUNT_ID", "acct-from-env");
    vi.resetModules();
    const fresh = await import("../cf-analytics"); // an import reads no setting: it cannot crash a process that lacks one
    const fetchImpl = vi.fn() as unknown as typeof fetch;
    const message = await errorOf(fresh.liveMinutesViewed([INPUT], FROM, TO, { fetchImpl }));
    expect(message).toMatch(/\bCLOUDFLARE_STREAM_TOKEN\b/);
    expect(message).not.toMatch(/\bCLOUDFLARE_ACCOUNT_ID\b/);
    expect(message).not.toContain("acct-from-env");
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

describe("liveMinutesViewed: one provider-call record per call (ruling 13)", () => {
  it("records the call as Cloudflare's, with the account id and the status, and nothing secret", async () => {
    const { read, recorder } = harness(() => ({ status: 200, body: answer([{ uid: INPUT, minutes: 2 }]) }));
    await read([INPUT, VIDEO_A]);
    await flush();
    expect(recorder.calls).toHaveLength(1);
    expect(recorder.calls[0]).toMatchObject({
      provider: "cloudflare", operation: "liveMinutesViewed", method: "POST", url: GRAPHQL, ids: [CONFIG.accountId], status: 200, errorCode: null,
    });
  });
});

// Fix round 1 (review m1, 2026-11-23): the daily sweep reads each session's uids in turn, and undici's own bound is 300 s, so one
// hung call held the sweep for five minutes. One call gives up after 20 s (the controller's figure, typed here) — the request and
// the body read alike — and is recorded as `timeout`. AbortSignal.timeout runs on a real timer, so the spy hands out a controller
// per call and the test fires the deadline itself.
describe("liveMinutesViewed: one call gives up at 20 s (fix round 1, review m1)", () => {
  const timedOut = () => new DOMException("The operation was aborted due to timeout", "TimeoutError");
  function deadlineSpy() {
    const deadlines: AbortController[] = [];
    const spy = vi.spyOn(AbortSignal, "timeout").mockImplementation(() => { const c = new AbortController(); deadlines.push(c); return c.signal; });
    return { deadlines, spy };
  }
  /** A 200 whose headers arrived and whose body never does — until its signal fires, or `cut` errors it at once. */
  function stalledBody(signal: AbortSignal | null | undefined, cut?: () => unknown): Response {
    return new Response(new ReadableStream({
      start(c) {
        if (cut) queueMicrotask(() => c.error(cut()));
        else signal?.addEventListener("abort", () => c.error(signal.reason), { once: true });
      },
    }), { status: 200, headers: { "content-type": "application/json" } });
  }

  it("a fetch that never answers: the call carries AbortSignal.timeout(20000), is still pending until the deadline fires, then throws our own words, recorded with no status and `timeout`", async () => {
    const { deadlines, spy } = deadlineSpy();
    try {
      const signals: (AbortSignal | null | undefined)[] = [];
      const fetchImpl = vi.fn((_url: string | URL | Request, init?: RequestInit) => {
        const signal = init?.signal;
        signals.push(signal);
        return new Promise<Response>((_, reject) => signal?.addEventListener("abort", () => reject(signal.reason), { once: true }));
      }) as unknown as typeof fetch;
      const recorder = new FakeRecorder();
      let settled = false;
      const pending = liveMinutesViewed([INPUT, VIDEO_A], FROM, TO, { config: CONFIG, fetchImpl, recorder })
        .then(() => null, (e: unknown) => e as Error)
        .finally(() => { settled = true; });
      await vi.waitFor(() => expect(signals).toHaveLength(1));
      expect(spy).toHaveBeenCalledTimes(1);
      expect(spy).toHaveBeenCalledWith(20_000);
      expect(signals[0], "the request carries the deadline's signal").toBe(deadlines[0]!.signal);
      await flush();
      expect(settled, "nothing answers before the deadline").toBe(false);
      deadlines[0]!.abort(timedOut());
      const err = await pending;
      expect(err?.message).toBe("cloudflare liveMinutesViewed: request failed before a response");
      expect(err?.message).not.toContain(CONFIG.token);
      await flush();
      expect(recorder.calls.map((c) => [c.status, c.errorCode])).toEqual([[null, "timeout"]]);
      expect(JSON.stringify(recorder.calls)).not.toContain(CONFIG.token);
    } finally {
      spy.mockRestore();
    }
  });

  it("a 200 whose body never arrives is a failed call at the deadline (no status, `timeout`), never the 200; a body cut by the connection is the same failure, `network`; a body that arrived but is not JSON is still read as absent", async () => {
    const { deadlines, spy } = deadlineSpy();
    try {
      let answered = 0;
      const fetchImpl = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
        answered++;
        if (answered === 1) return stalledBody(init?.signal);
        if (answered === 2) return stalledBody(init?.signal, () => new TypeError("terminated"));
        return new Response("<html>not JSON</html>", { status: 200, headers: { "content-type": "text/html" } });
      }) as unknown as typeof fetch;
      const recorder = new FakeRecorder();
      const read = () => liveMinutesViewed([INPUT], FROM, TO, { config: CONFIG, fetchImpl, recorder }).then(() => null, (e: unknown) => e as Error);
      const pending = read();
      await vi.waitFor(() => expect(answered, "the headers arrived").toBe(1));
      deadlines[0]!.abort(timedOut());
      const stalled = await pending;
      await flush();
      const cut = await read();
      await flush();
      let checked = 0;
      for (const err of [stalled, cut]) {
        expect(err?.message).toBe("cloudflare liveMinutesViewed: the response did not arrive in full");
        checked++;
      }
      expect(checked, "anti-vacuity: body failures read").toBe(2);
      // Not JSON is a body that arrived: read as absent, so the shape guard refuses it and the row keeps its 200.
      expect((await read())?.message).toBe("cloudflare liveMinutesViewed: HTTP 200 answered no accounts, not the one asked for");
      await flush();
      expect(recorder.calls.map((c) => [c.status, c.errorCode]), "a failure, never the 200").toEqual([[null, "timeout"], [null, "network"], [200, null]]);
    } finally {
      spy.mockRestore();
    }
  });
});
