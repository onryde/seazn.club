// S2-5 ruling 110 — the server's time as this page's overlay polls measure it.
//
// One window per page (`server-offset.ts`: the median of the last five samples), fed by every `fetchOverlayFixture`
// answer — an overlay page holds one stage, and every answer comes from the same servers. A football overlay clock
// reads through it (`use-overlay-clock.ts`); nothing else does. Its own module so the poll (`live-score-data.ts`) and
// the stage share it without either importing the other's internals.
import { createServerOffset } from "@/components/v2/scorepad/server-offset";

/** The page's window. Written only by `fetchOverlayFixture` (`sampleServerOffset`). */
export const overlayServerOffset = createServerOffset();

/** serverNow − localNow off this page's overlay polls, or null before one is measured. */
export function overlayServerOffsetMs(): number | null {
  return overlayServerOffset.offsetMs();
}
