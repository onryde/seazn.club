# Online Chess, paid by size with Seazn credits: Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** An organiser picks a size (16/32/64/128/256) for an online chess division, pays for it once in Seazn credits before round 1, and the size is the division's entrant limit.

**Architecture:** One package row per online division (`division_online_packages`) carries the chosen size and what was paid; ledger rows in the existing `org_stream_credits` point at it. Money moves on the privileged connection under two advisory locks (`division:` then org money); tenant transactions reach the sealed tables through `withTenant`'s existing `privilegedPrelude` / `privilegedEpilogue`. The size becomes a third term in the existing entrant cap, and `openRound` is the payment door that freezes the package.

**Tech Stack:** Next.js (this repo's version: read `node_modules/next/dist/docs/` before touching a route or page), TypeScript, postgres.js, Flyway SQL migrations, vitest (node environment, real database), Playwright, Stripe Checkout (sandbox), PostHog.

**Spec:** `docs/superpowers/specs/2026-11-23-online-chess-credits-design.md` (owner-approved 2026-11-23, commit `5b082c5b30`). Section numbers below (§) are the spec's. Read §3, §4, §7 and §8 before any task. Review history: `.superpowers/sdd/2026-11-17-chess-external-play/online-chess-credits-design-review.md`.

## Global Constraints

- **Read first:** `AGENTS.md`, `docs/superpowers/RULES.md`, `docs/superpowers/TEST-STRATEGY.md`. Server tasks also read `apps/web/src/server/MODULARIZATION.md`: new code goes in new focused modules, and any split of an existing file is a verbatim move behind an identical barrel.
- **Names:** "Online Chess", "Fair-play camera", "Seazn credits". "External Play" never reaches a user. Players never see a price, "credit", "plan", "upgrade" or "size".
- **Prices (§3.5), typed nowhere but the leaf module of Task 1:** 16→1/2, 32→2/4, 64→4/8, 128→8/16, 256→16/32 credits (without / with cameras). Included rounds: 16→6, 32→7, 64→8, 128→9, 256→10.
- **Formats (§3.9, P16):** allowed stage kinds `swiss`, `knockout`, `double_elim`, `page_playoff`, `stepladder`. Refused: `league`, `group`, `ladder`.
- **Error codes, exactly:** 402 `ONLINE_CHESS_NO_CREDITS` (`owed`, `balance`); 402 `ONLINE_CHESS_UNPAID` (the quote); 409 `ONLINE_QUOTE_CHANGED` (the fresh quote); 422 `ONLINE_SIZE_FULL` (`size`, `nextSize`); 422 `ONLINE_FORMAT_NOT_SUPPORTED` (`kind`); 422 `ONLINE_ROUNDS_NEED_SIZE` (`nextSize`); 422 `ONLINE_ROUNDS_ABOVE_MAX`; 422 `ONLINE_CAMERAS_NEED_UPGRADE` (`divisions: [{ id, name, owed }]`). Never reuse `no_credits`.
- **Money rules (§7.3, §7.4):** lock order is `division:` advisory lock (ascending division id when several), then the org money lock (`lockOrg`), then `select … for update` on the package row. Exactly-once is by STATE under those locks plus the client's `expectedOwed`; the spec deliberately uses no idempotency key for a package payment, so do not add one. The server derives cameras, rounds and places; the client sends a size and `expectedOwed` only (plus `addCameras`). Ledger rows are never updated or deleted.
- **Sealed tables:** no grant is widened and no `security definer` function is added. Each new `privilegedEpilogue` caller is added by name to `apps/web/src/lib/__tests__/privileged-epilogue-boundary.test.ts`.
- **Flag:** every new control and door is behind the existing PostHog flag `online-chess` (`server/usecases/external-play/online-chess-flag.ts`). Refunds and switching online play off are never flag-gated.
- **Migration number:** next free at build time. Re-check `git ls-tree -r --name-only origin/main db/migration | sort | tail` and the open PRs before writing the file. V543–V547 are taken and plan-limits plans V548+. No fixed number appears in this plan; the file is `db/migration/deltas/V<next>__online_chess_packages.sql`.
- **Tests, every task:** unit + e2e + smoke + regression where they apply. Every sweep asserts how many items it checked and fails on zero. Expected values come from the Global Constraints above or the spec, never from the code under test. Mutate each new guard once and record the result in the task's commit message. Test the sequence: a second call, after a refund, after a move down, two tabs.
- **Running tests:** scoped only. `cd apps/web && npx vitest run <paths> --reporter=json --outputFile=/tmp/oc-<task>.json --maxWorkers=1`, then read `numPassedTests` / `numTotalTests` and confirm `.testResults[].name` are the worktree's paths. Never the full suite, never full `tsc`. E2E runs in CI; a spec you touch may be run locally on its own.
- **Copy:** every user string in `apps/web/src/dictionaries/{en,es,fr,nl}/*.json`, then `npm run i18n:gen-keys` and `npm run i18n:check`. Help (`apps/web/content/help/**`) is English only.
- **UI:** one DOM, phone branches with `max-md:*` / `md:hidden`; verified by screenshot at 1280, 768 and 320 with no horizontal page scroll; any e2e that asserts a strip control must still find it. Use the frontend-design skill for Tasks 11 and 12. Mockups (`~/seazn-artifacts/2026-11-23_online-chess-cost-layout-v2_oc23a002/index.html`) are layout only; where they differ from the spec, the spec wins.
- **OpenAPI:** every new route and code goes into `apps/web/src/server/api-v1/openapi.ts`, then `npm run openapi:gen`; CI checks drift.
- **One PR for the wave,** in a worktree, tasks in the order below. Commit after every task.
- **Dependency:** the copy-only PR `chore/seazn-credits-rename` is merged first. This plan does not rename anything.
- **Out of this plan:** the `/product/online-chess` feature page and the public "what a credit buys" pricing strings (§9.2, §15). They are a separate plan, because §14 ships them as their own step once real screens can be captured from the merged product, and public chess copy must not go live while the flag is off.

## Review Focus

1. **A config save that re-sends `onlinePlay: "lichess"`** (every Entrants and format save re-sends the whole config). Expected: the package row is untouched: no second row, no size reset. Test in Task 6.
2. **A division with no stages yet.** Expected: cameras come from the division's own effective policy, counted rounds are 0, the quote works. Test in Task 4.
3. **An org's first-ever ledger write is a package payment** (empty ledger, month never rolled). Expected: the month is granted under the lock, then the payment draws on it; two concurrent first payments write one debit. Test in Task 5.
4. **A competition frozen for billing** (over `competitions.max_active`). Expected: paying is refused with the freeze's own 402, because round 1 could not open anyway; a refund and a move down still work. Test in Task 5. (The spec is silent; this is the plan's call.)
5. **A staff revoke, or a stream going live, between the receipt and the confirm.** Expected: 402 `ONLINE_CHESS_NO_CREDITS` with the true balance, nothing written, the receipt offers Buy credits. Test in Task 5.

---

## File Structure

New, all under `apps/web/src/`:

| File | Responsibility |
|---|---|
| `lib/online-chess-package.ts` | Import-free leaf: sizes, prices, included rounds, allowed kinds, error codes, door list. |
| `server/usecases/online-package/types.ts` | `PackageRow`, `PackageQuote`, `PackageState`. |
| `server/usecases/online-package/read.ts` | Read the live row; derive cameras, rounds, places. |
| `server/usecases/online-package/ledger.ts` | Package debit and refund rows on `org_stream_credits`. |
| `server/usecases/online-package/quote.ts` | The one quote. |
| `server/usecases/online-package/pay.ts` | Pay, upgrade, add cameras, move down. |
| `server/usecases/online-package/refund.ts` | Full refund, unpaid delete, the prelude/epilogue pair. |
| `server/usecases/online-package/settle.ts` | Reversal marker and settle. |
| `server/usecases/online-package/size.ts` | Choose or change an unpaid size; capacity clamp. |
| `server/usecases/online-package/gate.ts` | The `openRound` gate and freeze. |
| `server/usecases/online-package/index.ts` | Barrel. |
| `app/api/v1/divisions/[id]/online-package/route.ts` | `GET` quote, `POST` pay. |
| `components/v2/online-chess/size-select.tsx`, `price-line.tsx`, `pay-line.tsx`, `receipt.tsx`, `paid-chip.tsx` | The five UI pieces of §8. |

---

### Task 0: Preconditions

**Files:** none changed. Record findings in the PR description.

- [ ] **Step 1: The rename is on main.** `git grep -a -n -i -E "match credits?|streaming credits?" -- apps/web/src/dictionaries/en` returns nothing, and `stream.credits.pack1` reads "1 credit". If not, stop: the dependency is not merged.
- [ ] **Step 2: Re-pin.** Open each `file:line` the spec cites in §5 and §7 and confirm it; list every one that moved. A false premise is a finding to record, not a blocker.
- [ ] **Step 3: Census.** Read-only, prod and staging: count divisions with `config->>'onlinePlay' = 'lichess'`, split by stage kind and by "any `stage_round_opens` row". Prod was 0 on 2026-11-23. Staging rows on a refused format are cleaned by hand (test data), not migrated.
- [ ] **Step 4: Migration number.** Per Global Constraints.
- [ ] **Step 5: Settle the "Open at build time" items assigned to Task 0** (end of this plan).

---

### Task 1: The price leaf

**Files:**
- Create: `apps/web/src/lib/online-chess-package.ts`
- Modify: `apps/web/src/server/external-play/__tests__/import-free-leaves.test.ts` (add the file)
- Test: `apps/web/src/lib/__tests__/online-chess-package.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export const ONLINE_SIZES = [16, 32, 64, 128, 256] as const;
  export type OnlineSize = (typeof ONLINE_SIZES)[number];
  export function packagePrice(size: OnlineSize, cameras: boolean): number;
  export function includedRounds(size: OnlineSize): number;
  export function sizeFor(places: number): OnlineSize | null;        // null above 256; sizeFor(0) === 16
  export function sizeForRounds(rounds: number): OnlineSize | null;  // null above 10
  export function nextSize(size: OnlineSize): OnlineSize | null;
  export function sizeAllowedByPlan(size: OnlineSize, planCap: number | null): boolean; // P17
  export const ONLINE_ALLOWED_STAGE_KINDS: readonly string[];
  export const ONLINE_REFUSED_STAGE_KINDS: readonly string[];
  export const ONLINE_PACKAGE_CODES: { noCredits; unpaid; quoteChanged; sizeFull; formatNotSupported; roundsNeedSize; roundsAboveMax; camerasNeedUpgrade };
  export const ONLINE_SIZE_DOORS: readonly string[]; // filled by Task 7
  ```

- [ ] **Step 1: Write the failing tests** (expected values typed from Global Constraints):
  ```ts
  it("prices all 10 cells", () => { /* table of [size, cameras, credits]; expect(checked).toBe(10) */ });
  it("includes 6,7,8,9,10 rounds", …);
  it("sizeFor at each boundary", () => { /* 0→16, 16→16, 17→32, 32→32, 33→64, 64→64, 65→128, 128→128, 129→256, 256→256, 257→null */ });
  it("sizeForRounds", () => { /* 6→16, 7→32, 8→64, 9→128, 10→256, 11→null */ });
  it("sizeAllowedByPlan: cap 96 allows 128 and refuses 256; cap 32 allows 32 and refuses 64; null allows 256", …);
  it("every stage kind in stages_kind_check has a verdict", () => { /* read the kind list from the migration text; allowed ∪ refused ∪ ['americano'] === all; expect(count).toBe(9) */ });
  ```
- [ ] **Step 2: Run, confirm they fail** (module not found).
- [ ] **Step 3: Implement.** `sizeAllowedByPlan(size, cap)`: true when `cap === null`, or `size <= cap`, or `size` is the smallest ladder value `>= cap`.
- [ ] **Step 4: Run, confirm pass. Mutate once:** swap the camera multiplier to 1; the price test must fail.
- [ ] **Step 5: Commit** `feat(online-chess): package price leaf`.

---

### Task 2: Schema

**Files:**
- Create: `db/migration/deltas/V<next>__online_chess_packages.sql`
- Test: `apps/web/src/server/usecases/online-package/__tests__/schema.test.ts`

**Interfaces:**
- Produces: tables `division_online_packages` and `stream_pack_reversals`, column `org_stream_credits.online_package_id`, exactly as §7.1 (columns, four CHECKs, the partial unique index, RLS, the `org_stream_credits_one_subject` CHECK, the backfill).

- [ ] **Step 1: Write the failing tests** against a migrated database:
  ```ts
  it("app_user can read its own org's package and no other's", …);       // RLS: 1 row, then 0
  it("app_user cannot insert, update or delete a package", …);           // each rejects 42501
  it("app_user cannot read stream_pack_reversals", …);                   // 42501
  it("refuses paid_at without credits, cameras_paid without paid_at, refunded+forfeited > paid, refunded_at on an unpaid row", …); // 4 rejections
  it("refuses a second live row for one division; allows one after refunded_at is set", …);
  it("refuses a ledger row naming both a session and a package", …);
  it("keeps a paid row with division_id null when its division is deleted", …);
  ```
- [ ] **Step 2: Run, confirm they fail.**
- [ ] **Step 3: Write the migration** from §7.1. The RLS policy text copies the idiom of a neighbouring tenant-readable table (find one with `grep -a -n "to app_user using" db/migration`). Backfill: one row per online division; no round opened → unpaid at `sizeFor(places held)` (the count of `online-entrant-cap.ts:94-100`, written as SQL in the migration); a round opened → size 256, `frozen_at = now()`, unpaid.
- [ ] **Step 4: Apply per the `seazn-local-env` skill, run, confirm pass.**
- [ ] **Step 5: Commit** `feat(db): online chess packages and pack reversals`.

---

### Task 3: Package rows on the ledger

**Files:**
- Create: `apps/web/src/server/usecases/online-package/{types,read,ledger,index}.ts`
- Test: `apps/web/src/server/usecases/online-package/__tests__/ledger.test.ts`

**Interfaces:**
- Consumes: `lockOrg`, `creditBreakdown`, `rollMonthlyLocked` semantics via a new exported wrapper (below), from `server/usecases/stream-credits.ts`.
- Produces:
  ```ts
  // stream-credits.ts: export the existing private rollover for one more caller
  export async function rollMonthlyUnderLock(tx: Tx, orgId: string, rate: number, now: Date): Promise<void>;
  // ledger.ts — the caller holds the org money lock
  export type BucketSplit = { monthly: number; pack: number };
  export function planDebit(split: StreamCreditBreakdown, credits: number): BucketSplit;   // monthly first; throws if short
  export async function debitForPackage(tx: Tx, a: { orgId: string; packageId: string; credits: number }): Promise<BucketSplit>;
  export type Returnable = { pack: number; monthlyThisMonth: number; monthlyExpired: number };
  export async function returnableFor(tx: Tx, a: { orgId: string; packageId: string }, now: Date): Promise<Returnable>;
  export function planReturn(r: Returnable, credits: number): { pack: number; monthly: number; forfeited: number }; // P21 order
  export async function refundForPackage(tx: Tx, a: { orgId: string; packageId: string; pack: number; monthly: number }): Promise<void>;
  // read.ts
  export async function livePackage(db: Tx | typeof sql, divisionId: string, opts?: { forUpdate?: boolean }): Promise<PackageRow | null>;
  ```
  Rows: `reason` `consume` / `refund`, `online_package_id` set, `session_id` null, `created_by` null, one row per bucket, `balance_after` the running org total.

- [ ] **Step 1: Write the failing tests:**
  ```ts
  it("planDebit: monthly 3 pack 5, debit 8 → {3,5}; debit 2 → {2,0}; monthly 0 → {0,n}", …);
  it("planDebit differs from pack-first: monthly 1 pack 4, debit 2 → {1,1}", …);
  it("debitForPackage spanning both buckets writes two rows whose balance_after end at total − credits", …);
  it("returnableFor: pack consumes minus pack refunds; monthly split by UTC month of the consume", …);
  it("planReturn (P21): {pack 3, thisMonth 1, expired 2}, return 5 → {pack 3, monthly 1, forfeited 1}", …);
  it("refundForPackage returns each credit to its own bucket", …);
  it("creditBalance equals the breakdown total after every step of debit → debit → refund", …);
  ```
- [ ] **Step 2: Run, confirm they fail.**
- [ ] **Step 3: Implement.** `monthlyThisMonth` = monthly consumes of this package dated in `streamMonthlyPeriod(now)` minus monthly refunds of this package dated in the same period; `monthlyExpired` = the rest of the monthly consumes not yet refunded or forfeited (the row's `credits_forfeited` is subtracted by the caller in Task 5).
- [ ] **Step 4: Run, confirm pass. Mutate once:** make `planDebit` pack-first; the "differs" test must fail.
- [ ] **Step 5: Regression:** run `stream-credit-ledger-writers.test.ts` and `stream-credits-monthly.test.ts`; counts unchanged.
- [ ] **Step 6: Commit** `feat(online-chess): package debit and refund rows`.

---

### Task 4: The quote

**Files:**
- Create: `apps/web/src/server/usecases/online-package/quote.ts`; extend `read.ts`
- Test: `apps/web/src/server/usecases/online-package/__tests__/quote.test.ts`

**Interfaces:**
- Consumes: Task 1 leaf; Task 3 `livePackage`, `planDebit`, `returnableFor`, `planReturn`; `countOnlineHeld` (`server/external-play/online-entrant-cap.ts`); `effectivePolicy` (`server/external-play/camera-policy.ts`); `streamMonthlyRate`.
- Produces:
  ```ts
  // read.ts
  export async function derivedCameras(db, divisionId: string): Promise<boolean>;   // P9
  export async function countedRounds(db, divisionId: string): Promise<number>;     // P15
  export type PackageFacts = { cameras: boolean; rounds: number; held: number; planCap: number | null };
  // quote.ts
  export type PackageQuote = {
    size: OnlineSize; cameras: boolean; price: number;
    owed: number;                               // > 0 to pay, < 0 to return, 0 nothing
    take: BucketSplit | null;                   // when owed > 0
    back: { pack: number; monthly: number; forfeited: number } | null;   // when owed < 0
    monthlyExpiresOn: string;                   // ISO date, last day of the UTC month
    balance: number; held: number; rounds: number;
    refusal: null | "below_held" | "plan" | "rounds" | "rounds_above_max" | "frozen";
  };
  export async function quoteLocked(tx: Tx, a: { orgId: string; divisionId: string; size: OnlineSize; addCameras?: boolean }, facts: PackageFacts, now: Date): Promise<PackageQuote>;
  export async function onlinePackageQuote(auth: AuthCtx, divisionId: string, size: OnlineSize, addCameras?: boolean): Promise<PackageQuote>; // read-only, no lock
  ```
  `cameras` in the quote = `facts.cameras || addCameras === true || row.cameras_paid === true`. `owed` = `price − packagePrice(row.size, row.cameras_paid)` on a paid row, else `price`.

- [ ] **Step 1: Write the failing tests:**
  ```ts
  it("derivedCameras is nearest-level-wins per stage: competition required + division off → false; division off + one stage required → true", …);
  it("derivedCameras with no stages uses the division's effective policy", …);          // Review Focus 2
  it("countedRounds sums Swiss config.rounds only: swiss 5 + knockout → 5; swiss 5 + swiss 3 → 8; knockout alone → 0", …);
  it("unpaid 32 with cameras: owed 4, take split from the balance", …);
  it("paid 32 no cameras → quote 64: owed 2; → quote 16: owed −1 with back per P21", …);
  it("addCameras raises the price and never lowers it; on a row with cameras_paid it owes 0", …);
  it("refusals: size below held; size above the plan (P17); rounds 7 on a 16; rounds 11; a frozen row", …);
  ```
- [ ] **Step 2: Run, confirm they fail.**
- [ ] **Step 3: Implement.** `derivedCameras`: any stage's `effectivePolicy({stage, division, competition}) !== "off"`; with no stages, `effectivePolicy({stage: null, division, competition})`.
- [ ] **Step 4: Run, confirm pass. Mutate once:** make `derivedCameras` read the division level only; the stage test must fail.
- [ ] **Step 5: Commit** `feat(online-chess): one quote for the price line, the pay line and the receipt`.

---

### Task 5: Pay, upgrade, add cameras, move down

**Files:**
- Create: `apps/web/src/server/usecases/online-package/pay.ts`, `apps/web/src/app/api/v1/divisions/[id]/online-package/route.ts`
- Modify: `apps/web/src/server/api-v1/openapi.ts`; regenerate with `npm run openapi:gen`
- Test: `apps/web/src/server/usecases/online-package/__tests__/pay.test.ts`, `…/pay-concurrency.test.ts`, `apps/web/src/app/api/v1/divisions/[id]/online-package/__tests__/route.test.ts`

**Interfaces:**
- Consumes: Tasks 3 and 4; `assertCompetitionNotFrozen`; `assertOnlineChessOffered`; `settleReversals` (Task 6; call it through an injected dep so this task can land first, wired in Task 6).
- Produces:
  ```ts
  export type PayInput = { size: OnlineSize; expectedOwed: number; addCameras?: boolean };
  export type PayResult = { applied: boolean; quote: PackageQuote; package: PackageRow };
  export async function payOnlinePackage(auth: AuthCtx, divisionId: string, input: PayInput): Promise<PayResult>;
  // the same work on a caller's transaction, for Task 9's pay-and-open; the caller holds the division lock
  export async function payOnlinePackageInTx(tx: Tx, a: { orgId: string; divisionId: string; userId: string | null } & PayInput, facts: PackageFacts, monthly: { rate: number; now: Date }): Promise<PayResult>;
  ```
  Routes: `GET /api/v1/divisions/{id}/online-package?size=&addCameras=` → `PackageQuote`; `POST …/online-package` with a strict zod body `PayInput` → `PayResult`. Organiser roles only (`EDITOR_ROLES`).

- [ ] **Step 1: Write the failing tests:**
  ```ts
  it("first payment: debit equals the price, row paid, cameras_paid set, paid_by set", …);
  it("the same payment twice writes one debit; the second answers applied:false", …);
  it("two concurrent payments for one size write one debit", …);                 // hold the lock, as stream-credits concurrency tests do
  it("two tabs, 32 then 64: the second pays 2, and its stale expectedOwed 4 answers 409 with no row", …);
  it("409 ONLINE_QUOTE_CHANGED when the camera policy changed after the quote; ledger unchanged", …);
  it("409 when the rounds were raised after the quote", …);
  it("a body carrying `cameras` is rejected by the strict schema", …);
  it("402 ONLINE_CHESS_NO_CREDITS carries owed and balance; nothing written", …);  // Review Focus 5
  it("first-ever ledger write: the month is granted under the lock, then drawn", …); // Review Focus 3
  it("pay is refused on a billing-frozen competition; move down still works", …);  // Review Focus 4
  it("upgrade charges the difference; addCameras charges the camera difference", …);
  it("move down: all bought → all return; this month's included → return; mixed → bought first; earlier month → forfeited, counted, no row", …);
  it("move down then up: the forfeited credit is not credited back", …);
  it("move down refused below held, below the rounds' size, and when frozen", …);
  it("both invariants of §7.1 hold after every step of pay → up → down → up", …);
  it("a size change lowers a stored registration capacity above it and reports it", …);
  ```
- [ ] **Step 2: Run, confirm they fail.**
- [ ] **Step 3: Implement `payOnlinePackage`.** Before the transaction: plan cap (`getLimit`), monthly rate, frozen check, flag. Then `sql.begin`: `division:` lock → `lockOrg` → `rollMonthlyUnderLock` → `livePackage(forUpdate)` → facts → `quoteLocked` → compare `owed` with `expectedOwed` → debit or return → update the row → capacity clamp → settle. Throw the Global Constraints codes.
- [ ] **Step 4: Run, confirm pass. Mutate, one at a time:** drop the `expectedOwed` comparison; charge the full price on upgrade; return an expired included credit; credit forfeits toward a move up. Each must fail a named test.
- [ ] **Step 5: OpenAPI + route test**; run `npm run openapi:gen`; commit the regenerated JSON.
- [ ] **Step 6: Commit** `feat(online-chess): pay, upgrade, add cameras and move down`.

---

### Task 6: Card reversals, refund, and the tenant doors

**Files:**
- Create: `apps/web/src/server/usecases/online-package/{settle,refund,size}.ts`
- Modify: `apps/web/src/server/usecases/stream-credits.ts` (`recordStreamPackRefund`: netted attribution, reversal marker), `apps/web/src/server/usecases/divisions.ts` (`createDivision`, `patchDivision`, `deleteDivision`), `apps/web/src/server/usecases/competitions.ts` (`deleteCompetition`), `apps/web/src/lib/db.ts` (the epilogue comment only), `apps/web/src/lib/__tests__/privileged-epilogue-boundary.test.ts`
- Test: `apps/web/src/server/usecases/online-package/__tests__/{settle,refund,size,delete-doors}.test.ts`; extend `apps/web/src/server/usecases/__tests__/stream-credits-clawback.test.ts`

**Interfaces:**
- Consumes: Tasks 3–5.
- Produces:
  ```ts
  // settle.ts — caller holds the org money lock
  export async function markReversal(tx: Tx, a: { intent: string; orgId: string; purchased: number }): Promise<void>; // on conflict do nothing
  export async function netPackSpendSince(tx: Tx, orgId: string, since: Date): Promise<number>;  // pack consumes − pack refunds
  export async function settleReversals(tx: Tx, orgId: string): Promise<number>;                 // credits revoked
  // refund.ts
  export type PackageDeletePlan = { refund: PackageRow[]; drop: string[] /* unpaid ids */ };
  export async function planPackageDelete(ptx: Tx, a: { orgId: string; divisionIds: string[] }): Promise<PackageDeletePlan>; // prelude: reads, division locks ascending, lockOrg
  export async function applyPackageDelete(etx: Tx, orgId: string, plan: PackageDeletePlan, now: Date): Promise<{ returned: number; forfeited: number }>; // epilogue
  export async function refundOnlinePackageLocked(tx: Tx, row: PackageRow, now: Date): Promise<{ returned: number; forfeited: number }>;
  // size.ts — epilogue of the division save
  export async function writeOnlineSize(etx: Tx, a: { orgId: string; divisionId: string; divisionName: string; size: OnlineSize }): Promise<{ capacityLoweredTo: number | null }>;
  export function assertSizeFits(size: OnlineSize, facts: PackageFacts): void;  // tenant callback; throws the leaf's codes
  ```
  `settleReversals`: for each reversal of the org, oldest first: `outstanding = purchased − netPackSpendSince(purchasedAt) − alreadyRevoked(intent)`; revoke `min(outstanding, pack balance)` when above 0, as a `revoke` row carrying the intent and no key.

- [ ] **Step 1: Write the failing tests:**
  ```ts
  // settle + clawback
  it("worked example 1: buy 20, pay 16, card refund (claws 4), delete division → settle revokes 16; balance 0", …);
  it("other order: buy 20, pay 16, delete division (16 back), card refund → claws 20; balance 0", …);
  it("worked example 2: pack A 5 spent on streams and reversed; pack B 20 pays 16, refunded → settle revokes 0; balance 20", …);
  it("a package that froze is never reversed: buy 20, pay 16, open round, card refund → claws 4 only", …);
  it("a zero claw-back still writes a reversal marker", …);
  it("move down runs settle: example 1 with a move down in place of the delete", …);
  // refund
  it("full refund: bought back in full; included back only inside its month; forfeited counted; refunded_at set", …);
  it("refund twice writes once; refund of a frozen row is refused", …);
  it("move down then full refund never return more than was paid", …);
  // doors
  it("create with onlinePlay lichess writes one unpaid row at 16; with entrants already, at sizeFor(held)", …);
  it("re-sending onlinePlay lichess on a later save leaves the row untouched", …);   // Review Focus 1
  it("unpaid size change: up, down, down below held refused; a paid row refused by this door", …);
  it("online off: paid → refunded row; unpaid → row deleted; on again → one new unpaid row at the default", …);
  it("delete division: paid → refund in the same transaction; unpaid → no row left; frozen → row kept, no refund", …);
  it("delete competition with three paid and one unpaid division: three refunds, no orphan unpaid row", …);
  it("a refund that fails in the epilogue rolls the delete back: the division still exists", …);
  it("archive holds the package; restore returns it; purge refunds", …);
  it("the epilogue allow-list names divisions.ts and competitions.ts and fails for an unnamed file", …);
  ```
- [ ] **Step 2: Run, confirm they fail.**
- [ ] **Step 3: Implement settle and the claw-back change.** In `recordStreamPackRefund`, replace the consumes-only sum with `netPackSpendSince`, and call `markReversal` on every matched call before the zero-claw return.
- [ ] **Step 4: Wire the doors.** `patchDivision`: extend the existing prelude (`cameraGate`, `divisions.ts:860`) to also call `planPackageDelete` when the patch turns online play off; the tenant callback calls `assertSizeFits`; the epilogue calls `writeOnlineSize` or `applyPackageDelete`. `createDivision`, `deleteDivision`, `deleteCompetition`: the same pair. Rewrite `lib/db.ts`'s epilogue comment to describe both uses.
- [ ] **Step 5: Wire Task 5's settle dep to `settleReversals`.**
- [ ] **Step 6: Run, confirm pass. Mutate, one at a time:** drop the netting; replace the attribution with `purchased − revoked`; drop `refunded_at`; drop the frozen check; read packages after the cascade instead of in the prelude. Each must fail a named test.
- [ ] **Step 7: Regression:** `stream-credits-clawback.test.ts`, `stream-credits-reconcile.test.ts`, `match-day-code-open.test.ts`; existing counts unchanged plus the new cases.
- [ ] **Step 8: Commit** `feat(online-chess): refunds, reversals and the size on division saves`.

---

### Task 7: The size as the entrant cap

**Files:**
- Modify: `apps/web/src/server/external-play/online-entrant-cap.ts`, its callers (`server/usecases/entrants.ts`, `registration-submit.ts`, `registrations/waitlist.ts`, `registrations/settings.ts`, `registrations/places-left.ts`), `apps/web/src/components/v2/online-entrant-cap-refusal.ts`, `apps/web/src/lib/online-chess-package.ts` (`ONLINE_SIZE_DOORS`), `apps/web/src/server/api-v1/openapi.ts`
- Test: extend `apps/web/src/server/external-play/__tests__/online-entrant-cap.test.ts` and `apps/web/src/server/usecases/__tests__/online-entrant-cap-doors.test.ts`

**Interfaces:**
- Consumes: `livePackage`, the leaf.
- Produces:
  ```ts
  export type OnlineCapGuard = { readonly planLimit: number | null };                    // unchanged
  export function effectiveEntrantCap(online: boolean, planCap: number | null, size?: number | null): number | null;
  export function capBinder(online: boolean, planCap: number | null, size: number | null): "plan" | "size" | "online" | null;
  export function onlineSizeFullError(size: OnlineSize): HttpError;                      // 422 ONLINE_SIZE_FULL { size, nextSize }
  export async function sizeForDoor(tx: Tx, divisionId: string): Promise<number | null>; // the live row's size, read under the division lock
  export async function promoteIntoNewRoom(divisionId: string): Promise<number>;         // P18; called after a move up commits
  ```
  Which refusal answers: the plan's 402 when the plan is lowest; `ONLINE_SIZE_FULL` when the size is lowest; `ONLINE_DIVISION_FULL` at 256. An online division with no live row: today's cap, `log.error`, Sentry.

- [ ] **Step 1: Write the failing tests:**
  ```ts
  it("every door in ONLINE_SIZE_DOORS admits at the size and refuses at size + 1", () => { /* loop; expect(checked).toBe(ONLINE_SIZE_DOORS.length); expect(checked).toBeGreaterThan(0) */ });
  it("the door list matches the callers of effectiveEntrantCap found in source", …);   // a new door fails the sweep
  it("which refusal: plan 32 size 64 → plan 402; plan 256 size 32 → ONLINE_SIZE_FULL{32,64}; size 256 → ONLINE_DIVISION_FULL", …);
  it("plan cap 96, size 128: the 97th entrant gets the plan's refusal", …);
  it("after the freeze: late entry to the size allowed, size + 1 refused, Reinstate judged the same", …);
  it("public sign-up into a full size sees the ordinary full/waitlist answer, with no size code in the body", …);
  it("an online division with no live row uses min(plan, 256) and logs an error", …);
  it("a move up promotes the waitlist into the new room; manual-approval registration promotes nobody", …);
  it("over-the-board chess and every other sport never read a package", () => { /* loop sports; expect(checked).toBeGreaterThan(1) */ });
  ```
- [ ] **Step 2: Run, confirm they fail.**
- [ ] **Step 3: Implement.** Each door reads the size inside its transaction, after `lockDivisionForCap`. `promoteIntoNewRoom` reuses `promoteOldestWaitlisted` (`registrations/waitlist.ts:202`), looped while room remains; call it from Task 5's pay and Task 6's `writeOnlineSize` callers after commit.
- [ ] **Step 4: Run, confirm pass. Mutate once:** drop the size from the minimum; the door sweep must fail.
- [ ] **Step 5: Smoke.** Extend `scripts/smoke/suites/onlineChessDesk.ts`: choose 16 through the API, add 16 entrants, the 17th answers `ONLINE_SIZE_FULL`. Numbers come from the leaf.
- [ ] **Step 6: Commit** `feat(online-chess): the size is the entrant limit`.

---

### Task 8: Format, rounds and camera doors

**Files:**
- Modify: `apps/web/src/server/usecases/divisions.ts` (online switch at `:1268-1280`, create at `:346`, camera save at `:917-928`), `apps/web/src/server/usecases/stages/stage-graph.ts` (`createStages` and the stage update door), `apps/web/src/server/usecases/stages/swiss-gen.ts` (Generate and the rounds save), `apps/web/src/server/usecases/competitions.ts` (the competition camera save), the stage camera save, `apps/web/src/server/api-v1/openapi.ts`
- Create: `apps/web/src/server/usecases/online-package/format.ts`
- Test: `apps/web/src/server/usecases/online-package/__tests__/{format,rounds,cameras}-doors.test.ts`

**Interfaces:**
- Consumes: the leaf; `livePackage`; `derivedCameras`; `countedRounds`.
- Produces:
  ```ts
  export function assertOnlineFormat(kinds: readonly string[]): void;                               // 422 ONLINE_FORMAT_NOT_SUPPORTED { kind }
  export function assertRoundsFit(rounds: number, row: PackageRow | null): void;                    // ONLINE_ROUNDS_NEED_SIZE { nextSize } | ONLINE_ROUNDS_ABOVE_MAX
  export async function divisionsNeedingCameraUpgrade(tx: Tx, divisionIds: string[]): Promise<{ id: string; name: string; owed: number }[]>;
  ```

- [ ] **Step 1: Write the failing tests:**
  ```ts
  it("every stage kind: allowed kinds turn online on; refused kinds answer ONLINE_FORMAT_NOT_SUPPORTED", () => { /* loop the 9 kinds; expect(checked).toBe(9) */ });
  it("the other direction: an online division cannot gain a league, group or ladder stage", …);
  it("each direction is mutated alone and still refused by the other test's door", …); // two guards do not cover for each other
  it("rounds: 16 unpaid with 7 rounds → the save moves nothing and answers ONLINE_ROUNDS_NEED_SIZE{32}; 11 rounds → ONLINE_ROUNDS_ABOVE_MAX", …);
  it("rounds are not gated once frozen: Add a round succeeds", …);
  it("cameras, unpaid: policy on is allowed and the quote doubles", …);
  it("cameras, paid without: division save refused with this division and its difference", …);
  it("cameras, competition save touching two paid divisions: refused whole, both listed, nothing written", …);
  it("cameras off is never refused; back on is free when cameras_paid", …);
  it("after addCameras is paid the policy save goes through", …);
  ```
- [ ] **Step 2: Run, confirm they fail.**
- [ ] **Step 3: Implement.** All three gates apply only while the live row's `frozen_at` is null. Read `server/usecases/stages/index.ts` to find the stage update and rounds-save doors before editing.
- [ ] **Step 4: Run, confirm pass. Mutate:** let a league turn online on; let an online division gain a league stage. Each fails its own test.
- [ ] **Step 5: Regression:** `camera-policy.test.ts`, the Swiss rounds suites that cover `swiss-gen.ts`.
- [ ] **Step 6: Commit** `feat(online-chess): Swiss and knockout only; rounds and cameras priced before round 1`.

---

### Task 9: The payment door at "Open round"

**Files:**
- Create: `apps/web/src/server/usecases/online-package/gate.ts`
- Modify: `apps/web/src/server/usecases/external-play/open-round.ts` (inside the transaction at `:375`, after the lock at `:379`, before the stamp at `:532`), `apps/web/src/app/api/v1/stages/[id]/open-round/route.ts`, `apps/web/src/server/api-v1/openapi.ts`
- Test: `apps/web/src/server/usecases/external-play/__tests__/open-round-package-gate.test.ts`

**Interfaces:**
- Consumes: `payOnlinePackageInTx`, `livePackage`, facts readers.
- Produces:
  ```ts
  export async function gateFirstOpen(tx: Tx, a: { orgId: string; divisionId: string; userId: string; pay?: PayInput }, facts: PackageFacts, monthly: { rate: number; now: Date }): Promise<void>; // throws 402 ONLINE_CHESS_UNPAID { quote }
  export async function freezeOnlinePackage(tx: Tx, divisionId: string, now: Date): Promise<void>;
  // open-round.ts
  openRound(a: { stageId: string; roundNo: number; actorUserId: string; pay?: PayInput }, deps?): Promise<OpenRoundResult>
  ```
  The gate runs only when the live row's `frozen_at` is null. Facts and the monthly rate are read before the transaction. `gateFirstOpen` and the freeze are called on the path that writes the open, immediately before the stamp.

- [ ] **Step 1: Write the failing tests:**
  ```ts
  it("unpaid: 402 ONLINE_CHESS_UNPAID carrying the quote for the STORED size; no stamp", …);   // decision 15: 64 chosen, 30 held → quote.size 64, not 32
  it("paid and covering: opens, frozen_at set", …);
  it("paid but not covering (cameras added at stage level; rounds raised): refused with the difference", …);
  it("pay and open: one debit, one stamp, frozen", …);
  it("pay and open where the round does not open writes no debit", () => { /* one case per non-opening decision of openRound; expect(checked).toBe(<count read from the Decision union>) */ });
  it("first open is not round 1: a knockout first stage, and round 2 opened first, both meet the gate", …);
  it("the second and later opens ask nothing, even with zero credits", …);
  it("a grandfathered row (frozen, unpaid) is never asked", …);
  it("an upgrade racing the open: whichever commits first wins; the loser is refused, never both", …);
  it("pay and open with a stale expectedOwed answers 409 and opens nothing", …);
  ```
- [ ] **Step 2: Run, confirm they fail.**
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run, confirm pass. Mutate, one at a time:** let an unpaid row open; check `paid_at` only (not cover); write the debit before the decision; skip the freeze. Each fails a named test.
- [ ] **Step 5: Regression:** the existing `open-round` route tests and `external-play-premint.test.ts`.
- [ ] **Step 6: Commit** `feat(online-chess): round 1 needs a paid size, and paying can open it`.

---

### Task 10: Buying credits from the division, and the credit history

**Files:**
- Modify: `apps/web/src/app/api/billing/relay-checkout/route.ts` (gate at `:119-120`, body union at `:33-38`), `apps/web/src/lib/relay-checkout.ts` (success URL), `apps/web/src/server/usecases/stream-credits-tab.ts` (`:55`, `:64`), `apps/web/src/server/usecases/stream-credit-history.ts`, `apps/web/src/server/usecases/stream-credit-history-csv.ts`, `apps/web/src/server/usecases/stream-credits-checkout.ts` (return reconcile for the new target)
- Test: extend `apps/web/src/server/usecases/__tests__/stream-credit-history.test.ts`; `apps/web/src/app/api/billing/relay-checkout/__tests__/route.test.ts`

**Interfaces:**
- Produces: body arm `{ orgId, pack, returnTo: "division", divisionId, size? }`; success URL `…/d/<divSlug>?tab=fixtures&oc=pay&checkout=success&session_id={CHECKOUT_SESSION_ID}[&size=]`; history kinds `onlinePackagePaid`, `onlinePackageResized`, `onlinePackageRefunded`, each with `divisionName` and `size`.

- [ ] **Step 1: Write the failing tests:**
  ```ts
  it("checkout is allowed with streaming off when Online Chess is offered; refused when neither", …);
  it("returnTo division builds the division URL and refuses a division of another org", …);
  it("the credits tab offers packs and grants the month when only Online Chess is offered", …);
  it("history maps every package row; the unmapped count is 0 over a ledger holding pay, upgrade, move down and refund rows", () => { /* expect(mapped).toBeGreaterThan(0); expect(unmapped).toBe(0) */ });
  it("a deleted division's rows show the name snapshot", …);
  it("the CSV export carries the three kinds", …);
  ```
- [ ] **Step 2: Run, confirm they fail.**
- [ ] **Step 3: Implement.** Confirm `server/usecases/stream-sessions/current.ts` has no org-wide `reason = 'consume'` count; if it has, scope it to `session_id is not null` and add a test.
- [ ] **Step 4: Run, confirm pass.**
- [ ] **Step 5: Regression:** `stream-credits-reconcile.test.ts`, `stream-credits-rail-projection.test.ts`.
- [ ] **Step 6: Commit** `feat(online-chess): buy credits from a division; package rows in the credit history`.

---

### Task 11: The size select, the price line, the Review line

**Files:**
- Create: `apps/web/src/components/v2/online-chess/{size-select,price-line}.tsx`
- Modify: `apps/web/src/components/v2/rules/division-rules-strip.tsx` (under the camera select; online control at `:483`), `apps/web/src/components/v2/division-builder.tsx` (camera select `:1309`, review lines `:852`), the format picker used by the strip and the builder, the division page loader that feeds the strip
- Test: `apps/web/src/components/v2/online-chess/__tests__/size-select.test.tsx`; e2e `apps/web/e2e/mobile/rules-panels.spec.ts` (extend)

**Interfaces:**
- Consumes: the leaf; `GET …/online-package` quote; `capacityLoweredTo` from the save.
- Produces: `<OnlineSizeSelect value planCap held rounds paid onChange onPaidPick />`, `<OnlinePriceLine quote onBuyMore />`. Test ids: `online-size-select`, `online-price-line`.

- [ ] **Step 1: Write the failing unit tests** (node render, assertions anchored on `="`):
  ```ts
  it("renders five options, each with its rounds from the leaf", …);
  it("disables sizes above the plan (P17) with the plan name, and sizes below held with the count", …);
  it("is absent when online play is off or the flag is off", …);
  it("on a paid division a pick calls onPaidPick and never onChange", …);
  it("the price line reads '{price} credits · You have {balance} · Buy more'", …);
  it("a refused format disables the Lichess option and shows the reason", …);
  it("the Review step lists the price line and has no pay control", …);
  ```
- [ ] **Step 2: Run, confirm they fail.**
- [ ] **Step 3: Build**, with the frontend-design skill. One DOM; the three selects stack on phones.
- [ ] **Step 4: E2E** in `rules-panels.spec.ts`: the select appears when Lichess is chosen, the price follows the camera select, creating the division spends nothing (the ledger balance read through the API is unchanged), no horizontal scroll at any project width. Wait on `toBeAttached` where a phone disclosure folds the strip.
- [ ] **Step 5: Screenshots** at 1280, 768, 320 to the local sign-off server (not the repo).
- [ ] **Step 6: Commit** `feat(online-chess): pick a size in Division rules`.

---

### Task 12: The pay line, the receipt, the paid chip

**Files:**
- Create: `apps/web/src/components/v2/online-chess/{pay-line,receipt,paid-chip}.tsx`
- Modify: `apps/web/src/components/v2/stages-panel.tsx` (Fixtures tab rules strip), the Match Day control that calls open-round (`apps/web/src/components/v2/match-day/round-focus.tsx`), `apps/web/src/components/buy-stream-credits.tsx` and `apps/web/src/components/v2/fixture-stream-panel.tsx` (`creditsCard` at `:1562`: accept a preselected pack and a division return target), `apps/web/src/components/v2/entrants-panel.tsx` (map `ONLINE_SIZE_FULL` to Change size)
- Test: `apps/web/src/components/v2/online-chess/__tests__/{pay-line,receipt,paid-chip}.test.tsx`; e2e `apps/web/e2e/walkthrough/online-chess-credits.spec.ts` (new, owned by this wave); extend `apps/web/e2e/mobile/organiser-console.spec.ts`

**Interfaces:**
- Consumes: quote, pay, open-round with `pay`, checkout with `returnTo: "division"`.
- Produces: `<OnlinePayLine held size owed onChangeSize onPay />` (amber, in `LockLine`'s style; a new component), `<OnlineReceipt quote sizes mode="pay" | "payAndOpen" | "change" onConfirm />` (the `AiQuoteCard` layout inside `useConfirm`), `<OnlinePaidChip size frozen onChangeSize />`. Pack preselect: the smallest pack whose credits cover `owed − balance`. Test ids: `online-pay-line`, `online-receipt`, `online-paid-chip`.

- [ ] **Step 1: Write the failing unit tests:**
  ```ts
  it("pay line: 'Online Chess not paid. {held} registered, up to {size}. Round 1 can't open until it's paid.' with Change size and Pay {owed} credits", …);
  it("receipt rows: size, cameras, from this month's credits with the expiry date, from bought credits, total; a zero row is hidden", …);
  it("receipt in payAndOpen mode preselects the stored size and lists the others with price and consequence", …); // decision 15
  it("receipt for a move down shows back-to-bought, back-to-this-month, not-returned with its reason", …);
  it("on 409 the receipt redraws with the new quote and the price-changed line; onConfirm is not called twice", …);
  it("short balance: the confirm reads Buy credits and preselects the covering pack (shortfall 3 → the 5 pack)", …);
  it("paid chip: Change size before the freeze, none after", …);
  ```
- [ ] **Step 2: Run, confirm they fail.**
- [ ] **Step 3: Build**, with the frontend-design skill.
- [ ] **Step 4: Walkthrough e2e** (`online-chess-credits.spec.ts`), Stripe sandbox, flag forced on:
  1. build a division with Lichess and 32, see the price on Review, create; balance unchanged;
  2. amber line shows; register players; press Open round 1 unpaid; receipt opens on 32;
  3. run short; Buy credits; pay in the sandbox; land back on the receipt; pay and open; chip shows no Change size;
  4. second division: pay early from the amber line, move up from the chip, move down, see the credits back, open round 1.
  Budget the test from its taps, not a flat timeout.
- [ ] **Step 5: Width e2e** in `organiser-console.spec.ts`: pay line, receipt and chip at all seven widths, no horizontal scroll; the receipt's confirm is hit-tested with `elementFromPoint`.
- [ ] **Step 6: Screenshots** at 1280, 768, 320.
- [ ] **Step 7: Commit** `feat(online-chess): pay for a size from the division page or at round 1`.

---

### Task 13: Copy, help, the player sweep, metrics

**Files:**
- Modify: `apps/web/src/dictionaries/{en,es,fr,nl}/ui.json`, `apps/web/src/lib/i18n-keys.ts` (regenerated), `apps/web/content/help/sports/chess.md`, `apps/web/content/help/billing/` (the Seazn credits page the rename PR left), `apps/web/src/lib/copy-truth.ts` if it lists help tokens
- Create: `apps/web/src/server/usecases/online-package/events.ts`; `apps/web/e2e/online-chess-player-sweep.spec.ts`
- Test: `apps/web/src/lib/__tests__/online-chess-copy.test.ts`

**Interfaces:**
- Produces: dictionary keys under `onlineChess.size.*`, `onlineChess.price.*`, `onlineChess.payLine.*`, `onlineChess.receipt.*`, `onlineChess.chip.*`, `onlineChess.refusal.<CODE>`, `onlineChess.format.*`, `settings.credits.stream.kind.onlinePackage{Paid,Resized,Refunded}`; `capturePackageEvent(kind: "bought" | "resized" | "refunded", props)` sending `online_chess_package_<kind>` with `size`, `cameras`, `credits`, `monthly`, `pack`, `forfeited`, `plan`, `at_round_one`.

- [ ] **Step 1: Write the failing tests:**
  ```ts
  it("every online-chess key exists in all 4 locales", () => { /* expect(checked).toBeGreaterThan(40) */ });
  it("every code in ONLINE_PACKAGE_CODES has a refusal string", () => { /* expect(checked).toBe(8) */ });
  it("no organiser string says External Play", …);
  it("divset.onlinePlay.label and .summaryOn say Online Chess", …);
  it("the help price table is built from the leaf's tokens, not typed numbers", …);
  ```
- [ ] **Step 2: Run, confirm they fail.**
- [ ] **Step 3: Write the copy** (English from §8; translate with `npm run i18n:translate`, then read the three translations for the proper names "Online Chess", "Fair-play camera", "Seazn credits"); `npm run i18n:gen-keys`; `npm run i18n:check`.
- [ ] **Step 4: Help.** `sports/chess.md` gains "Online Chess: sizes and credits" (sizes, what is included, Swiss and knockout only, change before round 1, refunds). No redirects.
- [ ] **Step 5: The player sweep** (`online-chess-player-sweep.spec.ts`): as a player, in each of the 4 locales, open the public registration page, the division page, the match room and check-in of a paid online division; scan RENDERED TEXT for that locale's words for credit, plan, upgrade, size and for the price. Assert pages scanned is 4 × 4 = 16 and hits are 0. Paired positive: the same scan over the organiser's receipt finds the words.
- [ ] **Step 6: Events.** Call `capturePackageEvent` after commit from Tasks 5, 6 and 9. Unit-test the props of each kind.
- [ ] **Step 7: Run, confirm pass. Commit** `feat(online-chess): copy in four locales, help, player sweep, package events`.

---

### Task 14: Wave close

- [ ] **Step 1: Scoped gate.** Run every test file this wave created or changed, in one vitest call with the JSON reporter; paste the counts.
- [ ] **Step 2: OpenAPI drift.** `npm run openapi:gen` leaves a clean tree.
- [ ] **Step 3: Lint** the changed files with `rtk proxy npx eslint <files>`; read `✖ N problems`.
- [ ] **Step 4: Use the product.** With `ONLINE_CHESS_ALWAYS=1` on a local prod build (per `seazn-local-env`): do the walkthrough by hand once, and read the rows out of `org_stream_credits` and `division_online_packages` after each step. Write down what you saw.
- [ ] **Step 5: Review.** Dispatch the reviewer over the whole branch with the three standing lenses; fix; re-run Step 1.
- [ ] **Step 6: One PR.** Body per the `pr` skill; list the mutations run per task and the Task 0 findings. Smoke runs on the PR. E2E does not run on a PR: trigger `e2e.yml` by `workflow_dispatch` with the PR number, and hand back instead of waiting.
- [ ] **Step 7: Before the flag reaches a paying club:** set the Cloudflare billing alert (§14).

---

## Open at build time

| Item the spec marks unverified | Verified first in |
|---|---|
| The rename is merged; every cited line still holds | Task 0 |
| Staging census of online divisions on a refused format | Task 0 |
| Next free migration number | Task 0, re-checked in Task 2 |
| How the webhook treats a PARTIAL card refund (the claw-back is told an intent, not an amount) | Task 6, Step 3: read the caller in `server/usecases/billing-events/`; if a partial refund calls the claw-back, record that settle treats it as whole, and flag it in the PR |
| Lock order: no existing path takes the org money lock and then a `division:` lock | Task 5, by the concurrency test, not by reading |
| Which role the public places-left read runs as (it must read the size) | Task 7 |
| The function that promotes the waitlist (`promoteOldestWaitlisted`, `registrations/waitlist.ts:202`, found while planning; confirm it is the automatic path) | Task 7 |
| `stream-sessions/current.ts` holds no org-wide consume count | Task 10 |
| The "Add a round" server door stays ungated after the freeze | Task 8 |
| The stage update and stage camera save doors' exact files | Task 8, Step 3 |
| No sweep acts on boards of a round that was never opened (an unpaid, started division) | Task 14, Step 4, by driving it |
| Which `fixture_external_play` columns give camera minutes per time control | Not in this wave: the metric is a nightly query written after the first real event; recorded in the PR as owed |
| Event Pass credit amount after plan-limits merges | Not in this wave: nothing here reads it |
| Stripe product display names for the packs | The rename PR; confirm in Task 0 |

## Self-review notes

- **Coverage:** §3 decisions 1–16 map to Tasks 1 (prices, rounds, formats), 5 (pay, move down, add cameras), 6 (refunds), 7 (limit), 8 (formats, rounds, cameras), 9 (round 1), 11–12 (flow), 13 (names, players). §7.5 is Task 6. §13's tests are distributed by owner. §14 rollout step 1 is the dependency; step 3 and §15 are the separate plan named in Global Constraints.
- **Plan calls where the spec is silent:** paying on a billing-frozen competition is refused (Review Focus 4); route shape `GET`/`POST /divisions/{id}/online-package`; `openRound` takes `pay`; the checkout return address; a `for update` on the package row after the two advisory locks.
