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

const ROUTE_GLOB = fileURLToPath(new URL("../../app/**/route.ts", import.meta.url));

/** `NextResponse.redirect(new URL(<our path>, req.url | baseUrl(req)))` — the
 *  two spellings that bake a guessed origin into a Location header. */
const GUESSED_ORIGIN = /NextResponse\s*\.\s*redirect\(\s*new URL\([\s\S]{0,200}?,\s*(?:req\.url|baseUrl\()/g;

describe("redirects to our own paths carry no guessed origin", () => {
  it("no route handler builds a Location on req.url or baseUrl(req)", () => {
    const files = globSync(ROUTE_GLOB);
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
      for (const m of code.matchAll(GUESSED_ORIGIN)) {
        const line = code.slice(0, m.index).split("\n").length;
        offenders.push(`${file.split("/apps/web/")[1]}:${line}`);
      }
    }

    expect(
      offenders,
      "these redirect to one of our own paths on an origin taken from the request; behind a proxy, or on a server bound to 0.0.0.0, they send the user cross-origin and the browser withholds the session cookie. Use redirectLocal() from @/lib/http",
    ).toEqual([]);
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
