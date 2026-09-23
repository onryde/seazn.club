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
| D4 | Where / what one print covers | **Competition schedule page, one day**, one section per court, all divisions, `Unassigned` last. |
| D5 | Page layout | **List sheet**, 5 rows per page, not cut-out cards. |
| D6 | What an old sheet can do after the round moves on | Rule table §4.3 — view-only once the result is carried forward. |
| D7 | Who starts the match | **The umpire, from the device pad.** The confirm screen's button is `Start match` (`core.start`). |
| D8 | Frozen-competition gap (UI-only guard) | Leave as is. |

Facts the owner corrected during design: **unpair does not delete a Swiss
fixture** — it clears the sides and the next pairing refills the same row. A
printed Swiss sheet therefore stays bound to the board and scores whatever
pairing it currently holds.

## 3. Current state (verified 2026-09-22/23, re-pin before building)

- Mint: `createDeviceLink` (`apps/web/src/server/usecases/device-links.ts:121`) —
  session editor only (`requireSessionEditor` :87), `requireFeature("scoring.device_links",
  competition)` so an Event Pass lifts it (:128), 422 on `finalized`/`cancelled` (:138),
  `expires_at = endOfLocalDay` (venue tz: division → org → UTC), **revokes every prior
  live link for the fixture** (one live device). Secret stored as `token_hash` only,
  returned once.
- Resolve: `resolveDeviceLinkToken` (:249) — `LINK_INVALID` / `LINK_REVOKED` / `LINK_EXPIRED`.
- Console gate: `f/[no]/page.tsx:224` `deviceHandover` and `fixture-console.tsx:534`
  `canHandOver = deviceHandover && scoring && home && away`. The server does NOT require
  both sides; the UI does.
- Scoring refusals: only `finalized` and `cancelled` lock appends
  (`engine-db/append-event.ts:169`). Stage, division and competition status are never
  checked (`usecases/scoring.ts:449` checks only setup/scheduled phase). Device-link
  actors additionally may not finalize, may not void once finalized, may only void their
  own events (`scoring.ts:458-474`). They **may** send `core.start`.
- A decided / forfeited / abandoned fixture still accepts `core.void`, which reverts the
  result (`packages/engine/src/core/events.ts:188-214`).
- Advancement: `onDecided → fillSlot` (`scoring.ts:621-653`, `stages.ts:3439`) writes the
  winner/loser into `winner_to_fixture`/`loser_to_fixture` **only while the target side is
  null**. Next Swiss round refused while any seated board of the previous one is unsettled
  (`stages.ts:1013`). Stage completion requires counted fixtures settled
  (`engine-db/competition.ts:596`).
- TBD labels: `fixtures.home_slot_label/away_slot_label` (V360), rendered by
  `resolveSlotLabel` (`apps/web/src/lib/slot-label.ts:55`). Swiss shells have null sides
  and no label.
- Scan page: `app/score/[token]/page.tsx` never selects slot labels; `device-score-pad.tsx`
  shows plain `TBD` and hides start/undo unless both sides exist (:292-359). Entrants arrive
  as page props — the realtime stream does not carry side fills.
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
- Fixtures: `scheduled_at` inside that day in the venue tz (division override → org tz →
  UTC); exclude `finalized`, `cancelled`, `decided`, `forfeited` (byes), `abandoned`.
- Grouping: court order, then time, then match reference. No court → `Unassigned`
  section last.
- Page header: competition name, date, court, and "Scan to score. Check names on screen
  before you start."
- Row: time · division · match ref (`R1 M3`, `SF1`, `Round 3 · Board 2`) · sides (entrant
  display name via `entrantDisplayName`, else `resolveSlotLabel`, else `TBD`) · a pen line
  when a side is TBD · QR of `<origin>/score/<token>`.
- 5 rows per page; a court continues onto the next page with its header repeated. Footer:
  printed-at and page n / m.
- Rendering: pdfkit + qrcode following `poster.pdf`. Strings in the organiser's locale,
  keys added to all 4 dictionaries (+ `gen-keys`).

### 4.5 Scan screens (`app/score/[token]/page.tsx` + `device-score-pad.tsx`)

Page additionally loads court, scheduled time, division, match ref and both slot labels.

1. **Confirm** — both sides known, status `scheduled`: card with court, time, division,
   ref, names; button **Start match** sends `core.start` and opens the pad. `in_play` skips
   straight to the pad.
2. **Waiting** — a side is null: "Waiting for **Winner of QF1** vs **Ben Lim**" + "This
   page updates by itself". Side fills emit no score event, so the page re-checks every
   15s while waiting (`cache: "no-store"`; must not rebuild the stream subscription —
   see the inline-`auth` resubscribe trap), then moves to Confirm.
3. **View only** — carried forward / finalized / cancelled: final scoreboard, no controls,
   "Match over — result carried forward. Ask the organiser to correct it." (or finalised /
   cancelled wording). A live pad receiving `RESULT_CARRIED_FORWARD` switches here.
4. **Dead link** — revoked / deleted: existing screen.

Coordination: device-link scoring gaps W3 (realtime seam,
`2026-09-21-device-link-scoring-gaps-design.md` §5) is next in that programme and touches
the same pad subscription. Whichever lands second rebases onto the other; the waiting
re-check stays out of `useFixtureStream`.

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
