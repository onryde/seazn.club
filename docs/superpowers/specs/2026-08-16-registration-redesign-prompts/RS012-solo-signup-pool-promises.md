# RS012 — what the solo sign-up pool promises, and what it costs

Paste this whole file as the session opener. Read `_RULES.md`, then
`_INDEX.md` (RS009's section in particular — this session exists because of
what building RS009 exposed), then this file.

Branch `feat/rs012-solo-signup-pool-promises` in a fresh worktree. One PR.
Org-panel AND public surfaces — load `frontend-design:frontend-design`.

Design of record: `../2026-08-16-registration-redesign-design.md` §4–§6, plus
the rulings recorded in this session's own section of `_INDEX.md`.

## Why this exists

RS009 gave organisers the assignment loop the public stepper had been
promising since RS006. Building it exposed two things that loop does not
close, one of which is a live money defect. Neither is a defect IN RS009 —
both predate it — but RS009 is what makes them reachable, because before it
nobody could be placed at all and therefore nobody was really waiting.

**Raised to the owner at the end of the RS009 session and deferred here
deliberately**, per the no-new-issues rule: the assignment loop had to exist
before the promises around it were worth designing.

## The two findings, both verified against the tree

### 1. VERIFIED DEFECT — an unplaced solo sign-up eats a team's slot, and keeps eating it after being placed

`registration-submit.ts` decides capacity with:

```sql
select count(*)::int as n from registrations
where division_id = ${division_id} and status in ${SPOT_HOLDERS}
```

`SPOT_HOLDERS` is `pending|paid|confirmed` (`lib/registration-status.ts`).
There is **no `free_agent = false` filter anywhere in that count**. So:

- A team division with `capacity: 8` — which an organiser sets meaning
  *eight teams* — admits only 2 more teams once 6 people have signed up
  solo. The remaining 6 slots are held by individuals who are not teams.
- Worse, the slot is **never released**. RS009 deliberately leaves the solo
  sign-up's own `registrations` row intact after assignment (it holds their
  money, their consent and their answers — see RS009's tests, which assert
  exactly this). It stays `confirmed` with `free_agent = true`, so it still
  matches that count. A division can read 8/8 FULL while holding two actual
  teams and six people folded into them.

The decision this needs is a product one and belongs to the owner, not to an
implementer: **does `capacity` count entries, or does it count the things
that will actually take the field?** Both are defensible. The current
behaviour is neither — it is an unexamined consequence of solo sign-ups
being stored as `registrations` rows.

Whichever way it goes, the waitlist follows it: a division that reads full
when it is not is waitlisting teams it has room for.

### 2. An unplaced solo sign-up is never told anything

They pay, they read `register.details.freeAgent.note` — "the organiser will
assign you to a team once one has space" — and then nothing happens to them
that anyone can see:

- **No deadline.** Nothing tells them by when they will know.
- **No status.** RS008 shipped `register.status.entry.awaitingTeam` gated on
  `free_agent` alone as a stopgap; RS009 narrowed it. Either way it says
  "waiting", never "waiting *until*".
- **No exit.** If the division starts and they were never placed, there is
  no path that refunds them, withdraws them, or even notices. They hold a
  receipt for a place that does not exist.
- **The organiser has the mirror-image blind spot.** Nothing surfaces "4
  people are waiting and there are 2 free slots across 3 teams" until they
  go looking for it. The pool is a queue nobody is told is a queue.

## Scope

1. **Capacity semantics** — implement whichever answer the owner gives to
   the question in finding 1, and make the count say what it means in ONE
   place. If `capacity` is to mean teams, an assigned solo sign-up must stop
   consuming a slot, and the waitlist has to re-evaluate when one is freed
   (the `promoteOldestWaitlisted` path already exists — reuse it, do not
   fork it). Every changed count needs a test that fails without it.
2. **A place-by date.** Per division, defaulting to something already in the
   data rather than a new required field — the registration close date is
   the obvious candidate. Organiser-editable in the RS004 settings panel.
3. **Registrant-facing promise.** The status page tells a waiting solo
   sign-up what happens and by when, in their own language (×4 locales).
   Once placed, it says which team — RS009 owns `assignedToTeam`; check
   whether that shipped before adding a second one.
4. **Organiser-facing pressure.** The Registrants tab surfaces the pool as
   something needing action, not as a filter chip you have to know to click:
   how many are waiting, how many free slots exist across that division's
   teams, and how close the place-by date is.
5. **The unplaced path.** What actually happens when the date passes and
   somebody is still in the pool. **This is a money decision and needs an
   explicit owner ruling before implementation** — auto-refund and withdraw,
   or surface it to the organiser and let them choose. Do not guess. The
   RS007 findings register is full of money defects that shipped because an
   unexamined default looked correct.
6. **Notifications.** They are told when they are placed (RS009 ships this),
   and they are told if the deadline passes without a placement. Reuse the
   existing mailers; do not add a third unthrottled organiser-triggered one
   (`_INDEX.md` records two already).

## Acceptance criteria

- [ ] The capacity count means one thing, is expressed in one place, and has
      a test that fails if a solo sign-up is counted wrongly — before AND
      after assignment
- [ ] A division whose freed slot promotes a waitlisted team does so through
      the existing promotion path, with the ordering test that path already
      owns still green
- [ ] A waiting solo sign-up sees a date; a placed one sees a team name
- [ ] The place-by date passing produces the owner-ruled outcome, audited on
      the competition_events ledger like every other money event
- [ ] ×4 locales; screenshots 1280/768/320 of every changed surface; the
      registration hub's seven-width matrix coverage (added by RS009) still
      holds and covers the new pool summary
- [ ] Counts from the JSON reporter; `tsc EXIT=0`; lint clean; drift gates
      clean

### Test types

- **Unit** — capacity counting before/after assignment, promotion on a
  freed slot, deadline resolution and its default.
- **E2E** — a solo sign-up registers, sees the promise, is placed, sees the
  team. And the unhappy path: the date passes unplaced.
- **Smoke** — extend the demo so the pool is visible in it.
- **Regression** — the 8/8-full-with-two-teams case from finding 1, written
  to fail against today's code.

## Gotchas

- `SPOT_HOLDERS` is now declared in exactly one place
  (`lib/registration-status.ts`) after RS004 W3b removed a byte-identical
  duplicate. Keep it that way — the capacity question must not reintroduce
  a second list.
- RS009 asserts, on purpose, that assignment leaves the source registration
  `confirmed` and `free_agent = true`. If capacity is changed to exclude
  assigned solo sign-ups, do it by looking at the ASSIGNMENT
  (`registration_players.assigned_from_registration_id`, unique where
  non-null), not by mutating the source row's status — that row holds the
  registrant's money and consent, and withdrawing it to free a slot would
  refund a person who is happily playing.
- A "place-by date" that defaults to the competition's `starts_on` is not
  the same as the division's registration close. Pick one, say which, and
  write it in `_INDEX.md` — RS007 lost time to exactly this class of
  ambiguity with `refund_lock_at`.

## Execution

Scout: the capacity count's every reader (`git grep -a` for
`SPOT_HOLDERS` AND for `from registrations` — raw SQL strings are invisible
to `tsc`, and the RS001 wave's worst miss was three readers found only by
the full-suite rerun). Then the owner ruling on findings 1 and 5 BEFORE any
code. One implementer loop; reviewer focus: capacity double-count, the
promotion race on a freed slot, and the refund path.

## On close

`_INDEX.md`: RS012 → DONE + PR#, the capacity ruling and the unplaced-path
ruling both recorded verbatim with their reasons. Memory + snapshot.
