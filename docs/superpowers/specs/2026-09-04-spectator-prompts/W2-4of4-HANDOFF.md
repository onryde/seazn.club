# Spectator W2 (4/4) — handoff for a new session

Written 2026-09-16. You are picking up **W2 (4/4): Tasks 14–17 + 18 + redirect
prep**, starting from **merged `main`**, in a NEW worktree — not from
`feat/spectator-poster-division`.

Everything below was verified against the tree on 2026-09-16. Where a fact is
"read this yourself", it is because the recorded version is known to go stale —
do not take the summary as the authority.

---

## 1. Read these first, in this order

| File | Why |
| --- | --- |
| `docs/superpowers/specs/2026-09-04-spectator-surface-design.md` | Design of record. |
| `docs/superpowers/specs/2026-09-04-spectator-prompts/_INDEX.md` | Decision log, owner rulings verbatim, false premises. Long — read the LATEST sections first. |
| `.../2026-09-04-spectator-prompts/_RULES.md` | Standing programme rules. |
| `.../2026-09-04-spectator-prompts/_STATE.md` | The LIVE position. The `## Status` wave table in `_INDEX.md` is NOT the live position. |
| `docs/superpowers/plans/2026-09-05-spectator-w2-competition-landing.md` | The plan you are executing (1738 lines). |

**`P<n>` are PREMISES, not tasks. Do not confuse the two axes.** This mistake
was made and caught on 2026-09-16; acting on it would have mis-briefed the
player-page task.

- The plan numbers its **tasks** `### Task 1` … `### Task 19`. There is no
  "P14–P18".
- `P1–P20` are **premises** in the plan's **Re-pin table** (`:153-172` original,
  `:174-199` re-pinned), re-pinned 2026-09-08 against merged main `4ee38278d`:
  all 20 re-opened, 3 held, 17 moved/changed/false.
- The five premises that change *what gets built* are **P5, P11, P12, P13,
  P14** (`_INDEX.md:40`, plan `:100-118`). **P14 = `recomputePlayerStats`, and
  it is consumed by Task 3** (leaders, `:890`, `:899`) — **not** by Task 14.
- The re-pin table therefore says nothing about Tasks 14–18 *as tasks*. What it
  does say about premises those tasks rely on is in §2's table below.

`## Global Constraints` is at plan line **15** (R1–R7 bullets, `:17-24`). Every
task's requirements implicitly include it.

---

## 2. What this batch is, and why it starts at 14

W2's planned **PR4** was plan Tasks **13–18**: division page, player page, org
home, i18n zero-English sweep, walkthrough v2, gates.

- **Task 13 (division page rebuild) — DROPPED.** Owner ruling 2026-09-14.
  Replaced by *redirect prep* (§4 below).
- **Task 15 is already PARTLY DONE** — its layout tagline/footer landed on
  `feat/spectator-poster-division` as N1e e7. The plan itself shows **0 of 72
  steps ticked** (`- [x]` count is zero), because that work landed on another
  branch and was never back-ticked. Diff the branch before rebuilding.
- So the batch is **14, 15 (remainder), 16, 17, 18 + redirect prep**.

The plan has **19 tasks** total; Task 19 is optional, "after W1 has merged".
`_STATE.md`'s completed-task table (`:168-186`) is **W1's** execution state, not
W2's — its only W2 row (`:217`) says "DRAFT plan committed (f0d06b1f1)".

### Your five tasks, verified against the plan 2026-09-16

| # | Deliverable | Premises that bear on it | Dependency |
| --- | --- | --- | --- |
| **14** | Player page — per-match performances from W1's cricket fold, i18n (`:1581`) | **P8 → FALSE, and the absence is stale**: `cricket-ledger.ts` exists, so "Task 14 copies nothing" (`:188`). **P7 → HOLDS** (`:187`) | After 13; lane `{14,15}`, but **shares `data.ts` with Task 15** (`:1732`) — so not truly parallel |
| **15** | Org home — truthful chip from live fixtures, polling chip island (R10), locale dates, tagline/footer (`:1620`) | none named | After 13, lane-parallel with 14 (`:1732`) |
| **16** | i18n sweep leftovers + zero-English regression across every `/shared` page (`:1649`) | **P6 → CHANGED**: the fixture page now mounts `MatchCentreWithTabParam` (`:186`), which **un-gates** the fixture page this task had conditioned on W1's Task 14 (`:158`, `:1664`) | Sequential after 15; needs Task 6's dictionaries landed (`:1732`) |
| **17** | Walkthrough v2, seven-width scan per tab, `mobile.spec` routes, smoke checks (`:1681`) | **P20 → MOVED — "worst drift; touches every e2e task"**: helpers live in `spectator-public-helpers.ts`, **`setScheduledAt` does not exist**, and **`DEFAULT_SHOT_WIDTHS` is 3 widths, not 7** (`:199`). **P17 → CHANGED** (`:197`) | Sequential after 16; orchestrator-owned |
| **18** | Gates, review loop, R11 visual sign-off, programme index (`:1714`) | **P2 → STALE, already fixed**: the `W2-landing.md:4` pointer Task 18 Step 4 owes is already correct (`:182`) | Sequential after 17; **Step 3 consumes Task 17's screenshots** (`:1718`); orchestrator-owned |

**Read that table's sources before trusting it.** Two rows change real work:
Task 17's `DEFAULT_SHOT_WIDTHS` is 3 widths where the task text assumes 7, and
`setScheduledAt` — which the plan's steps call — does not exist.

Only Task 14 and 15 are lane-parallel, and they share `data.ts`. Ownership
lists do not hold across a shared file: run them sequentially, or in separate
worktrees.

**Naming, owner-agreed 2026-09-14 ("Ok"):** `feat/spectator-poster-division` is
NOT "W2 (4/4)". It ships as its own PR titled by content (hub Knockout tab,
share poster, live updates that never freeze). The label "W2 (4/4)" belongs to
THIS batch. W2's earlier PRs were **#758, #760, #774**.

---

## 3. What has already shipped (do not rebuild it)

- **W1 — MERGED** 2026-09-08, PR #743, merge commit `60c0615b0`. Tasks 1–20 all
  shipped, including the 14b–14d and 15b follow-on rounds. Dispositions in
  `W1-whole-branch-review-findings.md`. **W1's task numbers 14–18 are NOT
  yours** — same numbers, different wave. Do not confuse them.
- **W2 PR1–3** — #758, #760, #774.
- **PR #789** (timezone validation + latent reds) — MERGED 2026-09-16,
  squash `e0dafadea`. Public date surfaces now pass an explicit `timeZone`.
- **`feat/spectator-poster-division`** — hub Knockout tab, share poster, kiosk
  `/present` boards, poster.pdf, OG image, news surface. See §7.

**`_INDEX.md`'s wave table is STALE on W3:** it says "not started", but the
poster.png route, the Poster A share image and the poster button are already on
`feat/spectator-poster-division`. W3's remainder is its own session. Fix that
row at your first docs commit.

---

## 4. Redirect prep — the real shape of the work

The public division page is deprecated by a **308 into the hub**, never deleted.
End state: `/shared/{org}/{comp}?tab=matches&division={slug}`. Ruling recorded
in `_INDEX.md` "The public division page — deprecate, but NOT YET".

It is gated on the hub showing everything the division page shows. Status
verified 2026-09-16 by reading the files, not by grep:

| Step | State |
| --- | --- |
| 1 — Knockout tab | **DONE.** `knockout-tab.tsx` exists, rendered at `competition-landing.tsx:391`. The ruling still calls this "the one design call" — that line is now STALE. |
| 2 — squads on Teams cards | **NOT done.** `teams-tab.tsx` is 154 lines and renders no squad/roster; its only `number` hits are comments about `seed`. |
| 3 — suspensions + division description on Info | **PARTIAL.** `info-tab.tsx` has a `descriptionSlot` (`:40`, `:184`, `:205-207`, testid `mh-info-description`). **Suspensions are absent entirely.** |
| 4 — repoint inbound links, then the 308 | Blocked on 2 and 3. |

**The blocker is the DOCUMENT, not the UI.** `competition-hub-schema.ts`
carries neither squads nor suspensions. Adding them is a schema change, which
also forces an `openapi/v1*.json` regen AND a **`pub-hub-v1` cache bump** —
`unstable_cache` will otherwise serve an old-shaped document the page does not
re-parse.

**Step 4's inbound link, precisely located:**
- `apps/web/src/app/o/[orgSlug]/c/[compSlug]/d/[divSlug]/page.tsx:500` — the G9
  "view public" button, hardcoded `/shared/${orgSlug}/${competition.slug}/${divSlug}`.
  Use `routes.shared(org, comp, div)` when you repoint it; the helper already
  takes a divSlug (`lib/routes.ts:65-66`).
- Sibling hardcoded `/shared/${orgSlug}/${compSlug}` at `:770` on the same page.
- **The competition page needs NO change** — `o/[orgSlug]/c/[compSlug]/page.tsx:136`
  already builds `routes.shared(orgSlug, competition.slug)` and already opens in
  a new tab (`:323`, `:397` `external: true`).

---

## 5. Standing owner rulings — binding, not derivable from code

- Shell for all sports, Option A everywhere. `/shared` only.
- **R1 phone-DESIGNED, not shrunk.** **R10 live pages update without reload.**
  **R11 "a cosmetic defect is a defect"** — visual verification includes cosmetics.
- "You are the product owner" — make the call, record it, always recommend, and
  state what it costs if the call is wrong. **Never label your own
  recommendation as the owner's.**
- **Questions in CHAT**, never through a question tool.
- **Subagents: Opus minimum. Never override `model:` on a dispatch.**
- **Never file issues or PRs unprompted.**
- Binding visual gate: capture matrix **320 / 390 / 768 / 1024 / 1280**, every
  state asserted before its picture, written PER-SCREEN verdicts, and **owner
  sign-off on a published contact sheet before any PR, merge or redirect.**
- All four test types per task (unit / E2E / smoke / regression).
- Any new or changed user-facing string → all 4 locale dictionaries. Two
  exceptions: `content/help/**` and `apps/web/src/games/**`.
- Never enable/disable `e2e.yml`. Never run `UPDATE_GOLDEN=1`.
- Never `git stash` in a worktree (shared stack). Never `git add -A` — use
  `git commit -o <paths> -F <msgfile>`. Never `--amend`.
- Never touch the main checkout `/Users/ashokhein/github/seazn.club`.

---

## 6. Environment

New worktree off merged main; never check out in the main repo dir.

    S=~/.claude/skills/seazn-local-env/scripts/seazn-env.sh
    $S up --label <yours> --all        # fresh pg + db:apply + sync:sports + placement + server
    eval "$($S env --label <yours>)"   # REQUIRED before any vitest run
    $S rebuild --label <yours>         # after ANY code edit — see the trap below

A label is pinned to the worktree it was created from. `up` from the wrong tree
silently builds and tests the wrong code.

- **`up --server` REUSES an existing build.** It only builds when
  `standalone/apps/web/server.js` is absent, so after an edit it stages, starts,
  health-checks and asset-verifies the PREVIOUS bundle — every probe green.
  This bit this programme twice, most recently on 2026-09-16 when an e2e spec
  passed 13/13 against code that did not contain the fix. Use `rebuild` and
  confirm the new BUILD_ID.
- Playwright: run from `apps/web`, `PLAYWRIGHT_BASE=http://localhost:<port>`,
  **`localhost`, never `127.0.0.1`**.
- The walkthrough e2e **rewrites committed screenshots** under
  `e2e/__screens__/spectator-w1/walkthrough/` on every run — back up and restore
  before any git operation.
- A worktree needs `pnpm install --frozen-lockfile` (NOT npm), both `.env.local`
  symlinks, and a `.claude/agent-memory` symlink. Without the env symlinks
  ~1772 DB tests SKIP while `total` stays unchanged — only `pending` moves.

---

## 7. Traps this programme has already paid for

- **`vitest` positional filters are LITERAL SUBSTRINGS, not regex.**
  `"kiosk.*__tests__.layout"` selects ZERO files while a bare `"present-rename"`
  in the same command selects its file; escaping brackets also selects zero.
  Pass the raw path fragment quoted, escape nothing:
  `vitest run '(kiosk)/[orgSlug]/__tests__/'`. An over-narrow filter reports
  `files: 0` and EXIT=1 — which READS AS A FAILING SUITE but is an empty
  selection. **Always print `testResults.length` and the resolved
  `.testResults[].name` list.**
- **zsh does NOT word-split unquoted variables** — three paths in `$TESTS`
  become ONE filter, select nothing, exit 1.
- **`process.env.TZ` mutation is INERT inside vitest's worker pool** (ICU has
  cached the zone). Works in plain node. Two agents hit this independently. For
  a public date surface, assert the MECHANISM — record the options of every
  format call and require an explicit `timeZone` — because CI runs UTC, where a
  zone-less formatter produces the CORRECT string and a day-comparison test
  passes in the broken state.
- **`unstable_cache` serialises Maps to `{}`**, and a `void`ed `revalidateTag`
  is DROPPED after the request flushes.
- An isolated-worktree agent branches from **ORIGIN/MAIN**, never from your
  feature head — reset it first. Lane branches carry cherry-picked COPIES:
  cherry-pick, never merge.
- Dictionaries resolve by **KEY UNION**; `i18n-keys.ts` is GENERATED — rerun
  `gen-keys` and require zero drift.
- A zod `.default()` makes the field **REQUIRED on the output type** — run
  `apps/web` tsc every round; three fixtures once broke silently under a green
  suite.
- `smoke.ts` has no suite filter — isolate via a temporary entry-point copy.
- Shell cwd resets to the main checkout between tool calls. Prefix
  `cd <abs worktree> &&` in the SAME call, and confirm resolved paths before
  believing any count.
- **CI shape:** `ci.yml` triggers on `pull_request` only; `e2e.yml` triggers on
  **push to `main`** plus `workflow_dispatch` with a `pr` input. **A PR gets
  ZERO automatic e2e** — dispatch it with `-f pr=<N>`. Note `refs/pull/N/head`
  is the branch TIP, not the merge commit, and the run's `headSha` shows the
  dispatch ref and misleads.
- **Billing-block signature:** every job `failure`, **0 steps, ~3s duration**.
  The annotation is only visible via
  `gh api repos/<o>/<r>/check-runs/<jobId>/annotations`. It is transient and it
  is NOT your code. A real run shows 29–34 steps per job.
- `gh` is at **`/usr/local/bin/gh`**.
- CI gates an **OpenAPI drift check** (`ci.yml:92-96`): it runs
  `npm run openapi:gen` then `git diff --exit-code` on both spec files. Run that
  locally before raising a PR.

---

## 8. Carried forward — recorded, NOT fixed

Each of these is a decision already made. Do not re-derive them, and do not
silently close them.

- **The chrome tree still has the org-rename tail-drop** that the kiosk boards
  fixed. `[competitionSlug]/page.tsx:209-230` documents it as a measured
  finding. Deliberately out of scope of the kiosk fix.
- **A renamed PRIVATE competition now 308s where it used to 404**, because
  `public_competitions_v` (V397) filters visibility while `sharedRenameTarget`
  reads the base tables — so the rename is disclosed. Held CONSISTENT with the
  chrome page (`page.tsx:143`), which already behaves this way on main.
  **Follow-up owed covering BOTH surfaces.** Cost if the call is wrong: someone
  holding an old link learns a private competition's new slug.
- **The re-exported OG share card does not redirect**, so an unfurl of an old
  printed link still misses while the page 308s. Accepted.
- **`patch.slug` is not charset-checked** (`usecases/competitions.ts:527-533`).
  Pre-existing, shared with the chrome pages, cannot leave the origin.
  DEFERRED — tightening an API's accepted charset is a behaviour change owing
  its own review surface and possibly a migration for stored slugs.
- Still owed from the Knockout wave: **P1b** shell-held live status may lag
  (unmeasured); **P1c** `void fireStageRevalidate` ×4 in `stages.ts`; **O1**
  thin pre-start league Overview; an engine wave for double-elim unowed reset /
  `bracketRanks`.
- Two PRODUCT defects recorded via `test.fixme` in W1's walkthrough, owed to the
  match-centre owner: tab-rail tap targets ~32px at 320 (below the 44px
  minimum), and two SERIOUS axe colour-contrast failures at 320
  (`mc-updated-at` 4.09:1, bowling-figure labels 3.45:1, both short of AA 4.5:1).

---

## 9. Before you merge anything

1. Contact sheet published, **per-screen verdicts written**, and **owner
   sign-off received**. This gate is explicit and has held up a PR before.
2. OpenAPI drift clean.
3. CI green on the PR.
4. e2e dispatched against the PR number and green — it does NOT run
   automatically.
5. A red on `main`'s e2e gets blamed on whoever merges next. Check whether
   main was already red, and whether the red is the billing shape, before
   attributing it to your branch.
