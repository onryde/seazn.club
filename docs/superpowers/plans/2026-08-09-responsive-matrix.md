# Responsive Support Matrix (#349) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Prove and enforce a seven-width responsive matrix (320/360/375/390/430 phones, 768/834 portrait tablets) via Playwright viewport projects, fix everything the new widths surface, fully polish the tablet band, and upgrade the standing screenshot rule to 320+768+desktop.

**Architecture:** Five new Playwright projects run the existing gate file `apps/web/e2e/mobile.spec.ts` unmodified in shape (project-per-width, full suite — owner decision). Tablet findings resolve per-surface: Verdict D (desktop layout fits → targeted `md:` density rules) or Verdict P (cramped → promote that surface's fork `sm:`→`lg:`, tablets get the phone layout, 1280 desktop untouched). Spec: `docs/superpowers/specs/2026-08-09-responsive-matrix-design.md`.

**Tech Stack:** Playwright projects (Desktop Chrome + explicit viewport), Tailwind v4 (`sm` 640 / `md` 768 / `lg` 1024 breakpoints in `apps/web/src/app/globals.css`), Next.js prod-standalone server on :3100.

## Global Constraints

- Work happens in the worktree `/Users/ashokhein/github/seazn.club/.claude/worktrees/responsive-matrix-349` (branch `worktree-responsive-matrix-349`). Prefix every shell call `cd <abs worktree path> && …` — the shell cwd can silently reset to the main checkout between calls.
- Environment bring-up follows the `seazn-local-env` skill (`~/.claude/skills/seazn-local-env/SKILL.md`): fresh throwaway schema (`db:apply` **and** `sync:sports`), prod-standalone build served on :3100, `PLAYWRIGHT_BASE=http://localhost:3100`, cookie host must be `localhost` not `127.0.0.1`. Verify `lsof -t -i :3100` is YOUR server's PID before believing any result. Never touch the local dev DB (:5432).
- Judge every Playwright run only from the JSON reporter (`PLAYWRIGHT_JSON_OUTPUT_NAME` + `numPassedTests`/`numTotalTests`/`pending`), never the rtk summary (`PASS(0) FAIL(0)` can mean "failed to collect"). Confirm `.suites[].specs[].file` / result paths are the worktree's, not main's.
- `readlink -f node_modules` (and `apps/web/node_modules`) before the first run — a symlinked node_modules resolves `@seazn/engine` to MAIN's build.
- No horizontal page scroll at any width; wide tables scroll inside their own `overflow-x-auto` containers only.
- Fix classes at the phone floor: `min-w-0`, `flex-wrap`, `truncate`, padding tightening. No layout redesigns below 480px.
- Layout-only wave: no new user-facing strings expected. If a fix does add copy, it owes all four locale dictionaries (flat dotted-key JSON), never hardcoded English.
- `/admin` surfaces: functional check only — no design polish.
- `e2e.yml` stays disabled. Never enable it. This work merges via PR (smoke CI is PR-only).
- Pre-commit drift gates before the final commit: `npm run openapi:gen`, `npm run i18n:gen-keys`, `npm run schema:snapshot` (if present) — then `git status --porcelain` must be empty.
- Every task's commit message references #349.

---

### Task 1: Make the gate file width-honest (viewport threading, screenshot names, LCP pin)

Three defects block a correct multi-width run; all are in `apps/web/e2e/mobile.spec.ts`.

1. **Anon contexts ignore the project viewport.** The "public surfaces" and "LCP" tests call `browser.newContext()` raw. Raw contexts do NOT inherit project `use` options — they run at Playwright's default 1280×720 in every project. The phone-width public-surfaces gate has therefore never actually run at phone width. (The `page`-fixture tests are unaffected.)
2. **Screenshot filename is hardcoded** — `test-results/publish-gate-sheet-375.png` (line ~388); seven projects would overwrite one file.
3. **LCP must pin to the phone references** (spec §1): it gates load perf, not layout; seven Fast-3G runs add minutes and flake with no layout signal.

**Files:**
- Modify: `apps/web/e2e/mobile.spec.ts`

**Interfaces:**
- Produces: `projectViewport()` helper inside `mobile.spec.ts` — `() => {width: number; height: number} | null`, reads `test.info().project.use.viewport`. Later tasks' width-conditional branches use it.

- [ ] **Step 1: Add the viewport helper near the top of `mobile.spec.ts`** (after imports):

```ts
/** The viewport this PROJECT declares. Raw `browser.newContext()` does not
 *  inherit project `use` options, so every anon context must thread this
 *  through explicitly or it silently runs at Playwright's 1280×720 default. */
const projectViewport = (): { width: number; height: number } | null =>
  (test.info().project.use as { viewport?: { width: number; height: number } })
    .viewport ?? null;
```

- [ ] **Step 2: Thread it into both anon contexts.** In "public surfaces: no horizontal scroll" and "LCP < 2.5s on Fast-3G", change:

```ts
const anonCtx = await browser.newContext();
```

to:

```ts
const anonCtx = await browser.newContext({ viewport: projectViewport() ?? undefined });
```

- [ ] **Step 3: Parametrise the sheet screenshot.** Replace the hardcoded path:

```ts
await page.screenshot({
  path: `test-results/publish-gate-sheet-${test.info().project.name}.png`,
});
```

- [ ] **Step 4: Pin LCP to the phone references.** First line inside the LCP test body:

```ts
const vp = projectViewport();
test.skip(
  !vp || (vp.width !== 375 && vp.width !== 390),
  "LCP gates load perf at the phone reference widths only (spec §1); layout is gated by every project",
);
```

- [ ] **Step 5: Bring up the environment** per `seazn-local-env` (fresh schema with `db:apply` + `sync:sports`, prod-standalone build, server on :3100, `show data_directory` confirmed yours, `lsof -t -i :3100` is your PID). This environment is reused by all later tasks.

- [ ] **Step 6: Run the two existing mobile projects — this is the regression gate for the refactor, and step 2's viewport fix may surface REAL overflow reds on public surfaces that were previously invisible at 1280×720:**

```bash
cd /Users/ashokhein/github/seazn.club/.claude/worktrees/responsive-matrix-349/apps/web && \
PLAYWRIGHT_BASE=http://localhost:3100 \
PLAYWRIGHT_JSON_OUTPUT_NAME=/private/tmp/claude-501/-Users-ashokhein-github-seazn-club/765f72ad-ab4f-40e1-b74f-4a4aa1d581c8/scratchpad/t1.json \
npx playwright test --project=mobile-se --project=mobile-14 --reporter=json; \
jq '{passed:.stats.expected,failed:.stats.unexpected,skipped:.stats.skipped}' /private/tmp/claude-501/-Users-ashokhein-github-seazn-club/765f72ad-ab4f-40e1-b74f-4a4aa1d581c8/scratchpad/t1.json
```

Expected: failed=0 **or** a short list of real public-surface overflows now visible at true phone width. Fix any such red with the Task 3 fix classes before proceeding (they are this task's scope: the refactor exposed them). CONTROL test must pass in both projects.

- [ ] **Step 7: Commit**

```bash
git add apps/web/e2e/mobile.spec.ts && \
git commit -m "test(e2e): thread project viewport into anon contexts, parametrise sheet screenshot, pin LCP to phone refs (#349)"
```

(Include any step-6 overflow fixes in the same commit with their files listed.)

---

### Task 2: Add the five width projects and capture the red inventory

**Files:**
- Modify: `apps/web/playwright.config.ts` (after the `mobile-14` project entry)

**Interfaces:**
- Produces: project names `mobile-320`, `mobile-360`, `mobile-430`, `tablet-768`, `tablet-834` — Tasks 3–6 run them by these exact names.

- [ ] **Step 1: Add five projects** after `mobile-14`, same shape:

```ts
// #349 responsive matrix — the five widths beyond the 375/390 references.
// Full suite per width (owner decision, spec §1): every gate assertion
// holds at every width; LCP self-pins to 375/390 inside the test.
...([
  ["mobile-320", 320, 568],
  ["mobile-360", 360, 800],
  ["mobile-430", 430, 932],
  ["tablet-768", 768, 1024],
  ["tablet-834", 834, 1194],
] as const).map(([name, width, height]) => ({
  name,
  testMatch: /mobile\.spec\.ts/,
  use: {
    ...devices["Desktop Chrome"],
    viewport: { width, height },
    storageState: AUTH_STATE,
  },
  dependencies: ["setup"],
})),
```

(If the existing config style prefers literal entries over a `.map`, write the five literal objects instead — match the file's idiom; `mobile-se`/`mobile-14` are literal today, so literals are the default choice.)

- [ ] **Step 2: Run the three phone projects, JSON out:**

```bash
cd /Users/ashokhein/github/seazn.club/.claude/worktrees/responsive-matrix-349/apps/web && \
PLAYWRIGHT_BASE=http://localhost:3100 \
PLAYWRIGHT_JSON_OUTPUT_NAME=/private/tmp/claude-501/-Users-ashokhein-github-seazn-club/765f72ad-ab4f-40e1-b74f-4a4aa1d581c8/scratchpad/t2-phones.json \
npx playwright test --project=mobile-320 --project=mobile-360 --project=mobile-430 --reporter=json; \
jq '{passed:.stats.expected,failed:.stats.unexpected}' …/t2-phones.json
```

Expected: CONTROL passes ×3; a red inventory at 320 (likely) and possibly 360/430. Each failure message names the culprit element (the helper reports the widest un-contained offender).

- [ ] **Step 3: Run the two tablet projects the same way** (`t2-tablets.json`). Expected: overflow mostly green (tablets have MORE room); possible reds where assertions encode phone-only rendering (bottom sheet vs dialog) — those are Task 4's triage input, do not fix here.

- [ ] **Step 4: Check the org budget.** Five extra projects each mint a competition via the gate file's setup. If any project failed on competition-creation quota (`competitions.max_active` / owned-org cap per `e2e/auth.setup.ts` "ORG BUDGET"), consolidate: hoist the gate file's competition setup so one competition is created per worker run and shared across projects (a `.auth`-style JSON cache file keyed by `TAG`, written by the first project to run it and reused by the rest) — or, if the cap is generous enough, record "budget holds at 7 projects" and move on.

- [ ] **Step 5: Write the red inventory** to `/…/scratchpad/red-inventory.md`: one line per failure — project, test, route, culprit element, error text. This drives Tasks 3 and 4.

- [ ] **Step 6: Commit**

```bash
git add apps/web/playwright.config.ts && \
git commit -m "test(e2e): add mobile-320/360/430 + tablet-768/834 viewport projects (#349)"
```

(Committing config with known reds is intended — Tasks 3–6 turn them green; the branch merges only after Task 8.)

---

### Task 3: Fix the phone-width reds (320 / 360 / 430)

**Files:**
- Modify: whatever components the Task 2 red inventory names (expected: flex rows missing `min-w-0`, unwrapped button groups, untruncated text rows in `apps/web/src/components/**` and `apps/web/src/app/**`)

**Interfaces:**
- Consumes: red inventory from Task 2; `projectViewport()` from Task 1.

- [ ] **Step 1: For each red, reproduce narrowly** — rerun just that test in the failing project:

```bash
cd …/apps/web && PLAYWRIGHT_BASE=http://localhost:3100 \
npx playwright test --project=mobile-320 -g "<test title fragment>" --reporter=line
```

The failure text names the culprit (tag, classes, text snippet). Find it with `git grep` (never bare `grep` under `apps/` — `.next/types` contaminates counts; `grep` may also report "Binary file … matches", use `-a` when forced to plain grep).

- [ ] **Step 2: Apply the smallest fix from the approved classes** — in order of preference:
  1. `min-w-0` on the flex child that refuses to shrink (the classic: a `flex` row whose child contains `truncate` that never engages because the child's implicit `min-width:auto` wins);
  2. `flex-wrap` on button/badge groups;
  3. `truncate` (with `min-w-0` on the parent chain) on text that must stay one-line;
  4. tightened padding (`px-4` → `px-3` etc.) only where 1–3 don't close the gap.

  Never: fixed widths, `overflow-hidden` on the page, redesigns. If a surface genuinely cannot hold at 320 with these tools, stop and escalate to the owner rather than widening scope.

- [ ] **Step 3: Rerun the failing project after each fix** (same command). The width project IS the regression test: red before, green after, permanent in the gate.

- [ ] **Step 4: Screenshot each fixed surface** at 320, 768, and desktop 1280 (§4 standing rule), stored under `/tmp/349/` (owner instruction 2026-08-09: all wave screenshots in /tmp/) — these attach to the PR.

- [ ] **Step 5: Full three-phone-project rerun, JSON out.** Expected: `failed: 0` across mobile-320/360/430, and mobile-se/mobile-14 still green (rerun them too — a 320 fix can regress 375).

- [ ] **Step 6: Commit** (one commit per coherent fix cluster is fine; each message names the width that caught it):

```bash
git commit -m "fix(ui): <surface> holds at 320px — min-w-0 on <element> (#349)"
```

---

### Task 4: Tablet run, screenshot inventory, and the verdict table

**Files:**
- Create: `docs/superpowers/specs/2026-08-09-responsive-matrix-verdicts.md` (the table; columns fixed by spec §3)
- Modify: `apps/web/e2e/mobile.spec.ts` (width-conditional branches where an assertion encodes phone-only rendering)

**Interfaces:**
- Consumes: `projectViewport()` (Task 1), tablet red inventory (Task 2 step 3).
- Produces: verdict table rows `| surface | route | verdict (D/P) | files | screenshots |` — Tasks 5 and 6 implement exactly these rows; Task 8 attaches the file to the PR.

- [ ] **Step 1: Fix phone-only assertions.** For each tablet red that encodes phone rendering (e.g. the publish-gate sheet asserting bottom-sheet placement), branch inside the same test:

```ts
const isPhone = (projectViewport()?.width ?? 1280) < 640; // sm breakpoint
```

Assert the phone shape when `isPhone`, the dialog/desktop shape otherwise. The invariants that hold at EVERY width stay unconditional: element in DOM, content not clipped, no page-level horizontal scroll, ≥44px touch targets.

- [ ] **Step 2: Screenshot every inventory surface at 768 and 834.** Inventory = union of the `mobile.spec.ts` route arrays (console routes ×19, public surfaces ×5, news, axe routes, page smokes) + publish-gate sheet + schedule board. Drive with a throwaway Playwright script in the scratchpad (reuse `e2e/.auth/pro.json` storage state), writing `/tmp/349/tablet/<slug>-{768,834}.png` (owner instruction: all wave screenshots in /tmp/). `/admin` routes: screenshot for the functional check only.

- [ ] **Step 3: Eyeball pass → verdict per surface.** For each surface record D or P in `docs/superpowers/specs/2026-08-09-responsive-matrix-verdicts.md`:
  - **D (desktop layout fits):** structure is right, only density/spacing/column-count needs `md:` band rules.
  - **P (cramped):** sidebar+content collisions, half-collapsed nav (hamburger next to desktop links), toolbars wrapping badly — the phone layout serves tablets better; promote the fork `sm:`→`lg:`.
  - Automatic fails (spec §3): any half-collapsed state is at minimum a D with a fix, usually a P.
  - Known suspects to scrutinise first: org settings sidebar (`apps/web/src/app/o/[orgSlug]/settings/page.tsx`), marketing nav flip (`apps/web/src/components/marketing/mobile-nav.tsx`), console shell, schedule board (`apps/web/src/components/v2/schedule-board.tsx:347` — its `matchMedia("(max-width: 640px)")` JS fork follows its surface's verdict).

- [ ] **Step 4: Commit** the verdict table + any assertion branches:

```bash
git add docs/superpowers/specs/2026-08-09-responsive-matrix-verdicts.md apps/web/e2e/mobile.spec.ts && \
git commit -m "docs+test: tablet verdict table, width-branch phone-only assertions (#349)"
```

---

### Task 5: Verdict-D fixes — `md:` density band

**Files:**
- Modify: the Verdict-D rows' files from the Task 4 table.

**Interfaces:**
- Consumes: verdict table (Task 4).

- [ ] **Step 1: Per D-surface, add targeted `md:` rules** — spacing, density, column counts. Pattern examples (adapt per surface, matching each file's existing Tailwind idiom):
  - grid columns: `grid-cols-1 md:grid-cols-2 lg:grid-cols-3` where tablet currently gets the 3-col desktop grid squeezed;
  - gutters: `md:px-6 lg:px-10` where tablet inherits desktop's wide padding;
  - type/density: `md:text-sm lg:text-base` on data-dense tables tablet renders too large.

  Keep the `sm:` fork untouched on D surfaces — phones are already correct.

- [ ] **Step 2: Re-screenshot each fixed surface at 768/834** (same script as Task 4 step 2), plus 320/desktop (§4 rule). Confirm no horizontal page scroll appears.

- [ ] **Step 3: Rerun `tablet-768` + `tablet-834` projects, JSON out.** Expected `failed: 0`. Rerun `mobile-320` + desktop `parallel` too — `md:` rules must not disturb phones or 1280.

- [ ] **Step 4: Update the verdict table rows** with final files-touched + screenshot refs. Commit per coherent surface cluster:

```bash
git commit -m "fix(ui): <surface> md-band density for tablet portrait (#349)"
```

---

### Task 6: Verdict-P promotions — `sm:` → `lg:` fork moves

**Files:**
- Modify: the Verdict-P rows' files from the Task 4 table; `apps/web/src/components/v2/schedule-board.tsx` if the board is a P.

**Interfaces:**
- Consumes: verdict table (Task 4).

- [ ] **Step 1: Per P-surface, move the mobile/desktop fork.** Mechanically: every `sm:` class that flips this surface between its phone and desktop layout becomes `lg:`. Scope discipline: only the fork classes for THIS surface — shared components used by other surfaces get a wrapper-level override, not an in-component change (changing a shared component's `sm:` moves every consumer's fork).

- [ ] **Step 2: If the schedule board is a P**, move its JS fork with it: `matchMedia("(max-width: 640px)")` → `matchMedia("(max-width: 1023px)")` (lg−1) in `schedule-board.tsx:347`, so the JS and CSS forks stay on the same boundary.

- [ ] **Step 3: Verify all three bands per promoted surface:**
  - `tablet-768` + `tablet-834` green (tablets now render the phone layout);
  - `mobile-320` + `mobile-se` green (phone layout unchanged);
  - desktop `parallel` project green + a 1280 screenshot (the promotion must be invisible at 1280 — `lg`=1024 < 1280; this is the §5 proof).

- [ ] **Step 4: Screenshot each promoted surface at 320/768/desktop + 834.** Update verdict table rows. Commit:

```bash
git commit -m "fix(ui): <surface> keeps phone layout through tablet portrait — fork sm:→lg: (#349)"
```

---

### Task 7: Standing rule upgrade (AGENTS.md + RULES.md)

**Files:**
- Modify: `AGENTS.md` (the "UI work is verified by screenshot at desktop and 375px" bullet in Standing project rules)
- Modify: `docs/superpowers/RULES.md` (the `## UI/UX` section, currently the generic two-liner at ~line 67)

**Interfaces:** none — documentation task.

- [ ] **Step 1: AGENTS.md.** Replace the current bullet:

> UI work is verified by screenshot at desktop **and 375px**, with no horizontal page scroll.

with:

> UI work is verified by screenshot at desktop (1280), **320px**, and **768px**, with no horizontal page scroll at any of them; the seven-width e2e matrix (320/360/375/390/430/768/834, `mobile.spec.ts` projects) is the enforcement backstop.

(Keep the rest of the bullet — `/admin` functional-bar sentence — intact.)

- [ ] **Step 2: RULES.md `## UI/UX`.** Extend the section to:

```markdown
## UI/UX

Every interface works on both desktop AND mobile — responsive layouts,
touch-friendly targets, no desktop-only interactions.

Screenshot-verify every UI change at desktop (1280), 320px, and 768px —
no horizontal page scroll at any of them. Wide tables scroll inside their
own `overflow-x-auto` container, never the page. The seven-width e2e
matrix (`apps/web/e2e/mobile.spec.ts` viewport projects: 320/360/375/390/
430/768/834) is the enforcement backstop. `/admin` stays functional-bar
only.
```

- [ ] **Step 3: Commit**

```bash
git add AGENTS.md docs/superpowers/RULES.md && \
git commit -m "docs: upgrade UI verification rule to 320+768+desktop, matrix as backstop (#349)"
```

---

### Task 8: Full-matrix verification and PR

**Files:** none new (verification + PR assembly).

**Interfaces:**
- Consumes: everything; verdict table + `/tmp/349/` screenshots.

- [ ] **Step 1: Fresh-eyes environment check** — server still yours (`lsof -t -i :3100`), schema still the throwaway one, `git status --porcelain` shows only intended files (a sibling session's dirt reads as your failure).

- [ ] **Step 2: Full run — all projects** (setup, parallel, serial phase per script, all seven viewport projects), JSON out:

```bash
cd …/apps/web && PLAYWRIGHT_BASE=http://localhost:3100 \
PLAYWRIGHT_JSON_OUTPUT_NAME=…/scratchpad/final.json \
npx playwright test --reporter=json; \
jq '{passed:.stats.expected,failed:.stats.unexpected,skipped:.stats.skipped}' …/scratchpad/final.json
```

Then run the serial phase exactly as `npm run test:e2e` does (`--workers=1`) if the full invocation doesn't already. Expected: failed=0; skipped accounted for (LCP skips in 5 of 7 viewport projects are BY DESIGN — 10 skips from that test family, no others unexplained). Confirm result paths are the worktree's.

- [ ] **Step 3: Drift gates:** `npm run openapi:gen`, `npm run i18n:gen-keys`, `npm run schema:snapshot` (skip any script that doesn't exist) → `git status --porcelain` empty after each.

- [ ] **Step 4: Unit/engine suites untouched-check.** This wave changed only `apps/web` UI + e2e + docs; run `npm test --workspace apps/web -- run` with JSON reporter and paste counts (watch: positional args are filename filters — a typo silently subsets; run with NO positional filter).

- [ ] **Step 5: Push branch, open PR** (base `main`) titled `Responsive support matrix: 320–430 phones + 768/834 tablets (#349)`. Body includes: spec + verdict-table links, the JSON counts from step 2 verbatim, screenshot gallery (`/tmp/349/`), the AGENTS/RULES diff summary, and `Closes #349`. End body with the standard generated-with footer.

- [ ] **Step 6: Post-merge memory note** (session owner, not subagent): update `feedback_all_surfaces_mobile.md` / `feedback_ui_visual_approval.md`-adjacent memory to the 320+768+desktop rule once the PR merges — not before.

---

## Self-review notes (done at write time)

- **Spec coverage:** §1→Tasks 1–2 (incl. all four "known consequences": screenshot collision T1, width-conditional assertions T4, LCP pin T1, org budget T2s4); §2→Tasks 2–3; §3→Tasks 4–6 (`/admin` functional-only in T4s2, i18n guard in Global Constraints); §4→Task 7; §5→Task 8 (CONTROL per-project in T2s2, desktop-green proof in T6s3). Out-of-scope list honored (no slideshow/chess/2xl work anywhere).
- **Discovered-work honesty:** Tasks 3, 5, 6 operate on inventories produced by Tasks 2 and 4 — the plan fixes the *process and fix vocabulary*, not imaginary CSS. Known suspects are named with exact paths so the tablet pass starts concrete.
- **Type consistency:** `projectViewport()` defined once (T1s1), consumed T1s4, T4s1. Project names defined T2s1, used verbatim in every run command.
