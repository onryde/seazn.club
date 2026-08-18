import { v1, parseBody, reply } from "@/server/api-v1/http";
import { rateLimit } from "@/lib/rate-limit";
import { PublicJoinRequest } from "@/server/api-v1/schemas";
import { joinTeamEntry } from "@/server/usecases/registration-submit";
import { getCurrentUser } from "@/lib/auth";

type Ctx = { params: Promise<{ orgSlug: string; slug: string }> };

/**
 * Join an existing team entry via its `join_code` link (design §4 "Join
 * flow") — mints one player row. `join_code` is globally unique (V364
 * partial unique index), so `joinTeamEntry`'s own lookup needs no
 * org/competition scoping, matching how `ref_code` lookups already work
 * (see its doc comment in registration-submit.ts) — this route does not
 * re-derive or re-check that scoping itself. Its own, tighter rate-limit
 * bucket: a join link is easy to guess-and-hammer if it were only covered
 * by the general public read budget.
 */
export async function POST(req: Request, { params }: Ctx) {
  return v1(async () => {
    const ip =
      req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ??
      req.headers.get("x-real-ip") ??
      "unknown";
    await rateLimit(`regjoin:${ip}`, { max: 5, windowSeconds: 300 });
    // orgSlug/slug are unused: joinTeamEntry needs no org/competition scoping
    // (see above). Still awaited so this route honours the same dynamic-
    // segment contract as its sibling /register.
    await params;
    const input = await parseBody(req, PublicJoinRequest);
    const sessionUser = await getCurrentUser();
    const result = await joinTeamEntry({ sessionUserId: sessionUser?.id ?? null }, input);
    return reply(201, result);
  });
}
