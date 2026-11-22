// Seazn-hosted video Task 25: which recordings a viewer is offered, as which player, under which number — the merge of the
// interim (locked Cloudflare recordings, Task 14) and the replay move's rows (Task 24), PURE.
//
// Every expected value is the brief's rule, typed here (TEST-STRATEGY: never derive an expected value from the code under test):
// a playable row is an `embed` part under its stored number; a row on its way or failed keeps the `hls` part under its stored
// number; a deleted row is no part; a recording discovery has not listed is numbered after the highest stored number; the 30-day
// bound is Cloudflare's and applies to `hls` parts only (carry 1); the entries' order is kept and numbers may gap (carry 2).
// The bound is the relay's own declaration (DELETE_RECORDING_AFTER_DAYS), read from config, never from the module.
// No sport: the merge reads no sport rule.
import { describe, expect, it } from "vitest";
import { DELETE_RECORDING_AFTER_DAYS } from "@/server/relay/config";
import { REPLAY_ROW_STATES } from "../replay-move";
import { PART_OF_STATE, type ReplayEntry, UnknownReplayRowState, UnlistedUnlockedRecording, replayParts } from "../replay-parts";

const NOW = new Date("2026-11-22T12:00:00.000Z");
const KEEP_MS = DELETE_RECORDING_AFTER_DAYS * 24 * 60 * 60 * 1000;
const fresh = new Date(NOW.getTime() - 60 * 60_000);

function entry(cf: string, over: Partial<ReplayEntry> = {}): ReplayEntry {
  return { cfVideoId: cf, sessionId: "s1", sessionCreatedAt: fresh, locked: true, row: null, ...over };
}
const row = (partNo: number, state: string, over: Partial<NonNullable<ReplayEntry["row"]>> = {}): NonNullable<ReplayEntry["row"]> => ({
  partNo, state, removed: state === "deleted", listedVideo: state === "playable" ? `bunny-${partNo}` : null, ...over,
});
/** [partNo, player, the id it plays] for each part. */
const shape = (entries: ReplayEntry[], now = NOW) =>
  replayParts(entries, now).map((p) => [p.partNo, p.player, p.player === "embed" ? p.bunnyVideoId : p.cfVideoId]);

describe("replayParts — the interim and the replay host's parts, merged", () => {
  it("EMPTY CASE FIRST: no recording is no part", () => {
    expect(replayParts([], NOW)).toEqual([]);
  });

  it("with no replay row at all the numbering is Task 14's: 1..n in the order given, all hls", () => {
    expect(shape([entry("a"), entry("b"), entry("c")])).toEqual([[1, "hls", "a"], [2, "hls", "b"], [3, "hls", "c"]]);
  });

  it("the table knows every V542 state, and nothing else (held to replay-move.ts's list)", () => {
    expect(Object.keys(PART_OF_STATE).sort()).toEqual([...REPLAY_ROW_STATES].sort());
    expect(REPLAY_ROW_STATES.length, "states checked").toBe(7);
  });

  it("SWEEP every row state: playable → embed under its STORED number; found..encoding and failed → hls under its stored number; deleted → nothing", () => {
    const expected: Record<string, [number, string, string][]> = {
      found: [[4, "hls", "x"]], downloading: [[4, "hls", "x"]], fetching: [[4, "hls", "x"]], encoding: [[4, "hls", "x"]],
      failed: [[4, "hls", "x"]], playable: [[4, "embed", "bunny-4"]], deleted: [],
    };
    let checked = 0;
    for (const state of REPLAY_ROW_STATES) {
      expect(shape([entry("x", { row: row(4, state) })]), state).toEqual(expected[state]);
      checked++;
    }
    expect(checked, "states swept").toBe(7);
  });

  it("a playable row is embed WHETHER OR NOT a locked row exists; a row on its way with no locked row is no part (an unlocked uid is never signed)", () => {
    expect(shape([entry("x", { locked: false, row: row(1, "playable") })])).toEqual([[1, "embed", "bunny-1"]]);
    let checked = 0;
    for (const state of REPLAY_ROW_STATES.filter((s) => PART_OF_STATE[s] === "hls")) {
      expect(shape([entry("x", { locked: false, row: row(1, state) })]), state).toEqual([]);
      expect(shape([entry("x", { locked: true, row: row(1, state) })]), `${state}, locked`).toEqual([[1, "hls", "x"]]);
      checked++;
    }
    expect(checked, "on-the-way states checked").toBe(5);
  });

  it("a REMOVED row (deleted_at set) is no part whatever its state reads, the interim included", () => {
    let checked = 0;
    for (const state of REPLAY_ROW_STATES) {
      expect(shape([entry("x", { row: row(2, state, { removed: true }) })]), state).toEqual([]);
      checked++;
    }
    expect(checked).toBe(7);
  });

  it("a playable row the reader may NOT see (no listed video) is no part — never the Cloudflare copy the move deletes", () => {
    expect(shape([entry("x", { row: row(1, "playable", { listedVideo: null }) })])).toEqual([]);
  });

  it("the swap, one recording: no row → hls 1; found → hls 1; encoding → hls 1; playable → embed 1 (never two parts); deleted → none; failed → hls 1", () => {
    const steps: [string, ReplayEntry["row"], [number, string, string][]][] = [
      ["no row", null, [[1, "hls", "x"]]],
      ["found", row(1, "found"), [[1, "hls", "x"]]],
      ["encoding", row(1, "encoding"), [[1, "hls", "x"]]],
      ["playable", row(1, "playable"), [[1, "embed", "bunny-1"]]],
      ["deleted", row(1, "deleted"), []],
      ["failed", row(1, "failed"), [[1, "hls", "x"]]],
    ];
    for (const [name, r, want] of steps) expect(shape([entry("x", { row: r })]), name).toEqual(want);
    expect(steps.length).toBe(6);
  });

  it("two recordings, the first playable and the second encoding → parts 1 (embed) and 2 (hls)", () => {
    expect(shape([entry("a", { row: row(1, "playable") }), entry("b", { row: row(2, "encoding") })])).toEqual([[1, "embed", "bunny-1"], [2, "hls", "b"]]);
  });

  it("a recording discovery has not listed yet is numbered after the HIGHEST stored number — a removed row's included, as discovery's max(part_no) is", () => {
    // Part 1 listed and playable, part 2 removed by the organiser, a third recording locked but not yet listed: discovery will
    // give it 3, so the interim part is 3 now (never 2, which would move when discovery lists it).
    expect(shape([entry("a", { row: row(1, "playable") }), entry("b", { row: row(2, "deleted") }), entry("c")])).toEqual([[1, "embed", "bunny-1"], [3, "hls", "c"]]);
    // Two not yet listed: 3 and 4, in the order given.
    expect(shape([entry("a", { row: row(2, "encoding") }), entry("c"), entry("d")])).toEqual([[2, "hls", "a"], [3, "hls", "c"], [4, "hls", "d"]]);
  });

  it("carry 1: the 30-day bound is Cloudflare's — it leaves out hls parts at the edge (not a ms before) and NEVER an embed part; numbers keep and gap", () => {
    const old = new Date(NOW.getTime() - 40 * 24 * 60 * 60_000);
    const edge = (ms: number) => new Date(ms);
    const born = fresh.getTime();
    const entries = [
      entry("a", { sessionCreatedAt: fresh, row: row(1, "playable") }),
      entry("b", { sessionCreatedAt: fresh, row: row(2, "encoding") }),
      entry("c", { sessionCreatedAt: fresh }),
    ];
    expect(shape(entries, edge(born + KEEP_MS - 1)), "1 ms before Cloudflare's delete").toEqual([[1, "embed", "bunny-1"], [2, "hls", "b"], [3, "hls", "c"]]);
    expect(shape(entries, edge(born + KEEP_MS)), "at it: the embed stays, the hls parts go").toEqual([[1, "embed", "bunny-1"]]);
    expect(shape([entry("a", { sessionCreatedAt: old, row: row(5, "playable") })]), "an embed from a session long past the bound").toEqual([[5, "embed", "bunny-5"]]);
    // A part left out by the bound keeps the later part's number: an old unlisted recording still counts.
    expect(shape([entry("old", { sessionCreatedAt: old }), entry("new", { sessionCreatedAt: fresh })])).toEqual([[2, "hls", "new"]]);
  });

  it("carry 2: the parts keep the order they are given (recording order), with their stored numbers — never re-sorted or renumbered", () => {
    expect(shape([entry("a", { row: row(3, "playable") }), entry("b", { row: row(1, "encoding") }), entry("c", { row: row(7, "failed") })]))
      .toEqual([[3, "embed", "bunny-3"], [1, "hls", "b"], [7, "hls", "c"]]);
  });

  it("guards: a state the table does not know is refused by name; a recording neither locked nor listed is refused by name", () => {
    expect(() => replayParts([entry("x", { row: row(1, "archived") })], NOW)).toThrow(UnknownReplayRowState);
    expect(() => replayParts([entry("x", { row: row(1, "toString") })], NOW), "never a prototype key").toThrow(UnknownReplayRowState);
    expect(() => replayParts([entry("x", { locked: false, row: null })], NOW)).toThrow(UnlistedUnlockedRecording);
  });
});
