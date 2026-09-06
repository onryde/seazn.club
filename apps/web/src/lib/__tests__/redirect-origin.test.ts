import { describe, expect, it } from "vitest";
import { globSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { redirectLocal } from "@/lib/http";

/**
 * No route handler may build a redirect to one of OUR OWN paths on top of an
 * origin taken from the request.
 *
 * This is a source scan, and it is a source scan on purpose. The defect it
 * guards is invisible to every runtime test we can afford to run:
 *
 * - It only appears when the server's BIND ADDRESS differs from the origin the
 *   browser is on. The local harness pins HOSTNAME=127.0.0.1 and CI pins
 *   nothing (Next standalone then binds 0.0.0.0), so a test that drives the
 *   route locally is structurally unable to witness it.
 * - Two of the four sites this scan covers are Google OAuth error branches,
 *   reachable only with real OAuth configuration that CI does not carry.
 *
 * The mechanism: `req.url` is the server's internal binding, not the address
 * the browser is on (`lib/oauth.ts:25-26` says so). `baseUrl(req)` escapes it
 * ONLY when a proxy sets `x-forwarded-host` or an env override exists —
 * otherwise it falls through to `new URL(req.url).origin` and lands back on
 * the binding. The browser then withholds the session cookie across the origin
 * hop, and the destination sees a signed-out visitor. That is how an
 * email-change confirmation reached `/login` AFTER committing the new address
 * (CI run 33968571673).
 *
 * A third-party URL is a different case and stays absolute: Google's consent
 * URL and `googleRedirectUri()` are resolved by Google, not by our browser, so
 * they are not matched here — the pattern below only fires on the TWO-argument
 * `new URL(path, base)` form, which by construction means "a path of ours,
 * plus an origin we guessed".
 */

// Route handlers are route.ts AND route.tsx (one exists:
// (public)/r/[ref]/ticket.png/route.tsx), plus middleware, plus anything under
// src/server that builds a Response itself. A glob of route.ts alone was the
// review's finding: it silently exempts three whole classes of file.
const GLOBS = [
  "../../app/**/route.ts",
  "../../app/**/route.tsx",
  "../../middleware.ts",
  "../../server/**/*.ts",
].map((g) => fileURLToPath(new URL(g, import.meta.url)));

/** `NextResponse.redirect(new URL(<our path>, req.url | baseUrl(req)))` — the
 *  two spellings that bake a guessed origin into a Location header. */
//
// Matches a REDIRECT CALL whose argument derives from the request's origin.
// Two revisions got this wrong in opposite directions and both are worth
// keeping in mind:
//
//  - v1 matched one exact call shape and caught 1 of 11 hand-written variants.
//  - v2 also matched `${baseUrl(req)}...` anywhere, and fired on 19 sites that
//    are all CORRECT: emailed links, Stripe return_urls, invite/claim links, a
//    QR code. Those must be absolute — they are resolved by a mail client, by
//    Stripe, by a phone camera, not by a browser following a Location header.
//    A scan that reds on 19 correct lines gets deleted, not obeyed.
//
// So the anchor is the redirect, not the origin: building an absolute URL is
// fine, putting a guessed origin in a Location is not.
//
// KNOWN GAP, stated rather than papered over: a URL hoisted into a variable
// (`const u = new URL(p, req.url); return NextResponse.redirect(u)`) is not
// caught. Catching it needs real scope analysis, and the unit tests on
// redirectLocal below are the second line of defence.
const ORIGIN_SOURCE =
  /(?:NextResponse|Response)\s*\.\s*redirect\([^;]{0,200}?(?:(?:req|request)\.(?:url|nextUrl)|baseUrl\()/g;

describe("redirects to our own paths carry no guessed origin", () => {
  it("no route handler builds a Location on req.url or baseUrl(req)", () => {
    const files = GLOBS.flatMap((g) => globSync(g)).filter(
      (f) => !/\.(test|spec)\.tsx?$/.test(f) && !f.includes("/__tests__/"),
    );
    // Guards the guard: a glob that silently matches nothing would make every
    // assertion below vacuous, and this file would pass for ever while the
    // defect walked back in.
    expect(
      files.length,
      "the route glob matched no files — this scan would pass vacuously",
    ).toBeGreaterThan(50);

    const offenders: string[] = [];
    for (const file of files) {
      const src = readFileSync(file, "utf8");
      // Comments are BLANKED, not deleted — replacing each character with a
      // space keeps every byte offset intact, so the line numbers reported
      // below still point at real source.
      //
      // Not optional. The first run of this scan reported
      // `confirm/route.ts:9` — its own doc comment, which quotes the bad
      // spelling verbatim in order to explain it. A guard that fires on the
      // documentation of the defect it guards would be paid for by deleting
      // the explanation, which is the wrong trade every time.
      const code = src
        .replace(/\/\*[\s\S]*?\*\//g, (c) => c.replace(/[^\n]/g, " "))
        .replace(/(^|[^:])\/\/[^\n]*/g, (m0, p1: string) =>
          p1 + " ".repeat(m0.length - p1.length),
        );
      const rel = file.split("/apps/web/")[1];
      for (const m of code.matchAll(ORIGIN_SOURCE)) {
        const line = code.slice(0, m.index).split("\n").length;
        offenders.push(`${rel}:${line}`);
      }
    }

    expect(
      offenders,
      "these redirect to one of our own paths on an origin taken from the request; behind a proxy, or on a server bound to 0.0.0.0, they send the user cross-origin and the browser withholds the session cookie. Use redirectLocal() from @/lib/http",
    ).toEqual([]);
  });

  it("percent-encodes, because a Location above U+00FF throws rather than redirects", () => {
    // `safeNextPath` accepts non-Latin-1, and google/route.ts stores `next`
    // raw behind a `startsWith("/")` check, so this input is reachable:
    // /api/auth/google?next=/o/中文. The absolute spellings encoded it as a
    // side effect of building a URL; dropping the origin without keeping the
    // encoding turned that into a 500.
    expect(redirectLocal("/o/中文").headers.get("location")).toBe(
      "/o/%E4%B8%AD%E6%96%87",
    );
  });

  it.each([
    ["//evil.com", "protocol-relative — a valid Location, and not ours"],
    ["https://evil.com/x", "absolute off-site"],
    ["/\\\\evil.com", "backslash form some parsers read as protocol-relative"],
  ])("refuses %s (%s)", (input) => {
    expect(redirectLocal(input).headers.get("location")).toBe("/");
  });

  it("normalises traversal rather than emitting it", () => {
    expect(redirectLocal("/a/../../b").headers.get("location")).toBe("/b");
  });

  it("redirectLocal emits a relative Location and no origin", () => {
    const res = redirectLocal("/settings?tab=account&email_change=success");
    expect(res.status).toBe(307);
    // Asserted as an equality, not a `startsWith("/")`: that predicate is
    // satisfied by a redirect to the wrong path, and `not.toContain("://")` is
    // satisfied by an empty header.
    expect(res.headers.get("location")).toBe(
      "/settings?tab=account&email_change=success",
    );
  });

  it("carries a 308 through when asked, so a permanent move stays permanent", () => {
    expect(redirectLocal("/start", 308).status).toBe(308);
  });
});
