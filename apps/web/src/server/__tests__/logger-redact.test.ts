// Capture QR v2 §10.2 (T8c): no phone route ever logs the tok, a stream key or a passphrase.
//
// Two halves, each needed:
//  1. the logger's OWN redaction (server/logger.ts LOGGER_OPTIONS.redact), path by path — a synthetic line carrying the
//     secret at each redacted path, serialised by a pino built from the REAL options, must come out without it. One case
//     per path, so dropping any one path reds its case;
//  2. a SPY on the app's `log`: every call it receives while each phone route runs — success AND every error path — is
//     serialised through that same real configuration, and no captured line contains the tok, the session's stream key
//     or its passphrase. Zero captured lines is a FAILURE (anti-vacuity): a route that logged nothing proves nothing.
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { randomBytes } from "node:crypto";
import pino from "pino";
import { log, LOGGER_OPTIONS } from "../logger";
import { CaptureBeat } from "@/server/api-v1/capture-schemas";
import { disabledRelayDrivers, setRelayDriversForTest } from "@/server/relay/drivers";
import { saveStreamSettings } from "@/server/usecases/stream-codes";
import { captureRig, phoneId, type CaptureRig } from "@/server/usecases/__tests__/_capture-rig";
import { GET } from "@/app/api/v1/capture/codes/[code]/route";
import { POST as BEATS } from "@/app/api/v1/capture/codes/[code]/beats/route";
import { POST as START } from "@/app/api/v1/capture/codes/[code]/start/route";

const HAS_DB = !!process.env.DATABASE_URL;

const lines: string[] = [];
const sink = pino({ ...LOGGER_OPTIONS, level: "trace" }, { write: (s: string) => { lines.push(s); } });
const LEVELS = ["trace", "debug", "info", "warn", "error", "fatal"] as const;
beforeAll(() => {
  for (const level of LEVELS) {
    vi.spyOn(log, level).mockImplementation(((...args: unknown[]) => (sink[level] as (...a: unknown[]) => void)(...args)) as never);
  }
});
afterAll(() => vi.restoreAllMocks());

const ENV_KEYS = ["RELAY_KEK", "AUTH_SECRET", "OAUTH_BASE_URL", "NEXT_PUBLIC_BASE_URL", "STREAM_INGEST_HOST", "STREAM_PLAYBACK_HOST", "STREAM_SRT_ENABLED", "RELAY_DRIVERS"] as const;
const saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
beforeAll(() => {
  for (const k of ENV_KEYS) delete process.env[k];
  process.env.RELAY_KEK = randomBytes(32).toString("hex");
  process.env.AUTH_SECRET = "logger-redact-test-secret";
});
afterAll(() => {
  for (const k of ENV_KEYS) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
  setRelayDriversForTest(null);
});
afterAll(async () => {
  if (!HAS_DB) return;
  const g = globalThis as { _sql?: { end(): Promise<void> } };
  const client = g._sql;
  g._sql = undefined;
  await client?.end();
});

describe("the logger's redaction, path by path (§10.2)", () => {
  const SECRET = "s3cr3t-VALUE-that-must-never-be-written";
  beforeEach(() => { lines.length = 0; });
  const cases: [string, Record<string, unknown>][] = [
    ["req.headers.authorization", { req: { headers: { authorization: `Bearer ${SECRET}` } } }],
    ["*.tok", { qr: { tok: SECRET } }],
    ["*.cred", { descriptor: { cred: SECRET } }],
    ["*.streamKey", { rtmps: { streamKey: SECRET } }],
    ["*.passphrase", { srt: { passphrase: SECRET } }],
    ["tok (top level)", { tok: SECRET }],
    ["cred (top level)", { cred: SECRET }],
    ["streamKey (top level)", { streamKey: SECRET }],
    ["passphrase (top level)", { passphrase: SECRET }],
  ];
  it.each(cases)("%s → [Redacted]", (_path, obj) => {
    log.warn(obj, "redaction probe");
    expect(lines).toHaveLength(1);
    expect(lines[0]).not.toContain(SECRET);
    expect(lines[0]).toContain("[Redacted]");
    expect(lines[0]).toContain("redaction probe");
  });

  it("the positive pair: a field that is not a secret is written as it is", () => {
    log.warn({ fixtureId: SECRET }, "not a secret");
    expect(lines[0]).toContain(SECRET);
  });
});

const BASE = "https://test.local/api/v1/capture/codes";
const params = (code: string) => ({ params: Promise.resolve({ code }) });
const headersOf = (tok: string | null) => ({ "content-type": "application/json", ...(tok === null ? {} : { authorization: `Bearer ${tok}` }) });
function beatOf(r: CaptureRig, phone: string, over: Record<string, unknown>) {
  return CaptureBeat.parse({
    code: r.code, slot: 0, phone, claim: null, device: null, sid: null, at: r.now().toISOString(), state: "paired",
    cause: null, notReady: null, startFailed: null, stopped: null, mode: "operator", transport: null, bitrateKbps: null,
    delivery: "unknown", deliveredLagS: null, audioOk: null, battery: null, thermal: null, dataUsedMB: null,
    appVersion: "capture-test/1", ...over,
  });
}

describe.skipIf(!HAS_DB)("the phone routes never log a secret (§10.2): each route, success and every error path", () => {
  it("GET, beats and start — 200s, 401s, 404, 422s, 409s, 503 — no captured line carries the tok, the stream key or the passphrase; lines were captured", async () => {
    lines.length = 0;
    const r = await captureRig();
    setRelayDriversForTest(r.deps.drivers);
    const A = phoneId("a");
    const statuses: number[] = [];
    const get = async (code: string, tok: string | null, query = "") => {
      const res = await GET(new Request(`${BASE}/${code}${query}`, { headers: headersOf(tok) }), params(code));
      statuses.push(res.status);
      return res;
    };
    const beat = async (tok: string | null, body: unknown, raw?: string) => {
      const res = await BEATS(new Request(`${BASE}/${r.code}/beats`, { method: "POST", headers: headersOf(tok), body: raw ?? JSON.stringify(body) }), params(r.code));
      statuses.push(res.status);
      return res;
    };
    const start = async (tok: string | null, body: unknown, raw?: string) => {
      const res = await START(new Request(`${BASE}/${r.code}/start`, { method: "POST", headers: headersOf(tok), body: raw ?? JSON.stringify(body) }), params(r.code));
      statuses.push(res.status);
      return res;
    };

    await beat(r.tok, beatOf(r, A, { claim: "new" }));                       // 200 claim
    await saveStreamSettings(r.auth, r.fixtureId, { targetId: r.target.id });
    // The relay disabled on this deployment: the start path logs its refusal (503).
    setRelayDriversForTest(disabledRelayDrivers());
    await start(r.tok, { phone: A });                                         // 503
    setRelayDriversForTest(r.deps.drivers);
    const started = (await (await start(r.tok, { phone: A })).json()) as { sid: string };   // 200
    await start(r.tok, { phone: A });                                         // 409 already_live
    await start(r.tok, { phone: phoneId("x") });                              // 409 replaced
    await start(r.tok, null, "{nope");                                        // 422
    await start("wrong-tok", { phone: A });                                   // 401
    const withCred = (await (await get(r.code, r.tok, `?phone=${A}`)).json()) as { cred?: { rtmps: { streamKey: string }; srt: { passphrase: string } | null } };
    await get(r.code, r.tok);                                                 // 200 waiting-or-session without cred
    await get(r.code, "wrong-tok");                                           // 401
    await get(r.code, null);                                                  // 401 no Bearer
    await get("NOT_A_CODE!", r.tok);                                          // 404
    await get(r.code, r.tok, "?slot=1");                                      // 422
    await beat(r.tok, beatOf(r, A, { sid: started.sid, state: "armed" }));    // 200 go-live
    await beat(r.tok, null, "{nope");                                         // 422
    await beat(null, beatOf(r, A, {}));                                       // 401
    await beat(r.tok, beatOf(r, A, { state: "ended", sid: started.sid, endReason: "operator-stopped" }));   // 200 the operator's Stop

    expect(withCred.cred, "PREMISE: the session's phone was served its cred").toBeDefined();
    const secrets = [r.tok, withCred.cred!.rtmps.streamKey, ...(withCred.cred!.srt ? [withCred.cred!.srt.passphrase] : [])];
    expect(secrets.length).toBeGreaterThanOrEqual(2);
    expect(new Set(statuses)).toEqual(new Set([200, 401, 404, 409, 422, 503]));
    expect(lines.length, "anti-vacuity: the routes logged").toBeGreaterThan(0);
    let checked = 0;
    for (const line of lines) {
      for (const s of secrets) expect(line).not.toContain(s);
      checked++;
    }
    expect(checked).toBe(lines.length);
  });
});
