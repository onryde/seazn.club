// Stream overlay W1, Task 7 — WHICH label the public match page's link to the
// club's own broadcast carries, or that the page carries no link at all
// (design §3.9: "Watch live" while scheduled/in_play, "Replay" once
// decided/finalized, nothing for the void statuses). A held bracket result
// (W2a's needs_decision) reads "Replay" too: controller ruling D-M1
// (2026-10-09) — no play remains, and the stream's automatic stop arms on it.
//
// A module of its own beside `fixture-subheading.ts` and `share-text.ts` —
// this route's own convention for a decision the page body should not
// re-derive inline. The reason it is worth one here: the split is three-way
// over the WHOLE fixture-status vocabulary, and `page.tsx` is an async server
// component whose JSX can only be enumerated per status by rendering the page
// seven times. This function can be swept directly, and the page's own tests
// still prove it is mounted (a pure helper nothing renders is the inert seam).
import { OVERLAY_VOID_STATUSES } from "@/lib/overlay-model";

/** The statuses the design calls "once it is not live", plus the held
 *  `needs_decision` (ruling D-M1: no play remains; it is not void, so the
 *  organiser's link stays). Deliberately NOT `overlay-model.ts`'s own
 *  `ENDED_STATUSES`: that set folds the void statuses in (the overlay shows a
 *  "Final"/void FRAME for all five), and this page must tell those two groups
 *  apart — a decided match keeps its link and an abandoned one loses it. */
const REPLAYABLE_STATUSES = new Set(["decided", "finalized", "needs_decision"]);

/** The label key for a `public.overlay.*` lookup, or `null` when this page
 *  must show no link at all whatever the organiser saved.
 *
 *  Order is load-bearing: a void status is answered FIRST, so `cancelled` /
 *  `abandoned` / `forfeited` can never fall through to a label. `null` here is
 *  the whole reason a caller cannot render the anchor from `stream_url` alone.
 *
 *  The vocabulary is closed (`FIXTURE_STATUSES`), so the trailing default is
 *  exactly `scheduled` + `in_play` — the pre-match/live bucket, the one whose
 *  link points at a broadcast that has not finished. A status added to the
 *  vocabulary must be placed here, or it lands in that bucket (W2a's held
 *  status did, until ruling D-M1). */
export function streamLinkLabelKey(status: string): "overlay.watchLive" | "overlay.replay" | null {
  if (OVERLAY_VOID_STATUSES.has(status)) return null;
  if (REPLAYABLE_STATUSES.has(status)) return "overlay.replay";
  return "overlay.watchLive";
}
