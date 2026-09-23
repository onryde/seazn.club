# Device-link scoring — realtime and write-path gaps

Design of record. Owner-approved 2026-09-21 (approach C, plus "hide void
while held"). Supersedes nothing; the ScoringPad v2 programme index
(`2026-08-06-scoringpad-v2-prompts/_INDEX.md`) is **closed as of
2026-08-14** and contains no v3 vocabulary, so every ruling cited from it
below is carried in deliberately rather than assumed current.

## 1. Where this came from

An owner walkthrough on `stg` with a real badminton fixture and a live
device-link pad. Observed, in the product, not inferred from code:

- The organiser console read `0 — 0 (7–7)` while the device-link pad on
  the same fixture read `0 — 0 (11–9)` with **10 QUEUED**.
- Two `POST /events` calls 503ms apart carrying the **same**
  `idempotency_key` and **different** `expected_seq` (64, then 67), both
  answered `409 CONFLICT — "Nothing to undo — that entry is already
  undone"`. Captured in `stg.seazn.club-from-org-device-pad.har`.
- A `RATE_LIMITED` envelope from the same session (not in the HAR
  capture window).
- At 360px the pad's score line clipped mid-string:
  `21-14, 20-22 (10-1`.
- Two distinct undo controls visible at once: **"Void my last entry"**
  and **"Take back"**.

## 2. Root cause (R1)

`transport.ts:210` classifies **every** HTTP 409 as renegotiable:

```ts
if (status === 409) return false; // renegotiable — the conflict path owns it
```

But `scoring.ts` throws 409 for four semantically different outcomes:

| Site | Meaning | Can a new `expected_seq` fix it? |
|---|---|---|
| `scoring.ts:274` | "Nothing to undo" | No — terminal |
| `scoring.ts:282` | "… that entry does not exist" | No — terminal |
| `scoring.ts:283` | "… that entry is already undone" | No — terminal |
| sequence mismatch | `SEQ_CONFLICT` | Yes — renegotiable |

Only the fourth is renegotiable. The three undo refusals are terminal:
no sequence value will ever satisfy them.

All four arrive at the pipeline as `kind: "conflict"`, so
`pipeline.ts:290-315` inspects the ledger slot, renegotiates the seq,
and resends exactly once — faithfully executing the replay ruling at
`_INDEX.md:1786-1807` (corrected `:1838-50`). That code is **correct**.
It is simply being told the wrong thing.

The resend fails identically, and `pipeline.ts:329-333` returns
`stayed-queued` with reason `conflict-again`. `drainQueue:363-365` then
returns `stoppedEarly: true`, leaving the event at the head of the
queue.

**The head never clears, and every event behind it is blocked
permanently.**

### Why it is silent

`use-pad-pipeline.ts:1402` sets the offline chip only for
`reason === "network"`. A `conflict-again` wedge therefore breaks the
drain with no offline indicator, no error surface, and a queue-depth
number that keeps counting. The pad looks healthy while it has stopped
recording the match.

### What this explains

Every observed symptom, from one cause:

- **10 QUEUED that never drains** — the wedged head.
- **Duplicate POST, same key, seq 64→67** — renegotiate-and-resend-once,
  working as designed, against an error it can never win.
- **RATE_LIMITED** — each drain pass spends two requests on a
  **per-fixture 10/s** bucket (`scoring.ts:48,92`) that charges replays
  performing no write.
- **7–7 vs 11–9** — the device pad's optimistic fold kept counting while
  nothing behind the wedge could land.

The server states the intent the client defeats — `scoring.ts:266`:
*"so a double-tapped 'Undo last' degrades to a calm 'already undone'."*
The server made it calm; the client reads calm as retryable.

## 3. Findings withdrawn

Recorded so they are not re-derived:

- **"The retry resends without reconciling post-resync state."** False.
  `pipeline.ts:274` replays the original seq and key exactly as the
  ruling requires; `:290` inspects the slot; `:313-315` persists before
  resending. The mechanism was invented from a symptom.
- **"`device-score-pad.tsx`'s retry loop re-derives `expected_seq`."**
  False. `:148` mints a fresh key per `send()` and `:155` reads a
  closure-captured `live.last_seq`, so its three retries cannot produce
  same-key-different-seq. The HAR pair came from the v3 pipeline.
- **"`device.undoMine` is English-only."** False. Present in all four
  dictionaries; the initial grep matched the English *value*, not the key.

## 4. W1 — write-path correctness

Approach C: classify by error code at the boundary, plus a bounded
progress guarantee.

### 4.1 Server

`scoring.ts` — `HttpError`'s third argument already overrides the
generic status→code map (`errors.ts:13`; precedent `LINK_EXPIRED`, added
for this same pad). No new machinery.

```
:274  HttpError(409, "Nothing to undo",                 "UNDO_NOOP")
:282  HttpError(409, "… that entry does not exist",     "UNDO_TARGET_MISSING")
:283  HttpError(409, "… that entry is already undone",  "UNDO_ALREADY_VOIDED")
:285  HttpError(409, "An undo cannot be undone …",      "UNDO_NOT_UNDOABLE")
```

Sequence mismatch keeps `SEQ_CONFLICT`. Nothing else moves.

`:285` was missed in the first pass of this design and found while pinning
line numbers for the plan. It is the same wedge class as the other three:
terminal, unwinnable by any `expected_seq`. Recorded here because the
omission is evidence for §3's point — a list assembled from reading is a
hypothesis until each row is re-pinned against the tree.

### 4.2 Limiter placement

Move `rateLimit()` (`scoring.ts:92`) to run **after** the idempotency
replay check (`:94-97`), so a replay that performs no write costs no
**write** slot. That move is right and stands.

~~This is not a new denial-of-service surface: the replay check is a
Redis GET, the same cost class as the limiter's own INCR.~~
**Wrong — struck 2026-09-21 in W1 round-1 review, kept here rather than
deleted because the mistake is the instructive part.** The sentence
reasons about the cost of *one* request and silently concludes something
about *how many* may be sent. Those are different claims. Bounded cost
times an unbounded count is unbounded, and after the move a replay
passed no limiter at all — so a caller holding one already-answered
idempotency key could repeat it forever. That is reachable by anyone
with a leaked `dl_` URL, because a device link is a shareable address,
not a secret a single device holds.

What replaced it: a **second bucket on the replay branch only**
(`REPLAY_LIMIT`, keyed `scorereplayv1:<fixtureId>` like the write
bucket). Three properties, each pinned by a test that dies without it:

- **An abuse ceiling, never a pacing control.** Its max derives from
  `SCORING_LIMIT.max` rather than being typed beside it, so the two move
  together and cannot silently invert. It sits well above the write
  cadence — a real replay storm (a queue drained after a tab death, or
  several devices on one fixture retrying at once) is tens of requests,
  not hundreds, so this must never fire for a real pad.
- **Fail-open**, exactly like the write limiter: a Redis outage must
  never stop a scorer recording a match.
- **The write path is untouched** — same order, same limit: replay check,
  then the write limiter, then entitlement, then the undo guard.

**What this ceiling does NOT do, recorded so it is not over-claimed later.**
The finding it answers was phrased as "unbounded billed Redis GETs". It does
not close that. `cacheGet` necessarily runs BEFORE the limiter — you cannot
know a request is a replay until you have looked — so a caller hammering one
known key still costs one GET plus one INCR per request, and the limiter adds
an op rather than removing one. What it genuinely bounds is the RATE at which
replayed answers are served, not Redis command volume.

The limiter cannot be moved earlier: limiting before the lookup would charge
cache-MISS requests too, which is precisely the self-amplifying bug the
reordering above removed. Request volume is an edge concern, not an
application one — and verified 2026-09-22, the Cloudflare zone has no
`http_ratelimit` ruleset at all, so nothing bounds it today. That is the real
control if this ever matters commercially; see
`docs/superpowers/reviews/2026-09-22-cloudflare-edge-exposure-scoring-realtime.md`.

Generalisable, and the reason this is written out at length: "cheap per
call" is not an answer to "how many calls". A rate limit removed from a
path is not replaced by the path being inexpensive.

### 4.3 Transport classification

`transport.ts:210,236-240` splits the 409 on code:

- `SEQ_CONFLICT`, **or an absent code** → `kind: "conflict"`.
  Renegotiable; path unchanged. Defaulting an absent code to today's
  behaviour means an un-migrated server cannot wedge a new client.
- `UNDO_NOOP` | `UNDO_TARGET_MISSING` | `UNDO_ALREADY_VOIDED` |
  `UNDO_NOT_UNDOABLE` → `kind: "rejected"`. All **four**, matching
  §4.1's list — this section listed three until 2026-09-21, and the
  omitted one is exactly the refusal the staging wedge was built on.
  A code missing here does not fail loudly: it falls through to the
  renegotiable default above and silently restores the wedge.

No pipeline change is needed for this case. `pipeline.ts:280-283`
already drops the event and surfaces it, and
`use-pad-pipeline.ts:1393-1398` already removes the optimistic envelope
and records `lastRejection` for the UI. The wedge was never in the
pipeline; it was in what the pipeline was told.

### 4.4 Progress ceiling

The backstop that makes C more than A. `attempts` is already persisted
(`pipeline.ts:258`, `recordAttempt`). An event whose outcome is
`conflict-again` beyond the ceiling is dead-lettered: removed from the
head, surfaced through the existing `lastRejection` path, never dropped
silently.

**Load-bearing constraint: the ceiling applies to `conflict-again`
only — never to `network`.** An offline venue must queue indefinitely;
that is the product's entire purpose. A ceiling that catches network
failures converts a Wi-Fi blip into lost rallies, which is a worse
defect than the one being fixed.

The ceiling value is derived from the renegotiation protocol (one
renegotiation is permitted per drain pass, so the ceiling expresses how
many passes a genuinely-foreign slot may need), not chosen as a round
number.

### 4.5 Two undo controls

Confirmed distinct operations:

| Control | Owner | Mechanism |
|---|---|---|
| "Void my last entry" | `device-score-pad.tsx:321` (`device.undoMine`) | `core.void` on an **already-committed** event; the entry stays in the ledger, struck through |
| "Take back" | `pad-host.tsx:2458` (`pad.ribbon.takeBack`) | soft-commit cancel of a **held** entry, inside `HOLD_MS`, before it is ever sent |

Both are live simultaneously during the hold window, targeting different
events, with nothing on screen distinguishing them. This is what
produces a terminal undo refusal in the first place — the trigger for
R1, not its cause.

**Owner ruling 2026-09-21: hide "Void my last entry" while an entry is
held.** Only one undo is valid at any moment, and the scorer is not
asked to learn a new concept mid-match.

This requires a new seam: `DeviceScorePad` must observe the inner v3
pad's held state, which today has no channel (`onEvents` is the only
one). Per the programme's standing rule on inert seams, it is proven
only by driving it through its real producer and consumer — tap the pad,
observe the control hide, wait out `HOLD_MS`, observe it return. A
fixture on both ends proves the fixture.

### 4.6 Throttling is not offline

`transport.ts:152` lists 429 in `RETRYABLE_CLIENT_STATUS`; `:211` falls
through to `network-error`; `use-pad-pipeline.ts:1402` therefore shows
the offline chip. The scorer is told they have no connection when the
truth is that they are throttled.

A distinct `throttled` reason with its own copy in all four
dictionaries. It stays retryable — throttling is transient — but gains
backoff so the retry does not feed the limiter it is waiting on.

### 4.7 Making the limiter testable

`rate-limit.ts:42-48` allows everything when `REDIS_URL` is unset, so
local development and the entire e2e suite never exercise any limiter
behaviour. This is why none of the above was caught before `stg`.

A test-only in-memory counter, so the limiter's real behaviour is
exercised, plus a case that **defeats** the guard — if the predicate can
be deleted and the suite stays green, the test is decoration.

## 4.8 Score line clipping (folded in — owner ruling 2026-09-21)

Originally scoped as its own wave. Collapsed into W1 because the chosen
fix lands in `device-score-pad.tsx`, a file W1 already owns, and the
batching rule puts same-file work in one pass.

`kernel.ts:2393-2400` builds the headline as:

```ts
headline: `${setsWon.home} — ${setsWon.away}${setLine}${inSet}`
// setLine = ` · ${closedSets.map(s => `${s.home}–${s.away}`).join(", ")}`
// inSet   = ` (${open.set.home}–${open.set.away})`
```

`inSet` is concatenated without a ` · `, so `device-score-pad.tsx:280`'s
`split(" · ")` yields two groups and the second is the whole
`"21–14, 20–22 (10–14)"` string, rendered in one `whitespace-nowrap`
span (`:281`) at up to `3rem`. The `<p>` (`:279`) has no `max-w`, no
`truncate`, no overflow handling; the nearest rule is `overflow-hidden`
on `<header>` (`:239`), which **clips**. The string can only widen as
sets accumulate.

**Ruling: fix the pad's split, not the engine's string.** Two options
were rejected:

- *Change the engine separator.* `headline` is consumed by the overlay
  and spectator surfaces, so adding ` · ` before `inSet` changes
  rendered copy on broadcast graphics that cannot be hotfixed
  mid-match. Too expensive for a layout defect.
- *CSS only.* Works, but leaves the pad splitting a string it has no
  break points inside.

The pad splits the sets group on `", "` in addition to `" · "`, so each
closed set and the in-progress set each become their own nowrap unit and
the line can wrap between them. The engine string stays byte-identical
everywhere, so overlay and spectator are untouched by construction.

Residual: the engine keeps a mildly inconsistent separator convention.
Cosmetic, invisible to users, revisit if a second consumer trips on it.

## 5. W3 — the realtime seam (design level)

Sequenced **after** W2 (durable idempotency, §7.1) and after W1, which it
overlaps in `device-score-pad.tsx` and `use-pad-pipeline.ts`.

- **The auth seam.** `auth` is never forwarded into the pipeline.
  `PadHostV3`'s props (`pad-host.tsx:1440-1455`) have no `auth` field,
  and neither `registry.tsx:288-304` nor `pad-host.tsx:1530-1539` passes
  one, so `use-pad-pipeline.ts:1141` always resolves `SESSION_AUTH` and
  the realtime-token request goes out with no `Bearer dl_`. The route's
  device-link bypass (`realtime-token/route.ts:46`), its e2e
  (`device-links.spec.ts:240`) and its unit test
  (`use-fixture-stream.test.ts:272`) all drive the hook or route
  directly — both ends proven by fixtures while no production caller
  drives the seam. On any fixture that is neither entitled nor official,
  the device-link pad silently runs on the 15s poll.
  `_INDEX.md:1769-74` recorded "neither pad subscribes to realtime" as a
  false premise on 2026-08-12; for device-link pads it is still true.
- **One-way resync.** `device-score-pad.tsx:119,136` resyncs only after
  its own send or its own pad's ledger change. A score entered on the
  organiser console never reaches the device-link header until the
  umpire taps something.
- **No independent refresh.** `fixture-console.tsx` has no interval,
  focus or visibility listener; its chrome inherits the embedded pad's
  stream entirely (`:441`). One stalled pipeline stalls the console.
- **`sinceSeq` is an array count.** `use-pad-pipeline.ts:1142` passes
  `ledgerEvents.length` as the server's `since_seq`. Unverified either
  way; if the ledger can ever hold a row the server has not numbered,
  the poll skips foreign events.
- **Constraint inherited from W1:** do **not** add a drain retry timer
  before R1 ships. Against a wedged head a timer multiplies futile
  double-requests into the limiter.

Cross-pad lag is the **measurement** W1 and W2 must move (worst case
today ≈ `HOLD_MS` 10s + `POLL_MS` 15s), not a separate fix. Re-measure
after; do not design against the number.

## 6. W2 — durable idempotency (design level)

Answers the owner question at `_INDEX.md:1808-13`, asked 2026-08-12 and
unanswered until now.

Server idempotency is a **fail-open Redis cache**: `scoring.ts:44`
(`IDEM_TTL_SECONDS = 24h`), `:45` (`idemv1:` key), `:94-98` (`cacheGet`,
return the cached answer or fall through). There is **no
`score_events.idempotency_key` column and no unique index**.

So on a cache miss or a Redis outage the replay check returns nothing,
the write proceeds, and the same tap is recorded twice — silently, with
no constraint to catch it. The client's replay protocol (`pipeline.ts:274`
resends the same key deliberately) rests entirely on that cache holding.

**Ruling 2026-09-21: fix it, as its own wave, after W1 and before the
realtime seam.**

- *Not inside W1* — a migration plus a unique index is a different
  review surface, a different test type (a DB constraint test) and a
  different failure mode from W1's client-side classification. Bundled,
  a migration problem blocks a client fix that is otherwise ready.
- *Ahead of the realtime seam* — a double-recorded rally is data
  corruption on the money path and an umpire cannot distinguish it after
  the fact. The realtime seam is degradation: ugly, self-healing, and it
  makes nobody's score wrong. Corruption outranks degradation.
- W1 **shrinks this exposure** on the way past, because killing the
  wedge removes the futile resends that were repeatedly rolling the dice
  against a cold cache. W1-then-W2 is the right order on the merits, not
  merely a convenient one.

Greenfield schema (`RULES.md:30-34`): a new column and index are cheap
and expected; no contortion to avoid the migration.

### The shape of the fix (owner ruling 2026-09-21)

**A cache is the right home for rate limiting and the wrong home for
idempotency.** The two look alike and get opposite answers:

- *Rate limiting* is a fixed-window counter, inherently ephemeral. When
  it is lost it fails open to "allow", which is the safe direction for a
  scorer: someone goes unthrottled, and nobody's score is wrong. Redis
  is correct here and stays.
- *Idempotency* is a correctness guarantee. Fail-open means "write it
  twice". This is not only about outages — `IDEM_TTL_SECONDS` is 24h, so
  a retry past that window double-writes **by design**, and Upstash
  evicts under memory pressure besides. The ledger's protection against
  double-recording a rally currently rests on a store that is expected
  to forget.

So: `score_events` gets an `idempotency_key` column and a **unique index
on `(fixture_id, idempotency_key)`**. The database becomes the arbiter —
a duplicate insert raises a constraint violation, which the handler
translates into "return the original outcome". That is a true idempotent
replay with no cache in the correctness path. Redis may stay in front as
a fast path; it simply stops being load-bearing.

Secondary benefit that decides the testing story: `REDIS_URL` is **not
set locally** (confirmed 2026-09-21 — `cache.ts:35-36` gates everything
on it), so today neither the limiter nor the idempotency path executes in
dev or e2e at all. W1 Task 1 had to build an injection seam to test the
limiter. Moving idempotency into Postgres makes it exercised by the
existing suite for free, instead of needing a second such seam.

Evidence note: Redis IS live on staging — the owner's `RATE_LIMITED`
envelope proves the limiter fired. "Available on staging today" is not
the same claim as "never misses", and only the second would justify
leaving a correctness guarantee in a cache.

### As built (2026-09-22) — and the one premise above that is false

The ruling stands and shipped as written, with one correction that would
have made the wave inert had it not been caught by a red test.

**"A duplicate insert raises a constraint violation" is true only for the
RACE, and the race is not the common case.** `appendEvent` compares
`expected_seq` against the ledger tip (`append-event.ts:198`) and throws
`SEQ_CONFLICT` **before it attempts any insert**. In the ordinary
sequential retry — a pad resending a tap whose first write already
committed — the tip has moved, the seq check fires, and no unique
violation is ever raised. A handler matching only `23505` would compile,
pass review, and answer every real retry with a `409`: precisely the
defect this wave exists to remove. Measured red before the fix:
`EngineError: expected seq 1 but ledger is at 2`.

So the handler matches **both** shapes and gates the answer on a ledger
lookup rather than on the error code:

- `SEQ_CONFLICT` **or** a `score_events_idem_key` violation, **and**
- the fixture actually holds that key → answer with its original outcome.
- It does not → the `SEQ_CONFLICT` is genuine (another device got ahead)
  and still raises `409`.

Three more as-built notes:

- **The original outcome is reconstructed from the ledger**
  (`engine-db/replay.ts`), by folding UP TO the keyed event's seq through
  the write path's own `nextStatus`. Not a `match_states` read: that table
  holds the CURRENT state, which is a different answer the moment one more
  event lands, so a retrying pad would be handed a silently regressed score.
- **The ledger answer is rate limited** on `REPLAY_LIMIT`. It performs no
  write, but a `dl_` secret is a shareable URL, so an unbounded free
  surface is reachable by anyone holding a leaked link.
- **The claim above that this becomes "exercised by the existing suite for
  free" was optimistic.** It is exercised only by tests written to run with
  no cache mock at all; a suite that mocks `cacheGet` to hit never reaches
  the database branch. That is not hypothetical — it is why mutant M7
  survived `scoring-replay-is-free.test.ts`, the file that exists to pin
  that very limiter.

## 6b. Realtime propagation has almost no coverage (surveyed 2026-09-21)

Surveyed after the owner asked whether the realtime flows could be
proven in both the e2e suite and the walkthrough suite. Four propagation
flows exist; three have **no coverage at all**.

| Flow | Status |
|---|---|
| (a) device-link pad writes → organiser console **screen** reflects it | **none** |
| (b) console writes → device-link pad reflects it | **none** |
| (c) device chrome's own write → the **inner** v3 pad reflects it | **none** |
| (d) any write → public / spectator surface | covered |

- **(a)** `walkthrough/scorepad-v3-r7-console-chrome.spec.ts:214` and
  `scorepad-v3-cricket.spec.ts:496` both hold the console page open while
  a device writes — and then poll only `ledger(page.request, …)`. The
  console's DOM is never re-read after the device's tap, so the thing a
  person would notice is the one thing not asserted.
- **(b)** In r7 the console's `core.start` is recorded at `:230`, BEFORE
  the link is minted and the device opened at `:257`. What the device
  displays therefore arrived on initial load. No spec anywhere writes
  from the console with a device pad already mounted.
- **(c)** This is the owner's reported symptom, and it is already
  *documented and worked around* rather than tested:
  `scoring.spec.ts:532-542` states the console's `events` "is seeded once
  from server props and only ever refreshed by fixture-console's OWN
  send() calls — never by the pad's independent submission", and then
  calls `page.reload()` at `:553` to move past it.
- **(d)** Covered by `walkthrough/spectator-hub.spec.ts:448-466`,
  `hub-knockout.spec.ts:1325-1398`, `stream-overlay.spec.ts:794-878`.

### The clause that separates realtime from "eventually"

`stream-overlay.spec.ts:794-878` is the only test in the repo that proves
realtime rather than mere convergence: it asserts the score moves AND
that `elapsed < POLL_MS`. Without that second clause a propagation test
passes on the 15-second poll — which means it would have gone on passing
throughout the entire defect this wave exists to fix. **Every propagation
test added here carries that clause.**

Two corrections to this section, found when it was built (2026-09-22) — the
survey above was a hypothesis and these two rows did not survive the tree:

- **`POLL_MS` does not live in `use-pad-pipeline.ts` and is exported from
  nowhere.** It is `const POLL_MS = 15_000` at `use-fixture-stream.ts:21`.
  `usePadPipeline` only forwards a test-only `streamPollMs`. The new tests
  re-derive it by reading that source, the same idiom `enterprise-gate.spec.ts`
  uses, so moving the constant moves the tests with it.
- **The §6b(c) citation of `scoring.spec.ts:532-542` looks stale.** That
  comment claims the console's `events` are "only ever refreshed by
  fixture-console's OWN send() calls — never by the pad's independent
  submission". But `fixture-console.tsx:442`'s `handlePadEvents` is wired as
  `onEvents` at `:905`, and `pad-host.tsx:1575-1577` fires `onEvents` on any
  pipeline ledger change including a foreign-write merge. Read, not run —
  recorded as suspect rather than corrected.

And the clause has an environmental limit worth stating: CI builds against a
stub Supabase host and never subscribes, so the timing assertion degrades
there exactly as `stream-overlay.spec.ts:823-847`'s does. The two assertions
that are NOT environmental — the pad asked at the realtime-token door, and the
door answered 200 — fire in every branch. A prod-target run should set
`E2E_REQUIRE_REALTIME=1`, which turns the degradation into a hard red.

### A walkthrough that passes for the wrong reason

`walkthrough/scorepad-v3-r7-console-chrome.spec.ts:257` builds its
"courtside device" with a bare `context.browser()!.newContext()`, under
the comment *"its OWN browser context, no session cookie."* A bare
`newContext()` **inherits `use.storageState`** from `playwright.config.ts`
— measured directly in `api-keys.spec.ts:13-18`, where such a context came
back holding `seazn_session` and an unauthenticated API call answered
200. So that "device" is signed in as the organiser, and the spec's
void-authority assertions at `:284-296` may be satisfied for a reason
that has nothing to do with device links.

The correct idiom is documented at `device-links.spec.ts:36-39`; for a
context that will be DRIVEN, use `consentedAnonymousState()`
(`scorepad-a11y-kit.ts:346`), which is empty state plus a seeded
cookie-consent so the banner cannot race the pad.

### Mechanics any new spec owes

- `device-links.spec.ts` is in `SERIAL_SPECS` (`playwright.config.ts:31-32`)
  and therefore runs ONLY in the `serial` project
  (`--project=serial --workers=1`). It carries no `describe.configure`;
  its serial-ness comes from the project.
- The walkthrough project is selected by PATH alone
  (`playwright.config.ts:119,168-173`) and runs as a matrix leg of
  `e2e-parallel`.
- A new walkthrough spec MUST be named in `WALKTHROUGH_SPECS`
  (`src/lib/__tests__/e2e-ci-wiring.test.ts:159`) — the test at `:399-409`
  red-fails in every CI leg otherwise. Append at the END in wave order;
  the list is grouped by programme, never alphabetical.

### The switch existed and was never thrown — `scripts/realtime-gate.sh` (W3 T3, 2026-09-23)

`E2E_REQUIRE_REALTIME=1` has been honoured since the kit was written
(`e2e/realtime-propagation-kit.ts`, `const REQUIRE_REALTIME =
process.env.E2E_REQUIRE_REALTIME === "1"`). Nothing has ever set it.
Re-verified against the tree on 2026-09-23: `grep -rn E2E_REQUIRE_REALTIME
.github/` still returns **nothing** — not in `e2e.yml`, not in `ci.yml`, not in
any of the twelve workflow files.

**CI structurally cannot join a channel**, so this is not an oversight that CI
could absorb. Both halves re-read on 2026-09-23 and both still stand:

- `e2e.yml` sets `NEXT_PUBLIC_SUPABASE_URL: "https://stub.supabase.co"` — a
  stub host, chosen because `publicStorageUrl("")` "hides every badge/crest,
  making logo assertions untestable", with the file's own note that "No real
  Supabase call rides on it in e2e."
- The realtime signing key is a "CI-only dummy keypair (kid
  `e2e-ci-dummy-es256`) — generated for this workflow, **never imported into a
  real Supabase JWKS**."

So in CI the pad asks the token door, is answered 200, and then no socket ever
joins. The kit degrades by design and annotates the run; nothing reds.

**The local prod-target run can join, and it is the only thing that can.** The
gate is therefore a local command, not a CI job:

```bash
DATABASE_URL=<test db> DATABASE_SSL=disable \
  REALTIME_GATE_PORT=3371 scripts/realtime-gate.sh
```

It runs the two realtime-bearing specs in their own projects
(`e2e/device-links.spec.ts` under `serial`,
`e2e/walkthrough/console-device-live-sync.spec.ts` under `walkthrough`) with
`E2E_REQUIRE_REALTIME=1`, and it refuses to report a pass it did not earn.
Five exit codes, because "the gate could not run", "the gate ran nothing" and
"the gate red for an unrelated reason" must none of them read as a pass — nor
as a realtime regression:

| code | meaning |
|---|---|
| 0 | every realtime-bearing spec joined a channel and beat the poll |
| 1 | realtime regression — at least one pad sat on the poll |
| 2 | environment — no server, or no `DATABASE_URL`; nothing was measured |
| 3 | gate integrity — zero tests selected, or the spec set / clause / switch does not match the tree |
| 4 | inconclusive — **every** failing leg carried no realtime verdict at all |

Three things that guard are worth stating because each was a real hole:

- **The clause check counts CALL-shaped occurrences only.** In
  `device-links.spec.ts` the symbol appears three times — an import at `:5`,
  a prose comment at `:477`, and exactly **one** call at `:661`. A substring
  grep is satisfied by the comment alone, so every call site could be deleted
  and the gate would still run six tests, assert nothing about realtime, and
  exit 0. Measured: with the call commented out and the import and comment
  left in place, `grep -qa` is still satisfied.
- **The declared spec list is cross-checked against the tree**, in both
  directions: a declared spec with no call refuses, and a spec that calls the
  clause but is not declared refuses. That closes commenting an entry out,
  emptying the list, and adding a realtime spec nobody gated.
- **A failing leg is classified before the verdict is printed.** "At least one
  pad sat on the poll" is a claim about a cause, and it used to be printed on
  any non-zero leg — demonstrably wrongly (see the stale-server note below).
  A leg that fails carrying none of `assertPropagatedUnderPoll`'s four
  verdicts exits 4 instead.
- **A measured realtime verdict outranks a sibling leg's unrelated failure.**
  Classification is per leg *and remembered* per leg. One leg failing on a
  flake while another fails on a genuinely refused channel is not an
  inconclusive run — it is a regression plus a second problem, and it exits
  **1** with both legs named. The intermediate version tracked only "something
  failed without a verdict", which printed *"This is NOT evidence of a realtime
  regression"* over a sibling log containing "no websocket ever joined this
  fixture's channel". Driven, not argued: a keyless server taken down between
  the two legs produced exactly that state, and the two orderings give exit 1
  and exit 4 on the same run. An absent symptom that means *suppressed* rather
  than *safe* is the worst shape a gate can have, because the text tells the
  reader to stop looking.

One consequence worth knowing before you add a spec: the derivation looks for
a **direct** `assertPropagatedUnderPoll(` call. A spec that reaches the clause
through a shared helper is declared-but-not-derived and exits 3. Either call
the clause in the spec, or extend the derivation deliberately — do not delete
the cross-check to get past it.

Measured both ways on 2026-09-23, same build, same DB, same specs — the only
variable being whether the server got the ROOT `.env.local`:

| server | root `.env.local` | result |
|---|---|---|
| `:3371` | yes | **exit 0** — 8 passed (serial, 14.5s) + 3 passed (walkthrough, 12.9s) |
| `:3381` | no | **exit 1** — 1 failed / 7 passed, and 1 failed / 2 passed |

"Same DB" there is measured, not assumed — both repo `.env.local` files point
`DATABASE_URL` at the **dev** database, so a server on the test DB is on it
because something overrode them. `lsof` on the green server's pid shows its
pool connected to `127.0.0.1:54609`, and `pg_stat_activity` on that cluster
names those exact client ports as `seazn_w3rt` — the same database the
Playwright process and the red server used.

Both reds name the seam exactly:

> flow (c) device chrome -> its own inner pad: no websocket ever joined this
> fixture's channel, so the "under 15000ms" clause was NOT exercised. The value
> did arrive (13774ms, "0" -> "1"), by poll.

> flow (a) device-link pad -> organiser console screen: no websocket ever
> joined this fixture's channel ... The value did arrive (12955ms ...), by
> poll.

13.8s and 13.0s against a 15s poll: the value always arrives, which is why a
realtime regression here reads as a green suite and a lag rather than a
failure. The timings are also the fastest check that the gate ran for real —
the green legs finish in ~14s and ~13s, the red ones take 30s and 24s because
every measured write waits out the poll.

**The one thing every hand-rolled version gets wrong** is the server. The env
script passes only `apps/web/.env.local`; a key-name diff of the two files
shows exactly one difference, `SUPABASE_JWT_PRIVATE_KEY`, present in the root
file and absent from `apps/web`'s. Without it the server falls back to HS256
(`src/lib/realtime.ts` mints fine, and the token door still answers 200 — the
device-link token specs pass), and live Supabase then refuses the join. Start
the gate's server with **both** `--env-file` flags.

**A stale server reads as a realtime red, and the message does not say so.**
Found while proving this gate: a server left running from the previous day
(15h39m old) against a since-rebuilt `.next` serves HTML referencing chunks
that no longer exist — `/_next/static/chunks/<name>.js` answers **500
`text/plain`**, the browser raises `ChunkLoadError`, and the pad never mounts.
The specs fail on `toBeVisible()` for the pad, the page reads "Something went
wrong", and **no realtime message appears at all** — an environment fault
wearing a realtime costume.

The gate's first version printed "at least one pad sat on the poll" over
exactly that, which is why the classification in the table above exists: this
case now exits **4**, not 1, and says the run fell over before realtime was
measured. Verified against that same stale server, which was deliberately left
running as the fixture for it; a genuine no-root-`.env.local` server on the
current build still exits 1 on the same code, so the classifier discriminates
rather than merely suppressing. If you see exit 4, compare the server's start
time with the build's and restart it.

**Still OPEN for the owner, and not settled by this wave:** whether to give
Actions a real Supabase JWKS so CI can join a channel. It has its own cost and
its own secret-handling decision (note `e2e.yml`'s standing instruction not to
introduce a var whose name contains `PRIVATE_KEY`, because Actions strips
job-env vars by name match). Until that is decided, realtime is proven
**locally, deliberately, by running this script** — and nowhere else.

## 7. Open questions for the owner

1. ~~Durable idempotency~~ — **answered 2026-09-21**, see §6.
2. ~~W3's blast radius~~ — **answered 2026-09-21**, see §4.8.
3. **Ceiling value** — to be derived during implementation (§4.4) and
   brought back if the derivation is contested.
4. **A real Supabase JWKS for CI** — raised 2026-09-23, **not settled by
   W3**. CI cannot join a realtime channel by construction (stub host, dummy
   keypair — §6b), so `E2E_REQUIRE_REALTIME=1` can only ever be thrown
   locally, via `scripts/realtime-gate.sh`. Giving Actions a real JWKS would
   put realtime under CI, at the cost of a real signing key in the workflow
   and the name-matching secret-stripping problem `e2e.yml` documents.

## 7b. Wave sequence (owner-approved 2026-09-21)

1. **W1** — write-path correctness (§4), including the score-line fix
   folded in at §4.8 **and the `auth` forwarding pulled forward from §5**
   (see below). **MERGED 2026-09-22** (PR #823, squashed as `df892fac2`).
2. **W2** — durable idempotency (§6). Money path. **BUILT 2026-09-22** —
   see "As built" under §6 for the one design premise that proved false.
3. **W3** — the realtime seam (§5), less the `auth` forwarding. NEXT.

### `auth` forwarding pulled into W1 (owner ruling 2026-09-21)

Raised by an owner observation during the walkthrough: voiding from the
device-link chrome updates the outer panel instantly (its own `resync()`
at `device-score-pad.tsx:171`) while the inner pad lags seconds behind,
because only the inner pad depends on the stream — and the stream is
unauthenticated for device links (§5, first bullet).

Reasoning for the move, not merely convenience: W1 and W2 are both
verified by hand against a live pad, and every one of those verifications
is otherwise conducted through a 15-second lag that belongs to neither
wave. That makes each result ambiguous — a scorer, or a reviewer, cannot
tell a slow sync from a broken one. Fixing it first removes a confound
from every subsequent check rather than merely delivering its own value
sooner.

It is three files and carries its own e2e, which must drive the real
chain (`device-score-pad` → `registry` → `PadHostV3` → `usePadPipeline` →
`useFixtureStream`). Both ends of this seam already have passing tests
that drive the hook and the route directly, which is exactly why it
shipped inert.

### Recorded, not absorbed

`scoring.ts:258` publishes the fixture broadcast as
`void publishFixtureUpdate(fixtureId, "event")` — a floating promise that
a serverless handler can drop before the response flushes. If the pad
updates on a tap but never on a broadcast once the `auth` fix lands, this
is the next suspect. It is a separate defect and is not part of any wave
above.

## 8. Testing

All four types are owed (`RULES.md:65`), plus mutation proof on the
money path.

- **Unit** — transport classification per code, including absent-code
  fallback; limiter-after-idempotency; the ceiling firing on
  `conflict-again` and **not** on `network`.
- **Regression** — the observed scenario: void an already-voided entry,
  assert the queue head clears and the drain proceeds past it. Fails
  without the change.
- **E2E** — both undo controls; hide-while-held driven through the real
  producer and consumer; 320/768/1280 with no horizontal page scroll.
- **Smoke** — `scripts/smoke.ts`, pro and free paths.
- **Mutation** — delete the terminal-code branch; the suite must go red.
  Report the killer list, not a count.

### House-rule rows this satisfies

From the 2026-09-07 and 2026-09-14 owner checklists:

- *Use actual UI/API, not code inspection alone* — R1 was found by
  driving `stg` and reading a HAR; §3 exists because two code-derived
  claims did not survive contact with the source.
- *Cover concurrent/race* — the hold window with two live undo controls
  (§4.5) is the race.
- *Every guard needs a case that defeats it* — §4.7.
- *Derive expected values from the source of truth* — §4.4's ceiling.
- *Mutation-test the money/critical path specifically* — §8.
- *Negative assertion needs its positive pair* — the ceiling's
  `network` exemption is asserted in both directions.
- *New write path — diff against the nearest analogous path* — the
  device chrome's `send()` against the v3 pipeline's `sendOne()`.
