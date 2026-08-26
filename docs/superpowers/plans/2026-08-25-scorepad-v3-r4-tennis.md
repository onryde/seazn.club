# R4 — tennis skin: the build spec

Written by the main thread after scouting, BEFORE the skin exists. Everything
here is a decision, not a prediction — where a line is a prediction it says so.
Read `_RULES.md` → `_INDEX.md` (R4 sections) → `R4-tennis.md` first.

Pins are against `origin/main` `9080cb959`. **Re-pin before editing.**

## 0. What is already true (do not rebuild)

- Chassis carries tap model S unused: `ScorebugHalf.tappable` + `tapEvent`
  (`v3/types.ts:91-92`), enforced by `assertScorebugSpec` (`:1050-1058` —
  tappable REQUIRES `hintKey` AND `tapEvent`), rendered as a real `<button>`
  by `scorebug.tsx:150-155`. R4 is the first consumer.
- Palette landed (`01b3723db`): `SPORT_PALETTES.tennis`, hardcourt.
- Tennis declares real `fidelityEntitlements: {3: "scoring.rally_by_rally"}`.
- Engine bands: `set_summary` 0 · `sanction`/`interruption` 1 ·
  `point`/`game.award` 3. Band 2 unoccupied, deliberately.

## 1. Scorebug

`context` — pre-resolved TEXT (never a key). "Best of 3 · Set 2", plus
"· Tie-break" while `points.kind` is a tiebreak.

`halves: [home, away]`, each:

- `who: WhoLine[]` — **person names from lineup members, never entrant
  labels** (D-6). A pair entrant gives TWO lines. `serving: true` goes on the
  PLAYER, never the side, and `servingLabel` MUST be supplied wherever
  `serving` is set (R1's standing item; this is the wave where it bites — with
  `serving` true and no label the screen-reader cue is silently absent).
- `big` — the points as tennis words them: `0/15/30/40/AD`, or the raw
  tiebreak count while in a tiebreak.
- `tappable` — true iff phase is live AND the active band is 3. **Below band 3
  the halves are NOT buttons**, because `tennis.point` is a band-3 event and a
  tappable half at band 0 is a dead-end tap. Withhold above the ACTIVE band,
  not merely the entitled one (R3/B2's finding — `filterTilesByBand` filters
  entitled, `buildPadView` drops above active, and the skin must mirror the
  latter).
- `tapEvent` — `{type: "tennis.point", payload: {by: <entrantId>, server?}}`.
  Carry `server` whenever it is known. This is the point of the wave: the v2
  pad posts `{by}` alone, which is why tennis's ace/double-fault tallies have
  never been feedable from the pad.
- `hintKey` — required by the assert whenever tappable.

`strip: StripItem[]` — sets · games · next server · ends-change.

**Ends-change is DERIVED. There is no state field for it** (checked: no
ends-change anywhere in `nested/kernel.ts`). Players change ends after the
1st game of a set and after every 2 games thereafter — i.e. whenever the set's
completed-game total is ODD — and every 6 points inside a tiebreak. Compute it;
do not invent a state field, and do not send anything for it.

## 2. `phase(view)`

`NestedState.phase` is `pre | live | done | final | abandoned` (`kernel.ts:393`).
Map DOWN to the three `PadPhase` values: `pre → pre`, `live → live`,
`done|final|abandoned → post`. Never widen `PadPhase`, never give a sub-phase
its own slot. The kernel already collapses the last three pairwise at
`:1143`/`:1155` — mirror that, do not invent a fourth reading.

## 3. Tiles, and how D-16 actually closes

| tile | event | band | gate |
|---|---|---|---|
| Set score | `tennis.set_summary` | 0 | **withheld while `setInProgress`** |
| Code violation | `tennis.sanction` | 1 | live |
| Interruption | `tennis.interruption` | 1 | live |
| Award game | `tennis.game.award` | 3 | live, and NOT while `points.kind` is a tiebreak/match-tiebreak (the engine gates it at `:1410-1458` — mirror the gate) |
| More | generic | — | chassis |

**D-16 is a dead-end tap, not a layout complaint.** `applySetSummary` already
refuses a summary for a set being scored point-by-point
(`kernel.ts:1053-1055`), so today's mid-game Set-score tile 422s. Closing the
row means BOTH:

1. the tile is withheld while the set is in progress, and
2. `refusedEventTypes(view)` lists `tennis.set_summary` in that state, so the
   generic More sheet does not offer the same refused action a second time.

Exclusion is PER SET, not per match — a match may legally mix summary sets and
point-scored sets, unlike cricket's per-innings lock. Do not copy cricket's
wording.

**No Fault tile, no Let tile, no Retire tile** — rulings R4-1 and R4-2.

## 4. The point dock — the wave's real product value

`NestedPointMeta.kind` is `ace | double_fault | winner | ue`
(`kernel.ts:200-205`), already optional on every point, and
`NestedPersonTally` already folds ace and double-fault counts crediting the
SERVER. Nothing in v2 can send it. Four chips on `tennis.point`, each mutating
`meta.kind`.

Two rules, both load-bearing:

- **Legality by side.** An ace is won BY the server; a double fault is won by
  the RECEIVER. So `ace` is offered only when the point's `by` is the serving
  side, `double_fault` only when it is not, and `winner`/`ue` always. Read this
  from the PAYLOAD (`payload.server` + `payload.by`), never from the live view
  — by the time the dock renders, the fold has already advanced past the point.
- **One-way, and the alternatives leave.** `DockChip` has no exclusivity
  concept (`{id,label,labelText?,kind?,mutate}`) and the chassis marks a chip
  selected on tap with no inverse (R1: second tap is a no-op). Four
  simultaneously-selectable chips writing one field would show two selected
  while the payload held the last. So once a kind lands, `buildDock` returns
  ONLY the chosen chip. This uses R3's `setSpec` + `dockStore` mirror
  (`0b709fadd`) — the mechanism that makes a dock re-invoke with the ADVANCED
  payload. **That mechanism is the thing that shipped inert in R3 and no unit
  test could see it. The e2e must tap a chip and assert the DRAINED payload.**

Recorded limit: a mis-tapped shot type cannot be corrected inside the ~6s
window; the correction is undo (`core.void`), which the fold replays. Same
posture as every other dock in this pad.

## 5. Sheets

Guided sheets (`choice | person | number` steps only — there is NO text step):

- **Set score** — home games, away games, plus tiebreak points when the score
  is the `tiebreakAt+1 : tiebreakAt` shape (the engine REQUIRES `tb` there in
  strict mode, `kernel.ts:1081-1087`). Use `when(answers)` so the tb step is
  skipped when the shape does not call for it.
- **Code violation** — level (4 options: warning / point penalty / game penalty
  / default), then person, `candidates` narrowed to the offending side's own
  players. `NestedSanction.reason` is FREE TEXT and there is no text step, so
  it is not collected from the pad; say so in a comment rather than inventing a
  choice list, and note that `by` names the OFFENDER (the engine's convention —
  `game.award.winner` is the opposite party, `:336-343`).
- **Interruption** — kind (medical / toilet / heat / other), side, person, and
  duration as a `number` step. `person` REQUIRES `by` (enforced in
  `applyInterruption`, not in the schema) — gate the step accordingly or the
  tap dead-ends.

## 6. Copy

Ribbon keys `pad.tennis.ribbon.*` ×4 (the brief says ×4 keys; author what the
five event types actually need). **Ribbon bases take NO vars** — `buildRibbon`
calls `padLabel(key, t, eventType)` with none, so a placeholder renders
literally and nothing fails. The skin supplies `detail` through
`activityDetail`.

Every new key goes into all four dictionaries AND `PAD_LABEL_KEYS`
(`lib/scoring-vocab.ts` — tennis already has 12 there at `:853-864`), then
`npm run i18n:gen-keys`. A ribbon key that is only in the dictionaries stays on
the generic fallback forever with nothing failing.

## 7. Registry flip

`V3_SKINS.tennis = tennisSkinV3` AND `CONVERTED_SPORTS.add("tennis")` in the
same change (`v3/registry.ts:71-78`, `:99`). Mutation-prove the flip: removing
either half must red a test.

## 8. Tests owed

- Unit: serve-rotation builder against `pairOrder`; the `eventType` ↔ built
  event pin; D-16 gating; dock legality by side; the band floor.
- e2e: singles AND doubles. Serve-dot assertion anchored on `="` (React
  serialises an omitted prop as `"$undefined"`, so a bare `data-*` probe passes
  in both states). Deuce alternation. A dock chip tapped and asserted in the
  DRAINED payload.
- Existing specs that WILL break on the flip, all four found by grep:
  `scorepad-skins.spec.ts:211`, `v6-sports.spec.ts:108,213`,
  `scoring-vocab-labels.spec.ts:191`, plus `gallery.capture.ts:783` (tennis)
  and `:800` (tennis-doubles) — both `scoreOne`s click the v2 one-tap "Home"
  button that this conversion deletes.
- Gallery: the five shared states never open a sheet or a dock, so the doubles
  serve pip and the sanction sheet need their own `EXTRA_STATES` entries or the
  sign-off gate pictures nothing this wave changed. **Capture a band-3 fixture**
  — at band 0 the halves are not tappable and the sheet would picture a board
  nobody can tap.
- Smoke: deferred to R8 by name, in the PR body.

## 9. The doubles fixture cannot declare a serve order yet — fix the SEEDER first

Found while scoping the e2e task, and it invalidates the wave's headline
assertion if it is not fixed first.

`expectedDoublesServer` answers `null` unless the team sheet declared a
`pairOrder`. That posture is correct and deliberate (`squad-state.ts:103-104`,
"a side that declared no order at all returns empty rather than guessing") and
it holds all the way down: `LineupSlot.pairOrder` is
`z.number().int().positive().optional()` (`core/types.ts:222`) and
`lineup.ts:354` omits the key entirely when it is absent, so an undeclared
partner is filtered out of `pairOrderOf` rather than defaulting to 0.

**But no e2e or gallery fixture can declare one.** `RosterSlotSpec`
(`e2e/helpers.ts:1015-1025`) carries `fullName`, `positionKey` and `slot` — no
pair order — and `seedRosteredFixture`'s lineup PUT (`:1147-1153`) sends
`person_id`/`slot`/`order_no`/`roles`/`position_key` and nothing else. So every
doubles fixture this wave captures or drives would seed a pair with no declared
order, `expectedDoublesServer` would return `null` for both sides, and:

- the gallery's `tennis-doubles` screens — **the ones the owner has to verdict
  specifically, by name, per the brief** — would show NO serve pip at all,
  which is the wave's entire headline feature missing from its own sign-off
  sheet, indistinguishable from a defect;
- the doubles e2e's serve-dot assertion would be vacuous, or would have to
  assert the pip's ABSENCE and pass for the wrong reason.

The API side already supports it: `schemas.ts:941` declares
`pair_order: z.number().int().positive().nullish()`, and the lineup editor
already sends it through `toPutSlot(s, i, pairShaped)`. So the fix is small and
belongs BEFORE the e2e and gallery work, not inside it:

1. add `pairOrder?: number` to `RosterSlotSpec`, doc-commented the way `slot`
   already is (every existing caller omits it and stays byte-identical);
2. pass `...(s.pairOrder === undefined ? {} : { pair_order: s.pairOrder })`
   in the lineup PUT — spread-omit, never send an explicit `null`, so an
   individual-entrant fixture keeps declaring nothing;
3. give both gallery doubles rosters an explicit 1 and 2.

Then assert the pip against a KNOWN person rather than "whichever name the pad
happened to mark".
