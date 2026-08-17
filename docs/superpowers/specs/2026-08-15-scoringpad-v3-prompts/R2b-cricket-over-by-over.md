# R2b — cricket over-by-over: give it a real tile

**Status:** TODO. Depends on R2 merging. Owner requirement 2026-08-17.

## Correction to this file's first draft (read this before anything else)

The first version of this brief claimed over-by-over scoring "does not exist
and never did", off a single negative grep (`git log --all -S'cricket.over'`)
for an event type that never needed to exist. **That was wrong.** The owner
was right: v1 exposed over-by-over, and the engine still supports it.

It is not a separate event type. It is a **workflow on the existing band-0
event**: `CricketInningsSummary` (`cricket.ts:230-237`) carries
`runs`, `wickets`, `legalBalls` and — the load-bearing field — **`partial:
true`**, documented at `cricket.ts:225`:

> `partial: true` = in-progress snapshot: totals update an open innings and
> the fold's auto-close rules (all out / balls exhausted / target passed)
> decide closure — exactly the rules a fine innings closes under, which is
> what makes cfg-free coarsening possible.

So a scorer posts a partial summary **after each over** with the running total
and wickets, and the fold advances the innings. That is precisely "we enter
total score and wicket", per over.

Consequences, all of which SHRINK this wave versus the first draft:

- **No new event type. No schema change. No golden re-baseline.** The fold,
  the auto-close rules and the coarse-fidelity path all exist and are tested.
- **No fidelity-band decision.** It is already band 0 — free, below both paid
  tiers. The earlier "put it at band 1" ruling is moot and should not be
  applied; the ladder stays exactly as it is, closed at 0–3.
- **Not an engine wave.** This is a PAD wave.

## The actual gap

The v3 cricket skin declares **no tile** for `cricket.innings.summary`. The
event types its tiles dispatch are only `cricket.toss`, `cricket.review` and
`cricket.innings.close`; everything else — including `innings.summary` — is
reachable only through the generic "More" sheet's `padSpec(cfg)`-driven form
(`v3/skins/cricket.tsx:46-47`).

That is a bad fit for an action a scorer performs **every over**: it costs a
tile tap, a sheet open, and a scroll through a generic form, once per over,
for the whole innings.

Note this is the THIRD capability the legacy/v1 surface had that v3 does not
surface well — alongside event history + per-event void, and the fold's result
headline (both fixed in R2). The pattern is the point: v3 was rebuilt from
primitives and capability parity was never asserted anywhere. R2 adds a
legacy-parity test; extend it here rather than re-discovering this per wave.

## Scope

- A real over-by-over tile in the cricket skin that posts
  `cricket.innings.summary` with `partial: true`, taking runs and wickets.
- Reachable at band 0, so it survives R2's chassis band filter automatically
  (`filterTilesByBand` keeps any tile whose event band the org holds; band 0
  is held by everyone).
- i18n across all 4 locales, flat dotted keys. A new per-sport ribbon key must
  ALSO reach `PAD_LABEL_KEYS` in `scoring-vocab.ts` or the ribbon copy stays
  on the generic fallback with nothing failing.
- Tests: a unit test that fails without the tile, and coverage that a sequence
  of partial summaries folds to the same innings totals a scorer expects.

## Two open questions for the owner (do not guess)

1. **Which bands show the tile?** Band 0 is the floor, but a band-3
   (ball-by-ball) org may still want to fall back to over-level entry
   mid-match — bad light, a scorer handing over, catching up after a gap.
   Recommendation: show it at every band. Falling back is a real scoring
   need, and the engine already accepts summaries on an open innings.
   **Caveat to test first:** cricket REFUSES ball events on a
   summary-fidelity innings (`cricket.ts:1130`, `:2937` — "this innings is
   recorded at summary fidelity — ball events are not allowed"). Confirm
   whether the reverse holds (a partial summary on a ball-scored innings)
   before promising a mixed workflow — if the fold refuses it, this tile
   must be band-gated after all, and that is a real constraint rather than a
   preference.
2. **Prefill or increment?** Does the tile take the innings' running total
   (prefilled from the fold, scorer edits upward) or this over's increment
   (added to the fold's total)? The payload is a TOTAL (`runs` is the innings
   figure), so an increment form must add before dispatch. Prefilling is
   closer to the payload and harder to get wrong; an increment is closer to
   how a scorer thinks about an over.

## Traps

- **An engine-only diff still breaks `apps/web`** — but this wave should touch
  no engine at all. If it starts to, stop: that means the premise moved again.
- Root `turbo run typecheck --force` and `lint --force` are CI's gates.
- Tie/super-over goldens exist (`cricket.test.ts:298`, `:759`). Partial
  summaries must not disturb them.
