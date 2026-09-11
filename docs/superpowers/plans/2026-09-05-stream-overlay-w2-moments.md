# Stream Overlay W2 (Moments) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The overlay reacts to the match. A SIX, FOUR or OUT in cricket, a GOAL or card in football / hockey / ice hockey, an ACE, a break / set / match point and a set won in the racket sports, and a set point, match point or set won in volleyball (owner answer 21 / Q10) each raise a slab in the sport's own colour beside the bug (or under the bar), hold four seconds, fold away, and queue behind one another. The cricket bar's second band carries the batters at the crease and the bowler's figures. Nothing fires on load or reconnect; nothing fires twice; every name passes the public-site consent resolver; a sport whose module declares no such event renders nothing, by construction.

**Architecture:** (AMENDED 2026-09-10 by task zero — see the Status block.) One additive field on **`OverlayLiveData`, the overlay endpoint's projection** — `recent: RecentEvent[]`, the last eight void-resolved ledger events with their raw engine type, sequence number, a consent-resolved minimal payload and, for the racket sports, a server-derived `setWon` / `pointState` annotation computed by replaying the module through the real fold and probing "would the next point win the game / set / match" (the engine is the authority; no set rule is retyped). A pure client projection `momentsFor(sportKey, recent, sinceSeq, msg)` turns it into `OverlayMoment[]` through a per-sport allowlist that MATCHES on `(type, payload)`, never on type alone (W2-F3). The stage tracks the highest sequence it has seen, starting at the initial payload's tip, so OBS opening mid-stream replays nothing. A FIFO queue reducer drives one slab component whose motion is `transform` / `opacity` only. The cricket line comes from a server-side `foldMatch` with the real cricket module — the only source, since `match_centre` never reaches the overlay payload (W2-F10).

**Tech Stack:** Next 16 App Router (read `node_modules/next/dist/docs/` before touching a route), React 19, TypeScript 7 native tsc, Tailwind 4 + `globals.css`, zod, `@seazn/engine` (`foldMatch`, `resolveVoids`, per-module `eventSchemas`), postgres.js, vitest (`environment: "node"`, no DOM), Playwright, pnpm workspaces.

**Canvas (owner-reviewed, the visual authority):**
https://claude.ai/code/artifact/2aebcbde-28ba-45ff-9028-1151873e4901 — this
wave's artboard is **"Moments"** (SIX, OUT, GOAL and MATCH POINT slabs beside
the bug, in each sport's own colour), with "A across sports" and "B across
sports" for the boards the slab attaches to. `_THEMES.md` §5 holds the same
design as numbers.

**Spec:** `docs/superpowers/specs/2026-09-05-stream-overlay-design.md` — "Decisions locked" 3–4, "Architecture" §2 (`OverlayModel`, W2 fills `detail` for cricket), §9 Motion (the slab), "Step two — moments" (`OverlayMoment`, the per-sport allowlist), "Tests". Programme index: `docs/superpowers/specs/2026-09-05-stream-overlay-prompts/_INDEX.md`. Wave 1 plan: `docs/superpowers/plans/2026-09-05-stream-overlay-w1.md` (absent when this plan was written; the W1 skeleton below is taken from the spec and every W1 path is re-pinned at execution).

**Status (2026-09-11): TASK 1 IS SHIPPED — the payload half.** `recent` is on
`OverlayLiveData`, projected in `server/overlay/recent.ts`, consent-resolved,
mutation-swept (8/8), 40/40 green, tsc and lint clean, openapi regenerated.
**Step 7 is shipped too** — `derived.setWon` and `derived.pointState` ride on
the same payload, asked of the engine rather than computed. Task 2's
racket-sport rules have what they need.

**Verified end to end against a live DB**: 3947 passed / 0 failed, and the
DB-backed route test drives ten real badminton appends and reads the engine's
set point off the route's own JSON. Mutation sweep 17/17.

**Proven over real HTTP, 2026-09-11:** full smoke against a standalone prod
server — **1034 passed, 0 failed** — with the four new overlay checks among
them. That run matters beyond the checks themselves: it is the only place the
REAL `unstable_cache` executed, so the serialisation fix (W2-F18) is proven in
production shape rather than against a double. A green unit suite is not a working product.

**One finding from building it, worth the wave's attention.** The spectator
timeline was measured against this need before a line was written and CANNOT
serve it — `TimelineLine` carries no raw event type, `TIMELINE_KEY_FOR` is
deliberately many-to-one so the key cannot be inverted, and cricket has no entry
in that table at all. That settles W2-F1's "the source is the fallback" with a
reason rather than an absence, and it is the RECOMMENDATION the wave owes the
spectator programme: carry raw types.

**Status (2026-09-10): TASK ZERO IS CLOSED. Outcomes and findings W2-F1–W2-F12 are in `../specs/2026-09-05-stream-overlay-prompts/_INDEX.md` § “2026-09-10 — W2 task zero: the RE-PIN, closed”, re-verified against `main` `10c7f94cd`. Both gates are open (spectator W1 #743; PR1 / W1 overlay #761). NOT yet executable for one remaining reason: the re-pin falsified three premises this plan is written on, so Task 1's shapes and its placeholder test bodies must be rewritten and re-reviewed first. The wave's SCOPE is unchanged — every moment the owner named still fires. Its MECHANISM changes:**

- **W2-F3 — NO CHANGE OWED HERE (corrected 2026-09-11).** The finding was raised against `W2-moments.md`'s flat `MOMENT_TYPES` map and does not apply to this plan: Task 2 already specifies `MOMENT_RULES` as `(ev, ctx) => OverlayMoment | null` functions that read `boundary`/`wicketKind` off `cricket.ball`, already names `*.suspension.start` rather than a non-existent `*.card`, and additionally names `cricket.superover.ball` (verified `cricket.ts:408`). The BRIEF is what needs correcting.
- **W2-F4 — CONFIRMS this plan's derived branch** rather than correcting it: set point and match point are DERIVED in tennis, badminton, table tennis and volleyball at every band anyone streams at (`<sport>.set.summary` / `.game.summary` is an EVENT only at band 0), which is exactly what Task 2's `derived.pointState` / `derived.setWon` rules assume.
- **W2-F6 — a band-2 cricket wicket is a line DIFF**, not a type match: `batting.out` flipping false→true on a cumulative, repeatedly re-appended `cricket.player.line`.
- **W2-F1/F9/F10 — the source is the fallback, and it lands on `OverlayLiveData`,** not on the public fixture payload (the overlay no longer polls that route). The cricket batter line's “primary” source `match_centre.cricket.live` never arrives on the overlay payload; the server-side fold is the only source.
- **W2-F7 — CLOSED 2026-09-11.** The lineup/person path is added, and it goes through `readPublicLineups` directly rather than through `personOf`: the overlay publishes `{ name, masked }` and no id at all, so `makePersonOf`'s surrogate-id machinery is not needed here. A person the line-up never named is left UNNAMED rather than given the match centre's `"?"` — an overlay has no scorecard row to fill, and "GOAL" reads correctly on air where "?" does not.
- **W2-F11 — `useLiveFixture` now returns `awaitingDelay`.** The stage must gate `seenSeq` and the queue push on it or a delayed transport replays history (mutant h).
- **W2-F2 — do not read `data.match_centre` on the overlay payload.** It typechecks through `OverlayLiveData extends LiveFixtureData` and is always `undefined` at runtime.

This wave WAS blocked on `feat/spectator-surface` W1 merging (done 2026-09-08). Because its input
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

- **Sequencing.** spectator W1 MERGED 2026-09-08 (#743) and this branch is rebased on it (`60c0615b0`); W2 executes only after PR1 merges, and only after every `RE-PIN AT EXECUTION` in this document has been re-verified against the rebased tree (a brief is a hypothesis; a grep is not a read; a read is not a run). The "Dependencies on spectator W1" table says what to do when a symbol landed differently or not at all. Record each re-pin result in `_INDEX.md` before Task 1 starts.
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
- **Worktree discipline.** All work in `.claude/worktrees/stream-overlay` on `feat/stream-overlay`; prefix shell commands with `cd /Users/ashokhein/github/seazn.club/.claude/worktrees/stream-w2 &&` in the same call; never `git stash` (the stash stack is shared with the main checkout); commit with `/usr/bin/git commit -o <paths>` so the shared index cannot sweep a sibling's files in (`-o` fails with "pathspec did not match" on a NEW file: `/usr/bin/git add <new-file>` first, as its own plain call, then commit; the session's guard also refuses heredocs, `eval`, sourcing and `&&` chains that include git, so every git call is one plain command).
- **No redirect built from `req.url`** anywhere in this programme (base-commit health note in `_INDEX.md`): W2 adds no route; the existing public route returns JSON.
- **Sponsor logos are NOT in W2** (owner answer 20 / Q9, 2026-09-06: *"ok for own wave as put it last"*) — they are their own wave, scheduled LAST in the programme, after W1 and W2. The slab is the only thing that appears beside the bug or under the bar in this wave; reserve no space and leave no seam for a logo, because a reserved-but-empty slot is an inert seam and that wave owns sizing, placement and the per-tier rules.
- **Phone composition rules do not apply to the overlay canvas** (authored at 1920×1080, scaled), but the organiser panel's live preview renders the same component at reduced scale, so the slab must not overflow the 1920×1080 stage at any moment length: `max-width` on the slab, `truncate` with `min-w-0` on its text.

---

## Dependencies on spectator W1

Authority when this plan was written: the READ-ONLY worktree `.claude/worktrees/spectator` (branch `feat/spectator-surface`, 2026-09-05). Everything below is marked **RE-PIN AT EXECUTION**: W1 may land differently, and the pins are branch-relative (cite the symbol, re-find the line).

| # | Symbol (RE-PIN AT EXECUTION) | Where it is expected after the merge | What W2 uses it for | Fallback if absent or shaped differently |
|---|---|---|---|---|
| D1 | `LiveFixtureData.match_centre?: MatchCentreDocT` — `feat/spectator-surface:apps/web/src/components/public-site/live-score-data.ts:33` | `apps/web/src/components/public-site/live-score-data.ts` | Task 3 primary source of the cricket line: `data.match_centre?.cricket?.live` | Task 3 variant B/C: `LiveFixtureData.overlayCricket?: OverlayCricketLive` built by our own `loadOverlayRecent` (this plan, Task 1's helper gains `cricketLive`) | **(re-pinned 2026-09-08 @ 60c0615b0): HELD — `live-score-data.ts:46` `match_centre?: MatchCentreDocT`; `outcome.method` also present (`:23`).**
| D2 | `CricketView.live` shape — `feat/spectator-surface:apps/web/src/server/public-site/match-centre-schema.ts:41`: `{ striker: Person\|null, nonStriker, bowler, batters: CricketBattingRow[] (person, runs, balls, …), bowling: CricketBowlingRow[] (person, overs, maidens, runs, wickets, …), thisOver: string[], partnership, lastWicket }`, `Person = { personId, name, masked }` | same file | Task 3's input contract `OverlayCricketLiveInput` (structurally a subset of this) | Same as D1; the input type is ours, so only the adapter changes |
| D3 | `deriveCricketScorecard({ events, cfg, lineups }: ScorecardInput): CricketScorecard` — `feat/spectator-surface:packages/engine/src/sports/cricket/scorecard.ts:945`, exported from `sports/cricket/index.ts`; `CricketLive` at `scorecard-types.ts:85` (`striker/nonStriker/bowler: PersonId\|null`, `thisOver: BallGlyph[]`, `partnership`, `lastWicket`) and `BattingLine { runs, balls, … }` | `@seazn/engine/sports/cricket` | Task 1: the dismissed batter's `runs (balls)` on the OUT line; Task 3 variant B: the cricket line when D1 is absent | Task 1/3 variant C: the engine's own folded state — `activeInnings(state).list.at(-1)!.fine` (`packages/engine/src/sports/cricket/cricket.ts:584,441,409-422`: `striker`, `nonStriker`, `currentBowler`, `batterRuns`, `batterBalls`, `bowlerBalls`, `bowlerRuns`, `bowlerWickets`) via `foldMatch(cricket, cfg, lineups, events)`. Zero rules retyped either way. |
| D4 | `readPublicLineups(sql, …)`, `PublicPerson = { personId, name, masked }`, `DivisionConsentCtx = { youth?, player_name_display? }` — `feat/spectator-surface:apps/web/src/server/public-site/public-lineups.ts:21-25` | `apps/web/src/server/public-site/public-lineups.ts` | Task 1's `personOf(id)` for names in `recent` | Our own query in `overlay-recent.ts`: `select id, full_name, consent from persons where id = any($1) and merged_into is null` + `resolvePersonDisplayName` (`apps/web/src/lib/name-display.ts:72`); `merged_into is null` mirrors `data.ts:529` |
| D5 | The derived set-won diff inside `buildTimeline` — `feat/spectator-surface:apps/web/src/server/public-site/timeline.ts:500-560` (`derivedLines(previous, summary, event, sportKey, sides)`, module-local) and its replay loop `:600-623` (`module.apply(state, event, { strict: false, squads })`, skipping `core.suspend`/`core.resume` and lineup events) | `apps/web/src/server/public-site/timeline.ts` | Task 1's `setWon` annotation | Default, because `derivedLines` is not exported: our own `diffClosedSets(before, after)` over `summary.detail.sets[].closed` — the same diff, and W2 uses `foldMatch` prefixes rather than a hand replay so it can never drift from the production fold | **(re-pinned 2026-09-08 @ 60c0615b0): `buildTimeline` at `timeline.ts:587`, `TimelineArgs` `:80-92`; the derived pass and `derivedComplete` (`match-centre-schema.ts:88-96`) exist — the module-local line numbers are NOT re-pinned here (task zero).**
| D6 | The live transport hook — spectator has `feat/spectator-surface:apps/web/src/components/public-site/match-centre/use-live-fixture.ts:18` `useLiveFixture(...)` with `POLL_MS = 15_000`; the overlay W1 skeleton names `apps/web/src/components/public-site/match-centre/use-live-fixture.ts (re-pinned 2026-09-08 @ 60c0615b0: spectator W1 owns this path; the W1-skeleton path never lands)` | whichever path survives the merge (one hook, one transport) | Task 4 reads `data` from it and diffs `data.recent` | None needed: W2 touches neither hook's internals; it only consumes `data` | **(re-pinned 2026-09-08 @ 60c0615b0): DECIDED — one hook at `match-centre/use-live-fixture.ts:17` returning `{ data, transport }`; W1 widens it (`{ fetcher, delayMs? }`, `presentationNowOffsetMs`). The `components/public-site/use-live-fixture.ts` path never lands.**
| D7 | `publicFixture()` carrying `match_centre` via `loadMatchCentre` (spectator plan Task 9; `match-centre.ts` did NOT exist on the branch on 2026-09-05) | `apps/web/src/server/usecases/public.ts:263` | Only the ledger query could be shared | `recent` is loaded by our own `loadOverlayRecent` regardless; if `loadMatchCentre` exposes the loaded ledger/cfg/lineups, pass them in to avoid a second `score_events` read | **(re-pinned 2026-09-08 @ 60c0615b0): HELD — `usecases/public.ts:392-393` `const match_centre = await loadMatchCentre(sql, fixture, ctx); return { ...fixture, match_centre }`; `loadMatchCentre(sql, fixture: PublicFixture, ctx)` at `match-centre-load.ts:248` reads the ledger itself.**
| D8 | `TIMELINE_KEY_FOR` and the `timeline.*` dictionary keys (`feat/spectator-surface:apps/web/src/dictionaries/en/public.json:67-91`) | `public.json` | Informational only — W2 carries RAW engine types in `recent` and keeps its own `overlay.moment.*` keys, so a timeline template change cannot move a slab | — | **(re-pinned 2026-09-08 @ 60c0615b0): HELD — `lib/timeline-keys.ts:60` `TIMELINE_KEY_FOR`, `:31/:33/:35` the neutral / set-won / period-end keys.**
| D9 | `TimelineLine` — `match-centre-schema.ts:69` `{ seq, at, marker, sideIndex, text: Msg, emphasis }`; `match_centre.timeline: z.array(TimelineLine).nullable()` `:87` **(re-pinned 2026-09-08 @ 60c0615b0): NO event `type` on the line.** `text.key` = `TIMELINE_KEY_FOR[event.type]` (many-to-one for `core.lineup.*`, `KEY_OVERRIDE` per type, `TIMELINE_NEUTRAL_KEY` fallback); `emphasis` from `SCORE_EMPHASIS` / `STRONG_EMPHASIS` type sets (`timeline.ts:205`); `marker` = minute or `PERIOD mm:ss` (`:151`) | Task zero evaluates `match_centre.timeline` as the moments SOURCE: a kind is recoverable for the allowlisted scoring/card types by inverting `TIMELINE_KEY_FOR` (goal, card, point, rally, set/game summaries, shootout), not for lineup lines; derived set-won / period-end lines carry their own keys (`:33`, `:35`). F4 still holds — the source rides the OVERLAY ENDPOINT: the endpoint may embed a projected timeline slice (last N lines by `seq`) rather than the page double-polling | The fallback (`recentMomentEvents` with RAW types) if the inverted-key mapping is ambiguous for any allowlisted type |

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
`apps/web/src/lib/overlay-model.ts` (`overlayModel`, `OverlayModel`), `apps/web/src/components/overlay/{overlay-stage,overlay-bar,overlay-bug}.tsx`, `apps/web/src/components/public-site/match-centre/use-live-fixture.ts (re-pinned 2026-09-08 @ 60c0615b0: spectator W1 owns this path; the W1-skeleton path never lands)` (or D6), `apps/web/src/app/overlay/fixtures/[fixtureId]/page.tsx`, `apps/web/e2e/stream-overlay.spec.ts`.

W2 creates or modifies:

```
apps/web/src/lib/overlay-recent-types.ts                     NEW  pure types: RecentEvent, RecentPayload, RecentDerived, OverlayCricketLive (shared client/server)
apps/web/src/server/overlay/recent.ts                       NEW  buildOverlayRecent + recentWindow + personIdsIn + RECENT_PROJECT + loadRecentPersonOf (+ Step 7: probePointState, diffClosedSets)
apps/web/src/server/overlay/__tests__/recent.test.ts        NEW  pure: every stream FOLDED through the real module before it is projected
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

**Files — DESTINATION CORRECTED 2026-09-11 by task zero (W2-F1, W2-F9, W2-F10).**
`recent` goes on **`OverlayLiveData`, the overlay endpoint's projection**, NOT on
the public fixture payload: the overlay's ONE poll target is
`GET /api/v1/public/fixtures/[id]/overlay` and it no longer reads the public
fixture route at all. Putting it on `publicFixture` would ship a field the
overlay never receives.

- Create: `apps/web/src/lib/overlay-recent-types.ts`
- Create: `apps/web/src/server/overlay/recent.ts` (**under `server/overlay/`, not
  `server/public-site/`** — it is the overlay projection's own helper)
- Modify: `apps/web/src/server/overlay/project.ts:159-178` — the projector
  currently emits exactly `{ status, summary, outcome, lastSeq, venueTz, clock?,
  cricket? }`; `recent` is added there or it does not reach the overlay
- Modify: `apps/web/src/server/overlay/load.ts:76-81` — the ledger read and the
  **new lineup/person read** (see below)
- Modify: `apps/web/src/components/public-site/live-score-data.ts:59-71`
  (`OverlayLiveData`, NOT the shared `LiveFixtureData`)
- ~~Modify: `apps/web/src/app/overlay/fixtures/[fixtureId]/page.tsx`~~ — NO
  CHANGE NEEDED (measured 2026-09-11): its `initial` is
  `await loadOverlayLiveData(fixture.id)` verbatim, so `recent` arrives on first
  paint with no edit here.
- Modify: `scripts/smoke.ts` (one `check`, against the OVERLAY endpoint)
- Test: `apps/web/src/server/overlay/__tests__/recent.test.ts`
- Do NOT touch: `apps/web/src/server/usecases/public.ts`,
  `apps/web/src/server/public-site/data.ts`, the public fixture route, the
  engine, `live-score.tsx`.

**New work this task must carry, briefed as reuse and measured as absent
(W2-F7):** the consent resolver is NOT reachable from the overlay projection.
`server/overlay/{load,project}.ts` do no lineup or person read at all. Moment
lines name PEOPLE, so this task adds that path — `personOf` (type
`server/public-site/match-centre.ts:185`, built by `makePersonOf` `:214`) fed by
`readPublicLineups` (`server/public-site/public-lineups.ts:25,41`), which is the
single caller of `resolvePersonDisplayName` (`lib/name-display.ts:72`). Do NOT
reach for `maskPublicEntrantNames` (`data.ts:565`) — that is the ENTRANT-name
resolver and a different thing.

**Do NOT read `data.match_centre` on the overlay payload (W2-F2).** It
typechecks, because `OverlayLiveData extends LiveFixtureData`, and is always
`undefined` at runtime — the projector never sets it. A green `tsc` proves
nothing here.

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
// apps/web/src/server/overlay/recent.ts — SHIPPED 2026-09-11. The briefed
// `loadOverlayRecent(sql, fixture)` does NOT exist and is not owed: the fold
// already holds the void-resolved stream, so there is nothing to re-read.
export const RECENT_PROJECT: Readonly<Record<string, Project>>;   // keyed by ENGINE EVENT TYPE
export function recentWindow(active: readonly EventEnvelope[], window?: number): EventEnvelope[];
export function personIdsIn(window: readonly EventEnvelope[], sides: readonly [string, string]): string[];
export function buildOverlayRecent(args: {
  active: readonly EventEnvelope[]; sides: readonly [string, string];
  personOf: (id: unknown) => RecentPerson | undefined; window?: number;
}): RecentEvent[];
export function loadRecentPersonOf(
  sql: Sql, fixtureId: string, divisionId: string, ids: readonly string[],
): Promise<(id: unknown) => RecentPerson | undefined>;
// Step 7 adds `diffClosedSets` and the point-state probe beside these.
```

- [x] **Step 1: RE-PIN — DONE 2026-09-11 (task zero).** Outcomes and findings
  W2-F1…W2-F12 are in `_INDEX.md` § "2026-09-10 — W2 task zero". Pins that this
  task builds on, all re-verified at `main` `10c7f94cd`:
  `project.ts:159-178` (the emitted field set), `load.ts:76-81`,
  `live-score-data.ts:59-71` (`OverlayLiveData`), `timeline.ts:587` +
  `:80-92` (`buildTimeline`, `personOf` at `:91`), `match-centre.ts:185`/`:214`
  (`personOf`, `makePersonOf`), `public-lineups.ts:25,41`,
  `name-display.ts:72`, `data.ts:284` (`PublicFixture.last_seq`),
  `V216__score_events.sql:8,14` (gapless `seq`, `unique (fixture_id, seq)`),
  `append-event.ts:213,341-345` (`match_states.last_seq` upserted per append).
  Two further facts this task must honour: a void **appends** a `core.void` row
  so `last_seq` is strictly monotonic and cannot re-fire an old moment (W2-F5),
  and `resolveVoids` still filters at read, so the projection applies it.
  **The remaining greps in this step were aimed at `usecases/public.ts` and
  `public-site/data.ts`, which are no longer this task's files — dropped.**

- [x] **Step 2-6 — SHIPPED 2026-09-11 as the `recent` window (payload only).**
  Steps 2 to 6 as written below the line were STALE: they named
  `server/overlay/recent.ts`, `usecases/public.ts`,
  `public-site/data.ts` and the `stream-overlay` worktree — the destinations
  task zero had already struck (W2-F1/F9). They are replaced by what was
  actually built, which differs from the brief in three ways worth carrying
  forward.

  **What shipped** (`1a4dd53b6` and its parent):

  | | |
  |---|---|
  | Create | `apps/web/src/lib/overlay-recent-types.ts` — `RecentPerson`, `RecentPayload`, `RecentEvent`, `OVERLAY_RECENT_WINDOW = 8` |
  | Create | `apps/web/src/server/overlay/recent.ts` — `RECENT_PROJECT`, `recentWindow`, `personIdsIn`, `buildOverlayRecent`, `loadRecentPersonOf` |
  | Modify | `server/overlay/project.ts` — `recent` is passed IN and always emitted, even as `[]` |
  | Modify | `server/overlay/load.ts` — `recentOrEmpty`, best-effort like the fold |
  | Modify | `components/public-site/live-score-data.ts` — `recent?: RecentEvent[]` on `OverlayLiveData` |
  | Modify | `server/api-v1/openapi.ts` + the two generated `openapi/*.json` |
  | Modify | `scripts/smoke.ts` — four checks against the OVERLAY endpoint's own JSON |
  | Test | `server/overlay/__tests__/recent.test.ts` (17), plus 5 in `load.test.ts` and 2 in `project.test.ts` |

  **Three deviations from the brief, each measured:**

  1. **No second ledger read, and no `loadOverlayRecent` at all.**
     `FoldedFixture.active` IS the void-resolved stream (`engine-db/fold.ts`:
     `active: resolveVoids(envelopes)`) and `load.ts` already holds it. The
     briefed loader would have re-read `score_events`, `divisions`, `fixtures`,
     `stages` and the line-ups that `foldFixture` had just read — and been a
     second authority for which events survived.
  2. **The overlay PAGE needed no change.** Its `initial` is
     `await loadOverlayLiveData(fixture.id)` verbatim, so `recent` arrives on
     first paint with no edit. The brief listed `page.tsx` as a file to modify.
  3. **`personIdsIn` runs the projectors rather than listing payload keys.**
     The briefed `PERSON_KEYS = ["scorer", "person", "striker", …]` drifts from
     the projectors in both directions and both are defects — too many ids is a
     privacy floor breached (a cricket ball records a striker, a non-striker, a
     bowler and a fielder, and only the dismissed batter is ever spoken), too
     few is a moment that silently loses its name.

  **Two engine shapes the brief had wrong**, found by folding the test streams
  rather than trusting them: `CricketWicket.bowlerCredited` is REQUIRED, and
  `core.lineup.substitution` is `{ side, off: PersonId, on: LineupSlot }`, not
  `{ by, off, on }`.

  **Mutation sweep, 8 mutants, 8 killed** — but only after a fix: the wicket
  mutant (name the striker, not the dismissed batter) SURVIVED first time,
  because both cases dismissed the striker himself, so the right answer and the
  wrong one were the same person. Both now use a run out.

  **Verified:** `vitest src/server/overlay` 40/40, exit 0, paths confirmed in
  this worktree; `tsc` clean for `apps/web` and `tsconfig.scripts.json`; lint
  0 errors; `openapi:gen` regenerated and committed (the route carries no
  response schema, so only its summary moved).

  **Both verified since**: the DB-backed route test runs green against a live
  DB, and full smoke against a standalone prod server is 1034 passed / 0 failed
  with all four `recent` checks among them.

- [x] **Step 7: `derived` — SHIPPED 2026-09-11.** `recent` events carry
  `derived.setWon` (the event closed a set) and `derived.pointState` (one more
  point by a side would break serve, win the set or win the match), both asked
  of the module rather than computed here.

  **The input question, answered.** `FoldedFixture` CANNOT carry the module: it
  travels through `unstable_cache` on the overlay path, which serialises, and a
  module is an object of functions — it would arrive with its methods gone and
  every `unstable_cache` test in this repo would stay green, because they all
  double it with a passthrough. So `fold.ts` is split into `loadFoldInputs` +
  `foldFrom`, `foldFixture` is a thin wrapper over the two, and the overlay's
  cached entry computes BOTH halves from one load and one `resolveFixtureCfg`.

  | | |
  |---|---|
  | Modify | `server/engine-db/fold.ts` — `FoldInputs`, `loadFoldInputs`, `foldFrom`; `FoldedFixture` unchanged, so `rebuild.ts` and `admin-fixture-config.ts` are untouched |
  | Modify | `server/overlay/recent.ts` — `diffClosedSets`, `PROBE_POINT`, `probePointState`, `replayDerived` |
  | Modify | `server/overlay/load.ts` — one cached pass, key bumped to `overlay-fold-v2` |
  | Modify | `lib/overlay-recent-types.ts` — `RecentDerived`, `RecentEvent.derived?` |
  | Test | 15 more in `recent.test.ts`, `load.test.ts` rewritten (10), 2 more in the DB-backed route test |

  **How it works, and what is deliberately absent.** The replay is
  `buildTimeline`'s derived pass: ONE incremental walk applying each event once,
  diffing `setBreakdown(summary, sportKey)` for closed sets, degrading by
  STOPPING where the module refuses and reporting that rather than swallowing
  it. The point probe applies a synthetic point for each side and reads the
  result — so no set rule, tiebreak length or deciding-set variation appears in
  this codebase, and the probe refuses to run a type the module has not declared
  in its own `eventSchemas`. It runs from ONE event before the window, or the
  window's first entry cannot tell a transition from a continuation and every
  run of a match point reads as fresh.

  **Verified:** 3947 passed / 0 failed against a live DB (label `w2t1`); tsc
  clean for `apps/web` and `tsconfig.scripts.json`; lint 0 errors; mutation
  sweep **17/17** across both halves of the task. The DB-backed route test now
  drives ten real badminton appends under the sport's own `short` variant and
  reads the engine's set point off the route's JSON.

  **Five of the nine new mutants survived the first pass**, and every one was a
  real gap rather than an equivalent mutant — recorded in `_INDEX.md` as
  W2-F20, because three of them are the same shape and it will recur.

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
| football | `football.goal` → GOAL (led; own goal → OWN GOAL; `penalty` → line "{scorer} · Penalty", ruling 28); `football.card` → `colour` yellow → YELLOW CARD (caution), red / second_yellow → RED CARD / SECOND YELLOW (dismissal) | — |
| hockey | `hockey.goal` → GOAL; `hockey.suspension.start` → `class` green → GREEN CARD (caution), yellow → YELLOW CARD (caution), red → RED CARD (dismissal) | — |
| icehockey | `icehockey.goal` → GOAL; `icehockey.suspension.start` → PENALTY, line = the class label (minor, bench_minor, double_minor, major, misconduct → caution; game_misconduct, match → dismissal) | — |
| tennis | `tennis.point` with `kind === "ace"` → ACE (led) | `pointState.fresh`: break → BREAK POINT, set → SET POINT, match → MATCH POINT (led); `setWon` → SET {n}, line "{short} {home}–{away}" |
| badminton, tabletennis | — (the rally carries no shot kind) | `pointState.fresh`: set → GAME POINT, match → MATCH POINT; `setWon` → GAME {n} (unit from `GAME_UNIT_SPORTS`) |
| volleyball | — | `pointState.fresh`: set → SET POINT, match → MATCH POINT; `setWon` → SET {n} — **owner answer 21 (Q10), 2026-09-06: "Ok"**. Same probe as the racket sports; the spec's set-won-only line is superseded |
| boardgame, carrom, generic | none | none |

Sides' short names: `momentsFor` takes `sides: [string, string]` (the `short` W1's `overlayModel` already computes) so the set-won line can say who.

- [x] **Steps 1-5 — SHIPPED 2026-09-11.** `momentsFor`, `MOMENT_RULES`,
  `MOMENT_KEYS` and `maxSeq` in `apps/web/src/lib/overlay-moments.ts`; 30
  `overlay.moment.*` keys in all four locales; `i18n-keys.ts` regenerated;
  parity green. 35 tests, mutation sweep **11/11**, 2986 passed / 0 failed
  across `src/lib`, `src/server/overlay` and `src/components/public-site`; tsc
  clean, lint 0 errors.

  **Three corrections to the brief, each removing a SECOND AUTHORITY:**

  1. **No `overlay.moment.penaltyClass.*` family.** Those seven words already
     exist as `overlay.card.*` (W1's chip labels, `DISCIPLINE_LABEL_KEYS` in
     `lib/public-site.ts`) and already ship in four languages. The penalty
     moment's line goes through `disciplineLabel`, which is the existing
     resolver. 28 translations not written, and the chip and the slab cannot
     drift apart.
  2. **`GAME_UNIT_SPORTS` is EXPORTED, not restated.** The brief's
     `const GAME_UNIT = new Set([...])` would have been a second copy of a
     membership `setBreakdown` already owns.
  3. **Keys are plain strings against W1's `OverlayMsg`, not `MessageKey`.**
     `MsgFn`'s key type is `keyof typeof ui.json` and rejects every `overlay.*`
     key — those live in the `public` namespace. W1 hit this first and answered
     it with `OverlayMsg`; the union's safety is bought back by `MOMENT_KEYS`
     and a test holding it against the English dictionary.

  **Also corrected:** the card key is `overlay.moment.card.secondYellow`, not
  `.second_yellow` — this repo's dictionary convention is camelCase
  (`overlay.card.benchMinor`), and the rule maps the engine's snake_case class
  to it.

  **Two mutants survived the first pass**, both real:

  - **An unknown card colour could be given a GUESSED tone.** The colour and the
    tone lived in two parallel records, so "a key with no tone" was a state no
    test could witness — the guard was decoration. The two are now ONE table, so
    the state cannot be expressed at all.
  - **A sport with no allowlist fell through to football's rules.** The negative
    case used a type nobody honours, so "no rules" and "football's rules"
    answered alike. The case that tells them apart is an unknown sport carrying
    a type football DOES honour.

  **Test-harness facts worth keeping:** the engine refuses `second_yellow` for a
  player with no prior caution, so the card stream books the player first; and
  the suspension-tone coverage test derives its class list from each module's
  own parsed config, so a federation sheet adding a class reds rather than
  rendering toneless.

### Task 3: The cricket bar's batter-and-bowler line

**Files:**
- Create: `apps/web/src/lib/overlay-cricket.ts`
- Modify: `apps/web/src/lib/overlay-model.ts` (W1; `detail` for cricket)
- Modify (variant B/C only): `apps/web/src/server/overlay/recent.ts`, `apps/web/src/lib/overlay-recent-types.ts`, `apps/web/src/components/public-site/live-score-data.ts`
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
  `cd /Users/ashokhein/github/seazn.club/.claude/worktrees/stream-w2 && /usr/bin/git add apps/web/src/lib/overlay-cricket.ts apps/web/src/lib/__tests__/overlay-cricket.test.ts apps/web/src/lib/overlay-model.ts apps/web/src/lib/__tests__/overlay-model.test.ts && /usr/bin/git commit -o apps/web/src/lib/overlay-cricket.ts apps/web/src/lib/__tests__/overlay-cricket.test.ts apps/web/src/lib/overlay-model.ts apps/web/src/lib/__tests__/overlay-model.test.ts -m "overlay(cricket): the bar's second band carries the batters at the crease and the bowler's figures, from the match-centre live block" -m "Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>" -m "Claude-Session: https://claude.ai/code/session_01UdUR7dcxassJ4FExpVfRRr"`
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

- [x] **Steps 1-5 — SHIPPED 2026-09-11.** `moment-timing.ts`, `moment-queue.ts`
  (pure reducer), `use-moment-queue.ts`, `overlay-moment.tsx`, the slab CSS in
  `globals.css`, stage wiring, and three e2e tests in W1's own spec file.

  **Mutation sweep 9/9** after three survivors, one of which was a LATENT BUG
  rather than a missing test: the batch was deduped against history but never
  against itself, so two identical moments in one array would both have queued.
  A second (`nextDeadline`'s `current === null` clause) was unreachable and was
  removed rather than witnessed.

  **A real defect the contact sheet caught: THERE ARE THREE THEMES.** `slate`
  paints no scorebug — it COMPOSITES one, `defaultThemeFor(sportKey)` (§4a) — so
  reading `props.style` alone gave the slab the BAR's geometry under
  `?style=slate` while the BUG was on screen. Wrong for ten of the eleven
  sports, right for cricket only by accident. `slabPlacementFor(style, sportKey)`
  now answers it, beside `defaultThemeFor` so the two cannot drift.

  **The slot is a CLIPPING WINDOW at the emergence point, not the canvas.** An
  `inset: 0` slot cannot hide anything: translating a 185 px slab by its own
  width still leaves it on a 1920 px canvas, painted over the scorebug.

  **Placement measured rather than assumed** — bar slab at x=72 (the bar's own
  left inset), bug slab at x=540 (the bug's right edge, §4's `left 60` +
  `width 480`), headline inset 33 in both, height 216.

  **OPEN, and it is the sheet's problem rather than the code's:** §5 says the bar
  slab is "centred under the bar's detail band" with radius `0 0 6 6`, but §3
  puts the bar at `bottom: 54` standing 177 tall — 54 px of canvas against a
  216 px slab. The interim reading (slab ABOVE the bar, bottom tucked behind it,
  corners rounded at the top) is built and filmed; the sheet has not been
  amended, because rewriting an owner-approved section to match what was built
  is not a decision this wave gets to make alone.

  **Verified:** the WHOLE `stream-overlay.spec.ts` 19/19 (run whole, never a
  `-g` slice); `mobile.spec.ts` 298/298 across the seven widths; 607 unit tests
  in `src/components/overlay`.

  **One coupling removed:** the moments describe seeds its OWN rig. The file is
  serial around one shared hockey fixture and a test above DECIDES it, so
  appending answered `422 ALREADY_DECIDED`. Reordering would have worked today
  and broken the next time somebody added a test.

### Task 5: Dictionary coverage from the engine's enums, the visual gate, the index

**Files:**
- Create: `apps/web/src/lib/__tests__/overlay-moment-dictionary.test.ts`
- Modify: `apps/web/src/dictionaries/{en,es,fr,nl}/public.json` (`overlay.cricket.*` from Task 3 if not yet added; any key the coverage test finds missing)
- Modify or create: `apps/web/e2e/walkthrough/stream-overlay-capture.spec.ts` (RE-PIN: `grep -arl "overlay" apps/web/e2e/walkthrough/*.spec.ts`; if W1 named its capture spec differently, extend THAT file; if none exists, create this one — it is matched by `WALKTHROUGH`)
- Modify: `docs/superpowers/specs/2026-09-05-stream-overlay-prompts/_INDEX.md`

- [x] **Steps 1-5 — SHIPPED 2026-09-11.**
  `lib/__tests__/overlay-moment-dictionary.test.ts` (9 tests) and
  `e2e/overlay-moments.capture.ts` (5 scenes, all captured and verified).

  **The brief's `overlay.moment.penaltyClass.*` family was NOT created.** Those
  seven words already exist as `overlay.card.*` — W1's chip labels, mapped by
  `DISCIPLINE_LABEL_KEYS`, already in four locales — so the slab borrows them
  through `disciplineLabel` and the gate checks those. 28 translations not
  written, and the chip and the slab cannot drift apart.

  **`enumMembers` is the file's spine.** It reads `.options` or `.enum`,
  whichever this zod version exposes, and THROWS when neither yields members —
  an empty list would turn every sweep into a vacuous pass. Proven by emptying
  it: the throw fires at import and the suite goes red rather than
  green-with-a-hole.

  **The capture harness is COMMITTED, which W1's was not.** W1's contact sheet
  was produced ad hoc and left nothing to reproduce it, so this wave re-derived
  the whole rig. The `gallery` project's `testMatch` widens from one file to any
  `*.capture.ts`; before that a second harness matched NO project and could not
  be invoked at all.

  **`settled()` rather than `data-phase`.** The attribute flips when the CSS
  transition STARTS, not when it ends, so every screenshot taken on it was a
  motion frame — and a slab halfway out from behind the scorebug photographs
  exactly like one whose text overflows. That cost an hour and a wrong bug
  report before it was understood.

  **Owed to the owner, not to CI:** per-screen verdicts on the five scenes.
  "The gate passed" is not sign-off. **Given 2026-09-11** on the three frames
  re-shot after the review fixes (ruling 29); the earlier five are superseded.

### Task 6: Gates, review loop, PR

**OUTCOME, 2026-09-11.** Gates all green (counts in `W2-review.md`). The
reviewer pass returned **Needs fixes** with five findings, three of them
live-broadcast defects, on a branch that was already green and had had a clean
review on every individual task — fixed in `cbba5f28c`, recorded as W2-F35…F39.
A sixth item the review raised rather than changed, the penalty goal dropping
its scorer's name, was ruled the same day and fixed (ruling 28).


- [x] Full `apps/web` vitest from `apps/web` with the DB env and the JSON reporter (`/tmp/seazn-env/ovl/w2-full.json`): paste `numTotalTests / numPassedTests / numFailedTests` and confirm zero `numFailedTestSuites` (a suite that failed to COLLECT reads as `numFailedTests: 0`). Engine suite unchanged (`cd packages/engine && pnpm exec vitest run --reporter=json --outputFile=/tmp/seazn-env/ovl/w2-engine.json`) — W2 must not have touched it; confirm the count equals main's.
- [x] `rtk proxy pnpm lint` and read `✖ N problems` yourself; `pnpm typecheck` in both workspaces (the local build no longer typechecks); `pnpm openapi:gen` + `/usr/bin/git status --porcelain openapi` empty; `pnpm i18n:check`.
- [x] Smoke locally (`SMOKE_BASE=http://127.0.0.1:<port> node --experimental-strip-types scripts/smoke.ts` per the script's own header) — the new `recent` checks pass.
- [x] Reviewer pass (Opus) on the whole branch diff since the W1 merge base, findings written to `docs/superpowers/specs/2026-09-05-stream-overlay-prompts/W2-review.md`, fixed inline; never skip because every task review was clean.
- [x] `workflow_dispatch` e2e — **the owner chose dispatch against the BRANCH REF** rather than waiting on a PR number (`gh workflow run e2e.yml --ref feat/stream-w2-moments`; the workflow checks out `github.sha` when `inputs.pr` is empty). Per-screen visual verdicts: **accepted 2026-09-11** on the three re-shot frames (ruling 29). PR still owner-gated.

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
| Drop the consent call (`personOf` returns `full_name`) | `server/overlay/__tests__/recent.test.ts` "names on recent are the consent resolver's output, not the stored full name"; e2e OUT case (`not.toContainText(fullName)`) |
| Shorten the hold to 0 (`OVERLAY_MOMENT_HOLD_MS = 0`) | `moment-queue.test.ts` "the default hold is four seconds…" (pins the DEFAULT) and "idle + enqueue → in… hold with deadline now+hold"; e2e `toHaveText(/GOAL/)` reds because the slab is gone before the poll |
| `fresh` always true | `server/overlay/__tests__/recent.test.ts` "…the next point (Ad) is not fresh"; `overlay-moments.test.ts` racket case counts two break-point moments, not three |
| Remove the `probe.type in eventSchemas` guard | `server/overlay/__tests__/recent.test.ts` badminton spy test |
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
