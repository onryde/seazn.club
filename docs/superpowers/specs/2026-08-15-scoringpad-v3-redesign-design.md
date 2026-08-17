# ScoringPad v3 — design of record

Status: **APPROVED by owner 2026-08-15** (sections approved verbatim in-session).
Supersedes the v2 pad's *visual and interaction* layer only; the v2 substrate
(pipeline, queue, ledger, transport, vocab, `padSpec`) survives. Predecessor
programme: `2026-08-06-scoringpad-v2-prompts/_INDEX.md` (S1–S13, closed
2026-08-14, #570). Its standing rulings bind here: **fidelity ladder closed at
0–3, no second fidelity vocabulary, "doc 14" does not exist** — the fidelity
semantics live in `packages/engine/src/sport/module.ts` alone.

Evidence artifacts (owner-reviewed):

- Baseline gallery (v1 vs v2, per-screen IDs):
  <https://claude.ai/code/artifact/afdf2a1a-33d5-41d6-9b94-a485ced418b6>
- Direction comps / tap-model head-to-head:
  <https://claude.ai/code/artifact/c96496b9-4231-482a-85a0-d913cc25788b>

## 0. Owner rulings (verbatim intent, do not re-litigate)

1. v3 happens regardless; v2 rejected wholesale. v1's **tap-to-score** feel
   (badminton/tennis/chess) is the interaction foundation; v3 must still
   "feed all info".
2. **11 per-sport skins, variant-aware via cfg, shared chassis** — no
   universal renderer for real sports; literal per-variant components (29
   combos) rejected; family skins rejected.
3. **Theme: daylight product shell + stadium-night LCD scorebug tile** (the
   ice-hockey tile generalised — the one v2 element the owner kept).
4. **Detail: ribbon + transient ~6s dock** over always-visible ledger.
5. **Tap model: HYBRID** — MODEL-S (scoreboard halves are the buttons) for
   point-per-rally sports: tennis, badminton, tabletennis, volleyball,
   boardgame, generic. MODEL-T (passive scorebug + tile grid) for
   keypad/event-board sports: cricket, football, hockey, icehockey, carrom.
6. **One pad component on both surfaces.** Console wraps it with authority
   chrome; device link is the bare pad (day-scoped, fixture-scoped,
   cannot finalize — current semantics kept).
7. All 11 sports redesigned; **cricket + football first**. No interim hotfix.
8. **Per-screen visual sign-off is a merge gate**: gallery artifact + live
   walkthrough per wave, before merge (owner rule of 2026-07-19 generalised).
9. Everything derives from the product theme tokens
   (`apps/web/src/app/globals.css` floodlit-daylight + `--mk-*` night set).

## 1. Architecture

- `apps/web/src/components/v2/scorepad/` is reworked in place (path keeps the
  `v2` segment until R8's cleanup; renames are churn, not design).
- **Chassis** (shared): pipeline (`use-pad-pipeline.ts` — untouched semantics),
  transport, queue store, i18n vocab (S7 `PadLabel` namespace), plus the new
  primitives of §2.
- **Skins**: one file per sport — `skins/cricket.tsx`, `football.tsx`,
  `tennis.tsx`, `badminton.tsx`, `tabletennis.tsx`, `volleyball.tsx`,
  `hockey.tsx`, `icehockey.tsx`, `boardgame.tsx`, `carrom.tsx`, `generic.tsx`.
  Hockey/icehockey may share a `period-shared.ts` helper lib but each owns its
  file and declarations. The racquet family skin is split.
- **Registry totality gate**: a build-time/test gate asserts every engine
  module key resolves to a skin (S11's coverage-gate pattern, mutation-proved).
  No universal fallback path remains for the 11 sports; the fallback branch is
  deleted, not left inert.
- **Dies**: universal renderer usage for real sports, the raw fidelity picker,
  the console's duplicate Activity card, entrant-label rendering for
  individual/pair entrants, the always-open period goal form.
- **Survives byte-for-byte**: ledger semantics (`core.void` undo after send),
  offline queue durability, device-link auth, realtime reconcile, engine
  `padSpec(cfg)` as the action-vocabulary source.

## 2. Chassis primitives

### 2.1 Scorebug (night tile)

Night ground (`--mk-night` gradient per the comps), lime LCD numerals
(Barlow Condensed numerals, `font-variant-numeric: tabular-nums`), inside the
daylight card shell. Slots, all data-driven from the skin:

```
ScorebugSpec = {
  topLeft, topRight            // context line + live/sync state
  halves: [{ who, big, hint?, tappable?, onTap? }, { … }]
  strip?: ReactNode            // over dots, serve rotation, sets, clock…
}
```

`tappable: true` renders the dashed-lime affordance and makes the half a
44px+ button (MODEL-S). The score is rendered ONCE — the page header above the
pad loses its own score line (kills the triple-score defect, D-11).

### 2.2 Ribbon

Every commit answers in plain sport words with inline Undo:
`FOUR · Kannan · through covers — Undo`. Copy comes from the vocab layer, one
key per event type × sport, all 4 locales. The ribbon is the ONLY always-on
history element in the pad; tapping it expands the last ~5 events (words, not
payload dumps — kills D-5).

### 2.3 Detail dock + soft-commit

Tap ⇒ the event enters the **durable local queue immediately** (survives tab
death; ribbon renders it; the pad's optimistic fold advances). Transmission is
deferred while the dock window is open: `min(6 s, next tap, dock dismissed)`.
The dock offers enrichment chips (scorer, assist, boundary type, card colour,
wicket kind …) declared per event type by the skin; a chip tap mutates the
queued payload before send. Undo inside the window = drop from the queue —
no `core.void` event, no ledger noise. Undo after send = `core.void`, as today.

Consequences, stated so nobody re-derives them: offline behaviour is
unchanged (the queue was already the source of truth); public scorebug
latency gains ≤6 s (acceptable at club level; window is a chassis constant,
not per-sport config); ack/seq handling in the pipeline is untouched — only
the *enqueue→send* moment moves.

### 2.4 Context strip

For events whose payload REQUIRES people (cricket striker/non-striker/bowler):
persistent chips above the tiles, set once, tap to change; over-end
auto-prompts the next bowler; odd-run strike swap follows the fold. Every ball
tap already carries its people — the dock never asks for payload-required
fields, only optional enrichment. The one sanctioned interruption is a
guided sheet for events that cannot be side-only (cricket wicket: kind → who).

### 2.5 Tile grid

MODEL-T primary surface and MODEL-S secondary row. 44 px minimum, one visual
hierarchy: primary (violet fill, max two per screen), standard (outline),
destructive (red outline — Wicket, Card), minor (dashed, overflow row).
Match-losing actions (Forfeit/Abandon) live in console chrome, never in the
tile grid (kills D-12).

### 2.6 Recording chip

Replaces the `Result only · Card · Timeline · Detail 🔒` picker. A single
chip in the pad header states the level in sport words — "Recording
ball-by-ball", "Result only — plan records every ball on Pro" — tap opens an
explainer sheet with the entitlement upsell in the same sport words. Bands
remain `FidelityTier.tier` 0–3; this is presentation only. Locked = worded,
never a bare padlock (kills D-7).

### 2.7 Swap sheet (in-play substitutions — owner ask 2026-08-15)

The engine already models in-play personnel changes per sport law (S3/#426:
five `core.lineup.*` sibling events + per-variant `lineupPolicy(cfg)` —
football caps/no-re-entry vs rolling dispensations, FIVB once-and-same-
position + libero, cricket concussion replacement and retired-hurt resume,
both hockey codes unlimited rolling; refusals are returned values, never
throws). v2 never surfaced it from the pad. v3 adds ONE chassis primitive:

- **Swap sheet**: off-player picker (current on-field) → on-player picker
  (bench + policy-legal returners), both filtered by the module's own
  `lineupPolicy(cfg)`; a policy refusal renders as sport-worded inline copy
  ("Rolling subs aren't allowed in 11-a-side — 3 of 3 used"), never a dead
  control. Emits the sport's own event (`football.sub` where it exists,
  `core.lineup.substitution` otherwise). Where it appears: football/hockey/
  icehockey/volleyball tile ("Sub"); cricket contextually (new batter after a
  wicket, retire flow, concussion via lineup sheet); not rendered for sports
  whose lineups can't change (boardgame, generic, carrom singles).

### 2.8 SkinDef v3

```
SkinDef = {
  key, tapModel: "S" | "T",
  scorebug(view, ctx): ScorebugSpec,
  tiles(view, ctx): TileSpec[],          // phase-aware: pre/live/post
  dock(eventType, view): DockChip[] | null,
  context?(view, ctx): ContextStripSpec, // cricket-class sports only
  sheets?: { [eventType]: GuidedSheetSpec } // wicket-class flows
}
```

Pure data + render mappings, same testability stance as S11 (`layout` is
assertable with no DOM). `createSkinDispatch`'s "a skin cannot invent an
event" property is kept.

## 3. Per-sport specifications

| sport | tap model | scorebug halves | strip | primary tiles | dock enrichment | notes |
|---|---|---|---|---|---|---|
| tennis | S | pair/player names (serve dot on serving PLAYER), game points | sets · games · next server · ends | Fault/Let/Code/Retire minor row | — | doubles: names from lineup members; serve order needs §9 engine item; kills D-2 |
| badminton | S | players, rally points | games · server · interval hint | Sanctions minor | — | serving never "—" (D-17) |
| tabletennis | S | players, points | games · server (2-serve rotation) | minor row | — | first-ever browser coverage (D-13) |
| volleyball | S | teams, set points | sets · rotation/server | Timeout, Sanction | — | rally = half tap |
| boardgame | S | player names + 1–0 / 0–1 | variant (classical/rapid/blitz) | ½–½ + Method minor | method chips | no lineup UI (D-1); chess vocab kept |
| generic | S | sides, score | — | Win/Loss or Score entry per variant | — | the baseline "no skin" look |
| cricket | T | batting score `12/0`, overs | ▸ striker*/non-striker · over dots · bowler | run keypad 0–6, Wide, Wicket(red), extras minor | shot type; wicket via guided sheet | context strip §2.4; t20/odi/hundred identical; `test` adds declare/follow-on; kills D-14/D-15 |
| football | T | side scores | half · clock if present | per-side Goal, Card, Sub; Pen minor | scorer → assist chips | goal commits side-level instantly (fields optional in engine — honest); small-sided via cfg |
| hockey | T | side scores | period · cards | Goal, Card (green/yellow/red), PC | scorer; card person | period-shared lib |
| icehockey | T | side scores (LCD stays) | period · clock · PP countdown | Goal, Penalty, Faceoff-band extras | scorer/assist; penalty person+mins | kills D-8/D-9/D-10; suspension countdown kept |
| carrom | T | side scores | board no. | Board summary tiles | — | strike-by-strike stays PARKED (T-lane) |

Phase-awareness kills D-16: tiles are declared per phase — set-score entry
never renders mid-game; pre shows Start + lineup states; post shows the
sport's close flow only.

## 4. Surfaces

- **Console** (`/o/…/f/[no]`): authority chrome around the pad — lineup
  editor (below), finalize / forfeit / abandon (visually distinct from
  scoring, §2.5), the full audit ledger (page-level, with void — the pad's
  ribbon replaces the old second Activity card, D-4), device handover
  (moved beside the pad header, not page bottom — D-19).
- **Device link** (`/score/[token]`): bare pad + minimal match header.
  Semantics unchanged: today-only, fixture-only, no finalize.
- **Lineup editor, module-declaration-driven** (D-1, D-18): hidden entirely
  when `lineup.size ≤ 1 && benchMax === 0` (boardgame, carrom singles,
  generic); columns per sport — position column only when the sport's
  position catalog is non-trivial, Captain/Wicketkeeper flags only where the
  module declares such roles, pair-order column only for pair entrants of
  sports whose kernel consumes it. Fix the `2/1 starting` badge (D-3).
- **Person names everywhere** for individual/pair entrants (D-6): pad,
  header, pickers render member names; entrant display_name is a
  team-sports concept.

## 5. Cross-cutting bars

- i18n: every new string in all 4 dictionaries (`en,es,fr,nl`, flat dotted
  keys); `content/help/**` stays English-only.
- Contrast: AA computed from the token values at build/test time (the v2 axe
  pass found 24 failures the eye missed); axe runs per skin, as S13 left it.
- Touch: 44 px floor everywhere, including scorebug halves.
- Widths: verified 320/768/1280 by screenshot; the seven-width
  `mobile.spec.ts` matrix is the enforcement backstop; new surfaces must be
  added to it (a surface outside it has zero width coverage).
- No horizontal page scroll at any width; wide internals scroll in their own
  containers.
- `/admin` bar unchanged (functional only) — not part of this programme.

## 6. Testing & the sign-off gate

- **Capture harness productized** in R1: `apps/web/e2e/gallery.capture.ts`
  (name final at implementation) — seeds every sport via
  `seedRosteredFixture`, logs in via `loginUi`, walks pre/live/scored/dock/
  device-link states, screenshots 320/768/1280, emits the gallery HTML.
  Session-learned traps baked in: use `page.request` (the standalone
  `request` fixture has its own cookie jar → 401), never `networkidle`
  after login, dismiss the cookie banner, `animations:"disabled"` +
  screenshot timeouts. Runs on demand per wave, not in CI's PR path.
- **Gate, per wave, before merge**: gallery artifact + live walkthrough of
  the wave's key flows; owner verdicts recorded in the programme index.
  This is a ship-checklist line, same standing as green tests.
- Four test types per wave (unit / Playwright e2e vs prod build / smoke /
  regression); engine-touching waves add conformance + golden replay; the
  registry totality gate and skin dispatch guards are mutation-proved.
- UI-text changes: `git grep -a` old AND new strings across `e2e/` before
  merge (text breaks e2e).

## 7. Waves

One PR per wave; smoke CI is PR-only so no direct-to-main merges.

- **R1 — chassis**: Scorebug, Ribbon, Dock + soft-commit queue change,
  ContextStrip, TileGrid, RecordingChip, SkinDef v3 + registry gate,
  capture harness. No sport conversions yet; v2 skins keep rendering through
  a compatibility shim until each converts.
- **R2 — cricket** (owner priority). **R3 — football** (owner priority).
- **R4 — tennis** incl. doubles serve order (engine item §9.1) + D-3 badge.
- **R5 — racquet split**: badminton, tabletennis, volleyball as three skins.
- **R6 — period pair**: hockey, icehockey (form→tiles+dock, clock, PP).
- **R7 — boardgame, carrom, generic + lineup-editor gating + console
  chrome** (audit ledger consolidation, handover placement, authority
  separation).
- **R8 — sweep**: delete the v2 skin compatibility path, a11y/i18n/help
  (`content/help/**` scoring pages), smoke demo, full seven-width run,
  final all-sports gallery sign-off.

Waves state their deferred test types explicitly in the PR body, v2-style.

## 8. Defect register (found 2026-08-15, each owed by a named wave)

| id | finding | evidence | owed by |
|---|---|---|---|
| D-1 | Lineup editor renders for every sport — `fixture-console.tsx:546` gates only on `{home && away}`; chess gets a 1-slot team UI | CHE-01 | R7 |
| D-2 | Tennis pad has zero doubles affordances; `pairOrder` unread by the nested kernel (S3 seam left inert) | TED-03 | R4 |
| D-3 | Doubles lineup badge reads "2/1 starting" | TED-01 | R4 |
| D-4 | Activity ledger rendered twice per console page | CRI-03 | R7 — R2 recorded why not (console chrome is barred to it; `_INDEX.md`) |
| D-5 | Ledger rows print raw payload copy ("over: 0, ballInOver: 5") | CRI-03 | R2 — CLOSED for cricket (ribbon renders words); R8 audits the rest |
| D-6 | Individual/pair sports show entrant labels, never person names | CHE-01 | R1 + skins |
| D-7 | Raw fidelity picker + unexplained 🔒; free badminton = lone "Set score" | BAD-03 | R1 |
| D-8 | Icehockey goal form permanently open with resting validation error | ICE-03 | R6 |
| D-9 | Person chips overflow the card (clipped names) | ICE-03 | R6 |
| D-10 | Icehockey CLOCK renders "—" | ICE-03 | R6 |
| D-11 | Score rendered 3× above the fold | BAD-03 | R1 |
| D-12 | No action hierarchy — Abandon reads like a rally tap | all | R1/R7 |
| D-13 | boardgame + tabletennis never browser-driven (no e2e ever) | scout #2 | R1 harness + R4/R5/R7 e2e |
| D-14 | Cricket batter/bowler are dropdowns (3 taps each) | CRI-03 | R2 — CLOSED (context strip; the host holds pending picks, see `_INDEX.md` G5) |
| D-15 | Wicket fielder picker = cramped chip wall; capture runs wedged twice here | CRI-03 | R2 — CLOSED (one guided sheet, conditional steps, explicit candidates) |
| D-16 | Set-score entry offered mid-game (tennis at 30–30) | TED-03 | R4 |
| D-17 | Badminton SERVING shows "—" | BAD-03 | R5 |
| D-18 | One lineup table for all sports (position dropdowns for cricket, Captain for chess) | CRI-01 | R7 |
| D-19 | Device handover buried at page bottom | all | R7 |

Rule: a wave that touches a register row's surface closes the row or records
why not in the programme index — no silent drops.

### 8.1 Cross-cutting findings (GF-1…GF-9) → where addressed

| GF | finding | addressed by |
|---|---|---|
| GF-1 | monster-button monotony, no hierarchy | §2.5 tile hierarchy, D-12 |
| GF-2 | score rendered 3× | §2.1 single scorebug, D-11 |
| GF-3 | raw fidelity picker + bare 🔒 | §2.6 recording chip, D-7 |
| GF-4 | entrant labels, never person names | §4, D-6 |
| GF-5 | duplicate Activity ledger | §2.2 ribbon + §4 console audit, D-4 |
| GF-6 | one lineup table for all sports | §4 declaration-driven editor, D-18 |
| GF-7 | four action grammars in one product | §2 single grammar: tap → ribbon → dock; sheets only where payload demands (§2.4, §2.7) |
| GF-8 | substance worth keeping (ledger, undo, offline, handover) | §1 "survives", §4 |
| GF-9 | sticky-nav mid-image = capture artifact, not a bug | §6 harness notes |

## 9. Engine work items (the complete list)

1. **Tennis serve order for pairs**: the nested kernel consumes `pairOrder`
   (model shipped in S3, currently read only by the setbased kernel) so the
   pad can mark the serving player. Additive; modules stay `1.0.0`; expected
   to touch no recorded fold output (serve attribution is presentation until
   a point payload carries it). If any corpus state moves, follow
   GOLDEN-POLICY: red code commit + isolated re-baseline commit.
2. **`PadAttributionItem` needs a required/optional flag** (found in R2,
   owed by R8). `PadAttributionItem` (`sport/module.ts:264`) carries only
   `kind`, `path`, `role?` and `labelKey?`, so the pad cannot tell a required
   attribution item from an optional one — and the same action legitimately
   has both (`cricket.review`: `by` required, `person`/`against` optional).
   `checkActionValidity` therefore skips attribution entirely and an action
   can be confirmed with a required person unfilled; the engine's
   `strictObject` rejects it and the scorer's tap dead-ends on a refusal.
   Additive flag, then a sweep of all 11 sports' `padSpec` declarations, then
   conformance + golden replay because `padSpec` output is recorded surface.
   Modules stay `1.0.0`; no fold output should move.
3. **A shot-type field on `CricketBall`** (found in R2, owed by R8 or a
   cricket follow-up). §3's cricket row promises shot-type dock enrichment,
   but `CricketBall` is a `z.strictObject` with nowhere to put it, so R2
   shipped a Free-hit-only dock. This one IS a payload change: additive and
   optional, but it touches the golden corpus, so it follows GOLDEN-POLICY —
   red code commit plus an isolated re-baseline commit, never a silent one.
4. Nothing else. No new event types, no fidelity changes, no other schema
   work. The T-lane (tier-3 extensions), plus/minus and boardgame PGN stay
   parked on #430 exactly as ruled.

## 10. Out of scope

Billing/entitlement changes (wording only), `/admin`, public scorebug page
redesign, stats surfaces (S8/S9), competition formats, and anything in §9's
"nothing else".

## 11. Open items (tracked, not blocking)

- Soft-commit window: constant 6 s at R1; revisit only with evidence.
- Period clock source (D-10): R6 decides between elapsed-derived display and
  scorer-controlled clock; W4a's time model is the input.
- Console audit ledger density on mobile: R7 verifies at 320 px with the
  harness before merge.
