# W3 — the realtime seam Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stop the pad from silently losing a foreign score after a 409, give the
fixture console a refresh of its own, and make "realtime actually delivered" a
gate that can fail instead of a warning nobody reads.

**Architecture:** Three independent changes, ordered by customer harm. The pad
currently uses `ledgerEvents.length` as if it were the ledger's tip seq; that is
true only while the ledger is gapless, and a 409 renegotiation makes it sparse.
Task 1 replaces the count with a derived tip in both the poll cursor and the
write cursor. Task 2 gives `fixture-console.tsx` its own visibility/focus
refresh so a stalled pad pipeline cannot freeze the chrome. Task 3 turns the
already-working `E2E_REQUIRE_REALTIME=1` switch into a gate that a local
prod-target run actually enforces.

**Tech Stack:** Next.js (repo fork — read `node_modules/next/dist/docs/` before
touching framework APIs), React 19 hooks, TypeScript 7, vitest
(`environment: "node"` — NO DOM), Playwright, Supabase Realtime private
channels.

**Spec:** `docs/superpowers/specs/2026-09-21-device-link-scoring-gaps-design.md`
§5 (W3), with §6b for the propagation-coverage survey.

## Global Constraints

- **§5's premise list is HALF STALE. Re-verified 2026-09-22 against `80f511234`;
  do not plan from the doc's own bullets.**
  - *"`auth` is never forwarded into the pipeline"* — **FIXED** by W1+W2.
    Forwarded end to end: `device-score-pad.tsx` (memoised `padAuth`) →
    `registry.tsx` → `pad-host.tsx:1528` (`auth` is now a REQUIRED prop) →
    `use-pad-pipeline.ts:1155` → `use-fixture-stream.ts:166`
    `authHeadersFor(auth)` → `transport.ts`. Nothing owed.
  - *"One-way resync — a console score never reaches the device header until the
    umpire taps"* — **FALSE as concluded.** `handlePadEvents` in
    `device-score-pad.tsx` is wired into `pad-host.tsx`, which fires it on every
    `pipeline.events` change, and `onStreamEvents` (`use-pad-pipeline.ts:1143`)
    merges realtime/poll batches into `ledgerEvents`. It IS two-way — but only
    while the pad is mounted. Nothing owed here; the real cause of the reported
    symptom is Task 1.
  - *"No independent refresh"* — **TRUE.** Task 2.
  - *"`sinceSeq` is an array count… unverified either way"* — **TRUE, and the
    hedge resolves against us.** Task 1.
- **Realtime itself WORKS — measured 2026-09-22, do not "fix" it.** Same build,
  same DB, `E2E_REQUIRE_REALTIME=1` both times; the only variable was whether the
  server got the ROOT `.env.local`:
  - without it: `device-links.spec.ts` **1 failed** — *"no websocket ever joined
    this fixture's channel… the value did arrive (14085ms) by poll"*
  - with it: **8 passed**, and `walkthrough/console-device-live-sync.spec.ts`
    (*"both ways, faster than the poll"*) passed with **zero** degradation
    annotations.
- **One channel per fixture, shared by both pads.** Publisher broadcasts
  `` `fixture:${fixtureId}` `` (`lib/realtime.ts:41`); the single token door
  returns `` channel: `fixture:${id}` ``
  (`api/v1/public/fixtures/[id]/realtime-token/route.ts:28`); the client
  subscribes to whatever the door returns. Auth changes only the Authorization
  header (`use-fixture-stream.ts:166`), never the channel name. Do not introduce
  a per-auth channel.
- **`apps/web` vitest is `environment: "node"` — no DOM.** A green unit suite
  cannot see CSS, tap area, or mount/unmount wiring. Anything a user touches
  needs the e2e too.
- **Judge vitest ONLY from `--reporter=json --outputFile`** (`numPassedTests` /
  `numTotalTests`). A config failure produces NO json file at all and exit codes
  lie — measured this session.
- **`DATABASE_URL` from `.env.local` is REFUSED by `vitest.config.ts`** (it
  points at the dev DB). For a suite that needs no DB, run
  `DATABASE_URL= npx vitest run <paths>`.
- **Every change ships a test that fails without it.** Mutate each new guard one
  at a time; a guard nothing kills is decoration.
- **Do not add a drain retry timer** (constraint inherited from W1, §5): against
  a wedged head a timer multiplies futile double-requests into the limiter.
- **No new user-facing strings** are expected in this wave. If one appears, it
  owes all 4 locale dictionaries plus a `gen-keys` regen — never hardcoded
  English.
- **New walkthrough specs MUST be named in `WALKTHROUGH_SPECS`**
  (`apps/web/src/lib/__tests__/e2e-ci-wiring.test.ts`), grouped by programme, NOT
  alphabetically. Omitting it reds both "Unit tests 2/4" and "Smoke — DB + Redis"
  from one assertion.
- **`cd <abs worktree> &&` in the SAME call as every command you judge.** The
  shell cwd resets to the main checkout between tool calls; a verify run then
  executes on `main` and returns a false green.

## Environment for this wave

Already standing (label `w3rt`, tree
`.claude/worktrees/w3-realtime-seam`):

- Postgres `postgresql://postgres@127.0.0.1:54609/seazn_w3rt`, `DATABASE_SSL=disable`
- placement `:50272`
- env-script server `:3345` — **cannot do realtime** (no root `.env.local`).
  Keep it: Task 3 Step 2 needs a server that CANNOT join, to prove the gate reds.
- hand-started server `:3371` — **can**; started with BOTH `--env-file`s. Its pid
  is in the session scratchpad (`w3-server-both.pid`), and
  `scratchpad/start-both-env.sh` recreates it with the free-port and
  own-listener checks already wired:

```bash
cd <worktree>/apps/web/.next/standalone/apps/web
PORT=3371 HOSTNAME=127.0.0.1 \
  node --env-file=/Users/ashokhein/github/seazn.club/.env.local \
       --env-file=/Users/ashokhein/github/seazn.club/apps/web/.env.local \
       server.js
```

Then PROVE the listener is yours: `lsof -nP -iTCP:3371 -sTCP:LISTEN -t` must
equal the pid you started (or its child). A health 200 can come from a squatter.

---

## File Structure

| file | responsibility in this wave |
| --- | --- |
| `apps/web/src/components/v2/scorepad/use-pad-pipeline.ts` (modify) | Derive the ledger TIP instead of using array length, in both the poll cursor (`:1156`) and the write cursor (`:1555`). |
| `apps/web/src/components/v2/scorepad/__tests__/use-pad-pipeline.test.tsx` (modify) | The sparse-ledger regression, red first. |
| `apps/web/src/components/v2/fixture-console.tsx` (modify) | Its own visibility/focus refresh, independent of the embedded pad's pipeline. |
| `apps/web/e2e/walkthrough/console-stalled-pipeline.spec.ts` (create) | Drives the console with the pad's stream blocked, in a browser. |
| `apps/web/src/lib/__tests__/e2e-ci-wiring.test.ts` (modify) | Register the new walkthrough spec. |
| `scripts/realtime-gate.sh` (create) | One command that runs the realtime-bearing specs with the enforcement flag against a server that can actually join. |
| `docs/superpowers/specs/2026-09-21-device-link-scoring-gaps-design.md` (modify) | §5 "As built", recording the two false premises; §6b, the gate. |
| `docs/superpowers/reviews/2026-09-22-w3-round-1.md` (create) | Findings, mutant table, raw gate counts. |

---

## Task 1: The ledger tip is a seq, not a count

**Files:**
- Modify: `apps/web/src/components/v2/scorepad/use-pad-pipeline.ts` (`:1156`, `:1555`, plus one new helper below `mergeEnvelopesIntoLedger` at `:678`)
- Test: `apps/web/src/components/v2/scorepad/__tests__/use-pad-pipeline.test.tsx`

**Interfaces:**
- Consumes: `mergeEnvelopesIntoLedger` (`:678`, signature
  `(current: readonly EventEnvelope[], incoming: readonly EventEnvelope[], opts?: { incomingWins?: boolean; incomingIsLocal?: boolean }): EventEnvelope[]`)
  — it merges BY SEQ into a `Map<number, EventEnvelope>` and returns the values
  sorted ascending by seq. That is exactly why a sparse ledger is representable.
- Produces: `function ledgerTipSeq(events: readonly EventEnvelope[]): number` —
  module-private, used by both cursors.

### Why this is a defect and not a tidy-up

`use-pad-pipeline.ts:1156` passes `sinceSeq: ledgerEvents.length` to
`useFixtureStream`, and `:1555` computes
`nextExpectedSeq = ledgerEventsRef.current.length + pendingEnvelopesRef.current.size`.
Both read the array's LENGTH as if it were the ledger's highest seq. That holds
only while the ledger is gapless from 1.

Seq is gapless **on the server** — `engine-db/append-event.ts` asserts
`expected_seq == max(seq)` under the lock and lands the new row at
`expectedSeq + 1`. The pad's local copy is a different object, and it can go
sparse:

1. Pad holds `{1,2}`, length 2, submits expecting seq 3.
2. The organiser console commits **seq 3** first.
3. The pad's write 409s. `sendOne` renegotiates and resends; the ack lands at
   **seq 4**. `runDrain` merges the ack at the SERVER's seq
   (`:1332` — `confirmedSeq = outcome.kind === "acked" ? outcome.result.seq : undefined`).
4. The intervening foreign row (seq 3) is read inside `resolveConflict`
   (`pipeline.ts`) to DECIDE the conflict — and is **never committed to
   `ledgerEvents`**.
5. Ledger is now `{1,2,4}`, length **3**. The poll asks `seq > 3`, which returns
   4 (already held). **Seq 3 is never requested again**, and nothing lowers the
   length, so only an `initialEvents` re-seed heals it.

Two consequences, and the second is worse than the first:

- The organiser's score is **permanently missing** from that pad — which is
  exactly the symptom §5 blamed on "one-way resync", a premise now known false.
- `:1555` then computes a stale `expectedSeq` for the NEXT write, producing
  another 409, another renegotiation, another gap. It compounds.

**This is reasoned from the code and NOT yet reproduced.** Step 1 exists to
settle that. If the test cannot be made to fail, STOP: record "P4 is not
reachable" as a false premise in the design doc's §5 "As built" (Task 4) and
skip to Task 2. A premise that survives a real attempt to falsify it is a
finding; forcing a fix for an unreachable bug is not.

- [ ] **Step 1: Write the failing test**

Add to `apps/web/src/components/v2/scorepad/__tests__/use-pad-pipeline.test.tsx`
(123KB — read the nearest existing `describe` FIRST and reuse its harness and
helper names; do not invent a second rig).

```tsx
describe("a sparse ledger after a 409 renegotiation", () => {
  // THE DEFECT: `sinceSeq`/`expectedSeq` read the ARRAY LENGTH as if it were
  // the ledger tip. That is true only while the ledger is gapless. A 409
  // renegotiation makes it sparse: our ack is merged at the server's seq while
  // the foreign row that caused the conflict is read by resolveConflict and
  // never committed. Length 3 over {1,2,4} then asks the poll for `seq > 3`,
  // so the foreign seq 3 is skipped FOREVER.
  it("asks the poll for events after the TIP, not after the count", async () => {
    const rig = renderPipeline({
      // {1,2,4} — deliberately sparse, exactly the post-renegotiation shape.
      initialEvents: [slotEvent(1), slotEvent(2), slotEvent(4)],
    });
    await rig.settle();

    // The cursor the stream was handed. A count says 3 and loses seq 3; the
    // tip says 4.
    expect(rig.lastSinceSeq()).toBe(4);
  });

  it("derives the next expectedSeq from the TIP, not the count", async () => {
    const rig = renderPipeline({
      initialEvents: [slotEvent(1), slotEvent(2), slotEvent(4)],
    });
    await rig.settle();
    await rig.submit({ type: "generic.result", payload: { p1Score: 1, p2Score: 0 } });

    // With a count the pad claims expected_seq 3 — a seq the server already
    // filled — and takes a 409 it did not need.
    expect(rig.lastSubmittedExpectedSeq()).toBe(4);
  });

  it("is unchanged for a gapless ledger — the normal case", async () => {
    // The POSITIVE pair. A "fix" that always returned `length + 1` would
    // satisfy both assertions above and break every ordinary pad; this is the
    // case that catches it.
    const rig = renderPipeline({
      initialEvents: [slotEvent(1), slotEvent(2), slotEvent(3)],
    });
    await rig.settle();
    expect(rig.lastSinceSeq()).toBe(3);
    await rig.submit({ type: "generic.result", payload: { p1Score: 1, p2Score: 0 } });
    expect(rig.lastSubmittedExpectedSeq()).toBe(3);
  });

  it("asks from 0 on an empty ledger", async () => {
    // The boundary a tip helper is most likely to get wrong: `events[len - 1]`
    // on an empty array is `undefined`, and `undefined.seq` throws where the
    // old `length` quietly answered 0.
    const rig = renderPipeline({ initialEvents: [] });
    await rig.settle();
    expect(rig.lastSinceSeq()).toBe(0);
  });
});
```

If `renderPipeline` does not already expose `lastSinceSeq()` /
`lastSubmittedExpectedSeq()`, add them to the existing harness by recording what
the fake transport was called with. Do NOT reach into the hook's internals —
record what crossed the seam, because that is what the server actually sees.

- [ ] **Step 2: Run the test and verify it fails for the RIGHT reason**

```bash
cd <worktree>/apps/web && \
DATABASE_URL="postgresql://postgres@127.0.0.1:54609/seazn_w3rt" DATABASE_SSL=disable \
  npx vitest run src/components/v2/scorepad/__tests__/use-pad-pipeline.test.tsx \
  --reporter=json --outputFile=/tmp/w3-t1-red.json
node -e 'const r=require("/tmp/w3-t1-red.json");console.log(r.numPassedTests,r.numFailedTests);
for(const s of r.testResults)for(const a of s.assertionResults)if(a.status==="failed")
console.log(a.title,"::",a.failureMessages[0].split("\n")[0]);'
```

Expected: the first two FAIL with `expected 3 to be 4`, the last two PASS.
A failure with any other message means the harness is wrong, not the product —
fix the harness before touching `use-pad-pipeline.ts`.

**If all four PASS**, the premise is false: the harness is not reproducing a
sparse ledger, or a commit path fills the gap. Do not force it. Record the
finding (Task 4) and move to Task 2.

- [ ] **Step 3: Add the helper**

Place it directly beneath `mergeEnvelopesIntoLedger` (`:678`), because it
depends on that function's sort order and the two must be read together.

```ts
/**
 * The ledger's highest known seq — NOT `events.length`.
 *
 * `mergeEnvelopesIntoLedger` above keys by seq into a Map and returns the
 * values sorted ascending, so the ledger is legitimately SPARSE after a 409
 * renegotiation: our ack is merged at the server's own seq while the foreign
 * row that caused the conflict was only read inside `resolveConflict` and
 * never committed. `{1,2,4}` then has length 3, and a cursor built from that
 * length asks the poll for `seq > 3` — skipping seq 3 permanently, because
 * nothing ever lowers the length again.
 *
 * Reads the LAST element rather than scanning for a max: the sort order is
 * that function's contract, and duplicating a max() here would let the two
 * drift apart silently.
 */
function ledgerTipSeq(events: readonly EventEnvelope[]): number {
  return events.length === 0 ? 0 : (events[events.length - 1]?.seq ?? 0);
}
```

- [ ] **Step 4: Use it at both cursors**

At `:1156`, inside the `useFixtureStream({...})` call:

```ts
    sinceSeq: ledgerTipSeq(ledgerEvents),
```

At `:1555`, inside the submit path:

```ts
        const nextExpectedSeq = ledgerTipSeq(ledgerEventsRef.current) + pendingEnvelopesRef.current.size;
```

Both, not one. They are the same assumption in two places, and fixing only the
poll leaves the compounding-409 half of the defect live.

- [ ] **Step 5: Run the test and verify it passes**

Same command as Step 2, writing to `/tmp/w3-t1-green.json`.
Expected: 4 passed, 0 failed.

- [ ] **Step 6: Run the whole pipeline suite, not just the new block**

```bash
cd <worktree>/apps/web && \
DATABASE_URL="postgresql://postgres@127.0.0.1:54609/seazn_w3rt" DATABASE_SSL=disable \
  npx vitest run src/components/v2/scorepad/__tests__/ \
  --reporter=json --outputFile=/tmp/w3-t1-suite.json
```

`use-pad-pipeline.test.tsx` is 123KB and `pipeline.test.ts` is 54KB; both encode
the old count-as-tip assumption in places. Read every failure before changing
it — a test that asserted the OLD behaviour must be corrected with a comment
saying so, never deleted.

- [ ] **Step 7: Mutation — prove the new guard is not decoration**

Apply each mutant, run the block from Step 2, restore, record the verdict.

| mutant | expected |
| --- | --- |
| M1 `ledgerTipSeq` returns `events.length` | KILLED by "asks the poll for events after the TIP" |
| M2 revert `:1156` only, keep `:1555` | KILLED by the `sinceSeq` test, and the `expectedSeq` test must still PASS — proving the two are independent |
| M3 revert `:1555` only, keep `:1156` | KILLED by the `expectedSeq` test only |
| M4 `ledgerTipSeq` returns `events[0]?.seq ?? 0` | KILLED by the sparse tests |
| M5 `ledgerTipSeq` returns `events.length + 1` | KILLED by the gapless case (the positive pair) |

A surviving mutant is a real gap — write the missing test rather than recording
it as acceptable.

- [ ] **Step 8: Typecheck and commit**

```bash
cd <worktree>/apps/web && npx tsc --noEmit -p tsconfig.json; echo "TSC=$?"
cd <worktree> && git add apps/web/src/components/v2/scorepad/use-pad-pipeline.ts \
        apps/web/src/components/v2/scorepad/__tests__/use-pad-pipeline.test.tsx
git commit -F <message file>
```

Commit message must state the `{1,2,4}` shape, that both cursors moved, and the
mutant table with its verdicts.

---

## Task 2: The console refreshes itself

**Files:**
- Modify: `apps/web/src/components/v2/fixture-console.tsx`
- Create: `apps/web/e2e/walkthrough/console-stalled-pipeline.spec.ts`
- Modify: `apps/web/src/lib/__tests__/e2e-ci-wiring.test.ts`

**Interfaces:**
- Consumes: the console's existing `resync()` — the same function its own send
  path already calls. Do not write a second fetch.
- Produces: no new exports.

### The gap, re-verified 2026-09-22

`fixture-console.tsx` (1245 lines) has **no** `setInterval` and **no**
`focus`/`visibilitychange` listener. Its only two `addEventListener` calls are a
dialog Esc trap and a menu-dismiss `pointerdown`. Every chrome refresh comes
from `handlePadEvents` or from its own `send()` / `resync()`.

So the console's freshness is entirely a function of the embedded pad's
pipeline. If that pipeline stalls — a token door 403 on a Community plan, a
websocket that joined and died, a wedged drain — the chrome silently serves
stale state with no upper bound. There is no independent floor.

**Deliberately NOT a poll.** A second interval on the same fixture doubles the
request rate for every console in the product, and W1's inherited constraint
warns against exactly this multiplication. A visibility/focus refresh costs one
request at the moment a human returns to the tab, which is when staleness is
actually visible.

- [ ] **Step 1: Confirm the selector and the fixture shape before writing**

A locator that matches nothing makes this whole test vacuous. Read
`fixture-console.tsx` for the real root testid and the element that renders the
running score, and read an existing walkthrough spec for the helper names
(`seedRosteredFixture` / `fixturePath` / `apiJson` / `TAG`) and their actual
signatures. Write the spec against what you read, not against the sketch below.

- [ ] **Step 2: Write the failing e2e**

Create `apps/web/e2e/walkthrough/console-stalled-pipeline.spec.ts`. A unit test
CANNOT cover this: `apps/web` vitest is `environment: "node"`, so there is no
`document`, no `visibilitychange`, and no way to observe the listener at all.

```ts
// WALKTHROUGH — the console must not depend on the pad's pipeline for
// freshness. Its own chrome refresh is the floor under every stall.
//
// The stall is induced at the NETWORK layer rather than by unmounting the pad,
// because that is the shape the defect takes in production: the pad is still
// mounted and still rendered, its stream is simply not delivering.
import { test, expect, type Page } from "@playwright/test";
import { apiJson, fixturePath, seedRosteredFixture, TAG } from "../helpers";

const console_ = (page: Page) => page.locator('[data-testid="fixture-console"]');

test("a console whose pad stream is dead still refreshes when the operator returns", async ({
  page,
}) => {
  test.setTimeout(180_000);
  const fx = await seedRosteredFixture(page.request, {
    label: `W3 Console Stall ${TAG}`,
    sportKey: "badminton",
    variantKey: "bwf",
    entrantKind: "individual",
    home: [{ fullName: `W3 Stall Home ${TAG}` }],
    away: [{ fullName: `W3 Stall Away ${TAG}` }],
    emitCoreStart: true,
  });

  // Kill the console's inherited stream BEFORE it mounts: both transports.
  // `abort` and not a stub response — a stalled pipeline is silence, and a
  // 500 would exercise an error path this test is not about.
  await page.route("**/api/v1/public/fixtures/*/realtime-token", (route) => route.abort());
  await page.route("**/api/v1/fixtures/*/events?since_seq=*", (route) => route.abort());

  await page.goto(await fixturePath(page.request, fx.fixtureId));
  await expect(console_(page)).toBeVisible({ timeout: 20_000 });

  // A score arrives from somewhere else entirely — a second official's device.
  await apiJson(page.request, `/api/v1/fixtures/${fx.fixtureId}/events`, "POST", {
    expected_seq: 1,
    type: "badminton.rally",
    payload: { wonBy: "home" },
  });

  // PRECONDITION, and the assertion that makes the rest non-vacuous: with the
  // stream dead the console must NOT have the score yet. If this ever fails,
  // the routes above are not blocking the transports and everything below
  // passes for the wrong reason.
  await expect(scoreCell(page, "home")).toHaveText("0", { timeout: 3_000 });

  // The operator switches away and comes back. This is the seam under test.
  await page.evaluate(() => {
    Object.defineProperty(document, "visibilityState", { value: "hidden", configurable: true });
    document.dispatchEvent(new Event("visibilitychange"));
  });
  // Let the fetch the console SHOULD now make succeed.
  await page.unroute("**/api/v1/fixtures/*/events?since_seq=*");
  await page.evaluate(() => {
    Object.defineProperty(document, "visibilityState", { value: "visible", configurable: true });
    document.dispatchEvent(new Event("visibilitychange"));
  });

  await expect(scoreCell(page, "home"), "the console never refreshed on its own")
    .toHaveText("1", { timeout: 20_000 });
});
```

`scoreCell` is whatever Step 1 established. Assert on a SCORE CELL, never
`toContainText("1")` on the whole console — a "1" appears in a date, a set
number and a seq, so a container-level probe passes in both states.

- [ ] **Step 3: Run it and verify it fails**

```bash
cd <worktree>/apps/web && \
DATABASE_URL="postgresql://postgres@127.0.0.1:54609/seazn_w3rt" DATABASE_SSL=disable \
  E2E_PROD_TARGET=1 PLAYWRIGHT_BASE="http://localhost:3371" \
  npx playwright test e2e/walkthrough/console-stalled-pipeline.spec.ts \
  --project=walkthrough --reporter=line
```

Expected: FAIL on the final assertion ("the console never refreshed on its
own"), with the precondition PASSING. If the precondition fails instead, the
route patterns are wrong — fix them first.

- [ ] **Step 4: Add the listener**

In `fixture-console.tsx`, near the component's other effects:

```tsx
  // W3 (design §5) — the console's own freshness floor.
  //
  // Every other refresh path here is downstream of the embedded pad's
  // pipeline: `handlePadEvents`, and this component's own `send()`/`resync()`.
  // So a stalled pipeline — a 403 from the token door on a Community plan, a
  // websocket that joined and died, a wedged drain — leaves the chrome serving
  // stale state with NO upper bound.
  //
  // Deliberately not an interval: a second timer on the same fixture doubles
  // the request rate for every console in the product, and W1's standing
  // constraint warns against that multiplication. A human returning to the tab
  // is both the cheapest trigger and the moment staleness is actually visible.
  useEffect(() => {
    const refreshIfVisible = () => {
      if (document.visibilityState !== "visible") return;
      void resync();
    };
    document.addEventListener("visibilitychange", refreshIfVisible);
    window.addEventListener("focus", refreshIfVisible);
    return () => {
      document.removeEventListener("visibilitychange", refreshIfVisible);
      window.removeEventListener("focus", refreshIfVisible);
    };
  }, [resync]);
```

`resync` must be stable (a `useCallback`) or this effect tears down and
re-subscribes on every render — the identity hazard W1 shipped a fix for in
`device-score-pad.tsx`. Check its declaration; if it is not memoised, memoise it
and say why in a comment.

- [ ] **Step 5: Run the e2e and verify it passes**

Same command as Step 3. Expected: 1 passed.

- [ ] **Step 6: Register the walkthrough**

In `apps/web/src/lib/__tests__/e2e-ci-wiring.test.ts`, append to
`WALKTHROUGH_SPECS` in the device-link programme block (beside
`console-device-live-sync.spec.ts` and `scoring-idempotency-retry.spec.ts`):

```ts
  // W3 — the console's own refresh floor. Drives the console with BOTH pad
  // transports aborted, so it proves the chrome refreshes without the
  // pipeline. No unit test can see it: apps/web vitest is environment "node",
  // so there is no document and no visibilitychange at all.
  "console-stalled-pipeline.spec.ts",
```

Omitting this reds two CI jobs from one assertion. Verify:

```bash
cd <worktree>/apps/web && DATABASE_URL= npx vitest run src/lib/__tests__/e2e-ci-wiring.test.ts \
  --reporter=json --outputFile=/tmp/w3-wiring.json
```

Expected: 14 passed (the count W2 left it at; 14+N if the file has since grown).

- [ ] **Step 7: Mutation**

| mutant | expected |
| --- | --- |
| M6 delete both listeners | KILLED by the new e2e |
| M7 drop the `visibilityState !== "visible"` early return | SURVIVES — acceptable ONLY if you add a case proving a hidden tab does not fetch; otherwise write it |
| M8 remove the `focus` listener, keep `visibilitychange` | SURVIVES (the test drives visibility) — record it, do not chase it |
| M9 make `resync` a fresh arrow each render | SURVIVES the assertion but should show as repeated subscribe churn; note it and rely on the memoisation check in Step 4 |

- [ ] **Step 8: Typecheck and commit**

```bash
cd <worktree>/apps/web && npx tsc --noEmit -p tsconfig.json; echo "TSC=$?"
```

---

## Task 3: A realtime gate that can fail

**Files:**
- Create: `scripts/realtime-gate.sh`
- Modify: `docs/superpowers/specs/2026-09-21-device-link-scoring-gaps-design.md` (§6b)

**Interfaces:**
- Consumes: `E2E_REQUIRE_REALTIME=1`, already honoured and enforced in
  `apps/web/e2e/realtime-propagation-kit.ts`.
- Produces: `scripts/realtime-gate.sh` — exit 0 only if every realtime-bearing
  spec joined a channel and beat the poll.

### Why this is owed

The switch already exists and already works — it is simply never thrown:

- `E2E_REQUIRE_REALTIME` appears in **no workflow** (`grep -rn` over `.github/`
  returns nothing).
- CI cannot join a channel by design: `e2e.yml` mints with a dummy ES256
  keypair whose own comment says it is *"never imported into a real Supabase
  JWKS"*, and `realtime-propagation-kit.ts` records that CI builds against a
  **stub Supabase host**.
- Locally, `seazn-env.sh` passes the server only `apps/web/.env.local`, which
  does not carry `SUPABASE_JWT_PRIVATE_KEY` (measured: root `.env.local` 1
  occurrence, `apps/web/.env.local` 0). So the server mints HS256 and live
  Supabase refuses every join.

Net: a genuine realtime regression today shows up as **a green suite and a
15-second lag**. That is exactly how "is the device pad in realtime?" went
unanswered until it was driven by hand this session.

CI is not fixable here without giving Actions a real Supabase JWKS — a separate
decision with its own cost, and an OPEN owner question this wave does not
settle. What IS fixable is the local prod-target run, demonstrated working on
2026-09-22, so this task makes it one command instead of a reconstruction.

- [ ] **Step 1: Write the gate**

Create `scripts/realtime-gate.sh`:

```bash
#!/usr/bin/env bash
# The realtime gate. Exits non-zero if any realtime-bearing spec fell back to
# the poll.
#
# WHY THIS EXISTS: `E2E_REQUIRE_REALTIME=1` has always been honoured
# (apps/web/e2e/realtime-propagation-kit.ts) and has never been set by
# anything. CI cannot help — it builds against a stub Supabase host and mints
# with a dummy keypair "never imported into a real Supabase JWKS" (e2e.yml) —
# so without this script nothing anywhere can tell a working channel from a
# 15-second poll, and a realtime regression reads as green.
#
# THE ONE THING EVERY HAND-ROLLED VERSION GETS WRONG: the server must be
# started with the ROOT .env.local as well. seazn-env.sh passes only
# apps/web/.env.local, which does NOT carry SUPABASE_JWT_PRIVATE_KEY, so the
# server mints HS256 and live Supabase refuses the join with
# JwtSignatureError. Measured 2026-09-22: same build, 1 failed without the
# root env file, 8 passed with it.
set -uo pipefail

PORT="${REALTIME_GATE_PORT:-3371}"
BASE="http://localhost:${PORT}"   # localhost, never 127.0.0.1 — the e2e suite
                                  # pins cookies to this host.

if ! curl -fsS -o /dev/null "${BASE}/api/health"; then
  echo "no server on ${PORT}. Start one with BOTH env files:" >&2
  echo "  cd apps/web/.next/standalone/apps/web && PORT=${PORT} HOSTNAME=127.0.0.1 \\" >&2
  echo "    node --env-file=<repo>/.env.local --env-file=<repo>/apps/web/.env.local server.js" >&2
  exit 2
fi

cd "$(dirname "$0")/../apps/web" || exit 2

# Specs that carry a realtime CLAUSE. Listed by behaviour, not by filename
# pattern: a `-g` filter or a `*realtime*` glob selects neither of these.
SPECS=(
  "e2e/device-links.spec.ts"
  "e2e/walkthrough/console-device-live-sync.spec.ts"
)

FAILED=0
for spec in "${SPECS[@]}"; do
  case "$spec" in
    e2e/walkthrough/*) project=walkthrough ;;
    *)                 project=serial ;;
  esac
  echo "=== ${spec} (${project}) ==="
  E2E_REQUIRE_REALTIME=1 E2E_PROD_TARGET=1 PLAYWRIGHT_BASE="$BASE" \
    npx playwright test "$spec" --project="$project" --reporter=line
  rc=$?
  [ $rc -ne 0 ] && FAILED=1
done

if [ $FAILED -ne 0 ]; then
  echo "REALTIME GATE: FAILED — at least one pad sat on the poll." >&2
  exit 1
fi
echo "REALTIME GATE: PASS — every channel joined and beat the poll."
```

`chmod +x scripts/realtime-gate.sh`.

Confirm the two project names against `playwright.config.ts` before running —
a `--project` that does not exist errors rather than silently selecting
nothing, but confirm anyway.

- [ ] **Step 2: Prove the gate can FAIL, not just pass**

A gate that cannot go red is decoration. Run it against the server that
**cannot** join (`:3345`, started by the env script without the root env file):

```bash
cd <worktree> && REALTIME_GATE_PORT=3345 scripts/realtime-gate.sh; echo "EXIT=$?"
```

Expected: `EXIT=1`, with *"no websocket ever joined this fixture's channel"* in
the output. This is the whole proof — quote it in the commit message.

- [ ] **Step 3: Prove it passes on a server that CAN join**

```bash
cd <worktree> && REALTIME_GATE_PORT=3371 scripts/realtime-gate.sh; echo "EXIT=$?"
```

Expected: `EXIT=0`, `REALTIME GATE: PASS`.

Both runs are required. A pass alone proves nothing; a red alone proves nothing.

- [ ] **Step 4: Record it in the design doc**

Append to §6b of
`docs/superpowers/specs/2026-09-21-device-link-scoring-gaps-design.md` a short
subsection stating: the switch existed and was never set; CI structurally cannot
join (stub host + dummy keypair, both quoted); the local prod-target run can and
was measured doing so on 2026-09-22; `scripts/realtime-gate.sh` is now the way to
run it; and that giving CI a real Supabase JWKS remains an OPEN owner decision
this wave did not settle.

- [ ] **Step 5: Commit**

---

## Task 4: Record what the design got wrong

**Files:**
- Modify: `docs/superpowers/specs/2026-09-21-device-link-scoring-gaps-design.md` (§5)
- Create: `docs/superpowers/reviews/2026-09-22-w3-round-1.md`

- [ ] **Step 1: Add an "As built" to §5**

It must state, with evidence:

1. *"`auth` is never forwarded"* — **FIXED** by W1+W2, with the full chain.
2. *"One-way resync"* — **FALSE as concluded.** The clause was true; the
   conclusion was not. The real cause of "a console score never reaches the
   device" is Task 1's sparse-ledger cursor. Note that a false premise pointed
   two waves at the wrong component.
3. *"`sinceSeq` is an array count — unverified"* — resolved, carrying whichever
   verdict Task 1 Step 2 actually produced (defect confirmed, or premise
   unreachable). Write what the run said, not what this plan predicted.
4. **Realtime works**, with the measured before/after and the root-`.env.local`
   cause.

- [ ] **Step 2: Write the review record**

Same shape as `docs/superpowers/reviews/2026-09-22-w2-round-1.md`: findings,
the mutation table with EVERY verdict including survivors, the gates with raw
counts, and an explicit "not done / owner calls" section carrying the CI-JWKS
question.

- [ ] **Step 3: Full gate before the PR**

```bash
cd <worktree>/apps/web && \
DATABASE_URL="postgresql://postgres@127.0.0.1:54609/seazn_w3rt" DATABASE_SSL=disable \
  npx vitest run src/components/v2/scorepad/__tests__/ src/lib/__tests__/e2e-ci-wiring.test.ts \
  --reporter=json --outputFile=/tmp/w3-final.json
cd <worktree>/apps/web && npx tsc --noEmit -p tsconfig.json; echo "TSC=$?"
cd <worktree> && REALTIME_GATE_PORT=3371 scripts/realtime-gate.sh; echo "GATE=$?"
```

Confirm `.testResults[].name` resolves inside the w3 worktree before believing
any count. Paste the raw numbers into the review record — "tests pass" without
counts is not a gate.

- [ ] **Step 4: PR, and dispatch e2e explicitly**

`.github/workflows/e2e.yml` triggers on push to `main` ONLY — a PR gets zero
e2e signal automatically. **Re-read the file rather than trusting this line**;
the trigger has changed three times in one day historically. After opening the
PR:

```bash
gh workflow run e2e.yml -f pr=<number>
```

Note in the PR body that CI's e2e cannot exercise the realtime clause (stub
host), so the realtime gate is a LOCAL result and must be quoted in the
description rather than inferred from a green CI.

- [ ] **Step 5: Tear down**

```bash
kill "$(cat <scratchpad>/w3-server-both.pid)"
~/.claude/skills/seazn-local-env/scripts/seazn-env.sh down --label w3rt
```

Then confirm nothing still listens on 3345/3371/50272 — teardown needs a
positive ownership check, not an exit 0.

---

## Self-review

**Spec coverage.** §5 has four bullets. Bullet 1 (auth) is FIXED and is recorded
in Task 4 rather than implemented. Bullet 2 (one-way resync) is FALSE and is
recorded in Task 4. Bullet 3 (no independent refresh) is Task 2. Bullet 4
(`sinceSeq`) is Task 1. §5's closing note — *"cross-pad lag is the MEASUREMENT
W1 and W2 must move… re-measure after"* — is satisfied by Task 3's gate, which
turns that measurement into a pass/fail. §6b's coverage survey is addressed by
Tasks 2 and 3. No §5/§6b requirement is unassigned.

**Placeholder scan.** No TBD/TODO. Every code step carries real code; every
verify step carries the command and the expected output. Task 1 Step 1 and Task
2 Step 1 name the harness/selector work they need rather than leaving it
implied.

**Type consistency.** `ledgerTipSeq(events: readonly EventEnvelope[]): number`
is defined once in Task 1 Step 3 and used with that exact name in Step 4 and in
the mutant table. `resync()` in Task 2 is the console's existing function, not a
new one. `REALTIME_GATE_PORT` is the same variable in Task 3 Steps 1–3 and Task
4 Step 3. `scoreCell` is introduced in Task 2 Step 1 and used in Step 2.

**One honest gap, deliberately left.** Task 1's defect is reasoned from code and
not yet reproduced. Step 2 is written to settle it either way, and the task says
explicitly what to do if it cannot be made to fail: record it as a false premise
and move on. This plan must not be executed as though Task 1's premise were
already proven.
