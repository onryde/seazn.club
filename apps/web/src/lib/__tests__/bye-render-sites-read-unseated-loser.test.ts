// R116-4 (W2b Task 16; owner ruling 116) — the sweep guard, so a withdrawn winner's dead seat stops being fixed one
// surface at a time. Her seat keeps the bye label it was stamped with when it died, so EVERY place that turns a seat's
// stored label into words, or decides "this is a bye", prints "Bye" for her unless it asks the one reader first
// (`unseatedForfeitLoser`, lib/forfeit-tag.ts). R116-1..3 found such sites on the public pages, the run sheet, the
// exports, the bracket panel, then the console, the board card and the officials list — each after the last was green.
//
// What this scan reads, in every non-test file under apps/web/src (TypeScript's own parser, so a comment never counts):
//  - label:   a `resolveSlotLabel(label, …)` call whose label is not the literal `null` (a null label can only print
//             the fallback — TBD — never a stored bye; those are counted, not checked);
//  - namer:   a `namer.seat(fixtureId, seat, label)` call (`publicRoundNamer`, the public pages' seat namer);
//  - key:     the bye copy's keys as literals — `bracket.slot.bye` (the stored label, "Bye"), `schedule.bye` ("{name}
//             has a bye"), `eventCopy.forfeit.bye`, `pad.ribbon.core.forfeit.bye` — and, where one is a module-level
//             constant, every reference to that constant instead (in its own file and any file importing it);
//  - literal: a string literal "Bye" in code.
// Each site must be ROUTED — an enclosing function names the reader (imported from lib/forfeit-tag) or a registered
// carrier of it (below, each itself checked to call the reader) — or EXEMPT, by file and enclosing function, with the
// reason that tie can never reach it, and the NUMBER of sites it covers — so a new render inside an exempt function
// turns this red, as a new function does (there are no whole-file exemptions). An exemption covering more or fewer
// sites than it pins fails; a carrier no site uses fails; zero sites fails; and an independent census (a regex over the
// comment-stripped text — not the parser) must count the same sites.
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join, normalize } from "node:path";
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import type * as TS from "typescript";
import { describe, expect, it } from "vitest";

// `typescript` through require, not import: vite's import analysis chokes on the 10 MB CJS bundle
// (pass-scoping-guard.test.ts).
const ts: typeof TS = createRequire(import.meta.url)("typescript");

const WEB = new URL("../../../", import.meta.url).pathname; // apps/web/ from apps/web/src/lib/__tests__
const READER_FILE = "src/lib/forfeit-tag.ts";
const READERS = ["unseatedForfeitLoser", "unseatedForfeitLoserName"] as const;
const BYE_KEYS = new Set(["bracket.slot.bye", "schedule.bye", "eventCopy.forfeit.bye", "pad.ribbon.core.forfeit.bye"]);
const BYE_WORD = "Bye";

/** A name a site may call instead of the reader: `decl`, declared in `file`, must itself call the reader. A site may use
 *  it where its file IS `file`, imports `name` from it, or is one of `consumers` (a prop the page computes). */
interface Carrier {
  readonly name: string;
  readonly file: string;
  readonly decl?: string;
  readonly consumers?: readonly string[];
  readonly why: string;
}
const CONSOLE_PAGE = "src/app/o/[orgSlug]/c/[compSlug]/d/[divSlug]/f/[no]/page.tsx";
const CARRIERS: readonly Carrier[] = [
  { name: "seatEntrant", file: "src/components/v2/bracket-panel.tsx", why: "the bracket panel's seat id, R116-3" },
  { name: "seatName", file: "src/server/usecases/exports.ts", why: "the exports' seat name, R116-3" },
  { name: "unseatedName", file: "src/server/slideshow-data.ts", why: "the slideshow's dead-seat name, R116-3" },
  { name: "standIn", file: "src/server/slideshow-data.ts", why: "the public slideshow's dead-seat name, R116-1" },
  { name: "isBye", file: "src/lib/run-sheet-groups.ts", why: "the run sheet's bye row, R116-3" },
  {
    name: "home_unseated_name",
    file: CONSOLE_PAGE,
    decl: "unseatedName",
    consumers: ["src/components/v2/fixture-console.tsx"],
    why: "the console header's dead-seat name, computed by the page, R116-4",
  },
  {
    name: "away_unseated_name",
    file: CONSOLE_PAGE,
    decl: "unseatedName",
    consumers: ["src/components/v2/fixture-console.tsx"],
    why: "the console header's dead-seat name, computed by the page, R116-4",
  },
];

/** A site the tie cannot reach, by file and nearest named enclosing function ("<module>" at top level) — never a whole
 *  file, so a new function is a new site to route or exempt. `sites` pins how many unrouted sites it covers: a render
 *  added inside an exempt function is one more, and reds until it is read (and routed, or the pin raised with a reason
 *  that still holds). `via`, when given, is where the surface's names ARE read through the reader — each declaration is
 *  checked to call it. */
interface Exemption {
  readonly file: string;
  readonly fn: string;
  readonly sites: number;
  readonly reason: string;
  readonly via?: readonly { readonly file: string; readonly decl: string }[];
}
/** The public schedule's row and the public bracket's card — where `slotLabels` is read, after the reader. */
const PUBLIC_VIA = [
  { file: "src/components/public-site/schedule.tsx", decl: "ScorebugRow" },
  { file: "src/components/public-site/bracket.tsx", decl: "FixtureCard" },
];
const EXEMPT: readonly Exemption[] = [
  // The public seat namer's own fallback: library code its callers (namer sites, checked) sit above.
  { file: "src/server/public-site/feeder-slot-label.ts", fn: "publicSlotLabel", sites: 1, reason: "the public seat namer's own fallback; its callers are checked as namer sites" },
  // Fallback namers handed to a reader that names her first.
  {
    file: "src/server/public-site/match-centre-load.ts",
    fn: "slot", sites: 1,
    reason: "the match centre's fallback seat namer; `sides` takes the dead seat from `unseated` (read through the reader) before calling it",
    via: [{ file: "src/server/public-site/match-centre-load.ts", decl: "loadMatchCentre" }],
  },
  {
    file: "src/server/public-site/match-centre-load.ts",
    fn: "loadMatchCentre", sites: 1,
    reason: "the same fallback namer, re-pointed at the public seat namer",
    via: [{ file: "src/server/public-site/match-centre-load.ts", decl: "loadMatchCentre" }],
  },
  {
    file: "src/server/public-site/competition-hub.ts",
    fn: "slot", sites: 1,
    reason: "the hub's fallback seat namer (`ctx.slot`); hubSides takes `seated ?? unseatedForfeitLoser(...)` before calling it",
    via: [{ file: "src/server/public-site/competition-hub.ts", decl: "hubSides" }],
  },
  {
    file: "src/app/(public)/shared/[orgSlug]/[competitionSlug]/poster.pdf/route.ts",
    fn: "seatText", sites: 1,
    reason: "buildDrawModel's `seatText` names only a seat with no id, after `id ?? unseatedForfeitLoser(...)`",
    via: [{ file: "src/lib/poster-draw.ts", decl: "buildDrawModel" }],
  },
  {
    file: "src/app/(public)/shared/[orgSlug]/[competitionSlug]/[divisionSlug]/page.tsx",
    fn: "DivisionHomePage", sites: 2,
    reason: "`slotLabels` feeds <Schedule>/<Bracket>, which ask the reader before reading it",
    via: PUBLIC_VIA,
  },
  {
    file: "src/app/embed/divisions/[id]/[widget]/page.tsx",
    fn: "EmbedWidgetPage", sites: 2,
    reason: "`slotLabels` feeds <Schedule>/<Bracket>, which ask the reader before reading it",
    via: PUBLIC_VIA,
  },
  // Names arrive already resolved by a read that asks the reader.
  {
    file: "src/components/me/officiating-lane.tsx",
    fn: "CompletedCard", sites: 2,
    reason: "home_name/away_name arrive from getMyOfficiating's finished duties, which name her (unseatedForfeitLoserName)",
    via: [{ file: "src/server/usecases/me-officiating.ts", decl: "getMyOfficiating" }],
  },
  {
    file: "src/components/me/officiating-lane.tsx",
    fn: "AssignmentCard", sites: 2,
    reason: "outstanding duties (scheduled/in_play/needs_decision) — never a settled tie; names from getMyOfficiating",
    via: [{ file: "src/server/usecases/me-officiating.ts", decl: "getMyOfficiating" }],
  },
  // Status-gated: the tie is `forfeited` (settled), and these list only unplayed or live fixtures.
  { file: "src/server/usecases/org-posts.ts", fn: "assembleDigestUpcoming", sites: 2, reason: "the digest's upcoming list: `status = 'scheduled'` only" },
  { file: "src/server/public-site/public-player-matches.ts", fn: "opponentSeatNamer", sites: 2, reason: "a player's UPCOMING matches: `status = 'scheduled'` only" },
  { file: "src/server/public-site/public-player-matches.ts", fn: "readPlayerUpcoming", sites: 2, reason: "the upcoming read's own bye exclusion: `status = 'scheduled'` only" },
  { file: "src/server/usecases/exports.ts", fn: "buildOfficialsRotaDoc", sites: 2, reason: "the officials rota: `status in ('scheduled','in_play')` only" },
  { file: "src/server/usecases/exports.ts", fn: "buildMyRotaDoc", sites: 2, reason: "my rota: getMyOfficiating's outstanding duties (scheduled/in_play/needs_decision) only" },
  { file: "src/lib/scorer-sheets.ts", fn: "isBye", sites: 2, reason: "printable scorer sheets: PRINTABLE_STATUSES (scheduled, in_play) only" },
  { file: "src/server/usecases/scorer-sheets.ts", fn: "listSheetDays", sites: 2, reason: "the printable days: PRINTABLE_STATUSES (scheduled, in_play) only" },
  { file: "src/server/usecases/scan-match-names.ts", fn: "seat", sites: 1, reason: "seat names reach the scan page's Waiting screen (scheduled, a seat empty) and printable sheets (scheduled/in_play) only; a settled tie is view_only" },
  { file: "src/server/usecases/schedule.ts", fn: "moveFixture", sites: 2, reason: "the officials-change email on a MOVE: the board holds a settled tie (`playedFixtureIds`), so it never moves" },
  // Not a stored seat's occupant.
  { file: "src/components/v2/progression-panel.tsx", fn: "destinationSlotLabelText", sites: 1, reason: "names a progression DESTINATION slot in the editor, never a seat's occupant" },
  // The format preview: generated fixtures, which carry no stored outcome.
  { file: "src/server/usecases/stages.ts", fn: "previewDivisionFixtures", sites: 1, reason: "the format preview's own bye seat (`f.award`), over generated fixtures — no stored outcome" },
  { file: "src/server/usecases/stages.ts", fn: "slot", sites: 1, reason: "the format preview's seat namer, over generated fixtures — no stored outcome" },
  // Writers: the stored bye label as a value they WRITE, or a predicate a write is gated on. They render nothing.
  { file: "src/server/usecases/stages.ts", fn: "swissGen", sites: 1, reason: "writes the bye label onto a Swiss round's bye shell" },
  { file: "src/server/usecases/stages.ts", fn: "byeSlotLabel", sites: 1, reason: "the label generation stamps on a bye seat (a value, written by its caller)" },
  { file: "src/server/usecases/stages.ts", fn: "generateStageFixturesWrite", sites: 2, reason: "the generator's INSERT stamps the bye label on a generated bye seat" },
  { file: "src/server/usecases/stages.ts", fn: "generateProgressionSetupFixtures", sites: 4, reason: "writes the bye label on a progression seat, guarded on a seat not already stamped" },
  { file: "src/server/usecases/stages.ts", fn: "stampDepartedSeat", sites: 1, reason: "writes the bye label onto a departed entrant's seat" },
  { file: "src/server/usecases/stages.ts", fn: "awardSeededByes", sites: 2, reason: "selects the bye-stamped seats to WRITE their award (ruling 116's award, reason withdrew, is born here)" },
  { file: "src/server/usecases/stages.ts", fn: "writeDepartedSeat", sites: 1, reason: "writes the bye label onto a dead seat" },
  { file: "src/server/usecases/stages.ts", fn: "resolveBracketSeats", sites: 6, reason: "reads and writes seat labels to resolve the bracket's seats; writes, never renders" },
  { file: "src/server/usecases/stages.ts", fn: "confirmSeedProposal", sites: 2, reason: "writes the bye label on a confirmed seeding's bye seats" },
  { file: "src/server/engine-db/fed-seats.ts", fn: "seatIsStamped", sites: 1, reason: "the cascade's predicate: is this dead seat bye-stamped — gates a write" },
  { file: "src/server/engine-db/fed-seats.ts", fn: "planRevive", sites: 1, reason: "plans the cascade's seat revive (a write)" },
  { file: "src/server/engine-db/fed-seats.ts", fn: "writePlan", sites: 1, reason: "the cascade's dead-seat write" },
  { file: "src/server/engine-db/fed-seats.ts", fn: "writeRevives", sites: 1, reason: "the cascade's revive write" },
  // Keyed by the forfeit KIND (`forfeitCopyKind`, the classifier forfeitTag reads): her award's reason is `withdrew`.
  { file: "src/components/v2/scorepad/v3/ribbon.ts", fn: "coreRibbonKey", sites: 1, reason: "the pad ribbon's copy by forfeit kind; her award is `withdrew`, never `bye`" },
  { file: "src/lib/event-copy.ts", fn: "forfeitSentence", sites: 2, reason: "the timeline's copy by forfeit kind; her award is `withdrew`, never `bye`" },
];

interface Site {
  readonly file: string;
  readonly line: number;
  readonly kind: "label" | "namer" | "key" | "key-ref" | "literal";
  readonly fn: string;
  readonly routed: boolean;
}

function gitFiles(): string[] {
  return execFileSync("git", ["ls-files", "--", "src/**/*.ts", "src/**/*.tsx"], { cwd: WEB, encoding: "utf8" })
    .split("\n")
    .filter((f) => f && !f.includes("/__tests__/") && !/\.test\.tsx?$/.test(f) && !f.endsWith(".d.ts"))
    // The generated MessageKey union names every key as a type; it renders nothing.
    .filter((f) => f !== "src/lib/i18n-keys.ts");
}

const TRIGGER = /resolveSlotLabel\(|\.seat\(|bracket\.slot\.bye|schedule\.bye|eventCopy\.forfeit\.bye|pad\.ribbon\.core\.forfeit\.bye|["'`]Bye["'`]/;

const textCache = new Map<string, string>();
const read = (file: string): string => {
  let t = textCache.get(file);
  if (t === undefined) textCache.set(file, (t = readFileSync(join(WEB, file), "utf8")));
  return t;
};
const parseCache = new Map<string, TS.SourceFile>();
function parse(file: string): TS.SourceFile {
  const hit = parseCache.get(file);
  if (hit) return hit;
  const text = read(file);
  const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, file.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
  parseCache.set(file, sf);
  return sf;
}

/** The module an import specifier names, as a repo path without its extension. */
function resolveSpec(from: string, spec: string): string | null {
  const base = spec.startsWith("@/") ? `src/${spec.slice(2)}` : spec.startsWith(".") ? normalize(join(dirname(from), spec)) : null;
  return base?.replace(/\.(tsx?|js)$/, "").replace(/\/index$/, "") ?? null;
}
const noExt = (f: string) => f.replace(/\.(tsx?)$/, "").replace(/\/index$/, "");

/** Names `sf` imports from `file` (bindings, by their imported name). */
function importsFrom(sf: TS.SourceFile, file: string): Set<string> {
  const out = new Set<string>();
  for (const st of sf.statements) {
    if (!ts.isImportDeclaration(st) || !ts.isStringLiteral(st.moduleSpecifier)) continue;
    if (resolveSpec(sf.fileName, st.moduleSpecifier.text) !== noExt(file)) continue;
    const named = st.importClause?.namedBindings;
    if (named && ts.isNamedImports(named)) for (const el of named.elements) out.add((el.propertyName ?? el.name).text);
  }
  return out;
}

const isFn = (n: TS.Node): n is TS.FunctionLikeDeclaration =>
  ts.isFunctionDeclaration(n) || ts.isFunctionExpression(n) || ts.isArrowFunction(n) || ts.isMethodDeclaration(n) || ts.isGetAccessorDeclaration(n);

const idCache = new WeakMap<TS.Node, Set<string>>();
/** Every identifier (and property name) in a subtree — comments are trivia, never nodes. */
function idsIn(node: TS.Node): Set<string> {
  let ids = idCache.get(node);
  if (ids) return ids;
  ids = new Set<string>();
  const walk = (n: TS.Node) => {
    if (ts.isIdentifier(n)) ids!.add(n.text);
    ts.forEachChild(n, walk);
  };
  walk(node);
  idCache.set(node, ids);
  return ids;
}

/** The nearest NAMED enclosing declaration: a function, a variable holding one, a method or an object property. */
function enclosingName(node: TS.Node): string {
  for (let n: TS.Node | undefined = node.parent; n; n = n.parent) {
    if ((ts.isFunctionDeclaration(n) || ts.isMethodDeclaration(n)) && n.name) return n.name.getText();
    if ((ts.isArrowFunction(n) || ts.isFunctionExpression(n)) && n.parent) {
      const p = n.parent;
      if ((ts.isVariableDeclaration(p) || ts.isPropertyAssignment(p)) && p.name) return p.name.getText();
    }
  }
  return "<module>";
}

/** Declarations named `name` in `sf` (functions, variables) — the body each one runs. */
function declsNamed(sf: TS.SourceFile, name: string): TS.Node[] {
  const out: TS.Node[] = [];
  const walk = (n: TS.Node) => {
    if ((ts.isFunctionDeclaration(n) || ts.isVariableDeclaration(n)) && n.name && ts.isIdentifier(n.name) && n.name.text === name) out.push(n);
    ts.forEachChild(n, walk);
  };
  walk(sf);
  return out;
}

/** A declaration "calls the reader" when its subtree names one and its file may (is forfeit-tag or imports it). */
function declCallsReader(file: string, decl: string): { found: number; calling: number } {
  const sf = parse(file);
  const readers = file === READER_FILE ? new Set<string>(READERS) : importsFrom(sf, READER_FILE);
  const decls = declsNamed(sf, decl);
  return { found: decls.length, calling: decls.filter((d) => READERS.some((r) => readers.has(r) && idsIn(d).has(r))).length };
}

const isKeyLiteral = (n: TS.Node): n is TS.StringLiteral | TS.NoSubstitutionTemplateLiteral =>
  (ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n)) && !(n.parent && (ts.isLiteralTypeNode(n.parent) || ts.isImportDeclaration(n.parent)));

/** Top-level constants whose initialiser holds a bye key, as `[name, declaring file]` — three files each declare their
 *  own `BYE_SLOT_KEY`, so a name alone is not a key. */
function keyConstants(files: readonly string[]): [string, string][] {
  const out: [string, string][] = [];
  for (const file of files) {
    const sf = parse(file);
    for (const st of sf.statements) {
      if (!ts.isVariableStatement(st)) continue;
      for (const d of st.declarationList.declarations) {
        if (!ts.isIdentifier(d.name) || !d.initializer) continue;
        let holds = false;
        const walk = (n: TS.Node) => {
          if (isKeyLiteral(n) && BYE_KEYS.has(n.text)) holds = true;
          ts.forEachChild(n, walk);
        };
        walk(d.initializer);
        if (holds) out.push([d.name.text, file]);
      }
    }
  }
  return out;
}

function scan(): { sites: Site[]; nullLabels: number; carriersUsed: Set<string>; astCensus: Record<string, number> } {
  const files = gitFiles();
  const triggered = files.filter((f) => TRIGGER.test(read(f)));
  const consts = keyConstants(triggered);
  const sites: Site[] = [];
  const carriersUsed = new Set<string>();
  const astCensus = { resolveSlotLabel: 0, seat: 0, key: 0, literal: 0 };
  let nullLabels = 0;

  for (const file of files) {
    const text = read(file);
    // A file that only IMPORTS a key constant holds no trigger text; it is read when it imports one.
    const importedConsts = consts.filter(([, from]) => from !== file);
    if (!TRIGGER.test(text) && !importedConsts.some(([name]) => text.includes(name))) continue;
    const sf = parse(file);
    const readers = file === READER_FILE ? new Set<string>(READERS) : importsFrom(sf, READER_FILE);
    const usable = new Set<string>([...READERS].filter((r) => readers.has(r)));
    for (const c of CARRIERS) {
      if (c.file === file || importsFrom(sf, c.file).has(c.name) || c.consumers?.includes(file)) usable.add(c.name);
    }
    // The key constants this file may reference: its own, and those it imports from their declaring file.
    const refConsts = new Set<string>(consts.filter(([name, from]) => from === file || importsFrom(sf, from).has(name)).map(([n]) => n));

    const asksReader = (ids: Set<string>): boolean => {
      const hits = [...usable].filter((u) => ids.has(u));
      for (const h of hits) if (!(READERS as readonly string[]).includes(h)) carriersUsed.add(h);
      return hits.length > 0;
    };
    /** Routed: the NEAREST enclosing function names the reader or a carrier — not any ancestor, so a big component that
     *  asks the reader somewhere does not vouch for every seat it renders — or that function is a named helper every
     *  call of which (in this file, at least one) passes the reader's answer in an argument. */
    const routedAt = (node: TS.Node): boolean => {
      let fn: TS.Node | undefined = node.parent;
      while (fn && !isFn(fn)) fn = fn.parent;
      if (!fn) return false;
      if (asksReader(idsIn(fn))) return true;
      const name = helperName(fn);
      if (name === null) return false;
      const calls = callsOf(sf, name);
      return calls.length > 0 && calls.every((c) => c.arguments.some((a) => asksReader(idsIn(a))));
    };
    const add = (node: TS.Node, kind: Site["kind"]) =>
      sites.push({ file, line: sf.getLineAndCharacterOfPosition(node.getStart()).line + 1, kind, fn: enclosingName(node), routed: routedAt(node) });
    const inFunction = (node: TS.Node) => {
      for (let n: TS.Node | undefined = node.parent; n; n = n.parent) if (isFn(n)) return true;
      return false;
    };

    const walk = (n: TS.Node) => {
      if (ts.isCallExpression(n)) {
        const callee = n.expression;
        if (ts.isIdentifier(callee) && callee.text === "resolveSlotLabel") {
          astCensus.resolveSlotLabel++;
          if (n.arguments[0]?.kind === ts.SyntaxKind.NullKeyword) nullLabels++;
          else add(n, "label");
        } else if (ts.isPropertyAccessExpression(callee) && callee.name.text === "seat") {
          astCensus.seat++;
          add(n, "namer");
        }
      } else if (isKeyLiteral(n) && BYE_KEYS.has(n.text)) {
        astCensus.key++;
        // A key held by a top-level constant is decided where the constant is READ; those references are the sites.
        const top = !inFunction(n);
        const owner = top ? consts.find(([name, from]) => from === file && enclosingConst(n) === name)?.[0] : undefined;
        if (!owner) add(n, "key");
      } else if (isKeyLiteral(n) && n.text === BYE_WORD) {
        astCensus.literal++;
        add(n, "literal");
      } else if (ts.isIdentifier(n) && refConsts.has(n.text) && !isDeclName(n) && !isImportName(n)) {
        add(n, "key-ref");
      }
      ts.forEachChild(n, walk);
    };
    walk(sf);
  }
  return { sites, nullLabels, carriersUsed, astCensus };
}

/** A function's own name, when it is one a call can name: a declaration, or an arrow/function held by a `const`. */
function helperName(fn: TS.Node): string | null {
  if (ts.isFunctionDeclaration(fn) && fn.name) return fn.name.text;
  if ((ts.isArrowFunction(fn) || ts.isFunctionExpression(fn)) && ts.isVariableDeclaration(fn.parent) && ts.isIdentifier(fn.parent.name)) {
    return fn.parent.name.text;
  }
  return null;
}
function callsOf(sf: TS.SourceFile, name: string): TS.CallExpression[] {
  const out: TS.CallExpression[] = [];
  const walk = (n: TS.Node) => {
    if (ts.isCallExpression(n) && ts.isIdentifier(n.expression) && n.expression.text === name) out.push(n);
    ts.forEachChild(n, walk);
  };
  walk(sf);
  return out;
}

function enclosingConst(node: TS.Node): string | null {
  for (let n: TS.Node | undefined = node.parent; n; n = n.parent) {
    if (ts.isVariableDeclaration(n) && ts.isIdentifier(n.name) && ts.isVariableStatement(n.parent.parent) && ts.isSourceFile(n.parent.parent.parent)) return n.name.text;
  }
  return null;
}
const isDeclName = (n: TS.Identifier) => !!n.parent && ts.isVariableDeclaration(n.parent) && n.parent.name === n;
const isImportName = (n: TS.Identifier) => !!n.parent && (ts.isImportSpecifier(n.parent) || ts.isExportSpecifier(n.parent));

/** The independent census: the raw text with comments cut by a regex (not the parser), each pattern counted. A string
 *  holding `//` is protected by requiring the `//` not follow a colon or a quote (a URL, a protocol-relative path). */
function regexCensus(files: readonly string[]): Record<string, number> {
  const out = { resolveSlotLabel: 0, seat: 0, key: 0, literal: 0 };
  for (const file of files) {
    const body = read(file)
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/(^|[^:"'`\\])\/\/[^\n]*/g, "$1");
    out.resolveSlotLabel += [...body.matchAll(/\bresolveSlotLabel\(/g)].length - [...body.matchAll(/function resolveSlotLabel\(/g)].length;
    out.seat += [...body.matchAll(/\.seat\(/g)].length;
    out.key += [...body.matchAll(/["'`](?:bracket\.slot\.bye|schedule\.bye|eventCopy\.forfeit\.bye|pad\.ribbon\.core\.forfeit\.bye)["'`]/g)].length;
    out.literal += [...body.matchAll(/["'`]Bye["'`]/g)].length;
  }
  return out;
}

describe("R116-4: every bye render site reads `unseatedForfeitLoser` (ruling 116's dead seat)", () => {
  const { sites, nullLabels, carriersUsed, astCensus } = scan();
  const key = (s: Site) => `${s.file}::${s.fn}`;
  const exemptBy = new Map(EXEMPT.map((e) => [`${e.file}::${e.fn}`, e]));
  const exemptionOf = (s: Site): Exemption | undefined => exemptBy.get(key(s));

  it("checks a non-empty set of sites, and the parser and an independent census count the same ones", () => {
    const summary = {
      sites: sites.length,
      routed: sites.filter((s) => s.routed).length,
      exempt: sites.filter((s) => !s.routed && exemptionOf(s) !== undefined).length,
      nullLabels,
      byKind: Object.fromEntries(["label", "namer", "key", "key-ref", "literal"].map((k) => [k, sites.filter((s) => s.kind === k).length])),
    };
    console.log(`[bye-render-sites] ${JSON.stringify(summary)}`);
    if (process.env.BYE_SITES_DUMP) writeFileSync(process.env.BYE_SITES_DUMP, JSON.stringify(sites, null, 1));
    expect(summary.sites, "zero sites checked is a failure").toBeGreaterThan(0);
    expect(summary.routed, "no routed site: the reader's name is not being read").toBeGreaterThan(0);
    expect(summary.exempt, "no exempt site: the exemption key is not being read").toBeGreaterThan(0);
    expect(astCensus, "the parser and the regex census disagree — a call shape the scan cannot read").toEqual(regexCensus(gitFiles()));
    expect(astCensus.resolveSlotLabel, "resolveSlotLabel sites").toBe(summary.byKind.label! + nullLabels);
  });

  it("every site asks the reader (or a carrier of it), or is exempt with its reason", () => {
    const loose = sites.filter((s) => !s.routed && exemptionOf(s) === undefined).map((s) => `${s.file}:${s.line} [${s.kind}] in ${s.fn}`);
    expect(loose, "a bye render site that decides without `unseatedForfeitLoser` — route it, or exempt it with a reason").toEqual([]);
  });

  it("each exemption covers exactly the sites it pins (none stale, none grown), and each `via` calls the reader", () => {
    expect(exemptBy.size, "one exemption per file and function").toBe(EXEMPT.length);
    const covered = (e: Exemption) => sites.filter((s) => !s.routed && exemptionOf(s) === e);
    const drift = EXEMPT.filter((e) => covered(e).length !== e.sites).map(
      (e) => `${e.file}::${e.fn} pins ${e.sites}, covers ${covered(e).length}: ${covered(e).map((s) => `:${s.line} [${s.kind}]`).join(" ")}`,
    );
    expect(drift, "an exemption covering more or fewer sites than it pins — read the new site: route it, or re-pin with a reason that holds").toEqual([]);
    expect(EXEMPT.reduce((n, e) => n + e.sites, 0), "the pins sum to the exempt sites").toBe(sites.filter((s) => !s.routed && exemptionOf(s) !== undefined).length);
    let vias = 0;
    for (const e of EXEMPT) {
      for (const v of e.via ?? []) {
        const { found, calling } = declCallsReader(v.file, v.decl);
        expect(found, `${v.file}::${v.decl} exists`).toBeGreaterThan(0);
        expect(calling, `${v.file}::${v.decl} calls the reader`).toBe(found);
        vias++;
      }
    }
    expect(vias, "the via checks ran").toBe(EXEMPT.flatMap((e) => e.via ?? []).length);
    expect(vias, "zero via checks is a failure").toBeGreaterThan(0);
  });

  it("every carrier calls the reader and is used by a site", () => {
    let checked = 0;
    for (const c of CARRIERS) {
      const { found, calling } = declCallsReader(c.file, c.decl ?? c.name);
      expect(found, `${c.file}::${c.decl ?? c.name} (${c.why}) exists`).toBeGreaterThan(0);
      expect(calling, `${c.file}::${c.decl ?? c.name} (${c.why}) calls the reader`).toBe(found);
      expect(carriersUsed.has(c.name), `${c.name}: a carrier no site uses — drop it`).toBe(true);
      checked++;
    }
    expect(checked).toBe(CARRIERS.length);
  });
});
