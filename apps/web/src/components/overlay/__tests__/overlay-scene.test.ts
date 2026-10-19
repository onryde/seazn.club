// R2005 A1 — the scene table (`sceneFor`), all 18 cells, TYPED from overlay templates spec 2026-10-15 §4.2 and the
// R2005 amendment's table — never read back from `overlay-scene.tsx`. Plus the preview override's phase mapping.
import { describe, expect, it } from "vitest";
import { PROGRAMME_PHASES, type ProgrammePhaseWire } from "@/lib/relay-phase";
import { phaseForScene, sceneFor, type SceneCard } from "../overlay-scene";
import { OVERLAY_SCENES, type SceneId } from "../overlay-scenes";
import type { SlateState } from "../overlay-slate";

type Cell = { scene: SceneId | null; card: SceneCard | null };
const SLATES: readonly SlateState[] = ["warming", "live", "ended"];

// phase \ slate → { scene, card }, verbatim from the amendment's table (each row's reason there).
const TABLE: ReadonlyArray<[ProgrammePhaseWire | null, Record<SlateState, Cell>]> = [
  [null, { warming: { scene: null, card: "upcoming" }, live: { scene: null, card: null }, ended: { scene: null, card: "result" } }],
  ["waiting", { warming: { scene: "starting", card: "upcoming" }, live: { scene: "starting", card: null }, ended: { scene: "starting", card: "result" } }],
  ["live", { warming: { scene: null, card: "upcoming" }, live: { scene: null, card: null }, ended: { scene: null, card: "result" } }],
  ["frozen", { warming: { scene: null, card: "upcoming" }, live: { scene: null, card: null }, ended: { scene: null, card: "result" } }],
  ["reconnecting", {
    warming: { scene: "reconnecting", card: "reconnecting" },
    live: { scene: "reconnecting", card: "reconnecting" },
    ended: { scene: "reconnecting", card: "result" },
  }],
  ["final", { warming: { scene: "final", card: "ended" }, live: { scene: "final", card: "ended" }, ended: { scene: "final", card: "result" } }],
];

describe("A1 — sceneFor(phase, slate): the 18 cells of spec §4.2", () => {
  it("every cell matches the spec's table (cells checked: 18)", () => {
    let checked = 0;
    for (const [phase, row] of TABLE) {
      for (const slate of SLATES) {
        expect(sceneFor(phase, slate), `${phase} × ${slate}`).toEqual(row[slate]);
        checked++;
      }
    }
    console.log(`cells checked: ${checked}`);
    expect(checked).toBe(18);
  });

  it("the table covers every programme phase plus null, and every slate state", () => {
    expect(TABLE.map(([p]) => p)).toEqual([null, ...PROGRAMME_PHASES]);
    expect(SLATES).toHaveLength(3);
  });

  it("a null phase (no host) never yields a scene, for any slate", () => {
    let checked = 0;
    for (const slate of SLATES) {
      expect(sceneFor(null, slate).scene, slate).toBeNull();
      checked++;
    }
    expect(checked).toBeGreaterThan(0);
  });

  it("only one card at a time: a scene picks at most one card, and the card is never undefined", () => {
    for (const [phase] of TABLE) for (const slate of SLATES) expect(sceneFor(phase, slate).card).not.toBeUndefined();
  });
});

describe("the preview's sceneOverride, as a phase", () => {
  it("each declared scene maps to the phase that shows it; `live` means no scene whatever the slate", () => {
    const EXPECTED: Record<SceneId, ProgrammePhaseWire> = { live: "live", starting: "waiting", reconnecting: "reconnecting", final: "final" };
    let checked = 0;
    for (const def of OVERLAY_SCENES) {
      expect(phaseForScene(def.id), def.id).toBe(EXPECTED[def.id]);
      for (const slate of SLATES) {
        const shown = sceneFor(phaseForScene(def.id), slate).scene;
        expect(shown, `${def.id} × ${slate}`).toBe(def.id === "live" ? null : def.id);
      }
      checked++;
    }
    console.log(`scenes checked: ${checked}`);
    expect(checked).toBe(4);
  });
});
