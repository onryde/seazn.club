"use client";

// Board density mode (v3/04 §2): courts × time grid for one day. Empty cells
// are place targets — clickable and focusable, so drag-drop, tap-to-assign
// and keyboard placement all land on the same cells (v3/11 gap 11). Falls
// back to one "Unassigned venue" column when no courts are configured.
import { dayKey } from "@/lib/schedule-board";
import type { FeedLabelPair } from "@/lib/schedule-board";
import { FixtureBlock } from "./fixture-block";
import { timeLabel } from "@/lib/day-label";
import { divisionInk, divisionTint } from "@/lib/division-hue";
import { UNASSIGNED, type BoardConflict, type BoardFixture, type GhostBlock } from "./types";
import { useMsg } from "@/components/i18n/dict-provider";
import type { MessageKey } from "@/lib/messages";

const MIN = 60_000;

export function BoardGrid({
  day,
  slots,
  slotMinutes,
  courts,
  fixtures,
  divisionNames,
  entrantNames,
  feedLabels,
  conflictsByFixture,
  canEdit,
  multi,
  pickedId,
  onPick,
  onPlace,
  onDropCard,
  onTogglePin,
  venueCap,
  highlightId,
  ghosts,
}: {
  day: string;
  slots: number[];
  slotMinutes: number;
  /** Configured court labels; empty → single unassigned column. */
  courts: string[];
  /** Fixtures scheduled on this day (court may be null → unassigned column). */
  fixtures: BoardFixture[];
  divisionNames: Record<string, string>;
  entrantNames: Record<string, string>;
  feedLabels: Record<string, FeedLabelPair>;
  conflictsByFixture: Record<string, BoardConflict[]>;
  canEdit: boolean;
  multi: boolean;
  pickedId: string | null;
  onPick: (fixtureId: string) => void;
  onPlace: (atIso: string, court: string | null) => void;
  onDropCard: (fixtureId: string, atIso: string, court: string | null) => void;
  onTogglePin: (f: BoardFixture) => void;
  venueCap: string;
  highlightId: string | null;
  /** When set, an AI proposal is on screen: the grid swaps its live fixtures for
   *  the proposed layout as read-only ghost blocks (design §3). */
  ghosts?: GhostBlock[] | null;
}) {
  const msg = useMsg();
  const columns: (string | null)[] = courts.length > 0 ? courts : [null];
  const showGhosts = ghosts != null;

  // ROW HEIGHT TRACKS THE STEP (#datetime-ux prompt 05). Since the axis became
  // the solver's real `gcd(match, gap)` lattice, the same day is 14 rows at a
  // 60-minute step and 84 at a 10-minute one, so one fixed height cannot serve
  // both: the coarse board's 40px row turns the fine one into ~3400px of mostly
  // empty cells.
  //
  // IT TAKES BOTH CLASSES BELOW. The `td`'s own height is NOT what sets the row
  // — measured, an empty cell's floor is the place-target button's `min-h-8`,
  // so changing the `td` alone is inert and screenshots identically. Scaling
  // one without the other is the trap here.
  //
  // Floored, never scaled linearly: at a 5-minute step a proportional row would
  // be 3px. 24px is the floor because that is the WCAG 2.5.8 AA minimum target
  // size, and the button is a real drop/tap target. Cells holding a card grow
  // past either figure anyway — these are minimums.
  const compact = slotMinutes < 30;
  const rowHeight = compact ? "h-7" : "h-10";
  const placeHeight = compact ? "min-h-6" : "min-h-8";
  // At a fine step, labelling every row in full ("09:00 09:05 09:10 …") is
  // noise that buries the anchors, so half-hour marks stay dark and the rows
  // between them recede. A row that HOLDS something is always dark whatever the
  // clock says: muting the one label the organiser is reading a card against
  // was the first thing that went wrong when this was purely time-based.
  const inRow = (at: number, t: number) => at >= t && at < t + slotMinutes * MIN;
  const occupied = (t: number) =>
    showGhosts
      ? ghosts.some((g) => inRow(g.at, t))
      : fixtures.some((f) => inRow(new Date(f.scheduled_at as string).getTime(), t));
  const isMajor = (t: number) => new Date(t).getMinutes() % 30 === 0 || occupied(t);

  return (
    // Bounded VERTICALLY as well as horizontally: a fine step is legitimately
    // dozens of rows, and letting them stretch the page scrolls the court
    // headers off the top, which is the one thing a grid cannot afford. The
    // header is sticky inside this container so it survives that scroll.
    <div className="scroll-x scroll-x-fade max-h-[70vh] overflow-y-auto rounded-lg border border-slate-200 bg-white">
      <table className="w-full border-collapse text-xs" aria-label={msg("board.grid.aria", { day })}>
        <thead>
          <tr>
            <th className="sticky top-0 z-10 w-16 border-b border-slate-200 bg-slate-50 px-2 py-2 text-left font-medium text-slate-500">
              {msg("board.grid.time")}
            </th>
            {columns.map((c) => (
              <th
                key={c ?? UNASSIGNED}
                className="sticky top-0 z-10 min-w-36 border-b border-slate-200 border-l bg-slate-50 px-2 py-2 text-left font-medium text-slate-600"
              >
                {c ?? msg("board.grid.unassignedCol", { venue: venueCap.toLowerCase() })}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {slots.map((t) => (
            <tr key={t}>
              <td
                className={`border-b border-slate-100 px-2 py-1 align-top tabular-nums ${
                  isMajor(t) ? "text-slate-500" : "text-slate-300"
                }`}
              >
                {timeLabel(t)}
              </td>
              {columns.map((court) => {
                const inSlot = (at: number) => at >= t && at < t + slotMinutes * MIN;
                const sameCol = (c: string | null) => (court === null ? c === null : c === court);
                const cell = fixtures.filter(
                  (f) => sameCol(f.court_label) && inSlot(new Date(f.scheduled_at as string).getTime()),
                );
                const cellGhosts = showGhosts
                  ? ghosts!.filter((g) => sameCol(g.court) && inSlot(g.at))
                  : [];
                const iso = new Date(t).toISOString();
                return (
                  <td
                    key={court ?? UNASSIGNED}
                    className={`${rowHeight} border-b border-l border-slate-100 px-1 py-0.5 align-top`}
                    onDragOver={canEdit && !showGhosts ? (e) => e.preventDefault() : undefined}
                    onDrop={
                      canEdit && !showGhosts
                        ? (e) => {
                            e.preventDefault();
                            const fid = e.dataTransfer.getData("text/fixture");
                            if (fid) onDropCard(fid, iso, court);
                          }
                        : undefined
                    }
                  >
                    {/* AI proposal on screen: read-only ghost preview (§3). */}
                    {showGhosts
                      ? cellGhosts.map((g) => <GhostBlockView key={g.id} ghost={g} msg={msg} />)
                      : cell.map((f) => (
                          <div key={f.id} className={highlightId === f.id ? "animate-pulse" : undefined}>
                            <FixtureBlock
                              fixture={f}
                              divisionName={divisionNames[f.division_id] ?? ""}
                              showDivision={multi}
                              entrantNames={entrantNames}
                              feedLabels={feedLabels}
                              conflicts={conflictsByFixture[f.id] ?? []}
                              canEdit={canEdit}
                              picked={pickedId === f.id}
                              onPick={() => onPick(f.id)}
                              onTogglePin={() => onTogglePin(f)}
                            />
                          </div>
                        ))}
                    {!showGhosts && canEdit && cell.length === 0 && (
                      <button
                        type="button"
                        onClick={() => onPlace(iso, court)}
                        aria-label={
                          court
                            ? msg("board.grid.placeAriaCourt", { time: timeLabel(t), court })
                            : msg("board.grid.placeAriaUnassigned", { time: timeLabel(t) })
                        }
                        className={`h-full ${placeHeight} w-full rounded text-[10px] transition ${
                          pickedId
                            ? "border border-dashed border-purple-300 text-purple-600 hover:border-purple-500 hover:bg-purple-50 focus-visible:border-purple-500 focus-visible:bg-purple-50"
                            : "text-transparent focus-visible:border focus-visible:border-dashed focus-visible:border-purple-300 focus-visible:text-purple-600"
                        }`}
                        tabIndex={pickedId ? 0 : -1}
                        disabled={!pickedId}
                      >
                        {pickedId ? msg("board.grid.placeHere") : ""}
                      </button>
                    )}
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** Fixtures scheduled on `day` (time set; court may be null). */
export function fixturesOn(fixtures: BoardFixture[], day: string): BoardFixture[] {
  return fixtures.filter(
    (f) => f.scheduled_at !== null && dayKey(f.scheduled_at as string) === day,
  );
}

// The state-palette styling for each ghost tone (design §1). Translucent + dashed
// throughout so a proposal never reads as committed placement.
const GHOST_TONE: Record<GhostBlock["tone"], string> = {
  moved: "border-amber-400 bg-amber-50/70 text-amber-900",
  placed: "border-teal-400 bg-teal-50/70 text-teal-900",
  blocking: "border-red-400 bg-red-50/80 text-red-900",
  unchanged: "border-slate-300 bg-slate-50/60 text-slate-500 opacity-70",
};

/** One proposal ghost: dashed + translucent, tone-coloured, ≥40px, code + JR/Final
 *  marker + matchup + time only. Provenance stays in the diff list (§3). */
function GhostBlockView({ ghost, msg }: { ghost: GhostBlock; msg: (k: MessageKey, v?: Record<string, string | number>) => string }) {
  const marker = ghost.isFinal ? "FINAL" : ghost.isJunior ? "JR" : null;
  return (
    <div
      data-ghost-id={ghost.id}
      aria-label={msg("board.ai.ghost.aria", { code: ghost.code, matchup: ghost.matchup, time: timeLabel(ghost.at) })}
      className={`mb-0.5 min-h-10 rounded border border-dashed px-1.5 py-1 text-[11px] leading-tight ${GHOST_TONE[ghost.tone]} ${
        ghost.pulse ? "animate-pulse ring-2 ring-red-400" : ""
      }`}
    >
      <div className="flex items-center gap-1">
        <span className="font-mono text-[10px] font-semibold">{ghost.code}</span>
        {/* Joint proposals only: the same division chip the real cards wear, so
            a repainted competition board still reads as several divisions. */}
        {ghost.division && (
          <span
            title={ghost.division.name}
            className="shrink-0 truncate rounded px-1 text-[9px] font-semibold"
            style={{
              backgroundColor: divisionTint(ghost.division.id),
              color: divisionInk(ghost.division.id),
            }}
          >
            {ghost.division.name}
          </span>
        )}
        {marker && (
          <span
            className={`shrink-0 rounded px-1 text-[8px] font-bold leading-tight ${
              ghost.isFinal ? "bg-purple-200/70 text-purple-800" : "bg-sky-200/70 text-sky-800"
            }`}
          >
            {marker}
          </span>
        )}
        <span className="ml-auto shrink-0 tabular-nums text-[9px] opacity-80">{timeLabel(ghost.at)}</span>
      </div>
      <p className="mt-0.5 truncate font-medium">{ghost.matchup}</p>
    </div>
  );
}
