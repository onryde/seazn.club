// server/relay/domain/retention.ts — C1 (our 3-day promise on VIDEOS; Cloudflare
// keeps its 30-day floor) and C2 (videos BEFORE inputs: deleteInput leaks the
// recording, and a recording in live-inprogress answers 409 until it
// finalises — the port reports that and the next daily tick retries). PURE.
import { RECORDING_RETENTION_DAYS } from "../config";

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
