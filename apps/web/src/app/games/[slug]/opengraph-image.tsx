// /games/<slug> share card — the preview of a game link (Daily Word's share
// button posts exactly such links). Design of record: owner-approved
// games-canvas gen.py og_game — night slab; wordmark, huge title, tagline and
// a "Play free" pill on the left; the game's own GameArt, tilted, on the right.
//
// Type is the default next/og face (Geist Regular), like the root card — no
// font is fetched or vendored. Geist is far wider than the mockup's Barlow
// Condensed, so the title is sized to fit the 596px column and wraps onto a
// second line for a two-word title rather than running under the art.
import { ImageResponse } from "next/og";
import { notFound } from "next/navigation";
import { OG_SIZE } from "@/server/og/card";
import { GameArt } from "@/games/_shared/game-art";
import { CREAM_SOFT, GAME_CARD_ART, GamesWordmark, LIME, NIGHT, nightFrame } from "@/games/_shared/og-frame";
import { getGame, liveGames } from "@/games/registry";
import HubImage from "../opengraph-image";

export const alt = "Seazn Games — play free in your browser. No sign-up, no ads.";
export const size = OG_SIZE;
export const contentType = "image/png";

type Props = { params: Promise<{ slug: string }> };

/** Every live game's card is drawn once, at build — the registry is static. */
export function generateStaticParams() {
  return liveGames().map(({ slug }) => ({ slug }));
}

export default async function Image({ params }: Props) {
  const { slug } = await params;
  const game = getGame(slug);
  // An unknown slug is a 404, like its page: /games/<unknown> 404s and its
  // <meta> advertises the ROOT share image, not this one, so nothing
  // legitimate links here. (Next's route handler answers notFound() with an
  // empty 404.)
  if (!game) notFound();
  // A coming-soon game has a real page but no art yet, and "Play free" would
  // be untrue: its link previews as the /games hub card instead.
  if (game.status !== "live") return HubImage();

  return new ImageResponse(
    (
      <div style={nightFrame}>
        <div
          style={{
            display: "flex",
            flexDirection: "column",
            justifyContent: "space-between",
            width: 660,
            padding: "52px 0 52px 64px",
          }}
        >
          <GamesWordmark size={26} />
          <div style={{ display: "flex", flexDirection: "column", gap: 18 }}>
            <div style={{ display: "flex", fontSize: 96, fontWeight: 800, lineHeight: 0.95 }}>
              {game.title.toUpperCase()}
            </div>
            <div style={{ display: "flex", fontSize: 30, lineHeight: 1.35, color: CREAM_SOFT }}>
              {game.tagline}
            </div>
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: 14, fontSize: 24 }}>
            <div
              style={{
                display: "flex",
                background: LIME,
                color: NIGHT,
                fontWeight: 700,
                padding: "10px 20px",
                borderRadius: 999,
              }}
            >
              Play free
            </div>
            <div style={{ display: "flex", color: CREAM_SOFT }}>No sign-up. No ads.</div>
          </div>
        </div>

        <div style={{ display: "flex", flexGrow: 1, alignItems: "center", justifyContent: "center" }}>
          <div
            style={{
              display: "flex",
              transform: "rotate(-5deg)",
              borderRadius: 32,
              border: "4px solid rgba(245,240,232,0.18)",
              boxShadow: "0 30px 60px rgba(0,0,0,0.45)",
            }}
          >
            {/* No overflow:hidden anywhere under the tilt: satori applies the
                rotation to a clip path twice for the clipped children, which
                cut the board along a steeper edge than its frame's. The art
                draws its own rounded panel at the border's inner curve
                (32 - 4 = 28) and never overflows it. */}
            <GameArt slug={game.slug} width={GAME_CARD_ART} height={GAME_CARD_ART} radius={28} />
          </div>
        </div>
      </div>
    ),
    size,
  );
}
