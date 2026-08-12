# B00 — re-pin & refresh (first motion after the gate opens)

Read `_RULES.md`, `_INDEX.md`, bench spec §11 + §13. Docs-only session —
no product code. Branch in a worktree anyway (docs PR).

## Goal

The whole programme was authored 2026-08-13, before S10–S13 and C1–C8
landed. This session makes every downstream brief trustworthy again and
answers the spec's open risks, so B01+ never rediscover them.

## Scope

1. **Scout sweep** (parallel, read-only): re-pin every file:line, enum,
   zod shape, route and usecase cited across the bench spec + B-prompts:
   `ScheduleConfig`/conflict codes (post-C3 structured details), engine
   enum (post-C7 `optimized`, stored-row rewrites), repair enum, stats
   surfaces (post-S8/S9 names re-confirmed), scoring entry points
   (post-S13 — pad v2 is the only path now), officials/claims/news
   usecases, `setPlan` helper, `sync:sports`.
2. **Answer spec risks 1–9** with evidence, in the spec's §11 inline
   (edit the doc): stage progression (did D4/P5-P6 ship? → advancement
   strategy per suite), swiss manual fixtures, futsal cfg fit verdict
   (S2 Div B = futsal or WEuro fallback — decide now), StageKind CHECK
   current values, throughput plan (is D6/P11 live?), tennis
   walkover/retirement path, placement local-run recipe, plan→feature
   map rows for `scoring.ball_by_ball`/`stats.player`/rally keys.
3. **Portfolio inventory**: which of P1–P11 shipped; record in
   `_INDEX.md` which shared libs exist (capacity/health/court-windows,
   D4 flows, D6 import) — each B-prompt names its fallback when absent.
4. **`seazn-local-env` addendum**: placement-service section (env var,
   local grpc bring-up, health probe, the run-both-ways rule).
5. Update `_INDEX.md` status log + any B-prompt whose premise moved
   (edit the prompt file, note the edit in the log — briefs must never
   carry known-stale pins past B00).

## Do NOT

Write bench code; touch product code; re-open decided rulings (both
"Decisions already made" blocks).

## Acceptance

- [ ] Every citation in spec + prompts re-pinned or corrected
- [ ] Spec §11 risks 1–9 each carry an evidence-backed answer
- [ ] Futsal-vs-WEuro decided and recorded (suite 2 Div B)
- [ ] Portfolio inventory table in `_INDEX.md`
- [ ] seazn-local-env has the placement section
- [ ] `_INDEX.md` status log updated; docs PR merged

## Verify

Docs-only: `git status --porcelain` clean after commit; no code gates.

## Output cap

Final message under 15 lines — corrected-pin count, risk answers table
(one line each), portfolio inventory, blockers.
