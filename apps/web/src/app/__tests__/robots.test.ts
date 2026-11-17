// robots.txt (app/robots.ts). Pinned: the private paths every crawler is told to skip, and that every named AI
// crawler — search AND training (owner, 2026-11-17: "Let's AI scrape our site") — is allowed the public site with
// those same paths closed. The lists are read from robots-policy, never retyped here.
import { existsSync } from "node:fs";
import { join } from "node:path";
import type { MetadataRoute } from "next";
import { describe, expect, it } from "vitest";
import robots, * as route from "../robots";
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

  // Owner, 2026-11-17: "Let's AI scrape our site". Training crawlers used to carry one `Disallow: /` each; they are
  // now allowed the public site and, like every other crawler, kept out of the private paths.
  it.each(AI_CRAWLERS.map((bot) => [bot]))("%s is allowed the site but keeps the private paths closed", (bot) => {
    const found = rulesFor(bot);
    expect(found).toHaveLength(1);
    expect(list(found[0]!.allow)).toEqual(["/"]);
    expect(list(found[0]!.disallow)).toEqual(list(star().disallow));
    expect(list(found[0]!.disallow)).not.toContain("/");
  });

  it("no crawler at all is refused the whole site on production", () => {
    const all = rules();
    expect(all.length).toBeGreaterThan(1);
    for (const r of all) expect(list(r.disallow), String(r.userAgent)).not.toContain("/");
  });

  it("every named rule is an AI crawler's or an AI search crawler's, and no crawler is named twice", () => {
    const named = rules().flatMap((r) => list(r.userAgent)).filter((a) => a !== "*");
    expect(named.sort()).toEqual([...AI_CRAWLERS, ...AI_SEARCH_CRAWLERS].sort());
    expect(new Set(named).size).toBe(named.length);
  });

  // Search and link-preview bots carry no rule of their own: they fall under `*`.
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
  ])("%s has no rule of its own, so it falls under `*`", (bot) => {
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

describe("robots.txt: route config", () => {
  it("is dynamic: the staging decision is read per request, not frozen at build", () => {
    expect(route.dynamic).toBe("force-dynamic");
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
      expect(r.sitemap).toBeUndefined();
    } finally {
      if (prev === undefined) delete process.env.OAUTH_BASE_URL;
      else process.env.OAUTH_BASE_URL = prev;
    }
  });
});
