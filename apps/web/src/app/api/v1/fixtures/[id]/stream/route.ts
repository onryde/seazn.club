import { v1, parseBody } from "@/server/api-v1/http";
import { requireResourceAuth } from "@/server/api-v1/auth";
import { PutFixtureStream } from "@/server/api-v1/schemas";
import { setFixtureStreamUrl } from "@/server/usecases/fixtures";

type Ctx = { params: Promise<{ id: string }> };

/** The club's own broadcast link (stream overlay W1). Same write gate the
 *  schedule PATCH uses — `requireResourceAuth(req, "fixture", id, "write")`
 *  (fixtures/[id]/route.ts:17) — because pasting a public link on a fixture is
 *  the same authority as moving it. Returns JSON; never a redirect (R8). */
export async function PUT(req: Request, { params }: Ctx) {
  return v1(async () => {
    const { id } = await params;
    const body = await parseBody(req, PutFixtureStream);
    const auth = await requireResourceAuth(req, "fixture", id, "write");
    return setFixtureStreamUrl(auth, id, body.streamUrl);
  });
}
