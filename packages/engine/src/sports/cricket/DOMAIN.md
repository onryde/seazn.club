# Cricket — domain audit (W4, #407 programme)

## What this is

A per-fact audit of the cricket module against what a real cricket scorebook
records, one row per scorable fact, per declared variant. The question this
answers is **not** "does the UI show it" but "can the schema even hold it":

```
sport reality  ⊇  eventSchema / configSchema / State / summary
```

A fact marked `deferred` here is a fact no scorer will be able to record until
someone lifts it, so every deferral carries its reason.

**Audited against**

- MCC *Laws of Cricket* (2017 Code, 3rd edition 2022) — Laws 4 (the ball),
  15 (declaration and forfeiture), 18 (scoring runs / short runs), 20 (dead
  ball), 21 (no ball), 22 (wide), 23 (bye and leg bye), 24 (fielder's absence
  and substitutes), 25 (batter's innings and runners), 20.4/41 (penalty runs),
  and the ten modes of dismissal in Laws 30–39.
- ICC *Standard Playing Conditions* for Test, ODI and T20I — free hit, DRS,
  powerplays, the two-new-balls ODI condition, super over.
- The ECB/ACS linear and card scorebook conventions: batting card, bowling
  figures, extras columns (b / lb / w / nb / pen), fall of wickets,
  partnerships.
- ICC/ECB *Duckworth-Lewis-Stern Standard Edition* for the revision math
  already implemented in `dls.ts`.

**Declared variants** (`cricket.variants`): `t20`, `odi`, `hundred`, `test`.
They differ materially and the table says where.

A fifth variant, `pairs-6-a-side`, was **dropped 2026-08-11** (#431 ruling 3):
it only ever shrank the side to 6 and the innings to 60 balls, and the real
pairs convention is a different scoring grammar, not an extension of this one
— see "Pairs scoring" below and
`docs/superpowers/specs/2026-08-06-scoringpad-v2-prompts/_INDEX.md`'s
2026-08-11 decision log entry for the full reasoning.

| variant | innings/side | balls/innings | balls/over | players | notes |
|---|---|---|---|---|---|
| `t20` | 1 | 120 | 6 | 11 | 4-over bowler quota, free hit, powerplay, super over available |
| `odi` | 1 | 300 | 6 | 11 | 10-over quota, `minOversForResult` 20, two new balls in practice |
| `hundred` | 1 | 100 | **5** | 11 | balls counted in fives; "overs" in this module means `ballsPerOver` sets, so 100 balls = 20 sets |
| `test` | **2** | **null** (unlimited) | 6 | 11 | declarations, follow-on (lead 200), draw points, no free hit (red ball), no super over |

Two module-wide facts that shape every row:

1. **Dual fidelity is the load-bearing design.** `cricket.ball` (Tier 3) and
   `cricket.innings.summary` (Tier 0) both fold into the same
   `{runs, wickets, legalBalls}` totals, and all result / NRR / DLS math reads
   only those totals. `coarsen()` collapses a fine stream into a coarse one and
   conformance §9.6 asserts the two folds agree on **outcome and summary**.
   That is why fine-only facts (fielding credit, retirements as such,
   powerplays, reviews) must NOT appear in `summary` — a coarse fold cannot
   reproduce them.
2. **The golden corpus compares `JSON.stringify` of the whole state**, per
   event. Every field added by this wave therefore stays `undefined` until the
   fact it records actually occurs; an innings that uses none of them
   serialises exactly as it did before the wave. `cricket.golden.json` is
   byte-unchanged and `module.version` stays `1.0.0`.

---

## Mapping table

`Ev.X` = event payload schema, `Cfg.x` = config, `State.x` = folded state,
`summary.x` = `module.summary()` output. Person fields are always optional —
coarse scoring must stay legal.

### The delivery

| fact | variants | who/what participates | schema path | status | note |
|---|---|---|---|---|---|
| A delivery happened, in a numbered over | all | entrant (batting side, implicit) | `Ev.CricketBall.over` / `.ballInOver` | modelled | fold rejects a cursor that disagrees with the ledger; `hundred` counts in fives via `Cfg.ballsPerOver` |
| Runs off the bat | all | person: `striker` | `Ev.CricketBall.runs.bat` → `State.innings[].fine.batterRuns` | modelled | |
| Ball faced | all | person: `striker` | `Ev.CricketBall.striker` → `.fine.batterBalls` | modelled | not incremented on a wide (Law 22.6) |
| Non-striker at the other end | all | person: `nonStriker` | `Ev.CricketBall.nonStriker` → `.fine.nonStriker` | modelled | fold pins it against the ledger; strike rotation on odd runs is folded |
| Bowler of the delivery | all | person: `bowler` | `Ev.CricketBall.bowler` → `.fine.bowlerBalls` / `.bowlerRuns` | modelled | one bowler per over, no consecutive overs, `Cfg.maxOversPerBowler` all enforced |
| Boundary 4 or 6 (vs runs run) | all | person: `striker` | `Ev.CricketBall.boundary` → `State.innings[].boundaries` | modelled | suppresses the strike crossing; feeds `superOverStillTied: "boundary_count"` |
| Wide | all | — (charged to bowler) | `Ev.CricketBall.runs.extras.kind = "wide"` | modelled | illegal delivery, no ball faced, bat runs rejected |
| No ball | all | — (charged to bowler) | `…extras.kind = "noball"` | modelled | Law 21.13 puts *all* non-bat runs off a no ball in the no-ball column, so the single-kind extras shape is the correct scorebook entry |
| Bye / leg bye | all | — | `…extras.kind = "bye" / "legbye"` | modelled | legal delivery, not charged to the bowler |
| Penalty runs to the **batting** side | all | — | `…extras.kind = "penalty"` | modelled | lands in the batting innings total and in `.fine.extras` |
| Penalty runs to the **fielding** side | all | — | — | deferred | Law 41 adds them to the fielding side's own score, i.e. to a *different* innings that may not exist yet; it would change `aggregate()`, the innings-victory test and the NRR ledger. Needs a product decision on how a penalty bank scores for NRR before it can be modelled. |
| Free hit armed and consumed | white-ball variants (`t20`, `odi`, `hundred`) | — | `Ev.CricketBall.freeHit` → `.fine.freeHitPending` | modelled | armed by a no ball, survives an intervening wide, consumed by the next legal ball; only run-out/obstruction may dismiss on it. Deliberately off for `test` (red-ball) |
| Short run | all | person: `striker` | — | deferred | Law 18.5 deducts the run before it is entered, so the ledger's `runs.bat` is already the post-deduction figure. The umpire's signal is annotation, not a total — `core.note` carries it. |
| Dead ball | all | — | — | deferred | A dead ball that does not count is simply not entered in the ledger; one that does count is entered as the delivery it was. Nothing to hold. |

### Dismissals

| fact | variants | who/what participates | schema path | status | note |
|---|---|---|---|---|---|
| Bowled / LBW / hit wicket | all | persons: `out`, `bowler` | `Ev.CricketBall.wicket.kind` | modelled | `bowlerCredited` must be `true`; fold rejects the wrong value |
| Caught | all | persons: `out`, `fielder`, `bowler` | `…wicket.fielder` → `.fine.fielding[p].catches` | **extended** | `fielder` existed but was parsed and dropped; it is now validated against the fielding lineup and folded into a per-person fielding card |
| Stumped | all | persons: `out`, `fielder` (the keeper), `bowler` | `…wicket.fielder` → `.fine.fielding[p].stumpings` | **extended** | same fold; `bowlerCredited` stays `true` |
| Run out | all | persons: `out`, `fielder`, `fielderAssist` | `…wicket.fielder`, `…wicket.fielderAssist` → `.fine.fielding[p].runOuts` | **extended** | `fielderAssist` is new: the scorebook's "run out (thrower/breaker)". `fielder` = the fielder who completed it (broke the wicket), `fielderAssist` = the supporting fielder; both are credited a run out. Requires `fielder` and must differ from it. |
| Obstructing the field | all | persons: `out`, `fielder` | `…wicket.kind = "obstructed"` | modelled | credits the fielder a run out; "handled the ball" was folded into this by the 2017 Code |
| Timed out | all | person: `out` | `…wicket.kind = "timedout"` | modelled | |
| Retired out (as a delivery-time entry) | all | person: `out` | `…wicket.kind = "retired"` | modelled | legacy path, kept for back-compat; `cricket.retire` below is the richer one |
| **Hit the ball twice** | all | person: `out` | `…wicket.kind = "hitballtwice"` | **extended** | Law 34 — the tenth mode of dismissal, previously absent from the enum. Credited to no bowler, so `bowlerCredited` must be `false`. |
| Wicket-keeper distinguished from a fielder | all | person: `fielder` | `positions.roles[].key = "wicketkeeper"` | deferred | the keeper is a lineup role (required, unique), so "†" on a scorecard is derivable from the lineup rather than repeated on every ball. Recording it per delivery would be denormalised and could contradict the lineup. |
| Who threw vs who broke the wicket | all | persons: `fielder`, `fielderAssist` | `…wicket.fielderAssist` | **extended** | judged scoreable: it is the standard scorebook entry for a run out. The pair is ordered (completer, assister) rather than (thrower, breaker) because the completer is the one the card always names. |
| Bowler wicket credit | all | person: `bowler` | `…wicket.bowlerCredited` → `.fine.bowlerWickets` | modelled | fold pins credit to the mode of dismissal — it is not a free-text flag |
| Fall of wickets / partnership at each wicket | all | persons: both batters | — | deferred | fully derivable by replaying the ledger (the totals at each `wicket`-bearing event *are* the fall of wickets), and folding it would materialise an array on every existing innings, which the frozen golden corpus compares byte-for-byte. Belongs in a read-side projection, not the fold. |

### Batters coming and going

| fact | variants | who/what participates | schema path | status | note |
|---|---|---|---|---|---|
| Openers | all | persons | `State.innings[].fine.striker` / `.nonStriker` from lineup `orderNo` | modelled | |
| Who comes in next | all | person: `incoming` | `Ev.CricketBall.wicket.incoming` | **extended** | Law 25.1 leaves the order after the openers entirely to the captain; lineup `orderNo` is now only the default. Validated against the lineup, refused if the batter is out or already in. |
| Retired **hurt / ill** (not out) | all | persons: `person`, `incoming` | `Ev.CricketRetire` (`cricket.retire`), `reason: "hurt"/"other"` → `.fine.retiredNotOut` | **extended** | costs the side no wicket; the batter stays available. Unrepresentable before: the only retirement path was `wicket.kind = "retired"`, which always takes a wicket. |
| Retired **out** | all | person: `person` | `cricket.retire`, `reason: "out"` | **extended** | Law 25.4.3 — a dismissal credited to no bowler; increments `State.innings[].wickets` and can close the innings. **Deliberately unscored**: `cricket.retire` names a person but feeds no `playerStats` metric — a retirement is a mode of dismissal on the scorecard line, not a counting statistic, and crediting it would put a second wicket-shaped number next to the batter. Pinned by cricket.domain.test.ts. |
| A retired batter **resumes** | all | person: `incoming` | `Ev.CricketBall.wicket.incoming` / `Ev.CricketRetire.incoming` | **extended** | naming a retired-not-out batter as `incoming` takes him off `retiredNotOut`. When no batter who has not yet batted remains, a retired-not-out batter resumes automatically — this keeps the number of available batters equal to the all-out threshold whatever the retirements were, which is what lets a *coarse* fold (which never sees the retirements) close the innings at exactly the same wicket. |
| Substitute fielder | all | person | — | deferred | a substitute may field but not bat, bowl or keep (Law 24), so nothing on a scorecard changes. No fold-visible fact. The channel now exists (`core.lineup.substitution`) but every shipped variant caps it at `Cfg.lineupChanges.maxSubs = 0`, which is this row's reason expressed as config rather than as an absence. |
| Concussion / COVID replacement | `t20`, `odi`, `test` (ICC conditions) | person | `Cfg.lineupChanges.concussionReplacements` → `module.lineupPolicy` → `core.lineup.replacement` (`exemption: "concussion"`) → `State.squads` | **extended** | S3/W4b (#426). A like-for-like replacement *can* bat and bowl and is a person the team sheet never named, which is why this sat deferred: the squad was fixed at `init(cfg, lineups)`. `core/lineup.ts` now owns the squad for all eleven sports, so cricket declares a policy and the kernel folds the event — this module contains no membership, counting or re-entry logic of its own. The replacement is EXEMPT from the substitution cap (owner ruling 1: growth is cfg-gated per variant, default off; the entry carries `provenance: "added"`), and the replaced player may not return (`reentry: "none"`, owner ruling 2). Distinct from `cricket.retire`: retirement is the CREASE and a retired-hurt batter still resumes, a replacement is the FIELD. `State.orders` grows APPEND-ONLY because `fine.nextBatterIndex` is a cursor into it. |
| Runner for an injured batter | none in practice | person | — | deferred | withdrawn from the Laws for adult cricket in 2011; the module's tiers do not target the formats that still allow it. |

### The innings

| fact | variants | who/what participates | schema path | status | note |
|---|---|---|---|---|---|
| Innings totals (runs / wickets / legal balls) | all | entrant | `State.innings[].{runs,wickets,legalBalls}`, `Ev.CricketInningsSummary` | modelled | the one shape every downstream computation reads |
| Extras total | all | entrant | `State.innings[].fine.extras` | modelled | per-kind breakdown lives on each ball, not aggregated on the innings |
| Innings closed, and **why** | all | entrant | `Ev.CricketClose.reason` → `State.innings[].closeReason`, `summary.detail.innings[].closeReason` | **extended** | new optional enum (`all_out`, `overs_complete`, `target_reached`, `time`, `weather`, `forfeited`, `other`) on the explicit close event. The three auto-closes are deliberately left unstamped: they are exactly the `autoClose` predicates, so they are derivable from the totals, and stamping them would change every previously folded state. |
| Declaration | `test` (`inningsPerSide === 2`) | entrant | `cricket.innings.declare` → `State.innings[].declared` | modelled | fold refuses it for one-innings variants; shown as `d` in the summary line |
| Innings forfeited | `test` | entrant | `Ev.CricketClose.reason = "forfeited"` | **extended** | Law 15 — recorded as a close reason rather than a distinct event, because the totals a forfeited innings contributes are just zeros |
| Follow-on | `test` | entrant | `cricket.followon` + `Cfg.followOn.{enabled,lead}` → `State.followOnEnforced` | modelled | fold checks the actual lead against the configured one and reorders the innings sequence F,S,S,F |
| All-out threshold | all | entrant | derived: `min(Cfg.playersPerSide, lineup) − 1` | modelled | scales with `Cfg.playersPerSide`; the dropped `pairs-6-a-side` variant (#431 ruling 3) demonstrated this at `playersPerSide: 6` ⇒ 5 |
| **New ball taken** | all (in practice `test`, `odi`) | — | `cricket.newball` → `State.innings[].newBallAt[]` | **extended** | records the legal-ball count at which each new ball was taken; refuses two at the same point. Empty innings keep the field unset. |
| **Powerplay block** | white-ball variants | — | `cricket.powerplay` (`kind`: mandatory/batting/bowling, `phase`: start/end) → `State.innings[].powerplays[]` | **extended** | blocks are `{kind, fromBalls, toBalls}` in legal balls from the innings start; one open block at a time, an end must match the open block's kind |
| Over-rate / time penalty | white-ball variants | entrant | — | deferred | in the current conditions this is either an in-over fielding restriction (a competition rule about the *next* delivery, not a scorable fact) or a points/penalty-run sanction. The penalty-run half needs the fielding-side penalty bank above; the fielding-restriction half needs a product decision on whether a scorer records it at all. |
| Innings-by-innings scoreline | all | entrant | `summary.perSide[].line` (`"250 & 201/5"`), `summary.detail.innings[]` | modelled | reads only totals, so coarse and fine folds render identically (§9.6) |

### Reviews and officiating

| fact | variants | who/what participates | schema path | status | note |
|---|---|---|---|---|---|
| **A review was taken, by whom** | all (where the competition uses DRS) | entrant `by`, persons `person` (who called it), `against` (the batter concerned) | `cricket.review` | **extended** | **Deliberately unscored**: the persons are recorded but feed no `playerStats` metric — a review is a TEAM resource, already tallied per side in `State.innings[].reviews`, and no scorecard carries a per-player review column. Pinned by cricket.domain.test.ts. |
| **Review outcome** | as above | — | `Ev.CricketReview.outcome` = `upheld` / `struck_down` / `umpires_call` | **extended** | |
| **Reviews remaining** | as above | entrant | `Cfg.reviews.perInnings` + `State.innings[].reviews[side].{taken,lost}` | **extended** | only an unsuccessful *player* review is spent — umpire's call retains it (current ICC conditions) and an umpire review never counts against a side. With `Cfg.reviews` absent the allowance is unlimited, so the config stays byte-identical for every existing division. |
| Umpire identity per decision | all | person | — | deferred | umpires are fixture officials (`officialLabel.scorer = "Umpire"`, officials module), not per-event participants. Naming them on a review would duplicate the officials assignment. |

### Result, points and revision

| fact | variants | who/what participates | schema path | status | note |
|---|---|---|---|---|---|
| Toss and election | all | entrant | `cricket.toss` → `State.battingFirst` | modelled | must precede `core.start` |
| Target for the chase | one-innings variants | entrant | derived `chaseTarget()`, `State.revisedTarget` | modelled | |
| Win by wickets / by runs / by an innings | all | entrant | `State.outcome` + `State.margin` | modelled | innings victory only for `inningsPerSide === 2` |
| Tie / draw / no result / abandoned | all | entrant | `State.outcome.kind`, `Cfg.points.*` | modelled | draw exists only in two-innings cricket and only in league/group/swiss stages |
| Match closed on time (draw) | `test` | — | `cricket.match.close` | modelled | |
| Interruption (rain / light / other) | all | — | `cricket.interruption` → `State.interruptions` | modelled | metadata only; the numbers arrive on `cricket.revise` |
| DLS revision inputs (overs, wickets, resources) | one-innings variants with `Cfg.dls.enabled` | entrant | `cricket.revise.oversPerSide`, `State.r1`/`r2`, `dls.ts` `resourcesFromBalls()` | modelled | Standard Edition table; resources lost are computed at the current wickets. The table is a fixed six-ball / ten-wicket grid, so `resourcesFromBalls` converts balls and wickets onto ITS scales — never `cfg.ballsPerOver` or a raw wicket count (#451) |
| DLS / manual revised target | as above | entrant | `cricket.revise.target`, `State.revisedTarget`, `State.targetSource` | modelled | a manual umpire target always wins over the computed one |
| DLS par decision on abandonment | as above | entrant | `core.abandon` → `dlsPar()`, method `"dls"` | modelled | below `Cfg.minOversForResult` it is a no result |
| Super over | one-innings variants with `Cfg.superOver` | persons: all ball fields | `cricket.superover.ball`, `State.superOver` | modelled | 2-wicket all out, batting order flips each pair, `Cfg.superOverStillTied` = repeat / boundary_count / shared |
| Net run rate ledger | all | entrant | `standingsDelta().metrics` (`runs_for`, `balls_faced_eff`, …) | modelled | integer ledger only; a bowled-out side is charged its full quota; forfeits contribute nothing |
| Per-result points | all | entrant | `Cfg.points.{win,tie,noResult,loss,draw}` | modelled | `draw` is two-innings only |
| Post-match scorecard lines | all | person | `cricket.player.line` (Tier 2) | modelled | sum-checked against the innings totals; exact against a fine innings, bounded against a coarse one |
| Pairs scoring (6-a-side: fixed pairs, −5 per dismissal) | none (`pairs-6-a-side` dropped, #431) | persons: the pair | — | deferred | **dropped, not just unbuilt** (#431 ruling 3, 2026-08-11): the `pairs-6-a-side` preset only ever shrank the side to 6 and the innings to 60 balls; the real pairs convention (each pair bats a fixed number of overs, a dismissal costs 5 runs instead of ending the partnership) is a different scoring grammar, not an extension of this one, so the preset was removed rather than left half-built. See `docs/superpowers/specs/2026-08-06-scoringpad-v2-prompts/_INDEX.md`'s 2026-08-11 decision log entry. |
| Player leaderboards from the ledger | all | persons: all | `module.playerStats` | **extended** | `PlayerStatMetric.field`/`sumField` resolve dotted payload paths (`src/stats/stats.ts`), so the model is declared straight off `cricket.ball`: runs (`runs.bat`), balls faced, fours and sixes (`boundary`) by `striker`; balls bowled, runs conceded and wickets (`wicket.bowlerCredited`) by `bowler`; catches, stumpings and run outs by `wicket.fielder` plus `wicket.fielderAssist`; a `dismissals` total plus a ten-way mode split (`wicket.kind`'s full enum) by `wicket.out`, the dismissed batter. S8/#417 adds a `folded` fallback that reads `cricket.player.line` (Tier 2) for `runs`/`balls_faced`/`balls_bowled`/`runs_conceded`/`wickets`/`dismissals` — gated per person, per batting/bowling aspect, so a fine `cricket.ball` figure always wins and the coarse line fills in only a gap fine data never covered. That is what lets a v1-era coarse-only stream, or a stream mixing both tiers, produce a leaderboard without double-counting; `cricket.retire`/`cricket.review` still feed neither path (see "Deliberately unscored" above). The fold declares `folded.keys`/`sharesMetricKeys` honestly for those six names (S8/#417 W6 fix 1), so `playerStatsKeyCollisions` still catches a genuinely accidental future clash even though this one is intentional. **KNOWN LIMITATION** (W6 fix 3, pinned by cricket.playerstats.test.ts): the fine/coarse gate above is scoped to the WHOLE STREAM per person and aspect, not per innings, because an innings boundary is not derivable from what these two event types actually carry — `CricketBall` has no innings field at all (only `over`/`ballInOver`, which restart every innings), and an innings can close with no explicit `cricket.innings.close` event in the stream (the three auto-closes below are deliberately unstamped) — so a player with fine ball-by-ball data in one innings and only a coarse line for a LATER innings loses that later innings entirely; the gate already sees him as covered for that aspect from the earlier innings. Segmenting a flat ball list into innings would need `coarsen()`'s own multi-signal heuristic (an over/ball restart, or both crease batters going unseen) or a full replay of cricket's apply() state machine, both judged out of proportion for this fold to attempt. |

---

| Where in the match an event happened (the position axis) | all | — | `SportModule.position(state)` -> `innings` + `over` segments, e.g. `Innings 2 . Over 12.3` | extended | W4a T6b. A **read-side projection**, never a payload: a `MatchPosition` on every stamped event was considered this wave and rejected, because position is derivable from state the fold already computes and recording it would create a recorded value and a derived value of the same type that can silently disagree — the `DisciplineCard.entrantSide` shape. A wrong recorded value is in the hash-chained ledger forever; a wrong projection is one deploy away from fixed. Ordered segments rather than a display string, so W8 can drop a segment for a 375px scorebug, localise each `key` and order two positions in one match; `formatPosition` is the plain-text path. Nothing is materialised into state, so every frozen golden is byte-identical. The over comes from `legalBalls` and ONLY from `legalBalls`. An innings also carries `extras`, an integer on the same object that also counts deliveries, and only one of the two is the over reading — three wides into an over and the scoreboard still says 0.3. The super over CONTINUES the innings count rather than restarting at 1, because its innings are the third and fourth of the match and restarting would send position backwards mid-fixture. `oversText` is the module's own notation, shared with `summary`, so an over is spelled one way everywhere. |

**Row counts:** 36 modelled, 19 extended, 10 deferred (65 rows).
Asserted against the table itself by `src/testkit/dossiers.test.ts`.

## Downstream owed

- **Position labels owed in all four locale dictionaries** (W4a T6b): `scoring.position.innings`, `scoring.position.over`.
  `SportModule.position` returns a stable segment `key` plus an ENGLISH `label`
  fallback — the engine writes no locale copy, by the same rule `MetricSpec.label`
  follows. W8 renders `scoring.position.<key>` and falls back to `label`. Both values stay locale-neutral numerals; only the noun is looked up.
  Deliberately NOT written by this task, which touches no dictionary.

Recorded, not acted on.

1. ~~**`src/stats/stats.ts` needs dotted-path support**~~ — **DONE**, in W4's
   shared stats pass. `PlayerStatMetric.field`/`sumField` now resolve dotted
   payload paths, and cricket declares its leaderboards straight off
   `cricket.ball` (see the `Player leaderboards from the ledger` row above):
   runs, balls faced, balls bowled, runs conceded, wickets, catches, stumpings,
   run outs. Arrays remain a leaf — no traversal, no query syntax.
2. ~~**`apps/web/src/lib/scoring-vocab.ts` does not know `hitballtwice`.**~~ —
   **DONE**, S7/#427 (`366ef5a7`). `WicketKind` widened to ten values,
   `WICKET_KEY["hitballtwice"]` reuses the existing `kind.hitballtwice` key
   (already correct in all four dictionaries) rather than minting a duplicate.
   A first pass (`e55e10b7`) made the option *selectable* without fixing
   `wicketLabel()` itself, which checks only `WICKET_KEY` and never falls
   through to `KIND_KEY` the way `enumLabel("kind", …)` does — caught in
   review before merge.
3. ~~**New event types a pad must be able to prompt for**: `cricket.retire`
   … `cricket.newball` … `cricket.powerplay` … `cricket.review`~~ — **DONE**,
   S3-S5 shipped the vocabulary and i18n for all four opportunistically while
   wiring their own apps/web work; S7 confirmed presence rather than
   re-adding it.
4. ~~**New fields on an existing branch**: `wicket.fielderAssist` and
   `wicket.incoming`.~~ — **DONE**, S7/#427 (`af581d0e`). `PadAttributionItem`
   gained an optional `labelKey`, wired at cricket's wicket action for both
   fields; the fielder slots and "who's in?" pad affordance are S10's
   (renderer) to build once `PadSpec` is consumed.
5. **New close reasons.** `summary.detail.innings[].closeReason` is now
   sometimes present. Any renderer that enumerates that object must tolerate
   it (it is additive, so a spread-based renderer is already fine).
6. **`Cfg.reviews.perInnings`** is a new optional config key. The rules editor
   and the sports catalog seed (`sync:sports`) do not offer it; the variants
   deliberately do not set it, so nothing changes until a product decision is
   made about which competitions run DRS.
7. **Stat models that become possible**: a fielding leaderboard (catches /
   run outs / stumpings) — new for the product; retirement-aware batting
   averages (a retired-not-out innings is not an out); and per-innings review
   efficiency.
8. **Deferred rows that still need a product decision, not engineering**:
   penalty runs to the fielding side (and with it over-rate penalty runs).
   The pairs convention no longer belongs on this list — #431 ruling 3
   (2026-08-11) decided it rather than leaving it open: the `pairs-6-a-side`
   preset was dropped, and a real pairs scoring grammar is a different
   module concern, not a config knob here. (Concussion replacements also came
   off this list earlier: S3/W4b #426 shipped it — see "Concussion / COVID
   replacement" above.)

## What was NOT changed, on purpose

- `module.version` stays `1.0.0`; `cricket.golden.json` is byte-unchanged.
- No existing branch, enum member or field was removed, renamed or made
  required; every new field is `.optional()` and every new config key is
  `.optional()` with **no default**, so previously parsed configs are
  byte-identical.
- `summary()` gained exactly one conditional key (`closeReason`), which
  survives coarsening; no fine-only fact entered the summary, because §9.6
  requires a coarse fold to reproduce it.
- New event branches are **appended** to the `z.union`, never interleaved, so
  every pre-wave payload still resolves to the branch it always resolved to.
