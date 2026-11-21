"use client";
// The focus column's frame for an online round or board (spec 2026-11-05 §6.3): the court panel's own frame - "‹ All courts" on a phone,
// the name, what it is - which the shell mounts for a round or a board opened from the list, from Needs you or from `?round=` /
// `?board=`. The frame is shared: the round's panel is `RoundFocus` (round-focus.tsx, Task 7: phases and presses) and the board's is
// `BoardFocus` (board-focus.tsx, Task 8: the chess board, flags, decisions); each draws its own body inside this frame.
import type { ReactNode } from "react";
import { BackButton } from "./court-focus";

export function OnlineFocusFrame({
  testAttrs,
  title,
  backLabel,
  onBack,
  hiddenOnPhone,
  subtitle,
  children,
}: {
  testAttrs: Record<string, string>;
  title: string;
  backLabel: string;
  onBack: () => void;
  hiddenOnPhone: boolean;
  subtitle: ReactNode;
  children?: ReactNode;
}) {
  return (
    <section
      data-testid="md-focus"
      {...testAttrs}
      aria-label={title}
      className={`grid min-w-0 content-start gap-4${hiddenOnPhone ? " max-md:hidden" : ""}`}
    >
      <BackButton label={backLabel} onBack={onBack} />
      <header className="min-w-0">
        <h2 className="min-w-0 text-xl font-semibold text-purple-950 [overflow-wrap:anywhere]">{title}</h2>
        <p className="mt-0.5 flex min-w-0 flex-wrap items-center gap-x-2 text-xs text-slate-600 [overflow-wrap:anywhere]">{subtitle}</p>
      </header>
      {children}
    </section>
  );
}
