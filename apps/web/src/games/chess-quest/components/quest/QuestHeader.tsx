"use client";

// Quest header HUD — title, player + progress buttons, star total, days
// progress bar, land badges. Port of js/app.js renderHeader (45–75).
//
// Phone composition (design of record: "Quest hub on a phone" — Header): the
// title takes its own row, the four device controls become 44px icon buttons
// on one row (their labels fold, their aria-labels do not, so the accessible
// name is identical at every width), and the two-sentence lede folds behind a
// title takes its own row, the four device controls become 44px icon buttons
// on one row (their labels fold, their aria-labels do not, so the accessible
// name is identical at every width), and the lede and the land-badge shelf
// are desktop-only (`max-md:hidden`) so today's lesson lands on the first
// screen. ONE DOM, branched: everything below 768 is `max-md:*`; ≥768
// renders exactly what it rendered before.
import { LANDS } from "../../content/lands";
import { LESSONS } from "../../content/lessons";
import { useCopy } from "../../lib/copy";
import { useProgress } from "../../lib/progress";

// Phone: 44px square icon button. Desktop: today's pill with its label.
const ICON_BUTTON =
  "max-md:inline-flex max-md:h-11 max-md:w-11 max-md:items-center max-md:justify-center max-md:px-0";

export function QuestHeader({
  onOpenProfiles,
  onOpenProgress,
}: {
  onOpenProfiles(): void;
  onOpenProgress(): void;
}) {
  const progress = useProgress();
  const { t, isStory } = useCopy();
  const name = progress.getName();
  const done = progress.weeksDone();
  const pct = (done / LESSONS.length) * 100;
  // Written once, rendered twice — see the file header on the two width
  // branches below.
  const lede = t(
    "One small lesson every other day — Day 1, Day 3, Day 5… — from first square to first tournament, with real games to play right here.",
    "One focused lesson every other day — Day 1, Day 3, Day 5… — from the empty board to confident club play, with drills to play right here.",
  );

  return (
    <header className="flex flex-col gap-3">
      <div
        data-cq-slot="header-row"
        className="flex flex-wrap items-center justify-between gap-3 max-md:flex-col max-md:items-start max-md:gap-2"
      >
        <h2 className="mk-display text-2xl font-bold text-(color:--cq-ink) max-md:text-xl">
          {name ? `${name}'s ` : ""}Chess Quest <span aria-hidden>♞</span>
        </h2>
        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            aria-label={name ? `Players — ${name}` : "Players"}
            onClick={onOpenProfiles}
            className={`rounded-full border border-(color:--cq-accent-line) bg-white px-3 py-1 text-sm font-medium text-(color:--cq-accent-strong) hover:bg-(color:--cq-accent-wash) ${ICON_BUTTON}`}
          >
            {/* The glyph is its own node so the phone button centres it: a
                flex container drops whitespace-only items but keeps the
                trailing space of a "👥 " text run. */}
            <span aria-hidden>👥</span>{" "}
            <span className="max-md:hidden">
              {name || "Players"}{" "}
              <span className="ml-1 rounded-full bg-(color:--cq-accent-soft) px-1.5 py-0.5 text-xs text-(color:--cq-label)">
                {isStory() ? "Story" : "Classic"}
              </span>
            </span>
          </button>
          <button
            type="button"
            aria-label="Progress"
            onClick={onOpenProgress}
            className={`rounded-full border border-(color:--cq-accent-line) bg-white px-3 py-1 text-sm font-medium text-(color:--cq-accent-strong) hover:bg-(color:--cq-accent-wash) ${ICON_BUTTON}`}
          >
            <span aria-hidden>📊</span> <span className="max-md:hidden">Progress</span>
          </button>
          <button
            type="button"
            aria-label={progress.getMuted() ? "Unmute sounds" : "Mute sounds"}
            aria-pressed={progress.getMuted()}
            onClick={() => progress.setMuted(!progress.getMuted())}
            className={`rounded-full border border-(color:--cq-accent-line) bg-white px-2 py-1 text-sm hover:bg-(color:--cq-accent-wash) ${ICON_BUTTON}`}
          >
            {progress.getMuted() ? "🔇" : "🔊"}
          </button>
          <button
            type="button"
            aria-label={progress.getVoiceOn() ? "Turn coach voice off" : "Turn coach voice on"}
            aria-pressed={progress.getVoiceOn()}
            onClick={() => progress.setVoiceOn(!progress.getVoiceOn())}
            className={`rounded-full border px-2 py-1 text-sm ${ICON_BUTTON} ${
              progress.getVoiceOn()
                ? "border-(color:--cq-accent-line) bg-white hover:bg-(color:--cq-accent-wash)"
                : "border-slate-200 bg-slate-100 opacity-50"
            }`}
          >
            🗣
          </button>
        </div>
      </div>

      {/* Phones: no lede at all — the page header already names the quest,
          and a folded "About" box cost 50px of the first screen that the
          lesson card needs (the live 320 drive put the Play button at 824px
          with it). ≥768: the plain paragraph, as before. */}
      <p className="max-w-2xl text-sm text-slate-600 max-md:hidden">{lede}</p>

      <div className="flex flex-wrap items-center gap-4">
        <span className="text-sm font-semibold text-amber-600">⭐ {progress.totalStars()}</span>
        <div className="min-w-48 flex-1">
          <div className="flex justify-between text-xs text-slate-500">
            <span>Quest progress</span>
            <span>
              {done} / {LESSONS.length} days
            </span>
          </div>
          <div className="mt-1 h-2 overflow-hidden rounded-full bg-(color:--cq-accent-soft)">
            <div className="h-full rounded-full bg-(color:--cq-ring)" style={{ width: `${pct}%` }} />
          </div>
        </div>
      </div>

      {/* Land badges are a desktop trophy shelf; on phones two rows of them
          sat between the header and today's lesson. The same completion state
          is in the map's land rows, so the shelf is desktop-only. */}
      <div data-cq-slot="land-badges" className="flex flex-wrap gap-1.5 max-md:hidden">
        {LANDS.map((land) => {
          const won = progress.landDone(land);
          return (
            <span
              key={land.id}
              title={`${land.name}${won ? " — complete!" : ""}`}
              className={`flex h-8 w-8 items-center justify-center rounded-full border text-lg ${
                won
                  ? "border-emerald-500 bg-emerald-50"
                  : "border-slate-200 bg-slate-50 opacity-50"
              }`}
            >
              {land.glyph}
            </span>
          );
        })}
      </div>
    </header>
  );
}
