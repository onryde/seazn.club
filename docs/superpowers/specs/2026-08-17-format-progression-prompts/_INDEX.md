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
| F3 | **prompt ready** — `../2026-08-18-format-progression-f3-f5-design.md` §8 | F2 **merged** ✅ | design written 2026-08-18 against the shipped shape. Paste §8's F3 block as a whole prompt |
| F4 | **IN FLIGHT** — plan `../../plans/2026-08-18-f4-handout-surfaces.md`, branch `feat/f4-day-one-handout-surfaces`, worktree `.claude/worktrees/f4-handout`, DB label `f4` | — | premise RETIRED (no sport/format-kind gap in either direction; its mexicano comment folds into F3). Slot **repurposed** to the export + calendar day-one leaks (§7 P5, P2). Does NOT wait for F3 — three catalogue templates already emit `timing: "setup"`. Owner CONFIRMED the repurpose 2026-08-18 |
| F5 | **prompt ready** — same doc §8 | all | scope fixed by the §5 table |

**Why F3–F5 are not written.** They consume F2's field shape, and this repo has
a repeated failure where a session authored against a design meets an
implementation that landed differently — the scoringpad index is full of
"the prompt's central premise was false" entries. F3 gets written after F2
**merges**, against real code.

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

## Evidence

The 25-format sweep behind these findings was generated by running the real
generator (`previewDivisionFixtures`) over every shipped format — 12 picker
templates, 5 hand-built custom graphs, 8 catalogue templates. F1 Task 5 lands
that sweep as a committed snapshot test so the shapes cannot drift silently
again.
