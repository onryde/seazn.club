// A test that mints a sport must take it away again.
//
// `sports` is not a test scratch table — it is the product's own catalog.
// `/onboarding` lists every row in it, so a sport a test leaves behind becomes
// a tile on a real account's welcome screen, between Ice Hockey and Table
// Tennis, for as long as that database lives. Found 2026-09-21: twelve suites
// run against the shared local database left seven junk rows in it —
// `pool-test-<uuid8>` six times over (a fresh key EVERY run) and
// `rs005_no_lineup`. Nothing was red. Nothing ever would have been.
//
// WHY THIS GUARD IS STATIC RATHER THAN A QUERY.
// The obvious shape is a live assertion — "`sports` holds nothing outside the
// engine's `builtinModules`". It was rejected, twice over:
//
//   1. It cannot be owned by the file that fails it. vitest runs files in
//      parallel workers against ONE database, and this repo's own workflow runs
//      several agents against the same labelled environment at once. A sibling
//      suite that is mid-flight has its sport row in the table legitimately, so
//      the assertion reds a file that did nothing wrong. That was not
//      hypothetical while this was being written: the junk rows were purged,
//      and were back minutes later from another session's run.
//   2. A red would name a KEY, not a file. The point of a guard is to hand the
//      next person the offender, and `pool-test-3fd5f441` does not do that.
//
// A flaky guard whose message does not name the culprit is deleted by the next
// person who meets it, and then the leak is back with a note saying it was once
// considered. So this reads the tree instead: deterministic, no database, no
// run-order coupling, and its failure message carries `file:line` and the key.
//
// SCOPE: `src/` AND `e2e/`.
//
// `e2e/` was excluded when this guard was first written, on the reasoning that
// a Playwright spec's database lifecycle belongs to the Playwright projects and
// their setup files rather than to this suite — and the exclusion was recorded
// honestly, naming `e2e/walkthrough/rs012-solo-signup-pool.spec.ts` as a known
// leaker (`rs012-pool-<uuid8>`, no cleanup) rather than pretending the tree was
// clean. That spec has since been fixed IN PLACE, with the same registry and
// `test.afterAll` shape this guard checks for, which settles the argument: the
// leak class is identical, the fix is identical, and `inAfterHook` already
// matches `test.afterAll(` (the `\b` matches after the dot).
//
// The known limitation, stated so nobody has to rediscover it: a spec that
// mints a sport and cleans it up in a PROJECT teardown or a global setup file
// would be reported here as a leaker, because this scan reads one file at a
// time and cannot see a hook living elsewhere. No spec does that today. If one
// ever needs to, teach `inspect()` about that file — do NOT re-exclude the
// directory, which would hide every future leaker to buy one exemption.
import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { builtinModules } from "@seazn/engine/sports";

/**
 * The keys `scripts/sync-sports.ts` creates, DERIVED from the engine registry
 * rather than listed — that script upserts one `sports` row per shipped
 * SportModule, so these are exactly the rows that belong in the catalog. A
 * sport added to the engine moves this set with it; a sport invented by a test
 * never enters it.
 */
const CATALOG_KEYS = new Set(builtinModules.map((m) => m.key));

/**
 * This file itself. Its premise rows hold SYNTHETIC sources — a leaking one and
 * a clean one — so a scan that walked it would accuse the guard of being the
 * leak. The exemption is checked rather than trusted: the premise row below
 * pins that this file opens no database connection at all, so it cannot become
 * a hiding place for a real insert later.
 */
const SELF = "src/lib/__tests__/minted-sport-cleanup.test.ts";

interface Verdict {
  /** Why this file is believed to mint a key the catalog will never own. */
  reasons: string[];
  /** Has it registered the rows for removal? */
  cleanup: { deletesSports: boolean; deletesDivisionsFirst: boolean; inAfterHook: boolean };
}

/**
 * Does this source insert a sport key that `sync-sports` would never create,
 * and if so does it clean up?
 *
 * Three signatures, each one a real shape seen in this tree:
 *
 *  - a bare non-catalog string literal in the key position
 *    (`values ('rs005_no_lineup', …)`) — leaks exactly ONCE and then hides
 *    behind `on conflict do nothing` forever, which is why nobody noticed it;
 *  - a sport-named variable built by interpolation
 *    (``const sportKey = `pool-test-${suffix}` ``) — a FRESH row every run, so
 *    a literal cleanup could not work even if someone wrote one;
 *  - a call to a `mintedSport()` registry, which is a file declaring outright
 *    that it mints.
 *
 * A key that arrives as a plain interpolated identifier (`values (${sportKey}`,
 * `${mod.key}`) is NOT a signature: in this tree those are always a builtin
 * chosen by the caller or an engine module's own `key`, and treating them as
 * suspect would flag a dozen well-behaved files — a guard with a dozen false
 * positives is a guard that gets deleted.
 *
 * Exported for the synthetic cases below, which are what stop this going
 * vacuous: a scanner that silently stopped matching would otherwise report a
 * clean tree and be believed.
 */
export function inspect(src: string): Verdict | null {
  if (!src.includes("insert into sports")) return null;
  const reasons: string[] = [];

  for (const site of keySites(src)) {
    const lit = /^'([^']*)'$/.exec(site.expr);
    if (lit && !CATALOG_KEYS.has(lit[1]!)) {
      reasons.push(`line ${site.line}: inserts the non-catalog key '${lit[1]}'`);
    }
  }
  // A sport-named binding assembled from a template with an interpolation.
  for (const m of src.matchAll(/(?:const|let)\s+(\w*[Ss]port\w*)\s*=\s*[^;\n]*`([^`]*\$\{[^`]*)`/g)) {
    reasons.push(`declares ${m[1]} = \`${m[2]}\` — a fresh sport key every run`);
  }
  if (/\bmintedSport\s*\(/.test(src)) {
    reasons.push("calls mintedSport() — the file declares that it mints");
  }
  if (reasons.length === 0) return null;

  const del = src.indexOf("delete from sports");
  const divs = src.indexOf("delete from divisions");
  return {
    reasons,
    cleanup: {
      deletesSports: del !== -1,
      // The FK on `divisions.sport_key` is NO ACTION, so the sport row cannot
      // go while a division still points at it. Order is part of the fix.
      deletesDivisionsFirst: divs !== -1 && del !== -1 && divs < del,
      inAfterHook: /\bafter(All|Each)\s*\(/.test(src),
    },
  };
}

/** The first element of every `insert into sports … values (…)` tuple. */
function keySites(src: string): { line: number; expr: string }[] {
  const out: { line: number; expr: string }[] = [];
  let i = 0;
  while ((i = src.indexOf("insert into sports", i)) !== -1) {
    const line = src.slice(0, i).split("\n").length;
    // The statement is a tagged template; it ends at the closing backtick.
    const end = src.indexOf("`", i);
    const stmt = src.slice(i, end === -1 ? src.length : end);
    const v = stmt.indexOf("values");
    if (v !== -1) {
      // Walk the tuples at depth 0 — a naive `\(([^,]+),` also matches inside
      // `${sql.json({ groups: [], … })}` and reports the position catalog as a
      // key, which is how the first draft of this scan "found" 160 sites.
      let depth = 0;
      let start = -1;
      for (let k = v; k < stmt.length; k++) {
        const c = stmt[k];
        if (c === "(" || c === "{" || c === "[") {
          depth++;
          if (depth === 1 && c === "(") start = k + 1;
        } else if (c === ")" || c === "}" || c === "]") {
          depth--;
        } else if (c === "," && depth === 1 && start !== -1) {
          out.push({ line, expr: stmt.slice(start, k).trim() });
          start = -1;
        }
      }
    }
    i = end === -1 ? i + 1 : end;
  }
  return out;
}

/** Every file under `src/` and `e2e/` this scan has an opinion about. */
function scan(): { file: string; verdict: Verdict }[] {
  const hits: { file: string; verdict: Verdict }[] = [];
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      const path = join(dir, name);
      if (statSync(path).isDirectory()) {
        if (name === "node_modules" || name === ".next") continue;
        walk(path);
        continue;
      }
      if (!/\.tsx?$/.test(name)) continue;
      if (relative(process.cwd(), path).replace(/\\/g, "/") === SELF) continue;
      const verdict = inspect(readFileSync(path, "utf8"));
      if (verdict) hits.push({ file: relative(process.cwd(), path).replace(/\\/g, "/"), verdict });
    }
  };
  walk(join(process.cwd(), "src"));
  walk(join(process.cwd(), "e2e"));
  return hits.sort((a, b) => a.file.localeCompare(b.file));
}

/** Files that touch `sports` at all — the denominator, for the premise rows. */
function inserters(): string[] {
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      const path = join(dir, name);
      if (statSync(path).isDirectory()) {
        if (name === "node_modules" || name === ".next") continue;
        walk(path);
        continue;
      }
      if (!/\.tsx?$/.test(name)) continue;
      if (relative(process.cwd(), path).replace(/\\/g, "/") === SELF) continue;
      if (readFileSync(path, "utf8").includes("insert into sports")) {
        out.push(relative(process.cwd(), path).replace(/\\/g, "/"));
      }
    }
  };
  walk(join(process.cwd(), "src"));
  walk(join(process.cwd(), "e2e"));
  return out.sort();
}

describe("a test that mints a sport takes it away again", () => {
  it("every minting file deletes its rows, divisions first, from an after hook", () => {
    const offenders = scan()
      .filter(
        ({ verdict }) =>
          !verdict.cleanup.deletesSports ||
          !verdict.cleanup.deletesDivisionsFirst ||
          !verdict.cleanup.inAfterHook,
      )
      .map(({ file, verdict }) => {
        const missing = [
          verdict.cleanup.inAfterHook ? null : "no afterAll/afterEach hook",
          verdict.cleanup.deletesSports ? null : "never runs `delete from sports`",
          verdict.cleanup.deletesDivisionsFirst
            ? null
            : "does not `delete from divisions` BEFORE the sports row (the FK is NO ACTION)",
        ].filter(Boolean);
        return `${file}\n    mints because: ${verdict.reasons.join("; ")}\n    missing: ${missing.join(", ")}`;
      });
    expect(
      offenders,
      `these files leave sport rows in the product catalog — /onboarding lists every one of them:\n  ${offenders.join("\n  ")}`,
    ).toEqual([]);
  });

  it("premise: the scan still finds minting files at all", () => {
    // Without this, a scanner that quietly stopped matching would report an
    // empty offender list above and be believed. Both halves: the tree really
    // is walked, and at least one file really is classified as minting.
    expect(inserters().length, "nothing in src/ inserts into sports any more").toBeGreaterThanOrEqual(20);
    expect(scan().length, "no file in src/ is classified as minting — the scan has gone blind").toBeGreaterThanOrEqual(1);
  });

  it("premise: the classifier tells a leak from a clean file", () => {
    // The real anti-vacuity proof, independent of whatever the tree happens to
    // contain today. Each synthetic is one of the three signatures.
    const insert = "await sql`insert into sports (key, name) values (${k}, 'X')`;";
    const cleanup =
      "afterAll(async () => { await sql`delete from divisions where sport_key in ${sql(k)}`;" +
      " await sql`delete from sport_variants where sport_key in ${sql(k)}`;" +
      " await sql`delete from sports where key in ${sql(k)}`; });";

    // (a) a non-catalog literal, no cleanup.
    const litLeak = inspect("await sql`insert into sports (key, name) values ('made_up', 'X')`;");
    expect(litLeak?.reasons.join(), "a bare non-catalog literal is not detected").toContain("made_up");
    expect(litLeak?.cleanup.deletesSports).toBe(false);

    // (b) an interpolated sport key, no cleanup.
    const tplLeak = inspect("const sportKey = `pool-test-${suffix}`;\n" + insert);
    expect(tplLeak?.reasons.join(), "an interpolated sport key is not detected").toContain("sportKey");
    expect(tplLeak?.cleanup.deletesSports).toBe(false);

    // …and the same file WITH cleanup passes every leg.
    const fixed = inspect("const sportKey = `pool-test-${suffix}`;\n" + insert + "\n" + cleanup);
    expect(fixed?.cleanup).toEqual({
      deletesSports: true,
      deletesDivisionsFirst: true,
      inAfterHook: true,
    });

    // …but cleanup in the WRONG ORDER does not, because the FK would reject it.
    const wrongOrder = inspect(
      "const sportKey = `pool-test-${suffix}`;\n" +
        insert +
        "\nafterAll(async () => { await sql`delete from sports where key in ${sql(k)}`;" +
        " await sql`delete from divisions where sport_key in ${sql(k)}`; });",
    );
    expect(wrongOrder?.cleanup.deletesDivisionsFirst, "delete ordering is not checked").toBe(false);

    // (c) a file that inserts only catalog keys is not accused at all.
    expect(
      inspect("await sql`insert into sports (key, name) values ('generic', 'Generic')`;"),
      "a builtin-keyed insert was reported as minting",
    ).toBeNull();
    // …nor is a file that hands over a key the caller chose.
    expect(
      inspect("await sql`insert into sports (key, name) values (${mod.key}, ${mod.key})`;"),
      "an engine module key was reported as minting",
    ).toBeNull();
    // …nor a file that never touches the table.
    expect(inspect("const x = 1;")).toBeNull();

    // The self-exclusion above, checked. This file is skipped by the walk
    // because it carries the synthetic sources just used; that is only safe
    // while it never talks to a database itself.
    const self = readFileSync(join(process.cwd(), SELF), "utf8");
    expect(self, "the guard now opens a DB connection — it can no longer exempt itself").not.toMatch(
      /from "@\/lib\/db"/,
    );
    expect(self, "SELF no longer points at this file").toContain("a test that mints a sport takes it away again");
  });

  it("premise: the catalog keys come from the engine, not from a list typed here", () => {
    // If this set were hand-written it would be asserting yesterday's sports,
    // and a newly shipped sport would be reported as a test invention.
    expect(CATALOG_KEYS.size, "the engine registry is empty — CATALOG_KEYS is vacuous").toBeGreaterThanOrEqual(10);
    expect(CATALOG_KEYS.has("generic")).toBe(true);
    // The discriminating half: it is NOT simply "every key ever seen".
    expect(CATALOG_KEYS.has("pool-test-3fd5f441")).toBe(false);
    expect(CATALOG_KEYS.has("rs005_no_lineup")).toBe(false);
  });

  it("premise: the scan actually covers BOTH trees — src/ and e2e/", () => {
    // The `e2e/` walk was added after a Playwright spec leaked a sport row
    // into the product catalog. A mutation campaign then deleted that walk and
    // every row here stayed green (2026-09-21) — the extension was unpinned,
    // so the next person to "simplify" the scan silently loses e2e coverage
    // and the leak class comes back for exactly the tree it was found in.
    const files = inserters();
    const trees = new Set(files.map((f) => f.split("/")[0]));
    expect(files.length, "nothing inserts into sports — this guard is vacuous").toBeGreaterThan(5);
    expect(trees, `only walked: ${[...trees].join(", ")}`).toContain("src");
    expect(trees, "the e2e walk was dropped — a Playwright leaker would go unseen").toContain("e2e");
  });

});
