// R8 sweep, WS-E — dead `pad.*` dictionary-key detector.
// .superpowers/sdd/2026-09-01-scorepad-v3-r8-sweep/task-E-brief.md (repo root).
//
// Imports the CLI script's core directly (relative path — the core is
// self-contained with no `@/` alias, see dead-pad-keys-lib.ts's header) so a
// future dead key reds THIS suite, not just a manual run of the script.
import { describe, it, expect } from "vitest";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  findDeadPadKeys,
  deadKeysAgainst,
  extractSignals,
  engineDeclaredPadLabelKeys,
} from "../../../scripts/i18n/dead-pad-keys-lib.ts";

const webRoot = join(dirname(fileURLToPath(import.meta.url)), "../../..");

describe("dead pad.* dictionary-key detector (R8 sweep)", () => {
  it("finds no dead pad.* keys in the real dictionaries", () => {
    const { dead, padKeys } = findDeadPadKeys(webRoot);
    expect(padKeys.length).toBeGreaterThan(500); // sanity: the scan actually found the pad.* namespace
    expect(dead, `dead pad.* key(s) found: ${dead.join(", ")}`).toEqual([]);
  });

  // Mutation guard for the DECISION function itself (no filesystem involved)
  // — proves the matching logic reds on a key reachable by neither signal,
  // the same shape as manually adding `pad.zzz.dead` to en/ui.json (+ the 3
  // locales) and re-running the CLI script, which was done by hand during
  // this task and confirmed to exit 1 before the fix below existed, and 0
  // after the 5 real dead keys it found were removed.
  it("flags a key referenced by neither literal nor template pattern as dead", () => {
    const referenced = new Set(["pad.alive.one"]);
    const patterns = [/^pad\.template\..*\.suffix$/];
    expect(
      deadKeysAgainst(["pad.alive.one", "pad.template.x.suffix", "pad.zzz.dead"], referenced, patterns),
    ).toEqual(["pad.zzz.dead"]);
  });

  // THE trap the brief names: a key the engine can emit is live even with
  // ZERO app-code reference. Confirmed by hand (2026-09-02) that these three
  // real PAD_LABEL_KEYS entries occur in exactly one file in the whole
  // apps/web tree — scoring-vocab.ts's own PAD_LABEL_KEYS declaration —
  // because action-form.tsx/attribution-picker.tsx resolve them through a
  // fully generic `padLabel(x.key, ...)` passthrough, never a literal or
  // template-matchable string. Removing the `engineDeclaredPadLabelKeys`
  // union from `findDeadPadKeys` would make all three read as dead.
  it("treats engine-declared PAD_LABEL_KEYS entries as referenced even with no app-literal hit", () => {
    const declared = engineDeclaredPadLabelKeys(webRoot);
    const engineOnlyKeys = [
      "pad.cricket.action.inningsSummary",
      "pad.football.action.sinbinStart",
      "pad.tabletennis.action.rallyAttributed.field.scorer",
    ];
    for (const key of engineOnlyKeys) {
      expect(declared.has(key), `${key} must be engine-declared (PAD_LABEL_KEYS)`).toBe(true);
    }
  });

  // Regression: a JSDoc example inside a block comment
  // (period-shared.ts:74-77, `` `pad.${key}.${name}` `` illustrating what NOT
  // to generate) parsed as if it were real code produces the template
  // pattern `^pad\..*\..*$`, which matches virtually every real
  // `pad.<sport>.<rest>` key and silently made the whole detector vacuous —
  // this is exactly how the FIRST run of this detector reported "0 dead
  // keys" before comment-stripping was added, and was caught only by the
  // `pad.zzz.dead` mutation check above failing to RED.
  it("does not read a template example inside a comment as a live pattern", () => {
    const commented = [
      "/**",
      " * NOT generated with `pad.${key}.${name}` as MessageKey even though",
      " */",
      'const real = t("pad.real.only.key");',
    ].join("\n");
    const { literals, patterns } = extractSignals(commented);
    expect(literals).toEqual(new Set(["pad.real.only.key"]));
    expect(patterns).toEqual([]);
  });
});
