"use client";
// The pre-Go-live channel-safety notice (Phase 0, YouTube channel safety, Task 4): before a Go live to a YouTube Connect channel the panel
// asks the server once whether the channel is young or has run several short broadcasts lately, and if so shows this notice. Non-blocking:
// "Go live anyway" proceeds, "Cancel" dismisses. Pure helpers here (`needsChannelCheck`, `fetchChannelSafety`) so the panel file stays a
// caller and the Seazn destination (Task 16) can import the same predicate.
import { TriangleAlert } from "lucide-react";
import { useMsg } from "@/components/i18n/dict-provider";
import { apiV1 } from "@/lib/client-v1";
import type { StreamTarget, YoutubeChannelSafety } from "@/server/api-v1/schemas";

/** Does a Go live to this destination owe the channel-safety check? Only a YouTube Connect destination (`youtube` non-null): a pasted key,
 *  and any destination that is not a YouTube connection (the Seazn one, Task 16), never calls it. */
export function needsChannelCheck(target: Pick<StreamTarget, "youtube"> | null | undefined): boolean {
  return target != null && target.youtube !== null && target.youtube !== undefined;
}

/** One read of the connection's safety facts. Fail-open on this side too: a request that fails answers null, and the caller goes live. */
export async function fetchChannelSafety(orgId: string, connectionId: string): Promise<YoutubeChannelSafety | null> {
  try {
    return await apiV1<YoutubeChannelSafety>(`/api/v1/orgs/${orgId}/youtube-connections/${connectionId}/safety`);
  } catch {
    return null;
  }
}

export function ChannelSafetyNotice({ onGoAnyway, onCancel, busy }: { onGoAnyway: () => void; onCancel: () => void; busy: boolean }) {
  const msg = useMsg();
  return (
    <div data-testid="stream-safety-notice" role="status" className="mb-3 min-w-0 rounded-lg border border-amber-200 bg-amber-50 p-3.5 text-sm text-amber-900">
      <p className="flex gap-2">
        <TriangleAlert aria-hidden className="mt-0.5 h-5 w-5 shrink-0" strokeWidth={1.8} />
        <span data-testid="stream-safety-text" className="min-w-0 [overflow-wrap:anywhere]">{msg("stream.safety.notice")}</span>
      </p>
      <div className="mt-3 flex flex-col gap-1.5 sm:flex-row-reverse">
        <button type="button" data-testid="stream-safety-go-anyway" disabled={busy} onClick={onGoAnyway} className="btn btn-primary min-h-12 w-full text-base sm:w-auto">
          {msg("stream.safety.goAnyway")}
        </button>
        <button type="button" data-testid="stream-safety-cancel" onClick={onCancel} className="btn btn-ghost min-h-11 w-full sm:w-auto">
          {msg("stream.safety.cancel")}
        </button>
      </div>
    </div>
  );
}
