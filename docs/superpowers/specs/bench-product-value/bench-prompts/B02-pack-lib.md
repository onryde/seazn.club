# B02 — pack lib: PackSchema, stage-0 validator, reconstruction

Read `_RULES.md` → `_INDEX.md` → bench spec §4. Depends on B01.
Worktree; one PR. **PackSchema freezes at the end of B06 — design it
here like a public contract.**

## Scope

1. `scripts/bench/lib/pack-schema.ts` — zod `PackSchema` per spec §4:
   org/comp/divisions (sportKey, variantKey, cfg overrides, tiebreakers,
   stages incl. real bracket maps), persons (lane:
   player/official/coach/staff), entrants (team/pair/individual) +
   rosters (squad numbers, positions, captain, libero, pairs), streams
   `{fixtureExtKey, provenance: "real"|"reconstructed", events[]}`,
   `historicalAssignment` (venue+start per fixture, optional),
   `expected{}` (per-match result, per-stage tables with exact tie
   order, champion, leaders with counts, suspensions→fixture,
   specials), `meta{sources[], adaptations[]}`.
   Design notes binding here: pack schema ⊃ template schema (D1) — a
   strip function `packToTemplateSkeleton` ships with a test proving
   the subset relation; `ext_key` is the join key everywhere (fixtures
   are created via generators, matched by ext_key, never by array
   order).
2. `scripts/bench/lib/validate-pack.ts` — stage-0: zod parse →
   per-stream `foldMatch` with the division's cfg + pinned module →
   folded outcome equals expected → fold-derived standings equal
   expected tables (points AND tie order) → specials assertions
   (declared per stream kind: super_over, dls_revise, shootout, ot_gws,
   final_set_tb, expedite, retirement, concussion_sub, draw_half_points)
   → provenance stats. Pure, in-process, no DB. Shares its
   fold-then-trust shape with D6's dry-run (if P11 shipped, extract
   nothing — they stay parallel implementations of ONE documented
   contract; divergence is the parallel-paths defect, so a
   contract test in this session runs one stream through BOTH when D6
   exists).
3. `scripts/bench/lib/reconstruct.ts` — legal-sequence generators for
   side-attributed sports (setbased rally streams to exact real set
   scores; period fillers where the sheet says so). Deterministic:
   seeded PRNG with the seed IN the pack; identical output across runs.
4. Vitest suite for all of the above — CI-safe (no DB, no env): this is
   the bench's permanent CI presence.

## Do NOT touch

Engine source, golden corpora, product code. The validator READS engine
modules via public exports only.

## Acceptance

- [ ] Unit: schema edge cases (pair rosters, coach lanes, TBD-less
      brackets, adaptation entries); reconstruction determinism (same
      seed → byte-identical) and exactness (folds to the target score,
      N random targets per setbased sport)
- [ ] Regression: a deliberately-corrupted stream (wrong scorer, extra
      ball, swapped tie order) → validator names the stream AND the
      first divergent assertion; a `"real"`-flagged reconstructed
      stream is UNDETECTABLE by code — so the check is procedural:
      provenance spot-check instruction lives in the playbook, and the
      validator at least reds provenance MISSING
- [ ] Contract: `packToTemplateSkeleton` subset test; D6-parity test if
      P11 shipped (else recorded as pending in _INDEX)
- [ ] A hand-written micro-pack (`packs/_tiny.json`, one 2-entrant
      division, 3 streams incl. one reconstructed) validates green and
      becomes B01's `_tiny` suite input — runner + validator now share
      one fixture
- [ ] Counts pasted from JSON reporter; lint clean; engine tsc
      untouched (no engine edits)

## Verify (verbatim)

```bash
npx vitest run --reporter=json --outputFile=/tmp/b2.json scripts/bench
jq '{total:.numTotalTests,passed:.numPassedTests,failed:.numFailedTests}' /tmp/b2.json
rtk proxy npm run lint
npm run bench:scheduler -- --suite _tiny --wipe
```

## Output cap

Final message under 15 lines — commits, counts, schema surface summary
(top-level keys only), deviations.
