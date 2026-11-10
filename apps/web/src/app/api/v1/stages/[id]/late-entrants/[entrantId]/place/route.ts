import { v1 } from "@/server/api-v1/http";
import { requireResourceAuth } from "@/server/api-v1/auth";
import { placeWaitingKnockoutEntrant } from "@/server/usecases/knockout-late-entry";

type Ctx = { params: Promise<{ id: string; entrantId: string }> };

/** W4 T11 (X-LE-10, ruling 271): the organiser's one tap on a late player WAITING to join the stage's bracket — an
 *  automatic arrival (a paid registration, a waitlist promotion, an import, a Reinstate) the app never places by
 *  itself. Runs the cases "Add late player" runs (the bye, a withdrawn slot; a reinstated player's own walkover
 *  reversed) and answers a KnockoutLateEntryResult: placed, or `refused` / `rebuild_offered` (200 — the player keeps
 *  waiting). 409 KO_LATE_ENTRY_NOT_WAITING when the entrant does not wait on this stage; 422 KO_LATE_ENTRY_FED_STAGE
 *  when this knockout is filled from another stage (usecases/knockout-late-entry.ts). */
export async function POST(req: Request, { params }: Ctx) {
  return v1(async () => {
    const { id, entrantId } = await params;
    const auth = await requireResourceAuth(req, "stage", id, "write");
    return placeWaitingKnockoutEntrant(auth, id, entrantId);
  });
}
