// No second path to Resend (phase 3 wave 1, T7; spec "no second path"). The outbox is the only way mail leaves: it replaces, retries,
// seals, resolves the account's address at send time and releases a seat that ended badly. A `send*` that mails straight to Resend
// skips every one of those, and a future Email Service (phase 4) takes over dispatch, the worker and the webhook, so the seam it takes
// over has to be the ONLY one, and has to stay free of app rendering. This file keeps these claims, by reading the source (no runner,
// no database):
//
//  1. Allowlist. The `send*` exports of lib/email.ts are exactly the typed list in _kind-senders.ts (49). A new `send*` is a new direct
//     sender, and adding one is a decision this test makes someone take on purpose. Each kind that moves to the outbox (T8-T12) deletes
//     its `send*` in the same commit as it adds its enqueue, and removes its name there.
//  2. Imports. Nothing outside the outbox's tests, lib/email.ts itself and that module's own unit test imports `deliver`,
//     `sendWithResult`, `checkSendable` or `claimOne` - from lib/email, from the transport, or by any path to either (an alias, a
//     relative path, a re-export, a namespace import, a dynamic import).
//  3. The outbox's own production files are pinned file by file, not exempted by directory: the only two that touch the gated
//     names are attempt.ts (the gate and the transport) and transport.ts (the wire function), and no outbox file imports anything else
//     from lib/email (a render builder in dispatch or the worker is exactly what phase 4 cannot carry across).
//  4. Resend. Exactly one production file, lib/email.ts, names `api.resend.com`; none imports a mail SDK; and the key that authorises a
//     send (RESEND_API_KEY) is named in exactly the four production files that need it, so a second provider (a host built at run time,
//     another vendor) has to touch this list. Tests name the host legitimately (a fetch stub answers for it), so they are not scanned
//     (controller ruling C2): the count of production files scanned is reported, and zero is a failure.
//
// Every matcher is exercised on planted sources first, in the forms a bypass would take, and on the real files that carry the legal
// forms of the same thing (a scanner that finds nothing proves nothing). Sport: not applicable.
import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, posix, relative, resolve } from "node:path";
import { SENDER_ALLOWLIST } from "./_kind-senders";

const SRC = resolve(import.meta.dirname, "../../.."); // apps/web/src
const rel = (abs: string): string => relative(SRC, abs).split("\\").join("/");
const cache = new Map<string, string>();
/** A source file's text, read once for the whole file (the tree walk reads every file under src/ twice otherwise). */
const read = (relPath: string): string => {
  let text = cache.get(relPath);
  if (text === undefined) {
    text = readFileSync(join(SRC, relPath), "utf8");
    cache.set(relPath, text);
  }
  return text;
};

const CODE_FILE = /\.[cm]?[jt]sx?$/;

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (name === "node_modules" || name === ".next") continue;
    const full = join(dir, name);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (CODE_FILE.test(name)) out.push(full);
  }
  return out;
}

/** Every code file under src/, as a path relative to src/. */
const allFiles = (): string[] => walk(SRC).map(rel).sort();

// ---------------------------------------------------------------------------------------------------------------------------------
// 1. The allowlist
// ---------------------------------------------------------------------------------------------------------------------------------

/** The outbox's own typed sender: exported, but not one of the direct `send*` mails the allowlist is about. */
const OUTBOX_SENDER = "sendWithResult";

/** The exported `send*` names of a module's source: `export [async] function sendX` and `export const sendX`. */
function senderExports(source: string): string[] {
  const names: string[] = [];
  for (const m of source.matchAll(/^export\s+(?:async\s+)?function\s+(send\w*)/gm)) names.push(m[1]!);
  for (const m of source.matchAll(/^export\s+const\s+(send\w*)\b/gm)) names.push(m[1]!);
  return names.filter((n) => n !== OUTBOX_SENDER);
}

describe("1. the send* allowlist", () => {
  it("the matcher reads every form a new sender would take, and leaves the outbox's own sender and private helpers alone", () => {
    const src = [
      `export async function sendNewThingEmail(a: string) {}`,
      `export function sendSyncOne() {}`,
      `export const sendArrow = async () => {};`,
      `export const sendTyped: Sender = async () => {};`,
      `export async function sendWithResult(opts: SendOptions) {}`,
      `async function send(opts: SendOptions) {}`,
      `async function sendPrivate() {}`,
      `export async function notASender() {}`,
      `// export async function sendInAComment() {}`,
      `  export async function sendIndented() {}`,
    ].join("\n");
    // The last two lines are not at the start of a line (a comment, indentation): a real export is never either.
    expect(senderExports(src).sort()).toEqual(["sendArrow", "sendNewThingEmail", "sendSyncOne", "sendTyped"]);
  });

  it("lib/email.ts exports exactly the typed list: 49 senders, none added and none dropped", () => {
    const found = senderExports(read("lib/email.ts"));
    expect(new Set(found).size, "premise: no name is exported twice").toBe(found.length);
    expect(SENDER_ALLOWLIST, "the spec says 49 send* exports").toHaveLength(49);
    expect(found.length, "anti-vacuity: the file was read and its senders found").toBeGreaterThan(0);
    expect([...found].sort()).toEqual([...SENDER_ALLOWLIST].sort());
  });

  it("the allowlist has no duplicate", () => {
    expect(new Set(SENDER_ALLOWLIST).size).toBe(SENDER_ALLOWLIST.length);
  });
});

// ---------------------------------------------------------------------------------------------------------------------------------
// 2. The imports
// ---------------------------------------------------------------------------------------------------------------------------------

/** The things only the outbox may call: the transport's wire function, the typed sender, the gate (key, suppression), and the
 *  worker's claim (the one statement that takes a due row; a second claimer is a second dispatcher). */
const GATED_NAMES: readonly string[] = ["deliver", "sendWithResult", "checkSendable", "claimOne"];
const GATED = GATED_NAMES.join("|");

/** A module specifier as a path under src/ with no extension and no trailing /index, or null for a package or a path outside src/. */
function moduleOf(spec: string, fromRel: string): string | null {
  let p: string;
  if (spec.startsWith("@/")) p = spec.slice(2);
  else if (spec.startsWith("./") || spec.startsWith("../")) p = posix.normalize(posix.join(posix.dirname(fromRel), spec));
  else return null;
  if (p.startsWith("..")) return null;
  return p.replace(/\.[cm]?[jt]sx?$/, "").replace(/\/index$/, "");
}

/** The modules that hold the gated names: lib/email, and the outbox directory (its index, its transport, its worker). */
const isGatedModule = (m: string): boolean => m === "lib/email" || m === "server/email-outbox" || m.startsWith("server/email-outbox/");
/** The modules that RENDER a mail: lib/email (every `xxxEmail` builder lives there) and the templates it composes. The outbox stores a
 *  rendered mail and never renders one; phase 4 moves dispatch and the worker out of this app, so they cannot import these. */
const isRenderModule = (m: string): boolean => m === "lib/email" || m === "lib/email-templates" || m.startsWith("lib/email-templates/");

/** Production source: not a test (a `__tests__` directory, or a `.test.` / `.spec.` file). Tests name the host to stub it. */
const isProduction = (r: string): boolean => !/(^|\/)__tests__\//.test(r) && !/\.(?:test|spec)\.[cm]?[jt]sx?$/.test(r);

type Scan = {
  /** Imports (and re-exports) of a gated NAME by any route, and every way a module namespace could carry one out. */
  offences: string[];
  /** How many imports reach a gated module at all (the positive control: a scanner that never sees an import of lib/email is blind). */
  gatedModuleImports: number;
  /** Every VALUE import from a render module, as `module:name` (`module:*` for a namespace, default or star, `module:(run-time load)`). */
  renderImports: string[];
};

// Each comment form can be read ONE way only (a line comment runs to the end of its line; a block comment ends at the first `*/`), so
// the statement regex below cannot backtrack through alternative readings of the same text: that is the difference between
// milliseconds and a test that never returns on a file with a dozen comment lines.
const BLOCK = String.raw`\/\*(?:[^*]|\*(?!\/))*\*\/`;
const COMMENT = String.raw`\/\/[^\n]*(?=\n|$)|` + BLOCK;
const stripComments = (text: string): string => text.replace(new RegExp(COMMENT, "g"), " ");

/** Whether the end of this line prefix is inside a comment (`//`, `/*`, or a doc-comment continuation line) or a string literal. */
function opensInCommentOrString(linePrefix: string): boolean {
  let quote: string | null = null;
  for (let i = 0; i < linePrefix.length; i++) {
    const c = linePrefix[i]!;
    if (quote !== null) {
      if (c === "\\") i += 1;
      else if (c === quote) quote = null;
    } else if (c === '"' || c === "'" || c === "`") quote = c;
    else if (c === "/" && (linePrefix[i + 1] === "/" || linePrefix[i + 1] === "*")) return true;
  }
  return quote !== null || /^\s*\*/.test(linePrefix);
}

/**
 * Every use of `ident` in `source` other than as `ident.<name>` with a name that is not gated: the declaration itself, a comment
 * mention, and a member of a name that is not gated are all fine; a gated member, a member that is not a plain name (`ident[name]`,
 * `ident.default`) and any bare use (`const { deliver } = ident`, `export default ident`, `use(ident)`) are not, because each can carry a
 * gated function out of the module under another name.
 */
function usesOf(source: string, ident: string, spec: string): string[] {
  const out: string[] = [];
  const escaped = ident.replace(/\$/g, "\\$");
  for (const m of source.matchAll(new RegExp(`(?<![\\w$.])${escaped}(?![\\w$])`, "g"))) {
    const at = m.index;
    const before = source.slice(0, at);
    const after = source.slice(at + ident.length);
    // The declaration: `import * as ns` / `import ns` / `const ns =` / `ns = await import(...)`.
    if (/(?:\bas|\bconst|\blet|\bvar|\bimport)\s+$/.test(before)) continue;
    if (/^\s*(?::[^=;]+)?=(?![=>])/.test(after)) continue;
    // A mention in a comment or a string (prose that happens to use the name) is not a use.
    if (opensInCommentOrString(before.slice(before.lastIndexOf("\n") + 1))) continue;
    const member = /^\s*\??\.\s*([A-Za-z_$][\w$]*)/.exec(after) ?? /^\s*\[\s*["']([^"']+)["']\s*\]/.exec(after);
    if (member) {
      if (GATED_NAMES.includes(member[1]!)) out.push(`uses ${ident}.${member[1]} from ${spec}`);
      else if (member[1] === "default") out.push(`reads ${ident}.default from ${spec} (it could hold a gated function)`);
      continue;
    }
    out.push(`carries ${ident} (the module ${spec}) out as a bare value: it could hand on a gated name`);
  }
  return out;
}

/** What one file does with the gated and render modules. */
function scanImports(source: string, fromRel: string): Scan {
  const offences: string[] = [];
  const renderImports: string[] = [];
  let gatedModuleImports = 0;

  // import / export ... from "spec" (multi-line clauses included), after a `;`, a line start, or block comments on the same line. `import
  // type` / `export type` are erased and cannot call anything. A comment inside the clause may hold quotes and the words import and
  // export; the clause may not contain another `import` / `export` statement, so one with no semicolon cannot swallow the next. A
  // `/` that opens a comment is matched ONLY as a comment (the plain-character branch refuses it): otherwise each comment can be
  // read two ways and a clause that fails to end in `from` backtracks through every combination - minutes, on a file with a dozen.
  const statement = new RegExp(
    String.raw`(?:^|;)[ \t]*(?:(?:${BLOCK})[ \t]*)*(import|export)\s+(type\s+)?((?:${COMMENT}|(?!\b(?:import|export)\b)(?!\/[\/*])[^;'"` + "`" + String.raw`])*?)\s*from\s*["']([^"']+)["']`,
    "gm",
  );
  for (const m of source.matchAll(statement)) {
    const [, keyword, typeOnly, rawClause = "", spec = ""] = m;
    const mod = moduleOf(spec, fromRel);
    if (mod === null) continue;
    const gatedMod = isGatedModule(mod);
    const renderMod = isRenderModule(mod);
    if (!gatedMod && !renderMod) continue;
    if (gatedMod) gatedModuleImports += 1;
    if (typeOnly) continue;
    const clause = stripComments(rawClause).trim();
    const braces = /\{([^}]*)\}/.exec(clause);
    const head = clause.replace(braces?.[0] ?? "", "").replace(/,\s*$/, "").replace(/^\s*,/, "").trim();
    const star = /(?:^|,)\s*\*\s*(?:as\s+([\w$]+))?\s*$/.exec(head);
    if (keyword === "export" && star) {
      offences.push(`re-exports everything from ${spec}`);
      if (renderMod) renderImports.push(`${mod}:*`);
      continue;
    }
    if (keyword === "import") {
      // A namespace (`* as ns`) or a default (`def`) binding stands for the whole module: every use of it is judged.
      const bindings = [star?.[1], /^([A-Za-z_$][\w$]*)\s*(?:,|$)/.exec(head)?.[1]].filter((b): b is string => !!b);
      for (const b of bindings) {
        offences.push(...usesOf(source, b, spec));
        if (renderMod) renderImports.push(`${mod}:*`);
      }
    }
    for (const token of (braces?.[1] ?? "").split(",")) {
      const t = token.trim();
      if (t === "" || /^type\s/.test(t)) continue; // an inline `type X` is erased and cannot call anything
      const name = t.split(/\s+as\s+/)[0]!.trim();
      if (GATED_NAMES.includes(name)) offences.push(`${keyword === "import" ? "imports" : "re-exports"} ${name} from ${spec}`);
      if (renderMod) renderImports.push(`${mod}:${name}`);
    }
  }

  // import("spec"), require("spec"), vi.importActual("spec"): a run-time load, judged by what is DONE with it: a gated name read straight
  // off the call, destructured from it (or collected with a rest), picked in a `.then`, or the variable it is bound to used in any way
  // `usesOf` refuses. Loading the module for something else (the status reader, a type) is not a bypass. `typeof import("spec")` is a
  // type query and is erased.
  const dynamic = /(?<!typeof\s+)(?:\bimport|\brequire|\bimportActual)\s*(?:<[^>]*>)?\(\s*["']([^"']+)["']\s*\)/g;
  const tail = String.raw`\s*(?::[^=;]+)?(?<![=!<>])=\s*(?:\(\s*|await\s+)*(?:vi\s*\.\s*)?$`;
  for (const m of source.matchAll(dynamic)) {
    const spec = m[1]!;
    const mod = moduleOf(spec, fromRel);
    if (mod === null) continue;
    const gatedMod = isGatedModule(mod);
    const renderMod = isRenderModule(mod);
    if (!gatedMod && !renderMod) continue;
    const before = source.slice(0, m.index);
    const after = source.slice(m.index + m[0].length);
    // `type X = import("spec").X` names a TYPE (erased); nothing is loaded and `X` is not a binding of the module.
    if (/\btype\s+[A-Za-z_$][\w$]*\s*(?:<[^>]*>)?\s*=\s*$/.test(before)) continue;
    if (gatedMod) gatedModuleImports += 1;
    if (renderMod) renderImports.push(`${mod}:(run-time load)`);
    if (new RegExp(`^\\s*\\)?\\s*\\??\\.\\s*(?:${GATED})\\b`).test(after)) offences.push(`reads a gated name off the run-time load of ${spec}`);
    if (new RegExp(`^\\s*\\.\\s*then\\s*\\([^]{0,200}?\\b(?:${GATED})\\b`).test(after)) offences.push(`picks a gated name in a .then of ${spec}`);
    const destructured = new RegExp(String.raw`(\{[^}]*\})` + tail).exec(before);
    const bound = new RegExp(String.raw`(?<![\w$.])([A-Za-z_$][\w$]*)` + tail).exec(before);
    if (destructured) {
      for (const token of destructured[1]!.slice(1, -1).split(",")) {
        const t = token.trim();
        if (t.startsWith("...")) offences.push(`collects the rest of the run-time load of ${spec} (${t}): it could hold a gated name`);
        else if (GATED_NAMES.includes(t.split(":")[0]!.trim())) offences.push(`destructures ${t.split(":")[0]!.trim()} from the run-time load of ${spec}`);
      }
    } else if (bound) {
      offences.push(...usesOf(source, bound[1]!, spec));
    }
  }
  return { offences, gatedModuleImports, renderImports };
}

/** Files exempt from the whole-tree scan: lib/email.ts (it defines the names), that module's own unit test, and the outbox's tests (they
 *  test the seam; one swaps it for a mock and reads its calls). The outbox's PRODUCTION files are not exempt: each is pinned below. */
const OUTBOX_DIR = "server/email-outbox/";
const OUTBOX_TESTS = (r: string): boolean => r.startsWith(`${OUTBOX_DIR}__tests__/`);
const OWNER = "lib/email.ts";
/** The unit test of lib/email.ts's own gate and wire function: it imports them by name because they are what it tests. Exactly this
 *  file, not a pattern; the test below keeps the exemption honest (it must still need it). */
const OWN_TESTS: readonly string[] = ["lib/__tests__/email-send-result.test.ts"];
const exempt = (r: string): boolean => OUTBOX_TESTS(r) || r === OWNER || OWN_TESTS.includes(r);
const isOutboxProduction = (r: string): boolean => r.startsWith(OUTBOX_DIR) && isProduction(r);

/**
 * What each production file of the outbox may import, exactly. Two files touch the gated names: attempt.ts asks the gate
 * (`checkSendable`, lib/email) and calls the transport (`deliver`, ./transport); transport.ts is the wire function's one caller
 * (`deliver`, lib/email); index.ts re-exports constants.ts whole. Every other outbox production file imports none of them, and NO outbox file imports a render builder or any
 * other value from lib/email: the dispatch/worker seam phase 4 lifts out must not need the app to render.
 * A file that is not listed is pinned to "nothing". Adding to this table is a decision a reviewer sees.
 */
const OUTBOX_PINS: Readonly<Record<string, { gated: readonly string[]; render: readonly string[] }>> = {
  "server/email-outbox/attempt.ts": {
    gated: ["imports checkSendable from @/lib/email", "imports deliver from ./transport"],
    render: ["lib/email:checkSendable"],
  },
  "server/email-outbox/transport.ts": { gated: ["imports deliver from @/lib/email"], render: ["lib/email:deliver"] },
  // The public surface re-exports the whole constants module (a pure declaration file: no gated name is in it). A star re-export of
  // anything else here - the transport, the worker - is a change to this pin.
  "server/email-outbox/index.ts": { gated: ["re-exports everything from ./constants"], render: [] },
};

/** How a production outbox file's imports differ from its pin (empty = exactly as pinned). */
function outboxDiff(source: string, file: string): string[] {
  const pin = OUTBOX_PINS[file] ?? { gated: [], render: [] };
  const scan = scanImports(source, file);
  const key = (xs: readonly string[]): string => JSON.stringify([...xs].sort());
  const out: string[] = [];
  if (key(scan.offences) !== key(pin.gated)) out.push(`${file}: gated imports ${key(scan.offences)}, pinned ${key(pin.gated)}`);
  if (key(scan.renderImports) !== key(pin.render)) out.push(`${file}: imports from lib/email ${key(scan.renderImports)}, pinned ${key(pin.render)}`);
  return out;
}

describe("2. nothing outside the outbox imports the gated functions", () => {
  const at = "app/x/y.ts";

  it("the scanner finds a bypass in every form it can take", () => {
    const forms: Record<string, string> = {
      "named, from lib/email": `import { deliver } from "@/lib/email";`,
      "named, from the transport": `import { deliver } from "@/server/email-outbox/transport";`,
      "the gate": `import { checkSendable } from "@/lib/email";`,
      "the typed sender": `import { sendWithResult } from "@/lib/email";`,
      "the worker's claim": `import { claimOne } from "@/server/email-outbox/worker";`,
      "aliased": `import { deliver as post } from "@/lib/email";`,
      "among others": `import { sendInviteEmail, deliver } from "@/lib/email";`,
      "after an inline type": `import { type SendOptions, sendWithResult } from "@/lib/email";`,
      "multi-line": `import {\n  sendInviteEmail,\n  checkSendable,\n} from "@/lib/email";`,
      "relative path": `import { deliver } from "../../lib/email";`,
      "relative path with an extension": `import { deliver } from "../../lib/email.ts";`,
      "through the outbox index": `import { deliver } from "@/server/email-outbox";`,
      "through another outbox module": `import { sendWithResult } from "@/server/email-outbox/attempt";`,
      "a re-export by name": `export { deliver } from "@/lib/email";`,
      "a re-export under another name": `export { deliver as rawSend } from "@/server/email-outbox/transport";`,
      "a re-export of everything": `export * from "@/lib/email";`,
      "a re-export of everything as a namespace": `export * as mail from "@/lib/email";`,
      "a namespace import, used": `import * as mail from "@/lib/email";\nawait mail.deliver(m, key);`,
      "a namespace import, indexed": `import * as mail from "@/lib/email";\nawait mail["checkSendable"](m);`,
      "a namespace import, destructured": `import * as mail from "@/lib/email";\nconst { deliver } = mail;`,
      "a namespace import, exported as the default": `import * as mail from "@/lib/email";\nexport default mail;`,
      "a namespace import, handed on": `import * as mail from "@/lib/email";\nregister(mail);`,
      "a namespace import, indexed by a variable": `import * as mail from "@/lib/email";\nconst name = "deliver";\nawait mail[name](m, key);`,
      "a namespace import, through its default": `import * as mail from "@/lib/email";\nawait mail.default.deliver(m, key);`,
      "a default import, destructured": `import mail from "@/lib/email";\nconst { deliver } = mail;`,
      "a default import beside names, handed on": `import mail, { sendInviteEmail } from "@/lib/email";\nexport { mail };`,
      "a dynamic import, destructured": `const { deliver } = await import("@/lib/email");`,
      "a dynamic import, destructured and renamed": `const { deliver: post, sendInviteEmail } = await import("@/lib/email");`,
      "a dynamic import, destructured with a rest": `const { sendInviteEmail, ...rest } = await import("@/lib/email");`,
      "a dynamic import, bound then used": `const m = await import("@/server/email-outbox/transport");\nm.deliver(x, k);`,
      "a dynamic import, bound then destructured": `const m = await import("@/lib/email");\nconst { deliver } = m;`,
      "a dynamic import, bound then handed on": `const m = await import("@/lib/email");\nuse(m);`,
      "a dynamic import, assigned later": `let m;\nm = await import("@/lib/email");\nm.deliver(x, k);`,
      "a dynamic import, read off the call": `const send = (await import("@/lib/email")).sendWithResult;`,
      "a dynamic import, called off the call": `await (await import("@/lib/email")).deliver(m, k);`,
      "a dynamic import, in a then": `import("@/lib/email").then(({ deliver }) => deliver(m, k));`,
      "a require": `const { checkSendable } = require("../../lib/email");`,
      "an actual-module load": `const actual = await vi.importActual<typeof import("@/lib/email")>("@/lib/email");\nactual.sendWithResult(o);`,
      "on one line with another statement": `import a from "b"; import { deliver } from "@/lib/email";`,
      "after a block comment on the same line": `/* the sender */ import { deliver } from "@/lib/email";`,
      "an apostrophe in a comment inside the clause": `import {\n  sendInviteEmail, // don't\n  deliver,\n} from "@/lib/email";`,
      "a block comment with a quote inside the clause": `import { /* it's */ deliver } from "@/lib/email";`,
      "a comment that says export inside the clause": `import {\n  // export it\n  deliver,\n} from "@/lib/email";`,
    };
    let checked = 0;
    for (const [name, src] of Object.entries(forms)) {
      expect(scanImports(src, at).offences.length, name).toBeGreaterThan(0);
      checked += 1;
    }
    expect(checked, "anti-vacuity: every form was tried").toBe(Object.keys(forms).length);
    expect(checked).toBeGreaterThanOrEqual(40);
  });

  it("the scanner leaves legal imports alone (a negative needs its positive pair, above)", () => {
    const legal: Record<string, string> = {
      "another sender": `import { sendInviteEmail } from "@/lib/email";`,
      "a render builder": `import { magicLinkEmail, externalPlayInviteEmail } from "@/lib/email";`,
      "a type of the transport": `import type { DeliverMessage } from "@/server/email-outbox/transport";`,
      "an inline type of the gated name": `import { type deliver } from "@/lib/email";`,
      "another outbox export": `import { dispatchNow, enqueueEmail } from "@/server/email-outbox";`,
      "the same word elsewhere": `import { deliver } from "@/lib/something-else";`,
      "a package": `import { deliver } from "some-package";`,
      "a type query": `const actual = await importOriginal<typeof import("@/lib/email")>();\nactual.sendInviteEmail();`,
      "a dynamic load that names nothing gated": `const m = await import("@/lib/email");\nm.sendInviteEmail(x);`,
      "a dynamic load of another outbox module, in a file that mocks deliver": `vi.mock("@/server/email-outbox/transport", () => ({ deliver: vi.fn() }));\nconst { latestEmailStatus } = await import("@/server/email-outbox/status");`,
      "the type of a gated function, by a type query": `type Deliver = typeof import("@/lib/email").deliver;`,
      "a type taken off a dynamic import": `const f = (msg: import("@/server/email-outbox/transport").DeliverMessage) => msg;`,
      "a destructured sender": `const { sendInviteEmail } = await import("@/lib/email");`,
      "a vi.mock string": `vi.mock("@/server/email-outbox/transport", () => ({ deliver: vi.fn() }));`,
      "a mock of the worker's claim by name": `vi.mock("@/server/email-outbox/worker", () => ({ claimOne: vi.fn() }));`,
      "a namespace that never touches a gated name": `import * as mail from "@/lib/email";\nmail.sendInviteEmail(x);`,
      "a namespace named in comments": `import * as mail from "@/lib/email";\n// mail is only ever used for its senders\n/**\n * mail.sendInviteEmail is the one\n */\nmail.sendInviteEmail(x);`,
      "a namespace with an optional member": `import * as mail from "@/lib/email";\nmail?.sendInviteEmail(x);`,
      "a comment": `// import { deliver } from "@/lib/email";`,
      "after a block comment on the same line, legal": `/* the sender */ import { sendInviteEmail } from "@/lib/email";`,
      "an apostrophe in a comment inside the clause, legal": `import {\n  sendInviteEmail, // don't\n  sendReportSubmittedEmail,\n} from "@/lib/email";`,
      "a comment inside the clause that mentions a gated name": `import {\n  // deliver is not imported here\n  sendInviteEmail,\n} from "@/lib/email";`,
      "a type alias off a dynamic import": `type Mail = import("@/lib/email").TrialEndingEmail;\nconst f = vi.fn(async (o: Mail) => Boolean(o.to));`,
      "the bound name in a string and a comment": `const real = await vi.importActual("@/server/email-outbox/status");\n// the real read\nexpect(x, "premise: the real open").toBe(1);\nawait real.latestEmailStatus(a);`,
      "an object that happens to have a deliver key": `const t = { deliver: vi.fn() };\nawait t.deliver(m, k);`,
    };
    let checked = 0;
    for (const [name, src] of Object.entries(legal)) {
      expect(scanImports(src, at).offences, name).toEqual([]);
      checked += 1;
    }
    expect(checked).toBe(Object.keys(legal).length);
    expect(checked).toBeGreaterThanOrEqual(22);
  });

  it("the scanner sees the real forms: the transport's alias import and the unit test's relative import both offend", () => {
    // The two real files that legitimately import the gated names, one through the alias and one through a relative path.
    const transport = scanImports(read("server/email-outbox/transport.ts"), "server/email-outbox/transport.ts");
    expect(transport.offences).toEqual(["imports deliver from @/lib/email"]);
    const own = scanImports(read("lib/__tests__/email-send-result.test.ts"), "lib/__tests__/email-send-result.test.ts");
    expect(own.offences.map((o) => o.replace(/ from .*/, "")).sort()).toEqual(["imports checkSendable", "imports deliver", "imports sendWithResult"]);
  });

  it("the exemption for lib/email.ts's own unit test is exact and still needed", () => {
    expect(OWN_TESTS).toEqual(["lib/__tests__/email-send-result.test.ts"]);
    for (const f of OWN_TESTS) expect(scanImports(read(f), f).offences.length, `${f} still imports a gated function`).toBeGreaterThan(0);
  });

  it("the exemption is exactly the outbox's tests, lib/email.ts and that one unit test (no production file and no neighbour rides along)", () => {
    const exempted = ["server/email-outbox/__tests__/dispatch-wire.test.ts", "server/email-outbox/__tests__/_kind-harness.ts", "lib/email.ts", "lib/__tests__/email-send-result.test.ts"];
    const scanned = [
      // The outbox's own production files are scanned (and pinned), not exempt.
      "server/email-outbox/attempt.ts",
      "server/email-outbox/worker.ts",
      "server/email-outbox/transport.ts",
      "server/email-outbox/index.ts",
      "lib/mask-email.ts",
      "lib/email-templates/magic-link.ts",
      "lib/__tests__/email-builders.test.ts",
      "server/email-outbox-like/x.ts",
      "server/email-outbox-tests/x.ts",
      "server/usecases/registrations.ts",
      "app/api/auth/magic-link/route.ts",
    ];
    for (const f of exempted) expect(exempt(f), `${f} is exempt`).toBe(true);
    for (const f of scanned) expect(exempt(f), `${f} is scanned`).toBe(false);
  });

  it("no file under src/ outside lib/email.ts, its unit test and the outbox's tests imports deliver, sendWithResult, checkSendable or claimOne", () => {
    // The outbox's production files are in this walk: each is held to its pin (below) and nothing else may import the names at all.
    const files = allFiles().filter((r) => !exempt(r) && !isOutboxProduction(r));
    const offenders: string[] = [];
    let gatedModuleImports = 0;
    for (const f of files) {
      const scan = scanImports(read(f), f);
      gatedModuleImports += scan.gatedModuleImports;
      for (const o of scan.offences) offenders.push(`${f}: ${o}`);
    }
    expect(files.length, "anti-vacuity: files scanned").toBeGreaterThan(0);
    // The scan really observed code that imports the gated modules (dozens of files import a sender from lib/email), so it is not
    // reading nothing: it saw them and none named a gated function.
    expect(gatedModuleImports, "anti-vacuity: imports of lib/email or the outbox seen").toBeGreaterThan(0);
    expect(offenders).toEqual([]);
  }, 60_000);

  it("the walk covers the tree, including tests, and skips only what it names", () => {
    const files = allFiles();
    expect(files).toContain("lib/email.ts");
    expect(files).toContain("server/email-outbox/transport.ts");
    expect(files).toContain("app/api/auth/magic-link/route.ts");
    expect(files.some((f) => f.includes("/__tests__/")), "tests are scanned for imports").toBe(true);
  });
});

// ---------------------------------------------------------------------------------------------------------------------------------
// 3. The outbox's own production files, one by one
// ---------------------------------------------------------------------------------------------------------------------------------

describe("3. the outbox's production files import exactly what is pinned (phase 4 carries dispatch and the worker out of this app)", () => {
  it("the pin sees a second way out in a core file: a re-export of the transport, a render builder, a namespace, a star", () => {
    const planted: Record<string, [string, string]> = {
      "a re-export of deliver under another name": ["server/email-outbox/enqueue.ts", `export { deliver as rawSend } from "./transport";`],
      "a re-export of everything from the transport": ["server/email-outbox/index.ts", `export * from "./transport";`],
      "the gate imported where it is not pinned": ["server/email-outbox/worker.ts", `import { checkSendable } from "@/lib/email";`],
      "a render builder in the worker": ["server/email-outbox/worker.ts", `import { magicLinkEmail } from "@/lib/email";`],
      "a render builder in dispatch": ["server/email-outbox/attempt.ts", `import { checkSendable } from "@/lib/email";\nimport { deliver } from "./transport";\nimport { registrationEmail } from "@/lib/email";`],
      "a template in the worker": ["server/email-outbox/worker.ts", `import { renderMagicLink } from "@/lib/email-templates/magic-link";`],
      "a namespace of lib/email in a core file": ["server/email-outbox/recipient.ts", `import * as mail from "@/lib/email";\nmail.sendInviteEmail(x);`],
      "a run-time load of lib/email in a core file": ["server/email-outbox/hooks.ts", `const m = await import("@/lib/email");\nm.sendInviteEmail(x);`],
      "the gate dropped from attempt.ts": ["server/email-outbox/attempt.ts", `import { deliver } from "./transport";`],
      "the transport called twice in attempt.ts": ["server/email-outbox/attempt.ts", `import { checkSendable } from "@/lib/email";\nimport { deliver } from "./transport";\nimport { deliver as again } from "./transport";`],
      "claimOne imported by a core file": ["server/email-outbox/cancel.ts", `import { claimOne } from "./worker";`],
    };
    let checked = 0;
    for (const [name, [file, src]] of Object.entries(planted)) {
      expect(outboxDiff(src, file).length, name).toBeGreaterThan(0);
      checked += 1;
    }
    expect(checked).toBe(Object.keys(planted).length);
  });

  it("the pin accepts what is pinned, and a type-only or non-lib/email import in a core file", () => {
    const legal: Record<string, [string, string]> = {
      "attempt.ts as pinned": ["server/email-outbox/attempt.ts", `import { checkSendable, type DeliverResult } from "@/lib/email";\nimport { deliver } from "./transport";`],
      "transport.ts as pinned": ["server/email-outbox/transport.ts", `import { deliver as postToResend, type DeliverResult } from "@/lib/email";`],
      "a type from lib/email": ["server/email-outbox/classify.ts", `import type { SendResult } from "@/lib/email";`],
      "an inline type from lib/email": ["server/email-outbox/classify.ts", `import { type SendResult } from "@/lib/email";`],
      "the outbox's other modules": ["server/email-outbox/worker.ts", `import { dispatchNow } from "./attempt";\nimport { OUTBOX_KINDS } from "./constants";`],
      "the logger": ["server/email-outbox/hooks.ts", `import { log } from "@/server/logger";`],
    };
    let checked = 0;
    for (const [name, [file, src]] of Object.entries(legal)) {
      expect(outboxDiff(src, file), name).toEqual([]);
      checked += 1;
    }
    expect(checked).toBe(Object.keys(legal).length);
  });

  it("every production file of the outbox is exactly as pinned, and the pins name files that exist and are still needed", () => {
    const files = allFiles().filter(isOutboxProduction);
    const problems: string[] = [];
    for (const f of files) problems.push(...outboxDiff(read(f), f));
    expect(files.length, `anti-vacuity: ${files.length} outbox production files checked`).toBeGreaterThanOrEqual(15);
    expect(files, "the two pinned files are among them").toEqual(expect.arrayContaining(Object.keys(OUTBOX_PINS)));
    expect(problems).toEqual([]);
    // A pin is a licence to import a gated name: one that no longer matches a real import would license a future one.
    for (const [f, pin] of Object.entries(OUTBOX_PINS)) {
      expect(scanImports(read(f), f).offences.length, `${f} still imports what its pin allows`).toBe(pin.gated.length);
    }
  });
});

// ---------------------------------------------------------------------------------------------------------------------------------
// 4. The Resend URL, the key and the mail SDKs
// ---------------------------------------------------------------------------------------------------------------------------------

const RESEND_HOST = "api.resend.com";
/** The only production file that names the host: the wire function. (The outbox's transport reaches Resend through it and names no host.) */
const RESEND_HOLDERS: readonly string[] = ["lib/email.ts"];
/** The production files that name the key that authorises a send, exactly: the wire function reads it, the outbox's seal and readiness
 *  check it (is the box able to queue at all), and dev-links says why a link is shown when it is unset. A provider other than Resend, or a
 *  host assembled at run time, still needs a key: a new file that names it has to be added here by someone who read it. */
const RESEND_KEY_READERS: readonly string[] = ["lib/dev-links.ts", "lib/email.ts", "server/email-outbox/readiness.ts", "server/email-outbox/seal.ts"];
const RESEND_KEY = "RESEND_API_KEY";
/** Mail SDKs whose import would be a second way out. */
const MAIL_PACKAGES = /^(?:resend|@resend\/.+|nodemailer|@sendgrid\/.+|postmark|mailgun(?:\.js)?|@aws-sdk\/client-ses(?:v2)?|aws-sdk)$/;

/** Bare package specifiers a source imports or requires. */
function packagesOf(source: string): string[] {
  const out: string[] = [];
  for (const m of source.matchAll(/(?:\bfrom|\bimport|\brequire)\s*\(?\s*["']([^"'./@][^"']*|@[^"'/]+\/[^"']+)["']/g)) out.push(m[1]!);
  return out;
}

describe("4. Resend is reached from one place", () => {
  it("the production predicate keeps production and drops tests", () => {
    const production = ["lib/email.ts", "server/usecases/registrations.ts", "app/api/x/route.ts", "components/a.tsx"];
    const tests = ["lib/__tests__/email.test.ts", "server/usecases/__tests__/_invite-mail.ts", "app/x/a.test.ts", "app/x/a.spec.tsx", "a/__tests__/b/c.ts"];
    for (const p of production) expect(isProduction(p), p).toBe(true);
    for (const t of tests) expect(isProduction(t), t).toBe(false);
  });

  it("tests do name the host (that is why they are not scanned), and the production predicate really excludes them", () => {
    const known = ["server/email-outbox/__tests__/dispatch-wire.test.ts", "server/usecases/__tests__/_invite-mail.ts", "lib/__tests__/email-send-result.test.ts"];
    for (const f of known) {
      expect(read(f), `${f} names the host`).toContain(RESEND_HOST);
      expect(isProduction(f), `${f} is not production`).toBe(false);
    }
  });

  it("the package matcher reads imports, requires and re-exports, and only bare mail packages", () => {
    const src = [
      `import { Resend } from "resend";`,
      `import nodemailer from 'nodemailer'`,
      `const sg = require("@sendgrid/mail");`,
      `const ses = await import("@aws-sdk/client-ses");`,
      `import { x } from "@/lib/email";`,
      `import { y } from "./resend";`,
      `import { z } from "react";`,
    ].join("\n");
    const found = packagesOf(src);
    expect(found.filter((p) => MAIL_PACKAGES.test(p)).sort()).toEqual(["@aws-sdk/client-ses", "@sendgrid/mail", "nodemailer", "resend"]);
    expect(found, "and the local and unrelated imports are read as packages or ignored, never as mail").toContain("react");
  });

  it("exactly lib/email.ts names api.resend.com among production files, and none imports a mail SDK", () => {
    const files = allFiles().filter(isProduction);
    const holders: string[] = [];
    const sdk: string[] = [];
    for (const f of files) {
      const source = read(f);
      if (source.includes(RESEND_HOST)) holders.push(f);
      for (const p of packagesOf(source)) if (MAIL_PACKAGES.test(p)) sdk.push(`${f}: ${p}`);
    }
    // Reported, and zero is a failure (ruling C2): the scan walked production source.
    expect(files.length, `anti-vacuity: ${files.length} production files scanned`).toBeGreaterThan(0);
    // The positive pair, and the whole list: a holder that is listed but does not hold (the transport once was) would license the next.
    expect(holders, "the wire function names the host").toContain("lib/email.ts");
    expect(holders.sort(), "the holders are exactly the pinned list").toEqual([...RESEND_HOLDERS].sort());
    expect(sdk).toEqual([]);
  }, 60_000);

  it("the key that authorises a send is named in exactly the pinned production files", () => {
    const files = allFiles().filter(isProduction);
    const readers = files.filter((f) => read(f).includes(RESEND_KEY));
    expect(files.length, "anti-vacuity: production files scanned").toBeGreaterThan(0);
    expect(readers, "the wire function reads it").toContain("lib/email.ts");
    expect(readers.sort()).toEqual([...RESEND_KEY_READERS].sort());
  }, 60_000);
});
