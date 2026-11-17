# Match Day, all in one: design

Date: 2026-11-05. Status: draft for owner approval. Scope: `apps/web`, the Match Day surface, the online chess organizer functions and the division Fixtures tab's links.

Read with: `docs/superpowers/specs/2026-10-31-match-day-design.md` (Match Day as built), `docs/superpowers/specs/2026-11-05-checkin-capacity-design.md` (the capacity work this sits on), `docs/superpowers/plans/2026-11-05-checkin-capacity-3-arbiter.md` (re-targeted by section 9), `AGENTS.md`, `docs/superpowers/RULES.md`, `docs/superpowers/TEST-STRATEGY.md`.

Mockups (layout only; the build uses the house theme and Match Day's own components): `.superpowers/brainstorm/75429-1793918802/content/focus-v2.html` (chosen), `layout.html` (the three layouts offered; A chosen).

## 1. Intent

Match Day is the organizer's one surface for running the day. Today it runs the hall's courts, and an online chess round is run from a second page, the arbiter panel, with its own list, its own queue and its own round controls. The owner's ruling (2026-11-05): "we are designing the matchday which include all in one". The online boards of a round become rows in Match Day's list, a board in focus shows the chess board where a court shows its scoreboard, or the players' cameras when the division requires them, and the round's own controls, the waiting seats and the decisions sit where Match Day already has a place for each. The arbiter page is removed.

The layout is Match Day's, exactly (owner: "I need exactly same layout of matchday"): header, Needs you, the venue and division chips, the list on the left, the focus on the right; on a phone the list is home and a row opens full-screen. Nothing new is added to the page's shape.

A division is online or in the hall, never both (owner), so a competition can show courts and boards side by side, and a division chip narrows to one or the other.

## 2. Goals, non-goals, anti-goals

Goals

- One page for the day: courts and online boards in one list, one Needs you, one set of chips.
- Every board's state and presence visible in the list at no vendor cost (the capacity design's presence table and camera reports).
- A board in focus shows the position, or both players' cameras when required, with the clocks, flags and the decisions an arbiter makes.
- The round's controls (open, resend invites, +5 min, who is not here yet) reachable from the round's own row.
- Viewers who may see Match Day see the boards and their state; only an organizer who may edit, in a club offered online chess, sees cameras or decisions.

Non-goals

- Changing how a seat is earned, how a game is created or how a flag is written. Every server rule of online play stays as it is; this moves where it is shown and pressed.
- A grid of many boards' video at once. One board's cameras at a time, as one court is in focus at a time (owner, option A). Plan 3's grid is dropped (section 9).
- Court cameras (Match Day design §8, phase E) and the setup redesign (phases C and D). Untouched.
- A phone composition of its own for boards: boards follow the courts' phone rules.

Anti-goals

- Live state of an online round shown in two places after this ships (the Match Day design's own anti-goal, extended): the arbiter page, its queue cards and its entry links are gone, not hidden.
- A viewer, or an organizer who plays on a board, seeing a camera (chess design D7, C1). The page hides what the join route refuses, and the route keeps refusing.
- A board row that looks like a court row but behaves differently in ways the organizer cannot see: a board has no queue, no Call and no scorer QR, and its panel says what it is.

## 3. Constraints and verified facts

Match Day as built (`components/v2/match-day/`, `lib/match-day/`, `server/usecases/match-day.ts`)

- The list is courts in group order (playing, called, up next, elsewhere, free, closed), then "Playing, no court" rows (`NoCourtList`): matches `in_play` with no court, which already names "an online board" as a case. A row opens its panel beside the list from `md` and over it on a phone. The focus is one court or one match (`resolveFocus`), with a "left the list" notice when it goes.
- The header carries the title and date, the competition, the counts line (`headerCountParts`), the Needs you button and list (on a match day the competition's whole list lives here), the venue filter and the division chips.
- Read-only members get the same page with nothing that writes (`readOnly`); a billing-frozen competition offers no Call or Undo (`frozen`). The server refuses every write on its own.
- The page polls through `band-poll.ts` (20 s live, 90 s quiet, paused while hidden) and ticks a minute clock for closures.
- A panel's "Open pad" is the fixture's console page (`fixtureHref`); for a viewer it reads "Open match".

The arbiter functions as built (`usecases/external-play/arbiter.ts`, `components/v2/arbiter-panel.tsx`, `components/v2/arbiter/round-column.tsx`, `round-queue-cards.tsx`, `lib/arbiter-view.ts`, `lib/round-column.ts`)

- The loader (`loadArbiterRound`) reads one division's opened round: boards in board order with state (checking in, starting, live with move number, on hold, result, cancelled), clocks, camera policy, override, camera report state, each side's meeting (none, open, ended), the check-in extension state, each seat's check-in and invite words, and open flags. Plan 3 Task 3 adds each side's presence and reported camera.
- The round column reads `listOpenRounds` (the rounds that can be opened or are open, with the open-round view the press uses), `listNeedsOrganiserExternalPlay` (held boards), `listFlaggedExternalPlay` (flagged boards), the venue zone and whether the division has started; it draws three phases (before, check-in, playing) and the waiting list.
- The decisions: +5 min on a board (`checkin-extend`), +5 min to the round, resync from Lichess, "let the game go on" (close flags), settle the result (the resolve route, with the no-result offer), let play without video (D11 override). All are server usecases with routes; the panel only presses them.
- The camera join: `joinAsArbiter(fixtureId, side)` for ONE player's meeting, receive-only, refused for a viewer, a non-editor, an organizer who plays on the board, a board whose round is not open, a camera-off board, an overridden board, a meeting not started or ended. The browser side is `arbiter-camera.ts` (the guard) and `arbiter-watch.ts` (the chain), re-shaped by plan 3 Tasks 1 and 2 (one participant per meeting for the game, per-meeting chains, tokens in page memory, no DELETE from the browser, a 60-call floor).
- Who may use it: the page requires `canEdit`, a chess division with online play on, and the PostHog flag `online-chess` (`arbiterPanelOffered`). The Fixtures tab's entry card and the run sheet's chips link to the page (`routes.divisionArbiter`).
- The match room already renders a live position with `chessground` from the bridge's move list (`fenAfter(moves)`), so a read-only board needs no new dependency.

The capacity design (2026-11-05) and its plans

- Plans 1 and 2 are server-side and unchanged by this design. Plan 3's Tasks 1 to 3 (participant lifetime, per-meeting chains, presence and camera in the loader) are what this design's cameras run on; its grid, spike and panel wiring are replaced by section 9.

## 4. The design in one paragraph

Match Day's view grows a list of online rounds: for every online chess division of the competition, its opened round (or the next round that can be opened), with its boards read by the arbiter loader. In the list each online round is a group row heading its board rows, ordered after the courts and placed by the same groups (a round in check-in or with a board live sits with "playing", a round paired but not opened with "up next"). A board row reads like a court row: a state dot, "Board 3 · Chen v Abara" with a presence mark per player, and the state word on the right. Opening a board shows Match Day's focus panel with the chess board, or both players' cameras when the division requires them, in the scoreboard's place, the clocks under it, a state line, the board's flags and the decisions; opening a round shows the round's own panel: the countdown and tally during check-in, who is not here yet with resend and +5 per seat, "+5 min to the round" and "resend invites", and the next round's open. Held and flagged boards are Needs you rows that open the board. Everything shown comes from the tables the loader already reads; the only vendor calls are the two camera joins of the board in focus. The arbiter page, its column and its links are removed, and every link that pointed at it points at Match Day with `?board=`.

## 5. The list

### 5.1 Rows

- **Round row** (one per online division with a round to show): "<Division> · Round N", a round dot, and on the right the round's one-line state: during check-in "closes HH:MM · 7 of 10 here" (the venue zone, as the column printed it); while playing "6 of 10 playing"; before the open "paired · not opened"; a division not started "not started". It is a row like a court's: it opens the round's panel.
- **Board row**: a state dot; "Board N · White v Black" where each name carries a presence mark (green: a current peer in the player's meeting; amber: present with the camera reported off; grey: absent; no mark when the policy is off); on the right the state word: "Checking in", "Starting", "Live · move 12", "On hold · 1 flag" (red), the score ("1–0", "½–½"), "No result", "Cancelled" never (a cancelled board is not listed, as today). A board the organizer plays on is listed with its state and marks and opens a panel that says so (C1), never a camera.
- The rows of a round sit directly under their round row, in board order. No fold: boards are never many enough on one round to need one, and a free court's fold stays as it is.

### 5.2 Order and groups

The court list is untouched: its groups, its fold of free courts and its closed tail stay exactly as they are. The online rounds are a third block, after the courts and the "Playing, no court" rows, grouped among themselves: rounds in check-in or with a board live first, then rounds paired and not opened, then rounds whose boards are all over; within a group, divisions in competition order, and within a division its stages in order. A round is never folded. The desktop's default focus stays the first row of the whole list, so a court when any court is listed.

One row per (division, stage, round): a division whose Swiss stage has a round open and whose knockout stage has a round that can be opened shows two round rows, each with its own panel and its own "Open" press; the row's name carries the stage when the division has more than one ("U18 · Swiss · Round 2"). A division with nothing opened and nothing openable has no row. A division that has not started shows one row, "not started", whose panel says to start the division first.

A board that is `in_play` on no court today appears under "Playing, no court". Once a board row exists for it, that row is the only place it is listed: the no-court rows exclude fixtures that belong to a listed online round.

### 5.3 Chips and counts

- The division chips are the ones Match Day has: an online division's chip narrows the list to its round and boards; "All" shows courts and rounds together.
- The counts line gains the boards: "4 courts · 2 playing · 1 free · 6 boards playing", using the sport's noun (`venueNoun("boardgame")` is "board"); with no courts the line is the boards' part alone, as the no-court count is today.
- The venue filter is about courts; rounds have no venue and are never hidden by it.

### 5.4 Needs you

Two kinds join the competition's attentions, ONE ROW PER BOARD, each carrying the board's fixture id: a held board ("Board 4 · Novak v Silva needs a decision", kind `board_held`) and a flagged board ("Board 2 · camera report to review", kind `board_flagged`). They are produced where the desk's attentions are (`division-phase.ts` / `competition-desk.ts`, from `listNeedsOrganiserExternalPlay` and `listFlaggedExternalPlay`), so the competition page's "N things need you, in Match Day" line counts them and the one-place-at-a-time rule and its tests cover them. The division-level `needs_decision` row that today folds an online hold is replaced by the per-board rows for online divisions, so a hold is never counted twice. Each row's action opens the board's panel in place, as "Find a court" opens a court. The results-owed count is unchanged.

These rows show to every organizer who may edit, offered online chess or not: a decision FINISHES play, and nothing that finishes play follows the flag (the T20 rule the arbiter's queue already keeps). A board the viewer plays on is left out of that viewer's rows (C1), as the loader leaves it out of the list.

### 5.5 Boards from earlier rounds

A held or flagged board usually belongs to an earlier round than the one listed: a camera report lands after the game. Such a board is listed too, so Needs you and `?board=` always resolve to a row: under the division's round row, after its boards, a sub-group "Needs a decision" holds every held or flagged board of that division from any round, each a board row with its round chip ("R1"). A board that is both in the listed round and held appears once, in its round. With nothing held or flagged the sub-group is absent. A board in neither place is "left the list", never another board opened in its place.

## 6. The focus panels

### 6.1 A board in focus

Match Day's court panel, shaped for a board:

- Header: "Board N · White vs Black"; under it the division, stage, round chip and time control ("Swiss · R2 · 10+5"), and the state line ("Live · move 4 · both present"). On the right, "Open match" (the fixture's console page, `fixtureHref`), for everyone.
- The top panel, where a court shows its scoreboard:
  - **Cameras** when the division's camera policy is `required` and the viewer may watch: two tiles side by side (White left, Black right by color, the meeting being the side's), each with the player's name and color, the clock under it, and the tile's word when there is no video: "Not checked in", "Present, connecting", "Camera off since HH:MM", "Waiting for capacity" (the 60-call floor), "Over". A Cameras / Board switch sits in the header's right, so the organizer can look at the position; the switch defaults to Cameras.
  - **The chess board** otherwise (policy `off` or `optional`, an override, a viewer, an organizer who plays on the board, a board whose cameras are over): the position from the bridge's moves, read-only, oriented with White at the bottom, the last move marked, each player's name and clock beside it, "to move" on the side to move. Rendered with the match room's board (`chessground`), never a second board.
  - A board in check-in with no game yet shows the two sides with their check-in and invite words ("Here", "Not here yet · invite Delivered") in the top panel, and the cameras when required and present.
- Flags: the board's open flags as the arbiter's cards (`arbiter-flag-cards.tsx`: the camera report with its timeline, out-of-band play, connection problems, multiple devices), and "Camera report pending" where one is owed.
- Decide: the decisions as buttons, each only when the server would accept it (the loader's own predicates, as today): "+5 min" with its deadline line, "Resync from Lichess", "Let the game go on" (closes the flags on screen), "Settle the result…" with the existing choices and the no-result offer, "Let play without video" inside the outage card. A viewer sees none of them.
- A notice line for a refusal, kept per board through refreshes, as the court panel keeps a refused call.

Cameras join only for the board in focus: opening a board joins both sides' meetings (plan 3's per-meeting chains, tokens kept for the page), leaving a board leaves both with the SDK. Switching boards costs one call per meeting first visited and nothing to return. A board whose side has no meeting yet shows the word, not a join.

### 6.2 A round in focus

The round column's three phases become one panel, by phase:

- **Before**: "Round N · paired, not opened", the pairings list read-only, and the press "Open round N" with its confirmation and the open-round answer; "The division has not started" in its place when so.
- **Check-in**: the countdown to the next board closing (the column's one large element), the tally (here, not here yet, not invited, boards playing), the staggered batch times when the round staggers, then "Not here yet": one line per seat not here with its invite words and "Resend" and "+5 min" for the board, then the round's presses: "Resend invites", "+5 min to the round"; then "Open round N+1" with the server's warning while boards still play.
- **Playing**: "N of M boards playing", the finished clause, the round's reinvite or reopen press when the reader names one, and "Open round N+1" primary once everything is over.

Every press is the existing request (`useOpenRound`, the extend routes, the resend route) with the same guards, confirmations and answers.

### 6.3 On a phone

The list is home. A board row opens its panel full-screen with "‹ All courts" (or "‹ All boards" on a day with no courts); the two camera tiles stack. A round row opens the round's panel the same way. The header hides while a panel is open, as it does for a court.

### 6.4 Who sees what

| Reader | List | Board panel | Round panel |
|---|---|---|---|
| Member who may view | rows, state words, presence marks | the chess board, flags, "Open match"; no cameras, no decisions | the countdown and tally, the pairings; no presses |
| Organizer with a watcher role (`EDITOR_ROLES`: owner or admin, the join route's own rule), club offered online chess | the same | cameras when required, every decision | every press |
| The same organizer, club NOT offered online chess | the same | the chess board, flags, and the decisions that FINISH play (resync, let the game go on, settle); no cameras, no +5 | the countdown and tally; no presses (opening and inviting START play) |
| An organizer who plays on a board | that board is not listed; one line says so (the loader's rule today) | not reachable for that board | the presses, except that board's seats |

The organizer parts are offered when the viewer's role is in `EDITOR_ROLES`, the set the join route and the sweep's removal already use; if Match Day's `canEdit` is ever wider than that set, the narrower set decides, so the page never offers a tile the route refuses. The online-chess flag is read once per page load for the club (`onlineChessOffered`), as `arbiterPanelOffered` does today; the server routes keep their own checks and are not changed by this design. Residual, stated: the server refuses an organizer who plays on a board only for the video override today; the page hides the other decisions for that board as the arbiter panel does, and the routes are left as they are.

## 7. Data and server

- `MatchDayView` gains `online_rounds: MatchDayOnlineRound[]`: one per (online chess division, stage, round) to show (section 5.2), with `phase` (`before` | `checkin` | `playing` | `not_started`), the `OpenRoundView` the presses need, the LIST's facts for each board (state, clocks, each side's presence and reported camera from plan 3's loader, the check-in and invite words of a board in check-in, the flag and held counts), the "Needs a decision" boards of the division, the venue zone and `offered` (the club's online-chess flag). This is what the 20-second poll carries, for every reader.
- The board IN FOCUS reads its heavy parts through its own read, `GET /api/v1/fixtures/{id}/match-day-board`, polled on the same cadence while it is in focus: the position (`{ fen, lastMove, turn }` from the bridge's moves, `fenAfter`), the flag cards with their guard-fault stamps (`matchGuardFaults`), the no-result offer and the settle choices. The round in focus needs nothing beyond the list's facts. So the page's cost per reader is one list read per poll plus one board read while a board is open, never the loader's per-board statements for every board for every reader.
- What makes an online round part of "today": a board of a round opened today, or a board of any opened round with a live window or a game on file, is a match today for `countFixturesToday` (the rule the desk's Needs-you home and the competition page's "Open Match Day" button read), beside the `in_play` arm it already has. A round that is paired and not opened is listed but does not by itself make the day a match day; an online night is a match day from the moment its first round is opened. The day-boundary tests gain this case.
- The two Needs you kinds are desk attentions (section 5.4), produced per board with the fixture id as the row's target.
- Nothing new is written. Every press calls the route it calls today.
- `?board=<fixtureId>` opens that board (as `?court=` opens a court); `?round=<stageId>:<n>` opens a round. A value naming nothing on the list is ignored exactly as an unknown `?court=` is (the default focus, no notice); a board that was open and then leaves the list is the "left the list" notice, never another board in its place.
- The row source for an opened round is the arbiter loader (the division's latest opened round), not the open-round reader, so a round whose windows have all closed and whose games are still being played keeps its row with no view; the open-round reader's views add the rounds that can be opened. An opened round is listed while it is still the day's (section 7's rule) or while the division has a held or flagged board, and drops off after.
- Every press in a round's panel is that round's own. "Open round N+1" is on round N+1's row; round N's panel offers a line that selects it.

## 8. What is removed, and the links that move

- The arbiter page (`app/o/[orgSlug]/c/[compSlug]/d/[divSlug]/arbiter/page.tsx`), `ArbiterPanel`, `RoundColumn`, `WaitingList`, `RoundQueueCards`, `routes.divisionArbiter`, and `arbiter.spec.ts` and the arbiter parts of `online-chess-desk.spec.ts`. Pure modules the new panels reuse stay (`arbiter-view.ts`, `round-column.ts`'s phase and tally rules, `checkin-extend-ui.ts`, `arbiter-flag-cards.tsx`, `arbiter-decision.ts`, `arbiter-camera.ts`, `arbiter-watch.ts`), moved under `components/v2/match-day/` where they are only Match Day's.
- The old address answers a permanent redirect to Match Day with `?board=` when a fixture was named, so a bookmark or a mailed link still lands.
- The division Fixtures tab's entry card becomes "Open Match Day" with the round's status line it carries today ("2 boards need a decision"); the run sheet's "Review in arbiter panel" chips open Match Day on the board. The Needs you rows that said "in the arbiter panel" say "in Match Day".
- The one door (`arbiterPanelOffered`) is kept as the rule for the organizer parts, renamed to say what it gates.

## 9. The capacity plans

Plan 3 is re-targeted; plans 1 and 2 are unchanged.

- Keep Tasks 1, 2 and 3 as written (participant lifetime and the floor, per-meeting chains and token memory, presence and camera in the loader).
- Replace Tasks 4 to 6 (the grid, its e2e, the spike) with this design's panels: the board panel joins exactly two meetings, so no ceiling and no spike are needed; `ARBITER_GRID_*` constants and `EXTERNAL_PLAY_ARBITER_GRID` never exist.
- Task 7 (the final load run and the Redis decision) stays, with two Match Day pages open on boards during kickoff in place of two grids.

## 10. Rollout

1. Server: the view's `online_rounds` and the two Needs you kinds, behind nothing (additive).
2. The list rows and the two panels, with the chess board and the decisions, behind `MATCH_DAY_ONLINE=1`; the arbiter page still live.
3. Cameras in the board panel (after plan 3 Tasks 1 to 3).
4. Links moved, the redirect, the arbiter page removed, the flag removed. One release, so no day has two homes.

## 11. Left to the builder

- Component breakdown under `components/v2/match-day/` (`board-row`, `board-focus`, `round-row`, `round-focus`, the board renderer wrapper around the match room's board).
- The exact `MatchDayOnlineRound` shape and how `getMatchDay` reads it in its tenant transaction beside the sealed tables the loader reads on the privileged client (the arbiter page reads them after `requireDivisionPage`; Match Day must prove the competition first, then read).
- The placement rule's SQL or in-memory fold for rounds among the court groups.
- Dictionary keys for every new word, in four locales; the counts line's board noun.
- Test strategy: the list order and the focus resolution are pure (`lib/match-day/view.ts` tests); the panels' words from the loader's facts are unit cases; the e2e replaces the arbiter spec's walkthrough with the same flow on Match Day (open a round from the round panel, seats arrive, a board shows its cameras' words with the fixture vendor, a flag is reviewed, a result is settled), at 1280, 768 and 320.

## 12. Calls I made

- The round is a row at the head of its boards and its controls live in its focus panel, not in the header: the header stays exactly Match Day's.
- Cameras show by default when the division requires them, the chess board otherwise, with a Cameras / Board switch where both exist.
- Both sides' cameras join together for the board in focus; the White/Black switch is gone with the single-camera pane.
- Held and flagged boards are two per-board attention kinds produced with the desk's, replacing the division-level fold of an online hold; they show to every editor, flag or not, because a decision finishes play.
- Held and flagged boards from earlier rounds are listed under their division in a "Needs a decision" sub-group, so every Needs you row and every `?board=` resolves to a row.
- The online rounds are a third block after the courts, grouped among themselves, one row per (division, stage, round); the court list is untouched.
- A round opened today, or with a live window or a game on file, makes the day a match day; a round paired and not opened does not.
- The poll carries the list's facts for every board; the board in focus reads its position and flag cards through its own read.
- An organizer who plays on a board does not see that board listed, as today; the server routes are not changed.
- The organizer parts follow the join route's own role set (`EDITOR_ROLES`), never a wider `canEdit`.
- The old arbiter address redirects rather than 404s.
- The organizer-only parts are gated by the existing one door (edit rights, online play, the online-chess flag); the rows, state and the decisions that finish play are not.

## Amended 2026-11-17 (owner rulings, after re-pinning the plan against main c788c6a5f9)

- A cancelled board is listed only while it has an open flag, under "Needs a decision"; it leaves the list once the flag is settled.
- The division page's Held | Flagged queue stays beside Match Day: same data, same actions, one source. Match Day is the primary entry.
- The Match Day code's day read (the capture phone) leaves online divisions out.
- Online boards follow Match Day's billing-freeze rule; one rule for in-hall and online.
