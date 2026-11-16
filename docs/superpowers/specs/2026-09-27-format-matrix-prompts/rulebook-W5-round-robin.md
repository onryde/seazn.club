# Rulebook W5 — round-robin family (league, triple_rr, league_ko, groups_ko, group_stepladder, group_playoffs, group_only, group_group_ko × 11 sports)

> **SIGNED 2026-11-06 — owner approved the design doc (ruling 285).**
> - Rows marked **OWNER 276–284** restate the W5 brainstorm rulings of 2026-11-05 (Q1–Q9, each the owner accepting
>   the designer's recommendation). Rulings 276–285 are recorded in `_INDEX.md` in this tree; re-check `origin/main`
>   before merging the ledger.
> - Rows marked **OWNER S1–S7 (2026-11-06)** were signed by the owner after the builder check, each per the
>   recommendation (§15).
> - Every row that was REC (the designer's calls, including the builder-check calls) is **signed by ruling 285**
>   (owner: "approve and record all rules", 2026-11-06) and reads OWNER 285. Design of record:
>   `../2026-11-05-format-matrix-w5-round-robin-design.md`.
> - Club separation rows stay **DEFERRED (ruling 272)**.
> - Primary-text article numbers for A1–A6 are owed; the signature, when it comes, covers the rules, not the citation
>   text.
> - **Revised 2026-11-16 against engine 9.0.0 (2cd842a) and app 97b184e2d9.** Owner ruling **286** (2026-11-16, "apply
>   your rec unequal pool"): unequal-pool normalisation is always on (§8). Rows marked **REC 2026-11-16 — owner to
>   confirm** were the designer's recommendations from the recon; the owner answered them the same day as rulings
  **287–290** (§16), and each such row now reads its ruling. The
>   "today" column of §14 is corrected where the recon found the behaviour already on main. Corrections with evidence:
>   design §13.

- **Date:** 2026-11-05 · **Wave:** W5 (design §8 of the programme) · **Rows:** `league`, `triple_rr`, `league_ko`,
  `groups_ko`, `group_stepladder`, `group_playoffs`, `group_only`, `group_group_ko` × football, cricket, boardgame,
  carrom, generic, volleyball, badminton, tabletennis, tennis, icehockey, hockey = **88 cells**. *2026-11-16: ruling 287
  deletes `triple_rr`; its row leaves the matrix, so W5 covers seven rows = 77 cells.*
- **Inputs read:** brief `W5-round-robin.md`; audits `audit-2026-09-27/FX-fixtures.md` (G1, G5, G15, G16, G17, G19,
  G21, G22) and `ST-standings.md` (G3, G5, G6, G14, G15, G17, G20, G23, G24, G28), app 782628af5; the W3-final truth run
  (`truth-runs/w3-final/ci/L3`, 2026-11-04); `_RULES.md`; `_INDEX.md` rulings 6, 11, 19, 183, 250–275 and the W5
  backlog; `rulebook-W3-swiss.md` §9 (R11, R12, C5, P4 hand-offs); `rulebook-W4-knockout.md` (RB4-D2, D4, L2, L11–L13,
  V3, V6).
- **How the code facts were established:** by reading, not driving, except where the W3-final L3 run shows ✅ or ❌. A
  read-only W5 recon ran on 2026-11-16 against 97b184e2d9 / 2cd842a (design §13); it re-read the "today" column but
  drove nothing, so every behavioural "today" below is still a hypothesis for W5's truth run (`_RULES.md` R5).
- **Rule ids:** `RB5-<area><n>`. These are rulebook ids. The engine rule rows get their own ids when they land (design
  §12; never `-KO-`).

---

## 1. Authority and citations

Ruling 11: federation rules first, product rules where no federation governs, and deliberate deviations recorded as
owner rulings. The per-sport tie-break cascades are W2d's (ruling 183) and are not restated here.

| # | Source | Used for |
|---|---|---|
| A1 | **UEFA** European Qualifiers / Euro final-tournament regulations | ranking of best third-placed (or Nth-placed) teams across groups of unequal size by discarding results against the lowest-placed team(s); group winners drawn against runners-up of other groups in the first knockout round |
| A2 | **FIFA** World Cup regulations | group winners and runners-up crossed in the round of 16; no same-group meeting before the semi-finals is a consequence of the fixed bracket, not a rule |
| A3 | **BWF** General Competition Regulations, round-robin practice | a player who withdraws from a round-robin event has all results deleted; group winners and runners-up crossed into the knockout; a pair may not change partners once play has started |
| A4 | **ITTF** Handbook, group practice | a player who withdraws from a group has results annulled; crossed placement from groups into the knockout |
| A5 | **The FA** Standard Code of Rules | a club withdrawing before completing 75 percent of its fixtures has its record expunged; after that, remaining fixtures are awarded to opponents |
| A6 | **FIDE** double round robin (Candidates) practice | every pair meets once per leg with colors reversed in the second leg |
| A7 | **Product rule** | where no federation source is given; cited as "product rule (ruling N)" |
| A8 | **The W3-final truth run** (CI 41818942253, L3, 2026-11-04) | read evidence for "today" where cited |

**Citation status.** A1–A6 record each body's *practice* from the controller's knowledge, not a read primary text.
Before sign-off the primary text and article number must be pinned for every A1–A6 row. Until then those rows cite the
body by name only. A8 is a read file.

**Where no federation governs** (late entry into a started round robin, the 50 percent threshold, the minimum pool
size, a points adjustment as an organizer action, frozen markers on a finished table), the product rule is the
authority (ruling 11).

---

## 2. Empty and degenerate cases first (R13)

| id | rule | source | status |
|---|---|---|---|
| RB5-E1 | A round-robin stage with 0 entrants refuses Generate with a named reason. It never answers "up to date" or an empty round. | product rule (R13) | OWNER 285 (designer's call) |
| RB5-E2 | n=1: the stage refuses Generate with a named reason ("a round robin needs at least 2 entrants"). | product rule | OWNER 285 (designer's call) |
| RB5-E3 | n=2: one fixture per leg, no bye. | product rule | OWNER 285 (designer's call) |
| RB5-E4 | A pool count that leaves any pool with fewer than 2 members is refused at Generate with a named reason that names a pool count that would work. The builder's estimate agrees. | product rule (ruling 279) | OWNER 279 |
| RB5-E5 | A group stage with 1 pool behaves as a league and still writes its pool id (FX-G22). | product rule | OWNER 285 (designer's call) |
| RB5-E6 | A cut larger than the field, or a best-Nth cut that no pool can supply, is refused with a named reason. | product rule (R13) | OWNER 285 (designer's call) |
| RB5-E7 | A best-Nth comparison over equal pools drops nothing; the sweep that proves RB5-U1 asserts it saw at least one unequal case (R25). (Today the flagged path drops the bottom one row even for equal pools, engine `competition/progression.ts:652-670`; this row is the change.) | product rule | OWNER 285 (designer's call) |
| RB5-E8 | "Adjust points" by 0, or without a reason, is refused with a named reason. | product rule | OWNER 285 (designer's call) |
| RB5-E9 | A catch-up placement that adds no fixture (the newcomer is already seated against everyone) is a named refusal, never an empty success. | product rule (R13) | OWNER 285 (designer's call) |

---

## 3. Generation

| id | rule | source | status |
|---|---|---|---|
| RB5-G1 | A league or pool is a round robin: every pair meets **exactly once per leg**. Legs run 1–8 as today. | A6; product rule | OWNER 285 (designer's call) |
| RB5-G2 | Home and away alternate by leg, and within a leg the home/away balance per entrant differs by at most 1 (as `roundrobin.ts` proves). | A6; product rule | OWNER 285 (designer's call) |
| RB5-G3 | An odd field has exactly one bye per round. The bye is **recorded** on the round, shown on the board and the public page, and never holds a court. | product rule (FX-G21) | OWNER 285 (designer's call) |
| RB5-G4 | Pools are filled by the seeded snake into the pool count the organizer chose. | product rule (today) | OWNER 285 (designer's call) |
| RB5-G5 | Unseeded entrants in a league or pool draw are ordered by the stage's stored draw seed, never by registration order, if the truth run shows registration order survives for round robin (FX-G17's round-robin half). | product rule (ruling 268 by analogy) | OWNER 285 (designer's call; conditional on the truth run) |
| RB5-G6 | `triple_rr` is **deleted** (owner, ruling 287: "in prod, no triple_rr, so blindly cleanup, delete it"). Scope, as the coordinator reads 287 (designer's call, not the owner's words): no template row and no detection branch (a lone league with `legs` ≥ 3 reads back as `league` with its leg count), no picker or builder control, no matrix row, no i18n keys or help copy; a door that accepts the key refuses it by name (none does today: the gallery answers 404 `unknown template`). `triple_rr` was detected, never stored, so there is no migration and no data cleanup. `legs` 1–8 stays as RB5-G1 has it (signed 285), so a `legs: 3` league is a league; the engine's `legs` input stays generic. | product rule (ruling 287; supersedes REC-1 and the 2026-11-06 "builds three legs" text) | OWNER 287 (2026-11-16) for the deletion; scope: designer's call (fix round 2) |
| RB5-G7 | Generate before Start reconciles by **(unordered pair, leg)**, scoped by pool: it adds every missing pair and drops a removed entrant's pairs. A second Generate with no roster change is a no-op that says so. Nothing is inserted twice. | product rule (design §6.6; W4 reconcile seam) | OWNER 285 (designer's call) |
| RB5-G8 | Rebuild is one transaction that keeps times and courts, and a league Rebuild keeps slots by position. | product rule (ruling 253; W3 X-RB-1) | OWNER 253 (restated) |
| RB5-G9 | A tie between teams in different pools that survives the best-Nth basis comparison is broken by the **sport's own declared cross-group cascade** (`crossGroup` order; its default is the sport's tiebreakers without the head-to-head steps), as the engine already does: a `seed` step gives the listed (seed) order; `lots` gives the engine's stored lots draw (`lotSeed(rngSeed, sorted ids)` fed to `shuffle`, stored once per members key and reused); a cascade with neither gives seed then id. No engine change. It applies only where ruling 281 does not decide: inside the cross-pool draw, rank ties are drawn with the stored draw seed (RB5-D3). | product rule (REC-2, narrowed 2026-11-16 fix round 1, re-worded by ruling 291; proved by a constructed enumeration over every template row with a best-Nth take, derived per sport cascade, fix rounds 2–3 — the harness's 21 W5 notes are re-judged by row, and those on rows without best-Nth are confirm-time table ties under the existing ladder) | OWNER 288 (2026-11-16), re-worded by OWNER 291 (2026-11-16) |

---

## 4. Late entry after Start

| id | rule | source | status |
|---|---|---|---|
| RB5-L1 | A late entrant is accepted only by a league or group stage that is the division's **entry stage** (or `group_group_ko`'s first tier), and only while that stage is not complete, even after the last drawn round has started. | product rule (ruling 276; S6) | OWNER 276, S6 (2026-11-06) |
| RB5-L2 | A bracket fed from a table never takes a late entrant (RB4-L2). The entrant joins the table stage under this section. | product rule (rulings 263, 276) | OWNER 276 |
| RB5-L3 | **Case (1), catch-up:** the newcomer is seated and owes one fixture per leg against every entrant in their pool (or the league). A fixture whose opponent holds the bye in a **future** round lands in that round. Every other owed fixture is appended as a **catch-up round** after the last drawn round, one fixture per round, labeled "Catch-up". | product rule (ruling 276) | OWNER 276 |
| RB5-L4 | Finished rounds are never changed, and round numbers are never rewritten. | product rule (ruling 276) | OWNER 276 |
| RB5-L5 | The newcomer's record is **not leveled**: no missed round is scored as a loss. The row is marked "Joined round N" until the catch-up rounds are done. | product rule (ruling 276) | OWNER 276 |
| RB5-L6 | Catch-up rounds follow the order of the rounds the opponents already played; every leg owes its fixture; home and away alternate as RB5-G2. | product rule | OWNER 285 (designer's call) |
| RB5-L7 | **Case (2):** if nothing in the stage has **started** (RB5-L11), in-place reshaping is refused and the refusal offers Rebuild (RB5-G8). | product rule (ruling 276) | OWNER 276 |
| RB5-L8 | **Case (3):** a complete stage refuses a late entrant with a named reason that points to the next stage. | product rule (ruling 276) | OWNER 276 |
| RB5-L9 | For a group stage the add form carries a **pool picker**, defaulting to the smallest pool (ties: the pool the seed snake would give the (n+1)th seed). The organizer may change it. | product rule (ruling 276) | OWNER 276 |
| RB5-L10 | **Automatic arrivals** (payment confirmation, waitlist promotion, import, Reinstate) into a started league or groups are **never auto-placed**. The entrant lands on the entrant list with a desk flag, and one organizer tap runs RB5-L15. It is never refused and never silently unplaced. The enroll door is the organizer's own add and runs the cases directly. A Reinstate of an entrant whose lines still exist restores them under RB5-W6 and never waits; only a Reinstate with no lines in the started stage waits here. | product rule (rulings 271, 276) | OWNER 276 |
| RB5-L11 | "Started" means a score event, live play, a decided result, or a Match Day call to a court (W4's K4 predicate). | product rule (RB4-L9) | OWNER 285 (designer's call) |
| RB5-L12 | A late pair is the late entrant. A late partner is a lineup matter, not an entry. | product rule (RB4-L11) | OWNER 285 (designer's call) |
| RB5-L13 | New catch-up fixtures are unscheduled and flagged to the desk. | product rule (RB4-L12) | OWNER 285 (designer's call) |
| RB5-L14 | "Add late player" has no Undo. Undo answers with a named refusal that points to Withdraw. | product rule (RB4-L13) | OWNER 285 (designer's call) |
| RB5-L15 | The cases are tried in order: complete → RB5-L8 refuse; nothing started (RB5-L11) → RB5-L7 Rebuild offered, with catch-up as the alternative on the same notice; otherwise → RB5-L3 catch-up. | product rule | OWNER 285 (designer's call) |
| RB5-L16 | Two late entrants in one pool owe each other a fixture (RB5-G1), placed by the same policy as RB5-L3. | product rule | OWNER 285 (designer's call) |
| RB5-L17 | Before Start, Generate on a group stage re-snakes every pool in one transaction (RB5-G4, G7), with times and courts carried by surviving pair. The pool picker (RB5-L9) exists only after Start, once the pools are published. Rebuild under RB5-L7 re-snakes too, and the notice says so. | product rule | OWNER 285 (designer's call) |

---

## 5. Withdrawal from a table

| id | rule | source | status |
|---|---|---|---|
| RB5-W1 | An entrant who leaves the stage for good (withdrawn, or disqualified: ruling 259) **stays in the table**, marked, ranked last, on every surface. | product rule (ruling 277) | OWNER 277 |
| RB5-W2 | **Under half of their scheduled matches played:** every result they played is **removed**, finalized ones included, and every unplayed fixture is **voided**, never a walkover. | product rule (ruling 277) | OWNER 277 |
| RB5-W3 | **Half or more played:** every result stands, and every unplayed fixture is a **walkover** to the opponent at the sport's declared walkover score. | product rule (ruling 277); W2 SC-S rows for the score | OWNER 277 |
| RB5-W4 | "Scheduled matches" counts the entrant's fixtures in the stage across every leg at the moment of withdrawal, catch-up fixtures included; decided or finalized counts as played, voided does not. | product rule | OWNER 285 (designer's call) |
| RB5-W5 | A disqualification uses the same rule as a withdrawal. | product rule (ruling 259) | OWNER 285 (designer's call) |
| RB5-W6 | Reinstate reverses the expunge or the walkovers: voided fixtures and never-played walkovers return to scheduled, and nothing is reshaped, because the entrant's lines still exist. A Reinstate of an entrant with no lines in a started stage is RB5-L10. | product rule (W3 Swiss reinstate by analogy) | OWNER 285 (designer's call) |
| RB5-W7 | The table footnote names the rule applied ("Results removed: left after 2 of 5" or "Remaining fixtures walked over"). | product rule | OWNER 285 (designer's call) |
| RB5-W8 | **Deviation:** BWF (A3) and ITTF (A4) delete a withdrawn player's results whenever they leave; the FA (A5) expunges below 75 percent. The product keeps one rule for every sport at 50 percent. | A3, A4, A5; ruling 277 | OWNER 277 (deviation) |
| RB5-W9 | A mid-match retirement (M3) and a single no-show (M1) are W2's rules: a loss or a walkover in that fixture only. They never trigger this section. | W2 rulebook | OWNER 285 (restates W2) |
| RB5-W10 | A player's own withdrawal after Start (ruling 111; the public status pages) goes through this section's withdrawal, with its phase check and cascade — one door. | rulings 111, 277 (REC-4) | OWNER 288 (2026-11-16) |
| RB5-W11 | A disqualification recorded on the pad or by the organiser during a match withdraws the entrant from the stage under this section (engine X-RT-1's "the cascade is W5" is re-worded to point here). Before confirming, the Disqualify action shows plain copy naming the consequence: which remaining fixtures are withdrawn, whether played results stand or are expunged under RB5-W2/W3 (with this entrant's actual count), and whether it can be undone, in 4 locales; the copy's numbers come from the same decision the cascade applies. | rulings 259, 277, 289 (REC-7) | OWNER 289 (2026-11-16) |
| RB5-W12 | Badminton follows this section like every sport: BD-WO-2 and BD-RT-1 drop "until W5" and are re-worded as a **permanent recorded deviation** from BWF GCR 16.2.5 (its delete-all is not applied). Tennis follows this section too, with no tennis row (none of its rules differs; RB2A-3's "ineligible for the knockout" does not apply to a league or group withdrawal). No sport-specific withdrawal code. | rulings 86, 277, 290 (REC-8 option A) | OWNER 290 (2026-11-16) |

---

## 6. The cut into a knockout

| id | rule | source | status |
|---|---|---|---|
| RB5-K1 | A withdrawn or disqualified entrant **leaves the knockout cut** on any completion: setup seeding excludes them, and on-complete `config.qualified` excludes them. | product rule (ruling 278; W3 T15 for Swiss) | OWNER 278 |
| RB5-K2 | The **next eligible entrant** in the table takes the seat. For a best-Nth cut the cross-pool comparison (RB5-U1) is recomputed without the departed entrant. | product rule (ruling 278) | OWNER 278 |
| RB5-K3 | The public page stops naming a departed entrant as a qualifier. The table keeps their row, marked. | product rule (ruling 278) | OWNER 278 |
| RB5-K4 | "Eligible" excludes withdrawn and disqualified entrants. | product rule | OWNER 285 (designer's call) |
| RB5-K5 | Once the knockout's first match has **started**, a departure is RB4-V3's walkover, not a backfill. | product rule (RB4-V3) | OWNER 285 (designer's call) |
| RB5-K6 | A departure or a result correction inside a completed league or group source stales every dependent proposal, draft or confirmed. Before the destination starts: re-propose and re-confirm. After: the bracket stands and the desk warns. | W3 RB3-19 by analogy; W4 RB4-Q5 (S5) | OWNER S5 (2026-11-06) |
| RB5-K7 | The destination side (a departed qualifier from a table source replaced by the next-ranked eligible entrant) is W4's RB4-V6. W5 proves both halves with one driving test per row. | RB4-V6 | OWNER 274 (restated) |

---

## 7. Pools

| id | rule | source | status |
|---|---|---|---|
| RB5-P1 | A pool's membership is **every seated entrant**, from day one, with zero played. A pool table never lists fewer entrants than are seated. | product rule (ruling 279; ST-G5) | OWNER 279 |
| RB5-P2 | The minimum pool size is **2** (RB5-E4). The rulebook records 3 as the federation norm for a mini-league; 2 is the product floor (deviation). | product rule (ruling 279; S7) | OWNER 279, S7 (2026-11-06) |
| RB5-P3 | A single pool writes its pool id (RB5-E5). | product rule | OWNER 285 (designer's call) |
| RB5-P4 | Board cards for pooled fixtures carry the pool letter. | product rule (FX-G19) | OWNER 285 (designer's call) |
| RB5-P5 | Rank override is scoped **per pool**: a rank may be pinned once per pool, and an override above the pool's size is refused at write, never thrown at a later recompute. | product rule (ST-G14) | OWNER 285 (designer's call) |
| RB5-P6 | Who sits out each round is recorded and shown (RB5-G3). | product rule (FX-G21) | OWNER 285 (designer's call) |
| RB5-P7 | A rank override on a stage that is not a table stage is refused with a named reason, and the public page does not report an override there. | product rule (P7; REC-6) | OWNER 288 (2026-11-16) |

---

## 8. Unequal pools

| id | rule | source | status |
|---|---|---|---|
| RB5-U1 | When a cut compares Nth-placed entrants across pools of different sizes, every candidate from a larger pool has their results against that pool's **bottom k** entrants left out, k = the size difference, so every candidate is compared on the same number of matches. | A1; ruling 280 | OWNER 280 |
| RB5-U8 | RB5-U1 is **always on**. It never depends on a per-stage flag: `normaliseUnequalPools` is accepted and ignored (kept in the schemas so stored configs parse; deprecated), and best-Nth over unequal pools is never refused for the size difference (the `SEEDING_BESTNTH_UNEQUAL_POOLS` refusal goes for this case). | product rule (ruling 286) | OWNER 286 (2026-11-16) |
| RB5-U2 | The reduced result set then runs the per-sport cross-pool cascade (W2d, ST-G4). | ruling 183 | OWNER 280 |
| RB5-U3 | The basis is shown on the table and in the progression panel ("compared on 3 matches; results v 5th in Pool B not counted"). | product rule (ruling 280) | OWNER 280 |
| RB5-U4 | The bottom entrant of a pool is the one that pool's own cascade ranks last, stored lots included. | product rule | OWNER 285 (designer's call) |
| RB5-U5 | An entrant expunged under RB5-W2 is already out of everyone's results; nothing more is dropped for them. | product rule | OWNER 285 (designer's call) |
| RB5-U6 | Equal pools drop nothing (RB5-E7), with or without the deprecated flag (RB5-U8). | product rule | OWNER 285 (designer's call); 286 |
| RB5-U7 | k per candidate = that candidate's pool's effective size minus the smallest effective size among the pools that supply a candidate. Effective size is after RB5-W2 expunges. Applied unconditionally (RB5-U8). | product rule | OWNER 285 (designer's call); 286 |

---

## 9. The draw into the knockout

| id | rule | source | status |
|---|---|---|---|
| RB5-D1 | Entrants from the same pool **never meet in round one** of a knockout fed from groups. | A1, A2, A3; ruling 281 | OWNER 281 |
| RB5-D2 | Placement goes by rank, then **pool rotation** (A1 v B2, B1 v A2; three pools top two: A1 v C2, B1 v A2, C1 v B2), on the fold. | product rule (ruling 281) | OWNER 281 |
| RB5-D3 | Where ranks tie across pools, the order is drawn with the destination stage's stored, shown, reproducible draw seed. | RB4-D4; ruling 281 | OWNER 281 |
| RB5-D4 | Where separation is impossible, Generate refuses with a named reason. Impossible means no ordering of the rank tiers separates every round-one pair; "one pool supplies more than half the draw" is one such case. | product rule (ruling 281) | OWNER 281 |
| RB5-D10 | The rotation is found by swapping entrants **within a rank tier** (runners-up among runners-up, best-Nth among best-Nth), searching tier orderings in pool order with ties by the stored seed. Pool winners keep their fold positions. The search is exhaustive over the tiers. With two pools, the winners plus the best runner-up into a 4-draw or a 3-stepladder (A1, B1, B2) is therefore refused, and stays refused. | product rule | OWNER 285 (designer's call); the A1/B1/B2 refusal confirmed by OWNER 288 (REC-12, 2026-11-16) |
| RB5-D11 | The reference checks legality (no same-pool round-one pair) and existence (a separating ordering exists, so the product must find one), as W3's Swiss oracle does. | design §7.2 | OWNER 285 (designer's call) |
| RB5-D5 | Round two onward follows the fold; same-pool entrants may meet. | A1, A2; ruling 281 | OWNER 281 |
| RB5-D6 | Byes go to the top-ranked qualifiers first (RB4-D2), and the rotation accounts for byes so a bye never forces a same-pool pair in round one. | RB4-D2; product rule | OWNER 285 (designer's call) |
| RB5-D7 | The rotation is deterministic given ranks and pool letters: Rebuild reproduces the draw. | product rule | OWNER 285 (designer's call) |
| RB5-D8 | A stepladder or page playoff fed from groups takes the same rotation for its first rung. | product rule | OWNER 285 (designer's call) |
| RB5-D9 | Opt-in club separation in pool draws keeps Q6's shape and is built by the clubs follow-up. | ruling 272 | DEFERRED (ruling 272) |

---

## 10. The table on every surface

| id | rule | source | status |
|---|---|---|---|
| RB5-T1 | At completion the live Through / Needs help computation stops and the cut line and markers **freeze**. | product rule (ruling 283; amends the 2026-09-22 qualification spec §3.3) | OWNER 283 |
| RB5-T14 | The frozen markers read **who actually went through**: the confirmed proposal or `config.qualified` where one exists, else the final table's cut. A settled tie, a correction after completion or a backfill (RB5-K2) updates them on read. | product rule | OWNER 285 (designer's call) |
| RB5-T2 | Frozen markers read **"Qualified"** and **"Out"** (not "Through" / "Needs help"). | product rule (ruling 283) | OWNER 283 |
| RB5-T3 | The frozen cut reads the same on the division page, hub, embed, `/present`, export and OG. | product rule (ruling 283) | OWNER 283 |
| RB5-T4 | RB5-T1 applies to every table stage with a cut: league, group and Swiss, including tables completed before W5 ships. Derived on read; no migration. | product rule (S3) | OWNER S3 (2026-11-06) |
| RB5-T5 | **"Adjust points"** is a desk action on any league, group or Swiss entrant: plus or minus N points with a **required reason**. | product rule (ruling 284) | OWNER 284 |
| RB5-T6 | It is undoable (a ledger row), and hidden on bracket stages. | product rule (ruling 284) | OWNER 284 |
| RB5-T7 | It folds as an opening delta before the cascade, and every surface shows it as a footnote under the table with its reason and date. | product rule (ruling 284) | OWNER 284 |
| RB5-T8 | On a Swiss stage the adjusted score drives the next pairing. | product rule (S2) | OWNER S2 (2026-11-06) |
| RB5-T9 | The adjustment is a ledger row (entrant, delta, reason, date, actor), never stage config. `carry_deltas` and `FORMAT_LOCKED` stay as they are; Undo is the ledger's undo. | product rule | OWNER 285 (designer's call) |
| RB5-T15 | N adjusts the sport's `points` metric, whatever the sport counts as points (league points; a match's worth where points are matches won). | product rule | OWNER 285 (designer's call); the "no points metric refuses" clause dropped by OWNER 288 (REC-11, 2026-11-16: every table folds `points`) |
| RB5-T10 | Hub tables carry the withdrawn and disqualified chip, as the division page does. | product rule (ST-G20) | OWNER 285 (designer's call) |
| RB5-T11 | Export writes every pool of a pooled stage, with derived columns and localized headers. | product rule (ST-G24) | OWNER 285 (designer's call) |
| RB5-T12 | Recap and digest posts include pooled standings. | product rule (ST-G6) | OWNER 285 (designer's call) |
| RB5-T13 | The standings API declares its response shape, lists a pooled stage's pools, and names withdrawn rows. | product rule (ST-G23, ST-G28) | OWNER 285 (designer's call) |

---

## 11. Roster rules

| id | rule | source | status |
|---|---|---|---|
| RB5-R1 | A **duplicate entrant** (the same person twice, R11a; one person in two pairs in one division, R11b) is refused at add with a named reason. | product rule (W3 rulebook hand-off) | OWNER 285 (designer's call) |
| RB5-R2 | A pair that loses one partner **withdraws as the entrant** under §5 (R12b). The remaining player may enter again in a new pair as a late entrant under §4, with a fresh record. | A3 (no partner change after play starts); ruling 282 | OWNER 282 |
| RB5-R3 | A substitute partner on a pair entrant (R12a) is refused with a named reason and routed ⏳ to the lineup work. | product rule (ruling 282) | OWNER 282 |

---

## 12. Builder and lifecycle

| id | rule | source | status |
|---|---|---|---|
| RB5-S1 | `group_only` (groups with no second stage) is offered by the division builder's format picker. | product rule (S1) | OWNER S1 (2026-11-06) |
| RB5-S2 | `group_group_ko` is offered through the template gallery: the "T20 Super 8" shape (group → group, snake-seeded → knockout) generalized to any sport and any field that divides cleanly. It has no format-picker control, and no cell is dropped. | product rule (S1) | OWNER S1 (2026-11-06) |
| RB5-S3 | The builder's estimate and the server agree on every refusal in this rulebook (RB5-E4, E6). | product rule | OWNER 285 (designer's call) |
| RB5-S4 | A second `POST /stages/:id/complete` is a no-op that says so; it never mints a second seed proposal. The harness no longer avoids the second call. | product rule (bench finding; R27) | OWNER 285 (designer's call) |
| RB5-S5 | Add match lands in the round the organizer picks, defaulting to the latest round where neither side plays, never a new round per match. | product rule (FX-G15) | OWNER 285 (designer's call) |

---

## 13. History

| id | rule | source | status |
|---|---|---|---|
| RB5-H1 | No live league or group table exists (owner census 2026-11-05: one finished Swiss → knockout). Every rule here applies to every table from the release, and RB5-T4 reaches the finished live Swiss table on read. No migration is owed. | product rule | OWNER 285, S3 |

---

## 14. Edge-case table (design §4 scenario ids applicable to the round-robin family)

**"today"** is the read-level prediction for the truth run, or the W3-final L3 state where cited (A8).

| ID | Scenario | Expected outcome (rule) | today |
|---|---|---|---|
| R1 | Late entry before Start | Enrolled; Generate reconciles by (pair, leg) (RB5-G7). | ❌ FX-G1 (#879: duplicates and gaps) |
| R2 | Late entry after Start, entry stage | RB5-L3 catch-up, L7 Rebuild offered, L8 refused, in order. | 🚫 LE-3 |
| R2f | Late entry after Start, bracket fed from a table | Refused there; joins the table (RB5-L2). | ✅ predicted (refused today, wrong copy) |
| R10 | Waitlist / paid confirm / import / Reinstate after Start | RB5-L10: listed, flagged, placed on the tap. | ❌ LE-4 (LIKELY: un-fixtured entrant) |
| R4 | Withdrawal mid-stage (default) | RB5-W1–W3. | ✅ A8 (all eight rows) |
| R4a | Under half played, none finalized | Total expunge, rest voided (RB5-W2). | ✅ predicted |
| R4b | Half or more played | Results stand, rest walked over (RB5-W3). | ✅ predicted |
| R4c | Under half played, some finalized | Total expunge including finalized (RB5-W2). | ❌ ST-G15 |
| R5 | Withdrawal after all their matches | Results stand; nothing to void (RB5-W3 with zero unplayed). | ✅ predicted |
| R6 / Q2 | Qualifier withdraws before the knockout starts | Leaves the cut; next eligible backfills (RB5-K1–K3). | ✅ predicted (2026-11-16: built by W4 T13, `lib/table-withdrawal.ts:61`; was ❌ CUT-1) — verify per row |
| R7 | Disqualification | As withdrawal (RB5-W5). | ⬜ → ruled |
| R11a/b | Duplicate entrant | Refused at add (RB5-R1). | ✅ predicted (2026-11-16: `PERSON_ON_OTHER_TEAM` 409, `server/usecases/entrants.ts:195`) — pin |
| R12a | Doubles partner substitute | ⛔ refused (RB5-R3). | 🚫 → ⛔ |
| R12b | Pair dissolved | Pair withdraws (RB5-R2). | UNVERIFIED |
| M1 | Single walkover | W2's rule; table unaffected beyond the fixture. | ✅ A8 |
| F1 | Odd field | One bye per round, recorded (RB5-G3). | ✅ A8 (bye not recorded: FX-G21 — the engine emits `rounds[].bye`, the app's `roundRobinGen` drops it; #850 is the same defect) |
| F1 (pool of one) | 7 entrants, 4 pools | ⛔ refused (RB5-E4). | ❌ ST-G5 / PO-1 (`group_group_ko` ×11) on the W3-final run; since C38 (96aae0f7e6) the first draw is refused as `group_too_few_entrants` without a named count — re-baseline |
| F2 | Field below minimum | Refused (RB5-E1, E2, E4). | ⬜ |
| F4 | Unequal pools, best-Nth cut | Bottom results dropped, always on; basis shown (RB5-U1–U3, U8). | ❌ ST-G3 (refused without the flag; k = 1 with it) |
| F5a/b, F6, F7 | Ties | W2d cascades; stored lots. | ✅ (W2d) |
| P1 | Complete with a fixture pending | Refused with a named reason (W4 RB4-C7 by analogy for tables). | ⬜ |
| P3 | Generate after a roster change, before Start | RB5-G7. | ❌ FX-G1 |
| P4 | Rebuild after results | RB5-G8 (W3's fix). | ✅ predicted (a red is W3's) |
| P7 | Rank override, pooled | Per pool (RB5-P5); refused on a non-table stage (RB5-P7). | ❌ ST-G14 (the engine already scopes locks per pool; the app's write check is whole-body) |
| Q1a/b | Qualifier by lots / organizer, then corrected after the draw | RB5-K6. | ❌ FX-G16 (table half) |
| D4a | Same-club separation in pools | DEFERRED (ruling 272). | 🚫 → ⏳ |
| X2 | Event cut short; table from an incomplete stage | Standings as they stand; markers freeze at completion (RB5-T1). | ⬜ |
| C5 | Points deduction | RB5-T5–T9. | 🚫 → built |
| C6a | Correction after the stage is complete | Recompute; frozen markers update on read from the confirmed qualification (RB5-T14); proposals stale (RB5-K6). | ❌ FX-G16 (table half) |
| LIFECYCLE | Every row, default config | Works. | ✅ A8, except `group_group_ko` F1 |
| Groups → KO draw | Three pools top two | No same-pool round one (RB5-D1). | ❌ FX-G5 |

---

## 15. Items for the owner — S1–S7 SIGNED 2026-11-06

The owner signed each one per the recommendation, one at a time, after the builder check (design §8). The remaining
REC rows were signed as one batch by ruling 285 on 2026-11-06 ("approve and record all rules").

- **S1** SIGNED 2026-11-06: `group_only` in the format picker; `group_group_ko` as a sport-agnostic gallery template
  (RB5-S1, S2).
- **S2** SIGNED 2026-11-06: Swiss pairs on the adjusted score under "Adjust points" (RB5-T8).
- **S3** SIGNED 2026-11-06: frozen markers reach the live tournament's finished Swiss table on read (RB5-T4, H1).
- **S4** SIGNED 2026-11-06: boardgame cells on the four groups-plus-bracket rows and generic `group_playoffs` →
  works (A8 shows ✅; SC-O1 closed by W2a); W5's truth run re-confirms. F1 on every row works by bye, never unfit.
- **S5** SIGNED 2026-11-06: a departure or correction inside a completed table source stales the proposal, draft and
  confirmed (RB5-K6).
- **S6** SIGNED 2026-11-06: the late-entry window runs until the table stage completes (RB5-L1).
- **S7** SIGNED 2026-11-06: the minimum pool size stays 2 (RB5-P2).

**Primary texts owed before sign-off:** the article numbers for every A1–A6 citation (§1).

## 16. Revision 2026-11-16: ruling 286 and the recommendations

- **Ruling 286 (OWNER, 2026-11-16):** unequal-pool normalisation always on (RB5-U8; U6 and U7 amended).
- **REC 2026-11-16 — as first written, answered the same day by rulings 287–290** (design §10 REC-1..REC-10): RB5-G6's reading (REC-1), RB5-G9
  (REC-2), RB5-W10 (REC-4), RB5-W11 (REC-7), RB5-W12 (REC-8), RB5-P7 (REC-6); the clause notes on RB5-T15 (REC-11)
  and RB5-D10 (REC-12). REC-5 (#837), REC-9 (ST-G4/12/13
  routing) and REC-10 (quick match `league_ko` regression) are tasks, not rules, and add no row.
- **Fix round 1 (2026-11-16):** RB5-G9 narrowed to where ruling 281 does not decide (REC-2 reworded; the cross-pool
  draw takes the stored draw seed for rank ties, RB5-D3). New recommendations **REC-11** (drop RB5-T15's "no points
  metric" clause) and **REC-12** (keep RB5-D10's two-pool winners-plus-best-runner-up refusal) — owner to confirm. The
  engine plan's canonical rule-id table maps every row here to an `X-…` id (the ⬜ marks this bullet first gave the REC
  rows were lifted by rulings 287–290, next bullet).
- **Open owner question (REC-3), not built in W5:** a box league (`group_only` with parallel boxes) — should the public
  page crown one champion over all boxes, one per box, or none? W4's `championIds` does not address `group_only`.
- **Owner rulings 2026-11-16, after fix round 1:** **287** `triple_rr` deleted (RB5-G6 re-signed; 77 cells);
  **288** REC-2..REC-6 and REC-9..REC-12 confirmed (RB5-G9, W10, P7, D10's refusal, T15's clause dropped) plus the
  rows-only 9.1.0 release and the storage calls (the plan names writer, reader and cleanup for each field); **289**
  REC-7 with the clear-instruction condition (RB5-W11); **290** REC-8 option A (RB5-W12). No row here reads "owner to
  confirm" any more. Engine ids: G6 → X-RR-6, G9 → X-PD-8, W10 → X-WDT-9, W11 → X-WDT-10 (+ X-RT-1 amendment), P7 →
  X-PO-4, W12 → BD-WO-2 / BD-RT-1 amendments (no tennis row).
- **Fix round 2 (2026-11-16, review-2; decisions sheet G1–G8):** ruling 287 is cited in the owner's words only ("in
  prod, no triple_rr, so blindly cleanup, delete it"); the earlier "API create refuses legs:3" was a coordinator gloss
  and is withdrawn; RB5-G6's scope list and its legs clause (RB5-G1, signed 285) are the coordinator's reading,
  marked as a designer's call. `triple_rr` is detected, never stored: no migration (G5). RB5-G9 has no "21 cases"
  count (G1). RB5-D3's "where ranks tie across pools" is read as **equal on the cross-pool comparison** — level on
  every key of the source's cross-group order, so only lots, seed or id ordered them; rows with different match counts
  are never level; the resolver's within-pool `tieUnbroken` flag is not that comparison (designer's call G3; the exact
  contract is the engine plan's `PooledSeed.tied`). Rows are unchanged otherwise.
- **Owner ruling 291 (2026-11-16, answer "A" to review-3 N1):** RB5-G9 is re-worded from "listed (seed) order, ending in stored lots" to "the sport's own declared cross-group cascade breaks the tie" (seed step → seed order; lots → the engine's stored lots draw; neither → seed then id). 291 supersedes the "listed (seed) order" wording that 288 confirmed for REC-2. No engine change.
- **Fix round 3 (2026-11-16, review-3 N2–N8):** RB5-G9 and RB5-D3 unchanged otherwise; the plans' minors only.
