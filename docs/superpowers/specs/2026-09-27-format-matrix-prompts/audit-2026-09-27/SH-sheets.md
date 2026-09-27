# Printable scorer sheets / QR PDF — gap audit (read-only)

Tree: `main` @ 782628af5 (2026-09-27). Scope: #869 (merged 6e1a9f1f9), #885 (`248e38181`, divisionId + date range),
#886 (`ec1bc29c1`, groupBy division), and the scan/QR follow-ups (fe43c4e6d, 1fbe44bac, 0d746cc4e, cf5200273, 764a3484d).

Method: read the spec (`docs/superpowers/specs/2026-09-23-printable-scorer-sheets-design.md`), the help article
(`apps/web/content/help/scoring/scorer-sheets.md`), and every production file on the path:

- the route: `apps/web/src/app/api/v1/competitions/[id]/exports/scorer-sheets/route.ts`
- the loader and builder: `apps/web/src/server/usecases/scorer-sheets.ts`
- the pure selection and paging: `apps/web/src/lib/scorer-sheets.ts`
- the renderer: `apps/web/src/server/scorer-sheet-pdf.ts`
- the links: `apps/web/src/server/usecases/device-links.ts`
- the view-only predicate: `apps/web/src/server/usecases/carried-forward.ts`
- the scan screen table: `apps/web/src/lib/scan-screen.ts`
- the scan page: `apps/web/src/app/score/[token]/page.tsx`
- the device pad: `apps/web/src/components/v2/device-score-pad.tsx`
- the print control: `apps/web/src/components/v2/print-scorer-sheets.tsx`
- the schedule page: `apps/web/src/app/o/[orgSlug]/c/[compSlug]/schedule/page.tsx`
- the match namer: `apps/web/src/server/usecases/scan-match-names.ts`
- the telemetry scrubber: `apps/web/src/lib/scrub-score-url.ts`

I checked the four dictionaries for key parity (en/es/fr/nl, 25 `sheets.*` + `device.scan.*` keys each, none missing).
I listed the test names in every sheet suite and read the three #885/#886 build tests.

**No local test run:** `vitest` in `apps/web` refused to load its config under the local DB env guard. Getting past it
needs a test DB, which this read-only audit did not set up. Every "tested" claim below comes from reading test code,
not from running it.

Legend: ✅ supported and covered · ⚠️ supported by the generic path but untested there, or has a caveat · ❌ not supported / absent.

---

## 1. Format support matrix (does a sheet print correctly?)

| Format | Prints? | TBD / later rounds | Byes | Carried-forward (view-only) | Evidence | Test coverage |
|---|---|---|---|---|---|---|
| League | ✅ | n/a | n/a | only when stage `complete` | `carried-forward.ts:63-71` | ✅ `scorer-sheets.test.ts:125` (league round no.), build tests all league |
| Groups (round robin) | ⚠️ | n/a | n/a | only when group stage complete (no feed edges) | same predicate | ❌ no groups rig in any sheet test or e2e |
| Knockout | ✅ | ✅ "Winner of QF·n" over pen line; half-seated final named per seat | ✅ empty seat + `bracket.slot.bye` label excluded, either side | ✅ winner feed filled | `lib/scorer-sheets.ts:94-105`, `scan-match-names.ts:79-104` | ✅ unit + `print-scan.spec.ts:642` (Waiting→Confirm without reload), fb3f2578c |
| Double elimination | ⚠️ | loser-feed labels via board namer | same bye rule | ✅ loser feed checked | `carried-forward.ts:59-62` | ⚠️ only the scorebug label test (`scan-screens.spec.ts:829`); the conditional GF reset prints with no "if needed" marker (G17) |
| Playoff (page playoff / 3rd place) | ⚠️ | codes Q2·1 / 3rd·1 from board | — | winner/loser feeds | `round-codes.ts` via `boardMatchNamer` | ❌ no sheet test |
| Swiss (paired) | ✅ | — | ✅ paired bye is `forfeited` → excluded | ✅ next round seated (ad-hoc excluded) | `carried-forward.ts:63-70`, `stages.ts:1289-1298` | ✅ `print-scan.spec.ts:745` |
| Swiss (rounds not yet paired) | ⚠️ | prints "TBD vs TBD" per board (by design, help §"When a side isn't decided") | ⚠️ an unpaired **bye shell** has no label, so it is not excluded if it carries a time (G16) | — | `scorer-sheets.test.ts:348`, `stages.ts:1535-1551` | ⚠️ a board removed by reshape kills its card (help documents it) |
| Walkover | ✅ after it is recorded (`forfeited` → excluded) | — | — | — | `PRINTABLE_STATUSES` `lib/scorer-sheets.ts:11` | ✅ status exclusion unit; ⚠️ a withdrawn-but-not-W/O'd fixture still prints (G19) |
| Unscheduled fixtures (any format) | ❌ | — | — | — | `lib/scorer-sheets.ts:104`, `usecases/scorer-sheets.ts:245` | ✅ pinned as excluded (G4) |

## 2. Sport support matrix (score grid vs the sport's model)

There is **no score grid at all**, for any sport. This is the owner's ruling D5 (amended 2026-09-24): "no score,
winner or umpire lines". See `scorer-sheet-pdf.ts:9-10` and the test `scorer-sheet-pdf.test.ts:265`. The card holds
the time, match code, division, both names and a QR. Every sport is modelled on the phone pad that the QR opens
(`page.tsx` → `loadFixturePadCfg`, which includes the stage overlay, so per-stage best-of overrides reach the pad).

| Sport | Paper grid | Scan → Confirm → Start → pad | Per-stage best-of / deciding set reaches pad | Tested from a sheet? |
|---|---|---|---|---|
| Badminton | ❌ (by design) | ⚠️ generic path | ✅ `page.tsx` `loadFixturePadCfg` | ❌ all sheet tests use `sport_key: "generic"` |
| Tennis | ❌ | ⚠️ | ✅ | ❌ |
| Table tennis | ❌ | ⚠️ | ✅ | ❌ |
| Volleyball | ❌ | ⚠️ | ✅ | ❌ |
| Football | ❌ (no goals / shootout box) | ⚠️ lineup catalog uses the DIVISION config, not the stage overlay (pre-existing, noted in `page.tsx`) | ✅ | ❌ |
| Hockey | ❌ | ⚠️ same | ✅ | ❌ |
| Cricket | ❌ (no innings/overs) | ⚠️ in-pad setup after `core.start` (same as console `fixture-console.tsx:1031`) | ✅ | ❌ |
| Generic | ❌ | ✅ | ✅ | ✅ `print-scan.spec.ts:517` (golden: every QR decoded from PDF pixels, one scored to a result) |

Evidence for "generic only": `_sheets-rig.ts:62`, `scorer-sheet-build.test.ts:83,132`, `print-scan.spec.ts:340`,
`scan-screens.spec.ts:533,863,1130`, `handover-panel.spec.ts:286`.

---

## 3. Gap table

| ID | Gap | Evidence (file:line) | Sev | Customer impact (plain) | Read vs inferred |
|---|---|---|---|---|---|
| G1 | **#885/#886 (print one division, date range, group by division) have no UI, and the route is session-only.** No organiser can reach these features. The print control POSTs `{date}` only. No division page, division-schedule page or fixtures tab has a print control. API keys are refused. | `print-scorer-sheets.tsx:95`; `route.ts:30`; `schemas.ts:1584-1601`; `key-scopes.ts:373-375`; `device-links.ts:89-94`; PR #886 body "API only, no UI" | H | An organiser who wants one division's cards, or cards for the whole weekend, cannot get them. It prints every division for one day or nothing. | read |
| G2 | **Printed links never re-check the entitlement.** `scoring.device_links` is gated only when a link is minted or printed. Links now have no expiry (`expires_at null`), and the scoring door never re-checks the plan. | `device-links.ts:217,283,302` (the only gates); `device-links.ts:196-203` (`expires_at` null); `api-v1/auth.ts:237-262` (no feature check) | M | Cards printed on Pro or an Event Pass keep scoring indefinitely after the plan or pass lapses. It is a gating leak that the old end-of-day expiry used to cap. | read |
| G3 | **No bulk revoke.** A PDF holds a whole day's live credentials (QR plus link annotation). The only kill switch is per-match Revoke or Revoke & reissue. | `app/api/v1/fixtures/[id]/device-links/[linkId]/route.ts`, `.../reissue/route.ts`; the only revoke writes are `device-links.ts:194,323` | M | If a sheet or its PDF leaks (posted to a group chat, left on a table), the organiser must reissue every match one by one to lock it down. | read |
| G4 | **Unscheduled fixtures cannot print.** The control is hidden when no fixture has a time. | `lib/scorer-sheets.ts:104`; `usecases/scorer-sheets.ts:245`; `print-scorer-sheets.tsx:60` | M | A club that runs a league or knockout without set match times cannot print scorer sheets at all. | read |
| G5 | **Non-Latin names have no glyphs** (Tamil, Devanagari, Arabic, Hebrew, Thai, CJK). There is no fallback font and no RTL shaping in pdfkit. Owner accepted "no Tamil glyphs" (plan Q10). | `scorer-sheet-pdf.ts:21-26` (coverage comment), `:345-361` (`drawSide`, Inter only) | M | Players with Tamil, Arabic or CJK names print as blank or boxed names, so the umpire cannot check them against the card. | read (code comment); render not run |
| G6 | **No paper fallback and no format on the card:** no sets, games, goals, shootout or overs box, and no "best of 3 to 21". This is by design (D5). | `scorer-sheet-pdf.ts:9-10`, `drawCard :250-275`; spec D5 | M | If the umpire's phone dies or loses signal, there is nowhere on the card to write the score. The card also does not remind them of the format. | read (design choice to re-confirm) |
| G7 | **No real sport is exercised from a sheet.** Every unit, integration, e2e and smoke case uses `generic`. | files listed in §2 | M | A badminton, cricket or football umpire's scan→Start→score path from a printed card has never been driven. A sport-specific setup or lineup break would ship green. | read (tests) / inferred (risk) |
| G8 | **Groups, double-elim and playoff sheets are untested** in the print or scan path. | grep of all sheet tests: only `league`, `knockout`, `swiss`, plus `double_elim` in one scorebug test (`scan-screens.spec.ts:873,888`) | M | Label or view-only mistakes in these formats (e.g. "Loser of WB2·1", group→KO seats) would reach organisers unseen. | read |
| G9 | **A whole-competition print is one long transaction.** `groupBy: division` with no date prints every scheduled day of every division, with per-fixture advisory lock + status read + ensure (+ seal/insert on first print). | `device-links.ts:296-311`; `usecases/scorer-sheets.ts:322-338`; `schemas.ts:1599` | M | A large event's first "print everything" could run long or time out. (It is unreachable today, see G1, but it is the first thing a UI would expose.) | inferred |
| G10 | **A cut-out card carries no court** in the default court mode. The court appears only in the page heading. | `scorer-sheet-pdf.ts:250-257` (card lines: time, ref, division, sides) | L | A card that strays from its court's pile does not say which court it belongs to until scanned. | read |
| G11 | **The scan screen names the court differently from the sheet.** The sheet uses the venue-qualified `courtDisplayName`; the scan page uses bare `crt.name`. | `page.tsx:125,349` vs `usecases/scorer-sheets.ts:212-215` | L | With two venues that each have a "Court 1", the sheet says "Court 1 (Hall B)" and the phone says just "Court 1". | read |
| G12 | **No reprint prompt after a reschedule.** The card prints time and court at print time and stays bound to the fixture. Nothing tells the organiser that printed cards are now stale. | `usecases/scorer-sheets.ts:400-415` (static text); help "Trust the phone" | L | An umpire can hold a card showing the old court or time. The phone shows the new ones, but the pile is on the wrong court. | inferred |
| G13 | **Analytics and filename are wrong for range/division prints.** `scorer_sheets_printed.date` is undefined. The filename says `all-days` even for a bounded range and embeds the raw division UUID. | `route.ts:48`, `route.ts:57` | L | Print analytics under-report multi-day use, and downloaded files get unhelpful names. | read |
| G14 | **`dateFrom > dateTo` is not validated.** It returns 422 "No matches to print on that day". | `schemas.ts:1596-1601`; `lib/scorer-sheets.ts:147-155` | L | A reversed range reads as "nothing to print" instead of "your dates are the wrong way round". | read |
| G15 | **Division sheet order is by division name, not the board's division order.** Same-named divisions would merge into one page run (paging keys on the heading string). The #886 test cannot tell name order from seq order ("Open" < "Second" in both). | `lib/scorer-sheets.ts:130-133`, `:204-205`; `scorer-sheet-build.test.ts:153` | L | Division runs come out in a different order from the schedule board. The test would not notice a regression. | read (order) / inferred (same-name) |
| G16 | **An unpaired Swiss bye shell is not excluded.** `sw-rN-bye` is `scheduled` with both sides null and no label, so `isBye` does not catch it. It prints a "TBD vs TBD" card if it ever carries a time. Whether the scheduler times bye shells was not verified. | `stages.ts:1535-1551`; `lib/scorer-sheets.ts:94-99`; `scorer-sheets.test.ts:348` pins "unlabelled empty seat prints" | L | Possible wasted card whose scan later says "no opponent". | inferred |
| G17 | **A double-elim grand-final reset (`conditional`) prints like any match**, with no "if needed" marker. `isPrintable` ignores `conditional`. | `lib/scorer-sheets.ts:103-105`; `round-codes.ts:171` | L | The umpire may treat an optional reset match as scheduled. | inferred |
| G18 | **Cards for future Swiss rounds can die.** A field-size reshape deletes boards, and a card whose board is gone scans as an invalid link. Documented in help. | `stages.ts:1569-1571`; help "When a printed card stops working" | L | Cards printed on day one for later Swiss rounds may need reprinting after a late withdrawal. | read |
| G19 | **A withdrawn entrant's match still prints** until the walkover is recorded (status stays `scheduled`). | `lib/scorer-sheets.ts:11` | L | A card is printed for a match that will not be played. The Girls' Singles runbook says record the W/O first. | inferred |
| G20 | **The scan-side lineup catalog reads the division config, not the stage overlay** (pre-existing, documented in `page.tsx`). | `app/score/[token]/page.tsx` (comment above `lineupCatalogFor`) | L | Only matters when a team sport gains a stage-overridable team size. It is a known gap, not new with sheets. | read |

**Counts:** H 1 · M 8 · L 11 (20 total).

---

## 4. Spec vs shipped

| Spec item | Shipped? | Note |
|---|---|---|
| D1 one link per fixture, no per-court link | ✅ | |
| D2 TBD sides print slot label, link bound to fixture | ✅ | Label = board namer (`scan-match-names.ts`), pen line (`scorer-sheet-pdf.ts:346-349`) |
| D3 link lives until fixture over; reprint = same QR | ✅ | `expires_at null`, sealed `secret_enc`; smoke checks reprint = same QR set. Side effect: G2 |
| D4 competition schedule page, one day, all divisions, courtless last | ✅ | Only surface. #885/#886 widened the API beyond D4 with no spec amendment and no UI (G1) |
| D5 (amended) 3×3 cut-out grid, B2 QR, no pen lines | ✅ | Geometry and decode tests present (`scorer-sheet-pdf.test.ts:121-230`) |
| D6 view-only once carried forward (§4.3 table) | ✅ | `carried-forward.ts`; the live seam is proven by a real inner-pad tap (`device-pad-carried-forward.spec.ts:314`) |
| D7 umpire starts from Confirm (`core.start`) | ✅ | `device-score-pad.tsx:678` |
| §4.1 `DEVICE_LINK_KEK`, fail closed | ✅ | 503 `DEVICE_LINK_KEK_MISSING`; build test `:334` |
| §4.2 `ensureDeviceLink`, hand-over never kills a print, Revoke & reissue | ✅ | Regression e2e `print-scan.spec.ts:882` |
| §4.4 POST route, session-only, 6/min, `private, no-store`, 422/500 codes | ✅ | |
| §4.4 every card's link proven in one query before printing | ✅ | `unprovenLinks` `usecases/scorer-sheets.ts:261-287` + 6 mutation-style tests |
| §4.4 org clock for day and times | ✅ | Divergence from the board's viewer-clock day tabs is documented, not fixed (ruling) |
| §4.4 strings in 4 dictionaries | ✅ | en/es/fr/nl parity 25/25 |
| §4.4 "Works at 320" + Community UpgradeGate | ✅ | `print-control.spec.ts` WIDTHS 320/768/1280 + pill widths |
| §4.5 Confirm / Waiting / View-only / Dead link | ✅ + "Not started yet" screen added (fe43c4e6d) | |
| §4.5 Waiting polls only while waiting | ✅ | `router.refresh` loop; perf fix e9283f28f |
| §5 Unit / integration / e2e / smoke / regression / visual | ✅ for the day print | ❌ none of the #885/#886 params in e2e or smoke; ❌ no real-sport sheet test (G7); ❌ groups/DE/playoff (G8) |
| §5 OpenAPI regenerated | ✅ | `openapi/v1.json` in each commit |
| Plan Q4 Rebuild dialog warns about printed sheets | ✅ | `handover-panel.spec.ts:270` |
| Telemetry: token never in a URL sent to third parties | ✅ | `scrub-score-url.ts`, replay block cf5200273; Referrer-Policy strict-origin-when-cross-origin (`next.config.js:9`). Memory notes the check-in and API-keys QR replay leak is still unfixed (outside sheets) |
| §6 out of scope: frozen-comp mint (D8), knockout void un-fill | D8 left as is; un-fill shipped separately (#856) | |

### Security notes (no defect found)
- Token: `dl_` + 32 random bytes base64url (`device-links.ts:22-24`), stored as sha256 plus an AES-GCM envelope. It is not
  guessable. A probe of a foreign fixture with a valid link is rate-limited (`auth.ts:260-262`).
- The URL is never printed as text. The PDF link annotation does carry it, so the PDF file itself is a credential bundle (see G3).
- The QR origin comes from `baseUrl(req)` (`lib/oauth.ts:20-33`). It is safe when `NEXT_PUBLIC_BASE_URL`/`OAUTH_BASE_URL` is
  set. Otherwise it follows `x-forwarded-host`, which is only the organiser's own request. Not verified which env prod sets.
