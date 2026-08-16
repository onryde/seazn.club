# Standing rules — every Registration Redesign (RS) session

Read this file **first**, at the top of every session. Each `RS*` prompt in this
directory assumes it and does not repeat it. Then read the session's own prompt
file and `_INDEX.md` (status + decisions, survives compaction).

Design of record: `../2026-08-16-registration-redesign-design.md`.

---

## 1. Owner rules (non-negotiable)

- **DON'T RAISE NEW ISSUES.** Found a defect, a wrong premise in the brief, or a
  gap? **Fix it in this session.** If the fix widens the blast radius beyond this
  session's stated file set, **ask first** — then fix. Never open a GitHub issue
  to defer it. Record every such fix in the PR body under `Unplanned fixes`.
- **Think past the literal brief.** Hunt gaps, edge cases and weak design.
  Propose the improvement, don't just implement the sentence. A brief premise
  that turns out false is a finding, not a blocker.
- **Greenfield, zero data.** Owner confirmed 2026-08-16: prod has **zero
  registration rows**. No backfills, no compat shims, no dual-shape rendering,
  no feature flags. Drop columns outright; constraints strict from day one.
  The public registration surface is **intentionally down** between RS001 and
  RS006 merges.
- **Names are public by default.** Registering = consent to public name (the
  consent-step copy says so plainly); opt-out later flips public rendering to
  initials. Youth divisions keep `divisions.player_name_display` behavior.
- **One PR per session.** Smoke CI runs on **PRs only** — merging locally and
  pushing to `main` skips it.
- **New branch in a worktree**, never a checkout in the main repo dir.

## 2. Toolchain

- **TypeScript 7**, **Node 26**, pnpm workspaces (`pnpm install
  --frozen-lockfile` in a fresh worktree).
- `apps/web` typecheck peaks ~2.8 GB — run with
  `NODE_OPTIONS=--max-old-space-size=6144`.
- Have commands write their own status: `npx tsc --noEmit; echo "EXIT=$?"`.
  A killed background command reports exit 0.

## 3. Skills — load, don't cite

| When | Skill |
|---|---|
| every session, before code | `superpowers:test-driven-development` |
| before claiming done | `superpowers:verification-before-completion` |
| any unexpected red | `superpowers:systematic-debugging` |
| before the PR | `superpowers:requesting-code-review`, `code-review` |
| branch integration | `superpowers:finishing-a-development-branch` |
| worktree setup / red suite triage | `seazn-local-env` |
| any UI surface | `frontend-design:frontend-design` |
| browser verification | Playwright MCP (`mcp__plugin_playwright_playwright__*`) |
| any migration or SQL | `supabase:supabase-postgres-best-practices` |
| any payment work | `stripe:*` — never answer billing from memory |

## 4. Agent topology

- **Scout (sonnet)** — all read-only exploration. Never pull file dumps into the
  main thread.
- **Implementer (sonnet, xhigh)** — writes code.
- **Reviewer (sonnet, xhigh)** — reviews the implementer's diff, returns a gap
  list only.
- **Loop**: implementer → reviewer → gaps → implementer → … until the review is
  clean **and** the gate is green. The main thread reruns the gate itself at the
  session boundary; never accept "done, tests pass" without raw counts pasted.
- **Batching**: same file set → one sequential implementer. Parallel only when
  file sets are provably disjoint; overlap → sequential or
  `isolation: "worktree"`.

### Dispatch brief template (copy verbatim, fill the brackets)

> Task: [one sentence].
> Files you own: [exact paths]. Do NOT touch: [paths].
> Context you need (do not re-derive): [pinned line refs, type shapes, the
> decision and its reason].
> Acceptance: [checklist]. Every change ships a test that fails without it.
> Verify with exactly: `npx vitest run --reporter=json --outputFile=/tmp/r.json <paths>`
> then `jq '{total:.numTotalTests,passed:.numPassedTests,failed:.numFailedTests}' /tmp/r.json`.
> Final message under 15 lines — counts, paths, deviations, blockers. No file
> contents, no diffs, no narration.
> Do not spawn sub-subagents. Do not open issues. If blocked, say so in one line.

## 5. Testing — four types, every session

1. **Unit** — pure logic, fast; DB-backed usecase tests against the fresh test
   schema (`:54329`, `db:apply` **and** `sync:sports`).
2. **E2E (Playwright)** — real browser against a prod build on
   **`localhost:3100`** (`127.0.0.1` 401s — Secure cookie).
3. **Smoke** — `scripts/smoke.ts`.
4. **Regression** — written to fail without the change.

Backend-only sessions defer 2–3 to a **named later session** (each prompt states
its mapping); say so in the PR body too. Never silently drop one.

## 6. Verification — the wrappers lie here

- vitest green **only** from
  `npx vitest run --reporter=json --outputFile=/tmp/r.json <paths>` +
  `jq '{total:.numTotalTests,passed:.numPassedTests,failed:.numFailedTests}'`.
  `rtk`'s `PASS(0) FAIL(0)` can mean *failed to collect*. Confirm paths in
  `.testResults[].name` — cwd can reset to the main checkout between calls, so
  prefix `cd <abs worktree> &&` in the **same** call.
- Prefix every tsc/vitest/eslint with `rtk proxy` — bare invocations have
  returned **fabricated** output. Lint: `rtk proxy npm run lint`, read
  `✖ N problems`.
- `git grep -a` always (plain grep reports source as `Binary file … matches`,
  and counts `.next/types/` under `apps/`).
- Worktree: symlink `node_modules` **and** `.claude/agent-memory`; verify
  `readlink -f node_modules/@seazn/engine` points at **your** worktree. No
  `.env.local` in a fresh worktree → DB suites silently skip. Never `git stash`
  in a worktree (shared stack).
- DB suites: fresh schema per session; **never** the dev DB on `:5432`, never
  port 3000. `db:apply` without `sync:sports` is NOT a fresh schema.
- Registration rows from `seed:demo` red unrelated sweep suites — sweeps need a
  fresh DB.
- **Unrelated failures**: red suite whose files this session did not touch →
  rerun once alone, then skip and note in the PR body. Do not chase.

## 7. Ship checklist (every session, before the PR)

- [ ] Every change has a test that fails without it
- [ ] Full gate rerun **inline by the main thread**, counts from JSON reporter
- [ ] `rtk proxy npx tsc --noEmit; echo "EXIT=$?"` → `EXIT=0`, heap raised
- [ ] `rtk proxy npm run lint` → `✖ 0 problems`
- [ ] **OpenAPI drift**: any api-v1 zod change → `npm run openapi:gen`; then
      `npm run i18n:gen-keys`; then `git status --porcelain` **empty** (both
      gates are CI-only — a green local run without this proves nothing)
- [ ] i18n: every new/changed user-facing string in **all 4** dictionaries
      (`en`,`es`,`fr`,`nl`, flat dotted keys) + `i18n:check`. `content/help/**`
      is one English tree, no translation owed
- [ ] UI: screenshots at **1280, 768 and 320** px, no horizontal page scroll,
      touch-sized targets; new public/org surfaces added to `mobile.spec.ts`
      seven-width matrix (a surface has ZERO width coverage until it is inside
      that file)
- [ ] UI text changed? `git grep -a` old **and** new strings across `e2e/` —
      text changes break e2e. Never touch `.github/workflows/e2e.yml` contents
      casually — it is LIVE on PRs
- [ ] Help pages (`content/help/**`) + smoke demo extended when user-visible
- [ ] `_INDEX.md` here updated: status, rulings, false premises, gotchas —
      **as they happen**, not at the end
- [ ] Memory written + `scripts/agent-memory-snapshot.sh` run

## 8. Compaction protocol

- Write every ruling into `_INDEX.md` **as it is made**.
- Preserve on compact: session state, files touched, decisions, latest counts.
- A resumed session reads, in order: `_RULES.md` → `_INDEX.md` → its own prompt
  file → the design doc. Nothing else should be needed.
