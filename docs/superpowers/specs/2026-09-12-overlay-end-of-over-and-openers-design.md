# Overlay — end-of-over card + match openers

**Status:** design, owner-approved in session 2026-09-12.  
**Branch / worktree:** `feat/overlay-end-of-over` · `.claude/worktrees/overlay-end-of-over`  
**Authorities this must not contradict:** `_THEMES.md`, `2026-09-05-stream-overlay-design.md`, `2026-09-09-overlay-composition-seam-design.md` (§5.1 end-of-over worked example), W2 moments plan (`2026-09-05-stream-overlay-w2-moments.md`), programme invariant that every score graphic is rendered by `/overlay/fixtures/[id]`.

**Not a new theme.** Two panels / slate enrichments that ride the existing theme registry (bar, bug, slate).

---

## 1. Goal

Give cricket streams two on-air beats that clubs already expect from broadcast:

1. **Match openers** — centered pre-play graphics so a live camera isn’t an empty scorebug while waiting for play.
2. **End-of-over summary** — a short animated card after every completed over, queued so it never fights W2 moment slabs (SIX / OUT / …).

Non-goals for this wave:

- Operator manual show/hide (`control` trigger) — deferred with the composition-seam control channel.
- Takeover batting scorecards / full innings cards.
- Reimplementing the scorebug in the capture app (phone still embeds this route).
- Gating livestream on scoring fidelity (already decided 2026-09-10: show consequence, don’t block).

---

## 2. Decisions locked (2026-09-12)

| # | Decision | Choice |
|---|---|---|
| D1 | End-of-over content | Full cricket card when fine facts exist; **compact** team-level card when coarse |
| D2 | End-of-over timing | Auto on over boundary; hold ~2s; **queue behind** W2 moment slabs |
| D3 | Coarse fidelity | **Degraded/compact** variant — never empty placeholders, never skip entirely when an over completed |
| D4 | End-of-over placement | **Anchored** to the scorebug (beside bug / under bar) — approach B anchored panel |
| D5 | End-of-over full layout | **Split card**: left batters + bowler; right this-over glyphs + over runs |
| D6 | Architecture | Dedicated panel + **shared FIFO** with moment slabs (not a SIX-style slab kind) |
| D7 | Themes for end-of-over | **Bar + Bug only.** Slate is out of scope for this panel (slate is not mid-over live) |
| D8 | Match openers | Sharpened **C**: slate for pre-start; brief **center card on Bar/Bug** after toss until first scoring |
| D9 | Motion | `transform` / `opacity` only; no mount/reconnect replay; `prefers-reduced-motion` = instant show/hide, same hold, same queue |
| D10 | Scorer undo while a graphic is on air | **Retract:** `momentQueue` `sync` folds the current slab/EOO out and drops queued ids that left the live window; **purges every id absent from live from `seen`** (including after a natural ride-out) so an end-of-over can re-fire after undo+recomplete. Scorebug already corrects via fold. |
| D11 | Ended-card top batter / bowler | On the **overlay poll** (`OverlayLiveData.highlights`), derived from the same cricket scorecard fold as crease / EOO — never SSR-only match-centre. Ranking matches match-centre (runs→SR, wickets→economy). Masked / unnamed people are omitted. |

---

## 3. Feature A — Match openers

### 3.1 States

| Phase | Engine / model signal (sketch) | Where | Center copy (shape) |
|---|---|---|---|
| **A1 — Pre-start** | Stream/overlay live enough to show slate warming; no `core.start` (or status still scheduled / not live match) | **Slate** | Headline: team names as **Home vs Away**. Line: toss pending / starting soon (enrich today’s `STARTING SOON` line — prefer naming the fixture over a generic headline alone) |
| **A2 — Toss decided, no scoring** | `cricket.toss` present; `core.start` may be present; **zero** scoring events (no ball, no over-summary) | **Bar or Bug** (whichever is selected) — **center card**, not the slate | “{Team} won the toss and elected to {bat\|bowl}” |
| **A3 — First scoring** | First ball or first coarse over-summary lands | Clear A2 | Normal scorebug; end-of-over (Feature B) applies thereafter |

Slate’s existing **signal lost** and **match ended** rows are unchanged.

### 3.2 A2 lifetime

Dismiss on **whichever comes first**:

- first scoring event, or
- **8 seconds** hold (slightly longer than moment slabs — toss is denser copy)

Never replay A2 on OBS reconnect if scoring has already begun. If reconnect happens still in A2, show once from current projection (data trigger), not from a stored “already shown” client flag that would skip a late-joining browser source forever — prefer **projection purity**: while “toss present && no scoring”, the card is eligible; the stage’s tip/seq gate still prevents replaying *past* boundaries after scoring starts.

### 3.3 Data

Promote into the overlay projection (theme-agnostic), deliberately:

- toss winner side → display name (same side naming as the scorebug)
- `elected`: `bat` | `bowl`
- “has any scoring event” boolean or equivalent derived once server-side / in the model

Consent does not apply to **team** names. Player names are not on the opener cards.

### 3.4 Motion

Same motion budget as moments for A2: in 250 ms → hold → out 250 ms. Slate A1 stays on the existing slate cross-fade rules (`_THEMES.md` §4a).

### 3.5 Why not only slate for A2

Clubs often switch from Slate → Bar when they go live. If the toss result lived only on slate, flipping theme would erase the most useful pre-first-ball sentence. A short Bar/Bug center card survives that flip.

---

## 4. Feature B — End-of-over card

### 4.1 Architecture

- One **anchored panel** registry member, e.g. `endOfOver` (composition seam axis 2).
- Themes that place the live scorebug (**bar**, **bug**) place this panel in the same family as the moment slot (under bar detail band / beside bug).
- **Slate does not place it.** Mid-over never runs under slate’s center headline model.
- Stage owns a **single FIFO** that can carry W2 moment slabs *and* end-of-over cards — never both on screen.

### 4.2 Trigger

Pure **data** trigger on over boundary:

- fine: legal balls / over index advances after a completed over
- coarse: over-summary event lands

Emit **one** queue item per completed over. **Never** on mount or reconnect (OBS opens mid-stream).

### 4.3 Variants (one component)

**Full — split card (D5)** when fine facts are present:

```
[ scorebug ] | End of over N
             | Left: striker R (B), non-striker R (B), bowler O-M-R-W
             | Right: this-over glyphs · over runs
```

**Compact** when those facts are absent (coarse over-by-over):

```
[ scorebug ] | End of over N
             | 8 runs · 142/6
```

If only some fine fields exist, **collapse missing rows** — do not show empty name slots. If too little remains to count as “full”, fall back to compact.

### 4.4 Queue vs moments

If a SIX/OUT (or other moment) is showing or queued for the same tip, the end-of-over card **waits**. Typical last-ball wicket: OUT slab first, then end-of-over.

Hold **2 seconds** (same as moment slabs) so the shared queue stays predictable.

### 4.5 Data (price first)

Composition seam §5.1 still holds: team totals are on the wire; player/ball facts may not be.

Order of work:

1. Promote cricket live facts into the overlay projection (striker, non-striker, bowler figures, `thisOver`, runs in the completed over) — theme-agnostic, consent-resolved names via the public-site path.
2. Panel consumes the projection only — no second fold in the component.

Over runs: from the completed over’s balls (fine) or over-summary payload (coarse). Team total/wickets/overs from existing overlay summary fields.

Establish whether bowler figures come from match-centre cricket live / scorecard fold vs lazily empty `player_stat_snapshots` before promising full card in tests.

### 4.6 Motion

In 250 ms → hold 2 s → out 250 ms. `transform`/`opacity` only. Reduced motion: instant show/hide, same hold, same queue.

---

## 5. Theme matrix

| Graphic | Bar | Bug | Slate |
|---|---|---|---|
| A1 pre-start center | — | — | **yes** (enrich warming) |
| A2 toss center card | **yes** | **yes** | no (use Bar/Bug after theme flip) |
| B end-of-over anchored card | **yes** | **yes** | **no** |
| W2 moment slabs | yes | yes | placement follows composited scorebug |

Cricket’s default theme remains **bar** (`defaultThemeFor`).

---

## 6. i18n

All visible strings are `public.overlay.*` (or slate keys already under `overlay.slate.*`) in **en, es, fr, nl**. No English in components.

Reuse shapes already proven on the match centre where possible (`matchCentre.endOfOver*`) but **do not** bind the overlay to match-centre keys — overlay owns its own keys so a spectator copy change cannot move the broadcast graphic.

Notation (`4`, `W`, `4.0-0-28-2`, CRR) stays notation; titles/labels localise.

---

## 7. Testing

### Openers

- Slate warming with two sides → center shows vs line (not only generic STARTING SOON without names if names are available).
- Toss + no scoring → Bar shows A2 copy with elected bat/bowl; Bug identical eligibility.
- First ball clears A2; reconnect after scoring does not show A2.
- Hold timeout clears A2 without scoring (timer path).

### End-of-over

- Boundary detector: once per completed over; never on mount.
- Compact vs full selection from projection facts; collapsed row when one fine field missing.
- Queue: OUT then end-of-over order.
- Consent-masked batter/bowler names.
- e2e: fine over → full card after any moment; coarse over-summary → compact; reopen mid-stream → no replay.

No snapshot tests — assert what the viewer can see.

---

## 8. Sequencing / implementation waves

Suggested build order (implementation plan will task this):

1. **Projection promotions** shared by A2 and B (toss fields; cricket live / over boundary facts).
2. **Shared queue** widening if W2 moments already own a FIFO — end-of-over becomes a second item kind in the same reducer, or a sibling queue coordinator with one on-screen slot.
3. **Feature A** (slate enrich + A2 center card) — smaller data surface; validates center motion on Bar.
4. **Feature B** (endOfOver panel + compact/full split layouts).

Depends on W2 moments infrastructure where the shared queue already exists on `main` (moments merged). Do not fork a second queue.

---

## 9. Open points (narrow)

1. **Exact A1 headline** — replace `STARTING SOON` with names-as-headline, or keep `STARTING SOON` and put `Home vs Away` on the line only? Default in this spec: **names as the primary center beat**; keep a short status line under (toss pending / kickoff time).
2. **A2 on Bug** — same center treatment as Bar (recommended) vs only Bar. Spec assumes **both**.
3. **Super over** — Feature B fires on completed super-over overs; A2 does not re-fire.

Resolve (1) in implementation plan review if owner wants STARTING SOON retained as the Barlow 96 headline for brand consistency with `_THEMES.md` §4a.

---

## 10. Spec self-review

- No TBD required for build start; §9 items are preference, not blockers.
- Consistent with composition seam: anchored end-of-over; slate for opaque pre-play; data priced before panel.
- Scope is one implementation programme (openers + end-of-over) sharing projection work — not two unrelated specs.
