// W2 — file-based sfx for the board's own physical cues (move/capture/
// check) and the shared "solve" chime. Tiny local audio files under
// public/games/chess-quest/sfx/, layered ALONGSIDE sfx.ts's synthesized
// oscillator tones, not replacing them: sfx.ts covers per-game feedback
// (tap/good/bad/coin/chime/fanfare), played from inside each mini-game's own
// logic, and none of those call sites change here. This file covers exactly
// two things — Board's move/capture/check (wired in Board.tsx, driven by the
// same single-piece-moved detector the W1 FLIP slide uses) and the shared
// "solve" win chime (wired into lib/celebrate.ts — see that file for why:
// celebrate() is already the one place every solvable mini-game reports a
// win, so hooking in there covers all of them without touching each game
// component individually).
//
// play() is a plain, stable, module-level function — not itself hook-based —
// so both a component (via the useSfx() hook below) and a plain function
// (celebrate.ts, which cannot call hooks) share the identical
// implementation. Mute state reuses sfx.isMuted() (./sfx.ts) rather than a
// second, parallel mute flag: that flag is already kept in sync with
// progress.getMuted() by useDeviceAudio(), so there is exactly one source of
// truth for "is this player muted" in the whole games tree.
import { sfx } from "./sfx";

export type SfxKind = "move" | "capture" | "check" | "solve";

const FILES: Record<SfxKind, string> = {
  move: "/games/chess-quest/sfx/move.wav",
  capture: "/games/chess-quest/sfx/capture.wav",
  check: "/games/chess-quest/sfx/check.wav",
  solve: "/games/chess-quest/sfx/solve.wav",
};

type WindowWithWebkitAudio = Window & { webkitAudioContext?: typeof AudioContext };

let ctx: AudioContext | null = null;

// Lazily creates the single AudioContext on first call — which only ever
// happens as a direct result of a move/capture/check/solve, i.e. after a
// user gesture already occurred, satisfying the autoplay-policy requirement
// the same way sfx.ts's own ac() does. Returns null (a clean no-op for the
// caller) when there is no window (SSR / this vitest environment) or the
// AudioContext API is missing entirely.
function ac(): AudioContext | null {
  if (typeof window === "undefined") return null;
  if (!ctx) {
    const AC = window.AudioContext ?? (window as WindowWithWebkitAudio).webkitAudioContext;
    if (!AC) return null;
    ctx = new AC();
  }
  if (ctx.state === "suspended") void ctx.resume();
  return ctx;
}

// undefined = never requested yet; null = requested and it 404'd or failed
// to decode — a permanent no-op for that kind from here on, never retried;
// AudioBuffer = decoded and ready to play.
const buffers: Partial<Record<SfxKind, AudioBuffer | null>> = {};
const pending: Partial<Record<SfxKind, Promise<AudioBuffer | null>>> = {};

function loadBuffer(kind: SfxKind, a: AudioContext): Promise<AudioBuffer | null> {
  if (kind in buffers) return Promise.resolve(buffers[kind] ?? null);
  if (!pending[kind]) {
    pending[kind] = (async () => {
      try {
        const res = await fetch(FILES[kind]);
        if (!res.ok) {
          buffers[kind] = null;
          return null;
        }
        const data = await res.arrayBuffer();
        const buf = await a.decodeAudioData(data);
        buffers[kind] = buf;
        return buf;
      } catch {
        // Missing file, network failure, or a decode error — all the same
        // "can't play this one" outcome from the caller's point of view.
        buffers[kind] = null;
        return null;
      }
    })();
  }
  return pending[kind]!;
}

/**
 * Plain, hook-free implementation — safe to call from a component or from a
 * plain function like celebrate(). No-ops silently and never throws: muted,
 * AudioContext missing, or the file failed to load/404'd.
 */
export function playSfx(kind: SfxKind): void {
  if (sfx.isMuted()) return;
  const a = ac();
  if (!a) return;
  void loadBuffer(kind, a)
    .then((buf) => {
      if (!buf || sfx.isMuted()) return;
      const src = a.createBufferSource();
      src.buffer = buf;
      src.connect(a.destination);
      src.start();
    })
    // loadBuffer itself never rejects (see its own try/catch), but if
    // playback ever threw synchronously this keeps the whole thing the
    // silent no-op the spec wants, not an unhandled rejection (review
    // 2026-08-27).
    .catch(() => {});
}

/**
 * Component-facing wrapper, named per the W2 spec's `useSfx()` contract.
 * Holds no hook state of its own — play is already the stable module-level
 * playSfx reference above — so it is also safe to call directly in a test
 * without a live render (this workspace has no jsdom/react-test-renderer).
 */
export function useSfx(): { play(kind: SfxKind): void } {
  return { play: playSfx };
}
