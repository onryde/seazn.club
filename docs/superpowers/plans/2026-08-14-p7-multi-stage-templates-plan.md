# P7 (D1b) — multi-stage templates, plus the two P6 follow-ups

Session record. Branch `feat/p7-multi-stage-templates`, worktree
`.claude/worktrees/p7-templates`, off `main@cdcc3bef` (P6, PR #568).

Prompt: `portfolio-prompts/P07-templates-multi-stage.md`.
Rules: `portfolio-prompts/_RULES.md` → `_INDEX.md` → `docs/superpowers/RULES.md`.
Specs: `designs/2026-08-13-format-templates-design.md` (D1),
`designs/2026-08-13-stage-progression-design.md` (D4).

Owner green-light 2026-08-14, and it carried an addition: **fix the two
follow-ups P6 shipped knowingly**, not just build P7.

## Scope, and why the follow-ups come first

Three work groups. F1 and F2 are P6's open follow-ups; T1–T4 are P7.

**F1 is not merely a tidy-up — it is a P7 enabler.** `euro24` and
`t20-super8` both end in knockout stages whose fixtures are fed by
earlier matches. If match-sourced slots have no label, P7's own
acceptance criterion ("Super 8 fixtures TBD-labeled") renders as bare
"TBD". F1 therefore lands before the catalog work.

The prompt says "Do NOT touch P5 server internals, stages.ts, engine".
**That stop-clause is overridden for F1 and F2 by the owner's explicit
instruction to fix the follow-ups**, both of which live in `stages.ts`.
It still binds T1–T4: the template tasks must not reach into P5.

## Baseline (measured, not assumed)

Server suite on this worktree BEFORE any edit, fresh DB `:54372` at
v362 + `sync:sports` (11 sports / 31 system variants):

    total 2842 / passed 2810 / failed 4 / files failed 1

The one red file is `schedule-build-honours-locks.test.ts` (4 tests) —
the documented placement-service environmental red; a peer session
closed it as environmental during P6 with the solver up. `numFailed
TestSuites: 5` is five nested `describe`s inside that one file, NOT a
collection failure — reconciled by counting `.testResults[]` (288
files: 1 failed, 287 passed) and confirming no file has zero
assertions. **The final gate must match this baseline exactly**; any
other red is ours.

## F1 — match-sourced slot labels

### What P6 recorded, and what is actually true

P6's follow-up said `slot.winner_match` / `slot.loser_match` have no
production reader and named `stages.ts`'s `homeFrom`/`awayFrom` as the
in-reach third path. Both hold. But re-pinning found **a fourth site
P6 did not know about**, and it changes the shape of the fix:

`apps/web/src/lib/schedule-board.ts:79-91` **already renders this exact
label in production**, as a hand-built English string:

    `${side} of R${round_no} #${seq_in_round}`

So the situation is not "an unused key". It is **two parallel paths for
one piece of vocabulary**, the live one hardcoded in English — a
standing-rule violation (no hardcoded user-facing English) and the
`parallel vocab lookup paths drift` defect class this repo has been
bitten by before.

Re-pinned facts (all verified at `cdcc3bef`):

- `GenFixture.homeFrom/awayFrom: {extKey, side:"winner"|"loser"}` —
  `stages.ts:499-500`, assigned `:519-528`.
- `generateStageFixtures` INSERT — `stages.ts:1016-1031`. Writes
  `winner_to_fixture`/`winner_to_slot`/`loser_to_*` (`:1057-1088`) but
  **never** `home_slot_label`/`away_slot_label`.
- `descriptorLabel` (`stage-seeding.ts:89-100`) emits only
  `slot.winner_group`, `slot.runner_up_group`, `slot.nth_group`,
  `slot.rank_range`, `slot.best_nth` — never the match pair.
- Columns exist since **V360**; `public_fixtures_v` exposes them since
  **V362**. **No migration needed.**
- Preview helper `stages.ts:799-809` builds `R{round} #{seq}` and is
  English-only by design (marketing gallery + `/help/formats`).

### The divergence this closes

| surface | today | file |
|---|---|---|
| org schedule board | "Winner of R1 #2" (hardcoded EN) | `lib/schedule-board.ts:79-91` |
| board card code | "R1·2" (middle dot, no space) | `components/v2/schedule-board.tsx:271` |
| console bracket panel | bare "TBD" | `bracket-panel.tsx:168,323,462,567` |
| public bracket | bare "TBD" | `public-site/bracket.tsx:385-397` |

Two defects in one table: the board tells a user "Winner of R1 #2"
while the card they must match it against is labelled "R1·2", and the
two bracket surfaces show nothing at all.

### Ruling: store data, resolve once, one ref shape

1. **Persist `{round, seq}`, never pre-rendered text.** `SlotLabel` is
   `{key, params}` and is written to the DB. Baking `"R1 #2"` into
   `params.ext` would freeze an untranslatable fragment in every row.
2. **One composition point.** `resolveSlotLabel` resolves
   `slot.winner_match`/`slot.loser_match` by first resolving
   `slot.match_ref` from `{round, seq}` and substituting it as `{ext}`.
   The dictionaries keep ONE definition of the ref shape; the phrase and
   the ref are separately translatable; nothing duplicates the format
   across four files.
3. **The card code uses `slot.match_ref` too**, so "Winner of X" and the
   card labelled "X" are the same string by construction, not by
   coincidence. This is the anti-drift requirement — it is the whole
   point of the task.
4. `generateStageFixtures` writes `home_slot_label`/`away_slot_label`
   for match-fed slots at INSERT (`:1016-1031`), from
   `g.homeFrom`/`g.awayFrom`, when the slot is not baked direct.
5. The preview helper switches to the same params so the marketing
   preview and the live board cannot drift either.

Cost if wrong: the ref shape is cosmetic and reversible; the persisted
`{round, seq}` params are strictly more information than today's
nothing, so no data is lost by changing our minds later.

### Watch

`stages-preview-slot-labels.test.ts` asserts these keys never leak as
literal text into live output. That assertion stays TRUE (keys still
resolve before render) and must not be weakened to accommodate F1 — if
it goes red, the fix is leaking raw keys.

## F2 — the orphaned-fixture hazard

P6 recorded: `generateStageFixtures` only inserts, so a fixture orphaned
by a rules change stays live, can take a time and a result, and pollutes
standings and exports.

**Re-pinning found a guard P6 did not account for.** `replaceStages`
(`stages.ts:260-285`, the only stage-rules edit path,
`PUT /api/v1/divisions/{id}/stages`) refuses with **409 `FORMAT_LOCKED`
if any fixture exists in the division** (`:276-281`). If that guard holds
on every path, the hazard is unreachable and the correct deliverable is
a regression test pinning the guard — not a detector for a state that
cannot occur.

This is the same shape as the P6 blast-radius ruling that the
whole-branch review overturned: a hazard inferred from a design doc and
never checked against the code. Reachability was therefore verified
before anything was built.

### Verdict: NOT REACHABLE. P6's follow-up 2 rested on a false premise.

Two properties make the orphan state impossible, and they compose:

1. `replaceStages` is the **only** writer that mutates `kind`, `seeding`
   or structural `config` on an existing stage row, and it refuses while
   any fixture exists in the division — under
   `pg_advisory_xact_lock('division:<id>')` taken in the same
   transaction (`stages.ts:275-283`), so it is not raceable.
2. `fixtures.stage_id` is `on delete cascade`
   (`db/migration/v2-engine/tables/V214__fixtures.sql:6`). Every other
   rules-edit route is delete-and-recreate, which takes the fixtures
   with it.

A full bypass sweep (`insert into stages` / `update stages` repo-wide)
found no other writer of `stages.seeding`, and `undoDivision` /
`redoDivision` have **no case that touches `stages` at all** — redo of a
generation re-runs against current rules, so it produces a consistent
result, never an orphan.

**So P6's stated hazard is not a defect and no detector will be built.**
Writing one would have been building for a state that cannot occur —
which is exactly the mistake P6's overturned ruling made, in the
opposite direction. Recording the false premise IS the deliverable, plus
a regression test that pins the two properties above so the thing making
it unreachable cannot be deleted silently.

### But the investigation found two REAL defects

**F2a — the seeded path is missing the plain path's too-few-entrants
guard.** `generateStageFixtures` guards with `group_too_few_entrants`
(`stages.ts:994-1005`); `generateSeededStageFixtures` (`:1328`) has no
equivalent. A `.seeding` group stage whose qualifier count cannot fill
its pools generates *some* fixtures, leaves the under-filled pools'
seeds with no slot, and then every `POST /stages/{id}/seed-proposal`
422s `SEEDING_RULES_MISSING` — "regenerate them first", **advice that
cannot work**, because regeneration is idempotent by `ext_key`. That is
a genuine dead end a user can reach and cannot escape.

This is the real "generation reporting what no longer matches" that P6
said was owed — for the failure that actually exists rather than the one
it imagined. **In scope, fixing it.**

**F2b — the format lock is division-wide, freezing later stages.** The
guard joins `stages s on s.id = f.stage_id where s.division_id = …` with
no per-stage predicate, so generating stage 1's fixtures freezes the
rules of every later, unplayed stage. `PUT /divisions/{id}/stages` is
all-or-nothing; `deleteStage` removes only the LAST stage. Editing stage
2 of 3 therefore means tearing down 3, then 2.

This lands directly on P7: a multi-stage template that generates
fixtures at instantiation could be format-locked at birth. Whether it
actually is depends on whether an entrant-less stage produces any
fixture rows — being verified before T3 is written.

**Ruling: do not redesign the stage-edit API in this session.** Narrowing
the guard changes `replaceStages` semantics on a shared release-2
surface — past this task's blast radius, and the standing rule says
escalate rather than silently widen. F2b is pinned by a regression test
recording current behaviour and surfaced to the owner.

## P7 tasks

Re-pinned targets (all live at `cdcc3bef`):

- `templates/schema.ts:51-73` — `TemplateStage`; `:22-25` is an explicit
  comment reserving `seeding` for P7.
- `templates/catalog/` — 5 JSONs: `slam128`, `swiss11`, `wc32`,
  `americano-night`, `box-league`; loader `catalog.ts:17-23`.
- `usecases/templates.ts:75-92` `createFromTemplate`, `:98-104`
  `instantiateTemplate`, `:253-257` the stage INSERT. Calls nothing from
  stage-seeding today.
- `templates/__tests__/schema.test.ts` (4), `usecases/__tests__/
  templates.test.ts` (14); pinned-shape table `:437-452`, an inline
  `it.each`, not a snapshot file.
- `components/v2/template-gallery.tsx:88` `TemplateDetailSheet`,
  per-stage render `:178-193`.
- `StageSeedingSchema` / `StageSeedingInput` —
  `api-v1/schemas.ts:543-555`. **Import it; never redeclare.**

**`page_playoff` is DB-checked** (`V298__page_playoff_stage_kind.sql`;
the api-v1 `StageKind` enum's 9 values match the CHECK). The design
doc's fallback to `knockout(4)` is therefore NOT taken — `league-playoff`
ships with a real `page_playoff` stage.

**T1** — `TemplateStage.seeding?: StageSeedingInput`, importing
`StageSeedingSchema`. One vocabulary; a fork here is the defect class
the prompt names explicitly.

**T2** — three catalog entries. `euro24` first: it is the hardest, its
best-thirds map is the one that will expose a schema that cannot express
what templates need, and it is cheaper to discover that before the other
two are written. Then `t20-super8`, then `league-playoff`.

**T3** — instantiation persists `seeding` on the stage rows. Two things
had to be settled first, and both changed the task:

1. **The stage INSERT does not write `seeding` at all today.**
   `templates.ts:253-263` inserts only
   `(division_id, seq, kind, name, config)` — unlike `createStages`
   (`stages.ts:227-233`). So "templates cannot express a seeded stage"
   is true at the persistence layer too, not just in the zod schema.
   T3 adds the column to that INSERT.

2. **Instantiation must NOT generate fixtures.** See the ruling below.

### Ruling: instantiation persists seeding rules, generates NO fixtures

The prompt says instantiation "generates seeded stages + their TBD
fixtures via P5's pathway". Taking that literally ships a product
defect, so it is not taken literally.

The chain: a `.seeding` stage bypasses the entrant query entirely and
mints synthetic entrants from its seeding rules
(`stages.ts:1348-1354`), so unlike a plain stage it CAN generate
fixtures with zero real entrants. One fixture row anywhere in the
division then trips the division-wide lock — in **two** places, not
one: `replaceStages` (`stages.ts:276-281`) and `patchDivision`
(`divisions.ts:556-563`, the identical `exists(...)` check).

Consequence if we generated at instantiation: the moment an organiser
picks a template, they can no longer change the division's format OR
its `variant_key`/config — **before adding a single entrant**. The only
escape is `deleteStage`, which removes the tail stage only. For a
feature whose entire UI story is "preview the structure, then adjust",
that is backwards.

Today's code already refuses this deliberately, with a comment
defending it (`templates.ts:258-262`: "No fixtures at instantiation
time by design: entrants don't exist yet"). **Ruling: keep that
invariant.** T3 persists `seeding`; TBD fixtures arrive from the
existing Generate action, which already handles `.seeding` stages
through `generateSeededStageFixtures`.

The acceptance criterion still holds — the e2e creates from template,
adds entrants, generates, and then sees TBD-labelled Super 8 fixtures.
One extra step, no defect.

Cost if wrong: TBD fixtures appear on Generate rather than at
instantiation. That is a small follow-up **once F2b narrows the lock** —
and F2b is precisely the blocker that makes generating-at-instantiation
unsafe today. The two findings are the same finding.

**T4** — detail sheet renders the progression map textually
("Top 2 per group → QF"), i18n ×4, full polish, 320/768/1280.

## Tests owed (all four, per RULES)

Unit: 3 entries parse + instantiate; seeded stages carry rules AND
fully-TBD fixtures with correct slot counts (euro24: 16 R16 slots incl.
4 best-third sources). F1: label resolver over `{round, seq}` in 4
locales, and generation writing labels for match-fed slots.
Regression: the pinned-shape table extended, **P4's 5 entries
byte-stable** — adding multi-stage must not disturb single-stage output;
plus F1's board-vs-card ref equality (the anti-drift assertion).
E2E: create from `t20-super8` → three stages visible, Super 8 fixtures
TBD-labeled — in `mobile.spec.ts` so it gets the seven-width matrix.
Smoke: one multi-stage from-template creation.

## Environment

Postgres `:54372`, `data_directory=/tmp/p7-pg` confirmed mine — `:54357`
and `:54371` were both squatted by other sessions and each produced the
documented `START_EXIT=1` + foreign `data_directory`; the ownership
guard aborted before `createdb` could touch either. v362,
`sync:sports` 11 sports / 31 system variants. `readlink -f
node_modules/@seazn/engine` resolves inside the worktree.

**The prompt's verify block runs vitest from the repo root**, which
yields `Cannot find package '@/...'` and a fake red across hundreds of
suites. Run it from `apps/web`. Same bug as P06's block.

## `_INDEX.md` ruling

`_RULES.md` §5 and `_MASTER.md` step 7 both require the session to
update the programme index on close. A standing memory says sessions
must NOT edit it — but gives its reason: "it conflicts every single
wave; the orchestrator writes the outcome at the boundary."

P7 runs ALONE (W4's `P6 ∥ P7` was superseded when P6 ruled P7 runs after
it merges), and it is the last lane of W4 — so this IS the wave
boundary the memory reserves the update for, and the conflict risk it
guards against does not exist. **Ruling: update the index in this PR**,
including the rows for P2/P4/P5/P6 that are stale (all merged, rows
still say IN FLIGHT/TODO) and actively misleading the next session.
Cost if wrong: one markdown merge conflict.
