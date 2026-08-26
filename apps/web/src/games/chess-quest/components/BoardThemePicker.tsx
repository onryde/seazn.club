"use client";

// Board colour picker — a device setting next to the mute toggle in
// QuestHeader (same posture as getMuted/setMuted: shared across profiles,
// persisted under seazn-games:chess-quest:v1). Board.tsx reads the chosen
// theme itself via useProgress(), so no prop threading through every
// mini-game is needed — picking a theme here just changes what every board
// renders with next.
import { BoardTheme, useProgress } from "../lib/progress";

const THEME_OPTIONS: { value: BoardTheme; label: string }[] = [
  { value: "green", label: "🟩 Green" },
  { value: "brown", label: "🟫 Brown" },
  { value: "purple", label: "🟪 Purple" },
];

export function BoardThemePicker() {
  const progress = useProgress();
  const theme = progress.getBoardTheme();

  return (
    <select
      aria-label="Board theme"
      value={theme}
      onChange={(e) => progress.setBoardTheme(e.target.value as BoardTheme)}
      className="rounded-full border border-purple-300 bg-white px-2 py-1 text-sm hover:bg-purple-50"
    >
      {THEME_OPTIONS.map((opt) => (
        <option key={opt.value} value={opt.value}>
          {opt.label}
        </option>
      ))}
    </select>
  );
}
