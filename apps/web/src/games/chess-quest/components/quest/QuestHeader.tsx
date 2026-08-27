"use client";

// Quest header HUD — title, player + progress buttons, star total, days
// progress bar, land badges. Port of js/app.js renderHeader (45–75).
import { LANDS } from "../../content/lands";
import { LESSONS } from "../../content/lessons";
import { useCopy } from "../../lib/copy";
import { useProgress } from "../../lib/progress";

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

  return (
    <header className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 className="mk-display text-2xl font-bold text-(color:--cq-ink)">
          {name ? `${name}'s ` : ""}Chess Quest <span aria-hidden>♞</span>
        </h2>
        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            onClick={onOpenProfiles}
            className="rounded-full border border-(color:--cq-accent-line) bg-white px-3 py-1 text-sm font-medium text-(color:--cq-accent-strong) hover:bg-(color:--cq-accent-wash)"
          >
            👥 {name || "Players"}{" "}
            <span className="ml-1 rounded-full bg-(color:--cq-accent-soft) px-1.5 py-0.5 text-xs text-(color:--cq-label)">
              {isStory() ? "Story" : "Classic"}
            </span>
          </button>
          <button
            type="button"
            onClick={onOpenProgress}
            className="rounded-full border border-(color:--cq-accent-line) bg-white px-3 py-1 text-sm font-medium text-(color:--cq-accent-strong) hover:bg-(color:--cq-accent-wash)"
          >
            📊 Progress
          </button>
          <button
            type="button"
            aria-label={progress.getMuted() ? "Unmute sounds" : "Mute sounds"}
            aria-pressed={progress.getMuted()}
            onClick={() => progress.setMuted(!progress.getMuted())}
            className="rounded-full border border-(color:--cq-accent-line) bg-white px-2 py-1 text-sm hover:bg-(color:--cq-accent-wash)"
          >
            {progress.getMuted() ? "🔇" : "🔊"}
          </button>
          <button
            type="button"
            aria-label={progress.getVoiceOn() ? "Turn coach voice off" : "Turn coach voice on"}
            aria-pressed={progress.getVoiceOn()}
            onClick={() => progress.setVoiceOn(!progress.getVoiceOn())}
            className={`rounded-full border px-2 py-1 text-sm ${
              progress.getVoiceOn()
                ? "border-(color:--cq-accent-line) bg-white hover:bg-(color:--cq-accent-wash)"
                : "border-slate-200 bg-slate-100 opacity-50"
            }`}
          >
            🗣
          </button>
        </div>
      </div>

      <p className="max-w-2xl text-sm text-slate-600">
        {t(
          "One small lesson every other day — Day 1, Day 3, Day 5… — from first square to first tournament, with real games to play right here.",
          "One focused lesson every other day — Day 1, Day 3, Day 5… — from the empty board to confident club play, with drills to play right here.",
        )}
      </p>

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

      <div className="flex flex-wrap gap-1.5">
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
