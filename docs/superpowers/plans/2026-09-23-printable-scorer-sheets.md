# Printable Scorer Sheets Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** An organiser prints one PDF per competition day — one section per court, five fixtures per page, one QR per fixture — and an umpire scans a row, confirms the match, taps **Start match** and scores it on their phone; the QR stays the same across reprints and goes view-only once the result has moved the competition on.

**Architecture:** `device_links` gains a sealed copy of the secret (`secret_enc`, AES-256-GCM under a new `DEVICE_LINK_KEK`) and a nullable expiry, so `ensureDeviceLink` can hand back the SAME secret on every reprint and every console hand-over. A pure carried-forward predicate, evaluated live at request time, refuses device-link writes with `403 RESULT_CARRIED_FORWARD`; that refusal travels transport → pipeline → a new registry callback → `DeviceScorePad`, which switches to a View-only screen. The scan page gains Confirm / Waiting / View-only screens chosen by one pure `scanScreen()` table. The PDF is rendered on the shared document system (`doc-theme.ts` fonts/palette/`qrBuffer`, `doc-render.ts` masthead + title block) by a renderer beside `doc-render.ts`, served like the timetable/tickets exports from `POST /api/v1/competitions/{id}/exports/scorer-sheets`, and fed by a pure day-selection + pagination model.

**Tech Stack:** Next.js 16.2 App Router (read `node_modules/next/dist/docs/` before touching routes — this is NOT the Next.js in training data), React 19.2, TypeScript 7, Node 26, postgres.js, Flyway, pdfkit 0.19, qrcode 1.5, sharp, vitest 4 (`environment: "node"`, no jsdom), Playwright, pnpm.

**Spec:** `docs/superpowers/specs/2026-09-23-printable-scorer-sheets-design.md` (owner-approved section by section 2026-09-23). Executors read the spec AND this plan; where they disagree, the "False premises" table below says which one the tree supports.

---

## Step 0 — Anchors re-pinned against `1c42a297a` (HEAD `a821288f8` = 1c42a297a + the two spec commits)

Every anchor in spec §3 and §4.5, re-read in the tree (`grep -a`, then opened):

| Spec anchor | Spec line | Tree now | Note |
|---|---|---|---|
| `createDeviceLink` | device-links.ts:121 | :121 | unchanged |
| `requireSessionEditor` | :87 | :87 | unchanged |
| `requireFeature(... competition)` | :128 | :128-132 | unchanged |
| 422 finalized/cancelled | :138 | :138-140 | unchanged |
| `endOfLocalDay` expiry | — | :148 | still imported by `checkin-token.ts:10` — keep exported |
| revoke every prior live link | — | :151-153 | unchanged |
| `resolveDeviceLinkToken` | :249 | :249-263 | **expiry check :259 breaks on a null `expires_at`** (P1) |
| `getActiveDeviceLink` live filter | — | :191 `expires_at > now()` | **hides null-expiry links** (P1) |
| `deviceHandover` gate | `f/[no]/page.tsx:224` | :224-229 | unchanged (frozen/finalized/cancelled, UI-only — D8) |
| `canHandOver` | fixture-console.tsx:679 | **:694** | moved +15 |
| hand-over panel mint/revoke | — | `components/v2/device-link-panel.tsx:58-91` | POST `/api/v1/fixtures/{id}/device-links` |
| v1 mint route | — | `app/api/v1/fixtures/[id]/device-links/route.ts:17-29` | calls `createDeviceLink` |
| append lock | append-event.ts:169 | :169 (`LOCKED_FIXTURE_STATUSES` :94) | unchanged |
| division phase check | scoring.ts:449 | **:463** | moved |
| device-link capability block | scoring.ts:457-475 | **:471-492** | moved |
| `onDecided → fillSlot` | scoring.ts:621-653 | **:635-668** | moved |
| `maybeAutoAdvance` | scoring.ts:737 | **:743** (called :736) | moved |
| advanced-fixture `schedule` push | scoring.ts:339 | **:353** | moved |
| `schedule.ts` push | :150 | :150 | unchanged |
| void semantics | engine events.ts:188-214 | `resolveVoids` :182-215 | unchanged in substance |
| `fillSlot` | stages.ts:3544 | :3544 | fills only a null side |
| Swiss next-round refusal | stages.ts:1068 | :1068 (`DECIDED` set :951) | unchanged |
| stage completion predicate | competition.ts:596 | :596 | unchanged |
| `resolveSlotLabel` | slot-label.ts:55 | :54 (`matchRef` :38) | unchanged |
| scan page select | page.tsx:87-89 | :87-88 | no slot labels, no status, no seq |
| TBD text | device-score-pad.tsx:292/296 | **:419/:423** | moved |
| start/undo gate | :322 | **:449** | moved |
| inner pad mount | :359 | **:487** | moved |
| chrome `send()` | :175 | **:204** (catch :236) | moved |
| `DEAD_CODES` | — | :81 | #848 |
| G1 freshness floor effect | — | :295-311 | #848 |
| `padAuth` memo | — | :356 | stable identity is load-bearing |
| `onSignal` | use-fixture-stream.ts:168 | **:184** | moved |
| `POLL_MS` | :21 | :21 (unexported) | unchanged |
| permanent-refusal class | transport.ts:295-297 | **:307** `isPermanentRefusal` | moved |
| 403 → rejected | :362-363 | **:375-376** | moved; **already carries the code** (P4) |
| `onEvents` prop | registry.tsx:204 | :204 | unchanged |
| forwarded to host | :299 | :299 | unchanged |
| host fires `onEvents` | — | `v3/pad-host.tsx:1574-1577` | where the new callback goes |
| pipeline `lastRejection` | — | `use-pad-pipeline.ts:462`, set :1711 | already surfaced |
| refusal copy map | — | `scorepad/refusal-copy.ts:55-66` | add the new code here |
| poster.pdf pattern | ✓ | `app/(public)/shared/[orgSlug]/[competitionSlug]/poster.pdf/route.ts` | `bufferPages: true` is REQUIRED for a footer loop |
| shared document system | ✓ | `server/doc-theme.ts` (`PALETTE`, `FONT`, `registerFonts` → Barlow Condensed + Inter from `assets/fonts`, `qrBuffer(url)` 180 px, null on failure), `server/doc-render.ts` (`docModelToPdf`, private `drawMasthead`/`drawTitleBlock`/`resolveLogo`, English footer, `EYEBROW.scoresheet = "MATCH SHEET"`) | T8 reuses these; `DocModel` is engine-owned (Do NOT touch) |
| export route analogue | ✓ | `api/v1/competitions/[id]/exports/timetable/route.ts` + `exports/tickets/route.ts` (`requireResourceAuth` → use-case → renderer → attachment, errors via `v1()`); `me/rota.pdf` is session-personal/cross-org — not the shape | T8 follows timetable/tickets |
| doc-render / doc-theme | ✓ | `server/doc-render.ts`, `server/doc-theme.ts` (`qrBuffer` :76) | |
| crypto | ✓ | `server/relay/crypto.ts` | reads `RELAY_KEK` only |
| enc-boundary | ✓ | `server/relay/__tests__/enc-boundary.test.ts` | **derives ENC columns from the stream_sessions migration ONLY** (P2) |
| schedule page | ✓ | `app/o/[orgSlug]/c/[compSlug]/schedule/page.tsx` | gated on `scheduling.multi_division`, which V393 made free for Community — so a Community org DOES reach the page and the `scoring.device_links` UpgradeGate is reachable |
| migrations | — | `db/migration/deltas/`, tail **V413** | **V414 is claimed** on branch `backup/qualstatus-pre-rebase3` → use **V415** (P9) |

### False or incomplete spec premises (record, do not block)

| # | Premise | What the tree says | How this plan handles it |
|---|---|---|---|
| P1 | "`expires_at` becomes nullable. New links write `null`." | `resolveDeviceLinkToken` does `new Date(link.expires_at).getTime() <= Date.now()` — `new Date(null)` is the epoch, so EVERY new link would 401 `LINK_EXPIRED`. `getActiveDeviceLink` filters `expires_at > now()`, which is NULL-false. | Task 2 fixes both and pins them with a test that fails on the unfixed resolver. |
| P2 | "`enc-boundary.test.ts` admits `device-links.ts`" | The test takes its column list from `V<n>__stream_sessions.sql` alone; a `secret_enc` declared in any other migration is invisible to it, and it asserts exactly three columns. | Task 1 derives columns from every delta and replaces the single-directory rule with a per-column allow-list. |
| P3 | "`DEVICE_LINK_KEK` is added to … CI env" | `RELAY_KEK` is in NO workflow (relay tests set it in `beforeAll`). Because `createDeviceLink` will now seal, every mint in CI — hand-over e2e, smoke's pass-grant check — needs the key in the SERVER's env. | Task 1 adds it beside `AUTH_SECRET` in all 8 jobs and pins that with a wiring test. |
| P4 | "transport classifies this code as terminal" | Already true: a 403 carrying our envelope returns `{kind:"rejected", code}` (transport.ts:375-376) and the pipeline stores it in `lastRejection`. What is missing is only pipeline → registry → chrome. | Task 5 adds the callback; no transport behaviour change, just an exported code set. |
| P5 | "decided … not carried forward → void its own events (fix a mistake right after the match)" | `onDecided` fills the knockout target synchronously in the same request (scoring.ts:660-668), so a knockout fixture is carried forward the instant it is decided. A stage's last fixture is carried as soon as the stage completes. The umpire's undo window after a decision exists only for league/group fixtures and Swiss boards before the next pairing. | Built as specified (safe direction); Task 4 pins the knockout case with a test so nobody "discovers" it later. **Owner question Q2.** |
| P6 | Waiting "re-checks fixture metadata (sides + labels) every POLL_MS (`cache: "no-store"`)" | A device link may read ONLY `/state` and `/events` (doc 13 §7 `rejectDeviceLink`, fixtures.ts:27); `GET /fixtures/{id}` refuses it. And the inner pad needs each side's members + lineup, which only the server page loads. | Waiting calls `router.refresh()` on the `force-dynamic` scan page every `POLL_MS` (and on tab return). Same cadence, same "only while waiting" rule, no new device-link read surface, and one authority (the page) for side data. |
| P7 | Row ref examples `R1 M3`, `SF1`, `Round 3 · Board 2` | The one authority for a match reference is `matchRef()` (slot-label.ts:38, key `slot.match_ref`, "R1·2"); the board card and every feeder label use it. | The sheet uses `matchRef(round_no, seq_in_round)` so the printed ref, the board chip and "Winner of R1·2" cannot disagree. **Owner question Q6.** |
| P8 | Confirm: "Start match sends `core.start` and opens the pad" | Today the inner pad mounts BEFORE start, and `useFixtureStream` has no fetch on mount (first read is a signal or the 15 s poll). Mounting it only after Start with the server bootstrap's events would show a pre-start pad and send a stale `expected_seq`. | Task 6 seeds the inner pad from the chrome's own post-start `resync()` at the moment it mounts. `e2e/device-links.spec.ts` "reaches its own inner pad faster than the poll" loses its premise (inner pad mounted pre-start) and is re-pointed, never weakened. |
| P9 | migration | V414 is claimed on `backup/qualstatus-pre-rebase3`. | V415. Re-check at commit time. |
| P10 | (silent) | "Rebuild fixtures" hard-deletes fixtures and cascades `device_links` (stages.ts:2997-3013); the confirm dialog counts device links. A rebuild after printing kills every printed QR on that stage (`LINK_INVALID`). | Out of scope to change; **owner question Q4**. |
| P11 | "Legacy hash-only links keep working until their `expires_at`" + "(only a legacy hash-only link) → revoke, mint" | Both hold only if nothing calls `ensure` on that fixture. A print or hand-over on a fixture with a live legacy link revokes it — including mid-match. | Built as specified; **owner question Q3**. |
| P12 | "Dead link — existing screen" | `DeadLink` in `app/score/[token]/page.tsx` is hard-coded English, and so are the resolver's messages it prints. | Task 6 touches the file, so it localises them (fix-inline rule). |
| P13 | (silent) | `proxy.ts`'s Origin check covers `/api/**` only; a POST under `/o/**` is protected by `SameSite=Lax` alone. | Task 8 serves the PDF from `/api/v1/competitions/{id}/exports/scorer-sheets`, inside `proxy.ts`'s check (no bespoke guard). |

### What #848 already gives the scan screens — reuse, do not duplicate

- **Freshness floor (G1)**: the `visibilitychange`/`focus` effect at device-score-pad.tsx:295-311. Task 6 extracts it UNCHANGED into `useTabReturn(onReturn, enabled)` so Waiting refreshes on tab return through the same code; `device-score-pad-freshness-floor.test.tsx` must stay green without edits — it is the extraction's regression test.
- **Dead-link handling**: `DEAD_CODES` (:81) and the dead screen (:359). Waiting needs nothing new: its `router.refresh()` re-runs `resolveDeviceLinkToken` server-side, so a link revoked while an umpire waits lands on the existing `DeadLink` page. `RESULT_CARRIED_FORWARD` is NOT added to `DEAD_CODES` — the link is alive, the fixture is over.
- **Server event ids / `lastOwnVoidable`**: unchanged. `handlePadEvents` never sees `RESULT_CARRIED_FORWARD` (it only issues GETs), so the chrome learns it from `send()` and from the new inner-pad callback only.

---

## Global Constraints

- **pnpm, never npm.** Every shell command starts `cd /Users/ashokhein/github/seazn.club-worktrees/scorer-sheets && …` (the shell cwd resets between calls). Never `git stash` in this worktree. No heredocs in this worktree.
- **The worktree has no `node_modules`.** First action of the first task: `cd /Users/ashokhein/github/seazn.club-worktrees/scorer-sheets && pnpm install --frozen-lockfile`. Never symlink `node_modules` from main (it compiles MAIN's engine).
- **Environment** per the `seazn-local-env` skill: `S=~/.claude/skills/seazn-local-env/scripts/seazn-env.sh; $S up --label sheets --server` from this worktree; `eval "$($S env --label sheets)"` in every shell that runs tests; `$S rebuild --label sheets` after code changes before any e2e/smoke. `db:apply` alone is not a fresh schema — `up` runs `sync:sports`. Confirm `show data_directory` is the label's own if anything looks odd.
- **Vitest is judged only by JSON**, run from `apps/web`:
  `cd /Users/ashokhein/github/seazn.club-worktrees/scorer-sheets/apps/web && rm -f "$TMPDIR/sheets.json" && rtk proxy pnpm exec vitest run <exact paths> --reporter=json --outputFile="$TMPDIR/sheets.json"; echo EXIT=$?`
  then `jq '{p:.numPassedTests,t:.numTotalTests,f:.numFailedTests,files:[.testResults[].name]}' "$TMPDIR/sheets.json"`. Green = `f == 0`, `p == t`, and `.testResults[].name` lists THIS worktree's paths. Positionals are literal filename filters — a typo runs a subset and reports green; always confirm the file list. DB suites skip silently without `DATABASE_URL` — `pending > 0` on a DB file means the env is missing, not green.
- **Lint/typecheck:** `$S gate --label sheets` and read the `Cached: N cached, M total` line; `rtk proxy pnpm run lint` if you need the raw `✖ N problems`.
- **Playwright:** `cd /Users/ashokhein/github/seazn.club-worktrees/scorer-sheets/apps/web && PLAYWRIGHT_BASE=$SMOKE_BASE E2E_PROD_TARGET=1 rtk proxy pnpm exec playwright test --project=walkthrough <file>; echo EXIT=$?`. `PLAYWRIGHT_BASE` host must be `localhost`, never `127.0.0.1`. Run the WHOLE spec file, never a `-g` slice (AGENTS 21). A timeout prints the in-flight poll's mismatch first — check the poll's own timeout before chasing data (AGENTS 20).
- **Every task ships a test that fails without it.** Write it, run it, SEE it red, then implement.
- **All four test types across the plan** (RULES): unit, e2e (Playwright), smoke (`scripts/smoke.ts`), regression. A backend-only task names the e2e that exercises it.
- **Every guard is mutation-tested.** Each task's final step lists `mutant → killing test`; apply each mutant by hand, run the named test, see it red, revert. Report the killer list, not a count.
- **Seams are proven through their real producer and consumer** (AGENTS 1): the carried-forward refusal is proven by a REAL inner-pad tap in a browser, and the PDF QR by a token extracted from the real PDF bytes and opened in a browser.
- **Empty case first** in every predicate/rule-table test (spec §4.3, RULES test-design). Include ≥1 case where the right answer differs from the wrong answer's constant.
- **i18n:** every new/changed user-facing string goes into all four dictionaries `apps/web/src/dictionaries/{en,es,fr,nl}/ui.json`, then `cd /Users/ashokhein/github/seazn.club-worktrees/scorer-sheets && pnpm run i18n:gen-keys && pnpm run i18n:check` (`apps/web/src/lib/i18n-keys.ts` is GENERATED — never hand-edit). No hard-coded English in anything a customer reads, including the PDF.
- **OpenAPI:** any v1 route/schema change → `cd /Users/ashokhein/github/seazn.club-worktrees/scorer-sheets && pnpm run openapi:gen && git status --porcelain openapi/` and commit the regenerated `openapi/v1.json` / `openapi/v1.public.json`. CI fails on drift.
- **Migrations:** Flyway, `db/migration/deltas/V415__device_link_sealed_secret.sql`. Before committing, re-run `git fetch -q origin && for b in $(git for-each-ref --format='%(refname:short)' refs/heads refs/remotes); do git ls-tree -r --name-only $b db/migration | grep -E '/V415__'; done` — a duplicate version survives a clean rebase and breaks Flyway at deploy.
- **UI bar:** mobile-first; screenshots at **320, 768, 1280** of every screen this plan adds or changes, no horizontal page scroll at any of them (`expectNoHorizontalScroll` in `e2e/helpers.ts`); `truncate` needs `min-w-0` on the whole ancestor chain; control-set diff (membership + order), not box size, between 320 and 1280. Show ≥2 UI options to the owner before building the print control (RULES).
- **Walkthrough specs** go in `apps/web/e2e/walkthrough/` and are registered in `WALKTHROUGH_SPECS` (`apps/web/src/lib/__tests__/e2e-ci-wiring.test.ts:159`) in programme order — immediately after `"device-pad-foreign-void.spec.ts",` (the device-link group), before `"entrant-rename-walkthrough.spec.ts",`.
- **Do NOT touch:** `packages/engine/**`, `fillSlot`/`onDecided` semantics, the Swiss pairing code, `fixture-console.tsx`'s `canHandOver` predicate (D2 is server-side; the console's two-sides UI gate stays), the frozen-competition guard (D8), `maybeAutoAdvance` (spec §6), anything under `apps/web/src/components/v2/scorepad/v3/` except the one prop in Task 5.
- Commit trailer on every commit: `Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>`. Commit only your own paths (`git add <paths>`, never `-A`). Do not push.

## Review Focus

Inputs the spec implies but does not test, most likely to bite first; each line's test is added to the owning task.

1. **Two organisers print (or print + hand over) the same day at the same moment.** Expect one live link per fixture and both PDFs carrying the SAME token. Without a per-fixture lock both see "no live link", both mint, the second revokes the first, and the first sheet is dead on arrival. → Task 2, concurrency test + advisory lock.
2. **A scheduled/in-play fixture whose feed target was filled by hand** (organiser seats someone in the final early). Expect the SF umpire can still score — carried-forward is only meaningful once this fixture is settled. → Task 4, "scheduled fixture with a filled feed still scores" (right answer differs from the ungated predicate).
3. **A fixture near local midnight in a timezone far from UTC** (e.g. 23:30 Pacific/Auckland is the previous UTC day). Expect it on the organiser's chosen LOCAL day, in its own division's tz, not UTC's. → Task 7, tz-edge cases.
4. **The PDF response carries live scoring credentials.** Expect `Cache-Control: private, no-store` and no CDN/browser caching of it; a cached copy is a credential leak. → Task 8, header assertion.
5. **A bye / one-sided settled fixture scanned** (forfeited with a null side). Expect a clear "no match to score" View-only screen, not Waiting forever and not a broken pad. → Task 6, `scanScreen` table row.

---

## File Structure

| Path | Create/Modify | Responsibility |
|---|---|---|
| `db/migration/deltas/V415__device_link_sealed_secret.sql` | Create (T1) | `secret_enc bytea null`, `expires_at` nullable |
| `apps/web/src/server/relay/crypto.ts` | Modify (T1) | envelope keyed by KEK name: `sealWith`/`openWith`; `seal`/`open` stay RELAY_KEK wrappers |
| `apps/web/src/server/relay/__tests__/crypto.test.ts` | Modify (T1) | DEVICE_LINK_KEK round-trip, key separation, tamper, missing key |
| `apps/web/src/server/relay/__tests__/enc-boundary.test.ts` | Modify (T1) | columns from every delta; per-column allow-list |
| `.env.example`, `.github/workflows/{ci,e2e,bench,help-shots}.yml` | Modify (T1) | `DEVICE_LINK_KEK` |
| `apps/web/src/lib/__tests__/device-link-kek-wiring.test.ts` | Create (T1) | every job with `AUTH_SECRET:` also has `DEVICE_LINK_KEK:` |
| `apps/web/src/server/usecases/device-links.ts` | Modify (T2) | `ensureDeviceLink(s)`, sealing mint, null-expiry resolver/active |
| `apps/web/src/server/usecases/__tests__/device-links.test.ts` | Modify (T2) | ensure/legacy/concurrency/null-expiry |
| `apps/web/src/app/api/v1/fixtures/[id]/device-links/route.ts` | Modify (T2) | POST → ensure (201 minted / 200 reused) |
| `apps/web/src/app/api/v1/fixtures/[id]/device-links/reissue/route.ts` | Create (T2) | POST → revoke + mint (Revoke & reissue) |
| `apps/web/src/server/api-v1/{schemas,openapi,key-scopes}.ts`, `openapi/*.json` | Modify (T2) | nullable `expires_at`, reissue route |
| `apps/web/src/components/v2/device-link-panel.tsx` | Modify (T3) | Show QR (same secret), Revoke & reissue, no-expiry copy |
| `apps/web/src/components/v2/device-link-copy.ts` | Create (T3) | pure copy-key choice for expiry |
| `apps/web/src/server/usecases/carried-forward.ts` | Create (T4) | pure predicate + SQL facts loader |
| `apps/web/src/server/usecases/scoring.ts` | Modify (T4) | 403 `RESULT_CARRIED_FORWARD` for device-link actors |
| `apps/web/src/server/usecases/__tests__/_sheets-rig.ts` | Create (T4) | league/knockout/swiss rigs for T4/T6/T7/T8 DB tests |
| `apps/web/src/components/v2/scorepad/transport.ts` | Modify (T5) | export `CHROME_TERMINAL_CODES`, `terminalRefusalOf` |
| `apps/web/src/components/v2/scorepad/refusal-copy.ts` | Modify (T5) | copy for the new code |
| `apps/web/src/components/v2/scorepad/v3/pad-host.tsx` | Modify (T5) | `onTerminalRefusal` prop fired from `lastRejection` |
| `apps/web/src/components/v2/scorepad/registry.tsx` | Modify (T5) | forward `onTerminalRefusal` |
| `apps/web/src/components/v2/device-score-pad.tsx` | Modify (T5, T6) | View-only state; Confirm; seeded mount |
| `apps/web/e2e/walkthrough/device-pad-carried-forward.spec.ts` | Create (T5) | real inner-pad tap → View-only |
| `apps/web/src/lib/scan-screen.ts` | Create (T6) | pure screen table |
| `apps/web/src/components/v2/use-tab-return.ts` | Create (T6) | G1 effect extracted verbatim |
| `apps/web/src/components/v2/scan-waiting.tsx` | Create (T6) | Waiting screen + `router.refresh()` loop |
| `apps/web/src/app/score/[token]/page.tsx` | Modify (T6) | labels/ref/time/status/carried; screen choice; localised DeadLink |
| `apps/web/src/lib/scorer-sheets.ts` | Create (T7) | pure day selection, ordering, default day, pagination |
| `apps/web/src/server/usecases/scorer-sheets.ts` | Create (T7) | the query + `listSheetDays` |
| `apps/web/src/server/scorer-sheet-pdf.ts` | Create (T8) | sheet renderer on `doc-theme` (fonts, palette, `qrBuffer`) + `doc-render`'s masthead/title block |
| `apps/web/src/server/doc-render.ts` | Modify (T8) | export `MARGIN`/`resolveLogo`/`drawMasthead`/`drawTitleBlock`; optional `eyebrow` param (no behaviour change) |
| `apps/web/src/server/usecases/exports.ts` | Modify (T8) | export `orgBranding` (no behaviour change) |
| `apps/web/src/app/api/v1/competitions/[id]/exports/scorer-sheets/route.ts` | Create (T8) | POST route, timetable/tickets pattern; + `openapi.ts`, `key-scopes.ts`, `openapi/*.json` |
| `apps/web/src/components/v2/print-scorer-sheets.tsx` | Create (T9) | day picker + button + gate |
| `apps/web/src/app/o/[orgSlug]/c/[compSlug]/schedule/page.tsx` | Modify (T9) | mounts it |
| `apps/web/e2e/walkthrough/scorer-sheets-print-scan.spec.ts` | Create (T10) | print → scan journeys, regression, visual |
| `scripts/smoke.ts` | Modify (T10) | PDF + QR count + same tokens + carried refusal |
| `apps/web/src/lib/__tests__/e2e-ci-wiring.test.ts` | Modify (T5, T10) | `WALKTHROUGH_SPECS` entries |
| `apps/web/src/dictionaries/{en,es,fr,nl}/ui.json`, `apps/web/src/lib/i18n-keys.ts` | Modify (T3, T5, T6, T8, T9) | strings + regen |

Task order is strict: T1 → T2 → T3 → T4 → T5 → T6 → T7 → T8 → T9 → T10. T3/T4 and T7 touch disjoint files and MAY run in parallel only in separate worktrees (`isolation: "worktree"`); by default run sequentially.

---

### Task 1: Sealed-secret column, `DEVICE_LINK_KEK` envelope, env wiring

**Files:**
- Create: `db/migration/deltas/V415__device_link_sealed_secret.sql`
- Modify: `apps/web/src/server/relay/crypto.ts` (whole file — `kek()`, `seal`, `open`)
- Modify: `apps/web/src/server/relay/__tests__/crypto.test.ts` (append a describe block)
- Modify: `apps/web/src/server/relay/__tests__/enc-boundary.test.ts:27-58` (column derivation + claims 1–3)
- Modify: `.env.example:78-79`, `.github/workflows/ci.yml` (jobs `smoke-db` ~:556, `smoke-db-usecases` ~:933, `smoke-e2e` ~:1204), `.github/workflows/e2e.yml` (`e2e-parallel` ~:321, `e2e-serial` ~:929, `e2e-mobile` ~:1252), `.github/workflows/bench.yml` (~:78), `.github/workflows/help-shots.yml` (~:38)
- Create: `apps/web/src/lib/__tests__/device-link-kek-wiring.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `type KekName = "RELAY_KEK" | "DEVICE_LINK_KEK"`; `sealWith(kek: KekName, plain: string): Buffer`; `openWith(kek: KekName, enc: Uint8Array): string` (both in `@/server/relay/crypto`); `seal`/`open` unchanged in signature and behaviour (RELAY_KEK). Column `device_links.secret_enc bytea null`; `device_links.expires_at timestamptz null`.

- [ ] **Step 0: Worktree + environment**

```bash
cd /Users/ashokhein/github/seazn.club-worktrees/scorer-sheets && git log --oneline -1 && pnpm install --frozen-lockfile
S=~/.claude/skills/seazn-local-env/scripts/seazn-env.sh
cd /Users/ashokhein/github/seazn.club-worktrees/scorer-sheets && $S up --label sheets --server
# Count-only check; NEVER print the value. 0 on either file => STOP and ask the owner to add a 64-hex DEVICE_LINK_KEK (owner action, their secret file).
grep -a -c '^DEVICE_LINK_KEK=[0-9a-f]\{64\}$' /Users/ashokhein/github/seazn.club/.env.local /Users/ashokhein/github/seazn.club/apps/web/.env.local
```

- [ ] **Step 1: Write the failing crypto tests** — append to `apps/web/src/server/relay/__tests__/crypto.test.ts`, and change its import line to `import { open, openWith, seal, sealWith } from "../crypto";`

```ts
// Scorer sheets §4.1 — the device-link secret is sealed under its OWN key. One
// leaked KEK must not open both the stream keys and every printed scoring QR.
describe("sealWith/openWith — DEVICE_LINK_KEK (scorer sheets §4.1)", () => {
  const savedDl = process.env.DEVICE_LINK_KEK;
  beforeAll(() => { process.env.DEVICE_LINK_KEK = randomBytes(32).toString("hex"); });
  afterAll(() => {
    if (savedDl === undefined) delete process.env.DEVICE_LINK_KEK;
    else process.env.DEVICE_LINK_KEK = savedDl;
  });

  it("round-trips a dl_ secret", () => {
    const secret = "dl_" + randomBytes(32).toString("base64url");
    expect(openWith("DEVICE_LINK_KEK", sealWith("DEVICE_LINK_KEK", secret))).toBe(secret);
  });

  it("a blob sealed under DEVICE_LINK_KEK does not open under RELAY_KEK, and vice versa", () => {
    expect(() => openWith("RELAY_KEK", sealWith("DEVICE_LINK_KEK", "dl_x"))).toThrow();
    expect(() => openWith("DEVICE_LINK_KEK", seal("rtmps://x"))).toThrow();
    // Positive pair: each key opens its own blob.
    expect(open(sealWith("RELAY_KEK", "rtmps://x"))).toBe("rtmps://x");
  });

  it("a flipped byte in the body throws instead of returning a plausible wrong secret", () => {
    const blob = sealWith("DEVICE_LINK_KEK", "dl_abc");
    blob[blob.length - 1] ^= 0x01;
    expect(() => openWith("DEVICE_LINK_KEK", blob)).toThrow();
  });

  it("names DEVICE_LINK_KEK when it is missing or malformed — never RELAY_KEK", () => {
    const keep = process.env.DEVICE_LINK_KEK;
    try {
      delete process.env.DEVICE_LINK_KEK;
      expect(() => sealWith("DEVICE_LINK_KEK", "dl_x")).toThrow(/DEVICE_LINK_KEK is not set/);
      process.env.DEVICE_LINK_KEK = "abcd";
      expect(() => sealWith("DEVICE_LINK_KEK", "dl_x")).toThrow(/DEVICE_LINK_KEK must be exactly 64 hex/);
    } finally {
      process.env.DEVICE_LINK_KEK = keep;
    }
  });
});
```

- [ ] **Step 2: Run it — expect FAIL** (`sealWith` is not exported)

Run: `cd /Users/ashokhein/github/seazn.club-worktrees/scorer-sheets/apps/web && rm -f "$TMPDIR/sheets.json" && rtk proxy pnpm exec vitest run src/server/relay/__tests__/crypto.test.ts --reporter=json --outputFile="$TMPDIR/sheets.json"; echo EXIT=$?; jq '{p:.numPassedTests,t:.numTotalTests,f:.numFailedTests,files:[.testResults[].name]}' "$TMPDIR/sheets.json"`
Expected: suite fails to collect or 4 failures naming `sealWith`.

- [ ] **Step 3: Implement** — replace from `function kek(): Buffer {` to the end of `apps/web/src/server/relay/crypto.ts` with:

```ts
/** The two envelope keys. Separate on purpose (scorer sheets §4.1): a leaked
 *  RELAY_KEK opens stream keys, a leaked DEVICE_LINK_KEK opens printed scoring
 *  QRs, and neither opens the other. */
export type KekName = "RELAY_KEK" | "DEVICE_LINK_KEK";

function kek(name: KekName): Buffer {
  const hex = process.env[name];
  if (!hex) throw new Error(`${name} is not set (32 bytes as 64 hex chars; a Fly secret in prod)`);
  if (!KEK_HEX.test(hex)) throw new Error(`${name} must be exactly 64 hex characters (32 bytes)`);
  return Buffer.from(hex, "hex");
}

export function sealWith(name: KekName, plain: string): Buffer {
  const dek = randomBytes(KEY_LEN);
  const dataIv = randomBytes(IV_LEN);
  const data = createCipheriv("aes-256-gcm", dek, dataIv);
  const body = Buffer.concat([data.update(plain, "utf8"), data.final()]);
  const dataTag = data.getAuthTag();

  const wrapIv = randomBytes(IV_LEN);
  const wrap = createCipheriv("aes-256-gcm", kek(name), wrapIv);
  const wrapped = Buffer.concat([wrap.update(dek), wrap.final()]);
  const wrapTag = wrap.getAuthTag();

  return Buffer.concat([Buffer.from([VERSION]), wrapIv, wrapped, wrapTag, dataIv, dataTag, body]);
}

export function openWith(name: KekName, enc: Uint8Array): string {
  const b = Buffer.from(enc);
  if (b.length < HEADER_LEN) throw new Error("relay envelope too short");
  if (b[0] !== VERSION) throw new Error(`relay envelope version ${b[0]} is not supported`);
  const wrapIv = b.subarray(1, 13);
  const wrapped = b.subarray(13, 45);
  const wrapTag = b.subarray(45, 61);
  const dataIv = b.subarray(61, 73);
  const dataTag = b.subarray(73, 89);
  const body = b.subarray(89);

  const unwrap = createDecipheriv("aes-256-gcm", kek(name), wrapIv);
  unwrap.setAuthTag(wrapTag);
  const dek = Buffer.concat([unwrap.update(wrapped), unwrap.final()]);

  const data = createDecipheriv("aes-256-gcm", dek, dataIv);
  data.setAuthTag(dataTag);
  return Buffer.concat([data.update(body), data.final()]).toString("utf8");
}

/** The relay's envelope — RELAY_KEK. Unchanged contract for every stream caller. */
export function seal(plain: string): Buffer {
  return sealWith("RELAY_KEK", plain);
}

export function open(enc: Uint8Array): string {
  return openWith("RELAY_KEK", enc);
}
```

Also update the header comment's first line to: `// server/relay/crypto.ts — AES-256-GCM envelope (design §6.2), keyed by RELAY_KEK (stream keys) or DEVICE_LINK_KEK (device-link secrets, scorer sheets §4.1).`

- [ ] **Step 4: Run crypto tests — expect PASS** (same command as Step 2; the pre-existing RELAY_KEK cases must still pass unchanged).

- [ ] **Step 5: Write the migration** `db/migration/deltas/V415__device_link_sealed_secret.sql`:

```sql
-- =============================================================================
-- Scorer sheets §4.1 (design 2026-09-23): a device link can be re-shown.
--
-- `secret_enc` is the plaintext dl_ secret sealed under DEVICE_LINK_KEK
-- (server/relay/crypto.ts sealWith). `token_hash` stays the ONLY lookup path —
-- nothing ever searches by the sealed value. A reprinted sheet and a console
-- hand-over open this column and hand back the SAME secret, so printing never
-- kills a sheet already on a court.
--
-- `expires_at` becomes nullable: a sealed link lives until its fixture is over
-- (the scoring path refuses it once the result is carried forward, and the
-- fixture's finalized/cancelled locks stand). Legacy hash-only rows keep their
-- end-of-day expiry and are replaced the first time ensureDeviceLink meets them.
-- =============================================================================
alter table device_links add column if not exists secret_enc bytea null;
alter table device_links alter column expires_at drop not null;
```

- [ ] **Step 6: Write the failing enc-boundary change** — replace lines 27-58 of `enc-boundary.test.ts` (from `const migration = …` through the end of the first `describe`) with:

```ts
// Every *_enc column ANY delta declares — `create table` column lines and
// `alter table … add column` alike. Deriving from one migration file (the old
// form) could not see a column added anywhere else.
const DELTA_FILES = readdirSync(DELTAS).filter((f) => /^V\d+__.+\.sql$/.test(f));
const ENC_COLUMNS = [
  ...new Set(
    DELTA_FILES.flatMap((f) =>
      [...readFileSync(join(DELTAS, f), "utf8").matchAll(/\b([a-z_]+_enc)\s+bytea\b/g)].map((m) => m[1]!),
    ),
  ),
].sort();

/** The relay's three stream columns: only server/relay/** may name them. */
const STREAM_COLUMNS = ["ingest_rtmps_key_enc", "ingest_srt_key_enc", "rtmp_enc"];
/** Scorer sheets §4.1: the sealed device-link secret, named by exactly one file. */
const DEVICE_LINK_COLUMNS = ["secret_enc"];
const DEVICE_LINK_OWNER = "server/usecases/device-links.ts";

describe("*_enc columns never leave their owners", () => {
  it("every declared *_enc column is owned — a new one cannot walk past this test", () => {
    expect(ENC_COLUMNS).toEqual([...STREAM_COLUMNS, ...DEVICE_LINK_COLUMNS].sort());
  });

  it("no file outside server/relay/** names a stream column (r3)", () => {
    const pattern = new RegExp(`\\b(${STREAM_COLUMNS.join("|")})\\b`);
    const offenders = walk(SRC)
      .filter((f) => !relative(SRC, f).startsWith("server/relay/"))
      .filter((f) => pattern.test(readFileSync(f, "utf8")))
      .map((f) => relative(SRC, f));
    expect(offenders).toEqual([]);
  });

  it("inside the boundary, only secret-columns.ts issues SQL over the stream columns", () => {
    const inside = walk(join(SRC, "server/relay"))
      .filter((f) => !f.includes("__tests__"))
      .filter((f) => new RegExp(`\\b(${STREAM_COLUMNS.join("|")})\\b`).test(readFileSync(f, "utf8")))
      .map((f) => relative(SRC, f));
    expect(inside).toEqual(["server/relay/secret-columns.ts"]);
  });

  it("outside __tests__, only device-links.ts names secret_enc — and it does", () => {
    const pattern = new RegExp(`\\b(${DEVICE_LINK_COLUMNS.join("|")})\\b`);
    const naming = walk(SRC)
      .map((f) => relative(SRC, f))
      .filter((f) => !f.split("/").includes("__tests__"))
      .filter((f) => pattern.test(readFileSync(join(SRC, f), "utf8")));
    expect(naming).toEqual([DEVICE_LINK_OWNER]);
  });
});
```

Run the boundary test now. Expected: the ownership test FAILS (`naming` is `[]` — `device-links.ts` does not name `secret_enc` until Task 2). That is correct and intended: Task 2 turns it green. Record the red output in the task report; do not weaken it. (If you want this task's own commit green, run only the first three `it`s here by listing the file and reading the per-test statuses — the fourth is owned by Task 2.)

- [ ] **Step 7: Env wiring — failing test first.** Create `apps/web/src/lib/__tests__/device-link-kek-wiring.test.ts`:

```ts
// Scorer sheets §4.1 / P3: every mint now SEALS, so a server without
// DEVICE_LINK_KEK cannot hand a device over. RELAY_KEK was never wired into CI
// (its tests set it in-process); this key is needed by the SERVER under e2e and
// smoke, so every job that boots a server with AUTH_SECRET must carry it too.
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const ROOT = resolve(import.meta.dirname, "../../../../..");
const WORKFLOWS = ["ci.yml", "e2e.yml", "bench.yml", "help-shots.yml"];

const count = (text: string, re: RegExp) => (text.match(re) ?? []).length;

describe("DEVICE_LINK_KEK reaches every server a test boots", () => {
  for (const wf of WORKFLOWS) {
    it(`${wf}: one DEVICE_LINK_KEK per AUTH_SECRET job env`, () => {
      const text = readFileSync(resolve(ROOT, ".github/workflows", wf), "utf8");
      const auth = count(text, /^\s+AUTH_SECRET:/gm);
      expect(auth, `${wf} has no AUTH_SECRET job env — the premise of this test moved`).toBeGreaterThan(0);
      expect(count(text, /^\s+DEVICE_LINK_KEK:\s*[0-9a-f]{64}\s*$/gm)).toBe(auth);
    });
  }

  it(".env.example documents it", () => {
    expect(readFileSync(resolve(ROOT, ".env.example"), "utf8")).toMatch(/^DEVICE_LINK_KEK=$/m);
  });
});
```

Run it — expect 5 failures. Then add, directly under every `AUTH_SECRET:` line in the 8 job envs (same indentation):

```yaml
      # CI-only envelope key for sealed device-link secrets (scorer sheets §4.1). Never a real key.
      DEVICE_LINK_KEK: 0f1e2d3c4b5a69788796a5b4c3d2e1f00f1e2d3c4b5a69788796a5b4c3d2e1f0
```

and in `.env.example` under `RELAY_KEK=`:

```
# Envelope key for device-link secrets (scorer sheets). 64 hex chars. Separate from RELAY_KEK on purpose.
DEVICE_LINK_KEK=
```

Run the wiring test — expect 5 passes. Note: `e2e.yml` edits change LIVE CI (it runs on every push to `main`).

- [ ] **Step 8: Apply the migration to the label DB and confirm the shape**

```bash
cd /Users/ashokhein/github/seazn.club-worktrees/scorer-sheets && eval "$($S env --label sheets)" && pnpm run db:apply && psql "$DATABASE_URL" -Atc "select column_name, is_nullable from information_schema.columns where table_name='device_links' and column_name in ('secret_enc','expires_at') order by 1"
```
Expected: `expires_at|YES` and `secret_enc|YES`. (`db:apply` without the env migrates the DEV db — the `eval` is mandatory.)

- [ ] **Step 9: Mutation check** (apply, run the named test, see red, revert):
  - `sealWith` ignores `name` and always uses `kek("RELAY_KEK")` → killed by "does not open under RELAY_KEK".
  - `kek()` error message hard-codes `RELAY_KEK` → killed by "names DEVICE_LINK_KEK when it is missing".
  - drop one `DEVICE_LINK_KEK:` line from `e2e.yml` → killed by `e2e.yml: one DEVICE_LINK_KEK per AUTH_SECRET job env`.
  - add `foo_enc bytea` to any delta → killed by "every declared *_enc column is owned".

- [ ] **Step 10: Duplicate-version check, then commit**

```bash
cd /Users/ashokhein/github/seazn.club-worktrees/scorer-sheets && git fetch -q origin && for b in $(git for-each-ref --format='%(refname:short)' refs/heads refs/remotes); do git ls-tree -r --name-only $b db/migration | grep -E '/V415__' | sed "s#^#$b: #"; done
git add db/migration/deltas/V415__device_link_sealed_secret.sql apps/web/src/server/relay/crypto.ts apps/web/src/server/relay/__tests__/crypto.test.ts apps/web/src/server/relay/__tests__/enc-boundary.test.ts apps/web/src/lib/__tests__/device-link-kek-wiring.test.ts .env.example .github/workflows/ci.yml .github/workflows/e2e.yml .github/workflows/bench.yml .github/workflows/help-shots.yml
git commit -m "feat(device-links): sealed secret column and DEVICE_LINK_KEK envelope" -m "Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```
The only branch allowed to list V415 is this one.

---

### Task 2: `ensureDeviceLink`, Revoke & reissue, null-expiry resolver, v1 routes

**Files:**
- Modify: `apps/web/src/server/usecases/device-links.ts` (DeviceLinkRow :24-34; `createDeviceLink` :117-163; `getActiveDeviceLink` :183-195; `resolveDeviceLinkToken` :249-263; add new functions after `createDeviceLink`)
- Modify: `apps/web/src/server/usecases/__tests__/device-links.test.ts` (append a describe), `apps/web/src/server/usecases/__tests__/pass-scope-w2.test.ts:202-216`, `apps/web/src/app/score/[token]/__tests__/page.test.tsx` (KEK line only)
- Modify: `apps/web/src/app/api/v1/fixtures/[id]/device-links/route.ts:11-29`
- Create: `apps/web/src/app/api/v1/fixtures/[id]/device-links/reissue/route.ts`
- Modify: `apps/web/src/server/api-v1/schemas.ts:1563-1576`, `apps/web/src/server/api-v1/openapi.ts:170-172`, `apps/web/src/server/api-v1/key-scopes.ts:332-334`; regenerate `openapi/v1.json`, `openapi/v1.public.json`

**Interfaces:**
- Consumes: `sealWith`, `openWith` (Task 1).
- Produces (all in `@/server/usecases/device-links`):
  - `DeviceLinkRow.expires_at: string | null`
  - `isLiveExpiry(expiresAt: string | null, now?: number): boolean`
  - `interface EnsuredDeviceLink { row: DeviceLinkRow; secret: string; minted: boolean }`
  - `ensureDeviceLink(auth: AuthCtx, fixtureId: string, label?: string | null): Promise<EnsuredDeviceLink>`
  - `ensureDeviceLinks(auth: AuthCtx, competitionId: string, fixtureIds: readonly string[]): Promise<Map<string, EnsuredDeviceLink>>`
  - `createDeviceLink(auth, fixtureId, label)` — now the Revoke & reissue primitive: revokes every live link, mints, SEALS, `expires_at = null`. Same signature/return.
  - v1: `POST /api/v1/fixtures/{id}/device-links` → ensure (201 minted, 200 reused; body `CreatedDeviceLink`); `POST /api/v1/fixtures/{id}/device-links/reissue` → `createDeviceLink` (201).

- [ ] **Step 1: KEK for every vitest file that mints.** At the top of `device-links.test.ts`, `page.test.tsx` and `pass-scope-w2.test.ts`, directly after the imports:

```ts
import { randomBytes as kekBytes } from "node:crypto";
// Every mint seals now (scorer sheets §4.1). Keep a developer's key if present; never print it.
process.env.DEVICE_LINK_KEK ??= kekBytes(32).toString("hex");
```
(`device-links.test.ts` already imports `randomUUID` from `node:crypto` — add `randomBytes as kekBytes` to that import instead of a second line.)

- [ ] **Step 2: Write the failing tests** — append to `device-links.test.ts` (uses the file's own `seedOrg`, `asOwner`, `rig`, `dlRequest`):

```ts
import { ensureDeviceLink, ensureDeviceLinks, isLiveExpiry } from "../device-links";

describe("isLiveExpiry (pure)", () => {
  it("null is 'until the fixture is over', never the epoch (P1)", () => {
    expect(isLiveExpiry(null, Date.parse("2030-01-01T00:00:00Z"))).toBe(true);
  });
  it("a past instant is dead, a future one live", () => {
    const now = Date.parse("2026-09-23T12:00:00Z");
    expect(isLiveExpiry("2026-09-23T11:59:59Z", now)).toBe(false);
    expect(isLiveExpiry("2026-09-23T12:00:01Z", now)).toBe(true);
  });
});

describe.skipIf(!HAS_DB)("ensureDeviceLink (scorer sheets §4.2)", () => {
  it("a sealed link has no expiry and RESOLVES (a null expires_at is not LINK_EXPIRED)", async () => {
    const { orgId, ownerId } = await seedOrg("pro");
    const owner = asOwner(orgId, ownerId);
    const { fixtures } = await rig(owner);
    const { row, secret, minted } = await ensureDeviceLink(owner, fixtures[0].id);
    expect(minted).toBe(true);
    expect(row.expires_at).toBeNull();
    await expect(resolveDeviceLinkToken(secret)).resolves.toMatchObject({ fixture_id: fixtures[0].id });
    const active = await getActiveDeviceLink(owner, fixtures[0].id);
    expect(active?.id).toBe(row.id);
  });

  it("twice returns the SAME secret and id, and the second call writes no row", async () => {
    const { orgId, ownerId } = await seedOrg("pro");
    const owner = asOwner(orgId, ownerId);
    const { fixtures } = await rig(owner);
    const a = await ensureDeviceLink(owner, fixtures[0].id);
    const b = await ensureDeviceLink(owner, fixtures[0].id);
    expect(b.secret).toBe(a.secret);
    expect(b.row.id).toBe(a.row.id);
    expect(b.minted).toBe(false);
    const [{ n }] = await sql<{ n: number }[]>`
      select count(*)::int as n from device_links where fixture_id = ${fixtures[0].id}`;
    expect(n).toBe(1);
  });

  it("replaces a legacy hash-only live link: fresh secret, the legacy one revoked", async () => {
    const { orgId, ownerId } = await seedOrg("pro");
    const owner = asOwner(orgId, ownerId);
    const { fixtures } = await rig(owner);
    const legacy = await createDeviceLink(owner, fixtures[0].id, null);
    await sql`update device_links set secret_enc = null, expires_at = now() + interval '6 hours'
              where id = ${legacy.id}`;
    const ensured = await ensureDeviceLink(owner, fixtures[0].id);
    expect(ensured.minted).toBe(true);
    expect(ensured.secret).not.toBe(legacy.secret);
    await expect(resolveDeviceLinkToken(legacy.secret)).rejects.toMatchObject({ code: "LINK_REVOKED" });
    await expect(resolveDeviceLinkToken(ensured.secret)).resolves.toMatchObject({ id: ensured.row.id });
  });

  it("after Revoke & reissue, ensure hands back the REISSUED secret", async () => {
    const { orgId, ownerId } = await seedOrg("pro");
    const owner = asOwner(orgId, ownerId);
    const { fixtures } = await rig(owner);
    const first = await ensureDeviceLink(owner, fixtures[0].id);
    const reissued = await createDeviceLink(owner, fixtures[0].id, null);
    const again = await ensureDeviceLink(owner, fixtures[0].id);
    expect(again.secret).toBe(reissued.secret);
    expect(again.secret).not.toBe(first.secret);
    await expect(resolveDeviceLinkToken(first.secret)).rejects.toMatchObject({ code: "LINK_REVOKED" });
  });

  it("allows a fixture with a TBD side — the link is bound to the fixture (D2)", async () => {
    const { orgId, ownerId } = await seedOrg("pro");
    const owner = asOwner(orgId, ownerId);
    const { fixtures } = await rig(owner);
    await sql`update fixtures set home_entrant_id = null where id = ${fixtures[0].id}`;
    await expect(ensureDeviceLink(owner, fixtures[0].id)).resolves.toMatchObject({ minted: true });
  });

  it("refuses finalized and cancelled with 422 — and a scheduled sibling still mints", async () => {
    const { orgId, ownerId } = await seedOrg("pro");
    const owner = asOwner(orgId, ownerId);
    const { fixtures } = await rig(owner);
    await sql`update fixtures set status = 'finalized' where id = ${fixtures[0].id}`;
    await sql`update fixtures set status = 'cancelled' where id = ${fixtures[1].id}`;
    await expect(ensureDeviceLink(owner, fixtures[0].id)).rejects.toMatchObject({ status: 422 });
    await expect(ensureDeviceLink(owner, fixtures[1].id)).rejects.toMatchObject({ status: 422 });
    await expect(ensureDeviceLink(owner, fixtures[2].id)).resolves.toMatchObject({ minted: true });
  });

  it("refuses an API key: session editors only", async () => {
    const { orgId, ownerId } = await seedOrg("pro");
    const owner = asOwner(orgId, ownerId);
    const { fixtures } = await rig(owner);
    const viaKey: AuthCtx = { ...owner, via: "api_key", keyId: randomUUID() } as AuthCtx;
    await expect(ensureDeviceLink(viaKey, fixtures[0].id)).rejects.toMatchObject({ status: 403 });
  });

  it("Community without a pass: 402 scoring.device_links", async () => {
    const { orgId, ownerId } = await seedOrg("community");
    const owner = asOwner(orgId, ownerId);
    const { fixtures } = await rig(owner);
    await expect(ensureDeviceLink(owner, fixtures[0].id)).rejects.toBeInstanceOf(PaymentRequiredError);
  });

  it("concurrent ensures on one fixture agree on ONE secret (Review Focus 1)", async () => {
    const { orgId, ownerId } = await seedOrg("pro");
    const owner = asOwner(orgId, ownerId);
    const { fixtures } = await rig(owner);
    const results = await Promise.all(Array.from({ length: 6 }, () => ensureDeviceLink(owner, fixtures[0].id)));
    expect(new Set(results.map((r) => r.secret)).size).toBe(1);
    const [{ live }] = await sql<{ live: number }[]>`
      select count(*)::int as live from device_links
      where fixture_id = ${fixtures[0].id} and revoked_at is null`;
    expect(live).toBe(1);
  });

  it("ensureDeviceLinks: one secret per fixture, stable across calls; a foreign fixture 404s", async () => {
    const { orgId, ownerId } = await seedOrg("pro");
    const owner = asOwner(orgId, ownerId);
    const { competition, fixtures } = await rig(owner);
    const other = await rig(owner);
    const ids = [fixtures[1].id, fixtures[0].id];
    const first = await ensureDeviceLinks(owner, competition.id, ids);
    const second = await ensureDeviceLinks(owner, competition.id, ids);
    for (const id of ids) expect(second.get(id)!.secret).toBe(first.get(id)!.secret);
    expect(first.get(fixtures[0].id)!.secret).not.toBe(first.get(fixtures[1].id)!.secret);
    await expect(ensureDeviceLinks(owner, competition.id, [other.fixtures[0].id])).rejects.toMatchObject({ status: 404 });
  });
});
```

and in `pass-scope-w2.test.ts`, inside the `scoring.device_links` case after the `createDeviceLink` assertions (import `ensureDeviceLinks` beside `createDeviceLink`):

```ts
    // Scorer sheets: the print path gates on the SAME competition.
    const sheetFixture = await makeFixture(ctx, passed);
    const sheet = await ensureDeviceLinks(ctx.auth, passed.competitionId, [sheetFixture]);
    expect(sheet.get(sheetFixture)!.secret).toMatch(/^dl_/);
    await expectPaywall(
      ensureDeviceLinks(ctx.auth, plain.competitionId, [await makeFixture(ctx, plain)]),
      "scoring.device_links",
    );
```

Also make the fourth enc-boundary test (Task 1 Step 6) part of this run.

- [ ] **Step 3: Run — expect FAIL**

`cd /Users/ashokhein/github/seazn.club-worktrees/scorer-sheets/apps/web && eval "$($S env --label sheets)" && rm -f "$TMPDIR/sheets.json" && rtk proxy pnpm exec vitest run src/server/usecases/__tests__/device-links.test.ts src/server/usecases/__tests__/pass-scope-w2.test.ts src/server/relay/__tests__/enc-boundary.test.ts --reporter=json --outputFile="$TMPDIR/sheets.json"; echo EXIT=$?`
Expected: collection error on the missing exports (then, once stubs exist, the null-expiry resolve fails with `LINK_EXPIRED`). Confirm `pending == 0` — a skipped DB suite is NOT a red.

- [ ] **Step 4: Implement in `device-links.ts`.** Add imports `import { openWith, sealWith } from "@/server/relay/crypto";` and `import type { Tx } from "@/lib/db";` (merge with the existing `@/lib/db` import). Change `DeviceLinkRow.expires_at` to `string | null`. Replace `createDeviceLink` (:117-163) with:

```ts
/** A link is live until its expiry; a sealed link (V415) has none — it lives
 *  until the fixture is over, which the SCORING path enforces (scorer sheets
 *  §4.3), not this clock. `new Date(null)` is the epoch, which is why this is
 *  a function and not an inline comparison (P1). */
export function isLiveExpiry(expiresAt: string | null, now: number = Date.now()): boolean {
  return expiresAt === null || new Date(expiresAt).getTime() > now;
}

/** Serialise every mint/ensure on one fixture. Without it two organisers
 *  printing at once both see "no live link", both mint, and the second revoke
 *  kills the first sheet before it leaves the printer. */
async function lockFixtureLinks(tx: Tx, fixtureId: string): Promise<void> {
  await tx`select pg_advisory_xact_lock(hashtext(${"device_link:" + fixtureId}))`;
}

async function loadLinkableFixture(tx: Tx, fixtureId: string, competitionId?: string): Promise<void> {
  const [fixture] = await tx<{ status: string; competition_id: string }[]>`
    select f.status, d.competition_id from fixtures f
    join divisions d on d.id = f.division_id
    where f.id = ${fixtureId}`;
  if (!fixture || (competitionId !== undefined && fixture.competition_id !== competitionId)) {
    throw new HttpError(404, "fixture not found");
  }
  if (fixture.status === "finalized" || fixture.status === "cancelled") {
    throw new HttpError(422, `fixture is ${fixture.status} — nothing left to score`);
  }
}

/** Revoke every live link on the fixture and mint a sealed, unexpiring one.
 *  Sealed BEFORE any write: a missing DEVICE_LINK_KEK throws with nothing revoked. */
async function mintInTx(
  tx: Tx,
  auth: AuthCtx,
  fixtureId: string,
  label: string | null,
): Promise<DeviceLinkRow & { secret: string }> {
  const secret = mintDeviceLinkSecret();
  const sealed = sealWith("DEVICE_LINK_KEK", secret);
  await tx`
    update device_links set revoked_at = now()
    where fixture_id = ${fixtureId} and revoked_at is null`;
  const [created] = await tx<DeviceLinkRow[]>`
    insert into device_links (org_id, fixture_id, token_hash, secret_enc, label, issued_by, expires_at)
    values (${auth.orgId}, ${fixtureId}, ${hashDeviceLinkToken(secret)}, ${sealed},
            ${label}, ${auth.userId}, null)
    returning ${tx(COLS)}`;
  return { ...created, secret };
}

/**
 * Revoke & reissue (scorer sheets §4.2): kill every live link for the fixture
 * — a lost sheet, a phone that walked off — and mint a fresh sealed one. The
 * ONLY path that changes a fixture's QR. Secret returned; re-showable later
 * through ensureDeviceLink.
 */
export async function createDeviceLink(
  auth: AuthCtx,
  fixtureId: string,
  label: string | null,
): Promise<DeviceLinkRow & { secret: string }> {
  requireSessionEditor(auth);
  // 402 for Community, unless an Event Pass covers this fixture's competition.
  await requireFeature(auth.orgId, "scoring.device_links", await competitionForFixture(fixtureId));
  return withTenant(auth.orgId, async (tx) => {
    await lockFixtureLinks(tx, fixtureId);
    await loadLinkableFixture(tx, fixtureId);
    return mintInTx(tx, auth, fixtureId, label);
  });
}

export interface EnsuredDeviceLink {
  row: DeviceLinkRow;
  secret: string;
  /** false = an existing sealed link was re-opened (no write). */
  minted: boolean;
}

async function ensureInTx(
  tx: Tx,
  auth: AuthCtx,
  fixtureId: string,
  label: string | null,
  competitionId?: string,
): Promise<EnsuredDeviceLink> {
  await lockFixtureLinks(tx, fixtureId);
  await loadLinkableFixture(tx, fixtureId, competitionId);
  const [live] = await tx<(DeviceLinkRow & { secret_enc: Uint8Array | null })[]>`
    select ${tx(COLS)}, secret_enc from device_links
    where fixture_id = ${fixtureId} and revoked_at is null
      and (expires_at is null or expires_at > now())
    order by created_at desc limit 1`;
  if (live && live.secret_enc) {
    const { secret_enc, ...row } = live;
    return { row, secret: openWith("DEVICE_LINK_KEK", secret_enc), minted: false };
  }
  // None, or only a legacy hash-only link (its secret is unrecoverable): replace it.
  const { secret, ...row } = await mintInTx(tx, auth, fixtureId, label);
  return { row, secret, minted: true };
}

/**
 * The fixture's scoring link, re-shown if it exists (scorer sheets §4.2). A
 * console hand-over and a reprinted sheet both call this, so neither ever
 * kills a QR already on a court. TBD sides are allowed (D2).
 */
export async function ensureDeviceLink(
  auth: AuthCtx,
  fixtureId: string,
  label: string | null = null,
): Promise<EnsuredDeviceLink> {
  requireSessionEditor(auth);
  await requireFeature(auth.orgId, "scoring.device_links", await competitionForFixture(fixtureId));
  return withTenant(auth.orgId, (tx) => ensureInTx(tx, auth, fixtureId, label));
}

/**
 * The print path: one gate for the competition, one transaction, every
 * fixture's link. Ids are locked in SORTED order so two overlapping prints
 * cannot deadlock on each other's advisory locks. A fixture outside
 * `competitionId` is a 404, never a silent mint.
 */
export async function ensureDeviceLinks(
  auth: AuthCtx,
  competitionId: string,
  fixtureIds: readonly string[],
): Promise<Map<string, EnsuredDeviceLink>> {
  requireSessionEditor(auth);
  await requireFeature(auth.orgId, "scoring.device_links", competitionId);
  const out = new Map<string, EnsuredDeviceLink>();
  await withTenant(auth.orgId, async (tx) => {
    for (const id of [...new Set(fixtureIds)].sort()) {
      out.set(id, await ensureInTx(tx, auth, id, null, competitionId));
    }
  });
  return out;
}
```

In `getActiveDeviceLink` change the where clause to `where fixture_id = ${fixtureId} and revoked_at is null and (expires_at is null or expires_at > now())`. In `resolveDeviceLinkToken` change the row type to `expires_at: string | null` and the expiry check to `if (!isLiveExpiry(link.expires_at)) {`. Update the file header's "Mint/revoke" sentence to mention ensure/reissue. `endOfLocalDay` stays exported (checkin-token.ts uses it).

- [ ] **Step 5: v1 routes.** Replace the POST in `app/api/v1/fixtures/[id]/device-links/route.ts` (and its doc comment) with:

```ts
/**
 * The fixture's device link (doc 13 §7; scorer sheets §4.2): editor session
 * only. Re-shows the live sealed link unchanged (200) or mints one (201),
 * replacing a legacy hash-only link. Never revokes a sealed link — Revoke &
 * reissue is `POST …/device-links/reissue`. 402 `scoring.device_links` for
 * Community without an Event Pass.
 */
export async function POST(req: Request, { params }: Ctx) {
  return v1(async () => {
    const { id } = await params;
    const ip =
      req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ??
      req.headers.get("x-real-ip") ??
      "unknown";
    await rateLimit(`dlmint:${ip}`, MINT_LIMIT);
    const body = await parseBody(req, CreateDeviceLink);
    const auth = await requireResourceAuth(req, "fixture", id, "write");
    const { row, secret, minted } = await ensureDeviceLink(auth, id, body.label ?? null);
    return reply(minted ? 201 : 200, { ...row, secret });
  });
}
```
(import `ensureDeviceLink` instead of `createDeviceLink`). Create `app/api/v1/fixtures/[id]/device-links/reissue/route.ts`:

```ts
import { v1, reply, parseBody } from "@/server/api-v1/http";
import { requireResourceAuth } from "@/server/api-v1/auth";
import { rateLimit } from "@/lib/rate-limit";
import { CreateDeviceLink } from "@/server/api-v1/schemas";
import { createDeviceLink } from "@/server/usecases/device-links";

type Ctx = { params: Promise<{ id: string }> };

// Shares the mint bucket: a reissue IS a mint.
const MINT_LIMIT = { max: 10, windowSeconds: 60 };

/** Revoke & reissue (scorer sheets §4.2): every live link for the fixture dies
 *  — including a printed sheet's QR — and a fresh sealed link is minted. */
export async function POST(req: Request, { params }: Ctx) {
  return v1(async () => {
    const { id } = await params;
    const ip =
      req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ??
      req.headers.get("x-real-ip") ??
      "unknown";
    await rateLimit(`dlmint:${ip}`, MINT_LIMIT);
    const body = await parseBody(req, CreateDeviceLink);
    const auth = await requireResourceAuth(req, "fixture", id, "write");
    return reply(201, await createDeviceLink(auth, id, body.label ?? null));
  });
}
```
Before writing it, read `node_modules/next/dist/docs/01-app/03-api-reference/03-file-conventions/route.md` (Next 16.2) and confirm a static `reissue/` segment beside the dynamic `[linkId]/` resolves to the static one.

- [ ] **Step 6: Contracts.** `schemas.ts`: `expires_at: z.string().nullable(),` in `DeviceLink`. `openapi.ts:170` summary becomes `"The fixture's device link (editor session only): re-shows the live sealed link (200) or mints one (201); never revokes a sealed link. Lives until the fixture is over."`; add after :172:

```ts
  { path: "/fixtures/{id}/device-links/reissue", method: "post", summary: "Revoke & reissue: every live device link for the fixture dies (including a printed scorer sheet's QR) and a fresh one is minted", tag: "device-links", request: S.CreateDeviceLink, response: S.CreatedDeviceLink, status: 201, errors: [402, 422, 429] },
```
`key-scopes.ts`: add `"POST /fixtures/:id/device-links/reissue",` after :334 (session-only list). Then:

```bash
cd /Users/ashokhein/github/seazn.club-worktrees/scorer-sheets && pnpm run openapi:gen && git status --porcelain openapi/
```
Expected: both `openapi/*.json` modified. Run the route-coverage/key-scope suites: `rtk proxy pnpm exec vitest run src/server/api-v1/__tests__ --reporter=json --outputFile="$TMPDIR/sheets.json"` from `apps/web` and read the JSON.

- [ ] **Step 7: Run Step 3's command — expect PASS**, `pending == 0`, file list = the three worktree paths. Also re-run `src/app/score/[token]/__tests__/page.test.tsx` (it mints).

- [ ] **Step 8: Mutation check**
  - resolver back to `new Date(link.expires_at).getTime() <= Date.now()` → killed by "a sealed link has no expiry and RESOLVES".
  - `getActiveDeviceLink` back to `expires_at > now()` → killed by the same test's `active?.id` line.
  - `ensureInTx` returns `mintInTx(...)` unconditionally (no reuse) → killed by "twice returns the SAME secret".
  - reuse condition `live && live.secret_enc` → `live` → killed by "replaces a legacy hash-only live link" (openWith on null throws).
  - delete `lockFixtureLinks` from `ensureInTx` → expected kill: "concurrent ensures … agree on ONE secret". This kill is RACE-dependent: run the mutant 3 times and report how many reds; if it survives all three, raise the parallelism to 12 and say so.
  - delete the finalized/cancelled throw → killed by "refuses finalized and cancelled".
  - delete `requireSessionEditor` in `ensureDeviceLink` → killed by "refuses an API key".
  - `ensureDeviceLinks` passes `undefined` as competitionId to `requireFeature` → killed by the pass-scope-w2 sibling paywall.
  - drop the `competitionId` comparison in `loadLinkableFixture` → killed by "a foreign fixture 404s".

- [ ] **Step 9: Commit**

```bash
cd /Users/ashokhein/github/seazn.club-worktrees/scorer-sheets && git add apps/web/src/server/usecases/device-links.ts apps/web/src/server/usecases/__tests__/device-links.test.ts apps/web/src/server/usecases/__tests__/pass-scope-w2.test.ts "apps/web/src/app/score/[token]/__tests__/page.test.tsx" "apps/web/src/app/api/v1/fixtures/[id]/device-links/route.ts" "apps/web/src/app/api/v1/fixtures/[id]/device-links/reissue/route.ts" apps/web/src/server/api-v1/schemas.ts apps/web/src/server/api-v1/openapi.ts apps/web/src/server/api-v1/key-scopes.ts openapi/v1.json openapi/v1.public.json
git commit -m "feat(device-links): ensureDeviceLink re-shows the sealed link; reissue is explicit" -m "Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

E2E owed by this task: `scorer-sheets-print-scan.spec.ts` "regression: a console hand-over after printing keeps the printed QR" (Task 10) exercises the POST route through the real panel.

---

### Task 3: Hand-over panel — Show QR (same secret), Revoke & reissue, no-expiry copy

**Files:**
- Create: `apps/web/src/components/v2/device-link-copy.ts`
- Create: `apps/web/src/components/v2/__tests__/device-link-copy.test.ts`
- Modify: `apps/web/src/components/v2/device-link-panel.tsx` (whole component body)
- Modify: `apps/web/src/dictionaries/{en,es,fr,nl}/ui.json` (keys beside the existing `dlink.*`), regenerate `apps/web/src/lib/i18n-keys.ts`

**Interfaces:**
- Consumes: v1 POST `/device-links` (ensure) and POST `/device-links/reissue` (Task 2).
- Produces: `expiryCopy(expiresAt: string | null, format: (iso: string) => string): { key: MessageKey; vars?: Record<string, string> }` and `liveCopy(...)` with the same shape. Test ids: `device-link-mint` (kept), `device-link-show`, `device-link-reissue`, `device-link-reissue-confirm`, `device-link-url`.

- [ ] **Step 1: Failing test** `apps/web/src/components/v2/__tests__/device-link-copy.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { expiryCopy, liveCopy } from "../device-link-copy";

const fmt = (iso: string) => `AT(${iso})`;

describe("device-link panel copy (scorer sheets §4.2)", () => {
  it("a sealed link (null expiry) says 'until the match is over' — never an epoch date", () => {
    expect(expiryCopy(null, fmt)).toEqual({ key: "dlink.untilOver" });
    expect(liveCopy(null, fmt)).toEqual({ key: "dlink.liveUntilOver" });
  });
  it("a legacy link keeps its dated copy", () => {
    expect(expiryCopy("2026-09-23T23:59:59Z", fmt)).toEqual({
      key: "dlink.shownOnce",
      vars: { date: "AT(2026-09-23T23:59:59Z)" },
    });
    expect(liveCopy("2026-09-23T23:59:59Z", fmt)).toEqual({
      key: "dlink.live",
      vars: { date: "AT(2026-09-23T23:59:59Z)" },
    });
  });
});
```
Run (vitest JSON command, this path) → FAIL (module missing).

- [ ] **Step 2: Implement** `apps/web/src/components/v2/device-link-copy.ts`:

```ts
import type { MessageKey } from "@/lib/messages";

export interface CopyRef {
  key: MessageKey;
  vars?: Record<string, string>;
}

/** Under the QR just shown. A sealed link (V415) has no expiry: it lives until
 *  the match is over and re-shows the same QR, so the old "shown once, until
 *  <date>" copy would be false. Legacy links keep it. */
export function expiryCopy(expiresAt: string | null, format: (iso: string) => string): CopyRef {
  return expiresAt === null
    ? { key: "dlink.untilOver" as MessageKey }
    : { key: "dlink.shownOnce" as MessageKey, vars: { date: format(expiresAt) } };
}

/** The "a link is live" line when no QR is on screen. */
export function liveCopy(expiresAt: string | null, format: (iso: string) => string): CopyRef {
  return expiresAt === null
    ? { key: "dlink.liveUntilOver" as MessageKey }
    : { key: "dlink.live" as MessageKey, vars: { date: format(expiresAt) } };
}
```

- [ ] **Step 3: Strings** — add to each `ui.json` (keep key order beside `dlink.*`):

| key | en | fr | es | nl |
|---|---|---|---|---|
| `dlink.untilOver` | Works until this match is over. Showing or printing it again gives the same QR. | Valable jusqu'à la fin de ce match. L'afficher ou l'imprimer à nouveau donne le même QR. | Válido hasta que termine este partido. Mostrarlo o imprimirlo de nuevo da el mismo QR. | Geldig tot deze wedstrijd voorbij is. Opnieuw tonen of printen geeft dezelfde QR. |
| `dlink.liveUntilOver` | A scoring link is live for this match until it is over. | Un lien de score est actif pour ce match jusqu'à sa fin. | Hay un enlace de puntuación activo para este partido hasta que termine. | Er is een scorelink actief voor deze wedstrijd tot hij voorbij is. |
| `dlink.showQr` | Show QR | Afficher le QR | Mostrar QR | QR tonen |
| `dlink.reissue` | Revoke & reissue | Révoquer et réémettre | Revocar y volver a emitir | Intrekken en opnieuw uitgeven |
| `dlink.reissueWarn` | The QR already handed out or printed for this match will stop working. | Le QR déjà remis ou imprimé pour ce match ne fonctionnera plus. | El QR ya entregado o impreso para este partido dejará de funcionar. | De QR die al is uitgedeeld of geprint voor deze wedstrijd werkt dan niet meer. |
| `dlink.reissueConfirm` | Yes, reissue | Oui, réémettre | Sí, volver a emitir | Ja, opnieuw uitgeven |
| `dlink.keep` | Keep this QR | Garder ce QR | Mantener este QR | Deze QR houden |

Then `cd /Users/ashokhein/github/seazn.club-worktrees/scorer-sheets && pnpm run i18n:gen-keys && pnpm run i18n:check`.

- [ ] **Step 4: Panel.** In `device-link-panel.tsx`: `ActiveLink.expires_at: string | null`; `minted` state `expires_at: string | null`; rename `mint` → `show` (same POST to `/device-links`, which is now ensure); add:

```tsx
  const [confirmReissue, setConfirmReissue] = useState(false);
  const fmtDate = (iso: string) => new Date(iso).toLocaleString();

  async function reissue() {
    setBusy(true);
    setError(null);
    try {
      const link = await apiV1<ActiveLink & { secret: string }>(
        `/api/v1/fixtures/${fixtureId}/device-links/reissue`,
        { method: "POST", json: {} },
      );
      const url = `${window.location.origin}/score/${link.secret}`;
      setMinted({ secret: link.secret, qr: await QRCode.toDataURL(url, { width: 280, margin: 1 }), expires_at: link.expires_at });
      setConfirmReissue(false);
      await refresh();
    } catch (err) {
      if (err instanceof ApiV1Error && err.code === "PAYMENT_REQUIRED") setPaywall(true);
      else setError(err instanceof Error ? err.message : msg("dlink.failed"));
    } finally {
      setBusy(false);
    }
  }
```

Render changes: under the QR, replace the `dlink.shownOnce` paragraph with `{(() => { const c = expiryCopy(minted.expires_at, fmtDate); return msg(c.key, c.vars); })()}`; give the URL paragraph `data-testid="device-link-url"`. In the `active && !minted` branch: the live line uses `liveCopy(active.expires_at, fmtDate)`; buttons in this order — `dlink.showQr` (`data-testid="device-link-show"`, `onClick={show}`, `btn btn-primary text-xs`), `dlink.revoke` (unchanged), `dlink.reissue` (`data-testid="device-link-reissue"`, `onClick={() => setConfirmReissue(true)}`, `btn btn-ghost text-xs`). Replace the old `dlink.newLink` button. When `confirmReissue`: a `role="alert"` paragraph with `dlink.reissueWarn` and two buttons, `dlink.reissueConfirm` (`data-testid="device-link-reissue-confirm"`, `btn btn-danger text-xs`, `onClick={reissue}`) and `dlink.keep` (`onClick={() => setConfirmReissue(false)}`). NO `window.confirm` — e2e fails on native dialogs (`failOnNativeDialog`). Buttons wrap: container `flex flex-wrap gap-2`, each button `min-h-11` for touch.

- [ ] **Step 5: Run** the copy test (PASS), `pnpm run i18n:check` (clean), `$S gate --label sheets` (lint+typecheck clean), and the existing hand-over e2e whole: `apps/web/e2e/device-links.spec.ts` (it clicks `device-link-mint`) — `$S rebuild --label sheets` first.

- [ ] **Step 6: Visual** — at 320/768/1280 capture the panel in each state (no link; QR shown; live link with the three buttons; reissue confirmation) with `screenshotAtWidths` from a throwaway spec under `$TMPDIR` or via the Task 10 capture spec; `expectNoHorizontalScroll` at each width; read every string on screen in `en` and one other locale.

- [ ] **Step 7: Mutation check**
  - `expiryCopy` ignores null (always dated) → killed by "a sealed link (null expiry) says 'until the match is over'".
  - panel's Show QR posts to `/reissue` → killed by Task 10 regression "hand-over after printing keeps the printed QR" (record that the killer lives in Task 10; run it there).

- [ ] **Step 8: Commit** (`git add` the five source paths, the four `ui.json`, `apps/web/src/lib/i18n-keys.ts`) — message `feat(device-links): hand-over panel re-shows the same QR; explicit revoke & reissue`.

---

### Task 4: Carried-forward predicate and the device-link refusal

**Files:**
- Create: `apps/web/src/server/usecases/carried-forward.ts`
- Create: `apps/web/src/server/usecases/__tests__/carried-forward.test.ts` (pure, no DB)
- Create: `apps/web/src/server/usecases/__tests__/_sheets-rig.ts` (DB rig shared with T6–T8)
- Create: `apps/web/src/server/usecases/__tests__/carried-forward-scoring.test.ts` (DB)
- Modify: `apps/web/src/server/usecases/scoring.ts:471-492` (inside `if (auth.via === "device_link") {`)

**Interfaces:**
- Consumes: `createDeviceLink` (T2) in the rig; `LOCKED_FIXTURE_STATUSES` (`@/server/engine-db/append-event`).
- Produces (`@/server/usecases/carried-forward`):
  - `interface CarriedForwardFacts { winnerFeedFilled: boolean; loserFeedFilled: boolean; swissNextRoundSeated: boolean; stageComplete: boolean }`
  - `NOT_CARRIED: CarriedForwardFacts` (all false)
  - `isCarriedForward(f: CarriedForwardFacts): boolean`
  - `SETTLED_OPEN_STATUSES: ReadonlySet<string>` = decided / forfeited / abandoned
  - `carriedForwardFacts(tx: Tx, fixtureId: string): Promise<{ status: string; facts: CarriedForwardFacts } | null>`
  - `resultCarriedForward(tx: Tx, fixtureId: string): Promise<boolean>` — true only for a settled fixture whose facts say carried
  - `RESULT_CARRIED_FORWARD = "RESULT_CARRIED_FORWARD"` (the wire code) and `RESULT_CARRIED_FORWARD_MESSAGE`
- Rig (`__tests__/_sheets-rig.ts`): `seedStage(auth, kind, names, config?)`, `fixturesOf(stageId)`, `deviceFor(owner, fixtureId)`, `decide(actor, fixtureId)`, `voidEvent(actor, fixtureId, eventId)`, `pairNextSwissRound(auth, stageId)`.

- [ ] **Step 1: Pure tests first** — `carried-forward.test.ts`:

```ts
// Scorer sheets §4.3 — THE EMPTY CASE FIRST. A "does any clause hold" rule
// answers no on the empty set and falls to the default; the default here is
// "the umpire may still act", so a predicate that silently answered no forever
// would pass every "contains X" test written after it.
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { LOCKED_FIXTURE_STATUSES } from "@/server/engine-db/append-event";
import { NOT_CARRIED, SETTLED_OPEN_STATUSES, isCarriedForward } from "../carried-forward";

describe("isCarriedForward", () => {
  it("empty case: no feed filled, no later Swiss round, stage open → NOT carried", () => {
    expect(isCarriedForward(NOT_CARRIED)).toBe(false);
  });

  it.each([
    ["winnerFeedFilled"],
    ["loserFeedFilled"],
    ["swissNextRoundSeated"],
    ["stageComplete"],
  ] as const)("%s alone → carried", (clause) => {
    expect(isCarriedForward({ ...NOT_CARRIED, [clause]: true })).toBe(true);
  });
});

describe("SETTLED_OPEN_STATUSES", () => {
  it("is every fixture status that is neither open nor locked — derived from the fixtures CHECK constraint", () => {
    const ddl = readFileSync(
      resolve(import.meta.dirname, "../../../../../../db/migration/v2-engine/tables/V214__fixtures.sql"),
      "utf8",
    );
    const list = ddl.match(/status\s+text[^;]*?check \(status in\s*\(([^)]*)\)/s)?.[1];
    expect(list, "V214's fixtures.status CHECK moved — re-derive").toBeDefined();
    const all = [...list!.matchAll(/'([a-z_]+)'/g)].map((m) => m[1]!);
    const expected = all.filter((s) => s !== "scheduled" && s !== "in_play" && !LOCKED_FIXTURE_STATUSES.has(s));
    expect([...SETTLED_OPEN_STATUSES].sort()).toEqual(expected.sort());
    // The differential: the open statuses are NOT in it, or the refusal would stop live scoring.
    expect(SETTLED_OPEN_STATUSES.has("in_play")).toBe(false);
    expect(SETTLED_OPEN_STATUSES.has("scheduled")).toBe(false);
  });
});
```

Run (vitest JSON command, this path) → FAIL (module missing).

- [ ] **Step 2: Implement** `apps/web/src/server/usecases/carried-forward.ts`:

```ts
import "server-only";
// Scorer sheets §4.3 — has this fixture's result moved the competition on?
// Evaluated LIVE at request time: unpairing the next Swiss round re-opens the
// previous one for the umpire's own undo, and nothing is stored that could go
// stale. Consulted by the device-link scoring path (usecases/scoring.ts) and by
// the scan page to choose its View-only screen — one predicate, two askers.
import type { Tx } from "@/lib/db";

export const RESULT_CARRIED_FORWARD = "RESULT_CARRIED_FORWARD";
export const RESULT_CARRIED_FORWARD_MESSAGE =
  "This result has already moved the competition on — ask the organiser to correct it";

export interface CarriedForwardFacts {
  /** `winner_to_fixture`'s `winner_to_slot` side is occupied. */
  winnerFeedFilled: boolean;
  /** `loser_to_fixture`'s `loser_to_slot` side is occupied. */
  loserFeedFilled: boolean;
  /** Swiss only: some board of round_no + 1 in this stage has a side seated. */
  swissNextRoundSeated: boolean;
  /** `stages.status = 'complete'`. */
  stageComplete: boolean;
}

export const NOT_CARRIED: CarriedForwardFacts = {
  winnerFeedFilled: false,
  loserFeedFilled: false,
  swissNextRoundSeated: false,
  stageComplete: false,
};

export function isCarriedForward(f: CarriedForwardFacts): boolean {
  return f.winnerFeedFilled || f.loserFeedFilled || f.swissNextRoundSeated || f.stageComplete;
}

/** Settled but not locked. Only these can have been carried forward: a
 *  scheduled or in-play fixture whose feed target an organiser filled by hand
 *  is still the umpire's to score (Review Focus 2), and finalized/cancelled
 *  keep their own refusals (append-event.ts LOCKED_FIXTURE_STATUSES). */
export const SETTLED_OPEN_STATUSES: ReadonlySet<string> = new Set(["decided", "forfeited", "abandoned"]);

export async function carriedForwardFacts(
  tx: Tx,
  fixtureId: string,
): Promise<{ status: string; facts: CarriedForwardFacts } | null> {
  const [row] = await tx<
    {
      status: string;
      winner_feed_filled: boolean;
      loser_feed_filled: boolean;
      swiss_next_round_seated: boolean;
      stage_complete: boolean;
    }[]
  >`
    select f.status,
      coalesce((select case f.winner_to_slot when 1 then w.home_entrant_id is not null
                                             when 2 then w.away_entrant_id is not null
                                             else false end
                from fixtures w where w.id = f.winner_to_fixture), false) as winner_feed_filled,
      coalesce((select case f.loser_to_slot when 1 then l.home_entrant_id is not null
                                            when 2 then l.away_entrant_id is not null
                                            else false end
                from fixtures l where l.id = f.loser_to_fixture), false) as loser_feed_filled,
      (s.kind = 'swiss' and exists (
         select 1 from fixtures n
         where n.stage_id = f.stage_id and n.round_no = f.round_no + 1
           and (n.home_entrant_id is not null or n.away_entrant_id is not null)
      )) as swiss_next_round_seated,
      (s.status = 'complete') as stage_complete
    from fixtures f join stages s on s.id = f.stage_id
    where f.id = ${fixtureId}`;
  if (!row) return null;
  return {
    status: row.status,
    facts: {
      winnerFeedFilled: row.winner_feed_filled,
      loserFeedFilled: row.loser_feed_filled,
      swissNextRoundSeated: row.swiss_next_round_seated,
      stageComplete: row.stage_complete,
    },
  };
}

export async function resultCarriedForward(tx: Tx, fixtureId: string): Promise<boolean> {
  const loaded = await carriedForwardFacts(tx, fixtureId);
  return loaded !== null && SETTLED_OPEN_STATUSES.has(loaded.status) && isCarriedForward(loaded.facts);
}
```

Run Step 1 → PASS.

- [ ] **Step 3: The rig** — `apps/web/src/server/usecases/__tests__/_sheets-rig.ts`:

```ts
// Shared DB rig for the scorer-sheet suites (T4 carried-forward, T6 scan page,
// T7/T8 sheets). Real use-cases end to end — never hand-inserted fixtures —
// so feeds, Swiss rounds and stage status are what the product writes.
import { randomBytes, randomUUID } from "node:crypto";
import { sql } from "@/lib/db";
import type { AuthCtx } from "@/server/api-v1/auth";
import { requireFixtureActor } from "@/server/api-v1/auth";
import { createCompetition } from "../competitions";
import { createDivision } from "../divisions";
import { createEntrants } from "../entrants";
import { createStages, generateStageFixtures } from "../stages";
import { startDivision } from "../schedule";
import { scoreEvent } from "../scoring";
import { createDeviceLink } from "../device-links";
import { GENERIC_CONFIG } from "./_seed";

process.env.DEVICE_LINK_KEK ??= randomBytes(32).toString("hex");

export type RigStageKind = "league" | "knockout" | "swiss";

export interface RigFixture {
  id: string;
  round_no: number;
  seq_in_round: number;
  status: string;
  home_entrant_id: string | null;
  away_entrant_id: string | null;
  winner_to_fixture: string | null;
  winner_to_slot: number | null;
}

export async function seedStage(
  auth: AuthCtx,
  kind: RigStageKind,
  names: string[],
  config: Record<string, unknown> = {},
) {
  const competition = await createCompetition(auth, {
    ends_on: "2030-12-31",
    name: `Sheets ${kind} ${randomUUID().slice(0, 6)}`,
    visibility: "private",
    branding: {},
  });
  const division = await createDivision(auth, competition.id, {
    name: "Open",
    sport_key: "generic",
    variant_key: "score",
    config: GENERIC_CONFIG,
  });
  await createEntrants(
    auth,
    division.id,
    names.map((n, i) => ({ kind: "individual" as const, display_name: n, seed: i + 1, members: [] })),
  );
  const [stage] = await createStages(auth, division.id, { seq: 1, kind, name: kind, config });
  await generateStageFixtures(auth, stage!.id);
  await startDivision(auth, division.id);
  return { competition, division, stage: stage! };
}

export async function fixturesOf(stageId: string): Promise<RigFixture[]> {
  return sql<RigFixture[]>`
    select id, round_no, seq_in_round, status, home_entrant_id, away_entrant_id,
           winner_to_fixture, winner_to_slot
    from fixtures where stage_id = ${stageId} order by round_no, seq_in_round`;
}

/** Swiss pairs the next round through the same call the desk's Pair button makes. */
export async function pairNextSwissRound(auth: AuthCtx, stageId: string): Promise<void> {
  await generateStageFixtures(auth, stageId);
}

/** A device-link actor for the fixture, through the real bearer door. */
export async function deviceFor(owner: AuthCtx, fixtureId: string): Promise<AuthCtx> {
  const link = await createDeviceLink(owner, fixtureId, null);
  const req = new Request("http://test.local/api/v1", { headers: { authorization: `Bearer ${link.secret}` } });
  return requireFixtureActor(req, fixtureId, "score");
}

async function tipSeq(fixtureId: string): Promise<number> {
  const [{ seq }] = await sql<{ seq: number }[]>`
    select coalesce(max(seq), 0)::int as seq from score_events where fixture_id = ${fixtureId}`;
  return seq;
}

/** core.start (if needed) + a 2–1 generic result by `actor`; the result event's id. */
export async function decide(actor: AuthCtx, fixtureId: string): Promise<string> {
  let seq = await tipSeq(fixtureId);
  if (seq === 0) {
    await scoreEvent(actor, fixtureId, { expected_seq: 0, type: "core.start", payload: {} });
    seq = 1;
  }
  await scoreEvent(actor, fixtureId, {
    expected_seq: seq,
    type: "generic.result",
    payload: { p1Score: 2, p2Score: 1 },
  });
  const [{ id }] = await sql<{ id: string }[]>`
    select id from score_events where fixture_id = ${fixtureId} and type = 'generic.result'
    order by seq desc limit 1`;
  return id;
}

export async function voidEvent(actor: AuthCtx, fixtureId: string, eventId: string) {
  return scoreEvent(actor, fixtureId, {
    expected_seq: await tipSeq(fixtureId),
    type: "core.void",
    payload: { event_id: eventId },
  });
}
```

Before relying on it, open `apps/web/src/server/usecases/__tests__/swiss-shell-fixtures.test.ts` and confirm (a) the Swiss config key (`rounds`, stages.ts:1007) and (b) whether round 1 is seated by the `generateStageFixtures` BEFORE `startDivision` or needs a second call after it. If the order differs, fix `seedStage` for `kind === "swiss"` here — record which in the task report.

- [ ] **Step 4: Failing DB tests** — `carried-forward-scoring.test.ts`:

```ts
import { afterAll, describe, expect, it } from "vitest";
import { sql } from "@/lib/db";
import { seedOrg } from "./_seed";
import { decide, deviceFor, fixturesOf, pairNextSwissRound, seedStage, voidEvent } from "./_sheets-rig";
import { unpairSwissRound } from "../stages";
import { scoreEvent } from "../scoring";

const HAS_DB = !!process.env.DATABASE_URL;

afterAll(async () => {
  if (!HAS_DB) return;
  const g = globalThis as { _sql?: { end(): Promise<void> } };
  const client = g._sql;
  g._sql = undefined;
  await client?.end();
});

const CARRIED = { status: 403, code: "RESULT_CARRIED_FORWARD" };

describe.skipIf(!HAS_DB)("device-link refusal once a result is carried forward (scorer sheets §4.3)", () => {
  it("empty case: a decided league fixture (no feeds, stage open) — the umpire may void their own result", async () => {
    const { auth } = await seedOrg("pro");
    const { stage } = await seedStage(auth, "league", ["A", "B", "C", "D"]);
    const [f] = await fixturesOf(stage.id);
    const device = await deviceFor(auth, f!.id);
    const own = await decide(device, f!.id);
    await expect(voidEvent(device, f!.id, own)).resolves.toBeDefined();
  });

  it("knockout: the SF is carried the instant it is decided (P5) — device void 403, organiser void passes", async () => {
    const { auth } = await seedOrg("pro");
    const { stage } = await seedStage(auth, "knockout", ["A", "B", "C", "D"]);
    const sf1 = (await fixturesOf(stage.id)).find((x) => x.round_no === 1 && x.seq_in_round === 1)!;
    const device = await deviceFor(auth, sf1.id);
    const own = await decide(device, sf1.id);
    const [target] = await sql<{ home_entrant_id: string | null; away_entrant_id: string | null }[]>`
      select home_entrant_id, away_entrant_id from fixtures where id = ${sf1.winner_to_fixture}`;
    expect(sf1.winner_to_slot === 1 ? target!.home_entrant_id : target!.away_entrant_id).not.toBeNull();
    await expect(voidEvent(device, sf1.id, own)).rejects.toMatchObject(CARRIED);
    // The organiser's session is unaffected (§4.3 last paragraph).
    await expect(voidEvent(auth, sf1.id, own)).resolves.toBeDefined();
  });

  it("loser feed: carried only once the loser's TARGET side is occupied — slot mapping witnessed both ways", async () => {
    const { auth } = await seedOrg("pro");
    const { stage } = await seedStage(auth, "league", ["A", "B", "C", "D"]);
    const [f, target] = await fixturesOf(stage.id);
    await sql`update fixtures set away_entrant_id = null where id = ${target!.id}`;
    await sql`update fixtures set loser_to_fixture = ${target!.id}, loser_to_slot = 2 where id = ${f!.id}`;
    const device = await deviceFor(auth, f!.id);
    const own = await decide(device, f!.id);
    // Target away side empty → not carried: the void passes, then re-decide.
    await expect(voidEvent(device, f!.id, own)).resolves.toBeDefined();
    const again = await decide(device, f!.id);
    await sql`update fixtures set away_entrant_id = ${target!.home_entrant_id} where id = ${target!.id}`;
    await expect(voidEvent(device, f!.id, again)).rejects.toMatchObject(CARRIED);
  });

  it("swiss: round N is carried while round N+1 is seated, and re-opens when it is unpaired", async () => {
    const { auth } = await seedOrg("pro");
    const { stage } = await seedStage(auth, "swiss", ["A", "B", "C", "D"], { rounds: 2 });
    const r1 = (await fixturesOf(stage.id)).filter((x) => x.round_no === 1 && x.home_entrant_id && x.away_entrant_id);
    expect(r1.length).toBe(2);
    const device = await deviceFor(auth, r1[0]!.id);
    const own = await decide(device, r1[0]!.id);
    await decide(auth, r1[1]!.id);
    await pairNextSwissRound(auth, stage.id);
    await expect(voidEvent(device, r1[0]!.id, own)).rejects.toMatchObject(CARRIED);
    await unpairSwissRound(auth, stage.id);
    await expect(voidEvent(device, r1[0]!.id, own)).resolves.toBeDefined();
  });

  it("stage complete: carried; stage re-opened: not carried", async () => {
    const { auth } = await seedOrg("pro");
    const { stage } = await seedStage(auth, "league", ["A", "B", "C", "D"]);
    const [f] = await fixturesOf(stage.id);
    const device = await deviceFor(auth, f!.id);
    const own = await decide(device, f!.id);
    await sql`update stages set status = 'complete' where id = ${stage.id}`;
    await expect(voidEvent(device, f!.id, own)).rejects.toMatchObject(CARRIED);
    await sql`update stages set status = 'active' where id = ${stage.id}`;
    await expect(voidEvent(device, f!.id, own)).resolves.toBeDefined();
  });

  it("a SCHEDULED fixture whose feed an organiser filled by hand still scores (Review Focus 2)", async () => {
    const { auth } = await seedOrg("pro");
    const { stage } = await seedStage(auth, "knockout", ["A", "B", "C", "D"]);
    const sf2 = (await fixturesOf(stage.id)).find((x) => x.round_no === 1 && x.seq_in_round === 2)!;
    const [anyEntrant] = await sql<{ id: string }[]>`
      select home_entrant_id as id from fixtures where id = ${sf2.id}`;
    const column = sf2.winner_to_slot === 1 ? sql`home_entrant_id` : sql`away_entrant_id`;
    await sql`update fixtures set ${column} = ${anyEntrant!.id} where id = ${sf2.winner_to_fixture}`;
    const device = await deviceFor(auth, sf2.id);
    await expect(
      scoreEvent(device, sf2.id, { expected_seq: 0, type: "core.start", payload: {} }),
    ).resolves.toBeDefined();
  });
});
```

Run → the knockout/loser/swiss/stage cases FAIL (the voids pass today).

- [ ] **Step 5: Implement the refusal** in `scoring.ts`. Add imports:

```ts
import {
  RESULT_CARRIED_FORWARD,
  RESULT_CARRIED_FORWARD_MESSAGE,
  SETTLED_OPEN_STATUSES,
  resultCarriedForward,
} from "./carried-forward";
```

and inside `if (auth.via === "device_link") {`, directly after the `core.finalize` throw:

```ts
    // Scorer sheets §4.3: once a settled result has moved the competition on —
    // a feed seated, the next Swiss round seated, the stage complete — a
    // device link may do nothing more with this fixture; corrections are the
    // organiser's. Evaluated LIVE (unpairing re-opens it), and only for a
    // settled fixture, so a live tap never pays for the query.
    if (SETTLED_OPEN_STATUSES.has(ctx.fixture_status)) {
      const carried = await withTenant(auth.orgId, (tx) => resultCarriedForward(tx, fixtureId));
      if (carried) throw new HttpError(403, RESULT_CARRIED_FORWARD_MESSAGE, RESULT_CARRIED_FORWARD);
    }
```

Known, accepted window: this check runs before `appendEvent`'s fixture lock, so a Swiss pairing committing in the same millisecond can let one void through. The organiser can re-pair; say so in the task report.

- [ ] **Step 6: Run** Steps 1+4 files plus the existing `device-links.test.ts` (its league device void must still pass) → all green, `pending == 0`.

- [ ] **Step 7: Mutation check** (per clause, per surface — RULES):
  - `isCarriedForward` → `return true` → killed by "empty case … may void".
  - `isCarriedForward` → `return false` → killed by the knockout case.
  - delete `winnerFeedFilled ||` → knockout case.
  - delete `loserFeedFilled ||` → loser-feed case (second assertion).
  - swap `when 1`/`when 2` in the loser CASE → loser-feed case (first assertion: the away side is empty, so a home-side read says "filled").
  - delete `swissNextRoundSeated ||` → Swiss case (first assertion).
  - `n.round_no = f.round_no + 1` → `>= f.round_no` → Swiss case (the board's own round is seated, so the unpair assertion reds).
  - delete `stageComplete` → stage case.
  - delete the `SETTLED_OPEN_STATUSES.has(...)` gate in scoring.ts (check every status) → killed by "a SCHEDULED fixture whose feed … still scores".
  - move the check outside the `auth.via === "device_link"` block → killed by the knockout case's organiser-void assertion.
  Report which test killed each.

- [ ] **Step 8: Commit** — `git add` the five paths; message `feat(scoring): refuse device-link writes once a result is carried forward`.

E2E owed: Task 5's `device-pad-carried-forward.spec.ts` drives this refusal from a real inner-pad tap; Task 10's journey drives it after a real Swiss pairing.

---

### Task 5: The seam — refusal → pipeline → registry callback → View-only chrome

**Files:**
- Modify: `apps/web/src/components/v2/scorepad/transport.ts` (after `TERMINAL_CONFLICT_CODES`, ~:250)
- Modify: `apps/web/src/components/v2/scorepad/__tests__/transport.test.ts` (append)
- Modify: `apps/web/src/components/v2/scorepad/refusal-copy.ts:55-66`
- Modify: `apps/web/src/components/v2/scorepad/v3/pad-host.tsx` (`PadHostV3Props` ~:1506; effect after :1577)
- Modify: `apps/web/src/components/v2/scorepad/registry.tsx:193-218, :299`
- Create: `apps/web/src/lib/scan-screen.ts` (view-only reasons + copy; T6 extends it)
- Modify: `apps/web/src/components/v2/device-score-pad.tsx` (Props, state, `send` catch :236, render :449/:487)
- Create: `apps/web/src/components/v2/__tests__/device-score-pad-view-only.test.tsx`
- Create: `apps/web/e2e/walkthrough/device-pad-carried-forward.spec.ts`
- Modify: `apps/web/src/lib/__tests__/e2e-ci-wiring.test.ts` (`WALKTHROUGH_SPECS`)
- Modify: 4 × `ui.json`, regenerate `i18n-keys.ts`

**Interfaces:**
- Consumes: wire code `RESULT_CARRIED_FORWARD` (T4) — as a string literal on the client (client code must not import `server-only` modules).
- Produces:
  - `CHROME_TERMINAL_CODES: ReadonlySet<string>`, `terminalRefusalOf(r: { code: string; message: string } | null): { code: string; message: string } | null` (transport.ts)
  - `PadHostV3Props.onTerminalRefusal?: (rejection: RejectionInfo) => void`; `ScorePadProps.onTerminalRefusal?` (same type), forwarded
  - `lib/scan-screen.ts`: `type ViewOnlyReason = "carried_forward" | "finalized" | "cancelled" | "no_opponent"`; `VIEW_ONLY_COPY: Record<ViewOnlyReason, MessageKey>`
  - `DeviceScorePad` props `initialViewOnly?: ViewOnlyReason | null`; test id `scan-view-only`

- [ ] **Step 1: Failing unit tests.** Append to `transport.test.ts`:

```ts
import { CHROME_TERMINAL_CODES, terminalRefusalOf } from "../transport";

describe("CHROME_TERMINAL_CODES (scorer sheets §4.5)", () => {
  it("a carried-forward refusal is terminal for the chrome; an ordinary refusal is not", () => {
    expect(terminalRefusalOf({ code: "RESULT_CARRIED_FORWARD", message: "m" })).toEqual({
      code: "RESULT_CARRIED_FORWARD",
      message: "m",
    });
    expect(terminalRefusalOf({ code: "FORBIDDEN", message: "m" })).toBeNull();
    expect(terminalRefusalOf(null)).toBeNull();
  });

  it("every chrome-terminal code is one scoring.ts can actually send", () => {
    const src = readFileSync(join(process.cwd(), "src/server/usecases/carried-forward.ts"), "utf8");
    for (const code of CHROME_TERMINAL_CODES) expect(src).toContain(`"${code}"`);
  });

  it("the transport hands the code through: a 403 envelope → rejected carrying RESULT_CARRIED_FORWARD (P4 pin)", async () => {
    const t = deviceLinkTransport("dl_x", {
      fetchFn: async () =>
        new Response(JSON.stringify({ ok: false, error: { code: "RESULT_CARRIED_FORWARD", message: "over" } }), {
          status: 403,
          headers: { "content-type": "application/json" },
        }),
    });
    const r = await t.appendEvent("f1", { expected_seq: 3, type: "core.void", payload: {}, idempotency_key: "k" } as never);
    expect(r).toMatchObject({ kind: "rejected", code: "RESULT_CARRIED_FORWARD" });
  });
});
```
(`deviceLinkTransport` is the exported factory at transport.ts:404-405 — confirm its name there; reuse whatever envelope helper the file's existing 403 tests use if `fromOurApi` needs a specific header.)

Create `device-score-pad-view-only.test.tsx`:

```tsx
// Scorer sheets §4.5 — the chrome's two ways into View-only. The INNER pad's
// way (pipeline → registry → this callback) is only proven end to end by
// e2e/walkthrough/device-pad-carried-forward.spec.ts; this file pins the
// chrome's half: the prop it hands down, and its own send() path.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ReactElement } from "react";
import { DeviceScorePad, type PadEventIn } from "@/components/v2/device-score-pad";
import { ScorePad } from "@/components/v2/scorepad/registry";
import type { SideInfo, SportInfo } from "@/components/v2/fixture-console";
import { propsOf, renderIsland } from "@/components/__tests__/_hook-harness";

const DEVICE_LINK_ID = "dl-1";
const OWN: PadEventIn = {
  id: "ev-own",
  seq: 2,
  type: "generic.result",
  payload: { p1Score: 2, p2Score: 1 },
  recorded_at: "2026-09-23T10:00:00.000Z",
  voids_event_id: null,
  device_link_id: DEVICE_LINK_ID,
};

const api = vi.hoisted(() => ({ postRefusal: null as null | { code: string; status: number } }));
vi.mock("@/lib/client-v1", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/client-v1")>();
  return {
    ...actual,
    apiV1: vi.fn((url: string, options?: { method?: string }) => {
      if (options?.method === "POST") {
        return api.postRefusal
          ? Promise.reject(new actual.ApiV1Error("over", api.postRefusal.status, api.postRefusal.code))
          : Promise.resolve({});
      }
      if (url.includes("/events")) return Promise.resolve([OWN]);
      return Promise.resolve({ status: "decided", last_seq: 2, summary: null, state: {}, outcome: { kind: "win" } });
    }),
  };
});

const sport: SportInfo = {
  key: "generic", config: {}, scorerLabel: "Umpire", positionGroups: [], roles: [], lineupSize: 1, benchMax: 0,
};
const side = (id: string, name: string): SideInfo => ({ id, name, members: [], lineup: [] });

function props(status: string, outcome: unknown) {
  return {
    token: "dl_test",
    deviceLinkId: DEVICE_LINK_ID,
    fixture: { id: "f1", round_no: 1, venue: null, court_label: "Court 2", competition_name: "Cup", division_name: "Open" },
    sport,
    home: side("h", "Nia"),
    away: side("a", "Mira"),
    initialState: { status, last_seq: 2, summary: null, state: {}, outcome },
    initialEvents: [OWN],
    scorePadV2: {
      moduleVersion: "1.0.0", resolvedConfig: {}, initialEvents: [], entitlements: {}, band: 0 as const,
      identity: { recordedBy: null, deviceLinkId: DEVICE_LINK_ID },
    },
  };
}

const byTestId = (tree: ReactElement[], id: string) => tree.find((e) => propsOf(e)["data-testid"] === id);
const flush = async () => { for (let i = 0; i < 5; i++) await new Promise((r) => setImmediate(r)); };

beforeEach(() => { api.postRefusal = null; });
afterEach(() => { vi.unstubAllGlobals(); });

describe("DeviceScorePad — View-only (scorer sheets §4.5)", () => {
  it("the chrome's own 'Void my last entry' refused RESULT_CARRIED_FORWARD → View-only, controls gone", async () => {
    api.postRefusal = { code: "RESULT_CARRIED_FORWARD", status: 403 };
    const island = renderIsland(DeviceScorePad, props("decided", { kind: "win" }));
    const voidBtn = byTestId(island.tree(), "device-void-mine");
    expect(voidBtn, "precondition: the link's own result offers its undo").toBeDefined();
    (propsOf(voidBtn!).onClick as () => void)();
    await flush();
    expect(byTestId(island.tree(), "scan-view-only")).toBeDefined();
    expect(byTestId(island.tree(), "device-void-mine")).toBeUndefined();
  });

  it("an ordinary refusal does NOT switch screens (the negative pair)", async () => {
    api.postRefusal = { code: "FORBIDDEN", status: 403 };
    const island = renderIsland(DeviceScorePad, props("decided", { kind: "win" }));
    (propsOf(byTestId(island.tree(), "device-void-mine")!).onClick as () => void)();
    await flush();
    expect(byTestId(island.tree(), "scan-view-only")).toBeUndefined();
  });

  it("hands the inner pad an onTerminalRefusal that switches to View-only and unmounts the pad", () => {
    const island = renderIsland(DeviceScorePad, props("in_play", null));
    const pad = island.tree().find((e) => e.type === ScorePad);
    expect(pad, "precondition: the inner pad is mounted in play").toBeDefined();
    const cb = propsOf(pad!).onTerminalRefusal as ((r: { code: string; message: string }) => void) | undefined;
    expect(cb, "the seam: DeviceScorePad must hand the pad this callback").toBeTypeOf("function");
    cb!({ code: "RESULT_CARRIED_FORWARD", message: "" });
    expect(byTestId(island.tree(), "scan-view-only")).toBeDefined();
    expect(island.tree().find((e) => e.type === ScorePad)).toBeUndefined();
  });

  it("initialViewOnly renders View-only from the first paint", () => {
    const island = renderIsland(DeviceScorePad, { ...props("finalized", { kind: "win" }), initialViewOnly: "finalized" as const });
    expect(byTestId(island.tree(), "scan-view-only")).toBeDefined();
  });
});
```

Run both files → FAIL.

- [ ] **Step 2: Implement transport + copy.** In `transport.ts` after `TERMINAL_CONFLICT_CODES`:

```ts
/**
 * Scorer sheets §4.5 — refusals that end what THIS SURFACE may do on the
 * fixture, not only this one write. The transport already classifies them as
 * `rejected` with their code (a 403 carrying our envelope, below); the
 * pipeline drops the write like any rejection. What these add is a signal to
 * the CHROME around the pad (`onTerminalRefusal`), which must change screens.
 * Each member is pinned against the server source that sends it.
 */
export const CHROME_TERMINAL_CODES: ReadonlySet<string> = new Set(["RESULT_CARRIED_FORWARD"]);

export function terminalRefusalOf(
  rejection: { code: string; message: string } | null,
): { code: string; message: string } | null {
  return rejection !== null && CHROME_TERMINAL_CODES.has(rejection.code) ? rejection : null;
}
```

`refusal-copy.ts` `REFUSAL_KEY`: add `RESULT_CARRIED_FORWARD: "scorepad.refusal.carriedForward",`.

Create `apps/web/src/lib/scan-screen.ts`:

```ts
// Scorer sheets §4.5 — what the scan page shows. Client-safe (no server imports).
import type { MessageKey } from "@/lib/messages";

export type ViewOnlyReason = "carried_forward" | "finalized" | "cancelled" | "no_opponent";

export const VIEW_ONLY_COPY: Readonly<Record<ViewOnlyReason, MessageKey>> = {
  carried_forward: "device.scan.viewOnly.carried",
  finalized: "device.scan.viewOnly.finalized",
  cancelled: "device.scan.viewOnly.cancelled",
  no_opponent: "device.scan.viewOnly.noOpponent",
};
```

- [ ] **Step 3: Implement the host + registry.** `pad-host.tsx` — import `terminalRefusalOf` from `../transport` and `type RejectionInfo` from `../use-pad-pipeline`; add to `PadHostV3Props` after `onEvents`:

```ts
  /** Scorer sheets §4.5 — fired when the pipeline's latest refusal is one that
   *  ends this surface's rights on the fixture (`CHROME_TERMINAL_CODES`), so the
   *  chrome can leave the pad. The pad still shows its own refusal banner. */
  onTerminalRefusal?: (rejection: RejectionInfo) => void;
```
and after the `onEvents` effect (:1574-1577):

```ts
  useEffect(() => {
    const terminal = terminalRefusalOf(pipeline.lastRejection);
    if (terminal) props.onTerminalRefusal?.(terminal);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pipeline.lastRejection]);
```
`registry.tsx` — `ScorePadProps` gains the same optional prop (import `type RejectionInfo` from `./use-pad-pipeline`) and the `<PadHostV3 …>` element gains `onTerminalRefusal={props.onTerminalRefusal}` beside `onEvents`.

- [ ] **Step 4: Implement the chrome** in `device-score-pad.tsx`:
  - Props: `initialViewOnly?: ViewOnlyReason | null;` (import `type ViewOnlyReason, VIEW_ONLY_COPY` from `@/lib/scan-screen`).
  - State next to `dead`: `const [viewOnly, setViewOnly] = useState<ViewOnlyReason | null>(initialViewOnly ?? null);` and `const onTerminalRefusal = useCallback(() => setViewOnly("carried_forward"), []);` — both ABOVE the `if (dead)` return (Rules of Hooks).
  - In `send()`'s catch (:236), before the `SEQ_CONFLICT` branch:
    ```ts
        } else if (err instanceof ApiV1Error && err.code === "RESULT_CARRIED_FORWARD") {
          setViewOnly("carried_forward");
    ```
  - Render: `const canAct = viewOnly === null;` Gate the start/undo row (:449) and the inner pad section (:487) with `canAct &&`. Pass `onTerminalRefusal={onTerminalRefusal}` to `<ScorePad …>`. Replace the `decided && scoring` "result recorded" paragraph's condition with `canAct && decided && scoring`, and add after the header:
    ```tsx
      {viewOnly !== null && (
        <p
          data-testid="scan-view-only"
          role="status"
          className="rounded-md border border-slate-700 bg-slate-900 px-3 py-3 text-center text-sm text-slate-200"
        >
          {msg(VIEW_ONLY_COPY[viewOnly])}
        </p>
      )}
    ```
  The header (final scoreboard) stays — "final scoreboard, no controls" (§4.5.3).

- [ ] **Step 5: Strings** (4 dictionaries, then `pnpm run i18n:gen-keys && pnpm run i18n:check`):

| key | en | fr | es | nl |
|---|---|---|---|---|
| `scorepad.refusal.carriedForward` | Not recorded — this result has already moved the competition on. Ask the organiser to correct it. | Non enregistré — ce résultat a déjà fait avancer la compétition. Demandez à l'organisateur de le corriger. | No registrado: este resultado ya ha hecho avanzar la competición. Pide al organizador que lo corrija. | Niet vastgelegd — deze uitslag heeft de competitie al verder gezet. Vraag de organisator om het te corrigeren. |
| `device.scan.viewOnly.carried` | Match over — result carried forward. Ask the organiser to correct it. | Match terminé — résultat reporté. Demandez à l'organisateur de le corriger. | Partido terminado: resultado trasladado. Pide al organizador que lo corrija. | Wedstrijd voorbij — uitslag doorgezet. Vraag de organisator om het te corrigeren. |
| `device.scan.viewOnly.finalized` | Match over — result finalised. Ask the organiser to correct it. | Match terminé — résultat validé. Demandez à l'organisateur de le corriger. | Partido terminado: resultado cerrado. Pide al organizador que lo corrija. | Wedstrijd voorbij — uitslag definitief. Vraag de organisator om het te corrigeren. |
| `device.scan.viewOnly.cancelled` | This match was cancelled. | Ce match a été annulé. | Este partido se ha cancelado. | Deze wedstrijd is geannuleerd. |
| `device.scan.viewOnly.noOpponent` | There is no match to score here — one side has no opponent. | Il n'y a pas de match à noter ici — un côté n'a pas d'adversaire. | Aquí no hay partido que puntuar: un lado no tiene rival. | Hier valt geen wedstrijd te scoren — één kant heeft geen tegenstander. |

- [ ] **Step 6: Run** transport + view-only tests → PASS; also re-run `device-score-pad-freshness-floor.test.tsx` and `registry.test.tsx` unchanged → PASS.

- [ ] **Step 7: The real seam, in a browser** — `apps/web/e2e/walkthrough/device-pad-carried-forward.spec.ts`. Copy the locator helpers `devicePad`, `scorebug`, `half`, `halfScore`, `padRefusal` and the constants `MOUNT_MS`, `CONVERGE_MS`, `SEND_MS`, `BUDGET_MS` VERBATIM from `e2e/walkthrough/device-pad-foreign-void.spec.ts` (:33-80), then:

```ts
import { test, expect, type APIRequestContext } from "@playwright/test";
import { apiJson, seedRosteredFixture, setFixtureStatusSql, setStageStatusSql, TAG } from "../helpers";
import { consentedAnonymousState } from "../scorepad-a11y-kit";
// …helpers copied from device-pad-foreign-void.spec.ts…

async function ledgerTypes(request: APIRequestContext, fixtureId: string): Promise<string[]> {
  const res = await apiJson<{ type: string }[]>(request, `/api/v1/fixtures/${fixtureId}/events?since_seq=0`);
  return (res.data ?? []).map((e) => e.type);
}

test("a real inner-pad tap refused RESULT_CARRIED_FORWARD moves the device to View-only", async ({ page, browser }) => {
  test.setTimeout(BUDGET_MS);
  const fx = await seedRosteredFixture(page.request, {
    label: `Carried ${TAG}`,
    sportKey: "badminton",
    variantKey: "bwf",
    entrantKind: "individual",
    home: [{ fullName: `CF Home ${TAG}` }],
    away: [{ fullName: `CF Away ${TAG}` }],
    emitCoreStart: true,
  });
  const fixture = await apiJson<{ stage_id: string }>(page.request, `/api/v1/fixtures/${fx.fixtureId}`);
  const minted = await apiJson<{ secret: string }>(page.request, `/api/v1/fixtures/${fx.fixtureId}/device-links`, "POST", {});
  expect([200, 201]).toContain(minted.status);

  const deviceCtx = await browser.newContext({ storageState: await consentedAnonymousState() });
  try {
    const device = await deviceCtx.newPage();
    await device.goto(`/score/${minted.data!.secret}`);
    await expect(devicePad(device)).toBeVisible({ timeout: MOUNT_MS });

    // Positive pair FIRST: while the stage is open a tap lands.
    await half(device, "home").click();
    await expect.poll(async () => (await ledgerTypes(page.request, fx.fixtureId)).filter((t) => t === "badminton.rally").length, {
      timeout: SEND_MS, message: "the positive pair: an in-play tap must land",
    }).toBe(1);

    // The competition moves on underneath the courtside pad. SQL, so NO ledger
    // event and NO push: the inner pad stays mounted and live, exactly the
    // stale courtside screen the refusal exists for.
    await setFixtureStatusSql(fx.fixtureId, "decided");
    await setStageStatusSql(fixture.data!.stage_id, "complete");

    // A REAL tap on the INNER pad (not the chrome's button, not a stubbed callback).
    await half(device, "home").click();
    await expect(device.getByTestId("scan-view-only"), "the refusal must reach the chrome").toBeVisible({ timeout: SEND_MS });
    await expect(devicePad(device), "View-only leaves no pad to tap").toHaveCount(0);
    expect(
      (await ledgerTypes(page.request, fx.fixtureId)).filter((t) => t === "badminton.rally").length,
      "and nothing was written",
    ).toBe(1);
  } finally {
    await deviceCtx.close();
  }
});
```
Confirm `setFixtureStatusSql` / `setStageStatusSql` signatures at `e2e/helpers.ts:889` / `:976`. Register in `WALKTHROUGH_SPECS` after `"device-pad-foreign-void.spec.ts",`:

```ts
  // Scorer sheets §4.5 — the carried-forward seam, driven from its real
  // producer (a courtside INNER-pad tap) to its real consumer (the chrome's
  // View-only screen). No unit test can see the pipeline → registry → chrome hop.
  "device-pad-carried-forward.spec.ts",
```

Run: `$S rebuild --label sheets && eval "$($S env --label sheets)"`, then the whole file with the Playwright command (Global Constraints), and `e2e-ci-wiring.test.ts` via vitest JSON.

- [ ] **Step 8: Mutation check**
  - `CHROME_TERMINAL_CODES` emptied → killed by the transport unit test AND the e2e (run the e2e too: it is the only killer of the host-effect mutants below).
  - delete the pad-host `onTerminalRefusal` effect → killed ONLY by `device-pad-carried-forward.spec.ts` (expected: the pad shows its refusal banner, the chrome never switches). Run it and record the red.
  - registry drops the `onTerminalRefusal={…}` forward → same e2e.
  - DeviceScorePad stops passing `onTerminalRefusal` → killed by "hands the inner pad an onTerminalRefusal".
  - `send()` catch branch removed → killed by "the chrome's own 'Void my last entry' refused …".
  - `canAct &&` removed from the pad section → killed by "…switches to View-only and unmounts the pad".

- [ ] **Step 9: Commit** — `git add` every path in **Files** plus `apps/web/src/lib/i18n-keys.ts`; message `feat(device-pad): a carried-forward refusal moves the courtside pad to View-only`.

---

### Task 6: Scan screens — Confirm, Waiting, View-only, localised Dead link

**Files:**
- Modify: `apps/web/src/lib/scan-screen.ts` (add `scanScreen`, `deadLinkKey`, `fixtureTimeLabel`)
- Create: `apps/web/src/lib/__tests__/scan-screen.test.ts`
- Create: `apps/web/src/components/v2/use-tab-return.ts`
- Create: `apps/web/src/components/v2/scan-waiting.tsx`
- Create: `apps/web/src/components/v2/__tests__/scan-waiting.test.tsx`
- Modify: `apps/web/src/components/v2/scorepad/use-fixture-stream.ts:21` (`export const POLL_MS`)
- Modify: `apps/web/src/components/v2/device-score-pad.tsx` (G1 effect :295-311 → `useTabReturn`; Confirm card; seeded mount; `PadEventIn.recorded_by`; dead copy by code)
- Modify: `apps/web/src/components/v2/__tests__/device-score-pad-view-only.test.tsx` (Confirm cases)
- Modify: `apps/web/src/app/score/[token]/page.tsx` (whole data section + render)
- Modify: `apps/web/src/app/score/[token]/__tests__/page.test.tsx` (append)
- Modify: `apps/web/e2e/device-links.spec.ts` (the "reaches its own inner pad faster than the poll" test, ~:560-660)
- Modify: 4 × `ui.json`, regenerate `i18n-keys.ts`

**Interfaces:**
- Consumes: `resultCarriedForward` (T4), `ViewOnlyReason`/`VIEW_ONLY_COPY` (T5), `resolveSlotLabel`/`matchRef` (`@/lib/slot-label`), `resolveVenueTz` (`@/lib/tz`), `intlLocaleFor` (`@/lib/public-date-locale`), `msgFor` (`@/lib/messages-i18n`), `resolveLocale` (`@/lib/resolve-locale`), `eventOutToEnvelope` (`@/components/v2/scorepad/wire`).
- Produces:
  - `type ScanScreen = { screen: "view_only"; reason: ViewOnlyReason } | { screen: "waiting" } | { screen: "confirm" } | { screen: "pad" }`
  - `scanScreen(i: { status: string; homeKnown: boolean; awayKnown: boolean; carriedForward: boolean }): ScanScreen`
  - `deadLinkKey(code: string | null): MessageKey`
  - `fixtureTimeLabel(iso: string | null, tz: string, intlLocale: string): string | null`
  - `useTabReturn(onReturn: () => void, enabled: boolean): void`
  - `ScanWaiting({ home, away, meta, pollMs? }: { home: string; away: string; meta: string; pollMs?: number })`
  - `export const POLL_MS = 15_000` (use-fixture-stream.ts)
  - DeviceScorePad `fixture.match_ref?: string | null`, `fixture.scheduled_label?: string | null`; `PadEventIn.recorded_by?: string | null`; test id `scan-confirm`

- [ ] **Step 1: Failing table test** `apps/web/src/lib/__tests__/scan-screen.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { deadLinkKey, fixtureTimeLabel, scanScreen } from "../scan-screen";

const ddl = readFileSync(resolve(import.meta.dirname, "../../../../../db/migration/v2-engine/tables/V214__fixtures.sql"), "utf8");
const STATUSES = [...ddl.match(/status\s+text[^;]*?check \(status in\s*\(([^)]*)\)/s)![1]!.matchAll(/'([a-z_]+)'/g)].map((m) => m[1]!);

describe("scanScreen (scorer sheets §4.5)", () => {
  it("the everyday case first: scheduled, both sides known, not carried → Confirm (never the pad)", () => {
    expect(scanScreen({ status: "scheduled", homeKnown: true, awayKnown: true, carriedForward: false })).toEqual({ screen: "confirm" });
  });

  it("in_play skips Confirm straight to the pad", () => {
    expect(scanScreen({ status: "in_play", homeKnown: true, awayKnown: true, carriedForward: false })).toEqual({ screen: "pad" });
  });

  it("a TBD side while scheduled → Waiting, whichever side", () => {
    for (const [h, a] of [[false, true], [true, false], [false, false]] as const) {
      expect(scanScreen({ status: "scheduled", homeKnown: h, awayKnown: a, carriedForward: false })).toEqual({ screen: "waiting" });
    }
  });

  it("finalized / cancelled / carried → View-only with their own reason, even with a TBD side", () => {
    expect(scanScreen({ status: "finalized", homeKnown: true, awayKnown: true, carriedForward: false })).toEqual({ screen: "view_only", reason: "finalized" });
    expect(scanScreen({ status: "cancelled", homeKnown: false, awayKnown: true, carriedForward: false })).toEqual({ screen: "view_only", reason: "cancelled" });
    expect(scanScreen({ status: "decided", homeKnown: true, awayKnown: true, carriedForward: true })).toEqual({ screen: "view_only", reason: "carried_forward" });
  });

  it("a settled one-sided fixture (a bye) is 'no opponent' — never Waiting forever (Review Focus 5)", () => {
    expect(scanScreen({ status: "forfeited", homeKnown: true, awayKnown: false, carriedForward: false })).toEqual({ screen: "view_only", reason: "no_opponent" });
  });

  it("decided but not carried → the pad (the umpire's own undo window)", () => {
    expect(scanScreen({ status: "decided", homeKnown: true, awayKnown: true, carriedForward: false })).toEqual({ screen: "pad" });
  });

  it("every fixture status in the schema has an answer for both sides known and not carried", () => {
    for (const status of STATUSES) {
      expect(scanScreen({ status, homeKnown: true, awayKnown: true, carriedForward: false }).screen).toMatch(/^(confirm|pad|view_only)$/);
    }
  });
});

describe("deadLinkKey", () => {
  it("maps each resolver code to its own copy; anything else is 'invalid'", () => {
    expect(deadLinkKey("LINK_REVOKED")).toBe("device.dead.revoked");
    expect(deadLinkKey("LINK_EXPIRED")).toBe("device.dead.expired");
    expect(deadLinkKey("LINK_INVALID")).toBe("device.dead.invalid");
    expect(deadLinkKey(null)).toBe("device.dead.invalid");
  });
});

describe("fixtureTimeLabel", () => {
  it("renders in the VENUE tz, not UTC — 23:30 Auckland is the previous UTC day", () => {
    const label = fixtureTimeLabel("2026-09-23T10:30:00Z", "Pacific/Auckland", "en-GB");
    expect(label).toContain("22:30");
    expect(fixtureTimeLabel(null, "UTC", "en-GB")).toBeNull();
  });
});
```

Run → FAIL.

- [ ] **Step 2: Implement** — append to `lib/scan-screen.ts`:

```ts
export type ScanScreen =
  | { screen: "view_only"; reason: ViewOnlyReason }
  | { screen: "waiting" }
  | { screen: "confirm" }
  | { screen: "pad" };

export interface ScanInput {
  status: string;
  homeKnown: boolean;
  awayKnown: boolean;
  /** `resultCarriedForward` — already false for anything not settled. */
  carriedForward: boolean;
}

/** One table, read top to bottom. Terminal states outrank everything; a TBD
 *  side waits only while the fixture is still to be played. */
export function scanScreen(i: ScanInput): ScanScreen {
  if (i.status === "finalized") return { screen: "view_only", reason: "finalized" };
  if (i.status === "cancelled") return { screen: "view_only", reason: "cancelled" };
  if (i.carriedForward) return { screen: "view_only", reason: "carried_forward" };
  if (!i.homeKnown || !i.awayKnown) {
    return i.status === "scheduled" ? { screen: "waiting" } : { screen: "view_only", reason: "no_opponent" };
  }
  if (i.status === "scheduled") return { screen: "confirm" };
  return { screen: "pad" };
}

const DEAD_KEY: Readonly<Record<string, MessageKey>> = {
  LINK_REVOKED: "device.dead.revoked",
  LINK_EXPIRED: "device.dead.expired",
};

/** The resolver's codes → copy. The resolver's own messages are English and
 *  never reach a screen (P12). */
export function deadLinkKey(code: string | null): MessageKey {
  return (code !== null && DEAD_KEY[code]) || "device.dead.invalid";
}

/** "Wed 23 Sep, 22:30" in the fixture's venue tz. */
export function fixtureTimeLabel(iso: string | null, tz: string, intlLocale: string): string | null {
  if (!iso) return null;
  return new Intl.DateTimeFormat(intlLocale, {
    timeZone: tz,
    weekday: "short",
    day: "numeric",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(iso));
}
```
Run Step 1 → PASS.

- [ ] **Step 3: Extract G1 verbatim.** Create `apps/web/src/components/v2/use-tab-return.ts` holding the effect from device-score-pad.tsx:295-311 — MOVE its comment block with it (the "Deliberately not an interval", "BOTH events", "visibilityState guard", SSR-guard paragraphs):

```ts
"use client";
import { useEffect } from "react";

/** G1 (#848) — refresh when a human comes back to the tab. Extracted unchanged
 *  from device-score-pad.tsx so the scan page's Waiting screen uses the SAME
 *  floor (scorer sheets §4.5). `enabled: false` removes both listeners. */
export function useTabReturn(onReturn: () => void, enabled: boolean): void {
  useEffect(() => {
    if (typeof document === "undefined" || typeof window === "undefined") return;
    if (!enabled) return;
    const refreshIfVisible = () => {
      if (document.visibilityState !== "visible") return;
      onReturn();
    };
    document.addEventListener("visibilitychange", refreshIfVisible);
    window.addEventListener("focus", refreshIfVisible);
    return () => {
      document.removeEventListener("visibilitychange", refreshIfVisible);
      window.removeEventListener("focus", refreshIfVisible);
    };
  }, [onReturn, enabled]);
}
```
In device-score-pad.tsx replace the effect with `useTabReturn(handlePadEvents, !dead);`. Run `device-score-pad-freshness-floor.test.tsx` UNCHANGED → it must stay fully green (this is the extraction's regression test). If any case reds, the extraction changed behaviour — fix the hook, never the test.

- [ ] **Step 4: Waiting — failing test** `apps/web/src/components/v2/__tests__/scan-waiting.test.tsx`:

```tsx
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { renderIsland } from "@/components/__tests__/_hook-harness";

const router = vi.hoisted(() => ({ refresh: vi.fn() }));
vi.mock("next/navigation", () => ({ useRouter: () => router }));

import { ScanWaiting } from "@/components/v2/scan-waiting";
import { POLL_MS } from "@/components/v2/scorepad/use-fixture-stream";

beforeEach(() => { vi.useFakeTimers(); router.refresh.mockClear(); });
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

describe("ScanWaiting (scorer sheets §4.5.2)", () => {
  it("re-renders the page every POLL_MS — and not before", () => {
    renderIsland(ScanWaiting, { home: "Winner of R1·1", away: "Ben Lim", meta: "Court 3" });
    vi.advanceTimersByTime(POLL_MS - 1);
    expect(router.refresh).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(router.refresh).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(POLL_MS);
    expect(router.refresh).toHaveBeenCalledTimes(2);
  });

  it("stops the moment Waiting unmounts (only while waiting)", () => {
    const island = renderIsland(ScanWaiting, { home: "A", away: "B", meta: "" });
    island.unmount();
    vi.advanceTimersByTime(POLL_MS * 3);
    expect(router.refresh).not.toHaveBeenCalled();
  });

  it("names both sides, the TBD one by its slot label", () => {
    const island = renderIsland(ScanWaiting, { home: "Winner of R1·1", away: "Ben Lim", meta: "" });
    expect(island.text()).toContain("Winner of R1·1");
    expect(island.text()).toContain("Ben Lim");
  });
});
```
Also add to `device-score-pad-view-only.test.tsx` a guard that the chrome itself never polls:

```tsx
  it("the pad chrome registers no interval of its own (Waiting's poll must not leak into it)", () => {
    const spy = vi.spyOn(globalThis, "setInterval");
    renderIsland(DeviceScorePad, props("in_play", null));
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });
```
Run → FAIL (module missing).

- [ ] **Step 5: Implement Waiting.** `use-fixture-stream.ts:21` → `export const POLL_MS = 15_000;`. Create `apps/web/src/components/v2/scan-waiting.tsx`:

```tsx
"use client";

// Scorer sheets §4.5.2 — a side is still TBD. No stream is mounted (there is
// no pad yet), so the page re-renders itself every POLL_MS — only while this
// screen exists — and on tab return (G1's floor, the same hook). It re-renders
// the SERVER page rather than fetching "metadata": a device link may read only
// /state and /events (doc 13 §7), and the pad it is waiting to mount needs each
// side's members and lineup, which only the page loads (P6). A revoked link
// lands on the page's own Dead-link screen on the next refresh.
import { useCallback, useEffect } from "react";
import { useRouter } from "next/navigation";
import { useMsg } from "@/components/i18n/dict-provider";
import { useTabReturn } from "@/components/v2/use-tab-return";
import { POLL_MS } from "@/components/v2/scorepad/use-fixture-stream";

export function ScanWaiting({
  home,
  away,
  meta,
  pollMs = POLL_MS,
}: {
  home: string;
  away: string;
  meta: string;
  pollMs?: number;
}) {
  const msg = useMsg();
  const router = useRouter();
  const refresh = useCallback(() => router.refresh(), [router]);
  useEffect(() => {
    const id = setInterval(refresh, pollMs);
    return () => clearInterval(id);
  }, [refresh, pollMs]);
  useTabReturn(refresh, true);

  return (
    <section
      data-testid="scan-waiting"
      aria-live="polite"
      className="rounded-2xl border border-slate-800 bg-slate-900 px-4 py-6 text-center"
    >
      {meta && <p className="truncate text-[11px] uppercase tracking-widest text-slate-400">{meta}</p>}
      <p className="mt-3 text-sm text-slate-300">{msg("device.scan.waitingFor")}</p>
      <p className="mt-1 flex min-w-0 flex-wrap items-baseline justify-center gap-x-2 text-base font-semibold text-slate-100">
        <strong className="min-w-0 break-words">{home}</strong>
        <span className="text-[10px] uppercase tracking-widest text-slate-400">{msg("schedule.vs")}</span>
        <strong className="min-w-0 break-words">{away}</strong>
      </p>
      <p className="mt-4 text-xs text-slate-400">{msg("device.scan.waitingHint")}</p>
    </section>
  );
}
```
Run Step 4 → PASS.

- [ ] **Step 6: Confirm + seeded mount — failing tests** appended to `device-score-pad-view-only.test.tsx`:

```tsx
describe("DeviceScorePad — Confirm (scorer sheets §4.5.1)", () => {
  it("scheduled with both sides: the Confirm card with Start, and NO inner pad yet", () => {
    const island = renderIsland(DeviceScorePad, {
      ...props("scheduled", null),
      initialEvents: [],
      fixture: { ...props("scheduled", null).fixture, match_ref: "R1·3", scheduled_label: "Wed 23 Sep, 10:30" },
    });
    const card = byTestId(island.tree(), "scan-confirm");
    expect(card).toBeDefined();
    expect(island.text()).toContain("R1·3");
    expect(island.text()).toContain("Wed 23 Sep, 10:30");
    expect(byTestId(island.tree(), "score-start-match")).toBeDefined();
    expect(island.tree().find((e) => e.type === ScorePad)).toBeUndefined();
  });

  it("Start match sends core.start, then mounts the pad SEEDED with the post-start ledger", async () => {
    const island = renderIsland(DeviceScorePad, { ...props("scheduled", null), initialEvents: [] });
    const { apiV1 } = await import("@/lib/client-v1");
    const started = { id: "ev-start", seq: 1, type: "core.start", payload: {}, recorded_at: "2026-09-23T10:31:00.000Z", voids_event_id: null, device_link_id: DEVICE_LINK_ID, recorded_by: "u1" };
    vi.mocked(apiV1).mockImplementation(((url: string, options?: { method?: string }) => {
      if (options?.method === "POST") return Promise.resolve({});
      if (url.includes("/events")) return Promise.resolve([started]);
      return Promise.resolve({ status: "in_play", last_seq: 1, summary: null, state: {}, outcome: null });
    }) as typeof apiV1);
    (propsOf(byTestId(island.tree(), "score-start-match")!).onClick as () => void)();
    await flush();
    const pad = island.tree().find((e) => e.type === ScorePad);
    expect(pad, "the pad mounts once the match is started").toBeDefined();
    const seeded = propsOf(pad!).initialEvents as { type: string; seq: number }[];
    expect(seeded.map((e) => [e.type, e.seq])).toEqual([["core.start", 1]]);
  });
});
```
Run → FAIL.

- [ ] **Step 7: Implement Confirm** in `device-score-pad.tsx`:
  - `PadEventIn` gains `recorded_by?: string | null;`. Props `fixture` gains `match_ref?: string | null; scheduled_label?: string | null;`.
  - `resync` returns the ledger: change its body's success path to `setLive(state); setEvents(all); return all;` and its type to `Promise<PadEventIn[]>` (the timeout/shape guards unchanged).
  - State: `const [padSeed, setPadSeed] = useState<readonly EventEnvelope[]>(scorePadV2?.initialEvents ?? []);` (import `type EventEnvelope` from `@seazn/engine/core` — already a dependency of this tree via registry — and `eventOutToEnvelope` from `@/components/v2/scorepad/wire`).
  - In `send()` replace `await resync(); return true;` with:
    ```ts
        const all = await resync();
        // The inner pad mounts only after Start (Confirm, §4.5.1) and its stream
        // does not read on mount, so it is SEEDED from this post-start ledger —
        // otherwise it opens on the pre-start bootstrap and sends a stale seq (P8).
        if (type === "core.start") {
          setPadSeed(all.map((e) => eventOutToEnvelope(fixture.id, { ...e, recorded_by: e.recorded_by ?? null })));
        }
        return true;
    ```
  - `const confirming = canAct && live.status === "scheduled" && !!home && !!away;`. When `confirming`, render INSTEAD of the start/undo row:
    ```tsx
      <section data-testid="scan-confirm" className="rounded-2xl border border-slate-800 bg-slate-900 p-4">
        <h2 className="text-sm font-semibold text-slate-100">{msg("device.scan.confirmTitle")}</h2>
        <dl className="mt-3 grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1 text-sm">
          {fixture.court_label && (<><dt className="text-slate-400">{msg("device.scan.court")}</dt><dd className="min-w-0 truncate text-slate-100">{fixture.court_label}</dd></>)}
          {fixture.scheduled_label && (<><dt className="text-slate-400">{msg("device.scan.time")}</dt><dd className="min-w-0 truncate text-slate-100">{fixture.scheduled_label}</dd></>)}
          <dt className="text-slate-400">{msg("device.scan.match")}</dt>
          <dd className="min-w-0 truncate text-slate-100">{fixture.division_name}{fixture.match_ref ? ` · ${fixture.match_ref}` : ""}</dd>
        </dl>
        <p className="mt-3 break-words text-base font-semibold text-slate-100">
          {entrantDisplayName(home!)} <span className="text-[10px] uppercase tracking-widest text-slate-400">{msg("schedule.vs")}</span> {entrantDisplayName(away!)}
        </p>
        <p className="mt-2 text-xs text-slate-400">{msg("device.scan.confirmHint")}</p>
        <button
          type="button"
          data-testid="score-start-match"
          disabled={busy || padSyncing}
          onClick={() => send("core.start", {})}
          className="btn btn-primary mt-4 h-12 w-full text-base"
        >
          {msg("score.startMatch")}
        </button>
      </section>
    ```
    and drop the `!started &&` Start button from the old row (the row now only ever holds "Void my last entry", condition `canAct && scoring && home && away && lastOwnVoidable`).
  - Inner pad section condition gains `&& started`, and its `initialEvents={padSeed}`.
  - Dead copy by code: `setDead(err.code)` in both catch sites and render `msg(deadLinkKey(dead))` in the dead screen (the state now holds a code, not English).

Run Steps 1/4/6 files + freshness-floor + view-only → PASS.

- [ ] **Step 8: Page — failing DB tests** appended to `app/score/[token]/__tests__/page.test.tsx`. Add at the top: `vi.mock("@/lib/resolve-locale", () => ({ resolveLocale: async () => "en" }));` (import `vi`), and imports of `ScanWaiting`, `resultCarriedForward` rig helpers (`seedStage`, `fixturesOf`, `decide`, `deviceFor` from `@/server/usecases/__tests__/_sheets-rig`), `ensureDeviceLink`:

```tsx
describe.skipIf(!HAS_DB)("ScorePadPage screens (scorer sheets §4.5)", () => {
  it("TBD side → Waiting, naming the slot label ('Winner of …'), no pad", async () => {
    const { auth } = await seedOrg("pro");
    const { stage } = await seedStage(auth, "knockout", ["A", "B", "C", "D"]);
    const final = (await fixturesOf(stage.id)).find((f) => f.round_no === 2)!;
    const { secret } = await ensureDeviceLink(auth, final.id);
    const tree = await ScorePadPage({ params: Promise.resolve({ token: secret }) });
    const waiting = find(tree, ScanWaiting);
    expect(waiting).not.toBeNull();
    expect(find(tree, DeviceScorePad)).toBeNull();
    const { home, away } = waiting!.props as { home: string; away: string };
    expect(home).toMatch(/R1/);
    expect(away).toMatch(/R1/);
  });

  it("carried forward → the pad renders View-only from its first paint", async () => {
    const { auth } = await seedOrg("pro");
    const { stage } = await seedStage(auth, "knockout", ["A", "B", "C", "D"]);
    const sf1 = (await fixturesOf(stage.id)).find((f) => f.round_no === 1 && f.seq_in_round === 1)!;
    const device = await deviceFor(auth, sf1.id);
    await decide(device, sf1.id);
    const { secret } = await ensureDeviceLink(auth, sf1.id);
    const tree = await ScorePadPage({ params: Promise.resolve({ token: secret }) });
    expect((find(tree, DeviceScorePad)!.props as { initialViewOnly: string | null }).initialViewOnly).toBe("carried_forward");
  });

  it("scheduled, both sides → the pad with no View-only, a match ref and a venue-tz time", async () => {
    const { auth, fixtureId } = await seedScorableFixture();
    await sql`update fixtures set scheduled_at = '2026-09-23T10:30:00Z' where id = ${fixtureId}`;
    const { secret } = await ensureDeviceLink(auth, fixtureId);
    const tree = await ScorePadPage({ params: Promise.resolve({ token: secret }) });
    const p = find(tree, DeviceScorePad)!.props as { initialViewOnly: string | null; fixture: { match_ref: string | null; scheduled_label: string | null } };
    expect(p.initialViewOnly).toBeNull();
    expect(p.fixture.match_ref).toMatch(/^R1/);
    expect(p.fixture.scheduled_label).not.toBeNull();
  });

  it("a revoked link → localised dead screen, not the resolver's English", async () => {
    const { auth, fixtureId } = await seedScorableFixture();
    const link = await ensureDeviceLink(auth, fixtureId);
    await sql`update device_links set revoked_at = now() where id = ${link.row.id}`;
    const tree = await ScorePadPage({ params: Promise.resolve({ token: link.secret }) });
    const text = JSON.stringify(tree);
    expect(text).toContain("This scoring link was revoked.");
    expect(text).not.toContain("ask the organiser");
  });
});
```
Run → FAIL.

- [ ] **Step 9: Implement the page** (`app/score/[token]/page.tsx`):
  - Resolve locale first: `const locale = await resolveLocale(); const t = (k: MessageKey, v?: Record<string, string | number>) => msgFor(locale, k, v);`
  - Dead link: `catch (err) { const code = err instanceof HttpError ? err.code ?? null : null; return <DeadLink message={t(deadLinkKey(code))} hint={t("device.askFreshLink")} />; }`; missing fixture → `t("device.dead.gone")`. `DeadLink` takes `{ message, hint }` — no English literals left in the file.
  - Extend the fixture select with `f.status, f.seq_in_round, f.home_slot_label, f.away_slot_label, ss.tz as division_tz, o.timezone as org_tz` and joins `left join schedule_settings ss on ss.division_id = d.id` and `left join organizations o on o.id = d.org_id` (types: `status: string; seq_in_round: number; home_slot_label: SlotLabel | null; away_slot_label: SlotLabel | null; division_tz: string | null; org_tz: string | null`).
  - After `home`/`away` are loaded:
    ```tsx
      const carried = await withTenant(link.org_id, (tx) => resultCarriedForward(tx, fixture.id));
      const screen = scanScreen({
        status: state.status,
        homeKnown: fixture.home_entrant_id !== null,
        awayKnown: fixture.away_entrant_id !== null,
        carriedForward: carried,
      });
      const tz = resolveVenueTz(fixture.division_tz, fixture.org_tz);
      const scheduledLabel = fixtureTimeLabel(fixture.scheduled_at, tz, intlLocaleFor(locale));
      const ref = matchRef(fixture.round_no, fixture.seq_in_round, t);
      const meta = [fixture.court_name, scheduledLabel, `${fixture.division_name} · ${ref}`].filter(Boolean).join(" · ");
      if (screen.screen === "waiting") {
        return (
          <main style={themeStyle} className="min-h-screen bg-court px-4 py-6">
            <div className="mx-auto max-w-2xl">
              <ScanWaiting
                home={home ? entrantDisplayName(home) : resolveSlotLabel(fixture.home_slot_label, t, "schedule.tbd")}
                away={away ? entrantDisplayName(away) : resolveSlotLabel(fixture.away_slot_label, t, "schedule.tbd")}
                meta={meta}
              />
            </div>
          </main>
        );
      }
    ```
  - `<DeviceScorePad …>` gains `initialViewOnly={screen.screen === "view_only" ? screen.reason : null}`, `fixture.match_ref={ref}`, `fixture.scheduled_label={scheduledLabel}`, and each mapped event carries `recorded_by: e.recorded_by`.
  - The Waiting → Confirm hop needs no client state: `router.refresh()` re-renders this page and, once both sides exist, it renders `DeviceScorePad` fresh.

Run Step 8 + the existing three page tests → PASS.

- [ ] **Step 10: Strings** (4 dictionaries + regen):

| key | en | fr | es | nl |
|---|---|---|---|---|
| `device.scan.confirmTitle` | Check the match before you start | Vérifiez le match avant de commencer | Comprueba el partido antes de empezar | Controleer de wedstrijd voor je begint |
| `device.scan.confirmHint` | Make sure these are the players in front of you. | Assurez-vous que ce sont bien les joueurs devant vous. | Asegúrate de que son los jugadores que tienes delante. | Controleer of dit de spelers voor je zijn. |
| `device.scan.court` | Court | Terrain | Pista | Baan |
| `device.scan.time` | Time | Heure | Hora | Tijd |
| `device.scan.match` | Match | Match | Partido | Wedstrijd |
| `device.scan.waitingFor` | Waiting for | En attente de | Esperando a | Wachten op |
| `device.scan.waitingHint` | This page updates by itself. | Cette page se met à jour toute seule. | Esta página se actualiza sola. | Deze pagina werkt zichzelf bij. |
| `device.dead.invalid` | This scoring link is not valid. | Ce lien de score n'est pas valide. | Este enlace de puntuación no es válido. | Deze scorelink is niet geldig. |
| `device.dead.revoked` | This scoring link was revoked. | Ce lien de score a été révoqué. | Este enlace de puntuación se ha revocado. | Deze scorelink is ingetrokken. |
| `device.dead.expired` | This scoring link has expired. | Ce lien de score a expiré. | Este enlace de puntuación ha caducado. | Deze scorelink is verlopen. |
| `device.dead.gone` | This match no longer exists. | Ce match n'existe plus. | Este partido ya no existe. | Deze wedstrijd bestaat niet meer. |

- [ ] **Step 11: Re-point the e2e whose premise P8 removed.** In `apps/web/e2e/device-links.spec.ts`, the test "reaches its own inner pad faster than the poll" (search for that title) assumed the inner pad is mounted BEFORE Start. Re-point, never weaken: keep its realtime-join assertions and its "well inside POLL_MS" budget, but make the observed write a SECOND writer's (an organiser `POST /events` via `page.request` after the device has tapped Start and the pad has mounted) and assert THAT paints on the device's inner pad before `POLL_MS`. It still runs only under `E2E_REQUIRE_REALTIME=1`; say in the report whether you could run it.

Then run every e2e file that opens `/score/…`, WHOLE, after `$S rebuild --label sheets`: `e2e/device-links.spec.ts`, `e2e/carrom-pad.spec.ts`, `e2e/scorepad-offline.spec.ts`, `e2e/scorepad-v3-cricket.spec.ts`, `e2e/scorepad-v3-partial-amend.spec.ts`, `e2e/scorepad-a11y-evidence.spec.ts`, `e2e/walkthrough/device-pad-stalled-pipeline.spec.ts`, `e2e/walkthrough/device-pad-foreign-void.spec.ts`, `e2e/walkthrough/console-device-live-sync.spec.ts`, `e2e/walkthrough/scorepad-v3-r7-console-chrome.spec.ts`, `e2e/walkthrough/device-pad-carried-forward.spec.ts` (use each file's own `--project`; read `playwright.config.ts`). Any spec that tapped inner-pad tiles on a SCHEDULED fixture must now tap `score-start-match` first — that is the new product flow, not a weakened assertion. `e2e/gallery.capture.ts` is a capture harness: update its scheduled-fixture step the same way.

- [ ] **Step 12: Visual (UI bar).** With `$S rebuild` done, capture Confirm, Waiting, View-only (carried, finalized) and Dead link at 320/768/1280 with `screenshotAtWidths`, assert `expectNoHorizontalScroll` at each, with a 43-character entrant name on Confirm and Waiting (the truncate/min-w-0 chain). Control-set diff at 320 vs 1280 (membership + order of buttons). Keep the capture in Task 10's spec (it owns the visual gate); here, look at them and write per-screen verdicts in the report.

- [ ] **Step 13: Mutation check**
  - `scanScreen`: swap the first two `if (i.status === "scheduled")`/TBD checks → killed by "a TBD side while scheduled → Waiting".
  - `scanScreen`: `no_opponent` branch → `waiting` → killed by the bye row.
  - `scanScreen`: `carriedForward` line deleted → killed by the carried row AND the page's "carried forward → View-only" test.
  - `ScanWaiting` interval without cleanup → killed by "stops the moment Waiting unmounts".
  - `fixtureTimeLabel` without `timeZone` → killed by the Auckland case (only on a machine not in NZ time — the test pins `22:30`, which UTC would render as `10:30`).
  - Confirm: inner pad condition loses `&& started` → killed by "…NO inner pad yet".
  - `setPadSeed` removed → killed by "mounts the pad SEEDED".
  - page `resultCarriedForward` replaced with `false` → killed by the page's carried test.

- [ ] **Step 14: Commit** — every path in **Files** + `i18n-keys.ts`; message `feat(scan): Confirm, Waiting and View-only screens on the scoring link`.

---

### Task 7: Day selection, ordering and pagination (pure) + the candidate query

**Files:**
- Create: `apps/web/src/lib/scorer-sheets.ts`
- Create: `apps/web/src/lib/__tests__/scorer-sheets.test.ts`
- Create: `apps/web/src/server/usecases/scorer-sheets.ts` (query half only; T8 adds the builder)
- Create: `apps/web/src/server/usecases/__tests__/scorer-sheets.test.ts` (DB)

**Interfaces:**
- Consumes: `resolveVenueTz` (`@/lib/tz`), `SlotLabel` (`@/lib/slot-label`), `entrantDisplayName` (`@/lib/entrant-name`). Tables: `fixtures.court_id → courts(venue_id, name, sort) → venues(name, sort)` (V367/V374); `fixtures.court_label` is the legacy fallback.
- Produces (`@/lib/scorer-sheets`, client-safe):
  - `PRINTABLE_STATUSES: ReadonlySet<string>` = scheduled / in_play
  - `interface SheetSide { name: string; kind: "individual" | "team" | "pair"; members: { name: string }[] }`
  - `interface SheetCandidate { id; status; scheduled_at: string | null; tz: string; division_name; round_no; seq_in_round; venue_name: string | null; venue_sort: number | null; court_name: string | null; court_sort: number | null; home: SheetSide | null; away: SheetSide | null; home_slot_label: SlotLabel | null; away_slot_label: SlotLabel | null }`
  - `localDateOf(iso: string, tz: string): string` (`YYYY-MM-DD`)
  - `selectSheetFixtures(c: readonly SheetCandidate[], day: string): SheetCandidate[]` (filtered AND ordered)
  - `sheetDays(c: readonly SheetCandidate[]): string[]`
  - `defaultSheetDay(days: readonly string[], today: string): string | null`
  - `ROWS_PER_PAGE = 5`; `interface SheetPage { courtHeading: string | null; continued: boolean; rows: SheetCandidate[] }`; `paginateSheet(rows, noCourt: string): SheetPage[]`
- Produces (`@/server/usecases/scorer-sheets`):
  - `loadSheetCandidates(auth: AuthCtx, competitionId: string, day?: string): Promise<SheetCandidate[]>`
  - `listSheetDays(auth: AuthCtx, competitionId: string): Promise<string[]>`

- [ ] **Step 1: Failing pure tests** — `apps/web/src/lib/__tests__/scorer-sheets.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import {
  ROWS_PER_PAGE,
  defaultSheetDay,
  localDateOf,
  paginateSheet,
  selectSheetFixtures,
  sheetDays,
  type SheetCandidate,
} from "../scorer-sheets";

const side = (name: string) => ({ name, kind: "individual" as const, members: [] });
let n = 0;
function c(over: Partial<SheetCandidate> = {}): SheetCandidate {
  n += 1;
  return {
    id: `f${n}`,
    status: "scheduled",
    scheduled_at: "2026-09-23T09:00:00Z",
    tz: "UTC",
    division_name: "Open",
    round_no: 1,
    seq_in_round: n,
    venue_name: "Hall",
    venue_sort: 0,
    court_name: "Court 1",
    court_sort: 0,
    home: side("A"),
    away: side("B"),
    home_slot_label: null,
    away_slot_label: null,
    ...over,
  };
}

describe("selectSheetFixtures (scorer sheets §4.4)", () => {
  it("empty case first: no candidates → no rows, whatever the day", () => {
    expect(selectSheetFixtures([], "2026-09-23")).toEqual([]);
  });

  it("keeps scheduled and in-play; drops decided/finalized/forfeited/abandoned/cancelled", () => {
    const rows = ["scheduled", "in_play", "decided", "finalized", "forfeited", "abandoned", "cancelled"].map((status) => c({ status }));
    expect(selectSheetFixtures(rows, "2026-09-23").map((r) => r.status)).toEqual(["scheduled", "in_play"]);
  });

  it("drops unscheduled fixtures", () => {
    expect(selectSheetFixtures([c({ scheduled_at: null })], "2026-09-23")).toEqual([]);
  });

  it("keeps a TBD-side fixture (knockout later rounds print, D2) but drops a bye", () => {
    const tbd = c({ away: null, away_slot_label: { key: "slot.winner_match", params: { round: 1, seq: 1 } } });
    const bye = c({ away: null, away_slot_label: { key: "bracket.slot.bye", params: {} } });
    expect(selectSheetFixtures([tbd, bye], "2026-09-23").map((r) => r.id)).toEqual([tbd.id]);
  });

  it("the day is the fixture's LOCAL day in its own tz — Auckland vs UTC (Review Focus 3)", () => {
    const late = c({ scheduled_at: "2026-09-23T11:30:00Z", tz: "Pacific/Auckland" }); // 23:30 NZST, 23 Sep
    const early = c({ scheduled_at: "2026-09-22T12:30:00Z", tz: "Pacific/Auckland" }); // 00:30 NZST, 23 Sep
    expect(selectSheetFixtures([late, early], "2026-09-23").map((r) => r.id).sort()).toEqual([early.id, late.id].sort());
    expect(selectSheetFixtures([early], "2026-09-22")).toEqual([]); // the UTC day would say yes
  });

  it("orders by venue, court, time, then round/seq; courtless rows last", () => {
    const rows = [
      c({ id: "none", court_name: null, court_sort: null, venue_name: null, venue_sort: null }),
      c({ id: "c2-late", court_name: "Court 2", court_sort: 1, scheduled_at: "2026-09-23T11:00:00Z" }),
      c({ id: "c1-late", court_name: "Court 1", court_sort: 0, scheduled_at: "2026-09-23T11:00:00Z" }),
      c({ id: "c1-early", court_name: "Court 1", court_sort: 0, scheduled_at: "2026-09-23T09:00:00Z" }),
      c({ id: "c2-early", court_name: "Court 2", court_sort: 1, scheduled_at: "2026-09-23T09:00:00Z" }),
    ];
    expect(selectSheetFixtures(rows, "2026-09-23").map((r) => r.id)).toEqual(["c1-early", "c1-late", "c2-early", "c2-late", "none"]);
  });

  it("court SORT beats court NAME — the ordering differential", () => {
    const rows = [c({ id: "B", court_name: "A court", court_sort: 9 }), c({ id: "A", court_name: "Z court", court_sort: 8 })];
    expect(selectSheetFixtures(rows, "2026-09-23").map((r) => r.id)).toEqual(["A", "B"]);
  });
});

describe("sheetDays / defaultSheetDay", () => {
  it("empty: no days, no default", () => {
    expect(sheetDays([])).toEqual([]);
    expect(defaultSheetDay([], "2026-09-23")).toBeNull();
  });

  it("distinct local days of printable fixtures only, sorted", () => {
    const rows = [
      c({ scheduled_at: "2026-09-24T09:00:00Z" }),
      c({ scheduled_at: "2026-09-23T09:00:00Z" }),
      c({ scheduled_at: "2026-09-23T10:00:00Z" }),
      c({ scheduled_at: "2026-09-25T09:00:00Z", status: "decided" }),
    ];
    expect(sheetDays(rows)).toEqual(["2026-09-23", "2026-09-24"]);
  });

  it("default: today if it has fixtures, else the next day that does, else the last", () => {
    const days = ["2026-09-20", "2026-09-23", "2026-09-26"];
    expect(defaultSheetDay(days, "2026-09-23")).toBe("2026-09-23");
    expect(defaultSheetDay(days, "2026-09-24")).toBe("2026-09-26");
    expect(defaultSheetDay(days, "2026-09-30")).toBe("2026-09-26");
    expect(defaultSheetDay(days, "2026-09-01")).toBe("2026-09-20");
  });
});

describe("localDateOf", () => {
  it("is tz-aware", () => {
    expect(localDateOf("2026-09-23T11:30:00Z", "Pacific/Auckland")).toBe("2026-09-23");
    expect(localDateOf("2026-09-23T03:30:00Z", "America/Los_Angeles")).toBe("2026-09-22");
  });
});

describe("paginateSheet", () => {
  it("empty: no pages", () => {
    expect(paginateSheet([], "No court")).toEqual([]);
  });

  it(`${ROWS_PER_PAGE} rows per page; each court starts a page; an overflow page is marked continued`, () => {
    const c1 = Array.from({ length: ROWS_PER_PAGE + 1 }, () => c({ court_name: "Court 1" }));
    const c2 = [c({ court_name: "Court 2", court_sort: 1 })];
    expect(paginateSheet([...c1, ...c2], "No court").map((p) => [p.courtHeading, p.continued, p.rows.length])).toEqual([
      ["Court 1", false, ROWS_PER_PAGE],
      ["Court 1", true, 1],
      ["Court 2", false, 1],
    ]);
  });

  it("courtless fixtures print under the no-court heading", () => {
    expect(paginateSheet([c({ court_name: null })], "No court")[0]!.courtHeading).toBe("No court");
  });
});
```

Run → FAIL.

- [ ] **Step 2: Implement** `apps/web/src/lib/scorer-sheets.ts`:

```ts
// Scorer sheets §4.4 — which fixtures print on a day, in what order, on which
// page. Pure and client-safe: the print control (T9) and the PDF (T8) share it.
import type { SlotLabel } from "@/lib/slot-label";

export const PRINTABLE_STATUSES: ReadonlySet<string> = new Set(["scheduled", "in_play"]);
export const ROWS_PER_PAGE = 5;
const BYE_KEY = "bracket.slot.bye";

export interface SheetSide {
  name: string;
  kind: "individual" | "team" | "pair";
  members: { name: string }[];
}

export interface SheetCandidate {
  id: string;
  status: string;
  scheduled_at: string | null;
  /** Venue lane (V305): division tz → org tz → UTC, resolved by the loader. */
  tz: string;
  division_name: string;
  round_no: number;
  seq_in_round: number;
  venue_name: string | null;
  venue_sort: number | null;
  court_name: string | null;
  court_sort: number | null;
  home: SheetSide | null;
  away: SheetSide | null;
  home_slot_label: SlotLabel | null;
  away_slot_label: SlotLabel | null;
}

export interface SheetPage {
  courtHeading: string | null;
  continued: boolean;
  rows: SheetCandidate[];
}

export function localDateOf(iso: string, tz: string): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" }).format(
    new Date(iso),
  );
}

function isBye(f: SheetCandidate): boolean {
  return f.home_slot_label?.key === BYE_KEY || f.away_slot_label?.key === BYE_KEY;
}

function printable(f: SheetCandidate): boolean {
  return PRINTABLE_STATUSES.has(f.status) && f.scheduled_at !== null && !isBye(f);
}

const LAST = Number.MAX_SAFE_INTEGER;

function compare(a: SheetCandidate, b: SheetCandidate): number {
  return (
    (a.court_name === null ? 1 : 0) - (b.court_name === null ? 1 : 0) ||
    (a.venue_sort ?? LAST) - (b.venue_sort ?? LAST) ||
    (a.venue_name ?? "").localeCompare(b.venue_name ?? "") ||
    (a.court_sort ?? LAST) - (b.court_sort ?? LAST) ||
    (a.court_name ?? "").localeCompare(b.court_name ?? "", undefined, { numeric: true }) ||
    Date.parse(a.scheduled_at!) - Date.parse(b.scheduled_at!) ||
    a.round_no - b.round_no ||
    a.seq_in_round - b.seq_in_round
  );
}

export function selectSheetFixtures(candidates: readonly SheetCandidate[], day: string): SheetCandidate[] {
  return candidates.filter((f) => printable(f) && localDateOf(f.scheduled_at!, f.tz) === day).sort(compare);
}

export function sheetDays(candidates: readonly SheetCandidate[]): string[] {
  const days = new Set<string>();
  for (const f of candidates) if (printable(f)) days.add(localDateOf(f.scheduled_at!, f.tz));
  return [...days].sort();
}

export function defaultSheetDay(days: readonly string[], today: string): string | null {
  if (days.length === 0) return null;
  return days.find((d) => d >= today) ?? days[days.length - 1]!;
}

export function paginateSheet(rows: readonly SheetCandidate[], noCourt: string): SheetPage[] {
  const pages: SheetPage[] = [];
  let current: SheetPage | null = null;
  for (const row of rows) {
    const heading = row.court_name ?? noCourt;
    if (!current || current.courtHeading !== heading || current.rows.length === ROWS_PER_PAGE) {
      const continued = current !== null && current.courtHeading === heading;
      current = { courtHeading: heading, continued, rows: [] };
      pages.push(current);
    }
    current.rows.push(row);
  }
  return pages;
}
```
Run Step 1 → PASS.

- [ ] **Step 3: Failing DB test** — `apps/web/src/server/usecases/__tests__/scorer-sheets.test.ts`:

```ts
import { afterAll, describe, expect, it } from "vitest";
import { sql } from "@/lib/db";
import { seedOrg } from "./_seed";
import { fixturesOf, seedStage } from "./_sheets-rig";
import { listSheetDays, loadSheetCandidates } from "../scorer-sheets";

const HAS_DB = !!process.env.DATABASE_URL;
afterAll(async () => {
  if (!HAS_DB) return;
  const g = globalThis as { _sql?: { end(): Promise<void> } };
  const client = g._sql;
  g._sql = undefined;
  await client?.end();
});

describe.skipIf(!HAS_DB)("loadSheetCandidates (scorer sheets §4.4)", () => {
  it("empty case: an unscheduled competition has no days", async () => {
    const { auth } = await seedOrg("pro");
    const { competition } = await seedStage(auth, "league", ["A", "B", "C", "D"]);
    expect(await listSheetDays(auth, competition.id)).toEqual([]);
  });

  it("loads names, slot labels and the DIVISION tz; the day lands on the local calendar", async () => {
    const { auth } = await seedOrg("pro");
    const { competition, division, stage } = await seedStage(auth, "knockout", ["Nia Okafor", "Ben Lim", "C", "D"]);
    await sql`update schedule_settings set tz = 'Pacific/Auckland' where division_id = ${division.id}`;
    const fx = await fixturesOf(stage.id);
    const sf = fx.find((f) => f.round_no === 1)!;
    const final = fx.find((f) => f.round_no === 2)!;
    await sql`update fixtures set scheduled_at = '2026-09-23T11:30:00Z' where id = ${sf.id}`; // 23:30 NZST
    await sql`update fixtures set scheduled_at = '2026-09-23T10:00:00Z' where id = ${final.id}`;
    const rows = await loadSheetCandidates(auth, competition.id, "2026-09-23");
    const sfRow = rows.find((r) => r.id === sf.id)!;
    expect(sfRow.tz).toBe("Pacific/Auckland");
    expect([sfRow.home?.name, sfRow.away?.name].filter(Boolean).length).toBe(2);
    const finalRow = rows.find((r) => r.id === final.id)!;
    expect(finalRow.home).toBeNull();
    expect(finalRow.home_slot_label?.key).toBe("slot.winner_match");
    expect(await listSheetDays(auth, competition.id)).toEqual(["2026-09-23"]);
  });

  it("is tenant-scoped: another org cannot load this competition", async () => {
    const a = await seedOrg("pro");
    const b = await seedOrg("pro");
    const { competition } = await seedStage(a.auth, "league", ["A", "B"]);
    await expect(loadSheetCandidates(b.auth, competition.id)).rejects.toMatchObject({ status: 404 });
  });
});
```
Confirm a `schedule_settings` row exists after `startDivision` (if not, insert it through the use-case that writes it — read V305 and its writer; never hand-insert past a not-null column). Run → FAIL.

- [ ] **Step 4: Implement** `apps/web/src/server/usecases/scorer-sheets.ts`:

```ts
import "server-only";
// Scorer sheets §4.4 — the fixtures a printed sheet could show. The DAY filter
// runs in JS (lib/scorer-sheets.ts) because each division has its own tz; the
// SQL narrows to a ±1-day UTC window around the requested day, an optimisation
// only. Page auth (editor, same-origin) is the ROUTE's job; this is
// RLS-bounded by withTenant.
import { withTenant } from "@/lib/db";
import { HttpError } from "@/lib/errors";
import type { AuthCtx } from "@/server/api-v1/auth";
import { entrantDisplayName } from "@/lib/entrant-name";
import { resolveVenueTz } from "@/lib/tz";
import type { SlotLabel } from "@/lib/slot-label";
import { sheetDays, type SheetCandidate, type SheetSide } from "@/lib/scorer-sheets";

interface EntrantJson {
  name: string;
  kind: SheetSide["kind"];
  members: { name: string }[];
}

interface Row {
  id: string;
  status: string;
  scheduled_at: string | null;
  division_tz: string | null;
  org_tz: string | null;
  division_name: string;
  round_no: number;
  seq_in_round: number;
  venue_name: string | null;
  venue_sort: number | null;
  court_name: string | null;
  court_sort: number | null;
  home: EntrantJson | null;
  away: EntrantJson | null;
  home_slot_label: SlotLabel | null;
  away_slot_label: SlotLabel | null;
}

function toSide(e: EntrantJson | null): SheetSide | null {
  if (!e) return null;
  return { name: entrantDisplayName({ name: e.name, kind: e.kind, members: e.members }), kind: e.kind, members: e.members };
}

export async function loadSheetCandidates(
  auth: AuthCtx,
  competitionId: string,
  day?: string,
): Promise<SheetCandidate[]> {
  return withTenant(auth.orgId, async (tx) => {
    const [comp] = await tx<{ id: string }[]>`select id from competitions where id = ${competitionId}`;
    if (!comp) throw new HttpError(404, "competition not found");
    const from = day ? `${day}T00:00:00Z` : null;
    const rows = await tx<Row[]>`
      with ent as (
        select e.id,
               json_build_object(
                 'name', e.display_name,
                 'kind', e.kind,
                 'members', coalesce((
                   select json_agg(json_build_object('name', p.full_name) order by em.created_at)
                   from entrant_members em join persons p on p.id = em.person_id
                   where em.entrant_id = e.id), '[]'::json)) as j
        from entrants e
        join divisions d on d.id = e.division_id
        where d.competition_id = ${competitionId}
      )
      select f.id, f.status, f.scheduled_at, ss.tz as division_tz, o.timezone as org_tz,
             d.name as division_name, f.round_no, f.seq_in_round,
             v.name as venue_name, v.sort as venue_sort,
             coalesce(c.name, f.court_label) as court_name, c.sort as court_sort,
             f.home_slot_label, f.away_slot_label,
             he.j as home, ae.j as away
      from fixtures f
      join divisions d on d.id = f.division_id
      join organizations o on o.id = d.org_id
      left join schedule_settings ss on ss.division_id = d.id
      left join courts c on c.id = f.court_id
      left join venues v on v.id = c.venue_id
      left join ent he on he.id = f.home_entrant_id
      left join ent ae on ae.id = f.away_entrant_id
      where d.competition_id = ${competitionId}
        and f.scheduled_at is not null
        and f.status in ('scheduled', 'in_play')
        and (${from}::timestamptz is null
             or f.scheduled_at between ${from}::timestamptz - interval '1 day'
                                  and ${from}::timestamptz + interval '2 days')`;
    return rows.map((r) => ({
      id: r.id,
      status: r.status,
      scheduled_at: r.scheduled_at,
      tz: resolveVenueTz(r.division_tz, r.org_tz),
      division_name: r.division_name,
      round_no: r.round_no,
      seq_in_round: r.seq_in_round,
      venue_name: r.venue_name,
      venue_sort: r.venue_sort,
      court_name: r.court_name,
      court_sort: r.court_sort,
      home: toSide(r.home),
      away: toSide(r.away),
      home_slot_label: r.home_slot_label,
      away_slot_label: r.away_slot_label,
    }));
  });
}

export async function listSheetDays(auth: AuthCtx, competitionId: string): Promise<string[]> {
  return sheetDays(await loadSheetCandidates(auth, competitionId));
}
```
Before running, open `usecases/entrants.ts` ~:240 and copy its exact member join (the column names `display_name`, `full_name` and the member ORDER above are this plan's reading — entrants.ts is the authority; match its ordering so the sheet lists members as the roster does). Run Step 3 → PASS.

- [ ] **Step 5: Mutation check**
  - `PRINTABLE_STATUSES` gains `decided` → killed by "keeps scheduled and in-play; drops …".
  - `isBye` → `false` → killed by "drops a bye".
  - `localDateOf` without `timeZone` → killed by the Auckland case's second assertion.
  - drop the `court_sort` term in `compare` → killed by "court SORT beats court NAME".
  - drop the courtless-first term → killed by the ordering case (`none` sorts first on its empty venue name).
  - drop `current.courtHeading !== heading` → killed by the pagination case.
  - `d >= today` → `d > today` → killed by the "today" assertion.
  - SQL: `division_tz`/`org_tz` swapped in `resolveVenueTz` → killed by the DB tz assertion.
  - SQL window narrowed to `+ interval '1 day'` → survives by design (the JS filter decides; the window is an optimisation, not a guard). Record as an accepted survivor.

- [ ] **Step 6: Commit** — the four paths; message `feat(sheets): which fixtures print on a day, and in what order`.

E2E owed: Task 10's golden journey prints from a real seeded schedule and asserts the QR count equals the day's fixtures.

---

### Task 8: The PDF and its route — on the shared document system

**Analogue chosen: `api/v1/competitions/[id]/exports/timetable/route.ts` (with `exports/tickets` for the QR half), not `me/rota.pdf`.** Both were read. Rota is session-personal and cross-org, with no tenant and no entitlement gate (`requireUser`, `buildMyRotaDoc(userId)`). A scorer sheet is the opposite: it belongs to one competition, it is entitled, and it is tenant-scoped. Timetable has exactly that shape. A use-case builds the model with `auth` + `competitionId` + `{ printedAt }`, a renderer turns it into bytes, and the handler returns `NextResponse` with an attachment, with errors in the `v1()` envelope. Tickets is the same shape and is the only export that carries a QR per section (`qrBuffer` pre-pass, 422 on nothing to print). This changes where the route lives. It moves from `/o/…/schedule/scorer-sheets.pdf` to **`POST /api/v1/competitions/{id}/exports/scorer-sheets`**. That places it behind `proxy.ts`'s CSRF Origin check for `/api/**`, so P13 is solved by where the route sits, and the separate `scorer-sheet-guard.ts` is dropped. It also puts the route in `openapi.ts` + `key-scopes.ts` beside its siblings.

**Why not a DocModel.** `DocModel` lives in `packages/engine/src/exports/types.ts`, which is on this plan's Do-NOT-touch list. Its only section that carries a QR is `ticket`, whose fields are admission-specific (`maskedName`, `ref`, `status`). Its QR is drawn without a link annotation, and its footer strings (`printed …`, `page N of M`) are hard-coded English. Expressing a match block would need a new `DocSection` payload in the engine. So the sheet gets **its own renderer beside `doc-render.ts`**, on the same theme. It uses `registerFonts`, `FONT`, `PALETTE` and `qrBuffer` from `doc-theme.ts`, and `drawMasthead` / `drawTitleBlock` / `resolveLogo` exported from `doc-render.ts` with no behaviour change. There is no second QR helper and no second palette.

**Files:**
- Modify: `apps/web/src/server/doc-render.ts` — `export` on `resolveLogo`, `drawMasthead`, `drawTitleBlock`, `MARGIN`. `drawTitleBlock` gains an optional third parameter `eyebrow = eyebrowFor(model.kind)`, so every existing call is byte-identical.
- Modify: `apps/web/src/server/usecases/exports.ts` — `export` on `orgBranding` (no behaviour change)
- Create: `apps/web/src/server/scorer-sheet-pdf.ts` (renderer)
- Create: `apps/web/src/server/__tests__/scorer-sheet-pdf.test.ts`
- Create: `apps/web/src/server/__tests__/_pdf-uris.ts`
- Modify: `apps/web/src/server/usecases/scorer-sheets.ts` (add `buildScorerSheet`)
- Create: `apps/web/src/app/api/v1/competitions/[id]/exports/scorer-sheets/route.ts`
- Create: `apps/web/src/app/api/v1/competitions/[id]/exports/scorer-sheets/__tests__/route.test.ts`
- Modify: `apps/web/src/server/api-v1/openapi.ts` (entry beside `/competitions/{id}/exports/tickets`, ~:365), `apps/web/src/server/api-v1/key-scopes.ts` (session-only list beside `"GET /me/rota.pdf"`, ~:371), then `pnpm run openapi:gen` → `openapi/v1.json`, `openapi/v1.public.json`
- Modify: `apps/web/package.json` (devDependency `jsqr`), `pnpm-lock.yaml`
- Modify: 4 × `ui.json`, regenerate `i18n-keys.ts`

**Interfaces:**
- Consumes:
  - `ensureDeviceLinks` (T2), plus `loadSheetCandidates` / `selectSheetFixtures` / `paginateSheet` (T7).
  - `matchRef` / `resolveSlotLabel`.
  - From `@/server/doc-theme`: `registerFonts`, `FONT`, `PALETTE`, `qrBuffer`. From `@/server/doc-render`: `drawMasthead`, `drawTitleBlock`, `resolveLogo`, `MARGIN`.
  - `orgBranding` (`@/server/usecases/exports`), `type DocModel` (`@seazn/engine/exports`, a type import only).
  - `requireResourceAuth(req, "competition", id, "write")`, `v1()` (`@/server/api-v1/http`).
  - `rateLimit` + `__setRateLimitCounterForTests`, `resolveLocale`, `msgFor`, `intlLocaleFor`.
- Produces:
  - `interface SheetRow { fixtureId; url; time; matchLine; home; away; homeTbd: boolean; awayTbd: boolean; homeMembers: string[]; awayMembers: string[] }`
  - `interface SheetModel { header: DocModel; pages: { heading: string; rows: SheetRow[] }[]; labels: { eyebrow; scan; winner; score; signature: string; page: (n: number, of: number) => string } }`. `header` is a DocModel with `kind: "scoresheet"`, `sections: []` and `pageBreaks: "auto"`, used ONLY for the shared masthead and title block. `meta.printedAt` is supplied by the caller, never `Date.now()` in the renderer.
  - `renderScorerSheetPdf(model: SheetModel): Promise<Buffer>`
  - `buildScorerSheet(auth, competitionId: string, day: string, origin: string, locale: Locale, opts: { printedAt: string }): Promise<SheetModel>`. It throws `HttpError(422, …, "NO_FIXTURES_ON_DAY")` when nothing prints, the way `buildAdmitTicketsDoc` refuses an empty ticket run.
  - `POST /api/v1/competitions/{id}/exports/scorer-sheets` with JSON body `{ date: "YYYY-MM-DD" }`. Responses: 200 `application/pdf`, attachment, `private, no-store`, or 400 / 402 / 403 / 422 / 429 in the v1 envelope.

- [ ] **Step 1: Decoder dependency.** Run `cd /Users/ashokhein/github/seazn.club-worktrees/scorer-sheets && pnpm --filter <apps/web package name> add -D jsqr` (read `"name"` in `apps/web/package.json`). `pdftoppm` is for the local visual check only, never in vitest.

- [ ] **Step 2: Failing renderer test.** `apps/web/src/server/__tests__/_pdf-uris.ts`:

```ts
// pdfkit writes link annotations as uncompressed dictionary objects, so their
// /URI strings are readable in the raw bytes even though content streams are
// FlateDecoded and the brand fonts are embedded. Literal escapes are undone.
export function pdfLinkUris(pdf: Buffer): string[] {
  const text = pdf.toString("latin1");
  return [...text.matchAll(/\/URI\s*\(((?:\\.|[^\\)])*)\)/g)].map((m) => m[1]!.replace(/\\([()\\])/g, "$1"));
}

export function pdfPageCount(pdf: Buffer): number {
  const m = pdf.toString("latin1").match(/\/Type\s*\/Pages[\s\S]*?\/Count\s+(\d+)/);
  return m ? Number(m[1]) : 0;
}
```
Not pinned yet: how pdfkit encodes the URI string. If the first buffer shows `/URI <hex>`, add a hex branch to the extractor. Never weaken the count or equality assertions. Text in the content streams is NOT decodable here: Inter/Barlow are embedded, so the hex operands are glyph ids (see poster.pdf's route.test.ts header). The tests therefore prove links, pages and fonts, not strings. The strings are proven on the plain model by the builder's DB test.

`apps/web/src/server/__tests__/scorer-sheet-pdf.test.ts`:

```ts
import { beforeAll, describe, expect, it } from "vitest";
import { resolve } from "node:path";
import jsQR from "jsqr";
import sharp from "sharp";
import type { DocModel } from "@seazn/engine/exports";
import { qrBuffer } from "../doc-theme";
import { renderScorerSheetPdf, type SheetModel, type SheetRow } from "../scorer-sheet-pdf";
import { pdfLinkUris, pdfPageCount } from "./_pdf-uris";

// fontDir() defaults to <cwd>/apps/web/assets/fonts, which does not exist when
// vitest runs from apps/web. Unset, registerFonts SILENTLY falls back to
// Helvetica and this suite would prove the wrong fonts. Point it at the real dir.
beforeAll(() => {
  process.env.DOC_FONT_DIR = resolve(import.meta.dirname, "../../../assets/fonts");
});

const header: DocModel = {
  kind: "scoresheet", title: "Cup", description: "Wednesday 23 September",
  meta: { printedAt: "2026-09-23 08:00" }, sections: [], pageBreaks: "auto",
};
const labels: SheetModel["labels"] = {
  eyebrow: "SCORER SHEETS", scan: "Scan to score", winner: "Winner", score: "Score", signature: "Umpire",
  page: (n, of) => `Page ${n} of ${of}`,
};
const row = (i: number, over: Partial<SheetRow> = {}): SheetRow => ({
  fixtureId: `f${i}`, url: `https://example.test/score/dl_token${i}`, time: "10:30",
  matchLine: `Open · R1·${i}`, home: `Home ${i}`, away: `Away ${i}`, homeTbd: false, awayTbd: false,
  homeMembers: [], awayMembers: [], ...over,
});
const model = (pages: SheetRow[][]): SheetModel => ({
  header, labels, pages: pages.map((rows, i) => ({ heading: `Court ${i + 1}`, rows })),
});

describe("renderScorerSheetPdf (scorer sheets §4.4)", () => {
  it("is a PDF with one page per model page", async () => {
    const pdf = await renderScorerSheetPdf(model([[row(1), row(2)], [row(3)]]));
    expect(pdf.subarray(0, 5).toString("latin1")).toBe("%PDF-");
    expect(pdfPageCount(pdf)).toBe(2);
  });

  it("every row carries exactly one link to its own URL, in order — tappable when opened on a phone", async () => {
    const rows = [row(1), row(2), row(3)];
    expect(pdfLinkUris(await renderScorerSheetPdf(model([rows])))).toEqual(rows.map((r) => r.url));
  });

  it("a TBD side keeps its row and QR (D2) — the pen line is no reason to skip the link", async () => {
    expect(pdfLinkUris(await renderScorerSheetPdf(model([[row(1, { home: "Winner of R1·1", homeTbd: true })]])))).toHaveLength(1);
  });

  it("is set in the brand fonts (doc-theme), not the Helvetica fallback", async () => {
    const bytes = (await renderScorerSheetPdf(model([[row(1)]]))).toString("latin1");
    expect(bytes).toMatch(/\/BaseFont\s*\/[A-Z]{6}\+Inter/);
    expect(bytes).toMatch(/\/BaseFont\s*\/[A-Z]{6}\+BarlowCondensed/);
    expect(bytes).not.toMatch(/\/BaseFont\s*\/Helvetica/);
  });
});

describe("the shared qrBuffer, at the size the sheet prints it", () => {
  it("decodes back to the exact URL (real encoder, real decoder)", async () => {
    const url = "https://example.test/score/dl_AbC-_123";
    const png = await qrBuffer(url);
    expect(png).not.toBeNull();
    const { data, info } = await sharp(png!).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
    expect(jsQR(new Uint8ClampedArray(data), info.width, info.height)?.data).toBe(url);
  });
});
```
Check the subset-prefix pattern (`ABCDEF+Inter-Regular`) against the first real buffer and match what pdfkit actually writes. Also cross-check `doc-render.test.ts` in case it already asserts embedded fonts, and reuse its matcher. Run → FAIL.

- [ ] **Step 3: Export the shared chrome from `doc-render.ts`.** This is a behaviour-preserving edit:
  - Add `export` to `const MARGIN`, `async function resolveLogo`, `function drawMasthead` and `function drawTitleBlock`.
  - Change the title block's signature to `export function drawTitleBlock(doc: PDFKit.PDFDocument, model: DocModel, eyebrow: string = eyebrowFor(model.kind)): void` and use `eyebrow` in place of `eyebrowFor(model.kind)` in its body. EYEBROW's `scoresheet: "MATCH SHEET"` is hard-coded English, and the sheet passes its localised eyebrow instead.
  - In `usecases/exports.ts`, add `export` to `async function orgBranding`.

  Run the existing `doc-render.test.ts`, `doc-render-ticket-layout.test.ts`, `doc-render-footer-qr.test.ts`, `doc-render-bracket.test.ts`, `doc-theme.test.ts` and `exports.test.ts` UNCHANGED. They must stay green, because they are this refactor's regression test.

- [ ] **Step 4: Implement** `apps/web/src/server/scorer-sheet-pdf.ts`:

```ts
import "server-only";
// Scorer sheets §4.4 — A4 portrait, on the shared document system:
// doc-theme's fonts, palette and QR helper, and doc-render's masthead (Pro
// `exports.branded` only) and title block. Its own body, because a match
// block is not a DocModel section (the engine type is out of scope, and the
// ticket section's QR has no link and its footer is English). Per page: the
// court heading (and "continued"), then up to ROWS_PER_PAGE match blocks.
// Each QR image is ALSO a link annotation, so a phone that opens the PDF can
// tap it. A TBD side prints its slot label over a pen line.
//
// Glyphs, measured with fontkit against assets/fonts on 2026-09-23:
// Inter (FONT.body/bodyMed) covers Latin-1, Latin Extended-A, Vietnamese,
// Greek and Cyrillic. It has none of Tamil, Devanagari, Arabic, Hebrew, Thai
// or CJK. Barlow Condensed (FONT.display*) covers Latin and Vietnamese only:
// 4/57 Greek, 0/64 Cyrillic. So every PERSON name is set in Inter, never in
// Barlow. Barlow is used only for our own chrome (court heading), where the
// four UI locales are all Latin.
import PDFDocument from "pdfkit";
import type { DocModel } from "@seazn/engine/exports";
import { FONT, PALETTE, qrBuffer, registerFonts } from "./doc-theme";
import { MARGIN, drawMasthead, drawTitleBlock, resolveLogo } from "./doc-render";

export interface SheetRow {
  fixtureId: string;
  url: string;
  time: string;
  matchLine: string;
  home: string;
  away: string;
  homeTbd: boolean;
  awayTbd: boolean;
  homeMembers: string[];
  awayMembers: string[];
}

export interface SheetModel {
  /** Masthead + title block only — `sections` stays empty. */
  header: DocModel;
  pages: { heading: string; rows: SheetRow[] }[];
  labels: { eyebrow: string; scan: string; winner: string; score: string; signature: string; page: (n: number, of: number) => string };
}

const QR = 104;
const BLOCK = 132;

export async function renderScorerSheetPdf(model: SheetModel): Promise<Buffer> {
  // QR pre-pass, as docModelToPdf does it: pdfkit draws synchronously. A null
  // QR is a sheet nobody can scan, so fail the print rather than ship it.
  const qrs = new Map<string, Buffer>();
  for (const page of model.pages) {
    for (const r of page.rows) {
      const png = await qrBuffer(r.url);
      if (!png) throw new Error(`QR generation failed for fixture ${r.fixtureId}`);
      qrs.set(r.fixtureId, png);
    }
  }
  const logo = model.header.branding ? await resolveLogo(model.header.branding.logos?.[0]) : null;

  const doc = new PDFDocument({ size: "A4", layout: "portrait", margin: MARGIN, bufferPages: true, info: { Title: model.header.title } });
  const chunks: Buffer[] = [];
  doc.on("data", (c: Buffer) => chunks.push(c));
  const done = new Promise<Buffer>((resolve) => doc.on("end", () => resolve(Buffer.concat(chunks))));
  registerFonts(doc);
  const width = doc.page.width - MARGIN * 2;

  for (const [p, page] of model.pages.entries()) {
    if (p > 0) doc.addPage();
    if (model.header.branding) drawMasthead(doc, model.header, logo);
    else doc.y = MARGIN;
    drawTitleBlock(doc, model.header, model.labels.eyebrow);
    doc.font(FONT.displayBold).fontSize(16).fillColor(PALETTE.night)
      .text(page.heading.toUpperCase(), MARGIN, doc.y, { width, lineBreak: false, ellipsis: true });
    let y = doc.y + 8;
    for (const r of page.rows) {
      doc.moveTo(MARGIN, y).lineTo(MARGIN + width, y).strokeColor(PALETTE.hairline).lineWidth(0.75).stroke();
      doc.image(qrs.get(r.fixtureId)!, MARGIN, y + 10, { width: QR, height: QR, link: r.url });
      doc.font(FONT.bodyMed).fontSize(7).fillColor(PALETTE.mute)
        .text(model.labels.scan, MARGIN, y + 12 + QR, { width: QR, align: "center", lineBreak: false });
      const x = MARGIN + QR + 16;
      const w = width - QR - 16;
      doc.font(FONT.bodyMed).fontSize(9).fillColor(PALETTE.slate)
        .text(`${r.time} · ${r.matchLine}`, x, y + 10, { width: w, lineBreak: false, ellipsis: true });
      side(doc, r.home, r.homeTbd, r.homeMembers, x, y + 26, w);
      side(doc, r.away, r.awayTbd, r.awayMembers, x, y + 58, w);
      doc.font(FONT.body).fontSize(8).fillColor(PALETTE.slate).text(
        `${model.labels.score} ____________   ${model.labels.winner} ____________   ${model.labels.signature} ____________`,
        x, y + 100, { width: w, lineBreak: false },
      );
      y += BLOCK;
    }
  }

  // Own footer: doc-render's says "printed … page N of M" in English.
  // Keep it inside the content box — text at or below page.height - MARGIN
  // is suppressed by pdfkit (doc-render's note).
  const range = doc.bufferedPageRange();
  for (let i = range.start; i < range.start + range.count; i++) {
    doc.switchToPage(i);
    const fy = doc.page.height - MARGIN - 10;
    doc.font(FONT.body).fontSize(7).fillColor(PALETTE.mute).text(
      `${model.header.meta.printedAt} · ${model.labels.page(i - range.start + 1, range.count)}`,
      MARGIN, fy, { width: width - 90, lineBreak: false },
    );
    doc.font(FONT.body).fontSize(7).fillColor(PALETTE.mute)
      .text("seazn.club", MARGIN, fy, { width, align: "right", lineBreak: false });
  }
  doc.end();
  return done;
}

function side(doc: PDFKit.PDFDocument, name: string, tbd: boolean, members: string[], x: number, y: number, w: number) {
  // Person names in Inter (FONT.bodyMed) — Barlow has no Cyrillic/Greek.
  doc.font(FONT.bodyMed).fontSize(12).fillColor(tbd ? PALETTE.slate : PALETTE.ink)
    .text(name, x, y, { width: w, lineBreak: false, ellipsis: true });
  if (tbd) {
    doc.moveTo(x, y + 26).lineTo(x + Math.min(w, 220), y + 26).strokeColor(PALETTE.slate).lineWidth(0.6).stroke();
  } else if (members.length > 0) {
    doc.font(FONT.body).fontSize(8).fillColor(PALETTE.slate)
      .text(members.join(", "), x, y + 16, { width: w, lineBreak: false, ellipsis: true });
  }
}
```
Run Step 2 → PASS.

Then render a 7-row model to `$TMPDIR/sheet.pdf`: a throwaway `pnpm exec tsx -e` from `apps/web` with `DOC_FONT_DIR` set, one branded run and one unbranded. Run `pdftoppm -r 80 -png $TMPDIR/sheet.pdf $TMPDIR/sheet` and LOOK at each page:
- masthead only on the branded run;
- title block, then court heading;
- five blocks, with the fifth clear of the footer.

The page-1 masthead pushes the body down by MAST_H + 18. If five blocks do not fit under it, lower `BLOCK` or `QR`. Do not lower `ROWS_PER_PAGE`: it is T7's contract, and changing it moves T7's test. Record the final geometry, and a phone scan of one printed QR at 104 pt (qrBuffer renders 180 px).

- [ ] **Step 5: Builder — failing DB test** appended to T7's `apps/web/src/server/usecases/__tests__/scorer-sheets.test.ts`:

```ts
import { buildScorerSheet } from "../scorer-sheets";

describe.skipIf(!HAS_DB)("buildScorerSheet (scorer sheets §4.4)", () => {
  it("empty day → 422 NO_FIXTURES_ON_DAY, and nothing is minted", async () => {
    const { auth } = await seedOrg("pro");
    const { competition } = await seedStage(auth, "league", ["A", "B", "C", "D"]);
    await expect(buildScorerSheet(auth, competition.id, "2026-10-01", "http://localhost:3000", "en", { printedAt: "x" }))
      .rejects.toMatchObject({ status: 422, code: "NO_FIXTURES_ON_DAY" });
    const [{ n }] = await sql<{ n: number }[]>`select count(*)::int as n from device_links where org_id = ${auth.orgId}`;
    expect(n).toBe(0);
  });

  it("one row per printable fixture, each URL a live link of THAT fixture; strings localised; TBD side is a slot label", async () => {
    const { auth } = await seedOrg("pro");
    const { competition, stage } = await seedStage(auth, "knockout", ["A", "B", "C", "D"]);
    const fx = await fixturesOf(stage.id);
    await sql`update fixtures set scheduled_at = '2026-09-23T09:00:00Z' where id = any(${fx.map((f) => f.id)})`;
    const m = await buildScorerSheet(auth, competition.id, "2026-09-23", "http://localhost:3000", "fr", { printedAt: "x" });
    const rows = m.pages.flatMap((p) => p.rows);
    expect(rows.map((r) => r.fixtureId).sort()).toEqual(fx.map((f) => f.id).sort());
    expect(m.labels.scan).toBe(msgFor("fr", "sheets.pdf.scan"));
    expect(m.header.kind).toBe("scoresheet");
    const final = rows.find((r) => r.fixtureId === fx.find((f) => f.round_no === 2)!.id)!;
    expect(final.homeTbd).toBe(true);
    expect(final.home).toBe(resolveSlotLabel({ key: "slot.winner_match", params: { round: 1, seq: 1 } }, (k, v) => msgFor("fr", k, v), "schedule.tbd"));
    for (const r of rows) {
      const [link] = await sql<{ fixture_id: string; revoked_at: string | null }[]>`
        select fixture_id, revoked_at from device_links where token_hash = ${hashDeviceLinkToken(r.url.split("/score/")[1]!)}`;
      expect([link?.fixture_id, link?.revoked_at]).toEqual([r.fixtureId, null]);
    }
  });

  it("a second build carries the SAME urls (a sheet on court stays alive)", async () => {
    const { auth } = await seedOrg("pro");
    const { competition, stage } = await seedStage(auth, "league", ["A", "B", "C", "D"]);
    const fx = await fixturesOf(stage.id);
    await sql`update fixtures set scheduled_at = '2026-09-23T09:00:00Z' where id = any(${fx.map((f) => f.id)})`;
    const urls = async () =>
      (await buildScorerSheet(auth, competition.id, "2026-09-23", "http://localhost:3000", "en", { printedAt: "x" }))
        .pages.flatMap((p) => p.rows.map((r) => r.url)).sort();
    expect(await urls()).toEqual(await urls());
  });
});
```
Add the imports: `msgFor`, `resolveSlotLabel`, `hashDeviceLinkToken`. Run → FAIL.

- [ ] **Step 6: Implement the builder.** Append to `usecases/scorer-sheets.ts`:

```ts
import { ensureDeviceLinks } from "./device-links";
import { orgBranding } from "./exports";
import { sql } from "@/lib/db";
import { msgFor } from "@/lib/messages-i18n";
import { intlLocaleFor } from "@/lib/public-date-locale";
import { matchRef, resolveSlotLabel } from "@/lib/slot-label";
import { paginateSheet, selectSheetFixtures } from "@/lib/scorer-sheets";
import type { Locale } from "@/lib/i18n-constants";
import type { SheetModel } from "@/server/scorer-sheet-pdf";

/** The printable model for one day (§4.4). Shaped like exports.ts's
 *  buildAdmitTicketsDoc: branding resolved OUTSIDE the tenant transaction,
 *  422 on nothing to print rather than an empty 200. Links are ENSURED —
 *  re-shown, never rotated (T2). */
export async function buildScorerSheet(
  auth: AuthCtx,
  competitionId: string,
  day: string,
  origin: string,
  locale: Locale,
  opts: { printedAt: string },
): Promise<SheetModel> {
  const rows = selectSheetFixtures(await loadSheetCandidates(auth, competitionId, day), day);
  if (rows.length === 0) throw new HttpError(422, "No fixtures to print on that day", "NO_FIXTURES_ON_DAY");
  const t = (k: Parameters<typeof msgFor>[1], v?: Record<string, string | number>) => msgFor(locale, k, v);
  const [comp] = await sql<{ name: string; org_id: string; org_name: string }[]>`
    select c.name, c.org_id, org.name as org_name
    from competitions c join organizations org on org.id = c.org_id where c.id = ${competitionId}`;
  const branding = await orgBranding(comp!.org_id, comp!.org_name, competitionId);
  const links = await ensureDeviceLinks(auth, competitionId, rows.map((r) => r.id));
  const intl = intlLocaleFor(locale);
  const time = (iso: string, tz: string) =>
    new Intl.DateTimeFormat(intl, { timeZone: tz, hour: "2-digit", minute: "2-digit" }).format(new Date(iso));
  // A calendar day, formatted at UTC noon so no zone shifts it (poster.pdf's rule).
  const dayLabel = new Intl.DateTimeFormat(intl, { timeZone: "UTC", weekday: "long", day: "numeric", month: "long", year: "numeric" })
    .format(new Date(`${day}T12:00:00Z`));
  return {
    header: {
      kind: "scoresheet",
      title: comp!.name,
      description: dayLabel,
      meta: { printedAt: opts.printedAt },
      branding,
      sections: [],
      pageBreaks: "auto",
    },
    labels: {
      eyebrow: t("sheets.pdf.eyebrow"),
      scan: t("sheets.pdf.scan"),
      winner: t("sheets.pdf.winner"),
      score: t("sheets.pdf.score"),
      signature: t("sheets.pdf.signature"),
      page: (n, of) => t("sheets.pdf.page", { n, of }),
    },
    pages: paginateSheet(rows, t("sheets.pdf.noCourt")).map((p) => ({
      heading: p.continued ? t("sheets.pdf.continued", { court: p.courtHeading ?? "" }) : (p.courtHeading ?? ""),
      rows: p.rows.map((r) => ({
        fixtureId: r.id,
        url: `${origin}/score/${links.get(r.id)!.secret}`,
        time: time(r.scheduled_at!, r.tz),
        matchLine: `${r.division_name} · ${matchRef(r.round_no, r.seq_in_round, t)}`,
        home: r.home?.name ?? resolveSlotLabel(r.home_slot_label, t, "schedule.tbd"),
        away: r.away?.name ?? resolveSlotLabel(r.away_slot_label, t, "schedule.tbd"),
        homeTbd: r.home === null,
        awayTbd: r.away === null,
        homeMembers: r.home && r.home.kind !== "individual" ? r.home.members.map((m) => m.name) : [],
        awayMembers: r.away && r.away.kind !== "individual" ? r.away.members.map((m) => m.name) : [],
      })),
    })),
  };
}
```
`orgBranding` already nulls branding for plans without `exports.branded`; confirm that at exports.ts:166 before relying on it. `loadSheetCandidates` runs first so a foreign competition 404s before anything is minted. Run Step 5 → PASS.

- [ ] **Step 7: Route — failing test** `apps/web/src/app/api/v1/competitions/[id]/exports/scorer-sheets/__tests__/route.test.ts`. The use-case is proven by Step 5 against the DB. The route test pins only the route's own duties: the auth scope it asks for, the body, the headers, the limiter, and the envelope.

```ts
import { beforeEach, describe, expect, it, vi } from "vitest";
import { HttpError } from "@/lib/errors";
import { __setRateLimitCounterForTests } from "@/lib/rate-limit";

const h = vi.hoisted(() => ({
  auth: vi.fn(),
  build: vi.fn(),
  render: vi.fn(async () => Buffer.from("%PDF-1.3 test")),
}));
vi.mock("@/server/api-v1/auth", async (orig) => ({ ...(await orig<object>()), requireResourceAuth: h.auth }));
vi.mock("@/server/usecases/scorer-sheets", () => ({ buildScorerSheet: h.build }));
vi.mock("@/server/scorer-sheet-pdf", () => ({ renderScorerSheetPdf: h.render }));
vi.mock("@/lib/resolve-locale", () => ({ resolveLocale: async () => "en" }));

import { POST } from "../route";

const AUTH = { orgId: "o1", userId: "u1", via: "session" };
const ctx = { params: Promise.resolve({ id: "c1" }) };
const req = (body: unknown) =>
  new Request("http://localhost:3000/api/v1/competitions/c1/exports/scorer-sheets", {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
  });

beforeEach(() => {
  vi.clearAllMocks();
  __setRateLimitCounterForTests(null);
  h.auth.mockResolvedValue(AUTH);
  h.build.mockResolvedValue({ header: {}, pages: [], labels: {} });
});

describe("POST /competitions/{id}/exports/scorer-sheets", () => {
  it("asks for WRITE on the competition (printing mints credentials) and passes the day through", async () => {
    const res = await POST(req({ date: "2026-09-23" }), ctx);
    expect(res.status).toBe(200);
    expect(h.auth).toHaveBeenCalledWith(expect.any(Request), "competition", "c1", "write");
    expect(h.build).toHaveBeenCalledWith(AUTH, "c1", "2026-09-23", "http://localhost:3000", "en", expect.objectContaining({ printedAt: expect.any(String) }));
  });

  it("serves a private, uncached attachment (Review Focus 4)", async () => {
    const res = await POST(req({ date: "2026-09-23" }), ctx);
    expect(res.headers.get("content-type")).toBe("application/pdf");
    expect(res.headers.get("cache-control")).toBe("private, no-store");
    expect(res.headers.get("content-disposition")).toBe('attachment; filename="scorer-sheets-2026-09-23.pdf"');
  });

  it("malformed date → 400 before anything is built", async () => {
    expect((await POST(req({ date: "23/09/2026" }), ctx)).status).toBe(400);
    expect(h.build).not.toHaveBeenCalled();
  });

  it("the use-case's 422 and the auth 403 come back in the v1 envelope", async () => {
    h.build.mockRejectedValueOnce(new HttpError(422, "No fixtures to print on that day", "NO_FIXTURES_ON_DAY"));
    const r422 = await POST(req({ date: "2026-10-01" }), ctx);
    expect(r422.status).toBe(422);
    expect((await r422.json()).error.code).toBe("NO_FIXTURES_ON_DAY");
    h.auth.mockRejectedValueOnce(new HttpError(403, "Forbidden"));
    expect((await POST(req({ date: "2026-09-23" }), ctx)).status).toBe(403);
  });

  it("over the per-user limit → 429 (the limiter is inert without Redis, so the counter is forced)", async () => {
    __setRateLimitCounterForTests(async () => 7);
    expect((await POST(req({ date: "2026-09-23" }), ctx)).status).toBe(429);
    expect(h.build).not.toHaveBeenCalled();
  });
});
```
Also pin the envelope shape `{ ok:false, error:{ code } }` against what `v1()` actually emits: read `server/api-v1/http.ts` and use its shape. Some pieces are proven elsewhere and are not re-proven here with a real session:
- The cross-origin refusal is `proxy.ts`'s. Its existing tests cover `/api/**` POSTs, so confirm one exists and name it in the report.
- The viewer 403 is `requireResourceAuth`'s.
- The Community 402 is proven by T2's pass-scope sibling and T10's smoke.

Run → FAIL.

- [ ] **Step 8: Implement the route** `apps/web/src/app/api/v1/competitions/[id]/exports/scorer-sheets/route.ts`. It follows timetable/tickets line for line, and adds the body, the limiter and no-store:

```ts
import { NextResponse } from "next/server";
import { z } from "zod";
import { v1 } from "@/server/api-v1/http";
import { requireResourceAuth } from "@/server/api-v1/auth";
import { HttpError } from "@/lib/errors";
import { rateLimit } from "@/lib/rate-limit";
import { baseUrl } from "@/lib/oauth";
import { resolveLocale } from "@/lib/resolve-locale";
import { buildScorerSheet } from "@/server/usecases/scorer-sheets";
import { renderScorerSheetPdf } from "@/server/scorer-sheet-pdf";

type Ctx = { params: Promise<{ id: string }> };
const Body = z.object({ date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/) });

/** POST /competitions/{id}/exports/scorer-sheets — one A4 scorer sheet per
 *  court for a day, a scan-to-score QR per match (scorer sheets §4.4). POST,
 *  not GET like its timetable/tickets siblings: printing MINTS scoring links
 *  (a prefetch or crawler must not), and the bytes are live credentials, so
 *  never cached. Session editors only — ensureDeviceLinks refuses API keys.
 *  Under /api so proxy.ts's CSRF Origin check covers it (P13). */
export async function POST(req: Request, { params }: Ctx) {
  try {
    const { id } = await params;
    const auth = await requireResourceAuth(req, "competition", id, "write");
    await rateLimit(`sheets:${auth.userId}`, { max: 6, windowSeconds: 60 });
    const parsed = Body.safeParse(await req.json().catch(() => null));
    if (!parsed.success) throw new HttpError(400, "date must be YYYY-MM-DD");
    const model = await buildScorerSheet(auth, id, parsed.data.date, new URL(baseUrl(req)).origin, await resolveLocale(), {
      printedAt: new Date().toISOString().slice(0, 16).replace("T", " "),
    });
    const bytes = await renderScorerSheetPdf(model);
    return new NextResponse(new Uint8Array(bytes), {
      headers: {
        "Content-Type": "application/pdf",
        "Content-Disposition": `attachment; filename="scorer-sheets-${parsed.data.date}.pdf"`,
        "Cache-Control": "private, no-store",
      },
    });
  } catch (err) {
    return v1(async () => {
      throw err;
    });
  }
}
```
Check two things. First, that `requireResourceAuth`'s `"write"` scope means editor for a session: read `auth.ts:352`, and if editor is a different scope name, use that one and fix the test. Second, that `v1()`'s error response also carries `no-store`; if not, it is only an error body with no credentials in it, so say so and leave it. Then register the route:
  - `openapi.ts`: add `{ path: "/competitions/{id}/exports/scorer-sheets", method: "post", summary: "Printable scorer sheets PDF for one day — one QR per match, each a live device link (re-shown, never rotated); session editors only (`scoring.device_links`)", tag: "exports", errors: [400, 402, 403, 422, 429] }` beside the tickets entry. Copy how a neighbouring POST entry declares its JSON body.
  - `key-scopes.ts`: add `"POST /competitions/:id/exports/scorer-sheets"` to the session-only list beside `"GET /me/rota.pdf"`, with a comment that printing mints device links, which are session-editor only (doc 13 §7).
  - `cd /Users/ashokhein/github/seazn.club-worktrees/scorer-sheets && pnpm run openapi:gen && git status --porcelain openapi/`, then commit the regenerated files.
  - Run the key-scopes coverage test (grep `key-scopes` under `src/server/api-v1/__tests__`): every v1 route must be classified.

- [ ] **Step 9: Strings** (4 dictionaries, then `pnpm run i18n:gen-keys && pnpm run i18n:check`):

| key | en | fr | es | nl |
|---|---|---|---|---|
| `sheets.pdf.eyebrow` | SCORER SHEETS | FEUILLES DE SCORE | HOJAS DE PUNTUACIÓN | SCOREFORMULIEREN |
| `sheets.pdf.scan` | Scan to score | Scannez pour noter | Escanea para puntuar | Scan om te scoren |
| `sheets.pdf.winner` | Winner | Vainqueur | Ganador | Winnaar |
| `sheets.pdf.score` | Score | Score | Resultado | Score |
| `sheets.pdf.signature` | Umpire | Arbitre | Árbitro | Scheidsrechter |
| `sheets.pdf.page` | Page {n} of {of} | Page {n} sur {of} | Página {n} de {of} | Pagina {n} van {of} |
| `sheets.pdf.noCourt` | No court assigned | Aucun terrain attribué | Sin pista asignada | Geen baan toegewezen |
| `sheets.pdf.continued` | {court} (continued) | {court} (suite) | {court} (continuación) | {court} (vervolg) |

- [ ] **Step 10: Run** the Step 2, 5 and 7 files, plus the six doc-render/doc-theme/exports suites from Step 3, via vitest JSON: PASS, and `pending == 0` on the DB files. Then run `$S gate --label sheets` (clean) and the OpenAPI drift check (`git status --porcelain openapi/` empty after commit).

- [ ] **Step 11: Mutation check**
  - drop `link: r.url` → killed by "every row carries exactly one link".
  - skip TBD rows in the renderer → killed by the TBD case.
  - skip `registerFonts(doc)` → killed by "is set in the brand fonts".
  - set person names in `FONT.displayBold` → no automatic killer (both fonts embed). This is a documented glyph rule, so review checks it by reading `side()`. Record it as unkillable by test.
  - `qrBuffer` null tolerated (draw nothing) → killed only by a forced-null case. Add `vi.mock("../doc-theme", …)` returning `null` from `qrBuffer` in a separate `it`, expecting `renderScorerSheetPdf` to reject. Add that case now and record it as the killer.
  - `drawTitleBlock`'s default eyebrow changed → killed by the existing doc-render suites (title bytes differ) only if they snapshot. Say which suite killed it, or record it as a survivor.
  - builder uses `createDeviceLink` per row → killed by "a second build carries the SAME urls".
  - builder throws nothing on an empty day → killed by the 422 case.
  - URL from `r.id` instead of the secret → killed by the hash lookup.
  - route asks `"read"` → killed by the WRITE assertion.
  - `Cache-Control` removed → killed by the header case (Review Focus 4).
  - `rateLimit` call deleted → killed by the 429 case.

- [ ] **Step 12: Commit.** Stage every path in **Files**, plus `i18n-keys.ts` and `openapi/*.json`. Message: `feat(sheets): printable scorer sheets PDF on the shared document theme`.

E2E owed: Task 10 downloads this through the UI and opens a token taken from the bytes.

---

### Task 9: The print control on the schedule page

**Files:**
- Create: `apps/web/src/components/v2/print-scorer-sheets.tsx`
- Create: `apps/web/src/components/v2/__tests__/print-scorer-sheets.test.tsx`
- Modify: `apps/web/src/app/o/[orgSlug]/c/[compSlug]/schedule/page.tsx` (data ~:48-60; header block ~:170-176)
- Modify: 4 × `ui.json`, regenerate `i18n-keys.ts`

**Interfaces:**
- Consumes: `listSheetDays` (T7), `defaultSheetDay`/`localDateOf` (T7), `hasFeature(orgId, "scoring.device_links", competitionId)`, `UpgradeGate`, the page's existing `viewerPlan`, `billingFrozen`, `canEdit`, `orgTz`.
- Produces: `PrintScorerSheets({ action, days, defaultDay, allowed, viewerPlan })`; test ids `print-sheets`, `print-sheets-day`, `print-sheets-submit`, `print-sheets-error`.

- [ ] **Step 0: Owner gate (RULES: ≥2 UI options before building).** Before writing code, send the owner two mock-ups (320 and 1280 each) through the controller, with a recommendation:
  - **A — inline header control:** a native day `<select>` plus a "Print scorer sheets" button, right of the schedule page title (stacks under it on phones). One tap to print today.
  - **B — header button + panel:** one "Print scorer sheets" button opening a small panel of days as radio rows with counts ("Wed 23 Sep · 14 matches") and a Download button. Better when a competition spans many days.
  Build the chosen one. The code below is A; for B keep the same props, test ids and POST contract.

- [ ] **Step 1: Failing harness test** `print-scorer-sheets.test.tsx`:

```tsx
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ReactElement } from "react";
import { propsOf, renderIsland } from "@/components/__tests__/_hook-harness";

vi.mock("@/components/upgrade-gate", () => ({ UpgradeGate: vi.fn(() => null) }));
import { UpgradeGate } from "@/components/upgrade-gate";
import { PrintScorerSheets, downloadBlob } from "@/components/v2/print-scorer-sheets";

const byTestId = (tree: ReactElement[], id: string) => tree.find((e) => propsOf(e)["data-testid"] === id);
const base = {
  action: "/api/v1/competitions/c1/exports/scorer-sheets",
  days: ["2026-09-23", "2026-09-24"],
  defaultDay: "2026-09-24",
  allowed: true,
  viewerPlan: "pro",
} as const;
const flush = async () => { for (let i = 0; i < 5; i++) await new Promise((r) => setImmediate(r)); };
afterEach(() => vi.unstubAllGlobals());

describe("PrintScorerSheets (scorer sheets §4.4)", () => {
  it("empty case: no printable days → no control at all", () => {
    const island = renderIsland(PrintScorerSheets, { ...base, days: [], defaultDay: null });
    expect(byTestId(island.tree(), "print-sheets")).toBeUndefined();
  });

  it("the picker OPENS AT the default day, not the first option", () => {
    const island = renderIsland(PrintScorerSheets, base);
    expect(propsOf(byTestId(island.tree(), "print-sheets-day")!).value).toBe("2026-09-24");
  });

  it("submit POSTs {date} as JSON to the action and hands the blob to the downloader", async () => {
    const fetchFn = vi.fn(async () =>
      new Response(new Blob(["%PDF-"]), { status: 200, headers: { "content-disposition": 'attachment; filename="s-2026-09-24.pdf"' } }));
    vi.stubGlobal("fetch", fetchFn);
    const download = vi.fn();
    const island = renderIsland(PrintScorerSheets, { ...base, download });
    (propsOf(byTestId(island.tree(), "print-sheets-submit")!).onClick as () => void)();
    await flush();
    expect(fetchFn).toHaveBeenCalledWith(base.action, expect.objectContaining({
      method: "POST", body: JSON.stringify({ date: "2026-09-24" }),
    }));
    expect(download).toHaveBeenCalledWith(expect.any(Blob), "s-2026-09-24.pdf");
  });

  it("a 422 shows the LOCALISED no-matches copy, not the server's English", async () => {
    vi.stubGlobal("fetch", vi.fn(async () =>
      Response.json({ ok: false, error: { code: "NO_FIXTURES_ON_DAY", message: "No fixtures to print on that day" } }, { status: 422 })));
    const island = renderIsland(PrintScorerSheets, { ...base, download: vi.fn() });
    (propsOf(byTestId(island.tree(), "print-sheets-submit")!).onClick as () => void)();
    await flush();
    expect(byTestId(island.tree(), "print-sheets-error")).toBeDefined();
    expect(island.text()).toContain("No matches to print on that day.");
  });

  it("not allowed → the upgrade gate instead of the button", () => {
    const island = renderIsland(PrintScorerSheets, { ...base, allowed: false });
    expect(island.tree().some((e) => e.type === UpgradeGate)).toBe(true);
    expect(byTestId(island.tree(), "print-sheets-submit")).toBeUndefined();
  });
});

describe("downloadBlob", () => {
  it("clicks an anchor carrying the filename, then revokes the object URL", () => {
    const click = vi.fn();
    const anchor = { click, remove: vi.fn(), href: "", download: "" };
    const revoke = vi.fn();
    downloadBlob(new Blob(["x"]), "s.pdf", {
      createElement: () => anchor as unknown as HTMLAnchorElement,
      append: vi.fn(),
      createObjectURL: () => "blob:1",
      revokeObjectURL: revoke,
    });
    expect([anchor.href, anchor.download]).toEqual(["blob:1", "s.pdf"]);
    expect(click).toHaveBeenCalledTimes(1);
    expect(revoke).toHaveBeenCalledWith("blob:1");
  });
});
```
Confirm the harness's `useMsg` resolves English copy (read `_hook-harness.tsx`; if it needs a provider, wrap as other harness tests do). Run → FAIL.

- [ ] **Step 2: Implement** `apps/web/src/components/v2/print-scorer-sheets.tsx`:

```tsx
"use client";
// Scorer sheets §4.4 — the organiser's print control. fetch, not a <form>: the
// response is a file, and an error must stay on this page as localised copy
// rather than navigating to a JSON body. Hidden (by the page) for viewers and
// billing-frozen competitions; gated here for plans without device links.
import { useState } from "react";
import { useMsg } from "@/components/i18n/dict-provider";
import { UpgradeGate } from "@/components/upgrade-gate";

interface DownloadEnv {
  createElement: () => HTMLAnchorElement;
  append: (a: HTMLAnchorElement) => void;
  createObjectURL: (b: Blob) => string;
  revokeObjectURL: (u: string) => void;
}

const browserEnv = (): DownloadEnv => ({
  createElement: () => document.createElement("a"),
  append: (a) => document.body.append(a),
  createObjectURL: (b) => URL.createObjectURL(b),
  revokeObjectURL: (u) => URL.revokeObjectURL(u),
});

export function downloadBlob(blob: Blob, filename: string, env: DownloadEnv = browserEnv()): void {
  const url = env.createObjectURL(blob);
  const a = env.createElement();
  a.href = url;
  a.download = filename;
  env.append(a);
  a.click();
  a.remove();
  env.revokeObjectURL(url);
}

export function PrintScorerSheets({
  action,
  days,
  defaultDay,
  allowed,
  viewerPlan,
  download = downloadBlob,
}: {
  action: string;
  days: readonly string[];
  defaultDay: string | null;
  allowed: boolean;
  viewerPlan: Parameters<typeof UpgradeGate>[0]["viewerPlan"];
  download?: (blob: Blob, filename: string) => void;
}) {
  const msg = useMsg();
  const [day, setDay] = useState(defaultDay ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  if (days.length === 0 || defaultDay === null) return null;
  if (!allowed) return <UpgradeGate feature="scoring.device_links" viewerPlan={viewerPlan} compact />;

  // A calendar day, formatted at UTC noon so the viewer's zone cannot shift it.
  const fmt = (d: string) =>
    new Intl.DateTimeFormat(undefined, { timeZone: "UTC", weekday: "short", day: "numeric", month: "short" })
      .format(new Date(`${d}T12:00:00Z`));

  async function submit() {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(action, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ date: day }),
      });
      if (!res.ok) {
        const code = ((await res.json().catch(() => null)) as { error?: { code?: string } } | null)?.error?.code;
        setError(code === "NO_FIXTURES_ON_DAY" ? msg("sheets.error.noFixtures") : msg("sheets.error.generic"));
        return;
      }
      const name = /filename="([^"]+)"/.exec(res.headers.get("content-disposition") ?? "")?.[1] ?? "scorer-sheets.pdf";
      download(await res.blob(), name);
    } catch {
      setError(msg("sheets.error.generic"));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div data-testid="print-sheets" className="flex min-w-0 flex-wrap items-end gap-2">
      <label className="flex min-w-0 flex-col text-xs text-muted">
        {msg("sheets.day")}
        <select
          data-testid="print-sheets-day"
          value={day}
          onChange={(e) => setDay(e.target.value)}
          className="input mt-1 h-11 min-w-0"
        >
          {days.map((d) => (
            <option key={d} value={d}>{fmt(d)}</option>
          ))}
        </select>
      </label>
      <button
        type="button"
        data-testid="print-sheets-submit"
        onClick={() => void submit()}
        disabled={busy}
        className="btn btn-secondary h-11"
      >
        {busy ? msg("sheets.preparing") : msg("sheets.print")}
      </button>
      {error && (
        <p data-testid="print-sheets-error" role="alert" className="w-full text-sm text-danger">
          {error}
        </p>
      )}
    </div>
  );
}
```
Match the class names (`input`, `btn btn-secondary`, `text-muted`, `text-danger`) to what the schedule page's neighbours use — read before styling.

Mount in `schedule/page.tsx`, main branch only (after the `multiAllowed` early return — the upgrade-gated branch at ~:62 shows no board and gets no print control; say so in the report):

```tsx
  const printable = canEdit && !billingFrozen;
  const [sheetsAllowed, sheetDayList] = printable
    ? await Promise.all([hasFeature(auth.orgId, "scoring.device_links", id), listSheetDays(auth, id)])
    : [false, [] as string[]];
  const defaultDay = defaultSheetDay(sheetDayList, localDateOf(new Date().toISOString(), orgTz));
```
and in the header, turn `<div className="mb-4">` into `<div className="mb-4 flex min-w-0 flex-wrap items-end justify-between gap-3">` and render after the `<h1>`:

```tsx
          {printable && (
            <PrintScorerSheets
              action={`/api/v1/competitions/${id}/exports/scorer-sheets`}
              days={sheetDayList}
              defaultDay={defaultDay}
              allowed={sheetsAllowed}
              viewerPlan={viewerPlan}
            />
          )}
```
(`billingFrozen` is declared below the current insertion point; move the `printable` block after it.) "Today" uses the org's venue clock (`orgTz`), as the board does; a division with its own tz still shows its fixtures on its own local day (T7) — the default is a convenience only.

- [ ] **Step 3: Strings**

| key | en | fr | es | nl |
|---|---|---|---|---|
| `sheets.day` | Day | Jour | Día | Dag |
| `sheets.print` | Print scorer sheets | Imprimer les feuilles de score | Imprimir hojas de puntuación | Scoreformulieren afdrukken |
| `sheets.preparing` | Preparing… | Préparation… | Preparando… | Bezig… |
| `sheets.error.noFixtures` | No matches to print on that day. | Aucun match à imprimer ce jour-là. | No hay partidos que imprimir ese día. | Geen wedstrijden om af te drukken op die dag. |
| `sheets.error.generic` | The sheets could not be prepared. Try again. | Impossible de préparer les feuilles. Réessayez. | No se han podido preparar las hojas. Inténtalo de nuevo. | De formulieren konden niet worden gemaakt. Probeer het opnieuw. |

- [ ] **Step 4: Run** the harness test and the page's existing `schedule/__tests__/venues-prop.test.tsx` (it may need `listSheetDays`/`hasFeature` mocked — add mocks, do not weaken its assertions) → PASS; gate clean.

- [ ] **Step 5: Mutation check**
  - `useState(defaultDay ?? "")` → `useState(days[0])` → killed by "OPENS AT the default day".
  - body sends a hard-coded first day → killed by the POST-body assertion.
  - `!allowed` branch removed → killed by "not allowed → the upgrade gate".
  - error shows the server message → killed by the 422 case's localised-text assertion.
  - `downloadBlob` skips `revokeObjectURL` → killed by the downloader case.
  - page `printable` → `true` → no unit killer (server component); killed by Task 10's "a viewer sees no print control". Record.

- [ ] **Step 6: Commit** — paths + `i18n-keys.ts`; message `feat(schedule): print scorer sheets for a day`.

---

### Task 10: The journey — print → scan → score; smoke; regression; visual gate

**Files:**
- Create: `apps/web/e2e/walkthrough/scorer-sheets-print-scan.spec.ts`
- Modify: `apps/web/src/lib/__tests__/e2e-ci-wiring.test.ts` (`WALKTHROUGH_SPECS`)
- Modify: `scripts/smoke.ts` (beside the device-links 201/402 check, ~:3152)

**Interfaces:**
- Consumes: everything above; e2e helpers `seedScoredDivision(request, names, { decide: false })`, `seedVenueWithCourts`, `createStageAndGenerate`, `competitionPath`, `apiJson`, `setFixtureScheduledAtSql`, `screenshotAtWidths`, `expectNoHorizontalScroll`, `TAG` (`e2e/helpers.ts`); `consentedAnonymousState` (`e2e/scorepad-a11y-kit`).
- Produces: no product code.

- [ ] **Step 1: Read before writing.** Open `e2e/helpers.ts` for the exact return shapes of `seedScoredDivision` (fixture ids? competition slug?), `createStageAndGenerate`, `competitionPath`; `e2e/device-links.spec.ts` for how it drives a generic pad to a result on a device; `components/v2/stages-panel.tsx` for the Swiss Pair / Unpair buttons' testids and the routes they call; and how an existing spec makes a non-editor member context (grep `viewer` / `member` in `e2e/helpers.ts`). Write down the shapes in the task report — the tests below name their assertions; the seeding lines are filled from these reads.

- [ ] **Step 2: The spec.** No `describe.configure({ mode: "serial" })` — each test seeds its own competition, so one red cannot hide the rest (AGENTS 21).

```ts
import { readFileSync } from "node:fs";
import { test, expect, type Page } from "@playwright/test";
import { apiJson, competitionPath, expectNoHorizontalScroll, screenshotAtWidths, seedScoredDivision, TAG } from "../helpers";
import { consentedAnonymousState } from "../scorepad-a11y-kit";

// seedScoredDivision schedules from 2026-09-15 09:00Z at +90 min steps.
const DAY = "2026-09-15";
// The Waiting screen re-renders every POLL_MS (15 s, use-fixture-stream.ts);
// e2e cannot import it, so the budget is that plus slack — keep them in step.
const WAITING_BUDGET_MS = 25_000;

function pdfUris(pdf: Buffer): string[] {
  return [...pdf.toString("latin1").matchAll(/\/URI\s*\(((?:\\.|[^\\)])*)\)/g)].map((m) =>
    m[1]!.replace(/\\([()\\])/g, "$1"),
  );
}

async function printDay(page: Page, schedulePath: string): Promise<Buffer> {
  await page.goto(schedulePath);
  await expect(page.getByTestId("print-sheets-day")).toHaveValue(DAY);
  const [download] = await Promise.all([page.waitForEvent("download"), page.getByTestId("print-sheets-submit").click()]);
  return readFileSync((await download.path())!);
}

test("golden: print the day, scan a QR taken from the PDF bytes, confirm, score to a result", async ({ page, browser }) => {
  const seeded = await seedScoredDivision(page.request, [`Nia ${TAG}`, `Ben ${TAG}`, `Cai ${TAG}`, `Dev ${TAG}`], { decide: false });
  const schedulePath = `${competitionPath(seeded)}/schedule`;
  const pdf = await printDay(page, schedulePath);
  expect(pdf.subarray(0, 5).toString("latin1")).toBe("%PDF-");
  const links = pdfUris(pdf);
  expect(links.length, "one QR per scheduled fixture on the day").toBe(/* fixtures seeded on DAY */ seeded.fixtureIds.length);
  expect(pdfUris(await printDay(page, schedulePath)).sort(), "a reprint keeps every printed QR alive").toEqual([...links].sort());

  const device = await browser.newContext({ storageState: await consentedAnonymousState() });
  try {
    const phone = await device.newPage();
    await phone.goto(new URL(links[0]!).pathname);
    await expect(phone.getByTestId("scan-confirm")).toBeVisible();
    await phone.getByTestId("score-start-match").click();
    // Drive the pad to a result with the same taps e2e/device-links.spec.ts uses.
    // Then:
    //   expect.poll(fixture state via page.request).toBe("decided")
  } finally {
    await device.close();
  }
});

test("knockout: the final's QR waits on 'Winner of …' and confirms WITHOUT a reload once both semis are decided", async ({ page, browser }) => {
  // Seed a 4-entrant knockout, schedule all three fixtures on DAY, print.
  // Phone opens the FINAL's link → `scan-waiting` visible, text contains "R1·1".
  // Organiser decides both SFs via POST /api/v1/fixtures/{id}/events.
  // expect(phone.getByTestId("scan-confirm")).toBeVisible({ timeout: WAITING_BUDGET_MS }) — no phone.reload().
});

test("swiss: a round-1 result goes View-only once round 2 is paired, and returns when it is unpaired", async ({ page, browser }) => {
  // Swiss stage (4 entrants, rounds: 2). Print. Phone scores R1·1 to a result.
  // Organiser clicks the desk's Pair button (the REAL producer — not SQL).
  // Phone reload → `scan-view-only` visible; a raw core.void with the phone's
  // bearer → 403 with code RESULT_CARRIED_FORWARD.
  // Organiser Unpairs → phone reload → no `scan-view-only`; "Void my last entry" visible.
});

test("regression: a console hand-over after printing re-shows the SAME QR; only Revoke & reissue kills it", async ({ page }) => {
  // Print; open the first fixture's page; click the hand-over panel's Show QR.
  // Assert the panel's link === the PDF's URI for that fixture, and
  // GET /api/v1/fixtures/{id}/state with the PDF's bearer → 200.
  // Click Revoke & reissue, confirm → same bearer → 401 LINK_REVOKED (the negative pair).
});

test("regression: a member without edit rights sees no print control", async ({ browser }) => {
  // Non-editor context on /schedule → expect(getByTestId("print-sheets")).toHaveCount(0),
  // positive pair: the organiser's context on the same page → toHaveCount(1).
});

test("visual: Confirm, Waiting, View-only, Dead link and the print control at 320 / 768 / 1280", async ({ page, browser }) => {
  // Seeds with a 43-character entrant name. For each screen:
  //   screenshotAtWidths(<page>, "<screen>", [320, 768, 1280]) and expectNoHorizontalScroll at each.
  // Assert the capture files exist and 320 ≠ 1280 bytes (AGENTS 10).
  // Control-set diff: the ordered list of button/select/link testids-or-labels at 320
  // equals the list at 1280 (membership + order), per screen.
});
```
Each commented body is a REQUIRED test body whose assertions are fixed above; the implementer fills in the seeding lines from Step 1's reads. A body that does not make its named assertions fails review.

- [ ] **Step 3: Register** in `WALKTHROUGH_SPECS`, directly after `"device-pad-carried-forward.spec.ts",`:

```ts
  // Scorer sheets — print a day, scan a QR from the real PDF bytes, confirm,
  // score; knockout Waiting → Confirm; Swiss View-only and back; hand-over
  // keeps the printed QR; the visual gate at 320/768/1280.
  "scorer-sheets-print-scan.spec.ts",
```

- [ ] **Step 4: Smoke** — in `scripts/smoke.ts`, beside the device-links check, reusing its session and seeding helpers exactly:
  - POST `/api/v1/competitions/{id}/exports/scorer-sheets` for a seeded day with a same-origin `Origin` (and once with a foreign `Origin` → `check` 403 from `proxy.ts`) → `check` status 200, `application/pdf`, bytes start `%PDF-`, `private, no-store`.
  - `check` URI count equals the scheduled fixtures that day; POST again → `check` the same URI set.
  - Decide a knockout SF with a bearer taken from the PDF, then `core.void` it with that bearer → `check` 403 and code `RESULT_CARRIED_FORWARD`.
  - A Community org → `check` 402.
  Run `cd /Users/ashokhein/github/seazn.club-worktrees/scorer-sheets && eval "$($S env --label sheets)" && pnpm run test:smoke; echo EXIT=$?` and paste the new checks' lines.

- [ ] **Step 5: Run** — `$S rebuild --label sheets`; the WHOLE spec file three times (AGENTS 8); `e2e-ci-wiring.test.ts` via vitest JSON; the smoke. Then `pdftoppm -r 80 -png <downloaded>.pdf $TMPDIR/sheets` and look at every page.

- [ ] **Step 6: Mutation check (journey level)**
  - `buildScorerSheet` → `createDeviceLink` per fixture → killed by the golden reprint assertion.
  - the panel's Show QR → reissue → killed by the hand-over regression.
  - `ScanWaiting` interval removed → killed by the knockout test (no reload).
  - schedule page `printable` → `true` → killed by the viewer regression.
  - `CHROME_TERMINAL_CODES` emptied → the Swiss test still passes on reload (the page picks View-only itself); its killer is T5's spec. Record that the two specs cover different halves.

- [ ] **Step 7: Per-screen verdicts** — for each screen × width (Confirm, Waiting, View-only carried, View-only finalized, Dead link, print control, each PDF page), write what you SAW: overflow, truncation, tap size, control set. "CI green" is not a verdict (AGENTS 11).

- [ ] **Step 8: Commit** — the three paths; message `test(sheets): print → scan → score journey, smoke and visual gate`.

---

## Self-Review

- **Spec coverage.** §4.1 sealed secret + KEK → T1. §4.2 ensure / reissue / legacy replacement / concurrency → T2, panel → T3. §4.3 carried-forward, evaluated live, session actors unaffected → T4. §4.5 View-only through the real refusal seam → T5; Confirm / Waiting / no-opponent / localised dead link → T6. §4.4 day selection, order, pagination, PDF, route, control → T7–T9. Journeys, smoke, regression, visual → T10. Spec §6 exclusions (auto-advance, engine, Swiss pairing) are in Do NOT touch.
- **Four test types.** Unit: every task. E2E: T5 (carried-forward seam), T6 (all 11 `/score/` specs re-run, one re-pointed), T10 (journey). Smoke: T10. Regression: T6 freshness-floor suite unchanged, T10 hand-over + viewer, T2's existing device-links suite.
- **Seams proven through real producer and consumer.** Refusal: a real inner-pad tap in a browser (T5). QR: URLs read from real PDF bytes and decoded by a real QR decoder (T8), then opened on a phone context (T10). Seeded pad mount: harness test on the real `send()` path (T6) plus the re-pointed realtime e2e.
- **Empty case first:** carried-forward, `scanScreen`, `selectSheetFixtures`, `sheetDays`, `paginateSheet`, `PrintScorerSheets`.
- **Right answer ≠ the wrong one's constant:** Auckland day (T7), court sort vs name (T7), default day ≠ first option (T9), scheduled fixture with a hand-filled feed (T4), finalised vs carried copy (T6).
- **Shared document system (T8):** the renderer reuses `doc-theme`'s `registerFonts`/`FONT`/`PALETTE`/`qrBuffer` and `doc-render`'s masthead/title block — no second QR helper, palette or font set; the route follows the timetable/tickets exports. Glyph coverage was MEASURED (fontkit, 2026-09-23): Inter covers Latin, Vietnamese, Greek, Cyrillic; Barlow Condensed covers Latin/Vietnamese only; neither covers Tamil, Devanagari, Arabic, Hebrew, Thai or CJK — person names are therefore set in Inter, and non-covered scripts print as missing glyphs (a known limit shared with every existing export).
- **Type consistency:** `EnsuredDeviceLink { row, secret, minted }` is the same in T2/T6/T8; `ViewOnlyReason` is defined in T5 and extended in T6, never redefined; `SheetCandidate` is shared by T7/T8; the wire code `RESULT_CARRIED_FORWARD` is pinned against its server source in T5.
- **Accepted survivors, recorded:** the SQL ±1-day window (T7) is an optimisation, not a guard. The carried-forward check runs before the fixture lock (T4), so a Swiss pairing committing in the same instant can let one void through.
- **Where the plan gives assertions rather than code:** T10's five non-golden test bodies and the golden test's pad taps. They depend on e2e helper return shapes and desk testids that Step 1 reads first. Every assertion is named, and review rejects a body that drops one.
