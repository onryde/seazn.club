import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const SRC = join(__dirname, "..", "..");
const read = (p: string) => readFileSync(join(SRC, p), "utf8");

/** Every distribution event must have a producer that is not a test.
 *
 *  EMBED_RENDERED shipped DECLARED and unit-green with no call site anywhere,
 *  which is why item 0's baseline could never have been taken. A membership
 *  assertion on the constants file cannot see that; only the call site can.
 *
 *  POST_AUTO_DRAFTED has TWO producer files, not one: review round 1 finding
 *  1 moved the fixture-decided (scoring hot-path) capture out of org-posts.ts
 *  entirely, into usecases/scoring.ts's `refreshNews` — it has to fire AFTER
 *  the transaction commits, and `refreshNews` (not `insertGeneratedPost`) is
 *  what sits after that commit. org-posts.ts still carries the weekly-digest
 *  producer (`generateWeeklyDigest` / `sweepWeeklyDigests`). Losing either
 *  row would silently drop one of the two real producers. */
describe("distribution events have real producers", () => {
  it.each([
    ["EMBED_RENDERED", "app/embed/divisions/[id]/[widget]/page.tsx"],
    ["PUBLIC_PROFILE_VIEWED", "app/(public)/shared/[orgSlug]/page.tsx"],
    ["POST_AUTO_DRAFTED", "server/usecases/org-posts.ts"],
    ["POST_AUTO_DRAFTED", "server/usecases/scoring.ts"],
  ])("%s is captured in %s", (event, file) => {
    const src = read(file);
    expect(src, `${file} does not import captureServer`).toContain("captureServer");
    expect(src, `${file} never references EVENTS.${event}`).toContain(`EVENTS.${event}`);
  });

  // The negative pair: the auto-draft signal must NOT be the publish signal.
  // Collapsing them is how the current count came to mean "human published an
  // auto-draft" while being read as "an auto-post happened".
  it("keeps the auto-draft signal distinct from the publish signal", () => {
    const src = read("server/usecases/org-posts.ts");
    expect(src).toContain("EVENTS.POST_PUBLISHED");
    expect(src).toContain("EVENTS.POST_AUTO_DRAFTED");
  });
});
