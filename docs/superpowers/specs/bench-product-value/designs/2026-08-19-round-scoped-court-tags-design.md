# Round-scoped required court tags (#622)

Follow-up to the P9 venues-scheduler third review (#621). Closes the gap that
review deferred, and pays the debt `docs/superpowers/plans/2026-08-17-p9-session-status.md`
booked under "Deferred with reason: stage-level required_court_tags".

## The gap

`required_court_tags` filters candidate courts at two scopes, `divisions` and
`stages` (both `text[]`, V367). QF, SF and the final of one knockout stage share
a single `stages` row — their round role is computed positionally at display
time (`roundRole()`) and never persisted — so a stage-level tag says "every
knockout match must be indoor" and cannot say "only the final needs the
championship court".

## Decision 1 — rounds are addressed by ROLE, not by `round_no`

The obvious key is an int matching `fixtures.round_no`. It is wrong for a rule
an organiser AUTHORS, and `constraints.ts`'s `FixtureSelector` already said so
for the identical reason in a different rule family:

> an elimination bracket numbers sparsely (1,2,3 winners / 7-10 losers / 14
> grand final) and a USER-FACING RULE keyed on one would silently address the
> wrong fixtures

Two concrete failures a `round_no` key ships with:

- A double-elim stage numbers WB, LB and GF in ONE space. "The grand final" is
  not expressible; round 7 names a losers round at 8 entrants and something
  else at 16.
- Resizing a draw renumbers every round. A rule written against "round 3"
  silently moves to a different round, with no error and no visible change.

So `stage_round_court_tags.round_role` stores a `roundRoleKey()` value —
`final`, `semi_final`, `quarter_final`, `round_of_16`, `losers_round_2`,
`grand_final`, `rung_3`, `plain_round_4`. A role survives a resize: "the final"
is `final` at 8 entrants and at 64, and the two lanes' finals are distinct keys.

`roundRoleKey`/`parseRoundRoleKey` live beside `roundRole()` itself, so the
vocabulary an organiser can address is by construction the vocabulary the
display already names. `JSON.stringify(role)` was rejected: key order and any
future field would change the bytes of an already-stored primary key.

## Decision 2 — round-robin stages need no second scheme

The issue's second open question. `roundRole()` was previously only safe for
bracket kinds — every caller guarded it with its own copy of
`BRACKET_STAGE_KINDS` — and a `league` fixture reaching it read its column
defaults as bracket facts (lane null, `roundInLane === lastRoundInLane`, i.e.
`fromEnd === 0`), so round 1 of a one-round league came back "Final".

`roundRole()` now answers for EVERY stage kind, returning `plain_round_N` where
a round is an ordinal rather than a bracket position — which is what the
`plain_round` member of the union, declared but unreachable since F1, was always
for. A league addresses its rounds through the same column, the same key
vocabulary and the same resolution path as a knockout. Making the ordinal a role
is what avoids a parallel scheme; making the role an ordinal would not have.

## Decision 3 — a new table, not a column

`stage_round_court_tags (stage_id, org_id, round_role, required_court_tags,
created_at)`, PK `(stage_id, round_role)`, composite FK to `stages (id, org_id)`
(V367's own argument: `scripts/check-rls.ts` enumerates only tables that HAVE an
`org_id`, so a tenant table without one ships as a table the RLS guard skips
silently). `stages` gains `unique (id, org_id)` to hang that FK on.

Rejected alternatives:

- **A `jsonb` map on `stages`.** No FK, no per-row RLS, no index, and a
  malformed key is invisible until resolution time.
- **A per-fixture `required_court_tags` column.** A rule must survive fixture
  REGENERATION (`rebuildStageFixtures` deletes and recreates rows), and a
  per-fixture column is destroyed by it. It also makes "the final" a fact an
  organiser has to restate on every draw change.
- **A pg enum for `round_role`.** The vocabulary is owned by the engine and
  grows with new stage formats (page-playoff's `qualifier1`/`eliminator`/
  `qualifier2` arrived after `knockout`'s). An enum puts a migration between the
  engine gaining a format and an organiser being able to tag it.

A row naming a role no current fixture occupies is INERT, not corrupt —
deliberately, so a rule can be written at setup time before the draw exists.

## Decision 4 — resolution is per FIXTURE, in one place

The scopes now narrow in sequence: division ∪ stage ∪ round role. Three paths
consume the answer (`autoSchedule`, `buildSchedulePack`, `validateScheduleIn`)
and all three previously resolved it per SCOPE, which round tags make
impossible: a stage's fixtures no longer agree about their candidate set.

Neither approximation is safe. `candidateCourts` reads a required-tag list as
AND, so flattening two rounds' tags into one list demands a court carry the
final's tags to host a quarter-final; taking the union of the two resolved COURT
sets instead lets a quarter-final court host the final. `validateScheduleIn`
shipped the court-set union in #11 as the closest safe approximation available
at the time, and its own comment recorded that. #622 replaces it with the exact
answer.

`court-candidates.ts` gains `requiredCourtTagsByFixture` (three queries for a
whole division, never one per fixture) and `candidateCourtsByFixture` /
`tagQualifiedCourtIdsByFixture` (memoised on the tag union, so a 200-fixture
division issues one or two court scans, not 200). All three consumers call
those; a second copy at any call site is the placer/verifier fork
`court-candidates.ts`'s header opens by warning about.

This is also the debt the P9 status doc booked: "Owed when
`stages.required_court_tags` gains a write path: per-fixture stage-tag
resolution in all three paths, through the one shared `candidate-courts`
function — not three copies." The write path
(`PUT /api/v1/stages/{id}/court-tags`) and that resolution ship together.

## Decision 5 — the solver learns per-fixture court domains

`SlotConfig.courts` is one list for the whole run, so it cannot express "the
final needs the championship court, the quarter-finals do not". Narrowing it to
the intersection over-constrains every earlier round; widening it to the union
constrains none of them.

`SchedulableFixture.allowedCourts` carries the per-fixture set. `slotFixtures`
(greedy) skips a disallowed court; `build.ts` forwards it as
`Fixture.allowed_court_indices` (proto field 5) and `model.py` section 1c pins
`presence_court[i][c] == 0` for a disallowed court — the same unambiguous form
section 1b already uses for a slotless court, rather than an empty `Domain`.

EMPTY MEANS UNCONSTRAINED at every layer (wire, engine, placer), matching
`candidateCourts`'s reading of an empty required-tag list. A fixture that is not
narrowed sends nothing, so a board that does not use the feature produces a
byte-identical request and a byte-identical CP-SAT model — pinned by
`test_an_unconstrained_fixture_adds_no_constraints_at_all`.

A `locked` placement is NOT filtered by `allowedCourts`: an organiser's own pin
outranks a tag rule, and refusing it would make a published board
unrepresentable (ruling 3, candidate-courts.ts). The verifier reports such a row
as `court_tag_mismatch`, which stays a non-blocking, acknowledgeable warning for
the reason `isBlockingConflict` already documents — adding a round rule to a
board that already exists must not hard-refuse publish with no way out.

## Not in scope

- `PinnedRow` gains no `allowed_court_indices`. A pin does not move, so a court
  domain for it would constrain nothing.
- Round-scoped anything ELSE (rest, day caps, session windows). The role
  vocabulary and `parseRoundRoleKey` are reusable if a later rule family wants
  them; nothing here presumes it will.
