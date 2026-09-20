// The retention policy (C1: our 3-day promise; C2: videos BEFORE inputs —
// deleteInput leaks recordings). Pure; the sweep feeds it the port's lists.
import { describe, expect, it } from "vitest";
import { RECORDING_RETENTION_DAYS } from "../../config";
import { retentionPlan, type RetainedInput, type RetainedVideo } from "../retention";

const now = new Date("2026-09-14T10:00:00Z");
const daysAgo = (d: number, plusSeconds = 0) => new Date(now.getTime() - d * 86_400_000 + plusSeconds * 1000);
const v = (videoId: string, createdAt: Date, inputId: string | null = "in1", inProgress = false): RetainedVideo => ({ videoId, inputId, createdAt, inProgress });
const i = (ingestInputId: string, over: Partial<RetainedInput> = {}): RetainedInput => ({ inputRowId: `row-${ingestInputId}`, ingestInputId, sessionTerminal: true, sessionEndedAt: daysAgo(4), ...over });

describe("retentionPlan", () => {
  it("empty in → empty plan", () => {
    expect(retentionPlan([], [], now)).toEqual({ deleteVideos: [], deleteInputs: [], deferInputs: [] });
  });
  it("a video is deletable at exactly 3 days, not one second younger (C1 boundary); in-progress videos are still listed (the port answers 409)", () => {
    expect(retentionPlan([v("young", daysAgo(RECORDING_RETENTION_DAYS, 1))], [], now).deleteVideos).toEqual([]);
    expect(retentionPlan([v("old", daysAgo(RECORDING_RETENTION_DAYS))], [], now).deleteVideos).toEqual(["old"]);
    expect(retentionPlan([v("live", daysAgo(5), "in1", true)], [], now).deleteVideos).toEqual(["live"]);
  });
  it("an input is deleted only when its session is terminal for ≥ 3 days AND no video names it; otherwise deferred (C2)", () => {
    const input = i("in1");
    expect(retentionPlan([v("x", daysAgo(1), "in1")], [input], now)).toMatchObject({ deleteInputs: [], deferInputs: [input] });
    expect(retentionPlan([], [input], now)).toMatchObject({ deleteInputs: [input], deferInputs: [] });
    expect(retentionPlan([], [i("in2", { sessionEndedAt: daysAgo(RECORDING_RETENTION_DAYS, 1) })], now).deleteInputs).toEqual([]);
    expect(retentionPlan([], [i("in3", { sessionTerminal: false, sessionEndedAt: null })], now)).toEqual({ deleteVideos: [], deleteInputs: [], deferInputs: [] });
    // Task 2B mutation sweep — each row below killed a mutant nothing above could:
    // the input threshold's T row (ended EXACTLY 3 days ago → deletable), beside in2's T−1 s row;
    const atCutoff = i("in4", { sessionEndedAt: daysAgo(RECORDING_RETENTION_DAYS) });
    expect(retentionPlan([], [atCutoff], now).deleteInputs).toEqual([atCutoff]);
    // the two guards one at a time (in3 trips both at once): not terminal, however old its ended_at; terminal with no ended_at;
    expect(retentionPlan([], [i("in5", { sessionTerminal: false, sessionEndedAt: daysAgo(4) })], now)).toEqual({ deleteVideos: [], deleteInputs: [], deferInputs: [] });
    expect(retentionPlan([], [i("in6", { sessionTerminal: true, sessionEndedAt: null })], now)).toEqual({ deleteVideos: [], deleteInputs: [], deferInputs: [] });
    // and a still-RECORDING video holds its input (C2): its delete is listed but the port answers 409, so the video
    // survives this tick — deleting the input now would leak that recording.
    const recording = i("in7");
    expect(retentionPlan([v("rec", daysAgo(5), "in7", true)], [recording], now)).toEqual({ deleteVideos: ["rec"], deleteInputs: [], deferInputs: [recording] });
    // Fix round 1 (I1): an EXPIRED, FINISHED video that this same plan deletes still holds its input. Task 12 runs the video
    // deletes and then the input deletes from ONE plan without re-listing, so a video delete that does not land (a
    // list-then-409 race) would leak its recording. The input waits for the NEXT tick's listing to show the video gone.
    const sameRun = i("in8");
    expect(retentionPlan([v("old", daysAgo(RECORDING_RETENTION_DAYS), "in8")], [sameRun], now)).toEqual({ deleteVideos: ["old"], deleteInputs: [], deferInputs: [sameRun] });
  });
  it("a video of ANOTHER input does not hold this one", () => {
    expect(retentionPlan([v("x", daysAgo(1), "other")], [i("in1")], now).deleteInputs).toHaveLength(1);
  });
});
