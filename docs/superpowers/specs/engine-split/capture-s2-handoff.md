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
- A sport the server does not know, or a division pinned to a module version this build no longer ships, is `422 MODULE_NOT_FOUND`,
  not a 426 and not a 500.

**What is gated.** Only the `events` route. `lineups` (inputs to the fold, not a fold) and `finalize` (the server folds with its own
engine) are not. Anything posted to `events` is, including `core.void`: an outdated phone's undo is refused too, because it would
void against a ledger it folds differently. The web pad sends no epoch and is never refused. Server-internal writes (the
withdrawal cascade) carry none and are never refused.

**Ordering guarantees.** Tests are in `apps/web/src/server/usecases/__tests__/scoring-engine-epoch.test.ts` (case numbers below); the one
guarantee NOT pinned by a test is marked.

1. A retry the idempotency cache already answered returns `201` with the original answer before anything else is looked at (case 7,
   cache warm).
2. **Authorisation, entitlement and phase refusals outrank the 426.** A device link that may not write the event gets `403`, not 426
   (case 13, tested). A division not started (`422 WRONG_PHASE`), a frozen competition and the plan gates are raised by the same
   `assertEntitledToScore` that runs BEFORE the epoch check, so they win by code order; **no test pins those three**. An outdated
   phone that may not write at all is told that, not "update".
3. **An already-accepted key stays 201 after a bump** (case 7, cache warm AND cold). If the phone is behind but the ledger already
   holds that `idempotency_key` for this fixture, the server answers `201` with the ORIGINAL event. A lost ack's retry never turns
   into an "update the app" it cannot act on.
4. **A refusal burns nothing** (cases 4, 6, 8). It writes no row and caches nothing under the key: the same key K resent after the
   app updated is a new write, accepted exactly once. Two refusals in a row are two 426s and zero rows.
5. Only the moved sport is refused; every other sport at its own epoch still writes (cases 5, 9).
6. **Each 426 spends one slot of the fixture's shared write bucket** (`scorev1:{fixtureId}`, 10 per second, shared by EVERY device
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

- Show a clear "Update required" screen with a store link, in the app's own 4 locales. Map the CODE `ENGINE_OUTDATED`, like
  `refusal-copy.ts`; the server message is English-only.
- Treat it as **terminal**: never a retry loop. A resend is refused identically, and each refusal spends a slot of the fixture's
  shared write bucket, starving the other devices on that fixture. (The web pad's `transport.ts` already classifies every
  non-408/429, non-409 4xx as permanent; the native queue needs the same rule, or one outdated phone wedges its own queue head.)
- **Keep the unsent events queued. Never drop them.** After the update, resend them (same `idempotency_key`s; guarantee 3 and 4 make
  that safe). That recovery assumes the updated app folds the same ledger, which is what the epoch exists to ensure.
- Only the bumped sport is affected: the app keeps scoring other sports.

**Major / minor (engine-split owner; IN FLIGHT, not merged).** On branch `feat/engine-split-1e-minor` the fold version splits in two:
`FOLD_EPOCH` = MAJOR, which the server gates and which needs an app update; `FOLD_MINOR` = standings-only changes, which need no app
update and at most an optional "update available" prompt. **Pending merge; re-check names and shapes against that branch when it
lands.** This file describes `main` plus 1f as they are today (`foldEpochOf(sport): number`). Whatever the final shape: send the
MAJOR as `engine_epoch`.

**Option recorded, NOT decided.** After each sync the server could return the official state, so a phone that ever disagrees with
the server self-corrects instead of silently scoring on a divergent fold. Not built, not scoped; for S2's own design.

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

## 5. Checklist for S2

- [ ] `engine_epoch = foldEpochOf(fixture's sport)` on every `POST .../events`, `core.void` and retries included.
- [ ] 426 / `ENGINE_OUTDATED` mapped by code to localised "Update required" copy (4 locales) with a store link.
- [ ] 426 is terminal: no retry loop, queue kept, resent after update.
- [ ] Only the named `sport` blocked; other sports keep scoring.
- [ ] A test that drives the real queue through a faked epoch bump (the usecase tests' way), not a mocked transport.
- [ ] Re-read this file against `main` once 1f merges, and against `feat/engine-split-1e-minor` once it merges.
