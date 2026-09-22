import { readFileSync } from "node:fs";
import { expect, test, type Page } from "@playwright/test";

// Shared machinery for the REALTIME PROPAGATION specs — the four flows
// surveyed in
// `docs/superpowers/specs/2026-09-21-device-link-scoring-gaps-design.md` §6b:
//
//   (a) a device-link pad writes  -> the organiser console's screen moves
//   (b) the console writes        -> the device-link pad's screen moves
//   (c) the device chrome writes  -> its OWN inner v3 pad's screen moves
//   (d) any write                 -> the public/spectator surface moves
//
// (d) was already covered. (a)-(c) had nothing at all.
//
// THE ONE RULE THIS FILE EXISTS TO ENFORCE. A propagation test that merely
// waits for the value to appear is satisfied by the 15-SECOND POLLING
// FALLBACK, and would therefore have gone on passing straight through the
// defect this wave exists to fix (a device-link pad whose realtime token was
// requested anonymously, refused, and silently downgraded to poll). The only
// assertion that can tell realtime from "eventually" is a clock: the value
// moved AND it moved in less than the pad's own poll interval. That is the
// technique `stream-overlay.spec.ts`'s private-realtime test uses, and it is
// the only place in the repo that had it before this wave.

/**
 * The pad's OWN polling interval, re-derived from the module that declares it.
 *
 * NOT an import, because there is nothing to import: `use-fixture-stream.ts`
 * declares `const POLL_MS = 15_000` with no `export` keyword, and widening
 * that module's surface is out of scope for a test-only change.
 *
 * NOT a typed `15000` either. Every assertion downstream of this is "faster
 * than the poll"; a literal here would go on asserting yesterday's number the
 * moment somebody moved the real one, which is exactly the class of rot
 * AGENTS.md names ("derive the expected value from the source of truth, never
 * a table typed into the test"). Reading the declaration means a rename or a
 * re-timing throws HERE, loudly, instead of quietly weakening every
 * propagation test in the suite.
 *
 * Same reader idiom as `enterprise-gate.spec.ts`'s `readAdminPlanLabel()`.
 *
 * PREMISE CORRECTION. This constant is commonly cited as living in
 * `use-pad-pipeline.ts`. It does not: `usePadPipeline` passes
 * `pollMs: params.streamPollMs` (a test-only override, `undefined` in
 * production) straight through to `useFixtureStream`, which supplies the
 * default. `use-fixture-stream.ts` is the source of truth.
 */
export function padPollMs(): number {
  const url = new URL("../src/components/v2/scorepad/use-fixture-stream.ts", import.meta.url);
  const src = readFileSync(url, "utf8");
  const m = src.match(/^const POLL_MS\s*=\s*([0-9_]+)\s*;/m);
  if (!m) {
    throw new Error(
      "POLL_MS's declaration shape changed in scorepad/use-fixture-stream.ts — update this reader. " +
        "Do NOT replace it with a literal: every propagation assertion in the e2e suite is measured " +
        "against this number, and a stale copy weakens all of them silently.",
    );
  }
  const ms = Number(m[1]!.replace(/_/g, ""));
  if (!Number.isFinite(ms) || ms <= 0) {
    throw new Error(`POLL_MS read from use-fixture-stream.ts is not a usable interval: "${m[1]}"`);
  }
  return ms;
}

/** Set `E2E_REQUIRE_REALTIME=1` to turn "this environment has no realtime
 *  websocket" from a declared degradation into a hard failure. CI builds
 *  against a stub Supabase host and never subscribes (recorded in
 *  `stream-overlay.spec.ts`), so the default has to tolerate it — but an
 *  environment that is SUPPOSED to have realtime (a prod-target local run,
 *  staging) should not be allowed to quietly skip the only clause that
 *  separates realtime from a 15-second wait. */
const REQUIRE_REALTIME = process.env.E2E_REQUIRE_REALTIME === "1";

export interface FixtureRealtimeWatch {
  /** True once a websocket frame confirmed a SUCCESSFUL channel join for this
   *  fixture. Latches: a later teardown does not clear it, deliberately — a
   *  pad that joined and then lost the channel before the write it was
   *  supposed to hear is a DEFECT, and must be measured as one rather than
   *  excused as an absent environment. */
  joined: () => boolean;
  /** Every status the realtime-token door answered this page, in order. */
  tokenStatuses: number[];
  /** Every `Authorization` header this page presented at that door, in order.
   *  `undefined` means the pad asked anonymously — which is the exact defect
   *  the device-link `auth` chain exists to prevent. */
  authHeaders: (string | undefined)[];
}

/**
 * Arm the two observers a propagation assertion needs, from OUTSIDE the app.
 *
 * MUST be awaited BEFORE `page.goto(...)`: the pad asks for its realtime
 * token from a mount effect, so a listener attached after the navigation
 * resolves is a race that reads as "the pad never asked".
 *
 * Why a websocket sniff rather than a `data-*` attribute: the v3 pad surfaces
 * no transport state in its DOM (`useFixtureStream` returns `mode`, and
 * nothing renders it), and this wave is not permitted to add one. Playwright
 * can see the socket the page opens, which is a strictly external
 * observation — it cannot be satisfied by the app claiming success.
 */
export async function watchFixtureRealtime(
  page: Page,
  fixtureId: string,
): Promise<FixtureRealtimeWatch> {
  const tokenStatuses: number[] = [];
  const authHeaders: (string | undefined)[] = [];
  let joined = false;

  // A Phoenix join reply for THIS fixture's channel. Every socket is scanned
  // rather than filtering on a Supabase hostname: the host is environment
  // dependent, and a filter that missed would read as "no realtime here",
  // which is the branch that SKIPS the assertion — the one direction a
  // detector must never fail in.
  const STATUS_OK = /"status"\s*:\s*"ok"/;
  page.on("websocket", (ws) => {
    ws.on("framereceived", (frame) => {
      const text =
        typeof frame.payload === "string" ? frame.payload : frame.payload.toString("utf8");
      if (!text.includes(`fixture:${fixtureId}`)) return;
      if (!text.includes("phx_reply") || !STATUS_OK.test(text)) return;
      joined = true;
    });
  });

  await page.route("**/api/v1/public/fixtures/*/realtime-token", async (route) => {
    if (!route.request().url().includes(fixtureId)) {
      await route.continue();
      return;
    }
    authHeaders.push(route.request().headers()["authorization"]);
    // The DOOR'S ANSWER, not only the request. A pad can go on presenting a
    // perfectly correct credential while the route regresses underneath it
    // and drops it back to the poll — asserting the header alone is the
    // vacuous half. Same technique as `device-links.spec.ts`'s token test.
    const response = await route.fetch();
    tokenStatuses.push(response.status());
    await route.fulfill({ response });
  });

  return { joined: () => joined, tokenStatuses, authHeaders };
}

/**
 * Prove the observable is NOT moving on its own, BEFORE anything is measured
 * against it moving.
 *
 * Every assertion in this file is of the form "the screen changed, and it
 * changed fast". A reading that drifts by itself — a ticking clock, a
 * spinner, a relative timestamp, a re-render that reorders whitespace —
 * satisfies the first half in every state, including the broken one, and
 * reports an `elapsedMs` of a few hundred milliseconds that looks like a
 * triumphant realtime result. Two samples an interval apart is the whole
 * cost of closing that.
 *
 * Returns the settled value so the caller can quote it.
 */
export async function expectObservableIdle(opts: {
  read: () => Promise<string>;
  settleMs?: number;
  what: string;
}): Promise<string> {
  const first = await opts.read();
  await new Promise((resolve) => setTimeout(resolve, opts.settleMs ?? 1_200));
  const second = await opts.read();
  expect(
    second,
    `${opts.what}: this reading changed on its own ("${first}" -> "${second}") before any write was issued. "It changed" therefore cannot be evidence that anything propagated — pick a reading that only the ledger moves.`,
  ).toBe(first);
  return second;
}

export interface PropagationResult {
  /** Wall clock from just BEFORE the write was issued to the moment the
   *  watching screen's value changed. Includes the write's own round trip,
   *  which is deliberate: that is the latency a scorer experiences, and it
   *  keeps the measurement conservative rather than flattering. */
  elapsedMs: number;
  before: string;
  after: string;
}

/**
 * Issue `write`, then wait for `read` to move off whatever it said first, and
 * report how long that took.
 *
 * `read` must be cheap and must never throw — a locator that is briefly
 * absent should report `""`, not reject, or the poll dies on a re-render
 * instead of retrying through it.
 */
export async function measurePropagation(opts: {
  read: () => Promise<string>;
  write: () => Promise<void>;
  /** Generous: this is the "did it arrive AT ALL" bound, not the realtime
   *  bound. The realtime bound is `assertPropagatedUnderPoll` below. */
  timeoutMs: number;
  what: string;
}): Promise<PropagationResult> {
  const before = await opts.read();
  const t0 = Date.now();
  await opts.write();
  await expect
    .poll(opts.read, {
      message: `${opts.what}: never moved off "${before}" at all — the write did not land, or nothing on this screen reads the ledger`,
      timeout: opts.timeoutMs,
      intervals: [100, 200, 400, 800, 1_000],
    })
    .not.toBe(before);
  return { elapsedMs: Date.now() - t0, before, after: await opts.read() };
}

/**
 * THE CLAUSE. Assert the observed propagation was realtime, not the poll.
 *
 * Two assertions fire UNCONDITIONALLY, in every environment, because neither
 * is an environment question:
 *
 *  1. the watching pad ASKED at the realtime-token door, and
 *  2. the door LET IT IN (200).
 *
 * A pad that never asks, or is refused, is downgraded to the 15-second poll
 * for the rest of the match — that is the shipped defect, and it must red on
 * a stub Supabase host exactly as loudly as on a real one.
 *
 * The timing clause itself is gated on a socket having actually joined,
 * because CI builds against a stub Supabase host where no socket ever will
 * (recorded in `stream-overlay.spec.ts`, which degrades the same way). When
 * it degrades it says so in the test's annotations rather than passing
 * silently, and `E2E_REQUIRE_REALTIME=1` turns the degradation into a red for
 * the environments that are supposed to have realtime.
 */
export function assertPropagatedUnderPoll(opts: {
  where: string;
  result: PropagationResult;
  watch: FixtureRealtimeWatch;
  pollMs: number;
}): void {
  const { where, result, watch, pollMs } = opts;

  expect(
    watch.tokenStatuses.length,
    `${where}: this screen never asked the realtime-token door at all, so it can only ever be on the ${pollMs}ms poll`,
  ).toBeGreaterThan(0);
  expect(
    watch.tokenStatuses[0],
    `${where}: the realtime-token door answered ${watch.tokenStatuses[0]} — refused, so the pad is on the ${pollMs}ms poll for the rest of the match (auth headers seen: ${JSON.stringify(watch.authHeaders)})`,
  ).toBe(200);

  if (!watch.joined()) {
    const note =
      `${where}: no websocket ever joined this fixture's channel, so the ` +
      `"under ${pollMs}ms" clause was NOT exercised. The value did arrive ` +
      `(${result.elapsedMs}ms, "${result.before}" -> "${result.after}"), by poll.`;
    expect(
      REQUIRE_REALTIME,
      `${note} E2E_REQUIRE_REALTIME=1 is set, which says this environment is supposed to HAVE realtime — so a pad sitting on the poll is the failure, not the environment.`,
    ).toBe(false);
    test.info().annotations.push({ type: "realtime-unavailable", description: note });
    console.warn(`${note} Set E2E_REQUIRE_REALTIME=1 to make this a failure.`);
    return;
  }

  expect(
    result.elapsedMs,
    `${where}: "${result.before}" -> "${result.after}" took ${result.elapsedMs}ms — at or above the pad's own POLL_MS (${pollMs}) that is the polling fallback arriving, not realtime. The channel DID join, so this is a dropped broadcast or a subscription torn down across the write, not a missing environment.`,
  ).toBeLessThan(pollMs);
}
