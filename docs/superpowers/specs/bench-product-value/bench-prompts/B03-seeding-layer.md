# B03 — seeding layer (orgs → rosters → officials → plans → claims)

Read `_RULES.md` → `_INDEX.md` → bench spec §4 (entitlements), §9
(people layer). Depends on B02. Worktree; one PR.

## Scope

`scripts/bench/lib/seed.ts` — pack in, live org out, all via API except
the two sanctioned SQL touches:

1. Org + competition + divisions (sport/variant/cfg/tiebreakers) +
   stages per pack — through the same public APIs the app uses (magic
   link session from B01). Fixture generation via stage generate;
   fixtures matched to pack streams by `ext_key` (creation order is
   never trusted).
2. Persons ×lanes (player/official/coach/staff), entrants
   (team/pair/individual), rosters with metadata (squad numbers,
   positions, captain, libero, pair order).
3. **Plan/entitlement provisioning**: `setPlan`-by-SQL precedent
   (smoke.ts) using B00's verified plan→feature rows; then a probe:
   POST one deepest-tier event to a scratch fixture EXPECTING 201, and
   one against a free-plan scratch org EXPECTING the typed 422 — the
   gate is proven to exist AND to be cleared (a vacuous-green guard).
4. Officials: seeded + assigned per pack (auto-assign where the pack
   says, manual where named); official blackouts loaded.
5. Claims: `pc_` invites created for the pack's flagged stars (the
   accept flow is B05's, seeding only mints invites); coach lanes
   seeded for P3-style assertions later.
6. Idempotence: re-running seed for an existing suite org with `--keep`
   detects and short-circuits (by org slug + pack hash), so iterating
   on later layers doesn't duplicate orgs.

## Do NOT touch

Product code, packs other than `_tiny` (+ extend `_tiny` if a shape is
missing), scoring paths (B05).

## Acceptance

- [ ] `_tiny` seeds green end-to-end; second run short-circuits
      (idempotence test)
- [ ] Entitlement probe: both directions asserted by CODE
      (`capacity`-style typed error, not bare 422)
- [ ] Unit: ext_key matching (shuffled creation order still binds
      streams correctly); roster metadata mapping per entrant kind
- [ ] Regression: a pack person with lane=coach never lands in a
      playing roster projection (S3 ruling, asserted via API read)
- [ ] Officials assigned + blackout visible via API read-back
- [ ] pino: `suite_seeded` (org, persons, entrants, fixtures, ms)
- [ ] Counts pasted; lint clean

## Verify (verbatim)

```bash
npx vitest run --reporter=json --outputFile=/tmp/b3.json scripts/bench
jq '{total:.numTotalTests,passed:.numPassedTests,failed:.numFailedTests}' /tmp/b3.json
rtk proxy npm run lint
npm run bench:scheduler -- --suite _tiny --wipe
```

## Output cap

Final message under 15 lines — commits, counts, `_tiny` seed timings,
deviations.
