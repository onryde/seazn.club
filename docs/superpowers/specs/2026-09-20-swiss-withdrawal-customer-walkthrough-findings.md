# Swiss withdrawal — customer walkthrough findings

**Date:** 2026-09-20. **Branch:** `feat/swiss-withdrawal-reconcile` (PR #813).
**Method:** drove the real product in a browser against the `sw1` prod bundle
(`localhost:3331`) as a **fresh account** — new magic-link sign-in, onboarding,
competition and division created through the wizard, no seeded state and no
admin shortcuts. Entrant bulk-add and match scoring went through the product's
own v1 API from inside the signed-in session, the same split the repo's own
journeys use.

Everything below is what was SEEN on screen or read out of a live response.
Nothing here is inferred from the code.

## The path driven

Sign in → onboarding → create competition ("Swiss Verify Cup") → create
division ("Open Swiss", badminton/bwf, Swiss format) → 1 entrant through the
panel + 5 through the API → **Start tournament** (dialog confirmed) → 15 shells
minted (5 rounds × 3 boards) → **Pair next round** (R1 seated) → R1 played out
(3 walkovers) → **withdraw Ada** through the entrants table and its confirm
dialog → **Pair next round** again.

## The fix works, in the product

Pairing after the withdrawal returned **"Generated 3 fixture(s) (0 already
existed)"**. Before this branch that press threw `swiss shell count mismatch
for pairing`.

The reconciled round is correct on inspection of the live rows: R2 became two
seated boards plus `sw-r2-bye` (award), R1's played rows untouched, total
fixtures still 15. Ada's only remaining fixture is her decided R1 match. The
four active entrants are on the two boards and Fermi holds the bye.

Rounds 3–5 stayed at three boards each for a five-player field — the LAZY scope
the design specifies, now confirmed customer-visible as surplus TBD rows in
later rounds. Noted for the owner as an accepted trade, not a defect.

Widths: no horizontal page scroll at 320, 768 or 1280 on either the fixtures or
the standings tab. The division tab rail overflows at 320 but is
`overflow-x: auto` with focusable links inside, so it is the reachable kind and
axe-clean (checked, not assumed).

## Findings

### F1 — HIGH: a normal withdrawal raises a false "fixtures don't match the roster" alarm, and offers to rebuild a live tournament

Immediately after the withdrawal, the stage card shows:

> **Fixtures don't match the roster**
> No longer active, still on a fixture: Ada
> [ Rebuild fixtures ]

Ada's ONLY fixture is `sw-r1-b1`, status `forfeited` — a decided, played match
whose result is supposed to stand. This is the correct post-withdrawal state,
and the banner calls it a mismatch. The remedy offered is destructive, on a
running event, in the one moment the organiser has just been told something is
wrong.

It lands on exactly the path this PR repairs: the organiser presses Pair next,
it now works, and the screen immediately tells them their fixtures are broken
anyway. Worst case is an organiser who believes the warning and rebuilds.

**Recommendation:** the drift check must ignore entrants who appear only on
DECIDED / played fixtures. A withdrawn entrant's settled results are the
intended end state, not drift.

### F2 — HIGH: a withdrawn entrant stays in the standings, ranked, unmarked, in public

Read from the live console table and confirmed against the public endpoint:

| | value |
| --- | --- |
| Ada's entrant status | `withdrawn` |
| Ada in console standings | rank **4**, P 1, W 1, **2 pts** |
| Ada in PUBLIC standings | rank **4**, 2 pts, `played: 1` |
| Any withdrawn marker in the DOM | none — row classes identical to active rows |
| `status` key on a standings row | **absent entirely** |

The row object is `{won, lost, rank, drawn, played, points, metrics, tieBreak,
entrantId, tieUnbroken}` — there is no field a consumer could use to mark her,
so this cannot be fixed in the table component alone.

It also contradicts the product's own withdrawal copy, which promises: *"if
they've played less than half their games, everything they played is voided
(standings read as if they never entered)"*. Ada played 1 of 5 rounds — less
than half — and her result stands and still scores.

**Recommendation:** decide which of the two is true, then make them agree. As
product owner I would carry the row (spectators who watched R1 should still see
what happened) and mark it — add a status to the standings row and render a
"withdrawn" treatment — rather than void real results. But the copy promising
the void is currently the only statement of record, so this needs an owner call
before either side moves.

### F3 — MEDIUM: the start dialog states something false

The confirmation says, unconditionally:

> The format is already locked — fixtures exist.

It was shown on a division where the page BEHIND the dialog read *"No fixtures
yet — generate them when entrants are registered"* and offered a **Generate
fixtures** button. On the quick-start path, start is what generates; at the
moment the dialog renders, the format is not locked and no fixtures exist.

This is in the dialog shipped earlier today (#804) — the line is unconditional
in copy but conditional in fact.

**Recommendation:** gate the line on fixtures actually existing, the same way
the entrants line is already gated on the stage kinds. Four locales.

### F4 — MEDIUM: the Add entrant form stays fully live on a started tournament

The start dialog promises *"Entrant list closes … no one new can be added."*
The entrants tab then renders the complete Add entrant form — Kind, Name, Seed,
Player search, an enabled **Add entrant** button and **Import CSV**.

Driven: filling a name and pressing Add entrant produces a server refusal,
*"This tournament has started — the entrant list is locked. Withdrawing
entrants still works."* Nothing is added, nothing is corrupted — but the
product invites the organiser into a failure it already knows about, seconds
after telling them it would not be possible.

Secondary: that refusal is server copy surfaced verbatim to the user in
English. Whether API error strings are in scope for the 4-locale rule is an
open question, not decided here.

**Recommendation:** hide or disable the form once the list is locked and show
the existing explanatory line in its place — that line already renders on the
page.

### F5 — RETRACTED 2026-09-21, this finding was WRONG

~~Six empty rows in the standings table body.~~ **Withdrawn.** The standings
table has exactly six rows and none of them is empty.

The claim came from a whole-page `table tbody tr` sweep that counted a SECOND
table: the head-to-head **Results grid**, which sits inside a collapsed
`<details>`. `innerText` returns `""` for content inside a closed `<details>`,
so its six real rows read as blank. Forcing `details.open = true` gives six rows,
zero empty, with real content (`"CU Curie — · 0 — 0 · · ·"`). There is no padding
loop in the code either — `standings-table.tsx`'s `<tbody>` contains only
`ranked.map`.

This is the repo's own rule biting the person who wrote it down: a query showed
what exists and I asserted a property of it — here, that its rows were empty —
without opening the thing I was measuring. Left in place rather than deleted so
the next reader sees the retraction, not a gap.

### F6 — LOW: the destructive action is the primary button

On a Swiss stage that has paired nothing, **Complete stage** renders as the
filled primary while **Pair next round** is an outline secondary. The primary
should be the action the organiser wants next; completing a stage with nothing
played is the one to make them reach for.

### F7 — LOW: two names for one action

The empty-state text reads *"Swiss pairs one round at a time. Generate the next
round to pair them."* while the button is labelled **Pair next round**.

### F8 — LOW, unrelated: five of eleven onboarding sport tiles have no icon

Carrom, Generic, Hockey, Ice Hockey and Tennis render a generic medal emoji
where Badminton, Board game, Cricket, Football and Table Tennis have real
sport icons. First screen a new customer sees.

## What this means for the programme

F2 belongs in Wave 1 beside Tasks 1.1–1.3 — it is a standings-points defect of
the same family, and it is the one a spectator sees. It also strengthens the
case for Wave 0 Tasks 0.6/0.7: a test that asserted standings POINTS on a
division with a withdrawal would have caught it, and no such test exists.

F1 is arguably the most urgent thing found, because it actively pushes the
organiser toward a destructive recovery on a live event, and it is reachable
from the most ordinary interruption a tournament has.

None of F1–F8 is caused by this PR. F3 is caused by the PR merged earlier today.

## F9 — MEDIUM: an open tie-break tooltip is painted over by the rows below it

Added 2026-09-21 from a screenshot of the live standings table: with a
tie-break popover open, the NEXT row's rank chip punches through its left edge
and the row after that covers its bottom-left corner, over the first words of
the explanation.

Measured with `elementFromPoint` on rows 1, 3 and 4 before and after: the
left edge returned the next row's rank `SPAN`, the bottom-left its `TD`, while
the centre was clear. Every sticky rank cell is `z-10` and the popover is also
`z-10` INSIDE one of them, so the comparison happens between the two cells'
stacking contexts and the later row wins on DOM order. Raising the cell that
holds an open `<details>` is the fix; raising the tooltip cannot work.

## F10 — HIGH, new: the PUBLIC standings print a raw UUID where a withdrawn entrant's name belongs

Found 2026-09-21 while verifying the F2 chip on the live page (`/shared/
my-organization-9/swiss-verify-cup/open-swiss`, prod bundle). Row 4 of the
public table reads:

> 4 * ?f8001cf4-f592-4b5e-a77c-c94520efed0f 1 1 0 0 0 2

`public_entrants_v` filters `status in ('registered','confirmed')`, so a
withdrawn entrant never reaches the public page's `entrants` at all. The
STANDINGS SNAPSHOT still carries her row — it is keyed by entrant id and is
built from results, not from the roster — so `entrantNames` has no entry, and
the table falls back to printing the id.

Two consequences, one cause:

1. A spectator sees an internal UUID in a results table.
2. F2's chip cannot reach the public page or the embed. Wiring it there was
   tried and REMOVED in the same session rather than shipped inert — the prop
   would have been passed an always-empty array.

**Recommendation (mine, as product owner — not an owner ruling).** Widen
`public_entrants_v` to carry withdrawn entrants, keeping every masking rule it
already applies, and make the consumers that mean "the current field" — the
entrants tab, the kiosk, the ICS and poster exports — filter status themselves.
That is one migration plus a consumer audit, and it closes the UUID and the
missing chip together. It is deliberately NOT in this branch: a public data
view with five consumers is not a line to slip into a polish PR.

## F11 — MEDIUM, new: the LAST row's tie-break popover is clipped away entirely

Also found 2026-09-21, after F9's fix was in, by opening every row's popover in
turn and hit-testing it. Rows 1–5 were clean; row 6's tooltip returned the
section BELOW the table at five of six probe points.

Not the same cause as F9. The table sits in `relative overflow-x-auto`, and a
box with `overflow-x: auto` computes `overflow-y: auto` as well, so the final
row's popover is CLIPPED by the container rather than painted over: measured
tooltip bottom 704 against a container bottom of 679, at 1280. Clipping happens
before stacking, so no z-index can reach it.

**Fixed here:** the last row opens its popover upward (`[tr:last-child_&]`),
inside the same box, where F9's raise then wins.

## Disposition (2026-09-21, branch `fix/swiss-desk-polish`)

| | verdict |
| --- | --- |
| F1 | FIXED — `getStageRosterDrift` now reads a second, status-narrowed fixture set for `ghosts`; `unplaced` keeps the unfiltered one |
| F2 | PARTLY FIXED — the row is carried and MARKED ("Withdrawn" chip) on the console, public and embed tables. The two open questions below stay open |
| F3 | FIXED in #813 (merged) |
| F4 | FIXED — the Add-entrant form is replaced by the explanatory line once the list is locked |
| F5 | RETRACTED — the finding was wrong (see above) |
| F6 | FIXED — the primary follows "whatever still has work to do" |
| F7 | FIXED — the empty-state text now names the button it points at |
| F8 | OPEN — owner's call, unrelated to this programme |
| F9 | FIXED — the sticky rank cell is raised while its `<details>` is open |
| F10 | OPEN — public UUID + unreachable chip; needs the `public_entrants_v` widening above |
| F11 | FIXED — the last row's popover opens upward |

### Still owed, deliberately not done here

- **Whether a withdrawn entrant should be EXCLUDED from the ranking** rather
  than ranked and marked. This is the owner's call, not a defect fix: it
  changes what every other entrant's rank means. The chip does not decide it.
- **The withdrawal copy still promises a void** ("if they've played less than
  half their games, everything they played is voided"). In Swiss the
  denominator is undefined — pairing is lazy, so an entrant on one fixture has
  played 1 of 1 — and the product's behaviour (results stand) is the defensible
  one. The copy is what should move, and it moves with the ruling above.
- **The public and embed tables are NOT marked** — see F10. The prop exists on
  the component and the console page passes it; the public pages deliberately
  pass nothing, because the data cannot reach them yet.
- **`StandingsTableView`** (the competition hub's own table,
  `matches-hub/{table,overview}-tab.tsx`) is NOT marked. It renders from a
  server-built `TableViewT` rather than raw rows, so marking a withdrawal there
  means extending that view type and its builder — a spectator-surface change.

