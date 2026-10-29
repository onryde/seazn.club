// YouTube Connect T17 (spec §6.6 "Daily", plan T17 with controller override O5): the relay-sweep route driven for REAL - the route's own
// `defaultDeps` (the process's relay drivers and YouTube driver, installed by the registries' test seams), the real daily YouTube pass
// against a FakeYouTube, the real relay sweep against FakeIngest / FakeRunner, and a real Postgres. route.test.ts is the mocked half
// (auth order, call order, the catch); this file proves the seams are WIRED: a pass mocked on both ends proves the mock. What a mocked
// route cannot see is whether the port the process really resolves reaches the pass, whether the pass really runs when the relay is
// disabled, and whether the answer the Worker reads really carries the counter the Worker's own row names.
//
// What is real, and what is steered:
//   - Channels are connected through the real save (`connect` from the T8 rig) and made known to the fake (`seedGrant`: the connection's
//     channel id is the one the fake lists, as at connect). A rename, a deleted video and a dead grant are the FAKE's own controls
//     (`renameChannel`, `deleteVideo`, `killToken`) met by the real pass; a `complete` row is a row only SQL can age by 26 days, so
//     those two rows are built by SQL (the same row shape the end step writes) and say so.
//   - TIME. The route reads the real clock (`defaultDeps().now`); a row is "26 days stale" on it because its own `refreshed_at` is shifted
//     back by SQL - a producer's output moved in time.
//   - The pass is UNFILTERED in production (the route passes no `orgIds`: that option is the test seam), so an unscoped pass here would
//     health-check, refresh and PURGE every other suite's rows in the shared database, and flip every foreign connection (whose token this
//     file's fake does not know) to reconnect_needed. Both passes are therefore WRAPPED: the wrapper records exactly what the ROUTE passed
//     (asserted: the port and the clock, nothing else), then adds this file's org scope. The wrapper REFUSES to run with no scope set, so
//     it can never go unscoped by accident.
//
// Expected values are the spec's literals, typed here and never imported from the code under test: stale after 25 days (26 is stale, 24 is
// not), videos.list takes at most 50 ids. The Worker's reading of the answer is the REAL `failureCountsOver0` and the REAL `relay-sweep`
// row, imported from apps/cron-worker - never a copy, which would be a fixture on both ends.
// Sport: not applicable - streaming is sport-agnostic (global-constraints "Test rules"); every rig rides `generic`.
// Secrets: a token is never printed; rows are compared by id.
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { randomBytes } from "node:crypto";

const sentry = vi.hoisted(() => ({ captureError: vi.fn() }));
vi.mock("@/lib/sentry", () => ({ captureError: sentry.captureError }));

const hdrs = vi.hoisted(() => ({ store: new Headers() }));
vi.mock("next/headers", () => ({ headers: async () => hdrs.store }));

/** What the ROUTE passed each pass (recorded before the scope is added), and the scope this file adds. */
const seen = vi.hoisted(() => ({ orgIds: null as string[] | null, daily: [] as unknown[][], sweep: [] as unknown[][] }));
vi.mock("@/server/youtube/daily", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/server/youtube/daily")>();
  return {
    ...real,
    youtubeDaily: vi.fn(async (...args: Parameters<typeof real.youtubeDaily>) => {
      seen.daily.push([...args]);
      if (!seen.orgIds) throw new Error("test: no org scope set for the YouTube pass - an unscoped pass would health-check, refresh and purge every other suite's rows");
      return real.youtubeDaily(args[0], args[1], { ...args[2], orgIds: seen.orgIds });
    }),
  };
});
vi.mock("@/server/usecases/relay-sweep", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/server/usecases/relay-sweep")>();
  return {
    ...real,
    sweepStreamSessions: vi.fn(async (...args: Parameters<typeof real.sweepStreamSessions>) => {
      seen.sweep.push([...args]);
      if (!seen.orgIds) throw new Error("test: no org scope set for the relay sweep - an unscoped sweep would judge every other suite's sessions");
      return real.sweepStreamSessions(args[0], { ...args[1], orgIds: seen.orgIds });
    }),
  };
});

import { sql } from "@/lib/db";
import { disabledRelayDrivers, setRelayDriversForTest } from "@/server/relay/drivers";
import { FakeIngest, FakeRunner } from "@/server/relay/fakes";
import { divisionRig, seedOrg } from "@/server/usecases/__tests__/_rig";
import { rigUser } from "@/server/relay/__tests__/_session-rig";
import { setYoutubeDriverForTest } from "@/server/youtube/driver";
import { FakeYouTube } from "@/server/youtube/fake";
import { connect as connectChannel, type Org } from "@/server/youtube/__tests__/_connect-rig";

import { POST } from "./route";

// apps/cron-worker is outside the Fly image's build context (.dockerignore); the specifiers are computed so tsc never resolves them
// (route.test.ts has the full reason). vitest still loads the REAL modules, so the seam stays real.
type Job = { id: string; path: string; failureCounts?: readonly string[] };
const cronSrc = (file: string) => new URL(`../../../../../../cron-worker/src/${file}`, import.meta.url).href;
const { failureCountsOver0 } = (await import(/* @vite-ignore */ cronSrc("call.ts"))) as {
  failureCountsOver0: (job: Job, bodyText: string | null) => Record<string, number | "unreadable">;
};
const { JOBS } = (await import(/* @vite-ignore */ cronSrc("schedule.ts"))) as { JOBS: readonly Job[] };
const ROW = JOBS.find((j: Job) => j.id === "relay-sweep")!;

const HAS_DB = !!process.env.DATABASE_URL;
const SECRET = "s3cret-t17";
const STALE_DAYS = 26;   // spec §6.6: refreshed after ~25 days, so 26 is stale ...
const FRESH_DAYS = 24;   // ... and 24 is not

// ---- KEKs (CI supplies none of them) ----------------------------------------------------------------------------------------
const ENV = ["RELAY_KEK", "YOUTUBE_TOKEN_KEK"] as const;
const savedEnv = Object.fromEntries(ENV.map((k) => [k, process.env[k]]));
beforeAll(() => {
  process.env.RELAY_KEK = randomBytes(32).toString("hex");
  process.env.YOUTUBE_TOKEN_KEK = randomBytes(32).toString("hex");
});
afterAll(() => {
  for (const k of ENV) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
});
beforeEach(() => {
  sentry.captureError.mockClear();
  seen.orgIds = null;
  seen.daily = [];
  seen.sweep = [];
  vi.stubEnv("CRON_SECRET", SECRET);
  vi.stubEnv("OAUTH_BASE_URL", "");
  vi.stubEnv("NEXT_PUBLIC_BASE_URL", "");
  hdrs.store = new Headers({ "x-cron-secret": SECRET });
});
afterEach(() => {
  vi.unstubAllEnvs();
  hdrs.store = new Headers();
  setRelayDriversForTest(null);
  setYoutubeDriverForTest(null);
});

// ---- the world ----------------------------------------------------------------------------------------------------------
interface Chan { connectionId: string; targetId: string; token: string; channelId: string; title: string }
interface World { org: Org; fixtureId: string; fake: FakeYouTube; ingest: FakeIngest; runner: FakeRunner }

/** An org with one fixture and a fake YouTube, installed as the PROCESS's drivers so the route's own `defaultDeps` resolves to them. */
async function world(relay: "world" | "disabled" = "world"): Promise<World> {
  const seeded = await seedOrg();
  const auth = { ...seeded.auth, userId: await rigUser() };
  const org: Org = { auth, orgId: auth.orgId, userId: auth.userId };
  const d = await divisionRig(auth, { entrants: 2 });
  if (d.fixtureIds.length < 1) throw new Error("rig made no fixture");
  const fake = new FakeYouTube();
  const ingest = new FakeIngest({ clock: () => Date.now(), connectAfterMs: 0 });
  const runner = new FakeRunner();
  setRelayDriversForTest(relay === "disabled" ? disabledRelayDrivers() : { ingest, runner });
  setYoutubeDriverForTest(fake);
  seen.orgIds = [org.orgId];
  return { org, fixtureId: d.fixtureIds[0]!, fake, ingest, runner };
}

/** A channel connected through the real save and KNOWN to the fake. */
async function channel(w: World): Promise<Chan> {
  const c = await connectChannel(w.org);
  w.fake.seedGrant({ refreshToken: c.token, channelId: c.channel.id, channelTitle: c.channel.title });
  return { connectionId: c.connectionId, targetId: c.targetId, token: c.token, channelId: c.channel.id, title: c.channel.title };
}

/** A `complete` row for a real video at the fake, refreshed `ageDays` ago: SQL only, because no producer can wait 26 days (the row is the
 *  shape the end step writes). */
async function completeRow(w: World, c: Chan, ageDays: number): Promise<{ id: string; ytId: string }> {
  const at = await w.fake.accessToken(c.token);
  const { broadcastId } = await w.fake.insertBroadcast(at, { title: "t17 part", description: "", scheduledStart: new Date(), privacy: "unlisted", madeForKids: false });
  const [row] = await sql<{ id: string }[]>`
    insert into youtube_broadcasts (org_id, connection_id, fixture_id, title, privacy, state, yt_broadcast_id, completed_at, refreshed_at)
    values (${w.org.orgId}, ${c.connectionId}, ${w.fixtureId}, 't17 part', 'unlisted', 'complete', ${broadcastId}, now(),
            now() - (${ageDays}::float8 * interval '1 day'))
    returning id`;
  return { id: row!.id, ytId: broadcastId };
}

interface ConnRow { status: string; channel_title: string | null; last_health_at: Date | null }
const connRow = async (id: string): Promise<ConnRow> =>
  (await sql<ConnRow[]>`select status, channel_title, last_health_at from org_youtube_connections where id = ${id}`)[0]!;
const labelOf = async (targetId: string): Promise<string> =>
  (await sql<{ label: string }[]>`select label from org_stream_targets where id = ${targetId}`)[0]!.label;
const rowOf = async (id: string) =>
  (await sql<{ id: string; refreshed_at: Date }[]>`select id, refreshed_at from youtube_broadcasts where id = ${id}`)[0] ?? null;
const streamUrlOf = async (fixtureId: string) =>
  (await sql<{ stream_url: string | null }[]>`select stream_url from fixtures where id = ${fixtureId}`)[0]!.stream_url;

interface Counters { checked: number; reconnectNeeded: number; refreshed: number; removed: number; keysRemoved: number; purged: number; failed: number }
interface Answer { ok: boolean; data: { disabled?: true; youtube: Counters } & Record<string, unknown> }
const call = async () => {
  const res = await POST(new Request("http://internal:3000/api/cron/relay-sweep", { method: "POST", headers: { "x-forwarded-host": "app.example" } }));
  const text = await res.text();
  return { status: res.status, text, body: JSON.parse(text) as Answer };
};

describe.skipIf(!HAS_DB)("YouTube Connect T17 - POST /api/cron/relay-sweep, driven for real", () => {
  it("EMPTY CASE FIRST: an org with no connection - the route answers 200, the pass asked YouTube nothing, every counter is 0 and the Worker reads it as healthy; the next case is the positive pair", async () => {
    const w = await world();
    const r = await call();
    expect(r.status).toBe(200);
    expect(r.body.data.youtube).toEqual({ checked: 0, reconnectNeeded: 0, refreshed: 0, removed: 0, keysRemoved: 0, purged: 0, failed: 0 });
    expect(w.fake.calls, "nothing connected, nothing asked").toEqual([]);
    expect(failureCountsOver0(ROW, r.text)).toEqual({});
  });

  it("THE SEAM: one firing renames a channel, refreshes a stale video that is still there, removes one that is gone (and clears the replay link that pointed at it), and flips a dead grant - through the route's own deps, the process's YouTube driver and the real pass", async () => {
    const w = await world();
    const renamed = await channel(w);
    const media = await channel(w);
    const dead = await channel(w);

    w.fake.renameChannel(renamed.channelId, "Riverside FC (renamed)");
    const here = await completeRow(w, media, STALE_DAYS);
    const gone = await completeRow(w, media, STALE_DAYS);
    const fresh = await completeRow(w, media, FRESH_DAYS);
    await sql`update fixtures set stream_url = ${`https://www.youtube.com/watch?v=${gone.ytId}`} where id = ${w.fixtureId}`;
    w.fake.deleteVideo(gone.ytId);
    w.fake.killToken(dead.token);
    const freshBefore = (await rowOf(fresh.id))!.refreshed_at;
    const before = Date.now();

    const r = await call();
    expect(r.status).toBe(200);
    // Scoped to this file's org, so the counters are EXACT: 3 connections checked (the dead one counts: its token was opened), one
    // dead, one refreshed (the video still there), one removed (the video gone).
    expect(r.body.data.youtube).toEqual({ checked: 3, reconnectNeeded: 1, refreshed: 1, removed: 1, keysRemoved: 0, purged: 0, failed: 0 });

    // The rename reached the connection AND its destination row.
    expect(await connRow(renamed.connectionId)).toMatchObject({ status: "connected", channel_title: "Riverside FC (renamed)" });
    expect(await labelOf(renamed.targetId), "the destination row follows the title").toBe("Riverside FC (renamed)");
    expect((await connRow(renamed.connectionId)).last_health_at, "the health check stamped the connection").toBeInstanceOf(Date);
    // The refresh: the present video's clock moved to the pass's now; the gone one's row is deleted and the link that pointed at it cleared.
    expect((await rowOf(here.id))!.refreshed_at.getTime(), "the stale video that is still there was confirmed now").toBeGreaterThanOrEqual(before - 1000);
    expect(await rowOf(gone.id), "the video YouTube no longer has").toBeNull();
    expect(await streamUrlOf(w.fixtureId), "the replay link that pointed at it is cleared").toBeNull();
    // The sequence's negative pair: a row inside the 25 days is not asked about, so its clock is untouched.
    expect((await rowOf(fresh.id))!.refreshed_at.getTime()).toBe(freshBefore.getTime());
    // The dead grant.
    expect((await connRow(dead.connectionId)).status).toBe("reconnect_needed");
    expect((await connRow(media.connectionId)).status, "an untouched channel stays connected").toBe("connected");

    // What the ROUTE handed the pass: the process's YouTube driver and the deps' clock - and nothing else (the org scope is the TEST's).
    expect(seen.daily, "the pass ran once").toHaveLength(1);
    const args = seen.daily[0]!;
    expect(args, "no test seam reaches the production call").toHaveLength(2);
    expect(args[0], "the port is the process's driver").toBe(w.fake);
    expect(args[1]).toBeInstanceOf(Date);
    expect(Math.abs((args[1] as Date).getTime() - Date.now()), "the deps' clock is the real one").toBeLessThan(60_000);
    // The relay sweep ran too, with the deps alone, and the answer carries both.
    expect(seen.sweep, "the sweep ran once").toHaveLength(1);
    expect(seen.sweep[0], "exactly one argument: no options").toHaveLength(1);
    expect(r.body.data.disabled, "an enabled relay is not 'disabled'").toBeUndefined();
    expect(Object.keys(r.body.data).filter((k) => k !== "youtube").length, "the sweep's own summary rides beside `youtube`").toBeGreaterThan(0);
    // The Worker reads it as healthy: a dead grant is the pass working, and a removed video is not a failure either.
    expect(failureCountsOver0(ROW, r.text)).toEqual({});
  });

  it("a pass that FAILS something (YouTube cannot answer the refresh batch) is read by the Worker as degraded on `data.youtube.failed` - through the real answer - and the stale row is kept for tomorrow; the day after, the same row refreshes", async () => {
    const w = await world();
    const c = await channel(w);
    const stale = await completeRow(w, c, STALE_DAYS);
    w.fake.failNext("existingVideos", "youtube_unavailable");

    const bad = await call();
    expect(bad.status).toBe(200);
    expect(bad.body.data.youtube).toMatchObject({ checked: 1, refreshed: 0, removed: 0, failed: 1 });
    expect(await rowOf(stale.id), "a batch YouTube could not answer keeps its rows").not.toBeNull();
    expect(failureCountsOver0(ROW, bad.text)).toEqual({ "data.youtube.failed": 1 });

    const good = await call();   // the sequence: the second firing is the retry
    expect(good.body.data.youtube).toMatchObject({ checked: 1, refreshed: 1, failed: 0 });
    expect(failureCountsOver0(ROW, good.text)).toEqual({});
  });

  it("RELAY DISABLED: the pass STILL runs (DP III.E.4 does not wait for a relay), the sweep never does, and the disabled answer carries the counters so the Worker reads it as healthy - not 'unreadable'", async () => {
    const w = await world("disabled");
    const c = await channel(w);
    w.fake.renameChannel(c.channelId, "Renamed on a relay-less deployment");

    const r = await call();
    expect(r.status).toBe(200);
    expect(r.body.data.disabled).toBe(true);
    expect(r.body.data.youtube).toMatchObject({ checked: 1, failed: 0 });
    expect(Object.keys(r.body.data).sort(), "the disabled answer is exactly `disabled` and `youtube`").toEqual(["disabled", "youtube"]);
    expect((await connRow(c.connectionId)).channel_title, "the health check ran").toBe("Renamed on a relay-less deployment");
    expect(seen.daily).toHaveLength(1);
    expect(seen.sweep, "no relay sweep on a relay-disabled deployment").toEqual([]);
    expect(failureCountsOver0(ROW, r.text), "the Worker can read the disabled answer").toEqual({});
  });

  it("a pass that THROWS (the driver mode is misspelt, so the process's YouTube port cannot be built) is answered youtube.failed 1, reported once, and the relay sweep still runs", async () => {
    await world();
    setYoutubeDriverForTest(null);
    vi.stubEnv("YOUTUBE_DRIVER", "fkae");
    const r = await call();
    expect(r.status).toBe(200);
    expect(r.body.data.youtube).toEqual({ checked: 0, reconnectNeeded: 0, refreshed: 0, removed: 0, keysRemoved: 0, purged: 0, failed: 1 });
    expect(seen.daily, "the pass was never reached").toEqual([]);
    expect(seen.sweep, "the sweep went on").toHaveLength(1);
    expect(sentry.captureError.mock.calls.filter((c) => (c[1] as { route?: string } | undefined)?.route === "cron.relay_sweep.youtube")).toHaveLength(1);
    expect(r.text, "the answer carries counters, never the error text").not.toContain("fkae");
    expect(failureCountsOver0(ROW, r.text)).toEqual({ "data.youtube.failed": 1 });
  });

  it("an unauthorised call touches nothing: 401 on a wrong secret, and the pass and the sweep never run (the auth sits before both)", async () => {
    await world();
    hdrs.store = new Headers({ "x-cron-secret": "wrong" });
    expect((await call()).status).toBe(401);
    expect(seen.daily).toEqual([]);
    expect(seen.sweep).toEqual([]);
  });
});
