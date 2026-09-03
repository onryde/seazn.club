// R8 sweep, WS-E — dead `pad.*` dictionary-key detector.
// .superpowers/sdd/2026-09-01-scorepad-v3-r8-sweep/task-E-brief.md (repo root).
//
// Imports the CLI script's core directly (relative path — the core is
// self-contained with no `@/` alias, see dead-pad-keys-lib.ts's header) so a
// future dead key reds THIS suite, not just a manual run of the script.
import { describe, it, expect } from "vitest";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
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

  // W1 (entitlements v18) — a pluralised key is never written out in full:
  // `plural("pad.x.y", n)` resolves to `pad.x.y.one` / `pad.x.y.other` at
  // runtime, so the source carries the BASE and the dictionary carries the
  // CATEGORIES. Without this the detector calls every pluralised pad key dead
  // — which it did, for the band picker's own "N actions on the pad".
  it("a plural() call keeps its CLDR category keys live, and only its own", () => {
    const { patterns } = extractSignals('plural("pad.recording.actions", n, { count: n });');
    const live = (k: string) => patterns.some((p) => p.test(k));
    expect(live("pad.recording.actions.one")).toBe(true);
    expect(live("pad.recording.actions.other")).toBe(true);
    // a locale added later must not need a source change to stay live
    expect(live("pad.recording.actions.few")).toBe(true);
    // ...but the admission is scoped: a neighbouring key is NOT swept in,
    // or the fix would trade a false positive for a blind detector.
    expect(live("pad.recording.actions")).toBe(false);
    expect(live("pad.recording.actionsX.one")).toBe(false);
    expect(live("pad.recording.close")).toBe(false);
    expect(live("pad.cricket.action.ball.one")).toBe(false);
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

// ── Full-pipeline mutation guard, isolated from the real repo ────────────────
//
// FIX (review round 1): the ONE test above shaped like a mutation check
// (`deadKeysAgainst` with a "pad.zzz.dead" MOCK input) never actually drove
// `findDeadPadKeys` end to end against an injected dictionary key — and worse,
// the literal string "pad.zzz.dead" sitting in THIS test file is itself a
// `.ts` file under `src/`, which `findDeadPadKeys(webRoot)`'s own scan walks.
// So the real-repo test above ("finds no dead pad.* keys") silently
// "references" that exact sentinel via this file, and a reviewer who injects
// `pad.zzz.dead` into the REAL en/ui.json and reruns the CLI gets a false
// `✓ 0 dead` — the identical vacuousness class the JSDoc-comment bug above
// was caught for, just one level up the stack. Confirmed by hand: before this
// fix, `node scripts/i18n/find-dead-pad-keys.ts` printed `✓ 0 dead pad.* keys`
// with `pad.zzz.dead` freshly added to en/ui.json.
//
// The fix is NOT to exclude `__tests__/` from the walk — e2e/unit-test
// literals are legitimate references (excluding them would flag genuinely
// live keys, e.g. the five pinned cfg-space-walk-only keys
// `scoring-vocab.test.ts` itself asserts). The fix is to stop reusing the
// real repo tree for the mutation proof at all: build a throwaway directory
// shaped exactly like `webRoot` (dictionaries/en/ui.json,
// lib/scoring-vocab.ts, one referencing source file, an empty e2e/) and run
// the REAL `findDeadPadKeys` against THAT — no sentinel string this file uses
// anywhere else can leak in, because the fixture tree contains nothing this
// file wrote.
function buildFixtureWebRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "dead-pad-keys-fixture-"));
  mkdirSync(join(root, "src/dictionaries/en"), { recursive: true });
  mkdirSync(join(root, "src/lib"), { recursive: true });
  mkdirSync(join(root, "e2e"), { recursive: true });

  // Real i18n-dict-utils.ts (self-contained, only node:crypto) — dead-pad-keys-lib.ts
  // imports flattenKeys from it via a path relative to itself.
  const realDictUtils = readFileSync(join(webRoot, "src/lib/i18n-dict-utils.ts"), "utf8");
  writeFileSync(join(root, "src/lib/i18n-dict-utils.ts"), realDictUtils);

  writeFileSync(
    join(root, "src/dictionaries/en/ui.json"),
    JSON.stringify(
      {
        "pad.alive.literal": "Referenced by a plain string literal below",
        "pad.tpl.badminton.foo": "Referenced only via a template pattern below",
        "pad.engine.only": "Referenced only via PAD_LABEL_KEYS below — zero app literal",
        "pad.zzz.dead": "Referenced by nothing in this fixture — must be flagged dead",
      },
      null,
      2,
    ),
  );

  // Mirrors scoring-vocab.ts's own shape closely enough for
  // engineDeclaredPadLabelKeys's text parse: the exact substring
  // "export const PAD_LABEL_KEYS", then a literal-string array, closed by a
  // line that is exactly "];".
  writeFileSync(
    join(root, "src/lib/scoring-vocab.ts"),
    ['export const PAD_LABEL_KEYS: readonly string[] = [', '  "pad.engine.only",', "];", ""].join("\n"),
  );

  writeFileSync(
    join(root, "src/app-usage.ts"),
    [
      'const literal = "pad.alive.literal";',
      "function build(sport: string) {",
      "  return `pad.tpl.${sport}.foo`;",
      "}",
      "",
    ].join("\n"),
  );

  return root;
}

describe("dead pad.* detector — full pipeline, isolated tmpdir fixture (review round 1 fix)", () => {
  it("flags a key injected into the fixture dictionary but referenced nowhere as dead", () => {
    const root = buildFixtureWebRoot();
    try {
      const { dead } = findDeadPadKeys(root);
      expect(dead).toEqual(["pad.zzz.dead"]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("does not flag a literal-referenced, template-referenced, or engine-declared key in the same fixture", () => {
    const root = buildFixtureWebRoot();
    try {
      const { dead } = findDeadPadKeys(root);
      expect(dead).not.toContain("pad.alive.literal");
      expect(dead).not.toContain("pad.tpl.badminton.foo");
      expect(dead).not.toContain("pad.engine.only");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
