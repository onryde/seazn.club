// YouTube Connect T15 (spec §9.2, plan T15 with its post-T3 amendment; controller overrides O2/O3/O4; T14's forward note): the
// stream-tick route driven for REAL — the route's own `defaultDeps` (the process's relay drivers and YouTube driver, installed by
// the registries' test seams), the real end step against a FakeYouTube, the real session pass against FakeIngest/FakeRunner, and a
// real Postgres. route.test.ts is the mocked half (order, budget arithmetic, the catch); this file proves the seams are wired:
// a step mocked on both ends proves the mock.
//
// What is real, and what is steered:
//   - Go live is the organiser's `createSession` (so prepare, the pool, the session insert and the attach are the real ones), Stop is
//     `stopSession`, and the video arrives through the fake's `videoOn`.
//   - TIME. The route reads the real clock (`defaultDeps().now`), so a due broadcast has to be due on it. The one thing no producer
//     can do is wait ten minutes: the rows' timestamps are shifted back by SQL (`ago`), and every shifted shape is a producer's output
//     moved in time, never a hand-built row. The 5-minute grace and the 10-minute warming timeout are the spec's literals, typed here.
//   - The YouTube step is UNFILTERED — the route passes no `orgIds` (T14 forward note), so this file's pass also sees every other
//     suite's rows in the shared database — and this file's OWN earlier rows (a previous run's leftovers fall due on the real clock
//     minutes later). Other suites' rows are untouched unless due on the REAL clock (they script their own instants forward, so
//     theirs are not). So this file asserts only on its own rows, on lower bounds of the answer, and on what YouTube was asked about
//     ITS OWN broadcast ids (`asked`) — never on a total call count, which a foreign row processed by the same pass would move.
//   - The SESSION pass is scoped to this file's org by a wrapper on `tickOpenSessions` (its test-only `orgIds`): an unscoped pass would
//     tick every other suite's open sessions with THIS file's fakes. The wrapper refuses when no scope is set, so it can never go
//     unscoped by accident; the options the ROUTE passed are recorded before the scope is added, and are asserted.
//
// Expected values are the spec's and Google's literals, typed here and never imported from the code under test: grace 5 minutes after
// Stop (D4), the warming timeout 10 minutes, the YouTube slice 15 s of the tick's 45 s.
// Sport: not applicable — streaming is sport-agnostic (global-constraints "Test rules"); every rig rides `generic`.
// Secrets: a key / token is never printed; rows are compared by id.
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { randomBytes, randomUUID } from "node:crypto";

const sentry = vi.hoisted(() => ({ captureError: vi.fn() }));
vi.mock("@/lib/sentry", () => ({ captureError: sentry.captureError }));

const hdrs = vi.hoisted(() => ({ store: new Headers() }));
vi.mock("next/headers", () => ({ headers: async () => hdrs.store }));

/** The session pass, wrapped: records what the ROUTE passed, then scopes the real pass to this file's org. */
const pass = vi.hoisted(() => ({ orgIds: null as string[] | null, routeOpts: [] as unknown[] }));
vi.mock("@/server/usecases/stream-sessions", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/server/usecases/stream-sessions")>();
  return {
    ...real,
    tickOpenSessions: vi.fn(async (deps: Parameters<typeof real.tickOpenSessions>[0], opts?: Parameters<typeof real.tickOpenSessions>[1]) => {
      pass.routeOpts.push(opts);
      if (!pass.orgIds) throw new Error("test: no org scope set for the session pass — an unscoped pass would tick every other suite's open sessions");
      return real.tickOpenSessions(deps, { ...opts, orgIds: pass.orgIds });
    }),
  };
});

import { sql } from "@/lib/db";
import { invalidateOrgEntitlements } from "@/lib/entitlements";
import type { AuthCtx } from "@/server/api-v1/auth";
import { disabledRelayDrivers, setRelayDriversForTest } from "@/server/relay/drivers";
import { FakeIngest, FakeRunner } from "@/server/relay/fakes";
import { pairPresentPhone, rigUser, spendMonthlyStreamGrant } from "@/server/relay/__tests__/_session-rig";
import { divisionRig, seedOrg } from "@/server/usecases/__tests__/_rig";
import { grantCredits } from "@/server/usecases/stream-credits";
import { createSession, currentSession, stopSession, type SessionDeps } from "@/server/usecases/stream-sessions";
import { setYoutubeDriverForTest } from "@/server/youtube/driver";
import { FakeYouTube } from "@/server/youtube/fake";
import { connect as connectChannel } from "@/server/youtube/__tests__/_connect-rig";

import { POST } from "./route";

const HAS_DB = !!process.env.DATABASE_URL;
/** A storage pool no plausible number of foreign reservations can exhaust. */
const ROOMY_STORAGE_MINUTES = 100_000_000;
/** A Cloudflare input that never connects within this test: a session that goes nowhere. */
const NEVER_MS = 3_600_000;
const SECRET = "s3cret-t15";

// ---- KEKs and the composed image (the end-step suite's precedent: CI supplies none of them) ---------------------------------
const ENV = ["RELAY_KEK", "YOUTUBE_TOKEN_KEK", "RELAY_IMAGE"] as const;
const savedEnv = Object.fromEntries(ENV.map((k) => [k, process.env[k]]));
beforeAll(() => {
  process.env.RELAY_KEK = randomBytes(32).toString("hex");
  process.env.YOUTUBE_TOKEN_KEK = randomBytes(32).toString("hex");
  process.env.RELAY_IMAGE = "registry.fly.io/seazn-relay:t15-test";
});
afterAll(() => {
  for (const k of ENV) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
});
beforeEach(() => {
  sentry.captureError.mockClear();
  pass.orgIds = null;
  pass.routeOpts = [];
  vi.stubEnv("CRON_SECRET", SECRET);
  vi.stubEnv("OAUTH_BASE_URL", "");
  vi.stubEnv("NEXT_PUBLIC_BASE_URL", "");
  hdrs.store = new Headers({ "x-cron-secret": SECRET });
});
/** The orgs this file made. A FakeYouTube mints SEQUENTIAL ids (`fakebc00001`), so a broadcast row this file leaves open — one that
 *  falls due minutes later, on a later run, or after a failing case — would be picked up by a later UNFILTERED pass and read as
 *  the SAME id in that pass's own fake. Closing a test's rows when it ends keeps the file deterministic across runs. */
const made: string[] = [];
afterEach(async () => {
  vi.unstubAllEnvs();
  hdrs.store = new Headers();
  setRelayDriversForTest(null);
  setYoutubeDriverForTest(null);
  if (made.length > 0) {
    await sql`update youtube_broadcasts set state = 'failed', last_error_code = 'test_cleanup'
               where org_id in ${sql(made)} and state in ('created', 'bound', 'reserved', 'live', 'ending')`;
    made.length = 0;
  }
});

// ---- the world ----------------------------------------------------------------------------------------------------------
/** A FakeYouTube that records which broadcast ids it was asked to end or delete (the fake's own `calls` carry no ids). */
interface Tracked { fake: FakeYouTube; asked: { complete: string[]; deleteBroadcast: string[] } }
function tracked(): Tracked {
  const fake = new FakeYouTube();
  const asked: Tracked["asked"] = { complete: [], deleteBroadcast: [] };
  const complete = fake.complete.bind(fake);
  fake.complete = async (at, id) => { asked.complete.push(id); return complete(at, id); };
  const deleteBroadcast = fake.deleteBroadcast.bind(fake);
  fake.deleteBroadcast = async (at, id) => { asked.deleteBroadcast.push(id); return deleteBroadcast(at, id); };
  return { fake, asked };
}
/** How many times YouTube was asked `method` about THIS broadcast. */
const askedAbout = (t: Tracked, method: keyof Tracked["asked"], ytId: string): number => t.asked[method].filter((id) => id === ytId).length;

interface World {
  auth: AuthCtx; orgId: string; fixtureId: string; targetId: string;
  yt: Tracked; fake: FakeYouTube; ingest: FakeIngest; runner: FakeRunner; deps: SessionDeps;
}

async function override(orgId: string, key: string, value: boolean) {
  await sql`insert into org_entitlement_overrides (org_id, feature_key, bool_value, reason)
            values (${orgId}, ${key}, ${value}, 't15 unit')
            on conflict (org_id, feature_key) do update set bool_value = ${value}`;
  await invalidateOrgEntitlements(orgId);
}

/** An org with the relay, one fixture with a present phone, a match credit, and a channel connected through the real save. `fake` is the
 *  YouTube it talks to (`yt`): two worlds may share ONE (the process has one driver, as production has one Google). Every clock is the real one. */
async function world(o: { yt?: Tracked; connectAfterMs?: number } = {}): Promise<World> {
  const seeded = await seedOrg();
  const auth = { ...seeded.auth, userId: await rigUser() };
  made.push(auth.orgId);
  const d = await divisionRig(auth, { entrants: 2 });
  if (d.fixtureIds.length < 1) throw new Error("rig made no fixture");
  await override(auth.orgId, "streaming.overlay", true);
  await override(auth.orgId, "streaming.relay", true);
  const fixtureId = d.fixtureIds[0]!;
  await pairPresentPhone(fixtureId);
  await grantCredits({ orgId: auth.orgId, delta: 1, createdBy: await rigUser(), note: "t15", idempotencyKey: randomUUID() });
  await spendMonthlyStreamGrant(auth.orgId);
  const c = await connectChannel({ auth, orgId: auth.orgId, userId: auth.userId });
  const ingest = new FakeIngest({ clock: () => Date.now(), connectAfterMs: o.connectAfterMs ?? 0 });
  ingest.storage = { totalStorageMinutes: 0, totalStorageMinutesLimit: ROOMY_STORAGE_MINUTES, videoCount: 0 };
  const runner = new FakeRunner();
  const yt = o.yt ?? tracked();
  const fake = yt.fake;
  const deps: SessionDeps = { drivers: { ingest, runner }, now: () => new Date(), appUrl: "http://app.test", youtube: fake };
  return { auth, orgId: auth.orgId, fixtureId, targetId: c.targetId, yt, fake, ingest, runner, deps };
}

/** Install the world's fakes as the PROCESS's drivers, so the route's own `defaultDeps` resolves to them. */
function install(w: World, relay: "world" | "disabled" = "world"): void {
  setRelayDriversForTest(relay === "disabled" ? disabledRelayDrivers() : { ingest: w.ingest, runner: w.runner });
  setYoutubeDriverForTest(w.fake);
}

const goLive = async (w: World) => {
  await pairPresentPhone(w.fixtureId, { at: w.deps.now() });
  return createSession(w.auth, w.fixtureId, { mode: "passthrough", targetId: w.targetId }, w.deps);
};

interface SessionRow { id: string; state: string; youtube_broadcast_id: string | null; ended_at: Date | null; fail_reason: string | null }
const sessionRow = async (id: string): Promise<SessionRow> =>
  (await sql<SessionRow[]>`select id, state, youtube_broadcast_id, ended_at, fail_reason from fixture_stream_sessions where id = ${id}`)[0]!;
interface BRow { id: string; state: string; yt_broadcast_id: string | null; last_error_code: string | null; completed_at: Date | null }
const broadcastRow = async (id: string): Promise<BRow> =>
  (await sql<BRow[]>`select id, state, yt_broadcast_id, last_error_code, completed_at from youtube_broadcasts where id = ${id}`)[0]!;
const streamUrlOf = async (fixtureId: string) =>
  (await sql<{ stream_url: string | null }[]>`select stream_url from fixtures where id = ${fixtureId}`)[0]!.stream_url;

/** Go live → live → video arrives → Stop (all on the real clock). The broadcast is `live` at YouTube, its session over, and the
 *  grace is just starting: NOT yet due. */
async function playAndStop(w: World): Promise<{ sessionId: string; broadcastId: string; ytId: string }> {
  const { sessionId } = await goLive(w);
  expect((await currentSession(w.auth, w.fixtureId, w.deps))!.state, "premise: the session went live").toBe("live");
  const s = await sessionRow(sessionId);
  const b = await broadcastRow(s.youtube_broadcast_id!);
  const stream = w.fake.inspectBroadcast(b.yt_broadcast_id!)?.streamId;
  if (!stream) throw new Error("premise: the broadcast is bound to a stream");
  w.fake.videoOn(stream);
  await stopSession(w.auth, w.fixtureId, sessionId, w.deps);
  w.fake.videoOff(stream);
  const done = await sessionRow(sessionId);
  expect(done.state, "premise: the Stop carried the session to its end").toBe("completed");
  expect(done.ended_at, "premise: the Stop wrote ended_at").toBeInstanceOf(Date);
  expect((await broadcastRow(b.id)).state, "premise: inside the grace the broadcast is still live").toBe("live");
  return { sessionId, broadcastId: b.id, ytId: b.yt_broadcast_id! };
}

/** Time travel: a session's recorded instants moved `minutes` into the past, so the real clock is `minutes` further on. */
async function ago(sessionId: string, minutes: number, columns: ("ended_at" | "created_at" | "warming_at")[]): Promise<void> {
  for (const col of columns) {
    if (col === "ended_at") await sql`update fixture_stream_sessions set ended_at = ended_at - make_interval(mins => ${minutes}::int) where id = ${sessionId}`;
    else if (col === "created_at") await sql`update fixture_stream_sessions set created_at = created_at - make_interval(mins => ${minutes}::int) where id = ${sessionId}`;
    else await sql`update fixture_stream_sessions set warming_at = warming_at - make_interval(mins => ${minutes}::int) where id = ${sessionId}`;
  }
}

interface Counters { ended: number; neverLive: number; orphans: number; failed: number; deferred: number }
interface Answer {
  ok: boolean;
  data: { disabled?: true; ticked: number; ended: number; failed: number; deferred: number; youtube: Counters };
}
const call = async () => {
  const res = await POST(new Request("http://internal:3000/api/cron/stream-tick", { method: "POST", headers: { "x-forwarded-host": "app.example" } }));
  return { status: res.status, body: (await res.json()) as Answer };
};

describe.skipIf(!HAS_DB)("YouTube Connect T15 — POST /api/cron/stream-tick, driven for real", () => {
  it("the UNFILTERED end step: ONE firing ends the due broadcasts of TWO orgs (no org filter reached the step), once each; a second firing asks YouTube nothing more of them", async () => {
    const shared = tracked();
    const a = await world({ yt: shared });
    const b = await world({ yt: shared });
    const ma = await playAndStop(a);
    const mb = await playAndStop(b);
    // Grace is 5 minutes after Stop (D4): ten minutes on, both are overdue on the real clock.
    await ago(ma.sessionId, 10, ["ended_at"]);
    await ago(mb.sessionId, 10, ["ended_at"]);
    install(a);
    pass.orgIds = [a.orgId];

    const first = await call();
    expect(first.status).toBe(200);
    // The answer counts the WHOLE database's due rows (the step is unfiltered), so these are lower bounds; the rows are the proof.
    expect(first.body.data.youtube.ended, "both orgs' broadcasts were ended by this firing").toBeGreaterThanOrEqual(2);
    for (const m of [ma, mb]) {
      const row = await broadcastRow(m.broadcastId);
      expect(row.state, "the broadcast row").toBe("complete");
      expect(row.completed_at).toBeInstanceOf(Date);
    }
    for (const m of [ma, mb]) expect(askedAbout(shared, "complete", m.ytId), `YouTube was asked to complete ${m.broadcastId} once`).toBe(1);
    expect(shared.fake.inspectBroadcast(ma.ytId)?.life, "and the video really ended at YouTube").toBe("complete");
    expect(shared.fake.inspectBroadcast(mb.ytId)?.life).toBe("complete");
    // The answer's shape: the session counters beside the step's five.
    expect(Object.keys(first.body.data).sort()).toEqual(["deferred", "ended", "failed", "ticked", "youtube"]);
    expect(Object.keys(first.body.data.youtube).sort()).toEqual(["deferred", "ended", "failed", "neverLive", "orphans"]);
    // The replay link, written by the step the route ran.
    expect(await streamUrlOf(a.fixtureId), "the replay link points at the ended broadcast").toBe(`https://www.youtube.com/watch?v=${ma.ytId}`);

    // The sequence: a second firing finds them finished (a `complete` row is not a candidate) — YouTube is not asked again.
    const second = await call();
    expect(second.status).toBe(200);
    for (const m of [ma, mb]) expect(askedAbout(shared, "complete", m.ytId), `${m.broadcastId} is not completed again`).toBe(1);
    expect((await broadcastRow(ma.broadcastId)).state).toBe("complete");

    // What the route handed the session pass: a budget of its own, nothing else — the org scope above is the TEST's.
    expect(pass.routeOpts.length, "the session pass ran once per firing").toBe(2);
    for (const opts of pass.routeOpts) {
      expect(Object.keys(opts as object), "the route passes a budget and nothing else").toEqual(["budgetMs"]);
      const budget = (opts as { budgetMs: number }).budgetMs;
      expect(budget, "45 s minus what the step spent").toBeLessThanOrEqual(45_000);
      expect(budget, "the step is bounded by its own 15 s slice").toBeGreaterThanOrEqual(45_000 - 15_000 - 10_000);
    }
  });

  it("EMPTY CASE: a broadcast still INSIDE the grace is left alone by the same firing (the positive pair of the case above) — and ends once the grace has passed", async () => {
    const w = await world();
    const m = await playAndStop(w);
    install(w);
    pass.orgIds = [w.orgId];

    expect((await call()).status).toBe(200);
    expect((await broadcastRow(m.broadcastId)).state, "Stop + a few seconds is inside the 5-minute grace").toBe("live");
    expect(askedAbout(w.yt, "complete", m.ytId)).toBe(0);

    await ago(m.sessionId, 6, ["ended_at"]);
    expect((await call()).status).toBe(200);
    expect((await broadcastRow(m.broadcastId)).state, "Stop + 6 minutes is past it").toBe("complete");
    expect(askedAbout(w.yt, "complete", m.ytId)).toBe(1);
  });

  it("RELAY DISABLED (spec §9.2): a due broadcast is still ended, the session pass never runs, and the answer says disabled with failed: 0 and the step's counters", async () => {
    const w = await world();
    const m = await playAndStop(w);
    await ago(m.sessionId, 10, ["ended_at"]);
    install(w, "disabled");   // the deployment lost its relay AFTER the match: the broadcast is still YouTube's to end

    const r = await call();
    expect(r.status).toBe(200);
    expect(r.body.data).toMatchObject({ disabled: true, ticked: 0, ended: 0, failed: 0, deferred: 0 });
    expect(r.body.data.youtube.ended).toBeGreaterThanOrEqual(1);
    expect((await broadcastRow(m.broadcastId)).state).toBe("complete");
    expect(askedAbout(w.yt, "complete", m.ytId)).toBe(1);
    expect(pass.routeOpts, "no session pass ran on a relay-disabled deployment").toEqual([]);
  });

  it("POST-T3 (O3): the tick EXPIRES a stuck API-backed session — the warming timeout, reached through the route — and the YouTube step, which ran first, leaves its broadcast to the NEXT firing", async () => {
    const w = await world({ connectAfterMs: NEVER_MS });
    const { sessionId } = await goLive(w);
    const stuck = await sessionRow(sessionId);
    expect(stuck.youtube_broadcast_id, "premise: an API-backed session — it names a prepared broadcast").not.toBeNull();
    expect(["warming", "provisioning", "requested"], `premise: the session is open (${stuck.state})`).toContain(stuck.state);
    // The warming timeout is 10 minutes: this one has been warming for eleven.
    await ago(sessionId, 11, ["created_at", "warming_at"]);
    install(w);
    pass.orgIds = [w.orgId];

    const first = await call();
    expect(first.status).toBe(200);
    expect(first.body.data.ticked, "the session pass reached the session").toBe(1);
    expect(first.body.data.ended, "and it ended it").toBe(1);
    expect(first.body.data.failed).toBe(0);
    const over = await sessionRow(sessionId);
    expect(over.state, "the stuck session is terminal").toBe("failed");
    expect(over.fail_reason, "with a reason").not.toBeNull();
    expect(over.ended_at).toBeInstanceOf(Date);
    // Order: the step ran BEFORE the pass, so the broadcast was still held by an active session when it looked: nothing was asked of YouTube.
    const b = await broadcastRow(stuck.youtube_broadcast_id!);
    expect(b.state, "the broadcast was not ended in the same firing").toBe("live");
    expect(askedAbout(w.yt, "complete", b.yt_broadcast_id!) + askedAbout(w.yt, "deleteBroadcast", b.yt_broadcast_id!), "YouTube was asked nothing about it").toBe(0);

    // The next firing (past the grace) settles it: no video ever reached it, so it is deleted, not completed.
    await ago(sessionId, 10, ["ended_at"]);
    const second = await call();
    expect(second.status).toBe(200);
    expect(second.body.data.youtube.neverLive, "ended as a broadcast that never went live").toBeGreaterThanOrEqual(1);
    expect(await broadcastRow(b.id)).toMatchObject({ state: "failed", last_error_code: "never_live" });
    expect(askedAbout(w.yt, "complete", b.yt_broadcast_id!), "never completed").toBe(0);
    expect(askedAbout(w.yt, "deleteBroadcast", b.yt_broadcast_id!), "deleted once").toBe(1);
  });

  it("a YouTube step that THROWS (a misspelt YOUTUBE_DRIVER) answers youtube.failed 1 — and the session pass still expires the stuck session", async () => {
    const w = await world({ connectAfterMs: NEVER_MS });
    const { sessionId } = await goLive(w);
    await ago(sessionId, 11, ["created_at", "warming_at"]);
    setRelayDriversForTest({ ingest: w.ingest, runner: w.runner });
    setYoutubeDriverForTest(null);          // the process's own driver, read from the environment …
    vi.stubEnv("YOUTUBE_DRIVER", "fkae");   // … which is a typo
    pass.orgIds = [w.orgId];

    const r = await call();
    expect(r.status, "a bad YouTube setting never turns the cron into a 500").toBe(200);
    expect(r.body.data.youtube).toEqual({ ended: 0, neverLive: 0, orphans: 0, failed: 1, deferred: 0 });
    expect(r.body.data.ended, "the sessions were still ticked").toBe(1);
    expect((await sessionRow(sessionId)).state).toBe("failed");
    expect(sentry.captureError, "reported once").toHaveBeenCalledTimes(1);
    expect(sentry.captureError.mock.calls[0]![1]).toMatchObject({ route: "cron.stream_tick.youtube" });
  });
});
