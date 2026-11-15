// robots.txt (app/robots.ts) — bot hardening, 2026-09-25. Three things are
// pinned: the two paths every crawler is now told to skip, one `Disallow: /`
// rule per AI crawler (read from AI_CRAWLERS, never retyped here), and the
// positive pair — search and link-preview bots are NOT refused, so shared
// links keep their previews and public pages stay indexed.
import { existsSync } from "node:fs";
import { join } from "node:path";
import type { MetadataRoute } from "next";
import { describe, expect, it } from "vitest";
import robots from "../robots";
import { AI_CRAWLERS, AI_SEARCH_CRAWLERS } from "@/lib/robots-policy";

type Rule = Extract<MetadataRoute.Robots["rules"], unknown[]>[number];

const list = (v: string | string[] | undefined): string[] => (v === undefined ? [] : Array.isArray(v) ? v : [v]);
const rules = (): Rule[] => {
  const r = robots().rules;
  return Array.isArray(r) ? r : [r as Rule];
};
const rulesFor = (agent: string) => rules().filter((r) => list(r.userAgent).includes(agent));
const star = () => {
  const found = rulesFor("*");
  expect(found, "exactly one `*` rule").toHaveLength(1);
  return found[0]!;
};

/** Google/Bing robots path matching: a prefix match where `*` spans any
 *  characters (slashes included) and a trailing `$` anchors the end. */
function robotsMatches(pattern: string, path: string): boolean {
  const anchored = pattern.endsWith("$");
  const body = (anchored ? pattern.slice(0, -1) : pattern)
    .split("*")
    .map((s) => s.replace(/[.+?^${}()|[\]\\]/g, "\\$&"))
    .join(".*");
  return new RegExp(`^${body}${anchored ? "$" : ""}`).test(path);
}

const PLAYERS = "/live/*/*/players/";

describe("robots.txt: the `*` rule", () => {
  it("tells every crawler to skip the PostHog proxy and public player profiles", () => {
    const disallow = list(star().disallow);
    expect(disallow).toContain("/ingest/");
    expect(disallow).toContain(PLAYERS);
  });

  it("the player pattern matches a real profile URL and nothing above it: the competition page stays crawlable", () => {
    // Premise: the pattern's depth is the route tree's depth.
    const profile = join(process.cwd(), "src/app/(public)/live/[orgSlug]/[competitionSlug]/players/[personId]/page.tsx");
    expect(existsSync(profile), profile).toBe(true);

    expect(robotsMatches(PLAYERS, "/live/acme-club/summer-cup/players/0b5f2c1e-7d1a-4c55-9a51-2f8f1e3c9d10")).toBe(true);
    for (const open of ["/live/acme-club/summer-cup", "/live/acme-club/summer-cup/", "/live/acme-club", "/live/acme-club/summer-cup/register"]) {
      expect(robotsMatches(PLAYERS, open), open).toBe(false);
    }
    expect(robotsMatches("/ingest/", "/ingest/e/?ip=1")).toBe(true);
  });

  it("still allows the site root, and keeps the sitemap", () => {
    expect(list(star().allow)).toContain("/");
    expect(list(star().disallow)).not.toContain("/");
    expect(robots().sitemap).toMatch(/\/sitemap\.xml$/);
  });
});

describe("robots.txt: AI crawlers", () => {
  it("premise: the list is not empty and names no crawler twice", () => {
    expect(AI_CRAWLERS.length).toBeGreaterThan(0);
    expect(new Set(AI_CRAWLERS).size).toBe(AI_CRAWLERS.length);
  });

  it.each(AI_CRAWLERS.map((bot) => [bot]))("%s has one rule of its own, refusing the whole site", (bot) => {
    const found = rulesFor(bot);
    expect(found).toHaveLength(1);
    expect(list(found[0]!.userAgent)).toEqual([bot]);
    expect(list(found[0]!.disallow)).toEqual(["/"]);
    expect(list(found[0]!.allow)).toEqual([]);
  });

  it("every rule other than `*` and the search group is an AI crawler's: nothing else is refused", () => {
    const search = new Set<string>(AI_SEARCH_CRAWLERS);
    const others = rules().flatMap((r) => list(r.userAgent)).filter((a) => a !== "*" && !search.has(a));
    expect(others.sort()).toEqual([...AI_CRAWLERS].sort());
  });

  it("no crawler is both refused and allowed", () => {
    const refused = new Set<string>(AI_CRAWLERS);
    for (const bot of AI_SEARCH_CRAWLERS) expect(refused.has(bot), bot).toBe(false);
  });

  // The positive pair: these must reach the `*` rule, not a refusal.
  it.each([
    "Googlebot",
    "Bingbot",
    "facebookexternalhit",
    "WhatsApp",
    "Twitterbot",
    "Slackbot",
    "TelegramBot",
    "Discordbot",
    "LinkedInBot",
  ])("%s is not refused: no rule of its own, so it falls under `*`", (bot) => {
    expect(AI_CRAWLERS.map((a) => a.toLowerCase())).not.toContain(bot.toLowerCase());
    expect(rulesFor(bot)).toEqual([]);
  });
});

describe("robots.txt: AI search crawlers", () => {
  it("premise: the list is not empty and includes PerplexityBot", () => {
    expect(AI_SEARCH_CRAWLERS.length).toBeGreaterThan(0);
    expect(AI_SEARCH_CRAWLERS).toContain("PerplexityBot");
  });

  it.each(AI_SEARCH_CRAWLERS.map((bot) => [bot]))("%s is allowed the site but keeps the private paths closed", (bot) => {
    const found = rulesFor(bot);
    expect(found).toHaveLength(1);
    expect(list(found[0]!.allow)).toEqual(["/"]);
    expect(list(found[0]!.disallow)).toEqual(list(star().disallow));
    expect(list(found[0]!.disallow)).not.toContain("/");
  });
});

describe("robots.txt: staging origin", () => {
  it("an unrecognised origin is NOT closed: a wrong prod env fails open, never de-indexes the live site", () => {
    const prev = process.env.OAUTH_BASE_URL;
    process.env.OAUTH_BASE_URL = "https://www.seazn.club";
    try {
      expect(robots().rules).not.toEqual([{ userAgent: "*", disallow: "/" }]);
    } finally {
      if (prev === undefined) delete process.env.OAUTH_BASE_URL;
      else process.env.OAUTH_BASE_URL = prev;
    }
  });

  it("closes the whole site to everyone and lists no sitemap", async () => {
    const prev = process.env.OAUTH_BASE_URL;
    process.env.OAUTH_BASE_URL = "https://stg.seazn.club";
    try {
      const r = robots();
      expect(r.rules).toEqual([{ userAgent: "*", disallow: "/" }]);
    } finally {
      if (prev === undefined) delete process.env.OAUTH_BASE_URL;
      else process.env.OAUTH_BASE_URL = prev;
    }
  });
});
