import { v1, parseBody, reply } from "@/server/api-v1/http";
import { requireResourceAuth } from "@/server/api-v1/auth";
import { OfficiatingBlackoutInput } from "@/server/api-v1/schemas";
import { HttpError } from "@/lib/errors";
import {
  deleteOfficialBlackout,
  listOfficialBlackout,
  setOfficialBlackout,
} from "@/server/usecases/officials";

type Ctx = { params: Promise<{ id: string }> };

/** Read back this official's blackout dates (G9, bench B03 product-gaps):
 *  G2 shipped the write with no read — an organiser could set a blackout and
 *  never see it again short of the console-wide listOfficialBlackouts. */
export async function GET(req: Request, { params }: Ctx) {
  return v1(async () => {
    const { id } = await params;
    const auth = await requireResourceAuth(req, "official", id, "read");
    return listOfficialBlackout(auth, id);
  });
}

/** Org-side blackout write (G2, bench B03 product-gaps): the organiser's
 *  counterpart to POST /me/availability/officiating. Scoped to this one
 *  officials row via requireResourceAuth — never fans out across orgs the
 *  way the self-service /me route does. */
export async function POST(req: Request, { params }: Ctx) {
  return v1(async () => {
    const { id } = await params;
    const body = await parseBody(req, OfficiatingBlackoutInput);
    const auth = await requireResourceAuth(req, "official", id, "write");
    return reply(201, await setOfficialBlackout(auth, id, body.date, body.note));
  });
}

/** Clear a blackout date (?date=YYYY-MM-DD, idempotent). */
export async function DELETE(req: Request, { params }: Ctx) {
  return v1(async () => {
    const { id } = await params;
    const date = new URL(req.url).searchParams.get("date");
    if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      throw new HttpError(400, "Invalid date — expected ?date=YYYY-MM-DD");
    }
    const auth = await requireResourceAuth(req, "official", id, "write");
    await deleteOfficialBlackout(auth, id, date);
    return { deleted: true };
  });
}
