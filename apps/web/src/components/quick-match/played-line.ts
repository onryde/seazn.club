// The quick match's played line, "N of M matches played", in one place (quick match plan 4 Task 4; spec
// docs/superpowers/specs/2026-11-12-quick-match-cancel-and-skip-design.md §6: "N of M played · K not played", M the full
// total). The home, the setup page's Continue card and the account's list each say it from `playedOf`'s counts
// (quick-match-home.ts), and each builds it here, so the three never say a different thing about the same match.
//
// Pure and client-safe (a type import only). The account's list is a client island and the other two are server components,
// so each hands in its own bound `plural(key, count, vars)` (the viewer's dictionary and locale).
import type { QuickMatchCounts } from "@/lib/quick-match-finished";

export type PluralFn = (key: string, count: number, vars?: Record<string, string | number>) => string;

/**
 * The line for these counts. `days` is the unsaved home's countdown (C1: deleted that many days after the last score), or
 * null where no countdown is said: a saved match (it is kept until its owner deletes it), and the two lists, which never
 * carry one. With a Not played match the line names how many, through `notPlayedPart` (its own plural, `{count}`), and keeps
 * the full total.
 */
export function playedLine(plural: PluralFn, c: QuickMatchCounts, days: number | null): string {
  if (c.notPlayed > 0) {
    const skipped = plural("quickMatch.home.notPlayedPart", c.notPlayed);
    return days === null
      ? plural("quickMatch.home.playedSkippedSaved", c.total, { played: c.played, skipped })
      : plural("quickMatch.home.playedSkipped", c.total, { played: c.played, skipped, days });
  }
  return days === null
    ? plural("quickMatch.home.playedSaved", c.total, { played: c.played })
    : plural("quickMatch.home.played", c.total, { played: c.played, days });
}
