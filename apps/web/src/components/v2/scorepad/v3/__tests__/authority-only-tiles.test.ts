// R7 / Task C, C2 — the OTHER half of D-12: the tile-hierarchy convention.
//
// "Forfeit/Abandon are not representable in the tile grid" has been a
// convention stated in prose since R1, with no type and no runtime block
// (`_INDEX.md`: "Skin-level validation owes the enforcement"). Nothing has
// enforced it; cricket, football and the racquet skins simply never declared
// such a tile, which is not the same thing as the chassis refusing one.
//
// Console chrome is where the enforcement belongs because console chrome is
// where those two events LIVE: R7/C2 gives them a labelled band, below the
// pad and below the ledger, with a sentence saying they end the match record.
// A tile that reached the same event from inside the scoring grid would put
// the most destructive action in the product one thumb-width from a rally
// tap — the exact hierarchy failure D-12 names — and it would bypass both
// the sentence and the Abandon confirmation the band forces.
//
// The block is fail-CLOSED, and it is the one clause in `filterTilesByBand`
// that is: everything else there fails OPEN on purpose (an unclassifiable
// tile is shown, because a scorer can report a refusal but cannot report a
// button that was never drawn). That reasoning does not transfer here. A
// tile we cannot classify is a nuisance; a Forfeit tile a scorer taps by
// mistake ends someone's match.
import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { AUTHORITY_ONLY_EVENT_TYPES, filterTilesByBand } from "../pad-host";
import type { GuidedSheetSpec, SwapSlot, TileSpec } from "../types";
import type { FidelityBand, PadSpec } from "@seazn/engine/sport";

function tile(id: string, action: TileSpec["action"]): TileSpec {
  return { id, label: `l.${id}`, kind: "standard", phases: ["live"], action };
}

/** Empty on purpose: with no `fidelity` entry every tile below is KEPT by
 *  the band rule (it fails open), so anything that disappears disappeared
 *  because of the authority block and nothing else. */
const NO_FIDELITY: PadSpec["fidelity"] = {};
const ALL_BANDS: ReadonlySet<FidelityBand> = new Set<FidelityBand>([0, 1, 2, 3]);

const SHEETS: Record<string, GuidedSheetSpec> = {
  forfeitSheet: { event: "core.forfeit", steps: [], buildPayload: () => ({}) },
  goalSheet: { event: "football.goal", steps: [], buildPayload: () => ({}) },
};

const SWAPS: readonly SwapSlot[] = [
  { id: "bail", offLabel: "o", onLabel: "n", side: "home", eventType: "core.abandon" },
  { id: "sub", offLabel: "o", onLabel: "n", side: "home", eventType: "football.sub" },
] as unknown as readonly SwapSlot[];

function kept(tiles: readonly TileSpec[]): string[] {
  return filterTilesByBand(tiles, SHEETS, SWAPS, NO_FIDELITY, ALL_BANDS).map((t) => t.id);
}

describe("the tile grid cannot represent an authority action (D-12)", () => {
  it("names exactly the two the console's Match actions band owns", () => {
    expect([...AUTHORITY_ONLY_EVENT_TYPES].sort()).toEqual(["core.abandon", "core.forfeit"]);
  });

  it("drops a tile that dispatches core.forfeit or core.abandon directly", () => {
    expect(
      kept([
        tile("goal", { event: { type: "football.goal", payload: {} } }),
        tile("forfeit", { event: { type: "core.forfeit", payload: {} } }),
        tile("abandon", { event: { type: "core.abandon", payload: {} } }),
      ]),
      "the scoring tile stays; the two that end a match never render",
    ).toEqual(["goal"]);
  });

  it("drops one reached through a guided SHEET, not just a direct event", () => {
    expect(kept([tile("goalSheet", { sheet: "goalSheet" }), tile("ff", { sheet: "forfeitSheet" })])).toEqual([
      "goalSheet",
    ]);
  });

  it("drops one reached through a SWAP slot's declared event type", () => {
    expect(kept([tile("sub", { swap: "sub" }), tile("bail", { swap: "bail" })])).toEqual(["sub"]);
  });

  it("keeps every other core.* event — this is a closed pair, not a ban on core", () => {
    // `core.note` and `core.award` in particular: a skin may legitimately put
    // either on a tile, and the panel's own void allowlist already treats them
    // as the safe ones.
    expect(
      kept([
        tile("note", { event: { type: "core.note", payload: {} } }),
        tile("award", { event: { type: "core.award", payload: {} } }),
        tile("start", { event: { type: "core.start", payload: {} } }),
      ]),
    ).toEqual(["note", "award", "start"]);
  });
});

describe("no shipped skin violates the convention today", () => {
  // A parity sweep, not a spot check: the block above exists so a FUTURE
  // skin cannot, and this proves adding it took nothing away from the eleven
  // that already ship. Reads the skin sources rather than building each
  // skin's `tiles(view)`, because a skin's tile set is view-dependent and
  // "no source anywhere in this file names the type" is the stronger claim.
  const dir = join(process.cwd(), "src/components/v2/scorepad/v3/skins");
  const files = readdirSync(dir).filter((f) => f.endsWith(".tsx") || f.endsWith(".ts"));

  it("finds skins to sweep — an empty sweep would pass vacuously", () => {
    expect(files.length).toBeGreaterThan(3);
  });

  it.each(files)("%s declares no core.forfeit / core.abandon tile", (file) => {
    const src = readFileSync(join(dir, file), "utf8");
    for (const type of AUTHORITY_ONLY_EVENT_TYPES) {
      // Prose in a comment is fine and several skins have it; a declaration
      // is not. Both forms a tile can reach the type by are quoted strings.
      const declared = new RegExp(`(type|event|eventType)\\s*:\\s*["']${type.replace(".", "\\.")}["']`);
      expect(declared.test(src), `${file} declares ${type} in a tile-reachable position`).toBe(false);
    }
  });
});
