# Match Day, all in one Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

> **Revised 2026-11-17** against origin/main c788c6a5f9: every path, symbol and line re-pinned; built on merged Match Day's poll (`useDayRefresh` + `startBandPolling`, "Updated N s ago"), `divisionDays`, `roundOpensOfDivisions`, `watchFromLedger` and the `MatchDayView` zod; Task 9 adopts capacity plan 3's `joinable` re-open-on-poll and owns `VIDEO_BUSY` → `busy`; the shared arbiter modules stay put; the arbiter e2e is `arbiter-panel.spec.ts` (ported, then deleted); no migration. See "Revision notes" at the end; the owner's rulings of 2026-11-17 on O1–O4 are applied ("Resolved by owner 2026-11-17": cancelled boards only while flagged, one source for the division queue and Match Day, online divisions out of the Match Day code's day read, one billing-freeze rule — new Task 5a).

**Goal:** Put every online chess round of a competition inside Match Day, with board rows in the list, a board panel that shows the chess board or both players' cameras, a round panel with the round's controls, and Needs you rows for held and flagged boards, then remove the arbiter page.

**Architecture:** The Match Day view grows `online_rounds`, read beside the courts in `getMatchDay` from the arbiter loader and the open-round reader, carrying every board's list facts; a board in focus reads its position and flag cards through its own route. The shell lists rounds as a block after the courts and resolves a focused round or board exactly as it resolves a court. Two attention kinds, per board, join the desk's. The arbiter page, its column and its links are removed in the last task, with a redirect.

**Tech Stack:** Next.js 16 app router, React 19, `postgres`, vitest (node environment; `renderToString` for component suites), Playwright, four locale dictionaries under `apps/web/src/dictionaries/<locale>/ui.json`, `chessground` through the match room's `Board` (`apps/web/src/components/public-site/match-room/board.tsx`).

**Spec:** `docs/superpowers/specs/2026-11-05-match-day-all-in-one-design.md`. Read with the Match Day design (`docs/superpowers/specs/2026-10-31-match-day-design.md`) and the capacity design's plan 3 (`docs/superpowers/plans/2026-11-05-checkin-capacity-3-arbiter.md`). **Depends on plan 3's Tasks 1 to 3 being done first**: Task 3 there adds each side's `presence`, `camera` and `joinable` to `ArbiterSideMeeting` (`apps/web/src/lib/arbiter-view.ts`), which this plan's `presenceMark` (Task 1), board rows and joins (Task 9) read; Tasks 1 and 2 there are what Task 9 here joins cameras with. Order across the plans (owner, 2026-11-17, plan 3's header): capacity 1, capacity 2 (its Task 0 first), capacity 3 Tasks 1 to 3, this plan, capacity 3 Task 7.

**What merged Match Day already gives this plan (reuse, never rebuild):** the shell (`apps/web/src/components/v2/match-day/match-day-shell.tsx`) with its one day read `useDayRefresh(competitionId, setView)` (`use-day-refresh.ts`: one request at a time, `lastOkAt`, `failed`) driven by `startBandPolling(isLive(view), () => void refresh(), browserBandPollDeps())` (`components/v2/desk/band-poll.ts`: `LIVE_POLL_MS` 20 s, `QUIET_POLL_MS` 90 s, paused while hidden, an immediate read on `visibilitychange`) and the "Updated N s ago" / Refresh line (`refresh-line.tsx`, testids `md-refresh`, `md-refresh-age`, `md-refresh-button`); the focus and "left the list" machinery (`Opened`, `Focus`, `resolveFocus` in `apps/web/src/lib/match-day/view.ts`, `md-lost`); the no-court panel `NoCourtFocus` and its back label (`matchDay.back.<noun>` / `matchDay.back.list`, and `matchDay.back.board` already reads "All boards"); `MatchDayCtx` and `fixtureHref` (`court-focus.tsx`); the round chip `MatchRoundChip` (`round-chip.tsx`); `NeedsYou` with its in-place `onAlt` (`components/v2/desk/needs-you.tsx`); the per-division day `divisionDays` / `dayTable` (`apps/web/src/server/usecases/match-day-call.ts` lines 290 and 301); the opened-rounds reader `roundOpensOfDivisions` (`apps/web/src/server/external-play/round-open.ts` line 96); the public position derivation `watchFromLedger` (`apps/web/src/server/usecases/external-play-read.ts`, over `fenAfter`); and the view's zod `MatchDayView` (`apps/web/src/server/api-v1/schemas/fixtures.ts` line 199, parsed by the route test).

## Global Constraints

- The layout is Match Day's: header, Needs you, chips, list left, focus right, phone list-as-home. No new header element; the round's controls live in the round row's panel. One DOM, branched by `max-md:*` / `md:hidden` (AGENTS.md "The phone composition": never a second phone tree; `truncate` needs `min-w-0` on the whole ancestor chain; anchor a `md:hidden` assertion on `\s...hidden"`, since `/\bmd:hidden\b/` also matches inside `max-md:hidden`).
- The court list (`court-list.tsx`, `orderCourts`, `foldFreeCourts`) is not changed. Online rounds are a block after the courts and the no-court rows.
- Nothing server-side about online play changes: every press calls the route it calls today (`stages/[id]/open-round`, `stages/[id]/extend-checkin`, `fixtures/[id]/external-play/resend`, `…/extend-checkin`, `…/resync`, `…/flags/close` (the "let the game go on"), `…/resolve`, `…/video-override`, `…/arbiter` join — all under `apps/web/src/app/api/v1/`). The server routes' own refusals stand. Two owner-ruled exceptions (2026-11-17), each its own task: the START writes gain the billing-freeze guard (O4, Task 5a), and the Match Day code's day read leaves online divisions out (O3, Task 2).
- Who sees what: rows and state to any member who may open Match Day; cameras and presses that START play (open, invite, +5) only to a viewer whose role is in `EDITOR_ROLES` (`isEditorRole`, `apps/web/src/lib/types.ts` line 28) in a club offered online chess (`onlineChessOffered`, `apps/web/src/server/usecases/external-play/online-chess-flag.ts` line 42); decisions that FINISH play (resync, let the game go on, settle) to every `EDITOR_ROLES` viewer, flag or not. A board the viewer plays on is never listed for them. (Re-pinned: the page's `canEdit` IS `isEditorRole(org.role)` today, `apps/web/src/server/page-auth.ts` lines 103 and 162, so the page may pass `page.canEdit`; the design's "if `canEdit` is ever wider" case is a guard, not today's tree.) **Billing freeze (owner O4, 2026-11-17): online boards follow Match Day's rule, one rule for both.** Match Day's rule is `freeze-guard-sites.test.ts`'s (PB2, owner 2026-11-02): a competition over `competitions.max_active` keeps every write it guards EXCEPT scoring — Call, Undo and "+ Connect a stream" 402 and are not offered (`frozen && !readOnly`), the pad and scoring stay. Mapped onto the online presses: the START writes (open a round, resend invites, +5 on a board, +5 to the round) are gated — not offered when `frozen`, and refused 402 by the server (Task 5a); the FINISH decisions (resync, let the game go on, settle, let play without video) write or unblock a RESULT, the scoring the rule exempts, and stay offered, exactly as their usecases carry no freeze guard today; watching cameras writes nothing and is not gated. The arbiter page's old "`canEdit`, never `editable`" (`d/[divSlug]/page.tsx` line 599) is retired with it.
- Dictionary keys for every new word in all four locales (`apps/web/src/dictionaries/{en,es,fr,nl}/ui.json`; `npm run i18n:check` clean, then `npm run i18n:gen-keys` since a new key is a new `DictionaryKey`); copy in the house words: "Board N", "Not here yet", "Checking in", "Live · move N", "On hold", "Waiting for capacity". The Match Day page hands the shell a PICKED dictionary (`pickDictPrefixes(ui, ["matchDay.", "desk.needsYou.title", "dlink.title", "stream.youtube.link.live", "stream.auto.refus"])`, `match-day/page.tsx` line 77): every prefix a reused arbiter piece renders (`arbiter.`, `externalPlay.`) is added to that list in the task that first mounts it, or the island prints raw keys.
- Verified at 1280, 768 and 320 with no horizontal page scroll (`overflowingIn`, `apps/web/e2e/helpers.ts` line 177); the seven-width matrix is the `e2e/mobile/` area files (`apps/web/e2e/mobile/match-surfaces.spec.ts` holds the arbiter column's phone test today, line 735); the phone's list-as-home rule for a board is the court's. Screenshots are looked at and never committed. Every UI task's implementer loads the `frontend-design` skill (owner standing rule).
- `MATCH_DAY_ONLINE=1` gates the rows and panels until Task 10 removes the flag with the arbiter page. (Re-pinned: no `MATCH_DAY_ONLINE` exists anywhere on main today; Task 2 introduces it.)
- `npm run openapi:gen` (root `package.json`; writes `openapi/v1.json` and `openapi/v1.public.json`) leaves the tree clean before any commit that adds or changes a v1 route or a v1 answer's schema (Tasks 2, 3 and 4).
- Scoped test runs only (AGENTS.md; never the full gate, vitest suite or e2e suite locally): `cd <worktree>/apps/web && npx vitest run --reporter=json --outputFile=<file> <exact paths>`, then read `numTotalTests`, `numFailedTests` and `.testResults[].name` from the file. Commits are plain `git commit` on a worktree branch (`~/.claude/tools/github-safe.sh` does not exist on this machine). e2e runs locally only for the specs a task changed; the full seven-width matrix is CI's, via `workflow_dispatch` on the pushed branch (`.github/workflows/e2e.yml` runs on push to `main` only, never on a PR).
- No migration: this plan reads tables that exist (`stage_round_opens`, `fixture_external_play`, `fixture_play_flags`, `fixture_video_*`) and plan 1's presence table. Main's highest delta is V526; capacity plans take V527–V529; if a later revision needs one it takes V530 or above.
- Capacity rulings in force (relayed by the controller, 2026-11-17): the pre-mint job makes ROOMS only (a meeting row, no pre-minted player participant); an arbiter join with `EXTERNAL_PLAY_PRESENCE_PROOF` unset needs a COUNTED check-in for the side's player; the real-vendor proof of any camera join is capacity plan 1 Task 12 step 5 (real Cloudflare RealtimeKit on staging), defined there once and never redefined here.

## Review Focus

1. **A `?board=` for a board the viewer plays on, or for no listed board.** Expected: ignored exactly as an unknown `?court=` is (the default focus, no notice), never that board opened, no camera, no decision; a board that WAS open and then leaves the list is the "left the list" notice. Pinned in Task 6.
2. **The poll replaces the view while a board is in focus.** Expected: the focused board's cameras stay joined (keys stable across polls), its panel re-reads its own route only on its cadence, and a notice survives the refresh. A side that was not joinable becomes joinable on a later poll and joins with no press; a key refused `VIDEO_MEETING_NOT_STARTED` re-opens on the next poll while the side is still joinable. Pinned in Tasks 8 and 9.
3. **Two stages of one division each with a round to show.** Expected: two round rows, keys distinct, the stage named on both, and every press on a row is that row's own round: "Open round N+1" is on round N+1's row, never on round N's panel. Pinned in Tasks 1 and 7.
4. **A member who may only view, polling.** Expected: no presses, no cameras, no Needs you rows, the chess board and the state words still shown. Pinned in Tasks 2 and 8.
5. **An online round opened at 23:50.** Expected: the day is a match day at the open, and the next day's view still lists the round while a window is live or a game is on file, so Needs you does not jump back to the competition page at midnight. Pinned in Task 5.
6. **A billing-frozen competition on an online night** (owner O4). Expected: no Open round, no Resend, no +5 offered on Match Day (the division page's queue carries no START press today, `external-play-needs-result-queue.tsx` line 20), each refused 402 if called anyway; resync, let the game go on, settle and let play without video still offered and accepted; the cameras still watchable. Unfrozen: everything offered. Pinned in Tasks 1, 5a, 7 and 8.

---

## File structure

| File | Responsibility |
|---|---|
| `apps/web/src/lib/match-day/types.ts` (modify) | `MatchDayOnlineRound`, `MatchDayBoardRow`, `BoardPosition`, `MatchDayView.online_rounds`. |
| `apps/web/src/lib/match-day/online.ts` (create) | Pure rules: round order, row words, focus resolution for rounds and boards, who may press. |
| `apps/web/src/lib/arbiter-view.ts` (modify) | `ArbiterBoard.flagCount`; `ArbiterSideMeeting` as plan 3 Task 3 leaves it (`presence`, `camera`, `joinable`). |
| `apps/web/src/server/usecases/external-play/arbiter.ts` (modify) | `loadArbiterRound(…, { flags: "count" })`; `loadBoardsByIds`; `loadMatchDayBoard`. |
| `apps/web/src/server/usecases/match-day-online.ts` (create) | `readOnlineRounds`: the per-(division, stage, round) read. |
| `apps/web/src/server/usecases/match-day.ts` (modify) | `getMatchDay` includes `online_rounds`; the "today" arm in `countTodayByCompetition`. |
| `apps/web/src/server/api-v1/schemas/fixtures.ts`, `schemas/index.ts`, `apps/web/src/server/api-v1/openapi.ts` (modify) | `MatchDayView.online_rounds`, the needs-you item's `fixture_id`, `MatchDayBoard`, the new route's row. |
| `apps/web/src/app/api/v1/fixtures/[id]/match-day-board/route.ts` (create) | The focused board's read. |
| `apps/web/src/server/usecases/match-day-code-view.ts` (modify) | Owner O3: the Match Day code's day read leaves online divisions out (Task 2). |
| `apps/web/src/server/usecases/__tests__/online-queue-one-source.test.ts` (create) | Owner O2: pins the division queue, Match Day and the desk to the two held/flagged listers (Tasks 2, 4). |
| `apps/web/src/server/usecases/external-play/open-round.ts`, `invite.ts`, `checkin-extend.ts`, `guard.ts` (modify) | Owner O4: the START writes obey the billing freeze (Task 5a). |
| `apps/web/src/components/v2/external-play-needs-result-queue.tsx` (modify) | Owner O2: kept; each row links "Open in Match Day" (Task 10). |
| `apps/web/src/lib/division-phase.ts`, `apps/web/src/server/usecases/competition-desk.ts`, `apps/web/src/components/v2/desk/needs-you.tsx`, `apps/web/src/components/v2/desk/phase-pill.tsx` (modify) | The two per-board attention kinds. |
| `apps/web/src/components/v2/match-day/online-list.tsx`, `round-row.tsx`, `board-row.tsx` (create) | The rows. |
| `apps/web/src/components/v2/match-day/round-focus.tsx` (create) | The round's panel: phases, not here yet, presses. |
| `apps/web/src/components/v2/match-day/board-focus.tsx`, `board-position.tsx`, `board-cameras.tsx` (create) | The board's panel, the read-only board, the two tiles. |
| `apps/web/src/components/v2/match-day/match-day-shell.tsx`, `apps/web/src/app/o/[orgSlug]/c/[compSlug]/match-day/page.tsx` (modify) | Lists the block, resolves the focus, reads `?board=` and `?round=`. |
| `apps/web/src/components/v2/match-day/online/` (create; moves) | What becomes Match Day's ONLY: `arbiter-camera.ts`, `arbiter-watch.ts` (Task 9), `arbiter-joins.ts` (Task 9, new), `arbiter-video.tsx` (Task 9: the pure video rules and `SeatVideo` moved out of `arbiter-panel.tsx`). STAY where they are, because surviving surfaces import them: `lib/arbiter-view.ts`, `lib/round-column.ts` (also `arbiter-entry-card.tsx`'s `entryLine`), `components/v2/arbiter-flag-cards.tsx` and `arbiter-decision.ts` (imported by `external-play-needs-result-queue.tsx` lines 32-33 and `external-play-held-copy.ts` line 13), `components/v2/checkin-extend-ui.ts` (imported by `desk/open-round-state.ts` line 8). |
| `apps/web/next.config.js`, `apps/web/src/lib/routes.ts`, the division page, `stages-panel.tsx`, `arbiter-entry-card.tsx`, `online-game-exists-notice.tsx` (modify) | The redirect and the moved links. |
| Deleted in Task 10 | `apps/web/src/app/o/[orgSlug]/c/[compSlug]/d/[divSlug]/arbiter/page.tsx` and its `__tests__/page.test.tsx`, `components/v2/arbiter-panel.tsx` and its four suites, `components/v2/arbiter/round-column.tsx`, `round-queue-cards.tsx` and their suites, `apps/web/e2e/arbiter-panel.spec.ts` (after its flows are ported, Task 10), `apps/web/e2e/arbiter-column-kit.ts` (after its helpers move). |

---

### Task 1: Types and the pure rules

**Files:**
- Modify: `apps/web/src/lib/match-day/types.ts`, `apps/web/src/lib/arbiter-view.ts`
- Create: `apps/web/src/lib/match-day/online.ts`
- Test: `apps/web/src/lib/match-day/__tests__/online.test.ts`

**Interfaces:**

```ts
// arbiter-view.ts
// ArbiterBoard gains:  flagCount: number   // open flags, counted even when `flags` is [] (the list read)

// types.ts
export type OnlineRoundPhase = "not_started" | "before" | "checkin" | "playing";
/** A board as the list carries it: a whole ArbiterBoard (so lib/round-column.ts's rules, which take ArbiterBoard[], apply unchanged;
 *  `flags` is [] and `flagCount` the count on the list read) plus where it sits. */
export interface MatchDayBoardRow extends ArbiterBoard { stage_id: string; round_no: number; }
export interface MatchDayOnlineRound {
  key: string;                    // `${stage_id}:${round_no}` — the same spelling as roundKey (server/external-play/round-open.ts line 89)
  division_id: string; division_name: string; division_slug: string;
  stage_id: string; stage_name: string; round_no: number;
  /** The division has more than one round row on the page: the row names the stage. */
  multi_stage: boolean;
  phase: OnlineRoundPhase;
  offered: boolean;               // the club's online-chess flag
  tz: string;                     // the venue zone the column printed times in
  /** listOpenRounds' view for this (stage, round) (OpenRoundView, lib/open-round.ts line 77): the press, the pairings, the batches.
   *  Null when the reader has none for it (an opened round whose window has closed reads null today, as the column handles it) and for
   *  not_started. */
  view: OpenRoundView | null;
  /** The opened round whole (loadArbiterRound with flags "count"): its boards carry `seats`, `checkin` and `sides`, which the round
   *  panel's rules read. Null before the open. `round.boards` is the row's board list. */
  round: ArbiterRound | null;
  needs_decision: MatchDayBoardRow[]; // held or flagged boards of the division NOT in `round.boards`, any round, with their round
  own_boards: number;             // boards the viewer plays on, left out of both lists
}
export interface BoardPosition { fen: string; lastMove: [string, string] | null; turn: "white" | "black"; }
// MatchDayView gains:  online_rounds: MatchDayOnlineRound[];

// online.ts (pure)
export function onlineRoundPhase(r: Pick<MatchDayOnlineRound, "view" | "round" | "phase">, nowMs: number | null): OnlineRoundPhase; // the server's `phase`, re-derived from round.boards for the ticking clock: checkin while any board is checking_in
export function orderOnlineRounds(rounds: readonly MatchDayOnlineRound[], nowMs: number | null): MatchDayOnlineRound[]; // checkin/playing-with-a-live-board first, then before, then over; stable within a group
export type RoundRowWord = { kind: "closes"; at: string; here: number; seats: number } | { kind: "playing"; playing: number; total: number } | { kind: "paired" } | { kind: "not_started" } | { kind: "over" };
export function roundRowWord(r: MatchDayOnlineRound, nowMs: number | null): RoundRowWord; // from lib/round-column.ts checkinClock(boards, nowMs), checkinTally(boards, nowMs), playingTally(boards, boardsOwedAnInvite(view))
export type BoardRowWord = { kind: "checking_in" } | { kind: "starting" } | { kind: "live"; moveNo: number } | { kind: "on_hold"; flags: number } | { kind: "result"; score: string | null } | { kind: "no_result" } | { kind: "cancelled"; flags: number };
export function boardRowWord(b: MatchDayBoardRow): BoardRowWord; // `cancelled` only reaches the list through `needs_decision` (owner O1, 2026-11-17: a cancelled board is listed ONLY while it has an open flag, under "Needs a decision"; once the flag is settled it leaves the list)
export type PresenceMark = "here" | "off" | "away" | null; // null when the policy is off
export function presenceMark(b: MatchDayBoardRow, side: "home" | "away"): PresenceMark;
export type OnlineOpened = { kind: "round"; key: string; name: string } | { kind: "board"; id: string; name: string };
export type OnlineFocus = { kind: "round"; round: MatchDayOnlineRound } | { kind: "board"; round: MatchDayOnlineRound; board: MatchDayBoardRow } | { kind: "lost"; name: string } | { kind: "none" };
export function resolveOnlineFocus(rounds: readonly MatchDayOnlineRound[], opened: OnlineOpened | null): OnlineFocus; // a board is found in `round.boards` or `needs_decision`; never another board; `lost` only for an `opened` that names something (the shell never makes an `opened` from an unknown `?board=`)
export type Reader = { editor: boolean; offered: boolean; frozen: boolean }; // frozen: the competition is billing-frozen (MatchDayCtx.frozen; getCompetition(…).frozen)
/** THE online press rule, one for Match Day and the division page's Held | Flagged queue (owner O2 + O4, 2026-11-17). Pure,
 *  client-safe (lib/), so both surfaces import it. */
export function mayPress(reader: Reader, what: "start" | "finish" | "cameras"): boolean; // start: editor && offered && !frozen; finish: editor; cameras: editor && offered
```

`Opened` in `view.ts` (line 357, today `{ kind: "court" | "match"; id; name }`) gains the two kinds (`"round" | "board"`), and `resolveFocus` (line 369) is left as it is: the shell asks `resolveOnlineFocus` when `opened.kind` is one of the two. `presenceMark` reads `ArbiterSideMeeting.presence` and `.camera` as plan 3 Task 3 defines them (`presence.present`, `camera.state`), so plan 3 Tasks 1 to 3 land before this task. Re-pinned: `ArbiterBoardState` (`arbiter-view.ts` line 33) is `checking_in | starting | live | on_hold | result (score, noResult) | cancelled`; `result` with `noResult: true` is `no_result`; `cancelled` is reachable only through the flagged list (`listFlaggedExternalPlay` keeps a cancelled board with open flags, R4 at `arbiter.ts` line 262). The round-column rules take a clock: `openWindowBoards(boards, nowMs)`, `checkinClock(boards, nowMs)`, `checkinTally(boards, nowMs)`, `playingTally(boards, owed)` (`lib/round-column.ts` lines 54, 69, 98, 123), so `onlineRoundPhase` and `orderOnlineRounds` take `nowMs` too.

- [ ] **Step 1: Write the failing tests** (pure, no DB; one-line reason on the describe: online play is chess-only, `onlinePlay = 'lichess'` on `boardgame`): `orderOnlineRounds` empty case `[]` first; a check-in round before a paired one before an over one; two rounds of one division keep stage order; `roundRowWord` for each phase with values derived from `checkinClock`/`checkinTally` on seeded boards (the expected `at` is the earliest `deadlineAt` typed in the seed, never read back); `boardRowWord` for every `ArbiterBoardState` kind, `result` split by `noResult` (a sweep over the kinds read from a `Record<ArbiterBoardState["kind"], …>` so a new kind is a compile error, count reported and asserted > 0); `presenceMark` null when policy off, "off" when present with camera off, "away" for a pre-minted room (meeting row only, `joinable: false`, no presence); `resolveOnlineFocus`: none → `none`; a board in `needs_decision` found; a board of a round the viewer plays on (absent from both lists) → `lost`; a stale key → `lost`; `mayPress` table (8 reader shapes — editor × offered × frozen — × 3 asks, 24 cases counted, expected values typed from the Global Constraints' freeze mapping, never from the function): frozen → `start` false for every shape, unfrozen editor offered → `start` true (the positive pair); `finish` and `cameras` identical frozen or not.

- [ ] **Step 2: Run to verify they fail** (`cd apps/web && DATABASE_URL= npx vitest run --reporter=json --outputFile=/tmp/<task>/r.json src/lib/match-day/__tests__/online.test.ts`).

- [ ] **Step 3: Implement.** `roundRowWord` and `orderOnlineRounds` call `lib/round-column.ts`'s `checkinClock`, `checkinTally`, `playingTally` (with `boardsOwedAnInvite(view)`) over `round.boards` (an `ArbiterBoard[]`, so no adaptation).

- [ ] **Step 4: Run to verify they pass**, then `npm run typecheck --workspace apps/web` (scoped tsc: a temp tsconfig over the touched files is acceptable; never the full gate). `ArbiterBoard.flagCount` is a new REQUIRED field: every test builder that writes an `ArbiterBoard` literal gains it (typecheck lists them; plan 3 Task 3's list of builders is the same set).

- [ ] **Step 5: Mutate once each** (each alone, restored from a `cp` backup, `numTotalTests` unchanged): make `resolveOnlineFocus` fall back to the round's first board for an unknown id — the stale-key `lost` case must fail; drop `!frozen` from `mayPress`'s `start` arm (O4) — the frozen rows of the table must fail.

- [ ] **Step 6: Commit** — `feat(match-day): online round and board types and rules`.

---

### Task 2: The view carries the online rounds

**Files:**
- Modify: `apps/web/src/server/usecases/external-play/arbiter.ts` (`loadArbiterRound` option, line 166; `loadBoardsByIds`), `apps/web/src/server/usecases/match-day.ts` (`getMatchDay`, line 768), `apps/web/src/server/usecases/match-day-code-view.ts` (`getMatchDayForCode`, line 368 — owner O3), `apps/web/src/lib/match-day/view.ts` (`isMatchDayView` line 463, `matchDayForReader` line 643), `apps/web/src/server/api-v1/schemas/fixtures.ts` (`MatchDayView` line 199), then `npm run openapi:gen`
- Create: `apps/web/src/server/usecases/match-day-online.ts`
- Test: `apps/web/src/server/usecases/__tests__/match-day-online.test.ts` (DB suite; seed with `seedOnlineChessRound`, `seedOwner`, `seedPlayer`, `putVideoMeeting` from `apps/web/src/server/usecases/__tests__/_external-play-seed.ts` and the Match Day rig `_match-day-seed.ts` beside it), the route test `apps/web/src/app/api/v1/competitions/[id]/match-day/__tests__/route.test.ts` (it parses every answer with the `MatchDayView` zod, line 58), the code read's suite `apps/web/src/server/usecases/__tests__/match-day-code-view.test.ts` (O3), and a source guard `apps/web/src/server/usecases/__tests__/online-queue-one-source.test.ts` (O2; pure, reads files, no DB — the shape of `freeze-guard-sites.test.ts`)

**Interfaces:**

```ts
// arbiter.ts
export async function loadArbiterRound(auth, divisionId, opts?: { round?; now?; flags?: "full" | "count" }): Promise<ArbiterRound | null>;
//   "count" (the list read): `flags` is [] and `flagCount` is the open-flag count; no `flagView`, no `matchGuardFaults`. Default "full".
/** Boards by id, as the round view builds them (`boardRows` line 285 + `boardWithSides` line 373, with `BoardRow` gaining `stageId`:
 *  today's row carries `stageName` and `roundNo` but no stage id), for the held and flagged boards of earlier rounds. The viewer's own
 *  boards are left out (`fixturesSeating`, `./seated`), as the round view leaves them out. A cancelled board is read only when it has
 *  an open flag (the flagged list's R4 rule, `boardRows(…, { cancelled: true })`). */
export async function loadBoardsByIds(auth, divisionId: string, fixtureIds: readonly string[], opts: { now: Date; flags: "count" }): Promise<MatchDayBoardRow[]>;
// match-day-online.ts
export async function readOnlineRounds(auth: AuthCtx, competitionId: string, now: Date): Promise<MatchDayOnlineRound[]>;
//   For every live division of the competition with divisionPlaysOnline (server/external-play/online-play.ts line 25; sport_key and
//   config, as arbiterPanelOffered reads them): `offered` = onlineChessOffered(auth) once per call.
//   THE ROW SOURCE, two parts, so a round in play is never dropped when the open-round reader has no view for it:
//     (a) per STAGE of the division, the stage's LATEST opened round: ONE call of roundOpensOfDivisions(sql, onlineDivisionIds)
//         (server/external-play/round-open.ts line 96; keyed by roundKey, carrying roundOpenedAt) for every online division of the
//         competition, the highest round_no per stage taken in memory →
//         loadArbiterRound(auth, divisionId, { round: { stageId, roundNo }, now, flags: "count" }) → a row with `round` set and
//         `view` = the listOpenRounds view with the same (stageId, roundNo) (null allowed), phase checkin or playing. An earlier
//         opened round of the same stage is never a row: its held or flagged boards reach the page through `needs_decision` only;
//     (b) every listOpenRounds(auth, divisionId, { now }) view (open-round-view.ts line 124) with `state === "paired"` that is not
//         (a)'s round → a row with `round` null, phase "before" (a view in state "open" is (a)'s round or nothing);
//   a division not started: one row phase "not_started" (view null, round null); a division with neither and nothing held: no row.
//   An (a) row is listed only while it is still the day's, judged IN MEMORY from what this read already holds: its `roundOpenedAt`
//   inside the division's day — the bounds from `divisionDays(tx, orgTz, now, where)` (match-day-call.ts line 290, THE per-division
//   day: venue zone, else the organisation's, else UTC; one statement for the competition's divisions, the same function Task 5's
//   SQL takes its bounds from through `dayTable`) — or any board in `openWindowBoards(round.boards, now.getTime())`
//   (lib/round-column.ts), or any board whose state is starting or live, or any held or flagged board of the division; a round over
//   for days drops off.
//   `needs_decision`: listNeedsOrganiserExternalPlay (queue.ts line 73; rows with `seated` false) + listFlaggedExternalPlay
//   (arbiter.ts line 244), fixture ids not in (a)'s boards, read with loadBoardsByIds. OWNER O2 (2026-11-17): these two readers
//   are THE source of held and flagged boards for BOTH surfaces — the division page's Held | Flagged queue (d/[divSlug]/page.tsx
//   lines 632-633, unchanged) and Match Day (here, and Task 4's attentions, which read this field, never a query of their own).
//   No second query of `fixture_external_play` / `fixture_play_flags` for "held" or "flagged" is written anywhere in this plan.
//   OWNER O1 (2026-11-17): a cancelled board reaches `needs_decision` ONLY while it has an open flag (listFlaggedExternalPlay's
//   R4 rule, arbiter.ts line 262, unchanged); once its flags are settled the next read drops it, and it is never a round row. Boards the viewer plays on are excluded and
//   counted (`own_boards`), as the loader does. Sealed tables are read on the module `sql` client AFTER the competition auth (the
//   caller's `requireResourceAuth` / `requireCompetitionPage`), and never inside `getMatchDay`'s `withTenant` block (pool nesting:
//   match-day.ts's own comment "none may run inside the tenant transaction above").
// match-day.ts
//   getMatchDay(...) sets view.online_rounds = await readOnlineRounds(auth, id, now) — inside the existing outer Promise.all beside
//   openStreamStates / getCompetitionDesk / listDivisions / courtStreamsForDay — when process.env.MATCH_DAY_ONLINE === "1", else [];
//   then drops from `playing_no_court` every fixture listed in `online_rounds` (in any `round.boards` or `needs_decision`), so a board
//   is listed once, under its round (design §5.2), never as a no-court row. The drop is in getMatchDay AFTER readBoard, never inside
//   `readBoard`.
// match-day-code-view.ts (OWNER O3, 2026-11-17: online divisions stay OUT of the capture phone's day read)
//   getMatchDayForCode (line 368) builds on readBoard (line 373), whose no-court lists (`playingNoCourt`, `noCourt`) carry an online
//   board in play today. It drops every fixture of a division for which divisionPlaysOnline (online-play.ts line 25) holds, from
//   `courts[].now/next/finished` and `no_court`, through the same `covers` predicate (line 374), so a code's scope and the
//   online drop are one filter; its `online: []` (line 410) stays `[]` and its comment is rewritten to say so (owner O3: the code
//   read never lists online boards). In-hall divisions of the same competition are untouched. The division's sport_key and config
//   are read inside the existing `withTenant` (`divisions` is a tenant table), not on the module client.
// view.ts
//   isMatchDayView requires Array.isArray(o.online_rounds); matchDayForReader(view, canEdit) leaves online_rounds as they are
//   (presses are decided by `mayPress`; nothing in a row is organizer-only). The poll route (competitions/[id]/match-day/route.ts)
//   strips with isEditorRole(auth.role), the page with page.canEdit — the same predicate.
// schemas/fixtures.ts
//   MatchDayView gains `online_rounds: z.array(MatchDayOnlineRound)`: the round's own fields typed; `round` and `view` declared as
//   documented objects (`z.object({}).passthrough().nullable()` with a description naming lib/arbiter-view.ts ArbiterRound and
//   lib/open-round.ts OpenRoundView — no zod for either exists today); `needs_decision` the same. The zod is a plain z.object, so a
//   parse STRIPS an undeclared key silently: the route test asserts `online_rounds` survives the parse.
```

- [ ] **Step 1: Write the failing tests** (empty case first; one-line chess-only reason on the describe): a competition with no online division → `online_rounds` `[]` and `getMatchDay` otherwise unchanged; an online division with an opened round → one row, phase `checkin`, `round.boards` in board order with `flagCount` and `flags: []`; the same round after every window has closed and `listOpenRounds` has no view for it → still one row, `view` null, phase `playing`; a second stage with a paired round → a second row with `round` null, `multi_stage` true on both; a flagged board of round 1 while round 2 is listed → in `needs_decision` with `round_no: 1` and `stage_id`, not in `round.boards`; a held board of the listed round → in `round.boards` only (once); a round over for two days with nothing held → no row; a stage with rounds 1 and 2 both opened → one row (round 2) and round 1's held board in `needs_decision` with `round_no: 1`; a `listOpenRounds` view whose state is not `paired` and is not (a)'s round → no row; (O1) a cancelled board with an open flag → in `needs_decision` with state `cancelled`, a cancelled board whose flags are all settled → nowhere (not in `needs_decision`, not in any `round.boards`), and the SEQUENCE: cancelled + open flag → listed → `closeExternalPlayFlags` (`external-play/flags.ts` line 37, the "let the game go on" route `…/flags/close`) → a second `readOnlineRounds` → gone, the count of `needs_decision` down by exactly one; a division the club is not offered → `offered: false`, rows still present; an OTB division → no row; a second sport that cannot play online (a badminton division in the same competition) → no row; `isMatchDayView` refuses a view without `online_rounds`; the flag unset → `[]`; `getMatchDay` with an online board in play and no court → the board under its round and absent from `playing_no_court` (the no-court count asserted against the seed); the route test: a seeded online round's `online_rounds.length` equals the usecase's after `MatchDayView.parse` (anti-vacuity: > 0). Sequence: a second `readOnlineRounds` call after a board's result is written (the row's word moves from live to result, the row stays while held). (O3, `match-day-code-view.test.ts`, positive pair in ONE competition) a competition with an in-hall badminton division (a court, a board on it, a no-court row) and an online chess division (a board in play, no court): `getMatchDayForCode` with a competition-scope code → the online division's fixture ids absent from every court list and from `no_court` (count of online ids found: 0, of seeded: > 0), the in-hall division's rows all present (count equal to the seed's, > 0); the same with a venue-scope code (the in-hall court still listed). (O2, `online-queue-one-source.test.ts`, pure) reads `d/[divSlug]/page.tsx` and `match-day-online.ts` (Task 4 appends `competition-desk.ts`, its attention producer): each calls `listNeedsOrganiserExternalPlay` AND `listFlaggedExternalPlay`; and no file under `server/usecases/match-day*.ts`, `lib/match-day/` or `components/v2/match-day/` holds a SQL template naming `fixture_play_flags` or `needs_organiser` (a second query); it reports how many files it read (anti-vacuity: ≥ 3, 0 is a failure).

- [ ] **Step 2: Run to verify they fail.**

- [ ] **Step 3: Implement**, then `npm run openapi:gen`.

- [ ] **Step 4: Run to verify they pass**, plus the existing suites the change touches, by exact path (vitest positionals are literal filename filters): `src/server/usecases/__tests__/match-day.test.ts`, `src/server/usecases/__tests__/match-day-home-today.test.ts`, `src/server/usecases/__tests__/external-play-arbiter.test.ts`, `src/server/usecases/__tests__/external-play-arbiter-seats.test.ts`, `src/server/usecases/__tests__/external-play-flagged-and-run-sheet.test.ts`, `src/app/api/v1/competitions/[id]/match-day/__tests__/route.test.ts`; `git status --porcelain` clean after the generator.

- [ ] **Step 5: Mutate once each** (each alone, restored from a `cp` backup, `numTotalTests` unchanged): list a held board of the listed round in `needs_decision` too — the "once" test must fail; (O1) pass `loadBoardsByIds` every cancelled board of the division, flag or not — the "settled → nowhere" test and the sequence must fail; (O3) drop the online filter from `covers` — the code read's absence assertion must fail while its in-hall half stays green; (O2) add a `sql\`… fixture_play_flags …\`` read to `match-day-online.ts` — the source guard must fail.

- [ ] **Step 6: Commit** — `feat(match-day): read the online rounds into the view`.

---

### Task 3: The focused board's read

**Files:**
- Modify: `apps/web/src/server/usecases/external-play/arbiter.ts` (`loadMatchDayBoard`), `apps/web/src/server/api-v1/schemas/fixtures.ts` (`MatchDayBoard`, re-exported from `schemas/index.ts`), `apps/web/src/server/api-v1/openapi.ts` (the route's row beside the other `/fixtures/{id}/…` rows)
- Create: `apps/web/src/app/api/v1/fixtures/[id]/match-day-board/route.ts`
- Test: `apps/web/src/server/usecases/__tests__/external-play-arbiter.test.ts` (a new describe) and `apps/web/src/app/api/v1/fixtures/[id]/match-day-board/__tests__/route.test.ts`

**Interfaces:**

```ts
export type MatchDayBoard = ArbiterBoard & { position: BoardPosition | null; stage_id: string; round_no: number };
/** The board as its panel paints it: `boardWithSides` with full flags (flagView, matchGuardFaults), plus the position from the bridge's
 *  move list by the public read's own derivation — `watchFromLedger`'s rule in server/usecases/external-play-read.ts (fenAfter over
 *  `fixture_external_play.moves_uci`; `lastMove` is the last REPLAYED ply, `moves_uci[replayed - 1]`, split into its two squares, never
 *  the last element of the list: fenAfter stops at a move chess.js refuses; `turn` from `replayed % 2`), read from the bridge row the
 *  loader already joins (add `moves_uci` to `boardRows`), not through `loadOnlinePlayFixture` (guard.ts line 198, a playability guard
 *  that answers null for a finished board). 404 NOT_FOUND for a board of another club, or a cancelled board with no open flag;
 *  403 ARBITER_PLAYS_THIS_BOARD for a board the viewer plays on (isSeatedOn; the code and status joinAsArbiter uses, arbiter.ts
 *  line 733); any member who may read the competition may read it (no editor check: the board and its state are a viewer's too). */
export async function loadMatchDayBoard(auth: AuthCtx, fixtureId: string, opts?: { now?: Date }): Promise<MatchDayBoard>;
// GET /api/v1/fixtures/{id}/match-day-board → MatchDayBoard; auth requireResourceAuth(req, "fixture", id, "read").
```

- [ ] **Step 1: Write the failing tests**: a live board with 12 plies → `position.fen` equals `fenAfter(moves).fen` computed in the test from the same typed move list, `lastMove` the 12th ply's squares, `turn` white; a move list whose 8th ply chess.js refuses → `lastMove` the 7th ply's squares (the replay rule, not the list's tail); a board with no game (`challenge_id` null) → `position` null; full flags with `seconds`/`stamps` for a connection flag; a finished board still answers with its final position; the viewer plays on it → 403 `ARBITER_PLAYS_THIS_BOARD`; a viewer with read only → 200; another club's board → 404; an API key with read scope → 200 (the read route's terms). Chess-only reason on the describe.

- [ ] **Step 2: Run to verify they fail.**

- [ ] **Step 3: Implement**, then `npm run openapi:gen`.

- [ ] **Step 4: Run to verify they pass**; `git status --porcelain` clean after the generator.

- [ ] **Step 1b (owner O1, sequence):** a cancelled board with an open flag → 200 with its flag cards; `closeExternalPlayFlags` on every open flag; the same read again → 404 NOT_FOUND (the board left the list, so its read is gone with it; the panel's "left the list" notice is Task 8's).

- [ ] **Step 5: Mutate once each** (each alone, restored from a `cp` backup): drop the `isSeatedOn` refusal — the 403 case must fail; (O1) drop the "cancelled needs an open flag" condition — the second read of Step 1b must answer 200 and fail.

- [ ] **Step 6: Commit** — `feat(api): the Match Day board read`.

---

### Task 4: Per-board attentions

**Files:**
- Modify: `apps/web/src/lib/division-phase.ts` (`Attention` union line 247, `ATTENTION_SEVERITY` line 302, `KIND_ORDER` line 401 — a module-private array), `apps/web/src/components/v2/desk/phase-pill.tsx` (`RED_PILL_KEY` line 27, a `Record` over every kind: compile-forced), `apps/web/src/server/usecases/competition-desk.ts` (the producer, beside `resolveAttention(input)` at line 643), `apps/web/src/components/v2/desk/needs-you.tsx` (`NeedsYouItem` line 12, `needsYouKey` line 27, `needsYouItems` line 59, `NeedsYou` line 315), `apps/web/src/server/api-v1/schemas/fixtures.ts` (the `needs_you` item gains `fixture_id: Uuid.optional()`), the four dictionaries, then `npm run openapi:gen`
- Test: `apps/web/src/server/usecases/__tests__/online-queue-one-source.test.ts` (O2: append `competition-desk.ts` to the files it pins to the two listers; the anti-vacuity floor rises to the new count), `apps/web/src/lib/__tests__/division-phase.test.ts`, `apps/web/src/server/usecases/__tests__/competition-desk.test.ts`, `apps/web/src/server/usecases/__tests__/competition-desk-held.test.ts` (stays green beside the new cases), and the Needs-you kinds sweeps, each of which derives the kinds from `ATTENTION_SEVERITY`: `apps/web/src/app/o/[orgSlug]/c/[compSlug]/__tests__/competition-page-match-day.test.tsx` (line 275, "Needs you lives in one place at a time"), `apps/web/src/components/v2/desk/__tests__/desk-renderings-agree.test.tsx` (line 49), `apps/web/src/components/v2/match-day/__tests__/match-day-ssr.test.tsx` (lines 1256-1272: a `Record` over every kind, so the two kinds are a compile error there until added), `apps/web/src/components/v2/desk/__tests__/desk-ssr.test.tsx`

**Interfaces:**

```ts
// division-phase.ts
//   Attention gains: { kind: "board_held"; fixtureId: string; boardNo: number; home: string; away: string; roundNo: number; seated: boolean }
//                    { kind: "board_flagged"; fixtureId: string; boardNo: number; home: string; away: string; roundNo: number; flags: number }
//   ATTENTION_SEVERITY: board_held "red", board_flagged "amber".
//   KIND_ORDER (not exported; read by attentionRank, line 392): board_held directly after "needs_decision" (the same meaning: a
//   decision owed), board_flagged directly after "result_missing" (the match ambers). A kind missing from KIND_ORDER ranks -1, first in
//   its band, SILENTLY — so the test reaches it through `leadingAttention`'s tie-break, never an `indexOf` (the array is private).
// phase-pill.tsx: RED_PILL_KEY gains board_held → the pill's red key (a new `desk.pill.board_held` key, or `null` if the owner prefers
//   the division pill not to name it; default: a key, as needs_decision has one) and board_flagged → null (amber).
// competition-desk.ts: for an online division (the `onlineIds` set the desk already builds at line 521), one `board_held` per
//   NeedsOrganiserExternalPlayRow with `seated` false, one `board_flagged` per FlaggedBoard, appended to that division's attention list
//   after `resolveAttention(input)` (line 643). Both listers read on the module `sql` client, so they run OUTSIDE the desk's
//   `withTenant` block (line 346), as `roundOpensOfDivisions(sql, …)` at line 523 already does. RE-VERIFIED 2026-11-17: the desk's
//   attentions come from `resolveAttention` over fixture status and `awaitsSettle` (`isHeldFixture`, division-phase.ts line 123:
//   `status === "needs_decision" || awaitsSettle`); neither file reads `fixture_external_play.status = needs_organiser`, so an online
//   hold is NOT a desk attention today. The two kinds are purely additive: nothing is removed and nothing can be double-counted.
// needs-you.tsx: two cases in `needsYouItems`; `needsYouKey(divisionId, kind, fixtureId?)` (an optional third part of the key; today's
//   callers pass two, and `withFindCourt` finds rows by the two-part key, unchanged); the item carries `fixture_id` (the two board kinds
//   only); action { label: "Review board N", href: routes.competitionMatchDay(org, comp) + `?board=<fixtureId>` } (routes.ts line 77);
//   sub: the held reason's words (`components/v2/external-play-held-copy.ts`) or "camera report to review". `NeedsYou` gains
//   `onOpenBoard?: (fixtureId: string) => void`, the board kinds' twin of `onAlt` (same modifier-key rule as `altLink`): when given,
//   the ACTION link of an item with `fixture_id` is handled in place (preventDefault, then the handler) and its `href` still works
//   opened another way (the desk passes no handler and navigates; the Match Day shell passes its `openBoard`, because the shell builds
//   `opened` once from its focus props and a same-page `?board=` navigation would open nothing).
```

- [ ] **Step 1: Write the failing tests** (empty case first: an online division with nothing held or flagged raises neither kind): a held online board whose fixture status is not a decision state produces exactly one `board_held` and no `needs_decision`; a held online board whose fixture is ALSO held by the desk's own rule (fixture status `needs_decision`, the level-result hold — `competition-desk-held.test.ts` seeds the other held shape, a recorded abandon, and stays green beside it) produces both rows, one of each kind, nothing dropped; a flagged board one `board_flagged`; a board both held and flagged produces one of each (two rows, one board); two held boards of one division have two distinct keys; a held board the viewer plays on (`seated` true) raises nothing; an OTB `needs_decision` is unchanged; `leadingAttention` over `[board_held, final_decided]` picks board_held and over `[board_flagged, bans_waiting]` picks board_flagged (the tie-break inside each band); the kinds sweeps (every kind renders in exactly one place on both sides of the day boundary) now count the two new kinds — each sweep reports its count and it rises by 2.

- [ ] **Step 2: Run to verify they fail.**

- [ ] **Step 3: Implement**, with the dictionary keys `desk.needsYou.board_held`, `.board_held.sub`, `.board_flagged`, `.board_flagged.sub`, `.board.action` (and the pill key) in four locales, then `npm run i18n:gen-keys` and `npm run openapi:gen`.

- [ ] **Step 4: Run to verify they pass**; `npm run i18n:check`.

- [ ] **Step 1b (owners O1 and O2):** a cancelled board with an open flag → one `board_flagged`; after `closeExternalPlayFlags` a second desk read → none (the sequence); the desk's `board_held` + `board_flagged` fixture ids for a division equal, as sets, the ids the division page's two listers return for it (the same seed, both read in the test: one source, so one answer; > 0 ids compared).

- [ ] **Step 5: Mutate once each** (each alone, restored): drop `board_held` from `KIND_ORDER` — the tie-break case must fail; (O2) replace the desk's `listFlaggedExternalPlay` call with a hand-written `fixture_play_flags` select — the source guard must fail.

- [ ] **Step 6: Commit** — `feat(desk): per-board attentions for held and flagged online boards`.

---

### Task 5: What makes an online night a match day

**Files:**
- Modify: `apps/web/src/server/usecases/match-day.ts` (`countTodayByCompetition`'s `where`, line 159)
- Test: `apps/web/src/server/usecases/__tests__/match-day-home-today.test.ts`, `apps/web/src/server/usecases/__tests__/match-day.test.ts` (the `countFixturesToday` cases), and the competition-desk suite `apps/web/src/server/usecases/__tests__/competition-desk.test.ts`

**Interfaces:** the counted set gains a fixture of a (stage, round) with a `stage_round_opens` row that (a) was opened in the division's day (`o.opened_at` between `w.day_from` and `w.day_to`, the `dayTable` columns the statement already joins), or (b) is still inside the round's window bound at `now`, or (c) has a game on file (`fixture_external_play.challenge_id is not null and status <> 'finished'`; V451's status vocabulary is `pending | ready | live | finished | needs_organiser`). The bound in (b) is the ONE SQL fragment `roundWindowBoundSql(db)` that capacity plan 2 Task 8 adds to `apps/web/src/server/external-play/round-open.ts` for `anyCheckinWindowOpen` (the round's last batch start plus `ROUND_WINDOW_TAIL_MS`, declared in `window.ts` by that task: `DEADLINE_AFTER_MS + LINE_DEADLINE_GRACE_MS + CHECKIN_EXTEND_MAX * CHECKIN_EXTEND_STEP_MS`): a conservative per-round bound, never a per-board re-derivation of `windowFor` in SQL, and never this plan's own arithmetic on `DEADLINE_AFTER_MS` (rule 3 of `batch-anchor-source-guard.test.ts` refuses it outside `window.ts`). Plan 2 lands before this plan (owner order), so the fragment exists; re-read its signature on the tree before use. One statement; the arm is written beside the `IN_PLAY` arm. `countTodayByCompetition` serves BOTH `countFixturesToday` (the desk, Match Day) and `competitionsFixturesToday` (the org home's deck, line 206), so the org home's count and headline move with it: the headline's ranking (in play first, then the earliest planned) is unchanged, and a board counted by the new arm qualifies only as its row already would.

- [ ] **Step 1: Write the failing tests**: a round opened today with unscheduled boards → counted (and `needsYouHome` says Match Day); a round opened at 23:50 read at 00:10 the next day with a live window → still counted; the same with every window closed and no game → not counted; the same with a game on file → counted; a paired, unopened round → not counted; the org home's `competitionsFixturesToday` counts the same number as `countFixturesToday` for that competition (one rule, two surfaces); an OTB competition unchanged (its existing cases).

- [ ] **Step 2: Run to verify they fail.**

- [ ] **Step 3: Implement.**

- [ ] **Step 4: Run to verify they pass**, plus the competition-desk suite.

- [ ] **Step 5: Mutate once:** drop arm (b) — the 23:50 case must fail. Restore.

- [ ] **Step 6: Commit** — `feat(match-day): an opened online round makes the day a match day`.

---

### Task 5a: The START writes obey the billing freeze (owner O4, 2026-11-17)

Finding: Match Day's rule (`freeze-guard-sites.test.ts`, PB2 owner 2026-11-02) is "a billing-frozen competition keeps every write it guards EXCEPT scoring", enforced server-side (Call and Undo answer 402 through `frozenCompetitionIds` + `assertNotFrozen`, `match-day-call.ts` lines 533-537) with the UI hiding what the server refuses (`MatchDayCtx.frozen`, `court-focus.tsx`). The online START writes carry no freeze guard today (`git grep` of `frozen` over `external-play/open-round.ts`, `invite.ts`, `checkin-extend.ts`: none), so hiding a press on Match Day alone would leave the route open. One rule for both means the guard moves server-side too. The FINISH decisions settle a result (scoring) and stay unguarded, as today.

**Files:**
- Modify: `apps/web/src/server/usecases/external-play/open-round.ts` (`openRound`, line 193 — its stage read already selects `d.competition_id`), `apps/web/src/server/usecases/external-play/invite.ts` (`resendExternalPlayNotice`, line 441), `apps/web/src/server/usecases/external-play/checkin-extend.ts` (`extendCheckin` line 271, `extendRoundCheckin` line 292), `apps/web/src/server/usecases/external-play/guard.ts` (`OnlinePlayFixture` line 74 gains `competitionId`, read by `loadOnlinePlayFixture` line 198 — today it carries `competitionSlug` only)
- Test: `apps/web/src/server/usecases/__tests__/frozen-competition-writes.test.ts` (the freeze sweep; four new rows), `apps/web/src/server/usecases/__tests__/freeze-guard-sites.test.ts` (the `LEDGER`, line 90: four new sites, each `file#function` with the sweep's words — the ledger reds on a site without a witness), `apps/web/src/server/usecases/__tests__/external-play-checkin-extend.test.ts` (stays green)

- [ ] **Step 1: Write the failing tests** (state transitions: unfrozen → frozen → unfrozen again; empty case: a competition under its quota is never refused): for each of `openRound`, `resendExternalPlayNotice`, `extendCheckin`, `extendRoundCheckin`, a competition frozen the way the sweep already freezes one (its header: the org keeps Pro and the competition is pinned frozen, so the 402 is the freeze, not a plan gate) → `PaymentRequiredError` keyed `competitions.max_active` and nothing written (the round has no `stage_round_opens` row, the seat no new invite row, the window's bound unchanged); the same competition unfrozen → the write lands (the positive pair); `resyncExternalPlay`, `closeExternalPlayFlags`, `resolveExternalPlay` (`resolve.ts` line 206) and `overrideVideoAsOrganiser` (the `…/video-override` route) on the frozen competition → still accepted (scoring is exempt; the sweep counts the exempt calls it made, > 0). The sweep reports how many sites it drove (4; 0 is a failure). Add the four `LEDGER` rows.

- [ ] **Step 2: Run to verify they fail** (the frozen cases write; the ledger reds on four unwitnessed sites once the guards land, so add rows with the guards).

- [ ] **Step 3: Implement**: `assertCompetitionNotFrozen(f.orgId, f.competitionId)` before any write in each (outside a transaction, as the function's own comment requires; `openRound` reads its stage first, then asserts). The routes are unchanged: the 402 surfaces through `v1()`'s existing `PaymentRequiredError` mapping.

- [ ] **Step 4: Run to verify they pass**: the three test files by exact path, plus `src/server/usecases/__tests__/external-play-checkin-extend-create.test.ts`.

- [ ] **Step 5: Mutate once each** (each alone, restored from a `cp` backup, `numTotalTests` unchanged): remove the guard from `openRound` — its frozen case and the `LEDGER` must fail; remove it from `extendRoundCheckin` — the same.

- [ ] **Step 6: Commit** — `feat(external-play): the START writes obey the billing freeze`.

---

### Task 6: The rows and the focus in the shell

**Files:**
- Create: `apps/web/src/components/v2/match-day/online-list.tsx`, `round-row.tsx`, `board-row.tsx`
- Modify: `apps/web/src/components/v2/match-day/match-day-shell.tsx`, `apps/web/src/lib/match-day/view.ts` (`Opened`; `headerCountParts` line 109 gains the boards' part; `isLive` line 93), the match-day page `apps/web/src/app/o/[orgSlug]/c/[compSlug]/match-day/page.tsx` (`?board=`, `?round=` beside today's `query.court`; `onlineEnabled`; the picked dictionary's prefixes), the four dictionaries
- Test: `apps/web/src/components/v2/match-day/__tests__/online-list.test.tsx` (renderToString), the shell's existing suites `match-day-shell.test.tsx` and `match-day-ssr.test.tsx` in the same folder, and the page suite `apps/web/src/app/o/[orgSlug]/c/[compSlug]/match-day/__tests__/match-day-page-frozen.test.tsx` (the page's props)

**Interfaces:**

```ts
export function OnlineList(p: { rounds: MatchDayOnlineRound[]; selected: OnlineOpened | null; dict: Dict; locale: Locale; nowMs: number | null; onOpenRound(key: string): void; onOpenBoard(id: string): void }): ReactNode;
// Rows carry data-testid="md-round-row" / "md-board-row", data-key / data-fixture-id, data-state; a board of `needs_decision` carries
// its round as the merged `MatchRoundChip` (round-chip.tsx; a `MatchDayRound` of `{ code: "R<n>", label, coded: false }`, the board's
// own fallback); the division chip filter narrows rounds by division_id; the counts line adds plural(dict, "matchDay.header.boards", n)
// for boards checking in or live.
// The shell: `opened` may be an OnlineOpened; `focus` = resolveOnlineFocus when so; the phone opens a round or board full-screen as a
// court (`phoneOpen`, the same render-phase "lost → back to the list" adjustment); the back label is the merged one
// (`matchDay.back.${noun}` when courts are listed, else `matchDay.back.list` — or `matchDay.back.board`, which already reads
// "All boards", on a day whose list is boards only). `?board=` and `?round=` read exactly like `?court=` (focusCourtId): a value naming
// a listed board or round opens it, any other value is ignored (no `opened`, the default focus, no notice). `isLive(view)` (its Pick
// gains "online_rounds") gains "or any online round in check-in or with a starting or live board", so an online night polls at the live
// cadence through the merged `startBandPolling(live, …)` effect. Behind MATCH_DAY_ONLINE (a prop `onlineEnabled` from the page). The
// page passes `editor: page.canEdit` (= isEditorRole(org.role), page-auth.ts); the shell's `reader` for a row is
// `{ editor, offered: round.offered, frozen: ctx.frozen }` (owner O4: `MatchDayCtx.frozen`, the same flag that hides Call and Undo). The shell's `NeedsYou` gets `onOpenBoard={openBoard}` (Task 4's hook), the same function a
// board row's click calls. The page's picked dictionary gains "desk.needsYou." only if a board kind's copy is rendered client-side
// (today the rows arrive translated) — add exactly the prefixes the new rows render, nothing wider.
```

- [ ] **Step 1: Write the failing tests**: the empty case first — `online_rounds: []` renders no block and the court list's markup is byte-identical to today's; with two rounds and five boards the markup has 2 round rows and 5 board rows in `orderOnlineRounds` order, each board row's word from `boardRowWord` and its marks from `presenceMark`; the division chip for an OTB division hides the rounds; a selected board row has `aria-current`; the counts line reads "… · 6 boards playing" (plural key); `?board=` for a board the viewer plays on (absent from the view) renders the default focus with no notice and no board panel; a board opened and then gone from the next view renders the "left the list" notice with its name; `isLive` is true for a view with no courts and one round in check-in; `onlineEnabled` false renders no block; a `needs_decision` board shows its round chip. (O1 sequence) a cancelled board with an open flag opened by `?board=` → its panel; the next view (its flags settled, so `needs_decision` no longer carries it) → the "left the list" notice (`md-lost`) with the board's name, no panel, the list's board count down by one. (O4 wiring) the shell rendered with `frozen: true` and an editor in an offered club → a round in phase `before` has no `md-round-open-cta`; `frozen: false` → it has one (the positive pair, the same view).

- [ ] **Step 2: Run to verify they fail.**

- [ ] **Step 3: Implement.** Row markup copies `CourtRow`'s grid (`court-list.tsx` line 183: `grid min-h-14 w-full min-w-0 grid-cols-[auto_minmax(0,1fr)_auto]`, the `DOT` classes of line 40, `[overflow-wrap:anywhere]`).

- [ ] **Step 4: Run to verify they pass**; `npm run i18n:check`; lint on the touched files (`rtk proxy npx eslint --max-warnings 0 <files>` from `apps/web`, reading `✖ N problems`).

- [ ] **Step 5: Mutate once each** (each alone, restored from a `cp` backup): make the shell build `opened` from an unknown `?board=` — the "default focus, no notice" case must fail; (O4) build the row's `reader` with `frozen: false` — the frozen wiring case must fail.

- [ ] **Step 6: Commit** — `feat(match-day): online rounds and boards in the list`.

---

### Task 7: The round panel

**Files:**
- Create: `apps/web/src/components/v2/match-day/round-focus.tsx`
- Move: the `WaitingList` (`components/v2/arbiter/round-column.tsx` line 680) and `CheckinHero` (line 516) bodies, `OpenRoundBlockView`'s pairings and press (line 271), `roundPress` (line 425), into `round-focus.tsx` (the arbiter column keeps working until Task 10 by importing from here). Their `data-testid`s (`arbiter-waiting*`, `arbiter-checkin-*`, `arbiter-column-pairing-*`, `arbiter-extend-*`) move UNCHANGED, so the e2e that reads them (`checkin-extend.spec.ts`, `w3-swiss-app-a.spec.ts` line 683, `mobile/match-surfaces.spec.ts` line 735) changes only its navigation in Task 10.
- Modify: `apps/web/src/components/v2/arbiter/__tests__/round-column-copy.test.ts` — it scans every component file of `components/v2/arbiter/` from the directory listing plus `HELPER_FILES` (line 120) for literal keys against `ROUND_COLUMN_KEYS` (`lib/round-column.ts` line 229); the moved bodies leave that directory, so `round-focus.tsx` joins `HELPER_FILES` in the same commit or its literals go unswept. `apps/web/src/components/__tests__/api-v1-call-paths.test.ts` (`HAND_CHECKED_DYNAMIC`, line 82, compared exactly): the dynamic `apiV1` calls that move with `roundExtendRunner`'s and the resend's posts are re-counted per file.
- Test: `apps/web/src/components/v2/match-day/__tests__/round-focus.test.tsx`

**Interfaces:**

```ts
export function RoundFocus(p: { ctx: MatchDayCtx; round: MatchDayOnlineRound; next: MatchDayOnlineRound | null; reader: Reader; nowMs: number | null; backLabel: string; onBack(): void; onChanged(): void; onOpenBoard(id: string): void; onOpenRound(key: string): void; hiddenOnPhone?: boolean }): ReactNode;
// Every press on this panel is THIS row's round (its own `view`): never another round's. `onChanged` is the shell's quiet day read
// (`refresh()` of useDayRefresh), so a press's effect shows without waiting for the poll.
// phase not_started: "Start the division first" (externalPlay.openRound.startFirst); before: the pairings and "Open round N" via
// useOpenRound(round.view) (components/v2/desk/use-open-round.ts line 44) with OpenRoundConfirmBody (desk/open-round-control.tsx
// line 118), with the view's `earlierInPlay` warning inline (the same `OpenRoundBlockView` rules), `data-primary="true"` when
// `earlierInPlay` is empty; checkin: checkinClock big, the tally, the batches when staggered, "Not here yet" rows (seats of
// openWindowBoards(round.round.boards, nowMs) with seatWords (lib/invite-status.ts line 51), Resend via the resend route, "+5 min" via
// extendBoardPath (components/v2/checkin-extend-ui.ts line 36)), "Resend invites" / "+5 min to the round" (roundExtendRunner, same
// file line 175); playing: playingTally and the finished / on hold / waiting lines, the round's own reinvite or reopen press
// (`roundPress` over round.round and round.view). In checkin and playing, when `next` (the shell's: the row with the same `stage_id`
// and `round_no + 1` in phase "before", if any) exists, one line "Round N+1 is ready to open" whose press is onOpenRound(next.key): it
// selects that row, whose own panel carries the open. Presses render only when mayPress(reader, "start"). The open press carries
// `data-testid="md-round-open-cta"` and the confirm body's confirm button `data-testid="md-round-confirm-confirm"`: Task 10's
// walkthrough clicks both. The page's picked dictionary gains the "arbiter." and "externalPlay." prefixes the moved bodies render.
```

- [ ] **Step 1: Write the failing tests** (renderToString with a fake `useOpenRound` state): each phase's heading and lines; "Not here yet" lists exactly the seats not here of open-window boards (count asserted against the seed); a reader who may not press sees no button in any phase; a before-row's open is `data-primary="true"` only when its view's `earlierInPlay` is empty, and shows each earlier round's warning otherwise; the open press and its confirm carry the two test ids; a playing panel with `next` shows the "ready to open" line and no open button of its own; the shell's `next` for a round is null when the following round number belongs to another stage; a second render with a new `round` object for the same key keeps the open-round hook's state (the hook resets only on a round CHANGE, the arbiter column's own rule, `arbiter-panel.spec.ts` line 1740). (O4) an editor in an offered club on a FROZEN competition: no Open round, no Resend, no "+5 min", no "Resend invites", no "+5 min to the round" in any phase, while the phase lines, "Not here yet" and the pairings still render (count of presses found: 0); the same reader unfrozen → each phase's presses present (count > 0, typed per phase).

- [ ] **Step 2: Run to verify they fail.**

- [ ] **Step 3: Implement.**

- [ ] **Step 4: Run to verify they pass**, and the arbiter column's own suites still pass (they import the moved pieces): `src/components/v2/arbiter/__tests__/round-column.test.tsx`, `round-column-signoff-fixes.test.tsx`, `round-column-copy.test.ts`, `round-queue-cards.test.tsx`, and `src/components/__tests__/api-v1-call-paths.test.ts`.

- [ ] **Step 5: Mutate once each** (each alone, restored): let the playing panel render `next`'s open press itself — the "no open button of its own" case must fail; (O4) gate the check-in presses on `mayPress(…, "finish")` instead of `"start"` — the frozen case must fail.

- [ ] **Step 6: Commit** — `feat(match-day): the round panel`.

---

### Task 8: The board panel with the chess board, flags and decisions

**Files:**
- Create: `apps/web/src/components/v2/match-day/board-focus.tsx`, `board-position.tsx`
- Reuse in place (NOT moved; surviving surfaces import them): `components/v2/arbiter-flag-cards.tsx` (`FlagCard` line 81, `useFmt`, `Fmt` line 28), `components/v2/arbiter-decision.ts` (`decisionRunner` line 140, the reducer), `components/v2/checkin-extend-ui.ts`. Re-pinned: `external-play-needs-result-queue.tsx` (the division page's Held | Flagged queue) imports the first two (lines 32-33), `external-play-held-copy.ts` imports `Fmt` (line 13) and `desk/open-round-state.ts` imports `codeOf` from the third (line 8); the design §8 moves a module only "where [it is] only Match Day's".
- Modify: `apps/web/src/components/__tests__/api-v1-call-paths.test.ts` (`HAND_CHECKED_DYNAMIC`: `board-focus.tsx` gains its dynamic reads — the board GET and the `decisionRunner` post — counted and traced in the note above the entry)
- Test: `apps/web/src/components/v2/match-day/__tests__/board-focus.test.tsx`

**Interfaces:**

```ts
export function BoardPosition(p: { position: BoardPosition; white: string; black: string; clock: ArbiterClock | null; nowMs: number | null; label: string }): ReactNode;
// the match room's `Board` (components/public-site/match-room/board.tsx; `BoardProps` line 27) mounted with `dynamic(..., { ssr: false })`
// (as room-shell.tsx line 75 mounts it) and `{ fen, orientation: "white", lastMove, movable: false, syncKey: 0, onMove: () => {},
// viewOnly: true, label, t }`. `t` is the room's own copy reader (`RoomT = (key, vars?) => string`, match-room/room-copy.ts line 6);
// room-shell.tsx line 188 obtains it as `const t = useT()` from the dictionary provider (`components/i18n/dict-provider.tsx`: `useT`
// line 58, `DictProvider` line 17) that the `/o/[orgSlug]` layout mounts with the `ui` dictionary (`app/o/[orgSlug]/layout.tsx` lines
// 47 and 59), which the Match Day page sits under, so BoardPosition calls the same `useT()` itself and the page needs no extra
// dictionary pick. The renderToString suite wraps the component in `DictProvider` with the `ui` dictionary, or `useT()` throws.
export function BoardFocus(p: { ctx: MatchDayCtx; round: MatchDayOnlineRound; row: MatchDayBoardRow; reader: Reader; nowMs: number | null; refreshKey: number | null; backLabel: string; onBack(): void; onChanged(): void; cameras?: ReactNode; hiddenOnPhone?: boolean }): ReactNode;
// Reads GET /api/v1/fixtures/{id}/match-day-board on mount and whenever `refreshKey` changes — the shell passes useDayRefresh's
// `lastOkAt`, which moves on every successful day read (poll, Refresh button, visibility), so the board's read rides the merged poll and
// never runs a timer of its own; keeps the last answer. Header (Board N · names, division · stage · round chip · time control, state
// line, Open match = routes.fixture(org, comp, round.division_slug, row.fixtureNo) — `fixtureHref(ctx, f)` takes a MatchDayFixture,
// which a board row is not; `fixtureNo` is nullable on ArbiterBoard, no link when null); top panel = `cameras` when given (Task 9),
// else BoardPosition when position is non-null, else the two sides' check-in and invite words; flags via FlagCard and "Camera report
// pending"; Decide: the arbiter-decision reducer and decisionRunner, each button only when the loader's predicate allows it and
// mayPress(reader, "finish") (start-type +5 needs "start"); the refusal notice kept per board across `refreshKey` changes.
```

- [ ] **Step 1: Write the failing tests**: a live board renders the position (the `Board` stub receives the fen) and both clocks; a board with no game renders the seats' words; a viewer sees no Decide section; an editor in a club not offered sees resync/go-on/settle and no "+5 min"; the notice for a refused settle stays after `refreshKey` changes; a `refreshKey` change triggers exactly one board read (the fake `apiV1` call count is 2 after mount + one change, 2 again after a re-render with the same key). (O4) an editor in an offered club on a FROZEN competition: resync, let the game go on, settle and let play without video still render (the FINISH decisions, exempt as scoring), the board's "+5 min" does not; unfrozen → "+5 min" renders (the pair). (O1) a cancelled board with an open flag renders its flag cards and settle; the panel itself never decides the board left the list (the shell's `md-lost` does, Task 6).

- [ ] **Step 2: Run to verify they fail.**

- [ ] **Step 3: Implement.**

- [ ] **Step 4: Run to verify they pass**, with `src/components/__tests__/api-v1-call-paths.test.ts`; the panel's e2e in Task 10 proves the real `Board` mounts.

- [ ] **Step 5: Mutate once each** (each alone, restored): drop the `mayPress(reader, "finish")` guard on Decide — the viewer case must fail; (O4) gate Decide on `"start"` — the frozen case (decisions still offered) must fail.

- [ ] **Step 6: Commit** — `feat(match-day): the board panel`.

---

### Task 9: Both cameras in the board panel

**Depends on** plan 3 Tasks 1 to 3 (participant lifetime and floor, per-meeting chains and token memory, presence, camera and `joinable` in the loader, `arbiterSideAdmits`, the client-safe `VIDEO_BUSY` in `apps/web/src/lib/online-chess.ts`).

**Files:**
- Create: `apps/web/src/components/v2/match-day/board-cameras.tsx`; `apps/web/src/components/v2/match-day/online/arbiter-joins.ts` (`useArbiterJoins`); `apps/web/src/components/v2/match-day/online/arbiter-video.tsx` — MOVED out of `components/v2/arbiter-panel.tsx`, which re-exports them until Task 10 so its suites stay green: `ArbiterVideoView` (line 88) gaining `{ kind: "busy" }`, `arbiterJoinStateFromError` (line 168), `shouldJoinVideo` (156), `showsOutageCard` (163), `seatSide` (196), `sideSeat` (201), `nextOffSince` (216), `ArbiterSeatVideo` (85), `SeatVideo` (line 813, unexported today: exported from the new file), and plan 3 Task 3's `sideWatchable` and `rejoinAfterPoll` (plan 3 puts them in `arbiter-panel.tsx`, "retired with it": this task is where they move)
- Move: `components/v2/arbiter-camera.ts`, `components/v2/arbiter-watch.ts` (plan 3 Task 2's per-meeting chains) under `components/v2/match-day/online/` with their suites `components/v2/__tests__/arbiter-camera.test.ts`, `arbiter-watch.test.ts` (after Task 10 nothing outside Match Day imports them; `match-room/camera-loader.ts` line 117 names `arbiter-camera.ts` in a comment only — re-point the comment)
- Modify: `board-focus.tsx` (the Cameras / Board switch), `match-day-shell.tsx` (mounts `cameras` for the focused board when `mayPress(reader, "cameras")` and the policy is `required`), `components/v2/__tests__/arbiter-panel.test.tsx` (plan 3 Task 2's pin of `VIDEO_BUSY` → `{ kind: "error" }`, the ACCEPTED INTERIM, flips to `{ kind: "busy" }` here), `components/__tests__/api-v1-call-paths.test.ts` (the join's dynamic call counted under its new file)
- Test: `apps/web/src/components/v2/match-day/__tests__/board-cameras.test.tsx`, `apps/web/src/components/v2/match-day/__tests__/arbiter-joins.test.ts`, the moved `arbiter-watch.test.ts`

**Interfaces:**

```ts
export type MeetingKey = `${string}:${"home" | "away"}`; // `${fixtureId}:${side}`, the key `switchingFrom` parses today
/** One live join per key through makeArbiterSerial's per-meeting chains (plan 3 Task 2): a key added opens, a key removed closes
 *  (SDK leave only, never a DELETE). `keys` are ONLY the focused board's WATCHABLE sides — sideWatchable(board, side): the meeting is
 *  open AND the loader's `joinable` (plan 3 Task 3, arbiterSideAdmits: a player participant on file and, flag off, a COUNTED check-in /
 *  flag on, presence ever) — so a side the player has not reached makes no POST and reads `notStarted`.
 *  `pollKey` is the shell's useDayRefresh `lastOkAt`: when it changes and rejoinAfterPoll(view, watchable) is true for a key (its last
 *  answer was VIDEO_MEETING_NOT_STARTED while the side is still watchable, the flag-flip case), that key re-opens ONCE for that poll;
 *  a side whose `joinable` turns true on a poll simply appears in `keys` and opens. No timer for NOT_STARTED: the poll is the cadence.
 *  VIDEO_BUSY (lib/online-chess.ts): arbiterJoinStateFromError maps it to { kind: "busy" } (the tile's "Waiting for capacity"), retried
 *  on ARBITER_RETRY_MS (arbiter-camera.ts line 59: 500, 1000, 2000, 4000, 8000 ms), then held `busy` and re-opened on the next poll —
 *  at most 5 + 3 POSTs a minute per side at LIVE_POLL_MS, inside ARBITER_JOIN_LIMIT's 12 per (fixture, side, user) (plan 3 Task 1). */
export function useArbiterJoins(keys: readonly MeetingKey[], pollKey: number | null, deps?: { serial?: ReturnType<typeof makeArbiterSerial>; retryMs?: readonly number[] }): ReadonlyMap<MeetingKey, ArbiterVideoView>;
export function BoardCameras(p: { board: MatchDayBoardRow; views: ReadonlyMap<MeetingKey, ArbiterVideoView>; nowMs: number | null; f: Fmt }): ReactNode;
// two tiles, White left by color (seatSide of the board's whiteSide), each: SeatVideo when watching and live, else the word:
// notStarted (a side not joinable: "Not checked in") / present (connecting) / offSince / busy ("Waiting for capacity") / over. The shell
// owns `useArbiterJoins(keysOf(focusedBoard), lastOkAt)` keyed on the focused board, so a poll that replaces the view keeps the same
// keys and never re-joins a joined key; leaving the board removes both keys (SDK leave); returning to a board already visited costs no
// POST (plan 3 Task 2's kept token).
```

- [ ] **Step 1: Write the failing tests** (empty case first: `keys` `[]` opens nothing and makes no POST): two tiles; the words per state; keys unchanged across two renders with a new view object (the join hook's open count stays 2); a side `open` but not `joinable` (the pre-minted room: meeting row only, no player participant, no check-in) is not in `keys`, reads `notStarted`, and makes NO POST across three polls; THE SEQUENCE (owed by plan 3's review row 1): refused `VIDEO_MEETING_NOT_STARTED` → the player checks in (the next poll's board marks the side `joinable`, a new `pollKey`) → joined with no press, the fake serial's `join` called exactly twice; a key whose answer was `VIDEO_MEETING_NOT_STARTED` re-opens once per `pollKey` change while watchable and not at all when the `pollKey` is unchanged; a `VIDEO_BUSY` answer reads `busy` ("Waiting for capacity") and is retried after `ARBITER_RETRY_MS[0]` on the fake clock, then joins; after the last retry it stays `busy` until the next `pollKey`; the switch defaults to Cameras when the policy is required and the reader may watch, to Board otherwise; a reader not offered online chess gets no tiles and no POST. Chess-only reason on each describe.

- [ ] **Step 2: Run to verify they fail.**

- [ ] **Step 3: Implement.** The real-vendor proof of two live tiles is capacity plan 1 Task 12 step 5 (staging, real Cloudflare), not this task; locally the vendor is the fixture or unreachable.

- [ ] **Step 4: Run to verify they pass**, with `src/components/v2/__tests__/arbiter-panel.test.tsx`, `arbiter-panel-mount.test.tsx`, `arbiter-panel-d17.test.tsx`, `arbiter-panel-stale-open.test.tsx` (the panel still mounts through the re-exports), the moved camera and watch suites, and `src/components/__tests__/api-v1-call-paths.test.ts`.

- [ ] **Step 5: Mutate once each** (each alone, restored from a `cp` backup, `numTotalTests` unchanged): key on `state === "open"` instead of `sideWatchable` — the "no POST across three polls" case must fail; drop the `rejoinAfterPoll` re-open — the refused → checked in → joined sequence must fail; map `VIDEO_BUSY` back to `error` — the busy case must fail.

- [ ] **Step 6: Commit** — `feat(match-day): both players' cameras in the board panel`.

---

### Task 10: Links moved, the redirect, the arbiter page removed, the flag removed

**Files:**
- Modify: `apps/web/next.config.js` (`redirects()` at line 120: a 308 from `/o/:org/c/:comp/d/:div/arbiter` to `/o/:org/c/:comp/match-day`, `?fixture=` carried as `?board=` by a `has` (query `fixture`) / `destination` pair; Next carries the source's query onto the destination, so pin the EXACT `location`, `fixture=` included or not), `apps/web/src/lib/routes.ts` (remove `divisionArbiter`, line 128), the division page `apps/web/src/app/o/[orgSlug]/c/[compSlug]/d/[divSlug]/page.tsx` (the `arbiterPanelOffered` import line 103, `clubOffered` / `arbiterOffered` lines 610-619, `arbiterHref` line 722, the `ArbiterEntryCard` mount line 1052, the `arbiterHref` prop to `StagesPanel` line 1114) — `arbiterHref` becomes `routes.competitionMatchDay(orgSlug, compSlug)` under the same predicate; the Held | Flagged queue mount (lines 1054-1063, today `onlineDesk && !arbiterOffered`) is KEPT (owner O2, 2026-11-17) and becomes `onlineDesk` alone — it hid only because the panel's column carried the same lists, and that column is gone — reading the same `listNeedsOrganiserExternalPlay` / `listFlaggedExternalPlay` (lines 632-633, unchanged); `components/v2/external-play-needs-result-queue.tsx` (owner O2: Match Day is the primary entry — each held and flagged row gains "Open in Match Day", `routes.competitionMatchDay(org, comp)` + `?board=<fixtureId>`, a new prop `matchDayHref(fixtureId)` and a new key `externalPlay.queue.openInMatchDay` in four locales; its decisions stay exactly as they are, through the same `decisionRunner` / `FlagCard`; its header comment, lines 16-17, rewritten to say so); `apps/web/src/components/v2/arbiter-entry-card.tsx` (the card says "Open Match Day" with the status line it carries today, `entryLine`; testids `arbiter-entry` / `arbiter-entry-status` kept so `online-chess-division-page.spec.ts` changes only its link and copy assertions); `components/v2/stages-panel.tsx` line 1114 (`arbiterHrefFor` → `routes.competitionMatchDay(org, comp)` + `?board=<fixtureId>`; the run sheet's `arbiterHrefFor` / `arbiterHref` props in `desk/run-sheet.tsx` and `desk/run-sheet-row.tsx` keep their names and carry the new href); `components/v2/online-game-exists-notice.tsx` (its link); `components/v2/desk/needs-you.tsx` copy ("in the arbiter panel" → "in Match Day"); `apps/web/src/server/arbiter-panel-offered.ts` (rename to `online-boards-offered.ts`, same predicate; its suite `src/server/__tests__/arbiter-panel-offered.test.ts` renamed with it); `apps/web/e2e/walkthrough/chess-external-play.spec.ts` (`openFromColumn`, line 119, becomes: navigate to `routes.competitionMatchDay`, click the round's `md-round-row` by `data-key`, then the panel's `md-round-open-cta` and `md-round-confirm-confirm`; its `round.arbiterPath` gotos, lines 548 and 902); `apps/web/e2e/match-room-kit.ts` (`seedOnlineRound`'s `arbiterPath`, line 494, becomes a `matchDayPath`; 60 uses across seven e2e files today); `apps/web/e2e/arbiter-column-kit.ts` (its helpers `column`, `refreshNow`, `expectSeatWord`, `watchOpenRoundPosts`, `budgetFor`, `backdateOpenSql`, `openAnswerOf`, `recordOpenNotices`, `holdNoShowSql`, `cancelFlaggedSql` move to `apps/web/e2e/match-day-online-kit.ts` re-pointed at the Match Day test ids — `refreshNow` clicks `md-refresh-button` — with plan 3's `putRoom` / `putPreMinted` lifted there from `arbiter-panel.spec.ts`, and `putPreMinted` writing the MEETING ROW ONLY per the rooms-only ruling); `docs/runbooks/e2e-local.md` and `.github/workflows/e2e.yml` (drop `MATCH_DAY_ONLINE`, which Task 2 added); the dictionaries (drop `arbiter.*` keys no file renders any more — `ROUND_COLUMN_KEYS` and the copy test say which — then `npm run i18n:gen-keys`)
- Move: `apps/web/src/components/v2/arbiter/__tests__/round-column-copy.test.ts` and `_banned-copy.ts` to `apps/web/src/components/v2/match-day/__tests__/`, re-pointed from the `components/v2/arbiter` directory listing to the Match Day files that now render the column's keys (`round-focus.tsx`, `board-focus.tsx`) — deleting the directory must not delete the copy sweep. The pins that `arbiter-panel.test.tsx` holds for the moved pure rules (Task 9) move into `apps/web/src/components/v2/match-day/__tests__/arbiter-video.test.tsx` before that suite is deleted.
- Delete: the arbiter page and its suite (`d/[divSlug]/arbiter/page.tsx`, `arbiter/__tests__/page.test.tsx`), `components/v2/arbiter-panel.tsx` and its suites (`components/v2/__tests__/arbiter-panel.test.tsx`, `arbiter-panel-mount.test.tsx`, `arbiter-panel-d17.test.tsx`, `arbiter-panel-stale-open.test.tsx`), `components/v2/arbiter/round-column.tsx`, `round-queue-cards.tsx` and their suites (`components/v2/arbiter/__tests__/round-column.test.tsx`, `round-column-signoff-fixes.test.tsx`, `round-queue-cards.test.tsx`), `apps/web/e2e/arbiter-panel.spec.ts` (the arbiter e2e on main; `apps/web/e2e/arbiter.spec.ts` never existed) once every flow in the port table below is green in its new home, `apps/web/e2e/arbiter-column-kit.ts` once nothing imports it, and the arbiter parts of `apps/web/e2e/online-chess-desk.spec.ts` (its `arbiter-column-kit` import, line 58, and the column section from line 301)
- Every site that names the arbiter page today (re-verified 2026-11-17 against c788c6a5f9, `git grep` then each opened): `src/lib/routes.ts:128` (`divisionArbiter`); the division page (above) and its suites `d/[divSlug]/__tests__/arbiter-entry-link.test.tsx`, `online-chess-flag-wiring.test.tsx`, `online-start-hint-wiring.test.tsx`; `src/components/v2/stages-panel.tsx:1114` and its suites `components/v2/__tests__/stages-panel-open-round.test.tsx`, `stages-panel-online-game-exists.test.tsx`, `external-play-needs-result-queue.test.tsx`; `components/v2/arbiter-entry-card.tsx` and `__tests__/arbiter-entry-card.test.tsx`; `components/v2/online-game-exists-notice.tsx` and `__tests__/online-game-exists-notice.test.tsx`, `online-game-exists-route.test.tsx`; `components/v2/desk/run-sheet.tsx`, `run-sheet-row.tsx` and `desk/__tests__/run-sheet-camera.test.tsx`; `src/server/arbiter-panel-offered.ts` and `src/server/__tests__/arbiter-panel-offered.test.ts`; the literal `/arbiter?fixture=` hrefs in `src/server/usecases/__tests__/external-play-run-sheet-producers.test.ts` (lines 74, 103) and `external-play-sweep.test.ts` (line 4539); `components/public-site/match-room/__tests__/checkin-privacy.test.tsx`; `components/__tests__/api-v1-call-paths.test.ts` (the `arbiter-panel.tsx` and `round-queue-cards.tsx` entries, lines 105 and 117, go); the arbiter page and panel themselves.
- e2e specs that read the arbiter page's test ids or its address (grep of `e2e/` for `arbiter-(board-group|checkin|column|decision|entry|extend|invite|round-column|seat|settle|waiting)`, `online-game-exists`, `/arbiter`, `arbiterPath`, `arbiter-column-kit`): `e2e/arbiter-panel.spec.ts` (deleted after the port), `e2e/checkin-extend.spec.ts` (lines 167-194: navigation only, the extend testids move unchanged), `e2e/mobile/match-surfaces.spec.ts` (line 735, the arbiter round column at the phone widths → the round panel on Match Day at the same widths), `e2e/online-chess-desk.spec.ts`, `e2e/online-chess-division-page.spec.ts` (lines 57-78, the entry card), `e2e/w3-swiss-app-a.spec.ts` (line 683, the column's pairings → the round panel's), `e2e/walkthrough/chess-external-play.spec.ts`, and the kits `e2e/match-room-kit.ts`, `e2e/arbiter-column-kit.ts`.
- Create: `apps/web/e2e/match-day-online.spec.ts`, beside the existing `apps/web/e2e/match-day.spec.ts`; that spec's helpers (`seedMatchDay`, `row`, …) are LOCAL to it and a spec cannot import a spec, so the new spec imports the kits (`match-room-kit.ts` `seedOnlineRound`, `directory-kit.ts`, `midday-zone.ts`, the new `match-day-online-kit.ts`); it joins the `parallel` project's "rest" slice by itself (`apps/web/playwright.config.ts` line 133: "rest" is a catch-all).
- Port table (each `arbiter-panel.spec.ts` test → where its behaviour is proven after Task 10; none silently dropped): desktop run sheet to two boards, flags, decisions, outage let go (line 272) → `match-day-online.spec.ts` board panel; phone board picker at 320/768/1280 (416) → the phone list-as-home case below; the watch-only line under the title (454) → board panel header for a viewer; I-3 No result as VOID / hidden in Swiss and knockout (529) → board panel settle; I-4 knockout winner seats the next match (685) → board panel settle; I2 watch handed back on a board switch and tab close (732) → leaving a board leaves both meetings with the SDK, no DELETE (plan 3 Task 2's rule); I3 link to a board not here (806) → `?board=` unknown is IGNORED (design §7, a deliberate change: no notice); N1 pinned board of an earlier round (832) → the board under "Needs a decision"; N3 own board left out with one line (883) → `own_boards`; no panel for anyone else (914) → a viewer sees rows and no presses, a stranger is signed out; flag times in the venue's zone (956) → board panel flag cards; a side that has not checked in, join opens when the player arrives (1223) → Task 9's sequence end to end; colour swap after arrival (1286) → tiles by colour; the round column describe (1332-1740: open from the column, "already open" from a stale page, held board "Review board N" selects in place, Open round 2 offered while round 1 plays, Fixtures tab one entry line, queue state across the check-in to playing flip, hook reset on a round change) → the round panel and Needs you on Match Day.
- Test: `apps/web/src/lib/__tests__/public-hub-redirect.test.ts`'s pattern (it resolves `next.config.js`'s redirects as Next's server does) for the new redirect; the e2e

- [ ] **Step 1: Write the failing tests**: the redirect matcher maps `/o/a/c/b/d/c/arbiter?fixture=X` to `/o/a/c/b/match-day?board=X` (the exact `location`) and `/o/a/c/b/d/c/arbiter` to `/o/a/c/b/match-day`; `routes.divisionArbiter` no longer exists (typecheck); the e2e at 1280: a seeded online round lists its boards, the round row opens the round panel with the countdown, a board row opens its panel with the chess board for a seeded game and the state words for a seeded presence row (vendor unreachable in this spec), Needs you's "Review board N" opens the held board in place, the Fixtures tab's card says "Open Match Day"; at 320 and 768 the list is home and a board opens full-screen with "‹ All boards"; no horizontal page scroll at the three widths (`overflowingIn`); and in `e2e/mobile/match-surfaces.spec.ts` the round panel and a board panel at the project's real width (all seven widths run it), no horizontal scroll, every press at the 44px floor.

- [ ] **Step 2: Run to verify they fail.**

- [ ] **Step 3: Implement the moves and deletions**, remove the `MATCH_DAY_ONLINE` gate, run `npm run i18n:check`, `npm run i18n:gen-keys`, lint and scoped tsc on the touched files.

- [ ] **Step 4: Run** locally: the new `match-day-online.spec.ts` whole, the chess walkthrough whole, each spec in the e2e list above that this task edited, and the redirect test; then the seven-width matrix (`e2e/mobile/`, every area file, never a `-g` slice: AGENTS.md rule 21) on CI by `workflow_dispatch` against the pushed branch. Screenshots at 1280, 768 and 320 looked at (not committed). A `grep -a` of `apps/web/e2e` and `apps/web/src` for `divisionArbiter`, `/arbiter?`, `arbiter-round-column`, `arbiterPath` and `arbiter-column-kit` returns nothing but the redirect and its test.

- [ ] **Step 1b (owner O2):** `components/v2/__tests__/external-play-needs-result-queue.test.tsx`: every held and every flagged row carries the "Open in Match Day" link whose `href` is `…/match-day?board=<that row's fixture id>` (count of links equals held + flagged, > 0; empty lists → no link and no markup); the decision buttons the suite already pins are unchanged. The division page's queue mounts on a chess fixtures tab where the club IS offered online chess (today it does not): the division page suite that already pins `arbiterOffered` (`online-chess-flag-wiring.test.tsx`) gains that case and its negative pair (a viewer: no queue). `online-queue-one-source.test.ts` (Task 2) still green — the page's reads did not move.

- [ ] **Step 5: Mutate once each** (each alone, restored from a `cp` backup): point the redirect's destination at `?fixture=` instead of `?board=` — the redirect test must fail; (O2) restore `&& !arbiterOffered` on the queue mount — the offered-club case must fail; drop the queue row's link — the link count must fail.

- [ ] **Step 6: Commit** — `feat(match-day): all in one; the arbiter page retired`.

---

## Self-review notes

- Spec coverage: §5.1 rows → Task 6; §5.2 order and (stage, round) rows → Tasks 1 and 2; §5.3 chips and counts → Task 6; §5.4 Needs you → Task 4; §5.5 earlier rounds → Tasks 2 and 6; §6.1 board panel → Tasks 3, 8, 9; §6.2 round panel → Task 7; §6.3 phone → Tasks 6 and 10; §6.4 who sees what → Task 1 (`mayPress`) and every panel's tests; §7 data → Tasks 2, 3, 5; §8 removal and links → Task 10; §9 plan 3 → amended beside this plan; §10 rollout → the flag in Tasks 2 and 6, removed in Task 10.
- Type consistency: `MatchDayBoardRow` (Task 1) is what `boardRowWord`, `presenceMark`, `OnlineList`, `BoardFocus.row` and `BoardCameras.board` take; `MatchDayBoard` (Task 3) is what `BoardFocus` reads; `Reader`/`mayPress` (Task 1, `frozen` included per owner O4) gate every panel, and Task 5a's server guard refuses exactly what `mayPress(…, "start")` withholds when frozen; `OnlineOpened`/`resolveOnlineFocus` (Task 1) are the shell's; `MeetingKey` (Task 9) is `${fixtureId}:${side}`, the key `switchingFrom` parses today; `lastOkAt` (merged `useDayRefresh`) is both `BoardFocus.refreshKey` and `useArbiterJoins`' `pollKey`.
- Proportion: bodies appear only where the spec fixes an algorithm or a shape (the view's read, the "today" arm, the redirect).

---

## Revision notes

### 2026-11-17 (against origin/main c788c6a5f9)

Every backticked repo path was tested in the reference tree; every symbol below was opened, not only grepped. Old → new, why.

**Interface changes consumed from capacity plan 3 (as revised and review-fixed 2026-11-17)**

| Old | New | Why |
|---|---|---|
| Task 9 `useArbiterJoins(keys)`: "keyed on the focused board, so a poll that replaces the view keeps the same keys and never re-joins" | `useArbiterJoins(keys, pollKey)`; `keys` are only `sideWatchable` sides (open AND `joinable`); a key refused `VIDEO_MEETING_NOT_STARTED` re-opens once per `pollKey` change while still watchable (`rejoinAfterPoll`); a side turning joinable simply enters `keys`; test "refused → player checks in → joined with no press" | Plan 3 review row 1 / its "Owed by the Match Day plan's Task 9" note: the old hook never re-joined a side refused before the player arrived. The poll is Match Day's merged `useDayRefresh` + `startBandPolling`; `pollKey` = its `lastOkAt` |
| `VIDEO_BUSY` → `busy` "owned" by Task 9, plan 3 not stated | Task 9 flips plan 3 Task 2's interim `VIDEO_BUSY` → `error` case (and its pin in `arbiter-panel.test.tsx`) to `{ kind: "busy" }`; retry schedule bounded and costed against `ARBITER_JOIN_LIMIT` | Plan 3 Task 2 states the interim and hands the flip here |
| `ArbiterSideMeeting` "as plan 3 Task 3 leaves it" (presence, camera) | presence, camera AND `joinable` (ADDITIVE) | Plan 3 review fixes |
| `sideWatchable` / `rejoinAfterPoll` not named | Moved by Task 9 from `arbiter-panel.tsx` into `match-day/online/arbiter-video.tsx` with the other pure video rules; the panel re-exports until Task 10 | Plan 3 exports them from the panel, "retired with it" |
| Task 9 seeds: pre-minted room had a participant | `putPreMinted` writes the meeting row only; a pre-minted side is not joinable (no player participant) | Capacity ruling relayed 2026-11-17: pre-mint makes ROOMS only. Plan 3's own text still says pre-mint writes the participant row; that is plan 3's to reconcile |
| No real-vendor proof named | Task 9 points at capacity plan 1 Task 12 step 5 (staging, real Cloudflare), not redefined | Capacity ruling: one staging gate |

**Stale paths and names fixed**

| Old | New | Why |
|---|---|---|
| `apps/web/e2e/arbiter.spec.ts` (deleted in Task 10) | `apps/web/e2e/arbiter-panel.spec.ts`, ported by an explicit table then deleted | `arbiter.spec.ts` never existed (plan 3's reviewer) |
| Task 2 run path `src/server/usecases/external-play/__tests__/arbiter` | Exact files under `src/server/usecases/__tests__/` (`external-play-arbiter*.test.ts`, `external-play-flagged-and-run-sheet.test.ts`, `match-day*.test.ts`) | That folder holds neither suite (plan 3's reviewer); vitest positionals are literal filters |
| `apps/web/src/server/api-v1/schemas.ts` | `schemas/fixtures.ts` + `schemas/index.ts` + `openapi.ts` row | Schemas are a folder now |
| `KIND_ORDER` "is an array" in needs-you; "test asserts index not -1" | `KIND_ORDER` is module-private in `lib/division-phase.ts` line 401; tested through `leadingAttention`'s tie-break | It is not exported; a missing kind ranks -1 silently |
| — | `RED_PILL_KEY` (`phase-pill.tsx` line 27) added to Task 4 | A `Record` over every kind: compile-forced |
| `resolveAttention` at competition-desk.ts line 606 | line 643; listers run outside the `withTenant` block (line 346) | Line drift; pool nesting |
| "seed `tiebreak_owed` with the rig of `competition-desk-held.test.ts`" | fixture status `needs_decision` (the level-result hold); that rig seeds a recorded abandon | `tiebreak_owed` is not a status; `isHeldFixture` reads `needs_decision` or `awaitsSettle` |
| `divisionDayBounds(division, now)` lifted into match-day.ts | Reuse `divisionDays` / `dayTable` (`match-day-call.ts` lines 290, 301) | Merged Match Day already has THE per-division day |
| "one read of `stage_round_opens`" in Task 2 | `roundOpensOfDivisions(sql, ids)` (`round-open.ts` line 96) | The existing one reader |
| `openWindowBoards(round.boards)` etc. | the round-column rules take `nowMs`; `playingTally` takes `boardsOwedAnInvite(view)` | Today's signatures |
| Position from `loadOnlinePlayFixture(…).bridge.moves_uci`, `lastMove` = last ply | `watchFromLedger`'s rule over the loader's own bridge row; `lastMove` = last REPLAYED ply | `loadOnlinePlayFixture` is a playability guard; `fenAfter` stops at a refused move |
| `BoardRowWord` without cancelled | gains `cancelled` (flagged list only) | `ArbiterBoardState` has `cancelled`; the flagged list keeps one (R4) — see O1 |
| Moved modules: `arbiter-flag-cards.tsx`, `arbiter-decision.ts`, `checkin-extend-ui.ts` under `match-day/online/` | They STAY in `components/v2/` | Imported by the division page's Held \| Flagged queue, `external-play-held-copy.ts` and `desk/open-round-state.ts`; design §8 moves a module only where it is Match Day's alone |
| `routes.ts:79`, division page lines 98/566/673, `stages-panel.tsx:1069` | `routes.ts:128`; page lines 103/610-619/722/1052/1114; `stages-panel.tsx:1114` | Line drift |
| Site list missed `arbiter-entry-card.tsx`, `online-game-exists-notice.tsx`, run-sheet prop threading, eight more suites | Added to Task 10's list | New since 2026-11-05 |
| `~/.claude/tools/github-safe.sh commit` | plain `git commit` on a worktree branch | The tool does not exist on this machine |
| "`mobile.spec.ts` stays green" | `e2e/mobile/` area files (match-surfaces holds the arbiter column's phone test) on CI by dispatch | `mobile.spec.ts` was split; full e2e is CI's |
| New spec "reusing [match-day.spec.ts's] helpers" | Imports kits; a spec cannot import a spec | `match-day.spec.ts`'s helpers are local |

**Additions the tree forces** (not in the old plan): the `MatchDayView` zod gains `online_rounds` and the needs-you item's `fixture_id`, with `openapi:gen` (Tasks 2 and 4; the route test strips undeclared keys silently); the page's PICKED dictionary needs the prefixes the reused pieces render; `api-v1-call-paths.test.ts`'s exact `HAND_CHECKED_DYNAMIC` counts move with every dynamic `apiV1` call (Tasks 7-10); `round-column-copy.test.ts` scans `components/v2/arbiter/` by directory listing, so moved bodies join its `HELPER_FILES` (Task 7) and the test moves before the directory is deleted (Task 10); `seedOnlineRound`'s `arbiterPath` has 60 uses across seven e2e files; `countTodayByCompetition` also feeds the org home's deck (Task 5); `i18n:gen-keys` after every key change; each new guard has one mutant step; empty cases first.

**Merged Match Day reused** (header list): `useDayRefresh` / `startBandPolling` / `RefreshLine` as the only poll (board read and joins ride `lastOkAt`; e2e `refreshNow` clicks `md-refresh-button`); `resolveFocus`/`Opened`/`md-lost`; `NoCourtFocus`'s back labels (`matchDay.back.board` = "All boards" exists); `MatchRoundChip`; `NeedsYou.onAlt` as the model for `onOpenBoard`; `MatchDayCtx`; `divisionDays`; `roundOpensOfDivisions`; `watchFromLedger`.

**Migrations:** none (unchanged; the old plan had none). If one is ever needed it takes V530+.

### Resolved by owner 2026-11-17 ("apply rec")

Each was open in the first revision (merged code or today's tree disagreed with the design of record, or the design was silent). Finding → change.

- **O1. A cancelled board with open flags.** Finding: design §5.1 says "Cancelled never"; main's flagged list keeps a cancelled board while its flags are open (R4, `arbiter.ts` line 262), and §5.5 lists "every held or flagged board". Ruling: listed ONLY while it has an open flag, under "Needs a decision"; once settled it leaves the list. Change: Task 1 (`boardRowWord`'s cancelled arm cites the ruling); Task 2 (the rule stated in `needs_decision`; tests: flagged → listed, settled → nowhere, and the sequence listed → `closeExternalPlayFlags` → second read → gone; mutant: read every cancelled board); Task 3 (Step 1b: 200 → settle → 404; mutant); Task 4 (Step 1b: `board_flagged` gone after settling); Task 6 (the focused board → `md-lost` on the next view); Task 8 (the panel renders flag cards and settle, never decides "left").
- **O2. The division page's Held | Flagged queue.** Finding: `external-play-needs-result-queue.tsx` is mounted only where the arbiter panel is not offered (`d/[divSlug]/page.tsx` lines 1054-1063) and reads `listNeedsOrganiserExternalPlay` / `listFlaggedExternalPlay` (lines 632-633); after this plan Match Day shows the same decisions — two places. Ruling: keep both; same data, same actions, ONE source; Match Day is the primary entry. Change: Task 2 (`needs_decision` reads exactly those two listers, no second query; a new pure source guard `online-queue-one-source.test.ts` pins every consumer to them and forbids a hand-written `fixture_play_flags` / `needs_organiser` select in Match Day code, counting the files it read; mutant: add such a select); Task 4 (the desk's producer joins the guard; Step 1b: the desk's board ids equal the listers' ids for the same seed; mutant); Task 10 (the queue mounts on every chess desk, `onlineDesk` alone, and each row links "Open in Match Day" `?board=`; mutants: restore `!arbiterOffered`, drop the link).
- **O3. Match Day codes (capture phone, #1140).** Finding: `getMatchDayForCode` (`match-day-code-view.ts` line 368) builds on `readBoard` (line 373) and lists an in-play online board as a no-court match; its `online: []` (line 410) waited on this plan. Ruling: leave online divisions OUT of the code's day read. Change: Task 2 (a `match-day-code-view.ts` step: the `covers` predicate, line 374, drops every fixture of a `divisionPlaysOnline` division; `online` stays `[]` with its comment rewritten; positive-pair test in `match-day-code-view.test.ts` — online ids absent, in-hall rows all present, competition and venue scopes, counts asserted; mutant: drop the filter). The Global Constraints' "nothing server-side changes" names this exception.
- **O4. Billing freeze.** Finding: merged Match Day refuses Call and Undo 402 on a billing-frozen competition and hides them (`frozen`; the PB2 rule in `freeze-guard-sites.test.ts`: every guarded write except scoring), while the arbiter page kept every online press working (`canEdit`, never `editable`), and no online START write carries a freeze guard. Ruling: online boards follow Match Day's rule, one rule for both; the moved arbiter actions obey it. Change: Global Constraints (the mapping: START writes gated, FINISH decisions exempt as scoring, cameras ungated; the "`canEdit` never `editable`" line retired); Review Focus 6; Task 1 (`Reader` gains `frozen`; `mayPress("start")` requires `!frozen`; 24-case table with the frozen/unfrozen pair; mutant); new Task 5a (`openRound`, `resendExternalPlayNotice`, `extendCheckin`, `extendRoundCheckin` gain `assertCompetitionNotFrozen`, `OnlinePlayFixture` gains `competitionId`, four `LEDGER` rows and four sweep rows: frozen → 402 and nothing written, unfrozen → written, the FINISH usecases still accepted; mutants on two sites); Task 6 (the row's reader carries `ctx.frozen`; wiring pair; mutant); Task 7 (frozen → no START press in any phase, unfrozen → present; mutant); Task 8 (frozen → decisions still offered, "+5" not; mutant). The division page's queue carries no START press, so the ruling changes nothing there.
