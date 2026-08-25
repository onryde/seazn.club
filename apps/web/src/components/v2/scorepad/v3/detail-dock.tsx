"use client";
// Detail Dock — R1 chassis (Task 7). The tap-first flow's ONE enrichment
// surface: a tap on TileGrid (./tile-grid.tsx) commits its event
// IMMEDIATELY and durably (queue.ts's `enqueueHeld`, Task 4) — this
// component is what appears for the ~6s HOLD_MS window afterward, offering
// OPTIONAL chips (scorer, assist, boundary type, card colour…) that mutate
// the still-unsent payload before it drains. It never asks for anything the
// payload REQUIRES — only enrichment — and it never blocks: dismissing
// early sends immediately (`releaseHeld`), exactly the same outcome as
// letting the window expire on its own (queue.ts's own release tick fires
// the identical `onDue` either way — see that file's header).
//
// SPLIT (matches scorebug.tsx/assertScorebugSpec and
// tile-grid.tsx/tilesForPhase's own convention): the testable logic lives
// in the pure-ish `dockController` below, never in `DetailDock`'s own JSX —
// apps/web vitest is environment:"node", no jsdom (task-7-brief.md).
//
// RENDERER DESIGN (frontend-design pass, R1/Task 7). Two visual worlds
// already exist in this wave: the Scorebug's stadium-night LCD tile (Task
// 5, ./scorebug.tsx — bg-night, lime-400 digits, an always-on AUTHORITATIVE
// readout) and TileGrid's daylight control surface (Task 6, ./tile-grid.tsx
// — white/slate tiles, violet-600 primary; "a tile is a control, never a
// readout"). The Dock belongs to neither outright: it is a CONSEQUENCE of a
// tap on the daylight control surface, not a second readout, so it never
// borrows .app-display or the night background — but a plain white popover
// would send exactly the wrong signal for something optional and about to
// vanish in six seconds. Resolution: a warm cream surface (bg-cream — the
// SAME --mk-cream token the night tile prints ITS text in, repurposed here
// as a fill, a literal bridge colour between the two worlds) carrying the
// Scorebug's own `rounded-2xl border-t-2 border-lime-400` signature
// verbatim, so the Dock reads as "the thing that just happened on the
// readout, given a moment to breathe" rather than a disconnected system
// dialog. The one signature element: a lime depletion bar along the top
// edge that drains from full width to zero over the ACTUAL remaining hold
// window — a pure CSS width transition, no JS animation loop, respecting
// prefers-reduced-motion — the same --mk-live/"ticking" language already
// used for the live-match dot elsewhere in this app (nav.tsx's
// .app-gantry, scorebug.tsx's own live dot), applied here to visualise
// "this is closing" instead of "this is live". Selected chips fill
// violet-600 — TileGrid's own primary accent, reused deliberately: a
// selected chip and a primary tile are the same weight of "the chosen
// thing". Unselected chips mirror TileGrid's "standard" tile treatment
// (white, slate-200 border) sized to a 44px rounded-full pill — this exact
// product's OWN existing chip shape (attribution-picker.tsx's
// `chipClass`), not an invented one. Typography stays off .app-display for
// the same reason tile-grid.tsx gives: a chip is a control, never a
// readout.
import { useEffect, useReducer, useRef, useState } from "react";
import type { DockChip, DockSpec } from "./types";
import { mutateHeld, releaseHeld } from "../queue";
import type { QueueStore } from "../queue-store";

/**
 * The narrow surface `dockController` needs from the queue store —
 * PAYLOAD-level, not the whole `PendingEvent` queue.ts's own `mutateHeld`
 * operates on. This is what lets a `DockChip.mutate` (types.ts:
 * `(payload) => payload`) be handed to `store.mutateHeld` COMPLETELY
 * UNWRAPPED — no per-call adapter at the tap site, matching the brief's own
 * acceptance criterion verbatim ("store.mutateHeld(heldId, chip.mutate)").
 * `makeDockStore` below is the ONE place this file bridges to queue.ts's
 * real, PendingEvent-level primitives (Task 4) — a controller test can mock
 * this interface directly with two `vi.fn()`s and never construct a
 * QueueStore/PendingEvent at all (__tests__/dock.test.ts's own split).
 */
export interface DockStore {
  /** Same contract as queue.ts's `mutateHeld`: resolves false — a no-op —
   *  if `id` no longer names a currently-held entry (already released,
   *  dropped, or its window already closed); never throws. */
  mutateHeld: (id: string, fn: (payload: Record<string, unknown>) => Record<string, unknown>) => Promise<boolean>;
  /** Same contract as queue.ts's `releaseHeld`: a no-op if `id` no longer
   *  names a currently-held entry. */
  releaseHeld: (id: string) => Promise<void>;
}

/**
 * Production adapter: wraps a real `QueueStore` (queue-store.ts) into the
 * payload-level `DockStore` shape above, via queue.ts's own `mutateHeld`/
 * `releaseHeld` (Task 4) — the ONLY place in this file that touches the raw
 * `PendingEvent` shape. `fn` (a `DockChip.mutate`) only ever sees/returns
 * `payload`; every other `PendingEvent` field (type, expectedSeq, attempts,
 * …) passes through untouched, proved directly in
 * __tests__/dock.test.ts's own `makeDockStore` block.
 */
export function makeDockStore(store: QueueStore): DockStore {
  return {
    mutateHeld: (id, fn) =>
      mutateHeld(store, id, (event) => ({ ...event, payload: fn(event.payload as Record<string, unknown>) })),
    releaseHeld: (id) => releaseHeld(store, id),
  };
}

export interface DockChipView {
  chip: DockChip;
  selected: boolean;
}

export interface DockController {
  /** `spec.title`, verbatim (types.ts gives it no "i18n key" comment —
   *  same pre-resolved-string convention as ScorebugSpec.context) — the
   *  dock's ONE visible title (controller ruling, fix round 1). The
   *  chassis-fixed `pad.dock.title` copy ("Add detail — optional", Task 3)
   *  is the DEFAULT a skin may point this at, not a second line — it earns
   *  a place in `DetailDock`'s render only as the surrounding group's
   *  accessible name. */
  readonly title: string;
  /** Replace the spec this controller reads WITHOUT disturbing the selection
   *  set, for a skin whose dock depends on the held payload (football's goal
   *  dock: scorer, then assist). `DetailDock` rebuilds the controller only when
   *  `heldId` changes, so without this a new `spec` prop for the SAME held
   *  entry was silently ignored and the dock froze on its first step. */
  setSpec(next: DockSpec): void;
  /** Live view of every chip + its selection state — a GETTER, not a
   *  snapshot, so a caller re-reading this after `tapChip` resolves sees
   *  the update without a fresh `dockController(...)` call, which would
   *  also silently reset every OTHER chip's own selection back to
   *  unselected. */
  readonly chips: DockChipView[];
  /**
   * Apply `chipId`'s own `mutate` to the held payload — EXACTLY ONCE ever,
   * for the life of this controller instance. The id is claimed
   * SYNCHRONOUSLY, before the store call, so two taps fired back-to-back
   * without awaiting the first (a real double-tap, or two bound handlers
   * firing for one press) cannot both pass the guard and both apply
   * `chip.mutate` — see __tests__/dock.test.ts's own "FIX ROUND 1 finding
   * 2" race test. If the store then reports the mutation could NOT apply
   * (a `false` result — the hold window already closed under us), the
   * claim is rolled back and the chip reads unselected again, since
   * showing "selected" for a mutation that never landed would mislead the
   * scorer. A tap on an ALREADY-selected (or still in-flight) chip, or an
   * unknown `chipId`, is a no-op.
   *
   * RULING on the second case (the brief leaves this open): DockChip
   * declares no inverse/revert of `mutate` (types.ts), and reconstructing
   * one by snapshotting "the payload right before this chip's own mutate"
   * is UNSOUND the instant a second, unrelated chip gets selected
   * afterward — reverting chip A would also discard chip B's mutation,
   * corrupting a payload neither chip's own author asked to touch. "At
   * most once, never automatically undone" is the only behaviour that
   * cannot corrupt the payload however many OTHER chips get tapped in
   * between — see __tests__/dock.test.ts's own "second tap" block.
   */
  tapChip(chipId: string): Promise<void>;
  /** Release the held entry now — "send now". Delegates to the store's
   *  `releaseHeld`, itself idempotent (queue.ts), so a repeat call (e.g. a
   *  double-tap on the dismiss control) is harmless. */
  dismiss(): Promise<void>;
}

/**
 * `null` in, `null` out — no dock rendered (a skin's own `dock(eventType,
 * view)` returns `null` for an event with nothing worth enriching). For a
 * real spec, returns a controller instance whose `chips`/selection state is
 * privately held in closure — NOT reconstructed on every call, so a caller
 * (DetailDock, below) must keep ONE instance alive across a tap's whole
 * lifetime rather than calling this fresh on every render.
 */
export function dockController(spec: DockSpec | null, heldId: string, store: DockStore): DockController | null {
  if (spec === null) return null;
  // R3 review round 4 — the spec is LIVE, not a snapshot.
  //
  // This closed over the `spec` it was built with, and `DetailDock` rebuilds
  // the controller only when `heldId` changes. A skin whose dock depends on the
  // held PAYLOAD — football's goal dock asks for the scorer, then the assist —
  // therefore kept rendering its first step forever: the payload advanced, a
  // new spec arrived as a prop, and both were ignored. The two-step split was
  // inert in the running app while its unit tests passed, because those call
  // `buildDock` directly and never mount anything.
  //
  // `setSpec` swaps the spec WITHOUT resetting `selectedIds`: the selection is
  // per held entry, and the entry has not changed — only the question being
  // asked about it has.
  let current: DockSpec = spec;
  const selectedIds = new Set<string>();
  return {
    get title(): string {
      return current.title;
    },
    get chips(): DockChipView[] {
      return current.chips.map((chip) => ({ chip, selected: selectedIds.has(chip.id) }));
    },
    setSpec(next: DockSpec): void {
      current = next;
    },
    async tapChip(chipId: string): Promise<void> {
      if (selectedIds.has(chipId)) return; // second tap (or a still in-flight one) on this chip: no-op, see this interface's own doc
      const chip = current.chips.find((c) => c.id === chipId);
      if (chip === undefined) return; // unknown chip id: nothing to apply
      // FIX ROUND 1 finding 2: claim the id SYNCHRONOUSLY, before the
      // `await` below — not only once the store confirms it. Two taps
      // fired back-to-back without awaiting the first (a real double-tap,
      // or two bound handlers firing for one press) both run their
      // synchronous prefix — including this `selectedIds.has` check —
      // before either can resolve, so marking selection only AFTER the
      // await left a window where both passed the guard and both called
      // `store.mutateHeld`, double-applying `chip.mutate`. Claiming here
      // closes it: the second call's own `selectedIds.has` check now sees
      // the id already claimed and returns immediately, no store call.
      selectedIds.add(chipId);
      const applied = await store.mutateHeld(heldId, chip.mutate);
      if (!applied) selectedIds.delete(chipId); // roll back: the mutation never actually landed
    },
    dismiss(): Promise<void> {
      return store.releaseHeld(heldId);
    },
  };
}

export interface DetailDockProps {
  /** The just-committed event's own dock spec — a skin's `dock(eventType,
   *  view)` (types.ts). `null` renders nothing, mirroring `dockController`'s
   *  own contract — a caller can pass this straight through with no
   *  separate presence check. */
  spec: DockSpec | null;
  /** The held entry's `idempotencyKey` (queue.ts `enqueueHeld`'s own return
   *  value) — identifies WHICH queued event this dock's chips mutate. */
  heldId: string;
  /** Payload-level bridge to the queue store — build via `makeDockStore`
   *  above, around whatever `QueueStore` backs this pad. Should be a
   *  STABLE reference across renders (e.g. memoized by the caller,
   *  mirroring how use-pad-pipeline.ts memoizes its own store on
   *  `dbName`): this component keys its internal controller's lifetime on
   *  `heldId` alone, never on `store`'s identity, so an unstable `store`
   *  reference costs nothing beyond the very first render for a given
   *  `heldId` — see the render-phase reset below. */
  store: DockStore;
  /** Epoch ms when the hold window closes on its own — the SAME value as
   *  the held `PendingEvent.heldUntil` (types.ts; queue.ts's `HOLD_MS`
   *  applied at `enqueueHeld` time). Drives ONLY the visual countdown/
   *  depletion bar; the actual expiry and send are queue.ts's own release
   *  tick, entirely independent of whether this component is even
   *  mounted. */
  heldUntil: number;
  /** Same MsgFn-shaped lookup scorebug.tsx's and tile-grid.tsx's own `t`
   *  prop take (useMsg()/msgFor() both hand callers this shape) — loosely
   *  typed (not the stricter MessageKey-only MsgFn) because
   *  DockChip.label/DockSpec.title are plain `string` (types.ts —
   *  skin-authored i18n keys, not literal MessageKeys), same reasoning as
   *  tile-grid.tsx's own `t` prop. */
  t: (key: string, vars?: Record<string, string | number>) => string;
  /** Test-only clock override. Defaults to `Date.now`. */
  now?: () => number;
}

/**
 * Renders a DockSpec: its ONE title (`controller.title` — see
 * `DockController.title`'s own doc for the fix-round-1 ruling on why this
 * is the only visible heading), a row of 44px chip buttons, a live "clears
 * in Ns" countdown (`pad.dock.clears`), and an explicit dismiss control
 * (`pad.dock.dismiss` — "Send now": minted in fix round 1, since the
 * button's real effect is an immediate send, which the previously-reused
 * `disc.pad.dismiss` — a consequence-free banner hide elsewhere in this
 * app — misdescribed). `pad.dock.title` ("Add detail — optional") is used
 * ONLY as the surrounding group's `aria-label`, never rendered as visible
 * text.
 *
 * The controller instance is reset ONLY when `heldId` changes (a
 * render-phase state adjustment — React's own sanctioned pattern for this,
 * already used elsewhere in this tree: use-pad-pipeline.ts's `foldedState`
 * useMemo + its render-phase `setLastRejection`). Calling `dockController`
 * fresh on every render would silently wipe out in-progress chip
 * selections on every countdown tick.
 */
/**
 * Bring the just-opened dock ON SCREEN — R3/F (F4).
 *
 * The dock renders after the tile grid (pad-host.tsx), and the grid is tall
 * enough at EVERY width that the dock lands below the fold. Measured against
 * the real prod server on football's nine-tile board, tapping Goal · Home:
 * 88px of a 213px dock visible at 1280x720, MINUS 16 at 768x1024 (entirely
 * below the fold, without the scorer even having to scroll to reach the tile),
 * 12px of a 369px dock at 320x568. A soft-commit window the scorer cannot see
 * always expires, which silently defeats the "tap commits, dock enriches"
 * model the whole v3 design rests on.
 *
 * `block: "nearest"` and nothing else — the smallest fix that achieves it:
 *
 *  - it is a NO-OP when the element is already fully visible, so a width where
 *    the dock already fits never moves;
 *  - it scrolls the MINIMUM otherwise, so the top of the board stays on screen
 *    above the dock rather than the whole grid being pushed away;
 *  - the layout itself is untouched. A sticky/fixed bottom sheet was the other
 *    candidate and was rejected: at 320 a 369px dock pinned to the bottom
 *    COVERS the entire board, and an overlaying dock can intercept a tap meant
 *    for a tile — which would also break `apps/web/e2e/**` specs this task is
 *    barred from editing.
 *
 * No `behavior: "smooth"`: a scroll in flight makes every element the specs
 * click "unstable" for Playwright's actionability check, and an instant reveal
 * is also the right answer for `prefers-reduced-motion`, which removes the
 * branch entirely.
 *
 * Takes its node as a parameter and returns whether it scrolled so the
 * contract is assertable in a node environment (`__tests__/dock.test.ts`);
 * the WIRING below is proved in a browser, because it cannot be proved here.
 * Total on a missing node and a node without the method — this runs inside a
 * commit, where a throw would blank the pad.
 */
export function revealDock(node: { scrollIntoView?: (options: ScrollIntoViewOptions) => void } | null): boolean {
  if (node === null || typeof node.scrollIntoView !== "function") return false;
  node.scrollIntoView({ block: "nearest", inline: "nearest" });
  return true;
}

export function DetailDock({ spec, heldId, store, heldUntil, t, now = Date.now }: DetailDockProps) {
  // Render-phase state reset (React's own sanctioned "adjust state during
  // render" recipe — https://react.dev/reference/react/useState#storing-
  // information-from-previous-renders — TWO useState calls, deliberately
  // NOT a ref: this repo's react-hooks/refs lint rule forbids reading OR
  // writing a ref's `.current` during render, stricter than plain React
  // itself, so the "previous heldId" comparison below must be state too).
  // Bundles every piece of per-held-entry state that must reset together
  // exactly when `heldId` changes to a genuinely NEW held entry — never on
  // an ordinary re-render (a countdown tick, a parent re-render with the
  // same heldId) — into ONE guarded block, so nothing can reset out of
  // step with anything else.
  const [controller, setController] = useState<DockController | null>(() => dockController(spec, heldId, store));
  const [remainingS, setRemainingS] = useState(() => Math.max(0, Math.ceil((heldUntil - now()) / 1000)));
  const [holdMsAtMount, setHoldMsAtMount] = useState(() => Math.max(0, heldUntil - now()));
  const [depleted, setDepleted] = useState(false);
  const [controllerHeldId, setControllerHeldId] = useState(heldId);
  if (controllerHeldId !== heldId) {
    setControllerHeldId(heldId);
    setController(dockController(spec, heldId, store));
    setRemainingS(Math.max(0, Math.ceil((heldUntil - now()) / 1000)));
    setHoldMsAtMount(Math.max(0, heldUntil - now()));
    setDepleted(false);
  }

  // The spec is a PROP and changes for the same held entry whenever the skin's
  // dock depends on the payload. Push it into the controller before render
  // reads `chips`/`title`; assigning to a plain object (not React state) takes
  // effect on THIS frame, where an effect would leave one stale frame on screen
  // inside a ~6s window.
  if (controller !== null && spec !== null) controller.setSpec(spec);

  const [, bump] = useReducer((n: number) => n + 1, 0);
  const mountedRef = useRef(true);
  const rootRef = useRef<HTMLDivElement | null>(null);
  useEffect(
    () => () => {
      mountedRef.current = false;
    },
    [],
  );

  // Subscription-only (react-hooks/set-state-in-effect): every setState
  // call below runs inside a DEFERRED callback (a timer/rAF tick), never
  // synchronously as part of the effect body itself — the initial value
  // and any heldId-driven reset are both already handled by the
  // render-phase block above, so this effect's only job is to keep ticking
  // for as long as the SAME controller (held entry) is current.
  useEffect(() => {
    if (controller === null) return;
    const raf = requestAnimationFrame(() => setDepleted(true));
    const tick = setInterval(() => {
      setRemainingS(Math.max(0, Math.ceil((heldUntil - now()) / 1000)));
    }, 250);
    return () => {
      cancelAnimationFrame(raf);
      clearInterval(tick);
    };
    // heldUntil/now intentionally excluded: this effect re-arms only when
    // the CONTROLLER identity changes (i.e. a genuinely new held entry —
    // see the render-phase reset above), not on every heldUntil/now
    // reference a caller happens to pass.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [controller]);

  // R3/F (F4) — reveal on OPEN. Keyed on `controller`, the same identity the
  // tick effect above re-arms on: a genuinely new held entry, never a
  // countdown tick or an ordinary parent re-render, so the page is never
  // pulled around while a scorer is reading the dock they already have. See
  // `revealDock` above for the measurements and for why this is a scroll
  // rather than a sticky layout.
  useEffect(() => {
    if (controller === null) return;
    revealDock(rootRef.current);
  }, [controller]);

  if (controller === null) return null;

  const handleTap = (chipId: string) => {
    void controller.tapChip(chipId).then(() => {
      if (mountedRef.current) bump();
    });
  };
  const handleDismiss = () => {
    void controller.dismiss();
  };

  const prefersReducedMotion =
    typeof window !== "undefined" && typeof window.matchMedia === "function"
      ? window.matchMedia("(prefers-reduced-motion: reduce)").matches
      : false;

  return (
    <div
      ref={rootRef}
      role="group"
      aria-label={t("pad.dock.title")}
      className="overflow-hidden rounded-2xl border-t-2 border-lime-400 bg-cream shadow-lg"
    >
      <div
        aria-hidden="true"
        className="h-[3px] bg-lime-400"
        style={{
          width: depleted ? "0%" : "100%",
          transition: prefersReducedMotion ? "none" : `width ${holdMsAtMount}ms linear`,
        }}
      />

      <div className="flex items-start justify-between gap-2 px-4 pt-3">
        <div className="min-w-0">
          {/* FIX ROUND 1 finding 1 (controller ruling): the dock renders
             exactly ONE title — DockSpec.title, skin-supplied. The fixed
             `pad.dock.title` copy ("Add detail — optional") is the DEFAULT a
             skin may point its own title at, not a second visible line; it
             earns a place only as this group's accessible name (below). */}
          <p className="truncate text-sm font-semibold text-slate-800">{controller.title}</p>
        </div>
        <button
          type="button"
          onClick={handleDismiss}
          aria-label={t("pad.dock.dismiss")}
          style={{ minHeight: 44, minWidth: 44 }}
          className="-mr-2 -mt-1 flex shrink-0 items-center justify-center rounded-full text-slate-500 transition-colors hover:bg-slate-900/5 hover:text-slate-700 focus-visible:outline focus-visible:outline-2 focus-visible:outline-lime-400"
        >
          <svg aria-hidden="true" viewBox="0 0 16 16" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth={1.75} strokeLinecap="round">
            <path d="M3 3l10 10M13 3L3 13" />
          </svg>
        </button>
      </div>

      <div className="flex flex-wrap gap-2 px-4 py-3">
        {controller.chips.map(({ chip, selected }) => (
          <button
            key={chip.id}
            type="button"
            aria-pressed={selected}
            // FIX ROUND 1 finding 3 (design call): a selected chip is
            // ALREADY inert to a repeat tap at the controller level
            // (dockController.tapChip: "at most once, never auto-undone")
            // — leaving it a live, hover-reactive button that silently
            // swallows every further tap gave no feedback that anything
            // had changed. Reads as CONFIRMED, not merely disabled: keeps
            // the existing solid violet-600 fill + checkmark (already the
            // "chosen/done" treatment, matching TileGrid's own primary
            // weight) and drops the click/hover affordance rather than
            // inventing a separate greyed-out look. `aria-disabled` (not
            // the native `disabled` attribute) keeps it focusable, so a
            // screen-reader user tabbing through still perceives "this
            // choice was made" instead of the control silently vanishing
            // from the tab order.
            aria-disabled={selected || undefined}
            onClick={selected ? undefined : () => handleTap(chip.id)}
            style={{ minHeight: 44 }}
            // `DockChip.kind` (types.ts): a MODIFIER reads as a tab, a person
            // as the pill they already were. The radius is the only thing that
            // differs — same size, same border, same fill, so nothing about
            // this changes a dock whose chips set no `kind` (cricket's).
            className={`inline-flex min-w-0 max-w-full items-center gap-1.5 border px-4 text-sm font-medium transition-colors ${
              chip.kind === "flag" ? "rounded-lg" : "rounded-full"
            } ${
              selected
                ? "cursor-default border-transparent bg-violet-600 text-white"
                : "border-slate-200 bg-white text-slate-700 hover:bg-slate-50"
            }`}
          >
            {selected && (
              <svg
                aria-hidden="true"
                viewBox="0 0 16 16"
                className="h-3.5 w-3.5 shrink-0"
                fill="none"
                stroke="currentColor"
                strokeWidth={2}
                strokeLinecap="round"
                strokeLinejoin="round"
              >
                <path d="M3.5 8.5l3 3 6-7" />
              </svg>
            )}
            {/* FIX ROUND 1 finding 5: a long localized chip label with no
               natural break point can otherwise force this pill wider than
               its container — the same 320px-overflow defect class
               tile-grid.tsx's own fix round guarded against (`min-w-0` on
               the flex item above + `break-words` here, not `truncate`:
               mirrors that precedent's exact remedy rather than a new one). */}
            {/* R3/football (`DockChip.labelText`, types.ts): a pre-localised
               label WINS over the key. A chip naming a PERSON has no
               dictionary key to resolve — routing a display name through
               `t()` warns on every render and renders right only because the
               runtime hands the key back. Same precedence `TileSpec.
               labelText` already has in tile-grid.tsx: text wins, the key is
               not resolved at all, nothing is concatenated. */}
            <span className="break-words">{chip.labelText ?? t(chip.label)}</span>
          </button>
        ))}
      </div>

      <div className="px-4 pb-3">
        <span className="text-xs font-medium text-slate-600" style={{ fontVariantNumeric: "tabular-nums" }}>
          {t("pad.dock.clears", { s: remainingS })}
        </span>
      </div>
    </div>
  );
}
