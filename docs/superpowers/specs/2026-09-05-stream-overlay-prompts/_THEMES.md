# Stream overlay — design themes (binding for W1 and W2)

Source of the values: the owner-reviewed canvas
https://claude.ai/code/artifact/2aebcbde-28ba-45ff-9028-1151873e4901, authored at
1280×720 and converted here to the overlay's native canvas, **1920×1080**
(multiply the canvas by 1.5). OBS renders the page at 1080p one to one; every
other viewport is the same layout under `transform: scale(min(vw/1920,
vh/1080))` from the top-left, so the console preview at 320 px is this sheet,
smaller. Nothing below is a suggestion: a value that is not here is taken
from `globals.css` or `sport-theme.ts`, never invented.

## 1. Type

| Role | Face | Weights | Fallback | Notes |
|---|---|---|---|---|
| Names, numerals, brand mark, moment headlines | Barlow Condensed | 500, 600, 700, **800** | `'Arial Narrow', system-ui, sans-serif` | The public layout mounts 500/600/700 (`(public)/shared/[orgSlug]/layout.tsx:19-23`); the overlay layout mounts its own `next/font` instance adding 800 for W2 slabs. Variable `--ovl-font-display`. |
| Labels, context lines, detail band, footer | Geist | 400, 500, 600 | `system-ui, sans-serif` | From the root layout (`app/layout.tsx:10-13`), `--font-geist-sans`. |

Every value that can change width is `font-variant-numeric: tabular-nums`.
Team names never wrap and never truncate on the overlay: `white-space:
nowrap`, the cell grows, the other cell shrinks (`flex: 1 1 auto`). A name
longer than the cell can hold at 45 px falls to the entrant's short name, then
to the three-letter code; this is the only size step.

## 2. Colour — the seven sport tokens

The overlay root receives `sportThemeStyle(sportKey)`
(`components/v2/scorepad/v3/sport-theme.ts:557`). A sport without a palette
entry (cricket, generic) inherits the `:root` defaults
(`app/globals.css:1014-1022`). Overlay classes read only these seven:

| Token | Reads as | Used for |
|---|---|---|
| `--sport-board` | board | bar main band, bug body |
| `--sport-board-2` | band | live cell, brand cell, bug header, the side-in-play row |
| `--sport-ink` | ink | all text; 70 %, 65 %, 85 %, 92 % alphas for secondary text |
| `--sport-led` | LED | side-in-play score, LED bar, serve dot, striker dot, tennis points, football clock, sets-won count, boundary and goal slabs |
| `--sport-advisory` | green card (hockey) | card chip |
| `--sport-caution` | yellow card | card chip, yellow-card slab |
| `--sport-dismissal` | red card, wicket | card chip, wicket and red-card slabs, LED bar while a wicket slab shows |

Resolved values per sport, copied from `SPORT_PALETTES` (`sport-theme.ts:165`
onward) and the `:root` defaults. Missing cells inherit `:root`.

| Sport key | board | board-2 | ink | led | caution | dismissal |
|---|---|---|---|---|---|---|
| cricket (defaults) | `#150b36` | `#1d1145` | `#f5f0e8` | `#9ae600` | `#d97706` | `#dc2626` |
| generic (defaults) | `#150b36` | `#1d1145` | `#f5f0e8` | `#9ae600` | `#d97706` | `#dc2626` |
| football | `#0b1f16` | `#122e21` | `#f2f7f4` | `#ffb703` | `#ffd60a` | `#d00000` |
| hockey | `#06323c` | `#0a4657` | `#eef6f8` | `#ffd23f` | `#ffd60a` | `#ff5a4d` (advisory `#3ddc84`) |
| icehockey | `#040a22` | `#0c1430` | `#eef2f6` | `#67e8f9` | `#ffc233` | `#ff6b6b` |
| tennis | `#0b2545` | `#13315c` | `#f4f7fb` | `#d9f000` | `#f2a900` | `#fa5252` |
| badminton | `#241a14` | `#33261d` | `#f7f1e8` | `#2fe0bd` | `#ffc233` | `#ff6b6b` |
| tabletennis | `#101418` | `#0f2d40` | `#f2f6f8` | `#ff9440` | `#ffd60a` | `#ff7a80` |
| volleyball | `#161d27` | `#232c39` | `#f4f7fa` | `#4aa8ff` | `#ffd60a` | `#ff6b6b` |
| boardgame | `#25142e` | `#33203d` | `#efe9d8` | `#f4767a` | inherit | inherit |
| carrom | `#3a0f14` | `#4a161c` | `#f4ece0` | `#e0a63c` | inherit | inherit |

Fixed colours outside the sport set: live dot `#ef4444` with
`box-shadow: 0 0 15px rgba(239, 68, 68, 0.8)`; overlay shadow
`0 21px 66px rgba(0, 0, 0, 0.5)`; dividers `rgba(255, 255, 255, 0.14)`;
detail-band background = board at 90 % alpha (`color-mix(in srgb,
var(--sport-board) 90%, transparent)`).

Contrast: every LED-on-board and ink-on-board pair above is added to the
overlay's own contrast test (`apps/web/src/components/overlay/__tests__/contrast.test.ts`,
same method as `scorepad/v3/__tests__/contrast.test.ts`), floor 4.5:1 for
text, 3:1 for the LED bar. Slab text is board-on-LED and is tested too.

## 3. Theme A — Broadcast bar (`?style=bar`)

Anchored bottom, full width. Two stacked bands, one shadow, radius 6 px.

```
inset:            left 72   right 72   bottom 54
main band:        height 126   background board   ink
  live cell:      min-width 225, padding 0 33, background board-2
                  dot 15 (#ef4444) + "Live" Geist 24/600 letter-spacing .02em
                  context line Geist 21/500 ink 70 %      e.g. "T20, 2nd innings"
  team cell ×2:   flex 1 1 auto, padding 0 42, gap 24
                  name  Barlow 45/600 letter-spacing .01em nowrap
                  score Barlow 78/700 line-height 1 tabular   (margin-left auto)
                  meta  Barlow 33/500 ink 70 % width 66        e.g. overs "12.3"
  divider:        1.5 wide, rgba(255,255,255,.14)
  side in play:   inset bottom bar 8 px LED, score colour LED
  brand cell:     "seazn" Barlow 30/600 letter-spacing .08em ink 75 %,
                  padding 0 33, background board-2
detail band:      height 51, padding 0 33, gap 33, background board @ 90 %
                  Geist 24/500 ink 92 %; separators 1.5×24 rgba(255,255,255,.2)
                  emphasis item Geist 600 ink 100 % (chase line)
                  striker/server marker: 10.5 px LED dot before the name
```

Per-sport content of the bar (W1 unless marked W2):

| Sport | Live cell context | Team cell score / meta | Between cells | Detail band |
|---|---|---|---|---|
| cricket | format + innings ("T20, 2nd innings") | `142/6` / overs `20`; chasing side LED | divider | W2: striker* R (B), non-striker R (B), bowler O-M-R-W, "This over 1 4 W 0 2"; W1: chase line "Need 45 off 45", CRR, RRR |
| football, hockey, icehockey | period ("2nd half") | `2` / none | divider; clock cell Barlow 60/700 LED before brand | scorers per side ("Okafor 23'"), card chips 13.5×18 radius 3 in caution / dismissal / advisory with name and minute |
| tennis | set + round ("Set 3, quarter-final") | sets as cells Barlow 51/600 ink 70 %, current set 700 ink 100 %; serve dot 13.5 LED before server's name | points cell Barlow 60/700 LED ("30 : 15") | "Novak serving", break points saved, format line |
| badminton, tabletennis | game ("Game 2, men's doubles") | games as cells, current 700 ink 100 %; serve dot | games-won cell LED ("1 : 0") | who serves, previous game result, longest rally where the ledger has it |
| volleyball | set ("Set 4") | four set cells Barlow 45/600 ink 70 %, current set 54/700 ink 100 %; serve dot | sets-won cell LED ("1 : 2") | serving side, timeouts, set-situation line |
| boardgame | round / board | points as `1`, `½`, `0` Barlow 78/700 | divider | empty (band not rendered) |
| carrom | frame ("Frame 3") | board points | frame-wins cell LED | empty |
| generic | none | headline split per side | divider | empty |

An empty detail band is not rendered; the main band keeps its radius.

## 4. Theme B — Corner bug (`?style=bug`)

Anchored top-left. Width 480, radius 12, one shadow. The pad's own
"stadium-night tile", so the stream matches the app.

```
inset:            left 60   top 54
header:           height 48, padding 0 21, background board-2
                  dot 13.5 (#ef4444), "Live" Geist 21/600, context Geist 19.5/500 ink 65 %
                  right: brand Barlow 24/600 .08em ink 70 %  — football family: clock Barlow 33/700 LED instead
row ×2:           height 90, padding 0 24, gap 18
                  code  Barlow 48/600 width 96         ("MK", "NBR", "RDG"; tennis: surname Barlow 42/600 width 144)
                  cells Barlow 39/600 ink 70 %, gap 18 (sets / games / sets-won), current 700 ink 100 %
                  score Barlow 69/700 line-height 1 tabular (margin-left auto)
                  meta  Barlow 30/500 ink 65 % width 78 right-aligned (overs)
side in play:     row background board-2 + inset-left bar 8 px LED, score colour LED
footer:           height 45, padding 0 24, Geist 21/500 ink 85 %, space-between
                  emphasis Geist 600 ink 100 % (chase line)
```

Per-sport content of the bug: cricket rows `code · score · overs`, footer
"Need 45 off 45 · CRR 7.84 · RRR 6.00"; football family rows `code · [card
chips] · goals`, header clock, footer scorers; tennis rows `surname · set
cells · points (LED for server)`, footer "Novak serving · Quarter-final";
badminton and table tennis rows `pair · games won · points`, footer server
and games; volleyball rows `code · sets won · points`, footer server and
sets; boardgame rows `code · points`; carrom rows `code · frames · points`;
generic rows `code · value`.

## 5. Moments slab (W2)

Attached to the bug's right edge (radius `0 12 12 0`), or centred under the
bar's detail band (radius `0 0 6 6`). Height 216, padding 0 33, `display:
flex; flex-direction: column; justify-content: center; gap: 3`.

| Tone | Background | Text | Used for |
|---|---|---|---|
| `led` | `--sport-led` | `--sport-board` | boundary four and six, goal, ace, break/set/match point, set won, game won |
| `caution` | `--sport-caution` | `--sport-board` | yellow card |
| `dismissal` | `--sport-dismissal` | `#fff5f5` | wicket, red card |

Headline Barlow 96/800, line-height 0.9, letter-spacing .02em, upper case as
written in the dictionary ("SIX", "OUT", "GOAL"); a two-word headline
("MATCH POINT") drops to 78/800 on two lines. Line under it Geist 21/600
("S. Iyer 40 (24)", "R. Nair c Patel b Jones 12 (10)", "Adeyemi 70', Harbour
United"). While a wicket slab shows, the bug's LED bar and score take the
dismissal colour, then return.

## 6. Motion (W1 ships the first three; W2 adds the slab)

| Motion | Trigger | Spec | Reduced motion |
|---|---|---|---|
| Score tick | a side's `big` changed | that value only: `transform: scale(1) → 1.12 → 1`, 300 ms ease-out; its LED bar `opacity 1` for one frame then back | off |
| Side change | `led` moved to the other side | LED bar `transform: translateY(±90px)` (bug) / `translateX` (bar) over 200 ms ease-in-out | instant |
| Live dot | `live` true | `opacity 0.55 ↔ 1`, 2 s ease-in-out infinite | steady 1 |
| Slab (W2) | a moment dequeued | `translateX(-100%) → 0` 250 ms ease-out, hold 4000 ms, `→ -100%` 250 ms ease-in; slab clipped behind the bug (`overflow: hidden` on the wrapper) | show and hide with no transition |

Transform and opacity only. No animation on mount, no continuous ticker, no
`setInterval` for visuals; the tick is a class toggled from a previous-value
ref and removed on `animationend`.

## 7. Legibility at phone scale

Most fans watch on a phone where a 1080p frame is 390 px wide (scale 0.203).
Floors, measured on the canvas's "How fans see it on a phone" board:

| Element | Native | On a 390 px phone | Verdict |
|---|---|---|---|
| score (bar 78, bug 69) | 69 px minimum | 14 px | reads |
| bug code (48) | 48 px minimum | 10 px | reads |
| bar team name (45) | 45 px | 9 px | does not read; accepted, the bar is the desktop-and-TV theme |
| bar detail band (24) | 24 px | 5 px | does not read; accepted, same reason |
| slab headline (96) | 96 px | 19 px | reads |

Never lower a native size below these floors to fit content; drop content
instead (name → short name → code).

## 8. Organiser panel tokens (console, light theme)

The panel follows `embed-snippet.tsx` and `.card` / `.btn` in `globals.css`.

| Element | Classes / values |
|---|---|
| card | `card p-5` = radius 16, border `#f3e8ff` (purple-100), white, `shadow-sm` |
| heading | `text-sm font-semibold text-slate-700` with a 16 px lucide `Video` icon `text-purple-500`, stroke 1.75 |
| explainer | `text-xs text-slate-500` |
| style tabs | `rounded-md px-2.5 py-1 text-xs font-medium`; selected `bg-purple-100 text-purple-800`; idle `text-slate-500 hover:bg-purple-50 hover:text-purple-700`; `role="tab"` `aria-selected` |
| live preview | the real `<OverlayStage>` at `scale(640/1920)` inside a 96 px tall strip on a green field stand-in `linear-gradient(180deg, #3d7a3a, #2e6a2d)` |
| overlay link field | `rounded-lg border border-purple-100 bg-slate-950 font-mono text-[11px] text-slate-100`, height 40, read-only, selects on focus |
| copy button | `btn btn-ghost` = border `#e9d5ff`, text `#7e22ce`, 28 px inside the field at ≥ 768; full width 44 px below |
| steps | `ol` `text-[13px] leading-relaxed text-slate-700`, numbered (it is a sequence) |
| stream link input | `rounded-lg border border-purple-200 bg-white text-[13px] text-slate-700`, height 40 (44 below 768) |
| save button | `btn btn-primary` = `bg-purple-600 text-white`; label "Save link", success state "Saved" in the button |
| footnote | `text-[11px] text-slate-500` |
| phone (320–767) | single column, every control full width and 44 px tall, tabs 44 px, no horizontal scroll, identical control set to 1280 |

## 9. What each wave takes from this sheet

- **W1:** sections 1, 2, 3, 4, 6 (first three motions), 7, 8. Dictionary keys
  for every visible word here (`public.overlay.*`, `ui.stream.*`) in four
  locales.
- **W2:** section 5, the slab row of section 6, the W2 cells of section 3
  (cricket detail band), Barlow 800.

Visual sign-off per screen uses these values as the checklist: the reviewer
measures the shipped DOM (`getComputedStyle`) at 1920×1080 against sections
3 to 6 and records each deviation, rather than judging by eye.
