# Format Progression (F) — session index

**One session per prompt file.** Read `_RULES.md`, then this file, then the
session's prompt. This file is the compaction anchor: every ruling, false
premise, and status change gets written here **as it happens**.

Design of record: `../2026-08-17-format-progression-design.md` (approved
2026-08-17). Origin: owner ask — *"as an org, I can choose any format with
customization and I want to see all fixtures including final from day one."*

## Order

F1 is independent and ships first. F2 is the schema unification; F3 consumes it;
F4 depends on F3; F5 is last.

**F1 and F2 run in parallel but are NOT file-disjoint.** Both open
`apps/web/src/server/usecases/stages.ts` — F1 at `bracketToGen` and
`roundTitle`, F2 at `qualifierCount` and `seedNextStage`. `roundTitle` and
`qualifierCount` sit about three lines apart, inside git's merge-context
window, so the conflict is real rather than theoretical. Managed by: separate
worktrees, **F1 merges first**, F2 rebases onto merged F1 before opening its
PR. F2 is additionally fenced off `scheduling/bracket.ts`, `exports/build.ts`
and those two `stages.ts` functions; F1 is fenced off `qualification.ts`,
`stage-seeding.ts`, `format-templates.ts`, the take-rule region of
`schemas.ts`, and the catalogue fixtures.

| Session | Prompt file | Depends on | Status |
|---|---|---|---|
| F1 | `F1-bracket-round-role.md` | — | **MERGED** as #606 (2026-08-18), plus #613 which named the knockout tree's rounds — the one bracket shape F1 left with no captions at all |
| F2 | `F2-unified-progression-field.md` | — | **MERGED** as #616 (2026-08-18, `ef473f586`), 60 commits. One `progression` field; `qualification` and `seeding` dropped. Migrations V371-V373, no version collision on main |
| F3 | plans: `../../plans/2026-08-18-f3-day-one-fixtures.md` + `../../plans/2026-08-18-f3-task5-entrant-churn.md` | F2 **merged** ✅ | **ALL SIX DELIVERABLES DONE** 2026-08-19, DRAFT PR **#617**, branch `feat/f3-day-one-fixtures`, rebased onto `e7ccdd7eb` (post-P9). Six: nine emitters flipped to `timing:"setup"`; `groups_ko` draws from every pool; P6 resolved as a 422; §7 P1 **proven by execution** (day-one fixtures reach the board and survive a BUILD — same fixture id, byte-identical labels, entrant ids still null); entrant-churn detection + a rebuild that refuses once anything has been played; all 14 picker strings in 4 locales with a reader. Plus ruling 14's waiting-proposal prompt and ruling 12's amendment (carry was NEVER deliverable → F6). Gates: engine 3988/0/4001, web 5210 passed/12 failed/5290 (12 = 3 known-unrelated files: `org-addon-price-sweep` main-inherited, `org-posts-digest` cross-suite, `schedule-build-honours-locks` needs the placement service), gate 0 errors, i18n parity + key-union clean, OpenAPI drift found and closed (`e1e541692`). **Ultrareview run 2026-08-19 (13 findings): 9 fixed, 4 rejected with reasons — rulings 15-18 below.** Gates re-run after: engine 3989/0/4002, web 9325 passed/12 failed/9411 (the SAME 12 the branch started with), scripts 33/0/36, turbo typecheck+lint 4/4 with 0 errors, i18n parity 4904 x 4, no OpenAPI drift |
| F4 | **MERGED** as #619 (2026-08-18, `27af0f30d`), 16 commits. Export path + `.ics` feed + bracket poster | — | premise RETIRED (no sport/format-kind gap in either direction; its mexicano comment folds into F3). Slot **repurposed** to the export + calendar day-one leaks (§7 P5, P2). Does NOT wait for F3 — three catalogue templates already emit `timing: "setup"`. Owner CONFIRMED the repurpose 2026-08-18 |
| F5 | **prompt ready** — same doc §8 | all | scope fixed by the §5 table |
| F6 | **NEW, unwritten** — scoped by ruling 12's 2026-08-19 amendment | F3 | Make the SOLD entitlement `standings.carry_over` actually reachable. Wire `carryDeltas` + `config.carry_deltas` + the `standings_carried` event at `confirmSeedProposal` (mirroring `seedNextStage:2206-2247`, which already does it on the `on_complete` path); surface `REAL_TABLE_KINDS`' non-real-source rejection at propose time; relax the `schemas.ts` refine; add a carry control to the picker, which has none. Engine needs NO change — `config.carry_deltas → openingDeltas` already folds. Update `custom-points.test.ts`, `progression-multi-source.test.ts`, `progression-schema.test.ts`, which currently assert the rejection |

**Why F3–F5 are not written.** They consume F2's field shape, and this repo has
a repeated failure where a session authored against a design meets an
implementation that landed differently — the scoringpad index is full of
"the prompt's central premise was false" entries. F3 gets written after F2
**merges**, against real code.

## F4 closeout (MERGED #619, 2026-08-18) — what it changed and what it left

Delivered: the exported/printed draw (timetable, scoresheet, **bracket poster**)
and BOTH officials rotas resolve `home_slot_label`/`away_slot_label` through
`resolveSlotLabel` with the ORG's default locale; the public `.ics` feed emits
unscheduled day-one fixtures as all-day `STATUS:TENTATIVE` VEVENTs anchored on
`competitions.ends_on ?? starts_on`, with `SEQUENCE:0`/`SEQUENCE:1` and the UID
keyed on the fixture id so they update IN PLACE.

**Three things a fresh session will otherwise re-derive wrongly:**

- **`ticketRegistrationRows` was never part of P5.** The F3–F5 design §7 P5 and
  its §8 pickup prompt both claim it coalesces fixture participants to `"TBD"`
  "the same" as `officialDutyRows`. It does not — it selects
  `registrations.display_name`/`ref_code` and never joins `fixtures` or
  `entrants`. Verified twice, by two reviewers. Do not "fix" it.
- **The bracket poster runs its OWN fixture query** (`exports.ts` bracket arm),
  bypassing `exportFixtures` entirely. F4's first pass missed it for exactly
  that reason. Anything that changes how exported fixtures resolve must touch
  BOTH paths or it silently covers only one.
- **Adding a dictionary key is not finished until `npm run i18n:gen-keys` is run
  and `apps/web/src/lib/i18n-keys.ts` is committed.** `i18n:check` and the
  parity script BOTH stay green while that file is stale, because they compare
  the locales to each other. Only CI's drift gate sees it. F4 lost a CI cycle
  to this; #618 hit it the same day (`315ef26c0`).

**Left for F5** (found by F4's final review, none blocking at merge):
- `packages/engine/src/exports/build.ts:40` — `timeOf()` returns the literal
  `"TBD"` for every fixture with no `at`, i.e. **every day-one fixture**, so a
  French poster row reads `TBD | … | Vainqueur du Groupe A`. Column headers
  (`:53,:173`) are English too, and `home ?? "TBD"` (`:275,313,346,374`) IS
  reachable through the bracket arm. An earlier F4 note calling this
  "dead-not-wrong" was WRONG on both counts.
- `exports.ts` — scoresheet form lines and signatures ("Referee", "Captain — "),
  the Page-playoff description, and every section description are still
  hardcoded English on the very documents whose bracket chrome F4 localized.
- `calendar.ics/route.ts:37,80` — `?? "TBD"` and `?? "Entrant"` hardcoded;
  reachable when a fixture cites an entrant absent from `data.entrants`.
- `calendar.ics/route.ts:49-52` — **the `?entrant=` feed drops every day-one
  fixture by construction**: an unresolved fixture has both entrant ids null, so
  the predicate excludes it. "A player can subscribe to their own route through
  the draw" is NOT delivered and should not be claimed.
- Bare `?? "TBD"` of the same shape survives at `schedule.ts:2598`,
  `org-posts.ts:522,569,1357`, `officials.ts:600`, `match-reports.ts:224` —
  untriaged for placeholder-reachability.
- `registrations.ts:3001-3024` hand-rolls a second VCALENDAR builder that does
  not use `buildIcs`, and applies no `icsText` escaping — a comma or semicolon
  in a competition name emits a malformed TEXT value.
- `poster.pdf` still renders QR and branding only. A day-one full-draw poster is
  the product opportunity F4 makes possible for the first time.

**The one defect F4 itself created, and fixed before merge:** resolving slot
labels on the printed rota while `officiating-lane.tsx` still rendered "TBD"
left the screen and the PDF disagreeing — worse than the matching "TBD"s they
showed before. Caught only by the final whole-branch review; no test asserted
that screen and print agree, and none does now either.

## F3–F5 design (2026-08-18) — read before picking any of them up

`../2026-08-18-format-progression-f3-f5-design.md` is the design of record for
what remains. Two of its findings reverse premises stated elsewhere and will be
re-derived wrongly by a fresh session:

- **Neither F1 nor F2 delivered the owner's original ask.** All six multi-stage
  picker templates still emit `timing: "on_complete"`, so no format reachable
  from the picker shows day-one fixtures. F2 preserved every writer's behaviour
  deliberately. The capability exists and nothing uses it.
- **Placeholder labelling is exclusively a `setup`-timing feature.**
  `generateProgressionSetupFixtures` (`stages.ts:1432`) writes
  `home/away_slot_label` at `:1611, :1614`; the `on_complete` path never calls
  `descriptorLabel`. So flipping the templates switches labelling ON — it is
  not a risk to be mitigated. The exception is the export path, which selects
  no `*_slot_label` column at all and therefore prints "TBD" no matter what
  (§7 P5).

Also settled there: the downstream size is **always** derivable
(`progressionSize`); the unstable thing is the entrant list, and that hazard
already exists via `SEEDING_RULES_MISSING`. §8 carries copy-paste pickup
prompts for F3, F5 and two standalone product fixes.

## Owner rulings (2026-08-17)

1. **Universal day-one fixtures**: any format, including customised stage
   graphs, shows every fixture — final included — at setup.
2. **Unify onto one progression field** (owner chose this over the cheaper
   per-template fix), building the union of both vocabularies' expressiveness.
3. **L3/#414 finishes on `qualification`** rather than stopping mid-flight; F2
   migrates its `RoundLosers` union member along with everything else.
4. **The two overlapping rule pairs COLLAPSE** (2026-08-17). `topN {n}` and
   `rankRange {from:1,to:n}` say the same thing; `bestOfRank` and `bestNth` say
   near enough the same thing. F2 keeps **one of each and deletes the other**,
   naming which survived in its PR body. This is a breaking change to spec
   shape, which costs nothing today precisely because there is no production
   data — and would be expensive later. Keeping both would rebuild the drift
   this programme exists to end.
5. **Greenfield — there is no production data** (2026-08-17). F2 drops
   `stages.qualification` and `stages.seeding` outright: no backfill, no
   dual-read, no compat shims, no flags; constraints strict from day one. The
   migration is destructive and its correctness rests entirely on that premise,
   so **F2 verifies zero rows against the target database and stops if it finds
   any** — this ruling is dated and will outlive its accuracy. Consequence: F2
   does not need to split, so five sessions stands.

6. **F4 is repurposed, not retired** (2026-08-18). Its original premise —
   a sport/format-kind gap — was disproven in both directions, leaving one
   mexicano comment that folds into F3. The SLOT now carries the two places
   day-one fixtures leak on surfaces organisers hand out: the exported/printed
   draw and the subscribed calendar (design §7 P5, P2). Repurposing beats
   renumbering, which would break every reference already written to F5.
   F4 does NOT depend on F3 and the two may run in parallel — file sets are
   disjoint on inspection, and three catalogue templates already emit
   `timing: "setup"` so F4 has live test data today.

7. **Entrant churn: DETECT AND OFFER** (2026-08-18). When entrants change
   under a `setup` stage that already has generated fixtures, F3 surfaces it
   with a one-click rebuild rather than auto-regenerating silently or locking
   the entrant list. Nothing reshapes without the organiser choosing it — a
   bracket that has already been shared is the case that decides this.
   Consequence: the staleness signal does NOT exist today and must be built
   (derived, not stored); `lib/seeding-error.ts` is post-hoc only, so this is
   new UI rather than new copy. Design §2.2 and §7 P3.

8. **F4's ICS anchor: `competitions.ends_on`** (2026-08-18). An unscheduled
   day-one fixture has no time, and `IcsEvent` requires a `start` — so a
   tentative event needs a date from somewhere. `divisions` carry NO dates at
   all; only `competitions.starts_on` / `ends_on` (`V207:10`, both nullable).
   Ruling: all-day VEVENT on `ends_on`, falling back to `starts_on`, **skipped
   entirely when both are null** — a guessed DTSTART in somebody's subscribed
   calendar is worse than an absent event. `STATUS:TENTATIVE`, and the UID
   stays keyed on the fixture id so it converts to a timed `CONFIRMED` event
   **in place** rather than arriving beside a stale copy.

9. **V362's pre-publish mask STAYS** (2026-08-18). `public_fixtures_v` NULLs
   `scheduled_at` / `venue` / `court_label` for every fixture while
   `divisions.status = 'setup'` (`V362:25-27`) — so pre-publish the public
   calendar is empty *regardless of scheduling*, which is wider than the design
   doc's "unscheduled finals" framing of P2. That masking is a deliberate
   privacy rule feeding every public surface (bracket, schedule, embed, OG
   image), not just the calendar. Accepted consequence: during `setup` the whole
   feed is tentative all-day and converts at publish. Nothing new is exposed —
   slot labels are already unmasked by V362 itself.

10. **F3 flip scope: the six picker templates PLUS the format gallery**
    (2026-08-18). `config/format-gallery.tsx:277,308,321` carries its own
    `cannedStages` with `timing: "on_complete"` — a second user-reachable format
    surface the F3 brief did not name. Flipping only `format-templates.ts` would
    leave a gallery-created division with no day-one fixtures, which is the
    owner's ask leaking on a live surface. `stages-panel.tsx`'s ad-hoc
    `AddStageForm` (`:944`) and the seed scripts STAY on `on_complete`: that form
    POSTs and immediately calls `/generate`, which is on_complete semantics by
    construction, and moving it onto the propose/confirm flow is a different
    session's work.

11. **`groups_ko` converts `picks` → `topNPerGroup`** (2026-08-18; this
    ruling originally said "+ `snake`" and **ruling 13 overrode that** — the
    knockout target takes `rank_order`).
    Design §2.3 said the picker emits a flat ranked list that lets group-mates
    meet in the quarter-final. That is NOT the mechanism — `groups_ko`'s take is
    `picks` alternating `A1,B1,A2,B2…`, a hand-rolled 2-pool snake that is
    correct for two pools. The LIVE defect is different and worse: the builder
    offers a **pools 2–8 knob** (`division-builder.tsx:694-706`) that
    `buildTemplateStages` applies to the group stage, while the knockout's
    `picks` stay pinned to pools A and B — **with 4 pools, groups C and D
    qualify nobody**. The fix is `topNPerGroup n` (+ `bestNth` for the
    remainder, euro24's shape) with `placement: "snake"`, which is pool-count
    agnostic. A fresh session reading §2.3 alone will re-derive this wrongly.

12. **`timing: "setup"` + `carry` is rejected by the schema** — an OPEN product
    decision, not a defect (2026-08-18). `ProgressionSchema`'s second `.refine`
    (`api-v1/schemas.ts`) rejects the combination, so once F3 flips every picker
    format to `setup`, the marketed Pro entitlement `standings.carry_over`
    (`feature-copy.ts:51`, priced in all four marketing dictionaries) is
    unreachable on every picker format — via the API too, since no UI writes
    `carry` today. Nothing regresses for any current organiser (no template,
    gallery entry or catalogue file emits `carry`), so F3 does NOT change it.
    Making both work means carrying points at `confirmSeedProposal` time on the
    setup path.
    **AMENDED 2026-08-19, after scouting the code: the premise above is wrong
    in the organiser's favour and wrong in ours.** Two corrections:
    (a) `standings.carry_over` was NEVER deliverable, before F3 or after. No
    picker template, gallery entry, catalogue JSON, `AddStageForm` (which
    hardcodes `timing: "on_complete"` and has no carry control) or seed script
    emits `carry`; the only working path in the repo's history is a hand-built
    API payload inside `custom-points.test.ts`. F3 did not make a working
    feature unreachable — it exposed one that never shipped. The entitlement is
    gated Pro/Pro Plus/Business (`V246:10-12`, `V290:31`) and advertised on the
    PUBLIC pricing page in all four locales (`marketing.json:149`).
    (b) The refine's stated reason is not backed by the code. It claims a
    `setup` stage "seeds placeholders independently of source completion and
    never reads carry" — that describes fixture GENERATION, which happens at
    division setup. Carry would be computed at SEEDING time, and
    `confirmSeedProposal` already runs only after every named source is
    complete, with freshness-verified tables in hand (the same data
    `carryDeltas` needs). It simply never calls it. The incompatibility is
    unwired plumbing, not physics.
    Owner decision APPLIED 2026-08-19: **build it rather than un-sell it.** F3
    corrects the false message only (it is in scope, zero product risk); the
    wiring is scoped as its own session — see the F6 row in the table above.
    Do NOT quietly drop `standings.carry_over` from pricing as the cheap fix:
    selling a feature nobody can reach is the worse of the two states, and the
    engine already does the hard half (`config.carry_deltas → openingDeltas`
    folds regardless of which usecase wrote it, so the engine needs NO change).

13. **`snake` is chosen by the TARGET stage's kind, not the source's**
    (2026-08-18, found by review before it shipped). Design §2.3 says "a
    group-stage source implies `snake`". That rule is wrong and produces a
    materially broken draw. `snakeMerge` reverses alternate wave-major pots, so
    `topNPerGroup n:2` over pools A–D yields seeds `A1,B1,C1,D1,D2,C2,B2,A2`;
    `generateSingleElim` then folds seed *i* against seed *N+1-i*
    (`scheduling/bracket.ts:52-63,156-163`), so round 1 is **A1 v A2, B1 v B2**
    — every group replaying its own final. Plain `rank_order` over the same
    wave-major pots gives `A1 v D2, B1 v C2, C1 v B2, D1 v A2`, which is the
    correct cross-pool draw. `t20-super8.json` uses `snake` legitimately because
    its target is a GROUP stage, where reversal distributes strength across
    pools; a knockout target must not reverse. Rule of record: **snake for a
    group/pool target, rank_order for a bracket target.**
    Corollary caught in the same review: `snakeMerge` reverses a `bestNth` pot's
    array order without moving each descriptor's `position` (its cross-group
    strength rank), so a reversed wildcard pot seeds the weakest wildcard best.
    Never snake a `bestNth`-sourced pot.

14. **Seeding stays PROPOSE-AND-CONFIRM; no auto-confirm** (2026-08-18).
    Flipping to `timing: "setup"` also changes how a downstream stage FILLS,
    which the F3 design never states: `completeStage` (`stages.ts:1920`)
    computes a seed proposal and returns it, while `seedNextStage`'s automatic
    fill runs only on the `on_complete` branch (`:1933`). So every multi-stage
    picker format now needs the organiser to confirm a proposal before real
    names replace the placeholders. Auto-confirming unambiguous proposals was
    considered and **rejected** by the owner: every seeding decision stays
    explicitly the organiser's, and a tie must never resolve without someone
    looking at it.
    Two consequences F3 owes: the `ko_plate` e2e (`e2e/formats.spec.ts:41`)
    must drive propose→confirm rather than expecting `/generate` to seed, and
    the organiser needs a VISIBLE prompt that a proposal is waiting — without
    one, "always confirm" means a published bracket sits full of placeholders
    after the results are already in.

15. **An americano source had TWO readers and they had drifted**
    (2026-08-19, ultrareview finding 11 — the highest-value find of the
    review). An americano stage's `standings_snapshots` fold over the
    EPHEMERAL per-round `pair` entrants it mints per fixture, not the
    division's registered individuals. `tablesForCompletedStage` (the
    `on_complete` path) has known this since L3/#414 and re-ranks from the
    personal-points leaderboard instead. `sourcesToTables` — the
    `timing:"setup"` propose/confirm path F3 itself introduced — went
    straight to `sourceStandingsTables`, so a knockout behind an americano
    was seeded with entrant ids its own roster does not contain. A silent
    wrong draw, reachable from one `timing` value, in the same class as
    ruling 10's `groups_ko` pools-C/D miss. Fixed by extracting
    `americanoPlacementTables` and pointing both readers at it.
    **The pattern, stated once for whoever picks up F5/F6:** every defect
    of consequence found on this branch — rulings 10, 15, and ultrareview
    findings 8, 9 — was one rule with two readers that had drifted, not a
    rule that was wrong. When adding a path, look for the existing reader
    of the same rule before writing a second one.

16. **The churn banner must not fire on a stage nobody has generated yet**
    (2026-08-19, ultrareview finding 6). `getStageRosterDrift` compared the
    active roster against fixture-referenced entrants with no check that the
    stage HAS a board, so a freshly-created stage — the most common state a
    stage is ever in — reported every entrant as "unplaced" and offered a
    rebuild that would have been a no-op regenerate. Drift is defined
    against a board; no board, no drift. `Generate` is the call to action
    there, and the panel already renders it prominently.

17. **The rebuild warns about organiser SETUP; it does not block on it**
    (2026-08-19, ultrareview finding 5; an owner-level product call, made
    here rather than parked). `delete from fixtures` CASCADEs into
    `lineups`, `fixture_officials` and `device_links` — team sheets, referee
    appointments, paired scoring devices — none of which the guard checked.
    Blocking on them was rejected: an organiser who has already appointed
    referees is exactly the one most likely to need a rebuild before match
    day, so refusing would disable the feature when it earns its keep.
    Destroying them silently was equally rejected. The drift payload counts
    all three and the confirm dialog names them before the click. **The
    rule for anything added later: a RESULT belongs in the guard, organiser
    SETUP belongs in the count.**

18. **Four of the thirteen ultrareview findings were rejected**, recorded so
    a later review does not re-raise them as new:
    - *`seeded_map` collision uses `JSON.stringify` equality.* Deliberate and
      documented in place — a same-source duplicate descriptor is refused a
      few lines later by `resolveProgression`'s own entrant dedupe, and only
      `best_nth`'s key is genuinely ambiguous within one source (which it
      still refuses).
    - *Preview sizing derives the qualifier pool from the array-adjacent
      stage, not the stage the source names.* `PreviewStageInput` carries no
      stage id (its three callers pass draft/canned stages), so a
      `{stageId}` source is unresolvable in a preview by construction, and
      "previous" — what every shipped template emits — IS the adjacent one.
    - *`previewSourceShape` duplicates `poolCount()`.* The divergence is the
      point and is documented at both ends: a preview read path must fall
      back to 1 pool on malformed knob data, never 422 a gallery render.
    - *`format-templates.ts:379` hand-writes `timing:"setup"` per template.*
      That file is 317 lines. The underlying concern — three independent
      defaults for one concept — was real for `scripts/seed-demo.ts` and is
      closed by finding 12's fix and its drift gate
      (`scripts/__tests__/seed-demo-templates.test.ts`).

## F4's brief contains one false premise (found 2026-08-18)

The F3–F5 design §7 P5 and its §8 pickup prompt both state that
`ticketRegistrationRows` coalesces fixture participants to `"TBD"` "the same"
as `officialDutyRows`. **It does not.** `exports.ts:659-668` selects
`registrations.display_name` / `ref_code` / name-display flags; it never joins
`fixtures` or `entrants` and has no participant column to label. It is out of
scope for F4 and needs no change.

A **fifth** `?? "TBD"` site the brief does not name does exist —
`auditLedgerDoc` (`exports.ts:763`). Also out of scope, deliberately: an audit
ledger is the forensic record of an already-scored fixture, so both sides are
filled entrants and a placeholder cannot reach it. F4 leaves a comment there
rather than a change, so the next reader does not re-derive it as a gap.

The four sites that ARE real: `exportFixtures` (`:209-210`, SQL literal),
`officialDutyRows` + rota assembly (`:566-585`, `:614`), and `buildMyRotaDoc`
(`:726`, sourced from `me-officiating.ts:80-111`, which must be widened too).

## Where ruling 4's collapse actually lands (swept 2026-08-17)

The two pairs are **cross-vocabulary** — each pair is one member from
`qualification` and one from `seeding`. That is *why* they exist, and why F2's
union is the place they die rather than a separate cleanup.

| Rule | Vocabulary | Type site | Zod site |
|---|---|---|---|
| `topN` | qualification | `packages/engine/src/competition/qualification.ts:25-28` | `apps/web/src/server/api-v1/schemas.ts:492` |
| `rankRange` | seeding | `apps/web/src/server/usecases/stage-seeding.ts:43` | `schemas.ts:549-552` |
| `bestOfRank` | qualification | `qualification.ts:29-39` | `schemas.ts:493-502` |
| `bestNth` | seeding | `stage-seeding.ts:45` | `schemas.ts:554-556` |

Runtime consumers: `qualification.ts:95,109,114,190,274-282`;
`stage-seeding.ts:113` (`case "rankRange"`), `:133` (`case "bestNth"`),
`:299-338` (`resolveQualifiers` cross-group cascade, `bestNthOrder`).

Emitters F2 must migrate because the shape they emit is being deleted:
`components/v2/format-templates.ts:39,72,81,156,198` (all five emit `topN`),
`server/templates/catalog/league-playoff.json:31` (`rankRange`),
`catalog/euro24.json:34` (`bestNth`).

- **No SQL names any of the four.** `grep -ran` over `db/` returns zero hits;
  all four live inside the `stages.qualification` / `stages.seeding` JSON
  columns. Ruling 5's "destructive migration" is a JSON reshape or a drop, not
  a column rename.
- **Ruling 4 is wrong that `topN` and `rankRange` are equals.** `rankRange
  {from,to}` is strictly more expressive; `topN` is its `from:1` case. The
  survivor should be `rankRange` — which means **F2 owns the five
  `format-templates.ts` emitters**, not F3.
- **`bestOfRank` and `bestNth` are not equivalent.** `bestOfRank` carries
  `normaliseUnequalPools`; `bestNth` has the implemented cross-group cascade
  `bestOfRank` lacks. The survivor must absorb **both** — a collapse that keeps
  one name and quietly drops the other's capability is the inert-seam failure
  this repo keeps repeating.
- `stage-seeding.ts:19,29` document `bestNth`'s cascade as a KNOWN GAP. F2
  decides explicitly whether it closes or carries the gap; it must not leave it
  ambiguous.
- Do not confuse seeding's `topNPerGroup` with qualification's `topN` —
  different name, different shape, not part of the collapse.

## Findings that shaped the design — do not re-derive

- **Every multi-stage picker template uses `qualification`; none uses
  `seeding`.** Verified across all 12 (`league_ko`, `groups_ko`,
  `group_stepladder`, `group_playoffs` are the multi-stage ones). So the day-one
  gap is total on the path organisers actually use, not partial.
- **Neither vocabulary is a superset.** Only `seeding` has `snake` /
  `seeded_map` placement and group-count-agnostic take patterns; only
  `qualification` has multi-source `combine` with a per-source `from`.
- **The picker cannot express a correct DRAW, not merely a late one.** `topN`
  flattens qualifiers from several groups into one ranked list, so two teams
  from the same group can meet in the quarter-final. Group separation is exactly
  what `placement: "snake"` / `seeded_map` exist for, and the picker cannot
  reach them. This was not part of the original ask and is the strongest
  argument for F2.
- **FOUR round namers, not three.** The component sweep found three; a fourth
  lives in the engine at `packages/engine/src/exports/build.ts:237-240`
  (count-based, hardcoded English), on the export/poster path. Assume sweeps
  scoped to `apps/web/src/components` are incomplete for anything bracket-shaped.
- **The engine computes each round's role and persistence throws it away.**
  `BracketFixtureGen` carries `bracket: "WB"|"LB"|"GF"`, `isFinal`,
  `thirdPlace`, `conditional` (`scheduling/bracket.ts:17-29`); `bracketToGen`
  (`stages.ts:511-531`) copies none of them. That single omission is why four
  consumers re-derive the role and have drifted.
- **Worst observed instance**: a double elimination of 8 renders **four
  sections titled "Final" and three titled "Semi-finals"**. The wiring beneath
  is correct — the grand final reads winners'-final vs losers'-final — only the
  labels are wrong.
- **A bye renders as `TBD`.** A bye is known at setup and never resolves; the
  label tells organisers to wait for something that is not coming.
- **`League → top 3 → page_playoff` is silently unsupported** ("Preview isn't
  available for this format") because a page playoff is a four-team shape. The
  correct shape for three qualifiers is a **stepladder**, which works today. An
  organiser has no way to discover that.
- **Swiss / americano / mexicano / ladder cannot have day-one fixtures**, ever.
  Not a gap — they pair from live results.
- **Bracket shape derivation already works** and is not in scope to change: 6
  qualifiers produce an 8-slot bracket with byes on the top two seeds, wired
  through to the final, unprompted.
- **`mexicano` maps to engine kind `americano`.** Unresolved: deliberate, or
  drift worth closing in F4.
- **The format picker is hardcoded English — F3 owns closing it.**
  `STAGE_TEMPLATES` (`components/v2/format-templates.ts`) carries `label` and
  `help` as plain string literals, rendered as-is by `division-settings.tsx` and
  `division-builder.tsx`. **All 14 templates** (12 pre-existing + L3's
  `ko_plate` and `qualifying_main`) violate the 4-locale rule. L3 added
  dictionary keys for its two and then **reverted them** on owner ruling
  2026-08-17, because keys nothing reads are the inert-seam pattern and
  `i18n:check` stays green against them (it verifies locale parity, not usage).
  F3 already opens this file, so it wires all 14 through the dictionary in one
  pass, with a reader. **Watch `feedback_ui_text_breaks_e2e`** — e2e specs pin
  the English picker labels.

## F3 Task 2b + Task 3 — findings during implementation (2026-08-18)

- **Ruling 11's `topNPerGroup` switch (Task 2, commit `6351fd2ce`) shipped a
  NEW preview regression**, caught and fixed same-session as Task 2b:
  `qualifierCount` (`stages.ts:809`) sized a later stage from the engine's
  `progressionSize`, which deliberately returns 0 for `topNPerGroup`
  ("group-count-dependent; callers with a real shape use expandTake
  instead" — its own comment). Every `groups_ko`-shaped preview therefore
  fell through the `|| 4` guard to a 4-team bracket regardless of the real
  qualifier count (4 pools x 4/pool previewed 4, not 16) — silent, every
  test green, live on the builder's Format tab before an organiser even
  creates the division. Fixed: `qualifierCount` now expands the take
  against the PREVIOUS array stage's real shape (`previewSourceShape` — no
  DB read; the preview already has the whole stage array) whenever the
  take contains `topNPerGroup`. Every other take kind
  (rankRange/bestNth/picks/roundLosers-only — `league_ko`,
  `group_stepladder`, `group_playoffs`, `ko_plate`, `qualifying_main`) is
  untouched, still `progressionSize` alone — verified unchanged by test.
- **P6 (multi-source `seeded_map` key collision) was real, is now RESOLVED,
  and was never reachable from the picker.** `descriptorKey`
  (`` `${pool}${rank}` ``) does not encode which `sources[]` entry produced
  it; a `seeded_map` entry whose `source` string matched descriptors from
  two different sources used to resolve silently to whichever one a plain
  `Map` construction visited last — the wrong team's placeholder in the
  wrong bracket seat, every test green. `placeDescriptors`
  (`packages/engine/src/competition/progression.ts`) now throws
  `SEEDING_MAP_SOURCE_AMBIGUOUS` (422 — wired in `apps/web/src/server/api-v1/
  http.ts`'s `ENGINE_HTTP` and `lib/scoring-vocab.ts`'s `ENGINE_ERROR_KEY`;
  deliberately NOT added to `lib/seeding-error.ts`'s closed 13-code
  allowlist, per that file's own "no fresh owner ruling" note — an
  organiser sees the raw engine message, same fallback path
  `STAGE_NOT_READY` already uses) instead of silently mis-seating. A key
  shared between sources but never referenced by a `seeded_map` entry is
  not an error — both copies still flow through untouched, same as
  `rank_order`/`snake` always did (plain array ops, never a `descriptorKey`-
  keyed Map). Unreachable today: every writer in this codebase emits a
  single-source progression (`SourcedSlot`'s own doc comment) — multi-source
  is new capability this fix unlocked, not a live organiser-facing defect
  until a multi-source writer ships.
  - `apps/web/src/server/usecases/stages.ts`'s `slotOf`
    (`generateProgressionSetupFixtures`) needed NO code change on
    inspection — it's keyed by the synthetic per-seat id `slot:${i+1}`
    (array position), never by `descriptorKey`, so it was already immune to
    this collision. The task brief named `slotOf` as a fix site; traced and
    verified safe instead of changed, documented in place (`stages.ts`
    comment above the `slotOf` map).
  - One residual noted at the time — SINCE RESOLVED on this same branch
    (F3 round-3 review, Task 2), correcting the stale claim below (found by
    the round-4 review, 2026-08-18): `computeSeedProposal`'s `seedOfKey`
    (`stages.ts`) used to key by bare `descriptorKey` for the ties-display
    lookup, genuinely the same bug class as P6 above. This paragraph
    originally said fixing it would mean widening
    `ProgressionTieFlag.descriptors` past `SlotDescriptor[]` — a bigger
    blast radius than that session's authorized file set, so it was left
    unfixed and documented in place. It WAS widened since, to `SourcedSlot[]`
    (`progression.ts` — carries `sourceIndex`, no parallel shape invented).
    `stages.ts`'s `seedOfKey`/`seedProposalKey` now key ties by
    `sourceIndex` directly — `stages.ts:2452` reads `sourced.sourceIndex`.
    Not a live gap; a future reader should not re-derive this as one.

## Evidence

The 25-format sweep behind these findings was generated by running the real
generator (`previewDivisionFixtures`) over every shipped format — 12 picker
templates, 5 hand-built custom graphs, 8 catalogue templates. F1 Task 5 lands
that sweep as a committed snapshot test so the shapes cannot drift silently
again.
