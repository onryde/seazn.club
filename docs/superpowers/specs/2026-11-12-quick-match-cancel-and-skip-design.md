# Quick Match — skip one match: design

- **Date:** 2026-11-12 · **Programme:** Quick Match · **Status:** APPROVED — OWNER 2026-11-13 "OK apply rec" after the sign-off page qmd13a01 (localhost:8765)
- **OWNER 2026-11-12:** "both, cancel whole match and skip one match". Everything else is **(designer's call)**, listed
  in §5.
- **Order:** its own small PR after #1198, BEFORE League + Knockout (`2026-11-12-quick-match-league-knockout-design.md`),
  because a skipped league match must count as done for the league to finish and the knockout to fill.

## 1. Intent

Real club nights go wrong: rain, the hall closes, a player leaves early. Today a guest can only wait for the match to
expire (unsaved: 7 days after the last score) or, once saved, delete it from /me; and a league with one unplayable
match can never finish, so it never names a winner.

## 2. Cancel the whole quick match — DROPPED

**OWNER 2026-11-12:** not built. A quick match is mostly thrown away; an unsaved one is purged 7 days after the last
score, and that purge must be stated plainly to the guest (handled in PR #1198's copy).

## 3. Skip one league match ("Not played")

- **Who (designer's call):** anyone with the link — same as Score and Edit result, which anyone with the link can
  already do.
- **What it does:** the match becomes **Not played**: the fixture is marked cancelled (status `cancelled` already
  counts as done for stage completion, `scoring.ts:1236`), it gives no points to either side, and the table and
  "N of M matches played" count only played matches. A match with points already scored can be skipped too; its
  partial score is discarded from the table (kept in the ledger as history).
- **Undo (designer's call):** "Put back" on a Not played row restores it to unplayed, until the league is finished —
  after that (and after a League + Knockout has filled its knockout) it is refused with the existing "can't change" copy.
- **Edge:** if every remaining match is skipped, the league finishes and the winner is the table leader; if no match
  was played at all, the home shows "No matches were played" instead of a winner.
- **Knockout matches** (League + Knockout later) cannot be skipped — a bracket needs a winner. (Plain Knockout is no
  longer offered.)

## 4. House rules owed

Copy in 4 locales; mobile-first 320/768/1280; tests per TEST-STRATEGY.md including sequences (skip → put back → score;
skip the last match → winner; skip all; ); e2e +
walkthrough extension + smoke; admin "Played"/"Finished" counts treat
Not played correctly.

## 5. Designer's calls to check

3. Skip allowed for anyone with the link.
4. Skip uses the fixture's `cancelled` status; partial points don't count.
5. "Put back" allowed until the league finishes.
6. Separate PR after #1198, before League + Knockout.

## 6. Calls fixed at sign-off (2026-11-13, approved with the page)

- "Not played" lives in the match row's ⋯ menu (Option A), with a confirm sheet.
- "N of M played · K not played": M stays the full total.
- "Put back" is hidden once the league has finished; a stale tap gets the existing "can't change" copy.
- No match played: the table is hidden and the home offers "Start a new quick match".
- Only unplayed or in-progress matches can be skipped; a finished match cannot.
