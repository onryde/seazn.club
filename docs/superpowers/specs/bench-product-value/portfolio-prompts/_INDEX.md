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
| P1 | D2 capacity lib + route guard + card | `P01-capacity-precheck.md` | — | green-light | **IN FLIGHT** (wave 1) |
| P2 | D3 health lib + route + panel | `P02-schedule-health.md` | — (P1 pattern reuse, soft) | green-light | TODO (wave 2) |
| P3 | D7 enrichment + weekly digest | `P03-news-enrichment.md` | — | green-light | DONE — impl+tests on `feat/p3-news-enrichment`, PR not yet opened |
| P4 | D1a template catalog + instantiation + wizard | `P04-templates-single-stage.md` | — | green-light | TODO |
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
