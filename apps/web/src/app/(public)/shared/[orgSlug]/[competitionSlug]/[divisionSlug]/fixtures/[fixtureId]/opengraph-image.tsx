// The fixture share card — now the design board's Poster A at OG proportions,
// so pasting a match link into a group chat unfurls the same picture the
// `Poster` button downloads. Upcoming, live and result are three fills of one
// layout; see `server/og/match-poster.tsx` for the slot table.
import { ImageResponse } from "next/og";
import { MatchPoster, OG_SIZE } from "@/server/og/match-poster";
import { loadMatchPosterModel } from "@/server/og/match-poster-data";

export const size = OG_SIZE;
export const contentType = "image/png";
export const revalidate = 60; // fixtures move faster than tables

type Props = {
  params: Promise<{
    orgSlug: string;
    competitionSlug: string;
    divisionSlug: string;
    fixtureId: string;
  }>;
};

export default async function Image({ params }: Props) {
  const { orgSlug, competitionSlug, divisionSlug, fixtureId } = await params;
  const model = await loadMatchPosterModel(orgSlug, competitionSlug, divisionSlug, fixtureId);
  // A metadata image route has no 404 — it must return an image or the page's
  // own <meta> points at a broken URL. An unresolvable fixture gets the plain
  // court slab with the wordmark, which is what the link is worth.
  if (!model) {
    return new ImageResponse(
      (
        <div
          style={{
            width: "100%",
            height: "100%",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            background: "#231738",
            color: "#f7f5fb",
            fontSize: 56,
            fontWeight: 800,
            fontFamily: "sans-serif",
          }}
        >
          seazn.club
        </div>
      ),
      size,
    );
  }
  return new ImageResponse(<MatchPoster model={model} size="og" />, size);
}
