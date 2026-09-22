"use client";

// The ONE renderer for a list of `ScheduleConflict` rows in an organiser-facing
// refusal.
//
// Extracted verbatim from `schedule-gate-dialog.tsx` when the competition
// board's "Publish all" banner needed to show, per blocked division, exactly
// the same conflict rows the gate dialog shows — same label lookup, same help
// fallback ladder, same `data-*` hooks. A second hand-rolled copy is how the
// two surfaces start disagreeing about what `conflict.court` is called, and
// this subsystem's recurring defect is precisely a forked second path.
//
// The markup here is byte-for-byte what the dialog rendered before the
// extraction, which is why `schedule-gate-dialog.test.tsx` (22KB of markup
// assertions) is the regression net for this file.
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
  className,
  testId = "board-gate-conflict",
  keyPrefix = "",
}: {
  conflicts: BoardConflict[];
  board: BoardFixture[];
  entrantNames: Record<string, string>;
  feedLabels: Record<string, FeedLabelPair>;
  /** Competition-wide fixture id -> title, for a conflict's
   *  `details.other_fixture_id`. Absent → derived from `board`, which is
   *  whatever the caller passed (see the dialog's own prop doc). */
  fixtureTitles?: Record<string, string>;
  /** The `<ul>` classes. The gate dialog scrolls inside itself; a surface with
   *  room to grow passes its own, because an `overflow-y-auto` region owes axe
   *  a `tabindex`/role/name and a banner does not need one. */
  className?: string;
  testId?: string;
  /** Disambiguates React keys when several lists render on one surface. */
  keyPrefix?: string;
}) {
  const msg = useMsg();
  // The same two lookups the conflicts panel uses, so a code reads identically
  // whether the organiser met it in the panel or in this refusal.
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
  // `CONFLICT_HELP` entry (`types.ts`). `conflict.start_window`
  // (`lib/schedule-board.ts:39`) used to be exactly that case; it gained
  // both (P95 windows pass) and now resolves through the locale key above
  // instead. Kept for every other unmapped future code.
  const help = (code: string, details?: BoardConflictDetail) => {
    const key = `board.conflictHelp.${code}` as MessageKey;
    const out = msg(key);
    if (out !== key) return out;
    if (CONFLICT_HELP[code]) return CONFLICT_HELP[code];
    return details ? formatBoardConflictDetail(details, { msg, entrantNames, fixtureTitles }) : "";
  };

  const byId = new Map(board.map((f) => [f.id, f]));
  // Competition-wide fixture id -> title, for a conflict's
  // `details.otherFixtureId`. NOT safely derivable from `board` alone (a
  // prior comment here claimed it was): schedule-board.tsx passes the gate
  // dialog the division-filtered `board`, so a cross-division counterparty
  // is invisible to a map built from it (C3 review findings 2+3). Prefer
  // the caller-supplied, board-wide map; fall back to the filtered
  // self-derivation only when no caller has been updated to pass one.
  const fixtureTitles =
    fixtureTitlesProp ?? Object.fromEntries(board.map((f) => [f.id, cardTitle(f, entrantNames, feedLabels)]));

  return (
    <ul className={className}>
      {conflicts.map((c, i) => {
        const f = byId.get(c.fixture_id);
        return (
          <li
            key={`${keyPrefix}${c.fixture_id}-${c.code}-${i}`}
            data-testid={testId}
            data-code={c.code}
            data-blocking={c.blocking ? "yes" : "no"}
            className={`rounded-lg border p-2 text-xs ${
              c.blocking ? "border-red-200 bg-red-50/60" : "border-amber-200 bg-amber-50/60"
            }`}
          >
            <p className="font-medium text-slate-800">
              {/* Fix round 3 (Important 3): `lookup` was left off — an
                  unfilled slot's label fell through to cardTitle's
                  client-safe English default instead of `msg` (useMsg(),
                  line 62), regardless of this org's locale. */}
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
