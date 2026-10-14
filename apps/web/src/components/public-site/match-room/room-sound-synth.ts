// T17B fix 2, D19 — the room's sounds, SYNTHESIZED at run time with WebAudio. There are no audio files.
//
// Source and licence: every recipe below is original to Seazn, written for this room on 2026-10-14 — sine and
// triangle tones and band-passed white noise, shaped by gain envelopes. No third-party sound, sample or recording is
// used, copied or traced (in particular nothing from Lichess or chess.com, whose sound files are never to be used
// here), so there is no external licence to carry: the recipes are this repository's own code.
//
// The voice: a felt-and-wood board. A move is a short knock — a low tone with a burst of filtered noise for the
// contact; the opponent's knock sits a little higher, so it reads as "theirs" without looking; a capture lands lower
// and heavier with a second contact; a castle is two knocks, king then rook. Check, the start, the end, a draw offer
// and low time are pitched cues (tones, no knock), so they never read as a move.
//
// Every sound's FIRST tone has a frequency no other sound starts with (SOUND_SIGNATURE). The match-room e2e listens
// for it at the browser's AudioContext to tell which sound was played — the real WebAudio path, no test hook.
import type { Sound } from "./room-sounds";

export type Tone = {
  /** Seconds after the sound starts. */
  at: number;
  hz: number;
  /** A pitch the tone glides to over its length (a knock's drop). */
  toHz?: number;
  wave: "sine" | "triangle";
  /** Seconds, attack to silence. */
  dur: number;
  /** Peak gain, before the master level. */
  gain: number;
};
export type Knock = { at: number; hz: number; q: number; dur: number; gain: number };
export type Recipe = { tones: Tone[]; knocks: Knock[] };

export const MASTER_GAIN = 0.55;

const knock = (at: number, hz: number, bodyHz: number, gain: number, bodyGain: number): Recipe => ({
  tones: [{ at, hz: bodyHz, toHz: bodyHz * 0.7, wave: "sine", dur: 0.09, gain: bodyGain }],
  knocks: [{ at, hz, q: 6, dur: 0.035, gain }],
});
const join = (...rs: Recipe[]): Recipe => ({ tones: rs.flatMap((r) => r.tones), knocks: rs.flatMap((r) => r.knocks) });
const chime = (at: number, hz: number, dur: number, gain: number): Tone => ({ at, hz, wave: "triangle", dur, gain });

export const SYNTH: Record<Sound, Recipe> = {
  move: knock(0, 1_700, 300, 0.45, 0.35),
  opponentMove: knock(0, 2_300, 380, 0.45, 0.35),
  capture: join(knock(0, 1_100, 220, 0.55, 0.45), knock(0.045, 1_500, 250, 0.3, 0.25)),
  castle: join(knock(0, 1_700, 260, 0.4, 0.3), knock(0.11, 1_900, 310, 0.4, 0.3)),
  check: { tones: [chime(0, 660, 0.22, 0.28), chime(0, 990, 0.22, 0.16)], knocks: [{ at: 0, hz: 2_000, q: 5, dur: 0.03, gain: 0.35 }] },
  start: { tones: [chime(0, 523.25, 0.16, 0.25), chime(0.13, 783.99, 0.26, 0.25)], knocks: [] },
  end: { tones: [chime(0, 784, 0.16, 0.25), chime(0.14, 659.25, 0.16, 0.25), chime(0.28, 523.25, 0.34, 0.25)], knocks: [] },
  offer: { tones: [chime(0, 698.46, 0.14, 0.22), chime(0.16, 698.46, 0.2, 0.22)], knocks: [] },
  lowTime: { tones: [chime(0, 1_320, 0.06, 0.18), chime(0.12, 1_320, 0.06, 0.18)], knocks: [] },
};

export const SOUND_SIGNATURE: Record<Sound, number> = Object.fromEntries(
  Object.entries(SYNTH).map(([s, r]) => [s, r.tones[0]!.hz]),
) as Record<Sound, number>;

/** Seconds from a sound's start to its last tone or knock falling silent. */
export function synthDuration(s: Sound): number {
  const r = SYNTH[s];
  return Math.max(...r.tones.map((t) => t.at + t.dur), ...r.knocks.map((k) => k.at + k.dur));
}

const SILENT = 0.0001;
const noiseBuffers = new WeakMap<BaseAudioContext, AudioBuffer>();

function noise(ctx: BaseAudioContext): AudioBuffer {
  const held = noiseBuffers.get(ctx);
  if (held) return held;
  const length = Math.ceil(ctx.sampleRate * 0.1);
  const buffer = ctx.createBuffer(1, length, ctx.sampleRate);
  const data = buffer.getChannelData(0);
  for (let i = 0; i < length; i += 1) data[i] = Math.random() * 2 - 1;
  noiseBuffers.set(ctx, buffer);
  return buffer;
}

function envelope(ctx: BaseAudioContext, start: number, dur: number, peak: number, out: AudioNode): GainNode {
  const g = ctx.createGain();
  g.gain.setValueAtTime(SILENT, start);
  g.gain.exponentialRampToValueAtTime(peak, start + 0.004);
  g.gain.exponentialRampToValueAtTime(SILENT, start + dur);
  g.connect(out);
  return g;
}

/** Schedule one sound on `ctx`, starting now. Throws whatever the context throws; the player catches it. */
export function renderSound(ctx: BaseAudioContext, s: Sound): void {
  const r = SYNTH[s];
  const t0 = ctx.currentTime + 0.005;
  const out = ctx.createGain();
  out.gain.setValueAtTime(MASTER_GAIN, t0);
  out.connect(ctx.destination);
  for (const tone of r.tones) {
    const start = t0 + tone.at;
    const osc = ctx.createOscillator();
    osc.type = tone.wave;
    osc.frequency.setValueAtTime(tone.hz, start);
    if (tone.toHz !== undefined) osc.frequency.exponentialRampToValueAtTime(tone.toHz, start + tone.dur);
    osc.connect(envelope(ctx, start, tone.dur, tone.gain, out));
    osc.start(start);
    osc.stop(start + tone.dur + 0.02);
  }
  for (const k of r.knocks) {
    const start = t0 + k.at;
    const src = ctx.createBufferSource();
    src.buffer = noise(ctx);
    const band = ctx.createBiquadFilter();
    band.type = "bandpass";
    band.frequency.setValueAtTime(k.hz, start);
    band.Q.setValueAtTime(k.q, start);
    src.connect(band);
    band.connect(envelope(ctx, start, k.dur, k.gain, out));
    src.start(start);
    src.stop(start + k.dur + 0.02);
  }
}
