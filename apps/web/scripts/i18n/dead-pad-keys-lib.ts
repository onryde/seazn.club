// Pure, filesystem-scanning logic behind the dead `pad.*` dictionary-key
// detector (ScoringPad v3 R8 sweep, WS-E — see
// .superpowers/sdd/2026-09-01-scorepad-v3-r8-sweep/task-E-brief.md at the
// repo root). Self-contained (only node:fs/node:path plus a relative import
// of `flattenKeys`, no `@/` alias) so this file can be imported BOTH by the
// plain-node CLI runner (`find-dead-pad-keys.ts`, same directory) and by
// apps/web's vitest suite (`src/lib/__tests__/find-dead-pad-keys.test.ts`,
// via a relative path) — plain `node --experimental-strip-types` cannot
// resolve Next's `@/` path alias, the way `apps/web/src/lib/i18n-dict-utils.ts`'s
// own header explains for the identical reason.
//
// THE ONE DANGEROUS TRAP this file exists to avoid (see the brief): a
// `pad.*` key the ENGINE can emit at runtime is LIVE even with ZERO literal
// or template-matchable occurrence anywhere in apps/web/src or apps/web/e2e.
// Concretely: `action-form.tsx`'s `renderField`/`renderAction`,
// `attribution-picker.tsx`'s attribution rows, and `scorebug.tsx`'s hint
// resolution all call the shared `padLabel(x.key, ...)` gate with `x.key` a
// RUNTIME STRING the engine's `padSpec(cfg)` computed — never a literal or
// template-built string anywhere in application code. Confirmed by hand
// (2026-09-02): `pad.cricket.action.inningsSummary`,
// `pad.football.action.sinbinStart` and
// `pad.tabletennis.action.rallyAttributed.field.scorer` each occur in
// exactly ONE file in the whole apps/web tree — `scoring-vocab.ts`'s own
// `PAD_LABEL_KEYS` declaration — and nowhere else, yet all three are real,
// currently-live engine-emittable labels. The ONLY signal that proves keys
// like these are reachable is `scoring-vocab.ts`'s own hand-authored
// `PAD_LABEL_KEYS` array, which `__tests__/scoring-vocab.test.ts`'s
// `declaredPadLabels()` gate keeps equal to the eleven sport modules' real
// `padSpec(cfg)` emission surface (plus the ribbon/scorebug-hint categories
// documented at that array's own header). This module therefore EXCLUDES
// `scoring-vocab.ts` from the general literal/template scan below and
// instead parses `PAD_LABEL_KEYS` explicitly — by text, not a live import;
// `scoring-vocab.ts` pulls in `@/lib/messages`, `@seazn/engine/core` etc.
// through the `@/` alias, which plain node cannot resolve — and unions the
// result in as its own, separately-audited "engine-declared" category.
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { flattenKeys } from "../../src/lib/i18n-dict-utils.ts";

export interface DeadPadKeyResult {
  /** Every `pad.*` key in en/ui.json, sorted. */
  padKeys: string[];
  /** Every key proven live by a direct literal hit or PAD_LABEL_KEYS membership. */
  referenced: Set<string>;
  /** Template patterns (from backtick interpolations) a key can also match. */
  patterns: RegExp[];
  /** padKeys with no entry in `referenced` and no matching pattern. */
  dead: string[];
}

const SOURCE_EXTENSIONS = [".ts", ".tsx"];
// Pruned during the walk — never descended into.
const EXCLUDED_DIRS = new Set(["node_modules", ".next", ".turbo", "dictionaries"]);

function walkSourceFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (EXCLUDED_DIRS.has(entry.name)) continue;
      walkSourceFiles(join(dir, entry.name), out);
    } else if (entry.isFile() && SOURCE_EXTENSIONS.some((ext) => entry.name.endsWith(ext))) {
      out.push(join(dir, entry.name));
    }
  }
  return out;
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** A backtick template's static segments, as a regex matching any full key
 *  the template could produce. Each `${...}` hole becomes `.*` — deliberately
 *  permissive, since a hole's runtime value can itself carry a dot (e.g.
 *  ribbon.ts's `${suffix}` walks event types like "game.summary"), and a
 *  false NEGATIVE here (missing a real reference) is the costly direction —
 *  it is what would make the detector delete a live key. */
function templateToPattern(literalText: string): RegExp {
  const segments = literalText.split(/\$\{[^}]*\}/);
  return new RegExp(`^${segments.map(escapeRegex).join(".*")}$`);
}

/** Strip block (`/* … *\/`) and line (`// …`) comments before scanning.
 *  Load-bearing, not cosmetic: period-shared.ts:74-77 carries a JSDoc example
 *  `` `pad.${key}.${name}` `` illustrating what NOT to do — two
 *  interpolations either side of one literal dot — which, left in, produces
 *  the template pattern `^pad\..*\..*$`. That matches virtually every real
 *  `pad.<sport>.<rest>` key (they all have 2+ dots), so it silently defeats
 *  the whole detector: caught by this file's own mutation check (a synthetic
 *  `pad.zzz.dead` key went unflagged until this strip was added). Comments
 *  are never usage — of a literal OR a template — so stripping first is
 *  correct in general, not merely a fix for this one example. */
function stripComments(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
}

/** Every referenced-key SIGNAL in one file's source text: plain quoted
 *  `pad.x.y` literals (single, double, or backtick with no interpolation),
 *  and template patterns for backtick strings that do interpolate. */
export function extractSignals(text: string): { literals: Set<string>; patterns: RegExp[] } {
  const code = stripComments(text);
  const literals = new Set<string>();
  const patterns: RegExp[] = [];

  for (const m of code.matchAll(/(['"`])(pad\.[A-Za-z0-9_]+(?:\.[A-Za-z0-9_]+)*)\1/g)) {
    literals.add(m[2]);
  }
  for (const m of code.matchAll(/`(pad\.[^`]*)`/g)) {
    const content = m[1]!;
    if (content.includes("${")) patterns.push(templateToPattern(content));
  }
  // A pluralised key is NEVER written out in full: `plural("pad.x.y", n)`
  // resolves to `pad.x.y.one` / `pad.x.y.other` at runtime (see `plural` in
  // lib/messages), so a literal scan sees the BASE and the dictionary holds
  // the CATEGORIES, and every pluralised pad key would read as dead. The
  // whole CLDR category set is admitted rather than just the two English
  // uses, because a locale added later (Polish `few`/`many`, Arabic `zero`/
  // `two`) is a dictionary change with no matching source change — and a
  // false NEGATIVE is the costly direction here, per this file's own header.
  for (const m of code.matchAll(/\bplural\s*\(\s*(['"`])(pad\.[A-Za-z0-9_]+(?:\.[A-Za-z0-9_]+)*)\1/g)) {
    patterns.push(new RegExp(`^${escapeRegex(m[2]!)}\\.(?:zero|one|two|few|many|other)$`));
  }
  return { literals, patterns };
}

/** `PAD_LABEL_KEYS` from scoring-vocab.ts, parsed as text — see this file's
 *  header for why a live import isn't used. Every entry in the array is a
 *  plain quoted literal (confirmed by hand, 2026-09-02: the array declares
 *  no computed/spread entries), so a quoted-literal scan of the array's own
 *  span is exact, not approximate. Throws if the array can't be located —
 *  a silent empty result here would make every engine-only key look dead. */
export function engineDeclaredPadLabelKeys(webRoot: string): Set<string> {
  const src = readFileSync(join(webRoot, "src/lib/scoring-vocab.ts"), "utf8");
  const start = src.indexOf("export const PAD_LABEL_KEYS");
  if (start === -1) {
    throw new Error("dead-pad-keys-lib: PAD_LABEL_KEYS not found in scoring-vocab.ts — did it move or get renamed?");
  }
  const end = src.indexOf("\n];", start);
  if (end === -1) {
    throw new Error("dead-pad-keys-lib: PAD_LABEL_KEYS array close (`\\n];`) not found — the text parse is stale.");
  }
  const body = src.slice(start, end);
  const out = new Set<string>();
  for (const m of body.matchAll(/"(pad\.[A-Za-z0-9_.]+)"/g)) out.add(m[1]!);
  return out;
}

/** Pure decision function, isolated for direct unit testing with no
 *  filesystem involved — proves the matching LOGIC, not just that the
 *  pipeline runs end to end. */
export function deadKeysAgainst(padKeys: string[], referenced: Set<string>, patterns: RegExp[]): string[] {
  return padKeys.filter((k) => !referenced.has(k) && !patterns.some((p) => p.test(k)));
}

/**
 * Walks apps/web/src and apps/web/e2e for `pad.*` string-literal and
 * template-pattern hits, unions in scoring-vocab.ts's PAD_LABEL_KEYS (the
 * engine-declared set — see this file's header), and returns every `pad.*`
 * key in en/ui.json that neither signal reaches.
 *
 * Excluded from the literal/template scan: `dictionaries/` (the keys
 * themselves, not usages — every dict trivially contains its own key as a
 * quoted JSON property name), `src/lib/i18n-keys.ts` (generated 1:1 from
 * every dictionary key, so it would trivially "reference" anything that
 * exists and make the whole detector vacuous), and `src/lib/scoring-vocab.ts`
 * (the vocab REGISTRY, folded in explicitly instead — see header).
 */
export function findDeadPadKeys(webRoot: string): DeadPadKeyResult {
  const enDict = JSON.parse(readFileSync(join(webRoot, "src/dictionaries/en/ui.json"), "utf8")) as Record<
    string,
    unknown
  >;
  const padKeys = flattenKeys(enDict)
    .filter((k) => k.startsWith("pad."))
    .sort();

  const referenced = engineDeclaredPadLabelKeys(webRoot);
  const patterns: RegExp[] = [];

  const scoringVocabPath = join(webRoot, "src/lib/scoring-vocab.ts");
  const generatedKeysPath = join(webRoot, "src/lib/i18n-keys.ts");
  for (const root of [join(webRoot, "src"), join(webRoot, "e2e")]) {
    for (const file of walkSourceFiles(root)) {
      if (file === scoringVocabPath || file === generatedKeysPath) continue;
      const { literals, patterns: filePatterns } = extractSignals(readFileSync(file, "utf8"));
      for (const l of literals) referenced.add(l);
      patterns.push(...filePatterns);
    }
  }

  return { padKeys, referenced, patterns, dead: deadKeysAgainst(padKeys, referenced, patterns) };
}
