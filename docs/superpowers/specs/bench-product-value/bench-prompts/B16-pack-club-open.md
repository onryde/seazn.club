# B16 — suite 13 "Club Open" (customer journey, UI-first)

Read `_RULES.md` → `_INDEX.md` → `_PACK-PLAYBOOK.md` → customer-journey
spec `../designs/2026-08-27-bench-customer-journey-design.md` §5 (the
suite table and journey are the contract). Depends on B03r, B05, B06
pilot. Parallel-safe with B07–B15 (own pack file). Worktree; one PR.

## Re-pin first

Scout: board toolbar generate/auto-schedule controls (#650,
`apps/web/src/components/v2/board-*`), competition + division create
forms (`division-builder.tsx` testids from B03r PR 0), public standings /
results pages, ScoringPad v3 tile ids for **badminton** and **football**
and **tennis** (`apps/web/src/components/v2/scorepad/v3/registry.ts`,
`tile-grid.tsx`, skins in `../scorepad/skins/` — badminton is the
`racquet-skin.tsx`; no badminton walkthrough exists, so its tile ids are
discovered here),
signup route. Paste re-pins into the PR body.

## Scope

1. **Pack** `scripts/bench/packs/club-open.json` built by
   `scripts/bench/build-packs/club-open.ts` — fully synthetic
   (`provenance:"synthetic"` on every stream and on the entry layer),
   deterministic (seeded PRNG, seed in `meta`), spec §5 table verbatim:
   - U16 Singles · badminton · `age_max:15` · individual · free · auto · 16 entries · 1 over-age offender · KO
   - Mixed Doubles · badminton · `mixed` · pair · paid · auto · 6 pairs + 2 free agents · 1 M+M offender · RR
   - Open Men's 5s · football · `mens` · team · paid · manual · 10 teams × 6 · 1 roster with a woman (blocked at submit) · cap 8 ⇒ 1 waitlisted · approve ×7, reject ×1, promote ×1 (pays) · 2 groups + final
   - Women's Open · tennis · `womens` · individual · free · manual · 8 · 1 male offender · approve ×7 · KO
   Every person has `dob` + `gender`; ≥3 persons play two divisions
   (career-rollup oracle). Expected: champion + final table per
   division, funnel `expect` per division, `paid_cents` = 6 pairs + 8
   teams (7 approved + 1 promoted) at the pack's fee. Stage-0 folds
   green offline before anything else.
2. **Journey drivers** (extend `lib/drivers/browser.ts`, never the http
   driver) — every row of spec §5.1 through the UI:
   - `signupOrg()` — signup page → magic link → org created.
   - `createCompetition()`, `createDivision(block)` — builder testids
     `division-builder-name/-category/-age-min/-age-max/-create`.
   - `configureRegistration()` — hub Settings tab testids (B03r PR 0).
   - captains/players/consent/pay — already in B03r.
   - `organiser.act()` — hub Registrants tab testids.
   - `generateFixtures()`, `autoSchedule()`, `resolveConflicts()` —
     board toolbar; the B04 independent checker still runs on the
     fetched fixtures afterwards (checker is not replaced by the UI).
   - `Scorer.play(fixture, stream)` — pad tapping per sport, lifted from
     `scorepad-v3-deciders-fullmatch.spec.ts` (`pad`/`tile`/`sheet`/
     `tapTile`/`tapThroughSheet`/`startMatch`) with own `assert`, no
     `@playwright/test`. Sequential within a fixture (`expected_seq`),
     parallel across fixtures (separate contexts). Score read-back via
     `GET /api/v1/fixtures/:id/events` + `/state`, never DOM scraping.
     Badminton driver is new: write it from the v3 badminton module's
     tile ids; **it must be the same taps a human makes** (no hidden
     API fallback — that would reproduce the "API-driven e2e blind to
     pad payloads" trap).
   - `readResults()` — public standings/results pages → champion +
     table, compared to the pack's `expected` AND to the API read.
3. **Suite runner** `lib/suites/club-open.ts`: journey in §5.1 order;
   `--suite club-open` runs it alone (the standing "does my product work
   for a customer" smoke). Screenshots at each journey step under
   `--keep` (report links them).
4. **Oracles** (all gated): funnel (§5.2), champion per division, final
   tables, career rollup for the multi-division persons, checker
   conflicts = 0, offenders blocked at submit AND when the organiser
   tries to force them via the hub (RS011 organiser-side gate).
   Free-agent assignment (Mixed Doubles' 2 free agents) is **performed
   through the hub but report-only** in v1 (spec D4) — its outcome is
   logged, never gated.
5. **Report**: journey step table with wall-times (report-only), funnel
   table, pad taps count + wall (report-only), oracle results.
6. pino: `journey_step` (step, ms, screenshot), `pad_match_done`
   (fixture, sport, taps, ms).

## Task ladder (TDD, one commit each)

| # | Test first | Then |
|---|---|---|
| 1 | `build-packs/club-open.test`: pack builds deterministically (same seed ⇒ same hash); stage-0 green; each division's `expect` arithmetic | pack builder |
| 2 | stage-0 regression: remove the M+M pair's `expect:rejected_eligibility` ⇒ red "offender not declared" | — |
| 3 | `drivers/browser` selectors table unit: every testid the journey uses is listed once (a typo here is a run-time 30-min loss) | selector map |
| 4 | (live) `signupOrg` → `createCompetition` → 4 divisions; API read-back matches pack | organiser journey |
| 5 | (live) funnel for all four divisions; funnel oracle green; paid path through Checkout ×(6+8) | captains/players |
| 6 | (live) fixtures + auto-schedule via toolbar; checker green | board |
| 7 | (live) badminton pad driver on one U16 match to a result; then football, tennis | scorer |
| 8 | (live) full suite; champion/table/rollup oracles; `--keep` screenshots | closeout |

## Do NOT touch

Product code (defects found ⇒ RS follow-up issue + separate PR, never
here); other packs; http driver; PackSchema (frozen after B06 — if a
shape is missing, escalate in the PR).

## Acceptance

- [ ] Stage-0 green offline; deterministic build hash committed in `meta`
- [ ] Full `--suite club-open` run green, both with and without the placement container (`_RULES.md` §2)
- [ ] Every §5.1 row executed through the UI — PR body lists the surface per row with a screenshot link
- [ ] ~50 matches pad-tapped; zero event-stream POSTs from this suite (assert: the suite's http client made no `POST …/events` — a regression test on the request log)
- [ ] Offender forced-in via hub ⇒ blocked (RS011) — screenshot of the block
- [ ] Wall-times in the report, none gated
- [ ] Counts pasted (JSON reporter); lint clean; re-pins in PR body

## Verify (verbatim)

```bash
npx vitest run --reporter=json --outputFile=/tmp/b16.json scripts/bench
jq '{total:.numTotalTests,passed:.numPassedTests,failed:.numFailedTests}' /tmp/b16.json
rtk proxy npm run lint
npm run bench:scheduler -- --suite club-open --wipe
PLACEMENT_SERVICE_HOST=127.0.0.1:1 npm run bench:scheduler -- --suite club-open --wipe
```

## Output cap

Final message under 15 lines — commit, counts, journey wall per step,
pad taps/wall, oracle table, deviations.
