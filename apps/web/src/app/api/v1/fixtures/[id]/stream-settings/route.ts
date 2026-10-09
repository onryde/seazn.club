import { v1, parseBody } from "@/server/api-v1/http";
import { requireResourceAuth } from "@/server/api-v1/auth";
import { PutStreamSettings } from "@/server/api-v1/schemas";
import { saveStreamSettings } from "@/server/usecases/stream-codes";

type Ctx = { params: Promise<{ id: string }> };

/** The fixture's stream settings (capture QR v2 §6.7.3, §8.1): the body is `{ targetId?, autoStream? }`, at least one of
 *  them — `targetId` is the destination pre-pick (`null` clears it), `autoStream` the automatic-streaming switch; a field
 *  left out is left as it is. Editor session only, never key-reachable. 404 for another org's target, an archived one or an
 *  unknown id. */
export async function PUT(req: Request, { params }: Ctx) {
  return v1(async () => {
    const { id } = await params;
    const body = await parseBody(req, PutStreamSettings);
    const auth = await requireResourceAuth(req, "fixture", id, "write");
    return saveStreamSettings(auth, id, body);
  });
}
