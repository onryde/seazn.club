import { v1, parseBody, reply } from "@/server/api-v1/http";
import { requireResourceAuth } from "@/server/api-v1/auth";
import { PatchEntrant } from "@/server/api-v1/schemas";
import { getEntrant, patchEntrant, deleteEntrant } from "@/server/usecases/entrants";

type Ctx = { params: Promise<{ id: string }> };

export async function GET(req: Request, { params }: Ctx) {
  return v1(async () => {
    const { id } = await params;
    const auth = await requireResourceAuth(req, "entrant", id, "read");
    return getEntrant(auth, id);
  });
}

/** Withdraw (status), reseed, rename or replace members (doc 08 §3). */
export async function PATCH(req: Request, { params }: Ctx) {
  return v1(async () => {
    const { id } = await params;
    const body = await parseBody(req, PatchEntrant);
    const auth = await requireResourceAuth(req, "entrant", id, "write");
    return patchEntrant(auth, id, body);
  });
}

/** Hard delete — only while the division is still `setup` (see
 *  deleteEntrant); once scheduling has run, withdraw instead. */
export async function DELETE(req: Request, { params }: Ctx) {
  return v1(async () => {
    const { id } = await params;
    const auth = await requireResourceAuth(req, "entrant", id, "write");
    await deleteEntrant(auth, id);
    return reply(204, null);
  });
}
