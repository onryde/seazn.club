"use client";
// Seazn-hosted video (Task 25): the fixture stream panel's list of the fixture's Seazn replays, in its ended card. Each part the replay
// move made (the session view's `seaznReplays`, server/video/organiser-replays.ts), in part order, with its state in words: getting
// ready, ready on the match page (with its length), or failed. A part is labelled "Part {n}" only when there are two or more, as the
// panel's YouTube replay row labels its parts. Nothing at all when there is none. Task 26 adds Delete and Download per part here.
//
// The panel's own row style (a slate-bordered box, the slate chip): one quiet line per part, the state's colour on a small dot, and
// the failure in red words. A pure function of its props, as the panel's body is.
import { useMsg } from "@/components/i18n/dict-provider";
import type { StreamSessionCurrent } from "@/server/api-v1/schemas";

type Replay = StreamSessionCurrent["seaznReplays"][number];

const STATE_KEY = {
  processing: "stream.replay.seazn.processing",
  playable: "stream.replay.seazn.ready",
  failed: "stream.replay.seazn.failed",
} as const;
const DOT = { processing: "bg-amber-500", playable: "bg-emerald-500", failed: "bg-red-500" } as const;
const WORDS = { processing: "text-slate-700", playable: "text-slate-700", failed: "text-red-700" } as const;

/** A replay's length as a clock (`m:ss`, `h:mm:ss` from an hour); null for a length that is not a whole number of seconds. */
export function replayLength(seconds: number | null): string | null {
  if (seconds === null || !Number.isInteger(seconds) || seconds < 0) return null;
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = String(seconds % 60).padStart(2, "0");
  return h > 0 ? `${h}:${String(m).padStart(2, "0")}:${s}` : `${m}:${s}`;
}

/** `replays` absent: a view from a server older than the field (a deploy in flight), which has none to show. */
export function SeaznReplaysCard({ replays }: { replays: readonly Replay[] | undefined }) {
  const msg = useMsg();
  if (replays === undefined || replays.length === 0) return null;
  const parts = [...replays].sort((a, b) => a.partNo - b.partNo);
  const multi = parts.length > 1;
  return (
    <section data-testid="stream-seazn-replays" className="min-w-0 space-y-2 rounded-lg border border-slate-200 p-3">
      <p className="text-sm font-semibold text-slate-900">{msg("stream.replay.seazn.title")}</p>
      <ul className="space-y-2">
        {parts.map((p) => {
          const length = p.state === "playable" ? replayLength(p.lengthSeconds) : null;
          return (
            <li key={p.id} data-testid="stream-seazn-replay" data-state={p.state} className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1 text-sm">
              {multi && <span className="font-medium text-slate-900">{msg("stream.replay.seazn.part", { n: p.partNo })}</span>}
              <span className={`inline-flex min-w-0 items-center gap-2 ${WORDS[p.state]}`}>
                <span aria-hidden className={`inline-block h-2 w-2 shrink-0 rounded-full ${DOT[p.state]}`} />
                <span className="min-w-0">{msg(STATE_KEY[p.state])}</span>
              </span>
              {length !== null && <span className="rounded-md bg-slate-100 px-2 py-1 text-[11px] tabular-nums text-slate-700">{length}</span>}
            </li>
          );
        })}
      </ul>
    </section>
  );
}
