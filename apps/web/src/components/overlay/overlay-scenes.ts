// The overlay's scenes (spec 2026-10-15 §4.1–4.3 and §4.8; R2007 ships the list, R2005 the scene layer).
//
// A scene is a page layer ABOVE every template, so every template supports every scene by construction — which is why
// the registry carries no `scenes` field (R2007 decision 3, a resolved spec ambiguity: §4.4 says the registry carries
// "the scenes it supports"; §4.7's contract table, the later and more exact section, does not list it). The gallery's
// readability and safe-area sweeps run every scene × every template, so each scene R2005 appends is covered with no
// gallery edit.

/** Decision 8: `momentsFire` is the one authority for whether moment slabs show in a scene (D14, §4.8). The gallery's
 *  moment cells read it now, and R2005's stage discard rule reads the same field. */
export interface OverlaySceneDef {
  id: string;
  /** `ui` namespace; 4 locales. */
  labelKey: string;
  momentsFire: boolean;
}

// R2005 appends starting (true, D14), reconnecting (true, §4.8) and final (false, §4.8).
export const OVERLAY_SCENES = [
  { id: "live", labelKey: "stream.scene.live", momentsFire: true },
] as const satisfies readonly OverlaySceneDef[];

export type SceneId = (typeof OVERLAY_SCENES)[number]["id"];
