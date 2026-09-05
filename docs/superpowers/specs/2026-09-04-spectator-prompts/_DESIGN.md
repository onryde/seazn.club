# Spectator surface — design system (`/shared`, W1–W5)

Status: **DRAFT for owner review, 2026-09-05.** Docs only; no code, prompt or plan file was
touched. Companion theme sheet (static HTML, open in a browser):
`/private/tmp/claude-501/-Users-ashokhein-github-seazn-club/6262000e-0d12-4731-97e2-7a60369846eb/scratchpad/design/spectator-theme-sheet.html`.

This is an **extension of the shipped "courtside" system, not a rebrand.** Every value below
is either CITED from the tree (`file:line`, read — not grepped) or marked **PROPOSED**; a
proposed item is a recommendation for the owner to rule on, and nothing in a wave prompt
may treat it as ruled until `_INDEX.md` records the ruling. Paths are relative to
`apps/web/src/` unless they start with `docs/`, `packages/` or `db/`.

Written with the `frontend-design` skill's two-pass process. Pass 1 produced a token plan
from the tree; pass 2 reviewed it against the skill's list of generated-design defaults and
changed seven things — recorded in §9 so the reasoning survives the session.

---

## 1. Identity in one paragraph

A spectator page is read on a phone, at a ground, in daylight, five seconds at a time. It
must answer *what's the score, who's winning, when do we play* before the thumb moves, and
be worth forwarding to a WhatsApp group afterwards. The page belongs to the **competition
and its organiser** — their brand colour drives the accent and the court slab
(`lib/public-theme.ts:73-89`), the team's crest sits beside its name, the platform is one
footer line. Its vernacular is the **matchday programme and the ground scoreboard**:
condensed uppercase display type for names and headings, big tabular digits for scores, a
dark court slab as the one lifted object on a light page, everything else quiet — white
cards, hairlines, 13–14 px text. It must never feel like a shrunk admin table (the W0
finding: 13 pages with an identical control set at 320 and 1280, design doc
`docs/superpowers/specs/2026-09-04-spectator-surface-design.md:106-113`) or a generic SaaS
card kit (one radius everywhere, a grey shadow under every block, tracked ALL-CAPS labels
above every heading, meta strings glued with middle dots).

---

## 2. Tokens (existing, cited)

### 2.1 Palette

The public tree is themed by `--ps-*` custom properties declared in `app/globals.css:15-26`
and exposed as Tailwind v4 colour utilities via `@theme inline` (`globals.css:29-47`;
Tailwind `^4`, `apps/web/package.json:76`). **There is no `--color-line` token** — earlier
work cited a phantom one; the real hairline is the utility `border-zinc-200/80`, and the
only tinted rule is `border-accent-line` (`globals.css:19,40`).

| Role | Utility | Value | Source |
|---|---|---|---|
| Court slab (the dark header bar and every court card) | `bg-court` | `#231738` | `globals.css:20,41` |
| Ink on the slab | `text-court-ink` | `#f7f5fb` | `globals.css:21,42` |
| Muted ink on the slab | `text-court-muted` | `rgba(247,245,251,0.64)` | `globals.css:22,43` |
| Accent (org brand or platform violet) | `bg-accent` / `text-accent` | `#7c3aed` | `globals.css:15,36` |
| Ink on the accent | `text-accent-ink` | `#ffffff` | `globals.css:16,37` |
| Accent as text on white (link colour) | `text-accent-strong` | `#6931c9` | `globals.css:17,38` |
| Accent wash | `bg-accent-soft` | `#f5effe` | `globals.css:18,39` |
| Accent hairline | `border-accent-line` | `#decefb` | `globals.css:19,40` |
| Page canvas (public tree) | `bg-canvas` | `#f6f5f8` | `globals.css:23,44`; applied by `app/(public)/shared/[orgSlug]/layout.tsx:60` |
| Card surface | `bg-surface` | `#ffffff` | `globals.css:24,45` |
| Ink | `text-ink` | `#1d1928` | `globals.css:25,46` |
| Muted ink (≈4.6:1 on white, `components/public-site/match-centre/glyphs.tsx:12`) | `text-ink-muted` | `#6f6a7c` | `globals.css:26,47` |
| Hairline | `border-zinc-200/80` | Tailwind zinc-200 at 80 % (≈ `#e4e4e7`) | e.g. `components/public-site/tabs.tsx:21`, `match-centre/summary-tab.tsx:97` |
| Faint hairline (table rows) | `border-zinc-200/60`, `divide-zinc-200/60` | | `match-centre/scorecard-tab.tsx:259`, `commentary-tab.tsx:136` |
| Row wash / bar track | `bg-zinc-100` | ≈ `#f4f4f5` | `glyphs.tsx:15`, `summary-tab.tsx:236` |

Facts about the ground: `html, body` paints `--background: #fdfcf8` with two faint violet
beams (`globals.css:6,74-77`), but the public layout wraps everything in `bg-canvas`
(`layout.tsx:60`), so **the page a spectator sees is `#f6f5f8`**, not the `#fdfcf8` the W0
boards drew (`scratchpad/canvas/Main.dc.html` body). Tailwind v4's own palette is oklch;
every zinc/emerald/amber hex in this document is the sRGB approximation — never hardcode
one, use the utility (`globals.css:54-60` records the `lime-400` drift this caused once).

**Signal colours (fixed, not org-themeable):**

| Signal | Utilities | Source |
|---|---|---|
| Live | `text-emerald-300` text, `bg-emerald-400` dot and keel; `text-emerald-600`/`bg-emerald-400` on light rows | `match-centre/court-card.tsx:102,107,159`; `public-site/schedule.tsx:107,116,120-121`; `[competitionSlug]/page.tsx:171-174,183-184` |
| Podium (standings 1/2/3) | `bg-amber-300 text-amber-950`, `bg-slate-300 text-slate-900`, `bg-orange-300 text-orange-950`; leader row `bg-amber-50/60` | `public-site/standings-table.tsx:39-45,81` — "deliberately NOT org-themeable" |
| Champion | `bg-amber-400` edge, `text-amber-300` eyebrow | `[divisionSlug]/page.tsx:155-161` |
| Card grades (daylight set) | `--sport-advisory #16a34a`, `--sport-caution #d97706`, `--sport-dismissal #dc2626` | `globals.css:1019-1021` |

The pad's marketing/console night set (`--mk-night #150b36`, `--mk-lime #a3e635`,
`--mk-live #ef4444`, `globals.css:494-503`) is **not** part of the spectator surface; the
public site's live colour is emerald in five files (table above), and that stays.

### 2.2 Brand resolution — whose colour is where

- **Organiser/competition brand** → the whole `--ps-*` set. `resolvePublicTheme(brand)`
  (`lib/public-theme.ts:73-89`) derives accent-strong (85 % towards black, `:82`), soft
  (8 % over white, `:83`), line (25 %, `:84`) and **the court itself** — 15 % of the accent
  mixed into `#131118` (`:21,85`) — behind a WCAG guard (accent must reach 3:1 on white,
  `:77`; otherwise the platform violet). Competition branding overrides org branding
  (`:117-122`; `[competitionSlug]/page.tsx:87`). So "the competition's colours" on a
  spectator page IS the theme — no component picks a brand colour itself.
- **Team colour** → **it EXISTS; only the LADDER needs a ruling (P1).**

  > **Correction, 2026-09-05.** The first draft of this bullet read "No team or entrant
  > colour exists in the tree" and proposed a synthetic hue to stand in for one. That was
  > **false** — a grep for `colors` over `apps/web/src/server` finds org branding and stops,
  > because the team colour is stored one level up (on the *club*) and reaches the app
  > through a view. Re-checked against the migrations and the writer was found. The rule
  > this cost: an absence claim about DATA is settled in `db/migration/**`, not in the
  > server's TypeScript.

  **Storage and resolution.** `teams.colors jsonb`
  (`db/migration/v2-engine/tables/V206__teams.sql:5`) and `clubs.colors jsonb` — "default kit
  colours; teams inherit unless overridden" (`db/migration/jul3/V242__clubs_and_imports.sql:13`)
  — resolve in ONE place, exactly as the badge does:
  `team_display_v.colors = coalesce(t.colors, c.colors)`, team override wins, else the club
  (`V242:62-67,76`).

  **Shape and writer.** Four keys — `home_primary`, `home_secondary`, `away_primary`,
  `away_secondary` (`components/v2/club-hub/overview-tab.tsx:38-52`) — written by the club
  hub's four `<input type="color">` pickers (`:192-217`; saved as `null` when untouched,
  `:116`; → `server/usecases/clubs.ts:91-94`), localised in all four dictionaries
  (`dictionaries/*/ui.json:1561`), and validated as `#rrggbb` only at render time
  (`club-hub/kit-style.ts:7,15-17`).

  **It already reaches the spectator payload.** `public_entrants_v` emits a `team_display`
  block carrying `colors` (`db/migration/deltas/V289__entrant_badge_public_view.sql:26-32`;
  re-emitted by `V306:136` and `V350:44`), typed through as
  `PublicEntrant.team_display.colors` (`server/public-site/data.ts:316-323`) — and with **no
  entitlement gate**, unlike the member photo/person_id fields in the same view (`V289:12-18`).
  What is missing is a *reader*: nothing under `components/public-site` or `app/(public)`
  reads it (grep `-a`, 2026-09-05). The only renderer anywhere is the staff club page's 3 px
  kit stripe (`app/clubs/[id]/page.tsx:67` → `kit-style.ts:21-28`). So the W2/W3 prompts'
  "monogram in team colour" is **not** a false premise — the source exists and is
  organiser-owned. It is a *partial* one, because three cases resolve to nothing:

  1. **Unset** — an untouched club stores `null` (`overview-tab.tsx:116`), so most
     competitions will have no colour on day one.
  2. **Not a team** — `team_display` is null for individual and pair entrants
     (`server/public-site/data.ts:316-317`), i.e. every singles and doubles draw.
  3. **Unreadable** — the picker accepts any hex (`overview-tab.tsx:202-206`) with none of
     `resolvePublicTheme`'s 3:1 guard (`lib/public-theme.ts:77`). A club's real navy is
     invisible on `#231738`; its real yellow is invisible on white.

  **Recommendation (P1) — a three-rung ladder, top rung first:**
  1. `team_display.colors.home_primary` when it parses as `#rrggbb` **and** clears 3:1
     against the surface it lands on — reuse `public-theme.ts`'s own `contrast()`
     (`:60-63`), never a second implementation. Ink is white or `--ps-court-ink` by the
     same test. When both sides resolve to the same hue, the away side takes
     `away_primary` — the matchday rule for a kit clash, and it is already stored.
  2. else a deterministic hue from the **entrant id** through the wheel `lib/division-hue.ts:7`
     already uses (twelve stops that skip the brand violet's 260–290° band), tile
     `hsl(h 62% 48%)` (`:25-27`) with white ink — the same function family, keyed on the
     entrant, so a singles player gets a stable tile too.
  3. else neutral — `bg-zinc-100` with `text-ink-muted` initials, the `entity-logo.tsx:51`
     form. **Never** the purple→fuchsia gradient at `entity-logo.tsx:44` (§7).

  Customer value: a club that has set its kit sees its own colours on every card, poster and
  team page — the first time that data has been worth entering — and every other entrant
  still gets two distinguishable tiles with zero organiser work. Cost: one helper and the
  contrast test; **no schema change and no new organiser field**. Every shipped monogram
  today is accent violet (`layout.tsx:74-79`; `components/news/post-scorebug.tsx:43-49`) or
  grey/gradient (`components/ui/entity-logo.tsx:40-54`), so rung 2 and rung 3 are the only
  changes to what is on screen now.

  **Separate defect found on the way (not this programme's to fix):**
  `server/usecases/exports.ts:261-262` reads `htd.colors->>'primary'` for the fixtures CSV's
  `home_color`/`away_color`, but `primary` is a key **no writer in `apps/web/src` writes** —
  the club hub writes `home_primary`. Those two export columns are therefore null for every
  colour set through the product. Worth an owner decision on its own; it is a console/export
  bug, not a `/shared` one.

  **Against ruling 4** ("no organiser-set fields", `_INDEX.md:37-38`): the ladder adds none.
  Rung 1 *reads* a field the console has shipped for months and the public view already
  emits; rungs 2 and 3 need no data at all. This is the ruling being honoured, not bent —
  and it is why the ladder beats the synthetic-hue-only proposal it replaces: the organiser
  work is already done, and nothing on the spectator surface has ever shown it.
- **Sport colour** → **PROPOSED (P8):** the scorepad's `SPORT_PALETTES`
  (`components/v2/scorepad/v3/sport-theme.ts:165-503`; overrides only, defaults `:109-123`;
  table order is **wave order** — football, hockey, ice hockey, tennis, badminton, table
  tennis, volleyball, boardgame, carrom — not alphabetical, `:185-189`) are the scorer's
  night-board identity and **never leave the pad**. The court card stays `bg-court` for
  every sport, as the owner-picked W0 boards draw it for cricket, football and tennis
  (`FootballPhone.dc.html`, `TennisPhone.dc.html`: same `#231738` card). The one place sport
  colour reaches a spectator is a **card swatch on the Timeline** (a yellow/red/green card
  is information), drawn from the daylight set `globals.css:1019-1021` — not from the pad's
  per-sport overrides. Neutral everywhere else; the sport is named by a chip, not a colour.

### 2.3 Type

Two families, both already loaded; nothing new to mount.

| Family | Weights | Variable | Mounted at | Utility |
|---|---|---|---|---|
| **Barlow Condensed** — display: scores, names, headings | 500/600/700 | `--ps-font-display` | `app/(public)/shared/[orgSlug]/layout.tsx:19-23` (also 600/700 as `--font-barlow` at the root, `lib/fonts.ts:7-11`) | `font-display` (`globals.css:50`) |
| **Geist** — everything else | variable | `--font-geist-sans` | `app/layout.tsx:2,10,56` | `font-sans` (body, `app/layout.tsx:58`) |
| Geist Mono | | `--font-geist-mono` | `app/layout.tsx:11-14` | `font-mono` — **not used on this surface** (the one inherited use, the power-play chip `public-site/live-score.tsx:172`, is a tell — see §7) |

**Every score column is `tabular-nums`.** Shipped on the court card row (`court-card.tsx:119,127`),
both stat tables (`stat-table.tsx:86,116`; `scorecard-tab.tsx:102`), sets (`sets-tab.tsx:156`),
timeline markers (`timeline-tab.tsx:118`), glyphs (`glyphs.tsx:7`), standings (`standings-table.tsx:87,126`).

**Type scale — as shipped by W1, with the ≥768 step** (Tailwind v4 sizes: `text-xs` 12/16,
`text-sm` 14/20, `text-base` 16/24, `text-lg` 18/28, `text-xl` 20/28, `text-2xl` 24/32,
`text-4xl` 36/40, `text-5xl` 48/1, `text-6xl` 60/1; `text-[Npx]` arbitrary sizes inherit
the body line-height):

| Role | Phone (320–767) | ≥768 | Family / weight / case | Source |
|---|---|---|---|---|
| Score digits, court card | `text-2xl` 24 px | `md:text-4xl` 36 px | Barlow 700, tabular | `court-card.tsx:127` |
| Score headline, legacy scorebug (non-cricket Summary) | `text-5xl` 48 px | `sm:text-6xl` 60 px | Barlow 700, tabular, `leading-none tracking-tight` | `live-score.tsx:193` |
| Team name, court card | `text-xl` 20 px | `sm:text-2xl` 24 px | Barlow 600, **uppercase `tracking-wide`**, `truncate` | `court-card.tsx:121` |
| Page title (competition / org / news) | `text-4xl` 36 px | `sm:text-5xl` 48 px | Barlow 700, uppercase, `leading-none tracking-tight` | `[competitionSlug]/page.tsx:136`; `news/page.tsx:86` |
| Fixture page h1 | `text-2xl` 24 px | same | Barlow 600, sentence case | `fixtures/[fixtureId]/page.tsx:145` |
| Section h2 (light page) | `text-2xl` 24 px | same | Barlow 600, uppercase `tracking-wide` | `[competitionSlug]/page.tsx:219`; `globals.css:246` |
| Section title inside a card / tab | **PROPOSED (P3)** `font-display text-base font-semibold uppercase tracking-wide text-ink` 16 px | same | Barlow 600 — the owner-picked W0 board's `.display 16px 600 uppercase 0.04em` (`Main.dc.html`, "At the crease", "Fall of wickets") | shipped W1 uses Geist `text-xs font-semibold uppercase tracking-[0.18em] text-ink-muted` instead (`summary-tab.tsx:99,129,192,220`) — see §7 |
| Status chip (LIVE / RESULT / SCHEDULED) | `text-[11px]` | same | Geist 700 (live) / 600, uppercase `tracking-[0.22em]` | `court-card.tsx:102-103` |
| Chase / result / status line on the slab | shipped `text-sm text-court-muted` | same | Geist 400 | `court-card.tsx:140`; **PROPOSED (P4)** `font-display text-lg font-semibold text-court-ink` per the Main board's 18 px display line "Queens need 34 from 21" |
| Rate line (CRR · RRR), freshness | `text-xs`; `text-[11px] text-court-muted/70` | same | Geist | `court-card.tsx:145,152` |
| Tab label | `text-sm` 14 px | same | Geist 600 active / 500 inactive | `tab-rail.tsx:35-37` |
| Table cell (scorecard, sets, timeline, commentary, info) | `text-[13px]` (`leading-tight` on tables) | same | Geist 400; totals 600 | `scorecard-tab.tsx:233`; `sets-tab.tsx:100`; `timeline-tab.tsx:113`; `commentary-tab.tsx:144`; `info-tab.tsx:59` |
| Table cell (summary live block) | `text-sm` 14 px | same | | `stat-table.tsx:112,116` — **PROPOSED (P10):** converge on 13 px; two sizes for the same table kind is drift |
| Table header notation (R B 4s 6s SR / O M R W Econ) | `text-[13px]`-inherited, `font-medium text-ink-muted` | | notation stays notation, localised `title` + `sr-only` (`scorecard-tab.tsx:158-168`) | `scorecard-tab.tsx:103`; `stat-table.tsx:102` adds `text-xs uppercase tracking-wide` — converge on the scorecard form (P10) |
| Sub-line under a name (dismissal, "wd 2 · nb 1") | `text-[11px] text-ink-muted` | | Geist | `scorecard-tab.tsx:265,334` |
| Body / meta | `text-sm` 14 px; `text-xs` 12 px | | Geist | `court-card.tsx:140`; `summary-tab.tsx:180-181` |
| Schedule row name / score | `text-[15px] leading-6`; Barlow `text-lg` tabular | | | `schedule.tsx:101-108` |
| Standings points | `font-display text-base font-bold text-accent-strong` | | | `standings-table.tsx:128` |
| Footer | `text-xs text-ink-muted` | | | `layout.tsx:107` |

Line length: body copy under 80 characters — the reading column is `max-w-5xl` (`layout.tsx:106`)
but prose lives inside cards; the info `<dl>` is two columns even at 320 (`info-tab.tsx:52`).

### 2.4 Spacing, radii, borders, shadows — by ROLE

Radii are not one value. The shipped tree already spends them by role; the rule makes it
explicit (Tailwind v4: `rounded-md` 6, `-lg` 8, `-xl` 12, `-2xl` 16, `-3xl` 24, `-full`).

| Role | Radius | Border | Shadow | Padding | Source |
|---|---|---|---|---|---|
| Court card / hero slab | `rounded-2xl` | none | `shadow-lg` — **the only lifted object on the page** | `p-5 sm:p-6` | `court-card.tsx:94,96`; `live-score.tsx:165`; `[competitionSlug]/page.tsx:95` |
| Sticky header bar | none (full-bleed) | `border-t border-white/10` strip | `shadow-md` | `h-[52px] px-4` | `layout.tsx:62-63,100` |
| Content card (live block, performer tile) | `rounded-2xl` | `border border-zinc-200/80` | `shadow-sm` | `p-4` | `summary-tab.tsx:97,160` |
| Row group (schedule list, match list, standings box, squad) | `rounded-xl` | `border border-zinc-200/80`, rows `divide-y divide-zinc-100` | shipped `shadow-sm` (`schedule.tsx:263`, `standings-table.tsx:58`); **PROPOSED (P7): none** — hierarchy is carried by the shadow ladder (slab lg › card sm › rows none) | rows `px-3.5 py-2.5` | `schedule.tsx:114,263` |
| Disclosure (`<details>` innings) / over group | `rounded-xl` | `border border-zinc-200/80` | none | summary `px-3 py-2.5`; body `px-3 pb-3` | `scorecard-tab.tsx:374-378,385,414`; `commentary-tab.tsx:132` |
| Control (link-button, "Load earlier overs", select) | `rounded-lg` | `border border-zinc-200/80` | none | `px-3 py-2` | `info-tab.tsx:41-42`; `commentary-tab.tsx:219`; `.btn` `globals.css:226-228` |
| Glyph tile (sport letter, division glyph) | `rounded-lg` at 36 px | none | none | | `[competitionSlug]/page.tsx:237` |
| Crest / side badge | `rounded-md` ≤ 32 px; `rounded-lg`/`-xl` at 44–64 px; `rounded-[24px]`–`[40px]` at poster scale (96–400 px) | none | poster only: `0 30px 60px rgba(0,0,0,.4)` | | `layout.tsx:71,76`; `timeline-tab.tsx:93`; `entity-logo.tsx:32`; `PosterA.dc.html` |
| Chip / pill / tab / glyph / bar | `rounded-full` | chips `border border-zinc-200`; tabs none | active tab `shadow-sm` | tab `px-4 py-1.5`; chip `px-3 py-1`; glyph 26 × 26 | `tab-rail.tsx:35`; `summary-tab.tsx:206`; `glyphs.tsx:7` |
| Empty state | `rounded-xl` | `border border-dashed border-zinc-300` | none | `p-6` | `[competitionSlug]/page.tsx:223`; `schedule.tsx:287` |

Spacing rhythm: page gutter `px-4` (16), page top `py-6` (`layout.tsx:106`); the match-centre
stack is `space-y-4` (`match-centre.tsx:108`); inside cards `space-y-3` / `gap-3`; row padding
`py-2.5`; table cells `px-0.5` numeric, `px-1` name (`scorecard-tab.tsx:95-103`); grid gaps
`gap-2`/`gap-3`; a phone rail bleeds to the viewport edge with `max-md:-mx-4 max-md:px-4`
(`tab-rail.tsx:61`; `summary-tab.tsx:200`). Keel lines: `h-0.5 bg-accent` under the header
(`layout.tsx:104`), `h-1` under a court card — emerald while live, accent otherwise
(`court-card.tsx:159`; `live-score.tsx:236`).

### 2.5 Dark / light

**The public site is light-only.** Zero `dark:` utilities and no `prefers-color-scheme`
anywhere under `app/(public)` or `components/public-site` (grep `-a`, 2026-09-05), and none
in `globals.css`. The dark objects a spectator sees — the header bar, the court card, the
poster — are *designed* dark surfaces inside a light page, not a theme. R11's "both themes
where the page has them" therefore reads as one theme here; a future dark mode is a
separate programme, not something a wave adds by accident (no `dark:` in new markup).

---

## 3. Component vocabulary

These are the components W1 shipped or the older public pages already use. Later waves
compose from them; they do not invent parallels. Testids per R7 (`mc-`, `mh-`, `poster-`,
`gl-`; `_RULES.md:61-63`).

**Court card** (`match-centre/court-card.tsx`) — `overflow-hidden rounded-2xl bg-court
text-court-ink shadow-lg` › `p-5 sm:p-6` › optional status chip (`mc-live-pill` with the
`animate-live-pulse` dot only while `header.live`, `:106-108`; `mc-result-chip`; nothing for
postponed/abandoned, `:67-70`) › two side rows `flex items-baseline justify-between gap-3
tabular-nums`, batting side `font-bold` (`:113-137`) — name `truncate font-display text-xl
… uppercase`, score `font-display text-2xl font-bold tabular-nums md:text-4xl`, sub-line
`text-xs text-court-muted` › `mc-status-line` › `mc-rate-line` › `mc-updated-at` (live only)
› keel `h-1`. The W0 boards additionally give each side a 28 px crest tile
(`Main.dc.html`) — a W2/W3 addition once P1 is ruled, not a W1 change.

**Tab rail** (`match-centre/tab-rail.tsx`) — `role="tablist" tabIndex={0} aria-label`,
`flex gap-2 overflow-x-auto max-md:-mx-4 max-md:px-4` (`:57-63`); pills copied from the
division page's segmented bar (`tabs.tsx:30-32`): active `shrink-0 rounded-full bg-accent
px-4 py-1.5 text-sm font-semibold text-accent-ink shadow-sm`, inactive no resting fill,
`hover:bg-accent-soft hover:text-accent-strong` (`:35-37`). APG keyboard: Left/Right wrap,
Home/End (`:42-54`); `id="mc-tab-<id>"` / `aria-controls` (`:72-77`), the one `role="tabpanel"`
wrapper lives in `match-centre.tsx:111-116`. The division page wraps its rail in a sticky
segmented shell `top-[54px] … bg-canvas/90 backdrop-blur` (`tabs.tsx:18-21`); the match
centre does not. **Finding:** `text-sm` + `py-1.5` = 32 px tall — under the 44 px floor
(R11). **PROPOSED (P2):** keep the look, add the hit area: `relative min-h-11 before:absolute
before:inset-x-0 before:-inset-y-1.5 before:content-['']` on the button (a pseudo-element
hit-tests to its host, so `elementFromPoint` resolves to the tab).

**Score strip** — the compact two-row score used by the Live-now rail and the match card
(W2): the court card's side row at `text-[15px]` names and `text-lg`/`text-xl` digits, no
status chip, one line of meta. Today's rail card (`[competitionSlug]/page.tsx:191-202`)
shows a headline with **no team names** (W0 block II) and its `<ul>` scroll rail carries no
`tabindex`/role/name (`:187`) — W2 replaces it with this strip; see §5 W2.

**Stat table** (`match-centre/stat-table.tsx`; the scorecard's own tables follow the same
rules) — `w-full table-fixed border-separate border-spacing-0 tabular-nums` (`:86`); **every
numeric column carries an explicit width and `px-0.5`**, the name column carries none and
takes the remainder with `block truncate` on the inner span (`:112-116`; `scorecard-tab.tsx:187`
— never `max-w-0`, `:172-186`). Widths by content, border-box: `w-6` 24 px (M, W),
`w-7` 28 px (R, B, 4s, 6s, wd, nb — three digits), `w-8` 32 px (O — "19.4"), `w-10` 40 px
(set/period columns, `sets-tab.tsx:123`), `w-11` 44 px (SR, Econ — "142.9")
(`summary-tab.tsx:80-93`; `scorecard-tab.tsx:247-251,309-319`; ruling `_INDEX.md:164-165`).
Name remainder ≈ 106 px on the batting table at 320 (`scorecard-tab.tsx:40-45`). Header row
`border-b border-zinc-200/80`, body rows `border-b border-zinc-200/60`, totals `border-t`.
Columns appear only when the innings has the data (`scorecard-tab.tsx:25-31,90-93`); below
`md` the bowling `wd`/`nb` columns fold into a sub-line (`PHONE_FOLD`, `:117-143`). Wrapped in
a reachable `ScrollRegion` — `overflow-x-auto tabIndex={0} role="region" aria-label`
(`:211-217`) — as the last resort, never `overflow-hidden`.

**Chips** — status (court-card pill, above); **division** chip: `rounded-full bg-accent-soft
px-2 py-0.5 uppercase text-accent-strong` (`[competitionSlug]/page.tsx:251`; W2 may key its
wash on `divisionTint/divisionInk`, `lib/division-hue.ts:30-38`, which the console already
does); **sport** chip: the sport's first letter in a `rounded-lg bg-accent-soft font-display
text-accent-strong` tile (`:237`); **fall-of-wickets** chip `shrink-0 rounded-full border
border-zinc-200 px-3 py-1 text-xs tabular-nums` inside a `role="list"` rail (`summary-tab.tsx:195-210`);
**glyph** chips 26 × 26 `rounded-full text-[11px] font-bold tabular-nums` — 4/6 filled
accent, W `bg-ink text-canvas`, dot `bg-zinc-100 text-ink-muted`, extras outlined
`border-zinc-300`, runs `bg-zinc-100 text-zinc-700` (`glyphs.tsx:6-19`); **side badge**
`h-6 w-6 rounded-md bg-accent/15 text-[10px] font-bold uppercase` with `side.short`
(`timeline-tab.tsx:88-98`; `sets-tab.tsx:143`); **rank** chip `h-5 w-5 rounded-full
font-display text-[12px] font-bold` with the podium colours (`standings-table.tsx:47-55`).

**Person / entrant chips** — a chip whose label is a person's or team's name gets its own
row on phones (`max-md:col-span-2` in a two-column grid, or one per row): the scorepad
ruling (`docs/superpowers/specs/2026-09-02-scorepad-v3-phone-composition-design.md:73`,
`AGENTS.md` "Person/entrant chips get their own row"). Names `truncate` with `min-w-0` on
the whole ancestor chain (`_RULES.md:105-106`); the 43-character entrant name is the test.

**Disclosure / accordion** — native `<details>`, never a JS accordion (`scorecard-tab.tsx:12-16`):
`group rounded-xl border border-zinc-200/80 bg-surface`, `<summary>` `flex cursor-pointer
list-none items-center justify-between gap-2 px-3 py-2.5 [&::-webkit-details-marker]:hidden`
with an explicit `aria-hidden` chevron `h-3 w-3 group-open:rotate-90` (`:379-397`), name +
sub-line on the left, the total on the right; the LAST innings opens (`:18-23,484`). The
phone-only `PhoneDisclosure` pattern (toggle `md:hidden`, body `max-md:hidden`, `grid h-full`
on wrapper and body) is the house rule for folding a whole section
(`…phone-composition-design.md:89-90`).

**Empty and error states** — `rounded-xl border border-dashed border-zinc-300 bg-surface p-6
text-center text-sm text-ink-muted` (`[competitionSlug]/page.tsx:223`; `schedule.tsx:287`).
Copy: one sentence, what is missing and when it appears — "No fixtures yet — the schedule
appears once the draw is made." — never "coming soon" (R4), never an emoji, never an
apology. A tab that would be empty is not rendered at all (R4). Errors say what went wrong
and what to do next, in the interface's voice.

**Copy rules (every wave):** plain verbs and sentence case ("Load earlier overs", "Add to
calendar", "Download poster", "Request removal"); an action keeps its name through the flow;
no ALL-CAPS labels in the body face except the status chip and sport notation (§7); **no
middle-dot meta strings** — facts of different kinds are separate elements (a two-column
`<dl>`, a chip row, a flex row with `gap`); a middle dot may only separate repeated items
of the SAME kind inside one notation string (a fall-of-wickets sequence); **no "→" or "▸"
appended to link or button text** (inherited: "Present ▸", `[competitionSlug]/page.tsx:150`;
"← org", `:90`); breadcrumb separators are an icon element (`ChevronRight`, already imported
`:244`), not a glyph in the string. Notation (R B 4s SR; "wd 2"; "CRR 8.44") stays
notation and is not translated (R2).

**Live indicators and motion** — one orchestrated moment at most per surface (precedent:
the news post's digit settle, `globals.css:170-171` "the ONE motion moment … Nothing else
… animates"). On the spectator surface that moment is the LIVE dot's pulse
(`animate-live-pulse`, `globals.css:115-125,151-153`), gated on `header.live`; every
animation class is neutralised under `prefers-reduced-motion` (`globals.css:187-197`) and any
new one is added to that list. **Live updates change in place** (R10): a new document
re-renders the same keyed rows; a new over inserts at the top of Commentary; a finished
match swaps the chase line for the result line and the pill for the result chip
(design doc `:389-396`). **PROPOSED (P6):** the cell whose text changed gets one highlight —
a 600 ms `background-color` fade from `accent-soft` to transparent (`.mc-changed`, no
transform, none under reduced motion) — never a re-layout, never a toast. No hover lift on
cards (see §7). Transitions answer a person's action (open, expand) and nothing else.

**Focus** — `:where(a, button, summary, [role="tab"]):focus-visible { outline: 2px solid
var(--ps-accent); outline-offset: 2px }` (`globals.css:201-204`) — the ring follows the org
accent. **Finding:** the violet ring on the court slab measures ≈2.97:1 (WCAG 1.4.11 needs
3:1 for a UI boundary). **PROPOSED (P5):** inside `bg-court` containers the ring flips to
`var(--ps-court-ink)` — the same trick the console gantry uses with lime (`globals.css:816-819`).

**Touch targets ≥ 44 px, measured by hit-test** — a `boundingBox()` of 44 is not a tap
proven; `document.elementFromPoint(cx, cy)` must resolve to the control (`_RULES.md:88-89,120-121`).
Shipped heights to converge (**PROPOSED P2/P11**): tab pill 32 px; Info links and "Load
earlier overs" ≈36 px (`text-[13px]` + `py-2`, `info-tab.tsx:42`, `commentary-tab.tsx:219`);
`ShareBar` `.btn` ≈36 px (`components/share-bar.tsx:71-87`, `globals.css:227`). Fix is
`min-h-11` (or the pseudo hit-area for the pill) with the visual unchanged. `<summary>`
rows (`py-2.5` + two lines ≈ 57 px) and schedule rows already clear it.

---

## 4. Phone composition rules (R1, one DOM)

Binding, from `_RULES.md:20-27` and `…scorepad-v3-phone-composition-design.md:29-35`:

1. **What changes between 320 and 1280 is the control SET and its order — never a scale
   factor.** ≥768 may lay cards two-up (performers `md:grid-cols-2`, `summary-tab.tsx:158`;
   innings tables `md:grid-cols-2`, `scorecard-tab.tsx:414`) or add columns (`wd`/`nb`
   unfold, `PHONE_FOLD`), never a control the phone lacks. Prove it with a control-set diff
   from the live DOM (membership, order, repeats) at 320 vs 1280 — equal lists are a shrink.
2. **One DOM, branched at Tailwind `md` (768).** Phone-only behaviour is `max-md:*`;
   phone-only elements are `md:hidden`; desktop class strings are not edited. Never a second
   phone tree, never a JS media query. `/\bmd:hidden\b/` also matches inside `max-md:hidden`
   — anchor assertions on `\s...hidden"`.
3. **Order is explicit** — `flex flex-col` + `max-md:order-*` when a block must move (the
   pad puts *Take back* below the board this way); source order is not the phone order by
   default.
4. **Scrolling regions carry `tabindex="0"`, a role and an accessible name** (tab rail
   `tab-rail.tsx:57-60`; fall-of-wickets rail `summary-tab.tsx:195-199`; table regions
   `scorecard-tab.tsx:213`; sets `sets-tab.tsx:94`). An overflow whose extra content is
   reachable is a rail; one inside `overflow-hidden` is a defect. The competition page's
   Live-now `<ul>` (`[competitionSlug]/page.tsx:187`) is missing all three today — W2 fixes it.
5. **`truncate` needs `min-w-0` on the whole ancestor chain**; in a table use `table-fixed`
   plus `block truncate` on the inner span, because `min-w-0`/`max-width` on a `<td>` are
   inert (`stat-table.tsx:11-24`).
6. **No horizontal page scroll at 320/360/375/390/430/768/834** (`mobile.spec.ts` projects);
   `html, body { overflow-x: clip }` (`globals.css:71`) is a backstop, not a licence.
7. **Wide things scroll inside their own box** with a right-edge fade affordance where the
   cut-off would otherwise read as the end (`.scroll-x-fade`, `globals.css:400-407`).
8. **Chips whose label is a name get their own row** (§3); phone tap floor 44 px on every
   control (§3).
9. **Verify by looking**: 320/768/1280 screenshots read by a person, per-screen verdicts
   (R11) — a no-horizontal-scroll gate cannot see layout.

---

## 5. Per-wave themes

Each wave: the rules in the vocabulary above, then **one memorable thing** — boldness spent
in one place, everything around it quiet.

### W1 — Match centre (as built; later waves match it)

Composition (design doc `:334-349`; owner pick "A", `_INDEX.md:17`): breadcrumb + share ›
**court card** › **tab rail** › the active panel, inside `space-y-4` (`match-centre.tsx:108`);
the page keeps the shipped dark header bar and tagline strip exactly (W1 prompt `:52`).

1. The court card is the only `bg-court`, only `shadow-lg`, only display-size object on the
   page; everything below it is white cards with `border-zinc-200/80` hairlines or bare
   rows — nothing else is lifted.
2. Tabs come from the ledger (R4): cricket Summary · Scorecard · Commentary · Info; other
   sports Summary · Timeline · Sets/Periods · Info; an empty tab is not rendered.
   **Wiring finding (2026-09-05):** `TAB_PANELS` (`tab-panels.tsx:59-66`) still maps
   scorecard/commentary/timeline/sets/info to placeholders returning `null`, no file in
   `apps/web/src` imports `ScorecardTab`/`CommentaryTab`/`TimelineTab`/`SetsTab`/`InfoTab`,
   and the fixture page still mounts `LiveScore` (`fixtures/[fixtureId]/page.tsx:175`), not
   `MatchCentre` — Task 14 is unstarted (`_INDEX.md:157`). "As built" today is court card +
   rail + Summary; the other five panels exist and are unwired. Their classes above are
   still the vocabulary.
3. Summary: live block card › performers (two-up ≥768) › fall-of-wickets rail › partnership
   bars (`h-2 rounded-full bg-zinc-100` track, `bg-accent` fill, `summary-tab.tsx:236-237`).
4. Scorecard: one `<details>` per innings, last open; batting then bowling; ≥768 side by
   side (`DesktopA.dc.html`); dismissal as an 11 px sub-line; totals row `border-t` bold.
5. Commentary: over groups newest first, five at a time, "Load earlier overs"
   (`commentary-tab.tsx:73,214-223`); glyph `bg-accent/15` before each ball line.
6. Timeline: marker column `w-12` 11 px muted, sentence, side badge right
   (`timeline-tab.tsx:113-126`); emphasis `score` bold, `strong` bold accent (`:82-86`);
   card swatches per §2.2 P8. Sets/Periods: `w-10` columns, the open column `text-accent`
   with `data-open` (`sets-tab.tsx:113-125`), en dash for a missing cell (`:160`).
7. Info: two-column `<dl>` at 320, labels 11 px, values 13 px, then three `rounded-lg` links
   (`info-tab.tsx:47-81`); the band line in one sentence (ruling 12).
8. Copy: `matchCentre.*` keys, four locales; notation untranslated; status chip words from
   `matchCentre.status.*` (`_INDEX.md:161-164`).
9. Cosmetic convergence owed at R11 (proposed, §8): P2, P3, P4, P10, P11.

**The memorable thing:** the **chase line on the slab** — "Queens need 34 from 21" (final:
"Blue Blazers won by 12 runs") set in Barlow Condensed beneath the two score rows, with
CRR/RRR small beside it (`Main.dc.html` bottom row of the card). One sentence, the thing a
spectator came for. (P4 converges the shipped `text-sm` muted line to this.)

### W2 — Competition landing (hub), division and player pages

Renders (W2 prompt `:18-50`; design doc `:422-458`): a competition tab rail Overview ·
Matches · Table · Stats · Teams · (Gallery) · Info; hub hero; Live-now rail; match cards
grouped by day; standings composed for 320; leaders; team badges; the division page on the
same rail; the player page's per-match lines.

1. **Hero = the existing court slab hero** (`[competitionSlug]/page.tsx:95-179`): org eyebrow,
   competition name `font-display text-4xl sm:text-5xl uppercase`, date line, share bar,
   Register CTA, count chips `bg-white/12`, keel. Keep it; drop nothing. Do not add a second
   atmosphere — the accent radial washes at 50 % (`:111-118`) are the one it has.
2. **Rail = the `TabRail` component** (`tab-rail.tsx`) with `mh-` testids; the division page
   keeps its sticky segmented shell (`tabs.tsx:18-21`) — both use the same pill classes.
3. **Live-now rail = a row of score strips on court slabs** — each a miniature court card
   (`rounded-xl bg-court p-3.5 ring-1 ring-emerald-400/40`, `:194`) that now carries **two
   side rows with crest tile, short name and score** and the emerald keel; `role="list"
   tabIndex={0} aria-label`, `snap-x` optional, no `hover:-translate-y-0.5`.
4. **Match card** (Matches hub, division Schedule): the schedule row grammar
   (`schedule.tsx:111-153` — `grid-cols-[3.25rem_minmax(0,1fr)_auto]`, time/LIVE rail at
   left, stacked sides, right-aligned Barlow `text-lg` tabular scores, winner bold / loser
   muted, live edge `w-0.5 bg-emerald-400`) plus a crest tile before each name and one meta
   line (division chip · stage/round · venue as separate elements, not a joined string); the
   poster icon slot (W3) at the right of the meta line. Cards sit in a `rounded-xl` row
   group, `divide-y`, no shadow (P7).
5. **Standings at 320**: rank chip · crest (`EntityLogo` 20) · team (`truncate`) · P · W · L
   · **Pts** (`font-display text-base font-bold text-accent-strong`, `standings-table.tsx:128`)
   — the long tail (D, T, NR, NRR, tiebreak metrics) behind a `<details>` "More columns"
   per table or unfolding at `md`; the rank column stays sticky inside the box (`:67,86-90`).
   The podium colours stay fixed (`:39-45`).
6. **Leaders**: a row group per metric — rank chip · name (own row on phones if a chip) ·
   team badge · the figure in Barlow tabular right; rows link to the player page.
7. **Teams**: badge tile (real image via `resolveEntrantBadge({badge_url, team_logo_path})`,
   `[divisionSlug]/page.tsx:80-88`; else a monogram tile in the P1 ladder's colour) · name ·
   division chip. Teams whose club has set a kit colour show it here first — this tab is
   where a spectator notices the ladder is real.
8. **Empty case first** for every filter/table/leaders list (R9); the default filter ladder
   Live › Upcoming › Completed.
9. **i18n sweep** of the competition, division, `LiveScore`, schedule and the header tagline
   into `public.json`, four locales (R2).

**The memorable thing:** the **Live-now rail** — every live match in the competition as a
swipeable row of miniature court cards with real team names and scores, updating in place
(R10). It is the first thing under the hero and the reason a spectator opens the link.

### W3 — Match poster (feed 1080×1350, story 1080×1920; upcoming / live / result)

Renders (W3 prompt `:19-42`; design doc `:468-513`; picked board `PosterA.dc.html`,
`PosterResult.dc.html`): `next/og` PNG on the court colour with crest tiles.

1. **Ground = the competition's court colour** (`ogTheme(...).court`, `server/og/model.ts:21-43`
   → `--ps-court` derivation), ink `#f7f5fb`, muted `rgba(247,245,251,0.64)`, accent =
   brand accent. One atmosphere device as picked: the rotated accent slab at 14 % opacity plus
   the fading dot texture (`PosterA.dc.html`). The live and story variants add nothing more.
2. **Crest tiles = the design.** Two 400 × 400 tiles, `border-radius 40px`, shadow
   `0 30px 60px rgba(0,0,0,.4)`, filled with the team's colour (P1) and the real badge when
   `badge_url`/`team_display_v.logo_path` resolves (fetched with a timeout; else the
   two-letter monogram — `crestMonogram`, `lib/news-presentation.ts:77-87` — at 190 px
   Barlow 700, `letter-spacing -0.02em`); "VS" between them at 96 px, 50 % ink; a white
   name pill under each (`border-radius 999px; padding 14px 32px; 40px Barlow 600`, two
   lines max, centred).
3. **Type at poster scale** (Barlow Condensed unless noted): org badge 96 px tile
   (`radius 24`); competition eyebrow 34 px 600 `letter-spacing 0.18em` uppercase 72 % ink —
   the ONE tracked eyebrow this programme allows outside the status chip, because a poster
   is a programme cover; display line 132 px 700 `line-height 0.92` uppercase (stage label —
   "League match") with a 38 px sub-line; **result variant** display line 104 px `line-height
   0.95`, two lines max ("Blue Blazers won / by 12 runs"), result pill above it 26 px in a
   12 % ink capsule; **scores inside the tiles** 96 px tabular under a 150 px monogram, overs
   34 px at 80 % ink; the losing tile at `opacity .92`; format line 64 px 600; date/time/venue
   as one outlined capsule (2 px at 35 % ink, 34 px Geist 500) with `|` separators at 40 %
   ink; footer "Powered by" 26 px Geist + wordmark 40 px Barlow 700, or the org name/logo
   when `org.branded`.
4. **Live variant**: the LIVE capsule (`rgba(52,211,153,.16)` fill, `#6ee7b7` text, 6 px dot)
   replaces the result pill; the display line is the chase line; scores + overs in the tiles;
   a CRR/target/RRR row and the two batters at the crease as two outlined 24 px-radius rows
   (the result variant's performer boxes, `PosterResult.dc.html`); "updated HH:MM" 26 px muted.
5. **Top performers (result)**: two outlined boxes (`2px` at 20 % ink, radius 24, `18px 28px`)
   — label 22 px `letter-spacing 0.1em` uppercase, name 40 px, figure 64 px tabular. A masked
   performer's line is dropped, never printed masked (R3).
6. **Sponsor strip**: a white band 120 px tall above the footer with the title sponsor's
   logo on `#ffffff` at its own colours — never recoloured; absent when the competition has
   no title sponsor.
7. **Safe areas**: feed — 64 px margins all round (as drawn). Story — the same components
   with the rhythm stretched; **PROPOSED (P9)** keep everything that carries information
   inside y = 250 … 1580 (≈250 px top for the profile/progress bar, ≈340 px bottom for the
   reply bar); the ground and slab may bleed. Verify on a device before ruling.
8. **Fonts**: satori needs real font files — an OFL display + text pair pinned under
   `apps/web/public/fonts` (W3 prompt `:35-36`). Barlow Condensed and Geist are both OFL;
   pin those weights (700/600 display, 500/400 text) so the poster and the page share one
   voice.
9. Unbranded variant is not a "free" watermark: the wordmark is set at the same size and
   weight as the org name would be.

**The memorable thing:** the **two crest tiles in team colour**, big enough to read as a
thumbnail in a WhatsApp group — with the score dropped inside them on the result variant.

### W4 — Gallery (Gallery tab + match-centre Photos strip; staff upload, consent gate)

Renders (W4 prompt `:39-47`; design doc `:534-552`): a photo grid grouped by day and match,
a lightbox, the Photos strip, the staff upload sheet with the media-consent gate.

1. **Thumb grid**: square thumbs, `grid-cols-3 gap-1` at 320 (≈95 px each), `md:grid-cols-6`
   — no rounded corners inside the grid (the grid IS the object; corners on 18 thumbs read
   as a card kit); the group gets `rounded-xl overflow-hidden`. Thumb 400 px derivative, `alt`
   from the caption or the match name.
2. **Day / match headers**: the section title style (P3) in Barlow 16 px with the match's
   score strip (§3) as the sub-line — a photo set is captioned by the match, not by a
   timestamp.
3. **Lightbox**: full-bleed on `bg-court`; the image `object-contain`; a caption bar at the
   bottom carrying the score strip of the tagged match, the caption text (Geist 14 px
   court-ink), and three actions — Share, Download, Request removal — as `rounded-lg`
   court-ink outlined buttons, `min-h-11`; swipe left/right; close 44 × 44 top-right; the URL
   hash is the photo id (no per-photo pages, `noindex`).
4. **Photos strip** (match centre): six thumbs in a `role="list" tabIndex={0}` rail plus an
   "All photos" link; hidden when empty (R4/R9).
5. **Upload sheet** (staff only): the platform bottom sheet (`.modal-overlay`/`.modal`,
   `globals.css:345-362` — full-width under `sm`, drag handle, safe-area padding) — the
   one place the platform's own chrome is correct, because it is a tool for the organiser's
   staff, not a spectator surface.
6. **Consent gate**: a plain sentence — "3 players in Men's T8 have declined media consent.
   Check that none of them is pictured." — then the tick "I have checked that everyone
   pictured has media consent", stored as `consent_confirmed_at`; the Upload button is
   disabled until the tick; the count is a fact, not a warning colour.
7. **Consent-blocked / removed state**: a removed photo 404s everywhere; the lightbox's
   "Request removal" opens a prefilled message with the photo id; the empty gallery uses the
   standard empty state ("No photos yet — staff can add match-day photos here.").
8. Caption type: Geist 14 px `text-ink` (page) / `text-court-ink` (lightbox); taken-at as a
   `<time>` in the venue zone, 12 px muted; never a middle-dot string.
9. Motion: the lightbox opens with one fade (150 ms, none under reduced motion); no
   per-thumb hover effects.

**The memorable thing:** the **lightbox captioned by the score strip** — the photo sits on
the competition's court colour with the match it belongs to underneath it, so a shared
photo carries the result.

### W5 — Public team page (`…/teams/[entrantId]`) — PROPOSED in full (P12; W5 not ruled)

Renders (design doc `:562-567`): badge, squad, results, upcoming, table position.

1. **Header on the slab**: a 64 px crest tile (team colour, P1) beside the team name in
   Barlow `text-3xl` uppercase, the division chip and the competition link beneath; the
   record as three small tiles inside the slab — Played, Won, Lost (and Pts) — each a Barlow
   tabular figure over a 11 px label; keel in accent.
2. **Form strip**: the last five results as 24 px squares in a row — W emerald-500 filled,
   L `bg-white/12` outlined, D/T `bg-court-muted` — `role="list"` with an accessible name; the
   same tile grammar as the poster.
3. **Fixtures**: the W2 match card row group, grouped Upcoming then Completed, this team's
   side always bold.
4. **Table position**: the W2 standings composition filtered to a three-row window (the team
   and its neighbours) with a "Full table" link.
5. **Squad**: a row group — person chip (own row), role/number when the roster carries it,
   consent-masked names as the masked label (R3), per-player season line from the W2 leaders
   fold when present.
6. **Share bar** with the team page link (R8); the org's branded/unbranded footer.
7. One DOM; at ≥768 the header tiles sit inline right of the name; fixtures and squad
   two-up.

**The memorable thing:** the **form strip** under the crest — five coloured squares that
tell the season's story before a word is read.

---

## 6. Wave order and the vocabulary's growth

W1 fixes the court card, rail, tables, chips, disclosure. W2 adds the score strip, match
card, composed standings and leaders rows — reusing W1's classes verbatim. W3 takes the
same tokens to poster scale (one type ramp, listed above). W4 adds the grid and lightbox on
the same court colour. W5 recomposes W2's rows under a W3-style tile. **No wave introduces a
new colour, a new family, a new radius or a new shadow value**; a new component is named
here first (owner ruling) and then built.

---

## 7. Anti-patterns → class-level rules

From the `frontend-design` skill's list of generated-design tells, mapped to this tree.
Inherited instances are listed so they are converged deliberately, not propagated by copy.

| Tell | Rule for new markup (W2 on) | Inherited instances (converge at that page's R11; owner's call) |
|---|---|---|
| Tracked ALL-CAPS eyebrow above content | **Uppercase belongs to Barlow Condensed at ≥ 16 px with `tracking-tight`/`tracking-wide` (the brand), to the status chip, and to sport notation in table headers. Geist never goes uppercase below 14 px.** No `text-xs uppercase tracking-[0.18em]` label above a block. Section titles use P3. | `summary-tab.tsx:99,129,192,220`; `live-score.tsx:252`; `[competitionSlug]/page.tsx:133,183,196`; `players/[personId]/page.tsx:82,126,161`; `schedule.tsx:251`; `standings-table.tsx:66`; `info-tab.tsx:56`; `commentary-tab.tsx:197`; `sets-tab.tsx:101` |
| Middle-dot meta strings (`A · B · C`) | Facts of different kinds are separate elements; `·` only between repeated same-kind items in one notation string. | header tagline `layout.tsx:97,101` (W1 told to keep; W2 i18n sweep may recompose); `summary-tab.tsx:208`; `scorecard-tab.tsx:142,402,434`; `live-score.tsx:170` |
| "→" / "▸" / "←" glued to link text | Never. Icon element or plain text. | `[competitionSlug]/page.tsx:90,150`; `share-bar.tsx:89` ("Copied ✓") |
| One radius everywhere | Radii by role (§2.4): slab/card 2xl › row group/disclosure xl › control lg › badge md › chip full. | — (the tree already differentiates; keep it so) |
| The same grey shadow under every block | Shadow ladder: slab `shadow-lg` › card `shadow-sm` › rows/disclosures none. | `schedule.tsx:263`, `standings-table.tsx:58` row groups carry `shadow-sm` (P7) |
| Gradient washes as decoration | None. Solid fills, hairlines, one atmosphere device on the hero/poster only. | `entity-logo.tsx:44` (`from-purple-500 to-fuchsia-500` monogram — replace with the P1 tile); hero washes `[competitionSlug]/page.tsx:108,111-118` stay as the hero's one device |
| Hover transition on every card | No lift. `hover:border-accent-line` / `hover:bg-accent-soft/60` only; `transition` limited to `colors`. | `[competitionSlug]/page.tsx:194,232` (`hover:-translate-y-0.5 hover:shadow-md`) |
| Monospace for small data labels | None on this surface; digits are Barlow or Geist `tabular-nums`. | `live-score.tsx:172` |
| Emoji as icon | None; SVG glyphs or none. | `live-score.tsx:228` 🏆; `[divisionSlug]/page.tsx:158` |
| Tinted near-black standing in for black | `bg-court` is a derived brand slab (15 % accent over `#131118`), not `#111`; use the token, never a literal. | — |
| Big-number-with-small-label default hero | Only where the number is the content (scores); never as a stats row on the landing. | — |
| Numbered markers on non-sequences | Only for real sequences (overs, innings, rounds). | — |
| Copy that sells or apologises | Plain verbs, sentence case, states what happens. | — |

---

## 8. Proposed items needing an owner ruling

| # | Proposal | Value to the customer | Cost / blast radius |
|---|---|---|---|
| P1 | Team colour = a three-rung ladder (§2.2): the club's own `home_primary` from `team_display_v.colors` when it parses and clears 3:1 › deterministic hue from the entrant id via the `division-hue.ts` wheel › neutral initials. Used for monogram tiles on W2 Teams, W3 posters, W5 header | A club that set its kit sees its real colours for the first time; every other entrant still gets a distinguishable tile with no organiser work | One helper reusing `public-theme.ts`'s `contrast()`; tests for the ladder's three rungs, hue stability and the violet-band skip. **No schema change, no new organiser field** |
| P2 | Tab pill keeps its 32 px look; the button gains a 44 px hit area via a pseudo-element | Tabs tappable one-handed at a ground | `tab-rail.tsx:35-37`, `tabs.tsx:30-32`; e2e `elementFromPoint` check |
| P3 | Section titles in cards = Barlow 16 px (`font-display text-base font-semibold uppercase tracking-wide text-ink`), as the picked W0 board drew them; Geist tracked eyebrows capped to status chip + notation | The page reads as one voice (the scoreboard's), not two | four W1 lines + the inherited list in §7 |
| P4 | Chase/result line on the court card in `font-display text-lg font-semibold text-court-ink` | The one sentence a spectator came for is legible from arm's length | `court-card.tsx:140` |
| P5 | Focus ring flips to `--ps-court-ink` inside `bg-court` (violet measures ≈2.97:1 there) | Keyboard users can see focus on the slab | one CSS rule in `globals.css` |
| P6 | In-place live change = one 600 ms `accent-soft` fade on the changed cell; none under reduced motion | The eye finds what moved without a re-layout | one class + reduced-motion entry |
| P7 | Row groups drop `shadow-sm` | Hierarchy readable at a glance (slab › card › rows) | `schedule.tsx:263`, `standings-table.tsx:58` |
| P8 | Sport palette never leaves the pad; card swatches on Timeline from the daylight set | The page belongs to the organiser's brand; cards still read as cards | none beyond Timeline swatches |
| P9 | Story safe zones ≈250 px top / ≈340 px bottom, verified on a device | Nothing important under Instagram's chrome | poster layout only |
| P10 | Tables converge on 13 px cells and the scorecard's header form | Consistency across Summary and Scorecard | `stat-table.tsx:93,102,112,116` |
| P11 | `min-h-11` on Info links, "Load earlier overs", `ShareBar` buttons | 44 px floor met | three class edits |
| P12 | W5 team page theme (§5) | Captains share a page their squad reads on a phone | new route; designed after W4 per the index |

Findings recorded on the way (not proposals): the unwired tab panels and `LiveScore` mount
(§5 W1.2); the team colour that exists, reaches the public payload and is read by nothing on
`/shared` (§2.2), and the fixtures export reading a `primary` key no writer writes
(`exports.ts:261-262`, §2.2); tab pill 32 px and three ≈36 px controls (§3); the
Live-now rail missing `tabindex`/role/name (`[competitionSlug]/page.tsx:187`); page ground is
`#f6f5f8` not the boards' `#fdfcf8` (§2.1); the summary/scorecard table-size drift (P10).

---

## 9. Design process record (two passes)

**Pass 1 — plan from the tree.** Palette = the `--ps-*` set + emerald live + podium fixed;
type = Barlow Condensed display over Geist body, tabular everywhere; layout = slab › rail ›
quiet panels, left-aligned text, right-aligned numbers, centred only on the poster;
principles = numbers carry the hierarchy, the organiser's brand not the platform's, phone
first by control set.

**Pass 2 — review against the skill's generic defaults, and what changed:**

1. Section titles were going to follow shipped W1 (Geist 12 px tracked uppercase eyebrows —
   the skill's first tell). Changed to the owner-picked board's Barlow 16 px; eyebrow style
   capped to the status chip and notation (P3).
2. Row groups were going to inherit `shadow-sm` from `schedule.tsx`. Dropped, so the shadow
   ladder carries hierarchy instead of one shadow under every block (P7).
3. Hover lift and the gradient monogram were in the tree and would have been copied into W2
   cards and W2 Teams. Excluded from the vocabulary; inherited instances listed (§7).
4. The middle-dot rule was first written as "avoid"; tightened to "same-kind sequences only"
   with the inherited notation instances named, so cricket notation is not broken and meta
   strings are not glued.
5. The poster was going to gain a third atmosphere device on the story variant (a keel
   band). Removed — the picked slab + dots is the one device; story stretches rhythm only.
6. The tab pill was going to be documented as-is. The 44 px floor (R11) is a rule in this
   programme; documented the 32 px measurement and proposed the hit-area fix that keeps the
   look (P2).
7. "Monogram in team colour" was going to be written as an existing capability (the prompts
   assume it). Pass 2 recorded it as a false premise — "the tree has no team colour" — on a
   grep of `apps/web/src/server` that returned only org branding. **That verdict was itself
   wrong and is corrected in §2.2:** the colour is stored on the *club*
   (`V242__clubs_and_imports.sql:13`), resolved by `team_display_v`, written by the club
   hub's colour pickers and already carried on the public entrant payload — a grep of the
   server could never have seen it, because the fact lives in the migrations. The premise
   holds; what it lacks is a fallback for unset colours, non-team entrants and unreadable
   hexes, so P1 became a three-rung ladder rather than a synthetic hue. Two lessons, both
   already in `AGENTS.md` and both re-learned here at full price: a grep is not a read, and
   an absence claim about data is settled in `db/migration/**`.

Also considered and rejected: borrowing the pad's per-sport night boards for the court card
(a scorer's night tool on a daylight spectator page, and it would fragment the organiser's
brand across a competition's divisions); a dark mode (none exists — a separate programme);
a second display face for the poster (satori pins Barlow + Geist instead, one voice).

---

## 10. Verification — how R11 reads a screen against this document

Per screen, per width (320 / 768 / 1280), on a prod build with real data; write what was
SEEN, not what must be true. A row fails if any cell fails; a cosmetic defect is a defect.

| Check | How to read it |
|---|---|
| Type scale respected | Scores Barlow tabular at the sizes in §2.3; names Barlow uppercase; body Geist 13/14; no size outside the table without a ruling |
| Tokens only | Every colour is a `--ps-*` utility, a zinc hairline, or a named signal (emerald live, podium, card grades); no literal hex in `className`/`style` except `divisionHue`/P1 output |
| Radii and shadows by role | Slab 2xl+lg; card 2xl+sm; row group/disclosure xl, none; control lg; chip full — count the shadows on the screen: one `shadow-lg`, cards `shadow-sm`, nothing else |
| Uppercase discipline | No Geist uppercase under 14 px except the status chip and table notation |
| Copy rules | Sentence case; plain verbs; no `·` between unlike facts; no arrows in link text; empty state says what appears when |
| Touch targets | Every control ≥ 44 px by `elementFromPoint` at its centre, at 320 and 390 |
| Control-set diff | Visible controls (name, order, repeats) at 320 vs 1280 differ by fold/unfold only, never by scale; paste the diff |
| Scroll regions | Each `overflow-x-auto` box has `tabindex="0"`, a role and a name; nothing `overflow-hidden` clips content; page `scrollWidth === clientWidth` at seven widths |
| Truncation | The 43-character entrant name truncates on one line in every row, chip and card; no blob chips |
| Live in place | Post an event through the API with the page open; the changed cell updates with one highlight and no re-layout, scroll position unchanged |
| Focus visible | Tab through the screen; the ring is visible on light and on the slab |
| Reduced motion | With `prefers-reduced-motion: reduce`, nothing animates and every end state is shown |
| Empty and error states | Render each; one sentence, dashed box, no emoji, no "coming soon" |
| Locale | Repeat the read in one non-English locale; no English leaks except notation |

Verdict table format (append to the design doc, "W<n> sign-off — per-screen verdicts"):
`Screen · Width · Seen · Verdict · Defect id`, one row per screen per width.
