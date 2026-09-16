import { v1 } from "@/server/api-v1/http";
import { requireResourceAuth } from "@/server/api-v1/auth";
import { resendExternalPlayNotice } from "@/server/usecases/external-play";
import { baseUrl } from "@/lib/oauth";

type Ctx = { params: Promise<{ id: string }> };

/** POST /api/v1/fixtures/{id}/external-play/resend — re-email the Seazn
 *  fixture URL. Does not create a new Lichess challenge. */
export async function POST(req: Request, { params }: Ctx) {
  return v1(async () => {
    const { id } = await params;
    const auth = await requireResourceAuth(req, "fixture", id, "write");
    return resendExternalPlayNotice(auth, id, baseUrl(req));
  });
}
