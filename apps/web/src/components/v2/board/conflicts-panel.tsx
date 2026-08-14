"use client";

// Conflicts surfaced, not buried (v3/04 §2): a badge count in the board
// header opens this side panel — every violation listed in plain English
// with a jump-to-fixture link. Blocks carry a red corner tick separately.
import { useEffect, useRef } from "react";
import type { FeedLabelPair } from "@/lib/schedule-board";
import {
  CONFLICT_HELP,
  CONFLICT_LABEL,
  cardTitle,
  type BoardConflict,
  type BoardConflictDetail,
  type BoardFixture,
} from "./types";
import { formatBoardConflictDetail } from "./conflict-detail-format";
import { useMsg, usePlural } from "@/components/i18n/dict-provider";
import type { MessageKey } from "@/lib/messages";

/**
 * The count badge, plus the state that only exists because the count can lie
 * (#230 item 5).
 *
 * A failed check leaves `conflicts` at whatever the last successful one
 * returned — often nothing at all, which renders identically to a clean board.
 * So the unavailable notice has to survive `count === 0`, which is exactly
 * where the badge itself returns `null`. Ordering the early return AFTER the
 * failure check is the whole fix on this side; putting it back first hides the
 * only signal an organiser ever gets.
 */
export function ConflictsBadge({
  count,
  open,
  onToggle,
  checkFailed,
  checking,
  onRetry,
}: {
  count: number;
  open: boolean;
  onToggle: () => void;
  checkFailed: boolean;
  checking: boolean;
  onRetry: () => void;
}) {
  const plural = usePlural();
  if (count === 0 && !checkFailed) return null;
  return (
    <span className="inline-flex flex-wrap items-center gap-1.5">
      {count > 0 && (
        <button
          type="button"
          onClick={onToggle}
          aria-expanded={open}
          aria-label={plural("board.conflicts.badgeAria", count)}
          className="inline-flex min-h-8 items-center gap-1 rounded-full border border-amber-300 bg-amber-50 px-2.5 py-1 text-xs font-semibold text-amber-800 hover:bg-amber-100"
        >
          {plural("board.conflicts.badge", count)}
        </button>
      )}
      {/* …but NOT while the panel is open. The panel renders the same notice,
          with the same accessible name, so both together are two `role="status"`
          regions announcing one sentence and two buttons answering to "Check
          again" — a strict locator then resolves neither. The panel is the more
          specific surface, so the toolbar yields to it. */}
      {checkFailed && !open && <CheckUnavailable checking={checking} onRetry={onRetry} />}
    </span>
  );
}

/** "Conflict check unavailable · Check again" — one component so the toolbar
 *  and the panel cannot drift into two different ways of saying it. */
function CheckUnavailable({ checking, onRetry }: { checking: boolean; onRetry: () => void }) {
  const msg = useMsg();
  return (
    <span
      role="status"
      className="inline-flex min-h-8 flex-wrap items-center gap-1.5 rounded-full border border-slate-300 bg-slate-50 px-2.5 py-1 text-xs text-slate-600"
    >
      <span aria-hidden>⚠</span>
      <span>{msg("board.conflicts.checkFailed")}</span>
      <button
        type="button"
        onClick={onRetry}
        disabled={checking}
        className="font-semibold text-purple-700 hover:underline disabled:cursor-not-allowed disabled:opacity-50"
      >
        {msg("board.conflicts.retryCheck")}
      </button>
    </span>
  );
}

export function ConflictsPanel({
  conflicts,
  board,
  entrantNames,
  feedLabels,
  divisionNames,
  onJump,
  onClose,
  checkFailed,
  checking,
  onRetryCheck,
  fixtureTitles: fixtureTitlesProp,
}: {
  conflicts: BoardConflict[];
  board: BoardFixture[];
  entrantNames: Record<string, string>;
  feedLabels: Record<string, FeedLabelPair>;
  divisionNames: Record<string, string>;
  onJump: (fixtureId: string) => void;
  onClose: () => void;
  /** #230 item 5 — a list nobody could refresh is not the same as a clean one. */
  checkFailed: boolean;
  checking: boolean;
  onRetryCheck: () => void;
  /** Competition-wide fixture id -> title (`cardTitle` output), for a
   *  conflict's `details.otherFixtureId` (C3 review findings 2+3). Optional
   *  — a required prop would break every existing test constructing this
   *  panel directly, same reasoning `FixtureBlock`'s own `fixtureTitles`
   *  prop and commit 335d750d's `entrantNames` both used. `board` here is
   *  whatever the caller passed, and schedule-board.tsx passes the
   *  DIVISION-filtered view (`board = actions.board.filter((f) =>
   *  visibleIds.has(f.division_id))`) — a cross-division counterparty is
   *  invisible to it, the same axis `FixtureBlock`'s own fix already
   *  covers. When supplied, this should be built from the UNFILTERED board
   *  (schedule-board.tsx's `actions.board`). Absent, this panel falls back
   *  to deriving from its own `board` prop below — byte-for-byte its prior
   *  behaviour, for a caller that has not been updated to pass it. */
  fixtureTitles?: Record<string, string>;
}) {
  const msg = useMsg();
  const conflictLabel = (code: string) => {
    const key = `board.conflict.${code}` as MessageKey;
    const label = msg(key);
    return label === key ? (CONFLICT_LABEL[code] ?? code) : label;
  };
  // The generic code-level help wins when the locale has it; otherwise this
  // conflict's own structured `details` — localized and name-resolved,
  // never the deprecated raw `detail` string, which can carry a UUID (C3,
  // 2026-08-13 design amendment). NOT dead in production (a prior comment
  // here claimed it was): `conflict.start_window` is a live
  // `ScheduleConflict.code` (`lib/schedule-board.ts:39`) with neither a
  // `board.conflictHelp.conflict.start_window` key in any of the four
  // dictionaries nor a `CONFLICT_HELP` entry (`types.ts`) — this branch is
  // what an organiser actually sees for it today, and the improvement above
  // (structured, name-resolved detail instead of the old raw `detail`
  // string) reaches that live case. Kept for every other unmapped future
  // code too.
  const conflictHelp = (code: string, details?: BoardConflictDetail) => {
    const key = `board.conflictHelp.${code}` as MessageKey;
    const help = msg(key);
    if (help !== key) return help;
    if (CONFLICT_HELP[code]) return CONFLICT_HELP[code];
    return details ? formatBoardConflictDetail(details, { msg, entrantNames, fixtureTitles }) : "";
  };
  const ref = useRef<HTMLElement | null>(null);
  useEffect(() => {
    ref.current?.focus();
  }, []);
  const byId = new Map(board.map((f) => [f.id, f]));
  // Competition-wide fixture id -> title, for a conflict's
  // `details.otherFixtureId`. NOT safely derivable from `board` alone (a
  // prior comment here claimed it was, "unfiltered by day" — true on the
  // DAY axis, false on the DIVISION one): schedule-board.tsx passes this
  // panel the division-filtered `board`, so a cross-division counterparty
  // is invisible to a map built from it, the same gap `FixtureBlock`'s own
  // `fixtureTitles` prop already covers (C3 review findings 2+3). Prefer
  // the caller-supplied, board-wide map; fall back to the filtered
  // self-derivation only when no caller has been updated to pass one.
  const fixtureTitles =
    fixtureTitlesProp ?? Object.fromEntries(board.map((f) => [f.id, cardTitle(f, entrantNames, feedLabels)]));
  return (
    <aside
      ref={ref as React.RefObject<HTMLElement>}
      tabIndex={-1}
      role="region"
      aria-label={msg("board.conflicts.regionAria")}
      onKeyDown={(e) => {
        if (e.key === "Escape") onClose();
      }}
      className="fixed inset-x-0 bottom-0 z-40 max-h-[70vh] overflow-y-auto rounded-t-2xl border border-slate-200 bg-white p-4 shadow-xl outline-none sm:inset-x-auto sm:top-24 sm:right-4 sm:bottom-auto sm:w-96 sm:max-h-[70vh] sm:rounded-xl"
    >
      <div className="mb-2 flex items-center justify-between">
        <h3 className="text-sm font-semibold text-slate-800">
          {msg("board.conflicts.title", { n: conflicts.length })}
        </h3>
        <button
          type="button"
          onClick={onClose}
          aria-label={msg("board.conflicts.closeAria")}
          className="btn btn-ghost px-2 py-1 text-xs"
        >
          ✕
        </button>
      </div>
      {/* The list dates itself. Without this line an empty panel is an
          assertion ("nothing is wrong") that the app may have no evidence for. */}
      <p className="mb-2 text-[11px] text-slate-500">
        {checkFailed ? (
          <CheckUnavailable checking={checking} onRetry={onRetryCheck} />
        ) : (
          msg("board.conflicts.checkedJustNow")
        )}
      </p>
      <ul className="space-y-2">
        {conflicts.map((c, i) => {
          const f = byId.get(c.fixture_id);
          return (
            <li
              key={`${c.fixture_id}-${c.code}-${i}`}
              className={`rounded-lg border p-2.5 text-xs ${
                c.blocking ? "border-red-200 bg-red-50/60" : "border-amber-200 bg-amber-50/60"
              }`}
            >
              <p className="font-medium text-slate-800">
                {/* Fix round 3 (Important 3): `lookup` was left off — an
                    unfilled slot's label fell through to cardTitle's
                    client-safe English default instead of `msg` (useMsg(),
                    line 116), regardless of this org's locale. */}
                {f ? cardTitle(f, entrantNames, feedLabels, msg) : msg("board.conflicts.removedFixture")}
                {f && divisionNames[f.division_id] ? (
                  <span className="ml-1 font-normal text-slate-500">
                    · {divisionNames[f.division_id]}
                  </span>
                ) : null}
              </p>
              <p className="mt-0.5 text-slate-600">
                <span
                  className={`mr-1 rounded px-1 font-semibold ${
                    c.blocking ? "bg-red-100 text-red-700" : "bg-amber-100 text-amber-800"
                  }`}
                >
                  {conflictLabel(c.code)}
                </span>
                {conflictHelp(c.code, c.details)}
              </p>
              {f && (
                <button
                  type="button"
                  onClick={() => onJump(c.fixture_id)}
                  className="mt-1.5 font-medium text-purple-700 hover:underline"
                >
                  {msg("board.conflicts.jump")}
                </button>
              )}
            </li>
          );
        })}
      </ul>
    </aside>
  );
}
