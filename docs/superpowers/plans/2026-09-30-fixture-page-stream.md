# Fixture-page Stream, Directory Destinations and Signal-path Redesign Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Move the stream panel from the division run sheet to the organiser fixture page, make destinations a Directory
tab (YouTube and Twitch only, rename, replace key, archive), name the match that holds a busy destination, warn when
the destination is not receiving, redraw the panel as a Phone ── Seazn ── Destination signal path, and put the Seazn
logo in the three fixture-page QRs.

**Architecture:** Four waves on one branch. Wave S changes the server only: a V427 migration adds `archived_at`, and
`relay/secret-columns.ts` stays the only SQL over `rtmp_enc`. New PATCH and DELETE routes lock the target row that
`createSession` now also locks. The session projection carries `output {state, since}`. Wave P moves the mount (the
fixture page and a shared context loader) with no visual change, then removes the run-sheet mount. Wave D adds the
Directory tab and turns the panel's inline add form into a picker. Wave R adds the pure `chainFor` mapping and the
restyle, then the shared `renderSeaznQr` helper.

**Tech Stack:**
- Next.js 16 app router (`searchParams` is a Promise) and React 19 client islands.
- Tailwind (`max-md:` / `md:hidden` twins).
- Zod v4, with OpenAPI generated through `z.toJSONSchema`.
- postgres.js (`sql.begin`, `tx.savepoint`), and Flyway deltas under `db/migration/deltas/`.
- vitest runs with `environment: "node"`, so there is no DOM.
- Playwright walkthrough project, plus the `qrcode`, `sharp` and `jsqr` devDependencies.

**Spec:** `docs/superpowers/specs/2026-09-30-fixture-page-stream-design.md` and its mockups
`docs/superpowers/specs/2026-09-30-fixture-page-stream-mockups/option-a.html` and `directory.html`. Read them beside
every task. The spec binds; where this plan deviates, the deviation is named in "Premises re-verified" below.

**Worktree:** `/Users/ashokhein/github/seazn.club/.claude/worktrees/fixture-stream`, branch `feat/fixture-page-stream`,
cut from `origin/main` 770bdca07. Every command below starts with `cd` into this path **in the same shell call**
(AGENTS.md: shell cwd resets to the main checkout between calls). `WT` below means this absolute path.

## Execution batches (owner ruling 2026-09-30)

Seven batches. Each batch gets **one implementer and one review**; inside a batch the implementer still commits **once
per task**, in task order, so each commit stays bisectable and each task's own gate and mutations still run.

| Batch | Tasks | Boundary gate (the orchestrator re-runs it, scoped) |
|---|---|---|
| B1 | T1 + T2a + T2b | T1, T2a and T2b scope commands (with `scripts/__tests__/smoke-select.test.ts`); T2a Step 8's walkthroughs, whole; `SMOKE_ONLY=streamTargets` |
| B2 | T3 + T4 | T3 and T4 scope commands, then the **Wave S gate** (end of T4) |
| B3 | T5 + T6 | the **Wave P gate** (T5 Step 13's and T6 Step 6's unit lists together), then T5 Step 19, then T6 Step 6 (walkthroughs and e2e whole) |
| B4 | T7 + T8 | the Wave D gate (end of T8) |
| B5 | T9a + T9b | T9a Step 5 and T9b Step 6, including `mobile.spec.ts` whole; T9b's screenshots |
| B6 | T10 | T10 Step 4, then the owner's real-phone STOP (Step 6) |
| B7 | T11 | T11 is the lane close; it STOPs before any push or PR |

A batch's review runs over the batch's commits (`git diff <batch base>..HEAD`) with this plan's task text as the brief.
Fixes from that review land in the owning task's files as a follow-up commit in the same batch, and the batch gate is
re-run before the next batch starts.

## Global Constraints

**Rulings and product rules (spec §0–§1):**
- P1: the panel lives on the organiser fixture page. On desktop, Stream is a `btn btn-ghost min-h-11` beside the
  hand-over button. On phone, a 44 × 44 icon sits beside ⇄ in the header strip. **Organisers only** (the page-level
  `canEdit` from `requireFixturePage`).
- Who sees Stream: page `canEdit` AND (the org is streaming-entitled OR an active session exists for this fixture).
  **Stop is always reachable.** The console's own `canEdit` prop (`canScore && !frozen`) "is a **different** value and
  must not be reused".
- `openPanel: "handover" | "stream" | null`. Opening one closes the other. `detailsOpen` and the PhoneDisclosures stay
  independent.
- Twins carry these classes: `device-handover` / `fixture-stream` take `max-md:hidden`, and `device-handover-phone` /
  `fixture-stream-phone` take `md:hidden`.
- "Nothing changes at ≥768 except the two header buttons and the panel's new home."
- D1: destinations are managed **only in Directory** (the Streaming tab). The panel has a picker and "Manage
  destinations", which opens `/directory?tab=streaming` in a new tab. There is no inline add form.
- D2:
  - **Remove = archive**, hidden forever: no "show removed" and no restore UI.
  - Re-adding the same key brings the old row back.
  - Remove and Replace key are refused while a match is live **or waiting** on the destination, and the refusal names
    that match.
- D3: live, but the destination has not received for **30 s**. The warning is amber, the stream keeps running and Stop
  stays one tap away. A hard `rejected` still ends the session. There is no auto-end and no refund path.
- D4: "Hand over device" becomes **Remote scoring** (es "Puntuación remota", fr "Score à distance", nl "Scoren op
  afstand"), on both the button (`score.handOverDevice`) and the panel title (`dlink.title`).
- D5: Option A, "Signal path", with **lime** chain lines. **Lime (`--mk-lime` #a3e635) is never used for text.**
- D6: destinations are **YouTube and Twitch only**. LinkedIn is never offered.
- D7: every QR carries the Seazn logo in the centre, at error correction **H**, using `public/logo-square.png`, with
  the same geometry as `scorer-sheet-pdf.ts`. This branch covers three QRs: the stream capture QR, the Remote scoring
  QR and the check-in QR.
- The stream QR renders "at ≥320 px on desktop and full width on a phone"; expect "v22/105 modules at H".
- A real-phone scan is a gate. If the stream QR scans poorly, it alone stays logo-less and the exception is recorded
  in the helper's comment.
- D9: the Phone node takes an optional `phoneStatus` prop. **This branch renders nothing there.**
- D10 (owner, 2026-10-04): every QR rendered by the shared Seazn QR component (`SeaznQrImage`, T10) gets **tap to
  enlarge**. A caption under the QR reads "Tap to enlarge". A **single** tap (never a double tap, which is the
  browser's zoom) opens a full-screen overlay on white, the QR sized to min(viewport width, viewport height) minus a
  16 px gutter, captioned "Turn up brightness if it won't scan". While open it requests a Screen Wake Lock and
  releases it on close; `navigator.wakeLock` is feature-detected, and a missing API or a refused request never throws
  or blocks. It closes on any tap, a 44 px ✕, or Esc; focus moves into it and returns to the QR on close; it is
  `role="dialog"`, `aria-modal`, with an accessible name. It applies to the stream, Remote scoring and check-in QRs in
  this branch. The owner's scan gate covers the normal and the enlarged size.

**Server contract (spec §5):**
- Create order: an active duplicate returns the existing row; otherwise the most recent archived row is un-archived
  with the submitted label and watch link; otherwise a new row is inserted.
- The create body is `{kind: "youtube"|"twitch", label, streamKey, watchUrl?}`, strict, with **no `rtmpUrl`**. The
  server fills `url` from the per-platform preset. For YouTube that is `rtmp://a.rtmp.youtube.com/live2`, which the
  implementer verifies before trusting.
- `checkDestination` still runs as a guard. The DB `kind` CHECK is untouched and there is no data migration. Stored
  legacy kinds keep listing and streaming.
- Label is 1–80 characters.
- `keyHint` is the last 3 characters, or `null` when the key is shorter than 12 characters.
- Held means an active session (`ACTIVE_STATES`) references the target. `live` covers live and ending. `waiting`
  covers requested, provisioning and warming.
- Refusal codes (spec §5.2, verbatim): `DESTINATION_DUPLICATE` (409), `TARGET_IN_USE` (409, on PATCH and DELETE), and
  404 for removing an already-archived row. The existing `target_in_use` (409, createSession) keeps its lowercase
  code.
- Replace key, Remove and createSession all take `SELECT … FOR UPDATE` on the target row before checking. The
  `one_active_target` index stays as the backstop.
- The new methods are `PATCH /api/v1/orgs/{id}/stream-targets/{targetId}` and `DELETE …/{targetId}`. Both go in
  `NEVER_KEY_ROUTES` and in OpenAPI `ROUTES`, and `stream-contract.test.ts` goes from five pinned stream operations to
  seven.
- The projection gains `output: {state: "ok"|"connecting"|"rejected"|"unknown", since: string} | null` (for
  passthrough sessions).
- Provider meta `{sessionId}` goes on `removeOutput`, `addOutput`, `inputStatus` and `outputState`, at every call
  site.

**Copy (spec §3.3, §4, verbatim en):**
- "Uses 1 credit · {n} left · Buy more"
- "Live from the phone, but {Platform} isn't receiving it. Check the stream key in Directory." / "Open Directory"
- "No destinations yet. Add one in Directory."
- "Couldn't load your destinations." / "Retry"
- "{label} is {live|waiting for a phone} on Match {n} · {court}. Stop it there or pick another destination." /
  "Open Match {n}"
- Directory empty state: "No destinations yet. Add the stream key from YouTube or Twitch once, then pick it on any
  match."
- "This looks like a key name, not a key. A YouTube key looks like abcd-1234-efgh-5678-ijkl."
- Row subline: "{Platform} · key ends …{hint} · added {date}". Badges: "Live on Match {n}" and "Waiting for phone on
  Match {n}". Disabled reason: "Stop Match {n} first".
- Key-shape regexes (they warn, never block):
  - YouTube `^[a-z0-9]{4}(-[a-z0-9]{4}){3,4}$` (case-insensitive);
  - Twitch `^live_\d+_[A-Za-z0-9]{20,}$`.

**House rules (AGENTS.md, RULES.md, TEST-STRATEGY.md) that bind every task:**
- Every new or changed user-facing string goes in all four `apps/web/src/dictionaries/{en,es,fr,nl}/ui.json`, then
  `cd WT && pnpm i18n:gen-keys`, which regenerates `apps/web/src/lib/i18n-keys.ts` (never edit it by hand). After
  that, run `pnpm i18n:check`.
- Every change ships a test that fails without it.
- Every new guard is **mutated once** (delete the predicate, or `return true`) and the named test must go red. Record
  the mutation and the red test's name in the task's commit body.
- **Anti-vacuity:** every sweep, property or loop test asserts how many items it checked, and zero checked is a
  failure.
- **Expected values come from declarations** (`ACTIVE_STATES`, `STREAM_PLATFORM_PRESETS`,
  `OUTPUT_WARNING_AFTER_MS`, `KEY_HINT_MIN_LENGTH`, `SEAZN_QR_*`), never from a table typed into the test. At least
  one case per guard must have a right answer that differs from the wrong answer's constant.
- **Scoped local runs only.** Never the full vitest, e2e or gate (owner, 2026-09-28). Run vitest as
  `cd WT/apps/web && rm -f $OUT && pnpm vitest run <exact paths> --reporter=json --outputFile=$OUT; echo EXIT=$?`,
  then `jq '{p:.numPassedTests,t:.numTotalTests,f:.numFailedTests,files:[.testResults[].name]}' $OUT`.
  - Green means `f == 0`, `p == t`, `t > 0`, and every expected file appears in `.files` with a worktree path.
  - Delete `$OUT` first: a stale JSON reads as a pass.
  - Positional paths are literal filename filters, and a missing path is silently ignored, so compare `.files` to the
    list you passed.
- `tsc` and `eslint` run through `rtk proxy`:
  - `cd WT/apps/web && rtk proxy pnpm typecheck`;
  - `cd WT/apps/web && rtk proxy pnpm lint`, reading `✖ N problems`.
- Boundaries that must stay green without edits to their assertions:
  - `server/relay/__tests__/enc-boundary.test.ts`: `rtmp_enc` is named only in `server/relay/secret-columns.ts`;
  - `port-boundary.test.ts`;
  - `rls-static.test.ts`: `org_stream_targets` keeps FORCE RLS with zero policies. Its reads come from V410, and V427
    adds no policy.
- Walkthroughs always run as **whole files**, never with `-g`:
  `cd WT/apps/web && PLAYWRIGHT_BASE=http://localhost:3000 pnpm exec playwright test e2e/walkthrough/<file> --project=walkthrough --reporter=line; echo EXIT=$?`.
  Use `localhost`, never `127.0.0.1`. The server is a prod build of this worktree, stood up with the
  `seazn-local-env` skill (fresh DB = `db:apply` **and** `sync:sports`; confirm `show data_directory` is yours).
- All four test types are owed across the branch: unit, E2E, smoke (`scripts/smoke.ts`) and regression. Each task
  names which ones it owes.
- `/directory` is **not** `/admin`. It keeps the full visual bar: 1280, 768 and 320, with no horizontal page scroll.
- `git stash` is never used in this worktree. Commit with the attribution trailer the session provides.

## Review Focus

Five inputs the spec implies but never names, most likely to bite first. Each has its test in the owning task.

1. **An undecryptable or foreign-KEK envelope on a listed row.** A person expects the list to load with that row
   showing no key hint, not a 500 that blanks Directory and the picker. *(T1: `readKeyHints` yields `null` and never
   throws. T2a: `listStreamTargets` answers 200 with `keyHint: null` for a row sealed under another KEK.)*
2. **A pasted key with surrounding whitespace or newlines on Replace key.** A person expects it trimmed exactly as
   create trims it; a whitespace-only key is refused as empty, never sealed. *(T2b: PATCH `{streamKey: "  k…\n"}`
   stores the trimmed key, with its fingerprint equal to create's; `{streamKey: "   "}` gives 422.)*
3. **A double-tapped Remove or Replace, or two tabs.** A person expects the second call's 404 (already archived) to read
   as "already done": the list refreshes and no red error appears. *(T7:
   `destinationMutationOutcome(404, "remove") === "refresh"`, pinned in `stream-destinations-panel` unit tests.)*
4. **A finalized, cancelled, frozen or TBD-sided fixture with a stream still up.** A person expects Stop on the
   fixture page even though the Scoring section does not render for those fixtures. *(T5: the console renders
   `data-role="console-stream"` when the Scoring section is absent and the mount is non-null. There is a unit test
   for each of the four fixture shapes, plus walkthrough case A7 on a finalized fixture.)*
5. **Clock skew between server `since` and the browser clock.** A person expects no warning flash when the browser
   runs behind the server (a future `since`), and never a negative elapsed time. *(T4: `destinationWarning` with
   `since` 5 s in the future gives `false`, and `outputElapsedMs` clamps to 0.)*

## Premises re-verified (brief → corrected fact)

These were re-pinned against `origin/main` 770bdca07 on 2026-09-30. Each item says what the plan does about it.

1. **Migration number.** "V427 on main today" is true in effect: main tops out at
   `V426__streaming_every_plan_monthly_credits.sql`, and no branch or worktree holds V427+ (the W1c exec branch has no
   migrations). The re-check is repeated at T11.
2. **Platform presets.** "Server-filled url from `lib/stream-destinations.ts` preset" is false: no preset exists. T2a
   adds `STREAM_PLATFORMS` and `STREAM_PLATFORM_PRESETS`.
   - YouTube: `rtmp://a.rtmp.youtube.com/live2` (spec, staging-proven).
   - Twitch: `rtmps://ingest.global-contribute.live-video.net:443/app`. Its host is admitted by the
     `.global-contribute.live-video.net` entry, which the allowlist files under `kick`. T2a verifies it against
     `https://ingest.twitch.tv/ingests` before committing.
3. **Run-sheet filters.** "Remove `runSheetKeeps` … if no other caller": `runSheetKeeps` is RunSheet's **own** row
   filter (`desk/run-sheet.tsx:271`) and stays. `initialRunSheetFilter` (`stages-panel.tsx:220-229`, one caller
   :589-594) and `checkoutReturnFor` exist only for the checkout return and are removed in T6.
4. **Archived refusal at createSession.** "`targetBelongsToOrg` adds `archived_at IS NULL`" is only half the fix.
   `targetBelongsToOrg` is a boolean computed from a query in a `Promise.all` **outside** the admission transaction
   (`stream-sessions.ts` :1054-1062), and the spec also wants the row lock there. T2b moves that read into the
   admission transaction as `select … and archived_at is null for update`.
5. **D6 and the host allowlist.** The owner-asks D6 note says to narrow `STREAM_DESTINATION_HOSTS`, but spec §5.4
   requires stored legacy kinds to "keep listing and streaming", and `createSession` re-checks the stored url. So the
   host allowlist stays whole; only the **create** `kind` enum narrows.
6. **Round-1 `connecting`.** The claim that it was "mapped to unknown" is false. `ingest-cf.ts:283-287` maps any
   present non-`error` state (including `connecting`) to `ok`. That is exactly the staging round-1 bug ("panel said
   Live while YouTube received nothing"). T4's CF mapping fixes it, and its regression test drives
   `status.current.state: "connecting"`.
7. **Smoke.** "The CI smoke stream-overlay suite is updated for the new placement" is inaccurate:
   `streamOverlaySuite` (`scripts/smoke.ts:18468`) covers the overlay route only, never the panel's placement. What is
   owed instead:
   - a new `streamTargetsSuite` (T2b: create, rename, replace, remove and 409 over HTTP);
   - the stream-twin presence check beside the device-handover one at `smoke.ts:16981-16987` (T5).
8. **Where Stream sits.** The spec's "Scoring header" does not render in the Stop-critical cases.
   `fixture-console.tsx:1007` renders the Scoring section only when `scoring && home && away`, so it is absent for
   finalized, cancelled, frozen and TBD-sided fixtures. T5 adds a fallback `data-role="console-stream"` card for
   exactly those.
9. **Holder fields can be null.** `inUse.fixtureId/href/matchLabel` cannot always be filled:
   `fixture_stream_sessions.fixture_id` is `on delete set null` (V410). These fields are nullable, and the UI falls
   back to the generic copy.
10. **`matchLabel` as a server string.** An English "Match {n}" from the server would break the four-locale rule. The
    wire carries `matchNo: number | null`, and every client renders it through the existing `breadcrumb.match` key
    (en "Match {no}", es "Partido {no}", fr "Match {no}", nl "Wedstrijd {no}"). **Deviation from spec §5.3/§5.5,
    recorded.**
11. **Walkthrough capacity.** Walkthrough stream capacity is 3 (fake storage 1000 / `MAX_DURATION_MINUTES`), and
    `stream-relay` plus `stream-credits` already hold all three slot keys. The new Directory walkthrough takes a slot
    through the same `streamSlot()` helper and waits.
12. **T2 cannot be green on its own** unless it also touches the panel's `TargetForm` and the walkthrough helper,
    because dropping `rtmpUrl` breaks the panel's add form and `addTargetApi`. T2a therefore includes those minimal
    edits. T8 then removes the form.
13. **The division page's stream context** lives at :518-606, not :540-606 as the spec says. The frozen probes are at
    :616-618 and :803-816.

## File Structure

**Created:**

| Path | Responsibility | Task |
|---|---|---|
| `db/migration/deltas/V427__stream_target_archive.sql` | `archived_at`, and the index recreated as partial | T1 |
| `apps/web/src/server/usecases/stream-target-holders.ts` | one holder query + shape shared by list `inUse`, `targetHolderFor`, PATCH/DELETE 409 | T2a |
| `apps/web/src/app/api/v1/orgs/[id]/stream-targets/[targetId]/route.ts` | PATCH (rename / replace key), DELETE (archive) | T2b |
| `apps/web/src/server/stream-panel-context.ts` | `loadStreamPanelContext` — the one authority for `StreamPanelContext` | T5 |
| `apps/web/src/lib/fixture-stream-mount.ts` | pure `fixtureStreamMode`, `nextOpenPanel`, `streamButtonState` | T5, T9b |
| `apps/web/src/lib/stream-key-shape.ts` | pure `keyShapeWarning(kind, key)` | T7 |
| `apps/web/src/components/v2/stream-platform-mark.tsx` | `PlatformMark` + `STREAM_KIND_BRAND` | T7 |
| `apps/web/src/components/v2/stream-destinations-panel.tsx` | Directory Streaming tab (client) | T7 |
| `apps/web/e2e/walkthrough/directory-stream-destinations.spec.ts` | Directory cases of spec §9.2 | T7 |
| `apps/web/src/lib/stream-chain.ts` | pure `chainFor(view, now)` (§3.2 table) | T9a |
| `apps/web/src/components/v2/stream-signal-chain.tsx` | `SignalChain` component | T9a |
| `apps/web/src/components/v2/stream-session-provider.tsx` | one `usePhoneSession` poller shared by button dot + panel | T9b |
| `apps/web/src/lib/seazn-qr.ts` | `seaznQrLayout`, `seaznQrSvg`, `renderSeaznQr` | T10 |
| `apps/web/src/lib/qr-enlarge.ts` | D10: `enlargedQrSize`, `holdScreenWakeLock` | T10 |
| `scripts/smoke-select.ts` + `scripts/__tests__/smoke-select.test.ts` | pure `selectSmokeSuites` (SMOKE_ONLY) and its contract test | T2b |
| `apps/web/e2e/helpers/qr-enlarge.ts` | `expectQrEnlarges` — the D10 call-site witness | T10 |
| `apps/web/src/components/v2/seazn-qr-image.tsx` | D10: `SeaznQrImage` (tap to enlarge overlay) | T10 |

**Modified:**

| Path | What changes | Task |
|---|---|---|
| `apps/web/src/server/relay/secret-columns.ts` | `insertStreamTarget` order, `archiveStreamTarget`, `replaceTargetKey`, `readKeyHints`, `keyHintOf`, and a `lockStreamTarget` read | T1, T2b |
| `apps/web/src/lib/stream-destinations.ts` | `STREAM_PLATFORMS`, `STREAM_PLATFORM_PRESETS` | T2a |
| `apps/web/src/server/api-v1/schemas.ts` | the create kind narrows; `PatchStreamTarget`, `StreamTargetHolder`, `StreamOutput`; `StreamTarget` and `StreamSessionCurrent` gain fields | T2a, T2b, T4 |
| `apps/web/src/server/usecases/stream-targets.ts` | create by preset; list excludes archived plus `keyHint`/`inUse`; `patchStreamTarget` (rename or replace key), `removeStreamTarget`, `targetHeld` | T2a, T2b |
| `apps/web/src/server/relay/domain/session.ts` | `holdStateOf` | T2a |
| `apps/web/src/server/usecases/stream-sessions.ts` | `targetHolderFor`/`targetInUse` use the holders module; target lock in admission; provider meta; `output` projection; `openStreamStates` | T2b, T3, T4, T6 |
| `apps/web/src/server/relay/ports.ts`, `ingest-cf.ts`, `fakes.ts` | `OutputState` gains `connecting`; `ProviderCallMeta`; fake key prefixes | T2a, T4 |
| `apps/web/src/server/api-v1/openapi.ts`, `key-scopes.ts` | two routes plus 409 extras | T2b, T3 |
| `apps/web/src/lib/stream-session-view.ts` | holder copy; `OUTPUT_WARNING_AFTER_MS`, `destinationWarning` | T3, T4 |
| `apps/web/src/app/o/[orgSlug]/c/[compSlug]/d/[divSlug]/f/[no]/page.tsx` | `searchParams`, loader, stream mount | T5 |
| `apps/web/src/components/v2/fixture-console.tsx` | `openPanel`, Stream twins, `console-stream` fallback | T5, T9b |
| `apps/web/src/components/v2/fixture-stream-panel.tsx` | `openedByReturn`; the picker; the restyle; logo QR | T5, T8, T9a, T9b, T10 |
| `apps/web/src/app/api/billing/relay-checkout/route.ts` | return URL goes to the fixture page | T5 |
| `apps/web/src/app/o/[orgSlug]/c/[compSlug]/d/[divSlug]/page.tsx` | loader call in T5; stream context and probes removed in T6 | T5, T6 |
| `apps/web/src/components/v2/desk/run-sheet-row.tsx`, `desk/run-sheet.tsx`, `stages-panel.tsx` | toggle and panel become the chip | T6 |
| `apps/web/src/app/directory/page.tsx` | `streaming` tab | T7 |
| `apps/web/src/components/v2/device-link-panel.tsx`, `checkin-qr.tsx` | `renderSeaznQr`, `SeaznQrImage` | T10 |
| `docs/superpowers/specs/2026-09-05-stream-overlay-prompts/_THEMES.md` | §8a `QR size` and `QR encoding` rows, dated amendment (D7), with the fixture page's own 320-wide figure | T10 |
| `apps/web/src/dictionaries/{en,es,fr,nl}/ui.json` + generated `lib/i18n-keys.ts` | keys per task | T3, T5–T9b |
| `apps/web/e2e/walkthrough/stream-relay.spec.ts`, `stream-credits.spec.ts`, `e2e/stream-overlay.spec.ts`, `e2e/mobile.spec.ts` | fixture-page helpers, twin checks | T2a, T5, T6, T8, T9b |
| `apps/web/src/lib/__tests__/e2e-ci-wiring.test.ts` | registers the new walkthrough | T7 |
| `scripts/smoke.ts` | `streamTargetsSuite`; the `SELECTABLE_SUITES` registry, `subsetSetup`/`runSubset` and the `SMOKE_ONLY` entry; stream-twin presence (in `v1Suite`) | T2b, T5 |
| `docs/superpowers/specs/2026-09-02-scorepad-v3-phone-composition-design.md`, `AGENTS.md` | dated "two duplicated controls" amendment | T5 |

---
## Wave S — server (no UI change beyond what keeps the tree green)

### Task 1: V427 archive column and the secret-columns writers

**Files:**
- Create: `db/migration/deltas/V427__stream_target_archive.sql`
- Modify: `apps/web/src/server/relay/secret-columns.ts:95-150` (`insertStreamTarget`, `StoredStreamTarget`), plus new
  exports at the end of the file
- Test: `apps/web/src/server/relay/__tests__/secret-columns.test.ts` (new cases after :190)
- Test: `apps/web/src/server/relay/__tests__/migration-shape.test.ts:538-575` (the V421 case's index regex, and a new
  V427 case)
- Guard, run unchanged: `enc-boundary.test.ts`, `rls-static.test.ts`, `port-boundary.test.ts`

**Interfaces:**
- Consumes: `fingerprintDestination(url, key)`, `seal`, `open` (`relay/crypto.ts`), and `checkDestination` (`lib/stream-destinations.ts`).
- Produces (all exported from `server/relay/secret-columns.ts`):
  - `KEY_HINT_MIN_LENGTH = 12`, `KEY_HINT_CHARS = 3`, `keyHintOf(streamKey: string): string | null`
  - `type InsertOutcome = "existing" | "restored" | "inserted"`
  - `interface StoredStreamTarget { id; kind; label; watchUrl: string | null; createdAt: Date; outcome: InsertOutcome }`
  - `insertStreamTarget(tx, {orgId, kind, label, watchUrl, rtmp:{url, streamKey}}): Promise<StoredStreamTarget>` (same args as today)
  - `readKeyHints(tx, orgId): Promise<Map<string, string | null>>`, covering active rows only; an unopenable envelope gives `null`
  - `lockStreamTarget(tx, orgId, targetId): Promise<boolean>`, which is `SELECT … AND archived_at IS NULL FOR UPDATE`
  - `archiveStreamTarget(tx, orgId, targetId): Promise<boolean>`
  - `type ReplaceKeyResult = {ok: true; changed: boolean} | {ok: false; reason: "not_found"} | {ok: false; reason: "undialable"; rule: DestinationRefusal} | {ok: false; reason: "duplicate"; other: {id: string; label: string}}`
  - `replaceTargetKey(tx, orgId, targetId, streamKey): Promise<ReplaceKeyResult>`

- [ ] **Step 1: Re-check the migration number.**

```bash
cd /Users/ashokhein/github/seazn.club/.claude/worktrees/fixture-stream && git fetch origin --quiet && git ls-tree -r --name-only origin/main db/migration/deltas | sort -V | tail -2 && for b in $(git for-each-ref --format='%(refname:short)' refs/remotes/origin); do git ls-tree -r --name-only "$b" db/migration/deltas 2>/dev/null | grep -aE '/V4(2[7-9]|[3-9][0-9])__' | sed "s|^|$b: |"; done
```

Expected: main's last line is `V426__streaming_every_plan_monthly_credits.sql`, and no branch lists V427+. If one
does, take the next free number, and rename the file and every mention of V427 in this plan's steps before going on.

- [ ] **Step 2: Write the failing migration-shape tests.** In `migration-shape.test.ts`, change the V421 case's index
  regex (:571-573) to the new predicate, and add a V427 case directly after it.

```ts
    expect(idx?.indexdef, "org_stream_targets_org_dest_fingerprint is missing or renamed").toMatch(
      /^CREATE UNIQUE INDEX org_stream_targets_org_dest_fingerprint ON \w+\.org_stream_targets USING btree \(org_id, dest_fingerprint\) WHERE \(\(dest_fingerprint IS NOT NULL\) AND \(archived_at IS NULL\)\)$/,
    );
  });

  it("archived_at (V427, D2): NULLABLE timestamptz with no default; an ARCHIVED row never blocks an active row of the same fingerprint, while two ACTIVE rows still collide by name", async () => {
    const a = await rig();
    const hex64 = () => (randomUUID() + randomUUID()).replace(/-/g, "");
    const [shape] = await sql<{ data_type: string; is_nullable: string; column_default: string | null }[]>`
      select data_type, is_nullable, column_default from information_schema.columns
       where table_schema = current_schema() and table_name = 'org_stream_targets' and column_name = 'archived_at'`;
    expect(shape).toEqual({ data_type: "timestamp with time zone", is_nullable: "YES", column_default: null });
    const fp = hex64();
    const put = (archived: boolean) => sql`
      insert into org_stream_targets (org_id, kind, label, rtmp_enc, dest_fingerprint, archived_at)
      values (${a.orgId}, 'youtube', 'fp', ${Buffer.from("not-a-real-envelope")}, ${fp}, ${archived ? new Date() : null})`;
    await put(true);
    await put(true);               // two archived rows of one destination: history, both kept
    await put(false);              // the active row lands beside them
    await expect(put(false)).rejects.toMatchObject({ code: "23505", constraint_name: "org_stream_targets_org_dest_fingerprint" });
    const [{ n }] = await sql<{ n: number }[]>`select count(*)::int as n from org_stream_targets where org_id = ${a.orgId} and dest_fingerprint = ${fp}`;
    expect(n).toBe(3);
  });
```

- [ ] **Step 3: Run and confirm red.**

```bash
cd /Users/ashokhein/github/seazn.club/.claude/worktrees/fixture-stream/apps/web && rm -f /tmp/fs-t1.json && pnpm vitest run src/server/relay/__tests__/migration-shape.test.ts --reporter=json --outputFile=/tmp/fs-t1.json; echo EXIT=$?; jq '{p:.numPassedTests,t:.numTotalTests,f:.numFailedTests,files:[.testResults[].name]}' /tmp/fs-t1.json
```

Expected: `f` is 2 (the V421 regex case and the new V427 case), and `files` has one worktree path.

- [ ] **Step 4: Write the migration.**

```sql
-- V427 (feat/fixture-page-stream, spec 2026-09-30 §5.1, owner ruling D2): Remove = ARCHIVE.
-- A removed destination is hidden forever but never deleted: fixture_stream_sessions.target_id keeps NO ACTION, so
-- history and money rows keep the destination they streamed to. Re-adding the same key un-archives the most recent
-- archived row (server/relay/secret-columns.ts insertStreamTarget).
alter table org_stream_targets add column archived_at timestamptz null;

-- The one-destination-per-org index (V421, A19) becomes partial on ACTIVE rows too, keeping V421's own predicate, so an
-- archived row never blocks a new or re-keyed destination. insertStreamTarget's ON CONFLICT names this exact predicate
-- to INFER the index (a drifted predicate is 42P10); migration-shape.test.ts pins it as text.
drop index org_stream_targets_org_dest_fingerprint;
create unique index org_stream_targets_org_dest_fingerprint
  on org_stream_targets (org_id, dest_fingerprint)
  where dest_fingerprint is not null and archived_at is null;
```

Apply it to your own test DB (`seazn-local-env` skill: `pnpm db:apply` against the DATABASE_URL you own, then
`pnpm sync:sports`), and confirm `show data_directory` is yours first.

- [ ] **Step 5: Write the failing secret-columns tests.** Append them inside the existing
  `describe.skipIf(!HAS_DB)(…)` in `secret-columns.test.ts`. Extend the import at :19 with `archiveStreamTarget`,
  `keyHintOf`, `KEY_HINT_CHARS`, `KEY_HINT_MIN_LENGTH`, `lockStreamTarget`, `readKeyHints` and `replaceTargetKey`.

```ts
  /** A destination that dials: the rig's own youtube url with a fresh 65-char key. */
  const dest = (streamKey = secret65()) => ({ url: "rtmps://a.rtmps.youtube.com/live2", streamKey });
  const put = (orgId: string, rtmp: { url: string; streamKey: string }, label = "L", watchUrl: string | null = null) =>
    sql.begin((tx) => insertStreamTarget(tx, { orgId, kind: "youtube", label, watchUrl, rtmp }));

  it("D2 create order 1/3: an ACTIVE duplicate is returned as 'existing' and writes nothing — not its label, not its watch link", async () => {
    const { orgId } = await rig();
    const d = dest();
    const first = await put(orgId, d, "First", "https://youtu.be/one");
    const again = await put(orgId, d, "Second", "https://youtu.be/two");
    expect(first.outcome).toBe("inserted");
    expect(again).toMatchObject({ id: first.id, outcome: "existing", label: "First", watchUrl: "https://youtu.be/one" });
  });

  it("D2 create order 2/3: an ARCHIVED duplicate is RESTORED — same id, the SUBMITTED label and watch link, archived_at cleared", async () => {
    const { orgId } = await rig();
    const d = dest();
    const first = await put(orgId, d, "Old name", null);
    expect(await sql.begin((tx) => archiveStreamTarget(tx, orgId, first.id))).toBe(true);
    const back = await put(orgId, d, "New name", "https://youtu.be/new");
    expect(back).toMatchObject({ id: first.id, outcome: "restored", label: "New name", watchUrl: "https://youtu.be/new" });
    const [row] = await sql<{ archived_at: Date | null }[]>`select archived_at from org_stream_targets where id = ${first.id}`;
    expect(row!.archived_at).toBeNull();
  });

  it("D2 create order 2/3: of TWO archived rows of one destination, the MOST RECENTLY archived is the one restored", async () => {
    const { orgId } = await rig();
    const d = dest();
    const fp = fingerprintDestination(d.url, d.streamKey);
    const raw = (label: string, archivedAt: string) => sql<{ id: string }[]>`
      insert into org_stream_targets (org_id, kind, label, rtmp_enc, dest_fingerprint, archived_at)
      values (${orgId}, 'youtube', ${label}, ${seal(JSON.stringify(d))}, ${fp}, ${archivedAt}) returning id`;
    const [older] = await raw("older", "2026-09-01T00:00:00Z");
    const [newer] = await raw("newer", "2026-09-20T00:00:00Z");
    const back = await put(orgId, d, "again");
    expect(back.id).toBe(newer!.id);      // differential: the wrong ORDER BY returns `older`
    expect(back.id).not.toBe(older!.id);
  });

  it("D2 create order 3/3: no row of this destination (active or archived) inserts a new one", async () => {
    const { orgId } = await rig();
    const made = await put(orgId, dest());
    expect(made.outcome).toBe("inserted");
  });

  it("archiveStreamTarget: true once, false on the second call, false for ANOTHER org's id; an archived row reads as absent to lockStreamTarget", async () => {
    const a = await rig();
    const b = await rig();
    const t = await put(a.orgId, dest());
    expect(await sql.begin((tx) => archiveStreamTarget(tx, b.orgId, t.id))).toBe(false);
    expect(await sql.begin((tx) => lockStreamTarget(tx, a.orgId, t.id))).toBe(true);
    expect(await sql.begin((tx) => archiveStreamTarget(tx, a.orgId, t.id))).toBe(true);
    expect(await sql.begin((tx) => archiveStreamTarget(tx, a.orgId, t.id))).toBe(false);
    expect(await sql.begin((tx) => lockStreamTarget(tx, a.orgId, t.id))).toBe(false);
  });

  it("keyHintOf: null below KEY_HINT_MIN_LENGTH, the last KEY_HINT_CHARS characters at and above it", () => {
    const short = "x".repeat(KEY_HINT_MIN_LENGTH - 1);
    const exact = `${"y".repeat(KEY_HINT_MIN_LENGTH - KEY_HINT_CHARS)}abc`;
    expect(keyHintOf(short)).toBeNull();
    expect(keyHintOf(exact)).toBe(exact.slice(-KEY_HINT_CHARS));
    expect(keyHintOf(exact)).toHaveLength(KEY_HINT_CHARS);
  });

  it("readKeyHints (Review Focus 1): each ACTIVE row's hint; an UNOPENABLE envelope reads null and never throws; archived rows are absent", async () => {
    const { orgId } = await rig();
    const good = await put(orgId, dest("abcd-1234-efgh-5678-ijkl"));
    const gone = await put(orgId, dest());
    await sql.begin((tx) => archiveStreamTarget(tx, orgId, gone.id));
    const [bad] = await sql<{ id: string }[]>`
      insert into org_stream_targets (org_id, kind, label, rtmp_enc) values (${orgId}, 'youtube', 'bad', ${Buffer.from("not-a-real-envelope")}) returning id`;
    const hints = await sql.begin((tx) => readKeyHints(tx, orgId));
    expect(hints.get(good.id)).toBe("ijkl".slice(-KEY_HINT_CHARS));
    expect(hints.get(bad!.id)).toBeNull();
    expect(hints.has(gone.id)).toBe(false);
    // rig() seeds one target of its own; it is active and counted.
    expect(hints.size).toBe(3);
  });

  it("replaceTargetKey: re-seals the KEY under the SAME url and re-fingerprints; the same key again is a no-op", async () => {
    const { orgId } = await rig();
    const d = dest();
    const t = await put(orgId, d);
    const next = secret65();
    expect(await sql.begin((tx) => replaceTargetKey(tx, orgId, t.id, next))).toEqual({ ok: true, changed: true });
    expect(await sql.begin((tx) => readTargetSecret(tx, orgId, t.id))).toEqual({ url: d.url, streamKey: next });
    const [row] = await sql<{ dest_fingerprint: string }[]>`select dest_fingerprint from org_stream_targets where id = ${t.id}`;
    expect(row!.dest_fingerprint).toBe(fingerprintDestination(d.url, next));
    expect(await sql.begin((tx) => replaceTargetKey(tx, orgId, t.id, next))).toEqual({ ok: true, changed: false });
  });

  it("replaceTargetKey: an ACTIVE row already holding the new key is 'duplicate' naming it; an ARCHIVED holder and another ORG's holder do not block", async () => {
    const a = await rig();
    const b = await rig();
    const taken = dest();
    const holder = await put(a.orgId, taken, "Holder");
    const mover = await put(a.orgId, dest(), "Mover");
    expect(await sql.begin((tx) => replaceTargetKey(tx, a.orgId, mover.id, taken.streamKey)))
      .toEqual({ ok: false, reason: "duplicate", other: { id: holder.id, label: "Holder" } });
    await sql.begin((tx) => archiveStreamTarget(tx, a.orgId, holder.id));
    expect(await sql.begin((tx) => replaceTargetKey(tx, a.orgId, mover.id, taken.streamKey))).toEqual({ ok: true, changed: true });
    const other = await put(b.orgId, dest(), "B");
    expect(await sql.begin((tx) => replaceTargetKey(tx, b.orgId, other.id, taken.streamKey))).toEqual({ ok: true, changed: true });
  });

  it("replaceTargetKey: an archived or foreign target is 'not_found'; a stored url the allowlist no longer admits is 'undialable' with its rule", async () => {
    const a = await rig();
    const b = await rig();
    const t = await put(a.orgId, dest());
    expect(await sql.begin((tx) => replaceTargetKey(tx, b.orgId, t.id, secret65()))).toEqual({ ok: false, reason: "not_found" });
    await sql.begin((tx) => archiveStreamTarget(tx, a.orgId, t.id));
    expect(await sql.begin((tx) => replaceTargetKey(tx, a.orgId, t.id, secret65()))).toEqual({ ok: false, reason: "not_found" });
    const [legacy] = await sql<{ id: string }[]>`
      insert into org_stream_targets (org_id, kind, label, rtmp_enc)
      values (${a.orgId}, 'custom_rtmp', 'legacy', ${seal(JSON.stringify({ url: "rtmps://media.example.com/live", streamKey: secret65() }))}) returning id`;
    expect(await sql.begin((tx) => replaceTargetKey(tx, a.orgId, legacy!.id, secret65()))).toEqual({ ok: false, reason: "undialable", rule: "host" });
  });
```

- [ ] **Step 6: Run and confirm red.** Use the Step 3 command with `src/server/relay/__tests__/secret-columns.test.ts`
  added to the paths.

Expected: the new cases fail (`archiveStreamTarget is not a function`, and `outcome` is undefined). The collected file
list has both paths.

- [ ] **Step 7: Implement in `secret-columns.ts`.** Add `import { checkDestination, type DestinationRefusal } from "@/lib/stream-destinations";`
  beside the crypto import. Replace `insertStreamTarget`, `StoredStreamTarget`, `TargetRow` and `storedTarget`
  (:95-150) with the code below, and append the new functions after `readTargetSecret`.

```ts
/** §5.3: a key shorter than this has no hint — three characters of a short key are most of it. */
export const KEY_HINT_MIN_LENGTH = 12;
export const KEY_HINT_CHARS = 3;

export function keyHintOf(streamKey: string): string | null {
  return streamKey.length < KEY_HINT_MIN_LENGTH ? null : streamKey.slice(-KEY_HINT_CHARS);
}

/** The one unique index a destination write can meet (V421, made partial on active rows by V427). Matched by NAME. */
const FINGERPRINT_INDEX = "org_stream_targets_org_dest_fingerprint";
const isFingerprintConflict = (err: unknown): boolean => {
  const pg = err as { code?: string; constraint_name?: string };
  return pg.code === "23505" && pg.constraint_name === FINGERPRINT_INDEX;
};

export type InsertOutcome = "existing" | "restored" | "inserted";

/** Save a destination with its url + key sealed — the table's only writer of `rtmp_enc` and `dest_fingerprint`.
 *
 *  D2 (spec 2026-09-30 §5.2), in this order, per org and fingerprint:
 *   1. an ACTIVE row is the destination — returned as `existing`, nothing written (A19: the first row's kind, label,
 *      watch link and envelope stand);
 *   2. else the most recently ARCHIVED row is un-archived with the SUBMITTED label and watch link (`restored`);
 *   3. else a new row (`inserted`).
 *  A concurrent create or restore of the same destination makes the losing write a no-op or a 23505 on the partial
 *  index; the loop then re-reads, and step 1 — a new statement, so a new READ COMMITTED snapshot — returns the
 *  winner. Two lost rounds in a row are refused by name (m6). An undialable url throws before anything is written. */
export async function insertStreamTarget(
  tx: Tx,
  args: { orgId: string; kind: string; label: string; watchUrl: string | null; rtmp: { url: string; streamKey: string } },
): Promise<StoredStreamTarget> {
  const fingerprint = fingerprintDestination(args.rtmp.url, args.rtmp.streamKey);
  for (let attempt = 1; attempt <= 2; attempt++) {
    const [active] = await tx<TargetRow[]>`
      select id, kind, label, watch_url, created_at from org_stream_targets
       where org_id = ${args.orgId} and dest_fingerprint = ${fingerprint} and archived_at is null`;
    if (active) return storedTarget(active, "existing");
    const [archived] = await tx<{ id: string }[]>`
      select id from org_stream_targets
       where org_id = ${args.orgId} and dest_fingerprint = ${fingerprint} and archived_at is not null
       order by archived_at desc, created_at desc limit 1`;
    if (archived) {
      const restored = await tx
        .savepoint((sp) => sp<TargetRow[]>`
          update org_stream_targets set archived_at = null, label = ${args.label}, watch_url = ${args.watchUrl}
           where id = ${archived.id} and archived_at is not null
          returning id, kind, label, watch_url, created_at`)
        .catch((err: unknown) => {
          if (isFingerprintConflict(err)) return [] as TargetRow[];
          throw err;
        });
      if (restored[0]) return storedTarget(restored[0], "restored");
      continue;   // another writer restored or inserted it first: round again, step 1 returns theirs
    }
    const [row] = await tx<TargetRow[]>`
      insert into org_stream_targets (org_id, kind, label, rtmp_enc, watch_url, dest_fingerprint)
      values (${args.orgId}, ${args.kind}, ${args.label}, ${seal(JSON.stringify(args.rtmp))}, ${args.watchUrl}, ${fingerprint})
      on conflict (org_id, dest_fingerprint) where dest_fingerprint is not null and archived_at is null do nothing
      returning id, kind, label, watch_url, created_at`;
    if (row) return storedTarget(row, "inserted");
  }
  throw new StreamTargetVanishedError();
}

/** The STORED target's public fields and how this call reached it. Never the envelope. */
export interface StoredStreamTarget {
  id: string; kind: string; label: string; watchUrl: string | null; createdAt: Date; outcome: InsertOutcome;
}

type TargetRow = { id: string; kind: string; label: string; watch_url: string | null; created_at: Date };

const storedTarget = (r: TargetRow, outcome: InsertOutcome): StoredStreamTarget =>
  ({ id: r.id, kind: r.kind, label: r.label, watchUrl: r.watch_url, createdAt: new Date(r.created_at), outcome });
```

Then append:

```ts
/** §5.3 — each ACTIVE destination's key hint, opened here so the full key never leaves this module. An envelope that
 *  will not open (a rotated KEK, a corrupt byte) is a row with no hint, never a failed list (Review Focus 1). */
export async function readKeyHints(tx: Tx, orgId: string): Promise<Map<string, string | null>> {
  const rows = await tx<{ id: string; rtmp_enc: Uint8Array }[]>`
    select id, rtmp_enc from org_stream_targets where org_id = ${orgId} and archived_at is null`;
  const hints = new Map<string, string | null>();
  for (const r of rows) {
    let hint: string | null = null;
    try {
      hint = keyHintOf(openFields(r.rtmp_enc, TARGET_SEALED).streamKey);
    } catch {
      hint = null;
    }
    hints.set(r.id, hint);
  }
  return hints;
}

/** §5.2 — the row lock Replace key, Remove and createSession all take BEFORE they check, so Remove cannot interleave
 *  with Go live. False for an archived row, another org's row, or no row: the callers' 404. Under READ COMMITTED a
 *  lock that waited re-evaluates `archived_at is null` on the committed row, so a Remove that won reads as absent. */
export async function lockStreamTarget(tx: Tx, orgId: string, targetId: string): Promise<boolean> {
  const rows = await tx<{ id: string }[]>`
    select id from org_stream_targets where id = ${targetId} and org_id = ${orgId} and archived_at is null for update`;
  return rows.length === 1;
}

/** D2 — Remove is an archive. False when there was no ACTIVE row of this org to archive (the caller's 404). */
export async function archiveStreamTarget(tx: Tx, orgId: string, targetId: string): Promise<boolean> {
  const rows = await tx<{ id: string }[]>`
    update org_stream_targets set archived_at = now()
     where id = ${targetId} and org_id = ${orgId} and archived_at is null
    returning id`;
  return rows.length === 1;
}

export type ReplaceKeyResult =
  | { ok: true; changed: boolean }
  | { ok: false; reason: "not_found" }
  | { ok: false; reason: "undialable"; rule: DestinationRefusal }
  | { ok: false; reason: "duplicate"; other: { id: string; label: string } };

/** §5.2 Replace key — the SAME url (it was server-filled per platform), a new key: re-sealed and re-fingerprinted. An
 *  ACTIVE row of this org already holding the new fingerprint refuses with its name; an archived one never blocks. */
export async function replaceTargetKey(tx: Tx, orgId: string, targetId: string, streamKey: string): Promise<ReplaceKeyResult> {
  const [row] = await tx<{ rtmp_enc: Uint8Array; dest_fingerprint: string | null }[]>`
    select rtmp_enc, dest_fingerprint from org_stream_targets
     where id = ${targetId} and org_id = ${orgId} and archived_at is null`;
  if (!row) return { ok: false, reason: "not_found" };
  const { url } = openFields(row.rtmp_enc, TARGET_SEALED);
  const dialable = checkDestination(url);
  if (!dialable.ok) return { ok: false, reason: "undialable", rule: dialable.rule };
  const fingerprint = fingerprintDestination(dialable.url, streamKey);
  if (fingerprint === row.dest_fingerprint) return { ok: true, changed: false };
  const otherHolder = () => tx<{ id: string; label: string }[]>`
    select id, label from org_stream_targets
     where org_id = ${orgId} and dest_fingerprint = ${fingerprint} and archived_at is null and id <> ${targetId}`;
  const [other] = await otherHolder();
  if (other) return { ok: false, reason: "duplicate", other: { id: other.id, label: other.label } };
  const wrote = await tx
    .savepoint((sp) => sp`
      update org_stream_targets
         set rtmp_enc = ${seal(JSON.stringify({ url: dialable.url, streamKey }))}, dest_fingerprint = ${fingerprint}
       where id = ${targetId} and org_id = ${orgId} and archived_at is null`)
    .then(() => true)
    .catch((err: unknown) => {
      if (isFingerprintConflict(err)) return false;
      throw err;
    });
  if (wrote) return { ok: true, changed: true };
  const [winner] = await otherHolder();   // a concurrent create took the fingerprint between the read and the write
  if (!winner) throw new StreamTargetVanishedError();
  return { ok: false, reason: "duplicate", other: { id: winner.id, label: winner.label } };
}
```

- [ ] **Step 8: Adapt the two m6 retry tests** (`secret-columns.test.ts` :155 and :166). They drive a scripted `tx`
  that answers each statement from a list (`scripted(answers)`, :146). Each round now issues three statements (active
  read, archived read, insert), so the expected shapes change. Keep what each test PROVES ("the retry's insert lands",
  "refused by name, never a third attempt") and change only the shapes, exactly as follows:
  - `INSERT_SQL` (:144) gains the new predicate:
    `/^insert into org_stream_targets .* on conflict \(org_id, dest_fingerprint\) where dest_fingerprint is not null and archived_at is null do nothing/`.
  - `SELECT_SQL` (:145) becomes the ACTIVE read:
    `/^select id, kind, label, watch_url, created_at from org_stream_targets where org_id = \? and dest_fingerprint = \? and archived_at is null$/`.
  - Add `ARCHIVED_SQL = /^select id from org_stream_targets where org_id = \? and dest_fingerprint = \? and archived_at is not null order by archived_at desc, created_at desc limit 1$/`.
  - A classifier `const kindOf = (s: string) => INSERT_SQL.test(s) ? "insert" : SELECT_SQL.test(s) ? "active" : ARCHIVED_SQL.test(s) ? "archived" : s;`.
  - First test ("the retry's insert lands"): `scripted([[], [], [], [], [], [landed]])`; `toHaveLength(6)`;
    `statements.map(kindOf)` equals `["active", "archived", "insert", "active", "archived", "insert"]`; the
    `toMatchObject` on `out` is unchanged.
  - Second test ("refused by name"): `scripted([])`; `toHaveLength(6)`; the same six-kind sequence; the
    `StreamTargetVanishedError` assertion is unchanged. Six, not more, is the "never a third attempt" witness.
  - Update the comment above them: the window is now "an active read and an archived read that both find nothing, then
    an insert that conflicts".
  Every regex must match its statement: an unmatched statement falls through `kindOf` as its raw text and fails the
  `toEqual`, so a wrong regex cannot pass silently.

- [ ] **Step 9: Run T1's scope and confirm green.**

```bash
cd /Users/ashokhein/github/seazn.club/.claude/worktrees/fixture-stream/apps/web && rm -f /tmp/fs-t1.json && pnpm vitest run src/server/relay/__tests__/secret-columns.test.ts src/server/relay/__tests__/migration-shape.test.ts src/server/relay/__tests__/enc-boundary.test.ts src/server/relay/__tests__/rls-static.test.ts src/server/relay/__tests__/port-boundary.test.ts src/server/usecases/__tests__/stream-targets.test.ts --reporter=json --outputFile=/tmp/fs-t1.json; echo EXIT=$?; jq '{p:.numPassedTests,t:.numTotalTests,f:.numFailedTests,files:[.testResults[].name]}' /tmp/fs-t1.json
```

Expected: `f: 0`, `p == t`, and six files under the worktree. `stream-targets.test.ts` is in scope because it reads
`createStreamTarget`'s reply. If it asserts on the exact object, add `outcome` nowhere: the use-case maps fields
explicitly (:63-66), so it stays green.

- [ ] **Step 10: Mutate each new guard once.** Revert each mutation after its red.
  - `insertStreamTarget`: `archived_at is null` → removed from the step-1 read. Red: "an ARCHIVED duplicate is
    RESTORED".
  - `order by archived_at desc` → `asc`. Red: "the MOST RECENTLY archived".
  - `keyHintOf`: `<` → `<=`. Red: "keyHintOf".
  - `readKeyHints`: the `catch` rethrows. Red: "readKeyHints (Review Focus 1)".
  - `replaceTargetKey`: drop `and archived_at is null` from `otherHolder`. Red: "an ARCHIVED holder … do not block".
  - `lockStreamTarget`: drop `and archived_at is null`. Red: "archiveStreamTarget: … reads as absent".

- [ ] **Step 11: Typecheck.**
  `cd /Users/ashokhein/github/seazn.club/.claude/worktrees/fixture-stream/apps/web && rtk proxy pnpm typecheck`.
  Expected: exit 0.

- [ ] **Step 12: Commit.**

```bash
cd /Users/ashokhein/github/seazn.club/.claude/worktrees/fixture-stream && git add db/migration/deltas/V427__stream_target_archive.sql apps/web/src/server/relay/secret-columns.ts apps/web/src/server/relay/__tests__/secret-columns.test.ts apps/web/src/server/relay/__tests__/migration-shape.test.ts && git commit -m "feat(stream): V427 archive + restore-on-re-add, replace key, key hint (T1)" -m "Mutations: <list each mutation and the test that went red>"
```

### Task 2a: Create by platform preset, the list shape, and the holders module

**Files:**
- Modify: `apps/web/src/lib/stream-destinations.ts` (append after `STREAM_DESTINATION_HOSTS`, ~:103)
- Modify: `apps/web/src/server/api-v1/schemas.ts:1306-1382` (`CreateStreamTarget`, `StreamTarget`; new `StreamTargetHolder`)
- Modify: `apps/web/src/server/relay/domain/session.ts:20` (add `holdStateOf` after `isActive`)
- Create: `apps/web/src/server/usecases/stream-target-holders.ts`
- Modify: `apps/web/src/server/usecases/stream-targets.ts` (whole file)
- Modify: `apps/web/src/server/relay/fakes.ts:182-187` (`outputState`: the reject-by-key prefix)
- Modify: `apps/web/src/components/v2/fixture-stream-panel.tsx:728-745` (`TARGET_KINDS`) and `TargetForm` (:1879): drop the RTMP field (minimal; T8 deletes the form)
- Modify: `apps/web/src/server/api-v1/openapi.ts:224` (the POST summary no longer mentions `rtmpUrl`)
- Tests to update, **dropping `rtmpUrl` from every create body** (find them with `rtk proxy grep -rnaE "rtmpUrl" apps/web/src apps/web/e2e scripts`):
  - `src/server/usecases/__tests__/stream-targets.test.ts`
  - `stream-sessions.test.ts` (`rig()` at :199)
  - `app/api/v1/fixtures/[id]/stream-sessions/__tests__/routes.test.ts`
  - `relay-internal-routes.test.ts`, `relay-sweep.test.ts`
  - `src/server/api-v1/__tests__/stream-contract.test.ts`
  - `src/components/v2/__tests__/fixture-stream-panel.test.tsx`
  - `src/lib/__tests__/stream-destinations.test.ts`
  - `e2e/walkthrough/stream-relay.spec.ts` (`addTargetApi` :306, A1, A6, A8), `e2e/walkthrough/stream-credits.spec.ts`
  - `scripts/smoke.ts`, if the grep lists it
- Test (new): `apps/web/src/server/relay/domain/__tests__/hold-state.test.ts`
- Test (new): `apps/web/src/server/usecases/__tests__/stream-target-holders.test.ts`

**Interfaces:**
- Consumes: `insertStreamTarget` (now with `outcome`), `readKeyHints` (T1).
- Produces:
  - `lib/stream-destinations.ts`:
    - `STREAM_PLATFORMS = ["youtube","twitch"] as const`, and `type StreamPlatform`;
    - `STREAM_PLATFORM_PRESETS: Readonly<Record<StreamPlatform, string>>`.
  - `domain/session.ts`: `type HoldState = "live" | "waiting"`, `holdStateOf(state: SessionState): HoldState | null`.
  - `schemas.ts`:
    - `CreateStreamTarget = {kind: StreamPlatform, label, streamKey, watchUrl?}` (strict);
    - `StreamTargetHolder = {sessionId, fixtureId: string|null, href: string|null, matchNo: number|null, courtName: string|null, state: "live"|"waiting"}`;
    - `StreamTarget` gains `keyHint: string | null` and `inUse: StreamTargetHolder | null`.
  - `stream-target-holders.ts`:
    - `interface TargetHolder {sessionId, targetId, fixtureId, href, matchNo, courtName, label, state: HoldState}`;
    - `holderRows(exec: Tx | typeof sql, q: {orgId: string; targetId?: string; notFixtureId?: string}): Promise<TargetHolder[]>`;
    - `toTargetHolder(row)`;
    - `wireHolder(h): {fixtureId, href, matchNo, courtName, label, state}` (the 409 extra);
    - `listHolder(h): StreamTargetHolder` (the list's `inUse`).
  - `fakes.ts`: `FAKE_REJECT_KEY_PREFIX = "reject-"`.

- [ ] **Step 1: Verify the presets before writing them.**
  - Twitch: run `curl -s https://ingest.twitch.tv/ingests | jq -r '.ingests[] | select(.default==true or .name|test("Global";"i")) | .url_template'`.
    Expected: a template on `ingest.global-contribute.live-video.net/app/{stream_key}`. If Twitch's global
    template differs, use its host, and check it with `checkDestination` in Step 3's test before committing.
  - YouTube: `rtmp://a.rtmp.youtube.com/live2` is the spec's staging-proven value (2026-09-30). Its host is in the
    allowlist at `stream-destinations.ts:61`.
  - Record both sources in the preset's comment.

- [ ] **Step 2: Write the failing tests.**

`apps/web/src/server/relay/domain/__tests__/hold-state.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { ACTIVE_STATES, TERMINAL_STATES, holdStateOf } from "../session";

describe("holdStateOf — what 'held' means to a person (spec §5.3)", () => {
  it("every ACTIVE state holds the destination and every TERMINAL state releases it — both lists the domain's own", () => {
    let checked = 0;
    for (const s of ACTIVE_STATES) { expect(holdStateOf(s), s).not.toBeNull(); checked++; }
    for (const s of TERMINAL_STATES) { expect(holdStateOf(s), s).toBeNull(); checked++; }
    expect(checked).toBe(ACTIVE_STATES.length + TERMINAL_STATES.length);
    expect(checked).toBeGreaterThan(0);
  });
  it("live and ending read 'live'; requested, provisioning and warming read 'waiting' (a phone has not connected yet)", () => {
    expect(ACTIVE_STATES.filter((s) => holdStateOf(s) === "live")).toEqual(["live", "ending"]);
    expect(ACTIVE_STATES.filter((s) => holdStateOf(s) === "waiting")).toEqual(["requested", "provisioning", "warming"]);
  });
});
```

First add two exports to `apps/web/src/server/relay/__tests__/_session-rig.ts` (after `rigTarget`, :81). They are
shared by this test, T2b's cases and T6's. Here `streamRig()` does not fit: it returns
`{orgId, createdBy, fixtureIds, session}` with no `auth`, and mints one target per session.

```ts
/** An org + one started fixture + one fake-envelope target, with the org's AuthCtx — for tests that seat sessions on a
 *  target THEY choose (holders, Replace key / Remove refusals). */
export async function holdRig(): Promise<{ auth: AuthCtx; fixtureId: string; targetId: string }> {
  const { auth } = await seedOrg();
  const { fixtureId } = await startedDivisionWithFixture(auth);
  return { auth, fixtureId, targetId: await rigTarget(auth.orgId) };
}

/** A session on `targetId` in `state`, written raw: only the READ of held-ness is under test, never `decide`. */
export async function sessionOnTarget(orgId: string, fixtureId: string, targetId: string, state: string, exec: Tx = sql): Promise<string> {
  const [s] = await exec<{ id: string }[]>`
    insert into fixture_stream_sessions (fixture_id, org_id, mode, state, target_id, created_by, sport_key, competition_id, division_id, entitlement_via_override)
    select f.id, ${orgId}, 'passthrough', ${state}, ${targetId}, ${await rigUser()}, d.sport_key, d.competition_id, f.division_id, true
      from fixtures f join divisions d on d.id = f.division_id where f.id = ${fixtureId}
    returning id`;
  return s!.id;
}
```

Import `seedOrg` and `startedDivisionWithFixture` from `@/server/usecases/__tests__/_rig` (secret-columns.test.ts
imports them the same way), `AuthCtx` from `@/server/api-v1/auth`, and the `Tx` type the way `secret-columns.ts`
imports it, if the file does not already. `exec` lets T2b's row-lock test write the session INSIDE the transaction that
holds the lock; `rigUser()` stays on the pool (its user row must be committed before the session references it).

`apps/web/src/server/usecases/__tests__/stream-target-holders.test.ts` runs against the DB, like
`stream-sessions.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { sql } from "@/lib/db";
import { routes } from "@/lib/routes";
import { ACTIVE_STATES, TERMINAL_STATES, holdStateOf } from "@/server/relay/domain/session";
import { holdRig, sessionOnTarget } from "@/server/relay/__tests__/_session-rig";
import { holderRows, toTargetHolder } from "../stream-target-holders";

const HAS_DB = !!process.env.DATABASE_URL;

describe.skipIf(!HAS_DB)("holderRows — who holds a destination, named for a person", () => {
  it("each ACTIVE state is a holder with its hold state, fixture number and organiser href; each TERMINAL state is not", async () => {
    let checked = 0;
    for (const state of [...ACTIVE_STATES, ...TERMINAL_STATES]) {
      const r = await holdRig();
      const targetId = r.targetId;
      const sid = await sessionOnTarget(r.auth.orgId, r.fixtureId, targetId, state);
      const got = await holderRows(sql, { orgId: r.auth.orgId, targetId });
      if (holdStateOf(state) === null) {
        expect(got, state).toEqual([]);
      } else {
        const [fx] = await sql<{ fixture_no: number; org: string; comp: string; div: string }[]>`
          select f.fixture_no, o.slug as org, c.slug as comp, d.slug as div from fixtures f
            join divisions d on d.id = f.division_id join competitions c on c.id = d.competition_id
            join organizations o on o.id = c.org_id where f.id = ${r.fixtureId}`;
        expect(got, state).toEqual([expect.objectContaining({
          sessionId: sid, targetId, fixtureId: r.fixtureId, matchNo: fx!.fixture_no, state: holdStateOf(state),
          href: routes.fixture(fx!.org, fx!.comp, fx!.div, fx!.fixture_no),
        })]);
      }
      checked++;
    }
    expect(checked).toBe(ACTIVE_STATES.length + TERMINAL_STATES.length);
  });

  it("a holder whose fixture was DELETED still holds, with fixtureId, href and matchNo null", async () => {
    const r = await holdRig();
    const targetId = r.targetId;
    await sessionOnTarget(r.auth.orgId, r.fixtureId, targetId, "live");
    await sql`update fixture_stream_sessions set fixture_id = null where target_id = ${targetId}`;
    const [h] = await holderRows(sql, { orgId: r.auth.orgId, targetId });
    expect(h).toMatchObject({ fixtureId: null, href: null, matchNo: null, courtName: null, state: "live" });
  });

  it("notFixtureId excludes THIS fixture's own session and nothing else; another org's session is never a holder", async () => {
    const r = await holdRig();
    const other = await holdRig();
    const targetId = r.targetId;
    await sessionOnTarget(r.auth.orgId, r.fixtureId, targetId, "warming");
    expect(await holderRows(sql, { orgId: r.auth.orgId, targetId, notFixtureId: r.fixtureId })).toEqual([]);
    expect(await holderRows(sql, { orgId: r.auth.orgId, targetId })).toHaveLength(1);
    expect(await holderRows(sql, { orgId: other.auth.orgId, targetId })).toEqual([]);
  });

  it("toTargetHolder refuses a TERMINAL row — 'a holder is active' is a guard, not a comment", () => {
    expect(() => toTargetHolder({
      session_id: "s", target_id: "t", state: "completed", fixture_id: null, fixture_no: null,
      court_name: null, label: "L", org_slug: null, comp_slug: null, div_slug: null,
    })).toThrow(/terminal/);
  });
});
```

Add to `stream-targets.test.ts`. Its existing header sets its own KEK and imports `createStreamTarget`/`listStreamTargets`.
Import `STREAM_PLATFORMS` and `STREAM_PLATFORM_PRESETS` from `@/lib/stream-destinations`, `readTargetSecret` and
`archiveStreamTarget` from `@/server/relay/secret-columns`, and `CreateStreamTarget` from `@/server/api-v1/schemas`.

```ts
  it("D6: create fills the url from the PLATFORM's preset — every platform, the stored url is the preset's canonical form", async () => {
    let checked = 0;
    for (const kind of STREAM_PLATFORMS) {
      const { auth } = await seedOrg();
      const made = await createStreamTarget(auth, auth.orgId, { kind, label: kind, streamKey: `k-${kind}-0123456789` });
      const stored = await sql.begin((tx) => readTargetSecret(tx, auth.orgId, made.id));
      const canonical = checkDestination(STREAM_PLATFORM_PRESETS[kind]);
      expect(canonical.ok, kind).toBe(true);
      expect(stored.url).toBe(canonical.ok ? canonical.url : "");
      checked++;
    }
    expect(checked).toBe(STREAM_PLATFORMS.length);
  });

  it("D6: the create schema refuses every kind outside STREAM_PLATFORMS and an rtmpUrl field; a stored legacy kind still LISTS", async () => {
    const legacy = StreamTargetKind.options.filter((k) => !(STREAM_PLATFORMS as readonly string[]).includes(k));
    expect(legacy.length).toBeGreaterThan(0);
    for (const kind of legacy) {
      expect(CreateStreamTarget.safeParse({ kind, label: "x", streamKey: "k" }).success, kind).toBe(false);
    }
    expect(CreateStreamTarget.safeParse({ kind: "youtube", label: "x", streamKey: "k", rtmpUrl: "rtmp://a.rtmp.youtube.com/live2" }).success).toBe(false);
    const { auth } = await seedOrg();
    await sql`insert into org_stream_targets (org_id, kind, label, rtmp_enc) values (${auth.orgId}, 'facebook', 'Old FB', ${Buffer.from("x")})`;
    expect((await listStreamTargets(auth, auth.orgId)).map((t) => t.kind)).toContain("facebook");
  });

  it("the list excludes ARCHIVED rows and carries keyHint + inUse:null for an idle row", async () => {
    const { auth } = await seedOrg();
    const keep = await createStreamTarget(auth, auth.orgId, { kind: "youtube", label: "Keep", streamKey: "abcd-1234-efgh-5678-ijkl" });
    const drop = await createStreamTarget(auth, auth.orgId, { kind: "twitch", label: "Drop", streamKey: "live_123_abcdefghijklmnopqrstuvwxyz" });
    await sql.begin((tx) => archiveStreamTarget(tx, auth.orgId, drop.id));
    const list = await listStreamTargets(auth, auth.orgId);
    expect(list.map((t) => t.id)).toEqual([keep.id]);
    expect(list[0]).toMatchObject({ keyHint: "ijkl".slice(-3), inUse: null });
  });

  it("Review Focus 1: a row whose envelope will not open lists with keyHint null — the list still answers", async () => {
    const { auth } = await seedOrg();
    await sql`insert into org_stream_targets (org_id, kind, label, rtmp_enc) values (${auth.orgId}, 'youtube', 'Unreadable', ${Buffer.from("not-a-real-envelope")})`;
    const list = await listStreamTargets(auth, auth.orgId);
    expect(list.find((t) => t.label === "Unreadable")).toMatchObject({ keyHint: null });
  });
```

Also update the existing G2/A18 cases that drive `rtmpUrl` refusals through `createStreamTarget`. Create no longer
takes a url, so those rules are now reachable only through `checkDestination`, which `stream-destinations.test.ts`
already pins per rule. Move each case's **assertion** to a `checkDestination(url)` call in `stream-destinations.test.ts`
if that file does not already pin the same rule and url; then delete the case. Record in the commit body which cases
moved and which were already pinned.

- [ ] **Step 3: Pin the presets against the one validator.** Add to `src/lib/__tests__/stream-destinations.test.ts`:

```ts
it("every platform preset passes checkDestination, and every platform has one (D6)", () => {
  let checked = 0;
  for (const p of STREAM_PLATFORMS) {
    expect(checkDestination(STREAM_PLATFORM_PRESETS[p]), p).toMatchObject({ ok: true });
    checked++;
  }
  expect(checked).toBe(STREAM_PLATFORMS.length);
  expect(Object.keys(STREAM_PLATFORM_PRESETS).sort()).toEqual([...STREAM_PLATFORMS].sort());
});
```

- [ ] **Step 4: Run and confirm red.**

```bash
cd /Users/ashokhein/github/seazn.club/.claude/worktrees/fixture-stream/apps/web && rm -f /tmp/fs-t2a.json && pnpm vitest run src/server/relay/domain/__tests__/hold-state.test.ts src/server/usecases/__tests__/stream-target-holders.test.ts src/server/usecases/__tests__/stream-targets.test.ts src/lib/__tests__/stream-destinations.test.ts --reporter=json --outputFile=/tmp/fs-t2a.json; echo EXIT=$?; jq '{p:.numPassedTests,t:.numTotalTests,f:.numFailedTests,files:[.testResults[].name]}' /tmp/fs-t2a.json
```

Expected: the new cases fail on missing exports. All four files are collected. A file that fails to **collect** shows
as a `testResults` entry with a `message`, so read it.

- [ ] **Step 5: Implement.**

`lib/stream-destinations.ts` (append; zero imports, no enums, because openapi-gen loads it under strip-types):

```ts
/** D6 (owner 2026-09-30): the platforms a NEW destination may name. Stored rows of other kinds keep listing and
 *  streaming until removed (spec §5.4), so the host allowlist above is NOT narrowed. A tuple, not an enum: this module
 *  is loaded under bare strip-types by openapi-gen. */
export const STREAM_PLATFORMS = ["youtube", "twitch"] as const;
export type StreamPlatform = (typeof STREAM_PLATFORMS)[number];

/** The ingest address the SERVER fills per platform — the organiser never types one (spec §4 "No server field").
 *  YouTube: rtmp://a.rtmp.youtube.com/live2 — delivered to YouTube on staging 2026-09-30 (spec §5.4).
 *  Twitch: Twitch's global auto-ingest, https://ingest.twitch.tv/ingests (read <date of Step 1>); its host is admitted
 *  by the `.global-contribute.live-video.net` entry above. Each passes `checkDestination` (stream-destinations.test.ts). */
export const STREAM_PLATFORM_PRESETS: Readonly<Record<StreamPlatform, string>> = {
  youtube: "rtmp://a.rtmp.youtube.com/live2",
  twitch: "rtmps://ingest.global-contribute.live-video.net/app",
};
```

`domain/session.ts` (after `isActive`, :20):

```ts
/** Spec §5.3 — how a person reads an ACTIVE session that holds a destination: a phone has connected (`live`, and
 *  `ending` while it drains) or not yet (`waiting`). Terminal sessions hold nothing. */
export type HoldState = "live" | "waiting";
export function holdStateOf(state: SessionState): HoldState | null {
  switch (state) {
    case "live":
    case "ending":
      return "live";
    case "requested":
    case "provisioning":
    case "warming":
      return "waiting";
    case "completed":
    case "failed":
      return null;
  }
}
```

`schemas.ts`: add the import `import { STREAM_PLATFORMS } from "../../lib/stream-destinations.ts";` (check whether the
file already imports from it). **Relative with `.ts`, never `@/`:** `scripts/openapi-gen.ts` loads schemas.ts under bare
`node --experimental-strip-types`, which has no `@/` alias (the file's own header, schemas.ts:11-20 and :33-48, says so;
openapi.ts:27 imports this same file this way). An `@/` import passes vitest and tsc and then kills `pnpm openapi:gen`
with ERR_MODULE_NOT_FOUND. Replace `CreateStreamTarget` and `StreamTarget` (:1361-1382):

```ts
/** D6: the platforms a NEW destination may name — a subset of `StreamTargetKind`, which stays whole for stored rows. */
export const StreamPlatform = z.enum(STREAM_PLATFORMS);
export type StreamPlatform = z.infer<typeof StreamPlatform>;

export const CreateStreamTarget = z
  .object({
    kind: StreamPlatform,
    label: z.string().min(1).max(80),
    /** The platform's stream key. The ingest URL is filled by the server from the platform's preset
     *  (lib/stream-destinations.ts STREAM_PLATFORM_PRESETS) — there is no url field (spec §5.2). */
    streamKey: z.string().min(1).max(200),
    watchUrl: streamUrlSchema.optional(),
  })
  .strict();
export type CreateStreamTarget = z.infer<typeof CreateStreamTarget>;

/** Spec §5.3 — the session holding a destination. Nullable fields: a holder whose fixture was deleted
 *  (`fixture_id` is `on delete set null`) still holds, and cannot be named or linked. `matchNo` is a number, never an
 *  English "Match n": every client renders it through its own locale's `breadcrumb.match`. */
export const StreamTargetHolder = z.object({
  sessionId: z.string(),
  fixtureId: z.string().nullable(),
  href: z.string().nullable(),
  matchNo: z.number().int().nullable(),
  courtName: z.string().nullable(),
  state: z.enum(["live", "waiting"]),
});
export type StreamTargetHolder = z.infer<typeof StreamTargetHolder>;

export const StreamTarget = z.object({
  id: z.string(),
  kind: StreamTargetKind,
  label: z.string(),
  watchUrl: z.string().nullable(),
  createdAt: z.string(),
  /** The key's last 3 characters, or null for a key under 12 characters or an envelope that will not open (§5.3). */
  keyHint: z.string().nullable(),
  inUse: StreamTargetHolder.nullable(),
});
export type StreamTarget = z.infer<typeof StreamTarget>;
```

`server/usecases/stream-target-holders.ts`:

```ts
import "server-only";
// server/usecases/stream-target-holders.ts — ONE answer to "which session holds this destination", read by the
// Directory list (`inUse`), Go live's refusal (`target_in_use`), and Replace key / Remove (`TARGET_IN_USE`). Spec
// §5.3 + §5.5. Held = an ACTIVE session references the target; this org's only (the target join is the tenancy floor).
import { sql, type Tx } from "@/lib/db";
import { routes } from "@/lib/routes";
import type { StreamTargetHolder } from "@/server/api-v1/schemas";
import { ACTIVE_STATES, holdStateOf, type HoldState, type SessionState } from "@/server/relay/domain/session";

type Executor = Tx | typeof sql;

export interface HolderRow {
  session_id: string; target_id: string; state: SessionState; fixture_id: string | null; fixture_no: number | null;
  court_name: string | null; label: string; org_slug: string | null; comp_slug: string | null; div_slug: string | null;
}

export interface TargetHolder {
  sessionId: string; targetId: string; fixtureId: string | null; href: string | null; matchNo: number | null;
  courtName: string | null; label: string; state: HoldState;
}

export function toTargetHolder(r: HolderRow): TargetHolder {
  const state = holdStateOf(r.state);
  if (state === null) throw new Error(`holderRows returned a terminal session ${r.session_id}`);
  const href = r.org_slug && r.comp_slug && r.div_slug && r.fixture_no !== null
    ? routes.fixture(r.org_slug, r.comp_slug, r.div_slug, r.fixture_no)
    : null;
  return {
    sessionId: r.session_id, targetId: r.target_id, fixtureId: r.fixture_id, href, matchNo: r.fixture_no,
    courtName: r.court_name, label: r.label, state,
  };
}

/** Oldest session first, so "the" holder of a target is stable across reads. `notFixtureId` leaves THIS fixture's own
 *  session out (`is distinct from`, so a deleted fixture's session still counts) — Go live's own-fixture case is
 *  `active_session`, answered elsewhere. */
export async function holderRows(
  exec: Executor, q: { orgId: string; targetId?: string; notFixtureId?: string },
): Promise<TargetHolder[]> {
  const targetId = q.targetId ?? null;
  const notFixtureId = q.notFixtureId ?? null;
  const rows = await exec<HolderRow[]>`
    select s.id as session_id, s.target_id, s.state, s.fixture_id, f.fixture_no, c.name as court_name, t.label,
           o.slug as org_slug, comp.slug as comp_slug, d.slug as div_slug
      from fixture_stream_sessions s
      join org_stream_targets t on t.id = s.target_id
      left join fixtures f on f.id = s.fixture_id
      left join courts c on c.id = f.court_id
      left join divisions d on d.id = f.division_id
      left join competitions comp on comp.id = d.competition_id
      left join organizations o on o.id = comp.org_id
     where t.org_id = ${q.orgId}
       and s.state in ${exec([...ACTIVE_STATES])}
       and (${targetId}::uuid is null or s.target_id = ${targetId}::uuid)
       and (${notFixtureId}::uuid is null or s.fixture_id is distinct from ${notFixtureId}::uuid)
     order by s.created_at asc, s.id asc`;
  return rows.map(toTargetHolder);
}

/** The 409 extra (Go live's `target_in_use`, PATCH/DELETE's `TARGET_IN_USE`). No session id: nothing a client does with it. */
export const wireHolder = (h: TargetHolder) => ({
  fixtureId: h.fixtureId, href: h.href, matchNo: h.matchNo, courtName: h.courtName, label: h.label, state: h.state,
});

/** The list's `inUse`. */
export const listHolder = (h: TargetHolder): StreamTargetHolder => ({
  sessionId: h.sessionId, fixtureId: h.fixtureId, href: h.href, matchNo: h.matchNo, courtName: h.courtName, state: h.state,
});
```

`stream-targets.ts`: change the imports and the two functions. Keep `REFUSAL_MESSAGE` and
`DestinationNotAllowedError`, which createSession still throws. Replace the file header's "rtmpUrl is checked HERE"
paragraph with "The ingest url is the platform's preset (D6); `checkDestination` still runs on it as a guard, so a
preset the allowlist stopped admitting refuses by rule, never silently."

```ts
import { sql } from "@/lib/db";
import { HttpError } from "@/lib/errors";
import { DESTINATION_NOT_ALLOWED, STREAM_PLATFORM_PRESETS, checkDestination, type DestinationRefusal } from "@/lib/stream-destinations";
import { streamUrlSchema } from "@/lib/stream-url";
import type { AuthCtx } from "@/server/api-v1/auth";
import type { CreateStreamTarget, StreamTarget } from "@/server/api-v1/schemas";
import { insertStreamTarget, readKeyHints, type StoredStreamTarget } from "@/server/relay/secret-columns";
import { holderRows, listHolder, type TargetHolder } from "./stream-target-holders";

export async function listStreamTargets(auth: AuthCtx, orgId: string): Promise<StreamTarget[]> {
  if (auth.orgId !== orgId) throw new HttpError(404, "organization not found");
  const [rows, hints, holders] = await Promise.all([
    sql<{ id: string; kind: StreamTarget["kind"]; label: string; watch_url: string | null; created_at: string }[]>`
      select id, kind, label, watch_url, created_at from org_stream_targets
       where org_id = ${orgId} and archived_at is null order by created_at asc`,
    sql.begin((tx) => readKeyHints(tx, orgId)) as Promise<Map<string, string | null>>,
    holderRows(sql, { orgId }),
  ]);
  const heldBy = new Map<string, TargetHolder>();
  for (const h of holders) if (!heldBy.has(h.targetId)) heldBy.set(h.targetId, h);
  return rows.map((r) => {
    const h = heldBy.get(r.id);
    return {
      id: r.id, kind: r.kind, label: r.label, watchUrl: r.watch_url, createdAt: new Date(r.created_at).toISOString(),
      keyHint: hints.get(r.id) ?? null, inUse: h ? listHolder(h) : null,
    };
  });
}

export async function createStreamTarget(auth: AuthCtx, orgId: string, body: CreateStreamTarget): Promise<StreamTarget> {
  if (auth.orgId !== orgId) throw new HttpError(404, "organization not found");
  // Task 9 review minor 7: whitespace around a pasted key is TRIMMED (it is part of no key a platform issues).
  const streamKey = body.streamKey.trim();
  const destination = checkDestination(STREAM_PLATFORM_PRESETS[body.kind]);
  if (!destination.ok) throw new DestinationNotAllowedError(destination.rule);
  if (streamKey === "") throw new HttpError(422, "The stream key is empty");
  const watch = body.watchUrl === undefined ? null : streamUrlSchema.safeParse(body.watchUrl);
  if (watch && !watch.success) throw new HttpError(422, "invalid watch link");
  const watchUrl = watch ? watch.data : null;
  const stored = (await sql.begin((tx) =>
    insertStreamTarget(tx, { orgId, kind: body.kind, label: body.label, watchUrl, rtmp: { url: destination.url, streamKey } }),
  )) as StoredStreamTarget;
  return (await listStreamTargets(auth, orgId)).find((t) => t.id === stored.id)
    ?? (() => { throw new HttpError(409, "the destination changed while it was being saved; try again"); })();
}
```

The last line reads the reply back through the list, so `keyHint` and `inUse` come from the one projection. A row
archived between the insert and the read-back is a 409 retry, never a 500.

`fakes.ts` `outputState` (:182-187):

```ts
/** A destination whose stream KEY starts with this is refused by the fake "platform" — how a walkthrough drives
 *  `target_rejected` now that the ingest url is a server preset (D6) and no longer carries a "reject" host. */
export const FAKE_REJECT_KEY_PREFIX = "reject-";
```

```ts
    return row.outputs.some((o) => new URL(o.url).hostname.includes("reject") || o.streamKey.startsWith(FAKE_REJECT_KEY_PREFIX)) ? "rejected" : "ok";
```

Add a `fakes.test.ts` case: an output whose key starts with `FAKE_REJECT_KEY_PREFIX` reads `rejected`, and the same
url with another key reads `ok`.

`fixture-stream-panel.tsx`:
- `TARGET_KINDS` becomes `STREAM_PLATFORMS`, imported from `@/lib/stream-destinations`. Keep the export name
  `TARGET_KINDS` (it is the form's option list).
- The panel test that holds it equal to the enum now holds it equal to `StreamPlatform.options`.
- In `TargetForm`, delete the `stream-target-rtmp` input and its state, and send `{kind, label, streamKey, watchUrl}`.
- Leave the rest of the form (T8 removes it).

`stream-sessions.test.ts` `rig()` (:199):
- Its `targetHost` option is meaningless once the url is a preset, so replace it with `streamKey?: string`, sent as
  `streamKey: opts.streamKey ?? "yt-key"`, and drop the `rtmpUrl` line.
- Its three reject callers (:734, :2041, and the `p.host` sweep at :3261) pass
  `streamKey: \`${FAKE_REJECT_KEY_PREFIX}${randomUUID()}\`` where they passed `targetHost: "reject.restream.io"`.
- The :724 twitch caller drops `targetHost`.
- The :3261 sweep keeps one row per case. Rows whose `p.host` was a plain provider host become default-key rows, and
  that sweep's own count assertion must still hold. Re-read the sweep's title: if it claims per-host coverage, retitle
  it to what it now covers (per-host acceptance is pinned in `stream-destinations.test.ts`). **Never leave a title
  that claims more than its rows.**

Walkthroughs:
- `addTargetApi(page, orgId, t: {label: string; kind?: "youtube" | "twitch"; streamKey?: string})` sends
  `{kind: t.kind ?? "youtube", label, streamKey: t.streamKey ?? \`e2e-${randomBytes(6).toString("hex")}\`}`.
- A6 (refused destination) seeds `streamKey: \`${FAKE_REJECT_KEY_PREFIX}${randomBytes(6).toString("hex")}\`` with
  `kind: "youtube"`, and keeps every assertion. Import the constant as a string literal `"reject-"`, with a comment
  naming `fakes.ts FAKE_REJECT_KEY_PREFIX`. The e2e files cannot import server code.
- A1 (the UI add form): drop the RTMP fill and keep every other assertion.
- A8 (the platform list and off-list host):
  - the off-list host assertion is no longer reachable through the UI or API;
  - the per-provider acceptance moves to `stream-destinations.test.ts` (it already pins per-provider hosts);
  - A8 keeps asserting that the form offers exactly `YouTube` and `Twitch`;
  - T8 relocates it to the Directory spec.

- [ ] **Step 6: Run T2a's scope.**

```bash
cd /Users/ashokhein/github/seazn.club/.claude/worktrees/fixture-stream/apps/web && rm -f /tmp/fs-t2a.json && pnpm vitest run src/server/relay/domain/__tests__/hold-state.test.ts src/server/usecases/__tests__/stream-target-holders.test.ts src/server/usecases/__tests__/stream-targets.test.ts src/lib/__tests__/stream-destinations.test.ts src/server/relay/__tests__/fakes.test.ts src/server/relay/__tests__/secret-columns.test.ts src/server/relay/__tests__/enc-boundary.test.ts src/server/usecases/__tests__/stream-sessions.test.ts "src/app/api/v1/fixtures/[id]/stream-sessions/__tests__/routes.test.ts" src/server/api-v1/__tests__/stream-contract.test.ts src/components/v2/__tests__/fixture-stream-panel.test.tsx --reporter=json --outputFile=/tmp/fs-t2a.json; echo EXIT=$?; jq '{p:.numPassedTests,t:.numTotalTests,f:.numFailedTests,files:[.testResults[].name]}' /tmp/fs-t2a.json
```

Also run the two relay test files the grep listed (`src/server/usecases/__tests__/relay-internal-routes.test.ts`,
`src/server/usecases/__tests__/relay-sweep.test.ts`) by their exact paths. Expected: `f: 0`, and every path appears in
`files`.

Then regenerate the OpenAPI documents, because T2a changed `CreateStreamTarget`, `StreamTarget` and the POST summary,
and CI's drift check would red on T2a's commit alone:
`cd /Users/ashokhein/github/seazn.club/.claude/worktrees/fixture-stream && pnpm openapi:gen && git diff --stat -- openapi/`.
Expected: exit 0, and `openapi/v1.json` and `openapi/v1.public.json` both change.

- [ ] **Step 7: Mutate once each.**
  - `holdStateOf`: `case "ending"` moved under `"waiting"`. Red: "live and ending read 'live'".
  - `toTargetHolder`: the terminal throw deleted. Red: "toTargetHolder refuses a TERMINAL row".
  - `listStreamTargets`: `and archived_at is null` deleted. Red: "the list excludes ARCHIVED rows".
  - `createStreamTarget`: `STREAM_PLATFORM_PRESETS[body.kind]` replaced by the YouTube literal. Red: "fills the url
    from the PLATFORM's preset" (the twitch iteration).
  - `holderRows`: the `notFixtureId` predicate deleted. Red: "notFixtureId excludes THIS fixture's own session".

- [ ] **Step 8: Walkthroughs touched by the helper change, whole files.** With a prod build of this worktree
  (`seazn-local-env`):

```bash
cd /Users/ashokhein/github/seazn.club/.claude/worktrees/fixture-stream/apps/web && PLAYWRIGHT_BASE=http://localhost:3000 pnpm exec playwright test e2e/walkthrough/stream-relay.spec.ts e2e/walkthrough/stream-credits.spec.ts --project=walkthrough --reporter=line; echo EXIT=$?
```

Expected: EXIT=0, with the passed count equal to the file's test count. Paste the counts into the task report.

- [ ] **Step 9: Typecheck and lint.**
  `cd …/apps/web && rtk proxy pnpm typecheck && rtk proxy pnpm lint`. Expected: exit 0 and `✖ 0 problems`, or no ✖
  line.

- [ ] **Step 10: Commit.** Commit every file above with
  `feat(stream): create by platform preset, list keyHint + inUse, one holders module (T2a)`, with the mutation list in
  the body. The commit includes the regenerated `openapi/v1.json` and `openapi/v1.public.json` from Step 6.

### Task 2b: Rename, replace key, remove — the routes, the row locks and the contract

**Files:**
- Modify: `apps/web/src/server/api-v1/schemas.ts` (after `StreamTarget`: `PatchStreamTarget`, `StreamTargetRemoved`)
- Modify: `apps/web/src/server/usecases/stream-targets.ts` (append `patchStreamTarget`, `removeStreamTarget`, `targetHeld`)
- Create: `apps/web/src/app/api/v1/orgs/[id]/stream-targets/[targetId]/route.ts`
- Modify: `apps/web/src/server/usecases/stream-sessions.ts`:
  - :1054-1069: drop the target read from the `Promise.all`;
  - :1071-1078: lock inside the admission transaction;
  - append `expireTargetHolders`.
- Modify: `apps/web/src/server/api-v1/openapi.ts:223-224` (two ROUTES rows) and `ERROR_SCHEMA_OVERRIDES` :641
- Modify: `apps/web/src/server/api-v1/key-scopes.ts:341-342` (two entries)
- Modify: `scripts/smoke.ts` (new `streamTargetsSuite`, called in `main()` after `streamOverlaySuite`; the
  `SELECTABLE_SUITES` registry, `subsetSetup`, `runSubset` and the selected entry point)
- Create: `scripts/smoke-select.ts` (`selectSmokeSuites`, `SmokeSelectionError`)
- Test (new): `scripts/__tests__/smoke-select.test.ts`
- Test: `apps/web/src/server/usecases/__tests__/stream-targets.test.ts` (PATCH and DELETE cases; the row lock from
  Remove's and Replace key's side)
- Test: `apps/web/src/server/usecases/__tests__/stream-sessions.test.ts` (archived refused; the lock test from Go
  live's side; the §9.1 "replace a key, then go live" sequence)
- Test: `apps/web/src/server/relay/__tests__/_session-rig.ts` (`sessionOnTarget` gains an optional executor)
- Test: `apps/web/src/app/api/v1/orgs/[id]/stream-targets/__tests__/target-route.test.ts` (new: the route wiring and envelopes)
- Test: `apps/web/src/server/api-v1/__tests__/stream-contract.test.ts:212-219` (five becomes seven)

**Interfaces:**
- Consumes:
  - from T1: `lockStreamTarget`, `archiveStreamTarget`, `replaceTargetKey`;
  - from T2a: `holderRows`, `wireHolder`, `listStreamTargets`.
- Produces:
  - `PatchStreamTarget`: exactly one of `{label}` / `{streamKey}` (strict + refine).
  - `StreamTargetRemoved = {removed: true}`.
  - `patchStreamTarget(auth, orgId, targetId, body): Promise<StreamTarget>`.
  - `removeStreamTarget(auth, orgId, targetId): Promise<{removed: true}>`.
  - 409 `TARGET_IN_USE` with extra `{holder: wireHolder}`; 409 `DESTINATION_DUPLICATE` with extra
    `{other: {id, label}}`; 404 for an archived, foreign or absent target; 422 for an empty key.
  - `expireTargetHolders(orgId, targetId, deps): Promise<void>` (stream-sessions.ts), which the route calls before
    the use-case.

- [ ] **Step 1: Write the failing use-case tests** (append to `stream-targets.test.ts`). For the "held" cases, seed a
  session row in each ACTIVE state with T2a's `holdRig` and `sessionOnTarget` (`_session-rig.ts`). The target must be
  a REAL sealed one, because Replace key opens the envelope, so each case creates it through `createStreamTarget`
  rather than using `holdRig`'s fake-envelope `targetId`. `realTarget` below does that.

```ts
  /** holdRig's org and fixture, with a REAL sealed youtube target (a fresh key each call). */
  const realTarget = async () => {
    const r = await holdRig();
    const t = await createStreamTarget(r.auth, r.auth.orgId, { kind: "youtube", label: "Real", streamKey: `k-${randomUUID()}` });
    return { ...r, targetId: t.id };
  };

  it("rename: allowed at ANY time — idle, waiting and live; the reply is the list's own row", async () => {
    let checked = 0;
    for (const state of [null, ...ACTIVE_STATES] as const) {
      const r = await realTarget();
      const targetId = r.targetId;
      if (state) await sessionOnTarget(r.auth.orgId, r.fixtureId, targetId, state);
      const got = await patchStreamTarget(r.auth, r.auth.orgId, targetId, { label: `Renamed ${state ?? "idle"}` });
      expect(got).toMatchObject({ id: targetId, label: `Renamed ${state ?? "idle"}` });
      checked++;
    }
    expect(checked).toBe(ACTIVE_STATES.length + 1);
  });

  it("replace key and remove are REFUSED 409 TARGET_IN_USE in EVERY active state, naming the holder; allowed in every terminal one", async () => {
    let checked = 0;
    for (const state of [...ACTIVE_STATES, ...TERMINAL_STATES]) {
      for (const op of ["replace", "remove"] as const) {
        const r = await realTarget();
        const targetId = r.targetId;
        await sessionOnTarget(r.auth.orgId, r.fixtureId, targetId, state);
        const call = op === "replace"
          ? patchStreamTarget(r.auth, r.auth.orgId, targetId, { streamKey: `k-${randomUUID()}` })
          : removeStreamTarget(r.auth, r.auth.orgId, targetId);
        if (holdStateOf(state) === null) {
          await expect(call, `${op} ${state}`).resolves.toBeTruthy();
        } else {
          await expect(call, `${op} ${state}`).rejects.toMatchObject({
            status: 409, code: "TARGET_IN_USE",
            extra: { holder: expect.objectContaining({ fixtureId: r.fixtureId, state: holdStateOf(state) }) },
          });
        }
        checked++;
      }
    }
    expect(checked).toBe(2 * (ACTIVE_STATES.length + TERMINAL_STATES.length));
  });

  it("replace key onto a key ANOTHER active destination holds is 409 DESTINATION_DUPLICATE naming it; nothing is re-sealed", async () => {
    const { auth } = await seedOrg();
    const a = await createStreamTarget(auth, auth.orgId, { kind: "youtube", label: "A", streamKey: "aaaa-1111-bbbb-2222-cccc" });
    const b = await createStreamTarget(auth, auth.orgId, { kind: "youtube", label: "B", streamKey: "dddd-3333-eeee-4444-ffff" });
    await expect(patchStreamTarget(auth, auth.orgId, b.id, { streamKey: "aaaa-1111-bbbb-2222-cccc" }))
      .rejects.toMatchObject({ status: 409, code: "DESTINATION_DUPLICATE", extra: { other: { id: a.id, label: "A" } } });
    expect((await sql.begin((tx) => readTargetSecret(tx, auth.orgId, b.id))).streamKey).toBe("dddd-3333-eeee-4444-ffff");
  });

  it("Review Focus 2: replace key TRIMS surrounding whitespace and newlines (same fingerprint as create); whitespace-only is 422", async () => {
    const { auth } = await seedOrg();
    const t = await createStreamTarget(auth, auth.orgId, { kind: "youtube", label: "T", streamKey: "aaaa-1111-bbbb-2222-cccc" });
    await patchStreamTarget(auth, auth.orgId, t.id, { streamKey: "  abcd-1234-efgh-5678-ijkl\n" });
    expect((await sql.begin((tx) => readTargetSecret(tx, auth.orgId, t.id))).streamKey).toBe("abcd-1234-efgh-5678-ijkl");
    await expect(patchStreamTarget(auth, auth.orgId, t.id, { streamKey: "   " })).rejects.toMatchObject({ status: 422 });
  });

  it("remove archives: gone from the list, 404 the second time, and re-adding the same key RESTORES the same id (sequence)", async () => {
    const { auth } = await seedOrg();
    const t = await createStreamTarget(auth, auth.orgId, { kind: "twitch", label: "Tw", streamKey: "live_42_abcdefghijklmnopqrstu" });
    await removeStreamTarget(auth, auth.orgId, t.id);
    expect((await listStreamTargets(auth, auth.orgId)).map((x) => x.id)).not.toContain(t.id);
    await expect(removeStreamTarget(auth, auth.orgId, t.id)).rejects.toMatchObject({ status: 404 });
    await expect(patchStreamTarget(auth, auth.orgId, t.id, { label: "x" })).rejects.toMatchObject({ status: 404 });
    const back = await createStreamTarget(auth, auth.orgId, { kind: "twitch", label: "Tw again", streamKey: "live_42_abcdefghijklmnopqrstu" });
    expect(back).toMatchObject({ id: t.id, label: "Tw again" });
  });

  it("another org's target is 404 for rename, replace and remove — never a 409 that confirms it exists", async () => {
    const a = await seedOrg();
    const b = await seedOrg();
    const t = await createStreamTarget(a.auth, a.auth.orgId, { kind: "youtube", label: "A", streamKey: "aaaa-1111-bbbb-2222-cccc" });
    for (const call of [
      () => patchStreamTarget(b.auth, b.auth.orgId, t.id, { label: "x" }),
      () => patchStreamTarget(b.auth, b.auth.orgId, t.id, { streamKey: "k-0123456789ab" }),
      () => removeStreamTarget(b.auth, b.auth.orgId, t.id),
    ]) await expect(call()).rejects.toMatchObject({ status: 404 });
  });

  it("the ROW LOCK, Remove's side and Replace key's side: each WAITS on a Go live holding the target, then refuses 409 once that Go live's session commits", async () => {
    let checked = 0;
    for (const op of ["remove", "replace"] as const) {
      const r = await realTarget();
      let release!: () => void;
      const held = new Promise<void>((res) => { release = res; });
      let locked!: () => void;
      const lockTaken = new Promise<void>((res) => { locked = res; });
      // Transaction A plays createSession's admission: lock the target, write a `requested` session on it, hold.
      const goLive = sql.begin(async (tx) => {
        expect(await lockStreamTarget(tx, r.auth.orgId, r.targetId)).toBe(true);
        await sessionOnTarget(r.auth.orgId, r.fixtureId, r.targetId, "requested", tx);
        locked();
        await held;
      });
      try {
        await lockTaken;
        let settled = false;
        const write = (op === "remove"
          ? removeStreamTarget(r.auth, r.auth.orgId, r.targetId)
          : patchStreamTarget(r.auth, r.auth.orgId, r.targetId, { streamKey: `k-${randomUUID()}` })
        ).finally(() => { settled = true; });
        write.catch(() => {});                                 // observed below; no unhandled rejection meanwhile
        await new Promise((res) => setTimeout(res, 300));
        expect(settled, `${op} did not wait on the target row lock`).toBe(false);
        release();
        await goLive;
        // Under READ COMMITTED the waiter re-reads after A commits: the session A wrote is now the holder.
        await expect(write, op).rejects.toMatchObject({ status: 409, code: "TARGET_IN_USE" });
        checked++;
      } finally {
        release();                                             // a red above must not leave tx A holding the lock
        await goLive.catch(() => {});                          // …or its pooled connection, until teardown times out
      }
    }
    expect(checked).toBe(2);
  });

  it("PatchStreamTarget: exactly one of label / streamKey", () => {
    expect(PatchStreamTarget.safeParse({ label: "x" }).success).toBe(true);
    expect(PatchStreamTarget.safeParse({ streamKey: "k" }).success).toBe(true);
    expect(PatchStreamTarget.safeParse({}).success).toBe(false);
    expect(PatchStreamTarget.safeParse({ label: "x", streamKey: "k" }).success).toBe(false);
    expect(PatchStreamTarget.safeParse({ label: "x", rtmpUrl: "rtmp://a.rtmp.youtube.com/live2" }).success).toBe(false);
  });
```

Append to `stream-sessions.test.ts`, beside the G-T6 race test (:2973), and reuse its `rig()` and `deps`:

```ts
  it("an ARCHIVED target is refused at createSession with the existing not-found shape: 404, no live input, no machine, no session row", async () => {
    const r = await rig();
    await removeStreamTarget(r.auth, r.auth.orgId, r.target.id);
    const ingestSpy = vi.spyOn(r.ingest, "createLiveInput");
    try {
      await expect(createSession(r.auth, r.fixtureId, body(r.target.id), r.deps))
        .rejects.toMatchObject({ status: 404, message: "stream target not found" });
      expect(ingestSpy).not.toHaveBeenCalled();
    } finally {
      ingestSpy.mockRestore();
    }
    expect(r.runner.created).toEqual([]);
    const [{ n }] = await sql<{ n: number }[]>`select count(*)::int as n from fixture_stream_sessions where fixture_id = ${r.fixtureId}`;
    expect(n).toBe(0);
  });

  it("the ROW LOCK: createSession WAITS on a transaction that holds the target FOR UPDATE, and an archive committed there makes it 404", async () => {
    const r = await rig();
    let release!: () => void;
    const held = new Promise<void>((res) => { release = res; });
    let locked!: () => void;
    const lockTaken = new Promise<void>((res) => { locked = res; });
    const holder = sql.begin(async (tx) => {
      expect(await lockStreamTarget(tx, r.auth.orgId, r.target.id)).toBe(true);
      locked();
      await held;
      await archiveStreamTarget(tx, r.auth.orgId, r.target.id);
    });
    try {
      await lockTaken;
      let settled = false;
      const start = createSession(r.auth, r.fixtureId, body(r.target.id), r.deps)
        .finally(() => { settled = true; });
      start.catch(() => {});                                 // observed below; no unhandled rejection meanwhile
      await new Promise((res) => setTimeout(res, 300));
      expect(settled, "createSession did not wait on the target row lock").toBe(false);
      release();
      await holder;
      await expect(start).rejects.toMatchObject({ status: 404, message: "stream target not found" });
    } finally {
      release();                                             // a red above must not leave the holder tx open
      await holder.catch(() => {});
    }
  });
```

`rig()` (:199) is the file's own; it returns `target` (use `r.target.id`), `ingest`, `runner`, `deps`, `auth` and
`fixtureId`. The archived test does **not** assert "zero provider calls": the refusal is inside the admission
transaction, after `storageUsage()` in `createSession`'s `Promise.all` (stream-sessions.ts:1054-1069), which G-T1's idiom
counts as a provider call. Spec §5.2 asks only for "the existing not-found shape", and the test pins exactly that, plus
no live input, no Machine and no row. T2a already replaced `rig()`'s `targetHost` option with `streamKey` (see T2a
Step 5).

Append to `stream-sessions.test.ts` the §9.1 sequence **replace a key, then go live**. It is the seam between the
writer (`replaceTargetKey` reseals `rtmp_enc` and refingerprints) and the reader (createSession's `readTargetSecret`
and `addOutput`), and nothing else drives both:

```ts
  it("§9.1 sequence — replace a key, THEN go live: the output dials the NEW key, and the old key is dialled nowhere", async () => {
    const r = await rig({ credits: 1 });
    const before = await sql.begin((tx) => readTargetSecret(tx, r.auth.orgId, r.target.id));
    const newKey = `k-${randomUUID()}`;
    expect(newKey).not.toBe(before.streamKey);                        // or the test cannot tell the two apart
    await patchStreamTarget(r.auth, r.auth.orgId, r.target.id, { streamKey: newKey });
    const added = vi.spyOn(r.ingest, "addOutput");
    try {
      await createSession(r.auth, r.fixtureId, body(r.target.id), r.deps);
      expect(added).toHaveBeenCalledTimes(1);
      expect(added.mock.calls[0]![1]).toMatchObject({ url: before.url, streamKey: newKey });
    } finally {
      added.mockRestore();
    }
    expect(r.ingest.liveOutputsTo({ url: before.url, streamKey: newKey })).toBe(1);
    expect(r.ingest.liveOutputsTo(before)).toBe(0);
  });
```

Import `patchStreamTarget` from `../stream-targets` and `readTargetSecret` from `@/server/relay/secret-columns` if the
file does not already.

- [ ] **Step 2: Write the failing contract and route tests.**
  - `stream-contract.test.ts:212-219` becomes "exactly the SEVEN relay operations", with the list plus
    `"DELETE /orgs/:id/stream-targets/:targetId"` and `"PATCH /orgs/:id/stream-targets/:targetId"`. The next `it`
    already checks that each is in `NEVER_KEY_ROUTES` and resolves to no key rule, so no second edit is needed.
  - Create `apps/web/src/app/api/v1/orgs/[id]/stream-targets/__tests__/target-route.test.ts`, following the existing
    `…/fixtures/[id]/stream-sessions/__tests__/routes.test.ts` harness (read it for how it builds an authed `Request`
    and a session cookie).
  - Cases:
    - PATCH `{label}` gives 200 and the row;
    - PATCH `{}` gives 400 VALIDATION;
    - DELETE gives 200 `{removed: true}`, then 404;
    - a held DELETE gives 409, whose body `error.code === "TARGET_IN_USE"` and whose `error.holder.matchNo` equals
      the seeded fixture's `fixture_no`;
    - an API-key caller gets the refusal `NEVER_KEY_ROUTES` produces (assert the same status the sibling
      stream-targets POST test asserts for a key caller);
    - wire ⊆ spec: each refusal body validates against `ERROR_SCHEMA_OVERRIDES["PATCH /orgs/{id}/stream-targets/{targetId}"][409]`
      (and DELETE's), the same way `routes.test.ts` checks the create's.

- [ ] **Step 3: Run and confirm red.**

```bash
cd /Users/ashokhein/github/seazn.club/.claude/worktrees/fixture-stream/apps/web && rm -f /tmp/fs-t2b.json && pnpm vitest run src/server/usecases/__tests__/stream-targets.test.ts src/server/usecases/__tests__/stream-sessions.test.ts src/server/api-v1/__tests__/stream-contract.test.ts "src/app/api/v1/orgs/[id]/stream-targets/__tests__/target-route.test.ts" --reporter=json --outputFile=/tmp/fs-t2b.json; echo EXIT=$?; jq '{p:.numPassedTests,t:.numTotalTests,f:.numFailedTests,files:[.testResults[].name]}' /tmp/fs-t2b.json
```

- [ ] **Step 4: Implement.**

`schemas.ts` (after `StreamTarget`):

```ts
/** Spec §5.2 — Rename (`{label}`, allowed at any time) or Replace key (`{streamKey}`, refused while held). Exactly one. */
export const PatchStreamTarget = z
  .object({ label: z.string().min(1).max(80).optional(), streamKey: z.string().min(1).max(200).optional() })
  .strict()
  .refine((b) => (b.label === undefined) !== (b.streamKey === undefined), { message: "send exactly one of label or streamKey" });
export type PatchStreamTarget = z.infer<typeof PatchStreamTarget>;
export const StreamTargetRemoved = z.object({ removed: z.literal(true) });
```

`stream-targets.ts` (append; extend the secret-columns import with `archiveStreamTarget`, `lockStreamTarget`,
`replaceTargetKey`, and the holders import with `wireHolder`):

```ts
/** Spec §5.2 — 409 TARGET_IN_USE, naming the match that holds the destination. Uppercase: the spec's code for the
 *  Directory's refusals (Go live's own refusal keeps its lowercase `target_in_use`). */
export function targetHeld(h: TargetHolder): HttpError {
  return new HttpError(
    409,
    `the destination "${h.label}" is ${h.state === "live" ? "live" : "waiting for a phone"} on ${h.matchNo === null ? "another match" : `match ${h.matchNo}`}`,
    "TARGET_IN_USE",
    { holder: wireHolder(h) },
  );
}

const targetNotFound = () => new HttpError(404, "stream target not found");

export async function patchStreamTarget(auth: AuthCtx, orgId: string, targetId: string, body: PatchStreamTarget): Promise<StreamTarget> {
  if (auth.orgId !== orgId) throw new HttpError(404, "organization not found");
  if (body.label !== undefined) {
    const renamed = await sql<{ id: string }[]>`
      update org_stream_targets set label = ${body.label}
       where id = ${targetId} and org_id = ${orgId} and archived_at is null returning id`;
    if (renamed.length === 0) throw targetNotFound();
  } else {
    // Review Focus 2: trimmed exactly as create trims, so a re-paste of the same key fingerprints the same.
    const streamKey = (body.streamKey ?? "").trim();
    if (streamKey === "") throw new HttpError(422, "The stream key is empty");
    await sql.begin(async (tx) => {
      if (!(await lockStreamTarget(tx, orgId, targetId))) throw targetNotFound();
      const [holder] = await holderRows(tx, { orgId, targetId });
      if (holder) throw targetHeld(holder);
      const r = await replaceTargetKey(tx, orgId, targetId, streamKey);
      if (r.ok) return;
      if (r.reason === "not_found") throw targetNotFound();
      if (r.reason === "undialable") throw new DestinationNotAllowedError(r.rule);
      throw new HttpError(409, `that stream key is already saved as "${r.other.label}"`, "DESTINATION_DUPLICATE", { other: r.other });
    });
  }
  const row = (await listStreamTargets(auth, orgId)).find((t) => t.id === targetId);
  if (!row) throw targetNotFound();
  return row;
}

/** D2 — Remove is an archive, refused while held. The lock is taken BEFORE the holder check, and createSession takes
 *  the same lock in its admission transaction, so a Remove and a Go live on one destination serialise. */
export async function removeStreamTarget(auth: AuthCtx, orgId: string, targetId: string): Promise<{ removed: true }> {
  if (auth.orgId !== orgId) throw new HttpError(404, "organization not found");
  await sql.begin(async (tx) => {
    if (!(await lockStreamTarget(tx, orgId, targetId))) throw targetNotFound();
    const [holder] = await holderRows(tx, { orgId, targetId });
    if (holder) throw targetHeld(holder);
    await archiveStreamTarget(tx, orgId, targetId);
  });
  return { removed: true };
}
```

Add `PatchStreamTarget` to the schemas type import.

`stream-sessions.ts`:
- In `createSession`'s `Promise.all` (:1054-1069), delete the element
  `` sql<{ id: string }[]>`select id from org_stream_targets where id = ${body.targetId} and org_id = ${orgId}`, ``
  and `target` from the destructuring.
- Inside `sql.begin(async (tx) => {` (:1071), before `admit`:

```ts
    // Spec §5.2: the target ROW LOCK, taken inside the admission transaction and BEFORE admit reads it — Replace key and
    // Remove take the same lock, so a Remove cannot interleave with this Go live. An archived target is absent here
    // (`archived_at is null`), so `admit` answers the existing 404 target_not_found shape.
    const targetBelongsToOrg = await lockStreamTarget(tx, orgId, body.targetId);
```

- Pass `targetBelongsToOrg` to `admit` in place of `target.length === 1`, and add `lockStreamTarget` to the
  secret-columns import at :38.
- Append:

```ts
/** D2 — before Replace key or Remove reads "held", each current holder of the target gets its lazy expiry, the tick
 *  Go live's `targetHolderFor` already gives it: a session stuck past its deadline must not refuse a Remove forever.
 *  Outside any transaction (expiry may call the provider). Called by the stream-targets [targetId] route. */
export async function expireTargetHolders(orgId: string, targetId: string, deps: SessionDeps): Promise<void> {
  for (const h of await holderRows(sql, { orgId, targetId })) await applyExpiry(h.sessionId, deps);
}
```

- Add `import { holderRows } from "./stream-target-holders";`.

`app/api/v1/orgs/[id]/stream-targets/[targetId]/route.ts`:

```ts
import { v1, parseBody } from "@/server/api-v1/http";
import { requireOrgAuth, assertUuid } from "@/server/api-v1/auth";
import { PatchStreamTarget } from "@/server/api-v1/schemas";
import { patchStreamTarget, removeStreamTarget } from "@/server/usecases/stream-targets";
import { defaultDeps, expireTargetHolders } from "@/server/usecases/stream-sessions";
import { baseUrl } from "@/lib/oauth";

type Ctx = { params: Promise<{ id: string; targetId: string }> };

/** Spec §5.2 — Rename / Replace key. Org write, never key-reachable (key-scopes.ts NEVER_KEY_ROUTES: a target carries
 *  a stream key). A Replace first ticks the holders' expiry so a stuck session does not refuse it. */
export async function PATCH(req: Request, { params }: Ctx) {
  return v1(async () => {
    const { id, targetId } = await params;
    assertUuid(id, "organization");
    assertUuid(targetId, "stream target");
    const body = await parseBody(req, PatchStreamTarget);
    const auth = await requireOrgAuth(req, id, "write");
    if (body.streamKey !== undefined && auth.orgId === id) await expireTargetHolders(id, targetId, defaultDeps(baseUrl(req)));
    return patchStreamTarget(auth, id, targetId, body);
  });
}

/** Spec §5.2 — Remove = archive (D2). 409 TARGET_IN_USE while held; 404 once archived. */
export async function DELETE(req: Request, { params }: Ctx) {
  return v1(async () => {
    const { id, targetId } = await params;
    assertUuid(id, "organization");
    assertUuid(targetId, "stream target");
    const auth = await requireOrgAuth(req, id, "write");
    if (auth.orgId === id) await expireTargetHolders(id, targetId, defaultDeps(baseUrl(req)));
    return removeStreamTarget(auth, id, targetId);
  });
}
```

Check `assertUuid`'s second argument against its signature in `server/api-v1/auth.ts`, and use the noun form the
court route uses.

`openapi.ts`:
- Rewrite the POST row's summary (:224): "Add a streaming destination (YouTube or Twitch). The ingest URL is filled per
  platform; the key is sealed at rest (AES-256-GCM). The same key again returns the existing destination, or restores
  a removed one."
- Add after it:

```ts
  { path: "/orgs/{id}/stream-targets/{targetId}", method: "patch", summary: "Rename a streaming destination ({label}, allowed while in use) or replace its stream key ({streamKey}; 409 TARGET_IN_USE while a match is live or waiting on it, 409 DESTINATION_DUPLICATE when another destination already holds that key)", tag: "fixtures", request: S.PatchStreamTarget, response: S.StreamTarget, errors: [404, 409, 422] },
  { path: "/orgs/{id}/stream-targets/{targetId}", method: "delete", summary: "Remove a streaming destination — an archive: hidden from every list, history keeps its name, and adding the same key again restores it. 409 TARGET_IN_USE while a match is live or waiting on it; 404 once removed", tag: "fixtures", response: S.StreamTargetRemoved, errors: [404, 409] },
```

- Beside `STREAM_SESSION_CREATE_ERRORS`, add:

```ts
const STREAM_TARGET_HOLDER_PROPERTIES = {
  type: "object",
  description: "On TARGET_IN_USE (409): the match whose stream holds the destination (always this organisation's)",
  properties: {
    fixtureId: { type: ["string", "null"], format: "uuid", description: "The holding fixture; null if it was deleted" },
    href: { type: ["string", "null"], description: "The holding fixture's organiser page; null if it was deleted" },
    matchNo: { type: ["integer", "null"], description: "The holding fixture's number in its division; null if it was deleted" },
    courtName: { type: ["string", "null"], description: "The holding fixture's court, when it has one" },
    label: { type: "string", description: "The destination's own label" },
    state: { enum: ["live", "waiting"], description: "live = a phone is sending (live or ending); waiting = requested, provisioning or warming" },
  },
} as const;
const STREAM_TARGET_WRITE_409 = scopedErrorEnvelope({
  holder: STREAM_TARGET_HOLDER_PROPERTIES,
  other: {
    type: "object",
    description: "On DESTINATION_DUPLICATE (409): the active destination that already holds this stream key",
    properties: { id: { type: "string", format: "uuid" }, label: { type: "string" } },
  },
});
```

- Add to `ERROR_SCHEMA_OVERRIDES`:
  `"PATCH /orgs/{id}/stream-targets/{targetId}": { 409: STREAM_TARGET_WRITE_409, 422: DESTINATION_NOT_ALLOWED_ENVELOPE }`
  and `"DELETE /orgs/{id}/stream-targets/{targetId}": { 409: STREAM_TARGET_WRITE_409 }`.
- Then regenerate: `cd /Users/ashokhein/github/seazn.club/.claude/worktrees/fixture-stream && pnpm openapi:gen`. It
  rewrites `openapi/v1.json` and `openapi/v1.public.json`; commit both, because CI's drift check compares them.

`key-scopes.ts` after :342:

```ts
  "PATCH /orgs/:id/stream-targets/:targetId",
  "DELETE /orgs/:id/stream-targets/:targetId",
```

`scripts/smoke.ts`: add `async function streamTargetsSuite(admin: Session, orgId: string)` beside
`streamOverlaySuite` (:18468), and call it from `main()` right after `await streamOverlaySuite();` (:903) as
`await streamTargetsSuite(admin, org2.id);` (org2 is the shared Pro org; the suite archives everything it creates).
Model its fetch helpers on that suite. The suite:
1. POST `{kind:"twitch", label:"smoke-tw", streamKey:"live_1_" + 24 random alphanumerics}` gives 201 with
   `keyHint === key.slice(-3)` and `inUse === null`.
2. PATCH `{label:"smoke-tw-2"}` gives 200 with the label.
3. PATCH `{streamKey: <new>}` gives 200 with the new `keyHint`.
4. DELETE gives 200 `{removed:true}`.
5. DELETE gives 404.
6. POST the same key gives 201 with **the same id** (restored).
7. DELETE (cleanup).

Each step asserts its status, and the suite counts its steps and fails on fewer than 7.

**Running one suite without a full local smoke (review R1).** `scripts/smoke.ts` has NO suite filter and no skip
mechanism today (the only `SMOKE_*` variable is `SMOKE_BASE`, :51). `main()` (:177) interleaves inline checks with 81
`await …Suite(…)` calls that share `admin`, `org` and `org2`, so "skip the other suites" is not a meaningful switch
inside it. The filter therefore does NOT touch `main()`; it adds a second, explicit entry point beside it:

1. A pure selector, `scripts/smoke-select.ts`:

```ts
// scripts/smoke-select.ts — which smoke suites a run executes. Pure, so its contract is unit-tested
// (scripts/__tests__/smoke-select.test.ts) rather than witnessed by a full local smoke run.
export type SmokeSelection = { mode: "all" } | { mode: "subset"; names: readonly string[] };

export class SmokeSelectionError extends Error {}

/** `raw` is `process.env.SMOKE_ONLY`. UNSET is the default and means `main()` runs exactly as before — CI never sets
 *  it, so CI's smoke is unchanged. SET means "only these": a set-but-empty value, a list of only commas, or any name
 *  outside `known` fails loudly rather than running fewer suites than the caller believes. */
export function selectSmokeSuites(known: readonly string[], raw: string | undefined): SmokeSelection {
  if (raw === undefined) return { mode: "all" };
  const names = [...new Set(raw.split(",").map((s) => s.trim()).filter((s) => s !== ""))];
  if (names.length === 0) {
    throw new SmokeSelectionError(`SMOKE_ONLY is set but names no suite (${JSON.stringify(raw)}); unset it to run everything`);
  }
  const unknown = names.filter((n) => !known.includes(n));
  if (unknown.length > 0) {
    throw new SmokeSelectionError(`SMOKE_ONLY names unknown suite(s): ${unknown.join(", ")}. Selectable: ${known.join(", ")}`);
  }
  return { mode: "subset", names };
}
```

2. In `smoke.ts`, a registry of the suites that may run alone, and one explicit subset setup. **"Setup" for a subset
   is exactly the state the registered suites read, reproduced from `main()`'s own calls, and nothing else:** the
   admin sign-in (:177-179: `newSession()` + `signIn(admin, …)`), the plan bump that lets that owner create a second
   org (:383: `setPlan(org.id, "pro", admin)`), `org2`'s create and rename (:386-399), and the shared org's public
   dashboard headroom (:721: `insertEntitlementOverride(admin, org2.id, "dashboard.public.max", 100)`). Every inline
   check in `main()` and every unregistered suite is skipped under a subset — that is the point, and the run says so.

```ts
type SubsetCtx = { admin: Session; org2Id: string; org2Slug: string };

/** Suites that may run alone under SMOKE_ONLY (name = the function name without `Suite`). Add a suite here only if it
 *  needs nothing beyond SubsetCtx. */
const SELECTABLE_SUITES: Record<string, (c: SubsetCtx) => Promise<void>> = {
  streamTargets: (c) => streamTargetsSuite(c.admin, c.org2Id),
  v1: (c) => v1Suite(c.admin, c.org2Id, c.org2Slug),
};

/** The subset's setup: the same calls main() makes for this state, in main()'s order (see the lines cited above). */
async function subsetSetup(): Promise<SubsetCtx> {
  const admin = newSession();
  const ver = await signIn(admin, `delivered+admin_${tag}@resend.dev`);
  check("subset setup: admin signed in", !!admin.cookies["seazn_session"]);
  await setPlan(ver.org_id, "pro", admin);
  const org2 = (await call(admin, "/api/orgs", "POST", { name: `Second Org ${tag}` })) as { id: string; slug: string };
  const renamed = (await call(admin, `/api/orgs/${org2.id}`, "PATCH", { name: `Renamed Org ${tag}` })) as { slug: string };
  check("subset setup: org2 created and renamed", !!org2.id && !!renamed.slug);
  await insertEntitlementOverride(admin, org2.id, "dashboard.public.max", 100);
  return { admin, org2Id: org2.id, org2Slug: renamed.slug };
}

async function runSubset(names: readonly string[]): Promise<void> {
  const ctx = await subsetSetup();
  for (const n of names) await SELECTABLE_SUITES[n]!(ctx);
  console.log(`SMOKE_ONLY: ran ${names.length} suite(s): ${names.join(", ")} — main()'s inline checks and every other suite were skipped`);
}
```

   The entry at the bottom (:20259) becomes:

```ts
const selection = selectSmokeSuites(Object.keys(SELECTABLE_SUITES), process.env.SMOKE_ONLY);
(selection.mode === "all" ? main() : runSubset(selection.names))
  .then(async () => { /* unchanged: cleanup(tag), the pass/fail line, the exit code */ })
  .catch(async (e) => { /* unchanged */ });
```

   A `SmokeSelectionError` thrown by the selector happens before any request, exits 1, and prints the message (wrap
   the `selectSmokeSuites` call so it logs and `process.exit(1)`s). `cleanup(tag)` runs after a subset exactly as
   after `main()`; its audit conjunct needs at least one staff-audit row from this run, which the setup's `setPlan`
   writes (read `setPlan` to confirm; if it does not, that conjunct reds under a subset and the fix is in
   `subsetSetup`, never in the conjunct). Import the selector as `./smoke-select.ts` (bare `node
   --experimental-strip-types`, no alias).

3. `scripts/__tests__/smoke-select.test.ts` (run like its siblings: from the repo root,
   `./packages/engine/node_modules/.bin/vitest run scripts/__tests__/smoke-select.test.ts`, as ci.yml:755 does), on the
   model of `smoke-db-shard-partition.test.ts`:

```ts
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { SmokeSelectionError, selectSmokeSuites } from "../smoke-select.ts";

const KNOWN = ["streamTargets", "v1"] as const;

describe("SMOKE_ONLY — selectSmokeSuites (review R1)", () => {
  it("UNSET means run everything, and unset is the default: CI never sets SMOKE_ONLY, so CI's smoke is unchanged", () => {
    expect(selectSmokeSuites(KNOWN, undefined)).toEqual({ mode: "all" });
    const workflows = ["ci.yml", "e2e.yml"].map((f) => readFileSync(join(import.meta.dirname, "..", "..", ".github", "workflows", f), "utf8"));
    expect(workflows.length).toBe(2);
    for (const w of workflows) expect(w).not.toContain("SMOKE_ONLY");
  });
  it("a named subset returns exactly those names, in the given order, de-duplicated and trimmed", () => {
    expect(selectSmokeSuites(KNOWN, "streamTargets")).toEqual({ mode: "subset", names: ["streamTargets"] });
    expect(selectSmokeSuites(KNOWN, " v1 ,streamTargets,v1")).toEqual({ mode: "subset", names: ["v1", "streamTargets"] });
  });
  it("an UNKNOWN name fails loudly, naming it and the selectable list — never a silently shorter run", () => {
    expect(() => selectSmokeSuites(KNOWN, "streamTargets,streamTarget")).toThrow(SmokeSelectionError);
    expect(() => selectSmokeSuites(KNOWN, "streamTargets,streamTarget")).toThrow(/streamTarget\b.*Selectable: streamTargets, v1/);
  });
  it("ZERO matched is a failure: set-but-empty, whitespace, and commas only", () => {
    let checked = 0;
    for (const raw of ["", "   ", ",", " , ,"]) {
      expect(() => selectSmokeSuites(KNOWN, raw), JSON.stringify(raw)).toThrow(SmokeSelectionError);
      checked++;
    }
    expect(checked).toBe(4);
  });
  it("the registry smoke.ts passes in is the one this test assumes", () => {
    const src = readFileSync(join(import.meta.dirname, "..", "smoke.ts"), "utf8");
    const block = /const SELECTABLE_SUITES[^=]*=\s*\{([\s\S]*?)\n\};/.exec(src)?.[1] ?? "";
    const names = [...block.matchAll(/^\s*(\w+):/gm)].map((m) => m[1]);
    expect(names).toEqual([...KNOWN]);
  });
});
```

Mutants, each run against THIS unit test only (never a smoke run): `raw === undefined` returning a subset of `[]`
(red: "UNSET means run everything"); the unknown-name check deleted (red: "an UNKNOWN name fails loudly"); the
`names.length === 0` check deleted (red: "ZERO matched").

Then run just the new suite against the local prod server:
`cd /Users/ashokhein/github/seazn.club/.claude/worktrees/fixture-stream && SMOKE_ONLY=streamTargets pnpm test:smoke`.
Expected: exit 0, the `SMOKE_ONLY: ran 1 suite(s): streamTargets` line, the suite's own "7 steps" line, and the
`N passed, 0 failed` line. The full smoke is CI's, and runs on this branch's PR.

- [ ] **Step 5: Run T2b's scope.** Use the Step 3 command, plus `src/server/api-v1/__tests__/key-scopes.test.ts`,
  `src/server/api-v1/__tests__/openapi-coverage.test.ts`, `src/server/api-v1/__tests__/openapi-published.test.ts`,
  `src/server/usecases/__tests__/api-key-scopes.test.ts` and `src/server/relay/__tests__/enc-boundary.test.ts`.
  Expected: `f: 0`, and every file is collected. Then the selector's unit test, from the repo root:
  `cd /Users/ashokhein/github/seazn.club/.claude/worktrees/fixture-stream && rm -f /tmp/fs-smoke-select.json && ./packages/engine/node_modules/.bin/vitest run scripts/__tests__/smoke-select.test.ts --reporter=json --outputFile=/tmp/fs-smoke-select.json; echo EXIT=$?; jq '{p:.numPassedTests,t:.numTotalTests,f:.numFailedTests,files:[.testResults[].name]}' /tmp/fs-smoke-select.json`.
  Expected: 5 of 5, and the one file listed.

- [ ] **Step 6: Mutate once each.**
  - `removeStreamTarget`: the `holderRows` check deleted. Red: "REFUSED 409 TARGET_IN_USE in EVERY active state".
  - `createSession`: `lockStreamTarget` replaced by an unlocked `select … and archived_at is null` (no `for update`).
    Red: "the ROW LOCK: createSession WAITS", at its **final 404 assertion**. It does not settle within 300 ms even
    mutated, because the session INSERT's foreign-key check takes FOR KEY SHARE on the target, which conflicts with
    the holder's FOR UPDATE; the unlocked read saw the row before the archive, so the mutant admits and fails late.
  - `removeStreamTarget`: `lockStreamTarget` replaced by the same unlocked select. Red: "the ROW LOCK, Remove's side"
    (it settles inside 300 ms, reading no holder yet, and archives).
  - `patchStreamTarget` (replace branch): the same mutation. Red: "the ROW LOCK, … Replace key's side".
  - `lockStreamTarget` without `archived_at is null` (T1's mutation, re-run here). Red: "an ARCHIVED target is refused
    at createSession".
  - `patchStreamTarget`: `.trim()` deleted. Red: "Review Focus 2".
  - The `DESTINATION_DUPLICATE` branch replaced by `return`. Red: "replace key onto a key ANOTHER active destination
    holds".

- [ ] **Step 7: Typecheck, lint, commit.** Commit with
  `feat(stream): PATCH/DELETE stream targets, row lock shared with Go live, 5→7 contract (T2b)`, including the
  regenerated `openapi/*.json` and `scripts/smoke.ts`.

### Task 3: "In use" names the match — holder enrichment and its client copy

**Files:**
- Modify: `apps/web/src/server/usecases/stream-sessions.ts:830-855` (`targetHolderFor`), :975-982 (`Holder`, `targetInUse`), and the terminal-holder builders in `tearDownPriorMachines` (:889) and `releasePriorOutputs` (:938)
- Modify: `apps/web/src/server/api-v1/openapi.ts:619-632` (the `STREAM_SESSION_CREATE_ERRORS` 409 holder: reuse `STREAM_TARGET_HOLDER_PROPERTIES` from T2b)
- Modify: `apps/web/src/lib/stream-session-view.ts:150-200` (`createErrorHolder`, `createErrorText`)
- Modify: `apps/web/src/dictionaries/{en,es,fr,nl}/ui.json` + regenerate `apps/web/src/lib/i18n-keys.ts`
- Test: `apps/web/src/server/usecases/__tests__/stream-sessions.test.ts` (the existing A5/G-T* `target_in_use` cases)
- Test: `apps/web/src/lib/__tests__/stream-session-view.test.ts`

**Interfaces:**
- Consumes: `holderRows`, `wireHolder`, `TargetHolder` (T2a).
- Produces:
  - `target_in_use` 409 extra `holder: {fixtureId, href, matchNo, courtName, label, state} | null`. It stays null on
    the index-race path.
  - `stream-session-view.ts` (both existing signatures KEPT):
    - `CreateErrorHolder` extended to `{label: string; courtName: string | null; matchNo: number | null; href: string | null; state: "live" | "waiting"}`;
    - `createErrorHolder(err: unknown): CreateErrorHolder | null` — still takes the RAW wire error and keeps the
      `wireError` + `code === "target_in_use"` guard (called once, at fixture-stream-panel.tsx:1086, whose result is
      stored in `createError.holder`);
    - `inUseText(msg, holder: CreateErrorHolder): string` (new);
    - `createErrorText(error: {code, holder}, msg)` — unchanged signature (called at fixture-stream-panel.tsx:1867);
      only its `target_in_use` branch changes, to `holder ? inUseText(msg, holder) : msg(TARGET_IN_USE_ELSEWHERE_KEY)`.
  - Keys:
    - `stream.inUse.live`, `stream.inUse.waiting` (with `{label}` and `{match}`);
    - `stream.inUse.matchCourt` (`{match}` and `{court}`);
    - `stream.inUse.open` (`{match}`);
    - the ONE "elsewhere" key stays the existing `stream.error.target_in_use.unknown` ("That destination is already
      live on another match.", `TARGET_IN_USE_ELSEWHERE_KEY`, :126). No second "elsewhere" key is added;
    - `stream.error.target_in_use` (`{destination} … {court}`) has no reader after T3 and is **deleted** from all four
      locales; `CREATE_ERROR_KEYS.target_in_use` (:119) points at `stream.error.target_in_use.unknown`.

- [ ] **Step 1: Write the failing tests.** In `stream-sessions.test.ts`, find every assertion on
  `extra.holder` (`rtk proxy grep -naE "holder" apps/web/src/server/usecases/__tests__/stream-sessions.test.ts`). Extend
  the **active-holder** case (A5-shaped: a second fixture's Go live while the first is live) to:

```ts
    await expect(createSession(r.auth, second.fixtureId, { mode: "passthrough", targetId: r.targetId }, r.deps))
      .rejects.toMatchObject({
        status: 409, code: "target_in_use",
        extra: { holder: { fixtureId: r.fixtureId, matchNo: firstNo, href: routes.fixture(org, comp, div, firstNo), courtName: expect.anything(), label: "Club", state: "live" } },
      });
```

Read `firstNo` and the slugs from the DB exactly as `stream-target-holders.test.ts` does. Add a **waiting** twin, where
the holder is in `warming`, that expects `state: "waiting"`. Leave the G-T6 race case's `holder: null` unchanged. For
the terminal-teardown holder cases (`prior.otherFixture` / `priorOutput.otherFixture`), assert `state: "live"` (a
Machine or output still on air) and `matchNo` equal to that fixture's number.

In `stream-session-view.test.ts` (the node harness). The file already has `msg` (:40, English) and `wire(err)` (:65,
an `HttpError` through the real v1 envelope into an `ApiV1Error`). Every case goes through BOTH real functions in
production order: `createErrorHolder(raw)` then `createErrorText({code, holder}, msg)`, as fixture-stream-panel.tsx
:1086 and :1867 do. Add `const msgEs` beside `msg`, built the same way from the `es` dictionary (read :37-45: `msg`
loads a dictionary from `DICT_DIR`):

```ts
describe("target_in_use names the match (spec §3.3, §5.5)", () => {
  const holderOf = async (holder: unknown) => createErrorHolder(await wire(new HttpError(409, "in use", "target_in_use", { holder })));
  const textOf = async (holder: unknown, m = msg) => createErrorText({ code: "target_in_use", holder: await holderOf(holder) }, m);

  it("live + court: '{label} is live on Match {n} · {court}. …' in the page's locale", async () => {
    const h = { label: "Club YouTube", matchNo: 7, courtName: "Court 2", href: "/o/a/c/b/d/c/f/7", state: "live", fixtureId: "f" };
    expect(await textOf(h)).toBe("Club YouTube is live on Match 7 · Court 2. Stop it there or pick another destination.");
    expect(await textOf(h, msgEs)).toContain(msgEs("breadcrumb.match", { no: 7 }));
  });
  it("waiting, no court: the match alone, from breadcrumb.match", async () => {
    const h = { label: "Tw", matchNo: 3, courtName: null, href: "/x", state: "waiting", fixtureId: "f" };
    expect(await textOf(h)).toBe("Tw is waiting for a phone on Match 3. Stop it there or pick another destination.");
  });
  it("a holder whose fixture was deleted (matchNo null) reads the ONE 'elsewhere' key, never 'Match null'", async () => {
    const text = await textOf({ label: "Tw", matchNo: null, courtName: null, href: null, state: "live", fixtureId: null });
    expect(text).toBe(msg("stream.error.target_in_use.unknown"));
    expect(text).not.toMatch(/null|undefined|[{}]/);
  });
  it("the index-race holder:null reads the same 'elsewhere' key", async () => {
    expect(await textOf(null)).toBe(msg("stream.error.target_in_use.unknown"));
  });
  it("every new key exists in all four locales, and the retired key exists in none", () => {
    const keys = ["stream.inUse.live", "stream.inUse.waiting", "stream.inUse.matchCourt", "stream.inUse.open"];
    let checked = 0;
    for (const loc of ["en", "es", "fr", "nl"]) {
      const d = JSON.parse(readFileSync(join(DICT_DIR, loc, "ui.json"), "utf8")) as Record<string, string>;
      for (const k of keys) { expect(d[k], `${loc} ${k}`).toBeTruthy(); checked++; }
      expect(d["stream.error.target_in_use"], `${loc} retired key`).toBeUndefined();
    }
    expect(checked).toBe(4 * keys.length);
  });
});
```

Then update the existing cases at :222-250 to the new shape, keeping every negative:
- m6 (:225) `createErrorHolder({ code: "target_in_use" })` stays `toBeNull()`.
- :228-231: the two `toEqual`s become
  `{ courtName: "Court 3", label: "Club channel", matchNo: null, href: null, state: "live" }` and
  `{ courtName: null, label: "Club channel", matchNo: null, href: null, state: "live" }`. A holder with no `state`
  reads `"live"`: the pre-T3 server refused only for a destination already on air, and today's copy says "already
  live", so that is what such a holder has always meant.
- :232-235 stay `toBeNull()`: the index race (`holder: null`), `active_session` carrying a holder (the code guard), a
  holder with no `label`, and a non-wire error.
- :237-246 (`createErrorText`): the named case becomes
  `createErrorText({ code: "target_in_use", holder: { courtName: "Court 3", label: "Club channel", matchNo: 4, href: "/x", state: "live" } }, msg)`
  `toBe("Club channel is live on Match 4 · Court 3. Stop it there or pick another destination.")`, still with the
  `toContain` and `not.toMatch(/[{}]/)` lines. The court-without-match and null-holder rows both expect
  `msg("stream.error.target_in_use.unknown")`. The loop over the other codes is unchanged.
- `fixture-stream-panel.test.tsx:1115-1123` (D12) reads the retired key and the old holder shape too, and reds at
  Step 5 otherwise. Its `named` row feeds a FULL holder
  (`{ courtName: "Court 3", label: "Club channel", matchNo: 4, href: "/x", state: "live" }`) and expects
  `m("stream.inUse.live", { label: "Club channel", match: m("stream.inUse.matchCourt", { match: m("breadcrumb.match", { no: 4 }), court: "Court 3" }) })`;
  the `holder: null` row expects `m("stream.error.target_in_use.unknown")` (unchanged); the storage_exhausted row and
  the empty case are kept. Retitle it "target_in_use NAMES the match and court (D12, spec §5.5)".

- [ ] **Step 2: Run and confirm red.**

```bash
cd /Users/ashokhein/github/seazn.club/.claude/worktrees/fixture-stream/apps/web && rm -f /tmp/fs-t3.json && pnpm vitest run src/server/usecases/__tests__/stream-sessions.test.ts src/lib/__tests__/stream-session-view.test.ts --reporter=json --outputFile=/tmp/fs-t3.json; echo EXIT=$?; jq '{p:.numPassedTests,t:.numTotalTests,f:.numFailedTests,files:[.testResults[].name]}' /tmp/fs-t3.json
```

- [ ] **Step 3: Implement the server side.** Replace `targetHolderFor`'s body (:838-855):

```ts
async function targetHolderFor(targetId: string, orgId: string, fixtureId: string, deps: SessionDeps): Promise<TargetHolder | null> {
  const first = await holderRows(sql, { orgId, targetId, notFixtureId: fixtureId });
  if (first.length === 0) return null;
  for (const h of first) await applyExpiry(h.sessionId, deps);      // B: this start attempt IS the tick for the holder too
  const [still] = await holderRows(sql, { orgId, targetId, notFixtureId: fixtureId });
  return still ?? null;
}
```

Replace `interface Holder` and `targetInUse` (:975-982):

```ts
/** A holder as Go live's refusal names it. An ACTIVE holder comes from `holderRows`; a TERMINAL session whose Machine
 *  or output is still on air (`tearDownPriorMachines` / `releasePriorOutputs`) is built by `terminalHolder` below and
 *  reads `live` — to a person, the destination is still receiving from that match. */
type Holder = Pick<TargetHolder, "sessionId" | "label" | "courtName" | "fixtureId" | "href" | "matchNo" | "state">;

function targetInUse(h: Holder): HttpError {
  return new HttpError(
    409,
    `the destination "${h.label}" is already streaming for ${h.matchNo !== null ? `match ${h.matchNo}` : h.courtName ? `court ${h.courtName}` : `fixture ${h.fixtureId ?? "(deleted)"}`}`,
    "target_in_use",
    { holder: wireHolder({ ...h, targetId: "" }) },
  );
}
```

`wireHolder` does not read `targetId`. Make its parameter type
`Pick<TargetHolder, "fixtureId" | "href" | "matchNo" | "courtName" | "label" | "state">` in
`stream-target-holders.ts`, so the `targetId: ""` above is unnecessary, and drop it.

In `tearDownPriorMachines` and `releasePriorOutputs`, the queries building `Holder` from terminal sessions select
`s.id, c.name, s.fixture_id, t.label`. Extend each with `f.fixture_no, o.slug as org_slug, comp.slug as comp_slug, d.slug as div_slug`
via the same three left joins as `holderRows`, and build the holder with:

```ts
const terminalHolder = (r: { id: string; court_name: string | null; fixture_id: string | null; label: string; fixture_no: number | null; org_slug: string | null; comp_slug: string | null; div_slug: string | null }): Holder => ({
  sessionId: r.id, label: r.label, courtName: r.court_name, fixtureId: r.fixture_id, matchNo: r.fixture_no, state: "live",
  href: r.org_slug && r.comp_slug && r.div_slug && r.fixture_no !== null ? routes.fixture(r.org_slug, r.comp_slug, r.div_slug, r.fixture_no) : null,
});
```

Every read of `holder.holderFixtureId` in stream-sessions.ts becomes `holder.fixtureId` (use
`rtk proxy grep -naE "holderFixtureId"` to find them). Import `routes` from `@/lib/routes`, and
`TargetHolder` and `wireHolder` from `./stream-target-holders`.

`openapi.ts` :622-630: replace the `holder` property with
`{ ...STREAM_TARGET_HOLDER_PROPERTIES, type: ["object", "null"], description: "On target_in_use (409): … null when a concurrent start won the race and there is no holder to name" }`.
Hoist `STREAM_TARGET_HOLDER_PROPERTIES` above `STREAM_SESSION_CREATE_ERRORS` if T2b placed it below. Then run
`pnpm openapi:gen` again.

- [ ] **Step 4: Implement the client side.** In `stream-session-view.ts` (:150-200), keep `wireError`, both
  signatures and the code guard; widen the holder and change only `createErrorText`'s `target_in_use` branch:

```ts
export type CreateErrorHolder = {
  courtName: string | null; label: string; matchNo: number | null; href: string | null; state: "live" | "waiting";
};

/** Who holds the destination on a `target_in_use` (`extra.holder`, stream-sessions.ts `targetInUse`); `null` on the
 *  index-race variant `{ holder: null }`, on any other refusal, and on a holder without a label. A holder with no
 *  `state` (a pre-T3 server) reads "live": that server refused only for a destination already on air. */
export function createErrorHolder(err: unknown): CreateErrorHolder | null {
  const w = wireError(err);
  if (!w || w.code !== "target_in_use") return null;
  const h = w.extra.holder as { courtName?: unknown; label?: unknown; matchNo?: unknown; href?: unknown; state?: unknown } | null | undefined;
  if (typeof h !== "object" || h === null || typeof h.label !== "string") return null;
  return {
    courtName: typeof h.courtName === "string" ? h.courtName : null,
    label: h.label,
    matchNo: typeof h.matchNo === "number" ? h.matchNo : null,
    href: typeof h.href === "string" ? h.href : null,
    state: h.state === "waiting" ? "waiting" : "live",
  };
}

/** Spec §3.3 — "{label} is {live|waiting for a phone} on Match {n} · {court}. Stop it there or pick another
 *  destination." The match is the locale's own `breadcrumb.match`, never a server string. No match number (the holder's
 *  fixture was deleted) reads the one "elsewhere" sentence. */
export function inUseText(msg: Msg, h: CreateErrorHolder): string {
  if (h.matchNo === null) return msg(TARGET_IN_USE_ELSEWHERE_KEY);
  const matchOnly = msg("breadcrumb.match", { no: h.matchNo });
  const match = h.courtName ? msg("stream.inUse.matchCourt", { match: matchOnly, court: h.courtName }) : matchOnly;
  return msg(h.state === "live" ? "stream.inUse.live" : "stream.inUse.waiting", { label: h.label, match });
}

export function createErrorText(error: { code: CreateErrorCode; holder: CreateErrorHolder | null }, msg: Msg): string {
  if (error.code === "target_in_use") return error.holder ? inUseText(msg, error.holder) : msg(TARGET_IN_USE_ELSEWHERE_KEY);
  return msg(CREATE_ERROR_KEYS[error.code]);
}
```

`CREATE_ERROR_KEYS.target_in_use` (:119) becomes `"stream.error.target_in_use.unknown"`, so the map no longer names
the retired key. The two panel call sites (:1086 `createErrorHolder(err)` on the raw error, :1867
`createErrorText(p.createError, msg)`) are unchanged. Delete `stream.error.target_in_use` from all four
`ui.json` files; `pnpm i18n:gen-keys` then drops it from `i18n-keys.ts`, and tsc proves nothing still reads it.

Dictionary keys (flat, beside the existing `stream.error.*`):

| key | en | es | fr | nl |
|---|---|---|---|---|
| `stream.inUse.live` | `{label} is live on {match}. Stop it there or pick another destination.` | `{label} está en directo en {match}. Detenlo allí o elige otro destino.` | `{label} est en direct sur {match}. Arrêtez-le là-bas ou choisissez une autre destination.` | `{label} is live op {match}. Stop het daar of kies een andere bestemming.` |
| `stream.inUse.waiting` | `{label} is waiting for a phone on {match}. Stop it there or pick another destination.` | `{label} está esperando un teléfono en {match}. Detenlo allí o elige otro destino.` | `{label} attend un téléphone sur {match}. Arrêtez-le là-bas ou choisissez une autre destination.` | `{label} wacht op een telefoon op {match}. Stop het daar of kies een andere bestemming.` |
| `stream.inUse.matchCourt` | `{match} · {court}` | `{match} · {court}` | `{match} · {court}` | `{match} · {court}` |
| `stream.inUse.open` | `Open {match}` | `Abrir {match}` | `Ouvrir {match}` | `{match} openen` |

Then run `cd /Users/ashokhein/github/seazn.club/.claude/worktrees/fixture-stream && pnpm i18n:gen-keys && pnpm i18n:check`.

- [ ] **Step 5: Run T3's scope.** Use the Step 2 command (its `fixture-stream-panel.test.tsx` D12 case updated in
  Step 1), plus
  `"src/app/api/v1/fixtures/[id]/stream-sessions/__tests__/routes.test.ts"` (wire ⊆ spec for the enriched holder),
  `src/components/v2/__tests__/fixture-stream-panel.test.tsx` and
  `src/server/api-v1/__tests__/openapi-published.test.ts`. Expected: `f: 0`.

- [ ] **Step 6: Mutate once each.**
  - `inUseText`: the `matchNo === null` branch deleted. Red: "a holder whose fixture was deleted" (it renders
    `Match null`).
  - `createErrorHolder`: the `w.code !== "target_in_use"` guard deleted. Red: the kept `active_session` null row.
  - `terminalHolder`: `state: "live"` changed to `"waiting"`. Red: the terminal-teardown holder case.
  - `targetHolderFor`: `notFixtureId` dropped. Red: the existing "a second session on THIS fixture is
    active_session" case.

- [ ] **Step 7: Typecheck, lint, commit.** Commit with
  `feat(stream): target_in_use names the match — number, court, link, live|waiting (T3)`.

### Task 4: Output state reaches the screen, and provider calls carry the session

**Files:**
- Modify: `apps/web/src/server/relay/ports.ts:33` (`OutputState`), :66-73 (four signatures, plus `ProviderCallMeta`)
- Modify: `apps/web/src/server/relay/ingest-cf.ts:238-300` (four methods: meta passed through `call`; the `outputState` mapping)
- Modify: `apps/web/src/server/relay/fakes.ts:115-187` (four methods take meta and record `sessionId`; add `FAKE_CONNECTING_KEY_PREFIX`)
- Modify: `apps/web/src/server/relay/drivers.ts:45` (the disabled driver's four methods take and ignore meta)
- Modify: `apps/web/src/server/usecases/stream-sessions.ts` call sites:
  - `releaseOutput` :480 (`removeOutput`);
  - `observeIngestBeforeExpiry` :527 (`inputStatus`);
  - the `add_output` effect :615 (`addOutput`);
  - `currentSession` :1258 (`inputStatus` + `outputState`);
  - every further call the grep in Step 3 lists;
  - the projection :1338-1360 (`output`).
- Modify: `apps/web/src/server/api-v1/schemas.ts:1323-1357` (`StreamOutput`; `StreamSessionCurrent.output`)
- Modify: `apps/web/src/lib/stream-session-view.ts` (`OUTPUT_WARNING_AFTER_MS`, `outputElapsedMs`, `destinationWarning`)
- Test: `ingest-cf.test.ts`, `fakes.test.ts`, `stream-sessions.test.ts`, `stream-session-view.test.ts`
- Test: every test that builds a `StreamSessionCurrent` literal gains `output: null`. Find them with
  `rtk proxy grep -rlaE "restartFree:" apps/web/src apps/web/e2e`.

**Interfaces:**
- Produces:
  - `ports.ts`:
    - `type OutputState = "ok" | "connecting" | "rejected" | "unknown"`;
    - `interface ProviderCallMeta { sessionId?: string | null }`;
    - `inputStatus(inputId, meta?)`, `addOutput(inputId, target, meta?)`, `outputState(inputId, meta?)`,
      `removeOutput(inputId, outputId, meta?)`.
  - `schemas.ts`:
    - `StreamOutput = {state: OutputState, since: string}`;
    - `StreamSessionCurrent.output: StreamOutput | null`.
  - `stream-session-view.ts`:
    - `OUTPUT_WARNING_AFTER_MS = 30_000`;
    - `outputElapsedMs(view, now): number | null`, clamped at ≥ 0;
    - `destinationWarning(view, now): boolean`.
  - `fakes.ts`: `FAKE_CONNECTING_KEY_PREFIX = "connecting-"`.

- [ ] **Step 1: Pin Cloudflare's output-state vocabulary.** Run the Cloudflare MCP `search` over the OpenAPI
  `spec.paths` for `GET /accounts/{account_id}/stream/live_inputs/{live_input_identifier}/outputs`, and read the enum
  of `status.current.state`. The CF adapter's `removeOutput` comment records the same method (2026-09-29). Record the
  enum and the date in the `outputState` doc comment.
  - Expected words include `connected`, `connecting`, `reconnecting` and `error`.
  - If the enum differs, map by the rule "error → rejected; every output connected → ok; any connecting/reconnecting
    → connecting; else unknown", using the enum's own words.

- [ ] **Step 2: Write the failing tests.**

`ingest-cf.test.ts`: add beside the existing `outputState` cases, using that file's fetch stub and its
`{ success: true, result: [...] }` builder:

```ts
  it("outputState (D3, round-1 regression): 'connecting' and 'reconnecting' are CONNECTING, never ok — staging's panel said Live while YouTube received nothing", async () => {
    const cases: [string[], OutputState][] = [
      [["connected"], "ok"],
      [["connecting"], "connecting"],
      [["reconnecting"], "connecting"],
      [["connected", "connecting"], "connecting"],
      [["connected", "error"], "rejected"],
      [[], "unknown"],
      [["some-future-word"], "unknown"],
    ];
    let checked = 0;
    for (const [states, want] of cases) {
      stubOutputs(states.map((s) => ({ enabled: true, status: { current: { state: s } } })));
      expect(await adapter.outputState("in-1", { sessionId: "sess-1" }), states.join(",")).toBe(want);
      checked++;
    }
    expect(checked).toBe(cases.length);
  });

  it("the four per-session calls record their session id on the provider-call row (spec §5.7)", async () => {
    let checked = 0;
    for (const [op, run] of [
      ["inputStatus", () => adapter.inputStatus("in-1", { sessionId: "sess-9" })],
      ["addOutput", () => adapter.addOutput("in-1", { url: "rtmp://a.rtmp.youtube.com/live2", streamKey: "k" }, { sessionId: "sess-9" })],
      ["outputState", () => adapter.outputState("in-1", { sessionId: "sess-9" })],
      ["removeOutput", () => adapter.removeOutput("in-1", "out-1", { sessionId: "sess-9" })],
    ] as const) {
      stubOk();
      await run();
      expect(recorded.at(-1), op).toMatchObject({ operation: op, sessionId: "sess-9" });
      checked++;
    }
    expect(checked).toBe(4);
  });
```

`stubOutputs`, `stubOk`, `adapter` and `recorded` stand for that file's existing helpers. Read its top ~80 lines and
use their real names. The recorder capture is how the file already asserts `stream_provider_calls` rows.

Add a `fakes.test.ts` twin of the session-id case, and add: a key starting with `FAKE_CONNECTING_KEY_PREFIX` reads
`unknown` before the input connects and `connecting` after it (tick past `connectAfterMs` between the two reads), and
the provider-call recorder holds exactly the two `outputState` rows (no hidden `inputStatus`).

`stream-sessions.test.ts`:

```ts
  it("output.since is when the CURRENT output state began — the first ingest_status event of the trailing run of that state, not the latest poll", async () => {
    const r = await rig({ streamKey: `${FAKE_CONNECTING_KEY_PREFIX}${randomUUID()}` });   // the rig's target option; add one if rig() has none
    await goLive(r);                                   // the file's own helper to reach `live`
    const t0 = r.clock.now();
    const first = await currentSession(r.auth, r.fixtureId, r.deps);
    expect(first!.output).toEqual({ state: "connecting", since: expect.any(String) });
    r.clock.advance(10_000);
    const second = await currentSession(r.auth, r.fixtureId, r.deps);
    expect(second!.output!.since).toBe(first!.output!.since);          // unchanged state: since does not move
    expect(Date.parse(second!.output!.since)).toBeLessThanOrEqual(t0.getTime());
  });

  it("D3's clock starts at LIVE, never during warming: warm 45 s with the output non-ok, go live — no warning at live+0 s or live+29.999 s, a warning at live+30 s", async () => {
    const WARM_MS = 45_000;
    const POLL_MS = 5_000;
    let checked = 0;
    for (const nonOk of ["unknown", "connecting"] as const) {
      // The output reads the SAME non-ok state before and after go-live — Cloudflare's shape when the destination has
      // not been tried yet — so the trailing run of that state starts in warming. Only the live clamp stops the clock.
      const r = await rig({ connectAfterMs: WARM_MS });
      const outSpy = vi.spyOn(r.ingest, "outputState").mockResolvedValue(nonOk);
      try {
        await createSession(r.auth, r.fixtureId, body(r.target.id), r.deps);
        let polls = 0;
        for (let t = 0; t < WARM_MS; t += POLL_MS) {                // the organiser's poll through warming
          expect((await currentSession(r.auth, r.fixtureId, r.deps))!.state, `${nonOk} t=${t}`).not.toBe("live");
          polls++;
          r.tick(POLL_MS);
        }
        expect(polls).toBe(WARM_MS / POLL_MS);
        const live = await currentSession(r.auth, r.fixtureId, r.deps);
        expect(live!.state, nonOk).toBe("live");
        expect(live!.output, nonOk).toEqual({ state: nonOk, since: r.deps.now().toISOString() });   // clamped to live_at
        expect(destinationWarning(live!, r.deps.now()), `${nonOk} live+0`).toBe(false);
        r.tick(OUTPUT_WARNING_AFTER_MS - 1);
        const early = await currentSession(r.auth, r.fixtureId, r.deps);
        expect(destinationWarning(early!, r.deps.now()), `${nonOk} live+29.999`).toBe(false);
        r.tick(1);
        const due = await currentSession(r.auth, r.fixtureId, r.deps);
        expect(destinationWarning(due!, r.deps.now()), `${nonOk} live+30`).toBe(true);
      } finally {
        outSpy.mockRestore();
      }
      checked++;
    }
    expect(checked).toBe(2);
  });

  it("output is null for a composed session, and for a passthrough session once it has ended", async () => {
    const composed = await rig();
    await startComposed(composed);                     // the file's own composed-session setup
    expect((await currentSession(composed.auth, composed.fixtureId, composed.deps))!.output).toBeNull();
    const ended = await rig();
    await goLive(ended);
    expect((await currentSession(ended.auth, ended.fixtureId, ended.deps))!.output).not.toBeNull();   // the positive twin
    await stopAndDrain(ended);                         // the file's own Stop + grace helper, to `completed`
    const view = await currentSession(ended.auth, ended.fixtureId, ended.deps);
    expect(view!.state).toBe("completed");
    expect(view!.output).toBeNull();
  });
```

`goLive(r)`, `startComposed(r)`, `stopAndDrain(r)`, `r.clock.now()` and `r.clock.advance()` stand for the file's own
go-live, composed-start and stop helpers and its test clock (read
how the existing live-state cases reach `live` and move `deps.now()`), so use their real names. Write the second case
out in full with the file's existing composed-session setup (search for
`mode: "composed"` in the file), asserting `output: null` in both states. If `rig()` has no way to set the target's
key, add an optional `streamKey` to it, pass it to its `createStreamTarget` call, and keep every current caller's
default.

`stream-session-view.test.ts`:

```ts
describe("D3 — the destination warning (spec §5.6)", () => {
  const view = (state: string, output: { state: string; since: string } | null) => ({ state, output }) as never;
  const since = new Date("2026-09-30T12:00:00Z");
  const at = (ms: number) => new Date(since.getTime() + ms);
  it("fires at exactly OUTPUT_WARNING_AFTER_MS, not one millisecond before, for every non-ok state", () => {
    let checked = 0;
    for (const s of ["connecting", "unknown", "rejected"]) {
      const v = view("live", { state: s, since: since.toISOString() });
      expect(destinationWarning(v, at(OUTPUT_WARNING_AFTER_MS - 1)), s).toBe(false);
      expect(destinationWarning(v, at(OUTPUT_WARNING_AFTER_MS)), s).toBe(true);
      checked++;
    }
    expect(checked).toBe(3);
  });
  it("never while output is ok, never outside live, never without output", () => {
    const late = at(OUTPUT_WARNING_AFTER_MS * 10);
    expect(destinationWarning(view("live", { state: "ok", since: since.toISOString() }), late)).toBe(false);
    expect(destinationWarning(view("warming", { state: "connecting", since: since.toISOString() }), late)).toBe(false);
    expect(destinationWarning(view("live", null), late)).toBe(false);
  });
  it("Review Focus 5: a since in the browser's FUTURE (clock skew) gives no warning and an elapsed of 0, never negative", () => {
    const v = view("live", { state: "connecting", since: at(5_000).toISOString() });
    expect(outputElapsedMs(v, since)).toBe(0);
    expect(destinationWarning(v, since)).toBe(false);
  });
});
```

- [ ] **Step 3: Run and confirm red.** Also list every provider call site:
  `rtk proxy grep -naE "\.(inputStatus|addOutput|outputState|removeOutput)\(" apps/web/src/server`. Record the count,
  because Step 4 must touch every one of them.

```bash
cd /Users/ashokhein/github/seazn.club/.claude/worktrees/fixture-stream/apps/web && rm -f /tmp/fs-t4.json && pnpm vitest run src/server/relay/__tests__/ingest-cf.test.ts src/server/relay/__tests__/fakes.test.ts src/server/usecases/__tests__/stream-sessions.test.ts src/lib/__tests__/stream-session-view.test.ts --reporter=json --outputFile=/tmp/fs-t4.json; echo EXIT=$?; jq '{p:.numPassedTests,t:.numTotalTests,f:.numFailedTests,files:[.testResults[].name]}' /tmp/fs-t4.json
```

- [ ] **Step 4: Implement.**

`ports.ts`:

```ts
export type OutputState = "ok" | "connecting" | "rejected" | "unknown";
/** Spec §5.7 — what a per-session provider call is FOR, so its stream_provider_calls row carries the session (staging
 *  2026-09-30 found removeOutput rows with a NULL session_id). Optional: the sweep calls some ops with no session. */
export interface ProviderCallMeta { sessionId?: string | null }
```

and the four signatures:

```ts
  inputStatus(inputId: string, meta?: ProviderCallMeta): Promise<IngestStatus>;
  addOutput(inputId: string, target: IngestTarget, meta?: ProviderCallMeta): Promise<string>;
  outputState(inputId: string, meta?: ProviderCallMeta): Promise<OutputState>;
  removeOutput(inputId: string, outputId: string, meta?: ProviderCallMeta): Promise<void>;
```

`ingest-cf.ts`: each of the four gains `meta: ProviderCallMeta = {}` and passes `sessionId: meta.sessionId ?? null`
in its `call(…, { operation, ids, subjectId, sessionId })`, exactly as `deleteInput` already does. The `outputState`
mapping after the `rejected` line becomes:

```ts
    if (states.includes("error")) return "rejected";
    if (states.length === 0) return "unknown";
    // D3 (spec §5.6; staging round 1, 2026-09-30): a present, non-error state is NOT "ok". Cloudflare reports an output
    // that is still dialling — or re-dialling — the destination as <enum words from Step 1>; the panel said Live while
    // YouTube received nothing because this returned "ok" for them.
    if (states.some((s) => s === "connecting" || s === "reconnecting")) return "connecting";
    return states.every((s) => s === "connected") ? "ok" : "unknown";
```

`fakes.ts`: each of the four takes `meta: ProviderCallMeta = {}` and passes `meta.sessionId ?? null` as `record`'s
sixth argument. Then:

```ts
export const FAKE_CONNECTING_KEY_PREFIX = "connecting-";
```

```ts
    if (row.outputs.some((o) => new URL(o.url).hostname.includes("reject") || o.streamKey.startsWith(FAKE_REJECT_KEY_PREFIX))) return "rejected";
    // Cloudflare reports no output status before inbound video (ingest-cf.ts:283-287): `unknown` until the input
    // connects, then `connecting` for a destination that never accepts. The walkthrough then crosses go-live in the
    // real shape, not a friendlier one.
    if (row.outputs.some((o) => o.streamKey.startsWith(FAKE_CONNECTING_KEY_PREFIX))) return this.isConnected(row) ? "connecting" : "unknown";
    return "ok";
```

`isConnected(row)` is the predicate `inputStatus` already applies (fakes.ts:118-121: `row.scripted`, else
`clock() - createdAt >= connectAfterMs`), extracted into a private method that both call. It must not call
`inputStatus` itself, which would record an extra provider call and move every provider-call count.

`drivers.ts:45`: the disabled driver's four methods gain the unused `_meta?: ProviderCallMeta` parameter.

`stream-sessions.ts`: every call site from Step 3's grep passes `{ sessionId: <that session's id> }`: `sessionId` in
`releaseOutput`, the session id in `observeIngestBeforeExpiry` and in the effect runner, and `row.id` in
`currentSession`. A sweep call with no session (if the grep shows one) passes nothing, with a comment saying why.

`schemas.ts` (after `StreamIngest`):

```ts
/** D3 (spec §5.6) — the destination's side of a passthrough broadcast: `since` is when the CURRENT state began. */
export const StreamOutput = z.object({
  state: z.enum(["ok", "connecting", "rejected", "unknown"]),
  since: z.string(),
});
export type StreamOutput = z.infer<typeof StreamOutput>;
```

Add `output: StreamOutput.nullable(),` to `StreamSessionCurrent` after `ingest`.

In `currentSession`, keep the observed `output` in a variable scoped to the function
(`let outputObserved: OutputState | null = null;`, set inside `if (read)`). Before the `return`, add:

```ts
  // D3: `since` is the start of the trailing run of ingest_status events whose outputState equals the current one —
  // the events the poll above already records on every change (Ruling 13) — CLAMPED to the session's `live_at`. The
  // destination is not tried before the phone is live, and Cloudflare reads `unknown` (non-ok) all through warming,
  // so an unclamped run would start the 30 s clock during warming and warn on the first live render (review #9). While
  // live, `since` is therefore "non-ok while live". `greatest` ignores a null `live_at` (not live yet). Null for
  // composed sessions and whenever this poll did not read the output.
  let output: StreamSessionCurrent["output"] = null;
  if (row.mode === "passthrough" && outputObserved !== null) {
    const [first] = await sql<{ since: Date | null }[]>`
      select greatest(
        (select occurred_at from fixture_stream_events
          where session_id = ${row.id} and type = 'ingest_status'
            and seq > coalesce((select max(seq) from fixture_stream_events
                                 where session_id = ${row.id} and type = 'ingest_status'
                                   and payload->>'outputState' is distinct from ${outputObserved}), 0)
          order by seq asc limit 1),
        (select live_at from fixture_stream_sessions where id = ${row.id})
      ) as since`;
    output = { state: outputObserved, since: new Date(first?.since ?? deps.now()).toISOString() };
  }

Both clocks must be the session's clock: `live_at` is written from `deps.now()` (stream-sessions.ts:222), so the
`ingest_status` event this poll records must pass `occurredAt: deps.now()` to `recordEvent` (telemetry.ts:48 defaults
it to the wall clock). Read the call; if it omits `occurredAt`, pass it. Otherwise the unit test's ticked clock and the
rows disagree, and the sequence test above cannot pass for the right reason.
```

and add `output,` to the returned object after `ingest: ingestState,`.

`stream-session-view.ts`:

```ts
/** D3 (owner 2026-09-30): how long a live stream's destination may be not-receiving before the panel warns. */
export const OUTPUT_WARNING_AFTER_MS = 30_000;

/** How long the destination has been in its current non-ok state, clamped at 0 — a server `since` ahead of the
 *  browser clock (Review Focus 5) is "just now", never negative. Null when there is no output to judge. */
export function outputElapsedMs(view: Pick<StreamSessionCurrent, "output">, now: Date): number | null {
  if (!view.output) return null;
  return Math.max(0, now.getTime() - Date.parse(view.output.since));
}

export function destinationWarning(view: Pick<StreamSessionCurrent, "state" | "output">, now: Date): boolean {
  if (view.state !== "live" || !view.output || view.output.state === "ok") return false;
  return (outputElapsedMs(view, now) ?? 0) >= OUTPUT_WARNING_AFTER_MS;
}
```

Add `output: null,` to every `StreamSessionCurrent` literal that the Step-list grep finds.

- [ ] **Step 5: Run T4's scope.** Use the Step 3 command, plus `src/components/v2/__tests__/fixture-stream-panel.test.tsx`,
  `"src/app/api/v1/fixtures/[id]/stream-sessions/__tests__/routes.test.ts"`, `src/server/relay/__tests__/drivers.test.ts`,
  `src/server/relay/__tests__/port-boundary.test.ts`, `src/server/relay/__tests__/telemetry.test.ts` (whose sanitiser
  allowlist must keep `outputState`) and `src/server/api-v1/__tests__/stream-contract.test.ts`. Then run
  `pnpm openapi:gen`. Expected: `f: 0`.

- [ ] **Step 6: Mutate once each.**
  - `ingest-cf` `connecting` branch deleted. Red: "round-1 regression".
  - `destinationWarning`: `>=` changed to `>`. Red: "fires at exactly OUTPUT_WARNING_AFTER_MS".
  - `outputElapsedMs`: `Math.max(0, …)` removed. Red: "Review Focus 5".
  - `since` query: `is distinct from` changed to `=`. Red: "output.since is when the CURRENT output state began".
  - `since` query: the `live_at` arm of `greatest` deleted. Red: "D3's clock starts at LIVE" at `live+0` (since is the
    first warming poll, 45 s earlier, so the warning is already due).
  - `releaseOutput`: `{ sessionId }` removed. Red: the fakes/session-id case over `releaseOutput`. If no such case
    exists yet, add one to `stream-sessions.test.ts`: after Stop, the fake recorder's `removeOutput` row has
    `sessionId === r.sessionId`.

- [ ] **Step 7: Typecheck, lint, commit.** Commit with
  `feat(stream): output {state, since} on the projection, 30 s destinationWarning, session id on four provider calls (T4)`.

**Wave S gate** (the orchestrator re-runs it; scoped, not full):

```bash
cd /Users/ashokhein/github/seazn.club/.claude/worktrees/fixture-stream/apps/web && rm -f /tmp/fs-waveS.json && pnpm vitest run src/server/relay/__tests__/secret-columns.test.ts src/server/relay/__tests__/migration-shape.test.ts src/server/relay/__tests__/enc-boundary.test.ts src/server/relay/__tests__/rls-static.test.ts src/server/relay/__tests__/port-boundary.test.ts src/server/relay/__tests__/fakes.test.ts src/server/relay/__tests__/ingest-cf.test.ts src/server/relay/__tests__/drivers.test.ts src/server/relay/domain/__tests__/hold-state.test.ts src/server/usecases/__tests__/stream-target-holders.test.ts src/server/usecases/__tests__/stream-targets.test.ts src/server/usecases/__tests__/stream-sessions.test.ts src/server/api-v1/__tests__/stream-contract.test.ts src/server/api-v1/__tests__/key-scopes.test.ts src/server/api-v1/__tests__/openapi-published.test.ts src/lib/__tests__/stream-destinations.test.ts src/lib/__tests__/stream-session-view.test.ts src/components/v2/__tests__/fixture-stream-panel.test.tsx "src/app/api/v1/orgs/[id]/stream-targets/__tests__/target-route.test.ts" "src/app/api/v1/fixtures/[id]/stream-sessions/__tests__/routes.test.ts" src/server/usecases/__tests__/relay-internal-routes.test.ts src/server/usecases/__tests__/relay-sweep.test.ts src/server/api-v1/__tests__/openapi-coverage.test.ts src/server/usecases/__tests__/api-key-scopes.test.ts src/server/relay/__tests__/telemetry.test.ts --reporter=json --outputFile=/tmp/fs-waveS.json; echo EXIT=$?; jq '{p:.numPassedTests,t:.numTotalTests,f:.numFailedTests,n:(.testResults|length),files:[.testResults[].name]}' /tmp/fs-waveS.json
```

Expected: `f: 0` and `n: 25`, with every path present in `files`. Also run the two walkthroughs from T2a Step 8, whole.

## Wave P — placement (no visual change to the panel itself)

### Task 5: Mount the panel on the fixture page (the run-sheet mount stays)

**Files:**
- Create: `apps/web/src/server/stream-panel-context.ts`
- Create: `apps/web/src/lib/fixture-stream-mount.ts`
- Modify: `apps/web/src/app/o/[orgSlug]/c/[compSlug]/d/[divSlug]/f/[no]/page.tsx`:
  - :40-44: the `searchParams` prop;
  - after :75: the stream reads;
  - :224-229: the new `stream` and `streamReturn` props.
- Modify: `apps/web/src/app/o/[orgSlug]/c/[compSlug]/d/[divSlug]/page.tsx:518-606` (the block becomes one `loadStreamPanelContext` call)
- Modify: `apps/web/src/components/v2/fixture-console.tsx`:
  - :283: props;
  - :444: `handoverOpen` becomes `openPanel`;
  - :745: `consoleScoringEmptyOnPhone`;
  - :884-906: the phone twin;
  - :1007-1049: the desktop button and panel;
  - after the Scoring section: the `console-stream` fallback.
- Modify: `apps/web/src/components/v2/fixture-stream-panel.tsx`:
  - :282-304: `openedByReturn` prop;
  - :303-304: `returnedHere` reads it.
- Modify: `apps/web/src/app/api/billing/relay-checkout/route.ts`:
  - :73-79: select `f.fixture_no`;
  - :107: `tab` becomes `fixturePage`;
  - :118: the return URL.
- Modify: `apps/web/src/dictionaries/{en,es,fr,nl}/ui.json` (`stream.button`; the D4 renames of `score.handOverDevice` and `dlink.title`) + regenerate `lib/i18n-keys.ts`
- Modify: `apps/web/e2e/walkthrough/stream-relay.spec.ts`:
  - :344-364: `openFixturesTab`, `rowOf` and `openPhoneTab` become `openFixture` and `openStream`;
  - every caller of `row.*`.
- Modify: `apps/web/e2e/walkthrough/stream-credits.spec.ts`:
  - :318-332: the same helpers;
  - ~:860-900: the checkout-return case.
- Modify: `apps/web/e2e/stream-overlay.spec.ts:715-735, :852-870` (the run-sheet toggle becomes the fixture-page Stream control)
- Modify: `apps/web/e2e/mobile.spec.ts:101-117, :205-217` (the stream twin, both directions)
- Modify, if Step 12's grep lists them (they assert the D4 text): `apps/web/e2e/walkthrough/scorepad-v3-r7-console-chrome.spec.ts`, `scorer-sheets-handover-panel.spec.ts`, `scorer-sheets-print-scan.spec.ts`
- Modify: `scripts/smoke.ts:16981-16987` (the stream twin's presence)
- Modify: `docs/superpowers/specs/2026-09-02-scorepad-v3-phone-composition-design.md` (§2 :33, §3.1 :49-50, the table :97-99, smoke :130) and `AGENTS.md:278` (dated amendments)
- Test (new): `apps/web/src/lib/__tests__/fixture-stream-mount.test.ts`
- Test (new): `apps/web/src/server/__tests__/stream-panel-context.test.ts`
- Test: `apps/web/src/components/v2/__tests__/fixture-console-authority-band.test.tsx:257-275` (D4 text, the stream twins, and the fallback)
- Test: `apps/web/src/app/api/billing/relay-checkout/__tests__/route.test.ts` (return URL)
- Test: `apps/web/src/components/v2/__tests__/device-link-panel-i18n.test.tsx` (it asserts `dlink.title` text, so update it to the new string)

**Interfaces:**
- Consumes:
  - `StreamPanelContext`, `StreamPanelFixture`, `FixtureStreamPanel`, `PhoneStopProbe` (fixture-stream-panel.tsx);
  - `openStreamFixtureIds(auth, ids): Promise<string[]>` (stream-sessions.ts :1228, still present in this task);
  - `routes.fixture(org, comp, div, no)`.
- Produces:
  - `server/stream-panel-context.ts`: `loadStreamPanelContext(args: {auth: AuthCtx; competitionId: string; sportKey: string; fixtureIds: readonly string[]; locale: Locale; offered: boolean; checkout?: {status?: string; sessionId?: string}}): Promise<StreamPanelContext | undefined>`, which is undefined when `!offered`.
  - **Cost, accepted and measured (review #11).** The loader now runs on every render of the fixture page for an
    organiser with Stream offered, including each `router.refresh()` after a scoring `send`
    (fixture-console.tsx:540). It costs: 2× `hasFeature`, `relayCredits` (with the idempotent
    `ensureMonthlyStreamGrant`), `preferredCurrency`, `getDictionary("public")` (no DB) and `openStreamStates`. The
    plan keeps it on the server rather than splitting it into a client fetch on first open, because the panel must
    render its Ready state without a spinner and the checkout return needs the post-reconcile balance on first paint.
    The bound is pinned by a test (Step 2, "the loader's reads"): each dependency is called **at most once** per
    render, so the count cannot grow unnoticed. T11 Step 2 records the measured number of SQL round trips per
    organiser refresh against the prod budget (60 connections, 3 × 12) in the task report. Spectators, scorers
    without `canEdit` and orgs without Stream pay nothing: `offered` is false and the loader returns before any read.
  - `lib/fixture-stream-mount.ts`:
    - `type FixtureStreamMode = "panel" | "stop-only" | null`;
    - `fixtureStreamMode(i: {canEdit: boolean; entitled: boolean; frozen: boolean; activeSession: boolean}): FixtureStreamMode`;
    - `type OpenPanel = "handover" | "stream" | null`;
    - `nextOpenPanel(current: OpenPanel, clicked: "handover" | "stream"): OpenPanel`.
  - `fixture-console.tsx`:
    - `export type FixtureStreamMount = {mode: "panel"; context: StreamPanelContext; fixture: StreamPanelFixture; entrantNames: Record<string, string>; tz: string} | {mode: "stop-only"}`;
    - props `stream?: FixtureStreamMount` and `streamReturn?: boolean`.
  - `FixtureStreamPanel` prop `openedByReturn?: boolean`.
  - DOM:
    - `data-role="fixture-stream"` (desktop, `max-md:hidden`);
    - `data-role="fixture-stream-phone"` (header strip, `md:hidden`, 44 × 44);
    - `data-role="console-stream"` (the fallback card).
  - Keys: `stream.button`.

- [ ] **Step 1: Write the failing pure tests** — `apps/web/src/lib/__tests__/fixture-stream-mount.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { fixtureStreamMode, nextOpenPanel, type OpenPanel } from "../fixture-stream-mount";

describe("fixtureStreamMode — who sees Stream on the fixture page (spec §2)", () => {
  it("the whole 16-row truth table: never without page canEdit; the panel only when entitled and not frozen; otherwise Stop-only while a session is up", () => {
    let checked = 0;
    for (const canEdit of [false, true]) for (const entitled of [false, true]) for (const frozen of [false, true]) for (const activeSession of [false, true]) {
      const got = fixtureStreamMode({ canEdit, entitled, frozen, activeSession });
      const want = !canEdit ? null : entitled && !frozen ? "panel" : activeSession ? "stop-only" : null;
      expect(got, JSON.stringify({ canEdit, entitled, frozen, activeSession })).toBe(want);
      checked++;
    }
    expect(checked).toBe(16);
  });
  it("Stop is ALWAYS reachable for an organiser with a session up — every entitled/frozen combination", () => {
    let checked = 0;
    for (const entitled of [false, true]) for (const frozen of [false, true]) {
      expect(fixtureStreamMode({ canEdit: true, entitled, frozen, activeSession: true })).not.toBeNull();
      checked++;
    }
    expect(checked).toBe(4);
  });
});

describe("nextOpenPanel — one panel open at a time (spec §2)", () => {
  it("opening one closes the other; tapping the open one closes it; every (current, clicked) pair", () => {
    const table: [OpenPanel, "handover" | "stream", OpenPanel][] = [
      [null, "handover", "handover"], [null, "stream", "stream"],
      ["handover", "handover", null], ["handover", "stream", "stream"],
      ["stream", "stream", null], ["stream", "handover", "handover"],
    ];
    for (const [cur, clicked, want] of table) expect(nextOpenPanel(cur, clicked), `${cur}+${clicked}`).toBe(want);
    expect(table).toHaveLength(6);
  });
});
```

In the truth-table test, `want` is an independent restatement of spec §2's sentence, not a copy of the function. The
second test is a property check.

- [ ] **Step 2: Write the failing console tests.** In `fixture-console-authority-band.test.tsx`, read how
  `consoleHtml(props)` builds its props, and extend it with `stream` and `streamReturn`. Keep every existing assertion,
  apart from the D4 text:

```ts
  it("offers Remote scoring twice (D4): the desktop button hides on phones, the phone icon hides on desktop, and both share one accessible name", () => {
    const html = consoleHtml({ deviceHandover: true });
    expect(html).toMatch(/data-role="device-handover"[^>]*class="[^"]*\smax-md:hidden"/);
    expect(html).toMatch(/data-role="device-handover"[^>]*>Remote scoring</);
    expect(html).toMatch(/<button[^>]*data-role="device-handover-phone"[^>]*>/);
    expect(html).toMatch(/data-role="device-handover-phone"[^>]*class="[^"]*\smd:hidden"/);
    expect(html).toMatch(/data-role="device-handover-phone"[^>]*aria-label="Remote scoring"/);
  });

  it("offers Stream twice when mounted: desktop btn-ghost min-h-11 max-md:hidden, phone 44px md:hidden, one accessible name — and BEFORE the hand-over control in both places", () => {
    const html = consoleHtml({ deviceHandover: true, stream: { mode: "stop-only" } });
    expect(html).toMatch(/data-role="fixture-stream"[^>]*class="btn btn-ghost min-h-11\smax-md:hidden"/);
    expect(html).toMatch(/data-role="fixture-stream-phone"[^>]*class="[^"]*\sh-11 w-11\s[^"]*\smd:hidden"/);
    expect(html).toMatch(/data-role="fixture-stream-phone"[^>]*aria-label="Stream"/);
    expect(html.indexOf('data-role="fixture-stream-phone"')).toBeLessThan(html.indexOf('data-role="device-handover-phone"'));
    expect(html.indexOf('data-role="fixture-stream"')).toBeLessThan(html.indexOf('data-role="device-handover"'));
  });

  it("renders neither Stream control without a mount — the positive pair's other half", () => {
    const html = consoleHtml({ deviceHandover: true });
    expect(html).not.toMatch(/data-role="fixture-stream"/);
    expect(html).not.toMatch(/data-role="fixture-stream-phone"/);
  });

  it("Review Focus 4: Stream stays reachable when the Scoring section does not render — finalized, cancelled, read-only (frozen) and TBD-sided", () => {
    const shapes = [
      { name: "finalized", props: { initialState: { ...baseState, status: "finalized" } } },
      { name: "cancelled", props: { initialState: { ...baseState, status: "cancelled" } } },
      { name: "read-only", props: { canEdit: false } },
      { name: "TBD side", props: { away: null } },
    ];
    let checked = 0;
    for (const s of shapes) {
      const html = consoleHtml({ ...s.props, stream: { mode: "stop-only" } });
      expect(html, s.name).not.toMatch(/data-role="console-scoring"/);
      expect(html, s.name).toMatch(/data-role="console-stream"/);
      expect(html, s.name).toMatch(/data-role="fixture-stream"/);
      expect(html, s.name).toMatch(/data-role="fixture-stream-phone"/);
      checked++;
    }
    expect(checked).toBe(4);
  });

  it("the fallback card is absent whenever the Scoring section renders (no second Stream button)", () => {
    const html = consoleHtml({ stream: { mode: "stop-only" } });
    expect(html).toMatch(/data-role="console-scoring"/);
    expect(html).not.toMatch(/data-role="console-stream"/);
    expect(html.match(/data-role="fixture-stream"/g)).toHaveLength(1);
  });

  it("?stream=open opens the stream panel on first render (streamReturn), and only then", () => {
    expect(consoleHtml({ stream: { mode: "stop-only" }, streamReturn: true })).toMatch(/data-role="fixture-stream"[^>]*aria-expanded="true"/);
    expect(consoleHtml({ stream: { mode: "stop-only" } })).toMatch(/data-role="fixture-stream"[^>]*aria-expanded="false"/);
  });
```

`baseState` stands for whatever initial-state literal the file's `consoleHtml` already uses. Spread it. Check the
file's own name for the "read-only" prop (`canEdit` on the console). The stop-only mount renders `PhoneStopProbe`,
which fetches on mount, so it is inert under `renderToStaticMarkup` and is safe here.

- [ ] **Step 3: Write the failing loader test** — `apps/web/src/server/__tests__/stream-panel-context.test.ts`.
  **Move** (not copy) into it the context-level cases of
  `app/o/[orgSlug]/c/[compSlug]/d/[divSlug]/__tests__/stream-checkout-return.test.tsx`: :181, :196, :226, :239, :257,
  :285, :408, :427, :447, :489 and :504. Re-target each at `loadStreamPanelContext` directly, with the same `vi.mock`s
  of `@/lib/entitlements`, `@/server/usecases/stream-sessions` (`relayCredits`), `@/server/relay/drivers`
  (`relayUnavailable`), `@/server/usecases/stream-credits-checkout`, `@/lib/currency-server`,
  `@/server/overlay/overlay-key` and `@/lib/i18n`. Every assertion keeps its strength: reconcile before the balance
  read, concurrency (M4), no credits read without the relay, one key per listed fixture, and no keys when switched off.
  Add:

```ts
  it("offered:false reads NOTHING — no entitlement query, no reconcile, no credits (a read-only viewer or a frozen page)", async () => {
    const got = await loadStreamPanelContext({ ...args, offered: false, checkout: { status: "success", sessionId: "cs_1" } });
    // (review #11) `offered: false` reads NOTHING — the scorer's and spectator's refresh stays free. Assert every
    // dependency mock (hasFeature, relayCredits, preferredCurrency, openStreamStates) has 0 calls here; then, in a
    // sibling case "the loader's reads", render once with `offered: true` and assert each is called AT MOST once
    // (hasFeature exactly twice), counting the mocks checked and failing on zero.
    expect(got).toBeUndefined();
    expect(entitlements.hasFeature).not.toHaveBeenCalled();
    expect(checkoutSpies.reconcileStreamCreditsCheckout).not.toHaveBeenCalled();
    expect(sessions.relayCredits).not.toHaveBeenCalled();
  });
```

The division page test keeps its frozen-probe cases (:319-406) and its `checkoutReturn` cases (:541-557) in this task
(the division mount is unchanged). It also keeps **one** case proving the page calls the loader:
`loadStreamPanelContext` is mocked, and the page passes `offered: tab === "fixtures" && editable`, its competition id,
and the fixture ids in page order.

- [ ] **Step 4: Write the failing checkout-route test.** In `relay-checkout/__tests__/route.test.ts`, replace the
  assertion on `returnUrl` (search it for `stream=open`):

```ts
    const [call] = createRelayCheckout.mock.calls;
    expect(call[0].returnUrl).toBe(
      `${base}${routes.fixture(scene.orgSlug, scene.compSlug, scene.divSlug, scene.fixtureNo)}?stream=open&checkout=success&session_id={CHECKOUT_SESSION_ID}`,
    );
    expect(call[0].returnUrl).not.toContain("tab=fixtures");
    expect(call[0].returnUrl).not.toContain("fixture=");
```

The test's SQL mock must now return `fixture_no`. Set it to a value other than 1 (for example 14), so a hard-coded
`/f/1` cannot pass.

- [ ] **Step 5: Run and confirm red.**

```bash
cd /Users/ashokhein/github/seazn.club/.claude/worktrees/fixture-stream/apps/web && rm -f /tmp/fs-t5.json && pnpm vitest run src/lib/__tests__/fixture-stream-mount.test.ts src/server/__tests__/stream-panel-context.test.ts src/components/v2/__tests__/fixture-console-authority-band.test.tsx src/app/api/billing/relay-checkout/__tests__/route.test.ts "src/app/o/[orgSlug]/c/[compSlug]/d/[divSlug]/__tests__/stream-checkout-return.test.tsx" --reporter=json --outputFile=/tmp/fs-t5.json; echo EXIT=$?; jq '{p:.numPassedTests,t:.numTotalTests,f:.numFailedTests,files:[.testResults[].name]}' /tmp/fs-t5.json
```

- [ ] **Step 6: Implement the pure module** — `apps/web/src/lib/fixture-stream-mount.ts`:

```ts
// lib/fixture-stream-mount.ts — the fixture page's Stream gate and the console's one-open-panel rule (spec 2026-09-30
// §2). Pure, so the node harness pins every row of both tables.

export type FixtureStreamMode = "panel" | "stop-only" | null;

/** Who sees Stream: the PAGE's canEdit (owner/admin — never the console's own `canScore && !frozen`), and either the
 *  org is entitled and not frozen (the full panel) or a session is still up (Stop only — today's PhoneStopProbe
 *  guarantee, moved here). Officials who can only score never see it. */
export function fixtureStreamMode(i: { canEdit: boolean; entitled: boolean; frozen: boolean; activeSession: boolean }): FixtureStreamMode {
  if (!i.canEdit) return null;
  if (i.entitled && !i.frozen) return "panel";
  return i.activeSession ? "stop-only" : null;
}

export type OpenPanel = "handover" | "stream" | null;

/** One panel open at a time: opening one closes the other; tapping the open one closes it. */
export function nextOpenPanel(current: OpenPanel, clicked: "handover" | "stream"): OpenPanel {
  return current === clicked ? null : clicked;
}
```

- [ ] **Step 7: Implement the loader** — `apps/web/src/server/stream-panel-context.ts`. Move the division page's
  block (:518-606) here verbatim in behaviour, keeping its comments that explain *why*:

```ts
import "server-only";
// server/stream-panel-context.ts — THE authority for the stream panel's per-page context (spec 2026-09-30 §2 "Shared
// context loader"). Moved from the division page (:518-606, Stream Overlay W1 task 6 + Streaming R1 lane D); the
// fixture page is now its main caller. Every comment below the header came with the code.
import type { StreamPanelContext } from "@/components/v2/fixture-stream-panel";
import { hasFeature } from "@/lib/entitlements";
import { getDictionary, type Locale } from "@/lib/i18n";
import { preferredCurrency } from "@/lib/currency-server";
import type { AuthCtx } from "@/server/api-v1/auth";
import { overlayKeyFor } from "@/server/overlay/overlay-key";
import { relayUnavailable } from "@/server/relay/drivers";
import { reconcileStreamCreditsCheckout } from "@/server/usecases/stream-credits-checkout";
import { relayCredits } from "@/server/usecases/stream-sessions";

export async function loadStreamPanelContext(args: {
  auth: AuthCtx;
  competitionId: string;
  sportKey: string;
  /** The fixtures whose OBS URL the panel copies — one per mount point (one on the fixture page). */
  fixtureIds: readonly string[];
  locale: Locale;
  /** The caller's gate: an organiser on an editable, not billing-frozen page. False reads nothing. */
  offered: boolean;
  checkout?: { status?: string; sessionId?: string };
}): Promise<StreamPanelContext | undefined> {
  if (!args.offered) return undefined;
  const { auth, competitionId } = args;
  // Both entitlement reads carry the competition id: an Event Pass grants for the competition it was bought for.
  const entitled = await hasFeature(auth.orgId, "streaming.overlay", competitionId);
  const relayEntitled = entitled && (await hasFeature(auth.orgId, "streaming.relay", competitionId));
  // I2 / N1 / m1: a deployment with no relay (or a live one missing a Cloudflare secret) reads as unavailable, asked
  // WITHOUT constructing the drivers, and skips the credits read — that read GRANTS the month's free credits.
  const relayDisabled = relayEntitled && relayUnavailable();
  // G1: the match-credit checkout returns to the FIXTURE page now (relay-checkout/route.ts), and this render can beat
  // Stripe's webhook — reconcile before the balance is read. Best-effort, idempotent, never throws.
  if (args.checkout?.status === "success" && args.checkout.sessionId) {
    await reconcileStreamCreditsCheckout(auth.orgId, args.checkout.sessionId);
  }
  // M4: the credits and the currency are independent reads, run together; both only with a running relay.
  const [credits, currency] = relayEntitled && !relayDisabled
    ? await Promise.all([relayCredits(auth, auth.orgId), preferredCurrency(auth.orgId)])
    : [null, "gbp" as const];
  return {
    entitled,
    relayEntitled,
    relayDisabled,
    orgId: auth.orgId,
    streamBalance: credits?.total ?? 0,
    streamSplit: credits ? { monthly: credits.monthly, pack: credits.pack, total: credits.total } : null,
    monthlyAllowance: credits?.monthlyAllowance ?? 0,
    currency,
    sportKey: args.sportKey,
    // RT: each listed fixture's signed overlay key; a fixture the server cannot sign for goes keyless.
    overlayKeys: entitled
      ? Object.fromEntries(args.fixtureIds.flatMap((id) => {
          const key = overlayKeyFor(id);
          return key ? [[id, key] as const] : [];
        }))
      : {},
    // The `overlay.*` slice of the PUBLIC dictionary: getDictionary is server-only, so the island cannot load it.
    overlayDict: entitled
      ? (Object.fromEntries(Object.entries(await getDictionary(args.locale, "public")).filter(([k]) => k.startsWith("overlay."))) as Record<string, string>)
      : {},
  };
}
```

Check the `Locale` type's real export (the division page passes `locale` from `resolveLocale()`), and check that
`preferredCurrency`'s call shape matches the division page's (:564).

Division page:
- Replace :532-606 with
  `const streamPanel = await loadStreamPanelContext({ auth, competitionId: competition.id, sportKey: division.sport_key, fixtureIds: fixtures.map((f) => f.id), locale, offered: tab === "fixtures" && editable, checkout: { status: checkout, sessionId: checkoutSessionId } });`
  and `const streamEntitled = streamPanel?.entitled ?? false;`.
- Keep `frozenOnAir` (:616-618) and its use of `streamEntitled`.
- Drop the imports only the moved block used (`relayUnavailable`, `reconcileStreamCreditsCheckout`,
  `preferredCurrency`, `overlayKeyFor`, and `relayCredits` from the stream-sessions import).

- [ ] **Step 8: Implement the fixture page.** In `f/[no]/page.tsx`:

```tsx
export default async function FixturePage({
  params,
  searchParams,
}: {
  params: Promise<{ orgSlug: string; compSlug: string; divSlug: string; no: string }>;
  /** The checkout return (relay-checkout/route.ts) and the run-sheet chip land here with `?stream=open`. */
  searchParams: Promise<{ stream?: string | string[]; checkout?: string | string[]; session_id?: string | string[] }>;
}) {
  const { orgSlug, compSlug, divSlug, no } = await params;
  const sp = await searchParams;
  const first = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v);
```

After `competition` is read (:75), and before the JSX:

```tsx
  // Spec 2026-09-30 §2 — Stream on the fixture page. The PAGE's canEdit (owner/admin), never the console's
  // `canScore && !frozen`. The context loader reads nothing unless the full panel is offered.
  const frozen = competition.frozen ?? false;
  const streamContext = await loadStreamPanelContext({
    auth, competitionId: competition.id, sportKey: division.sport_key, fixtureIds: [id], locale: await resolveLocale(),
    offered: canEdit && !frozen, checkout: { status: first(sp.checkout), sessionId: first(sp.session_id) },
  });
  const streamMode = fixtureStreamMode({
    canEdit, entitled: streamContext?.entitled ?? false, frozen,
    activeSession: canEdit ? (await openStreamFixtureIds(auth, [id])).length > 0 : false,
  });
  const streamMount: FixtureStreamMount | undefined =
    streamMode === "panel" && streamContext
      ? {
          mode: "panel", context: streamContext, tz: schedule.tz,
          fixture: { id, status: fixture.status, outcome: state.outcome, scheduled_at: fixture.scheduled_at, home_entrant_id: fixture.home_entrant_id, away_entrant_id: fixture.away_entrant_id },
          entrantNames: Object.fromEntries([home, away].flatMap((s) => (s ? [[s.id, s.name] as const] : []))),
        }
      : streamMode === "stop-only" ? { mode: "stop-only" } : undefined;
```

Read the page's own `home`/`away` `SideInfo` shape for the entrant id and display-name fields, and use those field
names. Read `getScheduleSettings`' return for the venue zone field; the run sheet passes `scheduleSettings.tz` as
`tz`. Pass `stream={streamMount}` and `streamReturn={first(sp.stream) === "open"}` to `<FixtureConsole>`. Imports:
`resolveLocale`, `loadStreamPanelContext`, `fixtureStreamMode`, `openStreamFixtureIds`, and the type
`FixtureStreamMount`.

- [ ] **Step 9: Implement the console.** In `fixture-console.tsx`:

```tsx
import { FixtureStreamPanel, PhoneStopProbe, type StreamPanelContext, type StreamPanelFixture } from "@/components/v2/fixture-stream-panel";
import { nextOpenPanel, type OpenPanel } from "@/lib/fixture-stream-mount";

/** Spec 2026-09-30 §2 — what the fixture page mounts behind Stream: the whole panel (entitled, not frozen) or Stop only
 *  (a session still up on a frozen, switched-off or finalized fixture). Absent ⇒ no Stream control at all. */
export type FixtureStreamMount =
  | { mode: "panel"; context: StreamPanelContext; fixture: StreamPanelFixture; entrantNames: Record<string, string>; tz: string }
  | { mode: "stop-only" };
```

Props (beside `deviceHandover`, :283): `stream?: FixtureStreamMount;` and
`/** `?stream=open` on the URL: open the stream panel on first render (checkout return, run-sheet chip). */ streamReturn?: boolean;`.

State (:444) replaces `handoverOpen`:

```tsx
  const [openPanel, setOpenPanel] = useState<OpenPanel>(() => (stream && streamReturn ? "stream" : null));
  const handoverOpen = openPanel === "handover";
  const streamOpen = openPanel === "stream";
```

Each `setHandoverOpen((v) => !v)` (at :888 and :1020) becomes `setOpenPanel((p) => nextOpenPanel(p, "handover"))`.
Then:

```tsx
  const scoringSection = scoring && !!home && !!away;
  const streamBody = stream && streamOpen ? (
    <div className="mb-4" data-role="fixture-stream-body">
      {stream.mode === "panel" ? (
        <FixtureStreamPanel fixture={stream.fixture} entrantNames={stream.entrantNames} tz={stream.tz} stream={stream.context} openedByReturn={!!streamReturn} />
      ) : (
        <PhoneStopProbe fixtureId={fixture.id} />
      )}
    </div>
  ) : null;
  const streamButton = stream ? (
    <button
      type="button"
      data-role="fixture-stream"
      aria-expanded={streamOpen}
      onClick={() => setOpenPanel((p) => nextOpenPanel(p, "stream"))}
      className="btn btn-ghost min-h-11 max-md:hidden"
    >
      {msg("stream.button")}
    </button>
  ) : null;
```

`consoleScoringEmptyOnPhone` (:745) gains `&& !(stream && streamOpen)`.

Phone twin, in the header strip, **before** the hand-over icon (:884):

```tsx
          {stream && (
            <button
              type="button"
              data-role="fixture-stream-phone"
              aria-label={msg("stream.button")}
              aria-expanded={streamOpen}
              onClick={() => setOpenPanel((p) => nextOpenPanel(p, "stream"))}
              className="flex h-11 w-11 shrink-0 items-center justify-center rounded-lg border border-slate-200 text-slate-700 transition-colors hover:bg-slate-50 focus-visible:outline focus-visible:outline-2 focus-visible:outline-violet-400 md:hidden"
            >
              <Video aria-hidden="true" className="h-5 w-5" strokeWidth={1.75} />
            </button>
          )}
```

`Video` is the `lucide-react` icon the run-sheet toggle already uses; import it the same way `fixture-stream-panel.tsx`
does.

In the Scoring header row (:1013), render `{streamButton}` before the hand-over button. After the
`{canHandOver && handoverOpen && (…DeviceLinkPanel…)}` block (:1040-1049), render `{streamBody}`.

After the Scoring section's closing tag, add the fallback:

```tsx
      {/* Spec 2026-09-30 §2 + Review Focus 4: the Scoring section renders only while this fixture can be scored with both
          sides known. A finalized, cancelled, read-only or TBD-sided fixture can still have a stream on air, and Stop
          must stay reachable there — so Stream gets its own card whenever the Scoring section is absent. */}
      {stream && !scoringSection && (
        <section className="card p-5 max-md:p-3" data-role="console-stream">
          <div className="mb-3 flex flex-wrap items-center justify-between gap-2 max-md:hidden">
            <h2 className="text-sm font-semibold text-slate-700">{msg("stream.title")}</h2>
            {streamButton}
          </div>
          {streamBody}
        </section>
      )}
```

On a phone the fallback card is empty until the strip icon opens the body. Add `max-md:hidden` to the section while
`!streamOpen`, following the `consoleScoringEmptyOnPhone` pattern:
`` className={`card p-5 max-md:p-3${streamOpen ? "" : " max-md:hidden"}`} ``.

- [ ] **Step 10: Re-home the panel's return reader.** In `fixture-stream-panel.tsx`, `FixtureStreamPanel` gains
  `openedByReturn?: boolean`, documented as "The fixture page's `?stream=open` (server-read). The run-sheet mount
  still passes nothing and reads `checkoutReturnFor` until T6 removes it." :303 becomes:

```tsx
  const [returnedHere] = useState(() => !!openedByReturn || checkoutReturnFor(searchParams, fixture.id));
```

G5's strip and B2's scroll read `returnedHere` unchanged, so both now fire on the fixture page. `RETURN_PARAMS`
already lists `stream`, `checkout` and `session_id`, and it deletes `fixture` harmlessly when that param is absent.
Add a panel test to `fixture-stream-panel.test.tsx`, where the harness renders with a `useSearchParams` mock: with
`openedByReturn` and no `fixture` param, the Phone tab renders selected (`stream-tab-phone` has `aria-selected="true"`
or the file's own selected marker). Without it, OBS is selected (the positive pair).

- [ ] **Step 11: Point the checkout return at the fixture page.** In `relay-checkout/route.ts`, the query (:73-79)
  selects `f.fixture_no` as well (and its row type gains `fixture_no: number`). Then:

```ts
    // Spec 2026-09-30 §2: the panel lives on the fixture page now, so the pack checkout returns THERE. `stream=open`
    // opens the Stream panel on its Phone tab; the fixture page reconciles `session_id` before reading the balance.
    const fixturePage = `${baseUrl(req)}${routes.fixture(fx.org_slug, fx.comp_slug, fx.div_slug, fx.fixture_no)}`;
```

and `returnUrl: \`${fixturePage}?stream=open&checkout=success&session_id={CHECKOUT_SESSION_ID}\``. The Stripe cancel
URL, if the route builds one from `tab`, gets the same base followed by `?stream=open` (read the route to see whether
it does).

- [ ] **Step 12: D4 rename, and the Stream label** (all four locales, then gen-keys):

| key | en | es | fr | nl |
|---|---|---|---|---|
| `score.handOverDevice` (changed) | `Remote scoring` | `Puntuación remota` | `Score à distance` | `Scoren op afstand` |
| `dlink.title` (changed) | `Remote scoring` | `Puntuación remota` | `Score à distance` | `Scoren op afstand` |
| `stream.button` (new) | `Stream` | `Emitir` | `Diffuser` | `Uitzenden` |

Then run `cd /Users/ashokhein/github/seazn.club/.claude/worktrees/fixture-stream && pnpm i18n:gen-keys && pnpm i18n:check`.
Also run `rtk proxy grep -rnaE "Hand over device|Hand this device over" apps/web/src apps/web/e2e scripts` and update
every **assertion** it finds to the new text. Do not change a test's title so that it claims something new: a title
saying "Hand over device" becomes "Remote scoring (D4)".

- [ ] **Step 13: Run the unit scope.**

```bash
cd /Users/ashokhein/github/seazn.club/.claude/worktrees/fixture-stream/apps/web && rm -f /tmp/fs-t5.json && pnpm vitest run src/lib/__tests__/fixture-stream-mount.test.ts src/server/__tests__/stream-panel-context.test.ts src/components/v2/__tests__/fixture-console-authority-band.test.tsx src/components/v2/__tests__/fixture-stream-panel.test.tsx src/components/v2/__tests__/device-link-panel.test.tsx src/components/v2/__tests__/device-link-panel-i18n.test.tsx src/app/api/billing/relay-checkout/__tests__/route.test.ts "src/app/o/[orgSlug]/c/[compSlug]/d/[divSlug]/__tests__/stream-checkout-return.test.tsx" src/lib/__tests__/relay-checkout.test.ts --reporter=json --outputFile=/tmp/fs-t5.json; echo EXIT=$?; jq '{p:.numPassedTests,t:.numTotalTests,f:.numFailedTests,files:[.testResults[].name]}' /tmp/fs-t5.json
```

Expected: `f: 0`, with all nine files collected.

- [ ] **Step 14: Move the walkthroughs to the fixture page** (every assertion keeps its strength).
  - In `stream-relay.spec.ts`, replace `openFixturesTab`, `rowOf` and `openPhoneTab` (:344-364) with:

```ts
/** The fixture's organiser page — where the stream panel lives (spec 2026-09-30 §2). */
async function openFixture(page: Page, rig: RelayRig, f: RelayFixture, query = ""): Promise<void> {
  await page.goto(`${rig.divPath}/f/${f.no}${query}`);
  await expect(page.locator('[data-role="console-scoring"], [data-role="console-stream"]').first(), `fixture ${f.no}'s console rendered`).toBeAttached({ timeout: 30_000 });
}

/** The width's own Stream control — the desktop button at ≥768, the strip icon below. Exactly one is visible. */
const streamControl = (page: Page): Locator =>
  page.locator('[data-role="fixture-stream"]:visible, [data-role="fixture-stream-phone"]:visible');

/** Open Stream and the Phone tab — the organiser's own way in. Returns the panel's scope (was: the run-sheet row). */
async function openPhoneTab(page: Page, rig: RelayRig, f: RelayFixture): Promise<Locator> {
  await openFixture(page, rig, f);
  const control = streamControl(page);
  await expect(control, `fixture ${f.no} offers exactly one visible Stream control`).toHaveCount(1, { timeout: 30_000 });
  await control.click();
  const scope = page.locator('[data-role="fixture-stream-body"]');
  const phoneTab = scope.getByTestId("stream-tab-phone");
  if (await phoneTab.count()) await phoneTab.click();   // the stop-only mount has no tabs
  await expect(
    scope.locator('[data-phone-body], [data-testid="stream-stop-probe"], [data-testid="stream-switched-off"]').first(),
  ).toBeAttached({ timeout: 30_000 });
  return scope;
}
```

  - Every `rowOf(page, f).…` in the file becomes the scope `openPhoneTab` returns, or `page.locator('[data-role="fixture-stream-body"]')`
    after an `openFixture`. Keep every `expect`, with its message and timeout.
  - Cases that asserted a **run-sheet row** property (a toggle's presence per status, the frozen-page probe stack on
    the division page) now assert the same property on the fixture page. The stop-only card replaces the division
    probe: a frozen org with a live session shows `stream-stop-probe` inside `fixture-stream-body` after one tap on
    the Stream control.
  - Re-cost `test.setTimeout` in EVERY case from the file's constants (AGENTS.md #20). The move adds cost **per
    navigation** (each `openFixture` / `openPhoneTab` is a full page load, where a run-sheet row click was not), so
    the budget is the case's current expression plus its navigations:
    `test.setTimeout(<the case's current expression> + NAVS * NAV_MS)`, with
    `const NAV_MS = 30_000; // one fixture-page load, the budget openFixture waits for` at the top of the file and
    `const NAVS = <n>; // openFixture/openPhoneTab calls in this case` declared inside each case, counted by reading
    the case. A `Math.max(current, …)` is not enough: every current budget already exceeds `SEED_MS + CYCLE_MS + NAV_MS`
    (:445, :546, :604, :675, :740, :808), so the max would return the old value and cost nothing.
  - `stream-credits.spec.ts` gets the same helpers. Its checkout-return case (~:860-900) now asserts:
    - the Stripe return lands on `${rig.divPath}/f/${f.no}` (not `?tab=fixtures`);
    - the Stream panel is open on the Phone tab;
    - `stream`, `checkout` and `session_id` are stripped from the URL (G5: read `page.url()` after
      `expect.poll`);
    - the balance shown is the post-reconcile one;
    - at 320, 768 and 1280 (the case's existing width loop, or add one over the spec's `WIDTHS`).
  - `e2e/stream-overlay.spec.ts:715-735, :852-870`: the `fixture-stream-toggle` click becomes `openFixture` plus
    `streamControl(page).click()`, followed by `stream-tab-obs` where the OBS tab is what it tests. Copy the two
    helpers into that file (it is not a walkthrough and does not share the walkthrough module).

- [ ] **Step 15: mobile.spec twin checks, both directions.** After :103 and :205, add:

```ts
  const deskStream = page.locator('[data-role="fixture-stream"]');
  const phoneStream = page.locator('[data-role="fixture-stream-phone"]');
  const streamOffered = (await deskStream.count()) > 0;
  // Twins are EQUAL in presence (one mount drives both) — never one without the other.
  expect(await phoneStream.count(), "the stream twins are present together or not at all").toBe(await deskStream.count());
```

In the phone branch: `if (streamOffered) { await expect(phoneStream).toBeVisible(); await expect(deskStream).toBeHidden(); }`.
The desktop branch is the mirror. `mobile.spec` runs on the shared Pro org (`AUTH_STATE`), where streaming is
entitled since V426. Add one assertion that `streamOffered` is true on the project's fixture page, so the twin check
cannot pass vacuously; if the page under test there is not an organiser page, assert it where it is. Update the
control-set log line's expected membership only if the file pins it.

- [ ] **Step 16: Smoke.** After `smoke.ts:16987`:

```ts
  // Spec 2026-09-30 §2: Stream now has a desktop button and a phone strip icon, driven by ONE mount — equal presence.
  // The smoke admin is an owner on an entitled org (V426: every plan grants streaming.overlay), so both must be HERE:
  // equality alone would pass on a page that dropped both.
  const streamDesktop = fixturePage.body.includes('data-role="fixture-stream"');
  const streamPhone = fixturePage.body.includes('data-role="fixture-stream-phone"');
  check("fixture console: the Stream button and its phone icon both ship on an organiser's fixture page", streamDesktop && streamPhone);
```

- [ ] **Step 17: Dated amendments.** In the phone-composition spec:
  - After §2's single-DOM bullet (:33), add:

```markdown
  > **Amended 2026-09-30** (`2026-09-30-fixture-page-stream-design.md` §2, owner ruling P1): TWO controls now exist twice — *Remote scoring* (formerly *Hand over device*, `device-handover` / `device-handover-phone`) and *Stream* (`fixture-stream` / `fixture-stream-phone`). Each desktop twin carries `max-md:hidden`, each phone twin `md:hidden`; the phone Stream icon sits before ⇄ in the strip.
```

  - In §3.1 (:49), after the ⇄ bullet: `- Phone-only (amended 2026-09-30): [●] Stream icon, 44×44, md:hidden, before ⇄ — see the amendment in §2.`
  - In the table (:97-99), add a row after "Hand over device": `| Stream *(2026-09-30)* | **Stream** *(strip icon, before ⇄)* |`.
  - In the smoke line (:130), append: `(2026-09-30: and data-role="fixture-stream-phone" beside its desktop twin.)`
  - In `AGENTS.md` :278, replace "Exactly ONE control is duplicated (the device hand-over), and its desktop twin
    carries `max-md:hidden`." with:

```markdown
  Exactly TWO controls are duplicated (amended 2026-09-30, fixture-page stream spec §2): the device hand-over (now
  labelled *Remote scoring*) and *Stream*; each desktop twin carries `max-md:hidden`.
```

  Keep the paragraph's following sentence. Read the whole bullet first so that the replaced text is exact.

- [ ] **Step 18: Mutate once each.**
  - `fixtureStreamMode`: `&& !i.frozen` deleted. Red: the truth table.
  - The console fallback's `!scoringSection` changed to `true`. Red: "the fallback card is absent whenever the
    Scoring section renders".
  - The fallback deleted entirely. Red: "Review Focus 4".
  - `nextOpenPanel` changed to `return clicked`. Red: the pair table.
  - relay-checkout: `fx.fixture_no` changed to `1`. Red: the route test (fixture 14).
  - Loader: the `offered` early return deleted. Red: "offered:false reads NOTHING".

- [ ] **Step 19: Walkthrough and e2e gate, whole files.** With a fresh prod build of this worktree:

```bash
cd /Users/ashokhein/github/seazn.club/.claude/worktrees/fixture-stream/apps/web && PLAYWRIGHT_BASE=http://localhost:3000 pnpm exec playwright test e2e/walkthrough/stream-relay.spec.ts e2e/walkthrough/stream-credits.spec.ts e2e/walkthrough/scorepad-v3-r7-console-chrome.spec.ts e2e/walkthrough/scorer-sheets-handover-panel.spec.ts e2e/walkthrough/scorer-sheets-print-scan.spec.ts --project=walkthrough --reporter=line; echo EXIT=$?
cd /Users/ashokhein/github/seazn.club/.claude/worktrees/fixture-stream/apps/web && PLAYWRIGHT_BASE=http://localhost:3000 pnpm exec playwright test e2e/stream-overlay.spec.ts --reporter=line; echo EXIT=$?
cd /Users/ashokhein/github/seazn.club/.claude/worktrees/fixture-stream/apps/web && PLAYWRIGHT_BASE=http://localhost:3000 pnpm exec playwright test e2e/mobile.spec.ts --reporter=line; echo EXIT=$?
```

  - The three device-handover walkthroughs (spec §9.3) live under `e2e/walkthrough/`, not `e2e/`. They assert the
    hand-over controls, so they owe the D4 text and the twin changes above.
  - Read `playwright.config.ts` for which projects `stream-overlay.spec.ts` and `mobile.spec.ts` run under, and pass
    no `--project`, so each runs in all of its projects.
  - `mobile.spec.ts` is `mode: "serial"`, so a red one is a floor, not a total. Re-run after every fix until a full
    pass completes (AGENTS.md #21).
  - Paste the passed and total counts.

- [ ] **Step 20: Typecheck, lint, commit.** Commit with
  `feat(stream): Stream on the fixture page (P1) — one-open-panel, Stop-only fallback, checkout returns there; Remote scoring (D4) (T5)`.

### Task 6: Remove the run-sheet mount; add the Live / Waiting chip

**Files:**
- Modify: `apps/web/src/components/v2/desk/run-sheet-row.tsx`:
  - :192 (`streamOpen`), :433 (`showStream`), :497-499 (toggle), :722-729 (panel);
  - the `stream?` prop becomes `streamState?`.
- Modify: `apps/web/src/components/v2/desk/run-sheet.tsx` (the `stream` prop becomes `streamStates`, at :344, :427, :464, :504). `runSheetKeeps` stays (premise 3).
- Modify: `apps/web/src/components/v2/stages-panel.tsx`:
  - :19: drop the `checkoutReturnFor` import;
  - :220-229: delete `initialRunSheetFilter`;
  - :379: drop the `checkoutReturn` prop;
  - :589-594: the filter's initial value is today's default without the return branch;
  - thread `streamStates`.
- Modify: `apps/web/src/components/v2/fixture-stream-panel.tsx`:
  - delete `checkoutReturnFor` (:232), `FixtureStreamToggle` (:242-280) and the `checkoutReturnFor` fallback in `returnedHere`;
  - `RETURN_PARAMS` drops `fixture`.
- Modify: `apps/web/src/server/usecases/stream-sessions.ts:1228-1236` (`openStreamFixtureIds` becomes `openStreamStates`)
- Modify: `apps/web/src/app/o/[orgSlug]/c/[compSlug]/d/[divSlug]/page.tsx`:
  - drop `loadStreamPanelContext`, `frozenOnAir`, the `frozen-stream-probes` block (:803-816) and the `PhoneStopProbe` import;
  - the `checkoutReturn` and `stream` props;
  - add the `streamStates` read.
- Modify: `apps/web/src/app/o/[orgSlug]/c/[compSlug]/d/[divSlug]/f/[no]/page.tsx` (use `openStreamStates`)
- Modify: dictionaries (`runsheet.stream.live`, `runsheet.stream.waiting`) + gen-keys
- Test: `desk/__tests__/run-sheet-row-stream-gate.test.tsx` becomes the chip test (the same file, retitled)
- Test: delete `src/components/v2/__tests__/stages-panel-checkout-return-filter.test.tsx`. Its subject is removed; record this in the commit body.
- Test: `stream-checkout-return.test.tsx` (division). Delete the frozen-probe cases (:319-406) and the `checkoutReturn` cases (:541-557), and add a `streamStates` case (below). The four sibling page tests that mock `openStreamFixtureIds` (`public-hub-link`, `registration-hub-link`, `roster-drift-stage-wiring`, `seed-proposal-stage-pairing`: find them with `rtk proxy grep -rlaE "openStreamFixtureIds" apps/web/src`) mock `openStreamStates` returning `{}` instead.
- Test: `stream-sessions.test.ts:2496` (the `openStreamFixtureIds` case becomes `openStreamStates`)
- Test (e2e): add a chip case to `e2e/walkthrough/stream-relay.spec.ts`

**Interfaces:**
- Consumes: `holdStateOf`, `HoldState` (T2a); the fixture page's `?stream=open` reader (T5).
- Produces:
  - `openStreamStates(auth, fixtureIds): Promise<Record<string, HoldState>>`, holding only fixtures with an active
    session. If two sessions somehow exist, the state of the newest wins.
  - Run-sheet row prop `streamState?: HoldState`. The chip is `data-testid="run-sheet-stream-chip"` with
    `data-state="live|waiting"`, and `href = \`${href}?stream=open\`` (the row's own fixture href).
  - Keys: `runsheet.stream.live`, `runsheet.stream.waiting`.

- [ ] **Step 1: Record the caller audit** (the spec says "check the callers first"):

```bash
cd /Users/ashokhein/github/seazn.club/.claude/worktrees/fixture-stream && rtk proxy grep -rnaE "runSheetKeeps|initialRunSheetFilter|checkoutReturnFor|checkoutReturn\b|FixtureStreamToggle|openStreamFixtureIds" apps/web/src apps/web/e2e scripts
```

Expected on 2026-09-30:
- `runSheetKeeps` is used by `run-sheet.tsx:271`: **keep**.
- `initialRunSheetFilter`: only `stages-panel.tsx` :220/:589 and its test.
- `checkoutReturnFor`: only the panel, `stages-panel.tsx` and tests.
- `openStreamFixtureIds`: the division page, the fixture page (T5) and tests.

Paste the output into the commit body. If anything else appears, keep that symbol and record why.

- [ ] **Step 2: Write the failing tests.** Rename the cases in `run-sheet-row-stream-gate.test.tsx` to the chip (read
  its `rowHtml(props)` harness):

```ts
describe("the run sheet's stream chip (spec 2026-09-30 §2) — the path to Stop from the division", () => {
  it("each hold state renders its chip, linking to THIS fixture's page with ?stream=open, 44px tall on phone", () => {
    let checked = 0;
    for (const state of ["live", "waiting"] as const) {
      const html = rowHtml({ canEdit: true, streamState: state, href: "/o/a/c/b/d/c/f/7" });
      expect(html, state).toMatch(new RegExp(`data-testid="run-sheet-stream-chip"[^>]*data-state="${state}"`));
      expect(html, state).toMatch(/data-testid="run-sheet-stream-chip"[^>]*href="\/o\/a\/c\/b\/d\/c\/f\/7\?stream=open"/);
      expect(html, state).toMatch(/data-testid="run-sheet-stream-chip"[^>]*class="[^"]*\smax-md:min-h-11[\s"]/);
      checked++;
    }
    expect(checked).toBe(2);
  });
  it("no session: no chip — and no stream toggle or in-row panel in ANY state (the mount moved to the fixture page)", () => {
    for (const streamState of [undefined, "live", "waiting"] as const) {
      const html = rowHtml({ canEdit: true, streamState, href: "/x" });
      expect(html).not.toMatch(/data-testid="fixture-stream-toggle"/);
      expect(html).not.toMatch(/data-testid="stream-panel"/);
    }
    expect(rowHtml({ canEdit: true, href: "/x" })).not.toMatch(/data-testid="run-sheet-stream-chip"/);
  });
  it("a viewer who cannot edit sees no chip (it opens organiser controls)", () => {
    expect(rowHtml({ canEdit: false, streamState: "live", href: "/x" })).not.toMatch(/run-sheet-stream-chip/);
  });
});
```

`stream-sessions.test.ts` (replacing the :2496 case, and keeping its seeding):

```ts
  it("openStreamStates: each fixture with an ACTIVE session maps to its hold state; terminal and other-org sessions are absent", async () => {
    const r = await streamRig({ fixtures: 2 });
    const [a, b] = r.fixtureIds;
    await r.session(a!, "live");
    await r.session(b!, "provisioning");
    let terminal = 0;
    for (const s of TERMINAL_STATES) { await r.session(b!, s); terminal++; }   // completed AND failed, on a listed fixture
    expect(terminal).toBe(TERMINAL_STATES.length);
    const other = await streamRig();
    await other.session(other.fixtureIds[0]!, "live");
    const auth = await authFor(r.orgId);              // the file's own AuthCtx builder for a streamRig org
    expect(await openStreamStates(auth, [a!, b!, other.fixtureIds[0]!])).toEqual({ [a!]: "live", [b!]: "waiting" });
    expect(await openStreamStates(auth, [])).toEqual({});
  });

  it("openStreamStates ONLY terminal sessions on a fixture: absent (each terminal state alone)", async () => {
    let checked = 0;
    for (const s of TERMINAL_STATES) {
      const r = await streamRig();
      const f = r.fixtureIds[0]!;
      await r.session(f, s);
      expect(await openStreamStates(await authFor(r.orgId), [f]), s).toEqual({});
      checked++;
    }
    expect(checked).toBe(TERMINAL_STATES.length);
  });

  it("§9.1 sequence — the run-sheet chip's state after Stop: live, then the organiser's Stop through the real use case, then the fixture is absent", async () => {
    const r = await rig();
    const { sessionId } = await createSession(r.auth, r.fixtureId, body(r.target.id), r.deps);
    r.tick(3000);
    expect((await currentSession(r.auth, r.fixtureId, r.deps))!.state).toBe("live");
    expect(await openStreamStates(r.auth, [r.fixtureId])).toEqual({ [r.fixtureId]: "live" });
    await stopSession(r.auth, r.fixtureId, sessionId, r.deps);
    // Drive to terminal the way the file's "organiser's Stop" PATH does (its grace tick), then read again.
    expect(await openStreamStates(r.auth, [r.fixtureId])).toEqual({});
  });
```

The two filters that used to cover for each other (the SQL `state in ACTIVE_STATES` and an `if (s)` in the loop) are
collapsed into ONE guard, the SQL filter; the loop now throws on a terminal row, so the assumption is loud instead of a
silent second filter. Both cases witness the SQL guard: with it dropped, the terminal rows reach the loop and it
throws. The first case seeds its terminal rows on fixture `b`, which also has an active one, so `distinct on
(fixture_id) … order by created_at desc` picks a terminal row there. For
the Stop sequence, read the existing `PATHS` entry "the organiser's Stop" (stream-sessions.test.ts ~:3238) for how it
reaches `completed` after `stopSession`, and replace the comment line with that exact tick-and-read.

Read the existing :2496 case for how it builds the AuthCtx for a `streamRig` org, and use the same builder in place of
`authFor`.

Division page test (`stream-checkout-return.test.tsx`), which keeps its harness:

```ts
  it("the fixtures tab hands the run sheet each fixture's stream state for an organiser, and reads none for a viewer or another tab", async () => {
    sessions.openStreamStates.mockResolvedValue({ f1: "live" });
    const tree = await renderDivision({ tab: "fixtures", canEdit: true });
    expect(findProps(tree, "StagesPanel").streamStates).toEqual({ f1: "live" });
    sessions.openStreamStates.mockClear();
    await renderDivision({ tab: "fixtures", canEdit: false });
    await renderDivision({ tab: "entrants", canEdit: true });
    expect(sessions.openStreamStates).not.toHaveBeenCalled();
  });
```

`renderDivision` and `findProps` stand for that file's own page-render and element-walk helpers; use their real names.

- [ ] **Step 3: Run and confirm red.**

```bash
cd /Users/ashokhein/github/seazn.club/.claude/worktrees/fixture-stream/apps/web && rm -f /tmp/fs-t6.json && pnpm vitest run src/components/v2/desk/__tests__/run-sheet-row-stream-gate.test.tsx src/server/usecases/__tests__/stream-sessions.test.ts "src/app/o/[orgSlug]/c/[compSlug]/d/[divSlug]/__tests__/stream-checkout-return.test.tsx" --reporter=json --outputFile=/tmp/fs-t6.json; echo EXIT=$?; jq '{p:.numPassedTests,t:.numTotalTests,f:.numFailedTests,files:[.testResults[].name]}' /tmp/fs-t6.json
```

- [ ] **Step 4: Implement.**

`stream-sessions.ts` (replacing :1228-1236; import `holdStateOf` and `HoldState`):

```ts
/** Spec 2026-09-30 §2 — each listed fixture with a session still up, as a person reads it (live | waiting). Feeds the
 *  run sheet's chip (the division's path to Stop) and the fixture page's Stop-only mount. */
export async function openStreamStates(auth: AuthCtx, fixtureIds: readonly string[]): Promise<Record<string, HoldState>> {
  if (fixtureIds.length === 0) return {};
  const rows = await sql<{ fixture_id: string; state: SessionState }[]>`
    select distinct on (fixture_id) fixture_id, state from fixture_stream_sessions
     where org_id = ${auth.orgId} and fixture_id in ${sql([...fixtureIds])} and state in ${sql([...ACTIVE_STATES])}
     order by fixture_id, created_at desc`;
  const out: Record<string, HoldState> = {};
  for (const r of rows) {
    // ONE guard decides "active": the SQL filter above. This line is the assumption made loud (TEST-STRATEGY:
    // assumptions are guards), not a second filter that would cover for the first and leave both untested.
    const s = holdStateOf(r.state);
    if (s === null) throw new Error(`openStreamStates: a terminal session (${r.state}) passed the ACTIVE_STATES filter`);
    out[r.fixture_id] = s;
  }
  return out;
}
```

Fixture page (T5's `activeSession`): `activeSession: canEdit ? (await openStreamStates(auth, [id]))[id] !== undefined : false`.

Division page:
- Delete the stream block from T5, plus `frozenOnAir` and the probe JSX.
- Add `const streamStates = tab === "fixtures" && canEdit ? await openStreamStates(auth, fixtures.map((f) => f.id)) : {};`
  and pass `streamStates` to `StagesPanel` (in place of `stream` and `checkoutReturn`).
- Remove the `searchParams` fields `stream` and `fixture` (:97-116) if nothing else reads them. `checkout` and
  `session_id` also become unread: remove them too.

`stages-panel.tsx` / `run-sheet.tsx`:
- Replace the `stream?: StreamPanelContext` prop with `streamStates?: Record<string, HoldState>` at every hop.
- RunSheet passes `streamState={streamStates?.[f.id]}` to each row, in place of `stream={stream}` (:344, :427, :464,
  :504).
- Delete `initialRunSheetFilter`. The filter's `useState` initialiser is its non-return branch, verbatim.

`run-sheet-row.tsx`:
- Delete `streamOpen` (:192), `showStream` (:433), the toggle (:497-499) and the panel (:722-729), and their imports.
- After the time cell, add:

```tsx
          {canEdit && streamState && (
            <Link
              href={`${href}?stream=open`}
              data-testid="run-sheet-stream-chip"
              data-state={streamState}
              className="inline-flex shrink-0 items-center gap-1 rounded-full border border-slate-200 px-2 py-0.5 text-xs font-medium text-slate-700 hover:bg-slate-50 max-md:min-h-11"
            >
              <span aria-hidden className={`inline-block h-1.5 w-1.5 rounded-full ${streamState === "live" ? "bg-red-600" : "bg-amber-500"}`} />
              {msg(streamState === "live" ? "runsheet.stream.live" : "runsheet.stream.waiting")}
            </Link>
          )}
```

Use the row's own `Link` import (the console-link wrapper) and its `href` prop. If the row's `href` is not the
organiser fixture page for every status, build it with `routes.fixture(…, fixture.fixture_no)` from the row's slugs.
Read which one the row has.

`fixture-stream-panel.tsx`:
- Delete `checkoutReturnFor` and `FixtureStreamToggle`.
- `returnedHere` becomes `useState(() => !!openedByReturn)`.
- `RETURN_PARAMS` becomes `["stream", "checkout", "session_id"] as const`.
- Delete the panel-test cases that pinned `checkoutReturnFor` (the stages filter test is already deleted).
- Keep the case T5 added (`openedByReturn` opens Phone).

Dictionaries:

| key | en | es | fr | nl |
|---|---|---|---|---|
| `runsheet.stream.live` | `Live` | `En directo` | `En direct` | `Live` |
| `runsheet.stream.waiting` | `Waiting for phone` | `Esperando al teléfono` | `En attente du téléphone` | `Wacht op telefoon` |

Then run `pnpm i18n:gen-keys && pnpm i18n:check`. Remove `stream.toggle` from all four dictionaries if
`rtk proxy grep -rnaE "stream\.toggle" apps/web/src` shows no reader left (spec §6: unused labels go), and regenerate.

- [ ] **Step 5: E2E for the chip.** Add to `stream-relay.spec.ts`:
  - A **sequence** case, "the run sheet's chip names the state and leads to Stop; after Stop it is gone".
  - Seed a target; go live through `goLiveApi`.
  - Open `${rig.divPath}?tab=fixtures` and select the "all" filter. Then
    `expect(page.locator(\`li[data-fixture-no="${f.no}"] [data-testid="run-sheet-stream-chip"]\`)).toHaveAttribute("data-state", "live")`.
  - Click the chip. Expect `page` to reach `/f/${f.no}` with `fixture-stream-body` visible and `stream-stop` inside it.
  - `confirmStop`, then poll the API until the state is `completed`.
  - Reload the fixtures tab. The chip `toHaveCount(0)`, and the **positive twin**: the same row is attached
    (`li[data-fixture-no]` count 1), so an empty sheet cannot pass.
  - Add a **waiting** variant: create without the phone connecting (the file's existing way to hold `warming`, used by
    A5), and assert `data-state="waiting"`.
  - Budget: `test.setTimeout(Math.max(120_000, SEED_MS + CYCLE_MS + 2 * NAV_MS))`.

- [ ] **Step 6: Run the unit scope, then the walkthroughs (whole files) and `e2e/stream-overlay.spec.ts`.**

```bash
cd /Users/ashokhein/github/seazn.club/.claude/worktrees/fixture-stream/apps/web && rm -f /tmp/fs-t6.json && pnpm vitest run src/components/v2/desk/__tests__/run-sheet-row-stream-gate.test.tsx src/server/usecases/__tests__/stream-sessions.test.ts "src/app/o/[orgSlug]/c/[compSlug]/d/[divSlug]/__tests__/stream-checkout-return.test.tsx" "src/app/o/[orgSlug]/c/[compSlug]/d/[divSlug]/__tests__/public-hub-link.test.tsx" "src/app/o/[orgSlug]/c/[compSlug]/d/[divSlug]/__tests__/registration-hub-link.test.tsx" "src/app/o/[orgSlug]/c/[compSlug]/d/[divSlug]/__tests__/roster-drift-stage-wiring.test.tsx" "src/app/o/[orgSlug]/c/[compSlug]/d/[divSlug]/__tests__/seed-proposal-stage-pairing.test.tsx" src/components/v2/__tests__/fixture-stream-panel.test.tsx src/components/v2/__tests__/fixture-console-authority-band.test.tsx --reporter=json --outputFile=/tmp/fs-t6.json; echo EXIT=$?; jq '{p:.numPassedTests,t:.numTotalTests,f:.numFailedTests,files:[.testResults[].name]}' /tmp/fs-t6.json
```

Confirm the four sibling page tests' real paths with the Step 1 grep before running, because a wrong path is silently
skipped. Then run the Step 19 walkthrough and e2e commands from T5, whole files.

- [ ] **Step 7: Mutate once each.**
  - The chip's `canEdit &&` deleted. Red: "a viewer who cannot edit sees no chip".
  - `openStreamStates` SQL: `state in ACTIVE_STATES` changed to `state is not null`. Red: "terminal … absent" and
    "ONLY terminal sessions … absent" (a terminal row reaches the loop, which throws).
  - `openStreamStates` loop: the `throw` replaced by `continue`, SQL filter restored. Stays green by design: it is the
    assumption guard, reachable only through the SQL mutant above. Record that in the report.
  - The chip's href without `?stream=open`. Red: the href regex, and the e2e case.

- [ ] **Step 8: Typecheck, lint, commit.** Commit with
  `feat(stream): run sheet shows Live / Waiting chip to the fixture page; run-sheet mount removed (T6)`, and put the
  Step 1 audit output in the body.

**Wave P gate:** re-run T5 Step 13 and T6 Step 6's vitest lists together (the JSON check, expecting `f: 0`), then
T5 Step 19's three Playwright commands, whole files.

## Wave D — Directory owns destinations

### Task 7: Directory → Streaming tab

**Files:**
- Create: `apps/web/src/lib/stream-key-shape.ts`
- Create: `apps/web/src/components/v2/stream-platform-mark.tsx`
- Create: `apps/web/src/components/v2/stream-destinations-panel.tsx`
- Modify: `apps/web/src/app/directory/page.tsx`:
  - :29: `TABS` gains `"streaming"`;
  - :75: add the tab render;
  - after :250: add `StreamingTab`.
- Modify: `apps/web/src/dictionaries/{en,es,fr,nl}/ui.json` (the `directory.tab.streaming`, `directory.streaming.desc` and `streamDest.*` keys) + gen-keys
- Create: `apps/web/e2e/walkthrough/directory-stream-destinations.spec.ts`
- Modify: `apps/web/src/lib/__tests__/e2e-ci-wiring.test.ts:278-282` (register the new spec in the directory group)
- Test (new): `apps/web/src/lib/__tests__/stream-key-shape.test.ts`
- Test (new): `apps/web/src/components/v2/__tests__/stream-destinations-panel.test.tsx`

**Interfaces:**
- Consumes:
  - `StreamTarget` with `keyHint` and `inUse` (T2a);
  - PATCH and DELETE with the 409 `TARGET_IN_USE {holder}` and 409 `DESTINATION_DUPLICATE {other}` shapes (T2b);
  - `listStreamTargets(auth, orgId)` server-side;
  - `STREAM_PLATFORMS`.
- Produces:
  - `lib/stream-key-shape.ts`:
    - `KEY_SHAPES: Readonly<Record<StreamPlatform, RegExp>>`;
    - `keyShapeWarning(kind: StreamPlatform, key: string): "streamDest.shape.youtube" | "streamDest.shape.twitch" | null`.
  - `stream-platform-mark.tsx`:
    - `STREAM_KIND_BRAND: Record<Exclude<StreamTargetKind, "custom_rtmp">, string>`;
    - `platformName(msg, kind): string`;
    - `PlatformMark({kind, size}: {kind: StreamTargetKind; size: "sm" | "md"})`.
  - `stream-destinations-panel.tsx`:
    - `StreamDestinationsPanel({orgId, canEdit, targets, locale})`;
    - pure `destinationMutationOutcome(status: number, op: "rename" | "replace" | "remove"): "refresh" | "error"`;
    - pure `rowLock(t: StreamTarget): {locked: boolean; matchNo: number | null}`.
  - Test ids:
    - `stream-dest-add`, `stream-dest-form`, `stream-dest-platform-{kind}`, `stream-dest-name`, `stream-dest-key`,
      `stream-dest-key-show`, `stream-dest-key-warning`, `stream-dest-watch`, `stream-dest-save`, `stream-dest-cancel`;
    - `stream-dest-row` with `data-target-id`, `stream-dest-subline`, `stream-dest-badge` with `data-state`;
    - `stream-dest-rename`, `stream-dest-replace`, `stream-dest-remove`, `stream-dest-menu`, `stream-dest-locked`;
    - `stream-dest-empty`, `stream-dest-error`.

- [ ] **Step 1: Write the failing pure tests** — `apps/web/src/lib/__tests__/stream-key-shape.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { STREAM_PLATFORMS } from "@/lib/stream-destinations";
import { KEY_SHAPES, keyShapeWarning } from "../stream-key-shape";

describe("keyShapeWarning — warns, never blocks (spec §4)", () => {
  it("every platform has a shape and a warning key of its own", () => {
    expect(Object.keys(KEY_SHAPES).sort()).toEqual([...STREAM_PLATFORMS].sort());
    let checked = 0;
    for (const p of STREAM_PLATFORMS) { expect(keyShapeWarning(p, "TestKeyName"), p).toBe(`streamDest.shape.${p}`); checked++; }
    expect(checked).toBe(STREAM_PLATFORMS.length);
  });
  it("YouTube: 4 or 5 groups of 4, case-insensitive, pass; the staging key NAME and the wrong group counts warn", () => {
    for (const ok of ["abcd-1234-efgh-5678", "abcd-1234-efgh-5678-ijkl", "ABCD-1234-EFGH-5678-IJKL"]) expect(keyShapeWarning("youtube", ok), ok).toBeNull();
    for (const bad of ["TestYouTube", "abcd-1234-efgh", "abcd-1234-efgh-5678-ijkl-mnop", "abcd_1234_efgh_5678", "abc-1234-efgh-5678"]) expect(keyShapeWarning("youtube", bad), bad).toBe("streamDest.shape.youtube");
  });
  it("Twitch: live_<digits>_<20+ alphanumerics> passes; 19 characters, a missing prefix and the key name warn", () => {
    const twenty = "AbCdEfGhIjKlMnOpQrSt";
    expect(keyShapeWarning("twitch", `live_123456789_${twenty}`)).toBeNull();
    for (const bad of [`live_123456789_${twenty.slice(1)}`, `123456789_${twenty}`, "TestTwitch", `live_abc_${twenty}`]) expect(keyShapeWarning("twitch", bad), bad).toBe("streamDest.shape.twitch");
  });
  it("an empty or whitespace-only key has no warning yet (the field is simply unfinished); surrounding whitespace is ignored", () => {
    expect(keyShapeWarning("youtube", "")).toBeNull();
    expect(keyShapeWarning("youtube", "   ")).toBeNull();
    expect(keyShapeWarning("youtube", "  abcd-1234-efgh-5678\n")).toBeNull();
  });
});
```

`apps/web/src/components/v2/__tests__/stream-destinations-panel.test.tsx`. Use the node harness of
`venues-panel.test.ts` (read it): `renderToStaticMarkup` inside the dictionary provider, plus `vi.mock` of
`next/navigation`.

```tsx
import en from "@/dictionaries/en/ui.json";
import { t } from "@/lib/i18n";
import type { StreamTarget } from "@/server/api-v1/schemas";
import { StreamDestinationsPanel, destinationMutationOutcome, rowLock } from "../stream-destinations-panel";

const target = (over: Partial<StreamTarget> = {}): StreamTarget => ({
  id: "t1", kind: "youtube", label: "Club YouTube", watchUrl: null, createdAt: "2026-09-12T10:00:00.000Z",
  keyHint: "8hd", inUse: null, ...over,
});
const live = { sessionId: "s", fixtureId: "f", href: "/o/a/c/b/d/c/f/5", matchNo: 5, courtName: "Court 1", state: "live" as const };

describe("the Directory Streaming tab (spec §4)", () => {
  it("a row: platform mark, name, and the subline '{Platform} · key ends …{hint} · added {date}'", () => {
    const html = panelHtml({ targets: [target()] });
    expect(html).toMatch(/data-testid="stream-dest-subline"[^>]*>YouTube · key ends …8hd · added /);
  });
  it("no key hint from the server: the subline says nothing about the key (never '…null')", () => {
    const html = panelHtml({ targets: [target({ keyHint: null })] });
    expect(html).not.toMatch(/key ends/);
    expect(html).not.toMatch(/null|undefined/);
    expect(html).toMatch(/data-testid="stream-dest-subline"[^>]*>YouTube · added /);
  });
  it("in use: a badge per state that LINKS to the holding match; Replace key and Remove disabled with 'Stop Match {n} first'; Rename stays enabled", () => {
    let checked = 0;
    for (const state of ["live", "waiting"] as const) {
      const html = panelHtml({ canEdit: true, targets: [target({ inUse: { ...live, state } })] });
      expect(html, state).toMatch(new RegExp(`data-testid="stream-dest-badge"[^>]*data-state="${state}"[^>]*href="/o/a/c/b/d/c/f/5"|href="/o/a/c/b/d/c/f/5"[^>]*data-testid="stream-dest-badge"[^>]*data-state="${state}"`));
      expect(html, state).toMatch(/data-testid="stream-dest-replace"[^>]*aria-disabled="true"/);
      expect(html, state).toMatch(/data-testid="stream-dest-remove"[^>]*aria-disabled="true"/);
      expect(html, state).not.toMatch(/data-testid="stream-dest-rename"[^>]*aria-disabled="true"/);
      expect(html, state).toContain(t(en, "streamDest.stopFirst", { match: t(en, "breadcrumb.match", { no: 5 }) }));
      checked++;
    }
    expect(checked).toBe(2);
  });
  it("a viewer who cannot edit sees the list and NO action and no Add", () => {
    const html = panelHtml({ canEdit: false, targets: [target()] });
    expect(html).toMatch(/data-testid="stream-dest-row"/);
    for (const id of ["stream-dest-add", "stream-dest-rename", "stream-dest-replace", "stream-dest-remove", "stream-dest-menu"]) expect(html, id).not.toMatch(new RegExp(`data-testid="${id}"`));
  });
  it("empty: the empty state with Add for an editor; the positive twin renders no empty state", () => {
    expect(panelHtml({ canEdit: true, targets: [] })).toMatch(/data-testid="stream-dest-empty"[\s\S]*data-testid="stream-dest-empty-add"/);
    expect(panelHtml({ canEdit: false, targets: [] })).toMatch(/data-testid="stream-dest-empty"/);
    expect(panelHtml({ canEdit: false, targets: [] })).not.toMatch(/data-testid="stream-dest-empty-add"/);
    expect(panelHtml({ canEdit: true, targets: [target()] })).not.toMatch(/data-testid="stream-dest-empty"/);
  });
  it("the phone ⋯ menu is a 44px md:hidden button; the desktop actions are max-md:hidden", () => {
    const html = panelHtml({ canEdit: true, targets: [target()] });
    expect(html).toMatch(/data-testid="stream-dest-menu"[^>]*class="[^"]*\sh-11 w-11\s[^"]*\smd:hidden"/);
    expect(html).toMatch(/data-role="stream-dest-actions"[^>]*class="[^"]*\smax-md:hidden"/);
  });
  it("a stored legacy kind lists with its brand, and the add form offers ONLY the create platforms", () => {
    const html = panelHtml({ canEdit: true, targets: [target({ kind: "facebook", label: "Old FB" })], addOpen: true });
    expect(html).toMatch(/Facebook · key ends/);
    expect(html.match(/data-testid="stream-dest-platform-[a-z_]+"/g)).toEqual(['data-testid="stream-dest-platform-youtube"', 'data-testid="stream-dest-platform-twitch"']);
  });
});

describe("destinationMutationOutcome (Review Focus 3)", () => {
  it("a 404 on a repeated Remove or Replace means it already happened: refresh, no error; a 409 or 5xx is an error", () => {
    expect(destinationMutationOutcome(404, "remove")).toBe("refresh");
    expect(destinationMutationOutcome(404, "replace")).toBe("refresh");
    expect(destinationMutationOutcome(409, "remove")).toBe("error");
    expect(destinationMutationOutcome(500, "remove")).toBe("error");
    expect(destinationMutationOutcome(404, "rename")).toBe("refresh");
  });
});

describe("rowLock", () => {
  it("locked exactly while inUse is set, carrying its match number", () => {
    expect(rowLock(target())).toEqual({ locked: false, matchNo: null });
    expect(rowLock(target({ inUse: live }))).toEqual({ locked: true, matchNo: 5 });
    expect(rowLock(target({ inUse: { ...live, matchNo: null } }))).toEqual({ locked: true, matchNo: null });
  });
});
```

`panelHtml({targets, canEdit = true, addOpen = false})` renders `<StreamDestinationsPanel orgId="o" canEdit={canEdit} targets={targets} locale="en" initialAddOpen={addOpen} />`
inside the file's dictionary provider. `initialAddOpen` is a test seam, documented in the component as "opens the add
form on first render; the page never passes it".

- [ ] **Step 2: Run and confirm red.**

```bash
cd /Users/ashokhein/github/seazn.club/.claude/worktrees/fixture-stream/apps/web && rm -f /tmp/fs-t7.json && pnpm vitest run src/lib/__tests__/stream-key-shape.test.ts src/components/v2/__tests__/stream-destinations-panel.test.tsx --reporter=json --outputFile=/tmp/fs-t7.json; echo EXIT=$?; jq '{p:.numPassedTests,t:.numTotalTests,f:.numFailedTests,files:[.testResults[].name]}' /tmp/fs-t7.json
```

- [ ] **Step 3: Implement the pure module** — `apps/web/src/lib/stream-key-shape.ts`:

```ts
// lib/stream-key-shape.ts — spec 2026-09-30 §4 "Key-shape warning". WARNS, never blocks: a platform can change its key
// format, and the organiser is the authority on what their dashboard shows. Its job is the staging incident — a key's
// NAME ("TestYouTube") saved where the key belongs.
import type { StreamPlatform } from "@/lib/stream-destinations";

export const KEY_SHAPES: Readonly<Record<StreamPlatform, RegExp>> = {
  youtube: /^[a-z0-9]{4}(-[a-z0-9]{4}){3,4}$/i,
  twitch: /^live_\d+_[A-Za-z0-9]{20,}$/,
};

export function keyShapeWarning(kind: StreamPlatform, key: string): `streamDest.shape.${StreamPlatform}` | null {
  const k = key.trim();
  if (k === "") return null;
  return KEY_SHAPES[kind].test(k) ? null : `streamDest.shape.${kind}`;
}
```

- [ ] **Step 4: Implement the mark** — `apps/web/src/components/v2/stream-platform-mark.tsx`. The mockup's marks are
  brand-coloured rounded squares with an initial (`directory.html`). Brand names are not copy (fixture-stream-panel.tsx
  `KIND_BRAND`); `custom_rtmp` takes its dictionary label.

```tsx
import type { StreamTargetKind } from "@/server/api-v1/schemas";

type Msg = (key: string, vars?: Record<string, string | number>) => string;

/** Brand names are not copy. Every stored kind lists (spec §5.4), so every kind has a name here. */
export const STREAM_KIND_BRAND: Record<Exclude<StreamTargetKind, "custom_rtmp">, string> = {
  youtube: "YouTube",
  facebook: "Facebook",
  twitch: "Twitch",
  kick: "Kick",
};

export function platformName(msg: Msg, kind: StreamTargetKind): string {
  return kind === "custom_rtmp" ? msg("stream.target.kind.other") : STREAM_KIND_BRAND[kind];
}

const MARK: Record<StreamTargetKind, { bg: string; fg: string; letter: string }> = {
  youtube: { bg: "#ff0033", fg: "#ffffff", letter: "Y" },
  twitch: { bg: "#9146ff", fg: "#ffffff", letter: "T" },
  facebook: { bg: "#1877f2", fg: "#ffffff", letter: "f" },
  kick: { bg: "#53fc18", fg: "#0b0e0f", letter: "K" },
  custom_rtmp: { bg: "#e2e8f0", fg: "#334155", letter: "•" },
};

export function PlatformMark({ kind, size }: { kind: StreamTargetKind; size: "sm" | "md" }) {
  const m = MARK[kind];
  const box = size === "md" ? "h-8 w-8 text-sm" : "h-5 w-5 text-[11px]";
  return (
    <span aria-hidden="true" className={`grid ${box} shrink-0 place-items-center rounded-md font-bold`} style={{ background: m.bg, color: m.fg }}>
      {m.letter}
    </span>
  );
}
```

Also export `export const STREAM_MARK_KINDS = Object.keys(MARK) as StreamTargetKind[];`, and add to
`stream-destinations-panel.test.tsx`:
`expect([...STREAM_MARK_KINDS].sort()).toEqual([...StreamTargetKind.options].sort())`. Every stored kind lists, so
every kind needs a mark.

- [ ] **Step 5: Implement the panel** — `apps/web/src/components/v2/stream-destinations-panel.tsx`. It follows
  `venues-panel.tsx`:
  - `"use client"`, `apiV1`, and `ApiV1Error`;
  - `useMsg` (check its real export in `components/i18n/dict-provider`);
  - `useConfirm` from `@/components/ui/confirm-provider`;
  - `useRouter().refresh()` after each mutation;
  - inline forms and no modals.
  The full component:

```tsx
"use client";
// Directory → Streaming (spec 2026-09-30 §4, owner rulings D1 D2 D6). Destinations are managed HERE only; the fixture
// panel picks one. Remove is an archive (D2) and is refused while a match is live or waiting on it — the row says which.
import { useState } from "react";
import { useRouter } from "next/navigation";
import { apiV1, ApiV1Error } from "@/lib/client-v1";
import { useMsg } from "@/components/i18n/dict-provider";
import { useConfirm } from "@/components/ui/confirm-provider";
import { STREAM_PLATFORMS, type StreamPlatform } from "@/lib/stream-destinations";
import { keyShapeWarning } from "@/lib/stream-key-shape";
import type { StreamTarget } from "@/server/api-v1/schemas";
import { PlatformMark, platformName } from "./stream-platform-mark";

/** Review Focus 3: a 404 on Rename, Replace or Remove means the row is already gone (a double tap, a second tab) — the
 *  list is refreshed and nothing is shown as an error. */
export function destinationMutationOutcome(status: number, _op: "rename" | "replace" | "remove"): "refresh" | "error" {
  return status === 404 ? "refresh" : "error";
}

/** D2: Replace key and Remove are locked while a match is live OR waiting on the destination. */
export function rowLock(t: Pick<StreamTarget, "inUse">): { locked: boolean; matchNo: number | null } {
  return t.inUse ? { locked: true, matchNo: t.inUse.matchNo } : { locked: false, matchNo: null };
}

type Msg = ReturnType<typeof useMsg>;

function errorText(msg: Msg, err: unknown): string {
  if (err instanceof ApiV1Error && err.code === "DESTINATION_DUPLICATE") {
    const other = (err.extra as { other?: { label?: string } }).other;
    return msg("streamDest.error.duplicate", { label: other?.label ?? "" });
  }
  if (err instanceof ApiV1Error && err.code === "TARGET_IN_USE") {
    const h = (err.extra as { holder?: { matchNo?: number | null } }).holder;
    return typeof h?.matchNo === "number"
      ? msg("streamDest.stopFirst", { match: msg("breadcrumb.match", { no: h.matchNo }) })
      : msg("streamDest.error.inUse");
  }
  return msg("streamDest.error.generic");
}

export function StreamDestinationsPanel({
  orgId, canEdit, targets, locale, initialAddOpen = false,
}: {
  orgId: string;
  canEdit: boolean;
  targets: StreamTarget[];
  /** For the "added {date}" subline — the page's locale, formatted the same on server and client. */
  locale: string;
  /** Test seam: opens the add form on first render. The page never passes it. */
  initialAddOpen?: boolean;
}) {
  const msg = useMsg();
  const router = useRouter();
  const [addOpen, setAddOpen] = useState(initialAddOpen);
  const [error, setError] = useState<string | null>(null);

  const run = async (op: "add" | "rename" | "replace" | "remove", call: () => Promise<unknown>): Promise<boolean> => {
    setError(null);
    try {
      await call();
      router.refresh();
      return true;
    } catch (err) {
      if (op !== "add" && err instanceof ApiV1Error && destinationMutationOutcome(err.status, op) === "refresh") {
        router.refresh();
        return true;
      }
      setError(errorText(msg, err));
      return false;
    }
  };

  return (
    <div className="space-y-4">
      {canEdit && (
        <div>
          <button type="button" data-testid="stream-dest-add" aria-expanded={addOpen} onClick={() => setAddOpen((v) => !v)} className="btn btn-primary min-h-11">
            {msg("streamDest.add")}
          </button>
          {addOpen && (
            <AddForm
              onCancel={() => setAddOpen(false)}
              onSave={async (body) => {
                const ok = await run("add", () => apiV1(`/api/v1/orgs/${orgId}/stream-targets`, { method: "POST", json: body }));
                if (ok) setAddOpen(false);
              }}
            />
          )}
        </div>
      )}
      {error && (
        <p data-testid="stream-dest-error" role="alert" className="text-sm text-red-700">{error}</p>
      )}
      {targets.length === 0 ? (
        <div data-testid="stream-dest-empty" className="card p-5 text-sm text-slate-600">
          <p>{msg("streamDest.empty")}</p>
          {canEdit && !addOpen && (
            <button type="button" data-testid="stream-dest-empty-add" onClick={() => setAddOpen(true)} className="btn btn-primary mt-3 min-h-11">
              {msg("streamDest.add")}
            </button>
          )}
        </div>
      ) : (
        <div className="card overflow-visible">
          <ul className="divide-y divide-slate-100" aria-label={msg("directory.tab.streaming")}>
            {targets.map((t) => (
              <DestinationRow key={t.id} t={t} canEdit={canEdit} locale={locale} orgId={orgId} run={run} />
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

function AddForm({ onSave, onCancel }: { onSave: (b: { kind: StreamPlatform; label: string; streamKey: string; watchUrl?: string }) => Promise<void>; onCancel: () => void }) {
  const msg = useMsg();
  const [kind, setKind] = useState<StreamPlatform>("youtube");
  const [label, setLabel] = useState("");
  const [key, setKey] = useState("");
  const [show, setShow] = useState(false);
  const [watch, setWatch] = useState("");
  const [busy, setBusy] = useState(false);
  const warning = keyShapeWarning(kind, key);
  const ready = label.trim().length >= 1 && label.length <= 80 && key.trim() !== "";
  return (
    <form
      data-testid="stream-dest-form"
      className="card mt-3 p-5 max-md:p-4"
      aria-label={msg("streamDest.add")}
      onSubmit={async (e) => {
        e.preventDefault();
        if (!ready || busy) return;
        setBusy(true);
        await onSave({ kind, label, streamKey: key, ...(watch.trim() ? { watchUrl: watch.trim() } : {}) });
        setBusy(false);
      }}
    >
      <fieldset>
        <legend className="text-sm font-medium text-slate-800">{msg("streamDest.platform")}</legend>
        <div role="radiogroup" aria-label={msg("streamDest.platform")} className="mt-1.5 flex flex-wrap gap-1 rounded-lg bg-slate-100 p-1">
          {STREAM_PLATFORMS.map((p) => (
            <button
              key={p}
              type="button"
              role="radio"
              aria-checked={kind === p}
              data-testid={`stream-dest-platform-${p}`}
              onClick={() => setKind(p)}
              className={`flex min-h-11 flex-1 basis-[5.5rem] items-center justify-center gap-2 rounded-md px-3 text-sm font-medium ${kind === p ? "bg-white text-purple-700 shadow-sm" : "text-slate-600 hover:text-slate-900"}`}
            >
              <PlatformMark kind={p} size="sm" />
              {platformName(msg, p)}
            </button>
          ))}
        </div>
      </fieldset>
      <div className="mt-4 grid gap-4 md:grid-cols-2">
        <label className="block text-sm font-medium text-slate-800">
          {msg("streamDest.name")}
          <input data-testid="stream-dest-name" className="input mt-1 min-h-11" maxLength={80} value={label} onChange={(e) => setLabel(e.target.value)} />
        </label>
        <div>
          <label htmlFor="stream-dest-key" className="text-sm font-medium text-slate-800">{msg("streamDest.key")}</label>
          <div className="relative mt-1">
            <input
              id="stream-dest-key"
              data-testid="stream-dest-key"
              type={show ? "text" : "password"}
              autoComplete="off"
              className={`input min-h-11 pr-20 font-mono${warning ? " border-amber-400 ring-1 ring-amber-200" : ""}`}
              aria-describedby={warning ? "stream-dest-key-warning" : undefined}
              value={key}
              onChange={(e) => setKey(e.target.value)}
            />
            <button type="button" data-testid="stream-dest-key-show" aria-pressed={show} onClick={() => setShow((v) => !v)} className="absolute right-1 top-1/2 flex min-h-11 -translate-y-1/2 items-center rounded-md px-3 text-sm font-medium text-purple-700 hover:bg-purple-50">
              {msg(show ? "streamDest.keyHide" : "streamDest.keyShow")}
            </button>
          </div>
          {warning && (
            <p id="stream-dest-key-warning" data-testid="stream-dest-key-warning" className="mt-2 text-sm text-amber-800">{msg(warning)}</p>
          )}
        </div>
      </div>
      <label className="mt-4 block text-sm font-medium text-slate-800">
        {msg("streamDest.watch")}
        <input data-testid="stream-dest-watch" type="url" inputMode="url" className="input mt-1 min-h-11" value={watch} onChange={(e) => setWatch(e.target.value)} />
      </label>
      <div className="mt-5 flex gap-2 max-md:flex-col">
        <button type="submit" data-testid="stream-dest-save" disabled={!ready || busy} className="btn btn-primary min-h-11">{msg("streamDest.save")}</button>
        <button type="button" data-testid="stream-dest-cancel" onClick={onCancel} className="btn btn-ghost min-h-11">{msg("streamDest.cancel")}</button>
      </div>
    </form>
  );
}
```

`DestinationRow` (same file) renders:
- the `li` with `data-testid="stream-dest-row"` and `data-target-id`;
- a `PlatformMark` of size `md`;
- the name, as `p.truncate font-semibold`;
- the subline `data-testid="stream-dest-subline"`, which is
  `msg(t.keyHint ? "streamDest.subline" : "streamDest.sublineNoHint", { platform: platformName(msg, t.kind), hint: t.keyHint ?? "", date: new Intl.DateTimeFormat(locale, { day: "numeric", month: "short" }).format(new Date(t.createdAt)) })`;
- the badge, when `t.inUse` is set. It is a `Link` to `t.inUse.href`, or a `span` when `href` is null, with
  `data-testid="stream-dest-badge"` and `data-state={t.inUse.state}`. Classes: live is
  `badge bg-red-50 text-red-700 ring-1 ring-red-200`, and waiting is `badge bg-amber-50 text-amber-800 ring-1 ring-amber-200`.
  It carries a dot `span` and `msg(t.inUse.state === "live" ? "streamDest.badge.live" : "streamDest.badge.waiting", { match })`,
  where `match = t.inUse.matchNo === null ? msg("streamDest.anotherMatch") : msg("breadcrumb.match", { no: t.inUse.matchNo })`.
  It renders once under the name with `md:hidden` and once beside the actions with `max-md:hidden`, as in the mockup.
- When `canEdit`, the desktop actions `div data-role="stream-dest-actions" className="flex shrink-0 gap-1 max-md:hidden"`:
  - Rename (`stream-dest-rename`), which is never disabled;
  - Replace key (`stream-dest-replace`) and Remove (`stream-dest-remove`), each with
    `aria-disabled={locked || undefined}`. While locked, each has `title={stopFirst}`, a click is a no-op, and there
    is a visible `span.sr-only` with the same text.
  - Locked buttons are never `disabled`, so the tooltip stays reachable and focusable.
  - `stopFirst` is `msg("streamDest.stopFirst", { match })`.
- The phone ⋯ button `data-testid="stream-dest-menu"`, classes
  `grid h-11 w-11 place-items-center rounded-lg border border-slate-200 bg-white text-slate-600 md:hidden`,
  `aria-haspopup="menu"`, `aria-expanded`, and `aria-label={msg("streamDest.more", { label: t.label })}`.
  - It opens an inline `div role="menu"` holding the same three actions as `role="menuitem"` buttons, each `min-h-11`.
  - While locked, the two locked items render `aria-disabled` with the `stopFirst` text inside the menu, in
    `data-testid="stream-dest-locked"`, per spec "text inside the menu on phone".
- The inline Rename editor (`stream-dest-rename-input`, Save, Cancel) calls
  `run("rename", () => apiV1(`/api/v1/orgs/${orgId}/stream-targets/${t.id}`, { method: "PATCH", json: { label } }))`.
- The inline Replace editor: a password-style key input (`stream-dest-replace-input`) with the same Show toggle and
  the same `keyShapeWarning` for **the row's kind**. For a legacy kind (not in `STREAM_PLATFORMS`) it shows no
  warning. Save calls `PATCH { streamKey }`.
- Remove: `const ok = await confirm({ title: msg("streamDest.confirmRemove.title", { label: t.label }), body: msg("streamDest.confirmRemove.body"), confirmLabel: msg("streamDest.remove"), tone: "danger" }); if (ok) await run("remove", () => apiV1(…, { method: "DELETE" }))`.

- [ ] **Step 6: Wire the tab.** `directory/page.tsx`:

```tsx
const TABS = ["players", "clubs", "officials", "venues", "streaming"] as const;
```

```tsx
        {tab === "streaming" && <StreamingTab ui={ui} locale={locale} />}
```

```tsx
// Spec 2026-09-30 §4 — every member sees the list; Add / Rename / Replace key / Remove render only for canEdit (owner or
// admin), matching the API's write gate. Read server-side through the same use-case the API serves (VenuesTab's shape).
async function StreamingTab({ ui, locale }: { ui: Dict; locale: string }) {
  const { auth, canEdit } = await requirePageAuth();
  const targets = await listStreamTargets(auth, auth.orgId);
  return (
    <div className="space-y-4">
      <p className="max-w-xl text-sm text-slate-500">{t(ui, "directory.streaming.desc")}</p>
      <StreamDestinationsPanel orgId={auth.orgId} canEdit={canEdit} targets={targets} locale={locale} />
    </div>
  );
}
```

Import `listStreamTargets` and `StreamDestinationsPanel`. The tab label reads `directory.tab.${tabKey}` (:70), so the
new key is `directory.tab.streaming`.

- [ ] **Step 7: Dictionaries** (all four, then `pnpm i18n:gen-keys && pnpm i18n:check`):

| key | en | es | fr | nl |
|---|---|---|---|---|
| `directory.tab.streaming` | `Streaming` | `Emisión` | `Diffusion` | `Streaming` |
| `directory.streaming.desc` | `Where your matches stream to. Every match picks one of these.` | `A dónde se emiten tus partidos. Cada partido elige uno de estos.` | `Où vos matchs sont diffusés. Chaque match choisit l’une de ces destinations.` | `Waar je wedstrijden naartoe streamen. Elke wedstrijd kiest er een.` |
| `streamDest.add` | `Add destination` | `Añadir destino` | `Ajouter une destination` | `Bestemming toevoegen` |
| `streamDest.platform` | `Platform` | `Plataforma` | `Plateforme` | `Platform` |
| `streamDest.name` | `Name` | `Nombre` | `Nom` | `Naam` |
| `streamDest.key` | `Stream key` | `Clave de transmisión` | `Clé de stream` | `Streamsleutel` |
| `streamDest.keyShow` | `Show` | `Mostrar` | `Afficher` | `Tonen` |
| `streamDest.keyHide` | `Hide` | `Ocultar` | `Masquer` | `Verbergen` |
| `streamDest.watch` | `Watch link (optional)` | `Enlace para ver (opcional)` | `Lien de visionnage (facultatif)` | `Kijklink (optioneel)` |
| `streamDest.save` | `Save destination` | `Guardar destino` | `Enregistrer la destination` | `Bestemming opslaan` |
| `streamDest.cancel` | `Cancel` | `Cancelar` | `Annuler` | `Annuleren` |
| `streamDest.shape.youtube` | `This looks like a key name, not a key. A YouTube key looks like abcd-1234-efgh-5678-ijkl.` | `Parece el nombre de una clave, no la clave. Una clave de YouTube tiene este aspecto: abcd-1234-efgh-5678-ijkl.` | `Cela ressemble au nom d’une clé, pas à une clé. Une clé YouTube ressemble à abcd-1234-efgh-5678-ijkl.` | `Dit lijkt op de naam van een sleutel, niet op een sleutel. Een YouTube-sleutel ziet eruit als abcd-1234-efgh-5678-ijkl.` |
| `streamDest.shape.twitch` | `This looks like a key name, not a key. A Twitch key looks like live_123456789_AbCdEfGhIjKlMnOpQrSt.` | `Parece el nombre de una clave, no la clave. Una clave de Twitch tiene este aspecto: live_123456789_AbCdEfGhIjKlMnOpQrSt.` | `Cela ressemble au nom d’une clé, pas à une clé. Une clé Twitch ressemble à live_123456789_AbCdEfGhIjKlMnOpQrSt.` | `Dit lijkt op de naam van een sleutel, niet op een sleutel. Een Twitch-sleutel ziet eruit als live_123456789_AbCdEfGhIjKlMnOpQrSt.` |
| `streamDest.subline` | `{platform} · key ends …{hint} · added {date}` | `{platform} · la clave termina en …{hint} · añadido el {date}` | `{platform} · clé se terminant par …{hint} · ajoutée le {date}` | `{platform} · sleutel eindigt op …{hint} · toegevoegd op {date}` |
| `streamDest.sublineNoHint` | `{platform} · added {date}` | `{platform} · añadido el {date}` | `{platform} · ajoutée le {date}` | `{platform} · toegevoegd op {date}` |
| `streamDest.badge.live` | `Live on {match}` | `En directo en {match}` | `En direct sur {match}` | `Live op {match}` |
| `streamDest.badge.waiting` | `Waiting for phone on {match}` | `Esperando al teléfono en {match}` | `En attente du téléphone sur {match}` | `Wacht op telefoon op {match}` |
| `streamDest.anotherMatch` | `another match` | `otro partido` | `un autre match` | `een andere wedstrijd` |
| `streamDest.rename` | `Rename` | `Renombrar` | `Renommer` | `Hernoemen` |
| `streamDest.replaceKey` | `Replace key` | `Cambiar clave` | `Remplacer la clé` | `Sleutel vervangen` |
| `streamDest.remove` | `Remove` | `Eliminar` | `Supprimer` | `Verwijderen` |
| `streamDest.stopFirst` | `Stop {match} first` | `Detén primero {match}` | `Arrêtez d’abord {match}` | `Stop eerst {match}` |
| `streamDest.more` | `Actions for {label}` | `Acciones para {label}` | `Actions pour {label}` | `Acties voor {label}` |
| `streamDest.confirmRemove.title` | `Remove {label}?` | `¿Eliminar {label}?` | `Supprimer {label} ?` | `{label} verwijderen?` |
| `streamDest.confirmRemove.body` | `It disappears from every match's destination list. Past streams keep its name. Adding the same key again brings it back.` | `Desaparece de la lista de destinos de todos los partidos. Las emisiones anteriores conservan su nombre. Si vuelves a añadir la misma clave, reaparece.` | `Elle disparaît de la liste des destinations de chaque match. Les diffusions passées gardent son nom. Ajouter à nouveau la même clé la fait revenir.` | `Hij verdwijnt uit de bestemmingslijst van elke wedstrijd. Eerdere streams houden de naam. Voeg je dezelfde sleutel opnieuw toe, dan komt hij terug.` |
| `streamDest.empty` | `No destinations yet. Add the stream key from YouTube or Twitch once, then pick it on any match.` | `Aún no hay destinos. Añade una vez la clave de transmisión de YouTube o Twitch y elígela en cualquier partido.` | `Aucune destination pour l’instant. Ajoutez une fois la clé de stream YouTube ou Twitch, puis choisissez-la sur n’importe quel match.` | `Nog geen bestemmingen. Voeg één keer de streamsleutel van YouTube of Twitch toe en kies hem daarna bij elke wedstrijd.` |
| `streamDest.error.duplicate` | `That key is already saved as {label}.` | `Esa clave ya está guardada como {label}.` | `Cette clé est déjà enregistrée sous {label}.` | `Die sleutel is al opgeslagen als {label}.` |
| `streamDest.error.inUse` | `This destination is in use on another match. Stop it there first.` | `Este destino se está usando en otro partido. Detenlo allí primero.` | `Cette destination est utilisée sur un autre match. Arrêtez-la d’abord là-bas.` | `Deze bestemming is in gebruik bij een andere wedstrijd. Stop hem daar eerst.` |
| `streamDest.error.generic` | `That didn't save. Try again.` | `No se guardó. Inténtalo de nuevo.` | `L’enregistrement a échoué. Réessayez.` | `Opslaan is mislukt. Probeer het opnieuw.` |
| `streamDest.renameSave` | `Save name` | `Guardar nombre` | `Enregistrer le nom` | `Naam opslaan` |
| `streamDest.replaceSave` | `Save key` | `Guardar clave` | `Enregistrer la clé` | `Sleutel opslaan` |

The empty state carries **+ Add destination** only for an editor. For a viewer it shows the sentence alone (the add
control above it is `canEdit`-only).

- [ ] **Step 8: The walkthrough** — `apps/web/e2e/walkthrough/directory-stream-destinations.spec.ts`. It reuses the
  stream walkthroughs' seeding: copy `seedRelayRig`'s org and entitlement seeding into this file, or import it if the
  walkthrough folder already has a shared helper module (check `e2e/walkthrough/_*.ts`). Every case asserts through
  the UI and reads the API back as the witness. The cases, one `test` each, in the spec's §9.2 order:
  1. **Add with the shape warning, and both sides of the key-hint floor.**
     - Type `TestYouTube` as the key. `stream-dest-key-warning` is visible with the `streamDest.shape.youtube` text
       from the `en` dictionary import, and `stream-dest-save` is **enabled** (it warns, never blocks).
     - Save. The row's subline is the no-hint form: `TestYouTube` is 11 characters, below `KEY_HINT_MIN_LENGTH` 12.
       Assert that `key ends` is absent.
     - Add a second destination with `abcd-1234-efgh-5678-ijkl`. There is no warning, and its subline shows `…jkl`.
     - The API list's `keyHint` values read back as `null` and `"jkl"`.
  2. **Rename.** Rename the row and see the new name after `router.refresh()`. The API GET returns the new label.
  3. **Replace key.** Replace with `wxyz-9876-abcd-5432-efgh`. The subline shows `…fgh`, and the API `keyHint` is `fgh`.
  4. **Remove.** Confirm. The row is gone. The API list excludes it, and a DELETE through `page.request` gives 404.
  5. **In-use refusal while waiting, then while live.**
     - Seed a destination and create a session through the API without connecting (the waiting state).
     - Open the tab. `stream-dest-badge[data-state="waiting"]` links to `/f/{no}`.
     - Replace and Remove are `aria-disabled="true"`, and their title is `Stop Match {no} first`.
     - Click Remove: nothing happens, and the row stays.
     - Take the session live (`goLiveApi`): the badge is `data-state="live"`.
     - Stop it through the API: Remove is enabled.
     - Remove it: gone. This is the spec's sequence "Remove while waiting (refused), then Stop, then Remove (allowed)".
  6. **Re-add restores.** Remove, then add with the same key and a new name. The API list returns the **same id**
     (captured before the remove) with the new name.
  7. **The empty state.** On a fresh org, `stream-dest-empty` is visible with the `streamDest.empty` text, and its
     own `stream-dest-empty-add` (spec §4.1 "+ Add destination") opens `stream-dest-form`.
  8. **The phone ⋯ menu** at 320×568 (`page.setViewportSize`): `stream-dest-menu` is visible and ≥ 44×44 by
     `boundingBox`, and `elementFromPoint` at its centre is the button (a real hit-test). Open it: three menu items. For
     a held row, `stream-dest-locked` shows the Stop-first text. `stream-dest-actions` is hidden.
  9. **No horizontal scroll** at 320, 768 and 1280 on the tab with 3 rows, one of them held. Use the stream specs'
     `expectNoHorizontalScroll` pattern, and assert the count of widths checked is 3.
  10. **"Manage destinations" from the panel.** This moves here in T8, where the link is created.
  - Budget: `test.setTimeout` for the in-use case is `Math.max(120_000, SEED_MS + CYCLE_MS + SLOT_WAIT_MS)`, with the
    constants copied from `stream-relay.spec.ts` (:79-103). The capacity note is premise 11: this spec takes a slot
    through the same `streamSlot()` lock scheme (`SLOT_LOCK_BASE`) and waits.

Register it in `e2e-ci-wiring.test.ts` under the directory group (:278-282), with a comment line:
`// The Streaming tab (2026-09-30): destinations' add, shape warning, rename, replace key, remove=archive, the in-use lock (waiting and live), re-add restores, the empty state, the phone ⋯ menu.`
Add `"directory-stream-destinations.spec.ts",` after `"directory-venues-courts.spec.ts",`.

- [ ] **Step 9: Run the unit scope and the new walkthrough (whole file).**

```bash
cd /Users/ashokhein/github/seazn.club/.claude/worktrees/fixture-stream/apps/web && rm -f /tmp/fs-t7.json && pnpm vitest run src/lib/__tests__/stream-key-shape.test.ts src/components/v2/__tests__/stream-destinations-panel.test.tsx src/lib/__tests__/e2e-ci-wiring.test.ts src/components/v2/__tests__/venues-panel.test.ts --reporter=json --outputFile=/tmp/fs-t7.json; echo EXIT=$?; jq '{p:.numPassedTests,t:.numTotalTests,f:.numFailedTests,files:[.testResults[].name]}' /tmp/fs-t7.json
cd /Users/ashokhein/github/seazn.club/.claude/worktrees/fixture-stream/apps/web && PLAYWRIGHT_BASE=http://localhost:3000 pnpm exec playwright test e2e/walkthrough/directory-stream-destinations.spec.ts e2e/walkthrough/directory-venues-courts.spec.ts --project=walkthrough --reporter=line; echo EXIT=$?
```

`directory-venues-courts` is re-run because the tab strip changed.

- [ ] **Step 10: Mutate once each.**
  - `KEY_SHAPES.youtube`: the `i` flag dropped. Red: the uppercase case.
  - `{3,4}` changed to `{3}`. Red: the 5-group case.
  - `destinationMutationOutcome`: always `"error"`. Red: Review Focus 3.
  - `rowLock`: always `locked: false`. Red: "in use: … disabled".
  - The panel's `canEdit &&` on the actions. Red: "a viewer who cannot edit".

- [ ] **Step 11: Screenshots at 1280, 768 and 320** of the tab (empty, three rows with one held, the add form open
  with the warning, and the phone menu open). Crop to the panel (full-page captures flood context). Compare against
  `directory-1280.png` and `directory-320.png`, and write a per-screen verdict into the task report.
  **Mockup deviation:** `directory.html` shows "Server: YouTube's standard server · Change server" and a Server URL
  field. Spec §4 ("**No server field.**") and D6 overrule it, so none is built. Record this in the verdict.

- [ ] **Step 12: Typecheck, lint, commit.** Commit with
  `feat(directory): Streaming tab — add/rename/replace key/remove, in-use lock, key-shape warning (T7)`.

### Task 8: The fixture panel's destination picker

**Files:**
- Modify: `apps/web/src/components/v2/fixture-stream-panel.tsx`:
  - :764: delete `TargetFormValues`;
  - :1002: delete `showTargetForm`;
  - :1018-1029: the silent catch becomes a load state;
  - :1143-1161: delete `onSaveTarget`;
  - :1252-1300: `PhoneTabBodyProps`;
  - :1600-1640: the picker block;
  - :1879: delete `TargetForm`;
  - `createErrorText` usage: the in-use line gains the **Open Match** link.
- Modify: dictionaries (the `stream.dest.*` keys; remove `stream.target.label/kind/rtmp/key/watch/save/cancel/error` if unused) + gen-keys
- Modify: `apps/web/e2e/walkthrough/stream-relay.spec.ts`:
  - A1 no longer adds through the panel: it seeds through `addTargetApi` and asserts the picker;
  - A8's remaining form assertion moves to the Directory spec's case 1;
  - add the "Manage destinations" case to `directory-stream-destinations.spec.ts` as case 10.
- Test: `apps/web/src/components/v2/__tests__/fixture-stream-panel.test.tsx`

**Interfaces:**
- Consumes: `StreamTarget` (T2a); `CreateErrorHolder` (the parsed holder, T3) and `createErrorText` (T3);
  `PlatformMark`, `platformName` (T7).
- Produces:
  - `type TargetsState = {status: "loading"} | {status: "error"} | {status: "ok"; list: StreamTarget[]}`;
  - `PhoneTabBodyProps.targets: TargetsState`, replacing `StreamTarget[]`;
  - `onRetryTargets: () => void`;
  - `showTargetForm`, `onAddTarget` and `onSaveTarget` are removed.
  - Test ids:
    - `stream-manage-destinations` (`href="/directory?tab=streaming"`, `target="_blank"`, `rel="noopener"`);
    - `stream-dest-empty`, `stream-dest-load-error`, `stream-dest-retry`;
    - `stream-in-use-open`;
    - the existing `stream-target` select stays.

- [ ] **Step 1: Write the failing tests** in `fixture-stream-panel.test.tsx`, using `PhoneTabBody` with its node
  harness (read the file's `bodyHtml(props)` builder, which renders every state without a network):

```tsx
  it("D1: no inline add form anywhere — the picker offers 'Manage destinations' to the Directory tab, in a new tab", () => {
    const html = bodyHtml({ targets: { status: "ok", list: [target()] } });
    expect(html).not.toMatch(/data-testid="stream-target-add"/);
    expect(html).not.toMatch(/data-testid="stream-target-form"/);
    expect(html).toMatch(/data-testid="stream-manage-destinations"[^>]*href="\/directory\?tab=streaming"[^>]*target="_blank"/);
  });
  it("no destinations: the empty copy and link, Go live DISABLED; one destination: Go live enabled (the positive pair)", () => {
    const none = bodyHtml({ targets: { status: "ok", list: [] } });
    expect(none).toMatch(/data-testid="stream-dest-empty"/);
    expect(none).toMatch(/data-testid="stream-go-live"[^>]*disabled=""/);
    const one = bodyHtml({ targets: { status: "ok", list: [target()] }, selectedTargetId: "t1" });
    expect(one).not.toMatch(/data-testid="stream-dest-empty"/);
    expect(one).not.toMatch(/data-testid="stream-go-live"[^>]*disabled=""/);
  });
  it("a failed destination load is an ERROR with Retry — never shown as 'none' (fixes the silent catch)", () => {
    const html = bodyHtml({ targets: { status: "error" } });
    expect(html).toMatch(/data-testid="stream-dest-load-error"/);
    expect(html).toMatch(/data-testid="stream-dest-retry"/);
    expect(html).not.toMatch(/data-testid="stream-dest-empty"/);
    expect(html).toMatch(/data-testid="stream-go-live"[^>]*disabled=""/);
  });
  it("loading: neither 'none' nor an error", () => {
    const html = bodyHtml({ targets: { status: "loading" } });
    expect(html).not.toMatch(/stream-dest-empty|stream-dest-load-error/);
  });
  it("a target_in_use refusal names the match and links 'Open Match {n}' to its page; a deleted holder shows no link", () => {
    const held = bodyHtml({ createError: { code: "target_in_use", holder: { label: "Club YouTube", matchNo: 5, courtName: "Court 1", href: "/o/a/c/b/d/c/f/5", state: "waiting" } } });
    expect(held).toContain("Club YouTube is waiting for a phone on Match 5 · Court 1.");
    expect(held).toMatch(/data-testid="stream-in-use-open"[^>]*href="\/o\/a\/c\/b\/d\/c\/f\/5"[^>]*>Open Match 5</);
    const gone = bodyHtml({ createError: { code: "target_in_use", holder: { label: "X", matchNo: null, courtName: null, href: null, state: "live" } } });
    expect(gone).not.toMatch(/data-testid="stream-in-use-open"/);
  });
```

`createError` is the PARSED `{code, holder}` the panel stores (fixture-stream-panel.tsx:1086 runs
`createErrorHolder(err)` on the raw error once), never the raw `{status, code, extra}`. Use the file's own `target()`
builder if it has one. Otherwise add the one from T7's test.

- [ ] **Step 2: Run and confirm red** (the same JSON command, with `src/components/v2/__tests__/fixture-stream-panel.test.tsx`).

- [ ] **Step 3: Implement.** In `PhoneTab`:

```tsx
export type TargetsState = { status: "loading" } | { status: "error" } | { status: "ok"; list: StreamTarget[] };
```

```tsx
  const [targets, setTargets] = useState<TargetsState>({ status: "loading" });
  const [targetsTry, setTargetsTry] = useState(0);
  useEffect(() => {
    let live = true;
    setTargets({ status: "loading" });
    void (async () => {
      try {
        // created_at order (listStreamTargets), so the first is the org's oldest destination.
        const list = await apiV1<StreamTarget[]>(`/api/v1/orgs/${orgId}/stream-targets`);
        if (!live) return;
        setTargets({ status: "ok", list });
        setSelectedTargetId((cur) => (cur && list.some((t) => t.id === cur) ? cur : list[0]?.id ?? null));
      } catch {
        // Spec §3.3: an unreadable list is an ERROR with Retry — never "none", which told an organiser with five saved
        // destinations to go and add one (the silent catch this replaces).
        if (live) setTargets({ status: "error" });
      }
    })();
    return () => { live = false; };
  }, [orgId, targetsTry]);
```

Pass `onRetryTargets={() => setTargetsTry((n) => n + 1)}`. Every read of `targets` as an array in `PhoneTab` and
`PhoneTabBody` becomes `targets.status === "ok" ? targets.list : []`. Find the reads with
`rtk proxy grep -naE "targets\b" apps/web/src/components/v2/fixture-stream-panel.tsx`.

In `PhoneTabBody`, the destination block (:1600-1640) becomes:

```tsx
          <div>
            <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
              <label htmlFor={`stream-target-${fixtureId}`} className="text-sm font-medium text-slate-800">{msg("stream.dest.label")}</label>
              <a
                data-testid="stream-manage-destinations"
                href="/directory?tab=streaming"
                target="_blank"
                rel="noopener"
                className="tlink inline-flex min-h-11 items-center gap-1 text-sm md:min-h-0"
              >
                {msg("stream.dest.manage")}
              </a>
            </div>
            {p.targets.status === "error" ? (
              <div data-testid="stream-dest-load-error" role="alert" className="mt-1 flex flex-wrap items-center gap-2 text-sm text-red-700">
                <span>{msg("stream.dest.loadError")}</span>
                <button type="button" data-testid="stream-dest-retry" onClick={p.onRetryTargets} className="btn btn-ghost min-h-11">{msg("stream.dest.retry")}</button>
              </div>
            ) : p.targets.status === "ok" && p.targets.list.length === 0 ? (
              <p data-testid="stream-dest-empty" className="mt-1 text-sm text-slate-600">
                {msg("stream.dest.empty")}{" "}
                <a href="/directory?tab=streaming" target="_blank" rel="noopener" className="tlink">{msg("stream.dest.manage")}</a>
              </p>
            ) : p.targets.status === "ok" ? (
              <select
                id={`stream-target-${fixtureId}`}
                data-testid="stream-target"
                className="input mt-1 min-h-11"
                value={p.selectedTargetId ?? ""}
                onChange={(e) => p.onSelectTarget(e.target.value)}
              >
                {p.targets.list.map((t) => (
                  <option key={t.id} value={t.id}>{`${t.label} (${platformName(msg, t.kind)})`}</option>
                ))}
              </select>
            ) : null}
          </div>
```

Keep the select's existing attributes (read the current block). `fixtureId` here is whatever id the existing select
already uses. `platformName` replaces `KIND_BRAND`: delete `KIND_BRAND` and import from `stream-platform-mark.tsx`.
The platform mark inside the select comes in T9b's restyle, not here.

Go live's `disabled` gains `|| p.targets.status !== "ok" || p.targets.list.length === 0`.

Where `createErrorText` renders the refusal (`stream-create-error`), add after the text:

```tsx
              {(() => {
                const h = p.createError?.code === "target_in_use" ? p.createError.holder : null;   // already parsed at :1086
                return h?.href && h.matchNo !== null ? (
                  <a data-testid="stream-in-use-open" href={h.href} className="tlink ml-1">
                    {msg("stream.inUse.open", { match: msg("breadcrumb.match", { no: h.matchNo }) })}
                  </a>
                ) : null;
              })()}
```

Delete `TargetForm`, `TargetFormValues`, `showTargetForm`, `onAddTarget` and `onSaveTarget`, and the `stream-target-add`
button.

Dictionaries:

| key | en | es | fr | nl |
|---|---|---|---|---|
| `stream.dest.label` | `Destination` | `Destino` | `Destination` | `Bestemming` |
| `stream.dest.manage` | `Manage destinations` | `Gestionar destinos` | `Gérer les destinations` | `Bestemmingen beheren` |
| `stream.dest.empty` | `No destinations yet. Add one in Directory.` | `Aún no hay destinos. Añade uno en Directorio.` | `Aucune destination pour l’instant. Ajoutez-en une dans le Répertoire.` | `Nog geen bestemmingen. Voeg er een toe in Directory.` |
| `stream.dest.loadError` | `Couldn't load your destinations.` | `No se pudieron cargar tus destinos.` | `Impossible de charger vos destinations.` | `Je bestemmingen konden niet worden geladen.` |
| `stream.dest.retry` | `Retry` | `Reintentar` | `Réessayer` | `Opnieuw proberen` |

The Directory's own name per locale (`directory.title`) is en "Directory", es "Directorio", fr "Répertoire" and nl
"Directory"; the empty sentences above use exactly those. Then remove every `stream.target.*` key that
`rtk proxy grep -rnaE "stream\.target\.(label|kind|rtmp|key|watch|save|cancel|error)\b" apps/web/src` shows unread,
keeping `stream.target.kind.other` (read by `platformName`) and `stream.target.refused.*` (read by createSession's
422). Run `pnpm i18n:gen-keys && pnpm i18n:check`.

- [ ] **Step 4: Walkthroughs.**
  - `stream-relay.spec.ts` A1 keeps its journey (add a destination → pick it → Go live → QR → LIVE → Stop → ENDED at
    320/768/1280). The add step becomes the Directory: open `/directory?tab=streaming`, add, then `openPhoneTab`.
    This proves the new path end to end. Its Go live and ENDED assertions are unchanged.
  - Case 10 is added to `directory-stream-destinations.spec.ts`: open the fixture page panel, and
    `stream-manage-destinations` has `target="_blank"`. `context.waitForEvent("page")` on click opens
    `/directory?tab=streaming`, whose tab strip marks Streaming `aria-current="page"`.
  - A load-error case goes in `stream-relay.spec.ts`: `page.route("**/api/v1/orgs/*/stream-targets", r => r.fulfill({ status: 500 }))`,
    then open the Phone tab. `stream-dest-load-error` is visible, and Go live is disabled. Unroute, click
    `stream-dest-retry`, and the select shows the seeded destination (the positive twin).
  - The in-use case (A5) additionally asserts that `stream-in-use-open` links to the first fixture's page, and that
    clicking it lands on `/f/{firstNo}` with the Stream control present.

- [ ] **Step 5: Run the scope.** Run the vitest JSON command over `fixture-stream-panel.test.tsx`,
  `stream-session-view.test.ts` and `stream-destinations-panel.test.tsx`. Then run the walkthroughs, whole:
  `stream-relay`, `stream-credits` and `directory-stream-destinations`.

- [ ] **Step 6: Mutate once each.**
  - The catch sets `{status: "ok", list: []}` (the old silent behaviour). Red: "a failed destination load is an ERROR"
    at unit level, and the e2e load-error case.
  - Go live's `list.length === 0` guard deleted. Red: "no destinations: … Go live DISABLED".
  - The `h.href &&` guard deleted. Red: "a deleted holder shows no link".

- [ ] **Step 7: Typecheck, lint, commit.** Commit with
  `feat(stream): panel picks from Directory — manage link, empty state, load error + Retry, Open Match link (T8)`.

**Wave D gate:** run T7 Step 9's and T8 Step 5's commands together (the vitest JSON check and the three walkthroughs,
whole), then `mobile.spec.ts` whole, because the panel markup changed.

## Wave R — the Signal-path redesign and the logo QR

### Task 9a: The chain — a pure §3.2 mapping, its component, and the D3 warning box

**Files:**
- Create: `apps/web/src/lib/stream-chain.ts`
- Create: `apps/web/src/components/v2/stream-signal-chain.tsx`
- Modify: `apps/web/src/app/globals.css` (four `.stream-link-*` classes and the reduced-motion rule, beside the existing reduced-motion block at :187)
- Modify: `apps/web/src/components/v2/fixture-stream-panel.tsx`, in `PhoneTabBody`: the stepper (`stream-steps`) and the health chips (`stream-health`) are replaced by `<SignalChain>` and `<DestinationWarning>`. The health chips move into a closed `<details data-testid="stream-details">` whose body keeps the `stream-health` testid.
- Modify: dictionaries (`stream.chain.*`, `stream.output.*`) + gen-keys
- Test (new): `apps/web/src/lib/__tests__/stream-chain.test.ts`
- Test (new): `apps/web/src/components/v2/__tests__/stream-signal-chain.test.tsx`
- Test (e2e): `apps/web/e2e/walkthrough/stream-relay.spec.ts`. Add the D3 case (the round-1 regression) and update the `stream-steps` / `stream-health` assertions.

**Interfaces:**
- Consumes: `OUTPUT_WARNING_AFTER_MS`, `destinationWarning`, `StreamSessionView` (T4); `FAKE_CONNECTING_KEY_PREFIX` (T4, as the literal `"connecting-"` in e2e); `ACTIVE_STATES`/`TERMINAL_STATES`.
- Produces:
  - `lib/stream-chain.ts`:
    - `type NodeTone = "slate" | "amber" | "lime" | "red"`;
    - `type LinkStyle = "idle" | "connecting" | "flowing" | "problem"`;
    - `type ChainWord = "notConnected" | "ready" | "notLive" | "waiting" | "connected" | "receiving" | "live" | "connecting" | "notReceiving" | "noSignal" | "ending"`;
    - `interface ChainNode {tone: NodeTone; word: ChainWord; mark: "dot" | "bang" | null}`;
    - `interface Chain {phone: ChainNode; link1: LinkStyle; seazn: ChainNode; link2: LinkStyle; dest: ChainNode}`;
    - `chainFor(view: Pick<StreamSessionView, "state" | "ingest" | "output"> | null, now: Date): Chain | null`, which
      is null for completed/failed (the chain is not shown).
  - `SignalChain({chain, destination: {kind, label}, phoneStatus?: string})`, with `data-testid="stream-chain"` and
    `data-phone`/`data-seazn`/`data-dest` set to the words and `data-link1`/`data-link2` set to the styles.
  - `DestinationWarning({kind})`, with `data-testid="stream-output-warning"` and an Open Directory link
    `data-testid="stream-output-open-directory"` to `/directory?tab=streaming`.
  - CSS classes: `.stream-link-idle`, `.stream-link-connecting`, `.stream-link-flowing`, `.stream-link-problem`.

- [ ] **Step 1: Write the failing pure test** — `apps/web/src/lib/__tests__/stream-chain.test.ts`. The expected rows
  are the spec's §3.2 table (the rulebook), one `it` per row. The state lists come from the domain.

```ts
import { describe, expect, it } from "vitest";
import { ACTIVE_STATES, TERMINAL_STATES } from "@/server/relay/domain/session";
import { OUTPUT_WARNING_AFTER_MS } from "@/lib/stream-session-view";
import { chainFor } from "../stream-chain";

const T0 = new Date("2026-09-30T12:00:00Z");
const at = (ms: number) => new Date(T0.getTime() + ms);
const v = (state: string, ingest: string | null, output: string | null, sinceMs = 0) => ({
  state, ingest: ingest ? { state: ingest, protocol: "srt" } : null,
  output: output ? { state: output, since: at(sinceMs).toISOString() } : null,
}) as never;

describe("chainFor — spec §3.2, row by row", () => {
  it("idle (no session): all slate, dashed; Not connected · Ready · Not live", () => {
    expect(chainFor(null, T0)).toEqual({
      phone: { tone: "slate", word: "notConnected", mark: null }, link1: "idle",
      seazn: { tone: "slate", word: "ready", mark: null }, link2: "idle",
      dest: { tone: "slate", word: "notLive", mark: null },
    });
  });
  it("requested / provisioning / warming: amber Waiting, link 1 animated lime, link 2 idle, destination Not live", () => {
    let checked = 0;
    for (const s of ["requested", "provisioning", "warming"]) {
      expect(chainFor(v(s, null, null), T0), s).toEqual({
        phone: { tone: "amber", word: "waiting", mark: null }, link1: "connecting",
        seazn: { tone: "amber", word: "waiting", mark: null }, link2: "idle",
        dest: { tone: "slate", word: "notLive", mark: null },
      });
      checked++;
    }
    expect(checked).toBe(3);
  });
  it("live, output ok: lime Connected · Receiving, both links flowing, destination red Live with a dot", () => {
    expect(chainFor(v("live", "connected", "ok"), at(OUTPUT_WARNING_AFTER_MS * 5))).toEqual({
      phone: { tone: "lime", word: "connected", mark: null }, link1: "flowing",
      seazn: { tone: "lime", word: "receiving", mark: null }, link2: "flowing",
      dest: { tone: "red", word: "live", mark: "dot" },
    });
  });
  it("live, output not ok for under 30 s: link 2 animated, destination amber Connecting", () => {
    const c = chainFor(v("live", "connected", "connecting"), at(OUTPUT_WARNING_AFTER_MS - 1))!;
    expect(c.link2).toBe("connecting");
    expect(c.dest).toEqual({ tone: "amber", word: "connecting", mark: null });
    expect(c.link1).toBe("flowing");
  });
  it("live, output not ok for 30 s or more (D3): link 2 amber dashes, destination amber '!' Not receiving", () => {
    let checked = 0;
    for (const o of ["connecting", "unknown", "rejected"]) {
      const c = chainFor(v("live", "connected", o), at(OUTPUT_WARNING_AFTER_MS))!;
      expect(c.link2, o).toBe("problem");
      expect(c.dest, o).toEqual({ tone: "amber", word: "notReceiving", mark: "bang" });
      checked++;
    }
    expect(checked).toBe(3);
  });
  it("live, phone ingest stale: phone amber No signal, link 1 amber dashes, Seazn amber Waiting; link 2 and destination follow the output", () => {
    const c = chainFor(v("live", "disconnected", "ok"), T0)!;
    expect(c.phone).toEqual({ tone: "amber", word: "noSignal", mark: null });
    expect(c.link1).toBe("problem");
    expect(c.seazn).toEqual({ tone: "amber", word: "waiting", mark: null });
    expect(c.link2).toBe("flowing");
    expect(c.dest.word).toBe("live");
  });
  it("ending: all slate, destination Ending…", () => {
    const c = chainFor(v("ending", "connected", "ok"), T0)!;
    for (const n of [c.phone, c.seazn, c.dest]) expect(n.tone).toBe("slate");
    expect([c.link1, c.link2]).toEqual(["idle", "idle"]);
    expect(c.dest.word).toBe("ending");
  });
  it("every ACTIVE state draws a chain and every TERMINAL state draws none — both lists the domain's own", () => {
    let checked = 0;
    for (const s of ACTIVE_STATES) { expect(chainFor(v(s, "connected", "ok"), T0), s).not.toBeNull(); checked++; }
    for (const s of TERMINAL_STATES) { expect(chainFor(v(s, null, null), T0), s).toBeNull(); checked++; }
    expect(checked).toBe(ACTIVE_STATES.length + TERMINAL_STATES.length);
  });
});
```

`apps/web/src/components/v2/__tests__/stream-signal-chain.test.tsx` (node, `renderToStaticMarkup`):

```tsx
  it("lime appears only as a ring or line class — never on text, across EVERY §3.2 row's nodes", () => {
    // Every row of the table, rendered: each node carries data-tone; no element anywhere carries a lime TEXT class.
    const rows = [null, warming, liveOk, liveConnecting, liveWarned, liveStale, ending].map((view) => chainFor(view, T0)!);
    let nodes = 0;
    let limeNodes = 0;
    for (const chain of rows) {
      const html = chainHtml(chain);
      expect(html).not.toMatch(/text-\[var\(--mk-lime\)\]|text-lime-/);
      for (const m of html.matchAll(/data-tone="(\w+)"[^>]*class="([^"]*)"/g)) {
        nodes++;
        if (m[1] === "lime") {
          limeNodes++;
          expect(m[2]).toMatch(/ring-\[var\(--mk-lime\)\]/);
        }
      }
    }
    expect(nodes).toBe(rows.length * 3);        // three nodes per row, or the scan matched nothing
    expect(limeNodes).toBeGreaterThan(0);        // the lime rows really were scanned
  });
  it("links render their style class; the connecting and problem animations are opted out under reduced motion (globals.css)", () => {
    const css = readFileSync(resolve(import.meta.dirname, "../../../app/globals.css"), "utf8");
    expect(css).toMatch(/@media \(prefers-reduced-motion: reduce\)\s*\{[^}]*\.stream-link-connecting[^}]*\.stream-link-problem[^}]*animation:\s*none/);
    expect(chainHtml(chainFor(warming, T0)!)).toMatch(/data-link1="connecting"[\s\S]*class="[^"]*stream-link-connecting/);
  });
  it("the destination label sits under its node at ≥768 and on its own line under the chain below 768", () => {
    const html = chainHtml(chainFor(null, T0)!, { kind: "youtube", label: "Club YouTube" });
    expect(html).toMatch(/<span class="max-md:hidden">YouTube · Club YouTube<\/span>/);
    expect(html).toMatch(/data-testid="stream-chain-dest-label"[^>]*class="[^"]*\smd:hidden"/);
  });
  it("D9: phoneStatus is accepted and renders NOTHING in this branch", () => {
    const a = chainHtml(chainFor(liveOk, T0)!, undefined, "🔋 64% · warm");
    const b = chainHtml(chainFor(liveOk, T0)!);
    expect(a).toBe(b);
  });
  it("the chain box has the 2px lime top border and a group label that reads the three states", () => {
    const html = chainHtml(chainFor(null, T0)!);
    expect(html).toMatch(/border-t-2 border-\[var\(--mk-lime\)\]/);
    expect(html).toMatch(/role="group"[^>]*aria-label="[^"]*Not connected[^"]*Ready[^"]*Not live/);
  });
```

`chainHtml(chain, destination = {kind: "youtube", label: "Club YouTube"}, phoneStatus?)` renders
`<SignalChain …/>` inside the `en` dictionary provider. `warming`, `liveOk`, `liveConnecting` (output `connecting`,
`since` = T0), `liveWarned` (the same, rendered at T0 + `OUTPUT_WARNING_AFTER_MS`: build it by passing that `now` to
`chainFor`), `liveStale` (ingest `disconnected`) and `ending` are view literals like those in the pure test. Each
node's ring `span` carries `data-tone={node.tone}` before its `class`, which is what the scan reads.

- [ ] **Step 2: Run and confirm red.**

```bash
cd /Users/ashokhein/github/seazn.club/.claude/worktrees/fixture-stream/apps/web && rm -f /tmp/fs-t9a.json && pnpm vitest run src/lib/__tests__/stream-chain.test.ts src/components/v2/__tests__/stream-signal-chain.test.tsx --reporter=json --outputFile=/tmp/fs-t9a.json; echo EXIT=$?; jq '{p:.numPassedTests,t:.numTotalTests,f:.numFailedTests,files:[.testResults[].name]}' /tmp/fs-t9a.json
```

- [ ] **Step 3: Implement** `apps/web/src/lib/stream-chain.ts`:

```ts
// lib/stream-chain.ts — spec 2026-09-30 §3.2, the Signal-path table as ONE pure mapping. The component draws it; the
// Stream button's dot reads the same session through `streamButtonState` (T9b).
import { destinationWarning, type StreamSessionView } from "@/lib/stream-session-view";

export type NodeTone = "slate" | "amber" | "lime" | "red";
export type LinkStyle = "idle" | "connecting" | "flowing" | "problem";
export type ChainWord =
  | "notConnected" | "ready" | "notLive" | "waiting" | "connected" | "receiving" | "live" | "connecting"
  | "notReceiving" | "noSignal" | "ending";
export interface ChainNode { tone: NodeTone; word: ChainWord; mark: "dot" | "bang" | null }
export interface Chain { phone: ChainNode; link1: LinkStyle; seazn: ChainNode; link2: LinkStyle; dest: ChainNode }

const node = (tone: NodeTone, word: ChainWord, mark: ChainNode["mark"] = null): ChainNode => ({ tone, word, mark });

type ChainView = Pick<StreamSessionView, "state" | "ingest" | "output">;

/** The destination half while live: ok → flowing + red Live; not ok under 30 s (or not yet read) → animated +
 *  amber Connecting; not ok for 30 s or more (D3) → amber dashes + amber "!" Not receiving. */
function destinationHalf(view: ChainView, now: Date): Pick<Chain, "link2" | "dest"> {
  if (view.output?.state === "ok") return { link2: "flowing", dest: node("red", "live", "dot") };
  if (destinationWarning(view, now)) return { link2: "problem", dest: node("amber", "notReceiving", "bang") };
  return { link2: "connecting", dest: node("amber", "connecting") };
}

export function chainFor(view: ChainView | null, now: Date): Chain | null {
  if (!view) {
    return { phone: node("slate", "notConnected"), link1: "idle", seazn: node("slate", "ready"), link2: "idle", dest: node("slate", "notLive") };
  }
  switch (view.state) {
    case "requested":
    case "provisioning":
    case "warming":
      return { phone: node("amber", "waiting"), link1: "connecting", seazn: node("amber", "waiting"), link2: "idle", dest: node("slate", "notLive") };
    case "live": {
      const half = destinationHalf(view, now);
      if (view.ingest && view.ingest.state !== "connected") {
        return { phone: node("amber", "noSignal"), link1: "problem", seazn: node("amber", "waiting"), ...half };
      }
      return { phone: node("lime", "connected"), link1: "flowing", seazn: node("lime", "receiving"), ...half };
    }
    case "ending":
      return { phone: node("slate", "connected"), link1: "idle", seazn: node("slate", "receiving"), link2: "idle", dest: node("slate", "ending") };
    case "completed":
    case "failed":
      return null;
  }
}
```

"Phone ingest stale" is read as `ingest.state !== "connected"` while live. A `null` ingest (a failed provider read,
N1) is **not** stale: nothing is decided on an unknown, which is the poll's own rule. This is a plan decision, so pin
it with one test case: `v("live", null, "ok")` gives `phone.word === "connected"`. For `ending`, the phone and Seazn
words stay as they were, in slate. The spec's row says only "slate", and a slate "Connected" reads as "was
connected", which is honest.

`apps/web/src/app/globals.css`, beside the reduced-motion block. These are the mockup's own rules, renamed:

```css
/* Spec 2026-09-30 §3.2 — the Signal-path links. Lime is a LINE colour here, never text (D5). */
.stream-link-idle { border-top: 2px dashed #cbd5e1; height: 0; }
.stream-link-connecting { height: 2px; background-image: repeating-linear-gradient(90deg, var(--mk-lime) 0 6px, transparent 6px 12px); background-size: 12px 2px; animation: stream-link-flow 0.7s linear infinite; }
.stream-link-problem { height: 2px; background-image: repeating-linear-gradient(90deg, #d97706 0 6px, transparent 6px 12px); background-size: 12px 2px; animation: stream-link-flow 0.7s linear infinite; }
.stream-link-flowing { height: 3px; border-radius: 2px; background: var(--mk-lime); box-shadow: 0 0 6px rgba(163, 230, 53, 0.45); }
@keyframes stream-link-flow { from { background-position: 0 0; } to { background-position: 12px 0; } }
@media (prefers-reduced-motion: reduce) {
  .stream-link-connecting,
  .stream-link-problem {
    animation: none;
  }
}
```

The spec says "the animation runs only while connecting". The mockup also animates `problem`; the spec table's D3 row
says "**amber dashes**", with no animation. So make `.stream-link-problem` **static**: delete its `animation` and keep
the reduced-motion selector listing only `.stream-link-connecting`. Then fix the reduced-motion regex in the
component test to `/\.stream-link-connecting[^}]*animation:\s*none/`, and add
`expect(css).not.toMatch(/\.stream-link-problem\s*\{[^}]*animation/)`. The spec binds; the mockup is a reference.

`apps/web/src/components/v2/stream-signal-chain.tsx`: markup per `option-a.html` (:99-121). There are three
`w-16 md:w-24` columns (the destination's is `md:w-52`), each holding:
- a `span.relative.grid.h-10.w-10.place-items-center.rounded-full` ring, whose classes come from `TONE_RING`;
- the node name, as `mt-2 max-w-full truncate text-xs font-semibold text-slate-800 md:text-sm`;
- the state word, as `mt-0.5 text-[11px] leading-tight md:text-xs`, in `text-slate-500`, or `text-amber-800` for an
  amber tone, or `text-red-700` for red.
The links sit between the columns as `div.flex.h-10.min-w-3.flex-1.items-center > div.w-full.stream-link-<style>`.

```tsx
const TONE_RING: Record<NodeTone, string> = {
  slate: "bg-white text-slate-500 ring-1 ring-slate-300",
  amber: "bg-amber-50 text-amber-700 ring-2 ring-amber-400",
  lime: "bg-white text-slate-800 ring-2 ring-[var(--mk-lime)]",
  red: "bg-red-50 text-red-700 ring-2 ring-red-500",
};
```

The destination node's name is `platformName(msg, kind)` (T7) plus a `<span class="max-md:hidden">{platform} · {label}</span>`
twin. Under the chain sits `<p data-testid="stream-chain-dest-label" class="mt-2 text-center text-xs text-slate-500 md:hidden">{msg("stream.chain.to", { label })}</p>`.
The wrapper is `div.mt-4.rounded-lg.border-t-2.border-[var(--mk-lime)].bg-white.px-1.py-4.ring-1.ring-purple-100.md:px-6`,
with `role="group"` and `aria-label={msg("stream.chain.aria", { phone, seazn, platform, dest })}`. `mark: "dot"`
renders a `span.absolute.-right-0.5.-top-0.5.h-2.5.w-2.5.rounded-full.bg-red-500`, and `"bang"` renders a small amber
circle holding `!`. `phoneStatus` is destructured and deliberately unused, with the comment
`// D9: reserved for capture v2's heartbeat summary — this branch renders nothing here.`

`DestinationWarning` (same file):

```tsx
export function DestinationWarning({ kind }: { kind: StreamTargetKind }) {
  const msg = useMsg();
  return (
    <div data-testid="stream-output-warning" role="status" className="mt-3 rounded-lg border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900">
      <p>{msg("stream.output.warning", { platform: platformName(msg, kind) })}</p>
      <a data-testid="stream-output-open-directory" href="/directory?tab=streaming" target="_blank" rel="noopener" className="tlink mt-1 inline-flex min-h-11 items-center md:min-h-0">
        {msg("stream.output.openDirectory")}
      </a>
    </div>
  );
}
```

In `PhoneTabBody`:
- Compute `const chain = chainFor(view, now);`.
- Render `{chain && <SignalChain chain={chain} destination={{ kind: selectedOrSessionTarget.kind, label: selectedOrSessionTarget.label }} />}`
  where the stepper was. The target is the session's `view.target` when a session exists, else the selected
  destination. Hide the chain when there is neither.
- Render `{view && destinationWarning(view, now) && <DestinationWarning kind={view.target.kind} />}` under it.
- The health chips move into
  `<details data-testid="stream-details" className="mt-3"><summary className="min-h-11 …">{msg("stream.details")}</summary><div data-testid="stream-health">…today's chips…</div></details>`,
  which is closed by default.

Dictionaries:

| key | en | es | fr | nl |
|---|---|---|---|---|
| `stream.chain.phone` | `Phone` | `Teléfono` | `Téléphone` | `Telefoon` |
| `stream.chain.seazn` | `Seazn` | `Seazn` | `Seazn` | `Seazn` |
| `stream.chain.word.notConnected` | `Not connected` | `Sin conectar` | `Non connecté` | `Niet verbonden` |
| `stream.chain.word.ready` | `Ready` | `Listo` | `Prêt` | `Klaar` |
| `stream.chain.word.notLive` | `Not live` | `Sin emitir` | `Pas en direct` | `Niet live` |
| `stream.chain.word.waiting` | `Waiting` | `Esperando` | `En attente` | `Wachten` |
| `stream.chain.word.connected` | `Connected` | `Conectado` | `Connecté` | `Verbonden` |
| `stream.chain.word.receiving` | `Receiving` | `Recibiendo` | `Réception` | `Ontvangt` |
| `stream.chain.word.live` | `Live` | `En directo` | `En direct` | `Live` |
| `stream.chain.word.connecting` | `Connecting` | `Conectando` | `Connexion` | `Verbinden` |
| `stream.chain.word.notReceiving` | `Not receiving` | `No recibe` | `Ne reçoit rien` | `Ontvangt niets` |
| `stream.chain.word.noSignal` | `No signal` | `Sin señal` | `Pas de signal` | `Geen signaal` |
| `stream.chain.word.ending` | `Ending…` | `Finalizando…` | `Arrêt…` | `Stoppen…` |
| `stream.chain.to` | `To {label}` | `A {label}` | `Vers {label}` | `Naar {label}` |
| `stream.chain.aria` | `Signal path: phone {phone}, Seazn {seazn}, {platform} {dest}` | `Ruta de la señal: teléfono {phone}, Seazn {seazn}, {platform} {dest}` | `Chemin du signal : téléphone {phone}, Seazn {seazn}, {platform} {dest}` | `Signaalpad: telefoon {phone}, Seazn {seazn}, {platform} {dest}` |
| `stream.output.warning` | `Live from the phone, but {platform} isn't receiving it. Check the stream key in Directory.` | `En directo desde el teléfono, pero {platform} no lo está recibiendo. Revisa la clave de transmisión en Directorio.` | `En direct depuis le téléphone, mais {platform} ne le reçoit pas. Vérifiez la clé de stream dans le Répertoire.` | `Live vanaf de telefoon, maar {platform} ontvangt het niet. Controleer de streamsleutel in Directory.` |
| `stream.output.openDirectory` | `Open Directory` | `Abrir Directorio` | `Ouvrir le Répertoire` | `Directory openen` |
| `stream.details` | `Details` | `Detalles` | `Détails` | `Details` |

Then run `pnpm i18n:gen-keys && pnpm i18n:check`.

- [ ] **Step 4: The D3 walkthrough case** (the round-1 regression, spec §9.4), in `stream-relay.spec.ts`:
  - Seed a destination with `streamKey: "connecting-" + randomBytes(6).toString("hex")`. The literal names
    `fakes.ts FAKE_CONNECTING_KEY_PREFIX`.
  - Go live through the UI (`openPhoneTab`, pick, Go live) and wait for LIVE. Record `const liveAt = Date.now()` the
    moment the pill reads LIVE. The fake now reads `unknown` through warming and `connecting` after the input
    connects (T4), and T4 clamps `since` to `live_at`, so the 30 s are measured from live, not from the first warming
    poll: however long warming took under CI load, the first live render is `connecting`.
  - Assert the chain: `stream-chain` has `data-dest="connecting"` and `data-link2="connecting"`, and
    `stream-output-warning` has count 0.
  - `expect.poll` until `stream-output-warning` is visible, with timeout `OUTPUT_WARNING_AFTER_MS + 2 * POLL_WAIT_MS`.
    Then assert `Date.now() - liveAt >= OUTPUT_WARNING_AFTER_MS - POLL_WAIT_MS`: the warning did not fire early (the
    lower bound allows one poll of rendering lag, and no more).
    Declare `const OUTPUT_WARNING_AFTER_MS = 30_000; // lib/stream-session-view.ts` in the spec, with a unit
    assertion in `stream-session-view.test.ts` that the lib's value equals 30 000 (the spec's number), so the two
    cannot drift silently.
  - Then: `data-dest="notReceiving"`, the session is **still live** (the API `current.state === "live"`, so no
    auto-end, D3), `stream-stop` is visible and enabled (Stop one tap away), and
    `stream-output-open-directory` has `href="/directory?tab=streaming"`.
  - Stop, and the warning is gone.
  - The **positive twin** already exists: every other live case runs on an `ok` output. Add one assertion to A1's
    live step that `stream-output-warning` has count 0 after `OUTPUT_WARNING_AFTER_MS` has passed in that case, only
    if A1 already waits that long. Otherwise assert `data-dest="live"` there.
  - Budget: `test.setTimeout(Math.max(180_000, SEED_MS + LIVE_WAIT_MS + OUTPUT_WARNING_AFTER_MS + 3 * POLL_WAIT_MS + NAV_MS))`.
  - Replace every `stream-steps` assertion in both stream walkthroughs with the equivalent `stream-chain` data
    attribute: step 2 becomes `data-phone="waiting"`, step 3 becomes `data-dest="live"`, and so on. Health-chip
    assertions first open `stream-details` (`toBeAttached` → click the summary → `toBeVisible`).

- [ ] **Step 5: Run the scope.** Run the vitest JSON command over `stream-chain.test.ts`,
  `stream-signal-chain.test.tsx`, `fixture-stream-panel.test.tsx` and `stream-session-view.test.ts`, then the two
  stream walkthroughs, whole.

- [ ] **Step 6: Mutate once each.**
  - `destinationHalf`: the `destinationWarning` branch deleted. Red: the D3 row, plus e2e.
  - `chainFor` live: the `ingest.state !== "connected"` check changed to `true`. Red: "live, output ok" (the phone
    becomes amber).
  - `TONE_RING.lime` changed to `text-lime-600`. Red: "lime appears only as a ring … EVERY §3.2 row".
  - `phoneStatus` rendered. Red: the D9 case.

- [ ] **Step 7: Typecheck, lint, commit.** Commit with
  `feat(stream): Signal-path chain from one pure §3.2 mapping; D3 not-receiving warning (T9a)`.

### Task 9b: The frame restyle, one shared session poller, and the Stream button's state

**Files:**
- Create: `apps/web/src/components/v2/stream-session-provider.tsx`
- Modify: `apps/web/src/lib/fixture-stream-mount.ts` (add `streamButtonState`)
- Modify: `apps/web/src/components/v2/fixture-stream-panel.tsx`:
  - `usePhoneSession` (:773) gains `{enabled}`;
  - `PhoneTab` and `PhoneStopProbe` read the shared session;
  - the tabs become Phone first, and Phone is the default when nothing opens OBS;
  - `MODE_OPTIONS` / `stepRadio` / `stream-mode-scorebug` are removed;
  - the credits collapse to one line;
  - the Ready / Waiting / Live action blocks follow spec §3.3;
  - the ended and failed boxes are restyled (the QR's size is T10's).
- Modify: `apps/web/src/components/v2/fixture-console.tsx` (wrap in `StreamSessionProvider` when `stream` is set; the button's dot and label)
- Modify: dictionaries (`stream.buttonLive`, `stream.credits.uses`, `stream.onAir`) + gen-keys; remove `stream.mode.*` / `stream.steps.*` keys that become unread
- Test: `fixture-stream-panel.test.tsx`, `fixture-console-authority-band.test.tsx`, `fixture-stream-mount.test.ts`
- Test (e2e): both stream walkthroughs (updated `stream-mode-scorebug`, `stream-credits-split`, tab-default and `stream-balance` assertions), `stream-overlay.spec.ts` (OBS is now the second tab)

**Interfaces:**
- Consumes: `chainFor`, `SignalChain`, `DestinationWarning` (T9a); `destinationWarning` (T4); `FixtureStreamMount`, `OpenPanel` (T5).
- Produces:
  - `streamButtonState(view: Pick<StreamSessionView, "state" | "output"> | null, now: Date): {dot: null | "amber" | "red"; labelKey: "stream.button" | "stream.buttonLive"}`.
  - `StreamSessionProvider({fixtureId, initialView?, children})`, `useSharedPhoneSession(fixtureId)`.
  - `usePhoneSession(fixtureId, opts?: {enabled?: boolean; initialView?: StreamSessionView | null})`. `initialView`
    seeds the hook's `useState`; it is a **test seam the server never passes**, and the comment says so.
  - Known limit, recorded not fixed: the poll runs only while a session is non-terminal (fixture-stream-panel.tsx
    :820-827), so a session started from ANOTHER device stays invisible here (no dot) until the page reloads.
  - DOM: `data-role="fixture-stream"` / `-phone` gain `data-dot="amber|red"` when a dot shows.

- [ ] **Step 1: Write the failing tests.** In `fixture-stream-mount.test.ts`:

```ts
describe("streamButtonState — the Stream button's dot and label (spec §2)", () => {
  const T0 = new Date("2026-09-30T12:00:00Z");
  const view = (state: string, output: { state: string; since: string } | null = null) => ({ state, output }) as never;
  it("no dot while idle or over; amber while requested/provisioning/warming; red while live; label 'Live' only while live", () => {
    expect(streamButtonState(null, T0)).toEqual({ dot: null, labelKey: "stream.button" });
    let checked = 0;
    for (const s of ["requested", "provisioning", "warming"]) { expect(streamButtonState(view(s), T0), s).toEqual({ dot: "amber", labelKey: "stream.button" }); checked++; }
    for (const s of TERMINAL_STATES) { expect(streamButtonState(view(s), T0), s).toEqual({ dot: null, labelKey: "stream.button" }); checked++; }
    expect(streamButtonState(view("live", { state: "ok", since: T0.toISOString() }), T0)).toEqual({ dot: "red", labelKey: "stream.buttonLive" });
    expect(checked).toBe(3 + TERMINAL_STATES.length);
  });
  it("D3 turns the live dot AMBER at the warning threshold, and not before", () => {
    const out = { state: "connecting", since: T0.toISOString() };
    expect(streamButtonState(view("live", out), new Date(T0.getTime() + OUTPUT_WARNING_AFTER_MS - 1)).dot).toBe("red");
    expect(streamButtonState(view("live", out), new Date(T0.getTime() + OUTPUT_WARNING_AFTER_MS)).dot).toBe("amber");
  });
  it("ending: amber, labelled Stream (the session is still up, but no longer live)", () => {
    expect(streamButtonState(view("ending"), T0)).toEqual({ dot: "amber", labelKey: "stream.button" });
  });
});
```

The `ending` row is a **plan decision**, because spec §2 names no dot for `ending`. Amber means "still up, not live";
record it in the task report for the owner.

In `fixture-stream-panel.test.tsx`:
- Phone is the first tab and the default: its tab button comes first in the markup, and it is selected with no
  `openedByReturn`.
- There is no `stream-mode-scorebug` and no "Coming soon".
- The credits one-liner is three parts joined by ` · `: `stream.credits.uses` ("Uses 1 credit"), then
  `stream-balance` holding the EXISTING plural text (`stream.phone.credits.one` at n = 1, `.other` otherwise), then
  Buy more. `stream-balance` carries `title` = the split sentence when the split adds up. The existing
  `stream-balance` assertions (unit :1024, :1034, :1071) keep their meaning unchanged. Add a case at n = 1 and n = 9 in
  `es` and `fr`: the balance reads the plural key's `one` / `other` form, never a `{n}` interpolated into a fixed
  word.
- The Live state renders "On air" and the elapsed time in `font-mono`, plus a full-width `stream-stop` with the red
  classes; `stream-details` is closed (no `open` attribute).
- (The Waiting QR's size moves to T10, which owns every QR change and the `_THEMES.md` rows that bind it.)
- Ready: the picker, then `stream-manage-destinations`, then a full-width `stream-go-live`, then the credits line,
  in that DOM order (§3.3). Assert the `indexOf` order.
- The no-credit state still renders the pack tiles unchanged. Pin the existing tile test ids.

In `fixture-console-authority-band.test.tsx`:
- A console whose shared session is live (seed the provider with a view: `StreamSessionProvider` takes an optional
  `initialView` test seam, documented as "server never passes it") renders `data-role="fixture-stream"` with
  `data-dot="red"` and the label "Live", and the phone twin with `data-dot="red"`.
- Idle renders no `data-dot=`. Anchor the regex on `data-dot="`.
- The phone twin's accessible name follows the state (WCAG 1.4.1: the dot is colour only): live renders
  `aria-label="Live"` (`stream.buttonLive`), idle renders `aria-label="Stream"`. Anchor on `aria-label="`.

- [ ] **Step 2: Run and confirm red** (the JSON command over the three test files).

- [ ] **Step 3: Implement.**

`fixture-stream-mount.ts`:

```ts
import { destinationWarning, type StreamSessionView } from "@/lib/stream-session-view";

/** Spec §2 — the Stream button's dot: none idle, amber while provisioning/warming or during the D3 warning, red while
 *  live; its label reads "Live" while live. `ending` (not named by the spec) is amber "Stream": still up, not live. */
export function streamButtonState(
  view: Pick<StreamSessionView, "state" | "output"> | null, now: Date,
): { dot: null | "amber" | "red"; labelKey: "stream.button" | "stream.buttonLive" } {
  if (!view) return { dot: null, labelKey: "stream.button" };
  switch (view.state) {
    case "requested":
    case "provisioning":
    case "warming":
    case "ending":
      return { dot: "amber", labelKey: "stream.button" };
    case "live":
      return { dot: destinationWarning(view, now) ? "amber" : "red", labelKey: "stream.buttonLive" };
    case "completed":
    case "failed":
      return { dot: null, labelKey: "stream.button" };
  }
}
```

`stream-session-provider.tsx`:

```tsx
"use client";
// One poller per fixture page (spec 2026-09-30 §2): the Stream button's dot and the panel read the SAME session, so
// they can never disagree, and the page never runs two `current` polls. Mounted by FixtureConsole when Stream is.
import { createContext, useContext, type ReactNode } from "react";
import { usePhoneSession, type PhoneSession } from "./fixture-stream-panel";

const SessionCtx = createContext<PhoneSession | null>(null);

export function StreamSessionProvider({ fixtureId, initialView, children }: { fixtureId: string; initialView?: StreamSessionView | null; children: ReactNode }) {
  // `initialView` is a unit-test seam only: the server never passes it (the console mounts the provider without it).
  const session = usePhoneSession(fixtureId, { initialView });
  return <SessionCtx.Provider value={session}>{children}</SessionCtx.Provider>;
}

/** The provider's session when one is mounted above; otherwise this caller's own poll (the run sheet is gone, but the
 *  panel's unit harness renders it bare). Hooks run unconditionally; the own poll is disabled under a provider. */
export function useSharedPhoneSession(fixtureId: string): PhoneSession {
  const shared = useContext(SessionCtx);
  const own = usePhoneSession(fixtureId, { enabled: shared === null });
  return shared ?? own;
}
```

`usePhoneSession`:
- Export its return type as `PhoneSession`.
- Accept `opts: { enabled?: boolean; initialView?: StreamSessionView | null } = {}`. When `enabled === false`, it
  neither fetches nor polls: its effects return early on `!enabled`, with `enabled` in their dependency arrays.
  `initialView` seeds the view `useState` (test seam; the server never passes it).
- `PhoneTab` and `PhoneStopProbe` call `useSharedPhoneSession(fixtureId)` in place of `usePhoneSession(fixtureId)`.
- There is a circular import (the provider imports the panel, and the panel imports the provider). Break it by moving
  `usePhoneSession` and `PhoneSession` into `stream-session-provider.tsx`, with the panel importing from there. That
  is a pure move, and the diff shows it as one.

`fixture-console.tsx`:
- When `stream` is set, wrap the console's root children in `<StreamSessionProvider fixtureId={fixture.id}>`.
- Read `const s = useSharedPhoneSession(fixture.id)` in a tiny child `StreamControl` component, because the provider
  must be above the reader.
- `StreamControl({variant: "desktop" | "phone", open, onToggle})` renders the T5 buttons, with the label
  `msg(state.labelKey)` (desktop text, and the phone twin's `aria-label`, so the icon-only twin reads "Live" while
  live) and a dot `span` when `state.dot` is set
  (`h-2 w-2 rounded-full ${dot === "red" ? "bg-red-600" : "bg-amber-500"}`). The button carries `data-dot={dot}`, set
  only when non-null.
- `now` is the session hook's own ticking `now`, which already exists for the elapsed timer.

Frame (`PhoneTabBody` and `FixtureStreamPanel`):
- The tab order becomes Phone, then OBS overlay. The initial tab is `"phone"`, unless the panel's own OBS deep-link
  exists (none today), so `useState<"obs" | "phone">("phone")`. The `returnedHere` argument no longer changes the
  default (Phone is the default either way); keep the strip and scroll behaviour.
- Delete `MODE_OPTIONS`, `stepRadio`, the mode radiogroup and `mode`/`onMode` from the props. The feed mode is always
  `"passthrough"`, the only enabled one. The composed mode stays in the API.
- Credits: replace the chip and split block with one line composed of three parts, never one interpolated message
  (word order and plural agreement differ by locale):
  `<p className="mt-2 text-center text-xs text-slate-500">{msg("stream.credits.uses")} · <span data-testid="stream-balance" title={splitSentence}>{balanceText}</span> · <button data-testid="stream-buy-more" …>{msg("stream.phone.buyMore")}</button></p>`,
  where `balanceText` is exactly today's `stream-balance` text (`stream.phone.credits.one` / `.other` with `{n}`,
  read from the current code at :1457) and `splitSentence` is the existing `stream-credits-split` sentence when it
  adds up. Keep `data-testid="stream-credits-split"` as a visually-hidden `span` holding the same sentence, so screen
  readers keep it and the walkthroughs keep their witness. The mockup's "9 left" reads "9 credits" here: a plan
  decision, because the plural key is what keeps every locale grammatical.
- Live: `<p data-testid="stream-on-air" className="text-sm font-semibold text-slate-800">{msg("stream.onAir")}</p>` plus
  the elapsed time in `font-mono text-3xl tabular-nums`, then `stream-stop` as `btn min-h-12 w-full bg-red-600 text-white hover:bg-red-700`,
  keeping today's confirm dialog.
- The QR's size (`QR_COLUMN_W`, the img's width) is NOT changed here; T10 owns it.
- Ended and failed: keep their content and test ids, and change only the container classes to the new frame's card
  (`rounded-lg ring-1 ring-purple-100 bg-white p-4`).

Dictionaries:

| key | en | es | fr | nl |
|---|---|---|---|---|
| `stream.buttonLive` | `Live` | `En directo` | `En direct` | `Live` |
| `stream.credits.uses` | `Uses 1 credit` | `Usa 1 crédito` | `Utilise 1 crédit` | `Kost 1 credit` |
| `stream.onAir` | `On air` | `En antena` | `À l’antenne` | `In de lucht` |

Then remove each `stream.mode.*`, `stream.steps.*` and `stream.tab.obs` value that is now unread. Keep
`stream.tab.obs` if the OBS tab still reads it (its label becomes "OBS overlay": change the **value** in all four:
en `OBS overlay`, es `Superposición OBS`, fr `Incrustation OBS`, nl `OBS-overlay`). Run `pnpm i18n:gen-keys && pnpm i18n:check`.

- [ ] **Step 4: Walkthrough updates** (keep testids where the element survives):
  - Assertions on `stream-mode-scorebug` (disabled, "Coming soon") become one assertion that it has count 0.
  - Assertions that the panel opens on OBS become Phone.
  - `openPhoneTab`'s tab click stays harmless.
  - `stream-overlay.spec.ts` clicks `stream-tab-obs` before its OBS assertions.
  - `stream-credits` split assertions read `stream-credits-split` (still in the DOM, visually hidden: use
    `toHaveText`, not `toBeVisible`) and `stream-balance`'s `title`.
  - Every `creditsChip` text assertion stays exactly as it is, because `stream-balance` keeps the plural key's
    text: `rtk proxy grep -naE "creditsChip" apps/web/e2e` lists them (today stream-relay.spec.ts :459, :510, :557,
    :565, :577, :620, :722, :818, :838, and stream-overlay.spec.ts :889, :900). Run them; none is edited.
  - **The one-poller witness (spec §2), in the browser** (review #21: the node harness cannot see it, because
    `renderIsland` never provides context and `renderToStaticMarkup` runs no effects). In `stream-relay.spec.ts`,
    with a Waiting session and the panel open, count requests with
    `page.on("request", (r) => { if (r.method() === "GET" && new URL(r.url()).pathname.endsWith("/stream-sessions/current")) n++; })`
    over `const K = 4` poll periods (`await page.waitForTimeout(K * STREAM_POLL_MS)`), then assert
    `n >= K - 1` (the poll really ran: zero is a failure) and `n <= K + 1` (a second poller doubles it). Budget:
    add `K * STREAM_POLL_MS` to that case's timeout.

- [ ] **Step 5: Screenshots and per-screen verdicts.**
  - Capture the fixture page at 1280, 768 and 320 in each panel state: Ready, no destinations, load error, Waiting
    (QR), Live ok, Live connecting, D3 warning, in-use refusal, Ended, Failed, and no credits.
  - Drive the states through the walkthrough rig: the fake driver's key prefixes (`connecting-`, `reject-`) and
    `page.route` for the load error.
  - Crop each to the Scoring or `console-stream` card.
  - Compare against `option-a-1280.png` / `option-a-320.png`, and write one verdict line per screen and width into the
    task report.
  - For each, `expectNoHorizontalScroll` passes, and the images differ from each other (AGENTS.md #10: confirm they
    exist and DIFFER).

- [ ] **Step 6: Run the scope.** The unit JSON command over `fixture-stream-mount.test.ts`,
  `fixture-stream-panel.test.tsx`, `fixture-console-authority-band.test.tsx`, `stream-signal-chain.test.tsx` and
  `stream-chain.test.ts`. Then, whole files: `stream-relay`, `stream-credits`, `directory-stream-destinations`,
  `stream-overlay.spec.ts` and `mobile.spec.ts` (serial: re-run until a full pass completes).

- [ ] **Step 7: Mutate once each.**
  - `streamButtonState` live: `destinationWarning` ignored. Red: "D3 turns the live dot AMBER".
  - `useSharedPhoneSession`: `enabled: true` always. Red: the one-poller walkthrough assertion (`n <= K + 1`). Run
    that case alone for the mutant, then whole-file for the gate.
  - The Phone-first default changed back to `"obs"`. Red: "Phone is the first tab and the default".

- [ ] **Step 8: Typecheck, lint, commit.** Commit with
  `feat(stream): Signal-path frame — Phone first, credits one line, Details, one shared poller, Stream button dot (T9b)`.

### Task 10: `renderSeaznQr` — the logo QR, its size and tap to enlarge, on the three fixture-page QRs

**Files:**
- Create: `apps/web/src/lib/seazn-qr.ts`
- Create: `apps/web/src/lib/qr-enlarge.ts` (D10: `enlargedQrSize`, `holdScreenWakeLock`)
- Create: `apps/web/src/components/v2/seazn-qr-image.tsx` (D10: the shared QR image with tap to enlarge)
- Modify: `apps/web/src/components/v2/fixture-stream-panel.tsx`:
  - :720: delete `QR_RENDER_OPTIONS`;
  - :724: `QR_COLUMN_W` becomes `"w-full max-w-[346px]"` (the QR box's own width: 320 + 2 × 12 `p-3` + 2 × 1 border);
  - ~:1044: `QRCode.toDataURL` becomes `renderSeaznQr`;
  - :1702-1711: the `stream-qr` img and its skeleton go from `w-[min(264px,100%)]` to `w-[min(320px,100%)]`, and the
    img renders through `SeaznQrImage`.
- Modify: `apps/web/src/components/v2/device-link-panel.tsx:95` and :243 (the img through `SeaznQrImage`)
- Modify: `apps/web/src/components/v2/checkin-qr.tsx:27` and :67 (the img through `SeaznQrImage`)
- Modify: `docs/superpowers/specs/2026-09-05-stream-overlay-prompts/_THEMES.md` §8a, the `QR size` (:961) and
  `QR encoding` (:962) rows (dated amendment citing spec 2026-09-30 D7)
- Modify: dictionaries (`qr.tapToEnlarge`, `qr.enlarge`, `qr.enlarged.name`, `qr.enlarged.brightness`, `qr.enlarged.close`) + gen-keys
- Create: `apps/web/e2e/helpers/qr-enlarge.ts` (`expectQrEnlarges`)
- Modify (e2e): `apps/web/e2e/walkthrough/scorer-sheets-handover-panel.spec.ts` (the Remote scoring QR enlarges)
- Test (new): `apps/web/src/lib/__tests__/seazn-qr.test.ts`, `apps/web/src/lib/__tests__/qr-enlarge.test.ts`,
  `apps/web/src/components/v2/__tests__/seazn-qr-image.test.tsx`
- Test: `fixture-stream-panel.test.tsx` (its `qrcode` mock now mocks `@/lib/seazn-qr`; :66 import, :1130 size pin and
  :1871-1878 encoding pin rewritten against the amended sheet), `device-link-panel.test.tsx` (same mock change)
- Test (e2e): `apps/web/e2e/walkthrough/stream-relay.spec.ts` (painted QR width; the stream and check-in QRs enlarge,
  at 320×568, 568×320 and 1280×800), `scorer-sheets-handover-panel.spec.ts` (the Remote scoring QR enlarges)

**Interfaces:**
- Produces:
  - `SEAZN_QR_ERROR_CORRECTION = "H"`, `SEAZN_QR_QUIET_MODULES = 4`, `SEAZN_QR_ICON_FRACTION = 0.22`,
    `SEAZN_QR_ICON_PAD_MODULES = 1`, `SEAZN_QR_LOGO_PATH = "/logo-square.png"`.
  - `seaznQrLayout(n): {n; total; icon; k; k0}`.
  - `seaznQrSvg(text, {size, logoHref}): string` (pure).
  - `renderSeaznQr(text, {size}): Promise<string>`, which returns an SVG data URL and fetches the logo once per page
    as a data URL.
  - D10 (`lib/qr-enlarge.ts`): `QR_ENLARGE_GUTTER_PX = 16`; `enlargedQrSize(vw, vh): number`
    (= `max(0, min(vw, vh) − 2 × QR_ENLARGE_GUTTER_PX)`); `holdScreenWakeLock(nav): () => void` (requests a screen
    wake lock if the API exists; the returned disposer releases it, including one that resolves after the dispose;
    never throws, never rejects).
  - D10 (`components/v2/seazn-qr-image.tsx`): `SeaznQrImage({src, alt, testId, sensitive, className?, width?, height?})`
    — `sensitive` is REQUIRED. It renders `<button data-testid="{testId}-enlarge" aria-haspopup="dialog"
    aria-label="Enlarge QR code">` around the `<img data-testid={testId}>`, the caption "Tap to enlarge", and, when
    open, a portal overlay. Exported pure parts: `QR_NO_CAPTURE`, `qrCaptureClass(sensitive)`, and the effect-free
    `QrEnlargedView({src, alt, sensitive, size, label, closeLabel, caption, onClose, closeRef?})` —
    `data-testid="qr-enlarged"` (`role="dialog"`, `aria-modal="true"`, an accessible name) holding `qr-enlarged-img`,
    the brightness caption and a 44 px ✕ `qr-enlarged-close`. When `sensitive`, the inline img, the overlay root and
    the enlarged img all carry `ph-no-capture`.

- [ ] **Step 1: Write the failing test** — `apps/web/src/lib/__tests__/seazn-qr.test.ts`. It uses `jsqr` and `sharp`,
  as `src/server/__tests__/_sheet-raster.ts` does:

```ts
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import jsQR from "jsqr";
import QRCode from "qrcode";
import sharp from "sharp";
import { describe, expect, it } from "vitest";
import { SEAZN_QR_ERROR_CORRECTION, SEAZN_QR_ICON_FRACTION, SEAZN_QR_ICON_PAD_MODULES, SEAZN_QR_QUIET_MODULES, seaznQrLayout, seaznQrSvg } from "../seazn-qr";
import { enlargedQrSize } from "../qr-enlarge";

const LOGO = `data:image/png;base64,${readFileSync(resolve(import.meta.dirname, "../../../public/logo-square.png")).toString("base64")}`;

async function decode(svg: string, px: number): Promise<string | null> {
  const { data, info } = await sharp(Buffer.from(svg)).resize(px, px).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  return jsQR(new Uint8ClampedArray(data.buffer, data.byteOffset, data.length), info.width, info.height)?.data ?? null;
}

/** A realistic capture payload: the panel test's CaptureQrV1 fixture through `qrText` — ~435 bytes (spec §7). */
const STREAM_PAYLOAD = streamPayloadFixture();
const DLINK = "https://seazn.club/score/" + "a".repeat(43);
const CHECKIN = "https://seazn.club/checkin/" + "b".repeat(43);

describe("renderSeaznQr's symbol (spec §7, D7)", () => {
  it("the stream payload is realistic in size — the test would be vacuous on a short string", () => {
    expect(STREAM_PAYLOAD.length).toBeGreaterThanOrEqual(400);
  });
  it("encodes at the declared EC level: the viewBox is the H symbol's size plus the quiet zone — and differs from the M size", () => {
    const h = QRCode.create(STREAM_PAYLOAD, { errorCorrectionLevel: SEAZN_QR_ERROR_CORRECTION }).modules.size;
    const m = QRCode.create(STREAM_PAYLOAD, { errorCorrectionLevel: "M" }).modules.size;
    expect(h).not.toBe(m);
    const svg = seaznQrSvg(STREAM_PAYLOAD, { size: 320, logoHref: LOGO });
    expect(svg).toContain(`viewBox="0 0 ${h + 2 * SEAZN_QR_QUIET_MODULES} ${h + 2 * SEAZN_QR_QUIET_MODULES}"`);
  });
  it("the knock-out is the smallest ODD square holding the icon plus its pad, centred (scorer-sheet-pdf geometry)", () => {
    let checked = 0;
    for (const n of [21, 37, 81, 105, 177]) {
      const L = seaznQrLayout(n);
      expect(L.k % 2, `n=${n}`).toBe(1);
      expect(L.k, `n=${n}`).toBeGreaterThanOrEqual(n * SEAZN_QR_ICON_FRACTION + 2 * SEAZN_QR_ICON_PAD_MODULES);
      expect(L.k - 2, `n=${n}`).toBeLessThan(n * SEAZN_QR_ICON_FRACTION + 2 * SEAZN_QR_ICON_PAD_MODULES);
      expect(L.k0 * 2 + L.k, `n=${n}`).toBe(n);
      checked++;
    }
    expect(checked).toBe(5);
  });
  it("carries the logo, centred, at the icon fraction: x/y/width/height are the layout's own numbers", () => {
    let checked = 0;
    for (const text of [DLINK, STREAM_PAYLOAD]) {
      const n = QRCode.create(text, { errorCorrectionLevel: SEAZN_QR_ERROR_CORRECTION }).modules.size;
      const L = seaznQrLayout(n);
      const at = SEAZN_QR_QUIET_MODULES + (n - L.icon) / 2;
      const svg = seaznQrSvg(text, { size: 280, logoHref: LOGO });
      expect(svg).toContain(`<image href="${LOGO}" x="${at}" y="${at}" width="${L.icon}" height="${L.icon}"/>`);
      expect(L.icon).toBeCloseTo(n * SEAZN_QR_ICON_FRACTION, 10);
      checked++;
    }
    expect(checked).toBe(2);
  });
  it("DECODES with the logo on, at every size the page DISPLAYS — read from the sheet and the components, never typed here", async () => {
    // The stream QR's three measured sizes are the amended _THEMES.md §8a `QR size` row's (1280, 320, 320 @ 125 %).
    const row = readFileSync(THEMES_PATH, "utf8").split("\n").find((l) => l.startsWith("| QR size |"))!;
    const streamPx = [...row.matchAll(/\*\*(\d+) CSS px at/g)].map((m) => Number(m[1]));
    expect(streamPx.length).toBeGreaterThanOrEqual(3);                   // 1280, 320, 320 @ 125 % — more if Step 3a adds
    // Remote scoring and check-in: the display size their own components declare.
    const dlinkPx = 4 * Number(/dlink\.alt[^>]*\bw-(\d+)\b/.exec(readFileSync(DLINK_PANEL_PATH, "utf8"))![1]);
    const checkinPx = Number(/checkinQr\.alt[\s\S]{0,200}?width=\{(\d+)\}/.exec(readFileSync(CHECKIN_PATH, "utf8"))![1]);
    // D10: the enlarged overlay's size at the two e2e viewports.
    const enlarged = [enlargedQrSize(320, 568), enlargedQrSize(1280, 800)];
    const cases: [string, string, number][] = [
      ...streamPx.map((px) => ["stream", STREAM_PAYLOAD, px] as [string, string, number]),
      ["remote scoring", DLINK, dlinkPx], ["check-in", CHECKIN, checkinPx],
      ...enlarged.map((px) => ["stream enlarged", STREAM_PAYLOAD, px] as [string, string, number]),
    ];
    let checked = 0;
    for (const [name, text, px] of cases) {
      expect(px, `${name} size`).toBeGreaterThan(0);
      expect(await decode(seaznQrSvg(text, { size: px, logoHref: LOGO }), px), `${name} @ ${px}px`).toBe(text);
      checked++;
    }
    expect(checked).toBe(streamPx.length + 2 + enlarged.length);
  });
});
```

`THEMES_PATH`, `DLINK_PANEL_PATH` and `CHECKIN_PATH` are `resolve(import.meta.dirname, …)` paths to
`docs/superpowers/specs/2026-09-05-stream-overlay-prompts/_THEMES.md`,
`src/components/v2/device-link-panel.tsx` and `src/components/v2/checkin-qr.tsx`. The regexes read the class and
`width` the components pass to `SeaznQrImage` after Step 3b; if a component's markup moves, fix the regex, never type
the number in. This test runs after Step 3a has amended the sheet, so Step 2's red run expects the sheet read to fail
too.

For `streamPayloadFixture()`, import the `CaptureQrV1` fixture the panel test already builds, if it is exported;
otherwise build one here in the `lib/capture-qr` shape (`v: 1`, `sid` a uuid, `slot: 0`, both creds with 65-character
secrets, `preferred`, `exp`), and serialise it with the same `qrText` the panel uses.

**If the 172 px stream case (320 @ 125 % zoom) fails to decode, that is the spec's named risk and the §7 fallback
trigger, recorded as such.** Do not loosen the test. Record the
failure, and take the spec's fallback: the stream QR alone renders logo-less through a
`seaznQrSvg(text, {size, logoHref: null})` path at EC H. The exception is written in the helper's header comment, and
the test's stream rows switch to `logoHref: null` with a comment pointing at that exception. The real-phone gate
(Step 6) then decides.

- [ ] **Step 2: Run and confirm red.**

```bash
cd /Users/ashokhein/github/seazn.club/.claude/worktrees/fixture-stream/apps/web && rm -f /tmp/fs-t10.json && pnpm vitest run src/lib/__tests__/seazn-qr.test.ts --reporter=json --outputFile=/tmp/fs-t10.json; echo EXIT=$?; jq '{p:.numPassedTests,t:.numTotalTests,f:.numFailedTests,files:[.testResults[].name]}' /tmp/fs-t10.json
```

- [ ] **Step 3: Implement** `apps/web/src/lib/seazn-qr.ts`:

```ts
// lib/seazn-qr.ts — every QR carries the Seazn logo (owner ruling D7, a standing rule; spec 2026-09-30 §7). Error
// correction H, the app icon centred over a knocked-out square — the geometry scorer-sheet-pdf.ts drawBrandQr prints
// (ICON 12 mm on a ~152 pt symbol ≈ 0.22 of the symbol; 1-module white pad; the smallest odd knock-out that holds both).
// This branch: the stream capture QR, the Remote scoring QR, the check-in QR. The other six follow in their own PR.
// Exceptions: none yet. (If the real-phone scan of the stream QR fails — T10 Step 6 — it is recorded HERE.)
import QRCode from "qrcode";

export const SEAZN_QR_ERROR_CORRECTION = "H" as const;
export const SEAZN_QR_QUIET_MODULES = 4;
export const SEAZN_QR_ICON_FRACTION = 0.22;
export const SEAZN_QR_ICON_PAD_MODULES = 1;
export const SEAZN_QR_LOGO_PATH = "/logo-square.png";
const INK = "#150b36";   // --mk-night: the sheets' navy, dark enough for every decoder

export function seaznQrLayout(n: number): { n: number; total: number; icon: number; k: number; k0: number } {
  const icon = n * SEAZN_QR_ICON_FRACTION;
  let k = Math.ceil(icon + 2 * SEAZN_QR_ICON_PAD_MODULES);
  if (k % 2 === 0) k += 1;
  return { n, total: n + 2 * SEAZN_QR_QUIET_MODULES, icon, k, k0: (n - k) / 2 };
}

export function seaznQrSvg(text: string, opts: { size: number; logoHref: string | null }): string {
  const qr = QRCode.create(text, { errorCorrectionLevel: SEAZN_QR_ERROR_CORRECTION });
  const n = qr.modules.size;
  const L = seaznQrLayout(n);
  const q = SEAZN_QR_QUIET_MODULES;
  const knocked = (r: number, c: number) =>
    opts.logoHref !== null && r >= L.k0 && r < L.k0 + L.k && c >= L.k0 && c < L.k0 + L.k;
  const dark = (r: number, c: number) => qr.modules.get(r, c) === 1 && !knocked(r, c);
  let d = "";
  for (let r = 0; r < n; r++) {
    for (let c = 0; c < n; c++) {
      if (!dark(r, c)) continue;
      const start = c;
      while (c < n && dark(r, c)) c++;
      d += `M${start + q} ${r + q}h${c - start}v1h-${c - start}z`;
    }
  }
  const at = q + (n - L.icon) / 2;
  const logo = opts.logoHref === null ? "" : `<image href="${opts.logoHref}" x="${at}" y="${at}" width="${L.icon}" height="${L.icon}"/>`;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${L.total} ${L.total}" width="${opts.size}" height="${opts.size}" shape-rendering="crispEdges"><rect width="${L.total}" height="${L.total}" fill="#fff"/><path d="${d}" fill="${INK}"/>${logo}</svg>`;
}

let logoOnce: Promise<string | null> | null = null;
/** The icon as a data URL — an SVG shown through <img> may not fetch external images, so it is embedded. Fetched once
 *  per page; a failed fetch renders the QR without the icon (it decodes the same) rather than no QR. */
function logoDataUrl(): Promise<string | null> {
  logoOnce ??= fetch(SEAZN_QR_LOGO_PATH)
    .then((r) => (r.ok ? r.blob() : Promise.reject(new Error(String(r.status)))))
    .then((b) => new Promise<string>((res, rej) => {
      const fr = new FileReader();
      fr.onload = () => res(String(fr.result));
      fr.onerror = () => rej(fr.error);
      fr.readAsDataURL(b);
    }))
    .catch(() => {
      logoOnce = null;
      return null;
    });
  return logoOnce;
}

export async function renderSeaznQr(text: string, opts: { size: number }): Promise<string> {
  const svg = seaznQrSvg(text, { size: opts.size, logoHref: await logoDataUrl() });
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
}
```

`public/logo-square.png` is 512×512 and 165 KB, so a data URL of about 220 KB is embedded per QR image. There are
three QRs at most on one page, and each is rendered once per payload. That is acceptable, and it is recorded in the
commit body. If it proves heavy in the screenshots pass, a follow-up can ship a 128-px copy of the icon; this branch
does not add an asset.

Call sites:
- `fixture-stream-panel.tsx`: `QRCode.toDataURL(qrPayload, QR_RENDER_OPTIONS)` becomes
  `renderSeaznQr(qrPayload, { size: 640 })`. That is 2× the 320 px display, and the SVG scales. Delete
  `QR_RENDER_OPTIONS` and its `qrcode` import if unused.
- `device-link-panel.tsx:95`: `QRCode.toDataURL(url, { width: 280, margin: 1 })` becomes
  `renderSeaznQr(url, { size: 280 })`.
- `checkin-qr.tsx:27`: `(await import("qrcode")).default` … becomes
  `const { renderSeaznQr } = await import("@/lib/seazn-qr"); setQr(await renderSeaznQr(out.url, { size: 240 }));`.
- The `<img>` tags keep their `width`/`height` attributes and gain nothing else.

The panel and device-link tests mock `qrcode`'s `toDataURL`. Change those mocks to `vi.mock("@/lib/seazn-qr", …)`
returning a fixed data URL. Each test's assertion keeps its meaning ("the QR renders from the projection's payload
string"): assert that `renderSeaznQr` was called with the payload and `{ size: 640 }` (panel) and
`{ size: 280 }` (device link).

- [ ] **Step 3a: The stream QR's size, and the binding sheet amended** (spec §3.3 / §7: "≥320 px on desktop and
  full width on a phone"; review #18/#19).
  - `fixture-stream-panel.tsx`: the `stream-qr` img and its skeleton become `w-[min(320px,100%)]`. `QR_COLUMN_W`
    becomes `"w-full max-w-[346px]"`, so the QR box, the paste field (which §8a binds to "the QR box's own width") and
    the Cancel button (which keeps its own `md:w-auto`, now with no conflicting `md:` width) all follow the new box.
  - `_THEMES.md` §8a, `QR size` row (:961): replace `min(264px, available)` with `min(320px, available)` and the first
    measurement with **320 CSS px at 1280**. Keep the 236 and 172 measurements (the below-768 subtraction is
    unchanged) and every other sentence. Append: "Amended 2026-09-30 (spec 2026-09-30 D7 and §7: ≥320 px on desktop,
    full width on a phone); was `min(264px, available)`." If the T9b/T10 screenshots measure `available` below 320 at
    768, write the measured 768 number into the row as a fourth `**N CSS px at 768**`.
  - `_THEMES.md` §8a, `QR encoding` row (:962): replace its first sentence with "**EC-H with a 4-module quiet zone and
    the Seazn logo centred** (`lib/seazn-qr.ts`: the icon covers 0.22 of the symbol over a knocked-out odd square
    with a 1-module pad, the geometry of `scorer-sheet-pdf.ts` `drawBrandQr`); the ≈ 435-byte capture payload puts
    the symbol at v22 / 105 modules." Keep the row's last sentence. Append "Amended 2026-09-30 (spec 2026-09-30 D7);
    was EC-M with no logo."
  - `fixture-stream-panel.test.tsx`: drop the `QR_RENDER_OPTIONS` import (:66). Rewrite :1130 and :1871-1878 to pin
    the component against the AMENDED sheet (neither is deleted):

```ts
    // :1126-1130 — the QR is now a <SeaznQrImage> element (renderIsland does not expand it): find it by type and
    // `testId` prop, never by data-testid, and pin its props. The width is the sheet's rule, read from the row.
    const qrEl = walk(tree).find((el) => el.type === SeaznQrImage && propsOf(el).testId === "stream-qr");
    expect(qrEl, "the Waiting state renders the stream QR through SeaznQrImage").toBeDefined();
    expect(byTestId(tree, "stream-qr"), "no bare img bypasses the component").toBeUndefined();
    expect(propsOf(qrEl!).src).toBe("data:image/png;base64,AAAA");
    expect(propsOf(qrEl!).alt).toBe(m("stream.phone.qr.alt"));
    expect(propsOf(qrEl!).sensitive).toBe(true);
    const sizeRow = readFileSync(SHEET_PATH, "utf8").split("\n").find((l) => l.startsWith("| QR size |"))!;
    const cap = /min\((\d+)px, available\)/.exec(sizeRow)![1];
    expect(Number(cap)).toBeGreaterThanOrEqual(320);                       // spec §7's floor on desktop
    expect(String(propsOf(qrEl!).className)).toContain(`w-[min(${cap}px,100%)]`);
```

The old `const img = byTestId(tree, "stream-qr")!` and its `attr(img, …)` lines are deleted: that lookup finds nothing
once the img is inside the component. Import `walk` from the harness and `SeaznQrImage` from `../seazn-qr-image`.

```ts
  it("§8a's encoding settings are the helper's: EC-H, a 4-module quiet zone, and the Seazn logo (amended 2026-09-30, D7)", () => {
    const sheet = readFileSync(SHEET_PATH, "utf8");
    const row = sheet.split("\n").find((l) => l.startsWith("| QR encoding |"));
    expect(row, "§8a lost its QR encoding row").toBeDefined();
    expect(row!).toContain(`EC-${SEAZN_QR_ERROR_CORRECTION} with a ${SEAZN_QR_QUIET_MODULES}-module quiet zone`);
    expect(row!).toMatch(/Seazn logo/);
    expect(SEAZN_QR_ERROR_CORRECTION).toBe("H");                           // spec §7, the rulebook
  });
```

  - The row's 236 / 172 are the division page's arithmetic (page gutter 12, `.card` border, `p-4`, :961). The panel
    now lives in the fixture console, so re-derive the 320-wide figure from THAT container: measure, at 320 × 568, the
    content width of the stream panel's QR box on the fixture page (`boundingBox()` of the `stream-qr-field`'s parent
    column, minus the box's 2 × 12 padding and 2 × 1 border), and write it into the row as
    `**N CSS px at 320 (fixture page)**`, with the subtraction spelled out like the existing ones, and the 125 % figure
    likewise. The division-page figures stay only if a QR is still rendered there (after T6 it is not: replace them).
  - e2e (`stream-relay.spec.ts`, the case that reaches Waiting): at 1280 the painted `stream-qr` box is
    `≥ 320 − 0.5` CSS px wide (`boundingBox()`), and at 320 it equals the row's fixture-page figure ± 1. Read both
    numbers from the `QR size` row (the walkthrough already reads repo files by path), never typed. The trigger
    button is `w-full` (Step 3b), so `min(320px,100%)` resolves against the column, not the SVG's intrinsic 640 px.

- [ ] **Step 3b: Tap to enlarge (owner ruling D10, 2026-10-04).** Every QR rendered through `SeaznQrImage` opens full
  screen on a single tap.

`apps/web/src/lib/qr-enlarge.ts`:

```ts
// lib/qr-enlarge.ts — owner ruling D10 (2026-10-04): a Seazn QR opens full screen on one tap, as large as the
// viewport allows, with the screen kept awake while it is open.

/** The gutter on each side of the enlarged QR (D10: "min(viewport width, viewport height) minus a 16 px gutter"). */
export const QR_ENLARGE_GUTTER_PX = 16;

/** The enlarged QR's edge in CSS px — derived from the viewport every time, never a constant. */
export function enlargedQrSize(vw: number, vh: number): number {
  return Math.max(0, Math.min(vw, vh) - 2 * QR_ENLARGE_GUTTER_PX);
}

type WakeSentinel = { release(): Promise<void> };
type WakeNavigator = { wakeLock?: { request(type: "screen"): Promise<WakeSentinel> } } | undefined;

/** Hold a screen wake lock while the overlay is open. Feature-detected: no API, a refused request or a failed release
 *  never throws and never rejects (D10). The disposer also releases a lock that is granted AFTER it ran. */
export function holdScreenWakeLock(nav: WakeNavigator): () => void {
  let disposed = false;
  let sentinel: WakeSentinel | null = null;
  const lock = nav?.wakeLock;
  if (lock && typeof lock.request === "function") {
    Promise.resolve()
      .then(() => lock.request("screen"))
      .then((s) => {
        if (disposed) void s.release().catch(() => {});
        else sentinel = s;
      })
      .catch(() => {});
  }
  return () => {
    disposed = true;
    if (sentinel) void sentinel.release().catch(() => {});
    sentinel = null;
  };
}
```

`apps/web/src/components/v2/seazn-qr-image.tsx`:

```tsx
"use client";
// Owner ruling D10 (2026-10-04): every Seazn QR opens full screen on a SINGLE tap (a double tap is the browser's zoom),
// on white, as large as the viewport allows, with the screen kept awake. Esc, the ✕ or any tap closes it, and focus
// returns to the QR.
//
// `sensitive` is REQUIRED, never defaulted: a QR that paints a live secret (the capture credentials, the Remote
// scoring `/score/<secret>` link) carries `ph-no-capture` on the inline image AND on the enlarged overlay, because
// PostHog replay compresses its DOM frames before the `before_send` scrub can see them and its recorder blocks only
// this class (device-link-panel.tsx:238-243). The overlay is a portal on `document.body`, outside any ancestor that
// carries the class, so it must carry it itself.
import { useEffect, useRef, useState, type RefObject } from "react";
import { createPortal } from "react-dom";
import { useMsg } from "@/components/i18n/dict-provider";
import { enlargedQrSize, holdScreenWakeLock } from "@/lib/qr-enlarge";

/** The replay-blocking class, applied to every element that paints a sensitive QR. */
export const QR_NO_CAPTURE = "ph-no-capture";
export const qrCaptureClass = (sensitive: boolean): string => (sensitive ? QR_NO_CAPTURE : "");

export function SeaznQrImage(p: {
  src: string; alt: string; testId: string; sensitive: boolean; className?: string; width?: number; height?: number;
}) {
  const msg = useMsg();
  const [open, setOpen] = useState(false);
  const trigger = useRef<HTMLButtonElement>(null);
  return (
    <>
      <button
        ref={trigger}
        type="button"
        data-testid={`${p.testId}-enlarge`}
        aria-haspopup="dialog"
        aria-label={msg("qr.enlarge")}
        onClick={() => setOpen(true)}
        className="mx-auto block w-full touch-manipulation rounded focus-visible:outline focus-visible:outline-2 focus-visible:outline-violet-400"
      >
        {/* A data: URL encoded in the browser — nothing for next/image to optimise. */}
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          data-testid={p.testId}
          src={p.src}
          alt={p.alt}
          className={[qrCaptureClass(p.sensitive), p.className].filter(Boolean).join(" ")}
          width={p.width}
          height={p.height}
        />
      </button>
      <p className="mt-1 text-center text-xs text-slate-500">{msg("qr.tapToEnlarge")}</p>
      {open && (
        <QrEnlarged
          src={p.src}
          alt={p.alt}
          sensitive={p.sensitive}
          onClose={() => {
            setOpen(false);
            trigger.current?.focus();
          }}
        />
      )}
    </>
  );
}

/** The overlay's markup, with no effects and no portal — exported so a node test can render it and pin its classes
 *  (the effects and the portal are the browser's, and the e2e witnesses them). Portrait stacks the caption under the
 *  QR; landscape (`landscape:flex-row`) puts it beside the QR, where the free space is, so the QR keeps the ruling's
 *  full `min(vw, vh) − 32` and never overlaps the caption or leaves the viewport (review R6). */
export function QrEnlargedView(p: {
  src: string; alt: string; sensitive: boolean; size: number; label: string; closeLabel: string; caption: string;
  onClose: () => void; closeRef?: RefObject<HTMLButtonElement | null>;
}) {
  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={p.label}
      data-testid="qr-enlarged"
      onClick={(e) => {
        e.stopPropagation();                         // a portal still bubbles through the React tree to its owner
        p.onClose();
      }}
      className={`${qrCaptureClass(p.sensitive)} fixed inset-0 z-[100] flex flex-col items-center justify-center gap-3 bg-white landscape:flex-row`}
    >
      <button
        ref={p.closeRef}
        type="button"
        data-testid="qr-enlarged-close"
        aria-label={p.closeLabel}
        onClick={(e) => {
          e.stopPropagation();
          p.onClose();
        }}
        className="absolute right-2 top-2 flex h-11 w-11 items-center justify-center rounded-lg text-2xl text-slate-700 focus-visible:outline focus-visible:outline-2 focus-visible:outline-violet-400"
      >
        ✕
      </button>
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img
        data-testid="qr-enlarged-img"
        src={p.src}
        alt={p.alt}
        className={`${qrCaptureClass(p.sensitive)} shrink-0`}
        style={{ width: p.size, height: p.size }}
      />
      <p className="max-w-xs px-4 text-center text-sm text-slate-600">{p.caption}</p>
    </div>
  );
}

function QrEnlarged({ src, alt, sensitive, onClose }: { src: string; alt: string; sensitive: boolean; onClose: () => void }) {
  const msg = useMsg();
  const closeBtn = useRef<HTMLButtonElement>(null);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  const [size, setSize] = useState(() => enlargedQrSize(window.innerWidth, window.innerHeight));
  useEffect(() => {
    closeBtn.current?.focus();
    const onResize = () => setSize(enlargedQrSize(window.innerWidth, window.innerHeight));
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onCloseRef.current();
      if (e.key === "Tab") {                       // the ✕ is the dialog's only control: keep focus inside
        e.preventDefault();
        closeBtn.current?.focus();
      }
    };
    window.addEventListener("resize", onResize);
    document.addEventListener("keydown", onKey);
    const release = holdScreenWakeLock(navigator as Parameters<typeof holdScreenWakeLock>[0]);
    return () => {
      window.removeEventListener("resize", onResize);
      document.removeEventListener("keydown", onKey);
      release();
    };
  }, []);
  return createPortal(
    <QrEnlargedView
      src={src}
      alt={alt}
      sensitive={sensitive}
      size={size}
      label={msg("qr.enlarged.name")}
      closeLabel={msg("qr.enlarged.close")}
      caption={msg("qr.enlarged.brightness")}
      onClose={() => onCloseRef.current()}
      closeRef={closeBtn}
    />,
    document.body,
  );
}
```

The three call sites render their QR through it, keeping their test ids and classes. `sensitive` follows what each QR
encodes and what its markup does today (review R2):
- stream capture QR — `sensitive` (capture credentials with 65-character secrets; today's img lacks the class, which
  this fixes):
  `<SeaznQrImage testId="stream-qr" sensitive src={p.qrDataUrl} alt={msg("stream.phone.qr.alt")} className="mx-auto block aspect-square h-auto w-[min(320px,100%)]" />`;
- Remote scoring QR — `sensitive` (the live `/score/<secret>`; today's img already carries `ph-no-capture`, :243, which
  moves into the component, so the call site drops it from `className`):
  `<SeaznQrImage testId="dlink-qr" sensitive src={minted.qr} alt={msg("dlink.alt")} className="mx-auto h-56 w-56" />`.
  Keep the :238-242 comment above it; the device-link img has no test id today, so `dlink-qr` is new;
- check-in QR — `sensitive={false}`: its markup today (checkin-qr.tsx:67-74) carries no `ph-no-capture`, and this branch
  follows that. The link it encodes is a signed day-of check-in link; whether it should be blocked too is recorded as
  an owner question in T11 Step 8, not decided here:
  `<SeaznQrImage testId="checkin-qr" sensitive={false} src={qr} alt={msg("checkinQr.alt")} className="mx-auto rounded-lg border border-slate-200 p-1" width={176} height={176} />`.
  Its mint button gains `data-testid="checkin-open"` for the e2e.
Keep the panel's own eslint comment where the old `<img>` was removed. The check-in modal's inner card already stops
propagation, and the overlay root now stops it too, so a tap on the overlay never also closes the modal behind it.

Dictionaries (the owner named three strings. Two more are needed for accessible names: the ✕'s, and the trigger's,
which must name the action rather than read the image's alt (review R7; controller: "Enlarge QR code"). Both are
reported to the owner rather than borrowing another namespace's "Close"):

| key | en | es | fr | nl |
|---|---|---|---|---|
| `qr.tapToEnlarge` | `Tap to enlarge` | `Toca para ampliar` | `Touchez pour agrandir` | `Tik om te vergroten` |
| `qr.enlarge` | `Enlarge QR code` | `Ampliar código QR` | `Agrandir le code QR` | `QR-code vergroten` |
| `qr.enlarged.name` | `Enlarged QR code` | `Código QR ampliado` | `Code QR agrandi` | `Vergrote QR-code` |
| `qr.enlarged.brightness` | `Turn up brightness if it won't scan` | `Sube el brillo si no se escanea` | `Augmentez la luminosité si le code ne se scanne pas` | `Zet de helderheid hoger als hij niet scant` |
| `qr.enlarged.close` | `Close` | `Cerrar` | `Fermer` | `Sluiten` |

Then `pnpm i18n:gen-keys && pnpm i18n:check`.

Tests. `apps/web/src/lib/__tests__/qr-enlarge.test.ts` (node):

```ts
import { describe, expect, it, vi } from "vitest";
import { QR_ENLARGE_GUTTER_PX, enlargedQrSize, holdScreenWakeLock } from "../qr-enlarge";

const flush = () => new Promise((r) => setTimeout(r, 0));
const fakeNav = () => {
  const release = vi.fn(() => Promise.resolve());
  const request = vi.fn(() => Promise.resolve({ release }));
  return { nav: { wakeLock: { request } }, request, release };
};

describe("D10 — tap to enlarge", () => {
  it("the ruling's gutter is 16 px (owner 2026-10-04)", () => {
    expect(QR_ENLARGE_GUTTER_PX).toBe(16);
  });
  it("the enlarged size is DERIVED from the viewport: min(vw, vh) − 2 × gutter, portrait and landscape, phone and desktop", () => {
    const viewports: [number, number][] = [[320, 568], [568, 320], [390, 844], [768, 1024], [1280, 800], [1920, 1080]];
    let checked = 0;
    const seen = new Set<number>();
    for (const [vw, vh] of viewports) {
      const got = enlargedQrSize(vw, vh);
      expect(got, `${vw}×${vh}`).toBe(Math.min(vw, vh) - 2 * QR_ENLARGE_GUTTER_PX);
      seen.add(got);
      checked++;
    }
    expect(checked).toBe(viewports.length);
    expect(seen.size).toBeGreaterThan(3);            // a constant would collapse this to one value
    expect(enlargedQrSize(20, 20)).toBe(0);          // never negative
  });
  it("the wake lock is requested on open and RELEASED on close", async () => {
    const { nav, request, release } = fakeNav();
    const dispose = holdScreenWakeLock(nav);
    await flush();
    expect(request).toHaveBeenCalledWith("screen");
    expect(release).not.toHaveBeenCalled();
    dispose();
    await flush();
    expect(release).toHaveBeenCalledTimes(1);
  });
  it("a lock granted AFTER close is released the moment it arrives", async () => {
    const { nav, release } = fakeNav();
    const dispose = holdScreenWakeLock(nav);
    dispose();                                       // closed before the request resolved
    await flush();
    expect(release).toHaveBeenCalledTimes(1);
  });
  it("no crash when navigator.wakeLock is undefined, when navigator is undefined, and when the request or the release rejects", async () => {
    let checked = 0;
    for (const nav of [undefined, {}, { wakeLock: { request: () => Promise.reject(new Error("NotAllowedError")) } },
      { wakeLock: { request: () => Promise.resolve({ release: () => Promise.reject(new Error("gone")) }) } }]) {
      const dispose = holdScreenWakeLock(nav as never);
      await flush();
      expect(() => dispose()).not.toThrow();
      await flush();                                 // an unhandled rejection here fails the run
      checked++;
    }
    expect(checked).toBe(4);
  });
});
```

`apps/web/src/components/v2/__tests__/seazn-qr-image.test.tsx` (node, `renderToStaticMarkup` inside the `en`
provider, as the panel tests do). It tests the component through its exported pure parts, because opening it (the
portal, the effects, the focus) is the browser's and the e2e below witnesses that:

```tsx
describe("SeaznQrImage / QrEnlargedView — D10, and the replay block (review R2)", () => {
  const view = (sensitive: boolean) => renderToStaticMarkup(
    <QrEnlargedView src="data:image/svg+xml,x" alt="QR" sensitive={sensitive} size={288} label="Enlarge"
      closeLabel="Close" caption="Turn up" onClose={() => {}} />,
  );
  const closed = (sensitive: boolean) => render(<SeaznQrImage testId="stream-qr" sensitive={sensitive} src="data:image/svg+xml,x" alt="QR" />);

  it("sensitive: the overlay ROOT and the enlarged IMG both carry ph-no-capture", () => {
    const html = view(true);
    expect(html).toMatch(new RegExp(`data-testid="qr-enlarged"[^>]*class="[^"]*\\b${QR_NO_CAPTURE}\\b`));
    expect(html).toMatch(new RegExp(`data-testid="qr-enlarged-img"[^>]*class="[^"]*\\b${QR_NO_CAPTURE}\\b`));
  });
  it("not sensitive: neither does (the positive twin, so the class is not simply always on)", () => {
    expect(view(false)).not.toMatch(new RegExp(QR_NO_CAPTURE));
  });
  it("the inline image follows `sensitive` too; the trigger names the action and wraps the image; the caption shows", () => {
    expect(closed(true)).toMatch(new RegExp(`data-testid="stream-qr"[^>]*class="[^"]*\\b${QR_NO_CAPTURE}\\b`));
    expect(closed(false)).not.toMatch(new RegExp(QR_NO_CAPTURE));
    const html = closed(true);
    expect(html).toMatch(/data-testid="stream-qr-enlarge"[^>]*aria-haspopup="dialog"[^>]*aria-label="Enlarge QR code"[^>]*>[\s\S]*data-testid="stream-qr"/);
    expect(html).toContain(">Tap to enlarge<");
    expect(html).not.toContain('data-testid="qr-enlarged"');                 // closed renders no overlay
  });
  it("the overlay is a named modal dialog with a 44 px ✕ and the brightness caption", () => {
    const html = view(true);
    expect(html).toMatch(/role="dialog"[^>]*aria-modal="true"[^>]*aria-label="Enlarge"/);
    expect(html).toMatch(/data-testid="qr-enlarged-close"[^>]*class="[^"]*\bh-11 w-11\b/);
    expect(html).toContain("Turn up");
    expect(html).toMatch(/data-testid="qr-enlarged-img"[^>]*style="width:288px;height:288px"/);
  });
});
```

`render` is the file's `renderToStaticMarkup` inside the `en` dictionary provider (`useMsg` needs it); read how
`stream-signal-chain.test.tsx` (T9a) wraps it and reuse that. Order the attribute regexes after reading React's
serialised order once (React keeps JSX prop order); adjust the order, never loosen to a bare substring.

The call-site unit tests use `renderIsland`, which renders ONE level deep, so `<SeaznQrImage>` stays an unexpanded
element there: its button and caption never appear, and its `testId` is a prop, not `data-testid` (review R3). They
therefore pin the WIRING, and the e2e pins the behaviour:
- `fixture-stream-panel.test.tsx` (Waiting): find the element with
  `walk(tree).find((el) => el.type === SeaznQrImage && propsOf(el).testId === "stream-qr")`; assert its `src` is the
  mocked data URL, `sensitive === true`, and its `className` carries the sheet's `w-[min(${cap}px,100%)]` (Step 3a).
  Assert `byTestId(tree, "stream-qr")` is `undefined`: no bare `img` bypasses the component.
- `device-link-panel.test.tsx` (minted): the same find for `testId === "dlink-qr"`, `sensitive === true`, `src` the
  minted QR, and no bare `img` with `alt === m("dlink.alt")` left in the tree.
- check-in has no unit test file today; its witness is the e2e below.

e2e — every call site, on the fixture page, where the person sees it (review R3). One shared helper in
`apps/web/e2e/helpers/qr-enlarge.ts`:

```ts
/** D10: open a Seazn QR by a single tap, check the overlay, close it by Esc, check focus came back. */
export async function expectQrEnlarges(page: Page, testId: string, opts: { sensitive: boolean }): Promise<void> {
  const trigger = page.getByTestId(`${testId}-enlarge`);
  await expect(page.getByTestId(testId)).toBeVisible();
  await trigger.click();                                                   // one tap, never dblclick
  const overlay = page.getByTestId("qr-enlarged");
  await expect(overlay).toBeVisible();
  await expect(overlay).toHaveAttribute("role", "dialog");
  await expect(overlay).toHaveAttribute("aria-modal", "true");
  const img = page.getByTestId("qr-enlarged-img");
  for (const el of [overlay, img, page.getByTestId(testId)]) {
    if (opts.sensitive) await expect(el).toHaveClass(/\bph-no-capture\b/);
    else await expect(el).not.toHaveClass(/\bph-no-capture\b/);
  }
  const { width: vw, height: vh } = page.viewportSize()!;
  const box = (await img.boundingBox())!;
  expect(box.width).toBeGreaterThanOrEqual(Math.min(vw, vh) - 32 - 0.5);
  expect(box.y).toBeGreaterThanOrEqual(0);                                 // inside the viewport (review R6)
  expect(box.y + box.height).toBeLessThanOrEqual(vh + 0.5);
  await expect(page.getByTestId("qr-enlarged-close")).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(overlay).toHaveCount(0);
  await expect(trigger).toBeFocused();
}
```

- `stream-relay.spec.ts`, the case that reaches Waiting: `expectQrEnlarges(page, "stream-qr", { sensitive: true })` at
  `setViewportSize` 320×568, 568×320 (landscape, where the caption sits beside the QR) and 1280×800. At 1280 also:
  the ✕ is ≥ 44 × 44 and closes it; a tap on the enlarged image closes it ("any tap").
- The same spec, a fixture-page case: `checkin-open` mints the check-in link, then
  `expectQrEnlarges(page, "checkin-qr", { sensitive: false })` at 320×568. The check-in modal is still open after the
  overlay closes (the stopPropagation witness).
- `scorer-sheets-handover-panel.spec.ts`, after it mints the device link:
  `expectQrEnlarges(page, "dlink-qr", { sensitive: true })` at its current viewport.
- The wake lock, in every browser (review R5): before the first navigation,
  `page.addInitScript(() => { const w = { requests: 0, releases: 0 }; (window as any).__wake = w; Object.defineProperty(navigator, "wakeLock", { configurable: true, value: { request: async () => { w.requests++; return { release: async () => { w.releases++; } }; } } }); })`.
  After the stream QR opens: `__wake.requests === 1`, `releases === 0`; after Escape: `releases === 1` (poll: the
  release is async). The real API is never exercised here; the owner's phone gate (Step 6) is where it is real. A
  second case with the stub script defining `wakeLock` as `undefined` opens and closes the overlay (the no-API path).
- Budget: add `3 * NAV_MS` to the stream case (three viewport passes) and `NAV_MS` to the others.

- [ ] **Step 4: Run the scope.** The JSON command over `seazn-qr.test.ts`, `qr-enlarge.test.ts`,
  `seazn-qr-image.test.tsx`, `fixture-stream-panel.test.tsx`, `device-link-panel.test.tsx` and
  `device-link-panel-i18n.test.tsx`, then the stream walkthroughs (A-case "the QR at 125% zoom" still decodes in the
  browser; the three `expectQrEnlarges` call sites) and `scorer-sheets-handover-panel` / `scorer-sheets-print-scan`,
  whole. There is no check-in spec today (`checkin-qr` appears in no e2e file); its witness is the new fixture-page
  case in `stream-relay.spec.ts`.

- [ ] **Step 5: Mutate once each.**
  - `SEAZN_QR_ERROR_CORRECTION` changed to `"M"`. Red: "encodes at the declared EC level" (and decoding may still
    pass, which is why the size check exists).
  - `if (k % 2 === 0) k += 1` deleted. Red: the knock-out geometry test.
  - The `knocked` guard changed to always `false` (no knock-out, logo drawn over live modules). This must **not** make
    the decode test pass for a wrong reason: record whether it stays green. It is a finding about the decode margin,
    not a test to weaken.
  - `holdScreenWakeLock`'s disposer: `if (sentinel) void sentinel.release()…` deleted (D10's named mutant). Red: "the
    wake lock is … RELEASED on close". Restore it, then delete the `if (disposed) void s.release()…` arm. Red: "a lock
    granted AFTER close".
  - `enlargedQrSize` returns a constant `288`. Red: "the enlarged size is DERIVED from the viewport".
  - `QrEnlargedView`: `${qrCaptureClass(p.sensitive)}` removed from the overlay root's `className` (review R2's named
    mutant). Red: "sensitive: the overlay ROOT and the enlarged IMG both carry ph-no-capture", and the e2e's
    `toHaveClass` on `qr-enlarged` for `stream-qr` / `dlink-qr`. Restore it, then remove it from the enlarged img
    only: the same unit case reds on its second line.

- [ ] **Step 6: REAL-PHONE SCAN — STOP for the owner. This cannot be automated.**
  1. Start the prod build (`seazn-local-env`), open a fixture page at 1280, and take a session to Waiting, so the
     stream QR shows.
  2. Ask the owner to scan it with the Seazn capture app on a real phone. Also ask them to scan the Remote scoring QR
     and the check-in QR on the same page with the phone's camera.
  3. Repeat on a **320-wide display**: the same page opened on the organiser's own phone (or a second phone), where the
     stream QR paints at the sheet's 236 CSS px, scanned by the capture phone. This is the smallest real display, and
     the one an organiser holding the fixture page on a phone uses.
  4. Repeat every scan above **enlarged** (D10): tap the QR, scan the full-screen overlay. So each QR is scanned at its
     normal and its enlarged size, at 1280 and at 320.
  5. Record in the task report, for each QR × width × size: device, OS version, app or camera, distance, lighting,
     result (scanned / slow / failed), and the time to lock.
  6. **Do not continue past this step until the owner reports the result.**
     - If the stream QR scans poorly, apply the §7 fallback: `logoHref: null` for that call site only, recorded in the
       helper's header comment ("Exceptions: the stream capture QR — <date>, <device>, <result>"). Then re-run Step 4
       and ask for a re-scan.

- [ ] **Step 7: Commit** (after the owner's result): `feat(qr): Seazn-logo QR at EC H, ≥320 px, tap to enlarge on the stream, Remote scoring and check-in QRs (T10)`,
  with the scan record in the body, and the `_THEMES.md` amendment in the same commit.

### Task 11: Lane close — the scoped gate, the visual verdicts, then STOP

**Files:** none new. The task reads, runs and reports.

- [ ] **Step 1: Re-check the migration number and rebase.**

```bash
cd /Users/ashokhein/github/seazn.club/.claude/worktrees/fixture-stream && git fetch origin --quiet && git ls-tree -r --name-only origin/main db/migration/deltas | sort -V | tail -3 && git log --oneline -1 origin/main
```

  - If main now has a V427+, renumber this branch's migration to the next free number, update every mention, and
    re-run `migration-shape.test.ts`.
  - Then `git rebase origin/main`: no stash, no interactive mode. On a conflict in a shared literal (dictionaries,
    `NEVER_KEY_ROUTES`, `ROUTES`, `WALKTHROUGH_SPECS`), keep **both** sides in main's order (AGENTS.md #18).
  - Re-run `pnpm i18n:gen-keys` and `pnpm openapi:gen` after the rebase, and commit any change.

- [ ] **Step 2: The scoped unit gate** (every test file this branch changed or added; never the full suite):

```bash
cd /Users/ashokhein/github/seazn.club/.claude/worktrees/fixture-stream && FILES=$(git diff --name-only origin/main...HEAD -- 'apps/web/src/**/*.test.ts' 'apps/web/src/**/*.test.tsx' | sed 's|^apps/web/||' | tr '\n' ' ') && echo "$FILES" | wc -w && cd apps/web && rm -f /tmp/fs-t11.json && pnpm vitest run $FILES src/server/relay/__tests__/enc-boundary.test.ts src/server/relay/__tests__/rls-static.test.ts src/server/relay/__tests__/port-boundary.test.ts src/lib/__tests__/e2e-ci-wiring.test.ts --reporter=json --outputFile=/tmp/fs-t11.json; echo EXIT=$?; jq '{p:.numPassedTests,t:.numTotalTests,f:.numFailedTests,n:(.testResults|length),files:[.testResults[].name]}' /tmp/fs-t11.json
```

Expected: `f: 0`, and `n` equals the word count printed plus 4, minus any boundary file already listed. Compare the
two lists by eye: a missing path is a silently skipped file (AGENTS.md: positionals are literal filters).

The list above holds only test files the branch EDITED. The rule is "the tests covering the files you changed", so
also run the tests that cover a changed SOURCE file without having been edited themselves:

```bash
cd /Users/ashokhein/github/seazn.club/.claude/worktrees/fixture-stream && SRC=$(git diff --name-only origin/main...HEAD -- 'apps/web/src/**/*.ts' 'apps/web/src/**/*.tsx' | grep -v '__tests__' | sed 's|^apps/web/||' | tr '\n' ' ') && echo "$SRC" | wc -w && cd apps/web && rm -f /tmp/fs-t11-related.json && pnpm vitest related --run $SRC --reporter=json --outputFile=/tmp/fs-t11-related.json; echo EXIT=$?; jq '{p:.numPassedTests,t:.numTotalTests,f:.numFailedTests,n:(.testResults|length),files:[.testResults[].name]}' /tmp/fs-t11-related.json
```

Expected: `f: 0`, and `files` includes at least `openapi-coverage.test.ts`, `api-key-scopes.test.ts`,
`relay-sweep.test.ts` and `telemetry.test.ts` (review #26); a missing one means `related` did not see the import
graph, so run it by path. If `related` would pull in a very large set (it follows imports transitively), that is still
the covering set for this branch, not the full suite; report its `n`. Then run `rtk proxy pnpm typecheck`,
`rtk proxy pnpm lint` and `pnpm i18n:check`.

Record the organiser-refresh cost T5 accepted (review #11): with the prod server up, render one organiser fixture page
with Stream offered and count the SQL round trips `loadStreamPanelContext` makes (the dev query log, or a temporary
counter in a scratch run, never committed), and write the number beside the prod budget (60 connections, 3 × 12) in
the task report.

- [ ] **Step 3: The scoped e2e gate**, whole files, against a fresh prod build of the rebased worktree:

```bash
cd /Users/ashokhein/github/seazn.club/.claude/worktrees/fixture-stream/apps/web && PLAYWRIGHT_BASE=http://localhost:3000 pnpm exec playwright test e2e/walkthrough/stream-relay.spec.ts e2e/walkthrough/stream-credits.spec.ts e2e/walkthrough/directory-stream-destinations.spec.ts e2e/walkthrough/directory-venues-courts.spec.ts e2e/walkthrough/scorepad-v3-r7-console-chrome.spec.ts e2e/walkthrough/scorer-sheets-handover-panel.spec.ts e2e/walkthrough/scorer-sheets-print-scan.spec.ts --project=walkthrough --reporter=line; echo EXIT=$?
cd /Users/ashokhein/github/seazn.club/.claude/worktrees/fixture-stream/apps/web && PLAYWRIGHT_BASE=http://localhost:3000 pnpm exec playwright test e2e/stream-overlay.spec.ts e2e/mobile.spec.ts --reporter=line; echo EXIT=$?
```

Paste the passed and total counts for each. `mobile.spec.ts` is serial, so treat a red count as a floor and re-run
until a full pass completes. A red that looks environmental goes through the `seazn-local-env` skill §5 list before it
is called a defect.

- [ ] **Step 4: Smoke, scoped to the changed routes only.** The full smoke is CI's job: it runs on this branch's PR
  before merge (smoke is PR-triggered). Locally, run only the suites that cover the routes this branch changed, through
  T2b's `SMOKE_ONLY` entry point, against the local prod server with `RELAY_KEK` set as CI sets it:
  `cd /Users/ashokhein/github/seazn.club/.claude/worktrees/fixture-stream && SMOKE_ONLY=streamTargets,v1 pnpm test:smoke`.
  `streamTargets` covers the new PATCH/DELETE and the changed POST; `v1` holds the fixture-console Stream twin check
  (T5 Step 16 sits in `v1Suite`, smoke.ts:16864). Both are in `SELECTABLE_SUITES` and need only `subsetSetup`'s
  state. Expected: `SMOKE_ONLY: ran 2 suite(s)`, the `streamTargetsSuite` "7 steps" line, the Stream check passing,
  and `0 failed`. Re-run `scripts/__tests__/smoke-select.test.ts` too. Report both; at PR time, also report CI smoke's
  own `streamTargetsSuite` count.

- [ ] **Step 5: The control-set diff, 320 against 1280, from the live DOM** (AGENTS.md phone composition). On TWO
  entitled organiser fixture pages whose header strips differ, with the scoring pad mounted: a **badminton** v3 pad
  (its strip carries the reserved server slot, mobile.spec.ts:153) and a **cricket** v3 pad (its strip carries none).
  The Stream icon adds a 44 px control to a strip whose crowding differs by sport, so one sample is not a sweep.
  For each sport:
  - List the visible interactive controls in DOM order at 1280 and at 320 (the `controlSet` helper from
    `stream-relay.spec.ts`).
  - Diff membership, order and repeats.
  - Expected: the only controls present at both widths **as twins** are Remote scoring and Stream, each appearing once
    per width. Nothing else is repeated, and the 320 set is not the 1280 set shrunk.
  - Paste both lists and the diff, per sport (four lists, two diffs). Zero controls listed at either width is a
    failure of the helper, not a clean diff.

- [ ] **Step 6: Per-screen visual verdicts.** Gather T7 Step 11's and T9b Step 5's screenshots, plus the fixture page
  at 768 and 1280 with **no** panel open (to prove "nothing changes at ≥768 except the two header buttons").
  - Write one verdict line per screen and width: what it shows, whether it matches the mockup, and the defect if any.
  - Confirm that the files exist and that the images differ.
  - "CI green" is not a verdict (AGENTS.md #11).

- [ ] **Step 7: The whole-branch review.** Dispatch the `reviewer` agent over `git diff origin/main...HEAD`, with the
  spec and this plan as its brief and the three standing lenses (customer, owner, test design). Fix each finding in
  the owning task's files, and re-run that task's scoped gate.

- [ ] **Step 8: STOP for the owner.** Do **not** push, open a PR or dispatch e2e. Report to the owner:
  - the gate counts from Steps 2–4, and the organiser-refresh query count from Step 2;
  - the control-set diff;
  - the visual verdict table;
  - the T10 real-phone record;
  - the plan decisions the owner has not ruled on:
    - `ending` gives an amber "Stream" button;
    - a `null` ingest is not stale;
    - `matchNo` replaces `matchLabel` on the wire;
    - the Twitch preset host;
    - the Directory mockup's "Change server" was not built;
    - the problem link is static, not animated;
    - the credits line reads "9 credits" (the plural key), not the mockup's "9 left";
    - D10 needed two strings beyond the three the ruling named (`qr.enlarged.close` for the ✕, `qr.enlarge` for the
      trigger's accessible name);
    - the check-in QR stays replay-visible (`sensitive={false}`, matching its markup today): should its signed day-of
      link be blocked like the other two?
  - the premises list at the top of this plan.

  Wait for the owner's go-ahead before `git push` and `gh pr create`.

---

## Self-review

**1. Spec coverage.** Each spec section maps to one or more tasks:

| Spec section | Task |
|---|---|
| §0 P1 | T5 |
| §0 D1 | T7, T8 |
| §0 D2 | T1, T2b, T7 |
| §0 D3 | T4, T9a |
| §0 D4 | T5 |
| §0 D5 | T9a, T9b |
| §0 D6 | T2a |
| §0 D7 | T10 |
| §0 D8 | T7, T2a, T2b, T5 |
| §0 D9 | T9a (the unrendered `phoneStatus`) |
| §0 D10 (tap to enlarge, 2026-10-04) | T10 Step 3b (component, wake lock, 4 locales), Step 5 (the release mutant), Step 6 (scan both sizes) |
| §1 success list | T5 (found from the match), T7 (wrong key visible), T4 + T9a (30 s), T3 + T8 (busy destination names the match), T5 (Stop in every gate state), T11 Step 6 (≥768 unchanged) |
| §2 route + `searchParams`, who sees Stream, desktop/phone twins, `openPanel`, `consoleScoringEmptyOnPhone`, doc + AGENTS amendments, checkout return | T5 |
| §2 shared loader | T5 |
| §2 run-sheet removal + chip, "check callers" | T6 Step 1 |
| §3.1 frame | T9b |
| §3.2 chain + table + lime-not-text + reduced motion + D3 box | T9a |
| §3.3 Ready | T8, T9b |
| §3.3 Waiting | T9b, T10 (the ≥320 px QR and the `_THEMES.md` §8a amendment, Step 3a) |
| §3.3 Live | T9b |
| §3.3 No destinations, load error | T8 |
| §3.3 in-use | T3, T8 |
| §3.4 | T9a |
| §4 | T7 |
| §5.1 | T1 |
| §5.2 | T2a (create), T2b (PATCH/DELETE, locks, archived refusal, auth, NEVER_KEY_ROUTES, OpenAPI, contract 5→7) |
| §5.3 | T1 + T2a |
| §5.4 | T2a |
| §5.5 | T3 |
| §5.6 | T4 + T9a |
| §5.7 | T4 |
| §6 keys | per task; unused labels removed in T6, T8, T9b |
| §7 | T10 (the six other QRs are out of scope, per §7 / §8); decode sizes read from the amended §8a row and the components |
| §8 | nothing built |
| §9.1 | per task; the sequences: replace key then go live (T2b, stream-sessions), concurrent Remove / Replace against Go live (T2b, both sides of the row lock), the chip after Stop (T6, through the real Stop) |
| §9.2 | T5, T7, T8, T9a |
| §9.3 | T5, T9b, T11 |
| §9.4 | T2b + T5 smoke, T9a (round-1 regression), T5 (D2 checkout regression), T10 (phone scan) |
| §9.5 | Global Constraints |
| §10 | the panel extraction is split from the redesign: T5 (move) against T9a/T9b (restyle); migration re-check in T1 + T11; QR risk in T10; walkthrough budget in T5 Step 14 and T9a Step 4 |

**Spec lines mapped only by deviation (reported, not silently dropped):**
- §5.3/§5.5 `matchLabel` "Match {n}" becomes `matchNo` plus the client's `breadcrumb.match` (premise 10).
- §9.4 "the CI smoke stream-overlay suite is updated for the new placement" becomes a new `streamTargetsSuite` plus the
  fixture-console Stream check (premise 7).
- §3.2's `ending` row gives no Stream-button dot rule, so T9b decides amber.
- The Directory mockup's "Change server" field is overruled by §4 "No server field" (T7 Step 11).
- §3.3's credits line "Uses 1 credit · 9 left" renders "Uses 1 credit · 9 credits": the balance keeps the plural key
  so every locale agrees in number (T9b, review #22).

**2. Placeholder scan.** No "TBD", "TODO", "implement later" or "similar to Task N" remains. Where a step names an
existing helper by role rather than by name (`goLive(r)`, `startComposed`, `stopAndDrain`, `streamRig`/`authFor`,
`renderDivision`, `consoleHtml`'s `baseState`), the step says which existing code to read for its real name. Those files were not opened for this plan,
and naming them from memory would be a guess.

**3. Type consistency.** These names are the same everywhere they appear:
- `StoredStreamTarget.outcome`, `InsertOutcome`;
- `lockStreamTarget`, `archiveStreamTarget`, `replaceTargetKey` → `ReplaceKeyResult`, `readKeyHints`, `keyHintOf`,
  `KEY_HINT_MIN_LENGTH`;
- `STREAM_PLATFORMS`, `STREAM_PLATFORM_PRESETS`, `StreamPlatform`;
- `holdStateOf`, `HoldState`;
- `TargetHolder`, `holderRows`, `wireHolder`, `listHolder`;
- `StreamTargetHolder` (with `matchNo`), `PatchStreamTarget`, `StreamTargetRemoved`;
- `targetHeld` (`TARGET_IN_USE`) against `targetInUse` (`target_in_use`);
- `expireTargetHolders`, `openStreamStates`;
- `OutputState` (with `connecting`), `ProviderCallMeta`, `StreamOutput`, `OUTPUT_WARNING_AFTER_MS`,
  `outputElapsedMs`, `destinationWarning`;
- `FAKE_REJECT_KEY_PREFIX` / `FAKE_CONNECTING_KEY_PREFIX`;
- `loadStreamPanelContext`, `fixtureStreamMode`, `nextOpenPanel`, `OpenPanel`, `FixtureStreamMount`,
  `streamReturn` / `openedByReturn`, `streamButtonState`;
- `keyShapeWarning`, `KEY_SHAPES`, `PlatformMark`, `platformName`, `destinationMutationOutcome`, `rowLock`;
- `TargetsState`;
- `chainFor`, `Chain`, `SignalChain`, `DestinationWarning`;
- `StreamSessionProvider`, `useSharedPhoneSession`, `PhoneSession`;
- `seaznQrLayout`, `seaznQrSvg`, `renderSeaznQr`;
- `CreateErrorHolder` (widened, T3; the panel stores it parsed), `inUseText`, `TARGET_IN_USE_ELSEWHERE_KEY`;
- `QR_ENLARGE_GUTTER_PX`, `enlargedQrSize`, `holdScreenWakeLock`, `SeaznQrImage` (required `sensitive`),
  `QrEnlargedView`, `QR_NO_CAPTURE`, `qrCaptureClass`, `expectQrEnlarges`;
- `selectSmokeSuites`, `SmokeSelectionError`, `SELECTABLE_SUITES`, `subsetSetup`, `runSubset`.

`holdRig` / `sessionOnTarget` are defined in T2a, and T2b and T3 use them.

**4. Review Focus.** Each of the five lines has its test in its owning task:
1. T1 Step 5 and T2a Step 2.
2. T2b Step 1.
3. T7 Step 1 (`destinationMutationOutcome`).
4. T5 Step 2 ("Review Focus 4").
5. T4 Step 2 ("Review Focus 5").

Beyond those five, the spec's own §9.1 list is covered in the task steps above: create order, held refusals per
state, row lock, duplicate, archived at createSession, `keyHint` floor, allowlist, key shapes, 29/30 s, `since`,
holder fields, `session_id` on four ops, `openPanel`, and the sequences.
