# B03 wave — review findings, 2026-09-03

Reviewer pass over `origin/main...HEAD` (8 commits) before the PR. Written to
disk rather than left in a session: a finding that lives only in chat is gone
the moment the session is.

**Process note worth keeping.** This wave ran T4–T8 with **zero reviewer
passes** — implementers, then orchestrator-level verification by me. That
verification caught a real defect in every task, which is exactly why the
missing loop did not feel like a gap. It is the reasoning AGENTS.md failure
class 12 warns about ("five implementers back-to-back with zero reviewer
passes; green and still Needs Fixes"). Self-verification by the agent that
wrote the brief shares the brief's blind spots.

---

## F1 — CRITICAL. Officials auto-assign is structurally dead in any live run

Two independent causes, either sufficient. Both confirmed here, not taken from
the report.

**(a) The provisioned plan does not grant it.** `plan.ts`'s
`chooseGrantingPlan` selects the alphabetically-first plan granting
`cricket.dls`, which is `pro`. Queried live:

```
 feature_key    | community | pro | pro_plus
 officials.auto |     f     |  f  |    t
```

Only `pro_plus` grants `officials.auto`. So `officialsAutoGranted` is false on
every real catalog, and `autoAssign` never turns on — the thing T7's commit
message claims it "unblocked".

The suite's own tests say so and it was not noticed: the realistic-fixture test
asserts `officialsAutoGranted === false`, and the only test where it flips true
uses a plan matrix that exists in no migration. A fixture proving a fixture.

**(b) It runs before scheduling.** `officials/auto`'s `engineInput`
(`apps/web/src/server/usecases/officials.ts:386`) filters
`where division_id = ... and scheduled_at is not null`. `seedOfficialsAndClaims`
is called from inside `seedSuite`, which completes before `runTinySuite` drives
the scheduling walk, so the proposal is empty by construction.

**(b) is mine.** T6 shipped this function wired into nothing; I corrected that
as an inert seam and wired the whole of it into `seedSuite`. The inert-seam
correction was right for create/blackout/manual-assign/claim-invites — none of
those depend on scheduling or on an entitlement. It was wrong for the auto
pass specifically, and the file's own header comment had already said why. I
overrode a correct design decision without engaging its stated reason, and left
the comment contradicting the code.

`_tiny`'s `off-eli` official exists solely to exercise this path and never can.

**Fix (owed, not yet applied):** split the two. Keep create/blackout/manual/
invites in `seedSuite`. Move the auto pass to run from `runTinySuite` AFTER the
scheduling walk. And derive the plan per CAPABILITY rather than once for
`cricket.dls` alone — one plan that happens to grant one feature is not a
provisioning strategy.

## F2 — IMPORTANT. `seed.ts`'s header comment is stale and self-contradicting

It states the function is "deliberately NOT called from `seedSuite`" and gives
F1(b) as the reason. The code now calls it from `seedSuite` anyway. Whichever
way F1 is resolved, this comment must move with it — a header that argues
against its own file is worse than none.

## F3 — IMPORTANT. Two fakes script responses the product cannot give

Third occurrence of this pattern in one wave. A fake modelling an impossible
state makes its test worthless while it stays green.

- A non-empty `/officials/auto` proposal for a pre-scheduling division —
  impossible per F1(b).
- A non-empty `warn.official_unavailable` from `schedule/validate`, contradicting
  the same file's comment that this is honestly empty until scheduling precedes
  it.

Both prove wiring and read as if they prove live behaviour.

## F4 — MINOR, confirmed

- `expected_seq: 0` in the DLS probe is asserted by no test; a wrong value would
  409 live and nothing here would catch it.
- `SeedPlan.officialPersonRefs` has zero production consumers — disclosed as a
  reservation for a later task, which is this repo's "seam left for later ships
  inert" pattern.
- `SeededSuite.officialsAndClaims` presence/absence is asserted by no test at
  the `seedSuite` level.

## F5 — MINOR, plausible, unverified

Several belt-and-suspenders throws in `seed.ts` and `dls-gate.ts` have no fake
exercising either branch. Not mutation-run; treat as a lead.

## Clean

T8's `validate-pack.ts` league-stage warning (mutation-swept, the unreachable
`implied > 0` correctly removed); the `--keep` pack-hash and `findExistingSeed`
mechanism (value-pinned, and it explicitly guards the two-same-slug fixture
trap); the `bench-cli` sentinel test; and `seedSuite`'s division/stage/person/
entrant/blackout/manual-assignment bodies, asserted field-for-field.

## Verdict

**Needs fixes.** F1 undoes a stated goal of this wave without disclosure. It is
fixable, and until it is fixed the honest statement is "auto-assign is not
reached in a live run", not "unblocked".
