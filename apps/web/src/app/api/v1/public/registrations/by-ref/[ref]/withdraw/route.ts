import { z } from "zod";
import { v1, parseBody, reply } from "@/server/api-v1/http";
import { rateLimit } from "@/lib/rate-limit";
import { clientIp } from "@/lib/client-ip";
import { withdrawRegistrationByRef } from "@/server/usecases/registrations";

type Ctx = { params: Promise<{ ref: string }> };

const Body = z.object({ token: z.string().min(1), registration_id: z.string().uuid() });

/** Self-withdraw from /r/[ref] (v3/05 §3) — ref locates, token authorises.
 *  RS006 follow-up: a cart can hold more than one entry, so the caller names
 *  WHICH one via `registration_id`; `withdrawRegistrationByRef` verifies it
 *  belongs to the ref's own group before anything is withdrawn. */
export async function POST(req: Request, { params }: Ctx) {
  return v1(async () => {
    const ip = clientIp(req.headers);
    await rateLimit(`regwithdraw:${ip}`, { max: 10, windowSeconds: 60 });
    const { ref } = await params;
    const { token, registration_id } = await parseBody(req, Body);
    return reply(
      200,
      await withdrawRegistrationByRef(decodeURIComponent(ref), registration_id, token),
    );
  });
}
