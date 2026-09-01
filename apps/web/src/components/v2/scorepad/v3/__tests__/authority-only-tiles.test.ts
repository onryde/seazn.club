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
import { builtinModules } from "@seazn/engine/sports";

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

// R7 / Task C review, item 5 — THE PREMISE THAT KEEPS THE MORE-SHEET BYPASS
// LATENT.
//
// `AUTHORITY_ONLY_EVENT_TYPES` is enforced inside `filterTilesByBand`, which
// covers the tile GRID. `dedicated` (`dedicatedEventTypes`) is built from the
// FILTERED tiles, so an event this block removes leaves that set too, and
// `moreActions` then has no reason to exclude it — a `padSpec`-declared
// authority action would surface in the More sheet as an un-narrowed generic
// form, past the band's sentence and past the Abandon confirmation.
//
// Nothing is broken today because no engine `padSpec` declares either type.
// That is a PREMISE, and a premise a future wave can retire without noticing,
// so it is a tripwire instead: this fails the day a module declares one, and
// points at `AUTHORITY_ONLY_EVENT_TYPES`' own doc for what then has to change.
describe("no engine padSpec declares an authority action (the More-sheet premise)", () => {
  /** A cfg every module accepts. `parse({})` is enough for most of them;
   *  `generic` requires `resultMode`/`allowDraws` and answers only to one of
   *  its own variants, so fall through those rather than hand-writing a cfg
   *  this file would then have to keep in step with the schema. Throws
   *  loudly rather than skipping — a module dropped from the sweep is exactly
   *  how an audit like this goes quietly vacuous. */
  function anyCfg(m: (typeof builtinModules)[number]): unknown {
    try {
      return m.configSchema.parse({});
    } catch {
      for (const variant of Object.values((m.variants ?? {}) as Record<string, unknown>)) {
        try {
          return m.configSchema.parse(variant);
        } catch {
          continue;
        }
      }
      throw new Error(`no resolvable cfg for module ${m.key} — the sweep would silently skip it`);
    }
  }

  const specs = builtinModules.map((m) => {
    // `padSpec` is optional on `SportModule` (it landed module by module).
    // Throwing rather than filtering, for the same reason `anyCfg` throws: a
    // module quietly dropped from an audit is how the audit goes vacuous.
    const build = m.padSpec;
    if (build === undefined) throw new Error(`module ${m.key} declares no padSpec`);
    // A variant cannot introduce a NEW action type — `padSpec` builds its
    // panels from a closed list per module and gates them with `PadGate` — so
    // one resolution per module is the whole universe of declared types here.
    return { key: m.key, spec: build.call(m, anyCfg(m) as never) };
  });

  const declaredTypes = specs.flatMap(({ key, spec }) =>
    spec.panels.flatMap((panel) => panel.actions.map((a) => ({ key, type: a.type }))),
  );

  it("sweeps every builtin module, and finds real actions in them", () => {
    // Guards the sweep itself: a `padSpec` shape change that silently yielded
    // no actions would make every claim below vacuously true.
    expect(specs.length, "every builtin module, none skipped").toBe(builtinModules.length);
    expect(specs.length).toBeGreaterThan(8);
    expect(declaredTypes.length).toBeGreaterThan(30);
    // Discriminating: the sweep really is reading event type strings, not a
    // list of empty objects.
    expect(declaredTypes.some((d) => d.type.includes("."))).toBe(true);
  });

  it("declares neither core.forfeit nor core.abandon in any panel", () => {
    const offenders = declaredTypes.filter((d) => AUTHORITY_ONLY_EVENT_TYPES.has(d.type));
    expect(
      offenders,
      "a padSpec-declared authority action reaches the More sheet un-narrowed — see AUTHORITY_ONLY_EVENT_TYPES' doc",
    ).toEqual([]);
  });
});
