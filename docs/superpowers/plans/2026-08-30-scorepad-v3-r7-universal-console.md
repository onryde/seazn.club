# R7 — universal console: code-level plan

Wave brief: `docs/superpowers/specs/2026-08-15-scoringpad-v3-prompts/R7-universal-console.md`
Rulings + false premises: that directory's `_INDEX.md`, section "R7 (2026-08-30)".
Design of record: `docs/superpowers/specs/2026-08-15-scoringpad-v3-redesign-design.md` §3, §4, §8.
Scoping evidence (before/after specimens, captured live):
<https://claude.ai/code/artifact/84bd58c0-7bd3-4df6-8642-d77fa96e2166>

Worktree `.claude/worktrees/r7-console` · branch `feat/scorepad-v3-r7-universal-console`
off `e23dcf241` · env label `r7` (pg 54559, server :3348).

Everything below is pinned against `e23dcf241`. Re-pin before editing — every
line number in the wave brief itself predates R1 and six of its premises were
found false.

---

## 0. What this wave is, after scoping

The brief describes five tasks. Two of them do not exist as described, and four
more were added by owner ruling. The real shape:

| # | Task | Register rows | Blocked? |
|---|---|---|---|
| A | Three thin skins: boardgame, carrom, generic | D-13 (boardgame half) | no |
| B | Declaration-driven lineup editor | D-1, D-18 | no |
| B2 | `resolvePositions` read path — the inert seam behind B | — | no |
| C | Console chrome: one ledger, authority band, handover | D-4, D-6, D-12, D-19 | no |
| D | `v3-headline` conditional — the third score render | D-11 (reopened) | **partially** — see §6 |
| E | Cricket's empty More sheet at bands 0–1 | `_INDEX` L1507-1516 | no |
| F | P-5 dock amend path | P-5 | no |
| G | Legacy-lane demolition + totality gate | — | **YES — gated on R6 merging** |

D-3 is closed (R4). There is no `pad-renderer.tsx` fallback branch to delete.

---

## 1. Task A — three thin skins

New files, no overlap with R6:
`apps/web/src/components/v2/scorepad/v3/skins/{boardgame,carrom,generic}.tsx`

Each is a `(t) => SkinDefV3` **factory**, called once with a real `t` at
registration. `ScorebugSpec.context`, `WhoLine.name` and `DockSpec.title` are
pre-resolved TEXT; no `SkinDefV3` method receives `t`.

### boardgame — tapModel S

Ruling R7-2: **tap decides, dock enriches.**

- Scorebug halves are the two player NAMES (D-6 — person names, never entrant
  display names, for individual entrants). A tap commits `1–0` / `0–1`
  immediately.
- A `½ – ½` tile commits the draw.
- Ribbon reads the result in words, with Undo. Chess vocabulary is kept —
  "recorded by the arbiter" (v2 ruling, do not remint).
- A ~6s dock offers **Method** — checkmate / resignation / timeout / agreement
  — as OPTIONAL enrichment on the same payload. No tone values on the choice
  steps (`SheetChoiceStep.tone` is R6's this wave; do not touch it).
- Variant strip: classical / rapid / blitz.
- `lineup.size = 1, benchMax = 0` (`boardgame.ts:326`) ⇒ Task B hides the
  lineup editor entirely for this sport. That absence is an assertion, not an
  omission — see §2.
- **No `SPORT_PALETTES` entry** unless it earns one at visual sign-off; if it
  does, alphabetically ahead of R6's `hockey`, and R6 gets told first.

### carrom — tapModel T

Board-summary tiles. Strike-by-strike stays PARKED on the T-lane — do not build
it, do not leave a disabled affordance implying it exists.
`entrantModel` includes pair (`carrom.ts:812`), but `lineup.size = 1,
benchMax = 0` (`:507`), so the editor is hidden here too.
`carrom-pad.spec.ts` already exists and must stay green through the conversion.

### generic — tapModel S

Win/loss or score entry per variant. This is the baseline for what "no skin"
means, so it is the one sport that must look like the untouched default:
**generic is ABSENT from `SPORT_PALETTES`**, never present-with-defaults, or
`sportThemeStyle` stops returning `undefined` and the pad root gains a style
attribute it should not have (`__tests__/sport-theme.test.ts` locks this).

### Obligations every skin carries (inherited, R2 → R7)

- Implement `phase?(view)`. It is OPT-IN — omit it and the skin silently keeps
  the tab-shaped behaviour D-16 describes. Map a richer engine phase DOWN to
  the three `PadPhase` values inside the skin's own `phase()`; never widen the
  type.
- `sheets` is a METHOD of the view, not a static record, so a closed-over view
  cannot go stale.
- Real `fidelityEntitlements` from the module, or the recording chip renders an
  upsell for a band nothing gates.
- `WhoLine.servingLabel` wherever `serving` is set (not applicable to these
  three, but assert it rather than assume).
- Ribbon keys go into `PAD_LABEL_KEYS` (`lib/scoring-vocab.ts`), **not only**
  into the four dictionaries — otherwise ribbon copy stays on the generic
  fallback forever with nothing failing.

---

## 2. Task B — declaration-driven lineup editor (D-1, D-18)

`fixture-console.tsx:597` gates `LineupEditor` on `{home && away}` only.
`lineup-editor.tsx` is 484 lines and renders every column for every sport.

**Hide predicate (spec §4):** `lineup.size <= 1 && benchMax === 0`. All three of
this wave's sports match exactly (`boardgame.ts:326`, `carrom.ts:507`,
`generic.ts:487`).

**Columns, per declaration** (`lineup-editor.tsx:288-438`):

| Column | Line | Gate on |
|---|---|---|
| position select | `:308-329` | non-trivial position catalog, resolved per cfg |
| role select | `:330-345` | module declares roles |
| pair-order select | `:346-365` | `pairShaped` AND a kernel that consumes it |
| role checkboxes | `:366-390` | module declares them |

Do NOT read `positions` directly — see Task B2. `lineup-editor.tsx` currently
consumes already-flattened `positionGroups`/`roles` props (`:187-189`), sourced
upstream from `sportModule.positions.groups`; the fix is upstream of the editor.

**D-3 is closed** — `:209` already computes
`expectedStarting = pairShaped ? lineupSize * 2 : lineupSize`. Do not "fix" it.

**Testing shape.** The absence of the editor is the assertion, and per AGENTS.md
an absence probe on a Next body must anchor on `="` — React serialises an
omitted prop as `"$undefined"`, so a bare `data-*` probe passes in both states.

---

## 3. Task B2 — the `resolvePositions` read path (R7-8)

`packages/engine/src/sport/catalog.ts:53` has **zero production callers**.

Point these three at `resolvePositions(module, cfg)`:

- `apps/web/src/app/o/[orgSlug]/c/[compSlug]/d/[divSlug]/f/[no]/page.tsx:165-167`
- `apps/web/src/app/o/[orgSlug]/c/[compSlug]/d/[divSlug]/page.tsx:432-433`
- `apps/web/src/app/score/[token]/page.tsx:166-168`

The static positions already arrive; what never runs is the **cfg-conditional**
half. `period/kernel.ts:2434-2443` drops the keeper group's `min` to 0 when
`cfg.goalkeeper === "optional"`, and only `resolvePositions` invokes it.

**The regression test is the customer fact, not the seam:** a competition
configured with `goalkeeper: "optional"` must not show the lineup editor
demanding a keeper. A test that merely asserts `resolvePositions` was called
proves the wiring and not the behaviour.

R6 owns hockey's and ice hockey's declarations and does not touch these page
files. R7's own three sports declare no `positionsFor`, so they have no
conditional shape to lose — the test above needs a sport that does.

---

## 4. Task C — console chrome

### C1 — one ledger (D-4, ruling R7-1)

Merge, not delete. `v3/activity.tsx` becomes the single renderer:

- gains `#seq`, timestamp and recorded-by (from `fixture-console.tsx:619-683`),
- gains `Ledger verified ✓` and `Download audit` when mounted with authority,
- drops the coloured type chip (the row sentence already names the type) and
  keeps type as a 3px left stripe,
- `fixture-console.tsx:619-683` is DELETED.

The console mounts it with void authority + provenance + audit; `/score/[token]`
mounts the same component without them. Use `view.events` — never build a second
history route (`_INDEX` L2560).

### C2 — authority band (D-12, ruling R7-3)

Remove the bare button row at `fixture-console.tsx:497-567`. Add a labelled
band BELOW the pad and BELOW the ledger: caption "Match actions", a sentence
saying what it costs, outlined buttons only (never filled — nothing in this band
competes with a scoring tile), danger tint on Forfeit/Abandon, Abandon confirms.
`Finalize result` sits in the band (R7-3a).

**Enforce the tile-hierarchy convention here.** "Forfeit/Abandon are not
representable in the tile grid" is still only a comment with no type or runtime
block; console chrome is where the enforcement belongs, and it is the other half
of D-12.

**Do NOT introduce an `overflow: hidden` ancestor around the pad.** The 44px
floor on 40px minor tiles rides on a 2px `::before` bleed that any such ancestor
silently clips back to 40 (R1's unresolved item; console chrome wraps the pad).
Note `fixture-console.tsx:619` currently carries `overflow-hidden` on the
Activity card — that one is going away with C1, but do not re-add the pattern.

### C3 — handover beside the pad header (D-19, ruling R7-4)

`DeviceLinkPanel` moves from `f/[no]/page.tsx:218` to the pad header row.

### C4 — the two Undos (ruling R7-5)

Both stay. Rename each for what it does. First VERIFY the open item: whether
`latestEvent` (`pad-host.tsx:965`, unfiltered) lets the ribbon target a
`core.void` and void a void, where `lastVoidable` (`fixture-console.tsx:421`)
would not.

### C5 — person names everywhere (D-6)

Pad, header and pickers render member names for individual/pair entrants;
entrant `display_name` is a team-sports concept.

---

## 5. Task E — cricket's empty More sheet, and Task F — the dock amend path

**E** (`_INDEX` L1507-1516, routed to R7, never fixed): cricket's More tile can
open an EMPTY sheet at fidelity bands 0–1. Cricket must be re-captured in this
wave as part of the row.

**F** (P-5): the ~6s dock window silently drops a per-player stat if the scorer
does not answer, and v3 activity has no edit or amend path. Owner previously
recommended labelling such a row **partial**; retro-attribution stays deferred.
This is chassis work — keep the blast radius visible in the PR body.

---

## 6. Task D — the third score render (D-11, ruling R7-6)

`pad-host.tsx:1075` renders `data-role="v3-headline"`, a `bg-slate-900` bar
carrying the engine's `summaryHeadline`, directly above a scorebug showing the
same numbers larger.

**Declare, do not list** (design adopted from R6). A chassis-side list of
suppressed sports must be kept in sync with eleven skins and nothing fails when
it drifts. Give `SkinDefV3` an opt-in in the shape `phase?(view)` already uses:
a skin declares it OWNS the headline's information, and the chassis renders the
bar only when no skin has claimed it.

- cricket KEEPS it — the chase equation is information the scorebug cannot hold.
- football SUPPRESSES it — the headline is the scorebug's two numbers with an
  em dash between them.
- **hockey / ice hockey: DO NOT SUPPRESS YET.** `period/kernel.ts:2537` builds
  `${home} — ${away}${soSuffix}${otSuffix}${phaseSuffix}`. `(GWS 2–1)` and
  `(OT)` are today the ONLY statement of the shoot-out tally and the extra-time
  marker above the fold. Ping R6 before flipping; a duplicated headline is
  strictly better than a screen with no shoot-out score.

---

## 7. Task G — the demolition, and why it is last

`registry.ts:133-134` `LEGACY_SPORTS` = `builtinModules` keys minus
`CONVERTED_SPORTS`. `resolvePad` (`:157-160`) **throws** for a key in neither
set. So deleting the legacy lane while hockey/icehockey are unconverted does not
degrade them — it bricks them.

The totality flip is ONE commit, held at the tip, written only after R6 merges.
Do not write it on an assumption about R6's timeline.

**Sweep by SPORT KEY, not filename.** `__tests__/skin-coverage.test.ts:173-174`
maps sports to skins by key; no grep for a skin's filename surfaces it. Sweep
`"boardgame"`, `"carrom"`, `"generic"` as bare string literals across `src/` and
`e2e/` before deleting anything.

---

## 8. Verification — the traps that apply to this wave specifically

- vitest green ONLY from `--reporter=json --outputFile` + jq counts, and confirm
  the resolved paths in `.testResults[].name`. `rtk`'s `PASS(0) FAIL(0)` can
  mean *failed to collect*.
- `cd apps/web && npx vitest` — never `--root apps/web`, never from the repo
  root, never from the worktree root.
- Prefix every tsc/vitest/eslint probe with `rtk proxy`; a bare invocation has
  returned FABRICATED output in this programme.
- `apps/web` vitest is `environment: "node"` — **no jsdom**. A green builder
  suite is blind to stale closures, CSS cascade and real tap area. Every seam
  in this wave gets driven through its REAL producer and consumer.
- Shell cwd resets to the main checkout between calls — prefix
  `cd <abs worktree> &&` in the SAME call.
- No `git stash` in a worktree; the stack is shared with main.
- e2e on `localhost:3348`, never `127.0.0.1` (Secure cookie ⇒ 401 on every API
  call). Playwright needs cwd `apps/web` and `PLAYWRIGHT_BASE`.
- `gallery.capture.ts`'s per-sport `scoreOne` drives the very controls this
  conversion deletes (carrom `:2295`, generic `:2332`, boardgame `:2372`).
  Fix it in the same change, and confirm the images **exist AND DIFFER** — R4's
  harness errored before a single screenshot and would have collected a sign-off
  on zero pictures.

### The build rule this wave is under

Every new capability gets a test that folds the producer's own output through
the real consumer. A fixture on both ends proves the fixture. Specifically:

- Task A skins: drive the skin's own `mutate()` output through the real pad
  host and engine, in a browser — not a unit assertion on the builder.
- Task B2: assert the customer fact (optional keeper ⇒ editor does not demand
  one), not that the function was called.
- Task C1: prove the device link still renders history after the page panel is
  deleted. That is the failure this consolidation can cause.
- Task D: prove cricket KEEPS its headline in the same test that proves football
  loses it. One sample is not a parity sweep.

### Mutation proof

A guard nothing kills is not tested. For each gate added here — the lineup hide
predicate, the headline claim, the totality gate — delete the predicate or
`return true` and watch the suite go red. Restore from a `cp` backup, never
`git checkout`. Two guards covering for each other are each untested; mutate
them one at a time.

---

## 9. Ship checklist additions beyond `_RULES.md` §6

- [ ] Sport-key sweep done for all three sports before any deletion
- [ ] Device-link history proven present after C1
- [ ] `generic` absent from `SPORT_PALETTES`; `sport-theme.test.ts` green
- [ ] R6 pinged before any hockey/icehockey headline suppression
- [ ] `gallery.capture.ts` images exist AND differ, all three sports
- [ ] Cricket re-captured (Task E owes it)
- [ ] Throwaway `e2e/zz-r7-before.spec.ts` deleted
- [ ] Totality flip held at the tip until R6 merges
