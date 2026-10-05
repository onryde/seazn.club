import { v1 } from "@/server/api-v1/http";
import { requireResourceAuth } from "@/server/api-v1/auth";
import { reissueStreamCode } from "@/server/usecases/stream-codes";

type Ctx = { params: Promise<{ id: string }> };

/** Revoke & reissue the fixture's stream code (capture QR v2 §6.1, C3): the ACTIVE code ends at once (its phone's open
 *  session keeps a get and a beat until it ends) and a fresh one is minted. Editor session only, never key-reachable.
 *  200 {qr, issuedAt}; the same refusals as the ensure. `private, no-store` on every answer: the new tok is live. */
export async function POST(req: Request, { params }: Ctx) {
  const res = await v1(async () => {
    const { id } = await params;
    const auth = await requireResourceAuth(req, "fixture", id, "write");
    return reissueStreamCode(auth, id);
  });
  res.headers.set("Cache-Control", "private, no-store");
  res.headers.set("Vary", "Cookie, Authorization");
  return res;
}
