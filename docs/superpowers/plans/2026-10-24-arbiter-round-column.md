# Arbiter Panel Round Column (Variant C) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Move Open round, the invites, "+5 min to the round" and the Held / Flagged queue off the division Fixtures tab and into a phase-adaptive side column on the Arbiter Panel, with per-seat invite status read from the email outbox, behind the online-chess flag.

**Architecture:** The loader (`loadArbiterRound`) gains a per-seat `{ here, invites }` reading for boards in check-in: presence comes from the room's own `checkInCounts`, and invite words come from `latestEmailStatus` through a pure, total mapper. A pure model (`lib/round-column.ts`) decides the phase, the counts and the review targets. A client column (`components/v2/arbiter/round-column.tsx`) renders three phases inside `ArbiterScreen`'s existing one-DOM grid, which gains an `md` two-track layout. The Fixtures tab loses its Open round controls and its queue whenever the panel is offered, and keeps the queue as a fallback when it is not (T20).

**Tech Stack:** Next.js 16 (read `node_modules/next/dist/docs/` before touching routing or caching), React server and client components, Tailwind, postgres.js, vitest (`environment: "node"`, `renderToStaticMarkup` with the real dictionaries), Playwright (CI only), `scripts/smoke.ts`.

**Spec:** `docs/superpowers/specs/2026-10-24-arbiter-round-column-design.md` (read it first; section numbers below are the spec's).

## Global Constraints

- House theme only, the tokens in spec §4: Ink `#2e1065`, Soft `#4a3a6b`, Muted `#6b5b8a`, Line `#e7e3f3`, accent `#7c3aed` / `#5b21b6`, held `#b42318` on `#fef2f2` border `#f1c4c0`, caution `#713f12` on `#fef3c7` border `#f5d27a`, live dot `#4ade80`. `CLOCK_FACE` (`arbiter-panel.tsx:207`) for the countdown and tally numbers only. No colour, font, radius or shadow from the spike.
- One DOM, branched. The column becomes a column at `md` (768). Phone-only is `md:hidden`; desktop-only is `max-md:hidden`. Anchor class assertions on `\s...hidden"`, because `/\bmd:hidden\b/` also matches `max-md:hidden`.
- `min-w-0` on every ancestor of a truncating name.
- Invite words are exactly Sent / Delivered / Delayed / Bounced / Not delivered, plus "Not invited" when there is no mail. Never "opened", never "Invited" as a seat status.
- No em dash (`—`) and no arrow (`→ ← ↗`) in any string the column renders, in any locale.
- Every new or changed user-facing string goes into all four locales (`apps/web/src/dictionaries/{en,es,fr,nl}/ui.json`) with real translations, then `npm run i18n:gen-keys` (root script; `i18n-keys.ts` is GENERATED) and `npm run i18n:check`. Counted strings go through `plural()` / `useMsgPlural` (`.one` / `.other`). No verb agrees with a stage name. A zero clause is suppressed, never printed.
- No new API route. The column calls only the routes that exist today (open round, resend, board and round extend, settle, resync, go on, mark reviewed).
- The online-chess flag gates the PANEL and every link into it. It never gates a finishing control (T20).
- Tests: TEST-STRATEGY.md is binding. Write the failing test first and watch it fail; state the empty case first; every sweep reports its count and zero is a failure; expected values come from `OUTBOX_STATUSES`, `seatOutcome` and the dictionaries, never from the code under test; mutate each new guard once from a `cp` backup (never `git checkout <file>`).
- NEVER run the full vitest suite, the full gate or any e2e locally. Run only the scoped vitest paths named in each task. E2E runs in CI by `workflow_dispatch` with `--ref <branch>`; screenshots are taken with a throwaway capture script against a local prod server, not with the e2e suite.
- **Scoped vitest recipe** (called **VT** below). Run it from the worktree's `apps/web`, through a FILE reporter, and read the counts and the resolved file names:
  ```bash
  cd <worktree>/apps/web && npx vitest run --reporter=json --outputFile=/tmp/arbcol.json <paths>; \
    jq '{total: .numTotalTests, passed: .numPassedTests, failed: .numFailedTests, files: [.testResults[].name]}' /tmp/arbcol.json
  ```
  DB-backed suites need the local test DB from the `seazn-local-env` skill (fresh schema = `db:apply` + `sync:sports`; confirm `show data_directory` is yours). Never trust an `rtk` summary.
- **Typecheck and lint** on touched files: `cd <worktree>/apps/web && rtk proxy npx tsc --noEmit -p .` and `rtk proxy npx eslint <dir>` (lint the DIRECTORY for bracketed route paths; read `✖ N problems`).
- `grep -a` always. `/usr/bin/git`. Commit with explicit pathspecs; `next dev` writes untracked `apps/web/AGENTS.md` / `CLAUDE.md`, so never `git add -A`. No `git stash`.
- Evidence PNGs are never committed. They go in a gitignored SDD directory, with a PASS/FAIL text table.

## Review Focus

1. **A board re-paired after an Unpair** must not show the previous player's "Delivered" beside the new player. The ref id is fixture plus colour, not the person. Owning test: Task 2, `re-paired seat: the previous player's mail is not this seat's word`.
2. **Online play switched off, or the flag off, with a board held:** the panel 404s, so the Fixtures tab must still show the queue and its finishing controls, and must render no link into the panel. Owning tests: Task 9 `flag off: 404`, and Task 10 `not offered: the queue stays, with no panel link`.
3. **The clock crossing an edge with the page open and no refresh** (a board's deadline passes, a later check-in group opens): the hero must flip between "closes in", "opens in" and "closed" on time. Owning tests: Task 3 `checkinClock at the exact deadline millisecond`, Task 6 render at the edges; e2e `checkin-extend.spec.ts` "window's edges, live" migrated in Task 12.
4. **The organiser plays on a board of the round:** own boards are already left out of `round.boards`, so the tally, the waiting list and the queue must not count them, and a held card the organiser is `seated` on offers no action. Owning tests: Task 3 `own boards are never counted`, Task 7 `seated held card: the line, no action`.
5. **A second Open press, or a double click:** the column's press goes through `openRoundRunner`'s in-flight guard, and a second press after a success reads "already open" and sends nobody a second invite. Owning tests: Task 5 `second press: already open, no second invite`; e2e Task 13.

---

## File map

| File | Responsibility | Task |
|---|---|---|
| `apps/web/src/lib/invite-status.ts` (new) | Outbox status to invite word; a seat's words from its rows | 1 |
| `apps/web/src/lib/arbiter-view.ts` | `ArbiterSeatCheckin`, `ArbiterBoard.seats` | 2 |
| `apps/web/src/server/usecases/external-play/check-ins.ts` | bulk `checkedInAtOfBoards` beside `countedCheckIns` | 2 |
| `apps/web/src/server/usecases/external-play/arbiter.ts` | `BoardRow` stamp columns; seats on `boardOf` | 2 |
| `apps/web/src/lib/round-column.ts` (new) | phase, clock, tallies, review target, entry status, `ROUND_COLUMN_KEYS` | 3, 11 |
| `apps/web/src/components/v2/desk/use-open-round.ts` (new) | the Open / Resend handle lifted out of `OpenRoundControl` | 4 |
| `apps/web/src/components/v2/desk/open-round-control.tsx` | exports its copy helpers; `OpenRoundControl` deleted in Task 10 | 4, 10 |
| `apps/web/src/components/v2/arbiter/round-column.tsx` (new) | the column: before, check-in, playing | 5, 6, 7 |
| `apps/web/src/components/v2/arbiter/round-queue-cards.tsx` (new) | the compact Held / Flagged cards | 7 |
| `apps/web/src/components/v2/arbiter-panel.tsx` | mounts the column; `md` grid; `RoundExtend` moved | 8 |
| `apps/web/src/app/o/[orgSlug]/c/[compSlug]/d/[divSlug]/arbiter/page.tsx` | flag gate; loads the column's data | 9 |
| `apps/web/src/app/o/[orgSlug]/c/[compSlug]/d/[divSlug]/page.tsx` | `arbiterOffered`; no controls or queue when offered; entry status | 10 |
| `apps/web/src/components/v2/stages-panel.tsx` | `arbiterHrefFor` optional | 10 |
| `apps/web/src/components/v2/external-play-needs-result-queue.tsx` | the "Review in arbiter panel" link removed | 10 |
| `apps/web/src/dictionaries/{en,es,fr,nl}/ui.json`, `apps/web/src/lib/i18n-keys.ts` (generated) | copy | 1, 5, 6, 7, 10, 11 |
| `apps/web/e2e/match-room-kit.ts` | `seedSeatInvite` helper | 12 |
| `apps/web/e2e/{online-chess-desk,checkin-extend,online-chess-division-page,arbiter-panel}.spec.ts` | migrated off the Fixtures tab | 12 |
| `apps/web/e2e/arbiter-panel.spec.ts`, `apps/web/e2e/mobile.spec.ts` | new column coverage, seven widths | 13 |
| `apps/web/e2e/walkthrough/chess-external-play.spec.ts` | migrated, plus a whole round from the column | 12, 14 |
| `scripts/smoke.ts` | page-level checks | 15 |

---

### Task 1: Invite words

**Files:**
- Create: `apps/web/src/lib/invite-status.ts`
- Test: `apps/web/src/lib/__tests__/invite-status.test.ts`
- Modify: `apps/web/src/dictionaries/{en,es,fr,nl}/ui.json`, regenerate `apps/web/src/lib/i18n-keys.ts`

**Interfaces:**
- Consumes: `OUTBOX_STATUSES`, `type OutboxStatus` from `apps/web/src/server/email-outbox/constants.ts` (pure, no imports, no `server-only`; import the TYPE only from `lib/`); `seatOutcome` from `server/usecases/external-play/invite.ts` (tests only).
- Produces:
  ```ts
  export const INVITE_WORDS = ["sent", "delivered", "delayed", "bounced", "not_delivered"] as const;
  export type InviteWord = (typeof INVITE_WORDS)[number];
  export type SeatInviteWord = InviteWord | "not_invited";
  export const HOLDING_WORDS: readonly InviteWord[]; // ["sent", "delivered", "delayed"]
  export const INVITE_WORD_KEYS: Readonly<Record<SeatInviteWord, DictionaryKey>>;
  export function inviteWordOf(status: OutboxStatus): InviteWord | null;
  export function seatInviteWords(seat: {
    rows: readonly { recipient: string; status: OutboxStatus }[];
    mailboxes: readonly string[];
    stamped: boolean;
  }): SeatInviteWord[];
  ```

- [ ] **Step 1: Write the failing tests** in `invite-status.test.ts`:
  - `inviteWordOf is total over OUTBOX_STATUSES`: loop `OUTBOX_STATUSES`; count the statuses checked; `expect(checked).toBe(OUTBOX_STATUSES.length)` and `expect(checked).toBeGreaterThan(0)`. Every non-`replaced` status maps into `INVITE_WORDS`; `inviteWordOf("replaced")` is `null`.
  - `the five words, as spec §6.1 rules`: `delivered`, `complained` give `"delivered"`; `sent` gives `"sent"`; `delayed`, `queued`, `sending` give `"delayed"`; `bounced` gives `"bounced"`; `failed`, `suppressed`, `expired`, `dead` give `"not_delivered"`.
  - `a holding word exactly when seatOutcome holds the seat`: for every status `s` except `replaced`, `HOLDING_WORDS.includes(inviteWordOf(s))` equals `seatOutcome([s]) !== "failed"`. Report the count; zero is a failure.
  - `seat words: empty case first`: `{ rows: [], mailboxes: ["a@x"], stamped: false }` gives `["not_invited"]`; `{ rows: [], mailboxes: ["a@x"], stamped: true }` gives `["not_delivered"]` (equal to the word for `seatOutcome([])`, which is `"failed"`).
  - `seat words: only the seat's current mailboxes`: rows `[{ recipient: "Old@X", status: "delivered" }]` with mailboxes `["new@x"]` and `stamped: false` gives `["not_invited"]`; the same row with mailboxes `["old@x"]` gives `["delivered"]` (case-folded, as `queueFixtureInvite` folds).
  - `seat words: one per recipient, in mailbox order`: two mailboxes, statuses `sent` and `bounced`, give `["sent", "bounced"]`.
  - `no word says opened`: every `INVITE_WORD_KEYS` value in all four locales is non-empty and matches neither `/open/i` in `en` nor contains `—`.
- [ ] **Step 2: Run VT** on `src/lib/__tests__/invite-status.test.ts`. Expected: FAIL, the module is missing.
- [ ] **Step 3: Implement** `invite-status.ts`. Use a `switch` over `OutboxStatus` with an exhaustive `never` check, so a thirteenth status fails to compile. Add the keys `arbiter.invite.sent`, `.delivered`, `.delayed`, `.bounced`, `.notDelivered`, `.notInvited` and `arbiter.invite.help` (copy: spec §9) to all four locales; run `npm run i18n:gen-keys`.
- [ ] **Step 4: Run VT.** Expected: PASS; the totals sweep reports 12 checked.
- [ ] **Step 5: Mutation check.** From a `cp` backup, map `queued` to `"sent"`. The holding cross-check stays green (both are holding words), but the spec-table test must fail. Then map `complained` to `"not_delivered"`; the cross-check must fail. Restore from the backup and re-run VT.
- [ ] **Step 6: Commit** `feat(arbiter): invite words from the email outbox, total over its statuses`.

### Task 2: Per-seat presence and invite words on the round's boards

**Files:**
- Modify: `apps/web/src/lib/arbiter-view.ts` (type), `apps/web/src/server/usecases/external-play/check-ins.ts`, `apps/web/src/server/usecases/external-play/arbiter.ts:263-301` (`boardRows`), `:345` (`boardOf`), `:181` (`loadArbiterRound`)
- Test: `apps/web/src/server/usecases/__tests__/external-play-arbiter-seats.test.ts` (new, DB-backed; copy the seeding pattern of `external-play-arbiter.test.ts` and `external-play-checkin-extend.test.ts`)

**Interfaces:**
- Consumes: Task 1 `seatInviteWords`; `latestEmailStatus` (`server/email-outbox/status.ts:39`); `CHESS_SEAT_REF_TYPE`, `chessSeatRef` (`seat-stamp.ts`); `checkInCounts` (`server/external-play/window.ts:95`); `anchorOfRow` (already used by `checkinOf`); `SidePlayer.recipients` from `loadSides` (already called in `boardOf`).
- Produces:
  ```ts
  // lib/arbiter-view.ts
  export type ArbiterSeatCheckin = { here: boolean; invites: SeatInviteWord[] };
  // on ArbiterBoard:
  /** Phase 2 (spec §6): who has checked in, and each seat's invite words, by colour. Set only for a `checking_in` board of the
   *  round on screen; null in the Flagged list and for every other state. */
  seats: { white: ArbiterSeatCheckin; black: ArbiterSeatCheckin } | null;
  // check-ins.ts
  export async function checkedInAtOfBoards(fixtureIds: readonly string[]): Promise<Map<string, Map<string, Date | null>>>;
  ```
  `BoardRow` gains `whiteEmailedAt: Date | null`, `blackEmailedAt: Date | null`, `roundOpenId: string | null` (`ep.round_open_id`) and `openId: string | null` (`o.id`). A seat is stamped exactly when `roundOpenId !== null && roundOpenId === openId` and that colour's stamp is non-null. This is `boundStamps`' rule (`open-round-view.ts:93`).

- [ ] **Step 1: Write the failing tests** (each names the sequence it covers):
  - `empty case: a round with no board in check-in reads no seats and asks the outbox nothing` (spy on `latestEmailStatus`, or count statements; every board's `seats` is `null`).
  - `checked in during the window: here; before the window opened: not here` (stamp `fixture_availability.checked_in_at` one minute before `opensAt` for one player and inside the window for the other; the expected value comes from `checkInCounts`, not from the loader).
  - `CI default: a dead row and a released stamp reads Not delivered` (queue the invite through `openRound` with no API key; expect `["not_delivered"]` for both seats).
  - `delivered row, stamp held: Delivered`; `sent row: Sent`; `queued row: Delayed` (set `email_outbox.status` with the CHECKs honoured: `body = null` outside `queued` / `sending`, `lease_until` only for `sending`; re-stamp the seat bound to the open).
  - `re-paired seat: the previous player's mail is not this seat's word` (deliver to player A, Unpair, pair player B on the same fixture and colour, no new mail; expect `["not_invited"]`, never `"delivered"`).
  - `resend after Not delivered: the new row is the word` (the second call: a dead row, then `resendExternalPlayNotice`, then a `sent` row; expect `["sent"]`).
  - `stamped with no row: Not delivered, and a warning is logged`.
  - `another club's row for the same ref id is not read` (insert a `delivered` row under a second org with the same `ref_id`; expect the first org's word).
  - `a board past check-in (starting, live, on hold, result) carries seats null`.
  - `the Flagged list carries seats null` (`listFlaggedExternalPlay`).
- [ ] **Step 2: Run VT** on the new file. Expected: FAIL (`seats` is undefined).
- [ ] **Step 3: Implement.**
  - In `boardRows`, select the four columns.
  - Add `checkedInAtOfBoards` in `check-ins.ts`: one `select fixture_id, person_id, checked_in_at from fixture_availability where fixture_id in (...)`. `countedCheckIns` keeps its signature. The counting rule stays `checkInCounts`, its one authority.
  - In `loadArbiterRound`, before the `Promise.all`, read the presence map once, and read `latestEmailStatus(auth.orgId, CHESS_SEAT_REF_TYPE, refs)` once for the listed rows (two refs per row).
  - Pass both to `boardOf` in a new optional `ctx.seats`. In `boardOf`, set `seats` only when `state.kind === "checking_in"` and `ctx.seats` is given. `here` = `checkInCounts(at(personId), anchor)` (a `null` personId is not here). `invites` = `seatInviteWords({ rows: rows of that ref, mailboxes: side.recipients.map(r => r.email.trim().toLowerCase()), stamped })`. Log `warn` when stamped and no rows.
  - `listFlaggedExternalPlay` passes no `seats` context.
- [ ] **Step 4: Run VT** on the new file plus `external-play-arbiter.test.ts`, `external-play-flagged-and-run-sheet.test.ts` and `external-play-checkin-extend.test.ts`. Expected: PASS, and the totals match each file's count before the change plus the new tests.
- [ ] **Step 5: Mutation check.** From a `cp` backup, (a) drop the mailbox filter (the re-pair test must fail), (b) treat the stamp as bound without comparing `openId` (a test must fail; add `stamp from an earlier open is not bound` if none does), (c) drop the `orgId` argument's effect by passing the other org's id (the fence test must fail). Restore each time.
- [ ] **Step 6: tsc** on `apps/web`. `seats` is a required field, so every `ArbiterBoard` literal in the tests must add `seats: null`. Fix those fixtures and nothing else.
- [ ] **Step 7: Commit** `feat(arbiter): each check-in seat says whether its player is here and what their invite did`.

### Task 3: The column model (pure)

**Files:**
- Create: `apps/web/src/lib/round-column.ts`
- Test: `apps/web/src/lib/__tests__/round-column.test.ts`

**Interfaces:**
- Consumes: `ArbiterRound`, `ArbiterBoard`, `boardIsOver` (`lib/arbiter-view.ts`); `OpenRoundView` (`lib/open-round.ts`).
- Produces:
  ```ts
  export type RoundColumnPhase = "none" | "before" | "checkin" | "playing";
  export function roundColumnPhase(round: ArbiterRound | null, requested: "unavailable" | "own" | null): RoundColumnPhase;
  export type CheckinClock = { kind: "closes"; at: string } | { kind: "opens"; at: string } | { kind: "closed" };
  export function checkinClock(boards: readonly ArbiterBoard[], nowMs: number): CheckinClock;
  export type CheckinTally = { here: number; seats: number; playing: number; finished: number };
  export function checkinTally(boards: readonly ArbiterBoard[], nowMs: number): CheckinTally;
  export type PlayingTally = { playing: number; total: number; finished: number };
  export function playingTally(boards: readonly ArbiterBoard[]): PlayingTally;
  export type ReviewTarget = { kind: "select" } | { kind: "link" } | { kind: "none" };
  export function reviewTarget(fixtureId: string, round: ArbiterRound | null, card: { seated: boolean; cancelled: boolean }): ReviewTarget;
  export type EntryStatus =
    | { kind: "default" }
    | { kind: "attention"; count: number }
    | { kind: "checkin"; roundNo: number }
    | { kind: "ready"; roundNo: number };
  export function entryStatus(views: readonly OpenRoundView[], attention: number, nowMs: number): EntryStatus;
  export function viewOfRound(views: readonly OpenRoundView[], round: Pick<ArbiterRound, "stageId" | "roundNo">): OpenRoundView | null;
  export function nextRoundViews(views: readonly OpenRoundView[], round: ArbiterRound | null): OpenRoundView[]; // press === "open", excluding the round on screen; [] when round.current === false
  ```

- [ ] **Step 1: Write the failing tests**, empty case first in every `describe`:
  - Phase: `requested set: none, whatever the round` (also with `round` non-null); `no round: before`; `a board checking_in: checkin`; `none checking_in: playing`; `every board your own (boards [], ownBoards 2): playing`. Plus an ORDER case: `requested "own" with a round in check-in is none, not checkin`. This case fails if rule 1 moves below rule 3.
  - Clock: `no checking_in board: closed`; `one open window: closes at its deadline`; `two open windows: the EARLIER deadline`; `nothing open, a later group ahead: opens at the earliest opensAt`; `at exactly deadlineAt the window is closed` (half-open `[opensAt, deadlineAt)`, as `checkin-extend.ts` declares); `at exactly opensAt it is open`; `a checking_in board with checkin null is ignored` (the guard, reached).
  - Tally: `empty: all zero`; `seats are two per open-window checking_in board; a not-yet-open board is not counted`; `here counts seats.white.here and seats.black.here`; `seats null on a checking_in board counts as not here` (guard); `playing = starting + live; a held board is not playing` (the differential case: one `on_hold` board beside one `live`, so `playing` is 1, never 2); `finished = result boards; cancelled is never on the round`.
  - Playing tally: `empty boards: { playing: 0, total: 0, finished: 0 }`; `total is the boards on screen`.
  - Review target: `fixture in round.boards: select`; `not in the round: link`; `seated: none`; `cancelled: none`; `round null: link`.
  - Entry status ladder (empty case first): `nothing: default`; `attention 2 and a round ready: attention` (the ORDER case); `a round open with deadlineAt ahead: checkin`; `a round paired with press "open": ready`; `deadlineAt passed: not checkin`.
  - `nextRoundViews`: `pinned round (current false): []`; `excludes the round on screen`; `keeps the reader's order`.
  - `own boards are never counted`: a round with `ownBoards: 3` and one board on screen gives a tally over that one board only.
- [ ] **Step 2: Run VT.** Expected: FAIL, the module is missing.
- [ ] **Step 3: Implement** to the signatures. "Window open" is `Date.parse(opensAt) <= nowMs && nowMs < Date.parse(deadlineAt)`.
- [ ] **Step 4: Run VT.** Expected: PASS.
- [ ] **Step 5: Mutation check.** Reorder the phase ladder (put `checking_in` first), then reorder the entry ladder (put `ready` before `attention`), then count `on_hold` as playing. Each must turn exactly its named test red. Restore each time.
- [ ] **Step 6: Commit** `feat(arbiter): the round column's phase, clock and counts as one pure model`.

### Task 4: Lift the Open / Resend press out of `OpenRoundControl`

No behaviour change. This is the seam Tasks 5 to 7 consume.

**Files:**
- Create: `apps/web/src/components/v2/desk/use-open-round.ts`
- Modify: `apps/web/src/components/v2/desk/open-round-control.tsx` (use the hook; `export` `openNoticeText`, `resendNoticeText`, `timedBatches`, `owedPlayers`, `inviteState`)
- Test: the existing `components/v2/desk/__tests__/open-round-control.test.tsx`, `open-round-control-actions.test.tsx`, `open-round-batches-reachability.test.tsx` and `open-round-state.test.ts` stay green unchanged.

**Interfaces:**
- Produces:
  ```ts
  export type OpenRoundHandle = {
    state: OpenRoundUiState;
    ask(): void;
    cancel(): void;
    open(): void;           // openRoundRunner.open(view.stageId, view.roundNo)
    resend(fixtureId: string): void;
  };
  export function useOpenRound(view: OpenRoundView): OpenRoundHandle;
  ```
  The hook owns `useReducer(openRoundUi, …)`, `useRouter`, and `openRoundRunner` with `apiV1` POST and `router.refresh`, exactly as `OpenRoundControl` builds them today (`open-round-control.tsx:214-226`). The round's "+5" stays in `OpenRoundControl` for now; it is deleted with the control in Task 10.

- [ ] **Step 1: Record the baseline.** Run VT on the four test files and note `total` and `passed`.
- [ ] **Step 2: Refactor.** Move the reducer, router and runner wiring into the hook; `OpenRoundControl` calls `useOpenRound(round)`.
- [ ] **Step 3: Run VT.** Expected: the same `total` and `passed` as Step 1.
- [ ] **Step 4: Mutation check** (a true red is impossible for a refactor). Make the hook's `open()` call `runner.open(view.stageId, view.roundNo + 1)`. A test in `open-round-control-actions.test.tsx` must fail. If none does, add `the press opens THIS round` there. Restore.
- [ ] **Step 5: Commit** `refactor(desk): the open-round press as a hook the arbiter column can share`.

### Task 5: The column, before the round opens

**Files:**
- Create: `apps/web/src/components/v2/arbiter/round-column.tsx`
- Test: `apps/web/src/components/v2/arbiter/__tests__/round-column.test.tsx` (static render with the real `en` dictionary, wrapped in the providers `open-round-control.test.tsx` uses; mock `next/navigation` the way it does)
- Modify: the four `ui.json` files and `i18n-keys.ts` (keys `arbiter.column.label`, `arbiter.column.nothingPaired`, `arbiter.column.toFixtures`)

**Interfaces:**
- Consumes: Task 3 (`roundColumnPhase`, `nextRoundViews`); Task 4 (`useOpenRound`); `OpenRoundConfirmBody` and `openNoticeText` (`open-round-control.tsx`).
- Produces:
  ```ts
  export type RoundColumnData = {
    views: OpenRoundView[];                   // listOpenRounds, in the reader's order
    held: NeedsOrganiserExternalPlayRow[];     // type-only import from server/usecases/external-play/queue
    flagged: FlaggedBoard[];
    ownFlagged: number;
    tz: string;                                // getScheduleSettings(...).tz, the venue zone
    awaitsStart: boolean;                      // divisionScoringClosed(division.status)
  };
  export type RoundColumnProps = {
    round: ArbiterRound | null;
    requested: "unavailable" | "own" | null;
    data: RoundColumnData;
    nowMs: number | null;
    slugs: { org: string; comp: string; div: string };
    on: { select(fixtureId: string): void; extendBoard(fixtureId: string): void };
    roundExtend: React.ReactNode;              // the panel's own RoundExtend, placed in the hero (Task 8)
  };
  export function RoundColumn(p: RoundColumnProps): JSX.Element | null;
  ```
  Root: `<aside aria-label={t("arbiter.column.label")} data-testid="arbiter-round-column" data-phase=…>`. Before-phase block per view: `data-testid="arbiter-column-open"`, CTA `arbiter-column-open-cta`, confirm `arbiter-column-confirm` (inside it, `OpenRoundConfirmBody` with its existing testids, `open-round-earlier` included), notice `arbiter-column-open-notice`, pairings `arbiter-column-pairings`, start hint `arbiter-column-start-first`, empty line `arbiter-column-nothing`.

- [ ] **Step 1: Write the failing tests:**
  - `phase none: renders nothing` (`requested: "unavailable"`; the markup is empty).
  - `before, nothing to open: the empty line and a link to the Fixtures tab` (the href equals `routes.division(org, comp, div, "fixtures")`, never the arbiter route).
  - `before, division not started: the start line, no press` (the text equals `en["externalPlay.openRound.startFirst"]`).
  - `before, one view: heading, paired lede, Open round, pairings` (text from the `en` dictionary through `plural()` with the view's counts).
  - `before, two stages: each block names its stage; one stage: no stage name`.
  - `confirm open: OpenRoundConfirmBody with the earlier-in-play line when the view has earlierInPlay` (render the confirming state by passing an initial state through a test-only `initialState` prop on the block, or by rendering the exported pure `OpenRoundBlockView`; choose one and name it in the test).
  - `second press: already open, no second invite`: an `answered` notice whose result has `invited: 0` renders `en["externalPlay.openRound.alreadyOpen"]`, and the reducer refuses `open` while `busy` (R1). Assert through `openRoundUi`, the source of truth.
  - `every control in the column is at least 44px tall`: each `button` and `a` carries `min-h-11`.
- [ ] **Step 2: Run VT.** Expected: FAIL, the component is missing.
- [ ] **Step 3: Implement** the before branch only; the other phases render `null` for now. One primary button per block (`#7c3aed`), confirm as in `OpenRoundControl`. Add the three keys in four locales; run `npm run i18n:gen-keys`.
- [ ] **Step 4: Run VT.** Expected: PASS.
- [ ] **Step 5: Commit** `feat(arbiter): the round column before a round opens`.

### Task 6: The column during check-in

**Files:**
- Modify: `apps/web/src/components/v2/arbiter/round-column.tsx`
- Test: `apps/web/src/components/v2/arbiter/__tests__/round-column.test.tsx`
- Modify: the four `ui.json` files and `i18n-keys.ts`: `arbiter.column.checkin.closesIn`, `.opensIn`, `.closed`, `arbiter.column.checkin.tally.one/.other`, `arbiter.column.alreadyPlaying.one/.other`, `arbiter.column.finished.one/.other`, `arbiter.column.waiting.one/.other`, `arbiter.column.here`, `arbiter.column.notHereYet`, `arbiter.column.batchBoards` ("Boards {from} to {to}")

**Interfaces:**
- Consumes: Task 2 `board.seats`; Task 3 `checkinClock`, `checkinTally`, `viewOfRound`; Task 1 `INVITE_WORD_KEYS`; Task 4 `useOpenRound` (one handle for the round on screen, shared by the hero's reinvite press and the rows' Resend); `timedBatches`, `resendNoticeText`.
- Produces: testids `arbiter-checkin-hero`, `arbiter-checkin-clock` (`data-kind`), `arbiter-checkin-tally`, `arbiter-checkin-playing`, `arbiter-checkin-finished`, `arbiter-column-reinvite`, `arbiter-column-batches`, `arbiter-waiting`, `arbiter-waiting-row` (`data-fixture-id`), `arbiter-seat` (`data-colour`, `data-here`), `arbiter-invite-word` (`data-word`), `arbiter-waiting-resend`, `arbiter-waiting-extend`, `arbiter-invite-help`. Exported `WaitingList` (for Task 8 to place under the camera from `md`).

- [ ] **Step 1: Write the failing tests:**
  - `hero, empty tally: no board in check-in prints no "0 of 0"` (the tally line is absent).
  - `hero clock: closes / opens / closed, one string each` (render at `nowMs` before, inside and after the windows; the strings come from `en`).
  - `hero tally: 3 of 4 players checked in, and the progress bar says the same` (`aria-valuenow="3"`, `aria-valuemax="4"`).
  - `already playing: 2 boards; a held board is not counted; the finished clause shows only above zero`.
  - `the round's +5 is the panel's, placed here` (the hero renders the `roundExtend` node it is given, once; the column itself adds no `arbiter-extend-round` element).
  - `reinvite press shows only for press reinvite or reopen` (`press: "none"` gives no `arbiter-column-reinvite`).
  - `staggered: the groups, "Boards 1 to 8", with opens and closes` (no `–` in the markup).
  - `waiting list: empty case first` (every seat here gives no `arbiter-waiting`).
  - `waiting seat not here: "Not here yet" and one chip per invite word`; `seat here: "Here" and no invite chip`.
  - `Resend shows only when the view says canResend`; `no view for the round: no Resend on any row` (the guard).
  - `a row's +5 shows only when checkin.canExtend, and calls on.extendBoard(fixtureId)` (assert the button's `data-fixture-id`; the call itself is covered by Task 8's dispatch test).
  - `the help line says Delivered is not read` (text equals `en["arbiter.invite.help"]`).
  - `clock edges: at deadlineAt - 1 ms "closes", at deadlineAt "closed"` (Review Focus 3).
- [ ] **Step 2: Run VT.** Expected: FAIL.
- [ ] **Step 3: Implement.** Countdown `mm:ss` from `nowMs` (null before mount: render no digits, keep the label). Countdown in `CLOCK_FACE` at `text-3xl lg:text-4xl`, Ink. Chips: violet pair for `sent` / `delivered`, amber for `delayed` and "Not here yet", red for `bounced` / `not_delivered`, neutral outline for `not_invited`. Add the keys in four locales; gen-keys.
- [ ] **Step 4: Run VT.** Expected: PASS.
- [ ] **Step 5: Mutation check.** Remove the `canResend` condition (its test must fail), and print the tally when `seats === 0` (the empty-case test must fail). Restore.
- [ ] **Step 6: Commit** `feat(arbiter): check-in in the round column: the countdown, who is here, and what each invite did`.

### Task 7: The column while playing, and the queue cards

**Files:**
- Create: `apps/web/src/components/v2/arbiter/round-queue-cards.tsx`
- Modify: `apps/web/src/components/v2/arbiter/round-column.tsx`
- Test: `apps/web/src/components/v2/arbiter/__tests__/round-column.test.tsx`, `apps/web/src/components/v2/arbiter/__tests__/round-queue-cards.test.tsx`
- Modify: the four `ui.json` files and `i18n-keys.ts`: `arbiter.column.playing.one/.other`, `arbiter.column.queue.one/.other`, `arbiter.column.review` ("Review board {board}")

**Interfaces:**
- Consumes: Task 3 `playingTally`, `nextRoundViews`, `reviewTarget`; Task 4 `useOpenRound` (one per next-round view); `arbiterDecision` / `decisionRunner` (`components/v2/arbiter-decision.ts`) for the cancelled flagged card's Mark as reviewed, as `external-play-needs-result-queue.tsx` uses them.
- Produces: `export function RoundQueueCards(p: { round: ArbiterRound | null; held: NeedsOrganiserExternalPlayRow[]; flagged: FlaggedBoard[]; slugs; onSelect(fixtureId: string): void }): JSX.Element | null`; testids `arbiter-column-status`, `arbiter-column-next` (`data-primary`), `arbiter-column-earlier`, `arbiter-column-queue`, `arbiter-column-card` (`data-kind`, `data-fixture-id`), `arbiter-column-review`, `arbiter-column-mark-reviewed`.

- [ ] **Step 1: Write the failing tests:**
  - Queue: `empty case first: no cards, no title, no "0 boards"`.
  - `held in the round on screen: "Review board 4" is a BUTTON that calls onSelect, and nothing in the column links to the panel's own URL` (scan every `href` in the markup; none equals `routes.divisionArbiter(org, comp, div)` with or without the current board's `?fixture=`). This is the self-link fix.
  - `held in another round: "Review board 4" is a link to divisionArbiter(..., fixtureId)`.
  - `seated held card: the line, no action` (text equals `en["arbiter.notice.settleOwnBoard"]`; no `arbiter-column-review`).
  - `cancelled flagged card: Mark as reviewed, no Review`.
  - `title: "2 boards need a decision", red when any card is held, not red when only flagged`.
  - `the queue rises first in every phase` (the queue block comes before the hero and the status in source order).
  - Playing: `status "14 of 20 boards playing", finished clause above zero only`; `boards [] (own round): no counts at all`.
  - `next round while boards play: quiet button, earlier-in-play line inline` (the line equals the plural of `runsheet.round.confirmEarlierInPlay` for the view's first `earlierInPlay` entry); `every board over: the same button is primary` (`data-primary="true"`); `pinned older round: no next-round press`.
- [ ] **Step 2: Run VT.** Expected: FAIL.
- [ ] **Step 3: Implement.** Add the keys in four locales; gen-keys.
- [ ] **Step 4: Run VT.** Expected: PASS.
- [ ] **Step 5: Mutation check.** Make `reviewTarget` always `"link"`; the self-link test must fail. Restore.
- [ ] **Step 6: Commit** `feat(arbiter): the round column while playing: the queue as Review board N, and the next round with its warning`.

### Task 8: Mount the column in the panel

**Files:**
- Modify: `apps/web/src/components/v2/arbiter-panel.tsx` (`ArbiterScreenProps`, `ArbiterScreen` at `:217-380`, `ArbiterPanel` at `:940`, `EmptyNotice` use)
- Test: `apps/web/src/components/v2/__tests__/arbiter-panel.test.tsx`
- Modify: `arbiter.empty.body` in the four `ui.json` files (spec §9: it no longer says to open a round from the run sheet)

**Interfaces:**
- Consumes: Tasks 5 to 7 `RoundColumn`, `WaitingList`, `RoundColumnData`.
- Produces: `ArbiterScreenProps` gains `column: RoundColumnData` and `on.extendBoard(fixtureId: string): void`; `ArbiterPanel` gains a `column: RoundColumnData` prop. `on.extendBoard` = `select(fixtureId)` followed by `runner.extend(fixtureId, boardNo)` through the existing `linkedExtendDispatch`.

- [ ] **Step 1: Write the failing tests** in `arbiter-panel.test.tsx`:
  - `mount paths (spec §5.2 table)`: `requested` set gives no `arbiter-round-column`; `round null` gives the column with `data-phase="before"` beside `EmptyNotice`; `boards [] with ownBoards` gives `data-phase="playing"`; `board === null` (I3) gives no column; the grid gives the column. Report the five paths checked.
  - `one round extend on the page`: in check-in, exactly one `data-testid="arbiter-extend-round"` exists, inside `arbiter-checkin-hero`, and the top bar has none.
  - `md layout`: the `main` carries `md:grid` and `md:grid-cols-[minmax(0,1fr)_320px]` and keeps `lg:grid-cols-[248px_minmax(0,1fr)_320px]`; the picker label carries `md:col-span-2` and `lg:hidden`; the hero carries `max-md:order-[-2]`; the waiting list carries `max-md:order-[-1]` and `md:order-3`. Anchor every hidden-class assertion on `\s…hidden"`.
  - `the empty copy no longer sends the organiser to the run sheet` (the rendered body equals the new `en["arbiter.empty.body"]`, and that string does not contain "run sheet").
  - `extendBoard selects, then extends` (the decision reducer shows the selected board, then `busy.kind === "extend"`; drive it through `arbiterDecision` with the actions the shell dispatches).
- [ ] **Step 2: Run VT.** Expected: FAIL.
- [ ] **Step 3: Implement.** Pass `<RoundExtend …/>` into `RoundColumn` as `roundExtend` in place of the top-bar mount. Thread `column` through. Add `min-w-0` down every new wrapper.
- [ ] **Step 4: Run VT** on `arbiter-panel.test.tsx`, `round-column.test.tsx`, `round-queue-cards.test.tsx`, `arbiter-decision.test.ts`. Expected: PASS; `arbiter-panel.test.tsx`'s total is the old total plus the new tests.
- [ ] **Step 5: Commit** `feat(arbiter): the round column in the panel, a real column from md`.

### Task 9: The arbiter page: the flag and the column's data

**Files:**
- Modify: `apps/web/src/app/o/[orgSlug]/c/[compSlug]/d/[divSlug]/arbiter/page.tsx`
- Test: `apps/web/src/app/o/[orgSlug]/c/[compSlug]/d/[divSlug]/arbiter/__tests__/page.test.tsx` (it mocks `@/server/usecases/external-play`; extend the mock with `onlineChessOffered`, `listOpenRounds`, `listNeedsOrganiserExternalPlay` and `listFlaggedExternalPlay`, and mock `getScheduleSettings`)

**Interfaces:**
- Consumes: `onlineChessOffered` (`server/usecases/external-play/online-chess-flag.ts:42`), `listOpenRounds(auth, divisionId)`, `listNeedsOrganiserExternalPlay`, `listFlaggedExternalPlay`, `getScheduleSettings(auth, divisionId)` (`.tz`), `divisionScoringClosed` (the division page's import; re-pin it).
- Produces: `<ArbiterPanel … column={{ views, held, flagged: flagged.boards, ownFlagged: flagged.ownBoards, tz, awaitsStart }} />`.

- [ ] **Step 1: Write the failing tests:**
  - `flag off: 404, and no reader is asked` (`notFound` called; `loadArbiterRound` and `listOpenRounds` never called).
  - `flag on: the column gets the four reads and the venue zone` (exact props).
  - `not chess: 404 and the flag is never asked` (the other-sport witness).
  - `online play off: 404 and the flag is never asked` (the order of the checks: cheap ones first).
  - `requested "unavailable": the column's reads still run, and the panel decides` (pins that the page does not special-case it).
- [ ] **Step 2: Run VT.** Expected: FAIL.
- [ ] **Step 3: Implement.** Order: `canEdit`, sport, online play, then `await onlineChessOffered(page.auth)`, then the reads in one `Promise.all`.
- [ ] **Step 4: Run VT.** Expected: PASS.
- [ ] **Step 5: Mutation check.** Delete the flag check; `flag off: 404` must fail. Restore.
- [ ] **Step 6: Commit** `feat(arbiter): the panel follows the online-chess flag and loads its round column`.

### Task 10: The Fixtures tab after the move

**Files:**
- Modify: `apps/web/src/app/o/[orgSlug]/c/[compSlug]/d/[divSlug]/page.tsx:540-581` (reads) and `:825-881` (entry card, queue mount, `StagesPanel` props)
- Modify: `apps/web/src/components/v2/stages-panel.tsx` (`arbiterHrefFor` passed only when offered, `:1540`; the Open round mount at `:1351` already renders nothing without `openRounds`); `apps/web/src/components/v2/desk/run-sheet-row.tsx` (the comment "the round is opened from its stage card above" now says the Arbiter Panel)
- Modify: `apps/web/src/components/v2/external-play-needs-result-queue.tsx` (delete the `externalPlay.queue.review` link)
- Delete: `OpenRoundControl` and its round "+5" from `apps/web/src/components/v2/desk/open-round-control.tsx` once nothing renders it (`grep -a -rn "OpenRoundControl" apps/web/src` returns only its tests). Keep `OpenRoundConfirmBody` and the exported helpers. Retarget its tests to the column or delete the cases that only covered the removed control, listing each deleted test title in the commit body.
- Modify: the four `ui.json` files and `i18n-keys.ts`: `arbiter.entry.status.ready`, `arbiter.entry.status.checkin`
- Test: `apps/web/src/app/o/[orgSlug]/c/[compSlug]/d/[divSlug]/__tests__/online-chess-flag-wiring.test.tsx`, `apps/web/src/components/v2/__tests__/external-play-needs-result-queue.test.tsx`, `apps/web/src/components/v2/__tests__/stages-panel-open-round.test.tsx`

**Interfaces:**
- Consumes: Task 3 `entryStatus`.
- Produces: `arbiterOffered = editable && boardgame && onlinePlay === "lichess" && fixtures.length > 0 && await onlineChessOffered(auth)`, asked once per render and only on the Fixtures tab. Entry card `data-testid="arbiter-entry"` with `arbiter-entry-status` (`data-kind`).

- [ ] **Step 1: Write the failing tests:**
  - `offered: no Open round on any stage card, no queue, one entry card` (`openRounds` not passed; `ExternalPlayNeedsResultQueue` not rendered).
  - `offered: the entry line follows the ladder` (attention beats ready; texts from `en` through `plural()`).
  - `not offered: the queue stays, with no panel link` (`external-play-review` absent from the queue markup in every case; the queue still gets both lists). This updates the T16 case "online play off now: the queue gets both lists".
  - `flag off on a division playing online: no entry card, chip links are spans, the queue stays` (Review Focus 2).
  - `the start hint stays on the stage card when the division has not started` (`online-start-hint`).
  - `the empty case: a chess Fixtures tab with nothing held, nothing to open and the panel offered: the entry card with the default body`.
  - In `stages-panel-open-round.test.tsx`: `arbiterHrefFor absent: run-sheet chips render as spans`.
- [ ] **Step 2: Run VT.** Expected: FAIL.
- [ ] **Step 3: Implement.** Move the `arbiterHref` computation inside the `onlineDesk` branch and reuse the one `onlineChessOffered` answer. Add the keys in four locales; gen-keys.
- [ ] **Step 4: Run VT** on the three test files plus `components/v2/desk/__tests__/run-sheet-row.test.tsx` and every retargeted `open-round-control*` test. Expected: PASS.
- [ ] **Step 5: Mutation check.** Pass `openRounds` regardless of `arbiterOffered`; the "offered" test must fail. Restore.
- [ ] **Step 6: Commit** `feat(desk): the Fixtures tab hands the round to the Arbiter Panel and keeps the queue when the panel is not offered`.

### Task 11: The column's copy, swept

**Files:**
- Modify: `apps/web/src/lib/round-column.ts` (add `ROUND_COLUMN_KEYS`)
- Create: `apps/web/src/components/v2/arbiter/__tests__/round-column-copy.test.ts`
- Modify: the four `ui.json` files: reword `runsheet.round.paired`, `runsheet.round.openUntil`, `runsheet.round.err.notOnline`, `externalPlay.openRound.alreadyOpen`, `externalPlay.held.clockFlagUnsettled`, `externalPlay.queue.reviewedNew.one/.other` with no em dash and the same meaning (for example, "Paired, not opened. Nobody has been invited yet."; "Time's up: confirm the result")

**Interfaces:**
- Produces: `export const ROUND_COLUMN_KEYS: readonly DictionaryKey[]`, every key `round-column.tsx` and `round-queue-cards.tsx` can render, the plural keys listed by their stem.

- [ ] **Step 1: Write the failing tests:**
  - `every column key exists in all four locales` (plural stems resolve `.one` and `.other`); report the count and fail on zero.
  - `no em dash and no arrow in any locale` (`/[—→←↗]/`); report keys times locales checked.
  - `the list is the source's list, both ways`: read the two component files as text, collect every literal passed to `msg(`, `plural(`, `t(` and `f.t(`, and assert set equality with `ROUND_COLUMN_KEYS`. A key rendered but not listed fails, and so does one listed but never rendered.
  - `no invite word, in any locale, says opened` (for `en`, `/open/i` on the six `arbiter.invite.*` word values).
- [ ] **Step 2: Run VT.** Expected: FAIL on the em dashes.
- [ ] **Step 3: Reword** in four locales; run `npm run i18n:gen-keys` and `npm run i18n:check` (raw output, read the result).
- [ ] **Step 4: Run VT** on the copy test plus every test file that asserts one of the reworded strings. Find them with `grep -a -rln "runsheet.round.paired\|runsheet.round.openUntil\|alreadyOpen\|clockFlagUnsettled\|reviewedNew\|err.notOnline" apps/web/src apps/web/e2e scripts`. Tests that read the dictionary move on their own; a hard-coded English copy is updated to read the dictionary.
- [ ] **Step 5: Commit** `fix(i18n): the round column's copy has no em dash or arrow in any locale`.

### Task 12: E2E: a seeding helper, and the specs migrated off the Fixtures tab

E2E runs in CI only (Task 17). Each spec edit here is checked by `npx playwright test --list <spec>` (it collects and does not run) and by `tsc`.

**Files:**
- Modify: `apps/web/e2e/match-room-kit.ts`: add
  ```ts
  /** Spec §6: put a seat's newest outbox row in `status` (honouring V470's CHECKs: no body outside queued or sending, a lease
   *  only while sending, a unique provider id once the provider took it), and stamp the seat bound to its round's open when
   *  the status holds the seat (the hook's SEAT_HOLDING_STATUSES), or clear the stamp when it does not. */
  export async function seedSeatInvite(fixtureId: string, colour: "white" | "black", status: OutboxStatus): Promise<void>;
  ```
- Modify: `apps/web/e2e/online-chess-desk.spec.ts`: `Open round (D12)` (`:282`) and `Open round, staggered (I-1)` (`:446`) drive the column at `r.arbiterPath`; `the queue` (`:532`) settles from the panel through "Review board N", and lets a flagged board go on there; `Unpair while a game is on file` (`:659`) is unchanged and re-run.
- Modify: `apps/web/e2e/checkin-extend.spec.ts`: `the round: +5 min on the Fixtures tab …` (`:217`) becomes the panel's hero only (the "Fixtures tab does the same" half is replaced by an assertion that the Fixtures tab has no `open-round-extend`); `the bar at 320, 768 and 1280` (`:279`) measures the hero's bar; `the window's edges, live` (`:352`) reads `arbiter-checkin-clock` flipping `data-kind` with no reload.
- Modify: `apps/web/e2e/online-chess-division-page.spec.ts:49,64`: before Start, no `open-round` (unchanged); after Start, no `open-round` on the tab and an `arbiter-entry` reading "Round 1 is ready to open".
- Modify: `apps/web/e2e/arbiter-panel.spec.ts`: `desktop: from the run sheet to two boards` (`:252`) enters through `arbiter-entry`; `I-3` (`:505`): its queue half asserts the column card's Review opens the decision area, where the same No-result rule shows.
- Modify: `apps/web/e2e/walkthrough/chess-external-play.spec.ts`: `:501`, `:854` and `:963` open their rounds from the column; `:182` (the queue on an over-the-board division) also asserts there is no `external-play-review`. Re-read `:923`, `:1055`, `:1168` and `:1299` and move any Open round, queue or round "+5" step to the panel.

- [ ] **Step 1:** Write `seedSeatInvite`, and in each spec replace the Fixtures-tab locators with the column's testids from Tasks 5 to 7. Keep every assertion's strength. A migrated assertion that cannot hold on the new surface is a finding for the commit body, not a deletion.
- [ ] **Step 2:** `cd <worktree>/apps/web && npx playwright test --list e2e/online-chess-desk.spec.ts e2e/checkin-extend.spec.ts e2e/online-chess-division-page.spec.ts e2e/arbiter-panel.spec.ts e2e/walkthrough/chess-external-play.spec.ts`. Expected: every test is listed, with no collection error.
- [ ] **Step 3:** Sweep by behaviour, not filename: `grep -a -rn "open-round\b\|open-round-\|external-play-needs-result-queue\|external-play-review\|tab=fixtures" apps/web/e2e`. Every hit is either migrated or a deliberate "is absent" assertion. Record the count before and after in the commit body.
- [ ] **Step 4: tsc.** Then commit `test(e2e): drive Open round, the invites and the queue from the Arbiter Panel`.

### Task 13: E2E: the column at 1280 and across the seven widths

**Files:**
- Modify: `apps/web/e2e/arbiter-panel.spec.ts` (the `parallel` project, Desktop Chrome 1280, `AUTH_STATE` organiser)
- Modify: `apps/web/e2e/mobile.spec.ts` (serial; projects `mobile-320`, `mobile-360`, `mobile-se` 375, `mobile-14` 390, `mobile-430`, `tablet-768`, `tablet-834`; `AUTH_STATE`; it already imports `seedOnlineRound`)

- [ ] **Step 1: New tests in `arbiter-panel.spec.ts`:**
  - `round column: before, open from the column, then check-in with each invite's word` (`seedOnlineRound(…, { open: false })`; the panel shows `data-phase="before"`; Open, then confirm; a second Open press reads already open, and the outbox row count for the round does not grow (count the rows by SQL before and after); `data-phase="checkin"`; CI has no API key, so every seat reads `data-word="not_delivered"` and offers Resend; `seedSeatInvite` sets `delivered`, `sent`, `delayed` and `bounced` on four seats; after a reload each `arbiter-invite-word` reads its word from `uiEn`; nowhere on the page does "opened" appear).
  - `round column: a held board is "Review board N" and selects in place` (hold a board by SQL as `online-chess-desk.spec.ts:532` does; click Review; the URL path is unchanged, `aria-pressed` moves to that board, the settle fieldset is that board's).
  - `round column: Open round 2 stays offered while round 1 plays, with the warning` (round 1 live by `roundGameSql`; round 2 paired; `arbiter-column-earlier` reads the plural of `runsheet.round.confirmEarlierInPlay`; the press opens round 2, and the confirmation names the earlier games).
  - `Fixtures tab: no Open round, no queue, one entry line` (assert absence with its positive pair: the entry card is visible).
- [ ] **Step 2: New test in `mobile.spec.ts`**, written in the shape of the match-room test at `:5256`:
  `arbiter round column: below md the hero leads the page; from md it is the right-hand column; no horizontal scroll; 44px targets`. Seed an opened round with two boards. At width < 768: the hero's top is above the picker's, and the waiting list sits between them. At ≥ 768: the hero's left edge is at or right of the board pane's right edge. At every width: `document.documentElement.scrollWidth <= clientWidth`, and every `button` in `arbiter-round-column` is at least 44px and hit-tested with `elementFromPoint`. Count the relations and assert the expected count per branch (anti-vacuity), and print the column's `data-phase` beside the gate result (desk `_RULES.md`: print the asserted content). Also diff the visible control set inside the column at the project's width against the 1280 set from the same seed: below `md` the picker is in the set and the board list is not.
- [ ] **Step 3:** `npx playwright test --list e2e/arbiter-panel.spec.ts e2e/mobile.spec.ts`. Expected: the new tests are listed (`mobile.spec.ts` once per width project).
- [ ] **Step 4:** Commit `test(e2e): the round column at 1280 and at every phone and tablet width`.

### Task 14: Walkthrough: a whole round run from the column

**Files:**
- Modify: `apps/web/e2e/walkthrough/chess-external-play.spec.ts` (the `walkthrough` project)

- [ ] **Step 1:** Add `walkthrough: one round from the Arbiter Panel's column`. Seed an unopened round of four boards (`playable: true` for two of them). Then: open it from the column; read the countdown and "0 of 8 players checked in"; give one board "+5 min" from its row (its decision area shows the new closing time); check in both players of board 1 through their rooms (the existing room helpers) and watch the tally reach "2 of 8"; play board 1 a move (`roundGameSql`) and watch "1 board already playing"; let board 2's check-in run out by SQL (move its open stamp back) so the sweep holds it; on the column, "1 board needs a decision", then "Review board 2", then settle it from the decision area; finish the remaining boards by SQL; "Open round 2" becomes primary; open it. After each step, assert the column's `data-phase` and the line it changed. Budget it from its own costs (`Math.max(FLOOR, base + steps * slack)`, AGENTS.md class 20).
- [ ] **Step 2:** `npx playwright test --list e2e/walkthrough/chess-external-play.spec.ts`.
- [ ] **Step 3:** Commit `test(walkthrough): an online chess round run end to end from the Arbiter Panel`.

### Task 15: Smoke

**Files:**
- Modify: `scripts/smoke.ts`, in `onlineChessDeskSuite` (`:22696`). Check that the CI smoke job sets `ONLINE_CHESS_ALWAYS: "1"` (`.github/workflows/ci.yml`, about `:1739`; re-pin it).

- [ ] **Step 1:** Add checks. The organiser's GET of a division playing online returns an arbiter page whose HTML contains `data-testid="arbiter-round-column"`, anchored on `="`. Its Fixtures-tab HTML contains `data-testid="arbiter-entry"` and does not contain `data-testid="open-round"`. A signed-in stranger's GET of the arbiter page is a 404. Count the checks and assert the count (anti-vacuity, as the suite's "nine calls" check does).
- [ ] **Step 2:** `npx tsc --noEmit -p scripts` (or the repo's scripts typecheck; re-pin it). Running smoke locally is optional and must use `SMOKE_ONLY=online-chess-desk` against a local prod server from the `seazn-local-env` skill. CI's PR smoke is the arbiter.
- [ ] **Step 3:** Commit `test(smoke): the arbiter page carries the round column and the Fixtures tab no longer opens rounds`.

### Task 16: Screenshot sign-off at 1280, 768 and 320

**Files:** none committed. Evidence goes in a gitignored SDD directory (`.superpowers/…`), never in the repo.

- [ ] **Step 1:** Stand up a local prod server with the `seazn-local-env` skill. Seed with the e2e kit through a throwaway script in the scratchpad (`seedOnlineRound` plus `seedSeatInvite`).
- [ ] **Step 2:** Capture, at 1280, 768 and 320, cropped to the column (full-page shots hide defects): before; check-in with the four words and one "Here"; check-in with a staggered round's groups; playing with one held and one flagged card and "Open round 2" with its warning; and the Fixtures tab's entry card in its four ladder states. Assert `scrollWidth <= clientWidth` and print the phase beside each.
- [ ] **Step 3:** Confirm the images exist and DIFFER between states (AGENTS.md class 10). Write a per-screen PASS/FAIL table: what was asserted, what was seen, the width, and the phase. The owner's seven fixes are each a row.
- [ ] **Step 4:** The control-set diff, from the live DOM, of the column at 320 against 1280: membership, order and repeats.
- [ ] **Step 5:** Hand the table to the controller for the owner's per-screen verdicts (AGENTS.md class 11). Nothing is committed in this task.

### Task 17: Push, PR, CI, hand back

- [ ] **Step 1:** Scoped gate, once, over everything the branch touched: VT on every test file named in Tasks 1 to 11; `tsc`; eslint on the touched directories; `npm run i18n:check`. Paste the raw counts.
- [ ] **Step 2:** Push the branch and open a draft PR (smoke runs on PRs only). The PR body lists the e2e specs this changes, the status of OPEN-1 and OPEN-2, and the ops precondition: Resend's webhook must be subscribed to `email.delivered`, `email.delivery_delayed`, `email.bounced` and `email.complained` on staging and production, or the words stop at "Sent" (spec §6.3).
- [ ] **Step 3:** Dispatch e2e: `gh workflow run e2e.yml --ref feat/arbiter-round-column`. This covers the parallel, serial and walkthrough legs and all seven width projects.
- [ ] **Step 4:** Hand back at once with the PR URL, the head SHA, the local counts and the list of things owed to CI (e2e run id, smoke). Do NOT poll CI.
