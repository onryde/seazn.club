# Rulebook W3 — Swiss (swiss, swiss_playoff, swiss_knockout × 11 sports)

> **DRAFT — recommendations only; nothing here is an owner ruling until signed (_INDEX.md)**

- **Date:** 2026-09-27 · **Wave:** W3 (design §8) · **Rows:** `swiss`, `swiss_playoff`
  (swiss → page_playoff, top 4), `swiss_knockout` (swiss → knockout, top q) × football,
  cricket, boardgame, carrom, generic, volleyball, badminton, tabletennis, tennis,
  icehockey, hockey = **33 cells**.
- **Inputs read:** design §4, §5, §7.1–7.4, §8; `_INDEX.md` rulings 1–21; `_RULES.md`;
  `audit-2026-09-27/SW-swiss.md`, `ST-standings.md` (ST-G21), `SC-scoring.md` (SC-O7);
  issues #846, #838.
- **How the code facts below were established:** by opening the file at the tree
  `c427e972d` (= `main` `782628af5` + docs). **Nothing was driven.** A "read" is not a
  "run" (`AGENTS.md` class 5): every behavioural row in §8 is a hypothesis for W3's
  truth run (`_RULES.md` R5).
- **Why it matters now:** production Swiss is 9 divisions / 73 played fixtures, all
  **badminton** (design §1). The chess rules below are the authority for the format.
  Badminton is the sport customers use today.

---

## 1. Authority and citations

| # | Source | Sections used | URL |
|---|---|---|---|
| A1 | FIDE Handbook C.04.1 *Basic rules for Swiss Systems* (in force from 1 Feb 2026) | rule 2 (no rematch), 3 (pairing-allocated bye = win points, no colour), 4 (bye eligibility, which excludes players who scored a win's points without playing), 5 (same-score pairing, "in general"), 6 (colour difference within ±2), 7 (never the same colour three times in a row), 8 (colour preference) | https://handbook.fide.com/chapter/C0401202507 |
| A2 | FIDE Handbook C.04.2 *General handling rules for Swiss Tournaments* (from 1 Feb 2026) | 2.1–2.3 (TPN order: rating, title, alphabetical; frozen after round 4 is paired), 2.4 (late entries score **0** for missed rounds unless the tournament rules say otherwise), 3.2 (withdrawn players are no longer paired), 3.3 (a known absence is not paired and scores 0), **3.4 (only played games count for colour)**, **3.5 (two paired participants who did not play may be paired again)**, 4.3 (a correction after the next round is paired affects only later pairings), 4.4 (published pairings are not changed, with narrow exceptions) | https://handbook.fide.com/chapter/GeneralHandlingRulesForSwissTournaments202602 |
| A3 | FIDE Handbook C.04.3 *FIDE (Dutch) System* (from 1 Feb 2026) | absolute criteria **[C1]** no rematch, **[C2]** bye eligibility, **[C3]** non-topscorers with the same *absolute* colour preference do not meet; completion **[C4]**; quality criteria **[C5]–[C21]** (C5 lowest-scored bye receiver, C6–C8 fewest and lowest downfloaters, C9 bye receiver with the fewest unplayed games, C10–C13 colour, C14–C21 floats); colour preference definitions (absolute: difference > +1 or < −1, or the same colour twice running; strong ±1; mild 0); topscorer (> 50% of the maximum score when pairing the final round); art. 5.1 initial colour by lot; art. 5.2 colour allocation order | https://handbook.fide.com/chapter/C0403202602 |
| A4 | FIDE Handbook C.07 *Play-Off and Tie-Break Regulations* (from **1 March 2026**; replaces the 1 Aug 2024 – 28 Feb 2026 text) | 4.1 organiser chooses an ordered list (no mandated default), 4.2 lots once the list is exhausted, 6 direct encounter, 7.1 wins ("with or without playing"), 7.3 games with Black, 7.5 progressive, 7.7 **Standard Points**, 8.1 Buchholz, 9.1 Sonneborn-Berger, 14 modifiers (Cut-1/-2, Median-1/-2), **16 unplayed rounds** (below) | https://handbook.fide.com/chapter/TieBreakRegulations032026 |
| A5 | FIDE C.07, 1 Aug 2024 – 28 Feb 2026 (superseded, kept for comparison) | same art. 16 structure | https://handbook.fide.com/chapter/TieBreakRegulations082024 |
| A6 | FIDE Tie-Break Regulations before 1 Sep 2023 (superseded) | 15.2 **virtual opponent** `Svon = SPR + (1 − SfPR) + 0.5·(n − R)`. This is the model the engine comments cite. | https://handbook.fide.com/chapter/tiebreakregulationspre2023 |
| A7 | UEFA Champions League 2025/26 regulations, league phase (a Swiss-type league phase), art. 18. **Criteria list was read from a secondary source (Wikipedia).** Re-read the primary text before sign-off. | 1 GD, 2 GF, 3 away GF, 4 wins, 5 away wins, **6 opponents' collective points**, 7 opponents' collective GD, 8 opponents' collective GF, 9 disciplinary, 10 coefficient. **No head-to-head.** | https://documents.uefa.com/r/Regulations-of-the-UEFA-Champions-League-2025/26/Article-17-Match-system-league-phase-Online · https://en.wikipedia.org/wiki/2025%E2%80%9326_UEFA_Champions_League_league_phase |
| A8 | Round-count bounds (Swiss-system literature; the "safe" bound is my derivation, not a federation rule) | minimum ⌈log₂ n⌉ rounds, so that at most one perfect score survives; natural upper bound about n/2 | https://en.wikipedia.org/wiki/Swiss-system_tournament |

**Current C.07 art. 16 (A4), which this rulebook adopts:**

- **16.1** A *requested bye* is a half-point or zero-point bye. *"Any round after a
  participant withdraws is a zero-point-bye."* A **VUR** (voluntary unplayed round) is a
  requested bye or a forfeit loss.
- **16.2** Five categories: (1) pairing-allocated or full-point byes; (2) forfeit wins;
  (3) requested byes followed by at least one round that is not a VUR; (4) forfeit
  losses; (5) requested byes followed only by VURs, or in the last round.
- **16.3 (the participant as someone else's opponent).** Categories 1–4 are evaluated at
  the result their points correspond to. **Category 5 is evaluated as draws.**
- **16.4 (the participant's own tie-break).** Each unplayed round is scored against a
  **dummy whose score is the participant's own score**, capped at (16.4.1) the scheduled
  opponent's adjusted score for forfeits, or (16.4.2) *draw points × rounds* for every
  other unplayed round.
- **16.5.1** A Cut-1 on a participant with VURs cuts the lowest VUR contribution, provided
  that contribution is not below the least significant value.

**The pre-2023 "virtual opponent" (A6) is superseded.** The engine header
(`tiebreakers.ts:59-63`) calls it "C.07 2023". Neither label nor formula matches the
current text (§8 row T2).

**Where no federation governs.** No federation publishes a Swiss standard for football,
cricket, carrom, generic, the set sports, or hockey. Ruling 11 therefore makes the
**product rule** the authority for those sports:

- The pairing rules (§2) are FIDE's, sport-neutral.
- Round count (§3) and byes (§4) follow FIDE, scaled to the sport's table points.
- The tie-break chains (§5) follow the UEFA league-phase precedent (A7): own scoring
  first, opponents' strength second, and **no head-to-head early**, because in a Swiss
  the tied entrants usually never met.

---

## 2. Pairing rules the product must meet

### 2.1 Absolute (hard legality — a violation is always ❌)

| ID | Rule | Authority | Scope |
|---|---|---|---|
| P-A1 | Two entrants meet **at most once** in a Swiss stage. | A1 r.2, A3 [C1] | all sports |
| P-A2 | A pair whose match was **not played** (a one-sided walkover, a double walkover, a forfeit before play) **has not met**, so the two may be paired again. | A2 3.5 | all sports (**deviation question RB3-2**: today's product treats it as met) |
| P-A3 | Each round seats **every active entrant exactly once**, as a board or as the bye. There is **exactly one bye iff the active field is odd**, and none otherwise. | A1 r.3 | all |
| P-A4 | An entrant receives the pairing-allocated bye **at most once**, and **never after scoring a win's points without playing** (a walkover win). | A1 r.4, A3 [C2] | all |
| P-A5 | (Chess colours on) After the round, colour difference ∈ [−2, +2], and no entrant has the same colour three times running. Two non-topscorers with the same absolute colour preference do not meet. Only played games count toward colour. | A1 r.6–7, A3 [C3], A2 3.4 | boardgame when `chess` is on (RB3-10 recommends ON by default for boardgame) |
| P-A6 | **Completion.** If a pairing satisfying P-A1…P-A5 exists for the round, the product produces one. If none exists, the product **refuses with a named reason**. It never returns an empty or partial round as success (§3.3). | A3 [C4]; design §7.3 "nothing ends stuck"; `_RULES.md` R13 | all |
| P-A7 | Withdrawn, disqualified and deleted entrants are **not paired** in any round paired after the event. | A2 3.2 | all |

### 2.2 Preference (quality — tolerated by the reference, not asserted)

| ID | Preference | Authority | Product today |
|---|---|---|---|
| P-Q1 | Pair within score groups; floats are few and low-scored. | A1 r.5, A3 [C6]–[C8] | backtracking within groups with bounded floats (`swiss.ts:250-277`) |
| P-Q2 | The bye goes to the **lowest-scored** eligible entrant (then lowest-ranked) **whose removal leaves a pairable remainder**. | A3 [C5], [C9] | lowest eligible in pairing order, never retried (`swiss.ts:162-178`; SW-L3) |
| P-Q3 | Round 1 (seeded): top half against bottom half (S1[i] v S2[i]; 1v5, 2v6 … for 8). | A3 (bracket S1/S2) | "fold" gives exactly this (`swiss.ts:196`, foldIdx = ⌊len/2⌋). **MATCH.** |
| P-Q4 | Rounds ≥ 2: FIDE fold within the score group. The `swiss_playoff`/`swiss_knockout` templates use **rank-adjacent** pairing (1v2, 3v4) from round 2. This is a deliberate deviation (RB3-12). | A3 | `format-templates.ts:205,230` |
| P-Q5 | Colour preferences (A3 art. 5.2 order; initial colour by lot, art. 5.1); avoid repeated floats ([C14]–[C21]). | A3 | approximate (`swiss.ts:299-331`); upper board takes White when neutral, no lot |
| P-Q6 | Non-chess home/away alternates where the sport cares about home or serve. | product | stronger side always home (SW-L5) |

### 2.3 What the reference model checks (design §7.2 — legality plus existence, not a second pairing engine)

**Checked exactly, on every paired round of every case:**

1. P-A1, P-A3, P-A4, P-A7 on the seated round, against the round history the reference
   folds itself.
2. P-A5 when chess colours are on. Colour compatibility is *pairwise*: a pair is legal
   iff one of the two colour assignments satisfies both entrants' limits. So the
   compatibility graph stays a plain graph.
3. **Existence (P-A6).** Build the compatibility graph over the active field (edges =
   pairs legal under P-A1/P-A2/P-A5). For an odd field, for each bye-eligible entrant,
   delete it and test for a perfect matching.
   - If the product **paired** the round: assert legality.
   - If the product **refused**: assert that no candidate yields a perfect matching, and
     that the refusal names the reason.
   - If the product returned an **empty or partial round as success**: ❌ (SW-H1).
4. **Bye choice (P-Q2's hard core).** Assert that **no eligible entrant with a strictly
   lower score** exists whose removal leaves a pairable remainder. This is decidable
   with the same matching oracle. It is exact, because A3 [C5] is a *minimisation*
   criterion that outranks every other quality criterion.
5. **Round 1 with explicit seeds and no prior history** is fully determined. Assert the
   exact boards for the stage's effective mode: fold → S1[i] v S2[i];
   rank_adjacent → 1v2, 3v4 (the round-1 default is fold, #844).
6. Anti-vacuity (design §7.3a): each check records the number of boards, byes and
   candidate matchings it examined. **Zero boards on a round the stage owes is a
   failure.**

**Tolerated (not asserted):** score-group homogeneity beyond the bye rule, float choice,
colour *preferences*, transposition order, and the rank-adjacent vs fold choice from
round 2.

**Bound (W3 sets it — recommendation RB3-24):**

- Existence is checked by Edmonds' blossom matching. That is polynomial, so it covers
  every harness field **n ≤ 128**.
- A brute-force backtracking cross-check of the oracle itself runs for **n ≤ 12**.
- No look-ahead across future rounds is modelled. FIDE defines none. Multi-round
  pairability is handled by the round cap (§3).

---

## 3. Round count

### 3.1 Bounds (n = active field at the time of pairing)

| Quantity | Value | Why |
|---|---|---|
| **Minimum meaningful** | ⌈log₂ n⌉ | Fewer rounds leave two or more perfect scores that never met (A8). |
| **Safe maximum** (a rematch-free round is **guaranteed** whatever was paired before) | ⌊n/2⌋ | Dirac's theorem (my derivation, not a federation rule). After r−1 rounds each entrant has met at most r−1 others, so the "not yet met" graph has minimum degree ≥ n−r. For r ≤ n/2 it is Hamiltonian, so it has a perfect matching (odd n: apply the same argument to the n−1 non-bye entrants). **Not guaranteed with chess colour limits.** |
| **Hard maximum** (a legal Swiss **cannot exist** beyond it) | **n − 1 for even n; n for odd n** | Even n: after n−1 rounds everyone has met everyone. Odd n: every round needs a bye and nobody may have two (P-A4), so at most n rounds. |

**Correction to the brief and to SW-H1:** "rounds ≥ field size → impossible" is exact
for **even** fields only. For an odd field, n rounds is feasible, with every entrant
taking the bye once. The impossibility starts at n+1. SW-H1's example (4 × 5) is even
and does hold.

**Audit probe (engine only, SW-swiss.md) against these bounds:** 6 × 5 (builder default)
dead-ends in 15.5% of events. 5 exceeds the safe maximum of 3 and is within the hard
maximum of 5. All 0% cases (4×3, 5×5, 6×3, 7×5, 8×5, 10×5, 12×5, 8×3) are within the hard
maximum. 6×3 and 8×3 are within the safe maximum.

### 3.2 Recommended rounds per field size (RB3-3)

**Default** = `min(band(n), safeMax(n))`. The band is the owner's existing table in
`apps/web/src/lib/swiss-rounds.ts` (≤8 → 3, ≤16 → 4, ≤32 → 5, ≤64 → 6, beyond → 7). It
equals ⌈log₂ n⌉ for 5 ≤ n ≤ 128.

| n | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9–16 | 17–32 | 33–64 | 65+ |
|---|---|---|---|---|---|---|---|---|---|---|---|
| band | 3 | 3 | 3 | 3 | 3 | 3 | 3 | 4 | 5 | 6 | 7 |
| safe max ⌊n/2⌋ | 1 | 1 | 2 | 2 | 3 | 3 | 4 | 4–8 | 8–16 | … | … |
| hard max | 1 | 3 | 3 | 5 | 5 | 7 | 7 | … | … | … | … |
| **recommended default** | 1 | 1 | 2 | 2 | 3 | 3 | 3 | 4 | 5 | 6 | 7 |

- **Organiser may choose** any value from 1 to the hard maximum. The builder's current
  `max=15` is replaced by the field-derived hard maximum when the field is known.
- **Between the safe and the hard maximum:** allowed, with a plain warning that a round
  may become unpairable and what happens then (§3.3).
- **Above the hard maximum:** refused, with the reason named. The check runs at stage
  creation when the field is known, **again at Start and at every Generate** (the field
  can shrink after creation).
- For n = 3 and 4, the band's 3 rounds happen to be always pairable without chess
  colours (K₄ splits into 3 perfect matchings; 3 players rotate the bye). The owner may
  keep 3 there. See RB3-3.

### 3.3 When no legal pairing exists (SW-H1)

**The rule:** Pair next **never** reports success on an empty or partial round, and
never shows "Nothing new to generate — fixtures are up to date". It refuses with a
named reason, writes nothing (not even the bye), and offers the recovery.

**Proposed refusal copy** (4 locales owed):

> "Round N can't be paired: every remaining pairing would repeat a match already played
> [or: break the colour limits]. You can finish the Swiss after round N−1 (standings
> are final as they stand), or reduce the number of rounds."

**Recommended recovery actions (RB3-4):**

- **(a) "Finish the Swiss now".** This is X2: cancel the unpaired shells, complete the
  stage, and use standings as of the last complete round. Today it is 🚫 (§9).
- **(b) Reduce rounds.** Only through the stage setting (§7).
- **(c) "Allow one repeat pairing this round".** **Not recommended.** It breaks P-A1,
  which the reference asserts everywhere.

**Prevention (recommendation):**

- The default cap (§3.2).
- **When the organiser chose rounds above the safe maximum**, a one-round look-ahead:
  among legal pairings, prefer one after which the *next* round is still pairable (one
  blossom check per candidate). It is not a FIDE criterion, so the reference does not
  assert it.
- A different bye when the first choice leaves no pairing (P-Q2; SW-L3).

---

## 4. Byes, walkovers, withdrawals, late entries

Points are written in the stage's **table points** (the sport's points rule, or the
stage override). "Win points" means the table's `win` value. For chess that is 1
(2 half-points).

| Event | Own table points | Own tie-break card (own Buchholz, SB) | As an opponent in others' Buchholz / SB | Pairing effects |
|---|---|---|---|---|
| **Pairing-allocated bye** | **win points** (A1 r.3). **No for/against/diff and no forfeit score**; it is not a forfeit. | Unplayed, cat. 16.2.1: dummy score = **own final score**, capped at draw points × rounds (16.4.2). Scored as a win in SB. | Counts at its awarded result: a win (16.3.1), i.e. their actual score. | No colour (A1 r.3, A2 3.4). Never a second bye (P-A4). |
| **Half- or zero-point requested bye** | ½ win or 0 | cat. 16.2.3 or 16.2.5 | 16.2.5 evaluated as a draw (16.3.2) | **Not a product feature today (🚫).** RB3-7 |
| **Walkover, one side absent (M1)** | Winner: win points **via the sport's walkover credit** (the set/point credit is owned by W2, SC-S*). Loser: loss points (0 in chess). | Winner: forfeit win, 16.2.2, dummy = own score, capped at the absent opponent's adjusted score (16.4.1). Loser: forfeit loss, 16.2.4, a VUR. | Evaluated at the awarded result (16.3.1). | **Not met** (P-A2, A2 3.5). No colour for either (A2 3.4). The winner may not later take the bye (P-A4). |
| **Double walkover (M2)** | Both: loss points (0). Neither side is credited a win. | Both: forfeit loss, 16.2.4. | Evaluated as losses (16.3.1). | Not met. No colour. **Both remain bye-eligible** (neither scored a win's points without playing). The round counts as **decided**, so it must not block Pair next. The engine outcome is owned by W2 (SC-S6); its Swiss handling is W3's (SW-M9). |
| **Retirement mid-match (M3)** | Sport's retirement result (W2). A played game. | Played game | Played game | **Met.** Colour counts (the game was played). |
| **Withdrawal between rounds (R4)** | Results stand; **Swiss never expunges** (the product rule 2026-09-24 matches A2 3.2). | Later rounds = **zero-point byes** (16.1.1 note), category 16.2.5 | **Stays in the table and in every opponent's Buchholz**. Its post-withdrawal rounds count as **draws** there (16.3.2, the "adjusted score"). | Not paired again (P-A7). The field shrinks, so a bye appears or disappears. |
| **Withdrawal with a paired, undecided board** | That board is a **walkover to the opponent** (today's cascade, `withdrawal.ts:106-114`). Then as above. | forfeit loss (VUR) + later zero-point byes | as above | as above |
| **Late entry after Start (R2)** | **0 for each missed round** (A2 2.4, "unless the rules of the tournament say otherwise"). The organiser may set ½ per missed round as a house rule (RB3-13). | Missed rounds are zero-point byes before the first played round: category **16.2.3** (followed by non-VUR rounds), evaluated at 0 for opponents | — | Joins from the next unpaired round. TPN is provisional (A2 2.5). **Refused today (SW-L7, 🚫).** |
| **Disqualification (R7)** | Recommended: a withdrawal from that moment (future boards walk over). Retroactive annulment is a separate, explicit C4 action (RB3-17). | as withdrawal | as withdrawal | not paired again |

**The withdrawn entrant in opponents' Buchholz — explicit rule:** the entrant **remains
in the ledger for the rest of the stage**. Each opponent they met adds the entrant's
**adjusted** final score. That is their real score plus a draw's points for every round
after withdrawal (16.3.2). A withdrawn entrant never disappears from a Buchholz sum, and
never contributes only their frozen score. Today the entrant stays (`competition.ts:360-366`
builds the entrant set from fixtures) but without the adjustment (§8 T3).

**Non-chess scaling (fixes SW-L2):**

- The dummy cap "draw points × rounds" is read from the table's draw value.
- For a sport with no draw, the cap uses **½ × win points × rounds**, i.e. the
  Standard-Points midpoint (A4 7.7).
- "Rounds" means the **stage's rounds** as declared, or as cut short by X2. It is never
  the length of the entrant's own card.

---

## 5. Tie-break chains

A tied entrant pair in a Swiss usually never met. A chain that reaches head-to-head
early is therefore deciding ties by an empty comparison (SW-H4). All chains below are the
**default for a `swiss` stage** (stage-kind-aware, RB3-8). The organiser may reorder them
at stage level (ruling 12). Buchholz and Sonneborn-Berger apply the §4 unplayed-round
rules.

| Family (sports) | Proposed default chain | Basis |
|---|---|---|
| **Chess** (boardgame) | points → **Buchholz Cut-1** → Buchholz → Sonneborn-Berger → direct encounter → wins (with or without playing, A4 7.1) → lots | FIDE mandates no default (A4 4.1). This is the chain the engine already ships (`boardgame.ts:350-358`) and the common arbiter practice. Lots last (A4 4.2). |
| **Set sports** (badminton, table tennis, volleyball) | points → Buchholz Cut-1 → Buchholz → set ratio → point ratio → direct encounter → lots | UEFA shape (A7): own strength and schedule strength first, h2h late. Buchholz is on table points. |
| **Tennis** | points → Buchholz Cut-1 → Buchholz → set ratio → game ratio → direct encounter → lots | as above, with games in place of rally points |
| **Goals** (football, hockey, ice hockey) | points → goal difference → goals for → wins → **Buchholz** (opponents' collective points) → opponents' collective GD → direct encounter → lots | **UEFA CL league phase, art. 18 order (A7)**, minus away and disciplinary criteria and the coefficient, plus direct and lots |
| **Cricket** | points → wins → NRR → Buchholz Cut-1 → Buchholz → direct encounter → lots | NRR is cricket's universal second key (ICC playing conditions for group stages). Buchholz is placed after it because NRR already reflects margin. |
| **Carrom** | points → Buchholz Cut-1 → Buchholz → set ratio → board ratio → point ratio → direct encounter → lots | product rule (no federation Swiss) |
| **Generic** | points → Buchholz Cut-1 → Buchholz → diff → for → direct encounter → lots | product rule |

**New keys the chains need** (MISSING in `module.ts:40-59`): `opp_diff` (opponents'
collective goal difference), for the goals family. Optional, not in any default above:
`progressive` (A4 7.5), `median1` (A4 14.3).

**Buchholz basis for non-chess = table points** (UEFA criterion 6). The pairing score
groups use the **same table points** (fixes SW-M11), so the published table, the score
groups and the tie-breaks all read one number.

---

## 6. Swiss → playoff / knockout cut

1. **Qualifiers** = the top q of the **final** Swiss ranking under the stage's chain
   (§5): page playoff top 4, knockout top q. Seeding in the next stage is by Swiss rank.
2. **A tie across the cut line**, or a tie between two seeds that changes the bracket
   position:
   - First, the full chain *without* `lots`.
   - If still tied, the tie is **flagged** and the organiser must resolve it before
     confirm. There are two ways to resolve: a pick, or a **visible drawing of lots**
     recorded as a rank lock with its seed.
   - It is never silently confirmed on seed or id order. Today's
     `SEEDING_TIE_UNRESOLVED` guard (`stages.ts:5048-5065`) and the `tieUnbroken` marker
     on a lots class (`tiebreakers.ts:589-596`) implement exactly this. **MATCH, keep it.**
   - A play-off game (A4 play-off section) is not offered. Recommendation RB3-18: keep
     it out.
3. **A qualifier withdraws before the bracket's first match starts**, or a confirmed
   qualifier withdraws: follow the W4 rulebook (Q2, promote-next vs walkover). The
   Swiss side does not change.
4. **Correction after the cut is confirmed (Q1):**
   - If no bracket match has started: the proposal is stale, so re-propose, and the
     organiser re-confirms (FX-G16, W4 owns the fix).
   - If a bracket match has started: the Swiss standings update, the bracket stands, and
     the desk shows a warning naming the changed cut (A2 4.3 analogue). Owner item
     RB3-19.

---

## 7. Settings organisers may change, and at which level (ruling 12)

| Setting | Division | **Stage** (before the stage's first fixture **starts**) | Fixture (before it starts) | Mid-match |
|---|---|---|---|---|
| **Rounds** | — | ✅ **per stage** (#838, see below) | — | refused |
| Pairing mode round 1 (fold / rank_adjacent) | — | ✅ stored mode; plus the existing per-press round-1 override (#844) | — | — |
| Pairing mode rounds ≥ 2 | — | ✅ stage setting only; per-press refused (422 today, keep) | — | — |
| Chess colour rules (`chess`) | — | ✅ default **on** for boardgame, off otherwise (RB3-10) | — | — |
| Pairing-allocated bye value | — | ✅ win (default, FIDE) / draw / zero, if RB3-7 wires `byeScore` | — | — |
| Requested half/zero-point byes | — | — | per round, per entrant, before that round is paired (if built, RB3-7) | — |
| Tie-break chain | as fallback | ✅ (§5) | **never** | — |
| Table points (win/draw/loss/forfeit) | as fallback | ✅ | **never** | — |
| Cut size q / playoff kind | — | ✅ on the bracket stage | — | — |
| Match format (games, sets, overs, halves) | ✅ | ✅ (W2) | ✅ (W2, before start) | refused (M11) |
| Manual board swap (rounds ≥ 2) | — | — | 🚫 (SW-L12): recommend ⛔ with guidance "Unpair, then Pair next" (RB3-25) | — |

**#838 (O7) — recommendation for the owner to confirm here:** ruling 12 answers #838 as
**per stage**. Round count is a stage setting like every other.

- **Freeze point.** It stays editable until the stage's first fixture **starts**. That
  is issue option (b), evidence of play, *not* "fixtures exist". **Empty shells minted by
  Generate do not freeze it** (today they do, `stages.ts:512-518`, SW-M10).
- **After the first fixture has started**, only two explicit actions change the count:
  - "Finish the Swiss after round k" (X2)
  - "Add a round", allowed while the new total ≤ the hard maximum (§3.1) and the final
    round is not yet paired.
- Both are logged, undoable only while nothing in the affected rounds is seated.
- **Until W3 builds them**, the refusal names the recovery (#838 Task 3.0).

---

## 8. Product today vs the rule

Legend: **MATCH** (the product does what the rule says) · **DIFFERS** (it does something
else) · **MISSING** (no behaviour at all). "Read" = file opened. "Grep" = located only.
**Nothing below was driven** (R5).

### Pairing

| # | Rule | Product today (file:line) | Verdict | Gap | Verified |
|---|---|---|---|---|---|
| P1 | P-A1 no rematch | `swiss.ts:187-188` `hardLegal` excludes `played` pairs | MATCH | — | read |
| P2 | P-A2 unplayed pair may meet again | a two-sided award is added to `played` (`stages.ts:1128-1130`; commit 14c5095f2) | DIFFERS | NEW-3 (deliberate; RB3-2) | read |
| P3 | P-A3 exactly one bye iff odd | `swiss.ts:166-178`; bye row seated at `stages.ts:1284-1300` | MATCH | — | read |
| P4 | P-A4 one bye max; a walkover winner is ineligible | `stages.ts:1121-1127,1145` (`byes.add` for bye and award winner) | MATCH | — | read |
| P5 | P-A4 when every entrant has had a bye → refuse | `swiss.ts:168` falls back to the lowest entrant, **a second bye** | DIFFERS | NEW-2 | read |
| P6 | P-A5 chess colour limits | enforced in `swiss.ts:84-88,181-186` **only if** `cfg.chess`, and nothing but the API writes it (`stages.ts:1196`; `schemas.ts:1019`; not in `swiss11.json`, the builder or the templates) | MISSING (no path to switch on) | **SW-H3 confirmed** | read + grep |
| P7 | P-A5 topscorer exception in the final round (A3 [C3]) | not modelled; stricter than FIDE | DIFFERS | NEW-4 (low) | read |
| P8 | P-Q5 colour allocation; initial colour by lot | neutral → upper board White (`swiss.ts:325`) | DIFFERS | SW-H3 family | read |
| P9 | A2 3.4 only played games count for colour | `stages.ts:1134-1139` skips awards | MATCH | — | read |
| P10 | P-A6 existence: pairs whenever a legal pairing exists | complete within one group; multi-group search bounded (`swiss.ts:141,263`, `BUDGET` 200k at `:228`); no bye retry (`:162-178`) | DIFFERS | SW-L3, SW-L4 | read (+ audit run) |
| P11 | P-A6 no pairing → named refusal | `swiss.ts:280-283` returns `pairings: []`; `swissGen` seats only the bye and returns success (`stages.ts:1265-1300`); desk shows "nothing new" (`stages-panel.tsx:608-610`) | MISSING | **SW-H1 confirmed** | read |
| P12 | P-Q3 round 1 top half v bottom half | fold, foldIdx = ⌊len/2⌋ (`swiss.ts:196`) | MATCH | — | read |
| P13 | Pairing score = table points | hard-coded win/award 1, draw 0.5, bye 1 (`stages.ts:1122-1150`) | DIFFERS | **SW-M11 confirmed** | read |
| P14 | Ad-hoc fixture never credits a bye | implicit-bye loop runs to `latestSeatedSwissRound`, which includes an ad-hoc `maxRound+1` round (`stages.ts:1152-1178`, `:5761`; `swiss-shell.ts:124-131`) | DIFFERS | **#846 / SW-M3 confirmed by read** (not reproduced) | read |
| P15 | Unseeded round-1 order (A2 2.1: rating, title, alphabetical) | registration order (SW-L6) | DIFFERS | SW-L6 | audit (not re-read) |

### Round count

| # | Rule | Product today | Verdict | Gap | Verified |
|---|---|---|---|---|---|
| RC1 | Default from field size (§3.2) | builder default 5, `min 1, max 15` (`division-builder.tsx:290,849-853`); the band table has **no production caller**, only tests and one e2e (`swiss-rounds.ts`) | DIFFERS | **SW-H2 confirmed** | read + grep |
| RC2 | Refuse above the hard maximum | `assertSwissRoundsDeclared` checks only integer ≥ 1 (`stages.ts:350-358`) | MISSING | SW-H2 | read |
| RC3 | Rounds per stage, editable until the first fixture starts | `FORMAT_LOCKED` once any fixture, including empty shells, exists (`stages.ts:512-518`) | DIFFERS | **SW-M10 confirmed**; #838 | read |
| RC4 | "Finish the Swiss now" (X2) | no action; `/complete` with shells pending returns `completed:false` | MISSING | new (🚫) | audit plan-facts |

### Byes, walkovers, withdrawals, entry

| # | Rule | Product today | Verdict | Gap | Verified |
|---|---|---|---|---|---|
| B1 | Bye = win points, no for/against | `awardByeDelta` (`competition.ts:87-116`) goes through `applyPointsRule`. With a custom rule's `forfeit`, the bye gets `forfeit.winnerPoints` **plus `awardScore` into for/against/diff** (`points.ts:133,145-151`) | DIFFERS | **SW-M6 confirmed** | read |
| B2 | Bye value frozen when awarded | bye seat writes no `config_snapshot` (`stages.ts:1287-1297`); resolved from live config (`competition.ts:344-350`) | DIFFERS | **SW-M7 confirmed** | read |
| B3 | Bye value setting (`byeScore`) | declared (`boardgame.ts:52`), read by nothing | MISSING | SW-M8 = SC-O7. **Downgrade:** at its default (a win) the product is **FIDE-correct** (A1 r.3). The gap is only a house-rule half-point bye. | read |
| B4 | Requested half/zero-point byes | none | MISSING | new (🚫) | grep |
| B5 | Double walkover decided, not blocking | no double-forfeit outcome; an abandoned board is not `DECIDED` (`stages.ts:979`) and blocks Pair next | MISSING | **SW-M9 confirmed** (W2 owns the outcome) | read |
| B6 | Withdrawal: results stand, board walks over, not re-paired | `withdrawal.ts:4-8,106-114`; Swiss in `TABLE_KINDS` without expunge | MATCH | — | read |
| B7 | Withdrawn entrant stays in opponents' Buchholz | the entrant set comes from fixtures (`competition.ts:360-366`) | MATCH | — | read |
| B8 | Late entry after Start (0 for missed rounds) | enrolment locked when `active`, except ladder/americano (`entrants.ts:300-312`) | MISSING | SW-L7 (🚫) | read |
| B9 | Bye shells not placed on courts or printed | pre-pairing bye shell is `scheduled` and placeable; the sheet prints TBD v TBD | DIFFERS | SW-M13, SH-G16 | audit (not re-read) |
| B10 | Undo Pair next clears the round's seats | seated ids go to `seated_fixture_ids` (`stages.ts:2392`), which nothing reads (`stages.ts:2726`); the `fixtures_generated` undo executor is a no-op (`history.ts:574-577`) | DIFFERS | **SW-M2 confirmed** | read |

### Tie-breaks and display

| # | Rule | Product today | Verdict | Gap | Verified |
|---|---|---|---|---|---|
| T1 | Chess default chain (§5) | `boardgame.ts:350-358`: points, BH-C1, BH, SB, direct, wins, lots | MATCH | — | read |
| T2 | Own unplayed round = dummy at own score, capped (A4 16.4) | pre-2023 virtual opponent, and mis-applied: `virtualOpponentScore` gives a constant +½ per remaining round, where A6 gives the opposite result in round R (`tiebreakers.ts:63-69`). The card index is taken as the round, but awards are appended **after** all results (`tiebreakers.ts:726-742`) and results arrive in fixture order. "Rounds" = the entrant's card length, not the stage's rounds. | DIFFERS | **SW-M1 confirmed** (gap holds; its expected value is from the superseded formula, see below); NEW-1 (card length and order) | read |
| T3 | Opponent's post-withdrawal rounds count as draws (16.3.2) | no adjustment: the raw score is used (`tiebreakers.ts:74-80`) | MISSING | new | read |
| T4 | Forfeit win/loss is unplayed in Buchholz and SB (16.2.2/16.2.4) | a two-sided award enters as a played game against the real opponent | DIFFERS | **SW-L1 confirmed** (rule citation corrected) | read |
| T5 | Buchholz scale for non-chess | half-point-scaled virtual opponent | DIFFERS | SW-L2 | read |
| T6 | Swiss-aware default chain for non-chess (§5) | `division.tiebreakers ?? module.defaultTiebreakers` (`competition.ts:391-392`); badminton is `points, wins, set_ratio, point_ratio, h2h_points` (`badminton.ts:56`); no organiser UI | MISSING | **SW-H4 confirmed** (the UI half is W2's ST-G10) | read |
| T7 | "wins" includes unplayed wins (A4 7.1) | `wins()` counts award cards as wins (`tiebreakers.ts:120-123`, `:737`) | MATCH | — | read |
| T8 | Cut-line tie flagged, never silently ordered | `stages.ts:5048-5065`, `tiebreakers.ts:589-596` | MATCH | — | read |
| T9 | Buchholz shown where the table is shown | public view supports Buchholz (`standings-view.ts:51`); slideshow: no Buchholz reference found | MISSING (slideshow) | ST-G21 (grep-level only; read owed) | grep |
| T10 | `opp_diff`, progressive and median keys (§5) | not in `TiebreakerKey` (`module.ts:40-59`) | MISSING | new | read |

**Counts: MATCH 10 · DIFFERS 17 · MISSING 12 (39 rows).**

**SW gaps that did not fully hold up:**

- **SW-H1** (partly). "Any rounds ≥ field size always dead-ends" is true for even fields
  only. An odd field supports n rounds (§3.1). The core defect (an empty round reported
  as success) **holds**.
- **SW-M1 / SW-L1** (the rule, not the gap). Both cite the FIDE *virtual opponent* as the
  current rule. It was superseded in 2023, and C.07 (2026) art. 16.4 uses a dummy at the
  participant's own score. SW-M1's "FIDE gives 2.5" is computed with the superseded
  formula, so the reference must derive its expected values from A4. **The defects
  hold.**
- **SW-M8 / SC-O7** (severity). An inert `byeScore` leaves the FIDE-correct full-point
  bye in place. Only a house-rule half-point bye is unavailable.
- **SW-M6, SW-M13, SW-L6** were confirmed only as far as the lines listed above. Nothing
  contradicted them.

---

## 9. Edge-case table (design §4 scenarios applicable to Swiss)

These are the expected outcomes this rulebook requires. **"today"** is the read-level
prediction for the truth run, not an observation.

| ID | Scenario | Expected outcome (rule) | today |
|---|---|---|---|
| R1 | Late entry before Start | Enrolled; every unseated round is reshaped (eager pre-Start reconcile); paired from round 1. | ✅ predicted |
| R2 | Late entry after Start | **(if RB3-13 is accepted)** Joins from the next unpaired round with 0 per missed round; missed rounds are zero-point byes (16.2.3). Otherwise ⛔ with guidance. | 🚫 (SW-L7) |
| R3 | Withdrawal before Start | Removed from pairing; shells reshaped; no result. | ✅ predicted |
| R4a | Withdrawal between rounds, some results | Results stand (no expunge); not paired again; field parity flips the bye; stays in opponents' Buchholz with post-withdrawal rounds as draws. | ❌ T3 |
| R4b | Withdrawal with a paired undecided board | That board is a walkover to the opponent (P-A2: not met), then as R4a. | ❌ P2 (if RB3-2) |
| R4c | Withdrawal after a finalized board in the current round | That result stands; as R4a. | ✅ predicted |
| R5 | Withdrawal after all Swiss rounds are played | Swiss ranks stand. If in the cut → R6 / Q2. | ✅ predicted |
| R6 | Withdrawal after being seeded into the playoff/KO | W4 rulebook (walkover vs promote). The Swiss table does not change. | ⏳ W4 |
| R7 | Disqualification | As a withdrawal from that moment; retroactive annulment only through C4 (RB3-17). | ❌ (no cascade) / ⬜ |
| R8 | Entrant deleted | Before Start: allowed, round reshaped (fixed deb84282c). After Start: refused, pointing to Withdraw. | ✅ predicted |
| R9 | Pair rename / lineup | Same table, same pairings (metamorphic). | ✅ predicted |
| R10 | Waitlist promotion after the draw | = R1 before Start, = R2 after. | as R1/R2 |
| R11 | Duplicate entrant | Not Swiss-specific. Swiss requires only P-A1 per entrant id; the refusal belongs to the roster rulebook (W5). | ⬜ → W5 |
| R12 | Doubles partner withdraws | Substitute: same entrant, history kept. Dissolved: = R4. | ⬜ (W5 roster rule) |
| R13 | Moved to another division | 🚫 (design §4). Recommend ⛔ "withdraw here, enter there". | 🚫 |
| R14 | Retires from one match, plays the next | Retirement = loss (W2); a played game (met, colour counts); paired next round. | ✅ predicted (W2 credit ⏳) |
| R15 | Leaves after their last match, still paired next round | If the organiser withdraws them before pairing, not paired (A2 3.3). If paired and absent, M1 walkover. | ✅ predicted |
| R16 | Substitute or other lineup in a team match | No Swiss effect; stats attribution is W2. | n/a |
| M1 | Walkover in one match | Winner gets win points (W2 credit), not bye-eligible later, **not met** (P-A2), no colour; tie-breaks per §4. | ❌ P2, T4 |
| M2 | Double walkover | Both 0; decided (does not block Pair next); not met; both bye-eligible. | ❌ B5 (⏳ W2 for the outcome) |
| M3 | Retirement mid-match | Sport's retirement result; played game. | ⏳ W2 |
| M4 | Abandoned / no result | Pair next refuses with a named reason ("Round N has an unfinished match: <A v B>"), never "up to date". The organiser settles it (replay or an explicit result). | ✅ refusal exists (`STAGE_NOT_READY`); name the board (copy) |
| M5 | Draw in a stage that cannot end level | Swiss is a table stage, so draws stand where the sport allows them (0.5 pairing score today, table draw points under RB3-9). Bracket stage → W4. | ✅ predicted |
| M6 | Tie → decider | No deciders in a Swiss stage by default. The playoff/KO stage per W2/W4. | ⏳ W2/W4 |
| M7a | Void a result before the next round is paired | Fixture back to pending; Pair next refuses until it is decided again. | ✅ predicted |
| M7b | Void after the next round is paired | The published pairing stands (A2 4.3/4.4); standings and tie-breaks recompute. | ✅ predicted |
| M8a/b | Correct a finalized score (winner stays / flips) | Standings, Buchholz and SB recompute. Published pairings stand; only later rounds use the correction (A2 4.3). | ✅ predicted |
| M9 | Organiser forfeit/award | = M1. | ❌ as M1 |
| M10 | Disqualification mid-match | Forfeit loss for that match, then R7. | ⬜ (R7) |
| M11 | Rules change mid-match | **Refused** (ruling 12). | per W2 |
| F1 | Odd field | Exactly one bye per round, to the lowest-scored eligible entrant whose removal leaves a pairable remainder; win points; no for/against; frozen. | ❌ B1, B2 (+ P5, L3 rare) |
| F5a/b | Two-way / 3+-way ties | Resolved by the §5 chain in order; no h2h before Buchholz outside chess `direct`. | ❌ T6 (non-chess), ❌ T2 (chess with a bye) |
| F6 | Everyone level | Before any round: seed order. After play: the chain. If the chain is exhausted, lots, flagged. | ✅ predicted |
| F7 | Tie falls through to lots | Visible lots, recorded as a rank lock with its seed. A cut-line lots tie needs organiser confirmation. | ✅ predicted (T8) |
| P3 | Generate after a roster change | Pre-Start: every unseated round is reshaped. After Start: only the target round. No duplicate board, no phantom bye. | ✅ predicted; ❌ if an ad-hoc match exists (#846) |
| P4 | Rebuild after results | Refused for Swiss once any result exists, pointing to Unpair (#840 wipes the schedule; **W5 owns the fix**, W3 consumes). | ⏳ W5 |
| P5a | Undo Pair next | Clears that round's seats if nothing in it has a result; otherwise a named refusal. | ❌ B10 (SW-M2) |
| P5b | Unpair | Clears the latest *Swiss* round, never an ad-hoc fixture (SW-M5). | ❌ SW-M5 (read-level) |
| Q1a | Cut decided by lots/pick, corrected before the bracket starts | The proposal goes stale; re-propose and re-confirm. | ⏳ W4 (FX-G16) |
| Q1b | Same, after a bracket match started | The bracket stands; Swiss standings update; the desk warns (RB3-19). | ⬜ |
| X2 | Event cut short | "Finish the Swiss after round k": unpaired shells cancelled, standings final, tie-break "rounds" = k, cut proceeds. | 🚫 (RC4) |
| C1 | Home/away scores swapped | Corrected; recompute; no pairing change (A2 4.3). Chess: colour history corrected for later rounds. | ✅ predicted |
| C2 | Result entered on the wrong match | Void + re-enter both; as M7. | ✅ predicted |
| C3a/b | Protest: overturn / replay a day later | Overturn = M8. Replay: the board reopens; if the next round is already paired it stands. | ✅ / ⬜ (replay after pairing) |
| C4 | Ineligible player → retroactive forfeits | Each affected game becomes a forfeit loss (win to the opponent; unplayed per §4); recompute; later pairings stand. | 🚫 (no bulk forfeit path) |
| C5 | Points deduction | 🚫 (design §4). | 🚫 |
| C6 | Late correction after the Swiss is complete | Stage reopens its standings; ranks recompute; if the cut changes, Q1a/Q1b. | ⬜ |
| C7 | Result annulled weeks later | = C6. | ⬜ |

---

## 10. Items for the owner (recommendations, not rulings)

Each item is a recommendation with its owner value. Nothing here is ruled.

- **RB3-1 — Swiss legality = FIDE absolute criteria; pairing quality = a simplified
  Dutch.**
  - Adopt P-A1…P-A7 for every sport.
  - Deliberately do **not** implement Dutch quality criteria C6–C21 exactly. Today's
    score-group backtracking stays.
  - The reference asserts legality + existence + bye minimality only.
  - *Owner value:* every table is legal and never stalls. We do not build and maintain a
    second full FIDE engine for a customer base that is badminton today.
  - *Cost:* not FIDE-endorsed pairings. A rated chess event would use endorsed software
    anyway.
- **RB3-2 — Unplayed pairs may meet again** (A2 3.5). Reverse today's
  "two-sided walkover counts as met" (14c5095f2), but keep the walkover winner
  bye-ineligible. *Owner value:* matches FIDE and removes a source of dead-ends.
  - Alternative: keep today's rule as a recorded product deviation.
  - Recommend following FIDE.
- **RB3-3 — Round-count default and cap** (§3.2).
  - Default `min(band, ⌊n/2⌋)`.
  - Warn between the safe and the hard maximum.
  - **Refuse above n−1 (even) / n (odd)** at create, Start and every Generate.
  - The builder uses the band table (fixes SW-H2).
  - *Owner value:* the 6-player/5-round default that dead-ends 15.5% of events stops
    being offered.
  - Choice: whether n = 3–4 keep 3 rounds (feasible without colours).
- **RB3-4 — No legal pairing ⇒ named refusal** with "Finish the Swiss after round N−1"
  as the recovery. No "allow a repeat" option. Add a one-round look-ahead when rounds
  exceed the safe maximum. *Owner value:* the organiser is never told "up to date" over
  an empty round (SW-H1), and always has a way forward.
- **RB3-5 — #838: round count is per stage** (ruling 12, issue option b).
  - Editable until the stage's first fixture **starts**; shells do not freeze it.
  - After that, only "Finish now" and "Add a round" (≤ hard max).
  - *Owner value:* one rule to learn, "play freezes it". It already holds for `bestOf`.
  - **This is the owner's confirmation point for O7.**
- **RB3-6 — Adopt FIDE C.07 (1 March 2026) art. 16** for byes, forfeits and withdrawals
  in Buchholz and SB:
  - own unplayed rounds: dummy at own score, capped
  - post-withdrawal rounds: draws for opponents
  - forfeits: unplayed
  - This replaces the superseded virtual opponent. *Owner value:* chess tie-breaks match
    what an arbiter computes, so cut and seeding disputes go away.
- **RB3-7 — Byes.**
  - (a) The pairing-allocated bye = **win points, no for/against, frozen at award**, for
    all sports (fixes SW-M6, SW-M7).
  - (b) `byeScore`: wire it as a boardgame stage setting (win / draw / zero, default
    win), or delete it. Recommend **wire it**, because it is a common house rule.
  - (c) Requested half/zero-point byes: 🚫 today. Recommend **defer** (⛔ with guidance)
    and revisit when a chess customer asks.
- **RB3-8 — Swiss-aware default tie-break chains per sport family** (§5). The Swiss stage
  default replaces the division/sport default. Head-to-head comes late, with the UEFA
  league-phase precedent for goals sports.
  - *Owner value:* badminton Swiss (all live Swiss today) stops breaking ties on
    head-to-head between players who never met. That was the `SEEDING_TIE_UNRESOLVED`
    friction of the 09-24 probe.
- **RB3-9 — One number: table points** drive pairing score groups (SW-M11), the table
  and non-chess Buchholz. The dummy cap uses draw points, or ½ × win points for no-draw
  sports.
- **RB3-10 — Chess colours ON by default for a boardgame Swiss** (a stage setting that
  can be switched off). Round-1 initial colour by seeded lot (A3 5.1). Adopt the
  topscorer exception in the final round (A3 [C3]).
  - *Owner value:* the stronger player stops getting White every round (SW-H3).
  - Deviation to record if declined.
- **RB3-11 — Non-chess home/away alternation** as a soft preference (SW-L5). Recommend
  yes, low priority.
- **RB3-12 — Rank-adjacent pairing from round 2 in swiss_playoff/swiss_knockout** is a
  recorded deviation from Dutch fold (Hammes preset, Jul3/08 §7). Recommend **keep**:
  it was an earlier product choice, and the reference tolerates it.
- **RB3-13 — Late entry after Start into a Swiss** (R2). Recommend **build**: 0 per
  missed round (A2 2.4), optional house-rule ½. *Owner value:* Swiss is the one format
  that absorbs a latecomer cleanly.
  - Alternative: ⛔ with guidance.
- **RB3-14 — Double walkover** = both lose (0), decided, not met, both still
  bye-eligible. W3 wires the Swiss side; W2 owns the outcome.
- **RB3-15 — Ad-hoc matches on a Swiss stage (#846, SW-M3/M4/M5).**
  - Option A (recommended): **refuse Add match on a Swiss stage** with guidance ("Swiss
    rounds are paired by the system; add friendlies in another stage").
  - Option B: #846's fix, inferring byes only for shell rounds, plus the M4/M5 guards.
  - *Owner value:* A removes three defects with one refusal.
- **RB3-16 — Unseeded round-1 order.** Recommend a **seeded random draw** (recorded, so
  it can be replayed) over registration order (SW-L6). The FIDE order (rating, title,
  alphabetical) needs ratings the product does not hold.
- **RB3-17 — Disqualification** = a withdrawal from that moment. Retroactive annulment is
  a separate explicit action (C4). ⬜ until ruled.
- **RB3-18 — Cut-line ties:** keep today's flag-and-pick or visible lots. No play-off
  game.
- **RB3-19 — Correction that changes the cut after the bracket has started:** the
  bracket stands and the desk warns. Before it has started: re-propose (W4 FX-G16).
- **RB3-20 — "Finish the Swiss now"** (X2): build it. It is both the X2 path and the
  RB3-4 recovery.
- **RB3-21 — Corrections after the next round is paired** (M7b, M8, C1–C3): the
  published pairing stands, and standings recompute (A2 4.3/4.4). Confirm.
- **RB3-22 — Undo Pair next** clears seats when no result exists, and refuses with a
  name otherwise (SW-M2).
- **RB3-23 — Bye shells** are never placed on a court or printed (SW-M13, SH-G16; W8
  owns the print side).
- **RB3-24 — Reference bound:** blossom existence check for n ≤ 128, brute-force oracle
  cross-check for n ≤ 12. No multi-round look-ahead in the reference.
- **RB3-25 — Manual board swap for rounds ≥ 2** (SW-L12): ⛔ with guidance ("Unpair,
  then Pair next") for now. Revisit if an arbiter asks.

**🚫 needing a build-or-refuse ruling in W3:** R2 (RB3-13), R13 (⛔ recommended), X2
(RB3-20), C4 (recommend defer, ⛔), C5 (design-wide; W2 or W5), requested byes (RB3-7c),
manual swap (RB3-25).
