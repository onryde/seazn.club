// R2005 review round 1, item 1: the compositor's relay PAGE token rides a URL the way the overlay key does. The composed
// session's `overlayUrl` (`/overlay/fixtures/{id}?sid=…&st=…&host=compositor…`, stream-sessions.ts) carries it, and the
// relay page's live-data poll (`/api/v1/public/fixtures/{id}/overlay?sid=…&st=…`, `overlayPollPath`) sends it again
// every STREAM_POLL_MS. `st` is a live credential — a `relay-page` token opens a NON-public fixture's overlay until its
// session ends — so every `st=` QUERY PARAMETER value becomes `[st]`, plain or URL-encoded, exactly as `key=` does.
// `sid` is a session id, not a secret, and stays.
//
// Every token here is minted by the REAL producer (`mintRelayToken`, scope `relay-page`) and the poll URL is built by
// its real producer (`overlayPollPath`), so a change to the token's shape or the poll's parameters moves these cases.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CaptureResult } from "posthog-js";
import type { Event } from "@sentry/nextjs";
import { mintRelayToken } from "@/server/relay/tokens";
import { overlayPollPath } from "@/components/public-site/live-score-data";
import { posthogBeforeSend, scrubScoreUrl, scrubSentryEvent } from "../scrub-score-url";

const FIXTURE = "0b6f2c1e-7a53-4c55-9d0e-2f1a3b4c5d6e";
const SID = "5d0c8a9e-1b2f-4c3d-8e7f-6a5b4c3d2e1f";
const OTHER_SID = "7e6d5c4b-3a29-4817-a605-f4e3d2c1b0a9";
let ST = "";
let OTHER_ST = "";

/** The composed session's page URL, as `stream-sessions.ts` builds it (`new URLSearchParams({ sid, st, host, … })`). */
const pageUrl = (sid: string, st: string) =>
  `https://seazn.club/overlay/fixtures/${FIXTURE}?${new URLSearchParams({ sid, st, host: "compositor", delay: "3000", template: "bar" }).toString()}`;

beforeEach(async () => {
  vi.stubEnv("AUTH_SECRET", "r2005-scrub-st-test-secret");
  const expiresAt = new Date(Date.now() + 60 * 60_000);
  ST = await mintRelayToken({ sid: SID, scope: "relay-page", expiresAt });
  OTHER_ST = await mintRelayToken({ sid: OTHER_SID, scope: "relay-page", expiresAt });
  // A JWT: three base64url segments joined by dots — URL-safe, so the producers carry it unencoded.
  expect(ST, "premise: the producer mints a compact JWT").toMatch(/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
  expect(OTHER_ST).not.toBe(ST);
});
afterEach(() => vi.unstubAllEnvs());

/** No trace of either token, anywhere in the serialised value. */
function expectNoToken(value: unknown): void {
  const text = JSON.stringify(value);
  expect(text).not.toContain(ST);
  expect(text).not.toContain(OTHER_ST);
  // Each segment on its own too: a scrub that cut at the first `.` would leave the signature behind.
  for (const part of [...ST.split("."), ...OTHER_ST.split(".")]) expect(text).not.toContain(part);
}

describe("the relay page token never reaches telemetry (R2005 review item 1)", () => {
  it("the Sentry hook: the 5 s poll's breadcrumb, span and transaction, and the page's own request", () => {
    const poll = `https://seazn.club${overlayPollPath(FIXTURE, { sid: SID, st: ST })}`;
    expect(poll, "premise: the poll carries the token").toContain(ST);
    expect(poll, "premise: the poll carries the session id").toContain(`sid=${SID}`);
    const event: Event = {
      event_id: "e1",
      transaction: `GET /api/v1/public/fixtures/${FIXTURE}/overlay?sid=${SID}&st=${ST}`,
      request: {
        url: pageUrl(SID, ST),
        query_string: `sid=${SID}&st=${ST}&host=compositor`,
        headers: { Referer: pageUrl(OTHER_SID, OTHER_ST) },
      },
      breadcrumbs: [
        { category: "fetch", data: { url: poll, method: "GET", status_code: 200 } },
        { category: "navigation", data: { from: pageUrl(OTHER_SID, OTHER_ST), to: pageUrl(SID, ST) } },
      ],
      spans: [{ span_id: "s1", trace_id: "t1", start_timestamp: 1, description: `GET ${poll}`, data: { "http.url": poll } }],
    };
    const out = scrubSentryEvent(event);
    expectNoToken(out);
    expect(out.breadcrumbs?.[0]?.data?.url, "the session id is not a secret and stays").toBe(
      `https://seazn.club/api/v1/public/fixtures/${FIXTURE}/overlay?sid=${SID}&st=[st]`,
    );
    expect(out.request?.url).toBe(`https://seazn.club/overlay/fixtures/${FIXTURE}?sid=${SID}&st=[st]&host=compositor&delay=3000&template=bar`);
    expect(out.request?.query_string, "Sentry's query string has no `?`, and is still scrubbed").toBe(`sid=${SID}&st=[st]&host=compositor`);
    expect(out.transaction).toBe(`GET /api/v1/public/fixtures/${FIXTURE}/overlay?sid=${SID}&st=[st]`);
    expect(out.spans?.[0]?.data?.["http.url"]).toBe(`https://seazn.club/api/v1/public/fixtures/${FIXTURE}/overlay?sid=${SID}&st=[st]`);
  });

  it("the PostHog hook: a $pageview of the page URL keeps its path and parameters, and loses the token", () => {
    const url = pageUrl(SID, ST);
    const event: CaptureResult = {
      uuid: "0192-uuid",
      event: "$pageview",
      properties: { $current_url: url, $pathname: `/overlay/fixtures/${FIXTURE}`, $initial_current_url: url },
      $set_once: { $initial_current_url: url },
    };
    const out = posthogBeforeSend(event);
    expect(out, "an overlay page is not a staff page: the event is kept").not.toBeNull();
    expectNoToken(out);
    expect(out!.properties.$current_url).toBe(`https://seazn.club/overlay/fixtures/${FIXTURE}?sid=${SID}&st=[st]&host=compositor&delay=3000&template=bar`);
    expect(out!.properties.$pathname).toBe(`/overlay/fixtures/${FIXTURE}`);
  });

  it("every place an st can sit in a query string, plain and URL-encoded — and nothing that only looks like one", () => {
    const scrubbed: [string, string][] = [
      [`/overlay/fixtures/${FIXTURE}?st=${ST}`, `/overlay/fixtures/${FIXTURE}?st=[st]`],
      [`/overlay/fixtures/${FIXTURE}?sid=${SID}&st=${ST}&host=compositor`, `/overlay/fixtures/${FIXTURE}?sid=${SID}&st=[st]&host=compositor`],
      [`/overlay/fixtures/${FIXTURE}?st=${ST}#top`, `/overlay/fixtures/${FIXTURE}?st=[st]#top`],
      [`st=${ST}`, "st=[st]"],
      [`sid=${SID}&st=${ST}`, `sid=${SID}&st=[st]`],
      [`loaded "https://seazn.club/overlay/fixtures/${FIXTURE}?st=${ST}" in CEF`, `loaded "https://seazn.club/overlay/fixtures/${FIXTURE}?st=[st]" in CEF`],
      [`/login?next=%2Foverlay%2Ffixtures%2F${FIXTURE}%3Fst%3D${ST}`, `/login?next=%2Foverlay%2Ffixtures%2F${FIXTURE}%3Fst%3D[st]`],
      [`/login?next=%2Foverlay%2Ffixtures%2F${FIXTURE}%3Fsid%3D${SID}%26st%3D${ST}%26host%3Dcompositor`, `/login?next=%2Foverlay%2Ffixtures%2F${FIXTURE}%3Fsid%3D${SID}%26st%3D[st]%26host%3Dcompositor`],
      [`/r?u=%252Foverlay%253Fst%253D${ST}`, "/r?u=%252Foverlay%253Fst%253D[st]"],
      [`/r?u=%2foverlay%3fst%3d${ST}`, "/r?u=%2foverlay%3fst%3d[st]"],
    ];
    const untouched = [
      `/overlay/fixtures/${FIXTURE}?sid=${SID}&host=compositor`,
      "/games?first=1&last=2",
      "/api?test=abc&st_hint=x&sts=2&best=3",
      "a st= with a space before it is prose",
      `/overlay/fixtures/${FIXTURE}?st=`,
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
