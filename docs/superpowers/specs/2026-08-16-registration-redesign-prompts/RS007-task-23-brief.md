# Task brief — RS007 #23: a fresh join onto a materialised entry creates no squad membership

Self-contained brief for a fresh session. Everything needed is here; the
index section for #23 is in `_INDEX.md` and carries the same facts.

## The defect

The "I'm someone else" path on the public join page — a joiner who is NOT
already a roster row, so no `player_id` — against an entry that has ALREADY
been materialised inserts a `registration_players` row and **nothing else**.
No `entrant_members` row is ever created for them.

Verified mechanically (do not take on trust — re-confirm, then extend):

- `entrant_members` is INSERTed in exactly two places, both inside
  `materialise()`: `apps/web/src/server/usecases/registrations.ts:895` and
  `:918`.
- `materialise()` returns early at `registrations.ts:865`
  (`if (reg.entrant_id) return reg.entrant_id;`), so it never runs twice for
  a registration.
- The only other `entrant_members` write is
  `apps/web/src/server/usecases/registration-submit.ts:1209`, an `update`
  that REPOINTS an existing row from a placeholder person to a resolved one.
  That is #22's claim reconciliation — it needs a row to already exist.

So: entry materialises → squad exists → someone joins fresh → they get a
roster row and a success page, and are not in the squad.

**Product framing.** The join page tells that person "You're in". They are
not a member of the entrant that gets fielded, drawn, or scored. This is
worse than a hard failure, because nothing tells anyone: not the joiner, not
the captain, not the organiser.

## Distinct from #22 — do not merge the two

#22 (shipped, `347aeaefa`) fixes the CAPTAIN-TYPED duplicate: a roster row
the captain already entered, reconciled against the real person at claim
time. There, a membership row exists and is repointed.

Here there is no captain-entered row to reconcile against — the joiner is
adding themselves after the squad already exists. #22's reconciliation has
nothing to attach to. Reusing its code path is the obvious wrong turn.

## Product questions to settle BEFORE writing code

These are not implementation details; answer them with the owner, or state
your assumption explicitly and loudly.

1. **Does a late joiner join the squad at all?** Presumed yes — otherwise the
   join page is lying. But a squad that has already been drawn or scored is a
   different question from one that has merely been materialised. Decide
   whether materialised-and-untouched differs from materialised-and-played.
2. **Squad number and captaincy.** `entrant_members` carries `squad_number`
   and `is_captain`. A late joiner is not the captain. What number do they
   get — next free, or null? What if numbers collide?
3. **Caps.** What happens when the squad is already at the division's roster
   maximum? Reject the join with a clear message, or admit and let the
   organiser resolve it? A silent admit past a cap is how the current bug
   feels to a user, so prefer an explicit answer.
4. **Pairs are already handled — confirm, don't assume.** `joinTeamEntry`'s
   insert-a-new-person path 422s for a pair (a pair's roster is fixed at
   two). Verify that is still true and scope this to teams if so.

## Acceptance criteria

- A fresh join against a materialised entry results in an `entrant_members`
  row for the resolved person, or an explicit, translated refusal — never
  today's silent success.
- The existing claim path (#22) is unchanged: a captain-entered row still
  REPOINTS rather than inserting a second membership.
- Concurrency: two people joining the same entry at once cannot produce a
  duplicate membership or lose one. `entrant_members` has a uniqueness
  constraint — read it first and let the DB arbitrate rather than a
  read-then-write in application code. Note that a rejected statement ABORTS
  the surrounding Postgres transaction, so a bare try/catch does not survive
  it; use `tx.savepoint` (the #22 lane hit exactly this and its own test
  caught it).
- Every change ships a test that fails without it. Mutate the fix back, watch
  it go red, paste the counts, restore.

## Environment and verification traps (this repo bites in specific ways)

- Work in a worktree, never the main checkout. Prefix `cd <abs worktree> &&`
  on EVERY bash call — the shell cwd resets between calls and a verify run
  from the wrong tree returns a false green. **An empty `grep` result needs
  the same cwd proof as a test count**: from the wrong directory it matches
  nothing, prints no error, and reads exactly like "this string is unused".
- Stand the environment up with the `seazn-local-env` skill
  (`~/.claude/skills/seazn-local-env/SKILL.md`). Export it into every shell
  that runs tests: `eval "$(seazn-env env --label <label>)"`. vitest's config
  REFUSES to start if `DATABASE_URL` points at the dev DB — that refusal is a
  guard, not a bug.
- **Use a FRESH database.** A long-lived one accumulates orgs, and past ~28k
  the org-walking suites (`credits-*`, `org-posts-digest`,
  `org-addon-price-sweep`) stop failing on assertions and start failing on
  30-second timeouts or on other sessions' rows. Those reds are
  environmental. `duration: 30000` is the tell.
- Judge vitest ONLY from `--reporter=json --outputFile`, reading
  `numTotalTests`/`numPassedTests`/`numFailedTests`, and confirm
  `.testResults[].name` contains your worktree path. vitest NEVER typechecks
  test files — run `npx tsc --noEmit -p tsconfig.json` from `apps/web`
  separately.
- **Scope the suite by blast radius, not by which files you edited.** A
  migration's contract is pinned in `apps/web/src/server/__tests__/
  registration-schema.test.ts`, which is nowhere near the code you change.
  Running the whole `apps/web` suite once is cheaper than two CI rounds.
- Any new user-facing string goes in ALL FOUR locale dictionaries
  (`apps/web/src/dictionaries/{en,fr,es,nl}/ui.json`, flat keys), then
  `npm run i18n:gen-keys` and `npm run i18n:check` must both be clean.
  Server-side error strings in this repo are English-only — check which kind
  you are adding. Renaming or adding copy is the highest-risk change for
  breaking assertions: unit tests AND e2e specs assert on rendered text, and
  neither is found by searching for the KEY.
- CI: smoke runs on PRs only; **e2e does NOT run on a PR** — it triggers on
  push to `main`, and `workflow_dispatch` with a `pr` input is the only way
  to get e2e on a feature branch. Re-read `.github/workflows/e2e.yml` rather
  than trusting any description of its trigger, including this one.

## Where to read first

- `docs/superpowers/specs/2026-08-16-registration-redesign-prompts/_INDEX.md`
  — section `### #23`, then the DECISION LOG for the rulings already made.
- `_RULES.md` beside it.
- `apps/web/src/server/usecases/registrations.ts` — `materialise()`.
- `apps/web/src/server/usecases/registration-submit.ts` — `joinTeamEntry`.
