# Operator console (Graphics) — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** An org editor streaming a composed match gets a **Graphics** section at the top of the fixture stream
panel. It holds a plain-words health strip, the scenes Match · Break · Full time, a Hide graphics switch, and the
sponsor controls "Play next at next break" and "Skip this card". Every tap reaches the stream within a few seconds.

**Architecture:** The operator state is one row per fixture plus an append-only log. A tap is an optimistic-concurrency
`PUT /api/v1/fixtures/{id}/stream/operator`. The overlay's live answer carries `operator` for both hosts. The page
resolves the scene through one ordered precedence function (`sceneFor`), so the page and the health strip's "Viewers
see" line cannot disagree. The sponsor planner (sponsors plan S4/S5) reads the log, so hidden breaks, play next and
skip stay deterministic across hosts and re-polls. The compositor does not change.

**Tech Stack:** Next (the repo fork: read `node_modules/next/dist/docs/` before touching a route), TypeScript 7,
Node 26, postgres.js, Postgres 17 + Flyway deltas, zod + the api-v1 OpenAPI registry, vitest (`environment: "node"`),
Playwright via CI dispatch only.

**Spec:** `docs/superpowers/specs/2026-10-27-operator-console-design.md` (owner-approved 2026-10-27; §0 A1–A4 and
"org editors only" are the owner's). It reuses the sponsor spec
`docs/superpowers/specs/2026-10-27-sponsors-on-stream-design.md` and **its plan**
`docs/superpowers/plans/2026-10-27-sponsors-on-stream.md`. Read the sponsor plan's S4–S8 Interfaces blocks first.

**Cross-plan dependency order**

1. **Sponsors plan PR A** (`feat/r4-sponsors`, S1–S15) merges first. This plan consumes from it: `SponsorPlan`,
   `SponsorPlanAiring`, `planSponsors`, `OperatorLogEntry`, `OperatorLogField`, `graphicsHiddenAt`,
   `playNextChoiceAt`, `SPONSOR_STALE_MS` (S4), `sponsor_assignments`, `operatorLogFor`, `loadSponsorPlan` (S5),
   the queue's `skip` action and `cutShort` (S6), `SponsorCarousel`, `carouselOrder` (S7), `sponsor_airings.skipped`
   and `recordAirings` (S8).
2. **This plan** (`feat/r4-operator-console`, its own worktree, cut from `main` after PR A): C1–C8.
3. **C9** waits for the YouTube Connect PR, in the same gate as the sponsors plan's PR B. It ships with PR B or after
   it.
4. Release follows the sponsors plan's D13 rule: no prod tag carries this without Connect.

---

## Findings: spec pins re-verified on `5c4aeda9cd` (origin/main `a8f27bb7cf` + specs)

True as cited: `StreamMode` `server/api-v1/schemas.ts:1652`; composed `output` null `:1765-1767`; the chain's
neutral `sending` `lib/stream-chain.ts:20` (R2006 note :19); `frozen` in `PROGRAMME_PHASES` `lib/relay-phase.ts:12`;
`stream.onAir` `components/v2/fixture-stream-panel.tsx:2385`; `STREAM_POLL_MS = 5_000`
`lib/stream-session-view.ts:37`; the overlay route's relay `private, no-store` and public `s-maxage=2`
(`app/api/v1/public/fixtures/[id]/overlay/route.ts:16,20`).

Shifted or false (recorded):

- **G1.** `host=obs` is not a query value. The OBS page is the overlay page without `host=compositor`
  (`app/overlay/fixtures/[fixtureId]/page.tsx:177`). Every "at `host=obs`" test drives the page with no `host`.
- **G2.** The scene table lives in `components/overlay/overlay-scene.tsx:47` (`sceneFor(phase, slate)`), with scene
  declarations in `overlay-scenes.ts` (`OVERLAY_SCENES`, `momentsFire`). The precedence extends these two files; it
  is not a new parallel table.
- **G3.** "The same guard as Stop" is `requireResourceAuth(req, "fixture", id, "write")`
  (`app/api/v1/fixtures/[id]/stream-sessions/[sid]/stop/route.ts:18`) plus the session-only route list in
  `server/api-v1/key-scopes.ts:339-343`. Whether "write" admits a device-linked remote scorer is unverified. C2's
  test pins the 403, and a green there with no extra check is the finding.
- **G4.** The spec's "Viewers see" list has no line for the compositor's **Final** hold. Plan decision Q1 maps Final
  to the "The Full time screen" line (the Result or Stream ended card is what viewers see).

## Plan decisions

- **Q1.** "Viewers see" during compositor Final reads "The Full time screen" (G4).
- **Q2.** A passthrough session's PUT is refused with 409 `operator_needs_composed`. Its Graphics section is the
  plain line only (spec §1).
- **Q3.** "Current or next sponsor moment" (Skip's validity) is estimated from the plan. A plan airing is skippable
  while `now` lies in [`at + delay`, `at + delay + aheadMs + holdMs + SPONSOR_STALE_MS`], where `aheadMs` is the hold
  of a score moment at the same seq (e.g. `END_OF_OVER_HOLD_MS`, `lib/overlay-end-of-over.ts:10`). The bound is
  generous on purpose: refusing a real on-air card costs more than accepting a just-ended one, which folds nothing.
- **Q4.** A new composed session resets the row to Match, graphics shown, with no play-next and no skip. The reset is
  logged, so the planner sees it.

## Global Constraints

- **All 4 test types per task:** unit, E2E, smoke, regression. A task with no UI traces forward to the flow that
  exercises it. Every change ships a test that fails without it.
- **TEST-STRATEGY:** sweeps report a count, and zero checked is a FAILURE. Expected values come from declarations
  (`OVERLAY_SCENES`, `PROGRAMME_PHASES`, the sponsors plan's constants), never from the code under test. Mutate each
  new guard once and name its killer. Test the sequence: a second call, an empty input, after a void or undo, and
  another sport.
- **i18n:** every string, the "Graphics" heading included, goes in all 4 `dictionaries/*/ui.json`. A new key ⇒
  `npm run i18n:gen-keys`, then `npm run i18n:check`.
- **Mobile-first:** screenshots at 320 / 768 / 1280 with no horizontal scroll, as an Artifact page. 44 px targets.
  The 7-width `e2e/mobile.spec.ts` matrix is the backstop (open every phone fold first, AGENTS.md rule 22). `/admin`
  is exempt.
- **The frontend-design skill goes in every UI task. The screen is unmocked, so the builder shows the owner 2 layout
  options (C6) before building C7.** Mocks are layout only; the build uses the house theme.
- **Agents:** `implementer-sonnet` for every task; `reviewer` (Opus) reviews every task. No Rust task (the compositor
  is unchanged).
- **Verify, scoped only:**
  `cd <abs worktree>/apps/web && npx vitest run <paths> --reporter=json --outputFile=<scratch>/r4c-<task>/r.json; echo EXIT=$?`.
  Then check `numPassedTests == numTotalTests > 0`, `EXIT=0`, and that `.testResults[].name` are this worktree's
  paths. Also run `rtk proxy npm run typecheck --workspace apps/web`,
  `rtk proxy npx eslint --max-warnings 0 <changed files>`, and `npm run openapi:gen && git status --porcelain`
  (empty) when a route changes. DB tests use the `seazn-local-env` recipe.
- **E2E only by CI dispatch:** `gh workflow run e2e.yml --ref <branch> -f pr=<n>`. Never run Playwright or a server
  locally. Push, dispatch, hand back.
- **Engine boundary:** this plan touches no sport file. If one is touched, there is no value import from
  `competition/`, and `npm run engine:boundary` runs.
- **Migrations:** origin/main ends at V477, and V478 is claimed twice. Do not hardcode a number. Take the next free V
  at build time after re-checking origin/main and open branches (`git log --all --grep='takes V'`), and commit
  `chore(r4): C1 takes V<n>`.
- **Branch:** own worktree, rebased onto `main` before merge. Merge only on green CI and a clean review loop. Never
  `git stash`.
- **Not `components/v2/fixture-console.tsx`** (R7's scoring console) and not the division page's "Fixture Console".
  The UI name is **Graphics**.

## Review Focus

1. **A double tap or two editors at once.** The second PUT carries a stale `version` and gets a 409. The UI refetches
   and shows the current state, never a silent overwrite, and never a lost first tap. Test in C2 and C7.
2. **A tap during a camera drop.** Break set while Reconnecting shows Reconnecting. When the camera returns, Break is
   still in force. The strip reads "Phone reconnecting" with "Viewers see the Reconnecting screen, with the score".
   Test in C4 and C5.
3. **Hide graphics left on when the match resumes.** Nothing floods out when it is switched off: score moments and
   sponsor breaks from the hidden window are seen or unassigned. Test in C4.
4. **Skip pressed just as an 8 s card ends.** It is accepted inside Q3's window, folds nothing that has gone, and
   sets `skipped` only on an airing that really started. Test in C2 and C3.
5. **The panel on a 320 px phone with a 43-character sponsor name** in the Play next picker and the "Up next" row.
   `min-w-0` + `truncate` on the whole chain, no horizontal scroll. Test in C7.

---

## File structure

| File | Responsibility |
|---|---|
| `db/migration/deltas/V<next>__stream_operator.sql` | The state row and the log. |
| `apps/web/src/server/stream-operator/state.ts` | Read, put, reset, log. |
| `apps/web/src/lib/operator-console.ts` | Client-safe: `OperatorScene`, `OperatorState`, `ViewersSee`, `skippableMomentIds`, `graphicsHealth`. |
| `apps/web/src/app/api/v1/fixtures/[id]/stream/operator/route.ts` | PUT. |
| `apps/web/src/components/v2/stream-graphics-section.tsx` | The Graphics section. |

Modified: `server/sponsors/operator-log.ts` and `server/sponsors/airings.ts` (sponsors plan files),
`server/overlay/load.ts`, `components/overlay/{overlay-scene.tsx,overlay-scenes.ts,overlay-slate.tsx,overlay-stage.tsx,use-moment-queue.ts}`,
`server/api-v1/{schemas,openapi,key-scopes}.ts`, `server/usecases/stream-sessions.ts` (reset at admission; the session
view field), `lib/stream-session-view.ts`, `components/v2/fixture-stream-panel.tsx`, the four `ui.json`,
`e2e/{mobile,stream-overlay,overlay-compositor}.spec.ts`, `scripts/smoke.ts`.

---

### Task C1: Schema — operator state and log

**Files:**
- Create: `db/migration/deltas/V<next>__stream_operator.sql`
- Test: `apps/web/src/server/stream-operator/__tests__/migration.test.ts`

**Interfaces:**
- Produces:
  - `fixture_stream_operator (fixture_id pk → fixtures on delete cascade, org_id, scene text not null default 'match' check in ('match','break','full_time'), graphics_hidden boolean not null default false, next_sponsor_id uuid null → sponsors on delete set null, next_set_at timestamptz null, skip_moment_id text null, version int not null default 0, updated_by uuid null, updated_at timestamptz not null default now())`, check `(next_sponsor_id is null) = (next_set_at is null)`.
  - `fixture_stream_operator_log (id bigint generated always as identity, fixture_id → fixtures cascade, org_id, at timestamptz not null, field text check in ('scene','graphics_hidden','next_sponsor_id','skip_moment_id'), value jsonb, by uuid null)`, index `(fixture_id, at)`. The `field` set equals the sponsors plan's `OperatorLogField`.
  - RLS org-scoped (`enable` + `force`), as V283.
- [ ] **Step 0:** Load `supabase:supabase-postgres-best-practices`. Take the next free V.
- [ ] **Step 1: Failing tests.**
```ts
it("a fixture has at most one operator row; deleting the fixture removes row and log", …);
it("next_sponsor_id without next_set_at is refused", …);
it("deleting the chosen sponsor nulls next_sponsor_id (and the check still holds: next_set_at nulled with it)", …);  // a trigger or set-null on both — builder's call, the test decides
it("the log's field check equals OperatorLogField (read from information_schema vs the TS union)", …);
it("RLS: org B reads neither table's org A rows (count reported)", …);
```
- [ ] **Step 2–4:** red → delta → `db:apply` + `sync:sports` → green. **MUTATE** the pair check and name the killer.
- [ ] **Step 5: Commit** `feat(stream): operator state and log tables`, then `chore(r4): C1 takes V<n>`.

**Four types:** unit + regression; E2E via C8; smoke via C2's row.

### Task C2: The operator usecase and the PUT route

**Files:**
- Create: `server/stream-operator/state.ts`, `lib/operator-console.ts` (types + `skippableMomentIds`), `app/api/v1/fixtures/[id]/stream/operator/route.ts`
- Modify: `server/api-v1/{schemas,openapi,key-scopes}.ts` (add `"PUT /fixtures/:id/stream/operator"` to the session-only list beside stop, :339-343), `server/usecases/stream-sessions.ts` (`createSession` :1514 calls `resetStreamOperator`, Q4)
- Test: `server/stream-operator/__tests__/state.test.ts`, the route test, `lib/__tests__/operator-console.test.ts`

**Interfaces:**
- Consumes: sponsors S4 `SponsorPlan`, `SPONSOR_STALE_MS`; S5 `loadSponsorPlan`, `sponsorsTableCardSource`.
- Produces:
```ts
// lib/operator-console.ts
export type OperatorScene = "match" | "break" | "full_time";
export interface OperatorState { scene: OperatorScene; graphicsHidden: boolean; nextSponsorId: string | null; nextSetAt: string | null; skipMomentId: string | null; version: number }
export const DEFAULT_OPERATOR_STATE: OperatorState;   // match, shown, nulls, version 0
export function skippableMomentIds(plan: SponsorPlan, eventAt: (seq: number) => string, o: { now: number; delayMs: number; aheadMs: (seq: number) => number }): string[];  // Q3
// schemas.ts
export const PutStreamOperator = z.object({ version: z.number().int().min(0), scene: z.enum(["match", "break", "full_time"]).optional(),
  graphicsHidden: z.boolean().optional(), nextSponsorId: z.string().uuid().nullable().optional(), skipMomentId: z.string().max(80).optional() }).strict();
// server/stream-operator/state.ts
export async function readStreamOperator(exec: Tx | typeof sql, fixtureId: string): Promise<OperatorState>;   // DEFAULT when no row
export async function putStreamOperator(auth: AuthCtx, fixtureId: string, b: PutStreamOperator, now: Date): Promise<OperatorState>;
export async function resetStreamOperator(tx: Tx, fixtureId: string, orgId: string, now: Date): Promise<void>;
```
- Refusals, in order: another org's fixture → opaque 404. Not an editor → 403 (G3). No session in
  `warming | live | ending` → 409 `no_active_session`. Passthrough → 409 `operator_needs_composed` (Q2). Stale
  `version` → 409 `stale_version`. `nextSponsorId` not ticked for this fixture's competition → 422
  `sponsor_not_ticked`. `skipMomentId` not in `skippableMomentIds` → 422 `not_skippable`. Each changed field appends
  one log row, and `version` increments once per PUT.
- [ ] **Step 1: Failing tests.**
```ts
it("409 stale_version on a second PUT with the first's version; the row is unchanged", …);   // Review Focus 1
it("a scorer → 403; a device-linked remote scorer → 403 (G3); org B → 404", …);
it("no active session → 409; a passthrough session → 409 operator_needs_composed", …);
it("play next of an unticked sponsor → 422; of a ticked one → next_set_at = now, one log row", …);
it("skip of a moment not in the plan's current/next → 422; skip of an 8 s card's moment 3 s after its event, with no airing row yet → 200", …);   // spec §6
it("skippableMomentIds: delay 10 s shifts the window; a moment 1 ms past the window's end is not skippable", …);
it("sequence: hide → show → hide writes three log rows and leaves graphicsHidden true, version 3", …);
it("sequence: Full time → Match; a new composed session resets to DEFAULT and logs the reset (Q4)", …);
it("empty body {version} only → 400 (nothing to change)", …);
```
- [ ] **Step 2–4:** red → implement → green → `openapi:gen` drift empty. **MUTATE** (a) the version check and (b) the
  ticked check, one at a time, and name the killers.
- [ ] **Step 5: Commit** `feat(stream): operator state PUT`.

**Four types:** unit + regression; E2E via C8; smoke `stream: operator PUT on a seeded live session` (spec §6).

### Task C3: The operator in the plan, the overlay answer and the airing row

**Files:**
- Modify: `server/sponsors/operator-log.ts` (`operatorLogFor` reads `fixture_stream_operator_log`, the cross-plan seam), `server/sponsors/airings.ts` (`recordAirings` sets `skipped`), `server/overlay/load.ts` (`operator` field), `server/api-v1/schemas.ts` (overlay answer)
- Test: rewrite `server/sponsors/__tests__/assign.test.ts`'s `operatorLogFor` case; add `server/stream-operator/__tests__/plan-wiring.test.ts`

**Interfaces:**
- Consumes: C1 log; C2 `readStreamOperator`; sponsors S4 `planSponsors` (`graphicsHiddenAt`, `playNextChoiceAt`), S5
  `loadSponsorPlan`, S8 `recordAirings`.
- Produces: `OverlayLiveData.operator: { scene: OperatorScene; graphicsHidden: boolean; skipMomentId: string | null }`
  on both the public and the relay answer. Play next reaches the page only through `sponsorPlan`.
- [ ] **Step 1: Failing tests (DB-backed, through the real loader).**
```ts
it("a break opened while hidden (log says so) is not assigned, and the org's next position is unchanged", …);
it("play next → that sponsor takes the next eligible break as operator; the rotation's next is next after it", …);
it("play next → the break event is undone → the choice is still pending and takes the next eligible break", …);   // spec §6 sequence
it("a skipped moment's later start line writes the airing with skipped = true; a non-skipped one false", …);
it("a skip before start: no start line ever arrives ⇒ no airing row, and the rotation does not replay it", …);
it("the public answer and the relay answer carry the same operator object", …);
it("operator changes are not cached behind the fold key: a PUT is visible on the next public poll after the 2 s edge window", …);
```
- [ ] **Step 2–4:** red → implement → green → drift empty. **MUTATE** `operatorLogFor` back to `[]` and name the test
  that dies (proves the seam is live, failure class 1).
- [ ] **Step 5: Commit** `feat(stream): operator log drives the sponsor plan`.

**Four types:** unit + regression; E2E via C8; smoke `overlay answer carries operator`.

### Task C4: The page — scene precedence, Break and Full time, hide, skip

**Files:**
- Modify: `components/overlay/overlay-scenes.ts` (declare `break` with `momentsFire: true` and `full_time` with `momentsFire: false`), `components/overlay/overlay-scene.tsx` (`sceneFor` gains the operator), `components/overlay/overlay-slate.tsx` (`OverlayMatchCard` variants `back_shortly`, `full_time`), `components/overlay/overlay-stage.tsx`, `components/overlay/use-moment-queue.ts`, the four `ui.json`
- Test: `components/overlay/__tests__/scene-precedence.test.ts`, `components/overlay/__tests__/operator-moments.test.ts`

**Interfaces:**
- Consumes: C3 `operator`; sponsors S6 `skip` action; S7 `SponsorCarousel`.
- Produces:
```ts
export type SceneCard = "upcoming" | "result" | "reconnecting" | "ended" | "back_shortly" | "full_time";
export function sceneFor(phase: ProgrammePhaseWire | null, slate: SlateState, operatorScene: OperatorScene | null): SceneDecision;
// order: final > reconnecting > op full_time > op break > waiting > match; frozen ≡ match; operatorScene ignored when phase is null (no host, G1)
export function graphicsDrawn(d: SceneDecision, graphicsHidden: boolean): boolean;   // false only when d.scene === null (Match) and hidden
export type ViewersSee = "match_with_score" | "back_shortly" | "reconnecting_with_score" | "full_time" | "starting_soon" | "match_without_graphics";
export function viewersSee(d: SceneDecision, graphicsHidden: boolean): ViewersSee;   // final ⇒ "full_time" (Q1)
```
- Break draws the opaque backdrop, the score bug, the Back shortly card (entrant names) and the carousel, and score
  moments still fire. Full time draws Result when decided or void, else a Full time card with the score, plus the
  carousel, and no moments fire. Hidden in Match draws nothing: no bug, slabs or cards. Score moments are discarded
  (seen), and so are sponsor moments. `skipMomentId` dispatches the queue's `skip`. **Operator state is read from the
  newest poll and never passes through the overlay `delay` buffer** (re-pin the delay mechanism in `overlay-stage.tsx`
  first).
- [ ] **Step 1: Failing tests.**
```ts
it("precedence over every (PROGRAMME_PHASES ∪ null) × OperatorScene × hidden triple: rendered scene and viewersSee asserted (count = 6 × 3 × 2 = 36 reported; 0 ⇒ fail)", …);
it("frozen + Break ⇒ Break; reconnecting + Break ⇒ Reconnecting, and back to live ⇒ Break again", …);   // Review Focus 2
it("no host (OBS): operator scene never drawn; hide and skip still apply", …);
it("hidden in Match: graphicsDrawn false and score moments seen; unhide ⇒ the next new moment airs, none of the hidden ones", …);   // Review Focus 3
it("hidden in Break still draws Break; hidden during compositor Final still draws Final", …);
it("Full time with the match decided ⇒ result card; undecided ⇒ full_time card; momentsFireIn('full_time') is false", …);
it("delay 10 s: an operator change in the newest poll applies at once while that poll's score is still withheld", …);
it("skip folds only the named moment", …);
```
- [ ] **Step 2–4:** red → implement (frontend-design for the two card variants, house theme) → green. **MUTATE**
  (a) swap Break above Reconnecting in the order and (b) the hide guard, one at a time, and name the killers.
- [ ] **Step 5:** CI e2e `overlay-compositor.spec.ts` + `stream-overlay.spec.ts` (whole files). Publish 1920×1080
  captures of Break and Full time as an Artifact page.
- [ ] **Step 6: Commit** `feat(overlay): operator scenes, hide graphics and skip`.

**Four types:** unit + regression; E2E as above; smoke via C8.

### Task C5: The health strip and the session-view field

**Files:**
- Modify: `lib/operator-console.ts` (`graphicsHealth`), `server/api-v1/schemas.ts` (`StreamSessionCurrent` :1751 gains `graphics`), `server/usecases/stream-sessions.ts` (`currentSession` :2439 fills it), `lib/stream-session-view.ts`
- Test: `lib/__tests__/graphics-health.test.ts`, extend `server/usecases/__tests__/stream-sessions.test.ts`

**Interfaces:**
- Consumes: C4 `sceneFor`, `viewersSee`; C2 `readStreamOperator`, `skippableMomentIds`; `lib/stream-chain.ts` nodes.
- Produces:
```ts
export interface GraphicsHealth { live: "live" | "not_live" | "ended"; phone: "good" | "reconnecting" | "lost"; youtube: "sending"; viewersSee: ViewersSee }
export function graphicsHealth(i: { sessionState: StreamSessionState; phoneNode: ChainNode; beat: { programmePhase: ProgrammePhaseWire | null; input: "connecting" | "connected" | "backoff" | null } | null;
  operator: OperatorState; slate: SlateState }): GraphicsHealth;
// StreamSessionCurrent.graphics: { mode: StreamMode; operator: OperatorState; health: GraphicsHealth;
//   tickedSponsors: { id: string; name: string }[]; upNext: { sponsorId: string; name: string } | null; skippable: { momentId: string; name: string } | null } | null
```
- No "weak" phone word: only the three states the chain already measures. The YouTube line is `sending` only
  (C9 adds the Connect states). It never reads "receiving".
- [ ] **Step 1: Failing tests.**
```ts
it("enumerate every (session state × phone node word × beat input × programmePhase) the chain can produce; each maps to exactly one line set (count reported)", …);
it("phone drop: beat input 'backoff' + phase 'reconnecting' ⇒ phone 'reconnecting', viewersSee 'reconnecting_with_score'", …);
it("a composed session without Connect never yields a youtube value other than 'sending' (sweep, count reported)", …);
it("viewersSee here equals C4's viewersSee for the same inputs (one function, not two)", …);
it("graphics is null with no session; upNext clears once the choice is consumed; skippable names the plan's moment", …);
```
- [ ] **Step 2–4:** red → implement → green → drift empty. **MUTATE** the session-state → `live` arm (map `warming`
  to "live") and name the killer.
- [ ] **Step 5: Commit** `feat(stream): graphics health and session-view field`.

**Four types:** unit + regression; E2E via C7/C8; smoke `session view carries graphics on a composed session`.

### Task C6: Two layout options for the owner (no repo change; gates C7)

- [ ] **Step 1:** Load frontend-design. Build 2 layout options for the Graphics section at 320 and 1280, in the house
  theme, in the visual companion. Show the health strip, the segmented scenes, the Hide switch, Play next with a
  43-character name, Skip (enabled and disabled with its reason), and the passthrough line.
- [ ] **Step 2:** Re-pin how the phone composition's *Stream* control reaches the panel (AGENTS.md: one of the two
  duplicated controls, its desktop twin `max-md:hidden`) and put Graphics first in whatever it opens.
- [ ] **Step 3:** Publish both as one Artifact page with a recommendation framed as product owner. Record the owner's
  pick in this plan's decision list before C7 starts. Never assume it.

### Task C7: The Graphics section

**Files:**
- Create: `components/v2/stream-graphics-section.tsx`
- Modify: `components/v2/fixture-stream-panel.tsx` (mount at the top while the session is `warming | live | ending`), the four `ui.json`, `e2e/mobile.spec.ts`
- Test: `components/v2/__tests__/stream-graphics-section.test.tsx`

**Interfaces:**
- Consumes: C5 `StreamSessionCurrent.graphics` (rides the existing `STREAM_POLL_MS` poll, no second timer); C2 PUT.
- Produces: testids `stream-graphics`, `stream-graphics-scene-{match|break|full_time}`, `stream-graphics-hide`,
  `stream-graphics-play-next`, `stream-graphics-up-next`, `stream-graphics-skip`, `stream-graphics-health-{live|phone|youtube|viewers}`.
- Every disabled control says why: no card on air, a passthrough (OBS) session, or a stream that is not live. A 409
  refetches and shows the current state. Latency copy is "a few seconds".
- [ ] **Step 1: Failing tests (node render).**
```ts
it("passthrough ⇒ only the plain 'graphics are controlled in OBS' line, no controls", …);
it("the scene control opens at the server's scene (pin the seeded value: break), not at Match", …);
it("a 409 from the PUT triggers one refetch and renders the server's state", …);   // Review Focus 1
it("Skip disabled with its reason when graphics.skippable is null; enabled with the moment's sponsor name otherwise", …);
it("a scorer's view renders no Graphics section", …);
it("the sponsor name cell's ancestor chain carries min-w-0 at every level; the name truncates", …);   // Review Focus 5
```
- [ ] **Step 2–4:** red → implement C6's pick (frontend-design, house theme, 44 px targets) → green.
- [ ] **Step 5:** CI e2e `mobile.spec.ts` (whole file; open every fold first) and a `stream-graphics.spec.ts` at
  320/768/1280. Artifact page.
- [ ] **Step 6: Commit** `feat(stream): Graphics section`.

**Four types:** unit + regression; E2E as above (seven widths, no clipping); smoke via C8.

### Task C8: The seam, driven for real, plus E2E, smoke and the stg check

**Files:**
- Test: `server/stream-operator/__tests__/seam.test.ts`; extend `e2e/stream-graphics.spec.ts`, `e2e/overlay-compositor.spec.ts`; `scripts/smoke.ts`

- [ ] **Step 1: Seam (failure class 1).** PUT through the real route handler. Read the real overlay answer, relay and
  public. Fold it through the real `sceneFor`, `graphicsDrawn` and `momentQueueReducer` at `host=compositor` and with
  no host. Then send a real heartbeat body carrying the page's `seazn:sponsor:*` items to the real `heartbeat`
  usecase, and assert that `currentSession().graphics.health` and the `sponsor_airings` row (with `skipped` from the
  log) both change.
- [ ] **Step 2: E2E (CI dispatch).** The scene control switches the overlay preview, and Hide empties the Match
  preview. Graphics renders at all seven widths without clipping.
- [ ] **Step 3: Smoke.** The rows from C2, C3 and C5 are in `scripts/smoke.ts`. Run the scoped smoke.
- [ ] **Step 4: Live check on stg with the owner.** On one composed match: Break on and off, Full time, Hide graphics,
  Play next, Skip. Read `sponsor_airings` back.
- [ ] **Step 5: Commit** `test(stream): operator console seam, e2e, smoke`. Push, open the PR, dispatch e2e, hand back.

### Task C9: The YouTube line from Connect (after the Connect PR merges)

**Files:**
- Modify: `lib/operator-console.ts` (`GraphicsHealth.youtube` gains Connect states), `server/usecases/stream-sessions.ts` (read the session's `youtube_broadcast_id` → `youtube_broadcasts.state`), the four `ui.json`
- Test: extend `lib/__tests__/graphics-health.test.ts`

**Interfaces:**
- Consumes (Connect, re-pin on `main`): `fixture_stream_sessions.youtube_broadcast_id`, `youtube_broadcasts.state ∈ created|bound|reserved|live|ending|complete|failed`.
- Produces: `youtube: "sending" | "youtube_live" | "youtube_waiting" | "youtube_problem"`. `live` maps to youtube_live;
  `created | bound | reserved` to youtube_waiting; `failed` to youtube_problem; no broadcast to `sending` (unchanged).
- [ ] **Step 1: Failing tests:** each Connect state maps per the table above (sweep over the V478 state check's set,
  read from the schema, count reported). No broadcast stays `sending`.
- [ ] **Step 2–4:** red → implement → green. Mutate the `live` arm once.
- [ ] **Step 5: Commit** `feat(stream): YouTube line reads Connect's broadcast state`.

**Four types:** unit + regression; E2E `stream-graphics.spec.ts › youtube line` with the Connect fake; smoke none
beyond C5's.

---

## Spec coverage map (self-review)

| Spec | Task |
|---|---|
| §0 A1 | C5, C7, C9 |
| §0 A2 | C4, C7 |
| §0 A3 | C3, C4, C7 |
| §0 A4 | C2, C3, C7 |
| §0 editors only, 2 options | C2 (G3), C6 |
| §1 where / passthrough line | C7, Q2 |
| §2 | Findings |
| §3.1 | C5 (Connect line C9) |
| §3.2 precedence, OBS | C4 |
| §3.3 | C3, C4 |
| §3.4 | C2 (Q3), C3 |
| §4 state, PUT, read, latency | C1, C2, C3, C4 (no delay) |
| §5 | C7, Global |
| §6 | per task; seam C8 |
| §8 Later | not planned |
