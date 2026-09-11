# W2 — moments (SIX · OUT · GOAL · MATCH POINT) and the cricket batter/bowler line

**Look at the canvas first** —
https://claude.ai/code/artifact/2aebcbde-28ba-45ff-9028-1151873e4901 — this
wave's artboard is **"Moments"**: the SIX, OUT, GOAL and MATCH POINT slabs
beside the bug, each in its sport's own colour. Then read
`_RULES.md` → `_INDEX.md` → `W1-step-one.md` (the slot this wave fills) →
`_THEMES.md` §5 (the moment slab: tones, sizes, Barlow 800), §6 (slab row of
the motion table), §3 (the cricket detail band cells marked W2) →
**the design of record is now `../2026-09-07-streaming-programme-design.md`**
(§3.2 the overlay endpoint, §3.4 `OverlayMoment`, §3.6 motion, §13 findings
F3/F4 — re-pinned 2026-09-07 @ fb99bbd4c; the 09-05 design is superseded and
kept for the canvas and the approval record). Plan:
`../../plans/2026-09-05-stream-overlay-w2-moments.md` (being written by a Fable
agent 2026-09-05; absent when this file was written; the plan's task order wins,
this file's rulings win, a conflict is an `_INDEX.md` finding). Worktree
`.claude/worktrees/stream-overlay`; **one PR (PR2)**. **Spectator W1 MERGED 2026-09-08 (#743, `main` 60c0615b0) — the gate is OPEN; executes only after
every row of the RE-PIN table
below has been re-verified against the merged tree** (R4, R11). PR1 must have
merged first.

## Why the wave exists

A broadcast score that never reacts is a scoreboard. The owner's first question
after the two themes was "showing out, 4 or 6" — the moment a wicket falls or a
six clears the rope is the moment the stream needs the graphic, and the cricket
bar without a batter and bowler line is half a lower third. Both were deferred to
step two because their source — a per-event template model with sequence numbers
in the public payload — is being built by spectator W1, and building a second
one here would be the second authority for the same fact.

## Owner rulings that bind this wave (verbatim, 2026-09-05)

- "showing out, 4 or 6" → moments exist; the owner named the cricket ones.
- "all sports" → every sport whose module declares the event gets its moment;
  board game, carrom and generic render none, by construction.
- "will we do animation when score?" → the slab is the ONE motion this wave
  adds (R13): 250 ms out, 4 s hold, 250 ms back, FIFO queue,
  `prefers-reduced-motion` ⇒ instant show and hide.
- "use OPus SubAgent" → `model: opus` on every dispatch.

## The dependency — RE-PIN AT EXECUTION

Everything in this table was read on `feat/spectator-surface` (worktree
`.claude/worktrees/spectator`) on 2026-09-05 while that wave was still in
flight. **Every line number is branch-relative and every shape may have moved
by the time W1 merges.** The first task of this wave is to re-pin each row on
`main` after the merge and record the outcome in the plan; a row that no
longer holds is a finding, not a blocker.

| As read 2026-09-05 (`feat/spectator-surface`) | What this wave needs from it |
|---|---|
| **F4 (re-pinned 2026-09-07 @ fb99bbd4c, design §3.2/§13):** the overlay no longer polls `GET /api/v1/public/fixtures/[id]` — its ONE poll target is the **overlay endpoint** `GET /api/v1/public/fixtures/[id]/overlay` (`OverlayLiveData`, W1 scope 2b). R5's "same payload" referent is therefore the overlay endpoint: the moments source (W1's field, if it carries event types) AND the fallback both ride `OverlayLiveData` — no double poll, never a second endpoint | Task zero adds the chosen source as a field on `OverlayLiveData` (server-side projection beside `clock`/`cricket`), and the spectator payload `match_centre` is READ by that projection, not polled by the overlay |
| `apps/web/src/server/public-site/match-centre-schema.ts:59-72` `MatchCentreDoc { fixtureId, sportKey, header, tabs, cricket, timeline, sets, info, derivedComplete }`; wire field `match_centre` (snake_case, `:4`) on the public fixture JSON | Whether the merged public fixture row / `publicFixture()` (`usecases/public.ts:279` at `ac85c70`) carries it so the overlay endpoint's projection can read it server-side (F4 above) | **(re-pinned 2026-09-08 @ 60c0615b0): HELD, moved — `MatchCentreDoc` is `match-centre-schema.ts:85-97`, `timeline: z.array(TimelineLine).nullable()` at `:87`; `publicFixture()` returns `{ ...fixture, match_centre }` (`usecases/public.ts:392-393`) — the field IS on the public payload.** |
| `:44` `TimelineLine { seq, at, marker, sideIndex, text: Msg{key,params}, emphasis }` — carries `seq` but **NOT the raw event `type`** | A per-sport allowlist keyed on EVENT TYPE cannot be applied to this line as read. `TIMELINE_KEY_FOR` (`@/lib/timeline-keys`, re-exported at `timeline.ts:107-110`) maps type → dictionary key and **several sports share one template** (`timeline.ts:35`), so inverting key → type is lossy. Do NOT invert. If W1 lands with `type` (or an equivalent) on the line or on a `recentEvents` array, use it; if not, use the fallback below | **(re-pinned 2026-09-08 @ 60c0615b0): HELD, moved — `TimelineLine` is `:69` and STILL carries NO event `type`: `text.key` = `TIMELINE_KEY_FOR[event.type]` (`lib/timeline-keys.ts:60`, many-to-one for `core.lineup.*`, overridable by `KEY_OVERRIDE`, neutral fallback), `emphasis` ∈ score/strong/normal from type SETS (`timeline.ts:205`), `marker` = the minute or `PERIOD mm:ss` string (`:151`). So a kind is recoverable for the scoring/card types W2 allowlists by inverting the key table, not for lineup events; the fallback (raw types via the overlay endpoint) remains the honest source — decide at task zero.** |
| `timeline.ts:587` `buildTimeline(args: TimelineArgs): TimelineResult`; `TimelineArgs { sportKey, events, module, cfg, lineups, sides, personOf }` (`:80-92`) | `personOf: (personId) => PersonT` is consent-resolved by the caller (`public-lineups.ts`) — the resolver to reuse for names on moments (R17) | **(re-pinned 2026-09-08 @ 60c0615b0): HELD — `buildTimeline` `timeline.ts:587`, `TimelineArgs` `:80-92`, `loadMatchCentre` `match-centre-load.ts:248` calls it with the ledger it already reads.** |
| **(re-pinned 2026-09-08 @ 60c0615b0)** The live transport is `apps/web/src/components/public-site/match-centre/use-live-fixture.ts` (`useLiveFixture` `:17`, returns `{ data, transport }`; W1 widens it to `{ fetcher, delayMs? }` + `presentationNowOffsetMs`); `live-score.tsx` exports only `LiveScoreBody`, the `LiveScore` wrapper is retired | The overlay stage reads `data` (the overlay endpoint's payload) from THIS hook; moments diff `lastSeq` on that payload — no second hook, no second poll (F4) |
| `match-centre-schema.ts:11` `Side { entrantId, name, short, colour, badgeUrl }`; `:14-24` `MatchCentreHeader { battingIndex, statusLine, rateLine, … }` | `Side.short` may supersede W1-overlay's three-letter fallback (watch-list 6); `battingIndex` may supersede the overlay's own `led` derivation — if so, ONE authority: repoint the overlay, delete the duplicate |
| `:37-43` `CricketView.live { striker, nonStriker, bowler, batters, bowling, thisOver, partnership, lastWicket }` | The batter/bowler line's source. `CricketBattingRow { person, runs, balls, … }`, `CricketBowlingRow { person, overs, maidens, runs, wickets, … }` (`:26-27`) |
| Spectator `_RULES.md` R3 (consent), R4 (band ladder from the engine: cricket band 2 = `cricket.player.line`, band 3 = balls), R10 (live means live, never reload) | A band-0/1 cricket match has NO balls and NO lines: the batter line is ABSENT, not "—", and no ball-level moment can fire; the slab must still fire on card-level events (wicket via `cricket.player.line`? — re-pin which events a band-2 ledger records) |

**Fallback (if W1's payload does not carry event types, or W1 has not merged
when the owner wants moments):** a server helper of our own,
`apps/web/src/server/public-site/overlay-moments.ts`,
`recentMomentEvents(fixtureId, afterSeq: number, limit = 8)` reading
`score_events (fixture_id, seq, type, payload, voids_event_id)`
(`db/migration/v2-engine/tables/V216__score_events.sql:4-16`; `unique
(fixture_id, seq)`, index `(fixture_id, seq)`), excluding voided rows, projecting
ONLY `{ seq, type, <allowlisted payload fields> }` with person ids resolved
through `resolvePersonDisplayName` (`lib/name-display.ts:72`) /
`maskPublicEntrantNames` (`server/public-site/data.ts:510`) — surfaced as
`recentEvents` on **`OverlayLiveData`** (the overlay endpoint's projection,
W1 scope 2b — F4, re-pinned 2026-09-07 @ fb99bbd4c; NOT on the public fixture
JSON, which the overlay no longer polls), and on the OpenAPI public document
entry for the overlay endpoint (R7). Never a raw payload dump: a `cricket.ball` payload
carries more than a fan may see. The cricket batter line's fallback is a
server-side `foldMatch` (`packages/engine/src/core/events.ts:445`) with the real
cricket module in the same helper, projecting striker*/non-striker `runs(balls)`
and bowler `O-M-R-W` — never retyped cricket maths.

## Scope

1. **Interface and projection** — `apps/web/src/lib/overlay-moments.ts` (pure,
   client-safe, no `@/server/**`): the `OverlayMoment { kind; headline; line?;
   tone }` type W1 exported moves here (W1 re-exports it); `momentsFrom({
   sportKey, events: { seq, type, … }[], seenSeq, sides, msg }): { moments:
   OverlayMoment[]; seenSeq: number }` — filters by the allowlist, drops
   `seq <= seenSeq`, returns in ascending seq (FIFO), advances `seenSeq` to the
   max seq SEEN (allowlisted or not — an unlisted event still counts as seen,
   or it would be re-scanned forever).
2. **Allowlist** — **CORRECTED 2026-09-11: a flat `Record<eventType, {tone}>` map
   CANNOT express this and the plan already knows it.** Cricket's four, six and
   wicket are payload fields of `cricket.ball` (`boundary: 4|6`, `wicket`), not
   discrete types, and hockey/ice-hockey cards are `*.suspension.start` — there
   is no `*.card`. Use the plan's shape: `MOMENT_RULES: Record<sportKey,
   Record<string, (ev, ctx) => OverlayMoment | null>>`, matching on
   `(type, payload)`. The rows below are right about WHICH moments exist and
   wrong only about the lookup shape. `MOMENT_TYPES: Record<sportKey,
   Record<eventType, { tone; headlineKey; lineKey? }>>` per spec: cricket boundary four and six (`led`),
   wicket (`dismissal`); football goal (`led`), card (`caution`); hockey and ice
   hockey goal and card; tennis, badminton, table tennis: ace where the module
   records it, break point, set point, match point, set won (`led`);
   **volleyball set won, set point AND match point** (F3 — owner Q10,
   2026-09-06; re-pinned 2026-09-07 @ fb99bbd4c: set/match point are
   state-derived for volleyball per the module note, never an event match).
   **No entries** for boardgame, carrom, generic. The exact event type
   strings are read from each module's declared event schemas at plan time and
   a unit test derives them again at run time (`registry.ts:35,89`; the fold
   pattern `view-model.test.ts:8-12`) so a renamed event type fails the test
   rather than silently muting a moment. "Match point" and "set point" are
   STATE, not events, in some modules — if a module does not emit them as
   events, they are derived from the post-fold summary (`servingSide`,
   `setBreakdown` from `@/lib/public-site`), never from a retyped rule; the plan
   records per module which of the two it is.
3. **Headlines and lines** — dictionary keys `public.overlay.moment.<kind>`
   ("SIX", "OUT", "GOAL", "MATCH POINT", …) and `public.overlay.momentLine.<kind>`
   ("{name} c {fielder} b {bowler}", "{name} {minute}'"), four locales, keys
   regenerated (R14). Names via the consent resolver (R17): a masked person
   renders the masked label; the slab never renders blank.
4. **Stage and slab** — `overlay-stage.tsx` keeps `seenSeq` in a ref initialised
   to the fixture's `last_seq` (`PublicFixture.last_seq`, `data.ts:206`) AT
   MOUNT — **history never replays on load or reconnect** (R13: OBS shows the
   page mid-stream). On every new `data` from `useLiveFixture` it calls
   `momentsFrom` and pushes results onto a FIFO queue; `overlay-moment.tsx`
   shows the head for 4 s (`HOLD_MS` constant, env-tunable for tests the way
   the pad's is — the guard that pins its VALUE tests the DEFAULT), then
   dequeues. Attached to the bug (slides out) or under the bar (slides up),
   250 ms, `transform`/`opacity` only, LED colour for `led`, `--sport-caution`
   for cards, `--sport-dismissal` for wickets. `@media (prefers-reduced-motion:
   reduce)` ⇒ no transition, same 4 s hold. Testids `ovl-moment`,
   `ovl-moment[data-tone]`, `ovl-moment[data-kind]`, `ovl-moment-queue-depth`
   (a data attribute, for the e2e).
5. **Cricket batter/bowler line** — `overlayModel` fills `detail` for cricket:
   `"{striker}* {runs} ({balls})"`, `"{nonStriker} {runs} ({balls})"`,
   `"{bowler} {overs}-{maidens}-{runs}-{wickets}"` from `CricketView.live`
   (RE-PIN) or the fallback fold; absent (not "—") below band 2 or when no
   batter is at the crease. Notation stays notation with localised `title`.
   The bar renders `detail` as its second band; the bug shows the striker line
   only (owner artboard "B · Corner bug").
6. **Tests, smoke, visual, inventory, `_INDEX.md`** — below.

## Do NOT touch

Spectator W1's model, schemas, `buildTimeline`, `timeline-keys` or dictionaries
(import, never edit; a missing field is a request to that programme's owner via
recommendation, never a local patch); the scorepad and skins; the engine; W1
overlay's three motions; `LiveScoreBody` / `MatchCentre` / the shared `match-centre/use-live-fixture.ts` beyond W1's widening (re-pinned 2026-09-08 @ 60c0615b0); the panel (nothing new is configured — a
moment is not a setting); the entitlement matrix; `stages-panel.tsx`.

## Acceptance — all four test kinds, with the assertions named

- **Unit** (`lib/__tests__/overlay-moments.test.ts`, node env):
  - EMPTY first: no events → `moments: []`, `seenSeq` unchanged.
  - **"unlisted event type renders nothing"**: `core.start`, a dot-ball
    `cricket.ball`, `some.future.type`, and every event of a boardgame, carrom
    and generic ledger → `moments: []`, but `seenSeq` ADVANCED past them.
  - **"already-seen seq fires nothing"**: the same events with `seenSeq` = max
    seq → `[]`; then ONE new allowlisted event appended → exactly one moment
    (the positive pair; both directions of the idempotency guard).
  - Per sport, a real folded ledger (`foldMatch`, `events.ts:445`) containing
    the allowlisted events → the expected `kind`/`tone` sequence in ascending
    seq (FIFO order asserted with an ORDER-differential case: a six then a
    wicket must not come out wicket-first).
  - Every allowlisted type string exists in its module's declared event types
    (derived from the registry, never typed into the test).
  - Consent: a masked person → the masked label in `line`, never `""`; a team
    entrant → no person lookup.
  - Batter line: from a band-3 fold, striker marked `*`, bowler figures
    `O-M-R-W` match the engine's own scorecard for the same ledger; from a
    band-1 fold → `detail: []`.
  - **Mutants, per surface, recorded with their killer:** (a) delete the `seq <=
    seenSeq` filter; (b) delete the allowlist lookup (return every event); (c)
    swap `dismissal` and `led` tones; (d) sort descending; (e) stop advancing
    `seenSeq` on unlisted events; (f) drop the striker asterisk; (g) set
    `HOLD_MS` to 0 (killed by the e2e hold assertion); (h) initialise `seenSeq`
    to 0 at mount (killed by the e2e reload case).
- **E2E** (extend `apps/web/e2e/walkthrough/stream-overlay.spec.ts`; whole file
  runs; budget `Math.max(FLOOR, base + moments * (HOLD_MS + POLL_MS + slack))`):
  - Cricket, anonymous overlay open, post a six → `ovl-moment[data-kind="six"]`
    visible within one poll, gone after `HOLD_MS` + 250 ms (mutant g); post a
    wicket → `data-tone="dismissal"` and the line names the batter (consent
    resolved; assert the masked case on a second, opted-out player).
  - Two events posted back to back → the first is STILL shown when the second
    arrives (`ovl-moment-queue-depth="1"`), then the second follows — FIFO on
    the wire, not only in the unit.
  - Reload the overlay mid-match after several moments have happened → NO slab
    appears for any past event (mutant h); post one more → it fires.
  - `page.emulateMedia({ reducedMotion: "reduce" })` → the slab appears with no
    transition class and still holds 4 s.
  - Football fixture: goal → `led`, yellow card → `caution`; a board-game
    fixture: a full result posted → `ovl-moment` never attached.
  - Cricket bar: `ovl-detail` carries three lines with the striker's `*`; below
    band 2 the band is absent (`toHaveCount(0)`), and `ovl-root` still renders.
- **Smoke**: the public fixture JSON for a seeded cricket fixture carries
  whichever field the moments read (W1's `match_centre` with event types, or
  `recentEvents`) — the seam proven on the wire; and that field never carries a
  person id for a masked person.
- **Regression**: W1's overlay e2e (tick on the changed side only, 404/200 gate,
  panel control set) green unchanged; `live-score.test.tsx` unchanged;
  spectator W1's own public-site suites unchanged in count; the whole
  `mobile.spec.ts` file; `openapi:gen` and `gen-keys` no diff; `tsc` clean.
- **Visual gate**: slab in each tone (`led`, `caution`, `dismissal`) on bar AND
  bug at 1920×1080, cricket bar with the batter line, reduced-motion frame —
  images exist and differ; owner per-screen verdicts; composite over a light
  and a dark video frame.

## Inventory (pasted into the PR description)

The RE-PIN table with each row's outcome on merged `main` (held / moved / gone
and what replaced it); which source the moments read (W1 field or fallback) and
why; the allowlist as landed per sport with the module-declared type strings;
per-module note on event vs derived for match/set point; dictionary keys per
locale; vitest and Playwright counts from the JSON reports; the mutant table
a–h; screenshot list with hashes.

## PR shape and gates

One PR after PR1 and spectator W1 are both on `main`; rebase before the gate,
not after. Gates as `_RULES.md` §Merge gates 1–8. If the fallback source was
used, the PR says so in its first paragraph and `_INDEX.md` records the
recommendation to the spectator programme (send the RECOMMENDATION with its
reasoning; never "the owner ruled").

## Dispatch notes (for the orchestrator)

- Task zero is the RE-PIN, by a scout, `model: opus`, read-only, output the
  table with outcomes — under 15 lines plus the table. Nothing is built before
  its result is in the plan.
- Lanes: (A) `overlay-moments.ts` + allowlist + unit tests; (B) server source
  (W1 field wiring OR the fallback helper + public JSON + OpenAPI); (C) the
  slab component + stage wiring + e2e — C depends on A and B. Batter line
  rides with A (model) and B (source).
- Every brief carries the five things and the cap: **"final message under 15
  lines — counts, paths, deviations, blockers; no file contents or diffs."**
  `model: opus`; shell guard restated; `cd <worktree> &&` on every verify.
- Reviewer after each lane and on the whole branch; the orchestrator reruns the
  full gate and pastes counts. A stopped agent is resumed, never restarted.

## False-premise watch list (re-pin before building on any)

1. That W1's public payload carries raw event TYPES — as read it does NOT
   (`TimelineLine` has `seq` + a dictionary key). Decide source in task zero.
2. That "match point" / "set point" are events in every racket module — likely
   STATE in some; the plan records which per module.
3. That `PublicFixture.last_seq` is the ledger's max seq INCLUDING voided
   events — pin how voids move it, or the first poll after a void re-fires.
4. That one consent resolver serves both entrant names and person names on this
   branch after the merge (`maskPublicEntrantNames` `data.ts:510`,
   `resolvePersonDisplayName` `name-display.ts:72`, W1's `personOf`) — pin ONE.
5. That a band-2 cricket ledger records a wicket as a discrete event; if the
   wicket arrives only inside `cricket.player.line`, the OUT moment needs a
   diff of lines, not a type match.
6. That `HOLD_MS` can be env-tunable without the value guard following the live
   value — it must pin the DEFAULT (AGENTS.md failure class 20).
7. That spectator W1's `Side.short` and `battingIndex` are on the wire when the
   overlay renders — if yes, retire the overlay's own copies (one authority).
