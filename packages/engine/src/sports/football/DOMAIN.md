# Football — domain audit (W4, #407 programme)

## What was audited, and against what

Association football, as the module `football@1.0.0` models it.

Sources the audit was run against:

- **IFAB Laws of the Game 2025/26** — Law 3 (players and substitutes), Law 5
  (the referee's match record), Law 7 (duration and allowance for time lost),
  Law 10 (determining the outcome, including kicks from the penalty mark),
  Law 12 (fouls and misconduct, and its **temporary dismissals** addendum),
  Law 14 (the penalty kick).
- **The FA's grassroots match record / referee report**, and the FA's
  **sin-bin (temporary dismissal) system**, which runs at every level below
  National League System step 4 and throughout youth football.
- **FA Mini-Soccer and Small-Sided rules** and the **FIFA Futsal Laws**, for
  the substitution and time-penalty divergences in the small-sided game.
- FIFA/UEFA competition regulations for extra time, kicks from the penalty
  mark, and the group-stage points split.

Declared variants (`football.variants`): **`11-a-side`**, **`youth`**,
**`small-sided`**. Where a row says `all`, the fact is recorded identically in
every one of the three; where it names variants, the model diverges and the
"note" column says how.

The module already had optional person fields before this wave, so it sets the
attribution pattern the other families copy. **§4 states exactly which person
roles are complete and which are not.**

## Mapping table

Grouped by area, in scorebook order. `Ev.X` = a branch of the event union,
`Cfg.x` = `configSchema`, `State.x` = the folded `FootballState`,
`summary.x` = `module.summary()`, `Lineup.x` = the core `LineupPair` the module
is initialised with.

| fact | variants | who/what participates | schema path | status | note |
| --- | --- | --- | --- | --- | --- |
| Goal in open play | all | entrant `by`; `scorer`; `assist` | `Ev.FootballGoal.by`, `.scorer`, `.assist` → `State.goals`, `State.periods[].home\|away` | modelled | Scorer must be on the pitch for `by`; all three person fields optional so coarse scoring stays legal. |
| Goal scored from a penalty kick | all | `scorer` | `Ev.FootballGoal.penalty` | modelled | Flag pre-dates W4. W4 gave it a home in the stat model (`playerStats.penalty_goals`), a strict subset of `goals`, so `points = goals + assists` is unchanged. |
| Own goal, and who it is credited to | all | the striking side's `scorer`; credit goes to the opponent | `Ev.FootballGoal.ownGoal` → `creditGoal(opponent(by))` | modelled | `by` is the side whose player struck it; the fold credits the other side. `playerStats.goals` excludes own goals via `when: p.ownGoal !== true`. |
| Own goal charged to the player who scored it | all | `scorer` | `playerStats.own_goals` | **extended** | `{when: p.ownGoal === true}` on `football.goal`; a personal column only, so `goals` and `points` are unchanged. The closed-set assertion in `src/stats/stats.test.ts` was widened to the new correct row. |
| Assist | all | `assist` | `Ev.FootballGoal.assist` → `playerStats.assists` | modelled | One assist per goal (unlike ice hockey's two). |
| **Time of any event a scorer times** | all | n/a | `.at` on `Ev.FootballGoal`, `.FootballCard`, `.FootballSub`, `.FootballSinBinStart`, `.FootballSinBinEnd`, `.FootballPenalty`, `.FootballShootoutKick`, `.FootballPeriod` → `State.cards[].at`, `State.penalties[].at`, `State.squads[].sinBin[].startedAt`; legacy `.minute` where it already existed | **extended** | W4a (#425) §5.2. `at` is the core `GameTime` **verbatim** — SECONDS counted up from the start of the named period, so `90+3` is `{period:"H2", elapsed:2880}`. The pre-existing `minute` is MINUTES; it is **not removed** (that would break every frozen golden and the additive tripwire) but is deprecated in comment. **Where both are present `at` wins**: it is the only one the fold derives from, and `minute` is never read, converted or overwritten. Using the real `GameTime` schema is a contract, not a style note — the kernel is fail-open on a malformed stamp, so the payload schema is the only guard between a corrupt stamp and the ledger. **All eight payloads, not five**: these are `strictObject`s, so one without `at` does not merely lack the field, it REJECTS the key — a stamped penalty was unrecordable and could never advance the monotonic guard's high-water mark, no shoot-out payload could carry a stamp although `playPhases` lists SHOOTOUT, and the period marker (the one event a football scorer always times, and the trigger for the boundary sweep) could not carry the whistle. The fold still keeps per-period counts, not a timeline. |
| **As of when the folded state is true** | all | n/a | `State.asOf` | **extended** | W4a §6 obligation 3. Set to the stamp of every stamped event that reaches `apply`, absent until the first one — so a pre-wave state serialises exactly as it did, matching the `penalties` / `sinBin` precedent. It exists because lazy expiry means the pad's countdown and the folded pitch legitimately differ between an expiry and the next event: without it a scorer reads the stale strength as a bug, and W5's one universal renderer would have met two different state shapes across the eleven sports. An unstamped event never moves it backwards. |
| A goal-by-goal timeline inside State | all | `scorer`, `assist` | would be `State.timeline[]` | deferred | The ledger already is the timeline and the match report reads it. State is serialised whole into the frozen golden corpus, so a new always-present array would break back-compat for zero new information. |
| Disallowed goal and its reason (offside / VAR) | all | n/a | — | deferred | Not a scorebook entry: a disallowed goal is not a goal, and the FA/IFAB match record has no field for it. VAR exists only above every declared variant's level. Needs a product decision if the pad wants a "chalked off" timeline entry. |
| Penalty awarded in open play and **not** converted (saved / missed / woodwork) | all | `taker`; the defending `goalkeeper` | `Ev.FootballPenalty` → `State.penalties[]` | **extended** | New branch `{by, taker?, goalkeeper?, outcome, minute?}`. `outcome` is a required enum `saved\|missed\|post` — that is also what keeps the branch distinct in the union. A **converted** penalty stays `football.goal {penalty:true}`, so no pre-W4 stream changes meaning. `goalkeeper` is validated against the **defending** side. |
| Who took, and who saved, a missed penalty | all | `taker`, `goalkeeper` | `Ev.FootballPenalty.taker`, `.goalkeeper` → `State.penalties[].taker\|goalkeeper`, `playerStats.penalties_missed` | **extended** | Both optional, per the person-attribution convention. |
| The offence that conceded a penalty | all | offender | `Ev.FootballPenalty.offence` → `State.penalties[].offence` | **extended** | S4 (#428). New optional `PenaltyOffence` enum: IFAB Law 12's 8 direct-free-kick/penalty offences (`kicking`, `tripping`, `jumping_at`, `charging`, `pushing`, `striking`, `tackling`, `handball`). Deliberately a DIFFERENT field from `CardReason` on the same event — not every penalty carries a card at all, and a card's reason can diverge from the offence that gave the kick away. |
| Yellow card | all | `person` | `Ev.FootballCard.color = "yellow"` → `State.cards[]` | modelled | Anonymous cards legal; a second plain yellow for the same person is refused (must be recorded as `second_yellow`). |
| Second yellow, and the red that follows it | all | `person` | `Ev.FootballCard.color = "second_yellow"` → `State.squads[].sentOff` | modelled | Refused without a prior yellow for that person; the fold removes the player permanently. FIFA fair play scores it −3, a direct red −4, yellow + direct red −5. |
| Direct red card | all | `person` | `Ev.FootballCard.color = "red"` | modelled | Legal pre-kickoff too (football.md §9). |
| **The offence a card was shown for** | all | `person` | `Ev.FootballCard.reason` → `State.cards[].reason` | **extended** | New optional `CardReason` enum: the six Law 12.3 cautionable offences and the seven Law 12.4 sending-off offences. The suspension tariff is a function of *this*, not of the colour — violent conduct and a second caution are both reds and carry different bans. |
| **The offence reaching the discipline projection** | all | `person` | `Ev.FootballCard.reason` / `Ev.FootballSinBinStart.reason` → `discipline.extractCards() → DisciplineCard.reason` | **extended** | Unblocked later in W4: `DisciplineCard.reason` (`src/core/types.ts`) plus the conditional spread in football's `extractCards` (`football.ts`), so the discipline usecase can vary a suspension by offence and not only by colour. `extractCards` projects a **sin bin** too, under the declared colour `sin_bin` — the return half of that branch is never a second sanction. |
| FIFA fair-play deduction | all | `person` (anonymous cards deduct independently) | `Cfg.fairPlay`, `StandingsDelta.metrics.fair_play` | modelled | Worst applicable category per person. |
| **Sin bin / temporary dismissal** | all — universal in `youth` and `small-sided`, and the FA runs it in `11-a-side` below NLS step 4 | `person` | `Ev.FootballSinBinStart` (`football.sinbin.start`) → `State.squads[].sinBin[]` | **extended** | New branch. Removes the player from the pitch **without** sending them off — the fact no existing branch could express, since `football.card`'s non-yellow path removes a player for good. Anonymous bins are recorded but never move the pitch, the same discipline anonymous cards get. |
| A sin-binned player returning to the pitch | as above | `person` | `Ev.FootballSinBinEnd` (`football.sinbin.end`) | **extended** | A start/end PAIR, the shape the period kernel uses for a suspension: two scorer moments minutes apart. An anonymous end closes the oldest anonymous dismissal. `playerStats.sin_bins` counts the dismissal and never the return. |
| Length of a temporary dismissal | as above | n/a | `Ev.FootballSinBinStart.minutes`, falling back to `Cfg.sinBinMinutes` | **extended** | Left unset on every variant preset on purpose: the FA runs 10 minutes in 90-minute football and reduces it *pro rata* for shorter formats, so it is a competition setting, not a Law constant. |
| **A sin bin running out on the clock** | as above | `person` | `Ev.FootballSinBinStart.at` + `.minutes`/`Cfg.sinBinMinutes` → `State.squads[].sinBin[].expiresAt`, `State.squads[].sinBinLog[]`, swept in `apply` | **extended** | W4a (#425) §3.1. Before W4a a temporary dismissal ended **only** on an explicit `football.sinbin.end`, so the competition's own sin-bin length was recorded and never counted down. Expiry is **lazy**: the fold releases the player at the next STAMPED event at or after `expiresAt`, which means the pad (rendering the countdown from `expiresAt`) and the fold legitimately disagree in between — by design, and a `PadSpec` obligation for W5, not a bug. An **unstamped** event sweeps nothing, which is what keeps every pre-W4a stream folding unchanged, and both halves are required, so nothing expires that did not expire before. Two further sweeps close the gap lazy expiry leaves: the **whistle that closes a phase** ends anything that ran out inside it, and the **final whistle** (full time, a shoot-out decision, a forfeit, an awarded abandonment) ends every TIMED dismissal still standing — without them a bin that expired with nothing stamped after it survived into the final state and every consumer read the side a player short at full time. Both are TIMED-only, so an unstamped bin still keeps the side short to the end, which is what leaves the frozen goldens untouched. An anonymous bin closes without returning anybody to the pitch. The explicit end still works, and one stamped at or after a derived expiry is a **no-op, not a refusal** — the scorer recording a release the fold has already swept is being right, and refusing punishes them for the fold's own laziness. Narrow: reconciled against `sinBinLog` (the only record left once the sweep removes the entry), so a release of a bin that never existed, one still running, or one for a player the fold sent off all keep their rejection. |
| **A sin bin carrying into the next half** | as above | `person` | `Cfg.halfMinutes` / `Cfg.extraTime.halfMinutes`, overridden by `Cfg.periodSeconds` → `State.squads[].sinBin[].expiresAt` | **extended** | W4a §3.2, **amended 2026-08-04**. The wave originally ruled that expiry never crosses a period boundary, on the reasoning that the engine held no half length. Both halves were wrong: IFAB's temporary-dismissal protocol carries the unserved remainder into the next half exactly as IIHF carries a penalty, and `Cfg.halfMinutes` is a **required** positive integer, so the length was never missing. Leaving the expiry in-period was not a harmless approximation but actively wrong under lazy expiry — `{H1, 3200}` sorts before every H2 stamp, so the first stamped event of the second half swept a bin with 500 seconds still to run, under-serving the player in the offending side's favour. The lengths come from cfg's own required scalars; `Cfg.periodSeconds` is an **override for the one thing they cannot express**, halves of UNEQUAL length, and a map that merely contradicts the scalar is **ignored, not refused** (cfg is read live on every fold, so a `CONFIG_INVALID` there would let one admin edit make every already-scored fixture in the division unviewable). The carry counts against the NOMINAL length, so a half that ran into added time still carries against 45. Where there is no later phase to carry into, the **named fallback** applies: the expiry stays in-period past the nominal length and the bin ends on the explicit release or the final whistle. |
| A sin-binned player then sent off | as above | `person` | `applyCard` lineup check + `removeFromPitch` | **extended** | A player serving a temporary dismissal is off the pitch but still cardable; a permanent dismissal drops their bin entry so they cannot "return". |
| Substitution (off / on) | all | `off`, `on` | `Ev.FootballSub` **or** `core.lineup.substitution` → `reduceLineupEvent` → `State.squads[].onPitch\|bench\|offUsed` | modelled | `off` must be on the pitch, `on` must be someone this side may bring on. S3/W4b (#426) — **two vocabularies, one decider.** `football.sub` cannot be deleted (the frozen corpora contain it) so it stays on the wire unchanged; what moved is what its fold CALLS. Both it and the kernel's `core.lineup.substitution` now put the question to `core/lineup.ts`'s one reducer, and `football.lineup.test.ts` holds them to the same NUMBER of permitted substitutions rather than to "each works" — which is what the last three placer/verifier bugs in this repo each looked like. The kernel form additionally carries `positionKey`, which the legacy form has no field for. |
| **Return ("rolling" / "flying") substitution** | `youth`, `small-sided` | `off`, `on` | `Cfg.rollingSubs` → `lineupPolicy().reentry` (`unlimited` \| `none`) | **extended** | Absent ≡ pre-W4 behaviour (a substituted player may not return). When on, the player who came off rejoins the **bench** and nothing lands in `offUsed`. Declared `true` on both the `youth` and `small-sided` presets and left unset on `11-a-side`. S3/W4b (#426), owner ruling 2 — re-entry is a cfg knob (`none \| once \| unlimited`) and not a per-sport constant, and football is the sport that proves why: Law 3.3 is no-return while the grassroots and small-sided dispensations that share this module are rolling. The private `bench.includes(on)` test that used to encode it is gone. |
| **Cap on substitutions per side** | `11-a-side` (5 under most senior regulations) | entrant | `Cfg.maxSubs` → `lineupPolicy().maxSubs` → `SideSquad.subsUsed` | **extended** | Counted from `squad.offUsed.length` less any exempt replacements, so it still needed no new always-present state. Never applied under `rollingSubs`, which is uncapped by definition. Absent = uncapped, which is what every pre-W4 stream assumed. S3/W4b (#426) — the cap now has **one** reader, the shared reducer, and it is asserted through both substitution vocabularies at once. The refusal is also cfg-derived, so it is a WRITE-path error only: replaying a fixture whose competition has since lowered `maxSubs` folds rather than throwing, because the substitution was legal when it was made and there is no event left to void. |
| **Substitution *windows*** (3 windows for 5 subs) | `11-a-side` | entrant | `Cfg.subWindows` + `Ev.FootballSub.at` → `State.squads[].subWindows[]`, error `SUB_WINDOW_EXCEEDED` | **extended** | W4a (#425) §5.2. Unblocked by the core time model: the clock fact State had no clock for is now the stamp on the event. A window is the set of substitutions **sharing one `at`**, so three players sent on at a single stoppage spend one window; five subs taken one at a time spend five, which is exactly the Law that `Cfg.maxSubs` alone could not express. Counted per side, and applied **alongside** `maxSubs`, never instead of it. An **unstamped** substitution is in no window and consumes none — reading "no stamp" as one shared window would trip a one-window allowance on the second unstamped sub and make every pre-W4a stream unfoldable; recording one window each is the mirror of the same bug. Absent `Cfg.subWindows` = unlimited windows, which is what every pre-W4a stream assumed. First throw site for `SUB_WINDOW_EXCEEDED` (422). |
| Injury as the reason for a substitution | all | `off` | — | deferred | A scorebook records the substitution, not the injury; the reason is medical data with consent implications. Needs a product decision. |
| **Concussion (additional permanent) substitution** | all | `off`, `on` | `Cfg.concussionSubs` → `lineupPolicy().exemptions.concussion` → `core.lineup.replacement {exemption:"concussion"}` → `SideSquad.exemptUsed`, `State.squads[].exemptUsed` | **extended** | S3/W4b (#426). Closed by the kernel-owned lineup model: a replacement charged to a NAMED exemption rather than to the cap is a `core.lineup.replacement`, and `Cfg.concussionSubs` is what declares the exemption exists and how many. **Config-driven, never hard-coded** (owner ruling): the IFAB protocol is adopted per competition, so absent = the trial is not in force and the kernel refuses the event outright (`exemption-not-declared`) — which is also what stops a pad evading `maxSubs` by inventing an exemption key. The replacement is **permanent**, so its outgoing player still lands in `State.squads[].offUsed`; `exemptUsed` is carried alongside precisely so the cap arithmetic (`offUsed.length − exempt`) does not let the exemption spend the ordinary allowance one event later. Absent until the first exempt replacement, so no frozen stream moves. |
| Starting XI confirmed pre-match | all | 11 persons | `Lineup.slots[slot="starting"]`, `positions.lineup.size` | modelled | `validateLineup` enforces the exact count. |
| Captain confirmed pre-match | all | one person | `Lineup.slots[].roles = ["captain"]`, `positions.roles` | modelled | Declared `unique: true`. |
| Goalkeeper confirmed pre-match | all | one person | `Lineup.slots[].positionKey = "GK"` (`min:1, max:1`) → `initSquads` → `personsAtPosition(squads.home, "GK")` | modelled | S3/W4b (#426) — the "State does not know who the keeper is" caveat is **closed at the fold, not at State**, and the distinction is deliberate. `init` now builds its squads through the kernel's `initSquads`, which KEEPS `positionKey`; the keeper is nameable by person id from `foldMatchWithStoppage(...).squads` and from `ctx.squads` inside `apply`, at init and after every accepted change. It is **not** copied into `FootballState`, and cannot be: `state.squads` is inside the recorded state that the frozen corpus compares byte for byte, so any always-present position field there reds all eleven football streams (that is the same constraint the deferred row below used to cite, now measured rather than assumed). One squad, one place, projected on read. |
| **Goalkeeper change without a substitution** | all | `person` | `core.lineup.position {positionKey:"GK"}` (kernel-owned) → `SquadMember.positionKey` | **extended** | S3/W4b (#426). No `Ev.FootballKeeper` was needed and none was added: a change of gloves is a POSITION change, which is one of the five kernel `core.lineup.*` types, so all eleven sports get it from one implementation and football's event union does not move. It **charges nothing** — `core.lineup.position` never touches `SideSquad.subsUsed` — which is #426's explicit requirement ("swap the goalkeeper without spending a substitution") and is asserted against a `Cfg.maxSubs` that still bites on the very next substitution, so the assertion cannot pass vacuously. A keeper who comes on as a SUBSTITUTE carries `positionKey` on the incoming slot of `core.lineup.substitution` instead; the legacy `football.sub` states no position and therefore still changes nobody's. |
| **Goalkeeper stats: clean sheets, goals conceded** | all | person (goalkeeper) | `playerStats.folded` → `playerStats.goals_conceded`, `.clean_sheets` | **extended** | S8/#417. Closes the IOU the row above's own "Incomplete/missing" writeup left open. Read from the FOLD of `core.lineup.*` events, never the kickoff sheet — `footballKeeperStatsFold` (`football.ts`) replays `initSquads(lineups)` forward under `REPLAY_LINEUP_POLICY` and reads `personsAtPosition(side, "GK")` at the moment of each goal, so a mid-match keeper change splits both metrics between the two people who actually held the position. `goals_conceded` is charged to the CONCEDING side's current keeper, worked out from the CREDITED side (`opponent(credited)`), never from `by` directly — an own goal is credited to `opponent(by)`, so the two disagree exactly there. CLEAN SHEET is a documented judgement call, not a Law: a goalkeeper SPELL (the continuous stretch one person holds "GK") earns one iff its side conceded nothing during it, so a shutout split across two keepers credits BOTH and a keeper who concedes before being substituted off does not lose the clean sheet the OTHER keeper goes on to earn. `saves` now IS shipped — see the "Saves and save percentage" row below, S8/#417 W6. **Carried limitation**: a keeper sent off (`football.card`) and replaced by an outfield player with no recorded `core.lineup.position` stays the named "GK" here — the sending-off is football-private state (`FootballSquad.sentOff`), invisible to `core/lineup.ts`, the same carried-limitation shape the row above documents for a fixture mixing `football.sub` with `core.lineup.*`. |
| Shots on goal, per side | all | entrant, person (taker) | `Ev.FootballShot` → `State.shots[]`, `playerStats.shots`/`.shots_on_target` | **extended** | S8/#417 W6 (S2/#430's parked row, closed this session). New event type `football.shot`. A shot is a shooting side, an outcome (`ShotOutcome`: scored/saved/missed/blocked — its own enum, not the shared `AttemptOutcome` penalty vocabulary: "blocked" — stopped by an outfield defender before it ever reached the keeper, structurally impossible for a Law 14 penalty, where only the keeper may intervene — has no equivalent there), an optional `taker` (mirrors `FootballPenalty.taker`'s naming) and an optional defending `goalkeeper`. `outcome:"scored"` and the real `football.goal` event both describe ONE event on the pitch — see the row below for how `playerStats` avoids double-charging it. State-only, score-neutral: `coarsen` drops it (no score effect, same arm as cards/subs/penalties/sin bins), so it is absent from `summary.detail`. Band 3 ("detail") in `padSpec`'s fidelity map, per S2/#430's ruling — football's old tier 3 was an unfilled duplicate of tier 2 until this session; reuses tier 2's own entitlement (`scoring.match_timeline`) rather than inventing a new billing-plan row. |
| Saves and save percentage | all | person (goalkeeper) | `playerStats.folded` → `playerStats.saves`, `.shots_faced`, `.save_percentage` | **extended** | S8/#417 W6, closes the row above's "`saves` is NOT shipped" IOU — a save now has a per-attempt input to fold from, not just a missed penalty's single kick. Extends `footballKeeperStatsFold`: `shots_faced` is `saves + goals_conceded`, never a count of outcome-"scored" shots — a goal is already fully known from `football.goal`, so it needs no redundant shot logged alongside every goal. An outcome-"scored" shot NEVER bumps `goals_conceded`/`shots_faced` (double-charging the goal the row above already counts); it is read for coverage evidence only. The credited keeper is `Ev.FootballShot.goalkeeper` when present, else the same spell-derived on-ice occupant `goals_conceded` already uses. SAVE PERCENTAGE is gated on a per-SIDE coverage checksum (owner ruling, S2/#430, restated for shots): a side is trusted iff every goal it conceded also has a matching outcome-"scored" shot logged against it — the strongest signal answerable from inside the ledger alone, not an absolute guarantee (a side that conceded nothing has no goal to check a shot log against and is trusted by default). Omitted entirely, not a false zero, when the checksum fails — see `footballKeeperStatsFold`'s own docstring (`football.ts`) for the full reasoning. |
| **Shirt numbers** | all | every squad member | `entrantModel.team.squadNumbers = true` + `LineupSlot.squadNumber` | **extended** | Unblocked later in W4: the number field landed on `LineupSlot` (`src/core/types.ts`), so the affordance the entrant model declares now has a home on the lineup. Optional, and the fold never reads it. |
| **Squad size per variant (5-, 7-, 9-a-side)** | `small-sided` | 5–9 persons | `Cfg.teamSize` → `positionsFor(cfg)` → `resolvePositions` | **extended** | Unblocked later in W4: `SportModule.positionsFor?(cfg)` (`src/sport/module.ts`) and the `resolvePositions` accessor (`src/sport/catalog.ts`). Football declares `teamSize: 7` on `small-sided` (`football.ts`), so `validateLineup` now compares against the variant's own starting count. Lineup-only — never the fold. |
| Bench size | all | up to 12 persons | `positions.lineup.benchMax = 12` | modelled | Same per-variant caveat as squad size. |
| Two halves and half-time | all | n/a | `Ev.FootballPeriod.phase` `HT`/`FT` → `State.periods[]` | modelled | `Cfg.halves` is `z.literal(2)`. |
| Half length | all | n/a | `Cfg.halfMinutes` | modelled | Variant presets: 45 / 30 / 20. |
| Extra time (two halves) | `11-a-side` in knockout stages | n/a | `Cfg.extraTime`, phases `ET_H1`/`ET_H2`, markers `ET_HT`/`ET_FT` | modelled | Only entered when the score is level at FT. |
| **Added time (allowance for time lost)** | all | n/a | `Ev.FootballPeriod.addedMinutes` → `State.periods[].addedMinutes` → `summary.detail.periods` | **extended** | Stamped on the period the marker **closes**, not the one it opens. A match report writes "90+3", which a bare integer `minute` cannot tell apart from the 93rd minute of extra time. |
| Quarters instead of halves | `mini-soccer` | n/a | `Cfg.halves`: `z.literal(2)` → `z.union([z.literal(2), z.literal(4)])`; `PlayPhase` +`Q2`/`Q3`/`Q4`; `Ev.FootballPeriod.phase` +`QT`/`3QT` | extended | S5 (#431), owner-ruled `build` 2026-08-03 (decision log: `docs/superpowers/specs/2026-08-06-scoringpad-v2-prompts/_INDEX.md`, 2026-08-11 entry). Q1 is `H1` REUSED, never renamed — `core.start` is unchanged. The Q2/Q3 boundary reuses marker `HT` (the real half-time interval); the Q4/done boundary reuses `FT`; only the Q1/Q2 and Q3/Q4 boundaries needed new markers. Every `applyPeriod` arm gates on `cfg.halves`, not merely on `state.phase` — a marker legal in one mode sent from the other mode's matching `state.phase` is refused (`WRONG_PHASE`), never silently reinterpreted. New variant `mini-soccer` (FA U7–U10, 10-minute quarters, 7-a-side, rolling subs); the declared `youth` preset (FA U13+, 2×30 halves) is unchanged — see the per-variant table. |
| Kick-off, and which side kicks off | all | entrant | — | deferred | `core.start` is kernel-owned, carries no side, and is outside this family's blast radius; a `football.kickoff` would duplicate the start semantics. Needs a product decision. |
| Ends changed at half-time | all | n/a | — | deferred | Not entered in a match record. |
| **Temporary suspension of play, then resumption** | all | n/a | `core.suspend` / `core.resume` (kernel-owned) | **extended** | Unblocked later in W4: the pair landed in `src/core/events.ts` and is folded inside `foldMatch`, so it never reaches a module's `apply` and no sport re-implements it. A suspension that is never resumed leaves the stoppage open; `core.abandon`/`core.forfeit` close it in the same step they decide. |
| Abandonment | all | n/a | `core.abandon`, `Cfg.abandonPolicy` → `State.replayFlagged`, `summary.detail.abandoned` | modelled | `replay` leaves the fixture undecided; `award` decides for the leader (level ⇒ `no_result`). |
| Forfeit / walkover | all | entrant | `core.forfeit`, `Cfg.awardScore` | modelled | Awards the configured score to the opponent. |
| Kick from the penalty mark, and whether it scored | all, in knockout stages | kicker `person` | `Ev.FootballShootoutKick` → `State.shootout.kicks[]` | modelled | Kicker must be on the pitch; shootout kicks never touch `State.goals`. |
| Shootout order and alternation | as above | entrant | `expectedKicker()` in `sports/period/shootout.ts` | modelled | Out-of-turn kicks are rejected. |
| Shootout early decision and sudden death | as above | entrant | `shootoutDecision()` | modelled | Best-of-five with early decision once the lead exceeds the opponent's remaining kicks, then sudden-death pairs. |
| Which side takes the first kick | as above | entrant | the `by` of the first recorded kick | modelled | The recorded order *is* the coin-toss result; no separate field needed. |
| Keeper facing a shootout kick, and how a kick missed | as above | keeper | — | deferred | Niche even in an elite match record, and the wrong fidelity for tiers 0–3. |
| ABBA shootout order | as above | entrant | — | deferred | Trialled and withdrawn by IFAB; not in force in any competition we serve. |
| Group-stage shootout points split | `11-a-side` in group stages | entrant | `Cfg.points.shootoutWin`, `.shootoutLoss` | modelled | Youth-cup convention (SO win 2 / SO loss 1); folded through `declaredPointsSets`. |
| Referee and assistants | all | officials | `officialLabel.scorer = "Referee"` | deferred | Officials are a competition-layer assignment (the officials rota), not a match event; the module declares only the label the scoring UI shows. |
| Man of the match | all | `person` | `core.award` + `playerStats.awards[motm]` | modelled | Kernel-owned event, undoable via `core.void`. |
| Referee's written remarks | all | n/a | `core.note` | modelled | No state effect by contract. |
| Attendance, weather, pitch condition | all | n/a | — | deferred | Fixture metadata, not a scorebook event — belongs on the fixture record, not in the ledger. |

| Where in the match an event happened (the position axis) | all | — | `SportModule.position(state)` -> `period` + `clock` segments, e.g. `H2 . 48:12` | extended | W4a T6b. A **read-side projection**, never a payload: a `MatchPosition` on every stamped event was considered this wave and rejected, because position is derivable from state the fold already computes and recording it would create a recorded value and a derived value of the same type that can silently disagree — the `DisciplineCard.entrantSide` shape. A wrong recorded value is in the hash-chained ledger forever; a wrong projection is one deploy away from fixed. Ordered segments rather than a display string, so W8 can drop a segment for a 375px scorebug, localise each `key` and order two positions in one match; `formatPosition` is the plain-text path. Nothing is materialised into state, so every frozen golden is byte-identical. Football and the period kernel have different state types and cannot share a module member, so both delegate to the core `periodClockPosition` and the conformance suite holds them to ONE shape. That is the direct answer to this wave's five hand-rolled time-model divergences in this file. Ranked against `playPhases(cfg)` — the wider list an event's `at.period` is validated against — never the narrower `PLAY_PHASES`. |

**Row counts:** 25 modelled, 28 extended, 9 deferred (62 rows). No blank cells.
Asserted against the table itself by `src/testkit/dossiers.test.ts`.

## Per-variant divergence

| variant | where the model diverges | how it is expressed |
| --- | --- | --- |
| `11-a-side` | Baseline. Return-forbidden substitutions under a competition cap; extra time and kicks from the penalty mark in knockout; sin bins below NLS step 4. | `Cfg.maxSubs`, `Cfg.extraTime`, `Cfg.shootout`, `Ev.FootballSinBinStart` / `Ev.FootballSinBinEnd`. |
| `youth` | 2×30 halves (FA U13+); **repeat substitutions**; sin bins are standard, at a shorter pro-rata period. | `halfMinutes: 30` + `rollingSubs: true` on the preset; `Cfg.sinBinMinutes` per competition. |
| `small-sided` | 2×20 halves; **flying substitutions**, uncapped; time penalties of sin-bin shape; **a 5-, 7- or 9-man team**. | `halfMinutes: 20` + `rollingSubs: true` on the preset; `Ev.FootballSinBinStart` / `Ev.FootballSinBinEnd`. Squad size is **deferred** — `positions.lineup.size` is a single module-level `11`. |
| `mini-soccer` | S5/#431. FOUR 10-minute quarters (FA Mini-Soccer, U7–U10) instead of `youth`'s 2×30 halves — a disjoint age group, not a replacement; **repeat substitutions**; **a 7-man team**. Q1 is `H1` reused; the real half-time (Q2→Q3) reuses marker `HT`, full time (Q4→done/ET/shootout) reuses `FT`; only the Q1→Q2 and Q3→Q4 boundaries needed new markers (`QT`, `3QT`). | `halves: 4` + `halfMinutes: 10` + `rollingSubs: true` + `teamSize: 7` on the preset; `Ev.FootballPeriod.phase` gains `QT`/`3QT`; `PlayPhase` gains `Q2`/`Q3`/`Q4`; every `applyPeriod` arm additionally gates on `cfg.halves`. |

## Person attribution — what is complete, what is not

Football sets the pattern the other families copy, so this is explicit.

**Complete** (the role exists, is optional, and the fold retains it):

| event | person roles | retained in |
| --- | --- | --- |
| `football.goal` | `scorer`, `assist` | ledger + `playerStats.goals/assists/penalty_goals` |
| `football.card` | `person` | `State.cards[].person`, `discipline.extractCards`, `playerStats.*_cards` |
| `football.sub` | `off`, `on` (both **required** — a substitution with nobody named is not a fact) | `State.squads[].onPitch/bench/offUsed` |
| `football.shootout.kick` | `person` (kicker) | validated against the pitch; not retained per-kick in State |
| `football.penalty` *(W4)* | `taker`, `goalkeeper` | `State.penalties[].taker/goalkeeper`, `playerStats.penalties_missed` |
| `football.sinbin.start` / `.end` *(W4)* | `person` | `State.squads[].sinBin[].person`, `playerStats.sin_bins` |

**Incomplete / missing:**

1. ~~**The goalkeeper is never named in State.**~~ Closed in S3/W4b (#426), and
   closed **at the fold rather than in `State`** — read that distinction before
   using it. `squadFromLineup` is gone; `init` builds its squads with the
   kernel's `initSquads`, which keeps `positionKey`, so
   `personsAtPosition(squads.home, "GK")` names the keeper by person id at init,
   after a `core.lineup.position` change of gloves, and after a keeper
   substitution — from `foldMatchWithStoppage(...).squads` on the read side and
   from `ctx.squads` inside `apply`. Goalkeeper stats (clean sheets, saves,
   goals conceded) are therefore derivable now; ~~none is declared yet, which
   is S8's job, not this wave's~~ **S8/#417 shipped `goals_conceded` and
   `clean_sheets`** — see the mapping-table row above. `saves` stays
   undeclared, and structurally so: no save-shaped event exists in
   `FootballEv`.
   **What is NOT closed, deliberately:** `FootballState` itself still holds only
   person-id lists. `state.squads` is inside the state the frozen corpus
   compares byte for byte, and every default lineup names a GK, so ANY
   always-present position field there reds all eleven football streams at init
   — measured this session, not assumed. Carrying it in State would also make
   the recorded position and the folded one two constructions of one fact, which
   is the `DisciplineCard.entrantSide` shape. One squad, projected on read.
   **Carried limitation:** a legacy `football.sub` states no position and never
   reaches the kernel's squads (it is a module event; only `core.lineup.*` is
   kernel-folded), so a fixture scored with the legacy vocabulary answers
   position questions from the team sheet. A pad that wants position-accurate
   substitutions emits `core.lineup.substitution`, which carries `positionKey`
   on the incoming slot. **One fixture should use one vocabulary.** Membership
   is merged correctly either way (`mergeFromKernel` applies the kernel's delta
   rather than overwriting, so a red card, a sin bin and a legacy substitution
   all survive a later kernel event), but two things are undefined in a mixed
   fixture: positions, as above, and the CAP as the kernel counts it —
   `SideSquad.subsUsed` never sees a `football.sub`, so a kernel substitution
   made after legacy ones is judged against a low count. The legacy path does
   not have the mirror problem: it lifts football's own squad, which has both.
   Closing the mix properly needs the fold to route a module event into the
   kernel squad — a `core/events.ts` change, outside this session's blast
   radius, and it should be weighed against simply retiring `football.sub` from
   the pad once `core.lineup.*` ships there (the type must stay on the wire
   either way: the frozen corpora contain it).
2. **The shootout kicker is validated but not retained.** `applyShootoutKick`
   checks `person` is on the pitch and then folds only `{side, scored}`. Shootout
   conversion is not attributable from State (it is from the ledger).
3. ~~**The own-goal scorer is retained but not counted.**~~ Closed later in W4:
   `playerStats.own_goals` (`football.ts`) reads `football.goal.scorer` under
   `{when: p.ownGoal === true}`. `goals` and `points` are unchanged.
4. **Anonymous is always legal.** Every person field above except
   `football.sub`'s `off`/`on` is optional, and every fold has an anonymous path
   (cards, sin bins and penalties all record without touching the pitch).

## Downstream owed

Nothing here was acted on.

1. **New enum values the web-side vocab does not know**: `CardReason`
   (13 members), `PenaltyOutcome` (`saved`/`missed`/`post`).
   `apps/web/src/lib/scoring-vocab.ts` humanises unknown values, so nothing
   breaks — but they will read as raw snake_case until they get labels, in all
   four locale dictionaries.
2. **New event types the pad must be able to emit**: `football.penalty` and
   `football.sinbin.start`/`.end`, all tier-2/3 only (`scoring.match_timeline`
   entitlement). Neither moves the score.
3. **Facts the pad must prompt for**: the penalty `outcome` (required — there
   is no valid `football.penalty` without it); the sin-bin duration when
   `Cfg.sinBinMinutes` is not set; `addedMinutes` at each period marker.
4. **New config the rules editor should expose**: `rollingSubs`, `maxSubs`,
   `sinBinMinutes`, (W4a) `subWindows` and `periodSeconds`, and (S3/W4b)
   `concussionSubs` — the last one is the competition's adoption of the IFAB
   concussion-substitute trial, so it belongs beside `maxSubs` and reads
   "additional permanent substitutions for a suspected concussion", default
   none. `periodSeconds`
   is deliberately NOT a general "how long is a half" knob — `halfMinutes` and
   `extraTime.halfMinutes` already answer that and win where the two disagree —
   so an editor should surface it only as "halves of unequal length", or not at
   all. `rollingSubs` now ships `true` on the
   `youth` and `small-sided` presets, so an editor that renders variant presets
   will show a changed default for those two. `subWindows` is left unset on every
   preset on purpose: three windows is a senior-11-a-side regulation, not a Law
   constant, and absent means unlimited.
5. **Stat models that become possible**: `penalty_goals`, `penalties_missed`,
   `sin_bins` are new `playerStats.metrics` keys and will appear as new
   leaderboard columns. `points` is unchanged (`penalty_goals` is a strict
   subset of `goals`).
6. **W4a — what the pad owes the time model** (`PadSpec`, #416). Four things,
   and none of them is an engine constraint:
   - **The unit.** `at.elapsed` is SECONDS, the legacy `minute` is MINUTES, and
     nothing in the fold converts between them. A pad offering minute-only entry
     multiplies by 60 itself; `core/time.ts`'s `parseElapsed` takes `mm:ss` only
     and refuses a bare number precisely because this sport's legacy field is
     called `minute`.
   - **Remaining-basis entry needs a period length.** `Cfg.halfMinutes` is the
     NOMINAL half — `elapsed` may legitimately overrun it (`90+3`) and the carry
     counts against the nominal — so a pad offering "07:19 remaining" converts
     itself against the length it is drawing.
   - **Render what the fold is folded *as of*.** A sin bin expires lazily, at the
     next stamped event, so between the expiry and that event the pad's countdown
     and the folded pitch are meant to differ. `State.asOf` is what the pad shows
     so a scorer does not read the stale chip as a bug. Offering the explicit
     "return" button anyway is **safe**: a release the fold has already swept is
     a no-op, not an error.
   - **One window is ONE frozen stoppage stamp, reused verbatim.** A substitution
     window is exact-stamp equality (`period` and `elapsed` both), so a pad
     stamping each substitution off a live timer records `H1 600` for the first
     and `H1 601` for the second at a single stoppage and burns two windows
     against `Cfg.subWindows`. The pad must freeze the stamp when the stoppage
     opens and send that same object with every substitution made at it.
   - **Stamps go in non-decreasing order.** A backwards stamp is
     `NON_MONOTONIC_TIME` (422), and every stamped payload counts — including the
     penalty, the shoot-out kick and the period marker, which now advance the
     high-water mark like everything else. Correcting one is void **then**
     re-append, in that order, and an "edit" affordance on anything but the
     newest stamped event must undo forward to it.
7. **No `apps/web` surface, and no e2e, on purpose.** W4a ships engine-side only:
   no API field, no dictionary key, no pad control, so there is nothing to drive
   in a browser. e2e coverage for stamped football events is **deferred to W10
   (#421)**, where the pad first meets the API; persisting `at` (the events table
   gains no column this wave) is deferred with it. Recorded here rather than in
   the mapping table because the table's rows are sport-fact → schema-path tuples
   that `testkit/dossiers.test.ts` tallies, and a process row would corrupt the
   count.
8. **Not in the summary, on purpose**: unconverted penalties and sin bins are
   in `State` and on the ledger but **not** in `summary.detail`. Conformance
   §9.6 requires `summary(coarse fold) === summary(fine fold)` and `coarsen`
   drops every event with no score effect — the same reason `cards` has never
   been in the summary. A match report must read the ledger, not the summary.

## Blockers — all five were raised, and all five are now cleared

This section listed five shared-engine changes the football pass needed and was
not allowed to make: they sat outside one sport family's blast radius. The
shared-engine pass later in W4 made **every one of them**, on this same branch.
Nothing in this dossier is blocked. The mapping-table rows that read `deferred`
because of these are now `extended`, each naming what implements it.

| was blocked on | now | where it lives |
| --- | --- | --- |
| `DisciplineCard` had no `reason` | done | `DisciplineCard.reason` in `src/core/types.ts`; the conditional spread in football's `extractCards` |
| `PositionCatalog` was per module, not per variant | done | `SportModule.positionsFor?(cfg)` (`src/sport/module.ts`) + `resolvePositions` (`src/sport/catalog.ts`); football declares `Cfg.teamSize`, `small-sided` sets `7` |
| `LineupSlot` had no shirt-number field | done | `LineupSlot.squadNumber` in `src/core/types.ts` — the same name the roster path already used (`src/sport/entrant-model.ts`) |
| no resumable suspension in the core event set | done | `core.suspend` / `core.resume` in `src/core/events.ts`, folded inside `foldMatch` and never forwarded to a module's `apply` |
| `src/stats/stats.test.ts` blocked an `own_goals` metric | done | `playerStats.own_goals` in `football.ts`; the closed-set assertion in `stats.test.ts` was widened to the new correct row |

**Still genuinely deferred** (and still marked `deferred` in the table above):
the shootout kicker is validated but not retained in `State`; the injury
behind a substitution is medical data with consent implications. Each of
those needs a product decision or a state-machine extension, not a
shared-engine field.

**Closed in S4 (#428):** the Law 12 direct-free-kick offence taxonomy behind a
conceded penalty. It never actually needed a declared fidelity tier — that was
this row's own premise, and it was wrong: the taxonomy is short (8 members) and
closed (IFAB Law 12 §3), so it shipped as `PenaltyOffence`, additive and
optional on `Ev.FootballPenalty`, at the module's existing fidelity tiers.

**Closed in S5 (#431):** quarters instead of halves. This row's own premise —
that it needed a product decision to declare a `mini-soccer` variant first —
was the blocker, not the state-machine work itself: the owner ruled `build`
2026-08-03, and the mechanism turned out to be a bounded, additive extension
of the SAME pattern extra time already used (a cfg-gated switch arm plus a
compile-time preset), not a new kind of machinery. `PlayPhase` gained three
members (`Q2`/`Q3`/`Q4` — Q1 is `H1` reused, not a fourth), the marker enum
gained two (`QT`, `3QT`; the other two quarter boundaries reuse `HT`/`FT`
verbatim), and `applyPeriod` gates every arm on `cfg.halves` so the two modes
cannot be confused for each other even though they share `state.phase ===
"H1"` as their opening state. See the mapping table row above and the
per-variant table for the shipped shape.

**Cleared in S3/W4b (#426)** by the kernel-owned lineup model
(`src/core/lineup.ts`): the keeper is nameable by person id at every fold point
(finding 1 above, with its stated limitation), a goalkeeper change costs no
substitution, and the IFAB concussion replacement has a cfg-declared exemption
outside `Cfg.maxSubs`. Football's private squad model is gone: `squadFromLineup`
is deleted, `Cfg.maxSubs` has exactly one reader (`lineupPolicy`), and "may he
come back" is `LineupPolicy.reentry` rather than a `bench.includes(on)` test.
