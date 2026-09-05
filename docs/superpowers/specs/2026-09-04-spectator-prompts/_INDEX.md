# Spectator surface (`/shared`) — programme index

Decision log and session status. Read `_RULES.md` beside this file first.

- **Design of record:** `../2026-09-04-spectator-surface-design.md`
- **Plans:** W1 `../../plans/2026-09-04-spectator-w1-match-centre.md` (18 tasks — 17–18 added by ruling 12; EXECUTING) · W2 `../../plans/2026-09-05-spectator-w2-competition-landing.md` (DRAFT, 19 tasks) · W3 `../../plans/2026-09-05-spectator-w3-poster.md` (DRAFT, 10 tasks) · W4 `../../plans/2026-09-05-spectator-w4-gallery.md` (DRAFT, 12 tasks) · W5 `../../plans/2026-09-05-spectator-w5-public-team-page.md` (CANDIDATE DRAFT, 9 tasks). W2–W5 were drafted 2026-09-05 in parallel with W1 by planning agents on the owner's request ("write all waves"); every one is DRAFT until re-pinned after the wave before it merges. Each wave prompt carries a `## Plan` section with the owner questions and the product-owner recommendation.
- **Design system:** `_DESIGN.md` (tokens cited from the tree, W1's built vocabulary, per-wave themes with one memorable thing each, anti-patterns, R11 checklist; proposed items P1–P12 await an owner ruling). Visual theme sheet: https://claude.ai/code/artifact/45c81708-095d-458c-b49f-b471e2901415
- **Resume state:** `_STATE.md` — start there after any session loss.
- **Waves:** W0 capture + options · W1 match centre (every sport) · W2 landing ·
  W3 poster · W4 gallery · W5 public team page (in scope by ruling 16; plan drafted 2026-09-05)
- **Reference the owner pointed at:** cricheroes tournament matches page and
  three scorecard pages (fetched 2026-09-04; structure recorded in the spec).
  Ruling: copy the level of detail, not the site.

## Status

| Wave | Scope | State |
| --- | --- | --- |
| W0 | Prod-build capture of every existing public page at 320/375/768/1280; current-state block II; two mockup options each for match centre and poster (+ football and tennis boards); pick | **Done 2026-09-05.** Canvas: https://claude.ai/code/artifact/f745adf2-fd1f-4f14-9184-ba6f0eb41978 · plain view: https://claude.ai/code/artifact/e7ced691-6978-4036-8f20-cd134b5cfca5 · picks: match centre A, poster A — owner-confirmed, for every sport |
| W1 | Match centre for EVERY sport: engine cricket scorecard fold, ledger Timeline + Sets/Periods for the other sports, view model in the public fixture JSON, Summary/Scorecard/Commentary/Timeline/Sets/Info tabs by sport and tier, live transport carries the model, i18n, walkthrough v1 | **Executing** (subagent-driven): Tasks 1–5, 7, 10–13, 17 complete and integrated on `feat/spectator-surface`; 6, 8, 18 in review/fix rounds on isolated lanes; 9, 14, 15, 16 next. See `_STATE.md`. |
| W2 | Competition landing rail (Overview · Matches · Table · Stats · Teams · Gallery slot · Info), division + player pages for the phone, i18n sweep, walkthrough v2 | Plan DRAFT 2026-09-05 (19 tasks); 3 owner questions in `W2-landing.md`; not started |
| W3 | Match poster `poster.png` feed + story, upcoming/live/result, real crests, sponsor strip, download + native share, walkthrough v3 | Plan DRAFT 2026-09-05 (10 tasks); 3 owner questions in `W3-poster.md`; not started |
| W4 | Gallery: `gallery_photos`, storage bucket, staff upload from the public page with media-consent gate, Gallery tab + Photos strip, walkthrough v4 | Plan DRAFT 2026-09-05 (12 tasks); 6 owner questions in `W4-gallery.md` (consent data cannot express "declined" today); not started |
| W5 | Public team page (the other sports' Timeline moved into W1 by ruling 10) | **In scope (ruling 16, 2026-09-06).** DRAFT plan 2026-09-05 (9 tasks, option A); 10 owner questions in `W5-team-page.md`; runs after W4; re-pin first |

## Owner rulings

Rulings BY THE OWNER, 2026-09-04. Recommendations I made are in the next
section and are **not** interchangeable with these. Never carry either to a
peer session as the other.

1. **Sport scope: shell for every sport, cricket deep first.** (Picked from
   three options; it was also my recommendation.)
2. **Poster: upcoming + live + result variants, feed 4:5 and story 9:16,
   downloadable by anyone from the public fixture page.** (Picked; also my
   recommendation.)
3. **Order: W1 match centre → W2 landing → W3 poster.** (Picked; also my
   recommendation.) Walkthrough grows with every wave, not a wave of its own.
4. **"Focus on `/shared` public pages."** The organiser console is out of scope
   for this programme; no organiser-set fields.
5. **"All public pages must be designed for mobile view, not just shrink,
   including existing pages."** Repo-wide policy applied to every `/shared` page.
6. **"Can we add gallery upload as well?"** — yes, as W4 (my placement).
   Staff-only upload from the public page was my recommendation; the owner did
   not object.
7. **"Must use Opus at least for subagent."** Applied to the three agent
   frontmatters and `RULES.md` on this branch.
8. **"You are the product owner; your job is to increase customer and product
   value."** Remaining calls are made in-session and recorded, each with the
   customer value stated. Not a licence to skip the approval gate on the spec
   or on the W0 visual pick.
9. **"Write in multiple prompts to match the standard."** This directory.
10. **"Option A is OK in both, but not only for cricket."** (2026-09-05, on the W0
    canvas.) Match centre A and poster A confirmed; every sport gets its depth in
    W1 — a ledger-driven Timeline tab and a Sets / Periods tab beside cricket's
    Scorecard and Commentary. The "other sports' Timeline" wave is gone; W5's
    slot holds the public team page candidate (not yet ruled).
12. **"Two product-owner calls, recorded: apply your recommendation."**
    (2026-09-05.) The band line on the Info tab, and the band-2 player-line
    enrichment (engine schema + fold + the pad's line-entry form) are pulled
    into W1 as plan Tasks 17–18 — the programme's one deliberate scorepad touch.
13. **"Make sure that visually verify all pages including cosmetic, button, text
    alignment, etc."** (2026-09-05.) Standing rule R11: per-screen visual
    sign-off at 320/768/1280 with a written verdict table in the spec; cosmetic
    defects are defects, fixed before the PR.
11. **"Make sure that all live pages are live update without reload."**
    (2026-09-05.) Standing rule R10 in the spec and `_RULES.md`: every public
    surface showing a match in play updates in place over the existing
    transport; proven by posting an event while the anonymous page is open.

## Product-owner calls made in-session (mine, recorded so they can be reversed)

- Top performers are COMPUTED (runs then strike rate; wickets then economy); no
  player-of-the-match column. Value: the "who starred" line with zero organiser
  work; reversible by adding a column later.
- Commentary is auto-generated from the ball ledger (no free-text). Value: a
  live feed on every tier-3 match for free; the template set is derived from
  the engine's ball schema so it cannot go stale.
- Gallery upload is staff-only, on the public page, with a media-consent tick
  stored per upload and a public "Request removal" link. Value: photos without
  a moderation queue or a consent lawsuit; anonymous upload is out.
- Gallery limits are product constants (10 MB / 200 per competition); plan
  tiers are a v18 question for the owner.
- The landscape OG card stays as it is; the poster is a separate artefact.
- No view counters, comments, MVP-points formula, ads.
- **W0 picks (2026-09-05): match centre option A (court header + tab rail), poster
  option A (crest tiles).** Reasoning in the spec §"Options shown and the
  product-owner pick". The owner reverses either by naming the other letter.
- The Info tab names the scoring band in one line ("Scored ball-by-ball" / "from
  scorecard lines" / "Totals only") and empty tabs never render — a spectator
  reads the difference between two matches as the scorer's choice, not a broken
  page. The W1 reader accepts optional `fours/sixes/dismissal` and
  `maidens/wides/noBalls` on a band-2 line from day one; adding them to the
  engine schema and the pad's tier-2 form was recommended — and the owner
  pulled it into W1 (ruling 12; plan Tasks 17–18).
- Public team page queued as a W5 candidate ahead of the other sports' Timeline
  (recommended to the owner 2026-09-05, not yet ruled on) — captains share their
  team page to the whole squad; cheap once W2's match card, standings row and
  badge exist.

## Spec amendments (binding, in the design doc)

None yet.

## False premises found

- **WebFetch cannot read cricheroes** (403); `curl` with a browser UA can. The
  scorecard pages are client-rendered — their shells carry only titles and
  meta; the tournament page is server-rendered and gave the structure.
- **The public header was assumed white from a token sheet; it is the dark
  court bar** (`#231738`) with a letter-spaced tagline strip and the accent
  keel. Found by looking at the capture; the first mockups had to be corrected.
  A token sheet is not a screenshot.
- **`cricket.toss` after `core.start` is refused** (`422 WRONG_PHASE: toss must
  precede core.start`). The seed posted it second and lost the toss on both
  matches; the walkthrough posts it first.
- **The org home's competition chip read "UPCOMING"** on a competition with a
  live match and two finished ones. Recorded as a W2 finding (block II), not a
  brief premise.
- **The division chip prints the VARIANT ("T20"), not the configured format**
  (8 overs). W2/W3 read the config.
- **The spec's first R4 ladder typed the bands from memory and had them off by
  one.** The engine declares innings totals as band **0** ("result") and the
  toss/close/DLS card events as band **1** ("card"); player lines are 2, balls 3.
  Found when the owner asked what tier 1/2 scoring leaves on the public page
  (2026-09-05). R4 now quotes the engine's declaration and renders by presence.
  The same question surfaced a real data gap: a band-2 player line carries no
  4s/6s, how-out, maidens or wides — recommended to the scorepad programme as
  additive optional fields, not built here.
- **Posting a full tier-3 ledger through the API is slow** (~190 events ≈ 9 min:
  the strict fold replays the ledger per event). The first capture run spent
  its whole foreground budget seeding; the harness now reseeds from a saved
  `seed.json`. Walkthroughs seed short matches and never post a full T20.

## Environment (label `spx`)

See `_RULES.md` §Environment. No standing env between waves; W0's env was torn
down the moment its screens were on disk (2026-09-05).

W0 harness: `apps/web/e2e/walkthrough/w0-spectator-capture.spec.ts` — skips
unless `W0_DIR` is set; seeds a public competition (four 8-a-side cricket teams,
8 overs, one finished + one live match, three football sides) through the API
and captures every `/shared` page at 320/375/768/1280 in an anonymous context,
writing `manifest.json` (h-scroll + control set per width) and `seed.json`.
`W0_SEED=<seed.json>` reuses a seed instead of posting it again. Run from
`apps/web` with `PLAYWRIGHT_BASE`, `E2E_PROD_TARGET`, `DATABASE_URL`,
`DATABASE_SSL=disable` from `seazn-env env --label spx`, `--project=walkthrough`.

## Session status — 2026-09-05 (W1 execution, handoff)

W1 runs under `superpowers:subagent-driven-development`; the ledger is
`.superpowers/sdd/2026-09-04-spectator-w1-match-centre/progress.md` (git-ignored, in
the spectator worktree) — its "RESUME HERE" block is the recovery map. State at
handoff: Tasks 1–5, 7, 10–13 complete and integrated on `feat/spectator-surface`
(HEAD b8ed8fa31: lane B's 7 and lane C's 14 commits cherry-picked, dictionaries
resolved by key union, keys regenerated; public-site suites 537/0, tsc clean); Task 17
(engine band-2 lines) merged with a fix round in flight (regenerate
`cricket.schema.json`, extend the golden corpus — both reds were REAL, mis-triaged as
environmental); Tasks 6, 8, 18 in flight in isolated worktrees; 9, 14, 15, 16 not
started. The W2 plan exists only as an unreviewed DRAFT
(`plans/2026-09-05-spectator-w2-competition-landing.md`).

Rulings made this session (details in the ledger): the scorebug keeps "Not started"
through its own key `matchCentre.status.notStarted` (a localisation is a copy change —
grep the e2e suite for the literal first); `matchCentre.status.<status>` per real
status, raw fallback, never "Not played" for abandoned/cancelled; numeric table cells
`px-0.5` inside `w-7/w-8/w-11`; strike rate / economy one decimal, run rates two;
commentary heading level derives from `innings.length`; every apps/web round ends with
`tsc --noEmit -p tsconfig.json` (a zod `.default()` makes the field REQUIRED on the
output type — three fixtures broke silently under a green suite); Task 8 proves
dictionary coverage by DERIVATION (source scan + engine enums), not a typed list.

False premises found in W1 (do not re-derive): engine corpora live under `sports/**`;
`generic.configSchema.parse({})` throws; the kernel declares 14 event types;
`core.award` carries no side; a "missing `SetsView.unit`" finding was a mis-attribution
(the pre-image had it); `decideTie` does NOT leave `outcome` null under super-over
config; `applyPlayerLine` refuses an unclosed innings; `cricket.toss` is band 1; an
isolated-worktree agent branches from origin/main, never from the feature branch.

**Owner ruling 14 (2026-09-05 18:1x):** "write all wave implementation using fable
subagent?" — accepted as a ruling: Implementer and Reviewer agents run on Fable for
this programme's remaining waves (`.claude/agents/*.md` frontmatter; RULES.md). The four
agents resumed at 18:01 finish on Opus (a resume keeps the model).

**Ruling 14 corrected (2026-09-05 18:2x):** the owner's question meant PLANNING —
"only now use Fable Agent to write implementation plan for remaining waves". Agent
frontmatter reverted to `model: opus`; the W3 (poster) and W4 (gallery) plans are
drafted by Fable agents (docs only, DRAFT status, re-pinned before execution); the W2
draft already came from a Fable-model agent.

**Owner ruling 15 (2026-09-06 00:3x): team colour source CONFIRMED** — "Confirm": public
tiles use `team_display_v.colors.home_primary` through `public-theme.ts`'s 3:1 contrast
guard, else the `division-hue.ts` wheel keyed on the entrant, else neutral initials; one
resolver in W2 consumed by W3 and W5. `colors.primary` is a key nothing writes.

**Owner ruling 16 (2026-09-06 00:3x): W5 public team page is IN SCOPE** — "Keep it": W5
runs after W4 from `plans/2026-09-05-spectator-w5-public-team-page.md` (option A, `tm-*`
testids); its ten prompt questions carry the product-owner recommendations unless the
owner rules otherwise at re-pin.
