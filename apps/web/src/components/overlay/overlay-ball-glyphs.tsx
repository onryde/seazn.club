/** Circular this-over ball chips for bar/bug detail bands. */
export function OverlayBallGlyphs({ glyphs }: { glyphs: readonly string[] }) {
  return (
    <span data-testid="ovl-ball-glyphs" className="ovl-ball-glyphs">
      {glyphs.map((g, i) => (
        <span
          key={`${g}-${i}`}
          data-testid="ovl-ball-glyph"
          className={`ovl-ball-glyph${g === "4" || g === "6" ? " ovl-ball-glyph--boundary" : ""}${g === "W" ? " ovl-ball-glyph--wicket" : ""}`}
        >
          {g}
        </span>
      ))}
    </span>
  );
}
