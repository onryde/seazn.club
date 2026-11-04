# Rulebook W4 — knockout family (knockout, knockout_third_place, ko_plate, qualifying_main, stepladder_only, page_playoff_only × 11 sports)

> **SIGNED 2026-11-04 — owner approved the design doc (ruling 274).**
> - Rows marked **OWNER 263–273** carry the W4 brainstorm rulings (Q2–Q8 were the owner accepting the designer's
>   recommendation), then 271–273 after the builder check (owner "ye"). Design §8 S1–S7 are signed by ruling 273.
> - Every row that was REC (designer's / controller's calls) is **signed by ruling 274** (owner: "approve and record
>   all rules", 2026-11-04) and reads OWNER 274.
> - Club separation rows stay **DEFERRED (ruling 272)**.
> - Primary-text article numbers for the BWF/ITTF/ITF citations (A1–A3) are still owed; the signature covers the rules,
>   not the citation text. Design of record: `../2026-11-04-format-matrix-w4-knockout-design.md`.

- **Date:** 2026-11-04 · **Wave:** W4 (design §8 of the programme) · **Rows:** `knockout`, `knockout_third_place`
  (knockout + third place), `ko_plate` (main draw → plate), `qualifying_main` (qualifying → main draw),
  `stepladder_only`, `page_playoff_only` × football, cricket, boardgame, carrom, generic, volleyball, badminton,
  tabletennis, tennis, icehockey, hockey = **66 cells**.
- **Inputs read:** the W4 gap register and its recon (`/Users/ashokhein/seazn-artifacts/w4-recon/`, app 97d22c8acd,
  engine 972a7c7 = 3.0.2); brief `W4-knockout.md`; `_RULES.md`; `_INDEX.md` rulings 6, 11, 19, 72–79, 83–92, 101,
  116, 117, 250–262.
- **How the code facts were established:** by reading, not driving, except where CI run 41861339582 shows red. Every
  behavioural "today" below is a hypothesis for W4's truth run (`_RULES.md` R5).
- **Rule ids:** `RB4-<area><n>`. These are rulebook ids. The engine rule rows get their own ids when they land (design
  §12; never `-KO-`).

---

## 1. Authority and citations

Ruling 11: federation rules first, product rules where no federation governs, and deliberate deviations recorded as
owner rulings.

| # | Source | Used for |
|---|---|---|
| A1 | **BWF** (Badminton World Federation) draw practice | seed bands (3–4, 5–8) placed by lot; the unseeded drawn by lot; same-association players separated by half/quarter; two bronze medals (no third-place match) |
| A2 | **ITTF** (International Table Tennis Federation) draw practice | same-association separation; two bronzes |
| A3 | **ITF** (International Tennis Federation) draw practice | seed bands placed by lot (consolation practice for tennis is cited from A4, not here) |
| A4 | **USTA First Match Consolation** ([USTA](https://customercare.usta.com/hc/en-us/articles/360057067332), [USTA voluntary consolation](https://customercare.usta.com/hc/en-us/articles/4496605367060-Voluntary-Consolation-draw)) | first-round losers plus second-round losers who reached R2 by a bye or default enter the consolation; a separate "first-round losers consolation" (FRLC) takes R1 losers only |
| A5 | **NZ badminton tournament plate conditions** ([2023 Canterbury Open NZ Tour](https://badminton.org.nz/wp-content/uploads/2022/12/2023-Canterbury-Open-NZ-Tour.pdf)) | the plate takes losers of their first match automatically; a player who defaults, withdraws or retires that match is not eligible |
| A6 | **Product rule** | where no federation source is given in the register; cited as "product rule (ruling N)" |
| A7 | **EBU plate events** ([EBU member wiki](https://www.ebu.co.uk/member-wiki/knockouts:plate-events)) | club practice: copy R1 losers, and with R1 byes also the R2 losers who had the bye |

**Citation status.** A4, A5 and A7 were read by the controller on 2026-11-04 (URLs above). A1–A3 record each
federation's *practice* from the controller's knowledge, not a read primary text: before sign-off, the primary text
and article number must be pinned for every A1–A3 row (BWF General Competition Regulations / draw regulations,
ITTF Handbook, ITF rules). Until then those rows cite the body by name only.

**Where no federation governs** (stepladder, page playoff, late entry into a drawn bracket, lucky losers in a
two-stage product template, joint winners as an organiser action, history re-ranking), the product rule is the
authority (ruling 11).

---

## 2. Empty and degenerate cases first (R13)

| id | rule | source | status |
|---|---|---|---|
| RB4-E1 | A knockout-family stage with 0 entrants refuses Generate with a named reason. It never answers "up to date" or an empty bracket. | product rule (R13) | OWNER 274 |
| RB4-E2 | n=1: the stage refuses Generate with a named reason ("a knockout needs at least 2 entrants"). | product rule | OWNER 274 |
| RB4-E3 | n=2: one final, no byes, no third place, no plate. | product rule | OWNER 274 |
| RB4-E4 | Knockout + Plate is not offered below n=4. The builder hides it, and the server refuses it, with a named reason in 4 locales. | product rule (ruling 265) | OWNER 265 |
| RB4-E5 | Third place (Shared / Play-off) is not offered below n=4. At n=3 the single semi-final loser ranks 3rd alone, and no third-place match is generated. | product rule (ruling 266) | OWNER 266 |
| RB4-E6 | A plate whose first-loss field, after exclusions, has fewer than 2 entrants completes with a named outcome ("Not enough first-match losers for a plate"), never an empty success. | product rule (R13) | OWNER 274 (designer's call) |
| RB4-E7 | An empty lucky-loser pool leaves the vacated slot to walk over (RB4-V3). | product rule (ruling 264) | OWNER 274 (designer's call) |
| RB4-E8 | "Keep same club apart" is hidden when no entrant in the stage has a club. | product rule (ruling 268) | DEFERRED (ruling 272) |

---

## 3. Draw: seeding fold, byes, random draw, club separation

Club separation (RB4-D7, D8, E8) is **DEFERRED by ruling 272**. Only teams carry a club (`team_details.club_id`,
V242:22), and every live knockout is individual or pair badminton, so a team-only toggle would be an inert seam. It is
owed to a future clubs follow-up that gives persons and pairs a club (schema, registration and import); W5's groups
consume it then. The rows keep Q6's shape for that follow-up. The random draw (RB4-D3, D4) stays in W4.

| id | rule | source | status |
|---|---|---|---|
| RB4-D1 | Seeded entrants are placed by the deterministic **fold** (1 top, 2 bottom, 3–4 and onward by the standard fold). Seed bands are **not** placed by lot. | product rule (ruling 268); **deviation** from A1/A3 (bands by lot) | OWNER 268 (deviation) |
| RB4-D2 | Byes go to the **top seeds first**, in seed order. A bye is an award to the real side, never a fixture on a court. | A1 (byes to seeds); product rule (ruling 268) | OWNER 268 |
| RB4-D3 | Unseeded entrants are drawn **at random** into the remaining positions, never in registration order. | A1 (draw by lot); ruling 268 | OWNER 268 |
| RB4-D4 | The draw's seed is **stored, shown and reproducible**: the same seed and the same entrants give the same bracket. The seed is the stage's own (W3 `swissDrawSeed`, `mulberry32`), recorded on the generate's ledger row. | product rule (ruling 268) | OWNER 268 |
| RB4-D5 | Rebuild reuses the stored seed. | product rule | OWNER 274 (designer's call) |
| RB4-D6 | An API-supplied `slotOrder` overrides the draw. `config.byes` and `config.slotOrder` stay API-only, with no organiser control. | product rule | OWNER 273 (§8 S4) |
| RB4-D7 | **Opt-in "Keep same club apart in round 1"**: where clubs are known, two entrants of the same club do not meet in round 1 where the draw can avoid it. | A1/A2 (association separation; the owner narrowed it to round 1 and to clubs); ruling 268 | DEFERRED (ruling 272) |
| RB4-D8 | Separation moves only **unseeded** entrants and never a seed's fold position. Where it cannot avoid a same-club pair, the draw keeps it and the desk says which pairs. | product rule | DEFERRED (ruling 272) |
| RB4-D9 | Country separation is not offered (no data). Any request for it is refused with a named reason. | product rule (ruling 268) | OWNER 268 |
| RB4-D10 | A plate draw and a main draw fed from a stage use the same rules: seeds by their source seed or rank on the fold, the rest drawn with the destination stage's seed. | product rule | OWNER 274 (designer's call) |

---

## 4. Late entry after Start

| id | rule | source | status |
|---|---|---|---|
| RB4-L1 | A late entrant is accepted only by a stage that is the division's **entry stage**: a root knockout, ko_plate's main bracket, or qualifying_main's qualifying bracket. | product rule (ruling 263) | OWNER 263 |
| RB4-L2 | A knockout fed from Swiss, league or groups never takes a late entrant. The entrant joins the entry stage under its rule (Swiss: ruling 250; league and groups: W5). ko_plate's plate and qualifying_main's main draw never take one either. | product rule (ruling 263) | OWNER 263 |
| RB4-L3 | **Case (1):** if a round-1 bye's holder has not started their round-2 match, the late entrant plays the bye holder in a new round-1 match. The bye is reversed, and nothing else moves. | product rule (ruling 263) | OWNER 263 |
| RB4-L4 | With several open byes, case (1) takes the **lowest-seeded** bye holder's bye (ties by draw position). This is the slot a fresh fold would give an (n+1)th unseeded entrant. | product rule | OWNER 274 (designer's call) |
| RB4-L5 | **Case (2):** otherwise, if a withdrawn entrant's round-1 slot is still before its first match, the late entrant takes it. Where the withdrawal has already walked the line over, the case stays open until the walkover's winner starts their next match, and the walkover is reversed. | product rule (ruling 263; reversal is the designer's call) | OWNER 263 (+ 274 for the reversal) |
| RB4-L6 | **Case (3):** otherwise the late entry is refused with a named reason ("Round 1 complete; no slot left"). If nothing in the stage has started (no result and no called match — the K4 predicate), the refusal offers Rebuild (one transaction, keeps times and courts, ruling 253). | product rule (ruling 263) | OWNER 263 |
| RB4-L7 | A late entrant **never joins round 2** or later. | product rule (ruling 263) | OWNER 263 |
| RB4-L8 | Stepladder and page playoff take case (2) only. (Under RB4-S6 they are never an entry stage, so this reaches only a standalone stage created over the API before the refusal shipped.) | product rule (ruling 263) | OWNER 263 |
| RB4-L9 | "Started" means a score event, live play, a decided result, or a Match Day call to a court. The same predicate serves late entry, the lucky loser and take-back. | product rule (ruling 257 by analogy) | OWNER 274 (designer's call) |
| RB4-L10 | **Automatic arrivals** (payment confirmation, waitlist promotion, import, Reinstate) into a started knockout are **never auto-placed**. The entrant lands on the entrant list with a desk flag ("1 late player waiting — add to bracket"), and one organiser tap runs RB4-L3 → L5 → L6. It is never refused and never silently unplaced. W3's "automatic arrivals never reshape a published round" holds for knockout. | product rule (ruling 263, amended by 271) | OWNER 271 |
| RB4-L11 | A late pair is the late entrant. A late partner is a lineup matter, not an entry. | product rule (W3 design §4) | OWNER 274 |
| RB4-L12 | The new round-1 match takes the next free slot. If there is none, it is unscheduled and flagged to the desk. | product rule (W3 design call 5) | OWNER 274 (designer's call) |
| RB4-L13 | "Add late player" has no Undo. Undo answers with a named refusal that points to Withdraw. | product rule (W3 design §10.8) | OWNER 274 (designer's call) |
| RB4-L14 | A late entrant in ko_plate's main bracket feeds the plate with their first loss, like anyone else (RB4-P1). | product rule (rulings 263, 265) | OWNER 274 |

---

## 5. Vacated seat: walkover or lucky loser

| id | rule | source | status |
|---|---|---|---|
| RB4-V1 | Inside a bracket, a vacancy in round 2 or later is a **walkover** to the opponent (unchanged; X-WD-*). | product rule (rulings 90, 264) | OWNER 264 |
| RB4-V2 | A **qualifier's** main-draw slot vacated before their first main-draw match has **started** takes a **lucky loser**: the highest-ranked qualifying-stage entrant below the cut (rank q+1, then q+2 …), ties by seed, then random. | product rule (ruling 264) | OWNER 264 |
| RB4-V3 | Once the qualifier's first main-draw match has started, the vacancy is a walkover. An empty lucky-loser pool also walks over. | product rule (ruling 264) | OWNER 264 (+ 274 for the empty pool) |
| RB4-V4 | The qualifying bracket plays to its own final (as today); "best loser" = best final rank below the cut q, read from the qualifying stage's final ranks. No early-stop engine option. | product rule | OWNER 274 (controller's call after builder check) |
| RB4-V5 | A loser by walkover, withdrawal or disqualification is not eligible as a lucky loser. The random tiebreak uses the destination stage's draw seed. | product rule | OWNER 274 (designer's call) |
| RB4-V6 | A departed qualifier from a **table** source (league, group, Swiss) is replaced by the next-ranked eligible entrant of that table, as W3 does for Swiss. | product rule (W3 cut backfill, extended) | OWNER 274 (designer's call) |

---

## 6. Plate (ko_plate)

| id | rule | source | status |
|---|---|---|---|
| RB4-P1 | The plate holds **everyone's first loss**: every round-1 loser, plus every bye holder who loses their first match (in round 2). | A3, A4, A5; ruling 265 | OWNER 265 |
| RB4-P2 | **Excluded:** a first loss by walkover, withdrawal or retirement. A disqualification is a withdrawal (ruling 259), so it is excluded too. | A5 (defaults excluded); ruling 265 (designer's call accepted) | OWNER 265 |
| RB4-P3 | The plate draws **after round 2**, once every first loss is known. It never waits for the main final. | product rule (ruling 265) | OWNER 265 |
| RB4-P4 | The plate takes every eligible first loss. There is no fixed count q, so no first loss is dropped at any n. | product rule (ruling 265) | OWNER 265 |
| RB4-P5 | The plate is proposed through the normal proposal/confirm flow the moment its field is known. With auto-progress on, it is confirmed automatically. | product rule | OWNER 274 (designer's call) |
| RB4-P6 | Every n the builder offers for Knockout + Plate completes its plate through the real usecases, or is refused up front. Neither outcome is a 409 at Complete. | brief (Match Day carry) | OWNER 274 |

---

## 7. Qualifying → main (qualifying_main)

| id | rule | source | status |
|---|---|---|---|
| RB4-Q1 | qualifying_main is two knockout stages: the qualifying bracket's top q (by final rank) fill the main draw. Direct acceptance plus a qualifier merge is not built. | product rule | OWNER 273 (§8 S1) |
| RB4-Q2 | On a knockout source, q is offered only at a whole round (1, 2, 4, 8 …), so a shared place (RB4-T2) never straddles the cut. | product rule | OWNER 273 (§8 S2) |
| RB4-Q3 | Qualifiers are seeded into the main draw by their qualifying rank, on the fold (RB4-D1/D10). | product rule | OWNER 274 |
| RB4-Q4 | A qualifier's vacated slot: RB4-V2/V3. | ruling 264 | OWNER 264 |
| RB4-Q5 | A correction inside a completed qualifying source (or ko_plate's main draw) makes every dependent proposal stale, draft or confirmed. Before the destination bracket starts: re-propose and re-confirm. After: the bracket stands and the desk warns. | W3 RB3-19 by analogy (ruling 252) | OWNER 273 (§8 S3) |
| RB4-Q6 | qualifying_main is offered only at field sizes where it completes; below that it is refused with a named reason. The bound is set by the QM-2 driving test. | product rule (R13) | OWNER 274 |

---

## 8. Third place

| id | rule | source | status |
|---|---|---|---|
| RB4-T1 | Every knockout stage has one setting, **"Third place: Shared (default) / Play-off match"**. The default is the same in every sport: no per-sport table. | product rule (ruling 266) | OWNER 266 |
| RB4-T2 | **Shared:** both semi-final losers rank **3rd**, and nobody ranks 4th. This holds on every surface (bracket, public page, hub, embed, `/present`, OG, standings API, history). | A1, A2 (two bronzes); ruling 266 | OWNER 266 |
| RB4-T3 | **Play-off match:** the two semi-final losers play for 3rd and 4th. The stage is **not complete** until that match is decided or settled. | product rule (ruling 266) | OWNER 266 |
| RB4-T4 | A third-place match is never generated where fewer than two semi-finals are real (one is a bye). A request for one there is refused with a named reason. | product rule (ruling 266) | OWNER 266 |
| RB4-T5 | The setting is editable until the stage starts, then read-only. | product rule (RB3-5 "play freezes it") | OWNER 274 (designer's call) |
| RB4-T6 | Third-place play-off with one side out: walkover. Both sides out: 3rd is vacant and both rank 4th. | product rule (ruling 267 by analogy) | OWNER 274 (designer's call) |

---

## 9. Champion, joint winners, vacant title

| id | rule | source | status |
|---|---|---|---|
| RB4-C1 | The champion is the winner of the decided final. There is exactly one champion, except in RB4-C3 and RB4-C4. | design §7.3 | OWNER 274 |
| RB4-C2 | One finalist out (withdrawn, disqualified): the final is a **walkover**, and the other finalist is champion. | product rule (rulings 90, 267) | OWNER 267 |
| RB4-C3 | **Both finalists out:** the title is **vacant automatically**. Both rank 2nd and nobody ranks 1st. It reverses itself if Reinstate or Undo restores a finalist. | product rule (ruling 267; supersedes X-DW-3's hold for this case) | OWNER 267 |
| RB4-C4 | **Final not played** (rain, time): the organiser action **"Declare joint winners"**. Both finalists rank 1st, and the bracket shows "Joint winners". The action is undoable. | product rule (ruling 267; closes RB2A-30 / CK-KO-1's hand-off) | OWNER 267 |
| RB4-C5 | An unplayed final is **never** decided by seed or by a table. | product rule (ruling 267) | OWNER 267 |
| RB4-C6 | "Declare joint winners" is offered on any final with no decided result: scheduled, abandoned awaiting settle, or held level (`needs_decision`). A cricket final held under CK-KO-1 is included, and settle stays offered beside it. | product rule | OWNER 274 (designer's call) |
| RB4-C7 | A bracket stage **completes only when every fixture is decided or settled**. Completing it with a fixture undecided is refused with a named reason (CH-1, AN-2). | product rule (R13; design §7.3 "nothing ends stuck") | OWNER 274 |
| RB4-C8 | A stage whose final is decided but which is not yet complete raises a desk attention ("Final decided — complete the stage"). Completing the competition WARNS (never refuses — it is also the quota-retire path, `competitions.ts:512-521`), listing open stages and offering to complete any bracket whose final is decided (AN-1). | product rule | OWNER 273 (§8 S6) |

---

## 10. Final ranks

| id | rule | source | status |
|---|---|---|---|
| RB4-R1 | A completed bracket's final ranks cover **every entrant of the stage exactly once** (withdrawn and disqualified included), as a permutation, **except** the declared shared places: RB4-T2 (two 3rds), RB4-C3 (no 1st, two 2nds), RB4-C4 (two 1sts), RB4-T6 (two 4ths). | design §7.3; rulings 266, 267 | OWNER 274 (OWNER for the shared places) |
| RB4-R2 | Below the semi-finals, ranks stay strict: elimination round, then seed, then entrant id (unchanged). | product rule | OWNER 273 (§8 S7; equal 5th by round declined) |
| RB4-R3 | A walkover loser is eliminated at that fixture for ranking. Ranks and seats agree: an entrant ranked out at a fixture is never seated in a later one. | product rule (X-DE-1 by analogy; engine `stage.ts:485-497`) | OWNER 274 |
| RB4-R4 | Ranks and the champion are recomputed under the current rule for every finished bracket. There is no frozen "old rules" rank (RB4-H1). | product rule (ruling 270) | OWNER 270 |

---

## 11. Stepladder and page playoff (as final stages)

| id | rule | source | status |
|---|---|---|---|
| RB4-S1 | **Stepladder** (top k from a table, k ≥ 2): the lowest two seeds play first. Each winner meets the next seed up, and the last rung is against seed 1. | product rule | OWNER 274 |
| RB4-S2 | **Page playoff** (exactly 4 from a table): Q1 = 1 v 2; E = 3 v 4; Q2 = loser of Q1 v winner of E; Final = winner of Q1 v winner of Q2. | product rule | OWNER 274 |
| RB4-S3 | A withdrawal from either **walks the remaining fixtures over**, as knockout does. It never voids them. | product rule (X-WD-2, ruling 90) | OWNER 274 (restates signed X-WD-2) |
| RB4-S4 | A withdrawn **stepladder** seed is ranked as the loser of the rung they were due to enter. Every seed appears in the final ranks. | product rule | OWNER 274 (designer's call; SL-1) |
| RB4-S5 | A withdrawn **page-playoff** entrant gets **no second life** on the loser edge. A Q1 withdrawal walks Q1 over, and then Q2 over to E's winner, and the withdrawn entrant ranks below everyone still in the stage. Tests assert who plays whom, not that the stage completed. | product rule (X-DE-1 by analogy) | OWNER 274 (designer's call; FX-G7) |

---

## 12. Standalone refusal

| id | rule | source | status |
|---|---|---|---|
| RB4-S6 | Stepladder and page playoff are **not offered standalone**. The server refuses with a named reason ("needs a table to seed from; add a league or groups first"). The matrix cells are ⛔ refused, not 🚫 missing. | product rule (ruling 269) | OWNER 269 |
| RB4-S7 | Both remain offered as final stages: league → stepladder (top N); league or Swiss → page playoff (top 4). | product rule (ruling 269; `format-templates.ts:166-212`) | OWNER 269 |

---

## 13. History

| id | rule | source | status |
|---|---|---|---|
| RB4-H1 | Finished brackets switch to the shared-3rd rule (RB4-T2). There is no freeze. Ranks derived on read recompute automatically, and stored ranks get a one-off LOUD migration. | product rule (ruling 270) | OWNER 270 |

---

## 14. Edge-case table (design §4 scenario ids applicable to the knockout family)

**"today"** is the read-level prediction for the truth run, not an observation.

| ID | Scenario | Expected outcome (rule) | today |
|---|---|---|---|
| R1 | Late entry before Start | Enrolled; Generate reconciles the draw (design §6.5). | ❌ FX-G2 (8 → 9 double seats) |
| R2 | Late entry after Start, entry stage | RB4-L3 → L5 → L6, in order. | 🚫 LE-1 |
| R2f | Late entry after Start, fed knockout | Refused here; joins the entry stage (RB4-L2). | ✅ predicted (refused today, wrong copy) |
| R10 | Waitlist / paid confirm / import / Reinstate after the draw | RB4-L10 (ruling 271): listed, flagged, placed on the organiser's tap. | ❌ K7 (LIKELY) |
| R4 | Withdrawal mid-bracket | Walkover (RB4-V1); ranks RB4-R3. | ✅ knockout; ❌ stepladder/page playoff (SL-1, FX-G7) |
| R6 | Qualifier withdraws after being seeded, before playing | Lucky loser (RB4-V2), else walkover. | ❌ K9 |
| Q3 | Third place | RB4-T1 … T6. | 🚫 3P-1 (API-only) |
| Q4a | Final not played: joint winners | RB4-C4. | 🚫 |
| Q4b | Final decided by table | ⛔ refused (RB4-C5). | 🚫 → ⛔ |
| Q5a/b | Plate with byes / odd n | RB4-P1 … P6. | ❌ FX-G14 |
| D4a | Same-club separation | DEFERRED (ruling 272): ⏳ clubs follow-up. | 🚫 → ⏳ |
| D4b | Same-country separation | ⛔ refused (RB4-D9). | 🚫 → ⛔ |
| M2f | Both finalists withdrawn | Vacant title (RB4-C3). | ❌ WD-CASC (Generate 500) |
| F1 | Odd field (byes) | RB4-D2; plate RB4-P1. | ✅ knockout; ❌ ko_plate |
| P3 | Generate after a roster change, before Start | Reconcile (design §6.5); no duplicate seat, no second final. | ❌ FX-G2 / MB-004 |
| C6 | Correction inside a completed knockout source | RB4-Q5. | ❌ FX-G16 |

---

## 15. Items for the owner — S1–S7 SIGNED 2026-11-04, ruling 273

The owner signed these, as recommended, after the builder check ("ye"), with S6 in its warning form (design §8). The
remaining REC rows are signed as one batch when the owner approves the design doc.

- **S1** keep qualifying_main's two-stage shape (RB4-Q1).
- **S2** a qualifying cut at whole rounds only (RB4-Q2).
- **S3** a correction inside a knockout source stales the proposal, draft and confirmed (RB4-Q5).
- **S4** byes and slot order stay API-only (RB4-D6).
- **S5** O6: the boardgame cells on the six rows → works (root cause SC-O1 closed by W2a; confirm in the truth run).
  Generic standalone page playoff → ⛔ under RB4-S6. F1 on `page_playoff_only` stays unfit (ruling 6).
- **S6** AN-1: desk attention plus a warning (not a refusal) on Complete competition (RB4-C8).
- **S7** ranks below 3rd stay strict (RB4-R2).

**Primary texts owed before sign-off:** the article numbers for every A1–A3 citation (§1); A4, A5, A7 carry read URLs.
