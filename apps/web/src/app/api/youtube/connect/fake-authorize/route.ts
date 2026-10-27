import { NextResponse } from "next/server";
import { HttpError } from "@/lib/errors";
import { handler } from "@/lib/http";
import { youtubeDriver, youtubeFakeRoutesEnabled } from "@/server/youtube/driver";
import { isFakeYouTube } from "@/server/youtube/fake";
import { YouTubeError } from "@/server/youtube/port";

const NOT_FOUND = "Not found";

/** GET /api/youtube/connect/fake-authorize?state=… — Google's consent screen and redirect, for CI: the fake driver's
 *  `authorizeUrl` points here, and this hop answers the way Google does after consent — a 303 back to the redirect URI the
 *  authorize request carried, with a fresh single-use `code` and the same `state`.
 *
 *  404 unless YOUTUBE_DRIVER is fake AND ENV_NAME is local or ci (driver.ts `youtubeFakeRoutesEnabled`, the gate the control
 *  route uses), checked BEFORE the query is read: a deployment that names itself stg or prod cannot mint a code here even if its
 *  mode were set wrong. No auth, like the control route — it exists nowhere a real channel does.
 *
 *  The destination is the redirect URI the fake RECORDED for this state, never one the query names (a `redirect_uri` parameter
 *  is ignored, as Google ignores one that is not registered): this hop is not an open redirect. */
export async function GET(req: Request) {
  return handler(async () => {
    if (!youtubeFakeRoutesEnabled(process.env)) throw new HttpError(404, NOT_FOUND);
    const fake = youtubeDriver();
    if (!isFakeYouTube(fake)) throw new HttpError(404, NOT_FOUND);
    const state = new URL(req.url).searchParams.get("state");
    if (!state) throw new HttpError(400, "Missing state");
    try {
      const back = new URL(fake.redirectUriOf(state));
      back.searchParams.set("code", fake.issueCode(state));
      back.searchParams.set("state", state);
      return NextResponse.redirect(back, 303);
    } catch (err) {
      // An unknown state is the one refusal the fake can make; it holds no part of the request.
      if (err instanceof YouTubeError && err.code === "youtube_not_found") throw new HttpError(404, NOT_FOUND);
      throw err;
    }
  });
}
