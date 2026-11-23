# Rulebook W6 — double elimination (double_elim × 11 sports)

> **2026-11-23 — items S1 to S9 SIGNED by the owner (rulings 300–305). The REC rows still wait for the batch
> sign-off.**
> - Rows marked **OWNER 293–299** restate the W6 rulings of 2026-11-23 (owner "Ok go" on the W6 recommendation
>   list). Rows marked **OWNER <n>** with an older number restate a rule already signed in W2b or W4.
> - Rows marked **REC** are the designer's calls. They are listed in §15 and wait for the owner's batch sign-off.
> - The items that were open (⬜ S1 to S9) were approved by the owner on 2026-11-23 and are rulings 300–305. Their
>   rows now read **OWNER 300** to **OWNER 305**. §15 keeps each question, its answer and its ruling number. No ⬜
>   row is left.
> - **Amended 2026-11-23 after design review 1** (`.superpowers/sdd/2026-11-23-w6-double-elim/design-review-1.md`).
>   The review confirmed RB6-X1 to X3 exactly (a bijection at every frame to 256, the three worked tables, E(n), one
>   chalk rematch); those rows are unchanged. Changed: RB6-X7 (its precondition), RB6-B3 (both edges), RB6-G3 and
>   the new G11 (S8), RB6-L4 (S5 reworded), RB6-C5 (status), RB6-R1 to R3, R7, R8 and the new R10 (S7), §14, §15
>   (S7 to S9 added).
> - **Amended 2026-11-23 after design review 2** (`design-review-2.md`, same folder). No rule changed. Three rows
>   say more plainly what they already meant: RB6-G11 (a GF1 settled with no loser owes no reset; a reset is seated only
>   when owed), RB6-G9 (which correction is refused), RB6-B3 (every path that draws the bracket). RB6-R10 gains the
>   order after a double walkover in the WB final. §14 gains two rows.
> - **Amended 2026-11-23 after design review 3** (`design-review-3.md`). No rule changed. §14 gains two rows: the
>   reset after a grand final nobody played, and the public title when no reset is owed.

- **Date:** 2026-11-23 · **Wave:** W6 (design §8 of the programme) · **Row:** `double_elim` × football, cricket,
  boardgame, carrom, generic, volleyball, badminton, tabletennis, tennis, icehockey, hockey = **11 cells**.
- **Inputs read:** brief `W6-double-elim.md`; `_RULES.md`; `_INDEX.md` rulings 6, 11, 19, 263, 264, 266, 267, 271,
  293–299 and the block "W6 — premise re-pin (2026-11-23)" under "False premises found"; audits
  `audit-2026-09-27/FX-fixtures.md` (G3, G4, G24), `ST-standings.md` (G33), `offered-matrix.md` (reason b);
  design `../2026-09-27-format-matrix-design.md` §4 and §7.1–7.3; `rulebook-W4-knockout.md`;
  `rulebook-W5-round-robin.md` (form only); the engine's `rules/cross-sport.md` and
  `src/scheduling/bracket.ts:426-537` at engine d1f07f8 (10.0.3).
- **How the code facts were established:** by reading, not driving. Review 1 modelled the rule in throwaway
  scripts and ran no product test. Every "product today" below is the premise
  re-pin's read on app `276fff25d7` and engine 10.0.3, or a line this draft cites itself. Each is a hypothesis for
  W6's truth run (`_RULES.md` R5).
- **Rule ids:** `RB6-<area><n>`. These are rulebook ids. The engine rule rows get their own ids when they land.
- **Words used here.** WB = winners' bracket. LB = losers' bracket. GF1 = the first grand final. Reset = the second
  grand final. `WB r.i` is game i of WB round r, counted from the top of the draw. `LB t.p` is game p of LB round t.
  A **drop round** is an LB round that takes WB losers (LB round 1 and every even LB round). A **survivor round**
  is an odd LB round from 3 on, where two LB winners meet. **k** is the bracket depth: the frame holds 2^k seats.

---

## 1. Authority and citations

Ruling 11: federation rules first, product rules where no federation governs, and deliberate deviations recorded as
owner rulings. No federation among the 11 sports publishes a double-elimination structure, so the structure is a
product rule and the drop order follows published bracket practice. The match layer is federation-ruled and lives in
W2's rulebooks (§12).

| # | Source | Used for |
|---|---|---|
| A1 | **Smoothcomp, "Cross bracketing"** (https://support.smoothcomp.com/article/333-cross-bracketing, page dated "Last updated on March 25, 2024") | the drop order. It defines regular order (top to bottom), reversed order (bottom to top) and switched ("split the column in the middle and have the two halves switch places"). Its "NCAA type" lists, per elimination column: 16 acts like alternating; 32 = "1. Regular 2. Reversed 3. Reversed switched 4. Reversed"; 64 = "1. Regular 2. Reversed 3. Reversed switched 4. Regular switched 5. Regular". Purpose: "to avoid the same athletes fighting more than once", with the caveat "there will always be cases where you end up fighting the same athlete twice". It says 128 and 256 are supported but not described. |
| A2 | **brackets-manager.js `src/ordering.ts:153-160`** (github.com/Drarig29/brackets-manager.js, default branch) | a second published table, `defaultMinorOrdering`: 4 `[natural, reverse]`; 8 `[natural, reverse, natural]`; 16 `[natural, reverse_half_shift, reverse, natural]`; 32 `[natural, reverse, half_shift, natural, natural]`; 64 `[natural, reverse, half_shift, reverse, natural, natural]`; 128 `[natural, reverse, half_shift, pair_flip, pair_flip, pair_flip, natural]`. It disagrees with A1 at 16, 64 and 128 (§4, S1). |
| A3 | **Toornament, "Introducing the Loser Bracket"** (https://help.toornament.com/structures/introducing-the-loser-bracket) | the aim of the drop order: "Opponents who already played each other should meet again at the latest possible." |
| A4 | **Wikipedia, "Double-elimination tournament"** (https://en.wikipedia.org/wiki/Double-elimination_tournament) | the shape: losers of each W round "drop down" into the L bracket; the final is "a possible two games", the second called the "if game" or "bracket reset"; "the W bracket finalist wins the tournament by winning either game of the final round". |
| A5 | **Engine rule rows**, `rules/cross-sport.md` at engine 10.0.3: X-DW-2 (`:14`), X-DW-3 (`:15`), X-DE-1 (`:30`), X-DV-1 (`:56`), X-CH-3 (`:143`), X-FR-3 (`:151`) | the signed rules this rulebook keeps, amends or overturns |
| A6 | **Product rule** | cited as "product rule (ruling N)" |
| A7 | **W2 rulebooks** `rulebook-W2-sets-cricket.md`, `rulebook-W2-goals-boards.md` | every match-level decision rule (§12) |
| A8 | **The designer's own enumeration** (a throwaway model written from §3–§4, not committed, not product code) | the earliest-rematch numbers in §4. The reference agent re-derives them from the rule (R8, R9). Nothing here is taken from the product's output. |

**Citation status.** A1, A3 and A4 were read on 2026-11-23 through a fetch tool that returns extracted text; the
quoted strings are as returned. A2 was read from the repository on the same day. A5 and A7 are files in the engine
and this directory. A1 describes wrestling repechage, where the two finalists do not drop; a double elimination adds
one more drop (the WB final's loser) into a single game, which needs no order.

---

## 2. Empty and degenerate cases first (R13)

| id | rule | source | status |
|---|---|---|---|
| RB6-E1 | A double-elimination stage with 0 entrants refuses Generate with a named reason. It never answers "up to date" and never returns an empty bracket. | product rule (R13; RB4-E1) | REC |
| RB6-E2 | n=1: Generate is refused with a named reason ("a double elimination needs at least 2 entrants"). | product rule (RB4-E2) | REC |
| RB6-E3 | n=2: the WB is one match. There is no LB match: the WB loser is the LB champion. GF1 is the same pair again. With the reset on, the WB winner needs one more win and the WB loser needs two. Every match after the first is a rematch, so the rematch property (RB6-X6) does not apply at n=2. | structure (§3); A4 | OWNER 304 |
| RB6-E4 | n=3: frame of 4. Seed 1 has the WB round-1 bye. LB 1.1 has one dead seat, so the loser of 2 v 3 advances by bye (RB6-B2). The LB final is that entrant against the WB final's loser. Matches: 2 v 3, WB final, LB final, GF1, and the reset if earned. Places are 1st, 2nd, 3rd; nobody is 4th. | structure (§3, §5) | OWNER 304 |
| RB6-E5 | A bracket with no live LB match at all (n=2) still has exactly one champion and ranks that cover both entrants. | design §7.3 | REC |
| RB6-E6 | An LB line with both seats dead is dead: it is never a match, never scheduled, never counted as open, and it hands a dead seat to the line it feeds (RB6-B3). | product rule (R13) | REC |
| RB6-E7 | The rematch sweep reports how many LB matches and how many pairs it checked. Zero checked is a failure (n=2 is excluded by name, not by an empty pass). | R25; ruling 299 | OWNER 299 |

**Product today (read).** With fewer than 2 entrants the generator returns the WB's fixtures and no grand final
(`src/scheduling/bracket.ts:447`). At n=2 it builds the grand final against the WB final's loser (`:507-511`). No
named refusal was read for 0 or 1 entrants; the truth run settles it.

---

## 3. Structure and the draw

| id | rule | source | status |
|---|---|---|---|
| RB6-D1 | The frame is the smallest 2^k that holds the field (k ≥ 1). The WB is a single-elimination bracket of k rounds. `WB (r+1).j` takes the winners of `WB r.(2j−1)` and `WB r.(2j)`. | A4; product rule | REC |
| RB6-D2 | The WB draw follows the knockout family's rules unchanged: seeds on the fold, byes to the top seeds first, the unseeded drawn at random with a stored and shown draw seed, and Rebuild reuses that seed (RB4-D1 to RB4-D6). | ruling 268 (W4) | OWNER 268 |
| RB6-D3 | The LB has 2(k−1) rounds. LB round 1 and every even LB round are drop rounds. Odd rounds from 3 are survivor rounds. LB rounds 2r−3 and 2r−2 have 2^(k−r) games each (r = 2 … k). | A4 | REC |
| RB6-D4 | Every entrant is out of the stage at their second loss, and only then, except where §7 says otherwise (withdraw, disqualify). | A4; ruling 294 | OWNER 294 |
| RB6-D5 | The LB has no seeding of its own. Who meets whom there is fixed by §4 alone. | product rule | REC |
| RB6-D6 | Seat order inside a match (who is listed first) is not ruled here. The reference checks who plays whom, never which side is home. | product rule | REC |

---

## 4. Losers'-bracket drops cross (ruling 295)

The owner ruled that drops cross and that this rulebook fixes one published pattern. The pattern below is A1's
"NCAA type" table, written as one rule for any 2^k. It applies to a new or rebuilt bracket. A bracket with a result
keeps the lines it has (ruling 295).

| id | rule | source | status |
|---|---|---|---|
| RB6-X1 | **LB round 1** pairs adjacent WB round-1 losers in regular order: `LB 1.j` = loser of `WB 1.(2j−1)` v loser of `WB 1.(2j)`, j = 1 … 2^(k−2). | A1 ("1. Regular") | OWNER 295, 300 |
| RB6-X2 | **The loser of `WB r.i`** (r = 2 … k, i = 1 … G, G = 2^(k−r)) lands in **LB round 2(r−1)**, game p, against the winner of `LB (2r−3).p`. With c = (r−2) mod 4: **c=0 reversed:** p = G+1−i. **c=1 reversed then switched:** p = G/2+1−i when i ≤ G/2, else p = 3G/2+1−i. **c=2 switched:** p = i+G/2 when i ≤ G/2, else p = i−G/2. **c=3 regular:** p = i. When G = 1, p = 1. | A1 (columns 2 to 5 of its 32 and 64 lists; the four-step cycle past 64 is this rulebook's extension) | OWNER 295, 300 |
| RB6-X3 | **Survivor rounds:** `LB (2r−1).j` = winner of `LB (2r−2).(2j−1)` v winner of `LB (2r−2).(2j)`, r = 2 … k−1. | A4 | REC |
| RB6-X4 | The winner of the last LB round (round 2k−2, the LB final) is the LB champion and meets the WB champion in GF1. | A4 | REC |
| RB6-X5 | The pattern is defined on the frame. Byes change which seats are live (§5), never where a loser lands. | product rule | REC |
| RB6-X6 | **Property the reference checks, any results.** Two entrants meet again in the LB only if one lost a WB match that the other won. Under RB6-X1 to X3 no such pair can meet before LB round **E(n)**, whatever the results: **E(4)=2, E(8)=3, E(16)=4, E(32)=5, E(64)=7, E(128)=8**. A rematch in round E(n) is reachable, so the test has a case where right and wrong differ. A field on a frame of 2^k inherits that frame's E. | A8; A3 | REC |
| RB6-X7 | **Property, a fully seeded field on the fold, better seed wins every match.** When every entrant is seeded and placed on the fold (RB6-D2 with no unseeded entrant), for every n ≥ 3 there is exactly one LB rematch: the LB final, seed 3 against seed 2, who met in the WB semi-final. This holds for every mirror image of the fold. **It is not claimed for a partly seeded or random draw:** there only RB6-X6's earliest-round bound holds. With the top 4 on the fold and the rest drawn at random, the better seed winning gave 2 or 3 LB rematches in about 28% of draws at 16 and 35% at 32 (review 1, 3,000 draws each). | A8; review 1 | OWNER 300 |
| RB6-X8 | GF1 and the reset are outside both properties: GF1 may repeat any WB match, and the reset repeats GF1 by definition. | A4 | REC |

**Which order each size uses** (drops from WB round 2 onward; the WB final's loser always lands in the one-game LB
final):

| n | WB round 2 | WB round 3 | WB round 4 | WB round 5 | WB round 6 |
|---|---|---|---|---|---|
| 4 | one game | | | | |
| 8 | reversed | one game | | | |
| 16 | reversed | regular (c=1 on two games changes nothing) | one game | | |
| 32 | reversed | reversed then switched | switched (two games: a swap) | one game | |
| 64 | reversed | reversed then switched | switched | regular | one game |

**Worked table, n=4** (k=2; LB rounds 1–2):

| match | seats |
|---|---|
| LB 1.1 | L `WB 1.1` v L `WB 1.2` |
| LB 2.1 (LB final) | W `LB 1.1` v L `WB 2.1` |

Earliest possible rematch: LB round 2. It cannot be avoided: the WB final's loser beat one of the two LB 1.1 players.

**Worked table, n=8** (k=3; LB rounds 1–4):

| match | seats |
|---|---|
| LB 1.1 | L `WB 1.1` v L `WB 1.2` |
| LB 1.2 | L `WB 1.3` v L `WB 1.4` |
| LB 2.1 | W `LB 1.1` v L `WB 2.2` |
| LB 2.2 | W `LB 1.2` v L `WB 2.1` |
| LB 3.1 | W `LB 2.1` v W `LB 2.2` |
| LB 4.1 (LB final) | W `LB 3.1` v L `WB 3.1` |

Earliest possible rematch: LB round 3 (the loser of `WB 2.1` against the opponent they beat in WB round 1). Chalk
example on the draw 1 v 8, 4 v 5, 3 v 6, 2 v 7: LB 1 gives 5 and 6; LB 2.1 is 5 v 3, LB 2.2 is 6 v 4; LB 3.1 is
3 v 4; the LB final is 3 v 2, the one rematch.

**Worked table, n=16** (k=4; LB rounds 1–6):

| match | seats |
|---|---|
| LB 1.1 … 1.4 | L `WB 1.1` v L `WB 1.2` · L `WB 1.3` v L `WB 1.4` · L `WB 1.5` v L `WB 1.6` · L `WB 1.7` v L `WB 1.8` |
| LB 2.1 | W `LB 1.1` v L `WB 2.4` |
| LB 2.2 | W `LB 1.2` v L `WB 2.3` |
| LB 2.3 | W `LB 1.3` v L `WB 2.2` |
| LB 2.4 | W `LB 1.4` v L `WB 2.1` |
| LB 3.1, 3.2 | W `LB 2.1` v W `LB 2.2` · W `LB 2.3` v W `LB 2.4` |
| LB 4.1 | W `LB 3.1` v L `WB 3.1` |
| LB 4.2 | W `LB 3.2` v L `WB 3.2` |
| LB 5.1 | W `LB 4.1` v W `LB 4.2` |
| LB 6.1 (LB final) | W `LB 5.1` v L `WB 4.1` |

Earliest possible rematch: LB round 4 (the loser of `WB 3.1` against an opponent they beat in WB round 1). Chalk
example on the draw 1 v 16, 8 v 9, 5 v 12, 4 v 13, 3 v 14, 6 v 11, 7 v 10, 2 v 15: LB 2 is 9 v 7, 12 v 6, 11 v 5,
10 v 8; LB 3 is 7 v 6 and 5 v 8; LB 4 is 6 v 4 and 5 v 3; LB 5 is 4 v 3; the LB final is 3 v 2, the one rematch.

**How the sources compare (A8's enumeration).** Earliest LB round in which any rematch is possible:

| pattern | 8 | 16 | 32 | 64 | 128 |
|---|---|---|---|---|---|
| this rulebook (A1 NCAA type, cycled) | 3 | 4 | 5 | 7 | 8 |
| A2 brackets-manager defaults | 3 | 3 | 5 | 6 | 7 |
| A1 "Alternating" (reversed, regular, reversed …) | 3 | 4 | 4 | 4 | 4 |
| straight drops (product today) | 2 | 2 | 2 | 2 | 2 |

An exhaustive search over every drop permutation (with RB6-X1 fixed) finds nothing later than 3, 4 and 5 at 8, 16
and 32, so the chosen pattern is optimal there. At 64 and 128 it is the best of the named orders tried, not a proven
optimum. All three crossed patterns give the same chalk result (the LB final only).

**Product today (read).** Straight drops: the loser of WB round m+1 game i lands on LB game i
(`src/scheduling/bracket.ts:476-486`, engine 10.0.3; audit FX-G4). With the better seed winning every match that
gives 1, 3 and 7 LB rematches at 4, 8 and 16.

---

## 5. Fields that are not a power of two: byes and dead seats

| id | rule | source | status |
|---|---|---|---|
| RB6-B1 | A WB round-1 bye is an award to the real side (RB4-D2). It is not a match, it has no loser, and the LB seat its loser would have taken is **dead from the draw**: known at Generate, not discovered when a result lands. | RB4-D2; W6 brief, carried 1 | REC |
| RB6-B2 | An LB line with one dead seat is not a match. The entrant on the live seat **advances by bye**, the moment they arrive. It is not a walkover: nobody is credited a win, nobody takes a loss, no score is recorded, and it counts toward nobody's two losses. | RB4-D2 by analogy | REC |
| RB6-B3 | An LB line with two dead seats is dead (RB6-E6) and hands a dead seat on: the seat its **winner** feeds is dead from the draw too. Dead seats are worked out for the whole LB when the bracket is drawn, by Generate or by the draw of a stage fed from an earlier one, down both edges (a bye's loser edge, a dead line's winner edge), repeated until nothing changes. So at n=5 `LB 2.2` has a dead seat because `LB 1.2` is dead; the same shape appears at n = 9 to 11 and 17 to 23. On a frame of 8 the number of LB lines with a dead seat is the number of byes: 3 at n=5, 2 at n=6, 1 at n=7. A dead line is void. It is never a double walkover: nobody was absent. | product rule; review 1 | OWNER 305(c) |
| RB6-B4 | A line with a dead seat is never scheduled: it holds no time and no court at any moment, including while its live seat still waits on a feeder. Auto-schedule skips it, and it is never listed as a match to play, call or print. | W6 brief, carried 1; ruling 299 | OWNER 299 |
| RB6-B5 | A dead seat from the draw is different from a seat vacated during play. A seat vacated by a withdrawal, a disqualification or a double walkover is a **walkover** to the opponent (RB6-F6), which is a credited win. | ruling 264; X-DW-2 | OWNER 264 |
| RB6-B6 | A late entry that reopens a bye line (RB6-L3) makes its LB seat live again. | ruling 296 | REC |

Examples on a frame of 8, byes to the top seeds: **n=7** has one dead LB seat (LB 1.1 becomes a bye). **n=6** has
two (both LB round-1 lines are byes, so LB round 1 has no match). **n=5** has three: LB 1.1 is a bye, LB 1.2 is
dead, and so the loser of `WB 2.1` advances by bye from LB 2.2.

**Product today (read).** A bye award's loser edge already reads as dead and the seat is stamped once the other seat
fills (`usecases/stages/bracket-seats.ts:222-236`, `:547-563`). The gap is the window where both seats are open
(`:507-512`) and the placement predicates (`lib/bye-line.ts:64-66`, `engine-db/system-bye-sql.ts:47-54`,
`usecases/schedule/board.ts:40-42`): in that window Auto-schedule can give the line a time and a court.

---

## 6. Grand final and reset

| id | rule | source | status |
|---|---|---|---|
| RB6-G1 | Every double-elimination stage has one setting, **"Grand final: reset if needed (default) / single match"**. A new stage opens at "reset if needed". | ruling 293 | OWNER 293 |
| RB6-G2 | A stage already stored keeps its stored value. A stored stage with no value keeps the behaviour it had: a single match. No migration rewrites it. | ruling 293 (the second sentence is the designer's reading) | OWNER 293 (+ REC) |
| RB6-G3 | The setting is editable until GF1 has a result, then read-only with a named reason. A change adds or removes the unplayed reset in the same step, and a time or court the removed reset held is released. | product rule (nothing before GF1 depends on the setting) | OWNER 305(a) |
| RB6-G4 | **Reset if needed:** GF1 is WB champion v LB champion. If the WB champion wins GF1, the stage is decided. If the LB champion wins GF1, both have one loss and the reset is played; its winner is champion. | A4; ruling 293 | OWNER 293 |
| RB6-G5 | **Single match:** GF1 decides the title whoever wins. A WB champion who loses it is 2nd with one loss. | ruling 293 | OWNER 293 |
| RB6-G6 | When the WB champion wins GF1, **the reset does not exist for anyone**: it is not shown as a match to play, not counted as open, not called, and not printed as a match. (Printing is W8's lane; this row is the rule it follows.) | ruling 298 | OWNER 298 |
| RB6-G7 | **A reset the LB champion earned cannot be voided.** The stage is not complete until the reset is decided, walked over, or settled under §9. | ruling 298 | OWNER 298 |
| RB6-G8 | Before GF1 is decided the reset is shown as "if needed". It may hold a time and a court so the venue can plan. It is not an open match and is never called. | A4 ("unknown, until this match has been concluded") | REC |
| RB6-G9 | Whether the reset exists is read from GF1's current result every time. Once the reset has started, a correction that changes GF1's winner is refused with a named reason; a score fix that keeps the same winner is allowed. | product rule (R28) | REC |
| RB6-G10 | The stage completes when GF1 is decided and no reset is owed, or when the reset is decided or settled. Completing it with either undecided is refused with a named reason (RB4-C7). | RB4-C7 | OWNER 274 |
| RB6-G11 | **The reset is owed** exactly when the setting is "reset if needed", GF1 is settled with a winner, that winner is the LB champion, and GF1 has a loser, the WB champion, who is still in the stage. In every other settled state of GF1 the reset is not owed and does not exist (RB6-G6): the WB champion won; GF1 ended in joint winners (RB6-C5); GF1 left the title vacant (RB6-C4); GF1 was a walkover over a finalist who is out of the stage (RB6-C2); GF1 was settled with no loser, because a double walkover in the WB final left no WB champion (RB6-F7). The reset holds its two finalists if and only if it is owed. Every screen and every count reads this one answer. | rulings 293, 298, 267; review 1 | REC |

**Product today (read).** The reset is reachable through the public API only: `api-v1/schemas/stages.ts:263` accepts
`bracketReset` and the generator honours it (`src/scheduling/bracket.ts:524-533`); no template, screen or matrix row
sets it. An untriggered reset already reads as void and is skipped in the open count
(`engine-db/competition/bracket-stage.ts:237-240, 258-268`; `usecases/scoring.ts:1385-1392`), so FX-G3 as written is
false since W4. What is left is RB6-G7: the engine accepts a void reset after the LB champion won GF1.

---

## 7. Forfeit, no-show, walkover, withdrawal

| id | rule | source | status |
|---|---|---|---|
| RB6-F1 | **A forfeit or no-show on one match is one loss.** In the WB the absent side drops to the LB seat that match's loser takes (§4), like any loser. The opponent advances with a walkover win. This overturns X-DE-1 for forfeits. | ruling 294 | OWNER 294 |
| RB6-F2 | An organiser's award against one side (M9b) is the same: one loss. | ruling 294; audit FX-G24 | OWNER 294 |
| RB6-F3 | **A forfeit by a side already in the LB** is that side's second loss. They are out, the opponent advances with a walkover win, and the forfeiter is ranked at that LB round (RB6-R3). | ruling 294 | OWNER 294 |
| RB6-F4 | **Withdraw and disqualify are unchanged:** the entrant is out of the whole stage at once, wherever they stand, and every later seat of theirs walks over. They never drop. | rulings 264, 259, 294; X-DE-1 (kept for these two) | OWNER 294 |
| RB6-F5 | **Double walkover in the LB:** both sides take their second loss and both are out. The seat that match feeds is vacated, and its opponent advances by walkover. | ruling 294; X-DW-2 | OWNER 294 |
| RB6-F6 | A seat vacated during play (RB6-F4, F5, F7) is a walkover win for the opponent. It adds no loss to anyone still in the stage. | ruling 264; X-DW-2 | OWNER 264 |
| RB6-F7 | **Double walkover in the WB:** both sides are out. Neither drops: one WB match feeds one LB seat. The LB seat and the next WB seat each walk over (X-DW-2 kept). Ruling 301 amends ruling 294's "each drops once". | X-DW-2; ruling 301 | OWNER 301 |
| RB6-F8 | **A double walkover on GF1 or on the reset is refused**, with the guidance X-DW-3 gives (reschedule, record a walkover if one side turned up, or settle). The match stays open. The loss count of RB6-F5 is not applied to a final. | X-DW-3 (ruling 84) | OWNER 84 |
| RB6-F9 | **A forfeit in GF1.** By the WB champion: one loss; with the reset on, the reset is earned and RB6-G7 applies; with it off, the LB champion is champion. By the LB champion: second loss; the WB champion is champion and no reset exists. | rulings 293, 294, 298 | OWNER 294 |
| RB6-F10 | **A forfeit in the reset** is the forfeiter's second loss. The other side is champion. | ruling 294 | OWNER 294 |
| RB6-F11 | **A retirement mid-match** (M3, R14) is one loss, like a forfeit: the entrant drops and may play on. An entrant who cannot continue is withdrawn by the organiser, and then every later seat walks over. | ruling 302 | OWNER 302 |
| RB6-F12 | The walkover score credited to the winner is the sport's own (W2 rulebooks, §12). | ruling 11 | OWNER 11 |

**Product today (read).** A forfeit loser is out on purpose: X-DE-1, `engine-db/fed-seats.ts:146-165`,
`double-walkover-seating.test.ts:189`. FX-G24 is therefore a ruling, not a gap, and ruling 294 overturns it.

---

## 8. Late entry after Start (ruling 296)

| id | rule | source | status |
|---|---|---|---|
| RB6-L1 | A late entrant is accepted only where the double elimination is the division's entry stage. A double elimination fed from a table never takes one; the entrant joins the entry stage under its own rule (RB4-L2). | rulings 263, 296 | OWNER 296 |
| RB6-L2 | A late entrant joins **WB round 1 only**. They never join WB round 2 or later and never enter the LB directly. | ruling 296 | OWNER 296 |
| RB6-L3 | **Case (1):** a WB round-1 bye whose holder has not started their WB round-2 match. The late entrant plays the bye holder in a new WB round-1 match, the bye is reversed, and the LB seat that line feeds becomes live (RB6-B6). With several open byes it takes the lowest-seeded holder's (RB4-L4). | rulings 263, 296 | OWNER 296 |
| RB6-L4 | Case (1) is open only while the LB has not moved on past that bye: no entrant who advanced by bye (RB6-B2) through an LB line whose seats the reopened bye changes has started their next LB match. Reopening the bye takes those byes back: the entrant returns to the line and waits for the new opponent. (The line is not always the one the bye fed. At n=5 the bye's own LB line is dead and the line that changes is `LB 2.2`.) | product rule (the LB side of ruling 296 is not ruled) | OWNER 304 |
| RB6-L5 | **Case (2):** otherwise, a withdrawn entrant's WB round-1 slot before its first match. The late entrant takes it (RB4-L5, including the walkover reversal). | rulings 263, 296 | OWNER 296 |
| RB6-L6 | **Case (3):** otherwise a named refusal. When no result exists anywhere in the stage and no match has been called, the refusal offers Rebuild (RB4-L6 and its 2026-11-09 amendment, including the frozen-schedule answer). | rulings 263, 296 | OWNER 296 |
| RB6-L7 | **Organiser's tap only.** A payment confirmation, a waitlist promotion, an import or a Reinstate into a started double elimination lands on the entrant list with a desk flag. One organiser tap runs L3, L5, L6 in order. It is never auto-placed and never refused. | ruling 271 | OWNER 271 |
| RB6-L8 | "Started", the new match's slot and the missing Undo follow RB4-L9, L12 and L13. | W4 | OWNER 274 |

**Product today (read).** There is no double-elimination branch: `lib/open-entry-stages.ts:53-56` leaves
`double_elim` out of `ROOT_KNOCKOUT_KINDS`, so the start lock answers (`usecases/entrants.ts:448-463`).

---

## 9. Champion, and a final that is not played (ruling 267 applied)

"The deciding match" is GF1 while no reset is owed, and the reset once the LB champion has won GF1.

| id | rule | source | status |
|---|---|---|---|
| RB6-C1 | There is exactly one champion: the winner of the deciding match. The exceptions are RB6-C4 and RB6-C5 only. | design §7.3; RB4-C1 | OWNER 274 |
| RB6-C2 | **One finalist out before GF1** (withdrawn or disqualified): GF1 is a walkover and the other finalist is champion. No reset exists, whichever side is out, because the side that is out cannot play one. | ruling 267 (RB4-C2); the reset clause is the designer's call | OWNER 267 (+ REC) |
| RB6-C3 | **One finalist out between GF1 and an earned reset:** the reset is a walkover and the other finalist is champion. This counts as "walked over" under RB6-G7. | rulings 267, 298 | OWNER 298 |
| RB6-C4 | **Both finalists out** (before GF1, or between GF1 and an earned reset): the title is vacant automatically. Both rank 2nd and nobody ranks 1st. It reverses itself if Reinstate or Undo restores a finalist. | ruling 267 (RB4-C3; X-CH-3) | OWNER 267 |
| RB6-C5 | **The deciding match is not played** (rain, time): the organiser action "Declare joint winners" is offered on it while it has no decided result. Both finalists rank 1st. Declared on GF1, no reset exists. Declared on an earned reset, it settles the reset for RB6-G7. The action is undoable; undone on GF1, the reset is "if needed" again. | ruling 267 (RB4-C4, C6); the reset clauses: ruling 305(b) | OWNER 267, 305(b) |
| RB6-C6 | An unplayed deciding match is never decided by seed, by a table, or by the WB champion's unbeaten record automatically. | ruling 267 as narrowed by 275 (RB4-C5) | OWNER 275 |
| RB6-C7 | A stage whose deciding match is decided but which is not yet complete raises the desk attention of RB4-C8. | RB4-C8 | OWNER 273 |

---

## 10. Final ranks (ruling 297)

| id | rule | source | status |
|---|---|---|---|
| RB6-R1 | **One champion; ranks cover every entrant of the stage exactly once**, withdrawn and disqualified included. Shared places are allowed: entrants who went out in the same round share one (RB6-R3, R10), and §9 declares the title's (RB6-R8). A stage is never refused completion because a place has no holder or has several. | design §7.3; ruling 297; review 1 | OWNER 297, 305(d) |
| RB6-R2 | **1st to 4th are unique when the matches that decide them are played.** 1st is the winner of the deciding match. 2nd is its loser. **3rd is the loser of the LB final** (LB round 2k−2). **4th is the loser of the one game in LB round 2k−3.** At n=4 that game is LB 1.1. At n=3 there is no 4th. At n=2 there is no 3rd. Where one of those matches is not played, RB6-R10 applies. | ruling 297 | OWNER 297 |
| RB6-R3 | **Entrants who went out in the same LB round share a place.** The place is 1 plus the number of entrants who went out later. Seed does not order them, and neither does entrant id. With every match played this shares places from 5th down only. | ruling 297 | OWNER 297 |
| RB6-R4 | The reset setting changes only who is 1st and 2nd. Reset off, or reset on and not earned: GF1's winner and loser. Reset played: the reset's winner and loser. Every other place is the same in both modes. | rulings 293, 297 | OWNER 297 |
| RB6-R5 | A round with one real loser gives an unshared place (odd fields: 7th alone at n=7, 5th alone at n=5). A round with no match gives no place. | follows from RB6-R3 | REC |
| RB6-R6 | An entrant who forfeits is ranked by the round of their second loss, like any loser (RB6-F1, F3). | ruling 294 | OWNER 294 |
| RB6-R7 | **A withdrawn or disqualified entrant** is ranked at the LB round of the seat they vacate: their own LB match if they were in the LB, otherwise the LB round their WB match's loser drops to. They share that round's place. **A finalist who is out at the deciding match is its loser: 2nd** (RB6-C2, C3), as in a knockout. | X-FR-3 and X-DE-1 by analogy; not ruled for shared places | OWNER 303 |
| RB6-R8 | Shared places from §9 hold: a vacant title is two 2nds and no 1st; joint winners are two 1sts and no 2nd. Ruling 297 says "1st to 4th are unique" and names no exception; keeping ruling 267's two pairs here is a reading. | ruling 267 read with ruling 297 | OWNER 267 (+ REC) |
| RB6-R10 | **A double walkover can leave two or more entrants out in the same round near the top.** They share the place by RB6-R3's formula and the next place is skipped; a place whose match nobody lost has no holder. The stage completes. **n=4:** a double walkover in `LB 1.1` puts both out in LB round 1; the WB final's loser walks over the LB final, which nobody loses; the two rank **3=** and nobody is 4th. **n=8:** a double walkover in `LB 2.1` puts both out in LB round 2 with the loser of `LB 2.2`; `LB 3.1` is a walkover nobody loses; the three rank **4=**, nobody is 5th or 6th, and the LB round-1 losers are 7=. **n=8, a double walkover in `WB 2.1`** (S2: both out): both vacate the LB round-2 seat; the WB final and then the LB final are walkovers nobody loses, so the loser of `LB 3.1` is 3rd; the two rank 4= with the loser of `LB 2.1` (three at 4=), and the LB round-1 losers are 7=. **n=8, a double walkover in the WB final** (S2: both out): both vacate the LB final's seat and GF1's; the LB final and GF1 are each settled with nobody losing them, so the LB champion is **1st**, the two WB finalists share **2=**, nobody is 3rd, the loser of `LB 3.1` is **4th**, the LB round-2 losers are 5= and the LB round-1 losers 7=. No reset is owed (RB6-G11). | ruling 297 as read; X-DW-2; review 1 | OWNER 305(d) |
| RB6-R9 | Ranks are checked by a full-order oracle on every field size from 2 to at least 16, powers of two and odd fields, with the reset off and on. The check counts the entrants it ranked; zero is a failure. | ruling 299; ST-G33; R25 | OWNER 299 |

**Place tables** (full fields; the same with the reset off or on, per RB6-R4):

| place | n=4 | n=8 | n=16 |
|---|---|---|---|
| 1st | winner of the deciding match | same | same |
| 2nd | loser of the deciding match | same | same |
| 3rd | loser of LB 2.1 | loser of LB 4.1 | loser of LB 6.1 |
| 4th | loser of LB 1.1 | loser of LB 3.1 | loser of LB 5.1 |
| 5= | | 2 losers of LB round 2 | 2 losers of LB round 4 |
| 7= | | 2 losers of LB round 1 | 2 losers of LB round 3 |
| 9= | | | 4 losers of LB round 2 |
| 13= | | | 4 losers of LB round 1 |

**Odd fields** (frame of 8, byes per RB4-D2):

| place | n=7 | n=6 | n=5 |
|---|---|---|---|
| 1st, 2nd | deciding match | deciding match | deciding match |
| 3rd | loser of LB 4.1 | loser of LB 4.1 | loser of LB 4.1 |
| 4th | loser of LB 3.1 | loser of LB 3.1 | loser of LB 3.1 |
| 5= / 5th | 2 losers of LB round 2 (5=) | 2 losers of LB round 2 (5=) | the 1 loser of LB round 2 (5th) |
| 7th | the 1 loser of LB round 1 | (LB round 1 has no match) | |

**Product today (read).** Ranks below the semi-finals are strict in the knockout family: round, then seed, then
entrant id (RB4-R2). The engine guards the ranks as a permutation and falls back to GF1 when the reset is void
(`src/competition/stage.ts:825-834, 707, 767`). Audit ST-G33 says double-elimination ranks are tested with 2
entrants only. This draft first pinned that to `placement-snapshots.test.ts:322`; that line is inside a knockout
third-place case, so the pin was wrong and the claim is not re-pinned. The completed-stage guard allows a shared
rank only at 1 to 4 and never more than two holders (`stage.ts:208, 777-779`), so today it would refuse RB6-R10's
three at 4=.

---

## 11. Rebuild and the schedule

| id | rule | source | status |
|---|---|---|---|
| RB6-P1 | Rebuild deletes and regenerates in one transaction and keeps times and courts (ruling 253). In a double elimination a slot stays with the match's **role**, not its position. | ruling 253; ruling 299; W6 brief, carried 2 | OWNER 299 |
| RB6-P2 | A role is the lane (WB, LB, GF1, reset), the number of rounds before that lane's own final, and the game number in that round. The WB final keeps the WB final's slot, the LB final keeps the LB final's, GF1 keeps GF1's and the reset keeps the reset's, whatever the field size becomes. | W6 brief, carried 2 ("each lane counted back from its own final") | OWNER 299 |
| RB6-P3 | A role with no match in the old bracket starts unscheduled and is flagged to the desk (RB4-L12). A role with no match in the new bracket releases its slot. A role that is now a bye or dead line holds no slot (RB6-B4). | product rule | REC |
| RB6-P4 | Rebuild reuses the stored draw seed (RB4-D5) and applies §4's drops. It is offered only when no result exists (RB6-L6); a bracket with a result keeps its lines. | rulings 253, 295 | OWNER 295 |

**Product today (read).** Rebuild carries by role for knockout, stepladder and page playoff only. A double
elimination still matches by position, so a 4 → 5 Rebuild hands the grand final's slot to another line. It is pinned
as a known defect by `rebuild-one-transaction.test.ts` ("a double-elimination Rebuild still carries by position").

---

## 12. The match layer: each sport's own rules (ruling 11)

| id | rule | source | status |
|---|---|---|---|
| RB6-M1 | How a single match is won, what a walkover is worth, how a retirement or an abandonment is scored, and which decider ends a level match are each sport's rules. They are W2's rulebooks and are not restated here: `rulebook-W2-sets-cricket.md` (badminton §3, table tennis §4, volleyball §5, tennis §6, cricket §7) and `rulebook-W2-goals-boards.md` (football §1, hockey §2, ice hockey §3, boardgame §4, carrom §5, generic §6, cross-sport §7). | ruling 11 | OWNER 11 |
| RB6-M2 | Every double-elimination match needs a winner. No sport pays a level result into a table here. A level score is held as `needs_decision` for the organiser's settle; a generic one is refused with LEVEL_RESULT_IN_BRACKET. | X-DV-1 (`rules/cross-sport.md:56`), which names double elimination | OWNER 228 |
| RB6-M3 | **Boardgame takes no double-elimination rule of its own.** A drawn game in a bracket follows the knockout family's rule: RB4 §15 S5 (the boardgame bracket cells work, root cause SC-O1 closed by W2a) and RB2B-16 for the tie-break ladder. The truth run confirms it on this row. | ruling 299; `offered-matrix.md` reason b | OWNER 299 |
| RB6-M4 | The knockout "Third place" setting is not offered on a double-elimination stage. 3rd is always unique (RB6-R2). | ruling 266 read against ruling 297 | REC |
| RB6-M5 | A rules change attempted mid-match is refused, as everywhere (ruling 12). | design §4 M11 | OWNER 12 |

---

## 13. Entitlement

| id | rule | source | status |
|---|---|---|---|
| RB6-N1 | An organisation without `formats.double_elim` is refused when it creates or switches to a double elimination, with plain guidance naming the plan that has it. The cell is ⛔ refused, not 🚫 missing. | design §3; W6 brief | OWNER 299 |
| RB6-N2 | The gate is unchanged in W6. `page_playoff` shares the key and belongs to W4, so any change here re-runs W4's denied-state case. | ruling 299; W6 brief, trap 4 | OWNER 299 |
| RB6-N3 | A refused format change leaves the division's existing stages as they were. | W1b finding, routed to W9 (ruling 35) | ⏳ W9 |

---

## 14. Edge-case table (design §4 scenario ids applicable to double elimination)

**"today"** is the read-level prediction for the truth run, not an observation.

| ID | Scenario | Expected outcome (rule) | today |
|---|---|---|---|
| F2 | 0 or 1 entrants | Named refusal (RB6-E1, E2). | not read; generator returns no grand final (`bracket.ts:447`) |
| F2 | n=2, n=3 | RB6-E3, E4. | OWNER 304; n=2 generates today (`bracket.ts:507-511`) |
| F1, F3 | Odd field, non-power-of-two | WB byes (RB6-D2); dead LB seats (RB6-B1 to B4). | ✅ structure; ❌ carried 1 (a dead line can be scheduled) |
| F8 | Protected seeds | WB fold (RB6-D2); the LB is unseeded (RB6-D5). | ✅ predicted |
| FX-G4 | LB rematches | RB6-X1 to X7. | ❌ straight drops |
| FX-G3 | Reset not needed | RB6-G6. | ✅ since W4 (false premise 1) |
| — | Reset earned, then voided | Refused (RB6-G7). | ❌ the engine accepts the void |
| — | Reset setting in the builder | RB6-G1 to G3. | 🚫 API-only |
| M1 | Walkover in one match | One loss; drops (RB6-F1). | ❌ out today (X-DE-1) |
| M9a, M9b | Forfeit / award by the organiser | One loss; drops (RB6-F1, F2). | ❌ FX-G24 |
| M1 in LB | Forfeit by a side already in the LB | Out; ranked at that round (RB6-F3). | ✅ predicted |
| M2 | Double walkover, LB | Both out (RB6-F5). | ✅ predicted (X-DW-2) |
| M2 | Double walkover, WB | OWNER 301 (RB6-F7). | neither drops (X-DW-2) |
| M2 | Double walkover, GF1 or reset | Refused, stays open (RB6-F8). | ✅ predicted (X-DW-3); reset not read |
| M3 | Retirement mid-match | OWNER 302 (RB6-F11). | out today (X-DE-1) |
| M5 | Level result | Held for settle (RB6-M2, M3). | ✅ predicted (X-DV-1) |
| R2 | Late entry after Start | RB6-L3 → L5 → L6. | 🚫 start lock answers (false premise 3) |
| R10 | Waitlist / paid confirm / import / Reinstate after the draw | RB6-L7. | 🚫 as R2 |
| R4 | Withdrawal mid-bracket | Out at once; seats walk over (RB6-F4, F6); place RB6-R7. | ✅ predicted for seats; place OWNER 303 |
| R5 | Withdrawal after the entrant is already out | Status only; ranks unchanged (RB6-R1). | ✅ predicted |
| R6 | A qualifier from a table withdraws before playing here | Replaced from the table as RB4-V6; after their first match starts, a walkover. | not read |
| Q3 | Third place | No third-place match; 3rd unique (RB6-M4, R2). | not read |
| Q4a | Deciding match not played: joint winners | RB6-C5. | not read for GF1 or the reset |
| Q4b | Decided by seed or table | Never automatic (RB6-C6). | ✅ predicted |
| M2f | Both finalists withdrawn | Vacant title (RB6-C4). | not read |
| P4 | Rebuild after a field change | Slots stay with roles (RB6-P1 to P3). | ❌ carried 2 (by position) |
| ST-G33 | Ranks at every field size | RB6-R1 to R9. | ❌ shared places not built; "n=2 only" not re-pinned |
| M2 | Double walkover that empties 3rd or 4th | Shared by the formula; the stage completes (RB6-R10). | OWNER 305(d); ❌ predicted (the guard allows two holders at most) |
| — | Joint winners or a vacant title on GF1 with the reset on | No reset exists (RB6-G11). | ❌ joint winners are refused on a grand final today |
| — | A double walkover in the WB final, reset on | GF1 has no loser, no reset is owed, the LB champion is 1st and the WB finalists 2= (RB6-G11, R10). | not read |
| — | Auto-advance on a bracket that holds a void line (n=5), and on one whose reset was not needed | It advances (RB6-B3, G6). | ❌ predicted (the open count reads a void line as open) |
| — | GF1 settled without being played (a WB-final double walkover; a finalist who leaves while the other seat is open), reset on | The reset does not exist: void, never a credited win (RB6-G6, G11, C2). | ❌ predicted (the seat cascade would award it) |
| — | The public title when no reset is owed: joint winners, a vacant GF1, a GF1 with no loser, a walkover over an out WB champion | The title shows (RB6-G6, C2, C4, C5). | the walkover case ✅ today (read) and is the regression guard; the others not reachable today |
| — | The reset setting changed after Generate | Row added or removed; locked once GF1 has a result (RB6-G3). | OWNER 305(a); 🚫 no screen |
| DENIED | No `formats.double_elim` | ⛔ with guidance (RB6-N1). | ✅ predicted; stage loss on refusal is W9's (RB6-N3) |

The truth run also re-runs MB-007, MB-009 and MB-010, which carry no wave (false premise 8).

---

## 15. Items put to the owner — all signed 2026-11-23

Each was a question this rulebook could not settle from a ruling or a source. The owner approved every
recommendation below as written: **S1 = ruling 300, S2 = 301 (amends 294), S3 = 302, S4 = 303, S5 and S6 = 304,
S7 = 305(d) (amends 297), S8 = 305(a), S9 = 305(c).** Ruling 305(b) allows "Declare joint winners" on an earned
reset (RB6-C5), and 305(e) puts everything that needs engine 11.0.0 in app PR B. The text of each item is kept as
it was put.

Two points go slightly past the rulings' wording and stay the designer's reading (design §10): RB6-L4 names
"any LB line the reopened bye changes", where ruling 304 says "that bye's LB line"; and RB6-R10 shares a place
among three entrants where ruling 305(d) speaks of a double walkover's two sides.

- **S1 — Which published drop pattern (RB6-X1, X2).** The sources disagree. Smoothcomp's NCAA-type table (A1) and
  brackets-manager's defaults (A2) differ at 16, 64 and 128, and A1's own default ("Alternating") is a third
  pattern. **Recommendation:** A1's NCAA-type table, written as the four-step cycle of RB6-X2. It is the only one of
  the three that is best at every size counted (first possible rematch in LB round 3, 4, 5, 7, 8 at 8, 16, 32, 64,
  128), and one rule covers every size. Note that A1 lists sizes to 64; the cycle past 64 is our extension.
  *Owner value: players stop meeting the opponent they just lost to, and the bracket matches one a wrestling or
  esports organiser already knows.*
- **S2 — A double walkover in the winners' bracket (RB6-F7).** Ruling 294 says "each drops once", but one WB match
  feeds one LB seat, and the signed X-DW-2 says neither side drops. **Recommendation:** keep X-DW-2 here: both are
  out, the LB seat and the next WB seat each walk over. The alternative is that the better seed takes the LB seat
  and the other is out. *Owner value: no arbitrary pick between two sides who both failed to turn up, and no new
  rule to build for a rare event.*
- **S3 — A retirement mid-match (RB6-F11).** **Recommendation:** one loss, like a forfeit; the entrant drops and may
  play on (design §4 R14). If they cannot continue, the organiser withdraws them with one tap and every later seat
  walks over. *Owner value: an injured player who recovers keeps the second life the format promises.*
- **S4 — Where a withdrawn or disqualified entrant is placed (RB6-R7).** Ruling 297 shares places by LB round of
  exit, and an entrant who withdraws from the WB never has one. **Recommendation:** the LB round of the seat they
  vacate, sharing that round's place. *Owner value: the final table has no gaps and no special bottom row, and a
  withdrawal never outranks a player who lost on court later.*
- **S5 — Late entry into a bye whose LB line has moved on (RB6-L4).** Ruling 296 rules the WB side only.
  **Recommendation:** case (1) closes once any entrant who advanced by bye through an LB line that the reopened
  bye changes has started their next LB match; until then those byes are taken back. The server then tries the
  next bye, then case (2), then refuses. *Owner value: a late player never creates a loser with nowhere to drop,
  and nobody loses a match they have already started.* (Reworded after review 1: the changed line is not always
  the one the bye fed.)
- **S6 — Fields of 2 and 3 (RB6-E3, E4).** The structure is well defined and n=2 generates today.
  **Recommendation:** keep both offered, with no new refusal. *Owner value: an event whose field shrinks to two or
  three before Start still runs, as "beat them twice".*

- **S7 — Top places when a double walkover leaves a match unplayed (RB6-R1, R2, R10).** Ruling 297 says "1st to
  4th are unique". A double walkover can put two or three entrants out in one round near the top, and leave the
  match that decides 3rd or 4th with no loser. **Recommendation:** 1st to 4th are unique when the matches that
  decide them are played; otherwise the entrants out in the same round share the place by the same formula as
  below 4th, the next place is skipped, and the stage always completes. The alternative is to split them by seed,
  which ruling 297 removed below 4th. *Owner value: a no-show never blocks the organiser from closing the event,
  and no absent player is ranked above another by a number they were given before play.* **This amends how ruling
  297 reads, so it needs an explicit yes.**
- **S8 — How long the reset setting can change (RB6-G3).** The first draft said "until the stage starts".
  **Recommendation:** until GF1 has a result. Nothing before GF1 depends on the setting, and the change only adds
  or removes one unplayed match. *Owner value: an organiser who runs short of time on the day can drop the second
  final, or add it, without rebuilding the bracket.*
- **S9 — Where the dead-seat fix sits (RB6-B1 to B4; ruling 299).** Ruling 299 says the carry is fixed "at its
  one authority (`isByeLine` and its SQL twin)". Review 1 showed that a dead seat can come down a winner edge
  (RB6-B3), which a row-level predicate cannot see without walking the bracket. **Recommendation:** work the dead
  seats out from the draw at Generate and mark them on the rows, so the existing predicate and its twin answer
  with no change and no second copy of the rule (design §5.3). *Owner value: one place still decides what is
  never scheduled, and the 9-to-11 and 17-to-23 fields are covered, not only 5 to 7.* **This departs from the
  wording of ruling 299, so it is listed for a yes.**

**REC rows for the batch sign-off** (designer's calls, no open question): RB6-E1, E2, E5, E6; D1, D3, D5, D6; X3 to
X6, X8; B1, B2, B6; G2 (second sentence), G8, G9, G11; C2 (reset clause); R5; R8 (the reading of ruling 297 beside ruling 267); P3; M4.

**Rule rows this rulebook changes in the engine's `rules/cross-sport.md`:** X-DE-1 is overturned for forfeits and
kept for withdraw and disqualify (ruling 294); X-FR-3 ("a walkover loser is eliminated at that fixture for
ranking", `:151`) is narrowed to an entrant a walkover put out of the stage, because a double-elimination forfeit
loser in the WB is not out there; X-FR-1 and X-FR-2 gain the double-elimination shared places; X-DW-2's double-elimination clause is kept (ruling 301); new rows are owed for
structure, drop order, reset and ranks (false premise 7: none exist today).

**Citation still owed:** A1, A3 and A4 were read as extracted text. S1 is signed (ruling 300) and the rule was
confirmed by an independent script (review 1), but nobody has opened A1 itself. Someone should open A1 once
and confirm the 32 and 64 lists against RB6-X2's table.
