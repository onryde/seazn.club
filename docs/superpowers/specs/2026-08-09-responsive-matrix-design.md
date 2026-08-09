# Responsive support matrix: 320–430px phones + 768–834px portrait tablets

- **Date:** 2026-08-09
- **Issue:** [#349](https://github.com/ashokhein/seazn.club/issues/349)
- **Status:** Approved (design walked through with owner 2026-08-09)
- **Prerequisite:** #325 (`expectNoHorizontalScroll` cannot fail) — **already closed 2026-07-29**. The helper in `apps/web/e2e/helpers.ts` is geometry-based (forces `overflow-x: visible`, measures `scrollWidth` vs `clientWidth`, reports the widest un-contained culprit) and `mobile.spec.ts` carries a CONTROL test proving the check can fail. Item 1 of the issue's proposed work is therefore done and out of this spec.

## Goal

Widen the verified responsive surface from two widths (375px phone, 1280px desktop) to a seven-width device matrix, prove it at runtime, polish the tablet band fully, and upgrade the standing screenshot-verification rule.

| Class | Width × height | Devices |
|---|---|---|
| Legacy phone floor | 320×568 | iPhone SE 1st gen, older compacts |
| Standard Android | 360×800 | Most Android, entry-level phones |
| Current references | 375×667, 390×844 | already covered (`mobile-se`, `mobile-14`) |
| Pro Max class | 430×932 | iPhone 14/15/16 Pro Max |
| iPad portrait | 768×1024 | Standard iPad |
| Larger portrait tablets | 834×1194 | iPad Air/Pro 11", larger Androids |

## Current state (verified 2026-08-09)

- **Breakpoints:** Tailwind v4 in `apps/web/src/app/globals.css` — custom `xs` 480, defaults `sm` 640 / `md` 768 / `lg` 1024 / `xl` 1280. Dominant mobile/desktop fork is `sm:` (291 usages); `md:` 28, `lg:` 34. Four CSS `@media` rules at 640px, one `matchMedia("(max-width: 640px)")` in `src/components/v2/schedule-board.tsx:347`. No container queries.
- **Test coverage:** `apps/web/playwright.config.ts` — `mobile-se` 375×667 and `mobile-14` 390×844 run `e2e/mobile.spec.ts` (510 lines: overflow gate routes, axe, LCP, page smokes, publish-gate sheet, z3 schedule actions). Nothing runs at 320, 360, 430, 768, or 834.
- **Static 320px audit (issue, 2026-07-28):** clean — all 41 tables in scroll wrappers, modals collapse to bottom sheets under `sm`. Never proven at runtime.

## Decisions (owner, 2026-08-09)

1. **Run shape: Playwright project per width, full suite.** Five new projects, each running the whole of `mobile.spec.ts` — not a trimmed overflow-only sweep. Accepted cost: roughly 3.5× the mobile-phase wall time. Maximum fidelity; every gate assertion holds at every width.
2. **Tablet band: full polish in-wave.** Every density/spacing finding at 768/834 is fixed in this wave, not just overflow and broken layouts. Matches the owner UI bar (full polish on every surface except `/admin`).
3. **Standing rule: 320 + 768 + desktop.** The per-UI-change screenshot rule upgrades from "desktop + 375" to "desktop + 320 + 768". The 320 squeeze subsumes 375's failure modes; 768 covers the `md:` boundary; the e2e matrix is the backstop for the rest.
4. **Tablet mechanism: per-surface verdict.** No wholesale breakpoint migration, no container-query rollout. Each surface gets one of two verdicts (below).

## §1 Playwright matrix

`apps/web/playwright.config.ts` gains five projects, identical in shape to `mobile-se` (Desktop Chrome device, explicit viewport, `storageState: AUTH_STATE`, `dependencies: ["setup"]`, `testMatch: /mobile\.spec\.ts/`):

| Project | Viewport |
|---|---|
| `mobile-320` | 320×568 |
| `mobile-360` | 360×800 |
| `mobile-430` | 430×932 |
| `tablet-768` | 768×1024 |
| `tablet-834` | 834×1194 |

`mobile-se` and `mobile-14` stay unchanged. Desktop `parallel`/`serial` projects stay unchanged.

### Known consequences, handled in this wave

- **Screenshot filename collision.** `mobile.spec.ts:388` writes `test-results/publish-gate-sheet-375.png` regardless of project; seven projects would overwrite one file. Parametrise with `test.info().project.name`.
- **Width-conditional rendering.** At 768/834 the publish-gate confirm renders as a desktop dialog, not a bottom sheet (`sm` = 640 boundary); similar flips apply to modals and the bottom bar. Existing assertions are mostly width-agnostic (element in DOM, content not clipped, page not scrolling sideways). Where an assertion is genuinely phone-only or tablet-only, the test branches on `page.viewportSize()!.width < 640` inside the same test — no forked spec files.
- **LCP test pinned to phone references.** The Fast-3G LCP test (`mobile.spec.ts:266`) guards on width and runs only in the 375/390 projects. It gates load performance, not layout; running it seven times adds minutes of throttled runs and flake exposure with no layout signal. All other tests run at all seven widths.
- **Org quota.** `mobile.spec.ts` mints a competition per project run against the shared Pro org budget (`e2e/auth.setup.ts`, "ORG BUDGET"). Five more projects may trip the cap. Verify during implementation; if it trips, consolidate the gate file's setup so projects share one competition where safe.

## §2 Sweep and triage

1. Bring up DB + prod server per the `seazn-local-env` skill (standalone build, :3100 recipe).
2. Run the five new projects. Judge results only from `--reporter=json --outputFile` (`numPassedTests`/`numTotalTests`) — never the rtk summary.
3. Every red is a real, previously-invisible defect (the helper is proven able to fail). Expected 320px fix classes: `min-w-0` on flex children, `flex-wrap`, `truncate`, tightened padding — **no layout redesigns at the phone floor**.
4. Each fix's regression test is the width project that caught it: the fix lands, the project goes green, and the project stays in the gate permanently.

## §3 Tablet polish (768 / 834)

Full pass over every gate-route surface at both tablet widths, screenshot each, then a recorded verdict per surface. The surface inventory is the union of the route arrays already in `mobile.spec.ts` (console routes, public surfaces, news, axe, page smokes) plus the publish-gate sheet and schedule board — the implementation plan enumerates them.

- **Verdict D — desktop layout fits.** Targeted `md:` band rules for spacing, density, column counts. Surface keeps its desktop structure at tablet width.
- **Verdict P — desktop layout cramped.** Promote that surface's mobile/desktop fork `sm:` → `lg:`. Tablets keep the phone layout; desktop at 1280 is untouched (`lg` = 1024 < 1280). The desktop e2e projects staying green is the proof.

Known suspects (from the issue audit; not exhaustive):

- Org settings sidebar — `app/o/[orgSlug]/settings/page.tsx`
- Marketing nav hamburger→full-nav flip — `components/marketing/mobile-nav.tsx`
- Console shell (sidebar/nav treatment at exactly 768)
- Schedule board JS fork — `src/components/v2/schedule-board.tsx:347` `matchMedia("(max-width: 640px)")` gets the same verdict as its surface; if the surface promotes to `lg`, the matchMedia threshold moves with it.

Rules of the pass:

- The verdict table (surface → verdict → files touched → screenshot refs) is produced during implementation and attached to the PR; the spec defines its columns, not its rows.
- `/admin` surfaces: functional check only — no polish (owner rule).
- No half-collapsed states anywhere: hamburger next to desktop nav, sidebar overlapping content, etc. are automatic fails.
- Layout-only work — no new user-facing strings expected. Any fix that does add copy owes all four locale dictionaries per the standing i18n rule.
- Screenshots at both 768 and 834 for every surface touched, plus 320/768/desktop screenshots (§4 rule) for every surface changed.

## §4 Standing rule upgrade

`docs/superpowers/RULES.md`: the per-UI-change verification rule changes from "screenshot at desktop + 375px" to:

> Every UI change is screenshot-verified at **desktop (1280), 320px, and 768px**, with no horizontal page scroll at any of them. The seven-width e2e matrix is the enforcement backstop.

375/390 remain in the e2e gate; they simply stop being the manual-verification widths.

## §5 Verification

- All seven viewport projects green locally against a prod-standalone build; raw counts pasted from the JSON reporter, `.testResults[].name` paths confirmed to be the worktree's (cwd-reset trap).
- The CONTROL test (`mobile.spec.ts:25`) stays and passes in every project — the check can still fail at every width.
- Desktop `parallel`/`serial` projects stay green — proves Verdict-P `sm:`→`lg:` promotions did not disturb 1280.
- Wide tables scroll inside their own `overflow-x-auto` containers at every width; page-level horizontal scroll never appears.
- Tablet verdict table + screenshots attached to the PR.
- Owner test-type rule applied: the e2e width projects are the unit + regression layer for CSS-only changes; smoke suite unchanged; no behavior-logic changes expected (schedule-board matchMedia threshold move is covered by that surface's e2e assertions at phone, tablet, and desktop widths).
- `e2e.yml` stays disabled by owner policy — enforcement is local runs + PR-time verification. Smoke CI runs on PRs only, so this work merges via PR, not a local merge push.

## Out of scope

- Landscape tablet / desktop widths above 1280 (`2xl` unused; no demand).
- Venue slideshow / TV surfaces (`v2/slideshow.tsx`) — fixed-width by design.
- Chess-quest game canvas (own `window.innerWidth` sizing).
- `/admin` design polish — functional bar only.
- Container queries — revisit only if the per-surface verdicts start accumulating contradictory `md:`/`lg:` rules on shared components.

## Refs

- #349 — this programme
- #325 — helper rewrite (closed; CONTROL test is the living proof)
- Owner rule v17 SPEC-6 (2026-07-25) — superseded by §4 on merge
