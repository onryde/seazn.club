import "server-only";
// Who is calling a match-room route (spec §12.1). A personal link token in
// `?t=` wins when present — it is the link the player opened, and a signed-in
// organiser following a player's link must read that player's seat, not be
// refused as themselves. Otherwise the caller's SESSION: `requireUser` reads
// the session cookie only, so an API key can never become a room identity
// (the routes are NEVER_KEY_ROUTES in key-scopes.ts as well).
import { requireUser } from "@/lib/auth";
import type { RoomIdentity } from "@/server/usecases/external-play/room";

export async function matchRoomIdentity(req: Request): Promise<RoomIdentity> {
  const token = new URL(req.url).searchParams.get("t");
  if (token) return { kind: "token", token };
  const user = await requireUser();
  return { kind: "session", userId: user.id };
}
