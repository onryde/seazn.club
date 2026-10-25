# Arbiter Panel Round Column (Variant C) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Move Open round, the invites, "+5 min to the round" and the Held / Flagged queue off the division Fixtures tab and into a phase-adaptive side column on the Arbiter Panel. Each seat's invite status is read from the email outbox, and the panel sits behind the online-chess flag.

**Architecture:** The loader (`loadArbiterRound`) works in two passes. It builds the round's boards, then reads presence (the room's own `checkInCounts`) and the outbox (`latestEmailStatus`) once, for the `checking_in` boards only. A pure, total mapper turns the result into a per-seat `{ here, invites }`. A pure model (`lib/round-column.ts`) decides the phase, the counts, the queue count and the review targets. A client column (`components/v2/arbiter/round-column.tsx`) renders the three phases inside `ArbiterScreen`'s one-DOM grid. That grid gains an `md` two-track layout with explicit placement. The round's open-round handle lives in `ArbiterPanel`, so the hero and the waiting list share one in-flight guard. Whenever the panel is offered, the Fixtures tab loses its Open round controls and its queue. When the panel is not offered, the tab keeps the queue as a fallback (T20).

**Tech Stack:** Next.js 16 (read `node_modules/next/dist/docs/` before touching routing or caching), React server and client components, Tailwind, postgres.js, vitest (`environment: "node"`, `renderToStaticMarkup` with the real dictionaries), Playwright (CI only), `scripts/smoke.ts`.

**Spec:** `docs/superpowers/specs/2026-10-24-arbiter-round-column-design.md`. Section numbers below are the spec's. This plan was amended on 2026-10-24 by the pre-flight scan `.superpowers/sdd/2026-10-24-arbiter-round-column/preflight-scan.md` (C1 to C30) and the controller's rulings (`progress.md`). Every suggested ruling there is applied, with two controller exceptions. C13: the round bar's why and answer lines are preserved outside check-in. C23: an online-division smoke entry is built, and the check is not cut. A `(C<n>)` tag marks the text each ruling changed.

## Global Constraints

- **Rulings already made.** Controller ruling 1: the Fixtures tab gets option C, one status line on the existing entry card. Controller ruling 2: "Not invited" (`runsheet.round.notInvited`) is the sixth label. Both were applied under the owner's standing "apply the recommendation" rule, and the owner may override either (spec §2.1). Never call them owner rulings.
- **House theme only**, using the tokens in spec §4:
  - Ink `#2e1065`, Soft `#4a3a6b`, Muted `#6b5b8a`, Line `#e7e3f3`;
  - accent `#7c3aed` / `#5b21b6`;
  - held `#b42318` on `#fef2f2`, border `#f1c4c0`;
  - caution `#713f12` on `#fef3c7`, border `#f5d27a`;
  - live dot `#4ade80`.

  `CLOCK_FACE` (`arbiter-panel.tsx:207`) is for the countdown and the tally numbers only. Take no colour, font, radius or shadow from the spike.
- **One DOM, branched.** The column becomes a column at `md` (768), with the explicit placement in spec §5.1 (C10). Phone-only is `md:hidden`; desktop-only is `max-md:hidden`. Anchor class assertions on `\s...hidden"`, because `/\bmd:hidden\b/` also matches `max-md:hidden`. A landmark (`aside`) is never `display: contents`.
- `min-w-0` on every ancestor of a truncating name.
- **Invite words.** They are exactly Sent / Delivered / Delayed / Bounced / Not delivered, plus "Not invited" when there is no mail. Never "opened", never "Invited" as a seat status.
- **No em dash** (`—`) and **no arrow** (`→ ← ↗`) in any DICTIONARY string the column renders, in any locale. Names are data: `sideDisplayName`'s em-dash floor (`guard.ts:363-374`) stays.
- **Copy.** Every new or changed user-facing string goes into all four locales (`apps/web/src/dictionaries/{en,es,fr,nl}/ui.json`) with real translations. Then run `npm run i18n:gen-keys` (root script; `i18n-keys.ts` is GENERATED) and `npm run i18n:check`. Counted strings go through `plural()` / `useMsgPlural` (`.one` / `.other`). No verb agrees with a stage name. A zero clause is suppressed, never printed.
- **No new API route.** The column calls only routes that exist today: open round, resend, the board and round extend, settle, resync, go on, mark reviewed.
- **The online-chess flag** gates the PANEL and every link into it. It never gates a finishing control (T20). Entry and chip links follow `canEdit`; the controls and the queue follow `editable` (C18).
- **Logging.** Use the module's existing `log` (`@/server/logger`; `arbiter.ts:49` imports it). Since #1009 (`62bea803c`, merged to main after this branch's base `f94d9bd7c`), the logger strips DB echo fields. Rebasing is the controller's call, not a task here.
- **Tests: TEST-STRATEGY.md is binding.**
  - Write the failing test first and watch it fail.
  - State the empty case first.
  - Every sweep reports its count, and zero is a failure.
  - Expected values come from `OUTBOX_STATUSES`, `seatOutcome`, `checkInCounts`, the fixtures and the dictionaries, never from the code under test.
  - Mutate each new guard once from a `cp` backup, never with `git checkout <file>`.
- **Four test types, wave-level** (RULES.md:102-109; pre-flight D). Tasks 1 to 11 carry unit tests. Their e2e and smoke land in Tasks 12 to 15, and no task in 1 to 11 is "done" until its owning e2e and smoke pass in CI. The map is the table under the File map.
- **Never run the full suite, the full gate or any e2e locally.** Run only the scoped vitest paths each task names. E2E runs in CI by `workflow_dispatch` with `--ref <branch>`. Screenshots come from a throwaway capture script against a local prod server, not from the e2e suite.
- **Execution is strictly sequential** (pre-flight A31 to A38). Every copy task regenerates `i18n-keys.ts`, and several tasks share files. Run gen-keys before every commit that touches a dictionary.
- **Scoped vitest recipe** (called **VT** below), per task (AGENTS class 9). Write a FRESH report file in your own scratchpad subdirectory, delete it first, and read the counts AND the resolved file names:
  ```bash
  R=<scratchpad>/<your-agent-dir>/arbcol-t<N>.json; rm -f "$R"; \
  cd <worktree>/apps/web && npx vitest run --reporter=json --outputFile="$R" <paths>; \
  jq '{total: .numTotalTests, passed: .numPassedTests, failed: .numFailedTests, files: [.testResults[].name]}' "$R"
  ```
  A missing file means the run never started; it is never green. DB-backed suites need the local test DB from the `seazn-local-env` skill: a fresh schema is `db:apply` plus `sync:sports`, and confirm that `show data_directory` is yours. A fresh worktree has no `node_modules`, so set it up first. Never trust an `rtk` summary.
- **Typecheck with the repo's scripts** (TypeScript 7, typescript-native), never a bare `npx tsc` (that resolves TypeScript 6; C30):
  - `apps/web`: `cd <worktree>/apps/web && rtk proxy npm run typecheck` (it also checks `tsconfig.scripts.json`);
  - `scripts/` alone: `cd <worktree> && rtk proxy npm run typecheck:scripts`.

  Lint: `rtk proxy npx eslint <dir>`. Lint the DIRECTORY for bracketed route paths, and read `✖ N problems`.
- **Shell and git.** `grep -a` always; on BSD use `grep -a -rnE` with plain `|` alternation (C21). Use `/usr/bin/git`. Commit with explicit pathspecs: `next dev` writes untracked `apps/web/AGENTS.md` / `CLAUDE.md`, so never `git add -A`. No `git stash`.
- **Evidence PNGs are never committed.** They go in the gitignored `.superpowers/` directory, with a PASS/FAIL text table.

## Review Focus

1. **A board re-paired after an Unpair** must not show the previous player's "Delivered" beside the new player. The ref id is fixture plus colour, not the person. Owning test: Task 2, `re-paired seat: the previous player's mail is not this seat's word`.
2. **Online play switched off, or the flag off, with a board held:** the panel 404s, so the Fixtures tab must still show the queue and its finishing controls, and must render no link into the panel. Owning tests: Task 9 `flag off: 404`, and Task 10 `not offered: the queue stays, with no panel link`.
3. **The clock crossing an edge with the page open and no refresh** (a board's deadline passes, a later check-in group opens): the hero must flip between "closes in", "opens in" and "closed" on time, and a row's +5 must leave at the deadline. Owning tests: Task 3 `checkinClock at the exact deadline millisecond`, Task 6 `clock edges` and `row +5 follows the live clock`; e2e `checkin-extend.spec.ts` "window's edges, live", migrated in Task 12.
4. **The organiser plays on a board of the round, or on a held one:** a held card the organiser is `seated` on offers no action and is not counted in "{count} boards need a decision", and flagged boards the organiser plays on are counted only in the `ownFlagged` line. The loader already leaves own boards out of `round.boards` (`arbiter.ts:197-204`). Owning tests: Task 7 `seated held card: shown, not counted, no action` and `ownFlagged line`.
5. **A double click on the confirmation, or a press from a stale page:** the column's press goes through `openRoundRunner`'s in-flight guard. A double click sends one POST, and a press from a page made stale by an open elsewhere reads "already open" and invites nobody. Owning tests: Task 5 `busy: the CTA is disabled` and `already_open notice`; e2e Task 13 (C20).

---

## File map

| File | Responsibility | Task |
|---|---|---|
| `apps/web/src/lib/invite-status.ts` (new) | Outbox status to invite word; a seat's words from its rows | 1 |
| `apps/web/src/server/usecases/external-play/seat-stamp.ts` | `seatStampBound`, the one rule for "a stamp bound to this open" (C15) | 2 |
| `apps/web/src/server/usecases/external-play/open-round-view.ts` | `boundStamps` re-expressed through `seatStampBound` | 2 |
| `apps/web/src/lib/arbiter-view.ts` | `ArbiterSeatCheckin`, `ArbiterBoard.seats` | 2 |
| `apps/web/src/server/usecases/external-play/check-ins.ts` | bulk `checkedInAtOfBoards` beside `countedCheckIns` | 2 |
| `apps/web/src/server/usecases/external-play/arbiter.ts` | `BoardRow` stamp columns; the seats pass in `loadArbiterRound` | 2 |
| `apps/web/src/lib/round-column.ts` (new) | phase, clock, tallies, waiting set, queue count, review target, entry status and line, key lists | 3, 11 |
| `apps/web/src/components/v2/desk/use-open-round.ts` (new) | the Open / Resend handle lifted out of `OpenRoundControl` | 4, 10 |
| `apps/web/src/components/v2/desk/open-round-control.tsx` | exports its copy helpers; `OpenRoundControl` deleted in Task 10 | 4, 10 |
| `apps/web/src/components/v2/desk/open-round-state.ts` | the dead round-extend branches deleted in Task 10 (C26) | 10 |
| `apps/web/src/components/v2/arbiter/round-column.tsx` (new) | the column: before, check-in, playing; `OpenRoundBlockView`; `WaitingList` | 5, 6, 7 |
| `apps/web/src/components/v2/arbiter/round-queue-cards.tsx` (new) | the compact Held / Flagged cards | 7 |
| `apps/web/src/components/v2/arbiter-panel.tsx` | mounts the column; the `md` grid; `RoundExtend` placed by path; the round's handle | 8 |
| `apps/web/src/app/o/[orgSlug]/c/[compSlug]/d/[divSlug]/arbiter/page.tsx` | flag gate; loads the column's data | 9 |
| `apps/web/src/app/o/[orgSlug]/c/[compSlug]/d/[divSlug]/page.tsx` | `arbiterOffered` (`canEdit`); no controls or queue when offered; entry status | 10 |
| `apps/web/src/components/v2/stages-panel.tsx` | `openRounds` prop and mount removed; `arbiterHrefFor` optional | 10 |
| `apps/web/src/components/v2/external-play-needs-result-queue.tsx` | the "Review in arbiter panel" link removed | 10 |
| `apps/web/src/dictionaries/{en,es,fr,nl}/ui.json`, `apps/web/src/lib/i18n-keys.ts` (generated) | copy | 1, 5, 6, 7, 8, 10, 11 |
| `apps/web/e2e/match-room-kit.ts` | `seedSeatInvite` helper | 12 |
| `apps/web/e2e/{online-chess-desk,checkin-extend,online-chess-division-page,arbiter-panel}.spec.ts` | migrated off the Fixtures tab | 12 |
| `apps/web/e2e/arbiter-panel.spec.ts`, `apps/web/e2e/mobile.spec.ts` | new column coverage, seven widths | 13 |
| `apps/web/e2e/walkthrough/chess-external-play.spec.ts` | migrated, plus a whole round from the column | 12, 14 |
| `scripts/smoke.ts` | an online-division entry and page-level checks | 15 |

**Task to its owning e2e and smoke** (the wave-level four-types map):

| Task | Owning e2e (Task 12 to 14) | Owning smoke (Task 15) |
|---|---|---|
| 1, 2 | `arbiter-panel.spec.ts` "invite words" (13); walkthrough (14) | arbiter page carries the column |
| 3, 6 | `checkin-extend.spec.ts` migrated (12); `mobile.spec.ts` (13) | arbiter page carries the column |
| 4, 5 | `online-chess-desk.spec.ts` Open round, migrated (12); double click and stale page (13) | arbiter page carries the column |
| 7 | `online-chess-desk.spec.ts` queue, migrated (12); "Review board N in place" (13) | none (no page-level signal beyond the column) |
| 8 | `mobile.spec.ts` seven widths (13); `arbiter-panel.spec.ts` phone test (12) | arbiter page carries the column |
| 9 | `arbiter-panel.spec.ts` "no panel for anyone else" (unchanged, re-run) | stranger's 404 |
| 10 | `online-chess-division-page.spec.ts` (12); "Fixtures tab: one entry line" (13) | Fixtures tab: entry present, `open-round` absent |
| 11 | every spec above reads copy from `uiEn` | none |

---

### Task 1: Invite words

**Files:**
- Create: `apps/web/src/lib/invite-status.ts`
- Test: `apps/web/src/lib/__tests__/invite-status.test.ts`
- Modify: the four `ui.json` files, and regenerate `apps/web/src/lib/i18n-keys.ts`

**Interfaces:**
- Consumes:
  - `OUTBOX_STATUSES`, `LIVE_STATUSES` and `type OutboxStatus` from `apps/web/src/server/email-outbox/constants.ts`. That file is pure, with no imports and no `server-only`. Import the TYPE only into `lib/`.
  - `seatOutcome` from `server/usecases/external-play/invite.ts:230`, and `SEAT_HOLDING_STATUSES` from `invite-outbox-hook.ts:45`. Both are for the tests only.
- Produces:
  ```ts
  export const INVITE_WORDS = ["sent", "delivered", "delayed", "bounced", "not_delivered"] as const;
  export type InviteWord = (typeof INVITE_WORDS)[number];
  export type SeatInviteWord = InviteWord | "not_invited";
  export const HOLDING_WORDS: readonly InviteWord[]; // ["sent", "delivered", "delayed"]
  /** not_invited -> "runsheet.round.notInvited" (the run sheet's existing key; ruling 2, C2). */
  export const INVITE_WORD_KEYS: Readonly<Record<SeatInviteWord, DictionaryKey>>;
  export function inviteWordOf(status: OutboxStatus): InviteWord | null;
  /** Folds BOTH sides with trim().toLowerCase() (one authority, C1); drops a `replaced` row; callers pass raw addresses. */
  export function seatInviteWords(seat: {
    rows: readonly { recipient: string; status: OutboxStatus }[];
    mailboxes: readonly string[];
    stamped: boolean;
  }): SeatInviteWord[];
  ```

- [ ] **Step 1: Write the failing tests** in `invite-status.test.ts`:
  - `inviteWordOf is total over OUTBOX_STATUSES`: loop `OUTBOX_STATUSES` and count the statuses checked. Assert `expect(checked).toBe(OUTBOX_STATUSES.length)` and `expect(checked).toBeGreaterThan(0)`. Every non-`replaced` status maps into `INVITE_WORDS`; `inviteWordOf("replaced")` is `null`.
  - `the five words, as spec §6.1 rules`:
    - `delivered` and `complained` give `"delivered"`;
    - `sent` gives `"sent"`;
    - `delayed`, `queued` and `sending` give `"delayed"`;
    - `bounced` gives `"bounced"`;
    - `failed`, `suppressed`, `expired` and `dead` give `"not_delivered"`.
  - `a holding word exactly when seatOutcome holds the seat`: for every status `s` except `replaced`, `HOLDING_WORDS.includes(inviteWordOf(s))` equals `seatOutcome([s]) !== "failed"`. Report the count; zero is a failure.
  - `the e2e kit's holding list is the hook's` (C3): `SEAT_HOLDING_STATUSES` deep-equals `[...LIVE_STATUSES, "complained"]`, which is the expression Task 12's kit uses.
  - `seat words: empty case first`:
    - `{ rows: [], mailboxes: ["a@x"], stamped: false }` gives `["not_invited"]`;
    - `{ rows: [], mailboxes: ["a@x"], stamped: true }` gives `["not_delivered"]`, which equals the word for `seatOutcome([])` (`"failed"`).
  - `seat words: only the seat's current mailboxes, folded on both sides` (C1):
    - rows `[{ recipient: "Old@X", status: "delivered" }]` with mailboxes `["new@x"]` and `stamped: false` give `["not_invited"]`;
    - the same row with mailboxes `[" OLD@x "]` gives `["delivered"]`.
  - `seat words: a replaced row is dropped` (C1): rows `[{ recipient: "a@x", status: "replaced" }]`, mailboxes `["a@x"]` and `stamped: true` give `["not_delivered"]`, never a word for the replaced row.
  - `seat words: one per recipient, in mailbox order`: two mailboxes with statuses `sent` and `bounced` give `["sent", "bounced"]`.
  - `"Not invited" is the run sheet's key`: `INVITE_WORD_KEYS.not_invited === "runsheet.round.notInvited"`, and every value of `INVITE_WORD_KEYS` resolves to a non-empty string in all four locales. The "no word says opened" sweep lives in Task 11 only (A3).
- [ ] **Step 2: Run VT** on `src/lib/__tests__/invite-status.test.ts`. Expected: FAIL, because the module is missing.
- [ ] **Step 3: Implement** `invite-status.ts`. Use a `switch` over `OutboxStatus` with an exhaustive `never` check, so a thirteenth status fails to compile. Add the keys `arbiter.invite.sent`, `.delivered`, `.delayed`, `.bounced`, `.notDelivered` and `arbiter.invite.help` (copy: spec §9) to all four locales. Add NO `arbiter.invite.notInvited`. Run `npm run i18n:gen-keys`.
- [ ] **Step 4: Run VT.** Expected: PASS; the totals sweep reports 12 checked.
- [ ] **Step 5: Mutation check.** Work from a `cp` backup and restore after each mutation, then re-run VT.
  - (a) Map `queued` to `"sent"`. The holding cross-check stays green (both are holding words), but the spec-table test must fail.
  - (b) Map `complained` to `"not_delivered"`. The cross-check must fail.
  - (c) Fold only the row side. The `" OLD@x "` case must fail.
- [ ] **Step 6: Commit** `feat(arbiter): invite words from the email outbox, total over its statuses`.

### Task 2: Per-seat presence and invite words on the round's boards

**Files:**
- Modify:
  - `apps/web/src/server/usecases/external-play/seat-stamp.ts` (add `seatStampBound`);
  - `apps/web/src/server/usecases/external-play/open-round-view.ts:93` (`boundStamps` uses `seatStampBound`);
  - `apps/web/src/lib/arbiter-view.ts` (type);
  - `apps/web/src/server/usecases/external-play/check-ins.ts`;
  - `apps/web/src/server/usecases/external-play/arbiter.ts`: `boardRows` (`:263-301`), `boardOf` (`:345`) and `loadArbiterRound` (`:154`; its `boardRows` call is `:181`).
- Test: `apps/web/src/server/usecases/__tests__/external-play-arbiter-seats.test.ts` (new, DB-backed; copy the seeding pattern of `external-play-arbiter.test.ts` and `external-play-checkin-extend.test.ts`).

**Interfaces:**
- Consumes:
  - Task 1 `seatInviteWords`;
  - `latestEmailStatus` (`server/email-outbox/status.ts:36`);
  - `CHESS_SEAT_REF_TYPE` and `chessSeatRef` (`seat-stamp.ts:17`, `:21`);
  - `checkInCounts` (`server/external-play/window.ts:95`);
  - `anchorOfRow` (already used by `checkinOf`);
  - `SidePlayer.recipients` from `loadSides` (already called in `boardOf`).
- Produces:
  ```ts
  // seat-stamp.ts (C15: the one rule; open-round-view's boundStamps and the arbiter loader both call it)
  export function seatStampBound(
    row: { roundOpenId: string | null; whiteEmailedAt: Date | null; blackEmailedAt: Date | null },
    openId: string | null,
    colour: Colour,
  ): boolean; // openId !== null && row.roundOpenId === openId && that colour's stamp !== null
  // lib/arbiter-view.ts
  export type ArbiterSeatCheckin = { here: boolean; invites: SeatInviteWord[] };
  // on ArbiterBoard:
  /** Phase 2 (spec §6): who has checked in, and each seat's invite words, by colour. Set only for a `checking_in` board of the
   *  round on screen; null in the Flagged list and for every other state. */
  seats: { white: ArbiterSeatCheckin; black: ArbiterSeatCheckin } | null;
  // check-ins.ts
  export async function checkedInAtOfBoards(fixtureIds: readonly string[]): Promise<Map<string, Map<string, Date | null>>>;
  ```
  `BoardRow` gains `whiteEmailedAt: Date | null`, `blackEmailedAt: Date | null`, `roundOpenId: string | null` (`ep.round_open_id`) and `openId: string | null` (`o.id`).

- [ ] **Step 1: Write the failing tests.** Each test name says the sequence it covers.
  - `empty case: a round with no board in check-in issues no outbox read`. Every board's `seats` is `null`, and a spy on `latestEmailStatus` records zero calls (C24).
  - `checked in during the window: here; before the window opened: not here`. Stamp `fixture_availability.checked_in_at` one minute before `opensAt` for one player and inside the window for the other. The expected value comes from `checkInCounts`, not from the loader.
  - `CI default: a dead row and a released stamp reads Not delivered`. Queue the invite through `openRound` with no API key; both seats read `["not_delivered"]`.
  - `delivered row, stamp held: Delivered`; `sent row: Sent`; `queued row: Delayed`. Set `email_outbox.status` with the V470 CHECKs honoured: `body = null` outside `queued` / `sending`, and `lease_until` only for `sending`. Re-stamp the seat bound to the open.
  - `re-paired seat: the previous player's mail is not this seat's word`. Deliver to player A, Unpair, pair player B on the same fixture and colour, and send no new mail. Expect `["not_invited"]`, never `"delivered"`.
  - `resend after Not delivered: the new row is the word`. This is the second call, and it is reachable here, not from the screen (C4): a dead row, then `resendExternalPlayNotice`, then a `sent` row. Expect `["sent"]`.
  - `stamped with no row: Not delivered, and a warning is logged` (through the module's `log`).
  - `a stamp from an earlier open is not bound`. The stamp's `round_open_id` names another open, so the seat reads as not stamped.
  - `another club's row for the same ref id is not read`. Insert a `delivered` row under a second org with the same `ref_id`; expect the first org's word.
  - `a board past check-in (starting, live, on hold, result) carries seats null`.
  - `the Flagged list carries seats null` (`listFlaggedExternalPlay`).
- [ ] **Step 2: Run VT** on the new file. Expected: FAIL, because `seats` is undefined.
- [ ] **Step 3: Implement.**
  - **`seatStampBound`:** write it in `seat-stamp.ts`, and re-express `boundStamps` through it with no change in behaviour.
  - **`boardRows`:** select the four new columns.
  - **`checkedInAtOfBoards`:** add it to `check-ins.ts` as one query, `select fixture_id, person_id, checked_in_at from fixture_availability where fixture_id in (...)`. `countedCheckIns` keeps its signature, and the counting rule stays in `checkInCounts`, its one authority.
  - **Two passes in `loadArbiterRound`** (C24):
    1. Build the boards exactly as today, through `boardOf`.
    2. Collect the `checking_in` boards' fixture ids. Read `checkedInAtOfBoards(ids)` once, and `latestEmailStatus(auth.orgId, CHESS_SEAT_REF_TYPE, refs)` once with two refs per id. Attach `seats` to those boards.

    `boardOf` sets `seats: null`; the second pass replaces it. For each seat:
    - `here` = `checkInCounts(at(personId), anchor)`; a null `personId` is not here;
    - `invites` = `seatInviteWords({ rows: the rows of that ref, mailboxes: side.recipients.map(r => r.email), stamped: seatStampBound(row, row.openId, colour) })`. Pass the raw emails; `seatInviteWords` folds them.
  - **Logging:** call `log.warn` when a seat is stamped and has no rows.
  - **The Flagged list:** `listFlaggedExternalPlay` has no second pass.
- [ ] **Step 4: Run VT** on the new file plus `external-play-arbiter.test.ts`, `external-play-arbiter-reopen.test.ts` (reopen and stamp binding, C24), `external-play-flagged-and-run-sheet.test.ts`, `external-play-checkin-extend.test.ts` (all in `apps/web/src/server/usecases/__tests__/`) and `apps/web/src/server/usecases/external-play/__tests__/open-round-view.test.ts` (it witnesses `boundStamps`). Expected: PASS. Each file's total equals its count before the change, plus the new tests.
- [ ] **Step 5: Mutation check.** Work from a `cp` backup and restore after each mutation.
  - (a) Drop the mailbox filter. The re-pair test must fail.
  - (b) Make `seatStampBound` ignore `openId`. The earlier-open test must fail, and so must a case in `open-round-view.test.ts`.
  - (c) Pass the other org's id. The fence test must fail.
  - (d) Read the outbox for every listed board, not only the `checking_in` ones. The empty-case spy must fail.
- [ ] **Step 6: Typecheck.** Run `cd <worktree>/apps/web && rtk proxy npm run typecheck`. `seats` is a required field, so every `ArbiterBoard` literal in the tests must add `seats: null`. These include the `board()` factory in `arbiter-panel.test.tsx` (`:80`), `external-play-needs-result-queue*.test.tsx`, `online-chess-flag-controls.test.tsx` and `external-play-needs-organiser.test.ts`. Fix those fixtures and nothing else.
- [ ] **Step 7: Commit** `feat(arbiter): each check-in seat says whether its player is here and what their invite did`.

### Task 3: The column model (pure)

**Files:**
- Create: `apps/web/src/lib/round-column.ts`
- Test: `apps/web/src/lib/__tests__/round-column.test.ts`

**Interfaces:**
- Consumes:
  - `ArbiterRound`, `ArbiterBoard` and `boardIsOver` from `lib/arbiter-view.ts`;
  - `OpenRoundView` from `lib/open-round.ts`;
  - `inExtendWindow` from `lib/checkin-extend.ts:65`, the one window rule (C5; never restate it);
  - `type NeedsOrganiserExternalPlayRow` (`server/usecases/external-play/queue.ts`) and `type FlaggedBoard` (`server/usecases/external-play/arbiter.ts`), both type-only.
- Produces:
  ```ts
  export type RoundColumnPhase = "none" | "before" | "checkin" | "playing";
  export function roundColumnPhase(round: ArbiterRound | null, requested: "unavailable" | "own" | null): RoundColumnPhase;
  export type CheckinClock = { kind: "closes"; at: string } | { kind: "opens"; at: string } | { kind: "closed" };
  export function checkinClock(boards: readonly ArbiterBoard[], nowMs: number): CheckinClock;
  /** checking_in boards whose window is open now (inExtendWindow over board.checkin): the tally's set AND the waiting list's (A6). */
  export function openWindowBoards(boards: readonly ArbiterBoard[], nowMs: number): ArbiterBoard[];
  export type CheckinTally = { here: number; seats: number; playing: number; finished: number };
  export function checkinTally(boards: readonly ArbiterBoard[], nowMs: number): CheckinTally;
  export type PlayingTally = { playing: number; total: number; finished: number };
  export function playingTally(boards: readonly ArbiterBoard[]): PlayingTally;
  /** C6: distinct fixtureIds over held rows that are not `seated`, plus flagged boards. The column's title and the entry line share it. */
  export function attentionCount(held: readonly NeedsOrganiserExternalPlayRow[], flagged: readonly FlaggedBoard[]): number;
  export type ReviewTarget = { kind: "select" } | { kind: "link" } | { kind: "none" };
  export function reviewTarget(fixtureId: string, round: ArbiterRound | null, card: { seated: boolean; cancelled: boolean }): ReviewTarget;
  /** C7: attention and phase stay separate facts (desk _RULES). */
  export type EntryStatus = { attention: number; phase: "default" | "checkin" | "ready"; roundNo: number | null };
  export function entryStatus(views: readonly OpenRoundView[], attention: number, nowMs: number): EntryStatus;
  export type EntryLine =
    | { kind: "default" }
    | { kind: "attention"; count: number }
    | { kind: "checkin"; roundNo: number }
    | { kind: "ready"; roundNo: number };
  export function entryLine(s: EntryStatus): EntryLine;
  export function viewOfRound(views: readonly OpenRoundView[], round: Pick<ArbiterRound, "stageId" | "roundNo">): OpenRoundView | null;
  /** press === "open", excluding the round on screen; [] when round.current === false. */
  export function nextRoundViews(views: readonly OpenRoundView[], round: ArbiterRound | null): OpenRoundView[];
  ```

- [ ] **Step 1: Write the failing tests**, empty case first in every `describe`:
  - **Phase:**
    - `requested set: none, whatever the round` (also with `round` non-null);
    - `no round: before`;
    - `a board checking_in: checkin`;
    - `none checking_in: playing`;
    - `every board your own (boards [], ownBoards 2): playing`;
    - the ORDER case, `requested "own" with a round in check-in is none, not checkin`.
  - **Clock:**
    - `no checking_in board: closed`;
    - `one open window: closes at its deadline`;
    - `two open windows: the EARLIER deadline`;
    - `nothing open, a later group ahead: opens at the earliest opensAt`;
    - `at exactly deadlineAt the window is closed`;
    - `at exactly opensAt it is open`. For this and the previous case, the expected value comes from `inExtendWindow`'s own declaration, the half-open window `[opensAt, deadlineAt)`.
    - `a checking_in board with checkin null is ignored` (the guard, reached).
  - **Open-window set:**
    - `a not-yet-open board of a later group is in neither the tally nor the waiting set` (A6);
    - `a board past its deadline but still checking_in is in neither`.
  - **Tally:**
    - `empty: all zero`;
    - `seats are two per open-window board`;
    - `here counts seats.white.here and seats.black.here`;
    - `seats null on an open-window board counts as not here` (guard);
    - `playing = starting + live; a held board is not playing`. This is the differential case: one `on_hold` board beside one `live` board gives `playing` 1, never 2.
    - `finished = result boards`.
  - **Playing tally:**
    - `empty boards: { playing: 0, total: 0, finished: 0 }`;
    - `total is the boards on screen`.
  - **Attention count** (C6):
    - `empty: 0`;
    - `a held board with an open flag counts once`;
    - `a seated held row is not counted`;
    - `a cancelled flagged board counts`.
  - **Review target:**
    - `fixture in round.boards: select`;
    - `not in the round: link`;
    - `seated: none`;
    - `cancelled: none`;
    - `round null: link`.
  - **Entry status and line** (C7):
    - `nothing: default`;
    - `attention 2 and a round ready: the line is attention, and the status still says ready` (the two facts stay separate);
    - `a round open with deadlineAt ahead: checkin`;
    - `a round paired with press "open": ready`;
    - the ORDER case, `checkin and ready both (a league pairs every round at Generate): checkin`;
    - `deadlineAt passed: not checkin`.
  - **`nextRoundViews`:**
    - `pinned round (current false): []`;
    - `excludes the round on screen`;
    - `keeps the reader's order`.
- [ ] **Step 2: Run VT.** Expected: FAIL, because the module is missing.
- [ ] **Step 3: Implement** to the signatures. A board's window is `inExtendWindow({ opensAt, deadlineAt, extensionsLeft }, nowMs)` over its `checkin`.
- [ ] **Step 4: Run VT.** Expected: PASS.
- [ ] **Step 5: Mutation check.** Apply each mutation in turn. Each must turn exactly its named test red. Restore after each one.
  - Reorder the phase ladder so `checking_in` comes first.
  - Reorder the entry line so `ready` comes before `attention`.
  - Reorder the entry line so `ready` comes before `checkin`.
  - Count `on_hold` as playing.
  - Count seated held rows in `attentionCount`.
- [ ] **Step 6: Commit** `feat(arbiter): the round column's phase, clock, counts and entry line as one pure model`.

### Task 4: Lift the Open / Resend press out of `OpenRoundControl`

There is no behaviour change. This is the seam Tasks 5 to 8 consume.

**Files:**
- Create: `apps/web/src/components/v2/desk/use-open-round.ts`
- Modify: `apps/web/src/components/v2/desk/open-round-control.tsx`. Use the hook, and `export` `openNoticeText`, `resendNoticeText`, `timedBatches`, `owedPlayers` and `inviteState`.
- Test: the existing `components/v2/desk/__tests__/open-round-control.test.tsx`, `open-round-control-actions.test.tsx`, `open-round-batches-reachability.test.tsx` and `open-round-state.test.ts` stay green with no change.

**Interfaces:**
- Produces:
  ```ts
  export type OpenRoundHandle = {
    state: OpenRoundUiState;
    ask(): void;
    cancel(): void;
    open(): void;              // openRoundRunner.open(view.stageId, view.roundNo)
    resend(fixtureId: string): void;
    /** C8: the round "+5" OpenRoundControl still shows until Task 10 deletes the control; Task 10 removes it from the handle too. */
    extend(): void;
  };
  /** A null view gives a no-op handle (initial state; every call does nothing). ArbiterPanel calls it for the round on screen (C9). */
  export function useOpenRound(view: OpenRoundView | null): OpenRoundHandle;
  ```
  The hook owns `useReducer(openRoundUi, …)`, `useRouter`, and `openRoundRunner` with an `apiV1` POST and `router.refresh`. It builds them exactly as `OpenRoundControl` does today (`open-round-control.tsx:214-226`).

- [ ] **Step 1: Record the baseline.** Run VT on the four test files, and note `total` and `passed`.
- [ ] **Step 2: Refactor.** Move the reducer, router and runner wiring into the hook. `OpenRoundControl` calls `useOpenRound(round)` and uses `handle.extend()` for its round "+5".
- [ ] **Step 3: Run VT.** Expected: the same `total` and `passed` as in Step 1.
- [ ] **Step 4: Mutation check** (a refactor has no true red). Make the hook's `open()` call `runner.open(view.stageId, view.roundNo + 1)`. A test in `open-round-control-actions.test.tsx` must fail; if none does, add `the press opens THIS round` there. Restore. This killer is kept: Task 10 retargets it and never deletes it (A13).
- [ ] **Step 5: Typecheck** (`rtk proxy npm run typecheck`), then commit `refactor(desk): the open-round press as a hook the arbiter column can share`.

### Task 5: The column, before the round opens

**Files:**
- Create: `apps/web/src/components/v2/arbiter/round-column.tsx`
- Test: `apps/web/src/components/v2/arbiter/__tests__/round-column.test.tsx`. Render statically with the real `en` dictionary, wrapped in the providers `open-round-control.test.tsx` uses. Mock `next/navigation` the way it does.
- Modify: the four `ui.json` files and `i18n-keys.ts`, with the keys `arbiter.column.label`, `arbiter.column.nothingPaired` and `arbiter.column.toFixtures`.

**Interfaces:**
- Consumes:
  - Task 3 `roundColumnPhase` and `nextRoundViews`;
  - Task 4 `useOpenRound` and `OpenRoundHandle`;
  - `OpenRoundConfirmBody` and `openNoticeText` (`open-round-control.tsx`).
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
    /** C9: the round on screen's handle, owned by ArbiterPanel and shared with WaitingList. */
    openRound: OpenRoundHandle;
    on: { select(fixtureId: string): void; extendBoard(fixtureId: string): void };
    /** C13: the panel's one RoundExtend, placed by phase (Task 8). null when the panel mounts it elsewhere. */
    roundExtend: React.ReactNode;
  };
  export function RoundColumn(p: RoundColumnProps): JSX.Element | null;
  /** C25: pure (state in, markup out): one view's heading, lede, press, confirmation and notice. */
  export function OpenRoundBlockView(p: { view: OpenRoundView; state: OpenRoundUiState; tz: string; showStage: boolean;
    on: { ask(): void; cancel(): void; open(): void } }): JSX.Element;
  ```
  - The root is `<aside aria-label={t("arbiter.column.label")} data-testid="arbiter-round-column" data-phase=…>`.
  - Each before-phase block is `data-testid="arbiter-column-open"`, with these children:
    - the CTA, `arbiter-column-open-cta`;
    - the confirmation, `arbiter-column-confirm`, holding `OpenRoundConfirmBody` with its existing testids (including `open-round-earlier`);
    - the notice, `arbiter-column-open-notice`;
    - the pairings, `arbiter-column-pairings`.
  - The start hint is `arbiter-column-start-first`, and the empty line is `arbiter-column-nothing`.
  - Each next-round block calls `useOpenRound(view)` in a thin wrapper around `OpenRoundBlockView`. Rounds that are not the one on screen have their own handles; R1 is per round.

- [ ] **Step 1: Write the failing tests:**
  - `phase none: renders nothing`. With `requested: "unavailable"`, the markup is empty.
  - `before, not started: the start line wins and the empty line is absent` (A8). The text equals `en["externalPlay.openRound.startFirst"]`, and there is no `arbiter-column-nothing`.
  - `before, started, nothing to open: the empty line and a link to the Fixtures tab`. The href equals `routes.division(org, comp, div, "fixtures")`, never the arbiter route.
  - `before, one view: heading, paired lede, Open round, pairings`. The lede's player count is derived from the FIXTURE (two seats per board in the view's `pairings`), never from `owedPlayers`.
  - `before, two stages: each block names its stage; one stage: no stage name`.
  - `confirming: OpenRoundConfirmBody with the earlier-in-play line`. Render `OpenRoundBlockView` with `state.confirming: true` and a view with `earlierInPlay`.
  - `busy: the CTA is disabled` (C25). Render `OpenRoundBlockView` with `state.busy: { kind: "open" }`; the CTA carries `disabled=""` and `aria-busy="true"`.
  - `already_open notice` (C20, C25). Render `OpenRoundBlockView` with `state.notice = { kind: "answered", result: { opened: false, reason: "already_open", … } }`. The text equals the (Task 11) `en["externalPlay.openRound.alreadyOpen"]`. Use the result shape `OpenRoundResult` declares, from `lib/open-round.ts`.
  - `every control in the column is at least 44px tall`. Each `button` and `a` carries `min-h-11`.
  - `the pairings list, if it scrolls, is reachable` (AGENTS class 23). If the list has `overflow-y-auto`, it carries `tabindex="0"`, a `role` and an `aria-label`, as `OpenRoundConfirmBody`'s list does (`open-round-control.tsx:137-142`). If it does not scroll, it has no `overflow-*` at all. Assert whichever branch the build takes, and assert that the other is absent.
- [ ] **Step 2: Run VT.** Expected: FAIL, because the component is missing.
- [ ] **Step 3: Implement** the before branch only; the other phases render `null` for now. Use one primary button per block (`#7c3aed`), with the confirmation as in `OpenRoundControl`. There is no test-only prop on production code. Add the three keys in four locales, and run `npm run i18n:gen-keys`.
- [ ] **Step 4: Run VT.** Expected: PASS.
- [ ] **Step 5: Mutation check.** Drop the `disabled` binding on the CTA. The busy test must fail. Restore.
- [ ] **Step 6: Commit** `feat(arbiter): the round column before a round opens`.

### Task 6: The column during check-in

**Files:**
- Modify: `apps/web/src/components/v2/arbiter/round-column.tsx`
- Test: `apps/web/src/components/v2/arbiter/__tests__/round-column.test.tsx`
- Modify: the four `ui.json` files and `i18n-keys.ts`, with these keys:
  - `arbiter.column.checkin.closesIn`, `.opensIn` and `.closed`;
  - `arbiter.column.checkin.tally.one/.other`;
  - `arbiter.column.alreadyPlaying.one/.other`;
  - `arbiter.column.finished.one/.other`;
  - `arbiter.column.waiting.one/.other`;
  - `arbiter.column.here` and `arbiter.column.notHereYet`;
  - `arbiter.column.batchBoards` ("Boards {from} to {to}").

**Interfaces:**
- Consumes:
  - Task 2 `board.seats`;
  - Task 3 `checkinClock`, `openWindowBoards`, `checkinTally` and `viewOfRound`;
  - Task 1 `INVITE_WORD_KEYS`;
  - `RoundColumnProps.openRound`, the round on screen's handle (C9);
  - `boardExtendOffer` (`components/v2/checkin-extend-ui.ts:82`; C14);
  - `timedBatches` and `resendNoticeText`.
- Produces:
  ```ts
  /** C9: placed by Task 8 in the board group (under the camera from md). Shares the column's handle. */
  export type WaitingListProps = {
    boards: readonly ArbiterBoard[];   // round.boards; the list filters with openWindowBoards
    view: OpenRoundView | null;        // viewOfRound(...); null => no Resend on any row (guard)
    openRound: OpenRoundHandle;
    nowMs: number | null;
    on: { select(fixtureId: string): void; extendBoard(fixtureId: string): void };
  };
  export function WaitingList(p: WaitingListProps): JSX.Element | null;
  ```
  The testids are:
  - in the hero: `arbiter-checkin-hero`, `arbiter-checkin-clock` (`data-kind`), `arbiter-checkin-tally`, `arbiter-checkin-playing`, `arbiter-checkin-finished`, `arbiter-column-reinvite` and `arbiter-column-batches`;
  - in the waiting list: `arbiter-waiting`, `arbiter-waiting-row` (`data-fixture-id`), `arbiter-seat` (`data-colour`, `data-here`), `arbiter-invite-word` (`data-word`), `arbiter-waiting-resend`, `arbiter-waiting-extend` and `arbiter-invite-help`.

- [ ] **Step 1: Write the failing tests:**
  - **The hero:**
    - `hero, empty tally: no board in an open window prints no "0 of 0"`. The tally line is absent.
    - `hero clock: closes / opens / closed, one string each`. Render at `nowMs` before, inside and after the windows; the strings come from `en`.
    - `clock edges: at deadlineAt - 1 ms "closes", at deadlineAt "closed"` (Review Focus 3).
    - `hero tally: 3 of 4 players checked in, and the progress bar says the same`. Assert `aria-valuenow="3"` and `aria-valuemax="4"`.
    - `already playing: 2 boards; a held board is not counted; the finished clause shows only above zero`.
    - `the round's +5 is the node it is given, once`. The hero renders `roundExtend` once, and the column adds no `arbiter-extend-round` element of its own.
    - `reinvite press shows only for press reinvite or reopen`. With `press: "none"`, there is no `arbiter-column-reinvite`.
    - `staggered: the groups, "Boards 1 to 8", with opens and closes`. There is no `–` in the markup.
  - **The waiting list:**
    - `waiting list: empty case first`. With every open-window seat here, there is no `arbiter-waiting` and no help line.
    - `a later group's board is not in the waiting list before its window opens` (A6).
    - `waiting seat not here: "Not here yet" and one chip per invite word`; `seat here: "Here" and no invite chip`.
    - `Resend shows only when the view says canResend`. With a seat seeded `not_delivered` and the view's `canResend: false`, there is no Resend, and the hero offers the round's reopen press instead (C4).
    - `no view for the round: no Resend on any row` (the guard).
    - `row +5 follows the live clock` (C14). With `nowMs` inside the window it shows; at `deadlineAt` it is absent. The gate is `boardExtendOffer(board.checkin, nowMs).offered`, never the snapshot's `canExtend`. Assert the button's `data-fixture-id`; the call itself is covered by Task 8's dispatch test.
    - `the help line is the list's last line and says Delivered is not read`. The text equals `en["arbiter.invite.help"]`.
- [ ] **Step 2: Run VT.** Expected: FAIL.
- [ ] **Step 3: Implement.**
  - **Countdown:** `mm:ss` from `nowMs`. Before mount (`nowMs` null), render no digits and keep the label. Set it in `CLOCK_FACE` at `text-3xl lg:text-4xl`, in Ink.
  - **Chips:**
    - violet pair for `sent` / `delivered`;
    - amber for `delayed` and for "Not here yet";
    - red for `bounced` / `not_delivered`;
    - neutral outline for `not_invited`.
  - **Copy:** add the keys in four locales, and run gen-keys.
- [ ] **Step 4: Run VT.** Expected: PASS.
- [ ] **Step 5: Mutation check.** Apply each mutation in turn, and restore after each one.
  - Remove the `canResend` condition. Its test must fail.
  - Print the tally when `seats === 0`. The empty-case test must fail.
  - Gate the row's +5 on `checkin.canExtend` instead of `boardExtendOffer`. The live-clock test must fail (C14).
- [ ] **Step 6: Commit** `feat(arbiter): check-in in the round column: the countdown, who is here, and what each invite did`.

### Task 7: The column while playing, and the queue cards

**Files:**
- Create: `apps/web/src/components/v2/arbiter/round-queue-cards.tsx`
- Modify: `apps/web/src/components/v2/arbiter/round-column.tsx`
- Test: `apps/web/src/components/v2/arbiter/__tests__/round-column.test.tsx` and `apps/web/src/components/v2/arbiter/__tests__/round-queue-cards.test.tsx`
- Modify: the four `ui.json` files and `i18n-keys.ts`, with the keys `arbiter.column.playing.one/.other`, `arbiter.column.queue.one/.other`, `arbiter.column.review` ("Review board {board}") and `arbiter.column.reviewThis` ("Review this board")

**Interfaces:**
- Consumes:
  - Task 3 `playingTally`, `nextRoundViews`, `reviewTarget` and `attentionCount`;
  - Task 5 `OpenRoundBlockView`, with one `useOpenRound` per next-round view;
  - `HELD_TITLE_KEYS` and `heldBody` (`components/v2/external-play-held-copy.ts`);
  - `arbiterDecision` / `decisionRunner` (`components/v2/arbiter-decision.ts`) for a cancelled flagged card's "Mark as reviewed", used as `external-play-needs-result-queue.tsx` uses them. This is a second reducer and runner on the page, accepted and recorded (pre-flight T7).
- Produces:
  ```ts
  export function RoundQueueCards(p: {
    round: ArbiterRound | null;
    held: readonly NeedsOrganiserExternalPlayRow[];
    flagged: readonly FlaggedBoard[];
    ownFlagged: number;                 // C11: rendered, never inert
    slugs: { org: string; comp: string; div: string };
    onSelect(fixtureId: string): void;
  }): JSX.Element | null;
  ```
  The testids are `arbiter-column-status`, `arbiter-column-next` (`data-primary`), `arbiter-column-earlier`, `arbiter-column-queue`, `arbiter-column-card` (`data-kind`, `data-fixture-id`), `arbiter-column-review`, `arbiter-column-mark-reviewed` and `arbiter-column-own-flagged`.

- [ ] **Step 1: Write the failing tests:**
  - **The queue:**
    - `queue: empty case first: no cards, no title, no "0 boards", no ownFlagged line`.
    - `held in the round on screen: "Review board 4" is a BUTTON that calls onSelect, and nothing in the column links to the panel's own URL`. Scan every `href` in the markup; none may equal `routes.divisionArbiter(org, comp, div)`, with or without the current board's `?fixture=`. This is the self-link fix.
    - `held in another round: "Review board 4" is a link to divisionArbiter(..., fixtureId)`.
    - `boardNo null: the where line is the stage name, the action reads "Review this board"`. This is the named fallback, from `en["arbiter.column.reviewThis"]`.
    - `seated held card: shown, not counted, no action`. The text equals `en["arbiter.notice.settleOwnBoard"]`, there is no `arbiter-column-review`, and the title's count excludes the card (C6).
    - `a held board that is also flagged: two cards, counted once`.
    - `cancelled flagged card: Mark as reviewed, no Review`.
    - `ownFlagged line: absent at 0; at 2 the plural of externalPlay.queue.ownFlagged` (C11).
    - `title: "2 boards need a decision", red when any counted card is held, not red when only flagged`.
    - `the queue is the aside's first child in every phase`. Inside the `aside` no CSS `order` is used (assert there is no `order-` class within it), so source order is visual order (C10).
  - **Playing:**
    - `status "14 of 20 boards playing", finished clause above zero only`;
    - `boards [] (own round): no counts at all`.
    - `the playing block hosts the round bar's node` (C13). The `roundExtend` node renders inside `arbiter-column-status`.
  - **The next round:**
    - `next round while boards play: quiet button, EVERY earlier-in-play entry inline`. A view with two `earlierInPlay` entries renders two sentences, each the plural of `runsheet.round.confirmEarlierInPlay`.
    - `every board over: the same button is primary` (`data-primary="true"`);
    - `pinned older round: no next-round press`.
- [ ] **Step 2: Run VT.** Expected: FAIL.
- [ ] **Step 3: Implement.** Add the keys in four locales, and run gen-keys.
- [ ] **Step 4: Run VT.** Expected: PASS.
- [ ] **Step 5: Mutation check.** Apply each mutation in turn, and restore after each one.
  - Make `reviewTarget` always `"link"`. The self-link test must fail.
  - Make the title use `held.length + flagged.length`. The counted-once test must fail (C6).
- [ ] **Step 6: Commit** `feat(arbiter): the round column while playing: the queue as Review board N, and the next round with its warning`.

### Task 8: Mount the column in the panel

**Files:**
- Modify: `apps/web/src/components/v2/arbiter-panel.tsx`:
  - `ArbiterScreenProps` (`:105`);
  - `ArbiterScreen` (`:217-381`; render paths `:253-266`; the top-bar `RoundExtend` at `:249-251`);
  - `ArbiterPanel` (`:940`).
- Test: `apps/web/src/components/v2/__tests__/arbiter-panel.test.tsx`
- Modify: `arbiter.empty.body` in the four `ui.json` files (spec §9: it no longer says to open a round from the run sheet).

**Interfaces:**
- Consumes: Tasks 5 to 7 `RoundColumn`, `WaitingList` and `RoundColumnData`; Task 4 `useOpenRound`; Task 3 `viewOfRound` and `roundColumnPhase`.
- Produces:
  - `ArbiterScreenProps` gains `column: RoundColumnData`, `openRound: OpenRoundHandle` and `on.extendBoard(fixtureId: string): void`.
  - `ArbiterPanel` gains a `column: RoundColumnData` prop. It calls `useOpenRound(round ? viewOfRound(column.views, round) : null)` ONCE and passes the handle to both the column and `WaitingList` (C9).
  - `on.extendBoard` is `select(fixtureId)` followed by `runner.extend(fixtureId, boardNo)`, through the existing `linkedExtendDispatch`.
- **Placement (C10)**, exactly as in spec §5.1:
  - `main`: `flex flex-col gap-3 md:grid md:grid-cols-[minmax(0,1fr)_320px] md:grid-rows-[auto_1fr] md:items-start lg:grid-cols-[248px_minmax(0,1fr)_320px] lg:grid-rows-[auto_1fr]`.
  - `nav`: `hidden lg:flex lg:col-start-1 lg:row-start-1 lg:row-span-2`.
  - Board group (picker, watch-only line, heading, camera, switch, other reports, `WaitingList`): `max-md:contents md:flex md:flex-col md:gap-3 md:col-start-1 md:row-start-1 lg:col-start-2 lg:row-span-2`.
  - Decision group (flags, decision, outage): `max-md:contents md:flex md:flex-col md:gap-3 md:col-start-1 md:row-start-2 lg:col-start-3 lg:row-start-2`.
  - The `aside`: `max-md:order-[-2] md:col-start-2 md:row-start-1 md:row-span-2 lg:col-start-3 lg:row-start-1 lg:row-span-1`.
  - `WaitingList`'s root: `max-md:order-[-1]`.
  - Paths with no grid (before, no boards): `main` is `md:grid md:grid-cols-[minmax(0,1fr)_320px]`, and the `aside` is `max-md:order-[-1] md:col-start-2`.
- **The round bar (C13).** `ArbiterScreen` mounts exactly ONE `RoundExtend` per page, chosen by path:
  - in check-in, it is passed as `roundExtend` into the hero;
  - in the playing phase (the grid path and the no-boards path), it is passed into the playing status block;
  - in the I3 `board === null` path, it stays at its current top-bar position (`:249-251`);
  - with no round, there is none.

- [ ] **Step 1: Write the failing tests** in `arbiter-panel.test.tsx`:
  - `mount paths (spec §5.2 table)`:
    - `requested` set gives no `arbiter-round-column`;
    - `round null` gives the column with `data-phase="before"` beside `EmptyNotice`;
    - `boards [] with ownBoards` gives `data-phase="playing"`;
    - `board === null` (I3) gives no column;
    - the grid gives the column.

    Report the five paths checked.
  - `one round bar per page, placed by path` (C13): count `data-testid="arbiter-extend-round"` occurrences and assert exactly 1 per case.
    - check-in: the bar is inside `arbiter-checkin-hero`;
    - playing (grid path, f1 live / f2 result / f3 live): the bar is inside `arbiter-column-status`, and its why line `data-why="game_started"` is still rendered;
    - I3 path: the bar is in the top bar, outside any `aside`;
    - round null: zero bars.
  - `placement classes (C10)`: assert every class listed in the Interfaces placement above, on its group. Anchor every hidden-class assertion on `\s…hidden"`. This class test is necessary, not sufficient; the Step 4b capture and Task 13 are the proof.
  - `the empty copy no longer sends the organiser to the run sheet`. The rendered body equals the new `en["arbiter.empty.body"]`, and that string does not contain "run sheet".
  - `extendBoard selects, then extends`. The decision reducer shows the selected board, then `busy.kind === "extend"`. Drive it through `arbiterDecision` with the actions the shell dispatches.
  - `one handle for the hero and the rows` (C9). `ArbiterScreen` receives one `openRound`, and both the column and `WaitingList` read its `state`. With a `busy: { kind: "resend", fixtureId }` state, the hero's reinvite press and every row's Resend are disabled.
- [ ] **Step 2: Migrate the existing round-bar tests (C12, as the C13 ruling amends it).** These tests must keep their strength:
  - `the check-in extension: +5 min on a board and on the round` (`:1103`, its cases at `:1143`, `:1211` and `:1255`);
  - `… on a ticking clock` (`:1293`, its cases at `:1355` and `:1379`);
  - `the round bar's reason …` (`:1429`, its cases at `:1466`, `:1481` and `:1523`, including the 48-case MIX sweep at `:1497` / `:1525`).

  The bar is preserved outside check-in (C13), so these tests keep their boards. That includes the `roundOf()` rounds with no `checking_in` board, which are now the witnesses of the playing-block bar. Change only the locator, from the top bar to the placed bar. Do NOT give them a `checking_in` board: that would stop them testing the non-check-in why lines that C13 preserves. List every changed test title in the commit body.
- [ ] **Step 3: Run VT.** Expected: FAIL on the new tests only. The migrated ones may fail on their locator until Step 4.
- [ ] **Step 4: Implement.**
  - **4a.** Thread `column` and `openRound` through, place the groups, and place the bar by path. Add `min-w-0` down every new wrapper.
  - **4b. Local proof before the commit** (C10; AGENTS class 2). Stand up a local prod server (`seazn-local-env`), seed an opened round of four boards with a throwaway script in your scratchpad, and capture the panel at 768 and 320. Then check:
    - at 768, the `aside`'s left edge is at or right of the board group's right edge, and the decision group is below the camera in the left track;
    - at 320, the `aside` is above the picker, and the waiting list sits between them;
    - `scrollWidth <= clientWidth` at both widths.

    Print the phase beside each result. Nothing from this step is committed.
- [ ] **Step 5: Run VT** on `arbiter-panel.test.tsx`, `round-column.test.tsx`, `round-queue-cards.test.tsx` and `arbiter-decision.test.ts`. Expected: PASS. `arbiter-panel.test.tsx`'s total is the old total plus the new tests, with N cases migrated (the Step 2 list) and none deleted.
- [ ] **Step 6: Commit** `feat(arbiter): the round column in the panel, a real column from md`.

### Task 9: The arbiter page: the flag and the column's data

**Files:**
- Modify: `apps/web/src/app/o/[orgSlug]/c/[compSlug]/d/[divSlug]/arbiter/page.tsx`
- Test: `apps/web/src/app/o/[orgSlug]/c/[compSlug]/d/[divSlug]/arbiter/__tests__/page.test.tsx`. It mocks `@/server/usecases/external-play`: extend the mock with `onlineChessOffered`, `listOpenRounds`, `listNeedsOrganiserExternalPlay` and `listFlaggedExternalPlay`, and mock `getScheduleSettings`.

**Interfaces:**
- Consumes:
  - `onlineChessOffered` (`server/usecases/external-play/online-chess-flag.ts:42`);
  - `listOpenRounds(auth, divisionId)`, `listNeedsOrganiserExternalPlay` and `listFlaggedExternalPlay`;
  - `getScheduleSettings(auth, divisionId)`, for its `.tz`;
  - `divisionScoringClosed`, as the division page imports it (`page.tsx:40`).
- Produces: `<ArbiterPanel … column={{ views, held, flagged: flagged.boards, ownFlagged: flagged.ownBoards, tz, awaitsStart }} />`.

- [ ] **Step 1: Write the failing tests:**
  - `flag off: 404, and no reader is asked`. `notFound` is called, and `loadArbiterRound` and `listOpenRounds` are never called.
  - `flag on: the column gets the four reads and the venue zone` (exact props).
  - `not chess: 404 and the flag is never asked` (the other-sport witness).
  - `online play off: 404 and the flag is never asked` (cheap checks first).
  - `requested "unavailable": the column's reads still run, and the panel decides`. This pins that the page does not special-case it.
- [ ] **Step 2: Run VT.** Expected: FAIL.
- [ ] **Step 3: Implement.** The order is: `canEdit`, the sport, online play, then `await onlineChessOffered(page.auth)`, then the reads in one `Promise.all`.
- [ ] **Step 4: Run VT.** Expected: PASS.
- [ ] **Step 5: Mutation check.** Delete the flag check. `flag off: 404` must fail. Restore.
- [ ] **Step 6: Commit** `feat(arbiter): the panel follows the online-chess flag and loads its round column`.

### Task 10: The Fixtures tab after the move

**Files:**
- Modify: `apps/web/src/app/o/[orgSlug]/c/[compSlug]/d/[divSlug]/page.tsx`: the reads at `:540-581`, `editable` at `:296`, and the entry card, queue mount and `StagesPanel` props at `:825-881`.
- Modify: `apps/web/src/components/v2/stages-panel.tsx` (C16):
  - delete the `openRounds` prop, the `OpenRoundControl` import (`:105`) and its mount (`:1351`);
  - keep the `onlineAwaitsStart` hint (`:1356`) exactly as it is;
  - make `arbiterHrefFor` optional and pass it only when `arbiterOffered` (`:1540`).
- Modify: `apps/web/src/components/v2/desk/run-sheet-row.tsx:721-722`. The comment "the round is opened from its stage card above" now names the Arbiter Panel.
- Modify: `apps/web/src/components/v2/external-play-needs-result-queue.tsx`. Delete the `externalPlay.queue.review` link.
- Delete from `apps/web/src/components/v2/desk/open-round-control.tsx`: `OpenRoundControl` and its round "+5". Keep `OpenRoundConfirmBody` and the exported helpers.
- Modify: `apps/web/src/components/v2/desk/use-open-round.ts`. Remove `extend()` from the handle (C8).
- Modify: `apps/web/src/components/v2/desk/open-round-state.ts`. Delete the reducer's `extend` / `extendDone` branches, the `extendNotice` field and the runner's `extend`, which are dead now (C26). List each deleted `open-round-state.test.ts` case title in the commit body.
- Modify: the four `ui.json` files and `i18n-keys.ts`, with the keys `arbiter.entry.status.ready` and `arbiter.entry.status.checkin`.
- Test:
  - `apps/web/src/app/o/[orgSlug]/c/[compSlug]/d/[divSlug]/__tests__/online-chess-flag-wiring.test.tsx`;
  - `…/__tests__/online-start-hint-wiring.test.tsx`;
  - `…/__tests__/arbiter-entry-link.test.tsx`;
  - `apps/web/src/components/v2/__tests__/external-play-needs-result-queue.test.tsx`;
  - `apps/web/src/components/v2/__tests__/stages-panel-open-round.test.tsx`;
  - `apps/web/src/components/v2/__tests__/stages-panel-start-hint.test.tsx`;
  - the `open-round-control*` tests, retargeted (below).

**Interfaces:**
- Consumes: Task 3 `entryStatus`, `entryLine` and `attentionCount`. The `attention` producer is `attentionCount(needsOrganiserExternalPlay, flaggedExternalPlay.boards)`, the same function as the column's title (C6).
- Produces (C18):
  - `arbiterOffered = canEdit && boardgame && onlinePlay === "lichess" && fixtures.length > 0 && await onlineChessOffered(auth)`, asked once per render and only on the Fixtures tab. It decides the entry card and `arbiterHrefFor`.
  - `editable` decides the controls and the queue, as today.
  - The entry card is `data-testid="arbiter-entry"`, with `arbiter-entry-status` (`data-kind` = `entryLine(...).kind`).

- [ ] **Step 1: Rewrite the inverted cases (C17)** to the new rule at equal strength, and keep every "another sport" cell. The cases are:
  - `online-chess-flag-wiring.test.tsx:224` and `:250` ("the rounds to open reach the stage cards …", "hands the stage cards an EMPTY map"). They become: offered means `StagesPanel` gets no `openRounds` prop at all, and the entry card gets the status.
  - `online-chess-flag-wiring.test.tsx:257` (the queue mounts on an empty chess tab). It becomes: offered means no queue; not offered means the queue, as before.
  - `online-start-hint-wiring.test.tsx:178` and `:192` ("the rounds arrive"). These become: the hint still arrives; no rounds are passed.
  - `arbiter-entry-link.test.tsx:160-213`. The entry is now also gated on the flag and decided by `canEdit`, and its "another sport" cell stays.
  - `stages-panel-start-hint.test.tsx:49` and `:61`, and `stages-panel-open-round.test.tsx`. They become: no `openRounds` prop exists, the hint renders, and with `arbiterHrefFor` absent the run-sheet chips render as spans.
- [ ] **Step 2: Write the new failing tests:**
  - `offered: no Open round on any stage card, no queue, one entry card`.
  - `offered: the entry line follows the ladder`. Attention beats ready, and checkin beats ready; the texts come from `en` through `plural()`.
  - `not offered: the queue stays, with no panel link`. In every case, `external-play-review` is absent from the queue markup, and the queue still gets both lists. This updates the T16 case "online play off now: the queue gets both lists".
  - `flag off on a division playing online: no entry card, chip links are spans, the queue stays` (Review Focus 2).
  - `billing-frozen organiser (canEdit, not editable): the entry card and the chip links stay; no queue controls` (C18).
  - `the start hint stays on the stage card when the division has not started` (`online-start-hint`).
  - `the empty case: a chess Fixtures tab with nothing held, nothing to open and the panel offered: the entry card with the default body`.
- [ ] **Step 3: Retarget the deleted control's tests** (A13, C26):
  - the "the press opens THIS round" killer (Task 4) moves to the column's press, either in `round-column.test.tsx` or as a `useOpenRound` reducer-and-runner case. It is never deleted;
  - the cases that reach `timedBatches`' named refusal (`open-round-control.tsx:97-100`, "reached by open-round-control.test.tsx") call the exported `timedBatches` directly;
  - list every deleted test title in the commit body.
- [ ] **Step 4: Run VT.** Expected: FAIL on the new and rewritten cases.
- [ ] **Step 5: Implement.** Move the `arbiterHref` computation inside the `onlineDesk` branch, and reuse the one `onlineChessOffered` answer. Then check the deletion with `grep -a -rn "OpenRoundControl" apps/web/src`. It must return nothing but comments that name the history, or nothing at all. Add the keys in four locales, and run gen-keys.
- [ ] **Step 6: Run VT** on every test file listed under **Test** above, plus `components/v2/desk/__tests__/run-sheet-row.test.tsx`, `open-round-state.test.ts`, `open-round-batches-reachability.test.tsx` and `round-column.test.tsx`. Expected: PASS.
- [ ] **Step 7: Mutation checks.** Apply each mutation in turn, and restore after each one.
  - (a) Pass `openRounds` regardless of `arbiterOffered`. This needs a temporary prop: re-add it in the backup copy only, never in a commit. The "offered" test must fail.
  - (b) Decide the entry with `editable` instead of `canEdit`. The billing-frozen test must fail (C18).
- [ ] **Step 8: Typecheck** (`rtk proxy npm run typecheck`), then commit `feat(desk): the Fixtures tab hands the round to the Arbiter Panel and keeps the queue when the panel is not offered`.

### Task 11: The column's copy, swept

**Files:**
- Modify: `apps/web/src/lib/round-column.ts`. Add `ROUND_COLUMN_KEYS` and `ROUND_COLUMN_HELPER_KEYS`.
- Create: `apps/web/src/components/v2/arbiter/__tests__/round-column-copy.test.ts`.
- Modify: the four `ui.json` files. Reword these keys with no em dash and the same meaning:
  - `runsheet.round.paired` (for example, "Paired, not opened. Nobody has been invited yet.");
  - `runsheet.round.openUntil`;
  - `runsheet.round.err.notOnline`;
  - `externalPlay.openRound.alreadyOpen`;
  - `externalPlay.held.clockFlagUnsettled` (for example, "Time's up: confirm the result");
  - `externalPlay.queue.reviewedNew.one/.other`.

  `externalPlay.queue.title` is not rendered by the column and is left alone.

**Interfaces:**
- Produces (C19):
  ```ts
  /** Every key round-column.tsx and round-queue-cards.tsx pass as a LITERAL (plural keys by their stem). */
  export const ROUND_COLUMN_KEYS: readonly DictionaryKey[];
  /** Keys the column renders through helpers it does not own: openNoticeText (OPEN_ROUND_ALREADY_OPEN_KEY …),
   *  resendNoticeText, OpenRoundConfirmBody, RoundExtend. */
  export const ROUND_COLUMN_HELPER_KEYS: readonly DictionaryKey[];
  ```

- [ ] **Step 1: Write the failing tests:**
  - `every column key exists in all four locales`. It covers `ROUND_COLUMN_KEYS`, `ROUND_COLUMN_HELPER_KEYS`, and the values of `INVITE_WORD_KEYS` and `HELD_TITLE_KEYS`. Plural stems must resolve both `.one` and `.other`. Report the count; zero is a failure.
  - `no em dash and no arrow in any locale` (`/[—→←↗]/`) over the same set. Report keys times locales checked.
  - `the literals are in the list` (one way, C19). Read the two component files as text, collect every literal passed to `msg(`, `plural(`, `t(` and `f.t(`, and assert that each is in `ROUND_COLUMN_KEYS`. Report the count. Mutation proof: add a literal key to the component in a scratch copy, and the test must fail.
  - `every key map the column reads is covered`. The values of `INVITE_WORD_KEYS` and `HELD_TITLE_KEYS` are a subset of the swept set.
  - `no invite word, in any locale, reads as opened` (A3; the only copy of this test). Check `en` with `/open/i`, `es` with `/abiert/i`, `fr` with `/ouvert/i` and `nl` with `/geopend/i`, over the values of `INVITE_WORD_KEYS` and `arbiter.invite.help`. Report 4 locales × keys checked.
- [ ] **Step 2: Run VT.** Expected: FAIL on the em dashes.
- [ ] **Step 3: Reword** the keys in four locales. Run `npm run i18n:gen-keys` and `npm run i18n:check`, and read the raw output.
- [ ] **Step 4: Run VT** on the copy test, plus every test file that asserts one of the reworded strings. Find them with `grep -a -rlnE "runsheet\.round\.paired|runsheet\.round\.openUntil|alreadyOpen|clockFlagUnsettled|reviewedNew|err\.notOnline" apps/web/src apps/web/e2e scripts`. Tests that read the dictionary follow the change on their own; a hard-coded English copy is changed to read the dictionary.
- [ ] **Step 5: Commit** `fix(i18n): the round column's copy has no em dash or arrow in any locale`.

### Task 12: E2E: a seeding helper, and the specs migrated off the Fixtures tab

E2E runs in CI only (Task 17). Each spec edit here is checked by `npx playwright test --list <spec>`, which collects the tests and does not run them, and by the typecheck.

**Files:**
- Modify: `apps/web/e2e/match-room-kit.ts`. Add:
  ```ts
  /** Spec §6: put a seat's newest outbox row in `status` (honouring V470's CHECKs: no body outside queued or sending, a lease
   *  only while sending, a unique provider id once the provider took it), and stamp the seat bound to its round's open when
   *  the status holds the seat, or clear the stamp when it does not. The holding list is composed HERE from the pure
   *  constants.ts as [...LIVE_STATUSES, "complained"] (C3; Task 1 pins it equal to the hook's SEAT_HOLDING_STATUSES) - never
   *  imported from invite-outbox-hook.ts, which is server-only. */
  export async function seedSeatInvite(fixtureId: string, colour: "white" | "black", status: OutboxStatus): Promise<void>;
  ```
- Modify: `apps/web/e2e/online-chess-desk.spec.ts`:
  - `Open round (D12)` (`:282`) and `Open round, staggered (I-1)` (`:446`) drive the column at `r.arbiterPath`;
  - `the queue` (`:532`) settles from the panel through "Review board N", and lets a flagged board go on there;
  - `Unpair while a game is on file` (`:659`) is unchanged and is re-run.
- Modify: `apps/web/e2e/checkin-extend.spec.ts`:
  - `the round: +5 min on the Fixtures tab …` (`:217`) becomes the panel's hero only. The "Fixtures tab does the same" half is replaced by an assertion that the Fixtures tab has no `open-round-extend`. The `roundNoneOpen` why line is asserted on the panel's playing-block bar (C13).
  - `the bar at 320, 768 and 1280` (`:279`) measures the hero's bar.
  - `the window's edges, live` (`:352`) reads `arbiter-checkin-clock` flipping `data-kind`, and the row's +5 leaving at the deadline, with no reload.
- Modify: `apps/web/e2e/online-chess-division-page.spec.ts:49,64`. Before Start there is no `open-round` (unchanged). After Start there is no `open-round` on the tab, and an `arbiter-entry` reads `fill(uiEn["arbiter.entry.status.ready"], { round: 1 })`.
- Modify: `apps/web/e2e/arbiter-panel.spec.ts`:
  - `desktop: from the run sheet to two boards` (`:252`) enters through `arbiter-entry`;
  - in `I-3` (`:505`), the queue half asserts that the column card's Review opens the decision area, where the same No-result rule shows.
- Modify: `apps/web/e2e/walkthrough/chess-external-play.spec.ts`:
  - `:501`, `:854` and `:963` open their rounds from the column;
  - `:182` (the queue on an over-the-board division) also asserts there is no `external-play-review`;
  - re-read `:923`, `:1055`, `:1168` and `:1299`, and move any Open round, queue or round "+5" step to the panel.

- [ ] **Step 1:** Write `seedSeatInvite`. In each spec, replace the Fixtures-tab locators with the column's testids from Tasks 5 to 7. Keep every assertion's strength. A migrated assertion that cannot hold on the new surface is a finding for the commit body, not a deletion.
- [ ] **Step 2:** Run `cd <worktree>/apps/web && npx playwright test --list e2e/online-chess-desk.spec.ts e2e/checkin-extend.spec.ts e2e/online-chess-division-page.spec.ts e2e/arbiter-panel.spec.ts e2e/walkthrough/chess-external-play.spec.ts`. Expected: every test is listed, with no collection error.
- [ ] **Step 3:** Sweep by behaviour, not by filename (C21). Run `grep -a -rnE "open-round|external-play-needs-result-queue|external-play-review|tab=fixtures|fixturesTab" apps/web/e2e`. Every hit must be either migrated or a deliberate "is absent" assertion; navigation to the tab for other reasons stays. Record the count before and after in the commit body.
- [ ] **Step 4: Typecheck** (`rtk proxy npm run typecheck`, which covers `e2e/` through `apps/web`'s tsconfig; re-pin that it does). Then commit `test(e2e): drive Open round, the invites and the queue from the Arbiter Panel`.

### Task 13: E2E: the column at 1280 and across the seven widths

**Files:**
- Modify: `apps/web/e2e/arbiter-panel.spec.ts` (the `parallel` project: Desktop Chrome 1280, the `AUTH_STATE` organiser)
- Modify: `apps/web/e2e/mobile.spec.ts`. This file is serial (`:55`), runs in the projects `mobile-320`, `mobile-360`, `mobile-se` (375), `mobile-14` (390), `mobile-430`, `tablet-768` and `tablet-834` with `AUTH_STATE`, and already imports `seedOnlineRound` (`:31`).

- [ ] **Step 1: New tests in `arbiter-panel.spec.ts`** (C4, C20, C27):
  - `round column: before, open from the column, then check-in with each invite's word`. Seed with `seedOnlineRound(…, { open: false })`.
    - The panel shows `data-phase="before"`.
    - **Double click (C20a).** Double-click the confirmation's button, and count the POSTs to `/open-round` with `page.on("request")`: exactly one. Then count the round's outbox rows by SQL: exactly 2 × boards.
    - The column shows `data-phase="checkin"`.
    - **The CI default (C4).** CI has no API key, so every seat reads `data-word="not_delivered"`. No row offers Resend, and the hero offers the round's reopen press (`arbiter-column-reinvite`, with the `runsheet.round.confirmTitleReopen` title in its confirmation).
    - **Seeded words.** `seedSeatInvite` sets `delivered`, `sent`, `delayed` and `bounced` on four seats. After a reload, each `arbiter-invite-word` reads its word from `uiEn`. Resend shows on the rows of the seats seeded as holding (`sent`, `delivered`, `delayed`) and not on the `bounced` one.
    - **No "opened" (C27b).** The scan is scoped to the invite chips and `arbiter-invite-help`; there, no text matches `/open/i`.
  - `round column: "already open" from a stale page` (C20b). Load the panel in the before phase. Open the round by API, and seed every seat as holding (`sent`) with `seedSeatInvite`. Then press Open on the stale page and confirm. The notice reads `uiEn["externalPlay.openRound.alreadyOpen"]` (the Task 11 wording), and the outbox row count is unchanged.
  - `round column: a held board is "Review board N" and selects in place`. Hold a board by SQL, as `online-chess-desk.spec.ts:532` does, then click Review. The URL path is unchanged, `aria-pressed` moves to that board, and the settle fieldset is that board's.
  - `round column: Open round 2 stays offered while round 1 plays, with the warning`. Seed a league, which pairs every round at Generate. Make round 1 live with `roundGameSql`. `arbiter-column-earlier` reads `fill(uiEn["runsheet.round.confirmEarlierInPlay.one" | ".other"], …)`. The press opens round 2, and the confirmation names the earlier games.
  - `Fixtures tab: no Open round, no queue, one entry line`. Assert each absence with its positive pair: the entry card is visible and reads its ladder line.
- [ ] **Step 2: New test in `mobile.spec.ts`**, appended LAST in the file (C27e), in the shape of the match-room test at `:5258`. Its title: `arbiter round column: below md the column leads the page; from md it is the right-hand column; no horizontal scroll; 44px targets`.
  - **Seed:** an opened round with two boards.
  - **Below 768:**
    - the `aside`'s top is above the picker's top;
    - `arbiter-waiting` sits between the `aside` and the picker.
  - **At 768 and above:**
    - the `aside`'s left edge is at or right of the board group's right edge;
    - the decision group is below the camera.
  - **At every width:**
    - `document.documentElement.scrollWidth <= clientWidth`;
    - every `button` and `a` inside `arbiter-round-column` AND inside `arbiter-waiting` is at least 44px, and is hit-tested with `elementFromPoint` (C27d).
  - **Anti-vacuity:** count the relations, and assert the expected count per branch. Print the column's `data-phase` beside each gate result (desk `_RULES.md`).
  - **The control-set diff** is taken from `main`, not from the `aside` (C27c). Diff the visible control set of `main` at the project's width against the 1280 set from the same seed: below `lg` the picker is in the set and the board list is not, and the column's controls are present at both widths.
- [ ] **Step 3:** Run `npx playwright test --list e2e/arbiter-panel.spec.ts e2e/mobile.spec.ts`. Expected: the new tests are listed, `mobile.spec.ts` once per width project. Note in the PR body that `mobile.spec.ts` is serial, so its CI count is a floor (AGENTS class 21).
- [ ] **Step 4:** Commit `test(e2e): the round column at 1280 and at every phone and tablet width`.

### Task 14: Walkthrough: a whole round run from the column

**Files:**
- Modify: `apps/web/e2e/walkthrough/chess-external-play.spec.ts` (the `walkthrough` project)

- [ ] **Step 1: Add the test** `walkthrough: one round from the Arbiter Panel's column` (C22, C28). Assert every line through `fill(uiEn[...], …)` and never as English text.

  **Seed.** `seedOnlineRound(request, names, { open: false, stage: "league", playable: true })`. A league pairs every round at Generate, so round 2 is paired before round 1 ends. Use four boards.

  **Steps.** After each one, assert the column's `data-phase` and the line that step changed.
  1. Open the round from the column. Read the countdown, and the tally `fill(uiEn["arbiter.column.checkin.tally.other"], { count: 0, total: 8 })`.
  2. Give board 1 "+5 min" from its row. Its decision area shows the new closing time.
  3. Check in both players of boards 1, 3 and 4 through their rooms, with the existing room helpers. The tally reaches 6 of 8. Play a move on boards 3 and 4 with `roundGameSql`, so that only board 2 is still in check-in. "{count} boards already playing" then reads 2.
  4. Let board 2's check-in run out. Move the round's open stamp back by SQL. This expires only boards still without a game, and only board 2 is one by now (C22). Then fire the no-show sweep with this file's own `sweep(page)` helper (`:277`, `POST /api/cron/external-play`).
  5. The queue reads `fill(uiEn["arbiter.column.queue.one"], { count: 1 })`. Press "Review board 2" and settle the board from the decision area.
  6. Finish boards 1, 3 and 4 by SQL. "Open round 2" becomes primary (`data-primary="true"`). Open round 2.

  **Budget.** Compute it from its own costs: `Math.max(FLOOR, base + steps * slack)` (AGENTS class 20).
- [ ] **Step 2:** Run `npx playwright test --list e2e/walkthrough/chess-external-play.spec.ts`. The walkthrough shard is cut BY FILE and runs near its cap (`e2e.yml` header, pre-flight A38). Note the shard's expected time in the PR body.
- [ ] **Step 3:** Commit `test(walkthrough): an online chess round run end to end from the Arbiter Panel`.

### Task 15: Smoke: an online division, and the page-level checks

This task follows the controller's ruling on C23: build the online-division entry, and do not cut the check.

**Files:**
- Modify: `scripts/smoke.ts`, in `onlineChessDeskSuite` (`:22696`; its subset selector is `onlineChessDesk`, `:23080`).
- Facts, pinned:
  - A division can be CREATED playing online: `POST /api/v1/competitions/{id}/divisions` with `config.onlinePlay: "lichess"` asks only `assertOnlineChessOffered` (`apps/web/src/server/usecases/divisions.ts:261`).
  - The CI smoke job `smoke-e2e` sets `ONLINE_CHESS_ALWAYS: "1"` (`.github/workflows/ci.yml:1739`).
  - Neither the entry card nor the column needs Lichess-linked players: both need only fixtures and the predicates in spec §7 and §8.

- [ ] **Step 1: Build the online division.** In `onlineChessDeskSuite`, create a boardgame division with `config: { variant: "classical", clock: { base: 600, increment: 5 }, onlinePlay: "lichess" }`, two individual entrants and a league stage, then generate its fixtures with the suite's existing calls. Check that the division's `config.onlinePlay === "lichess"` and that it has at least one fixture. If the create is refused, the check FAILS with the server's code; it is never skipped.
- [ ] **Step 2: Add the page checks** on that division. Anchor every HTML probe on `="`.
  - The organiser's GET of the arbiter page returns 200, and its HTML contains `data-testid="arbiter-round-column"` and `data-phase="before"`.
  - The organiser's GET of its Fixtures tab contains `data-testid="arbiter-entry"` and does not contain `data-testid="open-round"`.
  - A signed-in stranger's GET of the arbiter page is a 404.

  Count the checks and assert the count (anti-vacuity), as the suite's "nine calls" check does (`:22783`).
- [ ] **Step 3: Typecheck** with `cd <worktree> && rtk proxy npm run typecheck:scripts` (C29). Running smoke locally is optional. If you do, use `SMOKE_ONLY=onlineChessDesk` (C29: a bad selector exits 1) against a local prod server from the `seazn-local-env` skill. CI's PR smoke is the arbiter.
- [ ] **Step 4:** Commit `test(smoke): an online chess division: the arbiter page carries the round column and the Fixtures tab no longer opens rounds`.

### Task 16: Screenshot sign-off at 1280, 768 and 320

**Files:** none are committed. Evidence goes in the gitignored `.superpowers/` directory, never in the repo.

- [ ] **Step 1:** Stand up a local prod server with the `seazn-local-env` skill. Seed it with the e2e kit through a throwaway script in the scratchpad, using `seedOnlineRound` and `seedSeatInvite`.
- [ ] **Step 2:** Capture each state at 1280, 768 and 320, cropped to the column and the waiting list (full-page shots hide defects). The states are:
  - before;
  - check-in, with the four words and one "Here";
  - check-in, with a staggered round's groups;
  - playing, with one held and one flagged card, the round bar's why line, and "Open round 2" with its warning;
  - the Fixtures tab's entry card, in its four line states.

  Assert `scrollWidth <= clientWidth`, and print the phase beside each capture.
- [ ] **Step 3:** Confirm that the images exist and DIFFER between states (AGENTS class 10). Write a per-screen PASS/FAIL table recording what was asserted, what was seen, the width and the phase. Each of the owner's seven fixes is a row.
- [ ] **Step 4:** Diff the control set of `main` from the live DOM, at 320 against 1280: membership, order and repeats.
- [ ] **Step 5:** Hand the table to the controller for the owner's per-screen verdicts (AGENTS class 11). Nothing is committed in this task.

### Task 17: Push, PR, CI, hand back

- [ ] **Step 1: Run the scoped gate once**, over everything the branch touched, and paste the raw counts:
  - VT on every test file named in Tasks 1 to 11, with one fresh report file;
  - `cd apps/web && rtk proxy npm run typecheck`;
  - `rtk proxy npm run typecheck:scripts`;
  - eslint on the touched directories;
  - `npm run i18n:check`.
- [ ] **Step 2: Push the branch and open a draft PR.** Smoke runs on PRs only. The PR body must state:
  - the e2e specs this changes;
  - that ruling 1 (option C) and ruling 2 ("Not invited") were applied by the controller under the owner's standing rule, and that the owner may override either;
  - the ops precondition: Resend's webhook must be subscribed to `email.delivered`, `email.delivery_delayed`, `email.bounced` and `email.complained` on staging and production, or the words stop at "Sent" (spec §6.3);
  - the walkthrough shard time (A38);
  - the panel poll's unmeasured connection cost (A22).
- [ ] **Step 3: Dispatch e2e** with `gh workflow run e2e.yml --ref feat/arbiter-round-column`. This covers the parallel, serial and walkthrough legs and all seven width projects.
- [ ] **Step 4: Hand back at once**, with the PR URL, the head SHA, the local counts and the list of what is owed to CI (the e2e run id, smoke). Do NOT poll CI.
