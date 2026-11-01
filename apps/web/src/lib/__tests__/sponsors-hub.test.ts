// R4 sponsors-on-stream S11 - the Sponsors hub's pure tab rules (spec 2026-10-27 §5.1, R19).
//
// Pure and dependency-free so the page, the nav's dashboard entry and the tests share ONE declaration of the tabs.
// Every expectation below is read from `SPONSORS_TABS` / `SPONSORS_EDITOR_ONLY_TABS` themselves (the declarations),
// never from a second typed list - except the ONE literal pin of the declared order, which is the contract with
// S12 (On stream) and S13 (Overview) and with the e2e specs.
import { describe, expect, it } from "vitest";
import {
  SPONSORS_EDITOR_ONLY_TABS,
  SPONSORS_TABS,
  legacySettingsSponsorsTarget,
  onStreamHref,
  resolveOnStreamScope,
  resolveSponsorsTab,
  sponsorsHref,
  sponsorsTabsFor,
} from "@/lib/sponsors-hub";
import { routes } from "@/lib/routes";

describe("SPONSORS_TABS", () => {
  it("is the four tabs the spec names, Overview first (the default), in the order they are laid out", () => {
    expect(SPONSORS_TABS).toEqual(["overview", "sponsors", "on_stream", "packages"]);
  });

  it("the editor-only set is a strict, non-empty subset of the declared tabs (nothing invented, nothing vacuous)", () => {
    expect(SPONSORS_EDITOR_ONLY_TABS.length).toBeGreaterThan(0);
    for (const tab of SPONSORS_EDITOR_ONLY_TABS) expect(SPONSORS_TABS).toContain(tab);
    expect(SPONSORS_EDITOR_ONLY_TABS.length).toBeLessThan(SPONSORS_TABS.length);
    // Overview is the landing tab: a viewer must always be able to land on it.
    expect(SPONSORS_EDITOR_ONLY_TABS).not.toContain(SPONSORS_TABS[0]);
  });
});

describe("sponsorsTabsFor", () => {
  it("an editor sees every declared tab, in declared order", () => {
    expect(sponsorsTabsFor(true)).toEqual([...SPONSORS_TABS]);
  });

  it("a non-editor sees every declared tab EXCEPT the editor-only ones - the read-only view Settings gave (R19)", () => {
    const viewer = sponsorsTabsFor(false);
    expect(viewer.length).toBeGreaterThan(0);
    for (const tab of SPONSORS_TABS) {
      expect(viewer.includes(tab), `${tab} for a non-editor`).toBe(!SPONSORS_EDITOR_ONLY_TABS.includes(tab));
    }
  });
});

describe("resolveSponsorsTab", () => {
  it("no tab, an empty tab and an unknown tab all land on Overview - for an editor AND a non-editor", () => {
    let checked = 0;
    for (const canEdit of [true, false]) {
      for (const raw of [undefined, "", "bogus", "Overview", "sponsors ", "settings"]) {
        expect(resolveSponsorsTab(raw, canEdit), `${JSON.stringify(raw)} canEdit=${canEdit}`).toBe("overview");
        checked++;
      }
    }
    expect(checked).toBe(12);
  });

  it("inherited object keys are not tabs (a lookup table would answer for them)", () => {
    for (const raw of ["__proto__", "constructor", "toString", "hasOwnProperty", "length", "0"]) {
      expect(resolveSponsorsTab(raw, true), raw).toBe("overview");
    }
  });

  it("every tab an editor may see resolves to itself", () => {
    const seen = sponsorsTabsFor(true).map((tab) => resolveSponsorsTab(tab, true));
    expect(seen).toEqual([...SPONSORS_TABS]);
    expect(seen.length).toBeGreaterThan(0);
  });

  it("a non-editor reaches the tabs they may see, and falls back to Overview for an editor-only tab (the denied gate)", () => {
    let granted = 0;
    let denied = 0;
    for (const tab of SPONSORS_TABS) {
      const got = resolveSponsorsTab(tab, false);
      if (SPONSORS_EDITOR_ONLY_TABS.includes(tab)) {
        expect(got, `${tab} is editor-only`).toBe("overview");
        denied++;
      } else {
        expect(got, `${tab} is readable`).toBe(tab);
        granted++;
      }
    }
    // Anti-vacuity: both arms ran.
    expect(granted).toBeGreaterThan(0);
    expect(denied).toBeGreaterThan(0);
  });
});

describe("sponsorsHref", () => {
  it("the bare hub is /o/<slug>/sponsors; a tab is a ?tab= on it - for every declared tab", () => {
    expect(sponsorsHref("acme")).toBe("/o/acme/sponsors");
    for (const tab of SPONSORS_TABS) expect(sponsorsHref("acme", tab)).toBe(`/o/acme/sponsors?tab=${tab}`);
    expect(SPONSORS_TABS.length).toBeGreaterThan(0);
  });

  it("is the console route builder's own URL (one place for the shape)", () => {
    expect(sponsorsHref("acme", "packages")).toBe(routes.orgSponsors("acme", "packages"));
    expect(sponsorsHref("acme")).toBe(routes.orgSponsors("acme"));
  });
});

describe("legacySettingsSponsorsTarget (settings?tab=sponsors -> sponsors?tab=sponsors)", () => {
  it("the bare legacy URL lands on the Sponsors tab of the hub", () => {
    expect(legacySettingsSponsorsTarget("acme", { tab: "sponsors" })).toBe("/o/acme/sponsors?tab=sponsors");
  });

  it("KEEPS every other query param, after tab - a return flag minted before the move is not silently dropped", () => {
    expect(legacySettingsSponsorsTarget("acme", { tab: "sponsors", x: "1" })).toBe("/o/acme/sponsors?tab=sponsors&x=1");
    expect(legacySettingsSponsorsTarget("acme", { x: "1", tab: "sponsors", y: "2" })).toBe(
      "/o/acme/sponsors?tab=sponsors&x=1&y=2",
    );
  });

  it("repeats a repeated param, drops an undefined one, and never lets an incoming tab override the forced one", () => {
    expect(legacySettingsSponsorsTarget("acme", { tab: ["team", "api"], x: ["1", "2"], gone: undefined })).toBe(
      "/o/acme/sponsors?tab=sponsors&x=1&x=2",
    );
  });

  it("encodes values (a value with & or = cannot smuggle a second param)", () => {
    expect(legacySettingsSponsorsTarget("acme", { tab: "sponsors", next: "a&tab=team=1" })).toBe(
      "/o/acme/sponsors?tab=sponsors&next=a%26tab%3Dteam%3D1",
    );
  });
});

describe("onStreamHref (the On stream tab's scope picker URL, S12)", () => {
  it("no scope is the hub's own On stream URL; a competition adds &scope= (encoded) after the tab", () => {
    expect(onStreamHref("riverside")).toBe(sponsorsHref("riverside", "on_stream"));
    expect(onStreamHref("riverside", null)).toBe("/o/riverside/sponsors?tab=on_stream");
    expect(onStreamHref("riverside", "c1")).toBe("/o/riverside/sponsors?tab=on_stream&scope=c1");
    expect(onStreamHref("riverside", "a&b=c"), "a value cannot smuggle a second param").toBe("/o/riverside/sponsors?tab=on_stream&scope=a%26b%3Dc");
    expect(onStreamHref("riverside", ""), "an empty id is no scope").toBe("/o/riverside/sponsors?tab=on_stream");
  });
});

describe("resolveOnStreamScope (a raw ?scope= is a scope only if it is one of THIS org's competitions)", () => {
  const competitions = [{ id: "c1" }, { id: "c2" }];

  it("an org competition's id is the scope; anything else is the organisation scope (null) - counted", () => {
    let checked = 0;
    for (const [raw, want] of [
      ["c1", "c1"],
      ["c2", "c2"],
      [undefined, null],
      ["", null],
      ["c3", null],
      ["C1", null],
      ["__proto__", null],
      ["constructor", null],
      [["c1", "c2"], null],
      [[], null],
    ] as const) {
      expect(resolveOnStreamScope(raw as string | string[] | undefined, competitions), JSON.stringify(raw)).toBe(want);
      checked++;
    }
    expect(checked).toBe(10);
  });

  it("an org with no competitions has only the organisation scope", () => {
    expect(resolveOnStreamScope("c1", [])).toBeNull();
  });
});
