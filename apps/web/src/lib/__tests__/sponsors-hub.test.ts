// R4 sponsors-on-stream S11 - the Sponsors hub's pure tab rules (spec 2026-10-27 §5.1, R19).
//
// Pure and dependency-free so the hub page, the Settings redirect and the tests share ONE declaration of the tabs.
// Every expectation below is read from `SPONSORS_TABS` / `SPONSORS_EDITOR_ONLY_TABS` themselves (the declarations),
// never from a second typed list - except the ONE literal pin of the declared order, which is the contract with
// S12 (On stream) and S13 (Overview) and with the e2e specs.
import { describe, expect, it } from "vitest";
import {
  SPONSORS_EDITOR_ONLY_TABS,
  SPONSORS_TABS,
  dealHref,
  legacySettingsSponsorsTarget,
  onStreamHref,
  resolveDealParam,
  resolveOnStreamScope,
  resolveSponsorParam,
  resolveSponsorsTab,
  sponsorHref,
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

// ---------------------------------------------------------------------------------------------------------------------
// Sponsor deals PR 2, Task 13: the hub's `?sponsor=` and `?deal=` (a sponsor's own page; a deal on it).
//
// Both params are trusted for nothing: an id is a selection only if it is one of the ids the PAGE loaded for THIS org (and, for
// a deal, for the selected sponsor). Anything else behaves as if absent - the list - never a 404 and never a crash. The
// expected URLs below are typed from the plan's interface (`/o/<slug>/sponsors?tab=sponsors&sponsor=<id>[&deal=<id>]`), not
// built with the helper under test.
// ---------------------------------------------------------------------------------------------------------------------
const SPONSOR_A = "aaaaaaaa-1111-4aaa-8bbb-cccccccccccc";
const SPONSOR_B = "bbbbbbbb-2222-4bbb-8ccc-dddddddddddd";
const FOREIGN = "eeeeeeee-9999-4eee-8fff-ffffffffffff";

describe.each([
  ["resolveSponsorParam", resolveSponsorParam],
  ["resolveDealParam", resolveDealParam],
] as const)("%s (a raw param is a selection only if it is one of THIS org's loaded ids)", (name, resolve) => {
  const own = [{ id: SPONSOR_A }, { id: SPONSOR_B }];

  it("an own id resolves to itself - and the SECOND id too, not just the first", () => {
    expect(resolve(SPONSOR_A, own)).toBe(SPONSOR_A);
    expect(resolve(SPONSOR_B, own)).toBe(SPONSOR_B);
  });

  it("the empty list resolves nothing (the empty case: an org with no sponsors or no deals)", () => {
    expect(resolve(SPONSOR_A, [])).toBeNull();
    expect(resolve(undefined, [])).toBeNull();
  });

  it("an id that is not in the list - another org's, made up, differently cased, or an inherited key - is absent (counted)", () => {
    let checked = 0;
    for (const raw of [FOREIGN, "not-a-uuid", SPONSOR_A.toUpperCase(), ` ${SPONSOR_A}`, `${SPONSOR_A} `, "__proto__", "constructor", "toString", "0"]) {
      expect(resolve(raw, own), `${name}(${JSON.stringify(raw)})`).toBeNull();
      checked++;
    }
    expect(checked).toBe(9);
  });

  it("absent and empty are absent; a repeated param (an array - even of own ids, even of one) is absent, never the first element (counted)", () => {
    let checked = 0;
    for (const raw of [undefined, "", [], [SPONSOR_A], [SPONSOR_A, SPONSOR_B], [FOREIGN, SPONSOR_A]] as (string | string[] | undefined)[]) {
      expect(resolve(raw, own), `${name}(${JSON.stringify(raw)})`).toBeNull();
      checked++;
    }
    expect(checked).toBe(6);
  });

  it("answers the list's own id, a second call answers the same, and the list is not touched", () => {
    const list = [{ id: SPONSOR_A }, { id: SPONSOR_B }];
    const before = JSON.stringify(list);
    expect(resolve(SPONSOR_B, list)).toBe(SPONSOR_B);
    expect(resolve(SPONSOR_B, list)).toBe(SPONSOR_B);
    expect(JSON.stringify(list)).toBe(before);
  });
});

describe("sponsorHref / dealHref (the sponsor's page and a deal on it are ?sponsor= / ?deal= on the Sponsors tab)", () => {
  it("a sponsor is ?tab=sponsors&sponsor=<id>; a deal adds &deal=<id> after it", () => {
    expect(sponsorHref("acme", SPONSOR_A)).toBe(`/o/acme/sponsors?tab=sponsors&sponsor=${SPONSOR_A}`);
    expect(dealHref("acme", SPONSOR_A, SPONSOR_B)).toBe(`/o/acme/sponsors?tab=sponsors&sponsor=${SPONSOR_A}&deal=${SPONSOR_B}`);
  });

  it("a deal URL starts with its sponsor's URL (one place for the shape), and both start with the Sponsors tab's", () => {
    expect(dealHref("acme", "s", "d").startsWith(sponsorHref("acme", "s"))).toBe(true);
    expect(sponsorHref("acme", "s").startsWith(sponsorsHref("acme", "sponsors"))).toBe(true);
  });

  it("encodes the ids (a value with & or = cannot smuggle a second param)", () => {
    expect(sponsorHref("acme", "a&tab=team=1")).toBe("/o/acme/sponsors?tab=sponsors&sponsor=a%26tab%3Dteam%3D1");
    expect(dealHref("acme", "s", "a&b")).toBe("/o/acme/sponsors?tab=sponsors&sponsor=s&deal=a%26b");
  });

  it("round trip: the id in a built URL is the id the resolver accepts", () => {
    const url = new URL(dealHref("acme", SPONSOR_A, SPONSOR_B), "https://x.test");
    expect(url.searchParams.get("tab")).toBe("sponsors");
    expect(resolveSponsorsTab(url.searchParams.get("tab") ?? undefined, true)).toBe("sponsors");
    expect(resolveSponsorParam(url.searchParams.get("sponsor") ?? undefined, [{ id: SPONSOR_A }])).toBe(SPONSOR_A);
    expect(resolveDealParam(url.searchParams.get("deal") ?? undefined, [{ id: SPONSOR_B }])).toBe(SPONSOR_B);
  });
});
