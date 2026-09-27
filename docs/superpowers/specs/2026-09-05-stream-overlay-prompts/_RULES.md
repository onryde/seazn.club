# Stream overlay — standing rules

Read this before touching anything under `apps/web/src/app/overlay/**`,
`apps/web/src/components/overlay/**`, `apps/web/src/lib/overlay-model.ts`,
`apps/web/src/lib/stream-url.ts`, `apps/web/src/components/public-site/use-live-fixture.ts`,
`apps/web/src/components/v2/fixture-stream-panel.tsx`, the `FixtureLine` row in
`apps/web/src/components/v2/stages-panel.tsx`, or `public_fixtures_v`. These are
rulings that are **not derivable from the code**. Design themes with every
binding pixel, colour, type and motion value: `_THEMES.md` beside this file
(native 1920×1080; cite its sections, never restate values). The owner-reviewed
canvas those values come from, and the picture of what you are building:
https://claude.ai/code/artifact/2aebcbde-28ba-45ff-9028-1151873e4901
(the two themes on cricket, both across four more sports, the W2 moments, the
phone legibility test, the OBS setup flow, and the organiser panel at desktop
and at 390). Design of record:
`../2026-09-05-stream-overlay-design.md` (owner-approved 2026-09-05; its
"Decisions locked" 1–7 and §9 "Motion" are binding; this file restates them for a
subagent that cannot afford the whole spec). Programme index: `_INDEX.md` beside
this file — its two pinned-symbol tables are the `path:line` authority every wave
file cites; re-pin against the tree before building on any row.

## Who the customer is

The club streaming its own match to YouTube, Facebook, Twitch or Kick with OBS,
who wants the live score inside the picture without the scorer doing anything
new. Second, the fan who finds the stream from the public match page. Video never
touches seazn; we serve a transparent page and the score. Every recommendation
and finding is stated as value to one of these two.

## The rules

- **R1 — Gate is an entitlement key, never a header, never a flag.** Key
  `streaming.overlay`. No plan grants it at launch (catalogue rows `false` on
  every plan, insert form as `V290__pro_plus_plan.sql:18,39`). It is **NOT added
  to `ENTITLEMENT_DOMAINS`** (`apps/web/src/lib/entitlement-domains.ts:5`) — the
  catalogue is code, and `buildPricingSections` (`lib/pricing-matrix.ts:191,199`)
  renders only listed keys, so leaving it out is what keeps it off `/pricing`.
  The owner's test org gets it through an `org_entitlement_overrides` row
  (`V025`), which the resolver ranks first (`lib/entitlements.ts:441,454`). Not
  entitled ⇒ the overlay route is `notFound()` and the panel is absent — never an
  upsell, never a 402, never `upgrade-gate.tsx`. Both surfaces read the SAME
  resolved feature through `hasFeature(orgId, "streaming.overlay")`, server-side,
  on every render; the client never decides. No custom request header exists in
  this repo except `x-seazn-org` and `x-seazn-locale` (both routing) and OBS
  cannot send one — do not reintroduce the idea.
- **R2 — Style lives in the URL, never in the database.** `?style=bar|bug` on the
  overlay URL. Per-sport default (product-owner call, reversible by the owner
  naming the other letter): **cricket opens on the bar, every other sport on the
  bug.** The panel's tabs switch the query parameter; no column, no setting row.
- **R3 — All eleven sports through ONE projection** (`overlayModel`). Bespoke
  detail lines and moments exist only where a module declares the events
  (cricket, football, hockey, ice hockey, tennis, badminton, table tennis,
  volleyball). Board game, carrom and generic get the shared two-row composition
  with `cells: []` and `detail: []` — a designed state, not an error. The sport
  key comes from the DIVISION (`PublicDivision.sport_key`, `data.ts:180`), not
  the fixture. `V3_SKINS` (`registry.ts:85`) is the working list of eleven keys;
  the registry has no enumerator (`registry.ts:35,89`) — watch-list item 8.
- **R4 — Moments and the cricket batter/bowler line are W2.** Step one ships the
  `OverlayMoment` interface as a type and the slot in the components, nothing
  more. W2 executes only after `feat/spectator-surface` W1 merges and every
  RE-PIN row in `W2-moments.md` is re-verified against the merged tree.
- **R5 — One transport, one authority per fact.** The subscribe-or-poll logic is
  LIFTED out of `live-score.tsx:60-117` into
  `components/public-site/use-live-fixture.ts` and `LiveScore` is repointed in
  the SAME change — never a second copy. Derivations (`setBreakdown`,
  `periodBreakdown`, `matchStrength`, `disciplineList`, `servingSide`) are
  imported from `@/lib/public-site` (`:290,319,338,352,373`); the overlay never
  re-derives. The poll URL is `GET /api/v1/public/fixtures/[id]` →
  `publicFixture(id)` (`usecases/public.ts:263`), fetched by `fetchLiveFixture`
  (`live-score-data.ts:30-32`); `POLL_MS = 15_000` (`live-score.tsx:29`) and the
  250 ms debounce are behaviour, not constants to tune.
- **R6 — `create or replace view public_fixtures_v` may only APPEND.** Postgres
  refuses a column reorder or drop through `create or replace`. `stream_url` goes
  LAST in a full redefinition copied from the latest definition
  (`db/migration/deltas/V369__public_fixtures_round_role.sql:18`). The
  `PublicFixture` column list is hand-maintained in two places (`data.ts:206`) —
  both gain the column or the seam is inert.
- **R7 — Every new route goes into OpenAPI in the same change.** `ROUTES`
  (`server/api-v1/openapi.ts:57`, `PATCH /fixtures/{id}` at `:142` is the
  neighbour), then `npm run openapi:gen` (`package.json:45`; `pnpm openapi:gen`
  is the same script) and commit `openapi/v1.json` + `openapi/v1.public.json`.
  CI's drift gate is a `ci.yml` step (`:94-98`), not a pre-commit hook.
- **R8 — Never build a redirect from `req.url`.** Main's walkthrough leg is red
  at this branch's base commit and one (withdrawn, unresolved) hypothesis was a
  redirect built with `new URL("/path", req.url)` emitting the CI bind address
  (`_INDEX.md` §"Base commit health"). The overlay page returns HTML or
  `notFound()`; `PUT /stream` returns JSON. No `redirect()` anywhere in this
  programme.
- **R9 — Walkthrough specs are picked up by PATH, not by a list.** The brief for
  these prompts said "name new specs in `WALKTHROUGH_SPECS`"; **no such symbol
  exists on this branch or on `feat/spectator-surface`** (grepped 2026-09-05)
  because it landed on `main` in PR #723 (`01ea4a455`), AFTER this branch's
  base `997ad225b`. A peer session reports `e2e-ci-wiring.test.ts` goes red in
  two CI jobs for any walkthrough spec not named there. So after the rebase
  the list WILL exist and the spec MUST be registered in the same commit.
  The `walkthrough` project matches `const WALKTHROUGH =
  /[\\/]e2e[\\/]walkthrough[\\/]/` (`apps/web/playwright.config.ts:119`, project
  at `:164`); CI runs it as `group: walkthrough … --workers=3`
  (`.github/workflows/e2e.yml:202-206`). Put the new spec under
  `apps/web/e2e/walkthrough/` and prove it was COLLECTED (`--list` shows it, or
  the JSON report names it). If a `WALKTHROUGH_SPECS` list exists after rebase,
  register there too — re-grep, do not assume either way.
- **R10 — Migration numbers are flat across directories; take the next free
  number at REBASE time.** `db/flyway.toml:6`; highest on this branch today is
  `V391`, so the spec's `V392` holds only until another branch lands one. Record
  the final number in the plan and in `_INDEX.md`. An unmerged migration is
  AMENDED, never corrected forward.
- **R11 — Sequencing with in-flight programmes.** PR1 REBASES after
  `feat/fixture-console-redesign` (competition desk W1, edits `stages-panel.tsx`)
  merges — it does not race it; the panel mount is one import and one conditional
  line inside `FixtureLine` so the rebase is mechanical. W2 starts after
  `feat/spectator-surface` W1 merges. A symbol pinned on another branch is
  BRANCH-RELATIVE — cite the symbol, re-pin the line.
- **R12 — Vocabulary.** "Fixture Console" in owner language is the DIVISION
  page's `?tab=fixtures` (`components/v2/stages-panel.tsx`), never
  `components/v2/fixture-console.tsx` (R7's device console). The panel mounts
  from `FixtureLine` (`stages-panel.tsx:1579`, the row COMPONENT); `FixtureRow`
  (`:73`) is the row's DATA type — the spec's §6 first sentence has the names
  the other way round and the index corrects it.
- **R13 — Exactly three motions in step one, all `transform`/`opacity`.** Score
  tick (changed `big` only, 1.0→1.12→1.0 over 300 ms, that side's LED flashes
  one frame), side change (LED bar slides 200 ms), live dot (0.55↔1.0 opacity,
  2 s, stops when decided). W2 adds ONE more: the moment slab (250 ms out, 4 s
  hold, 250 ms back, FIFO queue). Nothing else animates, ever: no entrance
  animation on load (OBS shows the page mid-stream; a slide-in on every
  reconnect is visible on air), no ticker, no per-frame timer.
  `prefers-reduced-motion` disables tick and breath and makes the slab an
  instant show/hide — precedent blocks in `app/globals.css:187` and its eight
  siblings, `components/news/post-scorebug.tsx:7`.
- **R14 — Every string through the dictionaries, four locales, keys
  regenerated.** `public.*` for the overlay, `ui.*` for the panel
  (`apps/web/src/dictionaries/{en,es,fr,nl}/`; `embed.*` in `ui.json:419-421`
  is the copy-button precedent), then `pnpm i18n:gen-keys` (`package.json:39`;
  `lib/i18n-keys.ts` is GENERATED — never hand-edit). Sport notation (CRR, RRR,
  overs, O-M-R-W) stays notation with a localised `title`. Sentence case, plain
  verbs ("Save link", "Copy"). Help copy under `content/help/**` is the one
  English-only exception.
- **R15 — Phone first, one DOM, identical control set.** The panel at 320: tabs,
  inputs and buttons full width at ≥ 44 px; at ≥ 768 the copy button moves
  inside the link field — same controls, different placement. Branch with
  `max-md:*` / `md:hidden` inside ONE tree, never a second phone tree. Verify
  with a control-set diff from the live DOM at 320 against 1280 (membership,
  order, repeats), never by comparing box sizes. `/\bmd:hidden\b/` also matches
  inside `max-md:hidden` — anchor assertions on `\s...hidden"`. `truncate` needs
  `min-w-0` on the whole ancestor chain (a 43-character entrant name is the
  test). The overlay itself is authored at 1920×1080 and scaled with
  `transform: scale(min(vw/1920, vh/1080))` from the top-left — the console
  preview renders the SAME component, never a picture.
- **R16 — Stream links: exact hostname, https only, anchor only.**
  `streamUrlSchema` (`lib/stream-url.ts`): `new URL()` parses, protocol
  `https:`, hostname `===` one of `www.youtube.com`, `youtube.com`,
  `m.youtube.com` (owner answer on Q5, 2026-09-06 — a link copied from the
  YouTube phone app), `youtu.be`, `www.facebook.com`, `facebook.com`,
  `fb.watch`, `www.twitch.tv`, `twitch.tv`, `kick.com`, `www.kick.com` —
  eleven. Never a prefix or substring test (memory: a prefix
  check is not origin validation — `/\evil.com` was an open redirect once).
  Empty string clears. Rendered only as `<a href target="_blank"
  rel="noopener">`; never an iframe here; CSP `frame-src` untouched.
- **R17 — Consent before names (W2).** Any person name on a moment or the
  cricket batter line goes through the existing resolver —
  `resolvePersonDisplayName` (`lib/name-display.ts:72`) /
  `maskPublicEntrantNames` (`server/public-site/data.ts:510`) on this branch,
  or spectator W1's consent-resolved `personOf` once merged. Pin ONE; never
  write a second. A masked person renders the masked label, never a blank slab.

## Repo traps that bite this programme specifically

From `AGENTS.md` at the worktree root — the ones that WILL fire here:

- **Overlay pages have no chrome and no cookies — a health 200 proves nothing.**
  Probe the score text and `getComputedStyle(document.body).backgroundColor ===
  "rgba(0, 0, 0, 0)"`, not the status code. A page can be 200 with its chunks
  never emitted.
- **`apps/web` vitest is `environment: "node"`** (`vitest.config.ts:129`) — no
  DOM. Hooks ARE unit-testable through `renderIsland` in
  `components/__tests__/_hook-harness.tsx` (the idiom `live-score.test.tsx:9-20`
  uses, with `setInterval` captured rather than faked, `:37-40`). Nothing about
  CSS cascade, transforms, `prefers-reduced-motion` or tap area is — the e2e is
  the only witness for those.
- **`rtk` lies.** Its vitest summary prints `PASS(0) FAIL(0)` for a suite that
  failed to COLLECT and swallows exit codes — judge green only from
  `--reporter=json --outputFile` (`numPassedTests`/`numTotalTests`, and confirm
  `.testResults[].name` resolves inside THIS worktree). It hides `npm run lint`
  entirely ("ESLint output (JSON parse failed)" is the wrapper losing the
  result) — use `rtk proxy` and read `✖ N problems`. It fabricates `Prettier:
  All files formatted correctly` and prints tsc clean while tsc exits 1.
- **Shell cwd resets to the MAIN checkout between calls.** Prefix every verify
  with `cd /Users/ashokhein/github/seazn.club/.claude/worktrees/stream-overlay
  &&` in the SAME call, or the run executes on `main` and returns a false green.
- **`npm test --workspace apps/web -- run <path>`** treats positionals as
  filename FILTERS — a typo runs a subset and reports green. Unset `DB_SCHEMA`
  and `--root` each under-report. Use `cd apps/web && vitest`.
- **`grep` says `Binary file … matches`** here — always `grep -a`.
- **A killed background command reports exit 0.** Have the command write
  `EXIT=$?` itself.
- **`git stash` in a worktree is NOT safe** — the stash stack is shared with the
  main checkout; a no-op push then pop pops a foreign stash and leaves
  `package.json` unmerged.
- **Assertions on Next HTML anchor on `="`** — an omitted prop serialises as
  `"$undefined"`, so a bare `data-*` probe passes in both states. And an HTML
  grep for dictionary copy passes in EVERY state (the payload carries it) —
  drive the DOM.
- **`-g` on a Playwright sweep is a filename sweep in costume;
  `mobile.spec.ts` is serial** (`describe.configure({ mode: "serial" })`), so a
  red count there is a FLOOR. Run whole spec files; re-run after each fix until
  a full pass completes. The fixtures tab already has seven-width cases
  (`mobile.spec.ts:578,2715,2907,3096,3189`).
- **A folded control is not visible — wait on `toBeAttached`, not
  `toBeVisible`**, open EVERY instance of the disclosure, and gate the open on
  the toggle being visible, not on a width literal. Do not weaken an assertion
  to match new markup.
- **A blown Playwright budget reports itself as a data defect** (`Expected 15 /
  Received 14` above the timeout line). Check the poll's OWN timeout before
  chasing a count. Seed SHORT matches — a full T20 through the API takes ~9 min
  (spectator false premise) — and post `cricket.toss` BEFORE `core.start`
  (`422 WRONG_PHASE` otherwise).
- **`apiV1` prepends nothing** — a route can 404 with 5,481 unit tests green.
  Smoke and e2e hit the real path.
- **`Number("") === 0`** — an empty numeric input zeroes a live value. The panel
  has no numeric input; keep it that way.
- **A client component importing `@/server/**` is a BUILD FAILURE.** The panel
  and the stage import `streamUrlSchema` from `@/lib/stream-url` and the model
  from `@/lib/overlay-model`, never from `@/server/**`.
- **An idempotency guard can skip a legitimate new arrival** (W2's seq diff):
  check both directions — already-seen fires nothing AND a new seq fires once.
- **The inert seam.** A column read everywhere and written nowhere; a validated
  field transmitted nowhere; a payload extended on the server and never read by
  the client. Every seam here (`stream_url` → view → `PublicFixture` → link;
  `PUT /stream` → DB → public JSON; hook → both consumers) is proven by driving
  its REAL producer and consumer, never a fixture on both ends.

## Shell guard in a worktree session

The RTK hook rewrites `git` to `rtk git` and the isolation guard refuses it,
plus heredocs, `eval`, `.`-sourcing, `&&` chains it calls "too complex", any
runtime-computed value where an option may stand, and any command text
containing `git` (including paths under `~/.claude/projects/-Users-ashokhein-
github-seazn-club/`). Rules: `/usr/bin/git <cmd>` as SEPARATE plain calls
(`git add <path>` then `git commit -m …`; `commit -o` fails on an untracked
file); write files and helper scripts with the **Write tool**, run them with one
plain `node …` line; read memory files with the Read tool; symlinks with
RELATIVE targets from the worktree root (`ln -sfn ../../../.env.local .env.local`;
`../../../../../apps/web/.env.local` from `apps/web/`); `grep -a`. Subagents
dispatched from this session hit the same guard — their briefs say so. The
orchestrator commits; a wave agent never runs git and never `git stash`.

## Environment (label `ovl`)

From THIS worktree, never the main checkout: `seazn-env up --label ovl --server`
(fresh Postgres + `db:apply` + `sync:sports` + a standalone prod build);
`seazn-env rebuild --label ovl` after every code change (`up --server` again is a
no-op by design and serves the OLD bundle — probe `_buildManifest.js`, not
`/api/health`; the server PORT can change on rebuild); `seazn-env down --label
ovl` when the gate or capture is on disk — no standing env. `eval` is refused
here, so read `seazn-env env --label ovl` as a plain call and set the values
explicitly: `DATABASE_URL=postgresql://postgres@127.0.0.1:54405/seazn_ovl
DATABASE_SSL=disable` (the port is the label's; if `env` prints another, the
printed one wins — confirm `show data_directory` is yours before trusting a
`createdb`). Playwright runs from `apps/web` with `PLAYWRIGHT_BASE` and
`E2E_PROD_TARGET` set; smoke reads `SMOKE_BASE` (`scripts/smoke.ts:24`).
`db:apply` alone is NOT a fresh schema (`funnel.test.ts` fails `expected
'generic' to be 'badminton'` without `sync:sports`). `pnpm`, never `npm
install`. A build that dies with exit 137 after "Compiled successfully" is OOM
from environment saturation — take other envs down, `SKIP_TYPECHECK=1`, and run
`tsc --noEmit -p apps/web/tsconfig.json` separately (a local build proves
nothing about types). `NEXT_BUILD_FS_CACHE=1` makes a rebuild ~24 s.

## Agents

Scout / Implementer / Reviewer. **Opus at minimum** — owner ruling for this
programme ("use OPus SubAgent", 2026-09-05). On THIS branch the frontmatter in
`.claude/agents/{scout,implementer,reviewer}.md:4` reads `model: sonnet`
(`docs/superpowers/RULES.md:38-46` says the same), so **every dispatch in this
programme passes `model: opus` explicitly** — the one programme where the
repo-wide "never override `model:`" line is overridden, by the owner. Never
silently downgrade; if the Opus limit is hit, say so and run the settling check
(`/usr/bin/git log --oneline`, `/usr/bin/git status --porcelain`) on any agent
dispatched in the window. Wave implementation PLANS are written by Fable agents
(owner: "use fable agent to write all wave implementation plans"). A stopped
agent is RESUMED, not restarted (owner: "Start the subagent where it left
instead of starting from the beginning") — `SendMessage` to the same agent id,
or hand it its own ledger; never re-dispatch a fresh agent onto half-done work.

Loop: Implementer → Reviewer → gap list → … until clean AND green; review after
every task group, never skipped. Every dispatch carries five things (exact
paths, acceptance criteria with all four test kinds named, what NOT to touch,
the verify command with `cd <worktree> &&`, an output cap — default "final
message under 15 lines — counts, paths, deviations, blockers; no file contents
or diffs"). Subagents run vitest and tsc SCOPED; the orchestrator runs the full
gate at the wave boundary and never accepts "done, tests pass" without the raw
JSON-reporter counts pasted back. Parallel only when file sets are provably
disjoint; overlap ⇒ sequential or `isolation: "worktree"` (an isolated-worktree
agent branches from `origin/main`, not from the feature branch).

## Merge gates (per PR)

1. Reviewer pass on the whole branch, even when every task review was clean.
2. `cd apps/web && vitest run --reporter=json --outputFile=<scratch>/vitest.json`
   — `numFailedTests: 0`, `numTotalTests` at or above main's, `.testResults[].name`
   inside this worktree; counts pasted into the PR.
3. `rtk proxy npm run lint` read to `✖ 0 problems`; `tsc --noEmit` clean;
   `npm run openapi:gen` leaves no diff; `pnpm i18n:gen-keys` leaves no diff.
4. Smoke on the PR (smoke CI is PR-only — a local merge to `main` skips it).
5. e2e via `workflow_dispatch` with `pr=<n>` (`e2e.yml:80-85`; e2e triggers on
   push to `main` ONLY, so a feature branch gets zero automatic e2e signal) —
   all three jobs green, the new walkthrough spec named in the run's report.
6. Per-screen visual sign-off by the OWNER: screenshots exist, DIFFER per
   sport, and each row says what was SEEN (alignment, wrapping at a 43-char
   name, contrast, tap ≥ 44 px by `elementFromPoint`, empty and 404 states).
7. Main's walkthrough leg must be GREEN before merging — the base-commit red
   (`_INDEX.md`) is not this branch's to absorb, and a merge on top of it hides
   whether the new spec passes.
8. `_INDEX.md` status updated in the same PR.

## Verification checklist

Verify as the customer: open the overlay in a real browser at 1920×1080 AND in
the console preview at 320; post an event and WATCH the number change without a
reload; save a link and READ it on the public page. Print what you saw beside
every pass/fail. All four locales whenever a string moved. A read is not a run;
a grep is not a read; a comment is a hypothesis. Product-owner lens on every
finding: customer gain or loss, cost and blast radius, a recommendation with
its strongest counter-argument — and never label your own recommendation as the
owner's ruling, in either direction.

## Test strategy — OWNER RULING 2026-09-27, binds EVERY R1 lane and wave

Owner's words: *"update and store this similar rules for all R1 waves/lanes"*, adopting the practices the owner
approved for the format-matrix programme as its ruling 21. The source is
`docs/superpowers/specs/2026-09-27-format-matrix-prompts/test-strategy-recommendation.md` on the local branch
`docs/format-matrix-programme` (read there, not from a paste; it is unpushed). **For R1 these are rules, not a
recommendation** — this programme's own owner ruled them here. They are ADAPTED below, because that programme's
axis is format × sport and ours is mode × driver × state; copying its wording would have produced sport sweeps
over code that has no sport in it.

They apply **from the next dispatch onward**. Task 7 keeps the brief it was dispatched with; its REVIEW applies
these, as does every brief after it.

**S1 — Model-based sequence testing over the two state machines.** `fast-check` is already a devDependency of
both `apps/web` and `packages/engine` (v3) and is already used in three suites including a money one
(`lib/__tests__/credits-wallet-merge.test.ts:15,70`), so this needs no new dependency and has a local idiom to
follow. Nothing in the repo uses the COMMAND model yet (`fc.commands` / `modelRun`), so R1 is where it starts.
Generate random sequences of the REAL triggers — `start`, `provisioned`, `went_live`, `stop`, `beat`,
`stale_beat`, `create_failed`, `destroy_ok`, `grace_expired`, `deadline`, `orphan_listed`, `credit_refused` —
and check the invariants after **every** step, not at the end. The invariants that are worth the machinery,
each of which is a defect this programme has already paid for by hand:
  - never two Machines alive for one session, and a retry only after a **CONFIRMED** destroy;
  - a terminal session never transitions, and `decide` throws only where it is documented to;
  - `balance == sum(deltas)`, never below zero, and **at most ONE consume per session**;
  - the runner deadline is never earlier than the session's wall clock (lane A's I1, as a PROPERTY over drift
    rather than the single case that closed it);
  - a create whose outcome is unknown never reports "made nothing";
  - `ending_at` set exactly when the state is `ending`; `started_at` set exactly once, at `live`.
A failure **shrinks to the shortest reproducing sequence, and that sequence is committed as a named regression
case with its seed BEFORE the fix.** The 70-cell and 17-state sweeps lane A wrote by hand are the floor this
replaces, not something it duplicates.

**S2 — Anti-vacuity, everywhere.** Every property, invariant, sweep and parity table **returns how many items
it checked, and zero checked is a FAILURE.** Every rule set states its empty case FIRST. This is the same
defect as three traps already recorded here — a suite that fails to collect reads as `PASS(0) FAIL(0)`, a
module-scope `throw` collects zero tests and reports green, and an empty grep from the wrong cwd reads as a
clean absence. A count printed beside a pass is the only thing that separates them.

**S3 — Mutation testing keeps BOTH layers.** The per-change layer does not move: every behaviour change owes a
hand mutant **per surface** with a killer named by test title, `cp`-backup/mutate/run/restore/`cmp`, and the
script asserts its match count before writing. On top of that, a **scheduled Stryker run scoped to
`apps/web/src/server/relay/**` and `usecases/stream-credits.ts`, with a score floor that may only rise** and
surviving mutants either killed or recorded as equivalent. Stryker is NOT a dependency today and a scheduled
run costs CI minutes on an account whose billing has already stopped every job once, so the scheduled layer
waits on the owner's go for the spend; the per-change layer is unconditional and already in force.

**S4 — Sweep the axis by default, and R1's axis is NOT sport.** It is **mode × driver × (state, trigger)**:
`passthrough`/`composed`, fake/live drivers, and the cells of the two machines. Sport sweeps apply only where a
sport actually enters — the overlay projection, the themes, the per-sport content table — and there they are all
eleven, not a lucky one. **A single-cell test carries a one-line reason.** "One sample is not a parity sweep" is
failure class 7 and it has shipped twice.

**S5 — Production shadow invariants, logged and never blocking.** The server evaluates the same invariants as S1
against REAL rows after each session write and records a Sentry event on a violation; it never refuses the
organiser. The two that are money, and that no unit test can see: **a live session with no Machine**, and **a
Machine with no live session**. Add `balance == sum(ledger)` per org. This needs the Sentry DSN the owner still
owes, so it is specced now and wired when the DSN lands.

**S6 — Assumptions are guards, not comments.** "Cannot happen" becomes an assertion or a named refusal with a
test that REACHES it. R1's live instance is already named: a doc comment at `ports.ts:77` is the ONLY thing
stopping Task 10 from passing `deadlineOf` where `runnerDeadlineOf` belongs, and nothing fails if it does. A
comment is a hypothesis; brand the type instead.

**S7 — Every PR declares its rows, and runs them.** A PR touching `server/relay/domain/**` declares the
(state × trigger) cells it changes; one touching the overlay declares the sport × theme rows. The declaration is
in the PR body and the rows are in the run.

**S8 — The reviewer answers four questions IN THE REVIEW, every time.** What happens **on a second call**
(idempotency — class 13 is an idempotency guard that swallowed a legitimate arrival); on an **empty input** (an
empty set answers no to every question and lands on the default, which shipped three vacuous defects in one
wave); **after a failure, an expiry, a refund or a revoke** (this programme's equivalent of "after a withdrawal
or void"); and **in the other mode and with the other driver** (its equivalent of "for another sport").

**S9 — Rules before building, and one root cause at one owner.** Nothing is built before its rules are decided;
a fix lands once, at the single authority for that fact, never as a patch per call site.

### S10 — The reconciliation, which matters because S-rules 1 and 2 above can be read as contradicting class 19

The format-matrix finding says *expected values taken from the code freeze wrong rules into the tests*. Failure
class 19 says *derive the expected value from the engine's own declarations, never a table typed into the test*.
Both are true, and a careless reading of either one produces the other's defect. The order to apply:

1. **A DECLARED rule is the oracle** — an owner ruling, this programme's design of record, a federation rule, a
   provider's documentation, or a MEASURED provider behaviour (the top-level `deleteRecordingAfterDays` echo,
   the LL-HLS numbers, `limit`'s 1000 ceiling). If one exists, the test asserts against it.
2. **The engine's own CONSTANT is legitimate only for a value the engine genuinely owns** — a timeout, a cap, a
   retry ceiling — and then it is IMPORTED, never retyped, so moving the constant moves the test with it.
3. **Observed output is NEVER an oracle.** A value read back from the code under test, or from a golden file
   regenerated by that code, proves only that it did what it did. This programme has already frozen a live bug
   as an expected value and carried it through two sign-offs.

And prefer at least one case where the right answer **differs** from the wrong one's constant, or the test
cannot witness the regression it exists for.
