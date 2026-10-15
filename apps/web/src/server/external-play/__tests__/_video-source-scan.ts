// D16 (design §5.6.1, §5.6.3) - the machinery of the two source guards, kept apart from the rules they enforce so it can be
// tested on its own (video-per-player-source-guard.test.ts does both).
//
// WHY A SCANNER AND NOT A GREP. A statement that touches `fixture_video_meetings` by `fixture_id` alone was correct while a
// fixture had ONE meeting and is wrong now that it has two (a join that lands on the other player's row, a delete that takes
// both, a `const [row]` that takes either one). The bug is invisible to a type checker and, in a database test, to anything
// that seeds one meeting. So the rule is held at the source: every TABLE REFERENCE that reaches one of the three video tables
// by `fixture_id` must name `side` in its OWN predicate. A reference, not a statement: "a key elsewhere in the same statement
// does not count for it" (a join on `fixture_id` alone, in a statement whose other table is keyed by `participant_id`, is
// exactly the bug the guard exists for).
//
// HOW. `lex` walks TypeScript source once, blanks comments, and collects every string and template literal as a CHUNK (a
// `${expression}` becomes a placeholder; a template nested in an expression is its own chunk). `tokenize` turns a chunk into
// words and symbols with their parenthesis depth. `judgeChunk` finds each reference (`from`, `join`, `update`, `insert into`,
// `delete from` followed by a video table) and reads off the key names in the reference's own predicate:
//   - a `join`'s own `on`, plus the `where` conjuncts that mention its alias;
//   - a `from`/`update`/`delete`'s `where` conjuncts that mention its alias (all of them when it has no alias);
//   - an `insert`'s column list.
// A sub-select's interior never counts for the reference around it, and a conjunct that is only about another table's alias
// never counts for this one.
//
// WHAT IT REFUSES TO GUESS. A mention of a video table that is not one of those five shapes (`lock table`, `using`, a plain
// string) is UNCLASSIFIED and fails the guard, and so does a lexer that finds a different number of mentions than a plain
// text search does (a regex literal or a quote it misread). A scanner that quietly saw less would pass everything.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

export const VIDEO_TABLES = ["fixture_video_meetings", "fixture_video_participants", "fixture_video_guard_faults"] as const;
export type VideoTable = (typeof VIDEO_TABLES)[number];
const TABLE_SET = new Set<string>(VIDEO_TABLES);

// ─── Source files ───────────────────────────────────────────────────────────────────────────────────────────────────

/** Every non-test `.ts`/`.tsx` file under `root`, as paths relative to it. Tests, fixtures, `node_modules` and `.d.ts` files
 *  are not production code. */
export function productionSources(root: string): string[] {
  const out: string[] = [];
  const walk = (dir: string): void => {
    for (const name of readdirSync(dir)) {
      if (name === "node_modules" || name === "__tests__" || name === "__fixtures__" || name === "__mocks__") continue;
      const full = join(dir, name);
      const st = statSync(full);
      if (st.isDirectory()) walk(full);
      else if (/\.tsx?$/.test(name) && !/\.d\.ts$/.test(name) && !/\.(test|spec)\.tsx?$/.test(name)) out.push(relative(root, full));
    }
  };
  walk(root);
  return out.sort();
}

// ─── The lexer: TypeScript source to SQL chunks ─────────────────────────────────────────────────────────────────────

export type Chunk = { text: string; offset: number };
export type Lexed = {
  /** The source with every comment replaced by spaces (offsets and line numbers are unchanged). */
  live: string;
  chunks: Chunk[];
  /** Code outside every string, template and comment (strings are shown as `""`). */
  code: string;
};

const REGEX_PREV = new Set(["", "(", ",", "=", ":", "[", "!", "&", "|", "?", "{", "}", ";", "+", "-", "*", "%", "<", ">", "~", "^"]);
const REGEX_KEYWORDS = new Set(["return", "typeof", "case", "do", "else", "in", "of", "void", "yield", "await", "delete", "throw", "new"]);

export function lex(src: string): Lexed {
  const chunks: Chunk[] = [];
  let code = "";
  let live = "";
  let prevSig = "";
  let prevWord = "";

  const blank = (from: number, to: number): string => src.slice(from, to).replace(/[^\n]/g, " ");

  /** A template literal starting at the backtick at `i`; returns the index after its closing backtick. */
  function template(i: number): number {
    const open = i;
    let text = "";
    i += 1;
    while (i < src.length) {
      const c = src[i]!;
      if (c === "\\") {
        text += src.slice(i, i + 2);
        i += 2;
      } else if (c === "`") {
        chunks.push({ text, offset: open });
        live += src.slice(open, i + 1);
        return i + 1;
      } else if (c === "$" && src[i + 1] === "{") {
        const end = expression(i + 2);
        text += " $X ";
        i = end;
      } else {
        text += c;
        i += 1;
      }
    }
    throw new Error(`lex: unterminated template literal at offset ${open}`);
  }

  /** The JS after `${` up to its matching `}`; returns the index after it. Templates inside become chunks of their own. */
  function expression(i: number): number {
    let depth = 0;
    const savedLive = live;
    const savedCode = code;
    const savedSig = prevSig;
    const savedWord = prevWord;
    while (i < src.length) {
      const c = src[i]!;
      if (c === "}" && depth === 0) {
        live = savedLive;
        code = savedCode;
        prevSig = savedSig;
        prevWord = savedWord;
        return i + 1;
      }
      if (c === "{") depth += 1;
      if (c === "}") depth -= 1;
      i = step(i);
    }
    throw new Error("lex: unterminated ${ expression");
  }

  /** One lexical element of code at `i`; returns the next index. */
  function step(i: number): number {
    const c = src[i]!;
    const n = src[i + 1];
    if (c === "/" && n === "/") {
      let j = i;
      while (j < src.length && src[j] !== "\n") j += 1;
      live += blank(i, j);
      return j;
    }
    if (c === "/" && n === "*") {
      const e = src.indexOf("*/", i + 2);
      if (e < 0) throw new Error(`lex: unterminated comment at offset ${i}`);
      live += blank(i, e + 2);
      return e + 2;
    }
    if (c === "'" || c === '"') {
      let j = i + 1;
      let text = "";
      while (j < src.length && src[j] !== c) {
        if (src[j] === "\n") throw new Error(`lex: unterminated string at offset ${i}`);
        if (src[j] === "\\") {
          text += src.slice(j, j + 2);
          j += 2;
        } else {
          text += src[j];
          j += 1;
        }
      }
      if (j >= src.length) throw new Error(`lex: unterminated string at offset ${i}`);
      chunks.push({ text, offset: i });
      live += src.slice(i, j + 1);
      code += '""';
      prevSig = c;
      prevWord = "";
      return j + 1;
    }
    if (c === "`") {
      const e = template(i);
      code += "``";
      prevSig = "`";
      prevWord = "";
      return e;
    }
    if (c === "/") {
      if (REGEX_PREV.has(prevSig) || REGEX_KEYWORDS.has(prevWord)) {
        let j = i + 1;
        let inClass = false;
        while (j < src.length) {
          const d = src[j]!;
          if (d === "\n") throw new Error(`lex: unterminated regex at offset ${i}`);
          if (d === "\\") j += 2;
          else if (d === "[") {
            inClass = true;
            j += 1;
          } else if (d === "]") {
            inClass = false;
            j += 1;
          } else if (d === "/" && !inClass) break;
          else j += 1;
        }
        j += 1;
        while (j < src.length && /[a-z]/i.test(src[j]!)) j += 1;
        live += src.slice(i, j);
        code += "/re/";
        prevSig = "/";
        prevWord = "";
        return j;
      }
    }
    live += c;
    code += c;
    if (/[A-Za-z0-9_$]/.test(c)) {
      prevWord = /[A-Za-z0-9_$]/.test(src[i - 1] ?? "") ? prevWord + c : c;
      prevSig = c;
    } else if (!/\s/.test(c)) {
      prevSig = c;
      prevWord = "";
    }
    return i + 1;
  }

  let i = 0;
  while (i < src.length) i = step(i);
  return { live, chunks, code };
}

// ─── The SQL tokenizer ──────────────────────────────────────────────────────────────────────────────────────────────

export type Tok = { t: string; d: number; off: number };

/** Words (lower-cased), parentheses and single-character symbols, each with its parenthesis depth (an opening and its closing
 *  parenthesis share the depth OUTSIDE the group). Strings collapse to `'s'`, numbers to `0`, `$…` placeholders to `$x`. */
export function tokenize(sql: string): { toks: Tok[]; balanced: boolean } {
  const toks: Tok[] = [];
  let d = 0;
  let balanced = true;
  let i = 0;
  while (i < sql.length) {
    const c = sql[i]!;
    if (/\s/.test(c)) {
      i += 1;
    } else if (c === "-" && sql[i + 1] === "-") {
      while (i < sql.length && sql[i] !== "\n") i += 1;
    } else if (c === "/" && sql[i + 1] === "*") {
      const e = sql.indexOf("*/", i + 2);
      i = e < 0 ? sql.length : e + 2;
    } else if (c === "'") {
      let j = i + 1;
      while (j < sql.length) {
        if (sql[j] === "'") {
          if (sql[j + 1] === "'") j += 2;
          else break;
        } else j += 1;
      }
      toks.push({ t: "'s'", d, off: i });
      i = j + 1;
    } else if (c === '"') {
      const e = sql.indexOf('"', i + 1);
      toks.push({ t: sql.slice(i + 1, e < 0 ? sql.length : e).toLowerCase(), d, off: i });
      i = e < 0 ? sql.length : e + 1;
    } else if (/[A-Za-z_]/.test(c)) {
      let j = i;
      while (j < sql.length && /[A-Za-z0-9_$]/.test(sql[j]!)) j += 1;
      toks.push({ t: sql.slice(i, j).toLowerCase(), d, off: i });
      i = j;
    } else if (c === "$") {
      let j = i + 1;
      while (j < sql.length && /[A-Za-z0-9_]/.test(sql[j]!)) j += 1;
      toks.push({ t: "$x", d, off: i });
      i = j;
    } else if (/[0-9]/.test(c)) {
      let j = i;
      while (j < sql.length && /[0-9.]/.test(sql[j]!)) j += 1;
      toks.push({ t: "0", d, off: i });
      i = j;
    } else if (c === "(") {
      toks.push({ t: "(", d, off: i });
      d += 1;
      i += 1;
    } else if (c === ")") {
      d -= 1;
      if (d < 0) {
        balanced = false;
        d = 0;
      }
      toks.push({ t: ")", d, off: i });
      i += 1;
    } else {
      toks.push({ t: c, d, off: i });
      i += 1;
    }
  }
  if (d !== 0) balanced = false;
  return { toks, balanced };
}

// ─── Judging references ─────────────────────────────────────────────────────────────────────────────────────────────

export type RefKind = "from" | "join" | "update" | "delete" | "insert";

export type Outcome =
  | "side" //             counted; its own predicate names `side`
  | "participant_id" //   counted; a participants reference keyed by participant_id (names no side)
  | "missing_side" //     counted; fixture-keyed and names neither: a violation unless allow-listed
  | "other_key" //        not fixture-keyed: reached by meeting_id or a primary key, so not counted
  | "bare_side" //        a bare scan (no key at all) whose select list names `side`
  | "bare_pk" //          a bare scan whose rows are identified by their own primary key
  | "bare_no_side" //     a bare scan that selects neither: a violation
  | "unkeyed_write" //    an update/delete/insert with no recognisable key: a violation
  | "unparseable"; //     the chunk's parentheses do not balance around the reference: a violation

export type Judged = {
  file: string;
  /** The top-level function the statement sits in ("" when none is found). */
  fn: string;
  line: number;
  table: VideoTable;
  kind: RefKind;
  alias: string | null;
  names: { fixtureId: boolean; side: boolean; participantId: boolean; meetingId: boolean; id: boolean };
  outcome: Outcome;
};

export type Unclassified = { file: string; line: number; table: string; before: string };

const RESERVED = new Set([
  "set", "where", "on", "join", "left", "right", "inner", "cross", "full", "natural", "using", "from", "order", "group", "limit",
  "returning", "values", "for", "union", "intersect", "except", "having", "offset", "window", "and", "or", "select", "with", "as",
  "when", "then", "else", "end", "do", "is", "in", "not", "null", "default", "lateral", "fetch", "into", "$x", "(", ")", ",", ";",
]);
const ON_END = new Set(["join", "left", "right", "inner", "cross", "full", "natural", "where", "group", "order", "limit", "having", "returning", "union", "intersect", "except", "offset", "for", "window", "set", ";"]);
const WHERE_END = new Set(["group", "order", "limit", "having", "returning", "union", "intersect", "except", "offset", "for", "window", ";"]);
const WHERE_SEARCH_STOP = new Set(["select", "union", "intersect", "except", "returning", ";"]);

function matchParens(toks: Tok[]): { close: number[]; selectGroups: [number, number][] } {
  const close = new Array<number>(toks.length).fill(-1);
  const stack: number[] = [];
  toks.forEach((tok, i) => {
    if (tok.t === "(") stack.push(i);
    else if (tok.t === ")") {
      const open = stack.pop();
      if (open !== undefined) close[open] = i;
    }
  });
  // The parenthesised groups that hold a sub-select.
  const selectGroups: [number, number][] = [];
  toks.forEach((tok, i) => {
    if (tok.t !== "(" || close[i]! < 0) return;
    for (let j = i + 1; j < close[i]!; j += 1) {
      if (toks[j]!.t === "select") {
        selectGroups.push([i, close[i]!]);
        break;
      }
    }
  });
  return { close, selectGroups };
}

/** The indexes of a clause that starts at `start`: tokens at the reference's depth or deeper, up to a terminator word at the
 *  reference's own depth or the group's closing parenthesis. */
function clause(toks: Tok[], start: number, depth: number, ends: ReadonlySet<string>): number[] {
  const out: number[] = [];
  for (let j = start; j < toks.length; j += 1) {
    const tok = toks[j]!;
    if (tok.d < depth) break;
    if (tok.d === depth && ends.has(tok.t)) break;
    out.push(j);
  }
  return out;
}

/** Splits a clause on `and` at its own depth. */
function conjuncts(toks: Tok[], idx: number[], depth: number): number[][] {
  const out: number[][] = [[]];
  for (const j of idx) {
    if (toks[j]!.d === depth && toks[j]!.t === "and") out.push([]);
    else out[out.length - 1]!.push(j);
  }
  return out.filter((c) => c.length > 0);
}

function judgeChunk(text: string, file: string, fn: string, lineAt: (off: number) => number): { judged: Judged[]; unclassified: Unclassified[] } {
  const { toks, balanced } = tokenize(text);
  const { close, selectGroups } = matchParens(toks);
  const judged: Judged[] = [];
  const unclassified: Unclassified[] = [];

  toks.forEach((tok, k) => {
    if (!TABLE_SET.has(tok.t)) return;
    const table = tok.t as VideoTable;
    // What precedes the table name decides what kind of mention it is.
    let p = k - 1;
    if (toks[p]?.t === "only") p -= 1;
    const prev = toks[p]?.t;
    let kind: RefKind | null = null;
    if (prev === "join") kind = "join";
    else if (prev === "update") kind = "update";
    else if (prev === "into" && toks[p - 1]?.t === "insert") kind = "insert";
    else if (prev === "from") kind = toks[p - 1]?.t === "delete" ? "delete" : "from";
    if (kind === null) {
      unclassified.push({ file, line: lineAt(tok.off), table, before: toks.slice(Math.max(0, k - 3), k).map((x) => x.t).join(" ") });
      return;
    }

    // The alias, if there is one.
    let n = k + 1;
    if (toks[n]?.t === "as") n += 1;
    const aliasTok = toks[n];
    const alias = aliasTok && /^[a-z_][a-z0-9_]*$/.test(aliasTok.t) && !RESERVED.has(aliasTok.t) && !TABLE_SET.has(aliasTok.t) ? aliasTok.t : null;
    const afterRef = alias ? n + 1 : k + 1;
    const depth = tok.d;

    // What is inside a sub-select OPENED AFTER this reference (so one nested in its statement, not one that holds it) is
    // judged as that sub-select's own references and never counts for this one.
    const nested = (j: number): boolean => selectGroups.some(([open, end]) => open > k && open < j && j < end);
    const keep = (idxs: number[]): number[] => idxs.filter((j) => !nested(j));
    const mentionsAlias = (conj: number[]): boolean => {
      const quals = new Set<string>();
      for (const j of conj) if (toks[j + 1]?.t === "." && /^[a-z_]/.test(toks[j]!.t)) quals.add(toks[j]!.t);
      if (!alias) return true;
      return quals.size === 0 || quals.has(alias);
    };

    let predicate: number[] = [];
    if (kind === "insert") {
      if (toks[k + 1]?.t === "(" && close[k + 1]! >= 0) for (let j = k + 2; j < close[k + 1]!; j += 1) predicate.push(j);
    } else {
      if (kind === "join" && toks[afterRef]?.t === "on") {
        for (const c of conjuncts(toks, keep(clause(toks, afterRef + 1, depth, ON_END)), depth)) if (mentionsAlias(c)) predicate.push(...c);
      }
      // The first `where` at this depth after the reference (a bare scan may have none, or one about other tables only).
      let w = -1;
      for (let j = afterRef; j < toks.length; j += 1) {
        const x = toks[j]!;
        if (x.d < depth) break;
        if (x.d === depth && WHERE_SEARCH_STOP.has(x.t)) break;
        if (x.d === depth && x.t === "where") {
          w = j;
          break;
        }
      }
      if (w >= 0) {
        for (const c of conjuncts(toks, keep(clause(toks, w + 1, depth, WHERE_END)), depth)) if (mentionsAlias(c)) predicate.push(...c);
      }
    }
    predicate = predicate.filter((j) => !nested(j));

    const has = (w: string): boolean => predicate.some((j) => toks[j]!.t === w);
    const names = { fixtureId: has("fixture_id"), side: has("side"), participantId: has("participant_id"), meetingId: has("meeting_id"), id: has("id") };

    let outcome: Outcome;
    if (!balanced) outcome = "unparseable";
    else if (names.fixtureId) {
      if (names.side) outcome = "side";
      else if (table === "fixture_video_participants" && names.participantId && kind !== "insert") outcome = "participant_id";
      else outcome = "missing_side";
    } else if (kind !== "insert" && ((table === "fixture_video_meetings" && names.meetingId) || names.id || (table === "fixture_video_participants" && names.participantId))) {
      outcome = "other_key";
    } else if (kind === "from" || kind === "join") {
      // A bare scan: it must select `side` (a per-row consumer needs it) or be identified by its own primary key.
      let s = -1;
      for (let j = k - 1; j >= 0; j -= 1) {
        if (toks[j]!.d < depth) break;
        if (toks[j]!.d === depth && toks[j]!.t === "select") {
          s = j;
          break;
        }
      }
      const list: number[] = [];
      if (s >= 0) {
        for (let j = s + 1; j < toks.length; j += 1) {
          if (toks[j]!.d < depth) break;
          if (toks[j]!.d === depth && toks[j]!.t === "from") break;
          if (!nested(j)) list.push(j);
        }
      }
      const qual = alias ?? table;
      const selectsSide = list.some((j) => toks[j]!.t === "side");
      const selectsPk = list.some((j) => toks[j]!.t === qual && toks[j + 1]?.t === "." && toks[j + 2]?.t === "id");
      outcome = selectsSide ? "bare_side" : selectsPk ? "bare_pk" : "bare_no_side";
    } else {
      outcome = "unkeyed_write";
    }
    judged.push({ file, fn, line: lineAt(tok.off), table, kind, alias, names, outcome });
  });
  return { judged, unclassified };
}

/** The top-level function a character offset sits in: the last `function name` / `const name = (` that starts a line at
 *  column 0 before it. */
function enclosingFn(live: string, offset: number): string {
  const head = live.slice(0, offset);
  let last = "";
  const re = /^(?:export\s+)?(?:default\s+)?(?:async\s+)?function\s*\*?\s*([A-Za-z0-9_$]+)|^(?:export\s+)?const\s+([A-Za-z0-9_$]+)\s*(?::[^=\n]+)?=\s*(?:async\s*)?(?:\(|[A-Za-z0-9_$]+\s*=>)/gm;
  for (let m = re.exec(head); m; m = re.exec(head)) last = m[1] ?? m[2] ?? last;
  return last;
}

export type SourceScan = {
  file: string;
  judged: Judged[];
  unclassified: Unclassified[];
  /** Table names in comment-free source by plain text search, and those the SQL tokenizer found in chunks. They must agree. */
  mentionsPlain: number;
  mentionsTokenized: number;
  /** Table names in code outside every string and template. */
  mentionsInCode: number;
};

const TABLE_RE = new RegExp(`\\b(?:${VIDEO_TABLES.join("|")})\\b`, "g");

/** Judges every reference to a video table in one source file. */
export function scanSource(source: string, file: string): SourceScan {
  const { live, chunks, code } = lex(source);
  const lineAt = (offset: number) => live.slice(0, offset).split("\n").length;
  const judged: Judged[] = [];
  const unclassified: Unclassified[] = [];
  let mentionsTokenized = 0;
  for (const chunk of chunks) {
    if (!VIDEO_TABLES.some((t) => chunk.text.includes(t))) continue;
    const fn = enclosingFn(live, chunk.offset);
    const r = judgeChunk(chunk.text, file, fn, (off) => lineAt(chunk.offset) + chunk.text.slice(0, off).split("\n").length - 1);
    judged.push(...r.judged);
    unclassified.push(...r.unclassified);
    mentionsTokenized += tokenize(chunk.text).toks.filter((x) => TABLE_SET.has(x.t)).length;
  }
  return {
    file,
    judged,
    unclassified,
    mentionsPlain: (live.match(TABLE_RE) ?? []).length,
    mentionsTokenized,
    mentionsInCode: (code.match(TABLE_RE) ?? []).length,
  };
}

// ─── The allow-list ─────────────────────────────────────────────────────────────────────────────────────────────────

export type BothSides = {
  /** Path under `apps/web/src/server`. */
  file: string;
  fn: string;
  table: VideoTable;
  /** How many references in that function are meant to be both-sides. A different number, fewer or more, fails. */
  times: number;
  reason: string;
};

export type Verdict = {
  /** `missing_side`/`bare_no_side`/`unkeyed_write`/`unparseable` references nothing allows. */
  violations: Judged[];
  /** Entries whose function and table no longer hold exactly `times` such references. */
  stale: { entry: BothSides; found: number }[];
  /** References the allow-list took. */
  allowed: Judged[];
};

const BAD = new Set<Outcome>(["missing_side", "bare_no_side", "unkeyed_write", "unparseable"]);

export function applyAllowList(judged: readonly Judged[], allow: readonly BothSides[], serverRoot = "server/"): Verdict {
  const violations: Judged[] = [];
  const allowed: Judged[] = [];
  const found = new Map<BothSides, number>(allow.map((e) => [e, 0]));
  for (const ref of judged) {
    if (!BAD.has(ref.outcome)) continue;
    const entry = ref.outcome === "missing_side" ? allow.find((e) => serverRoot + e.file === ref.file && e.fn === ref.fn && e.table === ref.table) : undefined;
    if (entry) {
      found.set(entry, found.get(entry)! + 1);
      allowed.push(ref);
    } else violations.push(ref);
  }
  const stale = [...found].filter(([e, n]) => n !== e.times).map(([entry, n]) => ({ entry, found: n }));
  return { violations, stale, allowed };
}

export type Tally = {
  references: number;
  counted: number;
  side: number;
  /** Counted references of a participants table that name `participant_id` (with or without a side). */
  participantId: number;
  /** Of those, the ones that pass ONLY on it: the exemption actually in use. */
  participantIdOnly: number;
  otherKey: number;
  bare: number;
  allowed: number;
  perTable: Record<VideoTable, number>;
};

export function tally(judged: readonly Judged[], allowed: readonly Judged[]): Tally {
  const counted = judged.filter((j) => j.names.fixtureId);
  return {
    references: judged.length,
    counted: counted.length,
    side: counted.filter((j) => j.names.side).length,
    participantId: counted.filter((j) => j.table === "fixture_video_participants" && j.kind !== "insert" && j.names.participantId).length,
    participantIdOnly: counted.filter((j) => j.outcome === "participant_id").length,
    otherKey: judged.filter((j) => j.outcome === "other_key").length,
    bare: judged.filter((j) => j.outcome === "bare_side" || j.outcome === "bare_pk").length,
    allowed: allowed.length,
    perTable: Object.fromEntries(VIDEO_TABLES.map((t) => [t, judged.filter((j) => j.table === t).length])) as Record<VideoTable, number>,
  };
}

/** Scans every production source under `root` that names a video table. */
export function scanTree(root: string): { files: number; withTables: SourceScan[] } {
  const files = productionSources(root);
  const withTables: SourceScan[] = [];
  for (const f of files) {
    const src = readFileSync(join(root, f), "utf8");
    if (!VIDEO_TABLES.some((t) => src.includes(t))) continue;
    withTables.push(scanSource(src, f));
  }
  return { files: files.length, withTables };
}

// ─── The camera-report guard (§5.6.3) ───────────────────────────────────────────────────────────────────────────────

export const CAMERA_REPORT_COLUMNS = ["camera_reported", "camera_reported_at"] as const;

/** Source files (relative to `root`) that name a camera-report column in code or in a string, comments excluded. A file the
 *  lexer cannot read is searched whole: stricter, never looser. Files in `exclude` and generated files are not scanned. */
export function filesNamingCameraReport(
  root: string,
  exclude: readonly string[],
): { scanned: number; named: string[]; lexFailures: string[] } {
  const skip = new Set(exclude);
  const named: string[] = [];
  const lexFailures: string[] = [];
  let scanned = 0;
  const re = new RegExp(`\\b(?:${CAMERA_REPORT_COLUMNS.join("|")})\\b`);
  for (const f of productionSources(root)) {
    if (skip.has(f) || /(^|\/)(generated|__generated__)\//.test(f) || /\.generated\.tsx?$/.test(f)) continue;
    scanned += 1;
    const src = readFileSync(join(root, f), "utf8");
    if (!re.test(src)) continue;
    let live = src;
    try {
      live = lex(src).live;
    } catch {
      lexFailures.push(f);
    }
    if (re.test(live)) named.push(f);
  }
  return { scanned, named, lexFailures };
}
