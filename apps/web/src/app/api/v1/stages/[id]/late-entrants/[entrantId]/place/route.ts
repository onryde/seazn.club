import { HttpError } from "@/lib/errors";
import { v1 } from "@/server/api-v1/http";
import { requireResourceAuth } from "@/server/api-v1/auth";
import { PlaceLateEntrantInput } from "@/server/api-v1/schemas";
import { placeWaitingLateEntrant } from "@/server/usecases/roundrobin-late-entry";

type Ctx = { params: Promise<{ id: string; entrantId: string }> };

/** W4 T11 (X-LE-10, ruling 271): the organiser's one tap on a late player WAITING to join the stage — an automatic arrival
 *  (a paid registration, a waitlist promotion, an import, a Reinstate) the app never places by itself. Dispatched by the
 *  stage's kind (`placeWaitingLateEntrant`): a knockout runs the cases "Add late player" runs (the bye, a withdrawn slot; a
 *  reinstated player's own walkover reversed) and answers a KnockoutLateEntryResult — placed, or `refused` /
 *  `rebuild_offered` (200, the player keeps waiting); 409 KO_LATE_ENTRY_NOT_WAITING, 422 KO_LATE_ENTRY_FED_STAGE.
 *  W5 T6 (X-CU-8): a running root league or group writes the player's catch-up lines and answers a TableLateEntryResult;
 *  optional body `pool_key` names a group's pool, and `prefer_rebuild` (fix round 1 I1) redraws a stage nothing has started in
 *  with the player in it (409 STAGE_HAS_RESULTS once a match has started); 409 RR_LATE_ENTRY_ALREADY_PLACED / RR_LATE_ENTRY_NOT_WAITING
 *  (usecases/roundrobin-late-entry.ts). */
export async function POST(req: Request, { params }: Ctx) {
  return v1(async () => {
    const { id, entrantId } = await params;
    const auth = await requireResourceAuth(req, "stage", id, "write");
    // No body is the W4 call (a knockout, or a league / group with no pool named): an empty or absent body reads as `{}`.
    const text = await req.text();
    let raw: unknown = {};
    if (text.trim() !== "") {
      try {
        raw = JSON.parse(text);
      } catch {
        throw new HttpError(400, "Request body must be valid JSON");
      }
    }
    const body = PlaceLateEntrantInput.parse(raw);
    // Fix round 1 I1: the strip's Rebuild exit (`prefer_rebuild`), passed only when asked so the W4 / W5 T6 calls are unchanged.
    return body.prefer_rebuild === true
      ? placeWaitingLateEntrant(auth, id, entrantId, body.pool_key, { preferRebuild: true })
      : placeWaitingLateEntrant(auth, id, entrantId, body.pool_key);
  });
}
