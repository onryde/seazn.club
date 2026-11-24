// Add stage after groups (owner Option C, 2026-11-24): a per-group take out of SEVERAL groups that could never be drawn (the
// separation, size and page-playoff refusals) is refused when an `on_complete` stage is SAVED. The scenes that exercise the DRAW-time
// refusals (the door that still guards a shape that became impossible after the save: a withdrawal, a fed field) must still reach
// them, so they store the stage as `setup` - the builder's own timing, which the save door only warns of - and then write the timing
// onto the row, exactly as a stage saved before this door stands. The draw reads the stored row, never the save path.
import { sql } from "@/lib/db";

export async function storeAsOnComplete(stageId: string): Promise<void> {
  const rows = await sql<{ timing: string }[]>`
    update stages set progression = jsonb_set(progression, '{timing}', '"on_complete"') where id = ${stageId} returning progression->>'timing' as timing`;
  if (rows.length !== 1 || rows[0]!.timing !== "on_complete") throw new Error(`storeAsOnComplete: stage ${stageId} was not rewritten`);
}
