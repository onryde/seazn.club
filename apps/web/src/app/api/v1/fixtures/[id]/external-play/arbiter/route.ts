import { v1 } from "@/server/api-v1/http";
import { requireResourceAuth } from "@/server/api-v1/auth";
import { joinAsArbiter } from "@/server/usecases/external-play";

type Ctx = { params: Promise<{ id: string }> };

/** POST /api/v1/fixtures/{id}/external-play/arbiter (T15, design §5.3) — a
 *  signed-in organiser joins the board's video meeting receive-only: their
 *  OWN token (preset `arbiter`) and the two players' participant ids by
 *  colour. Never a player's token (spec §10), never an API key
 *  (key-scopes NEVER_KEY_ROUTES). 409 VIDEO_NOT_IN_USE (camera off),
 *  VIDEO_OVERRIDDEN (let play without video), VIDEO_MEETING_ENDED; 503
 *  VIDEO_UNAVAILABLE when RealtimeKit is down. */
export async function POST(req: Request, { params }: Ctx) {
  return v1(async () => {
    const { id } = await params;
    const auth = await requireResourceAuth(req, "fixture", id, "write");
    return joinAsArbiter(auth, id);
  });
}
