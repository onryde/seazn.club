# Standing rules — every Format Progression (F) session

Read this file **first**, at the top of every session. Each `F*` prompt in this
directory assumes it and does not repeat it. Then read the session's own prompt
file and `_INDEX.md` (status + decisions, survives compaction).

Design of record: `../2026-08-17-format-progression-design.md`.

---

## 1. Owner rules (non-negotiable)

- **DON'T RAISE NEW ISSUES.** Found a defect, a wrong premise in the brief, or a
  gap? **Fix it in this session.** If the fix widens the blast radius beyond the
  session's stated file set, **ask first** — then fix. Never open a GitHub issue
  to defer it. Record every such fix in the PR body under `Unplanned fixes`.
- **Think past the literal brief.** A brief premise that turns out false is a
  finding, not a blocker. This programme exists because four separate round
  namers drifted while every test stayed green — assume more of that.
- **One PR per session.** Smoke CI runs on **PRs only**; merging locally and
  pushing to `main` skips it.
- **New branch in a worktree**, never a checkout in the main repo dir.
- **Every change ships a test that fails without it.**
- All four test types per session: unit, DB integration, E2E, smoke — plus a
  regression test. Any session that defers a type must say so in its PR body
  with a reason.

## 2. Programme-specific invariants

- **A round's name is a property of its POSITION, never its match count.** A
  double-elim losers bracket has repeated 2-match and 1-match rounds by
  construction, so any count-based namer produces several "Semi-finals" and
  several "Final"s in one bracket. If you find yourself counting fixtures to
  name something, stop.
- **`lastRound` is per LANE, not per stage.** A DE's losers bracket has more
  rounds than its winners bracket; a global maximum silently reintroduces the
  naming bug with every test still green.
- **The engine returns roles, never English.** `packages/engine` must not carry
  user-facing strings and must not import from `apps/web`. i18n mapping lives in
  `apps/web`.
- **`ext_key` is the only place page-playoff node identity survives**
  (`pp-q1`, `pp-elim`, `pp-q2`, `pp-final` — `bracket.ts:390-393`). Qualifier 1
  and the Eliminator share a round and a match count; nothing else distinguishes
  them. Parse it, never re-derive.
- **Some formats cannot have day-one fixtures and that is arithmetic, not a
  bug.** Swiss, americano, mexicano and ladder pair from live results. A final
  above them can be pre-created; the rounds beneath it cannot. Never "fix" this.
- **A stage may hold `qualification` OR `seeding`, never both** — `stages.ts`
  422s `SEEDING_RULES_MISSING`. Until F2 lands, that constraint is load-bearing.

## 3. Toolchain

- **TypeScript 7**, **Node 26**, pnpm workspaces (`pnpm install
  --frozen-lockfile` in a fresh worktree — a symlinked `node_modules` compiles
  MAIN's engine and you measure the wrong code).
- `apps/web` typecheck peaks ~2.8 GB: `NODE_OPTIONS=--max-old-space-size=6144`.
- Have commands write their own status: `npx tsc --noEmit; echo "EXIT=$?"`.
  A killed background command reports exit 0.
- Judge vitest green **only** from `--reporter=json --outputFile`. A suite that
  fails to collect contributes 0 tests and 0 failures, so `failed: 0` is not
  green on its own — check `numTotalTests` moved and `numFailedTestSuites` is 0.
- `npx vitest run <path>` from the repo root under-reports with
  `Cannot find package '@/lib/db'` — use `--root apps/web`.
- Prefix `cd <abs worktree> &&` in the **same** call as every command; cwd
  resets to the main checkout between tool calls.

## 4. Known-red baseline (verified on `main`, 2026-08-17)

These five suites fail on a clean `main` for environmental reasons. Do not
attribute them to your change, and do not "fix" them in an F session:

`help-content`, `help-groups-suspension`, `sponsor-crm-migration`,
`enrichment-dict-parity`, `schedule-build-honours-locks`.

`schedule-build-honours-locks` is 11/11 **with a placement service running**
(`seazn-env up --label X --placement`). The others are path/ENOENT failures at
collection. Re-verify this list at the start of each session rather than
trusting it — it will age.

## 5. Skills — load, don't cite

| When | Skill |
|---|---|
| every session, before code | `superpowers:test-driven-development` |
| before claiming done | `superpowers:verification-before-completion` |
| any unexpected red | `superpowers:systematic-debugging` |
| before the PR | `superpowers:requesting-code-review`, `code-review` |
| worktree setup / red triage | `seazn-local-env` |
| any UI surface | `frontend-design:frontend-design` |
| any migration or SQL | `supabase:supabase-postgres-best-practices` |
| browser verification | Playwright MCP |

## 6. Agent topology

- **Scout (sonnet)** — read-only exploration; never pull file dumps into the
  main thread.
- **Implementer (sonnet, xhigh)** — writes code. Commit each verified red→green
  unit as you go; this is a shared worktree and uncommitted work has been
  silently reset here before.
- **Reviewer (sonnet, xhigh)** — gap list only.
- Parallel only when file sets are provably disjoint. `stages.ts` and
  `api-v1/schemas.ts` are single-writer files across this whole programme.
