# Seazn-hosted Video Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a per-match destination **Seazn**. A Seazn match runs composed, plays live on the public match page and on Match Day from a signed Cloudflare programme input, and its replay moves to Bunny Stream, where it stays while the org is a customer. Delivered minutes are measured for staff.

**Architecture:** Seazn is one `org_stream_targets` row per org with `kind = 'seazn'` and no credential. Every admission, holder and picker path reads it from there, so `target_id` stays the session's one destination fact. A Seazn session is composed. The programme input (Input B, R2004) that composed sessions already create becomes the viewers' input: it is created signed and gets no Cloudflare output. A tick pass moves finished programme recordings to Bunny through a new `ReplayHost` port. From Phase 1 on, the daily sweep holds every Seazn recording past 3 days (Cloudflare's 30-day floor is the backstop) so Phase 2 can still move it; Phase 3 measures delivery and deletes the replays of deleted orgs.

**Tech Stack:** Next.js (apps/web), TypeScript 7, postgres.js (`sql`, the non-tenant client for stream tables), zod 4 api-v1 schemas plus `npm run openapi:gen`, `jose` (already a dependency) for RS256 tokens, `hls.js` (new, pinned exactly), vitest (node env, real Postgres), Playwright e2e, and `scripts/smoke/suites`.

**Spec:** `docs/superpowers/specs/2026-11-20-seazn-hosted-video-design.md`. Executors read it first; it is binding. Also read `apps/web/src/server/MODULARIZATION.md`, `docs/superpowers/RULES.md` and `docs/superpowers/TEST-STRATEGY.md`.

## Global Constraints

- **Migration numbers: V538, V539, V540.** The spec's "next is V531" is stale: this branch already has V531–V537 (no V533). Re-check `ls db/migration/deltas | sort -V | tail -3` at each rebase and renumber if main has moved.
- **Three server flags, all off by default**, read in `apps/web/src/server/relay/config.ts`, the one place relay numbers and settings live, and parsed the way `STREAM_SRT_ENABLED` is (`"true"`/`"false"`, anything else throws): `SEAZN_HOSTED_LIVE` (Phase 1), `SEAZN_HOSTED_REPLAY` (Phase 2, which needs LIVE), `SEAZN_HOSTED_COST` (Phase 3). With LIVE off, no reader lists, picks, resolves or admits a `seazn` row, and the product behaves exactly as it does today.
- G1, the anti-goal: a Seazn session creates no `youtube_broadcasts` row, prepares no broadcast, adds no Cloudflare output and reads no key. A non-Seazn session's path does not change by one byte. Every task that touches start, apply or tick carries a regression test for a pasted-key session and a YouTube session.
- G5: **all Seazn playback is signed.** That covers the Cloudflare programme input (`recording.requireSignedURLs: true`, `allowedOrigins` = the Seazn hosts) and the Bunny CDN (token authentication, with the library's allowed domains set to the Seazn hosts). The camera input stays unsigned, because the phone's `playbackUrl` (`capture-phone.ts:269`) reads it.
- `ingest-cf.ts:10-15`: never send an update that changes `recording` on a live input. The signed settings are part of the create body, and `setInputEnabled` re-sends exactly what the create sent.
- Secrets (the Cloudflare signing key, the Bunny API key, the Bunny token key) come from env through `config.ts` only. They never appear in a URL query, a log, an error, a `stream_provider_calls` row or a database column. A signed token appears only in the playback URL handed to the viewer.
- Courts stay out (spec §7.2). `court_stream_links` admits YouTube connections only (court stream O9), so a `seazn` row (no connection) is already refused there. A test pins that.
- Billing is unchanged (spec §7.3): a Seazn match takes one stream credit through the same admission, balance and `consume_credit` path as any composed match.
- Every new user-facing string goes in `src/dictionaries/{en,es,fr,nl}/ui.json` (and `public.json` for the match page). `src/lib/i18n-keys.ts` is generated and never hand-edited.
- UI changes are verified at 1280, 768 and 320 with no horizontal page scroll. `/admin` is verified at 1280 only.
- Run only the tests that cover the files you changed. Read the counts from `--reporter=json --outputFile=<scratch>/r.json` (`numPassedTests`/`numTotalTests`, with paths under this worktree). Never run the full suite locally.
- After any api-v1 change: `npm run openapi:gen && git status --porcelain` must show only your intended openapi diff.

## Review Focus

1. **Two Seazn matches of one org live at the same time.** Both are admitted, because one shared `seazn` row must never read as "destination in use". Pinned in Task 3 (the index) and Task 5 (the holder guard and admission).
2. **The flag goes off after a fixture saved Seazn as its pick, or while a Seazn session runs.** A new start is refused with a typed 422, the saved Seazn pick resolves to **no destination** ("waiting for a destination"), never silently to YouTube or another external one (spec anti-goal), and the running session runs on and ends normally. Pinned in Task 4 and Task 5.
3. **A viewer who loaded the page before kick-off, or keeps it open past the token's expiry.** The player appears when the session goes live, without a reload, and re-mints before expiry while keeping the same `<video>` element. Pinned in Task 9.
4. **A Stop and restart, which makes two sessions, or one programme input with two recordings.** Every recording becomes a replay, numbered by recording start across sessions. Pinned in Task 18 and Task 19.
5. **Bunny never becomes playable** (status 5 or 6, a fetch that keeps failing, an unreachable API). The Cloudflare recording is never deleted, retries back off, staff are alerted once after 3 days, and the sweep never deletes it. Pinned in Task 18 and Task 12.

---

# Phase 1 — Seazn live (`SEAZN_HOSTED_LIVE`)

### Task 1: Probe Cloudflare signed live playback

The adapter changes in Task 6 rest on three vendor behaviours that the docs leave open: `requireSignedURLs` and `allowedOrigins` placed inside `recording` on a **live input**, a self-signed token whose `sub` is the **live input uid**, and a `PUT` that keeps the setting. Settle them before building on them.

**Files:**

- Create: `apps/web/src/server/relay/__tests__/cf-signed-live.live.test.ts`, gated the way `fly-client.live.test.ts` is (`_live-fly-gate.ts` pattern: skipped unless `CF_LIVE_PROBE=1` plus the account env)
- Create: `docs/superpowers/specs/2026-11-20-seazn-hosted-probes.md` (results only)

- [ ] **Step 1: Write the probe.** Create an input with `recording: { mode: "automatic", requireSignedURLs: true, allowedOrigins: ["seazn.club"], timeoutSeconds: 180 }`. Assert:
  - the echo carries both settings;
  - an unsigned `/{uid}/manifest/video.m3u8` answers 401 or 403;
  - a `jose`-signed RS256 token `{ sub: uid, kid, exp: now+600 }` at `/{token}/manifest/video.m3u8` answers 200 (or 204 while idle; anything but 401/403);
  - a `PUT` that re-sends the same `recording` with `enabled: false` echoes `requireSignedURLs: true`;
  - the video the input records reads `requireSignedURLs: true` in `GET /stream/{videoId}`.

  Then delete the video and the input.

- [ ] **Step 2: Run it against the staging account.** `cd apps/web && CF_LIVE_PROBE=1 npx vitest run src/server/relay/__tests__/cf-signed-live.live.test.ts`. Record each assertion's result in the probes doc. If `sub` = input uid fails, stop and raise it: Task 7 must then sign the input's current live video uid (`listInputVideos` → the `inProgress` one), which the doc records as the fallback.
- [ ] **Step 3: Commit** `test(stream): live probe for signed Cloudflare live inputs`.

### Task 2: Seazn settings in relay config

**Files:**

- Modify: `apps/web/src/server/relay/config.ts` (beside `streamPlaybackHost`/`srtEnabled`, `:314-342`)
- Test: `apps/web/src/server/relay/__tests__/config.test.ts`

**Interfaces — Produces:**

- `seaznHostedLive(env?): boolean`, `seaznHostedReplay(env?): boolean`, `seaznHostedCost(env?): boolean`. Unset means false. `"true"`/`"false"` are accepted case-insensitively; anything else throws and names the variable. `seaznHostedReplay` is true only when LIVE is true too.
- `seaznVideoOrigins(env?): string[] | null`. Reads `SEAZN_VIDEO_ORIGINS`, comma-separated bare hostnames trimmed and de-duplicated. Null when unset. Throws on an entry with a scheme or path.
- `streamSigningKey(env?): { keyId: string; pem: string } | null`. Reads `STREAM_SIGNING_KEY_ID` and `STREAM_SIGNING_KEY_PEM_B64`, and null unless both are set. Under the FAKE driver the answer is `{ keyId: "fake", pem }` from `fakeSigningKey()` in `fakes.ts`, an RSA pair generated with `jose` `generateKeyPair("RS256")` once per process and kept in memory. No private key is committed.
- `SEAZN_LIVE_TOKEN_TTL_SECONDS = 3600` and `SEAZN_TOKEN_REFRESH_BEFORE_SECONDS = 300`.

  Plan decision: a 1 h token that the client island re-mints 5 min before expiry (Task 9). That keeps the token short-lived (spec §5.2), stays far under Cloudflare's 24 h cap, and a 3 h match costs three mints per viewer.

- [ ] **Step 1: Write the failing tests.**
  - `seaznHostedLive({})` is false. `({SEAZN_HOSTED_LIVE:"TRUE"})` is true. `"yes"` throws `/SEAZN_HOSTED_LIVE/`.
  - `seaznHostedReplay({SEAZN_HOSTED_REPLAY:"true"})` is false while LIVE is unset.
  - `seaznVideoOrigins({SEAZN_VIDEO_ORIGINS:" seazn.club,www.seazn.club,seazn.club"})` equals `["seazn.club","www.seazn.club"]`, and `"https://seazn.club"` throws.
  - `streamSigningKey` is null when only one of the two variables is set.
  - The values are pinned to the constants: `SEAZN_LIVE_TOKEN_TTL_SECONDS === 3600`.
- [ ] **Step 2: Run them and see them fail.** `cd apps/web && npx vitest run src/server/relay/__tests__/config.test.ts --reporter=json --outputFile=$SCRATCH/t2.json`.
- [ ] **Step 3: Implement** the five readers and the constants.
- [ ] **Step 4: Run the Step 2 command again.** Expect PASS. Mutate one guard: make `seaznHostedReplay` ignore LIVE, and the LIVE-unset test fails.
- [ ] **Step 5: Commit** `feat(stream): Seazn-hosted settings and flags`.

### Task 3: Migration V538 — the Seazn destination row

**Files:**

- Create: `db/migration/deltas/V538__seazn_destination.sql`
- Test: `apps/web/src/server/relay/__tests__/seazn-destination-migration.test.ts`, following `court-stream-migration.test.ts`. Extend `migration-shape.test.ts` if it enumerates the kind check.

**Plan decision:** use a `kind = 'seazn'` row on `org_stream_targets`, not a flag on `fixture_stream_settings`. `fixture_stream_sessions.target_id`, `court_stream_links.target_id` (not null), the picker, `fixtureStreamTarget`'s default and the session's `destination_kind` copy (`start.ts:477`) all key on a target row, so a row keeps every reader working and a flag would fork each of them.

**DDL:**

- Widen the kind check to `('youtube','facebook','twitch','kick','custom_rtmp','seazn')`.
- Replace `org_stream_targets_one_source` with `check ((kind = 'seazn' and rtmp_enc is null and youtube_connection_id is null) or (kind <> 'seazn' and (rtmp_enc is null) <> (youtube_connection_id is null)))`.
- `create unique index org_stream_targets_one_seazn on org_stream_targets (org_id) where kind = 'seazn'`.
- Insert one row per existing organisation: `label 'Seazn'`, `watch_url null`. Create function `ensure_seazn_target()` as `security definer` with `set search_path = public, pg_temp`, owned by the migration role, and an `after insert on organizations` trigger that inserts the row (`on conflict do nothing`). `org_stream_targets` has forced RLS with no policy (V410 `:407-408`), so an invoker-rights trigger would fail an org insert made by the app role.
- `fixture_stream_inputs` gains `access jsonb null`: the signed settings an input was CREATED with (`{"signed":true,"allowedOrigins":[…]}`), written once by provisioning and never updated (Task 6).
- `create table seazn_held_alerts (cf_video_id text primary key, session_id uuid not null references fixture_stream_sessions(id) on delete restrict, alerted_at timestamptz not null default now())`, with RLS as in V430. It is the one-alert-per-recording mark for the sweep hold (Task 12); it needs no replay row, so it works in Phase 1.
- Drop and recreate `fixture_stream_sessions_one_active_target` (V479 `:285-289`) with an added `and destination_kind is distinct from 'seazn'`. `destination_kind` is written once at insert and never updated, so the predicate is stable.

  Plan decision: rows are created by trigger rather than lazily on read. `fixtureStreamTarget` is documented as writing nothing, and RULES.md is greenfield, so no backfill concern applies.

- [ ] **Step 1: Write the failing tests.**
  - A new org gets exactly one `seazn` row.
  - A second `seazn` row for that org fails 23505.
  - A `seazn` row with `rtmp_enc` set fails 23514. A `youtube` row with neither source still fails 23514 (the regression).
  - Two `live` sessions on one `seazn` target insert. Two on one pasted target still fail 23505.
  - The RLS state of `org_stream_targets` is unchanged (`rls-static.test.ts`), and `seazn_held_alerts` is listed.
  - An organisation inserted under `set local role app_user` (the app role) commits and gets its `seazn` row. Run it once with the function as invoker to see it fail, then as definer.
- [ ] **Step 2: Run them and see them fail** (table shape missing). `cd apps/web && npx vitest run src/server/relay/__tests__/seazn-destination-migration.test.ts src/server/relay/__tests__/migration-shape.test.ts src/server/relay/__tests__/rls-static.test.ts --reporter=json --outputFile=$SCRATCH/t3.json`.
- [ ] **Step 3: Write V538.** Apply it to a fresh local schema per the `seazn-local-env` skill (`db:apply` then `sync:sports`). Never apply it to a shared database.
- [ ] **Step 4: Run the Step 2 command again.** Expect PASS.
- [ ] **Step 5: Commit** `feat(db): V538 Seazn destination row`.

### Task 4: Destination reads and writes know Seazn

**Files:**

- Modify: `apps/web/src/server/api-v1/schemas/streaming.ts:70` (`StreamTargetKind` gains `"seazn"`)
- Modify: `apps/web/src/server/usecases/stream-targets.ts`:
  - `listStreamTargets :66-95`: when LIVE is on, Seazn is first, `keyHint: null`, `inUse: null`; when LIVE is off, the row is left out.
  - `patchStreamTarget :163`, `removeStreamTarget :198`: both refuse a `seazn` row.
- Modify: `apps/web/src/server/usecases/stream-codes.ts`:
  - `fixtureStreamTarget :496-509`: when LIVE is on, list `seazn` first; when off, exclude it.
  - `writeStreamSettings :515`: refuse a `seazn` target with 422 `seazn_unavailable` while LIVE is off.
- Modify: `apps/web/src/server/usecases/stream-target-holders.ts:43-66` (`holderRows`): add `and t.kind <> 'seazn'` beside the existing `t.youtube_connection_id is null`.
- Read, no change expected: `apps/web/src/lib/stream-destinations.ts:79-81` (`resolveStreamTarget`). A saved pick that is not in the live list answers `null`, so with LIVE off (Seazn excluded from the list) a saved Seazn pick resolves to no destination. Pin that with a test; never add a fallback there.
- Test: `src/server/usecases/__tests__/stream-targets.test.ts`, `src/server/usecases/__tests__/stream-codes.test.ts` (or the file that covers `fixtureStreamTarget`), `src/server/usecases/__tests__/court-streams.test.ts`

**Interfaces — Produces:**

- `SEAZN_TARGET_FIXED = "seazn_destination_fixed"`: the 422 code for patch and remove.
- `SEAZN_UNAVAILABLE = "seazn_unavailable"`: the 422 code when a write or start names a Seazn target while LIVE is off.
- SQL fragment `seaznOrder(on: boolean)` in `stream-targets.ts`. When on it is `order by (kind = 'seazn') desc, created_at, id`. When off it is `kind <> 'seazn'` in the WHERE plus the old order.

- [ ] **Step 1: Write the failing tests.**
  - LIVE on: `listStreamTargets` returns the Seazn row first for an org with two older pasted keys, and `fixtureStreamTarget` with no saved pick answers it with `source: "default"`.
  - LIVE off: neither function returns it, and the pick is the oldest pasted key (the regression).
  - LIVE off with a fixture whose saved pick is the Seazn row (`target_chosen` true): `fixtureStreamTarget` answers `null`, not any external destination, even when the org has a YouTube connection (Review Focus 2, spec anti-goal).
  - `patchStreamTarget` and `removeStreamTarget` on Seazn give 422 `seazn_destination_fixed`, and the row is unchanged.
  - `holderRows` with a live session on Seazn returns `[]`.
  - Court link create with the Seazn target id gives the existing YouTube-only refusal.
- [ ] **Step 2: Run them and see them fail.** `cd apps/web && npx vitest run src/server/usecases/__tests__/stream-targets.test.ts src/server/usecases/__tests__/court-streams.test.ts <the stream-codes test file> --reporter=json --outputFile=$SCRATCH/t4.json`.
- [ ] **Step 3: Implement.** Then `npm run openapi:gen` (the kind enum and the two refusal codes).
- [ ] **Step 4: Run the Step 2 command again.** Expect PASS. Check that the openapi diff is the kind enum and the codes only. Mutate `holderRows`: drop the new predicate, and the holder test fails.
- [ ] **Step 5: Commit** `feat(stream): Seazn in destination reads and writes`.

### Task 5: Admission of a Seazn session

**Files:**

- Modify: `apps/web/src/server/usecases/stream-sessions/start.ts`:
  - mode: the target's kind is read first, and a `seazn` target sets `body.mode = "composed"` BEFORE `composedRunnerDown` is computed (`:253`), so the composed gate (`admitMode`) judges the mode that will actually run;
  - the destination doors (`:316-340`) are kept and still called; they skip the Seazn target through `pastedTarget` (next bullet) and `holderRows` (Task 4);
  - the secret re-check (`:455-466`, `readTargetSecret`/`checkDestination`) and the earlier `refuseUnreadableTarget` are skipped for a `seazn` target.
- Modify: `apps/web/src/server/usecases/stream-sessions/holders.ts:60-61` (`pastedTarget`): a `kind = 'seazn'` target is not pasted (`x.youtube_connection_id is not null or x.kind = 'seazn'`). The calls stay, so the same-fixture half of `tearDownPriorMachines` (`:103`) and `releasePriorOutputs` (`:153`) still destroys a previous composed Machine of this fixture, while another fixture's Seazn session is never touched.
- Modify: `apps/web/src/server/usecases/stream-sessions/refusals.ts` (the two new refusals)
- Modify: `apps/web/src/server/usecases/capture-phone.ts:807-834` (`phoneStartRefusal`): `seazn_unavailable` → `noDestination(...)`; `seazn_video_unconfigured` → `CaptureRefusalError(503, "unavailable", …)`; `composed_unavailable` stops being a thrown caller bug and maps to `CaptureRefusalError(503, "unavailable", …)`, because a Seazn target now makes a phone start composed whatever `startModeFor` resolved.
- Modify: `apps/web/src/server/usecases/stream-auto.ts:32-57` (`autoStartRefusalOf`): the same three codes, as the retryable "unavailable" family it already uses for `composed_unavailable`.
- Test: `apps/web/src/server/usecases/__tests__/stream-sessions.test.ts` (new `describe("Seazn destination")` block, or a sibling `stream-sessions.seazn.test.ts` using `_session-rig.ts`, given the file is 517 KB)

**Interfaces:**

- Consumes: `seaznHostedLive`, `seaznVideoOrigins`, `streamSigningKey` (Task 2).
- Produces:
  - `isSeaznTarget(tx, orgId, targetId): Promise<boolean>` in `destination.ts`.
  - Refusals: 422 `seazn_unavailable` (LIVE off), and 503 `seazn_video_unconfigured` (LIVE on with no origins or no signing key under a real driver), both raised before any provider call.

  Plan decision: coerce the mode rather than refuse passthrough. The phone's start and the automatic start read the fixture's stored `stream_mode`, and refusing would strand them. `composedUnavailable()` still refuses first, by name.

- [ ] **Step 1: Write the failing tests.** Use the fakes (`relay/fakes.ts`).
  - A passthrough create on Seazn makes a session with `mode = 'composed'` and `destination_kind = 'seazn'`, no `youtube_broadcasts` row, and no `readTargetSecret` call (spy).
  - A second fixture of the same org starts on Seazn while the first is live, so both are admitted (Review Focus 1).
  - LIVE off gives 422 `seazn_unavailable` with zero provider calls and no row.
  - LIVE on with no signing key under a non-fake driver mode gives 503 `seazn_video_unconfigured` with zero provider calls.
  - One credit is consumed at live, the same count a composed YouTube session consumes.
  - On a deployment with no compositor runner, a phone start on Seazn (stored mode passthrough) is refused `composed_unavailable` before any provider call, and `phoneStartRefusal` maps it to 503 `unavailable` (no throw). `autoStartRefusalOf` maps it too.
  - `phoneStartRefusal` and `autoStartRefusalOf` each map `seazn_unavailable` and `seazn_video_unconfigured` (one test per code per mapper).
  - A Seazn restart of the same fixture whose previous composed session left an undestroyed Machine: `tearDownPriorMachines` destroys it. Another fixture's live Seazn Machine is untouched.
  - Regression: a pasted-key start and a YouTube start produce the same provider-call sequence as before (assert against the recorded call list).
- [ ] **Step 2: Run them and see them fail.** `cd apps/web && npx vitest run src/server/usecases/__tests__/stream-sessions.seazn.test.ts --reporter=json --outputFile=$SCRATCH/t5.json`.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run the Step 2 command again.** Expect PASS. Then run the scoped regression: `stream-sessions.test.ts` and `relay-sweep.test.ts`. Mutate `pastedTarget` back to its old predicate, and the two-matches test fails.
- [ ] **Step 5: Commit** `feat(stream): admit Seazn sessions as composed with no external destination`.

### Task 6: No output, signed programme input

**Files:**

- Modify: `apps/web/src/server/relay/domain/session.ts`:
  - `Session` gains `destination: "external" | "seazn"`;
  - `provisioned` (`:398-403`) emits `[]` instead of `[{ type: "add_output" }]` when `destination === "seazn"`.
- Modify: `apps/web/src/server/usecases/stream-sessions/session-row.ts` (map `destination_kind = 'seazn'` to `"seazn"`, everything else to `"external"`)
- Modify: `apps/web/src/server/usecases/stream-sessions/provision.ts:35-36,64-67` (the programme create passes `access`, and `fixture_stream_inputs.access` is written in the same statement that stores the input's credentials, never updated afterwards)
- Modify: `apps/web/src/server/relay/ports.ts`:
  - `IngestCreateSpec` gains `access?: { signed: true; allowedOrigins: string[] }`;
  - `InputSwitchMeta` gains `access?`, the value READ from `fixture_stream_inputs.access`, never from env. So an env change to `SEAZN_VIDEO_ORIGINS` can never alter `recording` on an existing input (`ingest-cf.ts:10-15`).
- Modify: `apps/web/src/server/relay/ingest-cf.ts`:
  - `createLiveInput :270-300`: `recording` becomes `liveInputRecording(spec.access)`;
  - the read-back compares `requireSignedURLs`/`allowedOrigins`;
  - `setInputEnabled :499-516`: re-sends `liveInputRecording(meta.access)` and verifies the echo.
- Modify: `apps/web/src/server/relay/fakes.ts` (the fake keeps `access` per input; `inputAccess(inputId)` lets tests read it)
- Callers: the only production caller of `setInputEnabled` is `port-effects.ts:180`, and it switches the CAMERA (unsigned, no `access`). No programme input is switched today. The adapter refuses a `role: "programme"` call whose meta has no `access` key at all (`access: null` is the explicit unsigned answer read from the row), so a future caller cannot send an unsigned body to a signed input by forgetting the field.
- Modify: `apps/web/src/server/relay/__tests__/ingest-cf.test.ts:1144-1148`. The pin that `recording: LIVE_INPUT_RECORDING` appears exactly twice becomes: `recording: liveInputRecording(` appears exactly twice (create and PUT), `liveInputRecording`'s body spreads `LIVE_INPUT_RECORDING`, and the one-`mode:`-literal assertion is unchanged.
- Test: `relay/domain/__tests__/session.test.ts`, `relay/__tests__/ingest-cf.test.ts`, `relay/__tests__/fakes.test.ts`, `usecases/__tests__/stream-sessions.seazn.test.ts`

**Interfaces — Produces:**

- `liveInputRecording(access?: IngestCreateSpec["access"]): typeof LIVE_INPUT_RECORDING & { requireSignedURLs?: true; allowedOrigins?: string[] }`, exported from `ingest-cf.ts`.
- `seaznAccess(): { signed: true; allowedOrigins: string[] }`, in `destination.ts`. It throws if the origins are null; admission has already refused that case.

- [ ] **Step 1: Write the failing tests.**
  - Domain: `decide(provisioned)` on a Seazn session gives `effects: []`, and on an external one gives `[{type:"add_output"}]`. Sweep both modes × both destinations.
  - ingest-cf, using the existing mocked-fetch harness:
    - the programme create body for Seazn carries `recording.requireSignedURLs === true` and `allowedOrigins === ["seazn.club"]`;
    - the camera create body carries neither;
    - an echo missing `requireSignedURLs` throws `/settings were not applied/`;
    - `setInputEnabled(…, { access })` re-sends both;
    - `setInputEnabled(…, { role: "programme" })` with no `access` key throws before any fetch.
  - Usecase:
    - a Seazn session reaches `live` on the fake with `output_uid` null and no `add_output` row in `stream_provider_calls`;
    - a `target_rejected` never fires across ten ticks (the tick's existing `outputState` read on the programme input answers with no output, which decides nothing; no tick change is made);
    - `fixture_stream_inputs.access` is set on the programme row and null on the camera row, and no statement in `src/server` updates it (grep test).
  - Regression: an external composed session still adds exactly one output on the programme input.
- [ ] **Step 2: Run them and see them fail.** `cd apps/web && npx vitest run src/server/relay/domain/__tests__/session.test.ts src/server/relay/__tests__/ingest-cf.test.ts src/server/relay/__tests__/fakes.test.ts src/server/usecases/__tests__/stream-sessions.seazn.test.ts --reporter=json --outputFile=$SCRATCH/t6.json`.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run the Step 2 command again.** Expect PASS. Run `runner.test.ts` and `port-boundary.test.ts` scoped. Mutate the `provisioned` branch, and the domain test fails.
- [ ] **Step 5: Commit** `feat(stream): Seazn sessions publish to a signed programme input with no output`.

### Task 7: Sign Cloudflare playback

**Files:**

- Create: `apps/web/src/server/video/cf-playback.ts`
- Test: `apps/web/src/server/video/__tests__/cf-playback.test.ts`

**Interfaces — Produces:**

- `signLivePlayback(inputUid: string, now: Date): Promise<{ src: string; expiresAt: string }>`. Its claims are `{ sub: inputUid, kid, exp: now + SEAZN_LIVE_TOKEN_TTL_SECONDS, nbf: now - 30 }`, signed RS256 with `jose` `SignJWT`. `src` is `https://${streamPlaybackHost()}/${token}/manifest/video.m3u8`. Under the fake driver, `src` is `https://playback.fake.invalid/${token}/manifest/video.m3u8`.
- `signDownload(videoUid: string, now: Date, ttlSeconds: number): Promise<string>` for Phase 2. It adds `downloadable: true` and returns `https://<host>/<token>/downloads/default.mp4`.

  Plan decision: self-sign with a key from `POST /stream/keys`, held in env, rather than call `/stream/{uid}/token` per viewer. It costs no API call per page view and no rate-limit exposure.

- [ ] **Step 1: Write the failing tests.**
  - Verify the token with the matching public key: `sub`, `kid`, `exp - iat === 3600`.
  - The URL holds no `?` (the token is a path segment, never a query).
  - The error message for a missing key does not contain the PEM (assert that no substring of the PEM appears in `String(err)`).
- [ ] **Step 2: Run them and see them fail.** `cd apps/web && npx vitest run src/server/video/__tests__/cf-playback.test.ts --reporter=json --outputFile=$SCRATCH/t7.json`.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run the Step 2 command again.** Expect PASS.
- [ ] **Step 5: Commit** `feat(stream): signed Cloudflare playback URLs`.

### Task 8: Public video read and route

**Files:**

- Create: `apps/web/src/server/video/seazn-video.ts`
- Create: `apps/web/src/app/api/v1/public/fixtures/[id]/video/route.ts`, modelled on `realtime-token/route.ts` (`publicRateLimit`, `v1`, `reply`)
- Modify: `apps/web/src/server/api-v1/schemas/` (the public resource group; add `PublicFixtureVideo`) and the openapi registration
- Test: `apps/web/src/server/video/__tests__/seazn-video.test.ts`, `apps/web/src/app/api/v1/public/fixtures/[id]/video/route.test.ts`

**Interfaces — Produces:**

- `type PublicFixtureVideo = { live: { src: string; expiresAt: string } | null; replay: { partNo: number; src: string; expiresAt: string }[] }`. `replay` stays `[]` until Task 19.
- `seaznFixtureVideo(fixtureId: string, now: Date): Promise<PublicFixtureVideo>`. The fixture must be readable through `public_fixtures_v`, the same redaction `replayParts` relies on (`server/youtube/parts.ts:38`); if not, it returns `{live:null, replay:[]}`. `live` is set only when the fixture's latest session has `destination_kind = 'seazn'` and `state = 'live'`; `src` is signed for its programme input uid (`readFirstInput(tx, sid, "programme")`). LIVE off returns `{live:null, replay:[]}`.
- `seaznFixtureVideoForOrg(orgId, fixtureId, now)`: the same answer, org-scoped, for Match Day and the organiser panel. It covers private competitions (spec G5).
- `GET /api/v1/public/fixtures/{id}/video` returns 200 `PublicFixtureVideo` with `Cache-Control: private, no-store`, so a signed URL is never cached at the edge.

- [ ] **Step 1: Write the failing tests.**
  - A Seazn live session gives `live.src` matching `/^https:\/\/playback\.fake\.invalid\/[^/?]+\/manifest\/video\.m3u8$/`.
  - Each of these gives `live: null`: state `warming`, `ending` or `completed`; a YouTube session; a private competition through the public read. The org read of the private one is set.
  - The route answers `no-store` and hits the rate limit like its sibling.
  - LIVE off gives `live: null` for a live Seazn session.
- [ ] **Step 2: Run them and see them fail.** `cd apps/web && npx vitest run src/server/video/__tests__/seazn-video.test.ts "src/app/api/v1/public/fixtures/[id]/video" --reporter=json --outputFile=$SCRATCH/t8.json`.
- [ ] **Step 3: Implement.** Then run `npm run openapi:gen`.
- [ ] **Step 4: Run the Step 2 command again.** Expect PASS.
- [ ] **Step 5: Commit** `feat(stream): public Seazn video read`.

### Task 9: Seazn player on the public match page

**Files:**

- Modify: `apps/web/package.json`: add `hls.js`, pinned to the exact current version (`npm view hls.js version`, no caret).
- Create: `apps/web/src/components/public-site/match-centre/seazn-player.tsx` (client: hls.js with `enableWorker: false`, and native HLS when `video.canPlayType("application/vnd.apple.mpegurl")`)
- Create: `apps/web/src/components/public-site/match-centre/seazn-video-island.tsx` (client: fetches the Task 8 route)
- Create: `apps/web/src/components/public-site/match-centre/seazn-video-schedule.ts` (pure: when to fetch next)
- Modify: `apps/web/src/app/(public)/live/[orgSlug]/[competitionSlug]/[divisionSlug]/fixtures/[fixtureId]/page.tsx:265,472`. When `seaznVideoPlan(fixtureId)` answers `"seazn"`, the page mounts `<SeaznVideoIsland fixtureId>` in the `replay` slot instead of `<ReplayEmbed>`. Every other fixture keeps today's slot byte for byte (spec §5.1).
- Create: `apps/web/src/server/video/seazn-video-plan.ts`: `seaznVideoPlan(fixtureId: string): Promise<"seazn" | "external">`, decided from the fixture's OWN facts, never from `fixtureStreamTarget` (`stream-codes.ts:496-509` answers `{id,label,source}` with no kind):
  - LIVE off → `external`;
  - any session of the fixture with `destination_kind = 'seazn'`, or any non-deleted `fixture_video_replays` row (Phase 2) → `seazn`;
  - any other session, or the fixture decided → `external`;
  - no session at all and not decided → `seazn` only when the fixture's resolved target row has `kind = 'seazn'` (saved, or the org's default). The island then renders nothing until the route answers live.

  Plan decision: the last arm is the one use of the default pick, and only for a fixture that has never streamed and is not over. A viewer who opens the page before kick-off still gets the player at live without reloading (Review Focus 3), and a past YouTube fixture with no saved choice can never flip, because it has sessions.

- Modify: `apps/web/src/proxy.ts:91`: `connect-src` and a new `media-src 'self' blob:` add `https://${streamPlaybackHost()}` (and in Phase 2 the Bunny CDN host).
- Modify: `src/dictionaries/{en,es,fr,nl}/public.json`: keys `seaznVideo.live` ("Live"), `seaznVideo.unavailable` ("The video can't play right now"), `seaznVideo.part` ("Part {n}").
- Test: `components/public-site/match-centre/__tests__/seazn-video-schedule.test.ts`, `components/public-site/match-centre/__tests__/seazn-video-island.test.tsx` (SSR markup), `app/(public)/.../fixtures/[fixtureId]/__tests__/page.test.ts`, `apps/web/e2e/public-fixture.spec.ts`, `apps/web/e2e/mobile/public-pages.spec.ts`

**Interfaces — Produces:**

- `nextVideoFetchMs(video: PublicFixtureVideo | null, now: Date): number`:
  - not live and no replay: `30_000`;
  - live: `expiresAt - now - SEAZN_TOKEN_REFRESH_BEFORE_SECONDS*1000`, floored at `30_000`;
  - replay: the earliest part's expiry minus 5 min.
- `<SeaznVideoIsland fixtureId={string} endpoint?: "public" | "org" />`. The default `public` reads `/api/v1/public/fixtures/{id}/video`; `org` reads `/api/v1/fixtures/{id}/video` (Task 11).
- `<SeaznPlayer src={string} title={string} />`. It keeps one `<video>` across `src` changes for the same session, and swaps the source at the current time, so a refreshed token does not restart the picture.
- Plan decision: the player loads through a client island rather than with tokens minted in the server render. The page is ISR (`revalidate = 30`, `page.tsx:174`), and a token baked into cached HTML would be served past its expiry. The island also catches warming turning to live without a reload.

- [ ] **Step 1: Write the failing tests.**
  - Schedule: `null` gives 30 000. Live with an expiry 60 min away gives 55 min (Review Focus 3). Live with an expiry 2 min away gives 30 000.
  - Page: a YouTube fixture renders `ReplayEmbed` and no `data-testid="seazn-video"`. A Seazn fixture renders the island and no YouTube markup (anchor the assertion on `="`).
  - `seaznVideoPlan` with LIVE on: a past YouTube fixture with no saved choice (its org's default now resolves Seazn) answers `external`, and the page renders `ReplayEmbed` with its parts (the blocker regression). An unstarted fixture whose default is Seazn answers `seazn`. A fixture with one Seazn session answers `seazn` even after the org's default changes.
  - Player: rendering `<SeaznPlayer>` with `src` A then `src` B (a token refresh) keeps the same `<video>` element instance (same node; a ref counter of mounts stays at 1), and hls.js `loadSource` is called with B without `destroy()` (spy on a mocked hls.js).
  - e2e, fake driver: pick Seazn and Go live → the public page shows `[data-testid=seazn-player] video` with a `src` or `data-src` on the fake host, with no reload between warming and live. At 320, 768 and 1280: no horizontal scroll.
- [ ] **Step 2: Run them and see them fail.** `cd apps/web && npx vitest run src/components/public-site/match-centre/__tests__/seazn-video-schedule.test.ts src/components/public-site/match-centre/__tests__/seazn-video-island.test.tsx "src/app/(public)/live" --reporter=json --outputFile=$SCRATCH/t9.json`; `npx playwright test e2e/public-fixture.spec.ts e2e/mobile/public-pages.spec.ts` (whole files).
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run both commands again.** Expect PASS. Take screenshots at the three widths and open each one.
- [ ] **Step 5: Commit** `feat(stream): Seazn live player on the match page`.

### Task 10: Organiser picker — Seazn first and pre-selected

**Files:**

- Modify: `apps/web/src/components/v2/fixture-destination-picker.tsx:47` (a `seazn` option: Seazn mark, label `stream.dest.kind.seazn`, a one-line sub "Plays on this match's page")
- Modify: `apps/web/src/components/v2/stream-platform-mark.tsx` (a Seazn mark)
- Modify: `apps/web/src/components/v2/stream-destinations-panel.tsx` (the Seazn row shows with no Rename, Replace key or Remove)
- Modify: `apps/web/src/components/v2/fixture-stream-panel.tsx` (no logic change expected: `serverPick` comes from `fixtureStreamTarget`, which Task 4 already answers with Seazn; verify. The 2,805-line file is not split in this plan.)
- Modify: `src/dictionaries/{en,es,fr,nl}/ui.json`: `stream.dest.kind.seazn` ("Seazn"), `stream.dest.seazn.sub` ("Plays on this match's page"), `streamDest.error.seaznFixed` ("Seazn is always available and can't be changed"), `stream.refusal.seazn_unavailable`, `stream.refusal.seazn_video_unconfigured`
- Test: `components/v2/__tests__/fixture-destination-picker.test.tsx`, `components/v2/__tests__/stream-destinations-panel.test.tsx`, `e2e/streaming-destinations.spec.ts` (`e2e/walkthrough/`), `e2e/mobile/` (the stream-panel area file)

- [ ] **Step 1: Write the failing tests.**
  - The picker lists Seazn first and checked for a fixture with no pick.
  - Picking a pasted key and reloading keeps the pasted key (the server answer).
  - The destinations panel row for Seazn has no `button[name=Remove]`.
  - The `nl` render shows the Dutch strings.
  - e2e: a new org's match panel shows Seazn selected, and Go live starts a session with `destination_kind = 'seazn'`.
- [ ] **Step 2: Run them and see them fail.** Run vitest on the two component tests; run `npx playwright test e2e/walkthrough/streaming-destinations.spec.ts e2e/mobile/` on whole files.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run both again.** Expect PASS. Take screenshots at 320, 768 and 1280.
- [ ] **Step 5: Commit** `feat(stream): Seazn is the preferred destination in the match panel`.

### Task 11: Match Day plays the Seazn live

**Files:**

- Modify: `apps/web/src/lib/match-day/types.ts:83-86` and `apps/web/src/server/api-v1/schemas/fixtures.ts:154`: `live_video` keeps its YouTube shape untouched; a separate `live_seazn: boolean` is added beside it (true while the match's open session is a live Seazn session). The URL is not in the polled board. The preview fetches it through the org-scoped read below, so a polled board never carries a token.
- Modify: `apps/web/src/server/usecases/match-day.ts:845-866` (sets `live_seazn`)
- Create: `apps/web/src/app/api/v1/fixtures/[id]/video/route.ts` (organiser auth; `seaznFixtureVideoForOrg`)
- Modify: `apps/web/src/components/v2/match-day/court-stream-preview.tsx` (`live_seazn` renders `<SeaznVideoIsland fixtureId endpoint="org" />`, with the score line under the picture as today)
- Modify: the `streamPreviewOf` caller and `match-day/view` where `live_video.url` is read
- Test: `components/v2/match-day/__tests__/match-day-ssr.test.tsx`, `server/usecases/__tests__/match-day*.test.ts` (the file covering `live_video`), `e2e/match-day.spec.ts`, `e2e/mobile/match-surfaces.spec.ts`

- [ ] **Step 1: Write the failing tests.**
  - A Seazn live match on a playing court gives `live_seazn: true` and `live_video: null`, and the board JSON contains no `playback.fake.invalid`.
  - A YouTube one is unchanged.
  - e2e: a Match Day court with a live Seazn match shows `[data-testid=seazn-player]`. At 320 there is no horizontal scroll.
- [ ] **Step 2: Run them and see them fail.**
- [ ] **Step 3: Implement.** Then run `npm run openapi:gen`.
- [ ] **Step 4: Run them again.** Expect PASS.
- [ ] **Step 5: Commit** `feat(match-day): Seazn live preview`.

### Task 12: Sweep hold for Seazn recordings (ships with Phase 1)

Controller ruling (2026-11-20): every `destination_kind = 'seazn'` recording is held past 3 days **regardless of `SEAZN_HOSTED_REPLAY`**, so Phase 1 never loses a replay that Phase 2 will later move. Cloudflare's 30-day `deleteRecordingAfterDays` stays the backstop.

**Files:**

- Modify: `apps/web/src/server/usecases/relay-sweep.ts:507-560` (step 4, RETENTION)
- Modify: `SweepResult` (`:49`): add `seaznHeld: number` and `seaznHeldPastPromise: number`
- Test: `apps/web/src/server/usecases/__tests__/relay-sweep.test.ts` (new describe), `lib/__tests__/relay-sweep-workflow.test.ts` if it pins the result keys

**Interfaces:**

- `retentionPlan` stays pure and unchanged.
- The sweep removes from `ownedVideos` every video whose `inputId` is the programme input of a session with `destination_kind = 'seazn'`, whatever the flags. Their deletion is the mover's (Task 18) once Bunny has a playable copy, or Cloudflare's own at 30 days. Inputs that still name a held video are deferred by the existing rule (`:552-555`).
- For each held video older than `RECORDING_RETENTION_DAYS` with no `seazn_held_alerts` row and no `playable` replay: one `captureError(new Error("relay sweep: a Seazn recording past 3 days has not reached Bunny"), { route: "relay.sweep.seazn_held", extra: { sessionId, cfVideoId } })`, then an insert into `seazn_held_alerts` (V538). That is one alert per recording, ever, with or without a replay row.
- Held recordings count against the Cloudflare storage block. Admission and the sweep already read live usage (`storageHeadroomMinutes`), so a full block refuses new starts by the existing rule; nothing new is added for it.

- [ ] **Step 1: Write the failing tests.**
  - REPLAY off, LIVE on: a 4-day-old Seazn programme video is not deleted, its input is not deleted, `seaznHeld 1`, `captureError` is called once, and a second pass makes no second call (the ruling).
  - The same with REPLAY on and no replay row: also held.
  - A 4-day-old YouTube programme video: deleted (the regression).
  - A camera recording of a Seazn session is still deleted at the end of the session (step 2, `:349-362`, unchanged).
- [ ] **Step 2: Run them and see them fail.** `cd apps/web && npx vitest run src/server/usecases/__tests__/relay-sweep.test.ts --reporter=json --outputFile=$SCRATCH/t12.json`.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run the Step 2 command again.** Expect PASS. Mutate the hold filter by removing the destination predicate, and the YouTube test fails.
- [ ] **Step 5: Commit** `feat(stream): the sweep holds Seazn recordings past 3 days`.

### Task 13: Phase 1 smoke and walkthrough

**Files:**

- Create: `scripts/smoke/suites/seaznHosted.ts`, registered as `streamTargets.ts` is. It covers the Seazn row present and first, the start refused while LIVE is off, and the public video route `no-store`.
- Create: `apps/web/e2e/walkthrough/seazn-hosted.spec.ts`. On the fake driver, organiser and spectator: Seazn pre-selected → Go live → the spectator sees the player → Stop → the player goes and the page shows its ended state. The database has 0 `youtube_broadcasts` rows and 0 `add_output` provider calls for the fixture.

- [ ] **Step 1: Write both.**
- [ ] **Step 2: Run them.** `npx playwright test e2e/walkthrough/seazn-hosted.spec.ts`, and the smoke suite by its runner. Expect PASS.
- [ ] **Step 3: Run the scoped regression.** Run every vitest path from Tasks 2–12 in one JSON run, check that `numTotalTests` equals the per-task sum, then `npx playwright test e2e/walkthrough/stream-relay.spec.ts e2e/walkthrough/streaming-destinations.spec.ts` on whole files.
- [ ] **Step 4: Commit** `test(stream): Seazn live smoke and walkthrough`.

---

# Phase 2 — Replay on Bunny (`SEAZN_HOSTED_REPLAY`)

### Task 14: Probe Bunny Stream

The docs (checked 2026-11-20) show that `POST /library/{id}/videos/fetch` returns only `{success,message,statusCode}`, not the new guid. They do not show the Create Collection endpoint, and they do not confirm that CDN token authentication covers the Stream delivery host.

**Files:**

- Create: `apps/web/src/server/video/__tests__/bunny.live.test.ts`, gated by `BUNNY_LIVE_PROBE=1`
- Modify: `docs/superpowers/specs/2026-11-20-seazn-hosted-probes.md`

- [ ] **Step 1: Write the probe.**
  - `POST /library/{lib}/collections {name}` returns a `guid`.
  - Fetch a public test MP4 with `title = "probe:<uuid>"` and `collectionId`.
  - `GET /library/{lib}/videos?search=probe:<uuid>&collection=<guid>` finds exactly one item. Poll `GET /videos/{guid}` until `status === 4`.
  - The HLS playlist at `https://{BUNNY_CDN_HOST}/{guid}/playlist.m3u8` gives 403 unsigned and 200 with a directory token (`token_path=/{guid}/`). One segment URL from that playlist also gives 200.
  - The fetch is repeated with a Cloudflare signed `downloads/default.mp4` URL from Task 1's account.
  - `DELETE /videos/{guid}` answers 200.
- [ ] **Step 2: Run it and record each result.** If the search cannot find the fetched video, raise it before Task 16. The fallback recorded in the doc: create the video (`POST /videos` returns a guid) and stream the Cloudflare MP4 through the server with `PUT /videos/{guid}`.
- [ ] **Step 3: Commit** `test(stream): live probe for Bunny Stream`.

### Task 15: The `ReplayHost` port, its fake and config

**Files:**

- Create: `apps/web/src/server/video/replay-ports.ts`
- Create: `apps/web/src/server/video/replay-fake.ts`
- Create: `apps/web/src/server/video/replay-driver.ts`
- Modify: `apps/web/src/server/relay/config.ts`. It reads `REPLAY_DRIVER` (`fake` | `bunny`, where unset under the fake relay driver is `fake`), `BUNNY_STREAM_LIBRARY_ID`, `BUNNY_STREAM_API_KEY`, `BUNNY_CDN_HOST` and `BUNNY_TOKEN_KEY`. `bunnyConfig()` throws naming the missing variable and never echoes a value.
- Modify: `apps/web/src/server/usecases/stream-sessions/deps.ts` (`SessionDeps` gains `replay?: ReplayHost`, like `youtube?`)
- Test: `apps/web/src/server/video/__tests__/replay-fake.test.ts`, `relay/__tests__/config.test.ts`

**Interfaces — Produces:**

```ts
export type ReplayState = "processing" | "playable" | "failed" | "absent";
export interface ReplayHost {
  ensureCollection(orgId: string): Promise<string>; // collection id; idempotent by name `org:<orgId>`
  fetchFromUrl(a: {
    collectionId: string;
    title: string;
    url: string;
  }): Promise<void>;
  findByTitle(collectionId: string, title: string): Promise<string[]>; // guids with exactly this title, oldest first
  state(
    videoId: string,
  ): Promise<{ state: ReplayState; lengthSeconds: number | null }>;
  remove(videoId: string): Promise<"deleted" | "absent">;
  signedPlaylist(videoId: string, now: Date, ttlSeconds: number): string; // pure, no call
  signedDownload(videoId: string, now: Date, ttlSeconds: number): string; // pure; the MP4 fallback file, same token scheme
  watchMinutes(videoId: string, from: Date, to: Date): Promise<number>; // Phase 3
}
```

- Bunny `status` maps as follows: 4 → `playable`; 5 and 6 → `failed`; 0–3, 7 and 8 → `processing`; 404 → `absent`.
- `REPLAY_TOKEN_TTL_SECONDS = 3600`.
- Plan decision: one Bunny collection per org, named `org:<orgId>`, with its id cached in `org_video_collections` (Task 17). The spec recommends it, and it makes an org's replays listable and deletable as a set.
- Plan decision: the Bunny keys are env secrets read through `config.ts`, like the Cloudflare token. They are never stored in the database.

- [ ] **Step 1: Write the failing tests.**
  - The fake's `fetchFromUrl` then `findByTitle` returns one guid; two fetches of one title return two, oldest first.
  - The state machine is `processing` → `playable` after `fake.advance(guid)`, and `fake.fail(guid)` gives `failed`.
  - A repeated `ensureCollection` returns the same id.
  - `bunnyConfig({})` throws `/BUNNY_STREAM_API_KEY/`, and the message contains no value.
- [ ] **Step 2: Run them and see them fail.** `cd apps/web && npx vitest run src/server/video/__tests__/replay-fake.test.ts src/server/relay/__tests__/config.test.ts --reporter=json --outputFile=$SCRATCH/t14.json`.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run the Step 2 command again.** Expect PASS. Extend `port-boundary.test.ts`: `replay-ports.ts` names no Bunny vocabulary.
- [ ] **Step 5: Commit** `feat(stream): ReplayHost port and fake`.

### Task 16: The Bunny adapter

**Files:**

- Create: `apps/web/src/server/video/replay-bunny.ts`
- Test: `apps/web/src/server/video/__tests__/replay-bunny.test.ts` (mocked fetch, like `ingest-cf.test.ts`)

**Interfaces:**

- Consumes: the `ReplayHost` port (Task 15) and `bunnyConfig()`.
- Produces: `class BunnyReplayHost implements ReplayHost`.
  - Base URL `https://video.bunnycdn.com/library/{libraryId}`, with the `AccessKey` header.
  - `signedPlaylist` returns `https://{cdnHost}/bcdn_token={token}&expires={exp}&token_path=%2F{guid}%2F/{guid}/playlist.m3u8`, with `token = base64url(HMAC-SHA256(BUNNY_TOKEN_KEY, "/{guid}/" + exp))`. That is the formula from `bunny.net/docs/cdn-token-authentication`; Task 14's probe confirms it, and the probe's result wins if they differ.
  - Each call is recorded through the same redaction floor as `ingest-cf.ts` (`sanitise.ts`), so the AccessKey is never written.
  - The `fetchFromUrl` body's `url` is a signed Cloudflare download (its token is a path segment). Before the call is recorded in `stream_provider_calls`, the token segment is replaced by `[signed]`, and the `title` is kept.

- [ ] **Step 1: Write the failing tests.**
  - `fetchFromUrl` POSTs `/videos/fetch?collectionId=c1` with body `{url,title}`.
  - `state` maps 4, 5, 3 and 404 as Task 15 states.
  - `findByTitle` sends `search=` and returns the exact title match only, ignoring a prefix match.
  - The `AccessKey` value is absent from every thrown message and from every recorder payload.
  - The recorded `fetchFromUrl` payload holds `https://<host>/[signed]/downloads/default.mp4` and no substring of the token passed in; a thrown fetch error holds no token either.
  - `signedPlaylist` matches a vector computed by hand in the test from the documented formula.
- [ ] **Step 2: Run them and see them fail.**
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run them again.** Expect PASS.
- [ ] **Step 5: Commit** `feat(stream): Bunny Stream adapter`.

### Task 17: Migration V539 — replays

**Files:**

- Create: `db/migration/deltas/V539__seazn_replays.sql`
- Test: `apps/web/src/server/relay/__tests__/seazn-replays-migration.test.ts`

**DDL:**

- `org_video_collections (org_id uuid primary key references organizations(id) on delete restrict, collection_id text not null, created_at timestamptz not null default now())`.
- `fixture_video_replays`:
  - `id uuid pk`;
  - `org_id uuid not null references organizations(id) on delete restrict`;
  - `session_id uuid not null references fixture_stream_sessions(id) on delete restrict`;
  - `fixture_id uuid null references fixtures(id) on delete set null`;
  - `cf_video_id text not null unique`, `recorded_at timestamptz not null`;
  - `part_no int not null`, assigned once at discovery (the fixture's highest `part_no` + 1, in `recorded_at` order within a batch) and never changed, with `unique (fixture_id, part_no)`. A part keeps its number whatever becomes playable first;
  - `state text not null check (state in ('found','downloading','fetching','encoding','playable','failed','deleted'))`, `state_at timestamptz not null default now()` (moved by every state write);
  - `bunny_video_id text null`, `length_seconds int null`;
  - `attempts int not null default 0`, `next_attempt_at timestamptz not null default now()`;
  - `cf_deleted_at timestamptz null`, `playable_at timestamptz null`, `bunny_cleaned_at timestamptz null` (a deleted row whose Bunny copies have all been removed);
  - `deleted_at timestamptz null`, `deleted_by uuid null`, `deleted_reason text null check (deleted_reason in ('organiser','org_deleted'))`;
  - `created_at timestamptz not null default now()`.
- Index on `(state, next_attempt_at)` where `state not in ('playable','deleted')`. Index on `(fixture_id, recorded_at)`.
- Check: `bunny_video_id is not null or state in ('found','downloading','fetching','failed','deleted')`.
- `fixture_stream_inputs` gains `replays_discovered_at timestamptz null`: discovery's mark that it has listed this programme input's finished recordings for good.
- RLS on both tables follows V430: enable + force, no policy, no grant.
- View `public_fixture_seazn_replays_v (fixture_id, part_no, bunny_video_id)`. It keeps `state = 'playable'` rows with their stored `part_no` (gaps allowed while a part is still processing), under the same WHERE redaction as `public_fixture_youtube_parts_v`. Not granted to `app_user`.

  Plan decision: `on delete restrict` on `org_id`. No product path hard-deletes an organisation (`extra-orgs.ts:301`), and a cascade would drop the Bunny ids that Task 24 needs to delete the videos.

- [ ] **Step 1: Write the failing tests.**
  - A replay row with `state 'playable'` and no `bunny_video_id` fails 23514.
  - A duplicate `cf_video_id` fails 23505.
  - Deleting an org with a replay fails 23503.
  - The view shows two playable rows as parts 1 and 2; with part 1 still `encoding`, part 2 shows as 2 (not renumbered to 1); a private competition has no row.
  - A second row with the same `(fixture_id, part_no)` fails 23505.
  - `rls-static.test.ts` lists both tables.
- [ ] **Step 2: Run them, write V539 and apply it locally, then run them again.** Expect FAIL first, then PASS.
- [ ] **Step 3: Commit** `feat(db): V539 Seazn replays`.

### Task 18: Move recordings to Bunny

**Files:**

- Create: `apps/web/src/server/video/domain/replay-move.ts` (pure: the next step for a row)
- Create: `apps/web/src/server/usecases/seazn-replays.ts` (`discoverSeaznRecordings`, `moveSeaznRecordings`)
- Modify: `apps/web/src/server/relay/ports.ts`, `ingest-cf.ts` and `fakes.ts`: `IngestProvider` gains `createDownload(videoId): Promise<"ready" | "inprogress">` (`POST /stream/{uid}/downloads`, then read `default.status`; idempotent). The download goes with the video when `deleteVideo` runs.
- Modify: `apps/web/src/app/api/cron/stream-tick/route.ts`, adding a third pass `seazn` after the session pass. It never throws and answers `{ discovered, moved, playable, failed, deferred }`.
- Modify: `apps/cron-worker/src/schedule.ts:172`: `failureCounts` gains `"data.seazn.failed"`; extend `drift.test.ts` so it finds the field.

  Plan decision: the pass runs INSIDE the tick's existing 45 s (`STREAM_TICK_BUDGET_MS`, `tick.ts:202`), never after it. It gets `min(SEAZN_MOVE_BUDGET_MS = 8_000, what is left of the 45 s)` and starts no provider call with under 2 s left, so the whole firing still stops starting work at 45 s, inside the Worker's 60 s. When the session pass uses the whole budget, the seazn pass defers to the next minute (`deferred`).

- Test: `video/domain/__tests__/replay-move.test.ts`, `usecases/__tests__/seazn-replays.test.ts`, `app/api/cron/stream-tick/route.test.ts`

**Interfaces — Produces:**

- `nextReplayStep(row: ReplayRow, now: Date): ReplayStep`, a transition table:
  - `found` → `create_download`;
  - `downloading`: `create_download` again until `ready`, then `fetch`;
  - `fetching` → `find_guid`, and `encoding` once found. A `fetching` row whose `state_at` is older than `SEAZN_FETCH_STALE_MINUTES = 120` with no guid found goes back to `downloading`, and the fetch is sent again.

    Plan decision: 120 min is well above a 3 h 1080p MP4 fetch-and-ingest, and short enough that a lost fetch costs one retry within the day;

  - `encoding` → `poll_state` (`playable` sets `playable_at`, `failed` sets state `failed`);
  - `playable` with `cf_deleted_at` null → `delete_cf`;
  - `deleted` with `bunny_cleaned_at` null → `cleanup`: `findByTitle` and `remove` every match (a fetch in flight when the organiser deleted can land later), delete the Cloudflare copy if still there, then set `bunny_cleaned_at`. It repeats until a `findByTitle` after `SEAZN_FETCH_STALE_MINUTES` past `deleted_at` finds none.
  - A failure sets `attempts+1` and `next_attempt_at = now + min(2^attempts, 60) minutes`.
  - `failed` retries from `found` while `now - recorded_at < 30 days`.
- `discoverSeaznRecordings(deps, now)`: for each programme input of a Seazn session that ended more than `FINALISATION_GRACE_SECONDS` ago and whose `replays_discovered_at` is null, calls `listInputVideos(programme)` and inserts a `found` row per video (`on conflict (cf_video_id) do nothing`, `part_no` assigned as V539 says). When every listed video is finished (`inProgress === false`), it sets `replays_discovered_at`, and the input is never listed again.
- `moveSeaznRecordings(deps, { now, budgetMs })`. Concurrency and idempotency rules:
  - Rows are claimed in a short transaction, `select … where next_attempt_at <= now and state not in ('playable') … for update skip locked limit 10` (plus deleted rows awaiting cleanup), so two overlapping ticks never take one row.
  - The next state is written and committed BEFORE the provider call (`found → downloading`, `downloading → fetching` before `fetchFromUrl`), so a crash after the call is resumed by `find_guid` or the stale timeout, never by a blind second fetch.
  - Every state update is conditional: `update … set state = $next, state_at = now() where id = $id and state = $expected`. Zero rows updated means another actor moved it (an organiser delete), and the pass drops the row.
  - `findByTitle` returning more than one guid (a re-fetch raced the first) keeps the earliest and `remove`s the rest. The port's `findByTitle` returns `string[]` for this.
  - The Bunny title is `seazn:{sessionId}:{cfVideoId}`. The fetch URL is `signDownload(cfVideoId, now, 6*3600)` (Task 7). `deleteVideo` on Cloudflare runs only from `playable`; `in_progress` leaves `cf_deleted_at` null for the next tick.
- Plan decision: run from the stream tick (prod every minute) rather than from `persist.ts` or the daily sweep. `persist` runs inside the session's row transaction, where provider calls do not belong, and a daily pass would hold every recording on Cloudflare for up to a day for no reason. The tick already has the budget and failure-counter pattern (`endYoutube`).
- Plan decision: Bunny fetches Cloudflare's MP4 download through a signed `downloadable` token. Bunny fetches a file, not an HLS playlist, and the recording is signed (Task 6). Task 14's probe confirms that Bunny accepts the URL.

- [ ] **Step 1: Write the failing tests.**
  - Table sweep: every state × {success, provider throws} gives the expected step or backoff. The sweep reports how many cases it checked, and zero fails.
  - Usecase on the fakes:
    - a stopped and restarted Seazn match (two sessions) yields two rows ordered by `recorded_at` (Review Focus 4);
    - with `fake.fail(guid)`, the Cloudflare video is never deleted and `attempts` grows with backoff (Review Focus 5);
    - `deleteVideo` is never called before `playable`. Assert the call order: `deleteVideo` index > `state→playable` index;
    - REPLAY off gives zero discover and zero move calls;
    - overlap: two `moveSeaznRecordings` runs started together on one `found` row make exactly one `createDownload` and one `fetchFromUrl` call;
    - crash-resume: a throw injected after `fetchFromUrl` leaves the row `fetching`; the next run finds the guid and moves to `encoding` with no second fetch. With the fetch lost (fake drops it), the row goes back to `downloading` only after 120 min (assert at 119 and at 121);
    - duplicate guids: `findByTitle` answering two guids keeps the earlier and removes the other;
    - delete during fetch: an organiser delete lands while the row is `fetching`; the mover's conditional update hits zero rows, and the cleanup step later removes the guid the fetch produced and the Cloudflare copy, then sets `bunny_cleaned_at`;
    - an input with `replays_discovered_at` set is never listed again (zero `listInputVideos` calls on the second run);
    - a YouTube session's recordings are never discovered.
  - Route: the answer carries `seazn` counters, and a throwing pass answers `seazn.failed: 1` while the session pass still runs.
- [ ] **Step 2: Run them and see them fail.**
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run them again.** Expect PASS. Mutate the `playable` guard on `delete_cf`, and the order test fails.
- [ ] **Step 5: Commit** `feat(stream): move Seazn recordings to Bunny`.

### Task 19: Replay on the match page and in the panel

**Files:**

- Modify: `apps/web/src/server/video/seazn-video.ts` (`replay` is filled from `public_fixture_seazn_replays_v`, each part's `src` from `signedPlaylist`; the org read reads the table)
- Modify: `seazn-video-island.tsx` (with no live and a non-empty replay, it renders the parts in `partNo` order, "Part 1", "Part 2" when there are two or more, one `<SeaznPlayer>` at a time, the same part picker shape as `ReplayEmbed`'s)
- Modify: `apps/web/src/proxy.ts` (add `https://${BUNNY_CDN_HOST}` to `connect-src` and `media-src`)
- Create: `apps/web/src/server/video/organiser-replays.ts`: `fixtureSeaznReplays(orgId, fixtureId): Promise<{ id: string; partNo: number; state: "processing" | "playable" | "failed"; lengthSeconds: number | null }[]>`
- Modify: `apps/web/src/components/v2/fixture-stream-panel.tsx` (a Seazn fixture's ended state lists its replays with their state; the strings are in Task 20)
- Test: `seazn-video.test.ts`, `seazn-video-island.test.tsx`, `e2e/walkthrough/seazn-hosted.spec.ts` (extended)

- [ ] **Step 1: Write the failing tests.**
  - Two playable rows give `replay` of length 2 in `recorded_at` order, and each `src` contains `token_path=%2F<guid>%2F`.
  - A `processing` row is not public.
  - A replay of a private competition is absent from the public read and present in the org read.
  - e2e: after Stop, `fake.advance` and a tick, the page shows Part 1 and Part 2 for a stop/restart match.
- [ ] **Step 2: Run them and see them fail.**
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run them again.** Expect PASS. Take screenshots at 320, 768 and 1280.
- [ ] **Step 5: Commit** `feat(stream): Seazn replay player`.

### Task 20: The organiser deletes a replay

**Files:**

- Create: `apps/web/src/app/api/v1/fixtures/[id]/replays/[replayId]/route.ts` (`DELETE`; the editor role, `requireSessionEditor`)
- Modify: `apps/web/src/server/video/organiser-replays.ts`: `deleteSeaznReplay(auth: AuthCtx, fixtureId: string, replayId: string): Promise<{ deleted: true }>`. It is org-scoped, so another org's id gives 404. It takes the row `for update` (waiting for a mover's short claim transaction, never for a provider call), sets `state 'deleted'`, `state_at`, `deleted_reason 'organiser'`, `deleted_by` and commits. That write wins over the mover, whose next conditional update finds zero rows. It then calls `replay.remove` on a known `bunny_video_id` (idempotent on `absent`). Any Bunny copy still in flight, and the Cloudflare copy, are removed by the mover's `cleanup` step (Task 18).
- Modify: `fixture-stream-panel.tsx` (a Delete per part, confirmed by a dialog, and a Download link per playable part from `signedDownload`, 1 h). Spec §5.5 lets the organiser download during the 30-day grace, and the same link serves them at any time.
- Modify: `src/dictionaries/{en,es,fr,nl}/ui.json`: `stream.replay.seazn.title` ("Replay on Seazn"), `stream.replay.seazn.processing` ("Getting the replay ready"), `stream.replay.seazn.failed` ("This replay could not be prepared — Seazn has been told"), `stream.replay.delete` ("Delete replay"), `stream.replay.download` ("Download"), `stream.replay.deleteConfirm` ("Delete this replay for everyone? This can't be undone.")
- Test: `organiser-replays.test.ts`, `route.test.ts`, `e2e/walkthrough/seazn-hosted.spec.ts`

- [ ] **Step 1: Write the failing tests.**
  - The editor deletes, and the public read no longer lists the part.
  - A second delete answers 200 `{deleted:true}` with no second `remove` call.
  - A viewer role gives 403. Another org gives 404.
  - Bunny `remove` throwing still answers 200: the row is `deleted`, and `cleanup` retries the removal (the public read no longer lists it either way).
  - Delete while the row is `fetching`: 200, then the Task 18 cleanup removes the late guid.
  - A playable part's Download `href` carries a token and `expires`, and a `processing` part has no Download.
- [ ] **Step 2: Run them, implement, then run them again.** Expect FAIL first, then PASS. Then `npm run openapi:gen`.
- [ ] **Step 3: Commit** `feat(stream): organiser deletes a Seazn replay`.

### Task 21: Phase 2 smoke and scoped regression

- [ ] **Step 1: Extend `scripts/smoke/suites/seaznHosted.ts`** with a replay row reaching playable on the fake host, and the public route listing it.
- [ ] **Step 2: Run the regression in one JSON run.** It covers every vitest path from Tasks 15–20, then `npx playwright test e2e/walkthrough/seazn-hosted.spec.ts e2e/walkthrough/stream-relay.spec.ts`. Check the counts and paths.
- [ ] **Step 3: Commit** `test(stream): Seazn replay smoke`.

---

# Phase 3 — Cost and lifecycle (`SEAZN_HOSTED_COST`)

### Task 22: Migration V540 — delivered minutes

**Files:**

- Create: `db/migration/deltas/V540__seazn_delivery.sql`. Table `fixture_video_delivery (session_id uuid primary key references fixture_stream_sessions(id) on delete restrict, org_id uuid not null, live_minutes numeric(12,1) not null default 0, replay_minutes numeric(12,1) not null default 0, live_measured_through date null, replay_measured_through date null, updated_at timestamptz not null default now())`, with RLS as in V430.
- Test: `apps/web/src/server/relay/__tests__/seazn-delivery-migration.test.ts`

- [ ] **Step 1: Write the test** (table shape, `numeric(12,1)`, RLS listed), see it fail, write V540, apply it locally, and see it pass.
- [ ] **Step 2: Commit** `feat(db): V540 Seazn delivered minutes`.

### Task 23: Read delivered minutes

**Files:**

- Create: `apps/web/src/server/video/cf-analytics.ts`: `liveMinutesViewed(uids: string[], from: Date, to: Date): Promise<Record<string, number>>`. It POSTs to `https://api.cloudflare.com/client/v4/graphql` with `streamMinutesViewedAdaptiveGroups(filter: { uid_in, date_geq, date_leq }, limit)` and sums `sum.minutesViewed` per uid. Windows longer than 32 days are refused.
- Modify: `replay-bunny.ts` and `replay-fake.ts`. `watchMinutes(videoId, from, to)` reads `GET /library/{lib}/statistics?videoGuid=&dateFrom=&dateTo=` and sums `watchTimeChart` values. The probe settles the unit; the docs do not state it.
- Modify: `apps/web/src/server/relay/config.ts`: `CLOUDFLARE_ANALYTICS_TOKEN` and the account id reuse the relay's account env.
- Modify: the Task 14 probe file and the Task 1 probe file, adding one assertion each: Task 1, whether a live HLS view of a programme input is keyed by the **input uid** or by its live video uid; Task 14, the `watchTimeChart` unit.
- Test: `video/__tests__/cf-analytics.test.ts` (mocked fetch), `replay-bunny.test.ts`

**Plan decision:** query the programme input uid **and** each of its video uids, and sum them. The Cloudflare docs key `uid` as "Video ID (for HLS/DASH)", and whether a live input's live HLS minutes sit under the input uid is unmeasured. Summing both counts the minutes wherever they land; the probe then drops the key that never carries any.

- [ ] **Step 1: Write the failing tests.**
  - The GraphQL body carries `uid_in` with the given uids, and the date filters are ISO dates.
  - A 33-day window throws.
  - A `errors[]` answer throws without echoing the token.
  - Bunny's `watchTimeChart` `{a:60,b:30}` sums to the expected minutes under the probed unit.
- [ ] **Step 2: Run them, implement, then run them again.** Expect FAIL first, then PASS.
- [ ] **Step 3: Commit** `feat(stream): delivered-minute readers`.

### Task 24: The daily measurement pass, staff view and org-deleted grace

**Files:**

- Create: `apps/web/src/server/usecases/seazn-cost.ts`:
  - `measureSeaznDelivery(deps, now)`: for Seazn sessions ended within the last 31 days, live minutes through yesterday. For every replay not deleted, replay minutes through yesterday. Both are upserted into `fixture_video_delivery`.
  - `purgeDeletedOrgReplays(deps, now)`: for orgs with `organizations.deleted_at < now - 30 days`, `replay.remove` each non-deleted replay and set `state 'deleted'`, `deleted_reason 'org_deleted'`.
- Modify: `apps/web/src/server/usecases/relay-sweep.ts`. It adds step 6, `seazn` (COST flag), after retention. Each sub-pass is wrapped like the others and never fails the sweep. It adds `SweepResult.seaznMeasured` and `seaznReplaysPurged`.
- Modify: `apps/web/src/app/admin/orgs/[id]/page.tsx`: a "Seazn video" table (staff only, 1280 only) of the last 50 Seazn sessions, with fixture, ended, live minutes, replay minutes and replay state. English only (`/admin`).
- Test: `usecases/__tests__/seazn-cost.test.ts`, `relay-sweep.test.ts`, `app/admin/orgs/[id]` SSR test if present, `e2e/walkthrough/stream-credits-admin.spec.ts` (extended: the staff table renders)

**Plan decision:** the 30-day clock starts at `organizations.deleted_at` (V021). It is the only "closed or deleted" mark the schema has. No product path sets it today: account deletion soft-deletes the user only (`api/users/me/route.ts:176-185`), and there is no org close. So until such a path exists, a staff member sets it. A credits-only org or an org between subscriptions never starts the clock (spec §5.5).

- [ ] **Step 1: Write the failing tests.**
  - A Seazn session with fake analytics `{inputUid: 12.5, videoUid: 3}` stores `live_minutes 15.5`, and a second run on the same day does not double it (`*_measured_through` is the guard).
  - An org with `deleted_at = now - 31 days` has its replays removed. One at `now - 29 days` keeps them. An active org keeps them.
  - COST off gives zero analytics calls.
  - Analytics throwing leaves the sweep's other counters intact and calls `captureError` once.
  - The admin page shows the row.
- [ ] **Step 2: Run them and see them fail.** `cd apps/web && npx vitest run src/server/usecases/__tests__/seazn-cost.test.ts src/server/usecases/__tests__/relay-sweep.test.ts --reporter=json --outputFile=$SCRATCH/t24.json`.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run them again.** Expect PASS. Mutate the 30-day comparison to `<= now`, and the 29-day test fails. Take a screenshot of the admin page at 1280.
- [ ] **Step 5: Commit** `feat(stream): measure Seazn delivery and purge deleted orgs' replays`.

### Task 25: Phase 3 smoke and final regression

- [ ] **Step 1: Extend `seaznHosted.ts`.** The sweep answer carries `seaznMeasured`, and the admin table loads.
- [ ] **Step 2: Run the regression.** Run every vitest path from all tasks in one JSON run (check `numTotalTests` against the per-task sum and every path under this worktree), then `npx playwright test e2e/walkthrough/seazn-hosted.spec.ts e2e/walkthrough/stream-relay.spec.ts e2e/walkthrough/streaming-destinations.spec.ts e2e/match-day.spec.ts e2e/public-fixture.spec.ts` and all of `e2e/mobile/`. Finish with `npm run openapi:gen && git status --porcelain`.
- [ ] **Step 3: Commit** `test(stream): Seazn cost smoke`.

---

## Operator setup (not code; listed so a flag is never turned on half-configured)

- Phase 1:
  - `POST /accounts/{id}/stream/keys`, then put the result in `STREAM_SIGNING_KEY_ID` / `STREAM_SIGNING_KEY_PEM_B64`;
  - set `SEAZN_VIDEO_ORIGINS`;
  - then `SEAZN_HOSTED_LIVE=true`.
- Phase 2:
  - Bunny library with MP4 fallback on and allowed domains = the Seazn hosts;
  - CDN token authentication on, with its key in `BUNNY_TOKEN_KEY`;
  - `REPLAY_DRIVER=bunny`;
  - then `SEAZN_HOSTED_REPLAY=true`.
- Phase 3:
  - an analytics-read Cloudflare token;
  - then `SEAZN_HOSTED_COST=true`.
