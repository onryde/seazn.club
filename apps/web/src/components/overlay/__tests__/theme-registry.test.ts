// The theme registry (owner answer 18 / Q7). Four claims, and the fourth is
// the one that matters: the fallback is the SPORT'S default, not a constant.
//
// THE TRAP THIS FILE IS WRITTEN AROUND. On day one BOTH shipped themes are
// `sports: "all"`, so a suitability test written against `OVERLAY_THEMES`
// alone cannot witness the `sports` filter at all — it would pass with the
// filter deleted, and mutant (l) would survive. The probe registry below is
// what makes that branch reachable; it is not a mirror, because the FUNCTION
// under test is the shipped one and only its input table is local.
import { describe, expect, it } from "vitest";
import {
  OVERLAY_THEMES,
  defaultThemeFor,
  resolveTheme,
  resolveThemeFrom,
  themesForSport,
  type OverlayThemeDef,
} from "../theme-registry";

// A stand-in component; the registry never renders here.
const Noop = () => null;

/** A registry with a sport-RESTRICTED entry, which the shipped one has none of
 *  today. `cricketOnly` suits cricket and nothing else. */
const PROBE: Record<string, OverlayThemeDef> = {
  bar: { ...OVERLAY_THEMES.bar },
  bug: { ...OVERLAY_THEMES.bug },
  cricketOnly: {
    id: "bar", // id is the registry KEY's type; the probe reuses a real one
    labelKey: "stream.tab.bar",
    component: Noop,
    sports: ["cricket"],
  },
};

describe("defaultThemeFor", () => {
  it("opens cricket on the bar and every other sport on the bug", () => {
    expect(defaultThemeFor("cricket")).toBe("bar");
    for (const key of ["football", "tennis", "badminton", "volleyball", "generic"]) {
      expect(defaultThemeFor(key), key).toBe("bug");
    }
  });

  it("returns a theme that actually suits that sport — a default nothing offers is unreachable", () => {
    for (const key of ["cricket", "football", "tennis", "boardgame", "carrom", "generic"]) {
      const offered = themesForSport(key).map((t) => t.id);
      expect(offered, key).toContain(defaultThemeFor(key));
    }
  });
});

describe("resolveTheme", () => {
  it("resolves a valid id — including one that is NOT that sport's default", () => {
    // Both directions, or "valid id resolves" is indistinguishable from
    // "everything falls back to the default and cricket's happens to be bar".
    expect(resolveTheme("bar", "cricket").id).toBe("bar");
    expect(resolveTheme("bug", "cricket").id).toBe("bug");
    expect(resolveTheme("bar", "football").id).toBe("bar");
    expect(resolveTheme("bug", "football").id).toBe("bug");
  });

  it("falls back on an unknown or misspelt id, and never throws", () => {
    for (const bad of [undefined, "", " ", "BAR", "bugg", "corner-bug", "../etc", "__proto__", "toString"]) {
      expect(() => resolveTheme(bad, "football")).not.toThrow();
      expect(resolveTheme(bad, "football").id, String(bad)).toBe("bug");
    }
  });

  it("falls back when the requested theme does not list the fixture's sport", () => {
    // The probe's `cricketOnly` suits cricket only; football must not get it.
    expect(resolveThemeFrom(PROBE, "cricketOnly", "cricket", defaultThemeFor("cricket")).sports).toEqual(["cricket"]);
    expect(resolveThemeFrom(PROBE, "cricketOnly", "football", defaultThemeFor("football")).id).toBe("bug");
  });

  it("falls back to THE SPORT'S default, not to a hardcoded one", () => {
    // The differential case. Same bad input, two sports, two answers — a
    // `return OVERLAY_THEMES.bug` fallback passes every other test in this file.
    expect(resolveTheme("nonsense", "cricket").id).toBe("bar");
    expect(resolveTheme("nonsense", "football").id).toBe("bug");
    expect(resolveThemeFrom(PROBE, "cricketOnly", "cricket", "bar").id).not.toBe("bug");
  });
});

describe("themesForSport — the console and the route read ONE filter", () => {
  it("offers only themes that suit the sport, and every offered theme resolves back to itself", () => {
    for (const key of ["cricket", "football", "tennis", "volleyball", "boardgame", "generic"]) {
      const offered = themesForSport(key);
      expect(offered.length, key).toBeGreaterThan(0);
      for (const theme of offered) {
        expect(theme.sports === "all" || theme.sports.includes(key), `${key}/${theme.id}`).toBe(true);
        // The seam: a theme the panel shows must be one the route accepts.
        expect(resolveTheme(theme.id, key).id, `${key}/${theme.id}`).toBe(theme.id);
      }
    }
  });

  it("every registered theme carries a label key, and the registry is what the dictionary gate scans", () => {
    for (const theme of Object.values(OVERLAY_THEMES)) {
      expect(theme.labelKey, theme.id).toMatch(/^stream\.tab\./);
      expect(typeof theme.component, theme.id).toBe("function");
    }
    // Both shipped themes today; a third makes this a 3.
    expect(Object.keys(OVERLAY_THEMES).sort()).toEqual(["bar", "bug"]);
  });
});
