// Task 22 review I2: Bunny's CDN token (probe B5) rides the URL PATH, not a query:
// `https://{cdn}/bcdn_token=<t>&expires=<e>&token_path=%2F{guid}%2F/{guid}/play_{h}p.mp4`. The server SDK's fetch
// instrumentation drops only a URL's query and fragment, so the token reaches an outgoing request's breadcrumb (`data.url`)
// and its span (`url.full`, the description). Every Sentry string loses the value after `bcdn_token=`; `expires`,
// `token_path` and the file name stay, since none of them signs anything.
//
// The URL comes from the REAL producer (BunnyReplayHost.openDownload, through a mocked fetch), so a change to its shape moves
// these cases, and the events go through the two hooks sentry.server.config.ts installs (`scrubSentryEvent` for errors,
// `sentryBeforeSendTransaction` for transactions).
import { describe, expect, it } from "vitest";
import type { Event } from "@sentry/nextjs";
import { bunnyResolutionsBody } from "@/server/video/__tests__/_bunny-resolutions";
import { BunnyReplayHost } from "@/server/video/replay-bunny";
import { holdsCredential, scrubScoreUrl, scrubSentryEvent } from "../scrub-score-url";
import { sentryBeforeSendTransaction } from "../sentry-transactions";

const GUID = "3f1c2a9e-0b7d-4c55-9a61-2d8e4f7b1c03";
const CDN = "vz-test0001.b-cdn.net";

/** The CDN URL `openDownload` fetches, captured at the mocked fetch, and the token inside it. */
async function producedUrl(): Promise<{ url: string; token: string }> {
  let url = "";
  const fetchImpl = (async (u: string | URL | Request) => {
    const s = String(u);
    if (s.endsWith("/resolutions")) {
      return new Response(JSON.stringify(bunnyResolutionsBody({ guid: GUID, mp4: [240, 720] })), { status: 200 });
    }
    if (s.startsWith("https://video.bunnycdn.com/")) {
      return new Response(JSON.stringify({ guid: GUID, status: 4, length: 60, availableResolutions: "240p,720p" }), { status: 200 });
    }
    url = s;
    return new Response("mp4", { status: 200 });
  }) as typeof fetch;
  const host = new BunnyReplayHost(
    { libraryId: "424242", apiKey: "scrub-test-api-key", readOnlyKey: "scrub-test-readonly", cdnHost: CDN, tokenKey: "scrub-test-token-key" },
    { fetchImpl, now: () => new Date("2026-11-21T10:00:00.000Z"), videoOrigins: () => ["stg.seazn.club"] },
  );
  await host.openDownload(GUID);
  const token = /\/bcdn_token=([^&/]+)&/.exec(url)?.[1] ?? "";
  // Premise: the producer's URL has the B5 shape, and its token is a base64url sha256 (43 characters, no padding).
  expect(url, "premise: the B5 shape").toMatch(new RegExp(`^https://${CDN.replace(/\./g, "\\.")}/bcdn_token=[A-Za-z0-9_-]{43}&expires=\\d+&token_path=%2F${GUID}%2F/${GUID}/play_720p\\.mp4$`));
  expect(token).toHaveLength(43);
  return { url, token };
}

describe("Bunny's CDN token never reaches Sentry (Task 22 review I2)", () => {
  it("scrubScoreUrl replaces the token and keeps every other part of the URL", async () => {
    const { url, token } = await producedUrl();
    const scrubbed = scrubScoreUrl(url);
    expect(scrubbed).toBe(url.replace(token, "[token]"));
    expect(scrubbed).not.toContain(token);
    expect(scrubbed).toMatch(/\/bcdn_token=\[token\]&expires=\d+&token_path=/);
    expect(holdsCredential(url)).toBe(true);
    // The negative twin: a CDN file URL with no token holds nothing to scrub.
    const bare = `https://${CDN}/${GUID}/play_720p.mp4`;
    expect(scrubScoreUrl(bare)).toBe(bare);
  });

  it("an error event: the outgoing fetch's breadcrumb loses the token", async () => {
    const { url, token } = await producedUrl();
    const event: Event = {
      event_id: "e1",
      breadcrumbs: [{ category: "fetch", type: "http", data: { method: "GET", url, status_code: 403 } }],
      exception: { values: [{ type: "Error", value: `CDN said no to ${url}` }] },
    };
    const sent = JSON.stringify(scrubSentryEvent(event));
    expect(sent).not.toContain(token);
    expect(sent).toContain(`${CDN}/bcdn_token=[token]&expires=`);
    expect(sent).toContain(`/${GUID}/play_720p.mp4`);
  });

  it("a transaction: the http.client span's url and description and the trace data lose the token", async () => {
    const { url, token } = await producedUrl();
    const event: Event = {
      event_id: "t1",
      type: "transaction",
      transaction: "GET /api/v1/fixtures/[id]/replays/[replayId]/download",
      contexts: { trace: { trace_id: "a".repeat(32), span_id: "b".repeat(16), data: { "url.full": url } } },
      spans: [{
        span_id: "c".repeat(16), trace_id: "a".repeat(32), start_timestamp: 1, timestamp: 2, op: "http.client",
        description: `GET ${url}`, data: { "url.full": url, "http.url": url, "server.address": CDN },
      }],
    };
    const out = sentryBeforeSendTransaction(event);
    expect(out, "a download transaction is not a health check: it is sent").not.toBeNull();
    const sent = JSON.stringify(out);
    expect(sent).not.toContain(token);
    expect(sent.match(/bcdn_token=\[token\]/g)).toHaveLength(4); // trace data, the span's description, url.full, http.url
  });
});
