# Match stats for every sport — design

**Status:** DRAFT, awaiting owner ruling on the four open questions in §7.
**Requested:** 2026-09-07, owner — "we want to do the scoreboard for all sports, is it
possible" — during the spectator W1 gate.
**Scope:** the public match centre (`/shared/.../fixtures/[fixtureId]`) only. No organiser
surface, no scoring-pad change, no engine change.
**Sequencing:** lands AFTER spectator W1 merges. W1 is in its gate; this is a new tab with a
new schema, four locale dictionaries and e2e across eleven sports, which is a wave, not a
patch.

---

## 1. The problem, in one paragraph

Cricket's match centre has a real scorecard — batting and bowling tables, per player, derived
from the ledger. Every other sport gets a Sets/Periods grid and a prose timeline. A spectator
on a football fixture can see that it finished 3–1 and read "Goal — J. Fernandes (62')" in
the timeline, but cannot see that Fernandes scored twice and assisted once, because nothing
on the page aggregates by player. Against the benchmark this programme was set (cricheroes),
that is where we read thin for ten of our eleven sports.

## 2. What already exists — verified, with pointers

This is the part that changes the size of the job, and every line here was checked against the
tree rather than inferred.

- **Every sport declares a per-player stats model.** `SportModule.playerStats?:
  PlayerStatsModel` (`packages/engine/src/sport/module.ts:678`). All eleven shipped sports
  populate it; the `setbased`/`nested` kernels merge a default (`points_won`, `sets_won`,
  `sets_lost`) into whatever each preset declares, so no sport is empty.
- **The fold already exists and is sport-agnostic.** `aggregatePlayerStats(events, model,
  lineups, ctx)` → `PlayerStatRow[]` (`packages/engine/src/stats/stats.ts:654`). Its inputs
  are exactly what `loadMatchCentre` already has in hand.
- **Production already folds PER FIXTURE and then throws the result away.**
  `apps/web/src/server/usecases/player-stats.ts:127` maps each fixture's ledger through
  `aggregatePlayerStatsWithDiagnostics`, and `sumPlayerStats` immediately collapses the rows
  to division level because `player_stat_snapshots` is keyed `(division_id, person_id)`
  (`db/migration/jul3/V248__player_stats.sql:14`). The number a match centre wants is computed
  on every recompute and discarded.

**So this needs no new engine work.** What is missing is three pieces of wiring:

1. `match-centre.ts:819` is `if (sportKey === "cricket")`.
2. `MatchCentreTabId` (`match-centre-schema.ts:8`) has only a cricket-shaped `scorecard`.
3. No view schema for a flat per-player table.

**And the renderer already exists.** `stat-table.tsx` — extended in W1 with `foldAtPhone` /
`phoneSubLine` — is exactly this shape: a name column plus n right-aligned numeric columns
that fold on a phone.

### 2.1 What each sport actually declares

Real keys, read from the modules. This matters: a spec that invents stat names produces a
builder that cannot find them.

| Sport | Metrics (count) | Examples of real keys |
|---|---|---|
| ice hockey | 19 + 2 derived | `goals`, `assists`, `pen_minor`, `pen_major`, `goals_pp`, `goals_sh`, `so_goals` |
| hockey | 15 + folded | (see `sports/hockey/hockey.ts:42`) |
| football | 10 + 1 derived + folded GK | `goals`, `assists`, `yellow_cards`, `red_cards`, `penalty_goals`, `own_goals`, `shots`, `shots_on_target`; derived `points = goals + assists`; award `motm` |
| cricket | 14 + 17 folded | bespoke card, see §6 |
| tennis | 6 + kernel merge | + `points_won`, `sets_won`, `sets_lost` |
| carrom | 4 + folded | |
| badminton | 3 + kernel merge | `points` (scorer), `serves` (server), `sanctions` |
| table tennis | 3 + kernel merge | |
| volleyball | 3 + kernel merge | |
| boardgame | 3 + folded | |
| generic | 2 + folded | |

Two things fall out of that table and drive the whole design:

- **The spread is 19 to 2.** One layout cannot serve both. Ice hockey wants a box score;
  generic wants two columns and probably no tab at all.
- **`points_won` carries `display: false`** in the leaderboard context
  (`setbased/kernel.ts:1563`) — the engine already has an opinion that it is a fallback
  number, not something to show. Honour it.

## 3. What good products show — external benchmark

Researched 2026-09-07. The finding that matters: **the pro-grade metrics are not available to
us and are not what our users want anyway.**

- **Sofascore** builds its player rating from 200+ indicators — passes, duels, tackles,
  possession lost — starting every player at 6.5 and moving in real time. That depends on a
  professional data-collection operation per match. We collect what one volunteer taps into a
  phone on the touchline. **Do not attempt a rating.** A rating computed from ten events would
  be confidently wrong, and wrong about a named person.
- **Grassroots apps** (Statzo, Grassroots Stats, TeamStats, Mingle) converge on a much shorter
  list: **goals, assists, clean sheets, cards, minutes, match ratings, Player of the Match**,
  plus season-by-season aggregates. That list is almost exactly what our football module
  already declares — including `motm` as a declared award.
- **Ice hockey's box score is a settled convention**: `G, A, P, +/- , PIM, SOG, TOI` for
  skaters. We have G, A, and P (derivable), and penalties by class. We do **not** have `+/-`,
  `SOG` or `TOI`, and should not invent them.
- **Tennis and badminton** analysis centres on **winners vs unforced errors** and points won.
  We have `points` by scorer and `serves` by server for badminton — enough for points won and
  serve count, not for winners/errors, which nobody taps at grassroots.

**Conclusion for our product: show the short grassroots list, per sport, and stop.** Our
advantage over Sofascore is not depth — it is that the numbers are about *your* Saturday
league and are correct.

## 4. The design

### 4.1 One new tab, `stats`

A new `MatchCentreTabId` member. Appears **after** the sport's existing tabs and before
`info`. Labelled from the same "notation, not copy" convention the other tabs use — the label
is a translated word ("Stats"), the column headers are notation and are not translated.

### 4.2 Gate the tab on the FOLD'S OUTPUT, never on the sport

This is the single most important rule in this document, and it is the one a fresh
implementer will get wrong.

```
if (rows.length > 0 && rows.some(r => hasAnyNonZeroDisplayedMetric(r))) extraTabs.push("stats");
```

Cricket already does exactly this for its own tabs (`if (card.innings.some(i =>
i.batting.length > 0))`). The reason is the fidelity band: at a low band the ledger carries no
person-attributed events at all, so the fold returns nothing. `module.ts:676` states it
outright — "Sports without person-attributed events simply omit it (leaderboards then say
'requires detailed scoring')."

A tab that opens onto a table of zeros is worse than no tab. **A test must drive a
band-1 fixture and assert the tab is absent.**

### 4.3 Per-sport column sets, declared in ONE place

The engine's `PlayerStatsModel` says what a sport *can* measure. It does not say what a
spectator should *see* — 19 columns is a spreadsheet, not a match centre. So the view needs a
per-sport **display list**: an ordered subset of metric keys, plus which fold onto the phone
sub-line.

Proposed starting sets (owner to rule — §7):

| Sport | Columns (desktop) | Folded to sub-line on phone |
|---|---|---|
| football | G, A, P, YC, RC | shots, shots on target |
| ice hockey | G, A, P, PIM | PP/SH/EN goals, shootout |
| hockey | G, A, P, cards | (per module) |
| tennis / badminton / TT / volleyball | points won, serves | — |
| carrom, boardgame, generic | **no tab** (see §7 Q2) | — |

The list lives beside `sets-vocabulary.ts` as one map, for the reason that file already
records: two independent derivations of the same fact are two chances to disagree.

### 4.4 Rendering

`StatTable`, unchanged. It already does: `table-fixed` with explicit numeric widths and the
name column taking the remainder; `md:max-w-[28rem]` capped measure; `foldAtPhone` +
`phoneSubLine`; mono figures; a visible name-column header.

Rows group by side, in the fixture's own home/away order — never alphabetically, and never by
metric value, because a spectator scans for their own team first.

### 4.5 Names, consent and masking

Non-negotiable and easy to get wrong: person names on the public surface go through the ONE
shared `resolvePersonDisplayName`, with youth and `player_name_display` applied, exactly as
`loadMatchCentre`'s `maskSideNames` and `readPublicLineups` already do. **A new table that
reads person names straight off the fold would bypass consent masking.** The fold returns
person ids; resolve them through the existing path, never a second one.

## 5. What this is NOT

- **Not a rating.** See §3.
- **Not a replacement for cricket's scorecard.** Cricket keeps its bespoke card; if cricket
  gains this tab too it is a second, flat view.
- **Not a season/leaderboard view.** That exists (`divisionPlayerStats`, the public player
  page). This is one fixture.
- **Not a schema change to `player_stat_snapshots`.** The fold runs at read time from the
  ledger, like every other match-centre derivation. Persisting per-fixture rows is a much
  larger change and is not needed for this.

## 6. Why cricket stays bespoke

A flat metric fold produces `{person, key → number}`. Cricket's card is *ordered and
phase-structured*: batting order, dismissal text per batter, extras, fall of wickets, an over
log. None of that is expressible as a metric table, which is why
`deriveCricketScorecard` exists as ~1,000 lines of its own.

## 7. Rulings

Owner, 2026-09-07: "apply your rec". All four recommendations below are RULED as stated.

**Q1. Which columns per sport? — RULED: the short list of §4.3.** The alternative was "show
every declared metric", which gives ice hockey 19 columns and is a spreadsheet. Depth is
Sofascore's game and depends on a data operation we do not have; our advantage is that a small
number of numbers about a real Saturday league are correct.

**Q2. The thin sports — RULED: no tab for carrom, boardgame or generic.** They declare 2–4
metrics and the engine itself flags `points_won` `display: false`
(`setbased/kernel.ts:1563`). A two-column table of points won says less than the Sets grid
directly above it, and an almost-empty tab reads as a broken feature. Note this follows from
§4.2 automatically when the gate tests for a non-zero DISPLAYED metric — it is not a second
mechanism.

**Q3. Man of the Match — RULED: show it, as a chip on the player's row.** Football already
declares the `motm` award, and it is the single most-wanted grassroots stat in the research
(§3). Chip, not a column: it is a boolean about one player, and a column of blanks with one
tick in it wastes the width the numbers need.

**Q4. Cricket — RULED: no stats tab.** It keeps its bespoke Scorecard. Two tables of the same
match in one match centre invites the question of which one is right, and the flat fold cannot
express the ordered, phase-structured card anyway (§6).

## 7.1 The fidelity bands — RULED: all four bands stay

Raised by the owner 2026-09-07 ("we may disable the Band 1 and Band 2"), in the context of
guaranteeing this tab always has data. Recommendation against was put; **owner ruled the same
day: "we can keep band 1 and band 2"**. The 0–3 ladder is unchanged and §4.2's gate is
therefore load-bearing, not a temporary measure.

The reasoning is kept below because the facts are not derivable from the read side, and a
later session asked to "just always show the stats tab" will otherwise re-derive them wrongly.

**The band is an OUTPUT, not a setting.** `effectiveBand`
(`apps/web/src/server/public-site/match-centre.ts:691`) computes the maximum band across the
event types a fixture actually recorded. Nothing persists a band. "Disabling bands 1 and 2"
therefore is not a switch on this surface at all — it is a change to the SCORING PAD, hiding
those tile sets so a scorer may only record `result` (0) or `detail` (3). That is a
ScoringPad v3 decision touching every pad in the product, not a spectator-surface one.

**It would not remove the gate.** Every fixture already scored at band 1 or 2 keeps its
history. Dropping §4.2's gate would show a table of zeros for matches recorded entirely
correctly under today's rules. The gate is needed either way, and it costs one predicate — so
disabling the bands buys nothing that it saves.

**And it may reduce the data rather than increase it.** The middle rungs are how a volunteer
gives us a timeline without committing to ball-by-ball. Removing them does not push a
reluctant scorer up to `detail`; the cheaper response is dropping to `result`, which yields
LESS than today — a bare scoreline in place of a populated timeline. The band comment in
`module.ts:90-95` is explicit that this is a UX affordance and that no band is paywalled;
narrowing it is a burden increase on unpaid people.

*Ruled as recommended: all four bands stay, and the gate stays with them.* If the question is
reopened it needs evidence about what scorers actually pick — the distribution of
`effectiveBand` across recorded fixtures. That evidence must come from the PRODUCTION ledger:
the query was run against a local test database while writing this spec and the result
discarded, because every row there was seeded by a test suite and the distribution reflects
our own fixtures rather than anyone's Saturday. Resolving event type → band also needs each
module's `padSpec().fidelity` map, so it is a script, not plain SQL.

## 8. Verification (all four types, per RULES.md)

- **Unit** — the builder: a fixture whose fold yields rows produces a `stats` view with the
  declared columns in declared order; a band-1 fixture (no person attribution) produces
  `null` and NO tab; a person who opted out of `public_name` is masked. Mutation: delete the
  gate → the empty-table case must red.
- **E2E** — the tab renders for football, ice hockey, tennis and badminton, and is ABSENT for
  generic. Driven per sport, at 320/390/768/1280. Grep the testid, never the filename
  (`mobile.spec.ts` sweeps by behaviour).
- **Smoke** — the public fixture endpoint still serves for a division whose fold is empty.
  This surface has already 500'd once this month from a stricter-than-production parse
  (`match-centre-load.ts`, task-16 gate); a new derivation on the same path gets the same
  scrutiny.
- **Regression** — the four non-cricket sports keep their Sets/Periods and Timeline tabs, with
  the tab ORDER unchanged apart from the insertion.

Plus: all four locale dictionaries for the tab label and any word that is not notation;
screenshots at 320/768/1280 with no horizontal page scroll; a per-screen R11 verdict table.

## 9. Sources

- [Sofascore — decoding key football statistics](https://www.sofascore.com/news/from-expected-goals-to-player-of-the-match-decoding-key-football-statistics-for-better-insights)
- [Sofascore rating explained](https://corporate.sofascore.com/about/rating)
- [Statzo — tracking football stats for grassroots players](https://statzoapp.com/how-to-track-your-football-stats-the-complete-guide-for-grassroots-players/)
- [Mingle Sport — features for amateur teams](https://mingle.sport/features/)
- [Grassroots Stats (App Store)](https://apps.apple.com/us/app/grassroots-stats/id1490688072)
- [Hockey stats abbreviations — XbotGo](https://xbotgo.com/blogs/knowledge/hockey-stats-abbreviations)
- [Hockey stats explained — JudgeMate](https://www.judgemate.com/en/guides/ice-hockey-stats-explained)
- [Tennis stats explained — Tennisnerd](https://www.tennisnerd.net/tennis-stats-explained)
- [Winner points and unforced errors in badminton (2016 Olympics analysis)](https://www.researchgate.net/publication/341457562_Who_how_and_when_to_perform_winner_points_and_unforced_errors_in_badminton_matches_An_analysis_of_men's_single_matches_in_the_2016_Olympic_Games)
