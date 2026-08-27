import { v1, parseBody, reply } from "@/server/api-v1/http";
import { rateLimit } from "@/lib/rate-limit";
import { PublicJoinRequest } from "@/server/api-v1/schemas";
import { joinTeamEntry, previewJoinEntry } from "@/server/usecases/registration-submit";
import { getCurrentUser } from "@/lib/auth";

type Ctx = { params: Promise<{ orgSlug: string; slug: string }> };

function clientIp(req: Request): string {
  return (
    req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ??
    req.headers.get("x-real-ip") ??
    "unknown"
  );
}

/**
 * Join-link preview — the join page's first read, before it asks anyone to
 * type anything (design §4 "Join flow"). Same no-scoping-needed lookup as
 * the POST below (global `join_code`, see its own doc comment). Own rate-
 * limit bucket, same budget as POST: an unauthenticated GET-by-code is at
 * least as easy to guess-and-hammer as the mutating join itself — arguably
 * the cheaper oracle of the two, so it gets no more slack.
 */
export async function GET(req: Request, { params }: Ctx) {
  return v1(async () => {
    await rateLimit(`regjoinpreview:${clientIp(req)}`, { max: 5, windowSeconds: 300 });
    // orgSlug/slug unused — see the POST handler's own comment below.
    await params;
    const url = new URL(req.url);
    const joinCode = PublicJoinRequest.shape.join_code.parse(url.searchParams.get("join_code"));
    return previewJoinEntry(joinCode);
  });
}

/**
 * Join an existing team OR pair entry via its `join_code` link (design §4
 * "Join flow") — claims an existing captain-entered slot when the request
 * names one (`player_id`), else mints a new player row. `join_code` is
 * globally unique (V364 partial unique index), so `joinTeamEntry`'s own
 * lookup needs no org/competition scoping, matching how `ref_code` lookups
 * already work (see its doc comment in registration-submit.ts) — this route
 * does not re-derive or re-check that scoping itself. Its own, tighter
 * rate-limit bucket: a join link is easy to guess-and-hammer if it were
 * only covered by the general public read budget.
 */
export async function POST(req: Request, { params }: Ctx) {
  return v1(async () => {
    await rateLimit(`regjoin:${clientIp(req)}`, { max: 5, windowSeconds: 300 });
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
