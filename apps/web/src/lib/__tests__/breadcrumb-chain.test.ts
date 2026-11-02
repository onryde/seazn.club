// Breadcrumb chain derivation (v3/01 §3): trail from pathname + name maps,
// each level linked, names fall back to humanized slugs, fixture crumbs
// send the division link back to the fixtures tab.
import { describe, expect, it } from "vitest";
import { buildCrumbs, type BreadcrumbT } from "@/lib/breadcrumb-chain";
import { readdirSync } from "node:fs";
import { join } from "node:path";
import { routes } from "@/lib/routes";

const names = {
  comps: { "summer-smash": "Summer Smash 2026" },
  divs: { "summer-smash/u16-boys": "U16 Boys" },
};
const base = { orgName: "Acme Sports", names };

describe("buildCrumbs", () => {
  it("derives the full org › comp › div › page chain", () => {
    expect(
      buildCrumbs({ ...base, pathname: "/o/acme/c/summer-smash/d/u16-boys/schedule" }),
    ).toEqual([
      { label: "Acme Sports", href: "/o/acme" },
      { label: "Summer Smash 2026", href: "/o/acme/c/summer-smash" },
      { label: "U16 Boys", href: "/o/acme/c/summer-smash/d/u16-boys" },
      { label: "Schedule", href: "/o/acme/c/summer-smash/d/u16-boys/schedule" },
    ]);
  });

  it("labels fixtures as Match {no} and points the division back at fixtures", () => {
    const crumbs = buildCrumbs({
      ...base,
      pathname: "/o/acme/c/summer-smash/d/u16-boys/f/14",
    });
    expect(crumbs[2]).toEqual({
      label: "U16 Boys",
      href: "/o/acme/c/summer-smash/d/u16-boys?tab=fixtures",
    });
    expect(crumbs[3]).toEqual({
      label: "Match 14",
      href: "/o/acme/c/summer-smash/d/u16-boys/f/14",
    });
  });

  it("humanizes slugs missing from the name maps", () => {
    const crumbs = buildCrumbs({ ...base, pathname: "/o/acme/c/spring-open" });
    expect(crumbs[1]!.label).toBe("Spring open");
  });

  // Regression: /settings/connect produced ["Acme Sports", "Settings"], so the
  // trail marked "Settings" as the current page while you were on Connect, and
  // the back chevron (which targets crumbs[-2]) pointed at org home — skipping
  // Settings entirely. #190 had removed the page's own "← Settings" link on
  // the grounds the trail already carried one.
  it("gives every settings child its own crumb, so the back chevron lands on Settings", () => {
    expect(buildCrumbs({ ...base, pathname: "/o/acme/settings/connect" })).toEqual([
      { label: "Acme Sports", href: "/o/acme" },
      { label: "Settings", href: "/o/acme/settings" },
      { label: "Connect", href: "/o/acme/settings/connect" },
    ]);
    // An unlisted child still gets a crumb rather than costing the trail one.
    expect(buildCrumbs({ ...base, pathname: "/o/acme/settings/api-keys" }).map((c) => c.label))
      .toEqual(["Acme Sports", "Settings", "Api keys"]);
  });

  it("labels the Add-ons tab from the nav's own key, not a humanized slug", () => {
    const labels = buildCrumbs({ ...base, pathname: "/o/acme/settings/add-ons" }).map(
      (c) => c.label,
    );
    expect(labels).toEqual(["Acme Sports", "Settings", "Add-ons"]);
    // The specific thing being pinned: humanize() renders "add-ons" as
    // "Add ons" — an unhyphenated, untranslated English string on a page that
    // ships in four locales, and a name the sidebar does not use.
    expect(labels[2]).not.toBe("Add ons");
  });

  it("covers settings, billing and create pages", () => {
    expect(buildCrumbs({ ...base, pathname: "/o/acme/settings/billing" }).map((c) => c.label))
      .toEqual(["Acme Sports", "Settings", "Plan & Billing"]);
    expect(buildCrumbs({ ...base, pathname: "/o/acme/c/new" }).map((c) => c.label))
      .toEqual(["Acme Sports", "New competition"]);
    expect(
      buildCrumbs({ ...base, pathname: "/o/acme/c/summer-smash/d/new" }).map((c) => c.label),
    ).toEqual(["Acme Sports", "Summer Smash 2026", "New division"]);
  });

  it("returns only the org crumb on org home and [] off-console", () => {
    expect(buildCrumbs({ ...base, pathname: "/o/acme" })).toHaveLength(1);
    expect(buildCrumbs({ ...base, pathname: "/pricing" })).toEqual([]);
  });

  it("localizes fixed structural segments via the optional `t` translator — design/fix-ui/02-console-org.md: breadcrumb's 'Settings'/'Schedule'/'Registrations' segments stayed English regardless of locale", () => {
    const fr: BreadcrumbT = (key) =>
      ({
        "breadcrumb.settings": "Paramètres",
        "breadcrumb.billing": "Forfait et facturation",
        "breadcrumb.schedule": "Calendrier",
        "breadcrumb.registration": "Inscriptions",
        "breadcrumb.match": "Match {no}",
      })[key as string] ?? String(key);

    expect(
      buildCrumbs({ ...base, pathname: "/o/acme/settings/billing", t: fr }).map((c) => c.label),
    ).toEqual(["Acme Sports", "Paramètres", "Forfait et facturation"]);

    // divTail === "registrations" no longer gets its own crumb — the route
    // was deleted (RS001 demolition); the chain stops at the division.
    expect(
      buildCrumbs({
        ...base,
        pathname: "/o/acme/c/summer-smash/d/u16-boys/registrations",
        t: fr,
      }).map((c) => c.label),
    ).toEqual(["Acme Sports", "Summer Smash 2026", "U16 Boys"]);

    // …and its COMPETITION-level replacement (RS004) does.
    expect(
      buildCrumbs({
        ...base,
        pathname: "/o/acme/c/summer-smash/registration",
        t: fr,
      }).map((c) => c.label),
    ).toEqual(["Acme Sports", "Summer Smash 2026", "Inscriptions"]);
  });

  // The registration hub is a competition-level page, so it owes a crumb of
  // its own. Without one the trail ends at the competition and the back
  // affordance — which targets the structural PARENT, not history — sends the
  // reader to the org home instead of back to the competition they came from.
  describe("the registration hub (RS004)", () => {
    const hub = { ...base, pathname: "/o/acme/c/summer-smash/registration" };

    it("gets its own crumb, so the trail is org > competition > registration", () => {
      expect(buildCrumbs(hub).map((c) => c.label)).toEqual([
        "Acme Sports",
        "Summer Smash 2026",
        "Registration",
      ]);
    });

    it("makes the competition the structural parent, which is what back targets", () => {
      const crumbs = buildCrumbs(hub);
      expect(crumbs.at(-2)!.href).toBe("/o/acme/c/summer-smash");
      expect(crumbs.at(-1)!.href).toBe("/o/acme/c/summer-smash/registration");
    });

    it("points the crumb at the hub root, carrying no tab of its own", () => {
      // The tab is a QUERY parameter and `usePathname()` never includes one,
      // so the crumb cannot vary by tab — it must not pin one either, or it
      // would send the reader back to a tab they may not have been on.
      expect(buildCrumbs(hub).at(-1)!.href).not.toContain("?");
    });
  });

  // Owner report 2026-11-01: on /match-day the trail read "My organization >
  // Racquet Masters" with the competition as the LAST crumb, so it rendered as
  // the current page (not a link) and the phone back chevron pointed at the
  // ORG. Same defect as the registration hub above: an unlisted competition
  // tail stops the trail at the competition.
  describe("Match Day", () => {
    const md = { ...base, pathname: "/o/acme/c/summer-smash/match-day" };

    it("gets its own crumb: org > competition > Match Day", () => {
      const crumbs = buildCrumbs(md);
      expect(crumbs).toHaveLength(3);
      expect(crumbs.map((c) => c.label)).toEqual([
        "Acme Sports",
        "Summer Smash 2026",
        "Match Day",
      ]);
    });

    it("makes the competition the structural parent, which is what back targets", () => {
      const crumbs = buildCrumbs(md);
      // The competition crumb is no longer last, so it renders as a link.
      expect(crumbs.at(-2)).toEqual({
        label: "Summer Smash 2026",
        href: routes.competition("acme", "summer-smash"),
      });
      expect(crumbs.at(-1)!.href).toBe(routes.competitionMatchDay("acme", "summer-smash"));
    });

    it("localizes the label through the translator", () => {
      const fr: BreadcrumbT = (key) =>
        key === "breadcrumb.matchDay" ? "Jour de match" : String(key);
      expect(buildCrumbs({ ...md, t: fr }).at(-1)!.label).toBe("Jour de match");
    });
  });

  // The next competition-level route must not repeat the registration (2026-08-25)
  // and Match Day (2026-11-01) defect. The directories under
  // app/o/[orgSlug]/c/[compSlug]/ ARE the competition-level routes, so enumerate
  // them rather than a list typed here, and drive buildCrumbs for each.
  describe("every competition-level route directory owes a crumb", () => {
    const COMP_DIR = join(import.meta.dirname, "..", "..", "app", "o", "[orgSlug]", "c", "[compSlug]");
    // `d` is the division subtree (its own chain); `__tests__` is not a route.
    const NOT_ROUTES = new Set(["d", "__tests__"]);
    // Routes that deliberately have NO crumb of their own. `upgrade` carries an
    // in-page "← Back to competition" link (upgrade/page.tsx), so it is the one
    // page that does not rely on the trail's back target. Adding a name here is a
    // decision; it is asserted below to be real and to really have no crumb, so
    // the list cannot rot.
    const NO_CRUMB = new Set(["upgrade"]);

    const dirs = readdirSync(COMP_DIR, { withFileTypes: true })
      .filter((e) => e.isDirectory() && !NOT_ROUTES.has(e.name))
      .map((e) => e.name)
      .sort();
    const owing = dirs.filter((d) => !NO_CRUMB.has(d));
    const crumbsFor = (dir: string) =>
      buildCrumbs({ ...base, pathname: `/o/acme/c/summer-smash/${dir}` });

    it("finds the route directories (anti-vacuity)", () => {
      expect(dirs.length).toBeGreaterThan(0);
      expect(owing.length).toBeGreaterThan(0);
      // The two defects this guard exists for, by name.
      expect(owing).toContain("registration");
      expect(owing).toContain("match-day");
    });

    it("gives each one a third crumb that links to its own path", () => {
      for (const dir of owing) {
        const crumbs = crumbsFor(dir);
        expect(crumbs, dir).toHaveLength(3);
        expect(crumbs[1]!.href, dir).toBe("/o/acme/c/summer-smash");
        expect(crumbs[2]!.href, dir).toBe(`/o/acme/c/summer-smash/${dir}`);
      }
    });

    it("keeps the no-crumb list exact: every entry is a real route that really has none", () => {
      for (const dir of NO_CRUMB) {
        expect(dirs, dir).toContain(dir);
        expect(crumbsFor(dir), dir).toHaveLength(2);
      }
    });
  });

  it("without a `t` translator falls back to the plain English catalog lookup — same values the untranslated tests above assert, so buildCrumbs stays pure/testable outside a DictProvider", () => {
    expect(
      buildCrumbs({ ...base, pathname: "/o/acme/settings/billing" }).map((c) => c.label),
    ).toEqual(["Acme Sports", "Settings", "Plan & Billing"]);
  });
});
