# Court Stream (web) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let an organiser link a court to a connected YouTube channel for one venue day on the Match Day desk, so one phone scanned to that court's QR streams every match switched to *Stream* as its own broadcast, started by the scorer's Start and stopped after the result, with nobody touching the phone.

**Architecture:** A court link (`court_stream_links`) owns one stream code in the existing `fixture_stream_codes` table (a row with `court_link_id` instead of `fixture_id`), so pairings, beats, sessions and records keep their foreign keys. At each phone call the server reads the court's matches and asks one pure resolver (`courtFocus`) which match is current, which to start, which is next and which match's scoring link a tap gets. Each go-live runs through the one start path (`startBroadcast`) per fixture, so admission, credits, recording and the YouTube broadcast stay per match; a handover starts the new session, then stops the old one.

**Tech Stack:** Next.js (apps/web), TypeScript 7, postgres.js (`sql`, non-tenant for stream tables), zod 4 contracts generated to JSON Schema, vitest (node env, real Postgres), Playwright e2e.

**Spec:** `../seazn.club.capture/docs/specs/2026-11-14-court-stream-design.md` (owner rulings O1–O11 fixed; "(my call)" items approved with it). Also read: `docs/superpowers/specs/2026-10-01-capture-qr-v2-design.md` (the code, beat and start rules this extends) and `docs/superpowers/specs/2026-10-31-match-day-design.md` §8 (amended by Task 14).

## Global Constraints

- **Base:** branch from today's `origin/main` (b5f4d5ebb4 at revision, 2026-11-15). The main checkout's detached HEAD `96aae0f7e6` is far behind and has no Match Day code: never build on it. New branch `feat/court-stream` in a worktree (AGENTS.md). V522 (`youtube_live_status`) is on main and adds YouTube state to sessions: rebase before Task 2 and re-read `fixture_stream_sessions` as it stands.
- **Migration number:** `V525__court_stream_links.sql` (was drafted as V523; main took V523 and V524 first, so it was renumbered at the 2026-11-16 rebase). V521 (`drop_registrations_group_idx`), V522 (`youtube_live_status`), V523 (`org_revshare_ref`) and V524 (`email_outbox_billing_lifecycle`) are taken on main. The name must contain `stream` so the stream fold (`_stream-migration.ts`) reads it.
- Stream tables follow V430's RLS pattern: `enable` + `force` row level security, no policy, no grant, no `trg_set_org`; every read and write goes through the non-tenant `sql`, with the org as a WHERE from the code or link row.
- Contracts are generated, never hand-edited: change the zod twin and the prose in `scripts/gen-capture-contracts.ts`, run `node --experimental-strip-types scripts/gen-capture-contracts.ts`, and move each changed file's constant in `capture-contract.test.ts` in the same commit. File names keep their versions (additive optional fields, the W28 `stage` precedent): `capture-descriptor.v1`, `capture-beat.v1`, `capture-scoring-link.v1`, `capture-start.v1`, `capture-qr.v2`. The capture app re-pins its vendored copies to the merge commit.
- Per-fixture streaming is unchanged: a fixture code's descriptor, beat answer, start and scoring-link answer carry exactly today's keys plus the scoring link's new `label`, and no other byte moves on a per-fixture path.
- Court destinations are YouTube connections only (O9): `org_stream_targets.youtube_connection_id is not null`. A pasted key is refused at link time.
- A court code is minted only by the Match Day desk route (§5.1, my call); the match page never mints one.
- The court's day is the competition's zone, exactly as Match Day codes compute it (`competitionZone` + `dayBounds`, match-day-codes.ts): `opens_at` = 00:00, `expires_at` = 24:00 of `day`. The QR's `exp` = `Math.floor(expires_at / 1000)`.
- The tail is `AUTO_STOP_AFTER_RESULT_SECONDS` (180, config.ts), unchanged and still tunable.
- Money: one credit consumed per streamed match's first video (`consumeForSession`, unchanged W23 restart rules), none for an unstreamed match, none at switch-on.
- The stream code's tok and a scoring link's secret are never logged, never in an error message, never in a URL query.
- Every new user-facing string goes in all four `apps/web/src/dictionaries/{en,es,fr,nl}/ui.json` (keys registered in `lib/i18n-keys.ts`). `content/help/**` is English only.
- UI is verified at 1280, 768 and 320 with no horizontal page scroll.
- Tests: scoped only (never the full suite locally). Run from `apps/web`: `npx vitest run <paths> --reporter=json --outputFile=/tmp/cs-<task>.json` and read `numPassedTests`/`numTotalTests` and `.testResults[].name`. Each task's new guard is mutated once and a test must fail. Bring the DB up with the `seazn-local-env` skill.
- Owner standing rule (RULES.md): unit, e2e, smoke and regression coverage per change; smoke runs on the PR in CI.

## Review Focus

1. **Phone offline across a handover.** A phone that missed the go-live for B beats again still naming A's sid: it must be told about B (`go-live` B when B is armed, else `over` A then `go-live` B), never be re-offered A. Test owned by Task 8.
2. **Link withdrawn, or the day ends, while a match is live.** The live match keeps streaming to its end (C1b and the open-session deferral), no new match starts on that court, and after the session ends the code answers 401. Tests owned by Tasks 6 and 8.
3. **A match moved off a linked court, or onto one, mid-day.** The resolver follows `fixtures.court_id`: the moved match stops being this court's next, and a match moved onto a linked court with its switch on becomes it. Test owned by Task 5 (pure) and Task 6 (facts).
4. **A per-fixture code and the court switch racing on one match.** Under the fixture's code lock, exactly one of "mint a per-fixture code" and "turn Stream on" wins; the other is refused by name. Test owned by Task 4.
5. **The court's YouTube connection revoked after linking.** The next automatic start is refused `no_destination`, stored on the match, shown on the desk's court row; the beat still answers 200. Test owned by Task 8.

---

## File structure

| File | Responsibility |
|---|---|
| `db/migration/deltas/V525__court_stream_links.sql` | Court link table; code, settings, session and record columns |
| `apps/web/src/server/relay/domain/court-stream.ts` | Pure: `courtFocus`, `courtPhoneStatus`, `courtCodeView` |
| `apps/web/src/server/usecases/court-streams.ts` | Desk: link, list, withdraw, Stream switch; desk read for Match Day |
| `apps/web/src/server/usecases/court-stream-codes.ts` | Phone side: resolve a court code, read its facts, focus, label |
| `apps/web/src/server/usecases/capture-court.ts` | Court branches of descriptor, beat, start, scoring link |
| `apps/web/src/server/usecases/stream-auto-court.ts` | Court automatic start and handover |
| `apps/web/src/server/usecases/court-stream-sessions.ts` | `endOtherCourtSessions`: one active session per court link |
| `apps/web/src/app/api/v1/competitions/[id]/court-streams/route.ts` | POST link / GET list |
| `apps/web/src/app/api/v1/court-streams/[id]/withdraw/route.ts` | POST withdraw |
| `apps/web/src/app/api/v1/fixtures/[id]/court-stream/route.ts` | PUT Stream switch |
| `apps/web/src/components/v2/match-day/court-stream-sheet.tsx` | Desk: link a court, its QR, withdraw |
| `apps/web/src/components/v2/match-day/court-stream-switch.tsx` | Desk: per-match Stream switch |
| `apps/web/src/components/v2/match-day/court-phone-status.tsx` | Desk: Waiting / Live / Offline chip and refusal line |

Modified: `capture-schemas.ts`, `lib/capture-qr.ts`, `scripts/gen-capture-contracts.ts`, `docs/contracts/*`, `stream-codes.ts`, `secret-columns.ts`, `capture-phone.ts`, `capture-record.ts`, `admin-capture-records.ts`, `stream-sessions/start.ts`, `stream-sessions/auto-stop.ts`, `relay/domain/beat-answer.ts`, `match-day-codes.ts` (two exports), `match-day.ts`, `lib/match-day/types.ts`, `court-focus.tsx`, `stream-phone.ts`, `fixture-stream-panel.tsx`, `openapi.ts`, dictionaries, the Match Day design spec, the help page.

---

### Task 1: Contracts — the additive wire fields

Lands first: the phone plan consumes these names exactly.

**Files:**
- Modify: `apps/web/src/server/api-v1/capture-schemas.ts` (WaitingFields ~l.55, AnswerCommon ~l.168, CaptureScoringLinkOk l.194, CaptureRefusalCode l.295)
- Modify: `apps/web/src/lib/capture-qr.ts` (`captureQrV2Text`)
- Modify: `scripts/gen-capture-contracts.ts` (prose for every new prop; QR `exp` and `code` descriptions)
- Regenerate: `docs/contracts/capture-{descriptor,beat,scoring-link,start}.v1.json`, `docs/contracts/capture-qr.v2.json`; `openapi/v1.json` via `npm run openapi:gen`
- Create fixtures: `docs/contracts/fixtures/capture-descriptor.v1/valid-waiting-court.json`, `invalid-court-name-empty.json`, `invalid-court-extra-key.json`; `capture-beat.v1/answer-valid-waiting-next.json`, `answer-valid-live-next-unscheduled.json`, `answer-invalid-null-next.json`, `answer-invalid-next-extra-key.json`; `capture-scoring-link.v1/ok-valid-label.json`, `ok-invalid-label-empty.json`, `valid-no_match.json`; `capture-qr.v2/valid-court-exp.json` (if `valid-exp.json` does not already cover a 10-digit exp)
- Test: `apps/web/src/server/api-v1/__tests__/capture-contract.test.ts`, `apps/web/src/lib/__tests__/capture-qr.test.ts`

**Interfaces:**
- Produces (the phone plan must match these exactly):
  - `CaptureCourt = z.strictObject({ name: z.string().min(1).max(80) })`; `WaitingFields.court: CaptureCourt.optional()` — on the waiting shape and every session state; omitted, never null, on a fixture code.
  - `CaptureNext = z.strictObject({ label: z.string().min(1).max(200), scheduledStart: EpochS.nullable() })`; `AnswerCommon.next: CaptureNext.optional()` — on every beat answer branch; omitted, never null, when there is no next streamed match or the code is a fixture code.
  - `CaptureScoringLinkOk = z.strictObject({ url: …unchanged, label: z.string().min(1).max(200).optional() })` — this server always sends it.
  - `CaptureRefusalCode` gains `"no_match"` (court codes only: 409 from `…/scoring-link` and `…/start`).
  - `captureQrV2Text(p)` writes `exp` as a fifth key, after `tok`, when `p.exp !== undefined`; four keys otherwise.
  - `CAPTURE_COURT_NAME_MAX = 80` exported beside `CAPTURE_STAGE_LABEL_MAX`.

- [ ] **Step 1: Write the failing tests**

In `capture-contract.test.ts`, extend the per-state field matrices so `court` is admitted on all six descriptor states and `next` on all six answer states, and add each new fixture to its directory's valid/invalid list. Add:

```ts
it("a fixture code's descriptor and beat answer stay byte-identical (no court, no next)", () => {
  // valid-waiting.json and answer-valid-waiting.json parse through the NEW twins and re-serialise to their own bytes
});
it("no_match is a refusal word every refusal-bearing contract admits", () => {
  for (const file of ["capture-descriptor.v1.json", "capture-start.v1.json", "capture-scoring-link.v1.json"]) {
    expect(refusalCodesOf(file)).toContain("no_match");
  }
});
```

In `capture-qr.test.ts`:

```ts
it("writes exp fifth when the payload carries one (a court code)", () => {
  expect(captureQrV2Text({ v: 2, code: "0123456789ab", slot: 0, tok: "A".repeat(22), exp: 1794700800 }))
    .toBe('{"v":2,"code":"0123456789ab","slot":0,"tok":"AAAAAAAAAAAAAAAAAAAAAA","exp":1794700800}');
});
it("still writes exactly four keys without exp (T11's regression)", () => { /* existing bytes */ });
```

- [ ] **Step 2: Run to verify they fail**

Run: `cd apps/web && npx vitest run src/server/api-v1/__tests__/capture-contract.test.ts src/lib/__tests__/capture-qr.test.ts --reporter=json --outputFile=/tmp/cs-1.json`
Expected: FAIL on the new fixtures, the `no_match` test and the exp test.

- [ ] **Step 3: Implement the twins, the prose and the QR text**

Prose (in the generator, copied into the JSON): `court` — "Court codes only (court stream spec 2026-11-14 §6.1): the court this code streams, its display name. Omitted, never null, on a fixture's code."; `next` — "Court codes only (§5.3): the court's next streamed match not yet started, so the phone can show \"Next: …\" while waiting or during a live tail. Omitted, never null, when there is none or on a fixture's code."; scoring-link `label` — "The match the link scores, \"{side A} v {side B}\" or \"Match {n}\" (§5.6). On a court code it is the court's next called match not yet started, streamed or not (O10), so it may differ from the beat's `label` and `next`; the phone shows it on the panel. A phone drops an answer when its held sid, waiting label or `next` changed between the request and the answer."; `no_match` in the refusal descriptions of start ("409 no_match: a court code with no streamed match in play") and scoring-link ("409 no_match: a court code with no match queued on the court"); QR `code` — "A fixture's or a court's stable stream code…"; QR `exp` — "…This server sends it only on a court code: the end of the court's day (§5.1, O4). A fixture's code never carries it."

- [ ] **Step 4: Regenerate, move the SHA constants, regenerate OpenAPI**

Run: `node --experimental-strip-types scripts/gen-capture-contracts.ts && npm run openapi:gen`, then copy the five new sha256 values into `SHA256` in `capture-contract.test.ts`.

- [ ] **Step 5: Run to verify they pass**

Run the Step 2 command plus `src/server/usecases/__tests__/capture-get.test.ts src/server/usecases/__tests__/capture-beat.test.ts src/server/usecases/__tests__/capture-scoring-link.test.ts`.
Expected: PASS; the three use-case suites unchanged (no server sends the new fields yet). `git diff --exit-code openapi/` after a second `openapi:gen`.

- [ ] **Step 6: Commit**

```bash
git add apps/web/src/server/api-v1/capture-schemas.ts apps/web/src/lib/capture-qr.ts scripts/gen-capture-contracts.ts docs/contracts openapi apps/web/src/server/api-v1/__tests__/capture-contract.test.ts apps/web/src/lib/__tests__/capture-qr.test.ts
git commit -m "feat(capture): court stream contract fields (court, next, label, no_match, court exp)"
```

---

### Task 2: Migration V525 — court links and the columns that hang off them

**Files:**
- Create: `db/migration/deltas/V525__court_stream_links.sql`
- Modify: `apps/web/src/server/relay/__tests__/rls-static.test.ts` (court table by name), `apps/web/src/server/relay/__tests__/migration-shape.test.ts`
- Test: those two, plus `apps/web/src/server/relay/__tests__/court-stream-migration.test.ts` (new, DB)

**Interfaces:**
- Produces (SQL):
  - `court_stream_links (id uuid pk, org_id uuid not null → organizations cascade, competition_id uuid not null → competitions cascade, court_id uuid not null, day date not null, tz text not null, opens_at timestamptz not null, expires_at timestamptz not null, target_id uuid not null → org_stream_targets, created_by uuid not null, created_at timestamptz default now(), withdrawn_at timestamptz null, withdrawn_by uuid null, check (opens_at < expires_at), check ((withdrawn_at is null) = (withdrawn_by is null)), foreign key (court_id, org_id) → courts (id, org_id) on delete cascade)`; `create unique index court_stream_links_one_live on court_stream_links (court_id, day) where withdrawn_at is null`; `(org_id, created_at)` and `(competition_id, day)` indexes; RLS enable + force.
  - `fixture_stream_codes`: `fixture_id` drop not null; `court_link_id uuid null references court_stream_links(id) on delete cascade`; `check ((fixture_id is null) <> (court_link_id is null))` named `fixture_stream_codes_one_owner`; `create unique index fixture_stream_codes_one_active_court on fixture_stream_codes (court_link_id) where ended_at is null`; `end_cause` check re-added (same default name `fixture_stream_codes_end_cause_check`) admitting `'reissued','expired','withdrawn'`.
  - `fixture_stream_settings.court_stream boolean not null default false`; partial index `(fixture_id) where court_stream`.
  - `fixture_stream_sessions.court_link_id uuid null references court_stream_links(id) on delete set null` + index `(court_link_id)`.
  - `capture_records.fixture_id` drop not null; `check (fixture_id is not null or code_id is not null)` is already implied by `code_id not null` — add nothing else.

- [ ] **Step 1: Write the failing tests**

`court-stream-migration.test.ts` (DB):

```ts
it("a code row names exactly one owner", async () => { /* insert with both null → 23514; both set → 23514 */ });
it("one live link per court and day; a withdrawn one frees the slot", async () => { /* second insert 23505; withdraw; third insert ok */ });
it("one active code per court link", async () => { /* second active court code 23505 */ });
it("end_cause admits withdrawn", async () => { /* update … end_cause='withdrawn' succeeds */ });
it("court_stream defaults false on an existing settings row", async () => {});
```

`rls-static.test.ts`: add `"court_stream_links"` to a `V525_TABLES` list asserted enabled AND forced, and no policy/grant across the fold.

- [ ] **Step 2: Run to verify they fail**

Run: `cd apps/web && npx vitest run src/server/relay/__tests__/court-stream-migration.test.ts src/server/relay/__tests__/rls-static.test.ts src/server/relay/__tests__/migration-shape.test.ts --reporter=json --outputFile=/tmp/cs-2.json`
Expected: FAIL (table missing).

- [ ] **Step 3: Write `V525__court_stream_links.sql`**

Header comment names the spec, the V430 RLS pattern and why codes reuse `fixture_stream_codes` (pairings, sessions, beats and records keep their foreign keys). Confirm the `end_cause` check's default name with `\d fixture_stream_codes` on a fresh DB before dropping it, and say so in the comment (V430's own practice).

- [ ] **Step 4: Apply and run**

Apply to the local test DB per `seazn-local-env` (fresh schema: `db:apply` then `sync:sports`). Run the Step 2 command. Expected: PASS.

- [ ] **Step 5: Mutate once**

Drop the `fixture_stream_codes_one_owner` check from the file, re-apply: the owner test must fail. Restore.

- [ ] **Step 6: Commit**

```bash
git add db/migration/deltas/V525__court_stream_links.sql apps/web/src/server/relay/__tests__
git commit -m "feat(db): court stream links (V525)"
```

---

### Task 3: Court link on the desk — link, list, withdraw

**Files:**
- Create: `apps/web/src/server/usecases/court-streams.ts`
- Modify: `apps/web/src/server/usecases/match-day-codes.ts` (add `export` to `competitionZone` and `dayBounds`; no other change)
- Modify: `apps/web/src/server/relay/secret-columns.ts` (`insertCourtStreamCode`; widen `wipeStreamCodeTok`'s cause to `"reissued" | "expired" | "withdrawn"`)
- Modify: `apps/web/src/server/api-v1/schemas` (wire shapes), `apps/web/src/server/api-v1/openapi.ts`
- Create: `apps/web/src/app/api/v1/competitions/[id]/court-streams/route.ts`, `apps/web/src/app/api/v1/court-streams/[id]/withdraw/route.ts`
- Test: `apps/web/src/server/usecases/__tests__/court-streams.test.ts`, `apps/web/src/app/api/v1/competitions/[id]/court-streams/__tests__/route.test.ts`

**Interfaces:**
- Consumes: `competitionZone(auth, competitionId): Promise<string>`, `dayBounds(day, tz): { opensAt; expiresAt }` (match-day-codes.ts); `drawCode`, `freshTok`, `sha256Hex` from stream-codes.ts (export them if private — a move of visibility only); `openStreamCodeTok`.
- Produces:
  - `insertCourtStreamCode(tx, a: { orgId: string; courtLinkId: string; code: string; tokHash: string; tokEnc: Buffer; issuedBy: string }): Promise<{ id: string; createdAt: Date }>` (secret-columns.ts, the only file naming `tok_enc`).
  - `type CourtStreamShown = { id: string; courtId: string; courtName: string; day: string; expiresAt: Date; target: { id: string; label: string }; qr: CaptureQrV2 | null }` (`qr` null only when the sealed tok will not reopen).
  - `linkCourtStream(auth: AuthCtx, competitionId: string, input: { courtId: string; targetId: string; day?: string }, now?: Date): Promise<CourtStreamShown>`
  - `listCourtStreams(auth: AuthCtx, competitionId: string, now?: Date): Promise<CourtStreamShown[]>` — live links (not withdrawn, `expires_at > now`) whose court is one of the competition's candidate courts or carries one of its fixtures today, ordered by court sort.
  - `withdrawCourtStream(auth: AuthCtx, linkId: string): Promise<void>`
  - Wire (snake_case, v1 envelope): `POST /api/v1/competitions/{id}/court-streams` body `{ court_id, target_id, day? }` → 201 `{ id, court_id, court_name, day, expires_at, target: {id, label}, qr }`; `GET` same path → 200 list; `POST /api/v1/court-streams/{id}/withdraw` → 204.
  - Refusals: 403 not an editor session (`requireSessionEditor`); 402 without `streaming.relay`; 404 court, target or competition not the org's; 422 `court_destination_not_youtube` (a pasted target); 422 day already over; 409 `court_already_streaming` (a live link for that court and day names another target); 503 `RELAY_KEK_MISSING`; 503 `court_streaming_unconfigured` while `COURT_MIN_APP_VERSION` is unset or malformed (O13, see Task 7), nothing written.

- [ ] **Step 1: Write the failing tests** (DB, `seedDay()` from `_match-day-seed.ts`, an API target from `rigApiTarget`, a pasted one from `rigTarget`)

```ts
it("links Court 2 for today on a YouTube connection and shows a QR whose exp is the end of the day", async () => {
  const shown = await linkCourtStream(day.auth, day.comp.id, { courtId: day.courts.c2, targetId: api.targetId }, at(0));
  expect(shown.courtName).toBe("Court 2");
  expect(shown.qr).toMatchObject({ v: 2, slot: 0, exp: Math.floor(Date.parse("2026-11-07T23:00:00Z") / 1000) }); // 24:00 Europe/Amsterdam
  expect(await codeRowOf(shown.qr!.code)).toMatchObject({ fixture_id: null, court_link_id: shown.id, ended_at: null });
});
it("refuses a pasted-key destination: 422 court_destination_not_youtube, nothing written", async () => {});
it("with COURT_MIN_APP_VERSION unset: 503 court_streaming_unconfigured, no link and no code written (O13)", async () => {});
it("a second link call for the same court, day and target re-shows the same QR (no second code)", async () => {});
it("a second link call naming another target is 409 court_already_streaming", async () => {});
it("an API key or a device link cannot link (403); an org without streaming.relay is 402", async () => {});
it("withdraw ends the code 'withdrawn', wipes its tok, and frees the court for a new link", async () => {});
it("withdraw of another org's link is 404", async () => {});
it("the tok never appears in a log line or an error message", async () => { /* spy on log; assert no call arg contains tok */ });
```

Route test: 201 shape, 204 withdraw, `Cache-Control: private, no-store` on POST and GET (the tok is live).

- [ ] **Step 2: Run to verify they fail**

Run: `cd apps/web && npx vitest run src/server/usecases/__tests__/court-streams.test.ts "src/app/api/v1/competitions/[id]/court-streams" --reporter=json --outputFile=/tmp/cs-3.json`
Expected: FAIL (module missing).

- [ ] **Step 3: Implement**

`linkCourtStream`: `requireSessionEditor`; competition is the org's (`competitionZone` 404s otherwise); `requireFeature(orgId, "streaming.relay", competitionId)`; court is the org's and not archived; target is the org's, not archived, and `youtube_connection_id is not null`; `day ?? dayKeyInTz(now, tz)`, `dayBounds`; seal BEFORE any write (`hasValidKek("RELAY_KEK")`); one transaction under `pg_advisory_xact_lock(hashtext('court_stream:' || court_id || ':' || day))`: existing live link → same target re-shows (reopen + verify hash, as `ensureStreamCode` does) else 409; none → insert link, then `insertCourtStreamCode` with the code-collision redraw (`mintLocked`'s loop, savepoint per attempt). QR: `{ v: 2, code, slot: SLOT, tok, exp: Math.floor(expiresAt.getTime() / 1000) }`.

`withdrawCourtStream`: link must be the org's (via its competition's write auth in the route); in one transaction set `withdrawn_at/withdrawn_by` and `wipeStreamCodeTok(tx, codeId, "withdrawn", auth.userId)`. A live session keeps streaming (C1b, Task 6). Idempotent: a second withdraw is 204 with nothing written.

Route auth: `requireResourceAuth(req, "competition", id, "write")` for the competition routes; for withdraw, read the link's `competition_id` first and authorise on it.

- [ ] **Step 4: Run to verify they pass** — Step 2's command. Expected: PASS, counts pasted in the commit message body.

- [ ] **Step 5: Mutate once** — remove the `youtube_connection_id is not null` condition: the pasted-key test must fail. Restore.

- [ ] **Step 6: Commit**

```bash
git add apps/web/src/server/usecases/court-streams.ts apps/web/src/server/usecases/match-day-codes.ts apps/web/src/server/relay/secret-columns.ts apps/web/src/server/usecases/stream-codes.ts apps/web/src/server/api-v1 apps/web/src/app/api/v1/competitions apps/web/src/app/api/v1/court-streams apps/web/src/server/usecases/__tests__/court-streams.test.ts openapi
git commit -m "feat(stream): link a court to a YouTube channel for a day (desk)"
```

---

### Task 4: The per-match Stream switch and the own-code refusal

**Files:**
- Modify: `apps/web/src/server/usecases/court-streams.ts` (`setCourtStream`, `liveCourtLinkFor`)
- Modify: `apps/web/src/server/usecases/stream-codes.ts` (`ensureStreamCode`, `reissueStreamCode` refuse a court-streamed match)
- Create: `apps/web/src/app/api/v1/fixtures/[id]/court-stream/route.ts`; modify `openapi.ts`
- Test: `apps/web/src/server/usecases/__tests__/court-stream-switch.test.ts`; extend `stream-codes.test.ts`

**Interfaces:**
- Consumes: `lockFixtureCode(tx, fixtureId)` (stream-codes.ts — export it), `activeCodeOf`.
- Produces:
  - `liveCourtLinkFor(exec: Tx | typeof sql, a: { orgId: string; courtId: string | null; now: Date }): Promise<{ id: string; courtName: string } | null>` — the court's link that is not withdrawn and has `opens_at <= now < expires_at`.
  - `setCourtStream(auth: AuthCtx, fixtureId: string, on: boolean, now?: Date): Promise<{ on: boolean }>` — upsert into `fixture_stream_settings` like `writeAutoStream` (never touching `target_id`/`target_chosen`), bumping `revision`.
  - `PUT /api/v1/fixtures/{id}/court-stream` body `{ on: boolean }` → 200 `{ on }`.
  - Refusals: 409 `has_own_stream_code` (turning on while the fixture has an ACTIVE `fixture_stream_codes` row); 409 `court_not_streaming` (turning on while the fixture's court has no live link now); turning off is never refused. `ensureStreamCode`/`reissueStreamCode`: 409 `court_streamed` while `court_stream` is on and `liveCourtLinkFor` finds a link.

- [ ] **Step 1: Write the failing tests**

```ts
it("is off by default and spends nothing when turned on", async () => { /* no org_stream_credits row */ });
it("turning on a match that has its own stream code is 409 has_own_stream_code, nothing written", async () => {});
it("turning on a match whose court is not streaming is 409 court_not_streaming", async () => {});
it("turning off always succeeds, also on an unlinked court", async () => {});
it("ensureStreamCode on a court-streamed match is 409 court_streamed; turning the switch off lets it mint", async () => {});
it("racing a mint and a switch-on: exactly one wins, the other is refused by name", async () => {
  const [a, b] = await Promise.allSettled([ensureStreamCode(day.auth, fx), setCourtStream(day.auth, fx, true)]);
  // exactly one fulfilled; the rejected one's code is court_streamed or has_own_stream_code
});
it("an API key cannot set it (403)", async () => {});
```

- [ ] **Step 2: Run to verify they fail**

Run: `cd apps/web && npx vitest run src/server/usecases/__tests__/court-stream-switch.test.ts src/server/usecases/__tests__/stream-codes.test.ts --reporter=json --outputFile=/tmp/cs-4.json`
Expected: FAIL on the new tests only.

- [ ] **Step 3: Implement** — the resolver (Task 6 `courtFactsOf`) and the start guard (Task 7) also skip a fixture with an ACTIVE own code, so a row written before this guard existed cannot stream twice. `setCourtStream` takes `lockFixtureCode(tx, fixtureId)` first (the lock `ensureStreamCode` takes), then reads the active code and the live link; the ensure/reissue check runs inside their existing lock, after `finishedAtOf`.

- [ ] **Step 4: Run to verify they pass** — Step 2's command, all of `stream-codes.test.ts` green.

- [ ] **Step 5: Mutate once** — drop the lock in `setCourtStream`: the race test must fail (run it 5 times). Restore.

- [ ] **Step 6: Commit** — `git commit -m "feat(stream): per-match Stream switch for a linked court"`

---

### Task 5: The court resolver (pure)

**Files:**
- Create: `apps/web/src/server/relay/domain/court-stream.ts`
- Test: `apps/web/src/server/relay/domain/__tests__/court-stream.test.ts`

**Interfaces:**
- Consumes: `isNotResponding` (relay/domain/pairing.ts, exported) — reused, never copied; `CodeView` (stream-code.ts).
- Produces:

```ts
export type CourtMatchFacts = {
  fixtureId: string;
  status: string;                 // fixtures.status
  streamed: boolean;              // fixture_stream_settings.court_stream
  latched: boolean;               // auto_start_blocked_at is not null (organiser Stop, or this court phone's Stop)
  kickoffAt: Date | null;         // last active core.start (kickoffsOf); in_play only
  calledAt: Date | null;          // set only while the call still holds (liveCallSql)
  scheduledAt: Date | null;
  roundNo: number | null;         // fixtures.round_no
  seqInRound: number | null;      // fixtures.seq_in_round
  openSession: { sid: string; createdAt: Date } | null;  // this link's newest ACTIVE session for the fixture
};
export type CourtFocus = {
  current: { fixtureId: string; sid: string } | null;  // newest-created open court session, any fixture
  start: string | null;           // the fixture to start now (nothing open, or a handover), or null
  handover: boolean;              // start !== null && current !== null
  focusFixtureId: string | null;  // the waiting/live fields' subject: start ?? current ?? next
  nextFixtureId: string | null;   // first streamed, unlatched, status "scheduled" match in queue order
  scoringFixtureId: string | null;// first status "scheduled" match in queue order, streamed or not (O10)
};
export function courtFocus(matches: readonly CourtMatchFacts[]): CourtFocus;

export type CourtPhoneStatus = "unpaired" | "waiting" | "live" | "offline";
export function courtPhoneStatus(i: { pairing: { lastBeatAt: Date; answeredPoll: number } | null; openState: SessionState | null }, now: Date): CourtPhoneStatus;

/** The court code's CodeView for `codeStatus` (grace 0): `finishedAt` is the day's end once it has passed, else null. */
export function courtCodeView(v: { endedAt: Date | null; expiresAt: Date }, now: Date): CodeView;
```

Rules (spec §5.3, §5.4), each a named row in a table like `AUTO_START_CONJUNCTS`:
- **candidate** = the streamed, unlatched, `in_play` match with the newest `kickoffAt` (a null kickoff sorts oldest; a tie → the greater `fixtureId`).
- **start** = candidate when `current` is null; when `current` is another fixture whose status is not `in_play`, or whose kickoff is older than the candidate's; else null. A candidate with its own `openSession` is never `start`.
- **Queue order** — Match Day's own (match-day.ts:147 and the court queue): a held call first (by `calledAt`), then `scheduledAt` ascending nulls last, then `roundNo`, then `seqInRound`, then `fixtureId`.
- **courtPhoneStatus**: no pairing → `unpaired`; `isNotResponding({ held: true, lastBeatAt, answeredPoll }, now)` → `offline` (NOT_RESPONDING_BEATS = 3 answered cadences); open state `live` → `live`; else `waiting`.

- [ ] **Step 1: Write the failing tests** — a builder and a fixed clock, every expected value written out:

```ts
const T = (hhmm: string) => new Date(`2026-11-15T${hhmm}:00Z`);
const m = (id: string, o: Partial<CourtMatchFacts> = {}): CourtMatchFacts => ({
  fixtureId: id, status: "scheduled", streamed: true, latched: false, kickoffAt: null, calledAt: null,
  scheduledAt: null, roundNo: 1, seqInRound: 1, openSession: null, ...o,
});
const open = (sid: string, at: string) => ({ sid, createdAt: T(at) });

it("nothing streamed: no focus, no next; scoring is the first unstarted match", () => {
  const f = courtFocus([m("a", { streamed: false, scheduledAt: T("14:00") }), m("b", { streamed: false, scheduledAt: T("13:00") })]);
  expect(f).toEqual({ current: null, start: null, handover: false, focusFixtureId: null, nextFixtureId: null, scoringFixtureId: "b" });
});
it("one streamed match in play, nothing open: start it", () => {
  expect(courtFocus([m("a", { status: "in_play", kickoffAt: T("10:00") })]))
    .toMatchObject({ current: null, start: "a", handover: false, focusFixtureId: "a" });
});
it("A in its tail (decided, open), B kicks off: handover to B (O6)", () => {
  const f = courtFocus([m("a", { status: "decided", kickoffAt: null, openSession: open("sa", "10:00") }),
                        m("b", { status: "in_play", kickoffAt: T("10:40") })]);
  expect(f).toMatchObject({ current: { fixtureId: "a", sid: "sa" }, start: "b", handover: true, focusFixtureId: "b" });
});
it("A in play 10:00 with its session, B in play 10:01: B starts, handover", () => {
  const f = courtFocus([m("a", { status: "in_play", kickoffAt: T("10:00"), openSession: open("sa", "10:00") }),
                        m("b", { status: "in_play", kickoffAt: T("10:01") })]);
  expect(f).toMatchObject({ start: "b", handover: true });
});
it("A in play and newer than B, A open: no handover, focus A", () => {
  const f = courtFocus([m("a", { status: "in_play", kickoffAt: T("10:05"), openSession: open("sa", "10:05") }),
                        m("b", { status: "in_play", kickoffAt: T("10:01") })]);
  expect(f).toMatchObject({ current: { fixtureId: "a" }, start: null, handover: false, focusFixtureId: "a" });
});
it("equal kickoffs: the greater fixture id wins (and the lesser does not)", () => {
  expect(courtFocus([m("a", { status: "in_play", kickoffAt: T("10:00") }), m("b", { status: "in_play", kickoffAt: T("10:00") })]).start).toBe("b");
});
it("a latched match is never start, even newest; a latched match's open session (desk restart) is still current", () => {
  const f = courtFocus([m("a", { status: "in_play", kickoffAt: T("10:05"), latched: true, openSession: open("sa", "10:06") }),
                        m("b", { status: "in_play", kickoffAt: T("10:00") })]);
  expect(f).toMatchObject({ current: { fixtureId: "a", sid: "sa" }, start: null });
});
it("an unstreamed match in play is never start", () => {
  expect(courtFocus([m("a", { status: "in_play", kickoffAt: T("10:00"), streamed: false })]).start).toBeNull();
});
it("next skips latched and unstreamed matches; scoring skips neither unstreamed", () => {
  const f = courtFocus([m("c", { streamed: false, scheduledAt: T("11:00") }), m("d", { latched: true, scheduledAt: T("11:30") }),
                        m("e", { scheduledAt: T("12:00") })]);
  expect(f).toMatchObject({ nextFixtureId: "e", scoringFixtureId: "c", focusFixtureId: "e" });
});
it("a held call outranks an earlier planned match in next and scoring", () => {
  const f = courtFocus([m("p", { scheduledAt: T("11:00") }), m("q", { scheduledAt: T("12:00"), calledAt: T("10:30") })]);
  expect(f).toMatchObject({ nextFixtureId: "q", scoringFixtureId: "q" });
});
it("equal planned times fall back to round, then seq, then id", () => {
  const f = courtFocus([m("z", { scheduledAt: T("11:00"), roundNo: 2, seqInRound: 1 }), m("y", { scheduledAt: T("11:00"), roundNo: 1, seqInRound: 2 }),
                        m("x", { scheduledAt: T("11:00"), roundNo: 1, seqInRound: 3 })]);
  expect(f.nextFixtureId).toBe("y");
});
it("a match moved off the court is absent from the facts, so from every answer", () => {
  expect(courtFocus([]).scoringFixtureId).toBeNull();                       // Review Focus 3
});
it("courtPhoneStatus: at a 5 s cadence, 14.9 s silent is waiting, 15 s offline", () => {
  const p = { lastBeatAt: T("10:00"), answeredPoll: 5 };
  expect(courtPhoneStatus({ pairing: p, openState: null }, new Date(T("10:00").getTime() + 14_900))).toBe("waiting");
  expect(courtPhoneStatus({ pairing: p, openState: null }, new Date(T("10:00").getTime() + 15_000))).toBe("offline");
  expect(courtPhoneStatus({ pairing: p, openState: "live" }, T("10:00"))).toBe("live");
  expect(courtPhoneStatus({ pairing: null, openState: null }, T("10:00"))).toBe("unpaired");
});
it("courtCodeView: before the day's end finishedAt is null; at it, the end", () => {
  const end = T("23:00");
  expect(courtCodeView({ endedAt: null, expiresAt: end }, T("22:59"))).toEqual({ endedAt: null, finishedAt: null });
  expect(courtCodeView({ endedAt: null, expiresAt: end }, end)).toEqual({ endedAt: null, finishedAt: end });
});
```

(The `courtPhoneStatus` cadence numbers assume `isNotResponding`'s threshold is `3 × answeredPoll` seconds; read `cadenceMs` in pairing.ts first and write the boundary it gives, from the constant, not from this function.)

- [ ] **Step 2: Run to verify they fail** — `cd apps/web && npx vitest run src/server/relay/domain/__tests__/court-stream.test.ts --reporter=json --outputFile=/tmp/cs-5.json`. Expected: FAIL (module missing).

- [ ] **Step 3: Implement** — no I/O, no `Date.now()`. Sort with one comparator `queueOrder(a, b)` exported for Task 6's SQL parity test.

- [ ] **Step 4: Run to verify they pass.**

- [ ] **Step 5: Mutate once** — make the tie go to the lesser id: the equal-kickoffs test must fail. Restore.

- [ ] **Step 6: Commit** — `git commit -m "feat(stream): court resolver (current, start, next, scoring)"`

---

### Task 6: Resolving a court code and reading its facts

**Files:**
- Create: `apps/web/src/server/usecases/court-stream-codes.ts`
- Modify: `apps/web/src/server/usecases/stream-codes.ts` (add `kind: "fixture"` to `ResolvedCode`; `resolveAnyStreamCode`)
- Modify: `apps/web/src/server/relay/domain/stream-code.ts` only if `recordTailAnchor`'s input type must widen to admit `endCause: "withdrawn"`
- Test: `apps/web/src/server/usecases/__tests__/court-stream-codes.test.ts`

**Interfaces:**
- Consumes: `courtFocus`, `courtCodeView` (Task 5); `codeStatus`, `codeServes`, `recordTailAnchor`; `kickoffsOf` (engine-db/kickoff.ts); `liveCallSql`/`LIVE_CALL_ALIASES` (match-day-call.ts); `MOVABLE_STATUS`, `IN_PLAY`.
- Produces:
  - `ResolvedCode` gains `kind: "fixture"` (every construction site adds it).
  - `type CourtLinkRef = { id: string; competitionId: string; courtId: string; courtName: string; opensAt: Date; expiresAt: Date; targetId: string; withdrawnAt: Date | null }`
  - `type ResolvedCourtCode = { kind: "court"; codeId: string; orgId: string; status: "active" | "finishing" | "ended"; issuedBy: string; link: CourtLinkRef }`
  - `resolveAnyStreamCode(rawCode: string, tok: string, call: CodeCall, phone: string | null, now: Date): Promise<ResolvedCode | ResolvedCourtCode>` — one row read for both kinds (`left join fixtures`, `left join court_stream_links`), the same constant-time tok compare, the same C1/C1b/C2 rules. For a court code the "open session" is the newest ACTIVE session with `court_link_id = link.id`; C2's expiry uses `courtCodeView` with grace 0 and writes `end_cause = 'expired'`. The `record` tail (C1(c)) for a court code: `endCause` may be `withdrawn` (treated as `reissued` is: anchored on the code's own end), and the sessions it reads are those with `court_link_id = link.id`, not a fixture's. `resolveStreamCode` is unchanged and still refuses a court code (its inner join finds no fixture → 401).
  - `courtFactsOf(exec: Tx | typeof sql, link: CourtLinkRef): Promise<CourtMatchFacts[]>` — the org's fixtures with `court_id = link.courtId` and any of: `scheduled_at` in `[opensAt, expiresAt)`; `status = 'in_play'`; a call that still holds (`liveCallSql`); an ACTIVE session with `court_link_id = link.id` (match-day.ts:439-446's admission rule plus the open session). A fixture with an ACTIVE own `fixture_stream_codes` row is read with `streamed: false` whatever its switch says (Task 4's guard, enforced again here). `kickoffsOf` for the `in_play` ones; `round_no`, `seq_in_round` for the queue order.
  - `courtFocusOf(link: CourtLinkRef): Promise<{ facts: CourtMatchFacts[]; focus: CourtFocus }>`
  - `asFixtureCode(court: ResolvedCourtCode, fixtureId: string): ResolvedCode` — the same code, pointed at one match, for the per-fixture internals.
  - `matchLabelOf(orgId: string, fixtureId: string): Promise<string>` — `captureCommon`'s label rule, moved here verbatim and called by both (`fitText` to `LABEL_MAX`).

- [ ] **Step 1: Write the failing tests** (DB; `seedDay`, `place`, `setStatus`, Task 3's link on Court 2)

```ts
it("a court code resolves as kind court with its link; a fixture code as kind fixture with today's fields", async () => {});
it("a wrong tok on a court code is the same 401 code_ended as an unknown code", async () => {});
it("withdrawn, no open session: 401 for get, beat, claim and start", async () => {});            // Review Focus 2
it("withdrawn while a court session is open: its phone's get and beat are served; claim and start are 401", async () => {});
it("past the day's end with no open session: written expired, then 401", async () => {});
it("past the day's end with an open session: finishing, served", async () => {});
it("a record after withdrawal: served within 24 h of the code's end, anchored on court sessions", async () => {});
it("courtFactsOf admits a match in play whose planned time was yesterday, and a called match", async () => {
  await place(day, fx[0].id, -24 * 60, day.courts.c2); await setStatus(fx[0].id, "in_play");
  expect((await courtFactsOf(sql, link)).map((f) => f.fixtureId)).toContain(fx[0].id);
});
it("courtFactsOf: a match moved onto the court appears, one moved off disappears, another org's never does", async () => {}); // Review Focus 3
it("courtFactsOf: a match planned on the court tomorrow is not in today's facts", async () => {});
it("courtFactsOf reads a match with its own active stream code as not streamed", async () => {});
it("SQL queue order equals queueOrder() on a seeded court of 6 matches (ties on time, round and seq)", async () => {});
it("resolveStreamCode still refuses a court code (401)", async () => {});
```

- [ ] **Step 2: Run to verify they fail** — `cd apps/web && npx vitest run src/server/usecases/__tests__/court-stream-codes.test.ts src/server/usecases/__tests__/stream-codes.test.ts --reporter=json --outputFile=/tmp/cs-6.json`.

- [ ] **Step 3: Implement.** `EXPLAIN` the facts query on a seeded day; it must use `fixtures_court_idx` (V367). Paste the plan line in the commit body. No new index unless it seq-scans `fixtures`.

- [ ] **Step 4: Run to verify they pass**, plus `capture-get.test.ts capture-beat.test.ts capture-start.test.ts capture-record.test.ts` (`kind` is the only change there).

- [ ] **Step 5: Mutate once** — drop the `status = 'in_play'` arm: the yesterday's-match test must fail.

- [ ] **Step 6: Commit** — `git commit -m "feat(stream): resolve a court code and read its court's matches"`

---

### Task 7: The phone's calls on a court code — descriptor, beat, start, record

**Files:**
- Create: `apps/web/src/server/usecases/capture-court.ts`, `apps/web/src/server/usecases/court-stream-sessions.ts`
- Modify: `apps/web/src/server/usecases/stream-sessions/start.ts` (the pairing guard at ~l.186-196 and `opts.courtLinkId`; the insert writes `court_link_id`)
- Modify: `apps/web/src/server/usecases/capture-phone.ts` (`getCode`, `postBeat`, `postStart` switch to `resolveAnyStreamCode` and delegate the court branch; `waitingFieldsOf` takes `court`; `BeatAnswerCommon` carries `next`)
- Modify: `apps/web/src/server/relay/domain/beat-answer.ts` (`BeatAnswerCommon.next`; `wireBeatAnswer` picks it, omitted when null)
- Modify: `apps/web/src/server/usecases/capture-record.ts`, `apps/web/src/server/usecases/admin-capture-records.ts` (`fixtureId: string | null`)
- Test: `apps/web/src/server/usecases/__tests__/capture-court.test.ts`; extend `stream-sessions.test.ts` (guard) and the beat-answer domain tests

**Interfaces:**
- Consumes: Task 6's `resolveAnyStreamCode`, `courtFocusOf`, `asFixtureCode`, `matchLabelOf`; `markAutoStartBlocked`; `captureStageOf`.
- Produces:
  - **`startBroadcast` guard.** `opts.courtLinkId?: string`. Without it the pairing's code must be the fixture's own (today's query, unchanged). With it, in one read: the pairing's code has `court_link_id = courtLinkId`; the link is not withdrawn; the link's `court_id` is the fixture's `court_id`; the fixture's `court_stream` is on; and `opts.targetId === link.target_id` (O9: a court session streams to its link's YouTube channel, never another target). Any failure: `throw new Error("startBroadcast: … is not on fixture …'s court link")` before anything is weighed or written. The session row stores `court_link_id`.
  - `endOtherCourtSessions(a: { linkId: string; keepSid: string; actorUserId: string }, deps: SessionDeps): Promise<string[]>` (court-stream-sessions.ts) — every ACTIVE session with `court_link_id = linkId` and `id <> keepSid` gets `apply(sid, (s) => isActive(s.state) ? { type: "stop", reason: "auto_stopped" } : null, deps, { userId: actorUserId, source: "phone" })` and a `court_handover` event `{ to: keepSid }`; returns the ended sids. Called after EVERY successful court start (Task 7's operator start, Task 8's automatic start, Task 9's desk restart).
  - `courtCommon(court: ResolvedCourtCode, focus: CourtFocus, open: SessionState | null, deps, now): Promise<CaptureCommon & { court: { name: string }; next: { label: string; scheduledStart: number | null } | null }>` — with a focus fixture, `captureCommon` for it with `autoAllowed: true` and `destinationName` = the LINK's target label; with none, `label` = the court's name, no `scheduledStart`, `autoAllowed: true`, `overlayUrl: null`, poll cadence `POLL_FAR_SECONDS`. `next` = `focus.nextFixtureId`'s label and scheduled start.
  - **`getCourtCode(court, q, deps, now): Promise<Descriptor>`** — the shape follows the court's CURRENT session only: `focus.current` (the newest ACTIVE court session, any fixture). Session shape for that session when it is `warming`, `live` or `ending` (with `cred` only to its pairing's phone, as today), its fixture's waiting fields and its fixture's `stage`. Otherwise — no active court session, including right after A's session completed or failed — the WAITING shape on `focus.focusFixtureId` (start ?? next), with that fixture's `stage`, or the idle court shape (no `stage`) when there is none. A court code never answers `completed` or `failed`: the phone learns a match's end from the beat's `over`, and its next descriptor read is the next match.
  - `postCourtBeat(court, body, deps, now): Promise<BeatAnswer>` — the claim runs as today on the court code row (A9 newest takes over), subject to the old-app hook below; `stopped: X` from the current phone ends X `operator_stopped` (T23) AND stamps `markAutoStartBlocked` on X's fixture in the same transaction (the latch; court codes only); `state: "ended"` with a sid (T21) keeps today's meaning (ends the pairing). Step 6 (auto start) is Task 8's hook, stubbed here to `{ fired: false, why: "not_due" }`. The answer's subject is `courtFocusOf` read AFTER step 6.
  - `postCourtStart(court, body, deps, now): Promise<CaptureStartOk>` (Automatic off, the volunteer's hold) — holder check (409 `replaced`); `focus.current !== null` → 409 `already_live` naming it; `focus.start === null` → 409 `no_match`; else `startBroadcast(…, focus.start, { targetId: link.targetId, startCause: "operator", phone: "present", mode, courtLinkId: link.id })`, then `endOtherCourtSessions`.
  - **Old app versions — O13 (owner, 2026-11-15, "yes"): a court-code claim from an app build without court support is refused `404 not_a_stream_code`**, which every shipped build already shows as "Not valid for streaming — This code isn't valid for streaming." (capture `panel.codeInvalid`), so an old phone never pairs to a court and then unpairs it on its Stop. How it is set: a server environment variable `COURT_MIN_APP_VERSION`, read once by `courtMinAppVersion(): string | null` in `server/relay/config.ts` (beside the other relay settings, not a `tunable`). Its value is the `appVersion` of the first capture build carrying court support (`1.0.x-<commit count>`, capture AGENTS.md §11); builds compare by the `-<count>` suffix only. `courtClaimRefusal(appVersion: string): CaptureRefusalError | null` in capture-court.ts is called on a court code's `new` and `resume` claim before the claim is decided, and refuses any build whose count is below the configured one. The variable is set in production (and staging) before court codes are offered: `linkCourtStream` (Task 3) refuses `503 court_streaming_unconfigured` with nothing written while `courtMinAppVersion()` is null or malformed, so no court QR can exist on a server that would admit an old build. Tests: unset → linking is 503; set to `1.0.14-1200` → a `1.0.13-1150` claim is 404 `not_a_stream_code` with no pairing row, a `1.0.14-1200` claim and a `1.0.15-1300` claim are accepted; a fixture code's claim from `1.0.13-1150` is accepted (unchanged); a malformed value is treated as unset.

- [ ] **Step 1: Write the failing tests** (DB, `seedDay`, Task 3 link on Court 2 with `rigApiTarget`, `phoneId`, FakeIngest)

```ts
it("descriptor on a court with nothing streamed: waiting, label 'Court 2', court {name:'Court 2'}, no scheduledStart, no stage", async () => {
  const d = await getCode(link.code, link.tok, { slot: 0, phone }, deps, at(0));
  expect(d).toMatchObject({ state: "waiting", label: "Court 2", court: { name: "Court 2" }, autoAllowed: true, destinationName: "API rig" });
  expect(d).not.toHaveProperty("stage"); expect(d).not.toHaveProperty("scheduledStart");
});
it("A switched on, planned 14:00: descriptor label A's, beat next {label: A's, scheduledStart: 14:00 epoch s}", async () => {});
it("A live: descriptor is A's session shape with cred to the court phone only, A's stage", async () => {});
it("after A's session completed, nothing open: descriptor is WAITING on B (next), never completed A", async () => {});
it("a fixture code's descriptor and beat answer carry no court and no next", async () => {});
it("the first beat claims the court code; a second phone's new claim on a silent holder takes over (A9)", async () => {});
it("stopped: X from the court phone ends X operator_stopped and latches X's match; the pairing stays", async () => {});
it("a fixture code's stopped: X does NOT stamp auto_start_blocked_at (unchanged)", async () => {});
it("operator start with Automatic off and A in play: starts A on the link's target, cause operator, court_link_id set", async () => {});
it("operator start with nothing in play is 409 no_match; with A open is 409 already_live naming A's sid", async () => {});
it("startBroadcast refuses a court pairing for a fixture on another court, with the switch off, on a withdrawn link, or with another targetId", async () => {});
it("O13: COURT_MIN_APP_VERSION=1.0.14-1200 → a 1.0.13-1150 court claim is 404 not_a_stream_code, no pairing; 1.0.14-1200 and 1.0.15-1300 pair; a fixture code's 1.0.13-1150 claim pairs", async () => {});
it("a record upload on a court code is stored with fixture_id null and the code's id", async () => {});
```

- [ ] **Step 2: Run to verify they fail** — `cd apps/web && npx vitest run src/server/usecases/__tests__/capture-court.test.ts src/server/usecases/__tests__/stream-sessions.test.ts --reporter=json --outputFile=/tmp/cs-7.json`.

- [ ] **Step 3: Implement.** `capture-phone.ts` stays under 1,500 lines: court branches live in `capture-court.ts`; `capture-phone.ts` only dispatches on `resolved.kind` and exports the internals the court file needs (`captureCommon`, `waitingFieldsOf`, `latestSession`, `openSessionOf`, `holderOf`, `sessionDescriptor`) — visibility only. The `startBroadcast` guard query:

```sql
select p.code_id, c.issued_by, c.fixture_id as code_fixture, c.court_link_id, l.court_id as link_court, l.target_id as link_target,
       l.withdrawn_at, f.court_id as fixture_court, coalesce(st.court_stream, false) as court_stream
  from fixture_stream_pairings p
  join fixture_stream_codes c on c.id = p.code_id
  join fixtures f on f.id = ${fixtureId}
  left join court_stream_links l on l.id = c.court_link_id
  left join fixture_stream_settings st on st.fixture_id = f.id
 where p.id = ${actor.pairingId}
```

then the two branches in TypeScript, each failure its own named Error.

- [ ] **Step 4: Run to verify they pass**, plus the per-fixture regression set: `capture-get.test.ts capture-beat.test.ts capture-start.test.ts capture-record.test.ts capture-sequence.test.ts capture-model.test.ts admin-capture-records.test.ts stream-auto.test.ts`.

- [ ] **Step 5: Mutate once each** — drop the latch stamp (the latch test fails); drop the `targetId === link.target_id` check (the guard test fails).

- [ ] **Step 6: Commit** — `git commit -m "feat(capture): a court code's descriptor, beat, start and record"`

---

### Task 8: Automatic start and handover on a court

**Files:**
- Create: `apps/web/src/server/usecases/stream-auto-court.ts`
- Modify: `apps/web/src/server/relay/domain/beat-answer.ts` (`handover` row)
- Modify: `apps/web/src/server/usecases/capture-court.ts` (call the real `maybeCourtAutoStart`; pass `handover`)
- Test: `apps/web/src/server/usecases/__tests__/stream-auto-court.test.ts`; extend `apps/web/src/server/relay/domain/__tests__/beat-answer.test.ts`

**Interfaces:**
- Consumes: `courtFocusOf`; `autoStartVerdict` (unchanged table); `autoStartRefusalOf`; `startBroadcast(…courtLinkId)` and `endOtherCourtSessions` (Task 7).
- Produces:
  - `type CourtAutoStartResult = { fired: true; sessionId: string; endedSids: string[] } | { fired: false; why: "not_due" | "claim_lost" | "already_running" | "link_closed" } | { fired: false; why: "refused"; refusal: AutoStartRefusal }`
  - `maybeCourtAutoStart(a: { court: ResolvedCourtCode; pairingId: string; phoneMode: PhoneMode }, deps: SessionDeps, now: Date): Promise<CourtAutoStartResult>`
  - `BeatAnswerInput.handover: { sid: string; startedBy: CaptureStartedBy } | null`; a row between rows 2 and 3: `when: (i) => i.namedEnded !== null && i.handover !== null, then: go-live with i.handover`. The caller sets it only on a court code, only when the beat's named sid is a court session of this link that has ended and the court's current session is another one whose slot is `armed`; otherwise null (row 3 answers `over` as today).

```ts
export async function maybeCourtAutoStart(a, deps, now): Promise<CourtAutoStartResult> {
  const { court, pairingId, phoneMode } = a;
  if (court.status !== "active" || court.link.withdrawnAt !== null || now >= court.link.expiresAt) return { fired: false, why: "link_closed" };
  const { focus } = await courtFocusOf(court.link);
  if (focus.start === null) return { fired: false, why: "not_due" };
  const facts = await startFactsOf(focus.start, pairingId);        // maybeAutoStart's one-statement read, court_stream for auto_stream
  if (!autoStartVerdict({ ...facts, autoStream: facts.courtStream, phoneMode }, now, retrySeconds()).due) return { fired: false, why: "not_due" };
  if (!(await claimCourtStart(focus.start, now))) return { fired: false, why: "claim_lost" };   // CAS: court_stream and the once/blocked/spacing conditions
  try {
    const { sessionId } = await startBroadcast(
      { userId: court.issuedBy, orgId: court.orgId, source: "auto", pairingId }, focus.start,
      { targetId: court.link.targetId, startCause: "automatic", phone: "present", autoStartedAt: now,
        mode: await startModeFor(sql, focus.start), courtLinkId: court.link.id }, deps);
    const endedSids = await endOtherCourtSessions({ linkId: court.link.id, keepSid: sessionId, actorUserId: court.issuedBy }, deps);
    return { fired: true, sessionId, endedSids };
  } catch (err) { /* autoStartRefusalOf → store on focus.start's auto_start_refusal, exactly as maybeAutoStart; no session is ended */ }
}
```

Start first, then stop: a YouTube-connection destination has no holder exclusivity (`holderRows` filters `youtube_connection_id is null`; V479's one-active-target index excludes `api_backed`), so the new start is never refused for the old one, and a refused start leaves the old match's tail running.

- [ ] **Step 1: Write the failing tests**

Domain (`beat-answer.test.ts`), exact inputs and outputs:

```ts
const base = { claim: null, callerCurrent: true, slot: "armed" as const, open: { sid: SID_B, startedBy: "automatic" as const } };
it("handover: the named A ended and B is armed → go-live B", () => {
  expect(beatAnswer({ ...base, namedEnded: { sid: SID_A, endReason: "auto-stopped" }, handover: { sid: SID_B, startedBy: "automatic" } }))
    .toEqual({ state: "go-live", sid: SID_B, startedBy: "automatic" });
});
it("no handover given: the named A ended → over A (today's row 3)", () => {
  expect(beatAnswer({ ...base, namedEnded: { sid: SID_A, endReason: "auto-stopped" }, handover: null }))
    .toEqual({ state: "over", sid: SID_A, endReason: "auto-stopped" });
});
it("a replaced caller still hears replaced before any handover", () => {
  expect(beatAnswer({ ...base, callerCurrent: false, namedEnded: { sid: SID_A, endReason: "auto-stopped" }, handover: { sid: SID_B, startedBy: "automatic" } }).state).toBe("replaced");
});
```

(Use the wire's actual `endReason` spelling from `wireEndReason`, read before writing.)

Use case (`stream-auto-court.test.ts`; DB, FakeIngest `connectAfterMs: 0`, `deps.youtube = new FakeYouTube()`, `rigApiTarget`, Task 3 link on Court 2, a court phone `P` claimed in automatic mode, credits 5; `kickoff(fx, at)` appends a `core.start` score event and sets `in_play`):

```ts
it("A switched on kicks off: the next beat answers go-live, startedBy automatic; the session has court_link_id and A's fixture", async () => {
  await setCourtStream(day.auth, A, true); await kickoff(A, at(0));
  const ans = await beat(P, { sid: null });
  expect(ans).toMatchObject({ state: "go-live", startedBy: "automatic" });
  expect(await sessionRow(ans.sid)).toMatchObject({ fixture_id: A, court_link_id: link.id, target_id: api.targetId, start_cause: "automatic" });
});
it("an unstreamed match in play never starts: no session, no consume row", async () => {
  await kickoff(C, at(0)); expect((await beat(P, { sid: null })).state).toBe("waiting");
  expect(await sessionsOf(C)).toEqual([]); expect(await consumeRows(day.orgId)).toEqual([]);
});
it("A in its tail, B kicks off: B starts, then A ends auto_stopped with court_handover {to: B}", async () => {
  // A live, result saved at at(10), B kickoff at(11), beat naming A's sid
  // expect: B active, A state ending/completed end_reason auto_stopped, event court_handover payload {to: sidB}
});
it("the handover beat names A and B is armed: the answer is go-live B", async () => {});
it("phone offline across the handover: its first beat back naming A gets go-live B, or over A then go-live B; never A", async () => {}); // Review Focus 1
it("two court sessions open (a desk restart and an automatic start): after the next start only the new one is active", async () => {});
it("a match switched on mid-match goes live late, once; once it received video it never auto-starts again", async () => {});
it("the phone in Operator mode: nothing starts; the waiting answer still names A", async () => {});
it("past the day's end or withdrawn: link_closed, nothing starts, the live session runs on", async () => {}); // Review Focus 2
it("the YouTube connection revoked: refused no_destination, stored on A, the beat answers 200", async () => {}); // Review Focus 5
it("the link's target archived after linking: refused no_destination, stored", async () => {});
it("zero credits: refused no_credit, stored on B; A's tail is NOT stopped", async () => {});
it("a streamed match with no players entered starts, labelled 'Match {n}' in the org's locale", async () => {});
it("the same phone rescanning the court code (claim resume) keeps its pairing and its live session", async () => {});
```

- [ ] **Step 2: Run to verify they fail** — `cd apps/web && npx vitest run src/server/usecases/__tests__/stream-auto-court.test.ts src/server/relay/domain/__tests__/beat-answer.test.ts --reporter=json --outputFile=/tmp/cs-8.json`.

- [ ] **Step 3: Implement** as sketched above; `startFactsOf` and `claimCourtStart` are `maybeAutoStart`'s read and CAS with `court_stream` in place of `auto_stream` and the pairing joined through `c.court_link_id` instead of `c.fixture_id`.

- [ ] **Step 4: Run to verify they pass**, plus `stream-auto.test.ts stream-auto-model.test.ts stream-sessions.test.ts capture-beat.test.ts capture-sequence.test.ts`.

- [ ] **Step 5: Mutate once each** — (a) delete `court_stream` from the claim's WHERE: the unstreamed test fails; (b) call `endOtherCourtSessions` before `startBroadcast`: the zero-credits test fails; (c) make `endOtherCourtSessions` stop only the focus's `current`: the two-open-sessions test fails. Restore all.

- [ ] **Step 6: Commit** — `git commit -m "feat(stream): court automatic start and handover, one session per match"`

---

### Task 9: The tail, the latches, a desk restart — and money across handovers

**Files:**
- Modify: `apps/web/src/server/usecases/stream-sessions/auto-stop.ts` (`autoStopFactsOf`: `coalesce(st.auto_stream, false) or s.court_link_id is not null as auto_stream`)
- Modify: `apps/web/src/server/usecases/stream-sessions/start.ts` (`currentPhoneOf`: with no active own code, the court phone of the fixture's live court link when `court_stream` is on; `createSession` then starts with `courtLinkId` = that link and `targetId` FORCED to the link's `target_id` whatever the body names (O9; the Task 7 guard refuses any other), and after the start calls `endOtherCourtSessions`; the pre-pick write is skipped for a court start so the match's own destination choice is untouched)
- Test: `apps/web/src/server/usecases/__tests__/court-stream-money.test.ts`; extend `stream-auto-stop.test.ts`

**Interfaces:**
- Consumes: Task 8's `maybeCourtAutoStart`; Task 7's `startBroadcast(…courtLinkId)` and `endOtherCourtSessions`; `stopSession`; `consumeForSession` and `restartAllowance` (unchanged).
- The desk has no Stop or Go live button of its own: an organiser stops or restarts a court match from the match page's stream panel (the desk's `?stream=open` link), which runs `stopSession` and `createSession`.
- Produces: `currentPhoneOf(fixtureId, now)` returns `{ pairingId, standing, courtLinkId: string | null }`.

- [ ] **Step 1: Write the failing tests**

```ts
// Tail and latches
it("nothing follows: A's court session ends auto_stopped 180 s after finished_at (tunable), not before", async () => {});
it("a court session with its phone in Operator is never auto-stopped", async () => {});
it("organiser Stop on A ends A only; the link and the phone's pairing stay; A is never re-offered", async () => {});
it("phone Stop on A latches A; the match page's Go live restarts it on the court phone, court_link_id set, target the link's even when the body names another", async () => {});
it("a match-page restart of A while B's court session is live ends B (one active session per court link)", async () => {});

// Money and retention (spec §7 Web)
it("A then B streamed back to back: two consume rows, one per session, each session's fixture its own", async () => {});
it("A streamed, C (switch off) played between, then B: C has no session and no consume row", async () => {});
it("A restarted by the desk inside the reuse window: no second consume (W23 free restart)", async () => {});
it("each streamed match gets its own YouTube broadcast row (fixture_id = that match), and each session its own recording uids", async () => {});
it("a refused start (no_credit) writes no session and no consume row", async () => {});

// Regression
it("a per-fixture code's auto stop still reads the fixture's auto_stream switch alone", async () => {});
```

- [ ] **Step 2: Run to verify they fail** — `cd apps/web && npx vitest run src/server/usecases/__tests__/court-stream-money.test.ts src/server/usecases/__tests__/stream-auto-stop.test.ts --reporter=json --outputFile=/tmp/cs-9.json`.

- [ ] **Step 3: Implement.** Drive each go-live through the real tick (`tickSession` with FakeIngest connecting), so the consume happens where production consumes it (`apply`'s warming → live), never by inserting ledger rows.

- [ ] **Step 4: Run to verify they pass**, plus `stream-sessions.test.ts stream-auto-stop.test.ts capture-start.test.ts`.

- [ ] **Step 5: Mutate once** — drop `or s.court_link_id is not null`: the 180 s tail test must fail.

- [ ] **Step 6: Commit** — `git commit -m "feat(stream): court tail, latches and desk restart; money across handovers"`

---

### Task 10: The scoring link on a court code

**Files:**
- Modify: `apps/web/src/server/usecases/capture-phone.ts` (`postScoringLink` dispatches on `kind`; `label` on every answer)
- Modify: `apps/web/src/server/usecases/capture-court.ts` (`postCourtScoringLink`)
- Test: extend `apps/web/src/server/usecases/__tests__/capture-scoring-link.test.ts`; `capture-court.test.ts`

**Interfaces:**
- Consumes: `courtFocusOf().focus.scoringFixtureId`, `asFixtureCode`, `matchLabelOf`, `provideDeviceLinkForPhone`.
- Produces: `postCourtScoringLink(court: ResolvedCourtCode, body, deps, now, clientIp): Promise<CaptureScoringLinkOk>`, in this order: (1) resolve as `start`; (2) holder check against the court's current session or pairing → 409 `replaced`; (3) `courtFocusOf` → `scoringFixtureId === null` → 409 `no_match`; (4) https origin → 503; (5) `rateLimit("dlmint:"+clientIp, DEVICE_LINK_MINT_LIMIT)` (capture-phone.ts:824's budget); (6) `provideDeviceLinkForPhone(asFixtureCode(…))` → the link with that match's `label`. Steps 3 and 4 both come before the budget, so a refusal never spends it. The fixture code's order is today's with `label` added. A fixture code's answer also gains `label` (the code's own match).

- [ ] **Step 1: Write the failing tests**

```ts
it("during A's video the tap gets C's link (the next unstarted match on the court), streamed or not, with C's label", async () => {});
it("a held call outranks an earlier planned match", async () => {});
it("no match queued on the court: 409 no_match, no device link written, the mint budget untouched", async () => {});
it("a second tap returns the same url (no revoke), even after C's switch flips", async () => {});
it("a phone that is not the court's current phone: 409 replaced before anything is read", async () => {});
it("a fixture code's answer is {url, label} with its own match's label", async () => {});
```

- [ ] **Step 2: Run to verify they fail** — `cd apps/web && npx vitest run src/server/usecases/__tests__/capture-scoring-link.test.ts src/server/usecases/__tests__/capture-court.test.ts --reporter=json --outputFile=/tmp/cs-10.json`.

- [ ] **Step 3: Implement.** - [ ] **Step 4: Run to verify they pass.**

- [ ] **Step 5: Mutate once** — move the `no_match` check after `rateLimit`: the budget test must fail.

- [ ] **Step 6: Commit** — `git commit -m "feat(capture): a court code's scoring link is the court's next match"`

---

### Task 11: The desk's read of court streams

**Files:**
- Modify: `apps/web/src/lib/match-day/types.ts` (`MatchDayCourt.stream_link`, `MatchDayFixture.court_stream`, `MatchDayFixture.own_stream_code`)
- Modify: `apps/web/src/server/usecases/court-streams.ts` (`courtStreamsForDay`)
- Modify: `apps/web/src/server/usecases/match-day.ts` (`getMatchDay` merges it)
- Modify: `apps/web/src/server/api-v1/schemas/fixtures.ts` (the zod twins `MatchDayFixture` ~l.123 and `MatchDayCourt` ~l.160 gain the same fields; the route test parses each real answer with them), then `npm run openapi:gen` and commit `openapi/`
- Test: `apps/web/src/server/usecases/__tests__/court-streams-desk.test.ts`; extend `match-day.test.ts`

**Interfaces:**
- Consumes: `courtPhoneStatus` (Task 5); `liveCourtLinkFor`.
- Produces:

```ts
export interface MatchDayCourtStream {
  link_id: string;
  target_label: string;
  expires_at: string;                 // ISO
  phone: "unpaired" | "waiting" | "live" | "offline";
  /** The stored refusal of the court's latest refused automatic start (the focus match's `auto_start_refusal`), else null. */
  refusal: "no_destination" | "no_credit" | "not_entitled" | "destination_in_use" | "unavailable" | "competition_frozen" | null;
}
// MatchDayCourt.stream_link: MatchDayCourtStream | null
// MatchDayFixture.court_stream: boolean       — the switch
// MatchDayFixture.own_stream_code: boolean    — an ACTIVE fixture code exists (the switch shows "This match has its own stream code")
courtStreamsForDay(orgId: string, courtIds: readonly string[], fixtureIds: readonly string[], now: Date): Promise<{ links: Map<string, MatchDayCourtStream>; switches: Map<string, { on: boolean; ownCode: boolean }> }>
```

`competition_frozen` is served the way `streamPhone` serves it (`AUTO_SERVED_REFUSALS`), never stored.

- [ ] **Step 1: Write the failing tests**

```ts
it("a linked court with no phone reads unpaired; after a beat waiting; with a live session live; 3 missed beats offline", async () => {});
it("an unlinked court has stream_link null; a withdrawn link reads null", async () => {});
it("a refused automatic start shows its refusal on the court; a later success clears it", async () => {});
it("court_stream and own_stream_code per match", async () => {});
it("a view-only member reads it; the read costs one statement per kind (no per-court query)", async () => {});
```

- [ ] **Step 2: Run to verify they fail** — `cd apps/web && npx vitest run src/server/usecases/__tests__/court-streams-desk.test.ts src/server/usecases/__tests__/match-day.test.ts --reporter=json --outputFile=/tmp/cs-11.json`.

- [ ] **Step 3: Implement.** - [ ] **Step 4: Run to verify they pass.**

- [ ] **Step 5: Mutate once** — make `offline` use 2 beats: the offline test must fail.

- [ ] **Step 6: Commit** — `git commit -m "feat(match-day): court stream status in the desk's read"`

---

### Task 12: The desk UI — link a court, its QR, the Stream switch, the phone's status

**Files:**
- Create: `apps/web/src/components/v2/match-day/court-stream-sheet.tsx`, `court-stream-switch.tsx`, `court-phone-status.tsx`
- Modify: `apps/web/src/components/v2/match-day/court-focus.tsx` (header action, status, switch on the current match and each queued row), `court-list.tsx` (the status chip on a linked court's row)
- Modify: `apps/web/src/dictionaries/{en,es,fr,nl}/ui.json`, `apps/web/src/lib/i18n-keys.ts`
- Test: `apps/web/src/components/v2/match-day/__tests__/court-stream-ssr.test.tsx`; `apps/web/e2e/match-day.spec.ts` (new `court stream` describe)

**Interfaces:**
- Consumes: Task 3's routes, Task 4's route, Task 11's fields; `SeaznQrImage`, `renderSeaznQr`, `PHONE_HANDOVER_QR_MAX_PX` (as `match-day-code-sheet.tsx` uses them); `captureQrV2Text` (writes `exp`).
- Produces (English copy; es/fr/nl in the house voice):
  - `matchDay.courtStream.link` "Stream this court"
  - `matchDay.courtStream.destination` "YouTube channel"
  - `matchDay.courtStream.youtubeOnly` "A court streams to a connected YouTube channel, one video per match."
  - `matchDay.courtStream.connectYoutube` "Connect YouTube"
  - `matchDay.courtStream.show` "Show court QR"
  - `matchDay.courtStream.qrHint` "Scan with the Seazn Club app: Live Stream."
  - `matchDay.courtStream.until` "Works until {time} today"
  - `matchDay.courtStream.withdraw` "Stop streaming {court}"
  - `matchDay.courtStream.withdrawConfirm` "Unlink {court}? Its phone stops following matches. A match on air finishes first."
  - `matchDay.courtStream.phone.unpaired` "No phone yet", `.waiting` "Phone waiting", `.live` "Live", `.offline` "Phone offline"
  - `matchDay.courtStream.switch` "Stream"
  - `matchDay.courtStream.notStreaming` "Court not streaming"
  - `matchDay.courtStream.ownCode` "This match has its own stream code"
  - Refusal lines: reuse the stream panel's existing automatic-start refusal keys (grep `auto_start_refusal` copy used by `fixture-stream-panel.tsx`); add a key only where none exists.

Rules: the Link action shows on a court with no link, for an editor, not read-only, not frozen. The destination picker lists only YouTube-connection targets; with none, it shows `youtubeOnly` and a `connectYoutube` link to the org's destinations settings. The switch shows on a linked court's current and queued rows; on an unlinked court only a row whose switch is ON shows it, disabled, with `notStreaming`; a row with `own_stream_code` shows it disabled with `ownCode`. The QR sheet re-shows on demand (GET) and never mints on open. A refused switch (409) reverts the toggle and shows the refusal's line. Read-only and frozen views show the status chip and nothing that writes.

- [ ] **Step 1: Write the failing tests** — SSR: link action present/absent per role and freeze; switch states (on, off, disabled not-streaming, disabled own-code); chip text per phone status; no hard-coded English (render with the `nl` dictionary and assert the Dutch strings). e2e: the desktop flow in `match-day.spec.ts`, and the phone-width case (focused court, switch, chip, QR sheet with no horizontal scroll) in `apps/web/e2e/mobile/match-surfaces.spec.ts`, beside the other Match Day phone checks. Flow: link Court 2 → QR visible → switch on a queued match → the fake capture phone (`e2e/helpers/fake-capture-phone.ts`) beats → chip reads "Phone waiting" → withdraw → chip gone.

- [ ] **Step 2: Run to verify they fail** — `cd apps/web && npx vitest run src/components/v2/match-day/__tests__/court-stream-ssr.test.tsx --reporter=json --outputFile=/tmp/cs-12.json`; `npx playwright test e2e/match-day.spec.ts e2e/mobile/match-surfaces.spec.ts` (whole files, never `-g`).

- [ ] **Step 3: Implement**, following `match-day-code-sheet.tsx` for the sheet and the page's `max-md:` conventions (no second phone tree; `min-w-0` down the chain).

- [ ] **Step 4: Run to verify they pass**, and screenshot the focused court at 1280, 768 and 320 (linked, unlinked, live, offline) — no horizontal scroll, images opened and compared.

- [ ] **Step 5: Mutate once** — show the Link action to a read-only reader: the role test must fail.

- [ ] **Step 6: Commit** — `git commit -m "feat(match-day): link a court to stream, its QR, the Stream switch and phone status"`

---

### Task 13: The match page says "Streamed by Court 2's phone"

**Files:**
- Read first: `apps/web/src/server/MODULARIZATION.md` (stream-phone.ts and the stream-sessions folder are under it).
- Modify: `apps/web/src/server/usecases/stream-phone.ts` (`StreamPhone.court: { name: string } | null`)
- Modify: `apps/web/src/components/v2/fixture-stream-panel.tsx` (the line; no QR and no ensure call while `court` is set)
- Modify: dictionaries (`stream.courtStreamed` "Streamed by {court}'s phone")
- Test: `apps/web/src/components/v2/__tests__/fixture-stream-panel.test.tsx`; `apps/web/src/app/api/v1/fixtures/[id]/stream-phone/__tests__/route.test.ts`

**Interfaces:**
- Consumes: `liveCourtLinkFor`; the switch.
- Produces: `court` is set exactly when the fixture's switch is on and its court has a live link now. The panel keeps its Stop and Go live: they are the desk's Stop and restart for a court match (Task 9), and its Go live starts on the court phone and the link's channel.

- [ ] **Step 1: Write the failing tests** — the read carries `court`; the panel renders the line, renders no QR and makes no `POST …/stream-code` call; with the switch off the panel is today's (regression: existing panel tests unchanged).
- [ ] **Step 2: Run to verify they fail** — `cd apps/web && npx vitest run src/components/v2/__tests__/fixture-stream-panel.test.tsx "src/app/api/v1/fixtures/[id]/stream-phone" --reporter=json --outputFile=/tmp/cs-13.json`.
- [ ] **Step 3: Implement.** - [ ] **Step 4: Run to verify they pass**; screenshot the panel at 1280 and 320.
- [ ] **Step 5: Mutate once** — drop the `court` guard on the ensure call: the no-mint test must fail.
- [ ] **Step 6: Commit** — `git commit -m "feat(stream): a court-streamed match's panel names its court phone"`

---

### Task 14: Docs, the walkthrough and the regression sweep

**Files:**
- Modify: `docs/superpowers/specs/2026-10-31-match-day-design.md` §8 — replace "Between matches the stream shows a court-idle card." with: "Each streamed match is its own broadcast and its own video (court stream design 2026-11-14, O2); between matches nothing is on air. Superseded by O11, owner 2026-11-14." Keep §8's other constraints; add a pointer to this plan and the court stream spec.
- Modify: `apps/web/content/help/scheduling/match-day.md` — a "Stream a court" section: link, scan, switch, what the phone does, withdraw (English only).
- Create: `apps/web/e2e/walkthrough/court-stream.spec.ts` (with `AUTO_STOP_AFTER_RESULT_SECONDS` and `AUTO_START_RETRY_SECONDS` shortened through `tunable`)

- [ ] **Step 1: Write the walkthrough** — desk links Court 2 → fake phone claims → A and B switched on, C off → A starts on the pad → phone answered go-live → A's result → B starts inside the tail → phone answered go-live B, A ended → C plays, nothing starts → B's result → tail ends B → read `org_stream_credits`: exactly two consume rows (A, B).
- [ ] **Step 2: Run it** — `cd apps/web && npx playwright test e2e/walkthrough/court-stream.spec.ts`. Expected: PASS.
- [ ] **Step 3: Regression sweep (scoped)** — every suite named in Tasks 1–13's verify steps in one JSON-reporter run; confirm `numTotalTests` equals the sum of the per-task counts and every path in `.testResults[].name` is under this worktree. Then `npx playwright test e2e/walkthrough/capture-phone.spec.ts e2e/match-day.spec.ts` (whole files).
- [ ] **Step 4: Commit** — `git commit -m "docs: court stream supersedes the court-idle card; help and walkthrough"`
- [ ] **Step 5: Open the PR** — smoke runs on the PR; e2e only after merge or by `workflow_dispatch` with `pr`. Then the whole-branch Opus review before merge. Tell the capture session the merge commit to re-vendor the contracts from.

---

## Decisions this plan makes (for the reviewer)

- **Start, then stop, on a handover** (spec §5.4 said end-then-start). The spec's premise was the holder guard (`target_in_use`); verified false for a YouTube-connection destination, which O9 makes the only kind: `holderRows` skips connection-backed targets and V479's one-active-target index excludes `api_backed`. Start-first means a refused start (no credit, revoked channel) never cuts the previous match's tail. If the owner wants end-then-start anyway, it is the order of two calls in `maybeCourtAutoStart` (Task 8) and one test.
- **One active session per court link.** Every successful court start (automatic, the phone's operator start, a match-page restart) ends every other active session of the link (`endOtherCourtSessions`), so a desk restart can never leave two videos running on one camera.
- **Old app versions: O13** (owner, 2026-11-15): `COURT_MIN_APP_VERSION` (env, `server/relay/config.ts`) refuses an older build's court claim 404 `not_a_stream_code`; linking a court is refused until it is set (Tasks 3, 7).
- **`startBroadcast`, not `createSession`**, for the court's automatic start: `createSession` is the organiser's path and writes the destination pre-pick (`target_chosen`), which an automatic start must not (stream-auto.ts header, plan R-1). Admission, credits, recording and the YouTube broadcast are the same code either way.
- **Court codes live in `fixture_stream_codes`** (nullable `fixture_id`, `court_link_id`, one-owner check) so pairings, sessions, beats and records keep their foreign keys.
- **`no_match` joins the shared refusal list** (the W27 `match_finished` precedent), so the start and scoring-link routes share one refusal parser on the phone.
- **The phone's Stop on a court code stamps the A12 latch** on that match; on a fixture code it still does not (unchanged).
- **The desk's phone status has a fourth state, "No phone yet"** (`unpaired`), for a linked court nobody has scanned.
- **The court's day is the competition's zone**, as Match Day codes compute it; there is no per-venue zone in the schema.
