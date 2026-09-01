// R1 chassis (Task 2) — the totality gate: every engine sport key must
// resolve to EXACTLY ONE pad lane (v3 or legacy), never both, never
// neither. R1 converted no sports: LEGACY_SPORTS named every builtinModules
// key and V3_SKINS stayed empty, so every key resolved "legacy". R2/task E
// moves cricket — the gate's job stays the same: turn "a 12th engine sport
// ships with no lane" (or a double-owned key, or a half-finished flip) into
// a CI failure instead of a silent fallthrough.
// Mutation-proved in task-2-report.md (R1, the empty-registry shape) and
// again for R2/task E's flip — see the task report for the three pasted
// reds (double-owned / unowned / cricket-still-legacy), each produced by a
// temporary hand edit to ../registry.ts, reverted immediately after.
import { describe, it, expect } from "vitest";
// Scout re-pin (2026-08-16): the engine's canonical sport-key source is
// `builtinModules`, imported exactly as registry.test.tsx:11 already does —
// NOT a hand-copied list of the 11 sport names.
import { builtinModules } from "@seazn/engine/sports";
import { V3_SKINS, LEGACY_SPORTS, resolvePad, type PadLaneResolution } from "../registry";
import { cricketSkinV3 } from "../skins/cricket";
import { footballSkinV3 } from "../skins/football";
import { tennisSkinV3 } from "../skins/tennis";

// A dummy, no-op translator. Every test in this file cares only about LANE
// resolution (v3 vs legacy vs throw) or the TYPE shape of what V3_SKINS/
// resolvePad accept — never about a resolved skin's own copy — so nothing
// here needs a real dictionary.
const T = (key: string): string => key;

describe("registry totality", () => {
  it("every engine sport resolves to exactly one lane", () => {
    // Task 11 fix batch (deferred from Task 2's review): this gate has no
    // floor assertion on its own key source — an empty `builtinModules`
    // import would skip the loop below entirely and still report a
    // passing run, indistinguishable from a real green. Mitigated only by
    // a DIFFERENT file (registry.test.tsx:87) today; this line makes the
    // gate self-contained.
    expect(builtinModules.length).toBeGreaterThan(0);
    for (const m of builtinModules) {
      const key = m.key;
      const inV3 = key in V3_SKINS;
      const inLegacy = LEGACY_SPORTS.has(key);
      expect(inV3 || inLegacy, `${key} unowned`).toBe(true);
      expect(inV3 && inLegacy, `${key} double-owned`).toBe(false);
      expect(resolvePad(key, T).lane).toBe(inV3 ? "v3" : "legacy");
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
    // { lane: "v3", skin: Object } instead of throwing.
    expect("constructor" in V3_SKINS).toBe(false);
    expect(() => resolvePad("constructor", T)).toThrow(/no pad lane/);
  });

  // R2/task E — the wave's actual deliverable, not merely structural
  // self-consistency. The generic sweep above only proves resolvePad AGREES
  // with V3_SKINS/LEGACY_SPORTS' own membership, whatever that membership
  // happens to say — it would stay green even if this task shipped without
  // actually flipping cricket (cricket would simply read `inV3: false,
  // inLegacy: true`, and the loop's own `inV3 ? "v3" : "legacy"` check would
  // agree with itself and never notice). This pin is independent of that
  // membership check: it hardcodes the wave's own intended answer, so a
  // regression that leaves cricket in the legacy lane (while V3_SKINS/
  // LEGACY_SPORTS still structurally agree with each other) still reds.
  it("cricket specifically resolves to the v3 lane, not legacy — R2's own flip", () => {
    expect(resolvePad("cricket", T).lane).toBe("v3");
  });

  // R3/task B2 — the wave's deliverable, pinned independently of the
  // structural sweep above for the reason cricket's own pin states: that sweep
  // only proves resolvePad AGREES with V3_SKINS/LEGACY_SPORTS' membership,
  // whatever it happens to say, so a task that shipped without actually
  // flipping football would keep it green.
  it("football specifically resolves to the v3 lane, not legacy — this wave's own flip", () => {
    expect(resolvePad("football", T).lane).toBe("v3");
  });

  // R4/tennis — this wave's own deliverable, pinned independently of the
  // structural sweep above for the same reason cricket's and football's own
  // pins state: that sweep only proves resolvePad AGREES with V3_SKINS/
  // LEGACY_SPORTS' membership, whatever it happens to say, so a task that
  // shipped without actually flipping tennis would keep it green.
  it("tennis specifically resolves to the v3 lane, not legacy — this wave's own flip", () => {
    expect(resolvePad("tennis", T).lane).toBe("v3");
  });

  // R5/badminton — this wave's own deliverable, pinned independently of the
  // structural sweep above for the same reason every flip before it is: that
  // sweep only proves resolvePad AGREES with V3_SKINS/LEGACY_SPORTS'
  // membership, whatever it happens to say, so a task that shipped without
  // actually flipping badminton would keep it green.
  it("badminton specifically resolves to the v3 lane, not legacy — this wave's own flip", () => {
    expect(resolvePad("badminton", T).lane).toBe("v3");
  });

  // R5/C2 — table tennis, this wave's own deliverable, pinned independently
  // of the structural sweep above for the same reason every flip before it
  // is: that sweep only proves resolvePad AGREES with V3_SKINS/
  // LEGACY_SPORTS' membership, whatever it happens to say, so a task that
  // shipped without actually flipping table tennis would keep it green.
  it("table tennis specifically resolves to the v3 lane, not legacy — this wave's own flip", () => {
    expect(resolvePad("tabletennis", T).lane).toBe("v3");
  });

  // R5/C3 — volleyball, this wave's own deliverable, pinned independently of
  // the structural sweep above for the same reason every flip before it is:
  // that sweep only proves resolvePad AGREES with V3_SKINS/LEGACY_SPORTS'
  // membership, whatever it happens to say, so a task that shipped without
  // actually flipping volleyball would keep it green. This closes out the
  // racquet family: volleyball is the third and last `sports/setbased`
  // sibling, and `racquet-skin.tsx` (v2) is now unreferenced by any sport.
  it("volleyball specifically resolves to the v3 lane, not legacy — this wave's own flip", () => {
    expect(resolvePad("volleyball", T).lane).toBe("v3");
  });

  it("hockey and ice hockey specifically resolve to the v3 lane — R6 flips the period pair in ONE change", () => {
    // BOTH, in one assertion, deliberately: the two share
    // `skins/period-shared.ts`, so a half-flipped pair would leave that module
    // carrying a sport whose pad never reaches it — the shape this programme
    // calls an inert seam.
    expect(resolvePad("hockey", T).lane).toBe("v3");
    expect(resolvePad("icehockey", T).lane).toBe("v3");
  });

  // R7/A1 — generic, this wave's own deliverable, pinned independently of the
  // structural sweep below for the same reason every flip before it is: that
  // sweep only proves resolvePad AGREES with V3_SKINS/LEGACY_SPORTS'
  // membership, whatever it happens to say, so a task that shipped without
  // actually flipping generic would keep it green. Generic is NOT a fallback
  // — it is a first-class catalog entry, and the first sport to leave
  // `../../registry.tsx`'s own `RESOLUTION_KIND: "universal"` lane, which now
  // serves carrom and boardgame alone.
  it("generic specifically resolves to the v3 lane, not legacy — this wave's own flip", () => {
    expect(resolvePad("generic", T).lane).toBe("v3");
  });

  // R7/A2 — boardgame, this wave's own deliverable, pinned independently of
  // the structural sweep below for the same reason every flip before it is:
  // that sweep only proves resolvePad AGREES with V3_SKINS/LEGACY_SPORTS'
  // membership, whatever it happens to say, so a task that shipped without
  // actually flipping boardgame would keep it green. This leaves
  // `../../registry.tsx`'s own `RESOLUTION_KIND: "universal"` lane serving
  // carrom alone.
  it("boardgame specifically resolves to the v3 lane, not legacy — this wave's own flip", () => {
    expect(resolvePad("boardgame", T).lane).toBe("v3");
  });

  // R7/A3 — carrom, this wave's own deliverable, pinned independently of the
  // structural sweep below for the same reason every flip before it is: that
  // sweep only proves resolvePad AGREES with V3_SKINS/LEGACY_SPORTS'
  // membership, whatever it happens to say, so a task that shipped without
  // actually flipping carrom would keep it green. Carrom is the ELEVENTH and
  // LAST engine sport to leave `../../registry.tsx`'s own
  // `RESOLUTION_KIND: "universal"` lane, which now serves nobody.
  it("carrom specifically resolves to the v3 lane, not legacy — this wave's own flip, and the LAST sport off the universal lane", () => {
    expect(resolvePad("carrom", T).lane).toBe("v3");
  });

  it("every other builtinModules sport still resolves to legacy — CARROM WAS THE LAST ONE: this set now names all eleven shipped sports, and LEGACY_SPORTS is empty", () => {
    const converted = new Set([
      "cricket",
      "football",
      "tennis",
      "badminton",
      "tabletennis",
      "volleyball",
      "hockey",
      "icehockey",
      "generic",
      "boardgame",
      "carrom",
    ]);
    const others = builtinModules.map((m) => m.key).filter((key) => !converted.has(key));
    // `others` is EMPTY, not merely small — carrom (R7/A3) was the last sport
    // left on the legacy lane, per boardgame's own pin above ("...serving
    // carrom alone"). A `for` loop over an empty array would assert nothing
    // and stay green even if this whole gate were deleted, so the emptiness
    // itself is the assertion — not a guard wrapped around a now-vacuous
    // loop. `LEGACY_SPORTS` (../registry.ts) is asserted directly alongside
    // it, since `others` and `LEGACY_SPORTS` are two independently-derived
    // sets that must now agree on the same empty answer.
    expect(others).toEqual([]);
    expect(LEGACY_SPORTS.size).toBe(0);
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

  it("an un-called factory is not a valid PadLaneResolution.skin either — the boundary that actually reaches PadHostV3", () => {
    // @ts-expect-error — even if V3_SKINS's own type were loosened,
    // resolvePad's RETURN must still refuse to hand PadHostV3 a bare
    // function where it expects an object with a `.scorebug` method: this
    // is the line "do NOT assign the bare factory object into V3_SKINS" is
    // actually protecting downstream of the map itself. If this ever stops
    // erroring, `npm run typecheck` reports TS2578 here.
    const bad: PadLaneResolution = { lane: "v3", skin: cricketSkinV3 };
    expect(bad).toBeTruthy();
  });
});
