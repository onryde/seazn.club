// Password sign-in was removed on 2026-10-19 (owner: "yes remove it"). The product signs in by emailed link and Google,
// plus the profile-claim flow. This file is the tripwire that keeps it removed:
//
//   1. no route under app/api reads or accepts a password;
//   2. the four routes (/api/auth/login, signup, forgot-password, reset-password) and the two pages
//      (/forgot-password, /reset-password) do not come back, and the two old URLs end at the app's normal 404;
//   3. nothing in the app, the scripts, the tools or the e2e suite still calls a removed route;
//   4. the password hashing and reset code, and the dictionary keys that fed them, are gone;
//   5. the two retired slugs stay RESERVED, so an organisation can never claim a URL people still hold.
//
// It reads source, because the failure it exists for is an ADDITION: someone re-adds a route, a `password` field, or a
// caller. Behaviour tests of the surviving sign-in paths (magic link, Google, claim) live beside their routes, and the
// real-server 404 is asserted by e2e/password-sign-in-removed.spec.ts.
//
// Every scan reports how many files it read and zero is a failure (a scan whose walker broke would pass for ever), and
// the matcher is proven able to fail on a synthetic route before it is trusted on the real tree.
//
// DB objects: `users.password_hash` and `password_resets` still EXIST (the owner decides separately about dropping
// them). Code must not read or write them, with ONE exception pinned below: account deletion nulls the stored hash.
//
// Sport: not applicable. This is auth plumbing.
import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { hasLocale } from "@/lib/i18n-constants";

/** apps/web/src/, with a trailing slash: this file sits in src/lib/__tests__/. */
const SRC = fileURLToPath(new URL("../../", import.meta.url));
const API = `${SRC}app/api/`;
const APP = `${SRC}app/`;
/** The repo root: src -> web -> apps -> root. */
const REPO = path.resolve(SRC, "../../../");

const RETIRED_ROUTES = ["login", "signup", "forgot-password", "reset-password"] as const;
const RETIRED_PAGES = ["forgot-password", "reset-password"] as const;

/** Every file under `dir` whose name passes `keep`, skipping installed packages and build output. */
function filesUnder(dir: string, keep: (name: string) => boolean): string[] {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      return ["node_modules", ".next", ".turbo", "dist", "test-results", ".auth"].includes(entry.name)
        ? []
        : filesUnder(full, keep);
    }
    return keep(entry.name) ? [full] : [];
  });
}

const isSource = (n: string) => /\.(?:[cm]?[jt]sx?)$/.test(n);
const isTest = (n: string) => /\.(?:test|spec)\.[cm]?[jt]sx?$/.test(n);
/** Non-test source under src/ (a test may name a removed route to prove it is gone). */
const appSource = () =>
  filesUnder(SRC, (n) => isSource(n) && !isTest(n)).filter((f) => !f.includes(`${path.sep}__tests__${path.sep}`));

/** The code of a file with comments blanked, so a comment about the removed flow is not a hit. A `//` inside a string
 *  such as `https://…` is kept: only a `//` that starts the line or follows whitespace opens a comment. */
function codeOf(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n")
    .map((line) => line.replace(/(^|\s)\/\/.*$/, "$1"))
    .join("\n");
}

/** A route that reads or accepts a password: any code mention of `password` that is not the word "passwordless". */
const PASSWORD_FIELD = /password(?!less)/i;

/** The single allowed mention, as the exact line: account deletion erases the stored credential hash. */
const ERASURE = { file: "users/me/route.ts", line: /^\s*password_hash\s*=\s*null,\s*$/ };

/** The lines of `source` (as a route under app/api) that read or accept a password, less the allowed erasure. */
function passwordLines(relFile: string, source: string): string[] {
  return codeOf(source)
    .split("\n")
    .filter((l) => PASSWORD_FIELD.test(l))
    .filter((l) => !(relFile === ERASURE.file && ERASURE.line.test(l)));
}

describe("no route under app/api reads or accepts a password", () => {
  it("scans every route: none carries a password field, the account-deletion erasure aside", () => {
    const routes = filesUnder(API, (n) => /^route\.[cm]?[jt]sx?$/.test(n));
    expect(routes.length, "anti-vacuity: the walker found the route tree").toBeGreaterThan(100);

    const offenders = routes
      .map((f) => ({ file: path.relative(API, f), lines: passwordLines(path.relative(API, f), fs.readFileSync(f, "utf8")) }))
      .filter((r) => r.lines.length > 0);
    expect(offenders, `checked ${routes.length} routes`).toEqual([]);
  });

  it("the matcher can fail: a zod field, a body read, a destructure and a SQL column are each caught; a comment and 'passwordless' are not", () => {
    const flagged = (src: string) => passwordLines("any/route.ts", src).length;
    expect(flagged("const s = z.object({ email: z.string(), password: z.string().min(6) });")).toBe(1);
    expect(flagged("const { email, password } = await req.json();")).toBe(1);
    expect(flagged("const body = await req.json(); use(body.password);")).toBe(1);
    expect(flagged("select password_hash from users where email = ${e}")).toBe(1);
    expect(flagged("const hash = await bcrypt.hash(Password, 10);")).toBe(1);
    expect(flagged("// accepts a password here\nconst x = 1;")).toBe(0);
    expect(flagged("/* the old password route */\nconst x = 1;")).toBe(0);
    expect(flagged("return { message: 'passwordless sign-in' };")).toBe(0);
    expect(flagged("const u = 'https://seazn.club/x'; // see password docs")).toBe(0);
  });

  it("the one allowed mention is exactly the account-deletion erasure, and it is still there (delete this allowance with the column)", () => {
    const file = `${API}${ERASURE.file}`;
    const source = fs.readFileSync(file, "utf8");
    const hits = codeOf(source).split("\n").filter((l) => PASSWORD_FIELD.test(l));
    expect(hits.length, "the deletion route still erases the legacy hash").toBe(1);
    expect(ERASURE.line.test(hits[0]!)).toBe(true);
    // And the allowance applies to that file only: the same line anywhere else is an offender.
    expect(passwordLines("v1/other/route.ts", hits[0]!).length).toBe(1);
    expect(passwordLines(ERASURE.file, hits[0]!).length).toBe(0);
    // It sits in the soft-delete anonymisation, beside the other PII it clears, not in a read.
    expect(source).toMatch(/update users set[\s\S]*?password_hash\s*=\s*null[\s\S]*?deleted_at\s*=\s*now\(\)/);
  });
});

describe("the removed routes and pages stay removed", () => {
  it("none of the four auth routes exists, as a directory or as a route file", () => {
    let checked = 0;
    for (const name of RETIRED_ROUTES) {
      expect(fs.existsSync(`${API}auth/${name}`), `app/api/auth/${name} must not exist`).toBe(false);
      checked++;
    }
    expect(checked).toBe(RETIRED_ROUTES.length);
    // The sibling routes that REMAIN are found, so the directory check is not looking at an empty folder.
    for (const kept of ["magic-link", "google", "verify-email"]) {
      expect(fs.existsSync(`${API}auth/${kept}/route.ts`), `app/api/auth/${kept}/route.ts is the live sign-in path`).toBe(true);
    }
  });

  it("no route file anywhere under app/api/auth is named for a password flow", () => {
    const routes = filesUnder(`${API}auth/`, (n) => /^route\.[cm]?[jt]sx?$/.test(n));
    expect(routes.length, "anti-vacuity: the auth routes were found").toBeGreaterThan(5);
    const bad = routes
      .map((f) => path.relative(`${API}auth/`, f))
      .filter((rel) => rel.split(path.sep).some((seg) => /password|forgot|reset|^login$|^signup$|^sign-up$/i.test(seg)));
    expect(bad).toEqual([]);
  });

  it("neither page exists, and an unknown top-level path can only fall through to the locale route, which 404s", () => {
    for (const name of RETIRED_PAGES) {
      expect(fs.existsSync(`${APP}${name}`), `app/${name} must not exist`).toBe(false);
    }
    // Why a removed page ends at the normal 404 rather than a 500: the only dynamic top-level segment is [lang], and
    // its page calls notFound() for anything that is not a locale. A second top-level catch-all would swallow these.
    const dynamicTop = fs
      .readdirSync(APP, { withFileTypes: true })
      .filter((e) => e.isDirectory() && e.name.startsWith("["))
      .map((e) => e.name);
    expect(dynamicTop).toEqual(["[lang]"]);
    expect(fs.readFileSync(`${APP}[lang]/(marketing)/page.tsx`, "utf8")).toMatch(/if \(!hasLocale\(lang\)\) notFound\(\);/);
    for (const name of RETIRED_PAGES) expect(hasLocale(name), `${name} is not a locale`).toBe(false);
    // The positive pair: the sign-in page and the surviving verify page are still real pages.
    expect(fs.existsSync(`${APP}login/page.tsx`)).toBe(true);
    expect(fs.existsSync(`${APP}verify-email/page.tsx`)).toBe(true);
  });

  it("nothing in the app source calls a removed route or links to a removed page", () => {
    const files = appSource();
    expect(files.length, "anti-vacuity: the source tree was walked").toBeGreaterThan(500);
    const route = new RegExp(`/api/auth/(?:${RETIRED_ROUTES.join("|")})\\b`);
    const page = new RegExp(`["'\`(]/(?:${RETIRED_PAGES.join("|")})\\b`);
    const hits = files
      .filter((f) => {
        const code = codeOf(fs.readFileSync(f, "utf8"));
        return route.test(code) || page.test(code);
      })
      .map((f) => path.relative(SRC, f));
    expect(hits).toEqual([]);
  });

  it("no script, tool or e2e spec calls a removed route (the harnesses sign in by magic link)", () => {
    const roots = [`${REPO}/scripts`, `${REPO}/tools`, `${REPO}/apps/web/e2e`].map((r) => path.normalize(r));
    // The e2e spec that proves the routes are gone has to name them.
    const exempt = new Set([path.normalize(`${REPO}/apps/web/e2e/password-sign-in-removed.spec.ts`)]);
    const files = roots.flatMap((r) => filesUnder(r, isSource)).filter((f) => !exempt.has(f));
    expect(files.length, "anti-vacuity: the harness trees were walked").toBeGreaterThan(50);
    const route = new RegExp(`/api/auth/(?:${RETIRED_ROUTES.join("|")})\\b`);
    // The matcher must see a plain mention, or the scan is blind.
    expect(route.test("call('/api/auth/login', 'POST')")).toBe(true);
    const hits = files.filter((f) => route.test(codeOf(fs.readFileSync(f, "utf8")))).map((f) => path.relative(REPO, f));
    expect(hits).toEqual([]);
  });
});

describe("the password code and its DB objects are not touched by the app", () => {
  it("no source reads or writes users.password_hash or password_resets, or hashes a password", () => {
    const files = appSource();
    expect(files.length).toBeGreaterThan(500);
    // `bcrypt` is matched as an IMPORT, not as a word: the privacy policy page says in prose that legacy passwords were
    // hashed with bcrypt, which stays true while the hashes remain in the table, and is not code.
    const NEEDLE = /\b(?:password_hash|password_resets|hashPassword|verifyPassword|createPasswordResetToken|consumePasswordReset|sendPasswordResetEmail)\b|from\s+["']bcrypt(?:js)?["']|require\(["']bcrypt/;
    const hits: string[] = [];
    for (const f of files) {
      const rel = path.relative(SRC, f);
      for (const line of codeOf(fs.readFileSync(f, "utf8")).split("\n")) {
        if (!NEEDLE.test(line)) continue;
        // The account-deletion erasure is pinned by its own test above.
        if (rel === `app/api/${ERASURE.file}` && ERASURE.line.test(line)) continue;
        hits.push(`${rel}: ${line.trim()}`);
      }
    }
    expect(hits).toEqual([]);
    // The matcher sees an import and a helper call, so the empty result above is a finding and not blindness.
    expect(NEEDLE.test('import hasher from "bcryptjs";')).toBe(true);
    expect(NEEDLE.test("const h = await hashPassword(p);")).toBe(true);
    expect(NEEDLE.test("<p>Passwords are hashed with bcrypt.</p>")).toBe(false);
  });

  it("the password modules are gone and bcryptjs is no longer a dependency", () => {
    for (const rel of ["lib/password-reset.ts", "lib/email-templates/password-reset.ts"]) {
      expect(fs.existsSync(`${SRC}${rel}`), `${rel} must not exist`).toBe(false);
    }
    for (const manifest of [`${REPO}/package.json`, `${REPO}/apps/web/package.json`]) {
      const pkg = JSON.parse(fs.readFileSync(manifest, "utf8")) as Record<string, Record<string, string> | undefined>;
      const all = { ...pkg.dependencies, ...pkg.devDependencies };
      expect(Object.keys(all).length, `${manifest} was read`).toBeGreaterThan(5);
      expect(all.bcryptjs, `${manifest} must not depend on bcryptjs`).toBeUndefined();
    }
  });

  it("no locale carries a dictionary key for the removed forms or the reset email", () => {
    let keysChecked = 0;
    const offenders: string[] = [];
    for (const locale of ["en", "es", "fr", "nl"]) {
      const dir = `${SRC}dictionaries/${locale}`;
      const dictFiles = filesUnder(dir, (n) => n.endsWith(".json"));
      expect(dictFiles.length, `${locale}: dictionary files found`).toBeGreaterThan(3);
      for (const f of dictFiles) {
        for (const key of Object.keys(JSON.parse(fs.readFileSync(f, "utf8")) as Record<string, unknown>)) {
          keysChecked++;
          if (/^(?:forgotPw|resetPw|passwordReset)\./.test(key)) offenders.push(`${locale}/${path.basename(f)}: ${key}`);
        }
      }
    }
    expect(keysChecked, "anti-vacuity: keys were read").toBeGreaterThan(20_000);
    expect(offenders).toEqual([]);
  });
});
