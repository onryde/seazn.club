// W1d Task 20 review, Minor 3 (D14): the files a Stryker leg's `mutate` list selects, from node: built-ins alone.
//
// scripts/stryker-matrix.mjs fingerprints each leg's CUT, and mutation.yml files the leg's incremental cache under that
// fingerprint. A cut is not only the entries and the anchors: a file added, removed or renamed inside a glob changes what the
// leg mutates while every entry stays the same, and a cache restored across that change carries results for a file the leg no
// longer holds (the Survivors guard then refuses the report, and the cache, saved before it, would be restored again the next
// week). So the fingerprint includes the sorted list of files the entries resolve to.
//
// It cannot use `fs.globSync` / `path.matchesGlob` (node 22 and 24 only; the plan job runs with the runner's own node, and
// stryker-matrix.mjs says node 18.3 or later), so this reads the few glob forms stryker.groups.mjs uses: a literal path, `*`
// inside a segment, and `**` as a whole segment. Anything else is a refusal, never a guess. test/stryker-matrix.test.ts holds
// the result equal to the Stryker-side reading (test/stryker-coverage.ts `selected`, which uses node's own glob) for every leg.
import { readdirSync, statSync } from "node:fs";
import { join } from "node:path";

/** Characters a glob may carry that this reader does not implement (brace, class, `?`, extglob, escape, and a `!` that is not the leading negation). */
const UNSUPPORTED = /[?[\]{}()\\!]/;

/** A glob as segments, or a thrown `Error` naming what it cannot read. */
function segmentsOf(glob) {
  if (glob === "") throw new Error("an empty glob");
  if (glob.startsWith("/") || glob.endsWith("/")) throw new Error(`"${glob}": a glob is a relative path of segments, with no leading or trailing "/"`);
  const segments = glob.split("/");
  for (const s of segments) {
    if (s === "") throw new Error(`"${glob}": an empty segment`);
    if (UNSUPPORTED.test(s)) throw new Error(`"${glob}": the segment "${s}" uses glob syntax this reader does not implement (only "*" inside a segment and "**" as a whole segment)`);
    if (s.includes("**") && s !== "**") throw new Error(`"${glob}": "**" is a whole segment, not part of "${s}"`);
  }
  return segments;
}

/** One non-`**` segment as a RegExp: `*` is any run of characters but "/", everything else is itself. A segment that starts
 *  with "." is matched only by a segment that does (the default of the glob readers Stryker and node use). */
function segmentPattern(segment) {
  const body = segment.split("*").map((part) => part.replace(/[.+^$|\\]/g, "\\$&")).join("[^/]*");
  return new RegExp(segment.startsWith(".") ? `^${body}$` : `^(?!\\.)${body}$`);
}

/** Whether the path (as segments) matches the glob (as segments). `**` is zero or more whole segments; a trailing `**`
 *  needs at least one (it is what is UNDER the directory). */
function matchSegments(pattern, path) {
  const [head, ...rest] = pattern;
  if (head === undefined) return path.length === 0;
  if (head === "**") {
    if (rest.length === 0) return path.length > 0 && path.every((p) => !p.startsWith("."));
    for (let skip = 0; skip <= path.length; skip++) {
      if (path.slice(0, skip).some((p) => p.startsWith("."))) return false;
      if (matchSegments(rest, path.slice(skip))) return true;
    }
    return false;
  }
  return path.length > 0 && segmentPattern(head).test(path[0]) && matchSegments(rest, path.slice(1));
}

/** Whether `file` (a `/`-separated path relative to the root) matches `glob`. */
export function globMatches(glob, file) {
  return matchSegments(segmentsOf(glob), file.split("/"));
}

/** The literal leading directory of a glob (the segments before the first one with a wildcard), `null` for a glob with none. */
function literalDirectory(segments) {
  const at = segments.findIndex((s) => s.includes("*"));
  if (at === -1) return null;
  return segments.slice(0, at);
}

const listings = new Map();
/** Every regular file under `dir` (relative to `root`, `/`-separated), memoised: legs share directories. */
function filesUnder(root, dirSegments) {
  const key = `${root}\0${dirSegments.join("/")}`;
  const known = listings.get(key);
  if (known !== undefined) return known;
  const out = [];
  const walk = (segments) => {
    let entries;
    try {
      entries = readdirSync(join(root, ...segments), { withFileTypes: true });
    } catch (e) {
      if (e.code === "ENOENT" || e.code === "ENOTDIR") return;
      throw e;
    }
    for (const entry of entries) {
      const at = [...segments, entry.name];
      if (entry.isDirectory()) walk(at);
      else if (entry.isFile()) out.push(at.join("/"));
    }
  };
  walk(dirSegments);
  listings.set(key, out);
  return out;
}

/** `file#3` and `file:10-20` name a part or a range of a file: the file is what is selected. */
const SUFFIX = /(?:#\d+|:\d+-\d+)$/;

/** The files `entries` (a leg's `mutate` list, as stryker.groups.mjs writes it) select under `root`, sorted: a positive entry
 *  adds the files it matches, a `!` entry removes the files it matches whatever was added before, and a later positive entry
 *  adds them back (the order Stryker reads the list in). A positive glob must start with a literal directory (a leading
 *  wildcard would walk the whole tree). Throws an Error on a glob it cannot read. */
export function filesOf(entries, root) {
  const chosen = new Set();
  for (const entry of entries) {
    if (entry.startsWith("!")) {
      const glob = entry.slice(1);
      for (const f of [...chosen]) if (globMatches(glob, f)) chosen.delete(f);
      continue;
    }
    const glob = entry.replace(SUFFIX, "");
    const segments = segmentsOf(glob);
    const directory = literalDirectory(segments);
    if (directory === null) {
      let isFile = false;
      try {
        isFile = statSync(join(root, ...segments)).isFile();
      } catch (e) {
        if (e.code !== "ENOENT" && e.code !== "ENOTDIR") throw e;
      }
      if (isFile) chosen.add(segments.join("/"));
      continue;
    }
    if (directory.length === 0) throw new Error(`"${entry}": a glob must start with a literal directory (a leading wildcard would walk the whole tree)`);
    for (const f of filesUnder(root, directory)) if (matchSegments(segments, f.split("/"))) chosen.add(f);
  }
  return [...chosen].sort();
}
