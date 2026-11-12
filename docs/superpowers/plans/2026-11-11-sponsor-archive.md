# Archive a Sponsor: Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to carry out this plan task by task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** An editor can archive a sponsor from its own console page. An archived sponsor:
- is hidden from the Sponsors list, every public page, both TV slideshows, the stream and the `/s/` redirect;
- keeps every record (deals, invoice numbers, PDFs, payments, click counts);
- is refused while a deal still holds it ("End or settle its deal first.");
- comes back exactly as it was on Unarchive.

The list gains a slim "Show archived (N)" switch.

**Architecture:**
- **Storage:** one nullable column, `sponsors.archived_at` (V505, provisional), orthogonal to `status`.
- **Server:**
  - two usecases, `archiveSponsor` and `unarchiveSponsor`, under the F2 sponsor lock;
  - one deal predicate, `blocksArchive`, in `lib/sponsor-deals.ts`;
  - two new refusal codes;
  - the archive filter added to the five SQL visibility sites, pinned by a static sweep;
  - `createDeal` and `patchSponsor` refuse an archived sponsor.
- **Console:**
  - a shared `SlimSwitch` (lifted from the On stream tab);
  - the list's switch and a trailing greyed group;
  - the sponsor page's Archive card, and an archived banner with Unarchive.

**Tech stack:**
- Next 16 App Router, React 19.2.4, Tailwind v4.
- zod 4, postgres.js, Flyway.
- Tests: vitest (node environment, `renderToStaticMarkup` plus `components/__tests__/_hook-harness.tsx`), Playwright run on CI, and the `scripts/smoke` harness.

**Spec:** `docs/superpowers/specs/2026-11-11-sponsor-archive-design.md`. Read it first. It holds the re-pinned facts and false premises (§4), the decisions D1 to D28 (§5), the API table (§6.3), the UI at each width (§7), the blocking table (§8), the sequences (§9), the copy (§10) and the reader inventory (§11).

## Global Constraints

- **Worktree:** `/Users/ashokhein/github/seazn.club-worktrees/sponsor-archive`, branch `feat/sponsor-archive`.
  - Every Bash call starts with `cd <worktree> &&`.
  - Never `git stash` and never `git checkout <file>`. Restore a mutant from a `cp` backup.
  - In zsh, write a revision variable as `"${R}:path"`, never `"$R:path"` (`:a` is a modifier).
- **Order:** start only after #1176 (`feat/sponsor-deals-invoices`) has merged to main. Rebase this branch onto main first, then **re-pin every line number** this plan cites (they were read at PR 3 `db49811d45`).
- **Migration:** authored as **`V505__sponsor_archive.sql`** (main holds V501 title poster and V502-V504 sponsor invoices; V505 is the next free number). Its first line self-names `-- V505 — …`.
  - Tests find it **by suffix** (`/^V\d+__sponsor_archive\.sql$/`).
  - At merge, renumber to the next free number on main: `git mv` plus a line-1 edit. `migration-header-truth.test.ts` checks line 1.
- **One rule each:**
  - visibility is `status = 'active' and archived_at is null` in SQL;
  - blocking is `blocksArchive` (`lib/sponsor-deals.ts`), read by the server and the console alike;
  - refusals are `sponsorRefusal(409, …, "sponsor_has_current_deal" | "sponsor_archived")`.
- **API:** `POST` and `DELETE /api/v1/orgs/{id}/sponsors/{sponsorId}/archive`, both idempotent, both answering `Sponsor`, both listed in `NEVER_KEY_ROUTES`. The list takes `?archived=1` to include archived rows.
  - Run `npm run openapi:gen` after any schema change and commit `openapi/v1.json`. `git status --porcelain openapi/` must be clean after a second gen, and `v1.public.json` must not move.
  - No `docs/api-v1-breaking-changes.md` entry (spec D13).
- **Copy:**
  - every string in all four locales, exact text from spec §10;
  - `ui.json` takes the new keys in a **new block**, inserted, never reordered (AGENTS.md class 18);
  - after a dictionary edit, run `npm run i18n:gen-keys` and `npm run i18n:check` from the repo root.
- **Tests (TEST-STRATEGY.md, owner 2026-09-28):**
  - list the state transitions and the empty case first;
  - every sweep counts what it checked, and **zero is a failure**;
  - expected values come from the spec's tables (§8, §9, §11), the dictionary JSON or a declared constant, never from the function under test;
  - **mutate each guard you add once**, restoring from a `cp` backup, and report the killer;
  - every negative has its positive pair;
  - sport sweep: not applicable (sponsor visibility is sport-agnostic). Each test file states this once in its header.
- **Local verification (owner 2026-11-07):** run only the exact test files you changed or added, plus a scoped tsc. Never run eslint, a whole-project tsc, or Playwright locally.
  - **vitest** (from `apps/web`; DB suites need `DATABASE_URL`, see the `seazn-local-env` skill: `db:apply` + `sync:sports`):
    ```bash
    cd /Users/ashokhein/github/seazn.club-worktrees/sponsor-archive/apps/web && \
      npx vitest run --reporter=json --outputFile=$SCRATCH/tN.json <exact paths>; echo EXIT=$?
    jq '{total:.numTotalTests,passed:.numPassedTests,failed:.numFailedTests,files:[.testResults[].name]}' $SCRATCH/tN.json
    ```
    Pin `total`, and confirm `files` resolves inside this worktree.
  - **Scoped tsc:** the `tsconfig.changed.tN.json` recipe from `docs/superpowers/plans/2026-11-11-title-sponsor-hero-poster.md` (Global Constraints). Never commit that file.
  - **E2E collection only:** `npx playwright test --list <spec> > $SCRATCH/list.txt 2>&1`.
- `grep -a` always.
- Commits are conventional and end with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`. No PNG is ever committed.
- **Model marks** on each task heading: **[DB]** schema, data or server write path; **[UI]** console UI; **[money]** none here. `createDeal`'s refusal sits before any money moves, but its mutant is still owed (Task 3).

## Review Focus

The five failure modes most likely to hurt a real person, each pinned by a named test in its owning task:

1. **A reader that still shows the archived sponsor.** One SQL site misses the filter, so the sponsor stays on the stream's assigned break, or its `/s/` code still redirects and counts. Pinned by Task 4's per-reader DB tests (each with its unarchived positive) and the static sweep that fails on any `status = 'active'` sponsors read without `archived_at is null`.
2. **Archive succeeds while money is still owed, or a deal can still go live.** Pinned by Task 2's §8 table sweep and Task 3's sequence (an `expired` offline deal: 409, Write off, then archive).
3. **An invoice link breaks after archive.** Pinned by Task 3's regression (`invoiceDocByToken` non-null after archive) and Task 7's e2e (the invoice page opens, logged out, after archive).
4. **Unarchive does not restore "as it was".** Tier, scope, `on_stream`, `status`, `display_order`, `click_count` or the poster drifts. Pinned by Task 3's snapshot compare (every column but `archived_at`, read from the row).
5. **A deal is created on an archived sponsor and burns an invoice number.** Pinned by Task 3 (409 `sponsor_archived`, no `sponsor_orders` row, `sponsor_invoice_counters.last_number` unchanged), with both refusal points mutated separately.

---

## File structure

| File | Responsibility | Task |
|---|---|---|
| `db/migration/deltas/V505__sponsor_archive.sql` (new) | Column | 1 |
| `apps/web/src/server/sponsors/__tests__/archive-migration.test.ts` (new) | Column shape, found by suffix | 1 |
| `apps/web/src/lib/sponsor-deals.ts` | `blocksArchive` | 2 |
| `apps/web/src/lib/__tests__/sponsor-deals.test.ts` | §8 table | 2 |
| `apps/web/src/server/usecases/sponsors.ts` | `SponsorRow.archived_at`, `COLS`, `listSponsorRows` option, `archiveSponsor`, `unarchiveSponsor`, `patchSponsor` refusal, `resolveSponsors` filter | 3, 4 |
| `apps/web/src/server/sponsors/deal-apply.ts` | `LockedSponsor.archived_at` in `lockSponsorAndDeals` | 3 |
| `apps/web/src/server/usecases/sponsor-deals.ts` | `createDeal` refusal ×2 | 3 |
| `apps/web/src/lib/sponsor-refusals.ts` | Two codes | 3 |
| `apps/web/src/app/api/v1/orgs/[id]/sponsors/[sponsorId]/archive/route.ts` (new) | POST, DELETE | 3 |
| `apps/web/src/app/api/v1/orgs/[id]/sponsors/route.ts` | `?archived=1` | 3 |
| `apps/web/src/server/api-v1/key-scopes.ts`, `api-v1/openapi.ts`, `api-v1/schemas/sponsors.ts`, `openapi/v1.json` | Routes classified and documented | 3 |
| `apps/web/src/server/usecases/__tests__/sponsor-archive.test.ts` (new) | DB: the sequences of spec §9 | 3 |
| `apps/web/src/server/sponsors/clicks.ts`, `server/sponsors/card-source.ts`, `server/sponsors/report.ts` | Reader filters | 4 |
| `apps/web/src/server/sponsors/__tests__/archive-readers.test.ts` (new) | DB: every reader, with positive pairs | 4 |
| `apps/web/src/server/sponsors/__tests__/archive-reader-sweep.test.ts` (new) | Static sweep (D27) | 4 |
| `apps/web/src/components/ui/slim-switch.tsx` (new), `components/sponsors/on-stream-tab.tsx` | Shared switch | 5 |
| `apps/web/src/components/org-sponsors.tsx`, `components/sponsors/sponsor-list.tsx`, `components/sponsors/save-error.ts`, `app/o/[orgSlug]/sponsors/page.tsx` | List, switch, trailing group, On stream filter, refusal words | 6 |
| `apps/web/src/components/sponsors/sponsor-sheet.tsx`, `components/sponsors/overview-tab.tsx` | Archive card, archived banner, read-only page, Overview chip | 7 |
| `apps/web/src/dictionaries/{en,es,fr,nl}/ui.json`, `apps/web/src/lib/i18n-keys.ts` | Copy | 6, 7 |
| `apps/web/e2e/sponsor-archive.spec.ts` (new), `apps/web/e2e/mobile.spec.ts` | E2E | 8 |
| `scripts/smoke/suites/sponsors.ts` | Smoke rows | 9 |
| `apps/web/e2e/walkthrough/sponsor-archive-captures.spec.ts` (new), `.github/workflows/e2e.yml`, `apps/web/src/lib/__tests__/e2e-ci-wiring.test.ts` | Sign-off captures | 10 |

---

### Task 1 [DB]: Migration `V505__sponsor_archive.sql`

**Files:**
- Create: `db/migration/deltas/V505__sponsor_archive.sql`
- Test: `apps/web/src/server/sponsors/__tests__/archive-migration.test.ts`

**Interfaces:**
- Produces: column `sponsors.archived_at timestamptz null`.

- [ ] **Step 1: Write the failing test.** Use the rig of `server/sponsors/__tests__/migration.test.ts` (privileged `sql`, `describe.skipIf(!HAS_DB)`). The header says "sport-agnostic: no sport sweep".
  ```ts
  const DELTA = /^V\d+__sponsor_archive\.sql$/;
  it("finds exactly one sponsor_archive delta, by suffix")          // matches.length === 1
  it("its first line names its own version")                         // /^--\s*V(\d+)\s*[—–-]\s/ captures fileVersion(name)
  it("archived_at is nullable timestamptz with no default")          // information_schema: 'timestamp with time zone', 'YES', null
  it("an existing sponsor reads archived_at null after the delta")   // insert a row without the column; read back null
  ```
- [ ] **Step 2: Run it and see it fail.** Expected: `matches.length 0`, and `column "archived_at" does not exist`.
- [ ] **Step 3: Write the migration.** Use the exact SQL of spec §6.1, with line 1 self-naming. Run `npm run db:apply`.
- [ ] **Step 4: Run it and see it pass.** Expected: total 4, passed 4. Also run `src/lib/__tests__/migration-header-truth.test.ts`: green.
- [ ] **Step 5: Mutate once.** Change line 1 to `-- V504 — …`. `migration-header-truth` and "its first line names its own version" must both go red. Restore.
- [ ] **Step 6: Commit** with `feat(sponsors): archived_at column (V505, renumber at merge)`.

**Acceptance:** column present; the file is found by suffix; the header is truthful. Owner checklist rows: "Assumptions are guards", "Negative assertion needs its positive pair".

---

### Task 2 [DB]: `blocksArchive`, the one blocking rule

**Files:**
- Modify: `apps/web/src/lib/sponsor-deals.ts` (after `endedStillDue`, about `:221`)
- Test: `apps/web/src/lib/__tests__/sponsor-deals.test.ts`

**Interfaces:**
- Produces: `export function blocksArchive(d: Pick<SponsorDeal, "deal_status" | "payment_method" | "payment_status" | "live_at" | "ended_reason">): boolean`, which is `d.ended_reason !== "legacy" && (isLiveDeal(d) || isOpenDeal(d) || endedStillDue(d))`.

- [ ] **Step 1: Write the failing tests.**
  - **Empty case first:** `[].some(blocksArchive) === false`.
  - **The table:** spec §8 transcribed as a literal `ROWS` array of `{ deal, blocks }`. Every `deal_status` of `DEAL_STATUSES` must appear at least once; assert `seenStatuses.size === DEAL_STATUSES.length` (the anti-vacuity count), and assert `checked === ROWS.length` with `ROWS.length >= 14`.
  - **Differential pair:** an `expired` offline unpaid deal that went live blocks; the same deal with `live_at: null` does not. An `expired` **online** unpaid deal does not.
  - **Legacy:** an ended legacy order does not block.
- [ ] **Step 2: Run them and see them fail** (`blocksArchive` is not exported).
- [ ] **Step 3: Implement** the one-liner, with a header comment citing spec D9 and §8.
- [ ] **Step 4: Run them and see them pass.** Report the total.
- [ ] **Step 5: Mutate each arm once, restoring from `cp` each time, and report the killer of each.**
  1. Drop `|| endedStillDue(d)`: the `expired` offline row goes red.
  2. Drop `|| isOpenDeal(d)`: the draft, awaiting_payment, awaiting_approval and scheduled rows go red.
  3. Drop `isLiveDeal(d) ||`: the live row goes red.
  4. Drop the legacy check: the legacy row goes red only if a legacy row can be open. If nothing kills this mutant, record it as equivalent with that reason.
- [ ] **Step 6: Commit** with `feat(sponsors): blocksArchive, the one rule for what holds a sponsor`.

---

### Task 3 [DB]: Archive and Unarchive: usecases, refusals, routes, OpenAPI

Batched in one pass, because every step touches `usecases/sponsors.ts`, and Task 4 continues in the same file.

**Files:**
- Modify:
  - `usecases/sponsors.ts`: `SponsorRow` `:71-95`, `COLS` `:99-102`, `listSponsorRows` `:197-223`, `listSponsors` `:225-227`, `patchSponsor` after the lock `:293`; new `archiveSponsor` and `unarchiveSponsor` after `deleteSponsor`;
  - `server/sponsors/deal-apply.ts` (`LockedSponsor` `:39-49`, the select `:135`);
  - `usecases/sponsor-deals.ts` (`createDeal` `:249`, `:310`);
  - `lib/sponsor-refusals.ts`;
  - `app/api/v1/orgs/[id]/sponsors/route.ts`;
  - `api-v1/schemas/sponsors.ts` (`Sponsor` `:92-125`);
  - `api-v1/openapi.ts` (`:252-263`);
  - `api-v1/key-scopes.ts` (`NEVER_KEY_ROUTES` `:346-350`);
  - `openapi/v1.json` (generated);
  - `components/org-sponsors.tsx` (`SponsorItem.archived_at` only);
  - `app/o/[orgSlug]/sponsors/page.tsx` (`listSponsorRows(active.id, { includeArchived: true })` for the Sponsors tab only).
- Create: `app/api/v1/orgs/[id]/sponsors/[sponsorId]/archive/route.ts` (copy `venues/[venueId]/archive/route.ts`).
- Test:
  - `server/usecases/__tests__/sponsor-archive.test.ts` (new, DB);
  - `server/sponsors/__tests__/url-write-schemas.test.ts` (key-order unchanged; `archived_at` is in no write schema);
  - `components/sponsors/__tests__/save-error.test.ts` (it walks `SPONSOR_REFUSAL_CODES`, so the new codes join automatically and the test fails until they have words; Task 6 adds the words, so in this task add a temporary map entry pointing to the existing `sponsors.error.hasOpenDeal`, and record it in the commit body as replaced in Task 6);
  - the key-scopes enumeration test (`server/api-v1/__tests__/key-scopes*.test.ts`: every route file is classified).
- Fan-out: every `SponsorRow` and `SponsorItem` literal in tests gains `archived_at: null`. tsc lists them; find the rest with `grep -a -rl "SponsorItem\|SponsorRow" apps/web/src`.

**Interfaces:**
- Produces:
  - `SponsorRow.archived_at`, `SponsorItem.archived_at`, `LockedSponsor.archived_at`;
  - `listSponsorRows(orgId, opts?: { includeArchived?: boolean })`;
  - `archiveSponsor(auth, id): Promise<SponsorRow>`, `unarchiveSponsor(auth, id): Promise<SponsorRow>`;
  - codes `sponsor_has_current_deal` (409) and `sponsor_archived` (409);
  - routes `POST|DELETE /orgs/:id/sponsors/:sponsorId/archive`;
  - OpenAPI `Sponsor.archived_at: z.string().nullable()`, and the list query `archived: { schema: { type: "string", enum: ["1", "0"] } }`.

- [ ] **Step 1: Write the failing DB tests** in `sponsor-archive.test.ts`. Use the seeding of `sponsors.test.ts` and the deal rigs of `_invoice-rig.ts` and `_money-fixtures.ts`. Read back from the **stored row** with privileged `sql`, never from the usecase's return value alone. The header states "sport-agnostic: no sport sweep". Expected values come from spec §9.
  ```ts
  it("empty first: a sponsor with no deals archives; the default list omits it; ?archived=1 lists it with archived_at")
  it("a second archive answers the first archived_at, unchanged")                                  // second call
  it("archive → unarchive → archive: each succeeds; after the unarchive every column but archived_at equals the pre-archive snapshot")
    // snapshot = select * from sponsors where id; compare all keys except archived_at (status, tier, competition_id, on_stream,
    // display_order, click_count, logo_path, url, name, placement_from_deal_id, and poster_path when the column exists)
  it("unarchive of a sponsor that is not archived answers it unchanged")
  it("each blocking deal state refuses 409 sponsor_has_current_deal and writes nothing (count reported)")
    // one sponsor per row of spec §8 marked "yes": draft, awaiting_payment, awaiting_approval, scheduled, live, live parked, ended-still-due
    // assert archived_at stays null on each; checked === 7
  it("after End now the same sponsor archives; its deals, invoice_number and invoice_token_hash are unchanged")
  it("an offline deal ended 'expired' unpaid: 409; Write off; then archive succeeds")              // the "settle" path
  it("with invoices: archived, invoiceDocByToken(token) still answers the doc; delete is still 409 sponsor_has_deal_history")
  it("without invoices: a sponsor with only an ended complimentary deal archives, and can still be deleted")
  it("an archived sponsor: createDeal is 409 sponsor_archived; no sponsor_orders row; sponsor_invoice_counters.last_number unchanged")
  it("an archived sponsor: PATCH {name} is 409 sponsor_archived and the name is unchanged")
  it("PATCH {archived_at: null} is 400 empty patch, and the sponsor stays archived")              // regression: no back door
  it("unarchived: createDeal works and, immediate, goes live; resolveSponsors carries it again")   // "a new deal later works normally"
  it("Free org (no sponsors.tiers): archive and unarchive work; the free strip drops and regains the row")
  it("Event Pass org: archive and unarchive work on the pass's competition sponsor")
  it("another org's sponsor: archive and unarchive are 404, and its archived_at is unchanged")
  it("archive racing createDeal: exactly one wins under the sponsor lock")  // sponsor-lock.test.ts's F16 lock-witness shape:
    // tx A holds lockSponsorAndDeals; start archive and createDeal; release; assert (deal exists XOR archived)
  ```
  Route test, following `app/api/v1/orgs/[id]/sponsors/__tests__/on-stream.test.ts`: the GET default omits archived rows; `?archived=1` includes them; `?archived=yes` omits them; POST and DELETE answer the `Sponsor` shape.
- [ ] **Step 2: Run them and see them fail.**
- [ ] **Step 3: Implement** per spec §6.2. In order:
  1. `LockedSponsor` and the select;
  2. `COLS`;
  3. the two usecases, which await `expirePublicSponsors(auth.orgId, "sponsor.archive" | "sponsor.unarchive")` after the commit and `log.info`;
  4. the `patchSponsor` refusal right after `if (!locked) …`;
  5. the `createDeal` pre-read (`select archived_at from sponsors where id`) and the re-check after `lockSponsorAndDeals`, before `allocateInvoiceNumber`;
  6. the codes;
  7. the route;
  8. `?archived=1`;
  9. the schema, OpenAPI rows and summaries (spec §6.3), and the key-scopes entries.

  Then run `npm run openapi:gen`.
- [ ] **Step 4: Run them and see them pass.**
  - Run the test files plus the fixture-only files you edited, and report `total` and `passed`.
  - Run `openapi:gen` a second time: the porcelain must show only the first gen's change, and `openapi/v1.public.json` must be untouched.
  - Scoped tsc: EXIT=0.
- [ ] **Step 5: Mutate once each, restoring from `cp` each time, and report the killers.**
  1. `archiveSponsor`: delete the `blocksArchive` refusal. Killer: "each blocking deal state refuses…".
  2. `archiveSponsor`: delete the idempotent early return, so a second call re-stamps. Killer: "a second archive answers the first archived_at".
  3. `createDeal`: delete the **pre-read** refusal only. Expected: still red, because the locked re-check refuses, but with a different failure path. If it stays green, record that the two refusals cover each other, then delete the **locked** re-check only; the race test must go red. Report both.
  4. `createDeal`: move the locked re-check after `allocateInvoiceNumber`. Killer: "…last_number unchanged" goes red only if the transaction commits. Record whether rollback makes this mutant equivalent.
  5. `patchSponsor`: delete the `sponsor_archived` refusal. Killer: "PATCH {name} is 409".
  6. `listSponsorRows`: ignore `includeArchived` (always include). Killer: "the default list omits it".
  7. `expirePublicSponsors` removed from `archiveSponsor`: no unit test kills it. **Smoke** kills it (Task 9). Record that.
- [ ] **Step 6: Commit** with `feat(sponsors): archive and unarchive a sponsor (API, refusals, a new deal waits for unarchive)`.

---

### Task 4 [DB]: Every reader filters archived sponsors (spec §11)

**Files:**
- Modify:
  - `usecases/sponsors.ts` `resolveSponsors` `:472-476`: `and archived_at is null` inside the `where`, **before** the dedupe;
  - `server/sponsors/clicks.ts` `:63`, `:70`, `:88`;
  - `server/sponsors/card-source.ts` `:67`;
  - `server/sponsors/report.ts` `sponsorOverview` (the `where s.org_id … and ${listed}` arm): D15's predicate, and `archived: boolean` on `SponsorOverviewRow`.
- Test:
  - `server/sponsors/__tests__/archive-readers.test.ts` (new, DB);
  - `server/sponsors/__tests__/archive-reader-sweep.test.ts` (new, pure);
  - existing: `clicks.test.ts`, `assign.test.ts`, `usecases/__tests__/sponsors.test.ts`, `app/(public)/live/.../fixtures/[fixtureId]/__tests__/page-sponsors.test.ts`.

**Interfaces:**
- Consumes: Task 3's column and usecases.
- Produces: `SponsorOverviewRow.archived: boolean`.

- [ ] **Step 1: Write the failing tests.**

  `archive-readers.test.ts` (DB). Seed a Pro org and a competition, with sponsor **T**: active, tier `title`, competition-scoped, `on_stream`, a URL, a minted short code, a `sponsor_assignments` row, one click and one airing in the period. Every case reads T's absence after archive **and** its presence after unarchive (the positive pair). Count reported: `checked === 10`.
  ```ts
  it("resolveSponsors (tiered) — competition page, hero title, poster")
  it("resolveSponsors (tiered:false) — the free strip, slideshows, embed-data, orgBranding")
  it("resolveSponsors (onStream:true) — sponsorsTableCardSource.cardsFor, the rotation")
  it("activeSponsorCards — an assigned break airs nothing")
  it("resolveSponsorLink by uuid → null; recordClick writes no click and click_count is unchanged")
  it("resolveSponsorLink by short code → null")
  it("orgBranding(…) carries no sponsor T")
  it("sponsorOverview lists T archived:true while it has numbers in the period, and not in an empty period")  // D15, both directions
  it("sponsorReport(token) still answers T's report after archive")                                          // regression: a record
  it("name dedupe: an archived 'Acme' (older, competition-scoped) never hides a new active 'Acme'; the new id resolves")  // D28
  ```

  `archive-reader-sweep.test.ts` (pure, D27).
  - Walk `apps/web/src/server/**/*.ts`, excluding `__tests__`.
  - Find each SQL template that reads the `sponsors` table (`/\b(from|join)\s+sponsors\b/i`) **and** filters `status\s*=\s*'active'`.
  - Assert that each such template also contains `archived_at is null`.
  - Report the list. Assert `found.length === 5`, the inventory of spec §11 (resolveSponsors, the two `resolveSponsorLink` arms, `recordClick`, `activeSponsorCards`), and assert `found.length > 0`.
  - Positive pair: a fixture string with the filter passes and one without it fails, through the same matcher.
- [ ] **Step 2: Run them and see them fail.**
- [ ] **Step 3: Implement** the five filters and the Overview predicate.
- [ ] **Step 4: Run them and see them pass,** together with the four existing files. Report totals. Scoped tsc: EXIT=0.
- [ ] **Step 5: Mutate each site once, restoring each time, and report the killers.** Each mutant must be killed by its own reader case **and** by the sweep. A site killed only by the sweep is a gap: add its reader case.
  1. `resolveSponsors`: move the filter **after** the dedupe (filter in TS). Killer: the name-dedupe case.
  2. Drop the filter from `resolveSponsors`.
  3. Drop it from the `resolveSponsorLink` uuid arm.
  4. Drop it from the short-code arm.
  5. Drop it from `recordClick`.
  6. Drop it from `activeSponsorCards`.
  7. Drop the Overview predicate's `archived_at is null or` half.
- [ ] **Step 6: Commit** with `feat(sponsors): an archived sponsor leaves every public surface, the stream and the redirect`.

---

### Task 5 [UI]: `SlimSwitch`, the shared house switch

**Files:**
- Create: `apps/web/src/components/ui/slim-switch.tsx` (client), lifted verbatim from `on-stream-tab.tsx:214-235`.
  - Props: `{ checked, onChange, disabled?, labelledBy, testId, trackTestId?, knobTestId?, tone?: "purple" | "slate" }`.
  - The button is a 44 px target (`h-11 w-14`) with `role="switch"` and `aria-checked`. Inside it, a 24 × 44 track and a 20 px knob, with `motion-reduce:transition-none`.
- Modify: `on-stream-tab.tsx`, which renders `<SlimSwitch testId="on-stream-switch" trackTestId="on-stream-switch-track" knobTestId="on-stream-switch-knob" tone="purple" …/>`.
- Test:
  - `components/sponsors/__tests__/on-stream-tab.test.tsx`, **unchanged**. It is the regression proof that the extraction moved nothing.
  - `components/ui/__tests__/slim-switch.test.tsx` (new): role, `aria-checked` both ways, `aria-labelledby`, `disabled`, and the proportions read from the shipped classes (the target is 44 px; the track is no taller than 32 px and at least 1.5× wider than tall), as in `on-stream-tab.test.tsx:218-230`.

**Coordination:** before starting, `git log origin/main -- apps/web/src/components/ui/` for a switch the retired-packages work may have landed. If one exists, use it and skip this task (spec D23).

- [ ] **Step 1:** Write the slim-switch test, and see it fail.
- [ ] **Step 2:** Implement, and port the On stream tab.
- [ ] **Step 3:** Run both files. `on-stream-tab.test.tsx` must pass with zero edits.
- [ ] **Step 4: Mutate:** swap the track's `h-6` for `h-11`. The proportion case in **both** files must go red. Restore.
- [ ] **Step 5: Commit** with `refactor(ui): the slim switch is one component; the On stream tab uses it`.

---

### Task 6 [UI]: The list: "Show archived (N)", the trailing group, the On stream filter, the refusal words

**Files:**
- Modify:
  - `components/org-sponsors.tsx`: derive `live` and `archived`; local `showArchived` state, reset to false when `archived.length` reaches 0; pass both to `SponsorList`; after a delete, also remove the row from `archived`.
  - `components/sponsors/sponsor-list.tsx`:
    - the switch row (spec §7.1, `sponsors-archived-switch`);
    - the trailing group `data-tier="archived"`;
    - archived rows `data-archived="true"`, `opacity-60`, with the "Archived" chip, no move buttons, no row action, the trash kept, and the pencil linking to `sponsorHref` (read-only);
    - the export `ARCHIVED_ROW = "opacity-60"` for the tests.
  - `components/sponsors/save-error.ts`: `sponsor_has_current_deal → "sponsors.archive.blocked"`, `sponsor_archived → "sponsors.error.archived"` (this replaces Task 3's temporary entries).
  - `app/o/[orgSlug]/sponsors/page.tsx`: the On stream tab's `listSponsorRows(active.id)` stays default (archived excluded).
  - The four `ui.json` files: every key of spec §10 (new block), plus the changed value of `sponsors.error.hasDealHistory`. Then `lib/i18n-keys.ts` (generated).
- Test:
  - `components/sponsors/__tests__/sponsor-list.test.tsx`;
  - `components/__tests__/org-sponsors-deal-locks.test.tsx` (or a new `org-sponsors-archive.test.tsx` using `_hook-harness`);
  - `components/sponsors/__tests__/save-error.test.ts`;
  - `app/o/[orgSlug]/sponsors/__tests__/page.test.tsx`.

- [ ] **Step 1: Write the failing tests.** Expected strings are read from `dictionaries/en/ui.json`, never typed.
  ```ts
  it("empty first: no archived sponsor → no switch in the markup at all")                       // N = 0
  it("one archived → the switch reads 'Show archived (1)', aria-checked=false, and no archived row is rendered")
  it("switch on → a trailing group data-tier='archived' after every tier group, its rows greyed with the chip")
  it("an archived row has no move buttons and no row action; a live row in the same render still has both")    // positive pair
  it("the last archived sponsor unarchived → the switch is gone, and re-archiving shows it off again")         // sequence
  it("flat list (no tiers): the archived group still trails")
  it("viewer: the switch shows, and an archived row has no trash")
  it("save-error: sponsor_has_current_deal reads 'End or settle its deal first.' in en/es/fr/nl, through the real v1 handler")
  it("On stream tab: an archived ticked sponsor is not in the tick list; unarchived, it is")                   // page.test
  it("hasDealHistory's refusal now ends 'Archive it instead.' in four locales")                                // regression on copy
  ```
- [ ] **Step 2: Run them and see them fail.**
- [ ] **Step 3: Implement.** Run `npm run i18n:gen-keys` and `npm run i18n:check`.
- [ ] **Step 4: Run them and see them pass.** Report totals. Scoped tsc: EXIT=0.
- [ ] **Step 5: Mutate once each, and report the killers.**
  1. Render the switch when `archived.length >= 0`. Killer: "empty first".
  2. Render archived rows in their tier group. Killer: "trailing group".
  3. Keep the move buttons on archived rows. Killer: "no move buttons".
  4. Pass `includeArchived: true` to the On stream tab. Killer: the On stream case.
- [ ] **Step 6: Commit** with `feat(sponsors): Show archived switch and the archived group on the Sponsors list (four locales)`.

---

### Task 7 [UI]: The sponsor page: Archive card, archived banner, Unarchive, read-only

**Files:**
- Modify:
  - `components/sponsors/sponsor-sheet.tsx`:
    - the Archive card (spec §7.2);
    - the archived banner and Unarchive (spec §7.3);
    - for an archived sponsor: hide Edit, the editor, the stream checkbox (show the read-only state instead), Show again and Add deal.
    - New props `onArchive` and `onUnarchive`. `archiveBlocked` is computed from `deals.filter(d => d.sponsor_id === sponsor.id).some(blocksArchive)`, the same predicate as the server.
  - `components/org-sponsors.tsx`: `archive(s)` and `unarchive(s)`. Each one:
    - calls `apiV1` `POST` or `DELETE …/archive`;
    - replaces the row with the answer;
    - sets the notice `sponsors.archive.done` or `sponsors.archive.unarchived`;
    - on error, reads `save-error`.
    - `editSponsor` is ignored when `selected.archived_at !== null` (spec D24).
  - `components/sponsors/overview-tab.tsx`: the "Archived" chip on `row.archived`.
- Test: `components/sponsors/__tests__/sponsor-sheet.test.tsx`, `overview-tab.test.tsx`, and the org-sponsors harness test from Task 6.

- [ ] **Step 1: Write the failing tests.**
  ```ts
  it("live sponsor, editor, no deals: the Archive card with its hint and an enabled button labelled 'Archive {name}'")
  it("each blocking deal (§8 'yes' rows) disables the button and draws the visible blocked line, linked by aria-describedby (count reported)")
  it("an ended, settled deal leaves the button enabled")                                             // positive pair of the above
  it("viewer: no Archive card")
  it("archived: the banner names the date in the org timezone; Unarchive is present; Edit, editor, Show again, Add deal and the stream checkbox are absent; Deals and Report link remain")
  it("archived + ?edit=1: the read-only page, never the editor")                                     // D24
  it("archive → the notice reads '{name} is archived.'; unarchive → '{name} is back in your list.'; the page swaps card for banner and back")   // harness, sequence
  it("a 409 sponsor_has_current_deal from the server (the client thought it free) shows the blocked words and leaves the row live")
  it("Overview: an archived row carries the chip; a live row does not")
  ```
- [ ] **Step 2: Run them and see them fail.**
- [ ] **Step 3: Implement.** Mobile-first: `min-w-0` down the chain, `break-words` on the hint, banner and blocked line, `min-h-11` buttons below `md`.
- [ ] **Step 4: Run them and see them pass.** Report totals. Scoped tsc: EXIT=0.
- [ ] **Step 5: Mutate once each, and report the killers.**
  1. `archiveBlocked` reads `isLiveDeal` only. Killer: the blocking sweep's open and still-due rows.
  2. Show Edit on an archived page. Killer: the archived case.
  3. Honour `?edit=1` when archived. Killer: the D24 case.
- [ ] **Step 6: Commit** with `feat(sponsors): Archive and Unarchive on the sponsor page (four locales)`.

---

### Task 8 [UI]: E2E: the journey, and seven widths

**Files:**
- Create: `apps/web/e2e/sponsor-archive.spec.ts`. It joins the parallel "rest" catch-all, so no list edit is needed. Confirm with `e2e-ci-wiring.test.ts`.
- Modify: `apps/web/e2e/mobile.spec.ts`. Add one test with its own seed, never in the serial setup test (`mobile.spec.ts:363-372` says why).

- [ ] **Step 1: Write `sponsor-archive.spec.ts`.** Seed through the v1 API as `sponsors-hub.spec.ts` does. Every step is driven through the UI unless named.
  - **A1, golden path:**
    - an active Gold sponsor with a URL and an ended, **paid offline** deal (numbered invoice); note its invoice URL;
    - open its page and tap Archive; the notice is announced;
    - back to the list: the row is gone and "Show archived (1)" shows;
    - turn the switch on: the greyed row is in the "Archived" group;
    - log out: the competition page has no sponsor name or `/s/<id>`;
    - `GET /s/<id>` answers 404;
    - **the invoice URL opens with its number** (D7).
  - **A2, blocked:** a sponsor with a live deal shows the disabled button and "End or settle its deal first.". End the deal through the UI, then Archive works.
  - **A3, the sequence:** Unarchive from the page (switch on, open the row). The list shows the row in its tier group again, with clicks unchanged; the public page shows it again. Archive again, then Unarchive again, then Add deal (complimentary, immediate) through the sheet; the deal is live.
  - **A4, no new deal while archived (API):** `POST …/deals` answers 409 `sponsor_archived`. Then, through the UI, the archived page offers no Add deal.
  - **A5, another plan:** a Free org does archive and unarchive, and its public strip drops and regains the row.
  - **A6, a viewer** sees the banner, and no Archive or Unarchive.
- [ ] **Step 2: `mobile.spec.ts`,** at all seven widths, with a 43-character name, es and nl:
  - the sponsor page with the Archive card blocked, and the archived page with its banner;
  - the list with the switch on;
  - no horizontal page scroll;
  - the switch and the Archive and Unarchive buttons are each ≥ 44 px and hit-tested with `elementFromPoint`;
  - axe clean.
  - Where a control is folded below `md` (the row's ⋯ tray), open the fold first (AGENTS.md class 22).
- [ ] **Step 3: Collect:** `npx playwright test --list` on both specs to a file; the new tests are listed. Run `e2e-ci-wiring.test.ts` with the Global vitest command.
- [ ] **Step 4: Commit** with `test(e2e): archive a sponsor: journey, sequence, invoice link, seven widths`. CI runs them in Task 10's dispatch.

---

### Task 9 [DB]: Smoke rows

**Files:**
- Modify: `scripts/smoke/suites/sponsors.ts`. Add the rows after "sp click_count incremented", plus one row in the free-org block.

- [ ] **Step 1: Write the rows.** Each `check()` can fail, and each negative sits next to its positive.
  ```ts
  check("sp archive: POST /archive answers 200 with archived_at", res.status === 200 && body.archived_at !== null);
  check("sp archive: the public page no longer carries the gold sponsor", !html.includes(`/s/${goldId}`));   // read right after the 200 (D22)
  check("sp archive: /s/<id> answers 404", hop.status === 404);
  check("sp archive: the default list omits it, ?archived=1 lists it", !ids(list).includes(goldId) && ids(listAll).includes(goldId));
  check("sp archive: a second POST keeps the first archived_at", again.archived_at === body.archived_at);
  check("sp archive: a PATCH is 409 sponsor_archived", patch.status === 409 && code(patch) === "sponsor_archived");
  check("sp unarchive: DELETE /archive answers 200, archived_at null, the page carries it again", …);
  check("sp archive: a sponsor with a live deal is 409 sponsor_has_current_deal", …);   // uses the deals suite's seed
  check("sp free: archive and unarchive work, and the free strip drops and regains it", …);
  ```
- [ ] **Step 2: Scoped typecheck** with the `tsconfig.scripts.json` recipe. Expected: EXIT=0. Smoke runs on the PR's CI only.
- [ ] **Step 3: Mutate once (CI).** In a throwaway commit, delete `expirePublicSponsors` from `archiveSponsor`. "the public page no longer carries…" must go red. This is Task 3's mutant 7. Drop the commit and record the run ID.
- [ ] **Step 4: Commit** with `test(smoke): archive and unarchive a sponsor`.

---

### Task 10 [UI]: Sign-off: CI captures at 320, 768 and 1280, a page on :8765, then renumber

**Files:**
- Create: `apps/web/e2e/walkthrough/sponsor-archive-captures.spec.ts`. Model it on `sponsor-deals-captures.spec.ts`:
  - it skips unless `SPONSOR_ARCHIVE_CAPTURE_DIR` is set;
  - it uses a tall viewport;
  - every state is witnessed before its shot.
- Modify:
  - `.github/workflows/e2e.yml`: a `sponsor_archive_captures` input, its step and its artifact upload, copied from `sponsor_deals_captures` together with its "wrote no screenshots" guard;
  - `apps/web/src/lib/__tests__/e2e-ci-wiring.test.ts`: add the inventory entry.

**States,** each at 320, 768 and 1280 (en unless named):
- `sheet-archive-free`, `sheet-archive-blocked`;
- `sheet-archived` (banner with Unarchive);
- `sheet-archived-viewer`;
- `list-switch-off`, `list-switch-on`;
- `list-no-archived` (the control: no switch);
- `sheet-archived-es`, `sheet-archived-nl` (43-character name);
- `overview-archived-row`.

The last test checks that every file exists, is a PNG, and that no two are byte-identical (AGENTS.md class 10).

- [ ] **Step 1:** Write the spec and the wiring. Collect with `--list` to a file. Run `e2e-ci-wiring.test.ts`.
- [ ] **Step 2: Commit** with `test(e2e): sponsor archive sign-off captures (opt-in)`.
- [ ] **Step 3:** Push and open the PR (the body ends with the attribution line). Smoke runs on the PR. Then make **one** dispatch:
  `gh workflow run e2e.yml --ref feat/sponsor-archive -f pr=<PR> -f sponsor_archive_captures=true`.
  Do not poll. Hand back the run ID, then read the raw counts: the seven width projects, the parallel legs, "captures: N", and smoke's rows.
- [ ] **Step 4:** Run the mutant dispatches owed by Tasks 8 and 9, each on a throwaway commit. Record each killer and run ID.
- [ ] **Step 5:** Build the sign-off page under `~/seazn-artifacts/2026-11-1X_sponsor-archive-signoff_<hex>/`: one panel per state, 320/768/1280 side by side, a line saying what to look at, and `Verdict: ____`. Use the shared `:8765` server.
- [ ] **Step 6:** Get the owner's verdict for **each screen** (AGENTS.md class 11), including the open questions of spec §13. Route any "fix" back to Tasks 6 and 7, then re-capture.
- [ ] **Step 7, before merge:** renumber V505 to the next free number on main. That is `git mv` plus line 1 (`-- V<n> — …`). Re-run `archive-migration.test.ts` and `migration-header-truth.test.ts`. The merge waits for the owner's explicit go.

---

## Self-review

- **Spec coverage:**
  - G1 → T3, T7; G2 → T4, T6; G3 → T3 (snapshot), T4 (records); G4 → T2, T3, T7; G5 → T5, T6; G6 → T6, T7, T8, T10.
  - D8 → T1, T3; D9 → T2; D10 → T3, T7; D11 → T3; D12 and D13 → T3; D14 → T4; D15 → T4, T7; D16 → T7, T8; D17 → T2; D18 → T3 (`poster_path` in the snapshot when the column exists), T4; D19 → T6; D20 → T7; D21 → T6; D22 → T3, T9; D23 → T5; D24 → T6, T7; D25 → T3, T8, T9; D26 → T3, T7, T8; D27 → T4; D28 → T4.
- **Four test types:**
  - Unit and DB: T1 to T7.
  - E2E: T8, plus T10's captures.
  - Smoke: T9.
  - Regression: delete is still refused for history (T3); the invoice page opens after archive (T3, T8); `PATCH {archived_at}` is no back door (T3); the name dedupe (T4); the On stream switch keeps its proportions (T5); the delete-refusal copy (T6).
- **The four reviewer questions:**
  - second call: archive and unarchive are idempotent (T3);
  - empty input: no deals, no archived rows, an empty Overview period (T2, T3, T4, T6);
  - after a void: a deal ended, written off or refunded, then archive (T3);
  - another sport: not applicable (sponsor visibility is sport-agnostic), stated in each test header.
- **Interfaces:** `blocksArchive`, `archiveSponsor`, `unarchiveSponsor`, `listSponsorRows({ includeArchived })`, `SponsorRow.archived_at`, `SponsorItem.archived_at`, `LockedSponsor.archived_at`, `SponsorOverviewRow.archived` and `SlimSwitch` are each defined once, in the task named by its Produces block.