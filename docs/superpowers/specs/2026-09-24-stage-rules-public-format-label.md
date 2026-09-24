# Per-stage match rules — public format label (bug) + hub stage format lines (T7)

Date: 2026-09-24. Branch `fix/stage-rules-public-format`, worktree
`.claude/worktrees/stage-format-label`, off `origin/main` `5b46a6a5a`.

## The defect (verified in prod 2026-09-24)

Fixture `4137d495-7668-460e-9afb-82722e93ea9c` (southend-sports-community /
badminton-2026 / boys-singles, Swiss stage, scheduled):

- division `variant_key = short`, `config` = `{bestOf:3, setTo:11, cap:15, finalSetTo:11, winBy:2, ...}`
- stage `Swiss`, `config.rules` = `{bestOf:1, setTo:15, cap:21, finalSetTo:15, winBy:2}`

Public match page Info tab + header meta line read **"Short (11 points)"**.
Scoring is correct — `match-centre-load.ts:295` resolves
`resolveFixtureCfg(snapshot, division.config, stage.config)` — but the LABEL
is `variantLabel(division.variant_key)` in both loaders
(`server/public-site/data.ts:1114`, `server/usecases/public.ts:626`), which
never sees the stage overlay.

Poster (`server/og/match-poster.tsx:368-371`) falls back to
`header.metaLine` for live/final states, so it inherits the same wrong label
(pre-match poster shows "Starts …" instead, so prod posters today look fine).

Separately, spec `2026-09-17-per-stage-match-rules-override-design.md` §D3/T7
(hub `stageFormatLines`) was never built — `grep stageFormatLines` finds nothing.

## Decisions (orchestrator, 2026-09-24; owner asked for "fix 1 and 2")

- Owner scope: (1) fixture/match-centre label AND (2) T7 hub per-stage lines.
- Label wording: option A, the recommendation put to the owner — describe the
  EFFECTIVE rules: `1 game · 15 points (cap 21)`, `Best of 3 · 11 points (cap 15)`.
  Owner did not object; recorded as a recommendation, not an owner ruling.
- WHEN the described label replaces the variant name: when the fixture's
  resolved cfg differs from the division cfg on the sport's rule keys
  (`configKeysFor(sport)`). Otherwise the variant name stays (no copy change
  for any division without overrides).
- Rule keys differ ⇒ ALWAYS a described line, never the preset name, even if
  the line is vague (review round 2). A round-1 "same words ⇒ keep preset"
  guard was tried and reverted: it printed a FALSE preset for tennis (a Fast4
  stage in a "Tour" division read "Tour"). A true-but-vague line beats a
  false name; badminton `winBy`-only therefore gets a line.
- Wording: clauses joined with ", " (not " · ", which `metaLine` already
  uses as its own joiner) — `1 game, 15 points (cap 21)`; a decider clause
  when `finalSetTo` differs; a best-of-1 states `finalSetTo` because the engine
  plays the last possible set to it (`setTarget`, setbased/kernel.ts). Tennis
  states set shape, deciding set and no-ad from `format.rules.tennis.*` keys
  (not `SPORT_RULES` labels, which are English-only by design).
- T7: `stageFormatLines` only for stages whose effective rules differ from the
  division's (an identical line per stage is noise). Uses the same describer
  as the fixture label so the two surfaces never disagree. `formatLine` was
  never rendered anywhere; the lines are a new "Format by stage" box on the
  hub Info tab, plus a stage chip on the public division page.

## Owner finding (not fixed here)

On a best-of-1 stage the Fixture Console lets an organiser set the points
target (`setTo`), but the engine plays the only set to `finalSetTo`, so the
edit has no effect and nothing says so.
- Out of scope (note only): a division whose OWN config was edited away from
  its preset still shows the preset name.
