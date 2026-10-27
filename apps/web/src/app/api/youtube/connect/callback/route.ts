import { cookies } from "next/headers";
import { requireUser } from "@/lib/auth";
import { HttpError } from "@/lib/errors";
import { handler, redirectLocal } from "@/lib/http";
import { YOUTUBE_OAUTH_STATE_COOKIE, YOUTUBE_OAUTH_VERIFIER_COOKIE, youtubeRedirectUri } from "@/lib/oauth";
import { EDITOR_ROLES } from "@/lib/types";
import { YOUTUBE_SCOPE, youtubeLanding, type YoutubeLandingCode } from "@/lib/youtube";
import { log } from "@/server/logger";
import { sql } from "@/lib/db";
import { sealPendingToken } from "@/server/youtube/token-store";
import { claimPending, dropPending, grantInUse, reconnectTarget, roleNow, storeGrant } from "@/server/youtube/connect-flow";
import { saveConnectionFromGrant } from "@/server/youtube/connections";
import { youtubeDriver } from "@/server/youtube/driver";
import { YouTubeError, type YouTubePort } from "@/server/youtube/port";

/** Every exit is the same: a 303 to the Streaming page carrying one outcome (lib/youtube.ts `youtubeLanding`). */
const land = (code: YoutubeLandingCode, pendingId?: string) => redirectLocal(youtubeLanding(code, pendingId), 303);

/** What went wrong, as a code and nothing else: an error here may be a Google or database error whose text echoes a value, so
 *  only its class (and a YouTube error's own closed code and reason) reaches a log line. */
function failureOf(err: unknown): { failure: string; reason?: string } {
  if (err instanceof YouTubeError) return { failure: err.code, reason: err.reason };
  return { failure: err instanceof Error ? err.name : "unknown" };
}

/** The ids of the channels this grant can act on, or NULL when they cannot be read. Only used to decide whether a grant we are
 *  refusing may be revoked, and "cannot read" is not "none": a grant whose channels are unknown might be the one a live
 *  connection (any org) runs on, and revoking it would kill that connection. So null means the grant is left alone. */
async function channelIdsOf(port: YouTubePort, refreshToken: string): Promise<string[] | null> {
  try {
    return (await port.listMyChannels(await port.accessToken(refreshToken))).map((c) => c.id);
  } catch {
    return null;
  }
}

/** Google redirects here (a GET) after consent: spend the state, redeem the code with the PKCE verifier, check the user, the
 *  scope and the channels, and either connect, ask for a pick, or refuse — and on a refusal give the grant back at Google, unless
 *  a live connection already uses it (or its channels cannot be read, so whether one does is unknown). Every exit once the
 *  grant exists is a landing; a failure before that (the database, the driver) is the house error response, in `handler`, with
 *  the request's id on its log line. No URL it builds carries the code, a token or the verifier. */
export async function GET(req: Request) {
  return handler(() => callback(req));
}

async function callback(req: Request): Promise<Response> {
  const url = new URL(req.url);
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  const googleError = url.searchParams.get("error");

  const jar = await cookies();
  const expectedState = jar.get(YOUTUBE_OAUTH_STATE_COOKIE)?.value;
  const verifier = jar.get(YOUTUBE_OAUTH_VERIFIER_COOKIE)?.value;
  // Spent on arrival, whatever follows: a second delivery of this callback finds no cookie.
  jar.delete(YOUTUBE_OAUTH_STATE_COOKIE);
  jar.delete(YOUTUBE_OAUTH_VERIFIER_COOKIE);

  let user: { id: string };
  try {
    user = await requireUser();
  } catch {
    return land("expired");
  }

  // `state !== expectedState` also covers a missing cookie (state is a non-empty string here).
  if (!state || state !== expectedState || !verifier) return land("expired");

  // The state is single-use: this statement either hands over the pending grant or finds none (spent, expired, someone
  // else's). It is the only thing that lets a callback proceed, so a replay cannot mint a second connection or token.
  const pending = await claimPending(state, user.id);
  if (!pending) return land("expired");

  if (googleError !== null) {
    await dropPending(pending.id);
    return land("denied");
  }
  if (!code) {
    await dropPending(pending.id);
    return land("expired");
  }

  const port = youtubeDriver();
  let grant: { refreshToken: string; scope: string; googleSub: string | null };
  try {
    grant = await port.exchangeCode({ code, codeVerifier: verifier, redirectUri: youtubeRedirectUri(req) });
  } catch (err) {
    await dropPending(pending.id);
    const why = failureOf(err);
    log.warn({ orgId: pending.orgId, ...why }, "youtube connect callback: the code could not be redeemed");
    // Seazn's own configuration (no Google client, a redirect URI Google does not know) is not the club's to retry.
    const ours = err instanceof YouTubeError && (err.reason === "notConfigured" || err.reason === "redirectUriMismatch");
    return land(ours ? "not_configured" : "expired");
  }
  const { refreshToken, scope, googleSub } = grant;

  // From here a grant exists at Google. Every exit that does not store it goes through `refuse`, which gives the grant back —
  // unless a live connection (in ANY org) holds the grant's channel or its Google account: revoking that grant would kill
  // that connection. And unless the grant's channels cannot be read: then whether a connection holds it is unknown, and an
  // unrevoked grant is only an unused entry in the user's Google permissions, where a revoked one may be a dead connection.
  // Best effort and never throws.
  let channelIds: string[] | null | undefined;   // undefined: not read yet; null: could not be read
  const refuse = async (outcome: YoutubeLandingCode): Promise<Response> => {
    try {
      await dropPending(pending.id);
      if (channelIds === undefined) channelIds = await channelIdsOf(port, refreshToken);
      if (channelIds === null) {
        log.warn({ orgId: pending.orgId, outcome }, "youtube connect callback: the grant's channels are unknown, so it was NOT revoked");
      } else if (!(await grantInUse(channelIds, googleSub))) {
        await port.revoke(refreshToken);
      }
    } catch (err) {
      log.error({ orgId: pending.orgId, ...failureOf(err) }, "youtube connect callback: the refused grant could not be cleaned up");
    }
    return land(outcome);
  };

  try {
    // A fresh read, never the pending row's word and never the cache: the role may have gone since the start.
    const role = await roleNow(pending.orgId, user.id);
    if (!role || !(EDITOR_ROLES as readonly string[]).includes(role)) return await refuse("forbidden");

    // Membership of the space-separated list, never a substring: `…/auth/youtube.readonly` is not `…/auth/youtube`.
    if (!scope.split(/\s+/).includes(YOUTUBE_SCOPE)) return await refuse("scope_missing");

    let channels: { id: string; title: string }[];
    try {
      channels = await port.listMyChannels(await port.accessToken(refreshToken));
    } catch (err) {
      // YouTube did not answer (or the grant is unusable): that is not "no channel", and it is not a reason to revoke.
      log.warn({ orgId: pending.orgId, ...failureOf(err) }, "youtube connect callback: the grant's channels could not be read");
      channelIds = null;
      return await refuse("unavailable");
    }
    const grantChannelIds = channels.map((c) => c.id);
    channelIds = grantChannelIds;
    if (channels.length === 0) return await refuse("no_channel");

    // A reconnect is for THE connection's channel: the grant may list several, and it need not be first.
    let channelId: string | null = channels.length === 1 ? channels[0]!.id : null;
    if (pending.connectionId) {
      const target = await reconnectTarget(pending.orgId, pending.connectionId);
      if (!target) return await refuse("expired");   // disconnected between the start and now
      if (!grantChannelIds.includes(target.channelId)) return await refuse("different_channel");
      channelId = target.channelId;
    }

    // The token is sealed on the pending row in the same transaction as the grant's details: no unsealed copy is ever stored,
    // and a row without its token cannot be picked from.
    await sql.begin(async (tx) => {
      await storeGrant(tx, pending.id, { grantedScope: scope, googleSub, channels });
      await sealPendingToken(tx, pending.id, refreshToken);
    });
    if (channelId === null) return land("pick", pending.id);

    try {
      await saveConnectionFromGrant({ pendingId: pending.id, channelId, userId: user.id }, port);
    } catch (err) {
      // The channel is live in another org (V479 one-live-channel is global). The new grant is the same Google grant that
      // connection uses: NOT revoked. Our pending grant, with the token sealed on it, is simply dropped.
      if (err instanceof HttpError && err.code === "YOUTUBE_OTHER_ORG") {
        await dropPending(pending.id);
        return land("other_org");
      }
      throw err;
    }
    return land("connected");
  } catch (err) {
    log.error({ orgId: pending.orgId, ...failureOf(err) }, "youtube connect callback: failed after the grant was made; nothing was connected");
    return await refuse("expired");
  }
}
