# R5 — Racquet split: badminton, table tennis, volleyball

Read `_RULES.md`, `_INDEX.md`, spec §3 rows, §8. Scout re-pins; v2 shared
skin `skins/racquet-skin.tsx` (530 lines) dies at the end of this wave.

**Task:** THREE `SkinDefV3`s (all tapModel **S**), one file each:

- **badminton**: halves = players + rally points; strip = games · server ·
  interval hint; serving NEVER renders "—" (D-17) — derive from the setbased
  kernel's server field; Sanctions minor row.
- **tabletennis**: halves + 2-serve rotation in the strip; bo5/bo7 via cfg.
  First-ever browser coverage (D-13) — its e2e is NEW, not adapted.
- **volleyball**: team halves, set points; rotation/server strip; Timeout +
  Sanction tiles; libero surfaced via the Swap-sheet (FIVB once + position
  lock comes from `lineupPolicy` — refusal copy worded).

Pair entrants (badminton/tabletennis doubles kinds) reuse R4's serve-dot
pattern. Ribbon keys per sport ×4 locales. Free-plan state: recording chip
words the lock (D-7's mechanism, this family was the worst offender BAD-03).

**Register rows owed:** D-7 (this surface), D-13 (tabletennis half), D-17.

**Acceptance:** registry flips all three (mutation-proved); racquet-skin
file DELETED with zero references (`git grep -a` proof); per-sport e2e —
badminton rally to interval, tabletennis rally + rotation, volleyball rally +
set close + libero swap refusal; unit; smoke deferred to R8; screenshots ×3
each; axe each; **gallery + walkthrough sign-off recorded before merge**.

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
