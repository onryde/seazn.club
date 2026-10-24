# Arbiter Panel round column (Variant C): design

**Status:** design for owner review, 2026-10-24. Planning only; no product code has been written.
**Plan:** `docs/superpowers/plans/2026-10-24-arbiter-round-column.md`.
**Programme:** online chess, phase 2 of the arbiter work. This is the second of the three steps in the email outbox
design (`docs/superpowers/specs/2026-10-19-email-outbox-design.md`, "The order", item 2), which shipped as #1008.
**Read with:** `AGENTS.md`, `docs/superpowers/RULES.md`, `docs/superpowers/TEST-STRATEGY.md`, and the competition desk
`_INDEX.md` and `_RULES.md` (`docs/superpowers/specs/2026-09-02-competition-desk-prompts/`).

---

## 1. What the owner ruled (fixed inputs, not proposals)

1. **Open round moves off the division Fixtures tab** (owner: "looks messy") **into the Arbiter Panel**, as a side
   column about the round in view and nothing else.
2. The column carries the players' **email invites** (send, resend, status), **"+5 min to the round"**, and the
   **Held / Flagged queue**.
3. **Variant C, the phase-adaptive column**, chosen from the three-variant spike (branch `spike/arbiter-round-column`,
   worktree `.claude/worktrees/arbiter-round-spike`, `?spike=c`, commit `f4021ee4e4`). The spike is throwaway. Its
   mock is **layout only**; the build uses the house theme.
4. C is approved with seven fixes:
   1. a Held card's action reads **"Review board N"**;
   2. copy in the shape **"5 boards already playing"**;
   3. the column appears from the **`md`** breakpoint;
   4. **no arrows and no em dashes** in the copy, and **the self-link is fixed**;
   5. **"Open round 2" stays available** while earlier boards play, **with the server's warning**;
   6. invite status words come from the email outbox: **Sent / Delivered / Delayed / Bounced / Not delivered**, and
      **never "opened"**;
   7. **the Arbiter Panel follows the online-chess flag**.
5. The full UI bar applies (this is not `/admin`): 1280, 768 and 320 with no horizontal page scroll, plus the
   seven-width e2e matrix. The arbiter is mostly on a desktop or tablet; the phone still has to work.

## 2. Premises checked against the tree (2026-10-24, base `f94d9bd7c`)

| Premise in the brief | Verdict | Evidence |
|---|---|---|
| `latestEmailStatus(orgId, refType, refIds)` exists, privileged, org-filtered | **True** | `server/email-outbox/status.ts:39`; `distinct on (ref_id, lower(recipient))`, never `replaced`, newest by `created_at, id`; `at` is `status_at`; `[]` issues no statement |
| ref type `fixture_seat`, ref id `<fixtureId>:<colour>` | **True** | `seat-stamp.ts`: `CHESS_SEAT_REF_TYPE`, `chessSeatRef` |
| The desk carries invited / retrying counts | **Partly true** | They exist only as the RESPONSE to a press (`open-round-state.ts`, `ResendNotice {emailed, retrying}`). Nothing persistent says, per seat, what happened to the mail. The column needs a new per-seat read (§6). |
| The Arbiter Panel follows the online-chess flag | **False today** | `arbiter/page.tsx` checks `canEdit`, `boardgame` and `onlinePlay === "lichess"` only. The Fixtures-tab entry link (`arbiterHref`, division `page.tsx:574`) and every run-sheet chip link (`stages-panel.tsx:1540`, `arbiterHrefFor`, unconditional) ignore the flag too. Fix 7 is new work. |
| The queue belongs to online play | **False** | The queue mounts on ANY chess Fixtures tab (`onlineDesk`, `page.tsx:544`), online play on or off, flag on or off, by design: "Every control these feed FINISHES or reviews play, so none is gated by the online-chess flag (T20)". Moving it wholesale into a flag-gated panel would strand a held board. §8 keeps a fallback. |
| The spike's C screenshots | **Only one exists** | `c-checkin-used-1280.png` (check-in at 1280) in the spike session's scratchpad. No C capture at 768 or 320, and none of C's before or playing phases. The wireframes in §5 are drawn from the spike's code, not from pictures. |
| The spike's check-in hero is complete | **False** | It drops the round's own **reinvite / reopen** press (`press: "reinvite" | "reopen"`), which the Fixtures-tab control offers today. Removing the tab's control without it would lose the only way to invite late seats round-wide. §5.3 restores it. |
| The run sheet's "Review in arbiter panel" link is harmless | **False twice** | Inside the panel it links to the page you are on (fix 4's self-link). On a chess division with online play off, the panel 404s, so the same link on the Fixtures-tab queue points at a 404 today. |

**Questions only the owner can answer** (the plan builds the recommendation; each alternative is a one-step change):

- **OPEN-1** (§8): what the Fixtures tab says about the round once Open round has moved. The recommendation is C,
  one status line on the existing Arbiter Panel entry card.
- **OPEN-2** (§6.1): a seat with no mail at all. The recommendation is to show "Not invited", the run sheet's
  existing word, as a sixth label beside the five outbox words.

## 3. Who uses this and what the column is for

The arbiter is an organiser running an online chess round from a laptop or a tablet beside the board list and the
camera pane. During the ten minutes of check-in (`DEADLINE_AFTER_MS`, `server/external-play/window.ts:7`) they need
three answers at a glance: **how long is left, who is missing, and did the missing player's invite arrive**. After
check-in they need one: **which board needs me**. Before the round opens they need one press.

So the column is a **phase-adaptive answer to "what does this round want from me now"**, not a second board list.

## 4. Visual system (house theme, decided once)

The spike's colours and fonts are not used. Everything here already exists in `arbiter-panel.tsx`,
`arbiter-flag-cards.tsx` and `open-round-control.tsx`.

| Token | Hex | Role in the column |
|---|---|---|
| Ink | `#2e1065` | headings, names, the countdown |
| Soft | `#4a3a6b` | body copy |
| Muted | `#6b5b8a` | secondary lines (tally, batch times) |
| Line | `#e7e3f3` | card borders, dividers |
| Accent / deep accent | `#7c3aed` / `#5b21b6` | the one primary button per phase; "Sent" and "Delivered" chips (`#5b21b6` on `#f3effc`, border `#c9bdf0`) |
| Held (red) | `#b42318` on `#fef2f2`, border `#f1c4c0` | Held cards, "Bounced", "Not delivered" |
| Caution (amber) | `#713f12` on `#fef3c7`, border `#f5d27a` | Flagged cards, "Delayed", "Not here yet" |
| Live dot | `#4ade80` | "Here" (a dot plus the word; never colour alone) |

**Type.** The house sans for everything; `CLOCK_FACE` (`arbiter-panel.tsx:207`, Barlow, tabular numerals) for the
countdown and the tally numbers only. The countdown is the column's one large element (about 2.25rem at `lg`,
1.875rem at `md` and below). Nothing else is bold display type.

**Where the boldness goes.** One place: the check-in countdown. It is what the arbiter looks at most, and it is the
only element that changes every second. Everything around it is quiet: one primary button per phase, chips that are
words first and colour second, no icons that stand in for words, no arrows, no em dashes.

**Shapes.** Cards use the panel's existing `rounded-xl border border-[#e7e3f3] bg-white`. Chips use the panel's pill.
No new radius, no shadows, no gradients.

**Contrast.** Every chip pair above is at least 6:1 (red pair about 6.3:1, amber about 8:1, violet about 8:1). Every
status is carried by its word; the colour only repeats it.

## 5. Layout

### 5.1 Grid and order (one DOM, branched)

The panel today: one DOM; at `lg` a three-track grid `[248px_minmax(0,1fr)_320px]` (board list, the board, the
decision); below `lg` the wrappers are `display: contents` with `order-*`, and a `<select>` board picker replaces the
list. The column is added to that DOM once:

- **`lg` (1024 and up):** the right track holds the column ABOVE the decision. The board list stays left.
- **`md` to `lg` (768 to 1023):** a two-track grid `md:grid-cols-[minmax(0,1fr)_320px]`; the picker spans both tracks
  (`md:col-span-2 lg:hidden`), the board and its decision stack in the left track, the column takes the right track
  (`md:order-first` inside the right wrapper). Fix 3: the column is a real column from `md`.
- **Below `md`:** one column. Order: the check-in hero first (`max-md:order-[-2]`), the waiting list second
  (`max-md:order-[-1]`), then the picker, the board and the decision. In the before and playing phases the column's
  block sits first. Below `md`, the waiting list is part of the column's flow. From `md` it moves under the camera
  (`md:order-3` in the left track), as the spike did.

`min-w-0` runs down the whole ancestor chain of every truncating name (AGENTS.md, phone composition: a missing one cost
106px of page overflow at 320 to 390).

### 5.2 Phase, stated empty case first

`roundColumnPhase(round, requested)`, a ladder whose order is part of its meaning:

1. `requested !== null` (the page is saying "not here" or "you play on it"): **no column**. The panel's notice stands
   alone. Without this rule, a "not here" page would read as the before phase.
2. `round === null` (no round of this division has been opened): **before**.
3. Some board on screen is `checking_in`: **check-in**.
4. Otherwise: **playing**, which covers every board over too. An opened round whose every board is your own
   (`boards.length === 0`, `ownBoards > 0`) is **playing** with no counts. The empty case gets no "0 of 0" line.

A pinned older round (`round.current === false`) takes its phase from the round on screen. It never offers the next
round's press; the panel's existing N1 line already offers the newer round.

**Where the column mounts.** `ArbiterScreen` (`arbiter-panel.tsx:217`) has five render paths today. The column joins
three of them:

| Path today | Column |
|---|---|
| `requested !== null` (`RequestedNotice`) | none (rule 1) |
| `round === null` (`EmptyNotice`, `arbiter.empty.*`) | **before**: a two-track `main` from `md` (the notice left, the column right); below `md` the column comes first |
| `boards.length === 0` (own round or no boards) | **playing** with no counts: the queue and the next-round press still apply |
| `board === null` (I3: the asked-for board is not in this round) | none: the notice stands alone, as today |
| the board grid | the phase from §5.2, placed as in §5.1 |

The panel's top-bar `RoundExtend` moves into the check-in hero. A round-wide press can reach only a `checking_in` board
with its window open (`extendableBoards`), which is exactly when the phase is check-in, so no state loses the button.

### 5.3 Check-in (the phase the owner looked at)

```
1280                                                             column, 320px
+-------------+------------------------------------+-------------------------------+
| Boards      | Board 3 · Ada Lovelace v Alan Tur  | Round 2                       |
|  1 Ada v .. |  +------------------------------+  | Check-in closes in            |
|  2 ...      |  |                              |  |  07:42                        |
|  3 ...      |  |      camera / board pane     |  | 12 of 20 players checked in   |
|  ...        |  |                              |  | [====== progress ======    ]  |
|             |  +------------------------------+  | 5 boards already playing      |
|             |  Waiting on 4 boards               |  [ +5 min to the round ]      |
|             |  Board 6  Ada L.   Not here yet    |  Why only 3 boards? (helper)  |
|             |           Delivered                |  [ Invite 2 players ]  quiet  |
|             |           Bo M.    Here            |  Check-in groups (staggered)  |
|             |           [Resend invite] [+5 min] |   Boards 1 to 8  closes 19:10 |
|             |  Board 9  ...                      |   Boards 9 to 16 opens 19:10  |
|             |                                    +-------------------------------+
|             |                                    | 2 boards need a decision      |
|             |                                    |  Held  Board 4 ...            |
|             |                                    |   [Review board 4]            |
|             |                                    +-------------------------------+
|             |                                    | decision area (existing)      |
+-------------+------------------------------------+-------------------------------+
```

```
768                                            320
+---------------------------------------------+   +----------------------------+
| [ Board picker v ]  (spans both tracks)     |   | Round 2                    |
+--------------------------+------------------+   | Check-in closes in 07:42   |
| Board 3 pane             | Round 2          |   | 12 of 20 players checked in|
|                          | closes in 07:42  |   | 5 boards already playing   |
|                          | 12 of 20 ...     |   | [ +5 min to the round ]    |
| Waiting on 4 boards      | 5 boards already |   | Waiting on 4 boards        |
|  Board 6 ...             | [+5 min round]   |   |  Board 6  Ada L.           |
|  [Resend] [+5 min]       | 2 need a decision|   |   Not here yet  Delivered  |
| decision area            |  [Review board 4]|   |   [Resend invite] [+5 min] |
+--------------------------+------------------+   | [ Board picker v ]         |
                                                  | Board 3 pane, decision     |
                                                  +----------------------------+
```

**The hero** (`data-testid="arbiter-checkin-hero"`):

- **Countdown** to the NEXT board closing: the earliest `checkin.deadlineAt` over `checking_in` boards whose window is
  open now (`opensAt <= now < deadlineAt`). It ticks on the panel's existing clock (`useExtendClock`), so it moves
  without a refresh. No open window but a later group still to open: "Next check-in opens in mm:ss". No window open
  and none to come: "Check-in has closed". These are three states of one clock, each with its own string.
- **Tally**: "{n} of {total} players checked in", where `total` is two seats for each `checking_in` board whose window
  is open, and `n` is the seats among them that have checked in. Presence comes from the same rule the room uses
  (`checkInCounts`, `window.ts:95`): a check-in before the board's window opened does not count. A progress bar shows
  the same fraction (`role="progressbar"`, `aria-valuenow`, `aria-valuemax`).
- **"{count} boards already playing"** (fix 2): boards `starting` or `live`. Not held boards, which the queue lists,
  and not finished ones; "{count} boards finished" is a second clause, shown only above zero. A zero clause is never
  printed (desk `_RULES.md`: an empty cell is not information).
- **"+5 min to the round"**: the panel's existing `RoundExtend` (`arbiter-extend-round*` testids, `roundExtendRunner`,
  `liveExtendableBoards`, `roundExtendWhy`). It MOVES from the panel's top bar into the hero. It is not copied; there
  is one round extend on the page.
- **The round's own press** when `press` is `reinvite` or `reopen` (the spike dropped it, §2): the existing
  confirm, reached from a quiet secondary button with the existing copy ("Invite {count} players", "Open Round {round}
  again?").
- **Check-in groups** for a staggered round (`timedBatches`, I-1), as the Fixtures-tab control lists them today.

**The waiting list** (`data-testid="arbiter-waiting"`), under the camera from `md` and after the hero below `md`: one
row per `checking_in` board with at least one seat not here, in board order. Each seat shows its name and either
**"Here"** (live dot) or **"Not here yet"** followed by its invite chip(s) (§6). Row actions: **"Resend invite"**
when the round view says `canResend`, and the board's **"+5 min"** when `checkin.canExtend` (the panel's existing
board extend, linked to the round extend through `linkedExtendDispatch`). The board label is a button that selects
that board in place (the existing `select()`); it never navigates.

- A row's "+5 min" first brings that board on screen (`select()`) and then sends the board's existing extend
  (`decisionRunner.extend(boardId, boardNo)`). The answer appears in that board's decision area, where every board's
  +5 answer appears today. This is one press, and nothing is answered off screen.
- A row's "Resend invite" uses the round's open-round handle (the same reducer and runner the Fixtures-tab control
  uses, `openRoundUi` / `openRoundRunner`). Its answer (`rowNotice`: "{count} invites sent again.", "still sending")
  stays on that row. When `listOpenRounds` has no view for the round on screen, no row offers Resend. That is a
  guard, and a test reaches it.

### 5.4 Before the round opens

```
1280 column                         320 (top of the page)
+-------------------------------+   +----------------------------+
| Round 1                       |   | Round 1                    |
| 10 boards, 20 players. Players|   | 10 boards, 20 players. ... |
| see the scheduled time;       |   | [ Open round ]   (primary) |
| nothing is sent until you     |   | Pairings of round 1        |
| open the round.               |   |  Board 1  Ada L. v Bo M.   |
| [ Open round ]      (primary) |   |  ...                       |
| Pairings of round 1           |   +----------------------------+
|  Board 1  Ada L. v Bo M.      |
+-------------------------------+
```

- One block per stage view with `press === "open"` from `listOpenRounds`, the stage name shown only when the division
  has more than one stage. The block holds the round heading, the paired lede (`runsheet.round.pairedLede`), the
  **Open round** press with its existing confirmation (who it invites, the window, the scheduled-time note, and
  `earlierInPlay` when it applies), and a read-only list of the pairings.
- **Division not started** (`onlineAwaitsStart`): the existing "Start the division to open rounds for online play"
  line instead of a press.
- **Empty case** (no view to open, no round on screen): "No round is paired yet. Pair the next round on the Fixtures
  tab." with a link to `?tab=fixtures`. That link goes to another page, not this one.

### 5.5 Playing

```
1280 column
+-------------------------------+
| Round 2                       |
| 14 of 20 boards playing       |
| 3 boards finished             |
+-------------------------------+
| 2 boards need a decision      |   <- rises to the top of the column when present
|  Held   Round 2 · Board 4     |
|   Ada L. v Bo M.              |
|   Time's up: confirm the res. |
|   [ Review board 4 ]          |
|  Flagged  Board 7             |
|   [ Review board 7 ]          |
+-------------------------------+
| Round 3 is paired             |
| Round 2 still has 6 games in  |   <- the server's earlierInPlay warning, inline
| play.                         |
| [ Open round 3 ]   (quiet)    |   <- primary once every board is over
+-------------------------------+
```

- **Status:** "{n} of {total} boards playing" (`starting` + `live` over the boards on screen) and the finished
  clause, with no counts at all when `boards.length === 0`.
- **The next round** (fix 5): every view with `press === "open"` stays offered while boards still play. It is a quiet
  button, with the view's `earlierInPlay` sentence shown INLINE beside it (`runsheet.round.confirmEarlierInPlay`),
  not only in the confirmation. It becomes the primary button once every board on screen is over. The server's
  refusals and warnings are the same as today; nothing is blocked.

### 5.6 The queue in the column

The queue's data is the same as today: `listNeedsOrganiserExternalPlay` (held) and `listFlaggedExternalPlay` (flagged
plus `ownBoards`). The column shows it as compact cards, not as the Fixtures-tab queue with its full settle form,
because the panel already has the full decision area for the selected board.

- **A held board in the round on screen:** chip, where ("Round {round} · Board {board}"), names, the held reason, and
  **"Review board {n}"** (fix 1). The action is a BUTTON that selects that board in place (`select(fixtureId)`). This
  is the self-link fix: nothing on the panel links to the panel's own URL.
- **A held board of another round or stage:** the same card; "Review board {n}" is a link to
  `routes.divisionArbiter(..., fixtureId)`, which pins that board's round (I3). That is a different page state, not a
  link to the current one.
- **A held board the organiser plays on** (`seated`): the existing `arbiter.notice.settleOwnBoard` line and no action.
- **A flagged board:** chip, where, the flag count, and "Review board {n}", with the same in-place or link rule.
- **A flagged board that is cancelled:** it can never be selected (`arbiterRequestedRound` excludes cancelled boards,
  and so does the round), so its card keeps the inline **"Mark as reviewed"** it has today, and no Review button.
- The block rises to the top of the column in every phase when it has any card. Its title is "{count} boards need a
  decision", red when any card is held.

## 6. Invite status words

### 6.1 The mapping (fix 6), total over the twelve outbox statuses

Authority: the outbox design ("The seat stays stamped while any of its rows can still deliver", and the anti-goal
"the arbiter is never shown 'invited' for a player whose email never left") and the shipped classifier `seatOutcome`
(`invite.ts:230`) with the hook's `SEAT_HOLDING_STATUSES` (`invite-outbox-hook.ts`).

| Outbox status | Word | Why |
|---|---|---|
| `delivered` | **Delivered** | Resend's `email.delivered`: the receiving server accepted it. |
| `complained` | **Delivered** | It arrived and the recipient marked it as spam. The hook keeps the seat stamped (it is in `SEAT_HOLDING_STATUSES`, and `seatOutcome` says `invited`). "Not delivered" would be false. |
| `sent` | **Sent** | Resend accepted it; no delivery event yet. |
| `delayed` | **Delayed** | Resend's `email.delivery_delayed`. |
| `queued` | **Delayed** | Not yet accepted by Resend: either its first attempt is a moment away, or a retryable failure has put it back on the backoff schedule. The anti-goal forbids "Sent" for mail that never left. "Delayed" is true, and it holds the seat (`retrying`). |
| `sending` | **Delayed** | An attempt is in flight under a lease. Same reasoning as `queued`. |
| `bounced` | **Bounced** | Resend's `email.bounced`. Named separately because the fix is different: the address is wrong. |
| `failed` | **Not delivered** | The provider refused it permanently. |
| `suppressed` | **Not delivered** | Resend will not send to this address. |
| `expired` | **Not delivered** | Its `expires_at` (the board's check-in deadline) passed before it could go. |
| `dead` | **Not delivered** | Six attempts failed (the retry schedule ran out), or there was no API key. In CI and e2e every row ends here (`no_api_key`), so CI's default reading is "Not delivered". |
| `replaced` | *(none)* | Never an answer: `latestEmailStatus` filters it out. The mapper still handles it (returns `null`), so it is total over `OUTBOX_STATUSES`, and a test sweeps all twelve. |

The word list is closed at those five plus **"Not invited"**, which is not an outbox word: it is the answer when there
is no mail for the seat at all (§6.2). No word says, or implies, "opened". A short help line under the waiting list
says what "Delivered" means: "Delivered means the player's mail server accepted the invite. It does not mean they have
read it."

**OPEN-2 (owner): a sixth label for a seat with no mail.** The owner's five words are outbox words, and some seats
have no outbox row: a board whose window had already closed when the round opened (`skipped.windowClosed`), a seat
with no linked address, or a board re-paired after its invite. **Recommendation: show "Not invited"** for those
seats. It is the word the run sheet already uses (`runsheet.round.notInvited`), and the alternatives are both worse:
showing nothing hides a seat nobody has written to, and "Not delivered" claims a send that never happened. If the
owner wants only the five, such a seat shows no chip, and the plan's Task 1 drops `not_invited` (one step).

**Cross-check, as a test, not a comment.** For every status, `inviteWord(s)` is one of Sent / Delivered / Delayed
exactly when `seatOutcome([s])` is `invited` or `retrying`, and one of Bounced / Not delivered exactly when it is
`failed`. A seat painted "Sent" whose stamp the hook has released is the defect this rules out.

### 6.2 Which rows belong to a seat

Per seat, the loader reads `latestEmailStatus(auth.orgId, "fixture_seat", ["<fixtureId>:white", "<fixtureId>:black"])`
for the boards in check-in, in ONE call for the round. Then, per seat:

1. **Only the seat's current mailboxes count.** A row whose `lower(recipient)` is not among the seat's current
   recipients (`loadSides(f)` / `SidePlayer.recipients`, case-folded as `queueFixtureInvite` folds them) is ignored.
   Without this, a board re-paired after an Unpair would show the previous player's "Delivered" beside the new
   player's name: the ref id is the fixture and colour, not the person.
2. **One chip per remaining recipient.** The outbox design says "Status is per person; phase 2 shows it per person."
   A chess seat is normally one person (`guard.ts`: several linked members is not a chess seat), so this is one chip.
3. **No rows left, seat stamped** (bound to this round's open, as `boundStamps` reads it): "Not delivered". This is
   `seatOutcome([])`, which is `failed`, and the loader logs a warning, because a held stamp with no mail is an
   anomaly.
4. **No rows left, seat not stamped:** "Not invited".

Words are shown only where they help: on seats that are **not here yet**, on boards still **in check-in**. A seat
that has checked in shows "Here" and no mail word.

### 6.3 Where the words come from in production

"Delivered", "Bounced" and "Delayed" exist only if Resend's webhook is subscribed to those events. This is an ops
precondition for staging and production, not a code change. The plan's last task records it for the owner's staging
walk.

## 7. The online-chess flag (fix 7)

One question per page render: `onlineChessOffered(auth)` (PostHog `online-chess`, 60 s cache).

- **The arbiter page** 404s when the club is not offered online chess. This is a new check after the existing three.
- **The Fixtures-tab entry** to the panel, and **every run-sheet chip link** into it (`arbiterHrefFor`), render only
  when the panel would answer. When it would not, the chips fall back to plain spans (`chipLink` already does this for
  an undefined href).
- **Not gated:** the finishing controls (settle, resync, go on, mark reviewed) and their routes, as T20 rules. §8 is
  how they stay reachable when the panel is not offered.
- The owner's 2026-10-11 ruling ("the flag is never switched off mid-round, and there is no kill switch") bounds the
  remaining edge: a panel open in a tab when the flag flips keeps working until its next refresh, which then 404s.
  No further handling is designed for it.

CI and e2e run with `ONLINE_CHESS_ALWAYS=1`, so flag-off is proven by unit tests only, as the existing flag wiring
is (`online-chess-flag-wiring.test.tsx`).

## 8. The Fixtures tab after the move

Define `arbiterOffered` = the organiser can edit, a chess division, online play is `lichess`, the club is offered
online chess, and the division has fixtures. This is the same predicate the panel's 404 uses, plus "has fixtures"
for the entry.

**When `arbiterOffered`:**

- No Open round control on any stage card (`openRounds` is not passed to `StagesPanel`).
- No queue on the tab: it now lives in the panel.
- The "start the division first" hint stays on the stage card, because the Start button is on this tab.
- The existing entry card (`arbiter.entry.link` + body) carries ONE status line instead of its fixed body
  (**recommended option C**, OPEN-1). It is a ladder, empty case first:
  1. no view to open, no round in check-in and nothing held or flagged: the existing body text;
  2. something held or flagged: "{count} boards need a decision" (red). A red attention outranks the phase, as on
     the desk;
  3. a round in check-in: "Round {round} check-in is open";
  4. a round to open: "Round {round} is ready to open".

  The tests pin this ORDER with a case where both 2 and 4 hold.

**When not `arbiterOffered`** (online play off now, or the flag off): the queue stays on the tab exactly as today
(T20: a board held before online play was switched off is still owed its decision). The one change is that its
"Review in arbiter panel" link is not rendered, because the panel would 404. That link is a live 404 today (§2).

### OPEN-1 (owner): what the Fixtures tab says about the round

| Option | What the organiser sees on the Fixtures tab | Owner value |
|---|---|---|
| A. Remove only | The existing "Arbiter panel" link card, unchanged | Least on the tab. But nothing on the tab says a round is waiting to be opened or that a board is held, so the organiser has to open the panel to find out. |
| B. One line per stage round | "Round 2 · ready to open · Open in Arbiter Panel" per stage card | Status in place, but the stage cards get busier again, which is what "looks messy" objected to. |
| **C. One status line on the entry card (recommended)** | One card for the division: "Arbiter panel" plus one sentence, red when a board needs a decision | The tab stays clean (one card, no controls), and still answers "do I need to go to the panel now?". It reuses the existing card, so it adds no new element. |

The plan builds C. A is C with the status line deleted (one task step). B is a separate design.

## 9. Copy (all four locales, real translations)

New keys (English shown; es, fr and nl get their own translations in the same task):

| Key | English |
|---|---|
| `arbiter.column.label` | "This round" (the column's `aria-label`) |
| `arbiter.column.nothingPaired` | "No round is paired yet. Pair the next round on the Fixtures tab." |
| `arbiter.column.toFixtures` | "Go to Fixtures" |
| `arbiter.column.checkin.closesIn` | "Check-in closes in" |
| `arbiter.column.checkin.opensIn` | "Next check-in opens in" |
| `arbiter.column.checkin.closed` | "Check-in has closed" |
| `arbiter.column.checkin.tally.one/.other` | "{count} of {total} player checked in" / "{count} of {total} players checked in" (plural on `total`) |
| `arbiter.column.alreadyPlaying.one/.other` | "{count} board already playing" / "{count} boards already playing" |
| `arbiter.column.finished.one/.other` | "{count} board finished" / "{count} boards finished" |
| `arbiter.column.playing.one/.other` | "{count} of {total} board playing" / "{count} of {total} boards playing" (plural on `total`) |
| `arbiter.column.waiting.one/.other` | "Waiting on {count} board" / "Waiting on {count} boards" |
| `arbiter.column.here` | "Here" |
| `arbiter.column.notHereYet` | "Not here yet" |
| `arbiter.column.queue.one/.other` | "{count} board needs a decision" / "{count} boards need a decision" |
| `arbiter.column.review` | "Review board {board}" |
| `arbiter.invite.sent` / `.delivered` / `.delayed` / `.bounced` / `.notDelivered` / `.notInvited` | "Sent" / "Delivered" / "Delayed" / "Bounced" / "Not delivered" / "Not invited" |
| `arbiter.invite.help` | "Delivered means the player's mail server accepted the invite. It does not mean they have read it." |
| `arbiter.entry.status.ready` | "Round {round} is ready to open" |
| `arbiter.entry.status.checkin` | "Round {round} check-in is open" |

Reused as they are: `runsheet.round.heading`, `pairedLede`, `pairingsLabel`, `openCta`, `inviteCta`, every
`confirm*` key, `batches*`, `batchOpens`, `batchCloses`, `resend`, `resent`, `resentNone`, `sending`, `resendFailed`,
`err.disabled`, `err.roundChanged`, `err.failed`; `externalPlay.openRound.*`; `externalPlay.openRound.startFirst`;
`externalPlay.queue.where`; the panel's `arbiter-extend-round*` copy; `arbiter.notice.settleOwnBoard`.

Reworded because the column renders them and they carry an em dash (fix 4). Each is reworded in all four locales:
`runsheet.round.paired`, `runsheet.round.openUntil`, `runsheet.round.err.notOnline`,
`externalPlay.openRound.alreadyOpen`, `externalPlay.held.clockFlagUnsettled`, `externalPlay.queue.reviewedNew.*`.
Also `arbiter.empty.body`, whose "open a round from the run sheet" is no longer true. An en dash in a numeric range
("Boards 1–8", `runsheet.round.batchBoards`) is typographically a range mark, not a dash in a sentence. The column
renders it as "Boards 1 to 8", using a new `arbiter.column.batchBoards` key, so that no dash of any kind is left in
the column.

A sweep test holds every key the column can render (`ROUND_COLUMN_KEYS`) to: present in all four locales, no `—`,
no `→`, `←` or `↗`, and no "opened" or "open rate" in an invite word. The sweep reports its count; a count of zero is
a failure.

Rules carried from the desk: counted strings go through `plural()`; no verb agrees with a stage name; a zero clause
is suppressed, never printed.

## 10. What is out of scope

- The panel's other em-dash strings (`arbiter.ownRound`, `arbiter.ownHidden.*`, `arbiter.tile.own`,
  `arbiter.decide.*`, `arbiter.notice.*`). The column does not render them. They are listed for a follow-up copy pass.
- Opened or clicked tracking (rejected by the owner in the outbox design).
- Any new API route. Every press in the column calls a route that exists today: open round, resend, the board and
  round extend, settle, resync, go on, mark reviewed.
- Moving the remaining send functions onto the outbox (outbox phase 3).
- Any change to the room, the public fixture page, or `/me`.

## 11. Test obligations (the plan assigns each to a task)

- **Sequence** (TEST-STRATEGY 1): a second Open press (already open, nobody new); a Resend after "Not delivered"
  (the word becomes "Delayed" or "Sent" from the new row); a re-pair after an Unpair (the old mailbox's word is gone);
  a board held after check-in (it leaves the tally and the "already playing" count, and joins the queue); the last
  board over (Open round N becomes primary); a pinned older round (no next-round press); flag off with a board held
  (the Fixtures-tab queue is still there).
- **Empty case first**: phase with no round; tally with no board in check-in; queue with no cards (no title, no zero);
  entry line with nothing to say.
- **Anti-vacuity**: the word sweep reports 12 statuses checked; the copy sweep reports its key count; the e2e layout
  probe reports how many relations it checked at each width.
- **Expected values from declarations**: the word table is derived from `OUTBOX_STATUSES` and checked against
  `seatOutcome`, never typed as twelve rows and compared with themselves.
- **Mutate once**: the mailbox filter, the stamped and no-rows branch, the phase ladder's first rule, the entry
  ladder's order, and the flag gate on the page.
- **Another sport**: not applicable as a sweep. The column exists only for `boardgame` with `onlinePlay === "lichess"`.
  The page test keeps a non-chess division returning 404 as the witness.
- **UI**: 1280, 768 and 320 by screenshot with no horizontal scroll; the seven-width `mobile.spec.ts` matrix in CI;
  the control set diffed at 320 against 1280; tap targets hit-tested at 44px.
