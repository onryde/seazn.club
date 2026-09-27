# W1d — CI + the first full truth run

**Goal.** When this wave is done the matrix runs itself: weekly and on dispatch,
sharded on fresh databases, guarded against a silent bill if the repo goes
private, with a weekly Stryker mutation run — and the first full truth run has
been triaged. Every red is attributed to exactly one wave, so W2–W7 each start
from a measured backlog instead of an audit's guess. For an organiser, this is
the moment the ~150 audit hypotheses become a list of reproduced problems.

## Read first

- `_RULES.md` (R5, R10, R12, R14, R14a, R25) and `_INDEX.md` (rulings 16, 19,
  20, 21 and the "going private" recommendation — **not** a ruling).
- Design §2 (case states, wave done), §6.4, §6.5 (cadence, cost, visibility
  guard, three green dispatches), §7.3 ("W1's truth run is a floor"), §7.5
  item 2 (Stryker), §8 (the routing table you triage into), §9.
- Audits: all five gap files (`SW-`, `FX-`, `ST-`, `SC-`, `SH-`) — you triage
  reds against them; `plan-facts-repo.md` §5 (workflows, `bench.yml`
  precedent, `help-shots.yml` schedule precedent), `bench-reuse.md`.

## Prerequisites

W1a, W1b, W1c merged (design §8 order, R1).

## Scope

- Shards, fresh DB per shard with `sync:sports`, per-case timing.
- Weekly scheduled + `workflow_dispatch` workflow with the visibility guard;
  per-PR sample (L3 for touched rows + a fixed sample, R27).
- Weekly Stryker run on engine scheduling, competition and tiebreaker modules;
  mutation-score floor set from the first measured run, only allowed to rise.
- **The first full truth run** and triage of its reds into waves.
- **Routed gaps: none owned.** Triage routes reds to the §8 owner; it never
  re-routes a gap §8 already assigns.

## Lifecycle

No rulebook step (harness wave). §10 steps 4, 5 and 7; step 3 *is* this
wave's deliverable, run on every row instead of one wave's.

## Decisions owed

None from §11 (O1 is ruling 20). The private-repo runner plan stays a
recommendation until the owner rules it at the switch — do not implement a
self-hosted runner now. If a red has no §8 owner and no format/sport owner under
the §8 preamble, put the assignment to the owner as a recommendation.

## Done when

- Three consecutive green manual dispatches before the schedule is enabled
  (`bench.yml` R84 precedent). The design does not say what "green" means for a
  run whose purpose is to find reds — put a definition to the owner as a
  recommendation before the first dispatch (suggested: the harness completed
  and wrote a full `MATRIX.md`; product reds are data, harness errors are red).
- The visibility guard is proven by a mutation (private → the job fails loudly).
- First truth run triaged: every ❌ carries its gap ID and owning wave; every
  audit gap that did not reproduce is in "False premises found" (R5); every
  non-behavioural gap is marked verified-by-read or verified-by-failing-test.
- Stryker floor recorded; surviving mutants listed. No previously green CI job red.

## Traps

1. **Dispatched e2e runs use `main`'s workflow file** — pass `--ref <branch>`
   when the branch edits it; a push to `main` cancels a dispatched run, and
   "cancelled" is not a pass.
2. **All jobs red, zero steps, ~3 s is a billing block**, not a defect; zero
   steps is a runner that never started. Environment before defect (class 14).
3. **The repo is public** (R14a): every log and artifact is public. Synthetic
   orgs and people only; never echo a token, magic link or DB URL.
4. **The truth run is a floor** (§7.3): it has invariants only. Do not tell a
   wave its backlog is complete; the reference families arrive later.
5. **A killed background command exits 0** (that is the SIGTERM). Have each
   shard write `EXIT=$?` itself, and check that every shard's JSON exists and
   is non-empty before the matrix is generated (R25).

## Output and handoff

Write the triaged ❌ list per wave into `_INDEX.md` (a short table per wave or
a linked file), update the W1d row and the decision log as each dispatch lands
(R22), and flip W2's status to "backlog ready" only when its list is written.
