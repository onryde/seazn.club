// O17 over HTTP (web batch A4, owner 2026-11-17: "switching Stream off should stop the video now"): `PUT
// /api/v1/fixtures/{id}/court-stream {on: false}`, driven through its REAL handler (`requireResourceAuth` unmocked; only the
// cookie door is faked one layer down, the stream-phone route test's pattern), ends the match's open court session — so the
// route hands the usecase the relay's deps, and the stop is not a seam only the usecase test drives. The relay is the
// process's own (`defaultDeps`), set to fakes with `setRelayDriversForTest`. The usecase's cases are capture-court.test.ts's.
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
import { CaptureBeat } from "@/server/api-v1/capture-schemas";
import { FakeIngest, FakeRunner } from "@/server/relay/fakes";
import { FakeYouTube } from "@/server/youtube/fake";
import { setRelayDriversForTest } from "@/server/relay/drivers";
import { rigUser } from "@/server/relay/__tests__/_session-rig";
import { connect } from "@/server/youtube/__tests__/_connect-rig";
import { postBeat } from "@/server/usecases/capture-phone";
import { linkCourtStream, setCourtStream } from "@/server/usecases/court-streams";
import { grantCredits } from "@/server/usecases/stream-credits";
import { startBroadcast, type SessionDeps } from "@/server/usecases/stream-sessions";
import { place, seedDay, setStatus } from "@/server/usecases/__tests__/_match-day-seed";
import { PUT as courtStreamRoute } from "../route";

const HAS_DB = !!process.env.DATABASE_URL;
const ENV = ["RELAY_KEK", "YOUTUBE_TOKEN_KEK", "COURT_MIN_APP_VERSION"] as const;
const savedEnv = Object.fromEntries(ENV.map((k) => [k, process.env[k]]));
beforeAll(() => {
  process.env.RELAY_KEK = randomBytes(32).toString("hex");
  process.env.YOUTUBE_TOKEN_KEK = randomBytes(32).toString("hex");
  process.env.COURT_MIN_APP_VERSION = "1.0.14-1200";
});
afterAll(async () => {
  setRelayDriversForTest(null);
  for (const k of ENV) {
    if (savedEnv[k] === undefined) delete process.env[k]; else process.env[k] = savedEnv[k];
  }
  if (!HAS_DB) return;
  const g = globalThis as { _sql?: { end(): Promise<void> } };
  const client = g._sql;
  g._sql = undefined;
  await client?.end();
});

async function override(orgId: string, key: string, value: boolean) {
  await sql`insert into org_entitlement_overrides (org_id, feature_key, bool_value, reason) values (${orgId}, ${key}, ${value}, 'court stream route')
            on conflict (org_id, feature_key) do update set bool_value = ${value}`;
  await invalidateOrgEntitlements(orgId);
}

describe.skipIf(!HAS_DB)("PUT …/court-stream over HTTP (O17)", () => {
  it("{on: false} on a match whose court session is open → 200 {on: false}, and the session is stopped as the organiser's Stop", async () => {
    const ingest = new FakeIngest({ connectAfterMs: 0 });
    const runner = new FakeRunner();
    setRelayDriversForTest({ ingest, runner });
    const deps: SessionDeps = { drivers: { ingest, runner }, now: () => new Date(), appUrl: "http://app.test", youtube: new FakeYouTube() };
    const day = await seedDay();
    const fx = day.comp.fixtures[0]!.id;
    await override(day.orgId, "streaming.relay", true);
    await override(day.orgId, "streaming.overlay", true);
    await grantCredits({ orgId: day.orgId, delta: 3, createdBy: await rigUser(), note: "court route", idempotencyKey: randomUUID() });
    // The link is for REAL today (the switch's guard reads the clock), the match on its court and in play, switched on.
    const api = await connect({ auth: day.auth, orgId: day.orgId, userId: day.auth.userId! });
    const shown = await linkCourtStream(day.auth, day.comp.id, { courtId: day.courts.c2, targetId: api.targetId });
    await place(day, fx, 0, day.courts.c2);
    await setCourtStream(day.auth, fx, true);
    await setStatus(fx, "in_play");
    const phone = `court-route-${randomUUID()}`;
    const now = new Date();
    await postBeat(shown.qr!.code, shown.qr!.tok, CaptureBeat.parse({
      code: shown.qr!.code, slot: 0, phone, claim: "new", device: null, sid: null, at: now.toISOString(), state: "paired", cause: null,
      notReady: null, startFailed: null, stopped: null, mode: "operator", transport: null, bitrateKbps: null, delivery: "unknown",
      deliveredLagS: null, audioOk: null, battery: null, thermal: null, dataUsedMB: null, appVersion: "1.0.14-1200",
    }), deps, now);
    const [pairing] = await sql<{ id: string }[]>`select id from fixture_stream_pairings where phone = ${phone} and ended_at is null`;
    const { sessionId } = await startBroadcast(
      { userId: day.auth.userId!, orgId: day.orgId, source: "phone", pairingId: pairing!.id }, fx,
      { targetId: api.targetId, startCause: "operator", phone: "present", mode: "passthrough", courtLinkId: shown.id }, deps,
    );
    const open = async () => (await sql<{ state: string; end_reason: string | null }[]>`
      select state, end_reason from fixture_stream_sessions where id = ${sessionId}`)[0]!;
    expect(["requested", "provisioning", "warming", "live"], "premise: the court session is open").toContain((await open()).state);

    authState.userId = day.auth.userId!;
    const res = await courtStreamRoute(
      new Request(`https://test.local/api/v1/fixtures/${fx}/court-stream`, {
        method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ on: false }),
      }),
      { params: Promise.resolve({ id: fx }) },
    );
    expect(res.status).toBe(200);
    expect(((await res.json()) as { data: unknown }).data).toEqual({ on: false });
    const after = await open();
    expect(["ending", "completed"]).toContain(after.state);
    expect(after.end_reason).toBe("stopped");
  });
});
