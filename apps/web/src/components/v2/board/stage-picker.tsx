"use client";

import { useEffect, useRef, type RefObject } from "react";
import { divisionAccent } from "@/lib/division-hue";
import { dismissesMenu } from "./documents-menu";
import type { BoardStage } from "./types";

// The comp board's stage selector. The single-division board shows its two or
// three stages as pills, and that fits; the competition board multiplies
// those pills by every division and — grouped or not — pushed the solver
// buttons into a ragged wrap at five divisions, with "AI Schedule" stranded
// on a line of its own. The stage is a PARAMETER of those buttons, so it sits
// on their row as one chip that names both halves of the target ("Under 14s ·
// Playoffs") and opens a menu grouped by division underneath.
//
// A native <details>/<summary>, like DocumentsMenu beside it: focusable and
// togglable without a line of JS, and the menu stays in the static DOM while
// closed, which is what lets the hook-harness tests see every option. Same
// dismiss rule too — pointerdown outside, or Escape.

export interface StagePickerProps {
  /** Runnable stages, grouped by division in the competition's division order. */
  groups: ReadonlyArray<{ divisionId: string; stages: ReadonlyArray<BoardStage> }>;
  divisionNames: Record<string, string>;
  activeStage: BoardStage;
  onPick: (stageId: string) => void;
  /** The eyebrow caption beside the chip. */
  label: string;
  /** Accessible name for the menu. */
  menuLabel: string;
}

/** The hooks — a ref for the <details> and the dismiss listeners — live here,
 *  and the markup lives in `StagePickerMarkup` below WITHOUT hooks. Split on
 *  purpose: the board's toolbar tests drive `ScheduleBoard` through the hook
 *  harness, which renders one component deep and can only expand a HOOKLESS
 *  child. The markup is the part a click has to reach. */
export function StagePicker(props: StagePickerProps) {
  const rootRef = useRef<HTMLDetailsElement>(null);
  const close = () => {
    if (rootRef.current) rootRef.current.open = false;
  };
  useEffect(() => {
    const onDown = (e: PointerEvent) => {
      if (dismissesMenu(rootRef.current, e.target as Node)) close();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") close();
    };
    document.addEventListener("pointerdown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("pointerdown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, []);

  return <StagePickerMarkup {...props} rootRef={rootRef} close={close} />;
}

/** Hookless — see `StagePicker`. */
export function StagePickerMarkup({
  groups,
  divisionNames,
  activeStage,
  onPick,
  label,
  menuLabel,
  rootRef,
  close,
}: StagePickerProps & {
  rootRef: RefObject<HTMLDetailsElement | null>;
  /** Shuts the menu — after a pick, so the chip is what the organiser sees next. */
  close: () => void;
}) {
  return (
    <div className="flex min-w-0 items-center gap-2">
      <span className="app-display text-[10px] font-semibold text-slate-500">{label}</span>
      <details ref={rootRef} className="relative min-w-0">
        <summary
          data-testid="schedule-stage-picker"
          data-stage-id={activeStage.id}
          aria-haspopup="listbox"
          // `min-h-11`: the 44px touch floor the pills it replaces carry (#349).
          // `max-w-full` + a truncating division span: "Open Women Singles ·
          // Playoffs" must shorten inside the chip at 320px, not push the row.
          className="inline-flex min-h-11 max-w-full cursor-pointer list-none items-center gap-1.5 rounded-lg border border-slate-200 bg-slate-50 px-3 py-1.5 text-xs hover:border-slate-300 [&::-webkit-details-marker]:hidden"
        >
          <span
            aria-hidden
            className="h-2.5 w-2.5 flex-none rounded-sm"
            style={{ backgroundColor: divisionAccent(activeStage.division_id) }}
          />
          <span
            data-testid="schedule-stage-picker-division"
            className="min-w-0 truncate font-medium text-slate-500"
          >
            {divisionNames[activeStage.division_id]}
          </span>
          <span aria-hidden className="text-slate-400">
            ·
          </span>
          <span
            data-testid="schedule-stage-picker-stage"
            className="whitespace-nowrap font-semibold text-slate-900"
          >
            {activeStage.name}
          </span>
          <svg
            aria-hidden
            viewBox="0 0 16 16"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.8"
            className="ml-0.5 h-3 w-3 flex-none text-slate-500"
          >
            <path d="M4 6l4 4 4-4" />
          </svg>
        </summary>
        <div
          role="listbox"
          aria-label={menuLabel}
          // `max-w-[calc(100vw-2rem)]`: at 320px a fixed 16rem panel anchored
          // left of a chip that starts mid-row runs off the viewport edge.
          className="absolute left-0 top-12 z-20 max-h-80 w-64 max-w-[calc(100vw-2rem)] overflow-y-auto rounded-xl border border-purple-100 bg-white p-1 shadow-lg"
        >
          {groups.map((group) => (
            <div
              key={group.divisionId}
              data-testid="schedule-stage-group"
              data-division-id={group.divisionId}
            >
              <span
                data-testid="schedule-stage-group-label"
                className="flex items-center gap-1.5 px-2 pb-0.5 pt-2 text-[10px] font-semibold uppercase tracking-wide text-slate-500"
              >
                <span
                  aria-hidden
                  className="h-2 w-2 flex-none rounded-sm"
                  style={{ backgroundColor: divisionAccent(group.divisionId) }}
                />
                {divisionNames[group.divisionId]}
              </span>
              {group.stages.map((s) => {
                const selected = s.id === activeStage.id;
                return (
                  <button
                    key={s.id}
                    type="button"
                    role="option"
                    data-testid="schedule-stage"
                    data-stage-id={s.id}
                    aria-selected={selected}
                    onClick={() => {
                      onPick(s.id);
                      close();
                    }}
                    className={`block min-h-10 w-full rounded-md py-2 pl-6 pr-2 text-left text-sm transition ${
                      selected
                        ? "bg-purple-50 font-semibold text-purple-900"
                        : "text-slate-700 hover:bg-slate-50 hover:text-slate-900"
                    }`}
                  >
                    {s.name}
                  </button>
                );
              })}
            </div>
          ))}
        </div>
      </details>
    </div>
  );
}
