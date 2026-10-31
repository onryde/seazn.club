# Match Day — design

Status: draft for owner approval · 2026-10-31 · brainstorm session "division-builder"
Mockups (layout reference only; the build uses the house theme and components):
`.superpowers/brainstorm/7863-1793444283/content/` — `match-day-layout.html` (option C),
`match-day-c-no-stream.html` (C1), `match-day-free-court.html`.

## 1. Intent

Running the day is spread across the competition page today. The same live facts appear in
four places, and the owner finds the whole thing "complex to understand and flow":

| Place today | What it shows |
|---|---|
| Competition page, dark strip (`components/v2/desk/in-play-band.tsx`) | in-play matches, score as `0 – 0 (3-2)` |
| Competition page, "Needs you" (`components/v2/desk/needs-you.tsx`) | result-missing rows mixed in with setup jobs |
| Competition page, divisions list (`division-ledger.tsx`, `phase-pill.tsx`) | "Match day" phase pill + "Now: D v F" column |
| Division page, Fixtures tab (`components/v2/stages-panel.tsx`) | "Now playing" banner above the stage cards |

**Match Day** is a new organiser surface, scoped to one competition, for running the day
**court by court**. On the day there are N courts and a list of matches. The organiser opens
Match Day to see who is on each court now, who is next, which courts are free, and each court's
stream. They call waiting matches onto free courts.

The owner agreed that this is the third of three homes (2026-10-31):
1. **Division setup**: format, rules, points, tie-breaks (a separate project, designed next).
2. **Fixtures tab**: the draw and the schedule.
3. **Match Day**: everything live.

## 2. Users

- **Organiser and org staff with edit rights** use Match Day, at the desk or on a phone.
- **Scorers do not use Match Day controls.** They keep today's remote scoring / device link:
  a per-match link, scanned from the stream camera, the printed PDF, the fixture page, **or
  Match Day**, which now shows the scorer QR for a called or live match. No court-bound scorer
  link (owner: "No, scorer always scan the link").
- The public never sees Match Day.

## 3. Goals

- G1. One screen answers: what is on each court now, what is next, which court is free.
- G2. A free court can be filled in a few taps with the right waiting match, and the
  knock-on to the schedule is shown before anything changes.
- G3. Each court has one fixed camera, set up once for the day, that streams whatever match
  is on that court, with no per-match re-pairing.
- G4. Results still owed are visible and enterable from Match Day.
- G5. Works for **every sport** from day one: the court noun and the scoreboard follow the sport.
- G6. The competition page stops duplicating live state.

## 4. Non-goals (owner-scoped out)

- Moving a match that is **already playing** to another court.
- An automatic "bring the next match over" nudge on a free court. Calling is always a choice
  the organiser makes from the free court's list.
- Notifying players (push, SMS, email) when a match is called. Calling assigns a court.
- Several competitions in one view. Match Day is one competition at a time.
- Scorer-side changes beyond showing the existing per-match link/QR in Match Day.
- The setup redesign proper: giving rules, points and tie-breaks a new home in division setup,
  and redesigning the division builder. That is the next brainstorm. The concrete clean-ups
  found in this session ARE in scope as phases C and D (§12).

## 5. Anti-goals (a build that works but fails anyway)

- A badminton-shaped scoreboard on a football pitch or chess board.
- A move that silently reshuffles other pairs' times.
- A court with no stream showing an empty black video box.
- A venue that never streams seeing "+ Connect stream" on every court row.
- Live state still appearing in more than one place on the competition page after this ships.
- A phone view that is the desktop view shrunk. Phone gets its own composition (§6.2).

## 6. The surface

### 6.1 Layout: "court list + focus" (owner picked option C)

- **Desktop (≥ md):** header (competition, date, "N courts · N playing · N free", results-owed
  button). Below it, two columns:
  - Left: the **court list**, one row per court, showing court name, stream badge
    (only when live), current match and compact score, or "Free".
  - Right: the **focused court**.
- **Phone (< md):** the court list is the home screen. Tapping a court opens it full-screen
  with "‹ All courts" back. One DOM, branched with `max-md:*` / `md:hidden`, following the house
  phone-composition rules in AGENTS.md.

### 6.2 Focused court: states

| Court state | Top panel | Below |
|---|---|---|
| Playing, stream live | stream preview with the sport's scorebug over it, "Live on YouTube" badge | court · division · stage · started at; **Open pad**; scorer QR; queue |
| Playing, no stream (**C1**, owner pick) | the dark panel becomes a big scoreboard: the sport's own scorebug (who serves, games/sets, points; or minutes+goals; runs/wickets/overs; clock), with a small "+ Connect a stream" link in its corner | same |
| Called, not started | "Called: waiting for players" with the match, plus the scorer QR | queue |
| Free | "Court 5 is free", free since, "N matches could start here now" | the **candidate list** (§7) |
| In use by another competition | greyed: "In use: \<competition name\>" | nothing actionable |

The court list shows a stream badge **only** when that court is live. No badge otherwise.

**Score format.** Games or sets won in large type, current points beside them. This replaces
`0 – 0 (3-2)`. For every sport the scoreboard is the pad's existing per-sport scorebug
(the ScoringPad v3 skins under `components/v2/scorepad/v3/`), not a new badminton widget.

**Court noun** follows the sport (court, pitch, table, board), from wherever the venue/court
label already comes from today.

### 6.3 Header

- "Match Day · \<weekday date\>", competition name, court counts.
- **Needs you**: one attention button ("11 need you · 3 results owed") that opens the full
  "Needs you" list, which moves here on a match day (§9). Results owed come first, with
  **Enter result** on each.
- Division filter chips: an optional narrowing. Default is all divisions.

## 7. Calling a match onto a free court (the core flow)

Owner: "if court is free and next matches are waiting then we can pick and ask to play there".

Opening a free court lists **candidates**: matches that could start there now.

Order:
1. **This court's own next match**, if all its players are free. Starting it early respects
   the schedule and moves nothing else.
2. Matches waiting in **other courts' queues**, longest-waiting / most-behind first.
3. **"No court yet"**: ready matches in the competition's active stages with no court
   assigned. Ready means both entrants are known, so knockout TBD slots are excluded.

**Which courts.** *My call:* the court list is the union of every division's configured
candidate courts (`court-candidates.ts`) and any court holding one of this competition's fixtures
that day. "Free" means no match playing or called on it, from **any** competition: courts are
org-level, so another competition's playing or called match makes the court "In use: \<name\>".
Another competition's *planned* matches on a shared court count as that court's queue for the
knock-on preview. They are never controllable from here.

**Undo call.** *My call:* a called match that has not started has **Undo call**, which restores
its previous court and time (the old values are kept when calling). It can also be called to a
different free court from that court's candidate list. Without this, a wrong tap or a no-show
leaves a court blocked.

Each candidate shows teams/players, division, where it waits ("next on Court 2 · ~15 min",
"25 min behind Court 1", "Not scheduled"), and **Call to Court N**.

**Calling** assigns the match to the court. It writes the fixture's court and time; the
existing seam is `fixture.court_id` + `scheduled_at` via the run-sheet row's `patchSchedule`.
Nothing is sent to players. The match leaves its old queue. The court shows "Called" until the
scorer starts the pad, then shows the live scoreboard.

### 7.1 Schedule rule (owner "Ok")

- **On the day, queue order is the truth; times are estimates.** Each court's queue is its
  matches in scheduled order. Estimated start = max(planned time, estimated end of the match
  before it). Shown with "~".
- Calling another court's match onto this court:
  - its old court's queue moves up;
  - this court's queue shifts back one match.
- **A knock-on preview comes before confirming**, e.g. "Das v Gill move from 11:45 to ~12:10 on
  Court 5". Nothing changes behind the organiser's back.
- A pair is never pulled earlier than their slot unless the organiser calls them.
- **Owner ruling, 2026-10-31: planned times never change on a call** ("B, because A will have a
  domino effect"). Only the called match's `court_id`/`scheduled_at` are written. Every other
  match keeps its planned `scheduled_at`, and its "~" estimate is computed at read time. The
  published schedule, slideshow and players keep seeing planned times. Live estimates exist
  only in Match Day.
- **Consequence for the write path (builder-check finding, verified):** today
  `PATCH /api/v1/fixtures/:id` runs `assertNoNewBlocking` (`server/usecases/schedule.ts`,
  `isBlockingConflict` in `packages/engine/src/scheduling/calendar.ts`). It refuses court
  double-booking, so calling onto Court 5 at 11:31 is refused while Das v Gill are planned there
  at 11:45. Match Day therefore needs its **own call use case**, which:
  - **does not** treat overlap with *planned, not-started* matches on the target court (or the
    players' planned slots) as blocking;
  - **does** keep the §7.2 hard stops: a person on court now, or the court playing or called;
  - records the match's previous court and time, for Undo call.

  The existing PATCH path and its guard stay unchanged for every other caller. Check that later
  schedule-board edits on fixtures overlapping a called match still work. The guard refuses only
  *new* conflicts, so the overlap a call leaves behind must not make unrelated edits 409. Test it.

### 7.2 Hard stop vs warning (owner "Ok")

**Hard stop.** The candidate or court is greyed out, with the reason shown:
- A player of the match (person-level, so doubles partners count) is on court right now.
  Example: "Zara Khan is playing on Court 3".
- The target court already has a match playing or called.
- The court is in use by another competition (courts are org-level: `courts` → `venues` →
  `org_id`, V367).

**Warning in the preview.** Allowed; confirm to proceed:
- Other pairs get pushed later.
- A player gets less rest than the division's minimum rest gap, if the division declares one.
- The court's queue would run past the day's end / court hours.

## 8. One fixed camera per court (owner "yes")

Each court gets one camera, set up once for the day. When a match is called to or starts on that
court, the court's stream shows that match: overlay with those players and the sport's score.
Nobody re-points a stream per match. Between matches the stream shows a court-idle card.

**This is new plumbing, not just a new screen.** Every stream table today is per fixture:
`fixture_stream_sessions` (V410), `fixture_stream_codes` / `fixture_stream_settings` /
`fixture_stream_pairings` (V430), and YouTube Connect's broadcasts (V479). A court-level binding
that hands over from fixture to fixture does not exist.

Left to the builder (a plan-time spike), within these constraints:
- the organiser connects a camera to a court **once**;
- handover to the next match needs no organiser action;
- the existing per-fixture streaming keeps working for orgs that don't use court cameras;
- money, retention and credit accounting stay correct across handovers (see the stream billing
  traps in memory and V410's comments).

Phasing (proposed as my call; **owner OK 2026-10-31**): **Phase 1** ships Match Day without court cameras. The stream badge and
preview reflect any per-fixture stream already live for the match on that court; "+ Connect a
stream" uses the existing per-fixture flow. **Phase 2** adds the court-level camera. Phase 1 is
useful alone and does not wait on the biggest piece.

## 9. Changes outside Match Day

- **Competition page:**
  - remove the dark live strip (`InPlayBand`);
  - **"Needs you" lives in one place at a time** (owner OK, 2026-10-31).
    - **Before the day:** the full list stays on the competition page, as now.
    - **On a match day:** the condition is the same as for the Open Match Day button, i.e. the
      competition has fixtures that day. The **whole** list moves into Match Day, every kind:
      `result_missing`, no draw yet (Compute proposal), fixtures unscheduled, `no_scorer`,
      `not_recording`, `needs_decision`, `registrations_waiting`, `bans_waiting`, and any others.
      The competition page replaces the list with one line: "N things need you, in Match Day →".
    - **Inside Match Day:** the list sits behind the header's attention button. Results owed are
      counted first. `no_scorer` / `not_recording` also mark the affected court's row.
      Unscheduled fixtures link to the free-court candidate list as well as the schedule board.
    - **Tests:**
      - every kind `needs-you.tsx` renders today appears in exactly one place on both sides of
        the day boundary, never zero and never two;
      - a sweep reports how many kinds it checked, and a count of zero fails;
      - the boundary itself is tested: the day before, the day of, and a day with no fixtures
        in the middle of a multi-day event.
  - remove the divisions list's "Now:" column;
  - add **Open Match Day** to the header, shown once any division has fixtures on that day.
- **Divisions list on the competition page** (`division-ledger.tsx`), owner request 2026-10-31,
  added after approval:
  - show **5 divisions at a time**, with pagination;
  - a simple filter where **finished divisions are excluded by default**, plus a toggle to
    show them with their count ("Show finished (3)");
  - the pager and filter state live in the URL query, so a reload or the back button keeps
    them;
  - the "Needs you" attention items are unaffected: a division with an attention item is
    never hidden by the filter, only paged.
- **Division phase pill:** the organiser label `desk.phase.match_day` changes from "Match day" to
  **"In play"**, so "Match Day" is only the product name. *My call:* the public-site label
  `landing.status.matchDay` stays as is, because spectators never see the organiser product.
  The pill's derivation rules are owned by the competition-desk programme
  (`docs/superpowers/specs/2026-09-02-competition-desk-prompts/_INDEX.md`); read its `_RULES.md`
  first. This is a label change, not a phase-logic change.
- **Division Fixtures tab:** remove the "Now playing" banner. The rest of the tab is the setup
  project's.
- All new and changed strings go in all 4 locale dictionaries, then regenerate the i18n keys.

## 10. Constraints

- House theme and components (`--ps-*` tokens, Geist, existing pills and buttons). The mockups
  are layout only.
- Mobile-first. Verified at 320, 768 and 1280 with no horizontal page scroll, plus the 7-width
  e2e matrix.
- Organiser-only route under the competition (`/o/[org]/c/[comp]/…`), with the same edit
  permission as the division desk.
- Live updates: polling like the existing desk band (`band-poll.ts`) is acceptable. The builder
  picks the cadence.
- Tests per `docs/superpowers/TEST-STRATEGY.md`. That includes the sequence cases: call, then
  call again; call after a withdrawal or void; a doubles partner busy; another sport (football
  pitch, chess board); a court in use by another competition.

## 11. Left to the builder

Route name; component breakdown; how "Called" is represented (derived from court + time + not
started, or an explicit marker); the estimate maths; the poll cadence; the Phase 2 court-camera
mechanism; how the "No court yet" set is queried.

## 12. Delivery phases (owner 2026-10-31: "all discussion going on this plan with phase")

One plan, delivered in phases. Each phase ships on its own.

- **Phase A — Match Day surface.** §6, §7 (calling, Undo call, schedule rule, hard stops),
  results owed and the moved "Needs you" list inside Match Day (§6.3), the scorer QR, per-sport
  scoreboard and court noun, and Phase-1 streams (§8: per-fixture streams only).
- **Phase B — Competition and division page clean-up.** Everything in §9: remove the live strip,
  move "Needs you" on a match day, remove the "Now:" column, rename the pill to "In play", add
  Open Match Day, paginate and filter the divisions list, and remove the Fixtures tab's
  "Now playing" banner.
- **Phase C — Stage card clean-up** (Fixtures tab, `stages-panel.tsx` + `components/v2/stage-rules/`).
  Owner screenshots, 2026-10-31. Every defect below gets fixed:
  1. The stage kind pill repeats the stage name ("1. League" + "League"). Drop the pill when the
     name already says it.
  2. The format is stated twice ("Best of 3" + "Best of 3, 15 points (cap 21)"). Use one line.
  3. The lock line links to the tab it's on ("See the fixtures"). Remove the link.
  4. Internals copy goes: "Pinned at start · from before this update", "sport default" next to a
     pinned chip, and "Changes to the division's points don't reach it". One lock line per
     section, in organiser words ("Locked: the stage has started").
  5. Points: when every win pays the same, say it once ("Win 2 · Loss 0"). Show per-score rows
     only when the scores differ. Never write "pays 2-0 points".
  6. Tie-breaks: the repeated "head-to-head between the two" rows (the "if exactly two are still
     level" fallback) render as ONE explanatory line, not as numbered steps. The numbered list
     shows the real criteria in order.
  7. Sport vocabulary: criterion labels use the sport's unit (badminton "games", tennis "sets",
     table tennis "games", and so on), derived from the engine's sport declaration, never a
     hand-typed table.
  8. Buttons follow the stage state. **Complete stage** is never the primary button while
     fixtures are unplayed or in play. **Generate fixtures** is not offered on a stage that has
     started.
  9. Fixtures are visible without the extra click. **Owner direction, 2026-10-31:** the stage
     card header gets buttons in its **top-right**: **Match format** (rules), **Points** and
     **Tie-breaks**, plus the stage's other actions. Each opens its section in a panel or
     sheet: read-only once locked, editable before. Rules, points and tie-breaks no longer fill
     the card body. The body shows the one-line summary and the stage's fixtures (run sheet)
     directly. Points and Tie-breaks appear only for table stages, as today. On a phone the
     buttons collapse into one "Stage settings" menu, so the header doesn't wrap at 320.

  10. **One component per concern, reused everywhere** (owner 2026-10-31: "single component for
      each and reuse in builder, fixture and match pages"). There are three components:
      - **Match format** (rules)
      - **Points**
      - **Tie-breaks**

      Each has one set of modes:
      - **edit**: a division default in the builder and in Settings, or a stage override before
        lock;
      - **locked**: read-only once the stage has started;
      - **fixture override**: Match format only, where per-match overrides exist today.

      They replace the current per-surface copies: `MatchRuleFields` (builder + Settings),
      `StageRuleFields`, `StagePointsSection`, Settings "Standings points", and
      `StageTiebreaksSection`. Mounts:
      - the division builder;
      - division Settings;
      - the stage card's top-right panels;
      - match pages: the fixture console and the Match Day court focus, which show the match's
        format read-only.

      Consequence: because Tie-breaks is reused in the builder and Settings, the
      **division-level tie-break editor moves into scope**. It gives "Use the division's order"
      a control that sets it. Both forms take field ranges from one source (Phase D), so Legs,
      Rounds and Qualify can no longer disagree.
  Because this is a UI change, the header-button layout is **mocked (desktop 1280 + phone 320)
  and signed off by the owner before build** (house rule), with a second variant for the
  panel: a side sheet vs an inline expand under the header.
- **Phase D — Builder vs Settings field alignment.** The same field must take the same values in
  the division builder and in Settings:
  - Legs: 1–2 vs 1–4.
  - Rounds: minimum 1 vs 3.
  - Qualify: a fixed select vs any number from 2 to 32.

  The correct range for each comes from the engine's format declarations, not from either form.
  Add a test that drives both forms' bounds from that one source.
- **Phase E — later, own spike.** The fixed camera per court (§8). Also later, and not designed
  here: the full setup redesign (builder flow and Settings layout). The division-level
  tie-break editor moved into Phase C (item 10).
