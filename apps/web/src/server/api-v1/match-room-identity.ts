import "server-only";
// Who is calling a match-room route (spec §12.1). A personal link token in
// `?t=` wins when present — it is the link the player opened, and a signed-in
// organiser following a player's link must read that player's seat, not be
// refused as themselves. Otherwise the caller's SESSION: `requireUser` reads
// the session cookie only, so an API key can never become a room identity
// (the routes are NEVER_KEY_ROUTES in key-scopes.ts as well).
//
// A token also carries WHO IS LOOKING when the browser is signed in (`viewer`): the link works for whoever holds it, so
// the room compares the viewer's account with the seat's to tell the seat's own account from another (owner staging test
// 2026-10-19) - it never decides whose seat this is. Best effort and fail-open: a failed session read is a signed-out
// viewer, the room as it was, never a 500 on a player's poll. Only the routes that BUILD a snapshot ask for it
// (`{ viewer: true }`: GET and POST room, whose snapshot carries `account`) - act, camera, camera-report, camera-fault and
// clock-zero answer none, so they never pay the session lookup (review m1, PR #986).
import { requireUser } from "@/lib/auth";
import { roomViewer } from "@/server/usecases/external-play/room-viewer";
import type { RoomIdentity } from "@/server/usecases/external-play/room";

export async function matchRoomIdentity(req: Request, opts: { viewer?: boolean } = {}): Promise<RoomIdentity> {
  const token = new URL(req.url).searchParams.get("t");
  if (token) {
    const viewer = opts.viewer === true ? await roomViewer() : null;
    return viewer ? { kind: "token", token, viewer } : { kind: "token", token };
  }
  const user = await requireUser();
  return { kind: "session", userId: user.id };
}
