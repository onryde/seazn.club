"use client";
// The shared preview render (R2007; spec 2026-10-15 §4.8): the ONE path a non-broadcast surface draws an overlay
// through. The staff gallery uses it now and R2006's template picker must use it too, so what a staff member signs off
// and what an organiser picks are the same render.
//
// It lifts the organiser console's preview pattern (`fixture-stream-panel.tsx`'s strip): the authored 1920×1080 canvas,
// scaled from the top-left into a box whose height is width × 1080 / 1920, so the whole frame is visible at every size
// and never a crop. It renders THE stage — not a picture of it — with `snapshotOnly`, so no request ever leaves the page
// (a sample snapshot's fixture id does not exist), and `realtime={false}` with no purpose or key, so no token is minted.
import type { OverlayLiveData } from "@/components/public-site/live-score-data";
import type { OverlayMoment } from "@/lib/overlay-moments";
import type { OverlaySideInput } from "@/lib/overlay-model";
import type { DecidedOutcomeTemplates } from "@/lib/scoring-vocab";
import { OverlayStage } from "./overlay-stage";
import type { SceneId } from "./overlay-scenes";
import type { TemplateId } from "./template-registry";

const CANVAS_W = 1920;
const CANVAS_H = 1080;

export interface OverlayPreviewProps {
  template: TemplateId;
  sportKey: string;
  scene: SceneId;
  snapshot: OverlayLiveData;
  sides: [OverlaySideInput, OverlaySideInput];
  startLabel: string | null;
  dict: Record<string, string>;
  decidedTemplates: DecidedOutcomeTemplates;
  /** The card's context pill (competition · stage), as the broadcast page passes it. */
  slateMeta?: { competition?: string; stage?: string };
  /** A slab to show statically (gallery moment cells). */
  moment?: OverlayMoment;
  /** Rendered frame width in CSS px; the height is width × 1080 / 1920. */
  frameWidth: number;
}

export function OverlayPreview(props: OverlayPreviewProps) {
  const scale = props.frameWidth / CANVAS_W;
  return (
    <div
      data-testid="ovl-preview"
      data-template={props.template}
      data-scene={props.scene}
      className="relative overflow-hidden"
      style={{ width: props.frameWidth, height: (props.frameWidth * CANVAS_H) / CANVAS_W }}
    >
      <div
        data-testid="ovl-preview-canvas"
        className="absolute left-0 top-0"
        style={{ width: CANVAS_W, height: CANVAS_H, transform: `scale(${scale})`, transformOrigin: "top left" }}
      >
        <OverlayStage
          // The fixture id names the cell, never a real fixture: `snapshotOnly` means it is never fetched.
          fixtureId={`preview-${props.template}-${props.sportKey}`}
          initial={props.snapshot}
          realtime={false}
          snapshotOnly
          sportKey={props.sportKey}
          style={props.template}
          sides={props.sides}
          startLabel={props.startLabel}
          dict={props.dict}
          decidedTemplates={props.decidedTemplates}
          // R2005: the cell's scene reaches the stage (preview-only prop; the overlay page never sets it).
          sceneOverride={props.scene}
          {...(props.slateMeta ? { slateMeta: props.slateMeta } : {})}
          {...(props.moment ? { pinnedMoment: props.moment } : {})}
        />
      </div>
    </div>
  );
}
