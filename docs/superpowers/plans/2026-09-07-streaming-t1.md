# Streaming T1 — Theme Design and the Visual Gate — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Land the programme's Task 0 (environment, baseline, corpus corrections), the T1a theme design (≥2 owner options per un-approved surface, values into `_THEMES.md`), and the T1b visual gate as code (a manifest-driven Playwright capture harness plus a derived contrast test) — proven on routes that exist today, before W1-C builds a single overlay pixel.

**Architecture:** T1a is documentation and a design canvas: the owner picks by letter and the picked column is copied into `_THEMES.md` in the sheet's own shape. T1b is three small units: `components/overlay/overlay-tokens.ts` exports the overlay's colour authority (root defaults mirrored from `globals.css` and PROVEN equal by a test, the fixed colours, the slate values, and the pair ROLES the contrast test enumerates per sport); `lib/contrast.ts` is the WCAG formula; `e2e/visual/` is a manifest (`manifest.json`, validated by zod in `manifest.ts`), a seed table (`seeds.ts` — the ONE extension point later waves touch), reusable checklist assertions (`asserts.ts`), and the spec that walks the manifest (`capture.spec.ts`). The spec lives under `e2e/visual/` as a `.spec.ts` so the parallel project's catch-all "rest" leg runs it in CI with no config edit (proven by `e2e-ci-wiring.test.ts`); locally `VISUAL_DIR` points the PNGs somewhere durable.

**Tech Stack:** Next.js App Router, React 19, TypeScript, Tailwind v4 + `app/globals.css` custom properties, Zod 4, vitest (`environment: "node"`), Playwright 1.61 (`@axe-core/playwright` available), `scripts/smoke.ts`, the `design` skill (canvas artifact).

**Spec:** `docs/superpowers/specs/2026-09-07-streaming-programme-design.md` — §2 (atlas), §4 (T1), §9a (patterns every task names), §10 (testing), §11 (plan structure), §13 (findings). Binding values: `docs/superpowers/specs/2026-09-05-stream-overlay-prompts/_THEMES.md`. Owner checklist: `docs/superpowers/RULES.md` §"Owner checklist (2026-09-07)" — every task below names the rows it satisfies.

**Sibling plan (keep names/types compatible):** `docs/superpowers/plans/2026-09-05-stream-overlay-w1.md` (amended 2026-09-07 — Task 0 there is the overlay endpoint; Task 5 there IMPORTS `overlay-tokens.ts` and EXTENDS `contrast.test.ts` from this plan; Task 8 there ADDS manifest rows and a seed kind, never harness code).

## Global Constraints

- Worktree: `/Users/ashokhein/github/seazn.club/.claude/worktrees/stream-overlay`, branch `feat/stream-overlay`, rebased on `main` `b2244879f` (HEAD `d7431892b` at review time, 2026-09-08 — desk W3 #740 and settings W8 #744 are IN this tree; Task 0 Step 1 refuses to proceed if `main` has moved again). Prefix EVERY shell command with `cd /Users/ashokhein/github/seazn.club/.claude/worktrees/stream-overlay &&` in the SAME call (cwd resets between calls). Run git as `/usr/bin/git`. Never `git stash` here. No heredocs — the Write tool writes files. `grep -a`.
- `pnpm`, never `npm install`. A fresh worktree has NO `node_modules` (Task 0 installs) and NO `.env.local` (Task 0 symlinks both).
- Judge vitest ONLY from `--reporter=json --outputFile=<file>`: read `numPassedTests` / `numTotalTests` / `numFailedTests` with `node -e`, and confirm `.testResults[].name` resolves under the worktree. `rtk` prints `PASS(0) FAIL(0)` for a suite that failed to collect. JSON reports go to `/private/tmp/claude-501/-Users-ashokhein-github-seazn-club/b30673ed-f5cd-42f4-b756-805514a83656/scratchpad/t1/` (`mkdir -p` once; a bare `/tmp` path collides across sessions).
- DB-backed tests need `DATABASE_URL=… DATABASE_SSL=disable` INLINE on the command (~700 tests skip silently without it and `total` does not move). The `ovl` label's URL is printed by `~/.claude/skills/seazn-local-env/scripts/seazn-env.sh env --label ovl` — read it as a plain call, `eval` is refused.
- Playwright runs from `apps/web` with `PLAYWRIGHT_BASE=<ovl base>` and `E2E_PROD_TARGET=1` (`seazn-env.sh up --label ovl --server`); `seazn-env.sh rebuild --label ovl` after every code change — a second `up --server` serves the OLD bundle. Run the WHOLE spec file, never a `-g` slice.
- Migrations: deltas run to `V399__stats_player_career_split.sql` on `main` at `fb99bbd4c`. T1 creates NO migration. `ls db/migration/deltas | sort -V | tail -1` is re-run at Task 0 and recorded; W1 takes V400/V401 at its own rebase.
- Every user-facing string in all four dictionaries (`apps/web/src/dictionaries/{en,fr,es,nl}/`), then `pnpm i18n:gen-keys`; `lib/i18n-keys.ts` is GENERATED. T1 adds NO user-facing string (the harness and tokens are test/design infrastructure; the T1a copy lands as `_THEMES.md` values and is keyed by W1/R1 when rendered).
- One DOM branched with `max-md:*` / `md:hidden`; identical control SET at 320 and 1280; no horizontal page scroll at 320/360/375/390/430/768/834. `/\bmd:hidden\b/` also matches inside `max-md:hidden` — anchor on `\s...hidden"`.
- Every subagent dispatch passes `model: opus` explicitly (owner instruction 2026-09-05; the agent frontmatter reads `sonnet`).
- Do NOT touch: `components/v2/scorepad/**` (import from `sport-theme.ts`, never edit it — `overlay-tokens.ts` mirrors and PROVES, it does not move anything), `packages/engine/**`, `db/**`, `.github/workflows/e2e.yml` (the harness joins CI through the existing catch-all leg — that is the design, and the wiring test proves it), `ENTITLEMENT_DOMAINS`, any pricing surface, `app/embed/**`'s components (the harness photographs them, it does not edit them), `LiveScore`.
- Patterns this plan invokes, with their exemplars (spec §9a): one authority per fact (`globals.css` is the colour authority; `overlay-tokens.ts` is a typed mirror PROVEN equal by `contrast.test.ts`, the pad's own `overlay-tokens.ts`/`contrast.test.ts` pairing at `components/v2/scorepad/v3/`); registry over branching (`OVERLAY_PAIR_ROLES` is a table the test walks, never a per-sport branch); deny by default (`parseManifest` rejects an unknown check, an unknown seed kind, an unresolved route placeholder — the harness never guesses); the visual gate's own vacuous mode (recurring class 10: every group asserts its image COUNT, its hashes DIFFER where declared, and the last assertion runs after the state proven).

## File Structure

| File | Create / Modify | Responsibility |
|---|---|---|
| `docs/superpowers/specs/2026-09-05-stream-overlay-prompts/_STATE.md` | Modify (Task 0, Task 4) | Environment block (ovl URL, baseline counts, deltas tail), Task 0 done-marks |
| `docs/superpowers/specs/2026-09-05-stream-overlay-prompts/W1-step-one.md` | Modify (Task 0) | Pin corrections IN PLACE, each annotated "(re-pinned 2026-09-07 @ fb99bbd4c)" |
| `docs/superpowers/specs/2026-09-05-stream-overlay-prompts/W2-moments.md` | Modify (Task 0) | F3 (volleyball set & match point) on the allowlist row; F4 (referent = the overlay endpoint) in the RE-PIN table |
| `docs/superpowers/specs/2026-09-05-stream-overlay-prompts/_RULES.md` | Modify (Task 0) | R16 ten hosts → eleven (owner Q5), annotated |
| `docs/superpowers/specs/2026-09-05-stream-overlay-prompts/_INDEX.md` | Modify (Task 0, Task 4) | Status rows (W1 plan amended; T1 row), findings from this wave |
| `docs/superpowers/specs/2026-09-05-stream-overlay-prompts/_THEMES.md` | Modify (Task 1) | New §4a slate, §8a Phone tab, §8b credits card, decided/void rows in §3 and §4, contrast rows in §2 — the picked option's values |
| `apps/web/src/lib/contrast.ts` | Create (Task 2) | `contrastRatio(hexA, hexB)` (WCAG 2.x), `blendOver(fgHex, bgHex, alpha)` |
| `apps/web/src/lib/__tests__/contrast.test.ts` | Create (Task 2) | The formula's known extremes AND the gamma-differential pair (`#767676` on white) |
| `apps/web/src/components/overlay/overlay-tokens.ts` | Create (Task 2) | **`OVERLAY_TOKENS`** — the ONE exported object (`{ root, fixed, slate, sportKeys, pairRoles, alphaRoles, paletteFor }`) the corpus binds on — plus the granular `ROOT_SPORT_DEFAULTS`, `OVERLAY_FIXED`, `SLATE_TOKENS`, `paletteFor(sportKey)`, `OVERLAY_SPORT_KEYS`, `OVERLAY_PAIR_ROLES`, `OVERLAY_ALPHA_ROLES` for type reuse |
| `apps/web/src/components/overlay/__tests__/contrast.test.ts` | Create (Task 2) | Root defaults ≡ `globals.css` (parsed, `var()` resolved); every role × every sport ≥ its floor; slate pairs; alpha text pairs |
| `apps/web/e2e/helpers.ts` | Modify (Task 3) | `overflowingIn` MOVED here from `mobile.spec.ts` and exported (one authority) |
| `apps/web/e2e/mobile.spec.ts` | Modify (Task 3) | Imports `overflowingIn` from `./helpers`; local definition deleted; nothing else |
| `apps/web/e2e/visual/manifest.ts` | Create (Task 3) | `SEED_KINDS` + `SEED_PARAMS` (the pure tables), types + zod schema + `parseManifest(json)` + `resolveRoute(template, params)` |
| `apps/web/e2e/visual/manifest.json` | Create (Task 3) | The rows: today `public-fixture` (320 / 768 / 1280 / 320 @ 125 %) and `embed-standings` (768); W1-E and R2 append |
| `apps/web/e2e/visual/seeds.ts` | Create (Task 3) | `seedFor(kind, page)` — the RECIPES; a later wave adds one entry to `manifest.ts`'s two tables and one `case` here — the ONE extension point |
| `apps/web/e2e/visual/asserts.ts` | Create (Task 3) | `controlSet`, `expectNoClip`, `expectHitTargetsByPoint`, `expectTruncateChain`, `expectRailsA11y`, `applyBackdrop` |
| `apps/web/e2e/visual/capture.spec.ts` | Create (Task 3) | Walks the manifest: seed → context per row (viewport ÷ zoom, `deviceScaleFactor` = zoom) → await → backdrop → PNG + sha256 → checks → group assertions → `report.json` |
| `apps/web/src/lib/__tests__/visual-manifest.test.ts` | Create (Task 3) | Unit: the committed manifest parses; ids unique; every `mustDiffer` / `controlSetEqual` reference exists; every route placeholder is provided by its seed kind; ≥ 1 group; the wiring test still selects `visual/capture.spec.ts` in a CI leg |
| `scripts/smoke.ts` | Modify (Task 3) | `visualSeedRoutesSuite` — the two seeded routes answer 200 with the markup the manifest awaits |
| `docs/runbooks/visual-gate.md` | Create (Task 3) | How to run the harness locally, where the PNGs land, how a later wave adds rows and a seed kind |

---

### Task 0: Programme Task 0 — environment, baseline, corpus corrections

**Files:**
- Modify: `docs/superpowers/specs/2026-09-05-stream-overlay-prompts/_STATE.md` — the "Where the work lives" block and a new "Environment (label `ovl`, 2026-09-07)" block
- Modify: `docs/superpowers/specs/2026-09-05-stream-overlay-prompts/W1-step-one.md` — pins listed in Step 8
- Modify: `docs/superpowers/specs/2026-09-05-stream-overlay-prompts/W2-moments.md` — F3, F4
- Modify: `docs/superpowers/specs/2026-09-05-stream-overlay-prompts/_RULES.md` — R16
- Modify: `docs/superpowers/specs/2026-09-05-stream-overlay-prompts/_INDEX.md` — status rows

**Interfaces:**
- Consumes: `~/.claude/skills/seazn-local-env/scripts/seazn-env.sh` (`up | env | status | rebuild | down`, per label); `~/.claude/skills/seazn-local-env/SKILL.md` §"What `up` does NOT do" (the four gaps: `pnpm install --frozen-lockfile`, both `.env.local` symlinks, `seed:demo`, running the gate yourself).
- Produces: a running `ovl` database + prod server; `baseline-web.json` at the scratchpad; `_STATE.md`'s environment block with the counts; the corpus corrections every later brief cites.

**Checklist rows satisfied:** "One authority per fact" (the baseline is ONE JSON file, cited by path); "Review findings → written to disk" (every correction lands in the corpus, annotated); "A comment in code is a HYPOTHESIS" (Step 7 reproduces Q12's two reds instead of carrying the label).

- [ ] **Step 1: Confirm the tree and the migration tail.**
  `cd /Users/ashokhein/github/seazn.club/.claude/worktrees/stream-overlay && /usr/bin/git fetch origin main && /usr/bin/git rev-parse --abbrev-ref HEAD && /usr/bin/git log --oneline -1 && /usr/bin/git merge-base --is-ancestor origin/main HEAD; echo "UPTODATE=$?" && ls db/migration/deltas | sort -V | tail -1 && test -f .git && echo "WORKTREE=yes"`
  Expected: `feat/stream-overlay`, **`UPTODATE=0`** (a moved `main` prints `1` and STOPS the wave: rebase — `/usr/bin/git rebase origin/main` — re-run `ls db/migration/deltas | sort -V | tail -1`, and only then take the baseline; a baseline taken on a stale tree is what Task 4 Step 1 would compare against — review 2026-09-08 finding 7), `V399__stats_player_career_split.sql`, `WORKTREE=yes` (`.git` is a FILE in a worktree; the env script refuses `up` from the main checkout). If the tail is not V399, STOP and record the number in `_STATE.md` before anything else — three documents have already named a migration number that was taken by the time anyone read them.

- [ ] **Step 2: Install and link the environment the worktree lacks.**
  `cd /Users/ashokhein/github/seazn.club/.claude/worktrees/stream-overlay && pnpm install --frozen-lockfile > /private/tmp/claude-501/-Users-ashokhein-github-seazn-club/b30673ed-f5cd-42f4-b756-805514a83656/scratchpad/t1/pnpm.log 2>&1; echo "EXIT=$?"; tail -3 /private/tmp/claude-501/-Users-ashokhein-github-seazn-club/b30673ed-f5cd-42f4-b756-805514a83656/scratchpad/t1/pnpm.log`
  Expected: `EXIT=0` and a `node_modules` directory INSIDE the worktree (`ls -d node_modules apps/web/node_modules`). A SYMLINKED `node_modules` compiles MAIN's engine — never link it.
  Then both env symlinks (the main checkout holds the only `.env.local`; the script resolves it via `--git-common-dir`, but vitest and Next do not):
  `ln -sfn /Users/ashokhein/github/seazn.club/.env.local /Users/ashokhein/github/seazn.club/.claude/worktrees/stream-overlay/.env.local && ln -sfn /Users/ashokhein/github/seazn.club/apps/web/.env.local /Users/ashokhein/github/seazn.club/.claude/worktrees/stream-overlay/apps/web/.env.local && ls -l /Users/ashokhein/github/seazn.club/.claude/worktrees/stream-overlay/.env.local /Users/ashokhein/github/seazn.club/.claude/worktrees/stream-overlay/apps/web/.env.local`
  Expected: two symlinks printed with `->` targets that exist.

- [ ] **Step 3: Stand the `ovl` environment up from THIS worktree.**
  `cd /Users/ashokhein/github/seazn.club/.claude/worktrees/stream-overlay && mkdir -p /private/tmp/claude-501/-Users-ashokhein-github-seazn-club/b30673ed-f5cd-42f4-b756-805514a83656/scratchpad/t1 && ~/.claude/skills/seazn-local-env/scripts/seazn-env.sh up --label ovl --server > /private/tmp/claude-501/-Users-ashokhein-github-seazn-club/b30673ed-f5cd-42f4-b756-805514a83656/scratchpad/t1/env-up.log 2>&1; echo "EXIT=$?"; tail -15 /private/tmp/claude-501/-Users-ashokhein-github-seazn-club/b30673ed-f5cd-42f4-b756-805514a83656/scratchpad/t1/env-up.log`
  Expected: `EXIT=0`; the log shows Postgres on a 544xx port, `db:apply` AND `sync:sports` both run (a schema without `sync:sports` reds `funnel.test.ts` with `expected 'generic' to be 'badminton'`), a build, and a server on a 33xx port. Then `~/.claude/skills/seazn-local-env/scripts/seazn-env.sh status` and `~/.claude/skills/seazn-local-env/scripts/seazn-env.sh env --label ovl` — copy the printed `DATABASE_URL` and `SMOKE_BASE` values into `_STATE.md` (Step 9) and into every later command by hand.
  Then prove the database is yours: `psql "<DATABASE_URL>" -c "show data_directory"` — the path must contain `ovl`. A `pg_ctl` that failed "Address already in use" is followed by a `createdb` that SUCCEEDS against another session's server; this line is the only thing that tells them apart.

- [ ] **Step 4: Take the vitest baseline on the fresh DB.**
  `cd /Users/ashokhein/github/seazn.club/.claude/worktrees/stream-overlay/apps/web && DATABASE_URL=<ovl url> DATABASE_SSL=disable npx vitest run --reporter=json --outputFile=/private/tmp/claude-501/-Users-ashokhein-github-seazn-club/b30673ed-f5cd-42f4-b756-805514a83656/scratchpad/t1/baseline-web.json > /private/tmp/claude-501/-Users-ashokhein-github-seazn-club/b30673ed-f5cd-42f4-b756-805514a83656/scratchpad/t1/baseline-web.log 2>&1; echo "EXIT=$?"`
  then
  `node -e "const r=require('/private/tmp/claude-501/-Users-ashokhein-github-seazn-club/b30673ed-f5cd-42f4-b756-805514a83656/scratchpad/t1/baseline-web.json');console.log('passed',r.numPassedTests,'total',r.numTotalTests,'failed',r.numFailedTests,'pending',r.numPendingTests);const bad=r.testResults.filter(t=>t.status!=='passed').map(t=>t.name);console.log(bad.join('\n'));const out=r.testResults.filter(t=>!t.name.startsWith('/Users/ashokhein/github/seazn.club/.claude/worktrees/stream-overlay/')).length;console.log('outside-worktree',out)"`
  Expected: `outside-worktree 0`; `total` ≥ 14041 (the 2026-09-05 baseline at `997ad22` was 13962 / 14041 with 5 red; `main` has moved 346 commits, so the numbers move — record what you SEE); `pending` in the low hundreds at most (a `pending` in the thousands means the env symlink did not take and the DB suites skipped themselves). Every red file is named in `_STATE.md` with its classification (Step 7).

- [ ] **Step 5: Run the three gates that are cheap and lie loudest.**
  `cd /Users/ashokhein/github/seazn.club/.claude/worktrees/stream-overlay && rtk proxy npm run lint > /private/tmp/claude-501/-Users-ashokhein-github-seazn-club/b30673ed-f5cd-42f4-b756-805514a83656/scratchpad/t1/lint.log 2>&1; echo "EXIT=$?"; grep -a -E "✖|problems" /private/tmp/claude-501/-Users-ashokhein-github-seazn-club/b30673ed-f5cd-42f4-b756-805514a83656/scratchpad/t1/lint.log | tail -2`
  `cd /Users/ashokhein/github/seazn.club/.claude/worktrees/stream-overlay && npx tsc --noEmit -p apps/web/tsconfig.json > /private/tmp/claude-501/-Users-ashokhein-github-seazn-club/b30673ed-f5cd-42f4-b756-805514a83656/scratchpad/t1/tsc.log 2>&1; echo "EXIT=$?"; tail -3 /private/tmp/claude-501/-Users-ashokhein-github-seazn-club/b30673ed-f5cd-42f4-b756-805514a83656/scratchpad/t1/tsc.log`
  `cd /Users/ashokhein/github/seazn.club/.claude/worktrees/stream-overlay && npm run openapi:gen > /dev/null 2>&1; pnpm i18n:gen-keys > /dev/null 2>&1; /usr/bin/git status --porcelain`
  Expected: lint `✖ 0 problems` (or the count, recorded — `rtk` without `proxy` hides this output entirely), tsc `EXIT=0`, and an EMPTY porcelain (a diff from either generator on an untouched tree is a finding about `main`, recorded, not fixed here).

- [ ] **Step 6: Run the Playwright preflight against the served build.**
  `cd /Users/ashokhein/github/seazn.club/.claude/worktrees/stream-overlay/apps/web && PLAYWRIGHT_BASE=<ovl base> E2E_PROD_TARGET=1 npx playwright test e2e/mobile.spec.ts --project=mobile-320 --reporter=line > /private/tmp/claude-501/-Users-ashokhein-github-seazn-club/b30673ed-f5cd-42f4-b756-805514a83656/scratchpad/t1/mobile-320.log 2>&1; echo "EXIT=$?"; tail -5 /private/tmp/claude-501/-Users-ashokhein-github-seazn-club/b30673ed-f5cd-42f4-b756-805514a83656/scratchpad/t1/mobile-320.log`
  Expected: `global-setup` passes (proves the server IS this build — a stale standalone answers 200 on `/api/health` with every chunk 404), then the width's tests pass. `mobile.spec.ts` is SERIAL: a red count is a floor, not a total. This is the pre-change witness Task 3's helper move is judged against.

- [ ] **Step 7: Reproduce Q12's two reds rather than carry the label.**
  `cd /Users/ashokhein/github/seazn.club/.claude/worktrees/stream-overlay/apps/web && DATABASE_URL=<ovl url> DATABASE_SSL=disable npx vitest run src --reporter=json --outputFile=/private/tmp/claude-501/-Users-ashokhein-github-seazn-club/b30673ed-f5cd-42f4-b756-805514a83656/scratchpad/t1/q12.json -t "pass-scoping" > /dev/null 2>&1; node -e "const r=require('/private/tmp/claude-501/-Users-ashokhein-github-seazn-club/b30673ed-f5cd-42f4-b756-805514a83656/scratchpad/t1/q12.json');for(const t of r.testResults){for(const a of t.assertionResults){if(a.status!=='passed')console.log(t.name,'::',a.fullName,'::',(a.failureMessages[0]||'').slice(0,300))}}"`
  Expected: either the two reds print with their messages (record VERBATIM in `_STATE.md` under "Base commit health", attributed to `main` — the file is not a W1 or T1 file), or nothing prints and the 2026-09-05 note is closed as "green on `fb99bbd4c`". Do not fix either way; the rule is attribute, never absorb.

- [ ] **Step 8: Verify the corpus re-pins already landed, then write what is still owed (review 2026-09-08 finding 6: the 2026-09-07 corrections were committed at `8d31cb34f` / `c8dc4d07f` and merged to `main` in `b2244879f` — a rewrite here would stage nothing).** ONE verification, then two additions:

  (a) Verify, do not edit — every line below must print the stated value on an untouched tree; a miss is a finding, not a task:
  `cd /Users/ashokhein/github/seazn.club/.claude/worktrees/stream-overlay && grep -a -c "re-pinned 2026-09-07 @ fb99bbd4c" docs/superpowers/specs/2026-09-05-stream-overlay-prompts/W1-step-one.md` → `≥ 8`;
  `grep -a -c "eleven" docs/superpowers/specs/2026-09-05-stream-overlay-prompts/_RULES.md` → `≥ 1` (R16 already widened);
  `grep -a -n "run-sheet-row.tsx" docs/superpowers/specs/2026-09-05-stream-overlay-prompts/W1-step-one.md | head -1` → a hit (RP1 already re-pinned; the mount is the SYMBOL `data-testid="run-sheet-edit-time"` — `:407` on `main` `b2244879f` after desk W3, never a number to write);
  `grep -a -c "set point" docs/superpowers/specs/2026-09-05-stream-overlay-prompts/W2-moments.md` → `≥ 1` (F3 landed);
  `grep -a -n "^| T1 |" docs/superpowers/specs/2026-09-05-stream-overlay-prompts/_INDEX.md` → EMPTY (this is what is owed).

  (b) `_INDEX.md` status table — add the **T1** row after W1's: scope "theme design (T1a: slate, Phone tab, credits card, decided/void) + visual gate harness (T1b: `overlay-tokens.ts`, contrast sweep, manifest capture)", state "plan written 2026-09-07, reviewed 2026-09-08 (63 findings applied); execution started <date>", plan `plans/2026-09-07-streaming-t1.md`, prompt `T1-theme-and-visual-gate.md`, PR "PR-T1", gate "`_RULES.md` §Merge gates 1–8; owner per-screen sign-off on the T1a picks; the six contrast rows in Task 2 Step 8 resolved by the sheet". And under "Findings 2026-09-07" append two T1 findings, verbatim:
  - **FS-T1a** — `overflowingIn` is MOVED to `e2e/helpers.ts` and imported by `mobile.spec.ts`, overruling the T1 prompt's "copy the logic into `asserts.ts`" (`T1-theme-and-visual-gate.md` §Do NOT touch). Reason: `helpers.ts` is not a spec, so Playwright's "a test file should not import a test file" rule does not fire (`mobile.spec.ts:3-24` already imports 20 symbols from it), and one authority beats a copy that drifts (the third copy, `e2e/run-sheet.spec.ts:100 expectRunSheetNotClipped`, is recorded as a tidy owed, not touched by T1). The owner is told in the T1 Task 4 sign-off message that the prompt's instruction was overruled and why.
  - **FS-T1c** — `SLATE_TOKENS`'s three values are typed in `overlay-tokens.ts` AND in `_THEMES.md` §4a until Task 1 lands §4a and Task 2's contrast test gains a §4a parse (the live-dot parse is the shape); the sheet is the authority.
  - **FS-T1d** — six `slab-ink-on-dismissal` rows red by construction (T1 Task 2 Step 8's table, ratios 2.35–3.07 against 4.5): one design question for the owner, options A/B recorded there.
  - **FS-T1e** — a third overflow scan remains at `e2e/run-sheet.spec.ts:100 expectRunSheetNotClipped` (desk's spec, untouched by T1); tidy owed to whichever desk wave next edits that file.
  - **FS-T1b** — the manifest vocabulary is the PLAN's: `awaitSelector` (a CSS selector — the public fixture page and the embed widgets carry no testids, so `awaitTestId` could not await them), group-level `mustDiffer: [id, id][]` and `controlSetEqual` (a pair is a group fact, not a row's), and `toBeVisible` on the awaited element (a screenshot proves what is painted; `toBeAttached` is the FOLD rule and the overlay has no fold). The design §4.2 block, `T1-theme-and-visual-gate.md` items 5–6 and `R2-compositor.md` were amended to this vocabulary on 2026-09-08 (design FS16).

  (c) `_STATE.md` — add the environment block (Step 9). No other corpus file changes in this step.

- [ ] **Step 9: Write the environment block into `_STATE.md`.** Append after the "2026-09-08 — where things stand" block (the sentence "Not yet pushed since the rebase" no longer exists — do not look for it):

```markdown
## Environment (label `ovl`, stood up <date> from this worktree @ <HEAD sha>)

- `DATABASE_URL=<paste from seazn-env env --label ovl>` `DATABASE_SSL=disable`
- `SMOKE_BASE=<paste>` = `PLAYWRIGHT_BASE`; `E2E_PROD_TARGET=1`
- `show data_directory` → `<paste; must contain ovl>`
- Deltas tail on this branch: `V399__stats_player_career_split.sql` (T1 adds none; W1 takes V400/V401)
- Baseline (`apps/web`, full, fresh DB, tree = `origin/main` + this branch): passed <n> / total <n> / failed <n> / pending <n> —
  JSON at `<scratchpad>/t1/baseline-web.json`; red files: <list, each with its
  classification: environmental (placement service not running) | attributed to main | this branch>
- Lint `✖ <n> problems`; tsc EXIT=<n>; openapi:gen + i18n:gen-keys porcelain: <empty | diff recorded as finding>
- `mobile.spec.ts` @ mobile-320 before Task 3: <passed/failed counts>
- Q12 (`pass-scoping-guard.test.ts`): <reproduced with message | green on this tree>
- Recreate with `~/.claude/skills/seazn-local-env/scripts/seazn-env.sh up --label ovl --server` from the worktree; `rebuild --label ovl` after every code change.
```

- [ ] **Step 10: Commit the two additions. The force-push is the MAIN session's call — state it, do not do it.**
  `cd /Users/ashokhein/github/seazn.club/.claude/worktrees/stream-overlay && /usr/bin/git add docs/superpowers/specs/2026-09-05-stream-overlay-prompts/_STATE.md docs/superpowers/specs/2026-09-05-stream-overlay-prompts/_INDEX.md`
  then
  `cd /Users/ashokhein/github/seazn.club/.claude/worktrees/stream-overlay && /usr/bin/git commit -m "docs(streaming): Task 0 — ovl environment, baseline, T1 index row and the two T1 deviations" -m "The 2026-09-07 corpus re-pins were verified already landed (8d31cb34f / c8dc4d07f); this adds only the T1 status row, the overflowingIn-move and manifest-vocabulary findings, and the ovl coordinates and baseline counts a fresh session judges against." -m "Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>" -m "Claude-Session: https://claude.ai/code/session_01LJGBoVPAWczYB9c45TD1aw"`
  Final message to the main session: the commit sha, the baseline line verbatim, and whether the branch is ahead of origin.

---

### Task 1: T1a — theme design canvas and the `_THEMES.md` sections

**Files:**
- Modify: `docs/superpowers/specs/2026-09-05-stream-overlay-prompts/_THEMES.md` — new §4a, §8a, §8b; new rows in §2, §3, §4; §9 gains the T1/R1/R2 take-list
- The design canvas https://claude.ai/code/artifact/2aebcbde-28ba-45ff-9028-1151873e4901 gains artboards (the `design` skill; `Artifact` `action: "read"` the URL first, then republish to the SAME url — a new url is a different artifact and the corpus links break)

**Interfaces:**
- Consumes: `_THEMES.md` §1 (type), §2 (seven tokens, per-sport hex), §3 (`bar` anatomy), §4 (`bug` anatomy), §8 (panel tokens); `globals.css` `.card` / `.btn` / `.btn-primary` / `.btn-ghost`; `UpgradeGate` (`components/upgrade-gate.tsx:252`) as the upsell card's visual parent; spec §4.1 (the surfaces), §5.3 (Phone tab states), §7.5 (slate states).
- Produces: the picked VALUES, in `_THEMES.md`, that Task 2 encodes as `SLATE_TOKENS` and that W1 (panel, decided/void), R1 (Phone tab, credits card) and R2 (slate) build to. No code.

**Checklist rows satisfied:** "Show ≥2 UI options before building"; "Mobile-first, never shrink" (every panel artboard is drawn at 320 FIRST, then 768 and 1280); "Zoom in/out" (320 @ 125 %); "Verify visually, always" (the owner signs off on pictures, per screen); "Always give a recommendation, framed as product owner" (each pair carries one).

> **Two options per surface, with values, so the owner picks a LETTER and the executor copies a COLUMN.** Nothing here is a placeholder: both columns are complete; the one not picked is deleted from the sheet and kept on the canvas.

- [ ] **Step 1: Read what exists, then draw.** `Artifact` `action: "read"` the canvas url; read `_THEMES.md` §3 and §4 in full (the sheet shape every new section copies: preamble → inset block → per-state table). Then with the `design` skill add these artboards to the SAME canvas, named exactly:
  - `T1 · Slate A — Full-bleed board` and `T1 · Slate B — Card over field`, each showing three states (warming, signal lost, ended) at 1920×1080, composited over one light frame (a pitch under daylight: `linear-gradient(180deg, #e8f0e2 0%, #3d7a3a 55%, #2e6a2d 100%)`) and one dark frame (a floodlit night: `linear-gradient(180deg, #0a0d14, #1c2230)`).
  - `T1 · Phone tab A — Stepper` and `T1 · Phone tab B — State card`, each at 320, 768, 1280, and 320 @ 125 % zoom, showing the six states: idle, QR shown (warming), live with health line, ending, ended, failed (`target_rejected` copy).
  - `T1 · Credits card A — Three tiles` and `T1 · Credits card B — Inline row`, at 320 and 1280, showing "no key" (UpgradeGate) and "key, balance 0" (the buy card) and "balance 3" (the balance chip).
  - `T1 · Decided frame A` and `T1 · Decided frame B` for `bar` AND `bug`, at 1920×1080, showing decided (a winner) and void (`abandoned`), over light and dark.
  - `T1 · Bar and bug, seven tokens` — the approved themes re-shown ONLY where facts changed: a hockey frame with a green (`--sport-advisory`) card chip, the football family header with the clock TICKING (two frames one second apart), and a W2 slab headline set in Barlow **800**.

- [ ] **Step 2: The values behind each option (the executor draws THESE, the owner picks one).**

  **Slate (§4a) — `OVERLAY_THEMES.slate`, `sports: "all"`, the one OPAQUE theme.**

  | Value | A — Full-bleed board (recommended) | B — Card over field |
  |---|---|---|
  | ground | `--sport-board` opaque, 1920×1080; radial highlight `color-mix(in srgb, var(--sport-board-2) 60%, transparent)` centred at 50 % 40 %, radius 900 | `#0b0d12` opaque; a diagonal band `--sport-board` at 24 % alpha from (0,720) to (1920,360), 240 tall |
  | brand | "seazn" Barlow 30/600 `.08em` ink 75 %, inset left 72 top 54 | same, bottom-right inset 72/54 |
  | headline | Barlow 96/800 ink 100 %, centred, `letter-spacing .02em`, upper case from the dictionary: warming `STARTING SOON`, signal lost `SIGNAL LOST`, ended `MATCH ENDED` | Barlow 78/800 under the card, centred |
  | line | Geist 27/500 ink 70 %, 12 below the headline: warming = "Home v Away · 14:30 <venueTz short>", signal lost = "Reconnecting…", ended = the decided sentence (`fixtureStatusLabel` / outcome) | Geist 24/500 ink 70 % |
  | scorebug | the SELECTED theme (`bar` / `bug`) renders ON TOP in signal-lost and ended (the score never leaves the screen); warming renders the "—" scheduled state | the `bug` at 1.5× (720 wide, radius 18) centred at 50 % 42 %; `bar` not shown in B |
  | indicator | warming: three 15-px LED dots under the line, breathing `opacity .55 ↔ 1` 2 s staggered 300 ms (reduced-motion: steady); signal lost: one 15-px `#ef4444` dot beside the line; ended: none | same |
  | motion | none on mount; state swaps are a 250 ms cross-fade of `opacity` only | same |
  | recommendation | **A.** Owner value: the club's colours fill the frame (the stream stays on-brand while the phone reconnects), the score stays visible in two of three states, and it is the bar/bug registry's own palette — zero new tokens, one new component. B's dark neutral is a second palette to maintain and hides the bar. | — |

  **Phone tab (§8a) — extends §8's panel tokens; six states.**

  | Value | A — Stepper (recommended) | B — State card |
  |---|---|---|
  | frame | `card p-5`; heading `text-sm font-semibold text-slate-700` with 16-px lucide `Smartphone` `text-purple-500`; state pill right of the heading: `rounded-full px-2 py-0.5 text-[11px] font-medium`, idle `bg-slate-100 text-slate-600`, provisioning/warming `bg-amber-100 text-amber-800`, live `bg-red-100 text-red-700` with a 6-px `bg-red-500` dot, ending `bg-slate-100`, ended `bg-emerald-100 text-emerald-800`, failed `bg-red-50 text-red-700` | same frame, no pill; the state is the card heading's suffix ("Phone stream · Live") |
  | steps | `ol` of four `li`, `text-[13px] text-slate-700`: 1 Connect phone · 2 Waiting for camera · 3 Live · 4 Ended; the current step `font-semibold text-purple-800` with a `bg-purple-100` 24-px circled number; done steps `text-slate-400` with a check | none — the body swaps |
  | idle | destination `select` (`org_stream_targets`, "+ Add destination" `btn btn-ghost`), mode segmented control `role="radiogroup"` (`Clean feed` / `With scorebug`), balance chip "3 credits" `text-xs text-slate-500`, primary `btn btn-primary` "Go live" full-width 44 px at 320 | same controls, one column |
  | QR shown | QR 264 px (EC-M, 4-module quiet zone) centred in a `rounded-lg border border-purple-100 bg-white p-3`; under it the paste-code in the §8 link-field style (`font-mono text-[11px]`, copy button) and "Point the phone at this code" `text-xs text-slate-500`; secondary `btn btn-ghost` "Cancel" | same |
  | live | REC pill (`bg-red-600 text-white rounded-full px-2.5 py-1 text-[11px] font-semibold` with a breathing dot) + elapsed `font-mono tabular-nums`; health line three chips `rounded-md bg-slate-100 px-2 py-1 text-[11px] text-slate-700`: `30 fps` · `2.9 Mbps` · `beat 4 s ago` (stale > 45 s → `bg-amber-100`); delay nudge `−250 ms` / `+250 ms` `btn btn-ghost` pair (composed only); `btn btn-danger`-styled "Stop stream" (`bg-red-600 text-white`) that opens the repo's confirm dialog | same, REC pill in the heading row |
  | ending | pill "Ending…"; controls disabled; copy "Flushing the last seconds to <destination>" | same |
  | ended | summary: duration, credits used (1), "Watch replay" link (`stream_url` if filled), `btn btn-ghost` "Start another" | same |
  | failed | `rounded-lg border border-red-200 bg-red-50 p-3 text-[13px] text-red-800` with the reason copy from the dictionary map (`no_inbound_timeout`, `machine_crash`, `target_rejected` + the YouTube ~24 h note, `storage_exhausted`, `no_credits`); `btn btn-primary` "Try again" | same |
  | phone (320–767) | one column; every control full-width 44 px; the stepper collapses to one line "Step 2 of 4 · Waiting for camera" above the body; identical control SET to 1280 | one column |
  | recommendation | **A.** Owner value: an organiser at a ground sees WHERE they are in a four-step flow they run once a week, and support can say "which step are you on". B is fewer pixels but every state looks like a different feature. | — |

  **Credits card (§8b) — inside the Phone tab, replaces the body when the gate says so.**

  | Value | A — Three tiles (recommended) | B — Inline row |
  |---|---|---|
  | no `streaming.overlay` / no `streaming.relay` | `UpgradeGate` (existing component, plan href to Pro) — no new design | same |
  | key, balance 0 | heading "Buy match credits" + explainer "1 match = 1 credit, up to 5 hours"; three tiles in a `grid grid-cols-1 md:grid-cols-3 gap-2`: each `rounded-lg border border-purple-200 p-3 text-left` with pack size Barlow-free (`text-lg font-semibold text-slate-800`), price `text-sm text-slate-600`, per-match `text-[11px] text-slate-500`; the 5-pack carries `border-purple-500` + "Most clubs" `bg-purple-100 text-purple-800 rounded-full px-2 text-[10px]`; tile click → checkout; footnote "Sandbox prices until launch" while dark | one row: balance chip + `btn btn-primary` "Buy 5 credits · £25" + `Link` "Other packs" opening the tiles in a sheet |
  | balance ≥ 1 | chip "3 credits" `bg-emerald-50 text-emerald-800 rounded-full px-2 py-0.5 text-[11px]` in the Phone tab heading; "Buy more" `Link` `text-xs text-purple-700 underline` | same |
  | phone | tiles stack (`grid-cols-1`), each 44 px tall minimum, full width | row wraps to two lines |
  | recommendation | **A.** Owner value: three prices visible is the whole pricing page for this feature — no /pricing entry while dark, no second surface to translate; the "Most clubs" tile is the only nudge. | — |

  **Decided / void frame (rows in §3 `bar` and §4 `bug`).**

  | Value | A — Result in place (recommended) | B — Collapsed band |
  |---|---|---|
  | decided, bar | live cell: dot OFF, "Final" Geist 24/600 (from `fixtureStatusLabel`), context line = the decided sentence's short form ("Home won by 12 runs"); winner keeps the LED bar and LED score; detail band shows `result` (Geist 24/600 ink 100 %) in place of the chase line | detail band NOT rendered; the result sentence replaces the context line only |
  | decided, bug | header: dot OFF, "Final"; winner row keeps LED; footer = `result` | footer not rendered |
  | void (`VOID_STATUSES`), bar and bug | both sides ink 50 %, no LED anywhere, live cell/header shows the status label ("Abandoned", "Cancelled", "Forfeited"), no detail band / footer | same |
  | recommendation | **A.** Owner value: a replay viewer joining after the whistle still sees the score AND why it ended, in the same frame shape the live viewer saw — nothing jumps. | — |

- [ ] **Step 3: Publish the canvas and put the picks to the owner, in chat, by letter.** One message: the four pairs, one line each, recommendation first with the owner's value. Wait for the letters. (Questions go in chat, never the question widget — it did not reach the owner on 2026-09-07.)

- [ ] **Step 4: Write the picked columns into `_THEMES.md`.** In the sheet's own shape:
  - **§4a Slate** after §4, opening with the registry preamble in §4's words (`{ id: "slate", labelKey: "stream.tab.slate", component: OverlaySlate, sports: "all" }`), then the inset block and a per-state table (warming / signal lost / ended) with the picked column's values verbatim.
  - **§8a Phone tab** after §8: the frame row, the state pill (or heading suffix) row, one row per state, the phone row.
  - **§8b Credits card** after §8a: the four rows.
  - A **"Decided / void"** row appended to §3's per-sport table AND to §4's paragraph, with the picked values.
  - **§2 contrast**: add the pairs the picks introduce — slate ink-on-board (already covered), the state pill text-on-background pairs (`text-amber-800` on `bg-amber-100`, `text-red-700` on `bg-red-100`, `text-emerald-800` on `bg-emerald-100`, `text-red-800` on `bg-red-50`, `text-purple-800` on `bg-purple-100`) with their Tailwind v4 hex values read from `node_modules/tailwindcss/theme.css` at execution (record the hex beside each), floor 4.5:1.
  - **§9** gains: "**T1:** sections 2 (new rows), 4a, 8a, 8b, the decided/void rows. **R1:** 8a, 8b. **R2:** 4a."
  Verify: `cd /Users/ashokhein/github/seazn.club/.claude/worktrees/stream-overlay && grep -a -n -E "^## 4a|^## 8a|^## 8b|Decided / void" docs/superpowers/specs/2026-09-05-stream-overlay-prompts/_THEMES.md` prints five lines (4a, 8a, 8b, and the row in §3 and in §4).

- [ ] **Step 5: Commit.**
  `cd /Users/ashokhein/github/seazn.club/.claude/worktrees/stream-overlay && /usr/bin/git add docs/superpowers/specs/2026-09-05-stream-overlay-prompts/_THEMES.md`
  then
  `cd /Users/ashokhein/github/seazn.club/.claude/worktrees/stream-overlay && /usr/bin/git commit -m "docs(streaming): T1a — slate, Phone tab, credits card and decided/void values, owner-picked" -m "Two options per surface were drawn on the programme canvas; the owner picked by letter and the picked column is the sheet. Every new ink-on-background pair joins the §2 contrast table." -m "Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>" -m "Claude-Session: https://claude.ai/code/session_01LJGBoVPAWczYB9c45TD1aw"`

---

### Task 2: T1b — `OVERLAY_TOKENS` and the derived contrast test

**Files:**
- Create: `apps/web/src/lib/contrast.ts`
- Create (Test): `apps/web/src/lib/__tests__/contrast.test.ts`
- Create: `apps/web/src/components/overlay/overlay-tokens.ts`
- Create (Test): `apps/web/src/components/overlay/__tests__/contrast.test.ts`

**Interfaces:**
- Consumes: `SPORT_PALETTES: Readonly<Record<string, Partial<SportPalette>>>`, `SPORT_TOKENS`, `type SportPalette`, `type SportToken` from `@/components/v2/scorepad/v3/sport-theme` (`:77-79`, `:165`); `app/globals.css` `:root` `--sport-*` block (`:1135-1141`) and the `--mk-*` values it aliases; `_THEMES.md` §2 (per-sport table), §4a (slate, Task 1), §5 (slab tones).
- Produces:
  - `export function contrastRatio(hexA: string, hexB: string): number` and `export function blendOver(fgHex: string, bgHex: string, alpha: number): string` (`lib/contrast.ts`)
  - `export const ROOT_SPORT_DEFAULTS: SportPalette`
  - `export const OVERLAY_FIXED: { liveDot: string; slabDismissalInk: string }`
  - `export const SLATE_TOKENS: { headlineInk: string; lineInkAlpha: number; indicator: string }` (values from §4a — Option A's are written below; replace with B's if the owner picked B)
  - `export const OVERLAY_SPORT_KEYS: readonly string[]` (every key in `SPORT_PALETTES` plus `cricket` and `generic`, which inherit the root defaults)
  - `export function paletteFor(sportKey: string): SportPalette`
  - `export interface OverlayPairRole { id: string; fg: SportToken | "slabDismissalInk"; bg: SportToken; floor: 4.5 | 3; where: string }` and `export const OVERLAY_PAIR_ROLES: readonly OverlayPairRole[]`
  - `export interface OverlayAlphaRole { id: string; fg: SportToken; bg: SportToken; alpha: number; floor: 4.5 | 3; where: string }` and `export const OVERLAY_ALPHA_ROLES: readonly OverlayAlphaRole[]`
  - **`export const OVERLAY_TOKENS = { root, fixed, slate, sportKeys, pairRoles, alphaRoles, paletteFor } as const`** and `export type OverlayTokens` — THE one exported object the corpus binds on (spec §4.2; T1 prompt item 8; `W1-step-one.md`; `R2-compositor.md`); the contrast test, W1 Task 5 and R2 read THIS, the granular exports exist for type reuse only

**Checklist rows satisfied:** "Derive expected values from the engine's own declarations, never hand-typed constants" (the per-sport values come from `SPORT_PALETTES`; the root defaults are PROVEN equal to `globals.css`); "One sample isn't a parity sweep — enumerate" (every role × every sport); "Include ≥1 case where right answer differs from the wrong answer's constant" (the gamma-differential pair; the `#ff5a4d` dismissal row); "Negative assertion needs its positive pair" (a pair that FAILS its floor is asserted to fail — proves the test can see red); "One authority per fact".

> **A red pair is a FINDING, never a lowered floor.** Hockey's dismissal is `#ff5a4d` (`_THEMES.md` §2); the §5 slab line is `#fff5f5` on it — the executor computes it in Step 6 and, if it is under 4.5, records the pair in `_INDEX.md` and puts the fix (a darker per-sport slab ink, or `board` as the slab ink for that sport) to the owner as a T1a follow-up. The test stays red until the SHEET moves.

- [ ] **Step 1: Write the failing formula test.** Create `apps/web/src/lib/__tests__/contrast.test.ts`:

```ts
// The overlay's contrast formula — WCAG 2.x relative luminance and contrast
// ratio, lifted from the pad's own contrast.test.ts (scorepad/v3/__tests__)
// into a lib module so the overlay's test and the pad's can share ONE
// implementation instead of two copies. The pad's test-local copy is left in
// place this wave (scorepad/** is off-limits to this programme); recorded in
// _INDEX.md as a tidy owed to nobody in particular.
import { describe, expect, it } from "vitest";
import { blendOver, contrastRatio } from "../contrast";

describe("contrastRatio (WCAG 2.x)", () => {
  it("is 21:1 for black on white and 1:1 for a colour on itself", () => {
    expect(contrastRatio("#000000", "#ffffff")).toBeCloseTo(21, 1);
    expect(contrastRatio("#150b36", "#150b36")).toBeCloseTo(1, 5);
  });
  it("is symmetric", () => {
    expect(contrastRatio("#150b36", "#f5f0e8")).toBeCloseTo(contrastRatio("#f5f0e8", "#150b36"), 10);
  });
  // The one pair where gamma-correct and naive-linear luminance flip a real
  // AA verdict: correct ≈ 4.5422 (passes 4.5), naive ≈ 2.05 (fails). Every
  // other assertion in this file survives a mutant that deletes the sRGB
  // curve; this one does not.
  it("distinguishes gamma-correct from naive-linear luminance (#767676 on white)", () => {
    expect(contrastRatio("#767676", "#ffffff")).toBeCloseTo(4.5422, 3);
  });
  it("accepts 3-digit and upper-case hex", () => {
    expect(contrastRatio("#FFF", "#000")).toBeCloseTo(21, 1);
  });
});

describe("blendOver (alpha text composited over its board)", () => {
  it("alpha 1 is the foreground, alpha 0 is the background", () => {
    expect(blendOver("#f5f0e8", "#150b36", 1)).toBe("#f5f0e8");
    expect(blendOver("#f5f0e8", "#150b36", 0)).toBe("#150b36");
  });
  it("70 % cream over night is between the two, per channel", () => {
    // r: 0.7·0xf5 + 0.3·0x15 = 171.5 + 6.3 = 177.8 → 178 = b2
    // g: 0.7·0xf0 + 0.3·0x0b = 168.0 + 3.3 = 171.3 → 171 = ab
    // b: 0.7·0xe8 + 0.3·0x36 = 162.4 + 16.2 = 178.6 → 179 = b3
    expect(blendOver("#f5f0e8", "#150b36", 0.7)).toBe("#b2abb3");
  });
});
```

- [ ] **Step 2: Run it — expect red.** `cd /Users/ashokhein/github/seazn.club/.claude/worktrees/stream-overlay/apps/web && npx vitest run src/lib/__tests__/contrast.test.ts --reporter=json --outputFile=/private/tmp/claude-501/-Users-ashokhein-github-seazn-club/b30673ed-f5cd-42f4-b756-805514a83656/scratchpad/t1/t2a-red.json; node -e "const r=require('/private/tmp/claude-501/-Users-ashokhein-github-seazn-club/b30673ed-f5cd-42f4-b756-805514a83656/scratchpad/t1/t2a-red.json');console.log(r.numTotalTests,r.numFailedTests,r.testResults[0]&&r.testResults[0].message.slice(0,120))"`
  Expected: a collection failure — `Cannot find module '../contrast'` — so `numTotalTests: 0` and the suite's `message` names the module. That IS the red (a module-scope throw collects zero tests; read the message, not the count).

- [ ] **Step 3: Write `lib/contrast.ts`.**

```ts
// WCAG 2.x contrast, one implementation for the overlay's contrast gate.
// https://www.w3.org/TR/WCAG21/#dfn-relative-luminance
// https://www.w3.org/TR/WCAG21/#dfn-contrast-ratio
//
// Lifted from components/v2/scorepad/v3/__tests__/contrast.test.ts (R1 Task 5),
// where it was written from the spec formula and pinned by the #767676-on-white
// gamma-differential case that this module's own test keeps.

function expandHex(hex: string): string {
  const n = hex.trim().replace("#", "").toLowerCase();
  if (n.length === 3) return n.split("").map((c) => c + c).join("");
  if (n.length !== 6 || /[^0-9a-f]/.test(n)) throw new Error(`not a hex colour: ${hex}`);
  return n;
}

function channels(hex: string): [number, number, number] {
  const n = expandHex(hex);
  return [parseInt(n.slice(0, 2), 16), parseInt(n.slice(2, 4), 16), parseInt(n.slice(4, 6), 16)];
}

function srgbChannelToLinear(c: number): number {
  const s = c / 255;
  return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
}

export function relativeLuminance(hex: string): number {
  const [r, g, b] = channels(hex);
  return 0.2126 * srgbChannelToLinear(r) + 0.7152 * srgbChannelToLinear(g) + 0.0722 * srgbChannelToLinear(b);
}

/** (L1 + 0.05) / (L2 + 0.05), L1 the lighter. 1 ≤ ratio ≤ 21. */
export function contrastRatio(hexA: string, hexB: string): number {
  const l1 = relativeLuminance(hexA);
  const l2 = relativeLuminance(hexB);
  return (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05);
}

/** The colour a viewer SEES for `fg` painted at `alpha` over an opaque `bg` —
 *  simple source-over per channel, rounded. Ink at 70 % on the board is a
 *  different pair from ink on the board, and only the composite can be
 *  measured against a floor. */
export function blendOver(fgHex: string, bgHex: string, alpha: number): string {
  if (alpha < 0 || alpha > 1) throw new Error(`alpha out of range: ${alpha}`);
  const f = channels(fgHex);
  const b = channels(bgHex);
  const out = f.map((fc, i) => Math.round(fc * alpha + b[i]! * (1 - alpha)));
  return `#${out.map((c) => c.toString(16).padStart(2, "0")).join("")}`;
}
```

- [ ] **Step 4: Run — expect PASS.** Re-run Step 2's command. Expected: `numTotalTests: 6`, `numFailedTests: 0`.

- [ ] **Step 5: Write the failing token/contrast test.** Create `apps/web/src/components/overlay/__tests__/contrast.test.ts`:

```ts
// The overlay's colour gate (spec §4.2, _THEMES.md §2). Three claims:
//
//  1. ROOT_SPORT_DEFAULTS in tokens.ts is EXACTLY what app/globals.css's
//     `:root { --sport-* }` block resolves to. globals.css is the authority
//     (the pad's own tokens.ts/contrast.test.ts pairing says the same); this
//     file's typed mirror exists so a test can iterate it, and this claim is
//     what keeps the mirror honest. `var(--x)` and `var(--x, fallback)` are
//     resolved against the same stylesheet.
//  2. Every pair ROLE the overlay paints (OVERLAY_PAIR_ROLES) clears its floor
//     for EVERY sport the overlay can render — the per-sport values come from
//     SPORT_PALETTES (sport-theme.ts), never typed here. One sample is not a
//     parity sweep; this is the whole table.
//  3. Alpha text (ink at 70 %, 65 %, 85 %, 92 % — _THEMES.md §2) is measured
//     as the COMPOSITE the viewer sees, not as the solid ink.
//
// A red row is a FINDING for the sheet, never a lowered floor.
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { SPORT_PALETTES, SPORT_TOKENS } from "@/components/v2/scorepad/v3/sport-theme";
import { V3_SKINS } from "@/components/v2/scorepad/v3/registry";
import { blendOver, contrastRatio } from "@/lib/contrast";
// ONE exported object (spec §4.2; T1/W1/R2 prompts bind on this name). Every
// group below is read off it — the granular exports exist for type reuse,
// but this test derives from the object the corpus cites.
import { OVERLAY_TOKENS } from "../overlay-tokens";

const {
  root: ROOT_SPORT_DEFAULTS,
  fixed: OVERLAY_FIXED,
  slate: SLATE_TOKENS,
  sportKeys: OVERLAY_SPORT_KEYS,
  pairRoles: OVERLAY_PAIR_ROLES,
  alphaRoles: OVERLAY_ALPHA_ROLES,
  paletteFor,
} = OVERLAY_TOKENS;

/** `--name: value;` declarations from globals.css, first occurrence wins
 *  (the :root block declares each once; later media/theme blocks are not the
 *  default). `var(--x, fb)` resolves through the same map, falling back to
 *  `fb` when `--x` is undeclared (which is how `--sport-led` reaches #9ae600:
 *  `--color-lime-400` is Tailwind's, not globals.css's). */
function cssVars(): Map<string, string> {
  const css = readFileSync(join(process.cwd(), "src/app/globals.css"), "utf8");
  const vars = new Map<string, string>();
  for (const m of css.matchAll(/(--[a-z0-9-]+)\s*:\s*([^;]+);/g)) {
    if (!vars.has(m[1]!)) vars.set(m[1]!, m[2]!.trim());
  }
  return vars;
}
function resolveVar(vars: Map<string, string>, name: string, depth = 0): string {
  if (depth > 5) throw new Error(`var() chain too deep at ${name}`);
  const raw = vars.get(name);
  if (raw === undefined) throw new Error(`globals.css declares no ${name}`);
  const m = raw.match(/^var\((--[a-z0-9-]+)(?:\s*,\s*([^)]+))?\)$/);
  if (!m) return raw.toLowerCase();
  if (vars.has(m[1]!)) return resolveVar(vars, m[1]!, depth + 1);
  if (m[2]) return m[2].trim().toLowerCase();
  throw new Error(`${name} aliases ${m[1]} which is undeclared and has no fallback`);
}

describe("ROOT_SPORT_DEFAULTS mirrors globals.css :root exactly", () => {
  const vars = cssVars();
  it.each([...SPORT_TOKENS])("--sport-%s", (token) => {
    expect(ROOT_SPORT_DEFAULTS[token]).toBe(resolveVar(vars, `--sport-${token}`));
  });
  it("the mirror has no token globals.css lacks, and vice versa", () => {
    const declared = [...vars.keys()].filter((k) => k.startsWith("--sport-")).map((k) => k.slice(8)).sort();
    expect(declared).toEqual([...SPORT_TOKENS].sort());
  });
});

describe("OVERLAY_SPORT_KEYS is every palette plus the two that inherit", () => {
  it("covers SPORT_PALETTES and the root-default sports, once each", () => {
    const fromPalettes = Object.keys(SPORT_PALETTES);
    for (const k of fromPalettes) expect(OVERLAY_SPORT_KEYS).toContain(k);
    expect(OVERLAY_SPORT_KEYS).toContain("cricket");
    expect(OVERLAY_SPORT_KEYS).toContain("generic");
    expect(new Set(OVERLAY_SPORT_KEYS).size).toBe(OVERLAY_SPORT_KEYS.length);
  });
  it("is exactly the eleven sport keys the pad's skin registry names (one authority for 'which sports exist')", () => {
    // V3_SKINS (scorepad/v3/registry.ts:85) is the working list of eleven keys
    // (_RULES.md R3). Derived from it, never typed here — a twelfth skin
    // reddens this until OVERLAY_SPORT_KEYS covers it.
    expect([...OVERLAY_SPORT_KEYS].sort()).toEqual(Object.keys(V3_SKINS).sort());
    expect(Object.keys(V3_SKINS).length).toBe(11);
  });
  it("paletteFor fills a missing token from the root defaults, never from another sport", () => {
    // boardgame declares no caution/dismissal (_THEMES.md §2 "inherit").
    const bg = paletteFor("boardgame");
    expect(bg.caution).toBe(ROOT_SPORT_DEFAULTS.caution);
    expect(bg.board).toBe(SPORT_PALETTES.boardgame!.board);
    expect(paletteFor("cricket")).toEqual(ROOT_SPORT_DEFAULTS);
  });
});

describe("every pair role clears its floor for every sport (the parity sweep)", () => {
  const rows = OVERLAY_SPORT_KEYS.flatMap((sport) =>
    OVERLAY_PAIR_ROLES.map((role) => ({ sport, role })),
  );
  it.each(rows)("$sport · $role.id ≥ $role.floor:1 ($role.where)", ({ sport, role }) => {
    const p = paletteFor(sport);
    const fg = role.fg === "slabDismissalInk" ? OVERLAY_FIXED.slabDismissalInk : p[role.fg];
    const bg = p[role.bg];
    const ratio = contrastRatio(fg, bg);
    expect(ratio, `${sport} ${role.id}: ${fg} on ${bg} = ${ratio.toFixed(2)}`).toBeGreaterThanOrEqual(role.floor);
  });
  it("the sweep is not vacuous: a pair that CANNOT clear 4.5 is reported under it", () => {
    // Positive pair for the assertion above: the same helper, a pair chosen to
    // fail. If this passes 4.5, the formula is broken and every row above is
    // meaningless.
    expect(contrastRatio("#ffffff", "#f5f0e8")).toBeLessThan(4.5);
  });
  it("the table has at least the eight roles the sheet names, and no duplicate ids", () => {
    expect(OVERLAY_PAIR_ROLES.length).toBeGreaterThanOrEqual(8);
    expect(new Set(OVERLAY_PAIR_ROLES.map((r) => r.id)).size).toBe(OVERLAY_PAIR_ROLES.length);
  });
});

describe("alpha text is measured as the composite the viewer sees", () => {
  const rows = OVERLAY_SPORT_KEYS.flatMap((sport) =>
    OVERLAY_ALPHA_ROLES.map((role) => ({ sport, role })),
  );
  it.each(rows)("$sport · $role.id (ink @ $role.alpha) ≥ $role.floor:1", ({ sport, role }) => {
    const p = paletteFor(sport);
    const seen = blendOver(p[role.fg], p[role.bg], role.alpha);
    const ratio = contrastRatio(seen, p[role.bg]);
    expect(ratio, `${sport} ${role.id}: ${seen} on ${p[role.bg]} = ${ratio.toFixed(2)}`).toBeGreaterThanOrEqual(role.floor);
  });
  it("a composite is strictly lower-contrast than the solid ink (the test measures the right thing)", () => {
    const p = paletteFor("cricket");
    expect(contrastRatio(blendOver(p.ink, p.board, 0.7), p.board)).toBeLessThan(contrastRatio(p.ink, p.board));
  });
});

describe("slate (§4a) reads on every board", () => {
  it.each([...OVERLAY_SPORT_KEYS])("%s: headline ink on board ≥ 4.5, line ink (alpha) ≥ 4.5", (sport) => {
    const p = paletteFor(sport);
    const headline = SLATE_TOKENS.headlineInk === "ink" ? p.ink : SLATE_TOKENS.headlineInk;
    expect(contrastRatio(headline, p.board)).toBeGreaterThanOrEqual(4.5);
    expect(contrastRatio(blendOver(p.ink, p.board, SLATE_TOKENS.lineInkAlpha), p.board)).toBeGreaterThanOrEqual(4.5);
  });
  it("the live dot is what _THEMES.md §2 names — parsed from the sheet, not restated (one authority)", () => {
    // `_THEMES.md` §2: "Fixed colours outside the sport set: live dot `#ef4444`".
    // The sheet is the authority; the export is the mirror; this proves them
    // equal the way cssVars() proves ROOT_SPORT_DEFAULTS against globals.css.
    const sheet = readFileSync(join(process.cwd(), "../../docs/superpowers/specs/2026-09-05-stream-overlay-prompts/_THEMES.md"), "utf8");
    const m = sheet.match(/live dot `(#[0-9a-f]{6})`/);
    expect(m, "_THEMES.md §2 no longer names the live dot").not.toBeNull();
    expect(OVERLAY_FIXED.liveDot).toBe(m![1]);
    // The slate indicator IS the live dot (§4a) — a cross-constant relation,
    // not a value restated against itself.
    expect(SLATE_TOKENS.indicator).toBe(OVERLAY_FIXED.liveDot);
  });
  it("the slate values are typed ONCE in code and the sheet cites the export (recorded, not proven, until §4a lands)", () => {
    // §4a is written by Task 1 from the owner's pick. Until the executor adds
    // a §4a parse here (same shape as the live-dot case above), these three
    // values are TYPED TWICE — recorded in _INDEX.md as FS-T1c with the sheet
    // as the authority. This case pins the shape so the parse has something
    // to replace, and fails loudly if the export drifts from the kinds §4a
    // allows.
    expect(SLATE_TOKENS.headlineInk === "ink" || /^#[0-9a-f]{6}$/.test(SLATE_TOKENS.headlineInk)).toBe(true);
    expect(SLATE_TOKENS.lineInkAlpha).toBeGreaterThan(0);
    expect(SLATE_TOKENS.lineInkAlpha).toBeLessThanOrEqual(1);
  });
});
```

- [ ] **Step 6: Run it — expect red (collection).** `cd /Users/ashokhein/github/seazn.club/.claude/worktrees/stream-overlay/apps/web && npx vitest run src/components/overlay --reporter=json --outputFile=/private/tmp/claude-501/-Users-ashokhein-github-seazn-club/b30673ed-f5cd-42f4-b756-805514a83656/scratchpad/t1/t2b-red.json; node -e "const r=require('/private/tmp/claude-501/-Users-ashokhein-github-seazn-club/b30673ed-f5cd-42f4-b756-805514a83656/scratchpad/t1/t2b-red.json');console.log(r.numTotalTests,r.numFailedTests,(r.testResults[0]||{}).message)"`
  Expected: `Cannot find module '../tokens'`, `numTotalTests: 0`.

- [ ] **Step 7: Write `components/overlay/overlay-tokens.ts`.**

```ts
// The overlay's colour authority — for the parts globals.css and sport-theme.ts
// do not already own.
//
//  - Per-sport values come from SPORT_PALETTES (sport-theme.ts:165) at run time
//    through `paletteFor`; nothing per-sport is typed here.
//  - ROOT_SPORT_DEFAULTS mirrors globals.css's `:root { --sport-* }` block for
//    the sports with no palette entry (cricket, generic — _THEMES.md §2). It is
//    a MIRROR: __tests__/contrast.test.ts proves it equal to the stylesheet on
//    every run, so a change to globals.css that forgets this file reds a test
//    instead of shipping two truths.
//  - OVERLAY_PAIR_ROLES / OVERLAY_ALPHA_ROLES are the TABLE the contrast gate
//    walks (registry over branching). Adding a painted pair to a theme is one
//    row here; the sweep then covers it for every sport.
import {
  SPORT_PALETTES,
  SPORT_TOKENS,
  type SportPalette,
  type SportToken,
} from "@/components/v2/scorepad/v3/sport-theme";

/** globals.css :root — `--sport-board: var(--mk-night)` etc. (:1135-1141). */
export const ROOT_SPORT_DEFAULTS: SportPalette = {
  board: "#150b36",
  "board-2": "#1d1145",
  ink: "#f5f0e8",
  led: "#9ae600",
  advisory: "#16a34a",
  caution: "#d97706",
  dismissal: "#dc2626",
};

/** Colours outside the seven sport tokens (_THEMES.md §2 "fixed colours", §5). */
export const OVERLAY_FIXED = {
  liveDot: "#ef4444",
  slabDismissalInk: "#fff5f5",
} as const;

/** §4a slate (T1a, owner-picked). Option A's values; if the owner picked B,
 *  the sheet says so and these three lines follow it. `headlineInk: "ink"`
 *  means "the sport's own ink token". */
export const SLATE_TOKENS = {
  headlineInk: "ink" as "ink" | `#${string}`,
  lineInkAlpha: 0.7,
  indicator: "#ef4444",
} as const;

/** Every sport the overlay can be asked to render: each palette key, plus the
 *  two that inherit the root defaults. Sorted so a test's output is stable. */
export const OVERLAY_SPORT_KEYS: readonly string[] = [
  ...new Set([...Object.keys(SPORT_PALETTES), "cricket", "generic"]),
].sort();

export function paletteFor(sportKey: string): SportPalette {
  const overrides = SPORT_PALETTES[sportKey] ?? {};
  const out: Record<SportToken, string> = { ...ROOT_SPORT_DEFAULTS };
  for (const token of SPORT_TOKENS) {
    const v = overrides[token];
    if (v !== undefined) out[token] = v;
  }
  return out;
}

export interface OverlayPairRole {
  id: string;
  fg: SportToken | "slabDismissalInk";
  bg: SportToken;
  /** 4.5 = normal text (WCAG AA); 3 = large text (≥ 24 px, or ≥ 18.66 px bold) and UI. */
  floor: 4.5 | 3;
  where: string;
}

/** Solid-on-solid pairs the bar, the bug and the W2 slab paint (_THEMES.md §3–§5). */
export const OVERLAY_PAIR_ROLES: readonly OverlayPairRole[] = [
  { id: "ink-on-board", fg: "ink", bg: "board", floor: 4.5, where: "§3 team cell name 45/600, §4 code 48/600, footer" },
  { id: "ink-on-board-2", fg: "ink", bg: "board-2", floor: 4.5, where: "§3 live cell 'Live' 24/600, brand cell, §4 header" },
  { id: "led-on-board", fg: "led", bg: "board", floor: 3, where: "§3/§4 LED score 78/69 px (large text) and the 8-px LED bar (UI)" },
  { id: "led-on-board-2", fg: "led", bg: "board-2", floor: 3, where: "§4 side-in-play row: LED score on board-2" },
  { id: "board-on-led-headline", fg: "board", bg: "led", floor: 3, where: "§5 slab headline 96/800 (large text)" },
  { id: "board-on-led-line", fg: "board", bg: "led", floor: 4.5, where: "§5 slab line Geist 21/600 (normal text)" },
  { id: "board-on-caution", fg: "board", bg: "caution", floor: 4.5, where: "§5 yellow-card slab line" },
  { id: "slab-ink-on-dismissal", fg: "slabDismissalInk", bg: "dismissal", floor: 4.5, where: "§5 wicket / red-card slab line #fff5f5" },
  { id: "board-on-advisory", fg: "board", bg: "advisory", floor: 4.5, where: "§3 green-card chip (hockey) name + minute" },
];

export interface OverlayAlphaRole {
  id: string;
  fg: SportToken;
  bg: SportToken;
  alpha: number;
  floor: 4.5 | 3;
  where: string;
}

/** Ink painted at an alpha over its board (_THEMES.md §2: 70 %, 65 %, 85 %, 92 %). */
export const OVERLAY_ALPHA_ROLES: readonly OverlayAlphaRole[] = [
  { id: "ink70-on-board", fg: "ink", bg: "board", alpha: 0.7, floor: 4.5, where: "§3 context line 21/500, meta 33/500" },
  { id: "ink65-on-board-2", fg: "ink", bg: "board-2", alpha: 0.65, floor: 4.5, where: "§4 header context 19.5/500" },
  { id: "ink85-on-board", fg: "ink", bg: "board", alpha: 0.85, floor: 4.5, where: "§4 footer 21/500" },
  { id: "ink92-on-board", fg: "ink", bg: "board", alpha: 0.92, floor: 4.5, where: "§3 detail band 24/500 (on board @ 90 %)" },
  { id: "ink75-on-board-2", fg: "ink", bg: "board-2", alpha: 0.75, floor: 4.5, where: "§3 brand 'seazn' 30/600" },
];

/**
 * THE export the corpus binds on (spec §4.2; `T1-theme-and-visual-gate.md`
 * item 8; `W1-step-one.md`; `R2-compositor.md`): one object, seven groups.
 * `_THEMES.md` §2 cites `OVERLAY_TOKENS` by name; the granular exports above
 * exist for type reuse and stay beside it — never a second vocabulary.
 */
export const OVERLAY_TOKENS = {
  root: ROOT_SPORT_DEFAULTS,
  fixed: OVERLAY_FIXED,
  slate: SLATE_TOKENS,
  sportKeys: OVERLAY_SPORT_KEYS,
  pairRoles: OVERLAY_PAIR_ROLES,
  alphaRoles: OVERLAY_ALPHA_ROLES,
  paletteFor,
} as const;
export type OverlayTokens = typeof OVERLAY_TOKENS;
```

- [ ] **Step 8: Run — read the table, expect green OR named red rows.** Re-run Step 6's command, then `node -e "const r=require('/private/tmp/claude-501/-Users-ashokhein-github-seazn-club/b30673ed-f5cd-42f4-b756-805514a83656/scratchpad/t1/t2b-red.json');console.log('total',r.numTotalTests,'failed',r.numFailedTests);for(const t of r.testResults)for(const a of t.assertionResults)if(a.status!=='passed')console.log(a.fullName,'::',(a.failureMessages[0]||'').split('\n')[0])"`
  Expected: `total` ≥ 11 sports × 14 roles + the mirror rows (≥ 170 tests). Every red row prints the pair and the measured ratio. **Exactly SIX rows are expected red, all in `slab-ink-on-dismissal` (`#fff5f5` on a light-red dismissal), computed from `SPORT_PALETTES` at `sport-theme.ts:165` (review 2026-09-08 finding 4):**

  | sport | dismissal | ratio vs `#fff5f5` | floor |
  |---|---|---|---|
  | tabletennis | `#ff7a80` | 2.35 | 4.5 |
  | badminton | `#ff6b6b` | 2.59 | 4.5 |
  | icehockey | `#ff6b6b` | 2.59 | 4.5 |
  | volleyball | `#ff6b6b` | 2.59 | 4.5 |
  | hockey | `#ff5a4d` | 2.88 | 4.5 |
  | tennis | `#fa5252` | 3.07 | 4.5 |

  All other 148 role rows pass. Six reds are the EXPECTED state — an implementer who sees six and "fixes" five of them by editing a floor or a palette has broken the gate. They are ONE design question, put to the owner as a T1a follow-up in Task 1's sign-off message: `#fff5f5` cannot clear 4.5 on ANY light-red dismissal, so either (A, recommended) the §5 slab LINE takes `board` as its ink on every sport (headline stays `#fff5f5` at the 3:1 large-text floor, which all six clear — hockey 2.88 does NOT, so A also darkens hockey's `dismissal` to ≥ `#e8463a`, or hockey's slab line reads `board`), or (B) `_THEMES.md` §5 declares the slab line large text (≥ 24 px) at floor 3 — which still leaves tabletennis, badminton, icehockey, volleyball and hockey red. Owner value of A: one rule for eleven sports, no palette edit outside hockey. Record the six rows VERBATIM in `_INDEX.md` under "T1 findings" as FS-T1d with the measured ratios. The commit in Step 10 is made WITH the six reds; PR-T1 carries them as its open finding; the sheet moves (Task 1 Step 4, or a T1a follow-up commit) before W2 paints a slab.

- [ ] **Step 9: Mutants, each with its killer.**
  1. `overlay-tokens.ts`: change `ROOT_SPORT_DEFAULTS.led` to `"#a3e635"` (the v3 Tailwind hex, the exact mistake the sport-theme comment warns about). Expected red: `ROOT_SPORT_DEFAULTS mirrors globals.css :root exactly › --sport-led` — `expected '#a3e635' to be '#9ae600'`. Restore.
  2. `lib/contrast.ts`: replace `srgbChannelToLinear`'s body with `return c / 255;`. Expected red: `distinguishes gamma-correct from naive-linear luminance` only — and NOT the sweep (record that the sweep alone would have survived; that is why the differential case exists). Restore.
  3. `overlay-tokens.ts`: delete the `board-on-led-line` row. Expected red: `the table has at least the eight roles…` — `expected 8 to be greater than or equal to 8` does NOT fire (nine rows minus one is eight) — so this mutant SURVIVES the count and is killed only by the `where` audit in Step 10's review. Record it as a known weak spot: the count is a floor, the review reads the rows. Restore.
  4. `contrast.test.ts` (the sweep): change `toBeGreaterThanOrEqual(role.floor)` to `toBeGreaterThanOrEqual(1)`. Expected: every row passes AND `the sweep is not vacuous` still passes — so this mutant survives; it is a test-side mutant that only a reviewer reading the assertion catches. Recorded so the reviewer reads the ASSERTION, not the title (recurring class 4). Restore.
  Paste the killer list (mutant → test name) into the PR-T1 inventory.

- [ ] **Step 10: Gate and commit.**
  `cd /Users/ashokhein/github/seazn.club/.claude/worktrees/stream-overlay/apps/web && npx vitest run src/lib/__tests__/contrast.test.ts src/components/overlay --reporter=json --outputFile=/private/tmp/claude-501/-Users-ashokhein-github-seazn-club/b30673ed-f5cd-42f4-b756-805514a83656/scratchpad/t1/t2-green.json; node -e "const r=require('/private/tmp/claude-501/-Users-ashokhein-github-seazn-club/b30673ed-f5cd-42f4-b756-805514a83656/scratchpad/t1/t2-green.json');console.log(r.numPassedTests,r.numTotalTests,r.numFailedTests)"` and `cd /Users/ashokhein/github/seazn.club/.claude/worktrees/stream-overlay && npx tsc --noEmit -p apps/web/tsconfig.json; echo "EXIT=$?"`
  Expected: failures = exactly the finding rows from Step 8 (zero if the sheet already clears them); `EXIT=0`.
  `cd /Users/ashokhein/github/seazn.club/.claude/worktrees/stream-overlay && /usr/bin/git add apps/web/src/lib/contrast.ts apps/web/src/lib/__tests__/contrast.test.ts apps/web/src/components/overlay/overlay-tokens.ts apps/web/src/components/overlay/__tests__/contrast.test.ts`
  then
  `cd /Users/ashokhein/github/seazn.club/.claude/worktrees/stream-overlay && /usr/bin/git commit -m "overlay(tokens): colour authority mirror, pair roles, and the derived contrast sweep" -m "ROOT_SPORT_DEFAULTS is proven equal to globals.css on every run; every painted pair role is swept across every sport from SPORT_PALETTES, alpha text as the composite the viewer sees. A red row is a finding for the sheet, never a lowered floor." -m "Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>" -m "Claude-Session: https://claude.ai/code/session_01LJGBoVPAWczYB9c45TD1aw"`

---

### Task 3: T1b — the manifest-driven visual gate

**Files:**
- Modify: `apps/web/e2e/helpers.ts` — append `overflowingIn` (moved from `mobile.spec.ts:91-122`, its doc comment `:49-90`), exported
- Modify: `apps/web/e2e/mobile.spec.ts` — delete `:49-122` EXACTLY (the doc comment opens at `:49` `/** Split every box inside \`rootSelector\`…`, the function opens at `:91`, its closing brace is `:122`; `:123` is the blank line and `:124` opens the NEXT doc comment `/** The scorebug's own clipping gate.` — both stay), add `overflowingIn,` to the `./helpers` import list (`:3-24`, closes with `} from "./helpers";` at `:24`); NOTHING else changes. Verified byte-identical on `main` `b2244879f` (desk W3 changed 58 other lines of this file, not these).

> **Deviation from the T1 prompt, argued here and landed as `_INDEX.md` finding FS-T1a in Task 0 (review 2026-09-08 finding 2).** `T1-theme-and-visual-gate.md` §Do NOT touch says "`mobile.spec.ts` (donor for `overflowingIn`; copy the logic into `asserts.ts`, do not import a spec from a spec — Playwright rejects it)". This plan MOVES the function to `e2e/helpers.ts` and has `mobile.spec.ts` import it. Playwright's rule ("test file should not import test file") fires when a `.spec.ts` imports another `.spec.ts`; `helpers.ts` is not a spec — `mobile.spec.ts:3-24` already imports twenty symbols from it — so the rule does not apply, and one authority beats a copy that drifts (recurring class: the repo already holds a third, hand-shaped overflow scan at `e2e/run-sheet.spec.ts:100 expectRunSheetNotClipped`, written "in the shape `mobile.spec.ts`'s `overflowingIn`" per its own comment at `:90`; T1 does not touch it and records the tidy). The owner is told in Task 4's sign-off that the prompt's instruction was overruled and why; if the owner prefers the copy, Step 1 becomes "copy into `asserts.ts`" and `mobile.spec.ts` is untouched — one file's difference.
- Create: `apps/web/e2e/visual/manifest.ts`
- Create: `apps/web/e2e/visual/manifest.json`
- Create: `apps/web/e2e/visual/seeds.ts`
- Create: `apps/web/e2e/visual/asserts.ts`
- Create: `apps/web/e2e/visual/capture.spec.ts`
- Create (Test): `apps/web/src/lib/__tests__/visual-manifest.test.ts`
- Modify: `scripts/smoke.ts` — `visualSeedRoutesSuite`, called beside the other suites in `main()`
- Create: `docs/runbooks/visual-gate.md`

**Interfaces:**
- Consumes: `expectNoHorizontalScroll(page, opts?)` (`helpers.ts:49`), `apiJson` (`:128`), `TAG` (`:117`), `activeOrg(page)` (`:1335`), `seedRosteredFixture(request, spec)` (`:1599`, returns `RosteredFixture { competitionId, divisionId, fixtureId, … }` `:1569`), `scoreFixture(request, fixtureId, p1, p2)` (`:1738`); `measureHitTargets(scope: Locator): Promise<HitTarget[]>`, `hitTargetFloorReport(targets, floor?)`, `floorViolationLines(report)`, `HIT_TARGET_FLOOR_PX`, `dismissCookieBanner(page)` (`e2e/scorepad-a11y-kit.ts:57-83,190,209,409`); `AUTH_STATE = "e2e/.auth/pro.json"` (`playwright.config.ts:29`); the parallel project's default `testMatch` and `testIgnore` (`:140-162`) — `e2e/visual/*.spec.ts` matches the default and none of the ignores, so the "rest" leg runs it (proven in Step 12).
- Produces:
  - `export async function overflowingIn(page, rootSelector, childSelector, absentMessage): Promise<{ clipped: string[]; scrollable: string[]; truncatedByDesign: string[] }>` (`helpers.ts`)
  - `export type VisualCheck = "no-horizontal-scroll" | "no-clip" | "hit-targets" | "truncate-chain" | "rails-a11y"`
  - `export interface VisualRow { id: string; route: string; viewport: { width: number; height: number }; zoom: number; backdrop: "light" | "dark" | null; awaitSelector: string; auth: boolean; controlRoot: string | null; checks: VisualCheck[] }`
  - `export interface VisualGroup { id: string; seed: SeedKind; rows: VisualRow[]; mustDiffer: [string, string][]; controlSetEqual: [string, string][] }`
  - `export interface VisualManifest { version: 1; groups: VisualGroup[] }`
  - `export function parseManifest(json: unknown): VisualManifest` (zod; throws on an unknown check, unknown seed kind, duplicate id, dangling reference)
  - `export function resolveRoute(template: string, params: Record<string, string>): string` (throws on an unresolved `{placeholder}`)
  - `export type SeedKind = "none" | "public-fixture"`; `export const SEED_PARAMS: Record<SeedKind, readonly string[]>`; `export async function seedFor(kind: SeedKind, page: Page): Promise<Record<string, string>>` (`seeds.ts`)
  - `asserts.ts`: `controlSet(page, root): Promise<string[]>`, `expectNoClip(page, root, label)`, `expectHitTargetsByPoint(page, root, label)`, `expectTruncateChain(page, label)`, `expectRailsA11y(page, label)`, `applyBackdrop(page, backdrop)`, `BACKDROPS`
  - `docs/runbooks/visual-gate.md`

**Checklist rows satisfied:** "No horizontal scroll at 320/768/1280 — split on overflow-x"; "Compare control SET, not box size"; "Button size … check every width"; "Zoom in/out"; "truncate needs min-w-0 on WHOLE ancestor chain"; "Scrolling rail needs tabindex=0 + role + accessible name"; "Verify visually, always" (the PNGs are the sign-off input); "Empty-set case must be checked explicitly" (a group with zero written images fails; `parseManifest` rejects an empty `groups`).

> **Zoom, decided:** real browser zoom (Ctrl +) shrinks the CSS viewport and raises the device pixel ratio; a 1280-px window at 125 % lays out at 1024 CSS px with DPR 1.25. The harness reproduces exactly that — `viewport: { width: round(w / zoom), height: round(h / zoom) }`, `deviceScaleFactor: zoom` on a fresh context per row — rather than the non-standard CSS `zoom` property, which reflows differently from the browser control the owner actually uses. Because `deviceScaleFactor` is a CONTEXT option, every row gets its own context; the cost is a page load per row, which is the price of measuring the right thing.
>
> **Backdrop, decided:** two deterministic gradients (`BACKDROPS.light`, `BACKDROPS.dark`) painted on `html` via `addStyleTag` before the shot. A transparent overlay composites over them the way OBS composites it over a camera; an opaque page (embed, panel) is unaffected, and the row says `backdrop: null`. A real still can replace a gradient later by changing ONE constant — never per row.

- [ ] **Step 1: Move `overflowingIn` to `helpers.ts` (one authority), keep `mobile.spec.ts` green.** In `apps/web/e2e/helpers.ts`, append after `expectNoHorizontalScroll`'s closing brace (read the file to find it; it ends the block that begins at `:49`):

```ts
/** Overflow inside `rootSelector`, split three ways by the CAUSE (owner
 *  checklist: "split on overflow-x"). `clipped` — content wider than its box
 *  with `overflow-x: hidden|visible|clip` and no truncation signal: a real
 *  defect. `scrollable` — `overflow-x: auto|scroll`: a reachable rail, a
 *  feature, which the caller then holds to its own a11y invariant. `truncatedByDesign`
 *  — `text-overflow: ellipsis` or a `-webkit-line-clamp`: shortened on purpose.
 *  Moved here from mobile.spec.ts (2026-09-07, streaming T1) so the visual
 *  gate and the mobile matrix measure with ONE function; the pad's scorebug
 *  gate (`expectScorebugNotClipped`) still calls it from there. NOT yet one
 *  authority: `e2e/run-sheet.spec.ts`'s `expectRunSheetNotClipped` is a third,
 *  hand-shaped scan written "in the shape of" this one (its own comment) —
 *  left untouched by T1 (a desk spec), recorded in the programme `_INDEX.md`
 *  as a tidy owed. */
export async function overflowingIn(
  page: Page,
  rootSelector: string,
  childSelector: string,
  absentMessage: string,
): Promise<{ clipped: string[]; scrollable: string[]; truncatedByDesign: string[] }> {
  return page.evaluate(
    ({ rootSel, childSel, absent }) => {
      const root = document.querySelector<HTMLElement>(rootSel);
      if (!root) return { clipped: [absent], scrollable: [], truncatedByDesign: [] };
      const suspects: HTMLElement[] = [root, ...Array.from(root.querySelectorAll<HTMLElement>(childSel))];
      const over = suspects.filter((el) => el.scrollWidth - el.clientWidth > 1);
      const describe = (el: HTMLElement) =>
        `${el.tagName.toLowerCase()} ${el.scrollWidth}px content in ${el.clientWidth}px` +
        `${el.hasAttribute("tabindex") ? ` tabindex=${el.getAttribute("tabindex")}` : ""}`;
      const reachable = (el: HTMLElement) => /^(auto|scroll)$/.test(getComputedStyle(el).overflowX);
      const truncatedByDesign = (el: HTMLElement) => {
        const cs = getComputedStyle(el);
        if (cs.textOverflow === "ellipsis") return true;
        const clamp = cs.webkitLineClamp;
        return clamp !== "" && clamp !== "none";
      };
      const rest = over.filter((el) => !reachable(el));
      return {
        clipped: rest.filter((el) => !truncatedByDesign(el)).map(describe),
        scrollable: over.filter(reachable).map(describe),
        truncatedByDesign: rest.filter(truncatedByDesign).map(describe),
      };
    },
    { rootSel: rootSelector, childSel: childSelector, absent: absentMessage },
  );
}
```

  The body is `mobile.spec.ts:91-122` VERBATIM — diff them (`diff <(sed -n 91,122p apps/web/e2e/mobile.spec.ts) <(sed -n '<new start>,<new end>p' apps/web/e2e/helpers.ts)`) before deleting the original. Then in `mobile.spec.ts`: confirm the range first — `sed -n '49p;91p;122p;124p' apps/web/e2e/mobile.spec.ts` must print the `/** Split every box` comment opener, `async function overflowingIn(`, `}`, and `/** The scorebug's own clipping gate.` — then delete `:49-122` exactly (`sed -i '' '49,122d'`), leaving the blank line and the next doc comment intact. Add `overflowingIn,` to the `from "./helpers"` import list (`:3-24`) — the list is in WAVE order, not alphabetical (`TAG, apiJson, activeOrg, expectNoHorizontalScroll, addEntrantsViaApi, …`): append it as the last entry before `} from "./helpers";`. Verify: `cd /Users/ashokhein/github/seazn.club/.claude/worktrees/stream-overlay && grep -a -c "function overflowingIn" apps/web/e2e/mobile.spec.ts apps/web/e2e/helpers.ts` prints `0` and `1`, and `sed -n '49p' apps/web/e2e/mobile.spec.ts` now prints `/** The scorebug's own clipping gate.` (the file still parses: `npx tsc --noEmit -p apps/web/tsconfig.json` in Step 2).

- [ ] **Step 2: Prove the move changed nothing.** `cd /Users/ashokhein/github/seazn.club/.claude/worktrees/stream-overlay/apps/web && PLAYWRIGHT_BASE=<ovl base> E2E_PROD_TARGET=1 npx playwright test e2e/mobile.spec.ts --project=mobile-320 --reporter=line > /private/tmp/claude-501/-Users-ashokhein-github-seazn-club/b30673ed-f5cd-42f4-b756-805514a83656/scratchpad/t1/mobile-320-after.log 2>&1; echo "EXIT=$?"; tail -3 /private/tmp/claude-501/-Users-ashokhein-github-seazn-club/b30673ed-f5cd-42f4-b756-805514a83656/scratchpad/t1/mobile-320-after.log`
  Expected: the SAME passed/failed counts as Task 0 Step 6's log. Then `cd /Users/ashokhein/github/seazn.club/.claude/worktrees/stream-overlay && npx tsc --noEmit -p apps/web/tsconfig.json; echo "EXIT=$?"` → `EXIT=0` (the spec's import must resolve).

- [ ] **Step 3: Write the failing manifest unit test.** Create `apps/web/src/lib/__tests__/visual-manifest.test.ts`:

```ts
// The visual gate's manifest is DATA that later waves append to (spec §4.2:
// "W1-E and R2 add manifest rows, never harness code"). A manifest the
// harness cannot run — a dangling mustDiffer id, a route placeholder no seed
// provides, an unknown check name — would fail at Playwright time, on a
// prod build, after a rebuild: minutes late and easy to misread as a product
// defect. This pure unit fails in seconds, in every CI job, with the row named.
//
// Pure: no DB, no browser — and no import from `e2e/helpers.ts` (which would
// load `@playwright/test` and the whole helper module at import time). The
// seed KIND table lives in `manifest.ts` for exactly this reason (review
// finding 22); `seeds.ts` imports it from there.
import { describe, expect, it } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { parseManifest, resolveRoute, SEED_PARAMS } from "../../../e2e/visual/manifest";

const WEB = resolve(import.meta.dirname, "../../..");
const MANIFEST = join(WEB, "e2e/visual/manifest.json");

function load() {
  return parseManifest(JSON.parse(readFileSync(MANIFEST, "utf8")));
}

describe("e2e/visual/manifest.json", () => {
  it("parses, and is not empty (an empty manifest photographs nothing and passes)", () => {
    const m = load();
    expect(m.groups.length).toBeGreaterThan(0);
    for (const g of m.groups) expect(g.rows.length, `group ${g.id} has no rows`).toBeGreaterThan(0);
  });

  it("every route placeholder is provided by the group's seed kind", () => {
    for (const g of load().groups) {
      const params = Object.fromEntries(SEED_PARAMS[g.seed].map((k) => [k, "x"]));
      for (const r of g.rows) {
        expect(() => resolveRoute(r.route, params), `${g.id}/${r.id}: ${r.route}`).not.toThrow();
      }
    }
  });

  it("every mustDiffer and controlSetEqual reference names a row in the same group, and controlSetEqual rows carry a controlRoot", () => {
    for (const g of load().groups) {
      const ids = new Set(g.rows.map((r) => r.id));
      for (const [a, b] of g.mustDiffer) {
        expect(ids.has(a) && ids.has(b), `${g.id}: mustDiffer ${a}/${b}`).toBe(true);
        expect(a).not.toBe(b);
      }
      for (const [a, b] of g.controlSetEqual) {
        expect(ids.has(a) && ids.has(b), `${g.id}: controlSetEqual ${a}/${b}`).toBe(true);
        for (const id of [a, b]) {
          expect(g.rows.find((r) => r.id === id)!.controlRoot, `${g.id}/${id} has no controlRoot`).not.toBeNull();
        }
      }
    }
  });

  it("rejects what the harness cannot run, by name", () => {
    const base = { version: 1, groups: [{ id: "g", seed: "none", rows: [{ id: "r", route: "/", viewport: { width: 320, height: 568 }, awaitSelector: "body" }] }] };
    expect(() => parseManifest({ ...base, groups: [{ ...base.groups[0], rows: [{ ...base.groups[0]!.rows[0], checks: ["no-such-check"] }] }] })).toThrow(/no-such-check|invalid/i);
    expect(() => parseManifest({ ...base, groups: [{ ...base.groups[0], seed: "no-such-seed" }] })).toThrow(/no-such-seed|invalid/i);
    expect(() => parseManifest({ ...base, groups: [{ ...base.groups[0], mustDiffer: [["r", "ghost"]] }] })).toThrow(/ghost/);
    expect(() => parseManifest({ ...base, groups: [{ ...base.groups[0], rows: [base.groups[0]!.rows[0], base.groups[0]!.rows[0]] }] })).toThrow(/duplicate/i);
    expect(() => parseManifest({ ...base, groups: [] })).toThrow(/empty|at least/i);
    // Positive pair: the minimal manifest above is valid.
    expect(() => parseManifest(base)).not.toThrow();
  });

  it("resolveRoute refuses an unresolved placeholder rather than fetching a literal '{fixtureId}'", () => {
    expect(resolveRoute("/a/{x}/b", { x: "1" })).toBe("/a/1/b");
    expect(() => resolveRoute("/a/{x}/{y}", { x: "1" })).toThrow(/\{y\}/);
  });

  it("the capture spec is a .spec.ts outside every carve-out, so the parallel 'rest' leg selects it", () => {
    // The authoritative check is e2e-ci-wiring.test.ts › "runs every spec
    // file in at least one CI leg", which evaluates the REAL config; this
    // case pins the two facts that make that true, so a rename of the file
    // or the directory fails here with the reason.
    const path = "/e2e/visual/capture.spec.ts";
    expect(existsSync(join(WEB, path.slice(1))), `${path} is missing`).toBe(true);
    expect(/\.(spec|test)\.[cm]?[jt]sx?$/.test(path), "default testMatch").toBe(true);
    expect(/[\\/]e2e[\\/]walkthrough[\\/]/.test(path), "not the walkthrough carve-out").toBe(false);
    expect(/mobile\.spec\.ts/.test(path), "not the mobile matrix").toBe(false);
    expect(/(scorepad-v3-cricket|marketing-ai-demo|board-v3)\.spec\.ts/.test(path), "not PARALLEL_HEAVY").toBe(false);
  });
});
```

- [ ] **Step 4: Run it — expect red (collection).** `cd /Users/ashokhein/github/seazn.club/.claude/worktrees/stream-overlay/apps/web && npx vitest run src/lib/__tests__/visual-manifest.test.ts --reporter=json --outputFile=/private/tmp/claude-501/-Users-ashokhein-github-seazn-club/b30673ed-f5cd-42f4-b756-805514a83656/scratchpad/t1/t3a-red.json; node -e "const r=require('/private/tmp/claude-501/-Users-ashokhein-github-seazn-club/b30673ed-f5cd-42f4-b756-805514a83656/scratchpad/t1/t3a-red.json');console.log(r.numTotalTests,(r.testResults[0]||{}).message)"`
  Expected: `Cannot find module '../../../e2e/visual/manifest'`, `numTotalTests: 0`.

- [ ] **Step 5: Write `e2e/visual/manifest.ts`.**

```ts
// The visual gate's manifest: what to photograph, at what size, and what to
// hold each picture to. Deny by default — an unknown check, an unknown seed
// kind, a dangling reference or a duplicate id is refused at parse time, with
// the offending name, so a later wave's appended row cannot silently no-op.
import { z } from "zod";

/** Seed kinds and the placeholders each provides — declared HERE (a pure
 *  module) so the manifest unit test needs nothing from `helpers.ts`;
 *  `seeds.ts` imports these and supplies the recipes. A later wave adds its
 *  kind to BOTH tables in this file and its recipe in `seeds.ts`. */
export const SEED_KINDS = ["none", "public-fixture"] as const;
export type SeedKind = (typeof SEED_KINDS)[number];
export const SEED_PARAMS: Record<SeedKind, readonly string[]> = {
  none: [],
  "public-fixture": ["orgSlug", "compSlug", "divSlug", "divisionId", "fixtureId"],
};

export const VISUAL_CHECKS = [
  "no-horizontal-scroll",
  "no-clip",
  "hit-targets",
  "truncate-chain",
  "rails-a11y",
] as const;
export type VisualCheck = (typeof VISUAL_CHECKS)[number];

const RowSchema = z.object({
  id: z.string().min(1),
  /** A path with `{placeholders}` the group's seed provides. */
  route: z.string().startsWith("/"),
  /** The WINDOW size at 100 %. The harness divides by `zoom` for the CSS viewport. */
  viewport: z.object({ width: z.number().int().min(320).max(1920), height: z.number().int().min(480).max(1080) }),
  /** 1 = 100 %. 1.25 = the browser's 125 % (CSS viewport ÷ 1.25, DPR × 1.25). */
  zoom: z.number().min(0.5).max(2).default(1),
  backdrop: z.enum(["light", "dark"]).nullable().default(null),
  /** CSS selector the page must render before the shot — the state proven. */
  awaitSelector: z.string().min(1),
  /** Signed in as the shared Pro org (AUTH_STATE) or anonymous. */
  auth: z.boolean().default(false),
  /** Root for `controlSet`; required for a row named in `controlSetEqual`. */
  controlRoot: z.string().min(1).nullable().default(null),
  checks: z.array(z.enum(VISUAL_CHECKS)).default([]),
});

const GroupSchema = z.object({
  id: z.string().min(1),
  seed: z.enum(SEED_KINDS),
  rows: z.array(RowSchema).min(1),
  /** Pairs of row ids whose PNG hashes must differ (recurring class 10). */
  mustDiffer: z.array(z.tuple([z.string(), z.string()])).default([]),
  /** Pairs of row ids whose visible control SET must be identical
   *  (membership, order, repeats — never box size). */
  controlSetEqual: z.array(z.tuple([z.string(), z.string()])).default([]),
});

const ManifestSchema = z.object({
  version: z.literal(1),
  groups: z.array(GroupSchema).min(1, "manifest has no groups — an empty manifest photographs nothing"),
});

export type VisualRow = z.infer<typeof RowSchema>;
export type VisualGroup = z.infer<typeof GroupSchema>;
export type VisualManifest = z.infer<typeof ManifestSchema>;

export function parseManifest(json: unknown): VisualManifest {
  const m = ManifestSchema.parse(json);
  const seenGroup = new Set<string>();
  for (const g of m.groups) {
    if (seenGroup.has(g.id)) throw new Error(`duplicate group id ${g.id}`);
    seenGroup.add(g.id);
    const ids = new Set<string>();
    for (const r of g.rows) {
      if (ids.has(r.id)) throw new Error(`duplicate row id ${g.id}/${r.id}`);
      ids.add(r.id);
    }
    for (const [a, b] of [...g.mustDiffer, ...g.controlSetEqual]) {
      for (const id of [a, b]) if (!ids.has(id)) throw new Error(`${g.id}: reference to unknown row ${id}`);
      if (a === b) throw new Error(`${g.id}: a row cannot be compared with itself (${a})`);
    }
    for (const [a, b] of g.controlSetEqual) {
      for (const id of [a, b]) {
        if (g.rows.find((r) => r.id === id)!.controlRoot === null) {
          throw new Error(`${g.id}/${id}: named in controlSetEqual but has no controlRoot`);
        }
      }
    }
  }
  return m;
}

/** `/shared/{orgSlug}/…` → the seed's values. A placeholder the seed did not
 *  provide throws with its name; the harness must never fetch a literal
 *  `{fixtureId}` and photograph a 404 as if it were the page. */
export function resolveRoute(template: string, params: Record<string, string>): string {
  const out = template.replace(/\{([a-zA-Z0-9_]+)\}/g, (_, key: string) => {
    const v = params[key];
    if (v === undefined) throw new Error(`route ${template}: unresolved placeholder {${key}}`);
    return encodeURIComponent(v);
  });
  return out;
}
```

- [ ] **Step 6: Write `e2e/visual/seeds.ts` — the ONE extension point.**

```ts
// What each manifest group needs seeded, and the placeholders it then
// provides. THIS is the file a later wave extends (W1-E adds
// "overlay-fixture", R2 adds "relay-session"); the harness itself does not
// change. SEED_PARAMS is read by the manifest unit test so a route asking for
// a placeholder its seed cannot provide fails in seconds, not in Playwright.
import type { Page } from "@playwright/test";
import { activeOrg, apiJson, scoreFixture, seedRosteredFixture, TAG } from "../helpers";
import type { SeedKind } from "./manifest";

// SEED_KINDS / SEED_PARAMS are declared in ./manifest (pure); this file holds
// the RECIPES. Adding a kind = one entry in each table there + one case here.

/** A PUBLIC competition with one started, scored football fixture — the
 *  public match page and the embed widgets both render it. `skipLineups`:
 *  the pad's rosterless case, so no position rule can refuse the seed. */
async function publicFixture(page: Page): Promise<Record<string, string>> {
  const request = page.request;
  const seeded = await seedRosteredFixture(request, {
    label: `Visual gate ${TAG}`,
    sportKey: "football",
    variantKey: "",
    home: [{ fullName: "Ada Okafor" }, { fullName: "Bea Nwosu" }],
    away: [{ fullName: "Cal Adeyemi" }, { fullName: "Dee Harbour" }],
    entrantKind: "team",
    emitCoreStart: true,
    skipLineups: true,
  });
  // One goal so the page shows a score, not two dashes.
  await scoreFixture(request, seeded.fixtureId, 1, 0);
  const org = await activeOrg(page);
  const comp = await apiJson<{ slug: string }>(request, `/api/v1/competitions/${seeded.competitionId}`);
  const div = await apiJson<{ slug: string }>(request, `/api/v1/divisions/${seeded.divisionId}`);
  if (!comp.data?.slug || !div.data?.slug) {
    throw new Error(`seed public-fixture: slugs missing (comp ${comp.status}, div ${div.status})`);
  }
  return {
    orgSlug: org.slug,
    compSlug: comp.data.slug,
    divSlug: div.data.slug,
    divisionId: seeded.divisionId,
    fixtureId: seeded.fixtureId,
  };
}

export async function seedFor(kind: SeedKind, page: Page): Promise<Record<string, string>> {
  switch (kind) {
    case "none":
      return {};
    case "public-fixture":
      return publicFixture(page);
  }
}
```

  RE-PIN at execution: `activeOrg` returns `OrgInfo` — confirm it carries `slug` (`helpers.ts:1335` and the `OrgInfo` interface above it); `GET /api/v1/competitions/{id}` and `GET /api/v1/divisions/{id}` return `slug` (`calendar-ics.spec.ts:93` reads both the same way). `scoreFixture`'s payload is sport-generic (`:1738`) — if football refuses it, replace the call with one `football.goal` POST through `apiJson(request, \`/api/v1/fixtures/${id}/events\`, "POST", { expected_seq, type: "football.goal", payload: { by: "home" } })` and record which.

- [ ] **Step 7: Write `e2e/visual/asserts.ts` — the checklist as code.**

```ts
// The owner checklist's VERIFY-AS-CUSTOMER rows, each as one reusable
// assertion the capture spec runs per manifest row. Every function returns
// offenders BY NAME so a red names a thing, not a count.
import { expect, type Page } from "@playwright/test";
import { overflowingIn } from "../helpers";
import { floorViolationLines, hitTargetFloorReport, measureHitTargets } from "../scorepad-a11y-kit";

export const BACKDROPS = {
  light: "linear-gradient(180deg, #e8f0e2 0%, #3d7a3a 55%, #2e6a2d 100%)",
  dark: "linear-gradient(180deg, #0a0d14 0%, #1c2230 100%)",
} as const;

/** What a check INSPECTED, returned on PASS as well as fail so the log and
 *  report.json carry the element list, not a boolean (_RULES.md
 *  §Verification: "print what you saw beside every pass/fail"). A green
 *  `no-clip` over a `controlRoot` that was not in the DOM shows
 *  `inspected: 0`, which the reader can see. */
export interface Seen {
  inspected: number;
  sample: string[];
}

/** Paint the backdrop UNDER the page. A transparent segment (the overlay)
 *  composites over it the way OBS composites over a camera; an opaque page
 *  is unaffected. `!important` so the root layout's own ground cannot win. */
export async function applyBackdrop(page: Page, backdrop: keyof typeof BACKDROPS): Promise<void> {
  await page.addStyleTag({
    content: `html { background: ${BACKDROPS[backdrop]} fixed !important; min-height: 100vh; }`,
  });
}

/** The visible interactive controls under `root`, in DOM order, named by
 *  data-testid, then aria-label, then text. Membership, ORDER and REPEATS —
 *  the thing to diff between 320 and 1280, never box size. */
export async function controlSet(page: Page, root: string): Promise<string[]> {
  return page.evaluate((rootSel) => {
    const rootEl = document.querySelector<HTMLElement>(rootSel);
    if (!rootEl) return [`<${rootSel} not in DOM>`];
    return Array.from(
      rootEl.querySelectorAll<HTMLElement>('button, a[href], select, input, textarea, [role="button"], [role="tab"], [role="radio"]'),
    )
      .filter((el) => {
        const r = el.getBoundingClientRect();
        const cs = getComputedStyle(el);
        return r.width > 0 && r.height > 0 && cs.visibility !== "hidden" && cs.display !== "none";
      })
      .map((el) =>
        el.dataset.testid ??
        el.getAttribute("aria-label") ??
        (el.textContent ?? "").trim().replace(/\s+/g, " ").slice(0, 60),
      );
  }, root);
}

/** No REAL clip under `root`: content wider than a box that cannot scroll and
 *  is not truncated on purpose. Reachable rails are allowed here and held to
 *  their own invariant by `expectRailsA11y`. */
export async function expectNoClip(page: Page, root: string, label: string): Promise<Seen> {
  const childSel = "button,div,span,p,a,li,td,th,h1,h2,h3";
  const { clipped, scrollable, truncatedByDesign } = await overflowingIn(page, root, childSel, `${root} was not in the DOM`);
  const inspected = await page.locator(`${root}, ${root} :is(${childSel})`).count();
  expect(inspected, `${label}: ${root} inspected nothing — is the root in the DOM?`).toBeGreaterThan(0);
  expect(clipped, `${label}: clipped content under ${root}`).toEqual([]);
  return { inspected, sample: [...scrollable.slice(0, 3).map((s) => `rail: ${s}`), ...truncatedByDesign.slice(0, 3).map((s) => `truncated: ${s}`)] };
}

/** Every operable control under `root` is ≥ 44 × 44 by its real box AND is
 *  the thing a tap at its centre reaches (`elementFromPoint`, recurring
 *  class 2: boundingBox() measures paint, not hit area). */
export async function expectHitTargetsByPoint(page: Page, root: string, label: string): Promise<Seen> {
  const scope = page.locator(root);
  const targets = await measureHitTargets(scope);
  const report = hitTargetFloorReport(targets);
  expect(floorViolationLines(report), `${label}: controls under 44px`).toEqual([]);
  const missed = await page.evaluate((rootSel) => {
    const rootEl = document.querySelector<HTMLElement>(rootSel);
    if (!rootEl) return [`<${rootSel} not in DOM>`];
    const out: string[] = [];
    for (const el of Array.from(rootEl.querySelectorAll<HTMLElement>('button, a[href], select, [role="button"], [role="tab"]'))) {
      const r = el.getBoundingClientRect();
      if (r.width <= 0 || r.height <= 0) continue;
      if ((el as HTMLButtonElement).disabled) continue;
      const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
      if (!hit || !(el === hit || el.contains(hit))) {
        out.push(`${el.dataset.testid ?? el.getAttribute("aria-label") ?? el.tagName.toLowerCase()} @ (${Math.round(r.left + r.width / 2)},${Math.round(r.top + r.height / 2)}) hits ${hit ? hit.tagName.toLowerCase() : "nothing"}`);
      }
    }
    return out;
  }, root);
  expect(missed, `${label}: a tap at the centre reaches something else`).toEqual([]);
  return { inspected: report.operable.length, sample: report.operable.slice(0, 5).map((t) => `${t.name} ${t.width}x${t.height}`) };
}

/** Every `truncate` (ellipsis + nowrap + hidden) has `min-width: 0` on EVERY
 *  flex/grid-item ancestor up to the page root — the missing one is what put
 *  106px of overflow on the console at 320 with a 43-character name. */
export async function expectTruncateChain(page: Page, label: string): Promise<Seen> {
  const { offenders, truncates } = await page.evaluate(() => {
    const out: string[] = [];
    const truncates: string[] = [];
    const isTruncate = (cs: CSSStyleDeclaration) =>
      cs.textOverflow === "ellipsis" && cs.whiteSpace === "nowrap" && /hidden|clip/.test(cs.overflowX);
    const describe = (el: Element) =>
      `${el.tagName.toLowerCase()}${(el as HTMLElement).dataset?.testid ? `[data-testid=${(el as HTMLElement).dataset.testid}]` : ""}${el.className && typeof el.className === "string" ? "." + el.className.trim().split(/\s+/).slice(0, 3).join(".") : ""}`;
    for (const el of Array.from(document.querySelectorAll<HTMLElement>("*"))) {
      const cs = getComputedStyle(el);
      if (!isTruncate(cs)) continue;
      truncates.push(describe(el));
      let node: HTMLElement | null = el;
      while (node && node !== document.body) {
        const parent: HTMLElement | null = node.parentElement;
        if (!parent) break;
        const pd = getComputedStyle(parent).display;
        if (/flex|grid/.test(pd) && getComputedStyle(node).minWidth !== "0px") {
          out.push(`${describe(el)} → ancestor ${describe(node)} is a ${pd} item without min-width:0`);
          break;
        }
        node = parent;
      }
    }
    return { offenders: out, truncates };
  });
  expect(offenders, `${label}: truncate without min-w-0 on the whole chain`).toEqual([]);
  return { inspected: truncates.length, sample: truncates.slice(0, 5) };
}

/** Every scrolling rail (overflow-x auto|scroll AND actually overflowing) is
 *  keyboard-reachable — `tabindex="0"` on the rail, or a focusable child
 *  inside it (axe accepts either) — and a rail that carries tabindex="0"
 *  also carries a role and an accessible name. The exemption list is
 *  asserted, not assumed: every reachable rail is returned by name. */
export async function expectRailsA11y(page: Page, label: string, opts: { assert: boolean } = { assert: true }): Promise<{ rails: string[]; offenders: string[] }> {
  const { offenders, rails } = await page.evaluate(() => {
    const offenders: string[] = [];
    const rails: string[] = [];
    const focusable = 'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';
    for (const el of Array.from(document.querySelectorAll<HTMLElement>("*"))) {
      const cs = getComputedStyle(el);
      if (!/^(auto|scroll)$/.test(cs.overflowX) || el.scrollWidth - el.clientWidth <= 1) continue;
      const name = `${el.tagName.toLowerCase()}${el.dataset.testid ? `[data-testid=${el.dataset.testid}]` : ""} ${el.scrollWidth}px in ${el.clientWidth}px`;
      rails.push(name);
      const ownTab = el.getAttribute("tabindex") === "0";
      const childFocusable = el.querySelector(focusable) !== null;
      if (!ownTab && !childFocusable) offenders.push(`${name}: not keyboard-reachable (no tabindex=0, no focusable child)`);
      if (ownTab) {
        if (!el.getAttribute("role")) offenders.push(`${name}: tabindex=0 without a role`);
        if (!el.getAttribute("aria-label") && !el.getAttribute("aria-labelledby")) offenders.push(`${name}: tabindex=0 without an accessible name`);
      }
    }
    return { offenders, rails };
  });
  // Inspected on every row for the report; ASSERTED only when the row lists
  // the check (review finding 20) — so `rails: []` in report.json means "no
  // overflowing rail", never "the check was not run".
  if (opts.assert) expect(offenders, `${label}: scrolling rails`).toEqual([]);
  return { rails, offenders };
}
```

- [ ] **Step 8: Write `e2e/visual/manifest.json` — the rows that exist TODAY.**

```json
{
  "version": 1,
  "groups": [
    {
      "id": "public-fixture",
      "seed": "public-fixture",
      "rows": [
        {
          "id": "fixture-320",
          "route": "/shared/{orgSlug}/{compSlug}/{divSlug}/fixtures/{fixtureId}",
          "viewport": { "width": 320, "height": 568 },
          "awaitSelector": "main h1",
          "controlRoot": "main",
          "checks": ["no-horizontal-scroll", "no-clip", "hit-targets", "truncate-chain", "rails-a11y"]
        },
        {
          "id": "fixture-320-zoom125",
          "route": "/shared/{orgSlug}/{compSlug}/{divSlug}/fixtures/{fixtureId}",
          "viewport": { "width": 320, "height": 568 },
          "zoom": 1.25,
          "awaitSelector": "main h1",
          "controlRoot": "main",
          "checks": ["no-horizontal-scroll", "no-clip", "truncate-chain", "rails-a11y"]
        },
        {
          "id": "fixture-768",
          "route": "/shared/{orgSlug}/{compSlug}/{divSlug}/fixtures/{fixtureId}",
          "viewport": { "width": 768, "height": 1024 },
          "awaitSelector": "main h1",
          "controlRoot": "main",
          "checks": ["no-horizontal-scroll", "no-clip", "hit-targets", "truncate-chain", "rails-a11y"]
        },
        {
          "id": "fixture-1280",
          "route": "/shared/{orgSlug}/{compSlug}/{divSlug}/fixtures/{fixtureId}",
          "viewport": { "width": 1280, "height": 800 },
          "awaitSelector": "main h1",
          "controlRoot": "main",
          "checks": ["no-horizontal-scroll", "no-clip", "truncate-chain", "rails-a11y"]
        }
      ],
      "mustDiffer": [["fixture-320", "fixture-1280"], ["fixture-320", "fixture-320-zoom125"]],
      "controlSetEqual": [["fixture-320", "fixture-1280"]]
    },
    {
      "id": "embed-standings",
      "seed": "public-fixture",
      "rows": [
        {
          "id": "standings-768",
          "route": "/embed/divisions/{divisionId}/standings",
          "viewport": { "width": 768, "height": 600 },
          "awaitSelector": "table",
          "controlRoot": null,
          "checks": ["no-horizontal-scroll", "no-clip", "rails-a11y"]
        },
        {
          "id": "standings-320",
          "route": "/embed/divisions/{divisionId}/standings",
          "viewport": { "width": 320, "height": 600 },
          "awaitSelector": "table",
          "controlRoot": null,
          "checks": ["no-horizontal-scroll", "rails-a11y"]
        }
      ],
      "mustDiffer": [["standings-768", "standings-320"]],
      "controlSetEqual": []
    }
  ]
}
```

  RE-PIN at execution: `main h1` on the public fixture page — open `apps/web/src/app/(public)/shared/[orgSlug]/[competitionSlug]/[divisionSlug]/fixtures/[fixtureId]/page.tsx` and confirm the headline block renders an `h1` inside `main`; if it is `h2`, change the selector, never the page. `fixture-320` omits nothing; `fixture-1280` omits `hit-targets` because a desktop page is not held to the 44-px tap floor (the row is the diff partner). `standings-320` omits `no-clip` on purpose — the standings table is a WIDE table that scrolls inside its own container by design (AGENTS.md: "wide tables scroll inside their own overflow-x-auto container"), and `rails-a11y` is the assertion that holds that exemption to its invariant.

- [ ] **Step 9: Write `e2e/visual/capture.spec.ts`.**

```ts
// The visual gate (spec §4.2). Walks e2e/visual/manifest.json: seed → one
// context per row (viewport ÷ zoom, deviceScaleFactor = zoom — real browser
// zoom, not CSS zoom) → await the state → paint the backdrop → PNG + sha256
// → the row's checks → the group's cross-row assertions → report.json.
//
// Recurring class 10, the harness's own vacuous mode, is closed three ways:
// a group asserts it wrote exactly its row count; every `mustDiffer` pair is
// compared by hash; and the LAST assertion of every group runs after every
// row's state was awaited. There is no env-var skip: a run that photographs
// nothing fails.
//
// Lives under e2e/visual/ as a .spec.ts so the parallel project's catch-all
// "rest" leg runs it in CI with no config edit (visual-manifest.test.ts
// proves the selection). Locally, VISUAL_DIR points the PNGs somewhere
// durable; the default is apps/web/test-results/visual/<TAG> (gitignored).
import { test, expect, type Browser, type Page } from "@playwright/test";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { TAG, expectNoHorizontalScroll } from "../helpers";
import { dismissCookieBanner } from "../scorepad-a11y-kit";
import { parseManifest, resolveRoute, type VisualGroup, type VisualRow } from "./manifest";
import { seedFor } from "./seeds";
import {
  applyBackdrop,
  controlSet,
  expectHitTargetsByPoint,
  expectNoClip,
  expectRailsA11y,
  expectTruncateChain,
  type Seen,
} from "./asserts";

/** A real screenshot of a rendered page is never this small; a blank or an
 *  aborted capture is (T1 prompt item 6: "exists and is > 1 KB"). */
const MIN_PNG_BYTES = 1024;

const AUTH_STATE = "e2e/.auth/pro.json";
const OUT = process.env.VISUAL_DIR ?? join(process.cwd(), "test-results", "visual", TAG);
const manifest = parseManifest(JSON.parse(readFileSync(join(process.cwd(), "e2e/visual/manifest.json"), "utf8")));

interface Shot {
  id: string;
  file: string;
  /** PNG byte length — the anti-vacuity guard (a real screenshot is > 1 KB). */
  bytes: number;
  sha256: string;
  controls: string[] | null;
  rails: string[];
  /** What each check INSPECTED (counts + a sample), printed on pass too. */
  seen: Record<string, Seen>;
}

async function captureRow(browser: Browser, group: VisualGroup, row: VisualRow, params: Record<string, string>): Promise<Shot> {
  const context = await browser.newContext({
    viewport: { width: Math.round(row.viewport.width / row.zoom), height: Math.round(row.viewport.height / row.zoom) },
    deviceScaleFactor: row.zoom,
    storageState: row.auth ? AUTH_STATE : { cookies: [], origins: [] },
    reducedMotion: "reduce",
  });
  const page = await context.newPage();
  const label = `${group.id}/${row.id}`;
  try {
    await page.goto(resolveRoute(row.route, params), { waitUntil: "load" });
    await expect(page.locator(row.awaitSelector).first(), `${label}: ${row.awaitSelector} never rendered`).toBeVisible();
    await dismissCookieBanner(page);
    if (row.backdrop) await applyBackdrop(page, row.backdrop);
    await page.evaluate(() => document.fonts.ready);
    const file = join(OUT, `${group.id}--${row.id}.png`);
    await page.screenshot({ path: file, fullPage: false });
    const bytes = readFileSync(file);
    // PNG IHDR width at bytes 16–19: at zoom 1.25 the CSS viewport is 256 px
    // but the PICTURE is 320 px wide — the only proof the DPR actually applied.
    expect(bytes.readUInt32BE(16), `${label}: PNG width — deviceScaleFactor did not apply`).toBe(row.viewport.width);
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    writeFileSync(`${file}.sha256`, sha256);

    const seen: Record<string, Seen> = {};
    for (const check of row.checks) {
      switch (check) {
        case "no-horizontal-scroll":
          await expectNoHorizontalScroll(page);
          seen[check] = { inspected: 1, sample: ["document"] };
          break;
        case "no-clip":
          seen[check] = await expectNoClip(page, row.controlRoot ?? "body", label);
          break;
        case "hit-targets":
          seen[check] = await expectHitTargetsByPoint(page, row.controlRoot ?? "body", label);
          break;
        case "truncate-chain":
          seen[check] = await expectTruncateChain(page, label);
          break;
        case "rails-a11y":
          break; // inspected on EVERY row below for the report; asserted only when listed
      }
    }
    // Rails are inspected on every row so report.json never says "no rails"
    // for a row that simply did not list the check (review finding 20).
    const rails = await expectRailsA11y(page, label, { assert: row.checks.includes("rails-a11y") });
    const controls = row.controlRoot ? await controlSet(page, row.controlRoot) : null;
    // Print what was SEEN on pass, not only on fail (_RULES.md §Verification;
    // review finding 12): counts and a sample per check, beside the picture.
    console.log(
      `[visual ${label}] ${row.viewport.width}x${row.viewport.height}@${row.zoom} ` +
        `png=${bytes.length}B sha=${sha256.slice(0, 12)} rails=${rails.rails.length}` +
        (controls ? ` controls=${controls.length}` : "") +
        ` seen=${JSON.stringify(seen)}`,
    );
    return { id: row.id, file, bytes: bytes.length, sha256, controls, rails: rails.rails, seen };
  } finally {
    await context.close();
  }
}

test.describe("visual gate", () => {
  test.beforeAll(() => {
    mkdirSync(OUT, { recursive: true });
  });

  for (const group of manifest.groups) {
    test(`${group.id}: ${group.rows.length} rows`, async ({ browser, page }) => {
      test.setTimeout(30_000 + group.rows.length * 20_000);
      const params = await seedFor(group.seed, page);
      const shots: Shot[] = [];
      for (const row of group.rows) shots.push(await captureRow(browser, group, row, params));

      // Every declared image exists on disk — the harness did not skip a row.
      expect(shots.map((s) => existsSync(s.file)), `${group.id}: a PNG is missing`).toEqual(group.rows.map(() => true));
      expect(shots.length, `${group.id}: wrote fewer images than rows`).toBe(group.rows.length);

      const byId = new Map(shots.map((s) => [s.id, s]));
      for (const [a, b] of group.mustDiffer) {
        expect(byId.get(a)!.sha256, `${group.id}: ${a} and ${b} are pixel-identical — nothing opened, or the size never applied`).not.toBe(byId.get(b)!.sha256);
      }
      for (const [a, b] of group.controlSetEqual) {
        const ca = byId.get(a)!.controls!;
        const cb = byId.get(b)!.controls!;
        console.log(`[control-set ${group.id}] ${a}: ${ca.length} controls\n  ${ca.join("\n  ")}\n${b}: ${cb.length} controls\n  ${cb.join("\n  ")}`);
        expect(ca, `${group.id}: control SET differs between ${a} and ${b} (membership, order or repeats)`).toEqual(cb);
      }

      writeFileSync(
        join(OUT, `${group.id}.report.json`),
        JSON.stringify({ group: group.id, seed: params, shots }, null, 2),
      );
      // LAST, after every state was awaited and every picture written: the
      // group is not vacuous. Two guards a broken run actually violates
      // (review 2026-09-08 finding 9 — the previous `sha256.length === 64`
      // could never fire): every PNG is a real picture, and where the group
      // declares any mustDiffer pair, the group's hashes are not all one value.
      expect(shots.map((s) => [s.id, s.bytes > MIN_PNG_BYTES]), `${group.id}: a PNG under ${MIN_PNG_BYTES} bytes is a blank or aborted capture`).toEqual(shots.map((s) => [s.id, true]));
      if (group.mustDiffer.length > 0) {
        expect(new Set(shots.map((s) => s.sha256)).size, `${group.id}: every picture is identical — nothing opened`).toBeGreaterThan(1);
      }
    });
  }
});
```

- [ ] **Step 10: Run the unit test — expect PASS.** `cd /Users/ashokhein/github/seazn.club/.claude/worktrees/stream-overlay/apps/web && npx vitest run src/lib/__tests__/visual-manifest.test.ts src/lib/__tests__/e2e-ci-wiring.test.ts --reporter=json --outputFile=/private/tmp/claude-501/-Users-ashokhein-github-seazn-club/b30673ed-f5cd-42f4-b756-805514a83656/scratchpad/t1/t3a-green.json; node -e "const r=require('/private/tmp/claude-501/-Users-ashokhein-github-seazn-club/b30673ed-f5cd-42f4-b756-805514a83656/scratchpad/t1/t3a-green.json');console.log(r.numPassedTests,r.numTotalTests,r.numFailedTests)"`
  Expected: `numFailedTests: 0` — the manifest test's 6 cases AND the wiring test's `runs every spec file in at least one CI leg` (which now sees `visual/capture.spec.ts` and finds "rest" selects it). If the wiring test reds naming `visual/capture.spec.ts` as an orphan, the config has an ignore this plan did not read — stop, read `playwright.config.ts:140-162` again, and record.
  Then the DIRECT proof the T1 prompt asks for (item 9; review finding 11) — ask Playwright what it selected, not a unit test that models the config:
  `cd /Users/ashokhein/github/seazn.club/.claude/worktrees/stream-overlay/apps/web && PLAYWRIGHT_BASE=<ovl base> npx playwright test --list --project=parallel 2>/dev/null | grep -a "visual/capture"`
  Expected: exactly two lines, one per manifest group —
  `[parallel] › visual/capture.spec.ts:<n>:7 › visual gate › public-fixture: 4 rows` and
  `[parallel] › visual/capture.spec.ts:<n>:7 › visual gate › embed-standings: 2 rows`
  (the line/column numbers are Playwright's; the titles and the `[parallel]` project tag are what is asserted). Zero lines = the spec is not selected; more than two = a group was declared twice. Paste the two lines into the PR-T1 inventory.

- [ ] **Step 11: Run the harness against the prod build — expect green and pictures.** `cd /Users/ashokhein/github/seazn.club/.claude/worktrees/stream-overlay && ~/.claude/skills/seazn-local-env/scripts/seazn-env.sh rebuild --label ovl > /dev/null 2>&1; echo "EXIT=$?"` (the helpers move is a code change under `apps/web/e2e`, which the build does not include — but the server must be THIS tree's build; read the `tree` line `status` prints), then
  `cd /Users/ashokhein/github/seazn.club/.claude/worktrees/stream-overlay/apps/web && VISUAL_DIR=/private/tmp/claude-501/-Users-ashokhein-github-seazn-club/b30673ed-f5cd-42f4-b756-805514a83656/scratchpad/t1/shots PLAYWRIGHT_BASE=<ovl base> E2E_PROD_TARGET=1 npx playwright test e2e/visual/capture.spec.ts --project=parallel --reporter=line > /private/tmp/claude-501/-Users-ashokhein-github-seazn-club/b30673ed-f5cd-42f4-b756-805514a83656/scratchpad/t1/visual.log 2>&1; echo "EXIT=$?"; tail -8 /private/tmp/claude-501/-Users-ashokhein-github-seazn-club/b30673ed-f5cd-42f4-b756-805514a83656/scratchpad/t1/visual.log; ls -la /private/tmp/claude-501/-Users-ashokhein-github-seazn-club/b30673ed-f5cd-42f4-b756-805514a83656/scratchpad/t1/shots`
  Expected: `2 passed`, six PNGs + six `.sha256` + two `.report.json`; the `[control-set public-fixture]` block printed with the SAME list twice. Then OPEN the six pictures (Read tool on each PNG) and write one line per picture in the PR-T1 inventory: what is in it, and that the 125 % row is visibly larger type at the same 320 window. A red `truncate-chain` or `rails-a11y` row on the public fixture page is a FINDING about that page, recorded in `_INDEX.md` and attributed to `main`; the harness is right, the page is what is being measured. Do not weaken a check to pass a page that exists today.

- [ ] **Step 12: Mutants, each with its killer.**
  1. `capture.spec.ts`: change `deviceScaleFactor: row.zoom` to `deviceScaleFactor: 1`. The hash check does NOT catch this (the CSS viewport still differs, 256 vs 320, so the pictures still differ). Expected red: `public-fixture` › `fixture-320-zoom125: PNG width — deviceScaleFactor did not apply` — `expected 256 to be 320`. That IHDR assertion exists in `captureRow` for exactly this mutant. Restore.
  2. `capture.spec.ts`: delete the `mustDiffer` loop. Expected red: NONE from the harness itself — so the manifest unit test's `mustDiffer` reference check is not the killer either. The killer is the wiring: change `manifest.json`'s `fixture-1280` viewport to `320×568` (a duplicate of `fixture-320`) WITH the loop present → `pixel-identical` red proves the loop fires; with the loop deleted the duplicate passes. Record: mutant 2 is killed by the duplicate-row probe, run once and reverted.
  3. `asserts.ts` `expectTruncateChain`: change `getComputedStyle(node).minWidth !== "0px"` to `!== "auto"`. Expected red: any page with a correct `min-w-0` chain now reports every ancestor. Killed by `public-fixture` rows going red on a page that passed. Restore.
  4. `asserts.ts` `expectRailsA11y`: delete the `if (ownTab)` block. Expected: survives on today's routes if no rail carries `tabindex="0"` — record the survivor; W1-E's panel rows (a phone rail with `tabindex="0"`) become its killer, and the PR-T1 inventory says so.
  5. `manifest.ts`: delete the duplicate-row throw. Expected red: `visual-manifest.test.ts` › `rejects what the harness cannot run, by name` — `/duplicate/i`. Restore.
  Paste the killer list into the PR-T1 inventory, survivors named as survivors.

- [ ] **Step 13: Smoke — the seeded routes answer, through the server, not the browser.** In `scripts/smoke.ts`, find the block in `main()` where the public/embed checks run (`grep -a -n "embed" scripts/smoke.ts | head` — if an embed standings check already exists, extend it with the `seazn:embed:height` assertion and record that instead of adding a suite). Otherwise add beside the other suite calls:

```ts
  await visualSeedRoutesSuite(admin, org.id);
```

and the function, beside the other `…Suite` functions:

```ts
/** Streaming T1 — the two routes the visual gate photographs today answer as
 *  the manifest expects them to: the public fixture page with its headline,
 *  the embed standings widget with its auto-height script. A 200 whose body
 *  lacks the awaited markup is the inert page the harness would otherwise
 *  photograph as "fine". */
async function visualSeedRoutesSuite(owner: Session, orgId: string): Promise<void> {
  const comp = await v1data<{ id: string; slug: string }>(owner, "POST", "/api/v1/competitions", {
    name: `Visual smoke ${Date.now()}`, visibility: "public", ends_on: "2030-12-31",
  });
  const div = await v1data<{ id: string; slug: string }>(owner, "POST", `/api/v1/competitions/${comp.id}/divisions`, {
    name: "Smoke", sport_key: "football", variant_key: "", config: {},
  });
  const embed = await html(owner, `/embed/divisions/${div.id}/standings`);
  check("visual gate: embed standings renders", embed.status === 200 && embed.body.includes("seazn:embed:height"));
  const orgSlug = (await v1data<{ slug: string }>(owner, "GET", `/api/orgs/${orgId}`)).slug;
  const shared = await html(owner, `/shared/${orgSlug}/${comp.slug}/${div.slug}`);
  check("visual gate: public division page renders", shared.status === 200 && /<h1/.test(shared.body));
}
```

  RE-PIN at execution: `Session`, `v1data`, `html`, `check` are the file's own helpers (`html(s: Session, path)` is `scripts/smoke.ts:13356` on `b2244879f`; `check(label, cond)` and `v1data` are found by `grep -a -n -F "function check(" scripts/smoke.ts` / `grep -a -n -F "function v1data" scripts/smoke.ts` — the file is 17k+ lines and moves every wave, so the symbol is the pin) — read three neighbouring suites and use THEIR signatures; `GET /api/orgs/{id}` may not exist — if not, read the slug from `/api/orgs` (the list) as `activeOrg` does. Then `cd /Users/ashokhein/github/seazn.club/.claude/worktrees/stream-overlay && SMOKE_BASE=<ovl base> DATABASE_URL=<ovl url> DATABASE_SSL=disable node --experimental-strip-types scripts/smoke.ts 2>&1 | grep -a "visual gate"` → two `PASS` lines.

- [ ] **Step 14: Write the runbook.** Create `docs/runbooks/visual-gate.md`:

```markdown
# Visual gate — running and extending the capture harness

The harness is `apps/web/e2e/visual/capture.spec.ts`, driven by
`apps/web/e2e/visual/manifest.json`. It runs in CI on every push to `main`
inside the parallel project's "rest" leg (no config names it — the default
`testMatch` selects it, and `src/lib/__tests__/visual-manifest.test.ts`
proves that on every vitest run). It has NO env-var skip: a run that
photographs nothing fails (recurring failure class 10).

## Run it locally

    S=~/.claude/skills/seazn-local-env/scripts/seazn-env.sh
    $S up --label <label> --server        # from the worktree; rebuild after a code change
    $S env --label <label>                # read PLAYWRIGHT_BASE (= SMOKE_BASE)
    cd apps/web && VISUAL_DIR=/path/you/keep PLAYWRIGHT_BASE=<base> E2E_PROD_TARGET=1 \
      npx playwright test e2e/visual/capture.spec.ts --project=parallel --reporter=line

Pictures land in `VISUAL_DIR` (default `apps/web/test-results/visual/<TAG>`,
gitignored) as `<group>--<row>.png` + `.sha256`, plus `<group>.report.json`
(seed params, hashes, the control set per row, the reachable rails). The
`[control-set …]` block in the log is the 320-vs-1280 diff a reviewer reads.

## What a row asserts

`checks` per row: `no-horizontal-scroll` (page-level, `expectNoHorizontalScroll`),
`no-clip` (real clips under `controlRoot`, split on computed `overflow-x`),
`hit-targets` (≥ 44 px AND `elementFromPoint` reaches the control),
`truncate-chain` (`min-width: 0` on every flex/grid ancestor of a truncate),
`rails-a11y` (every overflowing rail keyboard-reachable; `tabindex="0"` rails
carry a role and a name). Group-level: `mustDiffer` (hashes differ),
`controlSetEqual` (membership, order, repeats — never box size).

`zoom: 1.25` reproduces the browser's 125 %: CSS viewport ÷ 1.25, DPR × 1.25,
own context per row. `backdrop: "light" | "dark"` paints a gradient under a
transparent page (the overlay) — an opaque page is unaffected.

## Add rows for your wave (W1-E, R2 …)

1. Append a group to `manifest.json`. Use an existing `seed` kind if its
   placeholders suffice.
2. Need new state? Add ONE seed kind to `e2e/visual/seeds.ts` (`SEED_KINDS`,
   `SEED_PARAMS`, `seedFor`). That file is the only harness file a wave edits.
3. `npx vitest run src/lib/__tests__/visual-manifest.test.ts` — a dangling
   reference or an unresolved placeholder fails here, in seconds.
4. Run the harness, OPEN the pictures, write one verdict line per picture in
   the PR. A green run is not a sign-off; the pictures are.

A red `truncate-chain` / `rails-a11y` / `hit-targets` row on a page your wave
did not touch is a finding about that page — record it in the programme
`_INDEX.md`, attributed; never loosen the check.
```

- [ ] **Step 15: Gate and commit.**
  `cd /Users/ashokhein/github/seazn.club/.claude/worktrees/stream-overlay/apps/web && DATABASE_URL=<ovl url> DATABASE_SSL=disable npx vitest run src/lib src/components/overlay --reporter=json --outputFile=/private/tmp/claude-501/-Users-ashokhein-github-seazn-club/b30673ed-f5cd-42f4-b756-805514a83656/scratchpad/t1/t3-green.json; node -e "const r=require('/private/tmp/claude-501/-Users-ashokhein-github-seazn-club/b30673ed-f5cd-42f4-b756-805514a83656/scratchpad/t1/t3-green.json');console.log(r.numPassedTests,r.numTotalTests,r.numFailedTests)"` → `numFailedTests` = exactly the six Task 2 Step 8 finding rows and nothing else (the `src/lib` slice includes the wiring test; `src/components/overlay` is Task 2's sweep — review finding 21); `cd /Users/ashokhein/github/seazn.club/.claude/worktrees/stream-overlay && npx tsc --noEmit -p apps/web/tsconfig.json; echo "EXIT=$?"` → `EXIT=0`; `cd /Users/ashokhein/github/seazn.club/.claude/worktrees/stream-overlay && rtk proxy npm run lint 2>&1 | grep -a -E "✖|problems" | tail -1` → `✖ 0 problems` (or Task 0's count, unchanged).
  `cd /Users/ashokhein/github/seazn.club/.claude/worktrees/stream-overlay && /usr/bin/git add apps/web/e2e/helpers.ts apps/web/e2e/mobile.spec.ts apps/web/e2e/visual/manifest.ts apps/web/e2e/visual/manifest.json apps/web/e2e/visual/seeds.ts apps/web/e2e/visual/asserts.ts apps/web/e2e/visual/capture.spec.ts apps/web/src/lib/__tests__/visual-manifest.test.ts scripts/smoke.ts docs/runbooks/visual-gate.md`
  then
  `cd /Users/ashokhein/github/seazn.club/.claude/worktrees/stream-overlay && /usr/bin/git commit -m "e2e(visual): manifest-driven capture harness with the owner checklist as assertions" -m "One spec walks a validated manifest: own context per row (real 125% zoom via DPR), backdrop under transparent pages, sha256 per PNG, mustDiffer and control-set-equal across rows, and the five checklist checks by name. Seeded with routes that exist today; later waves append rows and one seed kind. overflowingIn moves to helpers.ts so the mobile matrix and this gate measure with one function." -m "Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>" -m "Claude-Session: https://claude.ai/code/session_01LJGBoVPAWczYB9c45TD1aw"`

---

### Task 4: Wave close — index, inventory, per-screen sign-off, PR-T1

**Files:**
- Modify: `docs/superpowers/specs/2026-09-05-stream-overlay-prompts/_INDEX.md` — the T1 row, findings, the mutant killer lists
- Modify: `docs/superpowers/specs/2026-09-05-stream-overlay-prompts/_STATE.md` — T1 done; W1 next
- Modify: `docs/superpowers/plans/2026-09-05-stream-overlay-w1.md` — ONLY if execution found a T1 name the W1 amendment cites differently (record, then fix the W1 reference, never the T1 code)

**Interfaces:**
- Consumes: the three commits above; the six PNGs and their verdict lines; the killer lists from Tasks 2 and 3.
- Produces: PR-T1 (docs + T1b code), opened by the MAIN session on the owner's word (never file a PR unprompted); one `_INDEX.md` row; the owner's per-screen sign-off recorded by screen.

**Checklist rows satisfied:** "Report mutant KILLER LIST, not just count"; "Review findings → written to disk"; "Verify visually, always" (sign-off is per picture); "Surface bench/product gaps to owner" (every finding on a `main` page goes to the owner with a recommendation).

- [ ] **Step 1: The full gate against the Task 0 baseline.**
  `cd /Users/ashokhein/github/seazn.club/.claude/worktrees/stream-overlay/apps/web && DATABASE_URL=<ovl url> DATABASE_SSL=disable npx vitest run --reporter=json --outputFile=/private/tmp/claude-501/-Users-ashokhein-github-seazn-club/b30673ed-f5cd-42f4-b756-805514a83656/scratchpad/t1/full.json; node -e "const b=require('/private/tmp/claude-501/-Users-ashokhein-github-seazn-club/b30673ed-f5cd-42f4-b756-805514a83656/scratchpad/t1/baseline-web.json'),r=require('/private/tmp/claude-501/-Users-ashokhein-github-seazn-club/b30673ed-f5cd-42f4-b756-805514a83656/scratchpad/t1/full.json');console.log('baseline',b.numPassedTests,b.numTotalTests,b.numFailedTests);console.log('now',r.numPassedTests,r.numTotalTests,r.numFailedTests);const bad=r.testResults.filter(t=>t.status!=='passed').map(t=>t.name);console.log(bad.join('\n'))"`
  Expected: `now.total` = `baseline.total` + this wave's new tests (Task 2: ≥ 176; Task 3: 6); `now.failed` = `baseline.failed` + the Task 2 finding rows (if any), and the red list names ONLY the baseline files plus those rows. Then `openapi:gen` + `i18n:gen-keys` + porcelain empty (T1 touched neither); the whole `mobile.spec.ts` at ALL seven widths (`--project=mobile-se --project=mobile-14 --project=mobile-320 --project=mobile-360 --project=mobile-430 --project=tablet-768 --project=tablet-834`), counts pasted; and the harness once more from a clean `VISUAL_DIR`.

- [ ] **Step 2: Reviewer pass, then the gap list, then fix, then reviewer again.** Dispatch `reviewer` (`model: opus`) on `/usr/bin/git diff main...HEAD -- apps/web scripts docs/runbooks` with the brief: the three mutant tables, the `where` audit of `OVERLAY_PAIR_ROLES` (every painted pair in `_THEMES.md` §3–§5 has a row), the assertion-reads-as-title check on every `expect` in `asserts.ts` and `capture.spec.ts`, and the pattern exemplars (spec §9a) named in each file's header. Loop until the list is empty.

- [ ] **Step 3: `_INDEX.md` and `_STATE.md`.** In `_INDEX.md`: the T1 row → `done <date>, PR-T1 <n>`; a "T1 findings" list (the contrast rows, the public-page rows, the surviving mutants by name, the RE-PIN outcomes from Task 3 Steps 6/8/13); the killer lists verbatim. In `_STATE.md`: "THE FIRST THING TO DO NEXT SESSION" → "Execute W1 from `plans/2026-09-05-stream-overlay-w1.md` (amended); T1 is merged/in PR; the harness rows W1-E owes are listed in its Task 8".

- [ ] **Step 4: Per-screen sign-off, then hand PR-T1 to the main session.** Post in chat, one line per PNG (six today) and one per T1a pick (four), each with what the owner is looking at and the verdict asked for. The main session opens PR-T1 on the owner's word with the inventory: commits, vitest counts vs baseline, the mutant killer lists, the six pictures, the findings, the `_THEMES.md` sections. e2e before merge: `workflow_dispatch pr=<n>` — the only pre-merge e2e path.

- [ ] **Step 5: Commit.**
  `cd /Users/ashokhein/github/seazn.club/.claude/worktrees/stream-overlay && /usr/bin/git add docs/superpowers/specs/2026-09-05-stream-overlay-prompts/_INDEX.md docs/superpowers/specs/2026-09-05-stream-overlay-prompts/_STATE.md`
  then
  `cd /Users/ashokhein/github/seazn.club/.claude/worktrees/stream-overlay && /usr/bin/git commit -m "docs(streaming): T1 closed — findings, killer lists, sign-off record" -m "Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>" -m "Claude-Session: https://claude.ai/code/session_01LJGBoVPAWczYB9c45TD1aw"`

---

## Self-review

### Spec coverage (§4 and Task 0 of §11)

| Spec requirement | Task |
|---|---|
| §11 Task 0 — worktree recreated and rebased (done by the main session), `ls deltas \| tail`, corpus corrections in place annotated, Q12 reproduction | 0 (Steps 1, 7, 8) |
| §11 Task 0 — the environment and baseline a fresh session judges against | 0 (Steps 2–6, 9) |
| §4.1 ≥ 2 options per un-approved surface: slate, Phone tab, credits card, decided/void | 1 (Step 2, four pairs with values) |
| §4.1 overlay at 1920×1080; panel at 320/768/1280 AND 320 @ 125 %; light + dark composite | 1 (Step 1 artboard list) |
| §4.1 owner picks → `_THEMES.md` §4a / §8a / §8b / decided-void rows / §2 contrast rows | 1 (Step 4) |
| §4.2 `OVERLAY_TOKENS` export whose values ARE the sheet's; derive, never hand-type | 2 (`overlay-tokens.ts` mirrors `globals.css` and is PROVEN equal; per-sport from `SPORT_PALETTES`) |
| §4.2 contrast unit test, 4.5 / 3 floors, every pair incl. §4.1's | 2 (the sweep, alpha roles, slate) |
| §4.2 `capture.spec.ts` driven by `manifest.json`; seeds via `apiJson`; awaits the testid/selector; backdrop; PNG + sha256; exists; `mustDiffer`; last assertion after the state proven | 3 (Steps 5–9) |
| §4.2 seeded with routes that exist today; later waves add rows, never harness code | 3 (Step 8 rows; `seeds.ts` the one extension point; runbook) |
| §4.2 checklist rows as reusable assertions in `asserts.ts` | 3 (Step 7) |
| §10 four test kinds per task | Stated plainly (review finding 14): **Task 0 and Task 1 are DOCUMENTATION tasks** — no code, so the four-kind obligation does not attach (they carry verification commands, not tests). **Task 2**: unit (`lib/__tests__/contrast.test.ts`, `components/overlay/__tests__/contrast.test.ts`) + regression (the mirror vs `globals.css`, the eleven keys vs `V3_SKINS`); e2e and smoke are OWED, not implied — `overlay-tokens.ts` has no HTTP surface until the overlay route exists, so the user-facing flow that exercises it is W1-C's page, and W1 Task 8's e2e/smoke are named as this module's e2e/smoke in that plan's acceptance. **Task 3**: unit (`visual-manifest.test.ts`), e2e (`capture.spec.ts`), smoke (`visualSeedRoutesSuite`), regression (`mobile.spec.ts` unchanged counts after the helper move). **Task 4**: the wave gate; no code |
| §10.2 mutant tables with killer LIST | 2 (Step 9), 3 (Step 12) |
| §10.3 gates per PR incl. whole `mobile.spec.ts`, per-screen sign-off | 4 |
| §9a patterns named with exemplars | Global Constraints; each file header |

### Placeholder scan

No `TBD`, `TODO`, "similar to Task N", "add error handling". The two "RE-PIN at execution" notes (Task 3 Steps 6, 8, 13) name the exact symbol, the file, and the fallback to take — they are instructions, not gaps. `SLATE_TOKENS` carries Option A's values with the rule for B; both columns are in Task 1.

### Type and name consistency

- `overflowingIn` signature identical in `helpers.ts` (Task 3 Step 1) and its callers (`mobile.spec.ts`, `asserts.ts`).
- `VisualRow.controlRoot: string | null` — `manifest.json` rows either give a selector or `null`; `capture.spec.ts` falls back to `"body"` for checks and skips `controlSet` when null; `parseManifest` refuses a `controlSetEqual` row with `null`.
- `SEED_KINDS` (`seeds.ts`) is the source of `GroupSchema.seed`'s enum (`manifest.ts` imports it) and of `SEED_PARAMS`'s keys; the unit test reads both.
- `OVERLAY_PAIR_ROLES[].fg` is `SportToken | "slabDismissalInk"`; the test branches on the literal once.
- The W1 amendment (`2026-09-05-stream-overlay-w1.md`) imports `overlay-tokens.ts` by these names and extends `components/overlay/__tests__/contrast.test.ts` rather than creating it; its Task 8 adds an `overlay-fixture` seed kind to `SEED_KINDS` / `SEED_PARAMS` / `seedFor` and rows to `manifest.json`.
