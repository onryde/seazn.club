# Printable scorer sheets — one QR per fixture, per court, per day

Status: design, owner-approved section by section 2026-09-23. Spec awaiting owner review.

## 1. Goal

An organiser prints, for one competition day, a PDF with one section per
court. Each row is a fixture: time, division, match reference, both sides'
names (or the feeder label when a side is still TBD) and a QR code. The
organiser hands the court's sheet to the umpire; the umpire scans the row for
the match about to be played and scores it on their phone — including starting
it. No organiser action is needed per match.

## 2. Owner decisions (2026-09-23)

| # | Question | Ruling |
|---|---|---|
| D1 | What does the umpire scan? | **One link per fixture.** No per-court link. |
| D2 | TBD sides | Link is bound to the fixture, not the entrants — print the slot label (`Winner of QF1`), score once filled. |
| D3 | Link lifetime | **Until the fixture is over** (see §4.3). No end-of-day expiry. Reprint shows the **same** QR. |
| D4 | Where / what one print covers | **Competition schedule page, one day**, one section per court, all divisions, `Unassigned` last (printed "No court assigned"). |
| D5 | Page layout | ~~List sheet, 5 rows per page, not cut-out cards.~~ **Amended 2026-09-24 (owner-approved after seeing both rendered): full-width 3×3 grid of cut-out cards, 9 per page**, branded QR "B2", no result pen lines — §4.4 and §4.4.1. |
| D6 | What an old sheet can do after the round moves on | Rule table §4.3 — view-only once the result is carried forward. |
| D7 | Who starts the match | **The umpire, from the device pad.** The confirm screen's button is `Start match` (`core.start`). |
| D8 | Frozen-competition gap (UI-only guard) | Leave as is. |

Facts the owner corrected during design: **unpair does not delete a Swiss
fixture** — it clears the sides and the next pairing refills the same row. A
printed Swiss sheet therefore stays bound to the board and scores whatever
pairing it currently holds.

## 3. Current state (re-pinned 2026-09-23 against main c22e4df93, after W3 #845; re-pin again before building)

- Mint: `createDeviceLink` (`apps/web/src/server/usecases/device-links.ts:121`) —
  session editor only (`requireSessionEditor` :87), `requireFeature("scoring.device_links",
  competition)` so an Event Pass lifts it (:128), 422 on `finalized`/`cancelled` (:138),
  `expires_at = endOfLocalDay` (venue tz: division → org → UTC), **revokes every prior
  live link for the fixture** (one live device). Secret stored as `token_hash` only,
  returned once.
- Resolve: `resolveDeviceLinkToken` (:249) — `LINK_INVALID` / `LINK_REVOKED` / `LINK_EXPIRED`.
- Console gate: `f/[no]/page.tsx:224` `deviceHandover` and `fixture-console.tsx:679`
  `canHandOver = deviceHandover && scoring && home && away`. The server does NOT require
  both sides; the UI does.
- Scoring refusals: only `finalized` and `cancelled` lock appends
  (`engine-db/append-event.ts:169`). Stage, division and competition status are never
  checked (`usecases/scoring.ts:449` checks only setup/scheduled phase). Device-link
  actors additionally may not finalize, may not void once finalized, may only void their
  own events (`scoring.ts:457-475`). They **may** send `core.start`.
- A decided / forfeited / abandoned fixture still accepts `core.void`, which reverts the
  result (`packages/engine/src/core/events.ts:188-214`).
- Advancement: `onDecided → fillSlot` (`scoring.ts:621-653`, `stages.ts:3544`) writes the
  winner/loser into `winner_to_fixture`/`loser_to_fixture` **only while the target side is
  null**. Next Swiss round refused while any seated board of the previous one is unsettled
  (`stages.ts:1068`, `STAGE_NOT_READY`). Stage completion requires counted fixtures settled
  (`engine-db/competition.ts:596`).
- TBD labels: `fixtures.home_slot_label/away_slot_label` (V360), rendered by
  `resolveSlotLabel` (`apps/web/src/lib/slot-label.ts:55`). Swiss shells have null sides
  and no label.
- Scan page: `app/score/[token]/page.tsx` already selects `court_name`, `scheduled_at`,
  `division_name`, `round_no` (:87-89; `scheduled_at` is never passed to the pad) but never
  slot labels. `device-score-pad.tsx` shows plain `TBD` (:292, :296), gates start/undo (:322)
  and mounts the inner pad only when `home && away` (:359). `home`/`away` are props with no
  state; neither pad nor page has `router.refresh` or a timer.
- Side fills DO emit a `state_changed` broadcast (reason `schedule`) to the target fixture
  (`scoring.ts:339`, `schedule.ts:150`), but `useFixtureStream` ignores it (onSignal fetches
  events only, `use-fixture-stream.ts:168`) — and while a side is null no stream is mounted
  at all. Pad poll: `POLL_MS = 15_000` (`use-fixture-stream.ts:21`, unexported).
- Inner-pad 403s classify as `rejected` (`transport.ts:295-297, 362-363`); the only
  inner→chrome channel is `onEvents` (`registry.tsx:204, 299`). Only the chrome's own
  `send()` errors (`device-score-pad.tsx:175`) reach `DeviceScorePad`.
- PDF/QR: `pdfkit` + `qrcode` installed; pattern of record is
  `app/(public)/shared/[orgSlug]/[competitionSlug]/poster.pdf/route.ts` with
  `server/doc-render.ts` / `doc-theme.ts`.
- Encryption: `server/relay/crypto.ts` `seal`/`open` (AES-256-GCM, per-row DEK under
  `RELAY_KEK`), held to a single-module boundary by `enc-boundary.test.ts`.

## 4. Design

### 4.1 Data

Migration on `device_links`:

- `secret_enc bytea null` — the plaintext secret sealed under a **new** key
  `DEVICE_LINK_KEK` (separate from `RELAY_KEK`: one leaked key must not open both).
  `token_hash` remains the only lookup path.
- `expires_at` becomes nullable. New links write `null`.

Crypto: generalise `server/relay/crypto.ts` so `seal`/`open` take the KEK (or add a
sibling keyed wrapper); `enc-boundary.test.ts` admits `device-links.ts` as the one new
caller. `DEVICE_LINK_KEK` is added to `.env.example`, CI env and Fly secrets (stg + prod).

### 4.2 Link issuance — `ensureDeviceLink(auth, fixtureId)`

- Same auth + entitlement gate as `createDeviceLink`.
- Live link (not revoked, not expired) **with** `secret_enc` → open it, return the same
  secret. No write.
- Otherwise (none, or only a legacy hash-only link) → revoke, mint, seal, store, return.
- Refuses a fixture that is `finalized`/`cancelled` (as now). **Allows null sides.**

Callers:
- Scorer-sheet PDF route (§4.4), per fixture.
- Console hand-over switches from `createDeviceLink` to `ensureDeviceLink` — a hand-over
  must never kill a printed sheet.
- New explicit **Revoke & reissue** action (console + v1 endpoint) keeps today's
  revoke-then-mint semantics for a lost sheet.

Legacy hash-only links keep working until their `expires_at`.

### 4.3 What a device link may do (enforced server-side, device-link actors only)

| Fixture state | Link may |
|---|---|
| `scheduled` / `in_play` | score (incl. `core.start`) |
| decided / `forfeited` / `abandoned`, result **not** carried forward | void its own events (fix a mistake right after the match) |
| result **carried forward** | nothing — 403 `RESULT_CARRIED_FORWARD` |
| `finalized` / `cancelled` | nothing (existing refusals) |
| fixture deleted | `LINK_INVALID` (row cascades) |

**Carried forward** = any of, evaluated at request time:
1. its `winner_to_fixture` / `loser_to_fixture` target has the corresponding side filled;
2. it is a Swiss board and any board of round `round_no + 1` in the same stage has a side seated;
3. its stage is `complete`.

The predicate's first test is the empty case — no feed targets, no later round, stage not
complete — which must answer "not carried forward". Because it is evaluated live, unpairing
round N+1 re-opens round N for the umpire's own undo.

The organiser's session is unaffected; corrections after carry-forward are the organiser's.

`resolveDeviceLinkToken` keeps resolving links for finalized/cancelled/carried-forward
fixtures (the pad needs to render View-only); refusal is in the scoring path, not the
resolver.

### 4.4 Print route

- Button **Print scorer sheets** on `app/o/[orgSlug]/c/[compSlug]/schedule/page.tsx` with a
  day picker (default: today if it has fixtures, else the next day that does). Community
  without an Event Pass sees `UpgradeGate feature="scoring.device_links"`. Works at 320.
- `POST /o/[orgSlug]/c/[compSlug]/schedule/scorer-sheets.pdf` (POST: it may mint), body
  `{ date: "YYYY-MM-DD" }`. Session editor only; rate limited per user.
- Fixtures: `scheduled_at` inside that day on the **org clock** (`organizations.timezone`
  → UTC, `resolveVenueTz(null, orgTz)`), never a division's own tz override. This follows
  the repo rule in `usecases/schedule.ts` (`ScheduleSettingsOut`: "anything doing
  calendar-day math wants `orgTz`"), because a printed sheet must not depend on the device
  that prints it (controller ruling 2026-09-24, Task 7 review). Times print on that clock
  too. The competition board's day TABS are a different clock: `dayKey`
  (`lib/schedule-board.ts`) buckets on the VIEWER's device clock (ruling R8,
  `c/[compSlug]/schedule/page.tsx`); `orgTz` there governs only the date/time controls
  the organiser types in. So when the printing device is outside the org's zone, a
  fixture can sit under one day tab on the board and on a different day's sheet. Exclude `finalized`, `cancelled`, `decided`, `forfeited`
  (byes), `abandoned`, and a bye line still waiting for its draw (an EMPTY seat stamped
  `bracket.slot.bye`).
- Grouping: court order, then time, then match reference. No court → a "No court
  assigned" section last.
- **Layout (amended 2026-09-24, owner-approved):** A4 portrait, full width — 8 mm edges
  all round, a 3×3 grid of cut-out cards (≈64.7 × 78.8 mm each) divided by dashed cut
  lines, cards in time order left→right, then top→bottom. 9 cards per page
  (`ROWS_PER_PAGE`); a court continues onto the next page with its header repeated.
- Page header: the masthead (Pro `exports.branded` only), competition name (held to two
  lines), the date, and — beside the title, right-aligned — the court heading with its own
  page count (`COURT 2 · PAGE 1 OF 2`) and "Scan to score. Check names on screen before
  you start." Footer: printed-at and `seazn.club`; page numbering is per court, in the
  heading.
- Card: time · the board's match code (`QF·2`, `R1·3`) · division · both sides (entrant
  display name via `entrantDisplayName`, else `resolveSlotLabel`, else `TBD`). A name wraps
  to two lines, then takes an ellipsis; a doubles pair prints one member per line; a TBD
  side prints its slot label over a pen line. **No score, winner or umpire lines** —
  scoring happens on the phone the QR opens. Then the QR of `<origin>/score/<token>` (§4.4.1),
  which is also a link annotation. The URL and token are never printed as text: the token
  is a bearer secret.
- Rendering: pdfkit + qrcode on the shared document theme. Strings in the organiser's
  locale, keys added to all 4 dictionaries (+ `gen-keys`).

#### 4.4.1 The printed QR — "B2" (owner-approved 2026-09-24)

Error correction **H**; square navy data modules; **solid rounded navy finders** (7×7 ring
with outer corner radius **2.0 modules** and a solid one-module band, 3×3 centre rounded at
0.6 module — the 1:1:3:1:1 ratio holds on every centre line); the Seazn app icon
(`public/logo-square.png`), **12 mm** square (≈8.4% of the symbol), centred over a
knocked-out odd square of modules that leaves at least **one module of white** round it.
At least 4 modules of white separate the symbol from the text above and from the cut lines.

Decode evidence (jsQR, one crop per card):
- Variant B (dotted finders) decoded 0/9 in every condition — jsQR never finds dotted
  finders — hence solid rounded finders. Radius sweep on the 41.4 mm prototype symbol
  (`pdftoppm`, 90 dpi / 72 dpi / B&W): outer radius 1.5, 2.0 and 2.5 decoded 9/9
  everywhere; 0.5 and 1.0 (a rounded centre in a square hole) missed 2/9 at 90 dpi, with or
  without the icon; 3.0 and 3.5 missed 1–2/9. 2.0 is the centre of the passing band.
- Shipped renderer, 12 mm icon, radius 2.0, 10 cards (one TBD), under both a plain header
  and the tallest one (Pro masthead + two-line title): `pdftoppm` raster **10/10** at 72,
  80, 90, 100, 150 and 300 dpi and on a simulated black-and-white laser copy at 90 dpi;
  the only miss is 60 dpi under the tallest header (1/10, ≈1.8 px per module).
- CI gate: the page's vector drawing rasterised by librsvg (sharp; CI has no poppler) at
  90 dpi, 72 dpi and the B&W copy — every card decodes to its own row's URL.
- The low-radius misses depend on where the module edges fall on the pixel grid: at the
  shipped renderer's symbol sizes, radius 1.0 decodes 10/10 in every condition above. So
  no decode test can hold the line at 1.0, and the approved 2.0 is pinned by a geometry
  test instead. The icon size is load-bearing: a 16 mm icon under the tallest header
  decodes 0/10 at every radius.

### 4.5 Scan screens (`app/score/[token]/page.tsx` + `device-score-pad.tsx`)

Page additionally loads court, scheduled time, division, match ref and both slot labels.

1. **Confirm** — both sides known, status `scheduled`: card with court, time, division,
   ref, names; button **Start match** sends `core.start` and opens the pad. `in_play` skips
   straight to the pad.
2. **Waiting** — a side is null: "Waiting for **Winner of QF1** vs **Ben Lim**" + "This
   page updates by itself". No stream is mounted while a side is null, so the chrome
   re-checks fixture metadata (sides + labels) every `POLL_MS` while — and only while —
   waiting (`cache: "no-store"`), then moves to Confirm and the inner pad mounts. This is
   an interval, which W3 §5 avoided on the console to not double a live stream's polling;
   here no stream exists during Waiting, so nothing doubles. The `state_changed`
   (`schedule`) broadcast is NOT used as the trigger: CI cannot join realtime and the
   broadcast is a floating promise (W3 §7b), so it could only ever be a speed-up.
3. **View only** — carried forward / finalized / cancelled: final scoreboard, no controls,
   "Match over — result carried forward. Ask the organiser to correct it." (or finalised /
   cancelled wording). A live pad whose tap is refused with `RESULT_CARRIED_FORWARD`
   switches here. **No such path exists today** — an inner-pad 403 is classified
   `rejected` and never reaches the chrome. Build it: transport classifies this code as
   terminal and the pipeline surfaces it through a new registry callback (beside
   `onEvents`) that `DeviceScorePad` consumes. This is a seam — prove it by a REAL
   inner-pad tap in e2e, not a stubbed callback.
4. **Dead link** — revoked / deleted: existing screen.

Coordination: W3 (#845) has merged. **G1** (device-pad freshness floor, standalone fix,
branch `fix/device-pad-freshness-floor`) edits `device-score-pad.tsx` and lands first;
this work rebases onto it. The waiting re-check stays out of `useFixtureStream` (which is
unmounted during Waiting and fetches events only).

UI bar: mobile-first, screenshots of all four screens and the print control at 320 / 768 /
1280, no horizontal page scroll.

## 5. Testing

Each change ships a test that fails without it; each guard is mutated (predicate deleted /
`return true`) and must turn a test red.

- **Unit:** `ensureDeviceLink` idempotence and legacy replacement; seal/open round-trip and
  tamper → throw; the carried-forward predicate over its full table (empty case first,
  winner feed, loser feed, Swiss next round seated, then unpaired, stage complete);
  day selection (tz midnight edge, terminal-status exclusion, Unassigned, ordering).
- **Integration (real DB):** PDF route mints then re-returns the same tokens; a
  device-link void after carry-forward → 403 `RESULT_CARRIED_FORWARD` while a session
  editor's void on the same fixture passes; Community → 402, Event Pass lifts.
- **E2E (real producer → real consumer):** print → extract a token from the PDF →
  `/score/<token>` → Start match → score to decided; pair the next round → rescan → View
  only. TBD: open a semi-final link → decide its feeder → Waiting flips to Confirm without
  reload. Run the whole spec file, not a `-g` slice.
- **Smoke:** sheet route returns `application/pdf` with the expected QR count.
- **Regression:** console hand-over after printing keeps the printed QR valid.
- **Visual:** §4.5 screens + print control at 320/768/1280; PDF rendered to an image and
  checked non-blank with QRs present.
- OpenAPI regenerated for the changed/new device-link endpoints (CI drift check).

## 6. Out of scope

- Per-court QR (D1).
- Server-side frozen-competition check for minting (D8).
- Whether an organiser's void of a carried-forward result pulls the advanced entrant back
  out of the next fixture — `fillSlot` only fills nulls; unverified, own investigation.
- Possible defect: `maybeAutoAdvance` (`scoring.ts:737`) counts `finalized` as open, so a
  finalized fixture may block auto-advance. Unreproduced; own investigation.
