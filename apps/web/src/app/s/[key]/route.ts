// Tracked sponsor redirect (v10 PROMPT-56; R4 S10, spec 2026-10-27 §3.7). Public sponsor links land here so organisers
// can show sponsors real click numbers, per match and per source. ONE route, two shapes (owner ruling R7, controller
// addendum 2026-10-31), told apart by shape in `resolveSponsorLink`:
//   /s/<sponsorId>?f=<fixtureId>&src=match|site — the public boards (competition page `site`, match page `match`);
//   /s/<CODE> — the short code the stream prints (`seazn.club/s/K7QX`, any case); the code is the whole tag (`stream`).
// The target is only ever the sponsor's stored http(s) url, for an active sponsor; anything else is a 404.
//
// The click write is tail work: it must never delay or break the redirect, so it is deferred, and it is one statement
// (`recordClick`, server/sponsors/clicks.ts). Fix round 1 (I3) filters the WRITE, never the redirect: a HEAD or a bot's
// GET is redirected and not counted (`countsAsClick`), and a repeat tap inside the window counts once
// (`recordClickOnce`). Only a MISS is rate limited — past `SPONSOR_LINK_MISS_LIMIT` an IP's 404 becomes a 429, which
// blunts walking the short-code keyspace; a 302 is never refused.
import { deferred } from "@/lib/deferred";
import { HttpError } from "@/lib/errors";
import { rateLimit, SPONSOR_LINK_MISS_LIMIT } from "@/lib/rate-limit";
import { clientIpOf } from "@/server/api-v1/capture-http";
import { clientIpDigest, countsAsClick, recordClickOnce, resolveSponsorLink } from "@/server/sponsors/clicks";

export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ key: string }> };

export async function GET(req: Request, { params }: Ctx) {
  const { key } = await params;
  const ip = clientIpOf(req);
  const link = await resolveSponsorLink(key, new URL(req.url).searchParams);
  if (link === null) return miss(ip);
  if (countsAsClick(req)) deferred(() => recordClickOnce(link, ip));
  return Response.redirect(link.url, 302);
}

/** A 404, spending the IP's miss budget first: past it, a 429 with the window's Retry-After. */
async function miss(ip: string): Promise<Response> {
  try {
    await rateLimit(`s404:${clientIpDigest(ip)}`, SPONSOR_LINK_MISS_LIMIT);
  } catch (err) {
    if (err instanceof HttpError && err.status === 429) {
      return new Response(err.message, { status: 429, headers: err.headers });
    }
    throw err;
  }
  return new Response("Not found", { status: 404 });
}
