import { z } from "zod";
import { HttpError } from "@/lib/errors";
import { handler } from "@/lib/http";
import { sql } from "@/lib/db";
import { YOUTUBE_ERROR_CODES, YouTubeError } from "@/server/youtube/port";
import { FAKE_YOUTUBE_METHODS, isFakeYouTube, type FakeYouTube } from "@/server/youtube/fake";
import { youtubeDriver, youtubeFakeRoutesEnabled } from "@/server/youtube/driver";
import { openToken } from "@/server/youtube/token-store";

const NOT_FOUND = "Not found";

const Channel = z.object({ id: z.string().min(1).max(64), title: z.string().min(1).max(200) }).strict();
const Id = z.string().min(1).max(128);

/** The ops (plan R6, extended by fix rounds 1 and 2). Every id they take is a HANDLE or an id the product already shows (a stream
 *  id, a video id, a fixture id, an OAuth state) — never a refresh token or a stream key, which an e2e test must not be able to
 *  read or supply.
 *
 *  PARALLEL-SAFE ops name what they touch: a `tokenHandle` (`failNext`, `setLive`, `autoVideo` then scope to that grant's CHANNEL,
 *  so one org's walkthrough does not change another's), an OAuth `state` (`setChannels`, `pinChannels`, `grantScope`, `grantSub`: spent by the
 *  one grant that state mints), or one resource (`videoOn`, `videoOff`, `deleteVideo`, `killToken`, `issueCode`, `state`).
 *  SERIAL-ONLY ops name nothing and act on the whole fake: `reset`, and `failNext` / `setLive` / `autoVideo` WITHOUT a
 *  `tokenHandle`. T20 calls those only from serial setup, never from a spec that runs beside others. */
const Handle = Id;
const State = z.string().min(1).max(512);
const Body = z.discriminatedUnion("op", [
  z.object({ op: z.literal("setChannels"), channels: z.array(Channel).max(20), state: State }).strict(),
  z.object({
    op: z.literal("failNext"), method: z.enum(FAKE_YOUTUBE_METHODS), code: z.enum(YOUTUBE_ERROR_CODES), reason: z.string().max(200).optional(),
    tokenHandle: Handle.optional(),
  }).strict(),
  z.object({ op: z.literal("pinChannels"), tokenHandle: Handle, state: State }).strict(),
  z.object({ op: z.literal("killToken"), tokenHandle: Handle }).strict(),
  z.object({ op: z.literal("videoOn"), streamId: Id }).strict(),
  z.object({ op: z.literal("videoOff"), streamId: Id }).strict(),
  z.object({ op: z.literal("deleteVideo"), videoId: Id }).strict(),
  z.object({ op: z.literal("setLive"), state: z.enum(["enabled", "not_enabled", "blocked"]), tokenHandle: Handle.optional() }).strict(),
  z.object({ op: z.literal("autoVideo"), on: z.boolean(), tokenHandle: Handle.optional() }).strict(),
  z.object({ op: z.literal("issueCode"), state: State }).strict(),
  z.object({ op: z.literal("grantScope"), scope: z.string().min(1).max(512).nullable(), state: State }).strict(),
  z.object({ op: z.literal("grantSub"), sub: z.string().min(1).max(255).nullable(), state: State }).strict(),
  z.object({ op: z.literal("reset") }).strict(),
  z.object({ op: z.literal("state"), fixtureId: z.uuid() }).strict(),
]);

/** POST /api/internal/youtube/fake — the e2e walkthroughs' control over the FAKE YouTube (YouTube Connect T5, R6): kill a token,
 *  turn video on or off, delete a video, make the next call fail, read where a fixture's broadcasts stand.
 *
 *  404 unless YOUTUBE_DRIVER is fake AND ENV_NAME is local or ci (driver.ts `youtubeFakeRoutesEnabled`, the same name list as
 *  the fake-ingest control route), and BEFORE the body is read — an invalid body on a refused deployment is the same 404, so the
 *  route does not confirm it exists. No auth, like fake-ingest: it exists nowhere a real channel, a real token or a named
 *  deployment does. 400 for any body that is not one of the ops; 404 for a stream, video, handle or fixture it does not know.
 *
 *  `state { fixtureId }` answers `{ connectionId, tokenHandle, broadcasts: [{ videoId, life, streamId }] }`: the fixture's
 *  connection and broadcast rows are resolved here, server-side, so the answer holds handles and ids and no refresh token,
 *  access token, stream key or ingest URL. */
export async function POST(req: Request) {
  return handler(async () => {
    if (!youtubeFakeRoutesEnabled(process.env)) throw new HttpError(404, NOT_FOUND);
    const fake = youtubeDriver();
    if (!isFakeYouTube(fake)) throw new HttpError(404, NOT_FOUND);
    const parsed = Body.safeParse(await req.json().catch(() => null));
    if (!parsed.success) throw new HttpError(400, "Not one of the fake YouTube's ops");
    const body = parsed.data;
    try {
      switch (body.op) {
        case "setChannels": fake.setChannels(body.channels, body.state); return { op: body.op };
        case "failNext": fake.failNext(body.method, body.code, body.reason, scopeOf(fake, body.tokenHandle)); return { op: body.op };
        case "pinChannels": fake.pinChannelsTo(body.tokenHandle, body.state); return { op: body.op };
        case "killToken": fake.killHandle(body.tokenHandle); return { op: body.op };
        case "videoOn": fake.videoOn(body.streamId); return { op: body.op };
        case "videoOff": fake.videoOff(body.streamId); return { op: body.op };
        case "deleteVideo": fake.deleteVideo(body.videoId); return { op: body.op };
        case "setLive": fake.setLive(body.state, scopeOf(fake, body.tokenHandle)); return { op: body.op };
        case "autoVideo": fake.setAutoVideo(body.on, scopeOf(fake, body.tokenHandle)); return { op: body.op };
        // The fake authorize hop's job, for a walkthrough that drives the callback itself. A code alone is no credential.
        case "issueCode": return { op: body.op, code: fake.issueCode(body.state) };
        case "grantScope": fake.setGrantedScope(body.scope, body.state); return { op: body.op };
        // The Google account subject the one grant of this state reports; null = a youtube-only token with no `sub` (T18's branch).
        case "grantSub": fake.setGoogleSub(body.sub, body.state); return { op: body.op };
        case "reset": fake.reset(); return { op: body.op };
        case "state": return await fixtureState(fake, body.fixtureId);
      }
    } catch (err) {
      // The fake's own refusals: an unknown id is a 404, the channel's limits a 409 carrying YouTube's code. Nothing else of the
      // error (it holds none of the request) is forwarded.
      if (err instanceof YouTubeError) {
        if (err.code === "youtube_not_found") throw new HttpError(404, NOT_FOUND);
        throw new HttpError(409, "The fake YouTube refused", err.code);
      }
      throw err;
    }
  });
}

/** A handle names a grant, and a grant acts on one channel: that channel is the scope. No handle: no scope. */
function scopeOf(fake: FakeYouTube, tokenHandle: string | undefined): { channelId: string } | undefined {
  return tokenHandle === undefined ? undefined : { channelId: fake.channelOfHandle(tokenHandle) };
}

type FixtureStateRow = { connection_id: string | null; video_id: string | null; stream_id: string | null };

async function fixtureState(fake: FakeYouTube, fixtureId: string) {
  const [fixture] = await sql<{ org_id: string }[]>`select org_id from fixtures where id = ${fixtureId}`;
  if (!fixture) throw new HttpError(404, NOT_FOUND);
  // The broadcasts YouTube knows about (a row not yet created there has no video id), oldest first; the stream id is the
  // pooled key's liveStream id, a plain column — the sealed key itself is never read.
  const rows = await sql<FixtureStateRow[]>`
    select b.connection_id, b.yt_broadcast_id as video_id, k.live_stream_id as stream_id
      from youtube_broadcasts b
      left join youtube_stream_keys k on k.id = b.key_id
     where b.fixture_id = ${fixtureId} and b.org_id = ${fixture.org_id}
     order by b.created_at, b.id`;
  let connectionId = rows.length > 0 ? rows[rows.length - 1]!.connection_id : null;
  if (connectionId === null) {
    // No broadcast yet: the connection is the fixture's chosen destination's, if that destination is a connection.
    const [dest] = await sql<{ youtube_connection_id: string | null }[]>`
      select t.youtube_connection_id
        from fixture_stream_settings s
        join org_stream_targets t on t.id = s.target_id
       where s.fixture_id = ${fixtureId} and s.org_id = ${fixture.org_id}`;
    connectionId = dest?.youtube_connection_id ?? null;
  }
  const refreshToken = connectionId === null ? null : await openToken(sql, fixture.org_id, connectionId);
  return {
    connectionId,
    tokenHandle: refreshToken === null ? null : fake.tokenHandle(refreshToken),
    broadcasts: rows
      .filter((r) => r.video_id !== null)
      .map((r) => ({ videoId: r.video_id!, life: fake.inspectBroadcast(r.video_id!)?.life ?? "absent", streamId: r.stream_id })),
  };
}
