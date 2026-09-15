# Chess Lichess External Play Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let online chess divisions create Lichess challenges at T−15, email Seazn fixture links, soft-join in the pre-window, and auto-apply clean results (messy cases → organiser queue).

**Architecture:** Fixture bridge — Seazn keeps pairings/colours/standings; a Lichess adapter creates challenges and maps finished games into the existing `scoreEvent` / `boardgame.result` path. New tables for per-user Lichess OAuth and per-fixture external-play state. Chess.com is interface-only until a later plan.

**Tech Stack:** Next.js app routes, Flyway deltas under `db/migration/deltas/`, vitest, Playwright, `scripts/smoke.ts`, Resend email, external cron (`x-cron-secret`), Lichess OAuth + Challenge API (CI uses recorded payloads only).

**Spec:** `docs/superpowers/specs/2026-09-15-chess-lichess-external-play-design.md`

## Global Constraints

- New worktree off `main` (`using-git-worktrees`). Prefix verifies with `cd <abs worktree> &&`.
- **Migration number is never pinned:** at Task 1 start, `ls db/migration/deltas | sort -V | tail -1` and take next free `V4xx`. Check unmerged branches for claimed numbers.
- Greenfield schema OK (`docs/superpowers/RULES.md`).
- TypeScript 7 / Node 26.
- Every task owes unit + E2E + smoke + regression (trace UI for backend-only tasks).
- User-facing strings → all 4 locale dictionaries + `pnpm i18n:gen-keys`.
- Vitest: JSON reporter; confirm worktree paths in `.testResults[].name`. Never trust `rtk` PASS(0).
- `grep -a` in this repo.
- Do **not** change OTB chess when `onlinePlay` is off/absent.
- Lichess games are **unrated/casual**. Challenge created **as White** (home) using White’s token.
- Bronstein/`delay` clocks: no auto-create (escalate `needs_organiser`).
- No live Lichess network in CI — recorded JSON fixtures only.
- OpenAPI: regenerate after new/changed v1 routes (`npm run openapi:gen`).

---

## File map

| Path | Responsibility |
|---|---|
| `db/migration/deltas/V4xx__lichess_external_play.sql` | `user_external_accounts` + `fixture_external_play` |
| `apps/web/src/server/external-play/types.ts` | Provider union, status enum, adapter interface |
| `apps/web/src/server/external-play/clock.ts` | Boardgame clock → Lichess clock; delay reject |
| `apps/web/src/server/external-play/map-result.ts` | Lichess game JSON → `boardgame.result` payload |
| `apps/web/src/server/external-play/lichess/client.ts` | HTTP client (injectable fetch) |
| `apps/web/src/server/external-play/lichess/adapter.ts` | `ExternalPlayAdapter` for Lichess |
| `apps/web/src/server/external-play/__fixtures__/lichess/*.json` | Recorded payloads |
| `apps/web/src/server/usecases/external-accounts.ts` | Link/unlink Lichess; enrollment check helper |
| `apps/web/src/server/usecases/external-play.ts` | T−15 prepare, start/finish sync, T+20 escalate, organiser resolve |
| `apps/web/src/app/api/auth/lichess/**` | OAuth start + callback |
| `apps/web/src/app/api/cron/external-play/route.ts` | Cron: T−15 prepare + T+20 escalate |
| `apps/web/src/app/api/webhooks/lichess/route.ts` | Provider webhook |
| `apps/web/src/lib/email.ts` + `email-templates/` | Fixture play-ready email |
| Division settings + enrollment + fixture UI | `onlinePlay` toggle, gate, Play button, needs-result queue |

---

### Task 1: Schema + pure mappers (clock + result)

**Files:**
- Create: `db/migration/deltas/V4xx__lichess_external_play.sql`
- Create: `apps/web/src/server/external-play/types.ts`
- Create: `apps/web/src/server/external-play/clock.ts`
- Create: `apps/web/src/server/external-play/map-result.ts`
- Create: `apps/web/src/server/external-play/__tests__/clock.test.ts`
- Create: `apps/web/src/server/external-play/__tests__/map-result.test.ts`
- Create: `apps/web/src/server/external-play/__fixtures__/lichess/game-mate-white.json` (and draw/resign/abort samples)

**Interfaces:**
- Produces:
  - `export type ExternalPlayProvider = "lichess"`
  - `export type ExternalPlayStatus = "pending" | "ready" | "live" | "finished" | "needs_organiser"`
  - `export type LichessClock = { limit: number; increment: number }` // limit = base seconds
  - `export function mapBoardgameClockToLichess(clock: { base: number; increment?: number; delay?: number } | undefined): { ok: true; clock: LichessClock } | { ok: false; reason: "missing_clock" | "delay_unsupported" }`
  - `export function mapLichessGameToBoardgameResult(input: { game: LichessGameSnapshot; homeEntrantId: string; awayEntrantId: string; homeLichessId: string; awayLichessId: string }): { ok: true; type: "boardgame.result"; payload: BoardgameResult } | { ok: false; reason: "account_mismatch" | "unfinished" | "abort" | "unmapped" }`

- [ ] **Step 1: Write failing clock + map-result tests**

```ts
// clock.test.ts
it("maps Fischer 600+5", () => {
  expect(mapBoardgameClockToLichess({ base: 600, increment: 5 })).toEqual({
    ok: true,
    clock: { limit: 600, increment: 5 },
  });
});
it("rejects delay", () => {
  expect(mapBoardgameClockToLichess({ base: 300, delay: 3 }).ok).toBe(false);
});
it("sudden death uses increment 0", () => {
  expect(mapBoardgameClockToLichess({ base: 900 })).toEqual({
    ok: true,
    clock: { limit: 900, increment: 0 },
  });
});

// map-result.test.ts — load fixture JSON; assert winner entrant + method
it("maps white mate to home winner when home is white on Lichess", () => { /* … */ });
it("rejects when lichess ids do not match linked accounts", () => { /* … */ });
it("returns unfinished/abort as not ok", () => { /* … */ });
```

- [ ] **Step 2: Run tests — expect FAIL (modules missing)**

```bash
cd <worktree>/apps/web && npx vitest run src/server/external-play/__tests__/clock.test.ts src/server/external-play/__tests__/map-result.test.ts --reporter=json --outputFile=/tmp/ep1.json
node -e "const j=require('/tmp/ep1.json'); console.log(j.numPassedTests,j.numFailedTests,j.numTotalTests)"
```

- [ ] **Step 3: Add migration**

```sql
-- user_external_accounts: user_id, provider text check (provider in ('lichess')),
-- external_user_id text not null, username text not null,
-- access_token text not null, refresh_token text, token_expires_at timestamptz,
-- unique (provider, external_user_id), unique (user_id, provider)

-- fixture_external_play: fixture_id pk references fixtures,
-- provider text not null, status text not null,
-- external_challenge_id text, external_game_id text, play_url text,
-- white_play_url text, black_play_url text,
-- last_error text, emailed_at timestamptz,
-- started_at timestamptz, finished_at timestamptz,
-- org_id uuid not null, created_at/updated_at
-- indexes: (status, emailed_at), (external_game_id) where not null
```

Apply via repo’s normal migration path (`seazn-local-env` / `db:apply` as used in this tree).

- [ ] **Step 4: Implement types + mappers to green**

- [ ] **Step 5: Commit**

```bash
git add db/migration/deltas/V4xx__lichess_external_play.sql apps/web/src/server/external-play
git commit -m "$(cat <<'EOF'
feat(chess): schema and pure Lichess clock/result mappers

EOF
)"
```

---

### Task 2: Lichess adapter (challenge create + fetch game) behind interface

**Files:**
- Create: `apps/web/src/server/external-play/lichess/client.ts`
- Create: `apps/web/src/server/external-play/lichess/adapter.ts`
- Create: `apps/web/src/server/external-play/__tests__/lichess-adapter.test.ts`
- Modify: `apps/web/src/server/external-play/types.ts` (adapter interface)

**Interfaces:**
- Produces:
  - `export interface ExternalPlayAdapter { createChallenge(input: CreateChallengeInput): Promise<CreateChallengeResult>; fetchGame(gameId: string): Promise<LichessGameSnapshot>; }`
  - `CreateChallengeInput`: `{ whiteAccessToken: string; blackLichessUsername: string; clock: LichessClock; rated: false }`
  - `CreateChallengeResult`: `{ challengeId: string; gameId?: string; whitePlayUrl: string; blackPlayUrl: string }`
  - `export function createLichessAdapter(deps: { fetch: typeof fetch; baseUrl?: string }): ExternalPlayAdapter`

- [ ] **Step 1: Failing tests with mocked fetch** — assert POST path, Authorization bearer, body `rated:false`, `color:"white"`, clock fields; map 401/429 to thrown typed errors.

- [ ] **Step 2: Run — expect FAIL**

- [ ] **Step 3: Implement client + adapter** (no real network)

- [ ] **Step 4: Tests PASS**

- [ ] **Step 5: Commit** `feat(chess): Lichess adapter for challenge create and game fetch`

---

### Task 3: Link / unlink Lichess on user profile (OAuth)

**Files:**
- Create: `apps/web/src/app/api/auth/lichess/start/route.ts`
- Create: `apps/web/src/app/api/auth/lichess/callback/route.ts`
- Create: `apps/web/src/server/usecases/external-accounts.ts`
- Create: `apps/web/src/server/usecases/__tests__/external-accounts.test.ts`
- Modify: profile UI (locate existing profile/settings page via scout; add Link Lichess control)
- Modify: 4 locale dictionaries for new strings
- Env: `LICHESS_CLIENT_ID`, `LICHESS_CLIENT_SECRET`, `LICHESS_REDIRECT_URI` (document in `.env.example` if present)

**Interfaces:**
- Produces:
  - `export async function getLinkedAccount(userId: string, provider: "lichess"): Promise<LinkedAccount | null>`
  - `export async function upsertLichessLink(userId: string, row: { externalUserId: string; username: string; accessToken: string; refreshToken?: string; tokenExpiresAt?: Date }): Promise<void>`
  - `export async function unlinkExternalAccount(userId: string, provider: "lichess"): Promise<void>`
  - `export async function personHasLichessLink(orgId: string, personId: string): Promise<boolean>` // via `persons.user_id`

Mirror Google OAuth cookie/state patterns in `apps/web/src/app/api/auth/google/`.

- [ ] **Step 1: Unit tests** — upsert/get/unlink; `personHasLichessLink` false when `user_id` null or no row.

- [ ] **Step 2: Implement OAuth routes + usecase**

- [ ] **Step 3: Profile UI + i18n (4 locales)**

- [ ] **Step 4: E2E** — logged-in user can open Link Lichess (mock callback or stub usecase in e2e helper); unlink clears badge.

- [ ] **Step 5: Smoke** — one path asserting linked-account API or profile marker.

- [ ] **Step 6: Commit** `feat(chess): Lichess OAuth link and unlink on profile`

---

### Task 4: Division `onlinePlay` + enrollment gate

**Files:**
- Modify: `apps/web/src/server/api-v1/schemas.ts` (division config / patch accepts `onlinePlay`)
- Modify: `apps/web/src/server/usecases/divisions.ts` — validate `onlinePlay` ∈ `off|lichess` (default off); only allowed when sport/module is boardgame/chess
- Modify: `apps/web/src/server/usecases/registration-submit.ts` (+ organiser entrant add path if separate) — if division `onlinePlay === "lichess"`, require `personHasLichessLink`
- Modify: `apps/web/src/components/v2/division-settings.tsx` — toggle
- Tests: division-settings + registration-submit unit; e2e enrollment blocked CTA

**Interfaces:**
- Division config key: `onlinePlay: "off" | "lichess"` stored in `divisions.config` jsonb (same pattern as other sport settings).
- Produces: `export function readOnlinePlay(config: unknown): "off" | "lichess"`

- [ ] **Step 1: Failing tests** — patch sets lichess; enrollment 422 with stable error code when unlinked; linked passes gate.

- [ ] **Step 2: Implement validation + gate + UI + i18n**

- [ ] **Step 3: Regression** — chess division without `onlinePlay` still enrolls unlinked users.

- [ ] **Step 4: OpenAPI regen if schema exported**

- [ ] **Step 5: Commit** `feat(chess): onlinePlay division setting and Lichess enrollment gate`

---

### Task 5: T−15 prepare job (create challenge + email)

**Files:**
- Create: `apps/web/src/server/usecases/external-play.ts` (prepareSweep)
- Create: `apps/web/src/app/api/cron/external-play/route.ts`
- Create: `apps/web/src/lib/email-templates/external-play-ready.ts` (or beside siblings)
- Modify: `apps/web/src/lib/email.ts` — `sendExternalPlayReadyEmail(to, { fixtureUrl, opponentName, scheduledAt, locale })`
- Create: `apps/web/src/server/usecases/__tests__/external-play-prepare.test.ts`
- Document cron in comment: wire in `onryde/seazn.club.workflow` (external) — every 5 min.

**Interfaces:**
- Produces:
  - `export async function prepareExternalPlayWindow(now?: Date): Promise<{ prepared: number; emailed: number; deferred: number; failed: number }>`
  - Selection: fixtures with `scheduled_at` in `[now, now+15m]` (and overdue not-yet-prepared in a small lookback), division `onlinePlay=lichess`, no `fixture_external_play` row or status `pending`, both sides have linked accounts + White token.
  - On delay clock: insert/update row `needs_organiser`, `last_error='delay_unsupported'`, do not email play CTA.
  - On success: status `ready`, store urls/ids, email **Seazn fixture URL** once (`emailed_at`), transactional mail OK.
  - Idempotent: second sweep does not re-email if `emailed_at` set.

- [ ] **Step 1: Failing integration tests** with mocked adapter + email spy

- [ ] **Step 2: Implement prepareSweep + cron route** (`CRON_SECRET` / `x-cron-secret` like `api/cron/registrations/route.ts`)

- [ ] **Step 3: Email template + 4 locale email strings**

- [ ] **Step 4: E2E or smoke** — seed fixture at T−10, run prepare handler, assert row `ready` + email spy called with Seazn path (not raw lichess.org as durable link)

- [ ] **Step 5: Commit** `feat(chess): T-15 Lichess challenge prepare and play-ready email`

---

### Task 6: Webhook/poll sync → existing scoring path

**Files:**
- Modify: `apps/web/src/server/usecases/external-play.ts` — `applyProviderGameUpdate`, `pollLiveExternalPlay`
- Create: `apps/web/src/app/api/webhooks/lichess/route.ts`
- Create: `apps/web/src/server/usecases/__tests__/external-play-sync.test.ts`
- Possibly thin internal helper that calls `appendEvent` / privileged score path with org tenant

**Interfaces:**
- Produces:
  - `export async function applyProviderGameUpdate(opts: { provider: "lichess"; gameId: string; snapshot?: LichessGameSnapshot }): Promise<"ignored" | "live" | "finished" | "needs_organiser">`
  - Rules from spec §9/§11: account mismatch / abort / unfinished → `needs_organiser`; clean map → append `boardgame.result` via real scoring seam; if fixture already has result → `"ignored"`.
  - Auth: webhook verified with shared secret / Lichess signature env `LICHESS_WEBHOOK_SECRET`; load `org_id` from `fixture_external_play`; call internal `appendExternalResult(orgId, fixtureId, event)` that uses `withTenant` + `appendEvent` (or `scoreEvent` with owner AuthCtx minted for the org). **Must not** invent a parallel standings writer.
  - Provenance: set `fixture_external_play.status=finished` and store `external_game_id`; optional note in payload only if engine allows — do not break golden streams.

- [ ] **Step 1: Failing tests** — mate applies standings points; mismatch does not append; second webhook ignored; abort → needs_organiser

**Critical:** fold the adapter’s mapped event through the **real** `appendEvent`/`scoreEvent` path (spec + AGENTS inert-seam rule).

- [ ] **Step 2: Implement webhook + apply + poll helper invoked from same cron route**

- [ ] **Step 3: Unit/integration green**

- [ ] **Step 4: Smoke** — scripted apply of recorded mate payload updates match outcome

- [ ] **Step 5: Commit** `feat(chess): Lichess webhook/poll sync into boardgame results`

---

### Task 7: T+20 escalate + organiser resolve API

**Files:**
- Modify: `external-play.ts` — `escalateStaleExternalPlay(now)`
- Create: API route e.g. `POST /api/v1/fixtures/{id}/external-play/resolve` (organiser) OR reuse existing manual result UI + status clear
- Modify: openapi + schemas
- Tests for escalate and resolve

**Interfaces:**
- `escalateStaleExternalPlay`: status in (`ready`,`pending`) AND `scheduled_at + 20m < now` AND not live/finished → `needs_organiser`
- `resolveExternalPlay(auth, fixtureId, body)`: organiser sets forfeit/draw/no-result via normal score events, then status `finished` (or leave needs_organiser cleared)

- [ ] **Step 1–4: TDD escalate + resolve + OpenAPI**

- [ ] **Step 5: Commit** `feat(chess): external-play no-show escalate and organiser resolve`

---

### Task 8: Player fixture Play UI + organiser needs-result queue

**Files:**
- Scout then modify fixture console / competition fixtures surfaces for chess online divisions
- Organiser queue list (division desk or fixtures tab filter `needs_organiser`)
- i18n ×4
- Playwright: Play button appears when `ready`; disabled/absent before prepare; queue shows escalated fixture

**Behaviour:**
- Soft window: once `ready`, show **Play on Lichess** (side-appropriate URL if white/black urls differ).
- Before prepare: show scheduled time / “link arrives 15 minutes before”.
- `needs_organiser`: player messaging + organiser CTA.

- [ ] **Step 1: E2E failing** against testids you introduce

- [ ] **Step 2: Implement UI**

- [ ] **Step 3: Mobile + desktop** — no horizontal scroll; follow existing desk patterns (not a new marketing layout)

- [ ] **Step 4: Commit** `feat(chess): Play on Lichess UI and organiser needs-result queue`

---

### Task 9: End-to-end regression pack + workflow note

**Files:**
- Extend e2e coverage for full happy path with mocked Lichess adapter (DI or env stub)
- `scripts/smoke.ts` slice for onlinePlay off regression
- Short note in plan/spec or `docs/` only if owner wants — prefer comment on cron route pointing at workflow repo
- Verify OpenAPI drift CI clean

- [x] **Step 1: Happy-path e2e** — linked enroll → division onlinePlay → fixture scheduled → prepare → play url present → apply mate fixture → standings

- [x] **Step 2: Regression** — onlinePlay off: unlinked enroll OK; no `fixture_external_play` row after prepare sweep

- [x] **Step 3: Full gate** — vitest JSON counts for new files; targeted e2e file (whole file, no `-g` slice); smoke path

- [x] **Step 4: Commit** `test(chess): external-play happy path and OTB regression coverage`

---

## Spec coverage checklist (self-review)

| Spec item | Task |
|---|---|
| Profile Lichess OAuth link | 3 |
| Enrollment requires link | 4 |
| Division onlinePlay=lichess | 4 |
| T−15 create + email Seazn link | 5 |
| Soft pre-window / both must join | 5–6 (Lichess behaviour; UI copy Task 8) |
| Start → live | 6 |
| Clean finish → boardgame.result | 6 |
| Messy → needs_organiser | 6–7 |
| Create as White / unrated | 2, 5 |
| Delay clock not auto-synced | 1, 5 |
| T+20 escalate | 7 |
| Chess.com later (interface only) | 1–2 types allow provider union; no chesscom adapter |
| OTB unchanged when offline | 4, 9 |
| Webhook + poll | 6 |
| Tests: unit/e2e/smoke/regression | per task + 9 |

## Placeholder / consistency scan

- No TBDs left in task bodies.
- Status enum and mapper reasons reused across tasks.
- Cron auth matches existing registrations cron.
- Scoring goes through real append path (Task 6).

---

## Execution handoff

Plan complete and saved to `docs/superpowers/plans/2026-09-15-chess-lichess-external-play.md`.

**Two execution options:**

1. **Subagent-Driven (recommended)** — fresh subagent per task, review between tasks  
2. **Inline Execution** — this session runs tasks with checkpoints  

Which approach?
