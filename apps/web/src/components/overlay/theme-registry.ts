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
// NOT a `"use client"` module, deliberately. It imports three client
// components, so it becomes part of the client graph where a client component
// imports it; the SERVER page imports only `resolveTheme` and reads `.id` off
// the result, never `.component`, so no component reference crosses the RSC
// boundary as a prop. The stage does the component lookup on the client side
// of the line.
//
// `overlay-slate.tsx` imports BACK from this module (`OVERLAY_THEMES` +
// `defaultThemeFor`, to composite the sport's own scorebug under §4a's slate).
// That makes this pair an ES-module cycle, deliberately and safely: both of
// slate's references are read INSIDE its component body, never at module
// scope, so by the time either runs both modules are fully evaluated — and the
// alternative (slate picking between `OverlayBar`/`OverlayBug` itself) would
// be a SECOND id→component map, which is exactly the one-authority property
// this file exists to hold. Nothing here may move to a module-scope read of a
// slate export without breaking that.
import type { ComponentType } from "react";
import type { OverlayModel, OverlayMsg } from "@/lib/overlay-model";
import { OverlayBar } from "./overlay-bar";
import { OverlayBug } from "./overlay-bug";
import { OverlaySlate } from "./overlay-slate";

/**
 * What EVERY theme receives. Widened past `{model, tick}` in the Task 5e fix
 * round, when theme C shipped five orphaned `public.overlay.slate.*` keys
 * because a theme component had no way to resolve a dictionary key or to know
 * its sport.
 *
 * The rejected alternative was putting slate's strings on `OverlayModel`.
 * `overlay-model.ts` does not import this file and must not (see this module's
 * own header): the projection is theme-agnostic, "which is what lets eleven
 * sports and N themes meet in one model", and teaching it `overlay.slate.*`
 * would spend exactly that property to serve one theme. Widening HERE serves
 * every future theme instead, at the cost of two props the two themes that do
 * not need them simply ignore.
 *
 * `msg` is the SAME resolver `overlayModel` receives (`OverlayModelInput.msg`,
 * built once in `overlay-stage.tsx` over the stage's own `dict`) — one
 * dictionary channel for the projection and the themes, never two.
 */
export interface OverlayThemeProps {
  model: OverlayModel;
  /** [home, away] — the ONE `big` that just changed (the stage's 300ms score
   *  tick), so a theme can restart its own animation. */
  tick: [boolean, boolean];
  msg: OverlayMsg;
  /** The fixture's `sport_key`. A theme that composites another theme resolves
   *  it through `defaultThemeFor` below; the PALETTE still arrives as CSS
   *  custom properties the stage sets on the ancestor `.ovl-canvas`, never
   *  through this prop. */
  sportKey: string;
}

/** Every theme id the overlay can serve. Declared as an explicit union rather
 *  than derived with `keyof typeof OVERLAY_THEMES`, for two reasons: the page,
 *  the stage's props and the panel's state all need to NAME this type without
 *  importing the registry's value graph, and an explicit union makes a typo'd
 *  registry key a compile error instead of silently widening `ThemeId`. */
export type ThemeId = "bar" | "bug" | "slate";

export interface OverlayThemeDef {
  id: ThemeId;
  /** `ui` namespace, e.g. `stream.tab.bar`. The panel renders it through
   *  `useMsg` in all four locales; the dictionary coverage test finds it here
   *  because `components/overlay` is one of its SCAN_DIRS. Never English. */
  labelKey: string;
  component: ComponentType<OverlayThemeProps>;
  /** `"all"`, or the exact `sport_key` values this theme is designed for. A
   *  theme is offered in the console and accepted by the route only where this
   *  says so — one filter, so the two cannot disagree. */
  sports: "all" | readonly string[];
}

export const OVERLAY_THEMES: Record<ThemeId, OverlayThemeDef> = {
  bar: { id: "bar", labelKey: "stream.tab.bar", component: OverlayBar, sports: "all" },
  bug: { id: "bug", labelKey: "stream.tab.bug", component: OverlayBug, sports: "all" },
  slate: { id: "slate", labelKey: "stream.tab.slate", component: OverlaySlate, sports: "all" },
};

/** Which theme a sport OPENS on. Unchanged from decision 1 — cricket's chase
 *  and two-innings score want the lower third, a set or period score wants the
 *  tile — but it is one named function now, not a boolean inside the resolver,
 *  so a future per-sport default is one line here.
 *
 *  SECOND READER since the Task 5e fix round: `overlay-slate.tsx` calls this to
 *  decide WHICH scorebug it composites on top of the slate (§4a: "the SELECTED
 *  theme (§3 bar or §4 bug) renders ON TOP"). Two consequences. It must never
 *  return a theme that itself composites — returning `"slate"` here would
 *  recurse forever — which `overlay-stage-theme-props.test.ts` pins over all
 *  eleven sports. And moving a sport's default moves what its slate shows,
 *  which is the point: that is one edit, not two. */
export function defaultThemeFor(sportKey: string): ThemeId {
  return sportKey === "cricket" ? "bar" : "bug";
}

/**
 * Which SCOREBUG the moment slab attaches to (W2 Task 4).
 *
 * Not the same question as `?style=`, and that difference was a live bug:
 * `slate` is a theme in its own right but it paints no scorebug — it
 * COMPOSITES one, `defaultThemeFor(sportKey)`, on top of itself (§4a). A slab
 * placed from `props.style` alone therefore took the BAR's geometry under
 * `?style=slate` while the bug was the thing actually on screen — wrong for
 * ten of the eleven sports, and right for cricket only by accident.
 *
 * Caught by reading the overlay contact sheet, which shows three themes; the
 * code had been written against two.
 */
export function slabPlacementFor(style: ThemeId, sportKey: string): "bar" | "bug" {
  const scorebug = style === "slate" ? defaultThemeFor(sportKey) : style;
  return scorebug === "bug" ? "bug" : "bar";
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
