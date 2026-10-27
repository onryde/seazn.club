import { randomBytes } from "node:crypto";
import { cookies } from "next/headers";
import { NextResponse } from "next/server";
import { z } from "zod";
import { getOrgRole, requireUser } from "@/lib/auth";
import { HttpError } from "@/lib/errors";
import { handler, redirectLocal } from "@/lib/http";
import { YOUTUBE_OAUTH_STATE_COOKIE, YOUTUBE_OAUTH_VERIFIER_COOKIE, youtubeRedirectUri } from "@/lib/oauth";
import { EDITOR_ROLES } from "@/lib/types";
import { YOUTUBE_CONSENT_VERSION, YOUTUBE_PRIVACIES, youtubeLanding } from "@/lib/youtube";
import { pkceChallenge, pkceVerifier } from "@/server/external-play/pkce";
import { log } from "@/server/logger";
import { PENDING_LIFETIME_SECONDS, insertPending, reconnectTarget, unusableConnectKeys } from "@/server/youtube/connect-flow";
import { youtubeDriver } from "@/server/youtube/driver";
import { YouTubeError } from "@/server/youtube/port";

/** Short-lived cookies that only need to survive the round trip to Google and back — the same shape as the Lichess flow's.
 *  They carry the `state` and the PKCE verifier and nothing else: the intent (org, user, consent) is the pending row. */
const OAUTH_COOKIE_OPTS = {
  httpOnly: true,
  sameSite: "lax" as const,
  secure: process.env.NODE_ENV === "production",
  path: "/",
  maxAge: PENDING_LIFETIME_SECONDS,
};

/** The consent form (plan T7). An empty string is an absent field, so an unticked box or a blank select is "missing", never a
 *  value. `consent` must be exactly "1" (D7: the box is ticked once per connection, before Google is asked). */
const ConnectForm = z.object({
  orgId: z.uuid(),
  privacy: z.enum(YOUTUBE_PRIVACIES),
  madeForKids: z.enum(["0", "1", "true", "false"]).optional(),
  consent: z.literal("1"),
  connectionId: z.uuid().optional(),
});

/** A present Origin must be the origin this flow RETURNS to: the one the redirect URI names (the base URL unless
 *  YOUTUBE_REDIRECT_URI pins it) — cookies are host-bound, so a form from any other origin could not finish the round trip
 *  anyway. An absent Origin passes (SameSite=Lax already withholds the session from a cross-site POST). proxy.ts compares the
 *  hostname only; this compares the whole origin, scheme and port included. */
function originIsOurs(req: Request): boolean {
  const origin = req.headers.get("origin");
  if (origin === null) return true;
  return origin === new URL(youtubeRedirectUri(req)).origin;
}

/** Start connecting a YouTube channel (a form POST from the Directory's consent step): record the consent, then send the
 *  browser to Google (or, in CI, to the fake authorize hop). Every browser-facing refusal that is not a bad request lands on
 *  the Directory with `?youtube=<code>`; a bad request (no consent, a viewer, a foreign org) is the plain status. */
export async function POST(req: Request) {
  return handler(async () => {
    if (!originIsOurs(req)) throw new HttpError(403, "Cross-origin request refused");
    const user = await requireUser();

    const fd = await req.formData().catch(() => null);
    if (!fd) throw new HttpError(400, "Expected a form");
    const fields: Record<string, string> = {};
    for (const [k, v] of fd.entries()) if (typeof v === "string" && v !== "") fields[k] = v;
    const body = ConnectForm.parse(fields);

    // Membership first: an org the caller is not in is a 404 (no oracle for which orgs exist), a viewer is a 403.
    const role = await getOrgRole(body.orgId, user.id);
    if (!role) throw new HttpError(404, "Not found");
    if (!(EDITOR_ROLES as readonly string[]).includes(role)) throw new HttpError(403, "Only an owner or admin can connect YouTube");
    if (body.connectionId && !(await reconnectTarget(body.orgId, body.connectionId))) throw new HttpError(404, "Not found");

    // A grant made while the callback cannot seal it would be orphaned live at Google: refuse BEFORE sending anyone there.
    const unusable = unusableConnectKeys();
    if (unusable.length > 0) {
      log.error({ orgId: body.orgId, unusable }, "youtube connect: a key the callback seals with is unusable; nobody was sent to Google");
      return redirectLocal(youtubeLanding("not_configured"), 303);
    }

    const state = randomBytes(32).toString("base64url");
    const verifier = pkceVerifier();
    let authorizeUrl: string;
    try {
      authorizeUrl = youtubeDriver().authorizeUrl({ state, codeChallenge: pkceChallenge(verifier), redirectUri: youtubeRedirectUri(req) });
    } catch (err) {
      // The live driver refuses, synchronously, when Seazn's own Google client config is missing: a clean landing, not a 500.
      if (err instanceof YouTubeError && err.reason === "notConfigured") {
        log.error({ orgId: body.orgId }, "youtube connect: the Google client is not configured; nobody was sent to Google");
        return redirectLocal(youtubeLanding("not_configured"), 303);
      }
      throw err;
    }

    await insertPending({
      state, orgId: body.orgId, userId: user.id, connectionId: body.connectionId ?? null, privacy: body.privacy,
      madeForKids: body.madeForKids === "1" || body.madeForKids === "true", consentVersion: YOUTUBE_CONSENT_VERSION, now: new Date(),
    });

    const jar = await cookies();
    jar.set(YOUTUBE_OAUTH_STATE_COOKIE, state, OAUTH_COOKIE_OPTS);
    jar.set(YOUTUBE_OAUTH_VERIFIER_COOKIE, verifier, OAUTH_COOKIE_OPTS);
    // 303: the answer to a POST that must be followed with a GET of Google's page.
    return NextResponse.redirect(authorizeUrl, 303);
  });
}
