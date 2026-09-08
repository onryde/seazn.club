# Plan review — 2026-09-08 — `streaming-t1` and `stream-overlay-w1`

Read-only review of the two plans against the design of record
(`specs/2026-09-07-streaming-programme-design.md` §3, §4, §5.1–5.2, §9a, §10,
§11) and `RULES.md` §"Owner checklist (2026-09-07)". Every `path:line` below
was re-opened on the tree at worktree HEAD `be2ba7296`; where a plan's pin and
the file disagree, the file wins and the correct value is given.

Tree state at review time: worktree `feat/stream-overlay` @ `be2ba7296`,
**2 ahead / 3 behind `main` (`b2244879f`)**. `main` carries desk W3
`cf7dc84d9` (#740) and settings W8 `e156bc052` (#744), neither in this tree.
Deltas tail `V399__stats_player_career_split.sql` on both.

Severity: **blocker** = the plan cannot be executed correctly as written;
**major** = it executes but ships a hole or a false green; **minor** = a wrong
pin, a stale count, or a claim the code does not support.

---

Counts: **17 blocker · 20 major · 26 minor** (63 total) — 22 against
`2026-09-07-streaming-t1.md`, 40 against `2026-09-05-stream-overlay-w1.md`,
1 against the design of record (finding 23).

Verdict: **Needs fixes.** Both plans are unusually well built — derived test
budgets, honest survivor declarations, a real gamma-differential case, the
`newContext` auth trap closed — but seventeen blockers stand between them and
a first-time-correct execution, and three of those (findings 1, 24, 32) would
each ship a wave that is green and wrong rather than red.

---

## A. `plans/2026-09-07-streaming-t1.md`

| # | file:line | severity | finding | fix | resolution (2026-09-08, fixer) |
|---|---|---|---|---|---|
| 1 | `plans/2026-09-07-streaming-t1.md:233,240-246,497` | blocker | **`OVERLAY_TOKENS` is never created.** Spec §4.2 (`design:430`), `T1-theme-and-visual-gate.md:143,187,197,232`, `W1-step-one.md:33,246` and `R2-compositor.md:92` all bind on ONE exported object `OVERLAY_TOKENS` from `components/overlay/overlay-tokens.ts`. The plan writes `components/overlay/tokens.ts` with seven separate exports (`ROOT_SPORT_DEFAULTS`, `OVERLAY_FIXED`, `SLATE_TOKENS`, `paletteFor`, `OVERLAY_SPORT_KEYS`, `OVERLAY_PAIR_ROLES`, `OVERLAY_ALPHA_ROLES`) and no `OVERLAY_TOKENS` at all. Task 2's own title (`:228`) names it; no step writes it. W1 and R2 will import a symbol that does not exist. | Either add `export const OVERLAY_TOKENS = { root: ROOT_SPORT_DEFAULTS, fixed: OVERLAY_FIXED, slate: SLATE_TOKENS, pairRoles: …, alphaRoles: …, paletteFor }` as the single named entry point and keep the granular exports beside it, or amend all four corpus documents in Task 0 to the new names and record the rename as an `_INDEX.md` finding. Do not leave the two vocabularies coexisting. | fixed — `overlay-tokens.ts` now exports ONE object `OVERLAY_TOKENS = { root, fixed, slate, sportKeys, pairRoles, alphaRoles, paletteFor }` (seven groups) beside the granular exports; the contrast test destructures from `OVERLAY_TOKENS`; every `components/overlay/tokens.ts` reference in both plans renamed (T1 Task 2 Step 7; W1 File Structure, Task 5 Step 10) |
| 2 | `plans/2026-09-07-streaming-t1.md:626,656,702` | blocker | **Task 3 Step 1 edits `mobile.spec.ts`, which the T1 prompt's "Do NOT touch" list forbids** (`T1-theme-and-visual-gate.md`, §Do NOT touch: "`mobile.spec.ts` (donor for `overflowingIn`; copy the logic into `asserts.ts`, do not import a spec from a spec)"). The plan moves the function to `helpers.ts` and deletes the original. Nothing in the plan records the deviation; a grep for "do not import a spec from a spec", "deviation" or "prompt says" across the plan returns zero. Spec §11: "A conflict between plan ORDER and a design or owner RULING is an `_INDEX.md` finding, never silently resolved." | The plan's approach is defensible (`helpers.ts` is not a spec, so Playwright's rule does not fire, and one authority beats a copy) — but it must be argued in the plan and land as an `_INDEX.md` finding before Task 3 runs, with the owner told the prompt's instruction was overruled and why. | fixed — the deviation is argued in T1 Task 3's Files block (helpers.ts is not a spec; `mobile.spec.ts:3-24` already imports 20 symbols from it) and lands as `_INDEX.md` finding FS-T1a in T1 Task 0 Step 8(b), with the owner told at Task 4's sign-off |
| 3 | `plans/2026-09-07-streaming-t1.md:626,702` | blocker | **The deletion range `mobile.spec.ts:85-124` is wrong in both directions and corrupts the file.** Actual: the doc comment opens at `:49` (`/** Split every box inside \`rootSelector\`…`), the function opens at `:91`, the closing brace is `:122`. Deleting `:85-124` orphans comment lines `:49-84` and removes `:123-124` — the blank line plus the opening of the NEXT doc comment (`/** The scorebug's own clipping gate.` at `:124`). The result does not parse. | Delete `:49-122` exactly. The plan's own escape hatch ("read the exact lines") is not enough — a literal range in a plan gets applied literally. | fixed — delete `:49-122` exactly (comment `:49`, function `:91`, brace `:122`; `:123-124` stay), with a `sed -n '49p;91p;122p;124p'` pre-check and a post-check that `:49` now reads the scorebug-gate comment; verified on `b2244879f` |
| 4 | `plans/2026-09-07-streaming-t1.md:604` | blocker | **The expected-red set is understated 6×.** Step 8 says "Hockey `slab-ink-on-dismissal` … is expected to sit under 4.5" — singular. Computed from the plan's own `OVERLAY_PAIR_ROLES` against `SPORT_PALETTES` (`sport-theme.ts:165`), SIX sports fail that role: tabletennis 2.35, badminton / icehockey / volleyball 2.59 (all `#ff6b6b`), hockey 2.88 (`#ff5a4d`), tennis 3.07 (`#fa5252`). All other 148 role rows pass. An implementer told to expect one red will read the other five as regressions and "fix" them by editing the floor or the palette. | Name all six rows with their measured ratios in Step 8, and put the design question to the owner as one T1a follow-up: `#fff5f5` cannot clear 4.5 on ANY light-red dismissal, so the slab line for those six sports takes `board` as its ink (or `_THEMES.md` §5 declares the slab line large text at floor 3). | fixed — Step 8 names all six rows with measured ratios (tabletennis 2.35, badminton/icehockey/volleyball 2.59, hockey 2.88, tennis 3.07) and puts ONE design question (A: slab line takes `board` ink, hockey `dismissal` ≥ `#e8463a`; B: large-text floor) to the owner as a T1a follow-up, recorded as FS-T1d |
| 5 | `plans/2026-09-07-streaming-t1.md:291` | blocker | **A hand-typed constant in the plan's own test is wrong.** `blendOver("#f5f0e8","#150b36",0.7)` is `#b2abb3`, not `#b2adb3` — green is `0.7·240 + 0.3·11 = 171.3 → 171 = ab`. The comment at `:290` computes only the red channel. Step 4 (`:352`) says "expect PASS, `numFailedTests: 0`"; it will be red, and the shortest repair from that red is to change `lib/contrast.ts`. | Correct the expectation to `#b2abb3`, and show all three channels in the comment. | fixed — `#b2abb3`, all three channels shown in the comment |
| 6 | `plans/2026-09-07-streaming-t1.md:107-136` | blocker | **Task 0 Steps 8–10 are already done on the tree.** `_RULES.md:149-158` already reads "eleven"; `W1-step-one.md` already carries exactly 8 `re-pinned 2026-09-07 @ fb99bbd4c` annotations, so Step 8's own verify (`≥ 8`) passes on an untouched tree; `W1-step-one.md:264-273` already names `desk/run-sheet-row.tsx`, RP1 and desk W3; `W2-moments.md` and `_STATE.md` are current to 2026-09-08. Step 9's target sentence ("**Not yet pushed since the rebase**…") no longer exists in `_STATE.md`. Step 10's `git add` of five files will stage nothing. | Rewrite Task 0 Steps 8–10 to what is actually still owed: the `_INDEX.md` **T1 row** (absent — grep returns nothing) and the `_STATE.md` environment block (Step 9's second half). Delete the rest, and note in `_INDEX.md` that the re-pins landed at `8d31cb34f`/`c8dc4d07f`. | fixed — Steps 8–10 rewritten: Step 8(a) is a verify-only grep set that must pass untouched; (b) adds the absent `_INDEX.md` T1 row + findings FS-T1a/b; (c) → Step 9 adds only the `_STATE.md` environment block (the vanished sentence is named as gone); Step 10 commits two files |
| 7 | `plans/2026-09-07-streaming-t1.md:17,71-73` | blocker | **"rebased on `main` `fb99bbd4c`" is stale; the tree is 3 commits behind `main` (`b2244879f`).** Missing: desk W3 `cf7dc84d9` (#740, 114 lines in `run-sheet-row.tsx`, 58 in `mobile.spec.ts`) and settings W8 `e156bc052` (#744). Step 1's check `merge-base --is-ancestor fb99bbd4c HEAD` still returns 0 and therefore cannot see the drift. Consequence: the Task 0 vitest/mobile baselines are taken on a pre-W3 tree and Task 4 Step 1 compares against them. | Rebase on `main` before Task 0, then take the baseline; change Step 1's check to `/usr/bin/git fetch origin main && /usr/bin/git merge-base --is-ancestor origin/main HEAD; echo "UPTODATE=$?"` so a moved `main` STOPS the wave. `overflowingIn` is byte-identical at `:49-122` on both trees (verified), so finding 3's range survives the rebase; `run-sheet-edit-time` does not (finding 8). | fixed — Global Constraints now cite `main` `b2244879f` / HEAD `d7431892b`; Step 1 runs `git fetch origin main && merge-base --is-ancestor origin/main HEAD; UPTODATE=$?` and STOPS the wave on `1` (rebase, re-check deltas, then baseline) |
| 8 | `plans/2026-09-05-stream-overlay-w1.md:104,4065`; `plans/2026-09-07-streaming-t1.md:108` | blocker | **`run-sheet-edit-time` is `:407` on `main`, not `:377`.** Desk W3 (#740) merged 2026-09-08 and moved it; spec §13.1 FS14 already records this, but §3.8, §13.2 RP1, both W1 plan rows and T1 Task 0 Step 8.1 still say `:377` — and T1 Step 8.1 instructs the implementer to WRITE `:377` into `W1-step-one.md:265`. `run-sheet-row.tsx` changed by 114 lines in that commit, so the mount neighbourhood is not just shifted, it is rewritten. | Re-pin to the SYMBOL (`data-testid="run-sheet-edit-time"`), drop the number from the plans, and have W1 Task 6 grep for it after the rebase rather than seek a line. Remove the `:377` write from T1 Task 0 Step 8.1. | fixed — every `:377` in both plans replaced by the SYMBOL `data-testid="run-sheet-edit-time"` with `:407 on b2244879f, grep never seek`; T1 Step 8.1's write is gone (Step 8 is verify-only); spec §2 atlas, §3.8, §13.2 RP1 and `W1-step-one.md:265` updated the same way |
| 9 | `plans/2026-09-07-streaming-t1.md:1302-1304` | major | **The harness's own anti-vacuity assertion is a tautology.** `expect(shots.filter(s => s.sha256.length === 64).length).toBeGreaterThan(0)` — a sha256 hex digest is always 64 characters, so this can only fail when `shots` is empty, which `:1285` and `GroupSchema.rows.min(1)` already forbid. The one guard the plan cites recurring class 10 for is the one guard that cannot fire. | Assert something a broken run would violate: every PNG's byte length > 1 KB (the prompt's own bar, `T1-theme-and-visual-gate.md:108`), and that the set of hashes in the group has more than one distinct value where the group declares any `mustDiffer`. | fixed — the tautology is replaced by two guards a broken run violates: every PNG > 1 KB (`bytes` recorded per shot, `MIN_PNG_BYTES`) and, where a group declares any `mustDiffer`, more than one distinct hash |
| 10 | `plans/2026-09-07-streaming-t1.md:641-642,1232` | major | **Manifest field names drift from the spec and the prompt.** Spec §4.2 (`design:411`) and `T1-theme-and-visual-gate.md:91` specify `awaitTestId` and a row-level `mustDifferFrom?: string[]`; the plan uses `awaitSelector` and a group-level `mustDiffer: [string,string][]`. `T1-theme-and-visual-gate.md:101` also specifies `toBeAttached`; `capture.spec.ts` at `:1232` uses `toBeVisible`. W1-E and R2 append rows against the corpus vocabulary and will write fields the schema rejects. | Pick one vocabulary and propagate it. If the plan's is kept (group-level pairs are the better shape and `toBeVisible` is right for a screenshot, unlike a fold), amend the spec §4.2 block and the two prompts in Task 0 and record it as a finding. | fixed — plan vocabulary kept (`awaitSelector`, group-level `mustDiffer`/`controlSetEqual`, `toBeVisible`) with the argument (seeded pages carry no testids; a pair is a group fact); spec §4.2 and `T1-theme-and-visual-gate.md` items 5–6 amended; recorded as design FS16 and `_INDEX.md` FS-T1b. `R2-compositor.md:92` names only `OVERLAY_TOKENS`, nothing to amend |
| 11 | `plans/2026-09-07-streaming-t1.md:1174-1307` | major | **Prompt item 9's collection proof is not in any step.** `T1-theme-and-visual-gate.md` §9: "Prove collection, do not assume it: `npx playwright test --list --project=parallel \| grep -a visual/capture`". The plan substitutes the wiring unit test (`:779-790`) — which pins the two path facts but never asks Playwright what it actually selected. | Add the `--list` command to Task 3 Step 10 or 11 with its expected output (two test titles, one per manifest group). Both proofs are cheap; the prompt asks for the direct one. | fixed — Task 3 Step 10 adds `npx playwright test --list --project=parallel | grep -a visual/capture` with the two expected titles (one per manifest group) |
| 12 | `plans/2026-09-07-streaming-t1.md:1006-1094` | major | **The assertions do not print what they saw on PASS.** `T1-theme-and-visual-gate.md` §7 and `_RULES.md` §Verification require "the element list, not a boolean", beside every pass/fail. `expectNoClip`, `expectHitTargetsByPoint` and `expectTruncateChain` name offenders only in the failure message; only `controlSet` (`:1294`) and `rails` (`:1093`) are logged/reported. A green `no-clip` row is indistinguishable from a row whose `controlRoot` was not in the DOM. | Have each assertion return what it inspected (counts + the first few names) and `console.log` it beside the existing control-set block, or fold the counts into `report.json`. | fixed — `expectNoClip` / `expectHitTargetsByPoint` / `expectTruncateChain` return `Seen { inspected, sample }`; `captureRow` logs `[visual …] png= sha= rails= controls= seen=` on every row and writes `seen` into `report.json`; `expectNoClip` also fails when the root inspected nothing |
| 13 | `plans/2026-09-07-streaming-t1.md:532-544,487-490` | major | **The "one authority" mechanism is applied to one export and not the others.** `ROOT_SPORT_DEFAULTS` is proven equal to `globals.css` on every run (`:412-421`) — good. `OVERLAY_FIXED.liveDot` and all three `SLATE_TOKENS` values are hand-typed against `_THEMES.md` with no equality proof, and `:488`'s `expect(OVERLAY_FIXED.liveDot).toBe("#ef4444")` restates the constant it imports (checklist: "Derived bound is a tautology"). Spec §4.2: "the sheet cites the export; a value typed twice is a finding". | Either parse the `_THEMES.md` values the way `cssVars()` parses `globals.css`, or delete the tautological assertions and record in `_INDEX.md` that these four values are typed twice, with the sheet as the authority. | fixed — the `liveDot` assertion now PARSES `_THEMES.md` §2's "live dot `#ef4444`" (same shape as the `globals.css` parse); `SLATE_TOKENS.indicator === liveDot` kept as a cross-constant relation; the three slate values are recorded typed-twice as FS-T1c until Task 1 lands §4a and the executor adds its parse (the case pins the shape) |
| 14 | `plans/2026-09-07-streaming-t1.md:1465` | major | **Four test kinds are not met per task** (`RULES.md` §Testing, spec §10). Task 1 has no test row at all. Task 2's e2e and smoke are delegated forward ("trace forward to Task 3's harness"), Task 0 is "env only (docs)". | State it plainly: Tasks 0/1 are documentation tasks with no code and therefore no four-kind obligation (say so, don't imply coverage); give Task 2 its own smoke line, or fold the token module into `visualSeedRoutesSuite`'s assertions so the claim is real. | fixed — self-review row states it plainly: Tasks 0/1/4 are documentation; Task 2 owes e2e/smoke to W1 Task 8 by name (the overlay page is the first HTTP surface that renders the tokens) rather than implying coverage |
| 15 | `plans/2026-09-07-streaming-t1.md:625,702` | minor | Body range `mobile.spec.ts:91-124` — actual `:91-122`. | `:91-122`. | fixed — `:91-122` everywhere |
| 16 | `plans/2026-09-07-streaming-t1.md:702` | minor | Import block cited as `:3-25` (actual `:3-24`, `} from "./helpers";` is `:24`), and "alphabetically after `loginUi`" invents an order — the list is `TAG, apiJson, activeOrg, expectNoHorizontalScroll, addEntrantsViaApi, …`, not alphabetical (recurring class 18: assume wave order until read). | `:3-24`; append `overflowingIn,` at the end of the list or beside `expectNoHorizontalScroll`, and drop the alphabetical claim. | fixed — `:3-24`; the list is wave order (`TAG, apiJson, activeOrg, expectNoHorizontalScroll, addEntrantsViaApi, …`); append as the last entry |
| 17 | `plans/2026-09-07-streaming-t1.md:1354` | minor | `scripts/smoke.ts:91 check` — actual `:100`. `html(s, path)` is `:13356` (the plan repeats the W1 plan's `:12644`). | `:100` and `:13356`. | fixed — `html` `:13356`; `check` and `v1data` pinned to `grep -F "function check("` (symbol — the file is 17k lines and moves every wave) |
| 18 | `plans/2026-09-07-streaming-t1.md:430` | minor | `expect(OVERLAY_SPORT_KEYS.length).toBe(fromPalettes.length + 2 - …)` restates `OVERLAY_SPORT_KEYS`'s own constructor (`:548-550`) — a derived bound tested against itself. | Assert the literal expected membership for the eleven keys, or drop the case; `:426-429` already carries the load. | fixed — the self-referential length case is deleted; replaced by `[...OVERLAY_SPORT_KEYS].sort() === Object.keys(V3_SKINS).sort()` and `V3_SKINS` length 11 — derived from the pad's skin registry (`registry.ts:85`), the working list of eleven |
| 19 | `plans/2026-09-07-streaming-t1.md:43,667` | minor | "one authority" is not achieved: `e2e/run-sheet.spec.ts:92` keeps a THIRD overflow implementation (`expectRunSheetNotClipped`) that the move does not touch, and its own comment at `:82` says it was written "in the shape `mobile.spec.ts`'s `overflowingIn`". | Either repoint it in the same commit, or say in the header comment that two implementations remain and record the tidy in `_INDEX.md`. | fixed — the `helpers.ts` header comment says two implementations remain (`run-sheet.spec.ts:100 expectRunSheetNotClipped`, self-described as shaped on `overflowingIn`) and T1 Task 0 Step 8(b)'s FS-T1a records the tidy; not repointed (a desk spec, outside T1) |
| 20 | `plans/2026-09-07-streaming-t1.md:1259-1263` | minor | The `rails-a11y` switch case comments "run below unconditionally for the report"; `:1263` runs it only when the check is listed, so a row without it reports `rails: []` as if there were none. | Run `expectRailsA11y` on every row for the report and assert only when listed, or fix the comment. | fixed — `expectRailsA11y(page, label, { assert })` is inspected on EVERY row for `report.json` and asserted only when the row lists the check; the comment now matches |
| 21 | `plans/2026-09-07-streaming-t1.md:1412` | minor | Task 3 Step 15's gate runs `npx vitest run src/lib` — which misses `src/components/overlay/__tests__/contrast.test.ts` written in Task 2. | Add `src/components/overlay` to that invocation. | fixed — Step 15 runs `npx vitest run src/lib src/components/overlay`, expected red = exactly the six Step 8 rows |
| 22 | `plans/2026-09-07-streaming-t1.md:717,902` | minor | The manifest test's header claims "Pure: no DB, no browser", but importing `SEED_PARAMS` pulls `seeds.ts` → `../helpers` → `@playwright/test` and the whole helper module at load. Precedent says it works (`src/__tests__/directory-kit.test.ts:9` value-imports `TAG` from `../../e2e/helpers`), so this is a wrong claim rather than a break. | Either drop the claim, or move `SEED_KINDS`/`SEED_PARAMS` into `manifest.ts` so the pure test imports nothing from `helpers.ts`. | fixed — `SEED_KINDS` / `SEED_PARAMS` moved into `manifest.ts` (pure); `seeds.ts` imports `SeedKind` from it; the unit test imports nothing from `helpers.ts` and its header says why |
| 23 | `specs/2026-09-07-streaming-programme-design.md:112` | minor | The spec's atlas pins the `:root --sport-*` block at `globals.css:1014-1022`; it is `:1135-1141`. The T1 plan has it right (`:237`, `:520`), so this bites only a reader who trusts the spec. | `:1135-1141`. | fixed in the design — §2 atlas row now `globals.css:1135-1141` (E b2244879f); recorded as FS15 in §13.1 |

---

## B. `plans/2026-09-05-stream-overlay-w1.md`

Task 0 was read in full, as was every step annotated "amended 2026-09-07" or
"re-pinned"; the remainder was skimmed for coverage. Every pin below was
re-opened on the tree.

### B1 — Blockers

| # | file:line | severity | finding | fix | resolution (2026-09-08, fixer) |
|---|---|---|---|---|---|
| 24 | `w1.md:105,4064,4584` | blocker | **`run-sheet.tsx` has FOUR `<RunSheetRow>` mounts — `:261`, `:296`, `:334`, `:480` — and the plan threads the panel to two.** Step 4(b) at `:4584` says "BOTH `<RunSheetRow>` call sites (`:261`, `:296`)". `:334` is the settled/decided lane, which is exactly where owner Q6's replay ruling ("a club pastes the replay link after the final whistle") needs the toggle; the panel would be invisible there. `:480` is `RunSheetRowWithRule` and inherits via `{...rest}`. | Name all four sites; edit `:334` explicitly. Verify with `grep -an "<RunSheetRow" run-sheet.tsx` → 4 hits, and add an e2e that opens the panel on a `decided` fixture. | fixed — Step 4(b) names ALL FOUR mounts on `b2244879f` (`:355` day, `:390` unscheduled, `:428` settled, `:669` `RunSheetRowWithRule` via `{...rest}` with its prop type at `:655-666`); new Step 4(d) mount-count test in `run-sheet-filters.test.tsx` (three lanes → three toggles, zero when not entitled) plus a tree assertion of exactly 4 `<RunSheetRow` mounts; Task 8 Step 2b adds the e2e that opens the panel on a `decided` fixture INSIDE `[data-run-sheet-block="settled"]`; mutant (p) drops the settled prop |
| 25 | `w1.md:457,478,1658,1668` | blocker | **The `cricket.toss` payload cannot parse.** The plan writes `{ winner: "home", decision: "bat" }`; `CricketToss` (`packages/engine/src/sports/cricket/cricket.ts:240`) is `z.strictObject({ wonBy: EntrantId, elected: z.enum(["bat","bowl"]) })`. A strict parse rejects both keys, the fold yields no innings, and every cricket assertion in Task 0 fails for a reason the plan does not predict. | `{ wonBy: <entrantId>, elected: "bat" }` at all four sites. | fixed — `{ wonBy: HOME_ID, elected: "bat" }` at all four sites (`HOME_ID` read off `defaultLineupPair`, RE-PIN note); the RE-PIN paragraph quotes `CricketToss` from `cricket.ts:240-243` on `b2244879f` |
| 26 | `w1.md:480` | blocker | **The `cricket.revise` payload cannot parse.** The plan writes `{ target: 91, ballsLimit: 60, source: "dls" }`; `CricketRevise` (`cricket.ts:259`) is a `strictObject` of `{ oversPerSide?: int, target?: int }` with a refine — there is no `ballsLimit` and no `source`. | `{ oversPerSide: 10, target: 91 }`, and derive the expected limit as `oversPerSide × cfg.ballsPerOver` from the engine's own config rather than the literal 60 (checklist: "Derive expected values from the engine's own declarations"). | fixed — `{ oversPerSide: 10, target: 91 }`; expected `ballsLimit` = `10 × cfg.ballsPerOver` read from the module's config, plus a differential assertion against innings[0] |
| 27 | `w1.md:2412` | blocker | **The expected `ordinal_position: 22` for `stream_url` is wrong.** `V369__public_fixtures_round_role.sql:18`'s select lists **23** columns (id, division_id, stage_id, pool_id, round_no, seq_in_round, home_entrant_id, away_entrant_id, scheduled_at, venue, court_label, status, outcome, created_at, summary, last_seq, officials, home_slot_label, away_slot_label, lane, is_final, third_place, conditional), so an appended `stream_url` is **24**. A literal reader marks a correct migration broken. | Assert `stream_url` is the MAXIMUM `ordinal_position` in `public_fixtures_v` rather than a constant — the count moves every time the view is redefined (R6 allows append-only). | fixed — assert `ordinal_position = max(ordinal_position)` for the view, never a literal; the note records 23 columns in V369 → 24 today and why the number moves |
| 28 | `w1.md:2436` | blocker | `export type PatchFixture` is `server/api-v1/schemas.ts:1081`, not `:989`. The file is 4,679 lines; `:989` is unrelated code an implementer would edit by mistake. | `:1081`, anchored on the symbol. | fixed — `export const PatchFixture = z` at `:1118` (its `export type` `:1144`) on `b2244879f`, anchored on the symbol (the reviewer's `:1081` is itself stale on this tree) |
| 29 | `w1.md:4723` | blocker | **Five of seven `e2e/helpers.ts` pins are stale**, and the plan's Task 8 inserts code at them: `activeOrg` is `:1335` (plan `:1268`), `addEntrantsViaApi` `:1479` (`:1412`), `createStageAndGenerate` `:1496` (`:1429`), `setBoolEntitlementOverrideSql` `:518` (`:500`), `invalidateOrgEntitlements` `:961` (`:943`). `apiJson :128` and `expectNoHorizontalScroll :49` are correct. | Re-pin all five; prefer symbol anchors — `helpers.ts` is edited by every wave. | fixed — re-pinned on `b2244879f` with the SYMBOL as the pin: `activeOrg :1454`, `addEntrantsViaApi :1598`, `createStageAndGenerate :1615`, `setBoolEntitlementOverrideSql :518`, `invalidateOrgEntitlements :1013` — note four of the reviewer's five "correct" numbers had already moved by desk W3, which is the point of the symbol rule |
| 30 | `w1.md:4723,5076` | blocker | `scripts/smoke.ts` pins are stale: `insertEntitlementOverride` `:9937` (plan `:9461`), `html` `:13356` (`:12644`), `check` `:100` (`:91`); Step 6's "same block (`:784`)" is wrong — `scorePadV2AppendSuite(admin, org2.id)` is called at `:818`. | Re-pin all four. | fixed — `insertEntitlementOverride :9937`, `html :13356`, `check` by `grep -F`, the call site `await scorePadV2AppendSuite(admin, org2.id);` at `:818` (the function itself `:17358`) |
| 31 | `w1.md:4726,5309` | blocker | `WALKTHROUGH_SPECS` is `src/lib/__tests__/e2e-ci-wiring.test.ts:155`, not `:16` (`:16` is prose in the file header). The plan's rule "the walkthrough spec named in `WALKTHROUGH_SPECS` in the same commit" is right; the address is not. | `:155`. | fixed — `:155` everywhere (replace_all) |
| 32 | `w1.md:4086-4109` | blocker | **Task 6 Step 3a is a placeholder.** All three `it()` bodies are empty — `:4099` is `(status) => { /* render RunSheetRow with this status … */ }` and `:4109` is `it("is absent when canEdit is false, at the same status", () => {});`. This is the ONLY test pinning owner Q6's "at every fixture status" ruling and the `streamingEntitled` gate, so the wave's headline ruling ships untested and green. | Write the three bodies against `run-sheet-row.test.tsx`'s own render helper, enumerating the status table rather than one sample. | fixed — Step 3a is now real: `STATUSES` derived from `PatchFixture.shape.status` (the wire enum, 7 values asserted), `it.each` over every status expecting the toggle `aria-expanded="false"`, the two negative pairs (not entitled on a DECIDED row; `canEdit` false), the positive pair proving the gate is not `canEditFixtureTime` (`run-sheet-edit-time` present on scheduled / absent on decided while the toggle shows on both), and the `?stream=`/`streamTab` open case; `rowHtml` gains a trailing `stream` props object with defaults so existing cases are untouched |

### B2 — Majors

| # | file:line | severity | finding | fix | resolution (2026-09-08, fixer) |
|---|---|---|---|---|---|
| 33 | `w1.md:3590` | major | **Spec §3.1 "Resilience on air" has no step and no test.** "The stage holds the last known score through a fetch failure or a deploy, reconnects quietly, never paints a white frame" is the owner's one real argument against a separate service (Q16), and Task 5 Step 8 has no error boundary, no failure path and no assertion. | Add a stage-level unit (fetcher rejects ⇒ the last model is still painted, no throw) and an e2e that kills the endpoint mid-poll and asserts the score is still on screen. | fixed — unit: `use-live-fixture.test.tsx` › `a rejected fetch keeps the last known score and does not throw` (Task 1 Step 2a); e2e: Task 8 Step 2b's `page.route` kills the overlay endpoint for two POLL_MS windows and asserts the score is still painted and the body still transparent; mutant (q) removes the try/catch |
| 34 | `w1.md:5276` | major | Spec §10.2's W1 mutant **"delete `streamingEntitled` on the toggle"** has no row in the plan's mutant table; the other eight §10.2 W1 mutants all appear. Compounds finding 32 — the killer that row would name is the test that is empty. | Add the row naming Step 3a's "is absent when the org is not entitled / present when it is" pair as its killer. | fixed — mutant row (o) added: delete `streamingEntitled` from the toggle's condition, killer = Step 3a's not-entitled-on-decided case and the Task 8 not-entitled e2e; run in Task 6 Step 7a |
| 35 | `w1.md:53,5266-5270` | major | **No task states an acceptance block naming all four test kinds.** Spec §10 and `RULES.md` §Testing require unit + e2e + smoke + regression **per task** with named assertions; the only mapping is a wave-level table. Tasks 0, 2, 3, 4, 5, 6 and 7 name no e2e, smoke or regression of their own. | Add a per-task acceptance block naming the four kinds and the checklist rows it satisfies, as the T1 plan does. | fixed — an `**Acceptance (four kinds, named)**` block sits before the first step of every task (0–8), naming unit/e2e/smoke/regression by test title plus the checklist rows and the mutant pointer; Task 7 states plainly that it owes no unit beyond dictionary coverage |
| 36 | `w1.md:2626` | major | **Tasks 4, 6 and 7 have no mutation step.** The two `extra` rows at `:5297-5298` are the only cover and no numbered step runs them. | Give each task a mutation step, or have each task's acceptance point at its `extra` row by name. | fixed — Task 4 Step 5a (domain-list mutant; delete the relay catalogue rows), Task 6 Step 7a (mutants o, p, r), Task 7 Step 4a (drop `rel`; render for VOID statuses — adding the assertions to Step 1's case if absent), each with named killers; the two `extra` rows are now referenced from Task 3/4 acceptance |
| 37 | `w1.md:2365` | major | The `stream-url` mutant's killer list overstates the kill: mutant (a) claims "all ten `rejects …` cases" go red on `return true`, but there are **eleven** rejected rows and five of them (`javascript:`, `http://`, unparseable, leading space, the userinfo case) are killed by the protocol/parse branch, not the hostname check. A test that dies under every mutant fakes kills. | Name only the six hostname rows as mutant (a)'s killers. | fixed — mutant (a)'s killers are the EIGHT hostname rows (six original + the two from finding 38); the five protocol/parse rows are stated to stay green under it, and a red there means the mutant was applied too widely |
| 38 | `w1.md:2215` | major | Spec §3.7 names **trailing dots** and **IDN homographs** as attacks the exact comparison defeats; neither appears in the `REJECTED` table. The suffix and userinfo cases are present. | Add `https://youtube.com./x` and a Cyrillic-`е` homograph row. | fixed — `https://youtube.com./x` and a Cyrillic-`е` homograph row added to `REJECTED` with the reason each is a distinct hostname to the exact comparison |
| 39 | `w1.md:4546` | major | **`defaultTab={props.defaultOpen ? "obs" : "obs"}` — both branches identical, so the prop is dead.** §5.3's buy-credits flow returns from Stripe to "the same fixture row with the panel open", which R1 will need to open on the Phone tab; there is no way to. | Thread a real `defaultTab` from `?stream=<id>&tab=phone` through `StreamRowSlot`, or delete the prop and record that R1 owes the entry point. | fixed — `StreamRowSlot` takes a real `defaultTab: "obs" | "phone"`; `stages-panel.tsx` reads `?streamTab=` beside `?stream=`; threaded as `openStreamTab` through `RunSheet`/`RunSheetRowWithRule`/`RunSheetRow`; Step 3a's `?stream=` case asserts `stream-tab-phone` `aria-selected="true"`; R1's `success_url` has its entry point |
| 40 | `w1.md:271` | major | `seedPublicFixture` is `throw new Error("lift from data-court-venue-names.test.ts")` at `:272` — Task 0 Step 1's own test cannot run as written. | Inline the seed, or name the exact export to import. | fixed — `seedPublicFixture(orgTz)` is inlined from `data-court-venue-names.test.ts:47-93` (not exported on the tree), minus venue/court rows, plus `organizations.timezone`; returns `{ orgId, orgSlug, compSlug, divSlug, divisionId, fixtureId }` |
| 41 | `w1.md:4086` | major | Step 3a is placed **before** Step 1 (`:4114`) in file order, so an executor following the checkboxes writes the gate test before the panel or its dictionary copy exists. | Move Step 3a after Step 3. | fixed — Step 3a moved after Step 3b (which defines the tabs and `?stream=` it asserts) and before Step 4 |
| 42 | `w1.md:2784,36,2634` | major | Pricing pins wrong: `ENTITLEMENT_DOMAINS` is `entitlement-domains.ts:7` (plan `:5`); in `pricing-matrix.ts` it appears at `:4` and `:6` and the map is `:265`, with `buildPricingSections` at `:264` — the plan expects "`:196` and `:199`" and cites `:191,199`. | Re-pin to `:4`/`:6`/`:264`/`:265` and `entitlement-domains.ts:7`. | fixed — `entitlement-domains.ts:7`; `pricing-matrix.ts` `:4` (comment), `:6` (import), `buildPricingSections` `:264`, the map `:265` — Global Constraints and Task 4 Step 5 both re-pinned |
| 43 | `w1.md:3192,83,2796` | major | "after `getPublicFixture` (`:747`)" lands **inside** the function: `getPublicFixture` is `data.ts:701` and returns at `:759`. Inserting at `:747` puts the new helper in the middle of a function body. | Insert after `:760`; re-pin `getPublicFixture` to `:701` (`:2813` says `:689`, which the plan's own File Structure contradicts). | fixed — insert after `getPublicFixture`'s closing brace (`:701` open, `return { org … }` `:758`, `}` `:759` on `b2244879f`), anchored on the return line; File Structure row corrected |
| 44 | `w1.md:84,2196,737` | major | `usecases/public.ts` ranges wrong: `publicFixture` is `:279`, its `Pick<>` `:283-301`, its SELECT `:304-308`; the plan says `:263-297` and `:296-303`. | Re-pin all three. | fixed — `publicFixture :279`, `Pick<>` `:284-302`, SELECT `:304-308` in the File Structure row and the Task 0 RE-PIN |
| 45 | `w1.md:4555` | major | "the ONE place it is built (`toRunSheetFixture`, `stages-panel.tsx:1168`)" — `:1168` is the `<RunSheet blocks=…>` call site; `toRunSheetFixture` is DEFINED at `stages-panel.tsx:147`. An implementer adding `stream_url` to the row shape edits the wrong place. | `:147`. | fixed — `toRunSheetFixture` is DEFINED at `stages-panel.tsx:141` on `b2244879f` (the reviewer's `:147` had already moved; `:1126` is the `<RunSheet` mount); the note also adds `"stream_url"` to `RunSheetFixture`'s `Pick<>` (`run-sheet-groups.ts:32`), to the hand-declared `FixtureRow`, and to the console fixtures usecase's SELECT as Task 3 Step 8's third list |
| 46 | `w1.md:1424,75` | major | "immediately after `disciplineLabel` (`:377-380`)" — `disciplineLabel` is `lib/public-site.ts:382-384`. `:377` is inside `servingSide`'s neighbourhood. | Insert after `:384`. | fixed — insert after `disciplineLabel`'s closing brace `:384` (`:382-384`); File Structure row corrected |

### B3 — Minors

| # | file:line | severity | finding | fix | resolution (2026-09-08, fixer) |
|---|---|---|---|---|---|
| 47 | `w1.md:83` | minor | `PublicFixture` is `data.ts:207`, not `:206`; the fixture SELECT is `:722-729`, not `:711-716`. | Re-pin. | fixed — `PublicFixture :207`; SELECT `:722-729` (three sites) |
| 48 | `w1.md:2634,2813` | minor | `hasFeature` is `lib/entitlements.ts:456`, not `:454`. (Spec §2's atlas carries the same wrong value.) | `:456`. | fixed — `lib/entitlements.ts:456` (replace_all) |
| 49 | `w1.md:229,338` | minor | `resolveVenueTz` given as `tz.ts:43` in two comments; it is `:44`, which the plan's own Interfaces block at `:212` already says. | `:44`. | fixed — `lib/tz.ts:44` (replace_all) |
| 50 | `w1.md:35` | minor | `openapi:gen` is `package.json:46`, not `:45`. | `:46`. | rejected — opened `package.json:45` on `b2244879f`: `"openapi:gen": "node --experimental-strip-types scripts/openapi-gen.ts",` IS line 45 (grep -n "openapi:gen" package.json → 45); the plan is right on this tree |
| 51 | `w1.md:4114` | minor | The `embed.*` dictionary block is `ui.json:421-423`, not `:419-421`. | Re-pin. | fixed — pinned to the symbol (`grep -F '"embed"'` in the panel's namespace; RP9 says record whether it is `ui.json` or `console.json`) — the block did not resolve to `ui.json:421-423` on `b2244879f` either (`grep -F '"embed": {' apps/web/src/dictionaries/en/ui.json` returns nothing), so the number is not the pin |
| 52 | `w1.md:3226` | minor | `embed/layout.tsx` returns its `<div>` at `:25` (function opens `:23`), not `:26`. | Re-pin. | rejected — opened `apps/web/src/app/embed/layout.tsx` on `b2244879f`: `export default function EmbedLayout(` is `:24` and `<div className="min-h-4 bg-white p-3">` is `:26` (grep -n); the plan's `:26` is right on this tree — the comment now also names `:24` for the function |
| 53 | `w1.md:72` | minor | The hook lift range is given as `live-score.tsx:60-117`; spec §3.3 and the tree both say `:61-117` (`refresh` is `:61`, `:60` is blank). | `:61-117`. | fixed — `:61-117` (`refresh` `:61`; `:60` blank) |
| 54 | `w1.md:105` | minor | `run-sheet.tsx` Props pinned `:44-80`, but `export function RunSheet({` opens at `:36` with an inline destructure and there is no separate `Props` interface. | Pin the symbol, not a range. | fixed — pinned to the symbol `export function RunSheet({` (`:36`, inline destructure, no `Props` interface) |
| 55 | `w1.md:110` | minor | The division page's `<StagesPanel` mount is `:617`, not `:596`. (Its `Promise.all` `:126` and `embeds.enabled` `:814` are both correct.) | `:617`. | fixed — `<StagesPanel` mount `:617`; `Promise.all` `:126-138` |
| 56 | `w1.md:2991` | minor | The `.ovl-*` block is to be inserted "after `:1022`" of `globals.css`, which is mid-file inside a media-query close (the file is 1,316 lines; the `--sport-*` root block is `:1135-1141`). | State explicitly whether the block goes at EOF or beside the `.pad-*` rules, and pin it to a symbol. | fixed — append at END OF FILE after the last rule `.pad-card-swatch { … }`, under a banner; the root `--sport-*` block the overlay reads is `:1135-1141`; `:1022` named as mid-file |
| 57 | `w1.md:166` | minor | The `OverlayLiveData` block is headed "design §3.2, VERBATIM" but rewrites the interface as `extends LiveFixtureData` where the spec declares `status`/`summary`/`outcome` inline. The shapes are equivalent — `LiveFixtureData` is exactly those three — so this is a false claim, not a defect. | Drop "VERBATIM", or reproduce the spec's form. | fixed — heading now says "design §3.2 in equivalent form — `extends LiveFixtureData` IS the spec's inline three fields" |
| 58 | `w1.md:808,1212` | minor | Spec §3.3 says "an exported `presentationNowOffsetMs`"; the plan makes it a FIELD of the returned `LiveFixture<T>` (`:1212` returns `presentationNowOffsetMs: delayMs`). The spelling matches exactly; the surface does not. | Record as a deviation. The field is the better shape (one authority, per-hook), so amend the spec rather than the plan. | fixed in the design — §3.3 now says a `presentationNowOffsetMs` FIELD on the returned `LiveFixture<T>`; recorded as FS17 |
| 59 | `w1.md:3532` | minor | The page calls `hasFeature(org.id, "streaming.overlay", competition.id)` (competition-scoped) where spec §3.1 specifies the 2-arg org-wide read. Harmless — the override layer resolves first (`entitlements.ts:443`) — but undeclared. | Record the deviation, or drop the third argument. | fixed — recorded as a deviation in the page code comment: competition-scoped on purpose (Event Pass grants per competition, matching `getPublicFixture`'s own realtime read at `data.ts:743-746`); the override layer resolves first |
| 60 | `w1.md:1297` | minor | `OverlayMoment.tone` is a hand-written `"led"\|"caution"\|"dismissal"` union where spec §3.4 says `SportTone` (`sport-theme.ts:87` = `advisory, caution, dismissal` — note `led` is NOT a tone and `advisory` is missing). | Import `SportTone` so W2's slab widens additively and hockey's green card is reachable. | fixed — `tone: SportTone | "led"` with `import type { SportTone } from sport-theme` (advisory | caution | dismissal + the LED slab); Produces bullet matches |
| 61 | `w1.md:2789` | minor | Task 4's commit body says "V393 writes an explicit false for every plan key" and its subject names only `streaming.overlay`, while the migration written at `:2737` is **V401** inserting BOTH keys. | Fix the message. | fixed — subject `streaming.overlay and streaming.relay, denied on every plan`; body says V401 and both keys |
| 62 | `w1.md:1270,790` | minor | Attribution is inconsistent: Tasks 1–8 commit as `Co-Authored-By: Claude Opus 5 (1M context)` with session `01UdUR7dcxassJ4FExpVfRRr`; Task 0 (`:790`) uses `Claude Fable 5.1` with a different session URL. | One attribution across the wave. | fixed — every commit trailer is now `Claude Fable 5.1` / session `01LJGBoVPAWczYB9c45TD1aw` (replace_all) |
| 63 | `w1.md:1314` | minor | Step 1 is titled "the four new summary readers" but produces three (`battingEntrantId`, `chaseNeed`, `chaseBalls`). | Say three. | fixed — "three readers" in the step title, naming which read the summary and which the endpoint |

### B4 — Spec §3 coverage: two gaps

Everything in §3.1–§3.11 maps to a task+step **except** §3.1's on-air
resilience (finding 33) and §10.2's `streamingEntitled` mutant (finding 34).
Present and correctly pinned: the route + sibling layout with the transparent
`<style>` and `robots: { index: false }` (T5 S6/S7); `resolveTheme` never
throwing (T5 S6a–6d, with its own mutant); `lang=` via `toLocale` (T5 S7); the
`usePathname` return **and** the zero-cookies e2e (T5 S4a/S4b); the
`publicFixtureSlugs` helper (T5 S5); 4-arg `getPublicFixture` + `hasFeature`
→ `notFound()` (T5 S7); `useLiveFixture(id, initial, realtime, { fetcher })`
and the 1920×1080 `scale()` canvas (T5 S8); the overlay endpoint (T0 S13);
`unstable_cache` keyed on `last_seq` with the fold-spy ≤1× unit (T0 S9–S12);
the hook lifted from `live-score.tsx` with `LiveScore` repointed **in the same
commit** (T1 S3–S5, S7); `overlayModel` importing all five `lib/public-site`
derivations (T2 S7); `OVERLAY_THEMES`/`OverlayThemeDef`/`defaultThemeFor`/
`themesForSport`/`resolveTheme` used consistently; the three motions and the
ticking clock (T5 S4/S8a); V400 with the V369 body **copied correctly** and
`stream_url` appended LAST; eleven hosts; `PUT /stream` + the OpenAPI `ROUTES`
row; the panel with both tabs; `public-stream-link` (T7); V401 both keys
`false` for all five plans; and §3.11's empty states, with boardgame / carrom /
generic asserted explicitly at `:487`, `:1699`, `:3309`.

### B5 — Type consistency with spec §3.2–§3.5

`OverlayLiveData` and `OverlayModel` match the spec field-for-field
(`status`, `summary`, `outcome`, `lastSeq`, `venueTz`, `clock?{phase,
anchorSeconds, anchorAtWallMs}`, `cricket?{innings:[{runs, wickets,
legalBalls, ballsLimit}]}`). The registry names are used consistently across
both plans. The only drift is findings 57, 58 and 60.

---

## What was verified and is correct

Every one of these was re-opened; the plans agree with the tree and no finding
is owed.

| Pin | State |
|---|---|
| `apps/web/src/server/engine-db/fold.ts:58` `foldFixture(tx, fixtureId)` | correct |
| `apps/web/src/lib/tz.ts:44` `resolveVenueTz(divisionTz, orgTz)` | correct |
| `live-score.tsx` `POLL_MS :29`, `refresh :61`, live predicate `:69` (includes `scheduled`), realtime effect `:74-110`, poll effect `:113-117` | all correct |
| `db/migration/deltas/V369__public_fixtures_round_role.sql:18` is the latest `create or replace view public_fixtures_v` (V362 is the previous) | correct (FS13 holds) |
| `apps/web/playwright.config.ts:119` `const WALKTHROUGH = …`; `SERIAL_SPECS` `:31`; `AUTH_STATE` `:29`; `PARALLEL_HEAVY` `:82` | all correct |
| `apps/web/e2e/helpers.ts` `:49` `expectNoHorizontalScroll`, `:117` `TAG`, `:128` `apiJson`, `:518` `setBoolEntitlementOverrideSql`, `:1335` `activeOrg`, `:1569` `RosteredFixture`, `:1599` `seedRosteredFixture`, `:1738` `scoreFixture` | all correct, and unchanged on `main` |
| `apps/web/e2e/scorepad-a11y-kit.ts` `:57` `HIT_TARGET_FLOOR_PX`, `:83` `measureHitTargets`, `:190` `hitTargetFloorReport`, `:209` `floorViolationLines`, `:409` `dismissCookieBanner` | all correct |
| `cookie-consent.tsx` has NO `usePathname` and no route mechanism (`:26` component, `localStorage` at `:42,44`) | FS1 correct |
| `sport-theme.ts:77` `SPORT_TOKENS` (seven), `:87` `SPORT_TONES`, `:165` `SPORT_PALETTES` (nine palettes: football, hockey, icehockey, tennis, badminton, tabletennis, volleyball, boardgame, carrom → eleven overlay sports with cricket + generic) | correct |
| `lib/fonts.ts:7-9` `weight: ["600","700"]` — 800 absent | correct (FS8 holds) |
| `unstable_cache` precedent in `server/public-site/data.ts` | exists |
| `src/lib/__tests__/e2e-ci-wiring.test.ts:280` "runs every spec file in at least one CI leg" | exists; the plan's citation is accurate |
| The plan's `cssVars()`/`resolveVar()` parser, run against the real `globals.css` | resolves all seven tokens correctly (`board #150b36`, `board-2 #1d1145`, `ink #f5f0e8`, `led #9ae600`, `advisory #16a34a`, `caution #d97706`, `dismissal #dc2626`) and finds exactly the seven `--sport-*` declarations |
| `seedRosteredFixture` posts `visibility: "public"` (`helpers.ts:1637`), so the anonymous rows resolve | correct |
| `main h1` — `<main>` at `(public)/shared/[orgSlug]/layout.tsx:106`, `<h1>` at the fixture page `:145` | correct |
| `/embed/divisions/{id}/standings` — `app/embed/divisions/[id]/[widget]/page.tsx:28` `WIDGETS` includes `standings`; `<table>` at `standings-table.tsx:59`; `seazn:embed:height` at `app/embed/layout.tsx:15` | all correct |
| Zod 4 (`^4.4.3`) accepts the readonly-`as const` arrays passed to `z.enum` | correct |
| `browser.newContext({ storageState: row.auth ? AUTH_STATE : { cookies: [], origins: [] } })` (`:1225`) | closes the "bare `newContext()` is signed in" trap correctly |
| The PNG IHDR width assertion (`:1241`) | genuinely differential — it is the only thing that catches `deviceScaleFactor: 1`, and the plan says so |
| Per-group timeout `30_000 + rows × 20_000` (`:1278`) | a derived budget, not a flat literal — correct per recurring class 20 |
| All seven width project names (`mobile-se`, `mobile-14`, `mobile-320`, `mobile-360`, `mobile-430`, `tablet-768`, `tablet-834`) | correct |

**T1b CI placement (asked for explicitly).** `apps/web/e2e/visual/capture.spec.ts`
is selected by the **`parallel`** project (`apps/web/playwright.config.ts:140`)
— it matches Playwright's default `testMatch` and none of the four
`testIgnore` entries at `:151-157` (`SERIAL_SPECS`, `/mobile\.spec\.ts/`,
`WALKTHROUGH`, and `PARALLEL_HEAVY` only under the `rest` slice). It runs in
**`e2e-parallel`** (`.github/workflows/e2e.yml:103`), matrix legs
`parallel 1/2` and `parallel 2/2` (`:165-173`, `project: parallel`,
`slice: rest`). That workflow triggers on push to `main` and
`workflow_dispatch` only, so PR-T1 gets e2e ONLY via `workflow_dispatch
pr=<n>` — which the plan states correctly at `:1440`.

**Money path.** Confirmed: neither plan touches money. T1 has no Stripe,
credits or ledger code; the credits ledger, `relay-checkout` and the
`stream_pack` webhook branch are R1 (spec §5.2), and W1 lands only the V401
entitlement rows, `false` for all five plans. §5.4's five money mutants are
correctly deferred and are not owed here.

**Test-design checklist, per task.** Mutant tables with named killers: Task 2
Step 9 (four mutants, two of them declared SURVIVORS by name — honest), Task 3
Step 12 (five, one declared a survivor with W1-E named as its future killer).
Tasks 0, 1 and 4 carry none and do not need one (documentation). ≥1 case where
right ≠ wrong constant: Task 2 `#767676` on white (4.5422 correct vs ≈2.05
naive — verified by computation) and Task 3's IHDR width (320 vs 256) — both
genuine. Empty-set stated: `groups: []` and `rows: []` both throw
(`:769`, `:837`), and `paletteFor("cricket")` is the no-overrides case
(`:437`). Negative assertions have positive pairs: `:452-457` (a pair chosen
to fail) and `:770-771` (the minimal manifest is valid). Visual gate fails on
zero images: yes at parse time and at `:1285` — but see finding 9 for the
guard that cannot fire.

---

# Re-review 2026-09-08

Scope: the 17 blockers only, plus the two rejections and the three spec
amendments. Majors and minors were not re-read. Verified against the tree at
`709ec7c3d`, **rebased on `main` `b2244879f`** (confirmed:
`merge-base --is-ancestor b2244879f HEAD` → 0; `run-sheet-edit-time` now
`:407` in this tree; deltas tail still `V399`).

**16 CONFIRMED FIXED · 1 STILL OPEN.**

| # | verdict | evidence |
|---|---|---|
| 1 | CONFIRMED FIXED | `export const OVERLAY_TOKENS = { root, fixed, slate, sportKeys, pairRoles, alphaRoles, paletteFor } as const` at `t1.md:653`, `export type OverlayTokens` beside it; the contrast test now opens `import { OVERLAY_TOKENS } from "../overlay-tokens"` and destructures it; zero `components/overlay/tokens.ts` references remain in either plan. |
| 2 | CONFIRMED FIXED | The deviation is argued at `t1.md:701` (Playwright's rule fires spec→spec only; `mobile.spec.ts:3-24` already imports twenty symbols from `helpers.ts`) and lands as `_INDEX.md` finding **FS-T1a** in Task 0 Step 8(b) (`t1.md:117`), with the owner told at Task 4 sign-off and a one-file fallback if the owner prefers the copy. |
| 3 | CONFIRMED FIXED (one nit) | `t1.md:699,781` now delete `:49-122` exactly, with a `sed -n '49p;91p;122p;124p'` pre-check. Verified on this tree: comment `:49`, function `:91`, brace `:122`, `:123` blank, `:124` the next comment. **Nit:** the post-check at `:781` says `sed -n '49p'` "now prints `/** The scorebug's own clipping gate.`" — after deleting 74 lines it prints the BLANK old `:123`; the comment lands at `:50`. Change to `sed -n '50p'`, and squash the resulting double blank at `:48-49` or Prettier will. |
| 4 | CONFIRMED FIXED | `t1.md:668-674` is a six-row table with the measured ratios (tabletennis `#ff7a80` 2.35; badminton / icehockey / volleyball `#ff6b6b` 2.59; hockey `#ff5a4d` 2.88; tennis `#fa5252` 3.07), and ONE A/B design question to the owner recorded as **FS-T1d** (`t1.md:119`). Matches my own computation exactly. |
| 5 | CONFIRMED FIXED | `t1.md:305` → `expect(blendOver("#f5f0e8", "#150b36", 0.7)).toBe("#b2abb3")`, all three channels shown in the comment. |
| 6 | CONFIRMED FIXED | `t1.md:107-118`: Step 8(a) is verify-only (five greps that must pass on an untouched tree, a miss being a finding rather than a task), 8(b) adds the genuinely-absent `_INDEX.md` T1 row plus FS-T1a/FS-T1c, and the vanished `_STATE.md` sentence is named as gone. |
| 7 | CONFIRMED FIXED | Global Constraints (`t1.md:17`) cite `main` `b2244879f`; Step 1 (`t1.md:72-73`) runs `git fetch origin main && merge-base --is-ancestor origin/main HEAD; UPTODATE=$?` and STOPS the wave on `1` with the rebase-then-baseline order spelled out. Also tightened `test -e .git` → `test -f .git`. |
| 8 | CONFIRMED FIXED | Zero `:377` mount pins remain in either plan; both now carry the SYMBOL `data-testid="run-sheet-edit-time"` with "`:407` on `b2244879f`, grep never seek". T1 Step 8.1's write is gone. The single surviving `:377` (`w1.md:1493`) is a deliberate back-reference explaining finding 46's old wrong pin. |
| 24 | CONFIRMED FIXED | All four mounts named and re-pinned on the rebased tree — verified `<RunSheetRow` at `run-sheet.tsx:355` (day), `:390` (unscheduled), `:428` (settled), `:669` (`RunSheetRowWithRule`, via `{...rest}`). New Step 4(d) adds a mount-count test (three lanes → three toggles, zero when unentitled). |
| 25 | CONFIRMED FIXED | Fifteen `wonBy` occurrences and zero `winner:`/`decision:` in `w1.md`; the RE-PIN paragraph quotes `CricketToss` from `cricket.ts:240-243`. |
| 26 | CONFIRMED FIXED | `w1.md:523` → `["cricket.revise", { oversPerSide: 10, target: 91 }]`, with the expected limit derived as `oversPerSide × cfg.ballsPerOver` from the module's own config and a differential assertion against `innings[0]`. |
| 27 | CONFIRMED FIXED | `w1.md:2499-2500` asserts `stream_url` holds the MAX `ordinal_position` in `public_fixtures_v` rather than a literal, and records why the number moves (23 columns in V369 → 24 today). V369 confirmed still the latest definer on this tree. |
| 28 | CONFIRMED FIXED | Re-pinned to `export const PatchFixture` `:1118` / `export type` `:1144` — **the fixer is right and my `:1081` was pre-rebase**; verified on `b2244879f`. |
| 29 | CONFIRMED FIXED | Re-pinned on the rebased tree and verified symbol by symbol: `expectNoHorizontalScroll:49`, `apiJson:128`, `setBoolEntitlementOverrideSql:518`, `invalidateOrgEntitlements:1013`, `activeOrg:1454`, `addEntrantsViaApi:1598`, `createStageAndGenerate:1615`. **Four of my five "correct" numbers had themselves moved under desk W3** — the fixer's symbol-anchor rule is the right response. |
| 30 | CONFIRMED FIXED | Verified: `scorePadV2AppendSuite(admin, org2.id)` called `scripts/smoke.ts:818` (defined `:17358`), `insertEntitlementOverride:9937`, `html:13356`; `check` is now found by `grep -F` rather than a number. |
| 31 | CONFIRMED FIXED | `e2e-ci-wiring.test.ts:155` everywhere (`w1.md:4926,5564`); confirmed `const WALKTHROUGH_SPECS` is `:155` and `const WALKTHROUGH` is `playwright.config.ts:119` on the rebased tree. |
| **32** | **STILL OPEN** | `w1.md:4676` — see below. |

## 32 — STILL OPEN

The placeholder is gone and the replacement is a genuinely good test: `it.each`
over the whole status table, `aria-expanded="false"` pinning the VALUE the
control opens at, both negative pairs, an `expectRowRendered(html)` guard so an
absence cannot pass by nothing rendering, and a positive pair separating the
stream gate from `run-sheet-edit-time`. One line breaks all of it:

```
const STATUSES = (PatchFixture.shape.status as z.ZodEnum<[string, ...string[]]>).options;
```

Two independent faults, verified at `apps/web/src/server/api-v1/schemas.ts:1118-1144`:

1. **`PatchFixture` has no `status` field.** Its keys are `scheduled_at`,
   `venue_id`, `court_id`, `officials`, `schedule_locked`, `expected_seq`.
2. **`PatchFixture` has no `.shape`.** It is
   `z.object({…}).partial().strict().refine(…)` — a `ZodEffects`, on which
   `.shape` is `undefined`, so `.status` throws `TypeError` at module scope.

A module-scope throw in this repo collects **zero tests and reports green**
(the `PASS(0) FAIL(0)` trap), so the owner's Q6 ruling would ship untested for
the second time, and the failure would not announce itself.

The seven-value enum the plan wants is real and is at the cited line `:1188` —
but it belongs to `export const Fixture = z.object({…})` (`:1154`), a plain
object schema. **Fix:** `import { Fixture } from "@/server/api-v1/schemas";`
and `const STATUSES = Fixture.shape.status.options;` — no cast needed. The
hand-typed seven-value cross-check in the "status table is the whole enum"
case is correct as written and should stay; it is the tripwire for a new
status.

## Rejections — both UPHELD

- **Row 50 (`openapi:gen`).** Rejection correct. `"openapi:gen"` is
  `package.json:45` on `b2244879f`. My `:46` was wrong; the plan needs no
  change.
- **Row 52 (`embed/layout.tsx`).** Rejection correct. `export default function
  EmbedLayout(` is `:24` and `<div className="min-h-4 bg-white p-3">` is `:26`.
  My `:23`/`:25` were both off by one; the plan's `:26` is right, and naming
  `:24` for the function is an improvement.

## Spec amendments FS15–FS17 — all consistent

- **FS15** (`design:1024`) — §2's atlas now reads `globals.css:1135-1141`
  (`design:118`), which is the value on the tree. The T1 plan already had it.
- **FS16** (`design:1025`) — §4.2 (`design:412-418`) now specifies the plan's
  vocabulary in full: GROUPS carrying `mustDiffer`/`controlSetEqual`, rows
  carrying `awaitSelector`, `auth`, `controlRoot`, `checks`, with the reason
  (`/embed` and the public fixture page carry no testids). The T1 prompt is
  amended to match (`T1-theme-and-visual-gate.md:90,108`) and the T1 plan
  records it as FS-T1b (`t1.md:121`). Three documents, one vocabulary.
- **FS17** (`design:1026`) — §3.3 (`design:224-226`) now says
  `presentationNowOffsetMs` is a FIELD on the returned `LiveFixture<T>`,
  "never a module-level export", matching `w1.md:808,1212`.

## Verdict

**Needs one fix.** Sixteen of seventeen blockers are genuinely closed, several
with better answers than the findings asked for — the symbol-anchor rule
(29), the max-`ordinal_position` assertion (27), the derived `ballsLimit`
(26), and the argued deviation with a fallback (2). Blocker 32 is a
one-line change: `Fixture.shape.status.options`. Fix it and the wave is
executable.
