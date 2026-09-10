// Every `overlay.*` / `stream.*` key the source actually references exists in
// all four locales (R14). The key list is DERIVED FROM THE SOURCE, never typed
// here: a typed list drifts the moment a component adds a key, and then the
// test proves only that the list matches itself.
import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

const SRC = join(__dirname, "..", "..");
const DICT = join(SRC, "dictionaries");
const LOCALES = ["en", "fr", "es", "nl"] as const;

const SCAN_DIRS = [
  join(SRC, "components", "overlay"),
  join(SRC, "components", "v2"),
  join(SRC, "lib"),
  join(SRC, "app", "overlay"),
  join(SRC, "app", "(public)"),
];

function files(dir: string): string[] {
  let out: string[] = [];
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return out;
  }
  for (const entry of entries) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      if (entry === "__tests__") continue;
      out = out.concat(files(full));
    } else if (/\.tsx?$/.test(entry)) {
      // `lib/i18n-keys.ts` is GENERATED from `en` and lists EVERY key in the
      // catalog as a string literal. Scanning it made "referenced by the
      // source" mean "declared in en", so this test could not tell a panel
      // that resolves its copy from one that never mentions a key at all —
      // it degenerated into an en-vs-locale parity check. Task 6 found that
      // when the panel's own 30 keys landed and the "finds the keys at all"
      // floor moved with the DICTIONARY rather than with the code.
      if (entry !== "i18n-keys.ts") out.push(full);
    }
  }
  return out;
}

/**
 * Source with its comments removed.
 *
 * Found while mutation-testing the orphan check below (fix round 5): the key
 * scan matches BACKTICK-delimited literals, and this codebase's doc comments
 * routinely name a key in backticks — `overlay.brand`, right here in this
 * sentence, is one. So a component could stop resolving a key entirely, keep
 * the comment that mentions it, and the key would still read as "referenced".
 * The un-wiring mutant survived on exactly that. A comment is documentation,
 * never a reader.
 *
 * The `//` arm ignores a match preceded by `:` so `https://…` inside a string
 * does not truncate the rest of its line.
 */
export function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/[^\n]*/g, "$1");
}

/** Every string literal in the source that looks like one of this wave's keys.
 *  Deliberately a literal scan: a key built by concatenation is missed here and
 *  picked up by `dynamicPrefixesIn` below instead. */
function referencedKeys(prefix: string): Set<string> {
  const re = new RegExp(`["'\`](${prefix}\\.[A-Za-z0-9_.]+)["'\`]`, "g");
  const found = new Set<string>();
  for (const dir of SCAN_DIRS) {
    for (const file of files(dir)) {
      const source = stripComments(readFileSync(file, "utf8"));
      for (const m of source.matchAll(re)) found.add(m[1]!);
    }
  }
  return found;
}

/**
 * The static head of every template literal that BUILDS a key of this wave —
 * `` `stream.preview.${style}` `` yields `"stream.preview."`.
 *
 * The orphan check below needs this or it reports a false positive for every
 * key resolved by concatenation: `fixture-stream-panel.tsx:206` renders its
 * per-style caption that way, and `stream.preview.slate` therefore appears in
 * no source file as a literal while being fully wired.
 *
 * A prefix is only accepted with at least one segment BELOW the namespace
 * (`stream.preview.`, never a bare `stream.`) — a namespace-wide prefix would
 * excuse every key in it and quietly turn this whole test off.
 */
export function dynamicPrefixesIn(source: string, ns: string): Set<string> {
  const re = new RegExp("`(" + ns + "\\.[A-Za-z0-9_.]*)\\$\\{", "g");
  const out = new Set<string>();
  for (const m of source.matchAll(re)) {
    const head = m[1]!;
    // Both conjuncts carry weight, and each has its own row in the parser test
    // below: a head that does not end at a segment boundary (`stream.tab${id}`)
    // would excuse `stream.tabs.label` too, and a head of exactly one segment
    // (`stream.${key}`) would excuse the entire namespace and turn the orphan
    // check off without changing a single expectation.
    if (head.endsWith(".") && head.split(".").length > 2) out.add(head);
  }
  return out;
}

function dynamicPrefixes(ns: string): Set<string> {
  const out = new Set<string>();
  for (const dir of SCAN_DIRS) {
    for (const file of files(dir)) {
      for (const p of dynamicPrefixesIn(stripComments(readFileSync(file, "utf8")), ns)) out.add(p);
    }
  }
  return out;
}

/**
 * Keys `en` DECLARES that no source file resolves — in either direction: not as
 * a literal, not through a concatenated prefix.
 *
 * This is the half `overlay-dict-coverage.test.ts` did not have, and the reason
 * five orphaned `public.overlay.*` keys shipped past it: the source→dict checks
 * below prove nothing is MISSING, and the en-vs-locale check proves no locale
 * has an EXTRA — neither can see a key that is present in all four locales and
 * read by nothing. `overlay.brand` sat there in four dictionaries while three
 * components hardcoded `seazn`.
 */
function orphanKeys(ns: string, dict: Record<string, string>): string[] {
  const referenced = referencedKeys(ns);
  const prefixes = [...dynamicPrefixes(ns)];
  return Object.keys(dict)
    .filter((k) => k.startsWith(`${ns}.`))
    .filter((k) => !referenced.has(k) && !prefixes.some((p) => k.startsWith(p)))
    .sort();
}

/**
 * Orphans with a REASON and an owner. An entry here is a promise that the key
 * is owed to named future work, not that it is fine — so the test below fails
 * BOTH ways: an un-listed orphan, and a listed key that has since been wired or
 * deleted. Without that second direction the list would silently outlive the
 * thing it excuses, which is how the exemption becomes the defect.
 */
const KNOWN_ORPHANS: Readonly<Record<string, string>> = {
  // `_THEMES.md` §4a's "SIGNAL LOST" state cannot be reached from `OverlayModel`
  // alone; it needs B3's `<video>` element to report a stalled source. Recorded
  // in `overlay-slate.tsx`'s own header.
  "overlay.slate.signalLostHeadline": "owed to B3 — the <video> seam that can detect a stalled source",
  "overlay.slate.signalLostLine": "owed to B3 — same seam",
  // `overlay.watchLive` / `overlay.replay` were listed here as owed to Task 7.
  // Task 7 has WIRED them (the public match page's stream link,
  // `app/(public)/…/fixtures/[fixtureId]/{stream-link.ts,page.tsx}`), so the
  // check below reds on a stale entry and the promise is kept by deleting it,
  // never by keeping the row. Naming the two keys in this paragraph is safe on
  // both counts: `files()` skips every `__tests__` directory, so this file is
  // never scanned, and `stripComments` would drop the line even if it were.
};

const dictOf = (locale: string, ns: string): Record<string, string> =>
  JSON.parse(readFileSync(join(DICT, locale, `${ns}.json`), "utf8"));

describe("overlay + panel copy is complete in every locale", () => {
  it("scans the SOURCE, not the generated key union", () => {
    // The positive pair for the exclusion in `files()` above: without it this
    // test's whole premise ("keys the source actually references") is false,
    // because `lib/i18n-keys.ts` names every key in `en` as a literal — and
    // nothing else here would notice, since a bigger referenced set still
    // clears every floor and every "exists in this locale" check below.
    const scanned = files(join(SRC, "lib"));
    expect(scanned.length, "the lib scan found no files at all").toBeGreaterThan(10);
    expect(scanned.filter((f) => f.endsWith("i18n-keys.ts")), "the generated union was scanned").toEqual(
      [],
    );
  });

  it("finds the keys at all — a scan that matched nothing would pass vacuously", () => {
    expect(referencedKeys("overlay").size).toBeGreaterThanOrEqual(8);
    // RE-PIN (2026-09-10, task 6): the panel has landed, so the floor moves
    // past the brief's own `>= 12`. `fixture-stream-panel.tsx` resolves 29
    // `stream.*` literals and `theme-registry.ts` three more (`stream.tab.bar`
    // / `.bug` / `.slate`) — 32 today with `i18n-keys.ts` excluded above. 24
    // is a FLOOR, not that count: it is low enough that adding or merging a
    // key does not red this test, and high enough that a panel which stopped
    // resolving its copy through `msg` (hardcoded English, a deleted tab, a
    // whole branch dropped) falls through it.
    expect(referencedKeys("stream").size).toBeGreaterThanOrEqual(24);
  });

  for (const locale of LOCALES) {
    it(`${locale}/public.json carries every overlay.* key the source uses`, () => {
      const dict = dictOf(locale, "public");
      const missing = [...referencedKeys("overlay")].filter((k) => typeof dict[k] !== "string").sort();
      expect(missing, `${locale} is missing these overlay keys`).toEqual([]);
    });

    it(`${locale}/ui.json carries every stream.* key the source uses`, () => {
      const dict = dictOf(locale, "ui");
      const missing = [...referencedKeys("stream")].filter((k) => typeof dict[k] !== "string").sort();
      expect(missing, `${locale} is missing these stream keys`).toEqual([]);
    });
  }

  // -------------------------------------------------------------------------
  // The OTHER direction (fix round 5, I5). Everything above asks "does every
  // key the source uses exist?"; nothing above could ask "does every key that
  // exists reach a screen?", which is why three orphans shipped.
  // -------------------------------------------------------------------------
  it("every `overlay.*` key en declares is resolved by the source, or listed with its owner", () => {
    const orphans = orphanKeys("overlay", dictOf("en", "public"));
    const unexplained = orphans.filter((k) => !(k in KNOWN_ORPHANS));
    expect(
      unexplained,
      "declared in four locales and read by nothing — wire it, delete it, or add it to KNOWN_ORPHANS with the task that owes it",
    ).toEqual([]);
  });

  it("every `stream.*` key en declares is resolved by the source, or listed with its owner", () => {
    const orphans = orphanKeys("stream", dictOf("en", "ui"));
    const unexplained = orphans.filter((k) => !(k in KNOWN_ORPHANS));
    expect(unexplained, "same rule for the console panel's namespace").toEqual([]);
  });

  it("KNOWN_ORPHANS does not outlive what it excuses — every listed key is still declared AND still an orphan", () => {
    // The half that makes the list a promise rather than a mute. When Task 7
    // wires `overlay.watchLive`, this reds and the entry has to go; if someone
    // deletes the key instead, this reds too.
    const declared = { ...dictOf("en", "public"), ...dictOf("en", "ui") };
    const orphans = new Set([
      ...orphanKeys("overlay", dictOf("en", "public")),
      ...orphanKeys("stream", dictOf("en", "ui")),
    ]);
    const stale = Object.keys(KNOWN_ORPHANS)
      .filter((k) => typeof declared[k] !== "string" || !orphans.has(k))
      .sort();
    expect(stale, "these entries no longer describe the tree — remove them").toEqual([]);
    expect(Object.keys(KNOWN_ORPHANS).length, "an empty list would make the two checks above vacuous-proof but this one vacuous").toBeGreaterThan(0);
  });

  it("the concatenated-key reader is a real parser, not a rubber stamp", () => {
    // `orphanKeys` excuses a key when a template literal builds its prefix.
    // That escape hatch is only safe if it is narrow: one row per refusal.
    expect([...dynamicPrefixesIn("const k = `stream.preview.${style}`;", "stream")]).toEqual([
      "stream.preview.",
    ]);
    expect(
      [...dynamicPrefixesIn("const k = `stream.${anything}`;", "stream")],
      "a namespace-wide prefix would excuse every key at once",
    ).toEqual([]);
    expect(
      [...dynamicPrefixesIn("const k = `stream.tabs.lab${id}`;", "stream")],
      "a head that stops mid-segment would excuse stream.tabs.label — and it is DEEP enough to clear the depth guard, so only the segment-boundary conjunct refuses it",
    ).toEqual([]);
    expect([...dynamicPrefixesIn('const k = "stream.preview.slate";', "stream")]).toEqual([]);
    expect([...dynamicPrefixesIn("const k = `overlay.status.${s}`;", "stream")]).toEqual([]);
  });

  it("a key named in a COMMENT is not a reader — documentation cannot wire copy", () => {
    // The mutant that found this: un-wiring `overlay.brand` from all three
    // themes left the orphan check green, because the comments explaining the
    // change still named the key in backticks.
    const wired = 'const label = msg("overlay.brand");';
    const documented = "// see `overlay.brand`, resolved elsewhere\n/* and `overlay.brand` again */";
    expect(stripComments(wired), "real code is untouched").toBe(wired);
    expect(stripComments(documented).includes("overlay.brand"), "both comment forms go").toBe(false);
    expect(
      stripComments('const u = "https://example.test/x"; const k = "overlay.brand";'),
      "a URL's // must not eat the rest of the line",
    ).toContain("overlay.brand");
  });

  it("no locale carries an overlay/stream key en has dropped", () => {
    const en = { ...dictOf("en", "public"), ...dictOf("en", "ui") };
    for (const locale of LOCALES.filter((l) => l !== "en")) {
      const other = { ...dictOf(locale, "public"), ...dictOf(locale, "ui") };
      const orphans = Object.keys(other)
        .filter((k) => (k.startsWith("overlay.") || k.startsWith("stream.")) && !(k in en))
        .sort();
      expect(orphans, `${locale} has keys en does not`).toEqual([]);
    }
  });
});
