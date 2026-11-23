// Seazn-hosted video, Phase 1 Task 15: WHEN the match page's island asks the video route again (`nextVideoFetchMs`). Pure: an
// answer in, a delay out. The rules are the plan's (Review Focus 3 and the 2026-11-21 recommendation):
//   - no video yet, or none to show (warming, or ended with no recording signed yet): look again in 30 s;
//   - live: at the 30 s floor, whatever the token's life (Task 19, the Task 15 review's r3: a Stop must reach a page that is open,
//     within one poll, not ~55 minutes later at the token's refresh point; a re-read at 30 s also always lands inside the token's
//     refresh window, so it carries the refresh too);
//   - replay only, and every part is the replay host's embed (Task 25, carry 4): the 30 s floor while hot, the 60 s ceiling when
//     cold and not yet final (review m5: an undecided fixture never settles), and no timer once FINAL — the fixture settled and
//     nothing hot (the frame checked its token when it loaded, and a later answer never touches it, so the reads cost the frame
//     nothing: they are how a second Go live and a Stop still reach an open page);
//   - replay only with an `hls` part (the interim Cloudflare recording): the 30 s floor too, whatever the parts' tokens (Task 19 fix
//     round 1, I1: an organiser's second Go live after the first half's interim replay must reach a page that is open, within one
//     poll, not ~55 minutes later at the recording token's refresh point).
// The expected values are the rule's arithmetic from the declared window, never read off the function under test.
import { describe, expect, it } from "vitest";
import { SEAZN_TOKEN_REFRESH_BEFORE_SECONDS } from "@/server/relay/config";
import type { PublicFixtureVideo } from "@/server/api-v1/schemas";
import {
  SEAZN_VIDEO_KICKOFF_WINDOW_MS, SEAZN_VIDEO_POLL_CEILING_MS, SEAZN_VIDEO_POLL_FLOOR_MS, type VideoReadContext, backoffMs, isHotRead,
  nextVideoFetchMs as nextVideoFetchAt,
} from "../seazn-video-schedule";

const NOW = new Date("2026-11-21T12:00:00.000Z");
const MIN = 60_000;
const REFRESH_MS = SEAZN_TOKEN_REFRESH_BEFORE_SECONDS * 1000;
const at = (offsetMs: number): string => new Date(NOW.getTime() + offsetMs).toISOString();
/** The loop's context for an answer read at NOW on a fixture that is not settled, the first answer of its kind. */
const OPEN: VideoReadContext = { nowMs: NOW.getTime(), settledAtMs: null, emptyStreak: 1 };
/** The rules that do not depend on the loop's context, read in it. */
const nextVideoFetchMs = (video: PublicFixtureVideo | null): number | null => nextVideoFetchAt(video, OPEN);
const live = (offsetMs: number): PublicFixtureVideo["live"] => ({ src: "https://host.invalid/t/manifest/video.m3u8", expiresAt: at(offsetMs) });
const part = (partNo: number, offsetMs: number, player: "hls" | "embed" = "hls"): PublicFixtureVideo["replay"][number] => ({
  partNo,
  player,
  src: `https://host.invalid/p${partNo}/manifest/video.m3u8`,
  expiresAt: at(offsetMs),
});

describe("nextVideoFetchMs: nothing to show yet", () => {
  it("EMPTY CASE FIRST: no answer yet, and an answer with no live and no replay, both look again in 30 s", () => {
    expect(nextVideoFetchMs(null)).toBe(30_000);
    expect(nextVideoFetchMs({ live: null, replay: [] })).toBe(30_000);
    expect(SEAZN_VIDEO_POLL_FLOOR_MS, "the floor IS the plan's 30 s").toBe(30_000);
  });
});

describe("nextVideoFetchMs: live", () => {
  // r3 (Task 15 review, Task 19): the live answer is re-read at the floor, so a page that is open when the organiser stops learns it
  // within one poll. The expiries below are the ones the old rule (the token's refresh point) answered 55 and 25 min for.
  it("an expiry 60 min away is re-read at the 30 s floor, not at the token's refresh point (55 min)", () => {
    const wait = nextVideoFetchMs({ live: live(60 * MIN), replay: [] });
    expect(wait).toBe(SEAZN_VIDEO_POLL_FLOOR_MS);
    expect(wait, "the refresh point is where a stopped live used to linger").not.toBe(60 * MIN - REFRESH_MS);
  });

  it("the delay does not follow the token: an expiry 30 min away is also the 30 s floor", () => {
    expect(nextVideoFetchMs({ live: live(30 * MIN), replay: [] })).toBe(SEAZN_VIDEO_POLL_FLOOR_MS);
  });

  it("a 30 s re-read always lands inside the token's refresh window, so the floor carries the refresh as well", () => {
    expect(SEAZN_VIDEO_POLL_FLOOR_MS, "premise: the floor is shorter than the window the server re-mints in").toBeLessThan(REFRESH_MS);
  });

  it("an expiry closer than the refresh window (2 min), exactly on it, already past, or not a date: the 30 s floor", () => {
    expect(nextVideoFetchMs({ live: live(2 * MIN), replay: [] })).toBe(30_000);
    expect(nextVideoFetchMs({ live: live(REFRESH_MS), replay: [] }), "0 ms left to wait").toBe(30_000);
    expect(nextVideoFetchMs({ live: live(-10 * MIN), replay: [] })).toBe(30_000);
    expect(nextVideoFetchMs({ live: { src: "https://host.invalid/t/manifest/video.m3u8", expiresAt: "not a date" }, replay: [] }), "NaN must not become the delay").toBe(30_000);
  });

  it("recordings listed beside a live source set no delay of their own (only the live source plays): the floor", () => {
    expect(nextVideoFetchMs({ live: live(60 * MIN), replay: [part(1, 10 * MIN)] })).toBe(SEAZN_VIDEO_POLL_FLOOR_MS);
  });
});

describe("nextVideoFetchMs: replay only", () => {
  it("carry 4 + review m5: every part is the replay host's embed on a fixture not settled — the 30 s floor while HOT (a second Go live reaches an open page within one read), the 60 s ceiling when cold (it never settles if never decided)", () => {
    const embeds: PublicFixtureVideo = { live: null, replay: [part(1, 60 * MIN, "embed"), part(2, 60 * MIN, "embed")] };
    expect(nextVideoFetchMs(embeds), "cold: no kick-off, nothing active").toBe(SEAZN_VIDEO_POLL_CEILING_MS);
    expect(nextVideoFetchAt(embeds, { ...OPEN, activeUntilMs: NOW.getTime() + 1 }), "a session active as the page was drawn").toBe(SEAZN_VIDEO_POLL_FLOOR_MS);
    expect(nextVideoFetchAt(embeds, { ...OPEN, activeUntilMs: NOW.getTime() }), "active until now: cold").toBe(SEAZN_VIDEO_POLL_CEILING_MS);
    expect(nextVideoFetchAt(embeds, { ...OPEN, kickoffAtMs: NOW.getTime() + SEAZN_VIDEO_KICKOFF_WINDOW_MS }), "kick-off within the hour").toBe(SEAZN_VIDEO_POLL_FLOOR_MS);
  });

  it("review m5: an UNDECIDED fixture's embed-only replay on a cold page reads at the 60 s ceiling on every read — never the floor, never more — so a forgotten open tab costs one read a minute, and a later Go live still reaches it within one", () => {
    const embeds: PublicFixtureVideo = { live: null, replay: [part(1, 60 * MIN, "embed")] };
    let checked = 0;
    for (const hoursLater of [0, 1, 6, 24, 24 * 7]) {
      for (const emptyStreak of [0, 1, 5]) {
        const ctx: VideoReadContext = { nowMs: NOW.getTime() + hoursLater * 60 * MIN, settledAtMs: null, emptyStreak, kickoffAtMs: NOW.getTime() - 2 * 60 * MIN, activeUntilMs: NOW.getTime() - MIN };
        expect(nextVideoFetchAt(embeds, ctx), `${hoursLater} h later, streak ${emptyStreak}`).toBe(60_000);
        checked++;
      }
    }
    expect(checked, "anti-vacuity").toBe(15);
    // An hls part beside it still holds the floor (the interim's own rule): the ceiling is for embeds alone.
    expect(nextVideoFetchAt({ live: null, replay: [part(1, 60 * MIN, "embed"), part(2, 60 * MIN)] }, OPEN)).toBe(SEAZN_VIDEO_POLL_FLOOR_MS);
  });

  // I1 (Task 19 review): a page showing the interim replay must learn of a second Go live within one poll. The expiries below are
  // the ones the old rule (the earliest hls part's refresh point) answered 55 and 15 min for.
  it("an hls part (the interim Cloudflare recording) 60 min away is re-read at the 30 s floor, not at its refresh point (55 min)", () => {
    const wait = nextVideoFetchMs({ live: null, replay: [part(1, 60 * MIN)] });
    expect(wait).toBe(SEAZN_VIDEO_POLL_FLOOR_MS);
    expect(wait, "the refresh point is where a replay used to hide a restart").not.toBe(60 * MIN - REFRESH_MS);
  });

  it("several hls parts: the 30 s floor, whatever their expiries and the order they arrive in", () => {
    const parts = [part(1, 60 * MIN), part(3, 20 * MIN), part(4, 40 * MIN)];
    expect(nextVideoFetchMs({ live: null, replay: parts })).toBe(SEAZN_VIDEO_POLL_FLOOR_MS);
    expect(nextVideoFetchMs({ live: null, replay: [...parts].reverse() })).toBe(SEAZN_VIDEO_POLL_FLOOR_MS);
  });

  it("an embed part beside an hls one: the hls part puts the page on the 30 s floor", () => {
    expect(nextVideoFetchMs({ live: null, replay: [part(1, 5 * MIN, "embed"), part(2, 60 * MIN)] })).toBe(SEAZN_VIDEO_POLL_FLOOR_MS);
  });

  it("an hls part about to lapse, already past, or not a date: the 30 s floor", () => {
    expect(nextVideoFetchMs({ live: null, replay: [part(1, 1 * MIN)] })).toBe(30_000);
    expect(nextVideoFetchMs({ live: null, replay: [part(1, -10 * MIN)] })).toBe(30_000);
    const bad = { ...part(1, 60 * MIN), expiresAt: "not a date" };
    expect(nextVideoFetchMs({ live: null, replay: [bad] }), "NaN must not become the delay").toBe(30_000);
  });
});

// Phase 1 review I2: a 30 s poll forever, on every Seazn fixture page, open or forgotten. The backoff and the stop below are the fix
// brief's rule, typed here from the brief, never read off the function. The fix-wave re-review's N1 (2026-11-22) moved the ceiling to
// 60 s (a viewer watching the page saw Go live up to 5 min late) and keeps the floor while the match is HOT: in play, within an hour
// either side of its kick-off, or a Seazn session warming or live (the plan's `activeUntil`).
describe("review I2 + N1: nothing to show backs off, to 60 s, unless the match is hot", () => {
  const empty = { live: null, replay: [] };
  it("the ceiling IS the re-review's 60 s, and the kick-off window its hour", () => {
    expect(SEAZN_VIDEO_POLL_CEILING_MS).toBe(60_000);
    expect(SEAZN_VIDEO_KICKOFF_WINDOW_MS).toBe(60 * MIN);
  });

  it("EMPTY CASE FIRST: no kick-off and nothing active — the first empty answer is the 30 s floor, then 60 s, and never more", () => {
    const waits = [1, 2, 3, 4, 5, 6, 20].map((emptyStreak) => nextVideoFetchAt(empty, { ...OPEN, emptyStreak }));
    expect(waits).toEqual([30_000, 60_000, 60_000, 60_000, 60_000, 60_000, 60_000]);
  });

  it("backoffMs (empty answers, and failed reads: N6) is the same ladder: 30 s, then 60 s for good; a streak of 0 is the floor", () => {
    expect([0, 1, 2, 3, 10, 1000].map(backoffMs)).toEqual([30_000, 30_000, 60_000, 60_000, 60_000, 60_000]);
  });

  it("an answer that shows something is read at the floor whatever came before it: a live, and an hls replay", () => {
    for (const emptyStreak of [0, 1, 5]) {
      expect(nextVideoFetchAt({ live: live(60 * MIN), replay: [] }, { ...OPEN, emptyStreak }), `live, streak ${emptyStreak}`).toBe(SEAZN_VIDEO_POLL_FLOOR_MS);
      expect(nextVideoFetchAt({ live: null, replay: [part(1, 60 * MIN)] }, { ...OPEN, emptyStreak }), `hls, streak ${emptyStreak}`).toBe(SEAZN_VIDEO_POLL_FLOOR_MS);
    }
  });

  it("N1: within an hour either side of kick-off an empty answer holds the floor, deep into a streak; a ms outside the hour it backs off", () => {
    const k = (offsetMs: number): VideoReadContext => ({ ...OPEN, emptyStreak: 5, kickoffAtMs: NOW.getTime() + offsetMs });
    let checked = 0;
    for (const [offset, want] of [
      [60 * MIN, 30_000], [10 * MIN, 30_000], [0, 30_000], [-10 * MIN, 30_000], [-60 * MIN, 30_000],
      [60 * MIN + 1, 60_000], [-60 * MIN - 1, 60_000], [5 * 60 * MIN, 60_000],
    ] as const) {
      expect(nextVideoFetchAt(empty, k(offset)), `kick-off ${offset / MIN} min from now`).toBe(want);
      checked++;
    }
    expect(checked).toBe(8);
    expect(nextVideoFetchAt(empty, { ...OPEN, emptyStreak: 5, kickoffAtMs: Number.NaN }), "a kick-off that is not a date is no window").toBe(60_000);
  });

  it("N1: while the match is active (in play, or a Seazn session warming or live, when the page was drawn) an empty answer holds the floor, up to the plan's bound", () => {
    const a = (offsetMs: number): VideoReadContext => ({ ...OPEN, emptyStreak: 5, activeUntilMs: NOW.getTime() + offsetMs });
    expect(nextVideoFetchAt(empty, a(90 * MIN)), "active for 90 more minutes").toBe(30_000);
    expect(nextVideoFetchAt(empty, a(1)), "1 ms left").toBe(30_000);
    expect(nextVideoFetchAt(empty, a(0)), "the bound itself: no longer active").toBe(60_000);
    expect(nextVideoFetchAt(empty, a(-MIN)), "past it").toBe(60_000);
  });

  it("N1: hot outranks settled — something may still be happening — and cold-and-settled still stops", () => {
    const settledNow = { ...OPEN, emptyStreak: 5, settledAtMs: NOW.getTime() - MIN };
    expect(nextVideoFetchAt(empty, settledNow), "PREMISE: cold and settled stops").toBeNull();
    expect(nextVideoFetchAt(empty, { ...settledNow, kickoffAtMs: NOW.getTime() }), "near kick-off").toBe(30_000);
    expect(nextVideoFetchAt(empty, { ...settledNow, activeUntilMs: NOW.getTime() + MIN }), "active").toBe(30_000);
  });

  it("isHotRead: EMPTY CASE FIRST — no kick-off and no active bound is cold; either window alone is hot", () => {
    expect(isHotRead({ nowMs: NOW.getTime() })).toBe(false);
    expect(isHotRead({ nowMs: NOW.getTime(), kickoffAtMs: null, activeUntilMs: null })).toBe(false);
    expect(isHotRead({ nowMs: NOW.getTime(), kickoffAtMs: NOW.getTime() + SEAZN_VIDEO_KICKOFF_WINDOW_MS })).toBe(true);
    expect(isHotRead({ nowMs: NOW.getTime(), activeUntilMs: NOW.getTime() + 1 })).toBe(true);
  });
});

describe("review I2: a SETTLED fixture (decided, past the window a new Go live can start in)", () => {
  const settled = (offsetMs: number, emptyStreak = 1): VideoReadContext => ({ nowMs: NOW.getTime(), settledAtMs: NOW.getTime() + offsetMs, emptyStreak });

  it("EMPTY CASE FIRST: nothing to show once settled stops the loop — from the settle instant itself; one ms before it is still the backoff", () => {
    const empty = { live: null, replay: [] };
    expect(nextVideoFetchAt(empty, settled(-10 * MIN)), "settled 10 min ago").toBeNull();
    expect(nextVideoFetchAt(empty, settled(0)), "settled this instant").toBeNull();
    expect(nextVideoFetchAt(empty, settled(1)), "1 ms short of it: the first empty answer's floor").toBe(30_000);
    expect(nextVideoFetchAt(empty, settled(1, 3)), "and its backoff").toBe(60_000);
  });

  it("a live on a settled fixture is still read at the floor (a Stop must reach the page)", () => {
    expect(nextVideoFetchAt({ live: live(60 * MIN), replay: [] }, settled(-10 * MIN))).toBe(SEAZN_VIDEO_POLL_FLOOR_MS);
  });

  it("an hls replay is re-read at its token's refresh point, not at the floor: no restart is coming, and the token must still be refreshed", () => {
    const wait = nextVideoFetchAt({ live: null, replay: [part(1, 60 * MIN)] }, settled(-10 * MIN));
    expect(wait, "60 min of token, refreshed 5 min before its end").toBe(60 * MIN - REFRESH_MS);
    expect(wait).toBe(55 * MIN);
  });

  it("several hls parts: the EARLIEST token's refresh point, in any order; an embed beside them sets nothing", () => {
    const parts = [part(1, 60 * MIN), part(2, 20 * MIN), part(3, 40 * MIN), part(4, 5 * MIN, "embed")];
    expect(nextVideoFetchAt({ live: null, replay: parts }, settled(-1))).toBe(20 * MIN - REFRESH_MS);
    expect(nextVideoFetchAt({ live: null, replay: [...parts].reverse() }, settled(-1))).toBe(20 * MIN - REFRESH_MS);
  });

  it("a token inside its refresh window, already past, or not a date: the 30 s floor, never sooner", () => {
    expect(nextVideoFetchAt({ live: null, replay: [part(1, 2 * MIN)] }, settled(-1))).toBe(30_000);
    expect(nextVideoFetchAt({ live: null, replay: [part(1, REFRESH_MS + 10_000)] }, settled(-1)), "10 s to its refresh point").toBe(30_000);
    expect(nextVideoFetchAt({ live: null, replay: [part(1, -10 * MIN)] }, settled(-1))).toBe(30_000);
    expect(nextVideoFetchAt({ live: null, replay: [{ ...part(1, 60 * MIN), expiresAt: "not a date" }] }, settled(-1)), "NaN must not become the delay").toBe(30_000);
  });

  it("carry 4: embeds alone on a SETTLED, cold fixture are final — no timer; a ms before the settle, the floor", () => {
    const embeds: PublicFixtureVideo = { live: null, replay: [part(1, 60 * MIN, "embed"), part(2, 60 * MIN, "embed")] };
    expect(nextVideoFetchAt(embeds, settled(-1)), "settled a ms ago").toBeNull();
    expect(nextVideoFetchAt(embeds, settled(0)), "settled at this very read").toBeNull();
    expect(nextVideoFetchAt(embeds, settled(1)), "settled a ms from now: not yet final, cold: the ceiling (review m5)").toBe(SEAZN_VIDEO_POLL_CEILING_MS);
  });

  it("carry 4: hot outranks settled for embeds alone, as it does for an empty answer — a session active as the page was drawn, or kick-off within the hour, holds the floor", () => {
    const embeds: PublicFixtureVideo = { live: null, replay: [part(1, 60 * MIN, "embed")] };
    expect(nextVideoFetchAt(embeds, { ...settled(-1), activeUntilMs: NOW.getTime() + 1 }), "active a ms longer").toBe(SEAZN_VIDEO_POLL_FLOOR_MS);
    expect(nextVideoFetchAt(embeds, { ...settled(-1), activeUntilMs: NOW.getTime() }), "active until now: cold").toBeNull();
    expect(nextVideoFetchAt(embeds, { ...settled(-1), kickoffAtMs: NOW.getTime() - SEAZN_VIDEO_KICKOFF_WINDOW_MS }), "kick-off an hour ago").toBe(SEAZN_VIDEO_POLL_FLOOR_MS);
    expect(nextVideoFetchAt(embeds, { ...settled(-1), kickoffAtMs: NOW.getTime() - SEAZN_VIDEO_KICKOFF_WINDOW_MS - 1 }), "and a ms more").toBeNull();
  });
});
