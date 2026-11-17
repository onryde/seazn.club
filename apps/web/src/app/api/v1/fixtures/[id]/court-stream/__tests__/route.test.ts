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

// Fix round 1 (finding 4): the organiser's Stop fails the next `stopFailures.n` calls (a database blip), then is the real one.
const stopFailures = vi.hoisted(() => ({ n: 0, calls: 0 }));
vi.mock("@/server/usecases/stream-sessions/stop", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/server/usecases/stream-sessions/stop")>();
  return {
    ...actual,
    stopSession: ((...a: Parameters<typeof actual.stopSession>) => {
      stopFailures.calls += 1;
      if (stopFailures.n > 0) { stopFailures.n -= 1; return Promise.reject(new Error("stop failed (test)")); }
      return actual.stopSession(...a);
    }) as typeof actual.stopSession,
  };
});

// Fix round 2 (item 1): B1's court YouTube end, counted per session instead of run — "scheduled exactly once per real stop".
const courtEnds = vi.hoisted(() => ({ sids: [] as string[] }));
vi.mock("@/server/usecases/stream-sessions/court-end", () => ({
  endCourtBroadcastSoon: (sid: string) => { courtEnds.sids.push(sid); },
}));

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
const ENV = ["RELAY_KEK", "YOUTUBE_TOKEN_KEK", "COURT_MIN_APP_VERSION", "RELAY_IMAGE"] as const;
const savedEnv = Object.fromEntries(ENV.map((k) => [k, process.env[k]]));
beforeAll(() => {
  process.env.RELAY_KEK = randomBytes(32).toString("hex");
  process.env.YOUTUBE_TOKEN_KEK = randomBytes(32).toString("hex");
  process.env.COURT_MIN_APP_VERSION = "1.0.14-1200";
  process.env.RELAY_IMAGE = "registry.fly.io/seazn-relay:court-route-test";   // a composed start is refused without one
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

/** A court-streamed match in play on Court 2, its court session open (the court phone's start), as the desk sees it. */
async function courtSessionOpen(mode: "passthrough" | "composed" = "passthrough") {
  const ingest = new FakeIngest({ connectAfterMs: 0 });
  ingest.storage = { totalStorageMinutes: 0, totalStorageMinutesLimit: 100_000_000, videoCount: 0 };   // roomy: each test leaves a session reserving minutes
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
    { targetId: api.targetId, startCause: "operator", phone: "present", mode, courtLinkId: shown.id }, deps,
  );
  const session = async () => (await sql<{ state: string; end_reason: string | null }[]>`
    select state, end_reason from fixture_stream_sessions where id = ${sessionId}`)[0]!;
  expect(["requested", "provisioning", "warming", "live"], "premise: the court session is open").toContain((await session()).state);
  const switchOn = async () => (await sql<{ on: boolean }[]>`select court_stream as on from fixture_stream_settings where fixture_id = ${fx}`)[0]!.on;
  const off = async () => {
    authState.userId = day.auth.userId!;
    return courtStreamRoute(
      new Request(`https://test.local/api/v1/fixtures/${fx}/court-stream`, {
        method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ on: false }),
      }),
      { params: Promise.resolve({ id: fx }) },
    );
  };
  const stopTaps = async () => (await sql<{ n: number }[]>`
    select count(*)::int as n from fixture_stream_events where session_id = ${sessionId} and kind = 'action' and type = 'stop'`)[0]!.n;
  return { session, switchOn, off, runner, sessionId, stopTaps };
}

/** The provider's stop fails the next `n` calls (a Fly blip), after the stop's decision has committed. */
function failProviderStop(runner: FakeRunner, n: number) {
  const real = runner.stop.bind(runner);
  let left = n;
  const calls = { n: 0 };
  runner.stop = async (id, opts) => {
    calls.n += 1;
    if (left > 0) { left -= 1; throw new Error("provider stop failed (test)"); }
    return real(id, opts);
  };
  return calls;
}

describe.skipIf(!HAS_DB)("PUT …/court-stream over HTTP (O17)", () => {
  it("{on: false} on a match whose court session is open → 200 {on: false}, and the session is stopped as the organiser's Stop", async () => {
    stopFailures.n = 0;
    const c = await courtSessionOpen();
    const res = await c.off();
    expect(res.status).toBe(200);
    expect(((await res.json()) as { data: unknown }).data).toEqual({ on: false });
    const after = await c.session();
    expect(["ending", "completed"]).toContain(after.state);
    expect(after.end_reason).toBe("stopped");
  });

  it("fix round 1: a stop that fails once is tried again — 200, and the session is stopped", async () => {
    const c = await courtSessionOpen();
    stopFailures.n = 1;
    stopFailures.calls = 0;
    const res = await c.off();
    expect(res.status).toBe(200);
    expect(stopFailures.calls, "one failed stop and one retry").toBe(2);
    expect((await c.session()).end_reason).toBe("stopped");
  });

  it("fix round 1: a stop that fails twice answers an error (never a quiet 200 with the video on); a second OFF stops it", async () => {
    const c = await courtSessionOpen();
    stopFailures.n = 2;
    const res = await c.off();
    expect(res.status).toBe(500);
    expect(await c.switchOn(), "the switch has committed off").toBe(false);
    expect((await c.session()).end_reason, "the video is still on").toBeNull();
    stopFailures.n = 0;
    expect((await c.off()).status).toBe(200);
    expect((await c.session()).end_reason).toBe("stopped");
  });

  it("fix round 2: the provider stop throws AFTER the stop committed (`ending`) → the retry performs the provider stop once, the court end is scheduled once, one tap is recorded", async () => {
    stopFailures.n = 0;
    const c = await courtSessionOpen("composed");
    const calls = failProviderStop(c.runner, 1);
    courtEnds.sids = [];
    const res = await c.off();
    expect(res.status).toBe(200);
    expect(calls.n, "the failed provider stop, then the retry's").toBe(2);
    expect(c.runner.stops.length, "the provider stop happened, once").toBe(1);
    expect(courtEnds.sids, "the court's YouTube end, scheduled once").toEqual([c.sessionId]);
    expect(await c.stopTaps(), "one organiser action row, not one per retry").toBe(1);
    expect((await c.session()).end_reason).toBe("stopped");
    // A second OFF on the session now draining after a stop that landed owes nothing: no provider call, no second schedule.
    expect((await c.off()).status).toBe(200);
    expect(c.runner.stops.length).toBe(1);
    expect(courtEnds.sids).toEqual([c.sessionId]);
    expect(await c.stopTaps()).toBe(1);
  });

  it("fix round 2: the provider stop throws on both tries → 500 with the session `ending`; a second OFF finds it and performs the stop, scheduling the court end once", async () => {
    stopFailures.n = 0;
    const c = await courtSessionOpen("composed");
    const calls = failProviderStop(c.runner, 2);
    courtEnds.sids = [];
    expect((await c.off()).status).toBe(500);
    expect(calls.n).toBe(2);
    expect(c.runner.stops.length, "the video is not stopped yet").toBe(0);
    expect((await c.session()).state).toBe("ending");
    expect(courtEnds.sids).toEqual([]);
    expect((await c.off()).status).toBe(200);
    expect(c.runner.stops.length, "the second OFF performed the provider stop").toBe(1);
    expect(courtEnds.sids).toEqual([c.sessionId]);
    expect(await c.stopTaps()).toBe(1);
  });

  it("fix round 2: an `ending` composed session whose Machine already exited owes no stop — a second OFF calls no provider and schedules nothing", async () => {
    stopFailures.n = 0;
    const c = await courtSessionOpen("composed");
    failProviderStop(c.runner, 2);
    courtEnds.sids = [];
    expect((await c.off()).status).toBe(500);
    // The Machine's exit was observed meanwhile (the table moved the runner on): nothing is left for a stop to ask of it.
    await sql`update fixture_stream_sessions set runner_state = 'exited' where id = ${c.sessionId}`;
    expect((await c.off()).status).toBe(200);
    expect(c.runner.stops.length, "no provider stop for an exited Machine").toBe(0);
    expect(courtEnds.sids, "and no court end scheduled by the OFF").toEqual([]);
  });

  it("fix round 2: a passthrough stop that lands schedules the court end once (stopSession's own schedule, not a second)", async () => {
    stopFailures.n = 0;
    const c = await courtSessionOpen();
    courtEnds.sids = [];
    expect((await c.off()).status).toBe(200);
    expect(courtEnds.sids).toEqual([c.sessionId]);
    expect((await c.off()).status).toBe(200);
    expect(courtEnds.sids, "a second OFF on a stopped session schedules nothing").toEqual([c.sessionId]);
  });
});
