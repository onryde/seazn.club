# Standing rules — every bench session (B00–B18)

Read this **first**, then `_INDEX.md`, then your session's prompt. Prompts
assume this file and do not repeat it. Spec of record:
`../2026-08-12-scheduler-bench-design.md` — every semantic decision is
made there (simulate-never-feed-verdicts, gates vs report-only,
misalignment protocol §7, provenance discipline). Do not re-derive.

## 1. Owner rules (non-negotiable)

- **Don't raise new issues.** Defect or false premise found → fix
  in-session if inside the stated file set; else ask. Record under
  `Unplanned fixes` in the PR body.
- **Re-verify every `file:line`** in prompts/specs before trusting it —
  the whole programme was authored before S10–S13 and C1–C8 landed, ON
  PURPOSE. B00 re-pins globally; sessions still re-pin locally.
- **One PR per session.** Smoke CI runs on PRs only. Never enable
  `.github/workflows/e2e.yml`.
- **New branch in a worktree**; `pnpm install --frozen-lockfile`; check
  `readlink -f node_modules/@seazn/engine` resolves to the WORKTREE.
- **All 4 test types** (unit/e2e/smoke/regression) or the PR body names
  the deferral. The bench itself is not exempt: its lib code carries
  unit+regression; a tiny-suite run is its smoke; the bench run is the
  e2e.
- **i18n**: the bench is a dev tool — its report/CLI strings are exempt.
  Anything it adds to the APP (none expected) owes 4 locales.
- **Gates vs measurements**: correctness reds the run; timings NEVER
  do (load-sensitive-timing rule). Do not "helpfully" add a wall-time
  assertion.

## 2. Environment

Follow `seazn-local-env` (B00 adds its placement-service section).
Non-negotiables: never :3000, never the local dev DB; fresh DB needs
`db:apply` AND `sync:sports`; confirm `show data_directory`; assert your
port's PID via `lsof -t`. The bench's own pre-flight automates these —
until B01 lands, do them by hand.

**Placement service**: run gates BOTH with and without a live placement
container — a live service masks greedy/apply-path defects (CI smoke has
no placement container BY DESIGN). `PLACEMENT_SERVICE_HOST` overrides
`placement.flycast:50051`.

## 3. Bench-specific traps

- **The oracle direction is sacred**: packs carry raw events + expected
  values; the engine derives outcomes. Any helper that writes an
  outcome/verdict into the DB is a defect, not a shortcut.
- **Stage-0 before HTTP, always**: a pack whose streams don't fold to its
  own expected results must die in seconds offline, not minutes into a
  seeded run.
- **Entitlements**: deep tiers 422 without the right plan
  (`requiredFeatureForEvent`; `cricket.ball` → `scoring.ball_by_ball`).
  Seeding sets each org's plan via the smoke `setPlan` SQL precedent.
  B00 re-verifies the plan→feature map (bench spec risk 8).
- **Event throughput**: measured in B06 (pilot), revisited in B08
  (cricket, the volume monster). A batch endpoint is D6/P11 — if it has
  shipped, the bench MAY use it for seeding speed but MUST keep one
  suite on the single-POST path (that path is what live scoring uses).
- **Reconstructed streams**: legal sequences folding to EXACT real set
  scores, side-attributed sports only; `provenance:"reconstructed"`,
  never disguised as real. Report shows provenance % per suite.
- **`expected_seq` discipline**: the scoring API 409s on seq mismatch —
  the sim loop is strictly sequential per fixture; parallelism is
  across fixtures, never within one.
- **Independent checker independence**: it recomputes constraints from
  fetched fixtures. It imports NO solver code and trusts NO
  `/validate` output (wrapper-parity tautology). It MAY share the pure
  libs (`capacity.ts`, `health.ts`, `court-windows.ts`) — those are
  arithmetic, not the system under test.
- **Feasibility certificate order**: check the historical assignment
  against encoded constraints BEFORE reading any solver INFEASIBLE as a
  finding (spec §6.3) — it decides pack-bug vs product-bug.
- **Keep-data default**: `--keep` leaves orgs browsable; `--wipe` is for
  CI-ish loops. Never point at a long-lived DB (global-sweep suites red
  on those).
- **rtk wrappers lie** (vitest JSON reporter only, `rtk proxy` for
  lint/tsc); killed background commands exit 0 — the runner writes
  `EXIT=$?` itself.

## 4. Pack authoring (B06–B16)

Follow `_PACK-PLAYBOOK.md` exactly — research → build → validate →
record. Sources cited in pack meta; adaptations in `meta.adaptations[]`
(§7A protocol: adapt / escalate / drop — adaptations never red).
PackSchema is FROZEN after B06; additive needs escalate to the owner in
the PR, never land silently.

## 5. Agent topology (owner policy, current)

Scout: Sonnet, High. Implementer: Sonnet, MAX (set in
`.claude/agents/implementer.md`). Reviewer: Sonnet, MAX. Loop
implementer→reviewer until clean AND green. Never dispatch a subagent to
run long e2e/bench loops (600s watchdog) — main thread runs them.

## 6. Skills — load, don't cite

| When | Skill |
|---|---|
| before code | `superpowers:test-driven-development` |
| before claiming done | `superpowers:verification-before-completion` |
| any unexpected red | `superpowers:systematic-debugging` |
| before the PR | `superpowers:requesting-code-review` + `/code-review` |
| env bring-up / red-suite triage | `seazn-local-env` |
| any migration (none expected in bench) | `supabase-postgres-best-practices` |
