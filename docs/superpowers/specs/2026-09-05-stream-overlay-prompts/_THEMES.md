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
(`app/globals.css:1135-1141` — the seven `--sport-*` declarations; §5's
derivation rests on that fall-through, so this pin is load-bearing rather than
decorative). Overlay classes read only these seven:

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

**Eleven sports, not nine.** `SPORT_PALETTES` is OVERRIDES ONLY: cricket and
generic have no entry at all, and boardgame and carrom omit `caution` and
`dismissal`, so all four inherit `:root`'s `--sport-dismissal: #dc2626`
(`globals.css`). Any sweep over "each sport's dismissal" that reads only
`SPORT_PALETTES` is short by four — and the four it misses include cricket,
whose OUT slab is the tone's headline use. This is what settled §5's ink
(T1a, 2026-09-08).

**Every new ink-on-background pair** the T1 picks introduce — not merely the
pills and chips — carries the same 4.5:1 floor, measured against the hexes
Tailwind **4.3.1** actually compiles. `node_modules/tailwindcss/theme.css`
defines every colour in `oklch()`, so each hex is recorded here rather than left
to be re-derived. Scoping this list to "the pill and the chips" is how the
stepper's done-step colour slipped through review once; the scope is every pair.

| Pair | Hex on hex | Ratio |
|---|---|---|
| `text-amber-800` on `bg-amber-100` | `#973c00` on `#fef3c6` | 6.36 |
| `text-red-700` on `bg-red-100` | `#c10007` on `#ffe2e2` | 5.27 |
| `text-red-700` on `bg-red-50` | `#c10007` on `#fef2f2` | 5.87 |
| `text-red-800` on `bg-red-50` | `#9f0712` on `#fef2f2` | 7.64 |
| `text-emerald-800` on `bg-emerald-100` | `#006045` on `#d0fae5` | 6.70 |
| `text-emerald-800` on `bg-emerald-50` | `#006045` on `#ecfdf5` | 7.23 |
| `text-purple-800` on `bg-purple-100` | `#6e11b0` on `#f3e8ff` | 7.51 |
| `text-slate-600` on `bg-slate-100` | `#45556c` on `#f1f5f9` | 6.92 |
| `text-slate-700` on `bg-slate-100` (the health chips) | `#314158` on `#f1f5f9` | 9.45 |
| `text-slate-500` on white (the stepper's done steps) | `#62748e` on `#ffffff` | 4.76 |
| `text-slate-700` on white (§8a heading, step labels) | `#314158` on `#ffffff` | 10.36 |
| `text-slate-800` on white (§8b pack size) | `#1d293d` on `#ffffff` | 14.62 |
| `text-slate-600` on white (§8b price) | `#45556c` on `#ffffff` | 7.58 |
| `text-purple-700` on white (§8b "Buy more") | `#8200db` on `#ffffff` | 7.07 |
| `#ffffff` on `bg-red-600` (the REC pill) | `#ffffff` on `#e7000b` | 4.77 |

The table is the scope: **every** pair the picks introduce is in it, including
the four comfortable ones on white, so that "the table is shorter than the
claim" is never the state a reviewer has to notice. A future pair belongs here
whatever its ratio — the point of listing a 14.62 beside a 4.76 is that nobody
has to decide which ones were worth writing down.

`text-slate-400` was the first value written for the done steps and is
**2.63:1 on white** — it fails the floor this section declares. §8a uses
`text-slate-500` instead, which is already §8's own explainer colour, so the
panel gains no new grey. Recorded rather than quietly swapped, because "done"
is exactly the state a reader is tempted to fade past the floor.

A caveat rather than a rewrite: §8's `copy button` row still carries Tailwind
**v3** hexes — `#e9d5ff` and `#7e22ce` — while the installed 4.3.1 compiles
`purple-200` as `#e9d4ff` and `purple-700` as `#8200db`. The rows above are v4;
§8's are not yet. Correcting §8 is its own change, not T1's.

The slab's `dismissal` pair is per-sport and lives in §5.

### 2a. Card classes → chip tone, per period-kernel sport

**Every card class gets a chip** (product ruling, 2026-09-10, closing F13). Only
hockey and icehockey reach these — they are the two `makePeriodModule` sports,
and football's own entries are unreachable (it is not a period-kernel sport).

Before this ruling `DISCIPLINE_CLASS_TONE` declared **five of icehockey's seven
classes as UNCOLOURED** — `bench_minor`, `double_minor`, `major`, `misconduct`,
`game_misconduct` rendered no chip at all, while a 2-minute `minor` rendered
one. That is backwards on a broadcast: the more serious the offence, the less
visible the graphic. It was also settled in code rather than here, which is why
this section now exists.

| Sport | Class | Tone | Why |
|---|---|---|---|
| hockey | `green` | advisory | the sport's own three-card ladder, unchanged |
| hockey | `yellow` | caution | |
| hockey | `red` | dismissal | |
| icehockey | `minor`, `bench_minor`, `double_minor` | **caution** | the lesser-penalty family — a time penalty the side serves and returns from |
| icehockey | `major`, `misconduct`, `game_misconduct`, `match` | **dismissal** | the serious family — ejection or a period-length penalty |

Two tiers for icehockey, not three: the sport has no green-card equivalent, so
`advisory` stays unused there rather than being invented for symmetry.

Contrast is already satisfied — §2's table gives icehockey `caution` **11.24**
and `dismissal` **6.53** on its own `board-2`, both clear of the 3:1 graphical
floor unaided, and every chip additionally carries the `--sport-ink` hairline.

**A malformed discipline row must not erase the others** (same ruling, closing
F14). `disciplineList` previously returned `null` on the first entry it could
not parse, discarding rows it had already accepted — so one bad row from the
engine showed **no cards at all**, indistinguishable on screen from a clean
match. Skip the bad row, keep the good ones; reserve `null` for "no discipline
data at all". Showing two of three cards is strictly better than showing none
and looking correct, and this is the failure class where an over-refusing guard
silently dropped a wave's headline stat.

**The overlay's graphical pairs — floor 3:1, not 4.5.** The card chips and the
live dot are shapes, not words, so they answer to WCAG 1.4.11 at 3:1. §3
explains why the boundary is an `--sport-ink` hairline rather than the `board`
hairline the pad uses; these are the numbers behind it, all eleven sports:

| Pair (on `--sport-board-2`) | Range across the eleven sports | Floor 3 |
|---|---|---|
| **`--sport-ink` 1-px hairline** | **9.46 (hockey) – 16.11 (icehockey)** | clears everywhere — this is what carries the boundary |
| `advisory` fill | 3.93 (tennis) – 5.81 (hockey) | clears unaided |
| `caution` fill | 4.63 (carrom) – 11.24 (icehockey) | clears unaided |
| `dismissal` fill | **2.56 (football)** – 6.53 (icehockey) | football fails — **covered by the hairline** |
| live dot `#ef4444` | **2.75 (hockey)** – 4.82 (icehockey) | hockey fails — **covered by the hairline** |
| `--sport-board` 1-px hairline | 1.08 (cricket) – 1.33 (hockey) | fails everywhere — why the pad's hairline cannot serve here |

The two failing fills are **covered**, which is neither a pass nor a waiver: the
hairline is the boundary the criterion is met by, and the fill is then free to be
the sport's own red. Recorded this way so that a later change which removes or
thins the hairline reads as removing a load-bearing element rather than as
tidying a decoration.

Both also clear 3:1 on the OTHER ground — `dismissal` on `board` is 3.01
(football) and the live dot on `board` is 3.65 (hockey) — so "darken the band
these sit on" remains a live alternative for anyone who revisits this. It was not
taken because it would move `board-2`, which every theme reads.

## 3. Theme A — Broadcast bar (`?style=bar`)

> **This section IS registry entry `bar`** (owner answer 18 / Q7, 2026-09-06 —
> themes are a registry, not a two-value union): `{ id: "bar", labelKey:
> "stream.tab.bar", component: OverlayBar, sports: "all" }` in `OVERLAY_THEMES`
> (`apps/web/src/components/overlay/theme-registry.ts`). A future theme is a
> NEW SECTION of this sheet in the same shape — inset, band, type scale,
> per-sport cell table — paired with one registry entry and one component.
> Nothing below changes, and nothing below is per-sport: the sport enters
> through the palette (§2), never through the theme.

Anchored bottom, full width. Two stacked bands, one shadow, radius 6 px.

```
inset:            left 72   right 72   bottom 54
main band:        height 126   background board   ink
  live cell:      min-width 225, MAX-WIDTH 480, padding 0 33, background board-2
                  dot 15 (#ef4444) + 1-px --sport-ink hairline (see below)
                  "Live" Geist 24/600 letter-spacing .02em
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

**The live cell has a MAX-WIDTH of 480** (product ruling, 2026-09-10). Measured
in a browser at 1920×1080: the cell has `min-width: 225` and the team cells are
`flex: 1 1 auto`, so the cell grows with its context line — 225 px at "RIV won",
**312 px** at "Riverside won by 44 runs", **610 px** at a full-name result
sentence, taking each team cell down to 509 px. It never wraps and never
overflows the page, so this is a balance question rather than a defect: **a
scorebug's job is the score, and its caption must never dominate the frame.**
480 clears the reachable worst case (§3's decided context line is the SHORT form
— today a three-letter code plus a margin, ~312 px) while capping a long one, so
nothing reachable changes and the score can never be squeezed below half the bar
by data that arrives later. Past the cap the line clips; team names still never
truncate (§1's ladder is unchanged and applies to names, not to this line).

**The clock never shows an implausible number** (product ruling, 2026-09-10,
closing F16). Driven live, a fixture left `in_play` displayed **`1205:25`** —
twenty hours — because the clock ticks from the fold's anchor with no upper
bound and no relation to the period's declared length. A club that starts a
match and never ends it is ordinary, and this is the one element on screen that
keeps moving, so an absurd value is both the most visible defect and the most
likely. Where the period's expected length is knowable from the sport config,
show the broadcast convention past it (`45+`, `20+`); where it is not, hold the
clock at that ceiling rather than counting past it.

**Correction, same day:** this paragraph first read "`45+`, `90+`, `Q1+`".
**`90+` cannot occur.** `GameTime.elapsed` is **period-relative**, not
cumulative, so a football second half past its nominal length reads **`45+`**,
never `90+` — the clock restarts each period. Cumulative football minutes would
be a different feature and are not specified here. Recorded rather than quietly
swapped, because "90+" is the number a reader expects and would re-introduce. The live dot and
the period label carry liveness — the clock does not have to.

**The hairline is `--sport-ink`, not `--sport-board`, and it — not the fill —
is what satisfies WCAG 1.4.11 here.**

**What the owner approved is narrower than what this sheet draws, and the two
must not be read as one thing.** The recommendation put to them, and approved
verbatim with "apply your rec" (2026-09-08), was: *"the red-card chip and the
live dot take an `ink` hairline, not a `board` one"* — those two elements, the
two that fail their floor. **That is the ruling.**

This sheet then applies the same hairline to the `advisory` and `caution` chips
as well, so that all three discipline chips share one treatment in §3's bar and
§4's bug alike rather than the red one reading as an exception. **That extension
is the sheet's own consistency choice, not the owner's ruling.** It is separable
and reversible on its own: for those two chips the hairline is a boundary device
rather than a requirement, because both fills already clear 3:1 unaided (see the
`advisory`/`caution` note below). The owner's per-screen sign-off binds on the
red-card chip and the live dot; the other two chips are put to them as this
sheet's proposal.

The pad's standing rule reads the other way, and deliberately so.
`components/v2/scorepad/v3/tokens.ts:267-270` says of the pad's swatch:

> Its boundary against the pale sheet is carried by the `--sport-board`
> hairline, NEVER by the fill — yellow-on-wash is ~1.15:1 and cannot meet WCAG
> 1.4.11 alone. Exactly the pair that passes by eye and fails when computed.

Read the words "against the pale sheet": that rule is scoped to the pad's
console ground. **It does not transfer to the overlay**, where these chips sit
on `board-2`, a dark band of the sport's own palette. `board` against `board-2`
measures **1.08 (cricket) – 1.33 (hockey)** across the eleven sports — the two
are neighbouring shades by design — so a `board` hairline is invisible exactly
where it would have to do the work, and the FILL would silently become the
boundary. Two fills cannot carry it: `dismissal` on `board-2` bottoms out at
**2.56 (football)** and the live dot `#ef4444` at **2.75 (hockey)**, both under
the 3:1 graphical floor. `--sport-ink` on `board-2` measures **9.46 (hockey) –
16.11 (icehockey)** and clears everywhere, so the hairline carries the boundary
for all three chips and the dot.

`advisory` (3.93–5.81) and `caution` (4.63–11.24) clear 3:1 unaided on every
sport, so for those two the hairline is a boundary device rather than a
requirement; for `dismissal` and the live dot it is the requirement. §2 records
all of it. A later wave reading only `tokens.ts` would reach for `board` and
reintroduce this, which is why the scoping is written out here rather than left
to be inferred.

Per-sport content of the bar (W1 unless marked W2):

| Sport | Live cell context | Team cell score / meta | Between cells | Detail band |
|---|---|---|---|---|
| cricket | format + innings ("T20, 2nd innings") | `142/6` / overs `20`; chasing side LED | divider | W2: striker* R (B), non-striker R (B), bowler O-M-R-W, "This over 1 4 W 0 2"; W1: chase line "Need 45 off 45", CRR, RRR, **plus the revision marker below when the target was revised** |

**The chase line names the method when the target was revised** (owner ruling,
2026-09-10: *"add the DLS hint in W1"*). Without it a rain-revised chase shows
new numbers with nothing to say why they moved, which on a broadcast reads as
the scoreboard being wrong.

The data already arrives — this is a read, not a new derivation. Cricket's
`summary().detail` emits **`target` AND `targetSource`** together
(`packages/engine/src/sports/cricket/cricket.ts:3678-3680`), and
`projectOverlayLiveData` passes `summary` through whole (`server/overlay/project.ts`),
so `targetSource` is already on the wire and simply has no reader.

`targetSource` is `"dls" | "manual" | null`, so the marker has **three** cases
and a manual revision must NOT be labelled DLS:

| `targetSource` | Chase line |
|---|---|
| `"dls"` | the existing line + ` · DLS` |
| `"manual"` | the existing line + ` · Revised` |
| `null` | the existing line, unchanged |

Two new `public.overlay.chase.*` keys in all four locales; the marker is
appended by the projection (`overlayModel`), never assembled in a component, so
both themes and every future theme inherit it. `DLS` is a proper noun and stays
`DLS` in every locale; `Revised` translates.

**Consistency note.** `resultMsg` already names the method at the END of a
match — `cricket.ts:883` picks a `dls` suffix for the result sentence — so
before this ruling the overlay explained a revised result and not a revised
chase. This closes that asymmetry rather than opening a new surface.
| football, hockey, icehockey | period ("2nd half") | `2` / none | divider; clock cell Barlow 60/700 LED before brand | scorers per side ("Okafor 23'"), card chips 13.5×18 radius 3 in caution / dismissal / advisory, each with a 1-px `--sport-ink` hairline (see below), with name and minute |
| tennis | set + round ("Set 3, quarter-final") | sets as cells Barlow 51/600 ink 70 %, current set 700 ink 100 %; serve dot 13.5 LED before server's name | points cell Barlow 60/700 LED ("30 : 15") | "Novak serving", break points saved, format line |
| badminton, tabletennis | game ("Game 2, men's doubles") | games as cells, current 700 ink 100 %; serve dot | games-won cell LED ("1 : 0") | who serves, previous game result, longest rally where the ledger has it |
| volleyball | set ("Set 4") | four set cells Barlow 45/600 ink 70 %, current set 54/700 ink 100 %; serve dot | sets-won cell LED ("1 : 2") | serving side, timeouts, set-situation line |
| boardgame | round / board | points as `1`, `½`, `0` Barlow 78/700 | divider | empty (band not rendered) |
| carrom | frame ("Frame 3") | board points | frame-wins cell LED | empty |
| generic | none | headline split per side | divider | empty |
| **Decided / void** (every sport) | **decided** — dot OFF, "Final" Geist 24/600 in its place, context line = the short form of the result sentence ("Home won by 12 runs"). **Void carrying a verdict** (outcome present AND `kind <> 'no_result'`) — the status label ("Abandoned", "Forfeited") Geist 24/600 in the dot's place, context line = the short form, same as decided. **Void, no verdict** (null outcome, `no_result`, or `cancelled`) — the status label at full ink, context line = the sport's own line unchanged | decided AND void-carrying-a-verdict: the WINNING side keeps its LED bar and LED score, the loser is plain ink. Void, no verdict: both sides ink 50 %, no LED anywhere | unchanged | decided AND void-carrying-a-verdict: `result` Geist 24/600 ink 100 % REPLACES the chase line and the band still renders. Void, no verdict: no detail band |

An empty detail band is not rendered; the main band keeps its radius.

That last row is picked option 4A, "Result in place" (owner 2026-09-08):
nothing about the frame moves at the whistle, so a replay viewer arriving after
the end sees the score AND why it ended in the shape the live viewer saw. The
unpicked option B, "Collapsed band", stays on the design canvas.

**Three cases, not two — a void status is not the same as no result.**
`VOID_STATUSES` (`components/v2/stages-panel.tsx`) is `cancelled`, `abandoned`,
`forfeited`, and two of those routinely carry a genuine verdict: `forfeited`
always has a winner, and an abandoned match can be awarded (DLS in cricket, a
leader-awarded football result). The mechanism is in `fixtureStatusFromFold`
(`server/engine-db/append-event.ts`): `if (has("core.abandon")) return
"abandoned"` short-circuits BEFORE the outcome is consulted, so `status` says
`abandoned` while `fixtures.outcome` holds a real result.
`V355__division_results_abandoned_outcome.sql` exists for exactly this class and
carries the warning that settles the predicate:

> DO NOT "simplify" the new arm to `outcome is not null`. A cricket abandon
> folds to a **no_result OUTCOME** (see the comment at append-event.ts:113) —
> the outcome column is non-null and the verdict is "nothing happened". Keying
> on non-null alone would start charging a paid slot for a rained-off match,
> the opposite unfairness. MatchOutcome (packages/engine/src/core/types.ts) is
> a discriminated union on `kind`: win | draw | tie | no_result | award. A win,
> an award, a draw and a tie are all real verdicts; only `no_result` is not.

Read that as it is written: non-null **alone** is not enough, and neither is
`kind` alone. The test is V355's own two conjuncts, and the overlay uses the
same pair:

```sql
f.outcome is not null and f.outcome->>'kind' <> 'no_result'
```

So the overlay branches on the verdict, not on the status: **a fixture whose
outcome is PRESENT and whose `kind` is anything but `no_result` gets the DECIDED
treatment**, with the status label shown in place of the live dot so a viewer
still learns the match was abandoned or forfeited. Everything else gets the
blanked ink-50 % treatment: a null outcome, a `no_result` kind, and `cancelled`,
which never carries one. Dropping the null conjunct is not a harmless widening —
`resultMsg` returns `null` when `outcome == null` (`match-centre.ts:639`), so a
fixture with no outcome would render the decided frame around an empty detail
band. Written the other way round, an awarded result would disappear from the
stream, which is the one thing option 4A exists to prevent; written too loosely,
an unplayed one gets a winner's LED and a blank band.

**The result sentence has an existing producer; do not write a second one.**
`resultMsg` (`server/public-site/match-centre.ts:632`, called from `buildHeader`
and reached through the exported `buildMatchCentre` at `:974`) builds
"{winner} won {margin}" from `matchCentre.result.*`
(`dictionaries/en/public.json:177-189`), with the DLS, super-over,
boundary-count, shootout, forfeit, tie, draw and `no_result` variants already
written in four locales. That string is what the public match-centre page shows
for the same fixture, so the overlay must render **the same string from the same
producer** — a second authority would let the stream and the match page disagree
about who won. `resultMsg` is currently module-private; W1 exports it (or lifts
it beside the projection) rather than reimplementing it. The bar's context line
is a SHORTER string than the detail band's: the band carries `resultMsg`'s full
sentence, the context line carries the same sentence with the winner reduced to
the short name the cell already uses ("Kings won by 44 runs" against "Mumbai
Kings won by 44 runs"). Both come from `resultMsg`; only the winner token
differs.

The status WORDS — "Final", "Abandoned", "Cancelled", "Forfeited" — are NOT from
`resultMsg` and NOT from `fixtureStatusLabel` (`stages-panel.tsx`), whose
`schedule.fstatus.*` values are the console's lowercase vocabulary ("decided",
"abandoned") and carry no `final` key at all. They are new
`public.overlay.status.*` keys; see the i18n note in §9.

## 4. Theme B — Corner bug (`?style=bug`)

> **This section IS registry entry `bug`** (owner answer 18 / Q7): `{ id: "bug",
> labelKey: "stream.tab.bug", component: OverlayBug, sports: "all" }` in
> `OVERLAY_THEMES`. §3 and §4 are the registry's two entries on day one and its
> only content; the registry is the index, this sheet is the values. A third
> theme adds a §4a here in this same shape and one entry there — never an edit
> to the route, the panel or the projection. If a theme is ever designed for a
> subset of sports, that is the entry's `sports` field, and this sheet says
> which sports in its own preamble.

Anchored top-left. Width 480, radius 12, one shadow. The pad's own
"stadium-night tile", so the stream matches the app.

```
inset:            left 60   top 54
header:           height 48, padding 0 21, background board-2
                  dot 13.5 (#ef4444) + 1-px --sport-ink hairline (§3's rule)
                  "Live" Geist 21/600, context Geist 19.5/500 ink 65 %
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

The bug's card chips and its live dot carry the **1-px `--sport-ink` hairline**
on the same terms as §3's — same reasoning, same measurements, same reason not
to reach for `board`. Nothing about it is per-theme.

Per-sport content of the bug: cricket rows `code · score · overs`, footer
"Need 45 off 45 · CRR 7.84 · RRR 6.00"; football family rows `code · [card
chips] · goals`, header clock, footer scorers; tennis rows `surname · set
cells · points (LED for server)`, footer "Novak serving · Quarter-final";
badminton and table tennis rows `pair · games won · points`, footer server
and games; volleyball rows `code · sets won · points`, footer server and
sets; boardgame rows `code · points`; carrom rows `code · frames · points`;
generic rows `code · value`.

**Decided / void** in the bug, the same picked option 4A and the same three
cases as §3's row, branching on the outcome's `kind` rather than on the status.
**Decided** — the header dot goes OFF and "Final" takes its place, the winning
row keeps its LED bar and LED score, and the footer carries `resultMsg`'s
sentence (Geist 21/600 ink 100 %) in place of the chase line. **Void carrying a
verdict** (outcome PRESENT and `kind <> 'no_result'` — a forfeit, a DLS or
leader-awarded abandon) — identical to decided, except the header shows the
status label ("Abandoned", "Forfeited") where "Final" would be, so the viewer
learns both the result and how it ended. **Void with no verdict** (a null
outcome, a `no_result` kind, or `cancelled`, which never carries one) — both rows
drop to ink 50 %, no LED anywhere, the header carries the status label at full
ink, and the footer is not rendered at all. Same two conjuncts as §3, and for
the same reason: `resultMsg` has nothing to return for a null outcome. Same
`public.overlay.status.*` keys as §3.

## 4a. Theme C — Slate (`?style=slate`)

> **This section IS registry entry `slate`** (owner pick 1A, 2026-09-08):
> `{ id: "slate", labelKey: "stream.tab.slate", component: OverlaySlate,
> sports: "all" }` in `OVERLAY_THEMES`
> (`apps/web/src/components/overlay/theme-registry.ts`). It is the registry's
> third entry beside §3's `bar` and §4's `bug`, written in the same shape and
> for the same reason: the registry is the index, this sheet is the values, and
> the sport enters through the palette (§2) rather than through the theme.
> Two things are unlike §3 and §4. It is the **one OPAQUE theme** — every other
> theme is a transparent layer over the camera picture; this one replaces the
> picture — which is why compositing it over a light and a dark video frame is
> vacuous by construction and why that check binds on §3, §4 and their
> decided/void rows instead. And under B3 it is additionally a page STATE driven
> by the `<video>` element (spec §7.5), not only a `?style=` choice.

Full bleed, 1920×1080. No inset, no radius, no shadow: it *is* the frame.

```
ground:           --sport-board, opaque, 1920×1080
                  radial highlight color-mix(in srgb, var(--sport-board-2) 60%,
                  transparent) centred at 50 % 40 %, radius 900
brand:            "seazn" Barlow 30/600 letter-spacing .08em ink 75 %
                  inset left 72   top 54
headline:         Barlow 96/800 ink 100 %, centred, letter-spacing .02em,
                  upper case as written in the dictionary
line:             Geist 27/500 ink 70 %, 12 below the headline
indicator:        under the line (warming) or beside it (signal lost)
scorebug:         the SELECTED theme (§3 bar or §4 bug) renders ON TOP of the
                  slate, at its own inset, unchanged in every value
```

| State | Headline | Line | Scorebug on top | Indicator |
|---|---|---|---|---|
| warming | `STARTING SOON` | "Home v Away · 14:30 &lt;venueTz short&gt;" | the selected theme in its SCHEDULED state: scores render as `—` in ink 70 %, no LED anywhere, the live cell / header carries the start time and venue instead of the live dot | three 15-px `--sport-led` dots under the line, breathing `opacity .55 ↔ 1` over 2 s, staggered 300 ms |
| signal lost | `SIGNAL LOST` | "Reconnecting…" | the selected theme with its live values intact — **the score never leaves the screen** | one 15-px `#ef4444` dot beside the line, with the live dot's `box-shadow: 0 0 15px rgba(239, 68, 68, 0.8)` |
| ended | `MATCH ENDED` | `resultMsg`'s full sentence — the same string §3's detail band and §4's footer carry, from the same producer (`match-centre.ts`), never a second one | the selected theme in its decided state (§3 and §4's decided/void rows, all three cases) | none |

Motion: none on mount, and a state swap is a 250 ms cross-fade of `opacity`
only — nothing translates or scales. Under `prefers-reduced-motion` the warming
dots hold steady at `opacity 1` and the cross-fade is instant.

**i18n.** `STARTING SOON`, `SIGNAL LOST`, `MATCH ENDED` and "Reconnecting…" are
new `public.overlay.slate.*` keys. There are **zero** `public.overlay.*` keys in
any dictionary today, so every visible word in this section is new and is owed
in all four locales.

The unpicked option B, "Card over field" — a neutral `#0b0d12` ground with a
diagonal board band and the bug at 1.5× — stays on the design canvas and is
deliberately not a value here: it is a second palette to maintain and it never
shows the bar.

## 5. Moments slab (W2)

Attached to the bug's right edge (radius `0 12 12 0`), or centred under the
bar's detail band (radius `0 0 6 6`). Height 216, padding 0 33, `display:
flex; flex-direction: column; justify-content: center; gap: 3`.

| Tone | Background | Text | Used for |
|---|---|---|---|
| `led` | `--sport-led` | `--sport-board` | boundary four and six, goal, ace, break/set/match point, set won, game won |
| `caution` | `--sport-caution` | `--sport-board` | yellow card |
| `dismissal` | `--sport-dismissal` | whichever of `#fff5f5` and that sport's own `--sport-board` measures the higher WCAG contrast against that sport's own `--sport-dismissal` — see the table below | wicket, red card |

Headline Barlow 96/800, line-height 0.9, letter-spacing .02em, upper case as
written in the dictionary ("SIX", "OUT", "GOAL"); a two-word headline
("MATCH POINT") drops to 78/800 on two lines. Line under it Geist 21/600
("S. Iyer 40 (24)", "R. Nair c Patel b Jones 12 (10)", "Adeyemi 70', Harbour
United"). While a wicket slab shows, the bug's LED bar and score take the
dismissal colour, then return — that is `dismissal` used AS TEXT on `board`,
which is the same pair §5's table measures and which football fails at 3.01. It
keeps the **3:1 graphical licence** rather than the 4.5 text floor: the LED bar
is a bar, and the score beside it is a numeral at Barlow 69/700, both of which
the pad's own sheet already treats as large/graphical. The slab's headline is
the one place that pair must clear 4.5, and that is what the derivation below
settles.

**The `dismissal` ink is derived, not fixed** (owner pick 5C, 2026-09-08).
`dismissal` is the only one of the seven tokens that is a LIGHT colour in six
palettes and a DARK one in five, so no single ink clears 4.5:1 across the eleven
sports — **six fail either way**. Against `#fff5f5`: hockey 2.88, icehockey
2.59, tennis 3.07, badminton 2.59, tabletennis 2.35, volleyball 2.59. Against
`--sport-board`: football 3.01, cricket 3.84, generic 3.84, boardgame 3.57,
carrom 3.46, and hockey again at 4.46. (Five is the count against `#fff5f5` at a
3:1 floor, which is a different question and not the one this sheet asks.) The
rule is therefore per-sport, and the RESOLVED value is recorded here so a later
wave reads a value rather than re-deriving a rule:

| Sport | `--sport-dismissal` | Slab ink | Ratio |
|---|---|---|---|
| hockey | `#ff5a4d` | `--sport-board` `#06323c` | **4.46 — the named exception, below** |
| icehockey | `#ff6b6b` | `--sport-board` `#040a22` | 7.06 |
| tennis | `#fa5252` | `--sport-board` `#0b2545` | 4.68 |
| badminton | `#ff6b6b` | `--sport-board` `#241a14` | 6.14 |
| tabletennis | `#ff7a80` | `--sport-board` `#101418` | 7.35 |
| volleyball | `#ff6b6b` | `--sport-board` `#161d27` | 6.11 |
| football | `#d00000` | `#fff5f5` | 5.33 |
| cricket | `#dc2626` (`:root`) | `#fff5f5` | 4.51 |
| generic | `#dc2626` (`:root`) | `#fff5f5` | 4.51 |
| boardgame | `#dc2626` (`:root`) | `#fff5f5` | 4.51 |
| carrom | `#dc2626` (`:root`) | `#fff5f5` | 4.51 |

Ten of eleven clear 4.5:1. **Hockey is 4.46 — a named exception, recorded and
not waived.** The overlay's contrast test asserts hockey's ratio in the SHAPE
the pad's existing pin already uses: **two-sided, `>= 3.0` and `< 4.5`** — not a
one-sided `>= 3.0`, which would keep passing if the palette drifted upward and
would never tell anyone the exception had ended. Skipping hockey is the other
wrong answer: a skipped sport is the silent red this wording exists to prevent.

`sport-theme.ts`'s hockey block already pins 4.46 two-sided, but for a card
SWATCH (a shape in a colour with the name beside it) whose licence is the 3:1
graphical floor, not the 4.5 text floor. The slab WRITES on that colour, which
is exactly the "later wave that wants to word a red card on the night board"
that comment anticipated — so the slab does not inherit the swatch licence, and
this is the one place the two obligations meet on the same number.

Derive the expected ink in the test from the palette, never from a table typed
into the test — this table is the sheet's record of the outcome, not the test's
source of truth. No palette hex changes: the answer lives here.

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

**One deliberate exception: the football clock advances between events.**
A match clock is DATA, not decoration, and the engine gives a snapshot
(`phase`, `periods`, `asOf`) that only changes when something is scored or a
period turns. Left alone the clock would freeze for minutes at a time, which
looks broken on air. So the football family runs one 1 Hz interval that
advances the displayed time from the last snapshot plus elapsed wall time,
and it is **phase-aware**: it stops at half-time, at full-time and at any
stoppage the phase declares, and it re-anchors to the snapshot on every push
so it can never drift away from the engine's answer. This is the only timer
in the overlay; every other motion is CSS. `prefers-reduced-motion` does not
disable it, because it is information rather than movement.

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
| live preview | the real `<OverlayStage>` at `scale(640/1920)` inside a **360 px** tall strip on a green field stand-in `linear-gradient(180deg, #3d7a3a, #2e6a2d)`, `transform-origin: top left` (matching `.ovl-canvas`'s own) |

**The strip was 96 px and that number could not work** (owner ruling **360 px**,
2026-09-10, on the W1 Task 6 finding). At `scale(640/1920)` = 1/3, a 96 px strip
shows the top **288** of the canvas's 1080 authored px. §4's bug is anchored
`top: 54`, so it lands at y 18–79 scaled and is visible. **§3's bar is anchored
`bottom: 54`, which lands at y ≈ 279–342 scaled — entirely below a 96 px
strip.** Selecting *Broadcast bar* therefore previewed as an empty green
rectangle, and cricket's own default is `bar` (`defaultThemeFor`), so cricket
organisers met it first.

360 px is the smallest height that shows the whole 1080 px canvas at the scale
this row already states (1080 ÷ 3 = 360), so the fix moves ONE number and leaves
`scale(640/1920)` — which §8's own OBS-link copy and the panel's width maths both
depend on — untouched. The alternative, keeping 96 px and raising the scale,
would have shown a crop and made "the preview is the real `<OverlayStage>`" false.

Recorded rather than silently corrected because the two numbers were internally
inconsistent from the sheet's first draft, and a reader checking only one of them
would reintroduce it.
| overlay link field | `rounded-lg border border-purple-100 bg-slate-950 font-mono text-[11px] text-slate-100`, height 40, read-only, selects on focus |
| copy button | `btn btn-ghost` = border `#e9d5ff`, text `#7e22ce`, 28 px inside the field at ≥ 768; full width 44 px below |
| steps | `ol` `text-[13px] leading-relaxed text-slate-700`, numbered (it is a sequence) |
| stream link input | `rounded-lg border border-purple-200 bg-white text-[13px] text-slate-700`, height 40 (44 below 768) |
| save button | `btn btn-primary` = `bg-purple-600 text-white`; label "Save link", success state "Saved" in the button |
| footnote | `text-[11px] text-slate-500` |
| phone (320–767) | single column, every control full width and 44 px tall, tabs 44 px, no horizontal scroll, identical control set to 1280 |

## 8a. Phone tab (console, light theme)

Extends §8: same `card`, same heading grammar, same 44-px phone floor, same
link-field and copy-button styles. Picked option A, "Stepper" (owner
2026-09-08) — an organiser at a ground can see where they are in a four-step
flow they run once a week, and support can ask which step they are on. The
unpicked option B, "State card", stays on the design canvas.

| Element | Classes / values |
|---|---|
| frame | `card p-5`; below 768 `p-4` inside a 12-px page gutter (the QR row is what fixes those two numbers). Heading `text-sm font-semibold text-slate-700` with a 16 px lucide `Smartphone` icon `text-purple-500`, stroke 1.75 |
| state pill | right of the heading, `rounded-full px-2 py-0.5 text-[11px] font-medium`: idle `bg-slate-100 text-slate-600`; provisioning / warming `bg-amber-100 text-amber-800`; live `bg-red-100 text-red-700` with a 6-px `bg-red-500` dot; ending `bg-slate-100 text-slate-600`; ended `bg-emerald-100 text-emerald-800`; failed `bg-red-50 text-red-700` |
| steps | `ol` of four `li`, `text-[13px] text-slate-700`: 1 Connect phone · 2 Waiting for camera · 3 Live · 4 Ended. Current step `font-semibold text-purple-800` with a `bg-purple-100` 24-px circled number; done steps **`text-slate-500`** with a check (4.76:1 — `text-slate-400` is 2.63:1 on white and fails §2's floor; see §2). Below 768 the `ol` is REPLACED by one line — "Step 2 of 4 · Waiting for camera", `text-[13px] font-semibold text-purple-800`. **Left-aligned at every width, and left-aligned in the QR state too: it is a list.** |
| idle | destination `select` over `org_stream_targets` with "+ Add destination" `btn btn-ghost`; mode segmented control `role="radiogroup"` (`Clean feed` / `With scorebug`); balance chip "3 credits" `text-xs text-slate-500`; primary `btn btn-primary` "Go live" |
| QR shown (warming) | **ONE CENTRED COLUMN** (owner 2026-09-08). The QR sits in a `rounded-lg border border-purple-100 bg-white p-3` box, and the three things under it — the paste-code field, the caption "Point the phone at this code" `text-xs text-slate-500`, and `btn btn-ghost` "Cancel" — are all CENTRED beneath it, with the paste-code field taking **the QR box's own width**, not the card's. A left-aligned stack under a centred QR reads as two columns that do not line up, which is what this row exists to prevent. Paste code in §8's link-field style (`font-mono text-[11px]`, `bg-slate-950 text-slate-100`, height 40 / 44 below 768); the copy button follows §8's rule exactly — 28 px inside the field at ≥ 768, full width 44 px below it under 768. The stepper above is unaffected. |
| QR size | **`min(264px, available)` in CSS px, with NO floor above `available`** — the QR always fits its own box, so it can never be the thing that puts a horizontal scrollbar on the panel. It is a rule, not a constant. The three measurements, each with its unit: **264 CSS px at 1280** (and at 768 — `available` exceeds 264 at both); **236 CSS px at 320**; **172 CSS px at 320 @ 125 % zoom**, which is 215 device px. `available` = the width less, twice over, the page gutter 12, `.card`'s own 1-px border, the card's `p-4` 16, the QR box's 1-px border and its `p-3` 12 — so 320 − 2(12 + 1 + 16 + 1 + 12) = **236**, and 256 − 2(42) = **172**. That subtraction is the BELOW-768 one; at ≥ 768 substitute the card's `p-5` 20 for `p-4` 16, giving 2(46) — which changes no stated measurement, because `available` exceeds 264 at both 768 and 1280 and the `min()` clamps there anyway. A floor ABOVE `available` would pin the QR wider than its box and force exactly the scroll this rule prevents, at exactly the zoom state the wave's own checklist gates: an earlier draft of this row said "216 px floor", which is the DEVICE-pixel reading of the 172 CSS px box and is 44 CSS px too wide. Units are why that row is written out in full. |
| QR encoding | EC-M with a 4-module quiet zone (spec §7.6), payload ≈ 220–300 B, which puts the symbol at version ~10–13. Those two settings, not the pixel width alone, are what decide whether a code at a given size scans; a size rule recorded without them is not a specification. |
| paste code | **Always rendered, at every width, in every one of the three QR sizes** — it is not a fallback that appears when the QR gets small. There is therefore no width at which this state becomes unusable: at 320 @ 125 % zoom the organiser can still type or paste the code even if the 172 CSS px symbol reads poorly on their camera. |
| live | REC pill `bg-red-600 text-white rounded-full px-2.5 py-1 text-[11px] font-semibold` with a breathing 6-px white dot, beside elapsed `font-mono tabular-nums`; health line of three chips `rounded-md bg-slate-100 px-2 py-1 text-[11px] text-slate-700` — `30 fps` · `2.9 Mbps` · `beat 4 s ago`, the beat chip turning `bg-amber-100 text-amber-800` once the heartbeat is older than 45 s; delay nudge `−250 ms` / `+250 ms` `btn btn-ghost` pair, **composed mode only** (absent from the control set in clean feed); "Stop stream" **solid `bg-red-600 text-white`, deliberately NOT `.btn-danger`** — `globals.css`'s `.btn-danger` is `border border-red-200 bg-white text-red-600`, a white outline button, and this is the one irreversible control on a panel that is on air: it is the only solid red in the console and it is meant to be. It opens the repo's confirm dialog. A reviewer reading §8's "the panel follows `globals.css`" should read this row as the stated exception, not a drift |
| ending | pill "Ending…"; every control disabled; copy "Flushing the last seconds to &lt;destination&gt;" |
| ended | summary chips — duration, "1 credit used"; "Watch replay" link when `stream_url` is filled; `btn btn-ghost` "Start another" |
| failed | `rounded-lg border border-red-200 bg-red-50 p-3 text-[13px] text-red-800` carrying the reason copy for `no_inbound_timeout`, `machine_crash`, `target_rejected` (with YouTube's fresh-channel ~24 h note), `storage_exhausted` and `no_credits`; `btn btn-primary` "Try again" |
| phone (320–767) | one column; every control full width and 44 px; page gutter 12, card `p-4`; the stepper collapses to its one line; **identical control SET to 1280** — destination select, "+ Add destination", the two-option radiogroup, the balance chip, the primary action, and per state the QR + paste code + copy, REC + elapsed, the three health chips, the delay pair, Stop stream, Watch replay, Start another, Try again |

**The QR rule supersedes the design spec's `≥ 264 px`, deliberately and only for
the Phone tab.** `2026-09-07-streaming-programme-design.md` §7.6 states
"≈ 220–300 B → QR version ~10–13 at EC-M, **≥ 264 px**, 4-module quiet zone
[A]; manual paste-code fallback". The encoding half of that sentence is what the
`QR encoding` row adopts unchanged. The `≥ 264 px` half **cannot hold on a
phone**: with this panel's own padding, 264 CSS px of `available` needs a
viewport of at least 264 + 2(12 + 1 + 16 + 1 + 12) = **348 CSS px**, so every
width in the project's own 320–430 matrix fails it, and 320 @ 125 % zoom fails
it by more than half. A floor that cannot be met is not a floor; it is a
guaranteed defect report. The sheet therefore rules `min(264px, available)` with
no floor, and leans on the fallback **§7.6 itself provides in the same
sentence** — the manual paste code, which this sheet makes unconditional rather
than a degraded-mode extra.

Two documents must not carry two floors silently, so: **for the Phone tab, the
`QR size` row above is the authority and §7.6's `≥ 264 px` is superseded**;
§7.6 remains the authority for the payload, the version range, EC-M and the
quiet zone. Amending §7.6 itself is Task 4's, not T1a's — this note exists so
that W1 and R1 reading both documents cannot re-derive the floor differently.

**i18n.** Every visible word in this section is new: there are **zero**
`ui.stream.*` keys in any of the four dictionaries today, so the namespace is
empty and the five failure sentences are not the only debt — the state-pill
labels, the four step names, the collapsed "Step 2 of 4 · …" line, the caption,
the health-chip units and every button label are equally new. All of it lands as
`ui.stream.*` in all four locales.

**Card padding.** §8's own panel card keeps `card p-5` at every width; only
§8a's card drops to `p-4` below 768, and only because the QR box lives inside it
and `p-5` would cost the symbol another 8 CSS px at 320. The two tabs are never
side by side, so the difference is not visible to anyone.

## 8b. Credits card (console, light theme)

Inside the Phone tab, replacing its body when the gate says so (spec §5.3).
Picked option A, "Three tiles" (owner 2026-09-08) — three prices on screen is
the whole pricing page for this feature, so nothing is owed on `/pricing` while
streaming is dark and there is no second surface to translate. The unpicked
option B, "Inline row", stays on the design canvas.

| Org state | What renders |
|---|---|
| no `streaming.overlay` / no `streaming.relay` | `UpgradeGate` (`components/upgrade-gate.tsx`), plan href to Pro — **no new design**. Its card is that component's own `rounded-lg border border-purple-200 bg-purple-50 p-4 text-sm text-purple-900`, with the lock glyph, `PlanBadge` and the reason sentence. |
| key, balance 0 | heading "Buy match credits" and explainer "1 match = 1 credit, up to 5 hours"; three tiles in `grid grid-cols-1 md:grid-cols-3 gap-2`, each `rounded-lg border border-purple-200 p-3 text-left` with pack size `text-lg font-semibold text-slate-800`, price `text-sm text-slate-600` and per-match `text-[11px] text-slate-500`. Packs 1 / 5 / 20 at £6 / £25 / £80 — sandbox placeholders (spec §5.2); real prices are an owner ruling before the GA flip. The 5-pack carries `border-purple-500` and a "Most clubs" chip `bg-purple-100 text-purple-800 rounded-full px-2 text-[10px]`. A tile click goes straight to Checkout; there is no quantity picker. Footnote "Sandbox prices until launch" while dark. |
| balance ≥ 1 | chip "3 credits" `bg-emerald-50 text-emerald-800 rounded-full px-2 py-0.5 text-[11px]` in the Phone tab heading, plus "Buy more" `Link` `text-xs text-purple-700 underline`. The card itself is not rendered at all. |
| phone (320–767) | the tiles stack (`grid-cols-1`), each at least 44 px tall and full width; the heading chip and "Buy more" keep their places in the heading row |

**i18n.** As §8a: every visible word here is new — the heading, the explainer,
the three pack labels, the per-match line, "Most clubs", the balance chip, "Buy
more" and the sandbox footnote — and lands as `ui.stream.*` in all four locales.
`UpgradeGate`'s own copy is that component's, unchanged and not this sheet's.

## 9. What each wave takes from this sheet

- **W1:** sections 1, 2, 3, 4, 6 (first three motions), 7, 8. Dictionary keys
  for every visible word here (`public.overlay.*`, `ui.stream.*`) in four
  locales. **Both namespaces are empty today** — a grep across all four
  dictionaries returns zero `public.overlay.*` and zero `ui.stream.*` keys — so
  there is no "mostly done" here: every word in §4a, §8a and §8b is new, and
  each of those sections states its own namespace and its own owed line.
- **W2:** section 5, the slab row of section 6, the W2 cells of section 3
  (cricket detail band), Barlow 800.
- **T1:** sections 2 (new rows), 4a, 8a, 8b, the decided/void rows.
- **R1:** 8a, 8b.
- **R2:** 4a.

Visual sign-off per screen uses these values as the checklist: the reviewer
measures the shipped DOM (`getComputedStyle`) at 1920×1080 against sections
3 to 6 and records each deviation, rather than judging by eye.
