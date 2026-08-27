// A win: fanfare + confetti. Games call this instead of sfx.fanfare() so the
// two always fire together (and confetti stays reduced-motion aware).
//
// W2 also plays the file-based "solve" cue from here rather than from
// GameShell directly: celebrate() is already the one place every solvable
// mini-game reports a win (see lib/useSfx.ts's header), so every game gets
// the new cue with zero changes to the game components themselves — the
// same reasoning W2 uses for reusing the tap path for drag.
import { burst } from "./fx";
import { sfx } from "./sfx";
import { playSfx } from "./useSfx";

export function celebrate(originEl?: Element | null): void {
  sfx.fanfare();
  playSfx("solve");
  burst(originEl);
}
