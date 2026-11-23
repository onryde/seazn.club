// Task 30: the delivered-minutes reader for Seazn live (Cloudflare's GraphQL Analytics, `streamMinutesViewedAdaptiveGroups`)
// against a mocked fetch. No network. The query's names and limits are Cloudflare's published ones
// (developers.cloudflare.com/stream/getting-analytics/fetching-bulk-analytics, read 2026-11-23): the endpoint, the dataset, its
// `sum { minutesViewed }` and `dimensions { uid }`, and its maximum query interval of "32 days (768 hours)". Whether a live view
// of a programme input lands under the input uid or its live video uid is unmeasured (the plan sums both); the Task 7 probe
// settles it. Every expected value below is typed from those sources, never read back from the reader.
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

  it("an answer whose shape is not the query's is refused, never read as 0", async () => {
    const shapes: [string, unknown][] = [
      ["no data", { data: null, errors: null }],
      ["no account", { data: { viewer: { accounts: [] } }, errors: null }],
      ["groups not a list", { data: { viewer: { accounts: [{ streamMinutesViewedAdaptiveGroups: null }] } }, errors: null }],
      ["minutes missing", answer([{ uid: INPUT, minutes: undefined }])],
      ["minutes not a number", answer([{ uid: INPUT, minutes: "12" }])],
      ["minutes negative", answer([{ uid: INPUT, minutes: -1 }])],
      ["uid missing", answer([{ uid: undefined, minutes: 1 }])],
    ];
    let checked = 0;
    for (const [what, body] of shapes) {
      const { read } = harness(() => ({ status: 200, body }));
      expect(await errorOf(read([INPUT])), what).toMatch(/^cloudflare liveMinutesViewed: /);
      checked++;
    }
    expect(checked, "anti-vacuity: shapes refused").toBe(7);
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
    for (const r of recorders) {
      expect(r.calls).toHaveLength(1);
      expect(JSON.stringify(r.calls[0])).not.toContain(CONFIG.token);
      checked++;
    }
    expect(checked, "anti-vacuity: three messages and three records read").toBe(6);
  });

  it("the Stream token unset (the reader uses the relay's own pair: owner ruling 2026-11-23): it refuses naming CLOUDFLARE_STREAM_TOKEN, makes no call, and the module imports with nothing set", async () => {
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
