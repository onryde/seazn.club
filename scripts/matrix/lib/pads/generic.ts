// generic: the bench's genericAdapter (ruling 38), plus the one route it leaves
// owed, the win_loss draw. The pad writes a win_loss draw with its draw tile:
// generic.tsx:417 declares DRAW_TILE_ID and :512 builds the tile. Step 0 item 4
// (2026-09-30) saw the tile offered only with allowDraws on, and it wrote
// `generic.result {isDraw: true}`, exactly that key, at once.
import { genericAdapter } from "../../../bench/lib/drivers/adapters/generic.ts";
import type { MatrixPadAdapter } from "./types.ts";

/** generic.tsx:417 (text-pinned in pad-adapters.test.ts). */
export const GENERIC_DRAW_TILE_ID = "draw";

/** Exactly `{isDraw: true}`: the matrix's win_loss draw (streams/generic.ts). */
function isBareDraw(payload: unknown): boolean {
  if (typeof payload !== "object" || payload === null || Array.isArray(payload)) return false;
  const p = payload as Record<string, unknown>;
  return Object.keys(p).length === 1 && p.isDraw === true;
}

export const genericPad: MatrixPadAdapter = {
  sport: "generic",
  emits: ["core.start", "generic.result"],
  fallbacks: [],
  stepsFor(event, ctx) {
    if (event.type === "generic.result" && isBareDraw(event.payload)) return [{ kind: "tile", tileId: GENERIC_DRAW_TILE_ID }];
    return genericAdapter.stepsFor(event, ctx);
  },
  tolerableExtraKeys: (t) => genericAdapter.tolerableExtraKeys?.(t) ?? [],
};
