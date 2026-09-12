"use client";
// Theme C — the slate (_THEMES.md §4a). Full-bleed opaque ground + a centred
// headline/line, with the selected scorebug composited ON TOP at its own
// inset, unchanged in every value ("Slate is a ground plus a headline, not a
// replacement for the bar/bug").
//
// Task 5e shipped with THREE gaps, because `OverlayThemeDef.component` took
// only `{model, tick}`. Two of them were a registry-boundary limit and are now
// CLOSED by widening that contract (`OverlayThemeProps`, theme-registry.ts) —
// which is the fix that serves every future theme, rather than teaching the
// theme-agnostic `OverlayModel` about one theme's keys. The third is real and
// stays recorded:
//
//  1. CLOSED — the dictionary channel. `msg` is now a theme prop, threaded by
//     `overlay-stage.tsx` from the SAME resolver `overlayModel` receives (one
//     channel, not two). §4a's `public.overlay.slate.*` keys resolve here, so
//     the headline is the sheet's own literal copy in the reader's locale
//     rather than `model.header.context` standing in for it. The ended LINE
//     is still `model.result` — that was never a gap, it is §4a's exact ask
//     ("resultMsg's full sentence … from the same producer, never a second
//     one").
//  2. CLOSED — the sport. `sportKey` is a theme prop, so §4a's "the SELECTED
//     theme (§3 bar or §4 bug) renders ON TOP" resolves through the
//     registry's own `defaultThemeFor` — cricket composites the BAR, the
//     other ten the bug. Previously hardcoded to `OverlayBug`, which was
//     wrong for cricket.
//  3. OPEN, and out of scope by ruling — NO video-element seam (spec §7.5,
//     B3). "Signal lost" is a real §4a state but is driven entirely by the
//     relay page's `<video>` events (`stalled > 8s`), which `OverlayModel`
//     carries no field for at all — it is a live A/V health signal, not
//     fixture data. So `slateStateOf` below is TOTAL over the three states
//     `?style=slate` can actually reach — warming, ended, live — and never
//     produces "signal lost". Its two dictionary keys
//     (`overlay.slate.signalLost*`) therefore stay unreferenced until B3
//     lands; that is the one thing here still waiting on another wave, and
//     `overlay-slate.test.tsx` asserts they exist in all four locales so they
//     cannot rot in the meantime.
import { useEffect, useRef, useState } from "react";
import type { OverlayModel } from "@/lib/overlay-model";
// The registry, imported back (this pair is a deliberate ES-module cycle —
// see theme-registry.ts's header). BOTH references are read inside the
// component body below, never at module scope: `OVERLAY_THEMES` is a `const`
// and a module-scope read during the cycle would hit its TDZ.
import { OVERLAY_THEMES, defaultThemeFor, type OverlayThemeProps } from "./theme-registry";

/** The state `?style=slate` can derive from `OverlayModel` alone (gap 3
 *  above — "signal lost" is not reachable here, so it is not a member).
 *  "live" is not one of §4a's three named states; the sheet defines no
 *  headline/line/indicator for ordinary live play under slate, so that
 *  state renders ground + brand + scorebug only, never an invented fourth
 *  headline. */
export type SlateState = "warming" | "ended" | "live";

/** `_THEMES.md` §4a's own predicate, restated: `decided`/`voided` together
 *  cover every ended case (a plain decision, a void carrying a verdict, and
 *  a void with none — `overlay-model.ts`'s own three cases collapse to one
 *  boolean pair here because §4a's ended row does not branch on which). */
export function slateStateOf(model: OverlayModel): SlateState {
  if (model.decided || model.voided) return "ended";
  if (!model.live) return "warming";
  return "live";
}

/** §4a's headline key per state. `"live"` has none — the sheet defines no
 *  headline for ordinary live play under slate, and `.ovl-slate-content` does
 *  not render at all in that state. Keys are LITERALS in this table, not
 *  built by concatenation, so `overlay-dict-coverage.test.ts`'s source scan
 *  finds them. */
const HEADLINE_KEY: Record<Exclude<SlateState, "live">, string> = {
  warming: "overlay.slate.warmingHeadlineVs",
  ended: "overlay.slate.endedHeadline",
};

export function OverlaySlate({ model, tick, msg, sportKey }: OverlayThemeProps) {
  const state = slateStateOf(model);

  // Motion (_THEMES.md §6): none on mount, a state SWAP is a 250ms opacity
  // cross-fade, nothing else moves. Self-contained — gap 1's sibling problem:
  // `overlay-stage.tsx` cannot be edited to add a shared cross-fade helper,
  // so this mirrors its own score-tick machinery (ref + effect + timeout)
  // rather than reaching for it.
  const previousStateRef = useRef<SlateState | undefined>(undefined);
  const [fading, setFading] = useState(false);
  useEffect(() => {
    const previous = previousStateRef.current;
    previousStateRef.current = state;
    if (previous === undefined || previous === state) return; // never on mount, never on a same-state re-render
    setFading(true);
    const timer = setTimeout(() => setFading(false), 250);
    return () => clearTimeout(timer);
  }, [state]);

  const home = model.sides[0].name;
  const away = model.sides[1].name;

  // §4a: "the SELECTED theme (§3 bar or §4 bug) renders ON TOP" — resolved
  // through the registry's OWN per-sport default, so cricket composites its
  // lower third and the other ten their corner tile. One authority: this is
  // the same function `resolveTheme` falls back to, not a second table.
  // `defaultThemeFor` never returns `"slate"` (pinned over all eleven sports
  // in overlay-stage-theme-props.test.tsx), so this cannot recurse.
  const Scorebug = OVERLAY_THEMES[defaultThemeFor(sportKey)].component;

  return (
    <div className="ovl-slate" data-testid="ovl-slate" data-slate-state={state}>
      {/* Fix round 5, I5 — the third of the three hardcoded wordmarks, now the
          dictionary's own `overlay.brand`. */}
      <span className="ovl-slate-brand ovl-display">{msg("overlay.brand")}</span>
      {state === "live" ? null : (
        <div
          data-testid="ovl-slate-content"
          className={`ovl-slate-content${fading ? " ovl-slate-fading" : ""}`}
        >
          {/* §4a: "upper case as written in the dictionary" — the four
              dictionaries carry the upper-case form (asserted in
              overlay-slate.test.tsx), so nothing here upper-cases at render
              time. A `.toUpperCase()` would also be wrong for a locale whose
              casing rules differ from the browser's default. */}
          <span data-testid="ovl-slate-headline" className="ovl-slate-headline ovl-display">
            {state === "warming"
              ? msg(HEADLINE_KEY.warming, { home, away })
              : msg(HEADLINE_KEY.ended)}
          </span>
          {state === "warming" ? (
            <>
              {/* A1 (2026-09-12): names are the headline; line is toss-pending + start. */}
              <span data-testid="ovl-slate-line" className="ovl-slate-line">
                {msg("overlay.slate.warmingLineTossPending", { start: model.header.context })}
              </span>
              <span data-testid="ovl-slate-indicator-warming" className="ovl-slate-warming-dots">
                <span />
                <span />
                <span />
              </span>
            </>
          ) : model.result ? (
            <span data-testid="ovl-slate-line" className="ovl-slate-line">
              {model.result}
            </span>
          ) : null}
        </div>
      )}
      {/* §4a: "the SELECTED theme … renders ON TOP of the slate, at its own
          inset, unchanged in every value" — nested directly inside `.ovl-slate`
          (whose box is pixel-identical to `.ovl-canvas`'s, see globals.css),
          so the scorebug's own absolute inset resolves to the SAME screen
          position it would standalone. Every prop is passed straight through,
          `msg`/`sportKey` included, so the composited theme is indistinguishable
          from the same theme served directly under `?style=bar`/`?style=bug`. */}
      <Scorebug model={model} tick={tick} msg={msg} sportKey={sportKey} />
    </div>
  );
}
