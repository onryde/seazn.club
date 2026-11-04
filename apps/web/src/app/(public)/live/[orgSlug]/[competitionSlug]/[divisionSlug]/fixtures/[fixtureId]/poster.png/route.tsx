// The downloadable match poster (Spectator Surface Boards §poster, Option A) —
// 1080×1350 portrait, the shape a phone posts to a story or drops into a group
// chat. Same model and same layout as the fixture's OG card, just the board's
// own proportions; the `Poster` button beside `Share` links straight here.
//
// No `contentType` export: that is a metadata-file convention
// (opengraph-image / icon), not a Route Handler one — Next rejects it on a
// route module and `ImageResponse` sets `content-type: image/png` itself.
// Same rail as `news/[postSlug]/story.png`.
import { ImageResponse } from "next/og";
import { MatchPoster, POSTER_SIZE, posterImageInit } from "@/server/og/match-poster";
import { loadMatchPosterModel } from "@/server/og/match-poster-data";
import { posterFileName } from "@/lib/poster-file-name";

export const revalidate = 60; // a live match's poster is worth re-cutting

type Ctx = {
  params: Promise<{
    orgSlug: string;
    competitionSlug: string;
    divisionSlug: string;
    fixtureId: string;
  }>;
};

export async function GET(_req: Request, { params }: Ctx) {
  const { orgSlug, competitionSlug, divisionSlug, fixtureId } = await params;
  const model = await loadMatchPosterModel(orgSlug, competitionSlug, divisionSlug, fixtureId);
  // Unlike the OG card this IS a plain route, so a missing fixture can say so
  // rather than hand back a picture of nothing.
  if (!model) return new Response("not found", { status: 404 });

  const image = new ImageResponse(<MatchPoster model={model} size="poster" />, await posterImageInit(POSTER_SIZE));
  // `ImageResponse` is a Response whose headers already carry the content type
  // and the cache policy; re-emit its body with the disposition added rather
  // than replacing a header set we do not own.
  const headers = new Headers(image.headers);
  headers.set(
    "content-disposition",
    `attachment; filename="${posterFileName(model.sides[0].name, model.sides[1].name)}"`,
  );
  return new Response(image.body, { status: image.status, headers });
}
