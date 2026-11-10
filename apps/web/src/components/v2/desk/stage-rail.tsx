"use client";

// Competition Desk W3 (2026-09-06, task 2): the stage rail. Owner ruling —
// all stage chrome leaves the fixtures sheet. This is the first slice: the
// three stage-header action controls (Generate/Pair next, Complete stage,
// Delete stage), moved verbatim out of stages-panel.tsx's own header render.
//
// Match Day E1 item 1 (owner 2026-11-01): the rail no longer sits BELOW the rows. `stages-panel.tsx` mounts it inside the stage card's
// HEADER: from `md` its sheet is the header's actions group (Generate / Pair next, Unpair, Complete stage, Add match, Delete - the
// `stageActions` rules unchanged, only their place moved), left of the settings buttons; below `md` the trigger rides the header and
// the controls are the same bottom sheet as before. Court tags and the old "To schedule in this stage" footer are the panel's now (the
// first at the card's foot, the second gone: the counts line above the rows says it).
//
// SCF (owner pick, Option A, 2026-11-03): the row holds CONTROLS and nothing else. The Swiss "paired by the system" sentence and the
// "Unpair, then Pair next" line (said beside Unpair through the final round) moved to the stage's legend line (stages-panel.tsx); the fixed
// "Rounds: N" pill is gone once the count cannot change; More and the Pair next ▾ panel float from `md`
// (stage-popover.ts); and the divider between this group and the settings buttons is the settings group's own (stages-panel.tsx), asked
// of `stageRailActions` below, so it can never be stranded on a line of its own.
//
// PRESENTATIONAL ONLY, deliberately: this component receives everything it
// renders as props and calls no `use*` DATA hook of its own (useMsg is a
// plain context read, not a data fetch, and is fine — the per-stage capacity
// hook that used to make this rule concrete is gone, deleted with the
// Auto-schedule CTA it fed, but the rule stands: a data-fetching hook must
// not move into a per-stage child). Task 10 folds this
// into a phone bottom sheet, and the "no hooks of its own beyond useMsg"
// rule turned out to be load-bearing for that too, not just decoration —
// see the STATEFUL HOOKS note a few paragraphs down.
//
// Task 4 first attempt moved the auto-schedule CTA here and reverted: it
// reddened `stages-panel-auto-schedule-seq.test.tsx` and
// `stages-panel-result-strip.test.tsx`, which locate the button by testid
// through `renderIsland`'s default `walk()` — and `walk()` only recurses an
// element's `.props.children`, never invoking a nested function component's
// own render, so anything inside `<StageRail>`'s output was invisible to it
// from `StagesPanel`'s root, inline render or slot prop alike (full
// investigation in git history / task-4-report.md).
//
// Fix round 1 (owner ruling): fixed the TEST HELPER instead of abandoning
// the move. `_hook-harness.tsx` grew `expandWithHooks`, a way to expand a
// hook-using child (this file's own `useMsg()`) from a custom `expand`
// passed to `renderIsland` — mirroring the repo's existing hookless
// `expandRows`/`expandPanel` pattern, but installing a minimal `useContext`-
// only dispatcher for the duration of the call so a real hook doesn't hit
// React with no dispatcher active. Both test files now use it. The CTA
// below is the result — see its own comment for the shape.
//
// Task 10 — the fold this header always pointed at (it used to say "Task 5",
// this component's own two-column desktop column; the fold itself landed
// four tasks later). Below `md` this component now renders a floating
// "Stage tools" trigger plus a bottom sheet holding the exact same content
// — never a second copy of it (this wave's own recorded trap: a hidden
// duplicate of real text passes `toContainText`, which reads `textContent`
// and ignores `display:none`, and stops proving anything).
//
// STATEFUL HOOKS, first attempt and revert: `open` started as a local
// `useState` in THIS component (one instance's own disclosure state seemed
// like the obviously scoped place for it). It reddened
// `stages-panel-auto-schedule-seq.test.tsx` and
// `stages-panel-result-strip.test.tsx` — both walk `<StageRail>` through
// `expandWithHooks` (`_hook-harness.tsx`, added for Task 4 above), which
// installs a DELIBERATELY read-only dispatcher (`useContext`/`useMemo`/
// `useCallback` only) and throws on `useState`/`useId`/anything else
// stateful — its own doc comment names exactly this shape: "a child that
// turns out to need real state needs `renderIsland` on it directly, not
// this helper". So `open` is a PROP (`open`/`onToggleOpen`) instead, owned
// by `stages-panel.tsx` exactly the way `addingTo`/`onToggleAddMatch`
// already is one line below it — same shared-single-value shape (only one
// stage's inline "Add match" form can be open at a time today; only one
// stage's bottom sheet can usefully be open at a time now, since a SECOND
// open sheet would be a second `position:fixed` overlay stacked on the
// first). `sheetId` is derived from `stage.id` (already unique, already a
// prop) rather than `useId()`, for the same reason — no hook this component
// does not already have.
//
// Swiss round-1 pairing (spec 2026-09-22-swiss-round-one-pairing, "UI —
// option A, split button"): the split button's open/pick state IS a local
// `useState`, the exception the STATEFUL HOOKS note above anticipated. That
// note's constraint no longer binds this component — review M4 already gave
// it `useEffect`/`useRef`, which `expandWithHooks` rejects just the same, and
// nothing walks it through that helper any more (every test renders it with
// `renderToStaticMarkup`). The state is also genuinely per-stage and
// per-press, unlike the panel-wide single values `open`/`addingTo` are.
import { useEffect, useRef, useState } from "react";
import { useMsg, useMsgPlural } from "@/components/i18n/dict-provider";
import { stageActions } from "@/lib/stage-card/summaries";
import { WithReasonTip } from "./reason-tip";
import { SWISS_PAIRINGS, type SwissPairingMode } from "@/lib/swiss-pairing";
import {
  swissPairingChangeNote,
  swissPairingDrawNote,
  swissPairingForKey,
  swissPairingHint,
  swissPairingOptionLabel,
  swissPairingOverride,
  type SwissPairingMenu,
} from "@/lib/swiss-pairing-menu";
// Reused, never restated: `modal.tsx` already owns this repo's definition of
// "what is focusable" and its pure Tab-wrap rule. The phone sheet cribbed that
// component's bottom-sheet CSS; review finding M4 was that it cribbed ONLY the
// CSS, so the behaviour comes from the same place the look did.
import { FOCUSABLE_SELECTOR, nextTrapFocus } from "@/components/modal";
import Link from "@/components/ui/console-link";
import { knockoutLateEntryOffered, swissLateEntryOffered, type EntryStage } from "@/lib/open-entry-stages";
// W3 T12 Phase 2: the rounds chip (with its edit dialog) and the More menu's "Add a round" — their own file, so this
// rail only mounts them.
import { SwissAddRoundMenuItem, SwissRoundsChip, type SwissRoundsRail } from "./swiss-rounds-dialog";
import { SwissFinishMenuItem } from "./swiss-rounds-dialog";
import { SwissMoreMenu } from "./swiss-rounds-dialog";
import {
  alignOf,
  floatsNow,
  POPOVER_RAISED,
  popoverClasses,
  pressedAnItem,
  useStagePopover,
  type PopoverAlign,
} from "./stage-popover";

interface StageRow {
  id: string;
  seq: number;
  kind: string;
  name: string;
  config: Record<string, unknown>;
  progression: Record<string, unknown> | null;
  status: string;
}

export interface StageRailProps {
  stage: StageRow;
  canEdit: boolean;
  busy: string | null;
  fixtureCount: number;
  /** Match Day C3: `stageCounts` of ALL the stage's fixtures (Swiss unseated shells included; the panel never wraps it in a
   *  fallback) - what `stageActions` decides Generate and Complete from. */
  counts: { played: number; inPlay: number; unplayed: number };
  /** The matches the stage holds, byes out - the N in "Complete stage unlocks when all N matches are played". */
  matchCount: number;
  deletable: boolean;
  /** Resolves `true` when the action LANDED, `false` when it was refused or
   *  failed (the panel has already said why). The split button clears its
   *  round-1 pick only on `true` — review M2: a pick cleared at click time was
   *  lost to a failed press, and the retry quietly paired the default. */
  onAct: (
    stageId: string,
    action: "generate" | "complete" | "delete" | "unpair",
    opts?: { pairing?: SwissPairingMode },
  ) => Promise<boolean>;
  /** Swiss-only: lowest round still has unseated shells — drives Pair next label. */
  swissHasUnseated: boolean;
  /** Swiss-only: latest seated round has no played results — shows Unpair. */
  canUnpairSwiss: boolean;
  /** Swiss only, and only while a round waits to be paired; null otherwise
   *  (`swissPairingMenuFor`, lib/swiss-pairing-menu.ts). Non-null renders the
   *  ▾ half of the Pair next split button. */
  swissPairingMenu: SwissPairingMenu | null;
  onDelete: (stage: { id: string; name: string }) => void;
  /** Stage id whose inline "Add match" form is currently open (owned by the
   *  panel's `addingTo` state) — used only to reflect the trigger's disclosure
   *  state via `aria-expanded`, the same convention `StageCourtTagsEditor`'s
   *  own toggle uses. */
  addingTo: string | null;
  onToggleAddMatch: (stageId: string) => void;
  /** Task 10 — whether THIS stage's phone bottom sheet is open. Owned by the
   *  panel's own `openRailFor` state, same shared-single-value shape as
   *  `addingTo` two lines up (see this file's own header for why it is not
   *  a local `useState` here). Ignored above `md` — the sheet resets to a
   *  plain inline block regardless of this value, so a phone sheet left
   *  open across a resize never leaves a dangling overlay. */
  open: boolean;
  onToggleOpen: (stageId: string) => void;
  /** Whether this stage's kind is in `ADHOC_STAGE_KINDS` — computed by the
   *  panel, not the rail, so the rail stays presentational. */
  adhoc: boolean;
  /** W3 T10 — the facts the "More" menu's "Add late player" is gated on
   *  (`swissLateEntryOffered`, lib/open-entry-stages.ts), held by the panel:
   *  the division's status, whether a round of this stage has a seat, and
   *  where the item goes (the Entrants tab's own add form — reused, never a
   *  second form). Absent ⇒ no More menu.
   *  W4 T19 (X-LE-3): `division` — the division's stages, the stage among them — lets a started ROOT knockout offer the
   *  same item as "Add to bracket" (`knockoutLateEntryOffered`; the control's one name, b6a carry B3 #3). Absent ⇒ no
   *  knockout item. */
  lateEntry?: {
    divisionStatus: string;
    roundSeated: boolean;
    href: string;
    division?: readonly (EntryStage & { status: string })[];
  };
  /** W3 T12 Phase 2 (X-SW-17; owner pick B) — a Swiss stage's round count as the desk reads it
   *  (`listSwissRoundControls`), its rows and the two writes, held by the panel: the "Rounds: N · Edit" chip and the
   *  More menu's "Add a round" (swiss-rounds-dialog.tsx). Absent ⇒ neither (any other kind of stage). */
  swissRounds?: SwissRoundsRail;
  /** Match Day C3 (review round 1, phone ruling): the stage's Match rules / Points / Tie-breaks rows, built by the panel (it owns which
   *  panel is open) and mounted as the TOP rows of this sheet below `md` - the card's one phone trigger. The slot carries its own
   *  `md:hidden` (the header's buttons are the desktop twin). Absent: nothing, so the rail's other callers are unchanged. */
  toolsSlot?: React.ReactNode;
  /** W4 B2 fix round 1 (item 6): a root knockout whose roster moved before the division started (the panel's
   *  `knockoutUpdateDrawOffered`, lib/bracket-reconcile.ts). Generate is offered again, as the lead, worded "Update draw".
   *  Absent ⇒ false. */
  updateDraw?: boolean;
}

/**
 * What the actions group draws, decided once and asked by two places: this rail (which buttons) and the panel (does the settings group
 * beside it get a divider - a divider beside nothing is a stray line, so it needs `hasActions`).
 *
 * `hasActions` is true when the group holds at least one control. Add match is not listed: `stageActions` hands an ad-hoc stage with
 * fixtures an "add_match" only beside Generate (not started) or Complete (started), so wherever Add match shows, one of those already
 * counts. W3 (merge with Match Day #1103): the Swiss controls ride this same group. The Rounds control counts only while it is a
 * BUTTON (before the stage's first start, `control.started` false) - after the start it is no longer drawn at all (SCF, owner pick
 * Option A: the count is fixed, the legend line says "N rounds", and a pill that does nothing reads as a button). Both Mores are not
 * listed: the fed-Swiss More needs `swissRounds` too, and the late-add More is offered only on a started stage with a seated round
 * (`swissLateEntryOffered`), where Complete already counts.
 */
export function stageRailActions(p: {
  stage: Pick<StageRow, "kind" | "status">;
  counts: StageRailProps["counts"];
  fixtureCount: number;
  adhoc: boolean;
  swissHasUnseated: boolean;
  canUnpairSwiss: boolean;
  deletable: boolean;
  swissRounds?: Pick<SwissRoundsRail, "control">;
  updateDraw?: boolean;
}) {
  const { primary, secondary } = stageActions({
    status: p.stage.status,
    played: p.counts.played,
    inPlay: p.counts.inPlay,
    unplayed: p.counts.unplayed,
    hasFixtures: p.fixtureCount > 0,
    adhoc: p.adhoc,
    pairNext: p.stage.kind === "swiss" && p.swissHasUnseated,
    canUnpair: p.stage.kind === "swiss" && p.canUnpairSwiss,
    updateDraw: p.updateDraw ?? false,
  });
  const showGenerate = primary?.action === "generate" || primary?.action === "pair_next";
  const completeButton = [primary, ...secondary].find((b) => b?.action === "complete");
  const hasActions =
    (p.stage.status !== "complete" &&
      (showGenerate || (p.stage.kind === "swiss" && p.canUnpairSwiss) || completeButton !== undefined)) ||
    p.deletable ||
    (p.swissRounds !== undefined && !p.swissRounds.control.started);
  return { primary, secondary, showGenerate, completeButton, hasActions };
}

export function StageRail({
  stage,
  canEdit,
  busy,
  fixtureCount,
  counts,
  matchCount,
  deletable,
  onAct,
  onDelete,
  addingTo,
  onToggleAddMatch,
  open,
  onToggleOpen,
  adhoc,
  toolsSlot,
  swissHasUnseated,
  canUnpairSwiss,
  swissPairingMenu,
  lateEntry,
  swissRounds,
  updateDraw = false,
}: StageRailProps) {
  const msg = useMsg();
  const msgPlural = useMsgPlural();
  // W3 T10 — the "More" menu (owner pick: option A). Its open state is local
  // and per-stage, like the split button's below. T12's "Add a round" and
  // T13's "Finish now" join this same panel.
  const [moreOpen, setMoreOpen] = useState(false);
  const knockoutLateOffered =
    lateEntry?.division !== undefined &&
    knockoutLateEntryOffered({
      stage,
      division: lateEntry.division,
      divisionStatus: lateEntry.divisionStatus,
      generated: fixtureCount > 0,
    });
  const lateEntryOffered =
    lateEntry !== undefined &&
    (knockoutLateOffered ||
      swissLateEntryOffered({ stage, divisionStatus: lateEntry.divisionStatus, roundSeated: lateEntry.roundSeated }));
  // Derived, not `useId()`: `stage.id` is already unique and already a prop
  // — see this file's own header for why this component gains no hook
  // beyond `useMsg`.
  const sheetId = `stage-rail-sheet-${stage.id}`;

  // The split button's state, stamped with the ROUND it belongs to. While the
  // waiting round is a different one, the state reads as closed with no pick —
  // so a round-1 pick can never ride along into round 2, with no effect that
  // sets state. That HIDES the state; it does not clear it: if the round comes
  // back (1 → 2 → 1 with no press from this rail — another organiser pairs,
  // then unpairs), the old state is live again and the menu reopens as it was
  // left. The pick is shown checked there, so a press still sends what the
  // screen shows. What CLEARS it is a Pair next press from this rail that
  // lands (below).
  const [pairingState, setPairingState] = useState<{
    round: number;
    open: boolean;
    pick: SwissPairingMode | null;
  } | null>(null);
  const livePairing =
    swissPairingMenu && pairingState?.round === swissPairingMenu.round ? pairingState : null;
  const pairingOpen = livePairing?.open ?? false;
  const pairingPick = livePairing?.pick ?? null;
  const pairingToggleRef = useRef<HTMLButtonElement>(null);
  const closePairing = () => {
    if (swissPairingMenu) setPairingState({ round: swissPairingMenu.round, open: false, pick: pairingPick });
    pairingToggleRef.current?.focus();
  };
  // SCF (owner pick, Option A): from `md` the pairing panel and More float under their trigger instead of growing the card. Each menu's
  // ROOT (trigger + panel) is the element a press is "inside"; a press anywhere else, or Escape, closes it. Escape hands focus back to
  // the trigger; an outside press leaves focus where the organiser put it. The pick survives a close either way (it is the press
  // that uses it that clears it), so a menu closed by a stray tap is reopened as it was left.
  const [pairingAlign, setPairingAlign] = useState<PopoverAlign>("start");
  const pairingRoot = useStagePopover(pairingOpen, (how) => {
    if (how === "escape") closePairing();
    else if (swissPairingMenu) setPairingState({ round: swissPairingMenu.round, open: false, pick: pairingPick });
  });
  const moreToggleRef = useRef<HTMLButtonElement>(null);
  const [moreAlign, setMoreAlign] = useState<PopoverAlign>("start");
  // Only the late-add More lives in this component's tree; the fed-Swiss More (`SwissMoreMenu`) owns its own dismissal.
  const moreRoot = useStagePopover(moreOpen && lateEntryOffered, (how) => {
    setMoreOpen(false);
    if (how === "escape") moreToggleRef.current?.focus();
  });

  // WHICH action gets the filled primary. Found by driving the product
  // (2026-09-20): on a Swiss stage that had paired nothing, "Complete stage"
  // rendered as the primary while "Pair next round" was an outline secondary
  // beside it — the destructive action dressed as the one to press next.
  // Completing a stage that has never been paired ends it with nothing played.
  //
  // The rule is "whatever still has work to do": a stage with no fixtures, or
  // a Swiss stage with rounds still unseated, wants generate/pair. Once the
  // board is fully seated there IS nothing left to pair, and completing is
  // genuinely the next step — so the primary moves to it rather than
  // disappearing. Exactly one filled button either way.
  const pairingIsNext = fixtureCount === 0 || (stage.kind === "swiss" && swissHasUnseated);

  // Match Day C3 (spec §12 item 8): whether the stage offers Generate / Complete, and which one leads, is `stageActions`' answer
  // (C1's pure rule, pinned in `lib/stage-card/__tests__/summaries.test.ts`): Generate is gone once the stage has started,
  // Complete is present but DISABLED while any match is open, with the reason beside it. Pair next, Unpair and Add match keep
  // their own gates above and below (their decisions are the same as `stageActions`' own). The same answer is what the PANEL asks
  // (`stageRailActions`) to know whether the settings buttons beside this group get their divider.
  const { primary, showGenerate, completeButton } = stageRailActions({
    stage,
    counts,
    fixtureCount,
    adhoc,
    swissHasUnseated,
    canUnpairSwiss,
    deletable,
    swissRounds,
    updateDraw,
  });
  const completeHintId = `stage-complete-hint-${stage.id}`;

  // Review finding M4. Below `md` this sheet BEHAVES modally — a
  // `fixed inset-0` backdrop swallows every tap on the page behind it — but it
  // declared none of a modal's contract: no Escape, no focus move, no trap, no
  // restore. A keyboard organiser at 320 pressed "Stage tools" and left focus
  // on a trigger now buried under a 40% scrim, then tabbed into a page they
  // could neither see nor click. The behaviour comes from `modal.tsx` (the
  // same place the CSS did) rather than a second copy of the rule.
  //
  // Gated on matchMedia, NOT on a class: at >= 768 the sheet is an ordinary
  // inline block and there is no backdrop, so trapping focus inside it would
  // be wrong — and `open` can genuinely still be true there, when a phone
  // sheet is left open across a resize. These hooks sit ABOVE the `!canEdit`
  // early return because hooks cannot be called conditionally.
  const sheetRef = useRef<HTMLDivElement>(null);
  const toggleRef = useRef(onToggleOpen);
  useEffect(() => {
    toggleRef.current = onToggleOpen;
  });
  useEffect(() => {
    if (!open || typeof window === "undefined") return;
    if (!window.matchMedia("(max-width: 767.98px)").matches) return;
    const sheet = sheetRef.current;
    const restore = document.activeElement as HTMLElement | null;
    const focusables = (): HTMLElement[] =>
      Array.from(sheet?.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR) ?? []);
    if (!sheet?.contains(document.activeElement)) focusables()[0]?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        // An inner disclosure (the Swiss pairing menu) that already spent
        // this Escape marks it handled. `stopPropagation` cannot keep it from
        // reaching this listener: the App Router hydrates React onto
        // `document` itself, the very node this listens on, so React's
        // handler and this one are siblings, React's registered first.
        if (e.defaultPrevented) return;
        toggleRef.current(stage.id);
        return;
      }
      if (e.key !== "Tab") return;
      const target = nextTrapFocus(focusables(), document.activeElement as HTMLElement | null, e.shiftKey);
      if (target) {
        e.preventDefault();
        target.focus();
      }
    };
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("keydown", onKey);
      restore?.focus?.();
    };
  }, [open, stage.id]);

  // A non-editing viewer gets NOTHING from this component, at any width: every control it renders is an EDIT action
  // (generate / pair / complete / delete / add match), and the guard runs BEFORE the trigger, backdrop and sheet are built, so
  // `stage-rail.test.tsx`'s "renders nothing at all when the viewer cannot edit" asserts the exact empty string. The read-only
  // facts a viewer needs (the court-tags view, the settings buttons) are the panel's own, at every width.
  if (!canEdit) return null;

  return (
    <>
      {/* Floating trigger, phone only. `md:hidden` — never `max-md:hidden`,
          they are opposites (Task 10's own e2e anchors on `\s...hidden"` for
          exactly this reason). Styling cribbed from `phone-disclosure.tsx`'s
          toggle (rounded pill, border, shadow, chevron) — this repo's own
          established phone-toggle look — rather than the plain `.btn` class,
          which does not carry the elevated "floating" shape the brief calls
          for. */}
      <button
        type="button"
        data-testid="stage-rail-trigger"
        onClick={() => onToggleOpen(stage.id)}
        aria-expanded={open}
        aria-controls={sheetId}
        className="flex min-h-11 w-full items-center justify-between gap-2 rounded-2xl border border-slate-200 bg-white px-4 text-left text-sm font-semibold text-slate-800 shadow-sm transition-colors hover:bg-slate-50 focus-visible:outline focus-visible:outline-2 focus-visible:outline-violet-400 md:hidden"
      >
        {msg("schedule.stageTools")}
        <span aria-hidden="true">{open ? "▴" : "▾"}</span>
      </button>
      {/* Backdrop — mounted only while `open`, so it can never linger as a
          hidden duplicate. `md:hidden` too: a phone sheet left open across a
          resize past `md` must fall back to the plain inline rail, not a
          dangling overlay. */}
      {open && (
        <div
          className="fixed inset-0 z-30 bg-slate-900/40 md:hidden"
          onClick={() => onToggleOpen(stage.id)}
          data-testid="stage-rail-backdrop"
          aria-hidden="true"
        />
      )}
      {/* The sheet. Below `md`: a fixed bottom sheet cribbed from `components/modal.tsx`, `hidden` unless `open` - every control inside
          stays ATTACHED either way (only visibility toggles). From `md` up (Match Day E1 item 1): the sheet is no card-width block
          below the rows but the ACTIONS GROUP of the stage's header - `md:flex`, no padding, no chrome - so Generate / Pair next,
          Complete stage, Add match and Delete sit in the header beside the settings buttons, whatever `open` says (a phone sheet
          left open across a resize falls back to the same group, never a dangling overlay). One DOM: the controls are in the tree
          once, in this group, at every width.
          `tabIndex`/`role`/`aria-label` follow the `open` PROP (JS state, not a media query), so a desktop keyboard user never
          walks a "Stage tools" dialog stop through a box that does not scroll (review m10; AGENTS.md rule 23). */}
      <div
        ref={sheetRef}
        id={sheetId}
        data-testid="stage-rail-sheet"
        // Every one of these varies by the `open` PROP — JS state, not a media
        // query — so AGENTS.md #23's "tabindex cannot be varied by media query"
        // is satisfied: at a given width the answer never changes with the
        // viewport, only with what the organiser did.
        //
        // Review finding m10. They used to be UNCONDITIONAL, on the reading
        // that #23 owes a scrollable region a tab stop "whether it is open or
        // not". But this div is scrollable in exactly ONE state: open, below
        // `md` (`overflow-y-auto` lives in the open branch of the className
        // below; the closed branch is `hidden`, and `md:` resets to
        // `md:overflow-visible` at every width above). Unconditional therefore
        // bought nothing where the rule aims and cost real usability where it
        // does not: on a division with five stages, a DESKTOP keyboard user
        // walked five extra tab stops through non-scrolling blocks, and a
        // screen reader's landmark list carried five entries all named "Stage
        // tools". Gated on `open`, the tab stop exists precisely while the box
        // it belongs to can scroll.
        role={open ? "dialog" : undefined}
        aria-modal={open || undefined}
        aria-label={open ? msg("schedule.stageTools") : undefined}
        tabIndex={open ? 0 : undefined}
        className={[
          "min-w-0",
          open
            ? "fixed inset-x-0 bottom-0 z-30 flex max-h-[85dvh] flex-col gap-2 overflow-y-auto rounded-t-2xl border border-slate-200 bg-white p-4 pb-[calc(1rem+env(safe-area-inset-bottom))] shadow-2xl"
            : "hidden",
          "md:static md:z-auto md:flex md:max-h-none md:flex-row md:flex-wrap md:items-center md:gap-2 md:overflow-visible md:rounded-none md:border-0 md:bg-transparent md:p-0 md:shadow-none",
        ].join(" ")}
      >
        {open && (
          <span aria-hidden className="mx-auto mb-1 block h-1 w-10 shrink-0 rounded-full bg-slate-200 md:hidden" />
        )}
        {toolsSlot}
        {/* The actions: a vertical stack in the phone sheet (one control per row), a wrapping row in the header from `md` (a deliberate
            wrap, `gap-2`, not text-like ragged wrapping). `min-h-11` is on every button below at every width - 768/834 have no
            sheet chrome to give them room, and a 28px button is under the tap floor. */}
        <div className="flex flex-col gap-2 md:flex-row md:flex-wrap md:items-center">
          {swissRounds && (
            // W3 T12 Phase 2: the round count, first on the row. Opening its dialog closes the phone sheet first, so the
            // two modal layers never trap focus against each other.
            <SwissRoundsChip stageId={stage.id} busy={busy} rail={swissRounds} onOpen={() => open && onToggleOpen(stage.id)} />
          )}
          {stage.status !== "complete" && (
            <>
              {/* Swiss round-1 pairing — the split button (spec
                  2026-09-22-swiss-round-one-pairing, "UI — option A"). Pair
                  next is wrapped, not changed (review ruling R5): same
                  testid, same label, same click, plus the pick. `grow` keeps
                  it full-width in the phone sheet's column, where it used to
                  stretch on its own; in the desktop row the wrapper is
                  content-sized, so it grows into nothing. */}
              {showGenerate && (
              // The ROOT of the split button's menu: the button, its ▾ and the panel (SCF). A positioned box from `md`, so the panel
              // hangs from the button; below `md` a plain column, so the panel is the next row of the sheet, as it always was.
              <div ref={pairingRoot} data-testid="stage-pairing-root" className="flex min-w-0 flex-col gap-2 md:relative">
              <div className="flex items-stretch">
                <button
                  type="button"
                  disabled={busy !== null}
                  onClick={() => {
                    // P6/D4b task B, scope item 2 — REVERSED (fix round 3,
                    // Critical 1, whole-branch review): this click used to
                    // be gated behind a "you'll lose N fixtures" confirm
                    // dialog whenever stageFixtures.length > 0. That
                    // premise was never checked against the code and is
                    // false — generateStageFixtures (stages.ts) is
                    // ADDITIVE ONLY. It builds `byKey` from the stage's
                    // existing fixtures and inserts only the generated
                    // rows missing from it (stages.ts:997-1031); any
                    // existing fixture that no longer matches the current
                    // rules is left in place, untouched, not discarded.
                    // The repo's only `delete from fixtures` are
                    // history.ts's checkpoint restore and a demo seed —
                    // neither is this code path. So the dialog blocked a
                    // routine, safe action (an organiser adding a late
                    // entrant, then clicking Generate again) behind a
                    // false data-loss warning.
                    //
                    // Deliberately NOT replaced with a truthful-but-vague
                    // "this won't remove stale fixtures" disclaimer either:
                    // there is no client-side way to tell whether any
                    // existing fixture actually IS stale (that diff is
                    // engine-only, server-side, out of this task's scope —
                    // same reason the old dialog computed a client-side
                    // "blast radius" instead of the real diff in the first
                    // place). A disclaimer with no computed fact behind it
                    // would just be new boilerplate to click through on
                    // every regenerate, forever, in place of one that
                    // named specific (if wrong) numbers. Regeneration is
                    // simply a normal, unguarded action now, same as the
                    // common first-generate case always was.
                    const pressed = onAct(stage.id, "generate", swissPairingOverride(pairingPick, swissPairingMenu));
                    // Selection resets after every press that LANDS (spec;
                    // review M2): the pick was for that press only and is never
                    // stored on the stage. A press that fails keeps it, menu
                    // and all, so the retry sends what the organiser last saw
                    // instead of quietly falling back to the default.
                    void pressed.then((landed) => {
                      if (landed) setPairingState(null);
                    });
                  }}
                  data-testid="stage-generate"
                  className={`btn min-h-11 grow px-3 py-1.5 text-xs ${
                    pairingIsNext || primary?.action === "generate" ? "btn-primary" : "btn-ghost"
                  }${swissPairingMenu ? " rounded-r-none" : ""}`}
                >
                  {busy === stage.id
                    ? msg("schedule.working")
                    : stage.kind === "swiss"
                      ? fixtureCount === 0
                        ? msg("schedule.generate")
                        : swissHasUnseated
                          ? msg("schedule.pairNext")
                          : msg("schedule.generate")
                      : updateDraw && fixtureCount > 0
                        ? msg("schedule.updateDraw")
                        : msg("schedule.generate")}
                </button>
                {swissPairingMenu && (
                  <button
                    ref={pairingToggleRef}
                    type="button"
                    aria-expanded={pairingOpen}
                    aria-controls={`pairing-menu-${stage.id}`}
                    aria-label={msg("schedule.pairing.toggle")}
                    data-testid="stage-pairing-toggle"
                    disabled={busy !== null}
                    onClick={() => {
                      // Which edge the panel hangs from is read where the button is NOW (the header wraps), as it opens.
                      if (!pairingOpen) setPairingAlign(alignOf(pairingRoot.current));
                      setPairingState({ round: swissPairingMenu.round, open: !pairingOpen, pick: pairingPick });
                    }}
                    onKeyDown={(e) => {
                      // Escape closes the menu and stops there: marked
                      // handled, so the phone sheet's own Escape (above)
                      // leaves the sheet open — see the note on that listener.
                      if (e.key !== "Escape" || !pairingOpen) return;
                      e.preventDefault();
                      closePairing();
                    }}
                    // Always the filled primary, like Generate beside it: a menu
                    // exists only while a Swiss round waits to be paired, which
                    // is exactly when `pairingIsNext` holds (both read
                    // `nextUnseatedSwissRound` over the same fixtures).
                    className="btn btn-primary min-h-11 min-w-11 rounded-l-none border-l border-white/40 px-2 text-xs"
                  >
                    <span aria-hidden="true">{pairingOpen ? "▴" : "▾"}</span>
                  </button>
                )}
              </div>
              {/* The menu follows its toggle in the DOM, so the tab order is the reading order. In the phone sheet's column it is an
                  inline disclosure, the next row - nothing can overflow at 320. From `md` it is a popover hung from the button (SCF,
                  owner pick Option A): over the content, the card does not grow, and a press elsewhere or Escape closes it. A
                  pick inside it does NOT close it: the radios are a choice that Pair next then uses, and a menu that put its
                  checked option away would send a mode the organiser can no longer see. */}
              {swissPairingMenu && pairingOpen && (
                <SwissPairingMenuPanel
                  stageId={stage.id}
                  menu={swissPairingMenu}
                  pick={pairingPick}
                  onPick={(mode) => setPairingState({ round: swissPairingMenu.round, open: true, pick: mode })}
                  onClose={closePairing}
                  align={pairingAlign}
                />
              )}
              </div>
              )}
              {stage.kind === "swiss" && canUnpairSwiss && (
                <button
                  type="button"
                  disabled={busy !== null}
                  onClick={() => void onAct(stage.id, "unpair")}
                  data-testid="stage-unpair"
                  className="btn btn-ghost min-h-11 px-3 py-1.5 text-xs"
                >
                  {busy === stage.id ? msg("schedule.working") : msg("schedule.unpair")}
                </button>
              )}
              {completeButton &&
                (() => {
                  const complete = (
                    // `aria-disabled`, not `disabled`, while a match is open (E1 item 1): it stays in the tab order and on the hover
                    // path, so the reason is reachable by keyboard and by finger; the press does nothing. A press in flight
                    // (`busy`) is the one case that disables outright - there is nothing to read there.
                    <button
                      type="button"
                      disabled={busy !== null}
                      aria-disabled={!completeButton.enabled || undefined}
                      aria-describedby={completeButton.enabled ? undefined : completeHintId}
                      onClick={() => {
                        if (!completeButton.enabled) return;
                        void onAct(stage.id, "complete");
                      }}
                      data-testid="stage-complete"
                      className={`btn min-h-11 px-3 py-1.5 text-xs aria-disabled:cursor-help aria-disabled:opacity-50 max-md:grow ${
                        primary?.action === "complete" ? "btn-primary" : "btn-ghost"
                      }`}
                    >
                      {msg("schedule.complete")}
                    </button>
                  );
                  // Present but waiting while any match is open (item 8): the reason is a bubble on the greyed button itself - hover,
                  // keyboard focus or a tap (PB1: there is no ⓘ any more) - and `aria-describedby` above names it, so it is read with the
                  // button as well.
                  return completeButton.enabled ? (
                    complete
                  ) : (
                    <WithReasonTip
                      id={completeHintId}
                      reason={msgPlural("stageCard.completeHint", matchCount)}
                      reasonTestId="stage-complete-hint"
                    >
                      {complete}
                    </WithReasonTip>
                  );
                })()}
            </>
          )}
          {deletable && (
            <button
              type="button"
              disabled={busy !== null}
              onClick={() => onDelete({ id: stage.id, name: stage.name })}
              data-testid="stage-delete"
              className="btn btn-danger min-h-11 px-3 py-1.5 text-xs"
            >
              {msg("schedule.delete")}
            </button>
          )}
          {lateEntry && lateEntryOffered && (
            // W3 T10 — More. The ROOT holds the trigger and its panel (SCF): from `md` the panel is a popover hung from the button, over
            // the content, closed by a press elsewhere, by Escape (focus back on More) or by choosing an item; below `md` it is the
            // inline disclosure it always was, the next row of the sheet's column. `hidden` rather than unmounted, as
            // `desk-tools-more.tsx` does: the item stays in the DOM, so a test can tell "folded" from "never rendered".
            <div ref={moreRoot} data-testid="stage-more-root" className="flex min-w-0 flex-col gap-2 md:relative">
              <button
                ref={moreToggleRef}
                type="button"
                aria-expanded={moreOpen}
                aria-controls={`stage-more-menu-${stage.id}`}
                onClick={() => {
                  if (!moreOpen) setMoreAlign(alignOf(moreRoot.current));
                  setMoreOpen((v) => !v);
                }}
                data-testid="stage-more"
                className="btn btn-ghost min-h-11 justify-between gap-1.5 px-3 py-1.5 text-xs"
              >
                {msg("desk.tools.more")}
                <span aria-hidden="true">{moreOpen ? "▴" : "▾"}</span>
              </button>
              <div
                id={`stage-more-menu-${stage.id}`}
                hidden={!moreOpen}
                data-testid="stage-more-menu"
                onClick={(e) => {
                  // Choosing an item puts the floating menu away (and focus back on More). Below `md` the menu is part of the sheet and
                  // stays as it was.
                  if (!floatsNow() || !pressedAnItem(e.target)) return;
                  setMoreOpen(false);
                  moreToggleRef.current?.focus();
                }}
                className={popoverClasses(moreAlign)}
              >
                <div className={`flex flex-col overflow-hidden rounded-xl border border-purple-200 bg-white ${POPOVER_RAISED}`}>
                  <Link
                    href={lateEntry.href}
                    data-testid="stage-add-late-player"
                    className="flex min-h-11 flex-col justify-center border-b border-purple-100 px-4 py-2 last:border-b-0 hover:bg-purple-50"
                  >
                    <span className="text-sm font-medium text-purple-700">
                      {msg(knockoutLateOffered ? "knockout.addToBracket" : "stage.more.addLatePlayer")}
                    </span>
                    <span className="text-xs text-slate-500">{msg("stage.more.addLatePlayer.hint")}</span>
                  </Link>
                  {swissRounds && <SwissAddRoundMenuItem stageId={stage.id} busy={busy} rail={swissRounds} />}
                  {swissRounds && <SwissFinishMenuItem stageId={stage.id} busy={busy} rail={swissRounds} onOpen={() => open && onToggleOpen(stage.id)} />}
                </div>
              </div>
            </div>
          )}
          {/* Batch-4 ruling 3: a running Swiss with no late-add More above (a fed Swiss) still gets Add a round and Finish
              the Swiss now — its own More, the same toggle and testids, holding just those two. */}
          {!(lateEntry && lateEntryOffered) && swissRounds && (
            <SwissMoreMenu
              stageId={stage.id}
              busy={busy}
              rail={swissRounds}
              open={moreOpen}
              onToggle={() => setMoreOpen((v) => !v)}
              onFinishOpen={() => open && onToggleOpen(stage.id)}
            />
          )}
          {/* W3 RB3-15 A (X-SW-21, ruling 252): no Add match on a Swiss stage, whatever `adhoc` says - the system pairs its rounds and the
              server refuses the match (SWISS_ADHOC_REFUSED). The refusal's own copy used to stand HERE, in the action row, where the
              button would be. SCF (owner pick, Option A): it is information, not an action, and a 387px sentence in the row is what pushed the
              settings buttons onto a second line - so the panel now says it on the stage's legend line (`stage-swiss-adhoc-note`,
              stages-panel.tsx), under the same gates. The row holds controls only. */}
          {stage.status !== "complete" && adhoc && fixtureCount > 0 && stage.kind !== "swiss" && (
            // Task 3 — trigger only. `AddMatchForm` deliberately stays mounted in
            // stages-panel.tsx: it reads `boardSlotOptions`, which also feeds
            // `<RunSheet>`, so hoisting the form itself here would mean building
            // a second copy of that derivation. Do not "finish the job" by moving
            // the form too — that would break the run sheet's own slot options.
            <button
              type="button"
              disabled={busy !== null}
              onClick={() => onToggleAddMatch(stage.id)}
              aria-expanded={addingTo === stage.id}
              data-testid="stage-add-match"
              className="btn btn-ghost min-h-11 px-3 py-1.5 text-xs"
            >
              {msg("stage.addMatch.button")}
            </button>
          )}
        </div>
      </div>
    </>
  );
}

/**
 * The open Swiss pairing menu — the ▾ half of Pair next's split button.
 * Stateless: the rail owns the open/pick state and mounts this only while the
 * menu is open, so it is exported for `renderToStaticMarkup` tests (there is
 * no DOM to open it in). Every decision it renders — checked mode, labels,
 * hints, keys — comes from `lib/swiss-pairing-menu.ts`, pinned there.
 *
 * Round 1 (`choosable`): a radiogroup of the two modes, the default checked,
 * a roving tab stop on the checked radio, arrows move and select.
 * Round 2+: the same group, `aria-disabled`, holding ONE checked, disabled
 * radio naming the stage's own mode, plus the reason in visible text (spec:
 * a disabled control cannot show a hint on a phone — no hover).
 */
export function SwissPairingMenuPanel({
  stageId,
  menu,
  pick,
  onPick,
  onClose,
  align = "start",
}: {
  stageId: string;
  menu: SwissPairingMenu;
  pick: SwissPairingMode | null;
  onPick: (mode: SwissPairingMode) => void;
  /** Escape: close, and hand focus back to the toggle. */
  onClose: () => void;
  /** From `md` the panel hangs from the split button's left edge (`start`) or its right edge (`end`, when there is no room to the
   *  right - `popoverAlign`). Below `md` it is in flow and this changes nothing. */
  align?: PopoverAlign;
}) {
  const msg = useMsg();
  const checkedMode = pick ?? menu.defaultPairing;
  // X-SW-22 (W3 T8): round 1 over a field with an unseeded entrant is drawn at random — said once, under the options,
  // in the read-only hint's own quiet style, and tied to the group so a screen reader hears it with the choice.
  const drawNote = swissPairingDrawNote(menu, msg);
  const drawNoteId = `pairing-draw-note-${stageId}`;
  // X-SW-30 (W3 T14, SW-L12): round 2+ also says the Swiss rules decide the pairing and how to re-derive it (Unpair, then Pair next).
  const changeNote = swissPairingChangeNote(menu, msg);
  return (
    // The outer box is the positioned part: below `md` nothing (the next row of the sheet's column), from `md` a popover under the
    // split button (`popoverClasses`, SCF) - so opening it never moves the buttons after it, and the card does not grow. It is a
    // reading width (`md:w-96`), not the row's whole line.
    <div className={popoverClasses(align)}>
      <div
        id={`pairing-menu-${stageId}`}
        role="radiogroup"
        aria-label={msg("schedule.pairing.groupLabel", { round: menu.round })}
        aria-disabled={!menu.choosable || undefined}
        aria-describedby={drawNote === null ? undefined : drawNoteId}
        data-testid="stage-pairing-menu"
        onKeyDown={(e) => {
          if (e.key !== "Escape") return;
          // Marked handled, so the phone sheet — which listens for Escape on
          // `document` — stays open and only this menu closes.
          e.preventDefault();
          onClose();
        }}
        className={`flex w-full min-w-0 flex-col gap-1 rounded-lg border border-slate-200 bg-white p-1.5 text-xs ${POPOVER_RAISED}`}
      >
        {menu.choosable ? (
          <>
            {SWISS_PAIRINGS.map((mode) => {
              const checked = checkedMode === mode;
              return (
                <button
                  key={mode}
                  type="button"
                  role="radio"
                  aria-checked={checked}
                  tabIndex={checked ? 0 : -1}
                  data-testid={`stage-pairing-${mode}`}
                  data-pairing-mode={mode}
                  onClick={() => onPick(mode)}
                  onKeyDown={(e) => {
                    const next = swissPairingForKey(e.key, checkedMode);
                    if (!next) return;
                    e.preventDefault();
                    onPick(next);
                    // Roving tab stop: DOM focus follows the selection, or the
                    // focus ring stays on a radio that is no longer checked.
                    e.currentTarget
                      .closest('[role="radiogroup"]')
                      ?.querySelector<HTMLElement>(`[data-pairing-mode="${next}"]`)
                      ?.focus();
                  }}
                  className={`flex min-h-11 w-full min-w-0 items-center gap-2 rounded-md px-2 py-1 text-left transition-colors hover:bg-slate-50 focus-visible:outline focus-visible:outline-2 focus-visible:outline-violet-400 ${
                    checked ? "bg-purple-50" : ""
                  }`}
                >
                  <span aria-hidden="true" className={`shrink-0 ${checked ? "text-purple-700" : "text-slate-400"}`}>
                    {checked ? "●" : "○"}
                  </span>
                  <span className="flex min-w-0 flex-col">
                    <span className="font-semibold text-slate-800">
                      {swissPairingOptionLabel(mode, menu.defaultPairing, msg)}
                    </span>
                    {/* slate-600, not -500: -500 on the checked row's purple-50 wash
                        measured under 4.5:1 (axe color-contrast, serious). */}
                    <span className="text-slate-600">{swissPairingHint(mode, menu, msg)}</span>
                  </span>
                </button>
              );
            })}
            {drawNote === null ? null : (
              <p id={drawNoteId} className="px-2 pb-1.5 text-slate-500" data-testid="stage-pairing-draw-note">
                {drawNote}
              </p>
            )}
          </>
        ) : (
          <>
            <p
              role="radio"
              aria-checked="true"
              aria-disabled="true"
              data-testid="stage-pairing-readonly"
              className="flex min-h-11 min-w-0 items-center gap-2 px-2 font-semibold text-slate-800"
            >
              <span aria-hidden="true" className="shrink-0 text-purple-700">
                ✓
              </span>
              <span className="min-w-0">
                {msg(menu.stored === "rank_adjacent" ? "schedule.pairing.laterAdjacent" : "schedule.pairing.laterFold")}
              </span>
            </p>
            <p className="px-2 pb-1.5 text-slate-500" data-testid="stage-pairing-hint">
              {msg("schedule.pairing.roundOneOnly")}
            </p>
            {changeNote === null ? null : (
              <p className="px-2 pb-1.5 text-slate-500" data-testid="stage-pairing-change-hint">
                {changeNote}
              </p>
            )}
          </>
        )}
      </div>
    </div>
  );
}
