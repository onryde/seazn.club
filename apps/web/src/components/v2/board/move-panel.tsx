"use client";

// Precise move for the picked fixture: pick court + exact time, hit Move.
// The keyboard-accessible alternative to dragging since PROMPT-17; in v3 it
// rides the same pick state as tap-to-assign (v3/11 gap 11).
import { useMemo, useState } from "react";
import { toLocalInput, windowsToDailyHours, type FeedLabelPair } from "@/lib/schedule-board";
import { zonedTimeInput } from "@/lib/zoned-datetime";
import { cardTitle, type BoardConfig, type BoardFixture } from "./types";
import { useMsg } from "@/components/i18n/dict-provider";
import { DateTimeField } from "../shared/datetime-field";
import { boardSlotTimes } from "../shared/time-options";

export function MovePanel({
  fixture,
  courts,
  venueCap = "Court",
  entrantNames,
  feedLabels,
  boardConfig = null,
  onMove,
  onClose,
}: {
  fixture: BoardFixture;
  courts: string[];
  venueCap?: string;
  entrantNames: Record<string, string>;
  feedLabels: Record<string, FeedLabelPair>;
  /**
   * The board's own schedule config plus its governing venue clock, so this
   * panel's time select can offer the division's actual board slots (e.g.
   * 09:00, 09:40, 10:20 on a 40-minute/0-gap division) instead of a
   * quarter-hour grid the board isn't on — see the quarter-hour-time-select
   * design doc, "Why fixture-level fields differ". Threaded down from
   * `ScheduleBoard`, which already holds both, rather than fetched here.
   *
   * `config.startAt` is a stored INSTANT; it is converted to the org zone's
   * wall clock via `zonedTimeInput(…, orgTz)` before it becomes
   * `boardSlotTimes`' anchor — `orgTz` (`settings.orgTz`) is the governing
   * clock, never `settings.tz` (display-only, #448) and never the browser
   * zone. `null`, or a config that yields fewer than 2 slots, falls back to
   * the shared quarter-hour list — see `boardSlotOptions` below.
   */
  boardConfig?: { config: BoardConfig; orgTz: string } | null;
  onMove: (atIso: string | null, court: string | null) => void;
  onClose: () => void;
}) {
  const msg = useMsg();
  const [when, setWhen] = useState(
    fixture.scheduled_at ? toLocalInput(fixture.scheduled_at) : "",
  );
  const [court, setCourt] = useState(fixture.court_label ?? courts[0] ?? "");

  // `undefined` here (rather than an empty array) is what makes DateTimeField
  // fall back to its own generated quarter-hour list — the design's rule 2
  // fallback — both when there is no config yet and when one produced fewer
  // than 2 slots (an empty/degenerate board should never offer a 0- or
  // 1-entry select).
  const boardSlotOptions = useMemo((): string[] | undefined => {
    if (
      boardConfig === null ||
      boardConfig === undefined ||
      boardConfig.config.startAt === null ||
      boardConfig.config.startAt === undefined ||
      boardConfig.config.startAt === ""
    ) {
      return undefined;
    }
    const daily = windowsToDailyHours(boardConfig.config.sessionWindows, boardConfig.orgTz);
    const slots = boardSlotTimes({
      anchor: zonedTimeInput(boardConfig.config.startAt, boardConfig.orgTz),
      matchMinutes: boardConfig.config.matchMinutes,
      gapMinutes: boardConfig.config.gapMinutes,
      playFrom: daily?.from,
      playTo: daily?.to,
    });
    return slots.length >= 2 ? slots : undefined;
  }, [boardConfig]);

  return (
    <div
      role="dialog"
      aria-label={msg("board.moveAria", { title: cardTitle(fixture, entrantNames, feedLabels) })}
      className="flex flex-wrap items-end gap-2 rounded-lg border border-purple-200 bg-purple-50 p-3"
      onKeyDown={(e) => {
        if (e.key === "Escape") onClose();
      }}
    >
      <p className="w-full text-xs font-medium text-purple-800">
        {msg("board.moveLabel", { title: cardTitle(fixture, entrantNames, feedLabels) })}
        <span className="ml-2 font-normal text-purple-700">
          {msg("board.moveHint")}
        </span>
      </p>
      <DateTimeField
        kind="datetime-local"
        value={when}
        onChange={setWhen}
        label={msg("board.when")}
        options={boardSlotOptions}
      />
      <label className="block">
        <span className="label">{venueCap}</span>
        <select value={court} onChange={(e) => setCourt(e.target.value)} className="input px-2 py-1 text-xs">
          {courts.length === 0 && <option value="">{msg("board.unassigned")}</option>}
          {courts.map((c) => (
            <option key={c} value={c}>{c}</option>
          ))}
        </select>
      </label>
      <button
        type="button"
        onClick={() => onMove(when ? new Date(when).toISOString() : null, court || null)}
        className="btn btn-primary px-3 py-1.5 text-xs"
      >
        {msg("board.move")}
      </button>
      <button type="button" onClick={onClose} className="btn btn-ghost px-3 py-1.5 text-xs">
        {msg("board.cancel")}
      </button>
    </div>
  );
}
