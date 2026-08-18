# R2c Task 1 — candidate narrowing: the chassis capability

Design proposal, 2026-08-17. Answers Task 1 of `R2c-candidate-narrowing.md`
("design and land a way for a skin to narrow a candidate list per slot/step,
evaluated against the CURRENT fold state"). No code written; this is the
proposal the brief asked for while R2b lands.

Read `_RULES.md` then `_INDEX.md` first. The brief this answers is committed
on R2b's branch (`0282a1f2d`), not yet on `main` — it arrives with R2b's
merge.

**R2b MERGED as #610 (`78191611a`, tip `896c8e608`) 2026-08-18.** R2c branches
off `main` `7023502a3` in `.claude/worktrees/r2c-candidates`; the overlap
problem §8 was written to route around is gone.

**Line numbers pinned against `main` `7023502a3`.** They were originally taken
against R2b HEAD `f7e99e805`, which the pre-merge rebase orphaned — but
`git diff f7e99e805 main` over every path this document cites is **empty**, so
each pin is byte-valid as written. Re-pin anyway before editing (`_RULES.md`
§1); later waves will move them.

---

## 0. Summary of what changes

| | Change | Where |
| --- | --- | --- |
| 1 | `ContextSlot.candidates?: readonly string[]` | `v3/types.ts` |
| 2 | `ContextSlot.blocked?: Blocked` | `v3/types.ts` |
| 3 | `SheetChoiceStep.blocked?(answers): Blocked` | `v3/types.ts` |
| 4 | `export type Blocked` — the one shared type | `v3/types.ts` |
| 5 | honour 1+2 in the picker; add `data-*` hooks | `v3/context-strip.tsx` |
| 6 | honour 3 in the choice row; add `data-*` hooks | `v3/guided-sheet.tsx` |
| 7 | export `eligibleBowlers` | `packages/engine/src/sports/cricket/` |
| 8 | export `reviewsRemaining`, de-fork `applyReview` | `packages/engine/src/sports/cricket/cricket.ts` |
| 9 | a `retire` guided sheet; delete the `isEligibleOverBowler` fork | `v3/skins/cricket.tsx` |

Two optional fields and one optional method on the chassis. Ten skins compile
and behave unchanged — every addition is optional and absent-means-today's-
behaviour, the same posture `TileSpec.disabled`, `ContextSlot.message` and
`SheetPersonStep.candidates` already take.

**Nothing is added to `PadSpec`.** §4 records why, and what would have to
change first.

### Rulings taken this session (2026-08-18), for `_INDEX.md`

1. **C2 moves off the engine-declared surface.** `PadSpec` is data-only
   (§1); narrowing it is not additive. Cricket's skin owns Retire instead.
2. **Defect 4's ruling is AMENDED, not overridden by accident.** R2b's
   live-tile audit ruled "DROP the dedicated Retire tile, keep the generic
   More-sheet flow" (`_INDEX.md`, 2026-08-17) because the dedicated tile
   hardcoded `reason: "other"` and scoped its "off" picker to the whole
   batting side, while the generic form at least carried a real reason enum.
   R2c reinstates a Retire tile — but neither original fault survives: the
   new flow is a `GuidedSheetSpec` with the real reason enum AND
   crease-narrowed candidates, and it is still ONE entry point, because
   `dedicatedEventTypes` removes the generic one automatically. The audit
   compared two flawed flows and kept the less-bad one; this is the option
   neither of them was. Owner amended the ruling explicitly, 2026-08-18.
3. **Engine exports are in scope** — authorised by the R2c brief itself
   ("EXPORT it rather than copying… R2b exported `nextBattingSide` for
   exactly this reason"), not a new grant.

---

## 1. The finding that reshapes the brief: two surfaces, not one

The brief's three consumers do not sit on one substrate.

| | Surface | Functions allowed? | Consumers |
| --- | --- | --- | --- |
| **A** | v3 chassis (`v3/types.ts`) | yes — `sheets(view)`/`context(view)` already close over live state | C1 bowler chip, C3 review sheet |
| **B** | engine `PadSpec` → `attribution-picker.tsx` | **no** | C2 generic Retire |

Surface B's constraint is not a convention, it is a shipped invariant
(`packages/engine/src/sport/module.ts:84-95`):

> EVERYTHING BELOW IS DATA — no functions anywhere in the PadSpec tree. […] a
> function value would (a) vanish silently under `JSON.stringify`, which is how
> this file's own conformance suite proves `padSpec(cfg)` is byte-identical for
> a repeated call

So "add a predicate to `PadAttributionItem`" is not an additive change. It
breaks a conformance property that currently cannot fail.

**Ruling taken (owner, this session): C2 moves off surface B.** Cricket's skin
gains its own `retire` guided sheet, and the generic engine-declared Retire
action stops being reachable. §3.3 has the mechanics.

Consequence: Task 1's capability only ever has to serve surface A, where
closures are already the established idiom. That is why this design is two
fields and a method rather than a new engine DSL.

## 2. The finding that shrinks the brief: the narrowing API already exists

`SheetPersonStep.candidates?: readonly string[]` ships today (G6 ruling,
`v3/types.ts:308-324`):

> `candidates`, when present, SUPERSEDES `pool` entirely — same additive shape
> as `when` above. Exists because `pool` alone cannot express "exactly these
> two people"

Cricket's wicket sheet already uses it for precisely this defect class — the
"who's out" step needs the two batters at the crease, and `pool:"onfield"`
alone offers the whole on-field roster.

So Task 1 is **not** "invent a narrowing mechanism". It is "extend a shipped
one to the two places that lack it", which also discharges the brief's
"do not invent a third mechanism" constraint by not inventing a first one.

## 3. The design

### 3.0 Two operations, because there are two causes

Narrowing has two distinct causes and they want opposite treatments:

- **Scope** — the person is not in question at all (a batter in a bowler
  picker). Nobody expects them; listing eleven of them greyed out is noise on
  a touch-first surface at 320px. → **remove**.
- **Eligibility** — the person is in scope but blocked right now (bowled the
  previous over, at quota, side has no reviews left). This is exactly the case
  the brief warns about: *"a silently shortened list leaves a scorer who
  expected an option with no idea why it is missing"*. → **keep visible,
  disable, and say why**, which is `TileSpec.disabled`'s own shipped ruling
  (`v3/types.ts:139-168`: *"stays fully VISIBLE — never removed"*).

Collapsing these into one mechanism forces a bad answer either way: remove-all
loses the reason, disable-all renders 22 chips of which 20 are dead.

### 3.1 The shared type

```ts
/**
 * Person/option id -> the PRE-LOCALISED reason it is not selectable right
 * now. An ABSENT key means selectable; the map is never exhaustive.
 *
 * Pre-localised, skin-supplied prose — the same rule `WhoLine.servingLabel`,
 * `TileSpec.labelText`, `ContextSlot.message` and `SheetNumberStep.hintText`
 * already establish in this file: the chassis never resolves a
 * sport-namespaced key, and these strings need an interpolated person name
 * or a cfg-derived number baked in. A skin has `t` in scope for this —
 * `cricketSkinV3(t)` (skins/cricket.tsx:1928) closes over it and every
 * builder receives it.
 *
 * A blocked entry is RENDERED, disabled, with its reason beside it — never
 * removed. Removal is what `candidates` is for; see this file's own note on
 * scope vs eligibility.
 */
export type Blocked = Readonly<Record<string, string>>;
```

Named `Blocked` rather than `Disabled` deliberately: `TileSpec.disabled` is a
bare boolean on one tile, and reusing that word for a per-id map invites a
skin author to expect the same shape.

### 3.2 The three chassis additions

```ts
export interface ContextSlot {
  id: string;
  label: string;
  personId?: string;
  pool: "onfield" | "bench" | "all";
  required: boolean;
  readOnly?: boolean;
  message?: string;

  /** SCOPE. When present, SUPERSEDES `pool` entirely — the identical
   *  contract, wording and semantics `SheetPersonStep.candidates` (G6)
   *  already ships, extended to the strip. `pool` stays REQUIRED for every
   *  slot that does not set this, which is still the common case. */
  candidates?: readonly string[];

  /** ELIGIBILITY. Applied AFTER `candidates`/`pool` resolves, so a scope
   *  removal and an eligibility block never fight: a key naming someone
   *  already out of scope is simply never rendered, and is not an error. */
  blocked?: Blocked;
}

export interface SheetChoiceStep {
  id: string;
  kind: "choice";
  title: string;
  options: { id: string; label: string }[];
  when?: StepPredicate;
  hintKey?: string;

  /** ELIGIBILITY, evaluated at RENDER time against the answers accumulated
   *  so far — the same evaluation point and the same single-argument
   *  signature `StepPredicate` (`when`) already uses, for the same reason:
   *  the deciding fact is not known when `sheets(view)` builds the spec.
   *  Absent means every option is selectable. */
  blocked?(answers: Readonly<Record<string, string>>): Blocked;
}
```

`SheetPersonStep` is **unchanged** — it already has `candidates`. If a later
sport needs eligibility blocking on a person step it gains `blocked?: Blocked`
by the same rule, but nothing in R2c needs it, so it is not added (YAGNI).

`ContextSlot` gains no `side` field. The brief names its absence as a defect,
but `candidates` supersedes `pool` outright, so a slot that knows its exact
set never asks the side question — and no consumer in R2c needs side scoping
without also knowing the exact set. One field, not two.

`SheetChoiceStep.blocked` is a method while `ContextSlot.blocked` is a plain
value, and the asymmetry is load-bearing, not sloppiness: a strip slot has no
answers to depend on and is rebuilt every render from live `view`, so a value
is already current. A sheet step is built once per render but read across
several answer transitions within one sheet, so its verdict must be a function
of `answers` or it goes stale mid-wizard.

### 3.3 Per-consumer wiring

**C1 — bowler chip (`skins/cricket.tsx` `buildContext`, ~1576-1586).**

```ts
{
  id: "bowler",
  label: "pad.cricket.context.bowler",
  personId: people.bowler || undefined,
  pool: "onfield",
  required: true,
  candidates: bowlingOrder,                    // SCOPE: fielding side only
  blocked: bowlerBlocked(t, state, people, cfg, view.personNames),
  readOnly: inningsClosed || bowlerReadOnly ? true : undefined,
  message: /* unchanged */,
}
```

`bowlingOrder` is `state.orders[people.bowlingSide]` — already computed inside
`resolvePeople` (skins/cricket.tsx:456) and already the set every other caller
draws from. This alone closes the "BOTH squads" half of C1.

`bowlerBlocked` is new and thin: for each id in `bowlingOrder` not accepted by
the engine's eligibility rule, a reason string. It reuses the *existing*
`bowlerBlockMessage` wording (skins/cricket.tsx:1585) so the picker and the
slot message never word the same fact two ways.

Mid-over (`fine.currentBowler !== null`) the slot is already `readOnly` and the
picker never opens — `blocked` is computed but unreachable, exactly as
`bowlerBlockReason` already short-circuits (skins/cricket.tsx:535).

**C2 — Retire (`skins/cricket.tsx` `sheets`, 1899-1903).**

**A sheet is unreachable without a tile.** `TileSpec.action = {sheet: string}`
is the only thing that opens one, so this reinstates a Retire tile — the half
of defect 4's ruling that is being amended (§0, ruling 2). Phase-aware and
`minor`, matching the other non-ball tiles; it does NOT come back as a
`{swap:true}` tile, and cricket still declares no `swap()` (skins/cricket.tsx:
1908-1914 — SwapSheet stays chassis-only for R3-R7, as R2b recorded).

```ts
retire: {
  event: "cricket.retire",
  steps: [
    { id: "person", kind: "person", title: "…",
      side: people.battingSide, pool: "onfield",
      candidates: [people.striker, people.nonStriker].filter(Boolean) },
    { id: "reason", kind: "choice", title: "…",
      options: [hurt, out, other] },
    { id: "incoming", kind: "person", title: "…",
      side: people.battingSide, pool: "all",
      candidates: /* batting side, not dismissed, not at the crease */ },
  ],
  buildPayload: (a) => ({ person: a.person, reason: a.reason, incoming: a.incoming }),
}
```

Zero new chassis API — `SheetPersonStep.candidates` already does all of it.
The crease is `fine.striker`/`fine.nonStriker`, which is verbatim what the
engine checks (`applyRetire`, cricket.ts:1717-1719) and what `resolvePeople`
already resolves.

**The duplicate-entry-point risk closes itself.** `dedicatedEventTypes`
(pad-host.tsx:141-151) already does:

```ts
if (sheets) for (const spec of Object.values(sheets)) out.add(spec.event);
```

so adding a `retire` sheet whose `event` is `"cricket.retire"` removes it from
the More sheet automatically. No separate suppression change, and no repeat of
the two-divergent-entry-points defect R2b closed by dropping the swap tile
(skins/cricket.tsx:1908-1914).

The engine's `retireAction` (cricket.ts:2628-2636) stays declared and
conformance-covered — it is simply no longer the pad's route to it, the same
relationship every other dedicated tile already has with its More entry.

**C3 — review sheet (`skins/cricket.tsx` `reviewSheet`, 1749-1780).**

```ts
{
  id: "by",
  kind: "choice",
  title: "pad.cricket.sheet.review.by.title",
  options: [ { id: squads.home.entrantId, … }, { id: squads.away.entrantId, … } ],
  blocked: (answers) =>
    answers.kind === "player" ? exhaustedSides(t, state, cfg, squads) : {},
}
```

### 3.4 Renderer changes, and the `data-*` hooks the brief requires

Neither renderer has a per-item hook today — `renderCandidateRow`
(context-strip.tsx:92-117) and `renderChoiceRow` (guided-sheet.tsx:301-325)
both emit bare `<button>`s. Both gain:

- `data-candidate-id` / `data-choice-option-id` — the id, always present.
- `data-blocked="true"` — only on a blocked item.
- a real native `disabled` attribute, plus the reason as **visible text**
  beside the label — never `title`/tooltip (invisible on touch), which the
  brief requires explicitly.

Both stay PLAIN FUNCTIONS, not JSX components: this repo's node-only
`_hook-harness` walks a rendered tree through `.props.children` and never
invokes a nested component's own function, so a `<CandidateRow/>` would make
every button inside it invisible to `walk()`/`textOf()`
(context-strip.tsx:81-91 states this; `renderChoiceRow` inherits it).

Rendering treatment follows the existing disabled vocabulary rather than
inventing one: `TileSpec.disabled`'s native-`disabled`-button precedent, and
`ContextSlot.message`'s `text-red-600` for the reason. Contrast is computed
from tokens before sign-off (`_RULES.md` §5); `text-slate-400` on white
measures ~2.63:1 and is already a known failure in this tree
(attribution-picker.tsx:187-191) — do not reach for it.

## 4. What is deliberately NOT built, and the blocker that decided it

**Not built: a serialisable candidate-filter DSL on `PadSpec`.**

The engine has already solved this exact class once — `PadGate`
(module.ts:141-196): a closed serialisable DSL plus ONE exported evaluator
`evalPadGate`, imported and called by both the engine's own conformance test
and the web renderer, described in its own header as *"the structural fix for
this repo's recurring placer/verifier fork"*. A `PadCandidateFilter` alongside
it is the architecturally correct long-term answer and is what every future
sport would inherit.

**It is blocked on a shared primitive.** The DSL's path reader
`resolvePayloadPath` (`packages/engine/src/stats/stats.ts:42-54`) returns
`undefined` the moment the cursor is an array:

```ts
if (typeof cursor !== "object" || cursor === null || Array.isArray(cursor)) return undefined;
```

Cricket's crease lives at `state.innings[index].fine.striker`. Every gate
shipped in the repo is a shallow top-level scalar — `state.phase`,
`state.expedite`, `state.running`, `state.points.kind` — so nothing has hit
this yet. Reaching a cricket innings needs either array indexing added to a
reader that player-stat metrics also depend on, or an engine-exported flat
projection of "the current innings". Both are their own wave with their own
blast radius, and neither is a sub-task of R2c.

Recorded here so a later session does not re-derive it. If a second sport
needs engine-declared candidate narrowing, this is the first thing to price.

**The wave is already named.** R2's "owed by later waves" (`_INDEX.md`) assigns
`PadAttributionItem` to R8: *"attribution has no required/optional flag, so
nothing can validate it […] The fix is an ENGINE contract change plus a sweep
of all 11 sports' `padSpec` declarations plus conformance and golden replay."*
Same interface, same blast radius, same wave — a candidate filter should land
with that change, not before it.

## 5. Engine exports

The brief's rule: *"Where the engine already owns the rule, EXPORT it rather
than copying."* Two exports are owed.

**5.1 `eligibleBowlers` — export, and delete the skin's fork.**

`eligibleBowlers` (cricket.ts:1825-1836) is private and is exactly
`order.filter(<the skin's isEligibleOverBowler>)` — per element identical:

```ts
if (person === fine.prevOverBowler) return false;
if (maxOversPerBowler === undefined) return true;
return Math.floor((fine.bowlerBalls[person] ?? 0) / ballsPerOver) < maxOversPerBowler;
```

R2b declined this export and mirrored the rule instead, which cost its reviewer
a byte-for-byte verification to trust. C1 needs the *list*, not a per-person
boolean — which is what this function already is. Export it through
`sports/cricket/index.ts`, the same door `nextBattingSide` already uses
(line 20), and delete `isEligibleOverBowler` from the skin.

Note the one asymmetry, already documented in the skin: the engine's THIRD
refusal ground ("not in the fielding lineup", cricket.ts:1205) is not in
`eligibleBowlers` because its callers draw from `bowlingOrder` already. Under
this design `candidates: bowlingOrder` makes that invariant structural for the
picker too, so `bowlerBlockReason`'s separate lineup check stays as the
backstop for a stale override and nothing else.

**5.2 `reviewsRemaining` — new export, and de-fork the engine while we are here.**

The quota rule is **already forked twice inside the engine**:

- `applyReview` (cricket.ts:1805-1807): `ledger[side].lost >= allowance`, and
  only when `payload.kind === "player"`.
- the random-stream generator (cricket.ts:3484-3486): `spent < allowance`.

A third copy in the pad is the recurring bug the brief names. Add:

```ts
export function reviewsRemaining(state: CricketState, side: Side): number | null;
// null = uncapped (cfg.reviews?.perInnings undefined)
```

and route `applyReview` through it in the same commit. The generator's copy is
a nice-to-have — de-fork it if the diff stays small, otherwise name it in the
PR body as owed.

Two subtleties the pad must not lose:
- only `kind === "player"` reviews are capped (cricket.ts:1806) — an umpire
  review is always available;
- only an unsuccessful player review spends one (`outcome === "struck_down"`,
  cricket.ts:1810) — `lost`, not `taken`, is the counter.

## 6. False premise found — Task 4 is not a step-ordering problem

The brief (Task 4) says:

> the side asking for the review is not known until a LATER step of the sheet,
> so the quota cannot be checked when the first step is built. That is a
> step-ordering problem, not a filtering one. If the answer is to reorder the
> sheet's steps, say so and get it ruled before building.

The code disagrees, on three counts:

1. **Both sides' quotas are known at build time.** `innings.reviews[side].lost`
   and `cfg.reviews.perInnings` are both on `view` when `sheets(view)` runs.
   Nothing about the quota waits for an answer.
2. **The only late-bound fact is `kind`, and it is already step 1.** `kind` is
   `reviewSheet`'s first step and `by` is its third (skins/cricket.tsx:
   1754-1780). By the time `by` renders, `answers.kind` exists.
3. **`StepPredicate` already delivers exactly that.** `when?: (answers) =>
   boolean` is the shipped precedent for an answers-dependent step decision;
   `blocked?(answers)` is the same evaluation point with a richer return.

**No reordering. No ruling owed.** `blocked` on the existing `by` step, gated
on `answers.kind === "player"`, is the whole fix — and it is *better* than a
reorder would have been, because a reorder would have had to ask the side
first even for umpire reviews, which are never capped.

Recorded in `_INDEX.md` under premises found false when R2c opens.

## 7. Acceptance and tests

Per `_RULES.md` §5, four types. Every change ships a test that fails without
it; red step first with the real failure message pasted, then mutate the fix
and confirm the right test reds.

**Unit** (`v3/__tests__/`, `environment:"node"` — builders, not DOM):
- `candidates` supersedes `pool` on a `ContextSlot`, and an empty
  `candidates: []` renders the empty-pool text rather than falling back to
  `pool` (the `""`-vs-absent trap `ContextSlot.message` already hit — R2b
  review item 3).
- `blocked` keys naming someone out of scope are ignored, not thrown on.
- `SheetChoiceStep.blocked` is re-evaluated per answer transition, not once.
- cricket: bowler `candidates` is the fielding side only; `blocked` names the
  previous over's bowler and anyone at quota, with the same wording
  `bowlerBlockMessage` produces.
- cricket: retire `person` candidates are exactly striker+nonStriker; assert
  against a ninth-wicket fixture, where `pool:"onfield"` would offer ~9 wrong
  names (the D-15 case G6's own doc cites).
- cricket: review `by` blocked only when `answers.kind === "player"`; a side
  at `lost === allowance` is blocked, `lost === allowance - 1` is not;
  uncapped cfg blocks nobody.
- engine: `eligibleBowlers` export behaves identically to the deleted skin
  fork across the existing fixtures (this is the export's migration proof, and
  it is a real test, not a tautology — it runs the ENGINE function against
  assertions written for the skin one).
- engine: `reviewsRemaining` + `applyReview` agree; `applyReview` still
  refuses at the boundary after being routed through it.

**e2e** (`apps/web/e2e/scorepad-v3-cricket.spec.ts` — already sharded across
three CI jobs on every PR via the `parallel` project's `testIgnore`, so
additions run in CI):
- bowler chip at an over boundary: picker shows fielding side only, the
  previous over's bowler is present-but-`data-blocked="true"` and unclickable,
  with the reason visible as text; picking an eligible name clears the tile
  block.
- Retire via the pad's own sheet offers exactly two names; the More sheet no
  longer lists Retire at all.
- review sheet: `kind=player` blocks a side with no reviews left with the
  reason visible; `kind=umpire` blocks neither.

Assert on `data-*`, never on `title`. Anchor `data-*` probes on `="` — React
serialises an omitted prop as `"$undefined"`, so a bare probe passes in both
states.

**Regression:** the four defects R2b already fixed stay fixed — in particular
`ContextSlot.message: ""` must still render nothing.

**Smoke:** deferred to R8 by name, which already owes cricket smoke (R2b's own
D3). State it in the PR body.

**Widths:** 320/768/1280 screenshots with no horizontal scroll. A blocked
candidate carries its reason as inline text, which is the one real layout risk
here — a long reason beside a long name at 320px. `renderCandidateRow` already
uses `break-words`/`min-w-0`; keep both, and check the bowler picker with a
quota reason at 320 specifically.

**i18n:** every new reason string in all four dictionaries, flat dotted keys.
Cricket terms of art stay English by established precedent — match the
siblings. `npm run i18n:gen-keys` rewrites `src/lib/i18n-keys.ts`; commit it.

## 8. Branch and sequencing

**Done** — R2b merged 2026-08-18 (#610), so this is brief option 1 as written:
branch `feat/scorepad-v3-r2c-candidate-narrowing` off `main` `7023502a3`, in
`.claude/worktrees/r2c-candidates`. No writer overlap with anything in flight.

Order, because the dependencies are real:

1. Engine exports (§5) — independent of everything, and C1 needs 5.1.
2. Chassis types + both renderers (§3.2, §3.4) — one commit, ten skins
   unchanged, unit tests green before any skin uses them.
3. C1 (bowler) — the narrowest consumer, proves the strip path.
4. C2 (retire sheet) — proves the sheet path and closes the More entry.
5. C3 (review blocked) — depends on 5.2.
6. e2e, then gate rerun, then gallery + sign-off.

Traps that cost R2b the most, restated because they are process not code:
subagents die at 600s with no output (four did) — narrow briefs, short
commands, **commit early, one commit per item**; never `git add -A` and never
`git stash` in a worktree here; `rebuild` after ANY src change or the health
checks pass against the previous bundle; judge vitest green only from
`--reporter=json --outputFile`, and confirm every `.testResults[].name`
resolves inside the worktree.

## 8b. Built — what actually shipped, and what the gates said

All five code steps landed in the order §8 sets out. Deviations from the
design as written, each for a reason tsc or a test forced:

- **The engine exports take standalone structural types, not `Pick<...>`.**
  A `Pick` keeps its fields REQUIRED, so both exports were unusable from the
  skin's looser innings shape — the exact friction the exports existed to
  remove. tsc proved this; it was not visible to any test.
- **C2 asks two steps, not three.** `incoming` is optional in the engine and
  defaults to the next batter in the order, so asking would add a tap to
  every retirement to restate what the fold already knows. Reversible.
- **`buildSheets` now REQUIRES `t`.** Adding a translated string to a sheet
  created a new `t`-threading point, and `_INDEX.md` carries "R3-R7 skin
  authors: require `t`" precisely because a defaulted one is tsc-invisible.
  A factory-level test mirrors R2b's own proof for `tiles`.
- **The gallery needed three new capture states** — see `_INDEX.md`, "the
  gallery is BLIND to a narrowing wave unless it adds states".

Gates, judged from `--reporter=json` with every `.testResults[].name`
confirmed inside the worktree:

| Gate | Result |
| --- | --- |
| engine suite | 3934 passed / 0 failed / 3947 total (13 skipped = `placement-integration`, correct without the service) |
| apps/web full suite | 8760 passed / 4 failed / 8832 total — the 4 are `schedule-build-honours-locks`, PROVEN environmental: 11/11 with the placement service up |
| v3 suites | 599/599 |
| apps/web tsc | EXIT 0 |
| engine tsc | EXIT 0 |
| root turbo lint | EXIT 0, 0 errors / 75 warnings (unchanged from baseline) |
| i18n | parity OK across en/es/fr/nl; `i18n-keys.ts` regenerated |
| e2e (3 R2c tests) | 5 passed incl. setup, against a prod build whose bundle was confirmed newer than the last src edit |

Mutation-proofed at every step rather than trusted: 13 mutations across the
engine rule, the chassis fields, both renderers, and all three consumers,
each confirmed to red the specific test written for it.

## 9. Open, not blocking

- **`noEligible` on the bowler slot.** When nobody can legally open the next
  over, `candidates` is non-empty but `blocked` covers all of it. The picker
  then shows every name disabled with a reason, which is more informative than
  today's empty-ish state — but the underlying product question R2b flagged
  ("the laws of the game do not contemplate a fielding side too small to field
  a legal bowler") is still unruled. This design does not resolve it; it just
  stops the state from being silent.
- **`SheetPersonStep.blocked`.** Not added (nothing in R2c needs it). If a
  later sport does, it is the same field with the same semantics.
- **Generic `attribution-picker.tsx` still loops both sides** for every OTHER
  engine-declared action reachable from the More sheet. C2 removes cricket's
  worst instance; the surface-B gap itself stays open behind §4's blocker.
