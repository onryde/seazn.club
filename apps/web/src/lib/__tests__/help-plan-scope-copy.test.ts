// Truth-in-copy guard for three help pages whose PLAN or LIMIT SCOPE read ambiguously (docs-follow-product, from the
// what-if chat's gate round, 2026-11-23; the chat answered from these pages and one answer was WRONG because of the first).
//
//   directory/clubs-and-teams.md  "Your plan sets how many clubs and teams you can have" never said these are the
//     rows of the DIRECTORY, not the sides a division holds. `teams.max` counts the `teams` table (usecases/teams.ts);
//     a division's own size is `entrants.per_division.max` (usecases/entrants.ts). A reader took the Community figure for
//     the teams a league can have.
//   players/player-stats-and-photo.md  said "Both sections are there on every plan" while billing/plans.md and the
//     Event Pass page list "career stats" among what Pro or a pass adds. Both are true of DIFFERENT things: the player's
//     own Career card (me.ts, no gate) and the organisation's cross-competition rollup (`stats.player.career`).
//   sharing/embeds.md  named the plan once, in a long opening paragraph, and not where the steps are, and said "the Event
//     Pass" without saying a pass covers ONE competition (`embeds.enabled` is resolved per competition).
//
// SHAPE. A plan gate is a boolean cell, and `{{plan:…}}` renders integers only (server/help-tokens.ts: a boolean cell
// THROWS), so these gates are named by plan and pinned to `plan_entitlements` by the DB half below — the same pattern as
// the `officials.auto` test in help-copy-truth.test.ts. The integer figure on the directory page IS a token. Source pins
// read the enforcement site, each with a known-positive beside its negative so a rename cannot make one vacuous.
//
// LOCATION IS LOAD-BEARING: `src/lib/__tests__/` runs in the unit job and in smoke-db (.github/workflows/ci.yml). The DB
// half reports pending without DATABASE_URL, which is correct and is not a pass.
import { afterAll, describe, expect, it } from "vitest";
import { sql } from "@/lib/db";
import { ALL_PLAN_KEYS, PASS_KEYS } from "@/lib/currency";
import { markdownSection, plainProse, sentences, stripFrontmatter } from "@/lib/copy-truth";
import { featureReason } from "@/lib/feature-copy";
import { PASS_FEATURES } from "@/lib/pass-features";
import { planLabel } from "@/lib/plan-label";
import { loadPricingMatrix } from "@/lib/pricing-matrix-server";
import { resolveHelpTokens } from "@/server/help-tokens";
import { helpArticleBySlug, webSource } from "./_help-copy";

const HAS_DB = !!process.env.DATABASE_URL;

afterAll(async () => {
  if (!HAS_DB) return;
  const globalForDb = globalThis as { _sql?: { end(): Promise<void> } };
  const client = globalForDb._sql;
  globalForDb._sql = undefined;
  await client?.end();
});

/** The prose a reader reads, one sentence each: markdown emphasis and links reduced to their words. */
const sentencesOf = (text: string): string[] =>
  plainProse(text)
    .split(/\n+/)
    .flatMap((line) => sentences(line))
    .map((s) => s.trim())
    .filter((s) => s.length > 0);

/** The body of one exported function, up to the next top-level `export`. Null when the function is gone. */
function functionBody(source: string, name: string): string | null {
  const at = source.search(new RegExp(String.raw`export async function ${name}\b`));
  if (at === -1) return null;
  const rest = source.slice(at + 1);
  const next = rest.search(/\nexport /);
  return next === -1 ? rest : rest.slice(0, next);
}

/** A plan's display name as the page prints it: both Event Pass rungs are "the Event Pass" to a reader. */
const printedAs = (planKey: string): string =>
  (PASS_KEYS as readonly string[]).includes(planKey) ? "Event Pass" : planLabel(planKey);

const boolRows = async (feature: string) =>
  sql<{ plan_key: string; bool_value: boolean | null }[]>`
    select plan_key, bool_value from plan_entitlements where feature_key = ${feature} order by plan_key`;

// =============================================================================
// directory/clubs-and-teams.md
// =============================================================================
describe("directory/clubs-and-teams.md says its limits are the DIRECTORY's, not a division's", () => {
  const SLUG = "directory/clubs-and-teams";
  const page = helpArticleBySlug(SLUG);
  const limits = markdownSection(page, /^##\s+Limits\b/);

  it("finds the Limits section (a renamed heading is a fault, never an empty scan)", () => {
    expect(limits, "clubs-and-teams.md has no '## Limits…' heading").not.toBeNull();
    expect(sentencesOf(limits!).length, "sentences the Limits section scans").toBeGreaterThan(3);
  });

  it("opens the section by scoping the caps to what the Clubs & Teams tab holds", () => {
    const lead = sentencesOf(limits!)[0]!;
    expect(lead, lead).toMatch(/\bdirectory\b/i);
    expect(lead, lead).toMatch(/\bclubs\b/i);
    expect(lead, lead).toMatch(/\bteams\b/i);
    expect(lead, lead).toMatch(/\bsquad\b/i);
  });

  it("says a team here is a row in the directory and NOT a competition entrant", () => {
    const hit = sentencesOf(limits!).find((s) => /\bnot a competition entrant\b/i.test(s));
    expect(hit, "no sentence separates a directory team from an entrant").toBeDefined();
    expect(hit!, hit).toMatch(/\bClubs & Teams\b|\bdirectory\b/);
  });

  it("names the entrants-per-division limit as a SEPARATE cap, quoted through plan tokens", () => {
    const hit = sentencesOf(limits!).find((s) => /\bentrants per division\b/i.test(s));
    expect(hit, "no sentence names the entrants-per-division limit").toBeDefined();
    expect(hit!, hit).toMatch(/\bseparate\b/i);
    // Raw page text, tokens unresolved: a typed figure here would be a plan figure typed into a page.
    for (const plan of ["community", "pro"]) {
      expect(limits!, `${plan} entrants cap must be a token`).toContain(`{{plan:entrants.per_division.max:${plan}}}`);
    }
  });

  it("says enrolling a team adds an entrant to the division and no team to the directory", () => {
    const hit = sentencesOf(limits!).find((s) => /\bEnrolling a team\b/i.test(s));
    expect(hit, "no sentence says what enrolling does to each cap").toBeDefined();
    expect(hit!, hit).toMatch(/\bentrant\b/i);
    expect(hit!, hit).toMatch(/\bno new team\b/i);
  });

  it("never states the team cap unscoped again ('how many clubs and teams you can have')", () => {
    expect(page).not.toMatch(/how many clubs and teams you can have/i);
  });

  // The enforcement sites, read as source. Positive and negative on the same read.
  const teamsSrc = webSource("server/usecases/teams.ts");
  const entrantsSrc = webSource("server/usecases/entrants.ts");

  it("teams.max counts the directory's `teams` table (createTeam), and entrants are not counted against it", () => {
    const create = functionBody(teamsSrc, "createTeam");
    expect(create, "createTeam moved: this pin is blind").not.toBeNull();
    expect(create!, "createTeam no longer counts the teams table").toContain("select count(*)::int as n from teams");
    expect(create!, "createTeam no longer asserts teams.max").toContain('assertWithinLimit(teamCap, "teams.max"');
    const enrol = functionBody(entrantsSrc, "createEntrants");
    expect(enrol, "createEntrants moved: this pin is blind").not.toBeNull();
    expect(enrol!, "an entrant is now counted against teams.max").not.toContain("teams.max");
  });

  it("a division's size is entrants.per_division.max, resolved for the competition (an Event Pass lifts it there)", () => {
    expect(entrantsSrc).toMatch(/getLimit\(\s*auth\.orgId,\s*"entrants\.per_division\.max",\s*ref\?\.competition_id/);
  });

  describe.skipIf(!HAS_DB)("against the live matrix", () => {
    it("the section renders, and quotes the entrants cap the matrix enforces for Community and Pro", async () => {
      const resolved = resolveHelpTokens(helpArticleBySlug(SLUG), await loadPricingMatrix());
      const rows = await sql<{ plan_key: string; int_value: number | null }[]>`
        select plan_key, int_value from plan_entitlements
        where feature_key = 'entrants.per_division.max' and plan_key in ('community', 'pro')`;
      expect(rows.length, "no entrants.per_division.max rows for community/pro: the pin would pass vacuously").toBe(2);
      for (const r of rows) {
        expect(r.int_value, `${r.plan_key} has no integer cap`).not.toBeNull();
        expect(resolved, `the page does not quote ${r.plan_key}'s ${r.int_value}`).toContain(
          `${r.int_value} on ${planLabel(r.plan_key)}`,
        );
      }
    });
  });
});

// =============================================================================
// players/player-stats-and-photo.md
// =============================================================================
describe("players/player-stats-and-photo.md separates the player's own stats from the organisation's career rollup", () => {
  const SLUG = "players/player-stats-and-photo";
  const page = helpArticleBySlug(SLUG);
  const body = stripFrontmatter(page);
  const stats = markdownSection(page, /^##\s+Your stats\b/);

  it("finds the Your stats section", () => {
    expect(stats, "player-stats-and-photo.md has no '## Your stats' heading").not.toBeNull();
    expect(sentencesOf(stats!).length, "sentences the section scans").toBeGreaterThan(5);
  });

  it("says Career and My stats are on every plan BECAUSE no organisation's plan applies to them", () => {
    const hit = sentencesOf(stats!).find((s) => /\bBoth sections are there on every plan\b/.test(s));
    expect(hit, "the every-plan sentence is gone").toBeDefined();
    expect(hit!, hit).toMatch(/\byour own numbers\b/i);
    expect(hit!, hit).toMatch(/\bno organisation's plan applies\b/i);
  });

  it("scopes the plan-gated career claim to the ORGANISATION's rollup, and says it is not the Career card", () => {
    const planned = sentencesOf(body).filter((s) => /\bcareer\b/i.test(s) && /\b(Pro|Event Pass|Community)\b/.test(s));
    expect(planned.length, "no sentence ties career stats to a plan: the page no longer reconciles with plans.md").toBeGreaterThan(0);
    for (const s of planned) expect(s, s).toMatch(/\brollup\b|\borganisation\b/i);
    expect(
      sentencesOf(body).some((s) => /\bCareer\b/.test(s) && /\b(not|different)\b/i.test(s) && /\borganisation/i.test(s)),
      "no sentence says the plan's career stats are not the player's Career card",
    ).toBe(true);
  });

  it("names the plans that carry the rollup, Pro and the Event Pass for the competition, and says Community does not", () => {
    const hit = sentencesOf(body).find((s) => /\bneeds Pro\b/.test(s) && /\bEvent Pass\b/.test(s));
    expect(hit, "no sentence names the plans the rollup needs").toBeDefined();
    expect(hit!, hit).toMatch(/\bcompetition\b/i);
    expect(sentencesOf(body).some((s) => /\bCommunity does not get it\b/.test(s))).toBe(true);
  });

  it("does not claim the organiser's Stats tab needs a plan (it is free: stats.player)", () => {
    // The paragraph, not the sentence: "…lists every player… Members of the organisation see it… on every plan." is one claim.
    const tab = plainProse(stats!).split(/\n\s*\n/).find((p) => /\bStats\b/.test(p) && /\btab\b/i.test(p));
    expect(tab, "the organiser's Stats tab paragraph is gone").toBeDefined();
    expect(tab!, tab).toMatch(/\bevery plan\b/);
  });

  const meSrc = webSource("server/usecases/me.ts");
  const statsSrc = webSource("server/usecases/player-stats.ts");

  it("the player's own Career and My stats readers carry no entitlement gate", () => {
    for (const fn of ["listMyCareerStats", "listMyPlayerStats"]) {
      const body_ = functionBody(meSrc, fn);
      expect(body_, `${fn} moved: this pin is blind`).not.toBeNull();
      expect(body_!.length, `${fn} body scanned as nothing`).toBeGreaterThan(300);
      expect(body_!, `${fn} now calls an entitlement gate`).not.toMatch(/\b(requireFeature|hasFeature|getLimit|withinLimit)\b/);
    }
  });

  it("the organisation's career rollup IS gated, on stats.player.career, and the organiser's stats on stats.player", () => {
    const career = functionBody(statsSrc, "personCareerStats");
    expect(career, "personCareerStats moved: this pin is blind").not.toBeNull();
    expect(career!, "personCareerStats no longer goes through the career gate").toContain("careerReadableDivisions(");
    expect(statsSrc).toMatch(/requireFeature\(orgId, "stats\.player\.career"/);
    const division = functionBody(statsSrc, "divisionPlayerStats");
    expect(division, "divisionPlayerStats moved: this pin is blind").not.toBeNull();
    expect(division!).toMatch(/requireFeature\(auth\.orgId, "stats\.player",/);
    expect(division!, "the organiser's Stats tab is now behind the career key").not.toContain("stats.player.career");
  });

  it("an Event Pass lifts the rollup (it is a pass feature) and the record needs no pass (it is not)", () => {
    expect(PASS_FEATURES.has("stats.player.career")).toBe(true);
    expect(PASS_FEATURES.has("stats.player")).toBe(false);
  });

  describe.skipIf(!HAS_DB)("against the live matrix", () => {
    it("stats.player is on for every plan, which is what 'on every plan' says", async () => {
      const rows = await boolRows("stats.player");
      expect(rows.length, "no stats.player rows: the pin would pass vacuously").toBeGreaterThanOrEqual(ALL_PLAN_KEYS.length);
      expect(rows.filter((r) => r.bool_value !== true).map((r) => r.plan_key)).toEqual([]);
    });

    it("stats.player.career: Pro and both Event Pass rungs, which the page names, carry it, and Community, which it says does not, does not", async () => {
      const rows = await boolRows("stats.player.career");
      expect(rows.length, "no stats.player.career rows: the pin would pass vacuously").toBeGreaterThanOrEqual(ALL_PLAN_KEYS.length);
      const text = plainProse(body);
      const claimed = ["pro", ...PASS_KEYS];
      for (const key of claimed) {
        expect(rows.find((r) => r.plan_key === key)?.bool_value, `${key} does not carry the rollup`).toBe(true);
        expect(text, `the page does not name ${printedAs(key)}`).toContain(printedAs(key));
      }
      expect(rows.find((r) => r.plan_key === "community")?.bool_value, "the page says Community does not get the rollup").toBe(false);
      expect(claimed.length, "plans compared against the page's naming").toBe(3);
    });
  });
});

// =============================================================================
// sharing/embeds.md
// =============================================================================
describe("sharing/embeds.md states the plan an embed needs, where the steps are, and that a pass covers one competition", () => {
  const SLUG = "sharing/embeds";
  const page = helpArticleBySlug(SLUG);
  const [, frontmatter = ""] = page.split(/^---$/m);
  const snippet = markdownSection(page, /^##\s+Get the snippet\b/);
  const plans = markdownSection(page, /^##\s+Plans\b/);

  it("finds the sections it scans", () => {
    expect(snippet, "embeds.md has no '## Get the snippet' heading").not.toBeNull();
    expect(plans, "embeds.md has no '## Plans' heading").not.toBeNull();
    expect(sentencesOf(snippet!).length + sentencesOf(plans!).length, "sentences scanned").toBeGreaterThan(6);
  });

  it("puts the plan in the description (the search snippet) and ahead of the numbered steps", () => {
    expect(frontmatter, "the description does not name the plan").toMatch(/^description:.*\bPro\b.*\bEvent Pass\b/m);
    const beforeSteps = snippet!.split(/^\s*1\.\s/m)[0]!;
    expect(beforeSteps, "no plan statement before step 1").toMatch(/\bPro\b/);
    expect(beforeSteps, "no pass statement before step 1").toMatch(/\bEvent Pass\b/);
    expect(beforeSteps, "no 'this competition' scope before step 1").toMatch(/\bon this competition\b/);
  });

  it("says an Event Pass covers one competition, so another competition's division needs its own pass or Pro", () => {
    const hit = sentencesOf(plans!).find((s) => /\bpass covers one competition\b/i.test(s));
    expect(hit, "no sentence says a pass covers one competition").toBeDefined();
    expect(hit!, hit).toMatch(/\bits own pass or Pro\b/);
  });

  it("quotes the product's own refusal sentence, so a reworded gate moves this page", () => {
    expect(page).toContain(featureReason("embeds.enabled"));
  });

  const gateSrc = webSource("server/embed-data.ts");
  const widgetSrc = webSource("app/embed/divisions/[id]/[widget]/page.tsx");
  const panelSrc = webSource("components/v2/embed-snippet.tsx");

  it("the gate is resolved for the competition, and an Event Pass lifts it", () => {
    expect(gateSrc).toMatch(/hasFeature\(competition\.org_id, "embeds\.enabled", competition\.id\)/);
    expect(PASS_FEATURES.has("embeds.enabled"), "embeds.enabled left the pass-lifted set").toBe(true);
  });

  it("an unentitled panel shows the upgrade gate and no snippet, and the widget address 404s", () => {
    expect(panelSrc).toMatch(/!entitled \?[\s\S]*<UpgradeGate feature="embeds\.enabled"/);
    expect(widgetSrc).toMatch(/if \(!resolved\.ok\) notFound\(\)/);
  });

  describe.skipIf(!HAS_DB)("against the live matrix", () => {
    it("embeds.enabled: the plans the page lists are exactly the plans that carry it, and Community is refused", async () => {
      const rows = await boolRows("embeds.enabled");
      expect(rows.length, "no embeds.enabled rows: the pin would pass vacuously").toBeGreaterThanOrEqual(ALL_PLAN_KEYS.length);
      // The page's own list ("It is on Pro, Enterprise and the Event Pass, and it keeps itself up to date."), as printed.
      const list = /\bIt is on (.+?),? and it keeps/.exec(plainProse(stripFrontmatter(page)))?.[1];
      expect(list, "the 'It is on …' plan list is gone from the opening paragraph").toBeDefined();
      const listed = list!.split(/,\s*|\s+and\s+/).map((n) => n.replace(/^the\s+/i, "").trim()).sort();
      const carrying = [...new Set(rows.filter((r) => r.bool_value === true).map((r) => printedAs(r.plan_key)))].sort();
      expect(carrying.length, "plans that carry embeds (anti-vacuity)").toBeGreaterThanOrEqual(2);
      expect(listed, "the page's plan list disagrees with plan_entitlements").toEqual(carrying);
      const refused = rows.filter((r) => r.bool_value !== true).map((r) => r.plan_key);
      expect(refused, "who is refused: the page says only Community is").toEqual(["community"]);
      const refusal = plainProse(plans!).split(/\n\s*\n/).find((para) => /\bCommunity\b/.test(para) && /\bnot found\b/i.test(para));
      expect(refusal, "the Plans section does not say Community's widget address returns not found").toBeDefined();
    });
  });
});
