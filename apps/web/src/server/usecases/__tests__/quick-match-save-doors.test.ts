// Quick match plan 3, Task 4 (pre-flight D3; spec §7.7 as amended 2026-11-08): "any verified sign-in" saves the matches
// typed with the account's address, and that means EVERY place a person's session starts. A source scan, no database:
// every non-test file under src/ that imports `createSession` from "@/lib/auth" (the one place a session cookie is
// signed) must also `await saveQuickMatchesForVerifiedUser(<the same user>)` AFTER it. So a seventh sign-in door cannot
// ship without the save, and the six that exist cannot lose it.
//
// Read with the TypeScript parser, not a regex: comments are not nodes, so a call written in a comment does not count,
// and an aliased or multi-line import is still seen. It keys on the import SOURCE: the stream-sessions route calls a
// different `createSession` (a live stream's), which is not a sign-in.
//
// Exactly two exemptions, each with its reason and each asserted live (the file exists, still imports what the reason
// says, and does not save). A `createSession` from any other module, or a dynamic import of "@/lib/auth", fails until a
// person decides what it is.
import { readFileSync, readdirSync } from "node:fs";
import { createRequire } from "node:module";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import type * as TS from "typescript";
import { describe, expect, it } from "vitest";

// The CJS loader, not a static import: Vite refuses to transform typescript.js and the file would collect zero tests
// (src/__tests__/app-module-exports.test.ts).
const ts: typeof TS = createRequire(import.meta.url)("typescript");

const SRC = fileURLToPath(new URL("../../../", import.meta.url)); // this file sits in src/server/usecases/__tests__/
const AUTH = "@/lib/auth";
const SAVE_MODULE = "@/server/usecases/quick-match-save";
const SAVE_FN = "saveQuickMatchesForVerifiedUser";

/** The six doors the spec names (§7.7 amended: email verification, magic link, Google, the funnel claim, the invite
 *  claim, the claim accept), so a scan that silently stopped seeing one of them reds. */
const NAMED_DOORS = [
  "app/api/auth/verify-email/route.ts",
  "app/api/auth/magic-link/consume/route.ts",
  "app/api/auth/google/callback/route.ts",
  "app/api/funnel/claim/route.ts",
  "app/api/invites/[token]/claim/route.ts",
  "app/api/claims/[token]/accept/route.ts",
];

const EXEMPT: Record<string, { source: string; why: string }> = {
  "app/admin/impersonate/page.tsx": {
    source: AUTH,
    why: "staff impersonation: a staff member acting as the person, not the person signing in, so it must never save (spec §7.7 amended)",
  },
  "app/api/v1/fixtures/[id]/stream-sessions/route.ts": {
    source: "@/server/usecases/stream-sessions",
    why: "a live stream's session (stream-sessions.ts), not a sign-in: no person's session starts there",
  },
};

interface Scanned {
  file: string;
  /** Modules a `createSession` is imported from (a value import). */
  sources: string[];
  /** Start offsets of calls to "@/lib/auth"'s createSession, with their first argument's text. */
  mints: { at: number; arg: string }[];
  /** Calls to the save helper imported from its module, with their first argument's text and whether they are awaited. */
  saves: { at: number; arg: string; awaited: boolean }[];
  dynamicAuthImport: boolean;
}

function walk(dir: string, out: string[]): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name !== "__tests__" && entry.name !== "node_modules") walk(path, out);
    } else if (
      /\.tsx?$/.test(entry.name) &&
      !/\.(test|spec)\.tsx?$/.test(entry.name) &&
      !entry.name.endsWith(".d.ts")
    ) {
      out.push(path);
    }
  }
  return out;
}

/** `const { a, b } = await import("@/lib/auth")` takes only the names it destructures, readable here; any other shape
 *  (a namespace held in a variable, a `.then`) could reach `createSession` unseen, so it counts as taking it. */
function dynamicMayTakeCreateSession(call: TS.CallExpression): boolean {
  const awaited = call.parent;
  const decl = awaited && ts.isAwaitExpression(awaited) ? awaited.parent : undefined;
  if (!decl || !ts.isVariableDeclaration(decl) || !ts.isObjectBindingPattern(decl.name)) return true;
  return decl.name.elements.some((el) => {
    const key = el.propertyName ?? el.name;
    return !ts.isIdentifier(key) || key.text === "createSession";
  });
}

function scan(path: string, text: string): Scanned {
  const file = relative(SRC, path);
  const sf = ts.createSourceFile(
    file,
    text,
    ts.ScriptTarget.Latest,
    true,
    file.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );
  const sources: string[] = [];
  const authNames = new Set<string>();
  const authNamespaces = new Set<string>();
  let saveName: string | null = null;
  for (const st of sf.statements) {
    if (!ts.isImportDeclaration(st) || !ts.isStringLiteral(st.moduleSpecifier)) continue;
    const from = st.moduleSpecifier.text;
    const clause = st.importClause;
    if (!clause || clause.isTypeOnly) continue;
    const bindings = clause.namedBindings;
    if (bindings && ts.isNamespaceImport(bindings) && from === AUTH) authNamespaces.add(bindings.name.text);
    if (bindings && ts.isNamedImports(bindings)) {
      for (const el of bindings.elements) {
        if (el.isTypeOnly) continue;
        const imported = (el.propertyName ?? el.name).text;
        if (imported === "createSession") {
          sources.push(from);
          if (from === AUTH) authNames.add(el.name.text);
        }
        if (imported === SAVE_FN && from === SAVE_MODULE) saveName = el.name.text;
      }
    }
  }
  const out: Scanned = {
    file,
    sources,
    mints: [],
    saves: [],
    dynamicAuthImport: false,
  };
  const firstArg = (call: TS.CallExpression) => call.arguments[0]?.getText(sf) ?? "";
  const visit = (node: TS.Node): void => {
    if (ts.isCallExpression(node)) {
      const callee = node.expression;
      if (callee.kind === ts.SyntaxKind.ImportKeyword && node.arguments[0] && ts.isStringLiteral(node.arguments[0])) {
        if (node.arguments[0].text === AUTH && dynamicMayTakeCreateSession(node)) out.dynamicAuthImport = true;
      } else if (ts.isIdentifier(callee) && authNames.has(callee.text)) {
        out.mints.push({ at: node.getStart(sf), arg: firstArg(node) });
      } else if (
        ts.isPropertyAccessExpression(callee) &&
        callee.name.text === "createSession" &&
        ts.isIdentifier(callee.expression) &&
        authNamespaces.has(callee.expression.text)
      ) {
        out.mints.push({ at: node.getStart(sf), arg: firstArg(node) });
      } else if (ts.isIdentifier(callee) && saveName !== null && callee.text === saveName) {
        out.saves.push({
          at: node.getStart(sf),
          arg: firstArg(node),
          awaited: ts.isAwaitExpression(node.parent),
        });
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return out;
}

/** What is wrong with one door: every `createSession` owes an awaited save for the same argument AFTER it (a door with
 *  two branches that each sign someone in owes two), and every save follows a `createSession` for its own argument. */
function doorFaults(d: Scanned): string[] {
  if (d.saves.length === 0) return [`${d.file}: starts a session and never calls ${SAVE_FN}`];
  const faults: string[] = [];
  for (const s of d.saves) {
    if (!s.awaited) faults.push(`${d.file}: ${SAVE_FN}(${s.arg}) is not awaited`);
    if (!d.mints.some((m) => m.at < s.at && m.arg === s.arg)) {
      faults.push(`${d.file}: ${SAVE_FN}(${s.arg}) follows no createSession(${s.arg})`);
    }
  }
  for (const m of d.mints) {
    if (!d.saves.some((s) => s.at > m.at && s.awaited && s.arg === m.arg)) {
      faults.push(`${d.file}: createSession(${m.arg}) at offset ${m.at} has no awaited ${SAVE_FN}(${m.arg}) after it`);
    }
  }
  return faults;
}

/** Every source file that names `createSession` at all, scanned. The text filter only narrows what is parsed: a file
 *  that imports or calls it must spell it. */
const scanned: Scanned[] = walk(SRC, [])
  .map((path) => ({ path, text: readFileSync(path, "utf8") }))
  .filter(({ text }) => text.includes("createSession"))
  .map(({ path, text }) => scan(path, text));

const isDoor = (s: Scanned) => s.sources.includes(AUTH) || s.mints.length > 0;

describe("every sign-in door saves the quick matches typed with the account's address (D3)", () => {
  const doors = scanned.filter((s) => isDoor(s) && !(s.file in EXEMPT));

  it("finds the six doors the spec names, and checks at least that many (anti-vacuity)", () => {
    console.info(
      `quick-match-save doors: ${doors.length} sign-in doors checked (${scanned.length} files name createSession)`,
    );
    expect(doors.length).toBeGreaterThanOrEqual(NAMED_DOORS.length);
    expect(doors.map((d) => d.file)).toEqual(expect.arrayContaining(NAMED_DOORS));
  });

  it("each door pairs EVERY createSession with a later awaited save for the same user", () => {
    const faults = doors.flatMap(doorFaults);
    expect(faults).toEqual([]);
    expect(doors.length, "anti-vacuity: the loop judged doors").toBeGreaterThan(0);
    expect(
      doors.reduce((n, d) => n + d.mints.length, 0),
      "anti-vacuity: the pairing judged mints",
    ).toBeGreaterThanOrEqual(NAMED_DOORS.length);
  });

  it("no dynamic import of @/lib/auth hides a createSession from the scan", () => {
    expect(scanned.filter((s) => s.dynamicAuthImport).map((s) => s.file)).toEqual([]);
  });

  it("a createSession from any module but @/lib/auth is one of the listed exemptions", () => {
    const foreign = scanned.filter((s) => s.sources.some((src) => src !== AUTH));
    for (const s of foreign) {
      const exempt = EXEMPT[s.file];
      expect(exempt, `${s.file} imports a createSession from ${s.sources.join(", ")}: is it a sign-in?`).toBeDefined();
      expect(s.sources).toEqual([exempt!.source]);
    }
  });

  it("the two exemptions are live: each still imports what its reason says, and neither saves", () => {
    const seen: string[] = [];
    for (const [file, exempt] of Object.entries(EXEMPT)) {
      const s = scanned.find((x) => x.file === file);
      expect(s, `${file} (${exempt.why}) no longer names createSession: drop the exemption`).toBeDefined();
      expect(s!.sources, `${file}: ${exempt.why}`).toEqual([exempt.source]);
      expect(s!.saves, `${file} must not save: ${exempt.why}`).toEqual([]);
      seen.push(file);
    }
    expect(seen).toHaveLength(2);
    // The impersonation page is a real door in every other respect: it signs the target in through @/lib/auth.
    expect(scanned.find((x) => x.file === "app/admin/impersonate/page.tsx")!.mints.length).toBeGreaterThan(0);
  });
});

describe("the pairing judges every createSession, not the first (fixture doors through the same scan)", () => {
  const HEAD = [
    `import { createSession } from "@/lib/auth";`,
    `import { ${SAVE_FN} } from "${SAVE_MODULE}";`,
  ].join("\n");
  const fixture = (body: string) => scan(join(SRC, "app/api/__fixture__/route.ts"), `${HEAD}\n${body}\n`);

  it("two createSessions and one save: the second branch is a fault", () => {
    const d = fixture(`export async function GET(byGoogle: boolean, a: { id: string }, b: { id: string }) {
  if (byGoogle) {
    await createSession(a.id);
    await ${SAVE_FN}(a.id);
    return;
  }
  await createSession(b.id);
}`);
    expect([d.mints.length, d.saves.length], "premise: the scan reads two mints and one save").toEqual([2, 1]);
    expect(doorFaults(d)).toEqual([
      expect.stringMatching(/createSession\(b\.id\) at offset \d+ has no awaited .* after it$/),
    ]);
  });

  it("the same two branches, each with its save, are clean (the positive pair)", () => {
    const d = fixture(`export async function GET(byGoogle: boolean, a: { id: string }, b: { id: string }) {
  if (byGoogle) {
    await createSession(a.id);
    await ${SAVE_FN}(a.id);
    return;
  }
  await createSession(b.id);
  await ${SAVE_FN}(b.id);
}`);
    expect([d.mints.length, d.saves.length]).toEqual([2, 2]);
    expect(doorFaults(d)).toEqual([]);
  });

  it("a save before its createSession, or un-awaited, or for someone else, is a fault", () => {
    const before = fixture(`export async function GET(a: { id: string }) {
  await ${SAVE_FN}(a.id);
  await createSession(a.id);
}`);
    expect(doorFaults(before).length).toBe(2);
    const floating = fixture(`export async function GET(a: { id: string }) {
  await createSession(a.id);
  void ${SAVE_FN}(a.id);
}`);
    expect(doorFaults(floating)).toEqual([
      expect.stringMatching(/is not awaited$/),
      expect.stringMatching(/has no awaited .* after it$/),
    ]);
    const other = fixture(`export async function GET(a: { id: string }, b: { id: string }) {
  await createSession(a.id);
  await ${SAVE_FN}(b.id);
}`);
    expect(doorFaults(other)).toEqual([
      expect.stringMatching(/\(b\.id\) follows no createSession\(b\.id\)$/),
      expect.stringMatching(/createSession\(a\.id\) .* has no awaited/),
    ]);
  });
});
