import { v1, reply, parseBody } from "@/server/api-v1/http";
import { requireResourceAuth } from "@/server/api-v1/auth";
import { DEVICE_LINK_MINT_LIMIT, rateLimit } from "@/lib/rate-limit";
import { CreateDeviceLink } from "@/server/api-v1/schemas";
import { createDeviceLink } from "@/server/usecases/device-links";

type Ctx = { params: Promise<{ id: string }> };

/** Revoke & reissue (scorer sheets §4.2): every live link for the fixture dies
 *  — including a printed sheet's QR — and a fresh sealed link is minted. */
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
    return reply(201, await createDeviceLink(auth, id, body.label ?? null));
  });
}
