// The overlay's theme registry (owner answer 18 / Q7, 2026-09-06:
// "we will have multiple theme per sports so make it abstract and use can
// choose for now apply the default one").
//
// ONE authority for three facts: which themes exist, which sports each suits,
// and which one a sport opens on. Adding a theme is ONE entry here plus ONE
// component file — the route, the panel and the model are never edited for a
// theme again. `overlay-model.ts` does not import this file and must not: the
// projection is theme-agnostic, which is what lets eleven sports and N themes
// meet in one model.
//
// NOT a `"use client"` module, deliberately. It imports two client components,
// so it becomes part of the client graph where a client component imports it;
// the SERVER page imports only `resolveTheme` and reads `.id` off the result,
// never `.component`, so no component reference crosses the RSC boundary as a
// prop. The stage does the component lookup on the client side of the line.
import type { ComponentType } from "react";
import type { OverlayModel } from "@/lib/overlay-model";
import { OverlayBar } from "./overlay-bar";
import { OverlayBug } from "./overlay-bug";

/** Every theme id the overlay can serve. Declared as an explicit union rather
 *  than derived with `keyof typeof OVERLAY_THEMES`, for two reasons: the page,
 *  the stage's props and the panel's state all need to NAME this type without
 *  importing the registry's value graph, and an explicit union makes a typo'd
 *  registry key a compile error instead of silently widening `ThemeId`. */
export type ThemeId = "bar" | "bug";

export interface OverlayThemeDef {
  id: ThemeId;
  /** `ui` namespace, e.g. `stream.tab.bar`. The panel renders it through
   *  `useMsg` in all four locales; the dictionary coverage test finds it here
   *  because `components/overlay` is one of its SCAN_DIRS. Never English. */
  labelKey: string;
  component: ComponentType<{ model: OverlayModel; tick: [boolean, boolean] }>;
  /** `"all"`, or the exact `sport_key` values this theme is designed for. A
   *  theme is offered in the console and accepted by the route only where this
   *  says so — one filter, so the two cannot disagree. */
  sports: "all" | readonly string[];
}

export const OVERLAY_THEMES: Record<ThemeId, OverlayThemeDef> = {
  bar: { id: "bar", labelKey: "stream.tab.bar", component: OverlayBar, sports: "all" },
  bug: { id: "bug", labelKey: "stream.tab.bug", component: OverlayBug, sports: "all" },
};

/** Which theme a sport OPENS on. Unchanged from decision 1 — cricket's chase
 *  and two-innings score want the lower third, a set or period score wants the
 *  tile — but it is one named function now, not a boolean inside the resolver,
 *  so a future per-sport default is one line here. */
export function defaultThemeFor(sportKey: string): ThemeId {
  return sportKey === "cricket" ? "bar" : "bug";
}

function suits(theme: OverlayThemeDef, sportKey: string): boolean {
  return theme.sports === "all" || theme.sports.includes(sportKey);
}

/** What the console offers for this fixture, in registry order. */
export function themesForSport(sportKey: string): readonly OverlayThemeDef[] {
  return Object.values(OVERLAY_THEMES).filter((theme) => suits(theme, sportKey));
}

/** The body, with the registry injected. Exported ONLY so a test can pass a
 *  registry that HAS a sport-restricted theme: both shipped themes are
 *  `sports: "all"`, so the suitability branch is otherwise unreachable and
 *  deleting it would go unnoticed (mutant (l)). Production callers use
 *  `resolveTheme`. */
export function resolveThemeFrom(
  themes: Readonly<Record<string, OverlayThemeDef>>,
  styleParam: string | undefined,
  sportKey: string,
  fallback: ThemeId,
): OverlayThemeDef {
  // `Object.hasOwn`, not `themes[styleParam]`: `?style=toString` would
  // otherwise reach a prototype member and pass the truthiness check.
  const requested =
    styleParam && Object.hasOwn(themes, styleParam) ? themes[styleParam] : undefined;
  if (requested && suits(requested, sportKey)) return requested;
  return OVERLAY_THEMES[fallback];
}

/**
 * The one resolver. An unknown, misspelt or sport-unsuitable `?style=` falls
 * back to the sport's default and NEVER throws: the caller is an OBS browser
 * source in the middle of a live broadcast, and it cannot be asked to correct
 * a typo. A 404 or an exception here would take a club off air over a query
 * string.
 */
export function resolveTheme(styleParam: string | undefined, sportKey: string): OverlayThemeDef {
  return resolveThemeFrom(OVERLAY_THEMES, styleParam, sportKey, defaultThemeFor(sportKey));
}
