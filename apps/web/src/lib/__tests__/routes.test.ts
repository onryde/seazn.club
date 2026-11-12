// Route builders (PROMPT-30, v3/01 §2) — the single source of console hrefs.
// ESLint bans string-built console paths; if a URL shape changes, it changes
// here and nowhere else.
import { describe, expect, it } from "vitest";
import { isPublicHubPath, routes } from "@/lib/routes";
import { DEFAULT_LOCALE, LOCALES } from "@/lib/i18n-constants";

describe("routes", () => {
  it("builds the /o hierarchy from slugs", () => {
    expect(routes.orgHome("acme")).toBe("/o/acme");
    expect(routes.orgSettings("acme")).toBe("/o/acme/settings");
    expect(routes.orgSettings("acme", "team")).toBe("/o/acme/settings?tab=team");
    expect(routes.billing("acme")).toBe("/o/acme/settings/billing");
    expect(routes.competitionNew("acme")).toBe("/o/acme/c/new");
    expect(routes.competition("acme", "summer-smash")).toBe("/o/acme/c/summer-smash");
    expect(routes.competitionSettings("acme", "summer-smash")).toBe(
      "/o/acme/c/summer-smash/settings",
    );
    expect(routes.competitionSchedule("acme", "summer-smash")).toBe(
      "/o/acme/c/summer-smash/schedule",
    );
    expect(routes.competitionRegistration("acme", "summer-smash")).toBe(
      "/o/acme/c/summer-smash/registration",
    );
    expect(routes.competitionRegistration("acme", "summer-smash", "registrants")).toBe(
      "/o/acme/c/summer-smash/registration?tab=registrants",
    );
    expect(routes.divisionNew("acme", "summer-smash")).toBe("/o/acme/c/summer-smash/d/new");
    expect(routes.division("acme", "summer-smash", "u16-boys")).toBe(
      "/o/acme/c/summer-smash/d/u16-boys",
    );
    expect(routes.division("acme", "summer-smash", "u16-boys", "fixtures")).toBe(
      "/o/acme/c/summer-smash/d/u16-boys?tab=fixtures",
    );
    expect(routes.divisionSchedule("acme", "summer-smash", "u16-boys")).toBe(
      "/o/acme/c/summer-smash/d/u16-boys/schedule",
    );
    expect(routes.fixture("acme", "summer-smash", "u16-boys", 14)).toBe(
      "/o/acme/c/summer-smash/d/u16-boys/f/14",
    );
  });

  it("keeps id-based slideshow and slug-based public builders", () => {
    expect(routes.slideshowCompetition("abc-123")).toBe("/slideshow/competitions/abc-123");
    expect(routes.slideshowDivision("def-456")).toBe("/slideshow/divisions/def-456");
    expect(routes.publicHub("acme")).toBe("/live/acme");
    expect(routes.publicHub("acme", "summer-smash", "u16-boys")).toBe(
      "/live/acme/summer-smash/u16-boys",
    );
  });

  // LIVE1 (owner ruling 2026-11-03): every spectator URL is one of these, under /live. Each expected value is TYPED from
  // the route tree's folders (app/(public)/live/…), never derived from the builder.
  it("builds every public spectator shape under /live — counted", () => {
    const fx = "0b9a4c1e-5d2f-4c1a-9e1e-1f2a3b4c5d6e";
    const cases: [string, string][] = [
      [routes.publicHub("acme", "summer-smash"), "/live/acme/summer-smash"],
      [routes.publicNews("acme"), "/live/acme/news"],
      [routes.publicNewsPost("acme", "opening-day"), "/live/acme/news/opening-day"],
      [routes.publicNewsStory("acme", "opening-day"), "/live/acme/news/opening-day/story.png"],
      [routes.publicRegisterStatus("acme", "summer-smash"), "/live/acme/summer-smash/register/status"],
      [routes.publicRegisterJoin("acme", "summer-smash"), "/live/acme/summer-smash/register/join"],
      [routes.publicPlayer("acme", "summer-smash", "p-1"), "/live/acme/summer-smash/players/p-1"],
      [routes.publicPresent("acme", "summer-smash"), "/live/acme/summer-smash/present"],
      [routes.publicPresent("acme", "summer-smash", "u16-boys"), "/live/acme/summer-smash/u16-boys/present"],
      [routes.publicPosterPdf("acme", "summer-smash"), "/live/acme/summer-smash/poster.pdf"],
      [routes.publicCalendar("acme", "summer-smash", "u16-boys"), "/live/acme/summer-smash/u16-boys/calendar.ics"],
      [routes.publicFixture("acme", "summer-smash", "u16-boys", fx), `/live/acme/summer-smash/u16-boys/fixtures/${fx}`],
      [routes.publicFixturePlay("acme", "summer-smash", "u16-boys", fx), `/live/acme/summer-smash/u16-boys/fixtures/${fx}/play`],
      [routes.publicFixturePlay("acme", "summer-smash", "u16-boys", fx, "a+b/c"), `/live/acme/summer-smash/u16-boys/fixtures/${fx}/play?t=a%2Bb%2Fc`],
      // robots.ts's player-profile disallow is built from the same builder.
      [routes.publicPlayer("*", "*", ""), "/live/*/*/players/"],
    ];
    let checked = 0;
    for (const [built, expected] of cases) {
      expect(built).toBe(expected);
      checked += 1;
    }
    expect(checked, "anti-vacuity: shapes").toBe(cases.length);
  });

  it("isPublicHubPath: /live/<x> is the spectator tree; a bare /live (the marketing wall, option A), /live/, /livex and the old /shared are not", () => {
    const cases: [string, boolean][] = [
      ["/live/acme", true],
      ["/live/acme/summer-smash/u16-boys/present", true],
      ["/live", false],
      ["/live/", false],
      ["/livex/acme", false],
      ["/shared/acme", false],
      ["/en/live", false],
      ["/", false],
      ["", false],
    ];
    for (const [path, expected] of cases) expect(isPublicHubPath(path), path).toBe(expected);
    expect(cases.length).toBe(9);
  });

  it("publicHub refuses an empty org slug — it would build the marketing /live (a 200), not a hub page — and builds a real one", () => {
    expect(() => routes.publicHub("")).toThrow(/empty org slug/);
    expect(() => routes.publicHub("", "summer-smash", "u16-boys")).toThrow(/empty org slug/);
    // The positive pair: a real org slug still builds the hub, with or without the rest.
    expect(routes.publicHub("acme")).toBe("/live/acme");
    expect(routes.publicHub("acme", "summer-smash", "u16-boys")).toBe("/live/acme/summer-smash/u16-boys");
  });

  it("builds the public register page — the registration hub's per-row copy link target", () => {
    expect(routes.publicRegister("acme", "summer-smash")).toBe(
      "/live/acme/summer-smash/register",
    );
  });

  // RS005 R2: the division page's own link into the hub, division
  // pre-filtered (`&division_id=<uuid>`) — the param
  // registration-list-query.ts's parseRegistrationListQuery and the hub's
  // own data.ts (parseRegistrantsQuery) both read.
  it("composes tab and divisionId independently, keeping every existing call site's output unchanged", () => {
    const uuid = "11111111-2222-3333-4444-555555555555";
    expect(routes.competitionRegistration("acme", "summer-smash", "registrants", uuid)).toBe(
      `/o/acme/c/summer-smash/registration?tab=registrants&division_id=${uuid}`,
    );
    // divisionId with no tab — still composes, `tab` just absent.
    expect(routes.competitionRegistration("acme", "summer-smash", undefined, uuid)).toBe(
      `/o/acme/c/summer-smash/registration?division_id=${uuid}`,
    );
    // No divisionId (the pre-existing 5 call sites: competition page,
    // hub's own filtersAction/clearHref/emptyCtaHref/tab-strip,
    // breadcrumb-chain.ts) — unchanged from before this route grew a 4th
    // param.
    expect(routes.competitionRegistration("acme", "summer-smash")).toBe(
      "/o/acme/c/summer-smash/registration",
    );
    expect(routes.competitionRegistration("acme", "summer-smash", "settings")).toBe(
      "/o/acme/c/summer-smash/registration?tab=settings",
    );
  });

  it("builds the quick match setup screen under each shipped locale, and never a root path from anything else (counted)", () => {
    // The locale set is the app's own (i18n-constants), the path the spec's: `/<lang>/play` (quick match plan 2, Task 4).
    let checked = 0;
    for (const locale of LOCALES) {
      expect(routes.quickMatchSetup(locale)).toBe(`/${locale}/play`);
      checked++;
    }
    expect(checked, "anti-vacuity").toBe(LOCALES.length);
    // A value that names no shipped locale is the default's page: never `/join/play`, a secret route's root.
    for (const bad of ["join", "xx", "", "../q"]) expect(routes.quickMatchSetup(bad), JSON.stringify(bad)).toBe(`/${DEFAULT_LOCALE}/play`);
  });

  it("builds a quick match home's Score post: the home token and the match, both in the path", () => {
    expect(routes.quickMatchScore("qm_abc", "11111111-2222-3333-4444-555555555555")).toBe(
      "/q/qm_abc/score/11111111-2222-3333-4444-555555555555",
    );
    // The same home the token's own builder names, so the two never drift apart.
    expect(routes.quickMatchScore("qm_abc", "f")).toBe(`${routes.quickMatch("qm_abc")}/score/f`);
  });

  it("builds a quick match home's 'Add a match' post: the home token in the path, under the home (plan 2 Task 8)", () => {
    expect(routes.quickMatchAddMatch("qm_abc")).toBe("/q/qm_abc/add-match");
    // The same home the token's own builder names, so the two never drift apart.
    expect(routes.quickMatchAddMatch("qm_abc")).toBe(`${routes.quickMatch("qm_abc")}/add-match`);
  });

  it("builds a quick match's Save post: the home token in the path, under the save page (plan 3 Task 5)", () => {
    expect(routes.quickMatchSaveConfirm("qm_abc")).toBe("/q/qm_abc/save/confirm");
    // The same save page the reminder links to, so the two never drift apart.
    expect(routes.quickMatchSaveConfirm("qm_abc")).toBe(`${routes.quickMatchSave("qm_abc")}/confirm`);
  });
});

describe("routes.orgSponsors (R4 S11: the Sponsors hub is top-level, not a Settings tab)", () => {
  it("builds /o/<slug>/sponsors, with an optional ?tab=", () => {
    expect(routes.orgSponsors("acme")).toBe("/o/acme/sponsors");
    expect(routes.orgSponsors("acme", "on_stream")).toBe("/o/acme/sponsors?tab=on_stream");
  });
});
