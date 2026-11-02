"use client";

// Match Day C2 — what the three rules editors (Match format, Points, Tie-breaks) share: their modes and their one lock line.
import { useMsg } from "@/components/i18n/dict-provider";

/** Every rules editor has the same two modes (spec §12 Phase C item 10): "edit" (a division default, or a stage before its
 *  first score), "locked" (read-only: a stage that has started, or a reader who may not change it). */
export type RulesMode = "edit" | "locked";

/** "Locked: the stage has started" — the ONE lock line a section says (item 4), in organiser words. A division section says
 *  which stage holds it instead (`text`: "Locked: Pool A has started and plays this format"), still once per section. */
export function LockLine({ testId, text }: { testId: string; text?: string }) {
  const msg = useMsg();
  return (
    <p className="text-[11px] leading-snug text-slate-700" data-testid={testId}>
      <span aria-hidden="true">🔒 </span>
      {text ?? msg("stageCard.locked")}
    </p>
  );
}
