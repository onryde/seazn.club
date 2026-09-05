"use client";

// Progress dots for the puzzle games (mate-in-1/2/3, Piece Detective, Trick
// Shots). ONE DOM, branched — phone composition design of record
// (2026-09-05, "Option 1 — Board first, picks in a sheet"):
//
//   phones  (`md:hidden`)     a stepper — 44px ‹ / › either side of "3 of 12",
//                             with 8px decoration dots. The numbered grid's
//                             24px targets are well under the 44px floor.
//   desktop (`max-md:hidden`) the original numbered grid: solved dots fill,
//                             the current one is ringed.
//
// `variant="grid"` is the copy that lives INSIDE GameShell's phone picker
// sheet, so the phone can still jump straight to any puzzle: full-size 44px
// targets, named "Go to puzzle 3" so the sheet copy and the desktop copy are
// never two controls answering to one accessible name — and `md:hidden` of
// its own, because GameShell ALSO renders every picker's children inline for
// desktop. Without that, a puzzle game would paint this 44px grid next to the
// 24px grid in `extra` at >=768.
// Longest pack whose phone stepper still shows a dot per puzzle: ten dots at
// 8px + 6px gap = 134px, which fits between the two 44px arrows and the
// "n of N" text on a 320px screen. Exported so the test pins the boundary.
export const STEPPER_DOTS_MAX = 10;

export function PuzzleDots({
  count,
  current,
  isSolved,
  onPick,
  label = "Puzzle",
  variant = "auto",
}: {
  count: number;
  current: number;
  isSolved(i: number): boolean;
  onPick(i: number): void;
  label?: string;
  variant?: "auto" | "grid";
}) {
  const noun = label.toLowerCase();

  const numbered = (sheet: boolean) => (
    <div
      data-cq={sheet ? "puzzle-dots-sheet" : "puzzle-dots"}
      className={`flex flex-wrap justify-center gap-1.5 ${sheet ? "md:hidden" : "max-md:hidden"}`}
    >
      {Array.from({ length: count }, (_, i) => {
        const solved = isSolved(i);
        const cur = i === current;
        return (
          <button
            key={i}
            type="button"
            aria-label={sheet ? `Go to ${noun} ${i + 1}` : `${label} ${i + 1}`}
            aria-current={cur ? "true" : undefined}
            onClick={() => onPick(i)}
            className={`${sheet ? "h-11 w-11 text-sm" : "h-6 w-6 text-xs"} rounded-full border font-semibold ${
              solved
                ? "border-emerald-500 bg-emerald-500 text-white"
                : "border-(color:--cq-accent-line) bg-white text-(color:--cq-label)"
            } ${cur ? "ring-2 ring-(color:--cq-ring) ring-offset-1" : ""}`}
          >
            {i + 1}
          </button>
        );
      })}
    </div>
  );

  if (variant === "grid") return numbered(true);

  const step = (delta: number) => onPick(Math.min(count - 1, Math.max(0, current + delta)));

  return (
    <div className="flex flex-col gap-1">
      <div
        data-cq="puzzle-stepper"
        className="md:hidden flex h-11 items-center justify-center gap-3"
      >
        <button
          type="button"
          aria-label={`Previous ${noun}`}
          disabled={current <= 0}
          onClick={() => step(-1)}
          className="h-11 w-11 rounded-full text-lg font-bold text-(color:--cq-accent) disabled:opacity-30"
        >
          ‹
        </button>
        <span
          aria-live="polite"
          className="text-sm font-bold tabular-nums text-(color:--cq-ink)"
        >
          {current + 1} of {count}
        </span>
        {/* The dot strip is decoration for short packs only: at 14px a dot,
            the 35-puzzle arcade pack would need 490px of a 320px screen. The
            "n of N" text carries the position on its own past ten. */}
        {count <= STEPPER_DOTS_MAX ? (
          <span data-cq="puzzle-stepper-dots" aria-hidden className="flex gap-1.5">
            {Array.from({ length: count }, (_, i) => (
              <span
                key={i}
                className={`h-2 w-2 rounded-full ${
                  isSolved(i) ? "bg-emerald-500" : "bg-(color:--cq-accent-soft)"
                } ${i === current ? "ring-2 ring-(color:--cq-ring)" : ""}`}
              />
            ))}
          </span>
        ) : null}
        <button
          type="button"
          aria-label={`Next ${noun}`}
          disabled={current >= count - 1}
          onClick={() => step(1)}
          className="h-11 w-11 rounded-full text-lg font-bold text-(color:--cq-accent) disabled:opacity-30"
        >
          ›
        </button>
      </div>
      {numbered(false)}
    </div>
  );
}
