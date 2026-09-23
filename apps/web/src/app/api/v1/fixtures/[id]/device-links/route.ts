import { v1, reply, parseBody } from "@/server/api-v1/http";
import { requireResourceAuth } from "@/server/api-v1/auth";
// Per-IP limit on the mint doors (doc 08 §6 pattern; PROMPT-21 item 5), shared
// with …/reissue. Route files may export only handlers, so it lives in lib.
import { DEVICE_LINK_MINT_LIMIT, rateLimit } from "@/lib/rate-limit";
import { CreateDeviceLink } from "@/server/api-v1/schemas";
import { ensureDeviceLink, getActiveDeviceLink } from "@/server/usecases/device-links";

type Ctx = { params: Promise<{ id: string }> };

/**
 * The fixture's device link (doc 13 §7; scorer sheets §4.2): editor session
 * only. Re-shows the live sealed link unchanged (200) or mints one (201),
 * replacing a legacy hash-only link. Never revokes a sealed link — Revoke &
 * reissue is `POST …/device-links/reissue`. 402 `scoring.device_links` for
 * Community without an Event Pass.
 */
export async function POST(req: Request, { params }: Ctx) {
  return v1(async () => {
    const { id } = await params;
    const ip =
      req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ??
      req.headers.get("x-real-ip") ??
      "unknown";
    await rateLimit(`dlmint:${ip}`, DEVICE_LINK_MINT_LIMIT);
    const body = await parseBody(req, CreateDeviceLink);
    const auth = await requireResourceAuth(req, "fixture", id, "write");
    const { row, secret, minted } = await ensureDeviceLink(auth, id, body.label ?? null);
    return reply(minted ? 201 : 200, { ...row, secret });
  });
}

/** The fixture's active link, if any (organiser console; never the secret). */
export async function GET(req: Request, { params }: Ctx) {
  return v1(async () => {
    const { id } = await params;
    const auth = await requireResourceAuth(req, "fixture", id, "write");
    return getActiveDeviceLink(auth, id);
  });
}
