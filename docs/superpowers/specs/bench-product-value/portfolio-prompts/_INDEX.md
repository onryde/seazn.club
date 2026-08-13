# Product portfolio (7 follow-ups) — session index

**One session per row.** Read `docs/superpowers/RULES.md`, then this file,
then the session's prompt file. This file is the compaction anchor: every
ruling, false premise, and status change gets written here **as it
happens** (the scoringpad/release-2 pattern).

Programme origin: bench spec §14 (`../designs/2026-08-12-scheduler-bench-design.md`).
**Whole programme is creative-complete but BUILD-GATED: owner green-light
required per session.** Two extra hard gates: P8–P10 wait for the
release-2 C-chain (shared `schedule.ts`/`build.ts`); P11 waits for
ScoringPad S13 (scoring-ingest cutover). The bench itself stays
strict-wait (S13+C8) per its own spec — it is NOT a row here.

Specs of record (all in `../designs/`):

| D | Feature | Spec |
|---|---|---|
| D1 | Format templates | `../designs/2026-08-13-format-templates-design.md` |
| D2 | Capacity pre-check | `../designs/2026-08-13-capacity-precheck-design.md` |
| D3 | Schedule health | `../designs/2026-08-13-schedule-health-design.md` |
| D4 | Stage progression + TBD fixtures | `../designs/2026-08-13-stage-progression-design.md` |
| D5 | Venues & courts | `../designs/2026-08-13-venues-courts-design.md` |
| D6 | Batch event import | `../designs/2026-08-13-batch-event-import-design.md` |
| D7 | News enrichment + digest | `../designs/2026-08-13-news-enrichment-design.md` |

## Order

Ratified build order: **P1 → P2 → P3 → P4 → P5 → P6 → P7 → P8 → P9 → P10 → P11.**
P1–P4 are mutually independent (any subset may run, order above is the
recommendation); P5→P6→P7 strict; P8→P9→P10 strict; P11 independent but
S13-gated. New-branch-in-worktree rule applies to every session.

| Session | Feature | Prompt file | Depends on | External gate | Status |
|---|---|---|---|---|---|
| P1 | D2 capacity lib + route guard + card | `P01-capacity-precheck.md` | — | green-light | **MERGED** `78c8618f` (#544) |
| P2 | D3 health lib + route + panel | `P02-schedule-health.md` | — (P1 pattern reuse, soft) | green-light | **IN FLIGHT** (wave 2) |
| P3 | D7 enrichment + weekly digest | `P03-news-enrichment.md` | — | green-light | **MERGED** `51601495` (#545), V358 |
| P4 | D1a template catalog + instantiation + wizard | `P04-templates-single-stage.md` | — | green-light | **IN FLIGHT** (wave 2) |
| P5 | D4a seeding rules + TBD fixtures + fill engine | `P05-progression-engine.md` | — | green-light | TODO |
| P6 | D4b proposal UI + confirm flow | `P06-progression-ui.md` | P5 | green-light | TODO |
| P7 | D1b multi-stage templates | `P07-templates-multi-stage.md` | P4, P5 (StageSeeding merged) | green-light | TODO |
| P8 | D5a venues/courts schema + API + org UI | `P08-venues-schema-ui.md` | — | green-light + **release-2 C-chain done** | TODO |
| P9 | D5b scheduler integration + stored-config migration | `P09-venues-scheduler.md` | P8 | same as P8 | TODO |
| P10 | D5c calendars + window compiler | `P10-venues-calendars.md` | P9 | same as P8 | TODO |
| P11 | D6 batch import | `P11-batch-import.md` | — | green-light + **ScoringPad S13 done** | TODO |

## Decisions already made (do not re-open)

All owner-ratified 2026-08-13 in the design session:

- Deliverable: **7 separate full specs** + this prompt directory;
  **creative-only** — nothing builds without a per-session green-light.
- D2: advisory card; Solve hard-blocked ONLY on `verdict:"impossible"`;
  suggestions quantified by re-running the arithmetic (`flipsVerdict`).
- D3: per-metric bars 0–100, **no composite grade**.
- D4: propose + confirm (never fully automatic); **TBD placeholder
  fixtures for all stages at setup time** (owner's addition) — confirm
  FILLS existing fixtures, never regenerates; applied schedules survive
  seeding. One fill pathway shared with intra-bracket `fillSlot`.
- D5: full v1 = entities + scheduler integration + **tags** (owner's
  suggestion, replaces typed attribute columns) + **calendars in v1**.
  Stored-config migration converts court strings → court rows (the
  `ScheduleConfig`-is-the-read-path trap, handled by migration not by a
  permanent tolerant union).
- D1: **curated built-ins only**; templates carry i18n keys, never
  strings; catalog uses DB-checked StageKinds only.
- D6: KEPT after "why do we need this" challenge (career-pages-day-one +
  paper catch-up); **JSON only, finished matches only**; dry-run fold
  before any write; appends through the ONE production writer.
- D7: enrich existing drafts **and** add `weekly_digest` kind; digest
  trigger v1 = button (cron only if a job runner already exists — none
  assumed); enrichment is fail-open (plain draft, never a missing draft).
- Shared-lib contracts that also bind the future bench: `capacity.ts`,
  `health.ts`, `court-windows.ts` (pure, no DB/solver/clock), dry-run-fold
  shape (D6 ↔ bench stage-0). Pack schema ⊃ template schema.
- The bench programme's §14 now defers to THIS index for the 7 items.

## Standing constraints (restate in every dispatch brief)

- All four test types per session (unit / e2e / smoke / regression),
  stated in acceptance criteria; deferrals named in the PR body.
- i18n ×4 locales for every user-facing string (flat dotted keys);
  `content/help/**` stays English-only.
- UI verified 1280/320/768, no horizontal page scroll; `/admin` surfaces
  functional-bar only (P11's import page qualifies).
- Structured logging (pino) in new server code; never in tests or
  `src/core/**`.
- Pre-commit: `npm run openapi:gen && git status --porcelain` empty.
- No new GitHub issues: fix inline if in blast radius, else escalate.
- Worktree per session branch; `pnpm install --frozen-lockfile`.
- **Scout re-pin before touching anything** — every file:line in the
  specs/prompts predates C1/S10+ landings by design.
- **Schema work** (P4, P5, P8, P9, P11 create tables / update columns /
  add DB indexes): load the `supabase-postgres-best-practices` skill
  BEFORE writing any migration. Baseline owed regardless: every FK gets
  an index; array/jsonb columns queried by containment get GIN (e.g.
  `courts.tags` for `@>`); uniqueness lives in DDL (unique index), never
  app-side checks; greenfield stance — correct schema over backwards
  compatibility; re-verify the next free `V<n>` at execution, never
  trust the prompt's number.

## Status log

(append here as sessions run)

- 2026-08-13 — programme authored: 7 specs + 11 prompts committed,
  build-gated. C1 + S10 in flight at authoring time; S9 + C0 merged.
- 2026-08-13 — **wave 1 green-lit and started** (P1 ∥ P3, one worktree and
  one dedicated Postgres each). Ratified wave plan for the rest:
  W2 = P2 ∥ P4, W3 = P5 alone (two migrations must never run
  concurrently — mid-wave `V<n>` collision), W4 = P6 ∥ P7. P8→P9→P10 and
  P11 stay strictly sequential behind their external gates.

### False premises found by wave-1 scouts (rulings, do not re-derive)

Seven citations in the D2/D7 specs were wrong at authoring time. All are
now rulings; the specs below are corrected in place.

**D2 / P1**

1. `capacity.impossible` matched **no** convention in the tree. Typed
   codes here are ALL_CAPS_SNAKE, no dots (`EngineErrorCode`:
   `STAGE_NOT_READY`; `HttpError`: `AI_PLAN_FAILED`); dotted-lowercase
   `capacity.*` exists in source only as i18n keys. **Ruling: the code is
   `CAPACITY_IMPOSSIBLE`**, thrown as
   `new HttpError(422, msg, "CAPACITY_IMPOSSIBLE", { report })`. The
   engine enum and `ENGINE_HTTP` map are NOT widened — the lib stays pure
   and throws nothing; the web layer throws.
2. **There is no competition-scope `/schedule/auto` route.** The prompt's
   "joint competition variant" does not exist under that name. Ruling:
   guard the stage auto route + `aiPlanForCompetition` (assess
   per-division, 422 with the impossible set); leave the apply route
   alone.
3. `ScheduleConfig`'s real field is **`matchMinutes`**, not the spec's
   `m`/`matchDuration`.

**D7 / P3**

4. **`standings_snapshots` has no history** — `writeSnapshot`
   (`engine-db/competition.ts:224-236`) is `on conflict do update` keyed
   `(stage_id, pool_id)` and clobbers the prior row. The spec's
   "standings moves" enrichment therefore had **no data source at all**.
   Ruling: add `previous_positions jsonb`, preserved on upsert via
   `case when positions is distinct from excluded.positions then …`.
   The `is distinct from` guard is load-bearing — `recomputeStandings` is
   idempotent and re-runs, and an unguarded assignment erases the delta
   on the second run. This makes P3 a schema session, which the table
   above did not anticipate.
5. **`post_drafted` does not exist** (`git grep` = 0 hits; the
   structured-logging wave `989e0ba8` touched no news files). The spec
   cited it as an existing event to extend. It is being created.
6. **Round-recap is not a separate trigger** — it is drafted inline by
   `draftPostsForDecidedFixture` when `TABLE_KINDS.has(stage_kind)`. One
   call site, not two.
7. **A job runner already exists** — GitHub Actions `schedule:` cron →
   `x-cron-secret`-guarded endpoint (funnel-reminders, billing-events,
   billing-grant, billing-quantity, ai-preview-sweep, all `-stg`). D7's
   conditional ("cron only if a runner exists") therefore resolves to
   **ship the cron**, following that shape, stg-only.

Watch item for every wave-1/2 session: `PostKind` is declared **twice**
(`org-posts.ts:32` and `schemas.ts:2941`) and may also carry a DB CHECK —
the same API-enum-⊃-DB-CHECK mismatch already flagged for D1's
`americano`/`page_playoff`. Verify all three sites, never two.

### Live-branch collisions during wave 1

- `feat/c1-round-ordering` edits `usecases/schedule.ts` (the exact file
  P1's guard touches) + `engine/src/scheduling/build.ts`. P1's edit to
  that file is kept minimal and additive for this reason.
- `feat/s10-w8-chassis-renderer` edits all four `dictionaries/*/ui.json`
  + `lib/i18n-keys.ts`. P1 and P3 both add keys there too, so keys are
  namespaced disjointly: **P1 `schedule.capacity.*`, P3 `news.*` /
  `digest.*`** (note `register.capacity.*` already exists, unrelated).

### P3 completion notes (2026-08-13)

Implemented on `feat/p3-news-enrichment` (11 commits), not yet PR'd.
V358 migration applied to the session's own test DB. Two things beyond
the scout's four rulings, found during implementation:

- Ruling 4 said `previous_positions`; the real column is `rows` (JSON
  array of `StandingsRow`, not `positions`), so the migration/code use
  `previous_rows` — same `is distinct from` guard, adapted name.
- **New finding, not scouted**: `org_posts_auto_once` (V295) keys on
  `(org_id, trigger, fixture_id, division_id, stage_id, round_no)` —
  none of which a digest has, so every digest after an org's first
  would collide and silently no-op. V358 also narrows that index's
  `where` clause to exempt `trigger = 'weekly_digest'`. Consequence:
  the button is deliberately NOT idempotent (every press is a fresh
  draft); the cron (ruling 7) relies on its own weekly schedule as the
  only dedup, and skips an org with nothing to report rather than
  posting an empty digest weekly — see `digestForOrg`'s docstring in
  `org-posts.ts`.
- `key-scopes.test.ts` (every v1 route classified for API keys) only
  reds under a FULL `apps/web` sweep, not a news-scoped one — the new
  digest route needed an explicit entry. Worth a standing note for
  every session adding a route: run the full suite at least once
  before calling it done, not just the feature's own directory.
- Digest button gated on `news.auto` (same entitlement as the
  system auto-drafts) — a judgment call, not explicit in the prompt;
  reasoning: a digest is system-composed content, same PLG line V295
  already draws between manual (free) and generated (Pro).
- e2e/screenshot mechanics: the MCP Playwright browser was locked by a
  concurrent process this session, so verification screenshots used a
  standalone `playwright-core` script instead (launches its own
  Chromium); hit the `Secure`-cookie-on-`127.0.0.1` trap (browsers
  don't send `Secure` cookies to a bare IP over HTTP, only to the
  literal `localhost` hostname) — worth flagging for any other
  wave-1/2 session doing its own local screenshot verification.
- Deferred per this session's brief: full e2e run (authored, unrun —
  `apps/web/e2e/news.spec.ts`) and the full `scripts/smoke.ts` run
  (extended, syntax-checked, unrun) — both need a live prod-built
  server; orchestrator runs them at the wave boundary.

### Wave 1 outcome (2026-08-13) — PRs #544 (P1) / #545 (P3)

Both lanes green. Nine defects were found that no scout and no spec
predicted; six of them were **invisible to a passing test suite**, which
is the reusable lesson for waves 2–4.

Real defects found, by how they hid:

1. **Inert feature, compiler-proof.** P1's competition guard called
   `toSlotConfig` (never sets `tz`) where `toVerifyConfig` was meant.
   `SlotConfig` is structurally assignable to `VerifyConfig`, so tsc
   could not see it and the guard silently no-opped on every division
   since it was written. The review had filed this as "route lacks test
   coverage"; the missing test was hiding a dead feature, not merely an
   unproven one. See [[reference_verifyconfig_slotconfig_silent_widening]].
2. **Unique index swallows the feature.** `org_posts_auto_once` (V295)
   keys on five fields a weekly digest does not have, so every digest
   after an org's first would have silently no-opped.
3. **Aborted-transaction masking.** A rejected SQL statement aborts the
   whole `withTenant` transaction server-side; a JS `catch` does not
   undo that, so a later unrelated try/catch fails on its own first
   query with "current transaction is aborted", masking its real error
   and risking the draft's own INSERT. Fail-open that has never actually
   caught anything is an untested branch. Fixed with `tx.savepoint()`.
4. **Wrong-at-scale, not wrong-in-the-small.** The digest cron scanned
   every org: fine at 3 orgs, exceeded a 30s timeout at 7,305. Passed in
   isolation, failed only in a full run — and CI runs full. 30005ms →
   2051ms after an indexed pre-filter. The test's failure was a
   **timeout**, which `rtk` had redacted to `STACK_TRACE_ERROR`.
5. **Contract bloat.** `capacity_report` landed on the shared
   `ERROR_ENVELOPE`: 776 occurrences, both OpenAPI artifacts roughly
   doubled (`v1.json` 74,098 → 166,486 lines).
6. **Three-way name disagreement.** Guard threw `report`; OpenAPI and
   smoke read `capacity_report`. The smoke assertion could never have
   passed, unnoticed only because smoke was authored-not-run.
7. `computeLeaderboardMoves` rolled back one contributor's credit, so
   any 2+ scorer fixture fabricated rank-move claims in published drafts.
8. A new test called `run()` bare and never reached its own assertion.
9. `streak` sat behind the scorers guard, unreachable for forfeits.

Process notes worth carrying forward:

- **Mutation, not argument.** The reviewer hand-derived the arithmetic
  and concluded P1's cited regression test could not catch the
  `declaredConfig` bug. Reverting the line reds that exact test. Derive
  nothing about solver behaviour by hand — mutate and run.
- **Both-ways placement runs earned their keep.** The one persistent red
  (`schedule-solver-telemetry`, `expected 'solver_unavailable' to be
  'infeasible'`) passes with CP-SAT live and also appears on P3, which
  touches no scheduling code — two independent proofs it is
  environmental. The engine coverage gate also went red purely under
  concurrent agent load and was exit 0 on a quiet machine; run gates
  serially before believing a timing red.
- **Agents died to the 600s watchdog five times**, twice losing their
  transcript so they could not be resumed. Long commands must be
  detached-and-polled, and work committed before any long run. Two lanes
  were finished by the orchestrator directly for this reason.
- The `_INDEX.md` conflict recurs every wave: sessions edit it, main
  edits it. Wave 2 onward, sessions should NOT touch this file — the
  orchestrator writes the outcome at the wave boundary.

### Wave 1 CLOSED — merged 2026-08-13

`78c8618f` (P1 / #544, 12 CI checks green) and `51601495` (P3 / #545,
8 green). P3 rebased onto post-P1 main cleanly; all four dictionaries
carry both key families (14 `schedule.capacity.*`, 65 `news.*`/`digest.*`)
at identical counts, and all three drift gates regenerate to zero drift.

**The four e2e defects CI caught after both sessions reported done** are
the most transferable lesson of the wave. Every one was in a spec that
had been authored and typechecked but never executed, and two were
assertions that could not have failed:

- P1's spec navigated to the bare division path, which renders
  **Entrants** — `stage-auto-schedule` is not on it at all. The symptom
  was `toBeEnabled` timing out; the real error was `element(s) not
  found`. It survived review only because an earlier line failed first,
  so those lines had never run once.
- P3's `.first()` wait was **vacuous**: a prior row already satisfied
  it, so it never waited for the new insert and the API read raced the
  server. Passing would have meant nothing. Both digest specs now wait
  on the row count rising by exactly one, which is also retry-proof —
  digests are deliberately not deduped, so a Playwright retry leaves an
  extra draft and trips strict mode.

Ruling for waves 2–4: **a session may not report done on an unrun e2e
spec.** Authoring plus tsc is not evidence. If the session cannot run it,
it says so as a blocker rather than as a deviation, and the orchestrator
runs it before the PR — not after.

Ground truth for a CI-only e2e failure is the run's `playwright-report-*`
artifact: its per-failure ARIA snapshot shows what was actually on the
page, which is how the Entrants-tab diagnosis was settled rather than
guessed.

### Wave 2 IN FLIGHT (2026-08-13) — state at compaction

**P2 (D3 health) — GREEN, PR #547 open and pushed.** 23 commits on
`feat/p2-schedule-health`, worktree `.claude/worktrees/p2-health`, own
Postgres `:54411`. Gate re-verified after its fix round: engine
`test:coverage` exit 0, apps/web 6916/6857/1 (the known
`schedule-solver-telemetry` no-placement red), tsc 0, lint 0 errors,
drift gates clean. e2e 5/5 — **run by the orchestrator** against a real
standalone prod server on :3207. Six review findings closed; details in
the PR comment.

**P4 (D1a templates) — 12 commits, THREE items open.** Branch
`feat/p4-format-templates`, worktree `.claude/worktrees/p4-templates`,
own Postgres `:54413`, migration **V359** (`competitions.template_key` /
`template_version`). Fix round `cdab6d5a` closed all 8 first-review
findings. Still open when this was written:
1. `COMPETITION_MADE_PUBLIC` is never fired from the template path
   (`createCompetition:207-214` fires it via `shouldFireMadePublic`;
   `CreateFromTemplate.visibility` accepts `"public"`). The fix for
   "no funnel events" closed only the emitter the review named and left
   its own bug class half-open.
2. Nothing pins "fires exactly once" on the ORIGINAL manual paths
   (`competitions.ts:205`, `divisions.ts:248`) — the extraction is what
   makes that dangerous.
3. **`tsc --noEmit` on apps/web is RED at HEAD** —
   `format-gates.test.ts(46,72)` TS2353, `thirdPlace` not in
   `{byes?, cross_feeds?, placements?}`. The test is right; the bug is
   that `stageNeedsAdvancedFormatsGate`'s `config` param is too narrow
   for jsonb stage config. Production call sites compile only because
   they pass variables — excess-property checks fire on literals only.

**Next steps in order:** P4 finishes those three → orchestrator reruns
P4's gate on a QUIESCENT tree → P4 PR → both PRs merged → wave 3 =
**P5 alone** (it carries the remaining migration; two migrations must
never be in flight together).

**Environment still standing:** CP-SAT placement service on `:50077`
(secret `dev-secret`) for both-ways scheduling gates; four lane
databases (`:54401` p1, `:54343` p3, `:54411` p2, `:54413` p4).

**Two process notes earned this wave.** Never run a gate on a worktree
while an agent is active in it — two of three failures in one P4 gate
run were the sibling's in-flight edits, exactly the documented trap.
And `roundrobin.test.ts` "idempotence: regeneration is byte-identical"
joins the load-sensitive set: it went red in a loaded full run and
passed 42/42 in isolation, with the coverage run passing the same tests
minutes later. An idempotence test reads as a determinism bug, so it
will alarm the next session that sees it.
