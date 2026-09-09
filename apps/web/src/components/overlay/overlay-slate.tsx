"use client";
// Theme C — the slate (_THEMES.md §4a). Full-bleed opaque ground + a centred
// headline/line, with the selected scorebug composited ON TOP at its own
// inset, unchanged in every value ("Slate is a ground plus a headline, not a
// replacement for the bar/bug").
//
// THREE GAPS THIS FILE CANNOT CLOSE FROM `{model, tick}` ALONE. Every one is
// a real registry-boundary limit (theme-registry.ts's own "one entry plus one
// component, route/panel/projection never touched again" claim), not worked
// around with a DOM read or an invented value — recorded here, and in the
// task report, rather than silently patched over:
//
//  1. NO msg/dict/locale CHANNEL. `OverlayThemeDef.component` receives only
//     `{model, tick}` (theme-registry.ts) and `overlay-stage.tsx` renders
//     `<Theme model={model} tick={tick} />` — no third prop. The root
//     layout's `<html lang="en">` is also a static literal (`app/layout.tsx`),
//     so there is no reachable locale signal anywhere on this route either.
//     §4a's five new `public.overlay.slate.*` keys (three headlines plus the
//     warming/signal-lost line copy) are added in all four locales (the
//     brief's own unconditional requirement) but are NOT referenced here:
//     nothing in this file can resolve them. The headline/line below render
//     the closest ALREADY-RESOLVED, correctly-localized text `OverlayModel`
//     carries instead: `model.header.context` (not the sheet's literal
//     "STARTING SOON" / "MATCH ENDED") for the headline, and `model.result`
//     for the ended line — which IS §4a's exact ask ("resultMsg's full
//     sentence … from the same producer, never a second one"), so that one
//     pairing has zero deviation. The real fix is `overlay-stage.tsx`
//     threading `msg`/`dict` through to the theme, or `overlay-model.ts`
//     resolving the slate keys onto `OverlayModel` the way it already
//     resolves `header.context`/`result` — both forbidden files this round.
//  2. NO sportKey. §4a's "the SELECTED theme (§3 bar or §4 bug) renders ON
//     TOP" reads as `defaultThemeFor(sportKey)` (bar for cricket, bug for
//     the other ten) — the registry's own existing per-sport default. Theme
//     components never receive `sportKey` (palette reaches them only via CSS
//     custom properties `overlay-stage.tsx` sets on the ancestor
//     `.ovl-canvas`, never as a prop), so this file cannot reproduce that
//     split and always composites `OverlayBug`. Correct for ten of eleven
//     sports; cricket gets the corner bug instead of its own bar under
//     `?style=slate`.
//  3. NO video-element seam (spec §7.5, B3). "Signal lost" is a real §4a
//     state but is driven entirely by the relay page's `<video>` events
//     (`stalled > 8s`), which `OverlayModel` carries no field for at all —
//     it is a live A/V health signal, not fixture data. The brief is
//     explicit that building that seam is out of scope here ("do not build
//     a video element"), so `slateStateOf` below is TOTAL over the three
//     states `?style=slate` can actually reach — warming, ended, live — and
//     never produces "signal lost".
import { useEffect, useRef, useState } from "react";
import type { OverlayModel } from "@/lib/overlay-model";
import { OverlayBug } from "./overlay-bug";

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

export function OverlaySlate({ model, tick }: { model: OverlayModel; tick: [boolean, boolean] }) {
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

  return (
    <div className="ovl-slate" data-testid="ovl-slate" data-slate-state={state}>
      <span className="ovl-slate-brand ovl-display">seazn</span>
      {state === "live" ? null : (
        <div
          data-testid="ovl-slate-content"
          className={`ovl-slate-content${fading ? " ovl-slate-fading" : ""}`}
        >
          <span data-testid="ovl-slate-headline" className="ovl-slate-headline ovl-display">
            {model.header.context}
          </span>
          {state === "warming" ? (
            <>
              <span data-testid="ovl-slate-line" className="ovl-slate-line">{`${home} · ${away}`}</span>
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
          so `.ovl-bug`'s own absolute inset resolves to the SAME screen
          position it would standalone. Always `OverlayBug`, per gap 2 above. */}
      <OverlayBug model={model} tick={tick} />
    </div>
  );
}
