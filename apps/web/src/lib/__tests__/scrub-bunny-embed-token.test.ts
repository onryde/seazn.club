// Task 25 (security): the replay host's player URL is a credential — `https://iframe.mediadelivery.net/embed/<library>/<video>
// ?token=<sha256 hex>&expires=<epoch s>` (plan B4) plays the video until it expires. The match page sets it on an <iframe>, so a
// session replay's NETWORK recording holds it (the frame's document request: maskCapturedNetworkRequest), and an error near the
// frame can quote it (Sentry). Every string loses the `token` AND the `expires` value of an embed URL on the host's embed path,
// plain or URL-encoded inside another URL; the host, the library, the video and every other parameter stay.
//
// The URL comes from the REAL producer (BunnyReplayHost.signedEmbed), so a change to its shape moves these cases. Each hook is
// the one the app installs: maskCapturedNetworkRequest and posthogBeforeSend (PostHog), scrubSentryEvent (Sentry), and
// holdsCredential (the replay guard).
import { describe, expect, it } from "vitest";
import type { Event } from "@sentry/nextjs";
import type { CaptureResult, CapturedNetworkRequest } from "posthog-js";
import { BUNNY_EMBED_HOST, BunnyReplayHost } from "@/server/video/replay-bunny";
import { holdsCredential, maskCapturedNetworkRequest, posthogBeforeSend, scrubScoreUrl, scrubSentryEvent } from "../scrub-score-url";

const GUID = "3f1c2a9e-0b7d-4c55-9a61-2d8e4f7b1c03";
const LIB = "424242";

/** The embed URL the real adapter signs, its token and its expiry. */
function produced(): { url: string; token: string; expires: string } {
  const host = new BunnyReplayHost(
    { libraryId: LIB, apiKey: "scrub-test-api-key", readOnlyKey: "scrub-test-readonly", cdnHost: "vz-test0001.b-cdn.net", tokenKey: "scrub-test-token-key" },
    { fetchImpl: (async () => new Response("{}")) as typeof fetch, now: () => new Date("2026-11-22T10:00:00.000Z"), videoOrigins: () => ["stg.seazn.club"] },
  );
  const { src } = host.signedEmbed(GUID, new Date("2026-11-22T10:00:00.000Z"), 3600);
  const m = /\?token=([0-9a-f]{64})&expires=(\d+)$/.exec(src);
  expect(src, "premise: the B4 shape").toMatch(new RegExp(`^https://${BUNNY_EMBED_HOST.replace(/\./g, "\\.")}/embed/${LIB}/${GUID}\\?token=[0-9a-f]{64}&expires=\\d+$`));
  return { url: src, token: m![1]!, expires: m![2]! };
}

describe("the replay host's embed URL never reaches telemetry (Task 25)", () => {
  it("scrubScoreUrl replaces the token and the expiry and keeps the host, library and video; holdsCredential says so", () => {
    const { url, token, expires } = produced();
    const scrubbed = scrubScoreUrl(url);
    expect(scrubbed).toBe(`https://${BUNNY_EMBED_HOST}/embed/${LIB}/${GUID}?token=[token]&expires=[expires]`);
    expect(scrubbed).not.toContain(token);
    expect(scrubbed).not.toContain(expires);
    expect(holdsCredential(url)).toBe(true);
  });

  it("the parameters in any order, with others beside them (kept), and a fragment after", () => {
    const { token, expires } = produced();
    const url = `https://${BUNNY_EMBED_HOST}/embed/${LIB}/${GUID}?autoplay=true&expires=${expires}&preload=false&token=${token}#t=10`;
    expect(scrubScoreUrl(url)).toBe(`https://${BUNNY_EMBED_HOST}/embed/${LIB}/${GUID}?autoplay=true&expires=[expires]&preload=false&token=[token]#t=10`);
  });

  it("URL-ENCODED inside another URL (a referrer or a next= carried as a parameter), at two depths, either hex case", () => {
    const { url, token, expires } = produced();
    const once = encodeURIComponent(url);
    const outer = `https://app.example/login?next=${once}&x=1`;
    const scrubbed = scrubScoreUrl(outer);
    expect(scrubbed).not.toContain(token);
    expect(scrubbed).not.toContain(expires);
    expect(scrubbed).toContain(`iframe.mediadelivery.net%2Fembed%2F${LIB}%2F${GUID}%3Ftoken%3D[token]%26expires%3D[expires]`);
    expect(scrubbed).toMatch(/&x=1$/);
    const twice = scrubScoreUrl(`https://app.example/?r=${encodeURIComponent(encodeURIComponent(url)).toLowerCase()}`);
    expect(twice).not.toContain(token);
    expect(twice).not.toContain(expires);
  });

  it("negative twins: an embed URL with no query, the host's other paths, and a `token=` on another host are left as they are", () => {
    const { token } = produced();
    let checked = 0;
    for (const bare of [
      `https://${BUNNY_EMBED_HOST}/embed/${LIB}/${GUID}`,
      `https://${BUNNY_EMBED_HOST}/play/${LIB}/${GUID}?autoplay=true`,
      `https://example.com/embed/${LIB}/${GUID}?token=${token}&expires=1`,
      `https://${BUNNY_EMBED_HOST}.other.example/embed/${LIB}/${GUID}?token=${token}`,
    ]) {
      expect(scrubScoreUrl(bare), bare).toBe(bare);
      checked++;
    }
    expect(checked).toBe(4);
  });

  it("PostHog: the frame's document request in a session replay's network recording loses the token (name and initiator kept)", () => {
    const { url, token } = produced();
    const request = { name: url, initiatorType: "iframe", method: "GET", status: 200 } as unknown as CapturedNetworkRequest;
    const masked = maskCapturedNetworkRequest(request);
    expect(JSON.stringify(masked)).not.toContain(token);
    expect((masked as unknown as { name: string }).name).toContain("token=[token]");
    expect((masked as unknown as { initiatorType: string }).initiatorType).toBe("iframe");
  });

  it("PostHog: an event's properties lose it too", () => {
    const { url, token } = produced();
    const event = { uuid: "u", event: "$exception", properties: { $pathname: "/live/a/b/c/fixtures/x", $exception_message: `frame failed: ${url}` } } as unknown as CaptureResult;
    const sent = JSON.stringify(posthogBeforeSend(event));
    expect(sent).not.toContain(token);
    expect(sent).toContain("token=[token]");
  });

  it("Sentry: an error's message and a breadcrumb lose it", () => {
    const { url, token, expires } = produced();
    const event: Event = {
      event_id: "e1",
      breadcrumbs: [{ category: "navigation", data: { from: "/live/x", to: url } }],
      exception: { values: [{ type: "Error", value: `embed refused ${url}` }] },
    };
    const sent = JSON.stringify(scrubSentryEvent(event));
    expect(sent).not.toContain(token);
    expect(sent).not.toContain(`expires=${expires}`);
    expect(sent.match(/token=\[token\]&expires=\[expires\]/g)).toHaveLength(2);
  });
});
