// Seazn-hosted video, Phase 1 Task 15 fix round 1: the pure half of the hls.js token refresh. The player keeps one loaded manifest and
// swaps the token segment into every later request (seazn-playback.ts); this file is the rewrite itself, with the address shapes
// `cf-playback.ts` builds (`https://<host>/<token>/manifest/video.m3u8`) and the playlist and segment paths hls.js resolves under it.
// Expected strings are typed from the ruling "the token is the first path segment of the playback host", never taken from the function.
import { describe, expect, it } from "vitest";
import { parseSignedAddress, withToken } from "../seazn-signed-address";

const HOST = "https://customer-q7x2k9m4.cloudflarestream.com";
const OLD = "eyJhbGciOiJSUzI1NiJ9.eyJzdWIiOiJ1aWQifQ.c2ln-_x";
const NEW = "eyJhbGciOiJSUzI1NiJ9.eyJzdWIiOiJ1aWQiLCJuIjoyfQ.bmV3-_y";
const held = { origin: HOST, token: NEW };

describe("parseSignedAddress", () => {
  it("splits the address Cloudflare signs: host, token (dots, dashes and underscores kept), and everything after it", () => {
    expect(parseSignedAddress(`${HOST}/${OLD}/manifest/video.m3u8`)).toEqual({ origin: HOST, token: OLD, tail: "/manifest/video.m3u8" });
    expect(parseSignedAddress(`${HOST}/${OLD}/manifest/video.m3u8?a=1#b`)).toEqual({ origin: HOST, token: OLD, tail: "/manifest/video.m3u8?a=1#b" });
  });

  it("an address that ends at the token has an empty tail; a query or fragment right after the token is the tail", () => {
    expect(parseSignedAddress(`${HOST}/${OLD}`)).toEqual({ origin: HOST, token: OLD, tail: "" });
    expect(parseSignedAddress(`${HOST}/${OLD}?x=1`)).toEqual({ origin: HOST, token: OLD, tail: "?x=1" });
    expect(parseSignedAddress(`${HOST}/${OLD}#x`)).toEqual({ origin: HOST, token: OLD, tail: "#x" });
  });

  it("EMPTY CASES: nothing, a bare host, an empty first segment, another scheme and a relative path are not signed addresses", () => {
    const refused = ["", HOST, `${HOST}/`, `${HOST}//manifest/video.m3u8`, `http://h.example/${OLD}/x`, `/${OLD}/manifest/video.m3u8`, "manifest/video.m3u8", "not an address"];
    let checked = 0;
    for (const input of refused) {
      expect(parseSignedAddress(input), JSON.stringify(input)).toBeNull();
      checked++;
    }
    expect(checked, "anti-vacuity").toBe(refused.length);
  });
});

describe("withToken: the request under the newest token", () => {
  // The shapes hls.js asks for under a manifest: the manifest itself, a rendition's playlist (with and without a query), a media
  // segment, an init segment and an audio segment. Each is written under the OLD token, as the loaded manifest resolved it.
  const shapes: [string, string, string][] = [
    ["manifest", "/manifest/video.m3u8", "/manifest/video.m3u8"],
    ["rendition playlist", "/manifest/stream_1/video.m3u8", "/manifest/stream_1/video.m3u8"],
    ["live playlist reload (query)", "/manifest/stream_1/video.m3u8?_HLS_msn=12&_HLS_part=0", "/manifest/stream_1/video.m3u8?_HLS_msn=12&_HLS_part=0"],
    ["video segment", "/video/stream_1/seg_12.ts", "/video/stream_1/seg_12.ts"],
    ["init segment", "/video/stream_1/init.mp4", "/video/stream_1/init.mp4"],
    ["audio segment (fragment)", "/audio/seg_12.m4s#t=0", "/audio/seg_12.m4s#t=0"],
  ];

  it.each(shapes)("%s: only the token segment changes", (_name, oldTail, newTail) => {
    expect(withToken(`${HOST}/${OLD}${oldTail}`, held)).toBe(`${HOST}/${NEW}${newTail}`);
  });

  it("the sweep saw every shape", () => {
    let checked = 0;
    for (const [, oldTail, newTail] of shapes) {
      expect(withToken(`${HOST}/${OLD}${oldTail}`, held)).toBe(`${HOST}/${NEW}${newTail}`);
      checked++;
    }
    expect(checked, "anti-vacuity: every shape rewritten").toBe(6);
  });

  it("a URL already under the newest token is returned as it is", () => {
    const url = `${HOST}/${NEW}/manifest/video.m3u8`;
    expect(withToken(url, held)).toBe(url);
  });

  it("an address that ends at the token is rewritten to the new token alone", () => {
    expect(withToken(`${HOST}/${OLD}`, held)).toBe(`${HOST}/${NEW}`);
  });

  it("only the FIRST path segment is replaced: the same text further along, in a path or a query, is left alone", () => {
    expect(withToken(`${HOST}/${OLD}/video/${OLD}/seg.ts?t=${OLD}`, held)).toBe(`${HOST}/${NEW}/video/${OLD}/seg.ts?t=${OLD}`);
  });

  it("a URL on another host, another scheme, or with no token is returned unchanged (nothing but the playback host is touched)", () => {
    const untouched = [
      `https://elsewhere.example/${OLD}/manifest/video.m3u8`,
      `http://customer-q7x2k9m4.cloudflarestream.com/${OLD}/manifest/video.m3u8`,
      `${HOST}`,
      `${HOST}/`,
      "blob:https://app.example/1234",
      "",
    ];
    let checked = 0;
    for (const url of untouched) {
      expect(withToken(url, held), JSON.stringify(url)).toBe(url);
      checked++;
    }
    expect(checked, "anti-vacuity").toBe(untouched.length);
  });

  it("LOOK-ALIKE hosts are another host: a suffix, a userinfo trick, a port and credentials come back unchanged and never get the token", () => {
    const bare = HOST.replace("https://", "");
    const lookAlikes = [
      `https://${bare}.evil.example/${OLD}/manifest/video.m3u8`, // the real host as a prefix of another
      `https://${bare}.evil/${OLD}/video/seg_1.ts`,
      `https://${bare}@evil.example/${OLD}/manifest/video.m3u8`, // userinfo: the browser would connect to evil.example
      `https://${bare}:pw@evil.example/${OLD}/manifest/video.m3u8`,
      `${HOST}:8443/${OLD}/manifest/video.m3u8`, // the real host on another port is another origin
      `https://user:pw@${bare}/${OLD}/manifest/video.m3u8`, // credentials on the real host are not the held origin either
      `https://x${bare}/${OLD}/manifest/video.m3u8`, // and the real host as a suffix
    ];
    let checked = 0;
    for (const url of lookAlikes) {
      const out = withToken(url, held);
      expect(out, url).toBe(url);
      expect(out, `${url}: the new token never reaches another host`).not.toContain(NEW);
      checked++;
    }
    expect(checked, "anti-vacuity: every look-alike checked").toBe(7);
    expect(withToken(`${HOST}/${OLD}/manifest/video.m3u8`, held), "premise: the real host IS rewritten").toBe(`${HOST}/${NEW}/manifest/video.m3u8`);
  });

  it("round trip: what it returns is itself a signed address under the new token with the same tail", () => {
    const url = `${HOST}/${OLD}/manifest/stream_1/video.m3u8?_HLS_msn=3`;
    const out = parseSignedAddress(withToken(url, held));
    expect(out).toEqual({ origin: HOST, token: NEW, tail: "/manifest/stream_1/video.m3u8?_HLS_msn=3" });
  });
});
