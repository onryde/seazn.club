// The organiser's match page links the match's video on YouTube (owner, 2026-10-30): the session view the stream panel polls
// (`currentSession`, the `current` route's whole answer) carries `youtubeVideoUrl` - the watch URL of the YouTube broadcast the LATEST
// session streams into, once YouTube has given it its id, while that broadcast has not failed.
//
// Read through the REAL loader, with the REAL producers wherever one makes the shape on demand (class 1: a seam is proven through
// its real producer and consumer): Go live on a connected channel (the real prepare against a FakeYouTube), the real Stop, the real
// end step, the real restart inside the grace (which REUSES the broadcast), the real disconnect (which purges the broadcast rows), and
// a pasted key saved through the real `createStreamTarget`. SQL builds only the shapes no producer makes on demand: a failed
// broadcast still bound to the latest session, a broadcast YouTube has not answered for yet, and another organisation's broadcast.
//
// Expected URLs are built with the house watch-URL builder (`youtubeWatchUrl`, lib/youtube.ts - the one the replay parts use) from
// the broadcast id the BROADCAST ROW holds, never read back out of the view.
//
// Sport: not applicable - streaming is sport-agnostic (global-constraints "Test rules"); every rig rides `generic`.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomBytes, randomUUID } from "node:crypto";
import { sql } from "@/lib/db";
import { invalidateOrgEntitlements } from "@/lib/entitlements";
import { youtubeWatchUrl } from "@/lib/youtube";
import { FakeIngest, FakeRunner } from "@/server/relay/fakes";
import { pairPresentPhone, rigUser, spendMonthlyStreamGrant } from "@/server/relay/__tests__/_session-rig";
import { divisionRig, seedOrg } from "@/server/usecases/__tests__/_rig";
import { grantCredits } from "@/server/usecases/stream-credits";
import { createSession as organiserStart, currentSession, stopSession, type SessionDeps } from "@/server/usecases/stream-sessions";
import { createStreamTarget } from "@/server/usecases/stream-targets";
import { disconnectYoutube } from "../disconnect";
import { endDueBroadcasts } from "../end-step";
import { FakeYouTube } from "../fake";
import { connect } from "./_connect-rig";

const HAS_DB = !!process.env.DATABASE_URL;

const MIN = 60_000;
const SEC = 1000;
const ENV = ["RELAY_KEK", "YOUTUBE_TOKEN_KEK", "RELAY_IMAGE"] as const;
const savedEnv = Object.fromEntries(ENV.map((k) => [k, process.env[k]]));
beforeAll(() => {
  process.env.RELAY_KEK = randomBytes(32).toString("hex");
  process.env.YOUTUBE_TOKEN_KEK = randomBytes(32).toString("hex");
  process.env.RELAY_IMAGE = "registry.fly.io/seazn-relay:yt-link-test";
});
afterAll(() => {
  for (const k of ENV) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
});

/** An org with a connected channel, one started fixture, a phone paired and credits, on a scripted clock. `goLive` is the organiser's
 *  real Go live on the channel (or on `targetId`, a pasted key), answering the session id; `broadcastOf` reads the row a session names. */
async function rig() {
  const seeded = await seedOrg();
  const auth = { ...seeded.auth, userId: await rigUser() };
  const d = await divisionRig(auth, { entrants: 2 });
  const f = d.fixtureIds[0]!;
  for (const key of ["streaming.overlay", "streaming.relay"]) {
    await sql`insert into org_entitlement_overrides (org_id, feature_key, bool_value, reason) values (${auth.orgId}, ${key}, true, 'yt link unit')
              on conflict (org_id, feature_key) do update set bool_value = true`;
  }
  await invalidateOrgEntitlements(auth.orgId);
  await grantCredits({ orgId: auth.orgId, delta: 3, createdBy: await rigUser(), note: "yt link", idempotencyKey: randomUUID() });
  await spendMonthlyStreamGrant(auth.orgId);
  const c = await connect({ auth, orgId: auth.orgId, userId: auth.userId });

  let now = Date.now();
  const ingest = new FakeIngest({ clock: () => now, connectAfterMs: 3000 });
  ingest.storage = { totalStorageMinutes: 0, totalStorageMinutesLimit: 100_000_000, videoCount: 0 };
  const fake = new FakeYouTube({ now: () => new Date(now) });
  const deps: SessionDeps = { drivers: { ingest, runner: new FakeRunner() }, now: () => new Date(now), appUrl: "http://app.test", youtube: fake };

  const goLive = async (targetId: string = c.targetId): Promise<string> => {
    await pairPresentPhone(f, { at: deps.now() });
    const { sessionId } = await organiserStart(auth, f, { mode: "passthrough", targetId }, deps);
    return sessionId;
  };
  const broadcastOf = async (sessionId: string): Promise<{ id: string; ytId: string } | null> => {
    const [s] = await sql<{ youtube_broadcast_id: string | null }[]>`select youtube_broadcast_id from fixture_stream_sessions where id = ${sessionId}`;
    if (!s?.youtube_broadcast_id) return null;
    const [b] = await sql<{ yt_broadcast_id: string }[]>`select yt_broadcast_id from youtube_broadcasts where id = ${s.youtube_broadcast_id}`;
    return { id: s.youtube_broadcast_id, ytId: b!.yt_broadcast_id };
  };
  return {
    auth, f, fake, deps, connectionId: c.connectionId, goLive, broadcastOf,
    view: async () => (await currentSession(auth, f, deps))!,
    advance: (ms: number) => { now += ms; },
    stop: (sessionId: string) => stopSession(auth, f, sessionId, deps),
    endAll: () => endDueBroadcasts(fake, { now: () => new Date(now), budgetMs: 15_000, orgIds: [auth.orgId] }),
    disconnect: () => disconnectYoutube(auth, auth.orgId, c.connectionId, fake, { now: () => new Date(now) }),
  };
}

describe.skipIf(!HAS_DB)("the session view's link to the match's video on YouTube (youtubeVideoUrl)", () => {
  it("EMPTY CASE FIRST: a pasted key (saved through the real createStreamTarget) has no YouTube broadcast, so no link - live, and after its Stop", async () => {
    const r = await rig();
    const pasted = await createStreamTarget(r.auth, r.auth.orgId, { kind: "youtube", label: "Pasted", streamKey: `pasted-${randomUUID()}` });
    const sid = await r.goLive(pasted.id);
    r.advance(3 * SEC);
    const live = await r.view();
    expect(live.state, "premise: the pasted session went live").toBe("live");
    expect(await r.broadcastOf(sid), "premise: a pasted key names no broadcast").toBeNull();
    expect(live.youtubeVideoUrl).toBeNull();
    r.advance(MIN);
    await r.stop(sid);
    const ended = await r.view();
    expect(ended.state, "premise: stopped").toBe("completed");
    expect(ended.youtubeVideoUrl).toBeNull();
  });

  it("the real Go live on a connected channel: the view carries the broadcast's watch URL while live, the SAME URL after Stop, and still after the end step completes it", async () => {
    const r = await rig();
    const sid = await r.goLive();
    const b = await r.broadcastOf(sid);
    expect(b, "premise: the API session names its broadcast").not.toBeNull();
    const url = youtubeWatchUrl(b!.ytId);
    r.advance(3 * SEC);
    const live = await r.view();
    expect(live.state, "premise: live").toBe("live");
    expect(live.youtubeVideoUrl).toBe(url);

    r.fake.videoOn(r.fake.inspectBroadcast(b!.ytId)!.streamId!);
    r.advance(MIN);
    await r.stop(sid);
    r.fake.videoOff(r.fake.inspectBroadcast(b!.ytId)!.streamId!);
    const ended = await r.view();
    expect(ended.state, "premise: stopped").toBe("completed");
    expect(ended.youtubeVideoUrl, "a second read, after Stop: the same video").toBe(url);

    r.advance(6 * MIN);
    expect(await r.endAll(), "premise: the end step completed the broadcast").toMatchObject({ ended: 1 });
    expect((await sql<{ state: string }[]>`select state from youtube_broadcasts where id = ${b!.id}`)[0]!.state).toBe("complete");
    expect((await r.view()).youtubeVideoUrl, "a complete broadcast is still the match's video").toBe(url);
  });

  it("a SECOND session that reuses the broadcast (a restart inside the grace, the real prepare) shows the same link; one made after the grace shows its NEW broadcast's", async () => {
    const r = await rig();
    const first = await r.goLive();
    r.advance(3 * SEC);
    const b1 = (await r.broadcastOf(first))!;
    r.fake.videoOn(r.fake.inspectBroadcast(b1.ytId)!.streamId!);
    r.advance(MIN);
    await r.stop(first);
    r.advance(2 * MIN);   // inside the 5-minute grace: the restart reuses the broadcast

    const second = await r.goLive();
    expect(second, "premise: a new session").not.toBe(first);
    expect((await r.broadcastOf(second))!.id, "premise: the restart REUSED the broadcast").toBe(b1.id);
    r.advance(3 * SEC);
    const again = await r.view();
    expect(again.id, "premise: the view is the second session").toBe(second);
    expect(again.youtubeVideoUrl).toBe(youtubeWatchUrl(b1.ytId));

    // The positive pair: past the grace the restart makes a NEW broadcast, and the link follows the LATEST session to it.
    r.advance(MIN);
    await r.stop(second);
    r.fake.videoOff(r.fake.inspectBroadcast(b1.ytId)!.streamId!);
    r.advance(6 * MIN);
    const third = await r.goLive();
    const b3 = (await r.broadcastOf(third))!;
    expect(b3.id, "premise: a new broadcast after the grace").not.toBe(b1.id);
    expect((await r.view()).youtubeVideoUrl).toBe(youtubeWatchUrl(b3.ytId));
    expect(youtubeWatchUrl(b3.ytId), "premise: the two links differ").not.toBe(youtubeWatchUrl(b1.ytId));
  });

  it("a FAILED broadcast has no link, and neither has one YouTube has not given an id yet; the same row answers again once it is neither (SQL-built: no producer leaves either bound to the latest session on demand)", async () => {
    const r = await rig();
    const sid = await r.goLive();
    r.advance(3 * SEC);
    const b = (await r.broadcastOf(sid))!;
    const url = youtubeWatchUrl(b.ytId);
    expect((await r.view()).youtubeVideoUrl, "premise: linked").toBe(url);
    const [before] = await sql<{ state: string }[]>`select state from youtube_broadcasts where id = ${b.id}`;

    await sql`update youtube_broadcasts set state = 'failed', reserved_until = null where id = ${b.id}`;
    expect((await r.view()).youtubeVideoUrl, "failed").toBeNull();
    await sql`update youtube_broadcasts set state = ${before!.state} where id = ${b.id}`;
    expect((await r.view()).youtubeVideoUrl, "back to its state: linked again").toBe(url);

    await sql`update youtube_broadcasts set yt_broadcast_id = null where id = ${b.id}`;
    expect((await r.view()).youtubeVideoUrl, "no video id yet").toBeNull();
    await sql`update youtube_broadcasts set yt_broadcast_id = ${b.ytId} where id = ${b.id}`;
    expect((await r.view()).youtubeVideoUrl, "the id answered: linked again").toBe(url);
  });

  it("every broadcast state but `failed` links, once the id is known (V479's seven states, checked === 6 linked + 1 not)", async () => {
    const r = await rig();
    const sid = await r.goLive();
    r.advance(3 * SEC);
    const b = (await r.broadcastOf(sid))!;
    const url = youtubeWatchUrl(b.ytId);
    // V479's youtube_broadcasts_state_check, typed from the migration - not imported from the code under test.
    const STATES = ["created", "bound", "reserved", "live", "ending", "complete", "failed"] as const;
    let linked = 0;
    let unlinked = 0;
    for (const state of STATES) {
      await sql`update youtube_broadcasts
                   set state = ${state},
                       reserved_until = ${state === "reserved" ? new Date(Date.now() + 5 * MIN) : null},
                       completed_at = ${state === "complete" ? new Date() : null}
                 where id = ${b.id}`;
      const got = (await r.view()).youtubeVideoUrl;
      if (state === "failed") {
        expect(got, state).toBeNull();
        unlinked++;
      } else {
        expect(got, state).toBe(url);
        linked++;
      }
    }
    expect({ linked, unlinked }, "anti-vacuity: every state was read").toEqual({ linked: 6, unlinked: 1 });
  });

  it("after the channel is DISCONNECTED (the real disconnect purges the broadcast rows) the link is gone; the session itself is still read", async () => {
    const r = await rig();
    const sid = await r.goLive();
    r.advance(3 * SEC);
    const b = (await r.broadcastOf(sid))!;
    r.fake.videoOn(r.fake.inspectBroadcast(b.ytId)!.streamId!);
    r.advance(MIN);
    await r.stop(sid);
    r.fake.videoOff(r.fake.inspectBroadcast(b.ytId)!.streamId!);
    expect((await r.view()).youtubeVideoUrl, "premise: linked before the disconnect").toBe(youtubeWatchUrl(b.ytId));
    r.advance(6 * MIN);   // past the grace: the broadcast no longer blocks a disconnect

    await r.disconnect();
    expect((await sql<{ n: number }[]>`select count(*)::int as n from youtube_broadcasts where fixture_id = ${r.f}`)[0]!.n, "premise: purged").toBe(0);
    const after = await r.view();
    expect(after.id, "the same session is still the view").toBe(sid);
    expect(after.youtubeVideoUrl).toBeNull();
  });

  it("another organisation's broadcast is never this view's link, even if a session row named it (cannot happen through admission - a guard, reached by SQL)", async () => {
    const r = await rig();
    const other = await rig();
    const otherSid = await other.goLive();
    const foreign = (await other.broadcastOf(otherSid))!;
    const sid = await r.goLive();
    const own = (await r.broadcastOf(sid))!;
    r.advance(3 * SEC);
    expect((await r.view()).youtubeVideoUrl, "premise: its own broadcast links").toBe(youtubeWatchUrl(own.ytId));
    await sql`update fixture_stream_sessions set youtube_broadcast_id = ${foreign.id} where id = ${sid}`;
    expect((await r.view()).youtubeVideoUrl).toBeNull();
  });
});
