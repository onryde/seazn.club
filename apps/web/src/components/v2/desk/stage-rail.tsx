"use client";

// Competition Desk W3 (2026-09-06, task 2): the stage rail. Owner ruling —
// all stage chrome leaves the fixtures sheet. This is the first slice: the
// three stage-header action controls (Generate/Pair next, Complete stage,
// Delete stage), moved verbatim out of stages-panel.tsx's own header render.
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
import { useEffect, useRef } from "react";
import { useMsg } from "@/components/i18n/dict-provider";
// Reused, never restated: `modal.tsx` already owns this repo's definition of
// "what is focusable" and its pure Tab-wrap rule. The phone sheet cribbed that
// component's bottom-sheet CSS; review finding M4 was that it cribbed ONLY the
// CSS, so the behaviour comes from the same place the look did.
import { FOCUSABLE_SELECTOR, nextTrapFocus } from "@/components/modal";

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
  deletable: boolean;
  onAct: (stageId: string, action: "generate" | "complete" | "delete") => void;
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
  /** `StageCourtTagsEditor` stays mounted by the panel and is handed down as
   *  an already-built element — a slot, not a component reference — so the
   *  rail keeps owning no data hook of its own. */
  courtTagsSlot: React.ReactNode;
  /** Task 4, fix round 2 (ruling T4-B) — the unscheduled-count badge,
   *  already-built by the panel, same `courtTagsSlot` shape and same reason:
   *  a non-editing viewer must still see this badge (it carried NO `canEdit`
   *  gate in its previous, pre-rail position), but this component returns
   *  `null` outright for `!canEdit` — so the panel builds the element ONCE
   *  and mounts it in exactly one of two places: here when `canEdit`, or
   *  inline in its own tree when not (see stages-panel.tsx's own comment at
   *  that second site — same pattern Ruling T3-A already set for
   *  `courtTagsSlot`, never a second shape for the same problem). `null`
   *  when there is nothing unscheduled — hides the whole pinned section,
   *  matching the panel's own former `unscheduled.length > 0` gate
   *  byte-for-byte, now expressed as "the slot itself is absent" rather
   *  than a separate count prop.
   *
   *  Owner request (competition desk W3): the "Auto-schedule remaining" CTA
   *  and its capacity-blocked-reason line are GONE — scheduling belongs on
   *  the Schedule page (`ScheduleBoard`, `d/[divSlug]/schedule`, which owns
   *  the full `AutoScheduleMode` flow already), not the fixtures page. The
   *  owner's own ruling: remove the ACTION, keep the FACT — this slot is
   *  now the whole pinned section on its own, and the panel builds it as a
   *  LINK to the Schedule page instead of plain text, so a viewer with
   *  something to schedule has somewhere to go. `capacityBlocked`/
   *  `onAutoSchedule` props retired with the button; `capacityGateBlocks`
   *  itself stays in stages-panel.tsx (still tested on its own,
   *  `stages-panel-capacity.test.tsx` — a general D2 pre-check utility,
   *  not specific to this button) — only this component's OWN use of it
   *  is gone. */
  unscheduledBadgeSlot: React.ReactNode;
}

export function StageRail({
  stage,
  canEdit,
  busy,
  fixtureCount,
  deletable,
  onAct,
  onDelete,
  addingTo,
  onToggleAddMatch,
  open,
  onToggleOpen,
  adhoc,
  courtTagsSlot,
  unscheduledBadgeSlot,
}: StageRailProps) {
  const msg = useMsg();
  // Derived, not `useId()`: `stage.id` is already unique and already a prop
  // — see this file's own header for why this component gains no hook
  // beyond `useMsg`.
  const sheetId = `stage-rail-sheet-${stage.id}`;

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

  // A non-editing viewer's answer to "what do they see at 320 / at 1280?"
  // (owner sign-off question, Task 10): NOTHING new, at either width — this
  // guard runs BEFORE the trigger/backdrop/sheet JSX below, so `!canEdit`
  // returns `null` before any of it is even constructed, exactly the same
  // "built once, one of two mutually exclusive spots" contract Tasks 3/4/5
  // already established for `courtTagsSlot`/`unscheduledBadgeSlot`/the grid
  // track itself. There is no non-editing equivalent of this trigger to
  // place elsewhere, unlike those two slots: every control this component
  // renders is an EDIT action (generate/complete/delete/add-match/auto-
  // schedule) — the read-only facts a non-editing viewer needs (the
  // unscheduled count, the court-tags view) already have their own inline
  // `!canEdit` fallback in stages-panel.tsx's `stage-sheet` column, untouched
  // by this task. Proven by mutation, not merely asserted: defeating this
  // line (`!canEdit && false`) reddens `stage-rail.test.tsx`'s "renders
  // nothing at all when the viewer cannot edit" case, which asserts the
  // rendered HTML is the exact empty string — strong enough to catch a
  // leaked trigger, backdrop or sheet, not just a leaked action button.
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
      {/* The sheet itself — cribbed from `components/modal.tsx`'s
          bottom-sheet CSS (brief), breakpoint moved from `sm:` to `md:` per
          ruling 15. Below `md`: a fixed bottom sheet, `hidden` unless
          `open` — every control inside stays ATTACHED either way, only
          VISIBILITY toggles (brief: "wait on toBeAttached, not toBeVisible,
          for the folded controls"). At `md` and up: reset back to a plain
          block REGARDLESS of `open`, so a phone sheet left open across a
          resize renders as an ordinary full-width stacked block ("Option
          B" below — no more grid column to speak of), never a leftover
          overlay. `tabIndex`/`role`/`aria-label` are gated on `open` — see
          the m10 note on the attributes themselves for why that satisfies
          AGENTS.md #23 rather than breaking it.

          Fix round 1 (controller measurement, owner sign-off session):
          `md:py-4`, not `md:p-0`. `.card` (globals.css) carries no padding
          of its own — every card region insets itself (`stage-sheet`'s own
          header is `px-4 py-3`) — and this div's PRE-Task-10 shape
          (`min-w-0` on the wrapping `stage-rail` div in stages-panel.tsx, a
          bare fragment from `<StageRail>`) already had none either, so the
          desktop rail's first control has always sat flush against the
          card's rounded top edge; Task 10 is simply what finally got
          measured and reported.

          Fix round 3 (D2/D3, controller measurement): VERTICAL padding
          only here (`md:py-4`, and `md:px-0` explicitly — not merely
          omitted, so a phone sheet left `open` across a resize past `md`
          cannot leave the mobile branch's own `p-4` horizontal padding
          stuck in effect; `py-*` never touches `padding-left`/`-right`) —
          round 1's `md:p-4` gave this
          div its OWN horizontal inset on top of `courtTagsSlot`'s and
          `unscheduledBadgeSlot`'s div's OWN `px-4`, DOUBLE-padding those two
          (32px) while the action-button row below (which had no horizontal
          padding of its own) got only this div's 16px — exactly the
          measured 16px step between button left edges (l855) and
          court-tags/CTA left edges (l871). `courtTagsSlot`/
          `unscheduledBadgeSlot` are shared elements (also rendered inline in
          `stage-sheet` for a non-editing viewer, stages-panel.tsx) — their
          OWN `px-4` cannot change without moving that other placement too —
          so the fix is here and on the action-button row (`md:px-4` added
          there instead, a few lines down): every direct child of this div
          now supplies its OWN 16px horizontal inset, none of them doubled
          by an ambient one from this container.

          "Option B" (controller measurement, owner sign-off session,
          superseding Task 5/Ruling T5-A): the two-column desktop grid this
          div used to sit inside is GONE — a 280px column stacking five rail
          items forced the CARD to whatever height the rail needed
          (equal-height grid-row stretch), and no amount of body content in
          `stage-sheet` could ever close the resulting gap (measured:
          `body=262px rail=262px content=99px VOID=163px`, 62% empty, at
          1280). `stages-panel.tsx` no longer wraps `stage-sheet`/
          `stage-rail` in a grid at all — both are now ordinary stacked
          blocks, full CARD width at every size. Everything above and below
          in THIS div (padding, `md:block`, D2/D3/D4's fixes) already
          produces a full-width block at `md` and up regardless of the
          surrounding grid context, so none of it needed to change for this
          — a full-width column and "no column, full width" happen to want
          the same CSS on this specific div. D2's left/right-edge fix and
          D4's 44px floor stay meaningful (and verified) at the new,
          much-wider content box; D3 was retracted (flex slack in a 248px
          row, not a misalignment) and is not chased further here. */}
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
          "md:static md:z-auto md:block md:max-h-none md:overflow-visible md:rounded-none md:border-0 md:bg-transparent md:px-0 md:py-4 md:shadow-none",
        ].join(" ")}
      >
        {open && (
          <span aria-hidden className="mx-auto mb-1 block h-1 w-10 shrink-0 rounded-full bg-slate-200 md:hidden" />
        )}
        {/* Fix round 2 (controller measurement): the action-button quartet
            (generate/complete, delete, add-match — never more than three
            render at once) used to sit as bare `.btn` (`inline-flex`)
            siblings with no wrap instruction of its own, so at desktop
            (280px column, since retired by "Option B" below — this row is
            now full CARD width, so wrapping is unlikely in practice, but
            the deliberate-wrap recipe stays as the safety net for a long
            label or a narrow `md` width) they wrapped like TEXT — an
            accidental "2 + 1 ragged" line break with no controlled gap.
            `flex flex-wrap
            items-center gap-2` is the SAME recipe `unscheduledBadgeSlot`'s
            own row already uses a few lines down — a deliberate wrap, not
            an accidental one. `flex-col` (unprefixed) keeps the phone sheet
            exactly as it already was — a vertical stack, one control per
            row — the coordinator confirmed correct; only `md:flex-row`
            changes it back into a row at desktop.

            Fix round 3 (D2, controller measurement): `md:px-4` added here —
            this row was the one direct child of the sheet with NO
            horizontal padding of its own (`courtTagsSlot`/
            `unscheduledBadgeSlot`'s div both already carry `px-4`), so
            after round 1 gave the sheet itself `md:p-4` this row sat 16px
            further LEFT than the other two. Round 3 removes the sheet's own
            horizontal padding (`md:py-4` now, see the sheet's own comment
            above) and gives it here instead — the same source every other
            direct child already used, so all three now agree.

            D4 (controller measurement): `min-h-11` is now on every button
            below (generate/complete/delete/add-match — `stage-auto-schedule`
            already carried it), not conditionally inside the mobile sheet.
            Before this only the sheet's OWN chrome happened to give them
            room; at 768/834 (device widths in the seven-width matrix, `md:`
            and up, no sheet chrome at all) they measured 28-30px — under the
            44px tap floor. `min-h-11` is a plain Tailwind utility, not
            breakpoint-gated, so it now holds at every width. Explicitly NOT
            fixing here: `.btn-primary` still renders ~2px shorter than
            `.btn-ghost`/`.btn-danger` (a border-width difference,
            globals.css:229/232/235) — repo-wide, not this file's, owner
            decision pending; `min-h-11` is a FLOOR so this difference cannot
            put anything back under 44px, it just means the two button kinds
            are not pixel-identical in height above the floor. */}
        <div className="flex flex-col gap-2 md:flex-row md:flex-wrap md:items-center md:px-4">
          {stage.status !== "complete" && (
            <>
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
                  onAct(stage.id, "generate");
                }}
                data-testid="stage-generate"
                className="btn btn-ghost min-h-11 px-3 py-1.5 text-xs"
              >
                {busy === stage.id
                  ? msg("schedule.working")
                  : stage.kind === "swiss"
                    ? msg("schedule.pairNext")
                    : msg("schedule.generate")}
              </button>
              {fixtureCount > 0 && (
                <button
                  type="button"
                  disabled={busy !== null}
                  onClick={() => onAct(stage.id, "complete")}
                  data-testid="stage-complete"
                  className="btn btn-primary min-h-11 px-3 py-1.5 text-xs"
                >
                  {msg("schedule.complete")}
                </button>
              )}
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
          {stage.status !== "complete" && adhoc && fixtureCount > 0 && (
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
        {courtTagsSlot}
        {/* Task 4 — the pinned unscheduled section, moved onto the rail
            verbatim: same classNames, same gating, same testid.
            Owner request (competition desk W3): the auto-schedule CTA and
            its blocked-reason line are GONE from this page (scheduling
            belongs on the Schedule page) — this is now just the badge,
            built as a LINK by the panel (`unscheduledBadgeSlot`'s own doc
            comment above). Fix round 2 (T4-B): the badge itself is still a
            slot, not a value — never re-derive it here. */}
        {unscheduledBadgeSlot && (
          <div className="border-b border-dashed border-slate-200 bg-slate-50/60 px-4 py-3">
            <div className="flex flex-wrap items-center gap-2">{unscheduledBadgeSlot}</div>
          </div>
        )}
      </div>
    </>
  );
}
