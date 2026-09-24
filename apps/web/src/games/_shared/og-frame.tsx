// Shared pieces of the Seazn Games share images (app/games/opengraph-image.tsx
// and app/games/[slug]/opengraph-image.tsx). Design of record: the
// owner-approved games-canvas gen.py og_hub / og_game.
//
// Plain JSX, deliberately NOT importing next/og: the ImageResponse is built in
// the two route files, which share-image-surfaces.test.tsx derives and drives
// as satori surfaces. satori rules apply to everything here — flexbox only,
// every div `display: flex`, inline styles only.
//
// The night frame is the root share card's (app/opengraph-image.tsx), copied
// rather than imported: that file is a route module, not a library.

export const NIGHT = "#150b36";
const NIGHT2 = "#1d1145";
export const CREAM = "#f5f0e8";
export const LIME = "#a3e635";
/** Secondary copy on the night frame. */
export const CREAM_SOFT = "rgba(245,240,232,0.78)";
export const CREAM_FAINT = "rgba(245,240,232,0.66)";

/** Root style of a games share card: the stadium-night slab, full bleed. */
export const nightFrame = {
  width: "100%",
  height: "100%",
  display: "flex",
  color: CREAM,
  fontFamily: "sans-serif",
  backgroundColor: NIGHT,
  backgroundImage: `radial-gradient(720px 420px at 10% -10%, rgba(163,230,53,0.14), transparent 60%), radial-gradient(780px 460px at 90% -10%, rgba(124,58,237,0.30), transparent 62%), linear-gradient(180deg, ${NIGHT2}, ${NIGHT})`,
} as const;

/** The per-game card's art: a square this many px (gen.py og_game). */
export const GAME_CARD_ART = 430;

/** The hub card's row of game tiles (gen.py og_hub). */
export const HUB_TILES = {
  /** The row's width: the 1200px card (OG_SIZE — not imported: that module is
   *  server-only, and GameArt's tests read these sizes) less 64px each side. */
  rowWidth: 1200 - 2 * 64,
  gap: 28,
  border: 3,
  radius: 22,
  /** The mockup's tile, and so its aspect. */
  width: 320,
  height: 196,
} as const;

/**
 * The art size of each hub tile when `count` games are live: the mockup's
 * 320×196 while they fit the row, shrunk in proportion once they would not —
 * a fourth live game shrinks every tile rather than spilling off the card.
 */
export function hubTileSize(count: number): { width: number; height: number } {
  const { rowWidth, gap, border } = HUB_TILES;
  const fit = Math.floor((rowWidth - gap * (count - 1)) / count) - 2 * border;
  const width = Math.min(HUB_TILES.width, fit);
  return { width, height: Math.round((width * HUB_TILES.height) / HUB_TILES.width) };
}

/** "SEAZN GAMES" — the root card's wordmark with GAMES in lime. */
export function GamesWordmark({ size }: { size: number }) {
  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        gap: 12,
        fontSize: size,
        fontWeight: 700,
        letterSpacing: 6,
      }}
    >
      <div style={{ display: "flex" }}>SEAZN</div>
      <div style={{ display: "flex", color: LIME }}>GAMES</div>
    </div>
  );
}
