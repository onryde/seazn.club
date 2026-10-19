import "server-only";
// Who is looking at a match room opened through a personal link (owner staging test 2026-10-19): the signed-in user behind
// the request, if any. The link works for whoever holds it, so the room compares this account with the seat's to tell the
// seat's own account from another (room.ts `seatAccount`); it never decides whose seat it is. Best effort and fail-open: a
// failed session read is a signed-out viewer - the room as it was - never a 500 on a player's poll.
import { getCurrentUser } from "@/lib/auth";
import type { RoomViewer } from "./room";

export async function roomViewer(): Promise<RoomViewer | null> {
  try {
    const user = await getCurrentUser();
    return user ? { userId: user.id, email: user.email } : null;
  } catch {
    return null;
  }
}
