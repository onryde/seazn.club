# Rulebook W2 — goal sports, board games, carrom, generic

> **DRAFT — recommendations only; nothing here is an owner ruling until signed (_INDEX.md)**

- **Date:** 2026-09-27 · **Wave:** W2 sport scoring fidelity (design §8) · **Sibling:**
  `rulebook-W2-sets-cricket.md` (badminton, table tennis, volleyball, tennis, cricket).
- **Sports:** football, hockey (FIH), icehockey (IIHF), boardgame (chess / draughts / go —
  the module's variants are **time controls**, `classical | rapid | blitz`, not games,
  `boardgame.ts:51`), carrom (ICF), generic (product-defined).
- **Inputs read:** design §4, §5, §7.1–7.4, §8; `_INDEX.md` rulings 1–21; `_RULES.md`;
  `W2-scoring-fidelity.md`; audits `SC-scoring.md` (SC-X*, SC-P*, SC-O*), `ST-standings.md`
  (G1, G2, G10, G12, G16), `plan-facts-sports.md`, `offered-matrix.md`.
- **How code facts were established:** by opening the file at tree `8a74c538e` (= `main`
  `782628af5` + docs). **Nothing was driven** (`AGENTS.md` class 5, `_RULES.md` R20). Every
  behavioural row in §7/§8 is a hypothesis for W2's truth run (R5). Line numbers are
  re-pinned in this session; the audits' numbers were not trusted.
- **How federation facts were established:** the regulation text was downloaded and read
  where it is marked **(read)**. Where only a secondary summary could be reached it is marked
  **(secondary — re-read before signing)**. The owner should not sign a row that rests on a
  secondary citation without that re-read.

## 0. Conventions used below

- **Status of a product row (§7):** **MATCH** = the engine/web code does what the rule says;
  **DIFFERS** = it does something else; **MISSING** = no code path exists. A MATCH is a read,
  not a run.
- **Match result vs decider result.** For every goal sport the **match result is the score at
  the end of regulation (+ extra time where played)**; a shoot-out / GWS / tie-break decides who
  advances or who gets the bonus point, and is **never** added to goals — **except ice hockey**,
  where IIHF credits exactly one goal to the shoot-out winner (Rule 84.4 (XI)).
- **Empty case first (R13).** Every table rule set below states its empty case: *a table with
  zero counted fixtures ranks every entrant level on 0 points, and the cascade must fall to
  its last key (lots / seed) — never report a "leader".* Every decider rule states its
  empty case: *a knockout fixture with no decider configured is not "finished" when level;
  it is refused, with a named reason and a way forward.*
- **Customisation levels (ruling 12, design §5):** *Division* = defaults; *Stage* = every
  setting, before the stage's first fixture starts; *Fixture* = match format only, before
  that fixture starts; **never** table points or tiebreakers per fixture; **nothing mid-match**.
- **Scenario IDs** are design §4's. Outcomes in §8 are **expected values under this
  rulebook**, not what the product does.

## 0.1 Shared seam facts (read, all six sports)

| Fact | Evidence |
|---|---|
| One write path; standings read the stored outcome through the same resolved cfg. | `apps/web/src/server/engine-db/append-event.ts:252-420`; `competition.ts:305-352`; `fixture-cfg.ts:39-46` |
| Cfg frozen at the first event (V347). A later division edit never reaches a started fixture. | `fixture-cfg.ts:39-46`, `append-event.ts:280,365` |
| Stage overlay carries only `shootout` and `extraTime` (plus `rules`, which only the four set sports may write). No organiser screen writes the deciders. | `stage-cfg.ts:18` (`STAGE_DECIDER_KEYS`); `STAGE_RULES_SPORTS` read at `app/o/.../d/[divSlug]/page.tsx:399` |
| The knockout guard refuses **only** `outcome.kind === "draw"`. `tie` and `no_result` commit on a bracket fixture. | `append-event.ts:334-346` |
| `bracketWinnerLoser` seats nobody for `draw`/`tie`/`no_result`; its comment says those "never reach a bracket fixture" — false (R28). | `competition.ts:144-165` |
| Any stream containing `core.abandon` gets status `abandoned`, **even when the fold produced an outcome**. `abandoned` maps to engine `void`, which is excluded from the table. | `append-event.ts:141-148`; `apps/web/src/lib/fixture-engine-status.ts:17-19`; `packages/engine/src/competition/stage.ts:24` |
| An abandoned bracket fixture **with** an outcome is not a dead feeder; it stays stuck and visible (owner ruling 2026-09-21). | `apps/web/src/server/usecases/stages.ts:3627-3657` |
| `core.forfeit` carries one `by`; there is no two-sided forfeit event. | `packages/engine/src/core/events.ts:52` (per SC-S6; not re-opened) |
| H2H re-application (`h2hRecursive`) exists in the engine but **no production caller sets it**; only `h2h_scope: "overall"` is wired. | `packages/engine/src/competition/tiebreakers.ts:207-209, 456`; `apps/web/src/server/engine-db/competition.ts:395-419` (grep `-a` for `h2hRecursive` in `apps/web/src`: 0 hits) |
| Buchholz / Sonneborn-Berger compare **0 = level** unless the stage kind is `swiss` (the Swiss ledger is built only for `swiss`). | `tiebreakers.ts:351-358`; `competition.ts:404`; `competition/stage.ts:242` |
| Division table-points editor only recognises `win/draw/loss` (`w/d/l`) keys; `otWin/otLoss`, hockey `shootoutWin/Loss` and boardgame `scoring.*` are not editable. The tiebreak cascade has no editor (G10). | `apps/web/src/components/v2/division-settings.tsx:262-278`; ST-G10 |

---

## 1. Football

### 1.1 Authority

| Topic | Authority | Citation |
|---|---|---|
| Winning team, deciders | IFAB Laws of the Game, **Law 10.2** ("when competition rules require a winning team after a drawn match … the only permitted procedures are: away goals, two equal periods of extra time not exceeding 15 minutes each, kicks from the penalty mark") **(read)** | https://www.theifab.com/laws/latest/determining-the-outcome-of-a-match/ |
| Kicks from the penalty mark | IFAB **Law 10.3**: taken after the match has ended and not part of it; 5 kicks each alternately, then sudden death with equal numbers of kicks; teams reduced to equal numbers **(read)** | same URL |
| Group tiebreaks, FIFA convention (H2H first, applied once) | FIFA World Cup 2026 Regulations: H2H points → H2H GD → H2H goals → overall GD → overall goals → team conduct score → FIFA/Coca-Cola world ranking **(secondary — re-read; fifa.com page did not render)** | https://www.fifa.com/en/tournaments/mens/worldcup/canadamexicousa2026/articles/groups-how-teams-qualify-tie-breakers ; quoted at https://www.foxsports.com/stories/soccer/fifa-world-cup-group-stage-third-place-tiebreakers |
| Group tiebreaks, UEFA convention (H2H first, **re-applied** to a still-tied subset) | UEFA EURO Regulations **Art. 20.01** (a–c H2H, d re-application, e–f overall, g disciplinary, h ranking) and **Art. 20.02** (two level teams meeting in the last match → penalties) **(secondary — fetch returned 404; re-read)** | https://documents.uefa.com/r/Regulations-of-the-UEFA-European-Football-Championship-2022-24/Article-20-Equality-of-points-final-tournament-group-stage-Online |
| Group tiebreaks, classic (GD first) | FIFA World Cup ≤2022 convention: points → GD → goals → H2H → fair play → lots (the engine's `classic` preset states it) | `football.ts:1704-1710` (the product's own source note, `engine/11-sources.md`) |
| Forfeit score | FIFA Disciplinary Code 2025 **Art. 28.1**: forfeit = 3-0 (11-a-side), 5-0 futsal, 10-0 beach; **"if the goal difference at the end of the match is less favourable to the team at fault, the result on the pitch is upheld"** **(read)** | https://digitalhub.fifa.com/m/6094262690de769/original/FIFA-Disciplinary-Code-2025.pdf |
| Abandonment | IFAB is silent on the result; competition rules decide (replay or result stands). The product default `replay` is a competition-rules choice. | Law 5 / competition rules |

### 1.2 Match rules

- **Scoring model:** goals per period; two halves (or four quarters for mini-soccer).
- **Regulation result:** the score at full time. A draw is a valid result **only** in a table
  stage (league / group / swiss).
- **Deciders (knockout and any stage the competition says must produce a winner):**
  optional extra time (2 × ≤15 min, Law 10.2), then kicks from the penalty mark (5 each,
  then sudden death in the same order, Law 10.3). Competition rules may skip extra time and
  go straight to kicks.
- **Match result vs decider result:** the match result is the score after regulation (and
  extra time, if played). Kicks are **not** goals: they never enter GF/GA/GD, and the
  printed result is `1–1 (4–3 pens)`.

### 1.3 Outcome handling

| Case | Rule | Credited |
|---|---|---|
| Walkover (did not appear) | FDC Art. 28.1 | Winner 3-0; win points to the winner; loss to the offender |
| Retirement / team reduced below 7 / refuses to continue | Law 3 + FDC Art. 28.1 | 3-0 **or the pitch score if it is worse for the offender** (e.g. leading 5-0 stays 5-0) |
| Abandonment (weather, force majeure) | Competition rules; default **replay** | Nothing counts until replayed; in a knockout the fixture waits for a replay or an organiser ruling |
| No-result | Only as an abandonment the organiser chooses not to replay | Table: organiser rules (recommend: not counted — see RB2B-13) |
| Double walkover | FDC applies a forfeit to each | Both lose 0-3, 0 points each; played +1, lost +1 each; knockout: both out, next-round opponent advances by walkover |
| Disqualification of an entrant | Competition rules / FDC | Remaining fixtures forfeited 3-0; played fixtures per W5's withdrawal rule |
| Forfeit awarded by the organiser after a result (ineligible player) | FDC Art. 28.1 | Same as walkover, keeping the pitch score if worse for the offender |

### 1.4 Table rules

- **Points:** win 3, draw 1, loss 0. A group-stage shoot-out (youth-cup convention, only
  where a competition plays kicks after a group draw) pays the declared split (commonly
  2/1) and is recorded as **a draw plus a bonus point** in the W/D/L columns (RB2B-7).
- **Tiebreak default (recommend FIFA 2026):** points → H2H points → H2H GD → H2H goals →
  overall GD → overall goals → fair play (−1 yellow, −3 second yellow, −4 direct red,
  −5 yellow + direct red) → **drawing of lots** (deliberate deviation: FIFA uses its world
  ranking, which the product does not have — RB2B-4).
- **3-way ties:** the H2H mini-league is built among the tied teams only. FIFA applies it
  **once** and falls through to overall criteria; UEFA **re-applies** the H2H block to any
  subset still tied (Art. 20.01 d). Both must be offered; today only FIFA's is reachable.
- **Presets the organiser may pick (stage level):** `fifa2026` (default), `uefa` (H2H with
  re-application), `classic` (GD first).

### 1.5 Draws in knockout stages

A level knockout match at full time goes to extra time (if the stage declares it), then to
kicks. If the stage declares **no** decider, the match cannot finish level — the rulebook
requires every bracket stage to carry a decider (RB2B-1), so this state is unreachable after
W2. UEFA Art. 20.02's group-stage "penalties between two level teams that met last" is a
tiebreak, not a knockout decider (RB2B-5).

### 1.6 Settings and levels (ruling 12)

| Setting | Division | Stage | Fixture (before kick-off) | Mid-match |
|---|---|---|---|---|
| Half length, halves/quarters, team size | default | ✔ | ✔ (worst case: a final with no time left gets shorter halves) | ✘ |
| Extra time on/off, length | default | ✔ (bracket stages: on by default) | ✔ "straight to penalties" allowed (RB2B-3) | ✘ |
| Penalty shoot-out on/off | default | ✔ (bracket stages: **must** be on) | ✘ may not be switched off in a bracket | ✘ |
| Shoot-out attempts (5; youth 3) | default | ✔ | ✘ | ✘ |
| Table points incl. group shoot-out split | default | ✔ until the stage's first fixture starts, then locked (O8) | **never** | ✘ |
| Tiebreak preset / order | default | ✔ until first fixture starts, then locked | **never** | ✘ |
| Walkover score (3) | default | ✔ | never | ✘ |
| Abandonment policy | default | ✔ | never | ✘ |

### 1.7 Product today vs rule

| # | Rule | Product (file:line) | Verdict | Audit |
|---|---|---|---|---|
| F-1 | Goals per period, 2 halves / 4 quarters | `football.ts:66-110` (`halfMinutes`, `halves`) | MATCH | — |
| F-2 | Level at FT → ET (if declared) → kicks → else draw | `football.ts:999-1023` (`resolveFullTime`) | MATCH | — |
| F-3 | Kicks: 5 each then sudden death, early decision | `period/shootout.ts:60-77` (`shootoutDecision`, attempts 5) | MATCH | — |
| F-4 | Sudden-death kick order continues unchanged | `shootout.ts:80-85` (`expectedKicker` keeps the first kicker's side) | MATCH | — |
| F-5 | Kicks never counted as goals; result `1–1 (4–3 pens)` | `football.ts:1685-1697` (`sideMetrics` reads `state.goals`); `football.ts:1599-1633` | MATCH | confirms SC football row |
| F-6 | Deciders are a **stage** decision | Division-wide cfg; editor says "Knockout fixtures only" but `resolveFullTime` has no stage input; no stage screen | DIFFERS | confirms SC-X2, SC-P1 |
| F-7 | A bracket stage always has a decider | A stage with none: FT refused `DRAW_NOT_ALLOWED` (`append-event.ts:334-346`) and cfg frozen, so the match cannot finish | DIFFERS | confirms SC-P2 |
| F-8 | Points 3/1/0 | `football.ts:111-121` | MATCH | — |
| F-9 | Group shoot-out = draw + bonus in W/D/L | `football.ts:2622-2636` books it `won 1 / lost 1` with split points | DIFFERS | confirms SC-P5, ST-G16 |
| F-10 | FIFA 2026 cascade, H2H applied once | `football.ts:1704-1710` `fifa2026`; `tiebreakers.ts:456` (non-recursive default) | MATCH | — |
| F-11 | Fair-play values −1/−3/−4/−5 | `football.ts:1036-1057` | MATCH | — |
| F-12 | Final criterion | `lots` (`football.ts:1707`) vs FIFA world ranking | DIFFERS (deliberate deviation candidate, RB2B-4) | — |
| F-13 | UEFA re-application for a still-tied subset | Engine supports it (`tiebreakers.ts:456-461`) but no caller sets `h2hRecursive` | MISSING | new (not in audits) |
| F-14 | UEFA Art. 20.02 penalties between two level teams meeting last | none | MISSING | new |
| F-15 | Forfeit 3-0 | `football.ts:1635-1651` (`awardScore.goals` 3) | MATCH | — |
| F-16 | Pitch result upheld if worse for the offender | `applyForfeit` overwrites `goals` with 3-0 whatever the score (`football.ts:1640-1644`) | DIFFERS | new |
| F-17 | Abandon default = replay (nothing counts) | `football.ts:1653-1661` (`abandonPolicy: "replay"`, `football.ts:173`) | MATCH | — |
| F-18 | An abandonment the organiser settles (award) counts in the table | `award` policy yields an outcome but status stays `abandoned` → `void` → excluded | DIFFERS | confirms ST-G1 (extends it to football) |
| F-19 | Level abandonment in a bracket must be settled, not stall | `award` policy + level → `no_result`, passes the guard, seats nobody | DIFFERS | confirms SC-P9, SC-X1 |
| F-20 | Double walkover | No two-sided forfeit (`core.forfeit` has one `by`) | MISSING | confirms SC-S6 (extends to football) |
| F-21 | Table points / tiebreakers settable per stage, locked once started | Division-only; no cascade editor; `validateCascade` never called | MISSING | confirms ST-G10 |
| F-22 | Match format per stage and per fixture (before kick-off) | Not a stage-rules sport; `resolveFixtureCfg` takes no fixture input (`fixture-cfg.ts:39-46`) | MISSING | confirms FX-G23 / SC-O8 scope |
| F-23 | Futsal (FIFA Futsal Laws; forfeit 5-0 FDC 28.1) | No preset (variants 11-a-side / youth / small-sided / mini-soccer) | MISSING | confirms SC-P11 |
| F-24 | Result-only entry "3–1" | Goal-by-goal + HT/FT taps only | MISSING | confirms SC-P12 |
| F-25 | Settle an unresolved knockout by lot / organiser decision | no event | MISSING | confirms SC-X3 |
| F-26 | Shoot-out attempts configurable (IFAB 5; youth 3) | football `shootout` is a boolean; attempts fixed 5 | MISSING | confirms SC-P7 |

**Counts — football: MATCH 10 · DIFFERS 7 · MISSING 9.**

### 1.8 Edge cases (expected outcome under this rulebook)

| ID | Expected |
|---|---|
| M1 walkover in one match | 3-0 award to the opponent; win points; fixture `forfeited`; table counts it; bracket advances the winner |
| M2 double walkover | Both 0-3, 0 points, P+1 L+1 each (table); bracket: both out, the next-round opponent advances by walkover |
| M3 retirement / reduced below 7 | Award to the opponent, 3-0 **or** the pitch score if worse for the retiring side |
| M4 abandoned / no-result | Default replay: nothing counts; bracket waits (visible) until replayed or settled via the X3 event; an organiser-settled result counts in the table |
| M5 draw where the stage cannot end level | Unreachable after RB2B-1 (every bracket stage has a decider). Until then: refused with a named reason **and** a way forward (the stage decider screen) |
| M6 tie → decider | ET (if declared) then kicks; winner advances; score `1–1 (4–3 pens)`; kicks not in GD |
| M7 void a decided result | Before the next match starts: the result and the advanced name are withdrawn. After: refused `NEXT_MATCH_STARTED` (owner ruling 2026-09-23) |
| M8 correct a finalized score | Winner stays: table recomputes, bracket unchanged. Winner flips: same as M7 |
| M9 forfeit by organiser | As M1; a forfeit on a played match keeps the pitch score if worse for the offender |
| M10 DQ mid-match | Award to the opponent as M3; the entrant's status per W5 |
| M11 rules change mid-match | **Refused** with a named reason. Today a division edit is silently ignored for a started fixture (V347) — a refusal is owed (RB2B-31) |
| X3 round shortened before kick-off | Fixture-level half length applies to that fixture only; table points unchanged |
| F5 two-way tie | H2H result decides; if level (draw), overall GD, goals, fair play, lots |
| F5 3-way tie | Mini-league among the three; FIFA: once, then overall; UEFA: re-apply to the remaining pair |
| F6 everyone level | Every H2H and overall key level → fair play → lots, the lot seeded and recorded (`lotsGroups`) |
| F7 falls through to lots | Reproducible lot from the stage `rngSeed`; flagged on the table as "decided by lot" |
| C1 home/away swapped | Correct via void + re-enter; table identical to the corrected result, GD of both sides flips |
| C2 result on the wrong match | Void on the wrong fixture (M7 rules), enter on the right one |
| C3 protest upheld | Overturn = forfeit per FDC 28 (pitch score kept if worse); replay = void the result, fixture back to scheduled |
| C4 ineligible player | Each affected fixture forfeited 3-0 (or pitch score if worse); **🚫 no bulk action** — RB2B-34 |
| C5 points deduction | **🚫** no organiser path (carry_deltas `FORMAT_LOCKED`) — RB2B-35 |
| C6 late correction after stage complete | Table recomputes; progression effects per W4/W5 |
| C7 annulled weeks later | Void → excluded from table; ranks recomputed |

---

## 2. Hockey (FIH outdoor)

### 2.1 Authority

| Topic | Citation |
|---|---|
| Pool points 3/1/0 and the ranking cascade | FIH General Tournament Regulations (Outdoor, April 2024) **Appendix 3 §1–2**: points → **matches won** → GD → goals for → H2H (two teams) / mini-league among only them (3+) → **field goals** → shoot-out among the tied teams **(read)** — https://www.fih.hockey/static-assets/pdf/fih-general-tournament-regulations-1st-april-2024.pdf |
| Classification (knockout) matches | GTR **Appendix 2 §3.3** (the regulation-time score is the registered result) and **§3.4** (drawn → shoot-out per Appendix 12; **no extra time**) **(read)** |
| Shoot-out | GTR **Appendix 12**: 5 players each, 8 seconds; level → second series of five, sudden death within the series; **§20c / §21b: the team that started a series defends first in the next** (starter alternates) **(read)** |
| League shoot-out bonus (2/1) | FIH Pro League Regulations Season 7 (April 2026) **Reg 4.2 b–c**: a drawn match goes to a shoot-out; normal-time win 3; **shoot-out winner 1 + 1 bonus = 2; shoot-out loser 1**; loss 0 — i.e. the match **is a draw** plus a bonus **(read)** — https://www.fih.hockey/static-assets/pdf/fih-pro-league-regulations-season-7-april-2026.pdf |
| Pro League cascade | Reg 4.2: points → matches won → GD (normal time) → GF → H2H → field goals → cards **(read)** |
| Withdrawal / failure to play | GTR **Reg 13.1**: a team refusing or failing to complete a pool match is withdrawn; **all its matches recorded 5-0 losses**, team not ranked **(read)** |
| Abandonment | Pro League **Reg 7.1 h–j**: abandoned in the 4th quarter → score stands; before the 4th quarter → cancelled **(read)** |

### 2.2 Match rules

- **Scoring:** goals by kind (field goal, penalty corner, stroke, own goal) over 4 quarters.
- **Regulation result:** score after 4 quarters. Draws stand in pool/league play.
- **Deciders:** **no extra time** anywhere; a match that must produce a winner goes to a
  shoot-out (App. 12). In a league that plays shoot-outs (Pro League style) the match stays a
  **draw**; the shoot-out awards the bonus point.
- **Match vs decider:** shoot-out goals never enter GF/GA/GD (FIH does not credit a winning
  goal, unlike IIHF). Printed `2–2 (SO 3–0)`.

### 2.3 Outcome handling

| Case | Credited |
|---|---|
| Walkover / failure to play | 5-0 to the opponent (GTR 13.1); win points to the opponent |
| Retirement / failure to complete | 5-0, or the pitch score if worse for the offender (recommend the FDC-style upheld-score rule for consistency — RB2B-6) |
| Abandonment | 4th quarter → score stands (counts); earlier → cancelled/replay |
| Double walkover | Both 0-5, 0 points, P+1 L+1; bracket: both out |
| Disqualification | GTR 13.1: team not ranked; all matches 5-0 losses (a W5 withdrawal rule — recorded here as the sport's input) |

### 2.4 Table rules

- **Points:** win 3, draw 1, loss 0 (GTR App. 3). Where the stage plays shoot-outs after a
  draw: normal-time win 3, SO win 2, SO loss 1, loss 0 — recorded as **D** plus a bonus.
- **Cascade:** points → matches won → GD → GF → H2H (2 teams: the match between them; 3+:
  mini-league among only them, then the earlier keys within it) → field goals → **lots**
  (deviation: FIH plays a ranking shoot-out between tied teams, App. 3 §2 g–k — RB2B-11).

### 2.5 Draws in knockout stages

Straight to a shoot-out (5, then sudden-death series, starter alternating per series). No
extra time. A bracket stage without a shoot-out is refused at creation (RB2B-1).

### 2.6 Settings and levels

| Setting | Division | Stage | Fixture (pre-start) |
|---|---|---|---|
| Quarter length, players per side (youth 7) | default | ✔ | ✔ |
| Shoot-out on/off | default | ✔ (bracket: must be on) | ✘ |
| Shoot-out attempts (5; youth 3) | default | ✔ | ✘ |
| Table points incl. SO win/loss | default | ✔ until first fixture starts | never |
| Tiebreak order | default | ✔ until first fixture starts | never |
| Walkover score (5) | default | ✔ | never |
| Abandonment policy (Q4 rule) | default | ✔ | never |

### 2.7 Product today vs rule

| # | Rule | Product (file:line) | Verdict | Audit |
|---|---|---|---|---|
| H-1 | 4 quarters, goal kinds fg/pc/stroke/og | `hockey.ts:125-136` | MATCH | — |
| H-2 | Draws stand, 3/1/0 by default | `hockey.ts:127-129`; `period/kernel.ts:2644-2647` | MATCH | — |
| H-3 | No extra time; level → shoot-out when declared | `period/kernel.ts:1032-1044` (`resolveEnd`: OT only if `overtime` set; hockey default null) | MATCH | — |
| H-4 | Shoot-out 5 then sudden death | `kernel.ts:1343` (`shootoutDecision(kicks, attempts)`) | MATCH | — |
| H-5 | Series starter alternates (App. 12 §20c/§21b) | `expectedKicker` makes the first shooter's side lead every pair and **refuses** the other order (`kernel.ts:1325-1330`, `shootout.ts:80-85`) | DIFFERS | new |
| H-6 | Shoot-out goals not in GF/GA | `period.test.ts:686-705` asserts 2/2/0 | MATCH | — |
| H-7 | SO-decided league match = draw + bonus (W/D/L) | `kernel.ts:2614-2622` books it `won 1 / lost 1` | DIFFERS | confirms SC-P5 |
| H-8 | SO points 2/1 whenever shoot-outs are on | Editor toggle writes no points (`match-rules.ts:621-645`); `winPoints` falls back to `win/loss` = 3/0 (`kernel.ts:1467-1478`). Only the `fih-shootout` variant pays 2/1 (`hockey.ts:141-144`) | DIFFERS | confirms SC-P4 (see §8 note) |
| H-9 | Deciders set per stage | Division-wide; the stage overlay key `extraTime` is meaningless for period sports | DIFFERS | confirms SC-X2, SC-P1, SC-P8 |
| H-10 | Bracket stage always has a decider | Default `shootout: null` → level bracket match refused and frozen | DIFFERS | confirms SC-P2 |
| H-11 | Cascade: points → **wins** → GD → GF → H2H → **field goals** | `hockey.ts:212`: points → diff → for → h2h_points → seed (no `wins`, no field goals, no lots) | DIFFERS | new |
| H-12 | 3+-team mini-league then earlier keys within it | `tiebreakers.ts:414-462` builds the mini-table once; no re-application | DIFFERS | new (same root as F-13) |
| H-13 | Walkover 5-0 | `hockey.ts:134` `awardScore.goals: 3` | DIFFERS | new |
| H-14 | Pitch score upheld if worse for the offender | `kernel.ts:1429-1444` overwrites goals | DIFFERS | new |
| H-15 | Abandonment: Q4 → score stands; earlier → cancelled | `replay` or `award` at any time (`kernel.ts:1446-1463`); an award never reaches the table (ST-G1) | DIFFERS | confirms ST-G1; new (Q4 rule) |
| H-16 | Level abandonment in a bracket settled, not stalled | `no_result` passes the guard | DIFFERS | confirms SC-P9, SC-X1 |
| H-17 | Double walkover | none | MISSING | confirms SC-S6 (extends) |
| H-18 | Stage table points / tiebreak editor + lock | none (SO points not editable at all) | MISSING | confirms ST-G10, SC-P4 |
| H-19 | Match format per stage / fixture | not a stage-rules sport; no fixture input | MISSING | FX-G23 |
| H-20 | Shoot-out `suddenDeath` flag honoured or removed | declared, never read (`kernel.ts:88,194`) | MISSING | confirms SC-P7 |
| H-21 | Result-only entry | no `coarsen` / final-score event | MISSING | confirms SC-P12 |
| H-22 | Settle an unresolved bracket fixture by lot / organiser | none | MISSING | confirms SC-X3 |

**Counts — hockey: MATCH 5 · DIFFERS 11 · MISSING 6.**

### 2.8 Edge cases

| ID | Expected |
|---|---|
| M1 | 5-0 award, win points; bracket advances the opponent |
| M2 | Both 0-5, 0 points; bracket: both out |
| M3 | Award 5-0 or the pitch score if worse |
| M4 | Abandoned in Q4 → the score stands and counts; earlier → replay; bracket waits or X3-settles |
| M5 | Unreachable after RB2B-1; until then refused with a way forward |
| M6 | Straight to shoot-out; tie-break series starter alternates; `2–2 (SO 3–0)`; league: D + bonus, 2/1 |
| M7–M9 | As football (M7 owner ruling 2026-09-23; forfeit 5-0) |
| M10 | Award 5-0 to the opponent |
| M11 | Refused (RB2B-31) |
| X3 | Shorter quarters for one fixture before the push-back; points unchanged |
| F5 (2) | Points, wins, GD, GF, then the match between them, field goals, lots |
| F5 (3+) | Mini-league among only them (points, then wins/GD/GF within it), field goals, lots |
| F6 | All keys level → lots (FIH would play ranking shoot-outs — deviation RB2B-11) |
| F7 | Seeded lot, flagged |
| C1–C7 | As football, with 5-0 forfeits; C4 🚫 bulk (RB2B-34); C5 🚫 (RB2B-35) |

---

## 3. Ice hockey (IIHF)

### 3.1 Authority

| Topic | Citation |
|---|---|
| Points 3-2-1-0 | IIHF Sport Regulations 2023/24, "Three point system" **(read)** — https://blob.iihf.com/iihf-media/iihfmvc/media/downloads/regulations/2023/2023_iihf_sport_regulations.pdf ; IIHF Official Rule Book 2026/27 **Rule 78.1** (regulation win 3; OT/shootout win 2, loss 1 in round robin / preliminary round) **(read)** — https://blob.iihf.com/iihf-media/iihfmvc/media/downloads/rule%20book/2026-27_iihf_rule_book.pdf |
| Tie-breaking | Sport Regulations "Tie breaking system": 2 teams → the game between them; 3+ → sub-group on direct-game points, then direct GD, then direct goals; **"this process will continue until only two or none remain tied"**; steps 4–5 results against the closest best-ranked team outside; step 6 seeding **(read)** |
| Tiebreaks before all mutual games are played | Sport Regulations: fewest games played → GD all games → GF all games → seeding **(read)** |
| Overtime | Rule Book **Rule 84.1** (preliminary: 5-min sudden death, 3 skaters); Sport Regulations: playoff / bronze 10-min sudden death; **gold medal: 20-min sudden-death periods repeated "until a winner is declared"** **(read)** |
| Shootout | Rule Book **Rule 84.4**: 5 different shooters alternately; level → tie-break shots, **"the team that shot second in the first five … will start first"**, same player may repeat; **(XI) "only the decisive goal will count in the result of the game"** **(read)** |
| Forfeit | Rule Book **Rule 66**: the game is cancelled and the Proper Authority decides the outcome — **no fixed score** **(read)** |

### 3.2 Match rules

- **Scoring:** goals (fg/pp/sh/ps/og) over 3 × 20.
- **Regulation result:** a game never ends level under IIHF: level after regulation → OT
  (sudden death) → shootout (GWS).
- **Match vs decider:** OT goals are real goals. Of the shootout, **exactly one goal** is
  credited to the winner's official score (2–2 won on shots is recorded 3–2).
- Recreational leagues may play **no OT, draws stand, 2/1/0** (product `recreational`
  variant — product rule, no IIHF basis).

### 3.3 Outcome handling

| Case | Credited |
|---|---|
| Walkover / forfeit | IIHF leaves it to the Proper Authority; **product rule: 5-0** award, regulation-win points (3/0) |
| Retirement / cannot ice enough players | Rule 66: cancelled, Proper Authority decides → product: award 5-0 or pitch score if worse (RB2B-6) |
| Abandonment | Replay by default |
| Double walkover | Both 0-5, 0 points, both lost; bracket: both out |

### 3.4 Table rules

- **Points:** regulation win 3, OT/GWS win 2, OT/GWS loss 1, regulation loss 0.
- **Columns:** GP · W · **OTW** · **OTL** · L · GF · GA · GD · Pts (OT and GWS decisions both
  land in OTW/OTL, as IIHF standings print them). Recreational: GP W D L.
- **Cascade:** points → H2H points → H2H GD → H2H goals → **re-applied** to the remaining
  subset until ≤2 remain; 2 remaining → their game → overall GD → overall GF → seed →
  lots. IIHF steps 4–5 (results against the next best-ranked team) are a deliberate deviation
  (RB2B-12).
- **Partial schedule (mid-tournament):** if the tied teams have not all met, rank by fewest
  games played, GD, GF, seed (IIHF) — this is ST-G12's missing guard.

### 3.5 Draws in knockout stages

Unreachable by rule: OT then GWS. Playoff OT 10 min (recommended stage default for
knockout); a final may be declared "continuous sudden-death OT until a goal" (gold-medal
rule). OT on + GWS off is legal **only** with continuous OT (RB2B-9).

### 3.6 Settings and levels

| Setting | Division | Stage | Fixture (pre-start) |
|---|---|---|---|
| Period length | default | ✔ | ✔ |
| OT kind (single sudden-death / continuous until goal / none), length, skaters | default | ✔ (bracket: OT or GWS required) | ✔ length only |
| GWS on/off, attempts (5) | default | ✔ (bracket: on unless continuous OT) | ✘ |
| Table points (3-2-1-0 / 2-1-0) | default | ✔ until first fixture starts | never |
| Tiebreak order | default | ✔ | never |
| Walkover score (5) | default | ✔ | never |

### 3.7 Product today vs rule

| # | Rule | Product (file:line) | Verdict | Audit |
|---|---|---|---|---|
| I-1 | 3 × 20, goal kinds | `icehockey.ts:165-173` | MATCH | — |
| I-2 | Level → 5-min 3-on-3 sudden-death OT → GWS | `icehockey.ts:167-168`; `kernel.ts:1032-1044` | MATCH | — |
| I-3 | GWS 5 shooters then tie-break shots | `icehockey.ts:168`; `kernel.ts:1343` | MATCH | — |
| I-4 | Tie-break shots: team that shot second starts | `expectedKicker` forces the first shooter's side and refuses the IIHF order (`kernel.ts:1325-1330`) | DIFFERS | new |
| I-5 | Shootout winner credited one goal | `icehockey.ts:245` `shootoutWinnerGoal`; `kernel.ts:2258-2285`; `period.test.ts:651` | MATCH | — |
| I-6 | Points 3-2-1-0 | `icehockey.ts:170`; `kernel.ts:1467-1478` | MATCH | — |
| I-7 | OTW / OTL columns | Folded into W/L; no column | MISSING | confirms ST-G16 |
| I-8 | 2-team tie → their game | cascade `h2h_points` first (`icehockey.ts:237`) | MATCH | — |
| I-9 | 3+ → re-apply until ≤2 remain | block applied once (`tiebreakers.ts:456`, `h2hRecursive` never set) | DIFFERS | new |
| I-10 | Partial-schedule tiebreak (fewest GP, GD, GF, seed) | none; H2H built from whatever has been played | MISSING | confirms ST-G12 |
| I-11 | Playoff OT 10 min; gold-medal continuous OT | OT is one period or a fixed count (`kernel.ts:175-187`); OT on + GWS off → level → draw refused | MISSING | confirms SC-P3 |
| I-12 | Deciders per stage | division-wide | DIFFERS | confirms SC-X2, SC-P1 |
| I-13 | OT/SO points editable per stage | `otWin/otLoss` not editable (`division-settings.tsx:262-278`); API PointsRule flattens OT (points.ts) | MISSING | confirms SC-P4, SC-P10 |
| I-14 | Recreational: no OT, draws, 2/1/0 | `icehockey.ts:196-201` | MATCH | — |
| I-15 | Forfeit: product 5-0 | `icehockey.ts:175` | MATCH (product rule; IIHF Rule 66 sets no score) | — |
| I-16 | Pitch score upheld if worse | overwritten (`kernel.ts:1429-1444`) | DIFFERS | new |
| I-17 | Abandon default replay | `icehockey.ts:176` | MATCH | — |
| I-18 | Level abandonment in a bracket settled | award policy + level → `no_result` stalls | DIFFERS | confirms SC-P9, SC-X1 |
| I-19 | Double walkover | none | MISSING | SC-S6 (extends) |
| I-20 | Match format per stage / fixture | none | MISSING | FX-G23 |
| I-21 | Settle by lot / organiser | none | MISSING | SC-X3 |

**Counts — ice hockey: MATCH 9 · DIFFERS 5 · MISSING 7.** (I-15 counted as MATCH to the
product rule it adopts.)

### 3.8 Edge cases

| ID | Expected |
|---|---|
| M1 | 5-0 award, 3 points to the opponent |
| M2 | Both 0-5, 0 points, both L |
| M3 | Award 5-0 or the pitch score if worse |
| M4 | Replay; bracket waits or X3-settles |
| M5 | Unreachable (OT + GWS always on in a bracket, or continuous OT) |
| M6 | OT (5 min table / 10 min playoff) → GWS; winner +1 goal; table 2/1; OTW/OTL columns |
| M7–M11 | As football; M11 refused |
| X3 | Shorter periods / OT for one fixture before face-off |
| F5 (2) | Their game decides (never level under IIHF) |
| F5 (3+) | Sub-group on direct points → direct GD → direct GF, re-applied until ≤2; then their game; then overall GD, GF, seed, lots |
| F5 mid-tournament | Fewest GP, GD, GF, seed |
| F6 | Seed then lots |
| F7 | Lots, flagged |
| C1–C7 | As football; C4 🚫 bulk (RB2B-34); C5 🚫 (RB2B-35) |

---

## 4. Boardgame (chess; draughts and go share the module)

### 4.1 Authority

| Topic | Citation |
|---|---|
| Game points 1 / ½ / 0 | FIDE Laws of Chess (2023) **Art. 10.1** **(read)** — https://handbook.fide.com/chapter/E012023 |
| Forfeit / default time | Laws **Art. 6.7.1** (player absent after the default time loses); **Art. 6.7.2** (neither present: White's clock runs unless regulations say otherwise); **Art. 11.8** (both found guilty → "lost by both players") **(read)** |
| Result consistency | Laws **Art. 5.1** (checkmate wins), **5.2** (stalemate / dead position = draw), **9.2–9.6** (repetition, 50/75-move) — as cited in the module (`boardgame.ts:98-106`) |
| Tie-breaks (tables) | FIDE Handbook C.07 Play-Off and Tie-Break Regulations (effective 1 March 2026): **Art. 4.1.1** list published before the start; **Art. 4.2** remaining ties by drawing of lots; **Art. 8 note** Buchholz-family "must not be used in round-robins"; **Art. 15.2** forfeit wins/losses count as regular games except in ratings-based and Type-B tie-breaks **(read, summary)** — https://handbook.fide.com/chapter/TieBreakRegulations032026 |
| Knockout matches and tie-break games | FIDE World Cup 2025 regulations: 2 classical games; if 1–1 → 2 rapid (15+10) → 2 rapid (10+10) → 2 blitz (5+3) → 2 blitz (3+2) → **armageddon**: White 4+2, players bid for Black; **a draw = Black wins the match** **(secondary — re-read the FIDE handbook text)** — https://en.wikipedia.org/wiki/Chess_World_Cup_2025 ; C.07 Art. 3 leaves play-off parameters to the organiser |
| Draughts / go | No federation is adopted for W2: the module scores them with the chess vocabulary. Product rule (RB2B-22). |

### 4.2 Match rules

- **Scoring model:** one game, one terminal result `{winner | null, method}`; stored as
  half-points ×2 (win 2, draw 1, loss 0) and **always displayed as 1 / ½ / 0**.
- **Regulation result:** the game result. A draw is a real result in every table stage.
- **Knockout "match":** a fixture in a bracket is a **mini-match** of N games (default 1 for
  club events, 2 for FIDE-style), then a tie-break ladder the organiser fixes per stage:
  rapid pair(s) → blitz pair(s) → armageddon (draw = Black advances) — or lots as the club
  fallback. The **match result** is the classical score (e.g. 1–1); the **decider result**
  names who advanced and by which rung (`1–1, won on rapid 1½–½`).

### 4.3 Outcome handling

| Case | Credited |
|---|---|
| Forfeit (one absent) | Opponent 1, absentee 0 (Art. 6.7.1); a forfeit counts as a regular game for table tie-breaks (C.07 15.2), is excluded from colour history |
| Double forfeit | **Both lose**: 0–0, P+1 and **L+1 each** (Art. 11.8 wording "lost by both"; C.07 treats forfeits as games); bracket: both out |
| Retirement (resigns) | A normal loss (`resign`) |
| Abandonment | Rare; replay / arbiter decision; nothing counts meanwhile |
| Disqualification | Loss of the game; tournament status per W3/W5 |
| Bye | W3's rulebook (full-point vs half-point bye, SC-O7) — not decided here |

### 4.4 Table rules

- **Points:** 1 / ½ / 0 (stage may choose 3/1/0 "football scoring", as some opens do —
  RB2B-18).
- **Swiss cascade:** W3 rulebook (Buchholz family).
- **Round-robin cascade (recommend):** points → direct encounter (mini-league among the tied
  players) → number of wins → Sonneborn-Berger (from pool results) → lots. **No Buchholz in a
  round-robin** (C.07 Art. 8 note).
- Tie-break list fixed before the first round (Art. 4.1.1) → stage-level, locked at start.

### 4.5 Draws in knockout stages

A drawn classical game in a bracket is **not** a finished fixture: the fixture proceeds to the
stage's tie-break ladder; the fixture finishes only when a rung produces a winner (armageddon
guarantees one). Club fallback (a stage with no ladder): the organiser must record a decider
(lots / arbiter) — never a silent stall.

### 4.6 Settings and levels

| Setting | Division | Stage | Fixture (pre-start) |
|---|---|---|---|
| Time control (variant, base, increment, delay) | default | ✔ | ✔ (metadata; e.g. a final played faster) |
| Games per knockout match (1, 2, 4) | default | ✔ | ✔ |
| Tie-break ladder (rungs, their time controls, armageddon times) | default | ✔ | ✘ |
| Colours on/off | default | ✔ | ✘ |
| Table points (1/½/0 or 3/1/0) | default | ✔ until round 1 starts | never |
| Tie-break list | default | ✔ until round 1 starts | never |
| Bye value | W3 | W3 | — |

### 4.7 Product today vs rule

| # | Rule | Product (file:line) | Verdict | Audit |
|---|---|---|---|---|
| B-1 | 1 / ½ / 0 stored exactly | `boardgame.ts:39-48` (half-points ×2) | MATCH | — |
| B-2 | Pts displayed as 1 / ½ / 0 | Public table prints raw half-points (`standings-table.tsx:374` `formatMetric(row.points)`); `pointsToText` has 0 callers in `apps/web` | DIFFERS | confirms ST-G2 |
| B-3 | Draw valid in table stages | `boardgame.ts:770-772` | MATCH | — |
| B-4 | Drawn KO game → tie-break ladder, never a finished fixture | `supportsDraws` true for every kind; draw accepted, seats nobody; test pins it (`boardgame.test.ts:159-163`) | DIFFERS | confirms SC-O1 |
| B-5 | Mini-match (N games) and tie-break rungs / armageddon | none (the "mini-matches at the fixture layer" comment has no code) | MISSING | confirms SC-O1, offered-matrix reason b |
| B-6 | Forfeit: opponent 1, absentee 0 | `boardgame.ts:616-629` → win, method `forfeit` | MATCH | — |
| B-7 | Forfeit recordable before the game starts (Art. 6.7.1) | refused outside `live` (`boardgame.ts:617`); `core.start` first | DIFFERS | plan-facts (new as a rule gap) |
| B-8 | Forfeit excluded from colour history | `boardgame.ts:320-335` (`colorOf` null when forfeited) | MATCH | — |
| B-9 | Double forfeit = both lose | `double_forfeit` → `no_result`, 0 points, P+1, **W/D/L all 0** (`boardgame.ts:264-266, 747-752`) | DIFFERS | new (partial) |
| B-10 | Double forfeit in a bracket: both out | `no_result` passes the guard, stalls | DIFFERS | confirms SC-X1, SC-O5 |
| B-11 | Result/method consistent (Art. 5) | `{winner, "stalemate"}` and `{null, "checkmate"}` both fold (`boardgame.ts:243-280`) | DIFFERS | confirms SC-O10 |
| B-12 | RR cascade: direct, wins, SB, lots; no Buchholz | default cascade `points, buchholz_cut1, buchholz, sberger, direct, wins, lots` (`boardgame.ts:350-358`); outside Swiss all three Buchholz/SB compare **level** (`tiebreakers.ts:351-358`, `competition.ts:404`) — effectively points → direct → wins → lots, **no SB** | DIFFERS | new |
| B-13 | Tie-break list fixed before start, stage-level | division-level, no editor | MISSING | confirms ST-G10 |
| B-14 | Table points editable at stage level | `scoring` not recognised by the points editor (`division-settings.tsx:262-278`) | MISSING | new |
| B-15 | Time control per stage / fixture | division-level editor only (`match-rules.ts:654-700`) | MISSING | SC-O8 |
| B-16 | Lots as the last resort | `lots` at the tail | MATCH | — |
| B-17 | Team chess (board points) | individual entrants only (`boardgame.ts:515` per SC-O12) | MISSING | confirms SC-O12 |
| B-18 | Settle a bracket fixture by lot / arbiter | none | MISSING | SC-X3 |

**Counts — boardgame: MATCH 5 · DIFFERS 7 · MISSING 6.**

### 4.8 Edge cases

| ID | Expected |
|---|---|
| M1 | Opponent 1–0 (forfeit), recordable without a start event; excluded from colours |
| M2 | Both lose 0–0, P+1 L+1; bracket: both out, next opponent advances |
| M3 | Resignation = loss (no partial credit concept) |
| M4 | Replay / arbiter; nothing counts; bracket waits or X3-settles |
| M5 | A drawn KO game is not final: the fixture enters its tie-break ladder |
| M6 | Rapid → blitz → armageddon (draw = Black advances); the match result stays e.g. 1–1, decider recorded separately |
| M7–M9 | As football (void rules 2026-09-23) |
| M10 | Game lost by the disqualified player |
| M11 | Refused (e.g. changing the time control mid-game) |
| X3 | Faster time control for one game before it starts |
| F5 (RR) | Direct encounter mini-league → wins → SB → lots |
| F5 (Swiss) | W3 |
| F6 | Every player level (all draws) → direct level → wins 0 → SB level → lots |
| F7 | Lots, flagged |
| C1 | Colours swapped: correct the pairing card; points unchanged unless the result was keyed from the wrong side |
| C2–C7 | As football; C4 = forfeit losses; C4 🚫 bulk (RB2B-34); C5 🚫 (RB2B-35) |

---

## 5. Carrom (ICF)

### 5.1 Authority

| Topic | Citation |
|---|---|
| Game / match | ICF Laws of Carrom **Law 56** (a game is 25 points or 8 boards; leader after the 8th board wins; **level → an extra board**, toss for break) and **Law 57** (a match is best of three games) **(read via search summary; module cites the same laws, `carrom.ts:45-77`)** — https://www.carrom.co.uk/laws-of-carrom/ |
| Board points | Laws 52–54 (coins 1 each, queen 3 up to and including 21 points, no queen benefit from 22) — module citations `carrom.ts:55-70` |
| Absence | Law 143(i): a player who fails to report within 15 minutes after the match is announced loses the match **(read)** — same URL |
| Table points, walkover score, abandonment | **Not governed** by the ICF Laws → **product rules** (design §7.1) |

### 5.2 Match rules

- **Scoring:** boards → game (first to 25 / leader after 8, extra board if level) → match
  (best of 3). ICF play **never** ends level.
- **House rule** (product, `tieBoard: "draw"`): a game level after `maxBoards` is drawn,
  which can make a match drawn — **table stages only**.
- **Match result:** games won (e.g. 2–1); the extra board is part of the game, not a separate
  decider.

### 5.3 Outcome handling (product rules)

| Case | Credited (recommended) |
|---|---|
| Walkover (Law 143(i)) | Match to the opponent; win points; games 2–0; each awarded game 25–0 in points; boards unchanged (RB2B-24) |
| Retirement | Match to the opponent; completed games stand; unfinished games awarded 25–(opponent's score) |
| Abandonment | Replay by default (RB2B-25) |
| Double walkover | Both lose, 0 points; bracket: both out |

### 5.4 Table rules (product)

- **Points:** win 2, draw 1 (house rule only), loss 0.
- **Cascade:** points → wins → game ratio → board ratio → point ratio → H2H → lots (kept as
  the product rule).

### 5.5 Draws in knockout stages

ICF Law 56 extra board always applies in bracket stages, **whatever the division's house
rule** — so a carrom match in a bracket always has a winner.

### 5.6 Settings and levels

| Setting | Division | Stage | Fixture (pre-start) |
|---|---|---|---|
| gameTo, maxBoards, bestOf | default | ✔ | ✔ (a final played best of 5) |
| Queen points / cap / follows-board | default | ✔ | ✘ |
| tieBoard (extra / draw) | default | ✔ table stages only; brackets forced `extra` | ✘ |
| Table points | default | ✔ until first fixture starts | never |
| Tiebreak order | default | ✔ | never |

### 5.7 Product today vs rule

| # | Rule | Product (file:line) | Verdict | Audit |
|---|---|---|---|---|
| C-1 | 25 points / 8 boards, extra board when level | `carrom.ts:45-77` (`gameTo 25`, `maxBoards 8`, `tieBoard "extra"`); `decideGame` `carrom.ts:306-314` | MATCH | — |
| C-2 | Best of 3 games | `carrom.ts:54`; `bankGame` `carrom.ts:320-352` | MATCH | — |
| C-3 | Queen / coin points | `carrom.ts:55-70` | MATCH | — |
| C-4 | Extra board forced in brackets | `tieBoard: "draw"` is division-wide; a level KO game → drawn match → refused `DRAW_NOT_ALLOWED`, match unfinishable | DIFFERS | confirms SC-O4 |
| C-5 | Table points 2/1/0 (product) | `carrom.ts:45-49` | MATCH | — |
| C-6 | Walkover credits games 2–0 and 25–0 per game | award keeps only games actually played (`carrom.ts:451-462, 949-956`) | DIFFERS | new (carrom analogue of SC-S3) |
| C-7 | Abandon → replay (undecided) | abandon → `no_result`, shared draw points (`carrom.ts:465-470, 957-963`); status `abandoned` → void, so the shared points **never reach the table**; in a bracket it stalls | DIFFERS | confirms ST-G1, SC-O5 |
| C-8 | Double walkover | none | MISSING | new |
| C-9 | Cascade (product) | `carrom.ts:516-524` | MATCH | — |
| C-10 | Result-only entry at game level | band 0 is per board (`carrom.ts:707-711` per SC-O6) | MISSING | confirms SC-O6 |
| C-11 | Adjustment bounded by the game | `delta` unbounded above (`carrom.ts:122-127`) | DIFFERS | confirms SC-O9 |
| C-12 | Match format per stage / fixture (best of 5 final) | not a stage-rules sport | MISSING | confirms SC-O8 |
| C-13 | Table points / tiebreak per stage | division-level only | MISSING | ST-G10 |

**Counts — carrom: MATCH 5 · DIFFERS 4 · MISSING 4.**

### 5.8 Edge cases

| ID | Expected |
|---|---|
| M1 | Match to the opponent, 2 points, games 2–0, 25–0 per game |
| M2 | Both lose, 0 points; bracket both out |
| M3 | Completed games stand; the rest awarded |
| M4 | Replay; bracket waits or X3-settles |
| M5 | Unreachable in brackets (extra board forced) |
| M6 | Extra board decides the game (Law 56) |
| M7–M11 | As football; M11 refused (e.g. gameTo edited mid-match) |
| X3 | A final switched to best of 5 before it starts |
| F5 | Points → wins → game ratio → board ratio → point ratio → H2H → lots |
| F6 | Every ratio level → lots |
| F7 | Lots, flagged |
| C1–C7 | As football; C4 🚫 bulk (RB2B-34); C5 🚫 (RB2B-35) |

---

## 6. Generic (product-defined)

### 6.1 Authority

No federation governs "generic" — it is the product's container for unmodelled sports
(design §7.1). **Every rule below is a product rule and needs the owner's signature as
such.**

### 6.2 Match rules

- **Modes:** `win_loss` (a winner card, or a draw card when draws are allowed) or `score`
  (two non-negative integers, capped at a plausible maximum). Optional running tally.
- **Draws:** only in **table stages** (league / group / swiss) and only when `allowDraws`.
  In every bracket kind (knockout, double_elim, stepladder, page_playoff) and in ladder
  challenges a result must name a winner; the pad must not offer "Draw" there.
- **Deciders:** none modelled. A level bracket result is refused with a message that names
  what to do (enter the winner / settle via X3) — not "extra time or a shootout".

### 6.3 Outcome handling

| Case | Credited |
|---|---|
| Walkover | Win points; for/against 0–0 (no invented score); optional stage-level awarded score (RB2B-29) |
| Retirement | As walkover, keeping any recorded score |
| Abandonment | Replay by default (RB2B-25 applies to generic too); organiser may settle |
| Double walkover | Both lose, 0 points; bracket both out |

### 6.4 Table rules

- **Points:** 3 / 1 / 0 default, stage-editable.
- **Cascade:** points → diff → for → H2H points → lots.

### 6.5 Draws in knockout stages

Refused; the scorer enters the winner. No decider exists and none is recommended beyond the
shared X3 settle event.

### 6.6 Settings and levels

| Setting | Division | Stage | Fixture (pre-start) |
|---|---|---|---|
| resultMode | default | ✔ (before the stage starts) | ✘ (changes the table's metrics) |
| allowDraws | default | ✔ table stages only | ✘ |
| Table points | default | ✔ until first fixture starts | never |
| Tiebreak order | default | ✔ | never |

### 6.7 Product today vs rule

| # | Rule | Product (file:line) | Verdict | Audit |
|---|---|---|---|---|
| G-1 | win_loss / score modes | `generic.ts:30-72` | MATCH | — |
| G-2 | Draws only in table stages (allow-list) | deny-list excludes only knockout / double_elim / stepladder (`generic.ts:650-654`); page_playoff and ladder accept draws and stall | DIFFERS | confirms SC-O2 |
| G-3 | Pad hides Draw in brackets; refusal names a real way forward | pad reads cfg only; server says "extra time or a shootout" (`append-event.ts:342`) | DIFFERS | confirms SC-O3 |
| G-4 | Points 3/1/0 | `generic.ts:36-43` | MATCH | — |
| G-5 | Walkover: win points, 0–0 metrics | `generic.ts:557-564`, `generic.ts:620-627` (`sideMetrics` → zero when no score) | MATCH | — |
| G-6 | Abandon → replay by default | abandon → `no_result` shared draw points (`generic.ts:565-570, 634-638`), dropped from the table (ST-G1), stalls a bracket | DIFFERS | confirms ST-G1, SC-O5 |
| G-7 | Double walkover | none | MISSING | new |
| G-8 | Score cap enforced by the engine | cap 500 is pad-only (`generic.ts:250`) | DIFFERS | confirms SC-O11 |
| G-9 | Cascade points → diff → for → h2h → lots | `generic.ts:647` | MATCH | — |
| G-10 | Stage-level format / points / tiebreak | none | MISSING | SC-O8, ST-G10 |

**Counts — generic: MATCH 4 · DIFFERS 4 · MISSING 2.**

### 6.8 Edge cases

| ID | Expected |
|---|---|
| M1 | Win points, 0–0 |
| M2 | Both lose, 0 points; bracket both out |
| M3 | As walkover, recorded score kept |
| M4 | Replay; bracket waits or X3-settles |
| M5 | Level in a bracket refused, message names "enter the winner" |
| M6 | n/a (no decider) — X3 settle only |
| M7–M11 | As football |
| X3 | n/a for format (no match-format knobs beyond mode) — the case is dropped with that reason |
| F5–F7 | points → diff → for → H2H → lots |
| C1–C7 | As football; C4 🚫 bulk; C5 🚫 |

---

## 7. Cross-sport rules this wave must land (not sport-specific)

1. **Empty case (R13):** a stage with zero counted fixtures shows every entrant level and
   ranks by the last cascade key; a bracket fixture with no decider and a level result is
   refused, never "finished".
2. **No terminal non-win outcome in a bracket** (`draw`, `tie`, `no_result`) unless a decider
   has been recorded (SC-X1). The comment at `competition.ts:148-150` becomes a guard (R28).
3. **An abandonment that the organiser settles with an outcome counts** in the table and the
   bracket; an abandonment with no outcome is a replay (ST-G1, SC-X4).
4. **One X3 "settle" event** for all six sports: records who advances and why (lots,
   organiser decision, higher seed), marks the fixture decided, and never invents a score.
5. **Division-level points/tiebreakers lock per stage once that stage's first fixture
   starts** (O8, recommended in design §5 — confirmed here as RB2B-30).
6. **Tiebreak keys validated against the sport** at write time (ST-G10): `nrr` for football,
   `buchholz` outside Swiss, `board_ratio` outside carrom are refused.

---

## 8. Audit gaps: confirmed, extended, nuanced

- **Confirmed by read:** SC-X1, SC-X2, SC-X3, SC-P1, SC-P2, SC-P3, SC-P4, SC-P5, SC-P7, SC-P8,
  SC-P9, SC-P11, SC-P12, SC-O1, SC-O2, SC-O3, SC-O4, SC-O5, SC-O6, SC-O8, SC-O9, SC-O10,
  SC-O11, SC-O12, ST-G1, ST-G2, ST-G10, ST-G12, ST-G16.
- **Extended:** ST-G1 also swallows football/hockey `award`-policy abandonments and carrom /
  generic `no_result` abandonments (their shared points never reach a table). SC-S6 (double
  walkover) applies to football, hockey, ice hockey, carrom and generic too.
- **Nuanced (not contradicted):** SC-P4 / design §7.1 call FIH's split "2/1". That is the
  **Pro League** rule (Reg 4.2 c). FIH's tournament default (GTR App. 3) is 3/1/0 **with draws
  standing and no shoot-out in pools** — which is what the product's hockey default already
  does. The defect is real but narrower: it fires only when an organiser turns shoot-outs on
  for a table stage.
- **None failed to hold up** on read. (Behavioural confirmation is W2's truth run, R5.)
- **New gaps found by this rulebook (not in any audit):** F-13/H-12/I-9 (H2H re-application
  unreachable), F-14 (UEFA 20.02), F-16/H-14/I-16 (forfeit overwrites a worse pitch score),
  H-5/I-4 (tie-break shoot-out order refused), H-11 (FIH cascade missing wins / field goals),
  H-13 (FIH walkover 5-0), H-15 (FIH Q4 abandonment rule), B-7 (chess forfeit before start),
  B-9 (double forfeit not a loss), B-12 (round-robin chess has no working SB and uses
  Buchholz keys), B-14 (chess points not editable), C-6 (carrom walkover credit), C-8 / G-7
  (double walkover). W2 should list these in `_INDEX.md` with IDs at wave start.

---

## 9. Items for the owner (recommendations, each with its owner value)

Numbered RB2B-n. **None is a ruling.** 🚫 items carry a build-or-refuse recommendation.

**Deciders and brackets**

- **RB2B-1 — Every bracket stage carries a decider; creating one without is refused.**
  Defaults: football ET + penalties, hockey shoot-out, ice hockey OT + GWS, carrom extra
  board, chess tie-break ladder (RB2B-16), generic "enter the winner". *Owner value: no cup
  match can ever end on "TBD"; the organiser never needs support to finish a final.*
- **RB2B-2 — Deciders move to the stage, with a screen** (SC-X2/P1); the division value is
  only the default for new stages. Stage decider keys are validated against the sport schema
  at create (SC-P8). A group-stage shoot-out stays possible as an explicit table-stage choice.
  *Value: "penalties for the knockout" stops sending group draws to penalties.*
- **RB2B-3 — Fixture-level before kick-off may shorten periods and may switch extra time off
  ("straight to penalties"), never switch the shoot-out off in a bracket.** *Value: the owner's
  named worst case — a final with no time left — is handled without breaking the bracket.*
- **RB2B-9 — Ice hockey: add "continuous sudden-death OT until a goal" and default knockout
  stages to 10-minute OT + GWS.** *Value: standard playoff hockey is recordable (SC-P3).*
- **RB2B-10 — Shoot-out tie-break order follows the federation:** IIHF 84.4 (IX) and FIH App. 12
  §20c/21b (the other team starts the next series); football keeps IFAB order. Build.
  *Value: a correctly-run shoot-out is never refused by the pad.*
- **RB2B-14 — One X3 "settle" event (lot / organiser decision / higher seed) for every sport,
  and `draw`/`tie`/`no_result` refused in brackets unless settled** (SC-X1, SC-X3). *Value: a
  rained-off or double-no-show cup match has an honest record instead of a fake walkover.*
- **RB2B-16 — Chess knockout: build the tie-break mechanism.** Option A (recommended now): a
  fixture-level "games per match" plus a single decider event recording the rung that decided
  it (rapid / blitz / armageddon / lots) and the winner; `supportsDraws` false in bracket kinds
  unless the decider is present; the freezing test (`boardgame.test.ts:159`) is rewritten.
  Option B: model every tie-break game as its own fixture. *Value: a chess knockout finishes the
  way every arbiter runs one (SC-O1).*
- **RB2B-23 — Carrom: brackets always play the ICF extra board**, whatever the division house
  rule; `tieBoard` becomes a stage setting valid in table stages only. *Value: a club using the
  drawn-game house rule can still finish its knockout (SC-O4).*

**Table points and tiebreaks**

- **RB2B-4 — Football default `fifa2026`; also offer `uefa` (wire `h2hRecursive`) and
  `classic` as named stage presets. Final criterion: lots** (deliberate deviation from FIFA's
  world ranking / UEFA's qualifier ranking, which the product does not hold). *Value: an
  organiser copying either federation gets that federation's table.*
- **RB2B-5 — Refuse UEFA Art. 20.02** (penalties between two level teams that met last) —
  record as a deviation. *Value: avoids a rare, clock-bound on-pitch decider the pad cannot
  schedule; lots/next criteria stand in.*
- **RB2B-7 — A shoot-out-decided table match is a draw plus a bonus point in W/D/L**
  (FIH Pro League 4.2), and **turning shoot-outs on for a hockey table stage opens SO points
  fields seeded 2/1** (SC-P4/P5). Football's group split behaves the same. *Value: the D column
  and the points agree with the official table.*
- **RB2B-8 — Ice hockey table shows OTW / OTL** (ST-G16). *Value: two teams with the same W–L
  and different points show why.*
- **RB2B-11 — FIH cascade: points → wins → GD → GF → H2H → field goals → lots** (build a
  field-goals metric). Deviation: lots instead of FIH's ranking shoot-outs. *Value: a hockey
  pool ranks as FIH ranks it.*
- **RB2B-12 — Ice hockey: re-apply the H2H sub-group until ≤2 remain; add IIHF's
  partial-schedule order (fewest GP, GD, GF, seed) while mutual games are unplayed**
  (ST-G12). Deviation: skip IIHF steps 4–5 (results vs the next best-ranked team) → overall GD,
  GF, seed, lots. *Value: mid-tournament tables stop ranking a team above a rival it has not
  played.*
- **RB2B-17 — Chess Pts shown as 1 / ½ / 0 on every surface** (ST-G2) — a fix, not a
  deviation. *Value: "3½" is what every chess player expects to read.*
- **RB2B-18 — Chess table points editable per stage (1/½/0 or 3/1/0).** *Value: opens that use
  "football scoring" can run on Seazn.*
- **RB2B-19 — Chess round-robin default cascade: direct encounter → wins → Sonneborn-Berger
  (computed from pool results) → lots; Buchholz keys only in Swiss** (C.07 Art. 8 note). Build
  SB for non-Swiss stages. *Value: a club round-robin's tie-breaks actually break ties.*
- **RB2B-27 — Carrom table points 2/1/0 and cascade kept as product rules** (ICF silent).
  *Value: nothing changes for today's carrom tables.*
- **RB2B-30 — Confirm O8: division-level points / tiebreakers lock per stage once the stage's
  first fixture starts; stage-level editing before that; never per fixture.** *Value: every
  result in a table counts the same (ruling 12).*
- **RB2B-36 — Validate tiebreak keys against the sport at write** (ST-G10). *Value: a custom
  order never silently does nothing.*
- **RB2B-37 — API PointsRule: refuse a rule that cannot express the sport's scheme (ice hockey
  OT points) rather than flattening it** (SC-P10). *Value: an API user cannot lose the OT point
  silently.*

**Walkovers, retirements, abandonment**

- **RB2B-6 — Walkover scores per sport: football 3-0, hockey 5-0 (GTR 13.1 — change the
  default from 3), ice hockey 5-0 (product rule; IIHF Rule 66 sets none); any forfeit on a
  played match keeps the pitch score if worse for the offender (FDC Art. 28.1).** *Value:
  forfeits never improve the offender's goal difference.*
- **RB2B-13 — Abandonment: replay by default for every sport; FIH stages get the Q4 rule
  (abandoned in the 4th quarter → score stands); an abandonment settled with an outcome counts
  in the table** (ST-G1, SC-X4). *Value: a rained-off match either counts or is replayed —
  never silently dropped.*
- **RB2B-33 — Auto-advance treats an abandonment settled with an outcome as finished, and an
  unsettled one as a named blocker shown on the desk** (SC-X4). *Value: one rained-off,
  no-result match no longer freezes a group's automatic progression without saying why.*
- **RB2B-15 — Build a two-sided forfeit (double walkover) for all six sports: both lose,
  0 points, P+1 L+1; goal sports record no goals; bracket → both out, the next opponent
  advances.** Chess's existing `double_forfeit` switches from `no_result` to a loss for both.
  *Value: a both-no-show fixture can be closed and never blocks the stage (SC-S6).*
- **RB2B-21 — Chess forfeit recordable before a start event** (Art. 6.7.1). *Value: a no-show
  is one tap, not "start the game then forfeit it".*
- **RB2B-24 — Carrom walkover credits games 2–0 and 25–0 per awarded game** (product rule;
  ICF silent). *Value: a walkover never costs the winner on game/point ratio.*
- **RB2B-25 — Carrom and generic abandonment: replay by default, organiser may settle; shared
  points only as an explicit opt-in.** *Value: consistent with RB2B-13.*
- **RB2B-29 — Generic walkover 0–0 metrics, with an optional stage-level awarded score; the
  score cap enforced by the engine** (SC-O11). *Value: an import of 9999–0 cannot dominate a
  table.*

**Match format and entry**

- **RB2B-20 — Chess result/method cross-check in the engine** (SC-O10). *Value: the public
  page never prints "checkmate" on a draw.*
- **RB2B-26 — Carrom game-level result-only entry and a bounded adjustment** (SC-O6/O9).
  *Value: a paper result is typed once, not reconstructed board by board.*
- **RB2B-28 — Generic: draws on an allow-list (league/group/swiss); the pad hides Draw in
  brackets; the refusal names "enter the winner"** (SC-O2/O3). *Value: no stalled
  page-playoff and no advice about shoot-outs a generic sport does not have.*
- **RB2B-38 — Football shoot-out attempts configurable per stage (5; youth 3); remove the dead
  `shootout.suddenDeath` flag from hockey/ice hockey rather than honour a non-federation
  "end level" mode** (SC-P7). *Value: youth cups record their real shoot-outs.*
- **RB2B-39 — Result-only final-score entry for football / hockey / ice hockey** (SC-P12),
  folded through the same kernel. *Value: an after-the-day result is one entry, not ten taps;
  it is also the E2/E4 entry path the harness needs.*
- **RB2B-32 — Futsal (SC-P11, 🚫 no preset): build a minimal football variant** — 5-a-side,
  2 × 20, rolling subs, forfeit 5-0 (FDC 28.1) — **without** accumulated fouls. Not a new sport
  row (design §3). *Value: a futsal league starts from correct defaults instead of hand-tuning
  "small-sided".*

**Refusals and scope**

- **RB2B-22 — Team chess (SC-O12, 🚫): refuse in W2**; draughts and go keep the chess result
  vocabulary as a product rule. *Value: W2 stays on the input layer; team chess is a new
  entrant model, not a scoring fix.*
- **RB2B-31 — M11: a rules change on a started fixture is refused with a named reason** (today
  it is silently ignored by the V347 freeze). *Value: the organiser learns the change did not
  apply to the match in play.*
- **RB2B-34 — C4 retroactive forfeits across many fixtures (🚫 bulk action): refuse the bulk
  action in W2; each fixture is forfeited individually with the FDC-style score.** *Value: no
  one-click rewrite of a whole table; every change stays auditable.*
- **RB2B-35 — C5 points deduction (🚫, design §4): build**, as a stage-level deduction row with
  a reason shown on the table, owned by **W5** (table family). *Value: every federation here
  (FIFA, UEFA, FIH, IIHF) deducts points for conduct; organisers need it.*

**Count: 39 items (RB2B-1 … RB2B-39).**
