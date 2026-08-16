# R6 — Period pair: hockey, ice hockey

Read `_RULES.md`, `_INDEX.md`, spec §3 rows, §8, §11 (clock). Scout re-pins;
v2 shared skin `skins/period-skin.tsx` (857 lines). Each sport gets its OWN
file; a `period-shared.ts` helper lib is allowed.

**Task:** Two `SkinDefV3`s (tapModel **T**). The LCD identity STAYS (owner's
one KEEP from v2 — ICE-03 verdict) and generalises: scorebug halves = side
scores; strip = period · clock · PP countdown (suspension countdown kept —
it was one of S13's five recovered behaviours).

**Kill the always-open goal form (D-8):** Goal is a tile; person/kind land
via the dock; nothing renders a resting validation error. Person chips wrap,
never clip (D-9). **Clock (D-10, spec §11):** decide in-session between
elapsed-derived display and scorer-controlled clock — W4a's time model is
the input; record the ruling in `_INDEX.md`. Discipline: hockey Card tile
(green/yellow/red — FIH cards REDUCE the offender, nobody gains) vs
icehockey Penalty tile (mins + person via dock); the escalation hint and its
translations exist since S13 — reuse, don't remint. Rolling subs recordable
via Swap-sheet (optional at club level — presence, not enforcement).

**Owner-call item (HOC-04b):** card-flow presentation gets an explicit
walkthrough verdict.

**Register rows owed:** D-8, D-9, D-10.

**Acceptance:** registry flips both (mutation-proved); period-skin deleted,
`git grep -a` zero refs; e2e — goal+scorer, penalty with countdown visible,
hockey card escalation, both sports; unit incl. clock-ruling regression;
smoke deferred to R8; screenshots ×3; axe (this family carried the worst v2
contrast fails); **gallery + walkthrough sign-off recorded before merge**.

## Inherited from R2 (cricket, the first conversion) — do not re-derive

- **Implement `phase?(view)`.** R2 added it so tiles gate on the MATCH rather
  than a user-clicked tab; it is OPT-IN, so a skin that omits it silently
  keeps the tab-shaped behaviour D-16 describes. Map a richer engine phase
  DOWN to the three `PadPhase` values inside your own `phase()` body — never
  widen the type, and never give a mid-match sub-phase its own slot.
- **Two chassis capabilities exist — use them.** `GuidedSheetStep.when(answers)`
  skips a step without a tap, and `SheetPersonStep.candidates` supersedes the
  pool when the skin knows the exact legal people. Both are generic; they were
  built for cricket's wicket flow so ONE tile can open a flow that asks only
  what varies, instead of fanning out into a wall of tiles.
- **`sheets` is a METHOD of the view**, not a static record — the host rebuilds
  it per render so a closed-over view cannot go stale.
- **A skin that needs a translator is a FACTORY**: `(t) => SkinDefV3`, called
  once with a real `t` when it is registered. `ScorebugSpec.context`,
  `WhoLine.name` and `DockSpec.title` are pre-resolved TEXT, and no
  `SkinDefV3` method receives `t`.
- **The context strip does NOT persist through the engine.** Cricket has no
  event that records a striker/bowler pick, so the HOST holds pending
  selections and feeds them back through `PadHostView.contextOverrides`; a
  skin reads override-or-fold. The whole map clears when a new event lands.
  `contextSelect` remains on the contract for a sport whose engine genuinely
  CAN persist the pick — use it only then.
- **The recording chip needs a real `fidelityEntitlements`** from your module,
  or it renders an upsell for a band nothing gates. Cricket declares
  `{2: "stats.player", 3: "scoring.ball_by_ball"}`.
- **`WhoLine.servingLabel` must be supplied wherever you set `serving`** — the
  chassis renders a pre-localised label the SKIN provides, and with `serving`
  true and no label the screen-reader cue is silently absent.
- **Ribbon keys go into `PAD_LABEL_KEYS`** (`lib/scoring-vocab.ts`), not only
  into the four dictionaries — otherwise ribbon copy stays on the generic
  fallback forever with nothing failing.
- **Your conversion breaks e2e.** Grep `apps/web/e2e/` for the v2 selectors and
  text of the sport you are converting BEFORE you start, and check
  `gallery.capture.ts` too — its per-sport `scoreOne` drives the very controls
  a conversion deletes, and it is the tool the sign-off gate runs on.
