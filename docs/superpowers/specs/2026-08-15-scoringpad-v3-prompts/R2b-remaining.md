# R2b — what is left, 2026-08-17

Written at the point the CODE queue emptied and the VERIFICATION queue did
not. Rulings behind these items live in `_INDEX.md`; this file is the task
list, not the decision log.

Sizing is rough: **S** ≈ one agent, **M** ≈ one agent plus a review round,
**L** ≈ needs a design decision before anyone starts.

---

## A. Merge gates for R2b itself — nothing ships until these are done

| # | Task | Size | Notes |
| --- | --- | --- | --- |
| A1 | **e2e for the six new behaviours** | M | The single most valuable item on this page. See §B. |
| A2 | **Recapture the sign-off gallery (768 + 1280)** | S | The pad changed substantially after the existing captures were taken. Rebuild FIRST, then capture — R2's recorded mistake was captures predating the code. `GALLERY_WIDTHS=768,1280`, `docs/runbooks/pad-gallery.md`. |
| A3 | **Republish to the SAME artifact URL** | S | `https://claude.ai/code/artifact/2afe5c99-e189-4c4e-a07c-0b7bb038761a`. A new URL orphans the owner's earlier review. |
| A4 | **Owner per-screen sign-off verdicts recorded in `_INDEX.md`** | — | Owner's own step. Merge is BLOCKED until present (`_RULES.md`). |
| A5 | **Open the PR** | S | Must state: smoke deferred to **R8 by name**; the unplanned fixes; the engine export (`nextBattingSide`) as a deliberate exception to R2b's no-engine rule; and that `02c5e6da5` carries two agents' work under a one-sided message. |
| A6 | **Full-suite + gates run at the wave boundary** | S | Not just the v3 directory — the whole apps/web suite and the engine suite, judged from `--reporter=json`, never from rtk. |

## B. e2e backlog (A1, itemised)

Every one of these has unit coverage and NO end-to-end coverage. Every defect
the owner hit on 2026-08-17 was found by USING the pad, not by a failing test.
`apps/web/e2e/scorepad-v3-cricket.spec.ts` unless noted.

| # | Behaviour | Notes |
| --- | --- | --- |
| B1 | Dock chips end to end | Tap No-ball → `+3` → assert the SUBMITTED payload is `bat:3` + `extras{noball,1}`. Also: a wide's dock offers no bat-run chips. |
| B2 | Free-hit indicator appears and clears | No-ball → `[data-strip-item-id="freeHit"]` visible → next LEGAL ball → gone. Include the `no-ball → wide → legal` case: the wide must NOT clear it. |
| B3 | Activity note shows a real name | Change bowler mid-innings → the row reads a person's name, never a uuid. |
| B4 | Ineligible-bowler block | Override the chip to an ineligible bowler → delivery tiles carry `data-tile-disabled="true"`, are unclickable, and the bowler slot shows the reason; all clear on an eligible pick. |
| B5 | Closed-innings gate | Close → tiles disabled with the closure message → scorebug still shows the final score. |
| B6 | Innings transition | Close innings 1 → tap a delivery tile → innings 2 opens with the OTHER side batting. Nothing but e2e proves this. |
| B7 | Free-hit wicket kinds | With a free hit pending, the wicket sheet offers exactly Run out / Obstructing, and the hint renders. |
| B8 | Confirm the specs run in a project that EXISTS in CI | `scorepad-v3` has no dedicated CI job; `e2e.yml` contains no `scorepad` reference. A spec in a project nothing runs is not coverage. |

## C. Live defects still unfixed — same class as the four already fixed

The class: **the pad offers what the engine will refuse.** Four instances were
fixed on this branch; these are the ones left.

| # | Defect | Size | Why not fixed here |
| --- | --- | --- | --- |
| C1 | **Bowler chip lists BOTH squads** — pick a batting-side player, the server refuses ("not in the fielding lineup") | M | Needs a chassis change: `ContextSlot` has only `pool`, no side/candidate filter, and `pad-host.tsx` feeds it `combinedPool(squads)`. |
| C2 | **Generic Retire sheet offers all 22 players, both sides** | M | Owner accepted when choosing that flow. `attribution-picker.tsx`'s `candidatesForPerson` always loops both sides; `PadAttributionItem` has no `side` field. |
| C3 | **`reviewSheet` offers a review with no check on reviews REMAINING** | M | Engine enforces (`cricket.ts:1764`); the pad does not. PRE-EXISTING — untouched by this branch, correctly not claimed by it. Harder than it looks: the side asking is not known until a later step. |

## D. Not built at all

| # | Gap | Size | Notes |
| --- | --- | --- | --- |
| D1 | **Rain / DLS has no pad surface** | L | `cricket.interruption` (`kind: rain\|light\|other`, `oversLostEstimate`) and `cricket.revise` (revised overs/target) are real engine events with no tile. Closing for `weather` records that the innings ENDED, not that the match was interrupted and recalculated. A rain-affected match is not an exotic case. |
| D2 | **Nothing on screen says which scoring mode an innings is in** | L | Inferable only from which tiles are present. The fold locks it on the first event and only an undo reverses it. No owner ruling exists for what an indicator should SAY, and the chassis is shared by eleven skins. Carried to R8. |
| D3 | **Smoke coverage for cricket** | M | Deferred to **R8 by name**, which already owes it. Must be stated in the PR. |

## E. Debt this branch created or exposed

| # | Item | Size | Notes |
| --- | --- | --- | --- |
| E1 | **`SheetChoiceStep` / `SheetNumberStep` hints use OPPOSITE conventions** | S | Choice takes an i18n KEY; number takes a PRE-RESOLVED string. Both are justified individually (`sheets()` receives no `t`), and together they are a trap for R3-R7. Pick one, or name the split loudly in `types.ts`. |
| E2 | **Test named "mutation proof" does not mutate anything** | S | In the `resolvePeople` block; hardcodes its expectation. Not a tautology — it still fails if the bug returns — but the name overclaims. Rename. |
| E3 | **`pad.cricket.sheet.retire.reason.*` are dead keys** | S | Zero code references, confirmed PRE-EXISTING (main's own retire flow hardcoded `reason: "other"` and never had a picker). Not this branch's to clean, but somebody's. |
| E4 | **`02c5e6da5` carries two agents' work under a one-sided message** | — | Two agents raced on `git add`. Not worth a rebase two dozen commits deep; state it in the PR body instead. |
| E5 | **Four agent stalls at the 600s watchdog** | — | Process, not code. Broad briefs stall; narrow ones with commit-early instructions survive. Two were recovered by hand because the work was sound and only the commit was missing. |

---

## Recommended sequencing

1. **A1/§B first.** It is the only item that would have caught today's defects
   before the owner did.
2. **A2 → A3 → A4** in that order, after a rebuild. Never capture before
   rebuilding.
3. **A5/A6**, then merge.
4. **C1-C3 as a follow-up PR.** All three need chassis changes; folding them
   into R2b would grow a one-tile wave a seventh time and widen the sign-off
   surface again.
5. **D1 on its own**, with a design pass — rain handling is a feature, not a fix.
