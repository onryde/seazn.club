"use client";

// Precise move for the picked fixture: pick court + exact time, hit Move.
// The keyboard-accessible alternative to dragging since PROMPT-17; in v3 it
// rides the same pick state as tap-to-assign (v3/11 gap 11).
import { useMemo, useState } from "react";
import { windowsToDailyHours, type FeedLabelPair } from "@/lib/schedule-board";
import { isoFromZonedDateTime, zonedDateTimeInput, zonedTimeInput } from "@/lib/zoned-datetime";
import { cardTitle, type BoardConfig, type BoardFixture } from "./types";
import { useMsg } from "@/components/i18n/dict-provider";
import { DateTimeField } from "../shared/datetime-field";
import { boardSlotTimes } from "../shared/time-options";

export function MovePanel({
  fixture,
  courts,
  courtNames,
  venueCap = "Court",
  entrantNames,
  feedLabels,
  boardConfig,
  onMove,
  onClose,
}: {
  fixture: BoardFixture;
  /** P9 scope item 5: entries are `courts.id` uuids when the board's own
   *  `cfg.courts` (real ids since P9 pass 1) supplied them — see
   *  `schedule-board.tsx`'s own `courts` memo for the (pre-existing, not
   *  this pass's to fix) caveat that a pre-cutover fixture's frozen
   *  `court_label` can still ride along in this array. Never rendered raw:
   *  `courtNames` resolves each entry to a display name. */
  courts: string[];
  /** id -> display name, built from the org's own venues/courts (P9 scope
   *  item 5). Optional: an entry with no mapping falls back to rendering
   *  the raw value, matching this panel's behaviour before `courtNames`
   *  existed — existing callers that don't pass it are unaffected. */
  courtNames?: Record<string, string>;
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
   * zone. A config that yields fewer than 2 slots falls back to the shared
   * quarter-hour list — see `boardSlotOptions` below.
   *
   * REQUIRED, deliberately. It shipped optional-with-a-null-default and the
   * board — its only caller — never passed it, so the board-slot list was
   * unreachable in production while every test that exercised it passed one
   * in directly. `orgTz` is also what the value itself is seeded and emitted
   * on now, so an absent config would mean a panel with no clock at all
   * rather than a panel with a coarser list.
   */
  boardConfig: { config: BoardConfig; orgTz: string };
  onMove: (atIso: string | null, court: string | null) => void;
  onClose: () => void;
}) {
  const msg = useMsg();
  // THE WHOLE PANEL SPEAKS ONE CLOCK, and it is the venue's (#448).
  //
  // This used to seed from `toLocalInput`, which is deliberately the BROWSER's
  // zone. That was survivable while the field was a bare datetime-local — the
  // organiser typed a wall clock and it round-tripped through the same zone it
  // came from. It stopped being survivable once the time half became a list
  // generated from `startAt` on `orgTz`: the value and the options would be
  // two different clocks in one control, so an organiser working from a
  // different zone than the venue saw the board's grid plus their own time as
  // a stray extra option (injected by `timeOptions`' value rule, so no crash —
  // just a control quietly describing two timetables at once).
  const [when, setWhen] = useState(
    fixture.scheduled_at ? zonedDateTimeInput(fixture.scheduled_at, boardConfig.orgTz) : "",
  );
  // P9 scope item 5: seeded from `court_id`, never `court_label` — the
  // latter is FROZEN and stays null on anything scheduled since the
  // cutover (schedule.ts stopped writing it). `court_id` is what every
  // write path (`moveFixture`'s own `PatchFixture`, `.strict()`) actually
  // reads back, so seeding from it is what keeps the reopened panel's
  // preselected court in sync with reality.
  const [court, setCourt] = useState(fixture.court_id ?? courts[0] ?? "");

  // `undefined` here (rather than an empty array) is what makes DateTimeField
  // fall back to its own generated quarter-hour list — the design's rule 2
  // fallback — both when there is no config yet and when one produced fewer
  // than 2 slots (an empty/degenerate board should never offer a 0- or
  // 1-entry select).
  const boardSlotOptions = useMemo((): string[] | undefined => {
    if (
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
      // Fix round 3 (Important 3): both call sites below were missing the
      // `lookup` arg, so an unfilled slot's label fell through to cardTitle's
      // client-safe English default instead of this org's real locale, even
      // though `msg` (useMsg()) is right here.
      aria-label={msg("board.moveAria", { title: cardTitle(fixture, entrantNames, feedLabels, msg) })}
      className="flex flex-wrap items-end gap-3 rounded-lg border border-purple-100 bg-white p-3 shadow-sm"
      onKeyDown={(e) => {
        if (e.key === "Escape") onClose();
      }}
    >
      <div className="mr-1 flex flex-col gap-0.5">
        <span className="text-xs font-semibold text-purple-700">
          {msg("board.moveLabel", { title: cardTitle(fixture, entrantNames, feedLabels, msg) })}
        </span>
        {/* 11px on white: slate-500 measures 4.35:1 here (below the 4.5:1 AA
            floor per the ai-diff-panel axe finding, 2026-08-09) — slate-600. */}
        <span className="text-[11px] text-slate-600">{msg("board.moveHint")}</span>
      </div>
      <div className="w-80 max-w-full">
        <DateTimeField
          kind="datetime-local"
          value={when}
          onChange={setWhen}
          label={msg("board.when")}
          options={boardSlotOptions}
        />
      </div>
      <label className="block">
        <span className="label">{venueCap}</span>
        {/* `.select`'s own padding loses to `px-2 py-1 text-xs` under
            Tailwind's utilities layer (S13/#422 W11). `min-h-11` survives it. */}
        <select value={court} onChange={(e) => setCourt(e.target.value)} className="input min-h-11 px-2 py-1 text-xs">
          {courts.length === 0 && <option value="">{msg("board.unassigned")}</option>}
          {courts.map((c) => (
            <option key={c} value={c}>{courtNames?.[c] ?? c}</option>
          ))}
        </select>
      </label>
      <div className="ml-auto flex gap-2">
        <button type="button" onClick={onClose} className="btn btn-ghost px-3 py-1.5 text-xs">
          {msg("board.cancel")}
        </button>
        <button
          type="button"
          // Resolved on the venue clock, matching the seed and the option list
          // above. `new Date(when)` here would read the wall clock the organiser
          // just picked off the BOARD'S grid as the BROWSER's, storing an instant
          // the offset away from the slot they chose.
          onClick={() =>
            onMove(when ? isoFromZonedDateTime(when, boardConfig.orgTz) : null, court || null)
          }
          className="btn btn-primary px-3 py-1.5 text-xs"
        >
          {msg("board.move")}
        </button>
      </div>
    </div>
  );
}
