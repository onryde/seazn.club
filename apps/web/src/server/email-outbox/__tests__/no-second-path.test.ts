// No second path to Resend (phase 3 wave 1, T7; spec "no second path"). The outbox is the only way mail leaves: it replaces, retries,
// seals, resolves the account's address at send time and releases a seat that ended badly. A `send*` that mails straight to Resend
// skips every one of those, and a future Email Service (phase 4) takes over dispatch, the worker and the webhook, so the seam it takes
// over has to be the ONLY one. This file keeps three claims, by reading the source (no runner, no database):
//
//  1. Allowlist. The `send*` exports of lib/email.ts are exactly the typed list below (49). A new `send*` is a new direct sender, and
//     adding one is a decision this test makes someone take on purpose. Each kind that moves to the outbox (T8-T12) deletes its
//     `send*` in the same commit as it adds its enqueue, and removes its name here.
//  2. Imports. Nothing outside the outbox (src/server/email-outbox/) and lib/email.ts itself imports `deliver`, `sendWithResult` or
//     `checkSendable` - from lib/email, from the transport, or by any path to either (an alias, a relative path, a re-export, a
//     namespace import, a dynamic import).
//  3. Resend. No PRODUCTION source outside lib/email.ts and the transport names `api.resend.com`, and none imports a mail SDK.
//     Tests name the host legitimately (a fetch stub answers for it), so they are not scanned (controller ruling C2): the count of
//     production files scanned is reported, and zero is a failure.
//
// Every matcher is exercised on planted sources first, in the forms a bypass would take, and on the real files that carry the legal
// forms of the same thing (a scanner that finds nothing proves nothing). Sport: not applicable.
import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, posix, relative, resolve } from "node:path";

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

/** The 49 `send*` exports of lib/email.ts as of the start of phase 3 wave 1 (spec: "49 send* exports"), copied once from the file.
 *  `sendWithResult` is the outbox's own typed sender and is not among them. T8-T12 each delete one name (and its function). */
const SENDER_ALLOWLIST: readonly string[] = [
  "sendAccountDeletionEmail",
  "sendAiRunCostAlertEmail",
  "sendClaimInviteEmail",
  "sendConnectBankAlertEmail",
  "sendCreditPackGrantFailedAlertEmail",
  "sendDisputeAlertEmail",
  "sendDisputeLostEmail",
  "sendEarnGrantVolumeAlertEmail",
  "sendEmailChangeConfirmation",
  "sendEmailChangeNotice",
  "sendExtraOrgAllowanceAlertEmail",
  "sendExtraOrgRepriceFailedAlertEmail",
  "sendFunnelClaimEmail",
  "sendFunnelReminderEmail",
  "sendGroupOrgLeftEmail",
  "sendGroupOrgRemovedEmail",
  "sendInviteEmail",
  "sendOfficialAssignedEmail",
  "sendOfficialAssignmentChangedEmail",
  "sendOfficialInviteEmail",
  "sendPassCreditReversalIncompleteAlertEmail",
  "sendPassRevokedEmail",
  "sendPassRungMismatchAlertEmail",
  "sendPassUnknownCompetitionAlertEmail",
  "sendPaymentReminderEmail",
  "sendRefundIssuedEmail",
  "sendRegistrationEmail",
  "sendRegistrationPromotedEmail",
  "sendRegistrationRefundFailedAlertEmail",
  "sendReportSubmittedEmail",
  "sendSizePackGrantFailedAlertEmail",
  "sendSoloSignUpAssignedEmail",
  "sendSponsorDisputeAlertEmail",
  "sendSponsorDisputeLostEmail",
  "sendSponsorDisputeWonEmail",
  "sendSponsorInvoiceEmail",
  "sendSponsorReceiptEmail",
  "sendSponsorRefundEmail",
  "sendStaffDisputeAlertEmail",
  "sendStreamCreditClawbackAlertEmail",
  "sendStreamCreditGrantFailedAlertEmail",
  "sendStreamPackPriceDriftAlertEmail",
  "sendStuckEventsAlertEmail",
  "sendSuspensionConfirmedEmail",
  "sendSuspensionServedEmail",
  "sendTransferCompleteEmail",
  "sendTransferOfferEmail",
  "sendTrialEndingEmail",
  "sendVerificationEmail",
];

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

/** The three things only the outbox may call: the transport's wire function, the typed sender, and the gate (key, suppression). */
const GATED_NAMES: readonly string[] = ["deliver", "sendWithResult", "checkSendable"];

/** A module specifier as a path under src/ with no extension and no trailing /index, or null for a package or a path outside src/. */
function moduleOf(spec: string, fromRel: string): string | null {
  let p: string;
  if (spec.startsWith("@/")) p = spec.slice(2);
  else if (spec.startsWith("./") || spec.startsWith("../")) p = posix.normalize(posix.join(posix.dirname(fromRel), spec));
  else return null;
  if (p.startsWith("..")) return null;
  return p.replace(/\.[cm]?[jt]sx?$/, "").replace(/\/index$/, "");
}

/** The modules that hold the gated names: lib/email, and the outbox directory (its index and its transport). */
const isGatedModule = (m: string): boolean => m === "lib/email" || m === "server/email-outbox" || m.startsWith("server/email-outbox/");

type Scan = { offences: string[]; gatedModuleImports: number };

/** What one file does with the gated modules: the offences (an import of a gated NAME from one, by any route) and how many of its
 *  imports reach a gated module at all (the positive control: a scanner that never sees an import of lib/email is blind). */
function scanImports(source: string, fromRel: string): Scan {
  const offences: string[] = [];
  let gatedModuleImports = 0;

  // import / export ... from "spec" (multi-line clauses included). `import type` / `export type` are erased and cannot call anything.
  // The clause may not contain another `import` / `export`: a statement with no semicolon must not swallow the one after it.
  const statement = /(?:^|;)[ \t]*(import|export)\s+(type\s+)?((?:(?!\b(?:import|export)\b)[^;'"`])*?)\s*from\s*["']([^"']+)["']/gm;
  for (const m of source.matchAll(statement)) {
    const [, keyword, typeOnly, clause = "", spec = ""] = m;
    const mod = moduleOf(spec, fromRel);
    if (mod === null || !isGatedModule(mod)) continue;
    gatedModuleImports += 1;
    if (typeOnly) continue;
    const star = /^\*\s*(?:as\s+(\w+))?$/.exec(clause.trim());
    if (keyword === "export" && star) {
      offences.push(`re-exports everything from ${spec}`);
      continue;
    }
    if (keyword === "import" && star?.[1]) {
      const ns = star[1];
      if (new RegExp(`\\b${ns}\\s*(?:\\.|\\[\\s*["'])\\s*(?:${GATED_NAMES.join("|")})\\b`).test(source)) offences.push(`uses ${ns}.<gated> from ${spec}`);
      continue;
    }
    const braces = /\{([^}]*)\}/.exec(clause);
    for (const token of (braces?.[1] ?? "").split(",")) {
      const t = token.trim();
      if (t === "" || /^type\s/.test(t)) continue; // `{ type X }` is erased
      const name = t.split(/\s+as\s+/)[0]!.trim();
      if (GATED_NAMES.includes(name)) offences.push(`${keyword === "import" ? "imports" : "re-exports"} ${name} from ${spec}`);
    }
  }

  // import("spec"), require("spec"), vi.importActual("spec"): a run-time load of a gated module, judged by what is DONE with it: a gated
  // name read straight off the call, destructured from it, read off the variable it is bound to, or picked in a `.then`. Loading the
  // module for something else (the status reader, a type) is not a bypass. `typeof import("spec")` is a type query and is erased.
  const dynamic = /(?<!typeof\s+)(?:\bimport|\brequire|\bimportActual)\s*(?:<[^>]*>)?\(\s*["']([^"']+)["']\s*\)/g;
  const gated = GATED_NAMES.join("|");
  for (const m of source.matchAll(dynamic)) {
    const spec = m[1]!;
    const mod = moduleOf(spec, fromRel);
    if (mod === null || !isGatedModule(mod)) continue;
    gatedModuleImports += 1;
    const before = source.slice(0, m.index);
    const after = source.slice(m.index + m[0].length);
    if (new RegExp(`^\\s*\\)?\\s*\\.\\s*(?:${gated})\\b`).test(after)) offences.push(`reads a gated name off the run-time load of ${spec}`);
    if (new RegExp(`^\\s*\\.\\s*then\\s*\\([^]{0,200}?\\b(?:${gated})\\b`).test(after)) offences.push(`picks a gated name in a .then of ${spec}`);
    const bound = /(?:const|let|var)\s+(\{[^}]*\}|[A-Za-z_$][\w$]*)\s*(?::[^=;]+)?=\s*(?:\(\s*|await\s+)*(?:vi\s*\.\s*)?$/.exec(before);
    if (bound) {
      const target = bound[1]!;
      if (target.startsWith("{")) {
        for (const token of target.slice(1, -1).split(",")) {
          const name = token.split(":")[0]!.trim();
          if (GATED_NAMES.includes(name)) offences.push(`destructures ${name} from the run-time load of ${spec}`);
        }
      } else if (new RegExp(`\\b${target.replace(/\$/g, "\\$")}\\s*(?:\\.|\\[\\s*["'])\\s*(?:${gated})\\b`).test(source)) {
        offences.push(`uses ${target}.<gated> from the run-time load of ${spec}`);
      }
    }
  }
  return { offences, gatedModuleImports };
}

/** Files that may touch the gated names: the outbox itself, the module that defines them, and that module's own unit test. */
const IN_OUTBOX = (r: string): boolean => r.startsWith("server/email-outbox/");
const OWNER = "lib/email.ts";
/** The unit test of lib/email.ts's own gate and wire function: it imports them by name because they are what it tests. Exactly this
 *  file, not a pattern; the test below keeps the exemption honest (it must still need it). */
const OWN_TESTS: readonly string[] = ["lib/__tests__/email-send-result.test.ts"];
const exempt = (r: string): boolean => IN_OUTBOX(r) || r === OWNER || OWN_TESTS.includes(r);

describe("2. nothing outside the outbox imports the gated functions", () => {
  const at = "app/x/y.ts";

  it("the scanner finds a bypass in every form it can take", () => {
    const forms: Record<string, string> = {
      "named, from lib/email": `import { deliver } from "@/lib/email";`,
      "named, from the transport": `import { deliver } from "@/server/email-outbox/transport";`,
      "the gate": `import { checkSendable } from "@/lib/email";`,
      "the typed sender": `import { sendWithResult } from "@/lib/email";`,
      "aliased": `import { deliver as post } from "@/lib/email";`,
      "among others": `import { sendInviteEmail, deliver } from "@/lib/email";`,
      "after an inline type": `import { type SendOptions, sendWithResult } from "@/lib/email";`,
      "multi-line": `import {\n  sendInviteEmail,\n  checkSendable,\n} from "@/lib/email";`,
      "relative path": `import { deliver } from "../../lib/email";`,
      "relative path with an extension": `import { deliver } from "../../lib/email.ts";`,
      "through the outbox index": `import { deliver } from "@/server/email-outbox";`,
      "through another outbox module": `import { sendWithResult } from "@/server/email-outbox/attempt";`,
      "a re-export by name": `export { deliver } from "@/lib/email";`,
      "a re-export of everything": `export * from "@/lib/email";`,
      "a namespace import, used": `import * as mail from "@/lib/email";\nawait mail.deliver(m, key);`,
      "a namespace import, indexed": `import * as mail from "@/lib/email";\nawait mail["checkSendable"](m);`,
      "a dynamic import, destructured": `const { deliver } = await import("@/lib/email");`,
      "a dynamic import, destructured and renamed": `const { deliver: post, sendInviteEmail } = await import("@/lib/email");`,
      "a dynamic import, bound then used": `const m = await import("@/server/email-outbox/transport");\nm.deliver(x, k);`,
      "a dynamic import, read off the call": `const send = (await import("@/lib/email")).sendWithResult;`,
      "a dynamic import, called off the call": `await (await import("@/lib/email")).deliver(m, k);`,
      "a dynamic import, in a then": `import("@/lib/email").then(({ deliver }) => deliver(m, k));`,
      "a require": `const { checkSendable } = require("../../lib/email");`,
      "an actual-module load": `const actual = await vi.importActual<typeof import("@/lib/email")>("@/lib/email");\nactual.sendWithResult(o);`,
      "on one line with another statement": `import a from "b"; import { deliver } from "@/lib/email";`,
    };
    let checked = 0;
    for (const [name, src] of Object.entries(forms)) {
      expect(scanImports(src, at).offences.length, name).toBeGreaterThan(0);
      checked += 1;
    }
    expect(checked, "anti-vacuity: every form was tried").toBe(Object.keys(forms).length);
    expect(checked).toBeGreaterThanOrEqual(20);
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
      "a type taken off a dynamic import": `const f = (msg: import("@/server/email-outbox/transport").DeliverMessage) => msg;`,
      "a destructured sender": `const { sendInviteEmail } = await import("@/lib/email");`,
      "a vi.mock string": `vi.mock("@/server/email-outbox/transport", () => ({ deliver: vi.fn() }));`,
      "a namespace that never touches a gated name": `import * as mail from "@/lib/email";\nmail.sendInviteEmail(x);`,
      "a comment": `// import { deliver } from "@/lib/email";`,
    };
    let checked = 0;
    for (const [name, src] of Object.entries(legal)) {
      expect(scanImports(src, at).offences, name).toEqual([]);
      checked += 1;
    }
    expect(checked).toBe(Object.keys(legal).length);
    expect(checked).toBeGreaterThanOrEqual(13);
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

  it("no file under src/ outside the outbox and lib/email.ts imports deliver, sendWithResult or checkSendable", () => {
    const files = allFiles().filter((r) => !exempt(r));
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
// 3. The Resend URL and the mail SDKs
// ---------------------------------------------------------------------------------------------------------------------------------

const RESEND_HOST = "api.resend.com";
/** The only production files that may name the host: the wire function (lib/email.ts) and the transport that wraps it. */
const RESEND_HOLDERS: readonly string[] = ["lib/email.ts", "server/email-outbox/transport.ts"];
/** Mail SDKs whose import would be a second way out. */
const MAIL_PACKAGES = /^(?:resend|@resend\/.+|nodemailer|@sendgrid\/.+|postmark|mailgun(?:\.js)?|@aws-sdk\/client-ses(?:v2)?|aws-sdk)$/;

/** Production source: not a test (a `__tests__` directory, or a `.test.` / `.spec.` file). Tests name the host to stub it. */
const isProduction = (r: string): boolean => !/(^|\/)__tests__\//.test(r) && !/\.(?:test|spec)\.[cm]?[jt]sx?$/.test(r);

/** Bare package specifiers a source imports or requires. */
function packagesOf(source: string): string[] {
  const out: string[] = [];
  for (const m of source.matchAll(/(?:\bfrom|\bimport|\brequire)\s*\(?\s*["']([^"'./@][^"']*|@[^"'/]+\/[^"']+)["']/g)) out.push(m[1]!);
  return out;
}

describe("3. Resend is reached from one place", () => {
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

  it("no production file outside lib/email.ts and the transport names api.resend.com, and none imports a mail SDK", () => {
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
    // The positive pair: the host IS found where it lives, so the scan can see it at all.
    expect(holders, "the wire function names the host").toContain("lib/email.ts");
    expect(holders.filter((h) => !RESEND_HOLDERS.includes(h))).toEqual([]);
    expect(sdk).toEqual([]);
  }, 60_000);
});
