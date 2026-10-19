import { parseBody, v1 } from "@/server/api-v1/http";
import { requireResourceAuth } from "@/server/api-v1/auth";
import { ArbiterJoinInput } from "@/server/api-v1/schemas";
import { joinAsArbiter } from "@/server/usecases/external-play";

type Ctx = { params: Promise<{ id: string }> };

/** POST /api/v1/fixtures/{id}/external-play/arbiter (T15, design §5.3; D16, §5.6.4) — a
 *  signed-in organiser joins ONE PLAYER's video meeting receive-only (a board has a
 *  meeting per player, so the body names the entrant `side`): their OWN token
 *  (preset `arbiter`), the side joined and the participant ids of the players
 *  in that meeting. It joins an existing meeting or refuses - it never makes
 *  one. Never a player's token (spec §10), never an API key
 *  (key-scopes NEVER_KEY_ROUTES). 400 for a missing or unknown side; 409
 *  VIDEO_NOT_IN_USE (camera off), VIDEO_OVERRIDDEN (let play without video),
 *  VIDEO_MEETING_NOT_STARTED (that player has not checked in), VIDEO_MEETING_ENDED;
 *  429 past ARBITER_JOIN_LIMIT; 503 VIDEO_UNAVAILABLE when RealtimeKit is down. */
export async function POST(req: Request, { params }: Ctx) {
  return v1(async () => {
    const { id } = await params;
    const auth = await requireResourceAuth(req, "fixture", id, "write");
    const body = await parseBody(req, ArbiterJoinInput);
    return joinAsArbiter(auth, id, body.side);
  });
}
