# Findings: driving the scheduling journeys by hand

Task 0 of the scheduling-walkthrough wave. Owner's ruling 2026-09-03: **drive it
by hand first, then codify.** This document exists so that a defect found on
screen is recorded as a finding rather than frozen into a spec as expected
behaviour.

**Everything below was seen on a screen.** Where a claim needed a second
source (a row in the database, a computed style, a control's `disabled`
property) that source is named. Three things I believed after reading a
screenshot turned out to be false when I checked them properly; they are
recorded in §W as withdrawn rather than quietly dropped, because two of them
would have become assertions in Task 4.

## How it was driven

| | |
|---|---|
| Build | prod standalone (`output: standalone`), `seazn-env up --label schedwt --server` |
| App | `http://localhost:3313`, built from this worktree (`required-server-files.json` → `appDir` = `.claude/worktrees/sched-walkthrough/apps/web`) |
| Database | `postgresql://…@127.0.0.1:54750/seazn_schedwt`, `data_directory` = `/tmp/seazn-env/schedwt/pg` (verified ours) |
| Placement | CP-SAT native on `:50625`. **Confirmed live, not the greedy fallback** — every solve's provenance strip reads `Solver · N.Ns`, e.g. `Solver · 11.3s · nothing moved` |
| Browser | Chromium via Playwright, real clicks/typing. Widths 1280, 768, 320 |
| Locale | `en` throughout except §S12, which sets `seazn_locale=fr` |
| Data | org "My organization", competition "Autumn Fixtures swt1", division "Open Singles" (badminton/bwf), 6 entrants, 1 league stage → 15 fixtures, 2 venues × 2 courts |

Screenshots (29) and the raw control-set dumps are at
`/private/tmp/claude-501/-Users-ashokhein-github-seazn-club/2004869c-1c0d-4e71-a04a-0fcf6bbacb8a/scratchpad/shots/`.
They are **not** committed: the `docs/` tree tracks zero images today and the
repo root `.gitignore` carries `/*.png` precisely to stop session screenshots
landing in the tree. Filenames are cited per finding.

Both journeys were completed. The organiser day ran end to end through to
"Tournament started — scoring is open." The officials handoff ran end to end
except its auto-draft apply step, which cannot be pressed (§S4).

---

## Severity summary

| # | Finding | Severity |
|---|---|---|
| S1 | Minimum rest has two homes; the solver and the conflict checker read different ones | **Critical** |
| S2 | Clear schedule wipes a frozen board and tells the organiser nothing (F1, customer half) | **Critical** |
| S3 | Restoring a save point also edits a frozen board | **Critical** |
| S4 | Officials auto-draft: "Apply 6 assignments" is permanently disabled | High |
| S5 | The board grid renders local time; every other scheduling surface declares UTC | High |
| S6 | An official's own assignment list names the wrong venue | High |
| S7 | The auto-draft prints internal diagnostics, including an internal doc citation, to the organiser | High |
| S8 | The capacity card contradicts itself in adjacent lines | Medium-High |
| S9 | The capacity card ignores the live play-hours window while honouring every other live field | Medium |
| S10 | A required court tag that matches no court saves with a success toast | Medium |
| S11 | Typing a number then clicking a toggle silently discards the toggle | Medium-High |
| S12 | F2 confirmed: the Danger zone is hardcoded English — and so is much more | Medium |
| S13 | At 320 the officials ASSIGN control is 60% off-screen in a keyboard-unreachable rail | Medium |
| S14 | The six-tab console is a groomed shrink — identical control sets at 320/768/1280 | **Escalation** |
| S15 | An invited official's first sign-in lands on organiser onboarding and mints them an org | Medium |
| S16 | The claim link is not a link, is truncated, and is "shown once" | Medium |
| S17 | Assigning an official on a day they blocked is signalled by a hover-only glyph | Medium |
| S18 | With nothing scheduled the run sheet shows five empty round headers | Low |
| S19 | "Start tournament" is irreversible and has no confirmation | Low-Medium |
| S20 | Four of the six tabs, and the whole directory, carry zero `data-testid` | Informational |
| S21 | Court-picker checkboxes have duplicate accessible names and are 13 × 13 px | Low-Medium |
| S22 | Clear reports no counts — neither cleared nor skipped | Low |

---

## S1 — Minimum rest has two homes, and the two halves of the product disagree about which one is real

**Critical.**

The Settings tab has "Minimum rest per entrant (minutes)". The Constraints tab
has "Minimum rest", with its own editable number box. They are stored as two
separate fields in one JSON document:

```
config.perEntrantMinRest      = 30      ← Settings tab
config.constraints.restMin    = 35      ← Constraints tab
```

The Constraints tab's own header says *"Auto-schedule and AI Schedule both obey
these; matches you place by hand are checked against them too."*

They do not both obey these. Driven:

1. Settings = 30, Constraints = 35. Auto-schedule. The strip reports
   **"Optimised … SCHEDULED 15 / 15"** — and the toolbar immediately grows a
   **"⚠ 32 conflicts"** pill. Opening it lists, 32 times,
   *"rest — There isn't enough rest between matches for a team or player."*
   The observed rest between an entrant's consecutive matches is **30 minutes**
   (14:00→14:40, next start 15:10). The solver produced 30; the checker wanted
   35. (`swt-1280-15-conflicts-open.png`)
2. Constraints raised to **180**, auto-schedule re-run. Every rest is still
   **30 minutes**. A three-hour rest rule changed the arrangement but produced
   nothing like three hours of rest.
3. Constraints lowered to **30**, *without re-solving*. All 32 conflicts
   **vanish**. Same board, same fixtures, no new solve.

Step 3 is the decisive one. The conflict checker reads `constraints.restMin`.
The solver reads `perEntrantMinRest`. Neither surface says so.

**What the customer loses.** An organiser who sets a minimum rest on the tab
that says the auto-scheduler obeys it gets a schedule that does not obey it,
and is then shown 32 warnings by the same product for a board it just produced
and called "Optimised". The obvious repairs — press Auto-schedule again, press
Improve times — cannot help, because the value the solver reads was never
changed. The only escape is to discover a second field on a different tab.

There is also a quiet variant with a worse ending: leave Constraints at its
default **0** and set Settings to 30, and the Constraints tab displays "0" in a
box labelled Minimum rest while a warning beside it says entrants will rest at
least 30 min. Zero warnings are raised, because the checker's threshold is 0.
The organiser reading the Constraints tab believes the rest rule is off.
(`swt-1280-09-constraints.png`)

**Blast radius.** Every division. It is not sport-specific and not
format-specific — it is a property of the schedule-settings document that both
the board's conflict pass and the solver read. It also reaches the AI console,
which the Constraints tab claims to govern; I did not drive the AI path, so
that is a claim to check, not a finding.

**Recommendation.** One authority per fact. Delete the Constraints-tab
Minimum rest input and leave a read-only line there that names the Settings
value and links to it — the pattern the tab already half-implements with its
"set by minimum rest per entrant, on the Settings tab" sentence. Then make the
conflict checker read the same field the solver reads, so that a board the
solver called optimal is never immediately flagged by its own checker.

**Strongest argument against.** Two fields may be deliberate: a *hard floor*
the solver must respect and a *soft target* the checker warns against, which is
a legitimate design if a tournament wants "aim for 45, never below 30". If that
is the intent, the fix is not deletion but labelling — the two boxes must say
"never less than" and "prefer at least", and the conflict copy must say which
number it is measuring against and what it saw. Deleting one field would then
remove a real capability. This is a product decision, and I would put it to the
owner before either wave assumes the answer.

---

## S2 — Clear schedule wipes a frozen board, and the organiser is told nothing

**Critical.** This is F1's customer-visible half. Task 1 has separately
confirmed the server behaviour against a live database; what follows is only
what a person sees.

Sequence, all in a browser:

1. Board tab → **Freeze schedule**. The pill becomes **"🔒 Frozen — unfreeze"**
   and a green banner appears: **"Schedule frozen — all edits are blocked until
   you unfreeze."** (`swt-1280-17-frozen-bar.png`) `divisions.schedule_locked`
   is `true`. Board holds 15 scheduled fixtures.
2. History tab. The freeze is visible here only as a ticked "Freeze whole
   schedule" checkbox in the top right — which reads as a control, not a
   warning. The **Danger zone** below is unchanged from its unfrozen state:
   the **"Clear schedule…"** button is fully enabled, styled as a live
   destructive action, with **no disabled state, no lock icon, no reason text,
   and no mention of the freeze**. (`swt-1280-19-history-frozen.png`)
3. Press it. The confirm dialog is **word-for-word identical** to the unfrozen
   one: *"Clear unlocked slots? — Every unlocked timetable slot in this
   division is cleared. Locked slots and results stay."* Not one word about the
   freeze.
4. Press **Clear slots**. Fixtures scheduled: **15 → 0**.
   `schedule_locked` is still `true`. (`swt-1280-20-f1-cleared-while-frozen.png`,
   `swt-1280-21-board-empty-still-frozen.png`)
5. **The organiser is told nothing.** No error, no warning, no toast. The only
   feedback is a new row in Recent edits — **"#7 Schedule cleared"** — i.e. the
   product reports it as an ordinary, successful edit.

The contrast on the same division makes it worse rather than better. Pressing
**Auto-schedule** while frozen is refused, loudly and correctly, with a red
banner reading *"the division schedule is locked — unlock it to edit"*.
**Undo** is refused the same way. So the organiser has already been taught that
this product enforces the freeze.

**What the customer loses.** An organiser freezes a published timetable
precisely so it cannot move — teams have it, the .ics feed has it, it has been
printed. One button, whose dialog promises only to clear "unlocked" slots,
removes every slot. Nothing warns them before, and nothing tells them after
that they have done something the freeze existed to prevent.

**Blast radius.** Every frozen division. The window is the whole period between
freezing and the tournament starting, which is exactly the period in which a
frozen schedule matters. Recovery exists — the History panel's undo and save
points — but only if the organiser realises what happened, and the UI gives
them no reason to.

**Recommendation.** Two layers, and they must be mutated one at a time or each
is untested behind the other. Server: `clearScheduleScoped` refuses a frozen
division with the same 422 and the same message its four sibling write paths
already use, so all five refuse on identical terms. UI: **disable** the
Danger-zone button when frozen and say why beside it — disabled rather than
hidden, because a vanished control reads as a missing feature while a disabled
one with a reason teaches the organiser that unfreezing is the way back. That
reason string is new user-facing copy and owes all four locales (and see §S12,
which shows the surrounding card owes them already).

**Strongest argument against.** There is a real workflow behind "clear a frozen
board": the schedule is frozen, a venue falls through, and the organiser wants
to wipe and rebuild without first unfreezing — an extra step that also briefly
exposes the board to every other edit path. Making clear the one operation that
works while frozen could be a deliberate escape hatch, in which case the defect
is only that nothing says so. If the owner rules it deliberate, the fix is a
distinct confirm dialog ("This division is frozen. Clearing will remove N slots
anyway — continue?") rather than a refusal. I do not think this is what
happened here, because the dialog is byte-identical to the unfrozen one and
because `restore` behaves the same way (§S3) — two escape hatches nobody
designed is less likely than one guard nobody wrote.

---

## S3 — Restoring a save point also edits a frozen board

**Critical, and not named anywhere in the brief.**

With the division frozen and the board empty (from §S2), I pressed **Restore**
on the save point "before the clear" and confirmed the dialog. All **15 slots
were written back** — every fixture returning to the exact time and court it
held before, byte-identical on a diff — with `schedule_locked` still `true` and
no refusal.

On the same division, in the same panel, minutes apart:

| Operation | Frozen behaviour |
|---|---|
| Auto-schedule | **refused** — red banner, "the division schedule is locked — unlock it to edit" |
| Undo | **refused** — same banner |
| Clear schedule | **allowed**, board wiped, silent |
| Restore save point | **allowed**, 15 slots written, silent |

**What the customer loses.** The same promise as §S2, broken by a second door.
An organiser who freezes a board and then restores an *older* save point
silently replaces the frozen timetable with a stale one — which is worse than
clearing, because the board still looks full and correct.

**Blast radius.** Same as §S2. This matters for the wave's scope: the design
document's production change names `clearScheduleScoped` alone. A fix scoped to
that function leaves restore open, and a test suite that asserts only the clear
path will go green over a live hole.

**Recommendation.** Treat the freeze as a property of the *panel*, not of one
handler: audit every write path reachable from the History tab (clear, restore,
undo, redo, save-point delete) and apply the same guard, then test each one
separately. Widen Task 4's step 12 to cover restore as well as clear.

**Strongest argument against.** Restore is arguably a *recovery* action rather
than an edit, and a frozen board is exactly when you most want to put back what
was there. Blocking restore could strand an organiser who froze a board and
then discovered it was wrong. The counter is that undo is equally a recovery
action and is already blocked, so today's behaviour is not a considered
position either way — it is simply inconsistent.

---

## S4 — The officials auto-draft produces a proposal that cannot be applied

**High. This is the "inert seam" class: a control that renders, names a real
number, and never fires.**

On the Officials tab, with one linked official on the roster:

- **Propose** works. It returns a real result: the button beside it becomes
  **"Apply 6 assignments"**, and nine red rows explain the unfilled slots.
- **"Apply 6 assignments" is `disabled`.** Not styled-disabled — the DOM
  property is `true`. It carries no `title`, no `aria-label`, no
  `aria-disabled`, and there is no message anywhere on the page explaining why.
  (`swt-1280-24-officials-propose-diagnostics.png`)

I eliminated the obvious causes rather than guessing:

- Not the freeze. Unfroze the division (`schedule_locked` → `false`), re-ran
  Propose, got the same "Apply 6 assignments", still disabled.
- Not the division being live/published, and not a permissions or entitlement
  wall: **manual assignment through the per-fixture `<select>` on the same page
  works**, writing a real `fixture_officials` row.

So on a Pro Plus org, on an unfrozen division, with a linked official and a
valid six-assignment proposal, the apply step of the officials auto-draft
cannot be reached from the browser at all. I did not determine the cause;
that is for the fix, and I decline to guess at it here.

**What the customer loses.** The entire value of auto-assignment. The feature
is visible, it runs, it reports what it would do — and the organiser must then
do all of it by hand through fifteen dropdowns. Worse, they have been shown
that the product *could* have done it.

**Blast radius.** Every organiser using officials auto-draft. The existing
`officials-directory.spec.ts` asserts the manual `<select>` is *visible* and
stops there, so nothing in the suite has ever pressed Apply — which is exactly
how a seam stays inert through a green suite.

**Recommendation.** Find the predicate that disables the button and fix it, and
make Task 5 drive **propose → apply → read the resulting assignments back**, so
the seam is proven by its real producer and consumer rather than by a fixture
at both ends. Until it applies, that step of the design's journey cannot be
written as a passing assertion; it should be written as the failing test that
the fix makes green.

**Strongest argument against.** The button may be correctly disabled for a
reason I did not eliminate — a per-role requirement, a minimum roster size,
a stage-status precondition. If so, the finding shrinks to "the disabled state
has no explanation", which is still real but much cheaper. Either way the
product owes the organiser a sentence.

---

## S5 — The board grid shows local time; every other scheduling surface declares UTC

**High.**

`schedule_settings.tz` is `"UTC"`. The Settings tab, the Constraints tab and
the division run sheet all print **"Times shown in UTC"**, and the run sheet
labels each row explicitly, e.g. *"Scheduled · Sep 21, 2026, 2:00 PM UTC"*.

The board grid puts that same fixture on the **15:00** row. The browser's
timezone is Europe/London (BST, UTC+1). The board renders local time, and the
board tab carries **no timezone caption at all**.

The Officials tab is in the same state: its KICK-OFF column reads
**"Mon, Sep 21, 03:00 PM"** with no suffix, for a fixture the run sheet calls
2:00 PM UTC.

The official's own `/me` page is the one surface that gets it right, and it
does so by printing both: **"21 Sept 2026, 14:00 UTC ↳ 15:00 BST"**.
(`swt-1280-25-official-assignments-venue.png`)

**What the customer loses.** An organiser sets play hours 09:00–17:00 on a tab
that says UTC, then looks at a board whose rows are an hour later, and the two
never reconcile. The blackout they entered as 09:00–13:00 appears as a band
ending at 14:00. Nothing on the board tells them which clock they are reading.
For a tournament run in a single timezone by one person this is invisible; for
an organiser in a different zone from the venue, or a competition spanning a
DST boundary, it is the kind of error that puts people at a court an hour late.

**Blast radius.** Every board view for any org whose viewer is not on UTC.
It is a display-layer divergence, not a data one — the stored times are correct
and the .ics/run-sheet output is correct.

**Recommendation.** Pick one clock for the scheduling console and caption every
surface with it. Given that the settings the organiser *types* are UTC and the
run sheet already says so, the cheapest coherent answer is to render the board
in the division's `tz` and caption it, matching the sibling tabs. If local time
is wanted on the board, then `/me`'s dual-print is the pattern to copy, not a
silent switch.

**Strongest argument against.** Showing an organiser their own wall-clock time
is genuinely friendlier than making them do arithmetic, and `/me` shows the
product already believes that. The real defect may be narrower: the board is
right and the *captions* on the other tabs are the lie. That would make this a
copy fix rather than a rendering one — but it is still a fix, because today no
single screen tells the truth about all the others.

---

## S6 — An official's assignment list names the wrong venue

**High.**

`/me` renders each assignment as a breadcrumb:
`competition · division · organisation · venue · court`. For the fixture
"Ada Lovelace vs Fay Oduya" it reads:

> Autumn Fixtures swt1 · Open Singles · My organization · **Northside Annexe** · **Court 1 (Riverside Hall)**

The line contradicts itself: the venue slot says Northside Annexe and the
court's own venue qualifier says Riverside Hall. The database agrees with the
court: that fixture is on Court 1, **Riverside Hall**. The second assignment on
the same page — genuinely at Northside Annexe — renders correctly, so both rows
print "Northside Annexe" and only one of them is right.
(`swt-1280-25-official-assignments-venue.png`)

**What the customer loses.** An official is told to go to the wrong building.
This is the single most consequential string on the page for the person reading
it, and it is wrong in a way they cannot detect except by noticing that the
court name disagrees with the venue name three words earlier.

**Blast radius.** Any competition using more than one venue. A single-venue
competition can never show it, which is presumably why it has survived — and
which is also why the walkthrough's fixture should keep two venues.

**Recommendation.** Resolve the venue from the fixture's own court, not from
the division. Task 5 should assert the venue *and* the court on at least one
fixture at each of two venues; a single-venue assertion cannot witness this.

**Strongest argument against.** None on the substance — the line is
self-contradicting on its face. The only argument is about priority: officials
mostly know their own venues, and the court name (which is correct, and
venue-qualified) carries the truth. I would still fix it, because the failure
mode is silent and the reader has no reason to distrust the venue field.

---

## S7 — The auto-draft prints internal diagnostics, including an internal document citation, to the organiser

**High.**

Pressing **Propose** on the Officials tab renders nine red rows, each reading:

> `role_unfilled — 59559085 no eligible official — slot left empty (Jul3/02 §6)`

Three separate leaks in one line: a machine code (`role_unfilled`), an eight-hex
fragment of a fixture id that appears nowhere else in the UI and identifies
nothing to a human, and **a citation of an internal specification document**,
"(Jul3/02 §6)". (`swt-1280-24-officials-propose-diagnostics.png`)

**What the customer loses.** The organiser is shown nine alarming red rows and
cannot act on any of them: they cannot tell which fixtures are affected, and
the one piece of the message that looks authoritative is a reference to a
document they will never see. The actual, useful content — "you have one
official and eight matches on Sep 21 that they said they can't work" — is not
said anywhere.

**Blast radius.** Every propose that cannot fill a slot, which on a thin roster
is most of them. This is also the first thing a new organiser sees when they
try the feature.

**Recommendation.** Render these as human sentences naming the fixture the way
the rest of the page does ("Ada Lovelace vs Fay Oduya — no available official
for Referee"), and delete the doc citation. Note the standing repo rule that
engine comments citing "doc 14" point at a document that does not exist; this
is the same habit, but on a customer's screen rather than in a comment.

**Strongest argument against.** The codes are genuinely useful in a support
conversation, and stripping them makes a support ticket harder to diagnose. The
answer is the usual one: show the sentence, keep the code behind a details
disclosure or in the response payload — not both in the same red bar.

---

## S8 — The capacity card contradicts itself in adjacent lines

**Medium-High.**

With three courts, two days, 40-minute matches, a 10-minute gap, a four-hour
blackout, and a per-day cap of 5, the Capacity check renders:

> **Won't fit**
> 15 to place vs **50 available slots**
> 09-21 **23** · 09-22 **27**
> Ways to fix it: Add 1 day · Add 1 court · Raise the daily match cap by 1 · Shorten matches by 5 min · Reduce the gap by 5 min

(`swt-1280-11-capacity-contradiction.png`)

The verdict is computed from the per-day cap (5 × 2 = 10 < 15, so "Won't fit" is
correct). The number printed underneath it, 50, is the court-and-time capacity
with the cap ignored — so the card simultaneously says the schedule will not fit
and that there are more than three times as many slots as matches. The progress
bar and the per-day bars are drawn from the second number too.

The remedy list has its own problem: **"Raise the daily match cap by 1" is the
only remedy with no "Apply" link**, while all four remedies that do *not* address
the binding constraint have one. And the steps are fixed (±1 day, ±1 court,
±5 min) rather than derived from the shortfall — at match length 600 the card
offers "Shorten matches by 5 min" against a deficit of about 120.
(`swt-1280-04-capacity-wontfit.png`)

**What the customer loses.** The card's whole job is to answer "will this fit
before I press Auto". A reader who trusts the big number walks away believing
they have 50 slots for 15 matches; a reader who trusts the badge cannot find out
why, because the numbers on the same card disagree with it.

**Blast radius.** Any division with a per-day cap set. The cap is on the
Constraints tab, so the two are not even on the same screen.

**Recommendation.** Print the number the verdict was computed from. If the cap
is binding, the headline should read "15 to place vs 10 available slots (daily
cap 5 × 2 days)" and the bars should be capped. Give the cap remedy an Apply
like its siblings, and derive every remedy's step from the shortfall.

**Strongest argument against.** "50 available slots" is a true statement about
courts and hours, and some organisers want to see the raw room they have
independently of a self-imposed cap. If so, the card needs two numbers with two
labels, not one number doing both jobs — which is more work than making the
headline follow the verdict.

---

## S9 — The capacity card ignores the live play-hours window while honouring every other live field

**Medium.**

The card recomputes as you type — but not from everything you type. Measured by
changing one field at a time and reading the card without saving:

| Field changed (unsaved) | Card reacts? |
|---|---|
| Match length 40 → 600 | **yes** — 54 slots → 0, "Won't fit" |
| Court unticked in the picker | **yes** — 54 → 36 |
| Play until 17:00 → 10:00 | **no** — stays "Comfortable · 15 to place vs 54 available slots" |

With play hours narrowed to a single hour, the true capacity is 3 courts × 2
days × 1 slot = 6, against 15 matches. The card says 54 and "Comfortable" until
you press Save.

Once saved, the window *is* honoured (54 → the correct figure), and blackouts
are honoured too (50 slots, 09-21 dropping from 27 to 23 for the four-hour
Show Court blackout). So the arithmetic is right; only the live read is
partial.

**What the customer loses.** Widening or narrowing play hours is the most
natural lever to reach for when a schedule does not fit, and it is the one
lever whose effect the pre-flight cannot show. The organiser adjusts, sees no
change, and concludes the lever does nothing.

**Blast radius.** Every use of the settings tab. Low harm (a save corrects it),
but it directly undermines the card's purpose.

**Recommendation.** Feed the card the same live form state it already gets for
match length, gap and courts. A test should pin a *differential*: narrow the
window without saving and assert the number moves.

**Strongest argument against.** Deriving `sessionWindows` from the two
dropdowns plus the date range is more than reading a number out of an input,
and there is a defensible position that a pre-check should describe *saved*
settings rather than a half-typed form. That position is fine — but then the
card must not react to match length either, and today it does. The
inconsistency is the defect, whichever way it is resolved.

---

## S10 — A required court tag that matches no court saves with a success toast; only the solve refuses

**Medium.**

On the run sheet (`?tab=fixtures`), the stage's **Required court tags** editor
is a free-text input. I typed `showcourt` at a time when **no court in the org
carried any tag at all**, pressed Save, and got a green **"Court tags saved."**
No warning, no "0 courts match".

The Capacity check on the settings tab then still read **"Comfortable · 15 to
place vs 54 available slots"** — it is blind to required court tags, so the
pre-flight surface reported a comfortable fit for a stage that could not place
a single match.

The failure appears only at the moment of the solve, where the board is honest
and clear: a red banner, **"No configured court matches the required tags"**,
and nothing placed. (`swt-1280-05-auto-with-impossible-tag.png`)

For completeness: once a court did carry a tag, the same editor **did** offer
"Suggested: + indoor". So the component knows the org's real tag vocabulary and
offers it as a nudge; it simply does not use it as a guard. The venues panel
offers the same suggestions.

**What the customer loses.** A typo in a free-text field silently makes a whole
stage unschedulable, and the two screens an organiser would check before
solving — the tag editor and the capacity card — both say everything is fine.

**Blast radius.** Any stage or round with required court tags. Court tags are
tag-based rather than a count, and the effective set is division ∪ stage ∪
round, so a typo at any one level narrows the whole thing to nothing.

**Recommendation.** On save, count the courts that match and say so — "2 courts
match these tags" or, in red, "No courts match these tags — this stage cannot be
scheduled". Teach the capacity check about required tags so the pre-flight and
the solve agree.

**Strongest argument against.** Free-typed tags are deliberately open: an
organiser may tag courts *after* declaring what a stage needs, and a hard block
would stop a legitimate order of work. That is why the recommendation is a
count and a warning rather than a refusal.

---

## S11 — Typing a number then clicking a toggle silently discards the toggle

**Medium-High — silent data loss.**

The Constraints panel has no Save button; it writes on **blur**. Because a
click on a toggle is also the blur of whatever was focused, the two writes race
and the toggle loses. Reproduced twice:

1. Type `30` into Minimum rest, then click "A player is never in two matches at
   once". Result: `restMin: 30` saved, `crossPersonClash` still `"warn"` —
   the tick was lost. (Clicking the checkbox on its own, with nothing focused,
   works: `crossPersonClash` becomes `"hard"`.)
2. Type `35` into Minimum rest, then click "At least one break between a team's
   matches". Result: `restMin: 35` saved, `noBackToBack` still `false`, **and
   the checkbox visibly snaps back to unticked.**

**What the customer loses.** The organiser sets a number, ticks a safety rule,
watches the tick appear — and it silently reverts. If they do not happen to be
looking at that checkbox at that moment, they run a tournament without the rule
they believe they set. "A player is never in two matches at once" is exactly
such a rule, and its own helper text says that with it off, a double-booking is
only a warning.

**Blast radius.** The whole Constraints panel, on the most natural interaction
order there is: fill a field, then tick the box beneath it.

**Recommendation.** Serialise the panel's writes — queue them, or send the whole
constraints object from a single source of truth so a later write cannot carry
stale neighbours. Whatever the mechanism, the panel also needs a visible
confirmation: today it saves silently, while its siblings say "Scheduling
settings saved." and "Court tags saved."

**Strongest argument against.** A save-on-blur panel with no Save button is a
deliberate, pleasant pattern, and adding a Save button to fix a race would be
the wrong repair. Agreed — the recommendation is to fix the race, not the
pattern.

---

## S12 — F2 confirmed live, and it is wider than F2 says

**Medium.**

With `seazn_locale=fr` and the page demonstrably in French — "État" for the
Health tab, "LES VÔTRES", "1 utilisés", "Restaurer" — the Danger zone renders
entirely in English (`swt-1280-26-f2-french-danger-zone.png`):

> **Danger zone**
> Clears timetable slots only — locked and decided fixtures always survive, and the action is undoable above.
> **Clear schedule…**

The confirm dialog behind that button *is* correctly keyed and comes up fully
French: *"Effacer les créneaux déverrouillés ? … Annuler / Effacer les
créneaux"*. So the two sit side by side, one translated and one not, exactly as
the design predicted.

What the design did not predict is how much else on the same screen is
hardcoded. In French, still English: **five of the six tab labels** (Board,
Settings, Constraints, Officials, History — only Health translates), "History",
"↩ Undo", "↪ Redo", "Freeze whole schedule", "Recent edits", "Save points",
"Save point", and **every** Recent-edits row label — "Schedule applied",
"Schedule cleared", "Schedule restored", "Schedule published", "Division
started", "(not undoable)".

**What the customer loses.** A French organiser gets a French product with an
English control surface on the tab that holds its most destructive action.

**Blast radius.** All four locales, on the schedule console's tab strip — which
means every scheduling screen, not just History.

**Recommendation.** Move the literals to dictionary keys in all four locales,
beside the `confirm.clearSlots.*` keys that already exist. Scope the sweep to
the whole schedule page rather than the Danger zone alone; the tab strip is the
bigger prize and is a two-line change. Remember `i18n-keys.ts` is generated and
needs regenerating.

**Strongest argument against.** Widening the sweep grows the diff on files
three other live programmes are editing, and a wave whose job is walkthroughs
could reasonably fix only what its own journey touches. A defensible middle:
fix the Danger zone now (it is on the critical path for §S2's new reason
string, which owes four locales anyway) and file the tab strip separately.

---

## S13 — At 320 the officials ASSIGN control is 60% off-screen, in a rail a keyboard cannot reach

**Medium.**

Measured at 320px on the Officials tab (`swt-320-02-officials-table.png`):

- The four-column table sits in an `overflow-x: auto` wrapper —
  `scrollWidth` 347 vs `clientWidth` 286. Content is *reachable*, so this is a
  scrolling rail rather than clipped content, and the page-level
  no-horizontal-scroll gate passes. That gate cannot see what follows.
- The **ASSIGN** column header runs from x=285 to x=364 — it *starts* at the
  right edge of the viewport. The first assign `<select>` measures **47 px wide**
  at x=301–348, so roughly **19 px of it is on screen**.
- Entrant names wrap to four lines ("Ada / Lovelace / vs Fay / Oduya") and the
  kick-off wraps to five ("Mon, / Sep / 21, / 03:00 / PM").
- The scrolling wrapper is `class="card scroll-x scroll-x-fade"` with
  **no `tabindex`, no `role` and no `aria-label`** — the
  `scrollable-region-focusable` shape that axe flags at SERIOUS, and a keyboard
  user cannot scroll the rail to reach ASSIGN at all.

**What the customer loses.** The tab's primary action is unusable on a phone —
a 47px dropdown that must display official names, most of it past the edge, and
unreachable by keyboard.

**Blast radius.** Every phone width for the officials tab; the same
`.scroll-x` wrapper pattern is worth auditing on the other tabs' tables.

**Recommendation.** Give the rail `tabindex="0"` plus a role and an accessible
name (unconditionally — `tabindex` cannot be varied by media query). Then
reconsider the row: at phone widths a table with a 47px action column wants to
become a stacked card per fixture, with the assign control full-width beneath
the names.

**Strongest argument against.** A scrolling rail is a sanctioned pattern here
and the content genuinely is reachable by touch, so the accessibility
attributes may be the whole fix and the re-composition may be out of scope for
a walkthrough wave. That is a reasonable split — but the attributes are not
optional.

---

## S14 — ESCALATION: the six-tab console is a groomed shrink

**Not an auto-fail. A question for the design owner.**

I diffed the **visible control set** — membership, order and repeat count, from
the live DOM — at 320, 768 and 1280 across all six tabs. Raw dumps:
`swt-controls-{1280,768,320}.json`.

| Tab | 1280 | 768 | 320 | set identical to 1280? |
|---|---|---|---|---|
| board | 211 | 210 | 210 | differs by one control |
| health | 15 | 15 | 15 | **identical** |
| settings | 29 | 29 | 29 | **identical** |
| constraints | 23 | 23 | 23 | **identical** |
| officials | 30 | 30 | 30 | **identical** |
| history | 16 | 16 | 16 | **identical** |

The single board difference is a `⚠ N conflict` pill whose count changed
between passes — a state artefact, not a responsive branch. No horizontal page
scroll at any width on any tab.

So five of six tabs present **exactly the same controls, in exactly the same
order, at 320 px as at 1280 px**. That is the definition the standing rule
gives for a groomed shrink, and the rule says equal sets at every width is an
escalation to the design owner rather than an automatic failure.

To be fair to what renders: the reflow itself is competent. The tab strip
becomes a horizontal `.scroll-x` rail, the settings two-column grid collapses to
one, the capacity card stacks, and the constraints panel reads well in a single
column (`swt-320-01-settings.png`, `swt-320-03-constraints.png`). Nothing
overlaps and nothing is squashed illegibly — except the officials table (§S13).

**What the customer loses.** Nothing is broken; what is missing is a point of
view about what an organiser needs on a phone. Thirteen actions across six tabs
is a desk task, and the phone version is the desk task at 25% width.

**Blast radius.** The whole scheduling console. This is the largest organiser
surface that has had no phone composition work, at a moment when the scoring
pad and fixture console have just had theirs.

**Recommendation.** Put it to the design owner as a scoping question, not a
defect: does the scheduling console want a phone composition of its own, in the
manner of the 2026-09-02 scorepad work — one DOM, branched with `max-md:*`, an
explicit order, and a defensible answer to "what does an organiser do on a
phone at a tournament?" My own answer would be that the *board* and *officials*
tabs are the two anyone actually opens courtside, and they are the two that
suffer most; settings and constraints are desk work and a plain reflow is
honest for them.

**Strongest argument against.** A scheduling console is desk software. An
organiser builds a timetable sitting down, and a phone composition for
thirteen dense controls could cost a great deal for a use case that barely
exists — while `/admin`-style "functional bar, skip the polish" is already an
accepted stance for staff-facing surfaces. The counter is that the two tabs
named above *are* used courtside, and today they are the worst of the six.

---

## S15 — An invited official's first sign-in lands on organiser onboarding and mints them an organisation

**Medium.**

Signing in for the first time as the invited official (before following the
claim link) lands on `/onboarding`, headed **"WELCOME TO SEAZN CLUB — Create a
competition, add a division for your sport, register entrants — and you're
scoring within minutes"**, with a sport picker. The account is also given its
own organisation, "My organization", and the header renders an org switcher.

Nothing routes the new arrival to their claim, or to `/me`.

**What the customer loses.** A volunteer referee, invited to officiate, is met
by a wizard asking them to run a tournament. The one thing they came to do —
claim their profile — is not offered.

**Blast radius.** Every invited official who signs in before opening the claim
link, which is the normal order when the invite email is what prompted them to
create an account.

**Recommendation.** Carry the claim intent through sign-in and land the user on
the claim page, or at minimum on `/me`. Failing that, the onboarding screen
should offer "I was invited to officiate" as a first-class path.

**Strongest argument against.** A single onboarding for everyone is much
cheaper to maintain, and the claim link still works when they get to it. There
is also a real product reason to leave the door open — some officials do also
run their own club. But the default should follow the invitation.

---

## S16 — The claim link is not a link, is truncated, and is shown once

**Medium.**

After **Send invite**, the directory shows
(`swt-1280-22-claim-link-truncated.png`):

> Email failed to send — share the link below
> **Claim link (shown once)**
> `http://localhost:3313/claim/pc__ij1JSWXUK_rJ…`  [Copy]

Three separate problems:

- The URL is a `<code>` element, **not an anchor** — there is nothing to click.
- It is `truncate`d: 504 px of text in a 318 px box, so the organiser cannot
  read the whole URL on screen. The only route to the full value is the Copy
  button.
- It is labelled "shown once", so if Copy fails — a browser without clipboard
  permission, a locked-down device — the invite is unrecoverable.

This also invalidates a step of the plan: Task 5's journey says the claim link
is to be *"followed from the page that emits it, never constructed"*, by
clicking it. There is no link to click. A spec must read the `<code>`'s text
content or use Copy plus the clipboard.

**What the customer loses.** An organiser whose invite email bounces — which
is the exact case this panel exists for — is handed an unreadable, unclickable,
one-shot URL.

**Blast radius.** Every official invite where mail delivery fails, plus every
local/staging environment (which is all of them, since no mailer is
configured).

**Recommendation.** Render it as a real anchor with the full URL as its `title`,
and make the "shown once" claim survivable — a "regenerate invite" action beside
it, so a lost link is a nuisance rather than a dead end.

**Strongest argument against.** A claim link is a bearer secret and making it
clickable/selectable makes it easier to leak over the organiser's shoulder;
"shown once" is a deliberate security posture. Fair — but then regeneration is
mandatory, because the current design has no recovery at all.

---

## S17 — Assigning an official on a day they blocked is signalled by a hover-only glyph

**Medium.**

The seam itself works well. The official set an unavailable day on `/me`, and
the organiser's assign dropdown correctly labels them **"Nadia Halim —
unavailable"** on all seven fixtures that day, and plain "Nadia Halim" on the
others. That is a real, legible cross-person signal and it should be kept.

What is thin is what happens when the organiser assigns them anyway — which is
allowed, and reasonably so. The only mark on the assigned row is a bare **⚠**
glyph with `title="Marked unavailable on this date"` and **no `aria-label`**.
A hover tooltip is invisible to a screen reader and unavailable on touch.

Worse, the official's own page does not mention it at all. `/me` shows the
21 Sept assignment as an ordinary **"Awaiting your response"** with no clash
warning — while the list of dates she cannot make, containing 21 Sept, is a few
hundred pixels down the same page. I accepted the assignment as her; the
product let me, and `fixture_officials.response` is now `accepted` for a day she
had declared unavailable. (`swt-1280-25-official-assignments-venue.png`)

**What the customer loses.** The blackout the official took the trouble to
enter is honoured by the auto-draft and then quietly dropped at the two moments
that decide whether anyone turns up.

**Blast radius.** Every manual assignment onto a blacked-out day.

**Recommendation.** Give the ⚠ an `aria-label` and a visible text label rather
than a hover-only title, and flag the clash on the official's own card on `/me`
("You marked this day as unavailable") before they can accept.

**Strongest argument against.** Officials often can move a date; a loud clash
warning on `/me` risks nudging a decline where a conversation would have
worked. The counter is that the warning does not have to block — it only has to
be visible before they press Accept.

---

## S18 — With nothing scheduled the run sheet renders five empty round headers

**Low.**

On `?tab=fixtures` with no fixture scheduled, the page shows all 15 matches in
a flat "Not scheduled yet (15)" tray, followed by **five consecutive grey bars
reading ROUND 1 … ROUND 5 with nothing under any of them**
(`swt-1280-07-runsheet-rounds.png`, `swt-1280-08-runsheet-top.png`). The
container holds exactly five children, each a round header and no fixtures.

Once fixtures are scheduled the grouping is correct and useful
("ROUND 1 · Sep 21" with its three matches, "ROUND 3 · Sep 21 – Sep 22", …), so
this is purely an empty-state defect.

**What the customer loses.** The first view of a freshly generated division —
the moment when the organiser is deciding whether generation worked — ends in
five empty bars.

**Recommendation.** Render a round group only when it has scheduled fixtures,
or fold the five into one "Not scheduled yet" heading.

**Strongest argument against.** The empty headers do convey that five rounds
exist, which is information. If that is the intent, they should say so
("Round 1 — no scheduled matches yet") rather than being blank.

---

## S19 — "Start tournament" is irreversible and has no confirmation

**Low-Medium.**

`board-start-division` fires immediately on click. No dialog, no "are you
sure". The response is a toast: *"Tournament started — scoring is open."*

The product knows this action is irreversible and says so elsewhere: the run
sheet carries a standing note, **"Starting locks the setup — once scoring
starts, entrants and format are locked so results stay fair."** The History
tab records it as **"Division started (not undoable)"**.

**What the customer loses.** A misclick on a primary-styled button, sitting
directly beside "Publish schedule" in the same toolbar, permanently locks the
entrant list and format.

**Recommendation.** Confirm it, with the consequence in the dialog — the same
treatment "Clear schedule…" already gets, for an action that is strictly less
recoverable.

**Strongest argument against.** Confirmation fatigue is real, and an organiser
pressing Start on the morning of a tournament does not want a dialog. A softer
option is an undo window rather than a pre-confirmation.

---

## S20 — Four of the six tabs, and the whole directory, carry zero `data-testid`

**Informational — this is Task 3's input, and it is worse than the brief
assumed.**

Measured from the live DOM inside `<main>`:

| Surface | testids present |
|---|---|
| board (`?tab=board`) | `schedule-action-bar`, `schedule-auto`, `schedule-reflow`, `schedule-polish`, `board-ai-schedule`, `board-freeze`, `board-publish-schedule`, `board-start-division`, `board-tray`, `board-tray-mobile`, and after a solve `schedule-result-strip`, `schedule-result-provenance` |
| run sheet (`?tab=fixtures`) | `launch-start-division`, `tz-caption`, `documents-menu-trigger`, `stage-auto-schedule`, `fixture-schedule-toggle`, `stage-court-tags` |
| **settings** | **none** |
| **constraints** | **none** |
| **officials** | **none** |
| **history** | **none** |
| **health** | none observed |
| **/directory (all four tabs)** | **none** |

Everything I drove on those tabs was reached by translated button text,
`aria-label`, or DOM position — all three of which break under a non-default
locale, and the first of which breaks on any copy change. §S12 shows the locale
risk is not hypothetical.

Two specific gaps worth naming for Task 3, because they are accessibility
problems as well as testability ones: the "Add an official" **name field has no
placeholder, no `aria-label` and no wrapping label** — no accessible name at
all; and the blackout editor's "Applies to" `<select>` likewise has no
accessible name.

---

## S21 — Court-picker checkboxes have duplicate accessible names and are 13 × 13 px

**Low-Medium.**

The Settings tab's court multi-picker groups courts under a venue heading, but
the heading is a plain `<p>` — not a `<fieldset>`/`<legend>` or a labelled
group. So with a court called "Court 1" at each of two venues, the accessibility
tree contains **two checkboxes whose accessible name is exactly "Court 1"**,
with nothing to tell them apart. A screen-reader user cannot know which venue
they are ticking, and a test cannot address them by role and name.

Separately, each checkbox measures **13 × 13 CSS px** — well under the 24 px
minimum target size, on a control that is also present unchanged at 320 px
(§S14).

Credit where due: the *selected* list above the pickers gets this right, showing
"Court 1 / Riverside Hall" and "Court 1 / Northside Annexe" with the venue
subtitle appearing only where the name is ambiguous, and dropping it for the
uniquely named "Show Court". The board columns are venue-qualified too
("COURT 1 (RIVERSIDE HALL)"). Only the checkbox list is unqualified.

**Recommendation.** Wrap each venue's list in a `<fieldset>` with the venue as
its `<legend>`, or venue-qualify the checkbox labels the same way the selected
list already does. Raise the hit target.

**Strongest argument against.** The venue name is visible directly above the
list, so a sighted mouse user is never confused, and the fix touches a shared
primitive (`court-multi-picker.tsx`) used elsewhere. The a11y case stands
regardless.

---

## S22 — Clear reports no counts

**Low.**

The clear confirm says *"Every unlocked timetable slot in this division is
cleared"* without saying how many, and after the clear the only feedback is a
"#N Schedule cleared" row. Neither the number cleared nor the number skipped as
locked/decided is ever shown.

This matters to Task 4: the design's step 9 asks the spec to *"assert the
skipped counts match the locked/decided rows"*. **There are no counts in the
UI to assert.** That step must either read them from the API response or be
rewritten.

**Recommendation.** Put the count in the dialog ("This clears 15 slots; 0
locked slots will be kept") and in the confirmation.

---

## W — Premises I believed and then withdrew

The brief is a hypothesis, and so is anything I infer from a screenshot. Each
of these was a claim I was ready to write down before checking it.

**W1 — "The solver places fixtures outside the play-hours window."** Withdrawn.
I read `17:20` starts out of psql against a 09:00–17:00 window and had written
it up as a violation. The `psql` session timezone is **Europe/London**, and
`fixtures.scheduled_at` is `timestamptz` — every timestamp I had dumped was an
hour ahead of UTC. The real start was 16:20 UTC, comfortably inside. *Rule for
the next session: in this repo always dump as
`to_char(scheduled_at at time zone 'UTC', …)`; the bare `to_char` renders in
Europe/London and quietly manufactures an hour.*

**W2 — "The blackout band is mispainted: saved 09:00–13:00, painted
09:30–14:00."** Withdrawn. Once W1 exposed that the board renders in local
time, the saved blackout is 10:00–14:00 BST, and the painted band is exactly
the set of start times whose 40-minute match would overlap it (09:30 is the
first such start; 14:00 the first clean one). The paint is correct. What
*survived* from this investigation is §S5 — the board's clock disagrees with
every caption around it — which is a better finding than the one I started
with.

**W3 — "The blackout disappeared from the board after the refused solve."**
Withdrawn within a minute. I read it off a screenshot; counting
`[data-blackout]` cells found all 27 still present. They had been pushed below
the fold by the error banner and the result card. *A read of a screenshot is
not a measurement.*

**W4 — "The Constraints tab has no minimum-rest control; the design is right
that it lives on Settings."** Withdrawn — it has one, it is editable, it
persists, and it is not what the solver reads. That is §S1, and it is the most
serious thing in this document.

**W5 — "The stage court-tag editor offers no suggestions, which is why a typo
is dangerous."** Withdrawn. It offers "Suggested: + <tag>" as soon as any court
in the org carries a tag; my first attempt simply had a tagless org. The finding
narrowed to §S10: it knows the vocabulary and does not guard on it.

**W6 — F5's "court picker not built yet" (`court-tags-scheduling.spec.ts`'s
`test.fixme`).** Stale. Both the court multi-picker (Settings) and the stage
required-court-tags editor (run sheet) exist and work end to end through the
UI; I drove both. That `test.fixme` can be retired by this wave.

**W7 — Task 5 step 2, "follow the claim link by clicking it."** Not
implementable — see §S16, the link is a `<code>`, not an anchor.

**W8 — The constraint vocabulary in the design.** The design lists six hard
types from `constraints.ts`. What the Constraints *tab* actually writes is
wider: `constraints.hard[{type: "max_fixtures_per_day", count, scope}]` **plus**
flat siblings `restMin`, `noBackToBack`, `fieldFairness`, `parallelism`,
`crossPersonClash`, `startWindows`. Only one of the six named hard types is
reachable from this screen. Task 4's step 3 should assert against what the tab
writes, not against the engine's vocabulary.

**W9 — "The green 'Schedule frozen' banner stands while the division is
frozen."** It is a transient confirmation shown immediately after freezing; it
is gone on the next page load. The standing signals are the "🔒 Frozen —
unfreeze" pill (board) and the ticked "Freeze whole schedule" checkbox
(history). This makes §S2 slightly worse, not better: by the time an organiser
reaches the Danger zone the "all edits are blocked" promise is no longer on
screen anywhere.

---

## What this changes for the later tasks

1. **Task 4 step 12 must cover restore as well as clear** (§S3), and the
   production fix must not be scoped to `clearScheduleScoped` alone.
2. **Task 4 step 9 cannot assert skipped counts from the UI** (§S22).
3. **Task 4 step 3 should assert what the Constraints tab writes**, not the
   engine's six hard types (§W8) — and should pin `restMin` *and*
   `perEntrantMinRest` separately, because they are two facts (§S1).
4. **Task 4 step 6's capacity assertion must be derived**, and should include a
   case where the per-day cap binds, since that is where the card contradicts
   itself (§S8).
5. **Task 5 step 2 cannot click the claim link** (§S16).
6. **Task 5 step 4's apply cannot pass today** (§S4) — write it as the failing
   test the fix makes green, not as a passing assertion.
7. **Task 5 should use two venues and assert the venue on `/me`** (§S6); a
   single-venue fixture cannot witness that defect.
8. **Task 3's testid list should grow** to cover the directory's officials
   panel and the invite flow, and should add accessible names where there are
   none at all (§S20).
9. **§S14 is an owner question**, and should be asked before any phone work is
   scoped into this wave.
