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
import { MATCH_OFF_MIN_MS, matchCameraOff } from "../match-camera-off";

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
