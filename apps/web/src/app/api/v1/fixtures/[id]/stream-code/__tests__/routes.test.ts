// Capture QR v2 §6.1 / §9 (T5) over HTTP: the three organiser routes — ensure (`POST …/stream-code`), revoke & reissue
// (`POST …/stream-code/reissue`) and the destination pre-pick (`PUT …/stream-settings`) — driven through their REAL
// handlers over a real session (`requireResourceAuth` unmocked; only the cookie door is faked one layer down, the
// stream-sessions routes test's pattern). stream-codes.test.ts proves the usecase; this file proves the ROUTES carry it:
//   - the envelope: 200 {qr, issuedAt}, the same QR on a second ensure, a different one after a reissue;
//   - the ensure answer carries a live tok, so EVERY answer is `private, no-store` (spec §9) and varies on both
//     credentials the route reads;
//   - every refusal (402 without streaming.relay, 422 fixture_finished, 404 another org's target) reaches the wire, and
//     each status is a documented response of that route in the OpenAPI spec;
//   - API keys are refused at the door on all three (NEVER_KEY_ROUTES), and it is THAT refusal, not the usecase's own
//     session-only 403 that shares its status.
//
// ONE SPORT, on purpose (TEST-STRATEGY rule 6): nothing on these routes reads the sport.
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { randomBytes, randomUUID } from "node:crypto";

const authState = vi.hoisted(() => ({ userId: "" }));

vi.mock("@/lib/auth", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/auth")>();
  return {
    ...actual,
    requireUser: async () => ({ id: authState.userId }),
    getCurrentUser: async () => ({ id: authState.userId }),
    getActiveOrgId: async () => null,
  };
});

vi.mock("next/headers", () => ({
  cookies: async () => ({ get: () => undefined, set: () => {}, delete: () => {} }),
  headers: async () => new Headers(),
}));

import { sql } from "@/lib/db";
import { invalidateOrgEntitlements } from "@/lib/entitlements";
import { buildOpenApiDocument } from "@/server/api-v1/openapi";
import { StreamCodeShown, StreamSettings } from "@/server/api-v1/schemas";
import { createApiKey } from "@/server/usecases/api-keys";
import { createStreamTarget } from "@/server/usecases/stream-targets";
import { seedOrg } from "@/server/usecases/__tests__/_seed";
import { startedDivisionWithFixture } from "@/server/usecases/__tests__/_rig";
import { POST as ensureRoute } from "../route";
import { POST as reissueRoute } from "../reissue/route";
import { PUT as settingsRoute } from "../../stream-settings/route";

const HAS_DB = !!process.env.DATABASE_URL;

const savedKek = process.env.RELAY_KEK;
beforeAll(() => { process.env.RELAY_KEK = randomBytes(32).toString("hex"); });
afterAll(() => {
  if (savedKek === undefined) delete process.env.RELAY_KEK;
  else process.env.RELAY_KEK = savedKek;
});
afterAll(async () => {
  if (!HAS_DB) return;
  const g = globalThis as { _sql?: { end(): Promise<void> } };
  const client = g._sql;
  g._sql = undefined;
  await client?.end();
});

const BASE = "https://test.local/api/v1";

interface Envelope<T = unknown> {
  ok: boolean;
  data?: T;
  error?: { code: string; message: string; [k: string]: unknown };
  requestId?: string;
}

async function override(orgId: string, key: string, value: boolean) {
  await sql`insert into org_entitlement_overrides (org_id, feature_key, bool_value, reason) values (${orgId}, ${key}, ${value}, 'stream code routes')
            on conflict (org_id, feature_key) do update set bool_value = ${value}`;
  await invalidateOrgEntitlements(orgId);
}

/** A signed-in owner of a fresh org with one started fixture and (by default) the relay entitlement. */
async function organiser(opts: { relay?: boolean } = {}) {
  const { auth } = await seedOrg("pro");
  authState.userId = auth.userId!;
  const d = await startedDivisionWithFixture(auth);
  await override(auth.orgId, "streaming.relay", opts.relay ?? true);
  return { auth, fixtureId: d.fixtureId };
}

function request(method: string, path: string, body?: unknown, headers: Record<string, string> = {}): Request {
  return new Request(`${BASE}${path}`, {
    method,
    headers: { "content-type": "application/json", ...headers },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}
const params = (id: string) => ({ params: Promise.resolve({ id }) });
const ensureRaw = (fixtureId: string, headers?: Record<string, string>) =>
  ensureRoute(request("POST", `/fixtures/${fixtureId}/stream-code`, undefined, headers), params(fixtureId));
const reissueRaw = (fixtureId: string, headers?: Record<string, string>) =>
  reissueRoute(request("POST", `/fixtures/${fixtureId}/stream-code/reissue`, undefined, headers), params(fixtureId));
const settingsRaw = (fixtureId: string, body: unknown, headers?: Record<string, string>) =>
  settingsRoute(request("PUT", `/fixtures/${fixtureId}/stream-settings`, body, headers), params(fixtureId));
async function read<T>(res: Response): Promise<{ status: number; body: Envelope<T> }> {
  return { status: res.status, body: (await res.json()) as Envelope<T> };
}

type Op = { responses: Record<string, unknown> };
const documented = (path: string, method: "post" | "put"): string[] =>
  Object.keys((buildOpenApiDocument() as { paths: Record<string, Record<string, Op>> }).paths[`/api/v1${path}`]![method]!.responses);

describe.skipIf(!HAS_DB)("POST …/stream-code and …/stream-code/reissue over HTTP", () => {
  it("ensure → 200 {qr, issuedAt}; a SECOND ensure → the same QR; reissue → 200 a different code; the next ensure re-shows the reissued one", async () => {
    const o = await organiser();
    const first = await read<StreamCodeShown>(await ensureRaw(o.fixtureId));
    expect(first.status).toBe(200);
    const shown = StreamCodeShown.parse(first.body.data);
    expect(shown.qr).toMatchObject({ v: 2, slot: 0 });
    const second = await read<StreamCodeShown>(await ensureRaw(o.fixtureId));
    expect(StreamCodeShown.parse(second.body.data)).toEqual(shown);
    const reissued = await read<StreamCodeShown>(await reissueRaw(o.fixtureId));
    expect(reissued.status).toBe(200);
    const fresh = StreamCodeShown.parse(reissued.body.data);
    expect(fresh.qr.code).not.toBe(shown.qr.code);
    expect(StreamCodeShown.parse((await read<StreamCodeShown>(await ensureRaw(o.fixtureId))).body.data)).toEqual(fresh);
    const [{ n }] = await sql<{ n: number }[]>`select count(*)::int as n from fixture_stream_codes where fixture_id = ${o.fixtureId} and ended_at is null`;
    expect(n).toBe(1);
  });

  it("every ensure and reissue answer is `private, no-store` and varies on Cookie and Authorization — the 200 that carries a tok, and each refusal", async () => {
    const o = await organiser();
    const unpaid = await organiser({ relay: false });
    const finished = await organiser();
    await sql`update fixtures set status = 'cancelled' where id = ${finished.fixtureId}`;
    authState.userId = o.auth.userId!;
    const answers: [string, Response][] = [];
    answers.push(["200 ensure", await ensureRaw(o.fixtureId)]);
    answers.push(["200 reissue", await reissueRaw(o.fixtureId)]);
    authState.userId = unpaid.auth.userId!;
    answers.push(["402 ensure", await ensureRaw(unpaid.fixtureId)]);
    answers.push(["402 reissue", await reissueRaw(unpaid.fixtureId)]);
    authState.userId = finished.auth.userId!;
    answers.push(["422 ensure", await ensureRaw(finished.fixtureId)]);
    answers.push(["422 reissue", await reissueRaw(finished.fixtureId)]);
    expect(answers.map(([, r]) => r.status)).toEqual([200, 200, 402, 402, 422, 422]);
    let checked = 0;
    for (const [label, r] of answers) {
      expect(r.headers.get("cache-control"), label).toMatch(/(^|,\s*)no-store(\s*,|$)/);
      expect(r.headers.get("cache-control"), label).toMatch(/(^|,\s*)private(\s*,|$)/);
      const vary = (r.headers.get("vary") ?? "").toLowerCase().split(/\s*,\s*/);
      expect(vary, label).toEqual(expect.arrayContaining(["cookie", "authorization"]));
      checked++;
    }
    expect(checked).toBe(6);
  });

  it("refusals reach the wire: no streaming.relay → 402 naming the feature; a finished fixture → 422 fixture_finished — and each status is documented on its route", async () => {
    const unpaid = await organiser({ relay: false });
    const seen: [string, string, number][] = [];
    for (const [path, call] of [["/fixtures/{id}/stream-code", ensureRaw], ["/fixtures/{id}/stream-code/reissue", reissueRaw]] as const) {
      const r = await read(await call(unpaid.fixtureId));
      expect(r.status, path).toBe(402);
      expect(r.body.error, path).toMatchObject({ feature_key: "streaming.relay" });
      seen.push([path, "402", r.status]);
    }
    const finished = await organiser();
    await sql`update fixtures set status = 'cancelled' where id = ${finished.fixtureId}`;
    for (const [path, call] of [["/fixtures/{id}/stream-code", ensureRaw], ["/fixtures/{id}/stream-code/reissue", reissueRaw]] as const) {
      const r = await read(await call(finished.fixtureId));
      expect(r.status, path).toBe(422);
      expect(r.body.error, path).toMatchObject({ code: "fixture_finished" });
      seen.push([path, "422", r.status]);
    }
    expect(seen).toHaveLength(4);
    for (const [path, status] of seen) expect(documented(path, "post"), `${path} documents ${status}`).toContain(status);
    for (const path of ["/fixtures/{id}/stream-code", "/fixtures/{id}/stream-code/reissue"]) {
      expect(documented(path, "post"), `${path} documents the missing-KEK 503`).toContain("503");
    }
  });
});

describe.skipIf(!HAS_DB)("PUT …/stream-settings over HTTP", () => {
  it("saves the org's target → 200 {targetId}; null clears; another org's target is 404 (documented) and leaves the pick", async () => {
    const o = await organiser();
    const target = await createStreamTarget(o.auth, o.auth.orgId, { kind: "youtube", label: "Court", streamKey: `k-${randomUUID().slice(0, 8)}` });
    const saved = await read<StreamSettings>(await settingsRaw(o.fixtureId, { targetId: target.id }));
    expect(saved.status).toBe(200);
    expect(StreamSettings.parse(saved.body.data)).toEqual({ targetId: target.id });
    const other = await organiser();
    const theirs = await createStreamTarget(other.auth, other.auth.orgId, { kind: "youtube", label: "Theirs", streamKey: `k-${randomUUID().slice(0, 8)}` });
    authState.userId = o.auth.userId!;
    const refused = await read(await settingsRaw(o.fixtureId, { targetId: theirs.id }));
    expect(refused.status).toBe(404);
    expect(documented("/fixtures/{id}/stream-settings", "put")).toContain("404");
    const [row] = await sql<{ target_id: string | null }[]>`select target_id from fixture_stream_settings where fixture_id = ${o.fixtureId}`;
    expect(row!.target_id).toBe(target.id);
    const cleared = await read<StreamSettings>(await settingsRaw(o.fixtureId, { targetId: null }));
    expect(StreamSettings.parse(cleared.body.data)).toEqual({ targetId: null });
  });

  it("the body is strict: an unknown key or a missing targetId is refused and writes nothing", async () => {
    const o = await organiser();
    let checked = 0;
    for (const body of [{}, { targetId: null, autoStream: true }, { targetId: "not-a-uuid" }]) {
      const r = await settingsRaw(o.fixtureId, body);
      expect(r.status, JSON.stringify(body)).toBeGreaterThanOrEqual(400);
      expect(r.status, JSON.stringify(body)).toBeLessThan(500);
      checked++;
    }
    expect(checked).toBe(3);
    const [{ n }] = await sql<{ n: number }[]>`select count(*)::int as n from fixture_stream_settings where fixture_id = ${o.fixtureId}`;
    expect(n).toBe(0);
  });
});

describe.skipIf(!HAS_DB)("the three routes are never key-reachable (NEVER_KEY_ROUTES)", () => {
  it("an API key with every scope is refused at the DOOR on ensure, reissue and settings — never the usecase's session-only 403 — and writes nothing; the owner's session reaches the same doors", async () => {
    const o = await organiser();
    await override(o.auth.orgId, "api.access", true);
    await override(o.auth.orgId, "api.write", true);
    const { secret } = await createApiKey(o.auth, { name: `code-${randomUUID().slice(0, 6)}`, scopes: ["manage"] });
    const bearer = { authorization: `Bearer ${secret}` };
    const calls: [string, () => Promise<Response>][] = [
      ["ensure", () => ensureRaw(o.fixtureId, bearer)],
      ["reissue", () => reissueRaw(o.fixtureId, bearer)],
      ["settings", () => settingsRaw(o.fixtureId, { targetId: null }, bearer)],
    ];
    let checked = 0;
    for (const [label, call] of calls) {
      const r = await read(await call());
      expect(r.status, label).toBe(403);
      expect(r.body.error?.message, label).toMatch(/cannot access this endpoint/);
      checked++;
    }
    expect(checked).toBe(3);
    const [{ n }] = await sql<{ n: number }[]>`select count(*)::int as n from fixture_stream_codes where fixture_id = ${o.fixtureId}`;
    expect(n).toBe(0);
    authState.userId = o.auth.userId!;
    expect((await ensureRaw(o.fixtureId)).status).toBe(200);
    expect((await settingsRaw(o.fixtureId, { targetId: null })).status).toBe(200);
  });

  it("a signed-in user who is not a member of the fixture's org is refused, and no code is minted", async () => {
    const o = await organiser();
    const stranger = await organiser();
    authState.userId = stranger.auth.userId!;
    let checked = 0;
    for (const call of [ensureRaw, reissueRaw]) {
      // The door's own answer for a non-member (requireResourceAuth: 401) — any refusal will do; what matters is no mint.
      const status = (await call(o.fixtureId)).status;
      expect([401, 403, 404]).toContain(status);
      checked++;
    }
    expect(checked).toBe(2);
    const [{ n }] = await sql<{ n: number }[]>`select count(*)::int as n from fixture_stream_codes where fixture_id = ${o.fixtureId}`;
    expect(n).toBe(0);
  });
});
