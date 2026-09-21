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
slot. This is not a new denial-of-service surface: the replay check is a
Redis GET, the same cost class as the limiter's own INCR.

### 4.3 Transport classification

`transport.ts:210,236-240` splits the 409 on code:

- `SEQ_CONFLICT`, **or an absent code** → `kind: "conflict"`.
  Renegotiable; path unchanged. Defaulting an absent code to today's
  behaviour means an un-migrated server cannot wedge a new client.
- `UNDO_NOOP` | `UNDO_TARGET_MISSING` | `UNDO_ALREADY_VOIDED` →
  `kind: "rejected"`.

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

## 7. Open questions for the owner

1. ~~Durable idempotency~~ — **answered 2026-09-21**, see §6.
2. ~~W3's blast radius~~ — **answered 2026-09-21**, see §4.8.
3. **Ceiling value** — to be derived during implementation (§4.4) and
   brought back if the derivation is contested.

## 7b. Wave sequence (owner-approved 2026-09-21)

1. **W1** — write-path correctness (§4), including the score-line fix
   folded in at §4.8 **and the `auth` forwarding pulled forward from §5**
   (see below).
2. **W2** — durable idempotency (§6). Money path.
3. **W3** — the realtime seam (§5), less the `auth` forwarding.

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
