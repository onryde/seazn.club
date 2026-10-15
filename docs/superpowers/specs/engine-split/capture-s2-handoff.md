# Capture S2 handoff — `engine_epoch` at the scoring door

**RECOMMENDATION to put to your owner (AGENTS.md class 17).** This is the engine-split programme's recommendation to the capture
(mobile-s1 / S2) programme. Where it says "owner", it means the engine-split owner's position, relayed second-hand: it is NOT a
ruling of yours. Put each position below to your own owner before building on it.

- Written for: engine-split batch 1f, Task 1f-2 (spec §5.6, D15, D26, D31). Plan: `docs/superpowers/plans/2026-10-13-engine-split-phase1.md`.
- Server side: commits `287295d9d` and `a7fb39b13` on `feat/engine-split-1f`, **in review and NOT merged to `main` at the time of writing**.
  Everything under "The server contract" was verified against that branch (usecase tests, a prod-build e2e, smoke), not against `main`.
- `docs/contracts/` holds no scoring-events contract today (D32c). This file is the stand-in until S2 writes one; vendor from it, then
  move it there.

## 1. The server contract

**Endpoint.** `POST /api/v1/fixtures/{id}/events`, body `{ expected_seq, type, payload, idempotency_key?, engine_epoch? }`.

**The field.** `engine_epoch`: an integer ≥ 1, optional on the wire. It is the fold epoch of the phone's bundled engine for THIS
fixture's sport: `foldEpochOf(sport)` from `@seazn/engine/sport`. Send it on **every** write to that endpoint, `core.void` and keyed
retries included. The phone sends only the number; the server's own record of the fixture's sport is authoritative (D31), so the
phone must resolve the sport the same way it picks the module it folds with. `0`, a negative, a fraction or a string is a
`400 VALIDATION` and writes nothing.

**Today every sport's epoch is 1** (11 sports, `FOLD_EPOCH` in `packages/engine/src/sport/fold-epoch.ts`). A phone cannot be behind
until the first bump. Test the 426 path with a faked epoch, as the server's own tests do; never type the number.

**The comparison (owner positions, 2026-10-15):**

| phone's `engine_epoch` | server's `foldEpochOf(sport)` | result |
|---|---|---|
| absent | any | accepted (D31: the server cannot tell a capture phone from the web pad, so a missing value is never a refusal) |
| equal | | accepted |
| **higher** | | **accepted** — a phone ahead of the server is a supported state ("we maintain 2-3 backward version support with release discipline") |
| **lower** | | **refused 426, no grace window** |

**The refusal.** HTTP `426`, body

```json
{ "ok": false,
  "error": { "code": "ENGINE_OUTDATED", "message": "<English>", "sport": "badminton", "required": 2, "got": 1 },
  "requestId": "<uuid>" }
```

- `sport` is the fixture's sport key, `required` the server's epoch for it, `got` the epoch the request carried.
- `message` is English prose and **English only**, by the API's convention (the web pad's `components/v2/scorepad/refusal-copy.ts`
  maps the wire CODE to its own 4-locale copy and "never falls through to server prose"). Map `error.code`, never show `message`.
- **Key on `error.code`, never on the status alone.** The 426 carries no `Upgrade` header (it is not a protocol upgrade, and
  HTTP/2 forbids the header), so a generic HTTP stack that treats 426 as "retry with a different protocol" has nothing to act on.
  `ENGINE_OUTDATED` is the only 426 this API sends.
- A sport the server does not know, or a division pinned to a module version this build no longer ships, is `422 MODULE_NOT_FOUND`,
  not a 426 and not a 500.

**What is gated.** Only the `events` route. `lineups` (inputs to the fold, not a fold) and `finalize` (the server folds with its own
engine) are not. Anything posted to `events` is, including `core.void`: an outdated phone's undo is refused too, because it would
void against a ledger it folds differently. The web pad sends no epoch and is never refused. Server-internal writes (the
withdrawal cascade) carry none and are never refused.

**Ordering guarantees.** Tests are in `apps/web/src/server/usecases/__tests__/scoring-engine-epoch.test.ts` (case numbers below); a
guarantee NOT pinned by a test is marked.

1. The route's authentication runs FIRST, and for a `dl_` device link it also meters the link (`dlv1:<link>`, 10 per second per
   link, spent by every write including one that ends in a 426). Then, in scoring, a retry the idempotency cache already answered
   returns `201` with the original answer before the entitlement, phase and epoch checks are looked at (case 7, cache warm).
2. **Authorisation, entitlement and DIVISION-phase refusals outrank the 426.** All three are raised by `assertEntitledToScore`, which
   runs before the epoch check; an outdated phone that may not write at all is told that, not "update". Tested: a device link that may
   not write the event gets `403` (case 13); a division not yet started (`setup` / `scheduled`) gets `WRONG_PHASE` (case 13b); a frozen
   (over-quota) competition gets the `402` paywall (case 13c). The `cricket.dls` plan gate sits in the same function and wins the same
   way by code order; **no test pins that one**.
   **Ledger-level refusals do NOT outrank it.** A stale `expected_seq` (`SEQ_CONFLICT`), a fixture already decided, and an event the
   sport module rejects come from `appendEvent`, which runs AFTER the gate: a behind phone sees `426` first (case 13d, stale seq;
   the other two are by code order, unpinned). That is consistent with the terminal rule in §3: nothing such a phone sends can be written.
3. **An already-accepted key stays 201 after a bump** (case 7, cache warm AND cold). If the phone is behind but the ledger already
   holds that `idempotency_key` for this fixture, the server answers `201` with the ORIGINAL event. A lost ack's retry never turns
   into an "update the app" it cannot act on. The lookup is scoped to the fixture: a key accepted on fixture A never answers a NEW
   write on fixture B (case 15; the same key on B at the current epoch is a new write there). A keyed `core.void` is covered too, at
   EVERY epoch state and with the cache cold (cases 7b, 7c; before review F4 a cold-cache retry of an accepted keyed undo was refused
   `409 UNDO_ALREADY_VOIDED` instead of replayed). One exception, pre-existing and NOT fixed in 1f: see §4, "keyed retry of the event
   that finalized the fixture".
4. **A refusal burns nothing** (cases 4, 6, 8). It writes no row and caches nothing under the key: the same key K resent after the
   app updated is a new write, accepted exactly once. Two refusals in a row are two 426s and zero rows.
5. Only the moved sport is refused; every other sport at its own epoch still writes (cases 5, 9).
6. **Each 426 spends TWO rate-limit slots**: the sender's own (`dlv1:<link>` for a `dl_` device link, 10 per second per link, taken at
   the door before scoring) and the fixture's shared write bucket (`scorev1:{fixtureId}`, 10 per second, shared by EVERY device
   scoring that match). See §3: a retry loop starves the other scorers.

## 2. What the phone bundles

Only these `@seazn/engine` subpaths, which are the phone-safe closure (no `node:*`, no `process`, nothing from `scheduling`):
`@seazn/engine/core`, `@seazn/engine/sport`, `@seazn/engine/sports`, `@seazn/engine/sports/<dir>`. **The authority is
`@seazn/engine/phone-subpaths.json`** (`subpaths`, plus the pinned module closure and the date it was measured); a subpath not in
it is not phone-safe. `foldEpochOf` and `FOLD_EPOCH` live in `@seazn/engine/sport` and import nothing. The package is published as
`@onryde/seazn-engine` and imported as `@seazn/engine` through an alias (D19); canaries publish from `main`, while the production
server deploys from tags, so the engine a phone bundles can be newer than the one the server runs (see §3, release order).

The epoch moves with the fold: a sport's number is bumped in the SAME change that makes an existing event sequence fold
differently for it (CI: `fold-epoch:check --against HEAD^1`). It is per sport, so a badminton bump never touches a cricket scorer.

## 3. Positions to put to your owner

**Release order (engine-split owner).**

1. Ship the app update carrying the new rules FIRST. The old server accepts the higher epoch.
2. Wait for adoption, or use a store forced update, before tournament days.
3. THEN deploy the server.

The reverse order refuses every scorer of that sport as soon as the server deploys, possibly mid-match, with no way to proceed
before they update. There is no grace window, so this ordering is the only protection.

**What the app does on a 426 (engine-split owner).**

- Show a clear "Update required" screen with a store link, in the app's own 4 locales. **The app must NOT render the server's
  `error.message`**: it is English-only prose. Map the CODE `ENGINE_OUTDATED` to the app's own localised copy, exactly as the web pad's
  `refusal-copy.ts` maps codes and never falls through to server prose. `sport`, `required` and `got` are safe to show or log.
- A 426 is a THIRD class of failure, **"parked until update"**: it is neither a transient failure (network, 408, 429, 5xx: retried
  with backoff) nor a permanent refusal (a 403 or 404: the write is reported "not recorded" and DROPPED, as the web pad's
  `transport.ts` does for every other 4xx). Parked means: STOP, show the update prompt, never drop the write, never auto-retry it
  until the app is updated. A resend is refused identically, and each refusal spends two rate-limit slots (§1, guarantee 6),
  starving the other devices on that fixture. The native queue therefore needs its own state for it; copying the web pad's
  permanent-4xx rule would silently lose the scorer's taps, and treating it as transient would loop.
- **Keep the unsent events queued, in order. Never drop them**, and do not resend them automatically before the app is updated.
  After the update, resend them (same `idempotency_key`s; guarantees 3 and 4 make that safe). That recovery assumes the updated app
  folds the same ledger, which is what the epoch exists to ensure.
- Only the bumped sport is affected: the app keeps scoring other sports.

**Major / minor (engine-split owner; IN FLIGHT, not merged).** On branch `feat/engine-split-1e-minor` the fold version splits in two:
`FOLD_EPOCH` = MAJOR, which the server gates and which needs an app update; `FOLD_MINOR` = standings-only changes, which need no app
update and at most an optional "update available" prompt. **Pending merge; re-check names and shapes against that branch when it
lands.** This file describes `main` plus 1f as they are today (`foldEpochOf(sport): number`). Whatever the final shape: send the
MAJOR as `engine_epoch`.

**The server's state is already returned, and is the record (exists today; S2 should use it).** Every `201` carries the server's
own fold of the ledger up to that event: `state_summary`, `outcome`, `status`. `GET /api/v1/fixtures/{id}/state` serves the full
state. The web pad reconciles its optimistic fold against the server's on EVERY ack (`apps/web/src/components/v2/scorepad/
use-pad-pipeline.ts`, header comment). S2 should do the same, so a phone whose fold ever disagrees with the server's self-corrects
instead of scoring on a divergent fold. Nothing new needs building server-side for this.

**The ahead window (consequences of the release order above).** Between the app update and the server deploy, phones at epoch N+1
score against a server still at N. That is accepted on purpose, and it means: (1) the phone folds the bumped sport DIFFERENTLY from
the server, so its optimistic state and the server's `state_summary` can disagree, and the server's is the record (reconcile to it);
(2) an event that only the NEW rules allow (a rule-widening change) can be accepted by the phone's fold but REFUSED by the server's
older one with a `422` until the server deploys. S2 must surface that refusal to the scorer, not hide it or treat it as parked.

**Owed to S2's own design, recorded not decided (D26).** What a match ALREADY in progress does when its sport's epoch moves. With no
grace window the answer today is "the scorer is blocked until the app updates, and the queue waits"; whether to finish under the old
rules instead needs an epoch per division or fixture, which does not exist.

## 4. Known limits of the epoch guard (do not rely on it for more than it does)

- The guard compares the golden corpora (`packages/engine/src/sports/*/*.golden.json`). Those pin the **module layer** only. Coverage
  of core events is thin: `core.void`, `note`, `finalize`, `award`, `suspend`, `resume`, `settle` appear in 0 of 11 corpora and
  `core.abandon` in 6 of 11. The extension is on branch `test/golden-core-event-floor` (in flight).
- **Kernel overlays are not pinned**: the kernel's `outcomeOf` / `summaryOf` (settlement, expunge, withdrawal over a held level
  result), stoppage, and `forfeit-credit.ts`. A rule change there moves no golden and does NOT force a bump: it owes a MANUAL bump of
  every sport it reaches. See `packages/engine/src/testkit/GOLDEN-POLICY.md`, "What the guard cannot see".
- A bump is also forced by deltas-only or harness-only rewrites of a corpus; each locks out every older phone of that sport.
  (In flight on `feat/engine-split-1e-minor`, pending merge: a standings-only change becomes a MINOR bump that locks nobody out.)
- **A keyed retry of the event that finalized the fixture** (or otherwise left it `finalized` / `cancelled`), with the idempotency
  cache cold, is answered `ALREADY_DECIDED` by `appendEvent`, which checks the fixture's lock BEFORE its seq check and so never
  reaches its replay catch. Pre-existing (measured on the 1f branch with an up-to-date phone and no epoch involved), not fixed in 1f. A
  BEHIND phone's retry of the same event is answered `201` by the epoch gate's own replay (case 7d). The pad should read
  `ALREADY_DECIDED` on a keyed retry of its own finalize as "already done", and reconcile from `GET .../state`.

## 5. Checklist for S2

- [ ] `engine_epoch = foldEpochOf(fixture's sport)` on every `POST .../events`, `core.void` and retries included.
- [ ] 426 / `ENGINE_OUTDATED` mapped by code to localised "Update required" copy (4 locales) with a store link.
- [ ] 426 is "parked until update": never dropped, never auto-retried, queue kept in order, resent after the update.
- [ ] Reconcile the optimistic fold against the `201` body's `state_summary` / `outcome` / `status` on every ack.
- [ ] Only the named `sport` blocked; other sports keep scoring.
- [ ] A test that drives the real queue through a faked epoch bump (the usecase tests' way), not a mocked transport.
- [ ] Re-read this file against `main` once 1f merges, and against `feat/engine-split-1e-minor` once it merges.
