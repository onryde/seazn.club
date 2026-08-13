# S12 — #421 (W10): integration behind flag — one registry, both entry points, offline e2e

Paste this whole file as the session opener. Read `_RULES.md`, then `_INDEX.md`
(the deferred-e2e list from S1/S3–S8, S10's flag name), then this.

Branch `feat/s12-w10-integration` in a fresh worktree. One PR. Issue #421.
Design: `../2026-08-03-scoringpad-v2-design.md` (Part II, "Rollout").

**This session discharges the e2e debt** every engine session deferred. Read the
deferred list in `_INDEX.md` and cover it here.

## What S11 ALREADY SHIPPED — do not rebuild it (added 2026-08-13, PR #553)

This prompt was written before S11 ran, and S11 moved four of its premises.
Re-pin before trusting anything below.

1. **A skin registry already exists and is already consulted.**
   `scorepad/skins/registry.ts` maps `sportKey → SkinDef | null`, and
   `PadRenderer` calls `skinFor(module.key)` **by default** (owner ruling: a
   registry nothing calls is S10's inert-picker defect again). So scope item 1
   below is NOT "build a registry" — what actually remains is the `<ScorePad/>`
   wrapper and the **drift guard over every `builtinModules` key**, which S11's
   registry deliberately does not have: it only names the 8 skinned sports, and
   an unskinned sport resolves to `null` → universal renderer.
2. **`PadRenderer.skin` already has the three states you need**: `undefined` =
   consult the registry, `null` = force the universal path, a `SkinDef` = draw
   that one. Use `null` rather than inventing a second bypass.
3. **FIVE skins exist, not three** — cricket, racquet (volleyball + badminton +
   tabletennis), tennis, football, period (hockey + icehockey). The remaining
   sports stay universal deliberately.
4. **Flag name: `scorepad-v2` (HYPHEN)**, as S10 declared it via the repo's
   PostHog convention. This prompt says `scorepad_v2` with an underscore in
   scope item 2 — that is wrong; check `_INDEX.md`'s S10 entry and the code.

### Browser coverage S11 OWES you, and why it could not do it itself

S11's skin e2e drives tennis, volleyball, football and icehockey through S10's
harness route. **Two flows have no browser coverage at all**, and they are yours:

- **cricket: a full over including an extra, and a dismissal credited to a
  fielder** — the headline flow of the busiest pad in the product.
- **football: a goal WITH assist attribution** — S11 could only drive a
  side-only goal.

The cause is not neglect: every `cricket.ball` carries striker/nonStriker/bowler
and football's goal carries scorer/assist, and **the harness route's client
lineups are permanently SYNTHETIC**, so those payloads 422 against the real API
in either harness mode. S12 mounts the real entry points with real rosters, so
both become drivable here — and only here, before S13 deletes the harness.
Treat these two as first-class acceptance criteria, not extras.

Two more harness facts you will hit immediately: with no `?fixture=` param every
sport except `generic` is stuck in the `pre` phase forever (nothing emits
`core.start`), and `SCOREPAD_V2_HARNESS=1` is set in three e2e jobs in
`e2e.yml` — S13 removes both the route and those three lines.

## Why

Two near-duplicate dispatchers pick the pad today — `fixture-console.tsx`
(dispatch ~:226-231, render switch ~:316) and `device-score-pad.tsx`
(~:59-63, :268-283), re-pin both — with **no drift guard**, plus a third
hardcoded key list in `scoring-vocab.ts` (~:15-17). #407 WS2 step 6 wanted a
`PAD_FOR` registry over v1; this session supersedes that with the v2 registry.

v1 remains the default. v2 must be **fully working end-to-end** behind the flag
before S13 flips anything.

## Scope

1. **`scorepad/registry.tsx`** — resolves `sportKey → skin | universal` and owns
   `<ScorePad/>`. Compile-time completeness against the engine's module keys:
   a drift-guard test asserts every `module.key` in `builtinModules` resolves —
   a new engine sport without a registry decision fails CI, and "defaults to
   universal" is a decision that must be written, not implied.
2. **Flag** — follow the repo's existing feature-flag convention (S10 chose it;
   see `_INDEX.md`). `scorepad_v2` off by default. When **on**, *both* entry
   points — `FixtureConsole` (authed) and `/score/[token]` (device link) —
   render `<ScorePad/>` with the server-loaded payload (fixture, resolved cfg +
   pinned module version, sides including members/lineup, initial state/events,
   console extras). When **off**, the v1 paths are byte-identical — no behaviour
   change flag-off is the review bar.
3. **Server payload** — extend the two loaders to pass the resolved variant cfg +
   pinned module version (S10's resolution contract) without breaking v1 props.
   If any api-v1 zod schema moves, the openapi drift rule applies.
4. **e2e (flag on, local only)**:
   - console path — score a cricket fixture pre → live → post including an
     attributed dismissal and a void/correction;
   - device path — claim the link, score **offline** (context-level network
     kill), reconnect, drain the queue, finalize;
   - both assert the public page's summary updates (polling fallback);
   - desktop **and 375px** passes over both entry points;
   - **plus every assertion deferred from S1/S3–S8** — check `_INDEX.md`.
5. **Cleanup prep** — inventory every import of the v1 pads and every dispatcher
   branch. That inventory is S13's deletion list; commit it as a checklist in the
   PR body **and** into `_INDEX.md` (the PR body will not survive compaction).

## Acceptance criteria

- [ ] Flag **off**: zero behavioural diff on both entry points — v1 e2e still
      green, and a byte-level review of the two dispatch sites
- [ ] Flag **on**: both entry points fully scoreable via v2 for all 11 sports
      (drift guard + one e2e per entry point)
- [ ] Offline e2e: kill the network mid-match on the device path, keep scoring,
      reconnect, queue drains, server state converges — assert final `last_seq`
      **and** summary
- [ ] Registry drift-guard test fails when a module key lacks resolution
      (mutation-prove it). Note S11's registry names only the 8 skinned sports —
      the guard must sweep **every** `builtinModules` key and treat "universal"
      as a written decision, not a fallthrough
- [ ] **Cricket's over-with-an-extra and fielder-credited dismissal are driven
      in a real browser** — S11 could not (synthetic harness lineups 422). This
      is the busiest pad in the product and S13 deletes the only other route
- [ ] **Football's goal WITH assist attribution is driven in a real browser** —
      same reason; S11 covered a side-only goal
- [ ] Every deferred assertion from earlier sessions is either covered here or
      explicitly re-deferred to S13 with a reason, listed in `_INDEX.md`
- [ ] Local e2e via prod build + `E2E_PROD_TARGET` on **`localhost`**:3100 with
      `whsec_e2e_payments` set; **never touch `.github/workflows/e2e.yml`**
- [ ] openapi drift handled if schemas moved; `i18n:gen-keys`; then
      `git status --porcelain` **empty**
- [ ] Screenshots: both entry points, both breakpoints, attached
- [ ] Vitest **and** e2e counts pasted; `tsc EXIT=0`; lint `✖ 0 problems`

### Test types

- **Unit** — registry resolution, flag gating, payload shaping.
- **E2E (Playwright)** — the four flows above, both breakpoints, both auth modes.
  This is the session's centre of gravity.
- **Smoke** — v1 smoke must still pass untouched (flag off is the default);
  v2 smoke lands in S13.
- **Regression** — flag-off byte-identity; drift guard; offline drain convergence.

## Gotchas

- `newContext` without options **inherits the authed storageState** — the
  device-link spec must build an explicit fresh context or it silently tests the
  wrong auth mode.
- e2e on `127.0.0.1` 401s every API call while the browser stays signed in
  (`Secure` cookie under `NODE_ENV=production`). Use `localhost`.
- All three e2e projects failing in `auth.setup` on a magic-link timeout usually
  means **port 3100 is squatted** — the server died `EADDRINUSE` and health 200'd
  against a foreign server. Assert `lsof -t -i:3100` is your own PID.
- A failure in the parallel e2e phase means the serial and mobile phases **never
  ran** (`&&` chained). Fixing only the red spec ships the next one.
- v2 UI text that duplicates v1's e2e-anchored strings breaks v1 assertions while
  the flag is off — grep both phases before merge.
- `output: standalone`: `next start` serves 200 from the **wrong** server. Follow
  `seazn-local-env`; check assets, not just the page.
- Never `rm -rf .next` under a live dev server; a stale `.next` after a killed
  server causes 404s.
- Do **not** dispatch a subagent to run the e2e suite — long e2e runs have died
  to the 600s watchdog twice. Run it in the main thread.
- **A green root `npm run lint` says NOTHING about the lint CI runs.** CI runs
  `pnpm run lint` with cwd `apps/web`, which loads Next's own rule set on top.
  S11 shipped a root-green branch that failed CI with 7 eslint errors
  (`no-assign-module-variable` on a `const module = …` in tests,
  `react/display-name` on an anonymous arrow returning JSX). Run
  `cd apps/web && rtk proxy pnpm run lint` before pushing.
- **`next build` WORKS again** (measured 2026-08-13: 103s, 237/237 static pages,
  `BUILD_EXIT=0`). Any older note saying the build is broken on `/help/*` and to
  use `next dev` instead is stale — and it matters here, because a prod build is
  the only gate that catches a client-bundle leak while tsc and unit tests pass.
- The `grant-all` blind spot, since this session adds a flag: any test helper
  that normalises inputs to make one question answerable defines a blind spot
  its own size. S11's coverage sweeps granted every entitlement, so `locked`
  never occurred anywhere in the suite and two skins shipped rendering
  paid-gated actions as live controls. If you write a "flag on" helper, ask what
  it makes unobservable.

## Execution

The two dispatch sites + registry interlock → **one inline implementer pass**,
no parallel agents. e2e authoring can follow in the same pass.

**Scout (sonnet) brief:** both dispatchers with exact line ranges and their
current prop shapes; the `/score/[token]` route and its loader; the flag
convention as implemented in S10; `scoring-vocab.ts`'s hardcoded key list; the
e2e project layout (phases, storageState setup, base URL config). file:line table
only, under 25 lines, no file contents.

**Implementer (opus, high):** brief carries the scout table, the flag name, the
"flag off = byte-identical" bar, and the deferred-assertion list from `_INDEX.md`.

**Reviewer (sonnet):** is flag-off genuinely byte-identical, or merely
"looks the same"? Does the device-link e2e build a fresh context? Does the
offline test assert convergence (`last_seq` + summary) or just that no error
appeared? Gap list only.

## On close

`_INDEX.md`: S12 → DONE, the v1 deletion inventory (full list, not a pointer to
the PR body), which deferred assertions remain, and the flag's exact name and
default. Memory + `scripts/agent-memory-snapshot.sh`.
