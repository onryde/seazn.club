# Standing rules — every portfolio session (P1–P11)

Read this **first**, then `_INDEX.md`, then your session's prompt.
Prompts assume this file and do not repeat it. Cross-programme gates:
`../_MASTER.md`.

## 1. Owner rules (non-negotiable)

- **Don't raise new issues.** Defect/false premise → fix in-session if
  inside the stated file set; else ask. `Unplanned fixes` in the PR body.
- **Re-verify every `file:line`** before trusting it — all prompts
  authored 2026-08-13 while C1/S10+ were in flight. Scout re-pin is
  step zero of every session.
- **One PR per session.** Smoke CI is PR-only. Never enable
  `.github/workflows/e2e.yml`.
- **Worktree per branch**; `pnpm install --frozen-lockfile`;
  `readlink -f node_modules/@seazn/engine` must resolve INSIDE the
  worktree.
- **All 4 test types** or the PR body names the deferral + reason.
- **i18n ×4** (flat dotted keys) for every user-facing string;
  `content/help/**` stays English-only; grep changed UI text across
  `apps/web/e2e/**` before merge.
- **UI bar**: screenshots 1280/**320**/**768**, no horizontal page
  scroll; wide tables scroll in their own container; `/admin` surfaces
  (P11's import page) functional-bar only; everything else full polish
  (`frontend-design` skill applies — use it, don't cite it).
- **Structured logging**: pino in new server code; named events are in
  each spec; never in tests.
- **Pre-commit**: `npm run openapi:gen && git status --porcelain` empty
  (plus `i18n:gen-keys` / `schema:snapshot` when those surfaces moved).

## 2. Schema work (P4, P5, P8, P9, P11)

Load `supabase-postgres-best-practices` BEFORE authoring any migration.
Every FK indexed; containment-queried arrays get GIN; uniqueness in
DDL; greenfield stance — correct over compatible; re-verify the next
free `V<n>` at execution. `db:apply` is Flyway and destructive to the
target schema — NEVER the local dev DB; fresh test DB needs `db:apply`
AND `sync:sports`.

## 3. Verification traps that bite these sessions

- rtk wrappers: vitest green only via `--reporter=json --outputFile` +
  jq; lint via `rtk proxy` (read `✖ N problems`); `tsc` writes its own
  `EXIT=$?`. Positional args to `npm test` are filename FILTERS.
- **`ScheduleConfig` is the READ path** — stored rows must parse at
  every step (P9's whole migration design exists for this).
- **Placer/verifier parity** (P9/P10): any constraint the lattice
  build honors, the validate path must honor with the SAME function —
  `usableWindows`/`capacity.ts` exist to make the fork impossible; do
  not inline a second copy "for speed".
- **A live placement service masks greedy/apply defects** — schedule-
  touching sessions (P9, P10) run gates both ways.
- e2e: `localhost` never `127.0.0.1`; port 3100 squatting (assert
  `lsof -t` is your PID); parallel-phase failure hides serial+mobile;
  fresh browser context for device/second-user flows.
- Bare `data-*` probes on Next HTML pass in both states — anchor `="`.
- apps/web tsc heap ~2.8 GB (`NODE_OPTIONS=--max-old-space-size=6144`);
  engine has its own lint task.
- `settings.orgTz` is the governing clock (P3 digest, P10 windows);
  `settings.tz` is display.

## 4. Agent topology (owner policy, current)

Scout: Sonnet High. Implementer: Sonnet MAX. Reviewer: Sonnet MAX
(efforts live in `.claude/agents/*.md` frontmatter). Loop until review
clean AND gates green. Tasks sharing files → one implementer pass, not
parallel dispatches. Never subagent a long e2e run (600s watchdog).

## 5. On close (every session)

Update `_INDEX.md`: row → DONE + one-line outcome + any ruling made;
false premises found go to the status log AS DISCOVERED. Write memory
at decision points (`project_product_portfolio_programme` + traps as
reference files); run `scripts/agent-memory-snapshot.sh` at the wave
boundary. Deferred test types → named in PR body AND the index row.

## 6. Skills — load, don't cite

| When | Skill |
|---|---|
| before code | `superpowers:test-driven-development` |
| before claiming done | `superpowers:verification-before-completion` |
| any unexpected red | `superpowers:systematic-debugging` |
| before the PR | `superpowers:requesting-code-review` + `/code-review` |
| UI sessions (P1,P2,P3,P4,P6,P7,P8) | `frontend-design` |
| env bring-up / red triage | `seazn-local-env` |
| migrations (P4,P5,P8,P9,P11) | `supabase-postgres-best-practices` |
