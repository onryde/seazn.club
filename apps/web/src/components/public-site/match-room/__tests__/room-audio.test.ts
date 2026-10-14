// T17B fix 2, D19: the room's sounds are synthesized with WebAudio — no files — and play only after a user gesture.
// The player never throws: no AudioContext, a constructor that throws, a resume the browser refuses (the autoplay
// block), a context still suspended — each is silence. Over a fake AudioContext (vitest is node: no audio).
import { describe, expect, it, vi } from "vitest";
import { RESUME_FRESH_MS, roomAudio } from "../room-audio";
import { SYNTH, SOUND_SIGNATURE, synthDuration } from "../room-sound-synth";
import { SOUNDS, type Sound } from "../room-sounds";

class FakeParam {
  value = 0;
  calls: [string, number, number][] = [];
  setValueAtTime(v: number, t: number) {
    this.calls.push(["set", v, t]);
    return this;
  }
  exponentialRampToValueAtTime(v: number, t: number) {
    this.calls.push(["exp", v, t]);
    return this;
  }
  linearRampToValueAtTime(v: number, t: number) {
    this.calls.push(["lin", v, t]);
    return this;
  }
}
class FakeNode {
  connected: unknown[] = [];
  connect(n: unknown) {
    this.connected.push(n);
    return n;
  }
}
class FakeOsc extends FakeNode {
  type = "sine";
  frequency = new FakeParam();
  started: number[] = [];
  stopped: number[] = [];
  start(t: number) {
    this.started.push(t);
  }
  stop(t: number) {
    this.stopped.push(t);
  }
}
class FakeGain extends FakeNode {
  gain = new FakeParam();
}
class FakeFilter extends FakeNode {
  type = "lowpass";
  frequency = new FakeParam();
  Q = new FakeParam();
}
class FakeSource extends FakeNode {
  buffer: unknown = null;
  start() {}
  stop() {}
}
class FakeContext {
  state: "suspended" | "running" | "closed" = "running";
  currentTime = 1;
  sampleRate = 48_000;
  destination = { name: "speakers" };
  oscs: FakeOsc[] = [];
  resumes = 0;
  constructor(readonly resumeRejects = false) {}
  resume() {
    this.resumes += 1;
    if (this.resumeRejects) return Promise.reject(new DOMException("blocked", "NotAllowedError"));
    this.state = "running";
    return Promise.resolve();
  }
  createOscillator() {
    const o = new FakeOsc();
    this.oscs.push(o);
    return o;
  }
  createGain() {
    return new FakeGain();
  }
  createBiquadFilter() {
    return new FakeFilter();
  }
  createBufferSource() {
    return new FakeSource();
  }
  createBuffer(_channels: number, length: number) {
    const data = new Float32Array(length);
    return { getChannelData: () => data, length };
  }
}
const asCtx = (c: FakeContext) => c as unknown as AudioContext;

describe("the room's synthesized sounds (D19 — no files)", () => {
  it("every sound has a recipe, a signature tone no other sound starts with, and stays short (counted)", () => {
    let checked = 0;
    const firsts = new Set<number>();
    for (const s of SOUNDS) {
      const r = SYNTH[s];
      expect(r.tones.length, s).toBeGreaterThan(0);
      expect(SOUND_SIGNATURE[s], `${s}: its signature is its first tone`).toBe(r.tones[0]!.hz);
      firsts.add(r.tones[0]!.hz);
      for (const t of r.tones) {
        expect(t.hz, `${s}: audible`).toBeGreaterThanOrEqual(80);
        expect(t.hz, `${s}: audible`).toBeLessThanOrEqual(4_000);
        expect(t.gain, `${s}: never loud`).toBeLessThanOrEqual(0.6);
      }
      expect(synthDuration(s), `${s}: a short cue`).toBeLessThanOrEqual(0.7);
      checked += 1;
    }
    expect(checked).toBe(SOUNDS.length);
    expect(firsts.size, "one signature per sound").toBe(SOUNDS.length);
  });
});

describe("the player: only after a gesture, never a throw (D19)", () => {
  it("the empty case first: before any gesture nothing is created and nothing plays (counted)", () => {
    const make = vi.fn(() => asCtx(new FakeContext()));
    const audio = roomAudio(make);
    let checked = 0;
    for (const s of SOUNDS) {
      expect(() => audio.play(s)).not.toThrow();
      checked += 1;
    }
    expect(checked).toBe(SOUNDS.length);
    expect(make, "no AudioContext before a gesture").not.toHaveBeenCalled();
  });

  it("a gesture creates the context once; then each sound reaches the speakers as its own recipe (counted)", () => {
    const ctx = new FakeContext();
    const make = vi.fn(() => asCtx(ctx));
    const audio = roomAudio(make);
    audio.unlock();
    audio.unlock();
    expect(make).toHaveBeenCalledTimes(1);
    let checked = 0;
    for (const s of SOUNDS) {
      const before = ctx.oscs.length;
      audio.play(s);
      const made = ctx.oscs.slice(before);
      expect(made.length, s).toBe(SYNTH[s].tones.length);
      expect(made[0]!.frequency.calls[0], `${s}: its signature first`).toEqual(["set", SOUND_SIGNATURE[s], expect.any(Number)]);
      expect(made.every((o) => o.started.length === 1 && o.stopped.length === 1), `${s}: every tone starts and stops`).toBe(true);
      expect(made.every((o) => o.started[0]! >= ctx.currentTime), `${s}: never in the past`).toBe(true);
      checked += 1;
    }
    expect(checked).toBe(SOUNDS.length);
  });

  it("a suspended context (no gesture took, or the autoplay block) is silence; the next gesture resumes it", async () => {
    const ctx = new FakeContext();
    ctx.state = "suspended";
    const audio = roomAudio(() => asCtx(ctx));
    audio.unlock();
    expect(ctx.resumes).toBe(1);
    await Promise.resolve();
    expect(ctx.state).toBe("running");
    const stuck = new FakeContext(true);
    stuck.state = "suspended";
    const blocked = roomAudio(() => asCtx(stuck));
    expect(() => blocked.unlock()).not.toThrow();
    await new Promise((r) => setTimeout(r, 0)); // the refused resume settles — and is caught
    blocked.play("move");
    expect(stuck.oscs, "suspended: nothing is scheduled").toHaveLength(0);
  });

  it("a context the gesture made that is still starting: the sound plays once it runs — if that is soon, never late (counted)", async () => {
    const cases: [string, number, number][] = [
      ["starts at once", 0, 1],
      ["starts within the fresh window", RESUME_FRESH_MS, 1],
      ["starts too late (a phone back from a call)", RESUME_FRESH_MS + 1, 0],
    ];
    let checked = 0;
    for (const [name, wakeAfter, tones] of cases) {
      let t = 1_000;
      const c = new FakeContext();
      c.state = "suspended";
      let wake = () => {};
      c.resume = () =>
        new Promise<void>((r) => {
          wake = () => {
            c.state = "running";
            r();
          };
        });
      const audio = roomAudio(() => asCtx(c), () => t);
      audio.unlock();
      audio.play("move");
      expect(c.oscs, `${name}: nothing yet`).toHaveLength(0);
      t += wakeAfter;
      wake();
      await new Promise((r) => setTimeout(r, 0));
      expect(c.oscs.length, name).toBe(tones * SYNTH.move.tones.length);
      checked += 1;
    }
    expect(checked).toBe(cases.length);
  });

  it("no WebAudio at all, a constructor that throws, a play that throws: silence, never a throw (counted)", () => {
    const cases: [string, () => AudioContext | null][] = [
      ["no AudioContext in this browser", () => null],
      [
        "the constructor throws",
        () => {
          throw new Error("AudioContext is not allowed");
        },
      ],
      [
        "the context throws while building a sound",
        () => {
          const c = new FakeContext();
          c.createOscillator = () => {
            throw new Error("closed");
          };
          return asCtx(c);
        },
      ],
    ];
    let checked = 0;
    for (const [name, make] of cases) {
      const audio = roomAudio(make);
      expect(() => audio.unlock(), name).not.toThrow();
      for (const s of SOUNDS as readonly Sound[]) expect(() => audio.play(s), `${name}: ${s}`).not.toThrow();
      checked += 1;
    }
    expect(checked).toBe(cases.length);
  });
});
