// Capture QR v2 §6.3.1 over HTTP (T8a): `GET /api/v1/capture/codes/{code}` driven through its REAL handler. The
// use-case (capture-get.test.ts) proves the decision; this file proves the ROUTE carries it:
//   - a 2xx is the BARE contract shape (no `ok`), parsed with the zod twin;
//   - every refusal is `{code, message}`; the four ways a Bearer can fail (none, malformed, wrong tok, ended code)
//     answer the SAME body (A17, C1), so the wire never tells them apart;
//   - EVERY answer is `private, no-store` + `Pragma: no-cache`, error paths included;
//   - `slot` omitted is 0, any other slot is 422 `invalid`;
//   - the origin in the answer is never read off a forged `X-Forwarded-Host` (§6.4).
//
// ONE SPORT, on purpose (TEST-STRATEGY rule 6): the route reads no sport (capture-get.test.ts pins the one sport row).
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomBytes, randomUUID } from "node:crypto";
import { sql } from "@/lib/db";
import { CaptureRefusalError, captureJson, captureRefusal } from "@/server/api-v1/capture-http";
import { buildOpenApiDocument } from "@/server/api-v1/openapi";
import { CaptureDescriptor, CaptureRefusal } from "@/server/api-v1/capture-schemas";
import { createApiKey } from "@/server/usecases/api-keys";
import { reissueStreamCode } from "@/server/usecases/stream-codes";
import { captureRig, override, phoneId } from "@/server/usecases/__tests__/_capture-rig";
import { GET } from "../[code]/route";

const HAS_DB = !!process.env.DATABASE_URL;

const ENV_KEYS = ["RELAY_KEK", "OAUTH_BASE_URL", "NEXT_PUBLIC_BASE_URL", "STREAM_INGEST_HOST", "STREAM_PLAYBACK_HOST", "STREAM_SRT_ENABLED", "RELAY_DRIVERS"] as const;
const saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
beforeAll(() => {
  for (const k of ENV_KEYS) delete process.env[k];
  process.env.RELAY_KEK = randomBytes(32).toString("hex");
});
afterAll(() => {
  for (const k of ENV_KEYS) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
});
afterAll(async () => {
  if (!HAS_DB) return;
  const g = globalThis as { _sql?: { end(): Promise<void> } };
  const client = g._sql;
  g._sql = undefined;
  await client?.end();
});

const BASE = "https://test.local/api/v1/capture/codes";
function call(code: string, opts: { auth?: string | null; query?: string; headers?: Record<string, string> } = {}) {
  const headers: Record<string, string> = { ...opts.headers };
  if (opts.auth !== null && opts.auth !== undefined) headers.authorization = opts.auth;
  return GET(new Request(`${BASE}/${code}${opts.query ?? ""}`, { headers }), { params: Promise.resolve({ code }) });
}
async function read(res: Response) {
  return { status: res.status, body: (await res.json()) as Record<string, unknown>, cache: res.headers.get("cache-control"), pragma: res.headers.get("pragma") };
}
const NO_STORE = { cache: "private, no-store", pragma: "no-cache" };

describe.skipIf(!HAS_DB)("GET /api/v1/capture/codes/{code}", () => {
  it("200: the bare descriptor (no envelope) — waiting without a phone, the session shape with cred for the session's phone — each parsed with its branch, each no-store", async () => {
    const r = await captureRig();
    const mine = phoneId("mine");
    const waiting = await read(await call(r.code, { auth: `Bearer ${r.tok}`, query: "?slot=0" }));
    expect(waiting).toMatchObject({ status: 200, ...NO_STORE });
    expect(Object.hasOwn(waiting.body, "ok")).toBe(false);
    expect(waiting.body.state).toBe("waiting");
    expect(CaptureDescriptor.parse(waiting.body)).toEqual(waiting.body);
    await r.start(mine);
    const session = await read(await call(r.code, { auth: `Bearer ${r.tok}`, query: `?slot=0&phone=${encodeURIComponent(mine)}` }));
    expect(session).toMatchObject({ status: 200, ...NO_STORE });
    expect(session.body).toMatchObject({ state: "warming" });
    expect(Object.hasOwn(session.body, "cred")).toBe(true);
    expect(CaptureDescriptor.parse(session.body)).toEqual(session.body);
  });

  it("A17/C1: no Authorization, a malformed Bearer, a wrong tok, the org's own API key and an ENDED code answer the SAME 401 body, each no-store (never key-reachable)", async () => {
    const r = await captureRig();
    const old = { code: r.code, tok: r.tok };
    const fresh = await reissueStreamCode(r.auth, r.fixtureId);   // ends `old` (no session holds it)
    await override(r.auth.orgId, "api.access", true);
    await override(r.auth.orgId, "api.write", true);
    const { secret } = await createApiKey(r.auth, { name: `capture-${randomUUID().slice(0, 6)}`, scopes: ["manage"] });
    const answers = [
      await read(await call(fresh.qr.code, { auth: `Bearer ${secret}` })),
      await read(await call(fresh.qr.code, { auth: null })),
      await read(await call(fresh.qr.code, { auth: "Bearer" })),
      await read(await call(fresh.qr.code, { auth: `Basic ${fresh.qr.tok}` })),
      await read(await call(fresh.qr.code, { auth: `Bearer ${fresh.qr.tok} extra` })),
      await read(await call(fresh.qr.code, { auth: "Bearer not-the-tok" })),
      await read(await call(old.code, { auth: `Bearer ${old.tok}` })),
    ];
    for (const a of answers) {
      expect(a).toMatchObject({ status: 401, ...NO_STORE });
      expect(a.body).toEqual(answers[0]!.body);
    }
    expect(answers[0]!.body).toMatchObject({ code: "code_ended" });
    expect(Object.keys(answers[0]!.body).sort()).toEqual(["code", "message"]);
    expect(CaptureRefusal.parse(answers[0]!.body)).toEqual(answers[0]!.body);
    expect(answers.length).toBe(7);
    // The positive pair: the same request with the right tok on the live code is 200.
    expect((await call(fresh.qr.code, { auth: `Bearer ${fresh.qr.tok}` })).status).toBe(200);
  });

  it("a malformed code → 404 {code: not_a_stream_code, message}, no-store; with NO Bearer the same request is the uniform 401 — no credential, nothing else is answered", async () => {
    const r = await captureRig();
    const a = await read(await call("NOT_A_CODE!", { auth: `Bearer ${r.tok}` }));
    expect(a).toMatchObject({ status: 404, ...NO_STORE, body: { code: "not_a_stream_code" } });
    expect(CaptureRefusal.parse(a.body)).toEqual(a.body);
    expect(await read(await call("NOT_A_CODE!", { auth: null }))).toMatchObject({ status: 401, ...NO_STORE, body: { code: "code_ended" } });
  });

  it("an UNMAPPED failure (a terminal row with no single end reason) is still a no-store answer — the cache headers ride every exit", async () => {
    const r = await captureRig();
    const mine = phoneId("mine");
    const sid = await r.start(mine);
    // Both an end and a fail reason: wireEndReason refuses it by name (TerminalWithoutReason), which nothing maps.
    await sql`update fixture_stream_sessions set state = 'completed', end_reason = 'stopped', fail_reason = 'no_credits', ended_at = now() where id = ${sid}`;
    const a = await read(await call(r.code, { auth: `Bearer ${r.tok}`, query: `?phone=${encodeURIComponent(mine)}` }));
    expect(a).toMatchObject({ status: 500, ...NO_STORE });
  });

  it("slot: omitted is 0 (200); 1 and a non-number are 422 {code: invalid}, no-store (T41)", async () => {
    const r = await captureRig();
    expect((await call(r.code, { auth: `Bearer ${r.tok}` })).status).toBe(200);
    let checked = 0;
    for (const q of ["?slot=1", "?slot=abc", "?slot=-1"]) {
      const a = await read(await call(r.code, { auth: `Bearer ${r.tok}`, query: q }));
      expect(a, q).toMatchObject({ status: 422, ...NO_STORE, body: { code: "invalid" } });
      expect(CaptureRefusal.parse(a.body)).toEqual(a.body);
      checked++;
    }
    expect(checked).toBe(3);
  });

  it("§6.4: a forged X-Forwarded-Host never reaches the answer's urls — the environment's origin does", async () => {
    const r = await captureRig();
    process.env.OAUTH_BASE_URL = "https://seazn.test";
    try {
      const a = await read(await call(r.code, { auth: `Bearer ${r.tok}`, headers: { "x-forwarded-host": "evil.example", "x-forwarded-proto": "https" } }));
      expect(a.status).toBe(200);
      const urls = [a.body.heartbeatUrl, a.body.startUrl, a.body.overlayUrl].filter((u): u is string => typeof u === "string");
      expect(urls.length).toBeGreaterThanOrEqual(2);
      for (const u of urls) expect(new URL(u).host, u).toBe("seazn.test");
      expect(JSON.stringify(a.body)).not.toContain("evil.example");
    } finally {
      delete process.env.OAUTH_BASE_URL;
    }
  });
});

describe.skipIf(!HAS_DB)("the spec documents what the route answers", () => {
  it("OpenAPI (A16): the route is under the internal `capture` tag, BARE (no envelope, no 400), with a captureTok Bearer, and documents every status this file observed", () => {
    const doc = buildOpenApiDocument() as { paths: Record<string, Record<string, { tags: string[]; security: unknown[]; responses: Record<string, { content: { "application/json": { schema: { properties?: Record<string, unknown> } } } }> }>> };
    const op = doc.paths["/api/v1/capture/codes/{code}"]!.get!;
    expect(op.tags).toEqual(["capture"]);
    expect(op.security).toEqual([{ captureTok: [] }]);
    expect(Object.hasOwn(op.responses["200"]!.content["application/json"].schema.properties ?? {}, "ok")).toBe(false);
    expect(op.responses["400"]).toBeUndefined();
    const observed = ["200", "401", "404", "422"];
    for (const s of observed) expect(op.responses[s], s).toBeDefined();
    expect(observed.length).toBe(4);
  });
});

describe("captureRefusal — the wire's extras rule (R5)", () => {
  it("captureJson answers private, no-store and Pragma: no-cache whatever headers it is given", async () => {
    const res = captureJson(200, { a: 1 }, { "cache-control": "public, max-age=60", "retry-after": "3" });
    expect(res.headers.get("cache-control")).toBe("private, no-store");
    expect(res.headers.get("pragma")).toBe("no-cache");
    expect(res.headers.get("retry-after")).toBe("3");
    expect(await res.json()).toEqual({ a: 1 });
  });

  it("already_live carries its extras; any other code carrying extras is refused by name, never put on the wire", async () => {
    const live = captureRefusal(new CaptureRefusalError(409, "already_live", "live", { sid: "s", startedBy: "operator" }));
    expect(await live.json()).toEqual({ code: "already_live", message: "live", sid: "s", startedBy: "operator" });
    expect(live.headers.get("cache-control")).toBe("private, no-store");
    expect(() => captureRefusal(new CaptureRefusalError(409, "replaced", "x", { sid: "s" }))).toThrow(/only already_live/);
  });
});
