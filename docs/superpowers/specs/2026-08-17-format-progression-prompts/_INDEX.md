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

| Session | Prompt file | Depends on | Status |
|---|---|---|---|
| F1 | `F1-bracket-round-role.md` | — | TODO — plan written: `../../plans/2026-08-17-f1-bracket-round-role.md`. **Waits for L3/#414 to merge** (shared `stages.ts`) |
| F2 | `F2-unified-progression-field.md` | — | TODO — unblocked 2026-08-17 by the greenfield ruling |
| F3 | *(not written)* | F2 **merged** | authored against the shipped shape, not the designed one |
| F4 | *(not written)* | F3 | same |
| F5 | *(not written)* | all | written once the earlier sessions' deferred test debt is known |

**Why F3–F5 are not written.** They consume F2's field shape, and this repo has
a repeated failure where a session authored against a design meets an
implementation that landed differently — the scoringpad index is full of
"the prompt's central premise was false" entries. F3 gets written after F2
**merges**, against real code.

## Owner rulings (2026-08-17)

1. **Universal day-one fixtures**: any format, including customised stage
   graphs, shows every fixture — final included — at setup.
2. **Unify onto one progression field** (owner chose this over the cheaper
   per-template fix), building the union of both vocabularies' expressiveness.
3. **L3/#414 finishes on `qualification`** rather than stopping mid-flight; F2
   migrates its `RoundLosers` union member along with everything else.
4. **Greenfield — there is no production data** (2026-08-17). F2 drops
   `stages.qualification` and `stages.seeding` outright: no backfill, no
   dual-read, no compat shims, no flags; constraints strict from day one. The
   migration is destructive and its correctness rests entirely on that premise,
   so **F2 verifies zero rows against the target database and stops if it finds
   any** — this ruling is dated and will outlive its accuracy. Consequence: F2
   does not need to split, so five sessions stands.

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
