import { autoStartVerdict, autoStopDeadline, autoStopVerdict, type AutoStartFacts } from "../auto-stream";
import { describe, expect, it } from "vitest";
import {
  courtCodeView,
  courtFocus,
  courtPhoneStatus,
  courtRestartsAfter,
  courtStartFacts,
  courtTailEndsAt,
  startingOfCurrent,
  type CourtMatchFacts,
} from "../court-stream";

describe("court resolver", () => {
  const T = (hhmm: string) => new Date(`2026-11-15T${hhmm}:00Z`);
  const m = (
    id: string,
    o: Partial<CourtMatchFacts> = {},
  ): CourtMatchFacts => ({
    fixtureId: id,
    status: "scheduled",
    streamed: true,
    latched: false,
    kickoffAt: null,
    calledAt: null,
    ready: true,
    scheduledAt: null,
    roundNo: 1,
    seqInRound: 1,
    openSession: null,
    ...o,
  });
  const open = (sid: string, at: string, byOrganiser = false) => ({
    sid,
    createdAt: T(at),
    byOrganiser,
  });

  it("nothing streamed: no focus, no next; scoring is the first unstarted match", () => {
    const f = courtFocus([
      m("a", { streamed: false, scheduledAt: T("14:00") }),
      m("b", { streamed: false, scheduledAt: T("13:00") }),
    ]);
    expect(f).toEqual({
      current: null,
      start: null,
      handover: false,
      focusFixtureId: null,
      nextFixtureId: null,
      scoringFixtureId: "b",
    });
  });
  it("one streamed match in play, nothing open: start it", () => {
    expect(
      courtFocus([m("a", { status: "in_play", kickoffAt: T("10:00") })]),
    ).toMatchObject({
      current: null,
      start: "a",
      handover: false,
      focusFixtureId: "a",
    });
  });
  it("A in its tail (decided, open), B kicks off: handover to B (O6)", () => {
    const f = courtFocus([
      m("a", {
        status: "decided",
        kickoffAt: null,
        openSession: open("sa", "10:00"),
      }),
      m("b", { status: "in_play", kickoffAt: T("10:40") }),
    ]);
    expect(f).toMatchObject({
      current: { fixtureId: "a", sid: "sa" },
      start: "b",
      handover: true,
      focusFixtureId: "b",
    });
  });
  it("A in play 10:00 with its session, B in play 10:01: B starts, handover", () => {
    const f = courtFocus([
      m("a", {
        status: "in_play",
        kickoffAt: T("10:00"),
        openSession: open("sa", "10:00"),
      }),
      m("b", { status: "in_play", kickoffAt: T("10:01") }),
    ]);
    expect(f).toMatchObject({ start: "b", handover: true });
  });
  it("A in play and newer than B, A open: no handover, focus A", () => {
    const f = courtFocus([
      m("a", {
        status: "in_play",
        kickoffAt: T("10:05"),
        openSession: open("sa", "10:05"),
      }),
      m("b", { status: "in_play", kickoffAt: T("10:01") }),
    ]);
    expect(f).toMatchObject({
      current: { fixtureId: "a" },
      start: null,
      handover: false,
      focusFixtureId: "a",
    });
  });
  it("equal kickoffs: the greater fixture id wins (and the lesser does not)", () => {
    expect(
      courtFocus([
        m("a", { status: "in_play", kickoffAt: T("10:00") }),
        m("b", { status: "in_play", kickoffAt: T("10:00") }),
      ]).start,
    ).toBe("b");
  });
  it("a latched match is never start, even newest; a latched match's open session (desk restart) is still current", () => {
    const f = courtFocus([
      m("a", {
        status: "in_play",
        kickoffAt: T("10:05"),
        latched: true,
        openSession: open("sa", "10:06"),
      }),
      m("b", { status: "in_play", kickoffAt: T("10:00") }),
    ]);
    expect(f).toMatchObject({
      current: { fixtureId: "a", sid: "sa" },
      start: null,
    });
  });
  it("an unstreamed match in play is never start", () => {
    expect(
      courtFocus([
        m("a", { status: "in_play", kickoffAt: T("10:00"), streamed: false }),
      ]).start,
    ).toBeNull();
  });
  it("next skips latched and unstreamed matches; scoring skips neither unstreamed", () => {
    const f = courtFocus([
      m("c", { streamed: false, scheduledAt: T("11:00") }),
      m("d", { latched: true, scheduledAt: T("11:30") }),
      m("e", { scheduledAt: T("12:00") }),
    ]);
    expect(f).toMatchObject({
      nextFixtureId: "e",
      scoringFixtureId: "c",
      focusFixtureId: "e",
    });
  });
  it("a held call outranks an earlier planned match in next and scoring", () => {
    const f = courtFocus([
      m("p", { scheduledAt: T("11:00") }),
      m("q", { scheduledAt: T("12:00"), calledAt: T("10:30") }),
    ]);
    expect(f).toMatchObject({ nextFixtureId: "q", scoringFixtureId: "q" });
  });
  it("equal planned times fall back to round, then seq, then id", () => {
    const f = courtFocus([
      m("z", { scheduledAt: T("11:00"), roundNo: 2, seqInRound: 1 }),
      m("y", { scheduledAt: T("11:00"), roundNo: 1, seqInRound: 2 }),
      m("x", { scheduledAt: T("11:00"), roundNo: 1, seqInRound: 3 }),
    ]);
    expect(f.nextFixtureId).toBe("y");
  });
  it("a match moved off the court is absent from the facts, so from every answer", () => {
    expect(courtFocus([]).scoringFixtureId).toBeNull(); // Review Focus 3
  });
  it("courtPhoneStatus: at a 5 s cadence, 14.9 s silent is waiting, 15 s offline", () => {
    const p = { lastBeatAt: T("10:00"), answeredPoll: 5 };
    expect(
      courtPhoneStatus(
        { pairing: p, openState: null },
        new Date(T("10:00").getTime() + 14_900),
      ),
    ).toBe("waiting");
    expect(
      courtPhoneStatus(
        { pairing: p, openState: null },
        new Date(T("10:00").getTime() + 15_000),
      ),
    ).toBe("offline");
    expect(
      courtPhoneStatus({ pairing: p, openState: "live" }, T("10:00")),
    ).toBe("live");
    expect(
      courtPhoneStatus({ pairing: null, openState: null }, T("10:00")),
    ).toBe("unpaired");
  });
  it("courtCodeView: before the day's end finishedAt is null; at it, the end", () => {
    const end = T("23:00");
    expect(
      courtCodeView({ endedAt: null, expiresAt: end }, T("22:59")),
    ).toEqual({ endedAt: null, finishedAt: null });
    expect(courtCodeView({ endedAt: null, expiresAt: end }, end)).toEqual({
      endedAt: null,
      finishedAt: end,
    });
  });
  it("R3: an organiser-started in-play current is never displaced by a newer candidate", () => {
    const f = courtFocus([
      m("a", {
        status: "in_play",
        kickoffAt: T("10:00"),
        openSession: open("sa", "10:00", true),
      }),
      m("b", { status: "in_play", kickoffAt: T("10:10") }),
    ]);
    expect(f).toMatchObject({
      current: { fixtureId: "a", sid: "sa" },
      start: null,
      handover: false,
      focusFixtureId: "a",
    });
  });
  it("R3: once the organiser's match is decided, handover applies", () => {
    const f = courtFocus([
      m("a", { status: "decided", openSession: open("sa", "10:00", true) }),
      m("b", { status: "in_play", kickoffAt: T("10:10") }),
    ]);
    expect(f).toMatchObject({ start: "b", handover: true });
  });
  it("R3: the same, started by the phone (not the organiser): B starts", () => {
    const f = courtFocus([
      m("a", {
        status: "in_play",
        kickoffAt: T("10:00"),
        openSession: open("sa", "10:00", false),
      }),
      m("b", { status: "in_play", kickoffAt: T("10:10") }),
    ]);
    expect(f).toMatchObject({ start: "b", handover: true });
  });
  it("R6: a TBD match planned earlier never queues ahead of a ready one", () => {
    const f = courtFocus([
      m("t", { ready: false, scheduledAt: T("11:00") }),
      m("r", { scheduledAt: T("12:00") }),
    ]);
    expect(f).toMatchObject({ nextFixtureId: "r", scoringFixtureId: "r" });
  });

  describe("startingOfCurrent (D2: the match whose session exists but is not yet handed to the phone)", () => {
    const inPlay = (o: Partial<CourtMatchFacts> = {}) =>
      m("a", { status: "in_play", kickoffAt: T("10:00"), openSession: open("s1", "10:00"), ...o });
    const of = (a: CourtMatchFacts, state: Parameters<typeof startingOfCurrent>[2]) => {
      const facts = [a, m("b", { scheduledAt: T("11:00") })];
      return startingOfCurrent(facts, courtFocus(facts), state);
    };
    it("requested and provisioning name the in-play streamed match", () => {
      expect(of(inPlay(), "requested")).toBe("a");
      expect(of(inPlay(), "provisioning")).toBe("a");
    });
    it("warming (go-live, Open), live and ending, or no session: today's answer", () => {
      expect(of(inPlay(), "warming")).toBeNull();
      expect(of(inPlay(), "live")).toBeNull();
      expect(of(inPlay(), "ending")).toBeNull();
      expect(of(inPlay({ openSession: null }), null)).toBeNull();
    });
    it("Stream off, a latch, or a match no longer in play: today's answer", () => {
      expect(of(inPlay({ streamed: false }), "provisioning")).toBeNull();
      expect(of(inPlay({ latched: true }), "provisioning")).toBeNull();
      expect(of(inPlay({ status: "completed" }), "provisioning")).toBeNull();
    });
  });
});

describe("courtTailEndsAt (O16: when the court's video stops by itself, while that is still to come)", () => {
  const T = (hhmmss: string) => new Date(`2026-11-15T${hhmmss}Z`);
  const facts = (o: Partial<Parameters<typeof courtTailEndsAt>[0]> = {}): Parameters<typeof courtTailEndsAt>[0] => ({
    openState: "live",
    finishedAt: T("10:00:00"),
    sessionPredatesResult: true,
    phoneMode: "automatic",
    ...o,
  });
  // 45 s is not the court's 30 s tail and not the per-fixture 180 s, so the delay passed in is what decides the end.
  const DELAY = 45;

  it("is the result plus the delay it is given, while that is still ahead", () => {
    expect(courtTailEndsAt(facts(), T("10:00:12"), DELAY)).toEqual(T("10:00:45"));
  });
  it("is null at and after the end of the tail", () => {
    expect(courtTailEndsAt(facts(), T("10:00:44.999"), DELAY)).toEqual(T("10:00:45"));
    expect(courtTailEndsAt(facts(), T("10:00:45"), DELAY)).toBeNull();
    expect(courtTailEndsAt(facts(), T("10:09:00"), DELAY)).toBeNull();
  });
  it("is set only while the session is live: an ending one is already stopping, so it promises nothing", () => {
    expect(courtTailEndsAt(facts({ openState: "live" }), T("10:00:12"), DELAY)).toEqual(T("10:00:45"));
    for (const openState of ["ending", "requested", "provisioning", "warming", "completed", "failed", null] as const) {
      expect(courtTailEndsAt(facts({ openState }), T("10:00:12"), DELAY), String(openState)).toBeNull();
    }
  });
  it("is null with no result, and where the automatic stop will not fire", () => {
    expect(courtTailEndsAt(facts({ finishedAt: null }), T("10:00:12"), DELAY)).toBeNull();
    expect(courtTailEndsAt(facts({ phoneMode: "operator" }), T("10:00:12"), DELAY)).toBeNull();
    expect(courtTailEndsAt(facts({ phoneMode: null }), T("10:00:12"), DELAY)).toBeNull();
    expect(courtTailEndsAt(facts({ sessionPredatesResult: false }), T("10:00:12"), DELAY)).toBeNull();
  });
});

describe("one rule: the desk's tail ends exactly when the tick's delay_elapsed does", () => {
  const FIN = new Date("2026-11-15T10:00:00Z");
  const base = { autoStream: true, phoneMode: "automatic" as const, finishedAt: FIN, sessionPredatesResult: true };
  it("autoStopDeadline is the result plus the delay", () => {
    expect(autoStopDeadline(FIN, 30)).toEqual(new Date("2026-11-15T10:00:30Z"));
    expect(autoStopDeadline(FIN, 180)).toEqual(new Date("2026-11-15T10:03:00Z"));
  });
  it.each([-1, 0, 1, 29_999, 30_000, 30_001, 180_000])("at result + %i ms the desk has a tail exactly while the tick is not yet due", (ms) => {
    const now = new Date(FIN.getTime() + ms);
    const tick = autoStopVerdict(base, now, 30);
    const desk = courtTailEndsAt({ openState: "live", finishedAt: FIN, sessionPredatesResult: true, phoneMode: "automatic" }, now, 30);
    expect(desk !== null, `${ms} ms`).toBe(!tick.due);
    if (desk !== null) expect(desk).toEqual(autoStopDeadline(FIN, 30));
  });
});

// Court follow-up (controller ruling, 2026-11-18): a court session that ended because its phone went away does not latch the
// match. The rule, typed here: only `phone_lost` releases the two once-per-match latches (the automatic start has run; a session
// received video); every other end, and no ended session at all, releases nothing; and the organiser's latch is never touched.
describe("courtStartFacts (a phone gone mid-match: the court starts the match again)", () => {
  const T = new Date("2026-11-07T10:00:00Z");
  const latchedOnce: AutoStartFacts = {
    autoStream: true, phoneMode: "automatic", phonePresent: true, fixtureStatus: "in_play", openSession: false,
    autoStartedAt: T, autoStartBlockedAt: null, anySessionHadIngest: true, autoStartAttemptedAt: T,
  };
  const later = new Date(T.getTime() + 60 * 60_000);

  it("phone_lost releases not_yet_started and no_broadcast_ran, and the start is due", () => {
    expect(autoStartVerdict(latchedOnce, later, 30).failed, "premise: once-per-match holds the match").toEqual(["not_yet_started", "no_broadcast_ran"]);
    const released = courtStartFacts(latchedOnce, "phone_lost");
    expect(released).toEqual({ ...latchedOnce, autoStartedAt: null, anySessionHadIngest: false });
    expect(autoStartVerdict(released, later, 30)).toEqual({ due: true, failed: [] });
  });

  it("every other end, and none, releases nothing (count reported)", () => {
    let checked = 0;
    for (const end of [null, "stopped", "operator_stopped", "auto_stopped", "max_duration", "relay_ended"] as const) {
      expect(courtStartFacts(latchedOnce, end), String(end)).toBe(latchedOnce);
      expect(courtRestartsAfter(end), String(end)).toBe(false);
      checked++;
    }
    expect(checked).toBe(6);
    expect(courtRestartsAfter("phone_lost")).toBe(true);
  });

  it("the organiser's latch, the switch, the match in play, an open session and the retry spacing still decide after a phone gone", () => {
    const cases: [string, Partial<AutoStartFacts>, string, Date][] = [
      ["the organiser's Stop", { autoStartBlockedAt: T }, "not_blocked", later],
      ["Stream off", { autoStream: false }, "switch_on", later],
      ["the result", { fixtureStatus: "decided" }, "in_play", later],
      ["a session open", { openSession: true }, "no_open_session", later],
      ["inside the retry spacing", { autoStartAttemptedAt: later }, "retry_spacing", later],
    ];
    let checked = 0;
    for (const [label, over, conjunct, now] of cases) {
      const v = autoStartVerdict(courtStartFacts({ ...latchedOnce, ...over }, "phone_lost"), now, 30);
      expect(v, label).toEqual({ due: false, failed: [conjunct] });
      checked++;
    }
    expect(checked).toBe(5);
  });
});
