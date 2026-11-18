// The corner brand badge (owner, 2026-11-17): "Powered by" + the Seazn Club logo, bottom-right on every template and
// every scene, with a small match timer to its left while a match is in play.
//
// Presentational: the stage decides the timer's reading (`use-match-elapsed.ts`) and hands it in as a string, exactly as
// it hands the header clock to the model. The box is the registry's (`BRAND_BADGE_BOX`), never a number typed here.
import type { OverlayMsg } from "@/lib/overlay-model";
import { BRAND_BADGE_BOX } from "./template-registry";

/** The product's name: a proper noun, the same in every locale, and the logo's text alternative. */
const BRAND_NAME = "Seazn Club";

export function OverlayBrandBadge(props: { msg: OverlayMsg; elapsed: string | null }): React.ReactElement {
  return (
    <div
      data-testid="ovl-badge"
      className="ovl-badge"
      style={{
        left: `${BRAND_BADGE_BOX.x}px`,
        top: `${BRAND_BADGE_BOX.y}px`,
        width: `${BRAND_BADGE_BOX.width}px`,
        height: `${BRAND_BADGE_BOX.height}px`,
      }}
    >
      {props.elapsed === null ? null : (
        <span data-testid="ovl-badge-timer" className="ovl-badge-timer ovl-display">{props.elapsed}</span>
      )}
      <span className="ovl-badge-plate">
        <span className="ovl-badge-by">{props.msg("overlay.poweredBy")}</span>
        {/* A plain <img>: the overlay is a 1920×1080 canvas scaled as a whole, so `next/image`'s responsive sizes have
            nothing to choose between, and the logo must paint on the first frame of a broadcast. */}
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img className="ovl-badge-logo" src="/brand/seazn-logo-night-tight.png" alt={BRAND_NAME} width={130} height={30} />
      </span>
    </div>
  );
}
