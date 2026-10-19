// T17B fix 2, D19: the room's sound player. Browsers let a page make sound only after the person has interacted with
// it, so the AudioContext is created — and resumed — inside a gesture (unlock(), called from a tap or a key anywhere on
// the page: Check in counts, a move counts, the toggle counts). Before that, play() is silence. Nothing here ever
// throws: no WebAudio, a constructor the browser refuses, a resume the autoplay block rejects, a context still
// suspended — each one is simply no sound.
import { renderSound } from "./room-sound-synth";
import type { Sound } from "./room-sounds";

export type RoomAudio = { unlock(): void; play(s: Sound): void };

/** A context the gesture created can still be starting ("suspended" until the browser's first render quantum — some
 *  browsers report that for a moment). A sound asked for then is played once it runs, if that is within this long;
 *  never later, so a context that wakes minutes on (a phone back from a call) does not burst out old moves. */
export const RESUME_FRESH_MS = 300;

type Maker = () => AudioContext | null;

const browserMaker: Maker = () => {
  if (typeof window === "undefined") return null;
  const w = window as unknown as { AudioContext?: typeof AudioContext; webkitAudioContext?: typeof AudioContext };
  const Ctor = w.AudioContext ?? w.webkitAudioContext;
  return Ctor ? new Ctor() : null;
};

export function roomAudio(make: Maker = browserMaker, now: () => number = Date.now): RoomAudio {
  let ctx: AudioContext | null = null;
  return {
    unlock() {
      try {
        if (ctx === null) ctx = make();
        if (ctx !== null && ctx.state === "suspended") {
          Promise.resolve(ctx.resume()).catch(() => {});
        }
      } catch {
        // No context to be had (the browser refused one): silence; the next gesture asks again.
        ctx = null;
      }
    },
    play(s) {
      try {
        const c = ctx;
        if (c === null) return;
        if (c.state === "running") {
          renderSound(c, s);
          return;
        }
        if (c.state !== "suspended") return;
        const asked = now();
        Promise.resolve(c.resume())
          .then(() => {
            if (c.state === "running" && now() - asked <= RESUME_FRESH_MS) renderSound(c, s);
          })
          .catch(() => {});
      } catch {
        // A context that cannot build the sound: silence.
      }
    },
  };
}

/** The page's one player: one AudioContext per page, created on the first gesture. */
export const ROOM_AUDIO: RoomAudio = roomAudio();
