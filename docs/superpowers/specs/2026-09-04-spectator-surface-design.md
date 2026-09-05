# Spectator surface — the public `/shared` pages as the product's front window — design

Date: 2026-09-04. Branch `feat/spectator-surface`, worktree `.claude/worktrees/spectator`.
Programme index: `2026-09-04-spectator-prompts/_INDEX.md`; subagent rules: `_RULES.md` beside it.
W0 canvas (today's screens, two match-centre directions, two poster directions, on real
seeded data): https://claude.ai/code/artifact/f745adf2-fd1f-4f14-9184-ba6f0eb41978
Reference the owner pointed at (cricheroes tournament + three scorecard pages, fetched
2026-09-04 — see "Reference structure"). The owner's brief: *"we don't want to replicate
this, at least we want to have good details … most of the customer will come here and
see the pages"*, plus a dynamic per-match poster shareable at Instagram size.

## Goal

A spectator — a player, a parent, a club member, a sponsor — arrives on `/shared/…` from
a shared link, a QR poster, or a search result. Today a cricket match there is a headline
and a two-row score; the competition page has no matches list, no table, no leaders; the
copy is English on every locale; the only share image is the landscape OG meta card.

Every one of those visits is a customer's first impression of the organiser **and of
seazn** (free orgs carry "Powered by seazn"). Make the public pages the product's front
window:

1. a **match centre** with cricheroes-grade detail — live header, full scorecard,
   commentary, match info — for every sport's shell and cricket's depth first;
2. a **competition landing** that answers *what is on, who is winning, when do we play*
   on a phone in one screen;
3. a **share-ready match poster** (pre-match, live, result) at Instagram sizes, with the
   real crests and the competition's colours, downloadable by anyone;
4. a **spectator walkthrough** that drives the whole surface in an anonymous browser,
   growing with every wave;
5. a **photo gallery** the organiser's own people fill from the same public page, with
   media consent built into the upload (owner addition during brainstorm).

Customer value, stated as the owner asked: the organiser gets a professional public face
without doing anything; the player gets their scorecard and their per-match line; the
sponsor gets a logo on every shared poster; seazn gets the growth loop — every share
carries the brand to the next organiser.

## Decisions locked during brainstorm (owner, 2026-09-04)

1. **Sport scope**: the match-centre shell (tabs, live header, info, share, poster) is
   built for every sport; **cricket gets the first deep module** (scorecard + commentary
   from the ledger). Other sports were to get a Timeline tab in a later wave — superseded
   by decision 9: they get it in W1.
2. **Poster**: **upcoming + live + result** variants on one route, **feed 4:5 (1080×1350)
   and story 9:16 (1080×1920)**, downloadable from the public fixture page by anyone.
3. **Order**: **W1 match centre → W2 landing → W3 poster**. The spectator walkthrough is
   not a wave; every wave extends it.
4. **Scope is `/shared` only.** The organiser console is not touched. No organiser-set
   fields (no player-of-the-match column); "top performers" are computed from the ledger.
5. **Every public page is composed for the phone, not shrunk — including the existing
   pages** (org home, competition, division, fixture, player, news).
6. The session runs **as product owner**: remaining calls are made here, each stated as
   value to the customer, and recorded in this document and the programme index.
7. **Gallery upload is in** (owner, mid-brainstorm) as its own wave, W4, after the
   poster; the other sports' Timeline moves to W5. Upload is for the org's own signed-in
   staff from the public gallery page; never anonymous.
8. **Subagents run on Opus at minimum** (owner, mid-brainstorm). `.claude/agents/*.md`
   frontmatter and `RULES.md` are updated on this branch. Recorded caveat: another
   session logged the account's Opus weekly limit as hit on 2026-09-04, resetting Sep 5
   19:00 Europe/London, with Opus subagents dying on arrival (429) until then — any agent
   dispatched in that window gets the settling check (`git log`, `git status
   --porcelain`, report path) before its final message is believed.
9. **"Option A is OK in both — but not only for cricket"** (owner, 2026-09-05, on
   the W0 canvas). Match centre A and poster A are confirmed, and **every sport gets
   its depth in W1**, not a shell: cricket gets Scorecard + Commentary; every other
   sport gets a **Timeline** tab derived from its ledger (one localised template per
   engine event type) and, where the sport has sets or periods, a **Sets / Periods**
   tab promoting today's breakdowns. The former "W5 — other sports' Timeline" is
   folded into W1 and no longer exists as a wave.

## Current state — block I, from the tree (2026-09-04, scout-verified `file:line`)

| # | What a spectator sees | Where | Customer cost |
|---|---|---|---|
| 1 | A cricket fixture page is an H1, one headline line and a two-row score. No batting card, bowling figures, extras, fall of wickets, partnerships, over log, target or required rate. `LiveScore` has no cricket branch; cricket lands on the generic long-score fallback. | `components/public-site/live-score.tsx:160-259`; `server/public-site/data.ts:246-250` (`summary = {headline, perSide, detail}`); `components/public-site/schedule.tsx:62` | The parent asks the scorer. The player screenshots the pad. Nobody shares the page. |
| 2 | The competition page is a hero, a Live-now rail, a divisions grid and sponsors. No matches list, no points table, no leaders. | `app/(public)/shared/[orgSlug]/[competitionSlug]/page.tsx` | "When do we play / who is top" needs one division drill-down per division. |
| 3 | Competition, division and fixture pages and `LiveScore` are hardcoded English; only the org home and the player stat labels use the dictionary. | no `@/lib/i18n` import in those files; `schedule.tsx:16` self-documents "a pre-existing gap" | A French club's public face is in English. Breaks the standing 4-locale rule. |
| 4 | The only poster is the competition QR poster (HTML print page + pdfkit A4 PDF), linked from the organiser console. The only per-match image is the 1200×630 OG meta card. Crests are text monograms; `entrants.badge_url`, `team_display_v.logo_path` and `colors` reach no card. | `…/[competitionSlug]/poster/page.tsx:23`, `poster.pdf/route.ts:41`; `server/og/card.tsx`, `og/post-card.tsx:97` (a 1080×1350 story card already exists for news); DB `V288__v13_fidelity.sql:11`, `V242__clubs_and_imports.sql:12-13,67-78`, `V260__org_branding.sql:11` | Organisers hand-make posters in Canva, or do not. No share loop. |
| 5 | Competition, division and fixture pages carry no testids. `/shared` e2e coverage is ~20 single-assertion specs. No spectator walkthrough. | `apps/web/e2e/**` grep on `shared/` | Regressions on the most-viewed pages are found by customers. |
| 6 | The player page is career + per-division aggregates; no per-match lines. | `…/players/[personId]/page.tsx`, `data.ts:778` | The "my scorecard" hook — the reason players install cricheroes — is absent. |
| 7 | Pro orgs get Supabase Realtime on the fixture page; free orgs poll every 15 s. Either way only the headline moves. | `live-score.tsx:29,71-117` | Live means "the number changes", not "I can follow the match". |

**Cricket data reality.** The reduced engine state holds innings totals, per-batter
runs/balls, per-bowler overs/runs/wickets, striker/non-striker/bowler, revised target,
result, super over and DLS (`packages/engine/src/sports/cricket/cricket.ts:411-476,
3288-3325`). Everything else a scorecard shows — 4s/6s, strike rate, economy, maidens,
extras by kind, fall of wickets, partnerships, ball-by-ball, required rate — is
**derivable from the `score_events` ledger and read by nothing outside the pad**. The
ledger's fidelity is tiered 0–3 per event type (`cricket.ts:2985-3001`; band scale closed
at 0–3, `module.ts:96`), so a public scorecard must degrade by tier: a tier-0 match is a
result and nothing else.

### Block II — screens (captured 2026-09-05; prod build, label `spx`; seed and capture harness `apps/web/e2e/walkthrough/w0-spectator-capture.spec.ts`)

Block I is what the code says; this is what a person sees. Method: 13 pages × 4 widths
(320/375/768/1280) in an anonymous browser context; full-page and above-the-fold
screenshots; `scrollWidth − clientWidth` per width; and a **control-set diff** (every
visible link, button, tab, input and summary by label) at 320 against 1280. Result:
**no page scrolls horizontally at any width, and no page has a single phone-only or
desktop-only control — the control set is identical at 320 and 1280 on all 13 screens.**
Passing the no-horizontal-scroll gate while being a shrunk desktop everywhere is
precisely the case R1 exists for.

| Screen | What the phone shows (375) | Verdict | Customer cost |
|---|---|---|---|
| Fixture · cricket, live | Header, breadcrumb, H1, "Share on WhatsApp", date; a court card with a LIVE pill, a score headline wrapped onto two lines ("56/6 (8) — 51/0" / "(4.3)"), two team rows. Then roughly 60% of the screen is empty. | Shrunk, and empty | "Who is batting? How many do they need?" cannot be answered. The parent asks the scorer. |
| Fixture · cricket, final | The same plus one sentence above the card ("Match tied") and an ENDED label. | Shrunk, and empty | No batting card, bowling, or top performers — nothing to screenshot or share after the match. |
| Fixture · upcoming | H1, share, date, a card reading "SCHEDULED / Not started". | Empty | No venue, format, squads or countdown; no poster. |
| Fixture · football, final | Headline and goals by period (today's `LiveScore`). | Shrunk | Same shell problem; the sport content is real and stays in W1's Summary. |
| Competition | Hero card (org eyebrow, name, the END date, WhatsApp / Copy link, Present, count chips); a Live-now rail whose card shows the score with **no team names**; the divisions list. | Shrunk | The live card cannot be read without a tap; no matches list, table or leaders. |
| Division · Schedule | Segmented Schedule / Standings / Entrants pill (good); entrant filter, Day / Round toggle, Add to calendar; day groups; rows truncate team names to "Southend Blue …" / "Rochford Ramb…" with the score in a pill. | Rail designed; rows shrunk | Team identity — the one thing a spectator scans for — is lost in the row. |
| Division · Standings | A `# · TEAM · P · W · L · T · NR · …` table inside a scroll box; "Southend Blue Blazers" wraps onto three lines; the points column sits off-screen at 320. | Shrunk table | The number the table exists for is not visible without scrolling inside the box. |
| Division · Entrants | 40 identical controls at 320 and 1280. | Shrunk | — |
| Player | Monogram, name, org, "In this competition: Men's T8 — Southend Blue Blazers". Then empty. | Empty | No per-match lines; the "my scorecard" hook is absent. |
| Org home | Hero; the competitions list shows a status chip reading **"UPCOMING"** on a competition that has a live match and two finished ones. | Shrunk, and wrong | The org's front door says nothing is happening while a match is live. |
| News · Register | Empty state / closed state. Captured for the mobile audit only. | — | — |

Recorded on the way: the division chip reads **"T20" for an 8-over configuration** (it
prints the variant key, not the configured format — W3's `describeFormat` and W2's chips
must read the config); the schedule's day headers print "times in UTC" because the seeded
org has no timezone (correct, ugly — W2 drops the zone caption when it equals the
viewer's); `cricket.toss` must precede `core.start` (`422 WRONG_PHASE` otherwise), so the
walkthrough seeds the toss first; and posting a tier-3 ledger through the API runs the
strict fold on every event, so ~190 events take ~9 minutes — the walkthrough seeds
short matches (8 overs, 8 a side) and taps one over, it never posts a full T20.

### Options shown and the product-owner pick (2026-09-05)

Two directions each, on the same seeded data, in the app's own tokens (Barlow Condensed
display, Geist body, `#7c3aed` accent, `#231738` court card, the shipped dark header bar),
on the canvas linked in the header:

- Match centre **A — court header + tab rail** (Summary · Scorecard · Commentary · Info)
  against **B — one scrolling page** with a sticky compact score strip and jump chips.
  **Pick: A.** A 2,500 px phone page is the wrong trade for a live match; the tabs map
  one-to-one onto the fidelity ladder (a tier-2 match simply has no Commentary tab); and A
  keeps the court card as the shared shell for every sport.
- Poster **A — crest tiles** on the competition's court colour against **B — split field**
  in the two team colours. **Pick: A.** It survives two similar team colours and a
  43-character name, real badges drop straight into the tiles, and the result variant
  reuses the layout (shown). B stays on the canvas as the bold alternate for a later
  template choice.

Both picks were made as product owner under decision 6; the owner reverses either by
naming the other letter — the artboards keep their names on the canvas.

### Reference structure (cricheroes, fetched 2026-09-04)

Tournament page: header (name, city, view count, date range, total matches, total
teams); tabs *matches · leaderboard · points table · stats · heroes · sponsors · teams ·
gallery · about*; match filter *live · upcoming · completed*; match card = tournament,
ground + city, date, overs, stage label ("Eliminator", "Qualifier 1", "League Matches"),
status, team A score (overs), team B score (overs), result line. Scorecard pages are
client-rendered; their tabs are *Summary · Scorecard · Commentary · MVP · Info*; the live
header carries score, overs, run rate, target and required rate, the batters at the
crease (R, B, 4s, 6s, SR), the bowler (O, M, R, W, Econ), this over, partnership and last
wicket; the scorecard tab is batting and bowling tables, extras, total, fall of wickets,
did-not-bat; commentary is ball-by-ball; info is toss, officials, venue, ball type, overs.

**Deliberately not copied:** view counters (vanity), app-download interstitials
(web-first), the MVP points formula (a proprietary opinion — we show top performers
derived from the ledger), ads. The gallery IS copied in spirit (W4) — parents come back
for photos. We copy the *level of detail*, not the site.

## Standing rules for every public page (binding; restated for subagents in `_RULES.md`)

- **R1 — Phone composition, not shrink.** Each page is designed at 320/375 first; ≥768 may
  add columns or lay cards two-up, never new controls. Verify with a **control-set diff
  from the live DOM at 320 against 1280** — membership, order, repeats — not box sizes.
  Any scrolling region carries `tabindex="0"`, a role and an accessible name; no page
  scrolls horizontally at 320/360/375/390/430/768/834.
- **R2 — Every string through the `public` dictionary namespace in all four locales**,
  `gen-keys` regenerated. Cricket column abbreviations (R B 4s 6s SR · O M R W Econ) stay
  as the sport's own notation with localised `title`/`aria-label`.
- **R3 — Consent before names.** Every person name on a public page or image goes through
  the public-site consent resolver RS008 unified (the plan pins the symbol) — scorecards,
  commentary, top performers, posters, entrant lists. A masked line renders the masked
  label, never a blank row. Youth rule as in `fixtureCardModel`.
- **R4 — Fidelity ladder from the engine.** A match's fidelity is the max tier present in
  its ledger, read from the engine's own per-type declarations, never a table typed into
  the web app. Tier 3 → all tabs; tier 2 → Summary + Scorecard + Info; tier 1 → Summary
  (innings totals) + Info; tier 0 → Summary (result) + Info. **A tab that would be empty
  is not rendered.** No "coming soon".
- **R5 — One authority per fact.** Ball semantics (legal ball, extras attribution,
  dismissal credit) live in the engine cricket module; the web app maps, formats and
  localises and never re-derives a cricket rule. Chase derivations (target, required
  rate, projected) live beside the engine's own `chaseTarget`, not in a component.
- **R6 — No new entitlement rows.** Match centre, scorecard, commentary and poster are on
  every plan: they are the growth loop. Existing gates reused as-is — Realtime push on Pro
  and poll otherwise; `org.branded` decides the page and poster footer ("Powered by seazn"
  vs the org). Entitlements v18 is in flight; this programme adds nothing to its matrix.
- **R7 — Testids on every new control** (`mc-…` match centre, `mh-…` matches hub,
  `poster-…`); every wave extends `e2e/walkthrough/spectator-public.spec.ts`. Setup may
  use the API to REACH a state, but **at least one over of the cricket match under test
  is TAPPED through the real pad**, so the pad → ledger → public page seam is driven end to
  end rather than fixtured on both ends.
- **R8 — The share loop is a feature.** Every public page has the share bar (copy link,
  WhatsApp, X, native share); the fixture page adds poster download (W3). The free-tier
  footer "Powered by seazn" stays on every public page and poster of a non-branded org.
- **R9 — Empty case first.** Every aggregate (matches filter default, table, leaders, top
  performers) states its empty case before its ladder (competition-desk ruling; three
  vacuous "Finished" defects shipped in one wave there).
- **R10 — Live means live, never reload** (owner, 2026-09-05). Every public surface that
  shows a match in play updates **in place**: the match centre (every tab, not the
  headline), the competition Live-now rail and Matches hub cards, the division schedule
  rows, the standings after a result lands, the org home's status chips. Transport is
  the existing pair — Supabase Realtime push on Pro, polling otherwise (15 s today) —
  carrying the same public JSON the page rendered from, so a push and a poll produce the
  same DOM. A spectator is never told to refresh, and a page never reloads itself. The
  proof is end to end: the walkthrough posts an event through the API while the
  anonymous page is open and asserts the DOM changes within one poll interval with no
  navigation; a test that reloads to see the change has not tested this rule.

## The shared model (W1; W2 and W3 key off it)

### Engine fold: `deriveCricketScorecard`

`packages/engine/src/sports/cricket/scorecard.ts` —
`deriveCricketScorecard(events, cfg): CricketScorecard`, a pure fold over the same
ledger the reducer consumes, **reusing the reducer's ball-classification helpers**, not
re-implementing them (R5). Shape:

```ts
type CricketScorecard = {
  fidelity: 0 | 1 | 2 | 3;                       // max tier present, from the engine's declarations
  toss?: { winner: SideId; elected: "bat" | "bowl" };
  innings: CricketInningsCard[];                 // in order; super-over innings flagged
  live?: {                                       // only while in play
    battingSide: SideId; striker?: PersonRef; nonStriker?: PersonRef; bowler?: PersonRef;
    thisOver: BallGlyph[]; partnership: { runs: number; balls: number };
    lastWicket?: { batter: PersonRef; runs: number; balls: number; scoreAt: string };
    crr: number; target?: number; rrr?: number; needRuns?: number; ballsLeft?: number;
    projected?: number;                          // first innings only
  };
  result?: { kind: OutcomeKind; winner?: SideId; margin?: Margin; messageKey: string };
};
type CricketInningsCard = {
  side: SideId; number: number; isSuperOver: boolean; declared: boolean; closed: boolean;
  total: { runs: number; wickets: number; legalBalls: number; overs: string; runRate: number };
  extras: { wides: number; noBalls: number; byes: number; legByes: number; penalties: number; total: number };
  batting: BattingLine[];      // order, person, runs, balls, fours, sixes, strikeRate, dismissal
  didNotBat: PersonRef[];
  bowling: BowlingLine[];      // person, overs, legalBalls, maidens, runs, wickets, economy, wides, noBalls
  fallOfWickets: { wicket: number; runs: number; over: string; batter: PersonRef }[];
  partnerships: { batters: [PersonRef, PersonRef]; runs: number; balls: number; wicket: number | "unbroken" }[];
  overs: OverLog[];            // number, bowler, balls: BallGlyph[], runs, wickets, scoreAfter
};
```

Input by tier: tier 3 (`cricket.ball` / `cricket.superover.ball`) fills everything; tier
2 (`cricket.player.line`) fills `batting`/`bowling` and leaves `overs`, `fallOfWickets`,
`partnerships` empty; tier 1 (`cricket.innings.summary`) fills `total` only; tier 0
(`match.close`) fills `result` only. `dismissal.kind` is the engine's wicket enum, not a
string.

**Tests derive expectations from the engine's own declarations.** Ledger fixtures are
built through the engine's event schemas; totals are asserted equal to the reducer's
`ScoreSummary` on the same ledger (fold–reducer parity), so a cricket rule change moves
both. **Parity sweep, not one sample**: one scripted two-innings ledger with wides,
no-balls (free hit), byes, leg byes, penalty runs, a retired hurt, every dismissal kind
the enum declares (run out with a fielder among them), a maiden, a bowler changing ends,
a declared innings and a super over — with per-element assertions and mutation checks
(delete the wide branch → the extras test reds; swap striker and non-striker on a run-out
→ the partnership test reds). Every mutant is listed in the PR with the test that killed it.

### Web view model and transport

`apps/web/src/server/public-site/match-centre.ts` —
`buildMatchCentre(fixture, ledger, consent, locale): MatchCentreModel` = a sport-agnostic
shell `{ header, tabs, info }` plus `cricket?: CricketScorecardView` with names resolved
and masked (R3), numbers formatted, dismissal text as dictionary keys with params. The
public fixture JSON the `LiveScore` client already refreshes from (Realtime push on Pro,
15 s poll otherwise — the plan pins the URL) **carries the model**, so a push re-renders
the whole match centre, not the headline. Cost: a fold over ~250 balls is sub-millisecond;
no caching layer is added.

## W0 — capture and options (this session; no product code)

1. Prod build in this worktree per `seazn-local-env`; seed one public competition with a
   cricket division (tier-3 ledger, one live and one finished match) and a football
   division; capture every public page (org home, competition, division, fixture, player,
   news; register is captured only — RS owns it) at 320/375/768/1280.
2. Append **Current state block II** — per screen: what is present at 320 vs 1280
   (control-set diff), where it is a shrunk desktop, customer cost.
3. Publish a design artifact with **two options each** for the match centre (phone first,
   live and final) and the poster (feed). Owner picks a direction; the pick is recorded in
   "Decisions" and the programme index.

## W1 — match centre (`…/fixtures/[fixtureId]`, all sports; cricket deep)

### Composition at 320–430 (one DOM, branched with `max-md:*`)

```
‹ Division                                   [share]
LIVE · 12.3 ov                    (or) Result
Mumbai Kings              142/6 (20)
Rajasthan Rajvansh         98/3 (12.3)     ← side in play bold
Rajvansh need 45 from 45 · CRR 7.84 · RRR 6.00      (live)
Mumbai Kings won by 12 runs                          (final)
[Summary] [Scorecard] [Commentary] [Info]   ← scroll rail, role=tablist, tabindex=0
… tab body …
Powered by seazn
```

≥768 keeps the same controls; Summary's performer cards go two-up and each innings'
batting and bowling tables sit side by side. Nothing appears that 320 does not have.

### Tabs

- **Summary** (cricket). While live: batters at the crease (name, R(B), 4s, 6s, SR,
  striker dot), bowler (O-M-R-W, Econ), this-over glyphs, partnership, last wicket. Always:
  top performers per innings (best batter by runs then strike rate; best bowler by
  wickets then economy — computed, R4/R9), fall of wickets as compact chips
  ("1-12 · Smith · 2.3"), partnerships as a bar list, extras line. Final: result line first.
- **Scorecard**. Per innings, accordion, the innings in play (or the last) open: batting
  table — Batter with dismissal on a second line · R · B · 4s · 6s · SR; Did not bat;
  Extras (w nb b lb p); Total (runs/wkts · overs · RR); bowling table — Bowler · O · M · R
  · W · Econ · wd · nb; fall of wickets. At 320 the name column is `min-w-0 truncate`,
  numerals tabular and fixed-width; **the target is no horizontal scroll at 320 for six
  numeric columns** — measured on the W0 mockup; if it cannot fit, 4s/6s fold into the R(B)
  cell ("34 (21) · 4×4 1×6") and the decision is recorded.
- **Commentary** (tier 3 only). Over-grouped, newest first; over header
  "Over 12 · 7 runs · 98/3 · Jones 2-0-14-1"; ball line "12.3 · Jones to Smith · FOUR" with
  the outcome localised from a fixed template set derived from the engine's ball schema
  (runs 0–3, four, six, wide, no ball (+runs), bye, leg bye, penalty, wicket by kind,
  free hit). "Load earlier overs" after five overs. Live appends at the top.
- **Info**. Toss; format (overs, balls per over, players a side, powerplay if configured);
  venue/court; start time in the **venue zone** (`resolveVenueTz`, the competition-desk
  "one zone per fixture" ruling); stage/round; officials if the fixture has any; division
  and competition links; calendar (.ics) link.
- **Every other sport in W1** (decision 9): Summary = today's `LiveScore` content
  (headline, per-side, discipline, serving dot) inside the shell; **Timeline** = the
  fixture's ledger rendered newest-first, one localised template per engine event type
  (football goal / card / period / shoot-out kick; racket-sport point-game-set
  transitions; volleyball rotation; carrom and board-game frames; `core.*` phase
  events) — the template set is derived from each module's declared event schemas so a
  new event type cannot ship unlocalised, and a type without a template renders a
  neutral line, never nothing; **Sets / Periods** = today's `setBreakdown` /
  `periodBreakdown` promoted to a tab with per-set games (racket sports) or
  goals-by-period plus scorers (football) when the ledger carries them; Info as above.
  A tab whose ledger has nothing for it is not rendered (R4). The cricket Scorecard and
  Commentary tabs are the sport-specific versions of the same two ideas.

### Live behaviour, meta, footer

Transport unchanged; payload is the model; **every tab re-renders in place from the new
model** (R10) — the live block, the batter's line in Scorecard, the newest over in
Commentary, the Timeline's newest event, the Sets / Periods table — with no navigation
and no reload. LIVE pill reads "updated Ns ago" and keeps counting through a Realtime
drop (poll fallback, no toast to a spectator). A push that opens a new innings opens that
innings' accordion; a push that ends the match swaps the chase line for the result line
and the LIVE pill for the result chip, in place. `<title>` and description carry the
score when final ("Mumbai Kings 142/6 beat Rajasthan Rajvansh by 12 runs · DJPL 2026").
The landscape OG card is unchanged in W1. Footer per R6/R8.

### Tests (all four, stated here so the plan cannot drop one)

- **Unit**: the engine fold parity sweep (above); the web view model — masking, number
  formatting, dismissal keys per enum member × 4 locales (a new dismissal kind cannot ship
  unlocalised), the tier ladder with **the empty ledger stated first**, top performers'
  tie-breaks.
- **E2E**: `e2e/walkthrough/spectator-public.spec.ts` v1 — reach a cricket match mid-innings
  via the API, open the match centre in an anonymous context FIRST, then **TAP one over
  through the real pad** including a wide and a wicket, and assert — without navigating
  or reloading the anonymous page — that the over arrives in Commentary, the batter's
  line in Scorecard and the fall-of-wickets entry in Summary within one poll interval
  (R10), at 320 and 1280; a finished match shows the result
  line and top performers; a football fixture shows its goals on the Timeline tab and its
  halves on Sets / Periods, with no Scorecard or Commentary tab present. Plus an axe pass
  and the no-horizontal-scroll check at the seven widths for the fixture page (a public
  fixture case added to the `mobile.spec.ts` projects).
- **Smoke**: `scripts/smoke.ts` gains a public fixture page GET asserting the `mc-` markers
  and the public fixture JSON carrying `matchCentre`.
- **Regression**: the generic long-score fallback no longer renders for cricket
  (`schedule.tsx:62`); a dictionary-coverage assertion over the rendered fixture page in
  all four locales finds zero hardcoded English.
- **Screens**: 320/768/1280 for every tab, live and final, attached to the PR.

## W2 — competition landing, division and player pages, i18n sweep

The competition page becomes the competition's front window. Tab rail at phone widths:
**Overview · Matches · Table · Stats · Teams · Gallery · Info**; a tab with nothing to
show is not rendered (R4/R9) — Gallery therefore appears only once W4 has shipped and
the competition has photos; W2 reserves its slot and order, nothing more.

- **Overview**: hero in the brand colour with logo; status line ("Live now: 2 matches" /
  "Next: Sat 14:00" / dates); the Live-now rail upgraded to carry team names and scores;
  next three matches; first three rows of each table; register CTA when open; sponsors
  (existing tiers). **Live in place (R10)**: the Live-now rail, the Matches hub cards,
  the division schedule rows and the tables subscribe to the competition's live feed
  (Realtime on Pro, poll otherwise) and re-render without a reload — one client
  subscription per page, not one per card.
- **Matches**: all divisions. Filters *Live · Upcoming · Completed* — default is Live if
  any, else Upcoming if any, else Completed (empty case first). Division chips. Grouped by
  day in the venue zone. Match card = division chip · stage/round label · time or LIVE
  pill · venue/court · two rows of crest + team + score (overs) · result line or "Starts in
  2 h" · poster icon (W3). Links to the match centre.
- **Table**: per division, the existing `StandingsTable` under a division header with a
  "Full division" link; restyled for 320 (rank · crest · team · P · W · L · Pts with the
  long tail behind a "more" disclosure), never a shrunk desktop table.
- **Stats**: leaders per division from the existing public player-stat folds — cricket:
  most runs, most wickets, best strike rate above the module's minimum-balls floor;
  football: goals; other sports: the module's `MetricSpecLike` order. Rows link to the
  player page.
- **Teams**: every division's entrants with a badge (real image via `badge_url` /
  `logo_path`, else a monogram in the team colour) linking to the division's Entrants tab.
  No public team page (out of scope, noted as a later candidate after W5).
- **Info**: description, dates, venues, sponsors, registration state, .ics, share bar.

**Division page**: same rail treatment; Schedule reuses the match card; Standings restyled
for the phone as above; Entrants get badges. **Player page**: a per-match performances
list (cricket "34 (21) & 2/18", other sports the fixture result) linking to match centres,
from the same fold, consent-gated as today. **i18n sweep**: competition, division,
`LiveScore`, schedule, layout tagline — every string into the `public` namespace, four
locales; the W1 coverage assertion widened to every `/shared` page.

Tests: unit (filter default ladder with the empty case first; day grouping across a DST
boundary in the venue zone; leaders' floor read from the module spec), e2e (walkthrough
v2: org home → competition → Matches filters → Table → Stats → player → division at 320
and 1280 with the control-set diff asserted; then, with the competition page open in the
anonymous context, an event posted through the API moves the Live-now card and the
Matches hub card without a reload — R10), smoke (competition page GET carries `mh-`
markers), regression (zero hardcoded English on every public page, four locales).

## W3 — match poster

**Route** `…/fixtures/[fixtureId]/poster.png?format=feed|story` (default `feed`), rendered
with `next/og` `ImageResponse` exactly as `news/[postSlug]/story.png` is. Caching by
status: upcoming `revalidate 60`, live `no-store`, final `revalidate 300`. A private
competition's poster 404s like its page.

**Model** `matchPosterModel(...)` in `server/og/match-poster.tsx` beside `post-card.tsx`,
pure and unit-tested; reuses `ogTheme`/`resolvePublicTheme` for the brand colour (WCAG
guarded) and `fixtureCardModel`'s youth rule (R3).

**Anatomy — feed 1080×1350** (the owner's reference informs the hierarchy; the art is ours):

1. competition or org logo centred; eyebrow = competition name;
2. display line = stage/round label ("League · Round 3", "Semi-final", "Eliminator");
3. two crests — the real badge when `entrants.badge_url` or `team_display_v.logo_path`
   exists, else a monogram tile in the team's `colors.primary` or a deterministic palette
   colour — a "V" mark between; team-name pills below;
4. format line from the sport module's config via a small `describeFormat` per sport
   ("8-over match", "Best of 3 sets", "2 × 20 min") — keys, not English;
5. date · time · venue pill, venue zone, org locale;
6. footer: title-sponsor logo strip when the competition has one; "Powered by seazn"
   unless `org.branded`, then the org name/logo.

**Result variant**: scores under the crests ("142/6 (20)"), the result line as the display
line, two top-performer lines (masked per R3 — a masked performer is *dropped*, never
printed as a mask: a poster is permanent). **Live variant**: LIVE pill, score + overs,
CRR/target/RRR line, batters at the crease, "updated HH:MM". **Story 1080×1920**: same
components, stretched vertical rhythm, nothing new.

**Fonts**: satori needs real font data per weight; an OFL display + text family (bold and
regular) is pinned under `apps/web/public/fonts` with its licence file, used only by image
routes. **Badges** are fetched inside the route with a timeout and fall back to the
monogram — never a broken image in a poster.

**UI**: the fixture page share bar gains "Download poster" (feed / story) — a real
`<a download>` plus `navigator.share({ files })` where available, so a phone shares straight
into Instagram or WhatsApp; the Matches hub's cards carry the poster icon.

Tests: unit (model per variant × format, masking-drops-the-line, badge fallback, sponsor
strip presence, branded footer switch, `describeFormat` per sport), e2e (walkthrough v3:
download both formats from the fixture page in the anonymous context, decode the PNG and
assert 1080×1350 and 1080×1920, assert the result variant's text through the model),
smoke (`poster.png` 200, `image/png`, non-trivial size), regression (private competition's
poster 404; a masked minor never reaches the model). The three variants × two formats are
rendered and attached to the PR.

## W4 — gallery (owner addition, 2026-09-04)

**Value.** Parents and players come back for photos, and a competition page with a
gallery gets shared again after the match is over. The organiser gets one place for
match-day photos instead of a WhatsApp group; sponsors get their ground branding in
every picture. Scope stays `/shared`: the upload control lives **on the public gallery
itself** and is shown only to signed-in members of the org with a staff or scorer role
(existing session + role check). **No anonymous uploads** — spam, abuse and consent.

**Model.** Table `gallery_photos` (competition_id, division_id nullable, fixture_id
nullable, storage_path, width, height, caption, taken_at, uploaded_by, consent_confirmed_at,
created_at, deleted_at soft-delete). Storage: a Supabase Storage bucket `gallery` with
unguessable object paths (the division-logo `logo_storage_path` pattern is the precedent).
Two derivatives at upload — thumb 400 px, display 1600 px — via `sharp` in the upload
route; the original is kept; **EXIF stripped** (location privacy). Limits as product
constants: 10 MB per file, 200 photos per competition — a plan-tiered quota is a v18
question for the owner, not this programme (R6). The migration and any policy are
written under the Supabase Postgres best-practices skill; the schema is `seazn_club`.

**Surfaces.** Competition page **Gallery** tab (slot reserved in W2): grid of thumbs
grouped by day and match, lightbox with swipe, caption, share and download. Match centre
gains a **Photos** strip (up to six thumbs + "All photos") when the fixture has photos.
Both hidden when empty (R4/R9).

**Upload (staff only).** "Add photos" on the Gallery tab opens a sheet: multi-select from
the camera roll or camera (`accept="image/*" multiple`, mobile capture), optional match
tag (fixtures of that day, default the live or most recent), caption, then the
**media-consent gate**: the sheet shows how many players in the tagged division(s) have
media consent *declined* (the RS007 per-player media consent already collected) and
requires the tick "I have checked that everyone pictured has media consent" — stored as
`consent_confirmed_at` with the uploader. Per-file progress and retry. Any staff member
can delete from the lightbox (soft delete; derivatives and original removed in the same
request). The upload endpoint is `POST /api/v1/competitions/{id}/gallery`
(session-scoped, rate-limited), so the OpenAPI drift gate sees it.

**Public safeguards.** "Request removal" on every lightbox — a prefilled message to the
org's contact carrying the photo id; a removed photo 404s immediately in every reader;
no per-photo pages (the lightbox is a URL hash), `noindex` on the gallery tab's images.

**Tests.** Unit (derivative sizing, EXIF strip, quota ladder with the empty case first,
declined-consent count from the division's players, role check). E2E (walkthrough v4: a
staff context uploads two photos from the public gallery with a match tag and the consent
tick; the anonymous context sees them on the Gallery tab and the match centre's Photos
strip at 320 and 1280; removal → 404; the quota message at the cap). Smoke (gallery tab
GET carries `gl-` markers; the storage object exists). Regression (anonymous POST → 401;
upload without the consent tick → 400; a soft-deleted photo is absent from every reader).

## W5 — queued, not designed here

The other sports' Timeline that used to sit here moved into W1 (decision 9). The queued
candidate is the **public team page** (`…/teams/[entrantId]`: badge, squad, results,
upcoming, table position — captains share it to their squad), recommended to the owner
2026-09-05 and not yet ruled on. Own design pass after W4.

## Copy and i18n

Keys under `public.matchCentre.*`, `public.matchesHub.*`, `public.poster.*`. Dismissal
templates are keyed by the engine's wicket enum — `caught` "c {fielder} b {bowler}",
`bowled` "b {bowler}", `lbw` "lbw b {bowler}", `runOut` "run out ({fielder})", `stumped`
"st {fielder} b {bowler}", and the rest of the enum as declared — and a unit test asserts
every enum member has a key in every locale. Result lines are keys with params
(`wonByRuns`, `wonByWickets`, `wonSuperOver`, `wonDls`, `tied`, `noResult`, `abandoned`).
Cricket column abbreviations stay as notation (R2).

## Error and empty states

- Private competition → the existing branded 404; unlisted → reachable, `noindex` (today's
  behaviour, unchanged).
- Fixture without a ledger: Summary shows both sides, "Starts {relative}", venue; Info
  full; poster = upcoming variant.
- Abandoned / no result: the result line from the engine's outcome kind; tabs per tier.
- Masked names: masked label on pages, dropped line on posters (R3).
- Realtime drop: poll fallback, the "updated Ns ago" counter keeps counting; no toast.
- Badge fetch failure: monogram fallback (W3).
- Every aggregate's empty case is written in its test before its ladder (R9).

## Out of scope

Organiser console changes; player-of-the-match as a stored field; view counters,
comments; anonymous photo uploads; public team pages (later candidate); MVP points; ads;
the `present` kiosk slides; the scorepad; the landscape OG card's design; entitlement
matrix rows (including a gallery quota by plan); registration pages (RS programme owns
them — captured in W0 for the mobile audit only).

## Wave order, PRs, gates

W0 this session (docs + capture + artifact). W1 one PR — it may split at the engine-fold
boundary if the review load demands, and the fold's PR then still ships its unit sweep
plus a smoke assertion that the public fixture JSON carries the model, so the seam is not
left inert. W2 one PR. W3 one PR. W4 one PR (migration + storage + upload + gallery
tab + photos strip; its walkthrough leg needs a signed-in staff context beside the
anonymous one). W5 designed after W4. Every PR: implementer ↔ reviewer loop until clean;
gates run by the orchestrator with JSON-reporter counts pasted; e2e via
`workflow_dispatch` with the PR number (e2e does not run on PRs); smoke is PR-only;
screenshots at 320/768/1280 in the PR; the walkthrough green in the `walkthrough`
project; `openapi:gen` drift clean; the programme `_INDEX.md` status log updated in the
same PR.

## False-premise watch list (re-pin against the tree before building on any of these)

- The URL the `LiveScore` client polls (the scout named the mechanism, not the endpoint).
- The consent resolver's symbol in `server/public-site` (RS008 unified it; not named here).
- `next/og`'s bundled default font and which weights it carries.
- Whether any organiser flow writes `entrants.badge_url` today (a column read everywhere
  and written nowhere is a known pattern in this repo — if unwritten, the poster's crest
  path is proven with `team_display_v.logo_path` and the monogram fallback, and the gap is
  recorded, not silently absorbed).
- The share of tier-3 versus tier-2 cricket ledgers in the wild — decides how prominent
  Commentary is by default (the ladder hides it when empty either way).
- The engine's private `chaseTarget` — export or wrap it; never duplicate the formula.
