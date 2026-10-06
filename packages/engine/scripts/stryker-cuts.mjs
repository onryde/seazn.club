// W1d Task 15, fix round 1, I1 / T15-CUT (D14; rulings 66, 67): how a Stryker leg takes PART of one source file.
//
// A file too big for one leg (its mutants at the measured cost of one are over the 200-minute split line) is cut into parts
// at top-level STATEMENT boundaries, each cut named by the statement that STARTS the next part (an "anchor": the name an
// `export function`, `const`, `class`, `interface`, `type` or `enum` declares). stryker.groups.mjs declares the cuts
// (STRYKER_SPLITS) and a leg takes a part with `file#N`; this module turns them into the `file:a-b` ranges Stryker's `mutate`
// reads, with the TypeScript parser, whenever a config, the floor or a test needs them.
//
// Why not line numbers (the first build): Stryker keeps a mutant for a range only when the mutant's whole node lies inside it,
// so a boundary inside a statement loses the mutants of every node that spans it (a function body, an object literal), and a
// boundary typed as a line number lands inside a statement the first time anything is added above it. The reviewer ran
// Stryker's own instrumenter over copies of the five split kernels with one blank line added at the top: 3 mutants lost in
// cricket.ts, 2 in football.ts, 1 each in the period, setbased and nested kernels. A cut resolved from an anchor sits right
// after the last line of the statement before it, so whitespace, comments and edits inside any statement cannot move it from
// that statement, no mutant can fall on it, and nothing is lost by construction. test/stryker-cuts.test.ts proves it with
// Stryker's own instrumenter on the real kernels, with an edit at the top of cricket.ts.
//
// MEMBER CUTS (W1d Task 20 pre-step, T20-PRE). A single top-level statement can hold more mutants than a leg may (cricket's
// module object alone is 1,017, and at the hosted cost of one mutant that is over seven hours), so a cut may also fall between
// the MEMBERS of one named declaration: `Host.member` is the member that starts the next part. The members are those of an
// object-literal `const`, of a class, and of a function's body (its statements, `return` as one of them, then the members of
// the object that `return` ends with). The first member is never an anchor (a cut before it leaves only the declaration's
// opening line above). A member cut CANNOT be loss-free, unlike a statement cut: the node that contains the cut (the object
// literal, the function body) lies inside no part, and Stryker drops a mutant whose node is in no range. That loss is the
// container's own mutant ("replace the whole object with {}", "empty the whole body"), and nothing else; test/stryker-cuts.test.ts
// measures it with Stryker's own instrumenter on every real split file and holds it to those containers. Those mutants are
// never scored: the instrumenter DOES make them (an emptied body can be killed, or can survive), but no part holds them, so no
// leg runs them and no report counts them. stryker-unscored.json names each by file, mutator, replacement and line text (the line number is information only), and test/stryker-sizing.test.ts
// holds it equal to what the instrumenter finds; its count is the whole of the loss.
//
// A body statement that DECLARES NOTHING (an `if`, a `for`, a `switch`, a call) is named by its kind and its place among the
// body's statements of that kind (T20 step 2): `Host.if#3` is the third `if` of the body, `for#1`, `while#1`, `switch#1`, `try#1`,
// `throw#1`, `block#1` and `expr#1` (an expression statement) likewise. Football's `arbitraryEvent` is one `const roll` and then an
// `if` chain that holds 261 of its 336 mutants, and no declared name falls inside the chain, so before this it could not be cut at
// all. The ordinal counts only the statements that declare nothing, so an `if` added or removed ABOVE a cut renumbers it: the cut
// would then land one statement away from where it was (the parts still tile the file and nothing more is lost, so nothing else
// would notice, and a part's count moves by less than the 10% the sizing test allows for most deletions). So an ordinal anchor is
// PINNED to the statement it starts: stryker-anchors.json records the trimmed first line of that statement, checkAnchorRecords
// reds (test/stryker-cuts.test.ts, on the real files) the moment the Nth `if` starts a different line, and says to RE-CUT (the
// recut helper) and re-record; the plan step (scripts/stryker-matrix.mjs) puts the recorded line into the leg's cache fingerprint, so
// a leg re-cut at a moved anchor never restores the file the old cut wrote.
//
// Plain .mjs, like stryker.groups.mjs: stryker.config.mjs loads it under `stryker`, and the parser is loaded only when a cut is
// resolved, so scripts/stryker-matrix.mjs (which needs only the group names and runs before any install) never touches it.
// scripts/stryker-cuts.d.mts types it for the engine's .ts tests; a test holds the two equal.
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { STRYKER_GROUPS, STRYKER_SPLITS } from "../stryker.groups.mjs";

/** How a range says "to the end of the file": lines added at the foot of a file stay in its last part. */
export const TO_END_OF_FILE = 99999;

const ENGINE = join(dirname(fileURLToPath(import.meta.url)), "..");

/** The engine's own `typescript` (a devDependency), loaded the first time a cut is resolved.
 *  @type {typeof import("typescript") | undefined} */
let tsModule;
function typescript() {
  if (tsModule === undefined) {
    try {
      /** @type {unknown} */
      const loaded = createRequire(import.meta.url)("typescript");
      tsModule = /** @type {typeof import("typescript")} */ (loaded);
    } catch (e) {
      throw new Error(`scripts/stryker-cuts.mjs resolves a cut with the TypeScript parser, and \`typescript\` did not load (run pnpm install): ${e.message}`);
    }
  }
  return tsModule;
}

/** The names one top-level statement declares: a function, class, interface, type alias, enum or namespace by its name, a
 *  `const`/`let`/`var` statement by each name it binds. Other statements (an import, an `export { ... }`, an expression)
 *  declare none, and cannot be anchors.
 *  @param {typeof import("typescript")} ts
 *  @param {import("typescript").Statement} statement
 *  @returns {string[]} */
function declaredNames(ts, statement) {
  if (ts.isVariableStatement(statement)) {
    return statement.declarationList.declarations.flatMap((d) => (ts.isIdentifier(d.name) ? [d.name.text] : []));
  }
  if (
    ts.isFunctionDeclaration(statement) || ts.isClassDeclaration(statement) || ts.isInterfaceDeclaration(statement) ||
    ts.isTypeAliasDeclaration(statement) || ts.isEnumDeclaration(statement) || ts.isModuleDeclaration(statement)
  ) {
    return statement.name !== undefined && ts.isIdentifier(statement.name) ? [statement.name.text] : [];
  }
  return [];
}

/** The TypeScript source file of `text`, and a 1-based line of a position in it. */
function parseText(text) {
  const ts = typescript();
  const source = ts.createSourceFile("cut.ts", text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  return { ts, source, line: (pos) => source.getLineAndCharacterOfPosition(pos).line + 1 };
}

/** The top-level statements of `text`, in source order: `{index, names, startLine, endLine}` with lines 1-based. A statement
 *  starts at its first token (a comment above it, its JSDoc included, belongs to the gap before it) and ends where its last
 *  token does, so the lines of two statements never overlap unless they share a line. */
export function topLevelStatements(text) {
  const { ts, source, line } = parseText(text);
  return source.statements.map((s, index) => ({ index, names: declaredNames(ts, s), startLine: line(s.getStart(source)), endLine: line(s.getEnd()) }));
}

/** The name a property, method or class member declares, or undefined (a spread, a computed key, a destructuring). */
function memberName(ts, node) {
  const n = node.name;
  if (n === undefined) return undefined;
  return ts.isIdentifier(n) || ts.isStringLiteral(n) || ts.isNumericLiteral(n) || ts.isPrivateIdentifier(n) ? n.text : undefined;
}

/** What a statement that declares no name is called when a cut falls before it: `if`, `for` (for, for-in, for-of), `while` (while,
 *  do), `switch`, `try`, `throw`, `block`, `expr` (an expression statement, a call or an assignment), else `stmt`. */
function unnamedKind(ts, statement) {
  if (ts.isIfStatement(statement)) return "if";
  if (ts.isForStatement(statement) || ts.isForInStatement(statement) || ts.isForOfStatement(statement)) return "for";
  if (ts.isWhileStatement(statement) || ts.isDoStatement(statement)) return "while";
  if (ts.isSwitchStatement(statement)) return "switch";
  if (ts.isTryStatement(statement)) return "try";
  if (ts.isThrowStatement(statement)) return "throw";
  if (ts.isBlock(statement)) return "block";
  if (ts.isExpressionStatement(statement)) return "expr";
  return "stmt";
}

/** An expression with its parentheses, `as` and `satisfies` taken off. */
function unwrap(ts, expression) {
  let e = expression;
  while (e !== undefined && (ts.isParenthesizedExpression(e) || ts.isAsExpression(e) || ts.isSatisfiesExpression(e) || ts.isTypeAssertionExpression(e))) e = e.expression;
  return e;
}

/** The members of one node a cut can fall between, in source order, or null when it has none: an object literal (its
 *  properties), a class (its members), a function-like with a block body (the body's statements, `return` named "return", then
 *  the members of the object literal the LAST statement returns), and a `const` statement, a property or a class field bound to
 *  one of those (through its initializer). A member is `{names, startLine, endLine, prevEnd, node}`: `prevEnd` is the last line
 *  of the member before it (null for the first, which is never an anchor), `node` is the member itself (a member that is a
 *  container can be opened in turn), and a member that names nothing (a spread) keeps its place as a neighbour but carries no name.
 *  @returns {{names: string[], startLine: number, endLine: number, prevEnd: number | null, node: import("typescript").Node}[] | null} */
function membersOf(ts, source, line, node) {
  const run = (nodes, namesOf) => {
    let prev = null;
    return nodes.map((n) => {
      const m = { names: namesOf(n), startLine: line(n.getStart(source)), endLine: line(n.getEnd()), prevEnd: prev, node: n };
      prev = m.endLine;
      return m;
    });
  };
  const ofName = (n) => {
    const name = memberName(ts, n);
    return name === undefined ? [] : [name];
  };
  const ofBody = (body) => {
    const stmts = body.statements;
    const ordinals = new Map();
    // A statement that declares nothing (an `if`, a `for`, a `switch`, a call) is named by its kind and its place among the
    // body's statements of that kind: `if#3` is the third `if` of this body (T20, step 2: football's `arbitraryEvent` is ONE
    // `const roll` followed by an `if` chain that holds 261 of its 336 mutants, and no declared name falls inside it).
    const own = run([...stmts], (st) => {
      if (ts.isReturnStatement(st)) return ["return"];
      const declared = declaredNames(ts, st);
      if (declared.length > 0) return declared;
      const kind = unnamedKind(ts, st);
      const n = (ordinals.get(kind) ?? 0) + 1;
      ordinals.set(kind, n);
      return [`${kind}#${n}`];
    });
    const last = stmts[stmts.length - 1];
    const returned = last !== undefined && ts.isReturnStatement(last) ? unwrap(ts, last.expression) : undefined;
    return returned !== undefined && ts.isObjectLiteralExpression(returned) ? [...own, ...run([...returned.properties], ofName)] : own;
  };
  const viaInitializer = (initializer) => (initializer === undefined ? null : membersOf(ts, source, line, unwrap(ts, initializer)));
  if (ts.isClassDeclaration(node) || ts.isClassExpression(node)) return run([...node.members], ofName);
  if (ts.isObjectLiteralExpression(node)) return run([...node.properties], ofName);
  if ((ts.isFunctionDeclaration(node) || ts.isFunctionExpression(node) || ts.isMethodDeclaration(node) || ts.isArrowFunction(node) || ts.isGetAccessor(node) || ts.isSetAccessor(node) || ts.isConstructorDeclaration(node)) && node.body !== undefined && ts.isBlock(node.body)) return ofBody(node.body);
  if (ts.isVariableStatement(node)) return node.declarationList.declarations.length === 1 ? viaInitializer(node.declarationList.declarations[0].initializer) : null;
  if (ts.isVariableDeclaration(node) || ts.isPropertyAssignment(node) || ts.isPropertyDeclaration(node)) return viaInitializer(node.initializer);
  return null;
}

/** The units a cut can fall before in `text`, in source order, with the declarations named in `open` opened up: a top-level
 *  statement is one unit; an opened declaration is its own unit (its head, up to its first member) followed by one unit per
 *  named member after the first, named `Host.member`. A member that is itself big can be opened too, by its path
 *  (`Host.member`), and its members are `Host.member.sub`. A unit is `{names, startLine, endLine, prevEnd}`: `prevEnd` is the last
 *  line of the unit (or, inside an opened declaration, member) before it, null when there is none; a cut before it falls on that
 *  line, so it is a cut-able place only when `prevEnd` is below `startLine`. */
export function cutUnits(text, open = []) {
  const { ts, source, line } = parseText(text);
  const units = [];
  const wanted = new Set(open);
  const used = new Set();
  /** The members of `node` as units named `${prefix}.${member}`, opening those whose path is wanted. */
  const emit = (prefix, node) => {
    const members = membersOf(ts, source, line, node);
    if (members === null) throw new Error(`"${prefix}" has no members a cut can use (an object literal, a class, a function body)`);
    for (const m of members) {
      const named = m.names.filter((n) => n.length > 0);
      if (m.prevEnd !== null && named.length > 0) units.push({ names: named.map((n) => `${prefix}.${n}`), startLine: m.startLine, endLine: m.endLine, prevEnd: m.prevEnd });
      for (const n of named) {
        if (wanted.has(`${prefix}.${n}`)) {
          used.add(`${prefix}.${n}`);
          emit(`${prefix}.${n}`, m.node);
        }
      }
    }
  };
  source.statements.forEach((s, i) => {
    const names = declaredNames(ts, s);
    units.push({ names, startLine: line(s.getStart(source)), endLine: line(s.getEnd()), prevEnd: i === 0 ? null : line(source.statements[i - 1].getEnd()) });
    const host = names.find((n) => wanted.has(n));
    if (host === undefined) return;
    used.add(host);
    emit(host, s);
  });
  for (const w of wanted) {
    if (used.has(w)) continue;
    throw new Error(w.includes(".") ? `"${w}" is not a member of an opened declaration (open its host too, and name the member as it is declared)` : `no top-level statement declares "${w}"`);
  }
  return units;
}

/** Where a cut before `anchor` falls: the line the anchored unit starts on and the last line of what comes before it. An anchor
 *  is a top-level name, or a path `Host.member` (`Host.member.sub` for a member of a member) for a member of a declaration (see
 *  cutUnits). */
function locate(ts, source, line, statements, anchor, label) {
  const [hostName, ...path] = anchor.split(".");
  const declaring = statements.filter((s) => s.names.includes(hostName));
  if (declaring.length === 0) throw new Error(`${label}: no top-level statement declares "${hostName}"`);
  if (declaring.length > 1) throw new Error(`${label}: "${hostName}" is declared by ${declaring.length} top-level statements (an overload set, or a type and a value of one name), so a cut before it is ambiguous; anchor on another statement`);
  const at = declaring[0].index;
  if (path.length === 0) {
    if (at === 0) throw new Error(`${label}: "${anchor}" is the first statement, and a cut before it leaves an empty part`);
    return { startLine: statements[at].startLine, prevEnd: statements[at - 1].endLine, what: "statement" };
  }
  let node = source.statements[at];
  let walked = hostName;
  let m;
  let siblings = [];
  for (const step of path) {
    const members = membersOf(ts, source, line, node);
    if (members === null) throw new Error(`${label}: "${walked}" has no members a cut can use (an object literal, a class, a function body)`);
    siblings = members;
    const named = members.filter((x) => x.names.includes(step));
    if (named.length === 0) throw new Error(`${label}: no member of "${walked}" is named "${step}"`);
    if (named.length > 1) throw new Error(`${label}: "${walked}.${step}" names ${named.length} members of "${walked}", so a cut before it is ambiguous; anchor on another member`);
    m = named[0];
    node = m.node;
    walked = `${walked}.${step}`;
  }
  const container = walked.slice(0, walked.lastIndexOf("."));
  if (m.prevEnd === null) throw new Error(`${label}: "${anchor}" is the first member of "${container}", and a cut before it leaves only the declaration's opening line above it; anchor on a later member`);
  return { startLine: m.startLine, prevEnd: m.prevEnd, what: "member", siblings };
}

/** The ranges `file:a-b` that `anchors` cut a file into: the parts tile lines 1..TO_END_OF_FILE exactly. Part k ends on the
 *  last line of the statement (or member) before its next anchor, and the next part starts on the line after it (so a comment, a
 *  JSDoc or a blank line between two statements goes with the one BELOW it). `label` names the file in a refusal. */
export function resolveSplit(text, anchors, label = "the file") {
  const { ts, source, line } = parseText(text);
  const statements = source.statements.map((s, index) => ({ index, names: declaredNames(ts, s), startLine: line(s.getStart(source)), endLine: line(s.getEnd()) }));
  const ends = [];
  let previous = { anchor: null, startLine: 0 };
  for (const anchor of anchors) {
    const at = locate(ts, source, line, statements, anchor, label);
    if (at.startLine <= previous.startLine) throw new Error(`${label}: "${anchor}" must come after the previous anchor in the file (anchors are listed in source order, each once); it starts on line ${at.startLine} and the one before it${previous.anchor === null ? "" : `, "${previous.anchor}",`} on line ${previous.startLine}`);
    if (at.prevEnd >= at.startLine) throw new Error(`${label}: "${anchor}" starts on line ${at.startLine}, the same line the ${at.what} before it ends, and a line range cannot cut between them`);
    ends.push(at.prevEnd);
    previous = { anchor, startLine: at.startLine };
  }
  const ranges = [];
  let from = 1;
  for (const end of ends) {
    ranges.push([from, end]);
    from = end + 1;
  }
  ranges.push([from, TO_END_OF_FILE]);
  return ranges;
}

const PART = /^(.*)#(\d+)$/;

/** `entries` (a leg's `mutate` list as stryker.groups.mjs declares it) with each `file#N` replaced by the range of part N of
 *  that file, `file:a-b`; every other entry (a glob, a `!` negation, a whole file) is kept as it is, in order. `splits` maps a
 *  file to its anchors, and `readText(file)` gives the file's source. */
export function resolveEntries(entries, splits, readText) {
  const cache = new Map();
  return entries.map((entry) => {
    const m = PART.exec(entry);
    if (m === null) return entry;
    const file = m[1];
    const anchors = splits[file];
    if (anchors === undefined) throw new Error(`${entry}: ${file} has no split in STRYKER_SPLITS`);
    if (!cache.has(file)) cache.set(file, resolveSplit(readText(file), anchors, file));
    const ranges = cache.get(file);
    const part = Number(m[2]);
    if (part < 1 || part > ranges.length) throw new Error(`${entry}: part ${part} does not exist, ${file} has parts 1 to ${ranges.length}`);
    const [from, to] = ranges[part - 1];
    return `${file}:${from}-${to}`;
  });
}

/** One leg's `mutate` list with its parts resolved to ranges (what stryker.config.mjs hands to Stryker). `cwd` is the
 *  engine directory, which the files are read from. */
export function resolveGroup(group, cwd = ENGINE) {
  const entries = STRYKER_GROUPS[group];
  if (entries === undefined) throw new Error(`unknown group "${group}": expected one of ${Object.keys(STRYKER_GROUPS).join(", ")}`);
  return resolveEntries(entries, STRYKER_SPLITS, (file) => readFileSync(join(cwd, file), "utf8"));
}

/** An ordinal anchor: its last name is a kind and a place (`if#7`), unlike a declared name, which can hold no `#`. */
export function isOrdinalAnchor(anchor) {
  return /^[a-z]+#\d+$/.test(anchor.slice(anchor.lastIndexOf(".") + 1));
}

/** What the ordinal anchor `anchor` starts in `text` NOW: the trimmed first line of its statement, and the same-kind statements of
 *  its body (each with its own name and first line), so that a statement that moved can be found again. */
export function anchorStarts(text, anchor, label = "the file") {
  const { ts, source, line } = parseText(text);
  const statements = source.statements.map((s, index) => ({ index, names: declaredNames(ts, s), startLine: line(s.getStart(source)), endLine: line(s.getEnd()) }));
  const at = locate(ts, source, line, statements, anchor, label);
  const lines = text.split("\n");
  const first = (startLine) => lines[startLine - 1].trim();
  const kind = anchor.slice(anchor.lastIndexOf(".") + 1).replace(/\d+$/, "");
  return {
    starts: first(at.startLine),
    siblings: at.siblings.flatMap((x) => x.names.filter((n) => n.startsWith(kind)).map((name) => ({ name, starts: first(x.startLine) }))),
  };
}

/** The record of every ordinal anchor of `splits`, as stryker-anchors.json holds it: file -> anchor -> `{starts}`. An anchor that
 *  names no statement is a refusal, unless `lenient` (a hint printed for an author who has yet to re-cut leaves it out). */
export function anchorRecords(splits, readText, lenient = false) {
  const out = {};
  for (const [file, anchors] of Object.entries(splits)) {
    for (const anchor of anchors) {
      if (!isOrdinalAnchor(anchor)) continue;
      let starts;
      try {
        starts = anchorStarts(readText(file), anchor, file).starts;
      } catch (e) {
        if (lenient) continue;
        throw e;
      }
      (out[file] ??= {})[anchor] = { starts };
    }
  }
  return out;
}

const ANCHORS_FILE = "packages/engine/stryker-anchors.json";
const RECUT_COMMAND = "pnpm --filter @seazn/engine mutation:recut <file> <parts> [--extra <mutants>] [--open <Host,...>]";

/** The faults of the ordinal anchors of `splits` against what `records` pinned them to, as messages ([] when there are none), and
 *  how many anchors were checked (zero is the caller's failure). An anchor is at fault when it names no statement any more, when
 *  it starts a different line than the one recorded (an `if` was added or removed above it, or the statement was edited), when
 *  its line is shared by another statement of its kind (a renumber could not be told from no change), when it has no record, and
 *  a record with no anchor is at fault too. Every message that is about a moved cut says to RE-CUT. */
export function checkAnchorRecords(splits, records, readText) {
  const problems = [];
  let checked = 0;
  const wanted = new Set();
  const regenerate = () => `${ANCHORS_FILE}, from this run:\n${JSON.stringify(anchorRecords(splits, readText, true), null, 2)}`;
  for (const [file, anchors] of Object.entries(splits)) {
    for (const anchor of anchors) {
      if (!isOrdinalAnchor(anchor)) continue;
      checked++;
      wanted.add(`${file}\n${anchor}`);
      const kind = anchor.slice(anchor.lastIndexOf(".") + 1).replace(/\d+$/, "");
      const record = records[file]?.[anchor];
      if (record === undefined) {
        problems.push(`${file}: the ordinal anchor "${anchor}" has no record in ${ANCHORS_FILE}: a cut at the Nth ${kind.replace(/#$/, "")} moves silently when one is added or removed above it, so each is pinned to the line it starts. Write ${regenerate()}`);
        continue;
      }
      let now;
      try {
        now = anchorStarts(readText(file), anchor, file);
      } catch (e) {
        problems.push(`${file}: the ordinal anchor "${anchor}" no longer names a statement (${e.message}); it started \`${record.starts}\`. A statement was removed from above it: RE-CUT with ${RECUT_COMMAND}, paste its STRYKER_SPLITS line into stryker.groups.mjs, re-measure the legs, and write ${regenerate()}`);
        continue;
      }
      const same = now.siblings.filter((x) => x.starts === now.starts && x.name !== anchor.slice(anchor.lastIndexOf(".") + 1));
      if (same.length > 0) {
        problems.push(`${file}: the ordinal anchor "${anchor}" starts \`${now.starts}\`, which ${same.map((x) => x.name).join(", ")} start too, so a renumber could not be told from no change. Cut before another statement`);
        continue;
      }
      if (now.starts !== record.starts) {
        const moved = now.siblings.filter((x) => x.starts === record.starts);
        const where = anchor.slice(0, anchor.lastIndexOf("."));
        problems.push(`${file}: the ordinal anchor "${anchor}" starts \`${now.starts}\` now, and started \`${record.starts}\` when it was cut: ${kind.replace(/#$/, "")} statements were added or removed above it (or that statement was edited), so the cut MOVED. ${moved.length === 1 ? `The statement it was cut at is now \`${where}.${moved[0].name}\`. ` : "The statement it was cut at is not in the body any more. "}RE-CUT: change the anchor in STRYKER_SPLITS (or run ${RECUT_COMMAND}), re-measure the legs it cuts (their parts and counts moved), and write ${regenerate()}`);
      }
    }
  }
  for (const [file, byAnchor] of Object.entries(records)) {
    for (const anchor of Object.keys(byAnchor)) {
      if (!wanted.has(`${file}\n${anchor}`)) problems.push(`${ANCHORS_FILE} records "${anchor}" of ${file}, which no leg is cut at any more: drop it. Write ${regenerate()}`);
    }
  }
  return { checked, problems };
}

/** How many of the mutants that START on `startLines` (1-based, one entry per mutant) fall inside each top-level statement:
 *  `weights[i]` is statement i's. A mutant outside every statement is refused (it would be lost whichever way the file is cut). */
export function statementMutants(statements, startLines) {
  const weights = statements.map(() => 0);
  for (const line of startLines) {
    const at = statements.findIndex((s) => line >= s.startLine && line <= s.endLine);
    if (at === -1) throw new Error(`a mutant starts on line ${line}, outside every top-level statement`);
    weights[at]++;
  }
  return weights;
}

/** How many of the mutants that START on `startLines` (1-based) fall in each of `units` (cutUnits' output): a mutant belongs to
 *  the last unit that starts on or before its line, so a declaration's head takes the mutants above its first member, and the
 *  last member takes those below it. A mutant outside every top-level statement (`statements`) is refused, as in
 *  statementMutants. */
export function unitMutants(units, statements, startLines) {
  const weights = units.map(() => 0);
  for (const startLine of startLines) {
    if (!statements.some((s) => startLine >= s.startLine && startLine <= s.endLine)) throw new Error(`a mutant starts on line ${startLine}, outside every top-level statement`);
    let at = -1;
    for (let i = 0; i < units.length; i++) if (units[i].startLine <= startLine) at = i;
    weights[at]++;
  }
  return weights;
}

/** The split of statements `0..n-1` into `parts` runs that minimises the largest run, where a cut before statement i is allowed
 *  only if `cutable[i]` and every run holds at least one mutant. `extra` mutants (the other files a leg also carries) are
 *  added to the LAST run. Returns `{cuts, sizes, max}` (cuts are the statement indices that start runs 2..parts), or null when
 *  no such split exists. Among the splits that tie on the largest run the first cuts are the earliest (lexicographically first), so a
 *  plan is stable. */
export function planSplit({ weights, cutable, parts, extra = 0 }) {
  const n = weights.length;
  const prefix = [0];
  for (const w of weights) prefix.push(prefix[prefix.length - 1] + w);
  const sum = (from, to) => prefix[to] - prefix[from];
  // best[k][i]: the smallest possible largest run when statements i..n-1 are split into k runs; null when impossible
  const best = Array.from({ length: parts + 1 }, () => new Array(n + 1).fill(null));
  for (let i = 0; i < n; i++) best[1][i] = sum(i, n) > 0 ? { max: sum(i, n) + extra } : null;
  for (let k = 2; k <= parts; k++) {
    for (let i = 0; i < n; i++) {
      for (let j = i + 1; j < n; j++) {
        if (!cutable[j] || sum(i, j) <= 0 || best[k - 1][j] === null) continue;
        const max = Math.max(sum(i, j), best[k - 1][j].max);
        if (best[k][i] === null || max < best[k][i].max) best[k][i] = { max };
      }
    }
  }
  if (n === 0 || best[parts][0] === null) return null;
  // The smallest largest run is known (`max`); the cuts are then taken from the front, each as early as it can be while the rest
  // can still be cut into runs no larger than that: of all the splits that tie, the lexicographically first, which is what keeps a
  // plan stable when a statement is added at the foot.
  const max = best[parts][0].max;
  const cuts = [];
  const sizes = [];
  let at = 0;
  for (let k = parts; k > 1; k--) {
    let j = at + 1;
    while (j < n && !(cutable[j] && sum(at, j) > 0 && sum(at, j) <= max && best[k - 1][j] !== null && best[k - 1][j].max <= max)) j++;
    cuts.push(j);
    sizes.push(sum(at, j));
    at = j;
  }
  sizes.push(sum(at, n) + extra);
  return { cuts, sizes, max };
}
