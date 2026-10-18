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

// R2005 appends the three compositor scenes (spec §4.2), each with its `momentsFire` (§4.8): Starting soon fires (owner
// ruling D14, 2026-10-16 — a stream can start after the match has begun, and a goal scored before the first camera frame
// must still reach viewers), Reconnecting fires (the slab is the only way a viewer learns a goal happened), Final drops
// them (the deciding moment has already shown, and the Result card carries the outcome).
export const OVERLAY_SCENES = [
  { id: "live", labelKey: "stream.scene.live", momentsFire: true },
  { id: "starting", labelKey: "stream.scene.starting", momentsFire: true },
  { id: "reconnecting", labelKey: "stream.scene.reconnecting", momentsFire: true },
  { id: "final", labelKey: "stream.scene.final", momentsFire: false },
] as const satisfies readonly OverlaySceneDef[];

export type SceneId = (typeof OVERLAY_SCENES)[number]["id"];

/** Do moment slabs air in this scene? Read off the declaration above — the one authority (decision 8) — and never
 *  off a scene id. `null` is "no scene on screen" (an OBS page, or the compositor's `live`/`frozen`), where moments
 *  have always aired. An id the list does not declare is refused by name: a scene nobody declared has no rule. */
export function momentsFireIn(scene: SceneId | null): boolean {
  if (scene === null) return true;
  const def = OVERLAY_SCENES.find((s) => s.id === scene);
  if (def === undefined) throw new Error(`momentsFireIn: no scene ${JSON.stringify(scene)} is declared`);
  return def.momentsFire;
}
