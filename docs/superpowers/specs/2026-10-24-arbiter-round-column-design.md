# Arbiter Panel round column (Variant C): design

**Status:** design, amended 2026-10-24 by the pre-flight scan (`.superpowers/sdd/2026-10-24-arbiter-round-column/preflight-scan.md`,
C1 to C30) and the controller's rulings on it (`progress.md` beside it). Both owner questions were ruled the same day by
the controller, under the owner's standing "apply the recommendation" rule (§2.1). The owner has been told and may
override either. Planning only; no product code has been written.
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
| `latestEmailStatus(orgId, refType, refIds)` exists, privileged, org-filtered | **True** | `server/email-outbox/status.ts:36`; `distinct on (ref_id, lower(recipient))`, never `replaced`, newest by `created_at, id`; `at` is `status_at`; `[]` issues no statement |
| ref type `fixture_seat`, ref id `<fixtureId>:<colour>` | **True** | `seat-stamp.ts:17`, `:21`: `CHESS_SEAT_REF_TYPE`, `chessSeatRef` |
| The desk carries invited / retrying counts | **Partly true** | They exist only as the RESPONSE to a press (`open-round-state.ts`, `ResendNotice {emailed, retrying}`). Nothing persistent says, per seat, what happened to the mail. The column needs a new per-seat read (§6). |
| The Arbiter Panel follows the online-chess flag | **False today** | `arbiter/page.tsx` checks `canEdit`, `boardgame` and `onlinePlay === "lichess"` only. The Fixtures-tab entry link (`arbiterHref`, division `page.tsx:574`) and every run-sheet chip link (`stages-panel.tsx:1540`, `arbiterHrefFor`, unconditional) ignore the flag too. Fix 7 is new work. |
| The queue belongs to online play | **False** | The queue mounts on ANY chess Fixtures tab (`onlineDesk`, `page.tsx:544`), online play on or off, flag on or off, by design: "Every control these feed FINISHES or reviews play, so none is gated by the online-chess flag (T20)". Moving it wholesale into a flag-gated panel would strand a held board. §8 keeps a fallback. |
| The spike's C screenshots | **Only one exists** | `c-checkin-used-1280.png` (check-in at 1280) in the spike session's scratchpad. No C capture at 768 or 320, and none of C's before or playing phases. The wireframes in §5 are drawn from the spike's code, not from pictures. |
| The spike's check-in hero is complete | **False** | It drops the round's own **reinvite / reopen** press (`press: "reinvite" | "reopen"`), which the Fixtures-tab control offers today. Removing the tab's control without it would lose the only way to invite late seats round-wide. §5.3 restores it. |
| The run sheet's "Review in arbiter panel" link is harmless | **False twice** | Inside the panel it links to the page you are on (fix 4's self-link). On a chess division with online play off, the panel 404s, so the same link on the Fixtures-tab queue points at a 404 today. |
| A "Not delivered" seat can be resent from the screen | **False** (pre-flight C4) | `canResend` needs a bound stamp (`open-round-view.ts:250`). A dead row releases the stamp, so a Not delivered seat never offers Resend. The round's press becomes `reopen` instead (`online-chess-desk.spec.ts:402`). "Resend after Not delivered" is reachable at the usecase level only. |
| In CI, a second Open press reads "already open" | **False** (pre-flight C20) | Every invite ends `dead` in CI (`online-chess-desk.spec.ts:377`), so the press becomes `reopen` and a second press re-opens (`open-round.ts:394-400`) and GROWS the outbox. "Already open" is the result shape `opened: false, reason: "already_open"` (`open-round-control.tsx:183-185`), reachable from a stale page whose seats are held. |

### 2.1 Questions that went to the owner, ruled by the controller

Both were put as owner questions in the first draft. On 2026-10-24 the controller applied the recommendation under
the owner's standing "apply the recommendation" rule and told the owner, who may override either. They are controller
rulings, not owner rulings.

- **Ruling 1 (was OPEN-1, §8): option C.** The Fixtures tab keeps ONE status line on the existing Arbiter Panel entry
  card ("2 boards need a decision", red, ahead of "Round 2 is ready to open"). It keeps the tab calm and still signals
  attention. If overridden: one line of copy and its test change.
- **Ruling 2 (was OPEN-2, §6.1): "Not invited" is the sixth label**, for a seat with no outbox row. It is the run
  sheet's existing word. "Not delivered" would claim a send that never happened. If overridden: one label.

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

### 5.1 Grid, placement and order (one DOM, branched; pre-flight C10)

Today the board grid is `main` with `lg:grid lg:grid-cols-[248px_minmax(0,1fr)_320px]`. Its centre and right groups are
`contents` wrappers (`arbiter-panel.tsx:311`, `:337`), and below `lg` everything orders by `order-*` in one flex column.
A two-track grid whose children sit in `contents` wrappers auto-places them into alternating cells. The column
therefore needs EXPLICIT placement, through three real groups:

| Group (in DOM order) | Holds | Below `md` | `md` to `lg` (768 to 1023) | `lg` and up |
|---|---|---|---|---|
| board list `nav` | the board list | hidden | hidden | `lg:col-start-1 lg:row-start-1 lg:row-span-2` |
| **board group** | the picker (`lg:hidden`), the watch-only line, the board heading, the camera and switch, other reports, **the waiting list** | `max-md:contents` (children order themselves) | `md:col-start-1 md:row-start-1`, a flex column | `lg:col-start-2 lg:row-start-1 lg:row-span-2` |
| **decision group** | the flags section, the decision, the outage card | `max-md:contents` | `md:col-start-1 md:row-start-2`, a flex column | `lg:col-start-3 lg:row-start-2` |
| **the column** (`aside`) | the queue, then the phase block | one real box, `max-md:order-[-2]` | `md:col-start-2 md:row-start-1 md:row-span-2` | `lg:col-start-3 lg:row-start-1` |

`main` gets `md:grid md:grid-cols-[minmax(0,1fr)_320px] md:grid-rows-[auto_1fr] md:items-start`. At `lg` it gets
`lg:grid-cols-[248px_minmax(0,1fr)_320px] lg:grid-rows-[auto_1fr]`. The second row is flexible, so a column taller than
the board group grows the decision row and opens no gap under the camera.

- **Below `md`**, the `aside` stays ONE real box (a landmark is never `display: contents`). Its children are in source
  order: the queue first, then the hero or status. No CSS `order` is used inside it, so "the queue rises first" is true
  source order. The waiting list (in the board group) is `max-md:order-[-1]`, so the phone reads: column, waiting
  list, picker, board, flags, decision.
- **From `md`**, the waiting list sits under the camera in the board group (`md:order-none`), as the spike did.
- **The before phase and the "no boards on screen" path** have no board grid. They render `main` with
  `md:grid md:grid-cols-[minmax(0,1fr)_320px]`: the notice in track 1 and the `aside` in track 2; below `md`, the
  `aside` comes first (`max-md:order-[-1]`).

`min-w-0` runs down the whole ancestor chain of every truncating name (AGENTS.md, phone composition: a missing one cost
106px of page overflow at 320 to 390). The class strings alone cannot prove a grid (AGENTS class 2), so the build is
checked with a local capture at 768 and 320 before it is committed (plan Task 8), and the seven widths are checked in CI.

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

**Where the column mounts.** `ArbiterScreen` (`arbiter-panel.tsx:217`) has five render paths (`:253-266`). The column
joins three of them:

| Path today | Column |
|---|---|
| `requested !== null` (`RequestedNotice`) | none (rule 1) |
| `round === null` (`EmptyNotice`, `arbiter.empty.*`) | **before** |
| `boards.length === 0` (own round or no boards) | **playing** with no counts: the queue and the next-round press still apply |
| `board === null` (I3: the asked-for board is not in this round) | none: the notice stands alone, as today |
| the board grid | the phase from the ladder, placed as in §5.1 |

**The round bar (`RoundExtend`) keeps every line it shows today** (controller ruling on pre-flight C13). Today it renders
on every path with a round (`arbiter-panel.tsx:249-251`), with its button, its why line ("Game started", "Check-in
has closed") and the answer to the last press. Exactly one bar is mounted per page, and where it goes depends on the
path:

- **check-in phase:** inside the hero (§5.3), with its button;
- **playing phase** (the grid path and the no-boards path): inside the playing status block (§5.5), with its why line
  and its last answer. The button cannot appear there: a round-wide press reaches only a `checking_in` board with its
  window open, and such a board makes the phase check-in;
- **the I3 `board === null` path** (no column): in its current top-bar position, unchanged.

No state loses a line it shows today.

### 5.3 Check-in (the phase the owner looked at)

```
1280                                                             column, 320px
+-------------+------------------------------------+-------------------------------+
| Boards      | Board 3 · Ada Lovelace v Alan Tur  | 2 boards need a decision      |
|  1 Ada v .. |  +------------------------------+  |  Held  Round 2 · Board 4      |
|  2 ...      |  |                              |  |   [Review board 4]            |
|  3 ...      |  |      camera / board pane     |  +-------------------------------+
|  ...        |  |                              |  | Round 2                       |
|             |  +------------------------------+  | Check-in closes in            |
|             |  Waiting on 4 boards               |  07:42                        |
|             |  Board 6  Ada L.   Not here yet    | 12 of 20 players checked in   |
|             |           Delivered                | [====== progress ======    ]  |
|             |           Bo M.    Here            | 5 boards already playing      |
|             |           [Resend invite] [+5 min] |  [ +5 min to the round ]      |
|             |  Board 9  ...                      |  [ Invite 2 players ]  quiet  |
|             |  Delivered means ... (help line)   |  Check-in groups (staggered)  |
|             |                                    |   Boards 1 to 8  closes 19:10 |
|             |                                    +-------------------------------+
|             |                                    | decision area (existing)      |
+-------------+------------------------------------+-------------------------------+
```

```
768                                            320
+--------------------------+------------------+   +----------------------------+
| [ Board picker v ]       | 2 need a decision|   | 2 boards need a decision   |
| Board 3 pane             |  [Review board 4]|   |  [Review board 4]          |
|                          | Round 2          |   | Round 2                    |
| Waiting on 4 boards      | closes in 07:42  |   | Check-in closes in 07:42   |
|  Board 6 ...             | 12 of 20 ...     |   | 12 of 20 players checked in|
|  [Resend] [+5 min]       | 5 boards already |   | 5 boards already playing   |
+--------------------------+ [+5 min round]   |   | [ +5 min to the round ]    |
| flags, decision area     |                  |   | Waiting on 4 boards        |
+--------------------------+------------------+   |  Board 6 ... [Resend] [+5] |
                                                  | [ Board picker v ]         |
                                                  | Board 3 pane, decision     |
                                                  +----------------------------+
```

**The hero** (`data-testid="arbiter-checkin-hero"`):

- **Countdown** to the NEXT board closing: the earliest `checkin.deadlineAt` over `checking_in` boards whose window is
  open now. "Open now" is `inExtendWindow` (`lib/checkin-extend.ts:65`, opening included, deadline excluded), the one
  authority for the window; it is never restated (pre-flight C5). The countdown ticks on the panel's existing clock
  (`useExtendClock`), so it moves without a refresh. If no window is open but a later group is still to open, it reads
  "Next check-in opens in mm:ss". If no window is open and none is to come, it reads "Check-in has closed". These are
  three states of one clock, each with its own string.
- **Tally**: "{n} of {total} players checked in". `total` is two seats for each `checking_in` board whose window is
  open; `n` is the seats among them that have checked in. Presence comes from the rule the room uses (`checkInCounts`,
  `window.ts:95`), so a check-in before the board's window opened does not count. A progress bar shows the same
  fraction (`role="progressbar"`, `aria-valuenow`, `aria-valuemax`).
- **"{count} boards already playing"** (fix 2) counts boards that are `starting` or `live`. It does not count held boards,
  which the queue lists, or finished ones. "{count} boards finished" is a second clause, shown only above zero. A zero
  clause is never printed (desk `_RULES.md`: an empty cell is not information).
- **"+5 min to the round"**: the panel's one `RoundExtend` (`arbiter-extend-round*` testids, `roundExtendRunner`,
  `liveExtendableBoards`, `roundExtendWhy`), placed here in this phase (§5.2).
- **The round's own press** when `press` is `reinvite` or `reopen` (the spike dropped it, §2): the existing
  confirmation, reached from a quiet secondary button with the existing copy ("Invite {count} players", "Open Round
  {round} again?"). This is how a Not delivered seat is invited again (pre-flight C4). Its stamp is released, so its
  row offers no Resend, and the round's press becomes `reopen` or `reinvite`.
- **Check-in groups** for a staggered round (`timedBatches`, I-1), as the Fixtures-tab control lists them today.

**The waiting list** (`data-testid="arbiter-waiting"`), under the camera from `md` and after the column below `md`. It
lists the SAME boards as the tally (pre-flight A6): `checking_in` boards whose window is open now, with at least one
seat not here, in board order. A later group's boards appear only in the group list, never as "Not here yet" before
their window opens.

- Each seat shows its name and either **"Here"** (live dot) or **"Not here yet"** followed by its invite chip or chips
  (§6).
- **"Resend invite"** shows when the round's view says `canResend` for that board. That is only for a seat whose stamp
  is held, so it never shows beside "Not delivered" or "Bounced".
- **"+5 min"** shows when `boardExtendOffer(board.checkin, nowMs).offered` (`checkin-extend-ui.ts:82`), the
  owner's 2026-10-19 rule to the millisecond, which the panel's own board +5 uses (pre-flight C14). The snapshot's
  `canExtend` is never the gate.
- The board label is a button that selects that board in place (the existing `select()`). It never navigates.
- A row's "+5 min" first brings that board on screen (`select()`), then sends the board's existing extend
  (`decisionRunner.extend(boardId, boardNo)`). The answer appears in that board's decision area, where every board's
  +5 answer appears today. It is one press, and nothing is answered off screen.
- A row's "Resend invite" and the hero's reinvite or reopen press share ONE open-round handle for the round on screen
  (pre-flight C9). The handle lives in `ArbiterPanel` (`useOpenRound(view | null)`, a no-op when null), so R1's single
  in-flight guard (`open-round-state.ts:1-7`: one request at a time across the round's Open and its pairings' Resend)
  covers both. A Resend's answer (`rowNotice`: "{count} invites sent again.", "still sending") stays on its row. When
  `listOpenRounds` has no view for the round on screen, no row offers Resend. That is a guard, and a test reaches it.
- The help line ("Delivered means the player's mail server accepted the invite...") is the list's last line. It is
  absent with the list: with no row there is nothing to explain.

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

- There is one block per stage view with `press === "open"` from `listOpenRounds`. The stage name is shown only when
  more than one stage has a view. The block holds the round heading, the paired lede (`runsheet.round.pairedLede`), the
  **Open round** press with its existing confirmation (who it invites, the window, the scheduled-time note, and
  `earlierInPlay` when it applies), and a read-only list of the pairings. If that list scrolls inside its box, it owes
  `tabindex="0"`, a role and an accessible name, as `OpenRoundConfirmBody`'s list does (`open-round-control.tsx:137-142`,
  AGENTS class 23).
- **Division not started** (`onlineAwaitsStart`): the existing "Start the division to open rounds for online play"
  line, with no press. **It wins over the empty line** (pre-flight A8): `listOpenRounds` answers `[]` before Start, so
  both would otherwise apply.
- **Empty case** (started, no view to open, no round on screen): "No round is paired yet. Pair the next round on the
  Fixtures tab." with a link to `?tab=fixtures`. That link goes to another page, not this one.
- The block's press, its confirmation and its notice are rendered by a pure view (state in, markup out) over the
  `openRoundUi` state. The "already open" notice is the result `opened: false, reason: "already_open"`.

### 5.5 Playing

```
1280 column
+-------------------------------+
| 2 boards need a decision      |   <- the queue: first in the column whenever it has a card
|  Held   Round 2 · Board 4     |
|   Ada L. v Bo M.              |
|   Time's up: confirm the res. |
|   [ Review board 4 ]          |
|  Flagged  Board 7             |
|   [ Review board 7 ]          |
+-------------------------------+
| Round 2                       |
| 14 of 20 boards playing       |
| 3 boards finished             |
| Game started (round bar why)  |   <- the round bar's why line and last answer (§5.2)
+-------------------------------+
| Round 3 is paired             |
| Round 2 still has 6 games in  |   <- the server's earlierInPlay warning, inline
| play.                         |
| [ Open round 3 ]   (quiet)    |   <- primary once every board is over
+-------------------------------+
```

- **Status:** "{n} of {total} boards playing" (`starting` + `live` over the boards on screen) and the finished
  clause. There are no counts at all when `boards.length === 0`. Then the round bar's why line and last answer (§5.2).
- **The next round** (fix 5): every view with `press === "open"` stays offered while boards still play. Its button is
  quiet, with every `earlierInPlay` entry's sentence shown INLINE beside it (`runsheet.round.confirmEarlierInPlay`, one
  sentence per earlier round), not only in the confirmation. It becomes the primary button once every board on screen
  is over. The server's refusals and warnings are the same as today; nothing is blocked.

### 5.6 The queue in the column

The queue's data is the same as today: `listNeedsOrganiserExternalPlay` (held) and `listFlaggedExternalPlay` (flagged
plus `ownBoards`). The column shows it as compact cards, not as the Fixtures-tab queue with its full settle form,
because the panel already has the full decision area for the selected board.

- **A held board in the round on screen:** chip, where ("Round {round} · Board {board}"), names, the held reason, and
  **"Review board {n}"** (fix 1). The action is a BUTTON that selects that board in place (`select(fixtureId)`). This
  is the self-link fix: nothing on the panel links to the panel's own URL.
- **A held board of another round or stage:** the same card. "Review board {n}" is a link to
  `routes.divisionArbiter(..., fixtureId)`, which pins that board's round (I3). That is a different page state, not a
  link to the current one.
- **A board with no number** (`boardNo` is nullable on held rows, `queue.ts:32`): the where line falls back to the
  stage name, as the tab queue's `where()` does (`external-play-needs-result-queue.tsx:53-57`). The action reads
  "Review this board".
- **A held board the organiser plays on** (`seated`): the existing `arbiter.notice.settleOwnBoard` line and no action.
- **A flagged board:** chip, where, the flag count, and "Review board {n}", with the same in-place or link rule.
- **A flagged board that is cancelled:** it can never be selected (`arbiterRequestedRound` excludes cancelled boards,
  and so does the round), so its card keeps the inline **"Mark as reviewed"** it has today, and no Review button. That
  brings a second `arbiterDecision` reducer and runner onto the page, for that card only. This is accepted and
  recorded (pre-flight T7).
- **Boards the organiser plays on and that are flagged** are left out of the flagged list (C1, D7). As on the tab queue
  (`external-play-needs-result-queue.tsx:301`), one line says how many (`externalPlay.queue.ownFlagged`, plural). It
  is shown only above zero (pre-flight C11).
- **The count** behind "{count} boards need a decision" (pre-flight C6) is the number of DISTINCT fixture ids over the
  held boards the organiser does not sit on and the flagged boards. A held board with an open flag is in both lists and
  counts once. A seated held card is shown but not counted. The Fixtures-tab entry line (§8) uses this same count, from
  the same function.
- The block is the column's first child in every phase when it has any card. Its title is "{count} boards need a
  decision", red when any counted card is held.

## 6. Invite status words

### 6.1 The mapping (fix 6), total over the twelve outbox statuses

Authority: the outbox design ("The seat stays stamped while any of its rows can still deliver", and the anti-goal
"the arbiter is never shown 'invited' for a player whose email never left") and the shipped classifier `seatOutcome`
(`invite.ts:230`) with the hook's `SEAT_HOLDING_STATUSES` (`invite-outbox-hook.ts:45`).

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

**The sixth label (controller ruling 2, §2.1).** Some seats have no outbox row at all: a board whose window had already
closed when the round opened (`skipped.windowClosed`), a seat with no linked address, or a board re-paired after its
invite. Those seats show **"Not invited"**, rendered from the run sheet's existing key `runsheet.round.notInvited`
(pre-flight C2: one key, not a second copy that can drift per locale). Showing nothing would hide a seat nobody has
written to, and "Not delivered" would claim a send that never happened.

The word list is closed at those five plus "Not invited". No word says, or implies, "opened". A short help line says
what "Delivered" means: "Delivered means the player's mail server accepted the invite. It does not mean they have
read it."

**Cross-check, as a test, not a comment.** For every status, `inviteWord(s)` is one of Sent / Delivered / Delayed
exactly when `seatOutcome([s])` is `invited` or `retrying`, and one of Bounced / Not delivered exactly when it is
`failed`. A seat painted "Sent" whose stamp the hook has released is the defect this rules out.

### 6.2 Which rows belong to a seat

The loader reads in two passes (pre-flight C24): it builds the boards, collects the refs of the `checking_in` boards
only (`"<fixtureId>:white"`, `"<fixtureId>:black"`), reads `latestEmailStatus(auth.orgId, "fixture_seat", refs)` ONCE
for the round, then attaches the seats. A round with no board in check-in issues no outbox read (and
`latestEmailStatus([])` issues no statement anyway). Then, per seat:

1. **Only the seat's current mailboxes count.** A row is ignored unless its recipient is among the seat's current
   recipients (`loadSides(f)` / `SidePlayer.recipients`). Without this, a board re-paired after an Unpair would show the
   previous player's "Delivered" beside the new player's name, because the ref id is the fixture and colour, not the
   person. **Both sides are folded by one authority**, `trim().toLowerCase()` inside `seatInviteWords` (pre-flight
   C1). The outbox stores the raw address (`invite.ts:208`), and the caller passes raw emails.
2. **A `replaced` row is dropped explicitly** inside `seatInviteWords`, with a test that reaches it, even though
   `latestEmailStatus` never returns one.
3. **One chip per remaining recipient.** The outbox design says "Status is per person; phase 2 shows it per person."
   A chess seat is normally one person (`guard.ts`: several linked members is not a chess seat), so this is one chip.
4. **No rows left, seat stamped:** "Not delivered". This is the word for `seatOutcome([])`, which is `failed`. The
   loader logs a warning, because a held stamp with no mail is an anomaly. "Stamped" means bound to this round's open,
   and ONE exported helper in `seat-stamp.ts` answers it for both readers: the arbiter loader and `open-round-view.ts`'s
   `boundStamps` (pre-flight C15).
5. **No rows left, seat not stamped:** "Not invited".

Words are shown only where they help: on seats that are **not here yet**, on boards **in an open check-in window**. A
seat that has checked in shows "Here" and no mail word.

### 6.3 Where the words come from in production

"Delivered", "Bounced" and "Delayed" exist only if Resend's webhook is subscribed to those events. This is an ops
precondition for staging and production, not a code change. The plan's last task records it for the owner's staging
walk.

## 7. The online-chess flag (fix 7)

The page asks `onlineChessOffered(auth)` once per render (PostHog `online-chess`, 60 s cache).

- **The arbiter page** 404s when the club is not offered online chess. This is a new check after the existing three
  (`canEdit`, sport, online play), so the cheap checks run first and the flag is never asked for a non-chess division.
- **The Fixtures-tab entry** into the panel, and **every run-sheet chip link** into it (`arbiterHrefFor`), render only
  when the panel would answer. They are decided by `canEdit`, the predicate the panel's 404 uses
  (`arbiter/page.tsx:24`), not by `editable` (pre-flight C18: a billing-frozen organiser keeps a working panel and so
  keeps its entry). When the panel would not answer, the chips fall back to plain spans (`chipLink` already does this
  for an undefined href).
- **Not gated:** the finishing controls (settle, resync, go on, mark reviewed) and their routes, as T20 rules. §8 is
  how they stay reachable when the panel is not offered.
- The owner's 2026-10-11 ruling ("the flag is never switched off mid-round, and there is no kill switch") bounds the
  remaining edge. A panel left open in a tab when the flag flips keeps working until its next refresh, which then 404s.
  No further handling is designed for it.

CI and e2e run with `ONLINE_CHESS_ALWAYS=1`, so flag-off is proven by unit tests only, as the existing flag wiring
is (`online-chess-flag-wiring.test.tsx`).

## 8. The Fixtures tab after the move

Two predicates (pre-flight C18):

- **`arbiterOffered`** = `canEdit`, a chess division, online play is `lichess`, the club is offered online chess, and the
  division has fixtures. It decides the entry card and the chip links: the panel's own 404 predicate, plus "has
  fixtures". The 404 predicate is ONE function, `arbiterPanelOffered` (`server/arbiter-panel-offered.ts`), called by the
  arbiter page and by this tab, so the two cannot drift; the tab adds "has fixtures" on top.
- **`editable`** (`canEdit` and not billing-frozen, `page.tsx:296`) decides the controls and the queue, as today.

**When `arbiterOffered`:**

- No Open round control on any stage card. `StagesPanel` loses its `openRounds` prop and the mount
  (`stages-panel.tsx:1351`), and `OpenRoundControl` is deleted (pre-flight C16).
- No queue on the tab: it now lives in the panel.
- The "start the division first" hint stays on the stage card, because the Start button is on this tab. The hint is wanted
  before any fixture exists (a division that has not started has none yet), so it does not depend on the "has fixtures" term
  of `arbiterOffered`: the page asks the online-chess flag when the division has fixtures OR is awaiting start, and that ONE
  answer feeds both the entry card (which still needs fixtures) and the hint.
- The existing entry card (`arbiter.entry.link` plus body) carries ONE status line instead of its fixed body
  (**controller ruling 1, option C**, §2.1). Attention and phase are separate facts, as the desk rules require
  ("must never be collapsed into one enum"; pre-flight C7). The model is `{ attention: number; phase: "default" |
  "checkin" | "ready" }`. `attention` is the column queue's count (§5.6). `phase` is "checkin" when some view is open
  with its deadline ahead, otherwise "ready" when some view's press is "open", otherwise "default". A pure line picker
  then chooses the one line, empty case first:
  1. attention 0 and phase "default": the existing body text;
  2. attention above 0: "{count} boards need a decision" (red). A red attention outranks the phase, as on the desk;
  3. phase "checkin": "Round {round} check-in is open";
  4. phase "ready": "Round {round} is ready to open".

  The tests pin both orders: a case with attention and "ready" both true reads attention, and a case with "checkin"
  and "ready" both true (a league pairs every round at Generate) reads check-in.

**When not `arbiterOffered`** (online play off now, or the flag off): the queue stays on the tab exactly as today
(T20: a board held before online play was switched off is still owed its decision). The one change is that its
"Review in arbiter panel" link is gone, because the panel would 404. That link is a live 404 today (§2).

### Controller ruling 1 (was OPEN-1): what the Fixtures tab says about the round

Ruled 2026-10-24 by the controller under the owner's standing "apply the recommendation" rule; the owner has been told
and may override. The options as they were put:

| Option | What the organiser sees on the Fixtures tab | Owner value |
|---|---|---|
| A. Remove only | The existing "Arbiter panel" link card, unchanged | Least on the tab. But nothing on the tab says a round is waiting to be opened or that a board is held, so the organiser has to open the panel to find out. |
| B. One line per stage round | "Round 2 · ready to open · Open in Arbiter Panel" per stage card | Status in place, but the stage cards get busier again, which is what "looks messy" objected to. |
| **C. One status line on the entry card (applied)** | One card for the division: "Arbiter panel" plus one sentence, red when a board needs a decision | The tab stays clean (one card, no controls), and still answers "do I need to go to the panel now?". It reuses the existing card, so it adds no new element. |

If the owner overrides: A is C with the status line deleted (one task step); B is a separate design.

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
| `arbiter.column.reviewThis` | "Review this board" (a board with no number) |
| `arbiter.column.batchBoards` | "Boards {from} to {to}" |
| `arbiter.invite.sent` / `.delivered` / `.delayed` / `.bounced` / `.notDelivered` | "Sent" / "Delivered" / "Delayed" / "Bounced" / "Not delivered" |
| `arbiter.invite.help` | "Delivered means the player's mail server accepted the invite. It does not mean they have read it." |
| `arbiter.entry.status.ready` | "Round {round} is ready to open" |
| `arbiter.entry.status.checkin` | "Round {round} check-in is open" |

Reused as they are: `runsheet.round.notInvited` (the sixth label), `runsheet.round.heading`, `pairedLede`,
`pairingsLabel`, `openCta`, `inviteCta`, every `confirm*` key, `batches*`, `batchOpens`, `batchCloses`, `resend`,
`resent`, `resentNone`, `sending`, `resendFailed`, `err.disabled`, `err.roundChanged`, `err.failed`;
`externalPlay.openRound.*`, including `startFirst`; `externalPlay.queue.where`; `externalPlay.queue.ownFlagged`; the
panel's `arbiter-extend-round*` copy; `arbiter.notice.settleOwnBoard`.

Reworded because the column renders them and they carry an em dash (fix 4). Each is reworded in all four locales:
`runsheet.round.paired`, `runsheet.round.openUntil`, `runsheet.round.err.notOnline`,
`externalPlay.openRound.alreadyOpen`, `externalPlay.held.clockFlagUnsettled`, `externalPlay.queue.reviewedNew.*`.
Also `arbiter.empty.body`, whose "open a round from the run sheet" is no longer true. The column renders a numeric
range as "Boards 1 to 8", using `arbiter.column.batchBoards`, so that no dash of any kind is left in its copy.

**Scope of the dash rule.** It covers dictionary copy. Names are data: `sideDisplayName` floors an empty name to an em
dash (`guard.ts:363-374`), and that floor stays.

**The sweep** (pre-flight C19). Every key the column can render must be present in all four locales and must contain
no `—`, `→`, `←` or `↗`. The keys come from three sources:

1. **literals in the column's own files.** Every literal passed to `msg(`, `plural(`, `t(` or `f.t(` must be in
   `ROUND_COLUMN_KEYS` (one way: literals are a subset of the list);
2. **maps.** The values of `INVITE_WORD_KEYS`, `HELD_TITLE_KEYS` and the other key maps the column reads must be a
   subset of the list;
3. **helpers.** An explicit `ROUND_COLUMN_HELPER_KEYS` names the keys rendered through `openNoticeText`,
   `resendNoticeText`, `OpenRoundConfirmBody` and `RoundExtend`.

No invite word, in any locale, reads as "opened": `/open/i` in `en`, `abiert` in `es`, `ouvert` in `fr` and `geopend` in
`nl`. Each sweep reports its count, and zero is a failure.

Rules carried from the desk: counted strings go through `plural()`; no verb agrees with a stage name; a zero clause
is suppressed, never printed.

## 10. What is out of scope, and what is recorded

- The panel's other em-dash strings (`arbiter.ownRound`, `arbiter.ownHidden.*`, `arbiter.tile.own`,
  `arbiter.decide.*`, `arbiter.notice.*`). The column does not render them. They are listed for a follow-up copy pass.
- Opened or clicked tracking (rejected by the owner in the outbox design).
- Any new API route. Every press in the column calls a route that exists today: open round, resend, the board and
  round extend, settle, resync, go on, mark reviewed.
- Moving the remaining send functions onto the outbox (outbox phase 3).
- Any change to the room, the public fixture page, or `/me`.
- **Recorded, not changed** (pre-flight A22): each `router.refresh` poll of the panel now runs five readers plus the
  presence and outbox reads. This has not been measured against the 60-connection production budget, and the PR names it.

## 11. Test obligations (the plan assigns each to a task)

- **Sequence** (TEST-STRATEGY 1):
  - a double click on the confirmation sends one POST, and the outbox gains two rows per board;
  - "already open" from a stale page, with the round opened by API and the seats seeded as holding;
  - a Resend after "Not delivered" is proven at the usecase level, because the screen offers the round's reopen
    press there instead (§2, C4);
  - a re-pair after an Unpair: the old mailbox's word is gone;
  - a board held after check-in leaves the tally and the "already playing" count, and joins the queue;
  - when the last board is over, Open round N becomes primary;
  - a pinned older round offers no next-round press;
  - with the flag off and a board held, the Fixtures-tab queue is still there.
- **Empty case first**: phase with no round; tally with no board in check-in; queue with no cards (no title, no zero);
  entry line with nothing to say; the start line against the empty line.
- **Anti-vacuity**: the word sweep reports 12 statuses checked; the copy sweeps report their key counts; the e2e layout
  probe reports how many relations it checked at each width.
- **Expected values from declarations**: the word table is derived from `OUTBOX_STATUSES` and checked against
  `seatOutcome`, never typed as twelve rows and compared with themselves. The paired lede's player count comes from the
  fixture (two seats per board), not from `owedPlayers`.
- **Mutate once**:
  - the mailbox filter;
  - the stamped no-rows branch;
  - the loader's skip of the outbox read outside check-in;
  - the phase ladder's first rule, and the entry ladder's order;
  - the waiting row's live +5 gate;
  - the queue count;
  - the `canEdit` / `editable` split;
  - the flag gate on the page.
- **Another sport**: not applicable as a sweep. The column exists only for `boardgame` with `onlinePlay === "lichess"`.
  The witnesses are the page test's non-chess 404 and the "another sport" cell of `arbiter-entry-link.test.tsx`.
- **UI**: 1280, 768 and 320 by screenshot with no horizontal scroll; the seven-width `mobile.spec.ts` matrix in CI;
  the control set of `main` diffed at 320 against 1280; tap targets hit-tested at 44px, inside the column and the
  waiting list.
