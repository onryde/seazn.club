// A PRINTED or QR'd kiosk URL must survive a rename (K fix round, F2 + F3).
//
// Two measured defects on the /present boards, both fixed here:
//
//   F3 — a renamed COMPETITION 404'd the board. `/shared/<org>/<old>` 308s to
//        the new slug, but `/shared/<org>/<old>/present` called a bare
//        `notFound()` and never consulted the rename history.
//   F2 — a renamed ORG dropped the path tail. The kiosk LAYOUT entered through
//        `publicOrgOr404`, which calls `sharedRenameTarget(orgSlug)` with only
//        its own param — a layout has no others — so the board landed on
//        `/shared/<new>`, the org hub, instead of `/shared/<new>/<comp>/present`.
//
// So the assertions below pin the redirect TARGET, never merely "it redirected":
// the tail-less bug redirects too, and a test that only checked for a redirect
// would pass on exactly the defect this file exists for. They also pin the
// ARGUMENTS `sharedRenameTarget` is called with, which is where F2 actually
// lived — a call with the org slug alone cannot produce a tail, whatever the
// caller then does with the answer.
//
// The two halves are tested together on purpose: the fix moves the rename
// decision OUT of the layout (which cannot see the tail) and INTO each board
// page (which can). A layout that still redirects would terminate the response
// before the page's own correct redirect could run, so "the layout does not
// redirect" is a load-bearing assertion, not a tautology.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createElement, type ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

vi.mock("next/font/google", () => ({
  Barlow_Condensed: () => ({ variable: "(display-font-variable)", className: "" }),
}));

// Sentinels rather than Next's own control-flow errors: three branches here end
// in a throw, and a test that only asserted "it threw" could not tell a 404
// from a redirect from a crash. The redirect carries its target in the message,
// so the tail is asserted rather than assumed.
const nav = vi.hoisted(() => ({
  notFound: vi.fn(() => {
    throw new Error("CALLED_NOT_FOUND");
  }),
  permanentRedirect: vi.fn((to: string) => {
    throw new Error(`CALLED_REDIRECT:${to}`);
  }),
}));
vi.mock("next/navigation", async (importOriginal) => ({
  ...(await importOriginal<typeof import("next/navigation")>()),
  notFound: nav.notFound,
  permanentRedirect: nav.permanentRedirect,
}));

const stub = vi.hoisted(() => ({
  getPublicOrg: vi.fn(),
  getPublicCompetition: vi.fn(),
  getPublicDivision: vi.fn(),
  sharedRenameTarget: vi.fn(),
}));
// importOriginal spread, like `slideshow-labels.test.tsx`: the rest of the data
// module stays real so nothing it exports goes undefined under a sibling import.
vi.mock("@/server/public-site/data", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  getPublicOrg: stub.getPublicOrg,
  getPublicCompetition: stub.getPublicCompetition,
  getPublicDivision: stub.getPublicDivision,
}));
vi.mock("@/server/slug-resolve", () => ({ sharedRenameTarget: stub.sharedRenameTarget }));
// The board's slides are not what this file is about; building them for real
// would drag the whole read model in.
vi.mock("@/server/slideshow-data", () => ({ buildPublicDivisionSlides: async () => [] }));

import KioskOrgLayout from "../layout";
import PresentCompetitionPage from "../[competitionSlug]/present/page";
import PresentDivisionPage from "../[competitionSlug]/[divisionSlug]/present/page";

const ORG = {
  id: "o1",
  name: "Test Org",
  slug: "test-org",
  branded: false,
  branding: { colors: { primary: "#0f766e" } },
  logo: null,
  about: null,
  default_locale: "en",
};
const COMPETITION = { id: "c1", org_id: "o1", name: "Test Comp", slug: "test-comp", branding: null };
const DIVISION = { id: "d1", competition_id: "c1", name: "Test Div", slug: "test-div" };

const shell = () => ({ org: ORG, competition: COMPETITION, divisions: [], liveNow: [] });
const divisionData = () => ({
  org: ORG,
  competition: COMPETITION,
  division: DIVISION,
  stages: [],
  pools: [],
  fixtures: [],
  standings: [],
  entrants: [],
  tz: "UTC",
});

/** The competition board, at whatever slugs the case is about. */
const compBoard = (orgSlug = "test-org", competitionSlug = "test-comp") =>
  PresentCompetitionPage({ params: Promise.resolve({ orgSlug, competitionSlug }) });
/** The division board. */
const divBoard = (orgSlug = "test-org", competitionSlug = "test-comp", divisionSlug = "test-div") =>
  PresentDivisionPage({ params: Promise.resolve({ orgSlug, competitionSlug, divisionSlug }) });
/** The kiosk org layout, handed a probe child. */
const layout = (orgSlug = "test-org") =>
  KioskOrgLayout({
    children: createElement("p", { "data-probe": "board" }, "(the board)"),
    params: Promise.resolve({ orgSlug }),
  });

beforeEach(() => {
  for (const fn of [stub.getPublicOrg, stub.getPublicCompetition, stub.getPublicDivision, stub.sharedRenameTarget, nav.notFound, nav.permanentRedirect]) {
    fn.mockClear();
  }
  stub.getPublicOrg.mockResolvedValue({ org: ORG, competitions: [] });
  stub.getPublicCompetition.mockResolvedValue(shell());
  stub.getPublicDivision.mockResolvedValue(divisionData());
  stub.sharedRenameTarget.mockResolvedValue(null);
});

describe("a renamed ORG keeps the whole path (F2)", () => {
  // The old org slug resolves to nothing live, so the board's own read misses.
  const orgWasRenamed = () => {
    stub.getPublicCompetition.mockResolvedValue(null);
    stub.getPublicDivision.mockResolvedValue(null);
    stub.sharedRenameTarget.mockImplementation(async (_org: string, comp?: string, div?: string) =>
      ["/shared/new-org", comp, div].filter(Boolean).join("/"),
    );
  };

  it("competition board: lands on the board under the new org, not on the org hub", async () => {
    orgWasRenamed();
    await expect(compBoard("old-org")).rejects.toThrow("CALLED_REDIRECT:/shared/new-org/test-comp/present");
    // Where F2 actually lived: a call with the org slug alone cannot carry a tail.
    expect(stub.sharedRenameTarget).toHaveBeenCalledWith("old-org", "test-comp");
    expect(nav.notFound).not.toHaveBeenCalled();
  });

  it("division board: keeps the division too", async () => {
    orgWasRenamed();
    await expect(divBoard("old-org")).rejects.toThrow(
      "CALLED_REDIRECT:/shared/new-org/test-comp/test-div/present",
    );
    expect(stub.sharedRenameTarget).toHaveBeenCalledWith("old-org", "test-comp", "test-div");
    expect(nav.notFound).not.toHaveBeenCalled();
  });

  it("the layout does NOT redirect a renamed org: a tail-less 308 there would win the response first", async () => {
    orgWasRenamed();
    stub.getPublicOrg.mockResolvedValue(null);
    const html = renderToStaticMarkup((await layout("old-org")) as ReactElement);
    expect(html).toContain('data-probe="board"');
    expect(nav.permanentRedirect).not.toHaveBeenCalled();
    expect(nav.notFound).not.toHaveBeenCalled();
  });
});

describe("a renamed COMPETITION redirects instead of 404ing (F3)", () => {
  it("competition board", async () => {
    stub.getPublicCompetition.mockResolvedValue(null);
    stub.sharedRenameTarget.mockResolvedValue("/shared/test-org/new-comp");
    await expect(compBoard()).rejects.toThrow("CALLED_REDIRECT:/shared/test-org/new-comp/present");
    expect(nav.notFound).not.toHaveBeenCalled();
  });

  it("division board", async () => {
    stub.getPublicDivision.mockResolvedValue(null);
    stub.sharedRenameTarget.mockResolvedValue("/shared/test-org/new-comp/test-div");
    await expect(divBoard()).rejects.toThrow("CALLED_REDIRECT:/shared/test-org/new-comp/test-div/present");
    expect(nav.notFound).not.toHaveBeenCalled();
  });
});

describe("a renamed DIVISION redirects (F3, division board)", () => {
  it("lands on the new division's board", async () => {
    stub.getPublicDivision.mockResolvedValue(null);
    stub.sharedRenameTarget.mockResolvedValue("/shared/test-org/test-comp/new-div");
    await expect(divBoard()).rejects.toThrow("CALLED_REDIRECT:/shared/test-org/test-comp/new-div/present");
    expect(stub.sharedRenameTarget).toHaveBeenCalledWith("test-org", "test-comp", "test-div");
    expect(nav.notFound).not.toHaveBeenCalled();
  });
});

describe("what is genuinely not there still 404s", () => {
  // The negative pair for every redirect above: nothing in the rename history,
  // so the board must 404 rather than redirect to a path built out of nothing.
  it("competition board: a slug that was never anything", async () => {
    stub.getPublicCompetition.mockResolvedValue(null);
    stub.sharedRenameTarget.mockResolvedValue(null);
    await expect(compBoard("no-such-org", "no-such-comp")).rejects.toThrow("CALLED_NOT_FOUND");
    expect(nav.permanentRedirect).not.toHaveBeenCalled();
  });

  it("division board: a slug that was never anything", async () => {
    stub.getPublicDivision.mockResolvedValue(null);
    stub.sharedRenameTarget.mockResolvedValue(null);
    await expect(divBoard("no-such-org", "no-such-comp", "no-such-div")).rejects.toThrow("CALLED_NOT_FOUND");
    expect(nav.permanentRedirect).not.toHaveBeenCalled();
  });

  it("a missing org still 404s — the layout defers, and the board is what answers", async () => {
    stub.getPublicOrg.mockResolvedValue(null);
    stub.getPublicCompetition.mockResolvedValue(null);
    stub.sharedRenameTarget.mockResolvedValue(null);
    // The layout renders (it has nothing to decide with) …
    expect(renderToStaticMarkup((await layout("no-such-org")) as ReactElement)).toContain('data-probe="board"');
    // … and the page is what refuses, so no shell is ever served.
    await expect(compBoard("no-such-org")).rejects.toThrow("CALLED_NOT_FOUND");
  });

  it("a reserved slug still 404s before the database is touched", async () => {
    await expect(layout("admin")).rejects.toThrow("CALLED_NOT_FOUND");
    expect(stub.getPublicOrg).not.toHaveBeenCalled();
  });
});

describe("the positive pair: a live board is neither redirected nor 404'd", () => {
  it("competition board renders", async () => {
    await expect(compBoard()).resolves.toBeTruthy();
    expect(nav.permanentRedirect).not.toHaveBeenCalled();
    expect(nav.notFound).not.toHaveBeenCalled();
    // A live board must not pay for a rename lookup it does not need.
    expect(stub.sharedRenameTarget).not.toHaveBeenCalled();
  });

  it("division board renders", async () => {
    await expect(divBoard()).resolves.toBeTruthy();
    expect(nav.permanentRedirect).not.toHaveBeenCalled();
    expect(nav.notFound).not.toHaveBeenCalled();
    expect(stub.sharedRenameTarget).not.toHaveBeenCalled();
  });

  it("the layout still themes the board with the org's palette when the org is there", async () => {
    const html = renderToStaticMarkup((await layout()) as ReactElement);
    expect(html).toContain('data-probe="board"');
    // Anti-vacuity for the layout's null path: a real org still gets a style.
    expect(/^<div\b[^>]*\bstyle="[^"]+"/.test(html)).toBe(true);
  });
});
