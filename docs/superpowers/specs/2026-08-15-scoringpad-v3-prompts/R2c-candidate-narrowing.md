# R2c — candidate narrowing: the chassis capability, and cricket's three consumers

Owner-assigned 2026-08-17, to run **in parallel with R2b's merge gates** and
**before R3**. Read `_RULES.md` and `_INDEX.md` first; the evidence behind
every claim here is in `R2b-remaining.md` §C.

Branch: `feat/scorepad-v3-r2c-candidate-narrowing`, in its own worktree
(`.claude/worktrees/r2c-candidates`), off `main` — **not** off R2b's branch.
See "Overlap with R2b" below before you start.

## The thesis

Three open cricket defects look unrelated and are one missing capability:
**the chassis cannot narrow a candidate list to who is eligible RIGHT NOW.**

- `ContextSlot` has `pool` but no side or predicate, and `pad-host.tsx` feeds
  it `combinedPool(squads)` — BOTH squads.
- `attribution-picker.tsx`'s `candidatesForPerson` always loops both sides.
- `PadAttributionItem` (`packages/engine/src/sport/module.ts`) has no `side`
  field for the picker to filter on even if it wanted to.

So this is not cricket cleanup. It is a capability **every remaining sport
needs** — football substitutions, badminton service, any sport where "eligible
now" is narrower than "on the squad". Ten skins are about to be written; if
they land first, each works around the absence and the programme collects ten
more instances of the class below.

**The recurring defect class, stated once:** *the pad must never offer what the
engine will refuse.* R2b found four instances in cricket alone. Each one
reached the owner as a generic "That entry isn't valid for this match" after a
~6s soft-commit delay, because the client fold runs NON-STRICT and only the
server refuses. Every fix in this wave exists to move the refusal in front of
the tap.

## Task 1 — the chassis capability (the real work)

Design and land a way for a skin to narrow a candidate list per slot/step,
evaluated against the CURRENT fold state.

Constraints learned the hard way in R2b:
- **Additive and optional.** Ten skins must compile and behave unchanged.
  R2b's precedents: `TileSpec.disabled`, `ContextSlot.message`, `dock()`'s
  optional payload arg, `activityDetail`'s context object.
- **Do not grow another positional parameter list.** R2b let
  `activityDetail` reach SEVEN positional params before collapsing it to
  `ActivityDetailContext`. Start with an object.
- **Narrowing must come with a REASON.** A silently shortened list leaves a
  scorer who expected an option with no idea why it is missing — that is the
  owner's standing ruling (`_INDEX.md`, "never show a generic error where the
  exact reason is known"). `SheetChoiceStep.hint` and `ContextSlot.message`
  are the existing precedents; reuse rather than invent a third mechanism.
- **Mirror the engine, never fork it.** Where the engine already owns the
  rule, EXPORT it rather than copying. R2b exported `nextBattingSide` for
  exactly this reason; `isEligibleOverBowler` mirrors `eligibleBowlers` and
  the review had to verify it byte-for-byte to trust it. A forked rule that
  drifts is this repo's recurring bug.
- Whatever you build must be reachable by a Playwright test via a stable
  `data-*` hook, and must not rely on `title`/tooltip alone — invisible on
  touch, and this is a touch-first surface.

## Task 2 — C1: the bowler chip lists BOTH squads

Pick a batting-side player as bowler and the server refuses ("not in the
fielding lineup", `packages/engine/src/sports/cricket/cricket.ts` — the
lineup check is the one ground NOT gated by `strictFold`). The chip should
offer only the fielding side, and within it only bowlers `isEligibleOverBowler`
accepts (not `prevOverBowler`, under `cfg.maxOversPerBowler`).

`isEligibleOverBowler` already exists in `v3/skins/cricket.tsx` and is
review-verified against the engine — reuse it, do not write a second rule.

## Task 3 — C2: the generic Retire sheet offers all 22, both sides

Reachable via More → Retire. `{swap:true}` tiles contribute no type to
`dedicatedEventTypes` (`v3/pad-host.tsx`), which is why it is reachable at
all. Narrow to the batting side's crease. The engine backstops it
("… is not at the crease") but that is a rejection, not a prevention.

Note: R2b DROPPED cricket's dedicated Retire tile in favour of this flow
(owner ruling), so this is now the ONLY retire path — its candidate safety is
no longer a secondary concern.

## Task 4 — C3: `reviewSheet` offers a review with none remaining

The engine enforces a per-innings review quota (`cricket.ts`, `"… has no
reviews left in this innings"`); the pad does not check it. **Pre-existing —
NOT introduced by R2b**, and R2b's reviewer correctly declined to claim it.

Harder than it looks, and the reason is worth knowing before you start: the
side asking for the review is not known until a LATER step of the sheet, so
the quota cannot be checked when the first step is built. That is a
step-ordering problem, not a filtering one. If the answer is to reorder the
sheet's steps, say so and get it ruled before building.

## Overlap with R2b — read before branching

R2b is in flight on `feat/scorepad-v3-r2b-cricket-over` and touches the SAME
files: `v3/types.ts`, `v3/skins/cricket.tsx`, `v3/pad-host.tsx`,
`v3/context-strip.tsx`. Two writers in one file is what produced a tangled
commit and a lost commit message in R2b (`02c5e6da5`).

Options, in order of preference:
1. **Wait for R2b to merge**, then branch off `main`. Cleanest; R2b's gates
   are the only thing between here and that merge.
2. Branch off R2b's HEAD and rebase after it merges — workable, but you
   inherit its unmerged history and any review-driven changes to it.
3. Parallel on `main` with a hand-merge later — do NOT, for these files.

If starting immediately matters more than a clean merge, do **Task 1's design
work** (which is reading and a written proposal, not edits) while R2b lands.

## Gates — the same bar R2b was held to

- Every change ships a test that FAILS without it. Red step first, with the
  real failure message pasted; then mutate the fix and confirm the right test
  reds.
- Counts judged ONLY from `--reporter=json --outputFile` — never from `rtk`,
  which prints `PASS(0) FAIL(0)` for a suite that failed to COLLECT. Confirm
  every `.testResults[].name` resolves inside YOUR worktree; a cwd reset
  silently runs `main` and returns a false green.
- `npx turbo run typecheck --force` and `npx turbo run lint --force` from the
  worktree root, exit codes captured with a REDIRECT, not a pipe. Lint ceiling
  is 75 warnings / 0 errors. **vitest never typechecks test files** — only the
  typecheck gate catches a type error in a test, and two agents shipped exactly
  that this week.
- New/changed user-facing strings in all four locales, real translations.
  Cricket TERMS OF ART stay English by established precedent ("Wide",
  "No-ball", "Free hit", most wicket kinds are English in all four) — match the
  siblings. `npm run i18n:gen-keys` rewrites `src/lib/i18n-keys.ts`; commit it.
- e2e for each narrowing, in `apps/web/e2e/scorepad-v3-cricket.spec.ts`. The
  `parallel` project uses `testIgnore`, not an allow-list, so that file is
  already sharded across three CI jobs on every PR — additions run in CI.
- Visual sign-off (gallery + owner walkthrough) is a MERGE GATE (`_RULES.md`).

## Agent topology and the traps that cost R2b the most time

Scout → Implementer → Reviewer, per `RULES.md`. Batch the review if you
prefer — the owner chose one pass over the whole diff rather than per-fix.

- **Subagents are killed after 600s with no output.** FOUR died in R2b. Keep
  briefs narrow, keep commands short, and tell agents to COMMIT EARLY, one
  commit per item — uncommitted work is what gets lost. Two of the four were
  recovered by hand because only the commit was missing.
- **Never `git add -A`** in a shared worktree; it sweeps the other writer's
  staged files into your commit.
- **Never `git stash`** in a worktree here — the stash stack is shared with
  the main checkout and pops a foreign stash, leaving `package.json`
  unmerged.
- A local environment comes from `~/.claude/skills/seazn-local-env/SKILL.md`
  (`seazn-env.sh up --label r2c --all`). `rebuild` after ANY src change, or
  you test the previous bundle while every health check passes.
