# T1 — theme design (T1a) and the visual gate as code (T1b)

**Wave:** T1 · **PR:** PR-T1 · **Gate to start:** none — runs in parallel with
W1-A / W1-B and MUST land before W1-C (the overlay surface) is dispatched.
**Depends on:** the rebased branch (`feat/stream-overlay` on `main`
`fb99bbd4c`), nothing else. **Worktree:**
`/Users/ashokhein/github/seazn.club/.claude/worktrees/stream-overlay`, env
label `ovl` (`_RULES.md` §Environment). **Model:** `model: opus` on every
dispatch (`_RULES.md` §Agents — the repo's `.claude/agents/*.md:4` say
`sonnet`; this programme overrides by owner ruling). **Plan:**
`../../plans/2026-09-07-streaming-t1.md` (written by a Fable agent; its task
ORDER wins, this file's RULINGS win, a conflict is an `_INDEX.md` finding).

Read first, in this order: the design of record
`../2026-09-07-streaming-programme-design.md` §4 (T1, the authority for every
value below), §3.5–§3.6 (registry, tokens, motion), §5.3 (the Phone-tab states
the credits card covers), §7.5 (slate states), §9a (design patterns), §10;
`_THEMES.md` whole (the sheet T1a extends — same shape, same units);
`_RULES.md` R13, R15, §Repo traps, §Shell guard; `docs/superpowers/RULES.md`
§"Owner checklist (2026-09-07)" (every row named in acceptance below); the
canvas https://claude.ai/code/artifact/2aebcbde-28ba-45ff-9028-1151873e4901
(T1a adds its artboards THERE, never a second canvas).

## Why the wave exists

Owner, 2026-09-07: *"Can we have Wave for designing the theme and testing?"* →
*"Ok"* (design §4, `_INDEX.md` ruling 21). Three surfaces the owner has never
seen (slate, Phone tab, credits card) and one state he has not judged
(decided/void frame) were about to be built from prose. And every earlier
programme's visual gate was an ad-hoc capture that once collected a sign-off on
zero pictures (`AGENTS.md` failure class 10). T1a puts pictures in front of the
owner before code; T1b makes the gate a manifest-driven spec that proves its
own images exist and differ, reusable by W1-E, R2, desk W3 and spectator.

## Owner rulings that bind this wave (verbatim, dated)

- 2026-09-07: *"Can we have Wave for designing the theme and testing?"* → "Ok"
  — this wave exists; T1a and T1b ship together as one PR.
- 2026-09-07, the pasted checklist → "Show ≥2 UI options before building";
  "Verify visually, always"; "Zoom in/out — layout holds at non-100% zoom";
  "Compare control SET (membership/order/repeats), not box size"
  (`RULES.md` §"Owner checklist").
- 2026-09-05: *"I am ok with design"* / *"approve"* — theme `bar` and theme
  `bug` are APPROVED. T1a does not redesign them; it re-shows them only where
  a fact changed (seven tokens F2, the ticking football clock, Barlow 800).
- 2026-09-06 (Q7): *"we will have multiple theme per sports so make it
  abstract and use can choose for now apply the default one"* — the slate is
  a REGISTRY entry (`OVERLAY_THEMES.slate`, `sports: "all"`), designed as one.
- 2026-09-05: *"use OPus SubAgent"* → `model: opus`.

## Scope

### T1a — theme design (documents and canvas; NO product code)

1. **Artboards, ≥ 2 options per un-approved surface**, added to the existing
   canvas (`design` skill), named `T1 · <surface> · Option A|B`:
   - **Slate** (design §7.5): three states — warming, signal lost, ended —
     opaque, full-bleed 1920×1080, the sport palette's `--sport-board` as
     ground, the fixture's two names and the scheduled time in `venueTz`.
   - **Phone tab** (design §5.3, §6.4): idle (balance shown, "Go live"), QR
     shown (≥ 264 px, quiet zone 4 modules, paste-code fallback beneath),
     live with the health line (`fps`, `bitrateKbps`, last beat), ending,
     ended, and failed with reason copy for EACH of `no_inbound_timeout`,
     `machine_crash`, `target_rejected` (with the YouTube fresh-channel ~24 h
     note), `storage_exhausted`, `no_credits`.
   - **Credits / upgrade card** (design §5.3 rows 1–3): no key → the
     `UpgradeGate` card (existing component, `components/upgrade-gate.tsx`,
     re-shown only for placement); key + balance 0 → buy-credits card with the
     three packs 1 / 5 / 20 and the placeholder prices from design §5.2.
   - **Decided / void frame** for `bar` AND `bug`: `result` replacing `chase`,
     live dot off, winner keeps the LED (design §3.11); void statuses render
     the `fixtureStatusLabel` copy.
2. **Widths and zoom, every artboard**: overlay artboards at native 1920×1080;
   panel artboards at 320, 768 and 1280 AND 320 at 125 % zoom (checklist
   "Zoom in/out"). Every overlay frame composited over one light AND one dark
   video frame (OBS will).
3. **Owner picks by letter.** After the pick, values land in `_THEMES.md` in
   the sheet's own shape (inset, type scale, per-state table, hex per token):
   **§4a Slate**, **§8a Phone tab** (extends §8's panel tokens with the
   per-state rows), **§8b Credits card**, and a "decided / void" row appended
   to §3 (bar) and §4 (bug). §2's contrast table gains every new ink-on-board
   pair. §9's wave map gains T1 and the R1/R2 rows. Nothing else in the sheet
   changes — `bar` and `bug` values are approved.
4. **`_INDEX.md`**: the pick recorded as a ruling in the owner's words; a
   T1 row in the wave table.

### T1b — the visual gate as code (lands in the SAME PR)

5. **Manifest** `apps/web/e2e/visual/manifest.json` (new): an array of rows
   `{ id, route, viewport: { width, height }, zoom?: number, backdrop:
   "light" | "dark" | null, awaitTestId, mustDifferFrom?: string[], seed?:
   string }`. `seed` names a seeding recipe the spec knows (`"scorepad-
   cricket"`, `"embed-division"`); a row with no `seed` navigates as-is.
   Seeded TODAY with routes that exist: `/embed/...` (the existing embed
   layout, `app/embed/layout.tsx`) and one scorepad skin at 320 and 1280 — so
   the harness proves itself on real pages before the overlay exists. W1-E and
   R2 ADD rows; they never edit the harness.
6. **Spec** `apps/web/e2e/visual/capture.spec.ts` (new): for every row —
   seed through `apiJson` (`e2e/helpers.ts:128`), open a fresh context at the
   row's viewport (and `deviceScaleFactor`/CSS `zoom` for the 125 % rows),
   navigate, `toBeAttached` on `awaitTestId`, composite the backdrop when set
   (a fixed full-bleed `<div>` injected BEHIND the page's root, light
   `#f4f4f5` / dark `#0a0a0a`), screenshot to
   `<reportDir>/<id>.png` (`reportDir` = `E2E_VISUAL_DIR ??
   ../../.superpowers/sdd/shots/streaming`, the `credits-tab-shots.spec.ts`
   idiom), write `<id>.sha256`. Then, as the LAST test in the file (class 10 —
   the check runs after the state being proven): every declared `<id>.png`
   exists and is > 1 KB; every `mustDifferFrom` pair has different hashes; the
   manifest has no duplicate ids. Empty storageState + `loginUi`
   (`helpers.ts:272`) for organiser rows, exactly as `f3-day-one-shots.spec.ts`
   does, including its cookie-banner pre-dismissal (the banner sat on top of
   the surface once and the DOM assertions still passed).
7. **Assertions** `apps/web/e2e/visual/asserts.ts` (new), each a named export
   the manifest rows opt into via `checks: [...]`, and each ALSO usable by any
   other spec:
   - `expectNoRealClip(page)` — walks every element with `scrollWidth >
     clientWidth + 1`; computed `overflow-x` `auto`/`scroll` → a reachable rail
     (allowed, listed in the report); `hidden`/`visible` → a real clip → fail
     with the element's testid/tag and the two widths (checklist "No
     horizontal scroll … split on overflow-x"; donor `overflowingIn`,
     `mobile.spec.ts:91`).
   - `controlSet(page, scope)` → `string[]` of `data-testid`s in DOM order
     within `scope`; `expectSameControlSet(a, b)` compares membership, order
     AND repeats (checklist "Compare control SET"). Never box sizes.
   - `expectTapTargets(page, scope, min = 44)` — for every `button`, `a`,
     `[role=tab]`, `input` in `scope`: `elementFromPoint` at the box centre
     returns the control or a descendant, and the box is ≥ 44 × 44 (`AGENTS.md`
     class 2: `boundingBox()` measures paint; hit-test with `elementFromPoint`).
   - `expectZoomHolds(page, 1.25)` — sets `document.documentElement.style.zoom`
     and re-runs `expectNoRealClip` (checklist "Zoom in/out").
   - `expectTruncateChain(page)` — every element whose computed
     `text-overflow: ellipsis` has `min-width: 0` (or a non-`auto` min-width)
     on EVERY flex/grid ancestor up to the nearest non-flex block (checklist
     "truncate needs min-w-0 on WHOLE ancestor chain").
   - `expectRailsAccessible(page)` — every element with computed `overflow-x`
     `auto`/`scroll` that actually overflows carries `tabindex="0"`, a `role`
     and an accessible name, UNLESS it contains a focusable child (memory: a
     rail with focusable children passes axe; assert the exemption is that
     kind, print which).
   Each assertion PRINTS what it saw (`_RULES.md` §Verification: "print what
   you saw beside every pass/fail") — the element list, not a boolean.
8. **Contrast unit test** `apps/web/src/components/overlay/__tests__/contrast.test.ts`
   (new) reading ONE exported object `OVERLAY_TOKENS` from
   `apps/web/src/components/overlay/overlay-tokens.ts` (new; the ONLY place the
   `_THEMES.md` hex values exist in code — the sheet's §2 cites the export by
   name after this wave, and a value typed twice is a finding). Method =
   `components/v2/scorepad/v3/__tests__/contrast.test.ts` (the pad's). Floors
   4.5:1 text / 3:1 UI for every ink-on-board pair including the T1a additions
   (slate ground, Phone-tab chips, credits card). Derived, never hand-typed
   (checklist "Derive expected values from the engine's own declarations").
9. **CI wiring — state it, prove it.** `apps/web/e2e/visual/capture.spec.ts`
   sits under `apps/web/e2e/`, is NOT matched by `SERIAL_SPECS`
   (`apps/web/playwright.config.ts:31`), `/mobile\.spec\.ts/`, or
   `WALKTHROUGH` (`:119`), so the `parallel` project's default `testMatch`
   picks it up, and `e2e.yml`'s `e2e-parallel` "rest" slice runs it (the
   catch-all: "a new spec file therefore joins the sharded remainder
   automatically", `playwright.config.ts` comment above `PARALLEL_HEAVY`).
   Prove collection, do not assume it: `npx playwright test --list
   --project=parallel | grep -a visual/capture` shows every row's test title.
   `e2e-ci-wiring.test.ts` (`src/lib/__tests__/`) stays green — it pins the
   catch-all property. The PNGs are artefacts, not assertions, in CI: the
   spec must pass on a runner with no report dir mounted (create it).
10. **`_INDEX.md`**: T1b row; the manifest's initial ids listed; RP for the
    contrast donor.

## Out of scope

Any pixel of overlay product code (`app/overlay/**`, `components/overlay/*.tsx`
other than `overlay-tokens.ts`); the panel; the registry; W2's slab (its
values already exist, §5); sponsor logos (PR3, LAST by ruling, artboard owed
separately); a second canvas.

## Do NOT touch

`_THEMES.md` §1–§8 existing values (append sections and rows only — `bar`
and `bug` are approved); `components/v2/scorepad/**` (import the contrast
METHOD, never edit the pad's test); `mobile.spec.ts` (donor for
`overflowingIn`; copy the logic into `asserts.ts`, do not import a spec from a
spec — Playwright rejects it); `playwright.config.ts` and `.github/workflows/e2e.yml`
(placement is by path, nothing to wire); the engine; any migration; the
design of record.

## Acceptance — all four test kinds, assertions named

- **Unit** (`cd <worktree>/apps/web && npx vitest run components/overlay
  src/lib/__tests__/e2e-ci-wiring.test.ts --reporter=json --outputFile=<scratch>/t1.json`):
  - `contrast.test.ts`: EMPTY case first — `OVERLAY_TOKENS` has ≥ 1 palette
    and every palette names all SEVEN tokens (`board, board-2, ink, led,
    advisory, caution, dismissal`); every ink/led/advisory/caution/dismissal
    on board AND board-2 ≥ 4.5:1 (text) or ≥ 3:1 (UI, LED bar); slate ground
    pairs; the Phone-tab chip pairs; a DIFFERENTIAL case: a deliberately
    failing pair injected in the test proves the floor is enforced (checklist
    "Include ≥ 1 case where right answer differs from the wrong answer's
    constant").
  - `e2e-ci-wiring.test.ts` green unchanged (the catch-all property).
  - **Mutants, each with its killer:** (a) set the LED hex to the board hex in
    `OVERLAY_TOKENS` → contrast test red; (b) delete the `mustDifferFrom`
    check in `capture.spec.ts` → the manifest's `overlay-bar-vs-bug` style
    pair (seeded now with two DIFFERENT existing routes) no longer fails when
    one file is copied over the other in a harness self-test; (c) delete the
    `overflow-x` split in `expectNoRealClip` → the seeded scorepad row at 320
    (which has a reachable rail) goes red; (d) return `true` from
    `expectTapTargets` → a self-test row with a 24 px button injected via
    `page.addStyleTag` stays green → recorded as killed only if it goes red.
- **E2E** (`cd <worktree>/apps/web && PLAYWRIGHT_BASE=<ovl server>
  E2E_PROD_TARGET=1 npx playwright test e2e/visual/capture.spec.ts
  --project=parallel`): every manifest row produces a PNG + sha256; the final
  test asserts existence, size, hash difference, no duplicate ids; the seeded
  scorepad row at 320 passes `expectNoRealClip`, `expectTapTargets`,
  `expectZoomHolds(1.25)`, `expectTruncateChain`, `expectRailsAccessible`;
  the seeded embed row at 320 and 1280 passes `expectSameControlSet`
  (the positive pair: a row deliberately comparing 320 against a DIFFERENT
  route fails, asserted in a harness self-test).
- **Smoke** (`scripts/smoke.ts`, `expectFail` at `:105`): `GET
  /embed/<division>` 200 with the awaited testid in the body — the manifest's
  first row's route is alive on the smoke target.
- **Regression**: whole `mobile.spec.ts` at seven widths unchanged; full
  `apps/web` vitest total ≥ baseline; `npm run openapi:gen` and `pnpm
  i18n:gen-keys` leave no diff (T1 adds no strings — the artboards' copy
  lands with the wave that renders it); `tsc --noEmit` clean.
- **Visual gate (owner sign-off)**: the T1a artboards with the owner's letter
  per surface recorded in `_INDEX.md`; the T1b run's PNGs attached to PR-T1
  with a per-row line saying what was SEEN.

## Checklist rows this wave satisfies (`RULES.md` §"Owner checklist")

VERIFY-AS-CUSTOMER: all nine rows are ENCODED by scope 7 or exercised by scope
1–2 (≥ 2 options, mobile-first artboards at 320 first, control-set diff,
overflow-x split, button/text/card check at every width, 125 % zoom,
`min-w-0` chain, rail `tabindex`/role/name). PRODUCT-OWNER LENS: "Review
findings → written to disk" (`_INDEX.md`), "Show ≥ 2 UI options", "One
authority per fact" (`OVERLAY_TOKENS`). TEST-CASE DESIGN: "Derive expected
values", "≥ 1 differential case", "Empty-set case explicitly", "Negative
assertion needs its positive pair", "Mutate per SURFACE", "Report mutant
KILLER LIST".

## Verify (the orchestrator reruns at the wave boundary)

```
cd /Users/ashokhein/github/seazn.club/.claude/worktrees/stream-overlay/apps/web && \
  DATABASE_URL=postgresql://postgres@127.0.0.1:54405/seazn_ovl DATABASE_SSL=disable \
  npx vitest run components/overlay src/lib/__tests__/e2e-ci-wiring.test.ts \
  --reporter=json --outputFile=/private/tmp/claude-501/-Users-ashokhein-github-seazn-club/<session>/scratchpad/t1-unit.json
cd /Users/ashokhein/github/seazn.club/.claude/worktrees/stream-overlay/apps/web && \
  npx playwright test --list --project=parallel | grep -a "visual/capture"
cd /Users/ashokhein/github/seazn.club/.claude/worktrees/stream-overlay/apps/web && \
  PLAYWRIGHT_BASE=http://127.0.0.1:<ovl port> E2E_PROD_TARGET=1 \
  npx playwright test e2e/visual/capture.spec.ts --project=parallel --reporter=json
```

Judge green only from the JSON (`numPassedTests`, `.testResults[].name`
inside THIS worktree). Final message under 15 lines — counts, paths,
deviations, blockers; no file contents or diffs.

## Dispatch notes

- Lanes: (A) T1a canvas + `_THEMES.md` + `_INDEX.md` (docs; needs the owner's
  pick before its `_THEMES.md` step); (B) T1b `manifest.json` + `capture.spec.ts`
  + `asserts.ts` + `overlay-tokens.ts` + `contrast.test.ts`. A and B are
  disjoint and run in parallel; B's `overlay-tokens.ts` carries `bar`/`bug`
  values from `_THEMES.md` §2 on day one and gains A's values in a follow-up
  commit after the pick.
- The reviewer measures `asserts.ts` against the checklist rows by NAME and
  runs mutants (a)–(d) itself; a survivor is a missing test.
- Shell guard (`_RULES.md`): Write tool, `/usr/bin/git` never by a wave agent,
  `grep -a`, `cd <worktree> &&` on every verify.

## False-premise watch list (re-pin before building)

1. That `deviceScaleFactor` or CSS `zoom` reproduces browser zoom for the 125 %
   rows — pin which one Playwright honours for layout (CSS `zoom` on
   `documentElement` is the fallback; record which was used).
2. That `/embed/<division>` renders a stable testid to await — pin it from
   `app/embed/**`; if none, add ONE `data-testid="embed-root"` and record it.
3. That the pad's contrast method (`scorepad/v3/__tests__/contrast.test.ts`)
   exports a reusable ratio helper — if it is inline, copy the formula into
   `overlay-tokens.ts`'s test and cite the source line.
4. That `e2e-ci-wiring.test.ts` does not ALSO require new spec files to be
   named somewhere (it does for `walkthrough/`; read it for `visual/`).
5. That the parallel project's `storageState: AUTH_STATE` does not break the
   empty-storageState rows — `test.use({ storageState: { cookies: [],
   origins: [] } })` at file level is the `credits-tab-shots` idiom.
