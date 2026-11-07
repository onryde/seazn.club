# Quick Match 1: Foundation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The data layer and server seams a guest quick match needs: the `quick_matches` table with the system org and user, home and visitor tokens, an atomic create that leaves a started division behind or nothing, the sport offer proven by running every sport, the home read with its per-match check, and the guest path into the existing device-link pad.

**Architecture:** Every guest competition is an ordinary private competition in one system org, created through the product's own use cases under a built `AuthCtx` for the system user. Guest-only facts live in a new `quick_matches` table. The home token is the only credential; it is stored as a hash plus a sealed envelope exactly as device links store theirs. Scoring is the existing pad behind a guest-minted device link. Nothing in the engine changes.

**Tech Stack:** Next.js app router (apps/web), postgres.js with `withTenant` RLS transactions, Flyway SQL migrations under `db/migration/deltas`, zod schemas in `apps/web/src/server/api-v1/schemas.ts`, vitest (DB suites gated on `DATABASE_URL`), the engine as the npm package `@onryde/seazn-engine`, installed under the alias `@seazn/engine` (`"@seazn/engine": "npm:@onryde/seazn-engine@^3.0.2"`, `apps/web/package.json:25` and root `package.json:73`; 3.0.2 resolved in `pnpm-lock.yaml`), so every import is `@seazn/engine/<subpath>` (`/core`, `/sport`, `/sports`, `/competition`, `/testkit`). The workspace is pnpm (`package.json:11`, `pnpm@10.34.5`); root scripts still run as `npm run <script>`.

**Spec:** `docs/superpowers/specs/2026-11-03-quick-match-design.md` (sections cited as §n, decisions as On/Cn). Mockups: `docs/superpowers/specs/mockups/2026-11-03-quick-match/`.

**Repo root for every path below:** the seazn.club checkout (`/Users/ashokhein/github/seazn.club`, or a worktree of it such as `/Users/ashokhein/github/seazn.club-worktrees/quick-match`). Paths under `apps/web/` are written relative to that app where the file is TypeScript.

Re-pinned against origin/main 1b224951d4 on 2026-11-07 (drift accepted).

## Global Constraints

- **No code change before the owner says so** (owner, 2026-11-06). This plan is a document; execution is a separate go.
- **Commits** (O9, lifted 2026-11-07 in the spec's O9 row: "yes, lift O9, commit and PR as usual"): work on branch `feat/quick-match` in a worktree, ordinary commits, one PR per plan. Each task still ends with its tests green; commit at that point.
- **No engine change** (§12). If a probe shows one is needed, stop and report; do not patch the engine.
- **Caps** (C6, §7.2): sides 2..6; league plays per pair 1..4; 5 alive quick matches per visitor; 7 days from `last_activity_at` (C1); reminder 24h before expiry (C2).
- **System org and user** (§7.1): one org "Seazn quick matches", one user that can never sign in; both inserted by migration with fixed ids so code references constants.
- **Visibility** (C7): every guest competition is `visibility = 'private'`, `discoverable = false`, created with no slug (`createCompetition` then generates one, `apps/web/src/server/usecases/competitions.ts:372-385`, and `withUniqueSlug` dedupes it, `apps/web/src/server/usecases/slugs.ts:84-112`).
- **Tokens** (C19): home token `qm_` + 32 random bytes base64url; stored as sha256 hex and as a sealed envelope under `DEVICE_LINK_KEK` via `sealWith`/`openWith` (`apps/web/src/server/relay/crypto.ts:72,87`). Never in a query string.
- **Sides** (C20): entrants with `members: []`, kind `individual` / `pair` / `team` as the variant implies, seeded 1..N in entry order.
- **Dates** (C21): `starts_on` today, `ends_on` one year out; nothing date-driven closes a quick match.
- **Knockout offer** (C23): only when `resolveModule(sport_key, module_version).supportsDraws(cfg, "knockout")` is false (`resolveModule` from `@/server/engine-db`, `apps/web/src/server/engine-db/registry.ts:27`; `supportsDraws(cfg, stage)` is declared on every module in `@seazn/engine/sport`). **Format row** (C16): hidden with two sides.
- **DB tests:** `const HAS_DB = !!process.env.DATABASE_URL; describe.skipIf(!HAS_DB)`; seed helpers in `apps/web/src/server/usecases/__tests__/_seed.ts` (`makeUser` `:23`, `seedOrg` `:32`). A fresh worktree has no `node_modules`: run `pnpm install --frozen-lockfile` first. The local env script is machine-local and NOT on `PATH`: `S=~/.claude/skills/seazn-local-env/scripts/seazn-env.sh`, then `$S up --label qm --no-placement` (fresh Postgres + `db:apply` + `sync:sports`) and `eval "$($S env --label qm)"` (exports `DATABASE_URL` and `DATABASE_SSL=disable`), then from `apps/web`: `npx vitest run <path>`. Tests that need no DB: `DATABASE_URL= npx vitest run <path>`. Run only the files a task names (AGENTS.md: never the full suite locally).
- **House test rules** (`docs/superpowers/TEST-STRATEGY.md:48-97`): report the count a sweep checked and fail on zero; never derive expected values from the code under test; mutate each new guard once before calling it green; sweep sports with `forEachSport` from `@seazn/engine/testkit`, or `forEachSportAsync` for an async (DB) body: `forEachSport` refuses a body that returns a thenable (`AsyncBody`).
- **American English** in every file this plan creates, including copy keys and comments.

## Review Focus

Inputs the spec implies but no task's tests would otherwise exercise, most likely to bite first. Each has its test added to the owning task below.

1. **A side name that is only whitespace, or 200 characters of emoji.** Expected: refused with the same localized message as an empty name; a long name is clipped to the entrant `display_name` limit, never a 500. (Task 5)
2. **Two sides with the same name.** Expected: both create; entrant display names are not unique per division (the only unique index on `entrants` is `(team_id, division_id)` where `team_id is not null`, `V256__entrant_team_unique.sql:6-8`), and the home shows both rows. (Task 5)
3. **A home token for a quick match whose competition was deleted by the sweep.** Expected: the token resolves to nothing and the page shows the dead-link screen, never a 500 from a null competition. (Task 7)
4. **`DEVICE_LINK_KEK` unset in the environment.** Expected: create refuses with 503 before writing anything, the same way device links refuse (`device-links.ts:140-152` owner ruling: `HttpError(503, KEK_MISSING, "DEVICE_LINK_KEK_MISSING")`), never a half-created row with an empty envelope. (Task 2)
5. **A knockout request for a sport whose rules can draw, sent straight to the API with the format row hidden by the client.** Expected: the use case refuses with `QUICK_MATCH_FORMAT_NOT_OFFERED`; the server never trusts the client's offer. (Task 5)

---

### Task 1: Constants, the `quick_matches` table, the system org and user

**Files:**
- Create: `apps/web/src/lib/quick-match-constants.ts` (import-free: `schemas.ts` imports it relatively, see Task 5)
- Create: `db/migration/deltas/V492__quick_matches.sql` (V492 is free: main's latest is `V491__divisions_org_id_index.sql`. The number is still assigned at merge as main's max + 1, `V489__competition_frozen_at.sql:2-4`; tests find it by glob `V*__quick_matches.sql`)
- Test: `apps/web/src/server/usecases/__tests__/quick-match-migration.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export const QUICK_MATCH_SYSTEM_ORG_ID = "00000000-0000-4000-8000-00000000a001";
  export const QUICK_MATCH_SYSTEM_USER_ID = "00000000-0000-4000-8000-00000000a002";
  export const QUICK_MATCH_SYSTEM_USER_EMAIL = "quick-matches@system.seazn.invalid";
  export const QUICK_MATCH_SYSTEM_ORG_SLUG = "seazn-quick-matches";
  export const QUICK_MATCH_MAX_SIDES = 6;
  export const QUICK_MATCH_MIN_SIDES = 2;
  export const QUICK_MATCH_MAX_PLAYS = 4;
  export const QUICK_MATCH_MAX_ALIVE_PER_VISITOR = 5;
  export const QUICK_MATCH_EXPIRY_DAYS = 7;
  export const QUICK_MATCH_REMINDER_HOURS_BEFORE = 24;
  export const QUICK_MATCH_ENDS_ON_DAYS = 365;
  ```
- Table `quick_matches` (one row per quick match):
  ```sql
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references organizations (id) on delete cascade,
  competition_id uuid not null unique references competitions (id) on delete cascade,
  name text not null,
  format text not null check (format in ('league','knockout')),
  token_hash text not null unique,
  token_enc bytea not null,
  visitor_hash text not null,
  email text null,
  locale text not null default 'en',
  last_activity_at timestamptz not null default now(),
  expires_at timestamptz null,
  reminder_sent_at timestamptz null,
  saved_by_user_id uuid null references users (id) on delete set null,
  created_at timestamptz not null default now()
  ```
  Indexes on `(visitor_hash)`, `(saved_by_user_id)`, `(expires_at)`. RLS enabled and forced with the `V484__match_day_fixture_calls.sql:32-36` policy shape (`enable` + `force row level security`, one `for all to app_user` policy `using (org_id = current_org_id()) with check (org_id = current_org_id())`), grants `select, insert, update, delete` to `app_user`.
- Seed rows in the same migration: `users` (fixed id, the `.invalid` email, `display_name 'Seazn quick matches'`, `email_verified false`, no `password_hash`, no `google_sub`; columns per `db/migration/v1-baseline/V002__users.sql`); `subscriptions (owner_user_id, plan_key, status, quantity_paid)` = system user, `'community'`, `'active'`, 1 (the shape `createOrgForUser` uses, `apps/web/src/lib/auth.ts:323-357`, subscription insert `:346-349`); `organizations` (fixed id, name `'Seazn quick matches'`, slug `'seazn-quick-matches'`, `created_by` system user, `subscription_id`; org insert `:350-353`); **no** `org_members` row; `org_entitlement_overrides (org_id, feature_key, bool_value, int_value, reason)` = system org, `'competitions.max_active'`, null, null, `'quick match system org: per-visitor cap lives in quick_matches'` (`expires_at`, added by `V266__admin_plan_tools.sql:11-12`, stays null = never expires). The null limit also keeps the billing freeze off for the system org: `frozenCompetitionIds` freezes nothing under a null `competitions.max_active` (`apps/web/src/server/usecases/entitlement-freeze.ts:368-376`), and `createDivision`/`createEntrants`/`startDivision` all consult it.

- [ ] **Step 1: Write the failing migration test**

```ts
// apps/web/src/server/usecases/__tests__/quick-match-migration.test.ts
describe.skipIf(!HAS_DB)("quick_matches migration", () => {
  it("creates the table with RLS forced and the tenant policy", async () => {
    const [t] = await sql`select relrowsecurity, relforcerowsecurity from pg_class where relname = 'quick_matches'`;
    expect(t).toEqual({ relrowsecurity: true, relforcerowsecurity: true });
    const pol = await sql`select policyname from pg_policies where tablename = 'quick_matches'`;
    expect(pol.map((p) => p.policyname)).toEqual(["quick_matches_tenant"]);
  });
  it("seeds the system org, its user and the unlimited competitions override", async () => {
    const [org] = await sql`select name, slug, created_by from organizations where id = ${QUICK_MATCH_SYSTEM_ORG_ID}`;
    expect(org).toEqual({ name: "Seazn quick matches", slug: "seazn-quick-matches", created_by: QUICK_MATCH_SYSTEM_USER_ID });
    const members = await sql`select 1 from org_members where org_id = ${QUICK_MATCH_SYSTEM_ORG_ID}`;
    expect(members).toHaveLength(0);
    expect(await getLimit(QUICK_MATCH_SYSTEM_ORG_ID, "competitions.max_active")).toBeNull();
    expect(await hasFeature(QUICK_MATCH_SYSTEM_ORG_ID, "scoring.device_links")).toBe(true);
    expect(await hasFeature(QUICK_MATCH_SYSTEM_ORG_ID, "realtime")).toBe(false);
    expect(await hasFeature(QUICK_MATCH_SYSTEM_ORG_ID, "news.auto")).toBe(false);
  });
  it("the system user has no sign-in credential", async () => {
    const [u] = await sql`select email, password_hash, google_sub, email_verified from users where id = ${QUICK_MATCH_SYSTEM_USER_ID}`;
    expect(u).toEqual({ email: QUICK_MATCH_SYSTEM_USER_EMAIL, password_hash: null, google_sub: null, email_verified: false });
  });
});
```

`getLimit` and `hasFeature` from `@/lib/entitlements` (`:609`, `:456`). `scoring.device_links` is true on `community` since `V488__device_links_free.sql:24-27` (and device-links.ts no longer gates on it), so no override is owed for it.

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run src/server/usecases/__tests__/quick-match-migration.test.ts`
Expected: FAIL, `relname = 'quick_matches'` returns no row.

- [ ] **Step 3: Write the constants file and the migration**

Migration order inside the file: users → subscriptions → organizations → org_entitlement_overrides → `create table quick_matches` → indexes → RLS → grants. Use `on conflict do nothing` on the three seed inserts so a re-run is idempotent. Migrations run as the migrating role, which bypasses RLS (`V489__competition_frozen_at.sql:39`).

- [ ] **Step 4: Apply and run the test**

Run, with the label's env loaded (`eval "$($S env --label qm)"`, which exports `DATABASE_URL` and `DATABASE_SSL=disable`; the schema defaults to `seazn_club`, `scripts/flyway.sh:87`): `npm run db:apply` from the repo root, then the vitest file.
Expected: PASS, 3 tests.

- [ ] **Step 5: Mutate once**

Temporarily drop the `force row level security` line, apply to a scratch label (`$S up --label qmmut --no-placement`; an edited, already-applied migration fails Flyway's checksum on the `qm` label), confirm the first test fails there, restore, `$S down --label qmmut`.

---

### Task 2: Home token and visitor key helpers

**Files:**
- Create: `apps/web/src/server/usecases/quick-match-tokens.ts`
- Test: `apps/web/src/server/usecases/__tests__/quick-match-tokens.test.ts` (no DB)

**Interfaces:**
- Consumes: `sealWith(name: KekName, plain: string): Buffer`, `openWith(name: KekName, enc: Uint8Array): string`, `hasValidKek(name: KekName): boolean` from `@/server/relay/crypto` (`:72`, `:87`, `:61`; `KekName` `:49`); `HttpError(status, message, code?, extra?, headers?)` from `@/lib/errors` (`:12-22`).
- Produces:
  ```ts
  export const QUICK_MATCH_TOKEN_PREFIX = "qm_";
  export const QUICK_MATCH_VISITOR_COOKIE = "seazn_qm_visitor";
  export const QUICK_MATCH_VISITOR_COOKIE_MAX_AGE_S = 400 * 24 * 3600;
  export function mintHomeToken(): string;                 // "qm_" + randomBytes(32).toString("base64url")
  export function hashHomeToken(secret: string): string;   // sha256 hex, same recipe as hashDeviceLinkToken (device-links.ts:18-20)
  export function sealHomeToken(secret: string): Buffer;   // sealWith("DEVICE_LINK_KEK", secret); throws HttpError(503, <message>, "DEVICE_LINK_KEK_MISSING") when !hasValidKek — the code device links refuse with (device-links.ts:144-152)
  export function openHomeToken(enc: Uint8Array): string;  // openWith("DEVICE_LINK_KEK", enc)
  export function mintVisitorKey(): string;                // "qv_" + randomBytes(32).toString("base64url")
  export function hashVisitorKey(key: string): string;     // sha256 hex
  export function isHomeTokenShaped(s: string): boolean;   // prefix + base64url body of 43 chars
  ```

- [ ] **Step 1: Write the failing tests**

```ts
it("mints distinct prefixed tokens and hashes deterministically", () => {
  const a = mintHomeToken(), b = mintHomeToken();
  expect(a).not.toBe(b); expect(a.startsWith("qm_")).toBe(true); expect(isHomeTokenShaped(a)).toBe(true);
  expect(hashHomeToken(a)).toBe(hashHomeToken(a)); expect(hashHomeToken(a)).toHaveLength(64);
});
it("seals and opens under DEVICE_LINK_KEK", () => {
  process.env.DEVICE_LINK_KEK = "a".repeat(64);
  const t = mintHomeToken();
  expect(openHomeToken(sealHomeToken(t))).toBe(t);
});
it("refuses to seal with no KEK (Review Focus 4)", () => {
  delete process.env.DEVICE_LINK_KEK;
  expect(() => sealHomeToken(mintHomeToken())).toThrow(expect.objectContaining({ status: 503, code: "DEVICE_LINK_KEK_MISSING" }));
});
it("rejects shapes that are not a home token", () => {
  for (const s of ["", "dl_abc", "qm_", "qm_" + "x".repeat(42), "qm_" + "x".repeat(44)]) expect(isHomeTokenShaped(s)).toBe(false);
});
```

- [ ] **Step 2: Run to verify failure** (`DATABASE_URL= npx vitest run src/server/usecases/__tests__/quick-match-tokens.test.ts`, expected: module not found)
- [ ] **Step 3: Implement the module** with the signatures above. `crypto.ts` reads the KEK from `process.env` on every call (`kek()` `:51-56`, `hasValidKek` `:61-63`) and caches nothing, so the "no KEK" test clears the env in-process; no `vi.resetModules()` is needed. Restore the env in an `afterEach`.
- [ ] **Step 4: Run to verify pass** (expected: PASS, 4 tests)

---

### Task 3: A transaction-taking start for a division

**Files:**
- Modify: `apps/web/src/server/usecases/schedule.ts:4064-4228` (`startDivision`)
- Test: `apps/web/src/server/usecases/__tests__/start-division-in-tx.test.ts`

**Interfaces:**
- Consumes: the main-transaction body of `startDivision` (`:4121-4208`): advisory lock (`:4122`), re-select status (`:4123-4124`), read the division's fixture ids (`:4128-4130`), the already-active early return (`:4131-4133`), `loadSettings` (`:4137`) and the rolling quick-start times for a `setup` division with `roundMinutes`, which read the FIRST STAGE's id from the pre-flight (`pre.firstStage.id`, `:4146` and `:4161`) and re-check the freeze (`:4155-4157`), `validateScheduleIn` (`:4169`), `assertPublishable` (`:4171`), `appendPublishedEvent` (`:4177`), `update divisions set status='active'` (`:4180`), `appendDivisionEvent(tx, divisionId, "division_started", { from })` (`:4181-4183`), `update divisions set seq` (`:4184`), `update competitions set status='live' where status='published' returning id` (`:4203-4206`). It returns `{ started, fixtureIds, competitionPromoted }` (`:4132`, `:4207`).
- Produces:
  ```ts
  export async function startDivisionInTx(
    tx: Tx, auth: AuthCtx, divisionId: string, firstStageId: string, input: StartDivisionRequest = {},
  ): Promise<{ started: boolean; fixtureIds: string[]; competitionPromoted: boolean }>;
  ```
  `Tx` is `schedule.ts`'s own `postgres.TransactionSql` alias (`:97`); `StartDivisionRequest` is `{ acknowledge_warnings?, reason? }` (`schemas.ts:4252-4256`). `firstStageId` is a parameter because the rolling-times write reads `pre.firstStage.id`, which the transaction body does not select itself. `startDivision` keeps its signature (`StartDivisionOut`, `:4032-4037`) and calls `startDivisionInTx(tx, auth, divisionId, pre.firstStage.id, input)` inside its existing `withTenant`, then `afterScheduleWrite(divisionId, pre.competition_id, "start", out.fixtureIds)` (`:4209`) and the `competitionPromoted` analytics (`:4216-4226`) after commit, as today. Behavior of `startDivision` is unchanged; the existing start tests pin it.

- [ ] **Step 1: Write the failing test**

```ts
describe.skipIf(!HAS_DB)("startDivisionInTx", () => {
  it("starts a generated league division inside the caller's transaction", async () => {
    const { auth } = await seedOrg(); const div = await seedLeagueDivision(auth, 3);   // helper copied from add-fixture.test.ts seedDivision (:48) + createStages + generateStageFixtures (:87-94); returns { id, stageId }
    const out = await withTenant(auth.orgId, (tx) => startDivisionInTx(tx, auth, div.id, div.stageId, {}));
    expect(out.started).toBe(true); expect(out.fixtureIds).toHaveLength(3);
    const [row] = await withTenant(auth.orgId, (tx) => tx`select status from divisions where id = ${div.id}`);
    expect(row.status).toBe("active");
  });
  it("rolls back with the caller", async () => {
    // same seed; run startDivisionInTx then throw inside the same withTenant; afterwards status is still 'setup'
  });
});
```

- [ ] **Step 2: Run to verify failure** (expected: `startDivisionInTx` is not exported)
- [ ] **Step 3: Extract the body** of `startDivision`'s main `withTenant` callback (`:4121-4208`) into `startDivisionInTx` without changing a statement; the one rewrite is `pre.firstStage.id` → the `firstStageId` parameter. `startDivision` now does its pre-flight (`:4073-4100`) and `generateStageFixturesUnpublished` (`:4105-4119`) as before, then `withTenant(auth.orgId, (tx) => startDivisionInTx(tx, auth, divisionId, pre.firstStage.id, input))`, then `afterScheduleWrite` and the lifecycle event.
- [ ] **Step 4: Run the new test and the existing start suites** (`npx vitest run src/server/usecases/__tests__/start-division-in-tx.test.ts src/server/usecases/__tests__/schedule.test.ts src/server/usecases/__tests__/schedule-start-gate.test.ts src/server/usecases/__tests__/start-division-promotes-competition.test.ts src/server/usecases/__tests__/schedule-fixture-cache-keys.test.ts src/server/usecases/__tests__/schedule-bye-shell.test.ts` — the `schedule*`/`start*` files that call `startDivision`), expected: PASS, nothing previously green turns red.

---

### Task 4: Match count and draw preview from the real generator

**Files:**
- Create: `apps/web/src/server/usecases/quick-match-preview.ts`
- Modify: `apps/web/src/lib/__tests__/bye-render-sites-read-unseated-loser.test.ts` (one `EXEMPT` row, `:87`; see Step 3)
- Test: `apps/web/src/server/usecases/__tests__/quick-match-preview.test.ts` (no DB)

**Interfaces:**
- Consumes: `previewDivisionFixtures(stages: PreviewStageInput[], count: number): PreviewPhase[]` (`stages.ts:2778`; `PreviewStageInput {kind, name, config, progression}` `:2683-2688`). Its output carries no `award` and no structured bye flag: `PreviewPhase { title, note?, sections: PreviewSection[] }`, `PreviewSection { title, matches: PreviewMatch[] }`, `PreviewMatch { home: string; away: string }` (`:2670-2682`). Stage 1 sides are named `A, B, C…` by seed (`alphaLabel` `:2690-2700`, used at `:2795`; doc comment `:2775-2777`), the count is clamped to 2..64 (`:2782`), sections are one per round for league and knockout (`:2845-2851`, titled `"Round n"` or the bracket round role, `:2877-2895`), and a bye line's `away` is the preview's bye word `msg("bracket.slot.bye")` (`:2869-2874`; `msg` from `@/lib/messages`, English "Bye"). The internal `GenFixture.award` (`:1245`) is not exported.
- Produces:
  ```ts
  export type QuickMatchFormat = "league" | "knockout";
  export interface QuickMatchPreview { matchCount: number; byeCount: number; rounds: { title: string; lines: { home: string | null; away: string | null; bye: boolean }[] }[] }
  export function quickMatchPreview(input: { format: QuickMatchFormat; sides: number; plays: number }): QuickMatchPreview;
  export function quickMatchStageInput(input: { format: QuickMatchFormat; plays: number; name: string }): PreviewStageInput; // {kind:"league", config:{legs: plays}} or {kind:"knockout", config:{}}; progression null
  ```
  `bye` is `match.away === msg("bracket.slot.bye")`; `matchCount` counts lines that are not byes (a bye is not a match). Placeholder side labels come from `previewDivisionFixtures` as it names them.

- [ ] **Step 1: Write the failing tests** (values from the generator's documented rules, not from running it: round robin `N(N-1)/2 × legs`; knockout padded to a power of two with byes to the top seeds, `apps/web/src/lib/division-builder/format-estimate.ts:43-46`; seed i plays N+1−i, C22)

```ts
it.each([[2,1,1],[2,3,3],[4,1,6],[4,2,12],[6,4,60]])("league %i sides × %i plays = %i matches", (sides, plays, n) => {
  expect(quickMatchPreview({ format: "league", sides, plays }).matchCount).toBe(n);
});
it.each([[2,1,0],[3,2,1],[4,3,0],[5,4,3],[6,5,2]])("knockout %i sides = %i matches, %i byes", (sides, n, byes) => {
  const p = quickMatchPreview({ format: "knockout", sides, plays: 1 });
  expect(p.matchCount).toBe(n); expect(p.byeCount).toBe(byes);
});
it("knockout of 4 pairs 1 v 4 and 2 v 3 in round one", () => {
  const r1 = quickMatchPreview({ format: "knockout", sides: 4, plays: 1 }).rounds[0].lines;
  // seeds 1..4 are named A..D by the preview (stages.ts:2775-2777); the PAIRING is the assertion, not the line order
  expect(new Set(r1.map((l) => [l.home, l.away].sort().join("v")))).toEqual(new Set(["AvD", "BvC"]));
});
```

- [ ] **Step 2: Run to verify failure**
- [ ] **Step 3: Implement** `quickMatchStageInput` and `quickMatchPreview` as a thin fold over `previewDivisionFixtures`. The literal key `"bracket.slot.bye"` in a non-test file is a site for the bye-render-sites scan (`lib/__tests__/bye-render-sites-read-unseated-loser.test.ts`, header `:1-20`), which reds an unclassified site; add one `EXEMPT` row beside the preview's own (`:153`): `{ file: "src/server/usecases/quick-match-preview.ts", fn: "<the enclosing function>", sites: 1, reason: "the quick match preview's bye line, over previewDivisionFixtures' generated fixtures — no stored outcome" }`.
- [ ] **Step 4: Run to verify pass** (`DATABASE_URL= npx vitest run src/server/usecases/__tests__/quick-match-preview.test.ts src/lib/__tests__/bye-render-sites-read-unseated-loser.test.ts`; expected: PASS, 11 tests in the preview file and the scan green; if the knockout counts differ from the table above, the table was wrong about the generator, not the generator: re-derive from `format-estimate.ts` and record the correction in the test's comment)

---

### Task 5: Create a quick match, or nothing

**Files:**
- Create: `apps/web/src/server/usecases/quick-match-create.ts`
- Create: `apps/web/src/server/usecases/quick-match-delete.ts`
- Modify: `apps/web/src/server/api-v1/schemas.ts` (append `CreateQuickMatch`)
- Test: `apps/web/src/server/usecases/__tests__/quick-match-create.test.ts`

**Interfaces:**
- Consumes: `createCompetition(auth, input: CreateCompetition)` (`competitions.ts:309`; schema `schemas.ts:180-206`, `ends_on` required `:191`), `createDivision(auth, competitionId, input)` (`divisions.ts:259`; it pins `sports.module_version`, `:307-324`), `createStages(auth, divisionId, input)` (`stages.ts:588`; `CreateStages` is one stage or an array, `schemas.ts:1308`; `CreateStage {seq, kind, name, config, progression?}` strict, `:1297-1305`; league config `{ legs }` `schemas.ts:1238`), `createEntrants(auth, divisionId, inputs)` (`entrants.ts:351`; `CreateEntrant {kind, display_name, seed, members}` `schemas.ts:687`, `display_name` max `ENTRANT_NAME_MAX` = 200, `lib/entrant-roster-name.ts:26`), `generateStageFixturesTx(tx, auth, stageId, {}, "record")` (`stages.ts:3481`; returns `GenerateWrite {outcome, divisionId, competitionId, kind}` `:2963-2972`), `afterGenerateCommit(auth, stageId, write)` (`stages.ts:3427-3445`: the table refold, the stage revalidation and the generate event that `generateStageFixturesTx` leaves to its caller), `startDivisionInTx` (Task 3), `afterScheduleWrite(divisionId, competitionId, "start", fixtureIds)` (`schedule.ts:108`), `withTenant` (`lib/db.ts:283`, never nested, `:279-281`), `sql` (`:332`), `resolveModule(sport_key, module_version)` from `@/server/engine-db`, `AuthCtx` from `@/server/api-v1/auth` (`:19-34`), Task 2 token helpers, Task 4 preview, Task 1 constants, `LOCALES`/`DEFAULT_LOCALE` from `lib/i18n-constants.ts` (`:6-8`; there is no `LocaleSchema` in the repo).
- Produces:
  ```ts
  // schemas.ts — relative imports with the .ts extension, like every other import there (schemas.ts:20-30: the
  // standalone OpenAPI generator loads this file under bare `node --experimental-strip-types`, which has no `@/` alias):
  //   import { LOCALES, DEFAULT_LOCALE } from "../../lib/i18n-constants.ts";
  //   import { QUICK_MATCH_MIN_SIDES, QUICK_MATCH_MAX_SIDES, QUICK_MATCH_MAX_PLAYS } from "../../lib/quick-match-constants.ts";
  export const CreateQuickMatch = z.object({
    name: z.string().trim().min(1).max(80),
    sport_key: z.string().min(1), variant_key: z.string().min(1),
    format: z.enum(["league", "knockout"]),
    sides: z.array(z.string().trim().min(1).max(60)).min(QUICK_MATCH_MIN_SIDES).max(QUICK_MATCH_MAX_SIDES),
    plays: z.number().int().min(1).max(QUICK_MATCH_MAX_PLAYS).default(1),
    email: z.string().email().max(254).nullable().default(null),
    locale: z.enum(LOCALES).default(DEFAULT_LOCALE),   // precedent: app/api/funnel/start/route.ts:21
  }).strict();
  export type CreateQuickMatch = z.infer<typeof CreateQuickMatch>;

  // quick-match-create.ts
  export interface CreatedQuickMatch { id: string; competitionId: string; divisionId: string; stageId: string; token: string; matchCount: number; expiresAt: Date }
  export const QUICK_MATCH_ERRORS = { TOO_MANY_ALIVE: "QUICK_MATCH_TOO_MANY_ALIVE", FORMAT_NOT_OFFERED: "QUICK_MATCH_FORMAT_NOT_OFFERED", SPORT_NOT_OFFERED: "QUICK_MATCH_SPORT_NOT_OFFERED" } as const;
  export function systemAuth(): AuthCtx; // { orgId: QUICK_MATCH_SYSTEM_ORG_ID, via: "session", userId: QUICK_MATCH_SYSTEM_USER_ID, role: "owner", keyId: null }
  export async function createQuickMatch(
    input: CreateQuickMatch,
    ctx: { visitorHash: string; now?: Date; _failBeforeGenerateForTests?: () => void },
  ): Promise<CreatedQuickMatch>;

  // quick-match-delete.ts (privileged; the sweep and compensation use it)
  export async function hardDeleteQuickMatchCompetition(competitionId: string): Promise<void>; // sql.begin: delete email_outbox rows where ref_type='quick_match' and ref_id = the quick_matches id (free-text ref, V470__email_outbox.sql:38-39); delete quick_matches; delete competitions (cascades per §7.8)
  ```
  Order inside `createQuickMatch`:
  1. count alive rows for `visitorHash` (`expires_at > now and saved_by_user_id is null`); 5 or more → `HttpError(429, QUICK_MATCH_TOO_MANY_ALIVE)`.
  2. sport and variant must be in the offer (Task 6 `isOffered`); knockout only when `knockoutAllowed` (C23) and `sides.length > 2` (C16) → else `HttpError(422, QUICK_MATCH_FORMAT_NOT_OFFERED)`.
  3. `createCompetition(auth, { name, visibility: "private", branding: {}, starts_on: today, ends_on: today + 365 d })`.
  4. in `try`: `createDivision(auth, competition.id, { name, sport_key, variant_key, config: { entrants: { kinds: [kind], defaultKind: kind } } })` where `kind` is the variant's entrant kind (Task 6); `createStages(auth, division.id, { seq: 1, kind: format, name, config: format === "league" ? { legs: plays } : {} })`; `createEntrants(auth, division.id, sides.map((display_name, i) => ({ kind, display_name, seed: i + 1, members: [] })))`; then one `withTenant(SYSTEM_ORG, tx => { ctx._failBeforeGenerateForTests?.(); const write = generateStageFixturesTx(tx, auth, stage.id, {}, "record"); const started = startDivisionInTx(tx, auth, division.id, stage.id, {}); update competitions set status='live'; insert quick_matches row (token hash + envelope, expires_at = now + 7 d) })`; after it commits, `afterGenerateCommit(auth, stage.id, write)` and `afterScheduleWrite(division.id, competition.id, "start", started.fixtureIds)`, the post-commit work `generateStageFixtures` and `startDivision` each do for themselves (`stages.ts:3419-3420`, `schedule.ts:4209`).
  5. `catch`: `hardDeleteQuickMatchCompetition(competition.id)` then rethrow.
  The competition is set `live` directly because `startDivisionInTx` only promotes `published` → `live` and a guest competition is never published.

- [ ] **Step 1: Write the failing tests**

```ts
const sides = ["Ravi & Sam", "Priya & Tom", "Lee & Ana", "Jo & Max"];
const base = { name: "Badminton · Tue 3 Nov", sport_key: "badminton", variant_key: BADMINTON_DOUBLES, plays: 1, email: null, locale: "en" as const };
it("creates a started league with the promised fixture count", async () => {
  const out = await createQuickMatch({ ...base, format: "league", sides }, { visitorHash: v() });
  expect(out.matchCount).toBe(6);
  const fx = await listDivisionFixtures(systemAuth(), out.divisionId); expect(fx).toHaveLength(6);
  const [d] = await withTenant(SYSTEM_ORG, (tx) => tx`select status from divisions where id = ${out.divisionId}`); expect(d.status).toBe("active");
  const [c] = await withTenant(SYSTEM_ORG, (tx) => tx`select status, visibility, discoverable from competitions where id = ${out.competitionId}`);
  expect(c).toEqual({ status: "live", visibility: "private", discoverable: false });
  const [q] = await sql`select token_hash, saved_by_user_id from quick_matches where id = ${out.id}`;
  expect(q.token_hash).toBe(hashHomeToken(out.token)); expect(q.saved_by_user_id).toBeNull();
});
it("creates a knockout of 4 with two semi-finals and a final wired", async () => {
  const out = await createQuickMatch({ ...base, format: "knockout", sides }, { visitorHash: v() });
  const fx = await listDivisionFixtures(systemAuth(), out.divisionId);   // selects winner_to_fixture (fixtures.ts:381)
  expect(fx.filter((f) => f.round_no === 1)).toHaveLength(2);
  const final = fx.find((f) => f.round_no === 2)!; expect(final.home_entrant_id).toBeNull(); expect(final.away_entrant_id).toBeNull();
  expect(fx.filter((f) => f.round_no === 1).every((f) => f.winner_to_fixture === final.id)).toBe(true);
});
it("leaves nothing behind when generation fails (atomicity)", async () => {
  const before = await sql`select count(*)::int as n from competitions where org_id = ${SYSTEM_ORG}`;
  await expect(createQuickMatch({ ...base, format: "league", sides }, { visitorHash: v(), _failBeforeGenerateForTests: () => { throw new Error("boom"); } })).rejects.toThrow("boom");
  const after = await sql`select count(*)::int as n from competitions where org_id = ${SYSTEM_ORG}`;
  expect(after[0].n).toBe(before[0].n);
  expect(await sql`select 1 from quick_matches where name = ${base.name}`).toHaveLength(0);
});
it("refuses the 6th alive match for one visitor with QUICK_MATCH_TOO_MANY_ALIVE", async () => { /* 5 creates then the 6th rejects with status 429 and that code */ });
it("refuses knockout for a sport that can draw, even when asked directly (Review Focus 5)", async () => {
  await expect(createQuickMatch({ ...base, sport_key: "football", variant_key: FOOTBALL_DEFAULT, format: "knockout", sides }, { visitorHash: v() })).rejects.toMatchObject({ status: 422, code: "QUICK_MATCH_FORMAT_NOT_OFFERED" });
});
it("refuses knockout with two sides (C16)", async () => { /* format knockout, sides.slice(0,2) → 422 QUICK_MATCH_FORMAT_NOT_OFFERED */ });
it("two sides may share a name (Review Focus 2)", async () => { /* ["A","A","B"] league creates; 3 entrants */ });
it("a whitespace side name is refused by the schema (Review Focus 1)", () => { expect(() => CreateQuickMatch.parse({ ...base, format: "league", sides: ["A", "   "] })).toThrow(); });
it("the 7th side is refused by the schema", () => { expect(() => CreateQuickMatch.parse({ ...base, format: "league", sides: ["1","2","3","4","5","6","7"] })).toThrow(); });
it("more than one league stage never exists: exactly one stage, one division", async () => { /* counts */ });
```

`BADMINTON_DOUBLES` / `FOOTBALL_DEFAULT` are read in `beforeAll` from `sport_variants where is_system` (`V203__sport_variants.sql:6`), never typed. The sport rows exist after `npm run sync:sports` (which `$S up` runs).

- [ ] **Step 2: Run to verify failure**
- [ ] **Step 3: Implement** the schema, `systemAuth`, `createQuickMatch` in the order above, and `hardDeleteQuickMatchCompetition`. `createCompetition`'s input type is `CreateCompetition` (its zod output type, so `visibility` and `branding` are required fields); pass `ends_on` as an ISO date string.
- [ ] **Step 4: Run to verify pass** (expected: PASS, 10 tests)
- [ ] **Step 5: Mutate once:** comment out the `catch` compensation, confirm the atomicity test fails, restore.

---

### Task 6: The sport offer, proven by scoring every sport

**Files:**
- Create: `apps/web/src/server/usecases/__tests__/_quick-match-probe.ts` (test-only helper, like `_seed.ts` and `_rig.ts`: it imports `@seazn/engine/testkit`, which must never reach a production bundle)
- Create: `apps/web/src/lib/quick-match-offer.generated.json`
- Create: `apps/web/src/server/usecases/quick-match-sports.ts`
- Modify: root `package.json` (script `quick-match:probe`)
- Test: `apps/web/src/server/usecases/__tests__/quick-match-offer.test.ts`

**Interfaces:**
- Consumes: Task 5 `createQuickMatch` and `systemAuth`; `scoreEvent(auth, fixtureId, input: AppendEventRequest, opts?)` (`scoring.ts:150-157`; `AppendEventRequest {expected_seq, type, payload, idempotency_key?, engine_epoch?, rules_version?}` `schemas.ts:2808-2830`) driven with the device-link-shaped `AuthCtx` the pad uses (`via: "device_link"`, `deviceLinkId` from Task 8's mint, or the session-shaped system ctx when the probe runs before Task 8: the scoring door accepts both, `scoring.ts:582`, `:629`); `forEachSportAsync` (`@seazn/engine/testkit`, `dist/testkit/for-each-sport.d.ts:23`); the engine's own event generator for a module, `buildStream(module, cfg, lineups, seed, maxEvents)` and `onePlayEvent(...)` (`@seazn/engine/testkit`, `dist/testkit/helpers.d.ts:18`, `dist/testkit/play-event.d.ts`); `resolveModule(sport_key, module_version).supportsDraws(cfg, "knockout")` with `module_version` from the `sports` catalog row, the version `createDivision` pins (`divisions.ts:307-324`); `registrationDefaultKind(division)` (`apps/web/src/server/usecases/entrant-shape.ts:52-54`); `sport_variants` rows.
- Produces:
  ```ts
  // quick-match-offer.generated.json  (written by the probe, read at runtime, pinned by the test)
  { "engine": "<installed @seazn/engine version, read from node_modules/@seazn/engine/package.json as toolchain.test.ts:477 does>", "generatedAt": "...", "offered": [ { "sport_key": "badminton", "variant_key": "...", "entrant_kind": "pair" }, ... ], "excluded": [ { "sport_key": "cricket", "variant_key": "...", "reason": "WRONG_PHASE: ... lineup" }, ... ] }

  // quick-match-sports.ts
  export interface QuickMatchVariant { variant_key: string; name: string; entrant_kind: "individual" | "pair" | "team"; knockoutAllowed: boolean }
  export interface QuickMatchSport { sport_key: string; name: string; variants: QuickMatchVariant[] }
  export async function listQuickMatchSports(): Promise<QuickMatchSport[]>;   // sports × system variants ∩ offered, knockoutAllowed = !supportsDraws(cfg,"knockout")
  export function isOffered(sport_key: string, variant_key: string): boolean;
  export function entrantKindFor(sport_key: string, variant_key: string): "individual" | "pair" | "team";

  // __tests__/_quick-match-probe.ts
  export async function runQuickMatchProbe(opts: { quiet?: boolean }): Promise<OfferJson>;
  export function firstRallyFor(sport_key: string): AppendEventRequest;   // Task 8 uses it
  ```
  The probe: for every sport × system variant (swept with `forEachSportAsync`, which reports the count it visited), create a quick match of 2 sides as a league of 1 play, then drive one complete match through `scoreEvent` with an event sequence drawn from the engine's own generator for that module (`buildStream` / `onePlayEvent` above, the walk the engine's conformance corpora record), never a hand-typed one, with no lineup. (`scoring-free.test.ts` is the precedent for driving `scoreEvent` once per sport over `builtinModules` from `@seazn/engine/sports` on a `makeCommunityRig` org, `scoring-free.test.ts:13-18`; it scripts one pad-declared event per sport, not a full match.) A variant whose first event is refused (`WRONG_PHASE`, `INVALID_EVENT`, `LINEUP_INVALID` / `LINEUP_NOT_SUPPORTED`, all in `@seazn/engine/core`'s `errors.d.ts`) goes to `excluded` with the error code; one that reaches `decided` goes to `offered`. The entrant kind per variant is `registrationDefaultKind` of the created division: the division's effective default (`entrantShapeOf`, `entrant-shape.ts:22-30`, over the engine's `effectiveEntrantModel`), forced to `individual` for chess (owner ruling 2026-10-26). The probe deletes what it created with `hardDeleteQuickMatchCompetition`. It prints the counts and fails if `offered` is empty or does not contain badminton.

- [ ] **Step 1: Write the failing offer test**

```ts
describe.skipIf(!HAS_DB)("quick match offer", () => {
  it("the generated offer matches a fresh probe run for the pinned engine", async () => {
    const fresh = await runQuickMatchProbe({ quiet: true });       // from ./_quick-match-probe
    expect(fresh.offered.length).toBeGreaterThan(0);
    if (process.env.QUICK_MATCH_PROBE_WRITE === "1") writeFileSync(OFFER_JSON_PATH, JSON.stringify(fresh, null, 2) + "\n");   // the generator run (Step 3)
    expect(fresh.offered).toEqual(offerJson.offered); expect(fresh.excluded).toEqual(offerJson.excluded);
    console.info(`quick match probe checked ${fresh.offered.length + fresh.excluded.length} sport×variant cases`);
  });
  it("cricket is excluded and badminton, table tennis and tennis are offered", () => {
    expect(offerJson.excluded.some((e) => e.sport_key === "cricket")).toBe(true);
    for (const k of ["badminton", "tabletennis", "tennis"]) expect(offerJson.offered.some((o) => o.sport_key === k)).toBe(true);
  });
  it("knockoutAllowed follows the module's supportsDraws declaration", async () => {
    const sports = await listQuickMatchSports();
    const football = sports.find((s) => s.sport_key === "football");
    if (football) expect(football.variants.every((v) => v.knockoutAllowed === false)).toBe(true);   // football can draw (server/engine-db/__tests__/draw-guard.test.ts:139-162)
    expect(sports.find((s) => s.sport_key === "badminton")!.variants.some((v) => v.knockoutAllowed)).toBe(true);
  });
  it("generic is never offered on the setup screen", async () => { expect((await listQuickMatchSports()).some((s) => s.sport_key === "generic")).toBe(false); });
});
```

- [ ] **Step 2: Run to verify failure**
- [ ] **Step 3: Write the probe** (`runQuickMatchProbe` and `firstRallyFor` in `__tests__/_quick-match-probe.ts`) and `quick-match-sports.ts`. The probe cannot be a root `scripts/*.ts`: `tsx` is not a dependency, and every root script runs under bare `node --experimental-strip-types` (`package.json:47-68`, apart from the `db:*` bash wrappers), which resolves neither the `@/` alias nor the `server-only` marker (stubbed only under vitest, `apps/web/vitest.config.ts:199-200`) that the use cases it drives import. The one workaround on main, a `registerHooks` resolve hook (`scripts/w2d/post-deploy-pin.ts:67-71`), cannot carry this probe either: Node 26 strip-only mode refuses constructor parameter properties, which `HttpError` uses (`apps/web/src/lib/errors.ts:13-18`), and every create use case the probe drives imports it. The JSON is generated by the offer test itself under a flag, the `capture:ai-demo` pattern (`package.json:46`; the flag gate `src/demo/ai-templates/__capture__/capture.test.ts:61`): add `"quick-match:probe": "QUICK_MATCH_PROBE_WRITE=1 npm run test --workspace apps/web -- src/server/usecases/__tests__/quick-match-offer.test.ts"` to the root `package.json` scripts.
- [ ] **Step 4: Run the probe once to generate the JSON, then the test** (`npm run quick-match:probe` from the repo root with the label's env loaded, then `npx vitest run src/server/usecases/__tests__/quick-match-offer.test.ts` from `apps/web`; expected: PASS, 4 tests; the first test's console line reports a count greater than zero)
- [ ] **Step 5: Mutate once:** hand-edit one `offered` entry's variant key, confirm the first test fails, regenerate with `npm run quick-match:probe`.

---

### Task 7: Resolve a home token and read the home

**Files:**
- Create: `apps/web/src/server/usecases/quick-match-home.ts`
- Test: `apps/web/src/server/usecases/__tests__/quick-match-home.test.ts`

**Interfaces:**
- Consumes: Task 2 hashing; `listDivisionFixtures(auth, divisionId)` (`fixtures.ts:370`); `getStandings(auth, stageId, poolId?)` (`stages.ts:6173`; `StandingsOut {stage_id, pool_id, rows, computed_through_seq, updated_at}` `:6162-6170`); `isBye(f)` (`apps/web/src/lib/run-sheet-groups.ts:179-185`, typed on a `Pick` of `FixtureRow`); `withTenant`; Task 5 `systemAuth`; `Locale` from `@/lib/i18n-constants` (`:7`).
- Produces:
  ```ts
  export interface QuickMatchRow { id: string; competitionId: string; name: string; format: QuickMatchFormat; email: string | null; locale: Locale; lastActivityAt: Date; expiresAt: Date | null; savedByUserId: string | null; tokenEnc: Uint8Array }
  export async function resolveQuickMatchToken(token: string): Promise<QuickMatchRow | null>;  // null when not shaped, unknown, or expires_at < now
  export async function findQuickMatchByCompetition(competitionId: string): Promise<QuickMatchRow | null>;
  export async function touchQuickMatchActivity(id: string, now?: Date): Promise<void>;   // last_activity_at = now, expires_at = now + 7 d unless saved
  export interface QuickMatchSide { entrantId: string; name: string }
  export interface QuickMatchFixture { id: string; roundNo: number; fixtureNo: number; home: QuickMatchSide | null; away: QuickMatchSide | null; homeSlotLabel: unknown; awaySlotLabel: unknown; status: string; summary: unknown; isBye: boolean }
  export interface QuickMatchHome { row: QuickMatchRow; divisionId: string; stageId: string; sport: { key: string; name: string; variantName: string }; sides: QuickMatchSide[]; fixtures: QuickMatchFixture[]; next: QuickMatchFixture | null; live: QuickMatchFixture | null; played: number; total: number; standings: StandingsOut | null; allPlayed: boolean }
  export async function readQuickMatchHome(row: QuickMatchRow): Promise<QuickMatchHome | null>;  // null when the competition is gone (Review Focus 3)
  export function nextPlayable(fixtures: QuickMatchFixture[]): QuickMatchFixture | null;  // first by (roundNo, fixtureNo) with status in_play, else scheduled with both sides known
  ```
  Every query in `readQuickMatchHome` runs under `withTenant(SYSTEM_ORG)` and carries `and d.competition_id = ${row.competitionId}` (or checks the returned division's `competition_id`) before anything is returned (§7.1 point 3). `listDivisionFixtures` and `getStandings` each open their own `withTenant` (`fixtures.ts:371`, `stages.ts:6174`): call them in sequence, never from inside another open one (`lib/db.ts:279-281`).

- [ ] **Step 1: Write the failing tests**

```ts
it("resolves a live token and refuses the hash, an expired token and a foreign shape", async () => {
  const a = await createQuickMatch(league4, { visitorHash: v() });
  expect((await resolveQuickMatchToken(a.token))!.id).toBe(a.id);
  expect(await resolveQuickMatchToken(hashHomeToken(a.token))).toBeNull();
  expect(await resolveQuickMatchToken("dl_" + a.token.slice(3))).toBeNull();
  await sql`update quick_matches set expires_at = now() - interval '1 second' where id = ${a.id}`;
  expect(await resolveQuickMatchToken(a.token)).toBeNull();
});
it("reads the home with the next match first and 0 of 6 played", async () => {
  const h = (await readQuickMatchHome(row))!;
  expect(h.total).toBe(6); expect(h.played).toBe(0); expect(h.next!.fixtureNo).toBe(1); expect(h.standings!.rows).toHaveLength(4);
});
it("never returns another quick match's fixtures (isolation)", async () => {
  const a = await createQuickMatch(league4, { visitorHash: v() }); const b = await createQuickMatch(league4, { visitorHash: v() });
  const ha = (await readQuickMatchHome(rowOf(a)))!;
  const bFixtures = await listDivisionFixtures(systemAuth(), b.divisionId);
  expect(ha.fixtures.map((f) => f.id).some((id) => bFixtures.some((f) => f.id === id))).toBe(false);
});
it("returns null for a token whose competition was hard-deleted (Review Focus 3)", async () => { /* create, hardDeleteQuickMatchCompetition, resolve → null; readQuickMatchHome on a stale row → null */ });
it("knockout: the final has no sides and is not next; a bye row is marked", async () => { /* knockout of 3: next is the only playable round-1 fixture; the bye row isBye */ });
```

- [ ] **Step 2: Run to verify failure**
- [ ] **Step 3: Implement** the module. `isBye` is the shared predicate `isBye(f)` from `@/lib/run-sheet-groups` (`:179-185`: an `award` outcome with one empty seat that is not a withdrawn winner's, `unseatedForfeitLoser`), not a re-derivation; a generated bye row is written `status 'forfeited'` with an award outcome (`stages.ts:3768-3780`). If `nextPlayable` spells its status test as one set or chain of two or more fixture-status literals (`in_play`, `scheduled`), it owes a row in `apps/web/src/lib/__tests__/status-set-ledger.ts`: `status-set-sweep.test.ts` scans `apps/web/src` and reds an unclassified set (`:1-15`).
- [ ] **Step 4: Run to verify pass** (expected: PASS, 5 tests)
- [ ] **Step 5: Mutate once:** drop the `competition_id` predicate from the fixtures read, confirm the isolation test fails, restore.

---

### Task 8: Mint a device link for a guest

**Files:**
- Modify: `apps/web/src/server/usecases/device-links.ts` (append; `lockFixtureLinks` `:113-115`, `linkableStatus(tx, fixtureId, competitionId?)` `:122-131`, `loadLinkableFixture(tx, fixtureId, competitionId?)` `:133-138`, `ensureInTx` `:208-218`, `ensureLocked` `:235-255`)
- Test: `apps/web/src/server/usecases/__tests__/quick-match-device-link.test.ts`

**Interfaces:**
- Consumes: Task 7 `QuickMatchRow`; Task 5 `systemAuth`; `rateLimit(key, cfg)` (`lib/rate-limit.ts:60`, Redis-backed, no DB connection) and `DEVICE_LINK_MINT_LIMIT` (`:105`, 10 per 60 s); `resolveDeviceLinkToken` (`device-links.ts:445`; returns `{id, org_id, fixture_id, issued_by}`); `EnsuredDeviceLink {row, secret, minted}` (`:201-206`).
- Produces:
  ```ts
  export async function ensureGuestDeviceLink(qm: QuickMatchRow, fixtureId: string): Promise<EnsuredDeviceLink>;
  ```
  `rateLimit("qm-mint:" + qm.id, DEVICE_LINK_MINT_LIMIT)` first; then inside one `withTenant(SYSTEM_ORG)`: `lockFixtureLinks(tx, fixtureId)`; `loadLinkableFixture(tx, fixtureId, qm.competitionId)` (404 when the fixture is not in that competition, `:127-129`; 422 when finalized or cancelled, `:135-137`); 422 `QUICK_MATCH_SIDES_UNKNOWN` when either seat is null; then `ensureLocked(tx, systemAuth(), fixtureId, "quick-match")`, which re-shows the live sealed link or mints one issued by the system user (`mintInTx` writes `issued_by = auth.userId`, `:171-178`), bypassing `requireSessionEditor` (`:94-100`).

- [ ] **Step 1: Write the failing tests**

```ts
it("mints a link for a fixture of this quick match, issued by the system user, and reopens it next time", async () => {
  const first = await ensureGuestDeviceLink(row, fx[0].id); expect(first.minted).toBe(true);
  const again = await ensureGuestDeviceLink(row, fx[0].id); expect(again.minted).toBe(false); expect(again.secret).toBe(first.secret);
  expect((await resolveDeviceLinkToken(first.secret)).issued_by).toBe(QUICK_MATCH_SYSTEM_USER_ID);
});
it("refuses a fixture of another quick match in the same org (negative pair)", async () => {
  await expect(ensureGuestDeviceLink(rowA, fixtureOfB.id)).rejects.toMatchObject({ status: 404 });
});
it("refuses a knockout final whose sides are unknown", async () => { await expect(ensureGuestDeviceLink(koRow, finalId)).rejects.toMatchObject({ status: 422, code: "QUICK_MATCH_SIDES_UNKNOWN" }); });
it("a scored rally through the minted link lands in score_events (real producer and consumer)", async () => {
  const { secret } = await ensureGuestDeviceLink(row, fx[0].id);
  const res = await POST(new Request(`http://x/api/v1/fixtures/${fx[0].id}/events`, { method: "POST", headers: { authorization: `Bearer ${secret}`, "content-type": "application/json" }, body: JSON.stringify(firstRallyFor("badminton")) }), { params: Promise.resolve({ id: fx[0].id }) });
  expect(res.status).toBe(201);
  expect(await sql`select count(*)::int as n from score_events where fixture_id = ${fx[0].id}`).toEqual([{ n: 1 }]);
});
```

`POST` is the real route handler from `app/api/v1/fixtures/[id]/events/route.ts` (`:11-18`: `parseBody(AppendEventRequest)`, `requireFixtureActor(req, id, "score")`, `scoreEvent`); `firstRallyFor` takes the first event of the probe's badminton sequence (Task 6, `__tests__/_quick-match-probe.ts`).

- [ ] **Step 2: Run to verify failure**
- [ ] **Step 3: Implement** `ensureGuestDeviceLink` in `device-links.ts` beside `ensureDeviceLink` (`:262-269`). No extraction is owed: the body after `requireSessionEditor` already exists as `ensureInTx` (`:208-218`: lock, `loadLinkableFixture` scoped to a competition, `ensureLocked`), and its parts are module-private helpers the new function calls directly, with the sides check between `loadLinkableFixture` and `ensureLocked`.
- [ ] **Step 4: Run the new test and the existing device-link suites** (`npx vitest run src/server/usecases/__tests__/quick-match-device-link.test.ts src/server/usecases/__tests__/device-links.test.ts src/server/usecases/__tests__/device-link-sealed-secret-migration.test.ts`), expected: PASS, nothing previously green turns red.

---

### Task 9: The pad's way back

**Files:**
- Modify: `apps/web/src/app/score/[token]/page.tsx:259-314`
- Create: `apps/web/src/components/v2/quick-match-back-link.tsx`
- Modify: `apps/web/src/dictionaries/{en,fr,es,nl}/ui.json` (key `quickMatch.backToMatch`) and the generated `apps/web/src/lib/i18n-keys.ts`
- Test: `apps/web/src/app/score/[token]/__tests__/page.quick-match.test.tsx` (next to the existing `page.test.tsx`)

**Interfaces:**
- Consumes: Task 7 `findQuickMatchByCompetition`, Task 2 `openHomeToken`; `ScanFixtureRow.competition_id` (`apps/web/src/server/usecases/scan-fixture.ts:39`, read at `page.tsx:80`); `msgFor` (`@/lib/messages-i18n`, `page.tsx:40`, `t` at `:57`).
- Produces: `QuickMatchBackLink({ href, label }: { href: string; label: string })`, a one-line link rendered above `DeviceScorePad` (inside the `inLocale(...)` block at `page.tsx:262-311`) only when `link.org_id === QUICK_MATCH_SYSTEM_ORG_ID` and a `quick_matches` row exists for `fixture.competition_id`; `href = "/q/" + openHomeToken(row.tokenEnc)`. Copy: en "Back to the quick match". (`DeviceScorePad` has no header slot, `device-score-pad.tsx:62-107`, so the link wraps from the page.)

- [ ] **Step 1: Write the failing test** following `page.test.tsx`'s render harness: a system-org fixture renders a link whose `href` starts with `/q/qm_`; an ordinary org's fixture renders no such link; the English copy appears.
- [ ] **Step 2: Run to verify failure**
- [ ] **Step 3: Implement** the lookup after `readScanFixture` (guarded by the org id so ordinary pads pay no extra query) and the component; add the key to all four dictionaries; run `npm run i18n:gen-keys` (`lib/i18n-keys.ts` is generated from the en keys) and `npm run i18n:check` from the repo root.
- [ ] **Step 4: Run to verify pass**, plus the existing `page.test.tsx`.

---

### Task 10: The system user can never sign in

**Files:**
- Modify: `apps/web/src/app/api/auth/magic-link/route.ts:53` (the request handler)
- Modify: `apps/web/src/lib/login-link.ts` (`issueLoginLink` `:16`, which `createLoginLink` `:28-30` and the magic-link route `:83` both call)
- Test: `apps/web/src/app/api/auth/magic-link/__tests__/system-user-refused.test.ts`

**Interfaces:**
- Consumes: `QUICK_MATCH_SYSTEM_USER_ID`, `QUICK_MATCH_SYSTEM_USER_EMAIL`.
- Produces: the magic-link request for the system user's email gets the route's ordinary 200 with no token and no outbox row: after `resolveOrCreateUser(email)` (`route.ts:69`) the system user's id is treated as no account, the same branch an address held by a soft-deleted account takes (`resolveOrCreateUser` answers null, `apps/web/src/lib/users.ts:31-47`; the route then skips `if (userId)`, `route.ts:72`). (An unknown address is not the model: for one, `resolveOrCreateUser` creates an account and the route mails it.) `issueLoginLink(QUICK_MATCH_SYSTEM_USER_ID, db)`, and so `createLoginLink`, throws `HttpError(403, "system user")` before writing a `login_links` row: the route issues tokens through `issueLoginLink` inside its outbox transaction (`route.ts:82-97`), not through `createLoginLink`, so the guard belongs in the shared function. Google cannot match it: `google_sub` is null and the `.invalid` domain never verifies.

- [ ] **Step 1: Write the failing tests** (follow `route-outbox.test.ts`'s harness): requesting a link for the system email answers 200 and enqueues nothing; `createLoginLink(systemId)` and `issueLoginLink(systemId, sql)` reject with 403.
- [ ] **Step 2: Run to verify failure**
- [ ] **Step 3: Implement** both guards.
- [ ] **Step 4: Run to verify pass**, plus the existing magic-link and login-link suites (`src/app/api/auth/magic-link/__tests__/*.test.ts`, `src/lib/__tests__/login-link.test.ts`).

---

## Self-review notes

- **Spec coverage, plan 1 scope:** §7.1 (Task 1, 7), §7.2 (Task 1 override; the plan key choice is "community plus overrides", §10), §7.3 (Tasks 3, 4, 5), §7.4 (Task 8), C11 and C23 (Task 6), C12 (Task 9), C16 and C17 (Tasks 4, 5), C19 and C20 (Tasks 2, 5), C21 (Task 5 `ends_on`, with the "nothing date-driven" test in plan 3's sweep task), §7.5 (Task 7), §9 "create-and-score sweep" (Task 6 is the sweep; Task 8 the seam). Screens, email, saving and the sweep are plans 2 and 3.
- **Deviation from §7.3 "in one transaction":** `withTenant` must not be nested (`lib/db.ts:279-283`) and the four create use cases each open their own, so the competition, division, stage and entrants are created first and the fixtures, start and `quick_matches` row commit in one transaction; a failure anywhere hard-deletes the competition (Task 5). The observable promise holds: either a started quick match exists or nothing does, and Task 5's mutation step proves the compensation is load-bearing.
- **Type consistency:** `QuickMatchRow`, `QuickMatchFormat`, `systemAuth()`, `hashHomeToken`, `openHomeToken`, `hardDeleteQuickMatchCompetition`, `startDivisionInTx`, `ensureGuestDeviceLink` are named once here and used by those names in plans 2 and 3. `startDivisionInTx` now takes `firstStageId` and returns `competitionPromoted` (Task 3); `runQuickMatchProbe` and `firstRallyFor` live in `apps/web/src/server/usecases/__tests__/_quick-match-probe.ts` (Task 6).

## Re-pin log (2026-11-07)

Verified against origin/main 1b224951d4 in `/Users/ashokhein/github/seazn.club-worktrees/quick-match`, every pin opened and read. Engine facts read from the installed `@onryde/seazn-engine@3.0.2` (`node_modules/@seazn/engine/dist`, the version `pnpm-lock.yaml` resolves).

| Where | Old | New |
|---|---|---|
| Header | Repo root `/Users/asubramanian-mac2/Downloads/seazn.club-main` | `/Users/ashokhein/github/seazn.club` (or a worktree of it); re-pin line added |
| Tech Stack | engine "as the npm package `@onryde/seazn-engine`" | installed as alias `@seazn/engine` (`apps/web/package.json:25`, `package.json:73`), imports `@seazn/engine/<subpath>`; pnpm workspace (`package.json:11`) |
| Global: O9 | "No git commits, no remote (O9)" | O9 lifted 2026-11-07 per the spec's O9 row: branch `feat/quick-match`, commits, one PR per plan |
| Global: Visibility | `slugs.ts:84-106` | `apps/web/src/server/usecases/slugs.ts:84-112` (`withUniqueSlug`) + `competitions.ts:372-385` |
| Global: Knockout offer | `resolveModule` (no pin) | `@/server/engine-db`, `registry.ts:27` |
| Global: DB tests | `seazn-env up --label qm` / `seazn-env env` | `S=~/.claude/skills/seazn-local-env/scripts/seazn-env.sh` (not on PATH), `$S up --label qm --no-placement`, `eval "$($S env --label qm)"`; `pnpm install --frozen-lockfile` in a fresh worktree; `_seed.ts:23,32` |
| Global: House rules | `forEachSport` | `forEachSport` / `forEachSportAsync` (async body) |
| Review Focus 2 | `V256` | `V256__entrant_team_unique.sql:6-8` (team_id-only unique index) |
| Review Focus 4 | `device-links.ts:140` | `device-links.ts:140-152`, code `DEVICE_LINK_KEK_MISSING` |
| Task 1 migration | V492 "assigned at merge, `V489:2-4`" | V492 confirmed free (latest V491); pin spelled `V489__competition_frozen_at.sql:2-4` |
| Task 1 policy | `V484__match_day_fixture_calls.sql:19-36` | `:32-36` (19-31 is the table body) |
| Task 1 seed shape | `lib/auth.ts:323-357` | `apps/web/src/lib/auth.ts:323-357` (subscription `:346-349`, org `:350-353`); users cols `V002__users.sql`; override `expires_at` `V266:11-12` |
| Task 1 entitlements | `:609`, `:456` | unchanged (verified); `scoring.device_links` free since `V488:24-27`; null limit = no freeze (`entitlement-freeze.ts:368-376`) |
| Task 1 Step 3 | `V489:39` | `V489__competition_frozen_at.sql:39` (unchanged line) |
| Task 1 Step 4 | `DATABASE_URL=... DB_SCHEMA=<label schema> npm run db:apply` | label env via `$S env` (sets `DATABASE_URL`, `DATABASE_SSL=disable`); schema defaults to `seazn_club` (`scripts/flyway.sh:87`) |
| Task 1 Step 5 | "re-apply to a scratch schema" | scratch label `qmmut` (Flyway checksum refuses an edited applied migration) |
| Task 2 consumes | crypto fns (no line pins) | `crypto.ts:72,87,61`, `KekName :49`; `HttpError` `lib/errors.ts:12-22` |
| Task 2 Step 3 | "check how crypto.ts reads the KEK…; if it caches use `vi.resetModules()`" | resolved: read per call (`:51-56`, `:61-63`), no reset needed |
| Task 3 | `schedule.ts:4064-4228`, `:4121-4208` | unchanged (verified); body statements re-pinned line by line; `Tx :97`; `StartDivisionRequest schemas.ts:4252-4256`; `afterScheduleWrite :108/:4209` |
| Task 3 signature | `startDivisionInTx(tx, auth, divisionId, input)` → `{status, started, competitionId, fixtureIds}` | `(tx, auth, divisionId, firstStageId, input = {})` → `{started, fixtureIds, competitionPromoted}` |
| Task 3 Step 4 | `schedule*.test.ts` | the six `schedule*`/`start*` files that call `startDivision` |
| Task 4 | `stages.ts:2778`, `:2683` | unchanged (verified); `PreviewStageInput :2683-2688`; output types `:2670-2682` |
| Task 4 | "a bye line carries `award` (`:1245`)" | false for the preview's output: bye = `away === msg("bracket.slot.bye")` (`:2869-2874`); `:1245` is the unexported `GenFixture.award` |
| Task 4 | `format-estimate.ts:43-46` | `apps/web/src/lib/division-builder/format-estimate.ts:43-46` |
| Task 4 test | `[["1","4"],["2","3"]]` "adjust to the generator's naming" | labels are `A..D` (`alphaLabel :2690-2700`, doc `:2775-2777`): `{"AvD","BvC"}`, order-free |
| Task 4 files | 1 create + 1 test | + one `EXEMPT` row in `bye-render-sites-read-unseated-loser.test.ts` (`:87`, precedent `:153`) |
| Task 5 consumes | `competitions.ts:309`, `divisions.ts:259`, `stages.ts:588`, `schemas.ts:1308`, `:1238`, `entrants.ts:351`, `schemas.ts:687`, `stages.ts:3481`, `lib/db.ts:283`, `:332` | all unchanged (verified); added `CreateCompetition schemas.ts:180-206`, `CreateStage :1297-1305`, `GenerateWrite :2963-2972`, `divisions.ts:307-324`, `ENTRANT_NAME_MAX entrant-roster-name.ts:26`, `AuthCtx auth.ts:19-34`, `V470:38-39` |
| Task 5 schema | `locale: LocaleSchema.default("en")` | `z.enum(LOCALES).default(DEFAULT_LOCALE)` from `../../lib/i18n-constants.ts` (no `LocaleSchema` exists) |
| Task 5 schema imports | (unstated) | relative `.ts` imports only (`schemas.ts:20-30`) |
| Task 5 order step 4 | generate + start + insert, then done | + `afterGenerateCommit` (`stages.ts:3427-3445`) and `afterScheduleWrite` after commit |
| Task 5 test | `winner_to_fixture` on listed fixtures | confirmed selected by `listDivisionFixtures` (`fixtures.ts:381`) |
| Task 6 files | `scripts/quick-match-probe.ts`, `npx tsx`, `"quick-match:probe": "tsx …"` | `apps/web/src/server/usecases/__tests__/_quick-match-probe.ts`; script `QUICK_MATCH_PROBE_WRITE=1 npm run test --workspace apps/web -- …/quick-match-offer.test.ts` |
| Task 6 consumes | `scoreEvent(auth, fixtureId, body)` `scoring.ts:150` | `scoreEvent(auth, fixtureId, input: AppendEventRequest, opts?)` `:150-157`; `AppendEventRequest schemas.ts:2808-2830` |
| Task 6 consumes | `forEachSport` | `forEachSportAsync` (`for-each-sport.d.ts:23`) |
| Task 6 events | "testkit scenarios (the same sequences `scoring-free.test.ts` uses)" | `buildStream`/`onePlayEvent` (`@seazn/engine/testkit`); `scoring-free.test.ts` drives one pad event per sport, not a sequence |
| Task 6 entrant kind | `effectiveEntrantModel` (`entrant-shape.ts:22-30`) | `registrationDefaultKind` (`entrant-shape.ts:52-54`) over `entrantShapeOf` (`:22-30`) |
| Task 6 JSON `engine` | "`@onryde/seazn-engine` version from package.json" | installed `node_modules/@seazn/engine/package.json` version (`toolchain.test.ts:477` precedent) |
| Task 6 test comment | `draw-guard.test.ts:139-162` | `server/engine-db/__tests__/draw-guard.test.ts:139-162` (unchanged lines) |
| Task 7 consumes | `fixtures.ts:370`, `stages.ts:6173` | unchanged (verified); `StandingsOut :6162-6170`; `Locale i18n-constants.ts:7` |
| Task 7 Step 3 | `isBye` = `status === 'forfeited' && …` (`stages.ts:1282`) | reuse `isBye` (`lib/run-sheet-groups.ts:179-185`); bye insert `stages.ts:3768-3780` |
| Task 7 | (unstated) | `withTenant` nesting note; status-set ledger note |
| Task 8 | `ensureLocked :235`, `linkableStatus :122`, `resolveDeviceLinkToken :445` | unchanged (verified, ranges added); + `lockFixtureLinks :113-115`, `loadLinkableFixture :133-138`, `ensureInTx :208-218`, `EnsuredDeviceLink :201-206`, `rate-limit.ts:60,105` |
| Task 8 Step 3 | extract `ensureForIssuer(tx, issuer, fixtureId, label)` | no extraction: call the existing module-private helpers |
| Task 8 Step 4 | `device-link*.test.ts` | the two files that glob matched, named |
| Task 9 | `page.tsx:259-314`, `device-score-pad.tsx:62-107` | unchanged (verified); `inLocale` `:262-311`, `readScanFixture :80`, `msgFor :40/:57`, `scan-fixture.ts:39` |
| Task 9 Step 3 | `i18n:check` | `i18n:gen-keys` then `i18n:check` |
| Task 10 | Modify `login-link.ts (createLoginLink)` | guard in `issueLoginLink` `:16` (route calls it at `:83`, not `createLoginLink`) |
| Task 10 | "answers exactly as for an unknown address (no row, no mail)" | answers as for a soft-deleted address (`users.ts:31-47`); an unknown address creates an account |
| Task 10 Step 4 | "existing magic-link suites" | named: `magic-link/__tests__/*.test.ts`, `lib/__tests__/login-link.test.ts` |
| Self-review | `lib/db.ts:283` | `lib/db.ts:279-283` (the no-nesting comment and the function) |

### Drift adaptations

1. **No `LocaleSchema` (Task 5).** The plan's `CreateQuickMatch` imported a schema that does not exist anywhere in the repo. Rewritten as `z.enum(LOCALES).default(DEFAULT_LOCALE)` (the existing precedent is `app/api/funnel/start/route.ts:21`). `schemas.ts` must import it, and the new constants, by relative path with the `.ts` extension, because the standalone OpenAPI generator loads that file under bare strip-types (`schemas.ts:20-30`).
2. **`startDivision`'s transaction body depends on the pre-flight (Task 3).** The rolling-times write reads `pre.firstStage.id` (`schedule.ts:4146,4161`), and the body returns `competitionPromoted`, which the post-commit analytics read. "Extract without changing a statement" therefore needs a `firstStageId` parameter and the body's own return shape. The signature and the Task 5 call were rewritten to match. The verify command was narrowed from `schedule*.test.ts` (about 70 files, most of them AI or solver suites) to the six start suites.
3. **The generate's post-commit work is now a shared seam (Task 5).** `afterGenerateCommit(auth, stageId, write)` (`stages.ts:3427-3445`, from W3 T1 and W2d) does the table refold, the revalidation and the event that `generateStageFixturesTx` leaves to its caller. Without it a new league has no level table until the first lazy read. Task 5 now calls it after commit, plus the `afterScheduleWrite("start")` that `startDivision` does.
4. **The preview has no bye flag (Task 4).** `previewDivisionFixtures` returns strings only, and a bye shows as the bye word in `away`. Detection was rewritten to compare against `msg("bracket.slot.bye")`. That literal key is a site for the repo-wide bye-render-sites scan, so Task 4 gains one `EXEMPT` row, following the preview's own exemption at `:153`. The pairing test was rewritten with the preview's documented `A..D` labels and is order-free. `stages.ts` stays untouched, so TEST-STRATEGY item 9 is not triggered.
5. **The probe cannot be a root script (Task 6).** `tsx` is not a dependency, and root scripts run under `node --experimental-strip-types`, which resolves neither `@/` nor `server-only`. The `registerHooks` workaround (`scripts/w2d/post-deploy-pin.ts:67-71`) still fails here, because strip-only mode refuses `HttpError`'s parameter properties (`lib/errors.ts:13-18`). The probe was moved to a test-only helper (`__tests__/_quick-match-probe.ts`; this also keeps `@seazn/engine/testkit` out of production code). The JSON is now written by the offer test under `QUICK_MATCH_PROBE_WRITE=1`, the `capture:ai-demo` pattern (`package.json:46`).
6. **The event source for "one complete match" (Task 6).** `scoring-free.test.ts` does not hold per-sport sequences. The source is now the engine testkit's own generator (`buildStream`/`onePlayEvent`), and `scoring-free.test.ts` is cited only as the precedent for driving `scoreEvent` per sport. The sweep uses `forEachSportAsync`, because `forEachSport` refuses async bodies.
7. **The entrant kind comes from a helper that now exists (Task 6).** It is `registrationDefaultKind` (`entrant-shape.ts:52-54`), which already encodes chess as individual-only (owner ruling 2026-10-26), in place of a bare `effectiveEntrantModel` call.
8. **The bye predicate already exists (Task 7).** `isBye` in `lib/run-sheet-groups.ts:179-185` handles R116-3 (a withdrawn winner's seat is not a bye) and Swiss shells. The plan's hand-rolled `status === 'forfeited' && …` would have missed R116-3, so the task now reuses the shared predicate. Added a note on the status-set sweep (`status-set-sweep.test.ts`) for `nextPlayable`.
9. **The device-link body is already extracted (Task 8).** `ensureInTx` (`device-links.ts:208-218`) is the post-`requireSessionEditor` body, and its helpers are module-private in the same file. The "extract `ensureForIssuer`" step was replaced by direct calls, with the sides check inserted.
10. **The magic-link route no longer calls `createLoginLink` (Task 10).** It calls `issueLoginLink(userId, tx)` inside its outbox transaction (`route.ts:82-97`). The guard moved to `issueLoginLink`, which both callers share. The route-level answer is modelled on the soft-deleted-address branch, because an unknown address creates an account.
11. **Local env and package manager.** The repo is pnpm (`package.json:11`). `seazn-env` is a skill script, not a PATH command, and `$S up` already runs `db:apply` and `sync:sports`. `db:apply` takes `DATABASE_URL` and `DATABASE_SSL=disable`, and its schema defaults to `seazn_club`; no per-label `DB_SCHEMA` exists. The commands in Global Constraints and Task 1 were rewritten.
12. **Smaller alignments.**
    - Task 2's 503 now carries device links' own code, `DEVICE_LINK_KEK_MISSING`.
    - Task 2's "does crypto cache the KEK" question is resolved: it does not.
    - Task 1 notes that `scoring.device_links` is free on community since V488, and that the null `competitions.max_active` also keeps the V489 freeze off.

Not code drift, but changed: **O9 was lifted in the spec on 2026-11-07** (its row now reads "commit and PR as usual"), so the plan's "No git commits, no remote (O9)" constraint was updated to match the spec. No task's steps changed for it.

Observations left unchanged (plan-internal, not drift; for the executing session):
- **Review Focus 1 vs the schema.** Review Focus 1 says a long side name is "clipped" to the entrant limit, but `CreateQuickMatch` refuses names over 60 characters (400), below `ENTRANT_NAME_MAX` = 200. Both outcomes avoid a 500, so pick one.
- **Review Focus 4 vs the create order.** Review Focus 4 says "refuses with 503 before writing anything", but Task 5 seals the token in its last transaction, after the competition exists, so compensation removes it. Sealing first (step 0) would make the wording literal.
- **Tasks 5 and 6 depend on each other.** Task 5 consumes Task 6's `isOffered`/`entrantKindFor`, and Task 6's probe consumes Task 5's `createQuickMatch`. Order and scope were not changed.
- **Task 3: unacknowledged warnings may refuse the start.** `startDivisionInTx` keeps the publish gate (`assertPublishable`, `schedule.ts:3884-3907`). If an unslotted guest board raises warnings, `{}` (unacknowledged) refuses 422 `PUBLISH_UNACKNOWLEDGED`. Task 5's first test will show it.

### Blockers

None. No owner decision (O1–O11, C1–C23) is made impossible by the drift.
