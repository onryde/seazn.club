# W4 — knockout family: design

- **Date:** 2026-11-04 · **Programme:** format matrix (`2026-09-27-format-matrix-prompts/_INDEX.md`), wave W4
- **Rows:** `knockout`, `knockout_third_place`, `ko_plate`, `qualifying_main`, `stepladder_only`, `page_playoff_only`
  × 11 sports = 66 cells
- **Inputs:** wave brief `W4-knockout.md` (with its W3 and Match Day carries); draft rulebook `rulebook-W4-knockout.md`
  (unsigned, written 2026-11-04 beside the brief); the W4 gap register and its six supporting recon files
  (`/Users/ashokhein/seazn-artifacts/w4-recon/`: `00-GAP-REGISTER.md`, `A-routed-gaps.md` … `F-w3-analogues.md`,
  `grid.md`), read-only against app `origin/main` 97d22c8acd and engine `origin/main` 972a7c7 (= 3.0.2, the app's
  pin); the owner's prod census and anomaly drill-down (2026-11-04). The recon is machine-local; copy it to
  `.superpowers/handoff/2026-11-04-w4/` when the plan starts, as W3 did.
- **Status:** **APPROVED by the owner 2026-11-04 (ruling 274: "approve and record all rules")** — every designer's and
  controller's call below, and every REC rulebook row, is signed by 274; rule rows recorded in the engine's rules files
  on approval (owner instruction "record all rules in engine"), each marked not-yet-implemented until its PR lands.
  Original drafting note: Decisions marked **OWNER** were made by the owner in the W4 brainstorm on
  2026-11-04 (Q1–Q8, rulings 263–270). Q1 the owner agreed as framed. **Q2–Q8 were the owner accepting the designer's
  recommendation** (Q2: "apply your rec"; Q3–Q8 recorded in the register as "AGREED rec", Q3 being option B, the
  recommendation). Where an owner ruling itself carries a designer's call (Q2's tiebreak, Q3's exclusions and n≥4 gate,
  Q4's n<4 hide), the owner accepted it with the recommendation; §10 lists those separately. Decisions marked
  **(designer's call)** are new in this doc and are listed in §10 for checking. Everything marked **REC** is a rulebook
  recommendation that still needs the owner's signature (§8).
- **Amended 2026-11-04 after the builder check** (owner "ye" to all three recommendations):
  - **Ruling 271** amends 263: automatic arrivals into a started knockout are never auto-placed (§4.1).
  - **Ruling 272** routes D4, club separation, out of W4 to a future clubs follow-up (§5.4).
  - **Ruling 273** signs §8 S1–S7 as recommended, with S6 in its warning form.

---

## 1. Intent

Knockout works today for what customers run. The prod census (owner, 2026-11-04) found **10 knockout-family
divisions, all badminton, all fed from a table**: 9 Swiss → knockout and 1 league → knockout (n=3, a one-fixture
final). There is **no** standalone knockout, ko_plate, qualifying_main, stepladder or page playoff, no third-place
match, no API byes or slot order, no club data and no withdrawal or disqualification. The Sept-2026 prod events are
the owner's tests, not customers'.

So W4 is less about a pain live organisers feel and more about making the family trustworthy before anyone runs it
standalone:

1. **Late entry in every format** (owner, 2026-11-01). W3 shipped the Swiss half (ruling 250). The knockout half is
   absent: the server answers a bare 422 and the client says "list closes" (LE-1), while a paid confirmation, a
   waitlist promotion or an import silently adds an unplaced entrant to a drawn bracket (K7).
2. **Formats that are offered but break.**
   - Knockout + Plate fails with a 409 at every n with byes (FX-G14), and above 12 entrants it silently leaves
     round-1 losers out (PL-1).
   - Stepladder and page-playoff withdrawals are red on every sport (FX-G7, SL-1).
   - Third place is API-only (3P-1).
   - Finished brackets show as all-zero tables on the embed and `/present` (ST-G7), and the OG card reads from an
     unordered query (ST-G26).
3. **Results the bracket model cannot express:** a shared third place, joint winners and a vacant title. `finalRanks`
   is a strict list (SH-3, Q4), and two prod brackets already ended in a state the engine should have refused (AN-1,
   AN-2).
4. **Draw quality.** With no seeds, the earliest registrants get the byes (K5). There is no random draw. Club
   separation (D4) is also absent, but it leaves W4 under ruling 272 (§5.4).

**Success:**
- An organiser adding a late player to a drawn bracket sees them placed or gets a named reason. Never "up to date",
  and never an entrant silently left out of the bracket.
- Every n the builder offers for Knockout + Plate completes its plate, and the plate holds every first loss.
- Third place is a setting on a screen, Shared by default, and reads the same on every surface.
- No finished bracket is ever drawn as a table.
- Every rule W4 relies on is a signed row in the engine's rules files.

## 2. Goals, non-goals, anti-goals

**Goals**
- G1 **Late entry after Start, entry stage only** (OWNER Q1, §4.1).
- G2 **A vacated seat walks over, except a qualifier's unplayed main-draw slot, which takes a lucky loser** (OWNER Q2,
  §4.2).
- G3 **The plate holds everyone's first loss** and draws after round 2 (OWNER Q3, §5.1). This needs an engine change
  in onryde/seazn.club.engine.
- G4 **"Third place: Shared / Play-off match"**, one setting, the same default in every sport (OWNER Q4, §5.2).
- G5 **Final not played:** walkover, automatic vacant title, or "Declare joint winners" (OWNER Q5, §5.3).
- G6 **Draw:** seeds on the fold, byes to the top seeds, the unseeded drawn at random with a stored seed (OWNER Q6,
  §5.4). Q6's opt-in club separation is routed out of W4 by ruling 272.
- G7 **Standalone stepladder and page playoff are refused with a named reason.** As final stages both stay, and their
  withdrawal reds are fixed (OWNER Q7, §5.5).
- G8 **History:** the 9 finished prod brackets re-rank to a shared third (OWNER Q8, §7).
- G9 **One shared position-keyed bracket reconcile** (FX-G2), built with a seam W5 extends to round-robin (§6.5).
- G10 **Close every gap in §9** to ruling 19's bar: zero ❌ on the six rows attributable to W4, others ⏳ with their
  owner, and nothing previously ✅/⛔ turned red.
- G11 **Rule rows:** every W4 behaviour gets a signed row in the engine repo's `rules/cross-sport.md` (and a sport file
  where a sport-specific consequence exists), plus a numbered ruling in `_INDEX.md` (§12).

**Non-goals**
- **Seed bands drawn by lot.** BWF and ITF draw seeds 3–4 and 5–8 into their halves and quarters by lot. The owner
  kept the deterministic fold (Q6). It is recorded as a deviation row.
- **Club separation (D4): ⏳ deferred (OWNER, ruling 272).** Only teams carry a club (`team_details.club_id`,
  V242:22). Individuals and pairs have none, and every live knockout is individual or pair badminton, so a team-only
  toggle would be an inert seam. It is owed to a future clubs follow-up that gives persons and pairs a club (schema,
  registration and import); W5's groups consume it then.
- **Country separation** (Q6: no data, rare) and any separation beyond round 1.
- **Deciding an unplayed final by seed or by table** (Q5). The L2 Q4b cells become ⛔ refused, not 🚫.
- **Standalone stepladder or page playoff** (Q7).
- **Late entry into a knockout fed from a table.** The late player joins the entry stage under that stage's rule:
  Swiss is W3's, and league and groups are W5's (Q1).
- **A late entrant joining round 2 or later** (Q1).
- **Direct acceptance plus a qualifier merge for qualifying_main** (QM-1) (designer's call, §8 S1).
- **An organiser control for `config.byes` and `config.slotOrder`** (K6) (designer's call, §8 S4).
- **Making the withdrawal cascade one transaction, and the division lock** (K11). These stay W9's (ruling 101).

**Anti-goals: things that would make W4 a failure even if every test is green**
- A late-entry action that moves a player who is already on court, or re-seats a match that has been called to a
  court (ruling 257's reading of "started").
- Any automatic arrival left unplaced with no desk flag.
- A plate sweep that passes on zero cases, or that lists a live defect as its expected value (the n=5 allowlist,
  T8-b).
- A shared third on one surface and 3rd/4th on another.
- A stage marked complete with an unplayed fixture (AN-2), or a decided final whose stage never completes and so
  never ranks (AN-1).
- A third-place or page-playoff test that asserts "the stage completed" instead of who played whom (brief trap 3).

## 3. Constraints

- **Two repos.**
  - Bracket generation (`scheduling/bracket.ts`), progression feeds (`competition/progression.ts`) and final ranks
    (`competition/stage.ts`) live in **onryde/seazn.club.engine**, published as `@onryde/seazn-engine` (app pin
    `^3.0.2`).
  - The orchestration (`apps/web/src/server/usecases/stages.ts`), withdrawal, late entry, Rebuild, progression
    proposals, every public surface and every screen live in **seazn.club**.
  - Order: engine PR (code + tests + rule rows + a real changeset + `Matrix rows: …` in the body) → engine release
    (`engine-release` skill: manual `release/<V>` PR) → seazn.club bump PR.
  - `finalRanks` changes from a strict `EntrantId[]` to a shape that can tie (§6.1). That breaks the engine's public
    API, so the release is likely a major. The builder establishes this from the epoch report; a FOLD_EPOCH raise
    means app migration steps are owed first.
- **The ruling ledger stays in seazn.club.** The next free number was 263 on 2026-11-04 (262 is the last owner
  ruling; 260–261 are controller rulings). Re-check origin/main before claiming one, because parallel sessions add
  rulings.
- **Ten live divisions, all fed from a table** (§7). Q1, Q3 and Q6 touch none of them; Q4/Q8 re-rank nine.
- **House test rules** (`docs/superpowers/TEST-STRATEGY.md`, `_RULES.md`):
  - all four test types per task;
  - anti-vacuity counts on every sweep (R25);
  - expected values derived from the rulebook and the engine's declarations, never from `generate()`'s output (R9);
  - mutate every new guard once (R17);
  - test the sequence: a second late player, late entry after a withdrawal, after an Undo, and in another sport (R27).
- **The recon is a read, not a run** (R5). Every LIKELY row in §9 is proved by a driving test before it is called a
  defect, and every line pin is re-pinned before building on it (recon A §4 lists four that had already drifted).
- **UI bar:** mobile-first, verified at 1280, 320 and 768 with no horizontal scroll; every new string in all 4 locale
  dictionaries plus `pnpm i18n:gen-keys` (R23); ≥2 layout options shown to the owner before any new control is built
  (R24, §5.2).
- **E2E runs by CI dispatch only** (`--ref <branch>`), never locally. Locally, run only the scoped tests for changed
  files.
- **Environment (not a W4 gap):** in the main checkout, `node_modules/@seazn/engine` points at an untracked
  `packages/engine/` holding only `test-results/`, so engine imports there do not resolve to 3.0.2. Build in a
  worktree with a fresh install (`seazn-local-env` skill).

## 4. Bracket changes after the draw (OWNER, 2026-11-04)

### 4.1 Late entry after Start (OWNER Q1, ruling 263)

Late entry applies **only where the knockout is the entry stage**:

| Format | Takes a late player? |
|---|---|
| `knockout` (root) | yes |
| `ko_plate` | into the **main bracket** only; never into the plate |
| `qualifying_main` | into the **qualifying bracket** only; never into the main draw (a qualifier's vacated slot is §4.2, not late entry) |
| knockout after Swiss, league or groups | **never.** The player joins the entry stage under its own rule (Swiss: ruling 250; league and groups: W5) |
| `stepladder`, `page_playoff` | case (2) only |

Under Q7 a stepladder or page playoff is never the entry stage, so its "case (2) only" reaches only a standalone stage
created over the API before W4's refusal ships. The census found none in prod (designer's reading, §10).

One action, **"Add late player"**, in the stage rail's More menu, opens the Entrants tab's existing add form (W3
App A Task 10; never a second form). The server tries the cases in order and returns `late_entry` with the case taken:

| Case | Condition | What happens |
|---|---|---|
| **(1) Take a bye** | Some round-1 line is a bye whose holder has **not started** their round-2 match | A new round-1 match: newcomer v bye holder. The bye award is reversed, and the bye holder's round-2 match waits for the new result. Nothing else moves. |
| **(2) Take a withdrawn slot** | A withdrawn entrant's round-1 slot, before their first match | The newcomer takes the slot, and the line becomes a real match against the original opponent. |
| **(3) Refuse** | Otherwise | A named refusal: "Round 1 complete; no slot left". **Exception:** if nothing in the stage has **started** (no result and no match called to a court — the K4 "started" predicate; the anti-goal against re-seating a called match wins over the literal ruling-263 wording, controller's call after builder check), the refusal offers **Rebuild** (one transaction, keeps times and courts, ruling 253). |

> **Case (3) amendment.** Amended 2026-11-09 (W4 app PR A, product decision under the owner's no-check-in delegation — awaiting owner sign-off): an organiser's manual add into a full knockout where no match has started keeps the entrant, marks them waiting and answers 201 `rebuild_offered` (the waiting strip offers Rebuild fixtures), the same as the automatic door; once any match has started the add is refused with 409 KO_LATE_ENTRY_NO_SLOT. A tap still answers `rebuild_offered`.

A late entrant never joins round 2.

Designer's calls inside the cases (§10):
- **"Started"** is the shared predicate: a score event, live, decided, or called to a court on Match Day. Adapt
  `swissBoardStartedSql` / `liveCallSql` (K4).
- **Case (1) with several byes:** take the bye of the **lowest-seeded** bye holder, with ties broken by draw position.
  In the fold, that is exactly the slot an (n+1)th unseeded entrant would get in a fresh draw, so the bracket matches
  the one a full redraw would give.
- **Case (2) when the withdrawal has already walked the line over:** the case is open while the walkover's winner has
  not started their next match. The walkover is reversed, which mirrors case (1)'s "has not started round 2".
  Withdrawal walks seated lines over at once (X-WD), so without this case (2) could never apply.
- **The new round-1 match** takes the next free slot. If there is none, it is left unscheduled and flagged to the
  desk (W3 designer's call 5). A bye line never holds a court (K2).

**Automatic arrivals (OWNER, ruling 271, amending 263).** A payment confirmation, a waitlist promotion, an import or a
Reinstate into a started knockout is **never auto-placed**:
- The entrant lands on the entrant list, and the desk is flagged ("1 late player waiting — add to bracket").
- One organiser tap on that flag runs the cases above: bye slot → withdrawn slot → refuse.
- It is never silently unplaced, and never refused, because refusing would fail a payment.
- W3's carry "automatic arrivals never reshape a published round" **holds for knockout**: only an organiser action
  reshapes a drawn bracket. Ruling 271 reconciles Q1's "automatic arrivals follow the same cases" with that carry, and
  the cases run only on the organiser's tap.

Reinstate is covered by this rule (K13, §10).

**Entrant kinds:** individual, pair, team alike. A late pair is the late entrant, and a late partner is a lineup
matter (W3 designer's call 3).

**Plumbing reused from W3:**
- `LateEntryResult` gains a `format` discriminant and knockout case names: `bye`, `withdrawn_slot`, `refused`,
  `rebuild_offered` (LE-2).
- The client mirror `lib/open-entry-stages.ts` and the Start dialog's copy change per format, so "Entrant list closes"
  is no longer false for a knockout entry stage (LE-1). The drift test stays.
- An undo barrier `knockout_late_entry` joins `UNDO_BARRIER_TYPES`. "Add late player" has no Undo; Undo answers with a
  named refusal that points to Withdraw (W3 design §10.8).
- `admitSwissLateEntrant`'s four doors (registrations, imports, reinstate, enrol) gain a knockout admitter beside it.
- One desk notice per case, in 4 locales.

### 4.2 A vacated seat: walkover or lucky loser (OWNER Q2, ruling 264)

- **Inside a bracket, a vacancy in round 2 or later is a walkover** (unchanged; X-WD-*).
- **A qualifier's main-draw slot vacated before their first main-draw match has started** takes a **lucky loser**:
  the highest-ranked qualifying-stage entrant who did not qualify (final rank q+1, then q+2 …), ties by seed, then a
  random tiebreak. The qualifying bracket plays to its own final as today (`format-templates.ts:299-305`; no engine
  change to stop a bracket early), so "best loser" means best final rank below the cut (controller's call after
  builder check; RB4-V4). The tiebreak is the designer's call, accepted with the recommendation.
- **Once that match has started**, it is a walkover.
- This fixes K9. Build it by adapting W3's cut backfill (`cutEligiblePools`, `stage-seeding.ts`
  `CUT_SKIPS_DEPARTED_KINDS`).

Designer's calls (§10):
- **"Final qualifying round"** = the round whose winners are the qualifiers. For `qualifying_main` with q=4 from an
  8-draw, that is the quarter-finals, so the quarter-final losers are the pool.
- **Pool exclusions:** a loser by walkover, withdrawal or disqualification is not eligible.
- **Empty pool:** the slot walks over, as today.
- **Random tiebreak:** uses the destination stage's draw seed (§5.4), so it replays.
- **Table sources too:** W4 also extends the existing backfill (next-ranked in the table) from a Swiss source to league
  and group sources feeding a knockout. The destination code is one set; leaving it Swiss-only would keep K9 for
  groups → knockout.

## 5. Plate, places, champion, draw, refusals (OWNER, 2026-11-04)

### 5.1 Plate: everyone's first loss (OWNER Q3, ruling 265)

- **The plate holds everyone's first loss:** round-1 losers, plus bye holders who lose their first match in round 2.
- **The plate draws after round 2,** once its field is known (every round-1 line and every bye holder's round-2 line
  decided), not after the main final (PL-3).
- This is the usual intent of a plate (everyone plays at least twice). Real-world precedent: **USTA First Match
  Consolation** is this shape, and **NZ badminton tour plate conditions** take first-match losers and exclude
  defaults.
- **Engine change** (cross-repo, onryde/seazn.club.engine). A first-loss feed replaces `roundLosers{round: 1, count:
  q}`, and `BracketFixtureRow` gains the walkover/withdrawal marker the exclusion needs (PL-2). The fixed q=4 goes, so
  no first loss is dropped above 12 entrants (PL-1).
- **Excluded** (designer's call, accepted with the recommendation; matches NZ badminton): losers by walkover,
  withdrawal or retirement. A disqualification is a withdrawal (ruling 259), so it is excluded too.
- **Offered from n ≥ 4** (designer's call, accepted with the recommendation). It is hidden below 4 with a named reason
  in 4 locales. `lib/division-builder/format-estimate.ts` `roundOneLosers` and the server must agree; they disagree
  today at n=5.

Designer's calls (§10):
- **A plate field under 2** after exclusions completes the plate with a named outcome ("Not enough first-match losers
  for a plate"), never an empty success (R13).
- **Proposal flow:** the plate is proposed through today's proposal/confirm flow the moment its field is known. With
  auto_progress on, it is confirmed automatically.
- **Plate draw:** follows §5.4 (fold for seeds, by main-draw seed; random for the rest).
- **A late entrant** placed by §4.1 feeds the plate like anyone else.

Done when (brief): every n the builder offers either completes the plate through the real usecases or is refused up
front with copy in 4 locales; neither outcome is a 409 at Complete; the sweep reports its count, and n=5, 6, 7, 9 and
17 are named cases. The recon adds 33–35, 65–67 and 129–131 to the failing set; the sweep covers them too.

### 5.2 Third place: Shared or Play-off match (OWNER Q4, ruling 266)

- **One knockout-stage setting, "Third place: Shared (default) / Play-off match".** The default is the same in every
  sport: there is no per-sport table, and it is revisited only on evidence.
- **Shared:** both semi-final losers are joint 3rd on **every** surface. This needs tied ranks in the engine (SH-3).
- **Play-off match:** a real match decides 3rd and 4th, and the stage is not complete until it is played (3P-3).
- **Hidden below 4 entrants** (designer's call, accepted with the recommendation). The engine stops emitting a
  third-place match fed by a bye (3P-2).
- **New UI: ≥2 layout options shown to the owner before build (R24).** Two candidates (designer's call, for the
  options page, not a decision):
  - (A) a two-segment control "Shared | Play-off match" in the knockout stage settings;
  - (B) a single toggle "Play a third-place match", off = shared, with one helper line.
  Both sit in the division builder and the stage settings, and the owner picks.

Designer's calls (§10):
- **Editable until the stage starts,** then read-only, matching RB3-5's "play freezes it". Before Start a change
  regenerates through the reconcile (§6.5).
- **A play-off whose two sides have both withdrawn:** 3rd is vacant and both rank 4th, mirroring Q5's vacant title.
- **The L1 cells:** `knockout_third_place` becomes a builder path, so its 11 L1 🚫 cells are driven.

### 5.3 Final not played, and the champion (OWNER Q5, ruling 267)

- **One finalist out:** walkover (unchanged).
- **Both finalists withdrawn or disqualified:** the title is **vacant automatically**. Both rank 2nd, and nobody ranks
  1st. It reverses itself if Reinstate or Undo restores a finalist. This supersedes X-DW-3's "refused, fixture stays
  open" for the both-withdrawn final; X-DW-3 already says "a vacant title is W4".
- **Rain or time:** the organiser action **"Declare joint winners"** on the unplayed final. Both rank 1st, the bracket
  shows "Joint winners", and the action is undoable.
- **No decide-by-seed, no decide-by-table.**
- **Engine:** a tied rank 1, and a vacant-champion shape. Joint winners close RB2A-30 (ruling 74) and the hand-off in
  CK-KO-1.

Designer's calls (§10):
- **Where "Declare joint winners" is offered:** on a final with no decided result. That is a scheduled final, an
  abandoned one awaiting settle, or a held level one (`needs_decision`, ruling 79). It includes a cricket final held
  under CK-KO-1, and the settle stays beside it.
- **Champion surfaces** (`champion.ts`, the public banner) show both names for joint winners and "Title vacant" for
  a vacant one.

### 5.4 Draw (OWNER Q6, ruling 268; club separation deferred by ruling 272)

- **Seeds stay on the fold.**
- **Byes go to the top seeds first.**
- **The unseeded are drawn at random** with a stored, shown, reproducible draw seed. Reuse W3's `swissDrawSeed` (an
  FNV-1a hash of the stage id) and `mulberry32` (`lib/swiss-draw.ts`), recorded on the `fixtures_generated` row as
  `draw_seed` (fixes K5 / FX-G17).
- **Club separation is ⏳ deferred out of W4 (OWNER, ruling 272).** Q6 asked for an opt-in "Keep same club apart in
  round 1" where the club is known. The builder check found:
  - only teams carry a club (`team_details.club_id`, V242:22);
  - individuals and pairs have none;
  - every live knockout is individual or pair badminton.

  A team-only toggle would therefore be an inert seam. D4 is owed to a future clubs follow-up that gives persons and
  pairs a club (schema, registration and import); W5's groups consume it then. When that follow-up builds it, Q6's
  shape still applies: opt-in, round 1, hidden without club data. **The random draw with a stored seed stays in W4.**
- **Country separation is not built** (no data, rare).
- Keeping the fold is a deviation from BWF/ITF seed-band lots (non-goals).

Designer's calls (§10):
- **Rebuild keeps the stored seed**, so the same roster gives the same draw.
- **An API `slotOrder` still overrides** the draw (K6 stays API-only).
- **The draw seed is shown** on the stage header and desk, which counts as new UI under R24.

### 5.5 Standalone stepladder and page playoff are refused (OWNER Q7, ruling 269)

- **Not offered standalone.** The server refuses with a named reason: "needs a table to seed from; add a league or
  groups first".
- **The matrix cells become ⛔ refused**, not 🚫 missing (SP-UI; NEW-W1d-4's stepladder_only and page_playoff_only
  halves).
- **Both stay as final stages:** league → stepladder top N, and league/Swiss → page playoff top 4
  (`format-templates.ts:166-212`).
- **W4 still fixes their withdrawal reds** (FX-G7, SL-1). Withdrawal rules (rulebook §11):
  - A withdrawal walks over and never voids (X-WD-2).
  - A withdrawn page-playoff entrant gets no second life on the loser edge. Ranks and seats must agree (engine
    `stage.ts:485-497` pins a forfeit loser out at that fixture).
  - A withdrawn stepladder seed is ranked as the loser of the rung they were due to enter.
  - Assert who plays whom (brief trap 3).

## 6. Where everything lands

### 6.1 Engine PR (seazn.club.engine)

| Item | Gaps | Rule |
|---|---|---|
| First-loss plate feed: round-1 losers plus bye holders' first loss; excludes walkover, withdrawal and retirement losers; `BracketFixtureRow` carries the marker; a "field complete" predicate so the app can propose after round 2 | PL-2, PL-1 (feed half), PL-3 (predicate) | OWNER Q3 |
| `finalRanks` can tie: shared 3rd (both semi-final losers rank 3), joint winners (both rank 1), vacant title (no rank 1, both finalists rank 2) | SH-3, Q4 | OWNER Q4, Q5 |
| No third-place match where fewer than two semi-finals are real (n=3), and a named `CONFIG_INVALID` if one is asked for | 3P-2 | OWNER Q4 |
| A stage with a play-off is not complete until the third-place match is decided | 3P-3 | OWNER Q4 |
| `completeBracketStage` refuses while any fixture is undecided | CH-1, AN-2 (engine half) | REC (rulebook §9) |
| A withdrawn stepladder seed is ranked, if the truth run puts SL-1's cause in `bracketRanks` | SL-1 (conditional) | REC (rulebook §11) |
| Every property counts what it checked; "byes go to the top seeds" and "every entrant placed exactly once" across n, not at n=6 only (K21 in recon F) | SEED-R (test half) | R25 |
| Rule rows in `rules/cross-sport.md` (+ sport files), each id in a test title | SEED-R | G11 |

### 6.2 App: work that needs no engine change (PR A, can run before the release)

| Item | Gaps | Rule |
|---|---|---|
| "Add late player" for a knockout entry stage (§4.1); automatic arrivals wait on the entrant list with a desk flag ("1 late player waiting — add to bracket"), and one organiser tap runs the cases; `LateEntryResult.format`; client mirror and Start copy; undo barrier | LE-1, LE-2, K7 | OWNER Q1, 271 |
| Shared position-keyed reconcile for Generate before Start (§6.5); fixes the vacant-final Generate 500 | FX-G2, WD-CASC (500 half: MB-004/005) | design G9 |
| Rebuild carries slots by bracket role (round counted from the final), and a line that becomes a bye frees its slot | K3 | ruling 253 + (designer's call) |
| Lucky loser for a knockout source; backfill for league and group sources | K9 | OWNER Q2 |
| Knockout + Plate hidden below n=4 with its reason; `format-estimate` and server agree | FX-G14 (gate half) | OWNER Q3 |
| qualifying_main gated where it cannot complete, after a driving test establishes where that is | QM-2 | (designer's call) |
| Random draw of the unseeded with a stored, shown seed | K5, FX-G17/18 (FX-G17 half) | OWNER Q6 |
| A correction inside a completed knockout source stales its proposals, draft and confirmed: before the bracket starts, re-propose and re-confirm; after, the bracket stands and the desk warns (W3 RB3-19 by analogy; adapt `swiss-cut-drift.ts`); a cross-stage void un-fills `cross_feeds` seats | FX-G16, FX-G17/18 (FX-G18 half) | (designer's call, §8 S3) |
| Standalone stepladder / page playoff refused with a named reason | SP-UI | OWNER Q7 |
| Page-playoff and stepladder withdrawal fixed to the rulebook; triage rules re-keyed | FX-G7, SL-1 | OWNER Q7, X-WD-2 |
| Undo cannot cross a seed confirm (barrier row, named refusal) | K1 | (designer's call) |
| A bye line never takes or keeps a court: generalise X-SW-29's exclusion onto `systemByeSql`; `awardSeededByes` clears the slot | K2 | W3 RB3-23 by analogy |
| One "started" predicate (score, live, decided, Match Day call) for take-back, Rebuild and late entry | K4 | ruling 257 by analogy |
| A DQ walkover is worded as a disqualification, not "Withdrawal recorded" | K12 | ruling 259 |
| Reinstate in a knockout: never auto-placed; it waits with the desk flag like any automatic arrival (§4.1) | K13 | OWNER 271 |
| Bracket tiles: no result drawn over a name; no "TBD" on a finished bye tile (rulings 116/117) | N-1 | rulings 116, 117 |
| Embed standings widget and public `/present` skip bracket stages, as the organiser slideshow already does (`TABLE_KINDS`) | ST-G7 | brief |
| OG reads an ordered query: the first table stage by stage order, then pool; a bracket-only division shows its champion | ST-G26 | brief (designer's call on the bracket-only card) |
| Desk attention "Final decided — complete the stage"; Complete competition WARNS (never refuses) listing open stages, and offers to complete brackets whose final is decided | AN-1 | (controller's call after builder check, §8 S6) |
| Re-verify AN-2's app path on main; the app refuses to complete a stage with an undecided fixture even before the engine bump | AN-2 (app half) | REC (rulebook §9) |
| Test and matrix debt (§6.6) | T8-a … T8-g | R25, R13 |

### 6.3 App: after the engine release (PR B, bump)

| Item | Gaps |
|---|---|
| Engine bump; every `finalRanks` reader handles ties (placement snapshot, `champion.ts`, public standings API, bracket view, hub, embed bracket, `/present`, OG). Enumerate the readers by behaviour (grep `finalRanks` and the placement snapshot), not by filename | SH-3, Q4 |
| Plate wired to the first-loss feed and proposed after round 2; the builder's hidden Top N and q=4 removed | FX-G14 (close), PL-1, PL-3 |
| "Third place: Shared / Play-off match" control (the owner's chosen layout, R24) | 3P-1 |
| "Declare joint winners" on an unplayed final; automatic vacant title on both finalists out, reversible | Q4, WD-CASC (vacant half) |
| Q8 history: re-rank the finished brackets (§7) | — (ruling 270) |
| Full e2e per row (late entry in each case, plate at odd n, shared and played third place, joint winners, vacant title, an automatic arrival waiting then placed by the tap, a pair bracket) | T8-a, T8-c |
| Re-baseline L3 **in the same change** as each fix lands, so the 33 knockout reds in `baseline.json` stop being invisible to the gate | T8-d |
| Bench gates (§6.7) | — |

### 6.4 Reference family (`packages/reference`, seazn.club)

A bracket progression and final-ranks oracle, exact, written from the signed rulebook by a different agent from the
engine fixer (R8). It covers:
- the draw: the fold, bye placement, and a seeded random draw that replays;
- late-entry case selection;
- plate membership (the first-loss set and its exclusions);
- lucky-loser choice;
- ranks with shared places, joint winners and a vacant title;
- stepladder and page-playoff seats and ranks after a withdrawal.

Every check reports how many items it examined (R25). It is not a second bracket generator.

### 6.5 The shared bracket reconcile, and the seam W5 extends

FX-G2 today: Generate inserts by `ext_key` only (`stages.ts:3737-3738`). From 6 to 7 entrants nothing is inserted and
"up to date" shows. Crossing 8 → 9 seats entrants twice, keeps the old final beside a new one, and shows no drift
banner. Generate after a line turns into a bye answers a 500 (MB-004/005).

**Shape** (designer's call):
- **Identity:** a bracket line's identity is its role, (stage, round counted from the final, index in round), not its
  `round_no`.
- **Before Start, within one bracket size:** Generate fills bye lines with newcomers and turns a removed entrant's line
  into a bye. Both slot labels are cleared together, which is the 500. Nothing is inserted twice.
- **Before Start, crossing a power of two (either way):** the bracket is regenerated in one transaction (ruling 253),
  and times and courts are carried by role. The old final's slot goes to the new final, never to a new semi-final
  (K3).
- **After Start:** Generate never reshapes. §4.1's cases are the only way in.

**The W5 seam:** the reconcile takes a per-format identity function and a placement policy for new lines. Knockout
supplies (round from final, index). Round-robin (FX-G1) supplies the unordered pair plus the leg, and its own policy
for a new pair's slot. W4 ships the knockout function and the shared driver. W5 adds the round-robin function without
touching the driver. When the reconcile merges, the decision-log note to W5 records this shape (brief "Output and
handoff").

**R27 four questions, answered in writing at review:**
- **Second call:** a second Generate with no roster change is a no-op that says so.
- **Empty input:** zero entrants is a named refusal.
- **After a withdrawal or void:** the line becomes a bye before Start, and §4.1 case (2) applies after.
- **Another sport:** the R26 sweep over every module.

Test both sides of 8 → 9 (brief trap 1).

### 6.6 Matrix and test debt (T8; labels are this doc's)

| Label | Debt | What W4 does |
|---|---|---|
| T8-a | No knockout row fields **pairs**, at any level. The matrix fields one kind per sport; vitest, smoke and e2e field individuals (team ×3). The live prod kinds are individual **and pair**. | The counted usecase sweep (T8-e) covers individual, pair and team. App PR B adds one badminton doubles walkthrough. The matrix gains no kind axis (designer's call). |
| T8-b | `bracket-placement-sweep.test.ts:319` lists the ko_plate n=5 refusal as **expected** (it freezes the defect), and seeds the plate at n ∈ {5, 8} only | Remove the allowlist entry. Seed every n the builder offers; count it, zero checked = failure; name n=5, 6, 7, 9 and 17. |
| T8-c | L2: **407** ░ cells on the six rows never driven (no third-place or plate script) | Script Q3 (third place), Q5a/Q5b (plate), Q4a (joint winners), R2/R10 (late entry) and R6 (lucky loser). Q4b becomes ⛔ refused (Q5) and D4b ⛔ refused (Q6). D4a stays 🚫, re-routed ⏳ to the clubs follow-up (ruling 272). The rest stay ░ with a reason (designer's call). |
| T8-d | `baseline.json` holds all 33 knockout L3 reds (ko_plate F1 ×11, page_playoff_only R4 ×11, stepladder_only R4 ×11), so none can fail a gate | Re-baseline in the change that greens each (as W3 retired ruling 70's block). |
| T8-e | No counted per-format × entrant kind × case usecase sweep for knockout | A `knockout-late-entry-matrix.test.ts` modelled on `apps/web/src/server/usecases/__tests__/swiss-late-entry-matrix.test.ts`, specified below the table. |
| T8-f | qualifying_main has one hand-built n=4 vitest; stepladder and page playoff have no smoke and no walkthrough | All four test types for each (as final stages, after Q7). |
| T8-g | M6 dropped on boardgame for all six rows ("fixture layer, W4", `tools/matrix/lib/applicability.ts:294,328`), possibly stale since W2a's BG-KO-1 | Verify; lift the drop if stale. |

**The T8-e sweep**, modelled on the W3 file:
- Real usecases end to end.
- Axes:
  - every entry-stage template;
  - every kind, each kind's sport derived from the engine's declarations (`sportFor`);
  - every case: `bye`, `withdrawn_slot`, `refused`, `rebuild_offered`, `automatic_waiting` (never placed, flag raised; ruling 271) and `automatic_tapped` (the organiser's tap runs the cases).
- A fed-tail block that asserts the refusal for a knockout after Swiss, league or groups.
- The last `it` asserts that `checked.size` equals the product exactly, so a `-t` slice turns it red.
- Expected values come from the rulebook and the rows before the add, never from the code under test.

Two **stale triage rules** go too: `stepladder-withdraw-wrong-phase` matches 0 cases since W2b (its 11 L3 and 1 L2 reds
are untriaged), and `page-playoff-withdraw-voids` misses the L2 ui-path-only shape. Re-key them, or retire them with
the fix.

### 6.7 Reusable W3 mechanisms, and the bench gates

**As is:**
- Rebuild in one transaction (ruling 253);
- `systemByeSql`;
- `UNDO_BARRIER_TYPES`;
- the four automatic-arrival hooks;
- `open-entry-stages` and its drift test.

**Adapt:**
- the started predicate (`swissBoardStartedSql`, `liveCallSql`) → K4 and §4.1;
- `cutEligiblePools` → the lucky loser (K9);
- `swiss-cut-drift` → FX-G16;
- `mulberry32` / `swissDrawSeed` → the random draw (K5);
- `LateEntryResult` → plus `format` (LE-2).

X-SW-29's bye-slot fix keys on `sw-r{N}-bye` and does not reach knockout (K2).

**Bench gates (brief, design §9): All England (badminton knockout), Wimbledon (tennis), WTTC.** A grep of
`tools/bench/packs/` at 97d22c8acd found no pack for any of the three. Each is recorded ⏳ deferred, not blocking,
and runs when its suite lands. The builder re-checks at the gate.

## 7. Live divisions

- **Ten knockout-family divisions, all badminton, all fed from a table** (individual and pair, 3–14 entrants).
  - Q1 touches none: a fed knockout never takes a late player.
  - Q3 touches none: there is no live plate.
  - Q6 touches none: there is no live entry-stage draw.
- **Q4 + Q8 history (OWNER Q8, ruling 270).** The 9 finished prod brackets ranked their semi-final losers 3rd/4th by
  seed. They switch to a shared 3rd. There is no freeze and no "old rules" ranks.
  - Ranks derived on read recompute automatically.
  - Stored ranks (the placement snapshot written at `server/engine-db/competition.ts:1069`) get a one-off **LOUD**
    migration, per the owner's data-change rule.
  - The builder checks which applies. A prod read needs the owner's OK (the owner ran the census himself); the stg
    read is a standing OK, and stg data is test-only (clean up, no compat).
- **AN-1:**
  - **What prod holds:** a completed competition whose 8-bracket knockout has all 7 fixtures `decided` (none
    finalized), auto_progress off, and its stage and division still active. The bracket never ranks, and its
    champion may be missing on public surfaces.
  - **Gap:** nothing nudges Complete.
  - **Remedy** (OWNER, ruling 273, §8 S6): a desk attention "Final decided — complete the stage", and Complete
    competition **warns** (never refuses), listing the open stages.
  - **Verify on main first:** prod is an older tag.
- **AN-2:**
  - **What prod holds:** a draft competition whose 4-bracket stage is COMPLETE, with its final `in_play` and no
    outcome.
  - **Class:** the same as CH-1. The engine guard ships in the engine PR, and the app re-verifies its own completion
    path on main and refuses too (§6.2).
  - **Data:** the one prod row is the owner's test data. Whether it is repaired or left is the owner's call at
    deploy.
- **The prod deploy itself is not scheduled by this design.** The Q8 migration is owed before W4 reaches prod.

## 8. Owner sign-off (the rulebook): S1–S7 SIGNED 2026-11-04, ruling 273

Owner "ye" to the recommendations after the builder check. Q1–Q8 are owner rulings 263–270 (2026-11-04), amended by
271 (automatic arrivals) and 272 (club separation deferred).

S1–S7 below are **signed as recommended**, with S6 in its warning form; their rulebook rows read **OWNER 273**. The
rulebook's other **REC** rows (the designer's calls) stay REC until the owner approves this doc. These questions were
the ones that change what gets built:

- **S1 — qualifying_main shape (QM-1).** Keep two knockout stages joined by rankRange, plus the lucky loser (Q2). Do
  not build direct acceptance plus a qualifier merge. **Signed (273): keep.** No prod division uses it.
- **S2 — qualifying cut at whole rounds.** With a shared 3rd, a qualifying cut of q=3 would split a tie. **Signed (273):** offer
  q only at a whole round (1, 2, 4, 8 …) on a knockout source.
- **S3 — correction inside a completed knockout source (FX-G16).** **Signed (273):** W3 RB3-19 by analogy: before the bracket
  starts, re-propose and re-confirm (a confirmed proposal goes stale too); after, the bracket stands and the desk
  warns.
- **S4 — `config.byes` / `slotOrder` (K6).** **Signed (273):** they stay API-only, because the fold plus the random draw cover
  the organiser's need.
- **S5 — O6 per-cell rulings (brief).**
  - Boardgame cells on the six rows: **signed (273): works**, confirmed by the truth run. The root cause, SC-O1, was closed by
    W2a.
  - Generic standalone page playoff: ⛔ under Q7.
  - F1 on `page_playoff_only`: unfit (ruling 6), confirmed.
- **S6 — AN-1 remedy.** **Signed (273):** the desk attention, plus a **warning** (never a refusal) on Complete competition that
  lists open stages and offers to complete any bracket whose final is decided. Not a refusal: completing a competition
  is also the quota-retire path, kept open even for frozen competitions (`competitions.ts:512-521`).
- **S7 — ranks below 3rd.** **Signed (273):** they stay strict (elimination round, then seed), unchanged. The alternative is
  equal 5th, 9th … by round, BWF/ITTF-style. The engine's tie shape would allow it, and qualifying cuts would then
  need S2.

Once signed, each recommendation becomes a numbered ruling (re-checked). Its rule row lands in the engine PR or the app
PR that implements it, never ahead of the code.

## 9. Gap status on 2026-11-04

Read, not driven, except where a CI run says RED (run 41861339582). Source: the gap register, with file:line for both
repos. Verdicts are the register's. **LIKELY = prove by a driving test first**; if the test does not reproduce it, the
row goes to "False premises found (W4)".

| id | theme | verdict | piece | note |
|---|---|---|---|---|
| FX-G2 | T1 growth after draw | OPEN | App A | shared reconcile §6.5; RR half → W5 |
| LE-1 | T1 late entry | OPEN | App A | Q1 |
| K7 | T1 automatic arrival | LIKELY — prove by a driving test first | App A | ruling 271: never auto-placed; desk flag, one tap runs Q1 cases |
| K3 | T1 Rebuild slot carry | LIKELY — prove by a driving test first | App A | carry by role |
| LE-2 | T1 result shape | OPEN | App A | `format` discriminant |
| FX-G14 | T2 plate 409 | RED (ko_plate F1 ×11) | App A (n≥4 gate) + Engine PR + App B (feed, closes it) | Q3 |
| PL-1 | T2 plate drops losers n≥13 | OPEN | Engine PR + App B | Q3: no q |
| PL-2 | T2 first-loss feed | PARTIAL | Engine PR | Q3 + exclusions |
| PL-3 | T2 plate waits for final | OPEN | Engine PR (predicate) + App B | Q3: after round 2 |
| QM-1 | T2 direct acceptance | ABSENT (engine) | refused — not built (designer's call) | §8 S1 |
| QM-2 | T2 qualifying_main n<4 | UNVERIFIED — prove by a driving test first | App A | gate where it cannot complete |
| FX-G16 | T2 stale knockout source | OPEN | App A | §8 S3 |
| FX-G17/18 | T2 qualifier gaps (FX-G17 unseeded order, FX-G18 cross-stage un-fill) | OPEN | App A | FX-G17 with K5 (Q6); FX-G18 with FX-G16 |
| K9 | T2 departed qualifier | PRESENT | App A | Q2 lucky loser |
| 3P-1 | T3 third place API-only | RED (L1 🚫 ×11) | App B | Q4; R24 layouts first |
| 3P-2 | T3 n=3 dead third-place feed | PARTIAL (engine) | Engine PR | Q4 hide n<4 |
| 3P-3 | T3 completes before third place played | PARTIAL (engine) | Engine PR | Q4 |
| SH-3 | T3 shared 3rd impossible | ABSENT | Engine PR + App B | Q4, Q8 |
| Q4 | T3 joint winners / vacant title | ABSENT | Engine PR + App B | Q5 |
| CH-1 | T3 completes an unfinished bracket | OPEN (engine) | Engine PR | AN-2 class |
| WD-CASC | T3 vacant final, Generate 500 | RED (opt-in run, 5 sports) | App A (500) + App B (vacant title) | §6.5, Q5; lift `ko-generate-after-roster-change` fence with the fix |
| FX-G7 | T4 page playoff withdrawal | RED (R4 ×11; run wins over read) | App A | Q7; re-key triage rule |
| SL-1 | T4 stepladder withdrawn seed unranked | RED (R4 ×11, untriaged) | App A (+ Engine PR if cause is `bracketRanks`) | Q7; stale triage rule |
| SP-UI | T4 standalone stepladder / page playoff | RED (L1 🚫 ×11 each) | refused | Q7 |
| K5 | T5 registration-order byes | PRESENT | App A | Q6 random draw |
| K6 | T5 byes / slotOrder API-only | PRESENT | refused — stays API-only (designer's call) | §8 S4 |
| D4 | T5 club separation | ABSENT (engine) | ⏳ deferred — clubs follow-up (ruling 272) | only teams carry `club_id` (V242:22); W5 groups consume it then; country not built |
| SEED-R | T5 no rule rows | ABSENT | Engine PR + close-out rows | §12 |
| K1 | T6 Undo crosses seed confirm | LIKELY — prove by a driving test first | App A | barrier |
| K2 | T6 bye holds a court | LIKELY — prove by a driving test first | App A | `systemByeSql` |
| K4 | T6 Match Day call not "started" | LIKELY — prove by a driving test first | App A | one predicate |
| K11 | T6 withdrawal takes no division lock | LIKELY — prove by a driving test first | W9 | ruling 101 |
| K12 | T6 DQ worded as withdrawal | PRESENT | App A | ruling 259 wording |
| K13 | T6 Reinstate is a bare flip | LIKELY (rare) — prove by a driving test first | App A | ruling 271 (waits with the desk flag) |
| K24 | T6 one-day spread cap | LIKELY — prove by a driving test first | W9 | shared scheduler default, not knockout (designer's call) |
| N-1 | T6 bracket tiles | OPEN | App A | result over name + "TBD" on bye tiles (rulings 116/117); screenshot 320/768/1280 |
| ST-G7 | T7 finished bracket as table | OPEN, untested | App A | embed + `/present` |
| ST-G26 | T7 OG unordered | OPEN, untested | App A | assert order across pools and a KO placement; anchor on `="` |
| AN-1 | prod anomaly | suspected defect (prod data) | App A | §7, §8 S6; verify on main |
| AN-2 | prod anomaly | PRESENT in prod data | Engine PR (CH-1) + App A (re-verify) | §7 |
| T8-a … T8-g | T8 test + matrix debt | — | App A (+ App B e2e) | §6.6 |

- **40 register ids:** OPEN 11, RED 6, LIKELY 8, PRESENT 4, PARTIAL 3, ABSENT 5, UNVERIFIED 1, prod anomaly 2.
- **By piece** (a row can name two): Engine PR 12 (SL-1 conditional), App A 24, App B 7, refused 3 (QM-1, K6, SP-UI),
  W9 2 (K11, K24), W5 1 (FX-G2's round-robin half), ⏳ clubs follow-up 1 (D4, ruling 272).

**False or stale premises found** (go to `_INDEX.md` "False premises found (W4)" when the plan starts):
- FX-G7: the code reads fixed by W2b X-WD-2, but L3 is still red. The run wins over the read.
- NEW-W1d-3, MB-002, MB-003: the TBD-seat 422 is gone (X-WD-3). Stepladder R4 is now a different red (SL-1).
- Brief pins drifted:
  - `division-builder.tsx:558` → `lib/division-builder/format-choice.ts:77`;
  - `stages.ts:5472` → `:5788-5793`;
  - `lib/format-estimate.ts:44` → `lib/division-builder/format-estimate.ts:44`.
- The brief's failing-n list for the plate misses 33–35, 65–67 and 129–131.
- ST-G7's "slideshow": only the public `/present` and the embed are open. The organiser slideshow filters.
- ST-G26's OG path is now `(public)/live/…`.
- FX-G16 "draft proposals are staled": only for a table source. A knockout source stales nothing.
- Q1's "automatic arrivals follow the same cases" read as auto-placement would have broken the W3 carry "automatic arrivals never
  reshape a published round". Ruling 271 reconciles them: the carry holds, and the cases run on the organiser's tap.
- Q6's club separation premise: only teams carry a club (V242:22), so the toggle would be inert for every live knockout
  (ruling 272).

## 10. Calls made by the designer (check these)

**Accepted by the owner with the recommendation** (part of rulings 264–266; listed for visibility):
- A. The lucky loser's tiebreak among equal losers is random (Q2).
- B. The plate excludes walkover, withdrawal and retirement losers (Q3).
- C. Knockout + Plate is offered from n ≥ 4, hidden below with a reason (Q3).
- D. Third place is hidden below 4 entrants (Q4).

**New in this doc:**
1. "Started" for late entry, lucky loser and take-back is one predicate that includes a Match Day call (§4.1).
2. Case (1) with several byes takes the lowest-seeded bye holder's bye (§4.1).
3. Case (2) stays open after the withdrawal's walkover until the walkover winner starts their next match; the walkover
   is reversed (§4.1).
4. A new round-1 match takes the next free slot, or is unscheduled and flagged (§4.1).
5. "Add late player" has no Undo; a `knockout_late_entry` barrier refuses with a pointer to Withdraw (§4.1).
6. Under Q7, stepladder/page playoff "case (2) only" reaches only a standalone stage created before the refusal (§4.1).
7. "Final qualifying round" = the round whose winners are the qualifiers. Walkover, withdrawal and DQ losers are not
   eligible. An empty pool walks over. The tiebreak uses the stage's draw seed (§4.2).
8. W4 extends the departed-qualifier backfill to league and group sources (§4.2).
9. A plate field under 2 completes with a named outcome. The plate is proposed the moment its field is known, and
   drawn per §5.4 (§5.1).
10. The third-place setting is editable until the stage starts. A play-off with both sides withdrawn: 3rd vacant, both
    rank 4th. Layout candidates A/B for the R24 page (§5.2).
11. "Declare joint winners" is offered on any final without a decided result, a held cricket final included (§5.3).
12. (Withdrawn: club separation is deferred by ruling 272.)
13. Rebuild keeps the draw seed. An API `slotOrder` overrides the draw. The seed is shown on the stage (§5.4).
14. A withdrawn page-playoff entrant gets no second life; a withdrawn stepladder seed ranks as the loser of their rung
    (§5.5).
15. The reconcile's shape: role identity, fill byes within a size, regenerate in one transaction across a power of two,
    never reshape after Start (§6.5).
16. QM-1 not built; K6 stays API-only; K11 and K24 go to W9 (§9).
17. Reinstate in a knockout (K13) is settled by ruling 271: never auto-placed, it waits with the desk flag. What stays
    the designer's: a reinstated finalist reverses a vacant title (Q5).
18. AN-1: desk attention plus a warning (not a refusal) on Complete competition; signed as S6 by ruling 273 (§7, §8).
19. The matrix gains no entrant-kind axis; pairs are covered by the usecase sweep and one walkthrough. The listed L2 ░
    scenarios get scripts, and the rest stay ░ with a reason (§6.6).
20. FX-G16: both the draft and the confirmed proposal go stale; RB3-19 by analogy (§8 S3).
21. The OG card of a bracket-only division shows its champion (§6.2).
22. The rule-row prefix: rows use `X-` areas that do not contain `-KO-` (§12).

## 11. Left to the builder

- Refusal codes, i18n keys and copy for every new message (all 4 locales, `pnpm i18n:gen-keys`).
- The engine API shape for tied ranks, the vacant champion, the first-loss feed and its "field complete" predicate.
- Whether the `finalRanks` change is a major and whether it raises FOLD_EPOCH (the epoch report decides; migration
  first if so).
- Where the shown draw seed sits.
- Derived versus stored ranks for Q8, and so whether a migration is owed.
- The `finalRanks` reader list (by behaviour, §6.3).
- Exactly where qualifying_main cannot complete (QM-2's driving test), and its gate.
- The R24 options page for every new control (third place, Declare joint winners, the draw seed line, the late-entry
  notices and the "late player waiting" flag).
- Task breakdown, batching and PR count within the order in §3, in the plan (`superpowers:writing-plans`).

## 12. Every rule gets a rule row

Every signed W4 rule becomes a row in the engine repo's `rules/cross-sport.md` (and a sport file where a
sport-specific consequence exists). The README grammar applies: id, rule, citation, `signed N date` /
`deviation N date`, code and tests, and the id appears in a test title.

**Prefix** (designer's call): use new cross-sport areas, for example `X-DRAW-` (draw), `X-LE-` (late
entry), `X-LL-` (lucky loser), `X-PL-` (plate), `X-TP-` (third place), `X-CH-` (champion, joint winners, vacant) and
`X-FR-` (final ranks). Never put `-KO-` in a new id: `packages/reference`'s bracket-finish family reds on any KO row
that is not signed and cited.

A row lands with the code that makes it true, never ahead of it. As in W3, app-side rows ship in the engine PR after
app PR A has merged, so the release carries every W4 row and PR B's bump runs the app rules checker against them.

| Rule | Source | Lands in |
|---|---|---|
| Seeds on the fold; byes to the top seeds (deviation from BWF/ITF seed-band lots) | 268 | Engine PR |
| Unseeded drawn at random with a stored, reproducible seed | 268 (BWF draw by lot) | Close-out |
| Late entry: entry stage only; cases (1) bye, (2) withdrawn slot, (3) refuse / Rebuild if no result; never round 2 | 263 | Close-out |
| Automatic arrivals (confirm, waitlist, import, Reinstate) are never auto-placed: listed with a desk flag; one organiser tap runs the cases; never refused | 263, 271 | Close-out |
| Vacancy in round 2+ → walkover; a qualifier's unplayed slot → lucky loser; started → walkover | 264 | Close-out |
| Plate = everyone's first loss, minus walkover/withdrawal/retirement losers; draws after round 2; offered n ≥ 4 | 265 (USTA First Match Consolation; NZ badminton plate conditions) | Engine PR (+ close-out for the gate) |
| Third place: Shared (default) / Play-off; shared = both semi-final losers rank 3; play-off holds completion; hidden n<4 | 266 (BWF/ITTF two bronzes) | Engine PR (+ close-out for the control) |
| One finalist out → walkover; both out → vacant (both rank 2), reversible; "Declare joint winners" (both rank 1), undoable; no decide-by-seed/table | 267 | Engine PR (+ close-out for the action) |
| A bracket stage completes only when every fixture is decided or settled | REC (CH-1) | Engine PR |
| Final ranks are a permutation except the declared shared places | REC (design §7.3) | Engine PR |
| Standalone stepladder / page playoff refused with a named reason | 269 | Close-out |
| Page-playoff and stepladder withdrawal: walk over, no second life, every entrant ranked | REC (X-WD-2) | Engine PR / close-out per cause |
| History re-ranks to the current rule (no freeze) | 270 | Close-out |
| Qualifying cut at whole rounds; correction inside a knockout source; K6 stays API-only; AN-1 warning; ranks below 3rd strict | 273 (§8 S2–S4, S6, S7) | Close-out |

The X-SW-16 row omits `components/v2/format-picker.tsx` from its paths; that fix is owed "to the W4 rules close-out"
(W3 App B parked list) and lands with the rows above.
