// videoOffCoverage — camera evidence for the organiser, parsed from a
// RealtimeKit peer report (spec §5.2 as amended 5903962d4; controller
// addendum 3 to Task 7). Pure: no DB, no network, no configuration.
//
// EVERY expected value below is either hand arithmetic on timestamps this
// file chose, or a number from the spike's driver log
// (docs/superpowers/specs/evidence/2026-10-09-chess-spikes/rtk-peer-report.log).
// None is read back from the parser.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { RealtimeKitError, videoOffCoverage, type VideoOffCoverage } from "../realtimekit";

type RecordedData = {
  participant: {
    left_at: string | null;
    duration: number;
    peer_report: {
      quality: {
        video_producer: { timestamp: string }[];
        video_producer_cumulative: { issues: { no_video_fraction: number } };
      };
    };
  };
};
const RECORDED_BODY = JSON.parse(
  readFileSync(join(__dirname, "../../__fixtures__/realtimekit/peer-report-recorded.json"), "utf8"),
) as { data: RecordedData };
/** A fresh deep copy each time, so no test can leak a mutation into another. */
const recorded = (): RecordedData => structuredClone(RECORDED_BODY.data);

/** A deep copy of `r` with one field overwritten at `path` — the malformed
 *  cases need shapes the typed builder deliberately cannot express. */
function withField(r: object, path: (string | number)[], value: unknown): unknown {
  const copy = structuredClone(r) as Record<string | number, unknown>;
  let cur = copy;
  for (const k of path.slice(0, -1)) cur = cur[k] as Record<string | number, unknown>;
  cur[path[path.length - 1]!] = value;
  return copy;
}

/** Seconds after this instant are how the synthetic reports below are written. */
const ZERO = Date.UTC(2026, 9, 1, 12, 0, 0);
// Rounded: 1.005 * 1000 is 1004.999…, and Date truncates.
const at = (sec: number) => new Date(ZERO + Math.round(sec * 1000)).toISOString();

/** A synthetic finalised peer report in the recorded payload's shape. */
function report(o: {
  joined?: number;
  left?: number | null;
  duration?: number | null;
  samples?: number[];
  events?: [string, number][];
  noVideoFraction?: number;
}) {
  const joined = o.joined ?? 0;
  const left = o.left === undefined ? 600 : o.left;
  const duration = o.duration !== undefined ? o.duration : left === null ? 0 : (left - joined) / 60;
  return {
    participant: {
      id: "conn-1",
      user_id: "participant-1",
      custom_participant_id: "person-1",
      joined_at: at(joined),
      left_at: left === null ? null : at(left),
      duration,
      peer_report: {
        metadata: { events: (o.events ?? []).map(([name, s]) => ({ name, timestamp: at(s) })) },
        quality: {
          video_producer: (o.samples ?? []).map((s) => ({ timestamp: at(s), frames_encoded: 140 })),
          video_producer_cumulative: { issues: { no_video_fraction: o.noVideoFraction ?? 0 } },
        },
      },
    },
  };
}

/** Samples every `step` seconds from `from` to `to` inclusive. */
const every = (from: number, to: number, step = 7) => {
  const out: number[] = [];
  for (let s = from; s <= to + 1e-9; s += step) out.push(Math.round(s * 1000) / 1000);
  return out;
};

const complete = (c: VideoOffCoverage) => {
  if (c.incomplete) throw new Error(`premise: expected a complete coverage, got incomplete (${c.reason})`);
  return c;
};
const spans = (c: VideoOffCoverage) =>
  complete(c).offIntervals.map((i) => [i.from, i.to, i.seconds] as const);

describe("videoOffCoverage — the recorded spike report", () => {
  // Driver log (rtk-peer-report.log), never the parser:
  //   camera OFF 18:09:14.609, camera ON 18:12:14.621 (180 s off)
  //   FINAL: n=51 samples, ~7 s cadence, ONE gap 18:09:11 -> 18:12:20 (189 s),
  //   events video_off 18:09:14 / video_on 18:12:14, no_video_fraction = 0.
  const DRIVER_OFF = Date.parse("2026-10-09T18:09:14.609Z");
  const DRIVER_ON = Date.parse("2026-10-09T18:12:14.621Z");
  const LOG_CADENCE_S = 7;

  it("finds exactly the one off phase the driver ran, confirmed by the events", () => {
    const c = complete(videoOffCoverage(recorded()));
    expect(c.sampleCount, "log: n=51").toBe(51);
    expect(c.offIntervals.length, "log: ONE gap").toBe(1);
    const gap = c.offIntervals[0]!;
    // The log names the gap to the second.
    expect(gap.from.slice(0, 19), "log: gap starts 18:09:11").toBe("2026-10-09T18:09:11");
    expect(gap.to.slice(0, 19), "log: gap ends 18:12:20").toBe("2026-10-09T18:12:20");
    expect(Math.round(gap.seconds), "log: 189 s").toBe(189);
    // It brackets the driver's real off phase, by no more than one cadence a side.
    const from = Date.parse(gap.from);
    const to = Date.parse(gap.to);
    expect(from).toBeLessThanOrEqual(DRIVER_OFF);
    expect(to).toBeGreaterThanOrEqual(DRIVER_ON);
    expect(DRIVER_OFF - from).toBeLessThanOrEqual(LOG_CADENCE_S * 1000);
    expect(to - DRIVER_ON).toBeLessThanOrEqual(LOG_CADENCE_S * 1000);
    expect(gap.confirmedByEvents, "video_off 18:09:14 / video_on 18:12:14 lie inside it").toBe(true);
    expect(c.offSeconds).toBe(gap.seconds);
    // Events: off 180 s (driver) plus the final video_off at leave, a fraction of a second.
    expect(c.eventOffSeconds).toBeGreaterThanOrEqual(180);
    expect(c.eventOffSeconds).toBeLessThan(181);
    expect(c.cadenceSeconds, "log: ~7 s cadence").toBeGreaterThan(6.9);
    expect(c.cadenceSeconds).toBeLessThanOrEqual(7);
  });

  it("covers [joined_at, left_at], which agrees with the report's own duration field", () => {
    const r = recorded();
    const c = complete(videoOffCoverage(r));
    const declaredSeconds = (r.participant.duration as number) * 60;
    expect(declaredSeconds, "premise: log says duration 9.02 min").toBeGreaterThan(540);
    expect(Math.abs(c.coveredSeconds - declaredSeconds)).toBeLessThan(1);
  });

  it("never reads no_video_fraction: 0 (as recorded, with 3 min off) and 1 give the same answer", () => {
    const r0 = recorded();
    expect(
      r0.participant.peer_report.quality.video_producer_cumulative.issues.no_video_fraction,
      "premise: the recorded value is 0 despite three minutes off",
    ).toBe(0);
    const r1 = recorded();
    r1.participant.peer_report.quality.video_producer_cumulative.issues.no_video_fraction = 1;
    expect(videoOffCoverage(r1)).toEqual(videoOffCoverage(r0));
  });

  it("the frozen in-session snapshot (log 18:05:27: one sample, duration 0, not left) is incomplete", () => {
    const r = recorded();
    r.participant.peer_report.quality.video_producer = r.participant.peer_report.quality.video_producer.slice(0, 1);
    r.participant.left_at = null;
    r.participant.duration = 0;
    expect(videoOffCoverage(r)).toEqual({ incomplete: true, reason: "not_left", sampleCount: 1 });
  });
});

describe("videoOffCoverage — synthetic sequences", () => {
  it("sweeps the shapes the ruling names and reports the count", () => {
    // Window [0, 600] unless stated. Cadence 7 s ⇒ threshold 21 s.
    const cases: { name: string; r: ReturnType<typeof report>; want: [number, number, number][] }[] = [
      {
        name: "EMPTY: finalised with no samples at all ⇒ the whole window is off",
        r: report({ samples: [] }),
        want: [[0, 600, 600]],
      },
      {
        name: "camera on throughout ⇒ nothing off",
        r: report({ samples: every(7, 595) }),
        want: [],
      },
      {
        name: "gap at the START: join → first sample 60 s",
        r: report({ samples: every(60, 592) }),
        want: [[0, 60, 60]],
      },
      {
        name: "gap at the END: last sample 399 → leave 600",
        r: report({ samples: every(7, 399) }),
        want: [[399, 600, 201]],
      },
      {
        name: "one long gap 203 → 503",
        r: report({ samples: [...every(7, 203), ...every(503, 594)] }),
        want: [[203, 503, 300]],
      },
      {
        name: "two gaps, one at each end of a short on-phase",
        r: report({ samples: every(98, 196) }),
        want: [
          [0, 98, 98],
          [196, 600, 404],
        ],
      },
      {
        name: "JITTER: 6.5 / 7.5 s deltas and one 20.9 s delta stay under 3 × 7 = 21 s",
        r: report({ samples: [7, 13.5, 21, 27.5, 35, 42, 49, 69.9, 76.9, 83.4, 90.9, 97.9, ...every(104.9, 594.9)] }),
        want: [],
      },
      {
        name: "EXACTLY 3 × 7 = 21 s apart is not a gap (the rule is strictly greater)",
        r: report({ samples: [...every(7, 49), ...every(70, 595)] }),
        want: [],
      },
      {
        name: "just over the threshold: one 21.1 s delta IS a gap",
        r: report({ samples: [...every(7, 49), ...every(70.1, 588.1)] }),
        want: [[49, 70.1, 21.1]],
      },
      {
        name: "a single sample in a finalised report ⇒ off on both sides of it",
        r: report({ samples: [300] }),
        want: [
          [0, 300, 300],
          [300, 600, 300],
        ],
      },
    ];
    let checked = 0;
    let withGaps = 0;
    for (const c of cases) {
      const got = spans(videoOffCoverage(c.r));
      const want = c.want.map(([f, t, s]) => [at(f), at(t), s] as const);
      expect(got.length, c.name).toBe(want.length);
      got.forEach(([f, t, s], i) => {
        expect(f, `${c.name} [${i}] from`).toBe(want[i]![0]);
        expect(t, `${c.name} [${i}] to`).toBe(want[i]![1]);
        expect(s, `${c.name} [${i}] seconds`).toBeCloseTo(want[i]![2], 3);
      });
      const off = complete(videoOffCoverage(c.r)).offSeconds;
      expect(off, `${c.name} offSeconds`).toBeCloseTo(
        c.want.reduce((n, [, , s]) => n + s, 0),
        3,
      );
      if (want.length > 0) withGaps += 1;
      checked += 1;
    }
    expect(checked, "anti-vacuity").toBe(cases.length);
    expect(checked).toBeGreaterThanOrEqual(9);
    expect(withGaps, "both outcomes are exercised").toBeGreaterThan(0);
    expect(checked - withGaps, "both outcomes are exercised").toBeGreaterThan(0);
  });

  it("FLASHING CAMERA: one sample every 180 s is NOT hidden by its own median cadence", () => {
    // The deltas are all 180 s, so a raw 3 × median threshold would be 540 s
    // and report 0 s off for a player whose camera showed one frame-burst
    // every three minutes. The cadence is capped at the measured 7 s.
    const flash = report({ samples: [10, 190, 370, 550] });
    expect(spans(videoOffCoverage(flash))).toEqual([
      [at(10), at(190), 180],
      [at(190), at(370), 180],
      [at(370), at(550), 180],
      [at(550), at(600), 50],
    ]);
    // Two deltas, one normal and one long: the median of [7, 180] is 93.5.
    const two = report({ samples: [7, 14, 194], left: 200 });
    expect(spans(videoOffCoverage(two))).toEqual([[at(14), at(194), 180]]);
  });

  it("DUPLICATE samples: every sample reported twice is still a camera on throughout", () => {
    // Review I3: without de-duplication the deltas alternate 0 and 7 s, the
    // median collapses to 0, and a camera on for the whole match read
    // 600 of 600 s off. Hand arithmetic: on throughout ⇒ 0 s off, and the
    // true cadence is still 7 s.
    const once = every(7, 595);
    const doubled = report({ samples: once.flatMap((t) => [t, t]) });
    expect(doubled.participant.peer_report.quality.video_producer.length, "premise: doubled").toBe(once.length * 2);
    const c = complete(videoOffCoverage(doubled));
    expect(c.offIntervals).toEqual([]);
    expect(c.offSeconds).toBe(0);
    expect(c.cadenceSeconds, "the duplicates do not distort the cadence").toBe(7);
  });

  it("NEAR-duplicates a few ms apart behave the same: 0 s off, cadence floored at 5 s", () => {
    // t and t + 3 ms: identical-timestamp de-duplication cannot merge these,
    // so the 5 s floor is what keeps the threshold at 15 s.
    const near = report({ samples: every(7, 595).flatMap((t) => [t, t + 0.003]) });
    const c = complete(videoOffCoverage(near));
    expect(c.offIntervals).toEqual([]);
    expect(c.offSeconds).toBe(0);
    expect(c.cadenceSeconds).toBe(5);
  });

  it("the cadence FLOOR is 5 s: under a 3 s cadence a 12 s hole is not a gap and a 16 s hole is", () => {
    // Floor justified by the measurement: 50 deltas of 6.99–7.003 s in the
    // spike, so a median below 5 s is a data-shape artefact (duplicates,
    // bursts), not the SDK's cadence. 5 s keeps the threshold at >= 15 s.
    const twelve = report({ samples: [...every(3, 300, 3), ...every(312, 597, 3)] });
    expect(spans(videoOffCoverage(twelve)), "12 s < 3 × 5 s").toEqual([]);
    expect(complete(videoOffCoverage(twelve)).cadenceSeconds).toBe(5);
    const sixteen = report({ samples: [...every(3, 300, 3), ...every(316, 598, 3)] });
    expect(spans(videoOffCoverage(sixteen)), "16 s > 3 × 5 s").toEqual([[at(300), at(316), 16]]);
  });

  it("samples arriving out of order give the same answer, and the input is not mutated", () => {
    const ordered = report({ samples: [...every(7, 203), ...every(503, 594)] });
    const shuffled = structuredClone(ordered);
    shuffled.participant.peer_report.quality.video_producer.reverse();
    const before = structuredClone(shuffled);
    expect(videoOffCoverage(shuffled)).toEqual(videoOffCoverage(ordered));
    expect(shuffled, "the caller's report is untouched").toEqual(before);
  });

  it("SECOND CALL on the same report returns an equal result", () => {
    const r = recorded();
    expect(videoOffCoverage(r)).toEqual(videoOffCoverage(r));
  });

  it("samples outside [joined_at, left_at] are ignored", () => {
    const inside = report({ samples: [...every(7, 203), ...every(503, 594)] });
    const outside = report({ samples: [-30, -5, ...every(7, 203), ...every(503, 594), 605, 700] });
    expect(spans(videoOffCoverage(outside))).toEqual(spans(videoOffCoverage(inside)));
  });
});

describe("videoOffCoverage — the events cross-check", () => {
  const gapped = (events: [string, number][]) =>
    report({ samples: [...every(7, 203), ...every(503, 594)], events });

  it("sweeps event shapes and reports the count", () => {
    const cases: { name: string; events: [string, number][]; confirmed: boolean; eventOff: number }[] = [
      { name: "no events at all", events: [], confirmed: false, eventOff: 0 },
      { name: "off/on inside the gap", events: [["video_off", 205], ["video_on", 500]], confirmed: true, eventOff: 295 },
      {
        name: "off/on elsewhere, while samples kept flowing (disagreement surfaced)",
        events: [["video_off", 100], ["video_on", 150]],
        confirmed: false,
        eventOff: 50,
      },
      {
        name: "video_off never followed by video_on closes at leave",
        events: [["video_off", 450]],
        confirmed: true,
        eventOff: 150,
      },
      {
        name: "precall events before join are clamped to the window",
        events: [["video_on", -1], ["video_off", -0.5], ["video_on", 3]],
        confirmed: false,
        eventOff: 3,
      },
      {
        name: "repeated video_off keeps the FIRST start",
        events: [["video_off", 205], ["video_off", 300], ["video_on", 500]],
        confirmed: true,
        eventOff: 295,
      },
      {
        name: "unrelated event names are ignored",
        events: [["audio_off", 210], ["disconnect", 220], ["media_permission", 230]],
        confirmed: false,
        eventOff: 0,
      },
    ];
    let checked = 0;
    for (const c of cases) {
      const cov = complete(videoOffCoverage(gapped(c.events)));
      expect(cov.offIntervals.length, `${c.name}: the sample gap is found regardless of events`).toBe(1);
      expect(cov.offIntervals[0]!.confirmedByEvents, c.name).toBe(c.confirmed);
      expect(cov.eventOffSeconds, c.name).toBeCloseTo(c.eventOff, 3);
      checked += 1;
    }
    expect(checked, "anti-vacuity").toBe(cases.length);
    expect(checked).toBeGreaterThanOrEqual(7);
  });
});

describe("videoOffCoverage — incomplete and malformed reports", () => {
  it("incomplete until left_at is set AND duration > 0 (the caller retries)", () => {
    const cases: { name: string; r: ReturnType<typeof report>; reason: string }[] = [
      { name: "left_at null", r: report({ left: null, duration: 4, samples: [7, 14] }), reason: "not_left" },
      { name: "left_at null and duration 0", r: report({ left: null, samples: [7] }), reason: "not_left" },
      { name: "left but duration 0", r: report({ duration: 0, samples: [7, 14, 21] }), reason: "not_finalised" },
      { name: "left but duration missing", r: report({ duration: null, samples: [7] }), reason: "not_finalised" },
    ];
    let checked = 0;
    for (const c of cases) {
      const got = videoOffCoverage(c.r);
      expect(got, c.name).toEqual({
        incomplete: true,
        reason: c.reason,
        sampleCount: c.r.participant.peer_report.quality.video_producer.length,
      });
      checked += 1;
    }
    expect(checked, "anti-vacuity").toBe(cases.length);
  });

  it("a report it cannot read THROWS — it never becomes 'camera on' or 'camera off'", () => {
    const cases: { name: string; r: unknown }[] = [
      { name: "null", r: null },
      { name: "no participant", r: {} },
      { name: "joined_at missing", r: withField(report({ samples: [7] }), ["participant", "joined_at"], undefined) },
      { name: "joined_at not a date", r: withField(report({ samples: [7] }), ["participant", "joined_at"], "soon") },
      { name: "left_at not a date", r: withField(report({ samples: [7] }), ["participant", "left_at"], "later") },
      { name: "left_at before joined_at", r: report({ joined: 100, left: 50, duration: 1, samples: [] }) },
      {
        name: "a sample with no timestamp",
        r: withField(report({ samples: [7, 14] }), ["participant", "peer_report", "quality", "video_producer", 1, "timestamp"], undefined),
      },
      {
        name: "video_producer is not a list",
        r: withField(report({ samples: [7] }), ["participant", "peer_report", "quality", "video_producer"], { n: 1 }),
      },
      {
        name: "an event with a bad timestamp",
        r: withField(
          report({ samples: [7], events: [["video_off", 9]] }),
          ["participant", "peer_report", "metadata", "events", 0, "timestamp"],
          "not-a-date",
        ),
      },
    ];
    let checked = 0;
    for (const c of cases) {
      expect(() => videoOffCoverage(c.r), c.name).toThrow(RealtimeKitError);
      checked += 1;
    }
    expect(checked, "anti-vacuity").toBe(cases.length);
    expect(checked).toBeGreaterThanOrEqual(9);
  });
});
