# R3 — Football conversion (owner priority 2)

Read `_RULES.md`, `_INDEX.md`, spec §2/§3 (football row), §8. Scout re-pins;
v2 skin `skins/football-skin.tsx` (711 lines at capture).

**Task:** Convert football to `SkinDefV3` (tapModel **T**): night scorebug
(side scores; strip = half · clock if the view carries one), per-side tile
columns Goal / Card / Sub, Pen minor. Goal commits side-level instantly
(engine scorer/assist fields are optional — honest), dock asks scorer →
assist chips (band ≥2). Card tile → colour choice inline (yellow/red), person
via dock. **Sub via the Swap-sheet primitive** — `football.sub`, cap +
re-entry from the module's own `lineupPolicy(cfg)`, refusal copy worded
("3 of 3 subs used"). Small-sided/youth/mini variants shrink via cfg only.
Ribbon keys `pad.football.ribbon.*` ×4 locales.

**Owner-call item from the gallery (FOO-04):** present the old modal vs the
new dock flow in the walkthrough explicitly — the owner reserved judgment.

**Register rows owed:** D-4/D-5 on this surface; bench members must be
seedable for the sub e2e (`RosterSlotSpec.slot:"bench"` exists in helpers).

**Do NOT touch:** engine, other skins, console chrome.

**Acceptance:** registry flips football (mutation-proved); every
`football.*` type reachable; e2e — goal+assist, card, and a SUB with cap
exhaustion refusal, real rosters incl. bench; unit + regression; smoke
deferred to R8 (PR body); screenshots ×3 widths; axe; **gallery + walkthrough
sign-off recorded before merge**.

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
