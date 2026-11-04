// LIVE1 (owner ruling 2026-11-03): every old `/shared/…` URL answers a PERMANENT 308 to the same path under `/live/…`,
// query string kept, forever — a printed poster's QR code, an email already sent and a search result must all land.
//
// This resolves next.config's redirects the way Next's server does (router-utils/resolve-routes): each rule is matched
// with Next's OWN route builder (router-utils/filesystem buildCustomRoute), the destination is compiled with Next's own
// prepareDestination (appendParamsToQuery false, the request's query passed through), and the status is Next's own
// getRedirectStatus. The served half — a real 308 off a prod server, `Location` and all, and the browser landing on
// the spectator page — is e2e/walkthrough/live-public-path.spec.ts's.
//
// Every expected destination below is TYPED from the ruling ("/shared/<x>" → "/live/<x>"), never built with
// routes.* or read from next.config, so a change to either cannot move the expectation with it.
import { describe, expect, it } from "vitest";
import { buildCustomRoute } from "next/dist/server/lib/router-utils/filesystem";
import { prepareDestination } from "next/dist/shared/lib/router/utils/prepare-destination";
import { getRedirectStatus } from "next/dist/lib/redirect-status";
import { nextConfig } from "../../../next.config.js";

type RedirectRule = { source: string; destination: string; permanent?: boolean; statusCode?: number };

async function redirectRules(): Promise<RedirectRule[]> {
  const fn = (nextConfig as { redirects?: () => Promise<RedirectRule[]> }).redirects;
  return fn ? await fn() : [];
}

/** Where `url` (path + query) is sent, and with what status — or null when no redirect matches. */
async function redirectOf(url: string): Promise<{ status: number; location: string } | null> {
  const parsed = new URL(url, "http://localhost");
  const query: Record<string, string | string[]> = {};
  for (const key of new Set(parsed.searchParams.keys())) {
    const all = parsed.searchParams.getAll(key);
    query[key] = all.length > 1 ? all : all[0]!;
  }
  for (const rule of await redirectRules()) {
    const params = buildCustomRoute("redirect", rule).match(parsed.pathname);
    if (params === false) continue;
    const { parsedDestination } = prepareDestination({
      appendParamsToQuery: false,
      destination: rule.destination,
      params,
      query,
    } as Parameters<typeof prepareDestination>[0]);
    const search = new URLSearchParams();
    for (const [k, v] of Object.entries(parsedDestination.query)) {
      for (const one of Array.isArray(v) ? v : [v]) search.append(k, String(one));
    }
    const qs = search.toString();
    return { status: getRedirectStatus(rule as Parameters<typeof getRedirectStatus>[0]), location: `${parsedDestination.pathname}${qs ? `?${qs}` : ""}` };
  }
  return null;
}

const FX = "0b9a4c1e-5d2f-4c1a-9e1e-1f2a3b4c5d6e";

// Every shape the old tree served (app/(public)/live — moved from /shared — and its (kiosk) group), old → new.
const OLD_TO_NEW: [old: string, expected: string][] = [
  ["/shared/riverside", "/live/riverside"],
  ["/shared/riverside/summer-cup", "/live/riverside/summer-cup"],
  ["/shared/riverside/summer-cup?tab=matches&division=open", "/live/riverside/summer-cup?tab=matches&division=open"],
  ["/shared/riverside/summer-cup/open", "/live/riverside/summer-cup/open"],
  ["/shared/riverside/summer-cup/open?tab=standings", "/live/riverside/summer-cup/open?tab=standings"],
  [`/shared/riverside/summer-cup/open/fixtures/${FX}`, `/live/riverside/summer-cup/open/fixtures/${FX}`],
  [`/shared/riverside/summer-cup/open/fixtures/${FX}/play?t=eyJ.a-b_c`, `/live/riverside/summer-cup/open/fixtures/${FX}/play?t=eyJ.a-b_c`],
  [`/shared/riverside/summer-cup/open/fixtures/${FX}/poster.png`, `/live/riverside/summer-cup/open/fixtures/${FX}/poster.png`],
  ["/shared/riverside/summer-cup/poster", "/live/riverside/summer-cup/poster"],
  ["/shared/riverside/summer-cup/poster.pdf?division=open", "/live/riverside/summer-cup/poster.pdf?division=open"],
  ["/shared/riverside/summer-cup/present", "/live/riverside/summer-cup/present"],
  ["/shared/riverside/summer-cup/open/present", "/live/riverside/summer-cup/open/present"],
  ["/shared/riverside/summer-cup/register?join=AB12", "/live/riverside/summer-cup/register?join=AB12"],
  ["/shared/riverside/summer-cup/register/status?rid=g1&token=t%2Bk%3D", "/live/riverside/summer-cup/register/status?rid=g1&token=t%2Bk%3D"],
  ["/shared/riverside/summer-cup/register/join?join_code=XY9&player_id=p1", "/live/riverside/summer-cup/register/join?join_code=XY9&player_id=p1"],
  ["/shared/riverside/summer-cup/players/p-1", "/live/riverside/summer-cup/players/p-1"],
  ["/shared/riverside/summer-cup/open/calendar.ics?entrant=e1", "/live/riverside/summer-cup/open/calendar.ics?entrant=e1"],
  ["/shared/riverside/news", "/live/riverside/news"],
  ["/shared/riverside/news?page=2", "/live/riverside/news?page=2"],
  ["/shared/riverside/news/opening-day", "/live/riverside/news/opening-day"],
  ["/shared/riverside/news/opening-day/story.png", "/live/riverside/news/opening-day/story.png"],
  ["/shared/riverside/summer-cup/opengraph-image", "/live/riverside/summer-cup/opengraph-image"],
  // A repeated key keeps every value, in order.
  ["/shared/riverside/summer-cup?x=1&x=2", "/live/riverside/summer-cup?x=1&x=2"],
  // The bare old root lands on the bare new one — the marketing wall (option A).
  ["/shared", "/live"],
];

describe("LIVE1: /shared/:path* → /live/:path*, permanent (308), query kept", () => {
  it("every old shape — hub, division, fixture, match room, posters, kiosk, register, news, players, calendar — 308s to the same path under /live with its query, counted", async () => {
    let checked = 0;
    for (const [old, expected] of OLD_TO_NEW) {
      const r = await redirectOf(old);
      expect(r, `${old}: a redirect matches`).not.toBeNull();
      expect(r!.status, `${old}: permanent`).toBe(308);
      expect(r!.location, old).toBe(expected);
      checked += 1;
    }
    expect(checked, "anti-vacuity: old URLs").toBe(OLD_TO_NEW.length);
    expect(checked).toBeGreaterThan(20);
  });

  it("nothing else is redirected: the new tree, the marketing wall in every locale, look-alikes, and the app — counted", async () => {
    const untouched = [
      "/live",
      "/en/live",
      "/fr/live",
      "/live/riverside/summer-cup",
      `/live/riverside/summer-cup/open/fixtures/${FX}/play`,
      "/sharedx/riverside",
      "/shared-club/riverside",
      "/o/riverside/shared",
      "/o/riverside/c/summer-cup",
      "/embed/divisions/x/standings",
      "/api/v1/public/orgs/riverside",
      "/",
    ];
    let checked = 0;
    for (const path of untouched) {
      expect(await redirectOf(path), path).toBeNull();
      checked += 1;
    }
    expect(checked, "anti-vacuity: untouched paths").toBe(untouched.length);
  });

  it("there is exactly one redirect rule, and it is the permanent one (no 307 shadowing it)", async () => {
    const rules = await redirectRules();
    expect(rules.length).toBe(1);
    expect(rules[0]!.permanent).toBe(true);
    expect(rules[0]!.statusCode).toBeUndefined();
  });
});
