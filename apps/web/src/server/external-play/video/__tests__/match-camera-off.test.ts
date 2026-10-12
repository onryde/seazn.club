// T13, controller ruling C1: one player's camera evidence over ONE match is
// the UNION of every camera connection they had — a reload is a new peer, a
// rejoin after everyone left is a new session — and the off time is the part
// of the match window no connection had its camera on for. Every report here
// goes through the REAL per-report producer (videoOffCoverage), so the union
// is tested on what production feeds it, not on hand-built coverage.
//
// The threshold is the spec's (§5.2: off = a gap longer than 3x the sample
// cadence), taken from the module's own declarations at the cadence FLOOR,
// the smallest gap any single report can call off.
import { describe, expect, it } from "vitest";
import {
  PEER_REPORT_MIN_CADENCE_MS,
  VIDEO_OFF_GAP_CADENCES,
  videoOffCoverage,
  type VideoOffCoverage,
} from "../realtimekit";
import {
  GUARD_FAULT_FLAG_SECONDS,
  GUARD_FAULT_FLAG_STAMPS,
  MATCH_OFF_MIN_MS,
  matchCameraOff,
  stampedInMatch,
} from "../match-camera-off";

const ZERO = Date.parse("2026-10-11T10:00:00.000Z");
const at = (sec: number) => new Date(ZERO + Math.round(sec * 1000)).toISOString();
const win = (from: number, to: number) => ({ from: new Date(at(from)), to: new Date(at(to)) });

/** Samples every `step` seconds from `from` to `to` inclusive. */
const every = (from: number, to: number, step = 7) => {
  const out: number[] = [];
  for (let s = from; s <= to + 1e-9; s += step) out.push(Math.round(s * 1000) / 1000);
  return out;
};

/** A FINAL peer report (left, duration > 0), through the real producer. */
function connection(o: { joined: number; left: number; samples: number[]; events?: [string, number][] }) {
  const c: VideoOffCoverage = videoOffCoverage({
    participant: {
      joined_at: at(o.joined),
      left_at: at(o.left),
      duration: (o.left - o.joined) / 60,
      peer_report: {
        metadata: { events: (o.events ?? []).map(([name, s]) => ({ name, timestamp: at(s) })) },
        quality: { video_producer: o.samples.map((s) => ({ timestamp: at(s), frames_encoded: 140 })) },
      },
    },
  });
  if (c.incomplete) throw new Error("premise: a final report");
  return c;
}
const onThroughout = (joined: number, left: number) => connection({ joined, left, samples: every(joined, left) });
const offs = (r: ReturnType<typeof matchCameraOff>) => r.offIntervals.map((i) => [i.from, i.to, i.seconds] as const);

describe("matchCameraOff — the threshold is the spec's, from the declarations", () => {
  it("is 3 cadences at the 5 s cadence floor: 15 s", () => {
    expect(VIDEO_OFF_GAP_CADENCES * PEER_REPORT_MIN_CADENCE_MS, "spec §5.2 / ruling 2026-10-09").toBe(15_000);
    expect(MATCH_OFF_MIN_MS).toBe(VIDEO_OFF_GAP_CADENCES * PEER_REPORT_MIN_CADENCE_MS);
  });
});

describe("matchCameraOff — the union over connections", () => {
  it("one connection, camera on throughout: nothing off", () => {
    const r = matchCameraOff(win(60, 840), [onThroughout(0, 900)]);
    expect(r).toMatchObject({ offSeconds: 0, offIntervals: [], windowSeconds: 780, connections: 1 });
  });

  it("a RELOAD (two peers, 5 s apart) is not camera-off", () => {
    const r = matchCameraOff(win(60, 840), [onThroughout(0, 300), onThroughout(305, 900)]);
    expect(offs(r)).toEqual([]);
    expect(r.connections).toBe(2);
  });

  it("a reload that took 40 s is 40 s off — between the two connections", () => {
    const r = matchCameraOff(win(60, 840), [onThroughout(0, 300), onThroughout(340, 900)]);
    expect(offs(r)).toEqual([[at(300), at(340), 40]]);
    expect(r.offSeconds).toBe(40);
  });

  it("two tabs at once: one camera off while the other is on is NOT off", () => {
    const gappy = connection({ joined: 0, left: 900, samples: [...every(0, 196), ...every(392, 900)] });
    expect(gappy.offSeconds, "premise: alone, this connection shows a gap").toBeGreaterThan(0);
    expect(offs(matchCameraOff(win(0, 900), [gappy, onThroughout(0, 900)]))).toEqual([]);
  });

  it("a second tab opened and closed INSIDE a longer connection changes nothing", () => {
    // Union, not "the latest connection wins": the short one ends first.
    expect(offs(matchCameraOff(win(0, 900), [onThroughout(0, 900), onThroughout(100, 200)]))).toEqual([]);
  });

  it("a connection AFTER the match covers none of it, and never stretches the off time past the window", () => {
    expect(offs(matchCameraOff(win(60, 840), [onThroughout(900, 1000)]))).toEqual([[at(60), at(840), 780]]);
    expect(offs(matchCameraOff(win(60, 840), [onThroughout(0, 300), onThroughout(900, 1000)]))).toEqual([
      [at(300), at(840), 540],
    ]);
  });

  it("a gap in the one connection is off, and the camera's own events confirm it", () => {
    const samples = [...every(0, 196), ...every(392, 595)];
    const plain = matchCameraOff(win(0, 600), [connection({ joined: 0, left: 600, samples })]);
    expect(plain.offIntervals).toEqual([{ from: at(196), to: at(392), seconds: 196, confirmedByEvents: false }]);
    const evented = matchCameraOff(win(0, 600), [
      connection({ joined: 0, left: 600, samples, events: [["video_off", 200], ["video_on", 390]] }),
    ]);
    expect(evented.offIntervals).toEqual([{ from: at(196), to: at(392), seconds: 196, confirmedByEvents: true }]);
  });

  it("only the MATCH counts: an off gap is clipped to the window, and one outside it is nothing", () => {
    const c = connection({ joined: 0, left: 600, samples: [...every(0, 196), ...every(392, 595)] });
    expect(offs(matchCameraOff(win(300, 600), [c]))).toEqual([[at(300), at(392), 92]]);
    expect(offs(matchCameraOff(win(400, 600), [c]))).toEqual([]);
    // Before the first move, the room was open and the camera off: not the match.
    expect(offs(matchCameraOff(win(392, 595), [c]))).toEqual([]);
  });

  it("a REJOIN that left the match uncovered: off from the leave to the return", () => {
    // Session 1 ends when both leave at 300; session 2 opens at 420.
    const r = matchCameraOff(win(60, 840), [onThroughout(0, 300), onThroughout(420, 900)]);
    expect(offs(r)).toEqual([[at(300), at(420), 120]]);
  });

  it("NO connection at all in the match: the whole window is off", () => {
    expect(offs(matchCameraOff(win(60, 840), []))).toEqual([[at(60), at(840), 780]]);
    // …and a connection that ended before the match covers none of it.
    expect(offs(matchCameraOff(win(60, 840), [onThroughout(0, 50)]))).toEqual([[at(60), at(840), 780]]);
  });

  it("the edge: an uncovered stretch of exactly 15 s is not off; 15.001 s is", () => {
    expect(offs(matchCameraOff(win(0, 900), [onThroughout(0, 300), onThroughout(315, 900)]))).toEqual([]);
    expect(offs(matchCameraOff(win(0, 900), [onThroughout(0, 300), onThroughout(315.001, 900)]))).toEqual([
      [at(300), at(315.001), 15.001],
    ]);
  });

  it("a zero-length window has nothing off; an inverted one is refused", () => {
    expect(offs(matchCameraOff(win(100, 100), []))).toEqual([]);
    expect(() => matchCameraOff(win(200, 100), [])).toThrow(/window/);
  });
});

// T14 re-review 3, I-1 (controller ruling 2026-10-12): a gap OUR safeguard
// made — it left the meeting because it could not refuse a remote stream,
// and re-joined — is never the player's camera off. The stamped interval
// counts as covered; only what lies outside it is judged.
describe("matchCameraOff — our guard's faults are not the player's (I-1)", () => {
  const span = (from: number, to: number) => ({ from: new Date(at(from)), to: new Date(at(to)) });

  it("the positive pair: a 60 s gap is off; the same gap inside a stamped fault is not", () => {
    const reports = [onThroughout(0, 300), onThroughout(360, 900)];
    expect(offs(matchCameraOff(win(60, 840), reports)), "no stamp: the player's").toEqual([[at(300), at(360), 60]]);
    expect(offs(matchCameraOff(win(60, 840), reports, [span(300, 360)])), "stamped: ours").toEqual([]);
  });

  it("only the stamped part is excused — the rest of the gap, past 15 s, is still the player's", () => {
    const reports = [onThroughout(0, 300), onThroughout(400, 900)];
    expect(offs(matchCameraOff(win(60, 840), reports, [span(300, 320)]))).toEqual([[at(320), at(400), 80]]);
    // …and a remainder of 15 s or less is under the threshold, as any gap.
    expect(offs(matchCameraOff(win(60, 840), reports, [span(300, 385)]))).toEqual([]);
  });

  it("a fault with no camera at all (re-join never landed) excuses the window it covers, and no more", () => {
    expect(offs(matchCameraOff(win(60, 840), [onThroughout(0, 300)], [span(300, 840)]))).toEqual([]);
    expect(offs(matchCameraOff(win(60, 840), [onThroughout(0, 300)], [span(300, 600)]))).toEqual([[at(600), at(840), 240]]);
  });

  it("a fault outside the window changes nothing, and the empty list is the old answer", () => {
    const reports = [onThroughout(0, 300), onThroughout(360, 900)];
    expect(offs(matchCameraOff(win(60, 840), reports, [span(0, 50), span(850, 900)]))).toEqual([[at(300), at(360), 60]]);
    expect(matchCameraOff(win(60, 840), reports, [])).toEqual(matchCameraOff(win(60, 840), reports));
  });

  // T14 fix round 6, M-1 (adopted): a real guard fault TAKES the player out
  // of the meeting — failClosed leaves, the re-join is a new peer. So a stamp
  // excuses only the time no connection of the player was in the meeting; a
  // stamp held open while a connection sat in the meeting with its camera
  // off excuses nothing, and that time is judged as any other.
  it("M-1: stamped while ABSENT from the meeting ⇒ excused; stamped while PRESENT with the camera off ⇒ counted — the same 70 s, the same stamp", () => {
    // Sample instants are multiples of the 7 s step, so a gap's edges are exact.
    const stamp = [span(294, 364)];
    // Absent: the old peer left at 294, the re-join is a new peer at 364.
    const absent = [onThroughout(0, 294), onThroughout(364, 900)];
    expect(offs(matchCameraOff(win(60, 840), absent)), "premise: absent and unstamped, it is off").toEqual([[at(294), at(364), 70]]);
    expect(offs(matchCameraOff(win(60, 840), absent, stamp)), "absent: ours").toEqual([]);
    // Present: ONE connection 0–900, its camera producing nothing 294–364.
    const present = [connection({ joined: 0, left: 900, samples: [...every(0, 294), ...every(364, 900)] })];
    expect(offs(matchCameraOff(win(60, 840), present)), "premise: present and unstamped, the same gap").toEqual([[at(294), at(364), 70]]);
    expect(offs(matchCameraOff(win(60, 840), present, stamp)), "present without video: the player's, stamp or not").toEqual([[at(294), at(364), 70]]);
  });

  it("M-1: only the ABSENT part of a stamp is excused — a stamp straddling a leave excuses from the leave on, and a present-but-off remainder past 15 s still counts", () => {
    // In the meeting 0–336 with no video after 294; out 336–364; back at 364. Stamped 294–364.
    const reports = [connection({ joined: 0, left: 336, samples: every(0, 294) }), onThroughout(364, 900)];
    expect(offs(matchCameraOff(win(60, 840), reports)), "premise: unstamped, 294–364 is off").toEqual([[at(294), at(364), 70]]);
    expect(offs(matchCameraOff(win(60, 840), reports, [span(294, 364)])), "only 336–364 was ours").toEqual([[at(294), at(336), 42]]);
    // The pair: the same stamp, the camera on right up to the leave ⇒ nothing off.
    const honest = [onThroughout(0, 336), onThroughout(364, 900)];
    expect(offs(matchCameraOff(win(60, 840), honest, [span(294, 364)]))).toEqual([]);
  });

  it("M-1: absent → present → absent inside ONE stamp — both absent parts excused, the present-but-off middle counted", () => {
    // Out 294–350, a second tab in the meeting 350–413 with no video, out 413–504; stamped 294–504.
    const reports = [onThroughout(0, 294), connection({ joined: 350, left: 413, samples: [] }), onThroughout(504, 900)];
    expect(offs(matchCameraOff(win(60, 840), reports)), "premise").toEqual([[at(294), at(504), 210]]);
    expect(offs(matchCameraOff(win(60, 840), reports, [span(294, 504)]))).toEqual([[at(350), at(413), 63]]);
  });

  it("M-1: a second tab in the meeting during a stamp is a connected peer — its camera-off time is not excused", () => {
    // Tab A leaves at 294 (our fault); tab B sits in the meeting 210–504 with no video; C returns at 504.
    const reports = [onThroughout(0, 294), connection({ joined: 210, left: 504, samples: [] }), onThroughout(504, 900)];
    expect(offs(matchCameraOff(win(60, 840), reports)), "premise").toEqual([[at(294), at(504), 210]]);
    expect(offs(matchCameraOff(win(60, 840), reports, [span(294, 504)])), "B was in, camera off: counted").toEqual([[at(294), at(504), 210]]);
  });

  it("an inverted fault is refused — a stamp whose end precedes its start is not evidence", () => {
    expect(() => matchCameraOff(win(60, 840), [], [span(400, 300)])).toThrow(/fault/);
  });
});

// T14 fix round 5, ruling 1: a stamp excuses, it never HIDES. Past either
// threshold in one match — stamped time over GUARD_FAULT_FLAG_SECONDS, or more
// than GUARD_FAULT_FLAG_STAMPS stamps — the organiser is told, neutrally.
// Every case below is built from the two constants, so moving a threshold
// moves the test with it.
describe("stampedInMatch: our safeguard's stamps in ONE match, and when the organiser is told", () => {
  const span = (from: number, to: number) => ({ from: new Date(at(from)), to: new Date(at(to)) });
  const W = win(0, 3_600);
  /** `n` stamps of `each` seconds, 100 s apart, inside W. */
  const stamps = (n: number, each: number) => Array.from({ length: n }, (_, i) => span(100 + i * 100, 100 + i * 100 + each));

  it("the thresholds are the controller's ruling (2026-10-12): over 60 s in total, or more than 3 stamps", () => {
    expect([GUARD_FAULT_FLAG_SECONDS, GUARD_FAULT_FLAG_STAMPS]).toEqual([60, 3]);
  });

  it("no stamp: nothing stamped, no flag (the empty case)", () => {
    expect(stampedInMatch(W, [])).toEqual({ stamps: 0, seconds: 0, intervals: [], flag: false });
  });

  it("AT both thresholds — exactly the limit of stamps, exactly the limit of seconds between them — is no flag", () => {
    const each = GUARD_FAULT_FLAG_SECONDS / GUARD_FAULT_FLAG_STAMPS;
    const r = stampedInMatch(W, stamps(GUARD_FAULT_FLAG_STAMPS, each));
    expect([r.stamps, r.seconds], "premise: on both limits").toEqual([GUARD_FAULT_FLAG_STAMPS, GUARD_FAULT_FLAG_SECONDS]);
    expect(r.flag).toBe(false);
  });

  it("past the seconds (one stamp, one second over) is the flag; past the count (one stamp more, one second each) is the flag", () => {
    const long = stampedInMatch(W, [span(100, 100 + GUARD_FAULT_FLAG_SECONDS + 1)]);
    expect([long.stamps, long.seconds, long.flag]).toEqual([1, GUARD_FAULT_FLAG_SECONDS + 1, true]);
    const many = stampedInMatch(W, stamps(GUARD_FAULT_FLAG_STAMPS + 1, 1));
    expect([many.stamps, many.seconds, many.flag]).toEqual([GUARD_FAULT_FLAG_STAMPS + 1, GUARD_FAULT_FLAG_STAMPS + 1, true]);
  });

  it("only the match counts: a stamp wholly outside is not one, a stamp across an edge counts its part inside", () => {
    const outside = [span(-500, -400), span(3_700, 3_800), span(3_700, 3_700)];
    expect(stampedInMatch(W, outside)).toEqual({ stamps: 0, seconds: 0, intervals: [], flag: false });
    const across = stampedInMatch(W, [span(-30, GUARD_FAULT_FLAG_SECONDS), span(3_600 - 10, 3_650)]);
    expect([across.stamps, across.seconds], "60 s + 10 s inside: past the limit only together").toEqual([2, GUARD_FAULT_FLAG_SECONDS + 10]);
    expect(across.intervals).toEqual([
      { from: at(0), to: at(GUARD_FAULT_FLAG_SECONDS) },
      { from: at(3_590), to: at(3_600) },
    ]);
    expect(across.flag).toBe(true);
  });

  it("overlapping stamps are not counted twice in the seconds (each is still a stamp)", () => {
    const r = stampedInMatch(W, [span(100, 140), span(120, 160)]);
    expect([r.stamps, r.seconds, r.flag]).toEqual([2, 60, false]);
    expect(r.intervals).toEqual([{ from: at(100), to: at(160) }]);
  });

  it("a zero-length stamp inside the match is a stamp (a re-join that landed at once still left the meeting)", () => {
    const r = stampedInMatch(W, [...stamps(GUARD_FAULT_FLAG_STAMPS, 0), span(900, 900)]);
    expect([r.stamps, r.seconds, r.flag]).toEqual([GUARD_FAULT_FLAG_STAMPS + 1, 0, true]);
  });

  it("an inverted stamp is refused, as matchCameraOff refuses it", () => {
    expect(() => stampedInMatch(W, [span(400, 300)])).toThrow(/fault/);
  });
});
