// Route builders (PROMPT-30, v3/01 §2) — the single source of console hrefs.
// ESLint bans string-built console paths; if a URL shape changes, it changes
// here and nowhere else.
import { describe, expect, it } from "vitest";
import { routes } from "@/lib/routes";

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
    expect(routes.shared("acme")).toBe("/shared/acme");
    expect(routes.shared("acme", "summer-smash", "u16-boys")).toBe(
      "/shared/acme/summer-smash/u16-boys",
    );
  });

  it("builds the public register page — the registration hub's per-row copy link target", () => {
    expect(routes.publicRegister("acme", "summer-smash")).toBe(
      "/shared/acme/summer-smash/register",
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
});
