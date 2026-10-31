// Tracked sponsor redirect (v10 PROMPT-56; R4 S10, spec 2026-10-27 §3.7). Public sponsor links land here so organisers
// can show sponsors real click numbers, per match and per source. ONE route, two shapes (owner ruling R7, controller
// addendum 2026-10-31), told apart by shape in `resolveSponsorLink`:
//   /s/<sponsorId>?f=<fixtureId>&src=match|site — the public boards (competition page `site`, match page `match`);
//   /s/<CODE> — the short code the stream prints (`seazn.club/s/K7QX`); the code is the whole tag (`stream`).
// The target is only ever the sponsor's stored http(s) url, for an active sponsor; anything else is a 404.
//
// The click write is tail work: it must never delay or break the redirect, so it is deferred, and it is one statement
// (`recordClick`, server/sponsors/clicks.ts).
import { deferred } from "@/lib/deferred";
import { recordClick, resolveSponsorLink } from "@/server/sponsors/clicks";

export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ key: string }> };

export async function GET(req: Request, { params }: Ctx) {
  const { key } = await params;
  const link = await resolveSponsorLink(key, new URL(req.url).searchParams);
  if (link === null) return new Response("Not found", { status: 404 });
  deferred(() => recordClick(link.sponsorId, link.tag));
  return Response.redirect(link.url, 302);
}
