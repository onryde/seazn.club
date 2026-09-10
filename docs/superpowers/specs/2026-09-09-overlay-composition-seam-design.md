# Overlay composition seam — themes, panels, branding

**Status:** design, owner-delegated 2026-09-09 ("as a product owner, Staff
Engineer and Design Pattern and Alg expert, you can decide"). Approach **B**
picked by the owner over the author's recommendation of C; §3 explains why both
turned out to be right, for different things.

**Not W1.** W1 (`2026-09-05-stream-overlay-w1.md`) is mid-flight with Tasks 6–8
unstarted. Nothing here lands in W1. §8 says where it does land.

**Authorities this design must not contradict:** `_THEMES.md` (binding values),
`2026-09-07-streaming-programme-design.md` §3.5 (the registry), and the
programme's one invariant:

> Every pixel of score graphics on every tier is rendered by
> `/overlay/fixtures/[id]` and its theme registry. The cloud compositor is a
> customer of that route, never a second renderer. A theme, a W2 moment, a PR3
> sponsor logo lands once and appears everywhere.

## 1. The problem

The overlay can grow new **themes** cheaply and cannot grow anything else. The
question put by the owner was "can we fit any future design?" — the honest
answer was no, and the reason is that "theme" has been carrying three different
jobs' worth of expectation.

Competitor scan (2026-09-09; CrickPro's pages were 403 to direct fetch, so this
is from search summaries and is labelled as such): CrickPro advertises **17+
themes and ~50 panels** — batting and bowling scorecards, player profiles,
celebrations, charts, tournament leaderboards, sponsor panels — plus per-club
customisation of colours, logos and fonts. CricHeroes' own claim is vaguer
("templates already designed, and you can also customize them").

The important observation is not the counts. It is that **a batting scorecard is
not a theme, and no amount of theme-registry work produces one.** Three
independent axes are in play:

| Axis | What varies | Today |
|---|---|---|
| 1. **Theme** | how the scorebug looks | `OVERLAY_THEMES` — bar, bug, slate. Proven. |
| 2. **Panel** | *which other graphics exist at all* | one stage-rendered `ovl-moment-slot`, empty |
| 3. **Brand** | whose colours, logo, sponsor | per-**sport** palettes only; no logo anywhere |

Axis 1 is done and is not the bottleneck. **Axis 2 is where "anything fits"
actually lives.**

## 2. Goal and non-goals

**Goal.** Make axes 2 and 3 expressible, so a future graphic is a registry entry
rather than a redesign — and do it before more themes ship assumptions that have
to be retrofitted.

**Ships now (§8):** the slot contract, the panel registry with one real member,
and the brand seam. **Designed, not built:** takeover panels, the operator
control channel, sponsor rotation.

**Non-goals, explicitly:**
- **Multi-fixture designs.** Owner ruled these out ("I am not talking about
  multi match streaming"). `OverlayModel.sides` stays `[home, away]`. A ticker
  or leaderboard needs a second projection and is out of scope.
- **A theme declaring its own canvas.** Raised, then withdrawn by the owner. The
  canvas stays 1920×1080. (§7 still fixes the fact that it is hardcoded twice.)
- Any change to `OverlayModel`'s theme-agnosticism (§4.1).

## 3. Two kinds of panel — why B and C were both right

The owner picked approach B (themes own named slots) over the author's
recommendation of C (panels as stage-rendered siblings). Building it out showed
the disagreement was really a missing distinction:

- **Anchored panels** belong to the scorebug's composition. A moment slab sits
  beside the score; the brand mark sits inside the frame. When a theme
  rearranges, these must move with it. **The theme places them — approach B.**
- **Takeover panels** do not. A batting scorecard, a leaderboard or a player
  profile occupies the canvas on its own terms and is indifferent to where the
  scorebug is. **The canvas places them — approach C.**

Forcing both through one mechanism is what made every single-mechanism option
feel like a compromise: B alone imposes an N×M cost on graphics that never
needed theme placement, and C alone denies theme placement to the graphics that
do need it — which is precisely the "bottle rearranges its moments" case the
owner asked for.

So: **two kinds, one registry, one field distinguishes them.**

## 4. Contracts

### 4.1 What does NOT change

`OverlayModel` stays **theme-agnostic**. `theme-registry.ts` already says why,
and it is load-bearing:

> the projection is theme-agnostic, which is what lets eleven sports and N
> themes meet in one model

Panels needing data the model does not carry get it the same way themes do — by
a field being **promoted into the projection deliberately**, one at a time. No
panel gets raw access to the underlying payload. Two graphics deriving the same
fact independently is the "one authority per fact" violation that produced this
programme's decided/void defect, where the footer read `outcome` and the header
read `status` and they disagreed on screen.

### 4.2 Slots

```ts
export type SlotName = "brand" | "clubMark" | "moment" | "sponsor";
```

`brand` and `clubMark` are **two slots, not one** (owner, 2026-09-09 — §4.4).
The seazn watermark is permanent; a club mark is additional and never displaces
it. Modelling them as one replaceable slot would make "the club has a logo"
and "seazn is unattributed" the same state, which is exactly the state the
owner ruled out.

A closed union, for the reason `ThemeId` is a closed union: a typo becomes a
compile error rather than a silently-missing graphic.

Theme entries declare which slots they place:

```ts
export interface OverlayThemeDef {
  id: ThemeId;
  labelKey: string;
  component: ComponentType<OverlayThemeProps>;
  sports: "all" | readonly string[];
  /** Slots this theme positions ITSELF. Any slot not listed is rendered by
   *  the stage in its default position. Opt-in: a theme that declares nothing
   *  still gets every panel, just not where it chose. */
  places?: readonly SlotName[];
}
```

and receive their content by name:

```ts
export interface OverlayThemeProps {
  model: OverlayModel;
  tick: [boolean, boolean];
  msg: OverlayMsg;
  sportKey: string;
  slots: Readonly<Partial<Record<SlotName, ReactNode>>>;   // NEW
}
```

**This is what removes B's N×M cost.** A new slot does not touch any theme: the
stage renders it in the default position for every theme that has not opted in.
A theme opts in only when its design demands different placement — which is
exactly bottle's case and no one else's.

**The declaration must not drift from the render.** `places` says a theme
positions a slot; nothing structurally forces it to. §6 pins this with a test
per theme per declared slot, because a theme that declares `moment` and then
never renders `slots.moment` would silently drop the graphic — an absent symptom
that reads as "no moment happened", which is failure class 6 in this repo.

### 4.3 Panels

```ts
export interface PanelDef {
  id: string;
  component: ComponentType<OverlayPanelProps>;
  /** Anchored → placed by the theme via its slot. Takeover → placed on the
   *  canvas, independent of the theme (§3). */
  kind: "anchored" | "takeover";
  /** Anchored only: which slot it renders into. */
  slot?: SlotName;
  /** What makes it visible. Only "data" is implemented (§5). */
  trigger: PanelTrigger;
}

export const OVERLAY_PANELS: Record<string, PanelDef>;
```

A panel receives the same contract a theme does, minus the slots it cannot fill:

```ts
export interface OverlayPanelProps {
  model: OverlayModel;
  msg: OverlayMsg;
  sportKey: string;
  brand: OverlayBrand;
}
```

**Deliberately the same `msg` instance the stage builds for `overlayModel` and
for the theme** — one dictionary channel, not a third. W1 Task 5f established
this shape when it widened the theme props; a panel that resolved its own
dictionary would be a second authority for the same copy.

Panels register against a **slot name, never a theme id**, so a panel works with
bar, bug, slate, bottle and every theme not yet written — including in the Tier B
cloud compositor, per the programme invariant.

### 4.4 Brand (axis 3)

**Owner, 2026-09-09: "we must able to replace our logo easily", "transprent
svg", and — on whether a club mark may displace `seazn` — "no, watermark should
be alway right".**

**Two marks, and only one of them is ours to give away.**

- **`brand` — the seazn watermark. Always rendered, always right-positioned.**
  Not replaceable by a club, not hideable by an entitlement, not a function of
  the club's plan. "Replace our logo easily" is scoped to **us** swapping the
  seazn asset — which is precisely what making it a panel buys, since today it
  is hardcoded three times (§7.2) and a rebrand would mean editing every theme.
  Right-positioning is already what bar and bug do (`.ovl-brand` at the bar's
  right end, the bug header's right), so this ratifies the built behaviour
  rather than changing it.
- **`clubMark` — the club's own mark. Optional, additional, never in the
  `brand` slot.** Entitlement-gated, absent for most clubs.

Modelling these as one replaceable slot would make "this club has a logo" and
"seazn is unattributed" the same state. They are not, and the owner ruled the
second one out.

**Easily means data, not code** — for the club mark, an org-settings change that
takes effect on the next poll: no deploy, no theme edit, no code path per club.

**There is already exactly one authority for this and the panel must reuse it.**
`resolveLogoUrl(logo_storage_path, logo_url)`
(`server/public-site/data.ts:402`) resolves `organizations.logo_storage_path`
ahead of `logo_url`, and the surrounding query already gates both in SQL:

```sql
case when org_has_feature(o.id, 'branding') then o.logo_url end as logo_url,
case when org_has_feature(o.id, 'branding') then o.logo_storage_path end as logo_storage_path
```

The overlay must **not** grow a second resolver or a second gate. A club without
the `branding` entitlement resolves to `null` and the panel falls back to the
`seazn` mark — the fallback is the existing behaviour, so the panel's default
path is also its unbranded path.

**SVG, and specifically `<img>` — never inline `<svg>`.** Transparent SVG is the
right format here: it scales losslessly under the stage's
`transform: scale(...)`, and transparency is mandatory because the mark sits on
the sport's own `board-2` band rather than on white. But an SVG is a document,
and a club-uploaded one can carry script. Referencing it through `<img src>`
does not execute embedded script; inlining it does. **This is a hard rule, not a
preference** — the overlay is served from our origin and a stored-XSS here would
run in a page that other clubs' operators open.

Three consequences to settle when built, recorded now rather than discovered by
a customer:

1. **Legibility is the club's problem but our failure.** A dark mark on a dark
   `board-2` disappears. `_THEMES.md` §2's floors (4.5:1 text, 3:1 graphical)
   cannot be enforced against arbitrary artwork. Options are a constrained
   plate behind the mark, or a documented "supply a light-on-transparent mark"
   rule with a preview in the panel that shows it against all eleven palettes.
   Prefer the plate: it is enforceable, and a rule nobody reads is not a control.
2. **A broken or slow asset must never blank the frame.** The mark is on a live
   broadcast. Failure falls back to the `seazn` mark, the same as unbranded.
3. **CSP and the image host.** `proxy.ts`'s CSP governs what the overlay may
   load. Storage-served marks need an allowance; that file is on W1's
   do-not-touch list and this change is not W1, but the wave that builds this
   owns the CSP edit and its own test.

**Colour tokens are the second half of axis 3 and are NOT settled.** Club
colours would ride the same channel `sportThemeStyle(sportKey)` uses — more
custom properties on the root — but a club-supplied colour cannot be trusted to
clear §2's floors either, and unlike a logo it can land on text. §9 keeps this
open; the logo ships without it.

## 5. Visibility

```ts
type PanelTrigger =
  | { on: "data"; when: (m: OverlayModel) => boolean }   // implemented
  | { on: "timer"; everyMs: number }                     // designed
  | { on: "control"; command: string };                  // designed
```

- **`data`** is a pure function of the model — testable, deterministic,
  no new infrastructure. W2's moments are this shape.
- **`timer`** is a rotation (sponsor every N seconds). Cheap, but nothing needs
  it until PR3.
- **`control`** is "the operator shows the batting card now", and **it is the
  expensive one**. There is no channel from the organiser panel to a running OBS
  browser source today. It needs a real transport and is a wave of its own, not
  a field in a registry.

**Stating the cost plainly:** the panel *seam* is cheap; individual panels are
not equally cheap. Do not read "panels are now possible" as "any panel is now a
small job".

### 5.1 Worked example — the end-of-over card

Owner question, 2026-09-10: *"Do we display who is bowling, each ball and player
stat end of the over for few seconds? or can we extend such as feature later
on"*. It is the clearest case of the distinction above, so it is recorded here
rather than rediscovered in W2.

**Already specified.** `_THEMES.md` §3's cricket row splits it by wave:

> **W2:** striker\* R (B), non-striker R (B), bowler O-M-R-W, "This over 1 4 W 0 2"
> **W1:** chase line "Need 45 off 45", CRR, RRR

So W1 ships the chase line only, and the bowler/ball-by-ball content is W2's by
design, not an omission.

**The rendering is genuinely cheap.** "Appears at the end of the over, holds for
a few seconds, retires itself" is an **anchored panel with a `data` trigger** —
`{ on: "data", when: m => …over boundary… }`, one `OVERLAY_PANELS` entry and one
component. No new theme, no route change, and it inherits every theme including
ones not yet written. This is exactly what the seam is for.

**The data is not there, and that is the whole cost.** Measured against the live
endpoint for an in-play cricket fixture on 2026-09-10 —
`GET /api/v1/public/fixtures/:id/overlay` returns, in full:

```
summary.detail.innings[] → runs, wickets, legalBalls, declared, closed, entrantId
cricket.innings[]        → runs, wickets, legalBalls, ballsLimit
```

**No bowler. No striker. No per-ball log. No player identity of any kind.** The
projection carries team-level innings figures and stops there, and `OverlayModel`
has no field that could hold a player.

So the order of work is fixed, and it is the reverse of how the feature reads:

1. Promote per-player and per-ball facts into the projection — deliberately, one
   at a time, keeping it theme-agnostic (§4.1). This is the expensive half.
2. *Then* the panel is a registry entry.

**One trap waiting at step 1:** `player_stat_snapshots` are **lazily populated
with no write hook**, so "the per-player numbers are already in the database" is
not true in the way it sounds. Whoever builds this must establish where the
bowler's figures actually come from before promising the panel — the engine's
folded state, or a snapshot that may not have been written yet, are different
answers with different costs.

Generalise from it: **for any proposed panel, price the DATA first and the panel
second.** Every gap this programme has hit — football's discipline chips, the
serve dot, tennis's live game points, slate's signal-lost state — was a data gap
wearing a rendering gap's clothes.

### 5.2 Should streaming require band 3? — findings, and a recommendation NOT to

Owner proposal, 2026-09-10: require the top fidelity band for a live stream,
*"otherwise we can block the livestream option"*. (Asked as "Band 4"; the scale
is closed at 0–3 by the v2 ruling, so the top band is **3 — `detail`**.)

**This is recorded as a PROPOSAL with an author's recommendation against it. It
is NOT a ruling, and the decision is open.**

The instinct is sound: a band-0 stream produces a nearly empty overlay, and that
reflects on us rather than on the club. Three findings argue for a different
remedy.

**1. The band is derived, not chosen — so there is nothing to gate on.**
`effectiveBand` (`server/public-site/match-centre.ts:867`) scans the ledger and
takes the **maximum** band of any event type recorded so far. Nothing is stored:
no `fidelity` or `band` column exists anywhere in the schema (checked
`information_schema.columns`, 2026-09-10).

**2. Before the match there is no band at all.** `effectiveBand` returns `null`
for an empty ledger, and the comment is explicit that this is "a genuinely empty
ledger", not a zero. So a gate evaluated when the organiser presses "go live"
reads `null` — the one moment it would need a number.

**3. It is a maximum, not a floor.** One detailed event lifts the whole match to
band 3 while everything around it stays coarse; `band` starts at 0 and "only
ever rises". As a gate it is satisfied by a single tap and therefore says almost
nothing about what the overlay will actually have to show.

**And it reverses a shipped decision.** `sport/module.ts:90-95` states that since
entitlements v18 (2026-09) the band "is a UX filter only… **No band is paywalled
and nothing in `apps/web` reads an entitlement from it**", and
`server/usecases/event-import.ts:243` records that the previous fidelity-band
gate (`requiredFeatureForEvent`) "is deleted". Re-introducing one re-paywalls
something deliberately un-paywalled weeks earlier.

**Recommendation: show the consequence, do not block it.** Put the trade in the
organiser panel, where it is actionable:

> Scoring at "result" — your stream will show the score only. Score ball-by-ball
> to show the bowler and this over.

Owner value: the pull toward richer scoring without losing a stream, without a
support queue of "why won't it let me go live", and without reversing v18. A club
that wants only the score on screen is still a satisfied customer — that is
exactly what the competitor's basic ticker is (§1).

It also composes with §5.1: a panel whose data is absent simply does not fire.
**The overlay degrades by showing less, never by refusing to start** — which
matters more here than anywhere else in the product, because the failure mode is
a club that cannot go live in front of an audience.

If a hard gate is wanted anyway, the only implementable form is **post-hoc**:
let the stream start, then warn once N events have landed and the derived band
is still 0. Recorded so the shape is known; still not recommended, because it
punishes the club for a choice the *scorer* made, and on a matchday those are
frequently different people on different devices.

## 6. Testing

Standard for this repo — all four types, every change shipping a test that fails
without it — plus three that this design specifically owes:

1. **Slot declaration matches render.** Per theme, per declared slot: render the
   theme with a sentinel in that slot and assert it appears. Mutant: remove the
   `{slots.x}` render while leaving `places` declared — must go red.
2. **Default placement actually happens.** A theme that declares nothing must
   still show every panel. Mutant: drop the stage's default-render branch.
3. **Panels are theme-agnostic.** The same panel, asserted present across every
   registered theme — the N×M guard, and the thing that would rot first.

`apps/web` vitest is `environment: "node"`: it cannot see placement, overlap or
z-order. Slot placement is an **e2e/visual-gate** obligation, not a unit one, and
the visual gate's rows must pair (a single-row group escapes its
"every picture is identical" guard).

## 7. Two defects to fix while here

Both found while reading for this design; neither is caused by it.

1. **The canvas is hardcoded twice** — `overlay-stage.tsx`
   (`Math.min(innerWidth / 1920, innerHeight / 1080)`) and `globals.css:1333`
   (`.ovl-canvas { width: 1920px; height: 1080px }`). Change one and the other
   silently disagrees. One authority, read by both.
2. **The brand mark is hardcoded three times** — bar, bug and slate each emit
   their own `seazn`. §8 removes this by construction.

## 8. What ships, and when

**Not W1.** W1 has Tasks 6–8 outstanding and four fix rounds behind it. This is
a prerequisite for **W2's moments**, so it belongs at the **start of W2**, before
the first moment slab is built — which is the whole point of doing it now rather
than retrofitting.

Shipped in that wave:

1. `SlotName`, `places`, and `slots` on the theme props (§4.2).
2. `OVERLAY_PANELS` with **exactly one real member: the brand mark.**
3. bar, bug and slate stop hardcoding `seazn` and render `slots.brand`; each
   declares `places: ["brand"]`.
4. The §7 canvas de-duplication.

**Why the brand mark is the first panel.** The registry must not ship empty. An
empty registry is an inert seam — code that is typed, tested and reachable by
nothing — which is this repo's failure class 1, recorded as having recurred six
times "despite being named explicitly each time", and which this programme
shipped a seventh instance of on 2026-09-09 (five `overlay.slate.*` keys with no
channel to render them, closed by W1 Task 5f). The brand mark is a graphic that
**already exists, is already duplicated three times, and is already placed
differently by each theme** — so it exercises anchored placement, per-theme
opt-in and the default path on day one, with no new feature and no new copy.

Deferred with named gaps: takeover panels (no consumer yet), `timer` and
`control` triggers (§5), club branding assets (§4.4, needs the contrast ruling).

## 9. Owner answers, and what is still open

**Answered 2026-09-09:**

- **The mark is replaceable, and the format is transparent SVG** (§4.4). It
  reuses the existing `resolveLogoUrl` + `branding` entitlement rather than a
  second path, and is referenced through `<img src>` so a club-uploaded SVG
  cannot execute script.
- **No multi-fixture designs** — `sides` stays a pair (§2).
- **Approach B**, resolved into B-for-anchored / C-for-takeover (§3).

- **Club COLOUR is allowed only in NON-TEXT roles, verified at resolve time**
  (owner: "apply your rec", 2026-09-09). The author had not in fact recorded a
  recommendation for this one and made the call rather than infer a prior
  position: a club colour may drive an accent or a plate, where §2's 3:1
  graphical floor applies and can be computed server-side against the sport's
  own palette; if it fails the check it falls back to the sport token. **Text
  stays on `--sport-ink` unconditionally.** Sellable as "your colours",
  enforceable in code, and it cannot produce unreadable copy.
- **The mark gets a PLATE, not a guideline** (owner: "apply your rec"). A
  constrained plate behind the club mark is enforceable; "supply a
  light-on-transparent mark" is a rule nobody reads, and an unreadable mark on
  a live broadcast is our failure regardless of who supplied the artwork.
- **The seazn watermark always shows, always right; a club mark never displaces
  it** (owner: "no, watermark should be alway right"). Two slots — §4.2, §4.4.

**Still open:**

1. **Does streaming require fidelity band 3? (§5.2)** Owner proposed it
   2026-09-10; the author recommends **not** gating, and recommends showing the
   consequence in the panel instead. Three findings sit behind that: the band is
   derived rather than chosen, it reads `null` before the first event, and it is
   a maximum satisfied by one tap — plus re-gating reverses entitlements v18.
   **No decision taken.**
2. **Slate's home.** `2026-09-07-streaming-programme-design.md` §3.5 says slate
   is R2's; `_THEMES.md` §4a treats it as registry entry three; W1 built it on
   2026-09-09 under "fix all". The tree and the programme design now disagree
   and one of them needs correcting.
