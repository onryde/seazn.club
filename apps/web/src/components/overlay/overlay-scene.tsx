"use client";
// The compositor's scene layer (R2005; overlay templates spec 2026-10-15 §4.1–4.2, D4, D8).
//
// It mounts in exactly TWO cases (review I6): the page with `host=compositor`, where the phase comes from the channel
// (`use-programme-phase.ts`), and the preview render (`OverlayPreview`, R2007) through the stage's `sceneOverride`. The
// overlay PAGE never sets `sceneOverride`, so an OBS URL shows no scene: OBS users have their own.
//
// Z-ORDER (a resolved spec ambiguity, recorded): §4.1's diagram draws the scene layer on top, but §4.1 also says the
// score bug "stays visible over every scene" and is "never covered by a scene card". Both hold only if the BACKDROP sits
// below the template and the scene CARD sits above the backdrop, outside the template's `sceneCardSafeArea` — which is
// where the card layer already puts its card (R2007 step 9b). The slab sits above the card (§4.8).
//
// ONE CARD AT A TIME: when a scene is active, the scene picks the card and the card layer renders nothing else, so two
// cards can never stack. `sceneFor` returns the one card; the stage mounts only that.
import type { ProgrammePhaseWire } from "@/lib/relay-phase";
import type { SceneId } from "./overlay-scenes";
import type { SlateState } from "./overlay-slate";

/** The card the stage shows: the card layer's two (Upcoming, Result) and the two R2005 adds (Reconnecting, Stream
 *  ended). */
export type SceneCard = "upcoming" | "result" | "reconnecting" | "ended";

export interface SceneDecision {
  /** The scene on screen (its backdrop), or null for none. */
  scene: SceneId | null;
  card: SceneCard | null;
}

/** Today's card layer, unchanged (spec §4.2's last row): Upcoming before play, Result once decided, nothing live. */
function cardLayer(slate: SlateState): SceneCard | null {
  if (slate === "warming") return "upcoming";
  if (slate === "ended") return "result";
  return null;
}

/**
 * The scene table (spec §4.2; R2005 amendment 2026-10-15). `phase` is the channel's (null with no host); `slate` is
 * `slateStateOf(model)`.
 *
 *  - null (no host), `live`, `frozen`: no scene, today's card layer. `frozen` is a short glitch, which never flashes a
 *    card.
 *  - `waiting`: Starting soon, with "the matching existing card, so the card layer's rules still apply" — and with the
 *    match already in play, no card at all: the night backdrop with the score bug on it (a resolved ambiguity).
 *  - `reconnecting`: the Reconnecting card — or, once the match is decided, the Result card on the backdrop (§5).
 *  - `final`: the Result card when decided or void, otherwise the Stream ended card with the current score.
 */
export function sceneFor(phase: ProgrammePhaseWire | null, slate: SlateState): SceneDecision {
  switch (phase) {
    case null:
    case "live":
    case "frozen":
      return { scene: null, card: cardLayer(slate) };
    case "waiting":
      return { scene: "starting", card: cardLayer(slate) };
    case "reconnecting":
      return { scene: "reconnecting", card: slate === "ended" ? "result" : "reconnecting" };
    case "final":
      return { scene: "final", card: slate === "ended" ? "result" : "ended" };
  }
}

/** A preview's `sceneOverride` as the phase that shows it. `live` means NO scene whatever the phase (amendment
 *  2026-10-15), which the `live` phase already is. */
export function phaseForScene(scene: SceneId): ProgrammePhaseWire {
  switch (scene) {
    case "live":
      return "live";
    case "starting":
      return "waiting";
    case "reconnecting":
      return "reconnecting";
    case "final":
      return "final";
  }
}

/** The opaque night backdrop (spec §4.2, D8: "a branded night backdrop", house theme): the stadium-night plate across
 *  the whole canvas, floodlit from above. Textless — every word on a scene belongs to its card, which sits above. It
 *  renders BEFORE the template in the canvas, so the score bug paints over it. */
export function OverlaySceneBackdrop({ scene }: { scene: SceneId }) {
  return <div data-testid="ovl-scene" data-scene={scene} className="ovl-scene" aria-hidden="true" />;
}
