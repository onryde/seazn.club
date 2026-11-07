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
- **Sides** (C20, corrected by pre-flight D2): entrants with `members: []`, seeded 1..N in entry order, all of one kind (`individual` / `pair` / `team`). The kind is its own input on `CreateQuickMatch`, chosen by the setup's switch from the sport's own `entrantModel` kinds (chess: `individual` only). No variant carries a kind; Match rules picks the variant (spec §5 and C24, corrected 2026-11-07).
- **Dates** (C21): `starts_on` today, `ends_on` one year out; nothing date-driven closes a quick match.
- **Knockout offer** (C23): only when `resolveModule(sport_key, module_version).supportsDraws(cfg, "knockout")` is false (`resolveModule` from `@/server/engine-db`, `apps/web/src/server/engine-db/registry.ts:27`; `supportsDraws(cfg, stage)` is declared on every module in `@seazn/engine/sport`, `dist/sport/module.d.ts:643`) **and** (pre-flight D10, 2026-11-07) `reachableResultKinds(cfg, "league")` holds neither `tie` nor `noResult` (`dist/sport/module.d.ts:652-655`). A guest cannot settle a stalled bracket, so a sport that can pay a no-result (carrom, `module.d.ts:423`) gets no knockout in v1. One function decides it, Task 6's `offerFor`. **Format row** (C16): hidden with two sides.
- **DB tests:** `const HAS_DB = !!process.env.DATABASE_URL; describe.skipIf(!HAS_DB)`; seed helpers in `apps/web/src/server/usecases/__tests__/_seed.ts` (`makeUser` `:23`, `seedOrg` `:32`). A fresh worktree has no `node_modules`: run `pnpm install --frozen-lockfile` first. The local env script is machine-local and NOT on `PATH`: `S=~/.claude/skills/seazn-local-env/scripts/seazn-env.sh`, then `$S up --label qm --no-placement` (fresh Postgres + `db:apply` + `sync:sports`) and `eval "$($S env --label qm)"` (exports `DATABASE_URL` and `DATABASE_SSL=disable`), then from `apps/web`: `npx vitest run <path>`. Tests that need no DB: `DATABASE_URL= npx vitest run <path>`. Run only the files a task names (AGENTS.md: never the full suite locally).
- **The KEK in tests** (pre-flight A15): every create seals a token, and CI's unit job has no `DEVICE_LINK_KEK`. Every test file that creates a quick match (Tasks 5 to 9) stubs it at module scope, as `apps/web/src/server/usecases/__tests__/device-links.test.ts:7,32-37` does: `import { randomBytes as kekBytes } from "node:crypto"; const KEK = kekBytes(32).toString("hex"); vi.stubEnv("DEVICE_LINK_KEK", KEK);`.
- **One shared org in parallel files** (pre-flight A16): every quick match lives in the one system org, and vitest runs test files in parallel (`apps/web/vitest.config.ts:136`, pool `threads`). Key every assertion on a per-case unique name or visitor hash (`` `QM ${randomUUID().slice(0, 8)}` ``, `` `test-visitor-${randomUUID()}` ``). Never assert on the org's totals.
- **Errors** (pre-flight B5a): `new HttpError(status, englishMessage, CODE)`. The code is the THIRD argument (`apps/web/src/lib/errors.ts:12-22`). A code in the message slot leaves `body.code` absent, and plan 2 maps on `body.code`.
- **Analytics** (pre-flight D11): organizer activation events never fire for the system org. `captureServer` drops every event whose `orgId` is `QUICK_MATCH_SYSTEM_ORG_ID` except `quick_match_created`, which the create emits once (Task 5). This keeps organizer funnels clean.
- **House test rules** (`docs/superpowers/TEST-STRATEGY.md:48-97`): report the count a sweep checked and fail on zero; never derive expected values from the code under test; mutate each new guard once before calling it green; sweep sports with `forEachSport` from `@seazn/engine/testkit`, or `forEachSportAsync` for an async (DB) body: `forEachSport` refuses a body that returns a thenable (`AsyncBody`).
- **American English** in every file this plan creates, including copy keys and comments.

## Review Focus

Inputs the spec implies but no task's tests would otherwise exercise, most likely to bite first. Each has its test added to the owning task below.

1. **A side name that is only whitespace, or longer than 60 characters (31 emoji are 62 UTF-16 units).** Expected: refused by the schema (a 400), never a 500, and the client stops it first (plan 2 T4 sets `maxLength={60}`). The 60 is this plan's own cap, below `ENTRANT_NAME_MAX` = 200 (`lib/entrant-roster-name.ts:26`). Nothing is clipped, because clipping would silently change what a guest typed (pre-flight E1). (Task 5)
2. **Two sides with the same name.** Expected: both create; entrant display names are not unique per division (the only unique index on `entrants` is `(team_id, division_id)` where `team_id is not null`, `V256__entrant_team_unique.sql:6-8`), and the home shows both rows. (Task 5)
3. **A home token for a quick match whose competition was deleted by the sweep.** Expected: the token resolves to nothing and the page shows the dead-link screen, never a 500 from a null competition. (Task 7)
4. **`DEVICE_LINK_KEK` unset in the environment.** Expected: create refuses with 503 `DEVICE_LINK_KEK_MISSING` before it reads or writes anything, the same way device links refuse (`device-links.ts:140-152` owner ruling: `HttpError(503, KEK_MISSING, "DEVICE_LINK_KEK_MISSING")`). The home token is minted, hashed and sealed as step 0 of `createQuickMatch`, before the alive count and the first write, as device links seal "BEFORE any write" (`device-links.ts:161-170`). There is never a half-created row with an empty envelope (pre-flight E2). (Task 5; Task 2 proves only the helper's 503)
5. **A knockout request for a sport whose rules can draw, sent straight to the API with the format row hidden by the client.** Expected: the use case refuses with `QUICK_MATCH_FORMAT_NOT_OFFERED`; the server never trusts the client's offer. (Task 5. The test picks, at runtime, the first offered variant whose knockout is not allowed, and fails if there is none: no sport is hard-coded, pre-flight B5d)

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
  Indexes on `(visitor_hash)`, `(saved_by_user_id)`, `(expires_at)`. RLS enabled and forced with the `V484__match_day_fixture_calls.sql:32-36` policy shape (`enable` + `force row level security`, one `for all to app_user` policy), grants `select, insert, update, delete` to `app_user`. The policy is named, because Step 1's test pins the name (pre-flight B1):
  ```sql
  create policy quick_matches_tenant on quick_matches for all to app_user
    using (org_id = current_org_id()) with check (org_id = current_org_id());
  ```
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
  it("seeds the system org and its user, with no members", async () => {
    const [org] = await sql`select name, slug, created_by from organizations where id = ${QUICK_MATCH_SYSTEM_ORG_ID}`;
    expect(org).toEqual({ name: "Seazn quick matches", slug: "seazn-quick-matches", created_by: QUICK_MATCH_SYSTEM_USER_ID });
    const members = await sql`select 1 from org_members where org_id = ${QUICK_MATCH_SYSTEM_ORG_ID}`;
    expect(members).toHaveLength(0);
  });
  it("the system user has no sign-in credential", async () => {
    const [u] = await sql`select email, password_hash, google_sub, email_verified from users where id = ${QUICK_MATCH_SYSTEM_USER_ID}`;
    expect(u).toEqual({ email: QUICK_MATCH_SYSTEM_USER_EMAIL, password_hash: null, google_sub: null, email_verified: false });
  });
});
```

**No entitlement pin tests** (pre-flight D6; standing rule, owner 2026-10-20: behaviour tests only, never a test that watches an entitlement value). Each value the create path needs is proven by the behaviour that needs it:
- the one override seeded, `competitions.max_active` = null, by Task 5's quota test (the system org holds more alive competitions than community's limit);
- device links, true on `community` since `V488__device_links_free.sql:24-27` (and `device-links.ts` no longer gates on them), by Task 8's mint and score.

No other override is seeded. Community already allows the one division (4, `V319__v17_phase1_reorg.sql:14`), the one stage (unlimited, `V471__all_stages_free.sql:5,38`) and six sides (32, `V311__community_scale_caps.sql:41`), and the create path bounds sides and plays itself (Task 5's schema). §7.2's other rows (realtime, news, wallet, branding) stay at community's values without a pin.

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
  export function openHomeToken(enc: Uint8Array): string;  // openWith("DEVICE_LINK_KEK", enc); throws HttpError(503, <message>, "DEVICE_LINK_KEK_MISSING") when !hasValidKek("DEVICE_LINK_KEK"),
                                                           // checked BEFORE openWith, exactly as openSecret does (device-links.ts:154-159). Without it crypto's kek() throws a plain
                                                           // Error (crypto.ts:51-56), a 500 on every system-org pad (Task 9) and every page that rebuilds a link (pre-flight A6).
                                                           // A tampered or wrong-key envelope stays a 500: that is not a configuration gap.
  export function mintVisitorKey(): string;                // "qv_" + randomBytes(32).toString("base64url")
  export function hashVisitorKey(key: string): string;     // sha256 hex (64 chars)
  export function isHomeTokenShaped(s: string): boolean;   // prefix + base64url body of 43 chars
  export function isVisitorKeyShaped(s: string): boolean;  // "qv_" + base64url body of 43 chars; plan 2 T3 re-mints a cookie that fails it (pre-flight B2a)
  ```

- [ ] **Step 1: Write the failing tests**

```ts
const KEK = "a".repeat(64);
afterEach(() => { vi.unstubAllEnvs(); });

it("mints distinct prefixed tokens and hashes deterministically", () => {
  const a = mintHomeToken(), b = mintHomeToken();
  expect(a).not.toBe(b); expect(a.startsWith("qm_")).toBe(true); expect(isHomeTokenShaped(a)).toBe(true);
  expect(hashHomeToken(a)).toBe(hashHomeToken(a)); expect(hashHomeToken(a)).toMatch(/^[0-9a-f]{64}$/);
});
it("seals and opens under DEVICE_LINK_KEK", () => {
  vi.stubEnv("DEVICE_LINK_KEK", KEK);
  const t = mintHomeToken();
  expect(openHomeToken(sealHomeToken(t))).toBe(t);
});
it("refuses to seal with no KEK: the helper's half of Review Focus 4 (the create's half is Task 5)", () => {
  vi.stubEnv("DEVICE_LINK_KEK", "");
  expect(() => sealHomeToken(mintHomeToken())).toThrow(expect.objectContaining({ status: 503, code: "DEVICE_LINK_KEK_MISSING" }));
});
it("refuses to open with no KEK with the same 503, never a plain Error (A6)", () => {
  vi.stubEnv("DEVICE_LINK_KEK", KEK);
  const enc = sealHomeToken(mintHomeToken());
  vi.stubEnv("DEVICE_LINK_KEK", "");
  expect(() => openHomeToken(enc)).toThrow(expect.objectContaining({ status: 503, code: "DEVICE_LINK_KEK_MISSING" }));
});
it("rejects shapes that are not a home token", () => {
  for (const s of ["", "dl_abc", "qm_", "qm_" + "x".repeat(42), "qm_" + "x".repeat(44), "qv_" + "x".repeat(43)]) expect(isHomeTokenShaped(s)).toBe(false);
});
it("mints distinct prefixed visitor keys and hashes them deterministically (B2a)", () => {
  const a = mintVisitorKey(), b = mintVisitorKey();
  expect(a).not.toBe(b); expect(a.startsWith("qv_")).toBe(true); expect(isVisitorKeyShaped(a)).toBe(true);
  expect(hashVisitorKey(a)).toBe(hashVisitorKey(a)); expect(hashVisitorKey(a)).toMatch(/^[0-9a-f]{64}$/);
  expect(hashVisitorKey(a)).not.toBe(hashVisitorKey(b));
});
it("rejects shapes that are not a visitor key (B2a)", () => {
  for (const s of ["", "qv_", "qv_" + "x".repeat(42), "qv_" + "x".repeat(44), "qv_" + "!".repeat(43), "qm_" + "x".repeat(43)]) expect(isVisitorKeyShaped(s)).toBe(false);
});
```

- [ ] **Step 2: Run to verify failure** (`DATABASE_URL= npx vitest run src/server/usecases/__tests__/quick-match-tokens.test.ts`, expected: module not found)
- [ ] **Step 3: Implement the module** with the signatures above. `crypto.ts` reads the KEK from `process.env` on every call (`kek()` `:51-56`, `hasValidKek` `:61-63`) and caches nothing, so the "no KEK" tests stub the env in-process with `vi.stubEnv`; no `vi.resetModules()` is needed. `vi.unstubAllEnvs()` in the `afterEach` restores it.
- [ ] **Step 4: Run to verify pass** (expected: PASS, 7 tests)
- [ ] **Step 5: Mutate once:** delete the `hasValidKek` check from `openHomeToken`, confirm the "refuses to open" test fails (a plain `Error` carries no `status`), restore from a `cp` backup.

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
  it("rolls back with the caller: no status, no event, no promotion (pre-flight B3)", async () => {
    const { auth } = await seedOrg(); const div = await seedLeagueDivision(auth, 3);
    const compStatus = async () => (await withTenant(auth.orgId, (tx) => tx`
      select c.status from competitions c join divisions d on d.competition_id = c.id where d.id = ${div.id}`))[0].status;
    const before = await compStatus();
    await expect(withTenant(auth.orgId, async (tx) => {
      const out = await startDivisionInTx(tx, auth, div.id, div.stageId, {});
      expect(out.started).toBe(true);                                  // it did run, inside this transaction
      throw new Error("the caller failed after the start");
    })).rejects.toThrow("the caller failed after the start");
    const [d] = await withTenant(auth.orgId, (tx) => tx`select status from divisions where id = ${div.id}`);
    expect(d.status).toBe("setup");
    const events = await withTenant(auth.orgId, (tx) => tx`
      select 1 from division_events where division_id = ${div.id} and type = 'division_started'`);   // V220: division_events.type
    expect(events).toHaveLength(0);
    expect(await compStatus()).toBe(before);
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
- Modify: `apps/web/src/server/usecases/stages.ts` (one additive export, `previewStageDraw`, beside `previewDivisionFixtures` `:2778`; see Step 3)
- Test: `apps/web/src/server/usecases/__tests__/quick-match-preview.test.ts` (no DB)

**Interfaces:**
- Consumes: `previewDivisionFixtures(stages: PreviewStageInput[], count: number): PreviewPhase[]` (`stages.ts:2778`; `PreviewStageInput {kind, name, config, progression}` `:2683-2688`), the spec's named source for the count (C17), here only as the test's differential. Its output is English strings: `PreviewMatch { home: string; away: string }` (`:2670-2682`), stage-1 sides named `A, B, C…` (`alphaLabel` `:2690-2700`), round titles `"Round n"` or the bracket round role through `msg()` (`:2879-2895`), later-round sides "Winner of R1·1" through `resolveSlotLabel(…, msg, …)` (`:2834-2843`), and a bye line's `away` the English `msg("bracket.slot.bye")` (`:2874`). A setup screen in fr, es or nl would show that English (C10), so the quick match preview is built from the generator's STRUCTURE instead (pre-flight C2), through the new `previewStageDraw` below. It runs the same private `generate()` (`:2607`) over the same placeholder entrants (`e1..eN`, seed i, `:2810-2815`), so there is still one bracket algorithm (C22, §4).
- Produces:
  ```ts
  // stages.ts, beside previewDivisionFixtures. Additive; previewDivisionFixtures and every live path are untouched.
  export interface PreviewDrawFixture {
    roundNo: number;
    seqInRound: number;
    homeSeed: number | null;                          // the placeholder's seed (e<i> is seed i); null when the seat is fed or empty
    awaySeed: number | null;
    homeFrom: { round: number; seq: number } | null;  // "the winner of round·seq": the same {round, seq} refByExt builds (:2832)
    awayFrom: { round: number; seq: number } | null;
    bye: boolean;                                     // f.award !== undefined, the flag previewDivisionFixtures reads (:2874)
    role: RoundRole | null;                           // roundRoleFor(…) for BRACKET_KINDS (:5486), exactly as :2879-2895 computes it; null for a league
  }
  export function previewStageDraw(stage: PreviewStageInput, count: number): PreviewDrawFixture[];

  // quick-match-preview.ts. No string here is copy: plan 2 localizes (pre-flight C2).
  export type QuickMatchFormat = "league" | "knockout";
  export interface QuickMatchPreviewSide { seed: number | null; feeder: { round: number; seq: number } | null }   // seed i = the i-th side as typed (plan 2 maps it to that name); feeder = the winner of round·seq; both null on a bye's empty seat
  export interface QuickMatchPreviewLine { home: QuickMatchPreviewSide; away: QuickMatchPreviewSide; bye: boolean }
  export interface QuickMatchPreviewRound { roundNo: number; role: RoundRole | null; lines: QuickMatchPreviewLine[] }
  // role: the engine's typed round role (RoundRole from @seazn/engine/competition), named by plan 2 with roundRoleLabel(t, role) (lib/round-role-label.ts:21); null for a league round, which plan 2 calls "Round {n}"
  export interface QuickMatchPreview { matchCount: number; byeCount: number; rounds: QuickMatchPreviewRound[] }
  export interface QuickMatchStageInput { kind: QuickMatchFormat; name: string; config: { legs: number } | Record<string, never>; progression: null }
  export function quickMatchPreview(input: { format: QuickMatchFormat; sides: number; plays: number }): QuickMatchPreview;
  export function quickMatchStageInput(input: { format: QuickMatchFormat; plays: number; name: string }): QuickMatchStageInput;
  // {kind:"league", config:{legs: plays}} or {kind:"knockout", config:{}}, progression null. It is a PreviewStageInput, and Task 5's CreateStage once
  // `seq: 1` is added: ONE stage input for the preview and the create, so the count cannot drift (pre-flight A8)
  ```
  `matchCount` counts lines that are not byes (a bye is not a match); `byeCount` counts the byes.

- [ ] **Step 1: Write the failing tests** (values from the generator's documented rules, not from running it: round robin `N(N-1)/2 × legs`; knockout padded to a power of two with byes to the top seeds, `apps/web/src/lib/division-builder/format-estimate.ts:43-46`; seed i plays N+1−i, C22; the bye holders for 3, 5 and 6 sides from spec §7.3 step 3)

```ts
const pairs = (r: QuickMatchPreviewRound) => new Set(r.lines.filter((l) => !l.bye).map((l) => [l.home.seed, l.away.seed].sort().join("v")));

// [3,1,3] and [5,2,20] are odd fields: where a round-robin phantom bye could leak into the count (pre-flight B4)
it.each([[2,1,1],[2,3,3],[3,1,3],[4,1,6],[4,2,12],[5,2,20],[6,4,60]])("league %i sides × %i plays = %i matches", (sides, plays, n) => {
  expect(quickMatchPreview({ format: "league", sides, plays }).matchCount).toBe(n);
});
it.each([[2,1,0],[3,2,1],[4,3,0],[5,4,3],[6,5,2]])("knockout %i sides = %i matches, %i byes", (sides, n, byes) => {
  const p = quickMatchPreview({ format: "knockout", sides, plays: 1 });
  expect(p.matchCount).toBe(n); expect(p.byeCount).toBe(byes);
});
it("knockout of 4 pairs seed 1 v 4 and 2 v 3 in round one (C22)", () => {
  // the PAIRING is the assertion, not the line order
  expect(pairs(quickMatchPreview({ format: "knockout", sides: 4, plays: 1 }).rounds[0])).toEqual(new Set(["1v4", "2v3"]));
});
it.each([[3, [1]], [5, [1, 2, 3]], [6, [1, 2]]])("knockout of %i: the byes go to seeds %j (spec §7.3 step 3)", (sides, holders) => {
  const r1 = quickMatchPreview({ format: "knockout", sides, plays: 1 }).rounds[0];
  expect(r1.lines.filter((l) => l.bye).map((l) => l.home.seed).sort()).toEqual(holders);
  expect(r1.lines.filter((l) => l.bye).every((l) => l.away.seed === null && l.away.feeder === null)).toBe(true);
});
it("a later knockout round names its sides by feeder, never by seed or by text, and every knockout round carries the engine's role", () => {
  const p = quickMatchPreview({ format: "knockout", sides: 4, plays: 1 });
  const [final] = p.rounds[1]!.lines;
  expect(final!.home.seed).toBeNull(); expect(final!.away.seed).toBeNull();
  const feeders = [final!.home.feeder, final!.away.feeder];
  expect(feeders.every((f) => f?.round === 1)).toBe(true); expect(new Set(feeders.map((f) => f!.seq)).size).toBe(2);
  expect(p.rounds.every((r) => r.role !== null)).toBe(true);
  expect(quickMatchPreview({ format: "league", sides: 4, plays: 1 }).rounds.every((r) => r.role === null)).toBe(true);
});
it("matchCount equals previewDivisionFixtures' non-bye lines for every format, side count and plays (C17 differential)", () => {
  const bye = msg("bracket.slot.bye");   // a test file: the bye-render-sites scan reads non-test files only
  let checked = 0;
  for (const format of ["league", "knockout"] as const) for (let sides = 2; sides <= 6; sides++) for (const plays of format === "league" ? [1, 2, 3, 4] : [1]) {
    const lines = previewDivisionFixtures([quickMatchStageInput({ format, plays, name: "x" })], sides)[0]!.sections.flatMap((s) => s.matches);
    expect(quickMatchPreview({ format, sides, plays }).matchCount, `${format} ${sides}×${plays}`).toBe(lines.filter((m) => m.away !== bye).length);
    checked++;
  }
  expect(checked).toBe(25);   // 5 side counts × (4 plays + 1): anti-vacuity
});
```

- [ ] **Step 2: Run to verify failure**
- [ ] **Step 3: Implement** `previewStageDraw` in `stages.ts` directly below `previewDivisionFixtures`: the same `poolIds` (`:2783`) and placeholder entrants (`:2810-2815`), the same `generate(stage.kind, stage.config, entrants, poolIds)` call, the same `refByExt` (`:2832`) and `laneFixtures` (`:2860`), and per `GenFixture` (`:1237-1257`) the fields above; a `generate()` that throws returns `[]`, as the preview's own catch does. `previewDivisionFixtures` is not changed by a line. Then `quickMatchStageInput` and `quickMatchPreview` in `quick-match-preview.ts`, a thin fold over `previewStageDraw(quickMatchStageInput(...), sides)` grouped by `roundNo`. No bye-render-sites `EXEMPT` row is owed: neither file holds a bye copy key or a `resolveSlotLabel` call (the scan's header, `lib/__tests__/bye-render-sites-read-unseated-loser.test.ts:7-20`). The renderer that turns `bye: true` into words is plan 2's, and the row moves with it. **TEST-STRATEGY item 9** (`docs/superpowers/TEST-STRATEGY.md:88-89`, a PR touching `stages.ts`): the rows affected are league and knockout preview only, sport-independent (the preview takes no sport); Step 4 runs them.
- [ ] **Step 4: Run to verify pass** (with the label's env loaded: `npx vitest run src/server/usecases/__tests__/quick-match-preview.test.ts src/server/usecases/__tests__/stages-preview-slot-labels.test.ts src/server/usecases/__tests__/bracket-round-role.test.ts src/server/usecases/__tests__/preview-qualifier-sizing.test.ts src/app/api/v1/format-preview/__tests__/route.test.ts src/lib/__tests__/bye-render-sites-read-unseated-loser.test.ts`; expected: PASS, 18 tests in the preview file, the existing preview suites and the scan unchanged. If the knockout counts differ from the table above, the table was wrong about the generator, not the generator: re-derive from `format-estimate.ts` and record the correction in the test's comment)
- [ ] **Step 5: Mutate once:** make `previewStageDraw` report `bye: false` for every fixture, confirm the bye-holder and count tests fail, restore from a `cp` backup.

---

### Task 5: Create a quick match, or nothing

**Execution order (pre-flight A9).** The create is split in two so that Tasks 5 and 6 stop depending on each other. Steps 1 to 5 build the UNGUARDED tree, `createQuickMatchTree`, which Task 6's probe drives. Then run **Task 6**. Steps 6 to 10 build the GUARDED `createQuickMatch` over the tree; its guards read Task 6's `offerFor` and the generated offer JSON. The probe never goes through the offer it is producing, so its first run on the empty stub JSON can bootstrap.

**Files:**
- Create: `apps/web/src/server/usecases/quick-match-create.ts`
- Create: `apps/web/src/server/usecases/quick-match-delete.ts`
- Modify: `apps/web/src/server/api-v1/schemas.ts` (append `CreateQuickMatch`)
- Modify: `apps/web/src/lib/analytics-events.ts` (`EVENTS.QUICK_MATCH_CREATED`, in the object at `:12-90`) and `apps/web/src/lib/posthog-server.ts` (the system-org guard in `captureServer`, `:41-55`) (pre-flight D11; Steps 6 to 10)
- Test: `apps/web/src/server/usecases/__tests__/quick-match-create.test.ts`
- Test: `apps/web/src/lib/__tests__/posthog-server-quick-match.test.ts` (no DB; the harness of `posthog-server.test.ts:1-25`)

**Interfaces:**
- Consumes: `createCompetition(auth, input: CreateCompetition)` (`competitions.ts:309`; schema `schemas.ts:180-206`, `ends_on` required `:191`), `createDivision(auth, competitionId, input)` (`divisions.ts:259`; it pins `sports.module_version`, `:307-324`), `createStages(auth, divisionId, input)` (`stages.ts:588`; `CreateStages` is one stage or an array, `schemas.ts:1308`; `CreateStage {seq, kind, name, config, progression?}` strict, `:1297-1305`; league config `{ legs }` `schemas.ts:1238`), `createEntrants(auth, divisionId, inputs)` (`entrants.ts:351`; `CreateEntrant {kind, display_name, seed, members}` `schemas.ts:687`, `display_name` max `ENTRANT_NAME_MAX` = 200, `lib/entrant-roster-name.ts:26`), `generateStageFixturesTx(tx, auth, stageId, {}, "record")` (`stages.ts:3481`; returns `GenerateWrite {outcome, divisionId, competitionId, kind}` `:2963-2972`), `afterGenerateCommit(auth, stageId, write)` (`stages.ts:3427-3445`: the table refold, the stage revalidation and the generate event that `generateStageFixturesTx` leaves to its caller), `startDivisionInTx` (Task 3), `afterScheduleWrite(divisionId, competitionId, "start", fixtureIds)` (`schedule.ts:108`), `withTenant` (`lib/db.ts:283`, never nested, `:279-281`), `sql` (`:332`), `resolveModule(sport_key, module_version)` from `@/server/engine-db`, `AuthCtx` from `@/server/api-v1/auth` (`:19-34`), `EntrantKind` (`schemas.ts:144`), Task 2 token helpers, Task 4 `quickMatchPreview` and `quickMatchStageInput`, Task 1 constants, `LOCALES`/`DEFAULT_LOCALE` from `lib/i18n-constants.ts` (`:6-8`; there is no `LocaleSchema` in the repo), `captureServer` (`lib/posthog-server.ts:41`) and `EVENTS` (`lib/analytics-events.ts:12`); Task 6 `offerFor` (Steps 6 to 10 only); in the tests, `isBye` (`lib/run-sheet-groups.ts:179-185`).
- Produces:
  ```ts
  // schemas.ts — relative imports with the .ts extension, like every other import there (schemas.ts:20-30: the
  // standalone OpenAPI generator loads this file under bare `node --experimental-strip-types`, which has no `@/` alias):
  //   import { LOCALES, DEFAULT_LOCALE } from "../../lib/i18n-constants.ts";
  //   import { QUICK_MATCH_MIN_SIDES, QUICK_MATCH_MAX_SIDES, QUICK_MATCH_MAX_PLAYS } from "../../lib/quick-match-constants.ts";
  export const CreateQuickMatch = z.object({
    name: z.string().trim().min(1).max(80),
    sport_key: z.string().min(1), variant_key: z.string().min(1),
    kind: EntrantKind,   // D2: its own input, chosen by the setup's switch, checked against offerFor(...).kinds. Required: when the switch is
                         // hidden the client sends the sport's only kind, as it sends "league" when the format row is hidden (C3)
    format: z.enum(["league", "knockout"]),
    sides: z.array(z.string().trim().min(1).max(60)).min(QUICK_MATCH_MIN_SIDES).max(QUICK_MATCH_MAX_SIDES),   // E1: over 60 UTF-16 units is refused, never clipped
    plays: z.number().int().min(1).max(QUICK_MATCH_MAX_PLAYS).default(1),
    email: z.string().email().max(254).nullable().default(null),
    locale: z.enum(LOCALES).default(DEFAULT_LOCALE),   // precedent: app/api/funnel/start/route.ts:21
  }).strict();
  export type CreateQuickMatch = z.infer<typeof CreateQuickMatch>;

  // quick-match-create.ts
  export interface CreatedQuickMatch { id: string; competitionId: string; divisionId: string; stageId: string; token: string; matchCount: number; expiresAt: Date }
  export const QUICK_MATCH_ERRORS = {
    TOO_MANY_ALIVE: "QUICK_MATCH_TOO_MANY_ALIVE",
    FORMAT_NOT_OFFERED: "QUICK_MATCH_FORMAT_NOT_OFFERED",
    SPORT_NOT_OFFERED: "QUICK_MATCH_SPORT_NOT_OFFERED",
    KIND_NOT_OFFERED: "QUICK_MATCH_KIND_NOT_OFFERED",   // D2: a kind the sport does not take
  } as const;
  export function systemAuth(): AuthCtx; // { orgId: QUICK_MATCH_SYSTEM_ORG_ID, via: "session", userId: QUICK_MATCH_SYSTEM_USER_ID, role: "owner", keyId: null }
  export interface SealedHomeToken { token: string; hash: string; enc: Buffer }
  export function sealNewHomeToken(): SealedHomeToken;   // mintHomeToken → hashHomeToken → sealHomeToken (Task 2): 503 DEVICE_LINK_KEK_MISSING, touching nothing
  export async function createQuickMatchTree(           // UNGUARDED: no offer, kind or format check. Its only callers are Task 6's probe and createQuickMatch (A9)
    input: Omit<CreateQuickMatch, "kind">,
    kind: EntrantKind,
    ctx: { visitorHash: string; home: SealedHomeToken; now?: Date; _failBeforeGenerateForTests?: () => void },
  ): Promise<CreatedQuickMatch>;
  export async function createQuickMatch(               // GUARDED: what plan 2's route calls
    input: CreateQuickMatch,
    ctx: { visitorHash: string; now?: Date; _failBeforeGenerateForTests?: () => void },
  ): Promise<CreatedQuickMatch>;

  // quick-match-delete.ts (privileged; the sweep and compensation use it)
  export async function hardDeleteQuickMatchCompetition(competitionId: string): Promise<void>; // sql.begin: delete email_outbox rows where ref_type='quick_match' and ref_id = the quick_matches id (free-text ref, V470__email_outbox.sql:38-39); delete quick_matches; delete competitions (cascades per §7.8)
  ```
  Every refusal is `new HttpError(status, "<English message>", QUICK_MATCH_ERRORS.<CODE>)`: the code is the THIRD argument (`lib/errors.ts:12-22`, pre-flight B5a). The English message is for logs and API callers; plan 2 maps the code to copy.

  One alive count, used twice: `alive(db, visitorHash, now)` = `select count(*)::int from quick_matches where visitor_hash = ${visitorHash} and saved_by_user_id is null and expires_at > ${now}`.

  Order inside `createQuickMatch` (the wrapper, Steps 6 to 10):
  0. `const home = sealNewHomeToken()`: mint, hash and seal BEFORE any read or write. A missing KEK refuses 503 `DEVICE_LINK_KEK_MISSING` with nothing written, as device links seal "BEFORE any write" (`device-links.ts:161-170`) (pre-flight E2 and A4; Review Focus 4).
  1. `alive(sql, visitorHash, now)` ≥ `QUICK_MATCH_MAX_ALIVE_PER_VISITOR` → `new HttpError(429, …, QUICK_MATCH_ERRORS.TOO_MANY_ALIVE)`. This is the early refusal. The locked recount in the tree's step 3b is the race guard (B5f).
  2. `const offer = await offerFor(sport_key, variant_key)` (Task 6): `!offer.offered` → 422 `SPORT_NOT_OFFERED`; `!offer.kinds.includes(kind)` → 422 `KIND_NOT_OFFERED` (D2; chess's kinds are `["individual"]`); `format === "knockout" && (!offer.knockoutAllowed || sides.length <= 2)` → 422 `FORMAT_NOT_OFFERED` (C23 with D10, and C16).
  3. `const { kind, ...rest } = input; const out = await createQuickMatchTree(rest, kind, { visitorHash, home, now, _failBeforeGenerateForTests })`.
  4. After it returns: `captureServer({ event: EVENTS.QUICK_MATCH_CREATED, distinctId: QUICK_MATCH_SYSTEM_USER_ID, orgId: QUICK_MATCH_SYSTEM_ORG_ID, properties: { quick_match_id: out.id, sport_key, variant_key, kind, format, sides: sides.length, plays } })`, with no name, email or token (D11). The tree's organizer events all carry `orgId`, so the guard below drops them: `COMPETITION_CREATED` (`competitions.ts:279-281`), `DIVISION_CREATED` (`divisions.ts:252-254`), `SCHEDULE_GENERATED` (`stages.ts:3438-3443`), and later `RESULT_ENTERED` from scoring (`engine-db/append-event.ts:796-798`).

  Order inside `createQuickMatchTree` (Steps 1 to 5):
  1. `createCompetition(auth, { name, visibility: "private", branding: {}, starts_on: today, ends_on: today + QUICK_MATCH_ENDS_ON_DAYS })`.
  2. in `try`: `createDivision(auth, competition.id, { name, sport_key, variant_key, config: { entrants: { kinds: [kind], defaultKind: kind } } })` with `kind` the parameter (D2); `createStages(auth, division.id, { seq: 1, ...quickMatchStageInput({ format, plays, name }) })`, Task 4's own stage input and never a second inline copy (A8; if `CreateStage`'s config type does not take it as is, `CreateStage.parse(...)` it, one source either way); `createEntrants(auth, division.id, sides.map((display_name, i) => ({ kind, display_name, seed: i + 1, members: [] })))`.
  3. then one `withTenant(SYSTEM_ORG, async (tx) => { … })`, in this order:
     a. `ctx._failBeforeGenerateForTests?.()` (the entrants already exist: the atomicity test's failure point);
     b. ``await tx`select pg_advisory_xact_lock(hashtext(${"qm-visitor:" + ctx.visitorHash}))` `` (the idiom of `schedule.ts:4122` and `device-links.ts:114`), then `alive(tx, …)` again, ≥ the cap → 429 `TOO_MANY_ALIVE`. Two concurrent creates for one visitor at 4 alive both pass the wrapper's step 1; the lock serializes their final transactions, so the second recount sees 5 (B5f);
     c. `const write = await generateStageFixturesTx(tx, auth, stage.id, {}, "record")`;
     d. `const started = await startDivisionInTx(tx, auth, division.id, stage.id, {})`;
     e. `update competitions set status = 'live'`;
     f. insert the `quick_matches` row with `ctx.home.hash`, `ctx.home.enc`, `visitor_hash`, `expires_at = now + 7 d`.

     After it commits, `afterGenerateCommit(auth, stage.id, write)` and `afterScheduleWrite(division.id, competition.id, "start", started.fixtureIds)`: the post-commit work `generateStageFixtures` and `startDivision` each do for themselves (`stages.ts:3419-3420`, `schedule.ts:4209`).
  4. `matchCount = quickMatchPreview({ format, sides: sides.length, plays }).matchCount` (A8): the number the Start button showed (C17). Step 1's tests assert that it equals the generated non-bye count, and Task 6's probe asserts it for every offered sport × variant × kind × side count (D3).
  5. `catch`: `hardDeleteQuickMatchCompetition(competition.id)` then rethrow.

  The competition is set `live` directly because `startDivisionInTx` only promotes `published` → `live` and a guest competition is never published. The two-commit shape is §7.3's recorded deviation (Self-review notes); a crash between the commits is cleaned up by plan 3's sweep (pre-flight D1).

  The `captureServer` guard (D11) is its first statement: `if (args.orgId === QUICK_MATCH_SYSTEM_ORG_ID && args.event !== EVENTS.QUICK_MATCH_CREATED) return;`. `posthog-server.ts` imports `EVENTS` beside `ORG_GROUP` (`:3`) and the import-free constants file.

- [ ] **Step 1: Write the failing tree tests** (Part A)

```ts
// quick-match-create.test.ts
import { randomBytes as kekBytes, randomUUID } from "node:crypto";
const KEK = kekBytes(32).toString("hex");
vi.stubEnv("DEVICE_LINK_KEK", KEK);   // A15: CI's unit job has no KEK (device-links.test.ts:32-37)
vi.mock("@/lib/posthog-server", async (orig) => ({ ...(await orig<typeof import("@/lib/posthog-server")>()), captureServer: vi.fn() }));   // Step 6's D11 test reads its calls

const SYSTEM_ORG = QUICK_MATCH_SYSTEM_ORG_ID;
const uniq = () => `QM ${randomUUID().slice(0, 8)}`;   // A16: every case keys on its own name or visitor, never on the org's totals
const v = () => `test-visitor-${randomUUID()}`;
const sides = ["Ravi & Sam", "Priya & Tom", "Lee & Ana", "Jo & Max"];
let BADMINTON_V: string;   // beforeAll, never typed (B5c): select key from sport_variants where sport_key = 'badminton'
                           //   and is_system and org_id is null order by key limit 1 (V203__sport_variants.sql:1-7)
const input = (over: Partial<Omit<CreateQuickMatch, "kind">> = {}) =>
  ({ name: uniq(), sport_key: "badminton", variant_key: BADMINTON_V, format: "league" as const, sides, plays: 1, email: null, locale: "en" as const, ...over });
// "pair": badminton's entrantModel takes it (engine dist/sports/setbased/badminton.js:88), so Doubles exists (D2)
const tree = (over: Partial<Omit<CreateQuickMatch, "kind">> = {}, kind: EntrantKind = "pair", hook?: () => void) =>
  createQuickMatchTree(input(over), kind, { visitorHash: v(), home: sealNewHomeToken(), _failBeforeGenerateForTests: hook });
const nonBye = (fx: FixtureRow[]) => fx.filter((f) => !isBye(f));
const seedOf = async (divisionId: string) => new Map((await withTenant(SYSTEM_ORG, (tx) =>
  tx<{ id: string; seed: number }[]>`select id, seed from entrants where division_id = ${divisionId}`)).map((e) => [e.id, e.seed]));

it("creates a started league with the promised fixture count", async () => {
  const out = await tree();
  expect(out.matchCount).toBe(quickMatchPreview({ format: "league", sides: 4, plays: 1 }).matchCount);   // A8: the preview's number…
  expect(out.matchCount).toBe(6);                                                                        // …which is 4·3/2 (round robin)
  expect(nonBye(await listDivisionFixtures(systemAuth(), out.divisionId))).toHaveLength(out.matchCount);   // C17: never drifts
  const [d] = await withTenant(SYSTEM_ORG, (tx) => tx`select status from divisions where id = ${out.divisionId}`); expect(d.status).toBe("active");
  const [c] = await withTenant(SYSTEM_ORG, (tx) => tx`
    select status, visibility, discoverable, ends_on - starts_on as days from competitions where id = ${out.competitionId}`);
  expect(c).toEqual({ status: "live", visibility: "private", discoverable: false, days: 365 });   // D9: C21 "a year out" (date columns, V207:10)
  const ents = await withTenant(SYSTEM_ORG, (tx) => tx`select kind, seed from entrants where division_id = ${out.divisionId} order by seed`);
  expect(ents.map((e) => [e.kind, e.seed])).toEqual([["pair", 1], ["pair", 2], ["pair", 3], ["pair", 4]]);   // C20 + D2: the kind passed in, in entry order
  const [q] = await sql`select token_hash, saved_by_user_id from quick_matches where id = ${out.id}`;
  expect(q.token_hash).toBe(hashHomeToken(out.token)); expect(q.saved_by_user_id).toBeNull();
});
it("creates a knockout of 4 with two semi-finals and a final wired", async () => {
  const out = await tree({ format: "knockout" });
  const fx = await listDivisionFixtures(systemAuth(), out.divisionId);   // selects winner_to_fixture (fixtures.ts:381)
  expect(fx.filter((f) => f.round_no === 1)).toHaveLength(2);
  const final = fx.find((f) => f.round_no === 2)!; expect(final.home_entrant_id).toBeNull(); expect(final.away_entrant_id).toBeNull();
  expect(fx.filter((f) => f.round_no === 1).every((f) => f.winner_to_fixture === final.id)).toBe(true);
});
it.each([[3, [1]], [5, [1, 2, 3]], [6, [1, 2]]])("a knockout of %i draws what the preview drew: round-1 pairs, and byes to seeds %j (C22, D4)", async (n, holders) => {
  const out = await tree({ format: "knockout", sides: [...sides, "Kim & Lou", "Ola & Pat"].slice(0, n) });
  const seed = await seedOf(out.divisionId);
  const r1 = (await listDivisionFixtures(systemAuth(), out.divisionId)).filter((f) => f.round_no === 1);
  const madePairs = new Set(nonBye(r1).map((f) => [seed.get(f.home_entrant_id!), seed.get(f.away_entrant_id!)].sort().join("v")));
  const madeByes = r1.filter((f) => isBye(f)).map((f) => seed.get((f.home_entrant_id ?? f.away_entrant_id)!)).sort();
  const p = quickMatchPreview({ format: "knockout", sides: n, plays: 1 }).rounds[0]!;
  expect(madePairs).toEqual(new Set(p.lines.filter((l) => !l.bye).map((l) => [l.home.seed, l.away.seed].sort().join("v"))));
  expect(madeByes).toEqual(p.lines.filter((l) => l.bye).map((l) => l.home.seed).sort());
  // and the spec's own rule (§7.3 step 3), not only the preview's: the create stores a config built at create (stageConfigsAtCreate, stages.ts:473-501), the preview runs {}
  expect(madeByes).toEqual(holders);
});
it("leaves nothing behind when generation fails (atomicity)", async () => {
  const name = uniq();   // B5b: this case's own name, never the org's count (A16)
  await expect(tree({ name }, "pair", () => { throw new Error("boom"); })).rejects.toThrow("boom");
  expect(await sql`select 1 from competitions where org_id = ${SYSTEM_ORG} and name = ${name}`).toHaveLength(0);
  expect(await sql`select 1 from quick_matches where name = ${name}`).toHaveLength(0);
});
it("is never in a public view (§9 visibility, D7)", async () => {
  const out = await tree();
  expect(await sql`select 1 from public_competitions_v where id = ${out.competitionId}`).toHaveLength(0);   // V397__dashboard_theme_key.sql:69-70
  expect(await sql`select 1 from public_discovery_v where id = ${out.competitionId}`).toHaveLength(0);      // V419__discovery_excludes_drafts.sql:29-30
});
it("two quick matches with the same name both create, with distinct slugs (§9 slugs, D7)", async () => {
  const name = uniq(); const a = await tree({ name }); const b = await tree({ name });
  const rows = await sql`select slug from competitions where id in (${a.competitionId}, ${b.competitionId})`;
  expect(rows).toHaveLength(2); expect(new Set(rows.map((r) => r.slug)).size).toBe(2);
});
it("two sides may share a name (Review Focus 2)", async () => {
  const out = await tree({ sides: ["A", "A", "B"] });
  expect(await withTenant(SYSTEM_ORG, (tx) => tx`select 1 from entrants where division_id = ${out.divisionId}`)).toHaveLength(3);
});
it("exactly one division and one stage", async () => { /* by out.competitionId and out.divisionId: 1 division, 1 stage */ });
it("the system org holds more alive quick matches than community's competitions.max_active (§9 quota; D6's behaviour test)", async () => {
  const [{ int_value: cap }] = await sql`
    select int_value from plan_entitlements where plan_key = 'community' and feature_key = 'competitions.max_active'`;   // the plan's own row, not the code under test
  expect(cap).toBeGreaterThan(0);
  for (let i = 0; i <= cap; i++) await tree();   // cap + 1 creates, each its own visitor: without Task 1's null override the last one refuses
});
it("a whitespace side name is refused by the schema (Review Focus 1)", () => {
  expect(CreateQuickMatch.safeParse({ ...input(), kind: "pair", sides: ["A", "   "] }).success).toBe(false);
});
it("a side name over 60 characters is refused, never clipped (Review Focus 1, E1)", () => {
  const ok = (s: string) => CreateQuickMatch.safeParse({ ...input(), kind: "pair", sides: ["A", s] }).success;
  const shuttle = String.fromCodePoint(0x1f3f8);   // one emoji, two UTF-16 units
  expect(ok("x".repeat(60))).toBe(true); expect(ok("x".repeat(61))).toBe(false);
  expect(ok(shuttle.repeat(30))).toBe(true); expect(ok(shuttle.repeat(31))).toBe(false);
});
it("the 7th side is refused by the schema", () => {
  expect(CreateQuickMatch.safeParse({ ...input(), kind: "pair", sides: ["1", "2", "3", "4", "5", "6", "7"] }).success).toBe(false);
});
it("kind is required and must be an entrant kind (D2)", () => {
  expect(CreateQuickMatch.safeParse(input()).success).toBe(false);
  expect(CreateQuickMatch.safeParse({ ...input(), kind: "doubles" }).success).toBe(false);
  expect(CreateQuickMatch.safeParse({ ...input(), kind: "pair" }).success).toBe(true);
});
```

The sport rows exist after `npm run sync:sports` (which `$S up` runs).

- [ ] **Step 2: Run to verify failure**
- [ ] **Step 3: Implement** the schema, `systemAuth`, `sealNewHomeToken`, `createQuickMatchTree` in the order above, and `hardDeleteQuickMatchCompetition`. `createCompetition`'s input type is `CreateCompetition` (its zod output type, so `visibility` and `branding` are required fields); pass `ends_on` as an ISO date string.
- [ ] **Step 4: Run to verify pass** (`npx vitest run src/server/usecases/__tests__/quick-match-create.test.ts`; expected: PASS, 15 tests)
- [ ] **Step 5: Mutate once:** comment out the `catch` compensation, confirm the atomicity test fails, restore from a `cp` backup.

**Now run Task 6.** Steps 6 to 10 need its `offerFor` and the generated offer JSON.

- [ ] **Step 6: Write the failing wrapper tests** (Part B, same file) **and the analytics guard tests**

```ts
// quick-match-create.test.ts, Part B: the guarded wrapper
const base = () => ({ ...input(), kind: "pair" as const });
const reachedTree = () => { throw new Error("reached the tree"); };

it("refuses with 503 before it reads or writes anything when DEVICE_LINK_KEK is unset (Review Focus 4, E2)", async () => {
  const visitorHash = v();
  for (let i = 0; i < 5; i++) await createQuickMatch(base(), { visitorHash });   // at the cap: a seal placed after step 1 answers 429, not 503
  const b = base();
  vi.stubEnv("DEVICE_LINK_KEK", "");
  try {
    await expect(createQuickMatch(b, { visitorHash, _failBeforeGenerateForTests: reachedTree }))
      .rejects.toMatchObject({ status: 503, code: "DEVICE_LINK_KEK_MISSING" });
  } finally { vi.stubEnv("DEVICE_LINK_KEK", KEK); }
  expect(await sql`select 1 from competitions where org_id = ${SYSTEM_ORG} and name = ${b.name}`).toHaveLength(0);
});
it("refuses the 6th alive match for one visitor with 429 QUICK_MATCH_TOO_MANY_ALIVE, before the tree", async () => {
  const visitorHash = v();
  for (let i = 0; i < 5; i++) await createQuickMatch(base(), { visitorHash });
  // the early count answers before the tree; without it, the hook fires first and the rejection is "reached the tree"
  await expect(createQuickMatch(base(), { visitorHash, _failBeforeGenerateForTests: reachedTree }))
    .rejects.toMatchObject({ status: 429, code: "QUICK_MATCH_TOO_MANY_ALIVE" });
});
it("two concurrent creates at 4 alive: exactly one succeeds (the locked recount, B5f)", async () => {
  const visitorHash = v();
  for (let i = 0; i < 4; i++) await createQuickMatch(base(), { visitorHash });
  const both = await Promise.allSettled([createQuickMatch(base(), { visitorHash }), createQuickMatch(base(), { visitorHash })]);
  expect(both.filter((r) => r.status === "fulfilled")).toHaveLength(1);
  expect(both.find((r) => r.status === "rejected")).toMatchObject({ reason: { status: 429, code: "QUICK_MATCH_TOO_MANY_ALIVE" } });
  const [{ n }] = await sql`select count(*)::int as n from quick_matches where visitor_hash = ${visitorHash}`;
  expect(n).toBe(5);
});
it("refuses knockout for a variant whose rules can end level, even when asked directly (Review Focus 5)", async () => {
  const pick = (await listQuickMatchSports()).flatMap((s) => s.variants.filter((x) => !x.knockoutAllowed).map((x) => ({ s, x })))[0];
  expect(pick, "no offered variant refuses knockout: this test has nothing to witness").toBeDefined();   // B5d: never a hard-coded sport
  await expect(createQuickMatch({ ...base(), sport_key: pick!.s.sport_key, variant_key: pick!.x.variant_key, kind: pick!.s.kinds[0]!, format: "knockout" }, { visitorHash: v() }))
    .rejects.toMatchObject({ status: 422, code: "QUICK_MATCH_FORMAT_NOT_OFFERED" });
});
it("refuses knockout with two sides (C16)", async () => {
  expect((await offerFor("badminton", BADMINTON_V)).knockoutAllowed).toBe(true);   // so only the side count can refuse here (§9: badminton is offered knockout)
  await expect(createQuickMatch({ ...base(), format: "knockout", sides: sides.slice(0, 2) }, { visitorHash: v() }))
    .rejects.toMatchObject({ status: 422, code: "QUICK_MATCH_FORMAT_NOT_OFFERED" });
});
it("refuses a sport the probe excluded with QUICK_MATCH_SPORT_NOT_OFFERED", async () => {
  const [g] = await sql`select key from sport_variants where sport_key = 'generic' and is_system and org_id is null order by key limit 1`;   // excluded by the probe (Task 6, B6e)
  await expect(createQuickMatch({ ...base(), sport_key: "generic", variant_key: g.key, kind: "team" }, { visitorHash: v() }))
    .rejects.toMatchObject({ status: 422, code: "QUICK_MATCH_SPORT_NOT_OFFERED" });
});
it("refuses a kind the sport does not take with QUICK_MATCH_KIND_NOT_OFFERED (D2)", async () => {
  const { kinds } = await offerFor("badminton", BADMINTON_V);
  const missing = (["individual", "pair", "team"] as const).find((k) => !kinds.includes(k));
  expect(missing, "badminton takes every kind: this test has nothing to witness").toBeDefined();
  await expect(createQuickMatch({ ...base(), kind: missing! }, { visitorHash: v() }))
    .rejects.toMatchObject({ status: 422, code: "QUICK_MATCH_KIND_NOT_OFFERED" });
});
it("a create emits quick_match_created once, carrying no name, email or token (D11)", async () => {
  const cap = vi.mocked(captureServer); cap.mockClear();
  const b = { ...base(), email: "guest@example.com" };
  const out = await createQuickMatch(b, { visitorHash: v() });
  const ours = cap.mock.calls.map(([a]) => a).filter((a) => a.event === EVENTS.QUICK_MATCH_CREATED);
  expect(ours).toHaveLength(1);
  expect(ours[0]).toMatchObject({ orgId: SYSTEM_ORG, properties: { quick_match_id: out.id, sport_key: "badminton", kind: "pair", format: "league", sides: 4 } });
  const wire = JSON.stringify(ours[0]);
  for (const secret of [b.name, b.email, out.token]) expect(wire).not.toContain(secret);
});
```

```ts
// lib/__tests__/posthog-server-quick-match.test.ts: PostHog CONFIGURED, the SDK mocked (the harness of posthog-server.test.ts:1-25)
const OLD_ENV = { ...process.env };
const capture = vi.fn();
beforeEach(() => {
  vi.resetModules(); capture.mockClear();
  process.env.POSTHOG_KEY = "phc_test";   // read at module load (posthog-server.ts:12)
  vi.doMock("posthog-node", () => ({ PostHog: class { capture = capture; flush = async () => {}; } }));
});
afterEach(() => { process.env = { ...OLD_ENV }; });

it("drops every organizer event for the system org and passes quick_match_created (D11)", async () => {
  const { captureServer } = await import("@/lib/posthog-server"); const { EVENTS } = await import("@/lib/analytics-events");
  const organizer = [EVENTS.COMPETITION_CREATED, EVENTS.DIVISION_CREATED, EVENTS.SCHEDULE_GENERATED, EVENTS.RESULT_ENTERED];
  for (const event of organizer) await captureServer({ event, distinctId: QUICK_MATCH_SYSTEM_USER_ID, orgId: QUICK_MATCH_SYSTEM_ORG_ID });
  expect(capture).not.toHaveBeenCalled();
  await captureServer({ event: EVENTS.QUICK_MATCH_CREATED, distinctId: QUICK_MATCH_SYSTEM_USER_ID, orgId: QUICK_MATCH_SYSTEM_ORG_ID });
  expect(capture).toHaveBeenCalledTimes(1);
});
it("passes the same organizer event for any other org (the negative pair)", async () => {
  const { captureServer } = await import("@/lib/posthog-server"); const { EVENTS } = await import("@/lib/analytics-events");
  await captureServer({ event: EVENTS.COMPETITION_CREATED, distinctId: randomUUID(), orgId: randomUUID() });
  expect(capture).toHaveBeenCalledTimes(1);
});
```

- [ ] **Step 7: Run to verify failure**
- [ ] **Step 8: Implement** `createQuickMatch` in the order above (steps 0 to 4), `EVENTS.QUICK_MATCH_CREATED: "quick_match_created"`, and the `captureServer` guard.
- [ ] **Step 9: Run to verify pass** (`npx vitest run src/server/usecases/__tests__/quick-match-create.test.ts src/lib/__tests__/posthog-server-quick-match.test.ts src/lib/__tests__/posthog-server.test.ts src/lib/__tests__/analytics-events.test.ts`; expected: PASS, 23 tests in the create file (15 + 8), 2 in the guard file, and the two existing analytics files unchanged)
- [ ] **Step 10: Mutate each guard once, one at a time** (pre-flight B5g; AGENTS.md class 3: guards that cover for each other are each mutated alone). Restore from a `cp` backup after each, never `git checkout`, and record each pair in the task report:

  | Mutation | The test that must fail |
  |---|---|
  | Move step 0 (the seal) after step 1 | the 503 test (it answers 429) |
  | Delete the early alive count (step 1) | the 6th-alive test (it answers "reached the tree") |
  | Delete the locked recount (tree step 3b) | the concurrent test (both fulfil; 6 alive) |
  | `!offer.offered` → `false` | the sport-not-offered test |
  | Delete the kinds check | the kind-not-offered test |
  | Delete `!offer.knockoutAllowed` | Review Focus 5's test |
  | Delete `sides.length <= 2` | the C16 test |
  | Delete the `captureServer` guard | the guard file's first test |
  | Delete the `QUICK_MATCH_CREATED` call | the D11 test |

  The compensation was Step 5's. The advisory lock is not separately mutable without a timing harness; the recount mutant is its witness, and the report says so.

---

### Task 6: The sport offer, proven by scoring every sport

**Execution order (pre-flight A9):** after Task 5 Steps 1 to 5 (the probe drives `createQuickMatchTree`) and before Task 5 Steps 6 to 10 (the wrapper's guards read `offerFor` and the JSON written here).

**Files:**
- Create: `apps/web/src/server/usecases/__tests__/_quick-match-probe.ts` (test-only helper, like `_seed.ts` and `_rig.ts`: it imports `@seazn/engine/testkit`, which must never reach a production bundle)
- Create: `apps/web/src/lib/quick-match-offer.generated.json`, committed at Step 1 as the stub `{"engine":"","generatedAt":"","offered":[],"excluded":[]}` so its import resolves before the first write (pre-flight B6c)
- Create: `apps/web/src/server/usecases/quick-match-sports.ts`
- Modify: root `package.json` (script `quick-match:probe`)
- Test: `apps/web/src/server/usecases/__tests__/quick-match-offer.test.ts`

**Interfaces:**
- Consumes: Task 5 `createQuickMatchTree`, `sealNewHomeToken`, `systemAuth` and `hardDeleteQuickMatchCompetition`; Task 4 `quickMatchPreview`; `scoreEvent(auth, fixtureId, input: AppendEventRequest, opts?)` (`scoring.ts:150-157`; `AppendEventRequest {expected_seq, type, payload, idempotency_key?, engine_epoch?, rules_version?}` `schemas.ts:2808-2830`; it answers `ScoreOutcome {seq, outcome, status, event_id}`, `scoring.ts:54-66`) driven with the session-shaped system ctx (the scoring door accepts it as it accepts the pad's device-link ctx, `scoring.ts:582`, `:629`); `listDivisionFixtures` (`fixtures.ts:370`) and `isBye` (`lib/run-sheet-groups.ts:179-185`); `forEachSportAsync` (`@seazn/engine/testkit`, `dist/testkit/for-each-sport.d.ts:23`) over `builtinModules` (`@seazn/engine/sports`, as `scoring-free.test.ts:13,197` does); the engine's own walk, `buildWalk(module, cfg, lineups, seed, maxEvents)` → `{ events, states }` (`dist/testkit/helpers.d.ts:32-35`; it starts from `module.init(cfg, lineups)` and envelopes each event at `seq = events.length`, `dist/testkit/helpers.js:103-111`), `module.outcome(state)` (`dist/sport/module.d.ts:565`), and `onePlayEvent(module, cfg, lineups, prefix)` (`dist/testkit/play-event.d.ts:19`: a module-owned event that moves the score and leaves the match undecided); `resolveModule(sport_key, module_version)` with its `supportsDraws(cfg, "knockout")` (`module.d.ts:643`), `reachableResultKinds(cfg, "league")` (`:652-655`) and `entrantModel`, `module_version` from the `sports` catalog row, the version `createDivision` pins (`divisions.ts:307-324`); `entrantShapeOf` and `registrationDefaultKind` (`apps/web/src/server/usecases/entrant-shape.ts:22-30`, `:52-54`) and `isChessSport` (`@/lib/chess-individual-only`, as `entrant-shape.ts:9` imports it); `withSchemaDefaults(module, cfg)` (`server/engine-db/fixture-cfg.ts:157-165`) for a variant's cfg that no fixture holds yet, and `resolveFixtureCfg(fixture, divisionCfg, stage, module)` (`:119-128`) for a created fixture's fold cfg; `variantWordKey(sport_key, variant_key)` (`lib/variant-label-keys.ts:60-64`); the `sports` (`key`, `module_version`: `V202__sports.sql:5-11`) and `sport_variants` (`sport_key`, `key`, `config`, `is_system`, `org_id`: `V203__sport_variants.sql:1-7`) rows.
- Produces:
  ```ts
  // quick-match-offer.generated.json: written only by the probe's writer, read at runtime by offerFor, pinned by test 1.
  // The refusal's code only, never the engine's message, so a reworded message cannot redden the pin (B6f). No kind per
  // entry: the kind is a per-sport axis that offerFor computes (D2).
  { "engine": "<installed @seazn/engine version, read from node_modules/@seazn/engine/package.json as toolchain.test.ts:477 does>", "generatedAt": "...",
    "offered":  [ { "sport_key": "badminton", "variant_key": "..." }, ... ],
    "excluded": [ { "sport_key": "cricket", "variant_key": "...", "code": "<the refusal's error code>" },
                  { "sport_key": "generic", "variant_key": "...", "code": "QUICK_MATCH_GENERIC" }, ... ] }

  // quick-match-sports.ts
  export interface QuickMatchOffer { offered: boolean; kinds: EntrantKind[]; knockoutAllowed: boolean }
  export async function offerFor(sport_key: string, variant_key: string): Promise<QuickMatchOffer>;
  //  offered:         { sport_key, variant_key } is in the JSON's `offered`
  //  kinds:           isChessSport(sport_key) ? ["individual"] : entrantShapeOf({ sport_key, module_version, config: variant.config }).kinds,
  //                   from the catalog rows, before any division exists (A9, D2)
  //  knockoutAllowed: !mod.supportsDraws(cfg, "knockout") && !level.has("tie") && !level.has("noResult"),
  //                   cfg = withSchemaDefaults(mod, variant.config), level = mod.reachableResultKinds(cfg, "league") (C23 with D10)
  //  An unknown sport or variant answers { offered: false, kinds: [], knockoutAllowed: false }.
  //  The ONE source of these facts: Task 5's guards, listQuickMatchSports and the probe all call it (A9).
  export interface QuickMatchVariant { variant_key: string; labelKey: MessageKey; knockoutAllowed: boolean }
  export interface QuickMatchSport { sport_key: string; labelKey: MessageKey; kinds: EntrantKind[]; variants: QuickMatchVariant[] }
  export async function listQuickMatchSports(): Promise<QuickMatchSport[]>;
  //  sports × system variants where offerFor(...).offered. labelKey is `sport.${sport_key}` and variantWordKey(sport_key, variant_key),
  //  never the English sports.name / sport_variants.name (V203:4), so plan 2 renders them in all 4 locales (C1). A variant with no word key
  //  is not listed. kinds: the sport's own, one list per sport (D2; test 5 pins that every variant agrees).

  // __tests__/_quick-match-probe.ts
  export const PROBE_SEEDS = 32;          // the probe's budgets; an unproven case names both in its failure
  export const PROBE_MAX_EVENTS = 4000;
  export type OfferJson = { engine: string; generatedAt: string; offered: { sport_key: string; variant_key: string }[]; excluded: { sport_key: string; variant_key: string; code: string }[] };
  export function decidingPrefix(module: AnySportModule, cfg: unknown, lineups: LineupPair): EventEnvelope[] | null;
  //  The first seed in 1..PROBE_SEEDS whose buildWalk reaches module.outcome(state) !== null through core.start and MODULE-OWNED events
  //  only, up to and including the deciding event. A walk that draws core.forfeit, core.abandon or any other core.* event before it
  //  decides is skipped (the generator draws them, engine dist/sports/setbased/kernel.js:2147-2157). null = no seed decides (unproven).
  export type PlayResult = { kind: "decided"; events: number; lastSeq: number; lastEventId: string } | { kind: "refused"; code: string } | { kind: "unproven" };
  export async function playToDecided(auth: AuthCtx, fixtureId: string): Promise<PlayResult>;
  //  Reads the fixture's division, stage and seats. lineups = { home: { entrantId: <home seat>, slots: [] }, away: { entrantId: <away seat>, slots: [] } }:
  //  no lineup, and because the walk starts from module.init(cfg, lineups) its events name the fixture's own entrants. cfg = resolveFixtureCfg(…),
  //  the cfg the write path folds with. Posts decidingPrefix's events through scoreEvent with expected_seq = the envelope's seq (the count of
  //  events before it, as scoring-free.test.ts:161-178 counts). A refusal (HttpError or EngineError) → { kind: "refused", code }. The last post
  //  must answer status "decided"; anything else is "unproven": the walk and the write path disagree, so stop and report (§12).
  export async function firstRallyFor(fixtureId: string): Promise<AppendEventRequest[]>;
  //  [core.start, the first PLAY event] for the fixture's own sport, cfg and seats: onePlayEvent(module, cfg, lineups, [the start envelope]),
  //  expected_seq 0 and 1. Throws when onePlayEvent answers null. The walk's first event is core.start (kernel.js:2147-2149), so "the first
  //  event of the sequence" was a start, not a rally (pre-flight A10). Task 8 uses it.
  export async function runQuickMatchProbe(opts: { quiet?: boolean }): Promise<{ offer: OfferJson; checked: number; countCases: number }>;
  ```
  The probe (pre-flight B6 and D3), for every sport module (swept with `forEachSportAsync`, which reports the count it visited) × each of its system variants:
  1. **Generic** is excluded with the code `QUICK_MATCH_GENERIC` and nothing is created. The probe is the one source that keeps generic off the setup screen and out of the API, where Task 5's wrapper answers `SPORT_NOT_OFFERED` (B6e).
  2. **The offer: one full match per sport × variant.** Create a league of 2 sides and 1 play through `createQuickMatchTree`, with the variant's `registrationDefaultKind` (chess: `individual`), a unique name and visitor (A16) and a fresh `sealNewHomeToken()`. Run `playToDecided` on its only fixture: `decided` → `offered`; `refused` → `excluded` with the code; `unproven` → collected. Then hard-delete. The events come from the engine's own generator for that module (the walk its conformance corpora record), never a hand-typed sequence, and with no lineup. (`scoring-free.test.ts` is the precedent for driving `scoreEvent` once per sport over `builtinModules` on a `makeCommunityRig` org, `scoring-free.test.ts:13-18`; it scripts one pad-declared event per sport, not a full match.)
  3. **The counts (D3, offered variants only).** For each kind in `offerFor(...).kinds`, a league of N ∈ {2..6} sides (1 play), and a knockout of N ∈ {3..6} when `offerFor(...).knockoutAllowed`. Each create asserts that its non-bye fixtures (`listDivisionFixtures` filtered by `isBye`), its `matchCount` and `quickMatchPreview(...).matchCount` are one number, and throws naming the case otherwise. Then hard-delete.
  4. The probe fails when any case is unproven (naming it and both budgets), when `offered` is empty, or when it lacks badminton. It returns `checked` (sport × variant cases) and `countCases`, and prints both unless `quiet`.

- [ ] **Step 1: Write the failing offer test, and commit the stub JSON**

```ts
const KEK = kekBytes(32).toString("hex"); vi.stubEnv("DEVICE_LINK_KEK", KEK);   // A15
const WRITING = process.env.QUICK_MATCH_PROBE_WRITE === "1";
const en = uiEn as Record<string, string>;   // import uiEn from "@/dictionaries/en/ui.json", as home-rules.test.ts:14,21 does

// The writer is its own describe, gated on the flag, so a normal run never writes and a write run never compares itself against the
// stale module-level import (pre-flight B6c; the capture precedent, src/demo/ai-templates/__capture__/capture.test.ts:61,371).
describe.skipIf(!HAS_DB || !WRITING)("write the quick match offer (QUICK_MATCH_PROBE_WRITE=1 only)", () => {
  it("writes the probe's offer", async () => {
    const run = await runQuickMatchProbe({ quiet: false });
    writeFileSync(OFFER_JSON_PATH, JSON.stringify(run.offer, null, 2) + "\n");
  }, 30 * 60_000);
});

describe.skipIf(!HAS_DB || WRITING)("quick match offer", () => {
  it("DRIFT PIN: the committed offer equals a fresh probe run on the pinned engine", async () => {
    // Its expected value is this probe's own earlier output, so it proves only that nothing moved. The spec's oracle is the next test (B6g).
    const run = await runQuickMatchProbe({ quiet: true });
    console.info(`quick match probe checked ${run.checked} sport×variant cases and ${run.countCases} count cases`);
    expect(run.checked).toBeGreaterThan(0); expect(run.countCases).toBeGreaterThan(0);   // zero checked is a failure
    expect(run.offer.offered).toEqual(offerJson.offered); expect(run.offer.excluded).toEqual(offerJson.excluded);
  }, 30 * 60_000);   // about 600 creates (D3: "cost: slower DB suite"); AGENTS.md class 20
  it("cricket is excluded and badminton, table tennis and tennis are offered (spec §9)", () => {
    expect(offerJson.excluded.some((e) => e.sport_key === "cricket")).toBe(true);
    for (const k of ["badminton", "tabletennis", "tennis"]) expect(offerJson.offered.some((o) => o.sport_key === k)).toBe(true);
  });
  it("knockoutAllowed is the engine's own declaration for every offered variant, with both values present (C23, D8, D10)", async () => {
    let checked = 0; const seen = new Set<boolean>();
    for (const s of await listQuickMatchSports()) {
      const [row] = await sql`select module_version from sports where key = ${s.sport_key}`;
      const mod = resolveModule(s.sport_key, row.module_version);
      for (const x of s.variants) {
        const [vr] = await sql`select config from sport_variants where sport_key = ${s.sport_key} and key = ${x.variant_key} and is_system and org_id is null`;
        const cfg = withSchemaDefaults(mod, vr.config) as never;
        const level = mod.reachableResultKinds(cfg, "league");
        expect(x.knockoutAllowed, `${s.sport_key}/${x.variant_key}`).toBe(!mod.supportsDraws(cfg, "knockout") && !level.has("tie") && !level.has("noResult"));
        seen.add(x.knockoutAllowed); checked++;
      }
    }
    console.info(`knockout offer checked ${checked} variants`);
    expect(checked).toBeGreaterThan(0);
    expect(seen).toEqual(new Set([true, false]));   // D8: both directions witnessed, whatever football's offer turns out to be
    expect((await listQuickMatchSports()).find((s) => s.sport_key === "badminton")!.variants.some((x) => x.knockoutAllowed)).toBe(true);   // §9
  });
  it("generic is excluded by the probe and never listed (B6e)", async () => {
    expect(offerJson.excluded.some((e) => e.sport_key === "generic" && e.code === "QUICK_MATCH_GENERIC")).toBe(true);
    expect((await listQuickMatchSports()).some((s) => s.sport_key === "generic")).toBe(false);
  });
  it("each sport offers its own kinds, and every name is a dictionary key (C1, D2)", async () => {
    let checked = 0;
    const sports = await listQuickMatchSports();
    for (const s of sports) {
      expect(en[s.labelKey], s.labelKey).toBeTruthy();
      if (isChessSport(s.sport_key)) expect(s.kinds).toEqual(["individual"]);   // owner ruling 2026-10-26
      for (const x of s.variants) {
        expect(en[x.labelKey], x.labelKey).toBeTruthy();
        expect((await offerFor(s.sport_key, x.variant_key)).kinds, `${s.sport_key}/${x.variant_key}`).toEqual(s.kinds);   // a per-sport axis (D2)
        checked++;
      }
    }
    expect(checked).toBeGreaterThan(0);
    // the engine's declaration (dist/sports/setbased/badminton.js:88): Doubles exists, so the switch can offer it
    expect(sports.find((s) => s.sport_key === "badminton")!.kinds).toEqual(expect.arrayContaining(["individual", "pair"]));
  });
  it("offerFor of an unknown sport or variant offers nothing (the empty case)", async () => {
    expect(await offerFor("badminton", "no-such-variant")).toEqual({ offered: false, kinds: [], knockoutAllowed: false });
    expect(await offerFor("no-such-sport", "x")).toEqual({ offered: false, kinds: [], knockoutAllowed: false });
  });
});
```

- [ ] **Step 2: Run to verify failure**
- [ ] **Step 3: Write the probe** (`runQuickMatchProbe`, `decidingPrefix`, `playToDecided` and `firstRallyFor` in `__tests__/_quick-match-probe.ts`) and `quick-match-sports.ts`. The probe cannot be a root `scripts/*.ts`: `tsx` is not a dependency, and every root script runs under bare `node --experimental-strip-types` (`package.json:47-68`, apart from the `db:*` bash wrappers), which resolves neither the `@/` alias nor the `server-only` marker (stubbed only under vitest, `apps/web/vitest.config.ts:199-200`) that the use cases it drives import. The one workaround on main, a `registerHooks` resolve hook (`scripts/w2d/post-deploy-pin.ts:67-71`), cannot carry this probe either: Node 26 strip-only mode refuses constructor parameter properties, which `HttpError` uses (`apps/web/src/lib/errors.ts:13-18`), and every create use case the probe drives imports it. The JSON is generated by the offer test itself under a flag, the `capture:ai-demo` pattern (`package.json:46`; the flag gate `src/demo/ai-templates/__capture__/capture.test.ts:61`): add `"quick-match:probe": "QUICK_MATCH_PROBE_WRITE=1 npm run test --workspace apps/web -- src/server/usecases/__tests__/quick-match-offer.test.ts"` to the root `package.json` scripts.
- [ ] **Step 4: Run the probe once to generate the JSON, then the test** (`npm run quick-match:probe` from the repo root with the label's env loaded: only the writer runs. Then `npx vitest run src/server/usecases/__tests__/quick-match-offer.test.ts` from `apps/web`; expected: PASS, 6 tests with the writer's describe skipped, and the first test's console line reports both counts greater than zero)
- [ ] **Step 5: Mutate once each**, restoring from a `cp` backup: (a) hand-edit one `offered` entry's variant key, confirm the drift pin fails, regenerate with `npm run quick-match:probe`; (b) drop the D10 condition from `offerFor`, confirm the knockout test fails. If (b) survives, no offered variant can pay a tie or a no-result without `supportsDraws` today: record that the D10 condition is vacuous on the current offer, not wrong.

---

### Task 7: Resolve a home token and read the home

**Files:**
- Create: `apps/web/src/server/usecases/quick-match-home.ts`
- Create: `apps/web/src/server/usecases/quick-match-activity.ts` (the two touches; it imports only `@/lib/db` and the constants file, so Task 8's call from the scoring path adds no import of the home read's graph) (pre-flight D5)
- Modify (conditional): `apps/web/src/lib/__tests__/status-set-ledger.ts`, only if `nextPlayable` or the `played` count spells a set of two or more fixture-status literals (pre-flight B7e; Step 3)
- Test: `apps/web/src/server/usecases/__tests__/quick-match-home.test.ts`

**Interfaces:**
- Consumes: Task 2 hashing; `listDivisionFixtures(auth, divisionId)` (`fixtures.ts:370`; it selects `status`, `outcome` and `is_final`, `:379-380`, and is scoped by division only, `:372`, `:391`); `getStandings(auth, stageId, poolId?)` (`stages.ts:6173`; `StandingsOut {stage_id, pool_id, rows, computed_through_seq, updated_at}` `:6162-6170`); `isBye(f)` (`apps/web/src/lib/run-sheet-groups.ts:179-185`, typed on a `Pick` of `FixtureRow`); `SETTLED_FIXTURE_STATUSES` (`lib/fixture-status.ts:33`: `decided`, `forfeited`, `abandoned`); `match_states (fixture_id, org_id, last_seq, state, summary)` (`db/migration/v2-engine/tables/V217__match_states.sql:1-8`); `variantWordKey(sport_key, variant_key)` (`lib/variant-label-keys.ts:60-64`); `EntrantKind` (`schemas.ts:144`); `withTenant`; `sql`; Task 5 `systemAuth`; `Locale` from `@/lib/i18n-constants` (`:7`); in the tests, Task 6's `playToDecided` and `makeUser(name)` (`__tests__/_seed.ts:23`).
- Produces:
  ```ts
  // quick-match-home.ts
  export interface QuickMatchRow { id: string; competitionId: string; name: string; format: QuickMatchFormat; email: string | null; locale: Locale; lastActivityAt: Date; expiresAt: Date | null; savedByUserId: string | null; tokenEnc: Uint8Array }
  export async function resolveQuickMatchToken(token: string): Promise<QuickMatchRow | null>;
  //  null when not shaped, unknown, or expires_at <= now. A null expires_at is ALIVE: a saved row carries none (plan 3), and a bare
  //  `expires_at > now()` would kill every saved link (pre-flight B7a). The predicate is `(expires_at is null or expires_at > now())`.
  export async function findQuickMatchByCompetition(competitionId: string): Promise<QuickMatchRow | null>;
  export interface QuickMatchSide { entrantId: string; name: string }
  export interface QuickMatchFixture {
    id: string; roundNo: number; fixtureNo: number; home: QuickMatchSide | null; away: QuickMatchSide | null;
    homeSlotLabel: unknown; awaySlotLabel: unknown; status: string; summary: unknown; isBye: boolean;
    isFinal: boolean;                    // C10: fixtures.is_final, so plan 2 marks the final without guessing from the round
    winnerEntrantId: string | null;      // C10: outcome.winner when it is a string (an entrant id, lib/outcome-text.ts:78), else null
  }
  export interface QuickMatchHome {
    row: QuickMatchRow; divisionId: string; stageId: string;
    sport: { key: string; labelKey: MessageKey; variantKey: string; variantLabelKey: MessageKey | null };   // C1/C10: keys, never English names
    kind: EntrantKind;                   // C10: the eyebrow's "sport · kind · format" (the entrants' kind, one per quick match, D2)
    sides: QuickMatchSide[]; fixtures: QuickMatchFixture[]; next: QuickMatchFixture | null; live: QuickMatchFixture | null;
    played: number;                      // B7d: non-bye fixtures whose status is in SETTLED_FIXTURE_STATUSES
    total: number;                       // B7d: non-bye fixtures; equals Task 5's matchCount
    standings: StandingsOut | null; allPlayed: boolean;
  }
  export async function readQuickMatchHome(row: QuickMatchRow): Promise<QuickMatchHome | null>;  // null when the competition is gone (Review Focus 3)
  export function nextPlayable(fixtures: QuickMatchFixture[]): QuickMatchFixture | null;  // first by (roundNo, fixtureNo) with status in_play, else scheduled with both sides known

  // quick-match-activity.ts (privileged `sql`: the scoring caller holds no system-org session)
  export async function touchQuickMatchActivity(id: string, now?: Date): Promise<void>;
  export async function touchQuickMatchActivityForFixture(fixtureId: string, now?: Date): Promise<void>;
  //  Both: last_activity_at = now; expires_at = now + QUICK_MATCH_EXPIRY_DAYS when saved_by_user_id is null, else unchanged (a saved
  //  row stays null). The fixture form finds its row through fixtures → divisions → quick_matches.competition_id (unique, so indexed)
  //  in one statement, and touches nothing for a fixture outside a quick match. Task 8 calls it from the scoring path (D5).
  ```
  `summary` is not among `listDivisionFixtures`' columns: read it from `match_states` by `fixture_id` for the fixture ids just listed, under the same `withTenant(SYSTEM_ORG)` and the same competition check (pre-flight B7d).

  Every query in `readQuickMatchHome` runs under `withTenant(SYSTEM_ORG)`. The division lookup carries `and d.competition_id = ${row.competitionId}` and answers `null` when no division matches, before anything else is read (§7.1 point 3). That predicate is the isolation guard: `listDivisionFixtures` is scoped by division only, so without it an arbitrary system-org division answers (pre-flight B7c). `listDivisionFixtures` and `getStandings` each open their own `withTenant` (`fixtures.ts:371`, `stages.ts:6174`): call them in sequence, never from inside another open one (`lib/db.ts:279-281`).

- [ ] **Step 1: Write the failing tests**

```ts
vi.stubEnv("DEVICE_LINK_KEK", kekBytes(32).toString("hex"));   // A15: creates seal a home token
// fixtures: `league4` is a CreateQuickMatch of 4 badminton sides (kind "pair", the variant picked at runtime as Task 5 does);
// `rowOf(out)` = resolveQuickMatchToken(out.token)

it("resolves a live token and refuses the hash, an expired token and a foreign shape", async () => {
  const a = await createQuickMatch(league4, { visitorHash: v() });
  expect((await resolveQuickMatchToken(a.token))!.id).toBe(a.id);
  expect(await resolveQuickMatchToken(hashHomeToken(a.token))).toBeNull();
  expect(await resolveQuickMatchToken("dl_" + a.token.slice(3))).toBeNull();
  await sql`update quick_matches set expires_at = now() - interval '1 second' where id = ${a.id}`;
  expect(await resolveQuickMatchToken(a.token)).toBeNull();
});
it("a saved row with no expiry resolves (B7a)", async () => {
  const a = await createQuickMatch(league4, { visitorHash: v() }); const saver = await makeUser("qm-saver");
  await sql`update quick_matches set saved_by_user_id = ${saver.id}, expires_at = null where id = ${a.id}`;   // plan 3's saved shape
  expect((await resolveQuickMatchToken(a.token))!.id).toBe(a.id);
});
it("a touch on an unsaved row moves its activity and re-arms its expiry 7 days out (B7b)", async () => {
  const a = await createQuickMatch(league4, { visitorHash: v() }); const at = new Date(Date.now() + 3 * 86_400_000);
  await touchQuickMatchActivity(a.id, at);
  const [q] = await sql`select last_activity_at, expires_at from quick_matches where id = ${a.id}`;
  expect(q.last_activity_at.getTime()).toBe(at.getTime());
  expect(q.expires_at.getTime()).toBe(at.getTime() + QUICK_MATCH_EXPIRY_DAYS * 86_400_000);
});
it("a touch on a saved row moves its activity and leaves its expiry null (B7b)", async () => {
  /* as above after the saved update: last_activity_at = at, expires_at still null */
});
it("reads the home with the next match first and 0 of 6 played", async () => {
  const h = (await readQuickMatchHome(row))!;
  expect(h.total).toBe(6); expect(h.played).toBe(0); expect(h.next!.fixtureNo).toBe(1); expect(h.standings!.rows).toHaveLength(4);
  expect(h.kind).toBe("pair"); expect(h.sport).toMatchObject({ key: "badminton", labelKey: "sport.badminton" });
  expect(h.sport.variantLabelKey).toBe(variantWordKey("badminton", h.sport.variantKey));
});
it("never returns another quick match's division or fixtures (isolation)", async () => {
  const a = await createQuickMatch(league4, { visitorHash: v() }); const b = await createQuickMatch(league4, { visitorHash: v() });
  const ha = (await readQuickMatchHome(rowOf(a)))!;
  expect(ha.divisionId).toBe(a.divisionId);   // B7c: catches a dropped division predicate whatever the row order
  const bFixtures = await listDivisionFixtures(systemAuth(), b.divisionId);
  expect(ha.fixtures.map((f) => f.id).some((id) => bFixtures.some((f) => f.id === id))).toBe(false);
});
it("returns null for a token whose competition was hard-deleted (Review Focus 3)", async () => { /* create, hardDeleteQuickMatchCompetition, resolve → null; readQuickMatchHome on a stale row → null */ });
it("knockout of 3: the bye is marked and not counted, the final waits, then follows its semi-final (C10)", async () => {
  const k = await createQuickMatch({ ...league4, format: "knockout", sides: league4.sides.slice(0, 3) }, { visitorHash: v() });
  let h = (await readQuickMatchHome(rowOf(k)))!;
  expect(h.fixtures.filter((f) => f.isBye)).toHaveLength(1);
  expect(h.total).toBe(k.matchCount); expect(h.total).toBe(2);   // the semi-final and the final; the bye is not a match
  const final = h.fixtures.find((f) => f.isFinal)!; expect(final.roundNo).toBe(2);
  expect(h.next!.isFinal).toBe(false);                           // the final has an unknown side: not next
  const semi = h.next!;
  expect(await playToDecided(systemAuth(), semi.id)).toMatchObject({ kind: "decided" });
  h = (await readQuickMatchHome(rowOf(k)))!;
  expect(h.played).toBe(1);
  expect([semi.home!.entrantId, semi.away!.entrantId]).toContain(h.fixtures.find((f) => f.id === semi.id)!.winnerEntrantId);
  expect(h.next!.id).toBe(final.id);                             // both sides of the final are now known
});
it("a void of the deciding event takes the match back: played and the winner follow it (the sequence)", async () => {
  const a = await createQuickMatch(league4, { visitorHash: v() }); let h = (await readQuickMatchHome(rowOf(a)))!;
  const r = await playToDecided(systemAuth(), h.next!.id);
  if (r.kind !== "decided") throw new Error(`precondition: ${JSON.stringify(r)}`);
  h = (await readQuickMatchHome(rowOf(a)))!; expect(h.played).toBe(1);
  // core.void of the last event, expected_seq = the tip (carried-forward-scoring.test.ts:257-262); a settled fixture still takes it (fixture-status.ts:29-32)
  await scoreEvent(systemAuth(), h.fixtures[0]!.id, { expected_seq: r.lastSeq, type: "core.void", payload: { event_id: r.lastEventId } });
  h = (await readQuickMatchHome(rowOf(a)))!;
  expect(h.played).toBe(0); expect(h.fixtures[0]!.winnerEntrantId).toBeNull();
});
```

- [ ] **Step 2: Run to verify failure**
- [ ] **Step 3: Implement** both modules. `isBye` is the shared predicate `isBye(f)` from `@/lib/run-sheet-groups` (`:179-185`: an `award` outcome with one empty seat that is not a withdrawn winner's, `unseatedForfeitLoser`), not a re-derivation; a generated bye row is written `status 'forfeited'` with an award outcome (`stages.ts:3768-3780`), so `played` filters byes out before it tests `SETTLED_FIXTURE_STATUSES`. If `nextPlayable` spells its status test as one set or chain of two or more fixture-status literals (`in_play`, `scheduled`), it owes a row in `apps/web/src/lib/__tests__/status-set-ledger.ts`: `status-set-sweep.test.ts` scans `apps/web/src` and reds an unclassified set (`:1-15`). Reuse `SETTLED_FIXTURE_STATUSES` for `played`; a new literal set there owes the same row.
- [ ] **Step 4: Run to verify pass** (`npx vitest run src/server/usecases/__tests__/quick-match-home.test.ts`, plus `src/lib/__tests__/status-set-sweep.test.ts` if the ledger changed; expected: PASS, 9 tests)
- [ ] **Step 5: Mutate each guard once**, restoring from a `cp` backup: (a) drop the `competition_id` predicate from the DIVISION lookup (the fixtures read has none, B7c), confirm the isolation test fails on `ha.divisionId`; (b) make the resolve predicate a bare `expires_at > now()`, confirm the saved-row test fails.

---

### Task 8: Mint a device link for a guest, and count a score as activity

**Files:**
- Modify: `apps/web/src/server/usecases/device-links.ts` (append; `lockFixtureLinks` `:113-115`, `linkableStatus(tx, fixtureId, competitionId?)` `:122-131`, `loadLinkableFixture(tx, fixtureId, competitionId?)` `:133-138`, `ensureInTx` `:208-218`, `ensureLocked` `:235-255`)
- Modify: `apps/web/src/server/usecases/scoring.ts` (the `try`/`finally` after the append, `:358-371`) (pre-flight D5)
- Test: `apps/web/src/server/usecases/__tests__/quick-match-device-link.test.ts`

**Interfaces:**
- Consumes: Task 7 `QuickMatchRow` and `touchQuickMatchActivityForFixture` (`quick-match-activity.ts`); Task 5 `systemAuth`; Task 6 `firstRallyFor`; `rateLimit(key, cfg)` (`lib/rate-limit.ts:60`, Redis-backed, no DB connection) and `DEVICE_LINK_MINT_LIMIT` (`:105`, 10 per 60 s); `resolveDeviceLinkToken` (`device-links.ts:445`; returns `{id, org_id, fixture_id, issued_by}`); `EnsuredDeviceLink {row, secret, minted}` (`:201-206`); `score_events.type` (`db/migration/v2-engine/tables/V216__score_events.sql:9`).
- Produces:
  ```ts
  export async function ensureGuestDeviceLink(qm: QuickMatchRow, fixtureId: string): Promise<EnsuredDeviceLink>;
  ```
  `rateLimit("qm-mint:" + qm.id, DEVICE_LINK_MINT_LIMIT)` first; then inside one `withTenant(SYSTEM_ORG)`: `lockFixtureLinks(tx, fixtureId)`; `loadLinkableFixture(tx, fixtureId, qm.competitionId)` (404 when the fixture is not in that competition, `:127-129`; 422 when finalized or cancelled, `:135-137`); `new HttpError(422, …, "QUICK_MATCH_SIDES_UNKNOWN")` (the code is the third argument, B5a) when either seat is null; then `ensureLocked(tx, systemAuth(), fixtureId, "quick-match")`, which re-shows the live sealed link or mints one issued by the system user (`mintInTx` writes `issued_by = auth.userId`, `:171-178`), bypassing `requireSessionEditor` (`:94-100`).

  **The activity touch (pre-flight D5).** Spec C1 runs the 7 days from the last activity, "creation or the last score", and before this task no scored event touched the row: a pad scored for days without a return to the home would expire 7 days after the last Score tap. In `scoreEvent`'s `finally` (`scoring.ts:369-371`), after `invalidateAndPush` (`:370`): `if (auth.orgId === QUICK_MATCH_SYSTEM_ORG_ID) await touchQuickMatchActivityForFixture(fixtureId).catch((err: unknown) => log.error({ err, fixture: fixtureId }, "scoring: quick match activity touch failed (the score stands)"))`, the file's own catch-and-log idiom (`:448-449`). It runs only after the append committed: a refused write (409 `SEQ_CONFLICT`, 422) throws before the `try` at `:358` and touches nothing. One indexed update by competition (Task 7); every other org pays one comparison.

- [ ] **Step 1: Write the failing tests**

```ts
vi.stubEnv("DEVICE_LINK_KEK", kekBytes(32).toString("hex"));   // A15: the mint seals its secret (device-links.ts:161-170)

const post = (secret: string, fixtureId: string, body: AppendEventRequest) =>
  POST(new Request(`http://x/api/v1/fixtures/${fixtureId}/events`, { method: "POST", headers: { authorization: `Bearer ${secret}`, "content-type": "application/json" }, body: JSON.stringify(body) }), { params: Promise.resolve({ id: fixtureId }) });

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
  for (const e of await firstRallyFor(fx[0].id)) expect((await post(secret, fx[0].id, e)).status).toBe(201);   // core.start, then the first play (A10)
  // the walk's first event is core.start (engine sports/setbased/kernel.js:2147-2149): only a non-core row proves a rally was scored
  expect(await sql`select count(*)::int as n from score_events where fixture_id = ${fx[0].id} and type not like 'core.%'`).toEqual([{ n: 1 }]);
});
it("a score through the guest link touches the quick match; a refused write does not (D5)", async () => {
  const { secret } = await ensureGuestDeviceLink(row, fx[1].id);
  await sql`update quick_matches set last_activity_at = now() - interval '2 days', expires_at = now() + interval '5 days' where id = ${row.id}`;
  const [before] = await sql`select last_activity_at, expires_at from quick_matches where id = ${row.id}`;
  const [start] = await firstRallyFor(fx[1].id);
  expect((await post(secret, fx[1].id, { ...start!, expected_seq: 99 })).status).toBe(409);   // stale seq: nothing committed
  expect((await sql`select last_activity_at, expires_at from quick_matches where id = ${row.id}`)[0]).toEqual(before);
  expect((await post(secret, fx[1].id, start!)).status).toBe(201);
  const [after] = await sql`select last_activity_at, expires_at from quick_matches where id = ${row.id}`;
  expect(after.last_activity_at.getTime()).toBeGreaterThan(before.last_activity_at.getTime());
  expect(after.expires_at.getTime() - after.last_activity_at.getTime()).toBe(QUICK_MATCH_EXPIRY_DAYS * 86_400_000);
});
```

`POST` is the real route handler from `app/api/v1/fixtures/[id]/events/route.ts` (`:11-18`: `parseBody(AppendEventRequest)`, `requireFixtureActor(req, id, "score")`, `scoreEvent`), one event per request. `firstRallyFor(fixtureId)` (Task 6, `__tests__/_quick-match-probe.ts`) answers `[core.start, the first play event]` for the fixture's own sport, cfg and seats, at `expected_seq` 0 and 1 (pre-flight A10).

- [ ] **Step 2: Run to verify failure**
- [ ] **Step 3: Implement** `ensureGuestDeviceLink` in `device-links.ts` beside `ensureDeviceLink` (`:262-269`). No extraction is owed: the body after `requireSessionEditor` already exists as `ensureInTx` (`:208-218`: lock, `loadLinkableFixture` scoped to a competition, `ensureLocked`), and its parts are module-private helpers the new function calls directly, with the sides check between `loadLinkableFixture` and `ensureLocked`. Then the touch in `scoring.ts`, as above.
- [ ] **Step 4: Run the new test, the existing device-link suites and the scoring suites that cover `scoring.ts`** (`npx vitest run src/server/usecases/__tests__/quick-match-device-link.test.ts src/server/usecases/__tests__/device-links.test.ts src/server/usecases/__tests__/device-link-sealed-secret-migration.test.ts src/server/usecases/__tests__/scoring-free.test.ts src/server/usecases/__tests__/score-revalidate-in-request.test.ts`), expected: PASS, 5 new tests, nothing previously green turns red.
- [ ] **Step 5: Mutate each guard once** (pre-flight B8), restoring from a `cp` backup: (a) delete the sides check, confirm the knockout-final test fails (the mint resolves); (b) delete the touch in `scoring.ts`, confirm the D5 test fails; (c) move the touch before the append, confirm the D5 test fails on the 409 leg.

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
  The anchor carries `className="ph-no-capture …"` from the day it is created: its `href` holds the home token, a capability, and PostHog autocapture records a clicked anchor's `href` (the join-code precedent, `components/registration-hub-registrant-join-code.tsx:53-55`) (pre-flight B9). The page catches `HttpError` with code `DEVICE_LINK_KEK_MISSING` from `openHomeToken` (Task 2, A6) and renders the pad without the link: a missing KEK must never take the scoring pad down (pre-flight C8). Any other error rethrows.

- [ ] **Step 1: Write the failing test** following `page.test.tsx`'s render harness, with `vi.stubEnv("DEVICE_LINK_KEK", KEK)` at the top (A15): a system-org fixture renders a link whose `href` starts with `/q/qm_` and whose class list contains `ph-no-capture` (B9); an ordinary org's fixture renders no such link; the English copy appears; with `DEVICE_LINK_KEK` stubbed to `""` the system-org fixture still renders the pad, with no back link and no throw (C8, A6).
- [ ] **Step 2: Run to verify failure**
- [ ] **Step 3: Implement** the lookup after `readScanFixture` (guarded by the org id so ordinary pads pay no extra query) and the component; add the key to all four dictionaries; run `npm run i18n:gen-keys` (`lib/i18n-keys.ts` is generated from the en keys) and `npm run i18n:check` from the repo root.
- [ ] **Step 4: Run to verify pass**, plus the existing `page.test.tsx`.
- [ ] **Step 5: Mutate once:** drop the `DEVICE_LINK_KEK_MISSING` catch, confirm the KEK-unset test fails, restore from a `cp` backup.

---

### Task 10: The system user can never sign in

**Files:**
- Modify: `apps/web/src/app/api/auth/magic-link/route.ts:53` (the request handler)
- Modify: `apps/web/src/lib/login-link.ts` (`issueLoginLink` `:16`, which `createLoginLink` `:28-30` and the magic-link route `:83` both call)
- Test: `apps/web/src/app/api/auth/magic-link/__tests__/system-user-refused.test.ts`

**Interfaces:**
- Consumes: `QUICK_MATCH_SYSTEM_USER_ID`, `QUICK_MATCH_SYSTEM_USER_EMAIL`.
- Produces: the magic-link request for the system user's email gets the route's ordinary 200 with no token and no outbox row: after `resolveOrCreateUser(email)` (`route.ts:69`) the system user's id is treated as no account, the same branch an address held by a soft-deleted account takes (`resolveOrCreateUser` answers null, `apps/web/src/lib/users.ts:31-47`; the route then skips `if (userId)`, `route.ts:72`). (An unknown address is not the model: for one, `resolveOrCreateUser` creates an account and the route mails it.) `issueLoginLink(QUICK_MATCH_SYSTEM_USER_ID, db)`, and so `createLoginLink`, throws `HttpError(403, "system user")` before writing a `login_links` row: the route issues tokens through `issueLoginLink` inside its outbox transaction (`route.ts:82-97`), not through `createLoginLink`, so the guard belongs in the shared function. Google cannot match it: `google_sub` is null and the `.invalid` domain never verifies.
  The route guard sits on `resolveOrCreateUser`'s answer (`route.ts:69`), BEFORE `if (userId)` (`:72`) and so before `stampTermsAcceptance(userId)` (`:75`, which sets `users.terms_accepted_at`, `lib/legal.ts:25-31`): placed any later, the system user would be stamped as having accepted the terms (pre-flight B10).

- [ ] **Step 1: Write the failing tests** (follow `route-outbox.test.ts`'s harness): requesting a link for the system email answers 200, enqueues nothing, writes no `login_links` row, and leaves the system user's `terms_accepted_at` null (B10); `createLoginLink(systemId)` and `issueLoginLink(systemId, sql)` reject with 403.
- [ ] **Step 2: Run to verify failure**
- [ ] **Step 3: Implement** both guards.
- [ ] **Step 4: Run to verify pass**, plus the existing magic-link and login-link suites (`src/app/api/auth/magic-link/__tests__/*.test.ts`, `src/lib/__tests__/login-link.test.ts`).
- [ ] **Step 5: Mutate each guard once, one at a time** (pre-flight B10; the two cover for each other, AGENTS.md class 3), restoring from a `cp` backup: (a) delete the route guard, confirm the route test fails (`issueLoginLink`'s 403 now reaches the route, or the terms stamp lands); (b) delete the `issueLoginLink` guard, confirm both 403 tests fail.

---

## Self-review notes

- **Spec coverage, plan 1 scope:** §7.1 (Task 1, 7), §7.2 (Task 1 override; the plan key choice is "community plus overrides", §10), §7.3 (Tasks 3, 4, 5), §7.4 (Task 8), C11 and C23 (Task 6), C12 (Task 9), C16 and C17 (Tasks 4, 5), C19 and C20 (Tasks 2, 5), C21 (Task 5 `ends_on`, with the "nothing date-driven" test in plan 3's sweep task), §7.5 (Task 7), §9 "create-and-score sweep" (Task 6 is the sweep; Task 8 the seam). Screens, email, saving and the sweep are plans 2 and 3.
- **Deviation from §7.3 "in one transaction":** `withTenant` must not be nested (`lib/db.ts:279-283`) and the four create use cases each open their own, so the competition, division, stage and entrants are created first and the fixtures, start and `quick_matches` row commit in one transaction; a failure anywhere hard-deletes the competition (Task 5). The observable promise holds: either a started quick match exists or nothing does, and Task 5's mutation step proves the compensation is load-bearing. A process that dies between the two commits, before the compensation runs, leaves a system-org competition with no `quick_matches` row: plan 3's sweep also hard-deletes such competitions older than 1 h, with a test (pre-flight D1; plan 3 owns it, this plan only names it).
- **Type consistency:** `QuickMatchRow`, `QuickMatchFormat`, `systemAuth()`, `hashHomeToken`, `openHomeToken`, `hardDeleteQuickMatchCompetition`, `startDivisionInTx`, `ensureGuestDeviceLink` are named once here and used by those names in plans 2 and 3. `startDivisionInTx` now takes `firstStageId` and returns `competitionPromoted` (Task 3); `runQuickMatchProbe`, `playToDecided` and `firstRallyFor(fixtureId): Promise<AppendEventRequest[]>` live in `apps/web/src/server/usecases/__tests__/_quick-match-probe.ts` (Task 6). Added by the pre-flight (2026-11-07): `isVisitorKeyShaped` (Task 2); `previewStageDraw`, `PreviewDrawFixture`, `QuickMatchPreviewSide`/`Line`/`Round` and `QuickMatchStageInput` (Task 4); `createQuickMatchTree`, `SealedHomeToken`, `sealNewHomeToken`, `QUICK_MATCH_ERRORS.KIND_NOT_OFFERED`, `CreateQuickMatch.kind` and `EVENTS.QUICK_MATCH_CREATED` (Task 5); `offerFor`, `QuickMatchOffer`, and `QuickMatchSport.kinds`/`labelKey` (Task 6); `touchQuickMatchActivity` and `touchQuickMatchActivityForFixture` in `quick-match-activity.ts`, `QuickMatchFixture.isFinal`/`winnerEntrantId`, and `QuickMatchHome.kind`/`sport` keys (Task 7).
- **What plans 2 and 3 adapt to (their own pre-flights; this plan does not edit them):**
  - C1 and D2: `listQuickMatchSports()` answers per-sport `kinds` and `labelKey`s, never English names, and `CreateQuickMatch` requires `kind`. Plan 2 T2/T4 draw the kind switch from `kinds` (hidden when there is one; chess is `["individual"]`), send the chosen kind, and render names from the keys; the Match rules choice picks the variant only.
  - C2: `QuickMatchPreview` is structure (seed, feeder, round role, bye). Plan 2 T4 localizes it and maps seed i to the i-th typed name. If plan 2 renders the bye word through the literal `bracket.slot.bye` key in a non-test file, the bye-render-sites `EXEMPT` row Task 4 no longer carries is plan 2's.
  - C5: every code travels in `HttpError.code`, so `body.code` is present. Plan 2 adds copy for `QUICK_MATCH_SPORT_NOT_OFFERED` and `QUICK_MATCH_KIND_NOT_OFFERED` (for example `quickMatch.errors.sportNotOffered` and `quickMatch.errors.kindNotOffered`), beside its existing format and too-many keys.
  - C8: `openHomeToken` throws `HttpError` 503 `DEVICE_LINK_KEK_MISSING`. Plan 2 T9's marketing-home strip catches it and renders no strip; plan 3's reminder (T2) and account list (T6) handle it the same way.
  - C10: `QuickMatchFixture.isFinal`/`winnerEntrantId` and `QuickMatchHome.kind`/`sport` keys feed plan 2 T5's eyebrow, final marker, winner colouring and winner card.
  - E1: a side name over 60 UTF-16 units is refused (400), never clipped. Plan 2 T4's inputs carry `maxLength={60}`.
  - D5: a committed score now touches the row (Task 8), so plan 2 T6's Score-tap touch is a second, earlier touch, not the only one.
  - D11: the system org emits no organizer analytics; `quick_match_created` is the one server event.
  - D1: plan 3's sweep owns the orphan-competition delete (above).

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

All four were settled on 2026-11-07 (see Pre-flight amendments): the first by E1, the second by E2, the third by A9, and the fourth was answered OK by the scan's A7 (`schedule.ts:3876-3882`: the gate rejects conflicts, and an unslotted board yields no assignments, so it has none).

### Blockers

None. No owner decision (O1–O11, C1–C23) is made impossible by the drift.

## Pre-flight amendments (2026-11-07)

The rulings recorded in the SDD ledger (`.superpowers/sdd/2026-11-06-quick-match-1-foundation/progress.md`, "Pre-flight rulings (2026-11-07)") over the pre-flight scan beside it. A, B and C rows adopt the scan's suggested ruling; D and E rows follow the ledger. One line per non-OK row: where it landed.

- **A4** (seal after the tree): Task 5 wrapper step 0, `sealNewHomeToken()` before any read or write; Part B's 503 test runs at the cap; Step 10's first mutation.
- **A6** (`openHomeToken` with no KEK): Task 2 Produces, `HttpError` 503 `DEVICE_LINK_KEK_MISSING`; Task 2's "refuses to open" test and Step 5 mutation; Task 9 catches it.
- **A8** (one stage input, one count): Task 4 `quickMatchStageInput`; Task 5 tree steps 2 and 4 (`matchCount` from `quickMatchPreview`); Task 5's first test.
- **A9** (Tasks 5 and 6 depend on each other): Task 5's execution-order note (tree Steps 1 to 5, then Task 6, then wrapper Steps 6 to 10); Task 6's execution-order note; `offerFor` as the one source.
- **A10** (the first event is `core.start`): Task 6 `firstRallyFor(fixtureId)` answers `[core.start, first play]`; Task 8's rally test asserts a non-`core.*` row.
- **A15** (KEK in tests): Global Constraints "The KEK in tests"; `vi.stubEnv` in Tasks 2, 5, 6, 7, 8 and 9.
- **A16** (one shared org, parallel files): Global Constraints "One shared org in parallel files"; Task 5's per-case names and visitors; Task 6's probe.
- **B1** (policy name): Task 1 migration, `quick_matches_tenant`, pinned by Task 1's first test.
- **B2** (visitor key shape, open with no KEK): Task 2 `isVisitorKeyShaped` and its tests; Task 2's "refuses to open with no KEK" test.
- **B3** (rollback test was a comment): Task 3 Step 1, the rollback test spelled out (`divisions.status`, no `division_started` event, competition unchanged).
- **B4** (league rows): Task 4 Step 1, rows `[3,1,3]` and `[5,2,20]`, with the structural preview (C2).
- **B5** (create guards): Task 5. (a) codes as the third argument; (b) per-case names; (c) `kind` (D2); (d) Review Focus 5 picks its variant at runtime; (f) advisory lock and recount, tree step 3b, concurrent test; (g) Step 10's mutation table.
- **B6** (the probe): Task 6. (b) `PlayResult` decided, refused or unproven; (c) the writer's own describe and the Step 1 stub JSON; (e) generic excluded as `QUICK_MATCH_GENERIC`; (f) the code only; (g) test 1 named a drift pin.
- **B7** (home read): Task 7. (a) null expiry alive, saved-row test; (b) two touch tests; (c) division-predicate mutation and `ha.divisionId`; (d) `total`, `played` and `summary` from `match_states`; (e) the ledger file in Files.
- **B8** (guest link): Task 8. KEK stub, the rally test per A10, Step 5 mutations.
- **B9** (back link): Task 9 Produces, `ph-no-capture` from creation; Step 1's class assertion; the 503 caught.
- **B10** (system user sign-in): Task 10 Produces, the route guard before `stampTermsAcceptance` (`route.ts:75`); Step 1's `terms_accepted_at` assertion; Step 5's two mutations.
- **C1** (sport names and kinds): Task 6 `QuickMatchSport {labelKey, kinds}`, `QuickMatchVariant.labelKey`, test 5; Self-review "What plans 2 and 3 adapt to".
- **C2** (English preview strings): Task 4 structural `QuickMatchPreview` (seed, feeder, role, bye); Self-review cross-plan list.
- **C5** (error codes plan 2 maps): Global Constraints "Errors"; Task 5 `QUICK_MATCH_ERRORS` (plus `KIND_NOT_OFFERED`); Self-review cross-plan list (plan 2's copy keys).
- **C8** (`openHomeToken` failure mode): Task 2 (A6); Task 9 renders without the link; Self-review cross-plan list (plan 2 T9 and plan 3).
- **C10** (home shapes): Task 7 `QuickMatchFixture.isFinal`/`winnerEntrantId`, `QuickMatchHome.kind`/`sport`; the knockout-of-3 test.
- **D1** (two commits, orphan risk): Self-review "Deviation from §7.3", a cross-reference only; plan 3's sweep owns the delete and its test.
- **D2** (kind is a per-sport axis): Global Constraints "Sides"; Task 5 `CreateQuickMatch.kind` and `KIND_NOT_OFFERED`; Task 6 `offerFor(...).kinds`; spec §5 corrected and row C24 added.
- **D3** (probe counts): Task 6 probe step 3, league N 2 to 6 and knockout N 3 to 6 per offered sport × variant × kind; `countCases` in test 1.
- **D4** (knockouts of 3, 5 and 6): Task 5 Part A's `it.each`, round-1 pairs and bye holders against the preview and the spec's holders.
- **D5** (a score is activity): Task 7 `quick-match-activity.ts`; Task 8's `scoring.ts` touch, its D5 test and mutations (b) and (c).
- **D6** (entitlement overrides): Task 1's second test and its note, no entitlement pin tests; Task 5's quota test is the behavior.
- **D7** (public views, slugs): Task 5 Part A's two tests.
- **D8** (knockout offer oracle): Task 6 test 3, the engine's declaration per variant with both values present.
- **D9** (`ends_on`): Task 5's first test asserts 365 days; plan 3's sweep test stays the "nothing date-driven" pin.
- **D10** (a knockout that can end level): Global Constraints "Knockout offer"; Task 6 `offerFor.knockoutAllowed`; test 3; Step 5 mutation (b).
- **D11** (analytics): Global Constraints "Analytics"; Task 5's `captureServer` guard, `EVENTS.QUICK_MATCH_CREATED`, the D11 test and the guard file.
- **E1** (60 characters, refused): Review Focus 1 reworded; Task 5's 60/61 and 30/31-emoji test.
- **E2** (503 before any write): Review Focus 4 reworded and owned by Task 5; wrapper step 0; Part B's 503 test.
