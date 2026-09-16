// K-1 (2026-09-15): the /present kiosk left the org chrome layout by moving its
// two pages into the `(kiosk)` route group. A route group is not in the URL, so
// the move must change NO public URL — and must actually take the boards out
// from under `[orgSlug]/layout.tsx`, or the TV board is still boxed.
//
// Build-free: walks the app tree on disk, strips `(group)` segments, and maps
// every page / route handler / share image to the URL pattern Next serves it
// at. What this cannot see (a build and e2e do): Next's precedence of the
// static `present` segment over the chrome tree's `[divisionSlug]`.
import { readdirSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { describe, expect, it } from "vitest";

const APP = join(__dirname, "..", "..", "..");
const SHARED = join(APP, "(public)", "shared");

type Entry = { file: string; kind: "page" | "route" | "og"; url: string };

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) return name === "__tests__" ? [] : walk(full);
    return [full];
  });
}

function entries(): Entry[] {
  return walk(SHARED).flatMap((full): Entry[] => {
    const rel = relative(join(APP, "(public)"), full).split(sep);
    const name = rel.at(-1)!;
    const kind = /^page\.tsx?$/.test(name) ? "page" : /^route\.tsx?$/.test(name) ? "route" : /^opengraph-image\.tsx?$/.test(name) ? "og" : null;
    if (kind === null) return [];
    const segments = rel.slice(0, -1).filter((s) => !/^\(.+\)$/.test(s));
    return [{ file: rel.join("/"), kind, url: "/" + segments.join("/") }];
  });
}

/** Every page URL under /shared BEFORE the move, typed out, never derived. */
const PAGES_BEFORE_K1 = [
  "/shared/[orgSlug]",
  "/shared/[orgSlug]/news",
  "/shared/[orgSlug]/news/[postSlug]",
  "/shared/[orgSlug]/[competitionSlug]",
  "/shared/[orgSlug]/[competitionSlug]/players/[personId]",
  "/shared/[orgSlug]/[competitionSlug]/poster",
  "/shared/[orgSlug]/[competitionSlug]/present",
  "/shared/[orgSlug]/[competitionSlug]/register",
  "/shared/[orgSlug]/[competitionSlug]/register/join",
  "/shared/[orgSlug]/[competitionSlug]/register/status",
  "/shared/[orgSlug]/[competitionSlug]/[divisionSlug]",
  "/shared/[orgSlug]/[competitionSlug]/[divisionSlug]/present",
  "/shared/[orgSlug]/[competitionSlug]/[divisionSlug]/fixtures/[fixtureId]",
].sort();

const ROUTES_BEFORE_K1 = [
  "/shared/[orgSlug]/news/[postSlug]/story.png",
  "/shared/[orgSlug]/[competitionSlug]/poster.pdf",
  "/shared/[orgSlug]/[competitionSlug]/[divisionSlug]/calendar.ics",
  "/shared/[orgSlug]/[competitionSlug]/[divisionSlug]/fixtures/[fixtureId]/poster.png",
].sort();

const PRESENT = ["/shared/[orgSlug]/[competitionSlug]/present", "/shared/[orgSlug]/[competitionSlug]/[divisionSlug]/present"];

describe("/shared route inventory across the K-1 kiosk move", () => {
  it("serves exactly the page URLs it served before the move", () => {
    const pages = entries().filter((e) => e.kind === "page").map((e) => e.url).sort();
    expect(pages).toEqual(PAGES_BEFORE_K1);
  });

  it("serves exactly the route-handler URLs it served before the move", () => {
    const routes = entries().filter((e) => e.kind === "route").map((e) => e.url).sort();
    expect(routes).toEqual(ROUTES_BEFORE_K1);
  });

  it("no URL is claimed by two files of the same kind (two groups resolving to one path is a Next build error)", () => {
    const seen = new Map<string, string>();
    const dupes: string[] = [];
    for (const e of entries()) {
      const key = `${e.kind} ${e.url}`;
      if (seen.has(key)) dupes.push(`${key}: ${seen.get(key)} and ${e.file}`);
      seen.set(key, e.file);
    }
    expect(dupes).toEqual([]);
  });

  it("both /present pages sit in the (kiosk) group, outside the org chrome layout's directory", () => {
    const present = entries().filter((e) => e.kind === "page" && PRESENT.includes(e.url));
    expect(present.map((e) => e.url).sort()).toEqual([...PRESENT].sort());
    for (const e of present) {
      expect(e.file, `${e.url} is under the kiosk group`).toMatch(/^shared\/\(kiosk\)\/\[orgSlug\]\//);
      expect(e.file.startsWith("shared/[orgSlug]/"), `${e.url} is not under [orgSlug]/layout.tsx`).toBe(false);
    }
  });

  it("every other page stays under the org chrome layout", () => {
    const rest = entries().filter((e) => e.kind === "page" && !PRESENT.includes(e.url));
    expect(rest.length).toBe(PAGES_BEFORE_K1.length - PRESENT.length);
    for (const e of rest) expect(e.file, e.url).toMatch(/^shared\/\[orgSlug\]\//);
  });

  it("each /present page keeps a share image at its own segment (it inherited its parent's before the move)", () => {
    const og = new Set(entries().filter((e) => e.kind === "og").map((e) => e.url));
    for (const url of PRESENT) expect(og.has(url), `${url} has an opengraph-image`).toBe(true);
  });
});
