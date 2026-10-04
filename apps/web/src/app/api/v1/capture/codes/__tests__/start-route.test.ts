// Capture QR v2 §6.3.4 over HTTP (T8c): `POST /api/v1/capture/codes/{code}/start` driven through its REAL handler. The
// use-case (capture-start.test.ts) proves the decisions; this file proves the ROUTE carries them:
//   - the 2xx is the BARE `{sid}` (no `ok`), parsed with the contract's twin;
//   - already_live is the ONE refusal with extras ({sid, startedBy}), on the wire;
//   - the body is STRICT: not JSON, an unknown key, a phone outside 16..64 → 422 invalid, nothing written;
//   - no Bearer and the org's own API key answer the descriptor's ONE 401 body (never key-reachable);
//   - every answer is `private, no-store`; none is ever 410.
//
// ONE SPORT, on purpose (TEST-STRATEGY rule 6): the route reads no sport (capture-start.test.ts pins the sport row).
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomBytes, randomUUID } from "node:crypto";
import { sql } from "@/lib/db";
import { buildOpenApiDocument } from "@/server/api-v1/openapi";
import { CaptureBeat, CaptureRefusal, CaptureStartOk } from "@/server/api-v1/capture-schemas";
import { createApiKey } from "@/server/usecases/api-keys";
import { postBeat } from "@/server/usecases/capture-phone";
import { saveStreamSettings } from "@/server/usecases/stream-codes";
import { setRelayDriversForTest } from "@/server/relay/drivers";
import { captureRig as rawRig, override, phoneId, type CaptureRig } from "@/server/usecases/__tests__/_capture-rig";
import { POST } from "../[code]/start/route";

const HAS_DB = !!process.env.DATABASE_URL;

/** The route builds its own deps (defaultDeps): it is pointed at the rig's fakes, whose storage pool is roomy, so no
 *  start here reads 503 storage_exhausted for a reason no test controls. */
async function captureRig(opts: Parameters<typeof rawRig>[0] = {}) {
  const r = await rawRig(opts);
  setRelayDriversForTest(r.deps.drivers);
  return r;
}
afterAll(() => setRelayDriversForTest(null));

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
function call(code: string, payload: unknown, opts: { auth?: string | null; raw?: string } = {}) {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (opts.auth !== null && opts.auth !== undefined) headers.authorization = opts.auth;
  return POST(new Request(`${BASE}/${code}/start`, { method: "POST", headers, body: opts.raw ?? JSON.stringify(payload) }), { params: Promise.resolve({ code }) });
}
const statuses: number[] = [];
async function read(res: Response) {
  statuses.push(res.status);
  return { status: res.status, body: (await res.json()) as Record<string, unknown>, cache: res.headers.get("cache-control"), pragma: res.headers.get("pragma") };
}
const NO_STORE = { cache: "private, no-store", pragma: "no-cache" };

/** The phone claims the slot through the REAL beat; the organiser's pre-pick is the rig's destination. */
async function ready(r: CaptureRig, phone: string) {
  await postBeat(r.code, r.tok, CaptureBeat.parse({
    code: r.code, slot: 0, phone, claim: "new", device: null, sid: null, at: r.now().toISOString(), state: "paired",
    cause: null, notReady: null, startFailed: null, stopped: null, mode: "operator", transport: null, bitrateKbps: null,
    delivery: "unknown", deliveredLagS: null, audioOk: null, battery: null, thermal: null, dataUsedMB: null,
    appVersion: "capture-test/1",
  }), r.deps, r.now());
  await saveStreamSettings(r.auth, r.fixtureId, { targetId: r.target.id });
}
const sessionCount = async (r: CaptureRig) =>
  (await sql<{ n: number }[]>`select count(*)::int as n from fixture_stream_sessions where fixture_id = ${r.fixtureId}`)[0]!.n;

describe.skipIf(!HAS_DB)("POST /api/v1/capture/codes/{code}/start", () => {
  it("200: the bare {sid}; the retry meets 409 already_live {code, message, sid, startedBy} on the wire — both no-store", async () => {
    const r = await captureRig();
    const A = phoneId("a");
    await ready(r, A);
    const ok = await read(await call(r.code, { phone: A }, { auth: `Bearer ${r.tok}` }));
    expect(ok).toMatchObject({ status: 200, ...NO_STORE });
    expect(Object.hasOwn(ok.body, "ok")).toBe(false);
    expect(CaptureStartOk.parse(ok.body)).toEqual(ok.body);
    const again = await read(await call(r.code, { phone: A }, { auth: `Bearer ${r.tok}` }));
    expect(again).toMatchObject({ status: 409, ...NO_STORE, body: { code: "already_live", sid: ok.body.sid, startedBy: "operator" } });
    expect(CaptureRefusal.parse(again.body)).toEqual(again.body);
    expect(Object.keys(again.body).sort()).toEqual(["code", "message", "sid", "startedBy"]);
    // T12 on the wire: a phone that is not current — no extras.
    const stranger = await read(await call(r.code, { phone: phoneId("x") }, { auth: `Bearer ${r.tok}` }));
    expect(stranger).toMatchObject({ status: 409, ...NO_STORE, body: { code: "replaced" } });
    expect(Object.keys(stranger.body).sort()).toEqual(["code", "message"]);
  });

  it("STRICT body: not JSON, an unknown key, a phone of 15 or 65 characters, a missing phone → 422 invalid, no-store, nothing written", async () => {
    const r = await captureRig();
    const A = phoneId("a");
    await ready(r, A);
    const auth = `Bearer ${r.tok}`;
    const cases: [string, unknown, string?][] = [
      ["not JSON", null, "{nope"],
      ["an unknown key", { phone: A, slot: 0 }],
      ["a phone of 15", { phone: "p".repeat(15) }],
      ["a phone of 65", { phone: "p".repeat(65) }],
      ["no phone", {}],
    ];
    let checked = 0;
    for (const [why, payload, raw] of cases) {
      const a = await read(await call(r.code, payload, { auth, raw }));
      expect(a, why).toMatchObject({ status: 422, ...NO_STORE, body: { code: "invalid" } });
      expect(Object.keys(a.body).sort()).toEqual(["code", "message"]);
      checked++;
    }
    expect(checked).toBe(cases.length);
    expect(await sessionCount(r)).toBe(0);
  });

  it("A17/C1: no Bearer and the org's own API key answer the ONE 401 body; nothing written", async () => {
    const r = await captureRig();
    const A = phoneId("a");
    await ready(r, A);
    await override(r.auth.orgId, "api.access", true);
    await override(r.auth.orgId, "api.write", true);
    const { secret } = await createApiKey(r.auth, { name: `capture-${randomUUID().slice(0, 6)}`, scopes: ["manage"] });
    const none = await read(await call(r.code, { phone: A }, { auth: null }));
    const key = await read(await call(r.code, { phone: A }, { auth: `Bearer ${secret}` }));
    for (const a of [none, key]) {
      expect(a).toMatchObject({ status: 401, ...NO_STORE, body: { code: "code_ended" } });
      expect(a.body).toEqual(none.body);
    }
    expect(await sessionCount(r)).toBe(0);
  });

  it("OpenAPI (A16): under the internal `capture` tag, BARE, captureTok, the strict body; documents every status this file observed", () => {
    const doc = buildOpenApiDocument() as { paths: Record<string, Record<string, { tags: string[]; security: unknown[]; requestBody?: unknown; responses: Record<string, unknown> }>> };
    const op = doc.paths["/api/v1/capture/codes/{code}/start"]!.post!;
    expect(op.tags).toEqual(["capture"]);
    expect(op.security).toEqual([{ captureTok: [] }]);
    expect(op.requestBody).toBeDefined();
    const observed = [...new Set(statuses)].sort();
    expect(observed).toEqual([200, 401, 409, 422]);
    for (const s of [...observed, 402, 403, 429, 503]) expect(op.responses[String(s)], String(s)).toBeDefined();
  });

  it("never 410: no answer in this file was a 410 — and the file did answer", () => {
    expect(statuses.length).toBeGreaterThan(8);
    expect(statuses).not.toContain(410);
  });
});
