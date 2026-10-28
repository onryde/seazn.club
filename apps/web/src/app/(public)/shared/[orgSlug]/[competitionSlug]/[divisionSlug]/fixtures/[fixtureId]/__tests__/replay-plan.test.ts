// YouTube Connect T16 (owner rulings O1, O3): WHAT the public match page shows of a fixture's replay, as a decision swept over
// the whole fixture-status vocabulary - the stream-link.test.ts treatment for the replay.
//
// The data rules (O3), each with its twin:
//   - zero parts: nothing for the player; the club's own link is shown exactly as before (the pasted-key regression);
//   - parts and a stream_url that is one of them: the player carries it and the link is NOT shown a second time;
//   - parts and a stream_url that is the club's own, different link: both are shown;
//   - a void fixture (cancelled, abandoned, forfeited) shows no player and no link, whatever is stored (streamLinkLabelKey's rule);
//   - a part that is not a YouTube address is never offered a player.
// Expected values are typed from the rulings. The void set is the competition desk's own VOID_STATUSES (the authority
// stream-link.test.ts also holds the label to), and the status list is the app's FIXTURE_STATUSES.
import { describe, expect, it } from "vitest";
import { VOID_STATUSES } from "@/components/v2/stages-panel";
import { FIXTURE_STATUSES } from "@/lib/fixture-status";
import { replayPlan } from "../replay-plan";

const ID1 = "dQw4w9WgXcQ";
const ID2 = "a-B_c1D2e3F";
const WATCH1 = `https://www.youtube.com/watch?v=${ID1}`;
const WATCH2 = `https://www.youtube.com/watch?v=${ID2}`;
const P1 = { partNo: 1, url: WATCH1 };
const P2 = { partNo: 2, url: WATCH2 };
const TWITCH = "https://www.twitch.tv/seaznclub";
const DECIDED = "decided";

describe("replayPlan: the parts the page lists", () => {
  it("EMPTY CASE FIRST: no parts means no player, and the club's own link is shown as it always was", () => {
    expect(replayPlan({ status: DECIDED, streamUrl: TWITCH, parts: [] })).toEqual({ parts: [], showOwnLink: true });
    expect(replayPlan({ status: DECIDED, streamUrl: WATCH1, parts: [] }), "a pasted YouTube link with no parts is still just a link").toEqual({ parts: [], showOwnLink: true });
    expect(replayPlan({ status: DECIDED, streamUrl: null, parts: [] })).toEqual({ parts: [], showOwnLink: false });
    // The positive pair: the same fixture with a part now lists it.
    expect(replayPlan({ status: DECIDED, streamUrl: TWITCH, parts: [P1] }).parts).toEqual([P1]);
  });

  it("one part and a stream_url that IS that part: the player carries it, the link is not shown twice", () => {
    expect(replayPlan({ status: DECIDED, streamUrl: WATCH1, parts: [P1] })).toEqual({ parts: [P1], showOwnLink: false });
  });

  it("the same video in another YouTube spelling (youtu.be, /live/) is still the part: not shown twice", () => {
    for (const spelling of [`https://youtu.be/${ID1}`, `https://www.youtube.com/live/${ID1}`, `https://m.youtube.com/watch?v=${ID1}&t=3`]) {
      expect(replayPlan({ status: DECIDED, streamUrl: spelling, parts: [P1] }).showOwnLink, spelling).toBe(false);
    }
  });

  it("a club's own DIFFERENT link still renders beside the parts - another site's, and another YouTube video", () => {
    expect(replayPlan({ status: DECIDED, streamUrl: TWITCH, parts: [P1] })).toEqual({ parts: [P1], showOwnLink: true });
    expect(replayPlan({ status: DECIDED, streamUrl: WATCH2, parts: [P1] }), "a different video on YouTube is the club's own").toEqual({ parts: [P1], showOwnLink: true });
  });

  it("two parts: both are listed in the order given, and a stream_url equal to EITHER one is not shown again", () => {
    expect(replayPlan({ status: DECIDED, streamUrl: WATCH1, parts: [P1, P2] })).toEqual({ parts: [P1, P2], showOwnLink: false });
    expect(replayPlan({ status: DECIDED, streamUrl: WATCH2, parts: [P1, P2] }).showOwnLink, "the second part's address").toBe(false);
    expect(replayPlan({ status: DECIDED, streamUrl: TWITCH, parts: [P1, P2] }).showOwnLink).toBe(true);
  });

  it("a part that is not a YouTube address is never offered a player; the YouTube ones are kept", () => {
    const stray = { partNo: 2, url: "https://example.com/watch?v=dQw4w9WgXcQ" };
    expect(replayPlan({ status: DECIDED, streamUrl: null, parts: [P1, stray] }).parts).toEqual([P1]);
    expect(replayPlan({ status: DECIDED, streamUrl: null, parts: [stray] }).parts).toEqual([]);
    for (const bad of ["javascript:alert(1)", "http://www.youtube.com/watch?v=dQw4w9WgXcQ", "", "//youtu.be/dQw4w9WgXcQ"]) {
      expect(replayPlan({ status: DECIDED, streamUrl: null, parts: [{ partNo: 1, url: bad }] }).parts, JSON.stringify(bad)).toEqual([]);
    }
  });
});

describe("replayPlan: every fixture status, not one sample", () => {
  it("a void fixture shows no player and no link whatever is stored; every other status shows both - swept over the whole vocabulary", () => {
    let checked = 0;
    let voids = 0;
    let live = 0;
    for (const status of FIXTURE_STATUSES) {
      const plan = replayPlan({ status, streamUrl: TWITCH, parts: [P1, P2] });
      if (VOID_STATUSES.has(status)) {
        expect(plan, status).toEqual({ parts: [], showOwnLink: false });
        voids++;
      } else {
        expect(plan, status).toEqual({ parts: [P1, P2], showOwnLink: true });
        live++;
      }
      checked++;
    }
    expect(checked, "anti-vacuity: every status was asserted").toBe(FIXTURE_STATUSES.length);
    expect(voids, "the void third was exercised").toBe(3);
    expect(live, "and the rest").toBe(FIXTURE_STATUSES.length - 3);
  });

  it("a held bracket result (needs_decision) and a match still in play list the parts they have: a restart makes Part 1 a replay while the match goes on", () => {
    expect(replayPlan({ status: "needs_decision", streamUrl: null, parts: [P1] }).parts).toEqual([P1]);
    expect(replayPlan({ status: "in_play", streamUrl: null, parts: [P1] }).parts).toEqual([P1]);
  });
});
