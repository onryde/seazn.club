// Match Day online (Task 2), owner O2 (2026-11-17): the held and the flagged boards of a chess division have ONE source, for every
// surface that lists them - `listNeedsOrganiserExternalPlay` (held) and `listFlaggedExternalPlay` (flagged), read by the division
// page's Held | Flagged queue and by Match Day (`readOnlineRounds`; Task 4 appends the desk's attention producer, competition-desk.ts).
// A second query for "which boards are held" or "which are flagged" would drift from the first the day a rule changes (a settled
// cancelled board, a board the viewer plays on), so this file reads the sources and refuses it:
//   1. every consumer on the list calls BOTH listers;
//   2. no file of Match Day's own code (server/usecases/match-day*.ts, lib/match-day/, components/v2/match-day/) holds a SQL template
//      that names `fixture_play_flags` or `needs_organiser`.
// Pure: reads files, no database. The detector is proved on synthetic sources first (a guard nothing kills is not tested), and both
// halves report how many files they read - zero is a failure, so a moved directory cannot leave the guard checking nothing.
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";

const SRC = join(process.cwd(), "src");

/** The surfaces that list held and flagged boards: the division page's queue, Match Day's rounds, and (Task 4) the desk's per-board attentions. */
const CONSUMERS = [
  "app/o/[orgSlug]/c/[compSlug]/d/[divSlug]/page.tsx",
  "server/usecases/match-day-online.ts",
  "server/usecases/competition-desk.ts",
  // Match Day's two readers share ONE read of the pair per poll (MD-R23, `sharedQueueReads`): they call the listers through it, and it is
  // the one place that calls them for both.
  "server/usecases/external-play/queue-reads.ts",
] as const;
/** Match Day's poll reads the listers through `queue-reads` (one read per division per poll), so neither calls them directly. */
const SHARED_READERS = ["server/usecases/match-day-online.ts", "server/usecases/competition-desk.ts"] as const;

/** Whether `source` (comments already gone) calls `lister` otherwise than as a method of the shared reads - the bare
 *  `listFlaggedExternalPlay(auth, id)` or through a module (`arbiter.listFlaggedExternalPlay(auth, id)`), a read of its own - rather than
 *  `reads.listFlaggedExternalPlay(id)` / `ctx.queue.listFlaggedExternalPlay(id)`. */
export function callsListerDirectly(source: string, lister: string): boolean {
  for (const m of source.matchAll(new RegExp(`([\\w.]*)\\b${lister}\\(`, "g"))) {
    if (!/(^|\.)(queue|reads)\.$/.test(m[1]!)) return true;
  }
  return false;
}
const LISTERS = ["listNeedsOrganiserExternalPlay", "listFlaggedExternalPlay"] as const;
/** The words a held / flagged query names. */
const SECOND_QUERY_WORDS = ["fixture_play_flags", "needs_organiser"] as const;

/** Match Day's own code: the files that must hold no such query. */
function matchDayFiles(): string[] {
  const out: string[] = [];
  const walk = (dir: string, take: (name: string) => boolean) => {
    for (const name of readdirSync(dir)) {
      const path = join(dir, name);
      if (statSync(path).isDirectory()) {
        if (name !== "__tests__") walk(path, take);
      } else if (/\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name) && take(name)) out.push(path);
    }
  };
  walk(join(SRC, "server/usecases"), (n) => /^match-day.*\.ts$/.test(n));
  walk(join(SRC, "lib/match-day"), () => true);
  walk(join(SRC, "components/v2/match-day"), () => true);
  return out;
}

/** The source with its comments removed (a word in prose is no query). Strings are left alone: a template literal is the thing to read. */
function withoutComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
}

/** The tag of the template that opens at `start`: the identifier before it, and BEFORE its type arguments when it has some - the
 *  repo writes its SQL as ``tx<Row[]>`...` ``, ``sql<{ id: string }[]>`...` ``, so the character before the backtick is `>`, which a plain
 *  `(\w+)\s*$` read as "no tag" and left every typed query out of the scan. Walks back over the balanced `<...>` (an arrow `=>` inside is
 *  no closer). */
function tagBefore(code: string, start: number): string {
  let i = start - 1;
  while (i >= 0 && /\s/.test(code[i]!)) i--;
  if (code[i] === ">") {
    let depth = 0;
    for (; i >= 0; i--) {
      if (code[i] === ">" && code[i - 1] !== "=") depth++;
      else if (code[i] === "<" && --depth === 0) break;
    }
    i--;
    while (i >= 0 && /\s/.test(code[i]!)) i--;
  }
  const end = i + 1;
  while (i >= 0 && /\w/.test(code[i]!)) i--;
  return code.slice(i + 1, end);
}

/** Every template literal of `code` (comments already gone) as its tag and its own text, the text of `${ … }` expressions left out and
 *  the templates INSIDE them found too (a SQL fragment nested in a SQL template is a template of its own). A quoted string is skipped
 *  to its end or its line's end (JSX text can hold an apostrophe). */
function templatesOf(code: string): { tag: string; text: string }[] {
  const out: { tag: string; text: string }[] = [];
  const scan = (from: number, inExpression: boolean): number => {
    let i = from;
    let depth = 0;
    while (i < code.length) {
      const c = code[i]!;
      if (c === '"' || c === "'") {
        i++;
        while (i < code.length && code[i] !== c && code[i] !== "\n") i += code[i] === "\\" ? 2 : 1;
        i++;
      } else if (c === "`") {
        i = template(i);
      } else {
        if (inExpression && c === "{") depth++;
        if (inExpression && c === "}") {
          if (depth === 0) return i + 1;
          depth--;
        }
        i++;
      }
    }
    return i;
  };
  const template = (start: number): number => {
    const tag = tagBefore(code, start);
    let text = "";
    let i = start + 1;
    while (i < code.length) {
      const c = code[i]!;
      if (c === "\\") {
        text += code[i + 1] ?? "";
        i += 2;
      } else if (c === "`") {
        out.push({ tag, text });
        return i + 1;
      } else if (c === "$" && code[i + 1] === "{") {
        i = scan(i + 2, true);
      } else {
        text += c;
        i++;
      }
    }
    out.push({ tag, text });
    return i;
  };
  scan(0, false);
  return out;
}

/** The words of `SECOND_QUERY_WORDS` that a SQL TEMPLATE of `source` names: a template tagged `sql`, `tx` or `db`, after the comments
 *  are gone, nested fragments included. */
export function secondQueryWords(source: string): string[] {
  const found = new Set<string>();
  for (const t of templatesOf(withoutComments(source))) {
    if (!["sql", "tx", "db"].includes(t.tag)) continue;
    for (const w of SECOND_QUERY_WORDS) if (t.text.includes(w)) found.add(w);
  }
  return [...found];
}

describe("the detector (proved before it is trusted)", () => {
  it("names a SQL template that reads flags or the held status, tagged sql / tx / db", () => {
    expect(secondQueryWords("const x = await sql`select 1 from fixture_play_flags where closed_at is null`;")).toEqual(["fixture_play_flags"]);
    expect(secondQueryWords("await tx`select 1 from fixture_external_play where status = 'needs_organiser'`")).toEqual(["needs_organiser"]);
    expect(secondQueryWords("db`select * from fixture_play_flags fl join fixture_external_play ep on ep.status = 'needs_organiser'`").sort()).toEqual([
      "fixture_play_flags",
      "needs_organiser",
    ]);
  });

  it("finds a word in a fragment nested in a template, and in the text AFTER a nested fragment (the outer template's own tail)", () => {
    expect(secondQueryWords("await sql`select 1 ${ok ? sql`and fixture_play_flags` : sql``} from t`")).toEqual(["fixture_play_flags"]);
    expect(secondQueryWords("await sql`select 1 ${sql`x`} from t where status = 'needs_organiser'`")).toEqual(["needs_organiser"]);
    expect(secondQueryWords("await sql`select ${a} from fixtures where id in ${sql([...ids])}`")).toEqual([]);
  });

  it("finds a TYPED query - the repo's own spelling, tx<Row[]>`...` and sql<{ id: string }[]>`...` - which the tag read used to skip", () => {
    expect(secondQueryWords("const rows = await tx<{ id: string; at: Date | null }[]>`select 1 from fixture_play_flags`;")).toEqual(["fixture_play_flags"]);
    expect(secondQueryWords("await sql<Row[]>`select 1 where status = 'needs_organiser'`")).toEqual(["needs_organiser"]);
    expect(secondQueryWords("await sql <Map<string, number>>`select 1 from fixture_play_flags`")).toEqual(["fixture_play_flags"]);
    expect(secondQueryWords("const f = (a: number) => a; await db<(x: number) => void>`select 1 from fixture_play_flags`")).toEqual(["fixture_play_flags"]);
    // An untyped, untagged template and a typed non-SQL tag stay silent.
    expect(secondQueryWords("const t = css<Props>`color: red; /* fixture_play_flags */`;")).toEqual([]);
    expect(templatesOf("x<A>`a` + y`b`").map((t) => t.tag)).toEqual(["x", "y"]);
  });

  it("is silent for the same words in a comment, a plain string or an untagged template (no query there)", () => {
    expect(secondQueryWords("// reads fixture_play_flags\nconst a = 1;")).toEqual([]);
    expect(secondQueryWords("/* needs_organiser */ const a = 1;")).toEqual([]);
    expect(secondQueryWords("const reason = 'needs_organiser'; const t = `fixture_play_flags`;")).toEqual([]);
    expect(secondQueryWords("await sql`select 1 from fixtures where id = ${id}`")).toEqual([]);
  });
});

describe("owner O2: one source for the held and the flagged boards", () => {
  it("every consumer calls BOTH listers (and the list names the division page, Match Day and the desk)", () => {
    expect(CONSUMERS.length, "consumers named").toBeGreaterThanOrEqual(3);
    expect(CONSUMERS, "the desk's per-board attentions are a consumer").toContain("server/usecases/competition-desk.ts");
    let checked = 0;
    for (const file of CONSUMERS) {
      const source = withoutComments(readFileSync(join(SRC, file), "utf8"));
      for (const lister of LISTERS) {
        expect(new RegExp(`\\b${lister}\\(`).test(source), `${file} calls ${lister}`).toBe(true);
        checked++;
      }
    }
    expect(checked, "consumer x lister pairs checked").toBe(CONSUMERS.length * LISTERS.length);
  });

  it("the detector for a direct lister call finds the bare call and passes the method of the shared reads (proved before it is trusted)", () => {
    expect(callsListerDirectly("const x = await listFlaggedExternalPlay(auth, id);", "listFlaggedExternalPlay")).toBe(true);
    expect(callsListerDirectly("Promise.all([listFlaggedExternalPlay(auth, id)])", "listFlaggedExternalPlay")).toBe(true);
    expect(callsListerDirectly("const x = await ctx.queue.listFlaggedExternalPlay(id);", "listFlaggedExternalPlay")).toBe(false);
    expect(callsListerDirectly("reads.listFlaggedExternalPlay(divisionId)", "listFlaggedExternalPlay")).toBe(false);
    expect(callsListerDirectly("import { listFlaggedExternalPlay } from './arbiter';", "listFlaggedExternalPlay")).toBe(false);
    // A call through a module is as direct as a bare one; a method of anything but the shared reads is not the shared read.
    expect(callsListerDirectly("(await import('./arbiter')).listFlaggedExternalPlay(auth, id)", "listFlaggedExternalPlay")).toBe(true);
    expect(callsListerDirectly("arbiter.listFlaggedExternalPlay(auth, id)", "listFlaggedExternalPlay")).toBe(true);
    expect(callsListerDirectly("other.listFlaggedExternalPlay(id)", "listFlaggedExternalPlay")).toBe(true);
    // One direct call among shared ones is found.
    expect(callsListerDirectly("a = reads.listFlaggedExternalPlay(x); b = listFlaggedExternalPlay(auth, y);", "listFlaggedExternalPlay")).toBe(true);
    expect(callsListerDirectly("a = reads.listFlaggedExternalPlay(x); b = ctx.queue.listFlaggedExternalPlay(y);", "listFlaggedExternalPlay")).toBe(false);
  });

  it("MD-R23: Match Day's two readers ask the listers through the shared reads, never directly - a direct call is a second read of the same poll", () => {
    expect(SHARED_READERS.length, "readers named").toBe(2);
    let checked = 0;
    for (const file of SHARED_READERS) {
      const source = withoutComments(readFileSync(join(SRC, file), "utf8"));
      expect(source, `${file} takes the reads from queue-reads`).toMatch(/external-play\/queue-reads"/);
      for (const lister of LISTERS) {
        expect(new RegExp(`\\.${lister}\\(`).test(source), `${file} calls ${lister} on the shared reads`).toBe(true);
        expect(callsListerDirectly(source, lister), `${file} does not call ${lister} directly`).toBe(false);
        checked++;
      }
    }
    expect(checked, "reader x lister pairs checked").toBe(SHARED_READERS.length * LISTERS.length);
    // And the one module that does call them, for both, calls each.
    const reads = withoutComments(readFileSync(join(SRC, "server/usecases/external-play/queue-reads.ts"), "utf8"));
    for (const lister of LISTERS) expect(callsListerDirectly(reads, lister), `queue-reads.ts calls ${lister}`).toBe(true);
  });

  it("no file of Match Day's own code holds a SQL template naming fixture_play_flags or needs_organiser", () => {
    const files = matchDayFiles();
    expect(files.length, "files read (anti-vacuity: 0 is a failure)").toBeGreaterThanOrEqual(3);
    // The scan reaches each of the three roots, so a renamed directory cannot leave one unread.
    for (const root of ["server/usecases/match-day", "lib/match-day/", "components/v2/match-day/"]) {
      expect(files.filter((f) => relative(SRC, f).startsWith(root)).length, `files read under ${root}`).toBeGreaterThan(0);
    }
    const offenders = files.flatMap((f) => secondQueryWords(readFileSync(f, "utf8")).map((w) => `${relative(SRC, f)}: ${w}`));
    expect(offenders).toEqual([]);
  });

  it("the desk is no second source either: competition-desk.ts holds no SQL template naming fixture_play_flags or needs_organiser", () => {
    // The desk reads a great deal of SQL of its own (fixtures, stages, bans); the two words are the held and the flagged queries, and
    // the desk takes both from the listers (the test above). Match Day's file scan above does not reach it, so it is read here.
    const source = readFileSync(join(SRC, "server/usecases/competition-desk.ts"), "utf8");
    expect(withoutComments(source).length, "the desk's source was read (anti-vacuity)").toBeGreaterThan(1000);
    expect(templatesOf(withoutComments(source)).filter((t) => ["sql", "tx", "db"].includes(t.tag)).length, "SQL templates scanned").toBeGreaterThan(0);
    expect(secondQueryWords(source)).toEqual([]);
  });
});
