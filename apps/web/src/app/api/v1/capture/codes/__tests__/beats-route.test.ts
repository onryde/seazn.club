// Capture QR v2 §6.3.2 over HTTP (T8b): `POST /api/v1/capture/codes/{code}/beats` driven through its REAL handler. The
// use-case (capture-beat.test.ts) proves the transitions; this file proves the ROUTE carries them:
//   - a 2xx is the BARE answer (no `ok`), parsed with its own branch of the contract's union;
//   - the body is STRICT (Review Focus 2): an unknown key, an over-long appVersion or device.model, each D16 cross-field
//     rule, a body that is not JSON → 422 {code: invalid}; nothing is written for any of them;
//   - the Bearer refusals answer the SAME 401 body as the descriptor's (A17, C1);
//   - every answer is `private, no-store`; no answer is ever 410 (ask 8).
//
// ONE SPORT, on purpose (TEST-STRATEGY rule 6): the route reads no sport (capture-beat.test.ts pins the sport row).
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomBytes } from "node:crypto";
import { sql } from "@/lib/db";
import { buildOpenApiDocument } from "@/server/api-v1/openapi";
import { CaptureBeatAnswer, CaptureRefusal } from "@/server/api-v1/capture-schemas";
import { captureRig, phoneId, type CaptureRig } from "@/server/usecases/__tests__/_capture-rig";
import { POST } from "../[code]/beats/route";

const HAS_DB = !!process.env.DATABASE_URL;

const ENV_KEYS = ["RELAY_KEK", "OAUTH_BASE_URL", "NEXT_PUBLIC_BASE_URL", "STREAM_PLAYBACK_HOST", "STREAM_SRT_ENABLED", "RELAY_DRIVERS"] as const;
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
  return POST(new Request(`${BASE}/${code}/beats`, { method: "POST", headers, body: opts.raw ?? JSON.stringify(payload) }), { params: Promise.resolve({ code }) });
}
const statuses: number[] = [];
async function read(res: Response) {
  statuses.push(res.status);
  return { status: res.status, body: (await res.json()) as Record<string, unknown>, cache: res.headers.get("cache-control"), pragma: res.headers.get("pragma") };
}
const NO_STORE = { cache: "private, no-store", pragma: "no-cache" };

function beatOf(r: CaptureRig, phone: string, over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    code: r.code, slot: 0, phone, claim: null, device: null, sid: null, at: r.now().toISOString(), state: "paired",
    cause: null, notReady: null, startFailed: null, stopped: null, mode: "operator", transport: null, bitrateKbps: null,
    delivery: "unknown", deliveredLagS: null, audioOk: null, battery: null, thermal: null, dataUsedMB: null,
    appVersion: "capture-test/1", ...over,
  };
}
const pairingCount = async (r: CaptureRig) => (await sql<{ n: number }[]>`
  select count(*)::int as n from fixture_stream_pairings p join fixture_stream_codes c on c.id = p.code_id where c.fixture_id = ${r.fixtureId}`)[0]!.n;

describe.skipIf(!HAS_DB)("POST /api/v1/capture/codes/{code}/beats", () => {
  it("200: the bare answer per state (no envelope) — a claim's `waiting`, the started session's `go-live`, an unknown phone's `replaced` — each parsed with its own branch, each no-store", async () => {
    const r = await captureRig({ connectAfterMs: 3_600_000 });
    const A = phoneId("a");
    const auth = `Bearer ${r.tok}`;
    const seen: string[] = [];
    const waiting = await read(await call(r.code, beatOf(r, A, { claim: "new" }), { auth }));
    const sid = await r.start(A);
    const goLive = await read(await call(r.code, beatOf(r, A, { sid, state: "armed" }), { auth }));
    const replaced = await read(await call(r.code, beatOf(r, phoneId("b")), { auth }));
    for (const [a, state] of [[waiting, "waiting"], [goLive, "go-live"], [replaced, "replaced"]] as const) {
      expect(a, state).toMatchObject({ status: 200, ...NO_STORE, body: { state } });
      expect(Object.hasOwn(a.body, "ok")).toBe(false);
      expect(CaptureBeatAnswer.parse(a.body)).toEqual(a.body);
      seen.push(state);
    }
    expect(goLive.body).toMatchObject({ sid, startedBy: "organiser" });
    expect(seen).toHaveLength(3);
  });

  it("STRICT body (Review Focus 2, D16): each malformed beat → 422 {code: invalid}, no-store, and NOTHING written", async () => {
    const r = await captureRig();
    const A = phoneId("a");
    const auth = `Bearer ${r.tok}`;
    const cases: [string, unknown, string?][] = [
      ["an unknown key", { ...beatOf(r, A, { claim: "new" }), extra: 1 }],
      ["appVersion of 41 characters", beatOf(r, A, { claim: "new", appVersion: "v".repeat(41) })],
      ["device.model of 81 characters", beatOf(r, A, { claim: "new", device: { model: "m".repeat(81) } })],
      ["endReason without state ended", beatOf(r, A, { claim: "new", endReason: "operator-stopped" })],
      ["stopped with a non-null sid", beatOf(r, A, { claim: "new", sid: "00000000-0000-4000-8000-000000000001", stopped: "00000000-0000-4000-8000-000000000002" })],
      ["an `at` with no timezone", beatOf(r, A, { claim: "new", at: "2026-10-01T10:00:00" })],
      ["slot 1", beatOf(r, A, { claim: "new", slot: 1 })],
      ["a body naming another code", beatOf(r, A, { claim: "new", code: "0123456789ab" })],
      ["a body that is not JSON", null, "{not json"],
    ];
    let checked = 0;
    for (const [why, payload, raw] of cases) {
      const a = await read(await call(r.code, payload, { auth, raw }));
      expect(a, why).toMatchObject({ status: 422, ...NO_STORE, body: { code: "invalid" } });
      expect(CaptureRefusal.parse(a.body)).toEqual(a.body);
      checked++;
    }
    expect(checked).toBe(cases.length);
    expect(await pairingCount(r), "a refused beat writes nothing").toBe(0);
    // The positive pair: the same claim, well-formed, is 200 and pairs.
    expect((await call(r.code, beatOf(r, A, { claim: "new" }), { auth })).status).toBe(200);
    expect(await pairingCount(r)).toBe(1);
  });

  it("A17/C1: no Authorization and a wrong tok answer the descriptor's ONE 401 body; a malformed path code is 404 — each no-store", async () => {
    const r = await captureRig();
    const A = phoneId("a");
    const none = await read(await call(r.code, beatOf(r, A, { claim: "new" }), { auth: null }));
    const wrong = await read(await call(r.code, beatOf(r, A, { claim: "new" }), { auth: "Bearer not-the-tok" }));
    for (const a of [none, wrong]) {
      expect(a).toMatchObject({ status: 401, ...NO_STORE, body: { code: "code_ended" } });
      expect(a.body).toEqual(none.body);
      expect(Object.keys(a.body).sort()).toEqual(["code", "message"]);
    }
    const bad = await read(await call("NOT_A_CODE!", beatOf(r, A, { claim: "new" }), { auth: `Bearer ${r.tok}` }));
    expect(bad).toMatchObject({ status: 404, ...NO_STORE, body: { code: "not_a_stream_code" } });
    expect(await pairingCount(r)).toBe(0);
  });

  it("OpenAPI (A16): the route is under the internal `capture` tag, BARE, with the captureTok Bearer and the strict beat body; documents every status this file observed", () => {
    const doc = buildOpenApiDocument() as { paths: Record<string, Record<string, { tags: string[]; security: unknown[]; requestBody?: unknown; responses: Record<string, unknown> }>> };
    const op = doc.paths["/api/v1/capture/codes/{code}/beats"]!.post!;
    expect(op.tags).toEqual(["capture"]);
    expect(op.security).toEqual([{ captureTok: [] }]);
    expect(op.requestBody).toBeDefined();
    expect(op.responses["400"]).toBeUndefined();
    const observed = [...new Set(statuses)].sort();
    expect(observed).toEqual([200, 401, 404, 422]);
    for (const s of observed) expect(op.responses[String(s)], String(s)).toBeDefined();
  });

  it("never 410 (ask 8): no answer in this file was a 410 — and the file did answer", () => {
    expect(statuses.length).toBeGreaterThan(10);
    expect(statuses).not.toContain(410);
  });
});
