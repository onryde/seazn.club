// Final review I2: a device link's secret IS its URL (`/score/<token>`), and it
// is now long-lived, re-showable and printed on paper. Every telemetry surface
// that records a URL (PostHog's pageview/pageleave properties, Sentry's error
// and transaction events, breadcrumbs, the replay's own URL list and its
// recording) would otherwise carry a working scoring credential off the court.
// One helper scrubs it; these tests pin it on the shapes each SDK really sends.
import { describe, expect, it } from "vitest";
import type { CaptureResult } from "posthog-js";
import type { Event } from "@sentry/nextjs";
import {
  posthogBeforeSend,
  scrubRecordingEvent,
  scrubScoreTokens,
  scrubScoreUrl,
  scrubSentryEvent,
} from "../scrub-score-url";

/** The real shape: `dl_` + 32 random bytes as base64url (device-links.ts). */
const TOKEN = "dl_Q2hvb3NlIGEgcmVhbGx5IGxvbmcgcmFuZG9tIHRva2Vu_Ab-9";
const OTHER = "dl_ZmVlZGJhY2sgZnJvbSBhIHNlY29uZCBwaG9uZSBoZXJlXw-_x";
const PAGE = `https://seazn.club/score/${TOKEN}`;

/** No trace of either secret, anywhere in the serialised value. */
function expectNoToken(value: unknown): void {
  const text = JSON.stringify(value);
  expect(text).not.toContain(TOKEN);
  expect(text).not.toContain(OTHER);
  expect(text).not.toMatch(/\/score\/dl_/);
}

describe("scrubScoreUrl", () => {
  it.each([
    ["a full URL", PAGE, "https://seazn.club/score/[token]"],
    ["a bare path", `/score/${TOKEN}`, "/score/[token]"],
    ["a trailing slash", `/score/${TOKEN}/`, "/score/[token]/"],
    ["a query", `/score/${TOKEN}?from=sheet`, "/score/[token]?from=sheet"],
    ["a hash", `/score/${TOKEN}#pad`, "/score/[token]#pad"],
    ["two occurrences", `from /score/${TOKEN} to /score/${OTHER}`, "from /score/[token] to /score/[token]"],
    ["a quoted URL in a message", `GET "/score/${TOKEN}" failed`, 'GET "/score/[token]" failed'],
  ])("%s", (_, input, expected) => {
    expect(scrubScoreUrl(input)).toBe(expected);
  });

  it.each([
    ["no /score at all", "https://seazn.club/o/club/c/cup/schedule?day=2026-09-26"],
    ["a longer segment that only starts with score", "/scoreboard/abc"],
    ["the bare route", "/score"],
    ["the route with nothing after it", "/score/"],
    ["an already-scrubbed URL", "https://seazn.club/score/[token]"],
  ])("leaves %s untouched", (_, input) => {
    expect(scrubScoreUrl(input)).toBe(input);
  });

  it("scrubs a bare bearer token too (an Authorization header on a server event)", () => {
    expect(scrubScoreUrl(`Bearer ${TOKEN}`)).toBe("Bearer dl_[token]");
  });
});

describe("scrubScoreUrl — encoded and glued forms (fix batch 2, item 2)", () => {
  // A URL travels ENCODED inside another URL's query (a login `next=`, a
  // referrer carried as a param), and a secret can sit glued to a word
  // character (`x_dl_…`). `\bdl_` saw neither: there is no word boundary
  // between `F` and `d`, or between `_` and `d`.
  const IN_QUERY = `https://seazn.club/login?next=https%3A%2F%2Fseazn.club%2Fscore%2F${TOKEN}`;

  it.each([
    ["an encoded absolute URL in a query param", IN_QUERY, "https://seazn.club/login?next=https%3A%2F%2Fseazn.club%2Fscore%2F[token]"],
    [
      "an encoded URL with its own encoded query, then another param",
      `/login?next=%2Fscore%2F${TOKEN}%3Ffrom%3Dsheet&lang=fr`,
      "/login?next=%2Fscore%2F[token]%3Ffrom%3Dsheet&lang=fr",
    ],
    ["lower-case percent hex", `?next=%2fscore%2f${TOKEN}`, "?next=%2fscore%2f[token]"],
    [
      "a double-encoded URL",
      `?r=https%253A%252F%252Fseazn.club%252Fscore%252F${TOKEN}`,
      "?r=https%253A%252F%252Fseazn.club%252Fscore%252F[token]",
    ],
    // Three deep (a redirect's `next` carried inside another's): "ANY depth"
    // is `(?:25)*`, and double-encoding alone cannot tell it from `(?:25)?`.
    [
      "a triple-encoded URL",
      `?r=https%25253A%25252F%25252Fseazn.club%25252Fscore%25252F${TOKEN}`,
      "?r=https%25253A%25252F%25252Fseazn.club%25252Fscore%25252F[token]",
    ],
    // The encoded PATH form scrubs any segment, like `/score/<x>` does: the
    // route is the secret's only home, whatever the token looks like.
    ["an encoded path whose token is not dl_-shaped", "?next=%2Fscore%2Fabc123&x=1", "?next=%2Fscore%2F[token]&x=1"],
    // No `dl_` in these three, so only the encoded-path pattern (and its
    // pre-check) can catch them.
    ["the same, lower-case hex", "?next=%2fscore%2fabc123", "?next=%2fscore%2f[token]"],
    ["the same, double-encoded", "?r=%252Fscore%252Fabc123", "?r=%252Fscore%252F[token]"],
    ["the same, triple-encoded", "?r=%25252Fscore%25252Fabc123", "?r=%25252Fscore%25252F[token]"],
    ["a secret glued to a word character", `session_${TOKEN}`, "session_dl_[token]"],
    ["a secret glued to a digit", `9${TOKEN}`, "9dl_[token]"],
  ])("%s", (_, input, expected) => {
    expect(scrubScoreUrl(input)).toBe(expected);
    expectNoToken(scrubScoreUrl(input));
  });

  it.each([
    ["a short dl_ word", "dl_x"],
    ["a snake_case name holding dl_", "model_dl_config"],
    ["a word ending in dl_", "handl_request_body"],
    ["31 token characters: one short of a secret", `dl_${"A".repeat(31)}`],
    ["an encoded /scoreboard path", "?next=%2Fscoreboard%2Fabc"],
    ["an encoded /score/ with nothing after it", "?next=%2Fscore%2F&x=1"],
    ["an encoded, already-scrubbed URL", "?next=%2Fscore%2F%5Btoken%5D"],
  ])("leaves %s untouched", (_, input) => {
    expect(scrubScoreUrl(input)).toBe(input);
  });

  it("scrubs 32 token characters (the guard's exact floor)", () => {
    expect(scrubScoreUrl(`x_dl_${"A".repeat(32)}`)).toBe("x_dl_[token]");
  });

  it("the PostHog hook scrubs an encoded token out of a pageview's URL properties", () => {
    const out = posthogBeforeSend({
      uuid: "u1",
      event: "$pageview",
      properties: { $current_url: IN_QUERY, $pathname: "/login", $referrer: IN_QUERY },
    } as unknown as CaptureResult);
    expectNoToken(out);
    expect(out?.properties.$pathname).toBe("/login");
  });
});

describe("scrubScoreTokens (deep)", () => {
  it("scrubs every string in nested objects and arrays, and leaves everything else as it was", () => {
    const when = new Date("2026-09-26T09:00:00Z");
    const input = { a: PAGE, n: 3, ok: true, none: null, at: when, list: [PAGE, { deep: `/score/${OTHER}` }] };
    const out = scrubScoreTokens(input);
    expectNoToken(out);
    expect(out).toEqual({
      a: "https://seazn.club/score/[token]",
      n: 3,
      ok: true,
      none: null,
      at: when,
      list: ["https://seazn.club/score/[token]", { deep: "/score/[token]" }],
    });
    expect(out.at, "a Date is not a plain object: passed through, not rebuilt").toBe(when);
    expect(input.a, "the input is not mutated").toBe(PAGE);
  });
});

describe("posthogBeforeSend", () => {
  // A real `$pageview` as posthog-js 1.399 builds it (properties trimmed to the
  // URL-bearing ones and a couple that must survive untouched).
  const pageview = (): CaptureResult => ({
    uuid: "0192-uuid",
    event: "$pageview",
    properties: {
      token: "phc_project_key",
      distinct_id: "anon-1",
      $current_url: `${PAGE}?from=sheet`,
      $host: "seazn.club",
      $pathname: `/score/${TOKEN}`,
      $referrer: `https://seazn.club/score/${OTHER}`,
      $referring_domain: "seazn.club",
      $initial_current_url: PAGE,
      $prev_pageview_pathname: `/score/${OTHER}`,
      $session_entry_url: PAGE,
      $elements: [{ tag_name: "a", attr__href: `/score/${TOKEN}`, $el_text: "Open pad" }],
      $screen_height: 800,
    },
    $set_once: { $initial_current_url: PAGE, $initial_pathname: `/score/${TOKEN}` },
    $set: { $current_url: PAGE },
  });

  it("scrubs the token from every URL-valued property, person properties included", () => {
    const out = posthogBeforeSend(pageview());
    expect(out).not.toBeNull();
    expectNoToken(out);
    expect(out!.properties.$current_url).toBe("https://seazn.club/score/[token]?from=sheet");
    expect(out!.properties.$pathname).toBe("/score/[token]");
    expect(out!.$set_once?.$initial_pathname).toBe("/score/[token]");
  });

  it("keeps the event and every property that carries no token", () => {
    const out = posthogBeforeSend(pageview())!;
    expect(out.event).toBe("$pageview");
    expect(out.uuid).toBe("0192-uuid");
    expect(out.properties.token).toBe("phc_project_key");
    expect(out.properties.$host).toBe("seazn.club");
    expect(out.properties.$screen_height).toBe(800);
  });

  it("passes a dropped event (null) through as dropped", () => {
    expect(posthogBeforeSend(null)).toBeNull();
  });
});

// Fix batch item 7 (owner-approved 2026-09-25): staff pages send nothing from
// the browser. The route is app/admin at the top level (not under [lang]), so
// the rule is exact: "/admin" itself or anything under "/admin/". posthog-js
// stamps $pathname on every event it builds, so this also covers pageleave,
// autocapture, and cookie-consent's manual $pageview.
describe("posthogBeforeSend drops staff (/admin) pages (fix batch 7)", () => {
  const on = (pathname: string, event = "$pageview"): CaptureResult => ({
    uuid: "u",
    event,
    properties: { $pathname: pathname, $current_url: `https://seazn.club${pathname}` },
  });

  it.each([
    ["/admin", "$pageview"],
    ["/admin/", "$pageview"],
    ["/admin/orgs/x", "$pageview"],
    ["/admin/orgs/x", "$pageleave"],
    ["/admin/users/y", "$autocapture"],
    ["/admin/revenue", "pricing_viewed"],
  ])("drops %s (%s)", (pathname, event) => {
    expect(posthogBeforeSend(on(pathname, event))).toBeNull();
  });

  it.each([
    ["/administrator"],
    ["/administrators/list"],
    ["/o/admin-club"],
    ["/fr/admin-x"],
    ["/"],
  ])("keeps %s", (pathname) => {
    const out = posthogBeforeSend(on(pathname));
    expect(out).not.toBeNull();
    expect(out!.properties.$pathname).toBe(pathname);
  });

  it("keeps a scan page, and scrubs its token", () => {
    const out = posthogBeforeSend(on(`/score/${TOKEN}`));
    expect(out).not.toBeNull();
    expect(out!.properties.$pathname).toBe("/score/[token]");
    expectNoToken(out);
  });

  it("an event with no $pathname is kept (nothing says it is a staff page)", () => {
    const out = posthogBeforeSend({ uuid: "u", event: "custom", properties: { a: 1 } });
    expect(out?.properties).toEqual({ a: 1 });
  });
});

describe("scrubSentryEvent", () => {
  it("an error event: request URL, transaction, breadcrumbs, tags and stack frames", () => {
    const event: Event = {
      event_id: "e1",
      transaction: `/score/${TOKEN}`,
      request: { url: PAGE, headers: { Referer: PAGE, authorization: `Bearer ${TOKEN}` } },
      tags: { url: PAGE, route: "/score/[token]" },
      breadcrumbs: [
        { category: "navigation", data: { from: `/score/${OTHER}`, to: `/score/${TOKEN}` } },
        { category: "fetch", data: { url: `/api/v1/fixtures/f1/state`, method: "GET" } },
        { category: "console", message: `opened ${PAGE}` },
      ],
      exception: {
        values: [
          {
            type: "Error",
            value: "boom",
            stacktrace: { frames: [{ filename: PAGE, abs_path: PAGE, function: "onTap" }] },
          },
        ],
      },
    };
    const out = scrubSentryEvent(event);
    expect(out).not.toBeNull();
    expectNoToken(out);
    expect(out!.request?.url).toBe("https://seazn.club/score/[token]");
    expect(out!.transaction).toBe("/score/[token]");
    expect(out!.breadcrumbs?.[1]?.data?.url, "a URL with no token is left alone").toBe("/api/v1/fixtures/f1/state");
  });

  it("a transaction event: its spans' descriptions and URL attributes", () => {
    const event: Event = {
      type: "transaction",
      transaction: `/score/${TOKEN}`,
      spans: [
        {
          span_id: "s1",
          trace_id: "t1",
          start_timestamp: 1,
          description: `GET ${PAGE}`,
          data: { "http.url": PAGE, "url.full": PAGE },
        },
      ],
    };
    const out = scrubSentryEvent(event);
    expectNoToken(out);
    expect(out!.spans?.[0]?.description).toBe("GET https://seazn.club/score/[token]");
  });

  it("a replay event: its URL list", () => {
    const event = { type: "replay_event", replay_id: "r1", urls: [PAGE, "https://seazn.club/"] } as unknown as Event;
    const out = scrubSentryEvent(event) as unknown as { urls: string[] };
    expect(out.urls).toEqual(["https://seazn.club/score/[token]", "https://seazn.club/"]);
  });
});

// Capture QR v2 §10.2 (A18, FP18): a phone route's code is half its credential and its Bearer the other half; the beat
// body names the code again. A capture route's event loses all three. Every other event keeps its URL and body.
describe("scrubSentryEvent — the capture phone routes (A18)", () => {
  /** A real-shaped code (CAPTURE_CODE_RE) and tok (16 random bytes, base64url). */
  const CODE = "k3m9p2q7r4t8";
  const TOK = "Zm9vYmFyYmF6cXV4cXV1eA";
  const captureEvent = (path: string, headerName = "authorization"): Event => ({
    event_id: "c1",
    transaction: `POST /api/v1/capture/codes/${CODE}${path}`,
    request: {
      method: "POST",
      url: `https://seazn.club/api/v1/capture/codes/${CODE}${path}`,
      headers: { [headerName]: `Bearer ${TOK}`, "content-type": "application/json" },
      data: JSON.stringify({ code: CODE, phone: "phone-x-0123456789" }),
    },
    breadcrumbs: [{ category: "fetch", data: { url: `/api/v1/capture/codes/${CODE}/start` } }],
  });

  it("each phone route (GET, beats, start), either header case: the code in every string, the Bearer and the request body are gone", () => {
    let checked = 0;
    for (const path of ["", "/beats", "/start"]) {
      for (const headerName of ["authorization", "Authorization"]) {
        const out = scrubSentryEvent(captureEvent(path, headerName));
        const text = JSON.stringify(out);
        expect(text, `${path} ${headerName}`).not.toContain(CODE);
        expect(text).not.toContain(TOK);
        expect(out.request?.url).toBe(`https://seazn.club/api/v1/capture/codes/[code]${path}`);
        expect(out.transaction).toBe(`POST /api/v1/capture/codes/[code]${path}`);
        expect(out.request?.headers?.[headerName]).toBe("Bearer [tok]");
        expect(out.request?.headers?.["content-type"], "other headers are kept").toBe("application/json");
        expect(Object.hasOwn(out.request!, "data"), "the body is dropped").toBe(false);
        checked++;
      }
    }
    expect(checked).toBe(6);
  });

  it("an event that names the route in its TRANSACTION alone (no request URL) is a capture event too: Bearer and body gone", () => {
    const event = captureEvent("/start");
    delete event.request!.url;
    const out = scrubSentryEvent(event);
    expect(out.request?.headers?.authorization).toBe("Bearer [tok]");
    expect(Object.hasOwn(out.request!, "data")).toBe(false);
    expect(JSON.stringify(out)).not.toContain(TOK);
  });

  it("the input event is never mutated", () => {
    const event = captureEvent("/beats");
    const before = JSON.stringify(event);
    scrubSentryEvent(event);
    expect(JSON.stringify(event)).toBe(before);
  });

  it("the positive pair: a non-capture route keeps its URL, its headers and its body exactly", () => {
    const other: Event = {
      event_id: "o1",
      transaction: "POST /api/v1/fixtures/f1/stream-sessions",
      request: {
        method: "POST",
        url: "https://seazn.club/api/v1/fixtures/f1/stream-sessions",
        headers: { authorization: "Bearer sk_live_example", "content-type": "application/json" },
        data: JSON.stringify({ targetId: "t1" }),
      },
    };
    expect(scrubSentryEvent(other)).toEqual(other);
  });
});

describe("scrubRecordingEvent (Sentry Replay's beforeAddRecordingEvent)", () => {
  // Only CUSTOM frames (rrweb type 5) reach this hook: @sentry/replay 10.62
  // gates the callback on `isCustomEvent`. These are the two custom frames that
  // carry URLs.
  it("scrubs a navigation breadcrumb frame and a performance-span frame, and keeps them", () => {
    const crumb = {
      type: 5,
      timestamp: 2,
      data: { tag: "breadcrumb", payload: { category: "navigation", data: { from: `/score/${OTHER}`, to: `/score/${TOKEN}` } } },
    };
    const span = {
      type: 5,
      timestamp: 3,
      data: { tag: "performanceSpan", payload: { op: "navigation.push", description: PAGE, startTimestamp: 1, endTimestamp: 2 } },
    };
    const outCrumb = scrubRecordingEvent(crumb);
    const outSpan = scrubRecordingEvent(span);
    expectNoToken([outCrumb, outSpan]);
    expect(outCrumb.data.payload.data.to).toBe("/score/[token]");
    expect(outSpan.data.payload.description).toBe("https://seazn.club/score/[token]");
    expect(outSpan.data.payload.op, "the frame is kept, not dropped").toBe("navigation.push");
  });
});

describe("a Sentry log (beforeSendLog)", () => {
  // Next logs a failed RSC fetch with the page URL through console.error; the
  // console logging integration forwards it as a Sentry log.
  it("scrubs the message and URL attributes", () => {
    const log = {
      level: "error" as const,
      message: `Failed to fetch RSC payload for ${PAGE}?_rsc=1x2y. Falling back to browser navigation.`,
      attributes: { "url.path": `/score/${TOKEN}`, "sentry.origin": "auto.console.logging" },
    };
    const out = scrubScoreTokens(log);
    expectNoToken(out);
    expect(out.message).toBe(
      "Failed to fetch RSC payload for https://seazn.club/score/[token]?_rsc=1x2y. Falling back to browser navigation.",
    );
    expect(out.attributes["sentry.origin"]).toBe("auto.console.logging");
  });
});
