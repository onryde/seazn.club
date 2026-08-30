// Every `apiV1(...)` call in a client component must address `/api/v1/…`.
//
// WHY THIS FILE EXISTS. `apiV1` (lib/client-v1.ts) is a thin wrapper around
// `fetch` that adds the envelope handling and PREPENDS NOTHING — the caller
// passes a full path. RS009's assign sheet called
// `/registrations/{id}/assign-targets` instead of
// `/api/v1/registrations/{id}/assign-targets`, so every open of the sheet
// 404'd in the browser.
//
// It shipped past a 5481-test suite, a clean tsc, a clean lint and both drift
// gates, because nothing in that stack can see it:
//
//  - unit tests never issue a real request;
//  - the route tests call the handler function directly, so the URL that
//    reaches Next's router is never exercised;
//  - `tsc` sees a template string, which is a string whatever it contains;
//  - the openapi gate compares the SPEC to the registry, not the client.
//
// It was found by clicking the button. This test is the cheap standing
// version of that click: a string check over the source, which cannot prove
// a route works but can prove no caller has forgotten the prefix again.
import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

const COMPONENTS = join(process.cwd(), "src", "components");

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) {
      return name === "__tests__" ? [] : sourceFiles(full);
    }
    return name.endsWith(".ts") || name.endsWith(".tsx") ? [full] : [];
  });
}

/** The first argument of every `apiV1(` call, as written in the source. */
function apiV1Targets(src: string): string[] {
  // Deliberately a plain scan rather than a parse: it only has to read the
  // first token after the paren, and a regex cannot silently "fix" a path
  // the way a clever AST walk might by resolving a variable.
  return [...src.matchAll(/\bapiV1\s*(?:<[^>]*>)?\s*\(\s*([`"'])/g)].map((m) => {
    const start = m.index + m[0].length;
    const quote = m[1];
    const end = src.indexOf(quote, start);
    return src.slice(start, end === -1 ? start : end);
  });
}

describe("apiV1 call paths", () => {
  const files = sourceFiles(COMPONENTS);

  it("finds the components that call apiV1 at all", () => {
    // Guards the guard: a scan that matches nothing passes every assertion
    // below and proves precisely nothing. If this ever drops to zero, the
    // regex has stopped matching, not the codebase stopped calling.
    const callers = files.filter((f) => apiV1Targets(readFileSync(f, "utf8")).length > 0);
    expect(callers.length).toBeGreaterThan(0);
  });

  it("addresses an absolute /api path in every call", () => {
    // The rule is "/api/", not "/api/v1/". `apiV1` is named for the envelope
    // it parses, not for a route prefix it enforces, and at least one caller
    // legitimately uses it against a non-v1 endpoint
    // (news/composer.tsx → /api/orgs/{id}/content-upload, which exists).
    // Requiring /api/v1 flagged that as a defect on this gate's first run.
    // The real bug class is a path with NO api prefix at all, which is what
    // RS009's sheet shipped.
    const offenders: string[] = [];
    for (const file of files) {
      for (const target of apiV1Targets(readFileSync(file, "utf8"))) {
        if (!target.startsWith("/api/")) {
          offenders.push(`${file.slice(file.indexOf("src/"))} → ${target}`);
        }
      }
    }
    expect(offenders, "apiV1 prepends nothing — pass the full /api/... path").toEqual([]);
  });
});
