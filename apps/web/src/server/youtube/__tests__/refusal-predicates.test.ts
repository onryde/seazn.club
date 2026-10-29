// YouTube Connect, B6 batch review m4: the two refusal predicates of port.ts (`isLiveBlockedRefusal`, `isDeadGrantRefusal`).
//
// Expected values are Google's own: a "not authorized to <live>" refusal is the reason `insufficientLivePermissions` on a
// reconnect-class error (the liveBroadcasts / liveStreams pages), and every other reconnect refusal is a dead grant. The
// reason string is typed here, never imported from port.ts, so a change to the constant cannot move the test with it.
//
// No database, no sport: a predicate over an error object.
import { describe, expect, it } from "vitest";
import { YouTubeError, isDeadGrantRefusal, isLiveBlockedRefusal, YOUTUBE_ERROR_CODES, type YoutubeErrorCode } from "@/server/youtube/port";

/** Google's reason for "the request is not authorized to <live>". */
const LIVE_PERMISSIONS = "insufficientLivePermissions";

describe("the refusal predicates answer a plain boolean (B6 batch review m4)", () => {
  it("EMPTY CASE FIRST: a value that is not a YouTubeError is neither refusal, whatever it carries", () => {
    const lookalike = { code: "youtube_reconnect_needed", reason: LIVE_PERMISSIONS };
    for (const v of [undefined, null, "youtube_reconnect_needed", 0, new Error("youtube_reconnect_needed"), lookalike]) {
      expect(isLiveBlockedRefusal(v), String(v)).toBe(false);
      expect(isDeadGrantRefusal(v), String(v)).toBe(false);
    }
  });

  it("the truth table over EVERY code and the reasons that matter: only a reconnect refusal can be either, and never both", () => {
    const reasons = ["", LIVE_PERMISSIONS, "invalidGrant", "liveStreamingNotEnabled"];
    let rows = 0;
    for (const code of YOUTUBE_ERROR_CODES) {
      for (const reason of reasons) {
        const err = new YouTubeError(code, reason);
        const reconnect = code === "youtube_reconnect_needed";
        expect(isLiveBlockedRefusal(err), `${code}/${reason}: live blocked`).toBe(reconnect && reason === LIVE_PERMISSIONS);
        expect(isDeadGrantRefusal(err), `${code}/${reason}: dead grant`).toBe(reconnect && reason !== LIVE_PERMISSIONS);
        rows++;
      }
    }
    expect(rows, "anti-vacuity: every code against every reason").toBe(YOUTUBE_ERROR_CODES.length * reasons.length);
    expect(YOUTUBE_ERROR_CODES.length).toBeGreaterThan(1);
  });

  it("neither narrows the error's type: the FALSE branch of a refusal check still has the error's fields (a type guard left `never` there, and disconnect.ts read the code first to get round it)", () => {
    // This is a COMPILE-TIME pin, judged by `tsc`: with an `err is YouTubeError` return type the `!` branch below narrows `err` to
    // `never` and `err.code` is "Property 'code' does not exist on type 'never'". At run time it checks the same values.
    const code: YoutubeErrorCode = "youtube_unavailable";
    const err = new YouTubeError(code);
    let seen = "";
    if (!isDeadGrantRefusal(err)) seen += err.code;
    if (!isLiveBlockedRefusal(err)) seen += `|${err.reason}|${err.code}`;
    expect(seen).toBe("youtube_unavailable||youtube_unavailable");
  });
});
