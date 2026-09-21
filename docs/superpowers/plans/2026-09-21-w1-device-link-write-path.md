# W1 — Device-link write-path correctness Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stop a terminal undo refusal from permanently wedging the scoring queue, and stop the pad lying about why.

**Architecture:** The server already refuses four undo cases with HTTP 409, but so does a genuine sequence conflict, and `transport.ts:210` treats every 409 as renegotiable. Give the four terminal cases explicit machine codes, classify on the code rather than the status, and add a bounded ceiling so any unenumerated 409 degrades visibly instead of wedging. Two UI defects found in the same walkthrough ride along because they land in files this wave already owns.

**Tech Stack:** TypeScript 7, Node 26, Next.js, vitest (node environment — no DOM), Playwright, Upstash Redis, Postgres.

**Spec:** `docs/superpowers/specs/2026-09-21-device-link-scoring-gaps-design.md`

## Global Constraints

- TypeScript **7**, Node **26**. `apps/web` typecheck peaks ~2.8 GB — run with `NODE_OPTIONS=--max-old-space-size=6144`.
- Every user-facing string ships in **all four** dictionaries: `apps/web/src/dictionaries/{en,es,fr,nl}/ui.json`, flat dotted keys. Then `npm run i18n:gen-keys` — `i18n-keys.ts` is generated, never hand-edited.
- Verify vitest green **only** from `--reporter=json --outputFile` plus a `jq` read of `numPassedTests`/`numTotalTests`. `rtk`'s `PASS(0) FAIL(0)` can mean *failed to collect*.
- Prefix **every** `tsc`/`vitest`/`eslint` invocation with `rtk proxy`, including `--version` probes — a bare invocation can return fabricated output in this repo.
- `apps/web` vitest is `environment: "node"`. There is **no DOM**. A component's rendered classes are visible to a string scan; visibility, layout and tap area are not. Anything a user touches owes an e2e test, not a unit test.
- Work in a **worktree**, never a checkout in the main repo dir. Symlink `node_modules`; confirm `readlink -f node_modules/@seazn/engine` points at **your** worktree.
- Shell cwd resets to the main checkout between calls — prefix `cd <abs worktree> &&` in the **same** call.
- Do **not** `git stash` in a worktree; the stash stack is shared with the main checkout.
- Before the PR: `npm run openapi:gen` then `npm run i18n:gen-keys` then `git status --porcelain` must be **empty**. Both gates are CI-only.
- Do not open GitHub issues. Fix inline; if a fix widens blast radius past this plan's files, stop and ask.
- Where an e2e snippet below elides fixture setup (`// … open a device-link pad …`), reuse the setup helpers **already in `apps/web/e2e/device-links.spec.ts`** — that file has working device-link setup at `:9`, `:90`, `:156` and `:240`. Do not write a second one, and do not invent a helper name; read the file and use what is there.
- Sweep by behaviour, never by filename. Before claiming a change is covered, `git grep -a` the testid, route or wire code across `e2e/` — the spec that actually exercises a path is often not the one named after it.

---

### Task 0: Forward `auth` into the pipeline so a device-link pad gets realtime

Pulled forward from W3 by owner ruling 2026-09-21, because every manual verification of the rest of this wave is otherwise slowed by a 15-second lag that is not the fault of the thing being verified.

`ScorePadProps` declares `auth` (`registry.tsx:193-221`), `device-score-pad.tsx:347` passes it, `registry.tsx:256` uses it to pick `deviceLinkTransport`, and then `registry.tsx:289-304` **does not forward it to `PadHostV3`**. So `use-pad-pipeline.ts:1141` resolves `params.auth ?? SESSION_AUTH` to the session default, and the realtime-token fetch (`use-fixture-stream.ts:165`) goes out with no `Bearer dl_` header. On any fixture that is neither entitled nor official the token request is refused and the pad falls back to the 15s poll (`use-fixture-stream.ts:21,151-152`).

Observed by the owner on staging 2026-09-21: "Void my last entry" updates the outer chrome instantly (its own `resync()` at `device-score-pad.tsx:171`) while the inner pad takes seconds to catch up, because only the inner pad depends on the stream.

**Why this shipped inert:** the route's device-link bypass (`realtime-token/route.ts:46`), its e2e (`device-links.spec.ts:240`) and its unit test (`use-fixture-stream.test.ts:272`) all drive the hook or the route **directly**. Both ends are proven by fixtures while no production caller drives the seam. The test in Step 4 therefore drives the real chain or it proves nothing.

**Files:**
- Modify: `apps/web/src/components/v2/scorepad/v3/pad-host.tsx:1437-1500` (prop), `:1530-1539` (pass to the pipeline)
- Modify: `apps/web/src/components/v2/scorepad/registry.tsx:289-304` (forward)
- Test: `apps/web/e2e/device-links.spec.ts`

**Interfaces:**
- Consumes: `PadAuthMode` (the type `authHeadersFor` takes, `transport.ts:85`) and `ScorePadProps.auth`, both of which already exist.
- Produces: `PadHostV3Props.auth?: PadAuthMode`.

- [x] **Step 1: Confirm the two names before writing code**

Read `use-pad-pipeline.ts:1139-1148` and confirm the pipeline params field is spelled `auth`, and `transport.ts:80-90` for the exact exported name of the auth-mode type. Both were reported as `auth` / `PadAuthMode`; use whatever is actually there. Everything below assumes those two names.

- [x] **Step 2: Write the failing e2e**

```ts
// apps/web/e2e/device-links.spec.ts
test("a device-link pad authenticates its realtime token", async ({ page }) => {
  const tokenRequests: (string | undefined)[] = [];
  await page.route("**/api/v1/public/fixtures/*/realtime-token", async (route) => {
    tokenRequests.push(route.request().headers()["authorization"]);
    await route.continue();
  });

  // … open /score/{dl_token} for a fixture that is NOT entitled and NOT official …

  await expect.poll(() => tokenRequests.length).toBeGreaterThan(0);
  expect(tokenRequests[0]).toMatch(/^Bearer dl_/);
});
```

This drives `device-score-pad.tsx` → `registry.tsx` → `PadHostV3` → `usePadPipeline` → `useFixtureStream` — the actual production chain. A test that calls `useFixtureStream` directly would pass today, against a pad that has no realtime.

- [x] **Step 3: Run it to verify it fails**

```bash
cd apps/web && rtk proxy npx playwright test e2e/device-links.spec.ts
```

Expected: FAIL — the header is `undefined`, because the pipeline resolved `SESSION_AUTH`.

Seen 2026-09-21, against a standalone prod build of this worktree with the two prop lines reverted and everything else in place: `TypeError: expect(received).toMatch(expected) … Received has value: undefined` at the `/^Bearer dl_/` assertion. The `expect.poll(() => authHeaders.length).toBeGreaterThan(0)` ahead of it PASSED — so the pad did mount and did ask the token door; it simply asked anonymously. That is the inert seam, red for the right reason rather than a pad that failed to render.

- [x] **Step 4: Thread the prop**

`pad-host.tsx`, in `PadHostV3Props` beside `onEvents`:

```ts
  /** How this pad authenticates. Load-bearing for REALTIME specifically: the
   *  transport is already built with the right auth by `registry.tsx:256`, but
   *  `useFixtureStream` mints its own realtime token and needs the mode to send
   *  `Bearer dl_`. Absent it, `use-pad-pipeline.ts:1141` falls back to
   *  SESSION_AUTH and a device-link pad silently runs on the 15s poll. */
  auth?: PadAuthMode;
```

Import `PadAuthMode` from `../transport`. Pass it through at the `usePadPipeline(...)` call (`:1530-1539`):

```ts
    auth: props.auth,
```

`registry.tsx`, at the `<PadHostV3 …/>` mount (`:289-304`):

```tsx
  auth={props.auth}
```

- [x] **Step 5: Run the e2e to verify it passes**

```bash
cd apps/web && rtk proxy npx playwright test e2e/device-links.spec.ts
```

Expected: PASS, whole file green. Run the file, never a `-g` slice.

Done 2026-09-21: whole file, no `-g`, `--project=serial --workers=1` (device-links is in `SERIAL_SPECS`, `playwright.config.ts:31`, so the default project never selects it): **7 passed, 0 failed, exit 0** — 2 auth setup + all 5 tests in the file.

- [ ] **Step 6: Confirm the fix against the reported symptom** — NOT DONE, still owed

The two-browser stopwatch was not run. What IS now pinned is the mechanism either side of it: the real pad sends `Bearer <its own dl_ secret>` to the token door (Step 2's test, through the production chain), and on a PRIVATE fixture that header — and only that header — turns a 403 into a 200 with a token (the existing test at `device-links.spec.ts:309`). What no test here observes is the last leg, the broadcast actually reaching the mounted pad, which is exactly where this plan already suspects `scoring.ts:258`'s floating `void publishFixtureUpdate(...)`. So the owner-facing "about a second, not fifteen" claim is unverified: run it at the walkthrough, and if the pad updates on a tap but never on a broadcast, that is the second defect below, not a regression of this task.

Per `seazn-local-env`, bring up a prod build with two browsers on one fixture — the organiser console and a device-link pad. Void an entry from the device-link chrome and watch the inner pad. It should update in about a second, not fifteen.

If it still takes ~15s, the token is being refused for a different reason — read the token response, do not assume. If it updates on the console but **never** on the pad until you tap, suspect the broadcast itself: `scoring.ts:258` publishes with `void publishFixtureUpdate(fixtureId, "event")`, a floating promise that a serverless handler can drop before it flushes. That would be a second, separate defect — record it, do not absorb it into this task.

- [x] **Step 7: Typecheck and commit**

`cd apps/web` is load-bearing in the command below and was a real trip hazard: the repo ROOT has no `tsconfig.json` (only `tsconfig.scripts.json`), so `tsc --noEmit` run from the worktree root prints its help text and exits 1 — a red that is not a type error. From `apps/web` it is clean: **EXIT=0**, run twice (before and after the red/restore cycle). ESLint on the three touched files: 0 errors, 1 pre-existing `react-hooks/set-state-in-effect` warning at `pad-host.tsx:1619` (the band-seeding effect, untouched here).

```bash
cd apps/web && NODE_OPTIONS=--max-old-space-size=6144 rtk proxy npx tsc --noEmit; echo "EXIT=$?"
git add apps/web/src/components/v2/scorepad/v3/pad-host.tsx \
        apps/web/src/components/v2/scorepad/registry.tsx \
        apps/web/e2e/device-links.spec.ts
git commit -m "fix(scorepad): a device-link pad authenticates its realtime token"
```

---

### Task 1: Make the rate limiter exercisable in tests

Today `rate-limit.ts:42-48` returns "allow" whenever Redis is unconfigured, so local dev and the whole e2e suite never execute a single limiter decision. That is why none of this wave's defects were caught before staging. Task 3 cannot be tested until this exists.

**Files:**
- Modify: `apps/web/src/lib/rate-limit.ts:36-54`
- Test: `apps/web/src/lib/__tests__/rate-limit.test.ts` (create)

**Interfaces:**
- Consumes: nothing.
- Produces: `__setRateLimitCounterForTests(fn: ((key: string, windowSeconds: number) => Promise<number | null>) | null): void` — test-only injection point. Task 3 uses it.

- [ ] **Step 1: Write the failing test**

```ts
// apps/web/src/lib/__tests__/rate-limit.test.ts
import { afterEach, describe, expect, it } from "vitest";
import { HttpError } from "@/lib/errors";
import { rateLimit, __setRateLimitCounterForTests } from "@/lib/rate-limit";

afterEach(() => __setRateLimitCounterForTests(null));

function countingWindow() {
  const counts = new Map<string, number>();
  return async (key: string) => {
    const next = (counts.get(key) ?? 0) + 1;
    counts.set(key, next);
    return next;
  };
}

describe("rateLimit", () => {
  it("allows up to max and throws 429 on the one past it", async () => {
    __setRateLimitCounterForTests(countingWindow());
    for (let i = 0; i < 3; i++) {
      await expect(rateLimit("t:a", { max: 3, windowSeconds: 1 })).resolves.toBeUndefined();
    }
    await expect(rateLimit("t:a", { max: 3, windowSeconds: 1 })).rejects.toMatchObject({ status: 429 });
  });

  // The positive pair for the negative above: separate keys must NOT share a
  // bucket, or "throws past max" could pass with a global counter.
  it("counts per key, not globally", async () => {
    __setRateLimitCounterForTests(countingWindow());
    for (let i = 0; i < 3; i++) await rateLimit("t:a", { max: 3, windowSeconds: 1 });
    await expect(rateLimit("t:b", { max: 3, windowSeconds: 1 })).resolves.toBeUndefined();
  });

  // Defeats the guard: with the injector absent the limiter is inert, so a
  // test that never injects proves nothing. This asserts the inert path is
  // reachable AND distinguishable, so a future change that makes the real
  // path inert cannot hide behind a green suite.
  it("is inert when no counter is configured", async () => {
    __setRateLimitCounterForTests(async () => null);
    for (let i = 0; i < 50; i++) {
      await expect(rateLimit("t:c", { max: 1, windowSeconds: 1 })).resolves.toBeUndefined();
    }
  });
});

it("HttpError from the limiter carries no explicit code, so http.ts maps 429", async () => {
  __setRateLimitCounterForTests(async () => 99);
  const err = await rateLimit("t:d", { max: 1, windowSeconds: 1 }).catch((e) => e);
  expect(err).toBeInstanceOf(HttpError);
  expect((err as HttpError).code).toBeUndefined();
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
cd apps/web && rtk proxy npx vitest run --reporter=json --outputFile=/tmp/r1.json src/lib/__tests__/rate-limit.test.ts
jq '{total:.numTotalTests,passed:.numPassedTests,failed:.numFailedTests}' /tmp/r1.json
```

Expected: FAIL — `__setRateLimitCounterForTests` is not exported.

- [ ] **Step 3: Add the injection point**

In `apps/web/src/lib/rate-limit.ts`, above `rateLimit`:

```ts
type CounterFn = (key: string, windowSeconds: number) => Promise<number | null>;

/** Test-only seam. Production always uses `incrWindow`; the suite injects a
 *  deterministic counter so limiter BEHAVIOUR is executed rather than skipped.
 *  Without this the limiter is inert wherever Redis is unconfigured, which is
 *  local dev and the entire e2e suite. */
let counterOverride: CounterFn | null = null;
export function __setRateLimitCounterForTests(fn: CounterFn | null): void {
  counterOverride = fn;
}
```

Then change the first line of `rateLimit`'s body:

```ts
  const count = counterOverride
    ? await counterOverride(`rl:${key}`, windowSeconds)
    : await incrWindow(`rl:${key}`, windowSeconds);
```

Leave every other line, including the `failClosed` branch, untouched.

- [ ] **Step 4: Run test to verify it passes**

```bash
cd apps/web && rtk proxy npx vitest run --reporter=json --outputFile=/tmp/r1.json src/lib/__tests__/rate-limit.test.ts
jq '{total:.numTotalTests,passed:.numPassedTests,failed:.numFailedTests}' /tmp/r1.json
```

Expected: `total: 4, passed: 4, failed: 0`. Confirm `.testResults[].name` resolves inside **your** worktree.

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/lib/rate-limit.ts apps/web/src/lib/__tests__/rate-limit.test.ts
git commit -m "test(rate-limit): make the limiter exercisable without Redis"
```

---

### Task 2: Give the four terminal undo refusals explicit codes

All four currently fall through `http.ts:83`'s generic status→code map and arrive as `CONFLICT`, indistinguishable from a genuine sequence conflict. `HttpError`'s third argument already overrides that map (`errors.ts:13`; precedent `LINK_EXPIRED`), so this needs no new machinery.

**Files:**
- Modify: `apps/web/src/server/usecases/scoring.ts:262-287`
- Test: `apps/web/src/server/usecases/__tests__/scoring-undo-codes.test.ts` (create)

**Interfaces:**
- Consumes: nothing.
- Produces: the wire codes `UNDO_NOOP`, `UNDO_TARGET_MISSING`, `UNDO_ALREADY_VOIDED`, `UNDO_NOT_UNDOABLE`. Task 4 classifies on exactly these four strings; Task 5 gives each one copy.

- [ ] **Step 1: Write the failing test**

```ts
// apps/web/src/server/usecases/__tests__/scoring-undo-codes.test.ts
import { describe, expect, it } from "vitest";
import { HttpError } from "@/lib/errors";
import { __assertUndoTargetForTests as assertUndoTarget } from "../scoring";

const auth = { orgId: "00000000-0000-4000-8000-000000000001", userId: "u" } as never;
const FIXTURE = "00000000-0000-4000-8000-0000000000ff";

describe("assertUndoTarget wire codes", () => {
  it("a malformed event_id is UNDO_NOOP, not a bare CONFLICT", async () => {
    const err = await assertUndoTarget(auth, FIXTURE, {
      type: "core.void", payload: { event_id: "not-a-uuid" }, expected_seq: 1,
    } as never).catch((e) => e);
    expect(err).toBeInstanceOf(HttpError);
    expect((err as HttpError).status).toBe(409);
    expect((err as HttpError).code).toBe("UNDO_NOOP");
  });

  it("a missing payload is UNDO_NOOP", async () => {
    const err = await assertUndoTarget(auth, FIXTURE, {
      type: "core.void", payload: null, expected_seq: 1,
    } as never).catch((e) => e);
    expect((err as HttpError).code).toBe("UNDO_NOOP");
  });
});
```

The three DB-backed cases (`UNDO_TARGET_MISSING`, `UNDO_ALREADY_VOIDED`, `UNDO_NOT_UNDOABLE`) need a fixture row and belong with the DB-backed suites; they are covered end-to-end by Task 9's regression test. Do not fake them with a mocked `withTenant` — a mock here would assert the mock.

- [ ] **Step 2: Run test to verify it fails**

```bash
cd apps/web && rtk proxy npx vitest run --reporter=json --outputFile=/tmp/r2.json src/server/usecases/__tests__/scoring-undo-codes.test.ts
jq '{total:.numTotalTests,passed:.numPassedTests,failed:.numFailedTests}' /tmp/r2.json
```

Expected: FAIL — `__assertUndoTargetForTests` is not exported, then once exported, FAIL on `code` being `undefined`.

- [ ] **Step 3: Add the codes and the test export**

In `apps/web/src/server/usecases/scoring.ts`, replace the four throws:

```ts
  if (typeof eventId !== "string" || !UUID_RE.test(eventId)) {
    throw new HttpError(409, "Nothing to undo", "UNDO_NOOP");
  }
```

```ts
  if (!target) {
    throw new HttpError(409, "Nothing to undo — that entry does not exist", "UNDO_TARGET_MISSING");
  }
  if (target.voided) {
    throw new HttpError(409, "Nothing to undo — that entry is already undone", "UNDO_ALREADY_VOIDED");
  }
  if (target.type === "core.void") {
    throw new HttpError(
      409,
      "An undo cannot be undone — re-record the entry instead",
      "UNDO_NOT_UNDOABLE",
    );
  }
```

Below the function, add the test seam:

```ts
/** Test-only alias. `assertUndoTarget` is module-private by intent; the wire
 *  codes it throws are a contract `transport.ts` classifies on, so they get a
 *  direct test rather than one mediated by the whole scoreEvent path. */
export const __assertUndoTargetForTests = assertUndoTarget;
```

Update the comment at `:264-266` — it currently explains the 409 choice without mentioning that the four cases are now distinguishable:

```ts
// Undo with nothing to undo is a 409, never a crash (v3/09 §2): a missing /
// unknown / already-voided target answers CONFLICT before the fold would 422,
// so a double-tapped "Undo last" degrades to a calm "already undone".
//
// Each case carries its OWN wire code (2026-09-21, W1). All four are TERMINAL:
// no expected_seq can satisfy them. `transport.ts` classifies on these codes so
// the pad stops renegotiating a refusal it can never win — which used to wedge
// the queue head permanently. A new terminal case added here MUST get a code
// and copy, or it falls back to CONFLICT and reintroduces the wedge.
```

- [ ] **Step 4: Run test to verify it passes**

```bash
cd apps/web && rtk proxy npx vitest run --reporter=json --outputFile=/tmp/r2.json src/server/usecases/__tests__/scoring-undo-codes.test.ts
jq '{total:.numTotalTests,passed:.numPassedTests,failed:.numFailedTests}' /tmp/r2.json
```

Expected: `total: 2, passed: 2, failed: 0`.

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/server/usecases/scoring.ts apps/web/src/server/usecases/__tests__/scoring-undo-codes.test.ts
git commit -m "fix(scoring): terminal undo refusals carry their own wire codes"
```

---

### Task 3: Charge the limiter only for writes that do work

`scoring.ts:92` runs the limiter before the idempotency replay check at `:94-98`, so a replay that performs no write still spends a slot against a **per-fixture 10/s** bucket shared by every device on that fixture. Retries were self-amplifying against the limit rather than free.

**Files:**
- Modify: `apps/web/src/server/usecases/scoring.ts:92-98`
- Test: `apps/web/src/server/usecases/__tests__/scoring-replay-is-free.test.ts` (create)

**Interfaces:**
- Consumes: `__setRateLimitCounterForTests` from Task 1.
- Produces: nothing downstream.

- [ ] **Step 1: Write the failing test**

```ts
// apps/web/src/server/usecases/__tests__/scoring-replay-is-free.test.ts
import { afterEach, describe, expect, it, vi } from "vitest";
import { __setRateLimitCounterForTests } from "@/lib/rate-limit";

const cacheGet = vi.hoisted(() => vi.fn());
vi.mock("@/lib/cache", async (orig) => ({ ...(await orig<object>()), cacheGet }));

afterEach(() => {
  __setRateLimitCounterForTests(null);
  cacheGet.mockReset();
});

describe("scoreEvent limiter placement", () => {
  it("a cached replay consumes no limiter slot", async () => {
    const seen: string[] = [];
    __setRateLimitCounterForTests(async (key) => {
      seen.push(key);
      return seen.length;
    });
    cacheGet.mockResolvedValue({ event: { seq: 7 }, state: {}, outcome: null, status: "in_play" });

    const { scoreEvent } = await import("../scoring");
    const auth = { orgId: "00000000-0000-4000-8000-000000000001", userId: "u" } as never;
    const out = await scoreEvent(auth, "00000000-0000-4000-8000-0000000000ff", {
      expected_seq: 6, type: "badminton.rally", payload: {}, idempotency_key: "k-1",
    } as never);

    expect(out).toMatchObject({ status: "in_play" });
    expect(seen).toEqual([]); // the replay short-circuited BEFORE the limiter
  });

  // Positive pair: without this, "consumes no slot" would also pass if the
  // limiter were removed entirely.
  it("a first-time write DOES consume a slot", async () => {
    const seen: string[] = [];
    __setRateLimitCounterForTests(async (key) => {
      seen.push(key);
      return seen.length;
    });
    cacheGet.mockResolvedValue(null);

    const { scoreEvent } = await import("../scoring");
    const auth = { orgId: "00000000-0000-4000-8000-000000000001", userId: "u" } as never;
    await scoreEvent(auth, "00000000-0000-4000-8000-0000000000ff", {
      expected_seq: 6, type: "badminton.rally", payload: {}, idempotency_key: "k-2",
    } as never).catch(() => undefined); // entitlement/DB failure past the limiter is fine here

    expect(seen).toEqual(["rl:scorev1:00000000-0000-4000-8000-0000000000ff"]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
cd apps/web && rtk proxy npx vitest run --reporter=json --outputFile=/tmp/r3.json src/server/usecases/__tests__/scoring-replay-is-free.test.ts
jq '{total:.numTotalTests,passed:.numPassedTests,failed:.numFailedTests}' /tmp/r3.json
```

Expected: FAIL on the first test — `seen` is `["rl:scorev1:…"]` because the limiter runs first.

- [ ] **Step 3: Move the limiter below the replay check**

In `apps/web/src/server/usecases/scoring.ts`, replace lines 92-98 with:

```ts
  // The replay check runs FIRST (2026-09-21, W1). A retry carrying a key we
  // have already answered performs no write, so charging it a limiter slot made
  // retries self-amplifying against a bucket that is PER FIXTURE — every device
  // scoring the same match shares it. Not a new DoS surface: the check is one
  // Redis GET, the same cost class as the limiter's own INCR.
  const cacheKey = input.idempotency_key ? idemKey(fixtureId, input.idempotency_key) : null;
  if (cacheKey) {
    const replay = await cacheGet<ScoreOutcome>(cacheKey);
    if (replay) return replay; // retried request: same answer, no double write
  }

  await rateLimit(`scorev1:${fixtureId}`, SCORING_LIMIT);
```

- [ ] **Step 4: Run test to verify it passes**

```bash
cd apps/web && rtk proxy npx vitest run --reporter=json --outputFile=/tmp/r3.json src/server/usecases/__tests__/scoring-replay-is-free.test.ts
jq '{total:.numTotalTests,passed:.numPassedTests,failed:.numFailedTests}' /tmp/r3.json
```

Expected: `total: 2, passed: 2, failed: 0`.

- [ ] **Step 5: Verify no neighbouring suite regressed**

```bash
cd apps/web && rtk proxy npx vitest run --reporter=json --outputFile=/tmp/r3b.json src/server/usecases/__tests__/
jq '{total:.numTotalTests,passed:.numPassedTests,failed:.numFailedTests}' /tmp/r3b.json
```

Expected: `failed: 0`. If a suite fails to collect, `total` drops — compare against the count from before your change, do not trust `failed: 0` alone.

- [ ] **Step 6: Commit**

```bash
git add apps/web/src/server/usecases/scoring.ts apps/web/src/server/usecases/__tests__/scoring-replay-is-free.test.ts
git commit -m "fix(scoring): an idempotent replay no longer spends a rate-limit slot"
```

---

### Task 4: Classify a 409 by its code, and give each refusal words

This is the wave's load-bearing change. `transport.ts:210` returns `false` for every 409, so all four terminal refusals take the renegotiation path, fail identically on the resend, and land `stayed-queued`/`conflict-again` — which `drainQueue:363-365` answers by leaving the event at the head forever.

Copy is in the same task, not a later one: `refusal-copy.test.ts` pins `REFUSAL_KEY` against the server's code list, so the moment these codes can reach the resolver, that suite goes red without copy. They ship together or the task is not green.

**Files:**
- Modify: `apps/web/src/components/v2/scorepad/transport.ts:146-213, 236-241`
- Modify: `apps/web/src/components/v2/scorepad/refusal-copy.ts:39-56`
- Modify: `apps/web/src/dictionaries/{en,es,fr,nl}/ui.json`
- Test: `apps/web/src/components/v2/scorepad/__tests__/transport.test.ts` (extend)

**Interfaces:**
- Consumes: the four wire codes from Task 2.
- Produces: `TERMINAL_CONFLICT_CODES: ReadonlySet<string>` exported from `transport.ts`. No later task imports it — it is exported so its paired test can pin it against the server's list. Task 5's ceiling deliberately does **not** consult it: a terminal code already returns `rejected` here and never reaches the conflict path, so a ceiling check against it would be unreachable code.

- [ ] **Step 1: Write the failing test**

Append to `apps/web/src/components/v2/scorepad/__tests__/transport.test.ts`:

```ts
describe("409 classification", () => {
  function res(status: number, body: unknown) {
    return new Response(JSON.stringify(body), {
      status, headers: { "Content-Type": "application/json" },
    });
  }
  const body = (code: string) => ({ ok: false, error: { code, message: "nope" } });

  it.each([
    "UNDO_NOOP",
    "UNDO_TARGET_MISSING",
    "UNDO_ALREADY_VOIDED",
    "UNDO_NOT_UNDOABLE",
  ])("%s is terminal, not renegotiable", async (code) => {
    const t = sessionTransport({ fetchFn: async () => res(409, body(code)) });
    const out = await t.appendEvent("f1", {
      expected_seq: 1, type: "core.void", payload: {}, idempotency_key: "k",
    });
    expect(out.kind).toBe("rejected");
    expect(out).toMatchObject({ code });
  });

  // The positive pair. Without it, "terminal" would also pass if EVERY 409
  // became terminal — which would silently break the replay ruling and drop
  // real writes.
  it("SEQ_CONFLICT stays renegotiable", async () => {
    const t = sessionTransport({
      fetchFn: async () => res(409, { ok: false, error: { code: "SEQ_CONFLICT", message: "stale", current_seq: 9 } }),
    });
    const out = await t.appendEvent("f1", {
      expected_seq: 1, type: "badminton.rally", payload: {}, idempotency_key: "k",
    });
    expect(out).toMatchObject({ kind: "conflict", currentSeq: 9 });
  });

  // An un-migrated server sends 409 with no explicit code. It must keep
  // today's behaviour, or a new client would wedge against an old server.
  it("a 409 with no recognised code stays renegotiable", async () => {
    const t = sessionTransport({
      fetchFn: async () => res(409, { ok: false, error: { code: "CONFLICT", message: "stale" } }),
    });
    const out = await t.appendEvent("f1", {
      expected_seq: 1, type: "badminton.rally", payload: {}, idempotency_key: "k",
    });
    expect(out.kind).toBe("conflict");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
cd apps/web && rtk proxy npx vitest run --reporter=json --outputFile=/tmp/r4.json src/components/v2/scorepad/__tests__/transport.test.ts
jq '{total:.numTotalTests,passed:.numPassedTests,failed:.numFailedTests}' /tmp/r4.json
```

Expected: the four `it.each` cases FAIL with `kind` `"conflict"`; both positive-pair cases already pass.

- [ ] **Step 3: Split the 409 on its code**

In `apps/web/src/components/v2/scorepad/transport.ts`, above `isPermanentRefusal`:

```ts
/**
 * The 409s no `expected_seq` can ever satisfy.
 *
 * A 409 normally means "your write is fine, its expected_seq is stale" and the
 * pipeline's replay protocol renegotiates it. These four do not mean that. The
 * server is refusing the UNDO ITSELF — the target is missing, already struck,
 * or is a void that cannot be voided (`scoring.ts:262-287`).
 *
 * Renegotiating them resends a request that fails identically, which
 * `pipeline.ts:329-333` answers with `stayed-queued`/`conflict-again`, which
 * `drainQueue` answers by leaving the event at the HEAD — blocking every write
 * behind it, permanently and silently (`use-pad-pipeline.ts:1402` only raises
 * the offline chip for `network`). Measured on staging 2026-09-21: 10 queued
 * actions behind one already-undone void, while the pad went on showing a
 * score that had stopped being true.
 *
 * An UNRECOGNISED code stays renegotiable on purpose: an un-migrated server
 * sends a bare `CONFLICT`, and a new client must not wedge against it.
 */
export const TERMINAL_CONFLICT_CODES: ReadonlySet<string> = new Set([
  "UNDO_NOOP",
  "UNDO_TARGET_MISSING",
  "UNDO_ALREADY_VOIDED",
  "UNDO_NOT_UNDOABLE",
]);
```

Then replace the 409 branch at `:236-241`:

```ts
      // 409 splits two ways. A stale expected_seq is RENEGOTIABLE and belongs
      // to the pipeline's replay ruling. A terminal undo refusal is not — see
      // TERMINAL_CONFLICT_CODES.
      if (res.status === 409) {
        const code = envelope.error?.code;
        if (code !== undefined && TERMINAL_CONFLICT_CODES.has(code)) {
          return { kind: "rejected", code, message };
        }
        const currentSeq = typeof envelope.error?.current_seq === "number" ? envelope.error.current_seq : null;
        return { kind: "conflict", currentSeq, message };
      }
```

Leave `isPermanentRefusal` unchanged — it is reached only for non-409 statuses, and its `409 → false` line stays correct for the renegotiable case.

- [ ] **Step 4: Give each refusal words**

In `apps/web/src/components/v2/scorepad/refusal-copy.ts`, extend the map:

```ts
export const REFUSAL_KEY: Readonly<Record<string, MessageKey>> = {
  VALIDATION: "scorepad.refusal.invalid",
  UNAUTHENTICATED: "scorepad.refusal.signedOut",
  PAYMENT_REQUIRED: "scorepad.refusal.planLocked",
  FORBIDDEN: "scorepad.refusal.notAllowed",
  NOT_FOUND: "scorepad.refusal.missing",
  UNDO_NOOP: "scorepad.refusal.undoNothing",
  UNDO_TARGET_MISSING: "scorepad.refusal.undoMissing",
  UNDO_ALREADY_VOIDED: "scorepad.refusal.undoAlready",
  UNDO_NOT_UNDOABLE: "scorepad.refusal.undoNotUndoable",
};
```

Correct the doc comment at `:45-48`, which now states something false:

```ts
 * A bare `CONFLICT` is still deliberately ABSENT: a renegotiable 409 goes to
 * the append/replay protocol and never reaches this resolver. The four
 * `UNDO_*` codes DO reach it (W1, 2026-09-21) — they are 409s the server will
 * refuse no matter what seq we send, so they are surfaced rather than retried.
```

Add to `apps/web/src/dictionaries/en/ui.json` — every string leads with what did NOT happen, then what to do, per this file's own standing rule:

```json
"scorepad.refusal.undoNothing": "Not recorded — there was nothing to take back.",
"scorepad.refusal.undoMissing": "Not recorded — that entry is no longer on the sheet. Refresh and check the ledger.",
"scorepad.refusal.undoAlready": "Not recorded — that entry was already taken back.",
"scorepad.refusal.undoNotUndoable": "Not recorded — an undo cannot be undone. Re-record the entry instead.",
```

Translate the same four keys into `es`, `fr` and `nl` `ui.json`. Then:

```bash
cd apps/web && npm run i18n:gen-keys && npm run i18n:check
```

- [ ] **Step 5: Run tests to verify they pass**

```bash
cd apps/web && rtk proxy npx vitest run --reporter=json --outputFile=/tmp/r4.json \
  src/components/v2/scorepad/__tests__/transport.test.ts \
  src/components/v2/scorepad/__tests__/refusal-copy.test.ts
jq '{total:.numTotalTests,passed:.numPassedTests,failed:.numFailedTests}' /tmp/r4.json
```

Expected: `failed: 0`, and `total` has risen by exactly 6.

- [ ] **Step 6: Mutation-check the branch you just added**

Back up the file with `cp` — never `git checkout`, which would revert your own work:

```bash
cd apps/web && cp src/components/v2/scorepad/transport.ts /tmp/transport.bak
```

Delete the `TERMINAL_CONFLICT_CODES.has(code)` branch so every 409 renegotiates again, re-run the transport suite, and confirm it goes **red**. Then:

```bash
cd apps/web && cp /tmp/transport.bak src/components/v2/scorepad/transport.ts
```

Record which tests died. A test that dies under every mutant is not evidence; you want the four `it.each` cases dead and the two positive-pair cases alive.

- [ ] **Step 7: Commit**

```bash
git add apps/web/src/components/v2/scorepad/transport.ts \
        apps/web/src/components/v2/scorepad/refusal-copy.ts \
        apps/web/src/components/v2/scorepad/__tests__/transport.test.ts \
        apps/web/src/dictionaries/en/ui.json apps/web/src/dictionaries/es/ui.json \
        apps/web/src/dictionaries/fr/ui.json apps/web/src/dictionaries/nl/ui.json \
        apps/web/src/lib/i18n-keys.ts
git commit -m "fix(scorepad): a terminal undo refusal no longer wedges the queue head"
```

---

### Task 5: Guarantee the queue always makes progress

Task 4 fixes the four refusals we know about. This is the backstop for the ones we do not: any event that conflicts again after renegotiation, beyond a bounded number of drain passes, is surfaced instead of left at the head.

**Ceiling derivation — not a magic number.** `sendOne` permits exactly one renegotiation per call (`pipeline.ts:311-333`), and a renegotiation is warranted only when the ledger slot is FOREIGN — another device won the seq. A second pass covers a second foreign writer racing the same slot. Beyond two, the event is not losing a race; it is being refused for a reason renegotiation cannot address. `CONFLICT_PASS_CEILING = 2`.

**Files:**
- Modify: `apps/web/src/components/v2/scorepad/pipeline.ts:325-333`
- Modify: `apps/web/src/components/v2/scorepad/refusal-copy.ts`
- Modify: `apps/web/src/dictionaries/{en,es,fr,nl}/ui.json`
- Test: `apps/web/src/components/v2/scorepad/__tests__/pipeline.test.ts` (extend)

**Interfaces:**
- Consumes: `attempts` on `PendingEvent` (already persisted, `pipeline.ts:258`).
- Produces: wire code `QUEUE_STALLED` on a `{kind:"rejected"}` outcome. No new `SendOutcome` kind — this deliberately reuses the proven drop-and-surface path (`pipeline.ts:280-283`, `use-pad-pipeline.ts:1393-1398`).

- [ ] **Step 1: Write the failing test**

Append to `apps/web/src/components/v2/scorepad/__tests__/pipeline.test.ts`:

```ts
describe("conflict ceiling", () => {
  it("dead-letters an event that keeps conflicting after the ceiling", async () => {
    const transport = {
      appendEvent: async () => ({ kind: "conflict", currentSeq: 99, message: "stale" }),
      listEventsSince: async () => [{ seq: 6, id: "foreign", type: "x", payload: {}, voids: null }],
      getLastSeq: async () => 99,
    } as never;
    const store = makeMemoryStore();
    await store.put({
      localId: "l1", idempotencyKey: "k1", type: "badminton.rally", payload: {},
      expectedSeq: 5, attempts: 2, heldUntil: null,
    } as never);

    const out = await sendOne(transport, store, "f1", (await store.peekInOrder())[0], identity);

    expect(out).toMatchObject({ kind: "rejected", code: "QUEUE_STALLED" });
    expect(await store.peekInOrder()).toHaveLength(0); // head cleared
  });

  it("below the ceiling it still renegotiates rather than giving up", async () => {
    const transport = {
      appendEvent: async () => ({ kind: "conflict", currentSeq: 99, message: "stale" }),
      listEventsSince: async () => [{ seq: 6, id: "foreign", type: "x", payload: {}, voids: null }],
      getLastSeq: async () => 99,
    } as never;
    const store = makeMemoryStore();
    await store.put({
      localId: "l2", idempotencyKey: "k2", type: "badminton.rally", payload: {},
      expectedSeq: 5, attempts: 0, heldUntil: null,
    } as never);

    const out = await sendOne(transport, store, "f1", (await store.peekInOrder())[0], identity);

    expect(out).toMatchObject({ kind: "stayed-queued", reason: "conflict-again" });
    expect(await store.peekInOrder()).toHaveLength(1); // still queued, by design
  });

  // THE load-bearing negative. An offline venue must queue forever; a ceiling
  // that catches network failures turns a wifi blip into lost rallies, which is
  // a worse defect than the wedge this whole wave exists to fix.
  it("NEVER dead-letters a network failure, however many attempts", async () => {
    const transport = {
      appendEvent: async () => ({ kind: "network-error", message: "offline" }),
      listEventsSince: async () => [],
      getLastSeq: async () => 0,
    } as never;
    const store = makeMemoryStore();
    await store.put({
      localId: "l3", idempotencyKey: "k3", type: "badminton.rally", payload: {},
      expectedSeq: 5, attempts: 500, heldUntil: null,
    } as never);

    const out = await sendOne(transport, store, "f1", (await store.peekInOrder())[0], identity);

    expect(out).toMatchObject({ kind: "stayed-queued", reason: "network" });
    expect(await store.peekInOrder()).toHaveLength(1);
  });
});
```

If `makeMemoryStore` / `identity` helpers are not already present in this suite, reuse the ones the existing tests in this file build — do not introduce a second store fake.

- [ ] **Step 2: Run test to verify it fails**

```bash
cd apps/web && rtk proxy npx vitest run --reporter=json --outputFile=/tmp/r5.json src/components/v2/scorepad/__tests__/pipeline.test.ts
jq '{total:.numTotalTests,passed:.numPassedTests,failed:.numFailedTests}' /tmp/r5.json
```

Expected: the first case FAILS (`stayed-queued`, head still queued). Cases 2 and 3 already pass — they pin today's correct behaviour, which must survive.

- [ ] **Step 3: Add the ceiling**

In `apps/web/src/components/v2/scorepad/pipeline.ts`, above `sendOne`:

```ts
/**
 * How many drain passes an event may spend losing a seq race before the pad
 * stops treating it as a race at all.
 *
 * Derived, not chosen: `sendOne` permits exactly ONE renegotiation per call,
 * and renegotiation is warranted only when the ledger slot is FOREIGN —
 * another device won the seq. A second pass covers a second foreign writer
 * racing the same slot. Past that, the event is not losing a race; it is being
 * refused for a reason no expected_seq can address, and leaving it at the head
 * blocks every write behind it.
 *
 * Applies to `conflict-again` ONLY. A network failure is never dead-lettered
 * at any attempt count: an offline venue must queue indefinitely, which is the
 * entire purpose of the durable queue.
 */
const CONFLICT_PASS_CEILING = 2;
```

Replace the tail of `sendOne` (`:325-333`):

```ts
  // Another conflict, or a network error, on the resend: "resent exactly once".
  // The renegotiated expectedSeq is durably persisted, so the NEXT drain pass
  // retries from there, never from the stale original.
  if (second.kind === "conflict" && attemptsAsLoaded >= CONFLICT_PASS_CEILING) {
    await markDropped(store, event.idempotencyKey);
    return {
      kind: "rejected",
      ...base,
      code: "QUEUE_STALLED",
      message: "conflict again after renegotiation, past the pass ceiling",
    };
  }
  await recordAttempt(store, event.idempotencyKey, {
    attempts: attemptsAsLoaded + 1,
    lastError: second.kind === "conflict" ? "conflict again after renegotiation" : second.message,
  });
  return { kind: "stayed-queued", ...base, reason: second.kind === "conflict" ? "conflict-again" : "network" };
```

- [ ] **Step 4: Give it words**

`refusal-copy.ts`, add to `REFUSAL_KEY`:

```ts
  QUEUE_STALLED: "scorepad.refusal.queueStalled",
```

`apps/web/src/dictionaries/en/ui.json`:

```json
"scorepad.refusal.queueStalled": "Not recorded — this entry could not be saved after several tries. Check the ledger, then retake it.",
```

Translate into `es`, `fr`, `nl`. Then `npm run i18n:gen-keys && npm run i18n:check`.

- [ ] **Step 5: Run tests to verify they pass**

```bash
cd apps/web && rtk proxy npx vitest run --reporter=json --outputFile=/tmp/r5.json \
  src/components/v2/scorepad/__tests__/pipeline.test.ts \
  src/components/v2/scorepad/__tests__/refusal-copy.test.ts
jq '{total:.numTotalTests,passed:.numPassedTests,failed:.numFailedTests}' /tmp/r5.json
```

Expected: `failed: 0`, `total` up by exactly 3.

- [ ] **Step 6: Mutation-check the network exemption**

`cp` the file aside, then change the ceiling condition from `second.kind === "conflict" && …` to `…` alone, so network failures are dead-lettered too. Re-run. The third test MUST go red. Restore from the `cp` backup. This is the mutant that matters: it is the one whose survival would mean lost rallies.

- [ ] **Step 7: Commit**

```bash
git add apps/web/src/components/v2/scorepad/pipeline.ts \
        apps/web/src/components/v2/scorepad/refusal-copy.ts \
        apps/web/src/components/v2/scorepad/__tests__/pipeline.test.ts \
        apps/web/src/dictionaries/en/ui.json apps/web/src/dictionaries/es/ui.json \
        apps/web/src/dictionaries/fr/ui.json apps/web/src/dictionaries/nl/ui.json \
        apps/web/src/lib/i18n-keys.ts
git commit -m "fix(scorepad): bound the conflict retry so the queue always progresses"
```

---

### Task 6: Stop calling a throttled pad "offline"

`transport.ts:152` lists 429 in `RETRYABLE_CLIENT_STATUS`; `:211` returns `false`; the call falls to `{kind:"network-error"}` at `:245`; `use-pad-pipeline.ts:1402` raises the offline chip. The scorer is told they have no connection when the truth is that they are being rate-limited — and the bucket is per fixture, so a second device on the same match can cause it.

**Files:**
- Modify: `apps/web/src/components/v2/scorepad/pipeline.ts:157-172` (add the kind), `:284-287` (map it)
- Modify: `apps/web/src/components/v2/scorepad/transport.ts:242-245`
- Modify: `apps/web/src/components/v2/scorepad/use-pad-pipeline.ts:1399-1404`
- Modify: `apps/web/src/components/v2/scorepad/v3/pad-host.tsx:546-553` (chip label)
- Modify: `apps/web/src/dictionaries/{en,es,fr,nl}/ui.json`
- Test: `apps/web/src/components/v2/scorepad/__tests__/transport.test.ts`, `.../pipeline.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `AppendCallResult` gains `{ kind: "throttled"; message: string }`; `SendOutcome`'s `stayed-queued` gains `reason: "throttled"`.

- [ ] **Step 1: Write the failing test**

Append to `transport.test.ts`:

```ts
it("429 is throttled, not a network error", async () => {
  const t = sessionTransport({
    fetchFn: async () => new Response(
      JSON.stringify({ ok: false, error: { code: "RATE_LIMITED", message: "Too many requests" } }),
      { status: 429, headers: { "Content-Type": "application/json" } },
    ),
  });
  const out = await t.appendEvent("f1", {
    expected_seq: 1, type: "badminton.rally", payload: {}, idempotency_key: "k",
  });
  expect(out.kind).toBe("throttled");
});

// Positive pair: a real transport failure must STILL be a network error, or
// "throttled" could pass by swallowing everything.
it("a thrown fetch is still a network error", async () => {
  const t = sessionTransport({ fetchFn: async () => { throw new Error("dns"); } });
  const out = await t.appendEvent("f1", {
    expected_seq: 1, type: "badminton.rally", payload: {}, idempotency_key: "k",
  });
  expect(out.kind).toBe("network-error");
});
```

Append to `pipeline.test.ts`:

```ts
it("a throttled send stays queued WITHOUT claiming the pad is offline", async () => {
  const transport = {
    appendEvent: async () => ({ kind: "throttled", message: "Too many requests" }),
    listEventsSince: async () => [],
    getLastSeq: async () => 0,
  } as never;
  const store = makeMemoryStore();
  await store.put({
    localId: "l9", idempotencyKey: "k9", type: "badminton.rally", payload: {},
    expectedSeq: 1, attempts: 0, heldUntil: null,
  } as never);

  const out = await sendOne(transport, store, "f1", (await store.peekInOrder())[0], identity);

  expect(out).toMatchObject({ kind: "stayed-queued", reason: "throttled" });
  expect(await store.peekInOrder()).toHaveLength(1); // the tap is NOT lost
});
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
cd apps/web && rtk proxy npx vitest run --reporter=json --outputFile=/tmp/r6.json \
  src/components/v2/scorepad/__tests__/transport.test.ts \
  src/components/v2/scorepad/__tests__/pipeline.test.ts
jq '{total:.numTotalTests,passed:.numPassedTests,failed:.numFailedTests}' /tmp/r6.json
```

Expected: the two new cases FAIL; the positive pair passes already.

- [ ] **Step 3: Add the kind**

`pipeline.ts`, in the `AppendCallResult` union:

```ts
  /** 429. Transient by the server's own definition, so the tap is KEPT — but
   *  it is not a connectivity failure, and telling the scorer they are offline
   *  when the venue wifi is fine sends them to fix the wrong thing. The bucket
   *  is per FIXTURE (`scoring.ts:48`), so a second device on the same match can
   *  cause this without the scorer doing anything at all. */
  | { kind: "throttled"; message: string }
```

Widen `stayed-queued`'s reason union in the same file to include `"throttled"`.

Add the mapping in `sendOne`, beside the `network-error` branch at `:284-287`:

```ts
  if (first.kind === "throttled") {
    await recordAttempt(store, event.idempotencyKey, { attempts: attemptsAsLoaded + 1, lastError: first.message });
    return { kind: "stayed-queued", ...base, reason: "throttled" };
  }
```

TypeScript's exhaustiveness check will now point at every other consumer that must handle the new kind. Handle each one rather than widening a default branch.

- [ ] **Step 4: Return it from the transport**

`transport.ts`, before the `isPermanentRefusal` call at `:242`:

```ts
      if (res.status === 429) {
        return { kind: "throttled", message };
      }
```

- [ ] **Step 5: Stop the chip lying**

`use-pad-pipeline.ts:1402` currently reads `setOffline(outcome.reason === "network")`, which is already correct for the new reason — it will not raise the offline chip. Add the throttled state beside it so the chip can say something true:

```ts
        } else {
          // stayed-queued: network failure, throttling, or an indeterminate
          // 409 — stop here, in order, exactly like pipeline.ts's drainQueue.
          setOffline(outcome.reason === "network");
          setThrottled(outcome.reason === "throttled");
          break;
        }
```

Declare `throttled` alongside the existing `offline` state and return it from the hook. In `pad-host.tsx:546-553`, insert it into the label ladder ahead of the queued-count branch, so a throttled pad reads as throttled rather than as a bare backlog:

```json
"pad.queue.throttled": "Catching up — too many taps at once"
```

Add that key to all four dictionaries, then `npm run i18n:gen-keys && npm run i18n:check`.

- [ ] **Step 6: Run tests to verify they pass**

```bash
cd apps/web && rtk proxy npx vitest run --reporter=json --outputFile=/tmp/r6.json src/components/v2/scorepad/__tests__/
jq '{total:.numTotalTests,passed:.numPassedTests,failed:.numFailedTests}' /tmp/r6.json
```

Expected: `failed: 0`. Compare `total` against the pre-change count — a suite that fails to COLLECT reports zero failures.

- [ ] **Step 7: Typecheck, because this widened a union**

```bash
cd apps/web && NODE_OPTIONS=--max-old-space-size=6144 rtk proxy npx tsc --noEmit; echo "EXIT=$?"
```

Expected: `EXIT=0`.

- [ ] **Step 8: Commit**

```bash
git add apps/web/src/components/v2/scorepad/ apps/web/src/dictionaries/ apps/web/src/lib/i18n-keys.ts
git commit -m "fix(scorepad): a throttled write reads as throttled, not offline"
```

---

### Task 7: Hide "Void my last entry" while an entry is held

During the `HOLD_MS` window both undo controls are live and they target different events: the inner ribbon's "Take back" drops the *held* tap, while the outer chrome's "Void my last entry" strikes the last *committed* one. That is what produces a terminal undo refusal in the first place — the trigger for this whole wave. Owner ruling 2026-09-21: hide the outer control while an entry is held.

Three facts from the seam map that constrain the design:

- `held` is `useState<HeldTap | null>` at `pad-host.tsx:1622`, **local to `PadHostV3` and never lifted**. `UsePadPipelineResult` (`use-pad-pipeline.ts:405-511`) has no held field — the hold itself lives in the IndexedDB queue, not in React state.
- **Take-back visibility is NOT a proxy for held.** `ribbonUndoTarget` (`pad-host.tsx:616-634`, called at `:2178`) returns the held id *or* the latest voidable ledger row, so the ribbon shows for a sent row too. Gating on it would hide the outer button at the wrong times.
- `onEvents` already fires at hold time (`pad-host.tsx:1545-1548`; `submitHeld` commits its optimistic envelope at `use-pad-pipeline.ts:1651-1653` before enqueueing) but carries **no hold marker**, and nothing fires when the hold *ends*. So it cannot be reused. `device-score-pad.tsx:135-140` ignores its argument anyway and only calls `resync()`, which sets `padSyncing` — and `padSyncing` *disables* the button (`:315`), never hides it.

Note in passing: `PadHostV3Props` already declares an `onStateChange` callback (`pad-host.tsx:1498`) that `registry.tsx` never forwards — a third inert seam in this file. Do not build on it; add the new callback explicitly and leave that one alone (removing it is out of this task's blast radius).

**Files:**
- Modify: `apps/web/src/components/v2/scorepad/v3/pad-host.tsx:1437-1500` (prop), `:1622` (effect)
- Modify: `apps/web/src/components/v2/scorepad/registry.tsx:193-221` (prop), `:289-304` (forward)
- Modify: `apps/web/src/components/v2/device-score-pad.tsx:312-323`
- Test: `apps/web/e2e/device-links.spec.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `onHeldChange?: (isHeld: boolean) => void` on both `PadHostV3Props` and `ScorePadProps`.

- [ ] **Step 1: Add the callback to the inner pad**

`pad-host.tsx`, in `PadHostV3Props` beside `onEvents` (`:1499`):

```ts
  /** Fires true when a tap enters its soft-commit hold window and false when
   *  it leaves, by any route — due, taken back, or flushed by a newer tap.
   *  The outer device-link chrome uses this to withdraw its own "Void my last
   *  entry" while the inner pad holds something, because during that window
   *  the two controls target DIFFERENT events and tapping the outer one
   *  produces a terminal undo refusal. Deliberately not derived from
   *  `ribbonUndoTarget`: that is also non-null for a sent, voidable row. */
  onHeldChange?: (isHeld: boolean) => void;
```

Below the `held` declaration at `:1622`:

```ts
  useEffect(() => {
    props.onHeldChange?.(held !== null);
  }, [held, props.onHeldChange]);
```

The caller must pass a stable reference (`useCallback`) or this re-fires every render — Step 3 does.

- [ ] **Step 2: Forward it**

`registry.tsx`, add to `ScorePadProps` (`:193-221`):

```ts
  onHeldChange?: (isHeld: boolean) => void;
```

and to the `<PadHostV3 …/>` mount (`:289-304`):

```tsx
  onHeldChange={props.onHeldChange}
```

- [ ] **Step 3: Withdraw the outer control while held**

`device-score-pad.tsx` — add the state and a stable handler beside `padSyncing` (`:108`):

```tsx
  const [padHolding, setPadHolding] = useState(false);
  const handleHeldChange = useCallback((isHeld: boolean) => setPadHolding(isHeld), []);
```

Gate the button at `:312` and give it the testid it has always lacked:

```tsx
  {lastOwnVoidable && !padHolding && (
    <button
      type="button"
      data-testid="device-void-mine"
      disabled={busy || padSyncing}
```

Pass the handler on the `<ScorePad>` mount (`:339-351`):

```tsx
  onHeldChange={handleHeldChange}
```

- [ ] **Step 4: Prove it by driving it, not by mounting a fixture**

`apps/web` vitest is `environment: "node"` — it has no DOM, so it cannot see this at all, and the seam map confirms **no existing test anywhere** asserts the outer button against a held inner entry. A unit test with a fake on both ends would prove the fake.

Append to `apps/web/e2e/device-links.spec.ts`:

```ts
test("the outer void withdraws while the inner pad holds a tap", async ({ page }) => {
  // … open a device-link pad on a fixture with at least one recorded event …
  await expect(page.getByTestId("device-void-mine")).toBeVisible();

  await page.getByTestId(/* a scoring tile */).click();          // starts the hold
  await expect(page.getByTestId("device-void-mine")).toHaveCount(0);

  await expect(page.getByTestId("device-void-mine")).toBeVisible({
    timeout: HOLD_MS + 5_000,                                     // derived, not a literal
  });
});
```

Derive the wait from the same constant the pad uses (`NEXT_PUBLIC_SCOREPAD_HOLD_MS`, default `10_000` at `queue.ts:190`) rather than typing a number — a flat timeout beside a derived cost is a latent red, and this suite can run with a shortened hold.

Assert `toHaveCount(0)`, not `not.toBeVisible()`: the ruling is that the control is *withdrawn*, and a count assertion cannot pass against a merely-transparent button.

- [ ] **Step 5: Run the whole spec file**

```bash
cd apps/web && rtk proxy npx playwright test e2e/device-links.spec.ts
```

The whole file, never a `-g` slice — a filter selects the tests you thought of, not the ones you broke.

- [ ] **Step 6: Mutation-check the gate**

`cp` the file aside, delete `&& !padHolding`, re-run. The new test MUST go red. Restore from the backup, never with `git checkout`.

- [ ] **Step 7: Commit**

```bash
git add apps/web/src/components/v2/scorepad/v3/pad-host.tsx \
        apps/web/src/components/v2/scorepad/registry.tsx \
        apps/web/src/components/v2/device-score-pad.tsx \
        apps/web/e2e/device-links.spec.ts
git commit -m "fix(device-pad): only one undo is offered at a time"
```

---

### Task 8: Let the score line break instead of clipping

At 360px the device-link header clips mid-string: `21-14, 20-22 (10-1`. `kernel.ts:2400` joins the closed sets with `", "` and appends the in-progress set with no separator at all, so `device-score-pad.tsx:280`'s `split(" · ")` yields two groups and the second is the whole `"21–14, 20–22 (10–14)"` string in one `whitespace-nowrap` span. `<header>` (`:239`) is `overflow-hidden`, so it clips rather than wraps or scrolls, and the string only widens as sets accumulate.

The engine string is **not** changed: `headline` is consumed by the overlay and spectator surfaces, and altering it would change broadcast copy that cannot be hotfixed mid-match. The pad gains break points instead (spec §4.8).

**Files:**
- Modify: `apps/web/src/components/v2/device-score-pad.tsx:279-286`
- Test: `apps/web/e2e/device-links.spec.ts` (Task 9 covers it at width)

**Interfaces:**
- Consumes: nothing.
- Produces: nothing.

- [ ] **Step 1: Split the sets group, keeping each unit unbreakable**

Replace the score line's group construction at `:279-286`:

```tsx
<p className="font-mono text-[clamp(1.5rem,8.5vw,3rem)] tabular-nums leading-tight flex flex-wrap items-baseline justify-center gap-x-2">
  {(summary?.headline ?? "0 — 0")
    .split(" · ")
    // The engine appends the in-progress set to the closed-set list with no
    // " · " (kernel.ts:2400), so splitting on the separator alone leaves
    // "21–14, 20–22 (10–14)" as ONE unbreakable unit that overflow-hidden then
    // clips. Splitting the group on ", " as well gives the line somewhere to
    // wrap. The engine's string is deliberately untouched — overlay and
    // spectator render it too.
    .flatMap((group) => group.split(", "))
    .map((unit, i) => (
      <span key={i} className="inline-block whitespace-nowrap">
        {unit}
      </span>
    ))}
</p>
```

- [ ] **Step 2: Verify in a browser at 320 and 360**

Follow the `seazn-local-env` skill to bring up a prod build, open a device-link pad on a fixture with at least two completed sets, and screenshot at 320, 360, 768 and 1280.

Expected: the full string is readable at every width, wrapping between set scores; no horizontal page scroll anywhere. A unit test cannot see this — `apps/web` vitest is `environment: "node"`, so a class scan passes in both the clipped and the fixed state.

- [ ] **Step 3: Commit**

```bash
git add apps/web/src/components/v2/device-score-pad.tsx
git commit -m "fix(device-pad): the score line wraps between sets instead of clipping"
```

---

### Task 9: Prove the whole chain end to end

Every prior task proved one unit. This proves the defect the owner actually saw: a terminal undo refusal must not wedge the queue, and the pad must say something true when one happens.

**Files:**
- Test: `apps/web/e2e/device-links.spec.ts` (extend)
- Test: `apps/web/src/components/v2/scorepad/__tests__/use-pad-pipeline.test.tsx` (extend)

**Interfaces:**
- Consumes: everything above.
- Produces: nothing.

- [ ] **Step 1: Write the regression test at the hook level**

Append to `use-pad-pipeline.test.tsx` — the observed staging scenario, which must fail without Tasks 4 and 5:

```tsx
it("an already-undone void clears the head instead of blocking the queue", async () => {
  // Reproduces stg 2026-09-21: a void of an already-voided entry answered
  // 409 UNDO_ALREADY_VOIDED, renegotiated 64 -> 67, failed again, and left 10
  // actions stranded behind it with no offline chip and no error.
  const calls: number[] = [];
  const transport = {
    appendEvent: async (_f: string, body: { expected_seq: number; type: string }) => {
      calls.push(body.expected_seq);
      if (body.type === "core.void") {
        return { kind: "rejected", code: "UNDO_ALREADY_VOIDED", message: "already undone" };
      }
      return { kind: "ok", data: { event: { seq: body.expected_seq + 1 }, state: {}, status: "in_play" } };
    },
    listEventsSince: async () => [],
    getLastSeq: async () => 64,
  } as never;

  const { result } = renderPipeline({ transport });

  await act(async () => { await result.current.submit("core.void", { event_id: "e1" }); });
  await act(async () => { await result.current.submit("badminton.rally", { to: "home" }); });
  await act(async () => { await result.current.drain(); });

  expect(result.current.queueDepth).toBe(0);            // head cleared
  expect(result.current.lastRejection?.code).toBe("UNDO_ALREADY_VOIDED"); // and SAID so
  expect(result.current.offline).toBe(false);           // never claimed offline
});
```

Reuse whatever mount helper the existing tests in this file use; do not add a second one.

- [ ] **Step 2: Run it against the pre-fix code to confirm it fails**

```bash
cd apps/web && git stash list   # confirm empty; NEVER stash in a worktree here
cd apps/web && cp src/components/v2/scorepad/transport.ts /tmp/t.bak
# temporarily restore the old 409 branch, run, confirm RED, then:
cd apps/web && cp /tmp/t.bak src/components/v2/scorepad/transport.ts
```

A regression test that has never been seen red is decoration.

- [ ] **Step 3: Write the e2e**

Append to `apps/web/e2e/device-links.spec.ts`: open a device-link pad, record a rally, void it, then void the same entry again, and assert the pad surfaces a refusal, the queue depth returns to zero, and further taps still record. Assert on the refusal COPY a scorer reads, not on a status code. Sweep by behaviour — grep the testid and route, not the filename — since `device-links.spec.ts` may not be the only spec that drives this path.

Add the missing testid to the void button (`device-score-pad.tsx:312-323`, which today has none):

```tsx
data-testid="device-void-mine"
```

- [ ] **Step 4: Run the e2e against a prod build**

Per `seazn-local-env`: prod build, `E2E_PROD_TARGET` on **`localhost`**:3100 — `127.0.0.1` 401s every API call because the cookie is Secure.

Run the WHOLE spec file, never a `-g` slice: a filter selects the tests you thought of, not the ones you broke. If `mobile.spec.ts` goes red, treat its count as a floor — it is `mode: "serial"`, so the first failure aborts the rest.

- [ ] **Step 5: Full gate**

```bash
cd apps/web && rtk proxy npx vitest run --reporter=json --outputFile=/tmp/full.json
jq '{total:.numTotalTests,passed:.numPassedTests,failed:.numFailedTests,files:(.testResults|length)}' /tmp/full.json
cd apps/web && NODE_OPTIONS=--max-old-space-size=6144 rtk proxy npx tsc --noEmit; echo "EXIT=$?"
cd /Users/ashokhein/github/seazn.club && rtk proxy npm run lint
cd apps/web && npm run openapi:gen && npm run i18n:gen-keys
cd /Users/ashokhein/github/seazn.club && git status --porcelain   # MUST be empty
```

Judge green only from the JSON counts. `files` should be ~1430 for a full `apps/web` run — a much smaller number means suites failed to collect, which reports as zero failures.

- [ ] **Step 6: Commit**

```bash
git add apps/web/e2e/device-links.spec.ts \
        apps/web/src/components/v2/scorepad/__tests__/use-pad-pipeline.test.tsx \
        apps/web/src/components/v2/device-score-pad.tsx
git commit -m "test(device-links): pin the already-undone wedge end to end"
```

---

## Known-inert seams in these files — do not build on them

Found while mapping this wave. Each is declared, typed, and never driven by a production caller. Named here so a later task does not mistake one for a working channel:

- `PadHostV3Props.onStateChange` (`pad-host.tsx:1498`) — never forwarded by `registry.tsx`. Still inert after this wave. Do not assume it works; removing it is out of scope here.
- `ScorePadProps.auth` — **closed by Task 0.** Was passed in by `device-score-pad.tsx:347`, accepted at `registry.tsx:193-221`, and dropped at `:289-304`.

## Deferred to later waves

- **W2 — durable idempotency.** `score_events.idempotency_key` column plus a unique index (spec §6). Money path; next wave.
- **W3 — the realtime seam.** One-way resync in the device chrome, the console's missing independent refresh, `sinceSeq` as an array count (spec §5). The `auth` forwarding was **pulled out of W3 into Task 0** by owner ruling 2026-09-21. **Do not add a drain retry timer before W1 ships** — against a wedged head a timer only multiplies futile requests into the limiter.
- **Possible second defect, recorded not absorbed.** `scoring.ts:258` publishes the fixture broadcast as `void publishFixtureUpdate(fixtureId, "event")` — a floating promise a serverless handler can drop before the response flushes. If Task 0's Step 6 shows the pad updating on a tap but never on a broadcast, this is the next thing to look at. It is not part of W1.
