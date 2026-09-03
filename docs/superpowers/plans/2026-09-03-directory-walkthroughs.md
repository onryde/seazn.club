# Directory Walkthroughs Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Four Playwright walkthrough specs that drive `/directory`'s players, officials, venues and clubs journeys end-to-end through the real UI, plus the shared kit they need.

**Architecture:** Four new spec files under `apps/web/e2e/walkthrough/` (auto-selected by the existing `walkthrough` project — no config or CI edit), and one shared non-spec module at `apps/web/e2e/directory-kit.ts`. Setup reaches state via the API; every step that IS the thing under test is typed, tapped or uploaded. Each spec owns its data by unique-suffixing every name it creates, and the two specs that need a non-Pro plan mint their own org.

**Tech Stack:** Playwright (`@playwright/test`), TypeScript 7, Node 26, pnpm. Vitest for the wiring guard. `scripts/smoke.ts` for smoke.

**Spec:** `docs/superpowers/specs/2026-09-03-directory-walkthroughs-design.md`

## Global Constraints

Copied verbatim from the spec and from `docs/superpowers/RULES.md`. Every task's requirements implicitly include this section.

- **Never place a helper under `e2e/walkthrough/`.** `WALKTHROUGH = /[\\/]e2e[\\/]walkthrough[\\/]/` matches *any* file in that folder, so a helper there is selected as a spec and Playwright rejects the run with `test file "X" should not import test file "helpers.ts"`. The kit goes at `apps/web/e2e/directory-kit.ts`.
- **Setup may use the API to REACH a state; every step that IS the thing under test must be DONE THROUGH THE UI** — tapped, typed, submitted — and the system's own record must agree with it.
- **`AUTH_STATE` is `e2e/.auth/pro.json` — the shared PRO org.** A free-plan assertion made against it is vacuous. Any COUNT made against it counts the whole run's leftovers.
- **Scope every count to a per-spec unique token.** Never assert a global total.
- **A fresh org gets its OWN billing group** (`POST /api/orgs` → `createOrgForUser`, `lib/auth.ts:303`, which inserts a new `subscriptions` row). No `splitOrgIntoOwnGroupSql` call is needed. `setOrgPlanBySql` is nonetheless group-scoped (`helpers.ts:441-449`).
- **Never hardcode a plan limit value.** Read it live. `pro_plus` is being deleted and `enterprise` added by an in-flight branch; write against `"pro" | "community"` only.
- **Never construct a claim URL.** Read it from `data-testid="claim-link"` and navigate. Constructing it is how a dead link stays green.
- **Bare `browser.newContext()` inherits the owner session.** Spell out `storageState: { cookies: [], origins: [] }`.
- **No test may exceed the 60s default `timeout`.** A spec needing `test.setTimeout` has failed the speed budget and must be split. Where a budget must be raised, express it as a derived cost (`Math.max(FLOOR, base + n * PER_ITEM)`), never a flat constant.
- **`expect.poll`, never `page.waitForTimeout`.**
- **Every spec must be mutated until it goes red before it is trusted.** Named mutants are in each task.
- **Judge a vitest run only from `--reporter=json --outputFile`** (`numPassedTests` / `numTotalTests`), and confirm `.testResults[].name` paths are under this worktree. `rtk` prints `PASS(0) FAIL(0)` for a suite that failed to collect.
- **Prefix `cd <abs worktree> &&` in the same call as every command you judge.** The shell cwd resets to the main checkout between calls.
- **Never `git stash` in this worktree** — the stash stack is shared with the main checkout.
- **`grep -a` always** — this repo reports source files as binary and hides the lines otherwise.
- Worktree: `/Users/ashokhein/github/seazn.club/.claude/worktrees/dir-walkthrough`. Branch: `feat/directory-walkthroughs`.
- Local env label: `dirw`. `eval "$(~/.claude/skills/seazn-local-env/scripts/seazn-env.sh env --label dirw)"` exports `DATABASE_URL` / `SMOKE_BASE` / `PLACEMENT_SERVICE_*`.

---
