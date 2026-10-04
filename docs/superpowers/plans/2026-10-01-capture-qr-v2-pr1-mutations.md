# Capture QR v2 PR-1 — the mutation table (spec §11.1.3, rule 5)

The killer list the spec requires in the PR. Every row was **run** on the integrated tree in one sweep (T10, 2026-10-04,
on top of `7c5f30b2d`), because two guards that cover for each other only show up together (AGENTS.md class 3).

**How each row was run.**

- Exactly one textual replacement, which had to match once.
- Then the killer files, through vitest's JSON reporter, reading `numTotalTests` and `numFailedTests`.
- Then a restore from a `cp` backup, proven with `cmp`.

Every restore printed `RESTORED ok`. Each kill's failure MESSAGE was read, not just its count: a mutant can "die" on the
wrong leg. Totals were pinned against a baseline of the 20 killer files (606/606 green) before the sweep.

**The model column.** It is the T10 fast-check model (`capture-model.test.ts`, seed 20261004, 200 runs,
`CAPTURE_MODEL_SHRINK=0`) run against the same mutant. Each kill was read as the property's own `Got …` line, never a
zero-reach count. The model is a second killer for the ordered-action rows, not a replacement for the named one:
11 of the 12 rows it was run on were killed, and the survivor is explained in its row. "—" means not run.

Paths are under `apps/web/src/`. Guards are named by function and predicate, not line, so the table survives edits.

## §11.1.3, row by row

| # | Spec mutant | Guard in the current code | Mutant as run | Killed by (file — test) | Red / total | Model |
|---|---|---|---|---|---|---|
| 1 | `timingSafeEqual` → `===` | `server/usecases/stream-codes.ts` `tokMatches` | `timingSafeEqual(given, stored)` → `given.equals(stored)` | `stream-codes.test.ts` — "C1: the right tok resolves … each of the three runs timingSafeEqual exactly once" (the structural pin is a pass-through spy on `node:crypto`; message: `expected [] to have a length of 1`) | 1 / 32 | — |
| 2 | drop the dummy-hash compare for an unknown code | `tokMatches` (`storedHex ?? DUMMY_TOK_HASH`) | `if (storedHex === null) return false;` before the compare | the same C1 case: the unknown code runs **no** compare (`expected [] to have a length of 1`) | 1 / 32 | — |
| 3 | serve `cred` to any valid tok | `capture-phone.ts` `sessionDescriptor` `wantCred` (phone and slot equal the session's) | `wantCred = openState` | `capture-get.test.ts` — "an OPEN warming session: its own phone gets … cred; another phone … cred ABSENT" (the G0-d two-phone case), "live and ending … cred to the session's phone only", "credentials_served_count moves by exactly 1" | 3 / 40 | killed — `#3: cred to A (not the open session's phone)` |
| 4 | C1b always true | `relay/domain/stream-code.ts` `SERVES_ROWS` C1(b) | the C1(b) row's `when` → `i.status === "ended"` | `capture-beat.test.ts` — "C1b / C3 / T30 through the REAL reissue: … a `new` claim on it is 401"; `stream-codes.test.ts` C1b/C3; `capture-start.test.ts` "C1b: an ENDED (reissued) code starts NOTHING"; `capture-get.test.ts` C1b/C3 (14 red in all) | 14 / 130 | killed — `C1/C3: a GET through an ended code` |
| 5 | C2 drop "no open session" | `stream-code.ts` `STATUS_ROWS` `expiry_due` row | drop `!i.hasOpenSession &&` | `stream-code.test.ts` — "an open session DEFERS expiry (W2: never ends a live session)"; `stream-codes.test.ts` — "C2: an OPEN session defers the expiry" (ensure) and "C2: an open session DEFERS the expiry on resolve too" (a live session's phone answered `401 code_ended`, T34's case) | 3 / 71 | — |
| 6 | A9 refusal removed (T3) | `relay/domain/pairing.ts` `CLAIM_ROWS` T3 | T3 row deleted | `capture-beat.test.ts` — "T3: a LIVE slot whose phone is beating refuses B's `new` claim — `taken`" (+ T4 one-at-a-time, G0-g, T24a, anti-vacuity); `pairing.test.ts` — "T3: `new` … on a live slot … taken" and the every-input sweep (T3 unreached) | 7 / 55 | killed — `T4: a live slot is taken over only when its phone is dead (A14)`; the pinned late-stop sequence too |
| 7a | T4: drop the beat conjunct | `pairing.ts` `deadForTakeover` conjunct 1 | `since(lastBeatAt) >= window &&` removed | `pairing.test.ts` — "conjunct 1 fails alone: a beat inside the window (1 ms short)"; `capture-beat.test.ts` — "T4's conjuncts ONE AT A TIME" | 2 / 55 | killed — the same T4 assertion |
| 7b | T4: drop the CF conjunct | `deadForTakeover` conjunct 2 | `&& !i.freshReadConnected` removed | `pairing.test.ts` — "conjunct 2 fails alone: a fresh Cloudflare read says the input IS connected"; capture-beat "T4's conjuncts ONE AT A TIME" | 2 / 55 | — |
| 7c | T4: drop the sample conjunct | `deadForTakeover` conjunct 3 | `&& since(lastConnectedAt ?? liveSince) >= window` removed | `pairing.test.ts` — "conjunct 3 fails alone" and "no connected sample at all: the clock runs from liveSince"; capture-beat "ONE AT A TIME" | 3 / 55 | — |
| 8 | T6 `resume` treated as `new` | `pairing.ts` `CLAIM_ROWS` T6 | T6 `result: "replaced"` → `"takeover"` | `capture-beat.test.ts` — "T5 / T6 / T7 … T6: resume never steals"; `pairing.test.ts` — "T6: resume from a phone that is not current — replaced, in every slot state" and the every-input sweep | 3 / 55 | killed — `T6: expected 'live' to be 'replaced'`; the pinned late-stop sequence too |
| 9 | T24: on `stopped: X`, close the fixture's open sid instead of X | `capture-phone.ts` `postBeat` step 4, the `stopped` lookup by id | `where id = ${body.stopped}` → `where id = ${open?.id ?? body.stopped}` | `capture-beat.test.ts` — "T24: `stopped: X` for an X that has ENDED → `over X` …; the newer Y stays open" (Y was closed) | 1 / 31 | killed — `#5: <sid> was stopped (operator_stopped) by a step that did not name it` |
| 10 | T24a: drop the "current phone holds X" check | `postBeat` `stopApplies = callerCurrent \|\| !heldByCurrent` | `stopApplies = true` | `capture-beat.test.ts` — "T24a: a NON-current phone's late `stopped: X` while the current phone holds X is IGNORED" (`expected 'completed' to be 'warming'`) | 1 / 32 | killed — #5 as row 9; the pinned "A's late stop must not end B's live broadcast" too |
| 11 | T23: apply the hold check to the current phone too | the same `stopApplies` | `stopApplies = !heldByCurrent` | `capture-beat.test.ts` — "T23: `stopped: X` on the current phone's paired beat closes X (operator_stopped)" | 1 / 32 | killed — `the spec ends <sid> in this step` (the current phone's own stop was ignored); the pinned positive pair too |
| 12 | `phone_not_paired` gate removed | `relay/domain/session.ts` `admit` W5 line | the line deleted | `stream-sessions.test.ts` — "W5: an organiser Go live with NO phone paired → 409 phone_not_paired" + the silent phone, the §6.7.1 and §17.10 ORDER cases, the storage-read order, Revoke & reissue, the superseded pairing, D1's floor (12 red) | 12 / 269 | killed — `W5: no present phone on the active code: expected null to be 'phone_not_paired'` |
| 13 | pollSeconds near window off by one | `relay/domain/poll-seconds.ts` `nearWindowOpen` | `>=` → `>` | `poll-seconds.test.ts` — "T−30 min ± 1 s: … the window's edge and inside it are near" | 1 / 10 | — |
| 14 | ask 10 without `first_ingest_at IS NULL` | `relay/domain/phone-lost.ts` `warmingPhoneLost` | `i.firstIngestAt !== null \|\|` removed | `phone-lost.test.ts` — "first_ingest_at set → never (that is W19's case)"; `stream-tick.test.ts` — "a session WITH first_ingest_at is never ended by ask 10 — a warming reconnect" | 2 / 71 | **survived** (4/4 green), expected: `warming` is entered only from `provisioning` (`session.ts` decide), so a warming session WITH first ingest is unreachable through the use-cases; the named killers build that row by hand |
| 15 | W19: drop the beat conjunct | `phone-lost.ts` `livePhoneLost` | `beatAge >= limitMs &&` removed | `stream-tick.test.ts` — "BEATING while the input is down, for 20 min: not ended", "14 min 59 s on EACH clock alone", the beat race, W24 agreement; `phone-lost.test.ts` — "each clock 1 s short, alone → not lost" (6 red) | 6 / 71 | killed — `#10: <sid> ended phone_lost live with beat 0 ms, video 1080000 ms` |
| 16a | W19: drop the fresh-read conjunct | `livePhoneLost` | `&& !i.freshReadConnected` removed | `stream-tick.test.ts` — "the FRESH read alone holds it"; `phone-lost.test.ts` — "a fresh read that says connected → not lost" | 2 / 71 | — |
| 16b | W19: drop the connected-sample conjunct | `livePhoneLost` | `&& videoAge >= limitMs` removed | `stream-tick.test.ts` — "14 min 59 s on EACH clock alone … (video at 14:59)"; `phone-lost.test.ts` — "each clock 1 s short, alone" | 2 / 71 | — |
| 17a | W19: `>` for `≥` | `livePhoneLost` | both `>=` → `>` | `stream-tick.test.ts` — "the last connected sample at exactly the limit", "14 min 59 s … one second later it is", the B0/FP17 freshness case, m-3's unknown read, two ticks at once (16 red) | 16 / 71 | — |
| 17b | W19: 14 for 15 | `relay/config.ts` `PHONE_LOST_LIVE_MINUTES` | `15` → `14` | `relay/__tests__/config.test.ts` — "the guard pins the DEFAULTS: … 15 min lost" and "capture QR v2 constants equal the spec's own figures" (see note 1) | 3 / 94 | — |
| 18 | ask 10 at a flat 60 s (drop the cadence term) | `warmingPhoneLost` (`isSilent(lastBeatAt, cadence, …)`) | → `now − lastBeatAt ≥ floor` | `phone-lost.test.ts` — "a 60 s-cadence phone that has not heard go-live is NOT ended at 60 s, and IS ended at 90 s", the shortened-floor case; `stream-tick.test.ts` — "NOT ended 1 ms before §6.9's silence" | 4 / 71 | — |
| 19 | `preferred: "srt"` while `cred.srt` is null | `relay/ingest-cred.ts` `ingestCred` | `preferred: srtCred ? QR_PREFERRED_DEFAULT : "rtmps"` → `QR_PREFERRED_DEFAULT` | `ingest-cred.test.ts` — "srtEnabled false (A18): srt is null and preferred is rtmps"; `capture-get.test.ts` — "STREAM_SRT_ENABLED=false (A18)" (the SRT-off descriptor case) | 3 / 49 | — |
| 20 | purge deletes the session's final beat | `server/usecases/relay-sweep.ts` step 7b | the cutoff `${cutoff}` → `${now}` | `relay-sweep.test.ts` — "W10: … keeps the session's FINAL beat" (`expected 3 to be 1`) | 1 / 47 | — |
| 21 | `no-store` removed from an error path | `server/api-v1/capture-http.ts` `captureJson` + `captureRoute`'s last pass | both, for `status ≥ 400` | `get-route.test.ts` — "A17/C1: … the SAME 401 body, each no-store", the 404 and 503 cases; `beats-route.test.ts` — "no Authorization and a wrong tok … each no-store" (20 red) | 20 / 30 | — |
| 22 | consume not run for `startCause operator` | `session.ts` `decide` `ingest_connected` → `consume_credit` | the effect dropped when `s.startCause === "operator"` | `capture-start.test.ts` — "MONEY: the operator start consumes ONCE, at live" (`one credit at live: expected +0 to be -1`) | 1 / 109 | killed — `#11: the fixture's consume rows are W23's count: expected +0 to be 1` |
| 23 | the `ENV_NAME` gate on the fake-ingest route removed | `app/api/internal/relay/fake-ingest/[inputId]/route.ts` `fakeControlEnabled` | `→ env.RELAY_DRIVERS === "fake"` | its `route.test.ts` — "404: stg + fake", "404: prod + fake", "404: unset ENV_NAME + fake" | 3 / 9 | — |

## The two guards behind row 21, one at a time (AGENTS.md class 3)

Row 21's no-store lives in two places: `captureJson`, and `captureRoute`'s last pass over whatever `handler()` answered.

| Mutant | Killed by | Red / total |
|---|---|---|
| 21b: `captureJson` alone omits no-store on an error | `get-route.test.ts` — "already_live carries its extras …" (`captureRefusal` answers without the route) | 1 / 30 |
| 21c: the route's last pass alone skips an error | **survived (0 / 30) on the first sweep**: no answer reached a client without `captureJson`. Gap closed with a new case in `get-route.test.ts` — "an answer captureJson never built still leaves private, no-store …" (a refusal whose extras the wire refuses escapes to `handler()`'s own 500). Re-run: **killed**, `expected [ null, null ] to deeply equal [ 'private, no-store', 'no-cache' ]` | 1 / 31 |

## T9 (`GET /fixtures/{id}/stream-phone`, the W24 countdown)

These were run on this tree at `ecc96f1c3`. No product file changed between T9 and this sweep.

| Mutant | Killed by |
|---|---|
| the usecase's org scope dropped | `stream-phone.test.ts` — "org scope … 404" |
| the code row spread (`select *`) into the answer | 16 / 17 (the strict schema parse in every read) |
| the no-pairing branch removed (phone) | "C-1 … no phone facts" |
| the no-pairing gate on `lastTakeover` removed | "C-1 … no takeover" |
| the held pairing ignores `ended_at` | "an OPEN session whose own pairing has ENDED" |
| the current pairing ignores `ended_at` | T2, T21 and the ended-pairing case |
| the countdown's `has_phone` gate dropped | `stream-tick.test.ts` W24 — "C-1 … no countdown" |
| the countdown read from `heartbeat_at` | W24 LIVE "1 ms inside the quiet hold" and O5 "beating" |
| the countdown ignores a connected read | O5 — "a fresh connected read, no sample" |
| the countdown never computed | all 4 W24 cases |
| the `NEVER_KEY_ROUTES` entry removed | `key-scopes.test.ts` — "consciously classified" |

## Guards from later rulings (B7 review M-5)

These guards come from rulings made after §11.1.3 was written, and they live on this branch, so they belong on the PR's
killer list. Each was run once in the B7 fix round, on top of `42da4429d` plus the fix round's model. The method is the
same as above: one replacement, a `cp` restore checked by `cmp`, and the message read.

The model column is the fixed model (twelve invariants, seed 20261004, 200 runs, `CAPTURE_MODEL_SHRINK=0`). Its baseline
across the 11 killer files was 374/374.

| Ruling | Guard | Mutant as run | Killed by (file — test, message) | Red / total | Model |
|---|---|---|---|---|---|
| C-1 (phone-less sessions keep today's rules) | `stream-sessions.ts` `phoneLostEnd`: `if (!f.has_phone) return null` | `if (false && !f.has_phone) …` | `stream-tick.test.ts` — the four C-1 LEGACY/T35 cases (`the 5 s poll: expected 'completed' to be 'warming'`) | 4 / 45 | survived, as expected: every model session starts on a pairing, so none is phone-less |
| m-3 (an `unknown` read never ends a session) | `phoneLostEnd`: `fresh !== "unknown"` | the conjunct dropped | `stream-tick.test.ts` — the m-3 case (`claimed unknown: expected 'completed' to be 'live'`) and the I-1 countdown case | 3 / 45 (1 is the model) | killed — `#10: … ended phone_lost live … script unknown, sample unknown` |
| W23 (three free restarts) | `relay/domain/credits.ts` `restartIsFree`: `a.used < limit` | `<=` | `credits.test.ts` — "used 3 → not free"; `restart-allowance.test.ts` — BOUNDARY, NO VIDEO, NEVER BLOCKS, AGREEMENT, the refunded anchor, and its own SEQUENCE property | 8 / 23 (1 is the model) | killed — `the paid live wrote its consume row: expected undefined to be defined` (a free 4th) |
| W23 (only a restart with video counts) | `stream-credits.ts` `restartAllowance`: `and s.first_ingest_at is not null` | the line dropped | `restart-allowance.test.ts` — NO VIDEO (`used: 4` against 3) and its SEQUENCE property | 3 / 14 (1 is the model) | killed — `#11: the fixture's consume rows are W23's count: expected 2 to be 1` |
| C-2 (a reissue never ends the open session's phone) | `stream-sessions.ts` `phoneFactsOf`: the pairing join reads NO code state | the join gains `and exists (… fixture_stream_codes … ended_at is null)` | `stream-tick.test.ts` — "C1b/C3 (T30): after Revoke & reissue the old code still serves the open session's phone" (`reissued: … expected 'completed' to be 'warming'`) | 2 / 45 (1 is the model) | killed — `#10 (ask 10): … ended phone_lost after 0 ms of silence` |
| W5 (Go live asks the ACTIVE code's phone) | `stream-sessions.ts` `currentPhoneOf`: `and c.ended_at is null` | the filter dropped | `stream-sessions.test.ts` — "W5 after Revoke & reissue (T30, C3) …" (the Go live resolved instead of refusing) | 2 / 192 (1 is the model) | killed — `W5: a present phone is admitted: expected 'phone_not_paired' to be null` (the revoked code's pairing was read first) |
| B4 m-2 (a phone start carries the code's issuer and its pairing) | `capture-phone.ts` `postStart`'s actor | `pairingId: current.id` → `null` | `capture-start.test.ts` — 12 cases, through `startBroadcast`'s own refusal (`a phone start rides the slot's pairing, and none was given`) | 12 / 28 | — |
| B4 m-2, its other half | the same actor | `userId: resolved.issuedBy` → `null` | `capture-start.test.ts` — the same 12 (`a phone start is attributed to its stream code's issuer, not to user null`) | 12 / 28 | — |
| B6 R-1 (budgets keyed on the credential) | `api-v1/capture-http.ts` `capturePhoneRoute`: `capture-code:${code}:${who}` | `capture-code:${code}` | `limits-route.test.ts` — R-1's wrong-tok flood (`{ '401': 119, '429': 6 }` against `{ '401': 125 }`) and the 16-hex key shape | 2 / 9 | — |
| B6 I-1 (a valid tok is never refused by the 401 budget) | `capturePhoneRoute`: the fail budget is spent only in the 401 `catch` | the fail budget also spent before every call | `limits-route.test.ts` — CAPTURE_FAIL_LIMIT (`failure 16: expected 429 to be 401`), the valid-tok admission under R-1 (`valid request 31: expected 429 to be 200`), CAPTURE_CODE_LIMIT, the proxy-header order, "counts 401s ONLY" and the file's anti-vacuity | 6 / 9 | — |
| B6 I-2 (the rescan re-seat) | `capture-phone.ts` `postBeat`: `claim.result === "accept" && holder !== null && holder.code_id !== resolved.codeId` | `false && …` | `capture-beat.test.ts` — "I-2: the session's phone RESCANS the new QR …" (`ONE current pairing, A's, on the NEW code`) | 3 / 35 (2 are the model's) | killed — `the open session's phone and its code are the model's`, and the seed-55 regression |
| B6 M-6 (the lazy `code_ended`, with its C1b exemption) | `stream-codes.ts` `resolveStreamCode`: `!(callerIsOpenSessionPhone && sessionCreatedBeforeEnd)` | the exemption dropped | `capture-beat.test.ts` — "M-6: … the open session's phone is never ended by its refused claim" (`expected … to be null`) and "C1b / C3 / T30 through the REAL reissue" | 3 / 35 (1 is the model) | killed — `the open session's phone and its code are the model's: expected [ null, null ] …` |

## The B7 fix round's own guards

| Finding | Guard | Mutant as run | Killed by (file — test, message) | Red / total | Model |
|---|---|---|---|---|---|
| W24 ⇔ W19 (I-1 as re-ruled 2026-10-04: the live countdown only on a FRESH `disconnected`) | `relay/domain/phone-lost.ts` `lostCountdown`: `i.read.fresh !== "disconnected"` | `i.read.served !== "disconnected"` (the served word, carry included) | `stream-tick.test.ts` — "W24 ⇔ W19" (`no-evidence read carrying disconnected (G-a): countdown shown, the tick at W19's deadline left live/null`) and `phone-lost.test.ts`'s empty case | 2 / 110 | — |
| The same gate's input | `stream-sessions.ts` `currentSession`: `fresh: freshIngest` | `fresh: ingestState?.state ?? undefined` | "W24 ⇔ W19" (the same message) | 1 / 110 | — |
| N1: a status read that threw holds the warming timeout | `lostCountdown`: `const timeoutLeft = i.read.failed ? null : …` | `false ? null : …` | "W24 ⇔ the EARLIEST warming end" (`the status read throws: the tick at the countdown's end makes the end it named: expected null to be 'no_inbound_timeout'`), "I-1: a FAILED read", and two `phone-lost.test.ts` cases | 4 / 110 | — |
| The same gate's input | `currentSession`: `failed: phoneReadFailed` | `failed: false` | "W24 ⇔ the EARLIEST warming end" (the same message) and "I-1: a FAILED read" | 2 / 110 | — |
| Only the STATUS read holds it (the expiry never reads the outputs) | `tickSession`: `phoneReadFailed = false` right after `inputStatus` answers | moved after `outputState` | "W24 ⇔ the EARLIEST warming end" (`the outputs read throws (the status read answers): no countdown, so no end: expected 'no_inbound_timeout' to be null`) | 1 / 110 | — |
| The timeout fires whatever the word (M-4) | `lostCountdown`: `timeoutLeft` reads `failed` only | `i.read.failed \|\| i.read.served !== "disconnected" ? null : …` (I-1's first reading, applied to warming) | "W24 ⇔ the EARLIEST warming end" (`claimed unknown: no countdown, so no end: expected 'no_inbound_timeout' to be null`) and two `phone-lost.test.ts` cases | 3 / 110 | — |
| A failed read has no fresh word | `lostCountdown`: the `RangeError` on `failed` with a `fresh` word | deleted | `phone-lost.test.ts`'s empty case (`fresh connected on a failed read`) | 1 / 110 | — |
| Ask 10 reads no word | `phoneLostEnd`: `if (warmingPhoneLost({ … ...ask10PhoneOf(f) }` | `if (fresh !== undefined && warmingPhoneLost({…` | `stream-tick.test.ts` — "ask 10 reads no ingest word" (`no-evidence read with nothing to carry, the phone is silent: left warming/null`) and "W24 ⇔ the EARLIEST warming end" (`silent since pairing, the status read throws: … expected null to be 'phone_lost'`) | 2 / 44 | — |
| The earliest end: ask 10 is a warming target (controller ruling 2026-10-04) | `phone-lost.ts` `lostCountdown`: `if (ask10 !== null && …) return { …, reason: "phone_lost", … }` | the line deleted (the ask-10 target dropped) | `stream-tick.test.ts` — "W24 ⇔ the EARLIEST warming end" (`silent since pairing, disconnected: 1 s before the countdown's end (no_inbound_timeout) it is still open: expected 'phone_lost' to be null`), and seven `phone-lost.test.ts` cases | 8 / 110 | — |
| Armed only once beats stopped: the phone's own cadence | `ask10Countdown`: `beatAge < Math.max(cfg.quietSeconds, cadence + BEAT_LATE_SECONDS) * 1000` | `cfg.quietSeconds * 1000` | `phone-lost.test.ts` "armed exactly when beats have stopped" (`answered 60 s, not heard go-live: 1 s short of armed`) and "m-a: a far-cadence phone right after Go live" (`round trip 1 s`); `stream-tick.test.ts` "m-a through the poll" (`the go-live beat in flight: no countdown`) | 3 / 89 | — |
| … and the quiet hold | the same line | `(cadence + BEAT_LATE_SECONDS) * 1000` | the same test (`answered 5 s, heard go-live: 1 s short of armed`) | 1 / 89 | — |
| m-a (re-review): a beat a full near poll late, not merely in flight | the same line: `+ BEAT_LATE_SECONDS` | dropped (`cadence) * 1000`, round 3's arming) | the same three as the cadence row: "armed exactly" (`answered 60 s, not heard go-live: 1 s short of armed`), "m-a: … right after Go live" (`round trip 1 s`), "m-a through the poll" (`the go-live beat in flight: no countdown`) | 3 / 89 | — |
| The EARLIER end wins | `lostCountdown`: `ask10.remainingMs < timeoutLeft` | the comparison dropped (ask 10 whenever armed) | "W24 ⇔ the EARLIEST warming end" (`heard go-live, silent from +9:20, disconnected: 1 s before the countdown's end (phone_lost) it is still open: expected 'no_inbound_timeout' to be null`), and the domain's ordering and tie cases | 3 / 110 | — |
| A tie goes to the timeout (the tick expires first) | the same comparison: `<` | `<=` | `phone-lost.test.ts` "a tie goes to the warming timeout" | 1 / 110 | — |
| A held timeout is no candidate (N1) | `lostCountdown`: `timeoutLeft === null \|\| …` | `timeoutLeft !== null && …` | "W24 ⇔ the EARLIEST warming end" (`silent since pairing, the status read throws: no countdown, so no end: expected 'phone_lost' to be null`) and the domain's failed-read case | 2 / 110 | — |
| `connected` shows neither end | `lostCountdown`: `if (i.read.served === "connected") return null` | deleted | `phone-lost.test.ts`, both connected cases (the tick reaches it only in M-7's race) | 2 / 110 | — |
| No current pairing owes ask 10 now | `ask10Countdown`: `if (!p.hasCurrentPairing) return { elapsedMs: 0, remainingMs: 0 }` | `return null` | `phone-lost.test.ts` "no current pairing" (a race: the tick that ran first already ended it) | 1 / 110 | — |
| The countdown reads the tick's own floor | `stream-sessions.ts` `currentSession`: `silentFloorSeconds: tunable("PHONE_SILENT_FLOOR_SECONDS", …)` | `silentFloorSeconds: 0` | "W24 ⇔ the EARLIEST warming end" (`heard go-live, silent from +20 s, unknown: the tick at the countdown's end makes the end it named: expected null to be 'phone_lost'`) | 1 / 110 | — |
| m-b (re-review): Go live evaluates C2 at W5's lookup (§6.12 "Code ended: no Go live") | `stream-sessions.ts` `currentPhoneOf`: `if (codeStatus(…) === "expiry_due") { wipeStreamCodeTok(…); return null; }` | `if (false && codeStatus(…` | `stream-sessions.test.ts` "C2 at W5's lookup" (`at the grace (C2's ≥): expected { Object (sessionId) } to be an instance of HttpError`) | 1 / 16 (the W5 slice) | killed at run 6 (CI seed, unshrunk; `finish(goLive)`) — `C2 at W5's lookup: a code past its grace answers no Go live: expected null to be 'phone_not_paired'` |
| … an open session defers it there too | the same call: `c.open` | `false` | the same test (`an open session defers C2: expected { …(2) } to deeply equal { ended_at: null, end_cause: null }`) | 1 / 1 | — |
| M-6 (T9: refused reads write nothing) | `stream-phone.ts` `streamPhone`: the org check BEFORE the code block | the org check moved after the C2 write | `stream-phone.test.ts` — "org scope …" (`the three refused reads wrote nothing`) | 1 / 17 | — |
| I-3 (#8 on the answers) | `relay/domain/beat-answer.ts` `ANSWER_ROWS` row 6: `i.slot === "armed"` | `… \|\| i.slot === "live"` (a live slot answers `go-live`) | the model only — and the PRE-fix model survives it (4 / 4 green, run in this round), which is I-3's finding | 1 / 4 | killed — `#8: a beat answering go-live … ⇒ no ingest yet` |
| M-2 (T4 owed, not only allowed) | `capture-phone.ts` `postBeat`: `const dead = takeoverFacts !== null && …` | `const dead = false && …` (never a takeover) | the model | 1 / 4 | killed — `M-2: T4 is owed — the live slot's phone is dead on a claimed read` |
| M-4 (an owed W19 end is made) | `phoneLostEnd`'s W19 clause | `… && false && livePhoneLost(…)` | the model (`stream-tick.test.ts` kills it as well: every W19 case) | 1 / 4 | killed — `M-4: W19 was owed for … at this tick and it is still open` |

## Notes

1. **Row 17b survived its first run on `phone-lost` and `stream-tick` alone, by design.** Those suites derive every
   boundary from `PHONE_LOST_LIVE_MINUTES` itself (TEST-STRATEGY: never type the expected value into the test), so a
   changed constant moves them with it. The VALUE is pinned against the spec's own figure in `config.test.ts`, and that
   file kills it. Listing it as the killer is the point of the row.
2. **Row 5 (T34).** No test is named T34. The spec's case — a live session's phone gets 401 → red — is
   `stream-codes.test.ts` "C2: an open session DEFERS the expiry on resolve too". Under the mutant it answered
   `CaptureRefusalError: this stream code is no longer valid`.
3. **Row 9 needs the lookup itself mutated.** The literal mutant (`stop = open.id` after the `isActive(X)` check) never
   fires on T24's case, because X has ended. So the mutant swaps the sid the lookup reads, which is what "close the
   fixture's open sid instead of X" means.
