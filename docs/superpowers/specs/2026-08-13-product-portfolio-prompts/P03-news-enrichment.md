# P3 — News enrichment + weekly digest (D7)

Read first: `_RULES.md` → `_INDEX.md` → spec
`../2026-08-13-news-enrichment-design.md`. Worktree + fresh branch.

## Scope

1. Extend `ResultDraftInput`/`RoundRecapDraftInput` with optional
   `enrichment` (top performers, leaderboard moves, streaks / leaders,
   biggest result, standings moves). Templates stay PURE; absent
   enrichment ⇒ byte-identical output to today (anchor test).
2. Enrichment assembly at existing call sites
   (`draftPostsForDecidedFixture`, round-recap trigger): one pure helper
   per source (match summary, `divisionPlayerStats` diff, standings
   snapshots). FAIL-OPEN: any source error ⇒ plain draft + pino warn,
   never a missing draft.
3. New draft kind `weekly_digest` (standings movement, leaders, next 7
   days, claimed-player highlight) — trigger = button on org posts admin
   page; window = last 7 days in org tz (`settings.orgTz`, never
   `settings.tz`). Cron ONLY if a job runner already exists (scout
   answers; if none — button only, no new infra).

## Files (scout re-pins first — S9 refactored player-stats.ts)

- `apps/web/src/server/news/draft-templates.ts` + its tests
- `apps/web/src/server/usecases/org-posts.ts` (drafting call sites,
  digest usecase), posts admin page component, `schemas.ts`/OpenAPI if
  the digest button needs a route, 4 dictionaries

## Do NOT touch

`packages/engine/**`, scoring paths, `shouldFirePostPublished` semantics,
public post rendering beyond what new sections require.

## Acceptance criteria

- Unit: full/partial/absent enrichment; absent = byte-identical (the
  no-regression anchor); leaderboard diff math; digest window across a
  DST boundary in org tz.
- Regression: new dictionary keys asserted present in ALL 4 locales,
  seeded from the template's own key list, NOT from the dictionaries
  (event-copy-gate lesson); poisoned stats source still yields plain
  draft.
- E2E: decided fixture → enriched draft visible; digest button → draft
  with sections; publish flow unchanged.
- Smoke: enriched result draft + digest generation.
- No concatenated sentence fragments — parameterized keys only.
- pino: `post_drafted` gains `{enriched, kind}`.

## Verify (verbatim)

```bash
npx vitest run --reporter=json --outputFile=/tmp/p3.json apps/web/src/server
jq '{total:.numTotalTests,passed:.numPassedTests,failed:.numFailedTests}' /tmp/p3.json
rtk proxy npm run lint
npm run openapi:gen && git status --porcelain
```

## Execution & close

**Scout (Sonnet High):** re-pin draft call sites + post-S9 stats
signatures; job-runner existence answer. **Implementer (Sonnet MAX):**
spec's Digest content rules + Failure matrix verbatim in the brief.
**Reviewer (Sonnet MAX):** absent-enrichment byte-identity real (byte
compare), fail-open proven with a genuinely poisoned source (not a
mock that cannot fail), i18n gate seeded from the key list; gap list
only. Close per `_RULES.md` §5.

## Output cap

Final message under 15 lines — commits, verified counts, files touched,
deviations, blockers. No file contents, no diffs.
