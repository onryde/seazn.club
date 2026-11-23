// W5 follow-ups B3: the public division page is ISR and renders only its active tab, so `?tab=standings` / `?tab=entrants`
// on a division home are rewritten by the proxy to the tab's own document (`{division}/tab/{tab}`); the URL a spectator
// sees and shares is unchanged. Nothing else may be rewritten: no `tab`, Schedule, an unknown tab, the hub's own `?tab=`,
// and every static route that sits where a division (or a competition) slug would. That last set is SWEPT from the route
// tree itself, so a new static route under `/live` cannot be silently rewritten into a 404.
import { describe, expect, it } from "vitest";
import { readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { NextRequest } from "next/server";
import { divisionTabCanonicalRedirect, divisionTabRewrite, proxy } from "@/proxy";

const req = (pathAndQuery: string) => new NextRequest(`http://localhost:3000${pathAndQuery}`);

describe("B3 divisionTabRewrite", () => {
  it("?tab=standings and ?tab=entrants on a division home go to that tab's document, keeping the query", () => {
    let checked = 0;
    for (const tab of ["standings", "entrants"]) {
      for (const path of ["/live/riverside/autumn-cup/open", "/live/riverside/autumn-cup/open/"]) {
        const url = divisionTabRewrite(req(`${path}?tab=${tab}&ref=share`));
        expect(url?.pathname, `${path} ${tab}`).toBe(`/live/riverside/autumn-cup/open/tab/${tab}`);
        expect(url?.searchParams.get("ref")).toBe("share");
        checked += 1;
      }
    }
    expect(checked).toBe(4);
  });

  it("no rewrite: no tab, Schedule, an unknown or differently cased tab, the hub's own tabs, deeper and shallower paths", () => {
    const untouched = [
      "/live/riverside/autumn-cup/open",
      "/live/riverside/autumn-cup/open?tab=schedule",
      "/live/riverside/autumn-cup/open?tab=Standings",
      "/live/riverside/autumn-cup/open?tab=fixtures",
      "/live/riverside/autumn-cup?tab=standings",
      "/live/riverside/autumn-cup?tab=table",
      "/live/riverside/autumn-cup/open/fixtures/f1?tab=standings",
      "/live/riverside/autumn-cup/open/tab/standings?tab=standings",
      "/o/riverside/competitions/autumn-cup/open?tab=standings",
    ];
    for (const path of untouched) expect(divisionTabRewrite(req(path)), path).toBeNull();
    expect(untouched.length).toBe(9);
  });

  it("the route tree sweep: every static route at a division's (or competition's) depth under /live is never rewritten", () => {
    const LIVE = join(process.cwd(), "src/app/(public)/live");
    const routes: string[] = [];
    const walk = (dir: string, segments: string[]) => {
      for (const name of readdirSync(dir)) {
        const full = join(dir, name);
        if (!statSync(full).isDirectory()) {
          if (/^(page\.tsx|route\.ts)$/.test(name)) routes.push("/live/" + segments.join("/"));
          continue;
        }
        if (name === "__tests__") continue;
        if (/^\(.*\)$/.test(name)) walk(full, segments); // a route group adds no segment
        else walk(full, [...segments, name.replace(/^\[(.+)\]$/, "x-$1")]);
      }
    };
    walk(LIVE, []);
    const atDivisionDepth = routes.filter((r) => r.split("/").length === 5);
    let swept = 0;
    for (const route of atDivisionDepth) {
      const rewritten = divisionTabRewrite(req(`${route}?tab=standings`));
      if (route === "/live/x-orgSlug/x-competitionSlug/x-divisionSlug") expect(rewritten?.pathname).toBe(`${route}/tab/standings`);
      else expect(rewritten, `${route} is a static route, not a division`).toBeNull();
      swept += 1;
    }
    // Premise and anti-vacuity: the division page itself, and at least the static siblings this file was written against
    // (present, poster, poster.pdf, register, players' parent, news), are in the sweep.
    expect(atDivisionDepth).toContain("/live/x-orgSlug/x-competitionSlug/x-divisionSlug");
    expect(atDivisionDepth).toEqual(expect.arrayContaining(["/live/x-orgSlug/x-competitionSlug/present", "/live/x-orgSlug/x-competitionSlug/poster", "/live/x-orgSlug/news/x-postSlug"]));
    expect(swept).toBeGreaterThanOrEqual(6);
  });

  it("wired: the proxy itself answers a division's ?tab=standings with that rewrite, and the bare route with none", () => {
    const rewritten = proxy(req("/live/riverside/autumn-cup/open?tab=standings"));
    expect(rewritten.headers.get("x-middleware-rewrite")).toContain("/live/riverside/autumn-cup/open/tab/standings");
    const bare = proxy(req("/live/riverside/autumn-cup/open"));
    expect(bare.headers.get("x-middleware-rewrite")).toBeNull();
  });
});

// Review M2: the rewrite's target, `{division}/tab/{tab}`, is a real route, and a request for it by that path was served as a
// second public address of the same document (a crawler could index both). The proxy runs on the request a browser or crawler
// sends, never again on its own rewrite, so a request that NAMES the internal path is answered with a permanent redirect to the
// address the hub links to.
describe("M2 divisionTabCanonicalRedirect", () => {
  it("a direct request for a routed tab's internal path goes (308) to the division's ?tab= address, keeping the query", () => {
    let checked = 0;
    for (const tab of ["standings", "entrants"]) {
      for (const path of [`/live/riverside/autumn-cup/open/tab/${tab}`, `/live/riverside/autumn-cup/open/tab/${tab}/`]) {
        const url = divisionTabCanonicalRedirect(req(`${path}?ref=share`));
        expect(url?.pathname, path).toBe("/live/riverside/autumn-cup/open");
        expect(url?.searchParams.get("tab"), path).toBe(tab);
        expect(url?.searchParams.get("ref")).toBe("share");
        checked += 1;
      }
    }
    expect(checked, "anti-vacuity").toBe(4);
  });

  it("no redirect: the ?tab= address itself, an unknown tab, a static route or org tree in a division's place, a deeper path", () => {
    const untouched = [
      "/live/riverside/autumn-cup/open",
      "/live/riverside/autumn-cup/open?tab=standings",
      "/live/riverside/autumn-cup/open/tab/schedule",
      "/live/riverside/autumn-cup/open/tab/fixtures",
      "/live/riverside/autumn-cup/present/tab/standings",
      "/live/riverside/news/a-post/tab/standings",
      "/live/riverside/autumn-cup/open/tab/standings/more",
    ];
    for (const path of untouched) expect(divisionTabCanonicalRedirect(req(path)), path).toBeNull();
    expect(untouched.length).toBe(7);
  });

  it("wired: the proxy answers the internal path with a 308 to the ?tab= address, and the ?tab= address with the rewrite (never a redirect loop)", () => {
    // Premise: the internal route exists in the tree (the thing a direct request would otherwise reach).
    expect(statSync(join(process.cwd(), "src/app/(public)/live/[orgSlug]/[competitionSlug]/[divisionSlug]/tab/[tab]/page.tsx")).isFile()).toBe(true);
    const direct = proxy(req("/live/riverside/autumn-cup/open/tab/entrants"));
    expect(direct.status).toBe(308);
    expect(direct.headers.get("location")).toBe("http://localhost:3000/live/riverside/autumn-cup/open?tab=entrants");
    const viaTab = proxy(req("/live/riverside/autumn-cup/open?tab=entrants"));
    expect(viaTab.status).not.toBe(308);
    expect(viaTab.headers.get("x-middleware-rewrite")).toContain("/live/riverside/autumn-cup/open/tab/entrants");
  });
});
