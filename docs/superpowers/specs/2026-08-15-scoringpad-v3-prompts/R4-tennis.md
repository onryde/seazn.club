# R4 — Tennis conversion + doubles serve order

Read `_RULES.md`, `_INDEX.md`, spec §2/§3 (tennis row), §8, §9.1. Scout
re-pins; v2 skin `skins/tennis-skin.tsx` (520 lines), kernel
`packages/engine/src/sports/nested/kernel.ts`.

**Task:** Convert tennis to `SkinDefV3` (tapModel **S**): scoreboard halves
ARE the point buttons — pair/player names on the halves (person names from
lineup members, never entrant labels), lime serve dot on the serving PLAYER,
strip = sets · games · next server · ends-change. Fault/Let/Code/Retire minor
row. Phase-aware tiles kill mid-game set-score entry (D-16). Ribbon keys
`pad.tennis.ribbon.*` ×4.

**Engine item (spec §9.1, the programme's ONLY engine work):** the nested
kernel consumes `pairOrder` so serve order within a pair is derivable —
additive, module stays `1.0.0`, expected zero recorded-fold movement (serve
attribution is presentation until a payload carries it). If ANY corpus state
moves: GOLDEN-POLICY pair (red code commit + isolated re-baseline commit).
Engine touched ⇒ conformance + golden replay + engine lint owed.

**Register rows owed:** D-2 (doubles affordances), D-3 (the "2/1 starting"
badge — root-cause it; if the fix lives in the lineup editor, fix it here as
an unplanned fix rather than waiting for R7, it is one counter), D-16, D-6
on this surface.

**Acceptance:** registry flips tennis (mutation-proved); singles AND doubles
e2e (pair entrants, serve-dot assertion anchored `="` per the RSC trap, deuce
alternation); unit incl. serve-rotation builder against `pairOrder`; smoke
deferred to R8; screenshots ×3; axe; **gallery + walkthrough sign-off with
the owner specifically verdicting the doubles screen (their named pain)**.

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
