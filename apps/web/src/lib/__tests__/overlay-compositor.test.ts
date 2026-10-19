// R2005 — the compositor host's pure rules (lib/overlay-compositor.ts): the score-stale boundary, the change-only
// emitter, the phase channel's reducer and reply validator (A2), the CORS-simple loopback request (A6), and the pin
// that replaced change 3's clamp (every timestamp the picture schedules against is server-assigned or page-local).
//
// Every expected value is TYPED from its authority — compositor spec §6 (10 s), overlay templates spec §4.3 (3
// failures, port 7419, the long poll), Owed 18 (2 s) — and never read back from the module under test.
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";
import {
  changeOnly,
  isCompositorHost,
  isScoreStale,
  OVERLAY_ALIVE_EVERY_MS,
  PHASE_CHANNEL_INITIAL,
  PHASE_CHANNEL_START,
  PHASE_LOOPBACK_FAILURES_TO_FALLBACK,
  phaseChannelSignal,
  phaseChannelStep,
  phaseReplyEvent,
  SCORE_STALE_AFTER_MS,
  scoreStaleSignal,
  settledChannel,
  SIGNAL_ALIVE,
  SIGNAL_READY,
  type PhaseChannelEvent,
  type PhaseChannelState,
} from "../overlay-compositor";
import { PROGRAMME_PHASES } from "../relay-phase";
import { phaseRequest } from "@/components/overlay/use-programme-phase";
import { clockLabelAt } from "@/components/overlay/use-overlay-clock";

const run = (events: PhaseChannelEvent[], from: PhaseChannelState = PHASE_CHANNEL_INITIAL): PhaseChannelState =>
  events.reduce(phaseChannelStep, from);
const FAIL: PhaseChannelEvent = { type: "loopbackFailed" };
const ok = (phase: (typeof PROGRAMME_PHASES)[number], seq: number): PhaseChannelEvent => ({ type: "loopbackOk", phase, seq });

describe("the thresholds, typed from their authorities", () => {
  it("score stale after 10 s (compositor spec §6); the beat every 2 s (Owed 18, `cef_alive_every_ms`)", () => {
    expect(SCORE_STALE_AFTER_MS).toBe(10_000);
    expect(OVERLAY_ALIVE_EVERY_MS).toBe(2_000);
    // The compositor's hang threshold is five beats and equals the stale threshold (C02's config.rs).
    expect(5 * OVERLAY_ALIVE_EVERY_MS).toBe(SCORE_STALE_AFTER_MS);
  });

  it("only the exact `compositor` value turns the host on", () => {
    expect(isCompositorHost("compositor")).toBe(true);
    for (const v of [undefined, null, "", "obs", "Compositor", ["compositor"], ["compositor", "compositor"]]) {
      expect(isCompositorHost(v), JSON.stringify(v)).toBe(false);
    }
  });

  it("the console lines are F-001's channel words", () => {
    expect(SIGNAL_READY).toBe("seazn:ready");
    expect(SIGNAL_ALIVE).toBe("seazn:alive");
    expect([scoreStaleSignal(true), scoreStaleSignal(false)]).toEqual(["seazn:score-stale=true", "seazn:score-stale=false"]);
    expect([phaseChannelSignal("loopback"), phaseChannelSignal("web")]).toEqual([
      "seazn:phase-channel=loopback",
      "seazn:phase-channel=web",
    ]);
  });
});

describe("score stale (change 2)", () => {
  const LAST = 1_700_000_000_000;
  it("flips at EXACTLY SCORE_STALE_AFTER_MS after the last success, not one millisecond before", () => {
    expect(isScoreStale(LAST, LAST + 10_000 - 1)).toBe(false);
    expect(isScoreStale(LAST, LAST + 10_000)).toBe(true);
    expect(isScoreStale(LAST, LAST + 60_000)).toBe(true);
  });

  it("clears on the next success: a newer success at the same instant is fresh again", () => {
    const now = LAST + 12_000;
    expect(isScoreStale(LAST, now)).toBe(true);
    expect(isScoreStale(now, now)).toBe(false);
  });

  it("is emitted on change only: 5 identical states ⇒ 1 emit, and each later change emits once", () => {
    const out: boolean[] = [];
    const emit = changeOnly<boolean>((v) => out.push(v));
    for (let i = 0; i < 5; i++) emit(false);
    expect(out).toEqual([false]);
    for (const v of [true, true, true, false, false, true]) emit(v);
    expect(out).toEqual([false, true, false, true]);
  });
});

describe("A2 — phaseChannelStep (spec §4.3)", () => {
  it("PHASE_LOOPBACK_FAILURES_TO_FALLBACK is §4.3's 3, and the channel starts in loopback (F-009 outcome (a))", () => {
    expect(PHASE_LOOPBACK_FAILURES_TO_FALLBACK).toBe(3);
    expect(PHASE_CHANNEL_START).toBe("loopback");
    expect(PHASE_CHANNEL_INITIAL).toMatchObject({ channel: "loopback", failures: 0, phase: null });
  });

  it("fail, fail, ok → still loopback with failures 0", () => {
    const s = run([FAIL, FAIL, ok("live", 1)]);
    expect(s).toMatchObject({ channel: "loopback", failures: 0, phase: "live", seq: 1 });
  });

  it("fail × 3 → web; fail × 2 is not", () => {
    expect(run([FAIL, FAIL]).channel).toBe("loopback");
    expect(run([FAIL, FAIL, FAIL]).channel).toBe("web");
  });

  it("the failures must be CONSECUTIVE: fail, fail, ok, fail, fail stays loopback", () => {
    expect(run([FAIL, FAIL, ok("live", 1), FAIL, FAIL])).toMatchObject({ channel: "loopback", failures: 2 });
  });

  it("after web: loopbackOk is ignored (sticky), webPhase('reconnecting') is adopted", () => {
    const web = run([ok("live", 1), FAIL, FAIL, FAIL]);
    expect(web.channel).toBe("web");
    const after = run([ok("final", 99)], web);
    expect(after, "a later loopback success never switches back").toEqual(web);
    expect(run([{ type: "webPhase", phase: "reconnecting" }], web)).toMatchObject({ channel: "web", phase: "reconnecting" });
    expect(run([{ type: "webPhase", phase: null }], web).phase, "an absent programmePhase is no phase").toBeNull();
  });

  it("in loopback, a webPhase event is ignored", () => {
    const s = run([ok("live", 1), { type: "webPhase", phase: "final" }]);
    expect(s).toMatchObject({ channel: "loopback", phase: "live" });
  });

  it("a stale seq is ignored — no phase change — but it is an ANSWER, so it resets the failure count", () => {
    const s = run([ok("reconnecting", 5), ok("live", 4), ok("live", 5)]);
    expect(s).toMatchObject({ phase: "reconnecting", seq: 5 });
    // A long poll that ran out its hold answers with the CURRENT seq (C12): the endpoint is up.
    expect(run([ok("live", 5), FAIL, FAIL, ok("live", 5), FAIL, FAIL]).channel).toBe("loopback");
  });

  it("the endpoint's own (waiting, 0) — what it serves before any publish — is adopted, not read as stale", () => {
    expect(run([ok("waiting", 0)])).toMatchObject({ phase: "waiting", seq: 0 });
  });
});

describe("A2 (review m12) — the hook's reply validator", () => {
  it("4 replies: an undeclared phase, a negative seq and an extra key are FAILURES; a declared phase is a phase", () => {
    expect(phaseReplyEvent({ phase: "paused", seq: 1 })).toEqual({ type: "loopbackFailed" });
    expect(phaseReplyEvent({ phase: "live", seq: -1 })).toEqual({ type: "loopbackFailed" });
    expect(phaseReplyEvent({ phase: "live", seq: 1, x: 1 })).toEqual({ type: "loopbackFailed" });
    expect(phaseReplyEvent({ phase: "final", seq: 1 })).toEqual({ type: "loopbackOk", phase: "final", seq: 1 });
  });

  it("not JSON-shaped at all is a failure too", () => {
    for (const body of [null, "live", 7, [], { phase: "live" }, { seq: 1 }, { phase: "live", seq: 1.5 }]) {
      expect(phaseReplyEvent(body), JSON.stringify(body)).toEqual({ type: "loopbackFailed" });
    }
  });

  it("every declared programme phase is accepted (phases checked: 5)", () => {
    // Typed from spec §4.2 / compositor C03, never read back from PROGRAMME_PHASES — which is then held to it.
    const SPEC_PHASES = ["waiting", "live", "frozen", "reconnecting", "final"];
    expect([...PROGRAMME_PHASES]).toEqual(SPEC_PHASES);
    let checked = 0;
    for (const phase of SPEC_PHASES) {
      expect(phaseReplyEvent({ phase, seq: 3 }), phase).toEqual({ type: "loopbackOk", phase, seq: 3 });
      checked++;
    }
    console.log(`phases checked: ${checked}`);
    expect(checked).toBe(5);
  });
});

describe("the channel announcement", () => {
  it("nothing until loopback has answered; loopback once it has; web once fallen back", () => {
    expect(settledChannel(PHASE_CHANNEL_INITIAL, false)).toBeNull();
    expect(settledChannel(PHASE_CHANNEL_INITIAL, true)).toBe("loopback");
    expect(settledChannel(run([FAIL, FAIL, FAIL]), false)).toBe("web");
    expect(settledChannel(run([FAIL, FAIL, FAIL]), true)).toBe("web");
  });
});

describe("A6 — phaseRequest stays CORS-simple (F-009 review M5)", () => {
  it("the init is exactly { signal }: no headers, body, method, credentials or mode", () => {
    const signal = new AbortController().signal;
    const [url, init] = phaseRequest(7, signal);
    expect(Object.keys(init)).toEqual(["signal"]);
    expect(init.signal).toBe(signal);
    // Typed from spec §4.3 (port 7419, path /phase, `?after=<seq>`), never from RELAY_PHASE_PORT.
    expect(url).toBe("http://127.0.0.1:7419/phase?after=7");
  });
});

// Change 3 (clock skew), re-pinned 2026-10-18: NO clamp is built, because no timestamp the picture schedules against is
// a scorer device's. The delay buffer schedules each snapshot on the PAGE's own receipt clock (`receivedAt: Date.now()`
// in use-live-fixture.ts), and the clock's anchor is the envelope's `recordedAt`, which persistence stamps on the
// server (`append-event.ts`: `input.recordedAt ?? new Date().toISOString()`). These pins red the day that changes.
describe("change 3 — the picture's timestamps are server-assigned (the clamp's false premise)", () => {
  const SRC = join(__dirname, "..", "..");
  const files: string[] = [];
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      const p = join(dir, name);
      if (statSync(p).isDirectory()) {
        if (name === "__tests__" || name === "node_modules") continue;
        walk(p);
      } else if (/\.(ts|tsx)$/.test(name) && !/\.test\.tsx?$/.test(name)) files.push(p);
    }
  };
  walk(join(SRC, "server"));
  walk(join(SRC, "app"));

  it("of every production caller of the append path, only the P11 batch import supplies `recordedAt`", () => {
    const callers = files.filter((f) => /\bappendEvent(InTx)?\(/.test(readFileSync(f, "utf8")));
    const supplying = callers
      .filter((f) => !f.endsWith(join("engine-db", "append-event.ts")))
      .filter((f) => /\brecordedAt\b/.test(readFileSync(f, "utf8")))
      .map((f) => relative(SRC, f));
    console.log(`append-path callers checked: ${callers.length}`);
    expect(callers.length, "anti-vacuity: no append-path caller found").toBeGreaterThan(1);
    // P11 imports a FINISHED stream into an UNSTARTED fixture (event-import.ts refuses one with events or past
    // `scheduled`), through the API; no scorer device reaches it. A new name here is a device-sourced timestamp until
    // proven otherwise — and the clamp (spec §6, OVERLAY_FUTURE_CLAMP_MS) becomes owed.
    expect(supplying).toEqual([join("server", "usecases", "event-import.ts")]);
  });

  it("an anchor stamped in the future holds the clock at the anchor — it never runs ahead (`Math.max(0, …)`)", () => {
    const now = 1_700_000_000_000;
    const delay = 3_100;
    // 2 001 ms past `now + delay`: the case the brief's clamp was for.
    const clock = { phase: "H1", anchorSeconds: 600, anchorAtWallMs: now + delay + 2_001, running: true, nominalSeconds: 2_700 };
    expect(clockLabelAt(clock, now, delay)).toBe(clockLabelAt({ ...clock, anchorAtWallMs: now - delay }, now, delay));
    expect(clockLabelAt(clock, now, delay)).toBe("10:00");
  });
});
