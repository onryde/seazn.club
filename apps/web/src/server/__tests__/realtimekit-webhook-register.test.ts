// P1 T8 (check-in capacity plan 1): scripts/realtimekit-webhook-register.ts, the one-off that registers the presence webhook with
// Cloudflare RealtimeKit (the owner runs it once per environment at the staging gate). Imported by relative path as the precedent
// end-shared-meetings-script.test.ts imports scripts/chess-end-shared-meetings.ts.
//
// Expected values come from the vendor's OpenAPI (GET/POST .../realtime/kit/{app}/webhooks, PATCH .../webhooks/{id}; response
// `{ success, data }`; the event enum has `meeting.participantJoined`, `meeting.participantLeft`, `meeting.ended`), never from
// the script. The vendor here is an injected fetch: the real Cloudflare API is never called.
// Anti-vacuity: the request-recording assertions report how many calls they judged and zero is a failure.
// Single-sport reason: no sport is involved; this is an operator script.
import { describe, expect, it } from "vitest";
import {
  PRESENCE_WEBHOOK_EVENTS,
  registrationPlan,
  run,
  type VendorWebhook,
} from "../../../../../scripts/realtimekit-webhook-register.ts";

const URL_OK = "https://seazn.example/api/webhooks/realtimekit";
const TOKEN = "tok-SECRET-0123456789";
// ProcessEnv (@types/node + Next) makes NODE_ENV required; a partial env is exactly what these tests mean to pass.
const penv = (e: Record<string, string>): NodeJS.ProcessEnv => e as unknown as NodeJS.ProcessEnv;
const ENV = penv({ CLOUDFLARE_ACCOUNT_ID: "acct1", REALTIMEKIT_API_TOKEN: TOKEN, REALTIMEKIT_APP_ID: "app1" });
const PREFIX = "https://api.cloudflare.com/client/v4/accounts/acct1/realtime/kit/app1";

const hook = (over: Partial<VendorWebhook> = {}): VendorWebhook => ({
  id: "wh-1",
  name: "seazn-presence",
  url: "https://old.example/hook",
  events: ["meeting.started"],
  enabled: false,
  ...over,
});

type Call = { method: string; url: string; auth: string | null; body: unknown };
function recordingFetch(responses: Array<{ status?: number; json: unknown }>): { fetch: typeof fetch; calls: Call[] } {
  const calls: Call[] = [];
  let i = 0;
  const f = (async (input: string | URL | Request, init?: RequestInit) => {
    calls.push({
      method: init?.method ?? "GET",
      url: String(input),
      auth: new Headers(init?.headers).get("authorization"),
      body: typeof init?.body === "string" ? JSON.parse(init.body) : undefined,
    });
    const r = responses[i++] ?? { status: 500, json: {} };
    return new Response(JSON.stringify(r.json), { status: r.status ?? 200, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  return { fetch: f, calls };
}
const throwingFetch = (() => {
  throw new Error("fetch must not be called");
}) as unknown as typeof fetch;

function capture() {
  const lines: string[] = [];
  return { lines, out: (l: string) => lines.push(l) };
}

describe("registrationPlan", () => {
  it("events are exactly the three presence events", () => {
    expect([...PRESENCE_WEBHOOK_EVENTS]).toEqual(["meeting.participantJoined", "meeting.participantLeft", "meeting.ended"]);
  });

  it("POSTs /webhooks when no webhook of that name exists (empty list, and a list of other names)", () => {
    const want = { name: "seazn-presence", url: URL_OK };
    for (const existing of [[], [hook({ name: "someone-else", id: "wh-9" })]]) {
      const p = registrationPlan(existing, want);
      expect(p.method).toBe("POST");
      expect(p.path).toBe("/webhooks");
      expect(p.body).toEqual({ name: "seazn-presence", url: URL_OK, events: [...PRESENCE_WEBHOOK_EVENTS], enabled: true });
    }
  });

  it("PATCHes /webhooks/{id} to the wanted url/events/enabled when one of that name exists", () => {
    const p = registrationPlan([hook({ name: "other", id: "wh-0" }), hook()], { name: "seazn-presence", url: URL_OK });
    expect(p.method).toBe("PATCH");
    expect(p.path).toBe("/webhooks/wh-1");
    expect(p.body).toEqual({ name: "seazn-presence", url: URL_OK, events: [...PRESENCE_WEBHOOK_EVENTS], enabled: true });
  });

  it("the body's events array is a copy, not the shared constant", () => {
    const p = registrationPlan([], { name: "n", url: URL_OK });
    p.body.events.push("meeting.started");
    expect([...PRESENCE_WEBHOOK_EVENTS]).toHaveLength(3);
  });
});

describe("run", () => {
  it("--dry-run makes no request, needs no credentials, and exits 0", async () => {
    const c = capture();
    const code = await run(["--url", URL_OK, "--dry-run"], { fetch: throwingFetch, env: penv({}), out: c.out });
    expect(code).toBe(0);
    expect(c.lines.length).toBeGreaterThan(0);
    expect(c.lines.join("\n")).toContain(URL_OK);
  });

  it("registers a new webhook: GET the list, then POST the plan, Bearer-authenticated, exit 0", async () => {
    const { fetch, calls } = recordingFetch([{ json: { success: true, data: [] } }, { json: { success: true, data: hook({ id: "wh-new", url: URL_OK }) } }]);
    const c = capture();
    const code = await run(["--url", URL_OK], { fetch, env: ENV, out: c.out });
    expect(code).toBe(0);
    expect(calls).toHaveLength(2);
    expect(calls.map((x) => [x.method, x.url])).toEqual([
      ["GET", `${PREFIX}/webhooks`],
      ["POST", `${PREFIX}/webhooks`],
    ]);
    expect(calls.every((x) => x.auth === `Bearer ${TOKEN}`)).toBe(true);
    expect(calls[1].body).toEqual({ name: "seazn-presence", url: URL_OK, events: [...PRESENCE_WEBHOOK_EVENTS], enabled: true });
    expect(c.lines.join("\n")).toContain("wh-new");
  });

  it("updates an existing one (second run): GET then PATCH /webhooks/{id}; --name is honoured", async () => {
    const { fetch, calls } = recordingFetch([
      { json: { success: true, data: [hook({ name: "custom", id: "wh-7" })] } },
      { json: { success: true, data: hook({ name: "custom", id: "wh-7", url: URL_OK }) } },
    ]);
    const code = await run(["--url", URL_OK, "--name", "custom"], { fetch, env: ENV, out: () => undefined });
    expect(code).toBe(0);
    expect(calls.map((x) => [x.method, x.url])).toEqual([
      ["GET", `${PREFIX}/webhooks`],
      ["PATCH", `${PREFIX}/webhooks/wh-7`],
    ]);
  });

  it("REALTIMEKIT_BASE_URL redirects the calls (a fixture)", async () => {
    const { fetch, calls } = recordingFetch([{ json: { success: true, data: [] } }, { json: { success: true, data: hook() } }]);
    await run(["--url", URL_OK], { fetch, env: { ...ENV, REALTIMEKIT_BASE_URL: "http://127.0.0.1:9/" }, out: () => undefined });
    expect(calls).toHaveLength(2);
    expect(calls[0].url).toBe("http://127.0.0.1:9/accounts/acct1/realtime/kit/app1/webhooks");
  });

  it("a BLANK REALTIMEKIT_BASE_URL (an empty env line) is unset: the calls go to Cloudflare, not to a relative URL", async () => {
    const { fetch, calls } = recordingFetch([{ json: { success: true, data: [] } }, { json: { success: true, data: hook() } }]);
    expect(await run(["--url", URL_OK], { fetch, env: { ...ENV, REALTIMEKIT_BASE_URL: "" }, out: () => undefined })).toBe(0);
    expect(calls).toHaveLength(2);
    expect(calls.every((x) => x.url.startsWith(`${PREFIX}/webhooks`))).toBe(true);
  });

  it("the webhook id is printed only when it looks like an id; anything else (a quoted token, a line break, an over-long string) prints \"(not returned)\"", async () => {
    let checked = 0;
    for (const id of [`wh ${TOKEN}`, `wh-1\nINJECTED`, "x".repeat(65), "", "a b"]) {
      const c = capture();
      const { fetch } = recordingFetch([{ json: { success: true, data: [] } }, { json: { success: true, data: hook({ id, url: URL_OK }) } }]);
      expect(await run(["--url", URL_OK], { fetch, env: ENV, out: c.out }), JSON.stringify(id)).toBe(0);
      const text = c.lines.join("\n");
      expect(text, JSON.stringify(id)).toContain("id=(not returned)");
      expect(text, JSON.stringify(id)).not.toContain(TOKEN);
      expect(text, JSON.stringify(id)).not.toContain("INJECTED");
      checked += 1;
    }
    expect(checked).toBe(5);
    // the boundary that still prints: 64 id characters
    const c = capture();
    const ok = "a".repeat(64);
    await run(["--url", URL_OK], { fetch: recordingFetch([{ json: { success: true, data: [] } }, { json: { success: true, data: hook({ id: ok }) } }]).fetch, env: ENV, out: c.out });
    expect(c.lines.join("\n")).toContain(`id=${ok}`);
  });

  it("a vendor refusal exits 1 and the token never reaches out, even when the vendor body echoes it", async () => {
    const c = capture();
    const echo = { success: false, errors: [{ message: `bad token ${TOKEN}` }] };
    const a = await run(["--url", URL_OK], { fetch: recordingFetch([{ status: 403, json: echo }]).fetch, env: ENV, out: c.out });
    const b = await run(["--url", URL_OK], {
      fetch: recordingFetch([{ json: { success: true, data: [] } }, { status: 400, json: echo }]).fetch,
      env: ENV,
      out: c.out,
    });
    expect([a, b]).toEqual([1, 1]);
    expect(c.lines.length).toBeGreaterThan(0);
    expect(c.lines.join("\n")).not.toContain(TOKEN);
    expect(c.lines.join("\n")).toContain("403");
  });

  it("a transport error exits 1 without quoting the URL or token", async () => {
    const c = capture();
    const boom = (async () => {
      throw new Error(`connect failed to ${PREFIX} with ${TOKEN}`);
    }) as unknown as typeof fetch;
    const code = await run(["--url", URL_OK], { fetch: boom, env: ENV, out: c.out });
    expect(code).toBe(1);
    expect(c.lines.join("\n")).not.toContain(TOKEN);
  });

  it("a list answer without a data array is refused (exit 1) before anything is written", async () => {
    const { fetch, calls } = recordingFetch([{ json: { success: true } }]);
    const code = await run(["--url", URL_OK], { fetch, env: ENV, out: () => undefined });
    expect(code).toBe(1);
    expect(calls).toHaveLength(1);
  });

  it("usage errors exit 2 and call nothing: no --url, a non-https url, an unknown flag, missing env (non dry-run)", async () => {
    const cases: Array<[string[], NodeJS.ProcessEnv]> = [
      [[], ENV],
      [["--url", "not a url"], ENV],
      [["--url", "http://seazn.example/api/webhooks/realtimekit"], ENV],
      [["--url", URL_OK, "--bogus"], ENV],
      [["--url", URL_OK], penv({ CLOUDFLARE_ACCOUNT_ID: "acct1" })],
    ];
    for (const [argv, env] of cases) {
      const c = capture();
      expect(await run(argv, { fetch: throwingFetch, env, out: c.out }), JSON.stringify(argv)).toBe(2);
      expect(c.lines.length).toBeGreaterThan(0);
    }
    expect(cases).toHaveLength(5);
  });

  it("the missing-env message names the variables, never their values", async () => {
    const c = capture();
    await run(["--url", URL_OK], { fetch: throwingFetch, env: penv({ REALTIMEKIT_API_TOKEN: TOKEN }), out: c.out });
    const text = c.lines.join("\n");
    expect(text).toContain("CLOUDFLARE_ACCOUNT_ID");
    expect(text).toContain("REALTIMEKIT_APP_ID");
    expect(text).not.toContain(TOKEN);
  });
});

describe("importing the module", () => {
  it("runs nothing: no fetch, no exit (this file imported it above under vitest's argv)", () => {
    expect(process.exitCode ?? 0).toBe(0);
    expect(typeof run).toBe("function");
  });
});
