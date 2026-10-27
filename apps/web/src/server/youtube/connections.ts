import "server-only";
// server/youtube/connections.ts — the connect flow's save (plan T8 owns this file).
//
// STUB, written by T7 so the OAuth callback has something to import. T8 REPLACES this file with the real usecase (one
// transaction: take the pending grant's token, insert the connection and its destination row, delete the pending row;
// 23505 on org_youtube_connections_one_live_channel -> HttpError(409, …, "YOUTUBE_OTHER_ORG") with NO revoke at Google —
// the new grant is the one the live connection uses; a reconnect replaces the token). The callback relies on exactly that
// contract: it answers `other_org` on that HttpError code and revokes nothing, and on any other throw it drops the pending
// grant and revokes (guarded by server/youtube/connect-flow.ts `grantInUse`). Until T8 lands, the one-channel and the pick
// paths of the callback reach this stub and answer `expired`; B3 does not ship without T8.
import type { YouTubePort } from "./port";

export async function saveConnectionFromGrant(
  a: { pendingId: string; channelId: string; userId: string },
  port: YouTubePort,
): Promise<{ connectionId: string; targetId: string }> {
  void a;
  void port;
  throw new Error("saveConnectionFromGrant is built by plan T8");
}
