// /games share card — every WhatsApp/iMessage/X preview of the games listing
// (and, as the fallback, of an unknown or not-yet-live game: see
// [slug]/opengraph-image.tsx). Design of record: owner-approved games-canvas
// gen.py og_hub — the root card's night slab, the SEAZN GAMES wordmark, the
// promise, and one art tile per LIVE game, straight from the registry.
//
// Type is the default next/og face (Geist Regular), like the root card — no
// font is fetched or vendored. The mockup set the headline in Barlow
// Condensed at 96/64px; Geist is far wider, so the two lines are sized down
// until the longer one fits the 1072px content box.
import { ImageResponse } from "next/og";
import { OG_SIZE } from "@/server/og/card";
import { GameArt } from "@/games/_shared/game-art";
import { CREAM_FAINT, GamesWordmark, LIME, nightFrame } from "@/games/_shared/og-frame";
import { liveGames } from "@/games/registry";

export const alt = "Seazn Games — free games in your browser. No install, no sign-up, no ads.";
export const size = OG_SIZE;
export const contentType = "image/png";

const PAD_X = 64;
const CONTENT_W = OG_SIZE.width - 2 * PAD_X;
const TILE_GAP = 28;
const TILE_BORDER = 3;
const TILE_RADIUS = 22;
/** The mockup's tile, and its aspect. */
const TILE_W = 320;
const TILE_H = 196;

export default function Image() {
  const games = liveGames();
  // Three tiles at the mockup's 320px fill the row; a fourth live game shrinks
  // them all rather than spilling off the card.
  const fit = Math.floor((CONTENT_W - TILE_GAP * (games.length - 1)) / games.length) - 2 * TILE_BORDER;
  const tileW = Math.min(TILE_W, fit);
  const tileH = Math.round((tileW * TILE_H) / TILE_W);

  return new ImageResponse(
    (
      <div
        style={{
          ...nightFrame,
          flexDirection: "column",
          justifyContent: "space-between",
          padding: `52px ${PAD_X}px`,
        }}
      >
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
          <GamesWordmark size={30} />
          <div style={{ display: "flex", fontSize: 24, color: CREAM_FAINT }}>seazn.club/games</div>
        </div>

        <div style={{ display: "flex", flexDirection: "column", gap: 10, fontWeight: 800, lineHeight: 1 }}>
          <div style={{ display: "flex", fontSize: 64 }}>FREE GAMES IN YOUR BROWSER.</div>
          <div style={{ display: "flex", fontSize: 40, color: LIME }}>NO INSTALL. NO SIGN-UP. NO ADS.</div>
        </div>

        <div style={{ display: "flex", gap: TILE_GAP }}>
          {games.map((g) => (
            <div
              key={g.slug}
              style={{
                display: "flex",
                borderRadius: TILE_RADIUS,
                border: `${TILE_BORDER}px solid rgba(245,240,232,0.14)`,
                boxShadow: "0 18px 40px rgba(0,0,0,0.35)",
              }}
            >
              {/* No overflow:hidden here: the art draws its own panel at the
                  frame's INNER curve. A clip on this frame let a pixel of
                  square corner show past the curve. */}
              <GameArt slug={g.slug} width={tileW} height={tileH} radius={TILE_RADIUS - TILE_BORDER} />
            </div>
          ))}
        </div>
      </div>
    ),
    size,
  );
}
