# Format × Sport Matrix — W2c (stage-level rules, match overrides and their locks) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

> **Sequencing.** W2b (PR #945) is not merged.
> - **Before the rebase:** Tasks 1 and 2 build NOW on `feat/format-matrix-w2c`. Their files are disjoint from W2b's diff (checked file by file in **Loops and lanes**).
> - **Task 3 is the rebase** onto main with W2b merged. Everything after it waits for it.
> - **BLOCKED until rebase on W2b merge**, because they build on W2b code:
>   - Task 3 itself.
>   - Task 9: the stage-points forfeit reads W2b's `playRecorded` and changes W2b's `applyPointsRule` callers and `qualification-view.ts`.
>   - Task 10: it changes the `engine-db/awarded-state.ts` caller (re-read after the merge) and takes a migration number above V438 (re-checked on main at the rebase).
> - **The other post-rebase tasks** are not blocked by W2b *code*, but they edit files W2b also edits: every sport module, `sport/module.ts`, `stages.ts`, `fixture-console.tsx`, the dictionaries, `mobile.spec.ts`, `smoke.ts`. Building them before the rebase would only manufacture merge conflicts.

**Goal:** An organiser can give every stage of every sport its own rules (match format, deciders, abandon handling, chess tie-break rungs, table points). They can change one match's format before it starts, or correct it safely while live. They are told by name, before trying, when a rule is locked. No settings change ever re-orders a live table or re-scores a played match.

**Architecture:**
- **Rule facts live in the engine; presentation lives in web** (spec §4.1 as amended 2026-10-13, `f1a3da356`).
  - Each sport module declares `ruleKeys` (who may set a key, and for which stage kinds and variants) beside `variants`. It also declares `stageDefaults`.
  - The engine derives `stageKeysFor` / `fixtureKeysFor` / `pointsKeysFor` and checks a match override (`checkFixtureOverride`).
  - Web keeps one presentation file per sport under `apps/web/src/lib/match-rules/`: label, control, options, `build()`, and the engine key each field edits.
  - The server allowlists, the stage form, the match form and the public label all derive from the engine's declaration.
- **Defaults are layered, one source per layer:**
  1. the engine cfg default;
  2. the variant preset (already in `divisions.config`, written by `sync-sports`);
  3. `stageDefaults(kind, variant)`, written into `stages.config.rules` when the stage is created;
  4. the stage's stored rules;
  5. `fixtures.rules_override` (match-scoped keys only).
- **One resolver, compiler-enforced.** `resolveFixtureCfg` takes the fixture row (`{config_snapshot, rules_override}`, both required keys), so every caller must select the override. The order is `snapshot ?? (division ⊕ stage.rules ⊕ bracketDeciders(kind) ⊕ rules_override)`, frozen at the first event as today.
- **Three write paths, one "started" predicate:**
  - `putStageRules` (every sport, plus stage points);
  - the new `writeFixtureRulesOverride(fixtureIds[], fragment)`: unstarted → write; live or held → refold check, then re-freeze; finalized or cancelled → refused. A correction (or a staff re-freeze) increments the new `fixtures.rules_version int not null default 0`. The scoring pads send the version they loaded with each tap; a stale one is refused `FIXTURE_RULES_CHANGED` before anything is written, and the pad reloads its rules and says so. The server checks the version ONLY when the sender includes it, so settle, forfeit, finalize, withdrawal and import are never blocked (spec §4.5 item 2 at `1b757c6cb`, owner P-1 "A");
  - the division save, which refuses by name what a started inheriting stage depends on.
- **Engine behaviour:**
  - knockout presets: football ET plus pens with per-stage attempts, hockey shoot-out, ice hockey 10' OT plus GWS, cricket super over;
  - abandon options (Q10);
  - chess tie-break rungs and Armageddon colours (BG-KO-2 enforced);
  - the stage-points walkover split (Q9).
- **UI (owner-chosen option A for S1–S5):**
  - stage rules on the stage card, with stage points inside it;
  - a "Match rules" block on the fixture console;
  - lock lines said before the organiser tries;
  - the Armageddon sheet on the chess pad.

**Tech Stack:**
- TypeScript 7 (`typescript-native`), Node 26 `--experimental-strip-types` (no enums, namespaces or parameter properties; `.ts` import suffixes under `packages/` and `scripts/`).
- zod 4; vitest 4 (`vitest related`); fast-check.
- Next.js: read `node_modules/next/dist/docs/` before touching a page (AGENTS.md). Playwright; `@axe-core/playwright`.
- Postgres deltas under `db/migration/deltas/`; pnpm.
- Stryker (`packages/engine/stryker.groups.mjs`), the W2a hand-mutant runner `scripts/mutate.ts`, changed-lines Stryker `packages/engine/scripts/stryker-changed.mjs`.

**Spec:** `docs/superpowers/specs/2026-10-13-format-matrix-w2c-design.md`. The owner approved it 2026-10-13 and amended it twice the same day:
- `f1a3da356`: rule facts move to the engine, and web is split per sport (§4.1, §5.1, §9 P1).
- `8a0c4bd52`: open pads follow a correction (§2.1 #3, §4.5, §7, §9 P5), plus the **no live users** greenfield stance (§11). The owner's verbatim answers are in the gitignored `/Users/ashokhein/github/seazn.club/.superpowers/handoff/2026-10-12-w2c/w2c-state.md`.
- `1b757c6cb`: the owner's answers P-1..P-4 to the plan review (§1 division edits, §2.1 #11, §4.5 item 2, §5.2 migration, Appendix X-PT-1). This plan revision applies them and the review `/Users/ashokhein/github/seazn.club/.superpowers/handoff/2026-10-12-w2c/w2c-plan-review.md` (C1-C2, I1-I13, M1-M12). Each fix is cited by its review id where it lands.
- Rules: `docs/superpowers/specs/2026-09-27-format-matrix-prompts/_RULES.md` R1–R29.
- House rules: `AGENTS.md` (classes 1–23, the phone composition), `docs/superpowers/RULES.md` (four test types, never a full local suite, 1280/768/320 verdicts, both owner checklists), `docs/superpowers/TEST-STRATEGY.md` (rules 1–10, the reviewer's four questions).
- Style: `docs/superpowers/plans/2026-10-08-format-matrix-w2a.md`, and the W2b plan on `feat/format-matrix-w2b` (`docs/superpowers/plans/2026-10-09-format-matrix-w2b.md`).

Where the spec and the tree disagree, the tree wins, and the disagreement is a numbered entry in **Plan findings** at the end. Findings that need an owner decision are listed under **Owner answers and open questions**; a task that depends on an OPEN question does not start until the owner answers.

---

## Owner answers and open questions

The owner answered the plan review's questions on 2026-10-13, in chat to the orchestrator (P-1..P-4, then P-5 on the re-review). The answers below are the OWNER'S, recorded verbatim in substance (class 17: they are not the planner's recommendations relabelled). Spec commit `1b757c6cb` carries them. OQ-1..OQ-4 are closed.

- **P-1 "A" — the rules version (replaces the first D14 mechanism; fixes review C1 and C2).**
  - New column `fixtures.rules_version int not null default 0`, in the same migration as `rules_override` (Task 10).
  - It is incremented ONLY by a Q11 correction (Task 14) or a staff re-freeze (`resnapshotFixtureConfig`, Task 14's extracted `refreezeFixture`).
  - The server checks it ONLY WHEN THE SENDER INCLUDES IT. The scoring pads always send it: the console pad via `transport.ts:355`, the remote pad via `device-score-pad.tsx:318`, and any other scoring-tap sender. A stale one → `409 FIXTURE_RULES_CHANGED` before any write; the pad reloads and shows the banner.
  - Console settle/forfeit/finalize (`fixture-console.tsx:634`), `americano-panel.tsx:154`/`:160`, and the server writers (`withdrawal.ts`, `scoring.ts:873` `finalizeFixture`, `event-import.ts:354`) do not send it and are never blocked.
  - A source-scan test enumerates EVERY `/api/v1/fixtures/${…}/events` POST site, classifies each as scoring-pad (must send) or not, and fails on an unclassified new site.
  - DB tests: withdrawal, finalize, settle and import after a correction all succeed. The second-device case: version 0 with no correction is accepted. (Import after a correction cannot occur, because `importEvents` refuses a started fixture (`event-import.ts:223`); finding 38.)
- **P-2 "A" — division locks (was OQ-1).** Implement Q3/Q4 as ruled.
  - The `patchDivision` config lock (`divisions.ts:820-856`) LOOSENS to per started inheriting stage, named `DIVISION_FORMAT_LOCKED` / `DIVISION_TABLE_RULES_LOCKED`.
  - The `tiebreakers` column GAINS the Q3 lock. `replaceStages`' `FORMAT_LOCKED` is untouched.
  - Includes review I1 (re-parse after restore; a refused variant drops its preset keys) and I2 (the `smoke.ts:8378-8385` and `division-settings.test.ts:726-738` pins; the smoke edit goes in a loop that owns `smoke.ts`, i.e. after the rebase — Task 10's lane F).
- **P-3 "A" — stage-points forfeits (was OQ-2, reworded per review I7).**
  - A forfeit under a stage `PointsRule` = an award with NOTHING PLAYED, whatever the reason (walkover, or withdrew/DQ before play).
  - It is decided from `score_events` with the engine's existing "was anything played" predicate — `playRecorded(ledger, module)` in `packages/engine/src/core/events.ts` on W2b (rulings 112–115, 118, 120). One authority; no second predicate.
  - The caller passes a `played` flag into `applyPointsRule` (signature change). Every caller is fixed: W2b's `engine-db/competition.ts:395` and the bye path `:115`, plus `packages/engine/src/testkit/scenarios.ts:377` and `tools/bench/lib/validate-pack.ts` (finding 33).
  - After play → normal points (Q9). A bye keeps today's points for the advancer but NEVER gets `awardScore`. `awardScore` REPLACES the credit.
  - `public-site/qualification-view.ts` (W2b `:179`, `:187-199`) is updated in Task 9, with a parity test against `applyPointsRule`.
- **P-4 "A" — a correction that would end the match (was OQ-3).** Refused `FORMAT_DOES_NOT_FIT_PLAY` with "This format would end the match as it stands." Task 14 writes the real ledgers (review I8).
- **Already decided, not re-asked:** ruling 74's creation refusal is amended by the owner's Q7 "B" (all deciders off is allowed, with a notice, and held) — review M10; the S1 layout is the owner's "A" — review M8.

- **P-5 "A" — `share` on a sport that refuses draws (was OQ-4; finding 34).** Owner answer, verbatim: "A".
  - Refuse `abandonPolicy: "share"` with `allowDraws: false` at config save: `CONFIG_INVALID`, "Sharing the points needs draws to be allowed." Every write path that saves a cfg refuses it: `patchDivision`, `putStageRules` and `createStages`.
  - The S1 form shows the option as unavailable, with the same reason (Task 17).
  - Carrom is unaffected (it has no `allowDraws`).

No owner question is open. OQ-1..OQ-4 are closed.

---

## Decisions

- **D1 — the rule declaration is an engine fact (spec §4.1 as amended).**
  - `SportModule` gains `ruleKeys?: RuleKeys`, where `RuleKeys = Readonly<Record<string, RuleKeyFact>>` and `RuleKeyFact = {scope: "match" | "stage" | "points"; appliesTo?: {stageKinds?: readonly StageKind[]; variants?: readonly string[]}; matchBound?: "off_or_shorter"}`.
  - A key is a cfg path: a top-level key (`"bestOf"`), or a dotted path to a leaf inside an object (`"overtime.minutes"`) when the leaf's scope differs from its object's (finding 3). The most specific declared key owns a leaf.
  - `matchBound` is the one additive member beyond the spec's literal type (finding 4). It carries X-SR-2's "extra time per match only off or shorter" as a rule fact rather than web logic.
  - The engine exports `ruleKeyApplies`, `stageKeysFor`, `fixtureKeysFor`, `pointsKeysFor`, `ruleKeyOwning` and `checkFixtureOverride` from `@seazn/engine/sport`.
  - Shared kernels declare their keys once (`SET_RULE_KEYS` in the set-based kernel, `PERIOD_RULE_KEYS` in the period kernel), and modules spread or narrow them.
- **D2 — web is presentation only.**
  - `apps/web/src/lib/match-rules/<sport>.ts` holds each sport's `RuleField[]`. Each field gains `edits: readonly string[]`, the engine `ruleKeys` keys it writes.
  - No scope or applicability is declared in web.
  - `apps/web/src/lib/rule-scope.ts` maps engine keys back to web fields (`stageFieldsFor`, `matchFieldsFor`, `pointsFieldsFor`, `buildMatchFragment`). It imports only `@seazn/engine/sport` and `@seazn/engine/sports` (public exports).
  - Client components already import `@seazn/engine/sports` (five scorepad skins), so this adds no new kind of dependency.
  - The W2a M4 "restate engine lists client-side" pattern is NOT used here.
- **D3 — one storage place for deciders (greenfield, spec §11).** Every stage-scoped key, deciders included, lives in `stages.config.rules`. There are no live users, so no shim and no backfill:
  - `StageConfig`'s top-level `shootout`/`extraTime` (`schemas.ts:1109-1110`) are REMOVED from API v1;
  - the top-level overlay in `stageScopedCfg` (`stage-cfg.ts:35`, `STAGE_DECIDER_KEYS`) is deleted;
  - every writer and test that sets them top-level is moved to `rules` (Task 12 greps for them);
  - `createStages`/`replaceStages` ACCEPT `config.rules` (retiring `assertNoRulesKey`'s `RULES_NOT_ACCEPTED_HERE`) and validate it through the same allowlist and schema parse as `putStageRules` (SC-P8);
  - the tests that pin the old shapes are updated, not worked around.
- **D4 — the resolver signature.**
  - `resolveFixtureCfg(fixture: FixtureCfgSource, divisionCfg, stage, module)` with `interface FixtureCfgSource { readonly config_snapshot: unknown; readonly rules_override: unknown }`.
  - Both keys are REQUIRED, so a caller that does not select `rules_override` fails `tsc`.
  - A non-object override is ignored, as `stageScopedCfg` ignores a non-object `rules`.
- **D5 — the override fragment is replaced, never merged.**
  - `PUT /api/v1/fixtures/{id}/rules {rules}` replaces the fixture's whole fragment. `null` or `{}` clears the column to SQL `null`.
  - `writeFixtureRulesOverride(auth, fixtureIds[], fragment)` is all-or-nothing in one transaction and names the first fixture that blocked it.
- **D6 — Q11 correction.** Under the fixture advisory lock `appendEventInTx` takes, the writer refolds the recorded ledger with `foldFrom(fixtureId, {...inputs, cfg: corrected})` (`engine-db/fold.ts:165`).
  - It refuses `FORMAT_DOES_NOT_FIT_PLAY` when the fold throws (the engine's message is the reason), or when the corrected outcome differs from the recorded one — including a correction the play fits but that would END the match ("This format would end the match as it stands", owner P-4 "A").
  - Otherwise it writes `rules_override`, re-freezes `config_snapshot` + `config_snapshot_at` to the corrected resolved cfg, and increments `rules_version` (owner P-1).
  - It upserts `match_states` through the helper the staff re-snapshot uses (extracted from `admin-fixture-config.ts:212-338` into `engine-db/refreeze.ts`).
  - It writes one `competition_events` row `fixture.rules_override` with `{fixture_id, before, after, started}`.
- **D7 — every Armageddon records its colours (greenfield).**
  - An Armageddon `boardgame.tiebreak` event carries `black: EntrantId` and `result: "white" | "black" | "draw"`. The engine derives the advancer (a draw → Black, BG-KO-2) and refuses an Armageddon without `black` with `TIEBREAK_COLOUR_REQUIRED`.
  - No cfg flag and no legacy path: there are no live ledgers (spec §11), and the golden corpus has no Armageddon event (`grep -c armageddon boardgame.golden.json` = 0, 2026-10-13).
  - The three `tiebreak.test.ts` cases that send the old `{rung: "armageddon", winner}` shape are updated (finding 24).
  - Rapid and blitz rungs keep `{rung, winner, score?}`.
- **D8 — tie-break rungs.**
  - The boardgame cfg gains `tiebreakRungs: z.array(z.enum(TIEBREAK_RUNGS)).max(3).optional()`, refined to no duplicates. Absent means `TIEBREAK_RUNGS` (today's behaviour).
  - An empty list sends no game to phase `tiebreak`: a drawn bracket game is level, and the server holds it `needs_decision` (ruling 79).
  - A `boardgame.tiebreak` event whose rung is not in the list is refused `TIEBREAK_NOT_APPLICABLE` (an existing code).
- **D9 — abandon options (Q10).** The engine key is `abandonPolicy`.
  - Period kernel: `["replay", "award", "q4_stands"]`, with `q4_stands` refined to `periods.count === 4`. **`q4_stands` is a hockey-only option** (review I5): the offered options are a per-SPORT list (`abandonOptions` on the module: hockey declares all three, ice hockey declares `["replay", "award"]`), and ice hockey's parse refuses `q4_stands`. **It stands once the last regulation period has started, including in overtime and the shoot-out** (review I4): it replays only an abandon in `pre` or in a regulation period before the last (`period/kernel.ts:651-665`, `:708` replay otherwise).
  - Football keeps `["replay", "award"]` ("Result stands" = `award`, W2b's FB-AB-1 semantics).
  - Carrom and generic gain `abandonPolicy: z.enum(["replay", "share"]).optional()` (absent = replay). `share` folds an abandon to a `draw` at the score as it stood. Its `ruleKeys` entry has `appliesTo.stageKinds = DRAW_KINDS`.
  - Hockey's `fih-shootout` preset gains `abandonPolicy: "q4_stands"`.
  - The engine declares the offered list per sport (`SportModule.abandonOptions?: readonly string[]`, beside `ruleKeys`), and each module's parse refuses a policy outside its own list. The web picker (`abandonOptions(module)` in `lib/match-rules/shared.ts`) reads that list through the `ABANDON_LABELS` lookup table, so no if/else chain decides per sport and ice hockey is never offered `q4_stands`.
- **D10 — codes.**
  - New server codes are `HttpError` codes: `DIVISION_TABLE_RULES_LOCKED`, `DIVISION_FORMAT_LOCKED`, `FIXTURE_FORMAT_LOCKED`, `FORMAT_DOES_NOT_FIT_PLAY`, `RULE_NOT_SETTABLE`, `POINTS_RULE_INEXPRESSIBLE`, `FIXTURE_RULES_CHANGED` (D14). They are declared once in `apps/web/src/lib/rule-errors.ts` with their HTTP status.
  - `TIEBREAK_COLOUR_REQUIRED` is an `EngineErrorCode` (appended; `ENGINE_HTTP` 422).
  - Organiser copy lives under `ruleLock.<CODE>` in `ui.json` (4 locales). The server's English message is the same sentence.
  - OpenAPI has no code enum (finding 8), so each route's summary lists its codes.
- **D11 — the division lock (owner P-2 "A").**
  - Table rules are the division config keys whose `ruleKeys` scope is `"points"` (`pointsKeysFor`), plus `pointsMap`, plus the `tiebreakers` column. Every other changed key is match format.
  - A key is locked when a stage that INHERITS it has started (`lockedStageIdsAmong`). A stage inherits a format key unless its `config.rules` sets that key, and inherits table rules unless its `config.points` is set.
  - Refused keys are dropped from the write and listed in the response as `refused: [{field, code, stageId, stageName}]`; the rest saves.
  - **Re-parse after restore (review I1).** The write is built in two steps: (1) apply the requested change, (2) put every refused key back to its stored value. The FINAL config is then parsed once more by `module.configSchema` (`CONFIG_INVALID` on failure), so a restore can never write an unvalidated combination. When `variant_key` is refused, the preset keys that variant would have written are dropped as well (computed as the keys where `variants[requested]` differs from `variants[stored]`), and each is listed in `refused` under the variant's stage.- **D12 — one points describer.** `pointsLine(rule)` (Task 16) lives in the client-safe `apps/web/src/lib/points-line.ts`. `describe-rules.ts` (pure, `:10`) and the S3 preview both call it (spec §8).
- **D14 — the rules version (spec §4.5 item 2 at `1b757c6cb`; owner P-1 "A").** Replaces this plan's first mechanism (`config_snapshot_at` compared with the first event's `recorded_at`), which the review showed can never compare equal: Postgres `now()` in µs against the app's `new Date()` in ms, and `event-import` passes the historical `ev.at` (review C1, finding 28).
  - **The column.** `fixtures.rules_version int not null default 0`, added in Task 10's migration beside `rules_override`. Greenfield: no backfill is needed, because the default 0 is correct for every existing fixture (none was ever corrected).
  - **Who increments it.** ONLY `refreezeFixture` (Task 14), which both the Q11 correction and the staff `resnapshotFixtureConfig` call: `rules_version = rules_version + 1` in the same statement as the snapshot write. The first freeze at the first event does NOT touch it.
  - **Who sends it.** The scoring pads, always: `transport.ts:355` (the console's v3 pad pipeline) and `device-score-pad.tsx:318` (the remote `/score/[token]` pad). Both load it through `loadFixturePadCfg` (`rulesVersion`). An offline replay sends the version captured when the tap was made, exactly as it keeps its original `expected_seq`.
  - **Who does not send it, and is never blocked.** The console chrome's own `send()`/`post()` (`fixture-console.tsx:634`: start, void, settle, forfeit, abandon, finalize), `americano-panel.tsx:154`/`:160`, and the server's own writers that call `appendEvent` directly (`withdrawal.ts:121-160`, `scoring.ts:873` `finalizeFixture`, `event-import.ts:354`). API-v1 clients that omit it are unaffected (review C2).
  - **The check.** In `appendEventInTx`, under the fixture advisory lock and BEFORE the insert: if the request carries `rules_version` (a number) and it differs from the stored column, refuse `409 FIXTURE_RULES_CHANGED` with `extra: {rules_version: <stored>, format: <format line>}`. Absent means unchecked. There is no rule (b).
  - **The source scan.** One test enumerates every `/api/v1/fixtures/${…}/events` POST site under `apps/web/src` (excluding `__tests__`) and classifies each in a table: `pad` (must send `rules_version`) or `other` (named reason). A new unclassified site fails, and a `pad` site whose body lacks `rules_version` fails.
  - **The response.** Every accepted append returns the stored `rules_version`. When it differs from the pad's loaded version, the pad reloads its rules (`GET /api/v1/fixtures/{id}/rules`, new, returning `{cfg, rules_version, format_line}`) and, if the format line changed, shows the banner "The organiser changed this match's format: {format}".
- **D13 — stage creation.**
  - `withStageDefaults(module, kind, variant, config)` (new, `usecases/stage-defaults.ts`) is called at both stage insert sites (`stages.ts:458`, `templates.ts:345`). It returns `rules = stageDefaults(kind, variant) ⊕ provided rules` (provided wins), validated as in D3.
  - `replaceStages`' carry merges `defaults ⊕ carried` per key instead of replacing `rules` (`stages.ts:548-560`).

---

## Step 0 — anchors (pinned 2026-10-13 at `f1a3da356` = main `a6cc1f038` + three spec commits; W2b at `96b0f4db0`)

`E` = `packages/engine/src`. `W` = `apps/web/src`. `IDX` = `docs/superpowers/specs/2026-09-27-format-matrix-prompts/_INDEX.md`. `MUT` = `docs/superpowers/specs/2026-09-27-format-matrix-prompts/mutants/w2c`. `RULES` = `packages/engine/rules`.

| Fact | Where |
|---|---|
| `lib/match-rules.ts` is 1,062 lines; exports `RuleField :17`, `SPORT_RULES :323`, `SINGLE_SET_POINTS_LABEL :823`, `showsOnePointsField :851`, `visibleRuleFields :862`, `setRuleValue :877`, `alignBestOfOnePoints :898`, `buildRuleOverride :914`, `hydrateRuleValues :945`, `STAGE_RULES_SPORTS :956`, `keysEmittedBy :976`, `configKeysFor :989`, `ruleOptionLabel :1023`, `borrowOptionLabel :1051` | `W/lib/match-rules.ts` |
| private helpers `ownOr :124`, `rulesFor :131`, `sameShape :139`, `readShape :147`; shared `WIN_BY :159`; per-sport arrays `VOLLEYBALL_RULES :171`, `BADMINTON_RULES`, `TABLETENNIS_RULES`; `shootoutPointsPatch :311`; `TENNIS_SET_SHAPES` | `W/lib/match-rules.ts` |
| 15 importers of `@/lib/match-rules` (`stages-panel.tsx`, `match-rules.tsx` re-exports `RuleField` and three functions at `:16-23`, `stage-rules.ts`, `describe-rules.ts`, the division `page.tsx`, `e2e/walkthrough/stage-rules-start-promotion.spec.ts`, nine test files) | `git grep -l 'lib/match-rules"'` |
| per-sport field keys (41 unique) | `W/lib/match-rules.ts:326-792` |
| cricket `superOver` "Knockout fixtures only." (false, CR-11) | `W/lib/match-rules.ts:454-460` |
| `putStageRules` (gate `:154`, lock `:177`, allowlist `:195`, clear `:222`, merge-parse `:235`, write `:268`); `lockedStageIdsAmong :40` (not exported); `formatLockedStageIds :63` | `W/server/usecases/stage-rules.ts` |
| `stageScopedCfg`, `STAGE_DECIDER_KEYS` | `W/server/engine-db/stage-cfg.ts:18-40` |
| `resolveFixtureCfg :71`, `FixtureStageSource :7`, `DeciderSource :12`, `hasFrozenCfg :100` | `W/server/engine-db/fixture-cfg.ts` |
| resolver callers on main (9 files / 11 sites): `fold.ts:160`, `append-event.ts:287`, `competition.ts:339,362`, `match-centre-load.ts:432`, `usecases/fixtures.ts:124`, `player-stats.ts:444`, `event-import.ts:281`, `org-posts.ts:778`, `admin-fixture-config.ts:130,206`. W2b adds `engine-db/awarded-state.ts:101` | per file |
| caller-count source scan plus per-caller DB proof | `W/server/engine-db/__tests__/bracket-overlay-callers.test.ts:52-99` |
| `foldFrom :165`, `loadFoldInputs :88`, `FoldInputs :36-45` | `W/server/engine-db/fold.ts` |
| freeze `:297`, `:448-453`; `LOCKED_FIXTURE_STATUSES :108` | `W/server/engine-db/append-event.ts` |
| `resnapshotFixtureConfig :155` (guards `:161-203`, writes `:212-338`, audit `:342`) | `W/server/usecases/admin-fixture-config.ts` |
| `patchDivision :635` (config lock `:820-856`, write `:874`, tiebreakers `:899`) | `W/server/usecases/divisions.ts` |
| `createStages :362` (`assertNoRulesKey :368`, custom-points gate `:404-415`, insert `:458`); `replaceStages :490` (lock `:513-518`, carry `:528-560`); template insert | `W/server/usecases/stages.ts`; `W/server/usecases/templates.ts:345` |
| `StageConfig :1071` (`points :1104`, `shootout :1109`, `extraTime :1110`, `rules :1119`), `CreateStage :1131`, `PutStageRules :1201`, `StageRules :1206` | `W/server/api-v1/schemas.ts` |
| `/stages/{id}/rules` route | `W/server/api-v1/openapi.ts:156`; `W/app/api/v1/stages/[id]/rules/route.ts` |
| `HttpError(status, message, code?, extra?)` | `W/lib/errors.ts:12-20` |
| `ENGINE_HTTP`; `ENGINE_ERROR_KEY` | `W/server/api-v1/http.ts:22`; `W/lib/scoring-vocab.ts:596` |
| `stageFormatLines :37`; `describeMatchRules :202` (4-sport gate `:207`), `rulesDifferFromDivision :243`, `effectiveRulesLine :283`; public source `stages.config->'rules'` | `W/server/public-site/stage-format-lines.ts`; `W/server/public-site/describe-rules.ts`; `W/server/public-site/data.ts:946` |
| `StageFormatRow :2130` (mount gate `:1200`, PUT `:2192`, clear `:2209`, testids `:2223-2277`) | `W/components/v2/stages-panel.tsx` |
| `MatchRuleFields :26-43` | `W/components/v2/match-rules.tsx` |
| `FixtureConsole` props `:298-376`, match-actions `:1494-1553`; page loader `:69-81` | `W/components/v2/fixture-console.tsx`; `W/app/o/[orgSlug]/c/[compSlug]/d/[divSlug]/f/[no]/page.tsx` |
| `loadFixturePadCfg :98-131` | `W/server/usecases/fixtures.ts` |
| `run-sheet-held-chip :569-576` | `W/components/v2/desk/run-sheet-row.tsx` |
| division settings: `format-locked :788`, points grid `:924-944`, `applyFormat :551-623` | `W/components/v2/division-settings.tsx` |
| boardgame tie-break sheet `:550-601`, `buildSheets :605` | `W/components/v2/scorepad/v3/skins/boardgame.tsx` |
| `SportModule :690` (`configSchema :693`, `variants :753`, `supportsDraws :830`, `bracketDeciders :834`); `E/sport/index.ts` re-exports `module.ts` | `E/sport/module.ts` |
| `StageKind :91-102`, `BRACKET_KINDS :108`, `DRAW_KINDS :111`, `forbidsLevelResult :114` | `E/core/types.ts` |
| `builtinModules` (11 sports) ; `forEachSport(fn, modules?) : number` | `E/sports/index.ts:23`; `E/testkit/for-each-sport.ts:57` |
| engine package subpaths `./sport`, `./sports`, `./sports/*` (= `src/sports/*/index.ts`; set sports via `./sports/setbased`) | `packages/engine/package.json:7-11` |
| `TIEBREAK_RUNGS :191`, `BoardgameTiebreak :195-203`, cfg `tiebreak :84`, phase `:297`, `applyTiebreak :354-366`, `bracketDeciders :876`, `awaitingDecider :879` | `E/sports/boardgame/boardgame.ts` |
| football cfg (`extraTime :105-110`, `shootout :111` boolean, `points :112`, `abandonPolicy :174`), `applyAbandon :1654`, shoot-out kick `:1612-1626` | `E/sports/football/football.ts` |
| `shootoutDecision(kicks, attempts = 5)` | `E/sports/period/shootout.ts:60` |
| period cfg (`overtime`/`shootout` unions `:175-199`, `abandonPolicy :220`), `applyAbandon :1447-1462` | `E/sports/period/kernel.ts` |
| hockey defaults `:125-136`, `fih-shootout :141-144`; icehockey defaults `:165-176` | `E/sports/hockey/hockey.ts`; `E/sports/icehockey/icehockey.ts` |
| cricket `decideTie` reads `cfg.superOver` | `E/sports/cricket/cricket.ts:936-947` |
| `PointsRule :12-39`, `isForfeit :57-59`, `applyPointsRule :123` (W2b `:125`), awardScore ADDS `:146-152` (W2b `:149-154`) | `E/competition/points.ts` |
| W2b `awardReasonOf`, `FORFEIT_REASONS`, `AWARD_REASONS` | W2b `E/sport/forfeit-credit.ts:17`; `E/core/types.ts:136`, `:140` |
| `EngineErrorCode` (27) + frozen-order test | `E/core/errors.ts:7-78`; `E/core/errors.test.ts:30` |
| golden coverage | `E/testkit/golden.ts:785`; `E/testkit/GOLDEN-POLICY.md:26`, `:113-122` |
| rules checker, `AWAITING_PROOF` | `packages/engine/test/rules-reference.test.ts:12`; `packages/engine/test/rules-reference.ts:167` |
| DB helpers `seedBracket`, `declaredVariant`; local `seedOrg/seedDivision/seedStage/stageConfig` | `W/server/engine-db/__tests__/helpers/seed-bracket.ts:21-117`; `W/server/usecases/__tests__/stage-rules.test.ts:31-93` |
| e2e helpers `apiJson :312`, `addEntrantsViaApi :1978`, `createStageAndGenerate :1995`, `fixturePath :1959`, `expectNoHorizontalScroll :56`, `screenshotAtWidths :447`, `TAG :258` | `apps/web/e2e/helpers.ts` |
| width projects all `testMatch: /mobile\.spec\.ts/` | `apps/web/playwright.config.ts:191-258` |
| smoke `check :135`, suites called from `main :185` | `scripts/smoke.ts` |
| the append route and its body schema | `W/app/api/v1/fixtures/[id]/events/route.ts:11-18`; `AppendEventRequest` `W/server/api-v1/schemas.ts:1828-1833` |
| every client POST to that route (review C2; the scan in Task 15 enumerates them): scoring pads `W/components/v2/scorepad/transport.ts:355` (wire body `pipeline.ts:152`, `:203`) and `W/components/v2/device-score-pad.tsx:318`; not pads: `W/components/v2/fixture-console.tsx:634` (the console chrome's `post()`: start, void, settle, forfeit, abandon, finalize), `W/components/v2/americano-panel.tsx:154`, `:160` | per file |
| server writers that call `appendEvent` directly | `W/server/usecases/withdrawal.ts:121-160`; `W/server/usecases/scoring.ts:873` (`finalizeFixture`); `W/server/usecases/event-import.ts:354` (passes the historical `ev.at`) |
| both pads load cfg through `loadFixturePadCfg` | console `f/[no]/page.tsx:79`; remote `W/app/score/[token]/page.tsx:265-270` |
| the freeze clocks differ: `config_snapshot_at` is Postgres `now()` (µs, `append-event.ts:451`), the event's `recorded_at` is the app's `new Date()` (ms, `:258`) — why D14 uses a counter (review C1) | `W/server/engine-db/append-event.ts` |
| draw refusals at append (`DRAW_NOT_ALLOWED`, `LEVEL_RESULT_IN_BRACKET`) | `W/server/engine-db/append-event.ts:405-424` |
| W2b "was anything played": `playRecorded(ledger, module)` (rulings 112–115, 118, 120) | W2b `E/core/events.ts:354` |
| `applyPointsRule` callers on W2b: `W/server/engine-db/competition.ts:395` and the bye path `:115`; `E/testkit/scenarios.ts:377`; `tools/bench/lib/validate-pack.ts`. Mirror reader: W2b `W/server/public-site/qualification-view.ts:179`, `:187-199` | per file |
| period abandon phase test (`q4_stands` predicate base) | `E/sports/period/kernel.ts:651-665`, `:708` |
| pins that P-2 turns red: smoke `scripts/smoke.ts:8378-8385` (whole-config `FORMAT_LOCKED` after generation); `W/server/usecases/__tests__/division-settings.test.ts:726-738` (and the F2b block `:586-640`) | per file |
| old Armageddon senders (review I10): `W/server/usecases/__tests__/withdrawal-decider-hold.test.ts:214`; `scripts/smoke.ts:2406`; three `E/sports/boardgame/tiebreak.test.ts` cases | per file |
| the hand-mutant runner has NO Playwright mode (`Killer :14`; validation `:105-121`) | `scripts/mutate.ts` |
| highest delta on main | `db/migration/deltas/V437__capture_records.sql`; W2b adds `V438__w2b_double_walkover_and_results.sql` |

Before building on any line above, the implementer re-opens it (AGENTS class 5). After Task 3, every pin above is re-taken on the rebased tree. A moved line is a note in the task report; a changed MEANING is a new plan finding.

---

## Global Constraints

- **Worktree.** `WT` = `/Users/ashokhein/github/seazn.club-worktrees/format-matrix-w2c`, branch `feat/format-matrix-w2c`.
  - Every shell command starts `cd /Users/ashokhein/github/seazn.club-worktrees/format-matrix-w2c && …` (cwd resets between calls).
  - Never edit the main checkout or the W2b worktree. **Never `git stash`**: the stash stack is shared.
  - **No heredocs.** Write commit messages with the Write tool to `$TMPDIR/w2c-msg.txt`, then `git commit -F "$TMPDIR/w2c-msg.txt" -- <paths>`. Always name the paths: the orchestrator commits spec and IDX edits in the same worktree.
  - Every message ends with a blank line and the `Co-Authored-By:` line the committing agent's own system prompt gives.
- **Setup once (Task 0):** `pnpm install --frozen-lockfile`; symlink (never copy) `.env.local` and `apps/web/.env.local` from the main checkout; `readlink -f node_modules/@seazn/engine` must resolve inside `WT`.
- **Local env.** Follow `~/.claude/skills/seazn-local-env/SKILL.md`, with `S=~/.claude/skills/seazn-local-env/scripts/seazn-env.sh` and label `w2c`.
  - `$S up --label w2c --all` gives a fresh pg + `db:apply` + `sync:sports` + a prod server.
  - Load the environment with `eval "$($S env --label w2c)"`.
  - `psql "$DATABASE_URL" -Atc "show data_directory"` must equal the label's datadir.
  - After a code change, run `$S rebuild --label w2c`, never a second `up`.
  - `SMOKE_BASE=http://localhost:<port>` (never 127.0.0.1). e2e `BASE` is `localhost`, and Playwright runs from `apps/web`.
- **Local verification = ONLY the tests covering the files you changed.** Never the full gate, the full vitest suite, the full e2e suite or `seazn-env gate`. Never a Playwright `-g` slice: whole spec files only (R18). `mobile.spec.ts` is serial: a red count is a floor, so re-run after each fix until a full pass.
  - **apps/web vitest, by path** (`<N>` = task number):
    ```bash
    cd /Users/ashokhein/github/seazn.club-worktrees/format-matrix-w2c/apps/web && rm -f "$TMPDIR/w2c-t<N>.json" && npx vitest run <exact paths> --reporter=json --outputFile="$TMPDIR/w2c-t<N>.json"; echo EXIT=$?
    ```
  - **apps/web vitest, by edited sport file** (owner, 2026-10-13: editing one sport's presentation file runs that sport's tests):
    ```bash
    cd /Users/ashokhein/github/seazn.club-worktrees/format-matrix-w2c/apps/web && rm -f "$TMPDIR/w2c-t<N>.json" && npx vitest related --run src/lib/match-rules/<sport>.ts --reporter=json --outputFile="$TMPDIR/w2c-t<N>.json"; echo EXIT=$?
    ```
    `related` runs every test that imports the file, directly or through a chain. The per-sport contract tests import ONLY their own sport file (never the `index.ts` registry), so a football edit runs `football.contract.test.ts` and the registry-level suites, never another sport's contract. Judge that with
    ```bash
    jq -r '.testResults[].name|select(test("contract"))' "$TMPDIR/w2c-t<N>.json"
    ```
    Every name it prints must contain the edited sport.
  - **Engine vitest:**
    ```bash
    cd /Users/ashokhein/github/seazn.club-worktrees/format-matrix-w2c/packages/engine && rm -f "$TMPDIR/w2c-t<N>e.json" && npx vitest run <exact paths> --reporter=json --outputFile="$TMPDIR/w2c-t<N>e.json"; echo EXIT=$?
    ```
  - **The judge, after every vitest run:**
    ```bash
    cd /Users/ashokhein/github/seazn.club-worktrees/format-matrix-w2c && jq -c '{total:.numTotalTests,passed:.numPassedTests,failed:.numFailedTests,failedSuites:.numFailedTestSuites,files:[.testResults[].name]|length,names:[.testResults[].name]}' "$TMPDIR/w2c-t<N>.json"
    ```
    - **Green** = `failed == 0`, `failedSuites == 0`, `passed == total > 0`, `files` equals the number of paths passed (for `related`, the reviewer reads `names`), and every name starts with `WT`.
    - **A TDD red** = `failed > 0` AND `failedSuites == 0` AND each failure message is the assertion the step names. Read them with `.testResults[].assertionResults[] | select(.status=="failed") | .failureMessages[0]`. A `TypeError` or a collect failure is not a red.
    - Paste the line into the task report.
    - Never trust an `rtk` summary: `PASS(0) FAIL(0)` is a suite that failed to collect.
    - A vitest positional is a literal filename filter, so a typo silently runs a subset. The `files` count catches it.
  - **DB suites.** `.env.local` must be the symlink, or DB suites skip while `total` stays the same. A DB suite's pending count must be 0: `jq '[.testResults[].assertionResults[]|select(.status=="pending")]|length'`.
  - **Playwright** (whole files; the local server from the label):
    ```bash
    cd /Users/ashokhein/github/seazn.club-worktrees/format-matrix-w2c/apps/web && eval "$(~/.claude/skills/seazn-local-env/scripts/seazn-env.sh env --label w2c)" && npx playwright test e2e/<file>.spec.ts --project=parallel --reporter=json > "$TMPDIR/w2c-t<N>-pw.json"; echo EXIT=$?
    ```
    - For widths: `--project=mobile-320 --project=mobile-360 --project=mobile-se --project=mobile-14 --project=mobile-430 --project=tablet-768 --project=tablet-834` on `e2e/mobile.spec.ts`.
    - Judge with `jq '.stats'`: `unexpected == 0` and `expected > 0`.
    - A failure at `test.setTimeout` prints the in-flight `expect.poll` message first; that message is not the cause (class 20).
- **tsc and eslint, changed files only.**
  - Web: `cd WT/apps/web && rtk proxy node ../../node_modules/typescript-native/bin/tsc --noEmit -p tsconfig.json; echo EXIT=$?`.
  - Engine: `cd WT/packages/engine && rtk proxy node ../../node_modules/typescript-native/bin/tsc --noEmit; echo EXIT=$?`.
  - eslint: `cd WT && rtk proxy ./node_modules/.bin/eslint <changed files>; echo EXIT=$?`. Clean only with `EXIT=0` and no `✖`.
- **`grep -a` always** (or `git grep -n -a`). An empty grep from the wrong cwd is not absence.
- **The engine/web boundary** (spec §4.1; the engine moves to its own repo after W2):
  - `apps/web` imports only the engine's package subpaths (`@seazn/engine/core`, `/sport`, `/sports`, `/sports/<key>`, `/competition`). Never `@seazn/engine/src/...` and never a relative path into `packages/`.
  - New engine helpers are exported from `E/sport/index.ts`.
  - The engine never imports web.
- **OpenAPI** before every commit that touches `api-v1/`: `cd WT && pnpm openapi:gen && git status --porcelain openapi/` must show only the intended diff, committed with the task.
- **Golden corpus** (`E/testkit/GOLDEN-POLICY.md`).
  - Never `UPDATE_GOLDEN` / `REBASELINE_GOLDEN`.
  - New cfg fields are `.optional()` with no default.
  - A new coverage stream is appended with `EXTEND_GOLDEN=1` in a commit of its own, then `pnpm --filter @seazn/engine schema:snapshot`.
- **Strings** (R23).
  - Every new user-facing chrome string goes to `W/dictionaries/{en,es,fr,nl}/` in the same commit, then `pnpm i18n:gen-keys` and `pnpm i18n:check` at the root. `W/lib/i18n-keys.ts` is generated.
  - **Rule field labels, option labels and help stay canonical English in `lib/match-rules/<sport>.ts`** (design 2026-09-17, `match-rules.tsx:10`).
  - Only chrome localizes: section titles, the "Division" / "This stage" / "This match" tags, lock lines, notices, buttons, error copy.
- **Boundaries.**
  - A client component never imports a server module (`server-only`).
  - `lib/match-rules/**`, `lib/rule-scope.ts`, `lib/points-line.ts` and `lib/rule-errors.ts` are client-safe: no `server-only`, no `@/server/*` import.
  - `tools/` is never imported by `apps/` or `packages/`.
- **Do not touch:**
  - `.github/workflows/e2e.yml`;
  - `tools/bench/lib/suites/run-suite.ts` / `PackSchema`;
  - committed `truth-runs/**`;
  - the spec (the orchestrator owns it);
  - `competition/stage.ts` and `competition/progression.ts` (finding 22);
  - `colorOfHome` anywhere (the chess in-page contract);
  - any engine file split or move (spec §4.1: no engine restructure in W2c).
- **Test authority** (TEST-STRATEGY 1–10; R9, R13, R16, R25, R26, R28, R29):
  - **State transitions.** Every task lists its state transitions with the **empty case first**: a second call, an empty input, after a void (or withdrawal), another sport.
  - **Expected values** come from:
    - the signed rule rows (Appendix A as signed in Task 0);
    - the engine's declarations: `module.ruleKeys`, `module.configSchema`, `module.variants`, `module.stageDefaults`, `module.bracketDeciders`, `StageKind.options`, `BRACKET_KINDS`, `DRAW_KINDS`, `TIEBREAK_RUNGS`, `FORFEIT_REASONS`.

    They never come from the function under test. Each guard has one case where the right answer differs from the wrong one's constant.
  - **Anti-vacuity:**
    - Every sweep returns its count and asserts it `> 0`, and, where the population is known, equal to the derived count. Zero checked is a failure.
    - Sport sweeps go through `forEachSport` or `builtinModules`.
    - A single-sport test carries a one-line reason, and `pnpm matrix:single-sport --check --against HEAD^1` stays green. The per-sport web contract files are single-sport BY DESIGN; their reason line is "one file per sport, owner 2026-10-13".
  - **Budgets** come from the work: `const BUDGET_MS = Math.max(5_000, cases * PER_CASE_MS * 5)`.
- **Mutation, once per guard you add** (R17), through the W2a runner:
  ```bash
  cd /Users/ashokhein/github/seazn.club-worktrees/format-matrix-w2c && pnpm mutate --list docs/superpowers/specs/2026-09-27-format-matrix-prompts/mutants/w2c/t<N>.json --json-out "$TMPDIR/w2c-mut-t<N>.json"; echo EXIT=$?
  ```
  - Each mutant is `{id, file, find, replace, killers:[{cwd, files, name}]}`. `name` is a vitest `-t` regex: escape `( ) [ ] . * + ? |`.
  - Expected: `EXIT=0`, every row `KILLED by <test names>`, the file restored byte-identical. A `COLLECT_FAILED` killer is not a kill.
  - Engine code also runs changed-lines Stryker, with `TASK_BASE` = the commit the orchestrator recorded before dispatch:
  ```bash
  cd /Users/ashokhein/github/seazn.club-worktrees/format-matrix-w2c/packages/engine && rm -f reports/mutation/changed.json && M="$(node scripts/stryker-changed.mjs --base "$TASK_BASE")" && STRYKER_MUTATE="$M" pnpm mutation > "$TMPDIR/w2c-stryker-t<N>.log" 2>&1; echo EXIT=$?; node scripts/stryker-changed.mjs --report reports/mutation/changed.json --expect "$M"
  ```
  - Expected: `survived: 0, noCoverage: 0`. A survivor gets a killing test, or an equivalence row the reviewer agrees with. Never `// Stryker disable`.
  - E2E and smoke never appear in a `MUT/*.json` (`scripts/mutate.ts` has no Playwright mode). A guard whose only witness is a browser gets a pure helper (a `*-model.ts` beside the component) with a unit killer, and the component renders the helper's answer (review I9).
  - **Every `MUT/t<N>.json` must parse** before it is run or committed (review I3):
    ```bash
    cd /Users/ashokhein/github/seazn.club-worktrees/format-matrix-w2c && for f in docs/superpowers/specs/2026-09-27-format-matrix-prompts/mutants/w2c/t*.json; do jq -e 'type=="array" and length>0 and all(.[]; (.id|type)=="string" and (.killers|length)>0)' "$f" >/dev/null || echo "BAD $f"; done; echo EXIT=$?
    ```
    No `BAD` line may print, and each file's ids start with its own `t<N>-`.
- **Rule-10 sequences.** Ordered-action surfaces this wave touches get a fast-check sequence test with invariants after every step:
  - stage rules edits × fixture start × void (Task 11);
  - override write × start × correction × void × finalize (Task 14);
  - tie-break rungs × draw × settle (Task 8).

  A shrunk failure is committed as a named regression case, with its seed, BEFORE the fix (R29).
- **The four test types per task** (RULES.md).
  - A backend task traces its e2e forward to a NAMED later spec file and test title.
  - Smoke is owed per task as a named check inside `w2cStageRulesSuite` in `scripts/smoke.ts`, created in Task 10 and extended by later tasks. `smoke.ts` is a W2b file, so no pre-rebase task writes it.
  - Regression = the task's own red-first test plus the named existing suite it must keep green.
- **Rule rows.** Every proving test title carries its rule id as a whole token (`packages/engine/rules/README.md`). Until Task 3 writes the rows, the ids are already written in titles.
- **Docs as they happen** (R22). From Task 3 on, each task's commit updates `IDX`'s W2 row, and, for a false premise, "False premises found (W2c)". The orchestrator commits IDX.

---

## Review Focus

Five inputs the spec implies but no requirement names. Each line's test is written into the owning task.

1. **A scorer appends the first event while the organiser saves a correction on the same fixture.** Exactly one ordering wins: the correction either refolds the event (it fits) or is refused by name. Never a snapshot frozen under one cfg while `rules_override` says another. Test: Task 14, `fixture-rules.test.ts` "Review Focus 1: a correction and an append serialise on the fixture lock".
2. **The organiser saves a match override, then edits the stage's rules before the match starts.** The match plays the NEW stage value for every key it did not override, and its own value for the one it did; the console summary says which. Test: Task 10, `fixture-cfg-order.test.ts` "Review Focus 2: a stage edit after an override keeps the override and moves the rest".
3. **A Community-plan organiser opens the stage Points section.** The base win/draw/loss sentence works. The bonus rows and the walkover points row are shown as an upgrade gate (both states render). The API refuses `402 PAYMENT_REQUIRED` for a bonus exactly as `createStages` does (`stages.ts:404-415`). Tests: Task 13, `stage-points.test.ts` "Review Focus 3: bonuses and forfeit points need standings.custom_points"; Task 18 e2e "Review Focus 3: a Community org sees the gate, not the fields".
4. **The organiser turns every decider off on a knockout stage that already has generated, unstarted fixtures, and a match ends level.** The notice "Level matches in this stage will wait for your decision (lot, seed or your call)" was shown before saving. The level result is held `needs_decision`, and the settle closes it; no fixture is refused. Test: Task 12, `stage-defaults.test.ts` "X-SR-6 Review Focus 4: all deciders off → level → needs_decision → settle".
5. **The format template is re-applied (`replaceStages`) to a division whose knockout stage carries organiser-edited rules and W2c defaults.** The stage slot keeps the organiser's edits AND the defaults for keys they did not edit. A slot whose kind changed starts from its new kind's defaults only. Test: Task 12, `stage-defaults.test.ts` "Review Focus 5: replaceStages carries edits over defaults per key".

---

## Execution

**Owner ruling, 2026-10-13, verbatim: "A Sonnet with those 4 tasks on Opus".** It is recorded in `docs/superpowers/RULES.md` § Agent topology (commit `41dac8db8`) as a W2c-only exception. The standing Opus-minimum rule is unchanged for every other wave, and the `*-sonnet` agents are deleted when W2c closes (Task 23).

- **Agents.**
  - An ordinary task is implemented by `implementer-sonnet` and reviewed by `reviewer-sonnet`.
  - Exactly four pieces of work stay on the Opus `implementer` + `reviewer`. If a piece spans tasks, every part of it is Opus:

    | Owner's item | Task(s) | Why these |
    |---|---|---|
    | (1) engine `ruleKeys` + the `resolveFixtureCfg` change across every caller | **4** (the `ruleKeys` contract, helpers, override check, and the engine contract sweep), **10** (the migration, the resolver and its 12 caller sites) and **13b** (deleting the top-level decider overlay in `stageScopedCfg`, re-review IMP-R3) | Task 4 builds the contract; Tasks 10 and 13b change what the resolver returns for every caller. Task 5 (the web reader of the keys) is NOT part of it and stays Sonnet. |
    | (2) the Q11 refold/correction | **14** (the override writer, `refreezeFixture`, the correction, the admin hatch through it) | One task owns the writer and the refold. |
    | (3) the `rules_version` check | **15** (the append-time check, the pad senders, the POST-site scan, the writers test) | The column is created in Task 10 and incremented in Task 14, both already Opus. |
    | (4) the stage-points forfeit rule | **9** (`points.ts`, the four `applyPointsRule` callers, `qualification-view.ts`) | Task 13 (the stage points write path and its entitlement) does not decide what a forfeit is, so it stays Sonnet. |

  - **The per-sport `ruleKeys` DATA entries in Tasks 6–8 stay on Sonnet** (orchestrator decision under the owner's ruling, re-review IMP-R3). They are declarations, not contract or resolver code, and two Opus gates cover them: Task 4's engine contract sweep, which fails on any top-level key a module neither declares nor lists as unsettable, and batch 3's Opus batch-end review.
  - **No dispatch sets `model:`.** The agent type carries the model (`.claude/agents/{implementer,reviewer,implementer-sonnet,reviewer-sonnet,scout}.md`).
- **Every dispatch carries five things** (AGENTS.md):
  - exact file paths;
  - acceptance criteria: the task's red and green, with the rule ids;
  - what NOT to touch: Global Constraints plus the task's own list;
  - the verify command;
  - the output cap: "final message under 15 lines — counts, paths, deviations, blockers; no file contents or diffs".
- **UI dispatches (Tasks 15 (pad banner), 17–21)** must invoke `frontend-design:frontend-design` and apply it (spacing, hierarchy, the house design system already in `components/v2`), not cite it.
- **Raw counts.** The orchestrator never accepts "done, tests pass" without the judge's JSON line.

### Batches

Each task runs implementer → its own reviewer → fixes, as usual. **Every batch then ends with ONE Opus `reviewer` pass over the whole batch diff** (`git diff <batch-start-sha>..HEAD`), and the orchestrator re-runs the batch's SCOPED gate itself: the union of the batch's tasks' Step 4 commands, never the full suite. The next batch starts only after both are clean. Record `<batch-start-sha>` in `IDX` when the batch begins.

**The batch-end proof commit (re-review IMP-R4).** No task edits `packages/engine/test/rules-reference.test.ts` (`AWAITING_PROOF`) or a rules file's `proved-by` column. Each task reports the rule ids it proves, with the test paths. After the batch-end review is clean, the orchestrator makes ONE commit that:
- deletes those ids from `AWAITING_PROOF`;
- fills each row's `proved-by`;
- runs `rules-reference.test.ts` (judged by JSON).

Parallel lanes therefore never share that file. Task 23 confirms the map is empty.

| Batch | Tasks (lane) | Implementer → reviewer per task | Starts when |
|---|---|---|---|
| 1 — before the rebase | 0 (orchestrator); 1 (A, `WT`); 2 (B, lane) — 1 and 2 in parallel | 1: Sonnet. 2: Sonnet | now |
| — | 3 (orchestrator: rebase onto W2b, re-pin, rule rows) | orchestrator | W2b merged, batch 1 closed |
| 2 — the key declaration and the resolver | 4 (C, `WT`) and 10 (F, lane) in parallel; then 5 (C, `WT`) after 4 | 4: **Opus**. 10: **Opus**. 5: Sonnet | Task 3 done |
| 3 — engine rules | 6 + 7 (E1, `WT`, one loop); 8 (E2, lane); 9 (E3, lane) — all three in parallel | 6+7: Sonnet. 8: Sonnet. 9: **Opus** | batch 2 closed (Task 5 landed; lane F merged, which E3 needs) |
| 4 — server writers | 11 (G); then 12 + 13 (H, one loop); then 13b (H2); then 14 (I) — sequential | 11: Sonnet. 12+13: Sonnet. 13b: **Opus**. 14: **Opus** | batch 3 closed |
| 5 — pads and public labels | 15 (I2); then 16 (J) — sequential | 15: **Opus**. 16: Sonnet | batch 4 closed |
| 6 — UI and close-out | 17 + 18 (K, one loop); 19 (L); 20 + 21 (M, one loop, two reviewer sections); then 22 (N); then 23 (orchestrator) — sequential | all Sonnet; 23 orchestrator | batch 5 closed |

- Batches follow the parallel groups and lanes in **Loops and lanes**. A lane in a batch merges into `WT` before the batch-end review, so that review sees the merged tree.
- Batch 6's Opus review runs before Task 23's PR, over Tasks 17–22. Task 23's own gates follow it.
- A batch-end finding is fixed by the agent type that owns the task the finding is in (an Opus task's fix goes to `implementer`, any other to `implementer-sonnet`), then the batch-end review re-runs on the fix diff.

## Loops and lanes

**W2b's diff** (merge-base `55ac34d5d` → `96b0f4db0`, 339 files):
- **Touches:**
  - engine: every sport module and kernel, `sport/module.ts`, `core/{events,types,errors}.ts`, `competition/stage.ts`;
  - server: `engine-db/{append-event,competition,fed-seats,fold,awarded-state}.ts`, `usecases/{stages,scoring,withdrawal,player-stats,fixtures,org-posts}.ts`, `usecases/stage-rules.ts` (one doc comment), `match-centre-load.ts`, `api-v1/{http,schemas}.ts`;
  - web: `lib/{scoring-vocab,run-sheet-groups}.ts`, `components/v2/{stages-panel,fixture-console}.tsx`, `desk/run-sheet-row.tsx`, the boardgame skin;
  - strings, tests and docs: all four `ui.json` and `public.json`, `openapi/*.json`, `scripts/smoke.ts`, `e2e/mobile.spec.ts`, `rules-reference.*`, every rules file and `IDX`.
- **Does NOT touch:** `lib/match-rules.ts`, `engine-db/{fixture-cfg,stage-cfg}.ts`, `usecases/{divisions,templates}.ts`, `describe-rules.ts`, `stage-format-lines.ts`, `division-settings.tsx`, `match-rules.tsx`.

| Loop | Tasks | Where | Files | Waits on |
|---|---|---|---|---|
| — orchestrator | 0 setup, P-1..P-5 recorded, rule-row signing | `WT` | `MUT/.gitkeep` only | nothing |
| A | 1 web `match-rules` split per sport (pure move) | `WT` | `W/lib/match-rules.ts` → `W/lib/match-rules/{index,types,shared,<11 sports>}.ts`, `W/lib/match-rules/__tests__/split-equality.test.ts` (temporary, deleted in the task) | Task 0 |
| B (lane) | 2 division locks, server | worktree `format-matrix-w2c-divlock` | `W/server/usecases/{divisions,rule-locks}.ts` (`rule-locks.ts` new), `W/server/usecases/stage-rules.ts` (moves one function out, imports it back), `W/lib/rule-errors.ts` (new), `W/server/usecases/__tests__/{division-locks,division-settings}.test.ts` (incl. the `:726-738` pin, review I2), `MUT/t2.json`. NOT `scripts/smoke.ts`: its `:8378-8385` pin is moved by Task 10 in lane F, which owns `smoke.ts` after the rebase | P-2 answered "A". **Parallel with A** (no shared file) |
| — orchestrator | 3 rebase onto W2b, re-pin, rule rows | `WT` | rebase; `RULES/*.md`; `rules-reference.test.ts` `AWAITING_PROOF`; `IDX` | **BLOCKED until W2b merges** |
| C | 4 engine `ruleKeys` + helpers + engine P1 sweep; then 5 web `edits` + per-sport contract tests + `rule-scope.ts` | `WT` | 4: `E/sport/{module,rule-keys,index}.ts` (incl. the optional `SportModule.abandonOptions` TYPE), `E/sport/rule-keys.test.ts`, every `E/sports/**/<module>.ts` (one `ruleKeys` property each), `E/sports/setbased/kernel.ts`, `E/sports/period/kernel.ts`, `MUT/t4.json`. 5: `W/lib/match-rules/**` (incl. `types.ts`'s `"sequence"` kind and `shared.ts`'s `ABANDON_LABELS` + `abandonOptions`, moved here so E1/E2 never touch them, review M12), `W/lib/rule-scope.ts` (new), `W/lib/__tests__/rule-scope.test.ts`, `W/server/usecases/{rule-locks,divisions}.ts` (`TABLE_RULE_KEYS` derivation and its one reader, review M4), `MUT/t5.json` | Task 3 |
| E1 | 6 `stageDefaults` + KO presets + football attempts; 7 abandon options | `WT` | `E/sports/{football,hockey,icehockey,cricket,carrom,generic}/**`, `E/sports/period/{kernel,shootout}.ts`, their `*.schema.json`, `E/sport/stage-defaults.test.ts`, `E/sport/abandon-options.test.ts`, `E/sports/cricket/cricket.test.ts` (CK-SO-1), `W/server/engine-db/__tests__/abandon-share.test.ts` (new, review I6), `W/lib/match-rules/{football,hockey,icehockey,cricket,carrom,generic}.ts` + their contract tests, `MUT/t6.json`, `MUT/t7.json` | Task 5 |
| E2 (lane) | 8 chess rungs + Armageddon colours | worktree `format-matrix-w2c-chess` | `E/sports/boardgame/**` (incl. golden + schema), `W/server/usecases/__tests__/withdrawal-decider-hold.test.ts` (one old-shape sender, review I10), `E/core/errors.ts`, `E/core/errors.test.ts`, `E/testkit/golden.ts` (one COVERAGE entry), `W/lib/match-rules/boardgame.ts` + its contract test, `W/server/api-v1/http.ts` (one row), `W/lib/scoring-vocab.ts` (one row), 4 × `ui.json` (one key), `MUT/t8.json` | Task 5. **Parallel with E1 and E3** |
| E3 (lane) | 9 stage points walkover split + inexpressible | worktree `format-matrix-w2c-points` | `E/competition/points.ts`, `E/competition/points-w2c.test.ts`, the existing tests the `played` parameter and the replace rule break (re-review IMP-R4): `E/competition/points.test.ts`, `E/competition/w2b-tables.test.ts`, `E/competition/tiebreak-rule-award-alias.test.ts`, `W/server/public-site/__tests__/qualification-view.test.ts` (`:1232-1306`); `E/testkit/scenarios.ts` (one caller), `tools/bench/lib/validate-pack.ts` (one caller), `W/server/engine-db/competition.ts` (two callers), the standings DB suite's award case, `W/server/public-site/qualification-view.ts` + its parity test, `MUT/t9.json`. NOT `rules-reference.test.ts` (batch-end proof commit) | Task 3 and lane F merged (both edit `engine-db/competition.ts`), P-3 answered "A". **BLOCKED until rebase.** Parallel with C, E1, E2 |
| F (lane) | 10 migration + resolver through every caller + `w2cStageRulesSuite` | worktree `format-matrix-w2c-resolver` | `db/migration/deltas/V<next>__fixture_rules_override.sql`, `W/server/engine-db/fixture-cfg.ts`, the 10 caller files, `W/server/engine-db/__tests__/{fixture-cfg,bracket-overlay-callers,fixture-cfg-order}.test.ts`, `scripts/smoke.ts` (creates `w2cStageRulesSuite`; moves the P-2 pin `:8378-8385`), `MUT/t10.json` | Task 3. **BLOCKED until rebase** (migration number, `awarded-state.ts`). Parallel with C, E1, E2 |
| G | 11 stage rules for every sport | `WT` | `W/server/usecases/stage-rules.ts`, the division `page.tsx` (one condition), `W/server/usecases/__tests__/stage-rules{,-every-sport}.test.ts`, `scripts/smoke.ts`, `MUT/t11.json` | C, E1, E2, F merged |
| H | 12 stage creation defaults + SC-P8 + carry; 13 stage points server | `WT` | `W/server/usecases/{stages,templates,stage-defaults,stage-rules}.ts`, `W/server/api-v1/{schemas,openapi}.ts`, `openapi/*.json`, tests, `scripts/smoke.ts`, `MUT/t12.json`, `MUT/t13.json` | G, E3 merged |
| H2 | 13b delete the top-level decider overlay (Opus) | `WT` | `W/server/engine-db/stage-cfg.ts`, `W/server/engine-db/__tests__/stage-cfg.test.ts`, `W/server/usecases/__tests__/stage-rules-every-sport.test.ts` (the moved D3 case), `MUT/t13b.json` | H merged (Task 12 moved every writer to `config.rules`) |
| I | 14 the override writer + Q11 correction | `WT` | `W/server/usecases/fixture-rules.ts` (new), `W/server/engine-db/refreeze.ts` (new), `W/server/usecases/admin-fixture-config.ts`, `W/app/api/v1/fixtures/[id]/rules/route.ts` (new), `W/server/api-v1/{schemas,openapi}.ts`, `openapi/*.json`, tests, `scripts/smoke.ts`, `MUT/t14.json` | H2 merged (P-4 answered "A") |
| I2 | 15 open pads follow a correction (`FIXTURE_RULES_CHANGED`) | `WT` | `W/server/engine-db/append-event.ts` (version check), `W/server/api-v1/schemas.ts` (`rules_version`), `W/server/usecases/{fixtures,scoring}.ts`, `W/app/api/v1/fixtures/[id]/rules/route.ts` (GET added), `W/components/v2/scorepad/{transport,pipeline,use-pad-pipeline,refusal-copy}.ts`, `W/components/v2/device-score-pad.tsx` (sends the version), the pad banner component, both pad pages, `W/components/v2/__tests__/events-post-sites.test.ts` (new source scan), `W/server/usecases/__tests__/rules-version-writers.test.ts` (new), 4 × `ui.json`, `openapi/*.json`, `e2e/remote-pad-rules-w2c.spec.ts` (new), tests, `scripts/smoke.ts`, `MUT/t15.json` | I merged |
| J | 16 public labels | `WT` | `W/server/public-site/{describe-rules,stage-format-lines,data}.ts`, `W/lib/points-line.ts` (new), 4 × `public.json`, tests, `scripts/smoke.ts`, `MUT/t16.json` | I2 merged |
| K | 17 S1 + S4 (stage); 18 S3 | `WT` | `W/components/v2/{stages-panel,match-rules}.tsx`, `W/components/v2/stage-rules/*.tsx` (new), 4 × `ui.json`, `e2e/stage-rules-w2c.spec.ts` (new), `e2e/mobile.spec.ts`, `MUT/t17.json`, `MUT/t18.json` | J merged |
| L | 19 S2 + S4 (match) + run-sheet tag | `WT` | `W/components/v2/fixture-console.tsx`, `W/components/v2/match-rules-block.tsx` (new), the fixture page, `W/server/usecases/fixtures.ts` (loader), `desk/run-sheet-row.tsx`, 4 × `ui.json`, `e2e/match-rules-w2c.spec.ts` (new), `e2e/mobile.spec.ts`, `MUT/t19.json` | K merged |
| M | 20 S4 division settings; 21 S5 Armageddon pad | `WT` | `W/components/v2/division-settings.tsx`, `W/components/v2/scorepad/v3/skins/boardgame.tsx`, 4 × `ui.json`, `e2e/division-locks-w2c.spec.ts` (new), `e2e/bracket-finish.spec.ts`, `e2e/mobile.spec.ts`, `MUT/t20.json`, `MUT/t21.json` | L merged |
| N | 22 MD-1 classification | `WT` | `packages/engine/stryker-equivalent.json`, PR-body draft in `$TMPDIR` | every engine task merged |
| — orchestrator | 23 ship gates, PR, e2e dispatch, cross-programme P8 | `WT` | `IDX`, PR body | everything. The P8 step is **BLOCKED until `feat/chess-lichess-external-play` merges** |

- **Parallel groups.**
  - Before the rebase: **{A, B}**.
  - After Task 3: **{C, F}** start together. C runs Task 4 then Task 5 in `WT`, while F runs in a lane worktree. When F merges, **E3** starts in its lane (both edit `engine-db/competition.ts`). When Task 5 lands, **{E1, E2}** join: E1 in `WT`, E2 in a lane.
  - E1 and E2 are disjoint because the web presentation is one file per sport. E1 owns football, hockey, ice hockey, cricket, carrom and generic; E2 owns boardgame. Neither touches `index.ts`, `shared.ts` or `types.ts`: the `"sequence"` field kind and the abandon option table both land in Task 5 (review M12).
  - **Everything from G on is sequential.** G–N share `schemas.ts`/`openapi`, `smoke.ts`, the four dictionaries and `mobile.spec.ts`, none of which is provably disjoint.
- **Lanes** branch from `feat/format-matrix-w2c` and merge back with a merge commit (never a squash). The lane's scoped gate re-runs on the merged tree:
  ```bash
  cd /Users/ashokhein/github/seazn.club-worktrees/format-matrix-w2c && git worktree add ../format-matrix-w2c-<lane> -b feat/format-matrix-w2c-<lane> feat/format-matrix-w2c; echo EXIT=$?
  cd /Users/ashokhein/github/seazn.club-worktrees/format-matrix-w2c && git merge --no-ff feat/format-matrix-w2c-<lane> -m "Merge lane <lane> into W2c"; echo EXIT=$?
  ```
  - Each lane worktree gets its own `pnpm install --frozen-lockfile` and `.env.local` symlinks.
  - A lane edit outside its file set stops the lane (R2).
  - Lanes never write `IDX` or rules files; they report the lines, and the orchestrator commits them.
  - Lane B is cut from `WT` BEFORE the rebase, so lane B merges into `WT` before Task 3 starts. The rebase then carries it.
- **Batching** (RULES.md). Each of these pairs runs as one implementer loop (the agent split in **Execution** keeps Task 4 on Opus and Task 5 on Sonnet, so they are two loops back to back, not one):
  - Tasks 6+7: they share module files.
  - Tasks 12+13: they share `stage-rules.ts` and `schemas.ts`.
  - Tasks 17+18: they share `stages-panel.tsx`.
  - Tasks 20+21: they share only the dictionaries and `mobile.spec.ts`, so they get two reviewer sections.

## File structure

| Path | Responsibility | Task |
|---|---|---|
| `W/lib/match-rules/index.ts` (new) | the registry: `SPORT_RULES` assembled from the sport files in today's order, and every function `lib/match-rules.ts` exports today | 1 |
| `W/lib/match-rules/types.ts` (new) | `RuleField` (+ `edits`, Task 5) | 1, 5 |
| `W/lib/match-rules/shared.ts` (new) | `ownOr`, `sameShape`, `readShape`, `readNumber`, `WIN_BY` and the other helpers more than one sport uses | 1 |
| `W/lib/match-rules/{volleyball,badminton,tabletennis,tennis,football,cricket,icehockey,hockey,boardgame,carrom,generic}.ts` (new) | one sport's `RuleField[]` and its own helpers (presentation only) | 1, 5–8 |
| `W/lib/match-rules/__tests__/run-contract.ts` + `<sport>.contract.test.ts` × 11 (new) | the web P1 contract, per sport | 5 (+6–8) |
| `W/lib/rule-scope.ts` (new) | maps engine keys to web fields; `buildMatchFragment` | 5 |
| `W/lib/rule-errors.ts` (new) | the W2c code list with HTTP status and English message | 2 (+11, 13, 14, 15) |
| `W/server/usecases/rule-locks.ts` (new) | `lockedStageIdsAmong` (moved), `divisionRefusals`, `TABLE_RULE_KEYS` | 2, 5 |
| `W/server/usecases/divisions.ts` | Q3/Q4 refusals, partial save | 2 |
| `E/sport/module.ts` | `ruleKeys?`, `stageDefaults?` on `SportModule`; `RuleKeys`, `RuleKeyFact`, `RuleScope` types | 4 |
| `E/sport/rule-keys.ts` (new) | `ruleKeyApplies`, `stageKeysFor`, `fixtureKeysFor`, `pointsKeysFor`, `ruleKeyOwning`, `checkFixtureOverride` | 4 |
| `E/sports/*/<module>.ts`, `E/sports/{setbased,period}/kernel.ts` | `ruleKeys` per module / kernel | 4 (+6–8) |
| `E/sports/{football,hockey,icehockey,cricket}` | `stageDefaults`; football `shootoutAttempts` | 6 |
| `E/sports/{football,period,hockey,carrom,generic}` | abandon options | 7 |
| `E/sports/boardgame/boardgame.ts`; `E/core/errors.ts` | `tiebreakRungs`, `armageddonColours`, Armageddon `black`/`result`; `TIEBREAK_COLOUR_REQUIRED` | 8 |
| `E/competition/points.ts` | walkover-only forfeit, awardScore replaces, `pointsRuleExpressible` | 9 |
| `db/migration/deltas/V<next>__fixture_rules_override.sql`; `W/server/engine-db/fixture-cfg.ts` + 10 callers | `fixtures.rules_override`; `FixtureCfgSource` signature and order | 10 |
| `W/server/usecases/stage-rules.ts` | every sport, engine allowlist, deciders into `rules`; stage points | 11, 13 |
| `W/server/usecases/stage-defaults.ts` (new), `stages.ts`, `templates.ts`, `api-v1/schemas.ts` | defaults at both insert sites; carry merge; SC-P8 | 12 |
| `W/server/usecases/fixture-rules.ts`, `W/server/engine-db/refreeze.ts`, `W/app/api/v1/fixtures/[id]/rules/route.ts` (all new) | the one override writer, Q11, audit | 14 |
| `W/server/engine-db/append-event.ts`, `AppendEventRequest`, `W/components/v2/scorepad/{transport,pipeline,use-pad-pipeline}.ts`, `W/components/v2/scorepad/v3/rules-changed-banner.tsx` (new) | the rules version on every append; pad reload + banner | 15 |
| `W/lib/points-line.ts` (new), `W/server/public-site/{describe-rules,stage-format-lines,data}.ts` | labels for every sport, deciders, abandon, points | 16 |
| `W/components/v2/stage-rules/{stage-rules-editor,stage-points-editor,rule-lock-line}.tsx` (new), `stages-panel.tsx`, `match-rules.tsx` | S1, S3, S4 | 17, 18 |
| `W/components/v2/match-rules-block.tsx` (new), `fixture-console.tsx`, fixture page, `desk/run-sheet-row.tsx`, `usecases/fixtures.ts` | S2, S4, "Format changed" | 19 |
| `W/components/v2/division-settings.tsx` | S4 on the division | 20 |
| `W/components/v2/scorepad/v3/skins/boardgame.tsx` | S5 | 21 |
| `apps/web/e2e/{stage-rules-w2c,match-rules-w2c,division-locks-w2c}.spec.ts` (new), `e2e/bracket-finish.spec.ts`, `e2e/mobile.spec.ts` | e2e + widths | 17–21 |
| `scripts/smoke.ts` (`w2cStageRulesSuite`) | smoke | 10–16 |
| `MUT/t<N>.json` | hand mutants per task | every code task |

---

## Tasks

Every task below lists:
- its **four test types** (unit / e2e / smoke / regression), or N/A with the reason;
- its **sequence cases**, empty first;
- its **mutation step**;
- its **verify command**.

The orchestrator records `TASK_BASE=$(git rev-parse HEAD)` before dispatching each task.

---

### Task 0: Orchestrator — setup, owner questions, rule-row signing

**Files:**
- Create: `docs/superpowers/specs/2026-09-27-format-matrix-prompts/mutants/w2c/.gitkeep`
- Modify (gitignored, not committed): `/Users/ashokhein/github/seazn.club/.superpowers/handoff/2026-10-12-w2c/w2c-state.md`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - P-1..P-5 recorded verbatim in `w2c-state.md` (all already answered; see **Owner answers and open questions**);
  - the signed wording of every rule row in **Appendix A (as amended by this plan)**;
  - the `MUT` directory that every later task writes `t<N>.json` into.

- [ ] **Step 1: Set up the worktree**

```bash
cd /Users/ashokhein/github/seazn.club-worktrees/format-matrix-w2c && pnpm install --frozen-lockfile; echo EXIT=$?
cd /Users/ashokhein/github/seazn.club-worktrees/format-matrix-w2c && ln -sf /Users/ashokhein/github/seazn.club/.env.local .env.local && ln -sf /Users/ashokhein/github/seazn.club/apps/web/.env.local apps/web/.env.local && readlink -f node_modules/@seazn/engine; echo EXIT=$?
```
Expected: `EXIT=0` twice, and the engine path starts with `/Users/ashokhein/github/seazn.club-worktrees/format-matrix-w2c/`.

- [ ] **Step 2: Record P-1..P-5.**
  - Copy the owner's P-1..P-5 answers (as given to the orchestrator in chat, 2026-10-13) and the execution ruling into `w2c-state.md` under "Plan-time answers", verbatim, if they are not already there.
  - No question is asked here: every plan-time question is answered.
  - Do NOT re-ask ruling 74 (settled by Q7 "B", review M10) or the S1 layout (the owner chose "A", review M8).

- [ ] **Step 3: Sign the rule rows.**
  - Show the owner **Appendix A (as amended)** at the end of this plan. It carries the corrected ids (finding 6): `CK-SO-1` not `CR-SO-1`; `CA-AB-2` not `CM-AB-1`; and `GN-AB-2`, because `GN-AB-1` already exists on W2b.
  - Record the signed wording verbatim in `w2c-state.md`.
  - The rows are written into `packages/engine/rules/*.md` in Task 3, not now: three of the files (`hockey.md`, `icehockey.md`, `football.md`) exist only on W2b (finding 5; review M11).

- [ ] **Step 4: Create the mutant directory and commit**

```bash
cd /Users/ashokhein/github/seazn.club-worktrees/format-matrix-w2c && mkdir -p docs/superpowers/specs/2026-09-27-format-matrix-prompts/mutants/w2c && touch docs/superpowers/specs/2026-09-27-format-matrix-prompts/mutants/w2c/.gitkeep && git add docs/superpowers/specs/2026-09-27-format-matrix-prompts/mutants/w2c/.gitkeep && git commit -F "$TMPDIR/w2c-msg.txt" -- docs/superpowers/specs/2026-09-27-format-matrix-prompts/mutants/w2c/.gitkeep; echo EXIT=$?
```
Write the message with the Write tool first: `chore(w2c): mutant directory`, then a blank line, then the `Co-Authored-By:` line.

**Test types:** all N/A, because this task writes no product code.

---

### Task 1: Split `lib/match-rules.ts` per sport — a pure move (web, pre-rebase)

Owner, 2026-10-13 ("Ok"); spec §4.1 as amended. **No behaviour change.** The file is 1,062 lines. It becomes one presentation file per sport plus a registry, `apps/web/src/lib/match-rules/index.ts`, that re-exports today's whole public API, so all 15 importers keep working untouched.

**Files:**
- Move: `apps/web/src/lib/match-rules.ts` → `apps/web/src/lib/match-rules/index.ts` (`git mv` first, so history follows the registry), then cut it into:
  - Create: `apps/web/src/lib/match-rules/types.ts`: `RuleField`, verbatim from `:17-70`.
  - Create: `apps/web/src/lib/match-rules/shared.ts`: `ownOr`, `sameShape`, `readShape`, `readNumber`, `WIN_BY`, and every other helper used by more than one sport file. `rulesFor` stays private in `index.ts`.
  - Create: `apps/web/src/lib/match-rules/best-of-one.ts`: `SINGLE_SET_POINTS_LABEL`, `showsOnePointsField`, `alignBestOfOnePoints` (`:800-912`), the cross-sport best-of-1 logic.
  - Create one file per sport, each exporting its `RuleField[]` and the helpers only it uses:
    - `apps/web/src/lib/match-rules/volleyball.ts` (`VOLLEYBALL_RULES`);
    - `badminton.ts` (`BADMINTON_RULES`);
    - `tabletennis.ts` (`TABLETENNIS_RULES`);
    - `tennis.ts` (`TENNIS_RULES`, `TENNIS_SET_SHAPES`);
    - `football.ts` (`FOOTBALL_RULES`, `shootoutPointsPatch`);
    - `cricket.ts` (`CRICKET_RULES`);
    - `icehockey.ts` (`ICEHOCKEY_RULES`);
    - `hockey.ts` (`HOCKEY_RULES`);
    - `boardgame.ts` (`BOARDGAME_RULES`);
    - `carrom.ts` (`CARROM_RULES`);
    - `generic.ts` (`GENERIC_RULES`).
  - `index.ts` keeps, verbatim, everything else that `lib/match-rules.ts` exports today, and re-exports `RuleField` and the best-of-1 trio.
- Create then DELETE (never committed): `apps/web/src/lib/__tests__/split-equality.tmp.test.ts`
- Do NOT touch: any importer. `components/v2/match-rules.tsx:16-23` keeps re-exporting from `@/lib/match-rules`, which now resolves to the directory's `index.ts`. No field, label, order, value or comment changes.

**Interfaces:**
- Consumes: nothing.
- Produces: exactly today's public API at `@/lib/match-rules`:
  - `RuleField`, `SPORT_RULES`, `SINGLE_SET_POINTS_LABEL`, `showsOnePointsField`, `visibleRuleFields`, `setRuleValue`, `alignBestOfOnePoints`, `buildRuleOverride`, `hydrateRuleValues`, `STAGE_RULES_SPORTS`, `keysEmittedBy`, `configKeysFor`, `ruleOptionLabel`, `borrowOptionLabel`.

  New, for Tasks 5–8:
  - the per-sport constants named above, importable from `@/lib/match-rules/<sport>`;
  - `@/lib/match-rules/types`.

- [ ] **Step 1: Write the equality probe and dump the BEFORE state**

`apps/web/src/lib/__tests__/split-equality.tmp.test.ts`:

```ts
// One-off proof that the split is a pure move (owner 2026-10-13). Dumps the
// observable shape of SPORT_RULES — sport order, field order, every declared
// property, the SOURCE TEXT of every function, and each build() output for
// every probe value — plus the module's export list. Run before and after;
// the two dumps must be byte-identical. Deleted before the commit.
import { writeFileSync } from "node:fs";
import { it, expect } from "vitest";
import * as api from "@/lib/match-rules";
import type { RuleField } from "@/lib/match-rules";

const probes = (f: RuleField): string[] =>
  f.kind === "select" ? (f.options ?? []).map((o) => o.value) : f.kind === "bool" ? ["on", "off"] : [String(f.min ?? 1), String(f.max ?? 1)];

it("dumps the match-rules surface", () => {
  const out = {
    exports: Object.keys(api).sort(),
    stageRulesSports: [...api.STAGE_RULES_SPORTS],
    singleSetLabel: api.SINGLE_SET_POINTS_LABEL,
    sports: Object.entries(api.SPORT_RULES).map(([sport, fields]) => ({
      sport,
      fields: fields.map((f) => ({
        key: f.key, label: f.label, help: f.help ?? null, kind: f.kind,
        min: f.min ?? null, max: f.max ?? null, options: f.options ?? null,
        build: String(f.build), buildOnBlank: f.buildOnBlank ? String(f.buildOnBlank) : null, read: f.read ? String(f.read) : null,
        built: probes(f).map((v) => ({ v, out: f.build(v, {}), blank: f.buildOnBlank?.({}) ?? null })),
      })),
    })),
  };
  const fieldCount = out.sports.reduce((n, s) => n + s.fields.length, 0);
  expect(out.sports.length).toBe(11);
  expect(fieldCount).toBeGreaterThan(0);
  writeFileSync(process.env.SPLIT_DUMP!, JSON.stringify(out, null, 1));
});
```

```bash
cd /Users/ashokhein/github/seazn.club-worktrees/format-matrix-w2c/apps/web && SPLIT_DUMP="$TMPDIR/w2c-split-before.json" npx vitest run src/lib/__tests__/split-equality.tmp.test.ts --reporter=json --outputFile="$TMPDIR/w2c-t1-before.json"; echo EXIT=$?
```
Expected: `EXIT=0`, the judge shows `passed == total == 1`, and `$TMPDIR/w2c-split-before.json` exists and is non-empty (`wc -c`).

- [ ] **Step 2: Record the regression baseline (existing suites, unchanged)**

```bash
cd /Users/ashokhein/github/seazn.club-worktrees/format-matrix-w2c/apps/web && rm -f "$TMPDIR/w2c-t1.json" && npx vitest run src/lib/__tests__/match-rules-best-of-one.test.ts src/lib/__tests__/match-rules-config-keys.test.ts src/lib/__tests__/match-rules-hydrate.test.ts src/lib/__tests__/match-rules-labels.test.ts src/components/v2/__tests__/match-rules-best-of-one.test.tsx src/components/v2/__tests__/match-rules-unofferable-value.test.tsx src/components/v2/__tests__/stages-panel-stage-format.test.tsx src/server/public-site/__tests__/describe-rules.test.ts src/server/usecases/__tests__/stage-rules.test.ts --reporter=json --outputFile="$TMPDIR/w2c-t1.json"; echo EXIT=$?
```
Record the judge line: `files == 9`, `pending == 0` (`stage-rules.test.ts` is a DB suite). These nine are every vitest importer of `@/lib/match-rules` (Step 0 anchors).

- [ ] **Step 3: Move.**
  - `git mv apps/web/src/lib/match-rules.ts apps/web/src/lib/match-rules/index.ts`.
  - Cut each block verbatim into the files listed above, and import it back into `index.ts`. `SPORT_RULES` becomes an object literal of the per-sport constants, **in today's key order**: football, cricket, volleyball, badminton, tabletennis, tennis, icehockey, hockey, boardgame, carrom, generic. Read the order off the file; the dump enforces it.
  - Moved code keeps its comments. Sport files import shared helpers from `./shared` and the type from `./types`; nothing imports `./index` except consumers outside the directory.

- [ ] **Step 4: Prove the move.**

```bash
cd /Users/ashokhein/github/seazn.club-worktrees/format-matrix-w2c/apps/web && SPLIT_DUMP="$TMPDIR/w2c-split-after.json" npx vitest run src/lib/__tests__/split-equality.tmp.test.ts --reporter=json --outputFile="$TMPDIR/w2c-t1-after.json"; echo EXIT=$?; cmp "$TMPDIR/w2c-split-before.json" "$TMPDIR/w2c-split-after.json" && echo IDENTICAL
```
Expected: `EXIT=0` and `IDENTICAL`. A `cmp` difference is a defect of the move: fix the move and never edit the probe. Then:
- re-run Step 2's command and judge it equal to the baseline (same `total`, `failed == 0`);
- web `tsc`, which covers `e2e/` too (`apps/web/tsconfig.json` includes `**/*.ts`), `EXIT=0`;
- eslint on `src/lib/match-rules/`, `EXIT=0`.

- [ ] **Step 5: Mutate once.** A pure move adds no guard. Its one claim is "the registry keeps today's order", so prove the probe can witness a moved field:

`MUT/t1.json`:
```json
[
  { "id": "t1-order", "file": "apps/web/src/lib/match-rules/index.ts",
    "find": "  football: FOOTBALL_RULES,\n  cricket: CRICKET_RULES,", "replace": "  cricket: CRICKET_RULES,\n  football: FOOTBALL_RULES,",
    "killers": [{ "cwd": "apps/web", "files": ["src/lib/__tests__/match-rules-labels.test.ts", "src/lib/__tests__/match-rules-hydrate.test.ts"], "name": "." }] }
]
```
Run the mutate command.
- If no existing suite kills the reorder, `SURVIVED` is a FINDING, not a failure of this task: today's tests do not pin sport order.
- Record the finding, re-run Step 4's dump with the mutation applied by hand to show that `cmp` catches it, then restore the file.
- The probe is the witness for this task. Field order WITHIN a sport is pinned by the Task 5 contract tests, not by a test added here.

- [ ] **Step 6: Delete the probe and commit.**

```bash
cd /Users/ashokhein/github/seazn.club-worktrees/format-matrix-w2c && rm apps/web/src/lib/__tests__/split-equality.tmp.test.ts && git add -A apps/web/src/lib/match-rules apps/web/src/lib/match-rules.ts docs/superpowers/specs/2026-09-27-format-matrix-prompts/mutants/w2c/t1.json && git commit -F "$TMPDIR/w2c-msg.txt" -- apps/web/src/lib/match-rules apps/web/src/lib/match-rules.ts docs/superpowers/specs/2026-09-27-format-matrix-prompts/mutants/w2c/t1.json; echo EXIT=$?
```
Message: `refactor(match-rules): split per sport behind a registry (pure move)`. The body pastes the `IDENTICAL` line and both judge lines.

**Test types:**
- Unit: the nine existing suites, unchanged and green, plus the one-off dump equality.
- E2E: N/A. No markup or route changes. `tsc` compiles `e2e/walkthrough/stage-rules-start-promotion.spec.ts` against the registry.
- Smoke: N/A. No server behaviour changes.
- Regression: Step 2's baseline equals Step 4's run.

**Sequence cases:** N/A for a pure move. The dump probes every option value of every field, including min and max for numbers.

---
### Task 2: Division locks by name — server (lane B, pre-rebase; owner P-2 "A")

Implements item 4 (Q3, Q4), D11, X-SR-4, as the owner answered P-2 "A": the `patchDivision` config lock LOOSENS to per started inheriting stage; `tiebreakers` GAINS the lock; `replaceStages`' `FORMAT_LOCKED` is untouched. Includes review I1 (re-parse after restore; a refused variant drops its preset keys) and I2 (the pins this turns red).

**Files:**
- Create: `apps/web/src/server/usecases/rule-locks.ts` (`lockedStageIdsAmong` moves here unchanged; `stage-rules.ts` imports it)
- Create: `apps/web/src/lib/rule-errors.ts`
- Modify: `apps/web/src/server/usecases/divisions.ts:795-856` (config branch) and `:899` (tiebreakers)
- Modify: `apps/web/src/server/usecases/stage-rules.ts:40-58` (delete the moved function; add an import)
- Modify: `apps/web/src/server/usecases/__tests__/division-settings.test.ts:586-640` (F2b pin: rewrite the `patchDivision` half only) and `:726-738` (review I2: it pins the whole-config `FORMAT_LOCKED` after generation; it now starts a fixture first and expects the named code, or expects success when nothing has started — whichever its title promises)
- NOT here: the smoke pin `scripts/smoke.ts:8378-8385` (same whole-config `FORMAT_LOCKED`). `smoke.ts` is a W2b file, so Task 10 (lane F, after the rebase) rewrites it; until then smoke is red on that one check, which is acceptable because smoke runs on PRs only and the PR opens in Task 23
- Create: `apps/web/src/server/usecases/__tests__/division-locks.test.ts`
- Create: `MUT/t2.json`
- Do NOT touch: `stages.ts` (`replaceStages`' `FORMAT_LOCKED` stays, spec §4.3), `schemas.ts`/`openapi` (W2b edits them; the response's `refused` field reaches OpenAPI in Task 12), any UI.

**Interfaces:**
- Consumes: `lockedStageIdsAmong(tx, ids)` (moved, unchanged semantics: started = `config_snapshot` set OR any `score_events`).
- Produces:
  ```ts
  // lib/rule-errors.ts — client-safe
  export const RULE_ERROR_STATUS = {
    STAGE_FORMAT_LOCKED: 409, DIVISION_TABLE_RULES_LOCKED: 409, DIVISION_FORMAT_LOCKED: 409,
    FIXTURE_FORMAT_LOCKED: 409, FORMAT_DOES_NOT_FIT_PLAY: 409, RULE_NOT_SETTABLE: 400,
    POINTS_RULE_INEXPRESSIBLE: 422,
  } as const;
  export type RuleErrorCode = keyof typeof RULE_ERROR_STATUS;
  export function ruleErrorMessage(code: RuleErrorCode, p: { stage?: string; field?: string; reason?: string }): string; // English, = the en dictionary sentence
  // usecases/rule-locks.ts
  export const TABLE_RULE_KEYS: ReadonlySet<string>; // "points", "pointsMap"
  export interface RefusedField { field: string; code: "DIVISION_FORMAT_LOCKED" | "DIVISION_TABLE_RULES_LOCKED"; stageId: string; stageName: string }
  export async function lockedStageIdsAmong(tx: postgres.TransactionSql, ids: readonly string[]): Promise<Set<string>>;
  export async function divisionRefusals(tx, divisionId: string, change: { configKeys: readonly string[]; variant: boolean; tiebreakers: boolean }): Promise<RefusedField[]>;
  // divisions.ts — patchDivision's return gains: refused: RefusedField[]  (always present, [] when nothing refused)
  ```

- [ ] **Step 1: Write the failing test** — `division-locks.test.ts`

```ts
// X-SR-4 — division table rules and match format lock per STARTED INHERITING
// stage (Q3, Q4; plan D12). P4's lock sequence for the division (spec §9).
import { afterAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { sql } from "@/lib/db";
import { invalidateOrgEntitlements } from "@/lib/entitlements";
import { setOrgPlan } from "@/lib/__tests__/_billing-group";
import type { AuthCtx } from "@/server/api-v1/auth";
import { appendEvent, resolveLatestModule } from "@/server/engine-db";
import { createCompetition } from "../competitions";
import { createDivision, getDivision, patchDivision } from "../divisions";
import { createEntrants } from "../entrants";
import { createStages, generateStageFixtures } from "../stages";
import { putStageRules } from "../stage-rules";

const HAS_DB = !!process.env.DATABASE_URL;
afterAll(async () => { await (globalThis as { _sql?: { end(): Promise<void> } })._sql?.end(); });

async function seedOrg(): Promise<AuthCtx> {
  const s = randomUUID().slice(0, 8);
  const [{ id: orgId }] = await sql<{ id: string }[]>`insert into organizations (name, slug) values (${"Dl " + s}, ${"dl-" + s}) returning id`;
  await setOrgPlan(orgId, "pro");
  await invalidateOrgEntitlements(orgId);
  return { orgId, via: "session", userId: null, role: "owner", keyId: null };
}

/** Two league stages, 2 entrants each in one division; stage 1 generated. */
async function rig(sport: string, variant: string) {
  const auth = await seedOrg();
  const comp = await createCompetition(auth, { ends_on: "2030-12-31", name: "Dl " + randomUUID().slice(0, 6), visibility: "private", branding: {} });
  const d = await createDivision(auth, comp.id, { name: "Open", slug: "o-" + randomUUID().slice(0, 6), sport_key: sport, variant_key: variant, config: {} });
  await createEntrants(auth, d.id, [1, 2].map((i) => ({ kind: "individual" as const, display_name: `E${i}`, seed: i, members: [] })));
  const [s1] = await createStages(auth, d.id, { seq: 1, kind: "league", name: "Pool A", config: {}, progression: null });
  const [s2] = await createStages(auth, d.id, { seq: 2, kind: "league", name: "Pool B", config: {}, progression: null });
  await generateStageFixtures(auth, s1!.id);
  const [f] = await sql<{ id: string }[]>`select id from fixtures where stage_id = ${s1!.id} order by id limit 1`;
  return { auth, divisionId: d.id, s1: s1!, s2: s2!, fixtureId: f!.id };
}
const start = (auth: AuthCtx, fixtureId: string) => appendEvent(auth.orgId, fixtureId, 0, { type: "core.start", payload: {} });

describe.skipIf(!HAS_DB)("X-SR-4 division locks per started inheriting stage", () => {
  it("empty patch on a started division: saves, refuses nothing", async () => {
    const r = await rig("badminton", "short");
    await start(r.auth, r.fixtureId);
    const out = await patchDivision(r.auth, r.divisionId, {});
    expect(out.refused).toEqual([]);
  });

  it("generated but NOT started: a match-format change saves (the old division-wide FORMAT_LOCKED narrowed, P-2 A)", async () => {
    const r = await rig("badminton", "short");
    const before = await getDivision(r.auth, r.divisionId);
    const out = await patchDivision(r.auth, r.divisionId, { config: { ...(before.config as object), setTo: 15 } });
    expect(out.refused).toEqual([]);
    expect((out.config as { setTo: number }).setTo).toBe(15);
  });

  it("started inheriting stage: match format refused DIVISION_FORMAT_LOCKED naming the stage; another field still saves", async () => {
    const r = await rig("badminton", "short");
    await start(r.auth, r.fixtureId);
    const before = await getDivision(r.auth, r.divisionId);
    const out = await patchDivision(r.auth, r.divisionId, { name: "Renamed", config: { ...(before.config as object), setTo: 15 } });
    expect(out.name).toBe("Renamed");
    expect(out.refused).toEqual([{ field: "setTo", code: "DIVISION_FORMAT_LOCKED", stageId: r.s1.id, stageName: "Pool A" }]);
    expect((out.config as { setTo: number }).setTo).toBe((before.config as { setTo: number }).setTo);
  });

  it("a started stage that sets the key itself does not inherit it: the division change saves", async () => {
    const r = await rig("badminton", "short");
    await putStageRules(r.auth, r.s1.id, { rules: { setTo: 11 } });
    await start(r.auth, r.fixtureId);
    const before = await getDivision(r.auth, r.divisionId);
    const out = await patchDivision(r.auth, r.divisionId, { config: { ...(before.config as object), setTo: 15 } });
    expect(out.refused).toEqual([]);
  });

  it("table rules: tiebreakers refused DIVISION_TABLE_RULES_LOCKED once a stage started (Q3; unlocked before W2c)", async () => {
    const r = await rig("badminton", "short");
    await start(r.auth, r.fixtureId);
    const out = await patchDivision(r.auth, r.divisionId, { name: "N2", tiebreakers: ["head_to_head", "points_diff"] as never });
    expect(out.refused).toEqual([{ field: "tiebreakers", code: "DIVISION_TABLE_RULES_LOCKED", stageId: r.s1.id, stageName: "Pool A" }]);
  });

  it("only refused fields in the patch: 409 with the first refusal's code and the whole list", async () => {
    const r = await rig("badminton", "short");
    await start(r.auth, r.fixtureId);
    await expect(patchDivision(r.auth, r.divisionId, { tiebreakers: ["head_to_head"] as never })).rejects.toMatchObject({
      status: 409, code: "DIVISION_TABLE_RULES_LOCKED", extra: { refused: [{ field: "tiebreakers", stageName: "Pool A" }] },
    });
  });

  it("after the only event is voided the stage is still started (score_events exist): still refused", async () => {
    const r = await rig("badminton", "short");
    await start(r.auth, r.fixtureId);
    // Void by the real event id (ids are UUIDs; the engine refuses an unknown target, core/events.ts:296).
    const [{ id: startId }] = await sql<{ id: string }[]>`select id from score_events where fixture_id = ${r.fixtureId} and type = 'core.start'`;
    const v = await appendEvent(r.auth.orgId, r.fixtureId, 1, { type: "core.void", payload: {}, voids: startId });
    expect(v.event.voids).toBe(startId);                                   // the void landed
    await expect(patchDivision(r.auth, r.divisionId, { tiebreakers: ["head_to_head"] as never })).rejects.toMatchObject({ code: "DIVISION_TABLE_RULES_LOCKED" });
  });

  it("second call: re-sending the stored value is not a change and is not refused", async () => {
    const r = await rig("badminton", "short");
    await start(r.auth, r.fixtureId);
    const before = await getDivision(r.auth, r.divisionId);
    const out = await patchDivision(r.auth, r.divisionId, { config: before.config as never });
    expect(out.refused).toEqual([]);
  });

  it("another sport: a generic division's points (table rules) refused while a pool has started", async () => {
    const r = await rig("generic", "score");
    await start(r.auth, r.fixtureId);
    const before = await getDivision(r.auth, r.divisionId);
    const cfg = before.config as { points: Record<string, number> };
    await expect(patchDivision(r.auth, r.divisionId, { config: { ...cfg, points: { ...cfg.points, w: 2 } } })).rejects.toMatchObject({ code: "DIVISION_TABLE_RULES_LOCKED" });
  });

  it("variant change refused DIVISION_FORMAT_LOCKED when any stage started", async () => {
    const r = await rig("generic", "score");
    await start(r.auth, r.fixtureId);
    await expect(patchDivision(r.auth, r.divisionId, { variant_key: "win_loss" })).rejects.toMatchObject({ code: "DIVISION_FORMAT_LOCKED" });
  });

  it("I1: a refused variant also drops its preset keys — the stored config is byte-for-byte the old one", async () => {
    const r = await rig("generic", "score");
    await start(r.auth, r.fixtureId);
    const before = await getDivision(r.auth, r.divisionId);
    const out = await patchDivision(r.auth, r.divisionId, { name: "Renamed", variant_key: "win_loss" });
    expect(out.name).toBe("Renamed");
    expect(out.variant_key).toBe(before.variant_key);
    expect(out.config).toEqual(before.config);              // no preset key of "win_loss" (resultMode, allowDraws) leaked through
    // Every key the requested variant would have changed is listed, each under the started stage.
    const m = resolveLatestModule("generic");
    const fromVariant = Object.keys(m.variants["win_loss"] ?? {}).filter((k) => JSON.stringify((m.variants["win_loss"] as Record<string, unknown>)[k]) !== JSON.stringify((before.config as Record<string, unknown>)[k]));
    expect(fromVariant.length, "generic 'win_loss' differs from 'score' on at least one key").toBeGreaterThan(0);
    for (const k of fromVariant) expect(out.refused).toContainEqual(expect.objectContaining({ field: k, stageName: "Pool A" }));
    expect(out.refused).toContainEqual(expect.objectContaining({ field: "variant_key" }));
  });

  it("I1: the config left after restoring refused keys is parsed again — an invalid mix is CONFIG_INVALID and nothing is written", async () => {
    const r = await rig("badminton", "short");
    const m = resolveLatestModule("badminton");
    const before = (await getDivision(r.auth, r.divisionId)).config as Record<string, unknown> & { setTo: number; finalSetTo: number };
    // The kernel refines cap >= max(setTo, finalSetTo) (setbased/kernel.ts:129). Pool A sets `cap` itself (so cap is NOT inherited and saves) but inherits setTo (refused once started).
    await putStageRules(r.auth, r.s1.id, { rules: { cap: before.cap } });
    await start(r.auth, r.fixtureId);
    const requested = { ...before, setTo: before.setTo - 4, finalSetTo: before.finalSetTo - 4, cap: before.setTo - 2 };
    const restored = { ...before, cap: before.setTo - 2 };
    // Preconditions from the engine's own schema, so the case cannot pass vacuously:
    expect(m.configSchema.safeParse(requested).success, "the requested pair is valid").toBe(true);
    expect(m.configSchema.safeParse(restored).success, "the restored mix is invalid (cap below setTo)").toBe(false);
    await expect(patchDivision(r.auth, r.divisionId, { config: requested })).rejects.toMatchObject({ status: 422, code: "CONFIG_INVALID" });
    expect((await getDivision(r.auth, r.divisionId)).config).toEqual(before);
  });
});
```

The `rig` uses `badminton/short` and `generic/score`. Before Step 2, the implementer confirms both variant keys exist (`select key from sport_variants where sport_key in ('badminton','generic')`). If a key differs, they use the declared one through `declaredVariant` (`engine-db/__tests__/helpers/seed-bracket.ts`), never a guessed literal.

- [ ] **Step 2: Run it to verify it fails.** Expected red: the "not started" and "sets the key itself" cases fail with `FORMAT_LOCKED` thrown (today's division-wide lock), and the `refused` assertions fail with `undefined`. Command:
`cd /Users/ashokhein/github/seazn.club-worktrees/format-matrix-w2c-divlock/apps/web && rm -f "$TMPDIR/w2c-t2.json" && npx vitest run src/server/usecases/__tests__/division-locks.test.ts --reporter=json --outputFile="$TMPDIR/w2c-t2.json"; echo EXIT=$?`

- [ ] **Step 3: Implement.**

`rule-locks.ts`:

```ts
import "server-only";
import type postgres from "postgres";

/** Division config keys that are TABLE rules (Q3); every other key is match format (Q4).
 *  A literal until Task 5, which derives it from the engine (`pointsKeysFor` ∪ {"pointsMap"}, D11). */
export const TABLE_RULE_KEYS: ReadonlySet<string> = new Set(["points", "pointsMap"]);

export interface RefusedField {
  field: string;
  code: "DIVISION_FORMAT_LOCKED" | "DIVISION_TABLE_RULES_LOCKED";
  stageId: string;
  stageName: string;
}

// lockedStageIdsAmong — moved verbatim from stage-rules.ts:40 (no behaviour change).

export async function divisionRefusals(
  tx: postgres.TransactionSql,
  divisionId: string,
  change: { configKeys: readonly string[]; variant: boolean; tiebreakers: boolean },
): Promise<RefusedField[]> {
  if (change.configKeys.length === 0 && !change.variant && !change.tiebreakers) return [];
  const stages = await tx<{ id: string; name: string; seq: number; config: Record<string, unknown> | null }[]>`
    select id, name, seq, config from stages where division_id = ${divisionId} order by seq`;
  const started = await lockedStageIdsAmong(tx, stages.map((s) => s.id));
  const live = stages.filter((s) => started.has(s.id));
  const out: RefusedField[] = [];
  const first = (pred: (s: (typeof live)[number]) => boolean) => live.find(pred);
  if (change.variant) {
    const s = first(() => true);
    if (s) out.push({ field: "variant_key", code: "DIVISION_FORMAT_LOCKED", stageId: s.id, stageName: s.name });
  }
  if (change.tiebreakers) {
    const s = first(() => true); // W2d owns per-stage cascades; until then every stage inherits them
    if (s) out.push({ field: "tiebreakers", code: "DIVISION_TABLE_RULES_LOCKED", stageId: s.id, stageName: s.name });
  }
  for (const key of change.configKeys) {
    const table = TABLE_RULE_KEYS.has(key);
    const s = first((st) => {
      const cfg = st.config ?? {};
      if (table) return cfg.points == null;                       // a stage PointsRule replaces division points
      const rules = (cfg.rules ?? {}) as Record<string, unknown>;
      return rules[key] === undefined;                             // the stage inherits this key
    });
    if (s) out.push({ field: key, code: table ? "DIVISION_TABLE_RULES_LOCKED" : "DIVISION_FORMAT_LOCKED", stageId: s.id, stageName: s.name });
  }
  return out;
}
```

In `patchDivision` (`divisions.ts:795-856`), replace the `locked` query and every `formatLocked()` throw with:
1. Compute `changedKeys`: the top-level keys where `canonicalJson(finalConfig[k]) !== canonicalJson(current.config[k])`, excluding `entrants` (its existing door). Compute `variantChanged = patch.variant_key !== undefined && patch.variant_key !== current.variant_key`. Re-sending the current variant still resets config to the preset, so it is treated as a change of every preset key that differs: `changedKeys` already captures those.
2. Compute `tiebreakersChanged = patch.tiebreakers !== undefined && canonicalJson(patch.tiebreakers) !== canonicalJson(currentTiebreakers)`.
3. Call `refused = await divisionRefusals(tx, id, {configKeys: changedKeys, variant: variantChanged, tiebreakers: tiebreakersChanged})`.
4. For each refused config key, restore `finalConfig[k] = current.config[k]` (delete it when absent). If `variant_key` is refused, keep `current.variant_key` AND restore every key the requested variant's preset changed (`presetDelta = keys where variants[requested][k] differs from current.config[k]`), adding each to `refused` under the same stage (review I1). If `tiebreakers` is refused, drop it from the write.
4a. **Re-parse the final config** with `module.configSchema` (review I1). A failure throws the existing `422 CONFIG_INVALID` and nothing is written: a restore must never store a combination nobody validated.

   Items 4 and 4a are written with these literal lines, which `MUT/t2.json`'s `find` strings address (re-review minor):
   ```ts
   const presetDelta = Object.keys(requestedPreset).filter((k) => canonicalJson(requestedPreset[k]) !== canonicalJson(current.config[k]));
   for (const k of presetDelta) {
     restoreKey(finalConfig, current.config, k);
     refused.push({ field: k, code: "DIVISION_FORMAT_LOCKED", stageId: variantRefusal.stageId, stageName: variantRefusal.stageName });
   }
   const reparsed = module.configSchema.safeParse(finalConfig);
   if (!reparsed.success) throw new HttpError(422, reparsed.error.issues[0]?.message ?? "Invalid config", "CONFIG_INVALID");
   ```
   `restoreKey` sets `finalConfig[k] = current.config[k]`, or deletes the key when `current.config` lacks it. `variantRefusal` is the `variant_key` entry of `refused`.
5. If the patch has NO accepted change left (every changed field refused and no other column in `patch`), throw `new HttpError(409, ruleErrorMessage(refused[0].code, {stage: refused[0].stageName, field: refused[0].field}), refused[0].code, { refused })`.
6. Return `{...row, refused}`.

The CONFIG_INVALID branch keeps its 422 (the old "409 before 422 while locked" precedence was about the division-wide lock, which no longer exists for unstarted divisions). The existing tests at `division-settings.test.ts:404` and `:522` that pinned `FORMAT_LOCKED` on a generated-but-unstarted division are re-read. Each one either starts a fixture first (and then expects the named code) or now expects success, whichever its title promises. The F2b block at `:586-640` keeps its `replaceStages` assertion and replaces its `patchDivision` assertion with the narrowed behaviour, retitled "F2b — replaceStages stays division-wide; patchDivision narrowed to started inheriting stages (W2c X-SR-4)".

`rule-errors.ts` English messages (spec §7, verbatim):

```ts
const EN: Record<RuleErrorCode, (p: { stage?: string; field?: string; reason?: string }) => string> = {
  STAGE_FORMAT_LOCKED: (p) => `${p.stage} has started — its rules are locked.`,
  DIVISION_TABLE_RULES_LOCKED: (p) => `${p.stage} has started — table rules are locked.`,
  DIVISION_FORMAT_LOCKED: (p) => `${p.stage} has started; its match format is locked. Change individual unstarted matches instead.`,
  FIXTURE_FORMAT_LOCKED: () => "This match is finished — its format is locked.",
  FORMAT_DOES_NOT_FIT_PLAY: (p) => p.reason ?? "The recorded play does not fit this format.",
  RULE_NOT_SETTABLE: (p) => `${p.field} can't be set here${p.reason ? ` — ${p.reason}` : ""}.`,
  POINTS_RULE_INEXPRESSIBLE: (p) => `These points can't be set per stage yet — ${p.reason}.`,
};
export const ruleErrorMessage = (code: RuleErrorCode, p: { stage?: string; field?: string; reason?: string }) => EN[code](p);
```

- [ ] **Step 4: Run** `division-locks.test.ts`, `division-settings.test.ts` (incl. the rewritten `:586-640` and `:726-738` pins) and `stage-rules.test.ts` (it imports the moved function) → judge `files == 3`, green, `pending == 0`. Then `tsc` and eslint on the changed files. If the I1 re-parse case's second precondition fails, the set kernel has no cap-versus-setTo refinement: read its `superRefine` and rebuild the pair from a refinement it DOES declare (the case must stay non-vacuous), and record that as a task note.

- [ ] **Step 5: Mutate once** — `MUT/t2.json`:

```json
[
  { "id": "t2-inherit-format", "file": "apps/web/src/server/usecases/rule-locks.ts",
    "find": "return rules[key] === undefined;", "replace": "return true;",
    "killers": [{ "cwd": "apps/web", "files": ["src/server/usecases/__tests__/division-locks.test.ts"], "name": "sets the key itself does not inherit" }] },
  { "id": "t2-tiebreak-lock", "file": "apps/web/src/server/usecases/rule-locks.ts",
    "find": "if (change.tiebreakers) {", "replace": "if (false) {",
    "killers": [{ "cwd": "apps/web", "files": ["src/server/usecases/__tests__/division-locks.test.ts"], "name": "table rules: tiebreakers refused" }] },
  { "id": "t2-started-only", "file": "apps/web/src/server/usecases/rule-locks.ts",
    "find": "const live = stages.filter((s) => started.has(s.id));", "replace": "const live = stages;",
    "killers": [{ "cwd": "apps/web", "files": ["src/server/usecases/__tests__/division-locks.test.ts"], "name": "generated but NOT started" }] },
  { "id": "t2-reparse", "file": "apps/web/src/server/usecases/divisions.ts",
    "find": "const reparsed = module.configSchema.safeParse(finalConfig);", "replace": "const reparsed = { success: true as const, data: finalConfig };",
    "killers": [{ "cwd": "apps/web", "files": ["src/server/usecases/__tests__/division-locks.test.ts"], "name": "I1: the config left after restoring" }] },
  { "id": "t2-variant-preset", "file": "apps/web/src/server/usecases/divisions.ts",
    "find": "for (const k of presetDelta)", "replace": "for (const k of [])",
    "killers": [{ "cwd": "apps/web", "files": ["src/server/usecases/__tests__/division-locks.test.ts"], "name": "I1: a refused variant also drops" }] }
]
```

- [ ] **Step 6: Commit** `feat(w2c): division saves refuse by name what a started inheriting stage depends on (X-SR-4)`.

**Test types:**
- Unit: `division-locks.test.ts`, a DB suite (the predicate is SQL).
- E2E: Task 20, `e2e/division-locks-w2c.spec.ts` "X-SR-4 a started pool locks the division format with its name".
- Smoke: `w2c: division table rules lock names the started stage`, added to `w2cStageRulesSuite` in Task 10, which also rewrites the `smoke.ts:8378-8385` pin (review I2). Smoke cannot run before then (`smoke.ts` is a W2b file).
- Regression: `division-settings.test.ts` (F2b rewritten as above) and `stage-rules.test.ts`.

**Sequence cases:** empty patch; not started; started; second call with the same value; after a void; another sport; the stage sets the key itself (the positive pair of "inherits"); a refused variant; a restore that leaves an invalid mix.

---

### Task 3: Orchestrator — rebase onto W2b, re-pin, write the rule rows (**BLOCKED until rebase on W2b merge**)

**Files:**
- Rebase: `feat/format-matrix-w2c` onto `origin/main` with W2b (PR #945) merged.
- Modify: `packages/engine/rules/{cross-sport,boardgame,cricket,hockey,carrom,generic,icehockey,football}.md` (the signed rows), `packages/engine/test/rules-reference.test.ts` (`AWAITING_PROOF`), `IDX`.

**Interfaces:**
- Consumes: the signed rows (Task 0), the owner's P-3 answer, and lane B (Task 2) already merged into `WT`.
- Produces:
  - the rebased tree;
  - the migration number `V<next>` for Task 10;
  - the confirmed W2b names Task 9 reads (`playRecorded` in `E/core/events.ts`, `awardReasonOf`) and every `applyPointsRule` caller;
  - every W2c rule id present in a rules file and in `AWAITING_PROOF` until its proving test lands.

- [ ] **Step 1: Confirm the merge and rebase.**

```bash
cd /Users/ashokhein/github/seazn.club-worktrees/format-matrix-w2c && gh pr view 945 --json state,mergeCommit -q '.state+" "+.mergeCommit.oid'; echo EXIT=$?
cd /Users/ashokhein/github/seazn.club-worktrees/format-matrix-w2c && git fetch origin && git rebase origin/main; echo EXIT=$?
```
- Expected: `MERGED <sha>`, then a clean rebase or conflicts only in `usecases/stage-rules.ts`. W2b changes one doc comment there, and lane B moved `lockedStageIdsAmong` out; keep both.
- Never `git stash`. If `package.json` or the lockfile conflicts, take `origin/main`'s and re-run `pnpm install --frozen-lockfile`.

- [ ] **Step 2: Re-run the scoped gates of Tasks 1 and 2 on the rebased tree.** Use Task 1 Step 2's command and Task 2 Step 4's command, and judge each. Both must equal their pre-rebase counts. A drop in `total` means a suite stopped collecting.

- [ ] **Step 3: Re-pin.**
  - Re-run the Step 0 greps and record every moved line in `IDX` under the W2c row:
    ```bash
    cd /Users/ashokhein/github/seazn.club-worktrees/format-matrix-w2c && git grep -n -a 'resolveFixtureCfg(' -- apps/web/src | grep -v __tests__ | wc -l && ls db/migration/deltas | sort -V | tail -3 && git grep -n -a 'export function awardReasonOf\|export function playRecorded' -- packages/engine/src && git grep -n -a 'applyPointsRule(' -- apps/web/src packages/engine/src tools | grep -v '\.test\.'
    ```
  - Expected: 12 caller sites (11 + `awarded-state.ts`), the highest delta `V438__…` (or higher if main moved), `awardReasonOf` and `playRecorded` found, and the caller list.
  - Write `V<next>` = the highest + 1 into the Task 10 dispatch.
  - Record the `applyPointsRule` callers (expected four: `engine-db/competition.ts` twice, `testkit/scenarios.ts`, `tools/bench/lib/validate-pack.ts`) for Task 9. A stored award outcome carries NO played marker (review I7), which is why Task 9 reads `playRecorded` from the ledger.

- [ ] **Step 4: Write the signed rule rows.** Use each rules file's existing row format (copy the shape of the row above it) and the wording exactly as signed in Task 0. Add every new id to `AWAITING_PROOF` in `rules-reference.test.ts:12`, each with the owning task number as its reason (for example `"X-SR-5": "W2c Task 14"`). The checker then stays green until the proving test lands, and each task deletes its own entry.

```bash
cd /Users/ashokhein/github/seazn.club-worktrees/format-matrix-w2c/packages/engine && rm -f "$TMPDIR/w2c-t3e.json" && npx vitest run test/rules-reference.test.ts --reporter=json --outputFile="$TMPDIR/w2c-t3e.json"; echo EXIT=$?
```
Judge: green. **Mutation:** temporarily delete one new `AWAITING_PROOF` entry (`X-SR-7`) and re-run: it must go red naming `X-SR-7`. Then restore it.

- [ ] **Step 5: Update `IDX`** (W2c row: rebased, re-pinned; ruling 124 — W2b's generic retirement credit, which amends ruling 87 — folded from W2b's design notes if W2b's merge did not already add it, finding 20), then commit with explicit paths:

```bash
cd /Users/ashokhein/github/seazn.club-worktrees/format-matrix-w2c && git commit -F "$TMPDIR/w2c-msg.txt" -- packages/engine/rules packages/engine/test/rules-reference.test.ts docs/superpowers/specs/2026-09-27-format-matrix-prompts/_INDEX.md; echo EXIT=$?
```

**Test types:**
- Unit: `rules-reference.test.ts`.
- E2E, smoke: N/A (no product code).
- Regression: Step 2.

---

### Task 4: Engine — `ruleKeys`, the derived key helpers, the override check, and the engine P1 sweep

Spec §4.1 and §5.1 as amended; D1. Rule facts move into the engine.

**Files:**
- Modify: `packages/engine/src/sport/module.ts`: add the types and three optional members (`ruleKeys`, `stageDefaults`, and `abandonOptions` — its TYPE only; Task 7 fills it per sport, D9), beside `variants :753` and `bracketDeciders :834`.
- Create: `packages/engine/src/sport/rule-keys.ts`
- Modify: `packages/engine/src/sport/index.ts`: `export * from "./rule-keys.ts";`
- Modify, one `ruleKeys` property each:
  - `packages/engine/src/sports/setbased/kernel.ts` (`SET_RULE_KEYS`, exported) and `volleyball.ts`, `badminton.ts`, `tabletennis.ts` (spread it);
  - `packages/engine/src/sports/period/kernel.ts` (`PERIOD_RULE_KEYS`, exported), `hockey/hockey.ts` (narrows: no `overtime`), `icehockey/icehockey.ts`;
  - `football/football.ts`, `cricket/cricket.ts`, `tennis/tennis.ts`, `boardgame/boardgame.ts`, `carrom/carrom.ts`, `generic/generic.ts`.
- Create: `packages/engine/src/testkit/schema-paths.ts`
- Create: `packages/engine/src/sport/rule-keys.test.ts`
- Create: `MUT/t4.json`
- Do NOT touch: any cfg schema (Tasks 6–8 add keys), any golden file, `stageDefaults` bodies (Task 6). No file moves (spec §4.1: no engine restructure).

**Interfaces:**
- Consumes: `StageKind`, `BRACKET_KINDS`, `DRAW_KINDS` (`E/core/types.ts`); `AnySportModule` (`E/sport/module.ts`).
- Produces (exported from `@seazn/engine/sport`):
  ```ts
  export type RuleScope = "match" | "stage" | "points";
  export interface RuleKeyFact {
    readonly scope: RuleScope;
    readonly appliesTo?: { readonly stageKinds?: readonly StageKind[]; readonly variants?: readonly string[] };
    /** X-SR-2: a match may only switch this key off or shorten it. */
    readonly matchBound?: "off_or_shorter";
  }
  /** Key = a cfg path: top-level ("bestOf") or dotted to a leaf ("overtime.minutes"). Most specific wins. */
  export type RuleKeys = Readonly<Record<string, RuleKeyFact>>;
  // on SportModule<Cfg>:
  //   ruleKeys?: RuleKeys;
  //   stageDefaults?(kind: StageKind, variant: string | null): Partial<Cfg>;
  //   abandonOptions?: readonly string[];   // D9: the abandon policies THIS sport offers (Task 7 fills it)
  export function ruleKeyApplies(fact: RuleKeyFact, kind: StageKind | null, variant: string | null): boolean;
  export function stageKeysFor(m: AnySportModule, kind: StageKind | null, variant: string | null): readonly string[];   // scope stage|match, applying
  export function fixtureKeysFor(m: AnySportModule, kind: StageKind | null, variant: string | null): readonly string[]; // scope match, applying
  export function pointsKeysFor(m: AnySportModule, kind: StageKind | null, variant: string | null): readonly string[];
  export function stageTopKeysFor(m: AnySportModule, kind: StageKind | null, variant: string | null): ReadonlySet<string>; // first segments of stageKeysFor
  export function sportTopKeys(m: AnySportModule): ReadonlySet<string>;   // first segments of every declared key
  export function ruleKeyOwning(m: AnySportModule, path: readonly string[]): { key: string; fact: RuleKeyFact } | null;
  export function stageDefaultsFor(m: AnySportModule, kind: StageKind, variant: string | null): Record<string, unknown>; // m.stageDefaults?.(...) ?? {}
  export type OverrideCheck =
    | { readonly ok: true; readonly changed: readonly string[] }      // dotted leaves
    | { readonly ok: false; readonly code: "UNKNOWN_RULE_KEY" | "RULE_NOT_SETTABLE"; readonly path: string; readonly reason: string };
  export function checkFixtureOverride(m: AnySportModule, kind: StageKind | null, variant: string | null,
    stageResolved: Record<string, unknown>, override: Record<string, unknown>): OverrideCheck;
  ```

**The declaration (spec §4.1 Q5, by ENGINE key).** The web field that edits each key is in brackets. Scope `points` covers the table-points keys (D11). Every top-level schema key not listed is either a Q5 key under its engine name or is added to the test's `UNSETTABLE` table with a one-line reason. A key that fits neither, and that today's division form sets, stops the task: it is a plan finding for the owner (spec: "any key that moves is flagged").

| Module | match | stage | points | UNSETTABLE (test-side, with reason) |
|---|---|---|---|---|
| set kernel → volleyball, badminton, tabletennis | `bestOf`, `setTo`, `finalSetTo`, `cap`, `winBy` | — | `pointsMap` | `records` |
| tennis | `bestOf`, `set` [setType and the shape keys its build writes], `finalSet`, `game.noAd` [noAd], `tiebreak.winBy` [tiebreakWinBy] | — | `points` | `interruptions` |
| football | `halfMinutes`, `extraTime` (`matchBound: "off_or_shorter"`), `shootoutAttempts` (Task 6) | `shootout`, `teamSize`, `maxSubs`, `subWindows`, `sinBinMinutes`, `rollingSubs`, `concussionSubs`, `abandonPolicy` (Task 7) | `points` [shootoutWin, shootoutLoss], `awardScore` | `periodSeconds`, `halves`, `fairPlay` |
| cricket | `ballsPerInnings` [overs], `maxOversPerBowler` | `superOver` (any kind, CK-SO-1), `superOverStillTied`, `dls`, `minOversForResult`, `playersPerSide` | `points` | `inningsPerSide`, `ballsPerOver`, `followOn`, `reviews`, `lineupChanges` |
| period kernel → icehockey | `periods.minutes` [periodMinutes], `overtime.minutes` [overtimeMinutes], `shootout.attempts` [shootoutAttempts] | `overtime` [overtime, overtimeSkaters], `shootout`, `abandonPolicy` (Task 7) | `points`, `awardScore` | `setPieceKinds`, `goalkeeper`, `periodSeconds`, `suspensions`, `strength`, `goalKinds`, `assists` |
| hockey (narrows the kernel: no `overtime`, no `overtime.minutes`) | `periods.minutes` [quarterMinutes], `shootout.attempts` | `shootout`, `abandonPolicy` (Task 7) | `points`, `awardScore` | as ice hockey, plus `overtime` |
| boardgame | — | `variant`, `clock` [clockBaseMinutes, clockIncrementSeconds, clockDelaySeconds] (item 14), `tiebreak` (`appliesTo.stageKinds: BRACKET_KINDS`), `tiebreakRungs` (Task 8) | `scoring`, `byeScore` | `colors` |
| carrom | `gameTo`, `maxBoards`, `bestOf` | `queenPoints`, `queenCapAt`, `queenFollowsBoard`, `pointsPerCoin`, `tieBoard` (`appliesTo.stageKinds: DRAW_KINDS`, item 9), `abandonPolicy` (Task 7) | `points` | — |
| generic | — | `resultMode`, `allowDraws`, `abandonPolicy` (Task 7) | `points` | `progressScore` |

The top-level keys above are every key each module's schema declares on main `a6cc1f038` (listed 2026-10-13 by walking `configSchema`'s shape for all 11 `builtinModules`; review I8). Task 4 Step 1 re-lists them on the rebased tree, and any key W2b added is classified in the same step before the sweep is called green. Two guards keep the UNSETTABLE column honest: the engine sweep below fails on any top-level key in neither column, and Task 5's web contract fails if a key the division form sets TODAY (`configKeysFor`) is not a declared rule key — so nothing settable now can be quietly classed unsettable.

- [ ] **Step 1: Write the failing test** — `packages/engine/src/sport/rule-keys.test.ts`

```ts
// P1 engine sweep (spec §9, §4.1 as amended). Moves with the engine. Expected
// populations come from the registry and the schema, never from rule-keys.ts.
import { describe, expect, it } from "vitest";
import { BRACKET_KINDS, DRAW_KINDS, StageKind } from "../core/types.ts";
import { builtinModules } from "../sports/index.ts";
import { schemaHasPath, schemaTopKeys } from "../testkit/schema-paths.ts";
import {
  checkFixtureOverride, fixtureKeysFor, pointsKeysFor, ruleKeyOwning, stageDefaultsFor,
  stageKeysFor, stageTopKeysFor,
} from "./rule-keys.ts";

const KINDS = StageKind.options;
/** Top-level cfg keys an organiser never sets, per sport, each with its reason.
 *  Reviewed line by line; a new schema key fails the sweep until it is either
 *  declared in ruleKeys or listed here. */
const VARIANT = "a variant fact: set by the variant preset, never edited per stage or match (not in spec §4.1 Q5's settable list)";
const BOOKKEEPING = "scorer bookkeeping or pad vocabulary, not a format rule";
const PERIOD_UNSET = {
  setPieceKinds: BOOKKEEPING, goalkeeper: BOOKKEEPING, periodSeconds: VARIANT, suspensions: VARIANT,
  strength: VARIANT, goalKinds: BOOKKEEPING, assists: BOOKKEEPING,
} as const;
const SET_UNSET = { records: "stat-recording flags, not a format rule" } as const;
const UNSETTABLE: Readonly<Record<string, Readonly<Record<string, string>>>> = {
  volleyball: SET_UNSET, badminton: SET_UNSET, tabletennis: SET_UNSET,
  tennis: { interruptions: BOOKKEEPING },
  football: {
    periodSeconds: VARIANT,
    halves: "picks the phase machine (2 halves or 4 quarters); a variant fact",
    fairPlay: "card tracking for the FIFA fair-play tie-break; the tie-break cascade is W2d's",
  },
  cricket: {
    inningsPerSide: VARIANT, ballsPerOver: VARIANT, followOn: VARIANT,
    reviews: BOOKKEEPING, lineupChanges: "team-sheet policy, owned by the lineups programme (W4)",
  },
  icehockey: PERIOD_UNSET,
  hockey: { ...PERIOD_UNSET, overtime: "hockey has no overtime (FIH); the kernel key exists, hockey narrows it out" },
  boardgame: { colors: "home = White (chess.md §2); the in-page chess contract owns colours (do not touch colorOfHome)" },
  carrom: {},
  generic: { progressScore: "a pad display switch, not a result rule" },
};

describe("X-SR-1 P1 engine sweep — ruleKeys", () => {
  it("every builtin module declares ruleKeys, and every declared key is a real schema path", () => {
    let checked = 0;
    for (const m of builtinModules) {
      expect(m.ruleKeys, m.key).toBeDefined();
      for (const key of Object.keys(m.ruleKeys!)) {
        expect(schemaHasPath(m.configSchema, key.split(".")), `${m.key}: ${key}`).toBe(true);
        checked++;
      }
    }
    expect(checked).toBeGreaterThan(builtinModules.length);
  });

  it("every top-level schema key is declared or listed UNSETTABLE with a reason", () => {
    let checked = 0;
    for (const m of builtinModules) {
      const declared = new Set(Object.keys(m.ruleKeys ?? {}).map((k) => k.split(".")[0]!));
      const unsettable = UNSETTABLE[m.key] ?? {};
      for (const top of schemaTopKeys(m.configSchema)) {
        const ok = declared.has(top) || (Object.hasOwn(unsettable, top) && unsettable[top]!.length > 0);
        expect(ok, `${m.key}.${top} is neither a ruleKey nor UNSETTABLE`).toBe(true);
        checked++;
      }
    }
    expect(checked).toBeGreaterThan(0);
  });

  it("appliesTo names only real stage kinds and real variants", () => {
    let checked = 0;
    for (const m of builtinModules)
      for (const [key, fact] of Object.entries(m.ruleKeys ?? {})) {
        for (const k of fact.appliesTo?.stageKinds ?? []) { expect(KINDS, `${m.key}.${key}`).toContain(k); checked++; }
        for (const v of fact.appliesTo?.variants ?? []) { expect(Object.keys(m.variants), `${m.key}.${key}`).toContain(v); checked++; }
      }
    expect(checked).toBeGreaterThan(0); // carrom tieBoard at least
  });

  it("match ⊂ stage in every sport × kind × variant (fixtureKeys ⊂ stageKeys), and points keys are in neither", () => {
    let cells = 0;
    for (const m of builtinModules)
      for (const kind of [null, ...KINDS])
        for (const variant of [null, ...Object.keys(m.variants)]) {
          const stage = new Set(stageKeysFor(m, kind, variant));
          for (const k of fixtureKeysFor(m, kind, variant)) expect(stage.has(k), `${m.key}/${kind}/${variant}: ${k}`).toBe(true);
          for (const k of pointsKeysFor(m, kind, variant)) expect(stage.has(k), `${m.key}: points key ${k} leaked into stage`).toBe(false);
          cells++;
        }
    expect(cells).toBe(builtinModules.reduce((n, m) => n + (KINDS.length + 1) * (Object.keys(m.variants).length + 1), 0));
  });

  it("every variant preset parses, and every stageDefaults output parses over it and stays inside the stage keys", () => {
    let checked = 0;
    for (const m of builtinModules)
      for (const [variant, preset] of [[null, {}] as const, ...Object.entries(m.variants)])
        for (const kind of KINDS) {
          const defaults = stageDefaultsFor(m, kind, variant);
          const r = m.configSchema.safeParse({ ...preset, ...defaults });
          expect(r.success, `${m.key}/${variant}/${kind}`).toBe(true);
          const allowed = stageTopKeysFor(m, kind, variant);
          for (const k of Object.keys(defaults)) expect(allowed.has(k), `${m.key}/${kind}: default ${k}`).toBe(true);
          checked++;
        }
    expect(checked).toBeGreaterThan(0);
  });

  it("carrom tieBoard applies to table kinds only (item 9)", () => {
    const carrom = builtinModules.find((m) => m.key === "carrom")!;
    let shown = 0;
    for (const k of KINDS) {
      const has = stageKeysFor(carrom, k, null).includes("tieBoard");
      expect(has, k).toBe((DRAW_KINDS as readonly string[]).includes(k));
      if (has) shown++;
    }
    expect(shown).toBe(DRAW_KINDS.length);
    expect(BRACKET_KINDS.length + DRAW_KINDS.length).toBe(KINDS.length);
  });

  it("ruleKeyOwning picks the most specific key", () => {
    const ice = builtinModules.find((m) => m.key === "icehockey")!;
    expect(ruleKeyOwning(ice, ["overtime", "minutes"])?.key).toBe("overtime.minutes");
    expect(ruleKeyOwning(ice, ["overtime", "skaters"])?.key).toBe("overtime");
    expect(ruleKeyOwning(ice, ["nope"])).toBeNull();
  });
});

describe("X-SR-2 checkFixtureOverride", () => {
  const ice = builtinModules.find((m) => m.key === "icehockey")!;
  const fb = builtinModules.find((m) => m.key === "football")!;
  const tennis = builtinModules.find((m) => m.key === "tennis")!;
  const chess = builtinModules.find((m) => m.key === "boardgame")!;
  const stage = { periods: { count: 3, minutes: 20 }, overtime: { kind: "sudden_death", minutes: 10, skaters: 3 }, shootout: { attempts: 5, suddenDeath: true } };

  it("empty override: ok, nothing changed", () => {
    expect(checkFixtureOverride(ice, "knockout", null, stage, {})).toEqual({ ok: true, changed: [] });
  });
  it("a match leaf inside a stage object is accepted (overtime.minutes)", () => {
    expect(checkFixtureOverride(ice, "knockout", null, stage, { overtime: { ...stage.overtime, minutes: 5 } })).toEqual({ ok: true, changed: ["overtime.minutes"] });
  });
  it("a stage leaf in the same object is refused RULE_NOT_SETTABLE (overtime.skaters)", () => {
    expect(checkFixtureOverride(ice, "knockout", null, stage, { overtime: { ...stage.overtime, skaters: 4 } })).toMatchObject({ ok: false, code: "RULE_NOT_SETTABLE", path: "overtime.skaters" });
  });
  it("a match cannot switch on a decider its stage has off", () => {
    expect(checkFixtureOverride(ice, "knockout", null, { ...stage, overtime: null }, { overtime: { kind: "sudden_death", minutes: 5, skaters: 3 } })).toMatchObject({ ok: false, code: "RULE_NOT_SETTABLE" });
  });
  it("a key the sport never declares is UNKNOWN_RULE_KEY", () => {
    expect(checkFixtureOverride(ice, "knockout", null, stage, { bogus: 1 })).toMatchObject({ ok: false, code: "UNKNOWN_RULE_KEY", path: "bogus" });
  });
  it("another sport: tennis noAd accepted; a chess clock refused (stage only, item 14)", () => {
    expect(checkFixtureOverride(tennis, "league", null, { game: { noAd: false } }, { game: { noAd: true } })).toMatchObject({ ok: true });
    expect(checkFixtureOverride(chess, "knockout", null, { clock: { base: 600 } }, { clock: { base: 300 } })).toMatchObject({ ok: false, code: "RULE_NOT_SETTABLE", path: "clock.base" });
  });
  it("X-SR-2 football extra time per match: off or shorter only", () => {
    const st = { extraTime: { enabled: true, halfMinutes: 15 } };
    expect(checkFixtureOverride(fb, "knockout", null, st, { extraTime: { enabled: false, halfMinutes: 15 } })).toMatchObject({ ok: true });
    expect(checkFixtureOverride(fb, "knockout", null, st, { extraTime: { enabled: true, halfMinutes: 10 } })).toMatchObject({ ok: true });
    expect(checkFixtureOverride(fb, "knockout", null, st, { extraTime: { enabled: true, halfMinutes: 20 } })).toMatchObject({ ok: false, code: "RULE_NOT_SETTABLE", path: "extraTime" });
    expect(checkFixtureOverride(fb, "knockout", null, { extraTime: { enabled: false, halfMinutes: 15 } }, { extraTime: { enabled: true, halfMinutes: 15 } })).toMatchObject({ ok: false, code: "RULE_NOT_SETTABLE" });
  });
});
```

- [ ] **Step 2: Run it to verify it fails.**
  `cd /Users/ashokhein/github/seazn.club-worktrees/format-matrix-w2c/packages/engine && rm -f "$TMPDIR/w2c-t4e.json" && npx vitest run src/sport/rule-keys.test.ts --reporter=json --outputFile="$TMPDIR/w2c-t4e.json"; echo EXIT=$?`
  - The first run fails to collect: `rule-keys.ts` and `schema-paths.ts` do not exist yet.
  - Create both with every export throwing `new Error("not implemented")`, then re-run.
  - Expected: `failedSuites == 0`, and every test fails on an assertion or `not implemented`.

- [ ] **Step 3: Implement.** Write `schema-paths.ts` with zod 4's wrappers. The class names were checked on 2026-10-13 against `zod@4`. If the installed minor version renames them, adapt `unwrap` without touching the assertions.

```ts
import { z } from "zod";

function unwrap(s: z.ZodType): z.ZodType {
  let cur: z.ZodType = s;
  for (;;) {
    if (cur instanceof z.ZodOptional || cur instanceof z.ZodNullable || cur instanceof z.ZodDefault) cur = cur.unwrap() as z.ZodType;
    else if (cur instanceof z.ZodPipe) cur = cur.in as z.ZodType;
    else return cur;
  }
}
export function schemaHasPath(schema: z.ZodType, path: readonly string[]): boolean {
  if (path.length === 0) return true;
  const s = unwrap(schema);
  if (s instanceof z.ZodObject) {
    const child = (s.shape as Record<string, z.ZodType>)[path[0]!];
    return child !== undefined && schemaHasPath(child, path.slice(1));
  }
  if (s instanceof z.ZodUnion || s instanceof z.ZodDiscriminatedUnion) return (s.options as z.ZodType[]).some((o) => schemaHasPath(o, path));
  return false;
}
export function schemaTopKeys(schema: z.ZodType): readonly string[] {
  const s = unwrap(schema);
  return s instanceof z.ZodObject ? Object.keys(s.shape) : [];
}
```

Then write `rule-keys.ts`:

```ts
import type { StageKind } from "../core/types.ts";
import type { AnySportModule, RuleKeyFact } from "./module.ts";

export function ruleKeyApplies(fact: RuleKeyFact, kind: StageKind | null, variant: string | null): boolean {
  const a = fact.appliesTo;
  if (!a) return true;
  if (a.stageKinds && kind !== null && !a.stageKinds.includes(kind)) return false;
  if (a.variants && variant !== null && !a.variants.includes(variant)) return false;
  return true;
}
const keysWhere = (m: AnySportModule, kind: StageKind | null, variant: string | null, scopes: readonly string[]) =>
  Object.entries(m.ruleKeys ?? {}).filter(([, f]) => scopes.includes(f.scope) && ruleKeyApplies(f, kind, variant)).map(([k]) => k);
export const stageKeysFor = (m: AnySportModule, kind: StageKind | null, variant: string | null) => keysWhere(m, kind, variant, ["stage", "match"]);
export const fixtureKeysFor = (m: AnySportModule, kind: StageKind | null, variant: string | null) => keysWhere(m, kind, variant, ["match"]);
export const pointsKeysFor = (m: AnySportModule, kind: StageKind | null, variant: string | null) => keysWhere(m, kind, variant, ["points"]);
export const stageTopKeysFor = (m: AnySportModule, kind: StageKind | null, variant: string | null): ReadonlySet<string> =>
  new Set(stageKeysFor(m, kind, variant).map((k) => k.split(".")[0]!));
export const sportTopKeys = (m: AnySportModule): ReadonlySet<string> => new Set(Object.keys(m.ruleKeys ?? {}).map((k) => k.split(".")[0]!));

export function ruleKeyOwning(m: AnySportModule, path: readonly string[]): { key: string; fact: RuleKeyFact } | null {
  for (let n = path.length; n > 0; n--) {
    const key = path.slice(0, n).join(".");
    const fact = m.ruleKeys?.[key];
    if (fact && Object.hasOwn(m.ruleKeys!, key)) return { key, fact };
  }
  return null;
}
export const stageDefaultsFor = (m: AnySportModule, kind: StageKind, variant: string | null): Record<string, unknown> =>
  (m.stageDefaults?.(kind, variant) ?? {}) as Record<string, unknown>;

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const at = (o: unknown, p: readonly string[]): unknown => p.reduce<unknown>((acc, k) => (isObj(acc) ? acc[k] : undefined), o);
function changedLeaves(before: unknown, after: unknown, path: string[]): string[][] {
  if (isObj(before) && isObj(after)) {
    const keys = new Set([...Object.keys(before), ...Object.keys(after)]);
    return [...keys].flatMap((k) => changedLeaves(before[k], after[k], [...path, k]));
  }
  return JSON.stringify(before) === JSON.stringify(after) ? [] : [path];
}
function offOrShorter(o: unknown, s: unknown): string | null {
  const ov = isObj(o) ? o : {}; const st = isObj(s) ? s : {};
  if (ov.enabled !== true) return null;
  if (st.enabled !== true) return "it is off for this stage";
  return Number(ov.halfMinutes ?? 0) <= Number(st.halfMinutes ?? 0) ? null : "it can only be shorter than the stage's";
}

export type OverrideCheck =
  | { readonly ok: true; readonly changed: readonly string[] }
  | { readonly ok: false; readonly code: "UNKNOWN_RULE_KEY" | "RULE_NOT_SETTABLE"; readonly path: string; readonly reason: string };

export function checkFixtureOverride(
  m: AnySportModule, kind: StageKind | null, variant: string | null,
  stageResolved: Record<string, unknown>, override: Record<string, unknown>,
): OverrideCheck {
  const known = sportTopKeys(m);
  for (const k of Object.keys(override))
    if (!known.has(k)) return { ok: false, code: "UNKNOWN_RULE_KEY", path: k, reason: `${k} is not a ${m.key} rule` };
  const changed: string[] = [];
  for (const top of Object.keys(override))
    for (const leaf of changedLeaves(stageResolved[top], override[top], [top])) {
      const owner = ruleKeyOwning(m, leaf);
      const path = leaf.join(".");
      if (!owner || owner.fact.scope !== "match" || !ruleKeyApplies(owner.fact, kind, variant))
        return { ok: false, code: "RULE_NOT_SETTABLE", path, reason: "it can be set per stage, not per match" };
      const ownerPath = owner.key.split(".");
      if (owner.fact.matchBound === "off_or_shorter") {
        const why = offOrShorter(at(override, ownerPath), at(stageResolved, ownerPath));
        if (why) return { ok: false, code: "RULE_NOT_SETTABLE", path: owner.key, reason: why };
      } else if (at(stageResolved, leaf) === undefined || (ownerPath.length > 1 && !isObj(at(stageResolved, ownerPath.slice(0, -1))))) {
        return { ok: false, code: "RULE_NOT_SETTABLE", path, reason: "it is off for this stage" };
      }
      changed.push(path);
    }
  return { ok: true, changed };
}
```

  - In `module.ts`, add the three types and the three optional members, with doc comments citing spec §4.1 (and D9 for `abandonOptions`).
  - Declare `ruleKeys` in each module per the table, as `ruleKeys: { ...SET_RULE_KEYS }` and so on.
  - `UNSETTABLE` is written out in Step 1 (review I8). After the rebase, any `is neither a ruleKey nor UNSETTABLE` message names a key W2b added: classify it into the table and the literal with its reason, or stop and raise it (finding 27). Paste the final per-sport counts (declared, unsettable) into the task report.

- [ ] **Step 4: Run** the test (judge green), engine `tsc`, and report the ids it proves with their test paths (the batch-end proof commit, **Execution**): X-SR-1/2 from this test's titles. Then run the existing module suites that exercise every module's shape:

`cd /Users/ashokhein/github/seazn.club-worktrees/format-matrix-w2c/packages/engine && rm -f "$TMPDIR/w2c-t4e.json" && npx vitest run src/sport/rule-keys.test.ts test/rules-reference.test.ts src/sport/module.test.ts --reporter=json --outputFile="$TMPDIR/w2c-t4e.json"; echo EXIT=$?`

If `src/sport/module.test.ts` does not exist, the implementer names the suite that covers `module.ts` (`git grep -l -a "from \"./module.ts\"" -- packages/engine/src/sport`) and runs that.

- [ ] **Step 5: Mutate once** — `MUT/t4.json`, plus changed-lines Stryker over `rule-keys.ts`:

```json
[
  { "id": "t4-scope-match", "file": "packages/engine/src/sport/rule-keys.ts",
    "find": "owner.fact.scope !== \"match\" || ", "replace": "",
    "killers": [{ "cwd": "packages/engine", "files": ["src/sport/rule-keys.test.ts"], "name": "stage leaf in the same object" }] },
  { "id": "t4-most-specific", "file": "packages/engine/src/sport/rule-keys.ts",
    "find": "for (let n = path.length; n > 0; n--)", "replace": "for (let n = 1; n <= path.length; n++)",
    "killers": [{ "cwd": "packages/engine", "files": ["src/sport/rule-keys.test.ts"], "name": "most specific" }] },
  { "id": "t4-applies-kind", "file": "packages/engine/src/sport/rule-keys.ts",
    "find": "!a.stageKinds.includes(kind)) return false", "replace": "false) return false",
    "killers": [{ "cwd": "packages/engine", "files": ["src/sport/rule-keys.test.ts"], "name": "carrom tieBoard applies to table kinds only" }] },
  { "id": "t4-bound", "file": "packages/engine/src/sport/rule-keys.ts",
    "find": "<= Number(st.halfMinutes ?? 0) ? null", "replace": "<= Infinity ? null",
    "killers": [{ "cwd": "packages/engine", "files": ["src/sport/rule-keys.test.ts"], "name": "X-SR-2 football extra time per match" }] }
]
```

- [ ] **Step 6: Commit** `feat(engine): sport modules declare ruleKeys; stage/fixture key helpers (X-SR-1, X-SR-2)` with the listed paths.

**Test types:**
- Unit: above.
- E2E: Task 17, `e2e/stage-rules-w2c.spec.ts` "X-SR-1 every sport shows its stage fields" (the stage form reads these keys).
- Smoke: `w2c: every sport accepts its stage keys`, in Task 11.
- Regression: `rules-reference.test.ts`; the module suite; `pnpm --filter @seazn/engine schema:snapshot` shows no diff, because ruleKeys is not part of the cfg schema.

**Sequence cases:** an empty override first; one leaf; a sibling leaf; a stage-off decider; another sport (tennis, chess); every kind × variant cell in the sweep.

---

### Task 5: Web — fields name their engine key; per-sport contract tests; `rule-scope.ts`

> **Carried from Task 4 review (G2).** Six declared stage keys have no web field today: `rollingSubs`, `concussionSubs`, `superOverStillTied`, `minOversForResult`, `pointsPerCoin`, chess `tiebreak` (superseded by `tiebreakRungs` in Task 8). The "every settable key has a web field" contract must not go red silently: either add the field in the owning sport file (preferred where the organiser plausibly sets it) or list it in an explicit, counted `NO_WEB_FIELD_YET` map with the owning task/reason, and report which. Stage-level deciders are read from the engine's `decider: true` fact (Task 4 fix round 1), never from `bracketDeciders`.

> **Carried from batch-1 Opus review (M-b).** `rule-locks.ts:64-81`'s "inherits" check ignores stage kind: a started knockout locks `points`/`pointsMap`/`tiebreakers` (it has no table) and keys forced by `bracketDeciders` or top-level `STAGE_DECIDER_KEYS`. Once `ruleKeys` carry `appliesTo`, a stage only inherits a key that applies to its kind; add a knockout case (division `pointsMap` edit saves while only a knockout stage has started) + one mutant.

> **Carried from build (orchestrator, Task 1/2 reviews).** (a) Add `tools/matrix/__tests__/boundary.test.ts` (run with the ENGINE's vitest) to Step 4's verify: it guards the `.ts` sibling imports plain Node needs, and web `vitest related` never runs it. (b) Task 2 review M-4: `division-locks.test.ts` covers badminton + generic only; once `TABLE_RULE_KEYS` derives from `pointsKeysFor`, add a builtinModules sweep that every sport's table/format classification matches the engine declaration (counted, zero checked = failure).

Spec §4.1 as amended (web side), D2, D11.

**Files:**
- Modify: `apps/web/src/lib/match-rules/types.ts`: `RuleField` gains `edits: readonly string[]`, REQUIRED, so the compiler lists every field; `RuleField.kind` gains `"sequence"` (an ordered list, value = comma-joined option values). Both land here, not in Tasks 7–8, so lanes E1/E2 never touch `types.ts` (review M12).
- Modify: `apps/web/src/lib/match-rules/shared.ts`: add `ABANDON_LABELS` (D9's lookup table: `replay`, `award`, `q4_stands`, `share`) and `abandonOptions(module): {value, label}[]`, which reads `module.abandonOptions ?? []` (Task 4's type; Task 7 fills it) through the table and throws on an unmapped value. Unit-tested in `rule-scope.test.ts` with a fake module (review M12: E1 then never touches `shared.ts`).
- Modify: all 11 `apps/web/src/lib/match-rules/<sport>.ts` files: one `edits` per field (the bracketed web keys in Task 4's table).
- Create: `apps/web/src/lib/match-rules/__tests__/run-contract.ts`
- Create: `apps/web/src/lib/match-rules/__tests__/<sport>.contract.test.ts` × 11
- Create: `apps/web/src/lib/rule-scope.ts`
- Create: `apps/web/src/lib/__tests__/rule-scope.test.ts`
- Modify: `apps/web/src/server/usecases/rule-locks.ts`: `TABLE_RULE_KEYS` becomes `tableRuleKeys(module, variant)` = `pointsKeysFor ∪ {"pointsMap"}`. `divisionRefusals` gains a `module` parameter, and `divisions.ts` passes `resolveModule(current.sport_key, current.module_version)`.
- Create: `MUT/t5.json`
- Do NOT touch: labels, options, `build` bodies, field order (presentation stays as Task 1 left it); `STAGE_RULES_SPORTS` (Task 17 deletes it with its last consumer).

**Interfaces:**
- Consumes: Task 4's `stageKeysFor`, `fixtureKeysFor`, `pointsKeysFor`, `ruleKeyOwning`, `AnySportModule`, `RuleKeys`; Task 1's per-sport constants.
- Produces:
  ```ts
  // lib/rule-scope.ts (client-safe; imports @seazn/engine/sport and @seazn/engine/sports only)
  export interface RuleContext { readonly module: AnySportModule; readonly stageKind: StageKind | null; readonly variant: string | null }
  export function moduleFor(sportKey: string): AnySportModule | null;         // builtinModules lookup (client side)
  export function stageFieldsFor(ctx: RuleContext): RuleField[];            // every edits key ∈ stageKeysFor
  export function matchFieldsFor(ctx: RuleContext): RuleField[];            // every edits key ∈ fixtureKeysFor
  export function pointsFieldsFor(ctx: RuleContext): RuleField[];           // every edits key ∈ pointsKeysFor
  export function buildMatchFragment(ctx: RuleContext, values: Record<string, string>, stageResolved: Record<string, unknown>): Record<string, unknown>;
  // match-rules/__tests__/run-contract.ts
  export function runContract(m: AnySportModule, fields: readonly RuleField[]): void;
  ```

- [ ] **Step 1: Write the failing tests.** `run-contract.ts`:

```ts
// The web half of P1 (spec §9 as amended). One call per sport file, so
// `vitest related --dir src/lib/match-rules/__tests__ src/lib/match-rules/<sport>.ts` runs only that sport's
// contract. Expected populations come from the engine's ruleKeys and schema.
import { describe, expect, it } from "vitest";
import { StageKind } from "@seazn/engine/core";
import { fixtureKeysFor, stageKeysFor, type AnySportModule } from "@seazn/engine/sport";
import type { RuleField } from "../types";

const probes = (f: RuleField): string[] =>
  f.kind === "select" ? (f.options ?? []).map((o) => o.value)
  : f.kind === "bool" ? ["on", "off"]
  : f.kind === "sequence" ? ["", (f.options ?? []).map((o) => o.value).join(","), [...(f.options ?? [])].reverse().map((o) => o.value).join(",")]
  : [String(f.min ?? 1)];

export function runContract(m: AnySportModule, fields: readonly RuleField[]): void {
  const declared = new Set(Object.keys(m.ruleKeys ?? {}));
  describe(`${m.key} — web contract (X-SR-1)`, () => {
    it("every web field names one or more declared engine keys", () => {
      let checked = 0;
      for (const f of fields) {
        expect(f.edits.length, f.key).toBeGreaterThan(0);
        for (const k of f.edits) { expect(declared.has(k), `${f.key} edits undeclared ${k}`).toBe(true); checked++; }
      }
      expect(checked).toBeGreaterThan(0);
    });

    it("every settable (stage or match) engine key has a web field, in every kind × variant", () => {
      const edited = new Set(fields.flatMap((f) => f.edits));
      let cells = 0;
      for (const kind of [null, ...StageKind.options])
        for (const variant of [null, ...Object.keys(m.variants)]) {
          for (const k of stageKeysFor(m, kind, variant)) expect(edited.has(k), `${kind}/${variant}: no field edits ${k}`).toBe(true);
          cells++;
        }
      expect(cells).toBe((StageKind.options.length + 1) * (Object.keys(m.variants).length + 1));
    });

    it("every key a build() writes is the top segment of a key the field names", () => {
      let checked = 0;
      for (const f of fields) {
        const tops = new Set(f.edits.map((k) => k.split(".")[0]));
        for (const v of probes(f)) for (const k of Object.keys(f.build(v, {}))) { expect(tops.has(k), `${f.key}=${v} writes ${k}`).toBe(true); checked++; }
      }
      expect(checked).toBeGreaterThan(0);
    });

    it("every build() output parses the engine schema over every variant preset", () => {
      let checked = 0;
      for (const preset of [{}, ...Object.values(m.variants)])
        for (const f of fields)
          for (const v of probes(f)) {
            const r = m.configSchema.safeParse({ ...preset, ...f.build(v, {}) });
            expect(r.success, `${f.key}=${v}: ${r.success ? "" : JSON.stringify(r.error.issues)}`).toBe(true);
            checked++;
          }
      expect(checked).toBeGreaterThan(0);
    });

    it("a match-scoped field never edits a stage-only key", () => {
      let checked = 0;
      const match = new Set(fixtureKeysFor(m, null, null));
      for (const f of fields)
        if (f.edits.some((k) => match.has(k))) {
          for (const k of f.edits) expect(match.has(k), `${f.key} mixes ${k}`).toBe(true);
          checked++;
        }
      // boardgame and generic declare no match keys; every other sport must have at least one match field (never a vacuous pass)
      expect(checked > 0, `${m.key}: match fields iff match keys`).toBe(match.size > 0);
    });
  });
}
```

Each of the 11 contract files has this shape (the icehockey one shown; the others differ only in the two imports and the constant):

```ts
// Single-sport by design: one file per sport (owner 2026-10-13).
import { icehockey } from "@seazn/engine/sports/icehockey";
import { ICEHOCKEY_RULES } from "../icehockey";
import { runContract } from "./run-contract";

runContract(icehockey, ICEHOCKEY_RULES);
```

For the set sports, import from `@seazn/engine/sports/setbased` (`volleyball`, `badminton`, `tabletennis`). Before writing the imports, confirm each export name with `git grep -n -a "^export" -- packages/engine/src/sports/<key>/index.ts`.

`apps/web/src/lib/__tests__/rule-scope.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { builtinModules } from "@seazn/engine/sports";
import { DRAW_KINDS, StageKind } from "@seazn/engine/core";
import type { AnySportModule } from "@seazn/engine/sport";
import { buildMatchFragment, matchFieldsFor, moduleFor, stageFieldsFor, type RuleContext } from "@/lib/rule-scope";
import { abandonOptions } from "@/lib/match-rules/shared";

const ice = (): RuleContext => ({ module: moduleFor("icehockey")!, stageKind: "knockout", variant: null });
const stage = { periods: { count: 3, minutes: 20 }, overtime: { kind: "sudden_death", minutes: 10, skaters: 3 }, shootout: { attempts: 5, suddenDeath: true } };

describe("rule-scope — web reads the engine declaration (D2)", () => {
  it("moduleFor finds every builtin and refuses an unknown key", () => {
    for (const m of builtinModules) expect(moduleFor(m.key)?.key).toBe(m.key);
    expect(moduleFor("constructor")).toBeNull();
  });
  it("icehockey match fields are the three match keys' editors", () => {
    expect(matchFieldsFor(ice()).map((f) => f.key)).toEqual(["periodMinutes", "overtimeMinutes", "shootoutAttempts"]);
  });
  it("carrom tieBoard shows in table stages only (item 9), counted", () => {
    const carrom = moduleFor("carrom")!;
    let shown = 0;
    for (const k of StageKind.options) {
      const has = stageFieldsFor({ module: carrom, stageKind: k, variant: null }).some((f) => f.key === "tieBoard");
      expect(has, k).toBe((DRAW_KINDS as readonly string[]).includes(k));
      if (has) shown++;
    }
    expect(shown).toBe(DRAW_KINDS.length);
  });
  it("buildMatchFragment: empty values → {}", () => {
    expect(buildMatchFragment(ice(), {}, stage)).toEqual({});
  });
  it("buildMatchFragment deep-sets a sub-field (whose build writes nothing) on the stage object", () => {
    expect(buildMatchFragment(ice(), { overtimeMinutes: "5" }, stage)).toEqual({ overtime: { kind: "sudden_death", minutes: 5, skaters: 3 } });
  });
  it("buildMatchFragment writes nothing under a stage decider that is off", () => {
    expect(buildMatchFragment(ice(), { overtimeMinutes: "5" }, { ...stage, overtime: null })).toEqual({});
  });
  it("abandonOptions reads the module's own list through ABANDON_LABELS, in its order; empty stays empty; an unmapped value throws", () => {
    const fake = (o: string[]) => ({ key: "fake", abandonOptions: o }) as unknown as AnySportModule;
    expect(abandonOptions(fake(["q4_stands", "replay"])).map((x) => x.value)).toEqual(["q4_stands", "replay"]);
    expect(abandonOptions(fake([]))).toEqual([]);
    expect(() => abandonOptions(fake(["nope"]))).toThrow();
  });
  it("another sport: tennis noAd keeps the stage's other game leaves", () => {
    const t: RuleContext = { module: moduleFor("tennis")!, stageKind: "league", variant: null };
    expect(buildMatchFragment(t, { noAd: "on" }, { game: { noAd: false, other: 1 } })).toEqual({ game: { noAd: true, other: 1 } });
  });
});
```

Extend `division-locks.test.ts` with one case: "table rule keys come from the engine: an ice hockey `points` edit is table rules, a `periods` edit is match format". Its expected codes come from `pointsKeysFor(icehockey, null, null)`.

- [ ] **Step 2: Run to verify red.** `RuleField.edits` does not exist yet, so add it as OPTIONAL for this step only, and stub `rule-scope.ts` exports to throw. Then:
  `cd /Users/ashokhein/github/seazn.club-worktrees/format-matrix-w2c/apps/web && rm -f "$TMPDIR/w2c-t5.json" && npx vitest run src/lib/match-rules/__tests__/volleyball.contract.test.ts src/lib/match-rules/__tests__/badminton.contract.test.ts src/lib/match-rules/__tests__/tabletennis.contract.test.ts src/lib/match-rules/__tests__/tennis.contract.test.ts src/lib/match-rules/__tests__/football.contract.test.ts src/lib/match-rules/__tests__/cricket.contract.test.ts src/lib/match-rules/__tests__/icehockey.contract.test.ts src/lib/match-rules/__tests__/hockey.contract.test.ts src/lib/match-rules/__tests__/boardgame.contract.test.ts src/lib/match-rules/__tests__/carrom.contract.test.ts src/lib/match-rules/__tests__/generic.contract.test.ts src/lib/__tests__/rule-scope.test.ts --reporter=json --outputFile="$TMPDIR/w2c-t5.json"; echo EXIT=$?`
  Expected: `files == 12`, `failedSuites == 0`, and the failures are `edits` length or `not implemented`.

- [ ] **Step 3: Implement.**
  - Make `edits` required and fill it per field.
  - Write `rule-scope.ts`. `buildMatchFragment` keeps Task-1-era semantics: for each match field with a value, take the built leaf at each `edits` path, or `Number(value)` when the build writes nothing. Set it on a `structuredClone` of the stage-resolved top object, and skip the field when that object is not an object. The code is the `buildMatchFragment`/`setPath` pair below:

```ts
export function buildMatchFragment(ctx: RuleContext, values: Record<string, string>, stageResolved: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const f of matchFieldsFor(ctx)) {
    const v = values[f.key];
    if (v === undefined || v === "") continue;
    const built = f.build(v, values);
    for (const key of f.edits) {
      const path = key.split(".");
      const leaf = Object.keys(built).length > 0 ? path.reduce<unknown>((o, k) => (isObj(o) ? o[k] : undefined), built) : Number(v);
      if (leaf === undefined) continue;
      if (path.length === 1) { out[path[0]!] = leaf; continue; }
      const base = out[path[0]!] ?? stageResolved[path[0]!];
      if (!isObj(base)) continue;
      out[path[0]!] = setPath(structuredClone(base), path.slice(1), leaf);
    }
  }
  return out;
}
const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
function setPath(o: Record<string, unknown>, p: readonly string[], v: unknown): Record<string, unknown> {
  if (p.length === 1) return { ...o, [p[0]!]: v };
  return { ...o, [p[0]!]: setPath(isObj(o[p[0]!]) ? (o[p[0]!] as Record<string, unknown>) : {}, p.slice(1), v) };
}
```

  - `moduleFor` uses `builtinModules.find((m) => m.key === sportKey) ?? null`. Field lists come from `SPORT_RULES` via `Object.hasOwn`.

- [ ] **Step 4: Run.**
  1. Re-run Step 2's command (judge `files == 12`, green).
  2. Prove `related` scoping:
     ```bash
     cd /Users/ashokhein/github/seazn.club-worktrees/format-matrix-w2c/apps/web && rm -f "$TMPDIR/w2c-t5r.json" && npx vitest related --run src/lib/match-rules/football.ts --reporter=json --outputFile="$TMPDIR/w2c-t5r.json"; echo EXIT=$?; jq -r '.testResults[].name|select(test("contract"))' "$TMPDIR/w2c-t5r.json"
     ```
     The jq output must print exactly one path, ending in `football.contract.test.ts`.
  3. Run `division-locks.test.ts` and `division-settings.test.ts`.
  4. Re-run Task 1's nine suites.
  5. `tsc` and eslint.

- [ ] **Step 5: Mutate once** — `MUT/t5.json`:

```json
[
  { "id": "t5-contract-coverage", "file": "apps/web/src/lib/match-rules/icehockey.ts",
    "find": "edits: [\"overtime.minutes\"]", "replace": "edits: [\"overtime\"]",
    "killers": [{ "cwd": "apps/web", "files": ["src/lib/match-rules/__tests__/icehockey.contract.test.ts"], "name": "every settable" }] },
  { "id": "t5-fragment-skip-off", "file": "apps/web/src/lib/rule-scope.ts",
    "find": "if (!isObj(base)) continue;", "replace": "",
    "killers": [{ "cwd": "apps/web", "files": ["src/lib/__tests__/rule-scope.test.ts"], "name": "under a stage decider that is off" }] },
  { "id": "t5-table-keys", "file": "apps/web/src/server/usecases/rule-locks.ts",
    "find": "pointsKeysFor(", "replace": "((..._a: unknown[]) => [] as string[])(",
    "killers": [{ "cwd": "apps/web", "files": ["src/server/usecases/__tests__/division-locks.test.ts"], "name": "table rule keys come from the engine" }] }
]
```

- [ ] **Step 6: Commit** `feat(match-rules): fields name their engine key; per-sport contract tests (X-SR-1)`.

**Test types:**
- Unit: above.
- E2E: Task 17 (stage form) and Task 19 (match form) render `stageFieldsFor`/`matchFieldsFor`.
- Smoke: N/A. A pure library; the server consumers' smoke checks are in Tasks 11 and 14.
- Regression: Task 1's nine suites; `division-locks.test.ts`.

**Sequence cases:** empty values; one sub-field; a sub-field under a stage-off decider; another sport; every kind × variant cell per sport in the contract.

---
### Task 6: Engine — knockout presets (`stageDefaults`) and football shoot-out attempts (E1)

Spec items 6, 7, 8; X-SR-6, FB-SO-1, IH-KO-1, CK-SO-1; §4.2.

**Files:**
- Modify: `packages/engine/src/sports/football/football.ts`:
  - cfg (`:111` area): `shootoutAttempts: z.number().int().min(1).max(10).optional()`;
  - the shoot-out kick (`:1621`): `shootoutDecision(kicks, state.cfg.shootoutAttempts ?? 5)`;
  - `ruleKeys`: `shootoutAttempts` (match);
  - `stageDefaults`.
- Modify: `packages/engine/src/sports/hockey/hockey.ts`, `icehockey/icehockey.ts`, `cricket/cricket.ts`: `stageDefaults`.
- Modify: `packages/engine/src/sports/football/football.schema.json` (via `schema:snapshot`).
- Modify: `apps/web/src/lib/match-rules/football.ts`: new field `shootoutAttempts` (number 1–10, label "Shoot-out kicks each", `edits: ["shootoutAttempts"]`, build `{shootoutAttempts: Number(v)}`). The `shootout` field's help becomes "Penalties decide a level knockout match."
- Modify: `apps/web/src/lib/match-rules/cricket.ts`: the `superOver` help becomes "Plays a super over whenever a match ends tied — in any stage where it is On." (CR-11).
- Modify: `packages/engine/src/sports/cricket/cricket.test.ts`: one case (CK-SO-1 "league-on plays every tie", review M3).
- Create: `packages/engine/src/sport/stage-defaults.test.ts`
- Create: `MUT/t6.json`
- Do NOT touch: `stage.ts`, `progression.ts`; any golden stream; boardgame, carrom and generic (other tasks).

**Interfaces:**
- Consumes: Task 4's `stageDefaultsFor`, `ruleKeys`, `BRACKET_KINDS`.
- Produces: `stageDefaults(kind, variant)` on football, hockey, icehockey and cricket. It returns `{}` for every table kind and the presets below for every bracket kind. A **lookup table per module**, keyed by variant with a fallback, never an if/else chain:

| Module | Bracket-kind preset | Source of each value |
|---|---|---|
| football | `{extraTime: {enabled: true, halfMinutes: 15}, shootout: true, shootoutAttempts: <5, or 3 for youth>}` | X-SR-6, FB-SO-1 as signed |
| hockey | `{shootout: hockey.variants["fih-shootout"].shootout}` | the module's own FIH preset (no new constant) |
| icehockey | `{overtime: {kind: "sudden_death", minutes: 10, skaters: <engine default skaters>}, shootout: <engine default shootout>}` | IH-KO-1 (10'), the engine default for the rest |
| cricket | `{superOver: true}` | CK-SO-1 |

- [ ] **Step 1: Write the failing test** — `packages/engine/src/sport/stage-defaults.test.ts`

```ts
// X-SR-6 / FB-SO-1 / IH-KO-1 / CK-SO-1 — knockout presets. Expected values come
// from the signed rule rows and the modules' own declarations (variants,
// configSchema defaults, BRACKET_KINDS), never from stageDefaults itself.
import { describe, expect, it } from "vitest";
import { BRACKET_KINDS, DRAW_KINDS } from "../core/types.ts";
import { foldMatch, type EventEnvelope } from "../core/events.ts";
import { builtinModules } from "../sports/index.ts";
import { football } from "../sports/football/index.ts";
import { hockey } from "../sports/hockey/index.ts";
import { icehockey } from "../sports/icehockey/index.ts";
import { cricket } from "../sports/cricket/index.ts";
import { defaultLineupPair, makeEnvelope } from "../testkit/index.ts";
import { stageDefaultsFor } from "./rule-keys.ts";

const stream = (...specs: Array<[string, unknown?]>): EventEnvelope[] =>
  specs.map(([type, payload], i) => makeEnvelope(i, { type, payload: payload ?? {} }));

describe("X-SR-6 table kinds get no preset", () => {
  it("every module returns {} for every table kind (counted)", () => {
    let checked = 0;
    for (const m of builtinModules)
      for (const kind of DRAW_KINDS)
        for (const variant of [null, ...Object.keys(m.variants)]) { expect(stageDefaultsFor(m, kind, variant), `${m.key}/${kind}`).toEqual({}); checked++; }
    expect(checked).toBeGreaterThan(0);
  });
});

describe("X-SR-6 FB-SO-1 football knockout preset", () => {
  it("every bracket kind presets ET 2×15, penalties and 5 kicks; youth 3", () => {
    let checked = 0;
    for (const kind of BRACKET_KINDS) {
      expect(stageDefaultsFor(football, kind, null)).toEqual({ extraTime: { enabled: true, halfMinutes: 15 }, shootout: true, shootoutAttempts: 5 });
      expect(stageDefaultsFor(football, kind, "youth")).toMatchObject({ shootoutAttempts: 3 });
      checked++;
    }
    expect(checked).toBe(BRACKET_KINDS.length);
    expect(Object.keys(football.variants)).toContain("youth");
  });

  it("FB-SO-1 the shoot-out is decided after the stage's attempts (3), and NOT after 2 rounds under 5", () => {
    const kick = (by: string, scored: boolean): [string, unknown] => ["football.shootout.kick", { by, scored }];
    const lineups = defaultLineupPair(football.positions);
    const H = lineups.home.entrantId, A = lineups.away.entrantId;
    const events = stream(
      ["core.start"], ["football.period", { phase: "HT" }], ["football.period", { phase: "FT" }],
      ["football.period", { phase: "ET_HT" }], ["football.period", { phase: "ET_FT" }],
      kick(H, true), kick(A, false), kick(H, true), kick(A, false),   // 2-0 after two rounds
    );
    const three = football.configSchema.parse({ ...stageDefaultsFor(football, "knockout", "youth") });
    const five = football.configSchema.parse({ ...stageDefaultsFor(football, "knockout", null) });
    expect(foldMatch(football, three, lineups, events).outcome).toMatchObject({ kind: "win", winner: H, method: "shootout" });
    expect(foldMatch(football, five, lineups, events).outcome ?? null).toBeNull();
  });

  it("absent shootoutAttempts keeps today's 5 (a division cfg without the key)", () => {
    const cfg = football.configSchema.parse({ extraTime: { enabled: true, halfMinutes: 15 }, shootout: true });
    expect(cfg.shootoutAttempts).toBeUndefined();
  });
});

describe("hockey, ice hockey and cricket knockout presets", () => {
  it("hockey: the FIH preset's shoot-out, in every bracket kind", () => {
    for (const kind of BRACKET_KINDS) expect(stageDefaultsFor(hockey, kind, null)).toEqual({ shootout: hockey.variants["fih-shootout"]!.shootout });
  });
  it("IH-KO-1 ice hockey: 10-minute sudden-death OT and the default GWS", () => {
    const base = icehockey.configSchema.parse({});
    const d = stageDefaultsFor(icehockey, "knockout", null) as { overtime: { minutes: number; skaters: number; kind: string }; shootout: unknown };
    expect(d.overtime).toEqual({ kind: "sudden_death", minutes: 10, skaters: (base.overtime as { skaters: number }).skaters });
    expect(d.shootout).toEqual(base.shootout);
    expect(d.overtime.minutes).not.toBe((base.overtime as { minutes: number }).minutes); // 10 ≠ the engine's 5: the preset is not a no-op
  });
  it("CK-SO-1 cricket: super over on in knockouts, untouched in leagues (league-on is the organiser's choice)", () => {
    for (const kind of BRACKET_KINDS) expect(stageDefaultsFor(cricket, kind, "t20")).toEqual({ superOver: true });
    expect(stageDefaultsFor(cricket, "league", "t20")).toEqual({});
  });
  it("another sport without a hook (tennis): {} everywhere", () => {
    const tennis = builtinModules.find((m) => m.key === "tennis")!;
    expect(tennis.stageDefaults).toBeUndefined();
    expect(stageDefaultsFor(tennis, "knockout", null)).toEqual({});
  });
});
```

In `cricket.test.ts`, inside the existing describe "cricket golden (d): tied T20 super over policies" (it owns `tiedMain`, `fold` and `t20`), beside "league tie without a super over stands as a tie":

```ts
it("CK-SO-1 a league stage with the super over ON plays it on every tie (ICC), never a plain tie", () => {
  const { cfg, events } = tiedMain("repeat");       // superOver: true — what a league stage stores when the organiser turns it on
  const state = fold(cfg, events);
  expect(state.outcome).toBeNull();                  // not { kind: "tie" }: the super over is owed
  expect(state.superOver).not.toBeNull();
  expect(fold(t20, events).outcome).toEqual({ kind: "tie" }); // positive pair: off → the tie stands
});
```
The engine fold is stage-kind blind (the cfg decides), so this pins the league half of CK-SO-1 without a new code path; it should be GREEN on first run (a characterisation, not a red), and the mutation in Step 5 must kill it.

Before Step 2, confirm the cricket `t20` and football `youth` keys in each module's `variants`. If a name differs, the assertion uses the declared key; the rule row's wording is what fixes the VALUE.

- [ ] **Step 2: Run it to verify it fails.**
  `cd /Users/ashokhein/github/seazn.club-worktrees/format-matrix-w2c/packages/engine && rm -f "$TMPDIR/w2c-t6e.json" && npx vitest run src/sport/stage-defaults.test.ts --reporter=json --outputFile="$TMPDIR/w2c-t6e.json"; echo EXIT=$?`
  Expected red: every preset assertion fails with `{}`. The 3-attempt fold returns `null` (no decision yet), because 5 is hard-coded.

- [ ] **Step 3: Implement.**
  - **football:**
    ```ts
    const KO_PRESET: Readonly<Record<string, Partial<FootballCfg>>> = { youth: { shootoutAttempts: 3 } };
    // on the module:
    stageDefaults: (kind, variant) =>
      (BRACKET_KINDS as readonly string[]).includes(kind)
        ? { extraTime: { enabled: true, halfMinutes: 15 }, shootout: true, shootoutAttempts: 5, ...(variant !== null && Object.hasOwn(KO_PRESET, variant) ? KO_PRESET[variant] : {}) }
        : {},
    ```
    `:1621` becomes `shootoutDecision(kicks, state.cfg.shootoutAttempts ?? 5)`. If the state carries cfg under another name, use that name; re-read the reducer's signature.
  - **hockey**, **icehockey** and **cricket** follow the table above, reading their constants from `this.variants` / `configSchema.parse({})` at module load.
  - Add `shootoutAttempts` to football's `ruleKeys` (match).
  - Then: `pnpm --filter @seazn/engine schema:snapshot`.

- [ ] **Step 4: Run** the new test, `src/sport/rule-keys.test.ts` (its stageDefaults sweep now has non-empty presets), the football suites `src/sports/football/football.test.ts` and `src/sports/football/football.domain.test.ts`, `src/sports/period/period.test.ts`, `src/sports/cricket/cricket.test.ts`, and the golden replay `src/testkit/golden.test.ts`. If the golden replay file has another name, find it with `git grep -l -a 'COVERAGE_CONFIGS' -- packages/engine/src`. Judge each. Then the web side:
  ```bash
  cd /Users/ashokhein/github/seazn.club-worktrees/format-matrix-w2c/apps/web && rm -f "$TMPDIR/w2c-t6.json" && npx vitest related --run src/lib/match-rules/football.ts src/lib/match-rules/cricket.ts --reporter=json --outputFile="$TMPDIR/w2c-t6.json"; echo EXIT=$?
  ```
  The contract names printed must be exactly `football` and `cricket`. Then engine `tsc`, and report the ids it proves with their test paths (the batch-end proof commit, **Execution**): X-SR-6, FB-SO-1, IH-KO-1 and CK-SO-1 if their titles now prove them.

- [ ] **Step 5: Mutate once** — `MUT/t6.json`, plus changed-lines Stryker over the four modules (groups `sports-football-*`, `sports-period-*`, `sports-cricket-*`):

```json
[
  { "id": "t6-attempts-read", "file": "packages/engine/src/sports/football/football.ts",
    "find": "state.cfg.shootoutAttempts ?? 5", "replace": "5",
    "killers": [{ "cwd": "packages/engine", "files": ["src/sport/stage-defaults.test.ts"], "name": "FB-SO-1 the shoot-out is decided after the stage" }] },
  { "id": "t6-ko-only", "file": "packages/engine/src/sports/football/football.ts",
    "find": "(BRACKET_KINDS as readonly string[]).includes(kind)", "replace": "true",
    "killers": [{ "cwd": "packages/engine", "files": ["src/sport/stage-defaults.test.ts"], "name": "table kinds get no preset" }] },
  { "id": "t6-league-superover", "file": "packages/engine/src/sports/cricket/cricket.ts",
    "find": "  if (state.cfg.superOver) {", "replace": "  if (false) {",
    "killers": [{ "cwd": "packages/engine", "files": ["src/sports/cricket/cricket.test.ts"], "name": "CK-SO-1 a league stage with the super over ON" }] }
]
```

- [ ] **Step 6: Commit** `feat(engine): knockout presets per sport; football shoot-out attempts per stage (X-SR-6, FB-SO-1, IH-KO-1, CK-SO-1)`, including the schema snapshot.

**Test types:**
- Unit: above.
- E2E: Task 17 `e2e/stage-rules-w2c.spec.ts` "X-SR-6 a new knockout stage shows its preset deciders, labelled as knockout defaults".
- Smoke: Task 12 `w2c: a new knockout stage stores its sport's deciders`.
- Regression: the football, period and cricket suites; golden replay unchanged (no stream edited).

**Sequence cases:** a table kind (empty preset) first; every bracket kind; a variant with its own preset (youth); another sport with no hook (tennis); absent key → today's 5.

---

### Task 7: Engine — "If a match is abandoned" options (E1, same loop as Task 6)

> **Owner P-7 "A" (2026-10-13).** An abandoned fixture (fold `abandoned`, `core.abandon`) inside a Swiss stage must not strand the stage. Today (main) `stages.ts:~1014` `DECIDED` omits `abandoned` → `generateStageFixtures` throws STAGE_NOT_READY, and settle on that board is refused SETTLE_NOT_APPLICABLE, so nothing unblocks it. Ruling A: the organiser can SETTLE an abandoned board (enter a result or a no-result) — make settle applicable to `abandoned`; the next round keeps waiting until it is settled (do NOT add `abandoned` to DECIDED). The STAGE_NOT_READY refusal must name the abandoned board(s) so the organiser knows what to settle. Red-first DB tests: chess Swiss round 1 with one board abandoned → next round refused naming it → settle it → next round generates; repeat for one other sport whose console offers Abandon inside a Swiss stage (grep it), and a league stage (settle on abandoned also allowed, no regression). Rule row: add to the abandon rows (owner-signed wording needed at batch-3 start — draft: "An abandoned match in a Swiss stage holds the next round until the organiser settles it.").

> **Carried from Task 4.** `abandonPolicy` is held in `UNSETTABLE` in `packages/engine/src/sport/rule-keys.test.ts` until this task declares it; delete those 3 rows (add the file to this task's Files) when the per-sport abandon options land.

Spec item 12; Q10; D9; HK-AB-2, CA-AB-2, GN-AB-2; ruling 117. Review fixes I4 (the Q4 predicate), I5 (ice hockey is never offered `q4_stands`), I6 (`share` under `allowDraws: false`; owner P-5).

**Files:**
- Modify: `packages/engine/src/sports/period/kernel.ts`:
  - `abandonPolicy: z.enum(["replay", "award", "q4_stands"])`, with a `.superRefine` that refuses `q4_stands` unless `periods.count === 4`, AND refuses any policy outside the sport's own `abandonOptions` list. Each period sport passes its list when it builds its schema from the kernel; re-read how `hockey.ts` and `icehockey.ts` construct their `configSchema` from the kernel (top of each file) and thread the list through that same construction.
  - `applyAbandon` (`:1447`).
  - `PERIOD_RULE_KEYS.abandonPolicy` (stage).
- Modify: `packages/engine/src/sports/hockey/hockey.ts`: `abandonOptions: ["replay", "award", "q4_stands"]`; the `fih-shootout` preset gains `abandonPolicy: "q4_stands"`.
- Modify: `packages/engine/src/sports/icehockey/icehockey.ts`: `abandonOptions: ["replay", "award"]` (review I5: `q4_stands` is a hockey rule).
- Modify: `packages/engine/src/sports/football/football.ts`: `abandonOptions: ["replay", "award"]`; `ruleKeys.abandonPolicy` (stage). The enum is unchanged.
- Modify: `packages/engine/src/sports/carrom/carrom.ts`, `generic/generic.ts`: `abandonPolicy: z.enum(["replay", "share"]).optional()`; `abandonOptions: ["replay", "share"]`; `applyAbandon` honours `share`; `ruleKeys.abandonPolicy` (stage, `appliesTo.stageKinds: DRAW_KINDS`). **Generic, per owner P-5:** generic's schema also refuses `share` when `allowDraws` is false ("Sharing the points needs draws to be allowed").
- Modify: the five affected `*.schema.json` (snapshot).
- Modify, web presentation: `apps/web/src/lib/match-rules/{football,hockey,icehockey,carrom,generic}.ts` each gain one `abandon` field: `{key: "abandon", label: "If a match is abandoned", kind: "select", edits: ["abandonPolicy"], options: abandonOptions(<module>), build: (v) => ({abandonPolicy: v})}`. `abandonOptions` and `ABANDON_LABELS` already exist in `shared.ts` from Task 5, so this task does not touch `shared.ts` (review M12). The web contract (Task 5) parses each option through the module's schema, so an option the schema refuses fails there.
- Create: `packages/engine/src/sport/abandon-options.test.ts`
- Create: `apps/web/src/server/engine-db/__tests__/abandon-share.test.ts` (review I6: the append-level case)
- Create: `MUT/t7.json`

**Interfaces:**
- Consumes:
  - Task 4's `SportModule.abandonOptions` type;
  - Task 5's `abandonOptions(module)` web helper;
  - W2b's award-policy abandon semantics: a win or draw on the real score, and HK-AB-1 (ruling 117), a level abandon where the cfg refuses a draw → `no_result`.

  **Re-read `applyAbandon` and the phase list (`period/kernel.ts:651-665`, `:708`) on the rebased tree before Step 3** (W2b changed them).
- Produces: `abandonOptions` on football, hockey, icehockey, carrom and generic; `abandonPolicy` in `ruleKeys` as stage scope; the web `abandon` field.

**The `q4_stands` predicate (review I4).** An abandon REPLAYS only when the last regulation period has not started: phase `pre`, or a regulation period before the last (and the interval before the last quarter, if the kernel has one). Once the 4th quarter has started, the result STANDS through the award path, and that includes overtime and the shoot-out. A level score there in a no-draw cfg is `no_result` (ruling 117). The first draft keyed on "phase !== last regulation period", which replayed an abandon during the shoot-out; that is the defect.

- [ ] **Step 1: Write the failing tests** — `packages/engine/src/sport/abandon-options.test.ts`

```ts
// P9 (spec §9) — every abandon option per sport. Expected outcomes come from
// the signed rows HK-AB-2, CA-AB-2, GN-AB-2 and ruling 117, not from applyAbandon.
import { describe, expect, it } from "vitest";
import { foldMatch, type EventEnvelope } from "../core/events.ts";
import { DRAW_KINDS } from "../core/types.ts";
import { hockey } from "../sports/hockey/index.ts";
import { icehockey } from "../sports/icehockey/index.ts";
import { carrom } from "../sports/carrom/index.ts";
import { generic } from "../sports/generic/index.ts";
import { builtinModules } from "../sports/index.ts";
import { defaultLineupPair, makeEnvelope } from "../testkit/index.ts";
import { stageKeysFor } from "./rule-keys.ts";

const ev = (specs: Array<[string, unknown?]>): EventEnvelope[] => specs.map(([type, payload], i) => makeEnvelope(i, { type, payload: payload ?? {} }));
const hk = defaultLineupPair(hockey.positions);
const HH = hk.home.entrantId;
const fih = (extra: object = {}) => hockey.configSchema.parse({ ...hockey.variants["fih-shootout"], ...extra });
const goal = (by: string): [string, unknown] => ["hockey.goal", { by }];
const adv = (to: string): [string, unknown] => ["hockey.period.advance", { to }];
// The kernel's shoot-out phase label is "SHOOTOUT" (period/kernel.ts:552, :648 on main: "OT1..OTk ... then SHOOTOUT").
const SO = "SHOOTOUT";
const toQ4 = (): Array<[string, unknown?]> => [["core.start"], adv("Q2"), adv("Q3"), adv("Q4")];

describe("HK-AB-2 hockey: replay before the 4th quarter, the result stands from it on", () => {
  it("the fih-shootout preset carries q4_stands", () => {
    expect(fih().abandonPolicy).toBe("q4_stands");
  });
  it("abandoned before the start (pre) → replay", () => {
    const s = foldMatch(hockey, fih(), hk, ev([["core.abandon", { reason: "weather" }]]));
    expect(s).toMatchObject({ phase: "abandoned", replayFlagged: true });
  });
  it("abandoned in Q3 → replay (no outcome, replay flagged)", () => {
    const s = foldMatch(hockey, fih(), hk, ev([["core.start"], goal(HH), adv("Q2"), adv("Q3"), ["core.abandon", { reason: "weather" }]]));
    expect(s.outcome ?? null).toBeNull();
    expect(s).toMatchObject({ phase: "abandoned", replayFlagged: true });
  });
  it("abandoned in Q4 while leading → the score stands as a win", () => {
    const s = foldMatch(hockey, fih(), hk, ev([["core.start"], goal(HH), adv("Q2"), adv("Q3"), adv("Q4"), ["core.abandon", { reason: "weather" }]]));
    expect(s.outcome).toMatchObject({ winner: HH });
  });
  it("ruling 117: abandoned level in Q4 in a no-draw cfg → no result", () => {
    const s = foldMatch(hockey, fih(), hk, ev([...toQ4(), ["core.abandon", { reason: "weather" }]]));
    expect(s.outcome).toEqual({ kind: "no_result" });
  });
  it("I4: abandoned in the SHOOT-OUT → stands (never a replay); level → no result", () => {
    const s = foldMatch(hockey, fih(), hk, ev([...toQ4(), adv(SO), ["core.abandon", { reason: "weather" }]]));
    expect((s as { replayFlagged?: boolean }).replayFlagged ?? false).toBe(false);
    expect(s.outcome).toEqual({ kind: "no_result" });
  });
  it("I4: the overtime branch is unreachable for hockey — no hockey variant has overtime (an assumption made a guard)", () => {
    let checked = 0;
    for (const [v, preset] of Object.entries(hockey.variants)) {
      expect(hockey.configSchema.parse(preset).overtime ?? null, v).toBeNull();
      checked++;
    }
    expect(checked).toBe(Object.keys(hockey.variants).length);
  });
  it("q4_stands is refused for a cfg without four periods", () => {
    expect(hockey.configSchema.safeParse({ ...hockey.variants["fih-shootout"], periods: { count: 2, minutes: 35 } }).success).toBe(false);
  });
});

describe("I5 q4_stands is a hockey option only", () => {
  it("hockey offers it; ice hockey neither offers nor parses it", () => {
    expect(hockey.abandonOptions).toContain("q4_stands");
    expect(icehockey.abandonOptions).not.toContain("q4_stands");
    let checked = 0;
    for (const preset of Object.values(icehockey.variants)) {
      expect(icehockey.configSchema.safeParse({ ...preset, abandonPolicy: "q4_stands" }).success).toBe(false);
      checked++;
    }
    expect(checked).toBe(Object.keys(icehockey.variants).length);
  });
});

describe("CA-AB-2 GN-AB-2 opt-in shared points on an abandon; default unchanged", () => {
  for (const m of [carrom, generic]) {
    it(`${m.key}: absent policy keeps today's outcome`, () => {
      expect(m.configSchema.parse({}).abandonPolicy).toBeUndefined();
    });
    it(`${m.key}: share is offered in table stages only`, () => {
      let checked = 0;
      for (const k of ["league", "knockout"] as const) {
        expect(stageKeysFor(m, k, null).includes("abandonPolicy"), k).toBe((DRAW_KINDS as readonly string[]).includes(k));
        checked++;
      }
      expect(checked).toBe(2);
    });
  }
  it("generic: share folds an abandon to a draw and KEEPS the non-zero score as it stood (2–1)", () => {
    const lu = defaultLineupPair(generic.positions);
    const cfg = generic.configSchema.parse({ ...generic.variants["score"], allowDraws: true, abandonPolicy: "share" });
    const s = foldMatch(generic, cfg, lu, ev([
      ["core.start"],
      ["generic.score", { by: lu.home.entrantId, points: 2 }],
      ["generic.score", { by: lu.away.entrantId, points: 1 }],
      ["core.abandon", { reason: "weather" }],
    ]));
    expect(s.outcome).toMatchObject({ kind: "draw" });
    expect(generic.summary(s).headline).toContain("2");          // the score as it stood, not rewritten to level
  });
  it("carrom: share folds an abandon to a draw", () => {
    const lu = defaultLineupPair(carrom.positions);
    const cfg = carrom.configSchema.parse({ abandonPolicy: "share" });
    const s = foldMatch(carrom as never, cfg as never, lu, ev([["core.start"], ["core.abandon", { reason: "weather" }]]));
    expect((s as { outcome: unknown }).outcome).toMatchObject({ kind: "draw" });
  });
  it("P-5: generic refuses share when draws are not allowed (config time)", () => {
    expect(generic.configSchema.safeParse({ ...generic.variants["score"], allowDraws: false, abandonPolicy: "share" }).success).toBe(false);
    expect(generic.configSchema.safeParse({ ...generic.variants["score"], allowDraws: true, abandonPolicy: "share" }).success).toBe(true); // positive pair
  });
});

describe("P9 sweep: every offered abandon option folds an abandon without throwing", () => {
  it("each sport × each of ITS options (counted against the declared lists)", () => {
    let checked = 0;
    let offered = 0;
    for (const m of builtinModules) {
      for (const v of m.abandonOptions ?? []) {
        offered++;
        const preset = Object.values(m.variants).find((p) => m.configSchema.safeParse({ ...p, abandonPolicy: v }).success);
        expect(preset, `${m.key}: no variant accepts its own option ${v}`).toBeDefined();
        const cfg = m.configSchema.parse({ ...preset, abandonPolicy: v });
        expect(() => foldMatch(m as never, cfg as never, defaultLineupPair(m.positions), ev([["core.start"], ["core.abandon", { reason: "weather" }]]))).not.toThrow();
        checked++;
      }
    }
    expect(offered).toBe(2 + 3 + 2 + 2 + 2); // football, hockey, icehockey, carrom, generic — from the Files list above
    expect(checked).toBe(offered);
  });
});
```
The carrom stream uses carrom's own required first events. If `core.start` alone does not open play, prepend the minimal opening its existing abandon test uses (`git grep -n -a abandon -- packages/engine/src/sports/carrom/carrom.test.ts`) and cite that line in a comment. `generic.summary(...).headline` is the module's own score line; if the module names it differently, read it from `generic.ts`'s `summary`.

The schema refinement above is the engine half of P-5. The write paths that surface it are tested below.

`apps/web/src/server/engine-db/__tests__/abandon-share.test.ts` (review I6 — the refusal lives at append time, so only an append-level test can see it):

```ts
import { afterAll, describe, expect, it } from "vitest";
import { sql } from "@/lib/db";
import { appendEvent } from "@/server/engine-db";
import { getDivision, patchDivision } from "@/server/usecases/divisions";
import { seedBracket } from "./helpers/seed-bracket";

const HAS_DB = !!process.env.DATABASE_URL;
afterAll(async () => { await (globalThis as { _sql?: { end(): Promise<void> } })._sql?.end(); });

async function liveGeneric(allowDraws: boolean) {
  const b = await seedBracket({ sport: "generic", variant: "score", stageKind: "league", entrants: 2 });
  // Division cfg carries the policy until Task 12 lets a stage store it; set it the way the division form would.
  await sql`update divisions d set config = d.config || ${sql.json({ allowDraws, abandonPolicy: "share" })}
            from stages s join fixtures f on f.stage_id = s.id where f.id = ${b.fixtureIds[0]!} and d.id = s.division_id`;
  const id = b.fixtureIds[0]!;
  const [f] = await sql<{ home: string; away: string }[]>`select home_entrant_id as home, away_entrant_id as away from fixtures where id = ${id}`;
  await appendEvent(b.auth.orgId, id, 0, { type: "core.start", payload: {} });
  await appendEvent(b.auth.orgId, id, 1, { type: "generic.score", payload: { by: f!.home, points: 2 } });
  await appendEvent(b.auth.orgId, id, 2, { type: "generic.score", payload: { by: f!.away, points: 1 } });
  return { b, id };
}

describe.skipIf(!HAS_DB)("GN-AB-2 share at append time (review I6)", () => {
  it("allowDraws on: a 2–1 abandon under share is accepted as a draw and decided", async () => {
    const { b, id } = await liveGeneric(true);
    const r = await appendEvent(b.auth.orgId, id, 3, { type: "core.abandon", payload: { reason: "weather" } });
    expect(r.outcome).toMatchObject({ kind: "draw" });
    expect(r.status).toBe("decided");
  });
  it("P-5: allowDraws off — the division write path refuses share with the owner's reason, and nothing is written", async () => {
    const b = await seedBracket({ sport: "generic", variant: "score", stageKind: "league", entrants: 2 });
    const before = await getDivision(b.auth, b.divisionId);
    const err = await patchDivision(b.auth, b.divisionId, { config: { ...(before.config as object), allowDraws: false, abandonPolicy: "share" } as never }).catch((e) => e);
    expect(err).toMatchObject({ status: 422, code: "CONFIG_INVALID" });
    expect(String(err.message)).toContain("Sharing the points needs draws to be allowed");
    expect((await getDivision(b.auth, b.divisionId)).config).toEqual(before.config);
    // positive pair: the same write with draws allowed saves
    await expect(patchDivision(b.auth, b.divisionId, { config: { ...(before.config as object), allowDraws: true, abandonPolicy: "share" } as never })).resolves.toBeDefined();
  });
});
```
- Re-review IMP-R2: the first draft asserted a refusal at the freeze, but append, fold and core never parse the cfg against the module's schema, so that case could not red. The refusal lives in the WRITE PATHS, and each is tested where it exists:
  - `patchDivision`, here, because it already parses the division cfg today. If it does not route the parse through `module.configSchema`, the case reds; that is a finding for Task 7 to fix inside `divisions.ts`, not a reason to weaken the case.
  - `putStageRules`, in Task 11's `stage-rules-every-sport.test.ts` (case "P-5 share needs draws");
  - `createStages`, in Task 12's stage-creation test (case "P-5 share needs draws").
- The first case's SQL write stands in for a division form save with draws ON, which every path accepts; it proves the fold and the append agree on a shared draw at a non-zero score.
- `seedBracket` returns `divisionId`; if it does not, read it from the stage row.

- [ ] **Step 2: Run to verify red** (`src/sport/abandon-options.test.ts`; judge; then the web DB file). Expected:
  - `q4_stands` is not in the enum, so the preset assertion fails;
  - `abandonOptions` is undefined;
  - `share` parses as an unknown key;
  - the append test's first case gets `no_result` (today's generic abandon, `generic.ts:570-575`), and the `patchDivision` case saves (no refinement yet).

- [ ] **Step 3: Implement.** In the period kernel's `applyAbandon`, prepend:
  ```ts
  if (state.cfg.abandonPolicy === "q4_stands") {
    const regs = periodLabels(state.cfg);                       // regulation periods in order (re-read :651-665)
    const last = regs[regs.length - 1];
    const lastStarted = state.phase === last || phaseAfterRegulation(state.phase); // pre, earlier quarters and intervals → false
    if (!lastStarted) return { ...state, phase: "abandoned", replayFlagged: true };
    // the 4th quarter has started (or play is in OT / the shoot-out): fall through to the award path (ruling 117's level → no_result included)
  }
  ```
  - `phaseAfterRegulation(phase)` is a small exported kernel helper: true for the kernel's overtime and shoot-out phases, read from the same phase list. It is unit-tested by the shoot-out case above.
  - An interval phase between Q3 and Q4, if the kernel has one, counts as before Q4.
  - The `.superRefine` refusing a policy outside the module's `abandonOptions`.
  - Carrom and generic: `share` returns `{...state, phase: "done", outcome: {kind: "draw"}}`, keeping the score as it stood (no score rewrite).
  - Generic (P-5): `.superRefine` refusing `share` with `allowDraws: false`, message "Sharing the points needs draws to be allowed".
  - Then the presets, `abandonOptions`, the `ruleKeys` entries, the web fields, and `schema:snapshot`.

- [ ] **Step 4: Run.**
  - Engine: the new test; `src/sport/rule-keys.test.ts`; `src/sports/period/period.test.ts`, `src/sports/carrom/carrom.test.ts`, `src/sports/generic/generic.test.ts` (they hold today's abandon cases); the golden replay.
  - Web: `abandon-share.test.ts` (DB; `pending == 0`). Then `npx vitest related --run src/lib/match-rules/football.ts src/lib/match-rules/hockey.ts src/lib/match-rules/icehockey.ts src/lib/match-rules/carrom.ts src/lib/match-rules/generic.ts --reporter=json --outputFile="$TMPDIR/w2c-t7.json"`. The contract names must be exactly those five sports.
  - `tsc` both sides; report the ids it proves with their test paths (the batch-end proof commit, **Execution**): HK-AB-2, CA-AB-2, GN-AB-2.

- [ ] **Step 5: Mutate once** — `MUT/t7.json`, plus changed-lines Stryker (`sports-period-*`, `sports-other-3..7`):

```json
[
  { "id": "t7-q4-gate", "file": "packages/engine/src/sports/period/kernel.ts",
    "find": "if (!lastStarted) return", "replace": "if (false) return",
    "killers": [{ "cwd": "packages/engine", "files": ["src/sport/abandon-options.test.ts"], "name": "abandoned in Q3" }] },
  { "id": "t7-q4-shootout", "file": "packages/engine/src/sports/period/kernel.ts",
    "find": "phaseAfterRegulation(state.phase)", "replace": "false",
    "killers": [{ "cwd": "packages/engine", "files": ["src/sport/abandon-options.test.ts"], "name": "I4: abandoned in the SHOOT-OUT" }] },
  { "id": "t7-ice-options", "file": "packages/engine/src/sports/icehockey/icehockey.ts",
    "find": "abandonOptions: [\"replay\", \"award\"]", "replace": "abandonOptions: [\"replay\", \"award\", \"q4_stands\"]",
    "killers": [{ "cwd": "packages/engine", "files": ["src/sport/abandon-options.test.ts"], "name": "I5 q4_stands is a hockey option only" }] },
  { "id": "t7-share-kind", "file": "packages/engine/src/sports/carrom/carrom.ts",
    "find": "appliesTo: { stageKinds: DRAW_KINDS }", "replace": "appliesTo: undefined",
    "killers": [{ "cwd": "packages/engine", "files": ["src/sport/abandon-options.test.ts"], "name": "carrom: share is offered in table stages only" }] }
]
```
If `period/kernel.ts` does not take the sport's option list in a form the third mutant can reach, it targets the kernel's `.superRefine` line that checks the list instead. Its killer stays the same.

- [ ] **Step 6: Commit** `feat(engine): abandon options per stage — replay, result stands, Q4 rule, share (HK-AB-2, CA-AB-2, GN-AB-2)`.

**Test types:**
- Unit: above, including the append-level `abandon-share.test.ts`.
- E2E: Task 17 "X-SR-1 abandon options follow the sport" (the select's option list per sport).
- Smoke: Task 11 `w2c: a hockey stage saves q4_stands`.
- Regression: the period, carrom and generic suites; golden replay; HK-AB-1 (W2b's) proving test unchanged.

**Sequence cases:**
- the absent policy (today) first;
- each option;
- pre, Q3, Q4 and the shoot-out;
- level vs leading;
- a non-zero score under `share`;
- `allowDraws` off;
- another sport (carrom, generic, football, ice hockey);
- a preset that cannot take `q4_stands`.

---

### Task 8: Engine — chess tie-break rungs and Armageddon colours (lane E2)

> **Carried from Task 4 review (G1).** Under the resolver order (`division ⊕ stage.rules ⊕ bracketDeciders(kind) ⊕ override`), boardgame `bracketDeciders` → `{tiebreak:true}` (`boardgame.ts:~986`) always overwrites the stage's `tiebreak` key, so a stage can never switch it off. With `tiebreakRungs`, make the stage's list authoritative (empty list = held for the organiser, BG-KO-3/X-SR-6): `bracketDeciders` must not resurrect a rung or a decider the stage turned off. Red-first test through `resolveFixtureCfg` with a stage whose list is empty; coordinate with Task 13b, which owns the overlay.

Spec item 13; BG-KO-3, BG-KO-2 (enforced); D7, D8; P8 engine half.

**Files:**
- Modify: `packages/engine/src/sports/boardgame/boardgame.ts`:
  - cfg (`:84` area): `tiebreakRungs: z.array(z.enum(TIEBREAK_RUNGS)).max(TIEBREAK_RUNGS.length).optional()` refined to unique;
  - `BoardgameTiebreak` (`:195-203`): a discriminated union. Rapid and blitz keep `{rung, winner, score?}`; Armageddon becomes `{rung: "armageddon", black: EntrantId, result: "white" | "black" | "draw"}`;
  - `applyTiebreak` (`:354-366`): the winner for Armageddon is DERIVED (`result === "white"` → the non-black entrant, `"black"` or `"draw"` → `black`). The Armageddon colour is stored in a NEW OPTIONAL fold field `armageddonBlack?: EntrantId`, ABSENT from the state until an Armageddon is recorded (never `null` in init), so every existing boardgame golden state replays byte-identical (review I11). Never `colorOfHome`. A rung outside the cfg's list is refused `TIEBREAK_NOT_APPLICABLE`;
  - the phase switch (`:297`): a draw goes to phase `tiebreak` only when the effective rung list (cfg value ?? `TIEBREAK_RUNGS`) is non-empty;
  - `awaitingDecider` (`:879`): unchanged predicate (`phase === "tiebreak"`), now unreachable for an empty list;
  - `ruleKeys.tiebreakRungs` (stage, `appliesTo.stageKinds: BRACKET_KINDS`).
  - `export function effectiveRungs(cfg): readonly TiebreakRung[]` = `cfg.tiebreakRungs ?? TIEBREAK_RUNGS`, IN THE STAGE'S ORDER (never re-sorted to `TIEBREAK_RUNGS` order). The phase gate, the rung check and Task 21's sheet all read it (review I12).
- Modify: `packages/engine/src/core/errors.ts`: append `TIEBREAK_COLOUR_REQUIRED` (last, so the frozen-order test only grows); `packages/engine/src/core/errors.test.ts`: append it to the frozen list.
- Modify: `packages/engine/src/sports/boardgame/tiebreak.test.ts`: the three cases that send the old Armageddon shape are updated to `{black, result}` (greenfield, finding 24).
- Modify: `apps/web/src/server/usecases/__tests__/withdrawal-decider-hold.test.ts:214`: its Armageddon sender moves to `{black, result}` (review I10). The other old-shape sender, `scripts/smoke.ts:2406`, is moved by Task 11, which owns `smoke.ts` (this lane may run while lane F edits it).
- Modify: `packages/engine/src/sports/boardgame/boardgame.schema.json` (snapshot); `packages/engine/src/testkit/golden.ts` (`COVERAGE_CONFIGS` gains one bracket cfg with `tiebreakRungs: ["armageddon"]`), committed alone with `EXTEND_GOLDEN=1`.
- Modify: `apps/web/src/server/api-v1/http.ts:22` (`TIEBREAK_COLOUR_REQUIRED: 422`); `apps/web/src/lib/scoring-vocab.ts:596` (its `engineError.TIEBREAK_COLOUR_REQUIRED` key); `apps/web/src/dictionaries/{en,es,fr,nl}/ui.json` (`engineError.TIEBREAK_COLOUR_REQUIRED`: en "Record who had Black." with es/fr/nl translations); then `pnpm i18n:gen-keys`.
- Modify: `apps/web/src/lib/match-rules/boardgame.ts`: field `tiebreakRungs`. This is a `kind: "sequence"` control (the kind itself was added to `types.ts` by Task 5, review M12): an ordered subset of fixed options. The field has `options` = the three rungs with labels "Rapid game", "Blitz game", "Armageddon", `edits: ["tiebreakRungs"]`, and `build: (v) => ({tiebreakRungs: v === "" ? [] : v.split(",")})`. The value travels as a comma-joined string, so `values: Record<string,string>` is unchanged.
- Create: `MUT/t8.json`
- Do NOT touch: `colorOfHome`, `boardgame.tsx` skin (Task 21), any other sport.

**Interfaces:**
- Consumes: Task 4/5 contracts.
- Produces:
  - `BoardgameTiebreak` (the union above);
  - fold field `armageddonBlack?: EntrantId` (optional, absent unless set);
  - `effectiveRungs(cfg)`;
  - `TIEBREAK_COLOUR_REQUIRED`;
  - the boardgame `tiebreakRungs` web field.

- [ ] **Step 1: Write the failing tests.** Append to `packages/engine/src/sports/boardgame/tiebreak.test.ts`, which reuses its own `ev`, `lineups`, `H`, `A`, `ko`, `drawn`, `fold`, `codeOf` helpers (`:1-25`); add `effectiveRungs` and `TIEBREAK_RUNGS` to its `./boardgame.ts` import:

```ts
const koWith = (rungs: readonly string[]) => boardgame.configSchema.parse({ ...boardgame.bracketDeciders(boardgame.configSchema.parse({})), tiebreakRungs: rungs });
const arm = (seq: number, black: string, result: "white" | "black" | "draw") => ev(seq, "boardgame.tiebreak", { rung: "armageddon", black, result });

describe("BG-KO-3 a stage chooses its tie-break rungs and their order", () => {
  it("absent list = every rung in TIEBREAK_RUNGS order (today)", () => {
    expect(boardgame.configSchema.parse({}).tiebreakRungs).toBeUndefined();
    expect(fold(ko, drawn).phase).toBe("tiebreak");
  });
  it("empty list: a drawn bracket game is level, not awaiting a decider (ruling 79 hold applies)", () => {
    const s = fold(koWith([]), drawn);
    expect(s.phase).not.toBe("tiebreak");
    expect(boardgame.awaitingDecider!(s as never)).toBe(false);
    expect(s.outcome).toMatchObject({ kind: "draw" });
  });
  it("a rung outside the stage's list is refused TIEBREAK_NOT_APPLICABLE", () => {
    expect(codeOf(() => fold(koWith(["armageddon"]), [...drawn, ev(3, "boardgame.tiebreak", { rung: "rapid", winner: H })]))).toBe("TIEBREAK_NOT_APPLICABLE");
  });
  it("duplicates are refused by the schema; order is kept", () => {
    expect(boardgame.configSchema.safeParse({ tiebreakRungs: ["blitz", "blitz"] }).success).toBe(false);
    expect(koWith(["blitz", "rapid"]).tiebreakRungs).toEqual(["blitz", "rapid"]);
  });
  it("I12: the stage's order is the order played — [blitz, rapid] is NOT re-sorted to TIEBREAK_RUNGS order", () => {
    expect(TIEBREAK_RUNGS.indexOf("rapid")).toBeLessThan(TIEBREAK_RUNGS.indexOf("blitz")); // precondition: the canonical order differs
    expect(effectiveRungs(koWith(["blitz", "rapid"]))).toEqual(["blitz", "rapid"]);
    expect(effectiveRungs(koWith([]))).toEqual([]);
    expect(effectiveRungs(boardgame.configSchema.parse({}))).toEqual([...TIEBREAK_RUNGS]);
  });
});

describe("BG-KO-2 a drawn Armageddon is won by the recorded Black (P8 engine half)", () => {
  it("White wins → the non-black entrant advances", () => {
    expect(fold(koWith(["armageddon"]), [...drawn, arm(3, A, "white")]).outcome).toMatchObject({ kind: "win", winner: H, method: "tiebreak_armageddon" });
  });
  it("Black wins → black advances", () => {
    expect(fold(koWith(["armageddon"]), [...drawn, arm(3, A, "black")]).outcome).toMatchObject({ winner: A });
  });
  it("drawn → black advances (the rule this row exists for; differs from a 'home advances' constant)", () => {
    expect(fold(koWith(["armageddon"]), [...drawn, arm(3, A, "draw")]).outcome).toMatchObject({ winner: A });
    expect(fold(koWith(["armageddon"]), [...drawn, arm(3, H, "draw")]).outcome).toMatchObject({ winner: H });
  });
  it("the colour lives in its own field, never colorOfHome", () => {
    const s = fold(koWith(["armageddon"]), [...drawn, arm(3, A, "draw")]) as { armageddonBlack: string; colorOfHome?: unknown };
    const before = fold(koWith(["armageddon"]), drawn) as { colorOfHome?: unknown };
    expect(s.armageddonBlack).toBe(A);
    expect(s.colorOfHome).toEqual(before.colorOfHome);
  });
  it("I11: a fold with no Armageddon carries NO armageddonBlack key (goldens replay byte-identical)", () => {
    expect(Object.hasOwn(fold(ko, drawn), "armageddonBlack")).toBe(false);
    expect(Object.hasOwn(fold(koWith(["rapid"]), [...drawn, ev(3, "boardgame.tiebreak", { rung: "rapid", winner: H })]), "armageddonBlack")).toBe(false);
  });
  it("an Armageddon without black is refused TIEBREAK_COLOUR_REQUIRED", () => {
    expect(codeOf(() => fold(koWith(["armageddon"]), [...drawn, ev(3, "boardgame.tiebreak", { rung: "armageddon", result: "draw" })]))).toBe("TIEBREAK_COLOUR_REQUIRED");
  });
  it("a black who is not in the match is refused", () => {
    expect(codeOf(() => fold(koWith(["armageddon"]), [...drawn, arm(3, "nobody", "draw")]))).not.toBeNull();
  });
  it("after a void of the Armageddon event the match is awaiting a decider again", () => {
    const s = fold(koWith(["armageddon"]), [...drawn, arm(3, A, "draw"), ev(4, "core.void", {}, "e-3")   /* makeEnvelope ids are `e-${seq}` (testkit/helpers.ts:13) */]);
    expect(s.phase).toBe("tiebreak");
  });
});
```

Add a rule-10 sequence property in the same file:

```ts
describe("rule 10 — rungs × draw × tiebreak events", () => {
  it("after every prefix: awaitingDecider ⇔ phase tiebreak, and a decided match names a winner from the lineups", () => {
    let runs = 0;
    fc.assert(fc.property(
      fc.subarray([...TIEBREAK_RUNGS], { minLength: 0 }),
      fc.array(fc.record({ rung: fc.constantFrom(...TIEBREAK_RUNGS), black: fc.constantFrom(H, A), result: fc.constantFrom("white", "black", "draw") }), { maxLength: 3 }),
      (rungs, attempts) => {
        runs++;
        const events = [...drawn];
        for (const a of attempts) {
          const payload = a.rung === "armageddon" ? { rung: a.rung, black: a.black, result: a.result } : { rung: a.rung, winner: a.black };
          const next = [...events, ev(events.length + 1, "boardgame.tiebreak", payload)];
          if (codeOf(() => fold(koWith(rungs), next)) !== null) break;
          events.push(next[next.length - 1]!);
          const s = fold(koWith(rungs), events);
          expect(boardgame.awaitingDecider!(s as never)).toBe(s.phase === "tiebreak");
          if (s.outcome?.kind === "win") expect([H, A]).toContain(s.outcome.winner);
        }
      },
    ), { seed: 20261013, numRuns: 200 });
    expect(runs).toBe(200);
  });
});
```

- [ ] **Step 2: Run to verify red** (engine `src/sports/boardgame/tiebreak.test.ts` and `src/core/errors.test.ts`). Expected: the schema strips `tiebreakRungs`, the old union accepts no `black`, and `TIEBREAK_COLOUR_REQUIRED` is not a code.

- [ ] **Step 3: Implement** as listed in **Files**. The effective list is `cfg.tiebreakRungs ?? TIEBREAK_RUNGS`. Then:
  - `schema:snapshot`;
  - the golden coverage entry, as a commit of its own with `EXTEND_GOLDEN=1`;
  - the web field (the `"sequence"` kind exists since Task 5). `MatchRuleFields` renders "sequence" in Task 17; until then, `match-rules.tsx` renders nothing for an unknown kind. Confirm that by reading its switch and record it;
  - the http/vocab/dictionary rows and `pnpm i18n:gen-keys`.

- [ ] **Step 4: Run.**
  - Engine: `tiebreak.test.ts`, `boardgame.test.ts`, `errors.test.ts`, `rule-keys.test.ts`, the golden replay. Every pre-existing boardgame golden stream must replay BYTE-IDENTICAL (review I11); a diff there means `armageddonBlack` leaked into init.
  - Web: `withdrawal-decider-hold.test.ts` (DB, `pending == 0`); `npx vitest related --run src/lib/match-rules/boardgame.ts …` (contract names: exactly `boardgame`), `src/lib/__tests__/scoring-vocab*.test.ts` (the vocab coverage test, found with `git grep -l -a ENGINE_ERROR_KEY -- apps/web/src/lib/__tests__`), and `pnpm i18n:check`.
  - `tsc` both sides; `rules-reference.test.ts`.

- [ ] **Step 5: Mutate once** — `MUT/t8.json`, plus changed-lines Stryker (`sports-other-1/2`):

```json
[
  { "id": "t8-draw-to-black", "file": "packages/engine/src/sports/boardgame/boardgame.ts",
    "find": "result === \"white\" ?", "replace": "result !== \"black\" ?",
    "killers": [{ "cwd": "packages/engine", "files": ["src/sports/boardgame/tiebreak.test.ts"], "name": "drawn → black advances" }] },
  { "id": "t8-empty-list", "file": "packages/engine/src/sports/boardgame/boardgame.ts",
    "find": "rungs.length > 0", "replace": "true",
    "killers": [{ "cwd": "packages/engine", "files": ["src/sports/boardgame/tiebreak.test.ts"], "name": "empty list: a drawn bracket game is level" }] },
  { "id": "t8-colour-required", "file": "packages/engine/src/sports/boardgame/boardgame.ts",
    "find": "throw new EngineError(\"TIEBREAK_COLOUR_REQUIRED\"", "replace": "if (false) throw new EngineError(\"TIEBREAK_COLOUR_REQUIRED\"",
    "killers": [{ "cwd": "packages/engine", "files": ["src/sports/boardgame/tiebreak.test.ts"], "name": "without black is refused" }] },
  { "id": "t8-order", "file": "packages/engine/src/sports/boardgame/boardgame.ts",
    "find": "cfg.tiebreakRungs ?? TIEBREAK_RUNGS", "replace": "TIEBREAK_RUNGS.filter((r) => (cfg.tiebreakRungs ?? TIEBREAK_RUNGS).includes(r))",
    "killers": [{ "cwd": "packages/engine", "files": ["src/sports/boardgame/tiebreak.test.ts"], "name": "I12: the stage's order is the order played" }] }
]
```
The `find` strings assume the implementation uses `rungs.length > 0` for the phase gate and the derivation `result === "white" ? <non-black> : black`. The implementer writes the code in that form, so the mutants address it.

- [ ] **Step 6: Commit** `feat(engine): chess tie-break rungs per stage; Armageddon records Black (BG-KO-3, BG-KO-2)`. The golden extension is its own earlier commit.

**Test types:**
- Unit: above, including the rule-10 property.
- E2E: Task 21 `e2e/bracket-finish.spec.ts` "BG-KO-2 the Armageddon sheet records Black and advances Black on a draw" (the seam: the pad's emitted event is folded by the real module); Task 23's cross-programme P8.
- Smoke: Task 11 `w2c: a chess knockout stage saves an empty rung list`.
- Regression: `boardgame.test.ts`; `errors.test.ts` frozen order; golden replay.

**Sequence cases:** absent list first; empty list; a single rung; a reordered list; draw → Armageddon → void → awaiting again; another rung refused; another sport unaffected (the frozen `errors.test.ts` covers every module's codes).

---
### Task 9: Stage points — a forfeit is an award with NOTHING PLAYED; the awarded score replaces; inexpressible rules (lane E3, **BLOCKED until rebase on W2b merge and lane F merged**)

Spec items 10 (refusal half) and 11 as amended at `1b757c6cb`; Q1, Q9; owner P-3 "A"; X-PT-1; P6. Review fix I7: the first draft's premise was false. A stored award outcome `{kind, winner, loser|null, reason}` carries NO played marker (`core/types.ts:136-195`), so the played fact must come from the ledger.

**Files:**
- Modify: `packages/engine/src/competition/points.ts`: `applyPointsRule(outcome, pair, rule, played)` (new REQUIRED 4th parameter, so `tsc` lists every caller); `isForfeit` (`:57`) becomes `isUnplayedForfeit(outcome, played)`; the `awardScore` block (W2b `:149-154`) REPLACES; new `pointsRuleExpressible`.
- Modify, every caller (Task 3 Step 3's list; `tsc` is the check):
  - `apps/web/src/server/engine-db/competition.ts:395` (the standings fold): pass the fixture's played fact, computed with W2b's `playRecorded(ledger, module)` (`E/core/events.ts:354`; rulings 112–115, 118, 120) over the fixture's `score_events`. Load the ledgers of every FORFEIT-SHAPED fixture, i.e. those where `forfeitShaped(outcome)` is true: an award, OR a win whose method is `walkover`/`forfeit`. Chess's `boardgame.result {method: "forfeit"}` still decides `win{method: "forfeit"}`, not an award (W2b `boardgame.ts:298`, `:316-325`; only `core.forfeit` became an award, `:348`), and loading awards only would have passed it `played = false` after a played game (re-review minor). Use one query per stage (`select fixture_id, id, type, voids_event_id as voids from score_events where fixture_id = any(${forfeitShapedIds}) order by fixture_id, seq`). If W2b's `engine-db/awarded-state.ts` already derives this fact for a fixture, call that instead: one authority, never a second predicate.
  - `:115` (the bye path): `played = false`. A bye is told apart by `isBye`, not by the flag.
  - `packages/engine/src/testkit/scenarios.ts:377`: compute `playRecorded` over the scenario's own events.
  - `tools/bench/lib/validate-pack.ts`: compute `playRecorded` over the pack fixture's events if the pack carries them. If a pack carries only outcomes, pass `false` (an award with no ledger had nothing played) and say so in a comment citing this task. (Do-not-touch covers only `run-suite.ts` / `PackSchema`.)
- Modify: `apps/web/src/server/public-site/qualification-view.ts` (W2b `:179`, `:187-199`). `ruleScoresForfeits` today assumes "every award carries" the rule's score, ADDED. It becomes a per-fixture `ruleScoreReaches(f, meta)`: true only for an unplayed, non-bye award under a rule with a non-zero `awardScore`. `QualFixture` gains `played: boolean`, set by its loader from the same `playRecorded` read (re-read the loader on the rebased tree: `git grep -n -a "QualFixture" -- apps/web/src/server`).
- Create: `packages/engine/src/competition/points-w2c.test.ts`
- Create: `apps/web/src/server/public-site/__tests__/qualification-points-parity.test.ts`
- Modify (existing tests the new 4th parameter or the replace rule breaks; greenfield updates, each named in the report): `packages/engine/src/competition/points.test.ts`, `packages/engine/src/competition/w2b-tables.test.ts`, `packages/engine/src/competition/tiebreak-rule-award-alias.test.ts`, `apps/web/src/server/public-site/__tests__/qualification-view.test.ts:1232-1306` (re-pin each path and range on the rebased tree; `tsc` lists the call sites). Each call gains its `played` value, taken from the case's own ledger or, for an outcome-only fixture, `false` with a comment.
- Modify: `apps/web/src/server/engine-db/__tests__/` — the standings suite that covers awards (`git grep -l -a "awardScore" -- apps/web/src/server/engine-db/__tests__`) gains one DB case (below).
- Create: `MUT/t9.json`
- Do NOT touch: the module `forfeitCredit` hooks (W2b's); `stage.ts`; `playRecorded` itself.

**Interfaces:**
- Consumes:
  - `playRecorded(ledger, module)` (W2b, `@seazn/engine/core`);
  - `awardReasonOf(outcome)` → `"walkover" | "retired" | "disqualified" | "withdrew" | "bye"`;
  - `PointsRule`, `FixtureResult`, `MatchOutcome`.
- Produces:
  ```ts
  /** P-3 "A": a forfeit under a stage PointsRule is an award with NOTHING PLAYED, whatever its reason; never a bye. */
  export function isUnplayedForfeit(outcome: MatchOutcome, played: boolean): boolean;
  /** The outcomes whose `played` fact matters: an award, or a win by walkover/forfeit. Callers load ledgers for exactly these. */
  export function forfeitShaped(outcome: MatchOutcome): boolean;
  export function applyPointsRule(outcome: MatchOutcome, pair: FixtureResult, rule: PointsRule, played: boolean): FixtureResult;
  export type Expressible = { readonly ok: true } | { readonly ok: false; readonly keys: readonly string[]; readonly reason: string };
  /** Q1: a stage PointsRule (win/draw/loss + bonuses + forfeit) cannot express the division's split points. */
  export function pointsRuleExpressible(divisionCfg: unknown): Expressible;
  // qualification-view.ts
  export function ruleScoreReaches(f: Pick<QualFixture, "outcome" | "played" | "home_entrant_id" | "away_entrant_id">, meta: StageQualMeta): boolean;
  ```

**Behaviour (owner P-3 "A"; spec X-PT-1 at `1b757c6cb`).**

| Outcome | `played` | Stage rule `forfeit` set | Points | Metrics |
|---|---|---|---|---|
| award, any reason except `bye` (walkover, withdrew, disqualified, retired) | false | yes | `forfeit.winnerPoints` / `loserPoints` | `awardScore` **replaces** for/against/diff when set; otherwise the sport's credit stands |
| award, any reason except `bye` | true | yes | `base.win` / `base.loss` (S3's note: "retirement, DQ or withdrawal after play earns normal points") | the sport's credit (ruling 124 for generic) |
| award `bye` | false | yes | `forfeit.winnerPoints` for the advancer (today's) | NEVER `awardScore` |
| win, method `walkover` or `forfeit` (football/kernel) | false | yes | as an unplayed award | as an unplayed award |
| any | any | no forfeit row | base points | unchanged |

- [ ] **Step 1: Write the failing tests.** `packages/engine/src/competition/points-w2c.test.ts`:

```ts
// X-PT-1 (Q9, owner P-3 "A") and Q1. Expected values come from the signed rule row and the rule's own fields;
// the award shapes from W2b's AWARD_REASONS; the played fact from W2b's playRecorded over a real ledger.
import { describe, expect, it } from "vitest";
import { AWARD_REASONS, type MatchOutcome } from "../core/types.ts";
import { playRecorded } from "../core/events.ts";
import { builtinModules } from "../sports/index.ts";
import { applyPointsRule, forfeitShaped, isUnplayedForfeit, pointsRuleExpressible, PointsRule } from "./points.ts";

const rule = PointsRule.parse({ base: { win: 3, draw: 1, loss: 0 }, forfeit: { winnerPoints: 2, loserPoints: -1, awardScore: [5, 0] } });
const delta = (entrantId: string, won: 0 | 1, lost: 0 | 1, gf: number, ga: number) =>
  ({ entrantId, won, drawn: 0, lost, points: 0, metrics: { for: gf, against: ga, diff: gf - ga } });
const pair = (gf: number, ga: number) => [delta("H", 1, 0, gf, ga), delta("A", 0, 1, ga, gf)] as never;
const award = (reason: string): MatchOutcome => ({ kind: "award", winner: "H", loser: reason === "bye" ? null : "A", reason }) as never;
type D = ReturnType<typeof delta>;
const apply = (o: MatchOutcome, p: never, played: boolean, r = rule) => applyPointsRule(o, p, r, played) as unknown as D[];

// The played fact is read from ledgers through the ONE authority, never typed in:
const football = builtinModules.find((m) => m.key === "football")!;
const NOTHING = playRecorded([{ id: "1", type: "core.start" }, { id: "2", type: "core.forfeit" }], football);
const SOMETHING = playRecorded([{ id: "1", type: "core.start" }, { id: "2", type: "football.goal" }, { id: "3", type: "core.forfeit" }], football);

describe("X-PT-1 a forfeit is an award with nothing played, whatever its reason", () => {
  it("preconditions: the ledgers read as intended through playRecorded", () => {
    expect(NOTHING).toBe(false);
    expect(SOMETHING).toBe(true);
  });
  it("covers every award reason W2b declares (counted)", () => {
    expect([...AWARD_REASONS].sort()).toEqual(["bye", "disqualified", "retired", "walkover", "withdrew"]);
  });
  it("every non-bye reason with nothing played pays the forfeit row, and its awarded score REPLACES the credit", () => {
    let checked = 0;
    for (const reason of AWARD_REASONS.filter((r) => r !== "bye")) {
      const [h, a] = apply(award(reason), pair(3, 0), NOTHING);
      expect([h.points, a.points], reason).toEqual([rule.forfeit!.winnerPoints, rule.forfeit!.loserPoints]);
      expect(h.metrics, reason).toEqual({ for: 5, against: 0, diff: 5 }); // replaced: not 3 + 5
      expect(a.metrics, reason).toEqual({ for: 0, against: 5, diff: -5 });
      checked++;
    }
    expect(checked).toBe(AWARD_REASONS.length - 1);
  });
  it("every non-bye reason AFTER play earns normal points and keeps the sport's credit (Q9)", () => {
    let checked = 0;
    for (const reason of AWARD_REASONS.filter((r) => r !== "bye")) {
      const [h, a] = apply(award(reason), pair(2, 1), SOMETHING);
      expect([h.points, a.points], reason).toEqual([rule.base.win, rule.base.loss]);
      expect(h.metrics, reason).toEqual({ for: 2, against: 1, diff: 1 });
      checked++;
    }
    expect(checked).toBe(AWARD_REASONS.length - 1);
  });
  it("a bye keeps the forfeit row's points but NEVER the awarded score", () => {
    const [h] = apply(award("bye"), pair(0, 0), NOTHING);
    expect(h.points).toBe(rule.forfeit!.winnerPoints);
    expect(h.metrics).toEqual({ for: 0, against: 0, diff: 0 });
    expect(isUnplayedForfeit(award("bye"), NOTHING)).toBe(false);
  });
  it("a rule with no forfeit row pays base points to every award (the empty case)", () => {
    const plain = PointsRule.parse({ base: { win: 3, draw: 1, loss: 0 } });
    expect(apply(award("walkover"), pair(0, 0), NOTHING, plain)[0]!.points).toBe(plain.base.win);
  });
  it("forfeitShaped covers a win by forfeit (chess) as well as awards; a regulation win is not", () => {
    expect(forfeitShaped({ kind: "win", winner: "H", loser: "A", method: "forfeit" } as never)).toBe(true);
    expect(forfeitShaped({ kind: "win", winner: "H", loser: "A", method: "walkover" } as never)).toBe(true);
    expect(forfeitShaped(award("withdrew"))).toBe(true);
    expect(forfeitShaped({ kind: "win", winner: "H", loser: "A", method: "regulation" } as never)).toBe(false);
  });
  it("a chess win by forfeit AFTER moves were played earns normal points (the played flag reaches win outcomes)", () => {
    const won = { kind: "win", winner: "H", loser: "A", method: "forfeit" } as never;
    expect(isUnplayedForfeit(won, SOMETHING)).toBe(false);
    expect(apply(won, pair(1, 0), SOMETHING)[0]!.points).toBe(rule.base.win);
    expect(apply(won, pair(1, 0), NOTHING)[0]!.points).toBe(rule.forfeit!.winnerPoints);
  });
  it("a football walkover win method is a forfeit; a regulation win is not", () => {
    expect(isUnplayedForfeit({ kind: "win", winner: "H", loser: "A", method: "walkover" } as never, NOTHING)).toBe(true);
    expect(isUnplayedForfeit({ kind: "win", winner: "H", loser: "A", method: "regulation" } as never, SOMETHING)).toBe(false);
  });
  it("a double walkover stays 0 points for both whatever the flag (X-DW-4 unchanged)", () => {
    const [h, a] = apply({ kind: "double_walkover" } as never, pair(0, 0), NOTHING);
    expect([h.points, a.points]).toEqual([0, 0]);
  });
});

describe("Q1 pointsRuleExpressible — refused, never silently dropped", () => {
  it("every builtin division default: the result is decided by its split-points keys (counted)", () => {
    let checked = 0;
    for (const m of builtinModules)
      for (const preset of [{}, ...Object.values(m.variants)]) {
        const cfg = m.configSchema.parse(preset) as { points?: Record<string, unknown> };
        const split = Object.keys(cfg.points ?? {}).filter((k) => !["win", "draw", "loss", "w", "d", "l"].includes(k) && cfg.points![k] != null);
        expect(pointsRuleExpressible(cfg).ok, `${m.key}`).toBe(split.length === 0);
        checked++;
      }
    expect(checked).toBeGreaterThan(builtinModules.length);
  });
  it("ice hockey's OT/SO split is named in the refusal", () => {
    const ice = builtinModules.find((m) => m.key === "icehockey")!;
    const r = pointsRuleExpressible(ice.configSchema.parse({}));
    expect(r).toMatchObject({ ok: false, keys: expect.arrayContaining(["otWin", "otLoss"]) });
  });
  it("empty / null division cfg is expressible", () => {
    expect(pointsRuleExpressible({})).toEqual({ ok: true });
    expect(pointsRuleExpressible(null)).toEqual({ ok: true });
  });
});
```
Re-read the ice-hockey split keys (`otWin`, `otLoss`) from its `points` schema before running; the refusal must name the keys the schema actually declares.

`apps/web/src/server/public-site/__tests__/qualification-points-parity.test.ts` — the public calculator and the standings fold must agree (one rule, two readers):

```ts
import { describe, expect, it } from "vitest";
import { AWARD_REASONS } from "@seazn/engine/core";
import { applyPointsRule, PointsRule } from "@seazn/engine/competition";
import { ruleScoreReaches } from "../qualification-view";

const rule = PointsRule.parse({ base: { win: 3, draw: 1, loss: 0 }, forfeit: { winnerPoints: 2, loserPoints: 0, awardScore: [3, 0] } });
const meta = { pointsRule: rule } as never;
const pair = [
  { entrantId: "H", won: 1, drawn: 0, lost: 0, points: 0, metrics: { for: 1, against: 0, diff: 1 } },
  { entrantId: "A", won: 0, drawn: 0, lost: 1, points: 0, metrics: { for: 0, against: 1, diff: -1 } },
] as never;

describe("X-PT-1 qualification-view agrees with applyPointsRule on where the awarded score lands", () => {
  it("every award reason × played (counted): ruleScoreReaches ⇔ applyPointsRule changed the score", () => {
    let checked = 0;
    for (const reason of AWARD_REASONS)
      for (const played of [false, true]) {
        const outcome = { kind: "award", winner: "H", loser: reason === "bye" ? null : "A", reason } as never;
        const f = { outcome, played, home_entrant_id: "H", away_entrant_id: reason === "bye" ? null : "A" };
        const out = applyPointsRule(outcome, pair, rule, played) as unknown as { metrics: { for: number } }[];
        const changed = out[0]!.metrics.for !== 1;
        expect(ruleScoreReaches(f as never, meta), `${reason}/played=${played}`).toBe(changed);
        checked++;
      }
    expect(checked).toBe(AWARD_REASONS.length * 2);
  });
  it("a rule with a zero awarded score reaches nothing (the empty case)", () => {
    const zero = { pointsRule: PointsRule.parse({ base: { win: 3, draw: 1, loss: 0 }, forfeit: { winnerPoints: 2, loserPoints: 0, awardScore: [0, 0] } }) } as never;
    expect(ruleScoreReaches({ outcome: { kind: "award", winner: "H", loser: "A", reason: "walkover" }, played: false, home_entrant_id: "H", away_entrant_id: "A" } as never, zero)).toBe(false);
  });
});
```
`@seazn/engine/competition` is the package subpath (Global Constraints); confirm `applyPointsRule` and `PointsRule` are exported there.

The DB case in the standings suite drives the seam through real `score_events`:
- a badminton league stage with a `forfeit: {winnerPoints: 2, loserPoints: 0, awardScore: [21, 0]}` rule;
- fixture 1: `core.start` → `core.forfeit {reason: "withdrew"}` (nothing played) → the winner's row has 2 points and `for` 21;
- fixture 2: `core.start` → one rally event → `core.forfeit {reason: "withdrew"}` → base points and the rally score, no 21.

Copy the seeding and the forfeit payload from the suite's existing award case.

- [ ] **Step 2: Run to verify red** (engine file, then the two web files; judge). Expected: `applyPointsRule` takes 3 arguments (a tsc error is NOT a red: add the 4th parameter as optional and unused for the red run, so the assertions fail); the walkover metrics come back added (`for: 8`); the bye gets `for: 5`; a withdrew-with-nothing-played gets base points; the parity test fails on byes and played awards.

- [ ] **Step 3: Implement.**

```ts
const isBye = (o: MatchOutcome) => o.kind === "award" && awardReasonOf(o) === "bye";
export function forfeitShaped(outcome: MatchOutcome): boolean {
  return outcome.kind === "award" || (outcome.kind === "win" && (outcome.method === "walkover" || outcome.method === "forfeit"));
}
export function isUnplayedForfeit(outcome: MatchOutcome, played: boolean): boolean {
  if (played) return false;
  if (outcome.kind === "win") return outcome.method === "walkover" || outcome.method === "forfeit";
  return outcome.kind === "award" && !isBye(outcome);
}
```
In `applyPointsRule(outcome, pair, rule, played)`:
- `const forfeit = isUnplayedForfeit(outcome, played)`;
- the forfeit-points branch fires on `(forfeit || isBye(outcome)) && rule.forfeit !== undefined`;
- the awardScore block fires on `forfeit && rule.forfeit?.awardScore !== undefined` and ASSIGNS `metrics.for = mine; metrics.against = theirs; metrics.diff = mine - theirs`.

Then:
- make the 4th parameter required and fix the four callers;
- `ruleScoreReaches` in `qualification-view.ts`, with `ruleScoresForfeits`' callers moved to it per fixture;
- `QualFixture.played` from the loader.

`pointsRuleExpressible`:

```ts
const BASE_KEYS = new Set(["win", "draw", "loss", "w", "d", "l"]);
export function pointsRuleExpressible(divisionCfg: unknown): Expressible {
  const pts = (divisionCfg as { points?: Record<string, unknown> } | null)?.points;
  const keys = Object.keys(pts ?? {}).filter((k) => !BASE_KEYS.has(k) && pts![k] != null);
  return keys.length === 0 ? { ok: true } : { ok: false, keys, reason: `this division awards ${keys.join(", ")}, which a stage points rule cannot express yet` };
}
```

- [ ] **Step 4: Run.**
  - Engine: the new test, `src/competition/points.test.ts`, the suites that call `applyPointsRule` (`git grep -l -a applyPointsRule -- packages/engine/src '*.test.ts'`), `testkit` scenario tests; then report the ids it proves with their test paths (the batch-end proof commit, **Execution**): X-PT-1.
  - Web: the parity test; the standings suite with the new DB case (`pending == 0`); the existing qualification-view suites (`git grep -l -a qualification-view -- apps/web/src '*.test.ts'`).
  - Bench: `tools/bench`'s own validate-pack test, if one exists (`git grep -l -a validate-pack -- tools/bench '*.test.ts'`).
  - `tsc` for engine and web.

- [ ] **Step 5: Mutate once** — `MUT/t9.json`, plus changed-lines Stryker (group `competition-2`):

```json
[
  { "id": "t9-replace", "file": "packages/engine/src/competition/points.ts",
    "find": "metrics.for = mine;", "replace": "metrics.for = (metrics.for ?? 0) + mine;",
    "killers": [{ "cwd": "packages/engine", "files": ["src/competition/points-w2c.test.ts"], "name": "REPLACES the credit" }] },
  { "id": "t9-played", "file": "packages/engine/src/competition/points.ts",
    "find": "  if (played) return false;", "replace": "",
    "killers": [{ "cwd": "packages/engine", "files": ["src/competition/points-w2c.test.ts"], "name": "AFTER play earns normal points" }] },
  { "id": "t9-bye-no-score", "file": "packages/engine/src/competition/points.ts",
    "find": "return outcome.kind === \"award\" && !isBye(outcome);", "replace": "return outcome.kind === \"award\";",
    "killers": [{ "cwd": "packages/engine", "files": ["src/competition/points-w2c.test.ts"], "name": "a bye keeps the forfeit row" }] },
  { "id": "t9-forfeit-shaped", "file": "packages/engine/src/competition/points.ts",
    "find": "(outcome.kind === \"win\" && (outcome.method === \"walkover\" || outcome.method === \"forfeit\"));\n}\nexport function isUnplayedForfeit", "replace": "false;\n}\nexport function isUnplayedForfeit",
    "killers": [{ "cwd": "packages/engine", "files": ["src/competition/points-w2c.test.ts"], "name": "forfeitShaped covers a win by forfeit" }] },
  { "id": "t9-qual-parity", "file": "apps/web/src/server/public-site/qualification-view.ts",
    "find": "!f.played", "replace": "true",
    "killers": [{ "cwd": "apps/web", "files": ["src/server/public-site/__tests__/qualification-points-parity.test.ts"], "name": "ruleScoreReaches" }] }
]
```
`ruleScoreReaches` is written with the literal `!f.played` so the last mutant addresses it.

- [ ] **Step 6: Commit** `feat(engine): stage points — a forfeit is an award with nothing played; awarded score replaces (X-PT-1, Q1)`.

**Test types:**
- Unit: the engine file and the parity test.
- E2E: Task 18 `e2e/stage-rules-w2c.spec.ts` "ST-G8 stage points: preview, save, walkover row in the table (X-PT-1)". It is driven through the product: a walkover recorded by `core.forfeit` and a table read.
- Smoke: Task 13 `w2c: stage points walkover pays the forfeit row`.
- Regression: `points.test.ts`, the competition suites, and the qualification-view suites. Any test that pinned the additive awardScore or byes-as-score-carriers is updated (greenfield) and named in the task report. The DB standings case is the seam proof.

**Sequence cases:**
- a rule with no forfeit row (empty) first;
- every reason with nothing played;
- every reason after play;
- a bye;
- a double walkover;
- another sport's win-method walkover;
- an empty division cfg;
- a zero awarded score.

---

### Task 10: Migration + one resolver through every caller (lane F, **BLOCKED until rebase on W2b merge**; Opus)

> **Carried from batch-1 fixes.** `scripts/smoke.ts:8378-8385` re-sends the CURRENT variant: after Task 2 that is a 200 no-op. Rewrite the pin to start a stage, then PATCH a DIFFERENT variant and expect 409 `DIVISION_FORMAT_LOCKED` naming the stage (plus the unstarted-stage save that succeeds).

Spec item 2 (resolution half); §4.4; §5.2 at `1b757c6cb` (both columns); D4, D14; P2, P3; Review Focus 2; owner P-1 (the column) and P-2 (the smoke pin, review I2). Creates `w2cStageRulesSuite`.

**Files:**
- Create: `db/migration/deltas/V<next>__fixture_rules_override.sql` (`V<next>` from Task 3 Step 3): `rules_override jsonb` AND `rules_version int not null default 0` (P-1; nothing writes or reads the version until Tasks 14 and 15)
- Modify: `apps/web/src/server/engine-db/fixture-cfg.ts`: `FixtureCfgSource`; `resolveFixtureCfg(fixture, divisionCfg, stage, module)`.
- Modify: every caller (12 sites in 10 files after W2b). Each one's SQL select adds `f.rules_override`, and it passes `{config_snapshot, rules_override}`:
  - `engine-db/fold.ts`, `engine-db/append-event.ts`, `engine-db/competition.ts` (2 sites), `engine-db/awarded-state.ts`;
  - `public-site/match-centre-load.ts`;
  - `usecases/fixtures.ts`, `usecases/player-stats.ts`, `usecases/event-import.ts`, `usecases/org-posts.ts`, `usecases/admin-fixture-config.ts` (2 sites; the hatch passes the real override, not `null`).
- Modify: `apps/web/src/server/engine-db/__tests__/bracket-overlay-callers.test.ts`: SITES ledger + one override assertion per caller.
- Modify: `apps/web/src/server/engine-db/__tests__/fixture-cfg.test.ts` (or create it if absent): the order and signature.
- Create: `apps/web/src/server/engine-db/__tests__/fixture-cfg-order.test.ts`
- Modify: `scripts/smoke.ts`:
  - `w2cStageRulesSuite` (new), called from `main()` after `stageRulesFormatSmoke` (`:1242`);
  - the pin "v8 format 409s once fixtures exist" (`:8378-8385` on main; re-pin on the rebased tree), rewritten for P-2 (below).
- Create: `MUT/t10.json`

**Interfaces:**
- Consumes: nothing from Tasks 4–9. This lane is disjoint.
- Produces:
  ```ts
  export interface FixtureCfgSource { readonly config_snapshot: unknown; readonly rules_override: unknown }
  export function resolveFixtureCfg(fixture: FixtureCfgSource, divisionCfg: unknown, stage: FixtureStageSource | null, module: DeciderSource): unknown;
  // scripts/smoke.ts
  async function w2cStageRulesSuite(): Promise<void>;   // later tasks append checks to it
  ```

- [ ] **Step 1: Write the failing tests.** `fixture-cfg-order.test.ts` (P3, pure):

```ts
// P3 order differential (spec §9): snapshot ?? (division ⊕ stage.rules ⊕ bracketDeciders ⊕ rules_override).
import { describe, expect, it } from "vitest";
import { builtinModules } from "@seazn/engine/sports";
import { resolveFixtureCfg } from "../fixture-cfg";

const mod = (key: string) => builtinModules.find((m) => m.key === key)!;
const none = { config_snapshot: null, rules_override: null };

describe("P3 resolveFixtureCfg order", () => {
  it("override beats stage beats division (badminton bestOf: 5 / 3 / 1)", () => {
    const division = { bestOf: 5 }, stage = { kind: "league" as const, config: { rules: { bestOf: 3 } } };
    expect(resolveFixtureCfg(none, division, null, mod("badminton"))).toMatchObject({ bestOf: 5 });
    expect(resolveFixtureCfg(none, division, stage, mod("badminton"))).toMatchObject({ bestOf: 3 });
    expect(resolveFixtureCfg({ config_snapshot: null, rules_override: { bestOf: 1 } }, division, stage, mod("badminton"))).toMatchObject({ bestOf: 1 });
  });
  it("a bracket decider beats the stage (carrom KO tieBoard)", () => {
    const carrom = mod("carrom");
    const deciders = carrom.bracketDeciders(carrom.configSchema.parse({})) as { tieBoard: string };
    const r = resolveFixtureCfg(none, { tieBoard: "none" }, { kind: "knockout", config: { rules: { tieBoard: "none" } } }, carrom) as { tieBoard: string };
    expect(r.tieBoard).toBe(deciders.tieBoard);
    expect(deciders.tieBoard).not.toBe("none");
  });
  it("the override lands after the deciders (football KO: extra time switched off for one match)", () => {
    const r = resolveFixtureCfg({ config_snapshot: null, rules_override: { extraTime: { enabled: false, halfMinutes: 15 } } },
      {}, { kind: "knockout", config: { rules: { extraTime: { enabled: true, halfMinutes: 15 } } } }, mod("football")) as { extraTime: { enabled: boolean } };
    expect(r.extraTime.enabled).toBe(false);
  });
  it("a frozen snapshot wins over everything, override included", () => {
    expect(resolveFixtureCfg({ config_snapshot: { bestOf: 3 }, rules_override: { bestOf: 1 } }, { bestOf: 5 }, null, mod("badminton"))).toEqual({ bestOf: 3 });
  });
  it("a non-object override is ignored (null, array, string)", () => {
    for (const ov of [null, [], "x"]) expect(resolveFixtureCfg({ config_snapshot: null, rules_override: ov }, { bestOf: 5 }, null, mod("badminton"))).toMatchObject({ bestOf: 5 });
  });
  it("Review Focus 2: a stage edit after an override keeps the override and moves the rest", () => {
    const fixture = { config_snapshot: null, rules_override: { bestOf: 1 } };
    const before = resolveFixtureCfg(fixture, { bestOf: 5, setTo: 21 }, { kind: "league", config: { rules: { setTo: 21 } } }, mod("badminton"));
    const after = resolveFixtureCfg(fixture, { bestOf: 5, setTo: 21 }, { kind: "league", config: { rules: { setTo: 15 } } }, mod("badminton"));
    expect(before).toMatchObject({ bestOf: 1, setTo: 21 });
    expect(after).toMatchObject({ bestOf: 1, setTo: 15 });
  });
});
```

In `bracket-overlay-callers.test.ts`:
- Add `"engine-db/awarded-state.ts"` to the SITES ledger. The grep-count assertion (`:65-85`) now expects the tree's count, so a new caller fails until it is listed.
- In every per-caller DB case, before invoking the caller, seed `await sql\`update fixtures set rules_override = ${sql.json(OVERRIDE as never)} where id = ${fixtureId}\`` with `const OVERRIDE = { bestOf: 1 }` (a badminton fixture, or the case's own sport's match key from `fixtureKeysFor`).
- Add the assertion `expect(spy.mock.calls.at(-1)![0]).toMatchObject({ rules_override: OVERRIDE })`.
- Task 14 re-points this seeding to the real writer (the §8 seam).

- [ ] **Step 2: Run to verify red.** `fixture-cfg-order.test.ts` fails because the old signature takes a bare snapshot (the type error surfaces as a runtime mismatch: the object is treated as a frozen snapshot). The callers test fails on the missing `rules_override` key and on the SITES count.

- [ ] **Step 3: Implement.**
  - Migration:
    ```sql
    -- W2c (spec §4.3): a fixture's own match-format override — engine ruleKeys of
    -- scope "match" only, written by writeFixtureRulesOverride alone. Null = the
    -- fixture plays its stage's rules. Greenfield (spec §11): nullable, no default,
    -- no backfill.
    alter table fixtures add column if not exists rules_override jsonb;
    -- W2c P-1 (spec §4.5 item 2): bumped ONLY by a Q11 correction or a staff re-freeze
    -- (refreezeFixture). A scoring pad sends it with each event; append-event refuses a
    -- stale one FIXTURE_RULES_CHANGED. Senders that omit it are never checked.
    alter table fixtures add column if not exists rules_version int not null default 0;
    comment on column fixtures.rules_override is
      'W2c: match-scoped rule override (engine ruleKeys scope "match"). Resolved as '
      'snapshot ?? (division ⊕ stage.rules ⊕ bracketDeciders ⊕ rules_override); frozen '
      'into config_snapshot with everything else at the first event.';
    comment on column fixtures.rules_version is
      'W2c: incremented by a rules correction or staff re-freeze only; checked at append time when the sender includes it.';
    ```
  - Resolver: the D4 signature, with the override merged last:
    ```ts
    const ov = fixture.rules_override;
    return typeof ov === "object" && ov !== null && !Array.isArray(ov) ? { ...decided, ...(ov as object) } : decided;
    ```
  - Each caller's select gains `f.rules_override`. `tsc` lists every caller that does not compile, which is the point of D4.
  - Apply the migration to the label DB: `$S rebuild --label w2c` (it runs `db:apply`). Confirm with `psql "$DATABASE_URL" -Atc "select column_name from information_schema.columns where table_name='fixtures' and column_name in ('rules_override','rules_version') order by 1"`, which prints both names, and `select column_default, is_nullable from information_schema.columns where table_name='fixtures' and column_name='rules_version'`, which prints `0|NO`.
  - Smoke suite:
    ```ts
    async function w2cStageRulesSuite(): Promise<void> {
      const owner = newSession();
      await signIn(owner, `delivered+w2c_${tag}@resend.dev`);
      // Task 2's owed check — the division lock names the started stage (X-SR-4).
      const { divisionId, fixtureId } = await w2cSeedStartedPool(owner); // league pool A generated, one fixture started via the events API
      const r = await v1(owner, `/api/v1/divisions/${divisionId}`, "PATCH", { tiebreakers: ["head_to_head"] });
      check("w2c: division table rules lock names the started stage", r.status === 409 && (r.body as { code?: string }).code === "DIVISION_TABLE_RULES_LOCKED" && JSON.stringify(r.body).includes("Pool A"));
    }
    ```
    `w2cSeedStartedPool` is a local helper in the same file. It POSTs a competition, a division (`badminton`, `short`), two entrants, one league stage named "Pool A" via `/stages`, then `/generate`, then one `core.start` through `/api/v1/fixtures/{id}/events` with `expected_seq: 0`. It copies the call shapes of `stageRulesFormatSmoke` (`:6652`) and the events POST at `:2045`, and returns the ids.
  - The P-2 smoke pin (review I2). Today it asserts a whole-config `FORMAT_LOCKED` as soon as fixtures exist. Under P-2 the lock is per STARTED inheriting stage, so generating fixtures alone no longer locks the variant. Rewrite the block as two checks, keeping its seeding (`div`, `stage`, the `/generate` call):
    ```ts
    const early = await raw(admin, `/api/v1/divisions/${div.id}`, "PATCH", { variant_key: "score" });
    check("v8 format: a variant change is accepted while no stage has started (P-2)", early.status === 200);
    const [first] = (await v1(admin, `/api/v1/stages/${stage.id}/fixtures`, "GET")) as { id: string }[];
    await raw(admin, `/api/v1/fixtures/${first!.id}/events`, "POST", { expected_seq: 0, event: { type: "core.start", payload: {} } });
    const post = await raw(admin, `/api/v1/divisions/${div.id}`, "PATCH", { variant_key: "win_loss" });
    check(
      "v8 format 409s once an inheriting stage has started (P-2)",
      post.status === 409 &&
        (post.json.error as { code?: string } | undefined)?.code === "DIVISION_FORMAT_LOCKED" &&
        JSON.stringify(post.json).includes("\"L\""),   // names the started stage
    );
    ```
    - The division's sport and variants are the ones the block already seeds; read them first. If its sport is not generic, use two of that sport's own variant keys in place of `score` / `win_loss`.
    - Copy the fixture list and events POST shapes from the block's neighbours (the events POST at `:2045`). Do not invent routes: if `GET /stages/{id}/fixtures` does not exist, read the fixture id the way `stageRulesFormatSmoke` does.
    - `structSwap` below it is unchanged. Re-read it on the rebased tree: if it relied on the variant still being `score`, keep `early` as the last variant write.

- [ ] **Step 4: Run.** The two tests plus every caller's own suite: `git grep -l -a "resolveFixtureCfg\|loadFoldInputs\|loadFixturePadCfg" -- apps/web/src '*.test.ts'`. Pass that exact list and judge `files` against it. Then web `tsc` and eslint. Then the smoke suite alone against the label server:
  ```bash
  cd /Users/ashokhein/github/seazn.club-worktrees/format-matrix-w2c && eval "$(~/.claude/skills/seazn-local-env/scripts/seazn-env.sh env --label w2c)" && SMOKE_ONLY=w2cStageRulesSuite pnpm test:smoke; echo EXIT=$?
  ```
  The rewritten P-2 pin lives in another suite (the one holding "v8 format"); select that suite as well, the same way.
  If `smoke.ts` has no `SMOKE_ONLY` switch, read `main()` (`:185`) for its existing selection mechanism. If none exists, run the full smoke against the label server ONCE at this task's gate, which is the house smoke command, not the vitest suite. Record which applied.

- [ ] **Step 5: Mutate once** — `MUT/t10.json`:

```json
[
  { "id": "t10-override-last", "file": "apps/web/src/server/engine-db/fixture-cfg.ts",
    "find": "{ ...decided, ...(ov as object) }", "replace": "{ ...(ov as object), ...decided }",
    "killers": [{ "cwd": "apps/web", "files": ["src/server/engine-db/__tests__/fixture-cfg-order.test.ts"], "name": "override beats stage" }] },
  { "id": "t10-snapshot-first", "file": "apps/web/src/server/engine-db/fixture-cfg.ts",
    "find": "if (hasFrozenCfg(fixture.config_snapshot)) return fixture.config_snapshot;", "replace": "",
    "killers": [{ "cwd": "apps/web", "files": ["src/server/engine-db/__tests__/fixture-cfg-order.test.ts"], "name": "frozen snapshot wins" }] }
]
```

- [ ] **Step 6: Commit** `feat(w2c): fixtures.rules_override, resolved last through every caller (P2, P3)` with the migration, the resolver, the callers, the tests, `smoke.ts` and `t10.json`.

**Test types:**
- Unit: above, including the DB per-caller suite.
- E2E: Task 19 `e2e/match-rules-w2c.spec.ts` "X-SR-2 change one match's format before it starts; its effective rules read best of 1; the run sheet tags it".
- Smoke: the suite's first check, which is Task 2's, and the two rewritten "v8 format" checks (P-2). There is no override HTTP path until Task 14, whose smoke covers the override.
- Regression: each caller's own suite.

**Sequence cases:** no override (null) first; an override; a non-object override; a frozen snapshot plus an override; a stage edit after an override (Review Focus 2); another sport (carrom, football).

---

### Task 11: Stage rules for every sport — `putStageRules` (server)

> **Carried from batch-1 Opus review (I-A).** Since Task 2 (P-2 "A") the division config can change after stages have stored `config.rules`, but `patchDivision` never re-checks them: e.g. Pool B `{cap:21}` + a division change to setTo/finalSetTo 25 with cap 30 leaves B's merged config breaking the kernel's cap ≥ setTo refinement, frozen as is; or a division `pointsMap` edit drops a score a stage's `bestOf` override needs (standings throw, and the key then locks). Extract ONE merged-parse helper here (`{division ⊕ stage.rules}` parse + `unansweredSetScores` when rules set `bestOf`), use it in `putStageRules` AND in `patchDivision` for every stage that has `config.rules`: refuse naming the stage, with 422 `CONFIG_INVALID` for a parse failure and the existing `POINTS_MAP_INCOMPLETE` for the pointsMap arm (so `putStageRules`' current contract is unchanged). Red-first tests for both examples; mutate the new call in `patchDivision` once. Must land before Task 12 writes `stageDefaults` into every knockout stage's rules.

Spec item 1 (write path 1) and item 5's validation for deciders; D1, D3; X-SR-1, X-SR-3.

**Files:**
- Modify: `apps/web/src/server/usecases/stage-rules.ts:118-285`
- Modify: `apps/web/src/app/o/[orgSlug]/c/[compSlug]/d/[divSlug]/page.tsx:407-410` (load `formatLockedStageIds` for every sport)
- Modify: `apps/web/src/server/usecases/__tests__/stage-rules.test.ts`: retire "refuses a sport outside the sets-based four"; keep the `UNKNOWN_RULE_KEY` tests
- Create: `apps/web/src/server/usecases/__tests__/stage-rules-every-sport.test.ts`
- Modify: `scripts/smoke.ts`:
  - `w2cStageRulesSuite` gains the Task 4/7/8/11 checks;
  - the old-shape Armageddon sender at `:2406` ("bracket finish (chess)", `{rung: ARMAGEDDON, winner: chessAway}`) moves to Task 8's `{rung: "armageddon", black: chessAway, result: "draw"}`, and its check now asserts that Black advanced (re-review minor; review I10). Task 8 changed the engine, but this task owns `smoke.ts` in the sequential lanes.
- Create: `MUT/t11.json`
- Do NOT touch: `stages-panel.tsx` (Task 17), `schemas.ts` (Task 12), `engine-db/stage-cfg.ts` (the overlay deletion is resolver code: Opus Task 13b, re-review IMP-R3).

**Interfaces:**
- Consumes: Task 4's `sportTopKeys`, `stageTopKeysFor`; Task 2's `lockedStageIdsAmong`, `ruleErrorMessage`; `resolveModule`.
- Produces: `putStageRules(auth, stageId, {rules})` for every sport.
  - Refuses `UNKNOWN_RULE_KEY` (400) for a key the sport never declares.
  - Refuses `RULE_NOT_SETTABLE` (400, `extra: {field}`) for a declared key that is not settable for this stage's kind or variant, or that is a points key.
  - `SPORT_NOT_SUPPORTED` is no longer thrown anywhere (greenfield: its code is removed, and so are its tests).

- [ ] **Step 1: Write the failing test** — `stage-rules-every-sport.test.ts`. Copy `seedOrg`, `seedDivision`, `seedStage` and `stageConfig` from `stage-rules.test.ts:31-93` and add a `kind` parameter to `seedStage`:

```ts
import { builtinModules } from "@seazn/engine/sports";
import { stageTopKeysFor, sportTopKeys } from "@seazn/engine/sport";
import { SPORT_RULES } from "@/lib/match-rules";

/** The built CONFIG fragment a field writes for its first probe — the API takes config keys, never form keys. */
function builtFor(sport: string, top: string): Record<string, unknown> {
  const f = SPORT_RULES[sport]!.find((x) => x.edits.some((k) => k.split(".")[0] === top) && Object.keys(x.build(probe(x), {})).length > 0);
  return f ? f.build(probe(f), {}) : {};
}
const probe = (f: { kind: string; options?: { value: string }[]; min?: number }) =>
  f.kind === "select" ? f.options![0]!.value : f.kind === "bool" ? "on" : f.kind === "sequence" ? "" : String(f.min ?? 1);

describe.skipIf(!HAS_DB)("X-SR-1 putStageRules covers every sport", () => {
  it("every sport accepts every stage key it declares for a league stage, and stores it (counted)", async () => {
    let checked = 0;
    for (const m of builtinModules) {
      const variant = Object.keys(m.variants)[0]!;
      const auth = await seedOrg();
      const { divisionId } = await seedDivision(auth, m.key, variant, 0);
      const stageId = await seedStage(auth, divisionId, 1, "league");
      for (const top of stageTopKeysFor(m, "league", variant)) {
        const frag = builtFor(m.key, top);
        if (Object.keys(frag).length === 0) continue; // a sub-field with no own build: written through its parent
        await putStageRules(auth, stageId, { rules: frag });
        expect((await stageConfig(stageId)).rules, `${m.key}.${top}`).toMatchObject(frag);
        checked++;
      }
    }
    expect(checked).toBeGreaterThan(builtinModules.length);
  });

  it("UNKNOWN_RULE_KEY for an undeclared key; RULE_NOT_SETTABLE for a key this kind cannot set", async () => {
    const auth = await seedOrg();
    const carrom = builtinModules.find((m) => m.key === "carrom")!;
    const { divisionId } = await seedDivision(auth, "carrom", Object.keys(carrom.variants)[0]!, 0);
    const ko = await seedStage(auth, divisionId, 1, "knockout");
    expect(sportTopKeys(carrom).has("tieBoard")).toBe(true);
    await expect(putStageRules(auth, ko, { rules: { bogus: 1 } })).rejects.toMatchObject({ status: 400, code: "UNKNOWN_RULE_KEY" });
    await expect(putStageRules(auth, ko, { rules: { tieBoard: "extra" } })).rejects.toMatchObject({ status: 400, code: "RULE_NOT_SETTABLE", extra: { field: "tieBoard" } });
  });

  it("points keys belong to the Points section, never stage rules (football points)", async () => {
    const auth = await seedOrg();
    const { divisionId } = await seedDivision(auth, "football", "11-a-side", 0);
    const s = await seedStage(auth, divisionId, 1, "league");
    await expect(putStageRules(auth, s, { rules: { points: { shootoutWin: 2, shootoutLoss: 1 } } })).rejects.toMatchObject({ code: "RULE_NOT_SETTABLE" });
  });

  it("P-5 share needs draws: a generic stage refuses share while its division forbids draws", async () => {
    const auth = await seedOrg();
    const { divisionId } = await seedDivision(auth, "generic", "win_loss", 0);   // win_loss: allowDraws false
    const s = await seedStage(auth, divisionId, 1, "league");
    const err = await putStageRules(auth, s, { rules: { abandonPolicy: "share" } }).catch((e) => e);
    expect(err).toMatchObject({ status: 422, code: "CONFIG_INVALID" });
    expect(String(err.message)).toContain("Sharing the points needs draws to be allowed");
    expect((await stageConfig(s)).rules ?? null).toBeNull();
    await expect(putStageRules(auth, s, { rules: { allowDraws: true, abandonPolicy: "share" } })).resolves.toBeDefined(); // positive pair
  });

  it("X-SR-3 rules lock at the first event and stay locked after a void", async () => {
    const auth = await seedOrg();
    const chess = builtinModules.find((m) => m.key === "boardgame")!;
    const { divisionId } = await seedDivision(auth, "boardgame", Object.keys(chess.variants)[0]!, 2);
    const s = await seedStage(auth, divisionId, 1, "league");
    await generateStageFixtures(auth, s);
    const [f] = await sql<{ id: string }[]>`select id from fixtures where stage_id = ${s} limit 1`;
    await putStageRules(auth, s, { rules: { variant: "rapid" } });
    const started = await appendEvent(auth.orgId, f!.id, 0, { type: "core.start", payload: {} });
    await expect(putStageRules(auth, s, { rules: { variant: "blitz" } })).rejects.toMatchObject({ status: 409, code: "STAGE_FORMAT_LOCKED" });
    const v = await appendEvent(auth.orgId, f!.id, 1, { type: "core.void", payload: {}, voids: started.event.id });
    expect(v.event.voids).toBe(started.event.id);                          // the void landed
    await expect(putStageRules(auth, s, { rules: { variant: "blitz" } })).rejects.toMatchObject({ code: "STAGE_FORMAT_LOCKED" });
  });

  it("an empty fragment clears to the division; a second clear is a no-op", async () => {
    const auth = await seedOrg();
    const { divisionId } = await seedDivision(auth, "cricket", "t20", 0);
    const s = await seedStage(auth, divisionId, 1, "league");
    await putStageRules(auth, s, { rules: { superOver: true } });
    await putStageRules(auth, s, { rules: {} });
    expect(Object.hasOwn(await stageConfig(s), "rules")).toBe(false);
    await putStageRules(auth, s, { rules: {} });
    expect(Object.hasOwn(await stageConfig(s), "rules")).toBe(false);
  });

  it("CONFIG_INVALID carries the engine's reason", async () => {
    const auth = await seedOrg();
    const ice = builtinModules.find((m) => m.key === "icehockey")!;
    const { divisionId } = await seedDivision(auth, "icehockey", Object.keys(ice.variants)[0]!, 0);
    const s = await seedStage(auth, divisionId, 1, "league");
    await expect(putStageRules(auth, s, { rules: { periods: { count: 3, minutes: -1 } } })).rejects.toMatchObject({ code: "CONFIG_INVALID" });
  });
});
```

Add the rule-10 sequence property to the same file:

```ts
describe.skipIf(!HAS_DB)("rule 10 — stage rules × start × void", () => {
  it("after every step: a save succeeds iff no fixture of the stage has started", async () => {
    let steps = 0, voidsLanded = 0;
    await fc.assert(fc.asyncProperty(
      fc.array(fc.constantFrom("save", "clear", "start", "void"), { minLength: 1, maxLength: 6 }),
      async (ops) => {
        const auth = await seedOrg();
        const { divisionId } = await seedDivision(auth, "badminton", "short", 2);
        const s = await seedStage(auth, divisionId, 1, "league");
        await generateStageFixtures(auth, s);
        const [f] = await sql<{ id: string }[]>`select id from fixtures where stage_id = ${s} limit 1`;
        let seq = 0, started = false;
        const live: string[] = [];                                         // unvoided, non-void event ids (a void is not voidable)
        for (const op of ops) {
          steps++;
          if (op === "start" && seq === 0) { live.push((await appendEvent(auth.orgId, f!.id, seq, { type: "core.start", payload: {} })).event.id); seq++; started = true; continue; }
          if (op === "void" && live.length > 0) {
            const target = live.pop()!;
            const v = await appendEvent(auth.orgId, f!.id, seq, { type: "core.void", payload: {}, voids: target });
            expect(v.event.voids).toBe(target);                            // the void branch really ran
            voidsLanded++; seq++; continue;
          }
          if (op === "save" || op === "clear") {
            const p = putStageRules(auth, s, { rules: op === "save" ? { setTo: 15 } : {} });
            if (started) await expect(p).rejects.toMatchObject({ code: "STAGE_FORMAT_LOCKED" });
            else await expect(p).resolves.toBeDefined();
          }
        }
      },
    ), { seed: 20261013, numRuns: 25 });
    expect(steps).toBeGreaterThan(0);
    expect(voidsLanded, "the seeded runs never reached a void after a start").toBeGreaterThan(0);
  }, Math.max(5_000, 25 * 6 * 400 * 5));
});
```

- [ ] **Step 2: Run to verify red.** Expected: `SPORT_NOT_SUPPORTED` at the first non-set sport; `UNKNOWN_RULE_KEY` where `RULE_NOT_SETTABLE` is expected.

- [ ] **Step 3: Implement.**
  - Select `s.kind`, `d.variant_key`, `d.module_version`.
  - Resolve `module = resolveModule(sport, version)`.
  - Delete the 4-sport gate.
  - Per key `k`: if `!sportTopKeys(module).has(k)`, refuse `UNKNOWN_RULE_KEY`. If `!stageTopKeysFor(module, row.kind, row.variant_key).has(k)`, refuse `new HttpError(400, ruleErrorMessage("RULE_NOT_SETTABLE", {field: k, reason: "not for this stage's format"}), "RULE_NOT_SETTABLE", {field: k})`.
  - The null-strip, clear, merged parse and `POINTS_MAP_INCOMPLETE` stay as they are.
  - `page.tsx`: drop the `STAGE_RULES_SPORTS.has(...)` conjunct.
  - Grep for top-level stage deciders: `git grep -n -a "shootout:\|extraTime:" -- apps/web/src/server apps/web/e2e scripts`. Every hit that writes them into a STAGE config top level moves into `config.rules` in Task 12 (schemas) or here (tests). List them in the report.
  - Smoke additions to `w2cStageRulesSuite`:
    - `w2c: every sport accepts its stage keys`: one `PUT /api/v1/stages/{id}/rules` per builtin sport, with a key from `stageTopKeysFor`.
    - `w2c: a hockey stage saves q4_stands`: the FIH variant, a league stage, `{abandonPolicy: "q4_stands"}`, 200.
    - `w2c: a chess knockout stage saves an empty rung list`: `{tiebreakRungs: []}` on a knockout stage, 200.

- [ ] **Step 4: Run** the new test, `stage-rules.test.ts` and `fixture-cfg-order.test.ts`. Judge `files` = the paths passed and `pending == 0`. Then `tsc`, eslint, and the smoke suite as in Task 10.

- [ ] **Step 5: Mutate once** — `MUT/t11.json`:

```json
[
  { "id": "t11-not-settable", "file": "apps/web/src/server/usecases/stage-rules.ts",
    "find": "!stageTopKeysFor(module, row.kind, row.variant_key).has(k)", "replace": "false",
    "killers": [{ "cwd": "apps/web", "files": ["src/server/usecases/__tests__/stage-rules-every-sport.test.ts"], "name": "RULE_NOT_SETTABLE" }] },
  { "id": "t11-lock", "file": "apps/web/src/server/usecases/stage-rules.ts",
    "find": "\"STAGE_FORMAT_LOCKED\"", "replace": "\"STAGE_FORMAT_LOCKED_X\"",
    "killers": [{ "cwd": "apps/web", "files": ["src/server/usecases/__tests__/stage-rules-every-sport.test.ts"], "name": "X-SR-3" }] }
]
```

- [ ] **Step 6: Commit** `feat(w2c): stage rules for every sport from the engine declaration (X-SR-1, X-SR-3)`. The task does not edit `AWAITING_PROOF`: it should report the ids it proves with their test paths (the batch-end proof commit, **Execution**): X-SR-3. The orchestrator updates `IDX`.

**Test types:**
- Unit: above, including the rule-10 property.
- E2E: Task 17 `e2e/stage-rules-w2c.spec.ts` "X-SR-1 every sport shows its stage fields" and "X-SR-3 a started stage shows the lock line".
- Smoke: the three checks above.
- Regression: `stage-rules.test.ts`; `e2e/walkthrough/stage-rules-start-promotion.spec.ts` (whole file, re-run in Task 17 once the UI mounts for every sport).

**Sequence cases:** empty fragment / clear first; a second clear; save → start → refused → void → still refused (and the property); another sport (the every-sport sweep).

---
### Task 12: Stage creation writes the presets; the API takes `config.rules`; carry merges (server)

> **Carried from Task 5 review (M2).** `rule-locks.ts:~104` reads a decider at the stage's TOP level (pre-D3 storage). When this task moves deciders into `stages.config.rules`, convert that branch, its test and its mutant to read the new storage (or delete them if `stage.rules` already covers it). Grep `-a` for every other top-level decider read.

> **Carried from Task 2 review.** Name `openapi.ts:99` (the division PATCH summary still says "locked once fixtures exist"), declare the 409 body's `refused` array and the 200 body's `refused`, and list the new `ruleLock` codes in the division PATCH responses. Forward `EngineError.data` for `CONFIG_INVALID` in `api-v1/http.ts` so `issues`/`refused` reach HTTP clients (with a route test). Fix stale comments `pad-cfg-resolution.test.ts:99-102`, `schemas.ts:490-491`.

Spec items 5, 6; §4.2; D3, D13; SC-P8; P7; Review Focus 4 and 5; the §8 seam "stageDefaults output is read back through `resolveFixtureCfg` and folded by the real engine".

**Files:**
- Create: `apps/web/src/server/usecases/stage-defaults.ts`
- Modify: `apps/web/src/server/usecases/stage-rules.ts`: extract `validateStageRules(module, kind, variant, divisionCfg, rules)` (the allowlist plus merged parse that `putStageRules` runs) and export it.
- Modify: `apps/web/src/server/usecases/stages.ts`:
  - `createStages` (`:362`): retire `assertNoRulesKey`/`RULES_NOT_ACCEPTED_HERE`; validate `config.rules`, then `withStageDefaults` before the insert (`:458`);
  - `replaceStages` carry (`:528-560`): `rules = {...stageDefaultsFor(newKind), ...carried}` for a slot whose `seq:kind` matched, and defaults only for a slot whose kind changed.
- Modify: `apps/web/src/server/usecases/templates.ts:345`: the same helper.
- Modify: `apps/web/src/server/api-v1/schemas.ts`:
  - `StageConfig` drops top-level `shootout`/`extraTime` (`:1109-1110`) and refuses them loudly, as `PatchFixture`'s `.strict()` precedent does at `:1314-1320`;
  - `rules` is accepted (`:1119`);
  - the division response gains `refused` (Task 2's field).
- Modify: `apps/web/src/server/api-v1/openapi.ts` route summaries; `openapi/*.json` regenerated.
- Modify: every test, smoke check or e2e helper that writes a top-level stage `shootout`/`extraTime` (Task 11's grep list; for example `draw-guard.test.ts` "a knockout STAGE config shootout:true…") moves it into `config.rules`. Greenfield: no shim.
- Create: `apps/web/src/server/usecases/__tests__/stage-defaults.test.ts`
- Modify: `scripts/smoke.ts` (one check)
- Create: `MUT/t12.json`

**Interfaces:**
- Consumes: Task 4's `stageDefaultsFor`, `stageTopKeysFor`; Task 6's presets; Task 10's resolver; `loadFoldInputs`, `foldFrom`, `appendEvent`.
- Produces:
  ```ts
  export function withStageDefaults(module: AnySportModule, kind: StageKind, variant: string | null, config: Record<string, unknown>): Record<string, unknown>;
  export function validateStageRules(module: AnySportModule, kind: StageKind, variant: string | null, divisionCfg: Record<string, unknown>, rules: Record<string, unknown>): Record<string, unknown>; // throws UNKNOWN_RULE_KEY | RULE_NOT_SETTABLE | CONFIG_INVALID; returns the null-stripped fragment
  ```

- [ ] **Step 1: Write the failing test** — `stage-defaults.test.ts`. Use `seed-bracket.ts`'s `seedBracket`/`declaredVariant` for the bracket cases, and the stage-rules helpers for the rest:

```ts
import { afterAll, describe, expect, it } from "vitest";
import { builtinModules } from "@seazn/engine/sports";
import { stageDefaultsFor } from "@seazn/engine/sport";
import { BRACKET_KINDS, DRAW_KINDS } from "@seazn/engine/core";
import { sql } from "@/lib/db";
import { appendEvent } from "@/server/engine-db";
import { loadFoldInputs } from "@/server/engine-db/fold";
import { createStages, replaceStages, generateStageFixtures } from "../stages";
import { CreateStage } from "@/server/api-v1/schemas";
// seedOrg / seedDivision / stageConfig copied from stage-rules.test.ts:31-93

const HAS_DB = !!process.env.DATABASE_URL;
afterAll(async () => { await (globalThis as { _sql?: { end(): Promise<void> } })._sql?.end(); });
const football = builtinModules.find((m) => m.key === "football")!;

describe.skipIf(!HAS_DB)("X-SR-6 P7 a new stage stores its sport's preset", () => {
  it("every sport × every kind: stored rules equal stageDefaultsFor (counted; table kinds store none)", async () => {
    let checked = 0;
    for (const m of builtinModules) {
      const variant = Object.keys(m.variants)[0]!;
      const auth = await seedOrg();
      const { divisionId } = await seedDivision(auth, m.key, variant, 0);
      let seq = 1;
      for (const kind of [...DRAW_KINDS, ...BRACKET_KINDS]) {
        const [st] = await createStages(auth, divisionId, { seq: seq++, kind, name: `${kind}`, config: {}, progression: null });
        const expected = stageDefaultsFor(m, kind, variant);
        const cfg = await stageConfig(st!.id);
        if (Object.keys(expected).length === 0) expect(Object.hasOwn(cfg, "rules"), `${m.key}/${kind}`).toBe(false);
        else expect(cfg.rules, `${m.key}/${kind}`).toEqual(expected);
        checked++;
      }
    }
    expect(checked).toBe(builtinModules.length * (DRAW_KINDS.length + BRACKET_KINDS.length));
  });

  it("provided rules win over the preset, key by key (SC-P8: validated like putStageRules)", async () => {
    const auth = await seedOrg();
    const { divisionId } = await seedDivision(auth, "football", "11-a-side", 0);
    const [st] = await createStages(auth, divisionId, { seq: 1, kind: "knockout", name: "KO", config: { rules: { shootout: false } }, progression: null });
    expect((await stageConfig(st!.id)).rules).toEqual({ ...stageDefaultsFor(football, "knockout", "11-a-side"), shootout: false });
    await expect(createStages(auth, divisionId, { seq: 2, kind: "knockout", name: "KO2", config: { rules: { bogus: 1 } }, progression: null })).rejects.toMatchObject({ code: "UNKNOWN_RULE_KEY" });
  });

  it("P-5 share needs draws: createStages refuses share on a generic division that forbids draws; nothing is created", async () => {
    const auth = await seedOrg();
    const { divisionId } = await seedDivision(auth, "generic", "win_loss", 0);   // win_loss: allowDraws false
    const err = await createStages(auth, divisionId, { seq: 1, kind: "league", name: "L", config: { rules: { abandonPolicy: "share" } }, progression: null }).catch((e) => e);
    expect(err).toMatchObject({ status: 422, code: "CONFIG_INVALID" });
    expect(String(err.message)).toContain("Sharing the points needs draws to be allowed");
    const [{ n }] = await sql<{ n: number }[]>`select count(*)::int n from stages where division_id = ${divisionId}`;
    expect(n).toBe(0);
  });

  it("the API refuses a top-level stage decider (moved to config.rules; greenfield)", () => {
    const r = CreateStage.safeParse({ seq: 1, kind: "knockout", name: "KO", config: { shootout: true }, progression: null });
    expect(r.success).toBe(false);
  });

  it("seam (§8): the preset reaches the real fold — a level knockout FT goes to extra time", async () => {
    const auth = await seedOrg();
    const { divisionId } = await seedDivision(auth, "football", "11-a-side", 2);
    const [st] = await createStages(auth, divisionId, { seq: 1, kind: "knockout", name: "KO", config: {}, progression: null });
    await generateStageFixtures(auth, st!.id);
    const [f] = await sql<{ id: string }[]>`select id from fixtures where stage_id = ${st!.id} and home_entrant_id is not null and away_entrant_id is not null limit 1`;
    await appendEvent(auth.orgId, f!.id, 0, { type: "core.start", payload: {} });
    await appendEvent(auth.orgId, f!.id, 1, { type: "football.period", payload: { phase: "HT" } });
    const ft = await appendEvent(auth.orgId, f!.id, 2, { type: "football.period", payload: { phase: "FT" } });
    expect(ft.status).not.toBe("needs_decision");
    const inputs = await loadFoldInputs(f!.id);
    expect((inputs.cfg as { extraTime: { enabled: boolean } }).extraTime.enabled).toBe(true);
  });

  it("X-SR-6 Review Focus 4: all deciders off → level → needs_decision → settle", async () => {
    const auth = await seedOrg();
    const { divisionId } = await seedDivision(auth, "football", "11-a-side", 2);
    const [st] = await createStages(auth, divisionId, { seq: 1, kind: "knockout", name: "KO", config: { rules: { extraTime: { enabled: false, halfMinutes: 15 }, shootout: false } }, progression: null });
    await generateStageFixtures(auth, st!.id);
    const [f] = await sql<{ id: string; home: string }[]>`select id, home_entrant_id as home from fixtures where stage_id = ${st!.id} and home_entrant_id is not null and away_entrant_id is not null limit 1`;
    await appendEvent(auth.orgId, f!.id, 0, { type: "core.start", payload: {} });
    await appendEvent(auth.orgId, f!.id, 1, { type: "football.period", payload: { phase: "HT" } });
    const ft = await appendEvent(auth.orgId, f!.id, 2, { type: "football.period", payload: { phase: "FT" } });
    expect(ft.status).toBe("needs_decision");
    const settled = await appendEvent(auth.orgId, f!.id, 3, { type: "core.settle", payload: { winner: f!.home, method: "organiser" } });
    expect(settled.outcome).toMatchObject({ winner: f!.home });
  });

  it("Review Focus 5: replaceStages carries edits over defaults per key; a changed kind starts from its own defaults", async () => {
    const auth = await seedOrg();
    const { divisionId } = await seedDivision(auth, "football", "11-a-side", 0);
    await createStages(auth, divisionId, [
      { seq: 1, kind: "league", name: "L", config: {}, progression: null },
      { seq: 2, kind: "knockout", name: "KO", config: { rules: { shootout: false } }, progression: null },
    ]);
    const after = await replaceStages(auth, divisionId, [
      { seq: 1, kind: "knockout", name: "L→KO", config: {}, progression: null },
      { seq: 2, kind: "knockout", name: "KO", config: {}, progression: null },
    ]);
    const bySeq = Object.fromEntries(await Promise.all(after.map(async (s) => [s.seq, (await stageConfig(s.id)).rules] as const)));
    expect(bySeq[2]).toEqual({ ...stageDefaultsFor(football, "knockout", "11-a-side"), shootout: false });
    expect(bySeq[1]).toEqual(stageDefaultsFor(football, "knockout", "11-a-side"));
  });
});
```

- [ ] **Step 2: Run to verify red.** Expected: no `rules` stored; `RULES_NOT_ACCEPTED_HERE` thrown for provided rules; the top-level decider parses; the seam goes to `needs_decision`; the carry stores `{shootout: false}` alone.

- [ ] **Step 3: Implement.**

```ts
// stage-defaults.ts
import type { AnySportModule } from "@seazn/engine/sport";
import { stageDefaultsFor } from "@seazn/engine/sport";
import type { StageKind } from "@seazn/engine/core";
export function withStageDefaults(module: AnySportModule, kind: StageKind, variant: string | null, config: Record<string, unknown>): Record<string, unknown> {
  const provided = typeof config.rules === "object" && config.rules !== null && !Array.isArray(config.rules) ? (config.rules as Record<string, unknown>) : {};
  const rules = { ...stageDefaultsFor(module, kind, variant), ...provided };
  const { rules: _drop, ...rest } = config;
  return Object.keys(rules).length > 0 ? { ...rest, rules } : rest;
}
```
- `createStages`: per stage, `validateStageRules(...)` on any provided rules, then `withStageDefaults`.
- `replaceStages` carry: build the carried map as today, then `withStageDefaults(module, newKind, variant, {...config, rules: carried ?? {}})`.
- `templates.ts:345`: wrap `effectiveStageConfig(templateStage)` the same way.
- `schemas.ts`: remove the two keys and add the loud refusal (`.superRefine` adding an issue "moved to config.rules" when either key is present).
- `pnpm openapi:gen`.
- Update every top-level-decider writer from Task 11's list.
- Smoke: `w2c: a new knockout stage stores its sport's deciders` (`POST /stages` football knockout, then `GET` → `config.rules.shootout === true`).

- [ ] **Step 4: Run** the new test plus `stage-rules.test.ts`, `stage-rules-every-sport.test.ts`, `draw-guard.test.ts`, `division-settings.test.ts`, the stages suites (`git grep -l -a "createStages\|replaceStages" -- apps/web/src '*.test.ts'`) and the templates suite. Then `tsc`, eslint, the OpenAPI diff and the smoke suite.

- [ ] **Step 5: Mutate once** — `MUT/t12.json`:

```json
[
  { "id": "t12-defaults", "file": "apps/web/src/server/usecases/stage-defaults.ts",
    "find": "{ ...stageDefaultsFor(module, kind, variant), ...provided }", "replace": "{ ...provided }",
    "killers": [{ "cwd": "apps/web", "files": ["src/server/usecases/__tests__/stage-defaults.test.ts"], "name": "P7 a new stage stores" }] },
  { "id": "t12-precedence", "file": "apps/web/src/server/usecases/stage-defaults.ts",
    "find": "{ ...stageDefaultsFor(module, kind, variant), ...provided }", "replace": "{ ...provided, ...stageDefaultsFor(module, kind, variant) }",
    "killers": [{ "cwd": "apps/web", "files": ["src/server/usecases/__tests__/stage-defaults.test.ts"], "name": "provided rules win" }] }
]
```

- [ ] **Step 6: Commit** `feat(w2c): stages are created with their sport's presets; API takes config.rules (X-SR-6, SC-P8)`.

**Test types:**
- Unit: above.
- E2E: Task 17 "X-SR-6 a new knockout stage shows its preset deciders" and "X-SR-6 turning every decider off shows the hold notice".
- Smoke: the check above.
- Regression: the stages, templates and draw-guard suites, updated to the D3 shape where they pinned top-level deciders.

**Sequence cases:** a table kind (no preset) first; a bracket kind; provided over preset; a second create on the same division; replace with the same kind and with a changed kind; another sport (the every-sport sweep).

---

### Task 13: Stage points — the server half of ST-G8 (same loop as Task 12)

Spec item 10; Q1; Review Focus 3.

**Files:**
- Modify: `apps/web/src/server/usecases/stage-rules.ts`: the body becomes `{rules?, points?}`. `points` is a `PointsRule | null` written to `config.points`.
- Modify: `apps/web/src/server/api-v1/schemas.ts` (`PutStageRules :1201`, `StageRules :1206`), `openapi.ts:156` (summary codes), `openapi/*.json`.
- Modify: `apps/web/src/lib/rule-errors.ts` (`POINTS_RULE_INEXPRESSIBLE` message already present; verify).
- Create: `apps/web/src/server/usecases/__tests__/stage-points.test.ts`
- Modify: `scripts/smoke.ts` (one check)
- Create: `MUT/t13.json`

**Interfaces:**
- Consumes: Task 9's `pointsRuleExpressible`, `PointsRule`, `validatePointsRule`; the custom-points gate used by `createStages` (`stages.ts:404-415`). Extract it into `assertCustomPointsAllowed(auth, rule)` in `stages.ts` and export it, so both paths call ONE gate.
- Produces: `PUT /api/v1/stages/{id}/rules` with `{points: PointsRule}` writes `config.points`, and `{points: null}` removes it. Errors:
  - `RULE_NOT_SETTABLE` (field `points`): a bracket kind;
  - `POINTS_RULE_INEXPRESSIBLE` (422): `pointsRuleExpressible(division cfg)` not ok;
  - `PAYMENT_REQUIRED` (402): bonuses or a forfeit row without `standings.custom_points`;
  - `STAGE_FORMAT_LOCKED`: the stage started;
  - `CONFIG_INVALID`: `validatePointsRule`.

- [ ] **Step 1: Write the failing test** — `stage-points.test.ts`. Copy the helpers as in Task 11; `seedOrg(plan)` takes `"pro" | "community"`:

```ts
const base = { base: { win: 3, draw: 1, loss: 0 } };
const withBonus = { ...base, bonuses: [{ when: "loss_margin_lte", param: 7, points: 1 }] };
const withForfeit = { ...base, forfeit: { winnerPoints: 3, loserPoints: 0 } };

describe.skipIf(!HAS_DB)("ST-G8 stage points (server)", () => {
  it("empty: {points: null} on a stage with none is a no-op", async () => {
    const auth = await seedOrg("pro");
    const { divisionId } = await seedDivision(auth, "badminton", "short", 0);
    const s = await seedStage(auth, divisionId, 1, "league");
    await putStageRules(auth, s, { points: null });
    expect(Object.hasOwn(await stageConfig(s), "points")).toBe(false);
  });
  it("a table stage stores its points; a second save replaces; null clears", async () => {
    const auth = await seedOrg("pro");
    const { divisionId } = await seedDivision(auth, "badminton", "short", 0);
    const s = await seedStage(auth, divisionId, 1, "league");
    await putStageRules(auth, s, { points: base });
    await putStageRules(auth, s, { points: { base: { win: 2, draw: 1, loss: 0 } } });
    expect((await stageConfig(s)).points).toMatchObject({ base: { win: 2 } });
    await putStageRules(auth, s, { points: null });
    expect(Object.hasOwn(await stageConfig(s), "points")).toBe(false);
  });
  it("a bracket stage refuses points (RULE_NOT_SETTABLE)", async () => {
    const auth = await seedOrg("pro");
    const { divisionId } = await seedDivision(auth, "badminton", "short", 0);
    const s = await seedStage(auth, divisionId, 1, "knockout");
    await expect(putStageRules(auth, s, { points: base })).rejects.toMatchObject({ code: "RULE_NOT_SETTABLE", extra: { field: "points" } });
  });
  it("Q1 an inexpressible division refuses by name (ice hockey OT/SO points)", async () => {
    const auth = await seedOrg("pro");
    const { divisionId } = await seedDivision(auth, "icehockey", "iihf", 0);
    const s = await seedStage(auth, divisionId, 1, "league");
    await expect(putStageRules(auth, s, { points: base })).rejects.toMatchObject({ status: 422, code: "POINTS_RULE_INEXPRESSIBLE" });
  });
  it("Review Focus 3: bonuses and forfeit points need standings.custom_points", async () => {
    const community = await seedOrg("community");
    const { divisionId } = await seedDivision(community, "badminton", "short", 0);
    const s = await seedStage(community, divisionId, 1, "league");
    await putStageRules(community, s, { points: base });                       // the base sentence is free
    await expect(putStageRules(community, s, { points: withBonus })).rejects.toMatchObject({ status: 402 });
    await expect(putStageRules(community, s, { points: withForfeit })).rejects.toMatchObject({ status: 402 });
    const pro = await seedOrg("pro");
    const d2 = await seedDivision(pro, "badminton", "short", 0);
    const s2 = await seedStage(pro, d2.divisionId, 1, "league");
    await putStageRules(pro, s2, { points: withBonus });                       // the granted state
    expect((await stageConfig(s2)).points).toMatchObject({ bonuses: [{ when: "loss_margin_lte" }] });
  });
  it("after the stage starts, points lock (STAGE_FORMAT_LOCKED), and stay locked after a void", async () => {
    const auth = await seedOrg("pro");
    const { divisionId } = await seedDivision(auth, "badminton", "short", 2);
    const s = await seedStage(auth, divisionId, 1, "league");
    await generateStageFixtures(auth, s);
    const [f] = await sql<{ id: string }[]>`select id from fixtures where stage_id = ${s} limit 1`;
    const started = await appendEvent(auth.orgId, f!.id, 0, { type: "core.start", payload: {} });
    await expect(putStageRules(auth, s, { points: base })).rejects.toMatchObject({ code: "STAGE_FORMAT_LOCKED" });
    const v = await appendEvent(auth.orgId, f!.id, 1, { type: "core.void", payload: {}, voids: started.event.id });
    expect(v.event.voids).toBe(started.event.id);                          // the void landed
    await expect(putStageRules(auth, s, { points: base })).rejects.toMatchObject({ code: "STAGE_FORMAT_LOCKED" });
  });
  it("another sport: a generic league takes points", async () => {
    const auth = await seedOrg("pro");
    const { divisionId } = await seedDivision(auth, "generic", "score", 0);
    const s = await seedStage(auth, divisionId, 1, "league");
    await putStageRules(auth, s, { points: base });
    expect((await stageConfig(s)).points).toMatchObject(base);
  });
});
```
The badminton `short` and generic `score` variants are re-confirmed as in Task 2; the icehockey `iihf` key against `icehockey.variants`.

- [ ] **Step 2: Run to verify red** (the `points` key is unknown to `PutStageRules`).

- [ ] **Step 3: Implement.**
  - Schema: `PutStageRules = z.object({ rules: z.record(...).nullable().optional(), points: PointsRule.nullable().optional() }).refine(b => b.rules !== undefined || b.points !== undefined)`.
  - In `putStageRules`, inside the same lock as rules:
    1. kind check;
    2. `pointsRuleExpressible(divisionCfg)`;
    3. `assertCustomPointsAllowed(auth, points)`;
    4. `validatePointsRule(points, module.metrics)`;
    5. write `config || {points}` or `config - 'points'`.
  - Smoke: `w2c: stage points walkover pays the forfeit row`:
    1. a badminton league stage with `forfeit: {winnerPoints: 2, loserPoints: 0}`;
    2. generate fixtures;
    3. record `core.forfeit` `{reason: "walkover", …}` on one fixture over HTTP;
    4. read the standings: the winner shows 2 points.

- [ ] **Step 4: Run** the new test, `stage-rules.test.ts`, `stage-rules-every-sport.test.ts`, the `createStages` custom-points tests, `tsc`, eslint, the OpenAPI diff and the smoke suite.

- [ ] **Step 5: Mutate once** — `MUT/t13.json`:

```json
[
  { "id": "t13-gate", "file": "apps/web/src/server/usecases/stage-rules.ts",
    "find": "await assertCustomPointsAllowed(auth, points);", "replace": "",
    "killers": [{ "cwd": "apps/web", "files": ["src/server/usecases/__tests__/stage-points.test.ts"], "name": "Review Focus 3" }] },
  { "id": "t13-expressible", "file": "apps/web/src/server/usecases/stage-rules.ts",
    "find": "if (!expressible.ok)", "replace": "if (false)",
    "killers": [{ "cwd": "apps/web", "files": ["src/server/usecases/__tests__/stage-points.test.ts"], "name": "Q1 an inexpressible division" }] }
]
```

- [ ] **Step 6: Commit** `feat(w2c): stage points through the stage rules endpoint (ST-G8, Q1)`.

**Test types:**
- Unit: above.
- E2E: Task 18 `e2e/stage-rules-w2c.spec.ts` "ST-G8 stage points: preview, save, walkover row" and "Review Focus 3: a Community org sees the gate, not the fields".
- Smoke: the check above.
- Regression: the `createStages` custom-points tests; `points-w2c.test.ts`.

**Sequence cases:** null on empty first; save, re-save, clear; after start; after a void; another sport; both entitlement states.

---

### Task 13b: Delete the top-level decider overlay — resolver code (Opus; after Tasks 12+13, same batch)

> **Carried from Task 4 review (G1).** Confirm after the overlay deletion that NO sport's `bracketDeciders` overwrites a decider the stage stored as off (Q7 "B": all deciders off allowed, X-SR-6: held for the organiser). Sweep every sport × bracket kind with every decider off in `stage.rules`: the resolved cfg has them off. Count the cells; zero = fail.

D3 (greenfield); spec §4.4. Re-review IMP-R3: deleting `STAGE_DECIDER_KEYS` from `stageScopedCfg` changes what `resolveFixtureCfg` returns for every caller. That is resolver code, so it belongs to the owner's Opus item (1), not to Sonnet Task 11. It runs AFTER Tasks 12+13. By then Task 12 has moved every writer of a top-level stage `shootout`/`extraTime` into `config.rules`, so deleting the read cannot strand a stored value written by current code.

**Files:**
- Modify: `apps/web/src/server/engine-db/stage-cfg.ts`: delete `STAGE_DECIDER_KEYS` and its loop (`:18`, `:35-37` on main). Keep the null-strip. Rewrite the comment above it: merge order is now `{...divisionCfg, ...rules}`, and the deciders are ordinary `rules` keys gated by the write paths' `stageTopKeysFor` (Tasks 11, 12).
- Modify: `apps/web/src/server/engine-db/__tests__/stage-cfg.test.ts`: every case that pins the top-level overlay moves to the D3 shape, plus the case below.
- Modify: `apps/web/src/server/usecases/__tests__/stage-rules-every-sport.test.ts`: the "D3 deciders live in rules" case (moved here from Task 11, which leaves it out) gains the resolved-cfg assertion below.
- Create: `MUT/t13b.json`
- Do NOT touch: `fixture-cfg.ts` (Task 10's resolver signature is final); any writer (Task 12 moved them).

**Interfaces:**
- Consumes: Task 10's `resolveFixtureCfg`; Task 12's `config.rules`-only stage schema.
- Produces: `stageScopedCfg(divisionCfg, stageCfg)` reading `stageCfg.rules` only.

- [ ] **Step 1: Write the failing tests.** In `stage-cfg.test.ts`:

```ts
it("D3: a top-level stage decider no longer reaches the resolved cfg; the same key under rules does", () => {
  const division = { shootout: true };
  expect(stageScopedCfg(division, { shootout: false })).toEqual({ shootout: true });                 // top level ignored
  expect(stageScopedCfg(division, { rules: { shootout: false } })).toEqual({ shootout: false });     // rules win
  expect(stageScopedCfg(division, { shootout: true, rules: { shootout: false } })).toEqual({ shootout: false });
});
it("the empty case: no stage cfg, an empty one, and empty rules all return the division cfg unchanged", () => {
  const division = { bestOf: 3 };
  for (const stage of [null, undefined, {}, { rules: {} }]) expect(stageScopedCfg(division, stage as never)).toBe(division);
});
```
In `stage-rules-every-sport.test.ts`, the moved D3 case:

```ts
it("D3 deciders live in rules; a top-level decider no longer reaches the resolved cfg", async () => {
  const auth = await seedOrg();
  const { divisionId } = await seedDivision(auth, "football", "11-a-side", 0);
  const s = await seedStage(auth, divisionId, 1, "knockout");
  await putStageRules(auth, s, { rules: { shootout: false } });
  expect((await stageConfig(s)).rules).toMatchObject({ shootout: false });
  // a top-level value written straight to the row (no current writer can) is ignored by the resolver
  await sql`update stages set config = config || ${sql.json({ shootout: true })} where id = ${s}`;
  const football = builtinModules.find((m) => m.key === "football")!;
  const [st] = await sql<{ kind: string; config: Record<string, unknown> }[]>`select kind, config from stages where id = ${s}`;
  const resolved = resolveFixtureCfg({ config_snapshot: null, rules_override: null }, {}, st as never, football) as { shootout: boolean };
  expect(resolved.shootout).toBe(false);
});
```

- [ ] **Step 2: Run to verify red** (`stage-cfg.test.ts`, then the every-sport file; judge). Expected: the top level still wins over the division (`{shootout: false}`), so the first assertion fails, and the DB case resolves `true`.

- [ ] **Step 3: Implement** the deletion. Then grep for readers of a top-level stage decider: `git grep -n -a -E "config\??\.(shootout|extraTime)\b" -- apps/web/src scripts`. Any hit outside `config.rules` is a stranded reader: report it, and fix it if it is in `engine-db/`.

- [ ] **Step 4: Run** `stage-cfg.test.ts`, `stage-rules-every-sport.test.ts`, `fixture-cfg-order.test.ts`, `bracket-overlay-callers.test.ts`, `stage-defaults.test.ts`, `draw-guard.test.ts`, `config-snapshot.test.ts` and `fixture-cfg.test.ts` (the suites that resolve a stage's deciders; the last two seed a top-level stage `shootout` and must move it under `config.rules`). Judge `files` = the paths passed and `pending == 0`. Then web `tsc` and eslint.

- [ ] **Step 5: Mutate once** — `MUT/t13b.json`:

```json
[
  { "id": "t13b-rules-only", "file": "apps/web/src/server/engine-db/stage-cfg.ts",
    "find": "  if (Object.keys(overlay).length === 0) return divisionCfg;", "replace": "  for (const key of [\"shootout\", \"extraTime\"]) if (stageCfg[key] !== undefined) overlay[key] = stageCfg[key];\n  if (Object.keys(overlay).length === 0) return divisionCfg;",
    "killers": [{ "cwd": "apps/web", "files": ["src/server/engine-db/__tests__/stage-cfg.test.ts"], "name": "D3: a top-level stage decider no longer reaches" }] }
]
```
The mutant re-inserts the deleted overlay. The first assertion of the D3 case kills it.

- [ ] **Step 6: Commit** `refactor(w2c): stage deciders resolve from config.rules only (D3)`.

**Test types:**
- Unit: `stage-cfg.test.ts`.
- DB: the moved D3 case.
- E2E: Task 17's "football KO deciders off" test, which drives the stored `rules` through the pad.
- Smoke: Task 12's stage-defaults check (stage creation stores the presets under `rules`).
- Regression: the Step 4 suites.

**Sequence cases:**
- the empty case first;
- top level only;
- rules only;
- both (rules win);
- another sport: carrom's `tieBoard` is a rules key with no top-level twin, so `stage-cfg.test.ts` adds one carrom case asserting `rules.tieBoard` resolves.

---

### Task 14: The one override writer and the live correction (Q11) (server; Opus)

> **Carried from Task 5 review (I3).** `buildMatchFragment` emits carrom `{gameTo}` only; the engine's cross-field refinement "queenCapAt must not exceed gameTo" then refuses the merged cfg, and `queenCapAt` is a stage-only key the match form cannot send. Decide and test (recommend: the override write path refuses with a named CONFIG_INVALID — "Game to 5 is below this stage's queen cap 7" — rather than silently clamping a stage-only key). Same class for cricket `overs` < `maxOversPerBowler` and set-sport `cap` < target, which ARE on the match form: surface the engine's message on the field.

> **Carried from Task 4 review (M2, M3).** `checkFixtureOverride` must receive the SCHEMA-PARSED stage cfg (`resolveFixtureCfg` returns unparsed; an unparsed `{}` stage wrongly refuses an ice-hockey OT shortening). Parse the stage-resolved cfg first, then check. Store the PARSED override (unknown nested leaves like `set.bogus` are accepted by the check and stripped by the schema — never store them). Tests for both.

> **Carried from Task 10 review.** (M2) `fixture-cfg.ts:107` copies a `null` from the override over the lower layer while `stage-cfg.ts:30-34` treats `null` as "inherit": decide (recommend: `null` = inherit, i.e. the writer never stores nulls and the resolver drops them), pin it with a test and a doc-comment line. (Gap) Regenerate (`stages.ts:643`) and history undo (`history.ts:572`) delete unplayed fixtures, so an organiser's match override disappears silently: refuse or warn by name ("Match 3 has its own format") and test it.

> **Carried from Task 4 (c).** `writeFixtureRulesOverride` stores only the CHANGED leaves of a fragment (deep diff against the stage-resolved cfg), never a whole resolved sub-object — otherwise a stored override hides later stage edits to neighbouring keys. Test: override `bestOf` only, then change the stage's `setTo`; the fixture resolves the new `setTo`. Mutate once.

> **Carried from batch-1 Opus review (I-A, one layer up).** A division or stage save must not invalidate an unstarted fixture's `rules_override`: reuse Task 11's merged-parse helper to check `{division ⊕ stage.rules ⊕ bracketDeciders ⊕ rules_override}` for every unstarted fixture with an override when the division or stage rules change, refusing 422 naming the match. Red-first test + one mutant.

Spec items 2, 3; §4.5 item 2 at `1b757c6cb`; D5, D6, D14; owner P-1 (the version bump) and P-4 (a correction that ends the match is refused); X-SR-2, X-SR-5; P5 (server half); review I8 (real ledgers), M9 (the race assertion); Review Focus 1; the §8 seam "the override is folded through every caller from a real `writeFixtureRulesOverride` write".

**Files:**
- Create: `apps/web/src/server/engine-db/refreeze.ts`: `refreezeFixture(tx, fixtureId, cfg)`, extracted from `admin-fixture-config.ts:212-338` (the snapshot write plus the `match_states` upsert). Its snapshot `update` also sets `rules_version = rules_version + 1` and returns the new value (P-1: a correction and a staff re-freeze are the ONLY two bumps, and both go through this one function).
- Modify: `apps/web/src/server/usecases/admin-fixture-config.ts`: `resnapshotFixtureConfig` (`:155`) calls `refreezeFixture`. Behaviour is unchanged except that it now bumps `rules_version`, so an open pad learns of a staff re-freeze too. It passes the real `rules_override` through the resolver since Task 10.
- Create: `apps/web/src/server/usecases/fixture-rules.ts`
- Create: `apps/web/src/app/api/v1/fixtures/[id]/rules/route.ts` (`PUT`). Copy the auth call from `app/api/v1/fixtures/[id]/route.ts`'s PATCH.
- Modify: `apps/web/src/server/api-v1/schemas.ts` (`PutFixtureRules = z.object({rules: z.record(z.string(), z.unknown()).nullable()})`), `openapi.ts` (route + summary listing the codes), `openapi/*.json`.
- Modify: `apps/web/src/lib/rule-errors.ts` (`FIXTURE_FORMAT_LOCKED`, `FORMAT_DOES_NOT_FIT_PLAY` present; verify).
- Modify: `apps/web/src/server/engine-db/__tests__/bracket-overlay-callers.test.ts`: the override seeding now calls `writeFixtureRulesOverride` (the §8 seam).
- Create: `apps/web/src/server/usecases/__tests__/fixture-rules.test.ts`
- Modify: `scripts/smoke.ts` (two checks)
- Create: `MUT/t14.json`

**Interfaces:**
- Consumes: Task 4's `checkFixtureOverride`; Task 10's `resolveFixtureCfg`; `loadFoldInputs`, `foldFrom` (`fold.ts`); `hasFrozenCfg`; `LOCKED_FIXTURE_STATUSES`; the fixture advisory lock `pg_advisory_xact_lock(hashtext('fixture:'||id))` (`append-event.ts:189`).
- Produces:
  ```ts
  export interface OverrideWriteResult { readonly fixtures: readonly { id: string; started: boolean; rules_version: number }[] }
  // engine-db/refreeze.ts
  export async function refreezeFixture(tx: Tx, fixtureId: string, cfg: unknown): Promise<{ rules_version: number }>;
  export async function writeFixtureRulesOverride(auth: AuthCtx, fixtureIds: readonly string[], fragment: Record<string, unknown> | null): Promise<OverrideWriteResult>;
  // PUT /api/v1/fixtures/{id}/rules {rules} → 200 OverrideWriteResult
  ```
  The future competition-desk bulk action calls this function unchanged.

**The correction's "fits" test (D6; owner P-4 "A").** For each listed sport, refold the recorded ledger under the corrected cfg. It fits iff:
- the fold does not throw;
- `outcome` is unchanged;
- `module.summary(state).headline` (the score as shown) is unchanged.

That is how "never re-scores a played match" becomes a check (finding 23). When only the corrected fold has an outcome, the refusal reads "This format would end the match as it stands" (P-4).

- [ ] **Step 1: Write the failing test** — `fixture-rules.test.ts`:

```ts
// X-SR-2, X-SR-5, P5 — the one writer. Expected verdicts come from the signed rows
// (X-SR-5: "a started, unfinished match's format may be corrected only if the
// recorded play fits it") and the engine's own fold, never from the writer.
import { afterAll, describe, expect, it } from "vitest";
import { sql } from "@/lib/db";
import { appendEvent } from "@/server/engine-db";
import { writeFixtureRulesOverride } from "../fixture-rules";
import { seedBracket } from "@/server/engine-db/__tests__/helpers/seed-bracket";
import { resolveLatestModule } from "@seazn/engine/sports";
import { resnapshotFixtureConfig } from "../admin-fixture-config";

const HAS_DB = !!process.env.DATABASE_URL;
afterAll(async () => { await (globalThis as { _sql?: { end(): Promise<void> } })._sql?.end(); });
const row = async (id: string) => (await sql<{ rules_override: unknown; config_snapshot: Record<string, unknown> | null; rules_version: number }[]>`
  select rules_override, config_snapshot, rules_version from fixtures where id = ${id}`)[0]!;
const events = async (id: string) => Number((await sql<{ n: string }[]>`select count(*)::text n from score_events where fixture_id = ${id}`)[0]!.n);
const audit = async (id: string) => sql<{ payload: { before: unknown; after: unknown; started: boolean } }[]>`
  select payload from competition_events where type = 'fixture.rules_override' and payload->>'fixture_id' = ${id} order by created_at`;

describe.skipIf(!HAS_DB)("X-SR-2 writeFixtureRulesOverride — unstarted", () => {
  it("empty: null on a fixture without an override writes SQL null and one audit row", async () => {
    const b = await seedBracket({ sport: "badminton", variant: "short", stageKind: "league", entrants: 2 });
    await writeFixtureRulesOverride(b.auth, [b.fixtureIds[0]!], null);
    expect((await row(b.fixtureIds[0]!)).rules_override).toBeNull();
    expect(await audit(b.fixtureIds[0]!)).toHaveLength(1);
  });
  it("a match key is written; a second write REPLACES (never merges); {} clears", async () => {
    const b = await seedBracket({ sport: "badminton", variant: "short", stageKind: "league", entrants: 2 });
    const id = b.fixtureIds[0]!;
    await writeFixtureRulesOverride(b.auth, [id], { bestOf: 1 });
    await writeFixtureRulesOverride(b.auth, [id], { setTo: 15 });
    expect((await row(id)).rules_override).toEqual({ setTo: 15 });
    await writeFixtureRulesOverride(b.auth, [id], {});
    expect((await row(id)).rules_override).toBeNull();
  });
  it("a stage-only key is refused RULE_NOT_SETTABLE; nothing written", async () => {
    const b = await seedBracket({ sport: "football", variant: "11-a-side", stageKind: "knockout", entrants: 2 });
    await expect(writeFixtureRulesOverride(b.auth, [b.fixtureIds[0]!], { shootout: false })).rejects.toMatchObject({ code: "RULE_NOT_SETTABLE" });
    expect((await row(b.fixtureIds[0]!)).rules_override).toBeNull();
  });
  it("all-or-nothing: one finalized fixture in the batch refuses the batch and names it", async () => {
    const b = await seedBracket({ sport: "badminton", variant: "short", stageKind: "league", entrants: 3 });
    const [a, z] = b.fixtureIds;
    await sql`update fixtures set status = 'finalized' where id = ${z!}`;
    await expect(writeFixtureRulesOverride(b.auth, [a!, z!], { bestOf: 1 })).rejects.toMatchObject({ code: "FIXTURE_FORMAT_LOCKED", extra: { fixture_id: z } });
    expect((await row(a!)).rules_override).toBeNull();
  });
});

// I8 — a real ledger: one badminton set played to its end with the module's own rally event
// (`badminton.rally {wonBy}`, the shape public-player-matches.test.ts:707 uses). The rally count is the
// variant's own `setTo` (read from the module, never typed), so a preset change moves the test with it.
const badminton = resolveLatestModule("badminton");
const SHORT = badminton.configSchema.parse(badminton.variants["short"]) as { setTo: number; bestOf: number };
const sides = async (id: string) =>
  (await sql<{ home: string; away: string }[]>`select home_entrant_id as home, away_entrant_id as away from fixtures where id = ${id}`)[0]!;
async function playSet(orgId: string, id: string, seq0: number, winner: string): Promise<{ next: number; lastId: string }> {
  let seq = seq0, lastId = "";
  for (let i = 0; i < SHORT.setTo; i++) lastId = (await appendEvent(orgId, id, seq++, { type: "badminton.rally", payload: { wonBy: winner } })).event.id;
  return { next: seq, lastId };
}
async function oneSetPlayed(b: Awaited<ReturnType<typeof seedBracket>>) {
  const id = b.fixtureIds[0]!;
  const { home } = await sides(id);
  await appendEvent(b.auth.orgId, id, 0, { type: "core.start", payload: {} });
  const { next, lastId } = await playSet(b.auth.orgId, id, 1, home);
  return { id, home, next, lastRallyId: lastId };
}

describe.skipIf(!HAS_DB)("X-SR-5 P5 correction of a started match", () => {
  it("precondition: the short preset is best of 3, so one set leaves the match open", () => {
    expect(SHORT.bestOf).toBe(3);
  });
  it("fits: badminton best of 3 → 5 after one completed set; snapshot re-frozen, version bumped once, audit says started", async () => {
    const b = await seedBracket({ sport: "badminton", variant: "short", stageKind: "league", entrants: 2 });
    const { id } = await oneSetPlayed(b);
    const before = await row(id);
    expect(before.rules_version).toBe(0);                       // the first event freezes; it never bumps (P-1)
    const out = await writeFixtureRulesOverride(b.auth, [id], { bestOf: 5 });
    const r = await row(id);
    expect(r.config_snapshot).toMatchObject({ bestOf: 5 });
    expect(r.rules_version).toBe(1);
    expect(out.fixtures[0]).toMatchObject({ id, started: true, rules_version: 1 });
    expect(await events(id)).toBe(1 + SHORT.setTo);             // nothing appended or removed by a correction
    expect((await audit(id)).at(-1)!.payload).toMatchObject({ started: true, after: { bestOf: 5 } });
  });
  it("an UNSTARTED write never bumps the version (only a correction or a re-freeze does)", async () => {
    const b = await seedBracket({ sport: "badminton", variant: "short", stageKind: "league", entrants: 2 });
    await writeFixtureRulesOverride(b.auth, [b.fixtureIds[0]!], { bestOf: 1 });
    expect((await row(b.fixtureIds[0]!)).rules_version).toBe(0);
  });
  it("a staff re-freeze (resnapshotFixtureConfig) bumps the version through refreezeFixture", async () => {
    const b = await seedBracket({ sport: "badminton", variant: "short", stageKind: "league", entrants: 2 });
    const { id } = await oneSetPlayed(b);
    await resnapshotFixtureConfig(staffActorId, id, "w2c: staff re-freeze bumps the version"); // (actorId, fixtureId, reason) — admin-fixture-config.ts:155
    expect((await row(id)).rules_version).toBe(1);
  });
  it("does not fit: football extra time switched off while the match is in extra time → FORMAT_DOES_NOT_FIT_PLAY with the engine's reason; nothing changed", async () => {
    const b = await seedBracket({ sport: "football", variant: "11-a-side", stageKind: "knockout", entrants: 2, stageConfig: { rules: { extraTime: { enabled: true, halfMinutes: 15 }, shootout: true } } });
    const id = b.fixtureIds[0]!;
    let seq = 0;
    for (const [type, payload] of [["core.start", {}], ["football.period", { phase: "HT" }], ["football.period", { phase: "FT" }], ["football.period", { phase: "ET_HT" }]] as const)
      await appendEvent(b.auth.orgId, id, seq++, { type, payload });
    const before = await row(id);
    const err = await writeFixtureRulesOverride(b.auth, [id], { extraTime: { enabled: false, halfMinutes: 15 } }).catch((e) => e);
    expect(err).toMatchObject({ status: 409, code: "FORMAT_DOES_NOT_FIT_PLAY" });
    expect(String(err.message).length).toBeGreaterThan(0);
    expect(await row(id)).toEqual(before);                      // rules_version included: a refusal bumps nothing
  });
  it("P-4: a correction that would END the match is refused (best of 3 → 1 after a completed set); nothing changed", async () => {
    const b = await seedBracket({ sport: "badminton", variant: "short", stageKind: "league", entrants: 2 });
    const { id } = await oneSetPlayed(b);
    const before = await row(id);
    const err = await writeFixtureRulesOverride(b.auth, [id], { bestOf: 1 }).catch((e) => e);
    expect(err).toMatchObject({ status: 409, code: "FORMAT_DOES_NOT_FIT_PLAY" });
    expect(String(err.message)).toBe("This format would end the match as it stands");
    expect(await row(id)).toEqual(before);
  });
  it("P-4 positive pair: the same best-of-1 correction BEFORE any set completes fits", async () => {
    const b = await seedBracket({ sport: "badminton", variant: "short", stageKind: "league", entrants: 2 });
    const id = b.fixtureIds[0]!;
    const { home } = await sides(id);
    await appendEvent(b.auth.orgId, id, 0, { type: "core.start", payload: {} });
    await appendEvent(b.auth.orgId, id, 1, { type: "badminton.rally", payload: { wonBy: home } });
    await writeFixtureRulesOverride(b.auth, [id], { bestOf: 1 });
    expect((await row(id)).config_snapshot).toMatchObject({ bestOf: 1 });
  });
  it("finalized → FIXTURE_FORMAT_LOCKED; cancelled likewise", async () => {
    for (const status of ["finalized", "cancelled"]) {
      const b = await seedBracket({ sport: "badminton", variant: "short", stageKind: "league", entrants: 2 });
      await sql`update fixtures set status = ${status} where id = ${b.fixtureIds[0]!}`;
      await expect(writeFixtureRulesOverride(b.auth, [b.fixtureIds[0]!], { bestOf: 1 })).rejects.toMatchObject({ code: "FIXTURE_FORMAT_LOCKED" });
    }
  });
  it("after a void that empties the play, a correction still refolds (the ledger, not the score, decides)", async () => {
    const b = await seedBracket({ sport: "badminton", variant: "short", stageKind: "league", entrants: 2 });
    const { id, next, lastRallyId } = await oneSetPlayed(b);
    // void the set's last rally by its real id: the set is open again, so best of 1 no longer ends the match
    const v = await appendEvent(b.auth.orgId, id, next, { type: "core.void", payload: {}, voids: lastRallyId });
    expect(v.event.voids).toBe(lastRallyId);                               // the void landed
    expect(v.outcome).toBeNull();                                          // and the match is open again
    await writeFixtureRulesOverride(b.auth, [id], { bestOf: 1 });
    expect((await row(id)).config_snapshot).toMatchObject({ bestOf: 1 });
  });
  it("Review Focus 1: a correction and an append serialise on the fixture lock (M9)", async () => {
    let runs = 0;
    for (let i = 0; i < 5; i++) {
      const b = await seedBracket({ sport: "badminton", variant: "short", stageKind: "league", entrants: 2 });
      const id = b.fixtureIds[0]!;
      const [w, a] = await Promise.allSettled([
        writeFixtureRulesOverride(b.auth, [id], { bestOf: 1 }),
        appendEvent(b.auth.orgId, id, 0, { type: "core.start", payload: {} }),
      ]);
      expect(w.status).toBe("fulfilled");                       // unstarted or fits: neither order refuses
      expect(a.status).toBe("fulfilled");
      const r = await row(id);
      expect(r.rules_override).toEqual({ bestOf: 1 });
      // Either order must leave the frozen snapshot at best of 1: if the writer ran first, the start froze the
      // override; if the start ran first, the writer saw a frozen snapshot and refolded (then rules_version is 1).
      expect((r.config_snapshot as { bestOf: number } | null)?.bestOf).toBe(1);
      expect(r.rules_version).toBeLessThanOrEqual(1);
      runs++;
    }
    expect(runs).toBe(5);
  });
});
```

Notes for the implementer:
- `seedBracket` takes `variant` as declared (use `declaredVariant`).
- Its signature has no `stageConfig.rules` until D3. Add the parameter pass-through if it is missing.
- `resolveLatestModule` comes from `@seazn/engine/sports` (as in Task 2); `resnapshotFixtureConfig` from `../admin-fixture-config`. Its signature is `(actorId: string, fixtureId: string, reason: string)`, and an empty reason is refused 400. `staffActorId` is the staff user id the existing admin suite seeds (`git grep -l -a resnapshotFixtureConfig -- apps/web/src '*.test.ts'`). Copy its seeding, and never invent a caller (re-review minor).
- The void case assumes the set kernel reopens a set when its last rally is voided. Before relying on it, read the kernel's void handling; if a void cannot reopen a completed set, void the whole set's rallies instead, and say which in a comment.

Add the rule-10 property:

```ts
describe.skipIf(!HAS_DB)("rule 10 — override × start × correction × void × finalize", () => {
  it("invariants after every step", async () => {
    let steps = 0, voidsLanded = 0;
    await fc.assert(fc.asyncProperty(fc.array(fc.constantFrom("write3", "write1", "clear", "start", "void", "finalize"), { minLength: 1, maxLength: 7 }), async (ops) => {
      const b = await seedBracket({ sport: "badminton", variant: "short", stageKind: "league", entrants: 2 });
      const id = b.fixtureIds[0]!;
      let seq = 0, finalized = false, lastVersion = 0;
      const live: string[] = [];                                           // unvoided, non-void event ids
      for (const op of ops) {
        steps++;
        if (op === "start" && seq === 0 && !finalized) { live.push((await appendEvent(b.auth.orgId, id, seq++, { type: "core.start", payload: {} })).event.id); continue; }
        if (op === "void" && live.length > 0 && !finalized) {
          const target = live.pop()!;
          const v = await appendEvent(b.auth.orgId, id, seq++, { type: "core.void", payload: {}, voids: target });
          expect(v.event.voids).toBe(target);                              // the void branch really ran
          voidsLanded++; continue;
        }
        if (op === "finalize") { await sql`update fixtures set status = 'finalized' where id = ${id}`; finalized = true; continue; }
        const frag = op === "clear" ? {} : { bestOf: op === "write1" ? 1 : 3 };
        const p = writeFixtureRulesOverride(b.auth, [id], frag);
        if (finalized) { await expect(p).rejects.toMatchObject({ code: "FIXTURE_FORMAT_LOCKED" }); continue; }
        await p.catch(() => undefined);
        const r = await row(id);
        // a frozen snapshot always agrees with the stored override on every key the override sets
        if (r.config_snapshot && r.rules_override) for (const [k, v] of Object.entries(r.rules_override as object)) expect(r.config_snapshot[k]).toEqual(v);
        expect(r.rules_version).toBeGreaterThanOrEqual(lastVersion); // the version never goes back
        lastVersion = r.rules_version;
      }
    }), { seed: 20261013, numRuns: 20 });
    expect(steps).toBeGreaterThan(0);
    expect(voidsLanded, "the seeded runs never reached a void after a start").toBeGreaterThan(0);
  }, Math.max(5_000, 20 * 7 * 400 * 5));
});
```

- [ ] **Step 2: Run to verify red** (the module does not exist → collect failure; stub it to throw, then re-run: assertion reds).

- [ ] **Step 3: Implement** `fixture-rules.ts` per D5/D6:
  - one `sql.begin`;
  - sort the ids;
  - per id:
    1. `pg_advisory_xact_lock(hashtext('fixture:'||id))`;
    2. load the row with its division, stage and org check;
    3. status in `LOCKED_FIXTURE_STATUSES` → `FIXTURE_FORMAT_LOCKED` with `extra: {fixture_id}`;
    4. `stageResolved = resolveFixtureCfg({config_snapshot: null, rules_override: null}, …)`;
    5. `checkFixtureOverride` → `UNKNOWN_RULE_KEY`/`RULE_NOT_SETTABLE` with `extra: {fixture_id, field: path}`;
    6. `corrected = resolveFixtureCfg({config_snapshot: null, rules_override: fragment}, …)` parsed by `module.configSchema` (`CONFIG_INVALID`);
    7. if `hasFrozenCfg(row.config_snapshot)`:
       - `inputs = await loadFoldInputs(id)`. This reads outside `tx`, but the advisory lock is held, and appends take the same lock, so the ledger cannot move.
       - Fold twice, once with `inputs.cfg` and once with `corrected`.
       - Refuse `FORMAT_DOES_NOT_FIT_PLAY` when the fold throws (message = the engine's), when the outcomes differ, or when the headlines differ. The message is exactly "This format would end the match as it stands" when only the corrected fold has an outcome (P-4); otherwise it is the engine's reason.
       - Otherwise `refreezeFixture(tx, id, corrected)`: it rewrites the snapshot and bumps `rules_version` by one (P-1).
    8. `update fixtures set rules_override = <fragment or null>`;
    9. audit `competition_events` `fixture.rules_override` `{fixture_id, before, after, started}`.
  - Route plus OpenAPI.
  - Re-point `bracket-overlay-callers.test.ts`'s seeding to the writer.
  - Smoke:
    - `w2c: a match override saves and the pad cfg shows it` (PUT, then `GET /api/v1/fixtures/{id}/state` carries the effective format);
    - `w2c: a finished match's format is locked` (finalize, then PUT → 409 `FIXTURE_FORMAT_LOCKED`).

- [ ] **Step 4: Run** the new test, `bracket-overlay-callers.test.ts`, the admin-fixture-config suite (`git grep -l -a resnapshotFixtureConfig -- apps/web/src '*.test.ts'`), `fixture-cfg-order.test.ts`, `tsc`, eslint, the OpenAPI diff and the smoke suite.

- [ ] **Step 5: Mutate once** — `MUT/t14.json`:

```json
[
  { "id": "t14-fits-outcome", "file": "apps/web/src/server/usecases/fixture-rules.ts",
    "find": "outcomesDiffer(", "replace": "false && outcomesDiffer(",
    "killers": [{ "cwd": "apps/web", "files": ["src/server/usecases/__tests__/fixture-rules.test.ts"], "name": "P-4: a correction that would END the match is refused" }] },
  { "id": "t14-locked", "file": "apps/web/src/server/usecases/fixture-rules.ts",
    "find": "LOCKED_FIXTURE_STATUSES.includes(", "replace": "false && LOCKED_FIXTURE_STATUSES.includes(",
    "killers": [{ "cwd": "apps/web", "files": ["src/server/usecases/__tests__/fixture-rules.test.ts"], "name": "finalized" }] },
  { "id": "t14-replace", "file": "apps/web/src/server/usecases/fixture-rules.ts",
    "find": "const next = isEmpty(fragment) ? null : fragment;", "replace": "const next = { ...(row.rules_override as object ?? {}), ...(fragment ?? {}) };",
    "killers": [{ "cwd": "apps/web", "files": ["src/server/usecases/__tests__/fixture-rules.test.ts"], "name": "REPLACES" }] },
  { "id": "t14-version-bump", "file": "apps/web/src/server/engine-db/refreeze.ts",
    "find": "rules_version = rules_version + 1", "replace": "rules_version = rules_version",
    "killers": [{ "cwd": "apps/web", "files": ["src/server/usecases/__tests__/fixture-rules.test.ts"], "name": "version bumped once" }] }
]
```
The implementation names `outcomesDiffer`, `isEmpty` and `next` as written here, so the mutants address it.

- [ ] **Step 6: Commit** `feat(w2c): one override writer; a live correction must fit the recorded play (X-SR-2, X-SR-5)`.

**Test types:**
- Unit: above, including the race and the property.
- E2E: Task 19 `e2e/match-rules-w2c.spec.ts` "X-SR-2 change one match's format before it starts" and "X-SR-5 correct a live match's format"; Task 15's remote-pad e2e (P5 e2e).
- Smoke: the two checks above.
- Regression: `bracket-overlay-callers.test.ts`; the admin re-snapshot suite (the extracted helper must not change its behaviour).

**Sequence cases:** null on empty first; write, replace, clear; refused key; batch with a locked fixture; started fits, does not fit, would end (and its positive pair before a set completes); an unstarted write leaves the version at 0; a staff re-freeze bumps it; after a void; finalize; another sport (football); the race.

### Task 15: Open pads follow a correction — the rules version (owner P-1 "A"; Opus)

> **Carried from Task 2 review (I-1, orchestrator ruling).** The first event vs a division save can put one stage on mixed rules: `patchDivision` takes no lock, and `appendEventInTx` locks only `fixture:<id>` while reading LIVE `divisions.config` for an unsnapshotted fixture (`append-event.ts` ~:215/:287) and freezing it. Fix on a NEW advisory key (`division-config:<divisionId>`; not `division:`, whose holders take fixture locks → deadlock risk): `patchDivision` takes it EXCLUSIVE before its refusal read; `appendEventInTx` takes it SHARED (`pg_advisory_xact_lock_shared`) only when the fixture has no snapshot, after the fixture lock and before the division read. Test with two connections: hold the patch open past its refusal read, run the first event, commit; red = mixed snapshots in one stage, green = the patch is refused naming the stage (or the event waits and freezes the new config). Mutate each lock call once. Correct the stale claim at `stage-rules.ts:137-148`, and CLOSE that race too (batch-1 Opus review): `putStageRules` (Task 11's every-sport version) takes `division-config:` EXCLUSIVE as well, with its own two-connection red→green test and one mutant. **Lock order after W2b (#945):** W2b takes the stage lock before every fixture lock in `fed-seats.ts`, `scoring.ts` and `stages.ts`; re-read those paths after the rebase and place the shared `division-config:` lock so no path holds it while waiting on a stage or fixture lock another path holds in the opposite order (state the global order in the commit message).

Spec §2.1 #3 (pad half); §4.5 item 2 at `1b757c6cb`; §7 `FIXTURE_RULES_CHANGED`; §9 P5 e2e; D14; X-SR-7. Review C1 (the first draft compared `config_snapshot_at` to the first event's `recorded_at`, and refused a null version after a re-freeze, which also refused the server's own writers) and C2 (other POST sites and server writers; finding 32). The column was created in Task 10 and is bumped only by `refreezeFixture` (Task 14).

**The rule (D14, P-1).**
- `fixtures.rules_version` is an integer counter, 0 until a correction or a staff re-freeze bumps it.
- `appendEventInTx` checks it ONLY when the sender includes `rules_version`. A sent value that differs from the row's is refused `FIXTURE_RULES_CHANGED` (409) before any insert. An absent value is never checked.
- **Senders that always send it** (the two scoring pads): `components/v2/scorepad/transport.ts:355` and `components/v2/device-score-pad.tsx:318`.
  - The remote pad's scoring TAPS go through `deviceLinkTransport(token, init)` (`transport.ts:450`) → `makeTransport` → the POST at `:355`, the same sender as the console pad's `sessionTransport`. So `TransportInit` carries the version for both.
  - `device-score-pad.tsx:318` is the device CHROME ("void my last entry" and similar; re-review minor). It still sends the version per P-1, so a chrome void after a correction is refused like a tap.
- **Never send it, never blocked:**
  - `components/v2/fixture-console.tsx:634` (the console chrome `post()`: start, void, settle, forfeit, abandon, finalize; finding 37);
  - `components/v2/americano-panel.tsx:154` and `:160`;
  - the server writers `usecases/withdrawal.ts:121-160` (`withdrawEntrantCascade`), `usecases/scoring.ts:868` (`finalizeFixture`), and `usecases/event-import.ts:354` (`importEvents`). They call the append path directly, without the field.

**Files:**
- Create: `apps/web/e2e/remote-pad-rules-w2c.spec.ts` (the probe in Step 1 becomes its first test and is KEPT)
- Modify: `apps/web/src/server/api-v1/schemas.ts`: `AppendEventRequest` (`:1828`) gains `rules_version: z.number().int().nonnegative().optional()` (absent means unchecked; there is no null).
- Modify: `apps/web/src/server/usecases/scoring.ts:140` (`scoreEvent` threads it) and `apps/web/src/server/engine-db/append-event.ts`: the check after the advisory lock (`:189`) and BEFORE any insert. Every accepted response carries the row's `rules_version`.
- Modify: `apps/web/src/server/usecases/fixtures.ts:98-131`: `loadFixturePadCfg` returns `rulesVersion: number`.
- Modify: `apps/web/src/app/api/v1/fixtures/[id]/rules/route.ts`: add `GET` → `{cfg, rules_version, format_line}` (`format_line` from Task 16's describer once it lands; until then `effectiveRulesLine` as today).
- Modify: `apps/web/src/components/v2/scorepad/{transport.ts:355, pipeline.ts:152,203, use-pad-pipeline.ts, refusal-copy.ts}`:
  - send the loaded or captured version on every append;
  - on `FIXTURE_RULES_CHANGED`, or a newer `rules_version` in a response: reload the rules and raise the banner;
  - a queued tap refused for this reason is dropped with the banner, never resent under the new rules.
- Modify: `apps/web/src/components/v2/device-score-pad.tsx:318`: the body gains `rules_version`. The value comes from a new `rulesVersion` prop, set by `app/score/[token]/page.tsx` from `loadFixturePadCfg`. On the refusal it shows the same banner and reloads (`router.refresh()`, as the pad already does after a refusal; read `:330-360`).
- Modify: `apps/web/src/components/v2/scorepad/v3/types.ts` (bootstrap gains `rulesVersion`), `apps/web/src/app/score/[token]/page.tsx:265-270`, `apps/web/src/app/o/[orgSlug]/c/[compSlug]/d/[divSlug]/f/[no]/page.tsx:79` (pass it through).
- Create: `apps/web/src/components/v2/scorepad/v3/rules-changed-banner.tsx` (`data-testid="pad-rules-changed"`), used by both pads.
- Modify: `apps/web/src/dictionaries/{en,es,fr,nl}/ui.json`: `pad.rulesChanged` = "The organiser changed this match's format: {format}" plus es/fr/nl; `ruleLock.FIXTURE_RULES_CHANGED` (same sentence). Then `pnpm i18n:gen-keys`.
- Modify: `apps/web/src/lib/rule-errors.ts` (`FIXTURE_RULES_CHANGED: 409`).
- Create:
  - `apps/web/src/server/engine-db/__tests__/rules-version.test.ts` (the check);
  - `apps/web/src/server/usecases/__tests__/rules-version-writers.test.ts` (the non-senders are never blocked);
  - `apps/web/src/components/v2/__tests__/events-post-sites.test.ts` (the source scan);
  - `apps/web/src/components/v2/scorepad/__tests__/rules-version-transport.test.ts` (the pipeline).
- Modify: `scripts/smoke.ts` (one check)
- Create: `MUT/t15.json`

**Interfaces:**
- Consumes: Task 10's `rules_version` column; Task 14's writer and `refreezeFixture` (the only bump).
- Produces:
  - the wire field `rules_version: number` on pad appends and on every accepted response;
  - `GET /api/v1/fixtures/{id}/rules`;
  - `loadFixturePadCfg(...).rulesVersion: number`;
  - `FIXTURE_RULES_CHANGED` (409, `extra: {rules_version: number, format: string}`).

- [ ] **Step 1: DRIVE today's behaviour first (read ≠ run).** Write the probe as the spec's first test and run it on the tree BEFORE any Task 15 change:

```ts
// e2e/remote-pad-rules-w2c.spec.ts — kept as a probe (memory: keep probe specs).
import { expect, test } from "@playwright/test";
import { apiJson, addEntrantsViaApi, createStageAndGenerate, TAG } from "./helpers";

test("probe: an open remote pad after a live correction (records today's behaviour)", async ({ browser, request }) => {
  const seeded = await seedLiveBadminton(request); // local helper below: league stage, 2 entrants, generated, core.start appended
  const minted = await apiJson<{ secret: string }>(request, `/api/v1/fixtures/${seeded.fixtureId}/device-links`, "POST", { label: `w2c ${TAG}` });
  const pad = await (await browser.newContext()).newPage();
  await pad.goto(`/score/${minted.data!.secret}`);
  const formatBefore = await pad.getByTestId("pad-format-line").textContent().catch(() => null);
  const fix = await apiJson(request, `/api/v1/fixtures/${seeded.fixtureId}/rules`, "PUT", { rules: { bestOf: 5 } });
  expect(fix.status).toBe(200);
  await pad.waitForTimeout(20_000); // the pad's own refresh cadence, if any (probe only)
  const formatAfter = await pad.getByTestId("pad-format-line").textContent().catch(() => null);
  test.info().annotations.push({ type: "observed", description: JSON.stringify({ formatBefore, formatAfter }) });
});
```

`seedLiveBadminton` is a local helper in the spec. It POSTs a competition, a badminton `short` division, `addEntrantsViaApi(…, 2)`, `createStageAndGenerate(…, "league")`, and one `core.start` through `/api/v1/fixtures/{id}/events` with `expected_seq: 0`, then returns `{fixtureId}`. If the pad has no `pad-format-line` testid, the probe records the visible header text instead (read the skin for its testids first).

Run the whole file (Global Constraints, Playwright). Record in the task report and in `w2c-state.md`:
- whether the format text changed without a reload;
- whether a tap after the correction was accepted;
- under which cfg it folded (read `score_events`, then `GET /state`).

The result decides only how much of Step 4's client work already exists. **It never removes the server check.**

- [ ] **Step 2: Write the failing tests.**

`rules-version.test.ts` (the check). Every `core.void` through `scoreEvent` names its target as `payload: {event_id}`, the id `scoreEvent` returned; that is the shape `scoring.ts:205` maps to `voids` and `assertUndoTarget` (`:408-416`) checks. A top-level `voids` is ignored there and answers `UNDO_NOOP` (re-review IMP-R1):

```ts
import { afterAll, describe, expect, it } from "vitest";
import { sql } from "@/lib/db";
import { scoreEvent } from "@/server/usecases/scoring";
import { writeFixtureRulesOverride } from "@/server/usecases/fixture-rules";
import { loadFixturePadCfg } from "@/server/usecases/fixtures";
import { seedBracket } from "./helpers/seed-bracket";

const HAS_DB = !!process.env.DATABASE_URL;
afterAll(async () => { await (globalThis as { _sql?: { end(): Promise<void> } })._sql?.end(); });
const count = async (id: string) => Number((await sql<{ n: string }[]>`select count(*)::text n from score_events where fixture_id = ${id}`)[0]!.n);
async function liveBadminton() {
  const b = await seedBracket({ sport: "badminton", variant: "short", stageKind: "league", entrants: 2 });
  const id = b.fixtureIds[0]!;
  const started = await scoreEvent(b.auth, id, { expected_seq: 0, type: "core.start", payload: {} });
  return { b, id, startId: started.event_id };
}
const voidOf = (startId: string) => ({ type: "core.void", payload: { event_id: startId } });

describe.skipIf(!HAS_DB)("X-SR-7 a tap sent under old rules is never applied under new ones", () => {
  it("the empty case: version 0 with no correction is accepted, and the response carries 0", async () => {
    const { b, id, startId } = await liveBadminton();
    expect((await loadFixturePadCfg(b.auth, id)).rulesVersion).toBe(0);
    await expect(scoreEvent(b.auth, id, { expected_seq: 1, ...voidOf(startId), rules_version: 0 } as never)).resolves.toMatchObject({ rules_version: 0 });
    const [{ n }] = await sql<{ n: number }[]>`select count(*)::int n from score_events where fixture_id = ${id} and voids_event_id = ${startId}`;
    expect(n).toBe(1);                                                     // the void landed (not UNDO_NOOP)
  });
  it("a second device that loaded before the first event (version 0) is accepted after a normal first freeze", async () => {
    const { b, id, startId } = await liveBadminton();          // device A started the match; device B loaded at version 0 before it
    await expect(scoreEvent(b.auth, id, { expected_seq: 1, ...voidOf(startId), rules_version: 0 } as never)).resolves.toBeDefined();
  });
  it("after a correction: a stale version is refused FIXTURE_RULES_CHANGED and NO event is written; the current version is accepted", async () => {
    const { b, id, startId } = await liveBadminton();
    const stale = (await loadFixturePadCfg(b.auth, id)).rulesVersion;
    await writeFixtureRulesOverride(b.auth, [id], { bestOf: 5 });
    const before = await count(id);
    const err = await scoreEvent(b.auth, id, { expected_seq: 1, ...voidOf(startId), rules_version: stale } as never).catch((e) => e);
    expect(err).toMatchObject({ status: 409, code: "FIXTURE_RULES_CHANGED", extra: { rules_version: stale + 1 } });
    expect(await count(id)).toBe(before);
    const fresh = (await loadFixturePadCfg(b.auth, id)).rulesVersion;
    expect(fresh).toBe(stale + 1);
    await expect(scoreEvent(b.auth, id, { expected_seq: 1, ...voidOf(startId), rules_version: fresh } as never)).resolves.toMatchObject({ rules_version: fresh });
  });
  it("after a correction: an append WITHOUT the field is never checked (P-1)", async () => {
    const { b, id, startId } = await liveBadminton();
    await writeFixtureRulesOverride(b.auth, [id], { bestOf: 5 });
    await expect(scoreEvent(b.auth, id, { expected_seq: 1, ...voidOf(startId) } as never)).resolves.toBeDefined();
  });
  it("a version from the future is refused too (≠, not <)", async () => {
    const { b, id, startId } = await liveBadminton();
    await expect(scoreEvent(b.auth, id, { expected_seq: 1, ...voidOf(startId), rules_version: 7 } as never)).rejects.toMatchObject({ code: "FIXTURE_RULES_CHANGED" });
  });
  it("another sport (football): the same refusal", async () => {
    const b = await seedBracket({ sport: "football", variant: "11-a-side", stageKind: "league", entrants: 2 });
    const id = b.fixtureIds[0]!;
    await scoreEvent(b.auth, id, { expected_seq: 0, type: "core.start", payload: {} });
    await writeFixtureRulesOverride(b.auth, [id], { halfMinutes: 40 });
    await expect(scoreEvent(b.auth, id, { expected_seq: 1, type: "football.period", payload: { phase: "HT" }, rules_version: 0 } as never)).rejects.toMatchObject({ code: "FIXTURE_RULES_CHANGED" });
  });
});
```

`rules-version-writers.test.ts` (C2: the server's own writers are never blocked by a correction). Each case runs `liveBadminton()`-style seeding (football for withdrawal if that suite's seeding needs a team sport), then `writeFixtureRulesOverride(…, {bestOf: 5})` so `rules_version` is 1, then:
- **withdrawal:** `withdrawEntrantCascade(...)` on one entrant succeeds, and the fixture's `score_events` contain a row the cascade wrote after the correction (match it by type: a `core.forfeit` OR a `core.abandon` with `expunge`, whichever the cascade emits for that phase — assert on the set of new rows, not on "the last row"). Copy the call from `withdrawal-decider-hold.test.ts`.
- **finalize:** play the match to `decided` (two sets with the `badminton.rally {wonBy}` loop Task 14 uses), correct before the second set, then `finalizeFixture(auth, id, seq)` resolves and the status is `finalized`.
- **settle:** `scoreEvent(auth, id, {expected_seq, type: "core.settle", payload: {winner, method: "organiser"}})` with no `rules_version` resolves. Copy the payload from `settle-seating.test.ts:148`.
- **import is NOT a case (re-review minor).** `importEvents` refuses any fixture that already has a `score_events` row or a non-`scheduled` status (`event-import.ts:223-230`). A corrected fixture has started (a correction to an unstarted fixture bumps nothing), so "import after a correction" cannot happen. P-1 listed it; this is recorded as finding 38 rather than tested vacuously. The import path stays classified as a non-sender.
- **counted:** the file asserts that exactly these three writers ran (`expect(ran).toEqual(["withdrawal", "finalize", "settle"])`).

`events-post-sites.test.ts` (the source scan, P-1):

```ts
// P-1: every client POST to /api/v1/fixtures/{id}/events is classified. A pad site must send rules_version;
// every other site must not (it is never checked, so sending it would make a console action refusable).
import { readFileSync } from "node:fs";
import { execSync } from "node:child_process";
import { describe, expect, it } from "vitest";

const SITES: Readonly<Record<string, "pad" | "other">> = {
  "src/components/v2/scorepad/transport.ts": "pad",
  "src/components/v2/device-score-pad.tsx": "pad",
  "src/components/v2/fixture-console.tsx": "other",     // console chrome: start/void/settle/forfeit/abandon/finalize
  "src/components/v2/americano-panel.tsx": "other",     // two sites
};
const PATTERN = "/api/v1/fixtures/\\$\\{[^}]+\\}/events`";

function sites(): { file: string; line: number }[] {
  const out = execSync(`git grep -n -a -E '${PATTERN}' -- 'src/**/*.ts' 'src/**/*.tsx' ':!**/__tests__/**' ':!**/*.test.*'`, { cwd: process.cwd(), encoding: "utf8" });
  return out.trim().split("\n").filter(Boolean).map((l) => { const [file, line] = l.split(":"); return { file: file!, line: Number(line) }; });
}

describe("P-1 events POST sites", () => {
  it("every site is classified, and the scan finds exactly the known five", () => {
    const found = sites();
    for (const s of found) expect(SITES[s.file], `${s.file}:${s.line} is not classified`).toBeDefined();
    expect(found).toHaveLength(5);
    expect(new Set(found.map((s) => s.file))).toEqual(new Set(Object.keys(SITES)));
  });
  it("a pad site sends rules_version within its request body; an other site does not", () => {
    let checked = 0;
    for (const s of sites()) {
      const body = readFileSync(s.file, "utf8").split("\n").slice(s.line - 1, s.line + 14).join("\n");
      expect(/\brules_version\b/.test(body), `${s.file}:${s.line}`).toBe(SITES[s.file] === "pad");
      checked++;
    }
    expect(checked).toBe(5);
  });
});
```
- Run it from `apps/web` (its cwd is the vitest root).
- The 15-line window covers each site's literal body (`device-score-pad.tsx:318-326`, `transport.ts:355`). If `transport.ts` builds its body elsewhere (`pipeline.ts:203`), the pad classification for `transport.ts` instead asserts the builder's output in `rules-version-transport.test.ts`, and this test checks that `transport.ts` passes the built body. Record which.

`rules-version-transport.test.ts`: build a wire body through `pipeline.ts`'s exported builder (the function at `:203`) and assert:
- it carries the `rules_version` the pipeline was constructed with;
- a replayed persisted event keeps its captured version, not the current one;
- a `FIXTURE_RULES_CHANGED` refusal is classified as non-retryable by the pipeline's existing refusal classifier (the one `refused-write.test.ts` exercises).

- [ ] **Step 3: Run to verify red** (the four files; judge). Expected:
  - `rules_version` is stripped by the schema, so a stale append is accepted and the count assertions fail;
  - `rulesVersion` is undefined;
  - the scan fails on both pad sites;
  - the writers file is green already (a characterisation; it must stay green after Step 4, and Step 6's mutant must red it).

- [ ] **Step 4: Implement.**
  - **Server.** After the lock in `appendEventInTx`, select `rules_version` with the row. Then:
    ```ts
    if (input.rules_version !== undefined && input.rules_version !== row.rules_version)
      throw new HttpError(409, ruleErrorMessage("FIXTURE_RULES_CHANGED", { reason: formatLine }), "FIXTURE_RULES_CHANGED", { rules_version: row.rules_version, format: formatLine });
    ```
    Every accepted response adds `rules_version: row.rules_version`. The server writers keep calling the append path without the field. Do not add it to them.
  - **Clients.**
    - v3: thread `rulesVersion` from both pages into the pipeline. On a newer `rules_version` in a response, or on the refusal: `GET /rules`, swap the pad cfg, and show `RulesChangedBanner` with `msg("pad.rulesChanged", {format})`.
    - Device pad: the prop, the body field, and the banner plus refresh.
    - Run `frontend-design`: the banner sits above the board on phones (`order-*` per the phone composition), with `role="status"`.
  - The console chrome and the americano panel are NOT changed.

- [ ] **Step 5: Run.**
  - Unit: the four new files; `refused-write.test.ts`, `transport.test.ts`, `pipeline.test.ts`, `use-pad-pipeline.test.tsx`, `append-event.test.ts`, `app/score/[token]/__tests__/page.test.tsx`.
  - `tsc`, eslint, `pnpm i18n:check`, the OpenAPI diff, and the smoke check `w2c: a stale rules version is refused and writes nothing`.
  - Then the e2e spec, whole file, with the P5 e2e test added:

```ts
test("X-SR-7 P5: remote pad open on a live match; the organiser corrects the format; the pad says so; a stale tap writes nothing", async ({ browser, request }) => {
  const seeded = await seedLiveBadminton(request);
  const minted = await apiJson<{ secret: string }>(request, `/api/v1/fixtures/${seeded.fixtureId}/device-links`, "POST", { label: `w2c ${TAG}` });
  const pad = await (await browser.newContext()).newPage();
  await pad.goto(`/score/${minted.data!.secret}`);
  const before = await countEvents(request, seeded.fixtureId);
  const fix = await apiJson(request, `/api/v1/fixtures/${seeded.fixtureId}/rules`, "PUT", { rules: { bestOf: 5 } });
  expect(fix.status).toBe(200);
  await pad.getByTestId("pad-point-home").click();                       // sent with the stale version
  await expect(pad.getByTestId("pad-rules-changed")).toBeVisible();
  await expect(pad.getByTestId("pad-rules-changed")).toContainText(/best of 5/i);
  expect(await countEvents(request, seeded.fixtureId)).toBe(before);     // read back from score_events via GET /events
  await pad.getByTestId("pad-point-home").click();                       // positive pair: now on the current version
  await expect.poll(() => countEvents(request, seeded.fixtureId)).toBe(before + 1);
});
```
  - `countEvents` reads `GET /api/v1/fixtures/{id}/events?since_seq=0` and returns its length.
  - `pad-point-home` stands for the badminton pad's rally control. Use the testid the badminton skin actually renders: `git grep -n -a 'data-testid' -- apps/web/src/components/v2/scorepad/v3/skins/badminton.tsx`.
  - Then add the banner to `mobile.spec.ts`: one test that opens the remote pad at each width project, triggers the correction, and asserts `pad-rules-changed` is visible with `expectNoHorizontalScroll`. Run the whole file on the seven width projects.
  - Per-screen verdicts at 1280/768/320, using cropped screenshots in `$TMPDIR`, never committed.

- [ ] **Step 6: Mutate once** — `MUT/t15.json`:

```json
[
  { "id": "t15-stale", "file": "apps/web/src/server/engine-db/append-event.ts",
    "find": "input.rules_version !== row.rules_version", "replace": "false",
    "killers": [{ "cwd": "apps/web", "files": ["src/server/engine-db/__tests__/rules-version.test.ts"], "name": "a stale version is refused" }] },
  { "id": "t15-only-when-sent", "file": "apps/web/src/server/engine-db/append-event.ts",
    "find": "input.rules_version !== undefined && ", "replace": "",
    "killers": [{ "cwd": "apps/web", "files": ["src/server/usecases/__tests__/rules-version-writers.test.ts"], "name": "withdrawal" }] },
  { "id": "t15-transport-sender", "file": "apps/web/src/components/v2/scorepad/transport.ts",
    "find": "rules_version: event.rulesVersion,", "replace": "",
    "killers": [{ "cwd": "apps/web", "files": ["src/components/v2/scorepad/__tests__/rules-version-transport.test.ts"], "name": "carries the rules_version" }] },
  { "id": "t15-scan-pad", "file": "apps/web/src/components/v2/device-score-pad.tsx",
    "find": "rules_version: rulesVersion,", "replace": "",
    "killers": [{ "cwd": "apps/web", "files": ["src/components/v2/__tests__/events-post-sites.test.ts"], "name": "a pad site sends rules_version" }] }
]
```
- The second mutant also reds the "WITHOUT the field" case in `rules-version.test.ts`. The writers file must red on its own, which is why it is the named killer.
- The transport writes the body field as `rules_version: event.rulesVersion,` (the version captured with the queued event, so an offline replay keeps it), and the device chrome writes `rules_version: rulesVersion,`. The mutants address those literals.
- `rules-version-transport.test.ts` gains a case named "carries the rules_version". It drives `deviceLinkTransport(token, {fetch: stub, …})` and asserts that the POST body the stub receives carries the version. That is the remote pad's real tap path, not only the pipeline builder.

- [ ] **Step 7: Commit** `feat(w2c): open pads follow a correction; a stale pad tap is refused (X-SR-7, P-1)`.

**Test types:**
- Unit: the four files.
- E2E: `e2e/remote-pad-rules-w2c.spec.ts` (probe plus P5), and the `mobile.spec.ts` width test.
- Smoke: the check above.
- Regression: the scorepad pipeline/transport suites; `append-event.test.ts`; the score-page test; `scorepad-offline.spec.ts` (whole file, since the offline replay path changed); the withdrawal, finalize and import suites through the writers file.

**Sequence cases:**
- version 0 with no correction first;
- a second device at 0;
- a correction, then a stale tap;
- a correction, then an unversioned append;
- a future version;
- the current version;
- each server writer that can run after a correction (withdrawal, finalize, settle);
- an offline replay;
- another sport.

---
### Task 16: Public labels say the rules for every sport

Spec item 15, plus the public half of items 10, 12 and 13; X-SR-1 (public), X-PT-1 (public line).

**Files:**
- Modify: `apps/web/src/server/public-site/describe-rules.ts`:
  - `describeMatchRules` drops the `STAGE_RULES_SPORTS` gate (`:207`) and dispatches through a describer table keyed by the module's rule FAMILY (strategy pattern: 11 sports, 5 families; an if/else chain is what it replaces);
  - add `describeDeciders(module, kind, cfg)` and `describeAbandon(module, cfg)`;
  - `rulesDifferFromDivision` compares on `stageKeysFor ∪ fixtureKeysFor` (Task 4) instead of `configKeysFor`.
- Modify: `apps/web/src/server/public-site/stage-format-lines.ts`: resolve each stage through Task 10's `resolveFixtureCfg({ config_snapshot: null, rules_override: null }, divisionCfg, stage, module)` (the stage-resolved cfg, exactly as Task 14 computes it), so decider keys are part of the line (the comment at `:30-35` that excludes them is now false; replace it).
- Create: `apps/web/src/lib/points-line.ts` (client-safe, like `rules-line.ts`)
- Modify: `apps/web/src/server/public-site/data.ts`: the stage payload carries `points` when the stage has its own.
- Modify: `apps/web/src/dictionaries/{en,es,fr,nl}/public.json`: the keys listed in Step 3. Then `pnpm i18n:gen-keys`.
- Modify: `apps/web/src/server/public-site/__tests__/describe-rules.test.ts`: the import of `STAGE_RULES_SPORTS` goes; the "every other sport answers null" case is replaced by Step 1's sweep.
- Create: `apps/web/src/lib/__tests__/points-line.test.ts`
- Modify: `scripts/smoke.ts` (one check)
- Create: `MUT/t16.json`

**Interfaces:**
- Consumes: Task 4's `stageKeysFor`/`fixtureKeysFor`; Task 6's `stageDefaults`; Task 7's abandon options; Task 8's `tiebreakRungs`; Task 9's `PointsRule` (with `forfeit`); Task 10's `resolveFixtureCfg`.
- Produces:
  ```ts
  // describe-rules.ts
  export type RuleFamily = "setbased" | "nested" | "period" | "innings" | "boards" | "board" | "score";
  export function ruleFamilyOf(module: AnySportModule): RuleFamily; // from module.ruleKeys' shape, never from sportKey
  export function describeMatchRules(sportKey: string, module_: AnySportModule | null | undefined, cfg: unknown): RulesLineT | null; // signature unchanged
  export function describeDeciders(module_: AnySportModule, kind: StageKind, cfg: unknown): RulesLineT; // [] when the kind has no deciders
  export function describeAbandon(module_: AnySportModule, cfg: unknown): RulesLineT;     // [] when the sport declares no abandon options
  // lib/points-line.ts
  export function pointsLine(rule: PointsRule): readonly RulesClause[];
  ```
  `ruleFamilyOf` reads the module's DECLARATIONS, so a twelfth sport with a known family gets a line with no web change. An unknown shape answers `null`, never throws. How each family is detected is in Step 3.

- [ ] **Step 1: Write the failing tests.** In `describe-rules.test.ts`, replace the four-sport assumption with a sweep. Every expected number is read from the module's own variants through its `configSchema`, as the file's header already requires:

```ts
import { builtinModules } from "@seazn/engine/sports";
import { BRACKET_KINDS } from "@seazn/engine/core";
import { stageDefaultsFor, stageKeysFor } from "@seazn/engine/sport";
import { describeDeciders, describeAbandon } from "../describe-rules";

describe("X-SR-1 every sport's format line (public)", () => {
  it("every builtin sport × every declared variant answers a non-empty line in all 4 locales (counted)", () => {
    let checked = 0;
    for (const m of builtinModules) for (const v of Object.keys(m.variants)) {
      const line = describeMatchRules(m.key, m, variantCfg(m.key, v));
      expect(line, `${m.key}/${v}`).not.toBeNull();
      expect(line!.length, `${m.key}/${v}`).toBeGreaterThan(0);
      for (const dict of [enPublic, esPublic, frPublic, nlPublic]) {
        const text = rulesLineText(dict as never, line!);
        expect(text, `${m.key}/${v}`).not.toMatch(/format\.rules\./);  // an unresolved key prints its own name
        expect(text, `${m.key}/${v}`).not.toMatch(/\{[a-z]+\}/);       // an unfilled param
      }
      checked++;
    }
    expect(checked).toBe(builtinModules.reduce((n, m) => n + Object.keys(m.variants).length, 0));
    expect(checked).toBeGreaterThan(builtinModules.length);
  });

  it("a period sport's line carries its own numbers (football 11-a-side vs a variant that differs)", () => {
    const m = mod("football");
    const variants = Object.keys(m.variants);
    const lines = variants.map((v) => rulesLineText(enPublic as never, describeMatchRules("football", m, variantCfg("football", v))!));
    // Two variants whose halfMinutes differ must print different lines.
    const halves = variants.map((v) => (variantCfg("football", v) as { halfMinutes: number }).halfMinutes);
    const i = halves.findIndex((h) => h !== halves[0]);
    expect(i, "football declares two variants with different halves").toBeGreaterThan(0);
    expect(lines[i]).not.toBe(lines[0]);
    expect(lines[0]).toContain(String(halves[0]));
  });

  it("deciders: every bracket kind of every sport says its preset deciders; a table kind says none", () => {
    let checked = 0;
    for (const m of builtinModules) {
      const v = Object.keys(m.variants)[0]!;
      for (const kind of BRACKET_KINDS) {
        const preset = stageDefaultsFor(m, kind, v);
        const line = describeDeciders(m, kind, { ...variantCfg(m.key, v), ...preset });
        expect(line.length > 0, `${m.key}/${kind}`).toBe(Object.keys(preset).length > 0);
        checked++;
      }
      expect(describeDeciders(m, "league", variantCfg(m.key, v))).toEqual([]);
    }
    expect(checked).toBe(builtinModules.length * BRACKET_KINDS.length);
  });

  it("all deciders off says so (the spectator is told a level match waits for the organiser)", () => {
    const m = mod("football");
    const line = describeDeciders(m, "knockout", { ...variantCfg("football", "11-a-side"), extraTime: { enabled: false, halfMinutes: 15 }, shootout: false });
    expect(line).toEqual([{ key: "format.rules.decider.none" }]);
  });

  it("abandon: a sport that declares options names the chosen one; one that declares none says nothing", () => {
    let withOptions = 0;
    for (const m of builtinModules) {
      const v = Object.keys(m.variants)[0]!;
      const line = describeAbandon(m, variantCfg(m.key, v));
      if (stageKeysFor(m, "league", v).includes("abandonPolicy")) { expect(line.length, m.key).toBe(1); withOptions++; }
      else expect(line, m.key).toEqual([]);
    }
    expect(withOptions).toBeGreaterThan(0);
  });
});
```

`points-line.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import enPublic from "@/dictionaries/en/public.json";
import { rulesLineText } from "@/lib/rules-line";
import { pointsLine } from "../points-line";

describe("X-PT-1 the stage points sentence", () => {
  it("base only", () => {
    expect(rulesLineText(enPublic as never, pointsLine({ base: { win: 3, draw: 1, loss: 0 } }))).toBe("Win 3, draw 1, loss 0");
  });
  it("a forfeit row is its own clause, with its own numbers (2 ≠ the base win's 3)", () => {
    const text = rulesLineText(enPublic as never, pointsLine({ base: { win: 3, draw: 1, loss: 0 }, forfeit: { winnerPoints: 2, loserPoints: 0 } }));
    expect(text).toBe("Win 3, draw 1, loss 0, walkover 2–0");
  });
  it("bonuses are counted, not listed (one clause)", () => {
    const line = pointsLine({ base: { win: 4, draw: 2, loss: 0 }, bonuses: [{ when: "loss_margin_lte", param: 7, points: 1 }, { when: "scored_gte", param: 4, points: 1 }] } as never);
    expect(line.at(-1)).toEqual({ key: "format.points.bonuses", params: { n: 2 } });
  });
});
```
The English strings above are the proposed copy. They are signed with the Step 3 keys.

- [ ] **Step 2: Run to verify red.** Expected: `null` for seven sports; `describeDeciders`/`describeAbandon`/`pointsLine` undefined.

- [ ] **Step 3: Implement.**
  - **Families**, read from `ruleKeys` (Task 4):
    - `set` → `nested` (Task 4 declares tennis's top-level key `set`, not `set.games`; review M2);
    - `setTo` → `setbased`;
    - `halfMinutes` or `periods.minutes` → `period`;
    - `ballsPerInnings` → `innings` (printed as overs: `ballsPerInnings / cfg.ballsPerOver`);
    - `maxBoards` → `boards`;
    - `clock` → `board` (chess, item 14);
    - otherwise `score`.
  - **The table:**
    ```ts
    const DESCRIBERS: Record<RuleFamily, (sportKey: string, c: Record<string, unknown>) => RulesLineT | null> = {
      setbased: (k, c) => { const b = positive(c.bestOf); return b === undefined ? null : [describeSetKernel(k, c, b)]; },
      nested: (_k, c) => { const b = positive(c.bestOf); return b === undefined ? null : describeNested(c, b); },
      period: (_k, c) => describePeriods(c),
      innings: (_k, c) => describeInnings(c),
      boards: (_k, c) => describeBoards(c),
      board: (_k, c) => describeBoardGame(c),
      score: (_k, c) => describeScore(c),
    };
    ```
    The existing `describeSetKernel`/`describeNested` stay byte-identical, so the current describe-rules cases stay green unchanged.
  - **New `public.json` keys** (English proposed; es/fr/nl translated in the same commit):
    | Key | English |
    |---|---|
    | `format.rules.period.halves` | "{n} × {m} min" |
    | `format.rules.period.quarters` | "4 × {m} min" |
    | `format.rules.period.thirds` | "3 × {m} min" |
    | `format.rules.innings.overs` | "{n} overs a side" |
    | `format.rules.boards.count` | "{n} boards" |
    | `format.rules.board.clock` | "{base} min + {inc} s" |
    | `format.rules.score.firstTo` | "First to {n}" |
    | `format.rules.score.open` | "Score entered at the end" |
    | `format.rules.decider.extraTime` | "extra time {n} min" |
    | `format.rules.decider.shootout` | "penalties ({n})" |
    | `format.rules.decider.superOver` | "super over" |
    | `format.rules.decider.extraBoard` | "extra board" |
    | `format.rules.decider.rungs` | "tie-breaks: {list}" |
    | `format.rules.decider.armageddon` | "Armageddon" |
    | `format.rules.decider.none` | "level matches wait for the organiser" |
    | `format.rules.abandon.<option>` | one per declared option across all sports (Task 7's list) |
    | `format.points.base` | "Win {win}, draw {draw}, loss {loss}" |
    | `format.points.forfeit` | "walkover {w}–{l}" |
    | `format.points.bonuses` | "{n} bonus rules" |

    The period describer chooses halves, quarters or thirds from the module's declared period count, never from `sportKey`. Each describer reads only keys `ruleKeys` declares.
  - `stage-format-lines.ts` appends `describeDeciders(...)` for bracket kinds, plus `pointsLine` when the stage has `points`.
  - Smoke: `w2c: the public division page states a hockey stage's format`. Fetch the public division page HTML and assert the English halves/quarters clause is present, anchored on `="` per the AGENTS.md HTML rule where it is an attribute.

- [ ] **Step 4: Run** the two tests, `rules-line.test.ts`, `public-fixture-loaders-identity.test.ts`, every suite importing `stage-format-lines` (`git grep -l -a stageFormatLines -- apps/web/src '*.test.ts'`), `tsc`, eslint, `pnpm i18n:check` and the smoke suite. Judge as in Global Constraints.

- [ ] **Step 5: Mutate once** — `MUT/t16.json`:

```json
[
  { "id": "t16-family", "file": "apps/web/src/server/public-site/describe-rules.ts",
    "find": "period: (_k, c) => describePeriods(c),", "replace": "period: () => null,",
    "killers": [{ "cwd": "apps/web", "files": ["src/server/public-site/__tests__/describe-rules.test.ts"], "name": "every builtin sport" }] },
  { "id": "t16-forfeit", "file": "apps/web/src/lib/points-line.ts",
    "find": "if (rule.forfeit)", "replace": "if (false)",
    "killers": [{ "cwd": "apps/web", "files": ["src/lib/__tests__/points-line.test.ts"], "name": "a forfeit row" }] }
]
```

- [ ] **Step 6: Commit** `feat(w2c): public format lines for every sport, deciders and stage points`.

**Test types:**
- Unit: above.
- E2E: Task 17's "X-SR-1 every sport shows its stage fields" asserts the public stage chip for a hockey stage; Task 18's X-PT-1 asserts the points sentence on the public table.
- Smoke: the check above.
- Regression: the existing describe-rules cases unchanged (the four set-based sports print exactly as before), plus `public-fixture-loaders-identity.test.ts`.

**Sequence cases:** a table kind (no deciders) first; every bracket kind; all off; another family per sport; a stage with points and one without.

---

### Task 17: S1 + S4 — the stage format row for every sport (UI)

> **Mockups (design of record, owner picked A):** `docs/superpowers/specs/2026-10-13-format-matrix-w2c-mockups/` — open the screen's HTML beside the build before sign-off (README there maps screen → file).

> **Carried from Task 4 re-review.** The X-SR-6 "every decider off" notice must read the RESOLVED cfg (after `bracketDeciders`), not only `stage.rules`: until Task 8/13b land, chess `bracketDeciders` forces `tiebreak` on, so a notice saying tie-breaks are off would be false. Test the notice against a chess knockout stage with its list empty.

Spec items 1, 5, 6, 7, 9, 12, 13 and 14 (UI half); §5.3 S1, S4 (stage); X-SR-1, X-SR-3, X-SR-6, BG-KO-3 (UI); Review Focus 4 (the notice).

**Files:**
- Modify: `apps/web/src/components/v2/stages-panel.tsx`:
  - `StageFormatRow` (`:2130`) renders `stageFieldsFor({ module, stageKind: kind, variant })` (Task 5) for every sport;
  - the `STAGE_RULES_SPORTS` import (`:43`) is deleted.
- Modify: `apps/web/src/components/v2/match-rules.tsx`:
  - `MatchRuleFields` (`:26`) gains the `"sequence"` control (an ordered, reorderable list for `tiebreakRungs`, with add/remove from the declared options);
  - the `STAGE_RULES_SPORTS` re-export (`:6,:22`) goes.
- Create: `apps/web/src/components/v2/stage-rules/sequence-field.tsx`; `apps/web/src/components/v2/stage-rules/deciders-off-notice.tsx`
- Modify: `apps/web/src/lib/match-rules/index.ts`: delete `STAGE_RULES_SPORTS` (its last consumer goes here; the division `page.tsx` conjunct went in Task 11).
- Modify: `apps/web/src/dictionaries/{en,es,fr,nl}/ui.json`. Then `pnpm i18n:gen-keys`. Keys:
  - `stageRules.preset.knockout`: "Knockout defaults for {sport}";
  - `stageRules.decidersOff`: "Level matches in this stage will wait for your decision (lot, seed or your call)";
  - `stageRules.locked`: "This stage has started — its format is locked";
  - `stageRules.sequence.add`, `.remove`, `.moveUp`, `.moveDown`, `.empty` ("No tie-breaks: a level match waits for you");
  - `stageRules.edit`: "Edit rules"; `stageRules.useDivision`: "Use division rules";
  - `stageRules.source.division`: "Division"; `stageRules.source.stage`: "This stage";
  - `stageRules.section.format`: "Match format"; `.deciders`: "Deciders"; `.abandon`: "If abandoned"; `.points`: "Points";
  - `stageRules.lockedLink`: "See the fixtures".
- Create: `apps/web/e2e/stage-rules-w2c.spec.ts`
- Modify: `apps/web/e2e/mobile.spec.ts` (one test across the width projects)
- Modify: `apps/web/src/components/v2/__tests__/stages-panel*.test.tsx` (`git grep -l -a StageFormatRow -- apps/web/src '*.test.tsx'`)
- Create: `apps/web/src/components/v2/stage-rules/stage-row-model.ts`. Review I9: the two decisions the mutants target live in a pure helper with a unit killer, never a Playwright one.
  ```ts
  /** The stage row's fields for this sport, stage kind and variant (wraps Task 5's stageFieldsFor). */
  export function stageFieldsShown(module: SportModule, kind: StageKind, variant: string | null): readonly RuleField[];
  /** True when the stage is a bracket kind and every decider the module's bracketDeciders sets is switched off in `values`. */
  export function decidersAllOff(module: SportModule, kind: StageKind, values: Record<string, unknown>): boolean;
  /** Owner P-5: each abandon option with its availability. `share` is unavailable while the effective cfg has allowDraws === false. */
  export function abandonOptionStates(module: SportModule, values: Record<string, unknown>): readonly { value: string; disabled: boolean; reasonKey: string | null }[];
  ```
  The abandon select renders a disabled option with the reason `msg("stageRules.abandon.shareNeedsDraws")` beside it. Dictionary key, all four locales: `stageRules.abandon.shareNeedsDraws` = "Sharing the points needs draws to be allowed".
  `stages-panel.tsx` renders `{decidersAllOff(…) && <DecidersOffNotice …/>}` and maps `stageFieldsShown(…)`.
- Create: `apps/web/src/components/v2/stage-rules/__tests__/stage-row-model.test.ts`:
  ```ts
  import { describe, expect, it } from "vitest";
  import { builtinModules } from "@seazn/engine/sports";
  import { BRACKET_KINDS } from "@seazn/engine/core";
  import { stageKeysFor } from "@seazn/engine/sport";
  import { abandonOptionStates, decidersAllOff, stageFieldsShown } from "../stage-row-model";

  const football = builtinModules.find((m) => m.key === "football")!;
  describe("stage row model (I9 killers for t17)", () => {
    it("football KO with both deciders off holds; one on does not; a league never shows the notice (empty case)", () => {
      expect(decidersAllOff(football, "knockout", { extraTime: { enabled: false, halfMinutes: 15 }, shootout: false })).toBe(true);
      expect(decidersAllOff(football, "knockout", { extraTime: { enabled: true, halfMinutes: 15 }, shootout: false })).toBe(false);
      expect(decidersAllOff(football, "league", { extraTime: { enabled: false, halfMinutes: 15 }, shootout: false })).toBe(false);
    });
    it("P-5: generic share is unavailable, with the reason, while draws are off; available when on; carrom always", () => {
      const generic = builtinModules.find((m) => m.key === "generic")!;
      const carrom = builtinModules.find((m) => m.key === "carrom")!;
      const share = (m: typeof generic, v: Record<string, unknown>) => abandonOptionStates(m, v).find((o) => o.value === "share")!;
      expect(share(generic, { allowDraws: false })).toEqual({ value: "share", disabled: true, reasonKey: "stageRules.abandon.shareNeedsDraws" });
      expect(share(generic, { allowDraws: true }).disabled).toBe(false);
      expect(share(carrom, {}).disabled).toBe(false);
    });
    it("every sport shows its stage fields: each declared stage key is edited by a shown field (counted)", () => {
      let checked = 0;
      for (const m of builtinModules)
        for (const kind of ["league", ...BRACKET_KINDS] as const)
          for (const key of stageKeysFor(m, kind, null)) {
            const top = key.split(".")[0];
            expect(stageFieldsShown(m, kind, null).some((f) => f.edits.some((e) => e.split(".")[0] === top)), `${m.key}/${kind}/${key}`).toBe(true);
            checked++;
          }
      expect(checked).toBeGreaterThan(builtinModules.length);
    });
  });
  ```
  The `decidersAllOff` cases take the decider keys from `football.bracketDeciders(...)`. If football's deciders are named otherwise on the rebased tree, read them from there and keep the three cases.
- Create: `MUT/t17.json`

**Interfaces:**
- Consumes: Task 5's `stageFieldsFor(ctx: RuleContext): RuleField[]` (`RuleContext = { module, stageKind, variant }`) and `RuleField.kind` (now including `"sequence"`); Task 11's endpoint for every sport; Task 12's presets.
- Produces:
  - `data-testid="stage-format-row-<stageId>"`;
  - `stage-rule-field-<top segment of field.edits[0]>` per field (so the abandon field is `stage-rule-field-abandonPolicy`; two fields sharing a top segment share the testid, so tests take `.first()`);
  - `stage-deciders-off`;
  - `stage-format-locked`;
  - `stage-rule-sequence-<key>`, with items `-item-<i>`.

  Tasks 18, 19 and 20 reuse these testids.

- [ ] **Step 0: Run `frontend-design:frontend-design`** on the stage row (a phone-first layout).
  - The fields stack one per row below `md` and sit in a two-column grid at `md` and up.
  - The sequence control is a vertical list with ≥44px tap targets.
  - The notice is an inline callout (`role="status"`), not a toast.
  - Show the owner 2 layout options BEFORE building (memory: "2+ UI options"), as cropped screenshots of throwaway markup. Record the choice in `w2c-state.md`.

- [ ] **Step 1: Write the failing e2e** — `e2e/stage-rules-w2c.spec.ts`:

```ts
import { expect, test } from "@playwright/test";
import { builtinModules } from "@seazn/engine/sports";
import { stageKeysFor } from "@seazn/engine/sport";
import { apiJson, addEntrantsViaApi, createStageAndGenerate, TAG } from "./helpers";
import { abandonOptions } from "../src/lib/match-rules/shared"; // relative: the Playwright config has no `@/` alias

// Every expected key comes from the engine's declarations (stageKeysFor), never a typed list.
async function seedDivision(request, sport: string, variant: string) { /* POST competition + division; returns { divisionUrl, divisionId } — copy from division-settings.spec.ts's seeding */ }

test.describe("W2c stage rules (S1, S4)", () => {
  test("X-SR-1 every sport shows its stage fields", async ({ page, request }) => {
    let checked = 0;
    for (const m of builtinModules) {
      const variant = Object.keys(m.variants)[0]!;
      const d = await seedDivision(request, m.key, variant);
      const stage = await apiJson<{ id: string }[]>(request, `/api/v1/divisions/${d.divisionId}/stages`, "POST", [{ seq: 1, kind: "knockout", name: `KO ${TAG}`, config: {}, progression: null }]);
      await page.goto(`${d.divisionUrl}?tab=fixtures`);
      const row = page.getByTestId(`stage-format-row-${stage.data![0]!.id}`);
      await row.getByRole("button", { name: /edit rules/i }).click();
      for (const key of stageKeysFor(m, "knockout", variant)) {
        await expect(row.getByTestId(`stage-rule-field-${key.split(".")[0]}`).first(), `${m.key}:${key}`).toBeAttached();
      }
      checked++;
    }
    expect(checked).toBe(builtinModules.length);
  });

  test("X-SR-6 a new knockout stage shows its preset deciders, labelled as knockout defaults", async ({ page, request }) => {
    const d = await seedDivision(request, "football", "11-a-side");
    const st = await apiJson<{ id: string }[]>(request, `/api/v1/divisions/${d.divisionId}/stages`, "POST", [{ seq: 1, kind: "knockout", name: "KO", config: {}, progression: null }]);
    await page.goto(`${d.divisionUrl}?tab=fixtures`);
    const row = page.getByTestId(`stage-format-row-${st.data![0]!.id}`);
    await expect(row).toContainText(/knockout defaults/i);
    await row.getByRole("button", { name: /edit rules/i }).click();
    await expect(row.getByTestId("stage-rule-field-shootout").getByRole("checkbox")).toBeChecked();
  });

  test("X-SR-6 turning every decider off shows the hold notice before saving", async ({ page, request }) => {
    const d = await seedDivision(request, "football", "11-a-side");
    const st = await apiJson<{ id: string }[]>(request, `/api/v1/divisions/${d.divisionId}/stages`, "POST", [{ seq: 1, kind: "knockout", name: "KO", config: {}, progression: null }]);
    await page.goto(`${d.divisionUrl}?tab=fixtures`);
    const row = page.getByTestId(`stage-format-row-${st.data![0]!.id}`);
    await row.getByRole("button", { name: /edit rules/i }).click();
    await expect(row.getByTestId("stage-deciders-off")).toHaveCount(0);           // negative first …
    await row.getByTestId("stage-rule-field-shootout").getByRole("checkbox").uncheck();
    await row.getByTestId("stage-rule-field-extraTime").getByRole("checkbox").uncheck();
    await expect(row.getByTestId("stage-deciders-off")).toBeVisible();            // … then its positive pair
    await row.getByRole("button", { name: /save/i }).click();
    const after = await apiJson<{ config: { rules: Record<string, unknown> } }>(request, `/api/v1/stages/${st.data![0]!.id}`, "GET");
    expect(after.data!.config.rules).toMatchObject({ shootout: false, extraTime: { enabled: false } });
  });

  test("X-SR-1 abandon options follow the sport", async ({ page, request }) => {
    const d = await seedDivision(request, "hockey", Object.keys(builtinModules.find((m) => m.key === "hockey")!.variants)[0]!);
    const st = await apiJson<{ id: string }[]>(request, `/api/v1/divisions/${d.divisionId}/stages`, "POST", [{ seq: 1, kind: "league", name: "L", config: {}, progression: null }]);
    await page.goto(`${d.divisionUrl}?tab=fixtures`);
    const row = page.getByTestId(`stage-format-row-${st.data![0]!.id}`);
    await row.getByRole("button", { name: /edit rules/i }).click();
    const options = await row.getByTestId("stage-rule-field-abandonPolicy").locator("option").evaluateAll((os) => os.map((o) => (o as HTMLOptionElement).value));
    // The option list is Task 7's `abandonOptions(module)` (built from the schema enum); re-read its return shape first.
    expect(options).toEqual(abandonOptions(builtinModules.find((m) => m.key === "hockey")!).map((o) => o.value));
  });

  test("BG-KO-3 the chess tie-break sequence: reorder, remove all, save", async ({ page, request }) => {
    const chess = builtinModules.find((m) => m.key === "boardgame")!;
    const d = await seedDivision(request, "boardgame", Object.keys(chess.variants)[0]!);
    const st = await apiJson<{ id: string }[]>(request, `/api/v1/divisions/${d.divisionId}/stages`, "POST", [{ seq: 1, kind: "knockout", name: "KO", config: {}, progression: null }]);
    await page.goto(`${d.divisionUrl}?tab=fixtures`);
    const row = page.getByTestId(`stage-format-row-${st.data![0]!.id}`);
    await row.getByRole("button", { name: /edit rules/i }).click();
    const seq = row.getByTestId("stage-rule-sequence-tiebreakRungs");
    const before = await seq.locator('[data-testid^="stage-rule-sequence-tiebreakRungs-item-"]').allTextContents();
    expect(before.length).toBeGreaterThan(1);
    await seq.getByTestId("stage-rule-sequence-tiebreakRungs-item-1").getByRole("button", { name: /move up/i }).click();
    const swapped = await seq.locator('[data-testid^="stage-rule-sequence-tiebreakRungs-item-"]').allTextContents();
    expect(swapped).toEqual([before[1], before[0], ...before.slice(2)]);
    while (await seq.getByRole("button", { name: /remove/i }).count()) await seq.getByRole("button", { name: /remove/i }).first().click();
    await expect(seq).toContainText(/no tie-breaks/i);
    await row.getByRole("button", { name: /save/i }).click();
    const after = await apiJson<{ config: { rules: { tiebreakRungs: unknown[] } } }>(request, `/api/v1/stages/${st.data![0]!.id}`, "GET");
    expect(after.data!.config.rules.tiebreakRungs).toEqual([]);
  });

  test("X-SR-3 a started stage shows the lock line and no editable fields", async ({ page, request }) => {
    const d = await seedDivision(request, "badminton", "short");
    await addEntrantsViaApi(request, d.divisionId, 2);
    const { stageId, fixtureIds } = await createStageAndGenerate(request, d.divisionId, "league");
    await apiJson(request, `/api/v1/fixtures/${fixtureIds[0]}/events`, "POST", { expected_seq: 0, type: "core.start", payload: {} });
    await page.goto(`${d.divisionUrl}?tab=fixtures`);
    const row = page.getByTestId(`stage-format-row-${stageId}`);
    await expect(row.getByTestId("stage-format-locked")).toBeVisible();
    await expect(row.getByRole("button", { name: /edit rules/i })).toHaveCount(0);
  });
});
```
Notes:
- `seedDivision` is copied from `division-settings.spec.ts`'s seeding, and its body is written out in the spec.
- `createStageAndGenerate`'s return shape is re-read from `helpers.ts` before use.
- The GET stage route exists (`app/api/v1/stages/[id]/route.ts`); re-confirm it.
- The field testid takes the TOP key of a dotted path, because the field edits the top-level object (D1).

`mobile.spec.ts`: one test, "W2c stage format row at every width". It opens a football knockout row, toggles both deciders off and asserts:
- `stage-deciders-off` is visible;
- `expectNoHorizontalScroll(page)`;
- the sequence control on a chess row has every item's button ≥44px by `elementFromPoint` hit-test (AGENTS.md class 2), not `boundingBox`.

- [ ] **Step 2: Run to verify red.** Use the Global Constraints Playwright command on the whole spec file plus the whole `mobile.spec.ts` on the seven width projects. Expected: X-SR-1 fails for seven sports (no row rendered); the rest fail on the missing testids.

- [ ] **Step 3: Implement.** In `StageFormatRow`:
  0. Layout (spec §5.3 S1, owner-chosen A): a chip-style summary line; "Edit rules" expands IN PLACE into the sections Match format · Deciders · If abandoned · Points (Points is Task 18). Each field carries a *Division* or *This stage* label (preset knockout values say "Knockout defaults"). "Use division rules" sends `{rules: null}`. Sections stack below `md` (one DOM). The S4 lock line names the started stage and links to `?tab=fixtures`;
  1. `const fields = stageFieldsFor({ module, stageKind: kind, variant })`;
  2. render each through `MatchRuleFields`;
  3. hydrate from `stageConfig.rules` over the division cfg (unchanged logic);
  4. show `DecidersOffNotice` when `kind ∈ BRACKET_KINDS` and every decider field the sport declares reads off;
  5. show the preset label when the stored rules equal `stageDefaultsFor(...)`.

  `SequenceField`:
  - controlled list;
  - Move up/Move down/Remove buttons with `aria-label`s from the dictionary;
  - an Add menu from the field's declared options minus those present.

  Then delete `STAGE_RULES_SPORTS` and fix every import (`tsc` lists them).

- [ ] **Step 4: Run** the spec file, `mobile.spec.ts` (seven width projects, the whole file), the stages-panel unit suites, `tsc`, eslint and `pnpm i18n:check`. Then re-run the walkthrough `e2e/walkthrough/stage-rules-start-promotion.spec.ts` as a whole file. Then capture cropped screenshots of the stage row (closed, open football KO, open chess KO with the sequence, deciders off) at 1280/768/320 and give **per-screen verdicts**. Images live in `$TMPDIR` and are never committed.

- [ ] **Step 5: Mutate once** — `MUT/t17.json`:

```json
[
  { "id": "t17-notice", "file": "apps/web/src/components/v2/stage-rules/stage-row-model.ts",
    "find": "return isBracket && deciders.length > 0 && deciders.every(", "replace": "return false && deciders.every(",
    "killers": [{ "cwd": "apps/web", "files": ["src/components/v2/stage-rules/__tests__/stage-row-model.test.ts"], "name": "football KO with both deciders off holds" }] },
  { "id": "t17-fields", "file": "apps/web/src/components/v2/stage-rules/stage-row-model.ts",
    "find": "stageFieldsFor({ module, stageKind: kind, variant })", "replace": "stageFieldsFor({ module, stageKind: kind, variant }).slice(0, 1)",
    "killers": [{ "cwd": "apps/web", "files": ["src/components/v2/stage-rules/__tests__/stage-row-model.test.ts"], "name": "every sport shows its stage fields" }] }
]
```
`decidersAllOff` is written with the literal `return isBracket && deciders.length > 0 && deciders.every(` so the first mutant addresses it. The e2e tests "hold notice" and "every sport shows its stage fields" stay: they prove the panel is wired to the helpers.

- [ ] **Step 6: Commit** `feat(w2c): the stage format row for every sport, with the deciders-off notice (S1, S4)`.

**Test types:**
- Unit: the stages-panel suites updated for the new field set (class-scan tests anchored on `\s...hidden"` per AGENTS.md).
- E2E: the spec above, plus the width test.
- Smoke: N/A. The UI reads endpoints whose smoke checks are owned by Tasks 11 and 12; no new server path.
- Regression: the walkthrough re-run, and the existing stage-row e2e (`git grep -l -a "stage-format-row" -- apps/web/e2e`).

**Sequence cases:** a closed row first; open; toggle off then on (the notice comes and goes); save; reload; a started stage; another sport (the sweep); empty sequence.

---

### Task 18: S3 — stage points UI (same loop as Task 17)

> **Mockups (design of record, owner picked A):** `docs/superpowers/specs/2026-10-13-format-matrix-w2c-mockups/` — open the screen's HTML beside the build before sign-off (README there maps screen → file).

Spec items 10 and 11 (UI half); §5.3 S3; X-PT-1; Review Focus 3 (UI).

**Files:**
- Create: `apps/web/src/components/v2/stage-rules/stage-points-section.tsx`
- Modify: `apps/web/src/components/v2/stages-panel.tsx`: mount the section in `StageFormatRow` for table kinds only.
- Modify: `apps/web/src/dictionaries/{en,es,fr,nl}/ui.json`. Then `pnpm i18n:gen-keys`. Keys:
  - `stagePoints.title`: "Points";
  - `stagePoints.useDivision`: "Use the division's points";
  - `stagePoints.win`, `.draw`, `.loss`;
  - `stagePoints.sentence`: "A win earns {win} · a draw {draw} · a loss {loss}" (inputs inline);
  - `stagePoints.walkover`: "Walkover (nothing played): winner {w}, loser {l}";
  - `stagePoints.afterPlayNote`: "Retirement, disqualification or withdrawal after play earns normal points";
  - `stagePoints.more`: "More";
  - `stagePoints.bonuses`: "Bonus points";
  - `stagePoints.upgrade`: "Bonus and walkover points are part of Pro";
  - `stagePoints.inexpressible`: "This sport's points can't be set per stage yet". This shows for `POINTS_RULE_INEXPRESSIBLE`, rendered from the error's reason.
- Modify: `apps/web/e2e/stage-rules-w2c.spec.ts` (two tests); `apps/web/e2e/mobile.spec.ts` (the width test gains the points section)
- Create: `apps/web/src/components/v2/stage-rules/stage-points-model.ts` (review I9): `export function pointsSectionState(canCustom: boolean, expressible: boolean): "inexpressible" | "gate" | "editor"`. The order is inexpressible, then gate, then editor. `stage-points-section.tsx` switches on it.
- Create: `apps/web/src/components/v2/stage-rules/__tests__/stage-points-model.test.ts`: all four input pairs (counted, `checked === 4`): `(true, true)` → `"editor"`; `(false, true)` → `"gate"` (test name "Community org sees the gate"); `(true, false)` and `(false, false)` → `"inexpressible"` (an ice-hockey stage says why before it asks for Pro).
- Create: `MUT/t18.json`

**Interfaces:**
- Consumes:
  - Task 13's endpoint `{points}`;
  - Task 16's `pointsLine` (the preview sentence);
  - the entitlement read the stage-creation form already uses for `standings.custom_points` (`git grep -n -a "custom_points" -- apps/web/src/components`; reuse that hook, do not add one).
- Produces: testids `stage-points-<stageId>`, `stage-points-preview`, `stage-points-upgrade`, `stage-points-walkover-w`, `stage-points-walkover-l`.

- [ ] **Step 1: Write the failing e2e** (append to `stage-rules-w2c.spec.ts`):

```ts
test("ST-G8 stage points: preview, save, walkover row in the table (X-PT-1)", async ({ page, request }) => {
  const d = await seedDivision(request, "badminton", "short");
  await addEntrantsViaApi(request, d.divisionId, 2);
  const { stageId, fixtureIds } = await createStageAndGenerate(request, d.divisionId, "league");
  await page.goto(`${d.divisionUrl}?tab=fixtures`);
  const sec = page.getByTestId(`stage-points-${stageId}`);
  await sec.getByRole("checkbox", { name: /use the division/i }).uncheck();
  await sec.getByTestId("stage-points-walkover-w").fill("2");
  await sec.getByTestId("stage-points-walkover-l").fill("0");
  await expect(sec.getByTestId("stage-points-preview")).toContainText("walkover 2–0");
  await sec.getByRole("button", { name: /save/i }).click();
  // Drive the walkover through the product's own path, then read the table.
  const f = await apiJson<{ home_entrant_id: string; away_entrant_id: string }>(request, `/api/v1/fixtures/${fixtureIds[0]}`, "GET");
  // CoreForfeit is {by, reason} (W2b core/events.ts:64): `by` is the side that FORFEITS, so the AWAY side forfeits and home wins.
  await apiJson(request, `/api/v1/fixtures/${fixtureIds[0]}/events`, "POST", { expected_seq: 0, type: "core.forfeit", payload: { by: f.data!.away_entrant_id, reason: "walkover" } });
  await page.goto(`${d.divisionUrl}?tab=standings`);
  const winnerRow = page.getByTestId(`standings-row-${f.data!.home_entrant_id}`);
  await expect(winnerRow.getByTestId("standings-points")).toHaveText("2");      // 2, not the base win's 3
});

test("Review Focus 3: a Community org sees the gate, not the fields", async ({ browser }) => {
  // A Community-plan org: AUTH_STATE is the shared Pro org (memory), so sign in a fresh org on the community plan
  // using the helper the entitlements specs use (git grep -l -a "setOrgPlan" -- apps/web/e2e).
  const ctx = await communityOrgContext(browser);
  const page = await ctx.newPage();
  const d = await seedDivision(ctx.request, "badminton", "short");
  const { stageId } = await createStageAndGenerate(ctx.request, d.divisionId, "league");
  await page.goto(`${d.divisionUrl}?tab=fixtures`);
  const sec = page.getByTestId(`stage-points-${stageId}`);
  await sec.getByRole("checkbox", { name: /use the division/i }).uncheck();
  await expect(sec.getByRole("spinbutton", { name: /win/i })).toBeEditable();      // the base sentence works
  await expect(sec.getByTestId("stage-points-upgrade")).toBeVisible();
  await expect(sec.getByTestId("stage-points-walkover-w")).toHaveCount(0);
});
```
Notes:
- `communityOrgContext` is a local helper written in the spec from the entitlement specs' pattern (memory: `setOrgPlan` is GROUP-scoped, so use a fresh org).
- The `core.forfeit` payload shape is Task 9's. Re-read it from `packages/engine/src/core/events.ts` before running.
- The standings testids are re-read with `git grep -n -a 'data-testid="standings-' -- apps/web/src`; if they differ, use the real ones.

- [ ] **Step 2: Run to verify red.** Use the whole spec file, then the whole `mobile.spec.ts`.

- [ ] **Step 3: Implement** the section:
  - layout (spec §5.3 S3): the sentence row with inline inputs; the walkover sentence plus the after-play note; bonus rows filtered to the sport's metrics (`module.metrics`). Below `md` the walkover and bonus rows fold under one "More" disclosure (`phone-disclosure.tsx`); every e2e that asserts them opens it first, gated on the toggle being visible (AGENTS.md class 22);
  - the "use the division's points" toggle (off → `{points: null}`);
  - three number inputs;
  - the walkover pair, plus bonuses (the bonus editor already used by stage creation; `git grep -l -a "bonuses" -- apps/web/src/components/v2`), both behind the entitlement;
  - the live preview through `pointsLine` + `rulesLineText` with the PUBLIC dictionary slice the hub already ships to the client;
  - save → `PUT /api/v1/stages/{id}/rules {points}`;
  - on `POINTS_RULE_INEXPRESSIBLE`, the section renders `stagePoints.inexpressible` and no inputs (pre-checked from the division sport so the organiser never types into a dead form; the API remains the authority).

  Run `frontend-design` first.

- [ ] **Step 4: Run** as in Task 17 Step 4. Per-screen verdicts at 1280/768/320 for:
  - points closed;
  - open on Pro;
  - open on Community;
  - an ice-hockey stage (the inexpressible state).

- [ ] **Step 5: Mutate once** — `MUT/t18.json`:

```json
[
  { "id": "t18-gate", "file": "apps/web/src/components/v2/stage-rules/stage-points-model.ts",
    "find": "if (!canCustom) return \"gate\";", "replace": "",
    "killers": [{ "cwd": "apps/web", "files": ["src/components/v2/stage-rules/__tests__/stage-points-model.test.ts"], "name": "Community org sees the gate" }] }
]
```

- [ ] **Step 6: Commit** `feat(w2c): stage points section with walkover row and plan gate (S3, ST-G8)`.

**Test types:**
- Unit: N/A. The section is presentation over Task 13's validated endpoint and Task 16's tested `pointsLine`. Its logic is the toggle-to-null mapping, which the e2e save-and-read covers.
- E2E: above.
- Smoke: Task 13's walkover check covers the server path.
- Regression: the stage-creation points e2e (`git grep -l -a "custom_points\|bonuses" -- apps/web/e2e`) as whole files.

**Sequence cases:** use-division on (no points) first; off, save, reload; on again (clears); both entitlement states; the inexpressible sport.

---

### Task 19: S2 + S4 (match) — the match rules block on the fixture console, plus the run-sheet tag

> **Mockups (design of record, owner picked A):** `docs/superpowers/specs/2026-10-13-format-matrix-w2c-mockups/` — open the screen's HTML beside the build before sign-off (README there maps screen → file).

> **Carried from Task 5.** The football `extraTime` web field builds `{enabled, halfMinutes: 15}` on "On". As a match override against a stage whose extra time is shorter (or off), that is refused by the engine's `off_or_shorter` bound. The match form must seed extra time FROM THE STAGE's resolved value (and offer only off or shorter), never the field's default. Test: stage ET 2×10 → match form opens at 10, "On" with 15 is not offered.

Spec items 2 and 3 (UI half); §5.3 S2, S4 (match); X-SR-2, X-SR-5 (UI); P5 (console half).

**Files:**
- Create: `apps/web/src/components/v2/match-rules-block.tsx`
- Modify: `apps/web/src/components/v2/fixture-console.tsx`: accept and render the block (the R7 component, not the division tab).
- Modify: `apps/web/src/app/o/[orgSlug]/c/[compSlug]/d/[divSlug]/f/[no]/page.tsx`: load and pass `matchRules`.
- Modify: `apps/web/src/server/usecases/fixtures.ts`: `loadFixtureMatchRules(auth, fixtureId)` (finding 13: the console has no cfg/rules props today).
- Modify: `apps/web/src/components/v2/desk/run-sheet-row.tsx`: a "Format changed" tag when `rules_override` is non-null.
- Modify: the run-sheet loader that feeds it (`git grep -n -a "RunSheetRow" -- apps/web/src/server apps/web/src/app`) selects `rules_override is not null as format_changed`.
- Modify: `apps/web/src/dictionaries/{en,es,fr,nl}/ui.json`. Then `pnpm i18n:gen-keys`. Keys:
  - `matchRules.title`: "Match rules";
  - `matchRules.fromStage`: "From the stage: {format}";
  - `matchRules.overridden`: "Changed for this match";
  - `matchRules.source.stage`: "Stage"; `matchRules.source.match`: "This match";
  - `matchRules.reset`: "Use stage rules";
  - `matchRules.correctLive`: "Correct format";
  - `matchRules.correctWarning`: "The match so far is kept; the new format applies from here";
  - `matchRules.locked`: "This match is finished — its format is locked";
  - `runSheet.formatChanged`: "Format changed";
  - `ruleLock.FORMAT_DOES_NOT_FIT_PLAY`: "The match so far doesn't fit that format: {reason}".
- Create: `apps/web/e2e/match-rules-w2c.spec.ts`
- Modify: `apps/web/e2e/mobile.spec.ts` (one width test)
- Create: `apps/web/src/server/usecases/__tests__/fixture-match-rules-loader.test.ts`
- Create: `apps/web/src/components/v2/desk/run-sheet-tags.ts` (review I9): `export function formatChangedTag(row: { format_changed?: boolean | null }): "runSheet.formatChanged" | null`. `run-sheet-row.tsx` renders the chip when it is non-null.
- Create: `apps/web/src/components/v2/desk/__tests__/run-sheet-tags.test.ts`: `true` → the key; `false`, `null` and absent → `null` (counted, 4 cases; test name "the run sheet tags a changed format").
- Create: `MUT/t19.json`

**Interfaces:**
- Consumes:
  - Task 5's `matchFieldsFor(ctx: RuleContext)`;
  - Task 14's `PUT /api/v1/fixtures/{id}/rules` and its error codes;
  - Task 15's `GET /api/v1/fixtures/{id}/rules`;
  - Task 16's describer for the "From the stage" line.
- Produces:
  ```ts
  export interface FixtureMatchRules {
    readonly stageLine: string;                    // the stage-resolved format, as words
    readonly override: Record<string, unknown> | null;
    readonly effective: Record<string, unknown>;   // resolveFixtureCfg output
    readonly fields: readonly RuleField[];         // matchFieldsFor
    readonly state: "unstarted" | "live" | "locked";
  }
  export async function loadFixtureMatchRules(auth: AuthCtx, fixtureId: string): Promise<FixtureMatchRules>;
  ```
  Testids: `match-rules-block`, `match-rules-overridden`, `match-rules-reset`, `match-rules-locked`, `match-rules-error`, `run-sheet-format-changed`.

- [ ] **Step 1: Write the failing tests.** Loader unit test, `fixture-match-rules-loader.test.ts`:

```ts
import { afterAll, describe, expect, it } from "vitest";
import { fixtureKeysFor, stageKeysFor } from "@seazn/engine/sport";
import { sql } from "@/lib/db";
import { appendEvent, resolveLatestModule } from "@/server/engine-db";
import { matchFieldsFor } from "@/lib/match-rules";
import { loadFixtureMatchRules } from "../fixtures";
import { writeFixtureRulesOverride } from "../fixture-rules";
import { seedBracket } from "@/server/engine-db/__tests__/helpers/seed-bracket";

const HAS_DB = !!process.env.DATABASE_URL;
afterAll(async () => { await (globalThis as { _sql?: { end(): Promise<void> } })._sql?.end(); });

describe.skipIf(!HAS_DB)("loadFixtureMatchRules", () => {
  it("unstarted with no override: state unstarted, override null, effective = stage-resolved", async () => {
    const b = await seedBracket({ sport: "badminton", variant: "short", stageKind: "league", entrants: 2 });
    const r = await loadFixtureMatchRules(b.auth, b.fixtureIds[0]!);
    expect(r).toMatchObject({ state: "unstarted", override: null });
    expect(r.fields.length).toBe(matchFieldsFor({ module: resolveLatestModule("badminton"), stageKind: "league", variant: "short" }).length);
  });
  it("after an override: effective carries it; after start: live; after finalize: locked", async () => {
    const b = await seedBracket({ sport: "badminton", variant: "short", stageKind: "league", entrants: 2 });
    const id = b.fixtureIds[0]!;
    await writeFixtureRulesOverride(b.auth, [id], { bestOf: 1 });
    expect((await loadFixtureMatchRules(b.auth, id)).effective).toMatchObject({ bestOf: 1 });
    await appendEvent(b.auth.orgId, id, 0, { type: "core.start", payload: {} });
    expect((await loadFixtureMatchRules(b.auth, id)).state).toBe("live");
    await sql`update fixtures set status = 'finalized' where id = ${id}`;
    expect((await loadFixtureMatchRules(b.auth, id)).state).toBe("locked");
  });
  it("another sport (football): the fields are the match keys only — no stage-only decider", async () => {
    const b = await seedBracket({ sport: "football", variant: "11-a-side", stageKind: "knockout", entrants: 2 });
    const edited = (await loadFixtureMatchRules(b.auth, b.fixtureIds[0]!)).fields.flatMap((f) => f.edits);
    const m = resolveLatestModule("football");
    const matchKeys = new Set(fixtureKeysFor(m, "knockout", "11-a-side"));
    const stageOnly = stageKeysFor(m, "knockout", "11-a-side").filter((k) => !matchKeys.has(k));
    expect(stageOnly.length, "football declares stage-only keys").toBeGreaterThan(0);
    for (const k of stageOnly) expect(edited).not.toContain(k);
    expect(edited.length).toBeGreaterThan(0);
  });
});
```

E2E, `e2e/match-rules-w2c.spec.ts`:

```ts
test("X-SR-2 change one match's format before it starts; its effective rules read best of 1; the run sheet tags it", async ({ page, request }) => {
  const s = await seedBadmintonLeague(request); // local: division + 2 entrants + league stage generated; returns { divisionUrl, fixtureId, fixtureNo }
  await page.goto(`${s.divisionUrl}/f/${s.fixtureNo}`);
  const block = page.getByTestId("match-rules-block");
  await block.getByTestId("stage-rule-field-bestOf").getByRole("combobox").selectOption("1");
  await block.getByRole("button", { name: /save/i }).click();
  await expect(block.getByTestId("match-rules-overridden")).toBeVisible();
  await page.goto(`${s.divisionUrl}?tab=fixtures`);
  await expect(page.getByTestId(`run-sheet-row-${s.fixtureId}`).getByTestId("run-sheet-format-changed")).toBeVisible();
  const state = await apiJson<{ cfg: { bestOf: number } }>(request, `/api/v1/fixtures/${s.fixtureId}/rules`, "GET");
  expect(state.data!.cfg.bestOf).toBe(1);
});

test("X-SR-2 reset to the stage's format clears the override and the tag", async ({ page, request }) => {
  const s = await seedBadmintonLeague(request);
  await apiJson(request, `/api/v1/fixtures/${s.fixtureId}/rules`, "PUT", { rules: { bestOf: 1 } });
  await page.goto(`${s.divisionUrl}/f/${s.fixtureNo}`);
  await page.getByTestId("match-rules-reset").click();
  await expect(page.getByTestId("match-rules-overridden")).toHaveCount(0);
  await page.goto(`${s.divisionUrl}?tab=fixtures`);
  await expect(page.getByTestId(`run-sheet-row-${s.fixtureId}`).getByTestId("run-sheet-format-changed")).toHaveCount(0);
});

test("X-SR-5 correct a live match's format: a fitting change saves and writes no score event", async ({ page, request }) => {
  const s = await seedBadmintonLeague(request);
  await apiJson(request, `/api/v1/fixtures/${s.fixtureId}/events`, "POST", { expected_seq: 0, type: "core.start", payload: {} });
  await page.goto(`${s.divisionUrl}/f/${s.fixtureNo}`);
  const block = page.getByTestId("match-rules-block");
  await block.getByRole("button", { name: /correct format/i }).click();
  await block.getByTestId("stage-rule-field-bestOf").getByRole("combobox").selectOption("5");
  await block.getByRole("button", { name: /save/i }).click();
  await expect(block.getByTestId("match-rules-overridden")).toBeVisible();
  const n0 = await countEvents(request, s.fixtureId);
  expect(n0).toBe(1);                                                                 // a correction writes no score event
});

test("X-SR-5 a correction the play does not fit is refused with the engine's reason, and nothing changes (I8)", async ({ page, request }) => {
  const s = await seedFootballKnockoutWithExtraTime(request); // local: football 11-a-side, 2 entrants, knockout stage with rules {extraTime: on, 15'}, generated
  let seq = 0;
  for (const [type, payload] of [["core.start", {}], ["football.period", { phase: "HT" }], ["football.period", { phase: "FT" }], ["football.period", { phase: "ET_HT" }]] as const) {
    const r = await apiJson(request, `/api/v1/fixtures/${s.fixtureId}/events`, "POST", { expected_seq: seq++, type, payload });
    expect(r.status, type).toBe(201);
  }
  const before = await apiJson<{ cfg: { extraTime: { enabled: boolean } }; rules_version: number }>(request, `/api/v1/fixtures/${s.fixtureId}/rules`, "GET");
  expect(before.data!.cfg.extraTime.enabled).toBe(true);                               // precondition: the match is in extra time under ET-on
  await page.goto(`${s.divisionUrl}/f/${s.fixtureNo}`);
  const block = page.getByTestId("match-rules-block");
  await block.getByRole("button", { name: /correct format/i }).click();
  await block.getByTestId("stage-rule-field-extraTime").first().getByRole("checkbox").uncheck();
  await block.getByRole("button", { name: /save/i }).click();
  const error = block.getByTestId("match-rules-error");
  await expect(error).toBeVisible();
  await expect(error).toContainText(/doesn't fit that format/i);                      // ruleLock.FORMAT_DOES_NOT_FIT_PLAY
  expect(((await error.textContent()) ?? "").length).toBeGreaterThan("The match so far doesn't fit that format: ".length); // the reason is filled
  const after = await apiJson<{ cfg: unknown; rules_version: number }>(request, `/api/v1/fixtures/${s.fixtureId}/rules`, "GET");
  expect(after.data).toEqual(before.data);                                            // cfg and version unchanged
  await expect(block.getByTestId("match-rules-overridden")).toHaveCount(0);
  expect(await countEvents(request, s.fixtureId)).toBe(4);
});

test("X-SR-3 a finished match shows the lock and no form", async ({ page, request }) => {
  const s = await seedBadmintonLeague(request);
  await finishFixtureViaApi(request, s.fixtureId); // helpers.ts — re-read its name with git grep -n -a "export async function finish" -- apps/web/e2e/helpers.ts
  await page.goto(`${s.divisionUrl}/f/${s.fixtureNo}`);
  await expect(page.getByTestId("match-rules-locked")).toBeVisible();
  await expect(page.getByTestId("match-rules-block").getByRole("button", { name: /save/i })).toHaveCount(0);
});
```
- The "does not fit" case mirrors Task 14's unit case through the product (review I8).
- `countEvents`, `seedBadmintonLeague` and `seedFootballKnockoutWithExtraTime` are local helpers written in the spec. The football one PUTs the stage rules through Task 11's `PUT /api/v1/stages/{id}/rules` before `/generate`.
- The fixture page URL shape (`/f/{no}`) is re-read from the route folder.

Width test in `mobile.spec.ts`: "W2c match rules block at every width". It opens the block on a phone, asserts `toBeAttached` on the block's fields after opening any phone disclosure the console wraps it in (AGENTS.md class 22: open EVERY instance, gate on the toggle being visible), and `expectNoHorizontalScroll`.

- [ ] **Step 2: Run to verify red** (the loader unit test, then the spec and `mobile.spec.ts` as whole files).

- [ ] **Step 3: Implement.** Run `frontend-design` first.
  - Placement follows the phone composition design of record. The block lives in the console's existing chrome-down region on phones, inside one `phone-disclosure` (one DOM, `max-md:*`), and as a side card at `md` and up.
  - Read `docs/superpowers/specs/2026-09-02-scorepad-v3-phone-composition-design.md` before placing it.
  - The block renders:
    - the stage line;
    - `MatchRuleFields` for `fields` hydrated from `effective`;
    - Save → PUT; Reset → PUT `{rules: null}`;
    - the `correctLive` reveal when `state === "live"`;
    - the lock line when `locked`;
    - errors through `ruleLock.<code>` with the reason.
  - The run-sheet tag is a chip in the row's meta strip (`run-sheet-row.tsx`).

- [ ] **Step 4: Run.** Unit, the spec, `mobile.spec.ts`, the fixture-console unit suites, `tsc`, eslint, `pnpm i18n:check`, then the walkthrough `e2e/walkthrough/scorepad-v3-r7-console-chrome.spec.ts` (whole file; the console chrome changed). Per-screen verdicts at 1280/768/320 for:
  - unstarted (closed and open);
  - overridden;
  - live correction (open);
  - the refusal;
  - locked;
  - the run sheet with the tag.

  Also run a control-set diff at 320 against 1280 (membership and order) per the phone-composition rule.

- [ ] **Step 5: Mutate once** — `MUT/t19.json`:

```json
[
  { "id": "t19-tag", "file": "apps/web/src/components/v2/desk/run-sheet-tags.ts",
    "find": "row.format_changed === true ? \"runSheet.formatChanged\" : null", "replace": "null",
    "killers": [{ "cwd": "apps/web", "files": ["src/components/v2/desk/__tests__/run-sheet-tags.test.ts"], "name": "the run sheet tags a changed format" }] },
  { "id": "t19-state", "file": "apps/web/src/server/usecases/fixtures.ts",
    "find": "LOCKED_FIXTURE_STATUSES.includes(row.status) ? \"locked\"", "replace": "false ? \"locked\"",
    "killers": [{ "cwd": "apps/web", "files": ["src/server/usecases/__tests__/fixture-match-rules-loader.test.ts"], "name": "after finalize: locked" }] }
]
```

- [ ] **Step 6: Commit** `feat(w2c): the match format block on the fixture console and the run-sheet tag (S2, S4)`.

**Test types:**
- Unit: the loader.
- E2E: above, plus the width test.
- Smoke: Task 14's two checks cover the server path; N/A here for a new check.
- Regression: the R7 console walkthrough; the run-sheet e2e (`git grep -l -a "run-sheet-row" -- apps/web/e2e`) as whole files.

**Sequence cases:** unstarted with no override first; override; reset; live correction fits and does not fit; locked; another sport (football fields).

---
### Task 20: S4 — division settings name what is locked (UI)

> **Mockups (design of record, owner picked A):** `docs/superpowers/specs/2026-10-13-format-matrix-w2c-mockups/` — open the screen's HTML beside the build before sign-off (README there maps screen → file).

> **Carried from the batch-2 review.** (M-4) This task's text predates Task 5: `divisionRefusals` now takes `{module, variantKey, divisionConfig}` and `TABLE_RULE_KEYS` is `tableRuleKeys(module, variant)` — use the real signatures. (Owner-visible) A v1/settings save that mixes a refused key with anything that lands now answers **200 with `refused[]`** (Task 5); `division-settings.tsx:469-477` shows "rules saved" on any 200 and never reads `refused`, so the locked value silently snaps back on refresh. The form must name each refused field (RefusedField copy) on a 200 as well as a 409; e2e covers the mixed case. The Task 20 smoke check must include the mixed 200 case (Task 5 changed the HTTP contract).

> **Carried from batch-1 fixes.** `e2e/division-settings.spec.ts:95-99` re-sends the current variant `score` — now a 200 no-op. The rewrite must start a stage and send a DIFFERENT variant.

> **Carried from Task 2 review.** Add to Files and fix: `e2e/division-settings.spec.ts:92-99` (the PATCH 409 FORMAT_LOCKED after generate now returns 200 — rewrite to the per-started-stage behaviour, and the :92-93 testid/text assertions); `components/v2/format-lock.ts:3,6` + the division `page.tsx:948` (the UI still over-locks on any fixture); `content/help/divisions/settings.md:10` and its "Why can't I change the format?" paragraph (English only), plus help `lifecycle.md:15`, `add-a-division.md:21`, `start-scoring.md:7`; stale comments `division-settings.tsx:5`, `usecases/stages.ts:486`, `usecases/templates.ts:362`. i18n keys use the D10 prefix `ruleLock.<CODE>` (orchestrator ruling; the task text's `divisionLock.` is superseded). `RefusedField` is imported from `lib/rule-errors.ts`.

Spec item 4 (UI half); §5 S4 (division); X-SR-4 (UI). Owner P-2 "A": the lock is per started inheriting stage, and a save keeps every unlocked field.

**Files:**
- Modify: `apps/web/src/components/v2/division-settings.tsx`: after a save, render `refused[]` (Task 2's response field) as one line per refused field, naming the stage. Locked fields render read-only with the lock line before the organiser types (pre-computed from the same server read, so the response is a fallback, never the only signal).
- Modify: the division settings loader (`git grep -n -a "DivisionSettings" -- apps/web/src/app`): pass `lockedFields: RefusedField[]`, computed by `divisionRefusals(tx, divisionId, {configKeys: <every key>, variant: true, tiebreakers: true})`.
- Modify: `apps/web/src/dictionaries/{en,es,fr,nl}/ui.json`. Then `pnpm i18n:gen-keys`. Keys:
  - `divisionLock.DIVISION_FORMAT_LOCKED`: "Locked: {stage} has started and plays this format";
  - `divisionLock.DIVISION_TABLE_RULES_LOCKED`: "Locked: {stage} has started and its table uses these rules";
  - `divisionLock.partialSave`: "Saved. {n} setting(s) were kept because a stage has started".
- Create: `apps/web/e2e/division-locks-w2c.spec.ts`
- Modify: `apps/web/e2e/division-settings.spec.ts`: the F2b assertions that expect a whole-form `FORMAT_LOCKED` after generation move to the per-field shape (greenfield; Task 2 changed the server).
- Modify: `apps/web/e2e/mobile.spec.ts` (one width test)
- Create: `apps/web/src/components/v2/division-settings-locks.ts` (review I9): `export function lockLineFor(fieldKey: string, lockedFields: readonly RefusedField[]): RefusedField | undefined`. It matches a field by its key, or by any engine key its `edits` name. `division-settings.tsx` renders the lock line from it.
- Create: `apps/web/src/components/v2/__tests__/division-settings-locks.test.ts`, three cases:
  - "locks the division format with its name": a `variant_key` refusal naming "Pool A" is returned for the format field;
  - the empty case: `[]` → `undefined`;
  - another field's refusal → `undefined`.
- Create: `MUT/t20.json`

**Interfaces:**
- Consumes: Task 2's `RefusedField`, `divisionRefusals`, and the `patchDivision` response `refused`; Task 5's derived `TABLE_RULE_KEYS`.
- Produces: testids `division-locked-<field>`, `division-partial-save`.

- [ ] **Step 0: Run `frontend-design`.** The lock line sits under its field (not in a banner), and the read-only field keeps its value visible. On phones each field is a full-width row.

- [ ] **Step 1: Write the failing e2e** — `e2e/division-locks-w2c.spec.ts`:

```ts
import { expect, test } from "@playwright/test";
import { apiJson, addEntrantsViaApi, createStageAndGenerate, TAG } from "./helpers";

test("X-SR-4 a started pool locks the division format with its name; other settings still save", async ({ page, request }) => {
  const d = await seedDivision(request, "badminton", "short");          // copied from division-settings.spec.ts
  await addEntrantsViaApi(request, d.divisionId, 2);
  const { stageId, fixtureIds } = await createStageAndGenerate(request, d.divisionId, "league");
  await apiJson(request, `/api/v1/stages/${stageId}`, "PATCH", { name: `Pool ${TAG}` });
  await apiJson(request, `/api/v1/fixtures/${fixtureIds[0]}/events`, "POST", { expected_seq: 0, type: "core.start", payload: {} });
  await page.goto(`${d.divisionUrl}?tab=settings`);
  await expect(page.getByTestId("division-locked-bestOf")).toContainText(`Pool ${TAG}`);
  await expect(page.getByTestId("division-locked-tiebreakers")).toContainText(`Pool ${TAG}`);
  await page.getByLabel(/division name/i).fill(`Renamed ${TAG}`);
  await page.getByRole("button", { name: /save/i }).click();
  const after = await apiJson<{ name: string; config: { bestOf: number } }>(request, `/api/v1/divisions/${d.divisionId}`, "GET");
  expect(after.data!.name).toBe(`Renamed ${TAG}`);
});

test("X-SR-4 generated but NOT started: the division format still saves (P-2 A)", async ({ page, request }) => {
  const d = await seedDivision(request, "badminton", "short");
  await addEntrantsViaApi(request, d.divisionId, 2);
  await createStageAndGenerate(request, d.divisionId, "league");
  await page.goto(`${d.divisionUrl}?tab=settings`);
  await expect(page.locator('[data-testid^="division-locked-"]')).toHaveCount(0);
  // Change a format field through the form; the value is read back over the API.
  await page.getByTestId("stage-rule-field-bestOf").first().getByRole("combobox").selectOption("1");
  await page.getByRole("button", { name: /save/i }).click();
  await expect.poll(async () => (await apiJson<{ config: { bestOf: number } }>(request, `/api/v1/divisions/${d.divisionId}`, "GET")).data!.config.bestOf).toBe(1);
});

test("X-SR-4 a stage that sets its own rules does not lock the division format", async ({ page, request }) => {
  const d = await seedDivision(request, "badminton", "short");
  await addEntrantsViaApi(request, d.divisionId, 2);
  const { stageId, fixtureIds } = await createStageAndGenerate(request, d.divisionId, "league");
  await apiJson(request, `/api/v1/stages/${stageId}/rules`, "PUT", { rules: { bestOf: 3 } });
  await apiJson(request, `/api/v1/fixtures/${fixtureIds[0]}/events`, "POST", { expected_seq: 0, type: "core.start", payload: {} });
  await page.goto(`${d.divisionUrl}?tab=settings`);
  await expect(page.getByTestId("division-locked-bestOf")).toHaveCount(0);           // inherits nothing it locks …
  await expect(page.getByTestId("division-locked-tiebreakers")).toBeVisible();      // … but the table still does
});
```
The settings tab URL and its field labels are re-read from `division-settings.spec.ts` before running. The variant/format field's testid is whatever `division-settings.tsx` renders through `MatchRuleFields`, i.e. Task 17's scheme.

`mobile.spec.ts`: "W2c division lock lines at every width". It sets up the started-pool state, opens settings, and asserts `division-locked-bestOf` is visible plus `expectNoHorizontalScroll`.

- [ ] **Step 2: Run to verify red.** Whole files: the new spec, `division-settings.spec.ts`, `mobile.spec.ts`.

- [ ] **Step 3: Implement** (read-only fields with lock lines; the partial-save line from `refused.length`).

- [ ] **Step 4: Run** the three spec files, the division-settings unit suites (`git grep -l -a "division-settings" -- apps/web/src '*.test.ts*'`), `tsc`, eslint and `pnpm i18n:check`. Per-screen verdicts at 1280/768/320 for:
  - unlocked;
  - started pool (locked lines);
  - after a partial save.

- [ ] **Step 5: Mutate once** — `MUT/t20.json`:

```json
[
  { "id": "t20-lockline", "file": "apps/web/src/components/v2/division-settings-locks.ts",
    "find": "lockedFields.find((r) => r.field === fieldKey", "replace": "undefined && lockedFields.find((r) => r.field === fieldKey",
    "killers": [{ "cwd": "apps/web", "files": ["src/components/v2/__tests__/division-settings-locks.test.ts"], "name": "locks the division format with its name" }] }
]
```

- [ ] **Step 6: Commit** `feat(w2c): division settings name the stage that locks a field (S4, X-SR-4)`.

**Test types:**
- Unit: N/A. The lock computation is Task 2's server function, unit-tested there; this task renders its output.
- E2E: above, plus the width test.
- Smoke: Task 2 owes none; this task adds `w2c: a division save after a started pool returns refused[]` to `w2cStageRulesSuite` (PATCH, then assert `refused[0].stageName`).
- Regression: `division-settings.spec.ts` (rewritten F2b), whole file.

**Sequence cases:** unstarted first; generated and unstarted; started; a stage with its own rules; a partial save; reload.

---

### Task 21: S5 — the Armageddon pad sheet asks who has Black (same loop as Task 20)

> **Mockups (design of record, owner picked A):** `docs/superpowers/specs/2026-10-13-format-matrix-w2c-mockups/` — open the screen's HTML beside the build before sign-off (README there maps screen → file).

Spec item 13 (UI half); §5.3 S5; BG-KO-2 (enforced), BG-KO-3 (pad); finding 24.

**Files:**
- Modify: `apps/web/src/components/v2/scorepad/v3/skins/boardgame.tsx`: `tiebreakSheet` (`:550`).
  - Rung options come from `effectiveRungs(view.cfg)` (Task 8: the stage's list in the stage's order, or every rung when absent) instead of the constant `TIEBREAK_RUNGS`.
  - The Armageddon branch replaces "who won" with two steps: "Who had Black?" (the two entrants) and "Result?" (White won / Black won / Drawn), then a confirm line "Advances: X — Black, Armageddon drawn" (spec §5.3 S5).
  - The emitted payload is Task 8's `{rung: "armageddon", black, result}`.
  - The W2a hint ("a draw means Black advances") stays.
- Modify: `apps/web/src/components/v2/scorepad/v3/skins/__tests__/boardgame*.test.ts` (`git grep -l -a tiebreakSheet -- apps/web/src`): the sheet-spec unit tests.
- Modify: `apps/web/src/dictionaries/{en,es,fr,nl}/ui.json`. Then `pnpm i18n:gen-keys`. Keys:
  - `pad.boardgame.tiebreak.black.title`: "Who had Black?";
  - `pad.boardgame.tiebreak.result.title`: "Result?";
  - `pad.boardgame.tiebreak.result.white`: "White won";
  - `pad.boardgame.tiebreak.result.black`: "Black won";
  - `pad.boardgame.tiebreak.result.draw`: "Drawn";
  - `pad.boardgame.tiebreak.confirm.drawn`: "Advances: {name} — Black, Armageddon drawn";
  - `pad.boardgame.tiebreak.confirm.won`: "Advances: {name} — {colour} won".
- Modify: `apps/web/e2e/bracket-finish.spec.ts`:
  - the existing "BG-KO-1 + BG-KO-2 (ruling 82)…" test's Armageddon tail is rewritten to the new steps (greenfield: the old shape is gone);
  - one new test.
- Modify: `apps/web/e2e/mobile.spec.ts` (the sheet at every width)
- Create: `MUT/t21.json`

**Interfaces:**
- Consumes: Task 8's `BoardgameTiebreak` payload, `armageddonBlack`, `TIEBREAK_COLOUR_REQUIRED`, and the `tiebreakRungs` cfg; Task 17's stage editor (which sets the rungs the sheet offers).
- Produces: sheet option ids `black-home`/`black-away` and `result-white`/`result-black`/`result-draw` (as `data-choice-option-id`).

- [ ] **Step 1: Write the failing tests.** Sheet unit test (the existing sheet-spec suite's style: build `tiebreakSheet(view, t)` from a fixture view and walk its steps):

```ts
it("BG-KO-2 the Armageddon branch asks Black then the result, and builds Task 8's payload", () => {
  // ["armageddon", "rapid"] is NOT TIEBREAK_RUNGS order, so a sheet that re-sorts to the canonical list fails here (re-review minor).
  expect(TIEBREAK_RUNGS.indexOf("rapid")).toBeLessThan(TIEBREAK_RUNGS.indexOf("armageddon"));
  const spec = tiebreakSheet(viewWith({ tiebreakRungs: ["armageddon", "rapid"] }), t);
  expect(spec.steps.find((s) => s.id === "rung")!.options!.map((o) => o.id)).toEqual(["armageddon", "rapid"]); // from cfg, in cfg order
  const visible = (a: Record<string, unknown>) => spec.steps.filter((s) => !s.when || s.when(a)).map((s) => s.id);
  expect(visible({ rung: "armageddon" })).toEqual(["rung", "black", "result", "confirm"]);
  expect(visible({ rung: "rapid" })).toEqual(["rung", "winner", "score"]);
  expect(spec.build!({ rung: "armageddon", black: "away", result: "draw" }, view)).toEqual({ rung: "armageddon", black: view.entrantIds.away, result: "draw" });
});
it("BG-KO-3 an empty rung list offers no tie-break tile (the organiser settles)", () => {
  expect(tiebreakTileOffered(viewWith({ tiebreakRungs: [] }))).toBe(false);
});
```
`viewWith`, `t` and `tiebreakTileOffered` are the existing suite's helpers. If the tile predicate has another name, re-read it from `boardgame.tsx` and use that name. The step and option ids above are this task's, and Step 3 implements them.

E2E (new test in `bracket-finish.spec.ts`, reusing the file's `drawnChessKnockout`, `tile`, `option`, `pad`, `read`, `seatedInFinal`):

```ts
test("BG-KO-2 the Armageddon sheet records Black and advances Black on a draw", async ({ page, request }) => {
  const ko = await drawnChessKnockout(request);
  const { sf } = ko;
  await page.goto(await fixturePath(request, sf.id));
  await tile(page, "tiebreak").click();
  await option(page, "armageddon").click();
  await option(page, "black-away").click();
  await option(page, "result-draw").click();
  await expect(pad(page).getByText(ui("pad.boardgame.tiebreak.confirm.drawn", { name: ko.nameOf.get(sf.away_entrant_id!)! }))).toBeVisible();
  await pad(page).getByRole("button", { name: /confirm/i }).click();
  await expect.poll(async () => (await read(request, sf.id)).outcome).toMatchObject({ kind: "win", winner: sf.away_entrant_id, method: "tiebreak_armageddon" });
  await expect.poll(() => seatedInFinal(sf.id)).toContain(sf.away_entrant_id);
});
test("BG-KO-2 positive pair: White wins advances the OTHER entrant", async ({ page, request }) => {
  const ko = await drawnChessKnockout(request);
  const { sf } = ko;
  await page.goto(await fixturePath(request, sf.id));
  await tile(page, "tiebreak").click();
  await option(page, "armageddon").click();
  await option(page, "black-away").click();
  await option(page, "result-white").click();
  await pad(page).getByRole("button", { name: /confirm/i }).click();
  await expect.poll(async () => (await read(request, sf.id)).outcome).toMatchObject({ winner: sf.home_entrant_id });
});
```
The existing test's `toHaveCount(3)` on rung options becomes a count derived from the stage's `tiebreakRungs` as read back over the API (`GET /api/v1/stages/{id}`), never a typed 3.

- [ ] **Step 2: Run to verify red** (the unit suite, then `bracket-finish.spec.ts` and `mobile.spec.ts` as whole files).

- [ ] **Step 3: Implement** the steps. Run `frontend-design` first: two-choice steps use the sheet's existing choice rows, and the Draw option carries its consequence in the label, so the scorer never needs the hint to know who advances.

- [ ] **Step 4: Run** the unit suite, the two spec files, `e2e/walkthrough/scorepad-v3-boardgame-result.spec.ts` (whole file), `tsc`, eslint and `pnpm i18n:check`. Per-screen verdicts at 1280/768/320 for the three sheet steps.

- [ ] **Step 5: Mutate once** — `MUT/t21.json`:

```json
[
  { "id": "t21-black", "file": "apps/web/src/components/v2/scorepad/v3/skins/boardgame.tsx",
    "find": "black: view.entrantIds[answers.black", "replace": "black: view.entrantIds[\"home\"",
    "killers": [{ "cwd": "apps/web", "files": ["src/components/v2/scorepad/v3/skins/__tests__/boardgame-sheets.test.ts"], "name": "BG-KO-2 the Armageddon branch asks Black" }] },
  { "id": "t21-rungs", "file": "apps/web/src/components/v2/scorepad/v3/skins/boardgame.tsx",
    "find": "effectiveRungs(view.cfg).map(", "replace": "TIEBREAK_RUNGS.map(",
    "killers": [{ "cwd": "apps/web", "files": ["src/components/v2/scorepad/v3/skins/__tests__/boardgame-sheets.test.ts"], "name": "the Armageddon branch asks Black" }] }
]
```
The unit file path is the one `git grep -l -a tiebreakSheet` returns; update the killer path to it.

- [ ] **Step 6: Commit** `feat(w2c): the Armageddon sheet records who has Black (S5, BG-KO-2)`.

**Test types:**
- Unit: the sheet spec.
- E2E: above, plus the width test.
- Smoke: N/A. The tie-break event travels the existing events route; Task 8's engine golden covers the fold, and no new server path exists.
- Regression: the rewritten W2a BG-KO test; the boardgame result walkthrough.

**Sequence cases:** rapid first (unchanged path); Armageddon with a draw; Armageddon with White winning; Back from the result step; an empty rung list; another rung order.

---

### Task 22: MD-1 — classify every surviving mutant in the engine files W2c edits

Spec §10 MD-1. See "MD-1 mutation ownership" below.

**Files:**
- Modify: `packages/engine/stryker-equivalent.json` (the classification ledger; re-read its schema at the top of the file)
- Modify: engine test files only where a survivor is killable (named per survivor)
- No product code.

- [ ] **Step 1: Measure first.** Run the engine mutation command scoped to the edited files (the `mutate` list below), from `packages/engine`:
  ```bash
  cd /Users/ashokhein/github/seazn.club-worktrees/format-matrix-w2c/packages/engine && pnpm exec stryker run --mutate "src/sport/module.ts,src/sport/rule-keys.ts,src/competition/points.ts,src/sports/boardgame/**/*.ts,src/sports/period/kernel.ts,src/sports/period/shootout.ts,src/sports/setbased/kernel.ts,src/sports/football/football.ts,src/sports/hockey/hockey.ts,src/sports/icehockey/icehockey.ts,src/sports/cricket/cricket.ts,src/sports/carrom/carrom.ts,src/sports/generic/generic.ts,src/sports/tennis/tennis.ts" > "$TMPDIR/w2c-stryker.log" 2>&1; echo EXIT=$?
  ```
  - Record survivors AND `NoCoverage` mutants per file in `w2c-state.md` (review M6: a mutant no test reaches is a gap too, not a pass; Stryker reports it separately from Survived).
  - **If the total exceeds 150**, stop and report to the orchestrator. It splits the classification across implementers by file (disjoint), or asks the owner whether the pre-existing survivors in a file W2c only touched with a `ruleKeys` property belong to the P0 mutation-debt programme instead (finding 25).
  - Survivors in lines W2c did not change are still classified (MD-1 says "every file it edits"); the split is by file, not by line.
- [ ] **Step 2: Classify.** For each survivor and each `NoCoverage` mutant, exactly one of:
  - **killed**: a new test in the file's own suite, named for the rule it pins, with the expected value derived from a rule row or a declaration;
  - **equivalent**: an entry in `stryker-equivalent.json` with a one-sentence proof;
  - **debt**: listed in the PR body with the P0 programme's id, and only for lines W2c did not touch.

  Anti-vacuity: the classification count equals Step 1's survivors plus `NoCoverage`. Zero measured is an error unless the log shows the run completed with a mutant total > 0.
- [ ] **Step 3: Re-run** the same command. The survivors and `NoCoverage` mutants not classified "equivalent" or "debt" must be 0. Paste the summary line.
- [ ] **Step 4: Commit** `test(w2c): classify every surviving mutant in the engine files W2c edits (MD-1)`.

**Test types:**
- Unit: the killers added in Step 2.
- E2E: N/A (engine-only classification).
- Smoke: N/A (no product change).
- Regression: the Step 3 re-run.

**Sequence cases:** N/A (a ledger task).

---

### Task 23: Ship gates, PR, e2e dispatch, and the cross-programme P8 (orchestrator)

> **Carried from Task 10 review.** Merge-order dependency: W2c's migration is V443 because the chess branch (`feat/chess-lichess-external-play`) holds V439–V442 and deploys them to staging first; Flyway runs no out-of-order migrations, so chess must merge (and reach prod) before W2c, or W2c is renumbered above chess's final number. Confirm with the chess session before opening the PR.

> **Carried (mutation session, 2026-10-13).** A post-W2b Stryker re-measure PR (stryker-measured.json, stryker-timeouts.json, possibly stryker.groups.mjs cut anchors) is expected to merge BEFORE W2c. Before the PR: rebase onto it, run the engine `stryker-sizing` and `stryker-cuts` tests, and re-measure (CI dispatch per leg) any leg W2c pushes past 10% drift — W2c adds mutants in core/errors.ts (core-2 leg), points.ts, sport/*, period kernel, boardgame and every module's `ruleKeys`. Edit groups/measured files only on top of that PR.

Spec §9 P8; §11; Global Constraints. The P8 step is **BLOCKED until `feat/chess-lichess-external-play` merges**.

- [ ] **Step 1: Rule rows.**
  - The batch-end proof commits have already moved each row out of `AWAITING_PROOF`. Here the orchestrator confirms the map is EMPTY, and that every Appendix A row's `proved-by` names an existing test whose title carries the id.
  - Run `rules-reference.test.ts` (judge it).
  - Append the decision lines to `IDX`: D1–D14, the owner's P-1..P-5, the execution ruling ("A Sonnet with those 4 tasks on Opus"), and the findings needing a ruling.
- [ ] **Step 2: Scoped gate on the whole branch diff.**
  - vitest, **per-task scoped files only** (review I13; never `vitest related` over the branch diff, which fans out to most of the suite and breaks the standing "SCOPED tests only" rule):
    - The list is the union of the test files each of Tasks 1–22 names in its **Files** and **Step 4**. These are the same commands the batch-end gates already ran.
    - Write the list into `$TMPDIR/w2c-scoped-engine.txt` and `$TMPDIR/w2c-scoped-web.txt` by hand from the plan, one path per line, relative to `packages/engine` and `apps/web`.
    - The per-sport contract tests are included through the exact `vitest related --run src/lib/match-rules/<sport>.ts` commands Tasks 5–8 use. Those are scoped to one source file each, not to the branch.
    - Run each list as explicit paths: `cd …/packages/engine && npx vitest run $(cat "$TMPDIR/w2c-scoped-engine.txt") --reporter=json --outputFile="$TMPDIR/w2c-t23-engine.json"; echo EXIT=$?`, and the same from `apps/web`.
    - Judge each JSON: `numFailedTests == 0`, `numPendingTests == 0` for the DB files, and `.testResults | length` equal to the list's line count, with every `.testResults[].name` under the right worktree.
    - A path in the list that matches no file is an error, not a skip (zsh: an empty list runs the FULL suite; check `wc -l` > 0 first).
  - `tsc` for both packages; eslint via `rtk proxy` reading `✖ N problems`.
  - `pnpm i18n:check`; the OpenAPI drift check (`pnpm openapi:gen && git diff --exit-code openapi/`).
  - The smoke suite on a local prod server (Global Constraints).
  - Every new or changed e2e spec as WHOLE files on a prod build; `mobile.spec.ts` on the seven width projects.
  - Re-run any red-shaped gate three times before believing it.
- [ ] **Step 3: Final review.** Dispatch `reviewer` on `main...HEAD` with the three standing lenses (memory) and the five Review Focus lines. Findings go to a file in the scratchpad, never only to chat. Fix inline unless the blast radius says otherwise (RULES.md).
- [ ] **Step 4: Rebase onto `main`** carefully (memory: REBASE pre-merge). Then re-run Step 2's scoped vitest only for files the rebase touched.
- [ ] **Step 5: PR.** The body lists:
  - the Appendix A rows with their proving tests;
  - the MD-1 counts;
  - per-screen verdicts (text, no images committed);
  - OQ answers;
  - the plan findings that remain open.

  It ends with the attribution line.
- [ ] **Step 6: e2e dispatch.** `gh workflow run e2e.yml -f pr=<n>` (re-read `e2e.yml`'s inputs first). Confirm the run's head commit is the PR head, not `main` (memory: a dispatch's headSha is the dispatch ref; the run uses MAIN's workflow file). Read every job, including the serial ones, as a floor and not a total.
- [ ] **Step 7 (BLOCKED until `feat/chess-lichess-external-play` merges): P8 cross-programme.**
  - On the merged tree, run that branch's external-play suites against W2c's Armageddon colours. `external-play/guard.ts:450-456` reads `colorOfHome` (finding 18).
  - Assert that an Armageddon game played externally records the same `black` that the pad sheet would.
  - If the reader conflicts, it is a finding for both programmes' owners. **Do not edit the other branch.**

- [ ] **Step 8: Close the W2c agent exception.** After the PR merges, delete `.claude/agents/implementer-sonnet.md` and `.claude/agents/reviewer-sonnet.md`, and mark the W2c exception in `docs/superpowers/RULES.md` § Agent topology as closed (RULES.md: "delete the `*-sonnet` agents when W2c closes"). This goes in its own PR, or in the IDX close-out commit, whichever the orchestrator's owner prefers.

**Test types:** this task runs the gates; it adds none except any review fixes, which carry their own.

---

## MD-1 mutation ownership

- **W2c classifies survivors** (Task 22) in every engine file it edits:
  - `sport/module.ts`, `sport/rule-keys.ts`;
  - `competition/points.ts`;
  - `sports/boardgame/**`;
  - `sports/period/kernel.ts`, `sports/period/shootout.ts`;
  - `sports/setbased/kernel.ts` (its `ruleKeys` only);
  - `sports/football/football.ts`, `hockey/hockey.ts`, `icehockey/icehockey.ts`, `cricket/cricket.ts`, `carrom/carrom.ts`, `generic/generic.ts`;
  - `sports/tennis/tennis.ts` (its `ruleKeys` only).
- **Not W2c's.** `competition/stage.ts` and `competition/progression.ts` are not edited by W2c. They go on the mutation session's no-wave list (finding 22), and no W2c task may touch them to "help".
- **Volume.** Task 22 measures before it classifies and escalates above 150 survivors (finding 25).
- **Per-task mutation** (`MUT/t<N>.json`, one entry or a few per task) is separate from MD-1. It proves each new guard is killed by its own test. MD-1 is the whole-file ledger.

---

## Appendix A — rule rows W2c adds or changes (signed in Task 0, written in Task 3)

Wording is from spec Appendix A, with ids corrected (finding 6). **Owner signed all rows 2026-10-13 ("sign all"), GN-AB-2 with the P-5 sentence.** A row stays in `AWAITING_PROOF` until the batch-end proof commit of the batch that proves it fills its `proved-by` (**Execution**). Task 23 checks that the map is empty.

| Id | File | Rule (proposed wording) | Enforced at | Proved by |
|---|---|---|---|---|
| X-SR-1 | `cross-sport.md` | Every sport's stage can set the format keys its engine declares settable for that stage's kind and variant; nothing else. | `stage-rules.ts` (Task 11) via `stageTopKeysFor` | Tasks 4, 5, 11, 17 |
| X-SR-2 | `cross-sport.md` | One match may differ from its stage only on keys the engine declares match-scoped; a decider may only be switched off or shortened for one match. | `fixture-rules.ts` via `checkFixtureOverride` (Task 14) | Tasks 4, 14, 19 |
| X-SR-3 | `cross-sport.md` | A stage's format locks when any of its matches starts and stays locked after a void. | `stage-rules.ts` | Tasks 11, 13, 17 |
| X-SR-4 | `cross-sport.md` | A division setting locks only when a started stage inherits it; the refusal names the stage, and other settings still save. | `rule-locks.ts` (Task 2) | Tasks 2, 20 |
| X-SR-5 | `cross-sport.md` | A started, unfinished match's format may be corrected only if the recorded play fits it, and never so that the correction alone ends the match (owner P-4). A finished match's format is locked. | `fixture-rules.ts` (Task 14) | Tasks 14, 19 |
| X-SR-6 | `cross-sport.md` | A new bracket stage starts with its sport's deciders; with every decider off, a level match is held for the organiser, never refused. | `stage-defaults.ts` (Task 12); engine `stageDefaults` (Task 6) | Tasks 6, 12, 17 |
| **X-SR-7** | `cross-sport.md` | A tap a scoring pad sent under a match's old rules is never applied under its new ones: after a correction or a staff re-freeze, a pad append carrying a stale rules version is refused `FIXTURE_RULES_CHANGED` and writes nothing. An append that carries no version (the fixture console, the server's own writers) is not checked (owner P-1). | `append-event.ts` (Task 15) | Task 15 |
| X-PT-1 | `cross-sport.md` | A stage's points rule applies to that stage's table. A forfeit is an award with nothing played (a walkover, or a withdrawal or disqualification before play): it pays the rule's walkover row, and its awarded score replaces the credit. A bye never receives the awarded score. An award after play earns normal points. Bonus and walkover rows need the custom-points entitlement. (Spec `1b757c6cb`; owner P-3.) | `competition/points.ts` (Task 9), `stage-rules.ts` (Task 13) | Tasks 9, 13, 16, 18 |
| BG-KO-3 | `boardgame.md` | A chess knockout stage's tie-break sequence is the organiser's ordered list; an empty list sends a drawn game to the organiser. | `boardgame` module (Task 8) | Tasks 8, 17, 21 |
| BG-KO-2 | `boardgame.md` (status → `enforced`) | Armageddon records who had Black; a drawn Armageddon advances Black. | `boardgame` module (Task 8); pad sheet (Task 21) | Tasks 8, 21 |
| BG-KO-1 (amended) | `boardgame.md` | A drawn chess knockout game goes to the stage's tie-break rungs in order; with an empty rung list it is held for the organiser (ruling 79), never decided by a default. | boardgame module (Task 8) | Task 8 |
| **CK-SO-1** | `cricket.md` | A cricket knockout's super over is a stage default the organiser can switch off. Switched on in a league stage, it is played on every tie. | cricket `stageDefaults` (Task 6) | Task 6 |
| HK-AB-2 | `hockey.md` | Under `q4_stands` (hockey only; ice hockey is never offered it), an abandoned match is replayed if the 4th quarter had not started. From the 4th quarter on, including a shoot-out, the result stands; a level score in a format with no draws is no result (ruling 117). The option exists only for four-quarter formats. | period kernel (Task 7) | Task 7 |
| **CA-AB-2** | `carrom.md` | An abandoned carrom league match is replayed or the points are shared, as the stage says. | carrom module (Task 7) | Task 7 |
| **GN-AB-2** | `generic.md` | An abandoned generic league match is replayed or the points are shared, as the stage says. Sharing the points needs draws to be allowed (owner P-5). (GN-AB-1 exists on W2b.) | generic module (Task 7) | Task 7 |
| IH-KO-1 | `icehockey.md` | An ice-hockey knockout stage starts with overtime and a shootout. | icehockey `stageDefaults` (Task 6) | Task 6 |
| FB-SO-1 | `football.md` | A football shootout is 5 kicks each before sudden death; youth variants 3. The count is the match-scoped `shootoutAttempts`. | football `shootoutAttempts` (Task 6) | Task 6 |

---

## Plan findings — detail

Numbered as Part A cites them. **Owner-decision findings are marked (OQ)**, and Task 0 puts them to the owner one at a time.

1. **(answered: owner P-2 "A")** `patchDivision` already locks the whole config with `FORMAT_LOCKED` once any fixture exists (`divisions.ts:820-856`, F2b pin `division-settings.test.ts:586-640`). The `tiebreakers` column (`:899`) is unlocked. Q3/Q4 as ruled LOOSENS the config lock and tightens the tie-break lock.
2. The spec premise "a division save has no started check" is false. It has a stricter one (finding 1).
3. Several Q5 match keys are leaves inside stage-owned objects (`overtime.minutes`, `shootout.attempts`, `periods.minutes`, `game.noAd`, `tiebreak.winBy`). `ruleKeys` keys are therefore dotted paths, and the most specific declaration wins (D1). This is a design decision, not an owner question.
4. `matchBound: "off_or_shorter"` is additive to the spec's `ruleKeys` type. X-SR-2 needs it to say "a match may only switch a decider off or shorten it".
5. The hockey, ice-hockey and football rules files exist only on W2b, so their rows are written in Task 3 after the rebase.
6. **Id corrections to sign in Task 0:** `CK-SO-1` (spec said `CR-SO-1`; the cricket prefix is CK), `CA-AB-2` (spec said `CM-AB-1`; the carrom prefix is CA), and `GN-AB-2` (GN-AB-1 already exists on W2b).
7. `describe-rules.ts` covers only 4 sports today (`:207`), so Task 16 is sizeable: 7 sports, 5 new families, deciders, abandon and points.
8. The OpenAPI document has no code enum. The new error codes are listed in route summaries (Tasks 13, 14), not as a schema enum.
9. `UNKNOWN_RULE_KEY` (a key the sport never declares) is kept apart from `RULE_NOT_SETTABLE` (declared, but not for this scope or kind). `SPORT_NOT_SUPPORTED` is retired with the 4-sport gate (Task 11).
10. The stage points path needs the `standings.custom_points` gate that `createStages` applies (`stages.ts:404-415`); otherwise `PUT /stages/{id}/rules` would be a paywall bypass (Task 13, Review Focus 3).
11. **(answered: owner P-3 "A")** What counts as a "forfeit" for stage points: an award with nothing played, whatever its reason; never a bye. **Premise refuted (review I7):** the first draft assumed W2b's award outcome carries a nothing-played marker. It does not: `{kind, winner, loser|null, reason}` has none (`core/types.ts:136-195`). The played fact comes from W2b's `playRecorded(ledger, module)` over the fixture's `score_events` (Task 9).
12. Only `mobile.spec.ts` runs at the seven widths, and it is serial. Each UI task adds one width test there, and a red is a floor (AGENTS.md 21).
13. `FixtureConsole` has no cfg/rules props, so Task 19 adds `loadFixtureMatchRules`.
14. The resolver takes a fixture row (`FixtureCfgSource`, D4), not a bare snapshot, so `rules_override` cannot be forgotten by a caller.
15. The `replaceStages` carry REPLACES `rules` today, which would drop the new defaults. Task 12 merges per key (Review Focus 5).
16. There are two stage insert sites (`stages.ts:458`, `templates.ts:345`). Both call `withStageDefaults`.
17. D3 is greenfield: top-level stage `shootout`/`extraTime` are removed from `StageConfig` and live only in `config.rules`. Tests and helpers that pin the old shape are updated.
18. The chess `colorOfHome` reader is at `external-play/guard.ts:450-456`, but only on the local `feat/chess-lichess-external-play` branch. P8 waits for it (Task 23).
19. Football shootout attempts were hard-coded to 5 (`football.ts:1621`) with no cfg key. Task 6 adds the match-scoped key `shootoutAttempts` (FB-SO-1; review M1).
20. Ruling 124 is W2b's generic retirement credit (it amends ruling 87), not "the owner's W2c approvals" as the first draft said. Task 3 folds it into `IDX` if W2b's merge did not. The W2c approvals (P-1..P-4, the execution ruling) take the next free ruling numbers in Task 0.
21. The spec's `competition.ts:315` is `:359` on W2b. The W2b caller is confirmed.
22. `competition/stage.ts` and `progression.ts` are not edited by W2c, so they go on the mutation session's no-wave list (MD-1 ownership).
23. **(answered: owner P-4 "A")** A correction the recorded play fits but that ENDS the match (best of 3 → 1 after a set) is refused `FORMAT_DOES_NOT_FIT_PLAY` "This format would end the match as it stands". Task 14 proves it on a real ledger (review I8).
24. Armageddon events change shape (`{rung, black, result}`). This is greenfield: three `tiebreak.test.ts` cases and the W2a e2e are rewritten. The first draft missed two more old-shape senders (review I10): `withdrawal-decider-hold.test.ts:214` (Task 8) and `scripts/smoke.ts:2406` (Task 11, which owns `smoke.ts` after lane E2 merges). The golden corpus has 0 Armageddon events, and `armageddonBlack` is optional and absent unless set, so every existing golden replays byte-identical (review I11; asserted in Task 8).
25. MD-1 volume risk: 14 engine files, some large (`football.ts`, the period kernel). Task 22 measures first and escalates above 150 survivors.
26. Task 1's order mutant may SURVIVE, because nothing pins sport order in `SPORT_RULES`. If it does, the split-equality test is the killer, and it is deleted in the same task. Record it as a survivor of a deleted test, not as a gap.
27. The engine sweep (Task 4) needs a test-side `UNSETTABLE` table per sport for schema keys that are deliberately not rule keys. Any key that cannot be classified as settable or unsettable goes to the owner, not to a guess.
28. **Rewritten (review C1; owner P-1 "A").** The first draft told a re-freeze from a first freeze by comparing `config_snapshot_at` (Postgres `now()`, µs) with the first event's `recorded_at` (the app's `new Date()`, ms). The two clocks never compare equal, so every pad tap would have been refused, and a null version after a re-freeze also refused the server's own writers. D14 now uses an integer `fixtures.rules_version`, bumped only by `refreezeFixture` and checked only when the sender includes it. Residual: a correction to an UNSTARTED fixture bumps nothing, so an open pad plays the new rules from its first append, which is the correct direction.
29. Cricket's split tie/no-result points make stage points inexpressible for cricket until W2d (`POINTS_RULE_INEXPRESSIBLE`, Task 13).
30. Ruling 74 (`IDX:1015`, "Other sports in brackets") sends "RB2B-1's creation refusal" to W2c, but `git grep` finds no code-level refusal of a decider-less knockout stage. Task 12's X-SR-6 test pins acceptance (all-off is allowed and held). **Settled by the owner's Q7 "B"; not re-asked (review M10).**
31. Whether an open pad refreshes its rules today is unverified (a read is not a run). Task 15 Step 1 DRIVES it with a kept probe before building, and the server check ships whatever the probe shows.
32. **(review C2)** The first draft knew one events POST site. There are five client sites: `transport.ts:355` and `device-score-pad.tsx:318` (pads), `fixture-console.tsx:634`, and `americano-panel.tsx:154`/`:160`. There are also three server writers that append without a client (`withdrawal.ts:121-160`, `scoring.ts:868` `finalizeFixture`, `event-import.ts:354`). P-1 classifies them; Task 15's source scan fails on an unclassified site, and its writers test proves the server writers are never blocked.
33. `applyPointsRule` has four callers, not two: `engine-db/competition.ts:395` and the bye path `:115`, plus `testkit/scenarios.ts:377` and `tools/bench/lib/validate-pack.ts`. The new required `played` parameter makes `tsc` list all four (Task 9).
34. **(answered: owner P-5 "A")** Generic's `share` abandon option with `allowDraws: false` would fold to a draw the format forbids. It is refused at config save, `CONFIG_INVALID` "Sharing the points needs draws to be allowed.", on every write path (Tasks 7, 11, 12), and the S1 form shows the option unavailable with the same reason (Task 17). Carrom has no `allowDraws`, so it is unaffected.
35. Generic has no `"sets"` variant; its variants are `win_loss` and `score` (`generic.ts:512-530`). Task 2's variant cases use `win_loss`, which differs from `score` on `resultMode` and `allowDraws`.
36. Task 2's I1 re-parse case depends on the set kernel refusing `cap` below `setTo` (the restored mix: `setTo` and `finalSetTo` restored, `cap` lowered; `setbased/kernel.ts:129` refines `cap >= max(setTo, finalSetTo)` on main). The test asserts that refinement as a precondition from the module's own schema. If the kernel does not refine it, the precondition reds first, and the implementer picks a pair from the schema's actual refinements instead. Silently passing is not an option.
37. The fixture console's chrome `post()` (`fixture-console.tsx:634`) carries start, void, settle, forfeit, abandon and finalize. P-1 leaves it unversioned, so a console action after a correction is never refused. That is by the owner's design: the console reads the server's current state before each action.
38. **(re-review minor)** P-1's DB list includes "import after a correction". It cannot happen: `importEvents` refuses any fixture that already has a `score_events` row or a non-`scheduled` status (`event-import.ts:223-230`). A correction needs a started fixture, and a pre-start override bumps nothing. Task 15's writers test therefore covers withdrawal, finalize and settle; the import path stays classified as a non-sender.
39. **(re-review IMP-R1)** Event ids are UUIDs, not seq numbers. The first two drafts voided with `voids: "<seq>"`, which the engine refuses (`core/events.ts:296`), so every "after a void" case and the void branch of every sequence property never ran. Engine-level appends now void by `(await appendEvent(…)).event.id` and assert that the void landed (`v.event.voids`). Properties track a stack of live ids and assert `voidsLanded > 0`. Through `scoreEvent`, a void is `payload: {event_id}` (`scoring.ts:205`, `:408-416`); a top-level `voids` there answers `UNDO_NOOP`. Engine fold tests use the testkit's `e-<seq>` ids.
40. **(re-review IMP-R3)** Deleting `STAGE_DECIDER_KEYS` from `stageScopedCfg` changes the resolver's output for every caller, so it moved out of Sonnet Task 11 into Opus Task 13b. It runs after Task 12 moves every top-level decider writer into `config.rules`.

---

## Self-review

**1. Spec coverage.**

| Spec | Tasks |
|---|---|
| §2.1 #1 stage rules for every sport, scope-tagged (+ amendments: rule facts in the engine, per-sport web split) | 1, 4, 5, 11, 17 |
| #2 `fixtures.rules_override` through every caller | 10, 14, 19 |
| #3 correction of a started match; open pads reload; stale tap refused | 14, 15, 19 |
| #4 division locks by name | 2, 20 |
| #5 stage deciders screen; division default; API validation (SC-P8) | 11, 12, 17 |
| #6 knockout presets; all-off allowed with a notice (ruling 74) | 6, 12, 17 |
| #7 cricket super over per stage | 4 (CK-SO-1 scope), 6, 17 |
| #8 ice hockey KO default; football shootout attempts | 6 |
| #9 carrom `tieBoard` per table stage | 4, 11, 17 |
| #10 ST-G8 stage points; inexpressible refused | 9, 13, 18 |
| #11 a forfeit is an award with nothing played; `awardScore` replaces; byes never get it | 9 (P-3) |
| #12 "If a match is abandoned" per stage | 7, 16, 17 |
| #13 chess rungs; Armageddon colours; BG-KO-2 | 8, 17, 21 |
| #14 chess clock per stage, not per match | 4, 11, 17 |
| #15 public stage format label with stage rules and deciders | 16 |
| §5.3 S1–S5 | S1 17; S2 19; S3 18; S4 17, 19, 20; S5 21 |
| §7 codes | `RULE_NOT_SETTABLE`/`UNKNOWN_RULE_KEY` 4, 11, 14; `STAGE_FORMAT_LOCKED` 11, 13; `DIVISION_FORMAT_LOCKED`/`DIVISION_TABLE_RULES_LOCKED` 2; `FIXTURE_FORMAT_LOCKED`/`FORMAT_DOES_NOT_FIT_PLAY` 14; `POINTS_RULE_INEXPRESSIBLE` 9, 13; `TIEBREAK_COLOUR_REQUIRED` 8; `FIXTURE_RULES_CHANGED` 15 |
| §8 seams | override folded through every caller from a real `writeFixtureRulesOverride` write (14 re-points 10's test); `stageDefaults` read back through `resolveFixtureCfg` and folded (12); the Armageddon pad event folded by the real module, advancer read from the fold (21); the S3 preview and the public label are one function, `pointsLine` (16, 18) |
| §9 P1–P9 | P1 4 (engine sweep), 5 (web sweep); P2 10, 14 (from a real write); P3 10; P4 2, 11, 13; P5 14, 15 (remote-pad e2e); P6 9; P7 6, 12; P8 8, 21, 23 (cross-programme); P9 7 |
| §10 MD-1 | 22 |
| Appendix A | 3 (written), 0 (signed), 23 (proved-by) |

No gaps found.

**2. Placeholder scan.**
- No "TBD"/"TODO"/"similar to Task N".
- Where a task says "re-read X before running" (a testid, a helper's return shape, a route), that is a re-pin of a line in a moving tree (AGENTS.md 5), not missing content. The default it falls back to is named in each case.

**3. Type consistency.** Checked across tasks:
- `RuleKeys`, `RuleKeyFact`, `stageKeysFor`, `fixtureKeysFor`, `pointsKeysFor`, `stageTopKeysFor`, `sportTopKeys`, `stageDefaultsFor`, `checkFixtureOverride` (Task 4);
- `RuleField.edits`, `RuleContext`, `stageFieldsFor(ctx)`, `matchFieldsFor(ctx)` (Task 5; used in 17, 19);
- `FixtureCfgSource`, `resolveFixtureCfg` (Task 10; used in 14, 16);
- `withStageDefaults`, `validateStageRules` (12);
- `writeFixtureRulesOverride`, `OverrideWriteResult` (14; used in 15, 19);
- `fixtures.rules_version int` (10), bumped by `refreezeFixture` (14), checked in `appendEventInTx` and carried as `rules_version`/`rulesVersion: number` (15);
- `applyPointsRule(outcome, pair, rule, played)`, `isUnplayedForfeit(outcome, played)`, `forfeitShaped(outcome)` (9), and `ruleScoreReaches` (9, `qualification-view.ts`);
- `stageScopedCfg` reading `rules` only (13b);
- `decidersAllOff`, `stageFieldsShown`, `abandonOptionStates` (17, `stage-row-model.ts`);
- `SportModule.abandonOptions` (4), `abandonOptions(module)`/`ABANDON_LABELS` (5; used in 7);
- `effectiveRungs(cfg)` and the optional `armageddonBlack` (8; used in 21);
- `pointsLine` (16; used in 18; D12 names it);
- `RefusedField`, `divisionRefusals` (2; used in 20);
- the Armageddon payload `{rung, black, result}` (8; used in 21).

**4. Review Focus.** Five lines, each with its test in the owning task:
- 1 → Task 14;
- 2 → Task 10;
- 3 → Tasks 13 and 18;
- 4 and 5 → Task 12.

**5. Fix round (review of `f4c209bd6`; spec `1b757c6cb`; owner P-1..P-4 and the execution ruling).**

| Finding | Where fixed |
|---|---|
| C1 freeze clocks; null-version rule | D14 rewritten; Task 10 (column); Task 14 (bump); Task 15 rewritten; finding 28 |
| C2 other POST sites, server writers | D14; Task 15 (`events-post-sites.test.ts`, `rules-version-writers.test.ts`); finding 32 |
| I1 re-parse; refused variant drops its preset keys | Task 2 (two tests, Step 3 items 4/4a, mutants `t2-reparse`, `t2-variant-preset`) |
| I2 the two old lock pins | Task 2 (`division-settings.test.ts:726-738`); Task 10 (`smoke.ts:8378-8385`) |
| I3 MUT JSON must parse | Global Constraints (jq loop); every block re-checked |
| I4 `q4_stands` in OT/SO | Task 7 (predicate, shoot-out case, mutant `t7-q4-shootout`) |
| I5 ice hockey never offered `q4_stands` | Task 4 (`abandonOptions` type); Task 7 (per-sport lists, test, mutant `t7-ice-options`) |
| I6 / IMP-R2 `share` refusal | Task 7 (schema + `patchDivision`), Task 11 (`putStageRules`), Task 12 (`createStages`), Task 17 (S1 form); owner P-5 |
| I7 award has no played marker | Task 9 rewritten (`played` from `playRecorded`); finding 11 |
| I8 real ledgers | Task 14 (`playSet`, P-4 and its positive pair); Task 19 (X-SR-5 refusal e2e) |
| I9 Playwright killers | Tasks 17–21: pure helpers with unit killers |
| I10 old Armageddon senders | Task 8 (`withdrawal-decider-hold.test.ts:214`); Task 11 (`smoke.ts:2406`) |
| I11 golden byte-identical | Task 8 (optional `armageddonBlack`; `hasOwn` test; Step 4) |
| I12 rung order | Task 8 (`effectiveRungs`, `[blitz, rapid]` case, mutant `t8-order`); Task 21 reads it |
| I13 Task 23 scope | Task 23 Step 2 (per-task file lists, no `vitest related` over the branch) |
| M1 `shootoutAttempts` | Appendix A FB-SO-1; finding 19 |
| M2 tennis family key | Task 16 (`set`) |
| M3 BG-KO-1 amendment | Appendix A |
| M4/M12 shared web files | Task 5 owns `types.ts` "sequence", `shared.ts` `ABANDON_LABELS`/`abandonOptions`, `TABLE_RULE_KEYS`; Tasks 7/8 no longer touch them |
| M5 / IMP-R1 voids | every void by real event id, `payload: {event_id}` through `scoreEvent`; void branches assert they landed; finding 39 |
| M6 NoCoverage | Task 22 |
| M8/M10 not re-asked | Owner answers; Task 0; finding 30 |
| M9 tautological race assertion | Task 14 |
| M11 rules files on W2b | Task 0 Step 2 |
| CK-SO-1 league half | Task 6 (`cricket.test.ts` case, mutant `t6-league-superover`) |
| Execution ruling | **Execution** (batches; Opus Tasks 4, 9, 10, 13b, 14, 15); Task 23 Step 8 |
| IMP-R2 `share` write paths; owner P-5 | Task 7 (`patchDivision`), Task 11 (`putStageRules`), Task 12 (`createStages`), Task 17 (form); finding 34 |
| IMP-R3 overlay is resolver code | Task 13b (Opus); Execution states that Tasks 6–8 `ruleKeys` data stays Sonnet |
| IMP-R4 `AWAITING_PROOF` races; E3 file set | the batch-end proof commit (**Execution**); E3 lane row and Task 9 Files list the four broken suites |
| Minors (round 2) | `forfeitShaped` loads `played` for chess win-by-forfeit (Task 9); `SHOOTOUT` (Task 7); import case dropped (Task 15, finding 38); `t15-transport-sender` mutant; Task 19 test title; Task 21 non-canonical order case; `smoke.ts:2406` move in Task 11; `resnapshotFixtureConfig(actorId, fixtureId, reason)` (Task 14); `t2` literal lines (Task 2) |

## Execution handoff

The execution method is set by the owner (2026-10-13, "A Sonnet with those 4 tasks on Opus"): subagent-driven, in the six batches of **Execution**, with the loops and lanes above. Opus `implementer`/`reviewer` for Tasks 4, 9, 10, 13b, 14 and 15; `implementer-sonnet`/`reviewer-sonnet` for every other implementation task; one Opus `reviewer` pass plus the orchestrator's scoped gate at every batch end. The orchestrator asks the owner to review this plan and confirm it captures W2c before Task 0 begins.
