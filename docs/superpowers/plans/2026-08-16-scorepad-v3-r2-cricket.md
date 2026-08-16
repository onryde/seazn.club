# R2 — cricket conversion, execution plan

Wave brief: `docs/superpowers/specs/2026-08-15-scoringpad-v3-prompts/R2-cricket.md`.
Standing rules: `_RULES.md` beside it. Design of record:
`docs/superpowers/specs/2026-08-15-scoringpad-v3-redesign-design.md`.

Worktree `.claude/worktrees/r2-cricket`, branch `feat/scorepad-v3-r2-cricket`,
based on main `c8f0c916`. Test DB `postgresql://postgres@127.0.0.1:54345/seazn_test`
(own server, `data_directory` verified; `db:apply` + `sync:sports` = 11 sports,
31 system variants).

## 0. Re-pinned facts (scouted 2026-08-16, all pins in the brief predate R1)

| fact | evidence |
|---|---|
| **No v3 render host exists.** All six chassis components have ZERO production imports | `git grep -a` over `apps/web/src` + `apps/web/e2e` excluding `v3/__tests__/` |
| `registry.tsx:280` **throws** for a v3-lane sport — deliberate R1 tripwire | read inline |
| `SkinDefV3` methods take `(view)` only, not `(view, ctx)` as the spec sketch says | `v3/types.ts` |
| `enqueueHeld` (`queue.ts:184`) is dead code, no production caller; `retryDrain` is exposed at `use-pad-pipeline.ts:1352` | scout |
| cricket has **15** event types (`cricket.ts:362`); only `cricket.ball` / `cricket.superover.ball` dispatch directly (`cricket-skin.tsx:619`); the other 13 ride the generic `padSpec(cfg)` `ActionForm` (`cricket-skin.tsx:831,863`) | scout |
| `ballsPerOverOf()` (`cricket-skin.tsx:98`) already reads cfg with a 6 fallback; `hundred` sets 5 at `cricket.ts:2811` | scout — the brief's "assumes 6" fear is already half-closed |
| `PAD_LABEL_KEYS` = 172 entries (`scoring-vocab.ts:646`); 20 `pad.cricket.*`; **no ribbon keys** | scout |
| dictionaries: `apps/web/src/dictionaries/{en,es,fr,nl}/ui.json`, 76 cricket keys each, at parity | scout |
| 4 e2e specs drive the cricket pad: `scorepad-skins.spec.ts`, `scorepad-v2.spec.ts`, `scoring.spec.ts`, `scoring-vocab-labels.spec.ts` | scout |
| gallery capture: `apps/web/e2e/gallery.capture.ts:38`, `GALLERY_DIR`-gated, walks 12 sports | scout |

## 1. Owner rulings taken this session (2026-08-16)

1. **Admin events — HYBRID.** Toss, Review, Retire, Innings close, Declare get
   real phase-aware tiles; the remaining 8 sit behind one `minor` "More" tile
   that opens a sheet hosting the `padSpec(cfg)`-driven generic form. All in
   the PAD. Console authority chrome (Finalize/Forfeit/Abandon) stays R7;
   `/admin` is untouched.
2. **Recording chip — wire it, parameterised.** Derive the plan name from the
   org's real entitlement; kill the `planLabel("pro")` literal before the chip
   renders. Closes D-7 for cricket.
3. **Violet primary tiles — build as §2.5 specs, rule at sign-off.** Flag the
   `violet-*`-means-AI collision in the gallery; a recolour afterwards is a
   token change.

## 2. Tasks

Wave A runs in parallel (provably disjoint files). Everything after is serial.

### A1 — guided-sheet renderer (chassis debt R1 left)
- New `v3/guided-sheet.tsx`: renders `GuidedSheetSpec` step wizard
  (`SheetChoiceStep` | `SheetPersonStep`), back/cancel, `buildPayload(answers)`
  on the last step. Person steps resolve through `resolvePool` (context-strip's
  existing helper), NOT `attribution-picker`'s bench-inclusive candidates.
- `tile-grid.tsx`: `action = {sheet: string}` must reach a sheet-opener callback,
  not be forwarded raw.
- Tests: `v3/__tests__/guided-sheet.test.ts` — builder/step-machine assertions
  (node env, no DOM).

### A2 — recording chip plan name
- `recording-chip.tsx`: `buildRecording` takes the plan/entitlement instead of
  `planLabel("pro")`. `pro_plus` must render as itself.
- Tests: extend `v3/__tests__/recording.test.ts` — a `pro_plus` org is never
  told the band is "available on Pro".

### A3 — scorebug token linkage
- `scorebug.tsx` currently hand-matches `NIGHT_TILE_PAIRS` / `SCORE_TEXT_PX` in
  literal Tailwind. Link them so a class edit cannot desync what
  `contrast.test.ts` measures from what renders.

### B — v3 pad host (serial, biggest single item)
- New `v3/pad-host.tsx`: assembles scorebug + ribbon + context strip + tile grid
  + detail dock + swap sheet + guided sheet + recording chip over
  `usePadPipeline`. Held path via `enqueueHeld`; dock `onDue` uses `retryDrain`.
- Dispatch guard preserved: a skin cannot invent an event type.
- The "More" sheet hosts the `padSpec(cfg)` generic form (ruling 1).
- Replaces the `registry.tsx:280` throw with the real v3 branch.

### C — cricket `SkinDefV3` (`v3/skins/cricket.tsx`)
- scorebug: `12/0` + overs halves (both passive, tapModel T); strip =
  ▸striker* · non-striker · over dots (`ballsPerOver` from cfg) · ⚾ bowler.
- tiles: run keypad 0–6, Wide, red Wicket, extras minor row; 5 designed admin
  tiles per phase; "More"; `test` variant adds declare/follow-on/match.close.
- context strip: striker / non-striker / bowler — replaces the 3 dropdowns (D-14).
- sheets: wicket = kind → who out → fielder (D-15).
- dock: shot type.
- swap sheet: new batter after wicket, `cricket.retire` flow.

### D — i18n
- `pad.cricket.ribbon.*` ×4 locales **and** into `PAD_LABEL_KEYS` (R1's owed
  item — dictionaries alone leave ribbon copy on the generic fallback forever
  with nothing failing), plus every new tile/sheet string.
- `npm run i18n:gen-keys`, `i18n:check`, `git status --porcelain` empty.

### E — registry flip + gates
- `V3_SKINS.cricket`; cricket out of `LEGACY_SPORTS`. Mutation-prove both
  directions in `registry-totality.test.ts`.
- Dispatch-guard test: every one of the 15 `cricket.*` event types is reachable
  from the new surface.

### F — e2e + widths

Exact couplings the lane flip breaks (grepped 2026-08-16, before any edit):

| spec:line | selector / text | dies because |
|---|---|---|
| `scorepad-v2.spec.ts:96` | `[data-role="cricket-this-over"] select` ×3, driven by `selectOption` | the three dropdowns ARE D-14; the context strip replaces them |
| `scoring.spec.ts:245` | `[data-role="cricket-skin"]` | v3 skin is a different component |
| `scoring.spec.ts:247-248` | `getByText("Score")` / `getByText("Wickets")` as two fields | §2.1 renders one `12/0` scorebug instead |
| `scoring-vocab-labels.spec.ts:31` | the 10th dismissal offered as words | the wicket kind picker moves into the guided sheet |
| `scorepad-skins.spec.ts:76,114` | axe contrast guard + "a couple of balls scored" | only place axe runs against the cricket pad |

Consequence for tasks B/C: the v3 host and the cricket skin must emit STABLE
`data-role` hooks, decided deliberately, not inherited by accident — and every
assertion must anchor on `="` (React serialises an omitted prop as
`"$undefined"`, so a bare `data-*` probe passes in both states).

- Update the 4 existing cricket specs to the v3 surface (`git grep -a` old AND
  new text first).
- New spec: full over + wicket + undo + device link, real rosters.
- Add the converted pad to `mobile.spec.ts`'s seven-width matrix.
- axe per skin; screenshots 320/768/1280, no horizontal scroll, 44px floor.

### G — gate, gallery, sign-off
- Gallery capture for cricket, publish the artifact, owner per-screen verdicts
  recorded in `_INDEX.md` BEFORE merge (merge-blocking).
- Smoke deferred to R8 — say so in the PR body.
- Register rows D-4, D-5, D-14, D-15: close or record why not.

## 3. Verify commands (exact — the wrappers lie)

Scoped unit run, from the worktree, JSON only:

```bash
cd /Users/ashokhein/github/seazn.club/.claude/worktrees/r2-cricket/apps/web && \
DATABASE_URL="postgresql://postgres@127.0.0.1:54345/seazn_test" DATABASE_SSL=disable \
npx vitest run src/components/v2/scorepad/v3 --reporter=json \
  --outputFile=/tmp/r2-unit.json > /dev/null 2>&1; echo "EXIT=$?"
jq '{success,numPassedTests,numFailedTests,numTotalTests,numFailedTestSuites}' /tmp/r2-unit.json
```

Typecheck (peaks ~2.8 GB):

```bash
cd <wt>/apps/web && NODE_OPTIONS=--max-old-space-size=6144 npm run typecheck > out.txt 2>&1; echo "EXIT=$?"
```

Lint via `rtk proxy`, judged on the `✖ N problems` line — `rtk` hides
`npm run lint` output entirely.

## 4. Do NOT touch

`packages/engine` (no engine work in R2 — §9 item 1 is R4's), other skins,
the lineup editor (R7), console chrome (R7), `/admin`, `.github/workflows/`.
`skins/cricket-skin.tsx` stays on disk — R8 deletes the v2 path.
