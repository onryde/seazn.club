# Sponsors on stream, the Sponsors hub and the sponsor report — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A club ticks sponsors into a per-org rotation; the engine's declared natural breaks put a sponsor card on
both the composed and the OBS stream; the compositor proves each showing; and a no-login link gives the sponsor the
report (times shown, time on screen, viewer impressions, link clicks, a frame per showing).

**Architecture:** Each sport module declares its natural breaks (`SportModule.naturalBreaks`). The overlay's live
answer gains `sponsorPlan`, computed server-side by a pure planner over the fixture's breaks, the dial, the ticked
cards, the persisted assignments and the operator log, so OBS and the composed page show the same card at the same
break. The page queues sponsor moments behind score moments in the existing `moment-queue.ts`. At `host=compositor` it
logs `seazn:sponsor:*` console lines, which the compositor forwards on the heartbeat (`airings`) and the web writes to
`sponsor_airings`. The hub, the On stream tab and the report read those rows.

**Tech Stack:** Next (the repo fork: read `node_modules/next/dist/docs/` before touching a route or page),
TypeScript 7, Node 26, postgres.js, Postgres 17 + Flyway deltas, zod + the api-v1 OpenAPI registry, vitest
(`environment: "node"`), Playwright via CI dispatch only. The compositor is Rust (CEF + GStreamer) in
`/Users/ashokhein/github/seazn.club.compositor`.

**Spec:** `docs/superpowers/specs/2026-10-27-sponsors-on-stream-design.md` (owner-approved 2026-10-27; §0 D1–D14 are
the owner's and are not re-decided here). Companion: `docs/superpowers/specs/2026-10-27-operator-console-design.md`
and its plan `docs/superpowers/plans/2026-10-27-operator-console.md`. YouTube Connect:
`docs/superpowers/specs/2026-10-27-youtube-connect-design.md` and its plan, on branch `feat/youtube-connect`.

**Cross-plan dependency order**

1. **This plan, PR A** (`feat/r4-sponsors`, web): S1–S15. In parallel, **PR C** in the compositor repo
   (`feat/sponsor-airings`): SC1–SC2, which consumes S8's contract. PR A merges and deploys before PR C's release,
   because the heartbeat is `.strict()` and refuses an unknown `airings` field.
2. **Console plan** (`feat/r4-operator-console`): C1–C8, cut from `main` after PR A merges. It consumes S3, S4, S5,
   S6, S7 and S8 (names in the Interfaces blocks below).
3. **This plan, PR B** (`feat/r4-sponsors-youtube`): Y1–Y3, cut from `main` only after the YouTube Connect PR merges.
   Y2 additionally needs Connect's T14 (`youtube_broadcasts.actual_start_at`), which lands in that same PR. Console C9
   rides the same gate.
4. **Release (D13):** no prod tag carries PR A without the Connect PR and PR B. Merging PR A to `main` is not a
   release; the prod tag is.

---

## Findings: spec pins re-verified on `5c4aeda9cd` (origin/main `a8f27bb7cf` + specs)

True as cited: `resolveSponsors` `usecases/sponsors.ts:307`; `RelayHeartbeat` `api-v1/schemas.ts:2018`, `.strict()`
at :2062; 11 modules in `packages/engine/src/sports/index.ts:23-35`, none declaring breaks; carrom's `breaks` stat
`sports/carrom/carrom.ts:1176`; the Player-home `hidden min-[350px]:flex` precedent `components/nav.tsx:234`; the
overlay route's two cache headers `app/api/v1/public/fixtures/[id]/overlay/route.ts:16,20`; `seazn:ready` /
`seazn:alive` `lib/overlay-compositor.ts:50,53`, read in the compositor `crates/adapters/src/cef_graphics.rs:229-230`;
compositor heartbeat every 5 000 ms (`crates/domain/src/config.rs:265`).

False or shifted (recorded, not blockers):

- **F1.** `settings/page.tsx:161-177` is the Sponsors tab's data load (now :162-185). The mount is :453-475
  (`OrgSponsors` :456, `SponsorPackages` :467). The role guard is the page's `canEdit` (:118).
- **F2.** `END_OF_OVER_HOLD_MS` lives at `lib/overlay-end-of-over.ts:10` (3 000 ms), not in `overlay-moments.ts`;
  `overlay-moments.ts:48` is the `graphic` union.
- **F3.** **The public match page has no sponsor strip.** The only `/s/` link is `components/public-site/sponsors-board.tsx:76`,
  mounted on the competition page (`app/(public)/shared/[orgSlug]/[competitionSlug]/page.tsx:414`). S10 tags that
  board `src=site`. **Owner ruling 2026-10-27 ("a"):** the same board also mounts on the public match page
  (`app/(public)/shared/[orgSlug]/[competitionSlug]/[divisionSlug]/fixtures/[fixtureId]/page.tsx`), its links tagged
  `?f=<fixtureId>&src=match`, so clicks there count for that match. S10 owns it.
- **F4.** `host=obs` is not a query value. The OBS page is the overlay page without `host=compositor`
  (`app/overlay/fixtures/[fixtureId]/page.tsx:177`, `isCompositorHost`). Every "at `host=obs`" test drives the page with
  no `host`.
- **F5.** `relay-job.v1.json` is published by **web** (`docs/contracts/relay-job.v1.json`) and vendored **into the
  compositor** (`contracts/VENDORED.json`, source `onryde/seazn.club`). The spec's "vendored to web" has the direction
  reversed.
- **F6. Premise change (coordinator, from the YouTube Connect session, 2026-10-27):** Connect stores no viewer counts.
  Its retention hooks are `server/youtube/daily.ts` (its T17, the 30-day refresh) and `server/youtube/disconnect.ts`
  (its T18, the purge), and both DELETE `youtube_broadcasts` rows. So **spec §6.3's R4 refresh/purge job is dropped**,
  and so are the `viewers`, `video_id` and `youtube_refreshed_at` columns on `sponsor_airings`. Viewers live in an R4
  table with `broadcast_id → youtube_broadcasts(id) on delete cascade` (Y1). The video id is read through that join,
  never copied. Connect's purge then covers the 7-day and 30-day rules. Residual question for the coordinator: a viewer
  count read while live cannot be refreshed after the broadcast ends, but Connect's refresh keeps the broadcast row,
  so the count outlives 30 days. Y1 Step 0 checks this against DP III.E.4 and sends a negative back.
- **F7.** `youtube_broadcasts.actual_start_at` / `actual_end_at` (nullable timestamptz) are proposed by Connect's T14
  and pending their owner. They stay null while live and until the end step runs (up to ~10 min after Stop on stg).
  Y2 is gated on T14.
- **F8.** `lockOrg` (`usecases/stream-credits.ts:103`) is the stream-credits **money** lock. The rotation takes a
  separate advisory lock built the same way (S5), so sponsor polls never queue behind money writes.
- **F9.** Spec §3.2 sets "cycle position = count of the org's rotation assignments". A count collides once an undone
  break's not-yet-aired assignment is deleted. The position is `max(position) + 1` (gaps allowed).
- **F10.** `SponsorTier` is declared in server-only `usecases/sponsors.ts:41-42`, which imports the email outbox. The
  client-safe planner cannot import it, so S3 moves the tier list to `lib/sponsor-tiers.ts` and the usecase re-exports
  it (one authority).

## Plan decisions where the spec leaves the builder a choice

- **P1.** A minor and a major opened by the same event are one break: `opensAt` returns the major only. A set-winning
  tennis point is `["set_end"]`. The set break is the longer pause and includes the change of ends.
- **P2.** The Normal dial's "every 3rd minor" counts every minor break of the fixture, hidden ones included. A hidden
  eligible break is not assigned and does not advance the rotation.
- **P3.** Assignment table: `sponsor_assignments`, keyed `(fixture_id, moment_id)`. It is written on the overlay read
  path when a served plan first hands a break its card. The heartbeat-fed `sponsor_airings` stays proof only.
- **P4.** Frames go in `sponsor_airing_frames (session_id, moment_id)`, so a frame that arrives before its airing row
  never races. The report left-joins it.
- **P5.** The scene carousel's moment id is `scene:<sceneId>:<floor(startedAtMs / 10 000)>`, so each 10 s showing has
  a distinct `(session_id, moment_id)`.
- **P6.** The heartbeat wire tags each item: `{ kind: "start", … } | { kind: "end", … }`.
- **P7.** Weighted rotation is smooth weighted round robin (nginx): each step adds every card's weight to its current
  score, picks the highest (ties to the earlier card in `resolveSponsors` order) and subtracts the total.

## Global Constraints

- **All 4 test types per task:** unit, E2E, smoke, regression. A task with no UI traces forward to the flow that
  exercises it. Every change ships a test that fails without it.
- **TEST-STRATEGY** (`docs/superpowers/TEST-STRATEGY.md`): sweeps report a count, and zero checked is a FAILURE.
  Expected values come from the engine's declarations (`naturalBreaks.kinds`, `SPONSOR_TIER_WEIGHTS`) or the
  rulebook, never from the code under test. Mutate each new guard once and name its killer. Test the sequence:
  a second call, an empty input, after a void or undo, and another sport.
- **i18n:** every user-facing string goes in all 4 `apps/web/src/dictionaries/{en,es,fr,nl}/ui.json`. A new key ⇒
  `npm run i18n:gen-keys`, then `npm run i18n:check`.
- **Mobile-first:** screenshots at 320 / 768 / 1280 with no horizontal page scroll, published as an Artifact page
  (no evidence PNGs in the repo). The 7-width `apps/web/e2e/mobile.spec.ts` matrix is the backstop. `/admin` is
  exempt (1280 only), and that includes the overlay gallery.
- **The frontend-design skill goes in every UI task's dispatch.** Mocks are layout only; the build uses the house
  theme. The hub and the report are mocked (`overview-report.html`), so they need no option round.
- **Agents:** TypeScript tasks (apps/web and packages/engine) use `implementer-sonnet`. SC1–SC2 (Rust) use
  `implementer` (Opus). Every task is reviewed by `reviewer` (Opus). Loop until the review is clean and the gate is
  green.
- **Verify, scoped only, never the full suite:**
  `cd <abs worktree>/apps/web && npx vitest run <paths> --reporter=json --outputFile=<scratch>/r4-<task>/r.json; echo EXIT=$?`.
  Then check `numPassedTests == numTotalTests > 0`, `EXIT=0`, and that `.testResults[].name` are this worktree's
  paths. For the engine, use `cd <abs worktree>/packages/engine && npx vitest run …` with the same checks. Also run
  `rtk proxy npm run typecheck --workspace <ws>`, `rtk proxy npx eslint --max-warnings 0 <changed files>` (read
  `✖ N problems`), and `npm run openapi:gen && git status --porcelain` (must be empty after) when a route changes.
  DB-backed tests need the local env from the `seazn-local-env` skill (`db:apply` + `sync:sports`).
- **E2E only by CI dispatch:** `gh workflow run e2e.yml --ref <branch> -f pr=<n>`. Never run Playwright or a server
  locally. Agents push, dispatch, then hand back.
- **Engine boundary:** a sport file makes no value import from `competition/`. Run `npm run engine:boundary`.
- **Migrations:** Flyway applies them strictly in order. origin/main ends at V477, and V478 is claimed twice (email
  outbox W5, `feat/youtube-connect` d10933ef44). Do not hardcode a number. Each migration task takes the next free V
  at build time after re-checking origin/main and open branches (`git log --all --grep='takes V'`), and commits
  `chore(r4): <task> takes V<n>`.
- **Branches:** each PR in its own worktree, rebased onto `main` before merge. Merge only on green CI and a clean
  review loop. Never `git stash`.
- **Pricing (D8):** no new gate. The existing `sponsors.tiers` and `sponsors.monetize` gates move with their tabs
  unchanged.

## Review Focus

1. **A re-poll writes nothing twice.** Every overlay poll can try to assign, OBS's included (2 s edge, many viewers).
   Two concurrent polls must leave one assignment per `(fixture_id, moment_id)` and one rotation position each. A
   poll with nothing new to assign takes no lock. Test in S5.
2. **The compositor sends `airings` before web accepts them.** A strict schema 400s every beat, and the session dies.
   SC1 ships behind web's deploy, and S8 has a contract test that the vendored fixture with `airings` parses.
3. **The frame lands before the airing row** (it is posted 1.5 s after `start`, and the row comes on the next 5 s
   beat). P4's separate table handles this. Test in S9.
4. **A sponsor deleted while assigned or aired.** Its assignment's `sponsor_id` goes null and the card drops from the
   plan. The airing keeps `sponsor_name`, and the report still renders. Tests in S5 and S14.
5. **A long sponsor name on a 320 px hub card and on a 1080 lower third.** Truncate with `min-w-0` on the whole chain,
   use a realistic 43-character name, and keep the readability floor. Tests in S7 and S13.

---

## File structure

New, under `apps/web/src/` unless noted:

| File | Responsibility |
|---|---|
| `packages/engine/src/sport/natural-breaks.ts` | `NaturalBreakDecl`, `NaturalBreaks<Ev, State>`, `reachableBreakKinds` sweep helper (testkit-safe). |
| `lib/sponsor-tiers.ts` | Client-safe `SPONSOR_TIERS`, `SponsorTier`, `SPONSOR_TIER_WEIGHTS`. |
| `lib/sponsor-plan.ts` | The pure planner and its constants and types. |
| `server/sponsors/card-source.ts` | `SponsorCardSource` and its `sponsors`-table implementation. |
| `server/sponsors/stream-settings.ts` | Read and write `sponsor_stream_settings` (competition row overrides the org row). |
| `server/sponsors/assign.ts` | Rotation lock, assignment read/write, `loadSponsorPlan`. |
| `server/sponsors/operator-log.ts` | `operatorLogFor` (S5 ships it reading nothing; console C3 makes it read the log table). |
| `server/sponsors/airings.ts` | Heartbeat ingestion, session-end close, frame store. |
| `server/sponsors/clicks.ts` | Click-tag parse and record. |
| `server/sponsors/report.ts` | Overview rows, report links, the public report. |
| `components/overlay/sponsor-card.tsx` | Lower third and banner card, plus `SponsorCarousel`. |
| `app/o/[orgSlug]/sponsors/page.tsx` | The hub (four tabs). |
| `components/sponsors/{overview-tab,on-stream-tab,share-report}.tsx` | Hub tab bodies. |
| `app/r/sponsor/[token]/page.tsx` | The public report. |
| `app/api/internal/relay/sessions/[sid]/airings/[momentId]/frame/route.ts` | Frame upload. |
| `app/api/v1/orgs/[id]/sponsor-stream-settings/route.ts` | PUT settings. |
| `app/api/v1/orgs/[id]/sponsors/[sponsorId]/report-links/route.ts`, `app/api/v1/orgs/[id]/sponsor-report-links/[linkId]/route.ts` | Create and revoke links. |

Modified: `packages/engine/src/sport/module.ts`, eight sport files, `server/overlay/{load,recent}.ts`,
`lib/overlay-recent-types.ts`, `lib/overlay-moments.ts`, `components/overlay/{moment-queue,use-moment-queue,template-registry,overlay-stage}.ts(x)`,
`server/api-v1/{schemas,openapi,key-scopes}.ts`, `docs/contracts/relay-job.v1.json` + fixtures,
`server/usecases/{stream-sessions,sponsors}.ts`, `app/s/[sponsorId]/route.ts`, `lib/supabase-storage.ts`,
`app/o/[orgSlug]/settings/page.tsx`, `components/nav.tsx`, `app/o/[orgSlug]/page.tsx`, the four `ui.json`,
`scripts/smoke.ts`.

---

# PR A — web core (`feat/r4-sponsors`)

### Task S1: Engine — the natural-break declaration, the sweep, and the team sports

**Files:**
- Create: `packages/engine/src/sport/natural-breaks.ts`; test `packages/engine/src/sport/natural-breaks.test.ts`
- Modify: `packages/engine/src/sport/module.ts` (optional member beside `abandonOptions?` :896); `sports/cricket/cricket.ts`, `sports/football/football.ts`, `sports/hockey/hockey.ts`, `sports/icehockey/icehockey.ts` (each sport's own file)

**Interfaces:**
- Produces:
```ts
export interface NaturalBreakDecl { kind: string; size: "minor" | "major" }
export interface NaturalBreaks<Ev, State> {
  kinds: readonly NaturalBreakDecl[];
  /** Pure. The kinds this event OPENS, given the state before and after it. [] for most events. P1: never a minor beside a major. */
  opensAt(ev: Ev, before: State, after: State): readonly string[];
}
// SportModule<Cfg, Ev, State>.naturalBreaks?: NaturalBreaks<Ev, State>
export function breakSizeOf(decl: NaturalBreaks<unknown, unknown>, kind: string): "minor" | "major";   // throws on an undeclared kind
```

- [ ] **Step 0: Verify the starting kinds against each sport's DOMAIN.md and its events** (spec §3.1: the kinds are a
  hypothesis). Record per sport which event and state change opens each kind. If a kind has no engine-visible
  trigger, drop it and note why in the commit body.
- [ ] **Step 1: Write the failing tests.**
```ts
it("every declared kind is reachable by a real event sequence (forEachSport)", () => {
  // drive each module's golden/simulation sequences through fold; collect opensAt output
  // report { modulesWithBreaks, kindsDeclared, kindsReached }; expect(modulesWithBreaks).toBeGreaterThan(0)
  // every module.naturalBreaks.kinds[i].kind ∈ reached; 0 checked ⇒ fail
});
it("opensAt returns only declared kinds, and never a minor beside a major (P1)", …);
it("an undo-restored state opens nothing: opensAt(ev, after, before) after an undo returns []", …);
it("boardgame, carrom and generic declare no naturalBreaks (the scene carousel is their path)", …);
it("cricket: the 6th legal ball of an over opens over_end; the innings' last ball opens innings_break and not over_end", …);
it("football: half_time at the end of period 1; after_goal on a goal; a goal that ends the half opens half_time only", …);
it("breakSizeOf throws on an undeclared kind", …);
```
- [ ] **Step 2:** Run the engine VERIFY → FAIL.
- [ ] **Step 3:** Add the type and the four team sports' declarations, each in its own sport file.
- [ ] **Step 4:** VERIFY green. `npm run engine:boundary` clean. **MUTATE** cricket's `opensAt` to return `[]` and
  name the sweep test that dies.
- [ ] **Step 5: Commit** `feat(engine): declared natural breaks, team sports`.

**Four types:** unit + regression (above); E2E through S15's `stream-overlay.spec.ts › sponsor lower third after a
cricket over`; smoke via S15's overlay smoke row.

### Task S2: Engine — natural breaks for the set-based sports

**Files:**
- Modify: `packages/engine/src/sports/setbased/{kernel,badminton,tabletennis,volleyball}.ts`, `sports/tennis/tennis.ts`
- Test: extend `packages/engine/src/sport/natural-breaks.test.ts`

**Interfaces:**
- Consumes: S1 `NaturalBreaks`.
- Produces: `naturalBreaks` on tennis, badminton, tabletennis, volleyball. If several share a rule, it lives in the
  kernel as `setBasedBreaks(…)`, and each sport file passes its own kinds.

- [ ] **Step 0:** Verify the kinds against `DOMAIN.badminton.md`, `DOMAIN.tabletennis.md`, `DOMAIN.volleyball.md` and
  tennis `DOMAIN.md`. Tennis `changeover` is after odd games, badminton `interval` at 11 in a game, and table-tennis
  and volleyball `timeout` only where a timeout event exists.
- [ ] **Step 1: Failing tests.**
```ts
it("tennis: a set-winning point opens ['set_end'] once, and not changeover (P1)", …);
it("tennis: a game ending on an odd game count opens changeover; on an even count, nothing", …);
it("badminton: reaching 11 in a game opens interval once (a re-poll fold of the same events does not open it twice)", …);
it("the S1 sweep now reports modulesWithBreaks === 8 and every declared kind reached", …); // 8 = spec §3.1
```
- [ ] **Step 2–4:** red → implement → green. **MUTATE** the P1 major-wins rule and name the killer.
- [ ] **Step 5: Commit** `feat(engine): natural breaks for set-based sports`.

**Four types:** unit + regression; E2E via S15's overlay spec (one set-based fixture); smoke via S15.

### Task S3: Schema — sponsor stream tables, and the client-safe tiers

**Files:**
- Create: `db/migration/deltas/V<next>__sponsors_on_stream.sql`, `apps/web/src/lib/sponsor-tiers.ts`
- Modify: `apps/web/src/server/usecases/sponsors.ts:41-42` (re-export tiers from the lib)
- Test: `apps/web/src/server/sponsors/__tests__/migration.test.ts`

**Interfaces:**
- Produces (tables later tasks rely on; RLS org-scoped as V283, `enable` + `force`):
  - `sponsors.on_stream boolean not null default false`.
  - `sponsor_stream_settings (id, org_id, competition_id null → competitions on delete cascade, enabled boolean not null default false, frequency text check in ('light','normal','busy') default 'normal', updated_by, updated_at)`, unique `(org_id, competition_id) nulls not distinct`.
  - `sponsor_assignments (fixture_id → fixtures cascade, moment_id text, org_id, seq int, sponsor_id null → sponsors set null, position int null, source text check in ('rotation','operator'), break_kind text, style text check in ('lower_third','banner'), hold_ms int, operator_choice_at timestamptz null, assigned_at)`, pk `(fixture_id, moment_id)`, unique `(org_id, position)` where position is not null, check `(source = 'rotation') = (position is not null)`.
  - `sponsor_airings (id, org_id, sponsor_id null → set null, sponsor_name text not null, fixture_id, session_id → fixture_stream_sessions, moment_id, source text check in ('rotation','scene','operator'), break_kind null, style, started_at, ended_at null, cut_short bool default false, skipped bool default false, ended_estimated bool default false)`, unique `(session_id, moment_id)`, index `(org_id, sponsor_id, started_at)`. **No `viewers`, `video_id` or `youtube_refreshed_at` (F6).**
  - `sponsor_airing_frames (session_id, moment_id, org_id, path text, created_at)`, pk `(session_id, moment_id)` (P4).
  - `sponsor_clicks (id, org_id, sponsor_id → sponsors cascade, fixture_id null → fixtures set null, source text check in ('match','stream','site','unknown'), at)`, index `(sponsor_id, at)`.
  - `sponsor_report_links (id, org_id, sponsor_id → sponsors cascade, competition_id null, from_date date, to_date date, token_hash bytea unique, created_by, created_at, revoked_at null)`, check `from_date <= to_date`.
  - `lib/sponsor-tiers.ts`: `SPONSOR_TIERS`, `SponsorTier`, `SPONSOR_TIER_WEIGHTS = { title: 3, gold: 2, silver: 1, partner: 1 }` (D9).

- [ ] **Step 0:** Load `supabase:supabase-postgres-best-practices`. Take the next free V (Global Constraints).
- [ ] **Step 1: Failing tests.**
```ts
it("an existing sponsor reads on_stream = false (greenfield, no backfill)", …);
it("one settings row per (org, null competition) and per (org, competition)", …);
it("a second assignment for the same (fixture, moment) is refused; two rotation rows of one org cannot share a position", …);
it("a rotation assignment without a position, or an operator one with a position, is refused", …);
it("a second airing for the same (session, moment) is refused", …);
it("deleting a sponsor sets the airing's and assignment's sponsor_id null and keeps sponsor_name; it deletes its clicks and links", …);
it("RLS: org B reads none of org A's rows in all six tables (count reported, 0 tables checked ⇒ fail)", …);
it("SPONSOR_TIERS equals the sponsors.tier check's set, read from information_schema (one authority)", …);
```
- [ ] **Step 2–4:** red → write the delta → `db:apply` + `sync:sports` → green. **MUTATE** the position check
  constraint (drop it) and name the killer.
- [ ] **Step 5: Commit** `feat(sponsors): stream tables` and then `chore(r4): S3 takes V<n>`.

**Four types:** unit/regression (above); E2E via S12/S15 (every hub flow writes these tables); smoke
`sponsors: settings PUT round-trips` (S12).

### Task S4: The pure planner

**Files:**
- Create: `apps/web/src/lib/sponsor-plan.ts`; test `apps/web/src/lib/__tests__/sponsor-plan.test.ts`

**Interfaces:**
- Consumes: S1/S2 `naturalBreaks` (tests only, for derived expectations); S3 `SponsorTier`, `SPONSOR_TIER_WEIGHTS`.
- Produces (these names are shared with the console plan; do not rename):
```ts
export type SponsorFrequency = "light" | "normal" | "busy";
export type SponsorStyle = "lower_third" | "banner";
export const SPONSOR_COOLDOWN_MS = 90_000;
export const NORMAL_MINOR_EVERY = 3;
export const SPONSOR_STYLE_BY_SIZE = { minor: { style: "lower_third", holdMs: 8_000 }, major: { style: "banner", holdMs: 15_000 } } as const;
export const SPONSOR_STALE_MS = 20_000;
export const SCENE_CAROUSEL_MS = 10_000;
export interface SponsorCard { id: string; sponsorId: string; name: string; logoUrl: string | null; tier: SponsorTier }
export interface SponsorPlanAiring { momentId: string; seq: number; cardId: string; style: SponsorStyle; holdMs: number; breakKind: string }
export type SponsorPlan = { cards: SponsorCard[]; airings: SponsorPlanAiring[] } | null;   // spec §3.2, exact
export interface BreakOpened { seq: number; at: string; kind: string; size: "minor" | "major" }
export interface SponsorAssignment { momentId: string; seq: number; sponsorId: string | null; position: number | null;
  source: "rotation" | "operator"; breakKind: string; style: SponsorStyle; holdMs: number; operatorChoiceAt: string | null }
export type OperatorLogField = "scene" | "graphics_hidden" | "next_sponsor_id" | "skip_moment_id";
export interface OperatorLogEntry { at: string; field: OperatorLogField; value: string | boolean | null }
export interface PlanInput {
  breaks: readonly BreakOpened[];          // the whole fixture, undone events excluded, ascending seq
  windowSeqs: readonly number[];           // the `recent` window
  settings: { enabled: boolean; frequency: SponsorFrequency } | null;
  cards: readonly SponsorCard[];           // ticked, in resolveSponsors order
  assigned: readonly SponsorAssignment[];  // this fixture's persisted (frozen) assignments
  operatorLog: readonly OperatorLogEntry[];
  nextPosition: number;                    // the org's next free rotation position (max + 1, F9)
}
export function sponsorMomentId(seq: number, breakKind: string): string;            // `${seq}:sponsor.${breakKind}`
export function weightedCycle(cards: readonly SponsorCard[]): string[];             // P7, one full cycle of card ids
export function eligibleBreaks(breaks: readonly BreakOpened[], f: SponsorFrequency): BreakOpened[];   // dial only; P2
export function graphicsHiddenAt(log: readonly OperatorLogEntry[], at: string): boolean;
export function playNextChoiceAt(log: readonly OperatorLogEntry[], at: string): { sponsorId: string; setAt: string } | null;
export function planSponsors(i: PlanInput): { plan: SponsorPlan; newAssignments: SponsorAssignment[] };
```
- Rules (spec §3.2): Light = every major. Normal = every major + every 3rd minor. Busy = every major + every minor.
  A 90 s cooldown applies between assigned cards (event `at`). A frozen assignment wins over everything. A hidden
  break is not assigned, and its position is not consumed. A pending play-next choice (set before the break's `at`
  and not consumed by an earlier live operator assignment with the same `operatorChoiceAt`) takes the next eligible
  break with `source: "operator"`, `position: null`. The rotation picks `weightedCycle(cards)[position % length]`.
  A card no longer ticked is skipped at its position. `plan.airings` holds the window's assigned breaks only.
  `plan` is null when settings are null or disabled, or when no card is ticked.

- [ ] **Step 1: Failing tests.** Expectations come from `module.naturalBreaks.kinds` sizes and `SPONSOR_TIER_WEIGHTS`,
  never a typed table.
```ts
it("each dial × each declaring sport: eligible count matches the size-derived rule (counts reported, 0 ⇒ fail)", …);
it("cooldown: two minors 60 s apart on Busy assign only the first; 91 s apart assign both", …);
it("tier weights over 30 breaks with title+gold+silver ticked: 15 / 10 / 5 (derived from SPONSOR_TIER_WEIGHTS)", …);
it("weightedCycle(title, gold, silver) is one cycle of length Σ weights, and each card appears weight times", …);
it("a re-plan with the same inputs plus its own newAssignments returns the same plan and no newAssignments", …);
it("an undone break event is absent from breaks ⇒ its unaired moment leaves plan.airings", …);
it("a sponsor unticked mid-match: frozen breaks keep it; later breaks never pick it", …);
it("a break-less sport (generic) plans airings: [] and plan non-null when enabled", …);
it("frozen sequence: dial change, then tick/untick and a tier change — every earlier assignment keeps its sponsor; only later breaks move", …);
it("a break opened while graphicsHiddenAt is true is not assigned and nextPosition is not consumed (the sponsor keeps its turn)", …);
it("play next takes exactly one eligible break as operator, position null; the rotation's next sponsor is next after it", …);
it("play next chosen again before the break replaces the first choice", …);
it("empty: settings null ⇒ null; no ticked card ⇒ null; enabled + ticked + no breaks ⇒ airings []", …);
```
- [ ] **Step 2–4:** red → implement → green. **MUTATE** (a) the frozen-set read (ignore `assigned`) and (b) the
  hidden guard, one at a time, and name the killers.
- [ ] **Step 5: Commit** `feat(sponsors): pure sponsor planner`.

**Four types:** unit + regression; E2E via S12's preview strip and S15's overlay spec; smoke via S15.

### Task S5: Breaks in the fold, assignments, and `sponsorPlan` in the overlay answer

**Files:**
- Modify: `apps/web/src/server/overlay/recent.ts` (`replayDerived` :423 also emits the whole fixture's `BreakOpened[]`), `server/overlay/load.ts` (`CachedOverlay` gains `breaks`; bump the cache keys to `overlay-fold-v5` / `overlay-fold-relay-v5`; `loadOverlayLiveData` :259 adds `sponsorPlan`), `lib/overlay-recent-types.ts:78` (`RecentDerived.naturalBreaks?: string[]`), `server/api-v1/schemas.ts` (overlay answer schema)
- Create: `server/sponsors/{card-source,stream-settings,assign,operator-log}.ts`
- Test: `server/sponsors/__tests__/assign.test.ts`, `server/overlay/__tests__/load-sponsor-plan.test.ts`

**Interfaces:**
- Consumes: S4 `planSponsors`, `PlanInput`, `SponsorAssignment`, `OperatorLogEntry`; S3 tables.
- Produces:
```ts
// card-source.ts
export interface SponsorCardSource { cardsFor(orgId: string, fixture: { competitionId: string | null }): Promise<SponsorCard[]> }
export const sponsorsTableCardSource: SponsorCardSource;   // active, on_stream = true, resolveSponsors order
// stream-settings.ts
export async function resolveStreamSettings(exec: Tx | typeof sql, orgId: string, competitionId: string | null): Promise<{ enabled: boolean; frequency: SponsorFrequency } | null>;
export async function putStreamSettings(auth: AuthCtx, orgId: string, b: { competitionId: string | null; enabled: boolean; frequency: SponsorFrequency }): Promise<void>;
// operator-log.ts — CROSS-PLAN SEAM: returns [] until console C3 makes it read fixture_stream_operator_log
export async function operatorLogFor(exec: Tx | typeof sql, fixtureId: string): Promise<OperatorLogEntry[]>;
// assign.ts
export function sponsorRotationLockKey(orgId: string): string;   // `sponsor-rotation-org:${orgId.toLowerCase()}`
export async function lockSponsorRotation(tx: Tx, orgId: string): Promise<void>;
export async function loadSponsorPlan(a: { fixtureId: string; orgId: string; competitionId: string | null; breaks: readonly BreakOpened[]; windowSeqs: readonly number[] },
  deps?: { source?: SponsorCardSource }): Promise<SponsorPlan>;
// OverlayLiveData.sponsorPlan: SponsorPlan
```
- Flow: plan read-only first. Only when `newAssignments` is non-empty, or an unaired assignment's seq is no longer in
  `breaks`, open a tx: take `lockSponsorRotation`, re-read the assigned set and `max(position)`, re-plan, then
  `insert … on conflict do nothing` the new rows (rotation positions from `max + 1`) and delete undone unaired rows (no
  `sponsor_airings` row for that moment). Commit, then return the plan. The sponsor plan is read outside the fold
  cache: the fold is per `last_seq`, the settings are not.

- [ ] **Step 1: Failing tests (DB-backed).**
```ts
it("two matches back to back continue one org cycle (D14): match 2's first rotation break takes position = match 1's last + 1", …);
it("two concurrent fixtures assigning at once get distinct positions (Promise.all, both commit)", …);
it("on Light, a T20's single innings break goes to a different sponsor in match 2 than in match 1 (cards: title + gold)", …);   // D14's own example
it("two concurrent polls of one fixture leave exactly one assignment per moment", …);   // Review Focus 1
it("a poll with nothing new to assign takes no lock (the lock key is never requested)", …);
it("a deleted sponsor's assignment drops from cards and airings; the others keep their positions", …);   // Review Focus 4
it("an undone break's unaired assignment is deleted; an aired one is kept", …);
it("the competition settings row overrides the org row; with no competition row the org row applies; neither ⇒ null", …);
it("OBS (public) and relay answers carry an identical sponsorPlan for one fixture", …);
it("operatorLogFor returns [] (S5) — replaced by console C3; this test is rewritten there", …);
```
- [ ] **Step 2–4:** red → implement → green → `openapi:gen` drift empty. **MUTATE** the "nothing new ⇒ no lock" branch
  (always lock) and name the killer.
- [ ] **Step 5: Commit** `feat(sponsors): assignments and sponsorPlan in the overlay answer`.

**Four types:** unit + regression (above); E2E via S15's overlay spec; smoke `overlay: sponsorPlan present on a seeded
live fixture with a ticked sponsor` (scripts/smoke.ts).

### Task S6: Queue priority and sponsor moments

**Files:**
- Modify: `apps/web/src/lib/overlay-moments.ts` (`OverlayMoment.graphic` gains `"sponsor"`, plus `priority`, `holdMs?` and `sponsor?: { cardId; style; breakKind }`; `sponsorMoments(plan)`), `components/overlay/moment-queue.ts`
- Test: `components/overlay/__tests__/moment-queue-sponsor.test.ts`, `lib/__tests__/overlay-moments-sponsor.test.ts`

**Interfaces:**
- Consumes: S4 `SponsorPlan`, `SPONSOR_STALE_MS`.
- Produces:
```ts
export type MomentPriority = "score" | "sponsor";
export function sponsorMoments(plan: SponsorPlan, at: (seq: number) => string): OverlayMoment[];  // kind `sponsor.${breakKind}`, so momentIdOf === sponsorMomentId
// QueueAction gains:  | { type: "skip"; momentId: string; now: number; foldMs: number }   (used by console C4)
// MomentQueueState gains: cutShort: string[]   // ids folded early by a score moment or a skip; read by S7's end line
```
- Rules: a score moment enqueued while a sponsor moment is queued goes ahead of it. A score moment at the same `seq`
  always precedes the sponsor card (cricket `endOfOver`, a goal's slab, a set-won slab). A score moment arriving while
  a sponsor card is on air sends it to `out` and records it in `cutShort`. A sponsor moment queued longer than 20 s is
  dropped and marked seen. A per-moment `holdMs` overrides the action's. `discard` and `flush` treat sponsor moments
  like any other.

- [ ] **Step 1: Failing tests.**
```ts
it("a score moment enqueued behind a queued sponsor card airs first", …);
it("a score moment while a sponsor card holds sends it to out, and cutShort contains its id", …);
it("a sponsor moment queued > SPONSOR_STALE_MS is dropped and seen; at exactly 20 000 ms it still airs", …);
it("cricket over end: the real endOfOver moment (built by overlay-moments from a real over's events) airs before the over_end sponsor card, and their hold windows never overlap", …);
it("a sponsor moment holds SPONSOR_STYLE_BY_SIZE[size].holdMs, not the action holdMs", …);
it("Final discard marks sponsor moments seen; reduced motion (foldMs 0) still promotes the next", …);
it("skip folds only the named moment (on air → out + cutShort; queued → removed + seen)", …);
it("sponsorMoments(null) is []; momentIdOf(sponsor moment) === sponsorMomentId(seq, kind)", …);
```
- [ ] **Step 2–4:** red → implement → green. **MUTATE** the pre-empt guard (`return false`) and name the killer.
- [ ] **Step 5: Commit** `feat(overlay): sponsor moments and score-first priority`.

**Four types:** unit + regression; E2E via S15 (`cooldown honoured`, `score cuts a sponsor card`); smoke via S15.

### Task S7: Slots, the sponsor card, the scene carousel, and proof-of-play lines

**Files:**
- Modify: `components/overlay/template-registry.ts` (`OverlayTemplateDef.sponsorSlots`), `components/overlay/overlay-stage.tsx`, `components/overlay/use-moment-queue.ts` (emit the lines), `lib/overlay-compositor.ts` (signal names), `components/overlay/gallery-matrix.ts`, `e2e/overlay-gallery.spec.ts`, `e2e/overlay-readability.capture.ts`, the four `ui.json`
- Create: `components/overlay/sponsor-card.tsx`
- Test: `components/overlay/__tests__/sponsor-slots.test.ts`, `components/overlay/__tests__/sponsor-signals.test.ts`

**Interfaces:**
- Consumes: S6 moments and `cutShort`; S4 `SCENE_CAROUSEL_MS`, `SponsorCard`.
- Produces:
```ts
// OverlayTemplateDef.sponsorSlots: { lower_third: CanvasBox; banner: CanvasBox }   — bar and bug declare both
export const SIGNAL_SPONSOR_START = "seazn:sponsor:start";   // + JSON {momentId, cardId, style, source, breakKind, at}
export const SIGNAL_SPONSOR_END = "seazn:sponsor:end";       // + JSON {momentId, at, cutShort}
export const SPONSOR_LINE_MAX_BYTES = 512;
export function sponsorLine(kind: "start" | "end", body: object): string;   // throws past 512 bytes
export function carouselOrder(cards: readonly SponsorCard[]): SponsorCard[];  // title, then gold, then the rest, resolve order kept within a tier
export function carouselMomentId(scene: string, startedAtMs: number): string; // P5
export function SponsorCarousel(p: { cards: readonly SponsorCard[]; scene: string; host: "compositor" | null }): JSX.Element | null;
export function SponsorCardView(p: { card: SponsorCard; style: SponsorStyle; clickUrl: string; phase: Phase }): JSX.Element;
```
- The card shows the logo, the name and the on-screen `/s/<sponsorId>?f=<fixtureId>&src=stream` link text (S10).
  The carousel mounts on the compositor's Starting soon and Reconnecting scenes (the console adds Break and Full
  time), and each 10 s showing logs `source: "scene"`. Lines are logged only at `host=compositor`.

- [ ] **Step 1: Failing tests.**
```ts
it("every registry entry declares both slots, each disjoint from its sceneCardSafeArea (count reported, 0 ⇒ fail)", …);
it("every slot box lies inside the 1920×1080 canvas", …);
it("sponsorLine: a 513-byte body throws; keys are exactly the spec's", …);
it("host=compositor: hold → one start line; out → one end line with cutShort from the queue state; no host → no lines", …);
it("carouselOrder puts title then gold first (derived from SPONSOR_TIERS order)", …);
it("carouselMomentId differs for two showings 10 s apart and is equal within one", …);
```
- [ ] **Step 2–4:** red → implement → green. Extend the staff gallery (1280 only) to template × sport × slot, and the
  readability sweep (30 px floor at 1080, bar bottom ≥ 150 px) to sponsor cards with a reported count. Use a
  43-character sponsor name. **MUTATE** the `host` check on the lines and name the killer.
- [ ] **Step 5:** Dispatch CI e2e for `overlay-gallery.spec.ts`. Publish 1280 captures as an Artifact page.
- [ ] **Step 6: Commit** `feat(overlay): sponsor slots, card, carousel and proof-of-play lines`.

**Four types:** unit + regression; E2E `overlay-gallery.spec.ts › sponsor slots` and the readability capture; smoke via
S15.

### Task S8: Heartbeat contract and airing ingestion

**Files:**
- Modify: `server/api-v1/schemas.ts` (`RelayHeartbeat` :2018 gains `airings`, `airingsDropped`), `docs/contracts/relay-job.v1.json`, `docs/contracts/fixtures/relay-job.v1/` (+ `heartbeat-airings.json`, `heartbeat-invalid-airing-unknown-key.json`), `server/usecases/stream-sessions.ts` (`heartbeat` :2661 calls `recordAirings`; session end calls `closeOpenAirings`), `server/relay/sanitise.ts` (the airing list is not copied into sample `raw`)
- Create: `server/sponsors/airings.ts`
- Test: `server/sponsors/__tests__/airings.test.ts`, `server/api-v1/__tests__/relay-contract.test.ts` (extend)

**Interfaces:**
- Consumes: S3 `sponsor_airings`, `sponsor_assignments`; S7 line bodies.
- Produces (P6):
```ts
export const RelayAiring = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("start"), momentId: z.string().max(80), cardId: z.string().max(80), style: z.enum(["lower_third", "banner"]),
             source: z.enum(["rotation", "scene", "operator"]), breakKind: z.string().max(40).nullable(), at: z.string().datetime() }).strict(),
  z.object({ kind: z.literal("end"), momentId: z.string().max(80), at: z.string().datetime(), cutShort: z.boolean() }).strict(),
]);
// RelayHeartbeat: airings: z.array(RelayAiring).max(64).nullish(), airingsDropped: z.number().int().min(0).nullish()
export const AIRING_CLOCK_SKEW_MS = 600_000;   // 10 min (spec §3.6.4)
export async function recordAirings(tx: Tx, s: { sessionId: string; orgId: string; fixtureId: string }, items: readonly RelayAiring[], now: Date): Promise<{ written: number; refused: number }>;
export async function closeOpenAirings(tx: Tx, sessionId: string, lastBeatAt: Date): Promise<number>;   // ended_estimated = true
// CROSS-PLAN SEAM for console C3: recordAirings sets skipped from operatorLogFor (S5); S8 ships it false
```
- `start` upserts on `(session_id, moment_id)`. The sponsor id comes from the fixture's assignment, or from the card id
  for `scene`, and `sponsor_name` is snapshotted. `end` sets `ended_at` and `cut_short`. Items more than 10 min off
  server time are refused and counted.

- [ ] **Step 1: Failing tests.**
```ts
it("the vendored fixture heartbeat-airings.json parses; an airing with an unknown key is refused (strict)", …);   // Review Focus 2
it("start then end on two beats → one row, ended_at set, cut_short as sent", …);
it("the same start re-sent (a lost 2xx) upserts, no duplicate", …);
it("an item 10 min + 1 s off server time is refused; 10 min − 1 s is written", …);
it("session end with an open airing closes it at the last beat and flags ended_estimated", …);
it("a scene airing names its card's sponsor, source 'scene', break_kind null", …);
it("a sponsor deleted before its start line lands still writes the row with sponsor_name and sponsor_id null", …);
it("airings never appear in the stored sample raw", …);
```
- [ ] **Step 2–4:** red → implement → green → `openapi:gen` drift empty. **MUTATE** the skew guard and name the killer.
- [ ] **Step 5: Commit** `feat(sponsors): heartbeat airings contract and ingestion`.

**Four types:** unit + regression; E2E via S15's seam (`overlay-compositor.spec.ts`); smoke `relay: heartbeat with
airings answers 200` (scripts/smoke.ts).

### Task S9: The frame endpoint

**Files:**
- Create: `app/api/internal/relay/sessions/[sid]/airings/[momentId]/frame/route.ts`
- Modify: `server/sponsors/airings.ts` (`storeAiringFrame`), `lib/supabase-storage.ts` (`putStorageObject`, `signedReadUrl`; private path `sponsor-frames/<orgId>/<sessionId>/<momentId>.jpg`)
- Test: `server/sponsors/__tests__/frame.test.ts`, the route test

**Interfaces:**
- Produces: `POST …/frame` with body `image/jpeg` ≤ 256 KiB and the session bearer, answering 204.
  `storeAiringFrame(sessionId: string, token: string, momentId: string, bytes: Uint8Array): Promise<void>`.
  `signedReadUrl(path: string, ttlSec: number): Promise<string>` (S14 uses it).
- [ ] **Step 1: Failing tests.**
```ts
it("a frame posted before its airing row exists is stored; the report join finds it once the row lands", …);   // Review Focus 3
it("another session's token → 401 (the relay verifier's, as the heartbeat), nothing stored", …);
it("a non-JPEG body (bad magic bytes) or > 256 KiB → 413/415", …);
it("a second frame for the same moment replaces the path, one row", …);
```
- [ ] **Step 2–4:** red → implement → green. **MUTATE** the token check and name the killer.
- [ ] **Step 5: Commit** `feat(sponsors): airing frame upload`.

**Four types:** unit + regression; E2E via S14 (the report shows a seeded frame); smoke `relay: frame with a bad token
→ 401`.

### Task S10: Click attribution

**Files:**
- Modify: `app/s/[sponsorId]/route.ts`, `components/public-site/sponsors-board.tsx:76` (a `clickTag` prop: `src=site`
  on the competition page, `f=<fixtureId>&src=match` on the match page; F3),
  `app/(public)/shared/[orgSlug]/[competitionSlug]/[divisionSlug]/fixtures/[fixtureId]/page.tsx` (mount the board with
  `resolveSponsors(org.id, competition.id)`, the competition page's own call; nothing rendered when it is empty)
- Create: `server/sponsors/clicks.ts`
- Test: `app/s/[sponsorId]/__tests__/route.test.ts`, `server/sponsors/__tests__/clicks.test.ts`

**Interfaces:**
- Produces:
```ts
export const CLICK_SOURCES = ["match", "stream", "site", "unknown"] as const;
export function parseClickTag(q: URLSearchParams): { fixtureId: string | null; source: (typeof CLICK_SOURCES)[number] };
export async function recordClick(sponsorId: string, tag: { fixtureId: string | null; source: string }): Promise<void>;  // fixture outside the sponsor's org ⇒ fixtureId null, source unknown
export function streamClickPath(sponsorId: string, fixtureId: string): string;   // `/s/${sponsorId}?f=${fixtureId}&src=stream` (S7's card)
```
- [ ] **Step 1: Failing tests.**
```ts
it("?f=<own-org fixture>&src=stream → 302 to the url, click_count + 1, one sponsor_clicks row {fixture, 'stream'}", …);
it("a fixture of another org → row with fixture null, source 'unknown'; still 302", …);
it("src=bogus → 'unknown'; no query → 'unknown', fixture null", …);
it("an inactive sponsor → 404, no row (unchanged)", …);
it("sponsors-board links carry src=site on the competition page", …);
it("the match page renders the board with links ?f=<that fixture>&src=match", …);   // anchor on `="`, AGENTS.md
it("the match page renders no board when the competition has no active sponsors", …);
```
- [ ] **Step 2–4:** red → implement → green. **MUTATE** the org check on `f` and name the killer.
- [ ] **Step 5: Commit** `feat(sponsors): tagged click attribution`.

**Four types:** unit + regression; E2E `sponsors-hub.spec.ts › a stream click counts` (S13) and
`public-fixture.spec.ts › the match page sponsor board counts a click for that match` (all 7 widths; frontend-design
skill; house theme; no horizontal scroll at 320); smoke
`/s/[id]?f=&src= records a click row and still redirects` (spec §7).

### Task S11: The Sponsors hub shell, the moves, and the nav

**Files:**
- Create: `app/o/[orgSlug]/sponsors/page.tsx` (tabs Overview · Sponsors · On stream · Packages and orders, default Overview)
- Modify: `app/o/[orgSlug]/settings/page.tsx` (drop the tab, :176-185 and :453-475; `?tab=sponsors` redirects to `sponsors?tab=sponsors`), `components/nav.tsx` (Sponsors link `hidden min-[350px]:flex`, the :234 precedent), `app/o/[orgSlug]/page.tsx` (a Sponsors entry at every width), the four `ui.json`, `e2e/mobile.spec.ts`
- Test: `app/o/[orgSlug]/sponsors/__tests__/page.test.tsx`, `components/__tests__/nav-sponsors.test.tsx`

**Interfaces:**
- Consumes: `OrgSponsors`, `SponsorPackages` (moved, unchanged), `listSponsorRows`, `hasFeatureOnAnyPass` (gates unchanged).
- Produces: `SPONSORS_TABS = ["overview", "sponsors", "on_stream", "packages"] as const` and `sponsorsHref(orgSlug, tab?)`.

- [ ] **Step 1: Failing tests.**
```ts
it("no tab ⇒ Overview; an unknown tab ⇒ Overview", …);
it("settings?tab=sponsors redirects (307/308) to sponsors?tab=sponsors", …);
it("a non-editor gets the same refusal Settings → Sponsors gave (canEdit reused)", …);
it("the Sponsors and Packages tabs keep their sponsors.tiers / sponsors.monetize gates (granted AND denied render)", …);
it("nav: the Sponsors link class anchors on `\\shidden min-[350px]:flex\"`; the dashboard entry has no hidden class", …);
```
- [ ] **Step 2–4:** red → implement (frontend-design, house theme, layout per mock) → green. Add the Sponsors link to
  `mobile.spec.ts`'s overflow scan, and measure the dual-role 5-link case at 350+. If it overflows, Player home folds
  first (spec §6.1).
- [ ] **Step 5:** Dispatch CI e2e (`mobile.spec.ts`, the whole file, never `-g`). Publish 320/768/1280 shots as an
  Artifact page.
- [ ] **Step 6: Commit** `feat(sponsors): top-level Sponsors hub`.

**Four types:** unit + regression; E2E `mobile.spec.ts` (7 widths) and `sponsors-hub.spec.ts › tabs`; smoke
`sponsors hub answers 200 for an editor`.

### Task S12: The On stream tab

**Files:**
- Create: `components/sponsors/on-stream-tab.tsx`, `app/api/v1/orgs/[id]/sponsor-stream-settings/route.ts`
- Modify: `app/api/v1/orgs/[id]/sponsors/[sponsorId]/route.ts` + `usecases/sponsors.ts` `patchSponsor` :191 (accept `onStream`), `server/api-v1/{schemas,openapi,key-scopes}.ts`, the four `ui.json`
- Test: `components/sponsors/__tests__/on-stream-tab.test.tsx`, the route test, `e2e/sponsors-hub.spec.ts`

**Interfaces:**
- Consumes: S4 `planSponsors`, `eligibleBreaks`, `SPONSOR_STYLE_BY_SIZE`; S5 `putStreamSettings`,
  `resolveStreamSettings`; engine `naturalBreaks`.
- Produces: `PUT /orgs/{id}/sponsor-stream-settings` `{ competitionId: string | null; enabled: boolean; frequency }`.
  `PATCH /orgs/{id}/sponsors/{sponsorId}` accepts `onStream: boolean`.
  `previewForSport(sportKey: string, f: SponsorFrequency, cards: SponsorCard[]): { breaks: number; cards: number }`
  runs the same pure planner over the module's own sample events.
- UI: the rotation checklist (tier shown), the Light / Normal / Busy dial (a new sponsor opens ticked at **Normal**,
  D12), "Where" as text (short breaks → lower third, intervals → banner), the competition scope picker, and one
  preview strip per sport the org plays. No "Add a deal".
- [ ] **Step 1: Failing tests.**
```ts
it("the dial opens at the stored frequency; with no row it opens at Normal (D12)", …);   // pin the seeded value
it("preview: for cricket on Light, the strip's break count equals the module's major breaks over its sample", …);   // derived from kinds
it("a scorer → 403; another org → 404; an unknown frequency → 400", …);
it("the competition picker writes a competition row; clearing it writes the org row", …);
it("generic shows 'sponsors appear on scene screens' instead of a strip (no declared breaks)", …);
```
- [ ] **Step 2–4:** red → implement (frontend-design) → green → `openapi:gen` drift empty. **MUTATE** the frequency
  enum check and name the killer.
- [ ] **Step 5:** CI e2e `sponsors-hub.spec.ts › on stream` at 320/768/1280. Artifact page.
- [ ] **Step 6: Commit** `feat(sponsors): On stream tab`.

**Four types:** unit + regression; E2E as above; smoke `sponsors: settings PUT round-trips`.

### Task S13: Overview and Share report

**Files:**
- Create: `server/sponsors/report.ts` (overview and links), `components/sponsors/{overview-tab,share-report}.tsx`, the two link routes
- Modify: `server/api-v1/{schemas,openapi,key-scopes}.ts`, the four `ui.json`
- Test: `server/sponsors/__tests__/report-overview.test.ts`, `server/sponsors/__tests__/report-links.test.ts`

**Interfaces:**
- Produces:
```ts
export type SponsorPeriod = { kind: "this_year" } | { kind: "last_30_days" } | { kind: "competition"; competitionId: string };
export interface SponsorOverviewRow { sponsorId: string; name: string; timesShown: number; onScreenMs: number;
  viewerImpressions: number | null; peakViewers: number | null; linkClicks: number }
export async function sponsorOverview(auth: AuthCtx, orgId: string, p: SponsorPeriod, now: Date): Promise<SponsorOverviewRow[]>;
export async function createReportLink(auth: AuthCtx, orgId: string, a: { sponsorId: string; competitionId: string | null; from: string; to: string }): Promise<{ id: string; url: string }>;  // url shown once
export async function revokeReportLink(auth: AuthCtx, orgId: string, linkId: string): Promise<void>;
export function hashReportToken(token: string): Buffer;   // sha256; the token is 32 random bytes, base64url
```
- `viewerImpressions` and `peakViewers` are null in PR A (shown as a dash). Y1 fills them. On screen is
  Σ(`ended_at − started_at`) over closed airings, and skipped-before-start never exists. Times shown counts airings,
  scene airings included.
- [ ] **Step 1: Failing tests.**
```ts
it("overview sums seeded airings: count, Σ duration, clicks in period only (a click a day before the period excluded)", …);
it("viewer impressions are null ⇒ the card shows a dash, not 0", …);
it("a deleted sponsor's airings still appear under sponsor_name", …);   // Review Focus 4
it("createReportLink returns a url whose token hashes to the stored hash; the raw token is never in the row or any log line", …);
it("a second revoke is a no-op 404; org B cannot revoke org A's link", …);
it("empty: no airings ⇒ every sponsor row reads zeros and a dash, and no sponsor ⇒ the empty state", …);
```
- [ ] **Step 2–4:** red → implement (frontend-design; phone shows one card per sponsor, per mock; 43-character name
  truncates) → green → drift empty. **MUTATE** the period lower bound and name the killer.
- [ ] **Step 5:** CI e2e `sponsors-hub.spec.ts › overview + share` at 320/768/1280. Artifact page.
- [ ] **Step 6: Commit** `feat(sponsors): overview and shareable report links`.

**Four types:** unit + regression; E2E as above; smoke `sponsors: create link then revoke`.

### Task S14: The public report page

**Files:**
- Create: `app/r/sponsor/[token]/page.tsx`
- Modify: `server/sponsors/report.ts` (`sponsorReport`), the four `ui.json`
- Test: `server/sponsors/__tests__/report-public.test.ts`, `e2e/sponsor-report.spec.ts`

**Interfaces:**
- Consumes: S13 `hashReportToken`; S9 `signedReadUrl`; `publicRateLimit` (`usecases/public.ts:85`).
- Produces:
```ts
export interface SponsorReportShowing { airingId: string; startedAt: string; onScreenMs: number; fixtureLabel: string; breakKind: string | null;
  frameUrl: string | null; viewers: number | null; watchUrl: string | null }   // watchUrl null in PR A (Y2)
export interface SponsorReport { sponsor: { name: string; logoUrl: string | null }; period: { from: string; to: string };
  competition: string | null; onScreenMs: number; viewerImpressions: number | null; streamVisits: number; showings: SponsorReportShowing[] }
export async function sponsorReport(token: string, now: Date): Promise<SponsorReport | null>;   // null ⇒ opaque 404
```
- The page is sponsor-branded (logo and name lead), with three numbers (on screen · viewer impressions · visits from
  the stream, i.e. clicks with `src=stream`), the showings (frame or a neutral placeholder, match, break), and the
  footnote "composed streams" / "viewer numbers from YouTube". It is `noindex`, rate-limited, and print-friendly.
- [ ] **Step 1: Failing tests.**
```ts
it("an unknown token, a revoked token and a malformed token all → the same 404 body", …);
it("only airings inside [from_date, to_date] and the link's competition (when set) are shown", …);
it("streamVisits counts src=stream clicks only", …);
it("a showing with no frame renders the placeholder; frameUrl is a signed URL, never the storage path", …);
it("robots meta is noindex; the page renders with no session cookie", …);
```
- [ ] **Step 2–4:** red → implement (frontend-design, house theme, mock layout) → green.
- [ ] **Step 5:** CI e2e `sponsor-report.spec.ts` (opens without login, 404 after revoke, 320/768/1280, no horizontal
  scroll). Artifact page.
- [ ] **Step 6: Commit** `feat(sponsors): public sponsor report page`.

**Four types:** unit + regression; E2E as above; smoke `the report renders a seeded airing` (spec §7).

### Task S15: The seam, driven for real, plus the overlay E2E and the stg check

**Files:**
- Test: `server/sponsors/__tests__/seam.test.ts`; extend `e2e/stream-overlay.spec.ts`, `e2e/overlay-compositor.spec.ts`; `scripts/smoke.ts`

**Interfaces:**
- Consumes: S1–S14 (no new production code; a defect found here is fixed in its owning task's files and reviewed).

- [ ] **Step 1: The seam test (failure class 1).** Seed a cricket fixture, tick two sponsors, set Busy, and record a
  real over through the engine. Read the real `loadOverlayLiveData`. Fold its `sponsorPlan` through the real
  `sponsorMoments` and `momentQueueReducer` and the real `sponsorLine` builder. Wrap the lines as a real
  `RelayHeartbeat` body, parse it with the real schema, pass it to the real `heartbeat` usecase, then read the
  `sponsor_airings` row back. Assert the sponsor, style `lower_third`, hold 8 000 ms and `break_kind` `over_end`, all
  derived from the declarations.
- [ ] **Step 2: E2E (CI dispatch).** In `stream-overlay.spec.ts` (no host = OBS, F4): a lower third shows after a
  cricket over; a second over inside 90 s shows none (cooldown); a set-based fixture shows a banner at `set_end`. In
  `overlay-compositor.spec.ts`: a start and an end line appear in the console capture. Run whole files.
- [ ] **Step 3: Smoke rows** listed in S5, S8, S9, S10, S12, S13 and S14, all present in `scripts/smoke.ts`, then run
  the scoped smoke.
- [ ] **Step 4: Walkthrough + stg live check (with the owner).** Run one composed match. Read the airing rows and
  frames back. Measure the frame-grab CPU (SC2) p95 on stg; a measurable rise goes to the owner.
- [ ] **Step 5: Commit** `test(sponsors): real seam, overlay e2e, smoke`. Push, open PR A, dispatch e2e, hand back.

---

# PR C — compositor (`seazn.club.compositor`, branch `feat/sponsor-airings`; agent `implementer`, Opus)

### Task SC1: Sponsor lines, the bounded buffer, and the heartbeat field

**Files:**
- Modify: `crates/adapters/src/cef_graphics.rs` (`page_signal` :220-230: parse `seazn:sponsor:start|end`), `crates/adapters/src/control_http.rs` (`heartbeat_wire` :146 adds `airings`, `airingsDropped`), `crates/domain/src/health.rs` (the buffer), `contracts/relay-job.v1.json` + `contracts/VENDORED.json` (re-vendor from web's S8 commit)
- Test: `crates/adapters/tests/contract.rs`, a new `crates/domain/src/airings.rs` with unit tests

**Interfaces:**
- Consumes: S8 `RelayAiring` wire shape (P6), `SPONSOR_LINE_MAX_BYTES = 512`.
- Produces: `pub enum AiringLine { Start{…}, End{…} }`, `pub fn parse_sponsor_line(s: &str) -> Result<AiringLine, LineRefusal>`,
  `pub struct AiringBuffer { cap: 64, dropped: u32 }` with `push`, `take_for_beat`, `ack_2xx`, and `flush_final`.
- [ ] **Step 1: Failing tests (cargo).**
```rust
#[test] fn bad_json_oversize_and_unknown_key_are_refused() {}   // > 512 bytes; key outside the spec's set
#[test] fn the_65th_line_drops_the_oldest_and_counts_airings_dropped() {}
#[test] fn a_beat_answered_5xx_keeps_the_items_and_a_2xx_clears_them() {}
#[test] fn the_final_beat_flushes_the_buffer() {}
#[test] fn the_vendored_heartbeat_airings_fixture_round_trips() {}
```
- [ ] **Step 2–4:** red → implement → green (`cargo test -p adapters -p domain`). **MUTATE** "clear only on 2xx" (clear
  always) and name the killer.
- [ ] **Step 5: Commit** `feat(compositor): forward sponsor airings on the heartbeat`.

**Four types:** unit + regression (cargo); E2E: S15's `overlay-compositor.spec.ts`; smoke: the compositor harness's
heartbeat scenario with an airing.

### Task SC2: The frame grab

**Files:**
- Modify: `crates/adapters/src/gst_programme.rs` (an appsink tap off the streaming thread), `crates/app/src/control_worker.rs` (upload)
- Test: `crates/app/tests/scenarios.rs` (extend)

**Interfaces:**
- Consumes: S9 `POST /api/internal/relay/sessions/{sid}/airings/{momentId}/frame`, `image/jpeg`.
- Produces: `FRAME_GRAB_DELAY_MS = 1_500`, `FRAME_GRAB_MIN_GAP_MS = 20_000`, a JPEG at 640×360, q 75.
- [ ] **Step 1: Failing tests.**
```rust
#[test] fn a_start_line_grabs_one_frame_after_1500_ms() {}
#[test] fn a_second_start_inside_20_s_grabs_nothing() {}
#[test] fn a_failing_upload_logs_once_and_never_stalls_the_pipeline() {}   // programme frames keep flowing
```
- [ ] **Step 2–4:** red → implement → green. **MUTATE** the 20 s gate and name the killer.
- [ ] **Step 5: Commit** `feat(compositor): one programme frame per sponsor airing`. Push. PR C releases only after PR
  A is deployed (Review Focus 2).

---

# PR B — after YouTube Connect merges (`feat/r4-sponsors-youtube`)

Cut from `main` only once the Connect PR is merged. Re-pin every Connect name below against `main` at that time; the
names here are from `feat/youtube-connect` (`40419eafb2`) and its plan.

### Task Y1: Viewers at each showing (Connect-dependent)

**Files:**
- Create: `db/migration/deltas/V<next>__sponsor_airing_youtube.sql`
- Modify: `server/youtube/{port,fake,google}.ts` (add `liveViewers`), `server/sponsors/airings.ts` (the read at start), `server/sponsors/report.ts` (join for viewers)
- Test: `server/sponsors/__tests__/airing-youtube.test.ts`, extend `server/youtube/__tests__/fake.test.ts`

**Interfaces:**
- Consumes (Connect): `fixture_stream_sessions.youtube_broadcast_id`, `youtube_broadcasts (id, yt_broadcast_id, state, connection_id)`,
  `youtubeDriver()`, `openToken(exec, orgId, connectionId)`, `YouTubePort.accessToken`, `purgeConnectionData` (daily.ts),
  `disconnectYoutube` (disconnect.ts).
- Produces:
  - `sponsor_airing_youtube (airing_id pk → sponsor_airings on delete cascade, broadcast_id → youtube_broadcasts(id) on delete cascade, org_id, viewers int null, read_at timestamptz)`, RLS org-scoped. **Never a video id column (F6).**
  - `YouTubePort.liveViewers(at: string, videoId: string): Promise<number | null>`. It calls
    `videos.list?part=liveStreamingDetails` (1 quota unit) and returns null when `concurrentViewers` is hidden or
    absent.
  - `readViewersAtStart(airingId: string): Promise<void>`. It runs deferred after a new `start` row, only when the
    session's broadcast is `live`. It makes one call and never retries. Any error gives `viewers = null`.
- [ ] **Step 0:** Verify against DP III.E.4 whether a viewer count read while live may be kept past 30 days when
  Connect's refresh keeps the broadcast row (F6). A negative goes to the coordinator before Step 3.
- [ ] **Step 1: Failing tests.**
```ts
it("a start on a Connect broadcast that is live reads viewers once (fake.calls has one liveViewers)", …);
it("no broadcast, a hidden count, or an error ⇒ viewers null, no retry", …);
it("Connect's purgeConnectionData deletes the broadcast ⇒ the airing_youtube row is gone; sponsor_airings, durations and clicks unchanged (counts reported)", …);
it("Connect's daily refresh deleting a gone video ⇒ the same cascade", …);
it("disconnect → reconnect: the purged rows stay purged; new showings read fresh", …);
it("overview viewerImpressions = Σ viewers and peakViewers = max over the period; all null ⇒ dash", …);
```
- [ ] **Step 2–4:** red → implement → green. **MUTATE** the `state = 'live'` guard and name the killer.
- [ ] **Step 5: Commit** `feat(sponsors): viewers at each showing from YouTube Connect`, then `chore(r4): Y1 takes V<n>`.

**Four types:** unit + regression; E2E `sponsor-report.spec.ts › viewers column` with the Connect fake; smoke
`report shows a dash with no Connect`.

### Task Y2: "Watch this moment" (gated on Connect T14 being merged)

**Files:**
- Modify: `server/sponsors/report.ts` (`watchUrl`), `app/r/sponsor/[token]/page.tsx`
- Test: `server/sponsors/__tests__/watch-link.test.ts`

**Interfaces:**
- Consumes (Connect T14): `youtube_broadcasts.actual_start_at timestamptz null`, `yt_broadcast_id`.
- Produces: `watchMomentUrl(videoId: string, airingStartedAt: Date, actualStartAt: Date | null): string | null`, which
  returns `https://youtu.be/<videoId>?t=<max(0, floor((startedAt − actualStartAt) / 1000) − 3)>`, or null when
  `actualStartAt` is null.
- [ ] **Step 1: Failing tests.**
```ts
it("actual_start_at null (still live, or the end step has not run) ⇒ no link", …);
it("an airing 125.4 s after actual start ⇒ ?t=122; one 2 s after ⇒ ?t=0", …);
it("after a Connect purge ⇒ no link, the showing keeps frame, match, break and time on screen", …);
```
- [ ] **Step 2–4:** red → implement → green. **MUTATE** the null guard and name the killer.
- [ ] **Step 5: Commit** `feat(sponsors): watch this moment`.

**Four types:** unit + regression; E2E `sponsor-report.spec.ts › watch link` (seeded `actual_start_at`); smoke via S14's
row.

### Task Y3: Paid product placement (spec §6.2)

**Files:**
- Modify: Connect's broadcast insert path (`server/youtube/prepare.ts` / `google.ts`) **or** `components/sponsors/on-stream-tab.tsx`, the four `ui.json`
- Test: the matching unit test

- [ ] **Step 0:** Verify in Google's Data API reference whether `videos.paidProductPlacementDetails.hasPaidProductPlacement`
  is writable with the `youtube` scope. Record the URL and the answer in the commit.
- [ ] **Step 1 (writable):** test "rotation on for the fixture's competition ⇒ the insert/update sets
  hasPaidProductPlacement true; rotation off ⇒ false". **(not writable):** test "On stream tab with rotation on and a
  Connect channel shows the one-line reminder linking the channel setting; without Connect, nothing".
- [ ] **Step 2–4:** red → implement → green. Mutate the condition once.
- [ ] **Step 5: Commit** `feat(sponsors): declare paid promotion`. Push PR B, dispatch e2e, hand back.

**Four types:** unit + regression; E2E `sponsors-hub.spec.ts › paid promotion` (fake); smoke none beyond Y1's.

---

## Spec coverage map (self-review)

| Spec | Task |
|---|---|
| §0 D1–D14 | D2 S11 · D3 S4/S12 · D4 S13/S14 · D5 S14 · D6 Y2 · D8 Global · D9 S3/S4 · D10 S14 footnote · D11 S13/Y1 · D12 S12 · D13 header · D14 S5 |
| §1 premises | Findings F1–F10 |
| §2 rows 1–7 | 1 S6 · 2 S1/S2 · 3 S3/S4 (one row per scope; deals additive) · 4 S5 · 5 S7 · 6 S3/S8 · 7 S5 (+ console) |
| §3.1 | S1, S2 |
| §3.2 | S4, S5 (hidden/play-next inputs; real log via console C3) |
| §3.3 | S5 |
| §3.4 | S6, S7 (carousel on compositor scenes; Break/Full time in console C4) |
| §3.5 | S7 |
| §3.6.1–4 | S7, S8, S9, SC1, SC2 |
| §3.6.5 | Y1 (F6) |
| §3.7 | S10 (F3) |
| §4 | S3, Y1 (F6 removes three columns) |
| §5.1 | S11, S12, S13 |
| §5.2 | S14, Y2 |
| §6.1 | S11 |
| §6.2 | Y3 |
| §6.3 | dropped per F6; covered by Connect's purge, tested in Y1 |
| §7 | per task; seam S15; live check S15 Step 4 |
| §9 | header order; F5, F6, F7 |
