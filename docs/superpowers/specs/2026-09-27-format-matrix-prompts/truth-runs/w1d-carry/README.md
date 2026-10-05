# W1d carry runs: the match-day run sheet, the fold branch, void, forfeit and withdraw in the browser

Task 14 of the W1d CI-truth-run wave (items 15c to 15f; D15, D17). Three
browser-driven set runs on a fresh local environment (own database, standalone
production build baked with `NEXT_PUBLIC_SCOREPAD_HOLD_MS=3000`), at harness
commit `c2f7cf699` (clean: the commit that adds the harness code is the one
every run below records). Synthetic organisations only (`m-<run id>-<n>`).

| Directory | Plan | Run id | Layer | Cases | States | Checks (pass / abstain / fail) | Items | Wall |
|---|---|---|---|---|---|---|---|---|
| `match-day/` | `--set match-day` | `w1d-carry-match-day` | L2 | 2 (`league\|badminton\|bwf\|LIFECYCLE` at 1280 and 320) | works 2 | 48 / 16 / 0 | 636 | 54 s |
| `void-proof/` | `--set void-proof` | `w1d-carry-void-proof` | L2 | 2 (`league\|badminton\|bwf\|VOIDPROOF` at 1280 and 320) | works 2 | 44 / 12 / 0 | 268 | 31 s |
| `carry8-1280/` | `--set carry8-1280` | `w1d-carry-carry8-1280` | L1 | 4 (`league\|generic\|score` and `knockout\|badminton\|bwf`, M1 and R4, 1280) | works 4 | 72 / 42 / 0 | 806 | 101 s |

Each run exited 0, `vacuous: none`, `error reds: none`, and
`matrix:judge faults` compared every case with 0 faults.

One directory and one `plans.lock.json` entry per set invocation. The match-day
and void-proof sets each plan both widths in ONE run, so one `results.json`
holds both cases: splitting it by width would give a frozen plan that names
cases its run does not hold. The directory names are the set names, not the
width-split names the brief's Files list suggested (that list assumed one run
per width).

Command, per set (`<set>` one of the three, the shell exporting the hold value
the server was built with):

    NEXT_PUBLIC_SCOREPAD_HOLD_MS=3000 pnpm matrix:browser --set <set> --run-id w1d-carry-<set> --report-dir <dir>

## What the runs prove

- `runsheet-today-default` (D17, `match-day/`): the division was on its match
  day (four round-1 fixtures dated now, the other 24 undated) when the run
  sheet first loaded. The default filter was read BEFORE the sheet was widened:
  pass, 2 items, at 1280 and at 320.
- `fold-branch` (15d): on the first stage-rail visit of every browser case the
  stage tools were open at 1280 and folded at 320, each on its own side of
  Tailwind `md` (768): pass in every case of all three runs.
- `void-ledger` (6 items) and `void-fold` (3 items) (15e, `void-proof/`): the
  console's "Void last entry" appended one `core.void` naming the last event
  the harness posted, the product's own state was still in play, and the
  engine's fold of the ledger was the score before the event, not the score
  with it. `mixed-driver-coverage` there lists `voidLast` among 10 action
  types, all run in the browser.
- Forfeit (M1) and withdraw (R4) at 1280 (15f, `carry8-1280/`): the four cases
  work with their forfeit and withdrawal checks passing; the abstains are the
  rows' own (no lineup for individual entrants, no applicable stage for the
  swiss, americano and ladder invariants).

## Screens (one line each: what the screen shows)

All pictures are in `evidence/`; each is the run's own full-page capture, uncropped.

- `match-day-1280-today.png`: the Fixtures tab on arrival at 1280. The "Today"
  filter is pressed, one group "Monday, October 5 · 4 fixtures" holds round 1's
  four matches at the same time, a NOW marker closes the group, and the chips
  read Needs result 0, Unscheduled 24, All.
- `match-day-320-today.png`: the same arrival at 320. "Today" pressed, the same
  four rows (time, home name, away name cut to "Matrix P…" or "Matrix …",
  "Round 1 · No scorer yet", Assign scorer), and the stage's action buttons are
  folded behind a "Stage tools" row. That case's `no-horizontal-scroll` check passed over 35 probed states.
- `void-1280-before.png`: the match console for Matrix Player 1 vs Matrix
  Player 2 at 1280, In Play. Header score "1 - 0 · 21-16", pad on game 2 with
  "Games 1-0", chip "Game score recorded — 21-16 / Take back", Activity lists
  #2 Game score recorded and #1 Match started, and the Void last entry button.
- `void-1280-after.png`: the same console after the void. Header "0 - 0", pad on
  game 1 "Games 0-0", chip "Entry undone", Activity shows #3 Entry undone, #2
  struck through with a VOIDED tag, #1 Match started; the sync label reads
  SYNCING… at that moment. Void last entry is still offered.
- `void-320-before.png`: the console at 320 before the void. Header "1 - 0 ·
  21-16", Activity collapsed to its newest row (#2 Game score recorded, Void),
  Void last entry below it.
- `void-320-after.png`: the console at 320 after the void. Header "0 - 0" and
  Activity "#3 Entry undone" are updated; the pad board above still reads
  "Games 1-0" with the "Take back" chip while the label says ALL SYNCED.
- `forfeit-1280-after.png`: the console for Matrix Player 1 vs Matrix Player 8
  after a forfeit by the away side. Pill "Forfeited", "W/O - L", "Matrix
  Player 1 won", Activity #2 Match forfeited and #1 Match started, and the match
  actions now offer Finalize result and Share on WhatsApp.
- `withdrawn-1280-after.png`: the Entrants tab after withdrawing Matrix Player
  3. The row is greyed, its status reads Withdrawn and its action reads
  Reinstate; the other seven rows read Registered with Withdraw.

## Observations (what was seen; not diagnosed here)

- At 320 the run sheet cuts the away name of each row ("Matrix Player 1 vs
  Matrix P…"), so with these synthetic names two rows cannot be told apart by
  their opponent.
- At 320 the `void-320-after.png` capture shows the pad board and the Take back
  chip still on the pre-void state while the header and Activity already show
  the void. The 1280 capture, taken in the same step, shows the board
  reconciled. Whether the 320 capture caught the pad mid-sync was not
  established; the ledger checks (read from the ledger, not the pad) pass.
- After a forfeit the console still offers "Void last entry" and a Void on each
  Activity row (`forfeit-1280-after.png`). The harness never voids a forfeit.
