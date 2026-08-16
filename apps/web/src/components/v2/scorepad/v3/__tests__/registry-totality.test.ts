// R1 chassis (Task 2) — the totality gate: every engine sport key must
// resolve to EXACTLY ONE pad lane (v3 or legacy), never both, never
// neither. R1 converts no sports: LEGACY_SPORTS names every builtinModules
// key and V3_SKINS stays empty, so today every key resolves "legacy" — the
// gate's job is to turn "a 12th engine sport ships with no lane" (or a
// double-owned key) into a CI failure instead of a silent fallthrough.
// Mutation-proved in task-2-report.md: deleting one key from LEGACY_SPORTS
// reds this suite with the "unowned" message.
import { describe, it, expect } from "vitest";
// Scout re-pin (2026-08-16): the engine's canonical sport-key source is
// `builtinModules`, imported exactly as registry.test.tsx:11 already does —
// NOT a hand-copied list of the 11 sport names.
import { builtinModules } from "@seazn/engine/sports";
import { V3_SKINS, LEGACY_SPORTS, resolvePad } from "../registry";

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
      expect(resolvePad(key).lane).toBe(inV3 ? "v3" : "legacy");
    }
  });

  it("unknown key throws — no silent universal fallback", () => {
    expect(() => resolvePad("quidditch")).toThrow(/no pad lane/);
  });

  it("a key equal to an Object.prototype property name is not falsely owned (Task 11 fix batch)", () => {
    // Before the fix, V3_SKINS was a plain `{}` literal: `"constructor" in
    // V3_SKINS` and `V3_SKINS["constructor"]` both read the INHERITED
    // Object.prototype.constructor, so this key resolved truthy though it
    // was never inserted — resolvePad("constructor") returned a bogus
    // { lane: "v3", skin: Object } instead of throwing.
    expect("constructor" in V3_SKINS).toBe(false);
    expect(() => resolvePad("constructor")).toThrow(/no pad lane/);
  });
});
