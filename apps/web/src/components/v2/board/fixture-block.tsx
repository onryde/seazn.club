"use client";

// One fixture block (v3/04 §2): 6px division hue bar + division-tint wash,
// short-code chip, a small icon badge when a violation touches it, lucide
// pin/lock affordance, and a single pick/place mechanism that serves mouse,
// touch and keyboard alike.
import { divisionAccent, divisionHue, divisionShortCode, divisionTint } from "@/lib/division-hue";
import type { FeedLabelPair } from "@/lib/schedule-board";
import { CONFLICT_LABEL, cardTitle, type BoardConflict, type BoardFixture } from "./types";
import { useMsg } from "@/components/i18n/dict-provider";
import type { MessageKey } from "@/lib/messages";
import { AlertTriangle, Lock, Pin } from "lucide-react";

export function FixtureBlock({
  fixture,
  divisionName,
  showDivision,
  entrantNames,
  feedLabels,
  conflicts,
  canEdit,
  picked,
  onPick,
  onTogglePin,
  time,
}: {
  fixture: BoardFixture;
  divisionName: string;
  /** Chip renders only on multi-division boards. */
  showDivision: boolean;
  entrantNames: Record<string, string>;
  feedLabels: Record<string, FeedLabelPair>;
  conflicts: BoardConflict[];
  canEdit: boolean;
  /** This block is the current pick (tap-to-assign source). */
  picked: boolean;
  onPick: () => void;
  onTogglePin: () => void;
  /** Optional time caption (agenda/tray contexts). */
  time?: string;
}) {
  const msg = useMsg();
  const movable = canEdit && fixture.status === "scheduled";
  const title = cardTitle(fixture, entrantNames, feedLabels);
  const statusLabel = (s: string) => {
    const key = `schedule.fstatus.${s}` as MessageKey;
    const label = msg(key);
    return label === key ? s.replace("_", " ") : label;
  };
  const conflictLabel = (code: string) => {
    const key = `board.conflict.${code}` as MessageKey;
    const label = msg(key);
    return label === key ? (CONFLICT_LABEL[code] ?? code) : label;
  };
  // Same conflict CODE can appear once per person it touches (a rest warning
  // fires for both D and E) — merge those into one badge with every detail
  // joined in the tooltip, rather than printing the same word twice.
  const conflictGroups = Object.values(
    conflicts.reduce<Record<string, BoardConflict[]>>((acc, c) => {
      (acc[c.code] ??= []).push(c);
      return acc;
    }, {}),
  );
  const blocking = conflicts.some((c) => c.blocking);
  // divisionAccent (62% sat / 48% light) fails WCAG AA (4.5:1) for white
  // chip text on 8 of the 12 division hues — as low as 1.98:1 on the
  // yellow-green stop (measured across the full HUES wheel in division-hue.ts).
  // The chip gets its own darker fill, same hue/saturation, tuned so white
  // text clears 4.5:1 on every stop (worst case, 76°, lands at 5.3:1).
  const chipBg = `hsl(${divisionHue(fixture.division_id)} 62% 28%)`;
  return (
    <div
      data-fixture-id={fixture.id}
      draggable={movable}
      onDragStart={(e) => e.dataTransfer.setData("text/fixture", fixture.id)}
      className={`group relative mb-0.5 rounded border border-slate-200 px-1.5 py-1 text-[11px] leading-tight ${
        picked ? "ring-2 ring-purple-500" : ""
      } ${movable ? "cursor-grab" : "opacity-80"}`}
      style={{
        borderLeftWidth: 6,
        borderLeftColor: divisionAccent(fixture.division_id),
        backgroundColor: divisionTint(fixture.division_id),
      }}
    >
      {/* Conflict severity is now a badge, not the card's own background —
          the background is the division's, and the two stopped sharing a
          channel. */}
      {conflicts.length > 0 && (
        <span
          aria-hidden
          className={`absolute -top-1.5 -right-1.5 grid h-4 w-4 place-items-center rounded-full ring-2 ring-white ${
            blocking ? "bg-red-600 text-white" : "bg-amber-700 text-white"
          }`}
        >
          <AlertTriangle className="h-2.5 w-2.5" strokeWidth={2.5} />
        </span>
      )}
      <div className="flex items-center gap-1">
        {/* A decided fixture is done — no scheduling handle. It comes back the
            moment the result is undone (status returns to 'scheduled'). */}
        {movable ? (
          <button
            type="button"
            onClick={onPick}
            aria-pressed={picked}
            aria-label={msg("board.block.pickAria", {
              title,
              n: fixture.round_no,
              state: picked ? msg("board.block.statePicked") : msg("board.block.statePick"),
            })}
            className="min-w-0 flex-1 truncate text-left font-medium text-slate-700 hover:text-purple-700"
          >
            {title}
          </button>
        ) : (
          <span className="min-w-0 flex-1 truncate text-left font-medium text-slate-600">
            {title}
          </span>
        )}
        {canEdit && fixture.status === "scheduled" && (
          <button
            type="button"
            onClick={onTogglePin}
            aria-label={fixture.schedule_locked ? msg("board.block.unlock") : msg("board.block.pin")}
            title={fixture.schedule_locked ? msg("board.block.lockedTitle") : msg("board.block.pinTitle")}
            className={fixture.schedule_locked ? "text-purple-700" : "text-slate-400 opacity-30 group-hover:opacity-100"}
          >
            {fixture.schedule_locked ? (
              <Lock className="h-3 w-3" strokeWidth={2.5} />
            ) : (
              <Pin className="h-3 w-3" strokeWidth={2.5} />
            )}
          </button>
        )}
      </div>
      <div className="flex flex-wrap items-center gap-1 text-[10px] text-slate-500">
        {showDivision && (
          <span
            title={divisionName}
            data-division-chip={divisionShortCode(divisionName)}
            className="rounded px-1 font-semibold text-white"
            style={{ backgroundColor: chipBg }}
          >
            {divisionShortCode(divisionName)}
          </span>
        )}
        {time && <span>{time}</span>}
        <span>R{fixture.round_no}</span>
        {fixture.status !== "scheduled" && <span className="text-sky-600">{statusLabel(fixture.status)}</span>}
        {conflictGroups.map((group) => {
          const head = group[0]!;
          const groupBlocking = group.some((c) => c.blocking);
          const detail = group.map((c) => c.detail).filter(Boolean).join("; ");
          return (
            <span
              key={head.code}
              title={detail || undefined}
              className={`rounded px-1 ${groupBlocking ? "bg-red-100 text-red-700" : "bg-amber-100 text-amber-700"}`}
            >
              {conflictLabel(head.code)}
            </span>
          );
        })}
      </div>
    </div>
  );
}
