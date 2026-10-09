import { describe, expect, it } from "vitest";
import { BRACKET_KINDS, StageKind } from "@seazn/engine/core";
import { generic } from "@seazn/engine/sports/generic";
import { buildTiles as bgTiles, DRAW_TILE_ID as BG_DRAW } from "../skins/boardgame";
import {
  buildScorebug as genericScorebug,
  buildTiles as genericTiles,
  DRAW_TILE_ID as GENERIC_DRAW,
  SETTLE_TILE_ID,
} from "../skins/generic";
import { liveView } from "./_views";

// W2a Task 12 (spec §5.5; X-DR-1, GN-KO-1; addendum 4 — the pad's stage kind is consumed, not discarded). A bracket
// kind forbids a level result, so the generic pad offers no way to record one there. Boardgame keeps its Draw in every
// kind while live (owner ruling D-P1: the drawn game IS the tie-break's entry) and hides it only while a decider is
// pending (boardgame-tiebreak.test.ts). Each sweep walks the engine's own `StageKind.options`, counts what it checked,
// and requires BOTH answers to be reached.

const echo = (k: string) => k;
const WIN_LOSS_DRAWS = { ...generic.variants.win_loss, allowDraws: true };
const SCORE_DRAWS = { ...generic.variants.score, allowDraws: true };
const LEVEL_TALLY = [
  { type: "core.start", payload: {} },
  { type: "generic.score", payload: { by: "H", points: 1 } },
  { type: "generic.score", payload: { by: "A", points: 1 } },
];

describe("the pad hides a level result in bracket kinds (spec §5.5; X-DR-1, GN-KO-1)", () => {
  it("empty case first: with no stage kind (a fixture with no stage) both pads behave as before W2a", () => {
    expect(bgTiles(liveView("boardgame", { stageKind: null }), echo).some((t) => t.id === BG_DRAW)).toBe(true);
    expect(genericTiles(liveView("generic", { stageKind: null, cfg: WIN_LOSS_DRAWS }), echo).some((t) => t.id === GENERIC_DRAW)).toBe(true);
  });

  it("boardgame (D-P1): Draw shows in EVERY stage kind while live — brackets included", () => {
    let checked = 0;
    for (const k of StageKind.options) {
      expect(bgTiles(liveView("boardgame", { stageKind: k }), echo).some((t) => t.id === BG_DRAW), k).toBe(true);
      checked++;
    }
    expect(checked).toBe(StageKind.options.length);
  });

  it("generic win_loss (allowDraws true): the Draw tile is absent in every bracket kind and present everywhere else", () => {
    let checked = 0;
    let shown = 0;
    for (const k of StageKind.options) {
      const has = genericTiles(liveView("generic", { stageKind: k, cfg: WIN_LOSS_DRAWS }), echo).some((t) => t.id === GENERIC_DRAW);
      expect(has, k).toBe(!BRACKET_KINDS.has(k));
      checked++;
      if (has) shown++;
    }
    expect(checked).toBe(StageKind.options.length);
    expect(shown, "both answers reached").toBe(StageKind.options.length - BRACKET_KINDS.size);
    expect(shown).toBeGreaterThan(0);
  });

  it("generic score mode: a LEVEL tally offers 'Finish from tally' only where a level result is allowed", () => {
    let checked = 0;
    let shown = 0;
    for (const k of StageKind.options) {
      const has = genericTiles(liveView("generic", { stageKind: k, cfg: SCORE_DRAWS, events: LEVEL_TALLY }), echo).some((t) => t.id === SETTLE_TILE_ID);
      expect(has, k).toBe(!BRACKET_KINDS.has(k));
      checked++;
      if (has) shown++;
    }
    expect(checked).toBe(StageKind.options.length);
    expect(shown).toBe(StageKind.options.length - BRACKET_KINDS.size);
    // The positive pair for "absent": an UNLEVEL tally finishes in a bracket too.
    const unlevel = [...LEVEL_TALLY, { type: "generic.score", payload: { by: "H", points: 1 } }];
    expect(genericTiles(liveView("generic", { stageKind: "knockout", cfg: SCORE_DRAWS, events: unlevel }), echo).some((t) => t.id === SETTLE_TILE_ID)).toBe(true);
  });

  it("generic context line says 'No draws' in a bracket and 'Draws allowed' outside, for the same cfg", () => {
    let checked = 0;
    for (const k of StageKind.options) {
      const context = genericScorebug(liveView("generic", { stageKind: k, cfg: SCORE_DRAWS }), echo).context;
      expect(context, k).toContain(BRACKET_KINDS.has(k) ? "pad.generic.context.noDraws" : "pad.generic.context.draws");
      checked++;
    }
    expect(checked).toBe(StageKind.options.length);
  });

  it("generic strip: a level tally is ACCENTED in a bracket (the state the match cannot finish from) and plain in a league", () => {
    const strip = (k: string) => genericScorebug(liveView("generic", { stageKind: k, cfg: SCORE_DRAWS, events: LEVEL_TALLY }), echo).strip;
    expect(strip("knockout")).toEqual([expect.objectContaining({ id: "margin", accent: true })]);
    expect(strip("league")[0]).toMatchObject({ id: "margin" });
    expect(strip("league")[0]!.accent).toBeUndefined();
  });
});
