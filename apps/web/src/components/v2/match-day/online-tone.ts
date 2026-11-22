// Match Day online rows: how loud a word is, in colour. One table for the round row's word and the board row's, so a state reads the
// same wherever it is said (lib/match-day/online-copy.ts `WordTone` is the fact; this is only its paint). Never colour alone: every
// word carries its text, and the dots carry a shape (rows) or a title and a screen-reader line (presence marks).
import type { WordTone } from "@/lib/match-day/online-copy";

export const WORD_TONE: Record<WordTone, string> = {
  live: "text-emerald-700",
  wait: "text-amber-700",
  hold: "text-red-700",
  done: "text-purple-900",
  quiet: "text-slate-600",
};
