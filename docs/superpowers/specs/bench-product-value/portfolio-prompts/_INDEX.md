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
| P1 | D2 capacity lib + route guard + card | `P01-capacity-precheck.md` | — | green-light | TODO |
| P2 | D3 health lib + route + panel | `P02-schedule-health.md` | — (P1 pattern reuse, soft) | green-light | TODO |
| P3 | D7 enrichment + weekly digest | `P03-news-enrichment.md` | — | green-light | TODO |
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
