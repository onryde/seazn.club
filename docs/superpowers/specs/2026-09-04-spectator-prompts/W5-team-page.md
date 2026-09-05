# W5 — the public team page (per entrant, in a division)

> **Status: CANDIDATE — not yet ruled in scope by the owner.** `_INDEX.md`
> lists W5 as "Public team page (candidate…) — Not designed, not yet ruled",
> and the entry recording it sits under `_INDEX.md` §"Product-owner calls made
> in-session (mine, recorded so they can be reversed)" — an AGENT's
> recommendation, never the owner's ruling, and the two are never
> interchangeable. Nothing in this prompt executes until the owner
> rules Q1–Q10 below. Spec §W2 Teams still reads *"No public team page (out of
> scope, noted as a later candidate after W5)"* — W5 is the wave that would
> change that line.

Read `_RULES.md` → `_INDEX.md` → spec §W5 (lines 562–567) and §W2 Teams
(lines 449–450): `../2026-09-04-spectator-surface-design.md`. Plan:
`../../plans/2026-09-05-spectator-w5-public-team-page.md` (CANDIDATE DRAFT).
Worktree; one PR. Depends on W1 (the court card and `matchCentre.info.*`
keys), W2 (the hub document, `MatchCard`, `StandingsTableView`,
`PublicTabRail`, `useLiveCompetition`, the leaders reader) and W4 only in the
sense that it queues after it. **Every W2 name this wave consumes is a DRAFT
name today — re-pin premises P1–P17 (listed in the plan) after W1–W4 merge.**

## Why the wave exists

A captain has one job in the group chat every week: answer "what time is it
Saturday?". Today the answer is a screenshot. The team page replaces it with
one link that also carries the organiser's public face and — for a free org —
"Powered by seazn" (R8): the growth loop drawn as a share. The player sees
their own name and season line one tap from the player page. The organiser
does nothing to earn it: every fact on this page is already in the database,
and the page is a SLICE of two documents W2 already builds. That is the whole
argument for the wave — high customer value, one new server reader.

## Scope

1. **Route** `/shared/[org]/[comp]/[div]/teams/[entrantId]` (Q2). ISR
   `revalidate = 30` + empty `generateStaticParams`; no `searchParams` /
   `cookies()` / `headers()` in the server component — `?tab=` is read on the
   client. A rename redirects to the same entrant under the new slugs; an
   unknown, malformed, withdrawn, wrong-division or private-competition
   entrant 404s.
2. **Header** — crest (`badge_url` → team/club `logo_path` → monogram in the
   team colour, never an empty tile), kind eyebrow (Team / Pair / Player)
   linking to the division, the 43-character name truncating with a `title`,
   seed chip, and **P W D L Pts + "Position n of m" read from the standings
   SNAPSHOT** — never recomputed from fixtures (R5). No standing → "No results
   yet".
3. **Fixtures tab** — live · upcoming · recent, sliced from W2's hub document
   and rendered with W2's `MatchCard` unchanged (no division chip); the first
   upcoming card is `tm-next`; the entrant's own `.ics` feed
   (`calendar.ics?entrant=<id>`, which already exists) is always offered.
4. **Squad tab** — consent-resolved through the ONE resolver
   (`resolvePersonDisplayName`), **masked never blank**, youth rule applied;
   shirt number (en dash when none), captain "C" chip (Q6), localised position
   noun via `positionLabel`, and a season line of the engine's declared COUNT
   metrics only (Q5). A player link needs BOTH gates `public_entrants_v`
   already encodes: consent AND `dashboard.player_profiles`.
5. **Table tab** — W2's `StandingsTableView` with two ADDITIVE props
   (`highlightEntrantId`, `rowHref`), this entrant's row highlighted, every row
   linking to its own team page.
6. **Live (R10)** — one `useLiveCompetition` subscription per page; the
   fixture cards, the header's record and the table all derive from the live
   document, so a push or a poll that moves the hub moves this page on the same
   tick, in place, with no navigation.
7. **Three ways in** — W2's Teams-tab `TeamCard.href` repointed (it points at
   `?tab=entrants` today only because the spec said no team page existed), the
   division page's Entrants names, and every standings row.
8. **Testids `tm-*`** (Q4 — `mt-*` collides with Tailwind's `mt-` utilities;
   `tm-` has zero matches in `apps/web/src` and `apps/web/e2e` today);
   **walkthrough v5**; four locales.

## Do NOT touch

The organiser console (`app/o/**`, `components/v2/**`); the engine; the
scorepad; registration pages; the `present` slides; entitlement matrix or copy
(R6 — nothing new is gated); `e2e.yml`; W1's match centre components (the
court card gains NO links — Q7); W2's public API routes — this wave adds **no
endpoint and no OpenAPI change**, so `npm run openapi:gen && /usr/bin/git
status --porcelain openapi` must print nothing at the end of every task. No
organiser-set team content (bios, photos, team news), no per-team poster, no
per-team gallery, no cross-competition team profile, no ratio season lines
(the engine declares no floor), no team OG card, no sitemap entry.

## Acceptance — all four test types

- **Unit**: fixture buckets and standing-by-column-KEY with the EMPTY case
  first and an order-differential case each; `deriveTeamTabs` presence ladder;
  the squad builder — masked/unmasked positive pair, youth axis, both link
  gates, captain/number/position, season line with zeros dropped and the metric
  keys DERIVED from `specsFor` (never typed into the test); DB-backed
  `readPublicSquad` order and `loadTeamPage` composition + the four 404 rules;
  dictionary coverage in four locales with a `{param}` parity check.
- **E2E**: walkthrough v5 in `--project=walkthrough` — the anonymous 320
  context opens the page, reads the record against the standings API (one
  authority, two readers), then **with the page still open an over is TAPPED
  through the real pad / posted through the API and the live card's text
  changes within one poll interval with `page.url()` unchanged** (R10); the
  squad's link count is asserted against `members[].person_id` from the public
  view; the control-set diff at 320 vs 1280 on all three tabs; the seven-width
  no-horizontal-scroll scan **per tab**; axe at 320; tap targets hit-tested
  with `elementFromPoint`. Full `mobile.spec.ts` (never a `-g` slice; a serial
  file's red count is a floor).
- **Smoke**: the team page GET carries `tm-root` and `tm-header`; an unknown
  entrant id 404s.
- **Regression**: the ISR contract test gains the new page (a mutant removing
  `generateStaticParams` must red it); zero hardcoded English at es/fr/nl; W2's
  own `StandingsTableView` tests stay green UNCHANGED (the two props are
  additive); W2 walkthrough step 7's Teams-tab assertion is amended, not
  deleted.
- **Screens**: Fixtures (live), Fixtures (after the over), Squad, Table, the
  EMPTY page and a non-team entrant — each at 320/768/1280, read by a person
  for the R11 verdict table.

## Gates

As W1: orchestrator-run gates judged on JSON-reporter counts
(`numTotalTests`/`numFailedTests`/`numFailedTestSuites`, `.testResults[].name`
under the worktree), never exit codes; `npm run i18n:check` clean; OpenAPI
drift clean; e2e via `workflow_dispatch` with the PR number (e2e does not run
on PRs; smoke is PR-only); the final whole-branch review runs even when every
task review was clean; **R11 per-screen verdicts** appended to the spec before
the PR; `_INDEX.md` updated in the same PR, with the owner's rulings recorded
as RULINGS and never as recommendations.

## Plan (CANDIDATE DRAFT, 2026-09-05)

- **Plan:** `../../plans/2026-09-05-spectator-w5-public-team-page.md` — **9
  tasks** (1 pure hub slices `lib/team-page.ts` · 2 squad builder · 3
  `readPublicSquad` + `loadTeamPage` + caches + Teams-tab href · 4
  dictionaries ×4 + `i18n:gen-keys` · 5 header / fixtures / squad / table
  components + two additive `StandingsTableView` props · 6 `TeamPage` client
  root · 7 the route, metadata, ISR contract and the three ways in · 8
  walkthrough v5 + mobile route + smoke · 9 gates / review / R11 / index).
  Part 1 of that file is the DESIGN: the page's job, three phone compositions,
  the data table, out-of-scope and these questions.
- **Owner questions, with the product-owner recommendation:**
  1. **Is the page in scope at all?** **Recommend yes, as W5 after W4** — the
     captain's one link for zero organiser work; the only new server code is
     one squad reader.
  2. **Route.** **Recommend `…/[div]/teams/[entrantId]`** — an entrant belongs
     to exactly one division; the breadcrumb, the `calendar.ics?entrant=`
     sibling and the division ISR tag all live there.
  3. **Which entrant kinds?** **Recommend every kind** (team, pair,
     individual) — identical value for a singles player; only the copy differs
     (Squad vs Players). A withdrawn entrant 404s, as its division card
     already vanishes.
  4. **Testid prefix.** The dispatch suggested `mt-*`. **Recommend `tm-*`** —
     `mt-` is Tailwind's margin-top utility, so every `grep mt-` over markup or
     e2e returns hundreds of class hits; `tm-` is free today.
  5. **Season lines.** **Recommend the engine's declared COUNT metrics only**
     (max two, zeros dropped), never a ratio — `PlayerStatsModel` declares no
     minimum floor, so a strike rate over three balls would be a wrong number
     with the authority of a stat.
  6. **Captain marker.** `entrant_members.is_captain` is not public today.
     **Recommend showing it** as a "C" chip on the already-masked name — a fact
     visible to anyone at the ground; no new consent axis.
  7. **Links from the match centre's court-card sides.** **Recommend not in
     W5** — W1's control set is signed off; recorded as a W1 amendment
     candidate.
  8. **Composition A or B.** **Recommend A** (court header + tab rail, shell
     parity with the match centre and the landing), with B (one scrolling page,
     no rail) kept as the named alternate. C (squad first) is rejected: it
     would put a live score below the fold on the one public page that must not.
  9. **Share image.** The page inherits the division's `opengraph-image.tsx`
     (the standings card). **Recommend accepting for W5**; a team OG card is a
     W3-family follow-up.
  10. **Roster edits reach the page in 30 s, not instantly** — `entrants.ts`
      fires no `fireDivisionRevalidate`. **Recommend accepting** (R10 is about
      matches in play; a roster is not live) and recording it.
- **False premises found and positive findings while drafting:**
  `entrants.badge_url` IS written by an organiser flow (`setEntrantBadge` + the
  badge route), so the spec's "read everywhere, written nowhere" doubt does not
  apply here; `public_entrants_v.members[].person_id` is gated by the
  `dashboard.player_profiles` ENTITLEMENT as well as consent, so
  "consent-resolved" alone does not decide whether a name links; `is_captain`
  and `roles` never reach the public view (the reader goes to the base table,
  the `maskPublicEntrantNames` precedent, rather than widening a view many
  correct consumers read); `PlayerStatsModel` declares no leaderboard floor
  (W2 P9 — respected by shipping count metrics only); `sortHubMatches` already
  orders completed newest-first, so a second sort here would be a second
  authority; roster edits fire no public revalidation; the division-create API
  response carries `slug`, so the e2e seed builds the team route without a
  second lookup; **W2's Teams tab links to `?tab=entrants` only because the
  spec said no team page existed** — W5 repoints it and amends W2's walkthrough
  assertion rather than deleting it.
- **Status: not yet ruled in scope; re-pin after W1–W4 merge.** Premises
  P1–P17 in the plan are DRAFT until each is re-opened on the merged tree — P1
  (every W2 symbol), P2 (W1's `PersonT`, `useNow`, `matchCentre.info.*`), P3
  (the walkthrough file and its seed helpers) and P14 (how W2 reads `?tab=` on
  the client) will all move. A false premise found then is a finding for
  `_INDEX.md`, not a blocker.

---

## Design theme (from _DESIGN.md, 2026-09-05)

Build to `_DESIGN.md` §5 W5 — **the whole section is PROPOSED (P12)**, because W5 itself is
not ruled in scope. It recomposes W2's rows under a W3-style tile and introduces no new
colour, family, radius or shadow. Theme sheet:
<https://claude.ai/code/artifact/45c81708-095d-458c-b49f-b471e2901415> — the "W5 — public
team page" board at 320 px draws the header slab, record tiles, form strip and the rows
below. No W0 canvas board exists for W5.

**The memorable thing:** the **form strip** under the crest — five coloured squares that
tell the season's story before a word is read.

**Rules:**

1. **Header on the slab.** A 64 px crest tile (team colour, P1) beside the team name in
   Barlow `text-3xl` uppercase `truncate`, division chip and competition link beneath. The
   record sits INSIDE the slab as small tiles — Played, Won, Lost, Pts — each a
   `tabular-nums` Barlow figure over an 11 px label. Accent keel closes the slab. This is
   the page's only `bg-court` and only `shadow-lg` object.
2. **Form strip**: the last five results as 24 px squares in a row — W `emerald-500`
   filled, L `bg-white/12` outlined, D/T `bg-court-muted` — inside a `role="list"` with an
   accessible name, so a screen reader gets the sequence and not five loose letters. Same
   tile grammar as the poster; no gradients, no icons.
3. **Fixtures** reuse W2's `MatchCard` unchanged (no division chip), in a `rounded-xl` row
   group with `divide-y` and **no shadow** (P7); this entrant's side always bold. Grouped
   Upcoming then Completed, empty case stated first.
4. **Table tab** = W2's `StandingsTableView` with the two additive props, this row
   highlighted, every row linking to its own team page. Numeric widths and `px-0.5` per W1
   rule 5; podium colours stay fixed and are not org-themeable.
5. **Squad** is a row group of person chips. **A chip whose label is a person's name gets
   its own row on phones** (`max-md:col-span-2` in a two-column grid) — a name in a
   one-column cell inflates into a circular blob, which is the exact defect the owner
   rejected a build for on the pad. Masked names render the masked label, never blank;
   shirt number en dash when none.
6. **`truncate` needs `min-w-0` on the whole ancestor chain** — the 43-character entrant
   name appears in the header, in every match card and in the highlighted table row on this
   page; it is the truncation test at 320.
7. **One DOM, one control set.** At ≥768 the header tiles move inline right of the name and
   fixtures/squad go two-up — a fold and a grid change, never a control the phone lacks.
   Verify with a control-set diff from the live DOM at 320 vs 1280, per tab.
8. **Live in place (R10)** from the one `useLiveCompetition` document: the fixture cards,
   the header record and the table move on the same tick with one highlight (P6), no
   navigation, no scroll jump. `prefers-reduced-motion` disables the highlight.
9. **Copy and controls.** Sentence case, plain verbs; "No results yet" as the empty
   standing; the `.ics` control says what it does; no "→"; every control ≥ 44 px by
   `elementFromPoint`; scrolling regions carry `tabindex="0"`, a role and a name.

**Proposed items this wave depends on:** **P12** the W5 theme as a whole (and the wave's own
scope ruling Q1) · **P1** the team colour ladder — rule 1's crest tile and scope §2's
"monogram in the team colour" both resolve to it · **P7** row groups with no shadow ·
**P6** the live-change highlight · **P10** 13 px table cells · **P2** the tab rail's 44 px
hit area · **P3** section titles · **P5** the focus ring on the header slab · **P11**
`min-h-11` on controls.

### Conflicts for the owner

1. **The team-colour KEY.** The plan pins it as `primary` — premise P6
   (`…-w5-public-team-page.md:195`) and the data table at `:33,89`, sourcing it from
   `usecases/exports.ts:261-262` and reusing W2's `primaryColour`. That plan line is
   candid that `exports.ts` is "the only reader of the key"; it is also the only *wrong*
   reader. The writer is the club hub, which writes `home_primary` /`home_secondary` /
   `away_primary` / `away_secondary` (`components/v2/club-hub/overview-tab.tsx:38-52`);
   `_DESIGN.md` §2.2 has the chain. Same root as W2 conflict 1 and W3 conflict 1 — **one
   ruling settles all three**, and it should be made before W2 builds `primaryColour`,
   because W3 and W5 both consume it.
2. **The fallback when contrast fails.** The plan falls back to `var(--ps-accent)`
   (`…-w5-public-team-page.md:1715`); `_DESIGN.md` P1's ladder falls back to the entrant
   hue and then to neutral initials, reserving the accent for the organiser's brand. On
   this page the tile sits on `bg-court`, where the accent violet is also the weakest ring
   colour (P5) — two reasons the ladder differs. Owner picks one.
3. **The section heading.** The plan uses
   `font-display text-sm font-semibold uppercase tracking-[0.18em] text-ink-muted`
   (`…-w5-public-team-page.md:1244`); P3 specifies `font-display text-base font-semibold
   uppercase tracking-wide text-ink` — 16 px, normal tracking, full ink. Both are Barlow,
   so neither breaks the uppercase rule; they are simply two different section titles, and
   W5 would ship the only page that does not match its siblings.

**Correction (product-owner ruling, 2026-09-06 — apply at re-pin):** the team colour is
NOT `colors.primary`. The only writer (`club-hub/overview-tab.tsx:38-52`) stores
`home_primary` / `home_secondary` / `away_primary` / `away_secondary` on
`clubs.colors` / `teams.colors`, resolved by `team_display_v.colors` and already present in
the public entrant payload (`public-site/data.ts:316-323`). `exports.ts:261-262` reads
`colors->>'primary'` and is the broken reader this plan copied. Ruling: public tiles use
`colors.home_primary` through `public-theme.ts`'s 3:1 `contrast()` guard, else the
`division-hue.ts` wheel keyed on the entrant, else neutral initials (`_DESIGN.md` P1);
one shared resolver in W2 (`primaryColour`) consumed by W3 and W5 — no second palette.
