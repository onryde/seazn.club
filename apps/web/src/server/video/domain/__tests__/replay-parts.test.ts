// Seazn-hosted video Task 25: which recordings a viewer is offered, as which player, under which number — the merge of the
// interim (locked Cloudflare recordings, Task 14) and the replay move's rows (Task 24), PURE.
//
// Every expected value is the brief's rule, typed here (TEST-STRATEGY: never derive an expected value from the code under test):
// a playable row is an `embed` part under its stored number; a row on its way or failed keeps the `hls` part under its stored
// number; a deleted row is no part; a recording discovery has not listed takes the running highest + 1, never a number a row holds,
// and is dropped once its input is fully discovered (review I1: discovery stores exactly these numbers); the 30-day bound is
// Cloudflare's and applies to `hls` parts only (carry 1); the entries' order is kept and numbers may gap (carry 2).
// The bound is the relay's own declaration (DELETE_RECORDING_AFTER_DAYS), read from config, never from the module.
// No sport: the merge reads no sport rule.
import { describe, expect, it } from "vitest";
import { DELETE_RECORDING_AFTER_DAYS } from "@/server/relay/config";
import { REPLAY_ROW_STATES } from "../replay-move";
import { PART_OF_STATE, type ReplayEntry, UnknownReplayRowState, UnlistedUnlockedRecording, partNumbers, replayParts } from "../replay-parts";

const NOW = new Date("2026-11-22T12:00:00.000Z");
const KEEP_MS = DELETE_RECORDING_AFTER_DAYS * 24 * 60 * 60 * 1000;
const fresh = new Date(NOW.getTime() - 60 * 60_000);

function entry(cf: string, over: Partial<ReplayEntry> = {}): ReplayEntry {
  return { cfVideoId: cf, sessionId: "s1", sessionCreatedAt: fresh, locked: true, inputDiscovered: false, row: null, ...over };
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

  it("a recording discovery has not listed yet after the stored ones is numbered after the HIGHEST of them — a removed row's included (its number stays taken)", () => {
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

// ─── Review I1 (carry 2): ONE numbering authority — discovery stores what the merge shows, so no part's number ever moves ───────
// Discovery (usecases/seazn-replays.ts) stores, for each recording it lists, exactly the number `partNumbers` gives it over the same
// entries. The property that makes a part keep its number: storing ANY recording's given number changes no other recording's number.
describe("partNumbers — the one numbering rule (review I1)", () => {
  const unstored = (n: number) => Array.from({ length: n }, () => ({ stored: null as number | null }));

  it("EMPTY CASE FIRST: no recording, no number; with nothing stored it is Task 14's 1..n", () => {
    expect(partNumbers([])).toEqual([]);
    expect(partNumbers(unstored(4))).toEqual([1, 2, 3, 4]);
  });

  it("a stored number stands; a recording with none takes the running highest + 1; a number a row already holds is never shared", () => {
    expect(partNumbers([{ stored: 1 }, { stored: null }, { stored: 3 }]), "the A/E/B shape after discovery: E keeps 2").toEqual([1, 2, 3]);
    expect(partNumbers([{ stored: null }, { stored: 2 }]), "s1 not listed yet, s2 stored 2: s1 keeps 1").toEqual([1, 2]);
    // A row stored out of order by the rule before this one (s2 stored 1 while s1 had none): s1 is never given 1 too.
    expect(partNumbers([{ stored: null }, { stored: 1 }, { stored: null }])).toEqual([2, 1, 3]);
    expect(partNumbers([{ stored: 2 }, { stored: null }, { stored: 3 }, { stored: null }]), "skips the held 3").toEqual([2, 4, 3, 5]);
  });

  it("SWEEP: from every start (each recording stored or not), storing ANY subset of the others under the numbers given moves no number", () => {
    // Every start over 4 recordings: each is unstored, or stored under the number the rule gave it then (as discovery stores it).
    let checked = 0;
    for (let start = 0; start < 16; start++) {
      const base = partNumbers(unstored(4));
      const before = partNumbers(base.map((n, i) => ({ stored: (start >> i) & 1 ? n : null })));
      for (let store = 0; store < 16; store++) {
        const after = partNumbers(before.map((n, i) => ({ stored: ((start | store) >> i) & 1 ? n : null })));
        expect(after, `start ${start.toString(2)}, store ${store.toString(2)}`).toEqual(before);
        checked++;
      }
    }
    expect(checked, "anti-vacuity: 16 starts x 16 subsets").toBe(256);
  });
});

describe("replayParts — review I1's two discovery paths keep every number (carry 2)", () => {
  const S1 = "s1";
  const S2 = "s2";
  /** [partNo, player, what it plays] — the viewer's pick is a part number, so each number must keep playing ITS recording. */
  const byNumber = (entries: ReplayEntry[]) => new Map(replayParts(entries, NOW).map((p) => [p.partNo, p.cfVideoId]));

  it("A, E (errored: locked, never discovered), B in one session: 1, 2, 3 before discovery; after it A and B keep 1 and 3, E is gone (its number unused), and B played on the host is still 3", () => {
    const before = [entry("A"), entry("E"), entry("B")];
    expect(shape(before), "before discovery: Task 14's 1..3").toEqual([[1, "hls", "A"], [2, "hls", "E"], [3, "hls", "B"]]);
    // Discovery lists A and B (E is `error`: no row) and stores the numbers the merge gave them, then marks the input discovered.
    const given = partNumbers(before.map(() => ({ stored: null })));
    const after = [
      entry("A", { inputDiscovered: true, row: row(given[0]!, "found") }),
      entry("E", { inputDiscovered: true }),
      entry("B", { inputDiscovered: true, row: row(given[2]!, "found") }),
    ];
    expect(shape(after), "after: A 1, B 3, no E").toEqual([[1, "hls", "A"], [3, "hls", "B"]]);
    expect(byNumber(after).get(3), "the viewer's Part 3 still plays B").toBe(byNumber(before).get(3));
    expect(byNumber(after).get(1), "and Part 1 still plays A").toBe(byNumber(before).get(1));
    const moved = [after[0]!, after[1]!, entry("B", { inputDiscovered: true, row: row(3, "playable") })];
    expect(shape(moved), "B moved to the host: still Part 3").toEqual([[1, "hls", "A"], [3, "embed", "bunny-3"]]);
    // Before the input is marked (discovery not finished), E is still offered under its 2.
    expect(shape([after[0]!, entry("E"), after[2]!]).map((p) => p[0])).toEqual([1, 2, 3]);
  });

  it("session 1's listing failed and was skipped, session 2 listed first: A (s1) keeps 1 and B (s2) keeps 2 — and when s1 is listed later, still 1 and 2", () => {
    const before = [entry("A", { sessionId: S1 }), entry("B", { sessionId: S2 })];
    expect(shape(before)).toEqual([[1, "hls", "A"], [2, "hls", "B"]]);
    const s2Given = partNumbers([{ stored: null }, { stored: null }])[1]!;
    const s2Listed = [entry("A", { sessionId: S1 }), entry("B", { sessionId: S2, inputDiscovered: true, row: row(s2Given, "found") })];
    expect(shape(s2Listed), "s2 listed first: B stores 2, A keeps 1").toEqual([[1, "hls", "A"], [2, "hls", "B"]]);
    const s1Given = partNumbers(s2Listed.map((e) => ({ stored: e.row?.partNo ?? null })))[0]!;
    const both = [entry("A", { sessionId: S1, inputDiscovered: true, row: row(s1Given, "found") }), s2Listed[1]!];
    expect(shape(both), "s1 listed later: still 1 and 2").toEqual([[1, "hls", "A"], [2, "hls", "B"]]);
    for (const n of [1, 2]) expect(byNumber(both).get(n), `Part ${n} plays the same recording throughout`).toBe(byNumber(before).get(n));
  });

  it("a row decides once it exists: an input marked discovered never hides a recording that HAS a row", () => {
    expect(shape([entry("A", { inputDiscovered: true, row: row(1, "encoding") })])).toEqual([[1, "hls", "A"]]);
    expect(shape([entry("A", { inputDiscovered: true, row: row(1, "playable") })])).toEqual([[1, "embed", "bunny-1"]]);
  });
});
