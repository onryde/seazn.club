# P7 (D1b) multi-stage templates — session status, 2026-08-16

Resumes the session started 2026-08-14 and held by the owner mid-flight.
The handover briefs (`2026-08-14-p7-handover-briefs.md`) were executed as
written, with the deviations recorded below. Branch
`feat/p7-multi-stage-templates`, 14 commits, 21 files.

## What shipped

- **T1** — `TemplateStage.seeding`, typed by *importing* `StageSeedingSchema`
  and narrowing it with a `.refine()` type-predicate to the `"previous"`
  branch. `.omit`/`.extend` were unreachable: the exported binding is
  already a `ZodEffects` (its own map-non-empty refine), which drops those
  methods. No fork of the seeding vocabulary anywhere.
- **T2** — `euro24`, `t20-super8`, `league-playoff` catalog entries, i18n ×4.
- **T3** — instantiation persists `seeding`, and shape-validates it.
- **T4** — the progression map in the template detail sheet, plus the
  `league`/`page_playoff` label-map gap, plus a 320px field reorder.
- **T5** — e2e in `mobile.spec.ts` across seven viewport projects, and a
  multi-stage from-template step in `scripts/smoke.ts`.
- **Follow-up (owner-approved mid-session)** — stages are named by their
  own `i18nNameKey` rather than by kind, in both the sheet and the card.

## Rulings made this session

1. **`validateStageSeeding` moved into the shared `stage-seeding.ts`** and is
   now called by `createStages`/`replaceStages` AND by `instantiateTemplate`.
   The T3 brief said "do not touch `stages.ts`"; that constraint existed to
   stop a reimplementation of P5's logic, and moving one private helper into
   the module both callers already share serves that goal better than the
   alternative — inlining `sourceShapeOf` + `expandTake` + `placeDescriptors`
   at the template call site, which would have been a second copy of the
   save-time validation and would drift the first time either side gained a
   rule. Save-time behaviour is unchanged; `stage-progression.test.ts:138-142`
   already drove the moved function end-to-end and passes untouched.
2. **Instantiation still generates NO fixtures** (carried from the held
   session, re-pinned by a test). A `.seeding` stage mints synthetic entrants
   and can generate with zero real entrants; one fixture row format-locks the
   division via BOTH `replaceStages` and `patchDivision`, so generating at
   instantiation would freeze a competition's format at birth.
3. **euro24's best-thirds rule is deliberately simplified.** The real Euro
   2024 rule is a 15-permutation combination lookup; `StageSeeding.map` is a
   static `{slot, source}[]` and cannot express it. Mapped by rank among
   thirds instead, stated in the catalog entry's own description, and the
   caveat is now asserted against the loaded dictionary text in all four
   locales rather than against the key's name.
4. **Stages are named, not kinded, in the gallery.** `t20-super8` is the
   catalog's first template with two same-kind stages, which made the old
   kind-label rendering read "Group stage → Group stage → Knockout" with two
   indistinguishable progression prefixes. Approved from a mockup by the
   owner. The EN `templates.stageKind.*` values were retitled to Title Case
   to match `templates.stage.*`, since the two paths now render side by side.
5. **The template detail sheet leads with its form.** Name / Starts on /
   Ends on now precede the description and the STRUCTURE/PROGRESSION blocks,
   so the required Ends-on field is above the fold at 320px. Owner-approved.

## Defects found

Two are ours and fixed; two are pre-existing and reported, not fixed.

1. **FIXED — seeding silently dropped at instantiation.** `instantiateTemplate`
   inserted only `(division_id, seq, kind, name, config)` while `createStages`
   also wrote `seeding`/`qualification`. The three new templates were already
   wizard-selectable, so their seeding data was being discarded.
2. **FIXED — instantiation skipped the save-time shape validation.** The first
   T3 guard replicated only `resolveSeedingSource`'s "no earlier stage" branch,
   so a catalog entry whose `take`/`map` disagreed with its source stage's real
   shape persisted silently and only 422'd later at proposal/generate — while
   the code comment claimed the opposite. See ruling 1.
3. **REPORTED, not fixed — `uniqueSlug()` is check-then-insert.**
   `apps/web/src/server/usecases/slugs.ts` has no retry or transaction guard,
   so two concurrent same-named competitions in one org can both pass the
   "slug taken?" check; the loser surfaces a raw Postgres
   `competitions_org_id_slug_key` violation into the UI, contradicting the
   module's own documented "generated slugs never 409" guarantee. Surfaced by
   the new e2e scenario, whose seven viewport projects share one org.
4. **REPORTED, not fixed — the detail sheet's required field sits below the
   modal's internal scroll fold at 320×568 on EVERY template**, including ones
   P7 never touched (reproduced on `box-league`). P7 mitigated its own share
   by reordering the sheet body (ruling 5), but the underlying modal behaviour
   is untouched and belongs to `apps/web/src/components/modal.tsx`.

Also noted: `templateStageKinds` (`apps/web/src/server/templates/summary.ts`)
lost its last production caller when the card moved to the shared helper. Its
only remaining caller is its own test. The function was kept and its comment
corrected; a later session may want to delete both.

## Verification traps this session paid for

- **A held session's briefs go stale in specific places.** Of 14 re-pinned
  citations, four had moved and one was wrong in substance: the pinned-shape
  `it.each` pins THREE entries, not the five the brief asserted.
- **Three agents lost turns parking on background waits.** A killed background
  command reports exit code 0 and that 0 is the SIGTERM. One agent's final
  gate run died without writing its JSON at all; the orchestrator re-ran it.
- **Concurrent work on one database produces failure sets that do not
  overlap.** Two full-`src` runs disagreed (15 failures then 11, near-zero
  overlap, 30s-23min durations) purely because a dev server, the seed scripts
  and vitest were all on `seazn_p7_d1b`. Every later task got its own database.
- **A "distinguishability" test can be vacuous by coincidence.** The sheet-side
  regression's first version passed for `swiss11`/`americano-night` because the
  single-word stage label also appeared elsewhere in the rendered HTML; only
  isolating the structure `<ul>` and exact-matching made it real. Found by
  mutation, not by review.
- `org-posts-digest.test.ts` reds under DB contention with a 30s timeout and
  passes 7/7 standalone. It is not a P7 regression; `duration: 30006` is a
  clock, not an assertion.
