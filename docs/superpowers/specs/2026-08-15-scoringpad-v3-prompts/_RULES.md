# Standing rules — every ScoringPad v3 wave

Read this file **first** at the top of every wave session, then `_INDEX.md`,
then the wave's own prompt file. Design of record:
`../2026-08-15-scoringpad-v3-redesign-design.md` — the spec travels with every
brief; argue from it, not from memory. v2's history and rulings:
`../2026-08-06-scoringpad-v2-prompts/_INDEX.md` (fidelity ladder CLOSED 0–3,
no second vocabulary, "doc 14" does not exist).

## 1. Owner rules (non-negotiable, inherited from v2 + new gate)

- **DON'T RAISE NEW ISSUES.** Defect or false premise found → fix in-session;
  if the fix widens blast radius, ask first. Record under `Unplanned fixes`
  in the PR body. Spec §8's defect register rows are the exception structure:
  a wave that touches a row's surface closes the row or records why not in
  `_INDEX.md`.
- **Think past the literal brief.** A false premise is a finding, not a
  blocker. Scout re-pins every line number before the implementer touches
  anything — every pin in these briefs predates R1.
- **Greenfield schema stance** unchanged; engine modules stay `1.0.0`.
- **One PR per wave.** Smoke CI is PR-only.
- **New branch in a worktree**, never a checkout in the main repo dir.
- **VISUAL SIGN-OFF IS A MERGE GATE.** Before a wave's PR merges: run the
  capture harness for the wave's sports, publish the gallery artifact, get
  the owner's per-screen verdicts, AND offer the live walkthrough (server up,
  login link minted). Verdicts recorded in `_INDEX.md`. A wave merged
  without recorded sign-off is a broken gate, same severity as red tests.

## 2. Toolchain + verification (the wrappers lie — v2's list, still true)

- TS7, Node 26, pnpm (`pnpm install --frozen-lockfile` in worktrees).
- apps/web typecheck: `NODE_OPTIONS=--max-old-space-size=6144`; command
  writes its own `EXIT=$?`.
- vitest green ONLY via `--reporter=json --outputFile` + jq counts; `rtk`
  fabricates/masks (PASS(0) FAIL(0) = failed collect). Prefix tsc/vitest/
  eslint probes with `rtk proxy`.
- apps/web vitest is `environment:"node"` — NO jsdom. UI primitives are
  built as pure spec-builders (data) + thin renderers; unit tests assert the
  builders, e2e asserts the DOM. v2 skins were proven this way (S11).
- `git grep -a` always; worktree needs `.env.local` symlinks ×2 +
  `readlink -f node_modules/@seazn/engine` inside the worktree; no `git
  stash` in worktrees; killed background command reports exit 0.
- e2e locally: prod build + `E2E_PROD_TARGET=1` on `localhost` (127.0.0.1
  401s). Capture/e2e seeding: `seedRosteredFixture` + `loginUi` with
  `page.request` (the standalone `request` fixture has its own cookie jar),
  never `networkidle` after login, dismiss the cookie banner,
  `animations:"disabled"` on screenshots.

## 3. Skills — load, don't cite

Same table as v2 `_RULES.md` §3, plus: `frontend-design:frontend-design`
BEFORE any visual work in every wave (owner ruling — v2 under-used it), and
the wave re-reads spec §2 primitives before extending them.

## 4. Agent topology

Scout → Implementer → Reviewer → loop until
clean AND gate green; main thread reruns the gate itself and pastes JSON
counts. Dispatch briefs carry: exact paths, acceptance, do-not-touch, verify
command, ≤15-line output cap. Parallel only on provably disjoint file sets.

## 5. Testing — four types every wave

Unit / e2e (Playwright vs prod build) / smoke (`scripts/smoke.ts`) /
regression — a wave that defers one names the wave that owes it, in the PR
body. UI text changed → `git grep -a` old AND new across `e2e/` first.
New user-facing strings → all 4 dictionaries (`en,es,fr,nl`, flat dotted
keys) + `i18n:check`. Widths 320/768/1280 by screenshot + the seven-width
`mobile.spec.ts` matrix for any new surface. 44px floor. Contrast computed
from tokens, then axe per skin.

## 6. Ship checklist (per wave)

- [ ] Every change has a test that fails without it (mutation-proof the gates)
- [ ] Gate rerun inline, JSON counts pasted; tsc EXIT=0; lint `✖ 0 problems`
      (root AND engine when engine touched)
- [ ] OpenAPI/i18n drift: `npm run openapi:gen` if api-v1 zod moved;
      `npm run i18n:gen-keys`; `git status --porcelain` empty
- [ ] Screenshots 320/768/1280, no horizontal scroll, 44px targets
- [ ] **Gallery published + owner verdicts recorded + walkthrough offered**
- [ ] Help pages (`content/help/**`, English only) + smoke demo if user-visible
- [ ] `_INDEX.md` updated: status, rulings, premises found false, register rows
- [ ] Memory written + `scripts/agent-memory-snapshot.sh`

## 7. Compaction

Write rulings into `_INDEX.md` AS MADE. A resumed session reads `_RULES.md` →
`_INDEX.md` → its wave prompt → the spec. Nothing else should be needed.
