# ScoringPad v3 — R8 Sweep & Close — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development (fresh subagent per task, reviewer gate between). Steps use checkbox (`- [ ]`) syntax.

**Goal:** Discharge the ScoringPad v3 programme: delete the legacy lane, close every open defect/register row (or defer to a named owner), fix the live dead-end-tap class, back-fill smoke/a11y/width/help coverage, and record the owner's closing sign-off.

**Architecture:** All 11 sports are already on v3 skins (R1–R7). R8 is the final PR. Work is grouped into workstreams; each workstream is one or more reviewable task groups with its own test cycle. Two hard external constraints: (1) the live `r7-f` session owns the cricket empty-headline fix + R7-41 tile-label typing and is mid-flight on `v3/types.ts`, `skins/period-shared.ts`, `skins/{badminton,tabletennis,volleyball,boardgame,generic}.tsx`, `cricket.tsx`, `fixture-console.tsx` — R8 must NOT edit those until r7-f merges, then rebase; (2) every new/redesigned UI surface is shown to the owner with ≥2 options BEFORE building, and every change is verified visually.

**Tech Stack:** TS7, Node 26, pnpm; Next.js (vendored, read `node_modules/next/dist/docs/`); vitest (`environment: node`, no jsdom); Playwright (prod build + `E2E_PROD_TARGET=1` on localhost); engine modules pinned `1.0.0`; zod payload schemas; i18n dicts en/es/fr/nl (flat dotted keys, `pad.*` in `ui.json`).

**Spec:** `docs/superpowers/specs/2026-08-15-scoringpad-v3-prompts/R8-sweep.md` + `_INDEX.md` + `_RULES.md`; design of record `../2026-08-15-scoringpad-v3-redesign-design.md`.

## Global Constraints

- **One PR per wave.** Branch `feat/scorepad-v3-r8-sweep` in worktree `.claude/worktrees/r8-sweep`.
- **Never edit r7-f's files** until it merges: `v3/types.ts`, `skins/period-shared.ts`, `skins/{badminton,tabletennis,volleyball,boardgame,generic}.tsx`, `skins/cricket.tsx`, `fixture-console.tsx`, and tests `headline-ownership.test.ts`/`authority-only-tiles.test.ts`/`band-filter.test.ts`. Ping r7-f before touching `v3/types.ts` or `period-shared.ts`.
- **≥2 UI options to the owner before building** any new/redesigned surface; verify every change visually at 320/768/1280 with no horizontal page scroll; 44px tap-target floor.
- **Every change ships a test that fails without it**; mutation-proof each gate (delete the predicate / return true — still green ⇒ decoration).
- vitest green ONLY via `--reporter=json --outputFile` + jq (`numPassedTests`/`numTotalTests`); `cd apps/web && vitest`, never `--root`. Engine: `cd packages/engine && vitest`. tsc writes its own `EXIT=$?`, `NODE_OPTIONS=--max-old-space-size=6144`. lint via `rtk proxy`, read `✖ N problems`.
- New user-facing strings → all 4 dicts + `i18n:gen-keys` + `i18n:check`; help English-only under `content/help/**`; register new help slugs in `apps/web/src/lib/help.ts`.
- Engine payload change (shot-type chip) ⇒ golden replay + conformance. Attribution-flag change does NOT touch golden (padSpec is not golden-snapshotted — verified).
- Deferred-with-named-owner is allowed by acceptance; deferred-with-nobody is not.

---

## False premises found (record in `_INDEX.md`)

- FP-1: brief says finish `content/help/scoring/fidelity.md` because dual-lane wording is now stale — it already reads the converged single-tier model (`fidelity.md:9-16`), not stale. No rewrite owed; only a re-read.
- FP-2: brief says delete `skins/cricket-skin.tsx` — already deleted in R7/G; the only file left in `skins/` is `types.ts`.
- FP-3: brief (via R5) says swap-sheet shows six identical rows — R7 shipped `CandidateMeta {lead?,tag?}` (`v3/types.ts:770`) and volleyball libero rows are already distinguished (`volleyball.tsx:1550`). Only `football.tsx:1275` and `period-shared.ts:1254` (hockey/icehockey) remain bare.
- FP-4: R9 (scoring-goes-free) is NOT merged (only registered, `fb990e329`) — D-7 (raw fidelity picker) stays open under R9's name, OUT of R8 scope.

---

## Workstream map & sequencing

READY NOW (collision-free with r7-f): A legacy-deletion · B attribution-flag · C #675-recovery(design-gated) · D football-swap-meta · E dead-key-detector · F validateLineup-wiring · G smoke · H a11y · I width-matrix · J help-pages.
BLOCKED on r7-f merge + rebase: K #676-serve-strip(design-gated) · L hockey/icehockey-swap-meta · M mode-indicator-chassis(design-gated, new UI) · N cricket-shot-chip(design-gated, new UI).
CLOSE (last): O register-audit + gates · P gallery + walkthrough + PROGRAMME CLOSED.

Design-gated tasks (C, K, M, N) each begin with an options-first owner gate; their implementation steps are authored after the owner picks. Do not fabricate their final UI code before the pick.

---

## WS-A — Delete the legacy lane

**Files:**
- Modify: `apps/web/src/components/v2/scorepad/v3/registry.ts:184-210` (delete `LEGACY_SPORTS`, the `"legacy"` arm of `PadLaneResolution`, the `if (LEGACY_SPORTS.has…)` branch; keep the throw-on-unowned-key)
- Modify: `apps/web/src/components/v2/scorepad/registry.tsx:243-249` (the `resolvePad` consumer — collapse the `.lane !== "v3"` guard since the union is now a single member)
- Create: migrate `createSkinDispatch` (+ its internal deps `actionsByType`, `actionByType`, `KERNEL_DISPATCHABLE`) from `skins/types.ts:175-300` into a new `v3/skin-dispatch.ts`
- Delete: `apps/web/src/components/v2/scorepad/skins/types.ts` and the now-empty `skins/` directory
- Modify: `v3/pad-host.tsx:61`, `v3/__tests__/pad-host.test.ts:19`, `__tests__/view-model.test.ts:14` (repoint the `createSkinDispatch` import)
- Modify tests: `v3/__tests__/registry-totality.test.ts` (assert v3 lane alone), `__tests__/registry.test.tsx:295-337` (delete the force-legacy mock), `v3/__tests__/period-pair.test.ts:2042`, `skins/__tests__/{boardgame,carrom,generic}.test.ts` (drop `LEGACY_SPORTS` asserts)

**Interfaces:**
- Produces: `resolvePad(key): SkinDefV3` (returns the skin directly, or throws for an unowned key — no `.lane`); `createSkinDispatch` re-homed at `v3/skin-dispatch.ts` with identical signature.

- [ ] **Step 1:** Rewrite `registry-totality.test.ts` first (TDD): assert `resolvePad(k)` returns a skin for every `builtinModules` key and throws for a synthetic unowned key; remove every `LEGACY_SPORTS` reference. Run — expect FAIL (LEGACY_SPORTS still referenced / `.lane` still present).
- [ ] **Step 2:** Migrate `createSkinDispatch` into `v3/skin-dispatch.ts`; repoint the 3 importers. Run those 3 test files — expect PASS.
- [ ] **Step 3:** Delete `LEGACY_SPORTS` + the `"legacy"` arm + branch in `registry.ts`; collapse the consumer guard in `registry.tsx`; delete `skins/types.ts` + dir; drop dead `LEGACY_SPORTS` asserts in the 4 skin/pair tests; delete the force-legacy mock test.
- [ ] **Step 4:** `git grep -a` for `LEGACY_SPORTS`, `RESOLUTION_KIND`, `NO_V2_SKIN_SPORTS`, `skinFor`, `pad-renderer`, `skins/types` — expect zero live hits (comments in e2e are fine but sweep them too). Rerun totality test + full `cd apps/web && vitest run src/components/v2/scorepad` JSON — expect PASS, no collection loss.
- [ ] **Step 5:** tsc (`EXIT=$?`) + lint (`rtk proxy`, `✖ 0`). Commit `chore(scorepad): delete the legacy pad lane, R8 discharge`.

**Mutation check:** re-add a fake sport to `builtinModules` with no skin ⇒ totality test must red on the throw.

---

## WS-B — Attribution required/optional flag (fixes the live dead-end tap)

**Value:** across all 11 sports, tapping an action whose required attribution item is unfilled (e.g. `cricket.toss.wonBy`, `cricket.review.by`, `football.goal.by`) confirms, the engine `strictObject` rejects, and the tap dead-ends with no picker-side warning. This closes it.

**Design:** derive `required` from the engine's own zod schema — do NOT hand-type per sport (drift-prone; memory rule #19). At `padSpec` build, for each `PadAttributionItem` whose `path` is a top-level payload key, set `required` = "that key is non-optional in the action's payload schema". Conformance then asserts the flag equals the schema's required-ness for every action × item.

**Files:**
- Modify: `packages/engine/src/sport/module.ts:265-266` — add `required?: boolean` to both arms of `PadAttributionItem`
- Modify: each sport module's `padSpec` attribution builder to stamp `required` from its own payload schema. Pins: `cricket.ts:2646-2871`, `football.ts:2199-2284`, `generic.ts:283-332`, `boardgame.ts:407-441`, `carrom.ts:590-663`, `nested/kernel.ts:1578-1641` (tennis), `period/kernel.ts:1956-2113` (hockey/icehockey), `setbased/kernel.ts:1658-1718` (badminton/tabletennis/volleyball). Prefer a shared helper (schema-path → required) over 11 copies.
- Modify: `apps/web/src/components/v2/scorepad/view-model.ts:212` — `checkActionValidity` counts a required-but-unfilled attribution item as invalid (blocking Confirm), optional ones remain skippable
- Modify: `apps/web/src/components/v2/scorepad/v3/action-form.tsx:228-260` — mark required attribution rows, and gate Confirm on them (mirror the `fields` gating already there)
- Modify: `packages/engine/src/testkit/conformance-pad.ts:247-271` — add an assertion that each item's `required` flag matches the schema, and that omitting a required item's value is rejected while omitting an optional one is accepted
- Test: `packages/engine/src/sports/cricket/cricket.test.ts` (+ one per other sport as needed), `apps/web/src/components/v2/scorepad/__tests__/view-model.test.ts`, `v3/__tests__/` action-form dom-less builder test

**Interfaces:**
- Produces: `PadAttributionItem.required?: boolean`; `checkActionValidity` returns invalid when a `required` attribution item's path is unfilled.

- [ ] **Step 1 (engine TDD):** In `conformance-pad.ts`, add the assertion "for every action, every attribution item's `required` === (schema key non-optional)". Run engine conformance — expect FAIL (no `required` field yet).
- [ ] **Step 2:** Add `required?` to `PadAttributionItem`; write the shared schema-required helper; stamp `required` in every sport's padSpec attribution. Rerun engine conformance + golden (`cd packages/engine && vitest run` JSON) — expect PASS, golden unchanged (attribution not in golden — verify `git diff` on `*.golden.json` is empty).
- [ ] **Step 3 (app TDD):** Write a `view-model.test.ts` case: an action with a required attribution item unfilled ⇒ `checkActionValidity` invalid; with it filled ⇒ valid; an optional item unfilled ⇒ valid. Run — expect FAIL.
- [ ] **Step 4:** Honour `required` in `checkActionValidity`; gate Confirm + mark the required rows in `action-form.tsx`. Run app builder tests — expect PASS.
- [ ] **Step 5:** e2e — drive the cricket pad (`scorepad-v3-cricket.spec.ts`) through `cricket.toss.wonBy`: confirm is blocked until the side is chosen, then fires (no dead-end). This is the seam's REAL producer→consumer proof. Run vs prod build.
- [ ] **Step 6:** tsc + lint (root AND engine). Commit `fix(scorepad): flag required attribution so a required-unfilled tap no longer dead-ends`.

**Mutation check:** hard-code `required` to always `false` ⇒ Step-3 test and the conformance assertion must red.

**Owner UI note:** marking a required row (asterisk / "required" chip / disabled-Confirm affordance) is a small new UI signal → show ≥2 options before Step 4.

---

## WS-C — #675: recover attribution dropped in the HOLD_MS window  *(design-gated)*

**Defect:** soft-commit drains after `HOLD_MS` (12s default, `queue.ts:139/184`; site `pad-host.tsx:1419`), submitting entrant-only; R7's `isPartialDockAnswer` (`pad-host.tsx:1088`) flags it partial but `activity.tsx:241` offers only `onVoid` — no edit/recovery.

**Files (collision-free):** `v3/activity.tsx`, `v3/pad-host.tsx`, `scorepad/queue.ts`, `v3/detail-dock.tsx`.

- [ ] **Step 1 (OWNER GATE):** produce ≥2 options for recovering a partial event's attribution (e.g. (a) an "add attribution" affordance on the partial ledger row that re-opens the dock; (b) an amend event appended to the ledger; (c) extend the hold / a "still deciding" pin). Present as mockups + trade-offs (each must not corrupt the golden replay). Owner picks. THEN author Steps 2-N.
- [ ] Implementation steps authored post-pick; must ship a test that fails without the recovery path and an e2e that drops then recovers attribution.

---

## WS-D — Football swap-sheet: distinguish "who comes off" rows

**Files:** `apps/web/src/components/v2/scorepad/v3/skins/football.tsx:1275-1303` (`buildSwap` — the `SwapSlot`s carry no `candidateMeta`). Reuse the R7 `CandidateMeta {lead?, tag?}` pattern already in `v3/types.ts:770` and rendered by `context-strip.tsx:92-166` — no new UI, an established pattern applied.

- [ ] **Step 1:** builder test — `buildSwap` for a football fixture returns OFF candidates each carrying `candidateMeta` with a position/role distinguisher. Run — FAIL.
- [ ] **Step 2:** populate `candidateMeta` (position/number) in football `buildSwap`. Run — PASS.
- [ ] **Step 3:** e2e — open the football swap sheet at 320/768, screenshot, confirm rows are visually distinct. tsc + lint. Commit.

Note: hockey/icehockey `buildSwap` (`period-shared.ts:1254`) is the same fix but that file is r7-f's → WS-L, after rebase.

---

## WS-E — Dead `pad.*` dictionary-key detector + sweep

**Finding:** no unused-key detector exists; `i18n:check` is parity-only; `pad.*` keys live only in `ui.json`. Build the detector (a run is not enough — S13 found 160 by sweeping).

**Files:** Create `apps/web/scripts/i18n/find-dead-pad-keys.ts` (enumerate `ui.json` `pad.*` keys, `git grep -a` each literal across `apps/web/src` + `apps/web/e2e`, report unreferenced). Modify `ui.json` ×4 dicts to remove confirmed-dead keys. Wire the detector into `scoring-vocab.test.ts` or a new test so a future dead key reds CI.

- [ ] **Step 1:** write the detector script; run it; capture the dead-key list.
- [ ] **Step 2:** for each candidate, confirm truly dead (not referenced via a computed key — check `PAD_LABEL_KEYS`/`declaredPadLabels()` which the engine can still emit; a key the engine declares is NOT dead even if un-grepped in app code). Remove only genuinely-dead keys from all 4 dicts. `i18n:gen-keys` + `i18n:check`.
- [ ] **Step 3:** add a test asserting zero dead `pad.*` keys (mutation: re-add a junk `pad.zzz` key ⇒ red). tsc + lint. Commit.

---

## WS-F — Wire `validateLineup` into the lineup PUT route (warning-only)

**R7-15, owed R8.** `validateLineup`/`assertLineup` (`packages/engine/src/sport/catalog.ts:73,143`) have zero prod callers. Route: `apps/web/src/app/api/v1/fixtures/[id]/lineups/[entrantId]/route.ts`.

- [ ] **Step 1:** route-handler test — a PUT with a lineup that `validateLineup` flags returns success WITH a warning in the response (warning-only, non-blocking, per R7-17 ruling). Run — FAIL.
- [ ] **Step 2:** call `validateLineup` in the PUT handler, attach warnings to the response, log them (new code ships logging). Run — PASS.
- [ ] **Step 3:** tsc + lint + OpenAPI drift (`npm run openapi:gen` if the response zod moved; `git status --porcelain` empty). Commit.

---

## WS-G — Smoke: drive the v3 pad payloads on pro AND free paths, cricket both lanes

**Finding:** `scripts/smoke.ts`/`smoke-sports.ts` are node-only (no browser) and post events via API — they never exercise the pad's entitlement gating (free vs pro fidelity bands) as the pad produces it. Discharge the debt by covering both entitlement paths and both cricket lanes through the real API with the pad's own payload shapes.

**Files:** `apps/web/scripts/smoke.ts`, `apps/web/scripts/smoke-sports.ts`.

- [ ] **Step 1:** add a smoke section that runs a fixture on the FREE entitlement path and a PRO path, asserting the band-gated actions differ as the pad would gate them (fidelity band from entitlement). Cricket: exercise ball-by-ball (`cricket.ball`) AND over-by-over (`cricket.innings.summary` `partial:true`) — already present via API, assert both explicitly under the pad's payloads.
- [ ] **Step 2:** run `npm run test:smoke && npm run test:smoke:sports` locally against a prod-shaped DB; paste pass output. Commit.

Note: pad-UI rendering coverage is e2e's job (WS-H/I), not node smoke — recorded so the "pad-UI regression invisible to smoke" gap is owned by e2e, not left unnamed.

---

## WS-H — a11y: axe per skin (all 11) + 44px sweep + contrast

**Finding:** 44px sweep exists for `generic` only; 5 sports contrast-only 1-width; badminton/tabletennis/boardgame/carrom/hockey have zero axe.

**Files:** `apps/web/e2e/scorepad-a11y-evidence.spec.ts` (extend `measureHitTargets` + axe to all 11 skins at 320/375/1280), `apps/web/e2e/scorepad-skins.spec.ts` (contrast for the missing skins). Contrast computed from tokens then axe per skin.

- [ ] **Step 1:** parametrise the a11y spec over all 11 sportKeys; each asserts 44px floor + axe contrast at 3 widths. Run vs prod build — capture reds.
- [ ] **Step 2:** fix any genuine 44px / contrast failure found (in-session; if blast radius widens, record + ask). Rerun green.
- [ ] **Step 3:** commit. (Skins touched by r7-f: if a contrast fix lands in one of r7-f's skins, defer that skin's fix to post-rebase and name it.)

---

## WS-I — 7-width matrix: add the 4 missing pads

**Finding:** `mobile.spec.ts` covers 7 of 11 sports; missing icehockey, hockey, carrom, boardgame (zero width coverage).

**Files:** `apps/web/e2e/mobile.spec.ts` (add the 4 sportKeys to the width-matrix drive).

- [ ] **Step 1:** add icehockey/hockey/carrom/boardgame pad drives to `mobile.spec.ts`, asserting no horizontal scroll + 44px at each of the 7 widths.
- [ ] **Step 2:** run the 7 mobile projects vs prod build; fix any width overflow found; rerun green. Commit.

---

## WS-J — Help: 7 missing per-sport scoring pages (English only)

**Finding:** pages exist for cricket/tennis/hockey/football; missing badminton, tabletennis, volleyball, icehockey, carrom, boardgame, generic. `fidelity.md` is fine (FP-1). Registry `help.ts:42-57`.

**Files:** Create `content/help/scoring/{badminton,tabletennis,volleyball,icehockey,carrom,boardgame,generic}.md`; register each slug in `apps/web/src/lib/help.ts`; link from `basics.md` per the per-sport convention.

- [ ] **Step 1:** write each page (what the pad shows, the modes, the actions) matching the existing 4 pages' shape. English only.
- [ ] **Step 2:** register slugs in `help.ts`; a help test asserting every `content/help/scoring/*.md` is registered (mutation: add an unregistered file ⇒ red). Build the help route, screenshot one page. Commit.

---

## WS-K — #676: stop the serve strip blanking during the hold  *(design-gated, BLOCKED on r7-f)*

**Defect:** during the 12s hold, `state` has the tap but `events` lags → `setBasedServeContext` (`setbased/kernel.ts:1377`) reports `ledger-mismatch` → `servingInfo` returns `null` (`badminton.tsx:505`, `tabletennis.tsx:455`) → strip blanks. The "render nothing on disagreement" is deliberate.

- [ ] **Step 1 (OWNER GATE):** ≥2 options — e.g. (a) keep-last-confirmed serve state, dimmed/pending, until the ledger catches up; (b) drive serve context from optimistic `state` during the hold with a pending marker; (c) show an explicit "confirming…" chip. Present mockups + trade-offs (must not show a WRONG server). Owner picks.
- [ ] Implementation after r7-f merges + rebase (files overlap r7-f: badminton/tabletennis/types.ts/kernel). Ships a test that fails without it + an e2e proving the strip stays populated through a rally.

---

## WS-L — Hockey/icehockey swap-sheet meta  *(BLOCKED on r7-f)*

Same fix as WS-D, in `skins/period-shared.ts:1254` `buildSwap` (r7-f's file). After rebase: populate `candidateMeta` for the 6-on-ice pool; builder test + e2e screenshot. Ping r7-f / confirm merged first.

---

## WS-M — Mode-indicator chassis affordance (every sport)  *(design-gated, new UI, BLOCKED on r7-f)*

**Owner ruling:** a chassis mode/context chip slot every sport gets — resolves D2 (cricket ball-by-ball vs over-by-over unreadable) generally. Needs a new field in `v3/types.ts` (r7-f's file) + a chip slot in the shared chassis + a per-skin mode resolver.

- [ ] **Step 1 (OWNER GATE):** ≥2 options for the chip (placement in the scorebug/context strip, wording per sport, empty state). Cricket must read "Ball-by-ball"/"Over-by-over"; the other 10 supply their own mode label or opt out. Present mockups across ≥3 sports. Owner picks.
- [ ] Implementation after r7-f merges + rebase. Chassis type + renderer + per-skin resolver; builder tests + e2e + gallery states; all 4 dicts for any new copy.

---

## WS-N — Cricket shot-type dock chip  *(design-gated, new UI, engine payload, BLOCKED on r7-f)*

**Spec §3 enrichment.** `CricketBall` (`cricket.ts:179`) is a `strictObject` with no shot-type field. Adding it is a payload change ⇒ golden + conformance.

- [ ] **Step 1 (OWNER GATE):** ≥2 options for the dock chip (shot-type taxonomy + chip layout in `detail-dock.tsx`/`cricket.tsx`). Owner picks the taxonomy and UI.
- [ ] Implementation after r7-f merges + rebase: add the optional field to `CricketBall`; render the chip; golden re-baseline (documented, not silent) + conformance; builder test + e2e. Copy → 4 dicts.

---

## WS-O — Register audit + programme gates

- [ ] Walk every spec §8 D-row: closed, or carries a recorded reason + named owner in `_INDEX.md`. Spot-check every GF mapped section against the shipped UI (drive it, don't grep).
- [ ] Verify the event-copy gate reds on a missing `pad.<sport>.ribbon` key (mutate `scoring-vocab.ts:670` set / a dict, confirm `scoring-vocab.test.ts:322` reds, revert).
- [ ] `i18n:check` clean; `i18n:gen-keys` no drift; `git status --porcelain` empty. OpenAPI drift clean.
- [ ] Full programme gate: `cd apps/web && vitest run` JSON counts pasted; `cd packages/engine && vitest run` JSON; tsc EXIT=0 (root + engine); lint `✖ 0` (root + engine). Rerun any flaky-shaped suite 3×.

---

## WS-P — Close: gallery, walkthrough, PROGRAMME CLOSED

- [ ] Run the 12-capture gallery (`GALLERY_DIR=<dir> npx playwright test --project=gallery`); publish the artifact; confirm images exist and DIFFER.
- [ ] Full owner walkthrough — server up, login link minted — per-screen verdicts for all 11 skins + the R2c-carried screens (`08-bowlerpicker`/`09-retiresheet`/`10-reviewblocked`). Record verdicts in `_INDEX.md`.
- [ ] `_INDEX.md`: PROGRAMME CLOSED section (v2-style) — final status, every ruling, every false premise, register close-out, deferred-with-owner list (R9/D-7, and any WS deferred).
- [ ] Update the smoke demo if user-visible; help pages shipped (WS-J).
- [ ] Memory written + `scripts/agent-memory-snapshot.sh`.

---

## Self-review notes

- Spec coverage: R8-sweep.md bullets → WS mapping — legacy delete=A; v2-spec reconciliation/dead keys=A+E; smoke=G; i18n+event-copy gate=E+O; a11y=H; 7-width=I; help=J; gallery+walkthrough=P; register audit=O; PROGRAMME CLOSED=P. Inherited-from-R2: attribution flag=B; shot chip=N; cricket-skin delete=A(done, FP-2); smoke=G; fidelity.md=J(FP-1); event-copy gate=E/O. Inherited-from-R2b: mode indicator=M; cricket smoke both lanes=G; "pad offers what engine refuses"=B (the general class). Owner-ruled adds: #675=C, #676=K, swap-sheet=D+L, R7-41=owned by r7-f.
- Design-gated tasks (C,K,M,N) intentionally carry no final UI code — owner picks first (standing rule). Not a placeholder violation: the deliverable of their Step 1 is the options, not code.
