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

---
---

# Part II — what building the walkthroughs turned up

Part I above is Task 0: one session driving two journeys by hand, before any
code was written. Part II is everything the **rest of the wave** found —
ten tasks, eleven task reviews, three whole-branch review lenses and one
max-effort code review, all of it while turning Part I's journeys into two
executable specs.

The shape of the wave changed underneath it. It was scoped as a walkthrough
wave; the owner then ruled S1 and S3 in, so it also carries a CP-SAT wire fix
and four new server guards. Most of Part II is therefore about things found
**by building on Part I's findings** rather than by driving the product — and
the single most useful section for the next wave is §J, the sixteen briefed
premises that proved false.

**Sources**, all under
`.superpowers/sdd/2026-09-03-scheduling-walkthroughs/`: `progress.md` (the
ledger — every ruling and what it costs if wrong), `code-review-max.md` (20
verified findings, 3 rediscoveries, 5 unverified, one discarded section),
`wb-review-logic.md` / `wb-review-i18n.md` / `wb-review-tests.md`,
`task-4-review.md`, `task-5-review.md`, `task-9-rereview.md`,
`spec-fixes-report.md`, `copy-fix-report.md` and the ten `task-N-report.md`
files.

**What "verified" means below.** Every finding carried into Part II was
confirmed by someone opening the cited source, not by a grep. Where a claim
rests on a mechanism nobody exercised, it says so in the entry. Line numbers
are pinned against this branch (`feat/scheduling-walkthrough`) and are
branch-relative — cite the symbol, not the number, if you carry one elsewhere.

---

## §B — Disposition of Part I and of the design's F1–F5

The design document named five findings, F1–F5, before the wave started. Part I
added S1–S22. Here is where every one of them ended.

| # | Finding | Disposition |
|---|---|---|
| F1 | Clear ignores the freeze | **FIXED** — `clearScheduleScoped` guard (`25773433e`), UI disabled + reason (`ec3ed86dc`), e2e step 12 |
| F2 | Danger zone hardcoded English | **FIXED, and widened** — all nine strings in `history-panel.tsx` plus twelve event labels, 4 locales |
| F3 | Officials assign select never chosen | **FIXED** — Task 5 assigns a named official and reads `fixture_officials` back |
| F4 | No UI has ever created a blackout | **FIXED** — the organiser walkthrough drives the blackout editor, including the court-scoped round trip |
| F5 | Required court tags wholly API-driven | **FIXED** — both writers driven; the stale `test.fixme` in `court-tags-scheduling.spec.ts:276` can be retired (W6) |
| S1 | Minimum rest has two homes | **FIXED, and the mechanism was not what S1 said** — see §J FP12. One line: `build.ts` read the raw field into the CP-SAT wire instead of the shared `restFloor` resolver |
| S2 | Clear wipes a frozen board silently | **FIXED** (= F1) |
| S3 | Restore also edits a frozen board | **FIXED** (`5833243a0`..`e6193c1c2`), and then undo/redo too (`463bdfc27`), after the reason for exempting them turned out to be false (§J FP5) |
| S4 | Officials auto-draft cannot be applied | **NOT FIXED — encoded.** See §E |
| S5 | Board grid shows local time, captions say UTC | **OPEN.** Not scoped; no work done |
| S6 | Official's list names the wrong venue | **OPEN.** Task 5 seeds two venues so a fix is witnessable, but no fix |
| S7 | Auto-draft prints internal diagnostics | **OPEN** |
| S8 | Capacity card contradicts itself | **OPEN.** The organiser walkthrough derives its capacity assertion and includes a binding per-day cap case, so a fix is witnessable |
| S9 | Capacity card ignores live play hours | **OPEN** |
| S10 | Unmatched court tag saves with a success toast | **OPEN** |
| S11 | Typing a number then clicking a toggle discards the toggle | **OPEN.** The walkthrough now pins the commit semantics that make this reproducible (blur commits, checkbox commits instantly) |
| S12 | Danger zone hardcoded English, and wider | **PARTLY FIXED** (= F2). The six tab labels are still raw ids — see §H S31 |
| S13 | Officials ASSIGN control 60% off-screen at 320 | **OPEN.** See §F |
| S14 | Six-tab console is a groomed shrink | **PARTLY RETRACTED.** See §G |
| S15 | Invited official lands on organiser onboarding | **OPEN** |
| S16 | Claim link is not a link, truncated, shown once | **OPEN.** Task 5 works around it by reading the `<code>`'s text |
| S17 | Blackout clash signalled by a hover-only glyph | **OPEN.** Task 5 asserts `officials-unavailable-note`, so the organiser-side half is now covered by a test |
| S18 | Five empty round headers on an unscheduled run sheet | **OPEN** |
| S19 | "Start tournament" is irreversible with no confirmation | **OPEN** |
| S20 | Four tabs carry zero `data-testid` | **FIXED** — 27 testids across six files (`a74095b13`..`ff79a3dc9`), plus a contract test |
| S21 | Court-picker checkboxes: duplicate names, 13×13 px | **OPEN** |
| S22 | Clear reports no counts | **OPEN.** The walkthrough reads emptiness from the record instead |

Nine closed, thirteen open, one encoded, one partly retracted. That ratio is
the honest headline: **a walkthrough wave converts findings into tests far
faster than it converts them into fixes**, and the tests are what stop the
open ones being re-discovered from scratch next year.

---

## §C — S23: four more division write paths ignored the freeze

**Critical (as a set). All four now FIXED — `816fe1525`, `cf3b11e26`.**

The wave's headline claim is "a frozen division refuses edits". It shipped
four guards (clear, restore, undo, redo) and a comment saying the enumeration
was finished. Three whole-branch lenses and one max-effort review then found
**four more live write paths** that never asked.

| Path | Entry point | What it did on a frozen division |
|---|---|---|
| `clearPoolEntrants` (`history.ts:768`) | `POST /api/v1/pools/{id}/clear-entrants` | `delete from fixtures where … and status <> 'decided'` — fixtures **permanently removed** |
| `shiftDivisionSchedule` (`schedule-plus.ts:34`) | `POST /api/v1/schedule/shift`, and the Constraints tab's "Shift whole timetable" | moved **every unlocked fixture** and set `edit_watermark = null`, destroying the redo stack |
| `deleteCheckpoint` (`history.ts:606`) | the ✕ on a save-point row | `delete from division_checkpoints … returning id` — the save point **gone forever** |
| `startDivision`'s quick-start write (`schedule.ts:3622`) | `board-start-division` on a `setup` division | wrote `scheduled_at` across the first stage and called `generateStageFixtures` |

Each was found independently and verified by reading the function: none of the
four contained a `divisionLockState` call, and `shiftDivisionSchedule`'s
`schedule_locked` reads were the **per-fixture** column on a different table
with the same name.

**What the customer loses.** The four are not equivalent, and the differences
matter more than the count:

- `deleteCheckpoint` is the worst, because it is the only **unrecoverable**
  one. Its Restore sibling **on the same row** was greyed out by this wave with
  "The schedule is frozen. Unfreeze it above to restore a save point." — and
  the ✕ beside it silently destroyed the thing the greyed button was protecting.
  An organiser who is told they cannot restore, and who then tidies up the
  list, loses the restore point permanently.
- `shiftDivisionSchedule` is the widest, because it is a **first-class UI
  control on a tab of the same console**, and it damages the rewind: nulling
  `edit_watermark` means the History panel cannot put the board back even after
  an unfreeze.
- `clearPoolEntrants` deletes fixtures rather than un-scheduling them.
- `startDivision`'s write is the narrowest — it needs a division still in
  `setup` with rolling times configured — but it is the same class.

**Blast radius.** Every frozen division, for the whole window between freezing
and the tournament starting, which is exactly the window a freeze exists for.
Three of the four are reachable from the scheduling console the organiser is
already looking at; `shiftDivisionSchedule` and `clearPoolEntrants` are also
exposed to any API key with `manage` scope (`key-scopes.ts:290`).

**Recommendation — done.** All four now throw
`HttpError(422, SCHEDULE_LOCKED_MESSAGE, SCHEDULE_LOCKED_CODE)` from the shared
`apps/web/src/lib/schedule-lock.ts`, each placed after its own existence check
so a missing row still 404s. Every guard was **seen red first** with the actual
failure text recorded (`clearPoolEntrants` resolved `{ removed: 6, seq: 3 }`;
`deleteCheckpoint` resolved `undefined`; `shiftDivisionSchedule` resolved
`{ shifted: 1, … }`; `startDivision` left six fixtures alive because generation
is its own transaction). `deleteCheckpoint` needed a restructure — its
`delete … returning id` **was** its existence check, so there was nowhere to
stand that kept 404 ahead of 422; it is now `select` → 404 → guard → `delete`,
both halves in one transaction.

**Strongest argument against.** Two, and they are not the same strength.

For `shiftDivisionSchedule` there is a real one: shifting the whole timetable
by a fixed offset is the classic "the venue moved us an hour later" operation,
and it preserves relative order, so an organiser could argue it is the one edit
a frozen board should still accept. The counter is decisive on the data rather
than on taste — it nulls `edit_watermark`, so it is not order-preserving with
respect to the rewind, and the freeze's own copy says "block ALL schedule
EDITS (yours included)".

For `startDivision` the counter-argument won, and it changed the fix: see §H
S24 — **starting a frozen division must keep working**, and only its *write*
refuses. A guard that refused the transition would have been a regression.

The weakest argument against is the one nobody should accept: "these are
pre-existing, not regressions from this branch." True of all four — verified
with `git log -L` from the worktree. It is also irrelevant. The wave's claim is
what makes them urgent: shipping "a frozen division refuses edits" while a live
route deletes that division's fixtures makes the claim false, and the reader of
the release note has no way to know which half is true.

---

## §D — S24: the comment that asserted the enumeration was complete

**This is a finding about method, not a bug, and it is the most transferable
thing in Part II.**

`history.ts:255` shipped, in this wave, reading:

> Undo and redo **were the last two** division write paths that ignored it.

It was false at three sites on the day it was written — `clearPoolEntrants`
fifty lines below it in the same file, `deleteCheckpoint` in the same file, and
`shiftDivisionSchedule` in `schedule-plus.ts`. A sibling comment in
`clearScheduleScoped` claimed "Clear was the one division write path a freeze
did not stop", which was false in the same way.

The mechanism is worth naming precisely, because everyone involved was being
careful. The wave **did** enumerate write paths: the docstrings hunt down
`applySchedule`, `moveFixture`, the joint apply and the AI-plan gate, and even
disclose `patchFixture` as a known miss. What it did was enumerate the paths it
could reach by grepping for the sentence it already knew about, and then write
down a **count**. A grep over a sentence finds the sites that already say that
sentence. It cannot find the site that says nothing.

**What the customer loses.** Nothing directly — a comment ships no behaviour.
What is lost is the next reader. A comment stating a closed enumeration is the
cheapest possible way to stop someone checking, and it will be believed
precisely because it is specific. Two of this wave's own reviewers cited it
back as context.

**Blast radius.** Every future change to the freeze. And the class is wider
than freezes: any comment of the form "these are the only N places that do X".

**Recommendation — done, and the shape is the point.** The replacement comment
does **not** contain a corrected list. It names the enumeration's **source**:

> The enumeration is now the IMPORT GRAPH of `@/lib/schedule-lock` … `grep -rn
> SCHEDULE_LOCKED_MESSAGE apps/web/src` is the live answer and a freeze refusal
> that does NOT import the constant is the bug.

That converts a fact that rots into a query that cannot. It only works because
the constant is import-clean — `apps/web/src/lib/schedule-lock.ts` has zero
`import` statements, which makes "does everything share it?" arithmetic rather
than an argument.

**Strongest argument against.** A grep-recipe comment is less useful than a
list at the moment you read it: a list tells you the answer, a recipe makes you
run something. That is a genuine cost, paid on every read, against a benefit
paid once when the list would have gone stale. Two things settle it here.
First, this particular list had already gone stale **before it was committed**,
which is the fastest possible refutation of "lists are fine if you keep them
up". Second, the recipe is a one-line grep whose output is the list — so the
cost is seconds, and the answer is never wrong.

The residual honest weakness: the recipe is only as good as the constant's
discipline. A path that refuses a freeze by re-typing the sentence would be
invisible to the grep, exactly as before. The comment says so; nothing enforces
it. **A lint rule or a test asserting no literal `"schedule is locked"` outside
`schedule-lock.ts` is owed** and does not exist.

---

## §E — S4's disposition: encoded as actual behaviour plus a `test.fail()` pin

**S4 is NOT fixed.** Propose still builds a real draft that cannot be applied.

The wave's decision, and it was a deliberate one made twice: the walkthrough
carries **both** encodings.

1. The main journey asserts **what the product does today** —
   `officials-apply` is `toBeVisible()` (load-bearing: the button renders only
   under `proposal && proposal.assignments.length > 0`, so visibility proves
   the half of S4 that says *propose builds a real draft*) and then
   `toBeDisabled()`, under a comment naming S4 by id and by the findings-doc
   line, and stating why `toBeEnabled()` was not used and why `toBeDisabled()`
   **alone** would be wrong.
2. A separate `test.fail()` test pins the **correct** behaviour: enable, click,
   and poll that the fixture ends up with at least one official. It reds as
   "passed unexpectedly" the moment S4 is fixed.

`test.fail()`, never `test.skip()` — a skip is silent forever.

**What the customer loses, unchanged from Part I.** The entire value of
auto-assignment: the feature runs, reports what it would do, and then the
organiser does all of it through fifteen dropdowns, having been shown that the
product could have done it.

**Blast radius.** Every organiser using officials auto-draft.

**Recommendation.** Fix the predicate. Task 5's review established the
mechanism with enough precision that the fix is now a product decision rather
than an investigation: with `max_per_day: 1` and two fixtures on one day,
`assign.ts:228-231` skips the second (`dayCount >= maxPerDay`), `best === null`,
and `assign.ts:270-271` emits `role_unfilled` with `severity: "block"` — which
is exactly what `officials-panel.tsx:316`'s
`disabled={busy || proposal.conflicts.some(c => c.severity === "block")}`
refuses on. So the product's position is *"a draft that cannot fill every slot
cannot be applied at all"*. That is the thing to change: a partial draft should
be applicable, seating the assignments it did make and leaving the unfilled
slots unfilled — which is what the nine red rows already tell the organiser
happened.

**Strongest argument against, and it is stronger than Part I allowed.** Part I
said "the button may be correctly disabled for a reason I did not eliminate",
and that turned out to be true: it **is** correctly disabled by its own stated
rule. All-or-nothing has a real defence — a partial apply leaves the roster in
a state no one chose, and an organiser who applies six of fifteen and then
forgets is worse off than one who was refused. If the owner takes that view,
S4 shrinks to a copy defect: the button must say *why* it cannot be pressed
("3 slots have no eligible official — resolve them or assign manually"), which
today it does not, carrying no `title`, no `aria-label` and no `aria-disabled`.
Either way the product owes the organiser a sentence, and the `test.fail()` pin
is still the right shape — if the owner rules all-or-nothing correct, the pin
is deleted with a comment saying so, which is a decision on the record rather
than a silent skip.

**Two things about the pin itself that are findings in their own right** — see
§K T3: as first written, `test.fail()` was the first statement of the test
body, so six setup steps were inside the inverted envelope and would have read
green. Fixed in `4ef40fbe6`; the mechanism was read out of Playwright's own
`workerProcessEntry.js:991-994` rather than assumed, and proven in both
directions by running it.

---

## §F — S13 is still open

**Medium. No work done. Nothing in this wave touched it.**

At 320px on the Officials tab: the ASSIGN column header starts at x=285 — the
right edge of the viewport — and the first assign `<select>` is 47px wide at
x=301–348, so roughly 19px of it is on screen. The scrolling wrapper is
`class="card scroll-x scroll-x-fade"` with **no `tabindex`, no `role` and no
`aria-label`**, so a keyboard user cannot scroll the rail to reach the control
at all.

**Why it survives every gate we have.** The wrapper is a genuine
`overflow-x: auto` rail, so the page-level no-horizontal-scroll gate passes
correctly, and `mobile.spec.ts`'s clipping scan correctly excuses it as the
reachable kind of overflow. Both gates are right; neither is asking the
question that matters, which is whether the tab's primary action can be
operated.

**What the customer loses.** The officials tab's only action is unusable on a
phone. This is one of the two tabs anyone actually opens courtside.

**Blast radius.** Every phone width on the officials tab. The same `.scroll-x`
wrapper pattern is used elsewhere and is worth auditing.

**Recommendation.** Split it. The accessibility half is not optional and is
cheap: `tabindex="0"` plus a role and an accessible name on the rail,
unconditionally (`tabindex` cannot be varied by media query). The composition
half — a stacked card per fixture at phone widths with the assign control
full-width beneath the names — is a design decision that belongs with S14's.

**Strongest argument against.** For the composition half there is a real one:
scoping a phone composition into a wave that has already grown a CP-SAT fix and
four server guards is how waves stop landing, and S14's own escalation was
parked for the same reason. For the accessibility half there is none I can
construct. `scrollable-region-focusable` is a SERIOUS-impact axe rule, the
repo's own standing rule says any new scrolling region owes a `tabindex`, a
role and a name, and this one is not new — it has simply never been checked.
The only argument is scheduling, and scheduling is not an argument against
correctness.

---

## §G — S14: the board-tab reading is RETRACTED; the other five stand

### The retraction, first

**S14 as written claimed six tabs presented identical control sets at 320 and
1280. The board row was a measurement artefact and is WITHDRAWN.**

`schedule-board.tsx:853-861` reads a **saved density from `localStorage`**
before applying its mobile default. Part I's hand-drive walked 1280 → 768 → 320
in **one browser context**, so the 320 measurement was reading a desktop
density the same session had just chosen at 1280. It was never a responsive
branch.

Re-measured by Task 4 in a **fresh context with no saved preference**: the
first phone visit at 320 opens at **Agenda**, the intended mobile default. The
board tab is doing exactly what it should. **No phone work is owed for the
board tab**, and any future S14 measurement must use a fresh context per width
or it will reproduce this error.

This retraction was recorded durably before it was acted on
(`3e4d80d81`, then `ae7c61e04`), because a peer session had already been told
the original reading.

The general rule, which cost this wave two separate corrections: **a
measurement taken in a context that carries state from a previous measurement
is not a measurement of the second condition.** The same shape produced W1 in
Part I (a `psql` session timezone manufacturing an hour) and produced §K T5
below (a string grep confirming a string and being read as confirming a build).

### What still stands

Five of six tabs — health, settings, constraints, officials, history — present
**exactly the same controls, in the same order, at 320 as at 1280**. None of
them persists view state, so none of them can be contaminated the way the board
row was. Raw dumps are preserved at
`docs/superpowers/specs/2026-09-03-scheduling-walkthrough-evidence/`.

**What the customer loses.** Nothing is broken; what is missing is a point of
view about what an organiser needs on a phone. Five dense desk panels rendered
at 25% width.

**Blast radius.** The scheduling console is the largest organiser surface with
no phone composition, at a moment when the scoring pad and the fixture console
have both just had theirs.

**Recommendation.** Still an owner question, not a defect. The scoping answer
this wave would give, now that the board row is out of it: **officials is the
one tab that needs composition work**, and it needs it for S13's reason (a
dead primary action) rather than for S14's (an undifferentiated control set).
Settings, constraints, history and health are desk work where an honest reflow
is the right answer and a phone composition would be spending design budget on
a use case that barely exists.

**Strongest argument against, and it got stronger.** The owner scoped S14's
phone work into this wave on 2026-09-04, on the strength of a six-tab finding.
One of those six rows was wrong. That is a direct argument for *not* acting on
the remaining five without re-deriving the case: the finding that justified the
scope decision is not the finding that survived it. A decision made on
contaminated evidence should be re-put, not inherited — which is why the phone
work is PARKED rather than dropped or done.

---

## §H — New findings, still open

Numbering continues Part I's series. Each was verified by reading the cited
source; where the mechanism was not exercised, the entry says so.

### S25 — Deleting a blackout row corrupts the surviving row's date

**High. Silent data loss. `constraints-panel.tsx:844-848`, removal at `:881`.**

The `<li>` is `key={i}` and removal is
`rows.filter((_, j) => j !== i)`. The comment on the line this wave edited says
*"Index key: every field is controlled from this array, so there is no per-row
state for React to mis-reuse."* That is false. Each row's `from`/`to` are
`DateTimeField kind="datetime-local"`, which delegates to `DateTimeSplitField`,
whose state is `useState(() => splitValue(value))` — and whose **own docblock
says** it is *"seeded once from the incoming `value` … never re-derived from
props after mount"*.

Trigger: two blackouts, row 0 on 2026-09-10, row 1 on 2026-09-12. Remove row 0.
React keeps key `0` mounted and swaps its `value` prop to row 1's window;
`halves` still reads 2026-09-10, so the surviving blackout **displays the
deleted one's date**, and the next edit to either half writes 2026-09-10 back.

**What the customer loses.** They black out a day they deleted and un-black the
one they kept — and the screen agrees with the wrong version, so there is no
cue. The next solve places matches in a window the venue is closed.

**Blast radius.** Any division with two or more blackouts where one is removed.
Also: `data-blackout-index={i}`, added by this wave as the contract test's
identity column, is an array index and re-points at a different row after any
removal — so it is not a stable identity and should not be used as one.

**Recommendation.** Key the rows by a stable id (mint one on add), not by
index. Then delete the comment that says index keys are safe here — it is the
comment, not the key, that will cause the next instance.

**Strongest argument against.** Index keys are genuinely fine for a list whose
every field is controlled from the parent array — the comment states a true
general rule. The defect is that one child in the tree is *not* controlled: it
snapshots on mount by design, and its own docblock says so. So an equally valid
fix is to make `DateTimeSplitField` re-derive on a `value` change, which would
close this class everywhere rather than in one panel. That is the better fix
and the riskier one: that component is shared, and something else may be
relying on the snapshot. I would key the rows now and file the component
question separately.

### S26 — `settings-match-minutes` rewrites a cleared field to 30

**Medium. `board/settings-panel.tsx:578`, a line this wave edited.**

`onChange={(e) => setMatchMinutes(Number(e.target.value) || 30)}` on a
controlled input. `Number("") === 0`, `0 || 30` is `30` — so backspacing the
field to empty repaints it as `30` mid-edit and the next keystroke produces
`309`, never `90`. Typing a literal `0` is likewise rewritten to `30`.

The sibling on the **next line** already uses `sanitizeNonNegativeInt`, as does
the rest field. And the wave was demonstrably thinking about this exact class:
the organiser walkthrough deliberately pins that clearing `constraint-min-rest`
writes `0`, with a comment quoting `Number("") === 0`. The one numeric field
left on the old idiom is the one whose line the diff touched.

**What the customer loses.** An organiser changing 40 → 90 gets 309 unless they
select-all rather than backspace. Match length feeds every capacity number and
the solver.

**Blast radius.** One control, but a high-traffic one, on the settings tab.

**Recommendation.** Use `sanitizeNonNegativeInt`, matching its two neighbours.

**Strongest argument against.** The `|| 30` idiom exists to stop an empty field
producing `NaN` downstream, and a naive change to `Number(...)` alone would
reintroduce that. Fair — which is why the fix is the sibling's helper, not a
bare `Number()`. There is no argument for keeping it as it is.

**Note for whoever fixes it:** the new e2e cannot witness this. It drives the
control with `fill(String(MATCH_MINUTES))`, which never produces the empty
intermediate value. A regression test has to type, not fill.

### S27 — Pool-keyed rest still never reaches the solver

**Medium-High. Engine. `build.ts:1868`, `:1881`.**

The S1 fix routes the CP-SAT wire through the shared `restFloor` resolver for
three of its four sources. The fourth, `restByGroup` keyed by **pool**, still
does not arrive: `restFloor(verifyConfig, { divisionId: f.divisionId })` omits
`poolId`, while both consumers on the other side pass the whole fixture and so
resolve `restByGroup[poolId]`.

Trigger: a division with two pools and `restByGroup: { "<poolA-id>": 45 }`. The
solver is sent no rest rule, honestly returns "SCHEDULED n/n", and the verifier
then paints `rest` conflicts on every pair in that pool — **byte-identical to
the 32-conflict symptom S1 exists to fix**.

A second, narrower instance of the same class: `restByGroup[""]` is written as
a legal wire key (`merged[f.divisionId ?? ""]`) but can never be *read*, because
`rest-floor.ts:88` skips a lookup on an `undefined` key. The block comment
directly above claims the opposite.

**What the customer loses.** The exact defect S1 fixed, for anyone using
pool-scoped rest — including the "Optimised, and here are 32 warnings" screen
that made S1 findable.

**Blast radius.** Divisions with pool-scoped rest rules. Not the common case,
which is why it survived; the wire is keyed by division id while
`effectiveRestMinutes` resolves with `poolId` **and** `divisionId`.

**Recommendation.** Widen `buildRuleGroups`' division-keyed parameter. The
implementer confirmed this needs no proto change — `RuleGroup` is already a
fixture-id set, and only that parameter's key space blocks it. Add a test on
the pool axis: `grep -n poolId build-rest-lattice.test.ts` returns nothing
today, so there is no coverage of this axis at all.

**Strongest argument against.** The deferral was deliberate and reasoned: the
implementer refused to max-collapse pool floors into one division number
because raising a floor for sibling pools can turn a feasible board
**infeasible**, and a false `infeasible` is a hard stop rather than a warning.
That reasoning is correct and the decision should stand — the argument is
against *collapsing*, not against *widening*. What is not defensible is leaving
it silent: nothing warns a caller, and the docblock beside it describes the
old two-source fold. **The gap is a comment away from being a trap** rather
than a known deferral.

### S28 — A sibling role card stays clickable after its own row was answered

**Medium. `me/officiating-lane.tsx:238`, `:248`, `:79`.**

Cards are keyed `${fixture_id}:${official_id}:${role_key}` and each holds
`useState(a.response)` — initial value only. The write is per **fixture** and
`setMyOfficiatingResponse` matches every role the caller holds on that fixture.
So an official who is both referee and umpire on one fixture sees two cards;
accepting on one flips both DB rows, but only that card calls `setResponse`.
`router.refresh()` re-renders with fresh props and the other card's `useState`
initial value is never re-applied, so it keeps rendering Accept and Decline over
a row the server already recorded as accepted. Clicking Decline there then 422s
`RESPONSE_LOCKED`.

The wave's own new comment asserts this two-card case is real, and adds
`data-fixture-official-id` for it, without fixing the state.

**What the customer loses.** An official is shown an unanswered offer they have
already answered, and gets a raw 422 for pressing it.

**Blast radius.** Any official holding two roles on one fixture.

**Recommendation.** Derive `response` from props rather than snapshotting it —
or key the optimistic update by fixture, since that is what the server does.

**Strongest argument against.** The optimistic local state is what makes the
button feel instant, and deriving from props reintroduces a flash of the old
value while `router.refresh()` completes. Real, and the answer is the ordinary
one: keep the optimistic write, but apply it to every card sharing the fixture,
which is the same grouping the server already uses.

### S29 — `restoreCheckpoint` can be stopped mid-loop, and reports it as "nothing happened"

**Major. `history.ts:667-679` combined with the new per-step guard at `:283`.**

`restoreCheckpoint` loops up to 500 times calling `undoDivision`, each iteration
its own `withTenant` transaction with no lock spanning them. This wave added a
freeze check **inside** `step`, re-read fresh on every iteration.
`setDivisionLocks` takes no advisory lock and can commit at any time.

So a freeze landing mid-restore throws a 422 out of `restoreCheckpoint`,
uncaught, straight to the client — carrying the same sentence the pre-loop
guard uses for the true no-op case, while *i* undos have already committed. The
division is left at neither the original watermark nor the checkpoint's target.

**This is a hazard the wave introduced.** Before this branch nothing could
interrupt the loop except `UNDO_BLOCKED_HAS_RESULTS`.

**What the customer loses.** A board in an intermediate state, and an error
message that says nothing happened.

**Blast radius.** Multi-step restores on a division two people are working on,
or one person across two tabs. Narrow, and entirely invisible to the tests:
every existing test freezes **before** the restore, never during.

**Recommendation.** Two parts. Catch the 422 inside the loop and return a
partial report — count restored, count remaining, the reason — instead of a
bare refusal; the shape already exists on the joint path. And add the test that
freezes mid-loop, which no test does today.

**Strongest argument against.** The window is genuinely tiny and needs two
actors, so the cheaper answer is to accept it and change only the *message*, so
a 422 out of a partially-completed restore does not claim to be a no-op. That
is a defensible smaller fix, and it is strictly better than today. What is not
defensible is leaving the message as it is, because the one thing worse than a
partial rewind is a partial rewind reported as none.

### S30 — A long organisation name pushes "Sign out" off-screen at 768px

**Medium, and the way it was found is the finding.
`nav.tsx:112`/`:115`, `logout-button.tsx:37`.**

The org chip is `hidden shrink-0 … sm:flex` and renders `{activeOrg.name}` raw
— no `truncate`, no `max-w-*`. The sibling "Sign out" is also `shrink-0`, with a
comment saying it must never shrink or the label wraps. Two unshrinkable
siblings with an unbounded string between them.

This is not theoretical, and it was **reproduced by this wave**: Task 5's first
attempt used a ~32-character org name and *reproducibly failed the 768px scroll
gate on exactly that button*. The spec's own comment records it, calls it "a
real, pre-existing nav responsiveness gap", and says it is "worth a separate
finding".

**That finding was never filed.** The workaround shipped — org names shortened
to `"OH"` and `"S4P"` — and the defect is now actively hidden from the
seven-width gate by test-data choice. Its only record was a comment inside a
spec, until this paragraph.

**What the customer loses.** Any organisation whose name is long enough loses
the Sign out button at tablet width.

**Blast radius.** Every page — it is the global nav — for every org above the
name-length threshold. Nobody has measured that threshold.

**Recommendation.** `truncate` plus `min-w-0` on the chip and a `max-w-*`
ceiling, with the full name as a `title`. Then measure the threshold and check
the real distribution of org name lengths, because that decides whether this is
an edge case or a live incident nobody has reported.

**Strongest argument against.** The composition change is trivial; the argument
is about whether the finding is worth a wave's attention when no customer has
complained. The counter is the one that matters here: **a test that avoids a
defect by choosing different data has removed the only signal we had.** The
seven-width gate found this, once, and we taught it not to. That is worth
recording even if the fix waits.

### S31 — Five of six console tab labels are raw ids in every locale

**Medium. `schedule/page.tsx:271`.**

`{tabId === "health" ? <HealthTabLabel/> : tabId}` — the six tabs render as the
literal strings `board`, `settings`, `constraints`, `officials`, `history`, in
every locale. This is the navigation of the very page this wave's walkthrough
drives.

Pre-existing, not caused by this wave, and deliberately not fixed inside it:
`page.tsx` sits in a file three live programmes are editing.

**What the customer loses.** A French, Spanish or Dutch organiser gets an
English — in fact untranslated-identifier — tab strip on every scheduling
screen.

**Blast radius.** Every scheduling screen, all four locales.

**Recommendation.** Six keys, four locales, one line. It is the cheapest
user-visible i18n win in the console.

**Strongest argument against.** Contention: the file is shared with two other
in-flight waves and the repo's own rule is not to reorder or rewrite shared
literals concurrently. That argues for *sequencing*, not for skipping — and it
is a two-line change that adds keys rather than reordering them, which is the
merge-safe direction.

### S32 — Five of six hard-constraint types have no UI writer at all

**Medium. Product gap, found by enumerating the panels rather than the engine.**

Of the engine's six hard-constraint types, only `max_fixtures_per_day` has a UI
writer; of its seven scopes, only `division` does, and it is hard-coded inside
`withMaxFixturesPerDay` rather than chosen. The Constraints tab instead writes
its own flat siblings — `restMin`, `noBackToBack`, `fieldFairness`,
`parallelism`, `crossPersonClash`, `startWindows`. Relatedly, the UI has **no
venue scope for blackouts**: the selector is a flat list of court ids plus `""`
meaning division-wide, so "all courts at venue X" is not expressible.

**What the customer loses.** Capabilities the engine has and the product does
not offer. They are reachable only through the AI console and the API.

**Blast radius.** Every organiser who needs one of them.

**Recommendation.** This is a roadmap input rather than a bug: decide which of
the five are worth surfacing before anyone builds a sixth flat sibling beside
the existing ones, because each flat sibling makes the eventual unification
more expensive.

**Strongest argument against.** A constraint vocabulary the organiser cannot
express is not necessarily a gap — it may be deliberate simplification, and the
flat siblings may be the better UX for the two or three rules people actually
set. That is very likely right for most of them. The finding is not "expose all
six"; it is that nobody has *decided*, and the divergence has been growing by
accretion.

---

## §I — Closed in this wave, worth knowing about

| # | Finding | Where it landed |
|---|---|---|
| S33 | The freeze sentence was hand-typed at five sites, and a sixth carried a code nobody else did — so "which paths refuse?" was answerable only by grepping prose | `apps/web/src/lib/schedule-lock.ts`, ten consumers, `816fe1525` |
| S34 | The 422 refusal reached translated cards as raw server English, on the FIRST request, inside `board.ai.joint.undoneReason`'s `{reason}` | `66cd3cd2d`. Client-only was impossible — the code never reached the browser — so `failed[].code` was added to the wire and both surfaces now resolve a local string off `SCHEDULE_LOCKED_CODE` |
| S35 | Delete-save-point stayed live while Restore on the same row was greyed | `66cd3cd2d`. Also given real disabled styling — a bare text button inherits none of `.btn`'s `disabled:` tokens, so it had rendered pixel-identical to a live one |
| S36 | The joint console named the divisions it could not revert and never said why — the copy existed and nothing rendered it | `9f6d4117f` |
| S37 | The two "frozen"s: `competition.frozen` (billing) and `divisions.schedule_locked` sat one line apart under the same name, and reusing the wrong one made a guard silently never fire | renamed to `billingFrozen` across three pages, `2ad1e9cb1` |

**Residual on S34, recorded as a recommendation rather than fixed.** Both
surfaces still show the server's own message for anything *without* a
recognised code. That is deliberate: the leak worth closing was the known,
expected, actionable refusal, and replacing an unanticipated error with
"something went wrong" trades an untranslated known refusal for an unreportable
unknown one. The right long-term shape is a translated **frame** around a
quotable detail (`"Something went wrong: {detail}"`), which keeps the
diagnostic and stops the card ever speaking English in its own voice. That
touches every error path in the panel and is a separate task.

---

## §J — The sixteen false premises

**This is the most useful section in this document for the next wave.**

Sixteen briefed premises proved false. Most were written by the controller, in
a spec or a task brief, and then handed to an implementer as fact. **Not one
was caught by a passing test suite** — every single one was caught by a review,
by an implementer building on it, or by someone driving the product.

| # | The premise, as briefed | What was actually true | What it cost |
|---|---|---|---|
| FP1 | `restMin` is a `hard[]` rule of type `min_rest_minutes`; assert `config.hard.find(…).minutes === 60` | It writes `constraints.restMin`, a flat sibling — not a `hard[]` rule at all | The assertion **could never pass**. Had it shipped, Task 4 would have failed in a way that looks exactly like a product defect |
| FP2 | A blackout with no `court` key is "venue-wide" | The UI has no venue scope: a flat list of court ids plus `""` = division-wide | A test would have asserted a scope the product cannot express (now S32) |
| FP3 | `required_court_tags` is written from the run sheet | Two writers: `division-settings.tsx:628` and `stages-panel.tsx:2021` | Half the surface would have gone undriven |
| FP4 | `repair-domain.ts:499` misses `restByGroup` and `noBackToBack` | Both were already handled and already pinned | One commit that was a **no-op refactor** presented as a fix. Cause: a scout's characterisation passed into a dispatch without opening the file |
| FP5 | Undo/redo restore `divisions.schedule_locked`, so guarding them could strand an organiser | Those lines write `fixtures.schedule_locked` — a different column on a different table. `divisions.schedule_locked` has exactly one writer, which appends no ledger event, so **no rewind can ever unfreeze a division** | **This one reached the owner's decision.** The owner chose restore-only from an option list carrying this false reason, was told, and revisited: undo and redo are now guarded too |
| FP6 | Joint restore returning 200/`ok:false` while joint apply throws 422 is an inconsistency | It is the correct atomic/non-atomic distinction. Apply is one transaction (its 422 truthfully means nothing was written); restore is N, and its module docblock says "NOT one transaction, deliberately" | A "fix" would have made a non-atomic loop claim nothing happened when N−1 divisions were already rewound. The rule kept: **ATOMIC ⇒ refuse with a status; NON-ATOMIC ⇒ 200 plus a per-division report** |
| FP7 | `config.hard` exists | It is `config.constraints.hard` | The brief's snippet would have hung |
| FP8 | `GET /divisions/{id}/fixtures` does not exist (per a sibling spec's comment) | It does; the comment is stale | Work almost routed around a route that was there |
| FP9 | Asserting `board-start-division` is present after publish proves the publish worked | It is visible **before** publish | A **vacuous step**, caught before it shipped |
| FP10 | The constraints checkboxes would fail `check()` | They fail it *because they behave correctly* — instant commit, no dirty state to check | Nearly recorded correct behaviour as a defect |
| FP11 | `division-settings.tsx:626`'s "not read by scheduling" comment is accurate | It is wrong. Note it sits one line off the `:628` court-tags writer | A comment believed as evidence — the standing "a comment is a hypothesis" trap |
| FP12 | S1: min rest has two homes, the solver reads one and the checker the other | A **shared resolver already exists** — `restFloor(config, group)`, MAX over four sources, owner ruling #459. The greedy placer and the verifier both honour it. The defect was **one line**: `build.ts:1814` read the raw field into the CP-SAT wire | Would have produced a config unification — a schema change and a migration — where a one-line repoint was correct. Caught before any code was written, by mapping call sites instead of trusting the finding |
| FP13 | Task 5's step 4 should assert `officials-apply` is enabled | Contradicts S4, the wave's own High finding | Would have **frozen a High defect as expected behaviour** — the failure class this programme has already shipped twice. Caught by the controller re-reading its own brief before dispatch |
| FP14 | The served bundle is pristine — the guard string is in all nine chunks | A string grep confirms a **string**, never the build's freshness. The server was serving a build stamped before the wave's own testids and guards existed, while agents tested against it | Agents ran against a stale build; a broadcast hazard had to be retracted to a peer. Rule: check the `BUILD_ID` stamp against the commit date |
| FP15 | The `ui.json` merge conflict with the concurrent wave is four hunks, one per locale | Measured with `git merge-tree`: **three hunks per locale, twelve in all** | A resolver acting on the briefed sentence would have treated eight legitimate hunks as suspect |
| FP16 | Place the freeze guard "after the existence check" in `deleteCheckpoint` | There was **no existence check** — its `delete … returning id` *was* the check | The function needed a restructure (select → 404 → guard → delete) rather than a four-line insert. Found by the implementer building on the brief |

**The pattern, stated plainly.** Fourteen of the sixteen are the same error:
**a property was asserted from a grep, a comment, or a relayed summary, rather
than from opening the function.** FP4, FP5, FP11, FP12 and FP14 are that error
exactly. The two exceptions (FP13, FP9) are self-caught by re-reading, which is
the cheapest possible correction and the one worth institutionalising.

**Three second-order rules this wave paid for:**

1. **A correction is a NEW claim and inherits none of the verification of the
   thing it corrects.** The wave produced three successive wrong versions of
   one enumeration: the original comment, the fix-round replacement written
   from a freshly-built mental model instead of a re-read, and then a third
   round for a two-word error inside the sentence written to correct the second.
2. **A truncated grep reads exactly like an absence.** `grep … | head -3`
   returned three comment lines and the real call was the fourth match; the
   conclusion "the call is missing" was one keystroke from being filed.
3. **A disagreement between two measurements of a moving quantity is
   staleness, not impossibility.** A peer's memory-pressure number was
   "corrected" against a later reading of a value macOS grows and shrinks. Both
   were true at their times. Quote the time with any machine measurement.

---

## §K — The vacuous-green traps

Every one of these produced, or would have produced, a **green verdict on
something that did not run or did not check**. They are listed with the
signature to look for, because the signature is the transferable part.

### T1 — A Playwright abort reports `suites: 0` and reads as a pass

`scheduling-organiser-day.spec.ts` called `solverWallMs()` at **module scope**,
and that function throws on a malformed `PLACEMENT_WALL_SECONDS`. A module-scope
throw collects **zero tests**, and the JSON reporter emits
`suites: 0, expected: 0, unexpected: 0` — which any gate reading
`unexpected === 0` scores green.

Demonstrated rather than argued, with `PLACEMENT_WALL_SECONDS=oops`:

| | suites | expected | unexpected | exit |
|---|---|---|---|---|
| before | **0** | **0** | **0** | 1 |
| after | 2 | 2 | **1** | 1 |

The file's own docblock, six lines below the offending line, **states the rule
it was breaking**. Fixed by making the parse total (`{ ms, fault }`, falling
back to the documented default) and asserting `fault` as the test's first act.

The same shape hit the wave from the other direction: a review dispatch omitted
`PLAYWRIGHT_BASE`, the run aborted at preflight in 404ms, and returned
`suites: 0, expected: 0, unexpected: 0, flaky: 0`. Only the reviewer noticing
`suites: 0` stopped it being reported clean.

> **Rule: assert `suites > 0` and `expected > 0`. Never `unexpected === 0`
> alone.**

### T2 — `rtk` fabricates clean verdicts for tools it wraps

Three distinct instances in this wave, on three different tools:

- **tsc**: the bare wrapper prints `No errors found` **whether or not tsc exits
  1**. Use `rtk proxy` and read the exit code.
- **prettier**: `npx prettier --version` answers
  `Prettier: All files formatted correctly`. A re-review's "prettier --check
  clean on both" was therefore worthless — and so was the conclusion drawn from
  it that root and `apps/web` resolve config differently. Through `rtk proxy`
  both warn identically. (Nothing is owed: this repo has **no** prettier config,
  no format script and no prettier CI step. Formatting is not a gate here — do
  not bundle a reformat into an unrelated commit to chase one.)
- **git diff**: rewritten into a summary, so `grep '^[+-]'` returns **empty on
  a non-empty diff**. That is the wrapper, not an empty change.

An implementer independently rediscovered the tsc case and defended against it
by confirming with `eslint --format json` that both files had really been
linted rather than silently skipped by an ignore rule. That is the right
posture: **make the tool prove it looked at the file.**

### T3 — `test.fail()` covering its own setup

As first written, `test.fail()` was the **first statement** of the S4 pin's
body, so two `/api/orgs/active` round trips, a tab navigation, a propose click
and a 20s `toBeVisible` were all inside the inverted envelope. Six setup
failures would have recorded "failed as expected" and the suite would have been
green.

Worse in the long run: when S4 is actually fixed, the pin only reds if *every*
setup step still works — so any concurrent rot leaves it permanently green, the
stale `test.fail()` is never deleted, and the fixed behaviour returns to zero
coverage. The comment above it promised the exact opposite.

The mechanism was read out of Playwright's own
`workerProcessEntry.js:991-994`: `type === "fail"` assigns
`expectedStatus = "failed"` **at the moment it executes**. So moving the setup
*above* the call is sufficient. Proven both ways by running it: unmodified gives
`expected: 4, unexpected: 0`; with the setup deliberately broken, `unexpected: 2`
naming the setup step.

> **Rule: `test.fail()` goes immediately above the assertion it inverts, never
> at the top of the body.** And the amendment that specifies the pattern must
> also specify its **scope** — this gap was in the brief, not the implementation.

### T4 — An `afterAll` querying the wrong tenant

Both officials `afterAll` hooks called `resolveOfficialIdByName` without first
activating the org. `GET /api/v1/officials` is `requireAuth` and answers from
the **active-org cookie**, so it returned `[]` for the foreign org — the
fallback could never resolve, and both `stillThere` read-backs were vacuous
whatever happened.

The refinement matters more than the finding: `DELETE /api/v1/officials/{id}`
is `requireResourceAuth` and **re-pins to the resource's own org**, so the
deletes had been succeeding all along and nothing was observed leaking. The
leak is real exactly on the path the fallback exists for — the test dying
between the write and the response — and there the fallback was dead code.

Proven by mutation against the live DB, twice:

| | rows left behind | run verdict |
|---|---|---|
| activation removed | **2 leaked** | 4 passed, exit 0 |
| activation restored | 0 | 4 passed, exit 0 |

**Both runs report "4 passed".** That is the whole trap: cleanup that silently
no-ops is indistinguishable from cleanup that worked, from the summary.

### T5 — Four more, recorded because each was a near-miss

- **A guard's placement inside a single-transaction usecase cannot be witnessed
  by any DB assertion.** A mutant that moved `step()`'s guard from before
  `loadLedger` to *after* `execute` + `appendEvent` **survived** a 34/34 green
  run, because the rollback erases the difference. The assertion was kept with
  its real scope written into the code — it pins that the rewind stays *one*
  transaction, which is live rather than hypothetical, since `restoreCheckpoint`
  in the same file is N transactions.
- **`not.toContain(undefined)` passes on anything.** Deriving a negative
  assertion from `en/ui.json` without a key-exists guard only relocates the
  vacuity. The fix needs the guard; the wave's proof was a mutation *pair*
  (reword only → both green; reword **and** delete the skip branch → literal
  still green on a real defect, derived red).
- **A `suites: 0`-shaped abort has a sibling in vitest**: an unset
  `DATABASE_URL` makes the vitest **config itself** throw before collection.
  Run non-DB suites with an explicitly empty `DATABASE_URL=`, or the abort reads
  as an environment problem rather than as the deliberate skip it is.
- **A model floor changed results.** An opus sweep found two real defects (T3
  and T4 above) inside a file a sonnet review lens had read and **approved**.
  Recorded as a fact about this wave, not a general law — but where a
  cheaper-model pass is the *only* gate on a file, re-run it.

---

## §L — What is still owed

Not findings; open items, so nothing here is mistaken for done.

1. **The wave-boundary gate has not run.** Full vitest on a quiet tree, the
   full `walkthrough` project (the full-directory e2e form has never completed
   — a 22-file invocation blew the tool cap and was SIGKILLed), a
   `seazn-env rebuild`, and a browser re-drive of the fixed 32-conflict board.
   Deferred at load ~279 with other sessions asked to serialize.
2. **Three tasks' `scripts/smoke.ts` additions have never been executed.**
   Written, typechecked, committed, never run.
3. **`smoke.ts`'s `redoThawed`** is the only step that restores the board the
   REFLOW check measures, and `check()` never throws — so a non-200 redo makes
   REFLOW vacuously green *and* produces one red pointing at the wrong
   subsystem. The block reasons about exactly this hazard for the freeze/thaw
   pair and applies no equivalent guard to the rewind pair.
4. **`enabled:hover:underline`** (`history-panel.tsx`) is the **only** use of
   Tailwind's `enabled:` variant in the codebase. Nothing proves this build
   emits it, and a node-env class-token test cannot witness it. The failure is
   silent in the enabled direction. Needs a built-CSS check or a browser pass.
5. **The testid rename guard excludes the file this wave added the most
   testids to.** `scheduling-testid-contract.test.tsx`'s `OWNED` map covers five
   files and deliberately omits `history-panel.tsx` — to which this branch added
   ten testids the organiser walkthrough selects on. Rename one and the whole
   vitest suite stays green; only the `walkthrough` Playwright project reds, and
   **that runs on push to `main` only** — never on the PR that broke it. Its
   IDENTITY check is also file-wide (`toContain("data-court-id={")`), so moving
   the attribute off the element keeps it green.
6. **`blackout-editor` and `court-picker` are inert** — added, listed in the
   contract, selected by nothing.
7. **`stages-panel.tsx:744-745`'s second `schedule-undo`** has no
   `scheduleLocked` wiring, so a frozen division shows the raw untranslated
   server sentence there. Deliberately not fixed from this branch: a concurrent
   wave is rewriting that file.
8. **A flake to watch.** The officials walkthrough once timed out at 82.5s
   against its own 82.5s derived budget, on `official-blackout-add` staying
   disabled. Task 5's review identified the mechanism — a controlled date input
   whose `fill()` lost the hydration race, leaving `disabled={busy || !date}`
   true while `click()` waits out the entire test budget — and the two-line
   repair (`toHaveValue` then `toBeEnabled` before the click). **Do not raise
   the budget:** 82.5s is roughly three times the ~25s clean wall clock, so it
   is a stall, not accumulated slowness.
