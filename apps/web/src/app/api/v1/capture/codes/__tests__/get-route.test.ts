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
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { randomBytes, randomUUID } from "node:crypto";
import { ZodError } from "zod";
import { sql } from "@/lib/db";
import { HttpError } from "@/lib/errors";
import { log } from "@/server/logger";
import { CaptureRefusalError, captureJson, captureRefusal, captureRoute } from "@/server/api-v1/capture-http";
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

  it("an UNMAPPED failure (a terminal row with no single end reason) is the contract's 503 {code: unavailable} — no internal text, logged, no-store (B6 review M-5)", async () => {
    const r = await captureRig();
    const mine = phoneId("mine");
    const sid = await r.start(mine);
    // Both an end and a fail reason: wireEndReason refuses it by name (TerminalWithoutReason), which nothing maps.
    await sql`update fixture_stream_sessions set state = 'completed', end_reason = 'stopped', fail_reason = 'no_credits', ended_at = now() where id = ${sid}`;
    const errors = vi.spyOn(log, "error").mockImplementation(() => undefined);
    try {
      const a = await read(await call(r.code, { auth: `Bearer ${r.tok}`, query: `?phone=${encodeURIComponent(mine)}` }));
      expect(a).toMatchObject({ status: 503, ...NO_STORE, body: { code: "unavailable" } });
      expect(CaptureRefusal.parse(a.body)).toEqual(a.body);
      expect(Object.keys(a.body).sort()).toEqual(["code", "message"]);
      expect(JSON.stringify(a.body), "no internal text reaches the phone").not.toMatch(/TerminalWithoutReason|end_reason|fail_reason|no_credits/i);
      expect(errors, "still logged").toHaveBeenCalledTimes(1);
    } finally {
      errors.mockRestore();
    }
  });

  it("phone: absent is waiting (200); present it is the contract's 16–64 characters — empty, 15 and 65 characters are 422 {code: invalid}, no-store; 16 and 64 are served (B6 review M-4)", async () => {
    const r = await captureRig();
    expect((await read(await call(r.code, { auth: `Bearer ${r.tok}` }))).body.state).toBe("waiting");
    let checked = 0;
    for (const phone of ["", "x".repeat(15), "x".repeat(65)]) {
      const a = await read(await call(r.code, { auth: `Bearer ${r.tok}`, query: `?phone=${phone}` }));
      expect(a, `phone of ${phone.length}`).toMatchObject({ status: 422, ...NO_STORE, body: { code: "invalid" } });
      expect(CaptureRefusal.parse(a.body)).toEqual(a.body);
      checked++;
    }
    for (const phone of ["x".repeat(16), "x".repeat(64)]) {
      const a = await read(await call(r.code, { auth: `Bearer ${r.tok}`, query: `?phone=${phone}` }));
      expect(a, `phone of ${phone.length}`).toMatchObject({ status: 200, body: { state: "waiting" } });
      checked++;
    }
    expect(checked).toBe(5);
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
    const observed = ["200", "401", "404", "422", "503"];
    for (const s of observed) expect(op.responses[s], s).toBeDefined();
    expect(observed.length).toBe(5);
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

describe("captureRoute — anything unmapped is the contract's 503 unavailable (B6 review M-5)", () => {
  it("an assumption guard's HttpError, a race's 404, a ZodError and a plain Error each answer 503 {code: unavailable} with a fixed message, logged; a capture refusal and the limiter's 429 are unchanged", async () => {
    const errors = vi.spyOn(log, "error").mockImplementation(() => undefined);
    try {
      const unmapped: unknown[] = [
        new HttpError(409, "no phone is paired and answering", "phone_not_paired"),
        // Owner ruling 2026-10-09: the console's second W5 answer is the console's too — never on the phone's wire.
        new HttpError(409, "the phone paired on this match's stream code is not responding", "phone_not_responding"),
        new HttpError(404, "fixture not found"),
        new ZodError([]),
        new Error("relation seazn_club.secret_table does not exist"),
      ];
      const messages = new Set<string>();
      let checked = 0;
      for (const e of unmapped) {
        const res = await captureRoute(async () => { throw e; });
        const body = (await res.json()) as Record<string, unknown>;
        expect(res.status, String(e)).toBe(503);
        expect(res.headers.get("cache-control")).toBe("private, no-store");
        expect(CaptureRefusal.parse(body)).toEqual(body);
        expect(body.code).toBe("unavailable");
        expect(JSON.stringify(body)).not.toMatch(/paired|responding|fixture not found|secret_table/);
        messages.add(String(body.message));
        checked++;
      }
      expect(checked).toBe(unmapped.length);
      expect([...messages], "one fixed message, whatever the cause").toHaveLength(1);
      expect(errors).toHaveBeenCalledTimes(unmapped.length);
      const refusal = await captureRoute(async () => { throw new CaptureRefusalError(409, "replaced", "not current"); });
      expect([refusal.status, await refusal.json()]).toEqual([409, { code: "replaced", message: "not current" }]);
      const limited = await captureRoute(async () => { throw new HttpError(429, "slow down", undefined, undefined, { "Retry-After": "7" }); });
      expect([limited.status, limited.headers.get("retry-after"), ((await limited.json()) as { code: string }).code]).toEqual([429, "7", "rate_limited"]);
      expect(errors, "a mapped refusal logs nothing").toHaveBeenCalledTimes(unmapped.length);
    } finally {
      errors.mockRestore();
    }
  });

  it("an answer captureJson never built still leaves private, no-store: a refusal whose extras the wire refuses escapes to handler()'s own 500, and the route's last pass puts the cache headers on it (T10's mutation sweep: that pass alone was killed by nothing)", async () => {
    const errors = vi.spyOn(log, "error").mockImplementation(() => undefined);
    try {
      const res = await captureRoute(async () => { throw new CaptureRefusalError(409, "replaced", "x", { sid: "s" }); });
      expect(res.status, "PREMISE: handler() answered it, not captureJson").toBe(500);
      expect(JSON.stringify(await res.json()), "PREMISE: the refused extras never reach the wire").not.toContain('"sid"');
      expect([res.headers.get("cache-control"), res.headers.get("pragma")]).toEqual(["private, no-store", "no-cache"]);
    } finally {
      errors.mockRestore();
    }
  });
});
