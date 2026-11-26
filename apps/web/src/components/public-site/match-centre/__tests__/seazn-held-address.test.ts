// Seazn-hosted video: `holdAddresses`, the rule that keeps a playing video's address while its token is not due for a refresh
// (seazn-held-address.ts). Pure, so every branch is driven here; the island's use of it, through its poll and the real controller on a
// native element, is seazn-native-token-hold.test.tsx's. Expected boundaries come from the refresh constant, never a typed 300.
import { describe, expect, it } from "vitest";
import type { PublicFixtureVideo } from "@/server/api-v1/schemas";
import { SEAZN_TOKEN_REFRESH_BEFORE_SECONDS } from "@/server/relay/config";
import { holdAddresses, isRefreshDue } from "../seazn-held-address";

const NOW = Date.parse("2026-11-26T12:00:00.000Z");
const WINDOW_MS = SEAZN_TOKEN_REFRESH_BEFORE_SECONDS * 1000;
const addr = (token: string, host = "playback.fake.invalid", path = "manifest/video.m3u8") => `https://${host}/${token}/${path}`;
/** An address expiring `leftMs` after NOW. */
const signed = (token: string, leftMs: number, extra: { host?: string; path?: string; id?: string | null } = {}) => ({
  src: addr(token, extra.host, extra.path),
  expiresAt: new Date(NOW + leftMs).toISOString(),
  ...(extra.id === null ? {} : { id: extra.id ?? "vid-1" }),
});
const HOUR = 3_600_000;
const video = (v: { live?: ReturnType<typeof signed> | null; replay?: { partNo: number; player: "hls" | "embed"; src: string; expiresAt: string; id?: string }[] }): PublicFixtureVideo =>
  ({ live: v.live ?? null, replay: v.replay ?? [], session: null }) as unknown as PublicFixtureVideo;
const hlsPart = (partNo: number, token: string, leftMs: number, id = `rec-${partNo}`) => ({ partNo, player: "hls" as const, ...signed(token, leftMs, { id }) });

describe("isRefreshDue: the window the server itself stops reusing a token in", () => {
  it("is due at exactly the refresh window and one millisecond inside it, and not due one millisecond outside", () => {
    expect(isRefreshDue(new Date(NOW + WINDOW_MS + 1).toISOString(), NOW), "1 ms more than the window left").toBe(false);
    expect(isRefreshDue(new Date(NOW + WINDOW_MS).toISOString(), NOW), "exactly the window left").toBe(true);
    expect(isRefreshDue(new Date(NOW + WINDOW_MS - 1).toISOString(), NOW)).toBe(true);
    expect(isRefreshDue(new Date(NOW - 1).toISOString(), NOW), "already lapsed").toBe(true);
  });
  it("an expiry that is not a date is due: a token with no life to count is never held", () => {
    expect(isRefreshDue("not-a-date", NOW)).toBe(true);
    expect(isRefreshDue("", NOW)).toBe(true);
  });
});

describe("holdAddresses: the live", () => {
  it("EMPTY CASE FIRST: no answer before, an answer with nothing, and nothing held in either: the answer comes back as it is (same object)", () => {
    const empty = video({});
    expect(holdAddresses(null, empty, NOW)).toBe(empty);
    expect(holdAddresses(empty, empty, NOW)).toBe(empty);
    const live = video({ live: signed("a", HOUR) });
    expect(holdAddresses(null, live, NOW), "the first answer is shown whole").toBe(live);
  });

  it("the same video under another token, the held one not due: the held address (and its expiry) stay; the rest of the answer is the new one's", () => {
    const shown = video({ live: signed("a", HOUR) });
    const next = { ...video({ live: signed("b", HOUR + 30_000) }), session: { state: "live", wentLive: true } } as unknown as PublicFixtureVideo;
    const out = holdAddresses(shown, next, NOW);
    expect(out.live).toEqual(shown.live);
    expect(out.session, "the new answer's own fields stay").toEqual(next.session);
  });

  it("the same address again is returned untouched (nothing held, nothing changed)", () => {
    const shown = video({ live: signed("a", HOUR) });
    const next = video({ live: signed("a", HOUR) });
    expect(holdAddresses(shown, next, NOW)).toBe(next);
  });

  it("the held token is refresh-due: the new answer's address is taken, once; the NEXT answer is then compared with that one", () => {
    const shown = video({ live: signed("a", WINDOW_MS) });   // exactly due
    const refreshed = video({ live: signed("b", HOUR) });
    const out = holdAddresses(shown, refreshed, NOW);
    expect(out.live).toEqual(refreshed.live);
    const later = holdAddresses(out, video({ live: signed("c", HOUR) }), NOW + 30_000);
    expect(later.live, "the refreshed token is held in its turn").toEqual(refreshed.live);
  });

  it("one millisecond outside the window the held address is still held", () => {
    const shown = video({ live: signed("a", WINDOW_MS + 1) });
    expect(holdAddresses(shown, video({ live: signed("b", HOUR) }), NOW).live).toEqual(shown.live);
  });

  it("a different video is never held: another host, another path after the token, a live that came back after an answer without one", () => {
    const shown = video({ live: signed("a", HOUR) });
    for (const next of [
      video({ live: signed("b", HOUR, { host: "other.fake.invalid" }) }),
      video({ live: signed("b", HOUR, { path: "manifest/other.m3u8" }) }),
    ]) expect(holdAddresses(shown, next, NOW).live, "taken whole").toEqual(next.live);
    const gap = video({ replay: [hlsPart(1, "r1", HOUR)] });
    const back = video({ live: signed("b", HOUR) });
    expect(holdAddresses(holdAddresses(shown, gap, NOW), back, NOW).live, "the answer before it had no live: nothing held").toEqual(back.live);
  });

  it("TWO VIDEOS, ONE HOST AND PATH: another identity is never held, however far its token is from due (the token is what differs for every video)", () => {
    const shown = video({ live: signed("a", HOUR, { id: "vid-1" }) });
    const next = video({ live: signed("b", HOUR, { id: "vid-2" }) });
    expect(holdAddresses(shown, next, NOW).live).toEqual(next.live);
  });

  it("an answer with no identity, on either side, is never held", () => {
    const withId = video({ live: signed("a", HOUR) });
    const without = video({ live: signed("b", HOUR, { id: null }) });
    expect(holdAddresses(withId, without, NOW).live, "the new one names none").toEqual(without.live);
    expect(holdAddresses(without, withId, NOW).live, "the held one names none").toEqual(withId.live);
    expect(holdAddresses(without, video({ live: signed("c", HOUR, { id: null }) }), NOW).live, "neither names one").toEqual(signed("c", HOUR, { id: null }));
  });

  it("an address that is not a signed one (relative, another scheme) is never held, held or new", () => {
    const odd = { src: "/relative/video.m3u8", expiresAt: new Date(NOW + HOUR).toISOString() };
    const shown = video({ live: odd });
    const next = video({ live: signed("b", HOUR) });
    expect(holdAddresses(shown, next, NOW).live).toEqual(next.live);
    expect(holdAddresses(video({ live: signed("a", HOUR) }), video({ live: odd }), NOW).live).toEqual(odd);
  });
});

describe("holdAddresses: the recording parts", () => {
  it("each hls part keeps its own held address by part number, in the new answer's order, and a new part is taken as it is", () => {
    const shown = video({ replay: [hlsPart(1, "a1", HOUR), hlsPart(2, "a2", HOUR)] });
    const next = video({ replay: [hlsPart(2, "b2", HOUR), hlsPart(3, "b3", HOUR), hlsPart(1, "b1", HOUR)] });
    const out = holdAddresses(shown, next, NOW);
    expect(out.replay.map((p) => [p.partNo, p.src])).toEqual([
      [2, shown.replay[1]!.src],
      [3, next.replay[1]!.src],
      [1, shown.replay[0]!.src],
    ]);
  });

  it("a part whose recording changed under the same number (another identity) is taken, not held", () => {
    const shown = video({ replay: [hlsPart(1, "a1", HOUR, "rec-A")] });
    const next = video({ replay: [hlsPart(1, "b1", HOUR, "rec-B")] });
    expect(holdAddresses(shown, next, NOW).replay[0]).toEqual(next.replay[0]);
  });

  it("only the part whose token is due changes", () => {
    const shown = video({ replay: [hlsPart(1, "a1", WINDOW_MS), hlsPart(2, "a2", HOUR)] });
    const next = video({ replay: [hlsPart(1, "b1", HOUR), hlsPart(2, "b2", HOUR)] });
    const out = holdAddresses(shown, next, NOW);
    expect(out.replay[0]!.src, "due: the new one").toBe(next.replay[0]!.src);
    expect(out.replay[1]!.src, "not due: held").toBe(shown.replay[1]!.src);
  });

  it("an embed part (the replay host's frame) is never touched, and an hls part never inherits from an embed one of the same number", () => {
    const embed = { partNo: 1, player: "embed" as const, ...signed("e1", HOUR) };
    const embedNext = { partNo: 1, player: "embed" as const, ...signed("e2", HOUR) };
    expect(holdAddresses(video({ replay: [embed] }), video({ replay: [embedNext] }), NOW).replay[0]).toEqual(embedNext);
    const hlsNext = hlsPart(1, "h2", HOUR);
    expect(holdAddresses(video({ replay: [embed] }), video({ replay: [hlsNext] }), NOW).replay[0]).toEqual(hlsNext);
    // ...nor the other way: an hls part that turns to the host's frame (the same number, the same host and path) is the frame's own address.
    const turned = holdAddresses(video({ replay: [hlsPart(1, "h1", HOUR)] }), video({ replay: [embedNext] }), NOW);
    expect(turned.replay[0]).toEqual(embedNext);
  });

  it("a part gone from the list and back is not held (the answer between had none)", () => {
    const shown = video({ replay: [hlsPart(1, "a1", HOUR)] });
    const gone = holdAddresses(shown, video({}), NOW);
    const back = video({ replay: [hlsPart(1, "b1", HOUR)] });
    expect(holdAddresses(gone, back, NOW).replay[0]).toEqual(back.replay[0]);
  });

  it("live and parts are held independently in one answer", () => {
    const shown = video({ live: signed("a", HOUR), replay: [hlsPart(1, "a1", HOUR)] });
    const next = video({ live: signed("b", HOUR), replay: [hlsPart(1, "b1", HOUR)] });
    const out = holdAddresses(shown, next, NOW);
    expect(out.live).toEqual(shown.live);
    expect(out.replay[0]).toEqual(shown.replay[0]);
  });
});
