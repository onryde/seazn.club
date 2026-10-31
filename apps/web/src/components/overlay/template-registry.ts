// The overlay's template registry (owner answer 18 / Q7, 2026-09-06: "we will have multiple theme per sports so make
// it abstract and use can choose for now apply the default one"; spec 2026-10-15 §4.4 and §4.7, R2007).
//
// ONE authority for which SCOREBUG templates exist, which sports each suits, which one a sport opens on, where each
// one's moment slab attaches, and which box on the canvas each one occupies. Adding a template is ONE entry here plus
// ONE component file — the route, the stage, the gallery and the card layout are never edited for a template again
// (`template-extensibility.test.ts` holds that with a throwaway entry). `overlay-model.ts` does not import this file
// and must not: the projection is template-agnostic, which is what lets eleven sports and N templates meet in one model.
//
// Renamed from `theme-registry.ts` (R2007, decision 1: rename, don't wrap). What did NOT rename, deliberately: the
// component props stay `OverlayThemeProps` (spec §4.7), and the stage's `style` prop and the DOM's `data-style` keep
// their names, because `?style=` is the alias forever (§4.4) and e2e and OBS-facing tests read `data-style`.
//
// 2026-09-12: the warming/ended MATCH CARD is not a template. It is a layer `OverlayStage` mounts above bar/bug (see
// `docs/superpowers/specs/2026-09-12-overlay-match-card-layer-design.md`), and since R2007 it is laid out from the
// template's `sceneCardSafeArea` (`cardRegionFor` below). `?style=slate` is not a key, so it resolves as unknown →
// the sport default (decision 4) with no special case.
//
// NOT a `"use client"` module, deliberately. It imports client components, so it becomes part of the client graph
// where a client component imports it; the SERVER page imports only `resolveTemplate`/`templateParam` and reads `.id`
// off the result, never `.component`, so no component reference crosses the RSC boundary as a prop. The stage does
// the component lookup on the client side of the line.
import type { ComponentType } from "react";
import type { OverlayModel, OverlayMsg } from "@/lib/overlay-model";
import type { SponsorStyle } from "@/lib/sponsor-plan";
import { OverlayBar } from "./overlay-bar";
import { OverlayBug } from "./overlay-bug";

/**
 * What EVERY template receives. Widened past `{model, tick}` in the Task 5e fix round, when the match-card layer
 * shipped `public.overlay.slate.*` keys resolved through the same `msg` channel.
 *
 * `msg` is the SAME resolver `overlayModel` receives (`OverlayModelInput.msg`, built once in `overlay-stage.tsx` over
 * the stage's own `dict`) — one dictionary channel for the projection and the templates, never two.
 */
export interface OverlayThemeProps {
  model: OverlayModel;
  /** [home, away] — the ONE `big` that just changed (the stage's 300ms score
   *  tick), so a template can restart its own animation. */
  tick: [boolean, boolean];
  msg: OverlayMsg;
  /** The fixture's `sport_key`. The PALETTE arrives as CSS custom properties
   *  the stage sets on the ancestor `.ovl-canvas`, never through this prop. */
  sportKey: string;
}

/** Every scorebug template id the overlay can serve. Declared as an explicit union rather than derived with
 *  `keyof typeof OVERLAY_TEMPLATES`, for two reasons: the page, the stage's props and the panel's state all need to
 *  NAME this type without importing the registry's value graph, and an explicit union makes a typo'd registry key a
 *  compile error instead of silently widening `TemplateId`. The match card is not a TemplateId. */
export type TemplateId = "bar" | "bug";

/** A box on the 1920×1080 canvas, in canvas px. */
export interface CanvasBox {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface OverlayTemplateDef<Id extends string = TemplateId> {
  /** Stable. Used in ?template=, stored choices and OBS URLs. Never changes once shipped. */
  id: Id;
  /** `ui` namespace, e.g. `stream.tab.bar`; 4 locales. The panel renders it through `useMsg`; the dictionary coverage
   *  test finds it here because `components/overlay` is one of its SCAN_DIRS. Never English. */
  labelKey: string;
  /** `"all"`, or the exact `sport_key` values this template is designed for. A template is offered in a picker and
   *  accepted by the route only where this says so — one filter, so the two cannot disagree. */
  sports: "all" | readonly string[];
  component: ComponentType<OverlayThemeProps>;
  /** Where the moment slab attaches (`.ovl-moment-slot--<placement>`). Replaces `slabPlacementFor`. */
  slabPlacement: "bar" | "bug";
  /** The box scene and match cards must keep clear. DECLARED from the template's CSS layout rule, never copied from
   *  a measurement (review m1: a measured box passes the e2e's safe-area check by construction). The stage lays every
   *  card out from it (`cardRegionFor`), and the gallery e2e proves the rendered template stays inside it.
   *  `overlay-slab-placement.test.tsx` holds each declaration to the custom properties it was derived from. */
  sceneCardSafeArea: CanvasBox;
  /** R4 S7 (spec 2026-10-27 §3.5): where each sponsor look draws — the lower third (a minor break, 8 s) and the banner
   *  (a major break, 15 s; also the scene carousel's). DECLARED, like the safe area: each box keeps `CARD_CLEARANCE_PX`
   *  from `sceneCardSafeArea`, sits inside the canvas with its bottom ≥ 150 px off the floor (D9), and the banner leaves
   *  the match card a region (`cardRegionBeside`). `sponsor-slots.test.ts` holds every entry to all four. */
  sponsorSlots: Readonly<Record<SponsorStyle, CanvasBox>>;
  /** Kept so stored choices and OBS URLs resolve. Hidden from the picker. */
  retired?: { replacedBy: Id };
}

export type TemplateRegistry<Id extends string = string> = Readonly<Record<Id, OverlayTemplateDef<Id>>>;

export const OVERLAY_TEMPLATES: Readonly<Record<TemplateId, OverlayTemplateDef>> = {
  bar: {
    id: "bar",
    labelKey: "stream.tab.bar",
    sports: "all",
    component: OverlayBar,
    slabPlacement: "bar",
    // `.ovl-bar` is inset left/right 72 and stands `--ovl-bar-main-h` + `--ovl-bar-band-h` tall with its bottom edge
    // `--ovl-bar-bottom` above the canvas floor (globals.css, `.ovl-canvas`): 162 + 126 + 60.
    //   x = 72, width = 1920 − 72 − 72 = 1776
    //   y = 1080 − 162 − 126 − 60 = 732, height = 126 + 60 = 186
    // The band is reserved whether or not it renders (a bar without one is 60 px shorter, still inside the box).
    sceneCardSafeArea: { x: 72, y: 732, width: 1776, height: 186 },
    // Both above the bar, `CARD_CLEARANCE_PX` (24) clear of its box's top edge (732): bottoms at 708.
    //   lower third: the bar's own left inset (72), 1000 wide — the slab's corner, which it never shares (one moment
    //                at a time); 120 tall: an 88 px logo plate and a 48 + 30 px text pair.
    //   banner:      a 560 × 480 panel flush with the card region's right edge (1920 − 96 = 1824), so the match card
    //                keeps the 1144 × 636 strip to its left when the carousel shares a scene with it.
    sponsorSlots: {
      lower_third: { x: 72, y: 588, width: 1000, height: 120 },
      banner: { x: 1264, y: 228, width: 560, height: 480 },
    },
  },
  bug: {
    id: "bug",
    labelKey: "stream.tab.bug",
    sports: "all",
    component: OverlayBug,
    slabPlacement: "bug",
    // `.ovl-bug` sits at `--ovl-bug-left` 60 / `--ovl-bug-top` 54, `--ovl-bug-w` 560 wide (globals.css, `.ovl-canvas`).
    // Its tallest state is header + two side rows + footer — every non-cricket sport; cricket's bug is header + innings
    // strip + ONE hero row + footer, which is shorter:
    //   height = 60 (`--ovl-bug-header-h`) + 2 × 90 (`--ovl-bug-row-h`) + 56 (`--ovl-bug-footer-h`) = 296
    sceneCardSafeArea: { x: 60, y: 54, width: 560, height: 296 },
    // Both on the bug's own left edge (60).
    //   lower third: at the foot of the canvas, its bottom exactly 150 px off the floor (1080 − 150 = 930).
    //   banner:      the bug's width, stacked under it (350 + 24 = 374) — and so outside the card region beside the
    //                bug (x ≥ 644), which a scene's match card keeps whole.
    sponsorSlots: {
      lower_third: { x: 60, y: 810, width: 1000, height: 120 },
      banner: { x: 60, y: 374, width: 560, height: 480 },
    },
  },
};

/** Which template a sport OPENS on (spec §3). Cricket's chase and two-innings score want the lower third; a set or
 *  period score wants the tile. */
export function defaultTemplateFor(sportKey: string): TemplateId {
  return sportKey === "cricket" ? "bar" : "bug";
}

function suits(def: OverlayTemplateDef<string>, sportKey: string): boolean {
  return def.sports === "all" || def.sports.includes(sportKey);
}

/** Registry order; retired and sport-unsuitable entries hidden. The body every picker reads — exported with the
 *  registry injected so a test can hand it a retired or restricted entry, which the shipped registry has none of. */
export function templatesForSportFrom<Id extends string>(
  registry: TemplateRegistry<Id>,
  sportKey: string,
): readonly OverlayTemplateDef<Id>[] {
  return (Object.values(registry) as OverlayTemplateDef<Id>[]).filter(
    (def) => def.retired === undefined && suits(def, sportKey),
  );
}

/** What a picker offers for this fixture, in registry order. */
export function templatesForSport(sportKey: string): readonly OverlayTemplateDef[] {
  return templatesForSportFrom(OVERLAY_TEMPLATES, sportKey);
}

/**
 * Unknown, unsuitable, retired-with-a-dead-chain → `fallback`. Retired → its replacement (≤ registry-size hops). Never
 * throws: the caller is an OBS browser source in the middle of a live broadcast.
 *
 * Exported with the registry injected for the same reason as `templatesForSportFrom`: the shipped registry has no
 * retired and no sport-restricted entry, so those branches are otherwise unreachable and deleting them would go
 * unnoticed. Production callers use `resolveTemplate`.
 */
export function resolveTemplateFrom<Id extends string>(
  registry: TemplateRegistry<Id>,
  requested: string | null | undefined,
  sportKey: string,
  fallback: Id,
): OverlayTemplateDef<Id> {
  // `Object.hasOwn`, not `registry[requested]`: `?template=toString` would otherwise reach a prototype member.
  const lookup = (id: string | null | undefined): OverlayTemplateDef<Id> | undefined =>
    id && Object.hasOwn(registry, id) ? registry[id as Id] : undefined;
  let def = lookup(requested);
  // A retired id walks to its replacement. Bounded by the registry's size, so a cycle (a ↔ b) cannot hang the page:
  // more hops than entries means the chain revisited one, and the request falls back.
  for (let hops = 0; def?.retired !== undefined; hops++) {
    if (hops >= Object.keys(registry).length) return registry[fallback];
    def = lookup(def.retired.replacedBy);
  }
  if (def && suits(def, sportKey)) return def;
  return registry[fallback];
}

/**
 * The one resolver. An unknown, misspelt, sport-unsuitable or dead-chain id falls back to the sport's default; a
 * retired one resolves to its replacement; it NEVER throws.
 */
export function resolveTemplate(requested: string | null | undefined, sportKey: string): OverlayTemplateDef {
  return resolveTemplateFrom(OVERLAY_TEMPLATES, requested, sportKey, defaultTemplateFor(sportKey));
}

/**
 * Decision 2 (R2007): `template` when present and non-empty, else `style` — the alias every OBS URL written before
 * R2007 carries, kept forever (§4.4). One rule, no fall-through chain: an UNKNOWN `template` is still the request, and
 * resolves to the sport default, never to `style`'s value. Array values (a repeated parameter) take the first element.
 */
export function templateParam(q: { template?: string | string[]; style?: string | string[] }): string | undefined {
  const first = (v: string | string[] | undefined): string | undefined => (Array.isArray(v) ? v[0] : v);
  const template = first(q.template);
  if (template !== undefined && template !== "") return template;
  return first(q.style);
}

// ---------------------------------------------------------------------------------------------------------------------
// Step 9b (coordinator decision G2) — cards are laid out from the registry.
//
// The match card used to be centred on the whole canvas with a bottom padding that cleared only the BAR, so on the bug
// it sat under the scorebug (painted over at z-index 3 vs 1). Now the stage asks `cardRegionFor(def.sceneCardSafeArea)`
// for the canvas region a card may use, and a new template's box moves every card with no other edit.
// ---------------------------------------------------------------------------------------------------------------------

const CANVAS_W = 1920;
const CANVAS_H = 1080;

/** The card's frame inset from the canvas edges: the `.ovl-slate-content` padding before R2007 (72px 96px). */
export const CARD_INSET = { top: 72, right: 96, bottom: 72, left: 96 } as const;
/** The gap a card keeps from the template's box: the gap above the bar stack before R2007. */
export const CARD_CLEARANCE_PX = 24;
/** Design rule: a card region narrower than a third of the canvas width is not a card region. */
export const CARD_MIN_W = 640;
/** Design rule: a card region shorter than a third of the canvas height is not a card region. */
export const CARD_MIN_H = 360;

/**
 * The canvas region where scene and match cards are laid out: the largest, by area, of the four inset-canvas strips
 * beside `box` (right, above, left, below; ties in that order), kept `CARD_CLEARANCE_PX` clear of it. `null` when none
 * is at least `CARD_MIN_W × CARD_MIN_H`, in which case no card renders.
 */
export function cardRegionFor(box: CanvasBox): CanvasBox | null {
  const left = CARD_INSET.left;
  const top = CARD_INSET.top;
  const right = CANVAS_W - CARD_INSET.right;
  const bottom = CANVAS_H - CARD_INSET.bottom;
  const strip = (x0: number, y0: number, x1: number, y1: number): CanvasBox => ({
    x: x0,
    y: y0,
    width: x1 - x0,
    height: y1 - y0,
  });
  const candidates: CanvasBox[] = [
    strip(Math.max(left, box.x + box.width + CARD_CLEARANCE_PX), top, right, bottom), // right
    strip(left, top, right, Math.min(bottom, box.y - CARD_CLEARANCE_PX)), // above
    strip(left, top, Math.min(right, box.x - CARD_CLEARANCE_PX), bottom), // left
    strip(left, Math.max(top, box.y + box.height + CARD_CLEARANCE_PX), right, bottom), // below
  ];
  let best: CanvasBox | null = null;
  for (const c of candidates) {
    if (c.width < CARD_MIN_W || c.height < CARD_MIN_H) continue;
    if (best === null || c.width * c.height > best.width * best.height) best = c;
  }
  return best;
}

/**
 * R4 S7: the card region left once a sponsor slot shares the canvas with the match card (the scene carousel's banner on
 * Starting soon / Reconnecting). A slot already `CARD_CLEARANCE_PX` clear of `region` leaves it as it is. Otherwise the
 * largest, by area, of the four strips of `region` beside the slot (left, above, right, below; ties in that order),
 * each kept `CARD_CLEARANCE_PX` clear of it; `null` when none is at least `CARD_MIN_W × CARD_MIN_H` — the stage then
 * mounts no carousel, because the match card outranks it.
 */
export function cardRegionBeside(region: CanvasBox, slot: CanvasBox): CanvasBox | null {
  const g = CARD_CLEARANCE_PX;
  const clear =
    slot.x + slot.width + g <= region.x ||
    region.x + region.width + g <= slot.x ||
    slot.y + slot.height + g <= region.y ||
    region.y + region.height + g <= slot.y;
  if (clear) return region;
  const x0 = region.x;
  const y0 = region.y;
  const x1 = region.x + region.width;
  const y1 = region.y + region.height;
  const strip = (a: number, b: number, c: number, d: number): CanvasBox => ({ x: a, y: b, width: c - a, height: d - b });
  const candidates: CanvasBox[] = [
    strip(x0, y0, Math.min(x1, slot.x - g), y1), // left
    strip(x0, y0, x1, Math.min(y1, slot.y - g)), // above
    strip(Math.max(x0, slot.x + slot.width + g), y0, x1, y1), // right
    strip(x0, Math.max(y0, slot.y + slot.height + g), x1, y1), // below
  ];
  let best: CanvasBox | null = null;
  for (const c of candidates) {
    if (c.width < CARD_MIN_W || c.height < CARD_MIN_H) continue;
    if (best === null || c.width * c.height > best.width * best.height) best = c;
  }
  return best;
}
