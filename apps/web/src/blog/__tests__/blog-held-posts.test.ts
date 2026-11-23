// Posts #22 (how-americano-works) and #23 (how-mexicano-works) are HELD: written, reviewed and fixed, but not published,
// because the product cannot yet finish an evening of either format (owner ruling 2026-11-23; findings D1 and D2 in the
// batch 5 review). Their final text and examples live in
//   .superpowers/sdd/2026-11-19-blog-p2/held-22-how-americano-works.md and held-23-how-mexicano-works.md
// beside the SDD ledger, with the commit that holds the files and the steps that put them back.
//
// These are TRIPWIRES. Each one passes while the defect stands and FAILS the day it is fixed, so a fix cannot ship without
// someone being told that a held post is now ready to release. A tripwire is not a pin on the defect for its own sake: when
// it goes red, release the posts (see the held notes), then delete this file's matching test.
//
//   D1: score entry in americano. The division page's score boxes (`americano-panel.tsx` scoreMatch) post the event
//       `generic.result`; only the catch-all sport declares it, so in every other sport the boxes are refused. It stands
//       while (a) the panel still posts `generic.result` AND (b) no offered sport other than the catch-all declares it.
//       A fix that changes (a) or (b) turns the test red. The expected set is read from the sport registry's own
//       declarations (`eventSchemas`) and the builder's own offer (`templatesForSport`), never typed here.
//   D2: mexicano round two. Once round one is scored, the stage's buttons offer only "Complete" (`stageActions`), with no
//       way to draw the next round. A fix that adds one for this input turns the test red. Weaker than D1: a fix that
//       adds a NEW input to `stageActions` and leaves today's answer unchanged would not trip it, which the held note says.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { effectiveEntrantModel } from "@seazn/engine/sport";
import { builtinModules } from "@seazn/engine/sports";
import { describe, expect, it } from "vitest";
import { templatesForSport } from "@/lib/format-templates";
import { stageActions } from "@/lib/stage-card/summaries";
import { BLOG_PLANNED_SLUGS, allBlogPosts } from "@/server/blog-content";

const HELD = ["how-americano-works", "how-mexicano-works"] as const;
const PANEL = join(__dirname, "..", "..", "components", "v2", "americano-panel.tsx");

/** The sports the builder offers americano to, by the product's own offer. */
function offeredAmericano(): string[] {
  return builtinModules
    .filter((m) => templatesForSport(m.key, effectiveEntrantModel(m.entrantModel, null).kinds).some((t) => t.key === "americano"))
    .map((m) => m.key);
}

describe("held posts #22 and #23: tripwires that go red when the product defect they wait on is fixed", () => {
  it("D1: americano score entry still posts generic.result, which only the catch-all sport declares", () => {
    const offered = offeredAmericano();
    expect(offered, "anti-vacuity: americano is offered in the catch-all sport").toContain("generic");
    const others = offered.filter((k) => k !== "generic");
    expect(others.length, "anti-vacuity: americano is offered in sports other than the catch-all").toBeGreaterThan(0);
    const declares = (key: string) => "generic.result" in builtinModules.find((m) => m.key === key)!.eventSchemas;
    expect(declares("generic"), "the catch-all sport declares the event the boxes post").toBe(true);
    const source = readFileSync(PANEL, "utf8");
    const posts = (source.match(/type:\s*"generic\.result"/g) ?? []).length;
    const fixed = posts === 0 || others.some(declares);
    expect(fixed, "W7 fixed americano score entry: release held posts #22/#23").toBe(false);
    expect(posts, "the panel posts generic.result once").toBe(1);
  });

  it("D2: once round one is scored, the stage offers only Complete and no way to draw round two", () => {
    const afterRoundOne = stageActions({
      status: "active", played: 2, inPlay: 0, unplayed: 0, hasFixtures: true, adhoc: false, pairNext: false, canUnpair: false, updateDraw: false,
    });
    expect(afterRoundOne.primary?.action !== "complete" || afterRoundOne.secondary.length > 0, "W7 fixed mexicano round two: release held post #23").toBe(false);
    expect(afterRoundOne, "anti-vacuity: today's answer is the lone Complete").toEqual({ primary: { action: "complete", enabled: true }, secondary: [] });
  });

  it("the two held slugs are planned (so related: links to them resolve) and are not published posts", () => {
    const written = new Set(allBlogPosts().map((p) => p.slug));
    let checked = 0;
    for (const slug of HELD) {
      expect(BLOG_PLANNED_SLUGS.has(slug), `${slug} is on the planned list`).toBe(true);
      expect(written.has(slug), `${slug} is held, not published`).toBe(false);
      checked++;
    }
    expect(checked).toBe(2);
  });
});
