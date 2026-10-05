import { v1 } from "@/server/api-v1/http";
import { requireResourceAuth } from "@/server/api-v1/auth";
import { ensureStreamCode } from "@/server/usecases/stream-codes";

type Ctx = { params: Promise<{ id: string }> };

/** The fixture's stable stream code (capture QR v2 §6.1, W1): editor session only, never key-reachable
 *  (NEVER_KEY_ROUTES — the tok unlocks stream credentials). Re-shows the ACTIVE code (same QR) or mints one; it never
 *  ends a code — Revoke & reissue is `POST …/stream-code/reissue`. 200 {qr, issuedAt}. 402 without `streaming.relay`,
 *  422 `fixture_finished` (C4), 503 `RELAY_KEK_MISSING`. The answer carries a live tok, so EVERY answer is
 *  `private, no-store` and varies on both credentials the door reads (spec §9; the stream-sessions current route's I2). */
export async function POST(req: Request, { params }: Ctx) {
  const res = await v1(async () => {
    const { id } = await params;
    const auth = await requireResourceAuth(req, "fixture", id, "write");
    return ensureStreamCode(auth, id);
  });
  res.headers.set("Cache-Control", "private, no-store");
  res.headers.set("Vary", "Cookie, Authorization");
  return res;
}
