// Archive a sponsor, Task 4 (spec docs/superpowers/specs/2026-11-11-sponsor-archive-design.md D27, §11): ONE visibility rule in
// SQL, `status = 'active' and archived_at is null`. This static sweep reads every source file under src/server and src/app, .ts
// and .tsx (review M3: a route handler or a server component could hold SQL too; no database), and finds each
// SQL template that touches the `sponsors` table (`from` / `join` / `update sponsors`, pre-flight P1: `recordClick` UPDATEs) and
// filters `status = 'active'`. Each of those decides what the public, the stream or the redirect sees, so each must also carry
// `archived_at is null`. A new reader that copies the old filter goes red here until it adds the archive one.
//
// The inventory is spec §11's, typed here: `resolveSponsors` (usecases/sponsors.ts), the two `resolveSponsorLink` arms and
// `recordClick` (sponsors/clicks.ts), `activeSponsorCards` (sponsors/card-source.ts). Five. The count is reported, and zero found
// is a failure (a matcher that finds nothing proves nothing). The matcher and the template lexer are exercised on planted sources
// first, through the same functions the sweep uses.
//
// Sport: not applicable (a static read of SQL text).
import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";

const SRC = resolve(import.meta.dirname, "../../.."); // apps/web/src
/** Where SQL can live: the server modules and the app tree (route handlers, server components, server actions). */
const ROOTS = [join(SRC, "server"), join(SRC, "app")];
const SOURCE = /\.tsx?$/;
const NOT_SOURCE = /\.(test|spec)\.tsx?$|\.d\.ts$/;
const rel = (abs: string): string => relative(SRC, abs).split("\\").join("/");

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (name === "__tests__" || name === "node_modules") continue;
    const full = join(dir, name);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (SOURCE.test(name) && !NOT_SOURCE.test(name)) out.push(full);
  }
  return out;
}

/**
 * Every top-level template literal in a TypeScript source, with the offset it opens at. Comments and quoted strings are
 * skipped, so a backtick inside a comment never opens one. A template's text INCLUDES its `${…}` expressions and any template
 * nested in them (resolveSponsors' `${onStream ? sql`and on_stream` : sql``}`): one SQL statement is one entry.
 */
function templatesOf(src: string): { at: number; text: string }[] {
  const out: { at: number; text: string }[] = [];
  const n = src.length;
  const skipQuoted = (q: string, pos: number): number => {
    pos++;
    while (pos < n && src[pos] !== q && src[pos] !== "\n") pos += src[pos] === "\\" ? 2 : 1;
    return pos + 1;
  };
  // `pos` is the opening backtick; returns the offset after the closing one.
  const readTemplate = (pos: number): number => {
    pos++;
    while (pos < n) {
      const c = src[pos];
      if (c === "\\") pos += 2;
      else if (c === "`") return pos + 1;
      else if (c === "$" && src[pos + 1] === "{") pos = readCode(pos + 2, true);
      else pos++;
    }
    return pos;
  };
  // Code until its closing brace (inside `${…}`), or to the end of the file (top level, where templates are collected).
  function readCode(pos: number, inExpression: boolean): number {
    let depth = 0;
    while (pos < n) {
      const c = src[pos];
      if (c === "/" && src[pos + 1] === "/") {
        const e = src.indexOf("\n", pos);
        pos = e < 0 ? n : e;
      } else if (c === "/" && src[pos + 1] === "*") {
        const e = src.indexOf("*/", pos + 2);
        pos = e < 0 ? n : e + 2;
      } else if (c === "'" || c === '"') {
        pos = skipQuoted(c, pos);
      } else if (c === "`") {
        const end = readTemplate(pos);
        if (!inExpression) out.push({ at: pos, text: src.slice(pos + 1, end - 1) });
        pos = end;
      } else {
        if (c === "{") depth++;
        else if (c === "}") {
          if (inExpression && depth === 0) return pos + 1;
          depth--;
        }
        pos++;
      }
    }
    return pos;
  }
  readCode(0, false);
  return out;
}

/** A sponsors read or write that filters on visibility: the templates D27 governs. */
const isVisibilityRead = (sqlText: string): boolean =>
  /\b(from|join|update)\s+sponsors\b/i.test(sqlText) && /\bstatus\s*=\s*'active'/i.test(sqlText);
/** …and the archive half of the rule. */
const hidesArchived = (sqlText: string): boolean => /\barchived_at\s+is\s+null\b/i.test(sqlText);

const lineOf = (src: string, at: number): number => src.slice(0, at).split("\n").length;

interface Found {
  where: string;
  file: string;
  hidesArchived: boolean;
}

function sweep(): { scanned: number; perRoot: Record<string, number>; tsx: number; found: Found[] } {
  const perRoot: Record<string, number> = {};
  const files: string[] = [];
  for (const root of ROOTS) {
    const mine = walk(root);
    perRoot[rel(root)] = mine.length;
    files.push(...mine);
  }
  files.sort();
  const found: Found[] = [];
  for (const abs of files) {
    const src = readFileSync(abs, "utf8");
    for (const t of templatesOf(src)) {
      if (!isVisibilityRead(t.text)) continue;
      found.push({ where: `${rel(abs)}:${lineOf(src, t.at)}`, file: rel(abs), hidesArchived: hidesArchived(t.text) });
    }
  }
  return { scanned: files.length, perRoot, tsx: files.filter((f) => f.endsWith(".tsx")).length, found };
}

describe("the matcher and the lexer, on planted sources", () => {
  it("a visibility read with the archive filter passes; the same read without it is found and fails", () => {
    const withFilter = "const r = await sql`select id from sponsors where org_id = ${orgId} and status = 'active' and archived_at is null`;";
    const without = "const r = await sql`select id from sponsors where org_id = ${orgId} and status = 'active'`;";
    const [a] = templatesOf(withFilter);
    const [b] = templatesOf(without);
    expect([isVisibilityRead(a!.text), hidesArchived(a!.text)]).toEqual([true, true]);
    expect([isVisibilityRead(b!.text), hidesArchived(b!.text)]).toEqual([true, false]);
  });

  it("join and update forms are visibility reads too; another table, or no status filter, is not", () => {
    const read = (s: string) => isVisibilityRead(templatesOf(s)[0]!.text);
    expect(read("sql`select 1 from x c join sponsors sp on sp.id = c.sponsor_id and sp.status = 'active'`")).toBe(true);
    expect(read("sql`update sponsors set click_count = click_count + 1 where id = ${id} and status = 'active'`")).toBe(true);
    expect(read("sql`select 1 from sponsor_clicks where status = 'active'`")).toBe(false);
    expect(read("sql`select 1 from sponsors where org_id = ${orgId}`")).toBe(false);
  });

  it("a nested template is part of its statement; a backtick in a comment or a string opens nothing", () => {
    const src = [
      "// `select 1 from sponsors where status = 'active'` (a comment)",
      "/* `update sponsors set x = 1 where status = 'active'` */",
      "const s = \"`from sponsors where status = 'active'`\";",
      "const rows = await sql`",
      "  select id from sponsors where org_id = ${orgId} and status = 'active'",
      "    ${onStream ? sql`and on_stream` : sql``}",
      "    and archived_at is null",
      "  order by id`;",
    ].join("\n");
    const ts = templatesOf(src);
    expect(ts, "one statement, the nested fragments inside it").toHaveLength(1);
    expect([isVisibilityRead(ts[0]!.text), hidesArchived(ts[0]!.text)]).toEqual([true, true]);
    expect(lineOf(src, ts[0]!.at)).toBe(4);
  });

  it("a .tsx source (review M3): JSX text with an apostrophe does not swallow the SQL template after it", () => {
    const src = [
      "export default async function Page() {",
      "  const rows = await sql`select id from sponsors where org_id = ${orgId} and status = 'active'`;",
      "  return <p className=\"note\">Don't miss {rows.length} sponsors</p>;",
      "}",
      "const more = await sql`select 1 from sponsors where status = 'active' and archived_at is null`;",
    ].join("\n");
    const ts = templatesOf(src);
    expect(ts.map((t) => [lineOf(src, t.at), isVisibilityRead(t.text), hidesArchived(t.text)])).toEqual([
      [2, true, false],
      [5, true, true],
    ]);
  });
});

describe("D27: every sponsors visibility read in apps/web/src/server and src/app also hides the archived", () => {
  it("finds spec §11's five, and each carries `archived_at is null`", () => {
    const { scanned, perRoot, tsx, found } = sweep();
    // Reported, so a reviewer sees the inventory, not just a count.
    console.info(
      `archive-reader-sweep: scanned ${scanned} files (${JSON.stringify(perRoot)}, ${tsx} .tsx), found ${found.length}:\n  ` +
        found.map((f) => `${f.where}${f.hidesArchived ? "" : "  MISSING archived_at is null"}`).join("\n  "),
    );
    expect(scanned, "files scanned").toBeGreaterThan(0);
    // Named, not read off ROOTS: dropping a root from the walk must fail here.
    for (const root of ["server", "app"]) expect(perRoot[root] ?? 0, `files scanned under src/${root}`).toBeGreaterThan(0);
    expect(tsx, ".tsx files scanned").toBeGreaterThan(0);
    expect(found.length, "zero found is a failure").toBeGreaterThan(0);
    const perFile: Record<string, number> = {};
    for (const f of found) perFile[f.file] = (perFile[f.file] ?? 0) + 1;
    expect(perFile, "spec §11's inventory").toEqual({
      "server/sponsors/card-source.ts": 1, // activeSponsorCards
      "server/sponsors/clicks.ts": 3, // resolveSponsorLink's uuid arm and short-code arm, recordClick
      "server/usecases/sponsors.ts": 1, // resolveSponsors
    });
    expect(found.length).toBe(5);
    expect(found.filter((f) => !f.hidesArchived).map((f) => f.where), "visibility reads without the archive filter").toEqual([]);
  });
});
