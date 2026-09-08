# B05 review findings — running record

One row per finding, written as it happens rather than reconstructed at the
end. Reviews on this wave are per-task (implementer → reviewer → orchestrator
re-gate), per `_MASTER.md`'s session lifecycle and AGENTS.md failure class 12
("five implementers once ran back-to-back with zero reviewer passes; the wave
was green and still Needs Fixes").

Branch `feat/bench-b05-simulation`. Design of record:
`designs/2026-09-07-b05-simulation-layer-design.md`. Re-pins:
`B05-repins-2026-09-07.md`.

## Verdicts so far

| task | commits | reviewer | verdict | findings |
|---|---|---|---|---|
| T0 plan chooser | `599ca30fd`, `ec3fb4665` | subagent | SHIP | 2 MINOR, 1 fixed, 1 declared theoretical |
| T1 single-POST fold | `c8da050c0` | subagent | SHIP | none |
| T2 import fold | `2841ae8f7`, `7716a0e98` | subagent | SHIP | 3 MINOR, all fixed in T2.5 |
| T2.5 division start (D9) | `1974dbb23`, `b488ea5de` | subagent | SHIP | 2 MINOR, 1 fixed in T3, 1 accepted |
| T3 advancement + pack stage | `a1d4f573f`, `55171ef13`, `6dee0d855` | **orchestrator** (subagent stalled twice under machine load) | SHIP | 1 MINOR, fixed `2915d3fa0` |
| T4 comparators | `c731357ed`, `1794992c9`, `6695c65c2` | subagent | **NEEDS FIXES** | 2 MAJOR, 1 MINOR — being fixed in T5a |
| T4b wiring | `34b7dfb8c` … `28291950e` (8) | subagent (same pass) | — | see above |

## Findings, with what happened to each

### F-T0-1 — the catalog guard claimed to cover renames and did not (FIXED `ec3fb4665`)

T0's migration-derived plan guard parsed inserts minus deletes; its commit
message claimed it guarded "retirement/rename". Every migration in this tree
retires a plan by inserting the replacement and deleting the old row, so no
delta exercises a rename and the prose could stand unchallenged. Now handles
`update plans set key = …`, with a synthetic-SQL witness (no real delta can
provide one) and the direction nobody would notice being wrong pinned too: a
rename of a key that was never inserted must add nothing. Mutant `void ren`
reds exactly that test.

### F-T0-2 — privilege score could miscount an all-NULL row (ACCEPTED, theoretical)

`PlanCandidateInfo.privilege` counts unbounded int caps; a boolean-feature row
with both `bool_value` and `int_value` explicitly NULL would read as an
unbounded cap. No such row exists in any migration (V101/V112/V270/V290/V341/
V393 checked). Recorded rather than fixed.

### F-T2-1/2/3 — three MINORs (ALL FIXED in `1974dbb23` / `b488ea5de`)

`eventsPerCall` had only a far-over chunking case (added exact-at-cap and
one-over, independent of the streams cap); `ImportFindingReport` had no `kind`
discriminator and readers inferred the kind from which optional fields were
populated; `resolvePayloadRefs`, shared with the import fold, threw with a
hardcoded `"simulate:"` prefix so an import failure reported itself as a
simulate failure.

### F-T2.5-1 — a missing checker read as a clean one (FIXED in `55171ef13`)

D9 says a blocking-conflict refusal reports BOTH sides — the product's
conflicts and the checker's verdict on the same board. `checkerClean` was
attached only when the board fetch had succeeded, so a half-failed scheduling
walk would have degraded silently to one side that reads as clean. The
omission is now explicit.

### F-T2.5-2 — the acknowledged retry's own refusal is not chased (ACCEPTED)

If the retry is refused again, its conflict list is folded into a generic
"still refused" error rather than reported. Consistent with the stated policy
and exercised by a test; noted as the one branch where a second warnings list
is discarded.

### F-T3-1 — the new stage filter could empty a board and call it clean (FIXED `2915d3fa0`)

**The most valuable finding of the wave so far**, because its failure mode is
silent. T3 scoped the board fetch to the stage being scheduled — correct, and a
no-op on single-stage divisions — but compares `stage_id`, which the bench's
`WireFixture` types as optional while `S.Fixture`
(`api-v1/schemas.ts:1091-1093`) declares it required. Had that field ever
stopped arriving, every row would fail the comparison, the board would come
back EMPTY, and an empty board has no unplaced fixtures and no conflicts: a
clean judgement over nothing at all.

Now reds with both counts named, into the division's own error sink so it
reports as a finding rather than crashing the walk. Witness: a test masking
every fetched row's `stage_id` to a foreign value — a state no pack can
produce. Neutering the guard (`if (false && …)`) reds exactly that test,
78 → 77; restored 78/78.

### F-T4-1 — a third unwired comparator, and the only one nobody disclosed (OPEN, T5a)

MAJOR. `compareTieOrderCascade` (`oracle.ts:410`) has no call site anywhere in
`lib/suites/tiny.ts`. Two other comparators were knowingly left unwired for
want of a pack subject and were reported as such; this one was not mentioned in
any commit message or hand-off, so it would have shipped as an inert seam with
nobody counting it as owed. `_tiny` genuinely has no tied rows (7≠1, 2≠0), so
it needs a pack subject as well as a call site — and the tie has to be
ORDERING-DIFFERENTIAL, or the case cannot witness which cascade ran.

The lesson is not "wire it": it is that the vacuity ledger has to be written
down and checked against the code, because a comparator nobody remembers is
indistinguishable from one that passes.

### F-T4-2 — the D1-critical comparator passes on empty/empty (OPEN, T5a)

MAJOR. `compareRankCrossings` (`oracle.ts:483-491`) returns `matched: true`
when both the captured ranks and the standings ranks are empty: `[].every(...)`
is vacuously true and the lengths agree at 0. No test covers empty/empty
(`oracle.test.ts:355-380` covers agree, disagree, absent-capture). Production
is masked today only by the sibling `standingsVsExpected` check at
`tiny.ts:2833` reddening independently — two guards covering for each other,
which AGENTS.md failure class 3 says means neither is tested. Fixed in T5a as
`matched: false` with a reason, plus the empty/empty test and its positive pair.

### F-T4-3 — leaderboard's empty case is unit-only (OPEN, T5a)

MINOR, same class: standings' empty-actual case is proven through the wire
(`a830a775a`), the leaderboard's only in the comparator's own unit test.

### Verified as sound in the same pass

The D6 mis-attribution regression runs through the real `runTinySuite` against
a mutated temp pack, not a fixture; the two rank crossings come from genuinely
separate fake responses, so the "they disagree" test is not a tautology; the
narrowed `/stats/players` → `/persons/{id}/stats` assertion in
`tiny-suite-stats.test.ts` is a narrowing, not a weakening (the baseline oracle
name and warning still assert the original intent).

## Corrections to this wave's own documents

- **F1 was too narrow** (fixed `698476409`). The design doc and re-pin record
  said `stage_completed`/`finalRanks` appears "for a ladder/bracket
  completion". It is emitted for EVERY stage kind:
  `packages/engine/src/competition/stage.ts:237` (table/pool, ranks from
  `crossPoolOrder`), `:275` (bracket, `bracketRanks`),
  `engine-db/competition.ts:498` (ladder, `config.ladder_order`). The error
  came from grepping `finalRanks` inside `competition.ts` and reading the one
  arm that matched as the whole story — the table path's emission lives in the
  engine package and never appeared in the hit list. A grep is not a read.
  The load-bearing half of F1 is unchanged: the complete-call RESPONSE is the
  only time the ranks cross the wire.

## Product findings owed to bench spec §15

Not bench bugs — things the bench learned about the product, to be written into
the spec's §15 appendix at T7/T8 rather than filed as issues (`_RULES.md` §1,
spec §7 both forbid filing):

1. **The product has no champion concept on the wire.** Grep
   `champion|winner_entrant|division_winner` across `apps/web/src/server` and
   `apps/web/src/app/api/v1`: zero code hits, only marketing copy. "Who won"
   is expressible only as `rank: 1` in a final stage's standings or
   `finalRanks[0]` in a complete-call response.
2. **`finalRanks` is unreadable after the fact.** `GET /divisions/{id}/history`
   selects `seq, type, actor_id, created_at` and not `payload`, so the ranks a
   completion computed cannot be re-read by any client that missed the
   response. Worth knowing before a UI tries.
3. **`event-import.ts` cannot be imported by any non-Next consumer** — it opens
   `import "server-only"`, a webpack alias with no package behind it, so
   `IMPORT_CAPS` had to be hand-mirrored with a text-diff guard. The same is
   true of `lib/schedule-board.ts` (via `@/lib/zoned-datetime`) for the two
   publish refusal codes.

## Still owed

- T4 oracles, T5 suspension carry + specials, T6 people layer, T7 report
  sections + provenance, T8 the live `_tiny` run.
- A clean full-suite number on a quiet box (the `strip-types-loadable.test.ts`
  reds under load average 40+ are environmental — every module loads directly
  under `node --experimental-strip-types` in 3-12s, exit 0).
- The whole-branch review before the PR, and §15's three entries above.
