import { NextResponse } from "next/server";
import { HttpError } from "@/lib/errors";
import { handler } from "@/lib/http";
import { bearerOf } from "@/server/relay/bearer";
import { readCapped } from "@/server/relay/record-body";
import { AIRING_FRAME_MAX_BYTES, FrameStorageFailed, storeAiringFrame } from "@/server/sponsors/airings";

type Ctx = { params: Promise<{ sid: string; momentId: string }> };

/** The JPEG, or null once it runs past AIRING_FRAME_MAX_BYTES (inclusive). A Content-Length past the bound is refused
 *  before a byte is read; a body with no length is read no further than one chunk past the bound (`readCapped`). A body
 *  that cannot be read to its end — the client aborted mid-upload — is the CLIENT's failure: 400, never a 500 (this path
 *  runs no proxy, so the route reads the stream itself: S9 review m10). */
async function frameBody(req: Request): Promise<Uint8Array | null> {
  const declared = Number(req.headers.get("content-length") ?? "");
  if (Number.isFinite(declared) && declared > AIRING_FRAME_MAX_BYTES) return null;
  try {
    return await readCapped(req.body, AIRING_FRAME_MAX_BYTES);
  } catch {
    throw new HttpError(400, "the frame body could not be read to its end", "FRAME_BODY_UNREADABLE");
  }
}

/** POST …/airings/[momentId]/frame — R4 S9 (spec 2026-10-27 §3.6.3): the compositor's proof-of-play still, one JPEG per
 *  sponsor airing, posted 1.5 s after its `start` line (SC2, `HttpFrameUpload`). The relay JOB token as Bearer, the
 *  heartbeat's own: its PRESENCE is checked first (`bearerOf`, the same 401), then the body is read under its bound, and
 *  `storeAiringFrame` verifies the token before anything else — so every refused credential is the heartbeat's 401,
 *  whatever the body. 204 on success.
 *
 *  `momentId` is used AS GIVEN: SC2 percent-encodes it as one path segment (`12:sponsor.over_end` arrives as
 *  `12%3Asponsor.over_end`), and Next decodes each dynamic segment exactly once before the handler sees it
 *  (next/dist/shared/lib/router/utils/route-matcher.js, `getRouteMatcher` → decodeURIComponent). Decoding it again here
 *  would read a literal `%` id as another id, or throw on a lone `%`.
 *
 *  A storage failure (`FrameStorageFailed`) is answered HERE, in the handler's own envelope: the usecase has already
 *  reported it with its org and session (S9 carry), and the handler would capture it a second time with neither. */
export async function POST(req: Request, { params }: Ctx) {
  return handler(async () => {
    const { sid, momentId } = await params;
    const token = bearerOf(req);
    try {
      await storeAiringFrame(sid, token, momentId, await frameBody(req));
    } catch (err) {
      if (err instanceof FrameStorageFailed) {
        return NextResponse.json({ ok: false, error: err.message, code: err.code }, { status: err.status });
      }
      throw err;
    }
    return new Response(null, { status: 204 });
  });
}
