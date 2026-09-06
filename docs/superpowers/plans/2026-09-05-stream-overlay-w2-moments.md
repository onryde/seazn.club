# Stream Overlay W2 (Moments) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The overlay reacts to the match. A SIX, FOUR or OUT in cricket, a GOAL or card in football / hockey / ice hockey, an ACE, a break / set / match point and a set won in the racket sports, and a set point, match point or set won in volleyball (owner answer 21 / Q10) each raise a slab in the sport's own colour beside the bug (or under the bar), hold four seconds, fold away, and queue behind one another. The cricket bar's second band carries the batters at the crease and the bowler's figures. Nothing fires on load or reconnect; nothing fires twice; every name passes the public-site consent resolver; a sport whose module declares no such event renders nothing, by construction.

**Architecture:** One additive field on the public fixture payload — `recent: RecentEvent[]`, the last eight void-resolved ledger events with their raw engine type, sequence number, a consent-resolved minimal payload and, for the racket sports, a server-derived `setWon` / `pointState` annotation computed by replaying the module through the real fold and probing "would the next point win the game / set / match" (the engine is the authority; no set rule is retyped). A pure client projection `momentsFor(sportKey, recent, sinceSeq, msg)` turns it into `OverlayMoment[]` through a per-sport allowlist keyed by the module's declared event types. The stage tracks the highest sequence it has seen, starting at the initial payload's tip, so OBS opening mid-stream replays nothing. A FIFO queue reducer drives one slab component whose motion is `transform` / `opacity` only. The cricket line is a client projection of spectator W1's `match_centre.cricket.live` (primary) with a precisely named server fallback.

**Tech Stack:** Next 16 App Router (read `node_modules/next/dist/docs/` before touching a route), React 19, TypeScript 7 native tsc, Tailwind 4 + `globals.css`, zod, `@seazn/engine` (`foldMatch`, `resolveVoids`, per-module `eventSchemas`), postgres.js, vitest (`environment: "node"`, no DOM), Playwright, pnpm workspaces.

**Canvas (owner-reviewed, the visual authority):**
https://claude.ai/code/artifact/2aebcbde-28ba-45ff-9028-1151873e4901 — this
wave's artboard is **"Moments"** (SIX, OUT, GOAL and MATCH POINT slabs beside
the bug, in each sport's own colour), with "A across sports" and "B across
sports" for the boards the slab attaches to. `_THEMES.md` §5 holds the same
design as numbers.

**Spec:** `docs/superpowers/specs/2026-09-05-stream-overlay-design.md` — "Decisions locked" 3–4, "Architecture" §2 (`OverlayModel`, W2 fills `detail` for cricket), §9 Motion (the slab), "Step two — moments" (`OverlayMoment`, the per-sport allowlist), "Tests". Programme index: `docs/superpowers/specs/2026-09-05-stream-overlay-prompts/_INDEX.md`. Wave 1 plan: `docs/superpowers/plans/2026-09-05-stream-overlay-w1.md` (absent when this plan was written; the W1 skeleton below is taken from the spec and every W1 path is re-pinned at execution).

**Status (2026-09-05, main session review): NOT executable yet, by design.**
This wave is blocked on `feat/spectator-surface` W1 merging. Because its input
shapes are unpinned until then, several test bodies in Task 1 (the
`buildOverlayRecent` and `loadOverlayRecent` suites) are sketched as comments
rather than written as code, and two are empty `it(...)` bodies. That is a
placeholder by the repo's own rule and is recorded here so nobody runs the
plan as-is: **task zero** (close every RE-PIN row in the table below, record
the results in `_INDEX.md`) ends by rewriting every comment-sketched or
empty test body into real assertions derived from the pinned shapes, and
the plan is re-reviewed before Task 1 starts. An empty `it()` passes
vacuously; none may survive into a commit.

---

## Global Constraints

Copied from the spec and the programme rules; every task brief restates the ones it touches.

- **Sequencing.** W2 executes only after `feat/spectator-surface` W1 merges to `main` and this branch has rebased on it, and only after every `RE-PIN AT EXECUTION` in this document has been re-verified against the rebased tree (a brief is a hypothesis; a grep is not a read; a read is not a run). The "Dependencies on spectator W1" table says what to do when a symbol landed differently or not at all. Record each re-pin result in `_INDEX.md` before Task 1 starts.
- **pnpm, not npm.** `pnpm install --frozen-lockfile`, `pnpm exec vitest`, `pnpm i18n:gen-keys`, `pnpm i18n:check`, `pnpm openapi:gen`. `npm install` fails in this repo.
- **Four locales, always.** Any new or changed user-facing string lands in `apps/web/src/dictionaries/{en,es,fr,nl}/public.json` in the same commit, then `pnpm i18n:gen-keys` regenerates `apps/web/src/lib/i18n-keys.ts` (generated, never edited by hand) and `pnpm i18n:check` passes. No English typed into a component. Sport notation ("4", "W", "2.3-0-14-1", "CRR") stays notation; its `title` is localised.
- **Judge vitest only from the JSON reporter.** `cd <worktree>/apps/web && DATABASE_URL=postgresql://postgres@127.0.0.1:54405/seazn_ovl DATABASE_SSL=disable pnpm exec vitest run <paths> --reporter=json --outputFile=/tmp/seazn-env/ovl/<name>.json`, then read `numTotalTests`, `numPassedTests`, `numFailedTests`, and confirm `.testResults[].name` resolve under `.claude/worktrees/stream-overlay/` (a run from the wrong cwd is a false green). `rtk` summaries print `PASS(0) FAIL(0)` for a suite that failed to collect. Every DB-backed suite guards on `HAS_DB = !!process.env.DATABASE_URL`; without the env it skips and still exits 0.
- **Database.** Stand it up with `seazn-env up --label ovl` per the `seazn-local-env` skill (`db:apply` alone is not a fresh schema — it needs `sync:sports`). Confirm `show data_directory` is yours. Never run tests against port 5432.
- **Motion is `transform` and `opacity` only**, never layout properties; no entrance animation on load (OBS shows the page mid-stream, every reconnect would slide in); no continuous ticker; no per-frame timers. The slab: in 250 ms, hold 4 s, out 250 ms, FIFO queue. `prefers-reduced-motion: reduce` = instant show and hide, same hold, same queue.
- **Design values come from `docs/superpowers/specs/2026-09-05-stream-overlay-prompts/_THEMES.md`** (binding, native 1920×1080): §5 the slab (tones `led` / `caution` / `dismissal`, height 216, padding 0 33, headline Barlow 96/800 line-height 0.9, two-line variant 78, line Geist 21/600, radius `0 12 12 0` beside the bug or `0 0 6 6` under the bar; a wicket slab turns the bug's LED bar and score to the dismissal colour for its hold), §6 the slab row of the motion table, §3 the cricket detail-band cells marked W2, §1 the Barlow 800 weight the overlay layout must mount. Tasks cite these sections; no value is restated or invented.
- **Names on moments pass through the public-site consent resolver** — `resolvePersonDisplayName(fullName, consent, division.player_name_display, division.youth)` (`apps/web/src/lib/name-display.ts:72`) or spectator W1's `readPublicLineups` / `PublicPerson` seam that wraps it — exactly as the match centre's Summary tab does. The client never sees a full name the public page would mask.
- **Templates are derived from each module's declared event types.** Every recorded-event key in the allowlist is a key of that module's `eventSchemas` (`packages/engine/src/sport/module.ts:516`), asserted by a test that imports the real modules. An unlisted type (a future event, a sport with no entries) yields no moment and no throw — never a crash and never a placeholder slab. Board game, carrom and generic have no entries.
- **One authority per fact.** The overlay derives nothing twice: set rules come from the engine by probing the fold, batter figures come from W1's scorecard fold (or, as the named fallback, the engine's own folded state), names come from the consent resolver. No table of set targets or dismissal semantics is typed into `apps/web`.
- **Subagents run Opus or above** (owner ruling "use OPus SubAgent"; `model: opus` on every dispatch). Never silently downgrade.
- **Every change ships a test that fails without it**; the four kinds (unit, e2e, smoke, regression) are stated per task; mutation checks are run, not described.
- **e2e runs on push to `main` only.** Before merge use `workflow_dispatch` on `.github/workflows/e2e.yml` with the `pr` input; smoke runs on PRs only. Read `e2e.yml` itself before believing either sentence.
- **Worktree discipline.** All work in `.claude/worktrees/stream-overlay` on `feat/stream-overlay`; prefix shell commands with `cd /Users/ashokhein/github/seazn.club/.claude/worktrees/stream-overlay &&` in the same call; never `git stash` (the stash stack is shared with the main checkout); commit with `/usr/bin/git commit -o <paths>` so the shared index cannot sweep a sibling's files in (`-o` fails with "pathspec did not match" on a NEW file: `/usr/bin/git add <new-file>` first, as its own plain call, then commit; the session's guard also refuses heredocs, `eval`, sourcing and `&&` chains that include git, so every git call is one plain command).
- **No redirect built from `req.url`** anywhere in this programme (base-commit health note in `_INDEX.md`): W2 adds no route; the existing public route returns JSON.
- **Sponsor logos are NOT in W2** (owner answer 20 / Q9, 2026-09-06: *"ok for own wave as put it last"*) — they are their own wave, scheduled LAST in the programme, after W1 and W2. The slab is the only thing that appears beside the bug or under the bar in this wave; reserve no space and leave no seam for a logo, because a reserved-but-empty slot is an inert seam and that wave owns sizing, placement and the per-tier rules.
- **Phone composition rules do not apply to the overlay canvas** (authored at 1920×1080, scaled), but the organiser panel's live preview renders the same component at reduced scale, so the slab must not overflow the 1920×1080 stage at any moment length: `max-width` on the slab, `truncate` with `min-w-0` on its text.

---

## Dependencies on spectator W1

Authority when this plan was written: the READ-ONLY worktree `.claude/worktrees/spectator` (branch `feat/spectator-surface`, 2026-09-05). Everything below is marked **RE-PIN AT EXECUTION**: W1 may land differently, and the pins are branch-relative (cite the symbol, re-find the line).

| # | Symbol (RE-PIN AT EXECUTION) | Where it is expected after the merge | What W2 uses it for | Fallback if absent or shaped differently |
|---|---|---|---|---|
| D1 | `LiveFixtureData.match_centre?: MatchCentreDocT` — `feat/spectator-surface:apps/web/src/components/public-site/live-score-data.ts:33` | `apps/web/src/components/public-site/live-score-data.ts` | Task 3 primary source of the cricket line: `data.match_centre?.cricket?.live` | Task 3 variant B/C: `LiveFixtureData.overlayCricket?: OverlayCricketLive` built by our own `loadOverlayRecent` (this plan, Task 1's helper gains `cricketLive`) |
| D2 | `CricketView.live` shape — `feat/spectator-surface:apps/web/src/server/public-site/match-centre-schema.ts:41`: `{ striker: Person\|null, nonStriker, bowler, batters: CricketBattingRow[] (person, runs, balls, …), bowling: CricketBowlingRow[] (person, overs, maidens, runs, wickets, …), thisOver: string[], partnership, lastWicket }`, `Person = { personId, name, masked }` | same file | Task 3's input contract `OverlayCricketLiveInput` (structurally a subset of this) | Same as D1; the input type is ours, so only the adapter changes |
| D3 | `deriveCricketScorecard({ events, cfg, lineups }: ScorecardInput): CricketScorecard` — `feat/spectator-surface:packages/engine/src/sports/cricket/scorecard.ts:945`, exported from `sports/cricket/index.ts`; `CricketLive` at `scorecard-types.ts:85` (`striker/nonStriker/bowler: PersonId\|null`, `thisOver: BallGlyph[]`, `partnership`, `lastWicket`) and `BattingLine { runs, balls, … }` | `@seazn/engine/sports/cricket` | Task 1: the dismissed batter's `runs (balls)` on the OUT line; Task 3 variant B: the cricket line when D1 is absent | Task 1/3 variant C: the engine's own folded state — `activeInnings(state).list.at(-1)!.fine` (`packages/engine/src/sports/cricket/cricket.ts:584,441,409-422`: `striker`, `nonStriker`, `currentBowler`, `batterRuns`, `batterBalls`, `bowlerBalls`, `bowlerRuns`, `bowlerWickets`) via `foldMatch(cricket, cfg, lineups, events)`. Zero rules retyped either way. |
| D4 | `readPublicLineups(sql, …)`, `PublicPerson = { personId, name, masked }`, `DivisionConsentCtx = { youth?, player_name_display? }` — `feat/spectator-surface:apps/web/src/server/public-site/public-lineups.ts:21-25` | `apps/web/src/server/public-site/public-lineups.ts` | Task 1's `personOf(id)` for names in `recent` | Our own query in `overlay-recent.ts`: `select id, full_name, consent from persons where id = any($1) and merged_into is null` + `resolvePersonDisplayName` (`apps/web/src/lib/name-display.ts:72`); `merged_into is null` mirrors `data.ts:529` |
| D5 | The derived set-won diff inside `buildTimeline` — `feat/spectator-surface:apps/web/src/server/public-site/timeline.ts:500-560` (`derivedLines(previous, summary, event, sportKey, sides)`, module-local) and its replay loop `:600-623` (`module.apply(state, event, { strict: false, squads })`, skipping `core.suspend`/`core.resume` and lineup events) | `apps/web/src/server/public-site/timeline.ts` | Task 1's `setWon` annotation | Default, because `derivedLines` is not exported: our own `diffClosedSets(before, after)` over `summary.detail.sets[].closed` — the same diff, and W2 uses `foldMatch` prefixes rather than a hand replay so it can never drift from the production fold |
| D6 | The live transport hook — spectator has `feat/spectator-surface:apps/web/src/components/public-site/match-centre/use-live-fixture.ts:18` `useLiveFixture(...)` with `POLL_MS = 15_000`; the overlay W1 skeleton names `apps/web/src/components/public-site/use-live-fixture.ts` | whichever path survives the merge (one hook, one transport) | Task 4 reads `data` from it and diffs `data.recent` | None needed: W2 touches neither hook's internals; it only consumes `data` |
| D7 | `publicFixture()` carrying `match_centre` via `loadMatchCentre` (spectator plan Task 9; `match-centre.ts` did NOT exist on the branch on 2026-09-05) | `apps/web/src/server/usecases/public.ts:263` | Only the ledger query could be shared | `recent` is loaded by our own `loadOverlayRecent` regardless; if `loadMatchCentre` exposes the loaded ledger/cfg/lineups, pass them in to avoid a second `score_events` read |
| D8 | `TIMELINE_KEY_FOR` and the `timeline.*` dictionary keys (`feat/spectator-surface:apps/web/src/dictionaries/en/public.json:67-91`) | `public.json` | Informational only — W2 carries RAW engine types in `recent` and keeps its own `overlay.moment.*` keys, so a timeline template change cannot move a slab | — |

Pins on THIS branch that W2 builds on (verified 2026-09-05, `feat/stream-overlay`):

| path:line | symbol | fact |
|---|---|---|
| `apps/web/src/server/usecases/public.ts:263-298` | `publicFixture(fixtureId): Promise<unknown>` | selects from `public_fixtures_v`, cached under `pub:v1:fixture:<id>` (`:265`, `cached()` `:32`, TTL) |
| `apps/web/src/server/usecases/scoring.ts:491-507` | `invalidatePublicCache` | `cacheDelPattern("pub:v1:fixture:<id>")` + `fireDivisionRevalidate` on every accepted event — `recent` inherits both |
| `apps/web/src/server/public-site/data.ts:689-747` | `getPublicFixture(...)` | `unstable_cache(["pub-fixture", id], { tags: [divisionTag] })`; returns `{ fixture, entrantNames, realtime }`; `PublicDivision.youth?`, `.player_name_display?` at `:202-203`, read off `public_divisions_v dv` at `:440` |
| `apps/web/src/server/engine-db/fold.ts:59-146` | `foldFixture(tx, id)` | the module/cfg/lineups recipe: `resolveModule(sport_key, module_version)` (`registry.ts:27`), `resolveFixtureCfg(config_snapshot, division.config, stage.config)` (`fixture-cfg.ts`), `loadLineupPair(tx, id, home, away)` (`lineups.ts:64`, `tx: postgres.TransactionSql`) |
| `apps/web/src/server/engine-db/append-event.ts:196-197` | ledger read | `select id, seq, type, payload, recorded_at, recorded_by, voids_event_id from score_events where fixture_id = $1 order by seq` |
| `apps/web/src/server/usecases/scoring.ts:81` / `usecases/fixtures.ts` | `scoreEvent(auth, fixtureId, …)`, `putLineup(auth, fixtureId, entrantId, body)` | the real producers the DB tests post through (RE-PIN their input shapes from `api-v1/schemas.ts` before writing the test) |
| `packages/engine/src/core/events.ts:24,165,222,445` | `EventEnvelope`, `resolveVoids`, `FoldContext { strict, squads }`, `foldMatch(module, cfg, lineups, events, opts?)` | `foldMatch` resolves voids itself; `core/index.ts` re-exports `isLineupEventType` (`core/lineup.ts:274`) |
| `packages/engine/src/sport/module.ts:516,586-588` | `eventSchemas?`, `apply(state, ev, ctx?)`, `outcome(state)`, `summary(state)` | `summary` is display-ready at every prefix |
| `packages/engine/src/sports/cricket/cricket.ts:363` | `CRICKET_EVENT_SCHEMAS` (15 keys) | `CricketBall` `:177` `{ over, ballInOver, striker, nonStriker, bowler, runs: { bat, extras? }, wicket?, boundary?: 4\|6, freeHit? }`; `CricketWicket.kind` `:150` = bowled, caught, lbw, runout, stumped, hitwicket, retired, obstructed, timedout, hitballtwice; `CricketToss` `:240` `{ wonBy, elected }`; `cricket.superover.ball` shares `CricketBall` |
| `packages/engine/src/sports/football/football.ts:437` | `FOOTBALL_EVENT_SCHEMAS` (9 keys) | `FootballGoal` `:212` `{ by, scorer?, assist?, minute?, ownGoal?, penalty?, at? }`; `CardColor` `:224` = yellow, red, second_yellow; `FootballCard` `:244` `{ by, person?, color, minute?, reason?, at? }` |
| `packages/engine/src/sports/period/kernel.ts:1818-1868` | `makePeriodModule` `eventSchemas` | `<key>.goal`, `.period.advance`, `.suspension.start`, `.suspension.end`, `.shootout.attempt`, `.set_piece`, `.shot`; `PeriodGoal` `:223` `{ by, person?, assists?, kind?, emptyNet?, … }`; `PeriodSuspensionStart` `:301` `{ by, person?, class, reason?, servedBy?, minutes? }` |
| `packages/engine/src/sports/hockey/hockey.ts:5,50,54,130` / `icehockey/icehockey.ts:63-83,171` | class keys | hockey: green, yellow, red (`HOCKEY_SUSPENSIONS`, `period/suspensions.ts:73`); ice hockey: minor, bench_minor, double_minor, major, misconduct, game_misconduct, match (`ICEHOCKEY_SUSPENSIONS` `:56`). Not exported through `@seazn/engine/sports/*` — read them from the module's parsed default config in tests (RE-PIN the config entry point) |
| `packages/engine/src/sports/nested/kernel.ts:223,200,1989,2159-2177,1394` | `NestedPoint { by, server?, scorer?, meta?: { kind?: ace\|double_fault\|winner\|ue } }`; `eventSchemas` `<key>.point/.set_summary/.sanction/.interruption/.game.award`; summary `detail { sets[{home,away,closed}], games{home,away}, game: string, gameKind, serving: "home"\|"away"\|null }` | tennis key `tennis` (`tennis.ts:27` variants `tour`, …) |
| `packages/engine/src/sports/setbased/kernel.ts:147,2160,2399` | `SetBasedRally { wonBy, server?, scorer?, returns?, serving? }`; `eventSchemas` `<key>.rally/.set.summary/.timeout/.sanction/.sub/.expedite.start`; `detail { sets[{home,away,closed}], points{home,away} }` | keys `badminton`, `tabletennis`, `volleyball` (`setbased/{badminton,tabletennis,volleyball}.ts`) |
| `apps/web/src/lib/public-site.ts:281` | `GAME_UNIT_SPORTS = {badminton, tabletennis}` | the unit word ("Game" vs "Set") — W2 reuses it for `gamePoint`/`gameWon` vs `setPoint`/`setWon` |
| `apps/web/src/lib/scoring-vocab.ts:1147` | `MsgFn = (key: MessageKey, vars?) => string` | the `msg` W1's `overlayModel` already takes |
| `apps/web/src/lib/i18n-runtime.ts:30`, `scripts/i18n/gen-keys.ts` | `t(dict, key, vars)`; `DictionaryKey` is the flattened union of every `en/*.json` key — `public.json` keys carry NO `public.` prefix (`"chip.onNow"`), so the spec's `public.overlay.moment.*` is the FILE `public.json`, key `overlay.moment.*` | |
| `apps/web/e2e/helpers.ts:117,128,500,1282,1532` | `TAG`, `apiJson(request, path, method, body?)`, `setBoolEntitlementOverrideSql(orgId, key, value)`, `activeOrgIdFromRequest(request)`, `seedRosteredFixture(request, { label, sportKey, variantKey, home: RosterSlotSpec[], away, entrantKind?, emitCoreStart?, skipLineups? })` | persons are created with `consent: { public_name: true }`; events post to `/api/v1/fixtures/<id>/events` with `{ expected_seq, type, payload }`; `GET /api/v1/fixtures/<id>/state` → `last_seq` |
| `apps/web/playwright.config.ts:119,139-160` | `WALKTHROUGH = /[\\/]e2e[\\/]walkthrough[\\/]/`; `parallel` project = default testMatch | `stream-overlay.spec.ts` runs in `parallel`; a capture spec under `e2e/walkthrough/` runs in `walkthrough` |
| `scripts/smoke.ts:4931-4934` | `const pub = await v1(anon, "/api/v1/public/fixtures/<id>")`, `check(label, cond)` | the anonymous public-fixture read the smoke line extends |
| `apps/web/src/server/api-v1/openapi.ts:200` | `/public/fixtures/{id}` has no `response` schema | adding `recent` to the payload is not an OpenAPI drift; `pnpm openapi:gen` must produce an empty diff |
| `apps/web/src/app/globals.css:187-197,1014-1022` | reduced-motion block pattern; `:root { --sport-board, --sport-board-2, --sport-ink, --sport-led, --sport-advisory, --sport-caution, --sport-dismissal }` | slab tones read `--sport-led` / `--sport-caution` / `--sport-dismissal` |
| `packages/engine/src/testkit/helpers.ts:11,64` | `makeEnvelope(seq, { type, payload })`, `defaultLineupPair(module.positions)` → person ids `H-p1…`, `A-p1…` | the unit-test ledger idiom (`apps/web/src/components/v2/scorepad/__tests__/view-model.test.ts:8-12`) |

---

## File Structure

W1 skeleton (from the spec; RE-PIN each path against the merged tree):
`apps/web/src/lib/overlay-model.ts` (`overlayModel`, `OverlayModel`), `apps/web/src/components/overlay/{overlay-stage,overlay-bar,overlay-bug}.tsx`, `apps/web/src/components/public-site/use-live-fixture.ts` (or D6), `apps/web/src/app/overlay/fixtures/[fixtureId]/page.tsx`, `apps/web/e2e/stream-overlay.spec.ts`.

W2 creates or modifies:

```
apps/web/src/lib/overlay-recent-types.ts                     NEW  pure types: RecentEvent, RecentPayload, RecentDerived, OverlayCricketLive (shared client/server)
apps/web/src/server/public-site/overlay-recent.ts           NEW  loadOverlayRecent (DB) + buildOverlayRecent (pure) + RECENT_PROJECT + probePointState + diffClosedSets
apps/web/src/server/public-site/__tests__/overlay-recent.test.ts   NEW  DB-backed usecase test (posts through the real producers)
apps/web/src/server/usecases/public.ts                      MOD  publicFixture() returns { …row, recent }
apps/web/src/server/public-site/data.ts                     MOD  getPublicFixture() returns { …, recent }
apps/web/src/components/public-site/live-score-data.ts     MOD  LiveFixtureData.recent?: RecentEvent[] (and overlayCricket? only in Task 3 variant B/C)
apps/web/src/app/overlay/fixtures/[fixtureId]/page.tsx      MOD  initial carries recent
apps/web/src/lib/overlay-moments.ts                         NEW  momentsFor, MOMENT_RULES, OverlayMoment, MOMENT_KEYS
apps/web/src/lib/__tests__/overlay-moments.test.ts          NEW  per-sport folds, declarations parity, once-per-seq
apps/web/src/lib/overlay-cricket.ts                         NEW  cricketDetail(live, msg): string[]; liveFromFoldState adapter (fallback C)
apps/web/src/lib/__tests__/overlay-cricket.test.ts          NEW  real cricket ledger through the engine fold
apps/web/src/lib/overlay-model.ts                           MOD  detail = cricketDetail(...) when sportKey === "cricket"
apps/web/src/components/overlay/moment-timing.ts            NEW  OVERLAY_MOMENT_HOLD_MS = 4000, OVERLAY_MOMENT_FOLD_MS = 250 (imported by the e2e for its budget)
apps/web/src/components/overlay/moment-queue.ts             NEW  pure reducer: momentQueueReducer, MomentQueueState
apps/web/src/components/overlay/use-moment-queue.ts         NEW  useMomentQueue(incoming, { reducedMotion })
apps/web/src/components/overlay/overlay-moment.tsx          NEW  <OverlayMomentSlab>
apps/web/src/components/overlay/__tests__/moment-queue.test.ts NEW  reducer: FIFO, hold value, fold, reduced motion
apps/web/src/components/overlay/overlay-stage.tsx           MOD  seq tracking + queue + slab mount
apps/web/src/app/globals.css                                MOD  .ovl-slab* rules, keyframes, reduced-motion
apps/web/src/dictionaries/{en,es,fr,nl}/public.json         MOD  overlay.moment.* keys
apps/web/src/lib/i18n-keys.ts                               GEN  pnpm i18n:gen-keys
apps/web/src/lib/__tests__/overlay-moment-dictionary.test.ts NEW  every emittable key × 4 locales, enum-derived
apps/web/e2e/stream-overlay.spec.ts                         MOD  describe("moments")
apps/web/e2e/walkthrough/stream-overlay-capture.spec.ts     MOD/NEW  visual gate additions
scripts/smoke.ts                                            MOD  one check: the public fixture JSON carries recent
docs/superpowers/specs/2026-09-05-stream-overlay-prompts/_INDEX.md  MOD  status + W2 pins
```

---

### Task 1: The public payload carries the last eight events (`recent`)

**Files:**
- Create: `apps/web/src/lib/overlay-recent-types.ts`
- Create: `apps/web/src/server/public-site/overlay-recent.ts`
- Modify: `apps/web/src/server/usecases/public.ts:263-298` (`publicFixture`)
- Modify: `apps/web/src/server/public-site/data.ts:689-747` (`getPublicFixture`)
- Modify: `apps/web/src/components/public-site/live-score-data.ts` (`LiveFixtureData`)
- Modify: `apps/web/src/app/overlay/fixtures/[fixtureId]/page.tsx` (W1; `initial` gains `recent`)
- Modify: `scripts/smoke.ts` (one `check`)
- Test: `apps/web/src/server/public-site/__tests__/overlay-recent.test.ts`
- Do NOT touch: `apps/web/src/app/api/v1/public/fixtures/[id]/route.ts` (the route already returns whatever `publicFixture` returns), the engine, `live-score.tsx`.

**Interfaces:**

```ts
// apps/web/src/lib/overlay-recent-types.ts — pure, imported by client and server
export interface RecentPerson { name: string; masked: boolean }
export interface RecentPayload {
  side?: 0 | 1;                 // index into [home, away] the event credits (`by` / `wonBy`)
  person?: RecentPerson;        // scorer, carded player, dismissed batter, point scorer — consent-resolved
  runs?: number;                // cricket: runs off the bat
  boundary?: 4 | 6;
  wicketKind?: string;          // a CricketWicket.kind member
  batterRuns?: number;          // dismissed batter's final figures (D3, else the folded state)
  batterBalls?: number;
  colour?: string;              // football CardColor member
  class?: string;               // period-sport suspension class key
  kind?: string;                // goal kind / point meta.kind ("ace")
  ownGoal?: boolean;
  penalty?: boolean;
}
export interface RecentDerived {
  setWon?: { set: number; winner: 0 | 1; home: number; away: number };
  pointState?: { kind: "break" | "set" | "match"; side: 0 | 1; fresh: boolean };
}
export interface RecentEvent { seq: number; type: string; at: string; payload: RecentPayload; derived?: RecentDerived }
export const OVERLAY_RECENT_WINDOW = 8;
```

```ts
// apps/web/src/server/public-site/overlay-recent.ts
export function buildOverlayRecent(args: {
  sportKey: string; module: AnySportModule; cfg: unknown; lineups: LineupPair;
  events: readonly EventEnvelope[]; sides: [string, string];
  personOf: (id: unknown) => RecentPerson | undefined;
  batterFigures?: (personId: string, stateAfter: unknown) => { runs: number; balls: number } | null;
  window?: number;
}): RecentEvent[];
export async function loadOverlayRecent(sql: Sql, fixture: { id: string; division_id: string; home_entrant_id: string | null; away_entrant_id: string | null }): Promise<RecentEvent[]>;
export const RECENT_PROJECT: Readonly<Record<string, Project>>;      // keyed by ENGINE EVENT TYPE
export function diffClosedSets(before: unknown, after: unknown): RecentDerived["setWon"] | undefined;
```

- [ ] **Step 1: RE-PIN.** In the rebased tree run and record in `_INDEX.md`: `grep -an "match_centre\|loadMatchCentre" apps/web/src/server/usecases/public.ts apps/web/src/server/public-site/data.ts` (D7); `grep -an "export" apps/web/src/server/public-site/public-lineups.ts` (D4); `grep -an "^export async function scoreEvent" -A 8 apps/web/src/server/usecases/scoring.ts` and `grep -an "export const ScoreEvent\b\|export const PutLineup\b" -A 8 apps/web/src/server/api-v1/schemas.ts` (the producers' input shapes); `grep -an "youth\|player_name_display" db/migration -r | head` (whether the two columns live on `divisions` or only on the view).

- [ ] **Step 2: Failing tests** — `apps/web/src/server/public-site/__tests__/overlay-recent.test.ts`. DB-backed, following `apps/web/src/server/usecases/__tests__/add-fixture.test.ts:5-17` (`HAS_DB`, `describe.skipIf`) and the `_rig.ts` seeding helpers. Post through the REAL producers (`scoreEvent`, `putLineup`), never SQL inserts into `score_events`.

```ts
import { describe, expect, it, beforeAll } from "vitest";
import { sql } from "@/server/db";                                       // RE-PIN the default client's module
import { resolvePersonDisplayName } from "@/lib/name-display";
import { publicFixture } from "@/server/usecases/public";
import { scoreEvent } from "@/server/usecases/scoring";
import { putLineup, createPerson /* RE-PIN */ } from "@/server/usecases/fixtures";
import { seedOrg, makeCommunityRig } from "../../usecases/__tests__/_rig";
import { buildOverlayRecent, diffClosedSets } from "../overlay-recent";
import type { RecentEvent } from "@/lib/overlay-recent-types";
import { foldMatch } from "@seazn/engine/core";
import { defaultLineupPair, makeEnvelope } from "@seazn/engine/testkit";
import { tennis } from "@seazn/engine/sports/tennis";
import { cricket } from "@seazn/engine/sports/cricket";

const HAS_DB = !!process.env.DATABASE_URL;
const recentOf = (doc: unknown) => (doc as { recent: RecentEvent[] }).recent;

describe("buildOverlayRecent (pure, real modules)", () => {
  it("EMPTY ledger → []", () => {
    const lineups = defaultLineupPair(tennis.positions);
    expect(buildOverlayRecent({ sportKey: "tennis", module: tennis, cfg: tennis.variants.tour /* RE-PIN cfg parse */, lineups, events: [], sides: ["H", "A"], personOf: () => undefined })).toEqual([]);
  });
  it("keeps the last 8 module events, oldest first, raw engine type preserved, core.* and lineup events excluded", () => {
    // 12 tennis points after core.start → 8 entries, all type "tennis.point", seq ascending, none "core.start"
  });
  it("a voided event is absent from the window (resolveVoids runs first)", () => {
    // point at seq 3, core.void { voids: id-of-3 } at seq 4 → no entry with seq 3
  });
  it("tennis: the point that makes it 40–30 on the receiver's serve is a BREAK point, fresh; the next point (Ad) is not fresh", () => {
    // ledger: core.start, then points so that server=home and game reaches 30–40 (away leads) →
    // last.derived.pointState = { kind: "break", side: 1, fresh: true }; add one more away point? no — add a HOME point → 40–40 → pointState undefined
    // then away point → Ad away → { kind: "break", side: 1, fresh: true } again (transition after a gap IS fresh)
  });
  it("tennis: a set point that also wins the match is MATCH, not SET; a decided match has no pointState", () => {
    // fold a best-of-1-set ledger (RE-PIN a tennis cfg with bestOf 1 or drive 6-0 games) to 5–0 40–0 → kind "match"; after the winning point → pointState undefined
  });
  it("tennis: winning a set annotates setWon on the winning point with the closed set's games", () => {
    const won = /* the entry whose event closed the set */;
    expect(won.derived?.setWon).toEqual({ set: 1, winner: 0, home: 6, away: 0 });
  });
  it("badminton: 20–19 is a SET point for the leader; the probe never runs a type the module does not declare", () => {
    // 21-point game; also assert buildOverlayRecent with a module whose eventSchemas lacks "<key>.rally" (spy: { ...badminton, eventSchemas: {} }) yields NO pointState
  });
  it("cricket: a boundary ball projects { runs: 6, boundary: 6 }; a wicket ball projects wicketKind, the batter's name and figures; a plain ball projects { runs: 1 }", () => {
    // lineups = defaultLineupPair(cricket.positions); ids H-p1..; toss + core.start + 3 balls
    // personOf: (id) => id === "H-p1" ? { name: "H. One", masked: true } : undefined
  });
  it("football: goal → { side, person, ownGoal:false, penalty:false }; card → { side, person, colour: 'yellow' }; no derived", () => {});
  it("diffClosedSets: null/undefined/non-array on either side → undefined; a set closing → the set's ordinal, winner and score", () => {});
});

describe.skipIf(!HAS_DB)("loadOverlayRecent through publicFixture (DB)", () => {
  it("a posted football goal is read back as recent[-1] with type football.goal and seq === last_seq", async () => {
    const { auth } = await seedOrg();
    const rig = await makeCommunityRig("football");             // RE-PIN: started division + fixture + entrant ids
    await scoreEvent(auth, rig.fixtureId, { expectedSeq: 0, type: "core.start", payload: {} });
    await scoreEvent(auth, rig.fixtureId, { expectedSeq: 1, type: "football.goal", payload: { by: rig.homeEntrantId } });
    const recent = recentOf(await publicFixture(rig.fixtureId));
    expect(recent.at(-1)).toMatchObject({ seq: 2, type: "football.goal", payload: { side: 0 } });
    expect(recent.some((r) => r.type.startsWith("core."))).toBe(false);
  });
  it("names on recent are the consent resolver's output, not the stored full name (opt-out AND youth)", async () => {
    // seed a cricket division with two persons per side (RE-PIN createPerson/putLineup input shapes), one with consent { public_name: false }
    // post cricket.toss, core.start, one cricket.ball wicket with wicket.out = the opted-out batter
    const recent = recentOf(await publicFixture(fixtureId));
    const out = recent.at(-1)!;
    const expected = resolvePersonDisplayName("Bartholomew Ravindranath", { public_name: false }, null, false);
    expect(out.payload.person?.name).toBe(expected);              // derived from the resolver, never typed
    expect(out.payload.person?.name).not.toBe("Bartholomew Ravindranath");
    expect(out.payload.person?.masked).toBe(true);
    // second half: flip the division to youth (RE-PIN the column) and post another wicket for a CONSENTING batter → masked too
  });
  it("the cached payload is invalidated by the next event (recent grows without waiting for the TTL)", async () => {
    // publicFixture twice around a scoreEvent; second read's recent.length === first + 1
  });
  it("a fixture with an unassigned entrant (bye/TBD) returns recent: [] and does not throw", async () => {});
});
```

- [ ] **Step 3: Run — expect failures** (module not found).
  `cd /Users/ashokhein/github/seazn.club/.claude/worktrees/stream-overlay/apps/web && DATABASE_URL=postgresql://postgres@127.0.0.1:54405/seazn_ovl DATABASE_SSL=disable pnpm exec vitest run src/server/public-site/__tests__/overlay-recent.test.ts --reporter=json --outputFile=/tmp/seazn-env/ovl/w2-t1-red.json`
  Expected: `numFailedTestSuites: 1` (collection error: cannot resolve `../overlay-recent`).

- [ ] **Step 4: Implement** `overlay-recent-types.ts` (as above) and `overlay-recent.ts`:

```ts
import "server-only";
import type postgres from "postgres";
import { foldMatch, isLineupEventType, resolveVoids, type EventEnvelope, type LineupPair, type ScoreSummary } from "@seazn/engine/core";
import type { AnySportModule } from "@seazn/engine/sport";
import { activeInnings } from "@seazn/engine/sports/cricket";
import { resolveModule } from "@/server/engine-db/registry";
import { loadLineupPair } from "@/server/engine-db/lineups";
import { resolveFixtureCfg } from "@/server/engine-db/fixture-cfg";
import { resolvePersonDisplayName } from "@/lib/name-display";
import { OVERLAY_RECENT_WINDOW, type RecentDerived, type RecentEvent, type RecentPayload, type RecentPerson } from "@/lib/overlay-recent-types";

type Sql = ReturnType<typeof postgres>;
type Project = (payload: Record<string, unknown>, ctx: ProjectCtx) => RecentPayload;
interface ProjectCtx {
  sideOf: (entrantId: unknown) => 0 | 1 | undefined;
  personOf: (id: unknown) => RecentPerson | undefined;
  batterFigures: (personId: string) => { runs: number; balls: number } | null;
}
const strip = <T extends object>(o: T): T => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as T;

const ball: Project = (p, ctx) => {
  const bat = (p.runs as { bat?: number } | undefined)?.bat;
  const wicket = p.wicket as { kind?: string; out?: string } | undefined;
  const fig = typeof wicket?.out === "string" ? ctx.batterFigures(wicket.out) : null;
  return strip({
    runs: typeof bat === "number" ? bat : undefined,
    boundary: p.boundary === 4 || p.boundary === 6 ? p.boundary : undefined,
    wicketKind: wicket?.kind,
    person: wicket ? ctx.personOf(wicket.out) : undefined,
    batterRuns: fig?.runs, batterBalls: fig?.balls,
  });
};
const goal: Project = (p, ctx) => strip({
  side: ctx.sideOf(p.by), person: ctx.personOf(p.scorer ?? p.person),
  ownGoal: p.ownGoal === true || p.kind === "og", penalty: p.penalty === true,
  kind: typeof p.kind === "string" ? p.kind : undefined,
});
const card: Project = (p, ctx) => strip({ side: ctx.sideOf(p.by), person: ctx.personOf(p.person), colour: String(p.color) });
const suspension: Project = (p, ctx) => strip({ side: ctx.sideOf(p.by), person: ctx.personOf(p.person), class: String(p.class) });
const point: Project = (p, ctx) => strip({ side: ctx.sideOf(p.by), person: ctx.personOf(p.scorer), kind: (p.meta as { kind?: string } | undefined)?.kind });
const rally: Project = (p, ctx) => strip({ side: ctx.sideOf(p.wonBy), person: ctx.personOf(p.scorer) });

/** Keyed by the ENGINE'S recorded event type. A type absent here projects to `{}` and is still listed with its raw type — the client allowlist decides. */
export const RECENT_PROJECT: Readonly<Record<string, Project>> = {
  "cricket.ball": ball, "cricket.superover.ball": ball,
  "football.goal": goal, "football.card": card,
  "hockey.goal": goal, "hockey.suspension.start": suspension,
  "icehockey.goal": goal, "icehockey.suspension.start": suspension,
  "tennis.point": point,
  "badminton.rally": rally, "tabletennis.rally": rally, "volleyball.rally": rally,
};

/** The synthetic "next point for side X" — ONLY for kernels that record one; the type must be in the module's own eventSchemas or the probe does not run. */
const PROBE_POINT: Readonly<Record<string, (by: string) => { type: string; payload: Record<string, unknown> }>> = {
  tennis: (by) => ({ type: "tennis.point", payload: { by } }),
  badminton: (by) => ({ type: "badminton.rally", payload: { wonBy: by } }),
  tabletennis: (by) => ({ type: "tabletennis.rally", payload: { wonBy: by } }),
  volleyball: (by) => ({ type: "volleyball.rally", payload: { wonBy: by } }),
};

type SetsDetail = { sets?: { home: number; away: number; closed: boolean }[]; games?: { home: number; away: number }; serving?: "home" | "away" | null } | undefined;
const setsOf = (d: unknown): SetsDetail => (typeof d === "object" && d !== null ? (d as SetsDetail) : undefined);
const closedCount = (d: SetsDetail) => (Array.isArray(d?.sets) ? d!.sets!.filter((s) => s.closed === true).length : 0);

export function diffClosedSets(before: unknown, after: unknown): RecentDerived["setWon"] | undefined {
  const b = setsOf(before), a = setsOf(after);
  if (!Array.isArray(a?.sets)) return undefined;
  for (let i = 0; i < a!.sets!.length; i++) {
    const set = a!.sets![i]!;
    if (set.closed !== true || b?.sets?.[i]?.closed === true) continue;
    return { set: i + 1, winner: set.home > set.away ? 0 : 1, home: set.home, away: set.away };
  }
  return undefined;
}

function probePointState(args: { sportKey: string; module: AnySportModule; cfg: unknown; lineups: LineupPair; prefix: readonly EventEnvelope[]; sides: [string, string]; stateNow: unknown }): Omit<NonNullable<RecentDerived["pointState"]>, "fresh"> | undefined {
  const mk = PROBE_POINT[args.sportKey];
  if (!mk || args.module.outcome(args.stateNow) !== null) return undefined;       // decided: nothing is "point"
  const now = setsOf(args.module.summary(args.stateNow).detail);
  const closedNow = closedCount(now);
  const last = args.prefix.at(-1);
  for (const side of [0, 1] as const) {
    const probe = mk(args.sides[side]);
    if (!(probe.type in (args.module.eventSchemas ?? {}))) return undefined;      // derived from the module's declarations, never assumed
    const env: EventEnvelope = { id: "overlay-probe", fixtureId: last?.fixtureId ?? "probe", seq: (last?.seq ?? 0) + 1, type: probe.type, payload: probe.payload, recordedAt: last?.recordedAt ?? new Date(0).toISOString(), recordedBy: null };
    let state: unknown;
    try { state = foldMatch(args.module, args.cfg, args.lineups, [...args.prefix, env]); } catch { continue; }
    if (args.module.outcome(state)?.kind === "win") return { kind: "match", side };
    const then = setsOf(args.module.summary(state).detail);
    if (closedCount(then) > closedNow) return { kind: "set", side };
    if (args.sportKey === "tennis" && now?.serving && now.serving !== (side === 0 ? "home" : "away")) {
      const k = side === 0 ? "home" : "away";
      if ((then?.games?.[k] ?? 0) > (now?.games?.[k] ?? 0)) return { kind: "break", side };
    }
  }
  return undefined;
}

export function buildOverlayRecent(args: Parameters<typeof buildOverlayRecentImpl>[0]): RecentEvent[] { return buildOverlayRecentImpl(args); }
function buildOverlayRecentImpl(args: { sportKey: string; module: AnySportModule; cfg: unknown; lineups: LineupPair; events: readonly EventEnvelope[]; sides: [string, string]; personOf: (id: unknown) => RecentPerson | undefined; window?: number }): RecentEvent[] {
  const active = resolveVoids(args.events);
  const indexed = active.map((e, i) => ({ e, i })).filter(({ e }) => !e.type.startsWith("core.") && !isLineupEventType(e.type));
  const window = indexed.slice(-(args.window ?? OVERLAY_RECENT_WINDOW));
  if (window.length === 0) return [];
  const sideOf = (id: unknown): 0 | 1 | undefined => (id === args.sides[0] ? 0 : id === args.sides[1] ? 1 : undefined);
  const fold = (n: number): unknown => { try { return foldMatch(args.module, args.cfg, args.lineups, active.slice(0, n)); } catch { return null; } };
  const batterFigures = (state: unknown) => (personId: string) => {
    if (args.sportKey !== "cricket" || state === null) return null;
    const inn = activeInnings(state as Parameters<typeof activeInnings>[0]).list.at(-1) as { fine?: { batterRuns: Record<string, number>; batterBalls: Record<string, number> } | null } | undefined;
    const fine = inn?.fine;
    return fine ? { runs: fine.batterRuns[personId] ?? 0, balls: fine.batterBalls[personId] ?? 0 } : null;
  };
  // Prefix fold BEFORE the window's first event, so `fresh` is true only at a transition even at the window's edge.
  let prevState = fold(window[0]!.i);
  let prevPoint = prevState === null ? undefined : probePointState({ ...args, prefix: active.slice(0, window[0]!.i), stateNow: prevState });
  const out: RecentEvent[] = [];
  for (const { e, i } of window) {
    const state = fold(i + 1);
    const project = RECENT_PROJECT[e.type];
    const payload = project ? project((e.payload ?? {}) as Record<string, unknown>, { sideOf, personOf: args.personOf, batterFigures: batterFigures(state) }) : {};
    const derived: RecentDerived = {};
    if (state !== null && prevState !== null) {
      const setWon = diffClosedSets(args.module.summary(prevState).detail, args.module.summary(state).detail);
      if (setWon) derived.setWon = setWon;
    }
    const point = state === null ? undefined : probePointState({ ...args, prefix: active.slice(0, i + 1), stateNow: state });
    if (point) derived.pointState = { ...point, fresh: !(prevPoint && prevPoint.kind === point.kind && prevPoint.side === point.side) };
    out.push({ seq: e.seq, type: e.type, at: e.recordedAt, payload, ...(Object.keys(derived).length ? { derived } : {}) });
    prevState = state; prevPoint = point;
  }
  return out;
}

interface EventRow { id: string; seq: number; type: string; payload: unknown; recorded_at: Date; recorded_by: string | null; voids_event_id: string | null }
const PERSON_KEYS = ["scorer", "person", "striker", "nonStriker", "bowler", "server", "servedBy"] as const;

export async function loadOverlayRecent(sql: Sql, fixture: { id: string; division_id: string; home_entrant_id: string | null; away_entrant_id: string | null }): Promise<RecentEvent[]> {
  const { home_entrant_id: home, away_entrant_id: away } = fixture;
  if (!home || !away) return [];                                                   // bye/TBD: nothing can fold (fold.ts D4a)
  const [division] = await sql<{ sport_key: string; module_version: string; config: unknown; youth: boolean | null; player_name_display: string | null }[]>`
    select d.sport_key, d.module_version, d.config, dv.youth, dv.player_name_display
    from divisions d join public_divisions_v dv on dv.id = d.id
    where d.id = ${fixture.division_id}`;                                        // RE-PIN: data.ts:440 reads dv.youth / dv.player_name_display
  if (!division) return [];
  const rows = await sql<EventRow[]>`
    select id, seq, type, payload, recorded_at, recorded_by, voids_event_id
    from score_events where fixture_id = ${fixture.id} order by seq`;
  if (rows.length === 0) return [];
  const [fx] = await sql<{ config_snapshot: unknown; stage_config: unknown }[]>`
    select f.config_snapshot, s.config as stage_config from fixtures f join stages s on s.id = f.stage_id where f.id = ${fixture.id}`;
  const module = resolveModule(division.sport_key, division.module_version);
  const cfg = resolveFixtureCfg(fx?.config_snapshot, division.config, fx?.stage_config as Record<string, unknown> | null | undefined);
  const lineups = await sql.begin((tx) => loadLineupPair(tx as postgres.TransactionSql, fixture.id, home, away));
  const events: EventEnvelope[] = rows.map((r) => ({ id: r.id, fixtureId: fixture.id, seq: r.seq, type: r.type, payload: r.payload, recordedAt: r.recorded_at.toISOString(), recordedBy: r.recorded_by, ...(r.voids_event_id ? { voids: r.voids_event_id } : {}) }));
  const ids = new Set<string>();
  for (const e of events.slice(-OVERLAY_RECENT_WINDOW * 2)) {
    const p = (e.payload ?? {}) as Record<string, unknown>;
    for (const k of PERSON_KEYS) if (typeof p[k] === "string") ids.add(p[k] as string);
    const w = p.wicket as { out?: unknown } | undefined;
    if (typeof w?.out === "string") ids.add(w.out);
  }
  // D4 RE-PIN: prefer `readPublicLineups` when it resolves every id here; this query is the named fallback (and covers ids outside the lineup).
  const persons = ids.size === 0 ? [] : await sql<{ id: string; full_name: string; consent: { public_name?: boolean } | null }[]>`
    select id, full_name, consent from persons where id = any(${[...ids]}) and merged_into is null`;
  const byId = new Map(persons.map((p) => [p.id, p]));
  const personOf = (id: unknown): RecentPerson | undefined => {
    if (typeof id !== "string") return undefined;
    const p = byId.get(id); if (!p) return undefined;
    const name = resolvePersonDisplayName(p.full_name, p.consent, division.player_name_display, division.youth === true);
    return { name, masked: name !== p.full_name };
  };
  return buildOverlayRecent({ sportKey: division.sport_key, module, cfg, lineups, events, sides: [home, away], personOf });
}
```

  Wire it: in `publicFixture()` (`public.ts:265-297`), after `if (!row) throw …`: `const recent = await loadOverlayRecent(sql, row).catch((err) => { log.warn({ err, fixtureId }, "overlay recent unavailable"); return []; }); return { ...(await withCourtVenueName(row)), recent };` — inside `cached(...)`, so it is computed once per invalidation and `invalidatePublicCache` (`scoring.ts:507`) already busts it on every event. In `getPublicFixture()` (`data.ts:707-740`) add `recent: await loadOverlayRecent(sql, fixtureRow)` to the cached `detail` and to the return type. In `live-score-data.ts` add `recent?: RecentEvent[]` to `LiveFixtureData`. In the W1 overlay page pass `recent` inside `initial`. RE-PIN the logger import (`grep -arn "log.warn(" apps/web/src/server/public-site/*.ts | head -1`); if the public-site layer has none, `console.warn` with the same structured object.

  `scripts/smoke.ts`: beside `:4932`, `check("public fixture JSON carries recent[] (overlay W2)", Array.isArray(v1data<{ recent?: unknown }>(pub).recent))` and, after the `icehockey.goal` send at `:4935`, re-read and `check("recent tip is the goal", recent.at(-1)?.type === "icehockey.goal")`.

- [ ] **Step 5: Run — green.**
  Same command with `--outputFile=/tmp/seazn-env/ovl/w2-t1.json`. Expected: `numTotalTests: 14`, `numPassedTests: 14`, `numFailedTests: 0`, `.testResults[0].name` ends with `.claude/worktrees/stream-overlay/apps/web/src/server/public-site/__tests__/overlay-recent.test.ts`. Then `cd /Users/ashokhein/github/seazn.club/.claude/worktrees/stream-overlay && pnpm openapi:gen && /usr/bin/git status --porcelain openapi` → empty (no `response` schema on the route; nothing drifts). Mutants, each must red the named test: comment out the `resolvePersonDisplayName` call (return `p.full_name`) → "names on recent are the consent resolver's output"; delete `resolveVoids` (use `args.events`) → "a voided event is absent"; make `fresh` always `true` → "the next point (Ad) is not fresh"; delete the `probe.type in eventSchemas` guard → the badminton spy test. Paste the four red/green pairs into the PR.

- [ ] **Step 6: Commit.**
  `cd /Users/ashokhein/github/seazn.club/.claude/worktrees/stream-overlay && /usr/bin/git add apps/web/src/lib/overlay-recent-types.ts apps/web/src/server/public-site/overlay-recent.ts apps/web/src/server/public-site/__tests__/overlay-recent.test.ts apps/web/src/server/usecases/public.ts apps/web/src/server/public-site/data.ts apps/web/src/components/public-site/live-score-data.ts "apps/web/src/app/overlay/fixtures/[fixtureId]/page.tsx" scripts/smoke.ts && /usr/bin/git commit -o apps/web/src/lib/overlay-recent-types.ts apps/web/src/server/public-site/overlay-recent.ts apps/web/src/server/public-site/__tests__/overlay-recent.test.ts apps/web/src/server/usecases/public.ts apps/web/src/server/public-site/data.ts apps/web/src/components/public-site/live-score-data.ts "apps/web/src/app/overlay/fixtures/[fixtureId]/page.tsx" scripts/smoke.ts -m "api(public): the public fixture payload carries recent[] — last 8 ledger events, consent-resolved, with set-won and point-state derived by probing the engine fold" -m "Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>" -m "Claude-Session: https://claude.ai/code/session_01UdUR7dcxassJ4FExpVfRRr"`

---

### Task 2: Moment derivation — `momentsFor` and the per-sport allowlist

**Files:**
- Create: `apps/web/src/lib/overlay-moments.ts`
- Modify: `apps/web/src/dictionaries/{en,es,fr,nl}/public.json` (the `overlay.moment.*` keys — all four in THIS commit, because `MsgFn`'s key type is the generated union and the module will not typecheck without them)
- Regenerate: `apps/web/src/lib/i18n-keys.ts` (`pnpm i18n:gen-keys`)
- Test: `apps/web/src/lib/__tests__/overlay-moments.test.ts`
- Do NOT touch: components, the server helper, the engine.

**Interfaces:**

```ts
// apps/web/src/lib/overlay-moments.ts
import type { MsgFn } from "@/lib/scoring-vocab";
import type { RecentEvent } from "@/lib/overlay-recent-types";

/** Spec "Step two" interface, plus `seq` (React key + queue identity; additive). */
export interface OverlayMoment { kind: string; headline: string; line?: string; tone: "led" | "caution" | "dismissal"; seq: number }
export type MomentRule = (ev: RecentEvent, ctx: { msg: MsgFn; sportKey: string; sides: [string, string] }) => OverlayMoment | null;
/** sportKey → (engine event type | "derived.setWon" | "derived.pointState") → rule. Sports with no entry render nothing, by construction. */
export const MOMENT_RULES: Readonly<Record<string, Readonly<Record<string, MomentRule>>>>;
/** Events with seq > sinceSeq, ascending; one moment per (event, rule) at most. */
export function momentsFor(sportKey: string, recent: readonly RecentEvent[], sinceSeq: number, msg: MsgFn, sides: [string, string]): OverlayMoment[];
export function maxSeq(recent: readonly RecentEvent[] | undefined): number;   // 0 for empty
/** Every dictionary key a rule can emit — the coverage test's input (Task 5). */
export const MOMENT_KEYS: readonly string[];
```

Allowlist (from the modules' declarations read 2026-09-05; the parity test below keeps it honest):

| sport | recorded type → moment | derived |
|---|---|---|
| cricket | `cricket.ball`, `cricket.superover.ball`: `boundary 6` → SIX (led); `boundary 4` → FOUR (led); `wicketKind` → OUT (dismissal), line `"{name} {runs} ({balls}) · {kind}"`; a plain ball → null | — |
| football | `football.goal` → GOAL (led; own goal → OWN GOAL; `penalty` → line "Penalty"); `football.card` → `colour` yellow → YELLOW CARD (caution), red / second_yellow → RED CARD / SECOND YELLOW (dismissal) | — |
| hockey | `hockey.goal` → GOAL; `hockey.suspension.start` → `class` green → GREEN CARD (caution), yellow → YELLOW CARD (caution), red → RED CARD (dismissal) | — |
| icehockey | `icehockey.goal` → GOAL; `icehockey.suspension.start` → PENALTY, line = the class label (minor, bench_minor, double_minor, major, misconduct → caution; game_misconduct, match → dismissal) | — |
| tennis | `tennis.point` with `kind === "ace"` → ACE (led) | `pointState.fresh`: break → BREAK POINT, set → SET POINT, match → MATCH POINT (led); `setWon` → SET {n}, line "{short} {home}–{away}" |
| badminton, tabletennis | — (the rally carries no shot kind) | `pointState.fresh`: set → GAME POINT, match → MATCH POINT; `setWon` → GAME {n} (unit from `GAME_UNIT_SPORTS`) |
| volleyball | — | `pointState.fresh`: set → SET POINT, match → MATCH POINT; `setWon` → SET {n} — **owner answer 21 (Q10), 2026-09-06: "Ok"**. Same probe as the racket sports; the spec's set-won-only line is superseded |
| boardgame, carrom, generic | none | none |

Sides' short names: `momentsFor` takes `sides: [string, string]` (the `short` W1's `overlayModel` already computes) so the set-won line can say who.

- [ ] **Step 1: Failing tests** — `apps/web/src/lib/__tests__/overlay-moments.test.ts`. Fold REAL events through the REAL modules to build `recent` (use Task 1's pure `buildOverlayRecent` with `defaultLineupPair` ids and a `personOf` stub) — never a hand-typed `recent` for the positive cases. `msg` = `(key, vars) => key + JSON.stringify(vars ?? {})` so assertions pin keys and params, not English.

```ts
import { describe, expect, it } from "vitest";
import { cricket } from "@seazn/engine/sports/cricket";
import { football } from "@seazn/engine/sports/football";
import { hockey } from "@seazn/engine/sports/hockey";                    // hockey/index.ts exports `hockey` only
import { icehockey } from "@seazn/engine/sports/icehockey";              // icehockey/index.ts exports `icehockey` only
import { tennis } from "@seazn/engine/sports/tennis";
import { badminton, tabletennis, volleyball } from "@seazn/engine/sports/setbased";
import { boardgame } from "@seazn/engine/sports/boardgame";
import { carrom } from "@seazn/engine/sports/carrom";
import { generic } from "@seazn/engine/sports/generic";
import { MOMENT_RULES, momentsFor, maxSeq } from "../overlay-moments";
import { buildOverlayRecent } from "@/server/public-site/overlay-recent";  // pure export; the file's `server-only` marker is stubbed under vitest (vitest.config.ts alias)
import { defaultLineupPair, makeEnvelope } from "@seazn/engine/testkit";

const msg = (key: string, vars?: Record<string, string | number>) => `${key}${vars ? JSON.stringify(vars) : ""}`;
const SIDES: [string, string] = ["H", "A"];
const MODULES = { cricket, football, hockey, icehockey, tennis, badminton, tabletennis, volleyball, boardgame, carrom, generic } as const;

describe("MOMENT_RULES is derived from the modules' own declarations", () => {
  for (const [key, mod] of Object.entries(MODULES)) {
    it(`${key}: every recorded-event key in the allowlist is a key of the module's eventSchemas`, () => {
      const rules = Object.keys(MOMENT_RULES[key] ?? {}).filter((k) => !k.startsWith("derived."));
      for (const type of rules) expect(Object.keys(mod.eventSchemas ?? {}), `${key} allowlist names undeclared type ${type}`).toContain(type);
    });
  }
  it("boardgame, carrom and generic have NO entries", () => {
    for (const key of ["boardgame", "carrom", "generic"]) expect(Object.keys(MOMENT_RULES[key] ?? {})).toEqual([]);
  });
  it("an unlisted type yields nothing and does not throw", () => {
    expect(momentsFor("football", [{ seq: 9, type: "football.shot", at: "", payload: {} }], 0, msg, SIDES)).toEqual([]);
    expect(momentsFor("some.future.sport", [{ seq: 9, type: "x.y", at: "", payload: {} }], 0, msg, SIDES)).toEqual([]);
  });
});

describe("cricket", () => {
  const lineups = defaultLineupPair(cricket.positions);
  const cfg = /* RE-PIN: cricket.variants.t20 parsed through the module's config schema, as view-model.test.ts does for generic */;
  const base = { over: 0, ballInOver: 1, striker: "H-p1", nonStriker: "H-p2", bowler: "A-p11" };
  const ledger = [
    makeEnvelope(1, { type: "cricket.toss", payload: { wonBy: "H", elected: "bat" } }),
    makeEnvelope(2, { type: "core.start", payload: {} }),
    makeEnvelope(3, { type: "cricket.ball", payload: { ...base, runs: { bat: 6 }, boundary: 6 } }),
    makeEnvelope(4, { type: "cricket.ball", payload: { ...base, ballInOver: 2, runs: { bat: 1 } } }),
    makeEnvelope(5, { type: "cricket.ball", payload: { ...base, ballInOver: 3, striker: "H-p2", nonStriker: "H-p1", runs: { bat: 4 }, boundary: 4 } }),
    makeEnvelope(6, { type: "cricket.ball", payload: { ...base, ballInOver: 4, striker: "H-p2", nonStriker: "H-p1", runs: { bat: 0 }, wicket: { kind: "bowled", out: "H-p2", bowlerCredited: true, incoming: "H-p3" } } }),
  ];
  const recent = buildOverlayRecent({ sportKey: "cricket", module: cricket, cfg, lineups, events: ledger, sides: SIDES, personOf: (id) => (id === "H-p2" ? { name: "H. Two", masked: true } : undefined) });
  it("SIX, FOUR and OUT fire; the single is silent; order is ledger order", () => {
    const got = momentsFor("cricket", recent, 0, msg, SIDES);
    expect(got.map((m) => [m.seq, m.kind, m.tone])).toEqual([[3, "six", "led"], [5, "four", "led"], [6, "wicket", "dismissal"]]);
    expect(got[0]!.headline).toBe("overlay.moment.six");
  });
  it("OUT carries the dismissed batter's consent-resolved name, figures from the fold, and the kind key", () => {
    const out = momentsFor("cricket", recent, 5, msg, SIDES)[0]!;
    expect(out.line).toBe(`overlay.moment.batterLine${JSON.stringify({ name: "H. Two", runs: 4, balls: 2, kind: "overlay.moment.wicket.bowled" })}`);
  });
  it("seq already seen yields nothing; the boundary is sinceSeq EXCLUSIVE", () => {
    expect(momentsFor("cricket", recent, 6, msg, SIDES)).toEqual([]);
    expect(momentsFor("cricket", recent, 5, msg, SIDES).map((m) => m.seq)).toEqual([6]);
  });
  it("a super-over boundary uses the same rule", () => { /* cricket.superover.ball boundary 6 after a tie → six */ });
});

describe("football / hockey / ice hockey", () => {
  it("goal → GOAL led with scorer line; own goal → ownGoal key; penalty adds the penalty line", () => {});
  it("yellow → caution, red and second_yellow → dismissal; the headline key is per colour", () => {});
  it("hockey green/yellow → caution, red → dismissal; ice hockey minor → caution with class line, match → dismissal", () => {
    // build through buildOverlayRecent with hockey.suspension.start { by: "H", person: "H-p3", class: "green" } etc.
  });
});

describe("racket sports (derived)", () => {
  it("tennis: ace → ACE; a fresh break point → BREAK POINT once; the saved-then-regained point is a NEW moment; set won → SET 1 with the short and score", () => {
    // ledger driven to 30–40 on home serve (break, fresh) → 40–40 (nothing) → Ad away (break, fresh again) — two break-point moments, seqs differ
  });
  it("tennis: a set point that is also match point reads MATCH POINT only", () => {});
  it("badminton: 20–19 → GAME POINT (unit from GAME_UNIT_SPORTS); game won → GAME 1", () => {});
  it("volleyball: 24–23 → SET POINT, a set point that also wins the match → MATCH POINT, set won → SET 1 (owner answer 21 / Q10)", () => {
    // Drive a real volleyball ledger through buildOverlayRecent to 24–23 and
    // assert `overlay.moment.setPoint` — NOT `gamePoint`: the differential that
    // proves the unit comes from GAME_UNIT_SPORTS rather than from "it is a
    // set-based sport". Then a fifth-set 14–13 for MATCH POINT, and the set
    // close for SET 1. A test that only asserted "some moment fires" would
    // pass with badminton's keys wired in by mistake.
  });
  it("a non-fresh pointState yields nothing even with a new seq", () => {
    // hand-typed recent is acceptable for this NEGATIVE case: [{ seq: 12, type: "tennis.point", at: "", payload: {}, derived: { pointState: { kind: "match", side: 0, fresh: false } } }] → []
  });
});

describe("maxSeq", () => { it("0 for empty/undefined; the max otherwise", () => {}); });
```

- [ ] **Step 2: Run — expect failures** (`../overlay-moments` unresolved).
  `cd /Users/ashokhein/github/seazn.club/.claude/worktrees/stream-overlay/apps/web && DATABASE_URL= pnpm exec vitest run src/lib/__tests__/overlay-moments.test.ts --reporter=json --outputFile=/tmp/seazn-env/ovl/w2-t2-red.json`

- [ ] **Step 3: Implement** `overlay-moments.ts`:

```ts
import type { MessageKey } from "@/lib/i18n-runtime";              // RE-PIN: the generated-union key type MsgFn takes (scoring-vocab.ts:1147)
const GAME_UNIT = new Set(["badminton", "tabletennis"]);            // RE-PIN: export GAME_UNIT_SPORTS from lib/public-site.ts:281 and import it instead of restating
const name = (ev: RecentEvent) => ev.payload.person?.name;

const ball: MomentRule = (ev, { msg }) => {
  const p = ev.payload;
  if (p.wicketKind) {
    const kind = msg(`overlay.moment.wicket.${p.wicketKind}` as MessageKey);
    const line = name(ev) && p.batterRuns !== undefined && p.batterBalls !== undefined
      ? msg("overlay.moment.batterLine", { name: name(ev)!, runs: p.batterRuns, balls: p.batterBalls, kind })
      : kind;
    return { kind: "wicket", headline: msg("overlay.moment.out"), line, tone: "dismissal", seq: ev.seq };
  }
  if (p.boundary === 6) return { kind: "six", headline: msg("overlay.moment.six"), ...(name(ev) ? { line: name(ev) } : {}), tone: "led", seq: ev.seq };
  if (p.boundary === 4) return { kind: "four", headline: msg("overlay.moment.four"), ...(name(ev) ? { line: name(ev) } : {}), tone: "led", seq: ev.seq };
  return null;
};
const goal: MomentRule = (ev, { msg }) => ({
  kind: "goal", tone: "led", seq: ev.seq,
  headline: msg(ev.payload.ownGoal ? "overlay.moment.ownGoal" : "overlay.moment.goal"),
  ...(ev.payload.penalty ? { line: msg("overlay.moment.penalty") } : name(ev) ? { line: name(ev) } : {}),
});
const CARD_TONE: Record<string, OverlayMoment["tone"]> = { yellow: "caution", green: "caution", red: "dismissal", second_yellow: "dismissal" };
const card = (field: "colour" | "class"): MomentRule => (ev, { msg }) => {
  const c = ev.payload[field]; if (!c) return null;
  const tone = CARD_TONE[c]; if (!tone) return null;                                    // an undeclared colour renders nothing
  return { kind: `card.${c}`, headline: msg(`overlay.moment.card.${c}` as MessageKey), ...(name(ev) ? { line: name(ev) } : {}), tone, seq: ev.seq };
};
const PENALTY_TONE: Record<string, OverlayMoment["tone"]> = { minor: "caution", bench_minor: "caution", double_minor: "caution", major: "caution", misconduct: "caution", game_misconduct: "dismissal", match: "dismissal" };
const penalty: MomentRule = (ev, { msg }) => {
  const c = ev.payload.class; const tone = c ? PENALTY_TONE[c] : undefined; if (!c || !tone) return null;
  return { kind: `penalty.${c}`, headline: msg("overlay.moment.penaltyHeadline"), line: [msg(`overlay.moment.penaltyClass.${c}` as MessageKey), name(ev)].filter(Boolean).join(" · "), tone, seq: ev.seq };
};
const ace: MomentRule = (ev, { msg }) => (ev.payload.kind === "ace" ? { kind: "ace", headline: msg("overlay.moment.ace"), ...(name(ev) ? { line: name(ev) } : {}), tone: "led", seq: ev.seq } : null);
const pointState: MomentRule = (ev, { msg, sportKey }) => {
  const ps = ev.derived?.pointState; if (!ps || !ps.fresh) return null;
  const key = ps.kind === "match" ? "overlay.moment.matchPoint" : ps.kind === "break" ? "overlay.moment.breakPoint" : GAME_UNIT.has(sportKey) ? "overlay.moment.gamePoint" : "overlay.moment.setPoint";
  return { kind: `point.${ps.kind}`, headline: msg(key), tone: "led", seq: ev.seq };
};
const setWon: MomentRule = (ev, { msg, sportKey, sides }) => {
  const s = ev.derived?.setWon; if (!s) return null;
  return { kind: "setWon", headline: msg(GAME_UNIT.has(sportKey) ? "overlay.moment.gameWon" : "overlay.moment.setWon", { n: s.set }), line: msg("overlay.moment.setWonLine", { short: sides[s.winner], home: s.home, away: s.away }), tone: "led", seq: ev.seq };
};
export const MOMENT_RULES = {
  cricket: { "cricket.ball": ball, "cricket.superover.ball": ball },
  football: { "football.goal": goal, "football.card": card("colour") },
  hockey: { "hockey.goal": goal, "hockey.suspension.start": card("class") },
  icehockey: { "icehockey.goal": goal, "icehockey.suspension.start": penalty },
  tennis: { "tennis.point": ace, "derived.pointState": pointState, "derived.setWon": setWon },
  badminton: { "derived.pointState": pointState, "derived.setWon": setWon },
  tabletennis: { "derived.pointState": pointState, "derived.setWon": setWon },
  // Owner answer 21 (Q10), 2026-09-06: "Ok". Volleyball gets set point and
  // match point alongside its set-won moment, on the SAME `pointState` probe
  // the racket sports use — `GAME_UNIT_SPORTS` does not contain volleyball, so
  // `pointState` picks `overlay.moment.setPoint` (not gamePoint) and `setWon`
  // picks `overlay.moment.setWon` (not gameWon) with no per-sport branch.
  volleyball: { "derived.pointState": pointState, "derived.setWon": setWon },
  boardgame: {}, carrom: {}, generic: {},
} as const satisfies Record<string, Record<string, MomentRule>>;

export function momentsFor(sportKey, recent, sinceSeq, msg, sides): OverlayMoment[] {
  const rules = MOMENT_RULES[sportKey as keyof typeof MOMENT_RULES] as Record<string, MomentRule> | undefined;
  if (!rules) return [];
  const out: OverlayMoment[] = [];
  for (const ev of [...recent].sort((a, b) => a.seq - b.seq)) {
    if (ev.seq <= sinceSeq) continue;
    const ctx = { msg, sportKey, sides };
    for (const rule of [rules[ev.type], ev.derived?.setWon ? rules["derived.setWon"] : undefined, ev.derived?.pointState ? rules["derived.pointState"] : undefined]) {
      const m = rule?.(ev, ctx); if (m) out.push(m);
    }
  }
  return out;
}
```

  Order within one event: recorded first (ACE), then set won, then point state — a set-closing point that also opens a match point shows the set first. `MOMENT_KEYS` enumerates: six, four, out, batterLine, `wicket.<k>` for each `CricketWicket` kind, goal, ownGoal, penalty, `card.{yellow,red,second_yellow,green}`, penaltyHeadline, `penaltyClass.<c>` for each ice-hockey class, ace, breakPoint, setPoint, gamePoint, matchPoint, setWon, gameWon, setWonLine. Derive the enum lists in the module from the engine where it exports them (`CricketWicket.shape.kind.options` via `@seazn/engine/sports/cricket`; `CardColor.options` — RE-PIN whether `football/index.ts` exports it, else read `FOOTBALL_EVENT_SCHEMAS["football.card"]`); the ice-hockey classes come from the module's parsed default config (RE-PIN the entry point: `grep -an "configSchema\|parseConfig" packages/engine/src/sport/module.ts`).

  Dictionary keys (English; write es/fr/nl in the same commit with the sport's own vocabulary — "SIX"/"FOUR"/"OUT"/"lbw" stay English in all four, as cricket broadcasters in those languages do; "GOAL" → "GOL"/"BUT"/"GOAL"; "MATCH POINT" → "PUNTO DE PARTIDO"/"BALLE DE MATCH"/"MATCHPUNT"; etc.):

```json
"overlay.moment.six": "SIX",
"overlay.moment.four": "FOUR",
"overlay.moment.out": "OUT",
"overlay.moment.batterLine": "{name} {runs} ({balls}) · {kind}",
"overlay.moment.wicket.bowled": "b", "overlay.moment.wicket.caught": "c", "overlay.moment.wicket.lbw": "lbw",
"overlay.moment.wicket.runout": "run out", "overlay.moment.wicket.stumped": "st", "overlay.moment.wicket.hitwicket": "hit wicket",
"overlay.moment.wicket.retired": "retired out", "overlay.moment.wicket.obstructed": "obstructing the field",
"overlay.moment.wicket.timedout": "timed out", "overlay.moment.wicket.hitballtwice": "hit the ball twice",
"overlay.moment.goal": "GOAL", "overlay.moment.ownGoal": "OWN GOAL", "overlay.moment.penalty": "Penalty",
"overlay.moment.card.yellow": "YELLOW CARD", "overlay.moment.card.red": "RED CARD", "overlay.moment.card.second_yellow": "SECOND YELLOW", "overlay.moment.card.green": "GREEN CARD",
"overlay.moment.penaltyHeadline": "PENALTY",
"overlay.moment.penaltyClass.minor": "Minor", "overlay.moment.penaltyClass.bench_minor": "Bench minor", "overlay.moment.penaltyClass.double_minor": "Double minor",
"overlay.moment.penaltyClass.major": "Major", "overlay.moment.penaltyClass.misconduct": "Misconduct", "overlay.moment.penaltyClass.game_misconduct": "Game misconduct", "overlay.moment.penaltyClass.match": "Match penalty",
"overlay.moment.ace": "ACE",
"overlay.moment.breakPoint": "BREAK POINT", "overlay.moment.setPoint": "SET POINT", "overlay.moment.gamePoint": "GAME POINT", "overlay.moment.matchPoint": "MATCH POINT",
"overlay.moment.setWon": "SET {n}", "overlay.moment.gameWon": "GAME {n}", "overlay.moment.setWonLine": "{short} {home}–{away}"
```

  Then `cd /Users/ashokhein/github/seazn.club/.claude/worktrees/stream-overlay && pnpm i18n:gen-keys && pnpm i18n:check` — `i18n-keys.ts` must change; parity must pass.

- [ ] **Step 4: Run — green.** `--outputFile=/tmp/seazn-env/ovl/w2-t2.json`; expected `numTotalTests: 22` (11 parity + 11 behaviour; count from the file), all passed, path under the worktree. `cd …/apps/web && pnpm typecheck` clean (the union now carries the keys). Mutants: delete the `wicketKind` branch of `ball` → "SIX, FOUR and OUT fire" reds; change `ev.seq <= sinceSeq` to `<` → "seq already seen yields nothing" reds; remove the `!ps.fresh` return → "a non-fresh pointState yields nothing" reds; add `"football.shot": goal` → the football parity test STAYS green (it is declared) — so ALSO add a fixture-free assertion that `MOMENT_RULES.football` has exactly the two keys the spec allowlists, and confirm the mutant reds it.

- [ ] **Step 5: Commit.**
  `cd /Users/ashokhein/github/seazn.club/.claude/worktrees/stream-overlay && /usr/bin/git add apps/web/src/lib/overlay-moments.ts apps/web/src/lib/__tests__/overlay-moments.test.ts apps/web/src/dictionaries/en/public.json apps/web/src/dictionaries/es/public.json apps/web/src/dictionaries/fr/public.json apps/web/src/dictionaries/nl/public.json apps/web/src/lib/i18n-keys.ts && /usr/bin/git commit -o apps/web/src/lib/overlay-moments.ts apps/web/src/lib/__tests__/overlay-moments.test.ts apps/web/src/dictionaries/en/public.json apps/web/src/dictionaries/es/public.json apps/web/src/dictionaries/fr/public.json apps/web/src/dictionaries/nl/public.json apps/web/src/lib/i18n-keys.ts -m "overlay: momentsFor — per-sport allowlist keyed by each module's declared event types; overlay.moment.* in en/es/fr/nl, keys regenerated" -m "Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>" -m "Claude-Session: https://claude.ai/code/session_01UdUR7dcxassJ4FExpVfRRr"`

---

### Task 3: The cricket bar's batter-and-bowler line

**Files:**
- Create: `apps/web/src/lib/overlay-cricket.ts`
- Modify: `apps/web/src/lib/overlay-model.ts` (W1; `detail` for cricket)
- Modify (variant B/C only): `apps/web/src/server/public-site/overlay-recent.ts`, `apps/web/src/lib/overlay-recent-types.ts`, `apps/web/src/components/public-site/live-score-data.ts`
- Test: `apps/web/src/lib/__tests__/overlay-cricket.test.ts`
- Do NOT touch: the bar/bug components' layout (W1 already renders `detail[]` as the second band), the engine, the scorecard fold.

**Interfaces:**

```ts
// apps/web/src/lib/overlay-cricket.ts
/** Structurally a SUBSET of spectator W1's `CricketView.live` (D2) — so the merged payload satisfies it with no adapter. */
export interface OverlayCricketLiveInput {
  striker: { personId: string; name: string } | null;
  nonStriker: { personId: string; name: string } | null;
  bowler: { personId: string; name: string } | null;
  batters: { person: { personId: string; name: string }; runs: number; balls: number }[];
  bowling: { person: { personId: string; name: string }; overs: string; runs: number; wickets: number; maidens?: number | null }[];
  thisOver: string[];                      // glyph strings: "1", "4", "6", "W", "wd", "nb+2", "·"
}
/** [batters line, bowler line] — [] when nothing is at the crease (between innings, band ≤ 2, not started). */
export function cricketDetail(live: OverlayCricketLiveInput | null | undefined, msg: MsgFn): string[];
/** Variant C adapter: the engine's folded state → the same input, names via personOf. Also the unit test's producer. */
export function liveFromFoldState(state: unknown, personOf: (id: string) => string, thisOverGlyphs: string[]): OverlayCricketLiveInput | null;
```

Output shape (notation stays notation; only the striker marker's `title` and the "this over" label are dictionary strings):
- line 1: `"Sharma* 34 (21) · Kohli 12 (9)"` — striker first, `*` marker (`overlay.cricket.strikerMark` = "*"; its accessible title `overlay.cricket.onStrike`), then the non-striker; a batter absent from `batters` (band 2) still shows the name with no figures.
- line 2: `"Bumrah 2.3-0-14-1 · this over 1 4 · W 0"` — `overs-maidens-runs-wickets` (`maidens` null → `overs-runs-wickets`), then `overlay.cricket.thisOver` = "this over" followed by the glyphs joined by spaces; empty `thisOver` drops that segment.

- [ ] **Step 0: RE-PIN and choose the variant.** In the rebased tree: `grep -an "match_centre" apps/web/src/components/public-site/live-score-data.ts` and `grep -an "live:" apps/web/src/server/public-site/match-centre-schema.ts`. **A** (D1 and D2 present, and `publicFixture()` carries `match_centre` — D7): `cricketDetail(data.match_centre?.cricket?.live, msg)`; no server change. **B** (D1 absent, D3 present): Task 1's helper gains `cricketLive: OverlayCricketLive | null` computed from `deriveCricketScorecard({ events: active, cfg, lineups }).live` + `innings.at(-1).batting/bowling` with `personOf`; `LiveFixtureData.overlayCricket?`. **C** (D1 and D3 absent): the same field from `liveFromFoldState(foldMatch(cricket, cfg, lineups, active), personOf, glyphs)` where `glyphs` come from the current over's `cricket.ball` payloads in the window (runs → `String(bat)`, `boundary` → "4"/"6", `wicket` → "W", extras `wide` → "wd", `noball` → `nb+n`, dot → "·"). Record the choice in `_INDEX.md`. The code below is A plus the C adapter (which the unit test exercises regardless, so the fallback is never inert).

- [ ] **Step 1: Failing tests** — `apps/web/src/lib/__tests__/overlay-cricket.test.ts`, driven by a REAL ledger through the REAL fold:

```ts
import { foldMatch } from "@seazn/engine/core";
import { cricket, activeInnings } from "@seazn/engine/sports/cricket";
import { defaultLineupPair, makeEnvelope } from "@seazn/engine/testkit";
import { cricketDetail, liveFromFoldState, type OverlayCricketLiveInput } from "../overlay-cricket";
import type { CricketViewT } from "@/server/public-site/match-centre-schema";   // variant A only: the type-level seam pin
const msg = (k: string) => ({ "overlay.cricket.strikerMark": "*", "overlay.cricket.thisOver": "this over" } as Record<string, string>)[k] ?? k;
const names: Record<string, string> = { "H-p1": "Sharma", "H-p2": "Kohli", "H-p3": "Iyer", "A-p11": "Bumrah" };

describe("cricketDetail from a real fold", () => {
  const lineups = defaultLineupPair(cricket.positions);
  const cfg = /* RE-PIN: t20 parsed */;
  const base = { over: 0, ballInOver: 1, striker: "H-p1", nonStriker: "H-p2", bowler: "A-p11" };
  const events = [
    makeEnvelope(1, { type: "cricket.toss", payload: { wonBy: "H", elected: "bat" } }),
    makeEnvelope(2, { type: "core.start", payload: {} }),
    makeEnvelope(3, { type: "cricket.ball", payload: { ...base, runs: { bat: 1 } } }),                       // Sharma 1(1), strike to Kohli
    makeEnvelope(4, { type: "cricket.ball", payload: { ...base, ballInOver: 2, striker: "H-p2", nonStriker: "H-p1", runs: { bat: 4 }, boundary: 4 } }),
    makeEnvelope(5, { type: "cricket.ball", payload: { ...base, ballInOver: 3, striker: "H-p2", nonStriker: "H-p1", runs: { bat: 0, extras: { kind: "wide", runs: 1 } } } }),
    makeEnvelope(6, { type: "cricket.ball", payload: { ...base, ballInOver: 3, striker: "H-p2", nonStriker: "H-p1", runs: { bat: 0 }, wicket: { kind: "bowled", out: "H-p2", bowlerCredited: true, incoming: "H-p3" } } }),
  ];
  const state = foldMatch(cricket, cfg, lineups, events);
  const live = liveFromFoldState(state, (id) => names[id] ?? id, ["1", "4", "wd", "W"]);
  it("striker carries the marker and comes first; figures are the fold's, not typed here", () => {
    const fine = (activeInnings(state as never).list.at(-1) as { fine: { striker: string; batterRuns: Record<string, number>; batterBalls: Record<string, number> } }).fine;
    const [batters] = cricketDetail(live, msg as never);
    expect(batters).toBe(`${names[fine.striker]}* ${fine.batterRuns[fine.striker] ?? 0} (${fine.batterBalls[fine.striker] ?? 0}) · Sharma 1 (1)`);
    expect(fine.striker).toBe("H-p3");                                // the incoming batter is on strike after the wicket
  });
  it("bowler line is O-M-R-W from the fold plus this over's glyphs", () => {
    const [, bowler] = cricketDetail(live, msg as never);
    expect(bowler).toBe("Bumrah 0.3-0-6-1 · this over 1 4 wd W");
  });
  it("null live → []; a live block with no striker (between innings) → []", () => {
    expect(cricketDetail(null, msg as never)).toEqual([]);
    expect(cricketDetail({ ...live!, striker: null, nonStriker: null }, msg as never)).toEqual([]);
  });
  it("band 2 (player lines, no ball-by-ball): names without figures, no this-over segment", () => { /* batters: [] , thisOver: [] */ });
  it("type-level seam pin (variant A): W1's CricketView.live satisfies the input type", () => {
    const _pin: OverlayCricketLiveInput = null as unknown as NonNullable<CricketViewT["live"]>;   // compiles or the seam moved
    expect(_pin).toBeNull();
  });
});
```

- [ ] **Step 2: Run — expect failures.** `cd …/apps/web && DATABASE_URL= pnpm exec vitest run src/lib/__tests__/overlay-cricket.test.ts --reporter=json --outputFile=/tmp/seazn-env/ovl/w2-t3-red.json`.

- [ ] **Step 3: Implement.** `liveFromFoldState`: `const inn = activeInnings(state).list.at(-1)`; `fine = inn?.fine`; null when `!fine || (!fine.striker && !fine.nonStriker)`; batters from `fine.batterRuns/batterBalls` for the two at the crease; bowler from `fine.currentBowler` with `overs = \`${Math.floor(balls / bpo)}.${balls % bpo}\`` where `bpo` = `cfg.ballsPerOver` (RE-PIN the cfg field name; `cricket.test.ts:81` `balls(type, specs, bpo = 6)`), `runs = fine.bowlerRuns[b] ?? 0`, `wickets = fine.bowlerWickets[b] ?? 0`, `maidens: null` (the state does not track maidens — the fold D3 does; variant B fills it). `cricketDetail` composes the two lines exactly as specified. In `overlay-model.ts`: `detail: input.sportKey === "cricket" ? cricketDetail(cricketLiveOf(input.data), msg) : detail` where `cricketLiveOf(data) = data.match_centre?.cricket?.live ?? data.overlayCricket ?? null` (whichever fields exist after Step 0; do not reference a field that does not exist on the merged type).

- [ ] **Step 4: Run — green.** Expected `numTotalTests: 6`, all passed. Re-run the W1 `overlay-model` unit suite (`src/lib/__tests__/overlay-model.test.ts`, RE-PIN) — its cricket case asserted `detail: []` in step one; update THAT assertion to the two lines built from its own fixture (never weaken to "array"). Mutant: swap striker and non-striker in `cricketDetail` → "striker carries the marker and comes first" reds.

- [ ] **Step 5: Commit.**
  `cd /Users/ashokhein/github/seazn.club/.claude/worktrees/stream-overlay && /usr/bin/git add apps/web/src/lib/overlay-cricket.ts apps/web/src/lib/__tests__/overlay-cricket.test.ts apps/web/src/lib/overlay-model.ts apps/web/src/lib/__tests__/overlay-model.test.ts && /usr/bin/git commit -o apps/web/src/lib/overlay-cricket.ts apps/web/src/lib/__tests__/overlay-cricket.test.ts apps/web/src/lib/overlay-model.ts apps/web/src/lib/__tests__/overlay-model.test.ts -m "overlay(cricket): the bar's second band carries the batters at the crease and the bowler's figures, from the match-centre live block" -m "Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>" -m "Claude-Session: https://claude.ai/code/session_01UdUR7dcxassJ4FExpVfRRr"`
  (Variant B/C adds the three server/type files to both lists and the subject "…from the scorecard fold" / "…from the folded state".)

---

### Task 4: The slab — component, motion, queue, stage wiring, e2e

**Files:**
- Create: `apps/web/src/components/overlay/moment-timing.ts`, `moment-queue.ts`, `use-moment-queue.ts`, `overlay-moment.tsx`
- Modify: `apps/web/src/components/overlay/overlay-stage.tsx` (W1), `apps/web/src/app/globals.css`
- Test: `apps/web/src/components/overlay/__tests__/moment-queue.test.ts` (pure reducer; vitest has no DOM, so the hook is thin and untested here — the e2e proves the wiring)
- Test: `apps/web/e2e/stream-overlay.spec.ts` (W1's file; append `describe("moments")`)
- Do NOT touch: `overlay-bar.tsx` / `overlay-bug.tsx` beyond mounting the slab slot W1 left (RE-PIN: `grep -an "moment\|slot" apps/web/src/components/overlay/overlay-b*.tsx`), the pad's `.pad-*` classes, the score-tick / side-change / live-dot motions from W1.

**Interfaces:**

```ts
// moment-timing.ts — the ONE place the numbers live; the e2e imports them for its budget
export const OVERLAY_MOMENT_HOLD_MS = 4_000;
export const OVERLAY_MOMENT_FOLD_MS = 250;

// moment-queue.ts — pure
export type Phase = "in" | "hold" | "out";
export interface MomentQueueState { current: OverlayMoment | null; phase: Phase; queue: OverlayMoment[]; deadline: number | null }
export type QueueAction =
  | { type: "enqueue"; moments: OverlayMoment[]; now: number; foldMs: number; holdMs: number }
  | { type: "tick"; now: number; foldMs: number; holdMs: number };
export const INITIAL: MomentQueueState;
export function momentQueueReducer(state: MomentQueueState, action: QueueAction): MomentQueueState;
export function nextDeadline(state: MomentQueueState): number | null;

// use-moment-queue.ts — thin: useReducer + ONE setTimeout armed to nextDeadline (no interval, no rAF)
export function useMomentQueue(incoming: OverlayMoment[], opts: { reducedMotion: boolean }): { current: OverlayMoment | null; phase: Phase };

// overlay-moment.tsx
export function OverlayMomentSlab(props: { moment: OverlayMoment; phase: Phase; placement: "bar" | "bug" }): JSX.Element;
// renders <div data-testid="overlay-moment" data-kind data-tone data-phase data-seq class="ovl-slab ovl-slab--{placement} ovl-slab--{phase}"><span class="ovl-slab__headline">…</span>{line && <span class="ovl-slab__line">…</span>}</div>
```

Reducer semantics: `enqueue` appends (dedupes on `seq`+`kind`); when `current` is null it promotes the head to `phase: "in"` with `deadline = now + foldMs`; `tick` at or past the deadline advances `in → hold (now + holdMs) → out (now + foldMs) → next head or idle`. `reducedMotion` passes `foldMs: 0`, so the phases still exist (the DOM still shows `in`/`hold`/`out` for one tick) but nothing animates.

- [ ] **Step 1: Failing reducer tests** — `apps/web/src/components/overlay/__tests__/moment-queue.test.ts`:

```ts
import { INITIAL, momentQueueReducer as r, nextDeadline } from "../moment-queue";
import { OVERLAY_MOMENT_FOLD_MS, OVERLAY_MOMENT_HOLD_MS } from "../moment-timing";
const m = (seq: number, kind = "goal") => ({ seq, kind, headline: kind.toUpperCase(), tone: "led" as const });
const T = { foldMs: OVERLAY_MOMENT_FOLD_MS, holdMs: OVERLAY_MOMENT_HOLD_MS };

it("the default hold is four seconds and the fold a quarter — pinned on the DEFAULTS, not a live override", () => {
  expect(OVERLAY_MOMENT_HOLD_MS).toBe(4_000); expect(OVERLAY_MOMENT_FOLD_MS).toBe(250);
});
it("idle + enqueue → in with deadline now+fold; tick past it → hold with deadline now+hold; then out; then idle", () => {
  let s = r(INITIAL, { type: "enqueue", moments: [m(1)], now: 0, ...T });
  expect(s).toMatchObject({ current: m(1), phase: "in", deadline: 250 });
  s = r(s, { type: "tick", now: 250, ...T }); expect(s).toMatchObject({ phase: "hold", deadline: 4_250 });
  s = r(s, { type: "tick", now: 4_000, ...T }); expect(s.phase).toBe("hold");                       // early tick is a no-op
  s = r(s, { type: "tick", now: 4_250, ...T }); expect(s).toMatchObject({ phase: "out", deadline: 4_500 });
  s = r(s, { type: "tick", now: 4_500, ...T }); expect(s).toEqual(INITIAL);
});
it("FIFO: two moments enqueued together show in order, the second starts only after the first's out", () => {
  let s = r(INITIAL, { type: "enqueue", moments: [m(1, "goal"), m(2, "card.yellow")], now: 0, ...T });
  expect(s.queue.map((q) => q.seq)).toEqual([2]);
  for (const now of [250, 4_250, 4_500]) s = r(s, { type: "tick", now, ...T });
  expect(s).toMatchObject({ current: m(2, "card.yellow"), phase: "in" });
});
it("a moment arriving DURING a hold queues behind it (never interrupts)", () => {});
it("the same (seq, kind) enqueued twice is shown once", () => {});
it("reduced motion: foldMs 0 → in and out are zero-length, hold unchanged", () => {
  let s = r(INITIAL, { type: "enqueue", moments: [m(1)], now: 0, foldMs: 0, holdMs: 4_000 });
  s = r(s, { type: "tick", now: 0, foldMs: 0, holdMs: 4_000 }); expect(s).toMatchObject({ phase: "hold", deadline: 4_000 });
});
it("nextDeadline is null when idle and the state's deadline otherwise", () => {});
```

- [ ] **Step 2: Run — expect failures.** `cd …/apps/web && DATABASE_URL= pnpm exec vitest run src/components/overlay/__tests__/moment-queue.test.ts --reporter=json --outputFile=/tmp/seazn-env/ovl/w2-t4-red.json`.

- [ ] **Step 3: Implement** reducer, hook, slab, CSS, stage wiring.

  Hook (no per-frame timer — one timeout re-armed from `nextDeadline`):

```ts
export function useMomentQueue(incoming: OverlayMoment[], opts: { reducedMotion: boolean }) {
  const timing = { holdMs: OVERLAY_MOMENT_HOLD_MS, foldMs: opts.reducedMotion ? 0 : OVERLAY_MOMENT_FOLD_MS };
  const [state, dispatch] = useReducer(momentQueueReducer, INITIAL);
  useEffect(() => { if (incoming.length) dispatch({ type: "enqueue", moments: incoming, now: Date.now(), ...timing }); }, [incoming]);   // `incoming` is a fresh array only when momentsFor returned something (stage memoises [])
  useEffect(() => {
    const at = nextDeadline(state); if (at === null) return;
    const id = setTimeout(() => dispatch({ type: "tick", now: Date.now(), ...timing }), Math.max(0, at - Date.now()));
    return () => clearTimeout(id);
  }, [state, timing.foldMs]);
  return { current: state.current, phase: state.phase };
}
```

  Stage (inside the component that owns `const { data } = useLiveFixture(...)`; names RE-PIN):

```tsx
const seenRef = useRef<number>(maxSeq(initial.recent));                 // OBS opens mid-stream: nothing replays
const [fresh, setFresh] = useState<OverlayMoment[]>(EMPTY);
useEffect(() => {
  const recent = data.recent ?? [];
  const next = momentsFor(sportKey, recent, seenRef.current, msg, [model.sides[0].short, model.sides[1].short]);
  seenRef.current = Math.max(seenRef.current, maxSeq(recent));
  if (next.length) setFresh(next);
}, [data, sportKey, msg, model.sides]);
const reducedMotion = useReducedMotion();                                  // matchMedia("(prefers-reduced-motion: reduce)"), false on the server
const { current, phase } = useMomentQueue(fresh, { reducedMotion });
…
{current && <OverlayMomentSlab moment={current} phase={phase} placement={style} />}
```

  The slab sits in the slot W1 left in the bar (below the main band, full width) and the bug (to the right of the tile, vertically centred). CSS (`globals.css`, beside the W1 overlay rules):

```css
.ovl-slab { position: absolute; display: flex; flex-direction: column; gap: .15em; padding: .35em .9em; max-width: 34ch; min-width: 0;
  background: var(--ovl-slab-bg); color: var(--sport-board); font-family: var(--ps-font-display); font-variant-numeric: tabular-nums;
  will-change: transform, opacity; transition: transform var(--ovl-fold, 250ms) cubic-bezier(.2,.8,.2,1), opacity var(--ovl-fold, 250ms) linear; }
.ovl-slab[data-tone="led"]       { --ovl-slab-bg: var(--sport-led); }
.ovl-slab[data-tone="caution"]   { --ovl-slab-bg: var(--sport-caution); }
.ovl-slab[data-tone="dismissal"] { --ovl-slab-bg: var(--sport-dismissal); color: var(--sport-ink); }
.ovl-slab__headline { font-weight: 700; font-size: 2.2em; line-height: 1; letter-spacing: .02em; }
.ovl-slab__line { font-family: inherit; font-weight: 600; font-size: 1em; opacity: .9; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
/* bar: rises from under the main band; bug: slides out from behind the tile. transform + opacity ONLY. */
.ovl-slab--bar { left: 0; top: 100%; transform: translateY(-100%); }
.ovl-slab--bar.ovl-slab--in, .ovl-slab--bar.ovl-slab--hold { transform: translateY(0); opacity: 1; }
.ovl-slab--bar.ovl-slab--out { transform: translateY(-100%); opacity: 0; }
.ovl-slab--bug { left: 100%; top: 50%; transform: translate(-100%, -50%); opacity: 0; }
.ovl-slab--bug.ovl-slab--in, .ovl-slab--bug.ovl-slab--hold { transform: translate(0, -50%); opacity: 1; }
.ovl-slab--bug.ovl-slab--out { transform: translate(-100%, -50%); opacity: 0; }
@media (prefers-reduced-motion: reduce) { .ovl-slab { transition: none; } }
```

  The initial `in` frame must start from the hidden transform — render the slab with `data-phase="in"` on mount and set `--ovl-fold` from `OVERLAY_MOMENT_FOLD_MS` inline so CSS and reducer share the number (pass it as a style var from the component, never retype `250ms` in two places).

- [ ] **Step 4: Run — reducer green**, then typecheck: `cd …/apps/web && pnpm typecheck`.

- [ ] **Step 5: E2E** — append to `apps/web/e2e/stream-overlay.spec.ts` (W1's file; reuse its overlay-URL helper and its `streaming.overlay` / `realtime` override setup — RE-PIN their names; if W1 did not enable `realtime`, enable it here with `setBoolEntitlementOverrideSql(orgId, "realtime", true)` and thaw in `afterAll`, or every assertion waits a 15 s poll). Budget expressed in the constants (rule 20): `const BUDGET = OVERLAY_MOMENT_HOLD_MS + 2 * OVERLAY_MOMENT_FOLD_MS + POLL_MS + 5_000` with `POLL_MS` imported from the hook module (D6).

```ts
import { OVERLAY_MOMENT_FOLD_MS, OVERLAY_MOMENT_HOLD_MS } from "../src/components/overlay/moment-timing";
import { resolvePersonDisplayName } from "../src/lib/name-display";

async function post(request: APIRequestContext, fixtureId: string, type: string, payload: Record<string, unknown>) {
  const st = await apiJson<{ last_seq: number }>(request, `/api/v1/fixtures/${fixtureId}/state`);
  const res = await apiJson(request, `/api/v1/fixtures/${fixtureId}/events`, "POST", { expected_seq: st.data!.last_seq, type, payload });
  expect(res.status, `${type} ${JSON.stringify(res.error)}`).toBeLessThan(300);
}
const slab = (page: Page) => page.getByTestId("overlay-moment");

test.describe("moments", () => {
  test("football: a goal raises GOAL on the bug, once, and it is gone after the hold", async ({ page, request }) => {
    test.setTimeout(3 * BUDGET);
    const fx = await footballFixtureInPlay(request);                       // RE-PIN: copy the division body from `grep -an 'sport_key: "football"' apps/web/e2e/*.spec.ts | head -1`; core.start; no lineup needed
    await page.goto(overlayUrl(fx.fixtureId, "bug"));
    await expect(slab(page)).toHaveCount(0);                                // nothing on load
    await post(request, fx.fixtureId, "football.goal", { by: fx.homeEntrantId });
    const seen: string[] = [];
    await expect.poll(async () => { const k = await slab(page).getAttribute("data-kind").catch(() => null); if (k && seen.at(-1) !== k) seen.push(k); return seen.length; }, { timeout: BUDGET }).toBe(1);
    await expect(slab(page)).toHaveText(/GOAL/);
    await expect(slab(page)).toHaveCSS("background-color", await page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue("--sport-led").trim()).then(toRgb));
    await expect(slab(page)).toHaveCount(0, { timeout: OVERLAY_MOMENT_HOLD_MS + 2 * OVERLAY_MOMENT_FOLD_MS + 2_000 });
    await page.waitForTimeout(POLL_MS + 1_000);                             // a later poll must NOT replay it
    expect(seen).toEqual(["goal"]);
  });
  test("two events back to back: both slabs, in ledger order, one after the other", async ({ page, request }) => {
    test.setTimeout(3 * BUDGET);
    // goal then card posted within one refetch window; poll `data-kind` into an ordered distinct list until length 2
    // expect(order).toEqual(["goal", "card.yellow"]); and the card appeared only after the goal's slab had gone (record timestamps)
  });
  test("cricket: SIX on the bar; OUT carries the consent-masked name and the batter's figures", async ({ page, request }) => {
    test.setTimeout(4 * BUDGET);
    const rig = await seedRosteredFixture(request, { label: `ovl-cricket-${TAG}`, sportKey: "cricket", variantKey: "t20", home: ELEVEN_H, away: ELEVEN_A, emitCoreStart: false });   // RE-PIN RosteredFixture's fields
    await post(request, rig.fixtureId, "cricket.toss", { wonBy: rig.homeEntrantId, elected: "bat" });
    await post(request, rig.fixtureId, "core.start", {});
    const [s1, s2, s3] = rig.homePersonIds; const b = rig.awayPersonIds.at(-1)!;
    await withDb((sql) => sql`update persons set consent = '{"public_name": false}'::jsonb where id = ${s2}`);
    await page.goto(overlayUrl(rig.fixtureId, "bar"));
    await post(request, rig.fixtureId, "cricket.ball", { over: 0, ballInOver: 1, striker: s1, nonStriker: s2, bowler: b, runs: { bat: 6 }, boundary: 6 });
    await expect(slab(page)).toHaveText(/SIX/, { timeout: BUDGET });
    await expect(page.getByTestId("overlay-bar-detail")).toContainText(ELEVEN_H[0].fullName + "*");   // Task 3 live: striker marker (RE-PIN the detail testid W1 gave the second band)
    await expect(slab(page)).toHaveCount(0, { timeout: BUDGET });
    await post(request, rig.fixtureId, "cricket.ball", { over: 0, ballInOver: 2, striker: s1, nonStriker: s2, bowler: b, runs: { bat: 1 } });   // strike to s2
    await post(request, rig.fixtureId, "cricket.ball", { over: 0, ballInOver: 3, striker: s2, nonStriker: s1, bowler: b, runs: { bat: 0 }, wicket: { kind: "bowled", out: s2, bowlerCredited: true, incoming: s3 } });
    const masked = resolvePersonDisplayName(ELEVEN_H[1].fullName, { public_name: false }, null, false);
    await expect(slab(page)).toHaveText(/OUT/, { timeout: BUDGET });
    await expect(slab(page)).toContainText(masked);
    await expect(slab(page)).not.toContainText(ELEVEN_H[1].fullName);
    await expect(slab(page)).toContainText("0 (1)");                       // the fold's figures for s2
  });
  test("prefers-reduced-motion: the slab still appears and disappears, with no transition", async ({ page, request }) => {
    await page.emulateMedia({ reducedMotion: "reduce" });
    // post a goal; expect slab visible; expect toHaveCSS("transition-property", "none") or transition-duration "0s"; expect gone after hold
  });
});
```

  Run locally against the W1 prod server (per `seazn-local-env`): `cd /Users/ashokhein/github/seazn.club/.claude/worktrees/stream-overlay/apps/web && E2E_PROD_TARGET=1 BASE=http://127.0.0.1:<port> pnpm exec playwright test e2e/stream-overlay.spec.ts --project=parallel --reporter=list` — the WHOLE file, never `-g`. Expected: every W1 test still green plus 4 new passed. Then the seven-width regression: `pnpm exec playwright test e2e/mobile.spec.ts` (all width projects) unchanged — the overlay is not in it, but the division fixtures tab (W1's toggle) is, and the CSS file changed.

- [ ] **Step 6: Mutation checks on the wiring (the e2e must see them).** (i) `seenRef` initialised to `0` → the football test's first assertion fails? No — nothing is in `recent` before the goal for a fresh fixture; so ALSO seed one goal BEFORE `page.goto` in a fifth case "OBS opens mid-stream: the earlier goal does not replay" → with the mutant it reds. (ii) `holdMs: 0` → "gone after the hold" passes but `toHaveText(/GOAL/)` reds (the slab is gone before the poll sees hold) and the reducer's default-pin test reds. (iii) drop the dedupe → "once" still passes (one refetch) — covered by the reducer test instead; state this honestly in the PR.

- [ ] **Step 7: Commit.**
  `cd /Users/ashokhein/github/seazn.club/.claude/worktrees/stream-overlay && /usr/bin/git add apps/web/src/components/overlay/moment-timing.ts apps/web/src/components/overlay/moment-queue.ts apps/web/src/components/overlay/use-moment-queue.ts apps/web/src/components/overlay/overlay-moment.tsx apps/web/src/components/overlay/__tests__/moment-queue.test.ts apps/web/src/components/overlay/overlay-stage.tsx apps/web/src/app/globals.css apps/web/e2e/stream-overlay.spec.ts && /usr/bin/git commit -o apps/web/src/components/overlay/moment-timing.ts apps/web/src/components/overlay/moment-queue.ts apps/web/src/components/overlay/use-moment-queue.ts apps/web/src/components/overlay/overlay-moment.tsx apps/web/src/components/overlay/__tests__/moment-queue.test.ts apps/web/src/components/overlay/overlay-stage.tsx apps/web/src/app/globals.css apps/web/e2e/stream-overlay.spec.ts -m "overlay: the moment slab — FIFO queue (4 s hold, 250 ms fold, transform/opacity only), seq-diffed from recent[], reduced-motion instant; e2e for goal, order, cricket SIX/OUT with consent masking" -m "Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>" -m "Claude-Session: https://claude.ai/code/session_01UdUR7dcxassJ4FExpVfRRr"`

---

### Task 5: Dictionary coverage from the engine's enums, the visual gate, the index

**Files:**
- Create: `apps/web/src/lib/__tests__/overlay-moment-dictionary.test.ts`
- Modify: `apps/web/src/dictionaries/{en,es,fr,nl}/public.json` (`overlay.cricket.*` from Task 3 if not yet added; any key the coverage test finds missing)
- Modify or create: `apps/web/e2e/walkthrough/stream-overlay-capture.spec.ts` (RE-PIN: `grep -arl "overlay" apps/web/e2e/walkthrough/*.spec.ts`; if W1 named its capture spec differently, extend THAT file; if none exists, create this one — it is matched by `WALKTHROUGH`)
- Modify: `docs/superpowers/specs/2026-09-05-stream-overlay-prompts/_INDEX.md`

- [ ] **Step 1: Failing coverage test** — every key any rule can emit exists in all four locales, and the lists are DERIVED from the engine (a new dismissal kind or penalty class cannot ship unlocalised):

```ts
import en from "@/dictionaries/en/public.json"; import es from "@/dictionaries/es/public.json"; import fr from "@/dictionaries/fr/public.json"; import nl from "@/dictionaries/nl/public.json";
import { MOMENT_KEYS } from "../overlay-moments";
import { CricketWicket } from "@seazn/engine/sports/cricket";
import { FOOTBALL_EVENT_SCHEMAS } from "@seazn/engine/sports/football";      // RE-PIN export
import { icehockey } from "@seazn/engine/sports/icehockey";
const wicketKinds = CricketWicket.shape.kind.options;
const cardColours = (FOOTBALL_EVENT_SCHEMAS["football.card"] as z.ZodObject<{ color: z.ZodEnum<[string, ...string[]]> }>).shape.color.options;
const penaltyClasses = Object.keys(/* RE-PIN */ icehockeyDefaultCfg().suspensions.classes);
const DERIVED = [...wicketKinds.map((k) => `overlay.moment.wicket.${k}`), ...cardColours.map((c) => `overlay.moment.card.${c}`), "overlay.moment.card.green", ...penaltyClasses.map((c) => `overlay.moment.penaltyClass.${c}`)];
for (const [locale, dict] of Object.entries({ en, es, fr, nl })) {
  it(`${locale} carries every overlay moment key`, () => { for (const k of new Set([...MOMENT_KEYS, ...DERIVED, "overlay.cricket.strikerMark", "overlay.cricket.onStrike", "overlay.cricket.thisOver"])) expect(dict, k).toHaveProperty(k); });
}
it("every enum-derived key is in MOMENT_KEYS (the rule table and the enum agree)", () => { for (const k of DERIVED) expect(MOMENT_KEYS).toContain(k); });
it("placeholders match across locales", () => { /* for each key with {x} in en, every locale has the same set of {x} */ });
```

- [ ] **Step 2: Run — expect the missing keys listed; add them; `pnpm i18n:gen-keys && pnpm i18n:check`; run — green.** `--outputFile=/tmp/seazn-env/ovl/w2-t5.json`, expected `numTotalTests: 6`.

- [ ] **Step 3: Visual gate additions.** In the capture spec, after W1's bar/bug scenes, add scenes at 1920×1080 that CAPTURE THE SLAB MID-HOLD (post the event, wait `OVERLAY_MOMENT_FOLD_MS + 300`, screenshot): `cricket-bar-six`, `cricket-bar-out` (with the batter line visible in the same frame), `football-bug-goal`, `football-bug-card-red`, `tennis-bug-match-point` (drive a short best-of-one set through `tennis.point` to match point), `badminton-bug-game-won`, and one `prefers-reduced-motion` frame. Assert the files exist, are non-empty, and that `cricket-bar-six` ≠ `cricket-bar-out` byte-for-byte (the gate's own vacuous mode is two identical pictures). Attach to the PR with per-screen verdicts written by a human reading them (not "CI green").

- [ ] **Step 4: `_INDEX.md`.** Status row "PR2 (moments, cricket batter line)" → "planned `plans/2026-09-05-stream-overlay-w2-moments.md`; in flight after spectator W1 merge <date>"; add a "Pinned symbols — W2 (re-verified <date>)" table with the D1–D8 outcomes and the chosen Task 3 variant; add any false premise found (e.g. a column that lived on the view, a renamed hook path).

- [ ] **Step 5: Commit.**
  `cd /Users/ashokhein/github/seazn.club/.claude/worktrees/stream-overlay && /usr/bin/git add apps/web/src/lib/__tests__/overlay-moment-dictionary.test.ts apps/web/src/dictionaries/en/public.json apps/web/src/dictionaries/es/public.json apps/web/src/dictionaries/fr/public.json apps/web/src/dictionaries/nl/public.json apps/web/src/lib/i18n-keys.ts apps/web/e2e/walkthrough/stream-overlay-capture.spec.ts docs/superpowers/specs/2026-09-05-stream-overlay-prompts/_INDEX.md && /usr/bin/git commit -o apps/web/src/lib/__tests__/overlay-moment-dictionary.test.ts apps/web/src/dictionaries/en/public.json apps/web/src/dictionaries/es/public.json apps/web/src/dictionaries/fr/public.json apps/web/src/dictionaries/nl/public.json apps/web/src/lib/i18n-keys.ts apps/web/e2e/walkthrough/stream-overlay-capture.spec.ts docs/superpowers/specs/2026-09-05-stream-overlay-prompts/_INDEX.md -m "overlay(i18n): moment keys covered per engine enum in four locales; moment scenes in the visual gate; W2 pins in the programme index" -m "Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>" -m "Claude-Session: https://claude.ai/code/session_01UdUR7dcxassJ4FExpVfRRr"`

---

### Task 6: Gates, review loop, PR

- [ ] Full `apps/web` vitest from `apps/web` with the DB env and the JSON reporter (`/tmp/seazn-env/ovl/w2-full.json`): paste `numTotalTests / numPassedTests / numFailedTests` and confirm zero `numFailedTestSuites` (a suite that failed to COLLECT reads as `numFailedTests: 0`). Engine suite unchanged (`cd packages/engine && pnpm exec vitest run --reporter=json --outputFile=/tmp/seazn-env/ovl/w2-engine.json`) — W2 must not have touched it; confirm the count equals main's.
- [ ] `rtk proxy pnpm lint` and read `✖ N problems` yourself; `pnpm typecheck` in both workspaces (the local build no longer typechecks); `pnpm openapi:gen` + `/usr/bin/git status --porcelain openapi` empty; `pnpm i18n:check`.
- [ ] Smoke locally (`SMOKE_BASE=http://127.0.0.1:<port> node --experimental-strip-types scripts/smoke.ts` per the script's own header) — the new `recent` checks pass.
- [ ] Reviewer pass (Opus) on the whole branch diff since the W1 merge base, findings written to `docs/superpowers/specs/2026-09-05-stream-overlay-prompts/W2-review.md`, fixed inline; never skip because every task review was clean.
- [ ] Open the PR (only when the owner asks; never unprompted), then `workflow_dispatch` e2e with the PR number; smoke runs on the PR. Per-screen visual verdicts from the owner on the capture scenes.

---

## Self-review

**Spec coverage** (spec sentence → task):

| Spec | Task |
|---|---|
| "public payload to carry the last few events with their type and sequence number" | 1 |
| "per-event-type template set W1 derives from each module's event schemas, filtered by a per-sport allowlist" | 2 (raw types + `MOMENT_RULES`; parity test against `eventSchemas`) |
| "cricket boundary four and six, wicket; football goal and card; hockey and ice hockey goal and card; racket sports ace where the module records it, break point, set point, match point, set won; volleyball set point, match point and set won (owner answer 21 / Q10 — the spec said set won only)" | 2 (table + its own volleyball test); 1 (derived `pointState`/`setWon`) |
| "diffs the sequence to fire once per event" | 2 (`sinceSeq` exclusive) + 4 (`seenRef` from the initial tip) |
| "slab in the sport's LED colour (dismissal red for wickets, caution yellow for cards) attached to the bug or under the bar" | 4 (tones → `--sport-*`, `.ovl-slab--bar/bug`) |
| "holds four seconds, queues if another arrives" | 4 (reducer; e2e order test) |
| "Player names on moments pass through the public-site consent resolver" | 1 (`personOf`; DB test derives the expected value from the resolver) |
| "Board game, carrom and generic have no allowlist entries and render no moments, by construction" | 2 (empty entries + test) |
| §9 "slides out … 250 ms, holds four seconds, folds back 250 ms; queues; nothing else animates; no entrance animation on load; no per-frame timers; reduced motion = instant show and hide" | 4 (`moment-timing.ts`, one re-armed timeout, `seenRef`, reduced-motion CSS + reducer `foldMs: 0`, e2e) |
| §2 `OverlayModel.detail` "[] in step one for cricket" → W2 fills it | 3 |
| "The cricket bar's batter and bowler line is also step two, same dependency" | 3 (D1 primary; B/C named) |
| Copy: every string via the dictionary, four locales, `gen-keys` | 2, 3, 5 |
| Tests: unit / e2e / smoke / regression | unit 1–5; e2e 4; smoke 1; regression: W1 `overlay-model` cricket case (3), whole `stream-overlay.spec.ts` + `mobile.spec.ts` (4), engine count unchanged (6) |
| Visual gate: images exist and differ | 5 |

**Mutation checks** (run, not described; each names the test that must go red):

| Mutant | Red test |
|---|---|
| Delete the `wicketKind` branch in `MOMENT_RULES.cricket["cricket.ball"]` (the "allowlist entry for wicket") | `overlay-moments.test.ts` "SIX, FOUR and OUT fire; the single is silent" (expects `[6, "wicket", "dismissal"]`) and the e2e "cricket: SIX on the bar; OUT carries…" |
| Break the sequence diff so a moment fires twice (`ev.seq <= sinceSeq` → `<`, or `seenRef` never advanced) | `overlay-moments.test.ts` "seq already seen yields nothing; the boundary is sinceSeq EXCLUSIVE"; e2e "…once, and it is gone after the hold" (`seen` must equal `["goal"]` after a further poll) and "OBS opens mid-stream: the earlier goal does not replay" |
| Drop the consent call (`personOf` returns `full_name`) | `overlay-recent.test.ts` "names on recent are the consent resolver's output, not the stored full name"; e2e OUT case (`not.toContainText(fullName)`) |
| Shorten the hold to 0 (`OVERLAY_MOMENT_HOLD_MS = 0`) | `moment-queue.test.ts` "the default hold is four seconds…" (pins the DEFAULT) and "idle + enqueue → in… hold with deadline now+hold"; e2e `toHaveText(/GOAL/)` reds because the slab is gone before the poll |
| `fresh` always true | `overlay-recent.test.ts` "…the next point (Ad) is not fresh"; `overlay-moments.test.ts` racket case counts two break-point moments, not three |
| Remove the `probe.type in eventSchemas` guard | `overlay-recent.test.ts` badminton spy test |
| Add an undeclared type to an allowlist | the per-module parity test in `overlay-moments.test.ts` |

**Open pins** (each must be closed in `_INDEX.md` before Task 1):
1. D1–D8 above, especially whether `publicFixture()` carries `match_centre` (decides Task 3's variant) and the hook's path (D6).
2. `apps/web/src/server/db` default `sql` export name; whether `divisions` has `youth` / `player_name_display` or only `public_divisions_v` does; the config-parse entry point on `SportModule` for cfg in unit tests (`view-model.test.ts:29` builds generic's cfg by hand — cricket/tennis need the module's parsed defaults).
3. `scoreEvent`'s input shape (`expectedSeq` vs `expected_seq`) and `putLineup`'s body; `createPerson`'s usecase for the DB consent test.
4. `RosteredFixture`'s field names (`helpers.ts:~1500`) and whether `seedRosteredFixture` tolerates 11 cricket slots without a `positionKey`.
5. W1's testid for the bar's second band and the slot it left for the slab in `overlay-bar.tsx` / `overlay-bug.tsx`.
6. Football division `variant_key` for the e2e (copy from an existing football e2e, never guess).
7. Whether `@seazn/engine/sports/football` exports `FOOTBALL_EVENT_SCHEMAS` / `CardColor` (for the enum-derived dictionary test); `icehockey`'s default-config entry point for the class keys.

**Deviations from the task skeleton, recorded:**
- Dictionary keys land in Task 2 (all four locales), not Task 5, because `MsgFn`'s key type is the generated union and `overlay-moments.ts` cannot typecheck without them; Task 5 owns the enum-derived coverage test, `i18n:check`, the visual gate and the index.
- `OverlayMoment` gains `seq` (React key and queue identity) — additive to the spec's fixed interface.
- Break / set / match point are STATES, not recorded events; they are derived server-side by probing the fold with a synthetic next point rather than by retyping set rules, and fire only on the `fresh` transition. No `/recent` endpoint: `recent` rides the existing public fixture payload so it shares one cache and one invalidation.
- `recent` excludes `core.*` and lineup events (none is a moment); the window is taken after `resolveVoids`.

**~~Product-owner recommendation~~ — ACCEPTED, owner answer 21 (Q10), 2026-09-06: "Ok".** The recommendation was: volleyball's set point and match point cost nothing extra (the probe already computes them for every set-based kernel), and a volleyball broadcast that shows "SET POINT" reads as finished where one showing only "SET 2" reads as a scoreboard — parity across the four racket/net sports for one allowlist line. **Applied:** volleyball's entry in `MOMENT_RULES` (Task 2 Step 3) is now `{ "derived.pointState": pointState, "derived.setWon": setWon }`, the allowlist table row says so, and Task 2 Step 1 carries its own test asserting `setPoint` (not `gamePoint`) and `matchPoint`. The spec's "set won only" line for volleyball is superseded by this answer; `_INDEX.md` records it.
