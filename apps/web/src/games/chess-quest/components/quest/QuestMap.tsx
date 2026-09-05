"use client";

// Quest map — Track 1/2 sections, lands, day-numbered stops. Port of
// js/app.js renderMap (78–126). ✓ = done, ♞ = current stop, else the day.
//
// Phone composition (design of record: "Quest hub on a phone" — Map as rows):
// at 320 all 62 chips were a ~1,400px wall above the lesson card, so each
// land is a 48px row that expands to its chips; the land holding the CURRENT
// lesson opens by default. ONE DOM: the collapse is `max-md:hidden` on the
// chip row, never a bare `hidden` (which would blank the chips on desktop
// too) and never the `hidden` ATTRIBUTE, which is width-blind for the same
// reason: tailwindcss@4 preflight emits
// `[hidden]:where(:not([hidden='until-found'])){display:none !important}`, so
// the attribute BEATS a display utility rather than losing to it, and a
// closed land would then vanish at every width.
//
// ≥768 keeps today's cards with every chip on screen, so the row toggle must
// do nothing there. `md:pointer-events-none` blocks the POINTER only: a
// keyboard user could still Tab to the row at 1280 and press Enter, flipping
// `aria-expanded` to false over a land whose chips are all on screen. Since
// `tabindex` cannot be varied by a media query, the gate has to be
// behavioural — `collapseInForce()` below — which leaves `aria-expanded`
// honest exactly where the collapse applies, and inert everywhere else. The
// alternative is a duplicate desktop header row, i.e. the second tree this
// composition is not allowed to build.
import { useState } from "react";
import { LANDS } from "../../content/lands";
import { LESSONS } from "../../content/lessons";
import { useProgress } from "../../lib/progress";
import { dayOf } from "./questData";

const weeksOf = (land: (typeof LANDS)[number]) =>
  Array.from({ length: land.weeks[1] - land.weeks[0] + 1 }, (_, k) => land.weeks[0] + k);

/**
 * Is the land collapse actually in force? True only below Tailwind's `md`
 * (768) — the one width band where `max-md:hidden` hides a closed land's
 * chips. Exported so the breakpoint and the SSR case are pinned by
 * __tests__/QuestMap.test.tsx without a DOM.
 */
export function collapseInForce(): boolean {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") return false;
  return window.matchMedia("(max-width: 767px)").matches;
}

export function QuestMap({
  selected,
  onSelect,
}: {
  selected: number;
  onSelect(n: number): void;
}) {
  const progress = useProgress();
  const current = progress.currentWeek(LESSONS.length);
  // The land the player is actually standing in — not LANDS[0], which is only
  // right for a player who has never finished a lesson.
  const [openLand, setOpenLand] = useState<number | null>(
    () => (LANDS.find((l) => current >= l.weeks[0] && current <= l.weeks[1]) ?? LANDS[0]).id,
  );

  return (
    <div className="flex flex-col gap-4 max-md:gap-2">
      {LANDS.map((land, idx) => {
        const track = land.track ?? 1;
        const prevTrack = idx > 0 ? (LANDS[idx - 1].track ?? 1) : 0;
        const showTrackHead = track !== prevTrack;
        const won = progress.landDone(land);
        const weeks = weeksOf(land);
        const doneHere = weeks.filter((n) => progress.isWeekDone(n)).length;
        const isOpen = openLand === land.id;
        const daysId = `cq-land-${land.id}-days`;
        return (
          <div key={land.id} className="flex flex-col gap-2">
            {showTrackHead ? (
              <div className="mt-1 flex items-baseline gap-2">
                <span className="text-xs font-semibold uppercase tracking-wide text-(color:--cq-accent-muted)">
                  Track {track}
                </span>
                <span className="mk-display text-sm font-bold text-(color:--cq-ink-muted)">
                  {track === 1
                    ? "First Steps"
                    : track === 2
                      ? "Rising Player"
                      : track === 3
                        ? "Opening Range"
                        : "Puzzle Gorge"}
                </span>
              </div>
            ) : null}

            <div className="rounded-2xl border border-slate-200 bg-white p-3 max-md:p-2">
              {/* A real button so the whole 48px row is the phone tap target;
                  inert at ≥768, where the chips below never collapse — see
                  collapseInForce() and the file header. */}
              <button
                type="button"
                aria-expanded={isOpen}
                aria-controls={daysId}
                onClick={() => {
                  if (!collapseInForce()) return;
                  setOpenLand(isOpen ? null : land.id);
                }}
                className="flex w-full items-center gap-2 text-left max-md:min-h-12 md:pointer-events-none"
              >
                <span className="text-xl">{land.glyph}</span>
                <div className="flex min-w-0 flex-col leading-tight">
                  <span className="text-xs text-slate-400">
                    Days {dayOf(land.weeks[0])}–{dayOf(land.weeks[1])}
                  </span>
                  <span className="mk-display truncate text-sm font-bold text-(color:--cq-ink)">
                    {land.name}
                  </span>
                </div>
                <span className="ml-auto shrink-0 text-xs text-slate-500 md:hidden">
                  {doneHere} of {weeks.length} done
                </span>
                <span
                  title={won ? "Badge earned!" : "Finish every day here to earn the badge"}
                  className={`ml-auto shrink-0 text-lg max-md:hidden ${won ? "" : "opacity-30 grayscale"}`}
                >
                  {land.glyph}
                </span>
                <span aria-hidden className="shrink-0 text-slate-400 md:hidden">
                  {isOpen ? "⌃" : "⌄"}
                </span>
              </button>

              <div
                id={daysId}
                className={`mt-2 flex flex-wrap gap-1.5 ${isOpen ? "" : "max-md:hidden"}`}
              >
                {weeks.map((n) => {
                  const isDone = progress.isWeekDone(n);
                  const isCur = n === current && !isDone;
                  const isSel = n === selected;
                  return (
                    <button
                      key={n}
                      type="button"
                      aria-label={`Day ${dayOf(n)}: ${LESSONS[n - 1].title}`}
                      onClick={() => onSelect(n)}
                      className={`h-9 min-w-9 rounded-lg border px-1 text-sm font-semibold transition max-md:h-11 max-md:min-w-11 ${
                        isDone
                          ? "border-emerald-500 bg-emerald-500 text-white"
                          : isCur
                            ? "border-(color:--cq-ring) bg-(color:--cq-accent-soft) text-(color:--cq-accent-strong)"
                            : "border-slate-200 bg-white text-slate-600"
                      } ${isSel ? "ring-2 ring-(color:--cq-ring) ring-offset-1" : ""}`}
                    >
                      {isDone ? "✓" : isCur ? "♞" : dayOf(n)}
                    </button>
                  );
                })}
              </div>
            </div>
          </div>
        );
      })}
    </div>
  );
}
