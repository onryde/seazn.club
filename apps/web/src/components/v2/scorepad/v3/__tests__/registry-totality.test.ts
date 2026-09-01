// R1 chassis (Task 2) — the totality gate: every engine sport key must
// resolve to a v3 skin (V3_SKINS), never nothing. R1 converted no sports:
// V3_SKINS was empty and every real call fell through to a `LEGACY_SPORTS`
// table that routed to the now-demolished v2/universal renderer
// (../../registry.tsx's own header has the full record). Waves R2 through
// R7/A3 (carrom, 2026-08-31) moved one sport at a time into V3_SKINS until
// it named all eleven `builtinModules` keys; R8 (this task) deleted
// `LEGACY_SPORTS`, its `CONVERTED_SPORTS` companion, and the "legacy"
// resolution arm outright — with every key already owned by `V3_SKINS`,
// that branch had been provably unreachable since R7/A3. This gate's job
// narrows to what's left: turn "a 12th engine sport ships with no skin" (or
// a synthetic unowned key) into a CI failure instead of a silent
// fallthrough.
// Mutation-proved in task-2-report.md (R1, the empty-registry shape), again
// for R2/task E's flip (cricket), and again here for the R8 discharge — see
// task-A-report.md for the pasted reds.
import { describe, it, expect } from "vitest";
// Scout re-pin (2026-08-16): the engine's canonical sport-key source is
// `builtinModules`, imported exactly as registry.test.tsx:11 already does —
// NOT a hand-copied list of the 11 sport names.
import { builtinModules } from "@seazn/engine/sports";
import { V3_SKINS, resolvePad } from "../registry";
import type { SkinDefV3 } from "../types";
import { cricketSkinV3 } from "../skins/cricket";
import { footballSkinV3 } from "../skins/football";
import { tennisSkinV3 } from "../skins/tennis";

// A dummy, no-op translator. Every test in this file cares only about LANE
// resolution (v3 vs throw) or the TYPE shape of what V3_SKINS/resolvePad
// accept — never about a resolved skin's own copy — so nothing here needs a
// real dictionary.
const T = (key: string): string => key;

describe("registry totality", () => {
  it("every engine sport resolves to a real v3 skin, from V3_SKINS' own factory", () => {
    // Task 11 fix batch (deferred from Task 2's review): this gate has no
    // floor assertion on its own key source — an empty `builtinModules`
    // import would skip the loop below entirely and still report a
    // passing run, indistinguishable from a real green. Mitigated only by
    // a DIFFERENT file (registry.test.tsx:87) today; this line makes the
    // gate self-contained.
    expect(builtinModules.length).toBeGreaterThan(0);
    for (const m of builtinModules) {
      const key = m.key;
      expect(key in V3_SKINS, `${key} not owned by V3_SKINS`).toBe(true);
      // Drives the REAL factory, not just membership — a mismatched or
      // half-wired factory (the wrong sport's skin assigned to this key)
      // still reds here even though `key in V3_SKINS` alone would not
      // catch it.
      const skin = resolvePad(key, T);
      expect(skin.key, `${key} resolved to a skin for a different sport`).toBe(key);
    }
  });

  it("unknown key throws — no silent universal fallback", () => {
    expect(() => resolvePad("quidditch", T)).toThrow(/no pad lane/);
  });

  it("a key equal to an Object.prototype property name is not falsely owned (Task 11 fix batch)", () => {
    // Before the fix, V3_SKINS was a plain `{}` literal: `"constructor" in
    // V3_SKINS` and `V3_SKINS["constructor"]` both read the INHERITED
    // Object.prototype.constructor, so this key resolved truthy though it
    // was never inserted — resolvePad("constructor") returned a bogus
    // skin instead of throwing.
    expect("constructor" in V3_SKINS).toBe(false);
    expect(() => resolvePad("constructor", T)).toThrow(/no pad lane/);
  });
});

// ---------------------------------------------------------------------------
// RESTORED FROM THE DEMOLITION (R7/G review, 2026-09-01). This assertion lived
// in `../../__tests__/registry.test.tsx`'s "resolveScorePad — drift guard"
// block, six of whose seven assertions tested the v2 `RESOLUTION_KIND` /
// `skinFor` table that R7/G deleted. This one did not: it derives straight off
// `builtinModules` and asserts something about the ENGINE, not about any pad
// lane — so it was removed as collateral damage, and the review caught it.
//
// It belongs here because `registry-totality.test.ts` is now the file that
// holds `builtinModules` to a written decision rather than a fallthrough,
// which is exactly the posture this assertion enforces.
//
// WHAT IT PROTECTS. `padSpec` is an OPTIONAL hook on `SportModule`
// (`packages/engine/src/sport/module.ts`), and
// `apps/web/src/server/usecases/fidelity.ts`'s `resolveScorePadBootstrap`
// falls back to `EMPTY_SPEC` when a module has none — `fidelityEntitlements:
// {}`, so `resolveFidelityBand` gates NOTHING and the pad renders at full band
// regardless of what the org bought. Dead today only because all eleven
// `builtinModules` happen to implement it. A twelfth sport that forgets is a
// silently ungated pad; this turns that into a CI failure.
//
// The real write path still refuses the append at the scoring door
// (`scoring.ts`'s `requiredFeatureForEvent`), so the worst case is misleading
// UI rather than a billing bypass — which is why this is a guard and not a
// blocker.
//
// It is NOT covered by `packages/engine/src/testkit/conformance-pad.ts`'s
// `padSpecConformanceSuite`: that is a manual per-module opt-in, called from
// eight scattered `*.test.ts` files, so it protects a module only if some test
// file remembers to name it. This assertion is derived from `builtinModules`
// itself, which is what makes it total.
describe("every engine module ships a padSpec (no module ships an UNGATED pad)", () => {
  it("no builtinModules entry omits the optional padSpec hook", () => {
    const missing = builtinModules.filter((m) => typeof m.padSpec !== "function").map((m) => m.key);
    expect(
      missing,
      "a module with no padSpec gets fidelity.ts's EMPTY_SPEC — no fidelityEntitlements, so no band gate at all",
    ).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Type-level (R2/task E acceptance criterion 2): an UN-CALLED factory must
// never satisfy a slot that expects a resolved skin — neither V3_SKINS
// itself nor resolvePad's own return. vitest (esbuild) strips types and
// checks nothing; the real gate for everything below is `npm run
// typecheck`, not this file's own green tick — widening either type back
// makes tsc report `TS2578: Unused '@ts-expect-error' directive'` and the
// project typecheck fails, which IS the red step
// (reference_ts_expect_error_is_a_real_test.md).
// ---------------------------------------------------------------------------
describe("type-level: an un-called v3 skin factory cannot stand in for a resolved skin (R2/task E)", () => {
  it("V3_SKINS holds FACTORIES — the correct shape compiles clean", () => {
    const ok: typeof V3_SKINS = { cricket: cricketSkinV3, football: footballSkinV3, tennis: tennisSkinV3 };
    expect(typeof ok.cricket).toBe("function");
    expect(typeof ok.football).toBe("function");
    expect(typeof ok.tennis).toBe("function");
  });

  it("an ALREADY-CALLED skin is not a valid V3_SKINS entry", () => {
    // @ts-expect-error — V3_SKINS's value type is `(t: TFn) => SkinDefV3`,
    // a function; `footballSkinV3(T)` is the CALLED result, a plain object
    // with no call signature. If V3_SKINS's type is ever loosened to also
    // accept an already-built skin, this line stops erroring and
    // `npm run typecheck` reports TS2578 here.
    const bad: typeof V3_SKINS = { football: footballSkinV3(T) };
    expect(bad).toBeTruthy();
  });

  it("an un-called factory is not a valid resolvePad return either — the boundary that actually reaches PadHostV3", () => {
    // @ts-expect-error — even after R8's wrapper removal, resolvePad's
    // RETURN is a resolved `SkinDefV3`, never a bare factory function: this
    // is the line "do NOT assign the bare factory object into V3_SKINS" is
    // actually protecting downstream of the map itself. If this ever stops
    // erroring, `npm run typecheck` reports TS2578 here.
    const bad: SkinDefV3 = cricketSkinV3;
    expect(bad).toBeTruthy();
  });
});
