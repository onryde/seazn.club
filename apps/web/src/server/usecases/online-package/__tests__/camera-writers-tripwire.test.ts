// A tripwire over every WRITER of `stages.camera_policy` and `competitions.camera_policy` (Online Chess credits, Task 8, fix round 1,
// review I-3; spec 2026-11-23-online-chess-credits-design.md §7.6, P9, P19).
//
// Why it exists. The camera price is judged where a camera policy CHANGES (`assertCamerasPaidFor`, online-package/format.ts): the
// division save (divisions/patch.ts) is the one door today, and the cameras-doors suite proves it. The brief that built the gate
// said "no stage-level and no competition-level camera save exists" - a premise that lived only in a test header. Nothing KEPT it
// true: the day a stage PATCH or a competition PATCH learns a `camera_policy` field, a PAID division could turn the Fair-play camera
// on without paying for it, behind a green suite. This test is what keeps the premise true: it reads every non-test source file
// under apps/web/src and fails when a writer of either column appears, naming `assertCamerasPaidFor`.
//
// What a writer is (SQL and ORM alike; comments never count, strings do - SQL lives in them):
//   sql-update   `update stages|competitions [alias] set <list>` whose SET LIST (to the statement's top-level where/from/returning)
//                names camera_policy - a read in the WHERE clause is not a write;
//   sql-insert   `insert into stages|competitions (<columns>)` naming camera_policy, or a dynamic `insert into ... ${row}` whose
//                interpolation names it;
//   dynamic      an `update ... set ${helper(...)}` / `insert into ... ${...}` statement on either table in a file that names
//                camera_policy anywhere in its code (the column allowlist a helper takes lives beside the statement, e.g.
//                usecases/competitions.ts's `update competitions set ${q(values, ...cols)}`);
//   orm-write    `.update(stages|competitions)` / `.insert(...)` / `.insertInto("...")` (drizzle, kysely) followed, to the end of its
//                statement, by camera_policy / cameraPolicy.
// `divisions.camera_policy` is NOT in scope: its two writers are divisions/create.ts (a new division is unpaid: nothing to price) and
// divisions/patch.ts (gated, cameras-doors.test.ts).
//
// A writer may be added: name its file in EXPECTED_WRITERS below with the count of writes, and the file must call
// `assertCamerasPaidFor(` (or the helper `divisionsNeedingCameraUpgrade(` it wraps) - and a test of that door's refusal belongs with it.
//
// Anti-vacuity (TEST-STRATEGY.md): the scan reports the files it read and the statements it saw, and zero scanned is a FAILURE; the
// scanner is proven on synthetic sources first (every writer form is flagged, every look-alike is not), so "no writers found" cannot
// mean "the scanner sees nothing".
//
// Mutants (each run once by hand; results in the commit message):
//   T1 an added stage writer is not found      (a probe file `update stages set camera_policy` placed under src)   -> the tree scan
//   T2 the SET-LIST test reads the whole statement (a WHERE read counts as a write)                                -> "a read in WHERE"
//   T3 JS comments are not blanked                                                                                  -> "comments never count"
//   T4 the dynamic rule is dropped                                                                                  -> "dynamic helper"
//   T5 the files-scanned floor removed                                                                              -> (self-check: "scanned" floor)
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

type Form = "sql-update" | "sql-insert" | "dynamic" | "orm-write";
type Writer = { form: Form; table: "stages" | "competitions"; line: number };

const TABLE = "(?:\\w+\\.)?\"?(stages|competitions)\"?";
const CAMERA = /\bcamera_?policy\b/i;

/** The source with its JS comments blanked (same length, newlines kept), and every string, quoted or template, as a chunk of raw
 *  text (a template's `${...}` code included, its own comments blanked, SQL `--` and block comments blanked). A small lexer, not a
 *  regex: a `//` inside a string is not a comment, a template nests, and a regex literal's quote opens no string. */
function lex(source: string): { code: string; chunks: { text: string; at: number }[] } {
  const n = source.length;
  const out = source.split("");
  const chunks: { text: string; at: number }[] = [];
  const blank = (a: number, b: number) => {
    for (let k = a; k < b; k++) if (out[k] !== "\n") out[k] = " ";
  };
  const regexAllowed = (i: number): boolean => {
    let k = i - 1;
    while (k >= 0 && /[ \t]/.test(source[k]!)) k--;
    if (k < 0 || source[k] === "\n") return true;
    if ("(,=:[!&|?{};+-*%<>~^".includes(source[k]!)) return true;
    return /\b(?:return|typeof|case|in|of|delete|void|throw|new)$/.test(source.slice(Math.max(0, k - 7), k + 1));
  };
  const skipRegex = (i: number): number => {
    let k = i + 1;
    let inClass = false;
    while (k < n && source[k] !== "\n") {
      const c = source[k]!;
      if (c === "\\") k += 2;
      else if (c === "[") {
        inClass = true;
        k++;
      } else if (c === "]") {
        inClass = false;
        k++;
      } else if (c === "/" && !inClass) {
        k++;
        while (k < n && /[a-z]/i.test(source[k]!)) k++;
        return k;
      } else k++;
    }
    return i + 1; // no closing slash on the line: it was a division (or JSX), not a regex
  };
  const skipQuoted = (i: number, q: string): number => {
    let k = i + 1;
    while (k < n && source[k] !== "\n") {
      if (source[k] === "\\") k += 2;
      else if (source[k] === q) {
        chunks.push({ text: source.slice(i + 1, k), at: i });
        return k + 1;
      } else k++;
    }
    return k; // an unterminated quote ends at its line (JSX text with an apostrophe)
  };
  const template = (i: number): number => {
    let k = i + 1;
    while (k < n) {
      const c = source[k]!;
      if (c === "\\") k += 2;
      else if (c === "`") {
        chunks.push({ text: out.slice(i + 1, k).join(""), at: i });
        return k + 1;
      } else if (c === "$" && source[k + 1] === "{") k = scan(k + 2, true) + 1;
      else k++;
    }
    return n;
  };
  function scan(from: number, untilBrace: boolean): number {
    let i = from;
    let depth = 0;
    while (i < n) {
      const c = source[i]!;
      if (c === "/" && source[i + 1] === "/") {
        let j = source.indexOf("\n", i);
        if (j < 0) j = n;
        blank(i, j);
        i = j;
      } else if (c === "/" && source[i + 1] === "*") {
        let j = source.indexOf("*/", i + 2);
        j = j < 0 ? n : j + 2;
        blank(i, j);
        i = j;
      } else if (c === '"' || c === "'") i = skipQuoted(i, c);
      else if (c === "`") i = template(i);
      else if (c === "/" && regexAllowed(i)) i = skipRegex(i);
      else {
        if (c === "{") depth++;
        else if (c === "}") {
          if (untilBrace && depth === 0) return i;
          depth--;
        }
        i++;
      }
    }
    return i;
  }
  scan(0, false);
  const sqlBlank = (t: string) =>
    t.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " ")).replace(/(^|\s)--(?=\s|$)[^\n]*/gm, (m) => m.replace(/[^\n\s]/g, " "));
  return { code: out.join(""), chunks: chunks.map((c) => ({ ...c, text: sqlBlank(c.text) })) };
}

const lineOf = (source: string, index: number): number => source.slice(0, index).split("\n").length;

/** The set list of an UPDATE: from `from` to the first top-level where / from / returning, or the chunk's end. */
function setList(text: string, from: number): string {
  let depth = 0;
  for (let i = from; i < text.length; i++) {
    const c = text[i]!;
    if (c === "(") depth++;
    else if (c === ")") depth--;
    else if (depth === 0 && /^(?:where|from|returning)\b/i.test(text.slice(i)) && (i === 0 || /\W/.test(text[i - 1]!))) return text.slice(from, i);
  }
  return text.slice(from);
}

/** Every writer of stages.camera_policy / competitions.camera_policy in one source file's text. */
function camerasWriters(source: string): Writer[] {
  const { code, chunks } = lex(source);
  const found: Writer[] = [];
  const fileNamesCamera = CAMERA.test(code);
  const dynamicStatements: { table: Writer["table"]; line: number }[] = [];
  for (const { text, at } of chunks) {
    const base = lineOf(source, at);
    const lineIn = (i: number) => base + text.slice(0, i).split("\n").length - 1;
    for (const m of text.matchAll(new RegExp(`\\bupdate\\s+(?:only\\s+)?${TABLE}(?:\\s+(?:as\\s+)?(?!set\\b)\\w+)?\\s+set\\b`, "gi"))) {
      const list = setList(text, m.index! + m[0].length);
      const table = m[1] as Writer["table"];
      if (CAMERA.test(list)) found.push({ form: "sql-update", table, line: lineIn(m.index!) });
      else if (/^\s*\$\{[\s\S]*\}\s*$/.test(list)) dynamicStatements.push({ table, line: lineIn(m.index!) }); // the whole list is a helper
    }
    for (const m of text.matchAll(new RegExp(`\\binsert\\s+into\\s+${TABLE}\\s*(\\([^)]*\\))?`, "gi"))) {
      const table = m[1] as Writer["table"];
      const rest = text.slice(m.index! + m[0].length);
      if (m[2] !== undefined) {
        if (CAMERA.test(m[2])) found.push({ form: "sql-insert", table, line: lineIn(m.index!) });
      } else if (/^\s*\$\{/.test(rest)) {
        // `insert into stages ${sql(row, ...columns)}`: the columns are the interpolation's.
        if (CAMERA.test(rest.slice(0, rest.search(/\bon\s+conflict\b|\breturning\b|$/i)))) found.push({ form: "sql-insert", table, line: lineIn(m.index!) });
        else dynamicStatements.push({ table, line: lineIn(m.index!) });
      }
    }
  }
  if (fileNamesCamera) for (const d of dynamicStatements) found.push({ form: "dynamic", table: d.table, line: d.line });
  for (const m of code.matchAll(/\.(?:update|insert|insertInto)\(\s*(?:\w+\.)?["']?(stages|competitions)["']?\s*\)/g)) {
    const rest = code.slice(m.index!, m.index! + 800);
    const end = rest.indexOf(";");
    if (CAMERA.test(end < 0 ? rest : rest.slice(0, end))) found.push({ form: "orm-write", table: m[1] as Writer["table"], line: lineOf(source, m.index!) });
  }
  // A template nested in another template is both chunks: one writer, once.
  return found.filter((w, i) => found.findIndex((x) => x.form === w.form && x.table === w.table && x.line === w.line) === i);
}

/** The defects of a scan: a writer in a file nobody named, a named file that wrote more or fewer times than said, or a named file that
 *  never calls the gate. Pure, so the self-test can drive each branch. */
function judge(
  found: { file: string; writers: Writer[] }[],
  expected: { file: string; count: number }[],
  callsGate: (file: string) => boolean,
): string[] {
  const defects: string[] = [];
  for (const { file, writers } of found) {
    const want = expected.find((e) => e.file === file);
    if (want === undefined) {
      for (const w of writers) {
        defects.push(
          `${file}:${w.line}: a ${w.form} of ${w.table}.camera_policy. A camera policy that can turn the Fair-play camera ON must be priced: call ` +
            `assertCamerasPaidFor(tx, [divisionId, ...]) (server/usecases/online-package/format.ts) in the same transaction after the write, as ` +
            `divisions/patch.ts does, then name this file in EXPECTED_WRITERS with a test of the refusal`,
        );
      }
    } else {
      if (writers.length !== want.count) defects.push(`${file}: ${writers.length} writers of camera_policy, EXPECTED_WRITERS says ${want.count}`);
      if (!callsGate(file)) defects.push(`${file}: writes camera_policy but never calls assertCamerasPaidFor / divisionsNeedingCameraUpgrade`);
    }
  }
  for (const e of expected) {
    if (!found.some((f) => f.file === e.file)) defects.push(`${e.file}: named in EXPECTED_WRITERS but no longer writes camera_policy - remove it`);
  }
  return defects;
}

describe("the scanner, on synthetic sources (a writer is flagged, a look-alike is not)", () => {
  const flagged = (source: string): string[] => camerasWriters(source).map((w) => `${w.form}:${w.table}`);

  it("flags every writer form, across lines, with its line", () => {
    const cases: [string, string, string][] = [
      ["update, set list across lines", "const q = tx`\n  update stages s\n     set name = ${n},\n         camera_policy = ${p}\n   where s.id = ${id}`;", "sql-update:stages"],
      ["update, camera_policy after a subquery in the list", "tx`update competitions set name = (select max(x) from t where y), camera_policy = 'off' where id = 1`", "sql-update:competitions"],
      ["update with an alias and AS", "tx`update stages as st set camera_policy = null`", "sql-update:stages"],
      ["update of a schema-qualified table", "tx`update public.stages set camera_policy = 'required'`", "sql-update:stages"],
      ["insert, column list across lines", "tx`insert into competitions (org_id,\n  camera_policy, name)\n values (1, 2, 3)`", "sql-insert:competitions"],
      ["insert with a dynamic row naming the column", "tx`insert into stages ${tx(row, 'id', 'camera_policy')}`", "sql-insert:stages"],
      ["update with a dynamic set list naming the column", "tx`update stages set ${tx({ camera_policy: p })} where id = 1`", "sql-update:stages"],
      ["a plain quoted SQL string", "sql.unsafe(\"update stages set camera_policy = 'x'\")", "sql-update:stages"],
      ["drizzle-style update", "await db.update(stages).set({ name, camera_policy: p }).where(eq(stages.id, id));", "orm-write:stages"],
      ["drizzle-style insert, camelCase", "await db.insert(competitions).values({ orgId, cameraPolicy: p });", "orm-write:competitions"],
      ["kysely-style insertInto", "await db.insertInto('stages').values({ camera_policy: p }).execute();", "orm-write:stages"],
    ];
    let checked = 0;
    for (const [what, source, want] of cases) {
      expect(flagged(source), what).toEqual([want]);
      checked += 1;
    }
    expect(checked, "anti-vacuity: writer forms proven").toBe(11);
    expect(camerasWriters(cases[0]![1])[0]!.line, "the line is the statement's first").toBe(2);
  });

  it("a dynamic helper (the column allowlist lives beside the statement) is a writer only in a file that names camera_policy", () => {
    const helper = "tx`update competitions set ${q(values, ...cols)} where id = ${id}`";
    expect(flagged(helper), "a dynamic helper and no camera_policy anywhere").toEqual([]);
    expect(flagged(`const cols = ["name", "camera_policy"];\n${helper}`), "dynamic helper").toEqual(["dynamic:competitions"]);
    expect(flagged(`const cols = ["name"];\n${helper}\n// camera_policy is not a column of this`), "a comment's mention does not count").toEqual([]);
    expect(flagged("tx`insert into stages ${tx(row)}`\nconst k = 'camera_policy';"), "dynamic insert").toEqual(["dynamic:stages"]);
  });

  it("does not flag a look-alike", () => {
    const cases: [string, string][] = [
      ["a read in WHERE", "tx`update stages set status = 'x' where camera_policy is null`"],
      ["a read in RETURNING", "tx`update stages set status = 'x' returning camera_policy`"],
      ["a read of the column", "tx`select s.camera_policy from stages s join competitions c on c.id = s.competition_id`"],
      ["a division write", "tx`update divisions set camera_policy = ${p} where id = ${id}`"],
      ["a division insert", "tx`insert into divisions (name, camera_policy) values (1, 2)`"],
      ["another column of the same table", "tx`update stages set config = config || '{}' where id = 1`"],
      ["a // comment", "// update stages set camera_policy = 'x'\nconst a = 1;"],
      ["a block comment", "/* tx`update competitions set camera_policy = 'x'` */ const a = 1;"],
      ["a block comment inside an interpolation", "tx`update stages set name = ${/* camera_policy */ n} where id = 1`"],
      ["an SQL -- comment", "tx`update stages set name = 'x' -- camera_policy = 1\n where id = 1`"],
      ["an SQL block comment", "tx`update stages set name = 'x' /* camera_policy */ where id = 1`"],
      ["a table that merely starts like one", "tx`update stages_archive set camera_policy = 1`"],
      ["an ORM write of another table", "await db.update(divisions).set({ camera_policy: p });"],
      ["an ORM read", "await db.select({ p: stages.camera_policy }).from(stages);"],
    ];
    let checked = 0;
    for (const [what, source] of cases) {
      expect(flagged(source), what).toEqual([]);
      checked += 1;
    }
    expect(checked, "anti-vacuity: look-alikes proven").toBe(14);
  });

  it("reads past a `//` in a string, a nested template and a regex literal's quote, and still finds the write", () => {
    const writes = "tx`update stages set camera_policy = ${p}`";
    expect(flagged(`const u = "https://example.test/x"; ${writes}`), "// inside a string is not a comment").toEqual(["sql-update:stages"]);
    expect(flagged(`const t = \`a\${\`b\${1}\`}c\`; ${writes}`), "a template nested in a template").toEqual(["sql-update:stages"]);
    expect(flagged(`const r = /['"]x/; ${writes}`), "a regex literal's quote opens no string").toEqual(["sql-update:stages"]);
    expect(flagged(`const half = a / b; ${writes} // trailing`), "a division is not a regex").toEqual(["sql-update:stages"]);
  });

  it("judges: an unnamed writer fails with the gate's name; a named one needs its count and the gate call; a stale name fails", () => {
    const w = (line: number): Writer => ({ form: "sql-update", table: "stages", line });
    const calls = (f: string) => f === "a.ts";
    const unnamed = judge([{ file: "x.ts", writers: [w(3)] }], [], calls);
    expect(unnamed).toHaveLength(1);
    expect(unnamed[0], "the message points at the gate").toContain("assertCamerasPaidFor");
    expect(judge([{ file: "a.ts", writers: [w(1)] }], [{ file: "a.ts", count: 1 }], calls), "named, counted, gated").toEqual([]);
    expect(judge([{ file: "a.ts", writers: [w(1), w(2)] }], [{ file: "a.ts", count: 1 }], calls), "a second write is not waved through").toHaveLength(1);
    expect(judge([{ file: "b.ts", writers: [w(1)] }], [{ file: "b.ts", count: 1 }], calls), "named but never calls the gate").toHaveLength(1);
    expect(judge([], [{ file: "a.ts", count: 1 }], calls), "a stale name").toHaveLength(1);
  });
});

describe("every non-test source under apps/web/src", () => {
  // Typed here, not derived from the code: the writers the product has (none), and files that name the column and so prove the scan
  // reads real code (the readers and the two divisions writers).
  const EXPECTED_WRITERS: { file: string; count: number }[] = [];
  const SRC = join(import.meta.dirname, "..", "..", "..", "..");
  const walk = (dir: string): string[] =>
    readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
      const full = join(dir, e.name);
      if (e.isDirectory()) return e.name === "__tests__" || e.name === "__fixtures__" || e.name === "node_modules" ? [] : walk(full);
      return /\.tsx?$/.test(e.name) && !/\.test\./.test(e.name) && !/\.d\.ts$/.test(e.name) ? [full] : [];
    });

  it("none writes stages.camera_policy or competitions.camera_policy without pricing the camera", () => {
    const files = walk(SRC);
    expect(files.length, "anti-vacuity: source files scanned").toBeGreaterThan(500);
    const found: { file: string; writers: Writer[] }[] = [];
    const gate = new Map<string, boolean>();
    let namingCamera = 0;
    let statements = 0;
    for (const abs of files) {
      const rel = abs.slice(SRC.length + 1);
      const source = readFileSync(abs, "utf8");
      const { code, chunks } = lex(source);
      if (CAMERA.test(code)) namingCamera += 1;
      for (const { text } of chunks) statements += (text.match(/\b(?:update\s+\w+\s+set|insert\s+into\s+\w+)\b/gi) ?? []).length;
      const writers = camerasWriters(source);
      if (writers.length > 0) found.push({ file: rel, writers });
      gate.set(rel, /\b(?:assertCamerasPaidFor|divisionsNeedingCameraUpgrade)\(/.test(code));
    }
    // The scan read real code: files that name the column (the readers and the divisions doors) and the SQL statements it saw.
    expect(namingCamera, "anti-vacuity: files naming camera_policy in code (readers, divisions create/patch)").toBeGreaterThanOrEqual(5);
    expect(statements, "anti-vacuity: UPDATE/INSERT statements seen across every table").toBeGreaterThan(200);
    const defects = judge(found, EXPECTED_WRITERS, (f) => gate.get(f) === true);
    expect(defects.join("\n"), "no unpriced writer of stages.camera_policy / competitions.camera_policy").toBe("");
    expect(found.length, "writers found, as EXPECTED_WRITERS says").toBe(EXPECTED_WRITERS.length);
  });
});
