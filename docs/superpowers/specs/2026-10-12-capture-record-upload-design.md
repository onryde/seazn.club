# Capture record upload — design (approved)

**Status:** **approved** by the owner on 2026-10-12 ("approve all", relayed by the coordinating session): every
proposal P1–P11 and the owner questions Q1, Q2, Q3, Q5 and Q9. The questions to capture (Q4, Q6–Q8) were answered by
the capture team on 2026-10-12, relayed by the coordinating session (§12); capture corrected its Q7 answer the same day
(`engine-error` closes no window). The owner ruled the same day that a bad line
is DROPPED, not refused (ruling RL, §0). Implemented by the PR that adds `POST /api/v1/capture/codes/{code}/records`
(branch `feat/capture-record-upload`).
**Contract:** `docs/contracts/capture-record.v1.json` (served by the records route, twinned in `capture-schemas.ts`), with fixtures in
`docs/contracts/fixtures/capture-record.v1/`. Its sha256 and fixtures are pinned by
`apps/web/src/server/api-v1/__tests__/capture-contract.test.ts`.
**Builds on:** `2026-10-01-capture-qr-v2-design.md` (§4 envelope, §5.1 code machine, §6.3 phone API, §10 security,
§10.4 rate limits, §17.5 R5 `at`).
**Asked for by:** capture's brief `docs/specs/2026-10-11-s1-d3-web-brief.md` §1 (capture repo), which cites the
owner's rulings R3 and R4 in `2026-10-11-s1-d3-findings-design.md`.

## 0. Rulings and approved proposals

R3, R4 and RD are the owner's rulings from the brief. On 2026-10-12 the owner also approved every proposal below as
written, and answered the owner questions of §12. The cross-code rule was agreed between the web and capture
sessions; the owner then approved A1's reading of "belongs" (Q9).

| # | What | Status |
|---|---|---|
| R3 | Only the operator's tap sends, with _Send record to Seazn_. Nothing uploads by itself. | **Owner ruling**, 2026-10-11 |
| R4 | The server accepts a record from any currently valid token of the code, including a replaced phone's. The app keeps the token for 24 h after an unpair, for uploads only. | **Owner ruling**, 2026-10-11 |
| RD | The app shows only the ref ("Sent — ref R-7K2Q") and says nothing about dropped lines. The server still returns `dropped`, and the app ignores it. | **Owner ruling**, 2026-10-12 |
| RL | **A bad line is DROPPED, never the body refused.** A line that fails the line check — a secret-shaped value (S1–S5), a key off the allow-list, a value off its class (`sid`, `tokenTag`, `at` included), a line that is not JSON or not UTF-8 — is dropped and never stored, logged or echoed; the rest of the record is stored. The count of such lines is stored apart (`invalid_lines`, §9) and shown to staff, so a scrub leak can be spotted. The wire answer stays `{ref, kept, dropped}`, `dropped` covering both kinds; the app ignores it (RD). Body-level refusals stay: 413 `too_large` (the line or byte limits, the decompression cap), 401, 429, and 422 for a body that cannot be read as lines or has none (P10). If every line is dropped, the answer is still 201 with `kept: 0`. | **Owner ruling**, 2026-10-12 (relayed by the coordinating session) |
| A1, A2 | Cross-code attribution (§6) | Agreed rule (web and capture); A1's pairing-based reading **Approved** (owner, 2026-10-12), Q9 |
| P1 | Path `POST /api/v1/capture/codes/{code}/records` | **Approved** (owner, 2026-10-12) |
| P2 | 10 records an hour per code, in a bucket of its own (§8) | **Approved** (owner, 2026-10-12) (capture's number) |
| P3 | 413 answers a new word, `too_large` | **Approved** (owner, 2026-10-12), Q2 |
| P4 | 422 `invalid` for a disallowed key or a secret-shaped value | **Retired** by ruling RL (owner, 2026-10-12): such a LINE is dropped. `invalid` stays the 422 word for a body that cannot be read as lines or has none |
| P5 | Storage shape (§9), including recording `dropped_lines` with the record | **Approved** (owner, 2026-10-12) |
| P6 | 30-day retention | **Approved** (owner, 2026-10-12) |
| P7 | Admin view placement (§10): staff, in `/admin`, beside the session | **Approved** (owner, 2026-10-12), Q5 |
| P8 | Secret-shaped rules S1–S5 (§5), each skipping the scrub's mask | **Approved** (owner, 2026-10-12) |
| P9 | The ref: `R-` and 4 upper-case Crockford characters, at most 8 | **Approved** (owner, 2026-10-12) |
| P10 | Empty cases: 0 lines is 422; a record whose every line was dropped is 201 with `kept: 0`, stored as counts with no lines | **Approved** (owner, 2026-10-12) |
| P11 | Validity is `codeServes` with a new call, `record` (§4), with no phone condition, plus a 24 h tail (Q1). Trade-off, accepted: a revoked tok (perhaps from a leaked QR) can write records while the old session is open and for 24 h after, bounded by 10 an hour, 1 MB each and staff-only reading | **Approved** (owner, 2026-10-12), Q1 |

## 0.1 Premises checked against both trees (the dispatch is a hypothesis)

| Premise | What the code says | Consequence |
|---|---|---|
| "Every line has `at` (ms epoch)" | **False.** Both of capture's writers write ISO 8601 UTC with milliseconds, e.g. `2026-10-11T21:19:03.123Z` (`IsoTime.utc` in `Json.kt`, `toISOString` in `src/services/sessionRecord.ts`). | `at` reuses the beat's R5 shape (§5). A ms-epoch `at` is refused (fixture `line-invalid-at-epoch-ms`). |
| "Every line has `level`" | **False.** `level` is left out when it is `info` (CD7). Native masks a level it does not vet as `***`. | `level` is optional, and absent means `info`. |
| "`tokenTag` derivation is an open question" | **It is defined.** It is FNV-1a 32-bit over the token's UTF-16 code units, as 8 lowercase hex digits (`src/domain/credentials/tokenTag.ts`, `TokenTag.kt`, `modules/capture-engine/src/wire/token-tag-vectors.json`, carry 2). Only the `pair` line carries it (`Pairings.kt:41`). | Q8: capture confirmed it final (2026-10-12). |
| "Re-pairs mint new tokens for the code" | **Not on this server.** A code row holds exactly one tok (`fixture_stream_codes.tok_hash`). Revoke & reissue mints a **new code**, with a new code string and a new tok (`reissueStreamCode`, `mintLocked`). A re-scan of the same QR presents the same tok. | Today, "every token ever issued for this code" is one token: the Bearer that sent the record. |
| "The server must derive the tag from what it stores per pairing" | Pairings store no token. A code stores `sha256(tok)`, which is kept, and a sealed tok, which is wiped when the code ends. FNV-1a(tok) cannot be computed from `sha256(tok)`. | **No dependency today:** the server computes `tokenTag(Bearer)` on each request and stores nothing. **D1:** if a code can ever hold more than one tok, each tok's tag must be stored when it is minted, because the sealed tok is wiped. |
| "Admin view next to the session in /admin" | `/admin` has no stream-session view. The only staff page for a single fixture is `/admin/fixtures?id=` (a lookup by id). | §10 places it beside the session in `/admin` (P7, Q5, approved). |
| The scrub drops what is not allowed | **It masks instead.** An unexpected key leaves the phone as `"key":"***"`, a never key as `"tok":"***"`, and a number, boolean or null passes under **any** key (`scrub.ts`, `SessionRecord.kt`). | Capture drops unlisted keys before Send (Q4, answered); a line the server still finds off the list is dropped, not the body refused (ruling RL). |
| A credential in free text leaves the phone as a secret | **It is masked in place.** Capture's `vectors.json` case 22 turns `srt://h:1?passphrase=pass%2Bphrase%2F6d1e8b0c&x=1` into `srt://h:1?passphrase=***&x=1`. | Every secret-shaped rule skips the mask, so capture's correct output is admitted (§5, review fix 1). |
| `capturePhoneRoute` lets a route choose its budget | **It does not.** It spends `CAPTURE_CODE_LIMIT` on every route (`capture-http.ts:137`). | The records route needs a branch there (§8). |
| Where the record is shown | Capture's brief asks for "the console next to the session, for org admins only". This dispatch says `/admin`, for staff. | The owner chose staff in `/admin`, beside the session (Q5). |

## 1. Purpose

When a stream goes wrong, the operator taps _Send record to Seazn_ on the phone. The app posts its scrubbed on-device
record, which is the last 1000 lines. Staff read the record to diagnose the stream. The operator reads the ref aloud
to the organiser, and the organiser passes it to support. Nothing uploads automatically (R3).

## 2. Actors

- **Operator** (the phone): taps Send and sees _Sent · ref R-7K2Q_ or _Couldn't send — try again_. Nothing else (RD).
- **Organiser:** hears the ref and passes it to support.
- **Staff:** read the record in `/admin` (§10).
- **The server:** authenticates the code's tok, validates the lines, drops other codes' lines, stores the rest and
  answers.
- **Not actors:** any other org, whose lines never land here (§6), and any automatic process (R3).

## 3. Endpoint (P1, approved)

`POST /api/v1/capture/codes/{code}/records` sits beside `…/beats`, `…/start` and `…/scoring-link`. The route file
would be `apps/web/src/app/api/v1/capture/codes/[code]/records/route.ts`. It runs inside `capturePhoneRoute` with a
new route kind, `"records"`, which gives it the house behaviour:

- `Cache-Control: private, no-store` on every answer;
- the bare `{code, message}` refusal envelope;
- an unmapped error answers `503 unavailable`;
- every 401 spends the client IP's failed-attempt budget.

The rate limit is the exception. `capturePhoneRoute` spends `CAPTURE_CODE_LIMIT` on every route today
(`capture-http.ts:137`), so the implementing PR owes a branch on the route kind there (§8).

**Not idempotent.** Each tap makes a new record with a new ref. Two taps store two records.

## 4. Authentication and validity (P11 and Q1, approved)

- The phone sends `Authorization: Bearer <tok>`, exactly as beats do (`captureBearer`). A missing or malformed header
  is `401 code_ended` (A17).
- The server resolves the code with `resolveStreamCode`: it looks the code up, then compares `sha256(tok)` with
  `tok_hash` in constant time. A wrong tok or an unknown code is `401 code_ended`, with no oracle. A malformed code is
  `404 not_a_stream_code`.
- **No holder check (R4).** Unlike start and scoring-link, a phone that is not the slot's current phone may send. The
  route takes no `phone` id and reads none, so `resolveStreamCode` runs with `phone = null`, and its lazy
  `code_ended` write on a pairing never fires for a record.
- **"Currently valid" is `codeServes`, the server's own rule (`stream-code.ts:45-48`), with a new `CodeCall`
  (`:24`), `record`:**
  - **C1(a):** an ACTIVE code serves `record`. So does a FINISHING one. A code is FINISHING once its fixture has
    finished, for as long as either holds: it is inside the grace (`CODE_GRACE_AFTER_FINISH_MINUTES`, 120 by
    default), or a session is still open. An open session defers expiry past the grace (C2, `stream-code.ts:30-31`).
  - **C1(b), extended to `record`:** an ENDED code (reissued, or expired) serves `record` under the same session
    condition C1(b) sets for `get` and `beat`: the fixture still has an open session that was created before the
    code ended. It drops C1(b)'s phone condition, because R4 lets a phone that no longer holds the slot send, and the
    route reads no phone id. This is what R4's "any currently valid token" means on this server. The old code's tok
    still serves the open session after Revoke & reissue, so a replaced phone holding it may send.
  - **The trade-off, which the owner accepted on 2026-10-12 within the bounds below.** Dropping the phone condition
    means a REVOKED tok can write records for as long as the old session stays open, and for C1(c)'s 24 h after.
    That includes a tok from a leaked QR, which may be the very reason the organiser revoked the code.
    - **What bounds it:** 10 records an hour, at most 1 MB each, and only staff ever read a record (P7). A record
      cannot start, stop, claim or beat, and nothing it holds reaches the org or the public. Its lines still pass the
      allow-list and S1–S5, and A1/A2 keep only lines that belong to the code.
    - **What it costs:** staff may read junk lines from whoever holds the leaked QR, attributed to that session.
    - **The alternative, not taken:** keep C1(b)'s phone condition for `record`. The route would then read the phone
      id, and only the phone still streaming the open session could send under an ended code.
  - **C1(c), the 24 h tail (Q1, approved).** An ENDED code serves `record` for 24 h after it last served under C1(a)
    or C1(b), with no phone condition. The app keeps its credential for 24 h after Over and Replaced, and `tok_hash`
    survives the end, so the tok can still be checked. The 24 h run from the LATER of:
    - the code's own end: `ended_at` for a reissue, or, for an expiry, `finished_at` plus the grace. Not the lazily
      written `ended_at` of an expiry, which can land long after the code stopped serving;
    - the end of the last session of the fixture that was open when the code ended, which C1(a) or C1(b) served —
      "open when it ended" judged against the code's own end above (review fix 4: for an expiry, `finished_at` plus
      the grace, so a session begun after the code stopped serving and before the lazy write cannot stretch the tail).

    The ruling was relayed as "24 h after the code's session has ended", and Q1 asked about "a tok whose code ended
    no more than 24 h ago". The later-of rule meets both: with a session open, the tail runs from its end; with none,
    from the code's end.
  - **Anything else is `401 code_ended`.** That includes an ENDED code past its 24 h tail.

## 5. Body

- **Format:** NDJSON (`application/x-ndjson`), one JSON object per line. The contract's root is **one line**. The
  `Content-Type` header is not enforced, as the other capture routes do not enforce it.
- **Encoding:** `Content-Encoding: gzip`, or no header. Any other encoding is `422 invalid`, and so is a gzip that will
  not decode.
- **Limits, measured on the DECOMPRESSED body:** at most 1,048,576 bytes and at most 1000 non-empty lines. Empty lines,
  the trailing newline included, are skipped and not counted. Over either limit is `413 too_large`.
- **Zip-bomb defence:** the server inflates the body as a stream with a hard output cap of 1 MB + 1 byte, using zlib
  `maxOutputLength` or a counting transform that aborts. Reaching the cap is 413, and inflation stops there. The raw
  body read is also capped at 1 MB.
- **Keys:** the line keys come from capture's `modules/capture-engine/src/scrub/allow-list.json` (capture `2b4df80`,
  on `main`), 104 of them:
  - `at` (required), `kind` (required) and `level` (optional) are the line's own keys;
  - each `plain`, `publicUrl`, `text` and `scalars` key is accepted in its class;
  - the field `kind` is written as `field_kind`, because `kind` is the line's own key;
  - a number, boolean or null is accepted under any listed key except `sid` and `tokenTag`;
  - the mask `***` is accepted under a listed key except `tokenTag`, because it is the scrub's own output.

  Three keys are narrowed:
  - **`at`** is the beat's `at`, byte for byte (R5, §17.5): ISO 8601 with any offset, calendar-exact (no 30 February,
    29 February only in a leap year), seconds required, and a value with no zone refused. The server normalises it to
    UTC. Capture sends Z with milliseconds. One `at` shape across the capture wire beats a second Z-only one, because
    the stored time is normalised either way.
  - **`sid`** is the server's uuid (the beat's sid shape), the mask `***`, or null. A number or a boolean is off the
    class (`line-invalid-sid-number`, `line-invalid-sid-boolean`), because neither A1 nor A2 could judge it; such a
    line is dropped (ruling RL).
  - **`tokenTag`** is `^[0-9a-f]{8}$`, as the allow-list's own reason says.

  Capture ebac190 added five keys (2026-10-12), each with a reason line in its allow-list. `pickSource` (preview-size:
  which rule chose the preview's size, `ours` or `vendor`) is a plain key. Four are scalars the reasons narrow, as
  `tokenTag`'s narrows it: `bytes` (record.send's body size), `failures` (rejoin-retry's failed connects) and
  `retryMs` (rejoin-retry's wait) are integers of at least 0, and `pickAspect16x9` (preview-size: is the preview
  16:9) is a boolean. None of the four admits null or the mask; capture writes each from a typed field.

  Capture 2b4df80 added seven scalar keys (R-990P; owner approved 2026-10-26; web PR #1037), written on the `bitrate`
  and `bitrate-held` lines: `bandwidthBps`, `dropped`, `egressBps`, `gateBps`, `lost`, `sendBufferMs` and `target`.
  Each is the generic scalar class (a number, a boolean or null), as `gapMs` and `videoFps` are. Nothing narrows them;
  `sendBufferMs` has no minimum, because SRT reports it negative (-336 has been seen).

  **A line with any other key is dropped (ruling RL), including a never key** (`tok`, `code`, `streamKey`, …) even when
  masked, and so is a line with a value outside its key's class. When capture adds a key, it is a contract change here (a new sha256) in step with
  capture's change.
- **Secret-shaped values (P8, approved).** The server drops the LINE (ruling RL) when any string value, under any key,
  is secret-shaped:
  - **S1** is the Bearer that sent the record, in any of capture's three forms: raw, percent-encoded or form-encoded
    (the scrub's `formsOf`). The server holds the Bearer, so this match is exact. No schema can state it, so it is
    prose only.
  - **S2–S5 are the contract's own `$defs.secretS2`–`secretS5`.** A string that validates against
    `$defs.secretShaped` is one of them. The server runs exactly these patterns, and capture can run them too:
    - **S2:** an RTMP(S) URL that carries a stream key, meaning two or more path segments after the host, the last of
      which is not the mask. Cloudflare's bare `rtmps://live.cloudflare.com:443/live/` carries no key.
    - **S3:** SRT's credentials, in either of two forms. One is a `streamid=` or `passphrase=` pair whose value is not
      the mask. The other is the word `streamid` or `passphrase`, then whitespace, then at least 16 token characters.
      The second form is capture's vector 24 (`streamid a1b2…90 refused`), which has no `=` (re-review fix 2).
    - **S4:** a URL with userinfo whose password, or whole userinfo, is not exactly `***`.
    - **S5:** the word `Bearer`, then at least 16 token characters. `*` is no token character, so `Bearer ***` never
      matches. The length keeps prose such as "the bearer of" clear, and S3's second form uses the same length.
  - **Every rule skips the scrub's mask (review fix 1, re-review fix 1).** A credential the phone masked in place is
    no secret.
    - **"The mask" means `***` with no letter or digit after it** (`\*\*\*(?![A-Za-z0-9])`). Prose puts a full stop,
      a comma, a quote or a bracket after a URL or a pair, and the scrub masks in place, so the punctuation stays:
      `…/live/***.` and `(streamid=***)` are capture's correct output.
    - A partial mask, `***` with a letter or digit after it (`…/live/***K3Y`), still trips its rule. The test pins
      that too.
    - Without the skip, capture's correct output would be dropped as secret-shaped, so every line carrying a masked
      credential would vanish from the record (before ruling RL, it refused the whole body).
  - **The near misses are pinned.** These nine are fixtures the server must ADMIT, and the contract test proves each
    trips no rule while masked and exactly its rule once unmasked:
    - `line-valid-scrubbed-srt-passphrase` (capture's case 22, verbatim), near S3;
    - `line-valid-scrubbed-rtmps-key`, near S2;
    - `line-valid-scrubbed-userinfo`, near S4;
    - `line-valid-scrubbed-bearer`, near S5;
    - `line-valid-scrubbed-rtmps-key-period`, `-comma` and `-quoted`, near S2: the mask followed by `.`, `,` and `"`;
    - `line-valid-scrubbed-streamid-paren`, near S3: `(streamid=***)`;
    - `line-valid-scrubbed-streamid-space`, near S3: capture's case 24 output, `streamid *** refused`.

    Capture's cases 21 and 24 (`connect failed tok=*** at x`, `streamid *** refused`) are also pinned verbatim, under
    their own keys, as admitted. Case 24's input is the S3 vector `line-secret-streamid-space`.

  These are regular expressions with no entropy test, because an entropy test fires on class names such as
  `SocketTimeoutException` and on UUIDs. The phone's scrub is the first line of defence and these rules are the
  server's own second line. Each rule has a vector the line shape admits but the server drops (`line-secret-*`),
  and each vector trips its own rule alone.
- **Line by line (owner ruling RL, 2026-10-12; it replaces "whole body or nothing").** A bad line is dropped and the
  rest of the record is stored. A bad line is one the line shape refuses (a key off the allow-list — `__proto__`
  included, which zod's strict check skips and the twin refuses on its own (review fix 2) — a value off its class, a
  line that is not a JSON object), one that names a key twice (review fix 1: JSON.parse keeps the LAST value, so a
  first value would pass a screen of the parsed object; the rule is on the line's TEXT, and fixture
  `line-server-duplicate-key` pins it), one that is not UTF-8 (the body is split on the LF byte, so a bad byte
  spoils only its own line), or one with a secret-shaped value. It is counted in `dropped` and apart in
  `invalid_lines` (§9), and never stored, logged, quoted or echoed: no message names it. §6 says how a bad line meets
  attribution.
- **What is stored (review fix 1).** A kept line is stored as the server re-serialises the object it screened
  (`JSON.stringify` of the parsed line), never the bytes sent, so no spelling the screen did not judge reaches storage.
- **Order:** rate limit, then auth (401/404), then size (413), then a body that cannot be read as lines or has none
  (422), then each line's shape and allow-list, then its secret-shaped values, then attribution, storage and the 201.
  A stranger's body is never inflated.
- **Proxy (review fix 5).** `apps/web/src/proxy.ts` leaves the records path out of its matcher. While proxy runs on
  a path, Next buffers the request body (`proxyClientMaxBodySize`, 10 MB by default) before the route's own 1 MB
  raw cap, its rate limit and its auth. The one thing proxy does for an /api POST is the CSRF Origin check, which
  guards nothing on a Bearer-only, cookie-less route. Every other path still runs proxy
  (`src/__tests__/proxy-matcher.test.ts`, and the `capture-record` smoke on a real build).

## 6. Line attribution: the cross-code rule (A1, A2)

The record is the phone's last 1000 lines, so it can span codes: club X, then club Y. The server keeps a line only if
it belongs to the sending code. It drops every other line **before storing**, and it never logs or echoes a dropped
line.

- **A1, a line whose `sid` is a uuid:** kept if and only if that session belongs to the sending code. The owner's
  reading (Q9, 2026-10-12): the line's session was joined by a pairing of this code, meaning
  `fixture_stream_sessions.pairing_id` leads to a pairing whose `code_id` is the sending code, read at upload time.
  `fixture_stream_sessions.code_id` is NOT used.
  - After a takeover on the same code, the session's pairing becomes the new phone's pairing of the **same** code, so
    a replaced phone's session lines are kept. This is R4's case.
  - A session moved to a reissued code (the C3 move in `capture-phone.ts`) belongs to the new code.
  - **A null `pairing_id` means the line is dropped.** That is an organiser's start on a fixture with no phone paired:
    `StartActor.pairingId` is `phone?.pairingId ?? null` on that path (`stream-sessions.ts:1233`), and V430:109 makes
    the column nullable. No pairing leads to any code, so there is nothing to attribute the line to (Q9).
  - An unknown sid, or another code's sid, is dropped.
- **A masked `sid` (`***`) is dropped.** It names no session that can be checked.
- **A2, a line whose `sid` is null or absent:** kept if and only if it falls inside a pairing window of the sending
  code.
  - A window **opens** at a `pair` line whose `tokenTag` is in T(code), and that `pair` line is kept.
  - It **closes** through the next `unpaired`, `ended`, `pair-refused` or `reset` line, which belongs to the window
    (Q7, answered by capture 2026-10-12 and corrected by capture the same day), or just before the next `pair` line,
    which opens the next window, or just before the next unreadable line (below). Whichever comes first closes it.
  - An `engine-error` line does **not** close a window (capture's correction to Q7, 2026-10-12). Native also writes
    it on non-fatal paths where the pairing goes on, so it is an ordinary window line. A fatal error is followed by
    an `ended {reason: "fatal-error", wasLive}` line, and that `ended` closes the window.
  - **T(code)** is the set of tags of every tok ever issued for the code. Today it holds one tag: `tokenTag(Bearer)`
    (§0.1).
- A line before the record's first `pair` line is in no window, so it is dropped. This fails closed. See Q6.
- A1 decides a uuid-sid line on its own, wherever it falls, inside or outside a window.
- **Bad lines (ruling RL).** A secret-shaped line has a good shape, so attribution reads it like any other line (it may
  open or close a window), and it is then dropped. A line the server cannot read (not UTF-8, not JSON, not an object, a
  key off the allow-list, a value off its class) is dropped and closes any open window just before it, as a `pair` of
  no known code would: it may be another code's `pair` line, and a window run through it could keep that code's
  lines. This fails closed, like Q6. A1 still judges the uuid-sid lines after it. `keptLines` in
  `domain/capture-record.ts` is this policy, in one function.
- **A dropped line** is counted and nothing more. It is never stored (not even hashed), logged, quoted in an error or
  echoed.

**Worked example.** The phone sent club X's lines, then club Y's, and posts the record under Y's tok, whose tag is
`b24bb97b`. X's tag is `c980ff38`. S_X is X's session and S_Y is Y's.

| # | Line | Kept? | Why |
|---|---|---|---|
| 1 | `thermal` (no sid) | dropped | before the first `pair` |
| 2 | `pair` tokenTag `c980ff38` | dropped | opens X's window |
| 3 | `live` sid S_X | dropped | A1: S_X is X's |
| 4 | `network` (no sid) | dropped | inside X's window |
| 5 | `unpaired` (no sid) | dropped | closes X's window |
| 6 | `pair` tokenTag `b24bb97b` | **kept** | opens Y's window |
| 7 | `thermal` (no sid) | **kept** | inside Y's window |
| 8 | `live` sid S_Y | **kept** | A1: S_Y is Y's |

The answer is `201 {ref, kept: 3, dropped: 5}`, and the app shows only the ref (RD).

## 7. Answers (the capture envelope)

| Status | Body | When |
|---|---|---|
| 201 | `{ref, kept, dropped}` | Received. `kept + dropped` is the number of non-empty lines received; `dropped` counts another code's lines and bad lines alike (ruling RL). If every line was dropped, for either reason, the answer is still 201 with `kept: 0` (P10). |
| 401 | `code_ended` | missing, malformed or wrong Bearer; unknown code; a code `codeServes` refuses for `record` (§4, Q1) |
| 404 | `not_a_stream_code` | malformed code |
| 413 | `too_large` (new word, P3) | over 1000 lines or 1 MB decompressed; the inflate cap is reached |
| 422 | `invalid` | a body that cannot be read as lines (an unsupported Content-Encoding, a gzip that will not decode) or has no non-empty line (P10). Never a bad line: since ruling RL a bad line is dropped |
| 429 | `rate_limited` + `Retry-After` | the 11th record in the hour for the code |
| 503 | `unavailable` | anything unmapped (house) |

The route never answers `replaced` (R4). The fixture `invalid-replaced` pins this.

## 8. Limits and rate (P2, approved)

- **10 records an hour per code**, in the bucket `capture-record:{code}:{credentialKey}` (10 per 3600 s). The bucket is
  spent before the route runs, as the start's own budget is, so every attempt counts, a 413 or a 422 included.
- **The branch the route needs.** Today `capturePhoneRoute` spends `CAPTURE_CODE_LIMIT` on every route
  (`capture-http.ts:137`). The implementing PR adds `"records"` to its route kinds and branches there:
  - for `"records"`, spend `capture-record:` (a new `CAPTURE_RECORD_LIMIT`) **instead of** `capture-code:`;
  - for every other route kind, behaviour stays as it is.

  The point is that a Send never pushes a live phone's beats into 429. A test pins both halves: a records call leaves
  the code's budget untouched, and the 11th record is 429.
- A 401 spends the client IP's failed-attempt budget, as on every phone route.
- `Retry-After` is the window's true remaining seconds (QR v2 §17.4).

## 9. Storage and retention (P5, P6, approved)

The implementing PR owes the migration. The approved shape:

- `capture_records`: `id`, `org_id`, `competition_id`, `fixture_id`, `code_id`, `slot` (the code's slot, 0 today),
  `ref` (unique), `received_lines`, `kept_lines`, `dropped_lines`, `invalid_lines` (ruling RL: the bad lines among the
  dropped, a count only, at most `dropped_lines`), `body_bytes`, `lines` (the kept NDJSON, each the re-serialised line the screen judged),
  `created_at`, `expires_at`. Returning `dropped` is the owner's ruling (RD). Recording `dropped_lines` is part
  of P5, approved with it.
- `capture_record_sessions(record_id, session_id)`: the sessions that the kept sid lines name, with a cascading
  foreign key. This is what keys a record "by session".
- RLS follows the V410 pattern (QR v2 §17.1): staff read only.
- **Retention: 30 days (P6, approved).** `expires_at = created_at + 30 days`. The daily relay sweep deletes expired
  records, and their link rows cascade. The 24 h purge of phone beats is separate and does not change.
- **Ref (P9):** `R-` and 4 upper-case Crockford base32 characters, unique among the stored records. On a unique-index
  collision the server draws again, as `mintLocked` does. 4 characters give about 1.05 million refs. The contract
  allows up to 8, so the ref can grow without a new version.

## 10. Admin view (P7 and Q5, approved)

`/admin` is staff-only and desktop-only. It is verified at 1280 and nowhere else (AGENTS.md). A Next layout does not
gate the segments under it, so the page and BOTH reads behind it (`captureRecordByRef`, `captureRecordsOfFixture`)
each call `requireStaff()` themselves (review fix 3).

- **`/admin/capture-records?ref=R-7K2Q`** looks a record up by its ref, which is the support path: operator, then
  organiser, then staff.
- **`/admin/fixtures?id=<fixture>`** gains a _Capture records_ section next to each session: the records linked to that
  session, and then the fixture's records that name no session.
- Each record shows:
  - its ref, time, slot and code id (never the tok);
  - its received, kept and dropped counts, and how many of the dropped were bad lines (ruling RL: a scrub leak shows
    up there);
  - its kept lines as a table: `at`, `kind`, `level`, `sid`, and the other fields as `key=value`.
- No dropped line can be shown, because none is stored.

## 11. Privacy

- **What a line can hold:** only allow-list keys, which means closed words, numbers, public URLs and scrubbed text. A
  line holds no name, no email and no device model (`appVersion` only). It holds no token, code, stream key or
  passphrase: a line with a never key is dropped and S1–S5 drop a line carrying such a value in text (ruling RL),
  while the mask capture writes in their place passes.
- **Org isolation:** A1 and A2 drop other codes' lines before storage, so club X's lines never land in club Y's record.
  `dropped` is a count, and staff see only the count.
- **Logs:** the route logs no body and no header (QR v2 §10.2 redaction: `req.headers.authorization`), and Sentry drops
  the request body on capture routes. No answer names a dropped line, its key or its value (ruling RL).
- **Who sees a record:** staff only (P7) under RLS, for 30 days (P6). The owner ruled out an org-admin console view for
  now (Q5).
- **Consent:** the operator's tap is the only trigger (R3).

## 12. Questions: all answered (the owner's, and capture's on 2026-10-12)

- **Q1 (owner): ENDED codes beyond C1(b). ANSWERED 2026-10-12: yes.** Uploads are accepted for 24 h after the code
  last served (C1(c), §4), with no phone condition. The owner accepted the trade-off: a revoked tok, perhaps from a
  leaked QR, can write records for that window, bounded by 10 an hour, 1 MB each, staff-only reading and no effect
  on any stream. §4 records how the relayed wording ("after the code's session has ended") and the question's
  ("a code that ended no more than 24 h ago") are both met.
- **Q2 (owner): the 413 word. ANSWERED 2026-10-12: `too_large`.** The choice was a new word, `too_large`, or
  `invalid` at 413. `CaptureRefusalCode` is
  shared by the refusal of every capture contract. Adding a word to that shared twin changes the start, descriptor and
  scoring-link files, and capture re-vendors all of them. So records get their own refusal twin when the route lands,
  and no other file changes.
- **Q3 (owner). ANSWERED 2026-10-12:** P1–P11 are approved as written.
- **Q4 (capture): mask or drop. ANSWERED 2026-10-12 (capture, relayed): as recommended** — capture drops keys that are
  not on the list before Send. A line the server still finds off the list is dropped, not the body refused (ruling RL).
  The question as it was put: capture's scrub writes `"key":"***"` for an unexpected key and lets a scalar through
  under any key, but this server refuses both. **Recommended:** before Send, capture drops keys that are not on the
  list. Its port already pre-checks the lines and records `refused-local`. The alternative is to let the server drop
  masked unlisted keys instead of refusing the body. A masked VALUE under a listed key, or inside text, is admitted
  either way (§5).
  Two more items for capture to confirm (review minors):
  - **`SrtTarget.toString()` is never logged into the record.** It prints `streamId=<32 chars>` (`SessionConfig.kt`).
    That is a length, not a secret, but S3 reads `streamId=<32` as a `streamid=` pair, so one such line is dropped
    (ruling RL; before it, the server refused the whole record with 422). `Engine.kt` writes `failure.toString()`
    into `engine-error` lines, which is the path to check.
  - **Capture's own SRT prose stays as it is.** `srt passphrase is not 10–79 characters` and `srt streamId is blank`
    (`SessionConfig.kt` `problems()`, logged as a `pair-refused` line's `problems`) trip no rule. They are pinned as
    admitted fixtures (`line-valid-prose-srt-passphrase-length`, `line-valid-prose-srt-streamid-blank`). A rewording
    that puts 16 or more token characters after `passphrase` or `streamId` would trip S3.
- **Q5 (owner): who sees records. ANSWERED 2026-10-12: staff, in `/admin`, beside the session** (desktop only,
  verified at 1280). There is no org-admin console view for now. Capture's brief asked for "the console next to the
  session, for org admins only". That would need its own privacy review if it is ever asked for again.
- **Q6 (capture): a truncated first window. ANSWERED 2026-10-12: confirmed as stated.** Lines before the record's
  first `pair` are dropped. On a long pairing
  whose `pair` line has fallen out of the 1000-line ring, every line without a sid is lost. Capture could begin each
  sent record with the current pairing's `pair` line.
- **Q7 (capture). ANSWERED 2026-10-12, then CORRECTED by capture on 2026-10-12:** `unpaired` and `ended` are not
  the only kinds that end a pairing: `pair-refused` and `reset` end it too. All four close a window through
  themselves (§6); the contract's prose and `WINDOW_CLOSING_KINDS` (`domain/capture-record.ts`) say so.
  - **Capture's correction (2026-10-12).** The first answer also named `engine-error`. That was wrong: `engine-error`
    is not fatal-only. Native also writes it on non-fatal paths (`Engine.kt:136`; `BridgeCore.kt:608`) plus an error
    raised while already Ended (`Engine.kt:138`), line numbers on capture's `feat/s1-d3-fixes`. So `engine-error` no
    longer closes a window; a
    no-sid line after a non-fatal one is kept. On both fatal paths native writes `ended {reason: "fatal-error",
    wasLive}`, and `ended` already closes the window. `pair-refused` (always fatal) and `reset` (the backstop) still
    close. The contract admits that `ended` line as it is: `reason` is a plain key (a short word, `fatal-error`
    included) and `wasLive` is a scalars key (a boolean), both already on capture's allow-list.
- **Q8 (capture). ANSWERED 2026-10-12: final** — `tokenTag` is FNV-1a 32 over the token's UTF-16 code units, as 8
  lowercase hex digits (carry 2). The server's test will use
  `token-tag-vectors.json` as its rulebook. D1 (§0.1) applies if a code can ever hold more than one tok.
- **Q9 (owner): "a session belongs to this code". ANSWERED 2026-10-12: the session's pairing.** The line's session
  was joined by a pairing of this code: `pairing_id` leads to a pairing whose `code_id` is the sending code. A null
  `pairing_id` (an organiser's start with no phone) means the line is dropped. `fixture_stream_sessions.code_id` is
  NOT used, and neither is the looser `session.fixture_id = code.fixture_id`.

## 13. Test plan (TEST-STRATEGY.md; all four types)

### 13.1 This PR (contract only)

`capture-contract.test.ts` gains:

- the sha256 pin for the record contract (six files now);
- the listing check: the record is the one contract with no twin, and its `$defs` are exactly `ok`, `refusal`,
  `secretS2`–`secretS5` and `secretShaped`;
- an ajv sweep of all 52 fixtures (38 lines, 6 oks and 8 refusals), with a pinned count per shape. Valid fixtures
  must be admitted and invalid or tampered ones refused. The 6 secret vectors must be **admitted** by the line shape,
  and the root description must state each one's rule;
- the secret-shaped rules, run through the file's own `$defs`, all counted:
  - each secret vector trips its own rule alone (S1's trips none, since it needs the Bearer);
  - each of the 9 near misses trips no rule while masked, and exactly its rule once unmasked; 4 of them put `.`,
    `,`, `"` or `)` straight after the mask, which the test checks as a premise;
  - 3 partial masks (`***` with a letter or digit after it) still trip their rule;
  - capture's case 24 is pinned verbatim: its input as the S3 vector, its output as admitted;
  - capture's 2 SRT prose strings (Q4) are pinned verbatim, admitted, and trip no rule;
  - none of the 19 valid lines' strings is secret-shaped;
  - 7 bare or masked ingest strings are not secret-shaped;
- a check of the key set against capture's allow-list, typed in the test from `allow-list.json` and never read off the
  contract: 92 keys, none of them a never key. The test then makes 1346 class-by-class ajv probes, a pinned count.
  Among them, `sid` takes only a uuid, `***` or null, and `at` takes any offset but rejects 30 February and
  29 February 2027;
- `at` is checked equal to the beat's `at`, shape for shape;
- the answers: the closed 201, the Crockford ref alphabet (37 probes), a fixture for each refusal word in the table,
  and no `replaced`;
- a tripwire on capture-schemas.ts's FULL export list (23 names), so a twin under any name fails the test until it
  joins the parity test.

**Mutations, each run once and restored from a `cp` backup:**

1. A valid fixture made invalid (`at` as ms epoch) turned the sweep red.
2. Removing S5's sentence, with the sha re-pinned, turned the prose check red.
3. Adding an unlisted key, with the sha re-pinned, turned two tests red: the key set and the
   `line-invalid-unlisted-scalar` fixture.
4. **Review fix 1:** removing S3's mask skip, with the sha re-pinned, turned `line-valid-scrubbed-srt-passphrase` red
   ("masked, it trips no rule: expected ['S3'] to equal []").
5. **Re-review fix 1:** putting S2's old lookahead back (skip `***` only before whitespace, `/`, `?`, `#` or the
   end), with the sha re-pinned, turned `line-valid-scrubbed-rtmps-key-period` red ("masked, it trips no rule:
   expected ['S2'] to deeply equal []"), 29 of 30.
6. **Q4's prose pin:** lowering S3's whitespace floor from 16 token characters to 2, with the sha re-pinned, turned
   `line-valid-prose-srt-passphrase-length` red ("it trips no rule: expected ['S3'] to deeply equal []"), 29 of 30.

### 13.2 The implementing PR (owed)

**Transitions and empty cases come first (rule 1):**

- **A second call:** two taps store two records with two refs, and the 11th in an hour is 429.
- **An empty input:** 0 lines is 422; only blank lines is 422; all lines foreign, or all bad (ruling RL), is 201 with
  `kept: 0`.
- **After a withdrawal or void:**
  - a reissued code with its open session alive is accepted (C1(b) for `record`);
  - once that session closes, it is accepted for 24 h more (C1(c)), and then it is 401;
  - a reissued code with no session open is accepted for 24 h after the reissue, then 401;
  - an expired code's tail runs from `finished_at` plus the grace, not from a late lazy `ended_at`;
  - a session that ended or failed still has its lines kept;
  - a takeover on the same code: the replaced phone is accepted (R4);
  - a finished fixture is accepted inside the grace, and after it while a session is open.
- **Another sport:** not applicable. The capture surface reads no sport, which is the contract test's own stated
  reason. One fixture of any sport is enough.

**Unit tests (pure):**

- `codeServes` gains the `record` rows, table-tested from §4's text:
  - ACTIVE, FINISHING inside the grace, and FINISHING past it with a session open all serve;
  - ENDED with an open pre-end session serves for **any** phone (the case that differs from `get`);
  - ENDED with none serves inside the 24 h tail and is refused one moment past it, with the tail's anchor (the later
    of the code's end and its last session's end) taken as an input.
- `attribute(lines, {sessionsOfCode, tagsOfCode})` is table-driven from §6's text: the worked example row for row, plus
  X→Y, Y→X, X→Y→X, a truncated first window, X's sid inside Y's window (kept), Y's sid inside X's window (dropped), a
  masked sid (dropped), a null-pairing session's sid (dropped), closing by each of Q7's four kinds and by a foreign
  `pair`, a non-fatal `engine-error` that closes nothing (Q7 corrected), and an unreadable line as a boundary (ruling
  RL). Expected values come from the table, never from the function.
- **fast-check (rule 10):** random sequences of `pair(tag)`, `unpaired`, `ended`, sid lines and device lines across 2–3
  codes, with `engine-error` in the alphabet as a non-closing kind (Q7 corrected), with each line's owner known from the generator. After every step these must hold: kept lines are all the
  sending code's, no foreign line is kept, and `kept + dropped = received`. Runs with `kept > 0` and runs with
  `dropped > 0` are each counted, and zero of either is a failure. A shrunk failure is committed as a named seed.
- **Body reader:** 1000 lines pass and 1001 are 413; 1,048,576 bytes pass and one more byte is 413. A gzip of 10 MB of
  zeros is 413, and the test asserts the inflated-bytes counter stays at or under the cap plus one chunk. Corrupt gzip
  is 422, `br` is 422, and a trailing newline is fine.
- **Secret rules:** the server's S2–S5 are the contract's `$defs` patterns, read from the vendored file, never retyped.
  Every `line-secret-*` vector must be dropped and every near miss admitted. S1 is tested in all three forms, worked
  by hand. `tokenTag(Bearer)` is checked against capture's 9 vectors, a pinned count.
- **Twin parity:** the line twin joins `DIRS` and the input-and-output parity test. The tripwire forces this.

**Use case, with a database:**

- Two orgs, two fixtures, two codes, and one record that spans both, sent under each tok in turn. Each stored record
  must hold no line of the other code, by sid or by window, and the counts, link rows and ref uniqueness must hold. A
  forced ref collision must draw again.
- R4: phone A is replaced by phone B on the same code. A's tok is accepted, and A's sid lines are kept. After Revoke &
  reissue with the session still open, the old tok is accepted too.
- A spy logger, following §10.2, drives the 201, 401, 413 and 422 paths and asserts that no log or Sentry line holds a
  dropped line, the tok or any body value.
- The rate branch: a records call leaves `capture-code:`'s count unchanged, and the 11th record is 429.
- Purge: expired records and their link rows go, and unexpired ones stay.

**Route test** (`records-route.test.ts`): the raw body of every answer is checked against the contract fixtures under
ajv, with the cache headers on every answer and `Retry-After` through the limiter's test hook.

**E2E** (Playwright, run by `e2e.yml` on a push to main): mint a code as the existing capture e2e does, then POST a
record with its tok. Open `/admin/capture-records?ref=…` at **1280 only** (the `/admin` rule). Assert that the kept
lines render and that the foreign line's distinctive value appears nowhere on the page.

**Smoke** (`scripts/smoke.ts`, case `capture-record`): mint a code and POST a 3-line record holding an own window line,
an own device line and a foreign window line. Expect 201 with `kept: 2, dropped: 1`, values typed from the fixture's
construction. A wrong tok is 401, and 1001 lines are 413.

**Regression tests, one per named risk:**

- a cross-code leak: club X's lines sent under club Y's tok;
- the zip bomb;
- §0.1's `at` premise: lines exactly as capture's writers write them (ISO `at`, no `level` for info, `field_kind`, a
  masked plain value);
- review fix 1: capture's scrubbed output, the near-miss fixtures, sent whole and answered 201;
- R4's replaced phone.

**Mutations (rule 5).** Run one at a time and record the killer list in the PR. A mutant that survives means a missing
test.

- M1: A1 keeps every sid line.
- M2: A2 never closes a window.
- M3: A2 opens a window on any tag.
- M4: an unlisted key is admitted.
- M5: each of S1–S5 returns false (five mutants), each mask skip is removed (four mutants: the near misses must
  die), and each skip is narrowed to whitespace or the end (the punctuation near misses must die).
- M6: the inflate cap is removed.
- M7: the line limit is off by one (1000 vs 1001).
- M8: a dropped line is logged.
- M9: a holder check is added (this breaks R4).
- M10: the records branch falls back to the shared code budget.
- M11: the `record` C1(b) row requires the open session's phone.
- M12: the 24 h tail is anchored on the lazy `ended_at`, or on the code's end alone (a session that outlived the
  reissue must then die).
- M13 (ruling RL): the drop is made a refusal (a 422 when any line is bad); a use-case test must go red.
- M14 (Q7): a closing kind removed from the set; the Q7 test must go red.
- M14b (Q7 corrected, 2026-10-12): `engine-error` put back in the closing set; the Q7-corrected tests (attribution,
  the real screen, the use-case) and the fast-check sequence test must go red.
- M15 (ruling RL): an unreadable line made transparent to attribution; the boundary test must go red.
- Review fixes (PR #943), one mutant each: the verbatim bytes stored again; the duplicate-key check removed; the
  twin's `__proto__` refusal removed; a read's `requireStaff` removed; the tail's session filter put back on the lazy
  `ended_at`; the records path put back under the proxy matcher; a guard's error made to carry a line's content.
