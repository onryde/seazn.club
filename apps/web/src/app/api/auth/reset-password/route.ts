import { handler } from "@/lib/http";
import { consumePasswordReset } from "@/lib/password-reset";
import { z } from "zod";
import { rateLimit, AUTH_LIMIT } from "@/lib/rate-limit";
import { headers } from "next/headers";

const schema = z.object({
  token: z.string().min(1),
  password: z.string().min(6).max(100),
}).strict();

export async function POST(req: Request) {
  return handler(async () => {
    const ip = (await headers()).get("x-forwarded-for")?.split(",")[0]?.trim() ?? "unknown";
    await rateLimit(`reset-password:${ip}`, AUTH_LIMIT);

    const { token, password } = schema.parse(await req.json());
    await consumePasswordReset(token, password);
    return { ok: true };
  });
}
