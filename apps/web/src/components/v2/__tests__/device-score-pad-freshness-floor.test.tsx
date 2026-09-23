// G1 — the device-link pad's own freshness floor.
//
// W3 gave the ORGANISER's console a tab-return refresh
// (`fixture-console.tsx`, the `visibilitychange`/`focus` effect), so a stalled
// pad pipeline — a 403 at the realtime token door on a Community plan, a
// websocket that joined and died, a wedged drain — cannot leave stale numbers
// on that screen without an upper bound. The COURTSIDE pad
// (`device-score-pad.tsx`, the surface of the person actually scoring) is the
// console's twin and never got it: every refresh it performed was its own
// `send()` or its own inner pad's ledger change, both downstream of the very
// pipeline that stalls.
//
// WHAT THIS FILE CAN AND CANNOT SEE. `apps/web` vitest is `environment:
// "node"`: there is no browser, so nothing here can prove a real tab return
// DISPATCHES `visibilitychange` or `focus`, or that the browser delivers it.
// What it can prove, by stubbing `document`/`window` with recording targets
// and invoking the handler the component registered:
//   - which events the component listens for, and on which target;
//   - what that handler does when invoked — refreshes through the
//     `padSyncing` gate (observable: Undo is greyed mid-flight), ignores a
//     hide, and is bounded;
//   - that it is not an interval, that it is torn down on unmount, and that
//     the effect mounts cleanly with a partial DOM or none.
// The browser proof — a real page, a real pipeline stall, a real dispatch —
// is `e2e/walkthrough/device-pad-stalled-pipeline.spec.ts`.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { createServer, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import type { ReactElement } from "react";
import { DeviceScorePad, type PadEventIn } from "@/components/v2/device-score-pad";
import { OPPORTUNISTIC_RESYNC_MS, type SideInfo, type SportInfo } from "@/components/v2/fixture-console";
import { propsOf, renderIsland } from "@/components/__tests__/_hook-harness";

const api = vi.hoisted(() => ({
  calls: [] as { url: string; options?: { method?: string; json?: unknown; signal?: AbortSignal } }[],
  /** What the events GET returns. */
  events: [] as unknown[],
  /** What the state GET reports as the headline — moved mid-test to stand in
   *  for a score that arrived from somewhere else (a second device, the API). */
  headline: null as string | null,
  /** A HALF-OPEN socket, the shape a laptop waking from sleep or a Wi-Fi
   *  switch actually presents: the request is accepted and never answers. A
   *  GET in this mode settles ONLY through an `AbortSignal` the caller handed
   *  down; with none it hangs forever — the unbounded case itself, not a
   *  stubbed rejection standing in for it. Same double as
   *  `fixture-console-undo-pad-events.test.tsx`'s. */
  hang: false,
  /** The same half-open socket, answered the way `apiV1` answered an abort
   *  that landed MID-BODY before review round 1: the body-parse catch
   *  swallowed it and the call RESOLVED with `undefined`. The helper is fixed
   *  at the root now (`client-v1.test.ts`); this keeps the pad's own
   *  `throwIfAborted` honest against any transport that still resolves. */
  resolveUndefinedOnAbort: false,
  /** Every refresh GET is REFUSED with this envelope error — the shape
   *  `apiV1` throws for a revoked/expired link (a real `ApiV1Error`). */
  refuse: null as { code: string; status: number; message: string } | null,
  /** A 200 that `apiV1` hands back WITHOUT a usable body (review round 2): a
   *  connection dropped mid-body with no abort (undici `TypeError:
   *  terminated`) fails the body parse, `apiV1` defaults it to `{}` and
   *  resolves its `data` — `undefined`. `"state"` answers `/state` that way;
   *  `"events"` answers the ledger with a non-array. The other GET is healthy. */
  malformed: null as "state" | "events" | null,
  /** Route every GET through the REAL `apiV1` (and whatever `fetch` the test
   *  installs), recording how each call settled — the real-socket case. */
  real: false,
  realOutcomes: [] as { url: string; outcome: Promise<{ resolved: unknown } | { rejected: unknown }> }[],
  /** When set, `/state` resolves exactly this body (the ledger still answers
   *  `events`) — for server shapes the default double does not produce. */
  stateBody: null as unknown,
}));

vi.mock("@/lib/client-v1", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/client-v1")>();
  return {
    ...actual, // ApiV1Error stays the REAL class.
    apiV1: vi.fn((url: string, options?: { method?: string; json?: unknown; signal?: AbortSignal }) => {
      api.calls.push({ url, options });
      if (options?.method === "POST") return Promise.resolve({});
      if (api.real) {
        const call = actual.apiV1(url, options);
        api.realOutcomes.push({
          url,
          outcome: call.then(
            (resolved) => ({ resolved }),
            (rejected: unknown) => ({ rejected }),
          ),
        });
        return call;
      }
      if (api.malformed === "state" && !url.includes("/events")) return Promise.resolve(undefined);
      if (api.malformed === "events" && url.includes("/events")) return Promise.resolve({});
      if (api.refuse !== null) {
        const { code, status, message } = api.refuse;
        return Promise.reject(new actual.ApiV1Error(message, status, code));
      }
      if (api.hang || api.resolveUndefinedOnAbort) {
        return new Promise((resolve, reject) => {
          const signal = options?.signal;
          if (signal === undefined || signal === null) return; // never settles
          signal.addEventListener(
            "abort",
            () => (api.resolveUndefinedOnAbort ? resolve(undefined) : reject(signal.reason)),
            { once: true },
          );
        });
      }
      if (url.includes("/events")) return Promise.resolve(api.events);
      if (api.stateBody !== null) return Promise.resolve(api.stateBody);
      return Promise.resolve({
        status: "in_play",
        last_seq: api.events.length,
        summary: api.headline === null ? null : { headline: api.headline },
        state: {},
        outcome: null,
      });
    }),
  };
});

const DEVICE_LINK_ID = "link-1";

/** Recorded by THIS link, so "Void my last entry" renders — the control the
 *  `padSyncing` gate greys, and so the probe for whether the refresh went
 *  through that gate at all. */
const OWN: PadEventIn = {
  id: "ev-own",
  seq: 1,
  type: "badminton.rally",
  payload: {},
  recorded_at: "2026-09-23T10:00:00.000Z",
  voids_event_id: null,
  device_link_id: DEVICE_LINK_ID,
};

/** A rally that landed from somewhere else while this pad's pipeline was
 *  stalled. Not this link's, so it does not move `lastOwnVoidable` — the
 *  refresh is witnessed by the headline instead. */
const FOREIGN: PadEventIn = {
  id: "ev-foreign",
  seq: 2,
  type: "badminton.rally",
  payload: {},
  recorded_at: "2026-09-23T10:05:00.000Z",
  voids_event_id: null,
  device_link_id: null,
};

const sport: SportInfo = {
  key: "badminton",
  config: {},
  scorerLabel: "Umpire",
  positionGroups: [],
  roles: [],
  lineupSize: 2,
  benchMax: 1,
};

const side = (id: string, name: string): SideInfo => ({ id, name, members: [], lineup: [] });

/** The chrome opens on "0 — 0" (a null summary's own fallback in
 *  `device-score-pad.tsx`); the arriving score reads differently, so a render
 *  that never refreshed cannot satisfy the "it moved" assertions. */
const ARRIVED = "0 — 0 (1–0)";

function baseProps() {
  return {
    token: "dl_test",
    deviceLinkId: DEVICE_LINK_ID,
    fixture: {
      id: "f1",
      round_no: 2,
      venue: null,
      court_label: "Court 2",
      competition_name: "Summer League",
      division_name: "Badminton Singles",
    },
    sport,
    home: side("h", "Nia"),
    away: side("a", "Mira"),
    initialState: { status: "in_play", last_seq: 1, summary: null, state: {}, outcome: null },
    initialEvents: [OWN],
    scorePadV2: {
      moduleVersion: "1.0.0",
      resolvedConfig: {},
      initialEvents: [],
      entitlements: {},
      band: 0 as const,
      identity: { recordedBy: null, deviceLinkId: DEVICE_LINK_ID },
    },
  };
}

type Listener = () => void;

/** A recording `EventTarget` stand-in. Only the two methods the effect calls
 *  exist, so an effect that reached for anything else would throw here rather
 *  than pass against a permissive double. */
function recordingTarget() {
  const listeners: Record<string, Listener[]> = {};
  return {
    listeners,
    addEventListener: (type: string, fn: Listener) => {
      (listeners[type] ??= []).push(fn);
    },
    removeEventListener: (type: string, fn: Listener) => {
      listeners[type] = (listeners[type] ?? []).filter((f) => f !== fn);
    },
  };
}

function stubDocument(visibilityState: DocumentVisibilityState = "visible") {
  const doc = { ...recordingTarget(), visibilityState };
  vi.stubGlobal("document", doc);
  return doc;
}

function stubWindow() {
  const win = recordingTarget();
  vi.stubGlobal("window", win);
  return win;
}

/** Invoke every handler the component registered for `type` on `target` —
 *  the component's own function, called the way the browser would call it.
 *  Counted through `?? []` so a listener that was never registered reads as
 *  "fired nothing" (and the assertion after it names the defect) rather than
 *  as a TypeError about the test. */
function fire(target: { listeners: Record<string, Listener[]> }, type: string) {
  for (const fn of [...(target.listeners[type] ?? [])]) fn();
}

const count = (target: { listeners: Record<string, Listener[]> }, type: string) =>
  (target.listeners[type] ?? []).length;

/** "Void my last entry" — the only <button> this component renders with a
 *  `title` (`score.voidLastTitle`); Start-match carries none. */
function voidMine(tree: ReactElement[]): ReactElement {
  const el = tree.find((e) => e.type === "button" && propsOf(e).title !== undefined);
  if (!el) throw new Error("the device link's own 'Void my last entry' button did not render");
  return el;
}

const refreshCalls = () => api.calls.filter((c) => c.options?.method !== "POST");

beforeEach(() => {
  vi.useFakeTimers();
  api.calls.length = 0;
  api.events = [OWN];
  api.headline = null;
  api.hang = false;
  api.resolveUndefinedOnAbort = false;
  api.refuse = null;
  api.malformed = null;
  api.real = false;
  api.realOutcomes.length = 0;
  api.stateBody = null;
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("DeviceScorePad — the tab-return freshness floor (G1)", () => {
  it("listens for BOTH a visibility change on the document and a focus on the window", () => {
    // Both, because they do not always co-occur: a window-manager focus with
    // no visibility transition fires only `focus`; a tab switch inside an
    // already-focused window fires only `visibilitychange`.
    const doc = stubDocument();
    const win = stubWindow();
    renderIsland(DeviceScorePad, baseProps());

    expect(count(doc, "visibilitychange"), "document visibilitychange listeners").toBe(1);
    expect(count(win, "focus"), "window focus listeners").toBe(1);
    // And on the RIGHT target: `focus` does not bubble to `document`, and
    // `visibilitychange` is never fired at `window`.
    expect(count(doc, "focus"), "focus is a window event").toBe(0);
    expect(count(win, "visibilitychange"), "visibilitychange is a document event").toBe(0);
  });

  it("a return to the tab refreshes the chrome THROUGH the padSyncing gate, and the gate reopens", async () => {
    const doc = stubDocument("visible");
    stubWindow();
    const island = renderIsland(DeviceScorePad, baseProps());

    // Positive pair for the "greyed" assertion below: live at rest, so it
    // cannot pass by the control being absent or permanently disabled.
    expect(propsOf(voidMine(island.tree())).disabled).toBe(false);
    expect(island.text(), "the chrome opens on the bootstrap headline").toContain("0 — 0");
    expect(island.text()).not.toContain(ARRIVED);
    expect(refreshCalls(), "the floor must not fetch at mount — only on a return").toHaveLength(0);

    // A score arrives elsewhere while this pad's pipeline is stalled.
    api.events = [OWN, FOREIGN];
    api.headline = ARRIVED;

    fire(doc, "visibilitychange");

    // The same pair `resync()` has always read: the state AND the whole ledger.
    expect(refreshCalls().map((c) => c.url)).toEqual([
      "/api/v1/fixtures/f1/state",
      "/api/v1/fixtures/f1/events?since_seq=0",
    ]);
    // Greyed WHILE in flight. A handler that called `resync()` directly never
    // raises `padSyncing`, leaving Void live with a stale `expected_seq` at
    // exactly the moment the scorer is back at the pad — the 409 SEQ_CONFLICT
    // the flag exists to prevent (its own doc in device-score-pad.tsx).
    expect(
      propsOf(voidMine(island.tree())).disabled,
      "the tab-return refresh must raise padSyncing — calling resync() directly bypasses the gate",
    ).toBe(true);

    await vi.advanceTimersByTimeAsync(1000);

    expect(island.text(), "the chrome must show the score that arrived while it was stalled").toContain(
      ARRIVED,
    );
    expect(propsOf(voidMine(island.tree())).disabled, "the gate must reopen once the refresh settles").toBe(
      false,
    );
  });

  it("a window focus on its own refreshes too — no visibility transition needed", async () => {
    stubDocument("visible");
    const win = stubWindow();
    const island = renderIsland(DeviceScorePad, baseProps());

    api.events = [OWN, FOREIGN];
    api.headline = ARRIVED;

    fire(win, "focus");

    expect(refreshCalls(), "a bare focus must refresh").toHaveLength(2);
    expect(propsOf(voidMine(island.tree())).disabled, "and through the same gate").toBe(true);

    await vi.advanceTimersByTimeAsync(1000);

    expect(island.text()).toContain(ARRIVED);
    expect(propsOf(voidMine(island.tree())).disabled).toBe(false);
  });

  it("a HIDE fetches nothing — visibilitychange fires on leaving the tab as well as returning", async () => {
    const doc = stubDocument("hidden");
    stubWindow();
    const island = renderIsland(DeviceScorePad, baseProps());

    api.events = [OWN, FOREIGN];
    api.headline = ARRIVED;

    fire(doc, "visibilitychange");
    await vi.advanceTimersByTimeAsync(1000);

    expect(refreshCalls(), "a tab the scorer just left must not be refreshed").toHaveLength(0);
    expect(propsOf(voidMine(island.tree())).disabled, "nor gated").toBe(false);
    expect(island.text()).not.toContain(ARRIVED);

    // Positive pair: the SAME registered handler does refresh once the tab
    // reads visible, so the silence above is the guard, not a dead listener.
    doc.visibilityState = "visible";
    fire(doc, "visibilitychange");
    await vi.advanceTimersByTimeAsync(1000);

    expect(refreshCalls(), "the same handler, visible this time").toHaveLength(2);
    expect(island.text()).toContain(ARRIVED);
  });

  it("is bounded: a refresh that never answers reopens the controls at its budget, not before", async () => {
    // The exposure the bound exists for. A tab return is exactly when a woken
    // laptop's socket is half-open, and `apiV1` sets no timeout of its own —
    // so an unbounded refresh would never reach the `finally` that lowers
    // `padSyncing`, and "Void my last entry" would stay greyed with no error
    // and no limit.
    const doc = stubDocument("visible");
    stubWindow();
    const island = renderIsland(DeviceScorePad, baseProps());

    api.hang = true;
    fire(doc, "visibilitychange");

    // Really in flight, really gating — otherwise the recovery proves nothing.
    expect(refreshCalls()).toHaveLength(2);
    expect(propsOf(voidMine(island.tree())).disabled).toBe(true);
    // And every request in the pair carries the SAME live signal: a bound on
    // one leg only would leave the other to hang the `Promise.all`.
    const signals = refreshCalls().map((c) => c.options?.signal);
    expect(signals[0], "the refresh must hand apiV1 an AbortSignal").toBeInstanceOf(AbortSignal);
    expect(signals[1]).toBe(signals[0]);

    // The budget itself is a requirement, not a derived value, so it is
    // checked against the requirement. The two waits below are measured FROM
    // the constant, so on their own they could only catch a timer that
    // disagrees with it — these lines are what catch the constant itself
    // moving out of range.
    //
    // FLOOR 8s (review round 1 — a 5s floor admitted a 5s budget and killed
    // no mutant). A courtside refresh is two GETs, one of them the WHOLE
    // ledger, over venue Wi-Fi or mobile data, where multi-second round trips
    // are routine; an abort that lands on a slow-but-alive refresh fails it
    // silently, and the floor then does nothing exactly where it is needed.
    // The walkthrough leans on it too: `device-pad-stalled-pipeline.spec.ts`
    // holds the refresh open for this budget less 4s of headroom to observe
    // the gate, and refuses to run on under 3s of hold (a budget below 7s).
    //
    // CEILING 60s — the minute W3's console test holds as the most a scorer
    // should wait on greyed controls.
    expect(OPPORTUNISTIC_RESYNC_MS).toBeGreaterThanOrEqual(8_000);
    expect(OPPORTUNISTIC_RESYNC_MS).toBeLessThanOrEqual(60_000);

    // Not before the budget: the timer must be armed with the constant, not
    // some shorter figure (or none — an immediate abort).
    await vi.advanceTimersByTimeAsync(OPPORTUNISTIC_RESYNC_MS - 1);
    expect(propsOf(voidMine(island.tree())).disabled, "aborted before its budget").toBe(true);

    await vi.advanceTimersByTimeAsync(2);
    expect(
      propsOf(voidMine(island.tree())).disabled,
      "a refresh that never answers must not gate the controls forever",
    ).toBe(false);
  });

  it("an aborted refresh that RESOLVES (undefined) leaves the pad's state untouched and its gate open", async () => {
    // Review round 1: a transport that answers an abort by resolving rather
    // than rejecting — `apiV1` did exactly that for an abort mid-body — used
    // to reach `setLive(undefined)`, and the next render threw on
    // `live.summary`. `resync` now checks its own signal after the requests
    // settle and before touching state.
    const doc = stubDocument("visible");
    stubWindow();
    const island = renderIsland(DeviceScorePad, baseProps());

    api.resolveUndefinedOnAbort = true;
    fire(doc, "visibilitychange");
    expect(propsOf(voidMine(island.tree())).disabled, "the refresh really is in flight").toBe(true);

    await vi.advanceTimersByTimeAsync(OPPORTUNISTIC_RESYNC_MS + 1);

    // A fresh render, not the harness's last output: a render that THREW
    // leaves the previous tree in place, so reading `island.tree()` alone
    // could not tell a crashed pad from a healthy one.
    expect(() => island.rerender(baseProps()), "the pad crashed rendering an aborted refresh").not.toThrow();
    expect(island.text(), "live state untouched — still the bootstrap headline").toContain("0 — 0");
    const settled = voidMine(island.tree());
    expect(propsOf(settled).title, "events untouched — still targeting this link's own seq 1").toContain("seq 1");
    expect(propsOf(settled).disabled, "padSyncing cleared by the finally").toBe(false);
  });

  it("leaves no timer armed once a refresh settles", async () => {
    // The bound's timer is cleared in `resync`'s `finally`. Without that, every
    // settled refresh leaves one armed for the full budget — two per tab
    // return — which later aborts a controller nobody is listening to.
    const doc = stubDocument("visible");
    stubWindow();
    renderIsland(DeviceScorePad, baseProps());
    expect(vi.getTimerCount(), "nothing is armed at rest").toBe(0);

    fire(doc, "visibilitychange");
    // Positive pair: the budget timer IS visible to this count while the
    // refresh is in flight, so the zero below is the clear, not a blind spot.
    expect(vi.getTimerCount(), "the budget timer is armed while the refresh is in flight").toBe(1);

    // Settles at once (the double answers immediately) — far short of the
    // budget, so an uncleared timer would still be pending here.
    await vi.advanceTimersByTimeAsync(1000);
    expect(vi.getTimerCount(), "a settled refresh must clear its budget timer").toBe(0);
  });

  it("is NOT an interval — a pad nobody returns to costs nothing", async () => {
    // A second timer on the same fixture would double the request rate of
    // every courtside pad in the product; W3 made the same call for the
    // console. Ten poll-lengths of an untouched tab: not one request.
    stubDocument("visible");
    stubWindow();
    renderIsland(DeviceScorePad, baseProps());

    await vi.advanceTimersByTimeAsync(10 * 15_000);

    expect(refreshCalls(), "the floor fires on a return, never on a clock").toHaveLength(0);
  });

  it("removes both listeners on unmount", () => {
    const doc = stubDocument("visible");
    const win = stubWindow();
    const island = renderIsland(DeviceScorePad, baseProps());
    expect(count(doc, "visibilitychange") + count(win, "focus")).toBe(2);

    island.unmount();

    expect(count(doc, "visibilitychange"), "visibilitychange left registered").toBe(0);
    expect(count(win, "focus"), "focus left registered").toBe(0);
  });
});

// Review round 1, item 5 (owner-approved) — A LINK THAT DIES WHILE THE SCORER
// IS AWAY.
//
// The organiser revokes the link, or it expires, while the phone is in a
// pocket. The scorer comes back: the tab-return refresh is the FIRST request
// to learn the link is dead. It used to be swallowed like any other failed
// refresh, so the pad kept its live controls — every tap then failed — and
// every later return spent four more requests on a link that can never answer.
// It now lands on the same dead-link screen `send()` shows, and a dead pad
// stops listening. Anything else a refresh can fail with stays swallowed.
describe("DeviceScorePad — a tab-return refresh that finds the link dead", () => {
  // The two codes the server throws for a link that died mid-day
  // (`server/usecases/device-links.ts`); message verbatim from there.
  const REVOKED = {
    code: "LINK_REVOKED",
    status: 401,
    message: "This device link was revoked — ask the organiser",
  };
  const EXPIRED = {
    code: "LINK_EXPIRED",
    status: 401,
    message: "This device link has expired — ask the organiser",
  };

  it.each([REVOKED, EXPIRED])("$code lands on the dead-link screen, as a refused send does", async (refusal) => {
    const doc = stubDocument("visible");
    stubWindow();
    const island = renderIsland(DeviceScorePad, baseProps());
    // Positive baseline: a live pad with its controls, not the dead screen.
    expect(island.text()).not.toContain(refusal.message);
    expect(propsOf(voidMine(island.tree())).disabled).toBe(false);

    api.refuse = refusal;
    fire(doc, "visibilitychange");
    await vi.advanceTimersByTimeAsync(1000);

    expect(island.text(), "the scorer must be told the link is dead").toContain(refusal.message);
    expect(
      island.tree().some((e) => e.type === "button"),
      "a dead link keeps no controls — every tap on them would fail",
    ).toBe(false);
  });

  it("once dead, a return costs nothing: no listener fires a request", async () => {
    const doc = stubDocument("visible");
    const win = stubWindow();
    const island = renderIsland(DeviceScorePad, baseProps());

    api.refuse = REVOKED;
    fire(doc, "visibilitychange");
    await vi.advanceTimersByTimeAsync(1000);
    expect(island.text(), "precondition: the pad is on the dead-link screen").toContain(REVOKED.message);
    expect(refreshCalls(), "precondition: the refresh that found it dead did fetch").toHaveLength(2);

    api.calls.length = 0;
    fire(doc, "visibilitychange");
    fire(win, "focus");
    await vi.advanceTimersByTimeAsync(1000);

    expect(refreshCalls(), "a dead link must not be asked again on every return").toHaveLength(0);
  });

  it("any other refusal is still swallowed: live controls, and the next return still refreshes", async () => {
    const doc = stubDocument("visible");
    stubWindow();
    const island = renderIsland(DeviceScorePad, baseProps());

    const outage = { code: "INTERNAL_ERROR", status: 500, message: "Something went wrong" };
    api.refuse = outage;
    fire(doc, "visibilitychange");
    await vi.advanceTimersByTimeAsync(1000);

    expect(island.text(), "a passing outage is not a dead link").not.toContain(outage.message);
    expect(propsOf(voidMine(island.tree())).disabled, "controls stay live — and ungated").toBe(false);

    // And still listening: once the outage clears, the next return refreshes.
    api.refuse = null;
    api.events = [OWN, FOREIGN];
    api.headline = ARRIVED;
    api.calls.length = 0;
    fire(doc, "visibilitychange");
    await vi.advanceTimersByTimeAsync(1000);

    expect(refreshCalls()).toHaveLength(2);
    expect(island.text()).toContain(ARRIVED);
  });
});

// Review round 2 — A 200 WHOSE BODY NEVER ARRIVED.
//
// A connection dropped mid-body with no abort (undici `TypeError:
// terminated`; a phone switching cells, a proxy resetting) fails `apiV1`'s
// body parse, which defaults to `{}` — deliberately, the v1 export routes
// answer non-JSON 200s — so the call RESOLVES `undefined`. `resync` then wrote
// that into `live` and the next render threw on `live.summary`. Present on
// `main` via `send()`'s own resync, and newly reachable from every tab return.
// `resync` now checks the SHAPE before either setter.
const EN_UI = JSON.parse(readFileSync("src/dictionaries/en/ui.json", "utf8")) as Record<string, string>;

describe("DeviceScorePad — a refresh whose 200 carried no usable body", () => {
  /** A LATER entry by this same link. In the healthy half of each pair, so a
   *  guard that let `setEvents` run would retarget "Void my last entry" from
   *  seq 1 to seq 2 — the witness that the ledger was left untouched. */
  const OWN_LATER: PadEventIn = { ...OWN, id: "ev-own-2", seq: 2, recorded_at: "2026-09-23T10:06:00.000Z" };

  it.each([
    { malformed: "state" as const, what: "/state resolved undefined" },
    { malformed: "events" as const, what: "the ledger resolved a non-array" },
  ])("$what: state untouched, nothing escapes render, the gate reopens", async ({ malformed }) => {
    const doc = stubDocument("visible");
    stubWindow();
    const island = renderIsland(DeviceScorePad, baseProps());

    // The HEALTHY half of the pair carries a new score, so a guard that let
    // either setter run would move the header.
    api.events = [OWN, OWN_LATER];
    api.headline = ARRIVED;
    api.malformed = malformed;
    fire(doc, "visibilitychange");
    expect(propsOf(voidMine(island.tree())).disabled, "the refresh really is in flight").toBe(true);

    await vi.advanceTimersByTimeAsync(1000);

    // A FRESH render: one that throws leaves the harness's previous tree in
    // place, so `island.tree()` alone cannot tell a crashed pad from a live one.
    expect(() => island.rerender(baseProps()), "the pad crashed rendering a bodiless refresh").not.toThrow();
    expect(island.text(), "live untouched — neither setter ran").not.toContain(ARRIVED);
    const settled = voidMine(island.tree());
    expect(propsOf(settled).title, "events untouched — still this link's own seq 1").toContain("seq 1");
    expect(propsOf(settled).disabled, "padSyncing cleared by the finally").toBe(false);
  });

  it("send(): a write that lands but whose refresh comes back bodiless says so in the scorer's language", async () => {
    // The path that was live on `main`. The POST succeeded; the resync after
    // it did not. `send()` catches, and — because the guard's error carries no
    // message of its own — shows the localized fallback rather than a
    // developer string. Not a crash, and the controls come back.
    const island = renderIsland(DeviceScorePad, baseProps());
    api.malformed = "state";

    (propsOf(voidMine(island.tree())).onClick as () => void)();
    await vi.advanceTimersByTimeAsync(1000);

    expect(api.calls.some((c) => c.options?.method === "POST"), "the write went out").toBe(true);
    expect(() => island.rerender(baseProps()), "the pad crashed after a bodiless send-resync").not.toThrow();
    expect(island.text()).toContain(EN_UI["device.failed"]);
    expect(propsOf(voidMine(island.tree())).disabled, "busy cleared by send()'s finally").toBe(false);
  });

  it("a PRE-START fixture's empty ledger is a valid refresh, and is APPLIED", async () => {
    // The guard's other edge (review round 3). An empty array is what the
    // ledger of a fixture nobody has started yet IS, and `/state` then answers
    // `scheduled`, `last_seq: 0`, null summary and state — the shape
    // `getFixtureState` (server/usecases/fixtures.ts) builds from a fixture
    // with no `match_states` row. A guard that read "empty" as "missing" would
    // strand a pre-start pad on whatever it held before. The pad opens here on
    // an in-play bootstrap with one of its own entries, so both setters leave
    // a visible mark: `live` flips the header to Start, `events` removes Void.
    const doc = stubDocument("visible");
    stubWindow();
    const island = renderIsland(DeviceScorePad, baseProps());
    const startMatch = () => island.tree().find((e) => propsOf(e)["data-testid"] === "score-start-match");
    // Baseline, so the flips below are real flips.
    expect(startMatch(), "an in-play bootstrap offers no Start").toBeUndefined();
    expect(propsOf(voidMine(island.tree())).disabled).toBe(false);

    api.events = [];
    api.stateBody = { fixture_id: "f1", status: "scheduled", last_seq: 0, summary: null, state: null, outcome: null };
    fire(doc, "visibilitychange");
    await vi.advanceTimersByTimeAsync(1000);

    expect(() => island.rerender(baseProps()), "the pad crashed applying a pre-start refresh").not.toThrow();
    expect(startMatch(), "live applied — status is scheduled, so Start is offered").toBeDefined();
    expect(
      island.tree().some((e) => e.type === "button" && propsOf(e).title !== undefined),
      "events applied — the empty ledger leaves this link nothing to void",
    ).toBe(false);
    expect(propsOf(startMatch()!).disabled, "padSyncing cleared by the finally").toBe(false);
  });

  it("the REAL path: node fetch, a socket destroyed mid-body with no abort", async () => {
    // Not a double: the real `apiV1` over node's own `fetch`, against a local
    // server that sends `/state`'s headers and half its body, then destroys the
    // socket. The ledger answers whole. Real timers — undici's I/O does not run
    // on vitest's fake clock.
    vi.useRealTimers();
    const held: { res: ServerResponse | null } = { res: null };
    const server = createServer((req, res) => {
      if ((req.url ?? "").includes("/events")) {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: true, data: [OWN, OWN_LATER] }));
        return;
      }
      res.writeHead(200, { "Content-Type": "application/json" });
      res.write('{"ok":true,"data":{"status":"in_play","summary":{"headline":"0 — 0 (1–');
      held.res = res;
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

    // Destroy only once the client HAS the headers: a socket killed before them
    // makes `fetch` itself reject, which never reaches the guard.
    const realFetch = globalThis.fetch;
    let stateHeadersIn!: () => void;
    const headersIn = new Promise<void>((resolve) => (stateHeadersIn = resolve));
    vi.stubGlobal("fetch", async (input: string, init?: RequestInit) => {
      const res = await realFetch(new URL(input, base), init);
      if (!input.includes("/events")) stateHeadersIn();
      return res;
    });
    try {
      const doc = stubDocument("visible");
      stubWindow();
      const island = renderIsland(DeviceScorePad, baseProps());
      api.real = true;

      fire(doc, "visibilitychange");
      await headersIn;
      held.res?.socket?.destroy();

      // Both real calls settle; then give `resync`'s continuation and
      // `handlePadEvents`' `finally` a turn to run.
      await vi.waitFor(() => expect(api.realOutcomes).toHaveLength(2), { timeout: 5_000 });
      const [first, second] = await Promise.all(api.realOutcomes.map((o) => o.outcome));
      await new Promise((resolve) => setTimeout(resolve, 50));

      // Precondition: this really is the bodiless-200 path — the real `apiV1`
      // RESOLVED `/state` with `undefined` rather than rejecting, and the
      // ledger came home whole. Were `/state` to reject, the refresh would be
      // swallowed upstream and this case would never reach the guard.
      const byUrl = api.realOutcomes[0]!.url.includes("/events") ? { state: second, events: first } : { state: first, events: second };
      expect(byUrl.state, "the dropped body must reach resync as a resolved undefined").toEqual({
        resolved: undefined,
      });
      expect(byUrl.events).toMatchObject({ resolved: [{ id: OWN.id }, { id: OWN_LATER.id }] });

      expect(() => island.rerender(baseProps()), "the pad crashed on a real dropped body").not.toThrow();
      expect(island.text(), "live untouched").not.toContain(ARRIVED);
      expect(propsOf(voidMine(island.tree())).title, "events untouched").toContain("seq 1");
      expect(propsOf(voidMine(island.tree())).disabled, "the gate reopened").toBe(false);
    } finally {
      held.res?.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});

// The DOM guard. React never runs an effect during SSR, so "no DOM" is this
// effect's real server behaviour; in THIS runner it is also reachable, because
// `renderIsland` commits effects with no browser. W3 shipped the console's
// copy unguarded and crashed three existing suites at mount
// (`ReferenceError: document is not defined`).
//
// Both clauses of the guard are witnessed here, one partial DOM each, because
// the suites that mount this component present different shapes — and a guard
// with one clause is a crash in whichever shape it forgot. Each case asserts
// the mount survives AND registers nothing, so a guard that "survived" by
// swallowing half its registrations would not read as a pass.
describe("DeviceScorePad — the floor's DOM guard", () => {
  it("mounts with no DOM at all", () => {
    expect(() => renderIsland(DeviceScorePad, baseProps())).not.toThrow();
  });

  it("mounts with a document but no window, and registers nothing", () => {
    const doc = stubDocument("visible");
    expect(() => renderIsland(DeviceScorePad, baseProps())).not.toThrow();
    expect(count(doc, "visibilitychange"), "a half-registered floor").toBe(0);
  });

  it("mounts with a window but no document, and registers nothing", () => {
    const win = stubWindow();
    expect(() => renderIsland(DeviceScorePad, baseProps())).not.toThrow();
    expect(count(win, "focus"), "a half-registered floor").toBe(0);
  });
});
