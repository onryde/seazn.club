// R16: exact hostname, https only. A prefix or substring test is not origin
// validation — this repo has already shipped `/\evil.com` as an open redirect
// off exactly that mistake, so the negative cases below are the point of the
// file and the positives exist only so a schema that rejected everything
// could not pass for a correct one.
import { describe, expect, it } from "vitest";
import { STREAM_HOSTS, isStreamUrl, streamUrlSchema } from "@/lib/stream-url";

const ACCEPTED = [
  "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
  "https://youtube.com/live/abc123",
  "https://youtu.be/abc123",
  // Owner answer 16 (Q5): "Agree". A club that copies the link out of the
  // YouTube phone app pastes this host, did nothing wrong, and was being told
  // its own link was invalid. A real YouTube host, so the widening is exact.
  "https://m.youtube.com/watch?v=abc123",
  "https://www.facebook.com/clubpage/videos/123",
  "https://facebook.com/clubpage/live",
  "https://fb.watch/aBc-1/",
  "https://www.twitch.tv/seaznclub",
  "https://twitch.tv/seaznclub",
  "https://kick.com/seaznclub",
  "https://www.kick.com/seaznclub",
];

const REJECTED: [string, string][] = [
  ["https://evil.example/www.youtube.com", "an allowed host in the PATH is not the host"],
  ["https://www.youtube.com.evil.example/", "an allowed host as a PREFIX of the host is not the host"],
  ["https://youtube.com.evil.example", "same, without the www"],
  ["https://notyoutube.com/x", "an allowed host as a SUFFIX of the host is not the host"],
  ["javascript:alert(1)", "not https"],
  ["http://www.youtube.com/x", "http is refused even on an allowed host"],
  // `m.youtube.com` is now ACCEPTED (owner answer 16 / Q5) and has moved to
  // the list above. Its LOOK-ALIKE stays rejected here, which is the pair that
  // proves the widening added one exact hostname rather than a `youtube.com`
  // suffix rule — delete this row and the widening is indistinguishable from
  // an `endsWith` that would also accept `m.youtube.com.evil.example`.
  ["https://m.youtube.com.evil.example/x", "the new host as a PREFIX of the host is still not the host"],
  ["https://mm.youtube.com/x", "a near-miss subdomain of an allowed host is not on the list"],
  [" https://youtube.com", "a leading space is not trimmed into validity"],
  ["https://user:pass@www.youtube.com/x", "credentials in the authority"],
  // Design §3.7 names two more attacks the EXACT comparison defeats (review
  // 2026-09-08 finding 38): a trailing dot (a different hostname to the
  // comparison, the same host to a resolver) and an IDN homograph (Cyrillic
  // `е` U+0435 for Latin `e` — `new URL()` punycodes it to `xn--…`, which is
  // not on the list).
  ["https://youtube.com./x", "a trailing dot is a different hostname"],
  ["https://youtubе.com/x", "an IDN homograph (Cyrillic е) punycodes to xn--… and is not on the list"],
  ["not a url at all", "unparseable"],
];

describe("STREAM_HOSTS", () => {
  it("is exactly the eleven hostnames — R16's ten plus m.youtube.com — and nothing else", () => {
    expect([...STREAM_HOSTS].sort()).toEqual([
      "facebook.com", "fb.watch", "kick.com", "m.youtube.com", "twitch.tv",
      "www.facebook.com", "www.kick.com", "www.twitch.tv", "www.youtube.com",
      "youtu.be", "youtube.com",
    ]);
  });
});

describe("streamUrlSchema", () => {
  it.each(ACCEPTED)("accepts %s and returns it unchanged", (url) => {
    expect(streamUrlSchema.parse(url)).toBe(url);
    expect(isStreamUrl(url)).toBe(true);
  });

  it.each(REJECTED)("rejects %s — %s", (url) => {
    expect(() => streamUrlSchema.parse(url)).toThrow();
    expect(isStreamUrl(url)).toBe(false);
  });

  it("clears the link on an empty string and passes null through", () => {
    expect(streamUrlSchema.parse("")).toBeNull();
    expect(streamUrlSchema.parse("   ")).toBeNull();
    expect(streamUrlSchema.parse(null)).toBeNull();
  });

  it("names the field in its issue so the panel can render an inline error", () => {
    const parsed = streamUrlSchema.safeParse("https://evil.example/www.youtube.com");
    expect(parsed.success).toBe(false);
    if (!parsed.success) expect(parsed.error.issues[0]!.code).toBe("custom");
  });
});
