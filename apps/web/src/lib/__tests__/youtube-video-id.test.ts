// YouTube Connect T16: the public match page embeds a replay, and the embed's address is built from a VIDEO ID parsed out of
// the stored replay URL (owner ruling O4). The parse is the one thing between a stored string and an <iframe src>, so it is
// held to isYoutubeUrl's standard (https, youtube.com or a subdomain, youtu.be) PLUS a strict id shape: anything it cannot
// prove is a YouTube video id becomes `null`, and `null` is a link, never an iframe.
//
// Expected values are typed from YouTube's own URL forms (a watch page, a live page, a short link, an embed path, a Short),
// never read back from the function. A video id is 11 characters from [A-Za-z0-9_-] (the shape the fake driver mints too,
// server/youtube/fake.ts), which is a fact about YouTube, restated here as a literal.
import { describe, expect, it } from "vitest";
import { linkIsOneOfParts, replayRows, youtubeEmbedUrl, youtubeThumbnailUrl, youtubeVideoId } from "../youtube";

const ID = "dQw4w9WgXcQ";
const ID2 = "a-B_c1D2e3F";

describe("youtubeVideoId: the id of a YouTube video URL, or null", () => {
  const YES: [string, string][] = [
    [`https://www.youtube.com/watch?v=${ID}`, ID],
    [`https://youtube.com/watch?v=${ID2}`, ID2],
    [`https://m.youtube.com/watch?v=${ID}`, ID],
    [`https://www.youtube.com/watch?feature=share&v=${ID}&t=42`, ID],        // v is not the first parameter
    [`https://youtu.be/${ID}`, ID],
    [`https://YOUTU.BE/${ID2}?t=10`, ID2],
    [`https://www.youtube.com/live/${ID}`, ID],                              // the page a live broadcast has
    [`https://www.youtube.com/live/${ID}?feature=share`, ID],
    [`https://www.youtube.com/embed/${ID}`, ID],
    [`https://www.youtube.com/shorts/${ID2}`, ID2],
    [`https://www.youtube.com/v/${ID}`, ID],
  ];
  const NO = [
    // not a video address at all
    "https://www.youtube.com/",
    "https://www.youtube.com/channel/UCabcdefghijklmnopqrstuv",
    "https://www.youtube.com/@club",
    "https://www.youtube.com/playlist?list=PL1234567890a",
    "https://www.youtube.com/watch",                                         // no v
    "https://www.youtube.com/watch?v=",
    "https://youtu.be/",
    // the id is the wrong shape: too short, too long, characters outside the alphabet, an encoded slash
    "https://www.youtube.com/watch?v=short",
    `https://www.youtube.com/watch?v=${ID}extra`,
    "https://www.youtube.com/watch?v=abc def ghij",
    "https://www.youtube.com/watch?v=abc<script>1",
    "https://www.youtube.com/watch?v=../../etc/pw",
    `https://youtu.be/${ID}/more`,                                           // a video id is the whole path segment
    "https://youtu.be/%2e%2e%2f%2e%2e%2fabc",
    // not YouTube (isYoutubeUrl's own rejects)
    `https://www.twitch.tv/videos/${ID}`,
    `https://example.com/watch?v=${ID}`,
    `https://youtube.com.evil.example/watch?v=${ID}`,
    `https://notyoutube.com/watch?v=${ID}`,
    `https://evil.example/?u=https://youtu.be/${ID}`,
    `http://www.youtube.com/watch?v=${ID}`,                                  // not https
    `javascript:alert(1)//youtube.com/watch?v=${ID}`,
    `//www.youtube.com/watch?v=${ID}`,
    `www.youtube.com/watch?v=${ID}`,
    "",
    "not a url",
  ];

  it("returns the id for every YouTube video form and null for everything else, and says how many it checked", () => {
    let checked = 0;
    for (const [url, id] of YES) { expect(youtubeVideoId(url), url).toBe(id); checked++; }
    for (const url of NO) { expect(youtubeVideoId(url), url).toBeNull(); checked++; }
    expect(checked, "anti-vacuity: every row was asserted").toBe(YES.length + NO.length);
    expect(YES.length).toBeGreaterThanOrEqual(10);
    expect(NO.length).toBeGreaterThanOrEqual(20);
  });

  it("two different videos give two different ids (the answer is the URL's, not a constant)", () => {
    expect(youtubeVideoId(`https://www.youtube.com/watch?v=${ID}`)).not.toBe(youtubeVideoId(`https://www.youtube.com/watch?v=${ID2}`));
  });
});

describe("the embed and thumbnail addresses", () => {
  it("the embed is the privacy-enhanced host, over https, with the id in the path and autoplay on (it is only built after a tap)", () => {
    const u = new URL(youtubeEmbedUrl(ID, "https://seazn.club"));
    expect(u.protocol).toBe("https:");
    expect(u.hostname).toBe("www.youtube-nocookie.com");
    expect(u.pathname).toBe(`/embed/${ID}`);
    expect(u.searchParams.get("autoplay")).toBe("1");
    // rel=0 keeps the end-of-video suggestions to this channel; playsinline keeps iOS from forcing fullscreen; enablejsapi + origin
    // is what lets the page hear the player's error (embedding disabled) without loading YouTube's script.
    expect(u.searchParams.get("rel")).toBe("0");
    expect(u.searchParams.get("playsinline")).toBe("1");
    expect(u.searchParams.get("enablejsapi")).toBe("1");
    expect(u.searchParams.get("origin")).toBe("https://seazn.club");
  });

  it("a different id and a different origin move the address (not a constant)", () => {
    const a = new URL(youtubeEmbedUrl(ID, "https://seazn.club"));
    const b = new URL(youtubeEmbedUrl(ID2, "http://localhost:3000"));
    expect(a.pathname).not.toBe(b.pathname);
    expect(b.searchParams.get("origin")).toBe("http://localhost:3000");
  });

  it("the thumbnail is the video's public image on YouTube's image host", () => {
    const u = new URL(youtubeThumbnailUrl(ID));
    expect(u.origin).toBe("https://i.ytimg.com");
    expect(u.pathname).toBe(`/vi/${ID}/hqdefault.jpg`);
  });

  it("refuses an id of the wrong shape rather than building an address from it", () => {
    for (const bad of ["", "short", "has space!!", "../../x", `${ID}x`, "a/b/c/d/e/f"]) {
      expect(() => youtubeEmbedUrl(bad, "https://seazn.club"), bad).toThrow(/video id/);
      expect(() => youtubeThumbnailUrl(bad), bad).toThrow(/video id/);
    }
  });
});

// The two rules the public match page and the organiser's panel share about the fixture's own `stream_url` beside the replay parts:
// a link that IS one of the parts is not listed twice, and a different one still is.
describe("linkIsOneOfParts / replayRows: the club's own link beside the parts", () => {
  const P1 = { partNo: 1, url: `https://www.youtube.com/watch?v=${ID}` };
  const P2 = { partNo: 2, url: `https://www.youtube.com/watch?v=${ID2}` };
  const TWITCH = "https://www.twitch.tv/club";

  it("EMPTY CASE FIRST: no parts means no link is 'one of the parts', and the rows are just the club's own link, if any", () => {
    expect(linkIsOneOfParts(P1.url, [])).toBe(false);
    expect(replayRows(null, [])).toEqual([]);
    expect(replayRows("", [])).toEqual([]);
    expect(replayRows(TWITCH, [])).toEqual([{ key: "own", url: TWITCH, partNo: null }]);
    expect(replayRows(P1.url, []), "a YouTube link with no parts is still just the club's link").toEqual([{ key: "own", url: P1.url, partNo: null }]);
  });

  it("a link is one of the parts by VIDEO: the identical string, or the same video in another YouTube spelling - and nothing else", () => {
    expect(linkIsOneOfParts(P1.url, [P1, P2])).toBe(true);
    expect(linkIsOneOfParts(P2.url, [P1, P2])).toBe(true);
    for (const spelling of [`https://youtu.be/${ID}`, `https://www.youtube.com/live/${ID}`, `https://m.youtube.com/watch?v=${ID}&t=3`]) {
      expect(linkIsOneOfParts(spelling, [P1]), spelling).toBe(true);
    }
    expect(linkIsOneOfParts(P2.url, [P1]), "another video").toBe(false);
    expect(linkIsOneOfParts(TWITCH, [P1, P2]), "another site").toBe(false);
    // A non-YouTube part can only be matched by being the identical string (there is no id to compare).
    const odd = { partNo: 1, url: "https://example.com/vod/7" };
    expect(linkIsOneOfParts("https://example.com/vod/7", [odd])).toBe(true);
    expect(linkIsOneOfParts("https://example.com/vod/8", [odd])).toBe(false);
  });

  it("the rows are every part in order, then the club's own link only when it is not one of them", () => {
    expect(replayRows(P1.url, [P1, P2]).map((r) => [r.key, r.partNo])).toEqual([["part-1", 1], ["part-2", 2]]);
    expect(replayRows(TWITCH, [P1, P2])).toEqual([
      { key: "part-1", url: P1.url, partNo: 1 }, { key: "part-2", url: P2.url, partNo: 2 }, { key: "own", url: TWITCH, partNo: null },
    ]);
    expect(replayRows(null, [P1]).map((r) => r.url)).toEqual([P1.url]);
    // Keys are unique (they key a React list).
    const rows = replayRows(TWITCH, [P1, P2]);
    expect(new Set(rows.map((r) => r.key)).size).toBe(rows.length);
  });
});
