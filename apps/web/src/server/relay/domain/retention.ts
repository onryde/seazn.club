// server/relay/domain/retention.ts — C1 (our 3-day promise on VIDEOS; Cloudflare
// keeps its 30-day floor) and C2 (videos BEFORE inputs: deleteInput leaks the
// recording, and a recording in live-inprogress answers 409 until it
// finalises — the port reports that and the next daily tick retries). PURE.
import { RECORDING_RETENTION_DAYS } from "../config";

/** `inProgress` is carried for the CALLER and its telemetry; `retentionPlan` deliberately does NOT read it, so an
 *  in-progress video past the cutoff DOES land in `deleteVideos` (whole-branch review m2, doc-only — the behaviour is
 *  the intended one, and this comment is the thing that was missing).
 *
 *  The PROVIDER is the filter, not the plan: `deleteVideo` answers Cloudflare's 409 / code 10046 as `"in_progress"`
 *  and the next daily tick retries (C2). That is the only authority worth having, because this flag is a snapshot from
 *  the LIST call and a recording can finalise — or start — between that list and the delete. A plan that pre-filtered
 *  on it would be deciding from a stale fact and would quietly never delete a video whose flag was last seen true.
 *  A Task 12 reader must not assume the plan filters it. */
export interface RetainedVideo { videoId: string; inputId: string | null; createdAt: Date; inProgress: boolean }
export interface RetainedInput { inputRowId: string; ingestInputId: string; sessionTerminal: boolean; sessionEndedAt: Date | null }
export interface RetentionPlan { deleteVideos: string[]; deleteInputs: RetainedInput[]; deferInputs: RetainedInput[] }

export function retentionPlan(
  videos: readonly RetainedVideo[], inputs: readonly RetainedInput[], now: Date, days = RECORDING_RETENTION_DAYS,
): RetentionPlan {
  const cutoff = now.getTime() - days * 86_400_000;
  const deleteVideos = videos.filter((v) => v.createdAt.getTime() <= cutoff).map((v) => v.videoId);
  const named = new Set(videos.map((v) => v.inputId).filter((x): x is string => x !== null));
  const deleteInputs: RetainedInput[] = [];
  const deferInputs: RetainedInput[] = [];
  for (const i of inputs) {
    if (!i.sessionTerminal || !i.sessionEndedAt || i.sessionEndedAt.getTime() > cutoff) continue; // not yet the sweep's business
    (named.has(i.ingestInputId) ? deferInputs : deleteInputs).push(i);
  }
  return { deleteVideos, deleteInputs, deferInputs };
}
