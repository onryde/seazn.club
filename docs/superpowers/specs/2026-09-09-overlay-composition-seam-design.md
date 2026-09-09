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
export type SlotName = "brand" | "moment" | "sponsor";
```

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

Panels register against a **slot name, never a theme id**, so a panel works with
bar, bug, slate, bottle and every theme not yet written — including in the Tier B
cloud compositor, per the programme invariant.

### 4.4 Brand (axis 3)

Branding needs **no new mechanism**. It is:

1. **Tokens** — more custom properties on the overlay root, exactly how
   `sportThemeStyle(sportKey)` already sets the seven `--sport-*` properties.
   Club colours resolve server-side and ride the same channel.
2. **Assets** — a `brand` field on the stage props (mark URL, club name),
   reaching themes and panels through the §4.2 contract that W1 Task 5f already
   widened for `msg`/`sportKey`.

Contrast is not optional here: `_THEMES.md` §2 requires every new
ink-on-background pair to meet 4.5:1 (text) and 3:1 (graphical). **A
club-supplied colour cannot be trusted to clear either.** The brand seam must
either constrain club colour to roles that are contrast-checked at resolve time,
or keep club colour off text entirely. Decide when built; recorded here so it is
not discovered by a customer.

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
not equally cheap. A batting scorecard additionally needs per-player data, and
`player_stat_snapshots` are lazily populated with no write hook. Do not read
"panels are now possible" as "any panel is now a small job".

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

## 9. Open questions for the owner

1. **Club branding vs contrast (§4.4).** Constrain club colour to
   contrast-checked roles, or keep it off text? Affects what can be sold.
2. **Is the brand mark replaceable?** If a club can replace `seazn` with its own
   mark, that is a pricing and attribution decision, not a technical one.
3. **Slate's home.** `2026-09-07-streaming-programme-design.md` §3.5 says slate
   is R2's; `_THEMES.md` §4a treats it as registry entry three; W1 built it on
   2026-09-09 under "fix all". The tree and the programme design now disagree
   and one of them needs correcting.
