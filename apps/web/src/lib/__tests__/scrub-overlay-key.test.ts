// Lane-close re-review M-2: the OBS overlay's realtime key rides its URL (`/overlay/fixtures/{id}?…&key=…`, RT) and the
// overlay's token request (`/realtime-token?purpose=overlay&key=…`). The house scrubber (lib/scrub-score-url.ts) keeps
// URL-carried credentials out of telemetry — PostHog's `before_send` and Sentry's `beforeSend` both run it — but it only
// knew the device link's `/score/<token>`. An organiser who opens the OBS URL in a browser that accepted analytics would
// have sent a working key to PostHog as `$current_url`, and any error on the overlay to Sentry as its request URL.
//
// Every key here is minted by the REAL producer (`overlayKeyFor`), and every URL is built the way its producer builds it
// (the panel's OBS URL template, `realtimeTokenPath`), so a change to the key's shape moves these cases with it.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CaptureResult } from "posthog-js";
import type { Event } from "@sentry/nextjs";
import { overlayKeyFor } from "@/server/overlay/overlay-key";
import { OVERLAY_KEY_PARAM } from "@/lib/realtime-purpose";
import { OVERLAY_REALTIME_PURPOSE, realtimeTokenPath } from "@/components/public-site/live-score-data";
import { posthogBeforeSend, scrubScoreUrl, scrubSentryEvent } from "../scrub-score-url";

const FIXTURE = "0b6f2c1e-7a53-4c55-9d0e-2f1a3b4c5d6e";
const OTHER_FIXTURE = "9e8d7c6b-5a49-4838-8271-605f4e3d2c1b";
let KEY = "";
let OTHER_KEY = "";
/** The panel's own template (fixture-stream-panel.tsx, `overlayUrl`). */
const obsUrl = (fixtureId: string, key: string) =>
  `https://seazn.club/overlay/fixtures/${fixtureId}?style=broadcast&${OVERLAY_KEY_PARAM}=${encodeURIComponent(key)}`;

beforeEach(() => {
  vi.stubEnv("AUTH_SECRET", "m2-scrub-test-secret");
  KEY = overlayKeyFor(FIXTURE)!;
  OTHER_KEY = overlayKeyFor(OTHER_FIXTURE)!;
  expect(KEY, "premise: the producer mints a key").toMatch(/^[A-Za-z0-9_-]+$/);
  expect(OTHER_KEY).not.toBe(KEY);
});
afterEach(() => vi.unstubAllEnvs());

/** No trace of either key, anywhere in the serialised value. */
function expectNoKey(value: unknown): void {
  const text = JSON.stringify(value);
  expect(text).not.toContain(KEY);
  expect(text).not.toContain(OTHER_KEY);
}

describe("the overlay key never reaches telemetry (M-2)", () => {
  it("the PostHog hook: a $pageview of the OBS URL keeps its path and style, and loses the key", () => {
    const url = obsUrl(FIXTURE, KEY);
    const event: CaptureResult = {
      uuid: "0192-uuid",
      event: "$pageview",
      properties: {
        token: "phc_project_key",
        $current_url: url,
        $pathname: `/overlay/fixtures/${FIXTURE}`,
        $referrer: obsUrl(OTHER_FIXTURE, OTHER_KEY),
        $initial_current_url: url,
        $session_entry_url: url,
        $elements: [{ tag_name: "a", attr__href: `/overlay/fixtures/${FIXTURE}?${OVERLAY_KEY_PARAM}=${KEY}` }],
      },
      $set_once: { $initial_current_url: url },
      $set: { $current_url: url },
    };
    const out = posthogBeforeSend(event);
    expect(out, "an overlay page is not a staff page: the event is kept").not.toBeNull();
    expectNoKey(out);
    expect(out!.properties.$current_url).toBe(`https://seazn.club/overlay/fixtures/${FIXTURE}?style=broadcast&key=[key]`);
    expect(out!.properties.$pathname, "a path with no key is left alone").toBe(`/overlay/fixtures/${FIXTURE}`);
    expect(out!.properties.$elements[0].attr__href).toBe(`/overlay/fixtures/${FIXTURE}?key=[key]`);
    expect(out!.$set_once?.$initial_current_url).toBe(`https://seazn.club/overlay/fixtures/${FIXTURE}?style=broadcast&key=[key]`);
    expect(out!.properties.token, "the project token is not a query param and is left alone").toBe("phc_project_key");
  });

  it("the Sentry hook: request URL and query string, the token request's breadcrumb and span, and the transaction", () => {
    const tokenRequest = `https://seazn.club${realtimeTokenPath(FIXTURE, OVERLAY_REALTIME_PURPOSE, KEY)}`;
    expect(tokenRequest, "premise: the producer puts the key in the token request").toContain(KEY);
    const event: Event = {
      event_id: "e1",
      transaction: `GET /overlay/fixtures/${FIXTURE}?${OVERLAY_KEY_PARAM}=${KEY}`,
      request: {
        url: obsUrl(FIXTURE, KEY),
        query_string: `style=broadcast&${OVERLAY_KEY_PARAM}=${KEY}`,
        headers: { Referer: obsUrl(FIXTURE, KEY) },
      },
      breadcrumbs: [
        { category: "fetch", data: { url: tokenRequest, method: "GET", status_code: 200 } },
        { category: "navigation", data: { from: obsUrl(OTHER_FIXTURE, OTHER_KEY), to: obsUrl(FIXTURE, KEY) } },
      ],
      spans: [
        { span_id: "s1", trace_id: "t1", start_timestamp: 1, description: `GET ${tokenRequest}`, data: { "http.url": tokenRequest } },
      ],
    };
    const out = scrubSentryEvent(event);
    expectNoKey(out);
    expect(out.request?.url).toBe(`https://seazn.club/overlay/fixtures/${FIXTURE}?style=broadcast&key=[key]`);
    expect(out.request?.query_string, "Sentry's query string has no path, and is still scrubbed").toBe("style=broadcast&key=[key]");
    expect(out.breadcrumbs?.[0]?.data?.url, "the declared purpose is not a secret and stays").toBe(
      `https://seazn.club/api/v1/public/fixtures/${FIXTURE}/realtime-token?purpose=overlay&key=[key]`,
    );
  });

  it("every place a key can sit in a query string, plain and URL-encoded — and nothing that only looks like one", () => {
    const scrubbed: [string, string][] = [
      [`/overlay/fixtures/${FIXTURE}?${OVERLAY_KEY_PARAM}=${KEY}`, `/overlay/fixtures/${FIXTURE}?key=[key]`],
      [`/overlay/fixtures/${FIXTURE}?style=a&key=${KEY}&lang=es`, `/overlay/fixtures/${FIXTURE}?style=a&key=[key]&lang=es`],
      [`/overlay/fixtures/${FIXTURE}?key=${KEY}#top`, `/overlay/fixtures/${FIXTURE}?key=[key]#top`],
      [`key=${KEY}`, "key=[key]"],
      [`style=a&key=${KEY}`, "style=a&key=[key]"],
      [`opened "https://seazn.club/overlay/fixtures/${FIXTURE}?key=${KEY}" in OBS`, `opened "https://seazn.club/overlay/fixtures/${FIXTURE}?key=[key]" in OBS`],
      [`/login?next=%2Foverlay%2Ffixtures%2F${FIXTURE}%3Fkey%3D${KEY}`, `/login?next=%2Foverlay%2Ffixtures%2F${FIXTURE}%3Fkey%3D[key]`],
      [`/login?next=%2Foverlay%2Ffixtures%2F${FIXTURE}%3Fstyle%3Da%26key%3D${KEY}%26lang%3Des`, `/login?next=%2Foverlay%2Ffixtures%2F${FIXTURE}%3Fstyle%3Da%26key%3D[key]%26lang%3Des`],
      [`/r?u=%252Foverlay%253Fkey%253D${KEY}`, "/r?u=%252Foverlay%253Fkey%253D[key]"],
    ];
    const untouched = [
      `/overlay/fixtures/${FIXTURE}?style=broadcast`,
      "/games?monkey=banana",
      "/api?apikey=abc&keyboard=1&keys=2",
      "/settings?key_hint=x",
      "a key= with a space before it is prose",
      `/overlay/fixtures/${FIXTURE}?key=`,
    ];
    let checked = 0;
    for (const [input, want] of scrubbed) {
      expect(scrubScoreUrl(input), input).toBe(want);
      checked++;
    }
    for (const input of untouched) {
      expect(scrubScoreUrl(input), input).toBe(input);
      checked++;
    }
    expect(checked).toBe(scrubbed.length + untouched.length);
    expect(checked).toBeGreaterThan(10);
  });
});
