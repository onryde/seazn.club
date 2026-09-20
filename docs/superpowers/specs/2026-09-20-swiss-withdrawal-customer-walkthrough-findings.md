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

### F5 — LOW: six empty rows in the standings table body

`tbody` holds twelve `<tr>`: the six real rows followed by six empty ones. Dead
vertical space, worst on a phone.

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
