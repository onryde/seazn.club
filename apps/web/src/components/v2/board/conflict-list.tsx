"use client";

// The list of conflicts an organiser is shown before a board goes live.
//
// Extracted from `schedule-gate-dialog.tsx` when the Start-tournament
// confirmation dialog (design 2026-09-20) needed the same rows for its
// PREVIEW. Two dialogs now show the same conflicts about the same board; if
// they rendered them from two copies of this code the reactive refusal and the
// proactive preview would drift apart, which is precisely the thing an
// organiser would read as the product contradicting itself.
//
// The lookups below are the conflicts panel's own, so a code reads identically
// wherever the organiser meets it.
import { useMsg } from "@/components/i18n/dict-provider";
import type { MessageKey } from "@/lib/messages";
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

export function ConflictList({
  conflicts,
  board,
  entrantNames,
  feedLabels,
  fixtureTitles: fixtureTitlesProp,
  testId,
  ariaLabel,
}: {
  conflicts: readonly BoardConflict[];
  board: BoardFixture[];
  entrantNames: Record<string, string>;
  feedLabels: Record<string, FeedLabelPair>;
  /** Competition-wide fixture id -> title, for a conflict's
   *  `details.other_fixture_id`. NOT safely derivable from `board` alone: a
   *  caller may pass a DIVISION-filtered board, and a cross-division
   *  counterparty is then invisible to a map built from it (C3 review findings
   *  2+3). Absent, this falls back to self-derivation — byte-for-byte the
   *  behaviour of a caller that has not been updated to pass one. */
  fixtureTitles?: Record<string, string>;
  /** `data-testid` for each ROW, so a spec never has to select on copy. */
  testId: string;
  /** Accessible name for the scroll region. A scrollable box owes a role, a
   *  name and `tabindex="0"` or axe reds `scrollable-region-focusable` at
   *  SERIOUS — and `tabindex` cannot be varied by media query, so it is
   *  unconditional. */
  ariaLabel: string;
}) {
  const msg = useMsg();
  const label = (code: string) => {
    const key = `board.conflict.${code}` as MessageKey;
    const out = msg(key);
    return out === key ? (CONFLICT_LABEL[code] ?? code) : out;
  };
  // Same fallback order as the conflicts panel: the generic code-level help
  // wins when the locale has it, otherwise this conflict's own structured
  // `details` (localized, name-resolved — never the deprecated raw `detail`
  // string, C3 2026-08-13 design amendment). NOT dead in production: this
  // branch is what an organiser sees for any code with neither a
  // `board.conflictHelp.<code>` key in any of the four dictionaries nor a
  // `CONFLICT_HELP` entry (`types.ts`).
  const help = (code: string, details?: BoardConflictDetail) => {
    const key = `board.conflictHelp.${code}` as MessageKey;
    const out = msg(key);
    if (out !== key) return out;
    if (CONFLICT_HELP[code]) return CONFLICT_HELP[code];
    return details ? formatBoardConflictDetail(details, { msg, entrantNames, fixtureTitles }) : "";
  };

  const byId = new Map(board.map((f) => [f.id, f]));
  const fixtureTitles =
    fixtureTitlesProp ?? Object.fromEntries(board.map((f) => [f.id, cardTitle(f, entrantNames, feedLabels)]));

  return (
    /* Scrolls inside itself: a board can be refused on a dozen conflicts and
       the sheet must still fit a 320px phone without the page scrolling. */
    <ul
      className="max-h-56 space-y-2 overflow-y-auto"
      tabIndex={0}
      role="group"
      aria-label={ariaLabel}
    >
      {conflicts.map((c, i) => {
        const f = byId.get(c.fixture_id);
        return (
          <li
            key={`${c.fixture_id}-${c.code}-${i}`}
            data-testid={testId}
            data-code={c.code}
            data-blocking={c.blocking ? "yes" : "no"}
            className={`rounded-lg border p-2 text-xs ${
              c.blocking ? "border-red-200 bg-red-50/60" : "border-amber-200 bg-amber-50/60"
            }`}
          >
            <p className="font-medium text-slate-800">
              {/* `msg` is passed on purpose: without it an unfilled slot's
                  label falls through to cardTitle's client-safe English
                  default regardless of this org's locale. */}
              {f ? cardTitle(f, entrantNames, feedLabels, msg) : msg("board.conflicts.removedFixture")}
            </p>
            <p className="mt-0.5 text-slate-600">
              <span
                className={`mr-1 rounded px-1 font-semibold ${
                  c.blocking ? "bg-red-100 text-red-700" : "bg-amber-100 text-amber-800"
                }`}
              >
                {label(c.code)}
              </span>
              {help(c.code, c.details)}
            </p>
          </li>
        );
      })}
    </ul>
  );
}
