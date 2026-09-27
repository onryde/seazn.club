# Rulebook W2 — sport scoring fidelity: set sports and cricket

> **DRAFT — recommendations only; nothing here is an owner ruling until signed (_INDEX.md)**

- **Date:** 2026-09-27 · **Wave:** W2 (design §8), set-sport and cricket half. The goal-and-board half
  is `rulebook-W2-goals-boards.md`.
- **Sports:** badminton, table tennis, volleyball (the set-based kernel,
  `packages/engine/src/sports/setbased/kernel.ts`), tennis (the nested kernel,
  `packages/engine/src/sports/nested/kernel.ts`) and cricket (`packages/engine/src/sports/cricket/cricket.ts`).
- **Inputs read:** design §4, §5, §7.1–7.4 and the §8 W2 row; `_INDEX.md` rulings 1–21; `_RULES.md`;
  `W2-scoring-fidelity.md`; audits `SC-scoring.md` (SC-S1…S9, SC-C1…C8, SC-X1…X4), `ST-standings.md`
  (ST-G1, ST-G10, ST-G13, ST-G31), `plan-facts-sports.md`.
- **How the code facts were established:** by opening files at tree `92d2d1428` (= `main` `782628af5`
  plus docs). **Nothing was driven.** Every behavioural "product today" cell is a hypothesis for W2's truth
  run (`_RULES.md` R5; `AGENTS.md` class 5, "a read is not a run").
- **How the rules were established:** federation texts were downloaded and read where the host allowed it
  (marked **read**). Where only a search summary or a secondary source was reachable, the row says so
  (marked **summary** or **secondary**) and the text must be re-read before sign-off.
- **Why it matters now:** production is badminton only (design §1). Badminton therefore carries the
  largest customer risk in this half, and the badminton rules change on **4 January 2027** (RB2A-1).

Status legend in §6: **MATCH** = the engine does what the rule says · **DIFFERS** = it does something
else · **MISSING** = the rule needs a capability the product does not have.

---

## 0. Findings in one screen

1. **Walkover, retirement and withdrawal credit disagree across all four federations, and the product
   matches none of them.** BWF **deletes every result** of a player who fails to finish their group
   (GCR 16.2.5). ITTF credits the winner of an unplayed match **3–0, 11–0 each game** and counts a retired
   match's played points (Referee Handbook 2.3.7). FIVB scores a default **0–3, 0–25 each set** (Rule 6.4).
   ATP round robin counts a retirement or default as a **straight-set result with that match's games
   excluded** (ATP Rulebook 4.01 C.4). The product credits the winner full table points and **zero**
   sets, points and games, and keeps any partial score. This confirms SC-S3 and SC-S4, but it corrects
   their premise: no single "credit a straight-sets win" rule exists.
2. **All four set-sport default tiebreak cascades differ from their federation.** BWF uses head-to-head
   first for two tied, then games **difference** (not ratio). ITTF uses a mini-league among the tied, with
   an exclusion rule. FIVB ranks wins before match points. ATP puts head-to-head before set percentage for
   two tied. The engine has no set/point **difference** key and no ratio **mini-league** (confirms ST-G31
   and ST-G10).
3. **BWF moves to 3×15 on 4 January 2027**: games to 15, win by two from 14-all, cap 21. The editor can
   express it. No preset does, and the badminton default stays 21/30.
4. **Cricket:** ICC plays a **super over on every tie, including group matches** (T20I PC 16.3.1.1;
   T20 World Cup 2026 PC 16.3.1.2). That contradicts SC-C2's premise that ICC shares points on a league tie.
   SC-C2's gap still holds: the flag is division-wide and cannot be set per stage. ICC also names
   what happens to a knockout tie or no-result with no super over (16.10.5/16.10.6), and the product has no
   path for it (SC-C1).
5. **New, not in any audit:**
   - ICC charges a **defaulting team's NRR with its full quota** (T20WC 16.10.7). The product zeroes both sides.
   - ITF's short-set tie-break is **first to 5 with a deciding point at 4-all** (App VI §2). The product
     requires a two-point margin.
   - ITTF pays the loser of a **played** match 1 point and of an **unplayed** match 0 (3.7.5.1). The product
     pays 2/0 in both cases and cannot tell them apart.
   - ICC requires **10 overs** for a result in a semi-final or final, against 5 in the groups
     (T20WC 16.1.2). This is a stage-level setting that cricket cannot hold.
   - **Hypothesis NEW-H1:** a set-sport or tennis knockout match abandoned from the pad folds to
     `outcome: null`. `feederIsDead` (`stages.ts:3655-3658`) treats exactly that shape as a dead feeder, so
     the 2026-09-21 "stuck and visible" ruling may not hold for these five sports. Needs a truth run.

---

## 1. Authority and citations

| # | Source | Status | Sections used | URL |
|---|---|---|---|---|
| B1 | BWF Statutes 4.1 *Laws of Badminton* | summary (PDF refused to fetch: 403) | Law 7.1 (best of three games), 7.3 (21 points), 7.4 (20-all, two-point lead), 7.5 (29-all, 30th point wins), 7.6 (game winner serves first) | https://system.bwfbadminton.com/documents/folder_1_81/Statutes/CHAPTER-4---RULES-OF-THE-GAME/SECTION%204.1-%20Laws%20of%20Badminton.pdf · mirror https://www.worldbadminton.com/rules/ |
| B2 | BWF Statutes 5.1 *General Competition Regulations*, v6.0, in force 9 Nov 2024 | **read** | 13.6.2 (retiring in a team tie), 13.7 (no show → walkover), **16.2.1–16.2.5** (individual group ranking; deletion of all results), **16.3.1–16.3.8** (team group ranking; 16.3.8 incomplete match "as if completed without the conceding side scoring another point") | https://extranet.bwf.sport/docs/document-system/81/1466/1471/Section%205.1%20-%20General%20Competition%20Regulations%20-%209%20November%202024%20V6.0%20(1).pdf |
| B3 | BWF, 3×15 scoring approved at the 87th AGM, 25 Apr 2026. Effective **Mon 4 Jan 2027**: to 15, win by 2 from 14-all, cap 21 (20-all → next point), best of three, interval and change of ends at 8 | summary (bwfbadminton.com returned 403) | — | https://bwfbadminton.com/news-single/2026/04/25/bwf-members-approve-3x15-scoring-system · https://bwfbadminton.com/news-single/2026/04/26/key-changes-under-the-3x15-scoring-system · https://www.olympics.com/en/news/badminton-adopts-change-scoring-system-from-2027-3x15 |
| T1 | ITTF Statutes 2025 (effective 1 Jan 2025) | **read** | 2.11.1 (game to 11, 10-all two-point lead), 2.12.1 (best of any odd number of games), 2.15 (expedite), **3.7.5.1–3.7.5.4** (group ranking) | https://documents.ittf.sport/sites/default/files/public/2025-02/2025_ITTF_Statutes_clean_version.pdf |
| T2 | ITTF *Handbook for Tournament Referees*, 7th ed., Jan 2021 | **read** (third-party mirror) | **2.3.6** (a retired match keeps its played scores; worked example), **2.3.7** (the winner of an unplayed match is credited 3–0 / 4–0 and 11–0 each game; a partly played match keeps all points scored) | https://fctt.cat/wp-content/uploads/2025/07/7_Handbook-for-TOURNAMENT-REFEREES-ITTF-Gener-de-2021_ENG.pdf |
| V1 | FIVB *Official Volleyball Rules 2025–2028* | **read** | 6.2 (set to 25, two-point lead), 6.3.1 (three sets), 6.3.2 (5th set to 15), **6.4.1–6.4.3** (default 0–3 and 0–25 per set; an incomplete team keeps its points and sets, and the opponent is given what it needs), 7.1 (new toss for the deciding set) | https://www.fivb.com/wp-content/uploads/2025/01/FIVB-Volleyball_Rules2025_2028-EN-v05.pdf |
| V2 | FIVB *Official Beach Volleyball Rules 2025–2028* | summary | 6 (sets to 21, deciding 3rd set to 15, two-point lead; best of three) | https://www.fivb.com/wp-content/uploads/2025/02/FIVB-BeachVolleyball_Rules2025_2028-EN-v01.pdf |
| V3 | FIVB / Volleyball World competition ranking system (Men's Club World Championship 2022, an official FIVB event page) | **read** | victories first; then match points (3–0/3–1 → 3/0, 3–2 → 2/1, forfeit 0 with 25–0 ×3); then set ratio, point ratio, head-to-head | https://en.volleyballworld.com/volleyball/competitions/club-world-championship-men/2022/competition/ranking-system |
| V4 | VNL 2025 pool criteria (wins, match points, set quotient, point quotient, last match; 3+ tied at point quotient → only matches among them) | **secondary** (Wikipedia) | — | https://en.wikipedia.org/wiki/2025_FIVB_Men%27s_Volleyball_Nations_League |
| N1 | ITF *Rules of Tennis 2026* | **read** | Rule 5a (standard game, deuce/advantage), 5b (tie-break game to 7, two-point lead, serve order, receiver of the next set), 6a (advantage set), 6b (tie-break set at 6-all), 7 (best of 3 or 5), **App VI**: No-Ad; §1 short sets (to 4, two-game margin, tie-break at **4-all**, or at 3-all at the sanctioning body's discretion); **§2 short-set tie-break to 5 with a deciding point at 4-all**; §3/§4 match tie-break to 7/10 replacing the final set at one set all (or two sets all); §5 final-set tie-break to 10 at 6-all | https://www.itftennis.com/media/7221/2026-rules-of-tennis-english.pdf |
| N2 | *2026 ATP Official Rulebook*, IV World Championships: 4.01 Nitto ATP Finals – Singles, C. Round Robin 3)–6); 4.02 Doubles (MTB counts as one set and one game) | **read** | wins → matches played → head-to-head (2 tied) → 3 tied: % sets won → % games won → rankings → residual head-to-head; **4)** a conduct default or retirement counts as a straight-set win or loss, and the games of matches with the defaulting or retiring player are excluded from % games; **5)** a defaulted player is defaulted from all other RR matches | https://www.itftennis.com/media/15604/atp-2026-rulebook.pdf |
| C1 | *ICC Men's T20I Playing Conditions*, effective July 2025 | **read** | 16.1.2/16.1.3 (5 overs each to constitute a match; otherwise no result), 16.2 (match conceded or awarded), **16.3.1.1** (tie → super over, repeated until a winner; if impossible, tied), 16.4.1 (DLS revised target; one run less is a tie), 16.4.2 (DLS par at termination; equal to par is a tie), App F ¶11 (the side batting second bats first in the super over), ¶19 (and in each subsequent super over) | https://images.icc-cricket.com/image/upload/prd/qfnsie8fz6vhyl1pmcli.pdf |
| C2 | *ICC Men's T20 World Cup 2026 Playing Conditions* | **read** | 16.1.2/16.1.3 (**10 overs in semi-finals and final**), 16.3.1.2 (super over, unlimited), 16.5.1/16.5.3 (the match ends at the winning run; a boundary counts in full), **16.10.3** (points: win 2; tie, no result or abandoned 1; loss or forfeit 0), **16.10.4** (equal points → wins → NRR → head-to-head → ranking), **16.10.5** (semi-final tie with no completed super over, or no result → the group winner progresses), **16.10.6** (final: joint winners), **16.10.7** (NRR; all-out = full quota; super over excluded; only matches with a result; DLS credits; forfeit charges the defaulter 20 overs) | https://images.icc-cricket.com/image/upload/prd/igqt8cceiusrtat0ru5u.pdf |
| C3 | *ICC Men's ODI Playing Conditions*, July 2025 | summary (not opened) | 16.3.1 tie; super over per event regulations | https://images.icc-cricket.com/image/upload/prd/d25dbgishkx0kijb4jeu.pdf |

**Fast4.** Fast4 is a Tennis Australia brand, not an ITF term. The ITF recognises its parts in App VI: short
sets with a tie-break at 3-all (§1, alternative form), the short-set tie-break (§2) and No-Ad. This rulebook
treats "Fast4" as that combination.

---

## 2. Shared engine facts (read) — the set kernel, the nested kernel and the web seam

| Fact | Evidence |
|---|---|
| One write path: the pad at any band, device links, imports and v1 all fold through `appendEventInTx`. The coarse events (`game.summary`, `set.summary`, `set_summary`, `innings.summary`) fold through the same strict `apply` as rallies | `apps/web/src/server/engine-db/append-event.ts`; SC-scoring "Key facts" |
| The set predicate. A set is won at the cap, or at `setTo` with a `winBy` lead. A summary must be terminal, and the score one point earlier must still be live. The deciding set uses `finalSetTo` | `setbased/kernel.ts:447-449` (`setTarget`), `:454-468` (`setWinner`), `:474-489` (`reachableSetScore`), `:719-736` (strict check) |
| `bestOf` must be odd | `setbased/kernel.ts:128` |
| Set-sport table points: `pointsMap["W-L"]`, else `"*"`. A forfeit (`award`) pays the clean-sweep pair | `setbased/kernel.ts:2247-2258`, `:2451-2458` |
| Set-sport standings metrics are `sets_won`, `sets_lost`, `points_won` and `points_lost`, taken from what was actually played. A forfeit adds nothing | `setbased/kernel.ts:2260-2265` |
| Forfeit and retirement are the same event, `core.forfeit {by, reason}` → `award` to the opponent, with any completed sets left standing. Abandon → `phase: abandoned`, `outcome` stays null, `replayFlagged` | `setbased/kernel.ts:802-823`; `nested/kernel.ts:1375-1392`; `core/events.ts` `CoreForfeit` (single `by`) |
| The console's forfeit dialog pre-fills the reason "walkover", including for a retirement | `apps/web/src/components/v2/fixture-console.tsx:1398` |
| Draws are refused everywhere for both kernels | `setbased/kernel.ts:2469-2471`; `nested/kernel.ts:2223-2225` |
| Tennis standings metrics are `sets_won`, `sets_lost`, `games_won`, `games_lost` and `points_won`. There is **no `points_lost`**. A match tie-break set adds **0 games** | `nested/kernel.ts:2039-2050` |
| Tennis table points are `points.win`/`points.loss` for both `win` and `award` | `nested/kernel.ts:2197-2218` |
| Tiebreak keys: `points`, `wins`, `diff`/`for` (read only `gd`/`run_diff`/`diff` and `gf`/`runs_for`/`for`), `nrr`, `set_ratio`, `game_ratio`, `point_ratio`, `h2h_points`/`h2h_diff`/`h2h_for`, `seed`, `lots`. The h2h block builds a mini-table and compares it by **points/diff/for only**, so there is no mini-league ratio. Recursion (`h2hRecursive`) is off unless set, and web never sets it. There is **no set-difference or point-difference key** for the set sports | `competition/tiebreakers.ts:237-238, 332-366, 368-378, 414-462` |
| The cascade is division-level: `divisions.tiebreakers ?? module.defaultTiebreakers`. It has no UI and no validation against the sport | ST-G10; `engine-db/competition.ts:392` |
| Per-stage match rules exist for the four set sports only. They are locked once any fixture in the stage has a snapshot or events | `apps/web/src/lib/match-rules.ts:956-961`; `usecases/stage-rules.ts` |
| Config is frozen per fixture at its first event (V347). The stage deciders overlay (`shootout`, `extraTime`) has no UI writer and no cricket key | `append-event.ts:280,365` (SC audit); `engine-db/stage-cfg.ts:18` |
| The knockout guard refuses only `kind === "draw"`. `bracketWinnerLoser` returns `{}` for draw, tie and no_result | `append-event.ts:335-346`; `engine-db/competition.ts:151-164` |
| `abandoned` status maps to engine `void`, and void never reaches the standings fold | `apps/web/src/lib/fixture-engine-status.ts:17-19`; `packages/engine/src/competition/stage.ts:24` |
| League/group withdrawal expunges below 50% played, otherwise walks over the rest. Swiss never expunges | `packages/engine/src/competition/stage.ts:405-423`; `usecases/withdrawal.ts` |
| An abandoned knockout feeder **with no outcome** is dead, and one **with an outcome** stays stuck (owner ruling 2026-09-21) | `apps/web/src/server/usecases/stages.ts:3627-3658` |
| Table-points editor: only a sport whose config has a `points` object gets one (win/draw/loss concept keys). Set sports carry `pointsMap`, so badminton, TT and volleyball have **no table-points control**. Cricket `tie`/`noResult` are deliberately not editable (owner ruling R3.5, deferred) | `apps/web/src/components/v2/division-settings.tsx:230-278` |

---

## 3. Badminton

### 3.1 Authority
B1 (Laws), B2 (GCR 13, 16), B3 (3×15 from 4 Jan 2027).

### 3.2 Match rules

**Scoring model.** Rally point. A game goes to 21, with a two-point lead needed from 20-all and the 30th
point winning at 29-all (Law 7.3–7.5). A match is best of three games (Law 7.1). **From 4 Jan 2027 (B3):** to
15, two-point lead from 14-all, 21st point wins at 20-all, best of three.

**Legal game end scores (exhaustive).** The winner's score comes first.

| Rule set | Legal final scores |
|---|---|
| 3×21 (Laws today) | 21–0 … 21–19; 22–20, 23–21, …, 29–27, 30–28 (every n–(n−2) for 22 ≤ n ≤ 30); **30–29** |
| 3×15 (from 4 Jan 2027) | 15–0 … 15–13; 16–14, …, 21–19 (n–(n−2) for 16 ≤ n ≤ 21); **21–20** |
| product `short` variant (11, cap 15; not a BWF form) | 11–0 … 11–9; 12–10 … 15–13; 15–14 |
| **Illegal** (must be refused) | anything above the cap (31–29); a lead of more than two after the target (22–19, 25–21); a one-point win below the cap (21–20, 29–28); a score short of the target (20–18) |

**Match results:** 2–0 or 2–1. **Decider:** the third game, played under the same target (no separate
deciding-game target in either BWF rule set). No draws.

### 3.3 Outcome handling

| Outcome | What BWF says | Credit for standings |
|---|---|---|
| Walkover (no show) | The referee may declare a no show and award the match as a walkover (GCR 13.7) | **Individual group:** a player who does not complete all group matches has **all results deleted** (16.2.5). A no show is read here as not completing, so the question of walkover credit falls away for the absentee's whole group. **Knockout:** the opponent advances. **Team tie:** the match counts as if completed without the conceding side scoring another point (16.3.8) |
| Retirement | "Retiring during a match shall be considered to be not completing all group matches" (16.2.5) | **Individual group:** all the retiree's results are deleted. **Team tie:** 16.3.8 (the winner scores the remaining points, the retiree keeps its own) |
| Abandoned / unfinished | Not a ranking concept in GCR 16. The match is suspended and resumed or replayed by the referee | No table result until it is completed |
| Double walkover | Silent. Both players fail to complete ⇒ **16.2.5 deletes both** | Both deleted (individual). Team: ⬜ |
| Disqualification | 16.2.5 names disqualification explicitly | All results deleted |
| Withdrawal mid-event | 16.2.5 ("or withdrawal") | All results deleted, **whatever fraction was played** |

### 3.4 Table rules
Individual group play (GCR 16.2):
1. **Matches won** (16.2.1). There are no table points in the BWF text. A flat points map is equivalent.
2. Two tied → **the winner of their match** (16.2.2).
3. Three or more tied → **games difference** (won − lost), greater first (16.2.3). If that leaves two equal →
   their match (16.2.3.1).
4. Still three or more → **points difference** (16.2.4). If that leaves two equal → their match (16.2.4.1).
   Three or more still equal → **lots** (16.2.4.2).

Team group play (16.3) uses ties won, then the tie between two teams, then the differences in ties,
matches, games and points (each with a two-team head-to-head fallback), then lots. Team ties are not a
product capability (§3.6 row BD-12).

### 3.5 Settings organisers may change (ruling 12)

| Setting | Division | Stage (before its first fixture starts) | Fixture (before it starts) | Today |
|---|---|---|---|---|
| Game target, cap, win-by, best-of | ✅ | ✅ | ✅ (match format) | division ✅, stage ✅ (#804), fixture ❌ MISSING (`resolveFixtureCfg` takes no fixture input, design §5) |
| Table points (`pointsMap`) | ✅ | ✅ | **never** | **no UI anywhere** (`division-settings.tsx:272-278` reads `points`, badminton has `pointsMap`). Template or API only |
| Tiebreak order | ✅ | ✅ | **never** | division only, no UI, no validation (ST-G10) |
| Walkover/withdrawal policy | fixed by BWF 16.2.5 (recommend not a knob, RB2A-3) | — | — | product 50% rule, not configurable |
| Mid-match change | **refused** (M11) | | | the V347 freeze ignores it silently. No refusal message (§3.7 M11) |

### 3.6 Product today vs the rule

| ID | Rule | Product (file:line) | Verdict | Audit gap |
|---|---|---|---|---|
| BD-1 | Game to 21; two-point lead from 20-all; the 30th point wins at 29-all (Law 7.3–7.5) | `badminton.ts:21-26` + `setbased/kernel.ts:454-489` (cap ends the set; 30–28 and 30–29 reachable, 31–29 refused) | MATCH | "not a gap" row confirmed |
| BD-2 | Best of three games (Law 7.1) | `badminton.ts:22`; editor 1/3/5 (`match-rules.ts:213-222`) | MATCH | — |
| BD-3 | 3×15 from 4 Jan 2027 (B3) | No preset. Expressible by hand (setTo 11–30, cap 15–35; `match-rules.ts:227-250`) | MISSING | new |
| BD-4 | Only reachable game scores may be entered | `setbased/kernel.ts:728-736` (strict) | MATCH | — |
| BD-5 | No draws | `setbased/kernel.ts:2469-2471` | MATCH | — |
| BD-6 | Rank primarily by matches won (16.2.1) | `points` first with `{"*":[2,0]}`, then `wins` (`badminton.ts:28,56`). Equivalent while the map is flat | MATCH | ST-G31 (partly) |
| BD-7 | Two tied → their match (16.2.2) | `set_ratio`, then `point_ratio`, then `h2h_points` (`badminton.ts:56`) | DIFFERS | ST-G31 confirmed |
| BD-8 | 3+ tied → games **difference**, then points **difference**, with a two-player head-to-head fallback at each step (16.2.3–16.2.4) | overall **ratios**. No difference key exists for set sports, and h2h is last (`tiebreakers.ts:237-238, 343-349`) | DIFFERS | ST-G31, ST-G10 |
| BD-9 | Lots after everything (16.2.4.2) | no `lots` in the default. Residual → seed → UUID labelled "seeding" | MISSING | ST-G13 confirmed |
| BD-10 | Withdrawal, retirement, disqualification or no show in individual group play → **delete all that player's results** (16.2.5) | 50% expunge rule (`stage.ts:405-423`). Retirement = `award` keeping the partial score (`setbased/kernel.ts:804-814`). DQ is a status only (design R7) | DIFFERS | SC-S4 confirmed; SC-S3 premise corrected (BWF deletes, it does not credit 21–0) |
| BD-11 | A walkover stands only where 16.2.5 does not delete it (knockout; team 16.3.8) | `award`: clean-sweep table points, **0 games / 0 points** credited (`setbased/kernel.ts:2451-2458, 2260-2265`) | DIFFERS (a knockout has no ratios, so it bites only where a walkover stands in a table) | SC-S3 |
| BD-12 | Team tie ranking and incomplete-match credit (16.3, 16.3.8) | no team-tie aggregation (`tabletennis.ts:5-9` note: a stage-level feature not built) | MISSING | new |
| BD-13 | Retirement and walkover are different results (13.7 vs 16.2.5) | forfeit dialog pre-fills "walkover" for both (`fixture-console.tsx:1398`) | DIFFERS | SC-S4 |
| BD-14 | Double no show: both fail to complete | one `by` per forfeit (`core/events.ts` `CoreForfeit`). The kernel throws on `no_result` (`setbased/kernel.ts:2459-2463`) | MISSING | SC-S6 confirmed (read) |

**Tally — badminton: 5 MATCH · 5 DIFFERS · 4 MISSING.**

---

## 4. Table tennis

### 4.1 Authority
T1 (Statutes 2025: Laws 2.11–2.15, Regulations 3.7.5), T2 (Referee Handbook 2.3.6–2.3.7).

### 4.2 Match rules

**Scoring model.** A game goes to 11, with a two-point lead needed from 10-all and no cap (2.11.1). A match
is best of any odd number of games (2.12.1): best of 5 in most groups, best of 7 in finals. Expedite (2.15)
changes service, not scoring.

| Rule set | Legal final game scores |
|---|---|
| ITTF (2.11.1) | 11–0 … 11–9; 12–10, 13–11, … (every n–(n−2), n ≥ 12, unbounded) |
| product `hardbat-21` (not ITTF) | 21–0 … 21–19; n–(n−2), n ≥ 22 |
| **Illegal** | 11–10; 12–9; any one-point win; any lead above two past 11 |

**Match results:** best of 5 → 3–0, 3–1, 3–2; best of 7 → 4–0 … 4–3. No draws. No separate deciding-game
target.

### 4.3 Outcome handling (3.7.5.1; Referee Handbook 2.3.6–2.3.7)

| Outcome | Match points | Games / points credited |
|---|---|---|
| Played win / loss | winner 2, loser **1** | as played |
| Walkover (unplayed) | winner 2, loser **0** | winner credited **3–0 (4–0 in best of 7), 11–0 each game** (2.3.7) |
| Retirement (unfinished) | winner 2, loser **0** | **all points already scored count**, and the winner is given enough to decide the match. Example: retiring at 5–3 in the fifth game is recorded 11–7, 8–11, 11–6, 10–12, 11–5 (2.3.7) |
| Defaulted after completing a match | loser 0 | "recorded as a loss in an unplayed match" (3.7.5.1) |
| Double walkover | both 0 | ⬜ games credit (neither won). Recommend 0–0, excluded from ratios |
| Withdrawal | results already played **stand**. A retired player keeps the unfinished match in the table (2.3.6 worked example) | later matches are unplayed losses (0 MP; opponents credited 3–0) |

### 4.4 Table rules (3.7.5.1–3.7.5.4)
1. Match points (2/1/0 as above).
2. Equal match points → **only the matches between the tied players**, considering in turn match points,
   then **games ratio**, then **points ratio** (3.7.5.2).
3. **Exclusion:** once some tied players are placed, drop their matches and recompute the rest (3.7.5.3).
4. Lots (3.7.5.4).

### 4.5 Settings organisers may change
The same shape as badminton (§3.5). The match format (games to, best of) is set at division, stage or
fixture before start. There is no table-points UI today (`pointsMap`). Ruling 12 forbids per-fixture table
points.

### 4.6 Product today vs the rule

| ID | Rule | Product (file:line) | Verdict | Audit gap |
|---|---|---|---|---|
| TT-1 | Game to 11, two-point lead from 10-all, uncapped (2.11.1) | `tabletennis.ts:24-29`; kernel predicate | MATCH | — |
| TT-2 | Best of any odd number (2.12.1) | odd refine `setbased/kernel.ts:128`; editor 1/3/5/7 (`match-rules.ts:259-262`) | MATCH | — |
| TT-3 | Expedite does not change legal scores (2.15) | `records.expedite` flag only (`tabletennis.ts:37`) | MATCH | — |
| TT-4 | No draws | `setbased/kernel.ts:2469` | MATCH | — |
| TT-5 | Match points: win 2, played loss **1**, unplayed or unfinished loss **0** (3.7.5.1) | `{"*":[2,0]}` for both win and award (`tabletennis.ts:30`; `setbased/kernel.ts:2247-2258`). A `[2,1]` map would also pay the walkover loser 1 | DIFFERS | new |
| TT-6 | Rank primarily by match points | `points` first (`tabletennis.ts:57`) | MATCH | — |
| TT-7 | Ties → matches among the tied only: MP → games ratio → points ratio (3.7.5.2) | overall `wins`, `set_ratio`, `point_ratio`, then `h2h_points` last. The h2h block compares only points/diff/for (`tiebreakers.ts:376-378`) | DIFFERS | ST-G31 confirmed |
| TT-8 | Exclusion rule (3.7.5.3) | h2h recursion off (`tiebreakers.ts:456`; web never sets it, ST-G11) | MISSING | ST-G11 |
| TT-9 | Lots (3.7.5.4) | not in the default. Residual → seed → UUID | MISSING | ST-G13 |
| TT-10 | Walkover credited 3–0 / 11–0 (2.3.7) | 0 games / 0 points credited | DIFFERS | SC-S3 confirmed |
| TT-11 | Retirement: played points count and the winner is given what decides the match (2.3.7) | partial ledger only. The retiree can finish ahead on games | DIFFERS | SC-S4 confirmed |
| TT-12 | Defaulted after completion → loss in an unplayed match (3.7.5.1) | disqualification is a status only, with no fixture cascade | MISSING | design R7 |
| TT-13 | Withdrawal: played results stand (2.3.6) | expunged below 50% played (`stage.ts:423`) | DIFFERS | ST-G15 (related) |
| TT-14 | Double walkover: both lose an unplayed match (0 MP) | no path | MISSING | SC-S6 |

**Tally — table tennis: 5 MATCH · 5 DIFFERS · 4 MISSING.**

---

## 5. Volleyball (indoor; beach as a variant)

### 5.1 Authority
V1 (Rules 6.2–6.4, 7.1), V2 (beach 6), V3/V4 (pool ranking).

### 5.2 Match rules

**Scoring model.** Rally point. Sets 1–4 go to 25 with a two-point lead and no cap (6.2). The 5th set goes to
15 with a two-point lead (6.3.2). The match goes to the first to win three sets (6.3.1). The deciding set is
tossed afresh (7.1). **Beach (V2):** sets to 21, a deciding 3rd set to 15, two-point lead, best of three.

| Set | Legal final set scores |
|---|---|
| Indoor sets 1–4 | 25–0 … 25–23; 26–24, 27–25, … (n–(n−2), n ≥ 26) |
| Indoor set 5 | 15–0 … 15–13; 16–14, … (n–(n−2), n ≥ 16) |
| Beach sets 1–2 / set 3 | 21–0 … 21–19, n–(n−2) n ≥ 22 / 15–0 … 15–13, n–(n−2) n ≥ 16 |
| **Illegal** | 25–24; 26–23; a 5th set of 25–20; any one-point win |

**Match results:** 3–0, 3–1, 3–2 (beach 2–0, 2–1). No draws.

### 5.3 Outcome handling

| Outcome | Rule | Credit |
|---|---|---|
| Default (refusal to play, or not on court on time) | 6.4.1–6.4.2 | **0–3 for the match, 0–25 for each set.** Match points 3/0 (V3) |
| Incomplete team (injury, expulsion or disqualification leaving fewer than six) | 6.4.3 | loses the set or match. The opponent is given the points, or the points and sets, it needs. **The incomplete team keeps its points and sets** |
| Retirement | = incomplete team for the match (6.4.3) | as above |
| Abandoned / no result | not a rules concept (event regulations) | no table result until played |
| Double default | silent | ⬜ recommend both 0–3 losses with no match points and 0 credited |

### 5.4 Table rules (V3; V4 secondary)
1. **Number of matches won.**
2. **Match points:** 3–0 / 3–1 → 3 : 0; 3–2 → 2 : 1; forfeit → 3 : 0.
3. **Set ratio** (sets won ÷ sets lost).
4. **Point ratio** (points won ÷ points lost).
5. **Head-to-head** (the last match between the tied teams). V4: a 3+ tie at point ratio is ranked on the
   matches among the tied teams only (secondary source; re-read before sign-off).

FIVB defines match points for best of five only. Best-of-three indoor pool points are **not in the FIVB
text** (§5.6 VB-12 and RB2A-10).

### 5.5 Settings organisers may change
Match format (best-of, set target, deciding-set target) at division, stage or fixture before start
(`match-rules.ts:173-199`). The **FIVB points map is not editable in any UI.** Tiebreak order is
division-level with no UI.

### 5.6 Product today vs the rule

| ID | Rule | Product (file:line) | Verdict | Audit gap |
|---|---|---|---|---|
| VB-1 | Sets to 25, two-point lead, uncapped (6.2) | `volleyball.ts:33-37` | MATCH | — |
| VB-2 | 5th set to 15, two-point lead (6.3.2) | `finalSetTo: 15`; `setTarget` uses index bestOf−1 (`setbased/kernel.ts:447-449`) | MATCH | — |
| VB-3 | Match = three sets (6.3.1) | majority of bestOf 5 | MATCH | — |
| VB-4 | Beach 21/15, best of three (V2) | `beach` variant (`volleyball.ts:57-63`) | MATCH | — |
| VB-5 | Match points 3/0, 3/0, 2/1 (V3) | `FIVB_POINTS` (`volleyball.ts:11`) | MATCH | — |
| VB-6 | Forfeit 3 : 0 match points (V3) | clean-sweep pair `[3,0]` (`setbased/kernel.ts:2247-2249`) | MATCH | — |
| VB-7 | Default credited 0–3 and 0–25 ×3 (6.4.1) | 0 sets / 0 points credited | DIFFERS | SC-S3 confirmed |
| VB-8 | Incomplete team: the opponent is given what it needs; the incomplete team keeps its own (6.4.3) | partial ledger only | DIFFERS | SC-S4 confirmed |
| VB-9 | Wins **before** match points (V3, V4) | `points`, then `wins` (`volleyball.ts:97`). A team with 5 wins, all 3–2 (10 pts), ranks below 4 wins at 3–0 (12 pts); FIVB ranks it above | DIFFERS | ST-G31 confirmed |
| VB-10 | Set and point ratios as quotients | cross-multiplied, never divided (`tiebreakers.ts:293-327`) | MATCH | — |
| VB-11 | 3+ tie at point ratio → matches among the tied only (V4) | h2h block is points/diff/for only | MISSING | new |
| VB-12 | (FIVB silent) best-of-three indoor points | `"*"` pays 3–0 for a 2–1 win (`setbased/kernel.ts:2252-2256`). The editor guard is skipped when `"*"` exists | not counted (rule silent) → RB2A-10 | SC-S9 confirmed (read) |
| VB-13 | Double default | no path | MISSING | SC-S6 |
| VB-14 | No draws | `setbased/kernel.ts:2469` | MATCH | — |

**Tally — volleyball: 8 MATCH · 3 DIFFERS · 2 MISSING** (VB-12 is uncounted: the rule is silent).

---

## 6. Tennis

### 6.1 Authority
N1 (ITF Rules of Tennis 2026, Rules 5–7 and App VI), N2 (ATP Rulebook 2026, round robin 4.01 C, 4.02).
**The ITF does not regulate round-robin ranking.** The ATP Finals round robin is used here as the common
professional standard. Choosing it is itself an owner decision (RB2A-11).

### 6.2 Match rules

**Game.** 15/30/40/game, deuce and advantage (5a). No-Ad uses one deciding point at deuce (App VI).
**Tie-break game** to 7 with a two-point lead (5b). **Match** best of 3 or 5 (Rule 7).

| Set type | Legal final set scores (games; tie-break points in brackets) |
|---|---|
| Tie-break set (6b) | 6–0 … 6–4; 7–5; **7–6** with TB 7–0 … 7–5 or n–(n−2), n ≥ 8 |
| Advantage set (6a) | 6–0 … 6–4; n–(n−2), n ≥ 7 (8–6, 9–7, …) |
| Short set, TB at 4-all (App VI §1, the default form) | 4–0 … 4–2; 5–3; **5–4** with TB |
| Short set, TB at 3-all (App VI §1, the alternative; "Fast4") | 4–0 … 4–2; **4–3** with TB. 5–3 is **impossible** (3-all goes to the TB) |
| Short-set TB (App VI §2) | first to 5 with a deciding point at 4-all: 5–0 … **5–4** |
| Match tie-break (App VI §3/§4) replacing the final set at one set all (two sets all in best of 5) | to 7: 7–0 … 7–5, n–(n−2) n ≥ 8 · to 10: 10–0 … 10–8, n–(n−2) n ≥ 11 |
| Final-set TB to 10 at 6-all (App VI §5) | set 7–6 with TB 10–0 … 10–8 or n–(n−2), n ≥ 11 |
| **Illegal in any tie-break set** | 8–6, 9–7 (7–6 is terminal in a TB set); 7–7; 6–5 |

**Match results:** 2–0 or 2–1 (best of 3); 3–0, 3–1, 3–2 (best of 5). A match tie-break counts as a set.
No draws.

### 6.3 Outcome handling (N2, 4.01 C.4–C.6)

| Outcome | Rule | Credit |
|---|---|---|
| Retirement | "a conduct default or retirement shall count as a straight-set win or loss" | sets: the winner is credited 2–0 (3–0). **Games of every match with the retiring player are excluded from % games** |
| Conduct default | as retirement, **and the player is defaulted from all other RR matches** (C.5) | as above, for each remaining match |
| Walkover (no show) | not named. ⬜ recommend the same as a retirement | straight sets, games excluded |
| Withdrawal after the RR starts | "shall not be eligible for the single elimination competition" (C.6) | results stand. The player cannot qualify |
| Abandoned (rain) | not a result. The match resumes from the score | none until complete |
| Double walkover | silent | ⬜ recommend both losses, excluded from set/game percentages |

### 6.4 Table rules (N2, 4.01 C.3)
1. Most wins.
2. Most matches played (a 2–1 record beats 2–0).
3. Two tied → head-to-head.
4. Three tied → % sets won → % games won → ranking. At each step a single superior or inferior player
   leaves the other two to be settled by head-to-head.
   Doubles (4.02): **a won match tie-break counts as one set and one game.**

% won = won ÷ (won + lost). It orders entrants the same way as the product's won ÷ lost ratio, except
where both are 0.

### 6.5 Settings organisers may change
Best-of, set type (tie-break / advantage / Fast4), deciding set (same / MTB10 / MTB7 / TB10) and No-Ad
(`match-rules.ts:482-526`) at division, stage (#804) or fixture before start (fixture level ❌ today).
Table points win/loss are editable at division only (`division-settings.tsx:272-278`). No stage or fixture
points (ruling 12).

### 6.6 Product today vs the rule

| ID | Rule | Product (file:line) | Verdict | Audit gap |
|---|---|---|---|---|
| TN-1 | Standard game with deuce and advantage (5a) | `nested/kernel.ts:985-1003` | MATCH | — |
| TN-2 | No-Ad deciding point (App VI) | `game.noAd` (`nested/kernel.ts:994`) | MATCH | — |
| TN-3 | Tie-break to 7, two-point lead (5b) | `tbWinner`/`applyTbPoint` (`nested/kernel.ts:865-871, 1005-1044`) | MATCH | — |
| TN-4 | TB serve order; the first TB server receives the next set (5b) | `nested/kernel.ts:1012-1014, 1031-1038` | MATCH | — |
| TN-5 | Advantage set (6a) | `tiebreakAt: null` (`nested/kernel.ts:72`) | MATCH | — |
| TN-6 | Tie-break at 6-all (6b) | `nested/kernel.ts:969-977` | MATCH | — |
| TN-7 | In a TB set only 6–x (x ≤ 4), 7–5 and 7–6 are legal | the games-only summary accepts **8–6 and 9–7** (and 5–3 in Fast4). `wasLive` treats 7–6 as live (`nested/kernel.ts:1360-1367`) | DIFFERS | **SC-S1 confirmed (read)** |
| TN-8 | Best of 3 or 5 (Rule 7) | `bestOf`; editor 1/3/5 | MATCH | — |
| TN-9 | Short sets with the TB at **4-all** (App VI §1 default) | only the 3-all form is offered (`match-rules.ts:96-100`) | MISSING | new |
| TN-10 | Short-set TB: first to 5, **deciding point at 4-all** (App VI §2) | a single `tiebreak.winBy` (2) for every TB and MTB, so 5–4 is refused and 6–4 accepted (`nested/kernel.ts:1024`, `tennis.ts:24`) | DIFFERS | new |
| TN-11 | MTB replaces the final set at one set all (App VI §3/§4) | `finalSet.matchTiebreakTo` (`nested/kernel.ts:850-861, 935-945`) | MATCH | — |
| TN-12 | An MTB exists only at one set all / two sets all, so best of 1 has no MTB | best of 1 + MTB makes the only set an MTB (`isDecidingSet` true at 0–0, `nested/kernel.ts:850-853`). The editor offers the combination and #877's guard excludes tennis | DIFFERS | **SC-S2 confirmed (read)** |
| TN-13 | Final-set TB to 10 (App VI §5) | `finalSet.tiebreakTo` (`tennis.ts:32`) | MATCH | — |
| TN-14 | RR: wins → matches played → h2h (2 tied) → % sets → % games (N2 C.3) | `points`, `set_ratio`, `game_ratio`, `h2h_points`, `seed` (`tennis.ts:57`). h2h is last for two tied, and there is no matches-played key | DIFFERS | new (ST-G31 did not cover tennis) |
| TN-15 | Retirement or default = straight-set result, games excluded (C.4) | partial ledger. A leader who retires keeps its sets and games | DIFFERS | SC-S4 confirmed |
| TN-16 | A won MTB counts as one set **and one game** (4.02) | MTB counts as a set, **0 games** (`nested/kernel.ts:2042`) | DIFFERS | **SC-S5 confirmed.** Its source is the ATP Rulebook, not an "ITF convention" |
| TN-17 | Double walkover | no path | MISSING | SC-S6 |
| TN-18 | No draws | `nested/kernel.ts:2223-2225` | MATCH | — |

Not counted: **SC-S7** (no `points_lost`). No rule needs a point ratio in tennis. It is a validation defect
(ST-G10) and is handled by RB2A-15. **SC-S8** (award metrics untested) is a test gap. I did not re-verify it
by reading `setbased.test.ts`.

**Tally — tennis: 10 MATCH · 6 DIFFERS · 2 MISSING.**

---

## 7. Cricket

### 7.1 Authority
C1 (ICC T20I Playing Conditions, July 2025), C2 (ICC T20 World Cup 2026 Playing Conditions, the event
standard for points, NRR and knockouts), C3 (ODI, not opened). Community cricket follows no single code.
This rulebook takes **the ICC event standard (C2) as the federation default**. Community variants are
settings.

### 7.2 Match rules

**Scoring model.** Limited overs, one innings a side (the default). Two-innings play is supported as a
variant. A result needs both sides to have had the chance to bat **5 overs** (T20I), or **10 overs in a
semi-final or final** (C2 16.1.2). Otherwise it is a **no result** (16.1.3).

**Legal result states** (there are no "end scores"; these are the terminal conditions):

| Condition | Rule |
|---|---|
| Innings ends: all out (wickets = players − 1), quota of balls bowled, target reached, or declaration (multi-innings only) | Laws / 13.3 |
| The chase ends **at** the winning run. A boundary counts in full (16.5.1, 16.5.3), so the final chase total is at most **target − 1 + 7** (a no-ball plus six off the last needed run). Anything higher is impossible | C2 16.5 |
| Balls ≤ quota, wickets ≤ all-out, totals never decrease | Laws |
| Tie: equal scores with both innings complete (16.3.1.1) → **super over**, repeated until a winner. If impossible, tied | C1 16.3.1.1, C2 16.3.1.2 |
| Super over order: the side batting second bats first, then alternating (App F ¶11, ¶19) | C1 App F |
| DLS: revised target (one run less = tie); par at termination (equal = tie) | C1 16.4.1–16.4.2 |
| Draw: only multi-innings | — |

### 7.3 Outcome handling (C2 16.10.3, 16.10.7)

| Outcome | Table points | NRR |
|---|---|---|
| Win / loss | 2 / 0 | actual runs and overs. An all-out side is charged its full quota |
| Tie (super over impossible) | 1 / 1 | counts (a result) |
| No result / **abandoned** | 1 / 1 | excluded |
| Forfeit / refusal to play (16.2) | 2 / 0 | **the defaulting team is charged its full 20 overs; the winner's figures are unaffected** |
| DLS result at abandonment | as a win | Team 1 credited with **Team 2's par off Team 2's overs faced** |
| DLS applied earlier | as a win | Team 1 credited with **target − 1 off Team 2's allocated overs** |
| Knockout tie with no completed super over, or no result | — | semi-final: **the higher group finisher progresses** (16.10.5). Final: **joint winners** (16.10.6) |
| Double forfeit | silent | ⬜ recommend both 0 points, excluded from NRR |

### 7.4 Table rules (C2 16.10.4)
Points → wins → NRR → head-to-head → a pre-event ranking (seed). NRR = runs per over scored − runs per over
conceded, over the group stage (16.10.7). Only matches with a result count, and the super over is
excluded. Points and NRR are not carried from one stage to the next (16.10.2).

### 7.5 Settings organisers may change

| Setting | Division | Stage | Fixture (before start) | Today |
|---|---|---|---|---|
| Overs per innings, balls per over, players | ✅ | ✅ | ✅ | division only. Cricket is **not** in `STAGE_RULES_SPORTS` (`match-rules.ts:956-961`) |
| Minimum overs for a result | ✅ | ✅ (knockout 10 vs group 5) | ✅ | division only (`cricket.ts:73`) |
| Super over on a tie (and still-tied policy) | ✅ | ✅ **(this is the decider, design §5)** | ✗ (a decider, not match format) | division-wide flag (`cricket.ts:62-66`). No stage key (`stage-cfg.ts:18`) |
| DLS on/off | ✅ | ✅ | ✅ | division (Pro-gated at scoring, `scoring.ts:443-452`) |
| Table points win/tie/NR/loss | ✅ | ✅ | **never** | win/loss editable at division. Tie/NR not editable (deferred ruling in `division-settings.tsx:253-257`) |
| Knockout no-result rule (group position / seed / joint winners) | ✅ | ✅ | — | MISSING |

### 7.6 Product today vs the rule

| ID | Rule | Product (file:line) | Verdict | Audit gap |
|---|---|---|---|---|
| CR-1 | Points 2 / 1 (tie, NR) / 0 (C2 16.10.3) | `cricket.ts:53-61` | MATCH | — |
| CR-2 | **Abandoned / NR earns 1 point** (16.10.3) | the abandon fold gives `no_result`, but the status becomes `abandoned` → engine `void` → excluded (`append-event.ts:146`; `fixture-engine-status.ts:17-19`; `stage.ts:24`) | DIFFERS | **ST-G1 confirmed (read)** |
| CR-3 | Points → wins → NRR → h2h → ranking (16.10.4) | `cricket.ts:3961` | MATCH | — |
| CR-4 | NRR = aggregate runs/overs for − against (16.10.7) | integer ledger, cross-multiplied (`cricket.ts:3849-3882`; `tiebreakers.ts:309-317`) | MATCH | — |
| CR-5 | An all-out side is charged the full quota | `effectiveBalls` (`cricket.ts:3853-3858`) | MATCH | — |
| CR-6 | Super over excluded from NRR | `ledger` walks `state.innings` only | MATCH | — |
| CR-7 | Only matches with a result count for NRR | NR is zeroed (`cricket.ts:3937-3943`) | MATCH | — |
| CR-8 | DLS at abandonment: Team 1 = Team 2's par off Team 2's overs | Team 1's actual runs off its own balls (`cricket.ts:3864-3872` vs `:1150-1177`) | DIFFERS | **SC-C3 confirmed (read)** |
| CR-9 | DLS applied earlier: Team 1 = target − 1 off Team 2's allocated overs | Team 1's actual runs (`cricket.ts:3864-3872` vs `applyRevise :1070-1137`) | DIFFERS | SC-C3 |
| CR-10 | Forfeit: the defaulter is charged its full quota; the winner is unaffected | both ledgers zeroed (`cricket.ts:3916-3921`) | DIFFERS | **new** |
| CR-11 | Tie → super over in **every** match, repeated (C1 16.3.1.1) | `superOver: false` by default, so a tie stands at 1 pt each (`cricket.ts:62, 935-946`). "repeat" is supported (`:1870-1872`). The flag is division-wide only | DIFFERS | SC-C2 confirmed as a gap; **its premise "ICC league tie = shared" is false** |
| CR-12 | The side batting second bats first in the super over; alternate after (App F ¶11, ¶19) | `soBattingSideAt` (`cricket.ts:1754-1760`) | MATCH | — |
| CR-13 | 5 overs each for a result (16.1.2–16.1.3) | `minOversForResult: 5` checked on the chase at abandon (`cricket.ts:73, 1152-1161`) | MATCH (chase side; a first-innings abandonment → NR, also correct) | — |
| CR-14 | 10 overs in a semi-final or final (C2 16.1.2) | no stage-level setting | MISSING | new |
| CR-15 | DLS Standard Edition target and par (16.4) | `dls.ts` (`dlsTarget :153`, `dlsPar :165`) | MATCH (structure. The resource table's numbers are not re-verified here) | — |
| CR-16 | Semi-final tie or NR → the higher group finisher progresses (16.10.5) | the tie or NR commits and nobody advances (`append-event.ts:335-346`; `competition.ts:151-164`) | MISSING | **SC-C1 / SC-X1 confirmed (read)**, SC-X3 |
| CR-17 | Final tie or NR → joint winners (16.10.6) | no path (design Q4 🚫) | MISSING | new (design Q4) |
| CR-18 | A chase cannot pass the target except by the winning hit (16.5) | no overshoot check on the coarse summary (`cricket.ts:1661-1692`; auto-close `:1023-1038` keeps the runs) | MISSING | **SC-C4 confirmed (read)** |
| CR-19 | Draw only in multi-innings | `supportsDraws` (`cricket.ts:3964-3966`) | MATCH | — |
| CR-20 | NRR is runs **per over** | the display hardcodes 6 balls per over. Ranking is unaffected (`competition/display.ts:72`) | DIFFERS | SC-C7 |

Not counted: **SC-C5** (test gap; verified only by the absence of revise/DLS streams in the `standingsDelta`
calls listed by the audit, not re-read). **SC-C6** (coarse `boundaries` never collected) matters only under
`boundary_count`, a 2019 rule that C1 no longer uses. **SC-C8** (super over at band 3 only) is a pad/fidelity
item for W2's plan, not a rule.

**Tally — cricket: 10 MATCH · 6 DIFFERS · 4 MISSING.**

---

## 8. Edge-case table (design §4)

"Expected" is what this rulebook requires. It is **not** what the product does. BD = badminton, TT = table
tennis, VB = volleyball, TN = tennis, CR = cricket.

| Scenario | Set sports (BD / TT / VB / TN) | Cricket |
|---|---|---|
| **M1** walkover in one match | BD group: the absentee has not completed the group → **all its results deleted** (16.2.5); in a knockout the opponent advances. TT: winner 2 MP, absentee 0; games 3–0, points 11–0 ×3. VB: 3 : 0 MP; 0–3, 0–25 ×3. TN: straight-set win for set %; the match's games excluded | forfeit: winner 2, loser 0; defaulter's NRR charged its full quota with 0 runs; winner's NRR untouched |
| **M2** double walkover | BD: both results deleted (16.2.5). TT: both 0 MP, unplayed, no games. VB, TN: ⬜ (RB2A-6: both losses, excluded from ratios). Knockout: nobody advances, and the next-round opponent gets a walkover (RB2A-6) | ⬜ both 0 points, NRR excluded. Knockout as the set sports |
| **M3** retirement mid-match | BD group: retiree's results deleted; knockout: opponent advances. TT: played points stand, the winner is given what decides it, loser 0 MP. VB: 6.4.3 (the opponent is given what it needs; the retiree keeps its own). TN: straight-set result; games excluded | a team cannot retire; a refusal to play = forfeit (16.2) |
| **M4** abandoned / no result | no table result; resume from the score (suspend/resume) or replay. A knockout stays **stuck and visible** (owner ruling 2026-09-21) — **NEW-H1: may be read as a dead feeder today** | NR (below minimum overs) → 1 pt each, NRR excluded; DLS result above the minimum; must NOT become void (ST-G1) |
| **M5** draw in a stage that cannot end level | not reachable: no set sport can end level | a knockout tie → super over required. With it off → ⛔ refuse to commit a tie in a knockout and name the fix (RB2A-17) |
| **M6** tie → decider | n/a | super over, repeated until decided. If impossible: semi-final → higher group finisher, final → joint winners |
| **M7** void a decided result | before the next match starts: allowed, the table recomputes; after it starts: refused `NEXT_MATCH_STARTED` (owner ruling 2026-09-23, `append-event.ts:348-350`) | same |
| **M8** correct a finalized score | winner stays: sets, points and games recompute. VB 3–1 → 3–2 moves MP 3/0 → 2/1. Winner flips: points flip | winner stays: NRR recomputes; flips: points flip |
| **M9** organiser award | = the sport's walkover credit (M1) | = forfeit (M1) |
| **M10** disqualification mid-match | BD (black card): all results deleted (16.2.5). TT: loss as unplayed (3.7.5.1). VB: incomplete team (6.4.3). TN: default = straight-set loss **and defaulted from all remaining RR matches** (C.5). Today DQ is status only → ❌ (design R7) | awarded match (16.2); the defaulter is charged NRR |
| **M11** rules change attempted mid-match | ⛔ **refused with guidance** (ruling 12). Today the V347 freeze keeps the old rules but says nothing → ❌ until the refusal is explicit | same |
| **F5** two-way tie | BD: their match. TT: their match (mini-league of two). VB: wins → MP → set ratio → point ratio → their match. TN: their match | points → wins → NRR → their match |
| **F5** 3+-way tie | BD: games difference → points difference (h2h if it leaves two) → lots. TT: mini-league MP → games ratio → points ratio, with exclusion (3.7.5.3) → lots. VB: set ratio → point ratio → among the tied (V4). TN: % sets → % games (games of retirees excluded) → ranking/seed, h2h for a residual two | NRR → h2h → ranking/seed |
| **F6** everyone level | BD, TT: lots (16.2.4.2; 3.7.5.4). VB: ⬜ (lots not named; recommend lots). TN: ranking (seed) | ranking (seed); "all no results" → ranking (16.10.4 d) |
| **F7** falls through to lots | BD, TT, VB: a **lots** step, visibly labelled "drawn by lot". Today: seed → UUID labelled "seeding" (ST-G13) | seed is the federation's last step (a ranking), so lots is not needed |
| **C1** scores swapped home/away | the winner flips; per-sport points and ratios recompute | the batting order flips too: NRR recomputes |
| **C2** result on the wrong match | void both and re-enter; the sport credit follows the correct match | same |
| **C3** protest upheld: overturn / replay | overturn = M8; replay = void and reschedule | same |
| **C4** ineligible player → retroactive forfeits | each forfeited match takes the sport's walkover credit (M1). BD: disqualification deletes all results (16.2.5) | each = forfeit (points 2/0, defaulter's NRR charged) |
| **C5** points deduction | 🚫 today (design §4). No set-sport federation rule. Recommend build at stage level (RB2A-28) | 🚫 today. Deductions exist in ICC event regulations (not cited here) |
| **C6** late correction after the stage completes | reopen, recompute, re-rank; progression consequences are owned by W4/W5 | recompute NRR and qualification |
| **C7** result annulled weeks later | = void (M7) after the stage completes; the table recomputes | same |
| **R4** withdrawal mid-event | BD: **all results deleted, whatever fraction played** (16.2.5). TT: played results stand, and the rest are unplayed losses (0 MP; opponents 3–0 / 11–0). VB: ⬜ (event regulations). TN: results stand; the player is ineligible for the knockout (C.6) | ⬜ ICC event regulations not cited; recommend results stand, the rest forfeited |
| **R14** retires from one match, plays the next | BD: retiring = not completing → all deleted even if they play on (16.2.5). TT: allowed, results stand. TN: may continue if the doctor approves; that match's games are excluded (C.4) | n/a |
| **X1/X4** weather: resume vs replay | resume from the saved score (`core.suspend`/`core.resume`); the match format frozen at the first event stays | a rain-reduced match → DLS revise; abandoned → M4 |
| **X3** fixture-level format override before start | allowed: best-of, set target and cap (e.g. a final at best of 1) | allowed: overs per innings |

---

## 9. Items for the owner

Every item is a **recommendation**, with what an organiser or player sees. None is a ruling until signed in
`_INDEX.md`.

### 9.1 Scoring and presets

- **RB2A-1 — BWF 3×15 from 4 January 2027 (time-sensitive).** Add a `bwf-3x15` variant now: 15, win by 2,
  cap 21, best of 3. **Make it the default for badminton divisions created on or after 2027-01-04.** Keep
  `bwf` (3×21) selectable. Existing divisions keep their frozen config. *Owner value:* a club running a
  January league gets today's legal scores without hand-tuning three fields. Today a 21–20 game (legal under
  3×15) is refused as unreachable under 3×21.
- **RB2A-12 — Tennis short sets.**
  - Offer both ITF forms: "Short sets (TB at 4–4)", the App VI default, and "Short sets, TB at 3–3
    (Fast4)".
  - Give the short-set tie-break its App VI §2 deciding point at 4-all, which needs a per-tiebreak
    `winBy`, separate from the MTB.
  - Refuse 5–3 in the 3–3 form.

  *Owner value:* a Fast4 night records a 5–4 tie-break instead of being forced to 6–4.
- **RB2A-13 — Tennis best of 1 + match tie-break: refuse the combination in the editor** (an #877-style
  guard extended to tennis), with the copy "A match tie-break replaces a deciding set; best of 1 has none."
  *Owner value:* no division silently plays every match as a 10-point tie-break (SC-S2).
- **RB2A-7 — Table tennis points 2/1/0.** Adopt ITTF 3.7.5.1 as the table-tennis default: win 2, **played**
  loss 1, unplayed or unfinished loss 0. This needs the kernel to pay a different loser value for `award`
  than for `win`. *Owner value:* an ITTF-run league's points column matches the official sheet, and a no-show
  costs the absentee a point against a player who turned up and lost.
- **RB2A-10 — Volleyball best of 3 indoor (FIVB silent).** Recommend the default `{"2-1":[2,1], "*":[3,0]}`
  when a stage or division moves to best of 3 on the FIVB map. Extend the `pointsMap` guard to fire even when
  `"*"` exists (fixes SC-S9). *Owner value:* a best-of-3 group does not pay full points for a 2–1 win unless
  the organiser chose that.

### 9.2 Walkover, retirement, withdrawal, disqualification

- **RB2A-3 — Adopt the federation rule per sport, declared by the sport module, not an organiser knob.**
  - **Badminton:** in individual group play, a withdrawal, retirement, disqualification or no show
    **deletes all that player's results** (GCR 16.2.5). This replaces the 50% rule for badminton group
    stages.
  - **Table tennis:** results stand, and later matches are unplayed losses.
  - **Tennis:** results stand; the player is ineligible for the knockout.
  - **Other sports:** keep the product's 50% rule until their rulebook says otherwise.

  *Owner value:* a badminton group decided after a mid-event injury reads the way the referee's sheet reads.
  This is the **largest table change in production today** (badminton only), so it needs an explicit yes.
  *Alternative:* keep 50% everywhere and record badminton as a deliberate deviation.
- **RB2A-4 — Walkover credit per sport (SC-S3).**
  - TT: 3–0 / 4–0 games, 11–0 each game.
  - VB: 0–3 and 0–25 ×3.
  - TN: straight sets for set %, with the match's games excluded from game %.
  - BD knockout: 2–0 in games, with points ⬜. Recommend 21–0 ×2 as the ITTF-style analogue: BWF is silent
    once 16.2.5 deletes group results.

  Pin each with a reference-model oracle (R8, R9). *Owner value:* a team that wins by walkover is not
  dragged down on set or point ratio.
- **RB2A-5 — Retirement credit per sport (SC-S4), and "Retired" as its own choice.**
  - TT: played points count, and the winner is given what decides the match.
  - VB: 6.4.3.
  - TN: straight sets, games excluded.
  - BD: deletion (RB2A-3).

  The console must ask **Walkover / Retired / Disqualified** instead of pre-filling "walkover"
  (`fixture-console.tsx:1398`). *Owner value:* a player who retires while leading can no longer finish
  ahead on ratio. Public results say "ret." rather than "w/o".
- **RB2A-6 — Double walkover (SC-S6): build.**
  - Add a both-sides forfeit outcome.
  - Round robin: both take an unplayed loss (TT 0 MP) with nothing credited. BD: both deleted.
  - Knockout: nobody advances, and the next-round opponent receives a walkover.
  - Swiss consumes this outcome in W3 (SW-M9).

  *Owner value:* a fixture where nobody turned up can be closed. Today it blocks stage completion.
- **RB2A-16 — Disqualification cascade** (design R7 is the scenario; the sport consequences are here):
  - BD: all results deleted.
  - TT: that match an unplayed loss.
  - TN: defaulted from all remaining RR matches.
  - VB: incomplete team.

  This is a build. The routing wave is W2 for the outcome and W5 for the roster cascade (recommend).

### 9.3 Tables and tiebreaks

- **RB2A-2 — Federation default cascades.** The engine needs new keys for this: `set_diff`, `point_diff`, a
  `h2h_two` ("head-to-head when exactly two are tied") and a ratio mini-league block with exclusion.
  - **Badminton:** wins → h2h_two → set_diff → h2h_two → point_diff → h2h_two → lots.
  - **Table tennis:** points → mini-league (points → set ratio → point ratio, recursive exclusion) → lots.
  - **Volleyball:** wins → points → set_ratio → point_ratio → h2h.
  - **Tennis:** see RB2A-11.

  **Apply the new defaults to new divisions only**: snapshot the default into `divisions.tiebreakers` at
  creation. A live table must never reorder under an organiser mid-event. *Owner value:* a federation-run
  event can be published without a manual override. *Alternative:* keep the current defaults and label them
  "Seazn standard".
- **RB2A-11 — Tennis round-robin standard.** Adopt the ATP Finals order: wins → matches played → h2h_two →
  % sets → % games → seed, with a two-player residual h2h. **Count a won MTB as one game** (ATP 4.02; fixes
  SC-S5). The ITF has no RR rule, so this is a product choice citing ATP. *Owner value:* club round robins
  rank like the tour event players know.
- **RB2A-9 — Lots at the end of every set-sport cascade** (ST-G13). Show "drawn by lot" in the popover, and
  record the draw (seeded RNG, stored) so a reload does not reshuffle. *Owner value:* no table claims
  "ahead on seeding" for unseeded players.
- **RB2A-15 — Validate a custom cascade against the sport** (ST-G10). Refuse keys the sport does not emit:
  `nrr` outside cricket, `point_ratio` in tennis (SC-S7), `diff` in set sports. The refusal names the key.
  *Owner value:* no ∞ column and no silent no-op tiebreak.
- **RB2A-25 — Lock table points and tiebreakers per stage once its first fixture starts** (design O8).
  Recommend confirming. Editing a division's points is refused for started stages with "This stage has
  started; points and tie-breaks are fixed for it." Unstarted stages still take the change. *Owner value:*
  every result in a table counts the same (ruling 12).
- **RB2A-27 — Never per-fixture table points or tiebreakers; M11 refuses explicitly.** Confirm ruling 12's
  consequence. A mid-match rules edit is refused with a message; today it is silently ignored by the V347
  freeze.

### 9.4 Cricket

- **RB2A-17 — Knockout tie or no result (SC-C1, SC-X1, SC-X3): build ICC 16.10.5/16.10.6.** Add a stage-level
  "if a knockout match ends tied without a super over, or with no result" setting:
  - options: **higher group finisher (or higher seed) advances** (default, ICC), **decide by lot** (a
    first-class event that records it), **joint winners** (final only);
  - never commit a tie or NR that seats nobody.

  *Owner value:* a rained-off semi-final resolves the way the ICC does, instead of "TBD" forever.
- **RB2A-18 — Super over as a stage decider (SC-C2).**
  - Move `superOver` into the stage deciders overlay, with a screen (design O5).
  - Defaults: **knockout stages ON; league/group OFF**, the community norm, plus an "ICC: every tied match"
    option.
  - Record that SC-C2's premise was false: under ICC T20 conditions, group ties do go to a super over.

  *Owner value:* "super over in the knockouts only" does exactly that.
- **RB2A-19 — Count abandoned/no-result matches (ST-G1).** An `abandoned` fixture whose fold produced an
  outcome must reach the table (1 point each, NR column). *Owner value:* a washed-out match gives both
  teams their point, as in every cricket table.
- **RB2A-20 — DLS NRR credit (SC-C3).** Adopt 16.10.7: at abandonment, Team 1 = par off Team 2's overs; with
  DLS applied earlier, Team 1 = target − 1 off Team 2's allocated overs. *Owner value:* a rain-hit table
  matches the official ICC method.
- **RB2A-21 — Forfeit NRR (new).** Adopt 16.10.7: the defaulter is charged its full quota (0 runs off its
  balls), and the winner is unaffected. *Owner value:* forfeiting cannot protect a team's NRR.
- **RB2A-22 — Chase overshoot (SC-C4).** Refuse a coarse chase total above **target − 1 + 7**, with "A chase
  ends at the winning run — check the total". *Owner value:* one mistyped over total cannot inflate two
  teams' NRR all season.
- **RB2A-23 — Cricket per-stage rules** (overs, balls per over, minimum overs for a result, super over, DLS).
  Add cricket to per-stage rules (ruling 12). A knockout's 10-over minimum (C2 16.1.2) needs it. *Owner
  value:* a shorter group phase and a full-length final in one division.
- **RB2A-24 — Cricket tie/NR table points editable** (the deferred R3.5 follow-up), at division and stage,
  with help copy. Ruling 12 puts table points at stage level.
- **RB2A-26 — Hundred / 5-ball overs:** display NRR per the division's `ballsPerOver`, and make "overs per
  innings" multiply by `ballsPerOver` (SC-C7). Low priority.

### 9.5 Hypotheses and 🚫 items (build or refuse)

- **RB2A-29 — NEW-H1: a set-sport or tennis knockout abandon may walk the opponent through.** `core.abandon`
  leaves `outcome: null` in both kernels (`setbased/kernel.ts:818-823`, `nested/kernel.ts:1387-1392`).
  `feederIsDead` treats `abandoned` + null outcome as dead (`stages.ts:3655-3658`). The owner ruling of
  2026-09-21 says a rained-off match must stay stuck and visible. **Recommend:** reproduce it in W2's truth run.
  If it holds, distinguish a scorer's abandon from a generator void, for example by a flag on the fixture.
  Record it in "False premises found" if it does not reproduce.
- **RB2A-28 — 🚫 C5 points deduction: build** as a stage-level signed adjustment with a reason, shown on the
  table ("−2, conduct"). Design §4 lists it 🚫 because `carry_deltas` is API-only and `FORMAT_LOCKED` once
  fixtures exist. The owning wave is W5 (round-robin). This rulebook only states that no set-sport or cricket
  rule prevents it.
- **RB2A-30 — 🚫 Q4 final not played → joint winners: build for cricket** as part of RB2A-17 (ICC 16.10.6).
  For the set sports, recommend **refuse** with guidance ("replay or record a walkover"): no BWF, ITTF, FIVB
  or ATP rule declares joint winners.
- **RB2A-31 — 🚫 "Decide an abandoned knockout by lot / higher seed" (SC-X3): build** as one first-class
  event shared by every sport, recorded on the fixture ("advanced on higher group position" / "on lot").
  The fake-walkover workaround is **refused** from then on, because it corrupts the walkover credit of
  RB2A-4.
- **RB2A-32 — 🚫 BD team ties (GCR 16.3):** refuse for now with guidance ("run each rubber as its own
  division, or use generic"). Build only if a customer asks. No production usage today.
- **D1, D2, D4, R13** (design 🚫 list): no set-sport or cricket rule bears on them. They are left to
  W4/W5's format rulebooks.

**Owner items: 30 numbered recommendations (RB2A-1 … RB2A-32; RB2A-8 and RB2A-14 were folded into RB2A-2
and RB2A-11).**

---

## 10. Audit gaps: confirmed, corrected, not re-verified

| Gap | Verdict here |
|---|---|
| SC-S1, S2, S6, S9 | confirmed by read |
| SC-S3 | the gap is confirmed (0 credited). **Premise corrected:** BWF deletes (16.2.5) rather than crediting 21–0; tennis (ATP) counts straight sets with games excluded, not 6–0 6–0. TT and VB credit as claimed |
| SC-S4 | confirmed; the correct target differs per federation (§0.1) |
| SC-S5 | confirmed. **Source corrected:** ATP Rulebook 4.02, not an "ITF convention" |
| SC-S7 | the metric absence is confirmed. It is recast as a validation gap (RB2A-15), not a missing metric |
| SC-S8, SC-C5 | test gaps. Not re-verified by reading the tests |
| SC-C1, C3, C4, C7 | confirmed by read |
| SC-C2 | the gap is confirmed (division-wide). **Premise false:** ICC plays a super over on group ties too (T20I 16.3.1.1) |
| ST-G1 | confirmed by read for cricket |
| ST-G10, ST-G13, ST-G31 | confirmed. ST-G31's BWF/ITTF/FIVB claims match the texts read |
| New | CR-10 forfeit NRR; TN-9/TN-10 short sets; TT-5 ITTF 2/1/0; BD-3 3×15; BD-10 BWF deletion; CR-14 knockout minimum overs; VB-11 FIVB 3+ mini-league; NEW-H1 (hypothesis) |

**Totals (§6 rows): badminton 5/5/4 · table tennis 5/5/4 · volleyball 8/3/2 · tennis 10/6/2 · cricket
10/6/4 (MATCH/DIFFERS/MISSING).**
