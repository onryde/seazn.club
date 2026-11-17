import { v1, parseBody } from "@/server/api-v1/http";
import { requireResourceAuth } from "@/server/api-v1/auth";
import { PutCourtStream } from "@/server/api-v1/schemas";
import { setCourtStream } from "@/server/usecases/court-streams";
import { defaultDeps } from "@/server/usecases/stream-sessions";
import { baseUrl } from "@/lib/oauth";

type Ctx = { params: Promise<{ id: string }> };

/** The match's Stream switch (court stream §5.2): `{ on }` hands the match to its court's phone. Editor session only, never
 *  key-reachable. 409 has_own_stream_code / court_not_streaming when turning on; turning off is never refused, and stops the
 *  match's court session at once (O17), with the relay's deps. */
export async function PUT(req: Request, { params }: Ctx) {
  return v1(async () => {
    const { id } = await params;
    const body = await parseBody(req, PutCourtStream);
    const auth = await requireResourceAuth(req, "fixture", id, "write");
    return setCourtStream(auth, id, body.on, new Date(), defaultDeps(baseUrl(req)));
  });
}
