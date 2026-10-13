# Format matrix W2c — stage-level rules, match overrides and their locks (design)

- **Date:** 2026-10-13 · **Programme:** format × sport matrix, wave W2, sub-wave **W2c** ("stage-level rules with a
  screen, fixture override, O8", ruling 71)
- **Status:** design approved section by section in chat (session f-w2c, 2026-10-12/13). Scope questions Q1–Q11 and
  UI screens S1–S5 were answered by the owner, either relayed verbatim by the coordinator session f-w2b (routing a–f, Q1–Q6)
  or given directly in f-w2c (Q7–Q11, §1 amendment, S1–S5). **Written spec approved by the owner 2026-10-13**
  ("approve the spec, write the plan"); §4.1 amended the same day by the owner (web `lib/match-rules` split per sport;
  rule facts `ruleKeys` move to the engine, web keeps presentation). No product code until the owner approves the plan
  and its execution method.
- **Worktree / branch:** `/Users/ashokhein/github/seazn.club-worktrees/format-matrix-w2c`, `feat/format-matrix-w2c`
  (from `origin/main` `a6cc1f038`). **Rebase after W2b (PR #945) merges**: W2b changes `stage.ts`, award reasons
  (`awardReasonOf`), generic retirement credit (ruling 124), adds a `resolveFixtureCfg` caller
  (`engine-db/awarded-state.ts`) and migration V438.
- **Read with:** `AGENTS.md`, `docs/superpowers/RULES.md`, `docs/superpowers/TEST-STRATEGY.md`,
  `docs/superpowers/specs/2026-09-27-format-matrix-prompts/_RULES.md` and `_INDEX.md` (rulings to 128 live on the W2b
  branch until it merges), the programme design `2026-09-27-format-matrix-design.md`, and the W2a/W2b designs.
- **Code read at:** main `a6cc1f038` (W2b branch `b18b4f0f8` where marked "W2b"). Citations are pins for the plan, not
  promises; the plan re-pins after the rebase. Input ledgers (gitignored):
  `.superpowers/handoff/2026-10-12-w2c/` — `w2c-inventory.md` (28 items), `w2c-digest.md` (verification and routing),
  `w2c-arch.md` (architecture map), `w2c-state.md` (every owner answer, verbatim).

## 1. Why, and what done means

Today only four sports (tennis, badminton, table tennis, volleyball) can set rules per stage
(`lib/match-rules.ts:956` `STAGE_RULES_SPORTS`), and only their match format. Everything else is division-wide:

- **Deciders.** Football extra time and penalties, cricket super over and hockey shoot-out are one switch for the whole
  division, labelled "Knockout fixtures only". Cricket's switch is not actually limited: the engine plays a super over on
  ANY tie when it is on (`cricket.ts:939` reads cfg only; read, not run). Stage decider keys can be set only through the
  create/replace stages API body, where they are typed `z.unknown()` (`api-v1/schemas.ts:1109-1110`, SC-P8).
- **No match-level change.** The only per-match config is the V347 snapshot (`fixtures.config_snapshot`), null until
  the first event and then frozen (`append-event.ts:297`, `:449`). There is nowhere to say "this one match is best of 1".
- **Silent division edits.** The division save (`divisions.ts:899`) has no started check. Editing tie-breaks or points
  mid-group silently re-orders a live table; editing match format silently changes the unstarted half of a running
  group. Stage-level rules already refuse after start (`stage-rules.ts:177-183`, `STAGE_FORMAT_LOCKED`).
- **Stage points have no screen** (ST-G8): `PointsRule` (`competition/points.ts:12-39`) is API/template only. Under
  a stage rule, every award is a forfeit, so a retirement after play pays forfeit points, and `awardScore` is ADDED on
  top of the sport's credited score (W2b `points.ts:57-59`, `:149-154`; Loop R M-1).
- **Knockouts default to no decider.** Football ET/penalties default off (`football.ts:105-111`); hockey has no
  shoot-out outside the FIH preset (`hockey.ts:127-143`). Since W2a (ruling 79) a level knockout result is held
  `needs_decision` and settled, so nothing gets stuck, but every organiser starts from "no decider".
- **Chess knockouts.** Tie-break rungs are a fixed list (`boardgame.ts:191`); Armageddon colours are not recorded
  (`BoardgameTiebreak` = `{rung, winner, score?}`), so BG-KO-2 is a hint, not a rule.
- **Abandons.** One division-wide `abandonPolicy` (`replay | award`, `football.ts:180`, `period/kernel.ts:226`);
  carrom and generic have none. Hockey's FIH "Q4 abandon stands" (H-15) and the opt-in shared points (RB2B-25) have
  no home.

**Owner value:** an organiser can run a group stage and a knockout with different rules in every sport, change one
match before (or, safely, during) play, and is told plainly — before trying — when a rule is locked and why. A live
table is never re-ordered and a played match never re-scored by a settings change.

**Done means:**

1. Every in-scope item (§2.1) is built with its four test types and one mutation pass, or recorded with an owner
   verdict "not built, because…" (§2.2).
2. A fixture override reaches every `resolveFixtureCfg` caller, proved by driving the real producer and consumer
   (§9 P2), compiler-enforced.
3. Screens S1–S5 pass per-screen verdicts at 1280, 768 and 320; the seven-width e2e matrix is green; all new chrome is
   in 4 locales.
4. MD-1: every Survived/NoCoverage mutant in the engine files W2c changes is classified (§10).
5. Every rule row in Appendix A is signed at plan start, enforced, and proved by a test whose title carries its id.

## 2. Scope

### 2.1 In W2c

| # | Item | Source | Owner answer |
|---|---|---|---|
| 1 | Stage-level rules for **every** sport, every rule field, scope-tagged and extensible per sport / stage kind / variant | FX-G23, SC-O8, ruling 12, RB2A-23 | Q5, §1 amendment |
| 2 | Fixture-level match-format override `fixtures.rules_override` through every caller | O4, X3, DES §5 | Q2 |
| 3 | Organiser correction of a **started** (not finalized) match's format, refold-checked and audited | M11, RB2B-3 | Q11 (amends Q2) |
| 4 | Division locks: table points/tie-breaks (O8) and match format, refused by name per started inheriting stage | O8, M11, RB2A-27, RB2B-31 | Q3, Q4 |
| 5 | Stage deciders with a screen; division value is the default for new stages; API validation | SC-X2, SC-P1, RB2B-2, SC-P8 | routing (b), Q7 |
| 6 | Knockout stages created with deciders preselected; all-off allowed with a notice (amends ruling 74's refusal) | RB2B-1, ruling 74 | Q7 |
| 7 | Cricket super over per stage: KO on, league off, league-on = ICC every tie; fix false help copy | SC-C2, RB2A-18, CR-11 | Q8 |
| 8 | Ice hockey KO default 10' OT + GWS; football shoot-out attempts per stage | RB2B-9, RB2B-38 (stage halves) | routing (d) |
| 9 | Carrom `tieBoard` per stage (table stages) | SC-O4, RB2B-23 residual | routing |
| 10 | ST-G8 stage points screen; inexpressible rule refused at screen and API | ST-G8, ruling 83, SC-P10 (refusal only) | Q1 |
| 11 | Under a stage `PointsRule`, only a walkover is a forfeit; `awardScore` replaces the credit | Loop R M-1, RB2B-29 | Q9 |
| 12 | "If a match is abandoned" per stage: replay / result stands / hockey Q4 rule / share points | H-15, RB2B-25 | Q10 |
| 13 | Chess: per-stage tie-break rung list; Armageddon colours recorded, BG-KO-2 enforced | rulings 73, 82 | Q6 |
| 14 | Chess over-the-board clock per stage (not per match) | B-15 | routing (c), Q5 |
| 15 | Public stage format label shows stage rules and deciders | `stage-format-lines.ts:46` | f-w2b, Q2 |

### 2.2 Out, each with its owner

| Item | Owner | Ruling |
|---|---|---|
| ST-G10 per-stage tie-break cascade + `validateCascade` | W2d | routing (a) |
| Per-sport point systems: chess 1/½/0 or 3/1/0, cricket tie/NR, ice hockey OT/SO, hockey SO 2/1, volleyball `"*"` (SC-S9), football presets (RB2B-4), widening `PointsRule` (SC-P10) | W2d | routing (b), Q1 |
| Continuous sudden-death OT mode (SC-P3); removing dead `shootout.suddenDeath` | W2e | routing (d) |
| RB2A-17 stage default for a KO tie/no-result | **Not built** — "settle covers it, no setting" | routing (e) |
| Chess games per match | ruling-119 playoff-series wave — **owner re-route from W2c (ruling 73)** | Q6 |
| Per-fixture/per-round online chess time control | chess in-page programme | ruling 119 |
| Per-event default time control, zero-point byes, playoff sequences | ruling-119 wave | 118, 119 |
| Bulk "apply to all unstarted matches in this stage" | **competition-desk programme, owner-planned** (run-sheet control reusing `writeFixtureRulesOverride` unchanged). Running late is the commonest reason for the division edit Q4 refuses, so this is the likely first follow-up. | Q4 + "also C in future", "Competition-desk, ok" |
| Core scoring-rules backfill | its own wave | 121 |
| "Replay from 0-0" reset for an abandoned match (W2B:88) | unowned — gap recorded for `_INDEX` (ruling 42) | — |

## 3. Rulings this spec implements

- **71** W2c = stage-level rules with a screen, fixture override, O8.
- **12** stage-level for every setting; fixture-level is match format only; never per-fixture table points or
  tie-breaks.
- **73** (residual) rung configuration → W2c; games per match **re-routed to the 119 wave** (owner, Q6).
- **74** amended by the owner (Q7): no creation refusal; deciders preselected, all-off allowed with a notice.
- **79** a level bracket result is held `needs_decision` (W2c relies on it; does not change it).
- **82** Armageddon colours → W2c.
- **83** ST-G8 + stage settings → W2c.
- **117** a level abandon under award in a no-draw cfg is no result (H-15 Q4 case).
- **118 / 119 / 121** exclusions (§2.2).
- **124** retirement/DQ keeps the real score only if worse for the offender (the score half; W2c's Q9 is the points half).
- **MD-1 (f)** "B": `competition/stage.ts` and `progression.ts` follow the wave that edits them (§10).
- Owner answers Q1–Q11, S1–S5 and the §1 amendment are recorded verbatim in `w2c-state.md` and folded into `_INDEX`
  as new rulings at the W2c fold (numbers assigned then).

## 4. Architecture

### 4.1 One declaration decides who can set what (owner amendments to §1, 2026-10-13)

**Rule facts live in the engine; presentation lives in web** (owner "approve", asked in view of the planned engine →
own-repo split after W2). Who may set a key, and where it applies, is a game rule (ruling 12), so it must travel with
the engine; labels and controls stay with the screens.

- **Engine — each sport module declares `ruleKeys`** beside `variants` (`sport/module.ts:753`) and `stageDefaults`:
  `ruleKeys: Readonly<Record<CfgKey, { scope: "match" | "stage" | "points"; appliesTo?: { stageKinds?: StageKind[];
  variants?: string[] } }>>`. `scope` = Q5's groups 1, 2, 3; `appliesTo` = which stage kinds ("format") and which
  engine variants (`t20`, `fih-shootout`, `blitz`…) the key applies to. Shared kernels declare their keys once and the
  sport module re-exports or narrows them. Engine helpers derive, never hand-list:
  `stageKeysFor(module, kind, variant)` and `fixtureKeysFor(module, kind, variant)` (`fixtureKeys ⊂ stageKeys`).
- **Web — `apps/web/src/lib/match-rules/<sport>.ts`, one file per sport** (owner "Ok": the 1,062-line
  `lib/match-rules.ts` is split per sport as a pure move first, with an `index.ts` registry keeping today's public API),
  holds presentation only: label, control, options, `build()`, and the **engine key it edits**. No scope or
  applicability is declared in web.
- **One source both sides:** the server allowlists (`stage-rules.ts:196` `configKeysFor`, the fixture override
  writer), the stage form, the match override and the public label all read the engine's `ruleKeys` through the
  derived helpers. `STAGE_RULES_SPORTS` is deleted.
- **Two contract tests, one per side of the future split.** Engine (moves with the engine): every key in a module's
  cfg schema that is settable has a `ruleKeys` entry; `stageDefaults` and every variant parse the schema; the sweep
  covers every stage kind × variant and reports its count (0 = fail). Web (stays): per sport,
  `lib/match-rules/__tests__/<sport>.contract.test.ts` via a shared `runContract(sport)` — every web field names an
  engine key, every settable engine key has a web field, and every field's `build()` output parses the engine schema;
  `vitest related` then runs only the edited sport's tests.
- **No engine restructure in W2c.** `packages/engine/src/sports` is already one folder per sport with shared kernels
  on purpose; `ruleKeys` and `stageDefaults` go inside the existing module files. Splitting large files by concern
  belongs to the engine-split programme.
- After the split, a new rule field = engine release (the rule) + web bump (the label); the web contract test catches
  a mismatch at the bump. A label/control-only change stays web-only.

Adding a rule = one engine `ruleKeys` entry + one web field; adding a sport = one module declaration + one web file.
New stage-only keys: `tiebreakRungs` (chess), `abandon` (Q10), plus the existing decider keys.

Q5 classification (pinned against each engine schema in the plan; any key that moves is flagged to the owner):

- **match (stage and match):** `bestOf, setTo, finalSetTo, finalSet, setType, gameTo, cap, winBy, tiebreakWinBy,
  noAd, halfMinutes, quarterMinutes, periodMinutes, overtimeMinutes, shootoutAttempts, overs, maxOversPerBowler,
  maxBoards`, and `extraTime` — per match only **off or shorter** (RB2B-3).
- **stage only:** `allowDraws, shootout, superOver, overtime, dls, tieBoard, variant, resultMode, teamSize,
  playersPerSide, maxSubs, subWindows, sinBinMinutes, overtimeSkaters, queenFollowsBoard, queenCapAt, queenPoints,
  clockBaseMinutes, clockIncrementSeconds, clockDelaySeconds, tiebreakRungs, abandon`.
- **points (ST-G8 screen, not the rules picker):** `shootoutWin, shootoutLoss`.

Field labels stay canonical English (design 2026-09-17, `components/v2/match-rules.tsx:10`); all chrome localizes.

### 4.2 Defaults are layered, one source per layer

`engine cfg default → variant preset → stageDefaults(kind, variant) → stage stored rules → fixture rules_override`.

`stageDefaults` is a new optional `SportModule` hook beside `bracketDeciders` (`sport/module.ts:834`). It supplies the
knockout preselection (Q7/Q8): football ET 2×15 + penalties; hockey shoot-out (5); ice hockey 10' OT + GWS (RB2B-9);
cricket super over on. **Defaults are written into `stages.config.rules` when the stage is created**, not inferred at
resolve time — what the form shows is what is stored, and turning a default off is a visible, stored change. Division
values remain the default for any key a stage does not set (SC-X2).

### 4.3 Storage

- `stages.config.rules` — every stage-scoped key (existing jsonb fragment; `V210__stages.sql:8`).
- `stages.config.points` — the stage `PointsRule` (existing; read LIVE at `competition.ts:315`, safe only because
  `FORMAT_LOCKED` `stages.ts:518` holds — W2c does not loosen it).
- `fixtures.rules_override jsonb null` — **new**, match-scoped keys only. Migration number above W2b's V438
  (re-checked against main at plan time).

### 4.4 Resolution — `resolveFixtureCfg`

Signature changes to take the fixture row (`{config_snapshot, rules_override}`) instead of a bare snapshot
(`fixture-cfg.ts:71`), so **the compiler forces every caller** to pass the override. Today: 11 call sites in 9 files on
main; W2b adds `engine-db/awarded-state.ts`. The spec names no count: every caller, compiler-enforced.

Order: `snapshot ?? (division ⊕ stage.rules ⊕ bracketDeciders(kind) ⊕ rules_override)`. At the first event the
result is frozen into `config_snapshot` exactly as today. `lockedStageIdsAmong` (`stage-rules.ts:43`) is unchanged —
an override does not start a stage.

The public stage label (`public-site/stage-format-lines.ts:46`) switches to the same stage resolution (it reads only
`stages.config->'rules'` today, `data.ts:946`, and ignores deciders); per-fixture labels already use the resolver
(`match-centre-load.ts:472`).

### 4.5 Write paths and the one lock check

1. **Stage rules save** — `putStageRules` (`stage-rules.ts:118`), extended to every sport and to points.
2. **`writeFixtureRulesOverride(fixtureIds[], fragment, actor)`** — the ONE validated writer: per-sport allowlist,
   engine-schema validation, all-or-nothing in one transaction, audited. Unstarted fixture → write. Started and not
   finalized/cancelled (Q11) → refold the recorded events under the corrected cfg; if the fold refuses or ends in a
   state the recorded play contradicts, refuse `FORMAT_DOES_NOT_FIT_PLAY` with the engine's reason; else write and
   re-freeze the snapshot. Finalized/cancelled → `FIXTURE_FORMAT_LOCKED`. The future bulk action calls it unchanged.
3. **Division save** — refuses, by name, table points/tie-breaks (Q3) and match-format fields (Q4) while any stage
   inheriting them has started; other fields still save and the response lists what was refused.

All three read "started" from one predicate (`lockedStageIdsAmong` for stages; `hasFrozenCfg`,
`fixture-cfg.ts:100`, for a fixture). The staff hatch `resnapshotFixtureConfig` (`admin-fixture-config.ts:155`) stays
for finalized matches after a reopen, and is a `resolveFixtureCfg` caller, so it re-freezes WITH the override.

## 5. Components

### 5.1 Engine (`packages/engine/src/`)

- `sport/module.ts` — `ruleKeys` declaration (§4.1) and optional `stageDefaults(kind, variant): Partial<Cfg>`;
  `stageKeysFor` / `fixtureKeysFor` helpers exported from the engine's public API (web imports them).
- Sport modules — `stageDefaults` for football, hockey, ice hockey, cricket; abandon options (Q10): extend
  `abandonPolicy` in football and the period kernel; add an abandon setting to carrom and generic ("share the points",
  opt-in); hockey "result stands from Q4, else replay", preset in `fih-shootout`, level Q4 in a no-draw cfg → no result
  (117). Shoot-out `attempts` per stage (football; period kernel already has `attempts`).
- `sports/boardgame/boardgame.ts` — `tiebreakRungs` cfg (ordered subset of `TIEBREAK_RUNGS`, stage-scoped);
  `BoardgameTiebreak` gains Armageddon `black: EntrantId` and `result: "white" | "black" | "draw"`; the engine derives
  the advancer (draw → Black, BG-KO-2) and refuses an Armageddon without `black` (`TIEBREAK_COLOUR_REQUIRED`). Colour
  lives in its OWN fold field — **never `colorOfHome`** (chess in-page `guard.ts:425` reads it after the draw).
  `awaitingDecider` is true while any rung in the stage's list is owed; an empty list → false, and the level bracket
  result falls to the ruling-79 hold.
- `competition/points.ts` — `isForfeit` = walkover reason only (on W2b's `awardReasonOf`); `awardScore` replaces the
  credited score; `pointsRuleExpressible(rule, divisionCfg, sport)` for the Q1 refusal.

### 5.2 Server (`apps/web/src/server/`)

- `engine-db/fixture-cfg.ts` — new signature and order (§4.4); every caller updated.
- `usecases/stage-rules.ts` — every sport; allowlist from §4.1; points; same lock.
- `usecases/fixture-rules.ts` (new) — `writeFixtureRulesOverride` + refold check + audit.
- `usecases/divisions.ts` — Q3/Q4 refusals; partial save reports refused fields.
- `usecases/stages.ts` — stage creation writes `stageDefaults`; `replaceStages` carry keeps the new keys.
- `api-v1/schemas.ts` — decider keys validated (SC-P8); `PUT /stages/{id}/rules` covers every sport;
  `PUT /fixtures/{id}/rules` (new); error codes in OpenAPI (CI drift check).
- `public-site/stage-format-lines.ts`, `describe-rules.ts` — stage resolution, all sports, deciders.
- `db/migration/deltas/V4xx__fixture_rules_override.sql` (number above V438).

### 5.3 UI (`apps/web/src/components/`) — owner-chosen layouts

- **S1 stage rules (A):** the stage card's Format row (`stages-panel.tsx` `StageFormatRow`, `:2130`) for every sport.
  Summary line (chip-style); "Edit rules" expands in place into sections Match format · Deciders · If abandoned ·
  Points; each field labelled *Division* or *This stage* (knockout defaults say so); "Use division rules" resets. One
  DOM; sections stack below `md`.
- **S2 match rules (A):** a "Match rules" block on the fixture console (`fixture-console.tsx`): summary + "Changed for
  this match" tag; match-scoped fields only, labelled *Stage* or *This match*; "Use stage rules". On a live/held match
  the action reads **Correct format** with a one-line warning (Q11). The division fixtures list shows a "Format
  changed" tag.
- **S3 stage points (A):** inside S1's Points section, table stages only: live preview line; "A win earns [ ] · a draw
  [ ] · a loss [ ]"; Walkover (nothing played) sentence with optional score; a note that retirement, DQ or withdrawal
  after play earns normal points; bonus rows ("Losing by [7] or fewer: +[1]") filtered to the sport's metrics. Phone
  folds walkover and bonuses under "More". An inexpressible division rule shows the refusal card and the stage keeps
  the division's points.
- **S4 locks (A):** say it before they try — locked sections render read-only with one 🔒 line naming the started
  stage and what to do instead (link to the fixtures); the server refusal is the backstop with the same words. Same
  pattern on a started stage (S1) and a finalized match (S2).
- **S5 Armageddon (A):** the boardgame tie-break sheet (`scorepad/v3/skins/boardgame.tsx:550`): rung step offers the
  stage's `tiebreakRungs` in order; for Armageddon: "Who had Black?" → "Result?" (White won / Black won / Drawn) →
  confirm line "Advances: X — Black, Armageddon drawn". Rapid/blitz unchanged.
- Every UI task invokes `frontend-design`; verdicts at 1280/768/320 per screen.

## 6. The rules reference

Rule rows to sign at plan start are in Appendix A. Each is enforced in the engine or the one server writer, never in
UI alone.

## 7. Error handling

One code, one wording, screen and API, all 4 locales.

| Code | When | Organiser message |
|---|---|---|
| `STAGE_FORMAT_LOCKED` (exists) | stage rules edit after the stage started | "{stage} has started — its rules are locked." |
| `DIVISION_TABLE_RULES_LOCKED` (Q3) | division points/tie-breaks, inheriting stage started | "{stage} has started — table rules are locked." |
| `DIVISION_FORMAT_LOCKED` (Q4) | division match format, inheriting stage started | "{stage} has started; its match format is locked. Change individual unstarted matches instead." |
| `FIXTURE_FORMAT_LOCKED` | override on a finalized/cancelled match | "This match is finished — its format is locked." |
| `FORMAT_DOES_NOT_FIT_PLAY` (Q11) | correction the recorded play contradicts | engine reason, e.g. "2 sets already played" |
| `RULE_NOT_SETTABLE` | key outside the sport/kind/variant allowlist at that level | names the field and where it can be set |
| `POINTS_RULE_INEXPRESSIBLE` (Q1) | stage points would drop OT/SO points | "These points can't be set per stage yet…" + reason |
| `TIEBREAK_COLOUR_REQUIRED` | Armageddon without `black` | "Record who had Black." |
| `CONFIG_INVALID` (exists) | engine schema refusal | schema reason |

The division partial save never drops a field silently: refused fields are listed by name. The override writer is
all-or-nothing and names the fixture that blocked it.

## 8. Proof of the seams (class 1)

- The override is folded through every caller from a real `writeFixtureRulesOverride` write — not a fixture row.
- Stage creation's `stageDefaults` output is read back through `resolveFixtureCfg` and folded by the real engine.
- The Armageddon pad's emitted event is folded by the real boardgame module; the advancer is read from the fold.
- The S3 preview line is produced by the same function as the public format label.

## 9. Testing and gates

Four test types and one mutation pass per task; scoped runs only (never the full gate/suite, locally, by anyone);
expected values from rulebook rows or engine declarations; anti-vacuity counts.

- **P1 extension contract sweeps (two, §4.1):** engine — every sport × stage kind × variant: every settable cfg key has
  a `ruleKeys` scope, match ⊂ stage, `stageDefaults` and variants parse; web — per sport, every field names an engine
  key, every settable engine key has a field, `build()` output parses. Each reports its count; 0 = fail.
- **P2 every caller:** one overridden fixture through every `resolveFixtureCfg` caller; the caller count is compared to
  a `grep -a` of the tree, so a new caller fails the test until covered.
- **P3 order differential:** division, stage, bracket decider and override each give a different value.
- **P4 lock sequences:** before start / first event / second edit / after a void / another sport — for stage, division
  table rules, division format and match override, each with its positive pair.
- **P5 correction (Q11):** per-sport fits / does-not-fit table; audit row.
- **P6 points (Q9):** walkover vs retired/DQ/withdrew, `awardScore` replacing; inexpressible refusal; after W2b rebase.
- **P7 KO defaults (Q7/Q8):** create writes deciders; all-off → level result → `needs_decision` → settle.
- **P8 Armageddon:** colour + result → advancer; draw → Black; missing colour refused; empty rung list → hold. Cross-
  programme e2e (after `feat/chess-lichess-external-play` merges): online drawn KO game, empty rungs →
  `needs_decision` → settle → bridge closes.
- **P9 abandon:** every option per sport; hockey Q4 level → no result (117).
- **UI:** an e2e spec per screen, whole spec files (no `-g`), seven width projects; axe; per-screen verdicts.

## 10. MD-1 mutation ownership

Owner answer (f) "B": a file goes to the wave that edits it. W2c classifies survivors in every engine file its plan
edits — expected: `competition/points.ts` (Q9 moves it from W2d to W2c), `sports/boardgame/boardgame.ts`,
`sports/period/kernel.ts`, football, carrom, generic, cricket, `sport/module.ts`. `competition/stage.ts` and
`progression.ts` are classified by W2c **only if the plan's file list edits them**; otherwise they go to the mutation
session's no-wave list. Decided from the plan's file list.

## 11. Delivery

Spec → plan (owner approves plan and execution method) → build on `feat/format-matrix-w2c` after rebasing onto main
with W2b merged → reviewer pass per task → PR. Smoke is PR-only; e2e runs on push to main or `workflow_dispatch`
with `pr` — dispatch it before merge.

## 12. Risks

- **Resolver signature churn** across every caller — mechanical, compiler-checked; P2 guards behaviour.
- **Refold under a corrected cfg (Q11)** may surface engine states no test reached; P5 enumerates per sport.
- **Base moves twice** (W2b, then chess in-page); points.ts work waits for W2b's `awardReasonOf`.
- **Long forms** (cricket ~10 fields) — sections show only declared fields; phone folds.

## 13. Coordination

- **f-w2b / W2b (PR #945):** rebase after merge; migration above V438; `awarded-state.ts` caller; ruling 124 credit.
- **Chess in-page (`feat/chess-lichess-external-play`):** colour field and `awaitingDecider` contract (§5.1); their
  writer goes through `scoreEvent → appendEvent` (`result.ts:504`, `scoring.ts:191`), so the hold fires.
- **W2d:** inherits ST-G10, per-sport point systems, widening `PointsRule` (lifts `POINTS_RULE_INEXPRESSIBLE`), and may
  relax Q3's lock into per-stage pinning.
- **Competition desk:** bulk override action over `writeFixtureRulesOverride`.

## 14. False premises and corrections found (for `_INDEX` at fold)

1. "11 production caller files" for `resolveFixtureCfg`: 9 files / 11 sites on main; 10 / 12 after W2b.
   `overlay/recent.ts` is a comment only. The design's "~11 callers" omits `admin-fixture-config.ts`.
2. RB2B-1's harm (an unfinishable level KO result) was closed by W2a ruling 79; LEDGER cite is :169, not §150.
3. M11: stage-level rules already lock after start; only division edits were silent.
4. ST-G10 "→ W5" is stale; the design lists it under W2.
5. Cricket "Super over on a tie — Knockout fixtures only." is false: the engine plays it on any tie (code read).
6. The staff resnapshot hatch would be useless under W2c's locks (it re-freezes from locked live config) — resolved by
   Q11.

## Appendix A — Rule rows to sign at plan start

Proposed ids; wording finalised with the owner at plan start (ruling 71).

- `cross-sport.md` — **X-SR-1** a stage may set any stage- or match-scoped key its sport declares for its kind and
  variant. **X-SR-2** a match may override only match-scoped keys; extra time only off or shorter. **X-SR-3** a stage's
  rules lock when its first fixture starts. **X-SR-4** division table rules and match format lock per started
  inheriting stage. **X-SR-5** a started, unfinished match's format may be corrected only if the recorded play fits it.
  **X-SR-6** a new knockout stage presets its sport's deciders; with none, level results wait for settle.
  **X-PT-1** under a stage points rule only a walkover is a forfeit; its awarded score replaces the credit.
- `boardgame.md` — **BG-KO-3** a stage chooses its tie-break rungs and their order. **BG-KO-2** (now enforced) a drawn
  Armageddon is won by the recorded Black.
- `cricket.md` — **CR-SO-1** super over per stage; KO preset on, league off; on in a league plays on every tie.
- `hockey.md` — **HK-AB-2** (FIH stages) abandon in Q4 → result stands, earlier → replay; level Q4 in a no-draw cfg →
  no result (117).
- `carrom.md`, `generic.md` — **CM-AB-1 / GN-AB-1** opt-in shared points on an abandon; default replay.
- `icehockey.md` — **IH-KO-1** KO stages preset 10' OT + GWS.
- `football.md` — **FB-SO-1** shoot-out attempts per stage (5; youth 3).
