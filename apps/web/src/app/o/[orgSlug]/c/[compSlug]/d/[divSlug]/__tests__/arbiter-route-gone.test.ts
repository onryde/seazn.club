// MD-R3 (owner, 2026-11-19: "nobody using match day or arbiter panel today, so don't need redirect or backfill"): the Arbiter page's address
// - `/o/<org>/c/<comp>/d/<div>/arbiter` - simply stops existing. There is NO redirect: a request for it finds no route and Next answers 404.
//
// The pin is the three things that would make the old address answer something: a route segment named `arbiter` under the division, a catch-all
// segment that would swallow it, and a redirect or rewrite for it in next.config.js. Each is read from the tree; the premise (the division's
// route directory is read and has its own page and its other segments) is asserted first, so an unreadable directory cannot pass for "no such route".
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const DIVISION_DIR = resolve(__dirname, "..");
const NEXT_CONFIG = resolve(__dirname, "../../../../../../../../../next.config.js");

describe("the retired /arbiter address (MD-R3: no redirect, the route just stops existing)", () => {
  const entries = readdirSync(DIVISION_DIR);

  it("the division's route directory is the one read (premise: it has its own page and its sibling segments)", () => {
    expect(entries, "page.tsx is the division page").toContain("page.tsx");
    expect(entries, "schedule is a sibling segment that still exists").toContain("schedule");
    expect(entries.length, "anti-vacuity: a directory with entries was read").toBeGreaterThan(3);
  });

  it("has no `arbiter` route segment, and no catch-all segment that would serve the old address", () => {
    expect(entries, "no arbiter segment under the division").not.toContain("arbiter");
    expect(existsSync(resolve(DIVISION_DIR, "arbiter", "page.tsx")), "and no arbiter page file").toBe(false);
    const catchAll = entries.filter((e) => /^\[{1,2}\.\.\./.test(e));
    expect(catchAll, "no catch-all segment (it would answer /arbiter with something other than not-found)").toEqual([]);
  });

  it("next.config.js carries no redirect or rewrite for it", () => {
    expect(existsSync(NEXT_CONFIG), "premise: next.config.js is read from the app root").toBe(true);
    const config = readFileSync(NEXT_CONFIG, "utf8");
    expect(config.length, "anti-vacuity: the config is not empty").toBeGreaterThan(100);
    expect(config, "no mention of the old address at all").not.toMatch(/\/arbiter/);
  });
});
